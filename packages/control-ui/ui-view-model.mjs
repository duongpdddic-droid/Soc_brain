#!/usr/bin/env node
// ui-view-model.mjs — Soc_brain UI v1 canonical view-model adapter.
//
// The UI NEVER parses Telegram or raw terminal output to infer state. This
// adapter composes the ONLY sources of truth into one view-model contract:
//   - canonical session record (runtime-sandbox FSM)     -> identity + state
//   - execution status projection (executor-launcher)    -> runtime facts
//   - canonical progress record (task-progress, #90)     -> todo/progress
//   - Soc_Score telemetry stream (soc-score, #45)        -> events + durations
//   - activity tail (observability passthrough)          -> logs (display only)
//
// Contract (all fields ALWAYS present; null/[] when unknown):
//   taskId, issueNumber, prNumber, title, repo, branch, headSha,
//   canonicalState, phase, progressPercent, currentStep, totalSteps,
//   executor, executorVersion, model, executionId, pid, startedAt, elapsed,
//   lastMeaningfulActivityAt, health, blocker, humanActionRequired,
//   todo[], recentEvents[], telemetry, runtime, logs[]
//   + Issue #136: runtimeSession (3-layer state projection), github (titles)
//
// `canonicalState` is the session FSM state VERBATIM (no re-labeling). `phase`
// and `health` are PRESENTATION mappings (deterministic tables below) — they
// never feed back into the control plane. `logs[]` is observability
// passthrough for display; no state is ever derived from it.
//
// No framework. Node >= 22.

import fs from 'node:fs';
import { readSessionRecord, sessionPathFor } from '../runtime-sandbox/runtime-sandbox.mjs';
import { identityHash } from '../workspace/workspace.mjs';
import { readProgressRecord } from '../task-progress/task-progress.mjs';
import { computeSummary, eventsPathFor } from '../soc-score/soc-score.mjs';
import { readExecutionStatus, readActivityTail } from '../executor-launcher/executor-launcher.mjs';

export const VM_SCHEMA_VERSION = '1';

// Canonical FSM states that mean "a human must act" (Issue #65 human gate).
export const HUMAN_GATE_STATES = Object.freeze(['HUMAN_GATE_REQUIRED', 'WAITING_FOR_INPUT']);

// Presentation mapping canonicalState -> phase label.
const PHASE_BY_STATE = Object.freeze({
  NO_SESSION: 'idle',
  SESSION_ACTIVE: 'executing',
  BLOCKED: 'blocked',
  COMPLETED: 'completed',
  FAILED: 'failed',
  HUMAN_GATE_REQUIRED: 'awaiting_human',
  WAITING_FOR_INPUT: 'awaiting_human',
});

const RECENT_EVENTS_MAX = 20;
const DETAIL_MAX_CHARS = 200;

// Presentation mapping canonicalState + execution.status -> health.
export function deriveHealth({ canonicalState, execution } = {}) {
  if (canonicalState === 'COMPLETED') return 'healthy';
  if (canonicalState === 'FAILED' || canonicalState === 'BLOCKED') return 'attention';
  if (HUMAN_GATE_STATES.includes(canonicalState)) return 'attention';
  if (canonicalState === 'SESSION_ACTIVE') {
    const s = execution && execution.status;
    if (s === 'RUNNING' || s === 'STARTING') return 'healthy';
    return 'attention'; // canonical still active but the process is not running -> recovery needed
  }
  return 'offline';
}

function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function clip(s, max = DETAIL_MAX_CHARS) {
  const str = s == null ? '' : String(s);
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

// Empty VM: every contract field present, nothing derived.
export function emptyViewModel({ repo, issueNumber } = {}) {
  return {
    schemaVersion: VM_SCHEMA_VERSION,
    taskId: null, issueNumber: issueNumber ?? null, prNumber: null,
    title: null, repo: repo ?? null, branch: null, headSha: null,
    canonicalState: 'NO_SESSION', phase: 'idle',
    progressPercent: null, currentStep: null, totalSteps: null,
    executor: null, executorVersion: null, model: null, executionId: null, pid: null,
    startedAt: null, elapsed: null, lastMeaningfulActivityAt: null,
    health: 'offline', blocker: null, humanActionRequired: null,
    todo: [], recentEvents: [], telemetry: null, runtime: null, logs: [],
    runtimeSession: { taskLifecycle: 'NO_SESSION', sessionState: null, processStatus: null, sessionActive: false },
    github: { issueTitle: null, prTitle: null, issueTitleSource: 'unavailable', prTitleSource: 'unavailable' },
  };
}

// ---- 3-layer state projection (Issue #136, step 2) ---------------------------
// Layer 1 taskLifecycle: the canonical session FSM state, VERBATIM. It is the
//   ONLY primary status; nothing in the UI outranks it and no runtime layer
//   ever overrides it (it is not rewritten here either — stale FSM states stay
//   truthful; what changes is that runtime liveness is no longer CLAIMED from
//   a stale record).
// Layer 2 sessionState: live-session evidence ONLY. A historical lifecycle
//   EVENT named SESSION_ACTIVE (admission record) is NOT live evidence — the
//   projection treats it as historical. Live evidence today = the process is
//   actually alive for this task (RUNNING/STARTING) while the FSM is still
//   active. No execution record = unknown.
// Layer 3 processStatus: launcher process facts (STARTING/RUNNING/EXITED/
//   FAILED/STOPPED/INTERRUPTED) or UNKNOWN when no record exists.
// sessionActive is true ONLY under FSM-active + live process evidence; it is
// the sole flag the UI may render as "session active".
// sessionState values: SESSION_ACTIVE | SESSION_EXITED | NO_SESSION | UNKNOWN.
export function projectRuntimeSession({ canonicalState, execution } = {}) {
  const TERMINAL = ['COMPLETED', 'FAILED', 'BLOCKED'];
  const processStatus = (execution && execution.status) || 'UNKNOWN';
  const fsmActive = canonicalState === 'SESSION_ACTIVE';
  const processLive = processStatus === 'RUNNING' || processStatus === 'STARTING';
  let sessionState;
  if (fsmActive) {
    sessionState = processLive ? 'SESSION_ACTIVE' : (processStatus === 'UNKNOWN' ? 'UNKNOWN' : 'SESSION_EXITED');
  } else if (TERMINAL.includes(canonicalState)) {
    sessionState = 'SESSION_EXITED'; // terminalized task: session is over, never "active"
  } else if (canonicalState === 'NO_SESSION') {
    sessionState = 'NO_SESSION';
  } else {
    sessionState = 'UNKNOWN'; // human gates etc: no live-session claim either way
  }
  return {
    taskLifecycle: canonicalState ?? 'NO_SESSION',
    sessionState,
    processStatus,
    sessionActive: Boolean(fsmActive && processLive),
  };
}

// Fail-isolated Soc_Score telemetry read: whole JSONL, parse what parses.
function readTelemetryEvents({ stateDir, identityHash: id } = {}) {
  try {
    const raw = fs.readFileSync(eventsPathFor({ stateDir, identityHash: id }), 'utf8');
    return raw.split('\n')
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && typeof e.event === 'string');
  } catch {
    return [];
  }
}

// Compose one task view-model from canonical sources. ASYNC (Issue #136: may
// await the injectable GitHub title resolver). Always returns
// { ok: true, vm }; sub-read failures surface as nulls, never as crashes.
export async function buildTaskViewModel({
  repo, issueNumber, stateDir, maxLogs = 120,
  prNumber = null,
  deps = {},
} = {}) {
  const vm = emptyViewModel({ repo, issueNumber });
  if (!repo || !Number.isInteger(issueNumber) || issueNumber <= 0 || !stateDir) {
    return { ok: false, reason: 'VM_TARGET_INVALID', vm };
  }
  const D = {
    readSession: deps.readSession || readSessionRecord,
    sessionPathFor: deps.sessionPathFor || sessionPathFor,
    identityHash: deps.identityHash || identityHash,
    readExecution: deps.readExecution || readExecutionStatus,
    readProgress: deps.readProgress || readProgressRecord,
    readTelemetry: deps.readTelemetry || readTelemetryEvents,
    summarize: deps.summarize || computeSummary,
    readActivity: deps.readActivity || readActivityTail,
    resolveRefs: deps.resolveRefs || null, // async ({ repo, issueNumber, prNumber }) -> { issueTitle, prTitle } | null
  };

  const id = D.identityHash({ repo, issueNumber });
  vm.executionId = id;

  // 1) Canonical session record (authority for identity + lifecycle state).
  let session = null;
  try {
    const rs = D.readSession(D.sessionPathFor({ stateDir, identityHash: id }));
    if (rs && rs.ok && rs.session) session = rs.session;
  } catch { /* fail-isolated */ }
  if (!session) return { ok: true, vm }; // NO_SESSION: health/phase already idle/offline

  vm.taskId = session.taskId ?? `${repo}#${issueNumber}`;
  vm.issueNumber = session.issueNumber ?? issueNumber;
  // Canonical PR binding (persisted by control-loop persistPrNumber with
  // read-back) — never guessed from branch names or logs (Issue #136).
  vm.prNumber = prNumber ?? (Number.isInteger(session.prNumber) ? session.prNumber : null);
  vm.branch = session.branch ?? null;
  vm.headSha = session.headSha ?? null;
  vm.canonicalState = session.state;
  vm.startedAt = session.startedAt ?? null; // lease issuedAt (public projection already strips token)

  // GitHub-backed titles (Issue #136, step 1): presentation only, fail-isolated,
  // never fabricated. resolveRefs is async/injectable; when unavailable the
  // header falls back to `Issue #N` / `PR #N` verbatim.
  if (typeof D.resolveRefs === 'function') {
    try {
      const refs = await D.resolveRefs({ repo, issueNumber: vm.issueNumber, prNumber: vm.prNumber });
      if (refs && typeof refs === 'object') {
        vm.github = {
          issueTitle: typeof refs.issueTitle === 'string' ? refs.issueTitle : null,
          prTitle: typeof refs.prTitle === 'string' ? refs.prTitle : null,
          issueTitleSource: refs.issueTitle != null ? 'github' : 'unavailable',
          prTitleSource: refs.prTitle != null ? 'github' : 'unavailable',
        };
      }
    } catch { /* fail-isolated: titles stay unavailable */ }
  }

  // 2) Execution status projection (process facts; already public-safe).
  let exec = null;
  try {
    const r = D.readExecution({ stateDir, repo, issueNumber, includeActivity: false });
    if (r && r.ok && r.execution) exec = r.execution;
  } catch { /* fail-isolated */ }
  if (exec) {
    vm.executor = exec.executor ?? null;
    vm.model = exec.model ?? null;
    vm.executorVersion = exec.executorVersion ?? null; // real launch-time `--version` probe (never conflated with model)
    vm.pid = exec.pid ?? null;
    vm.elapsed = exec.elapsedMs ?? null;
    vm.startedAt = exec.startedAt ? new Date(exec.startedAt).toISOString() : vm.startedAt;
    vm.runtime = {
      status: exec.status, terminalStatus: exec.terminalStatus ?? null,
      reason: exec.reason ?? null, pid: exec.pid ?? null, executor: exec.executor ?? null,
      model: exec.model ?? null, executorVersion: exec.executorVersion ?? null,
      agent: exec.agent ?? null, sessionId: exec.sessionId ?? null,
      startedAt: exec.startedAt ? new Date(exec.startedAt).toISOString() : null,
      finishedAt: exec.finishedAt ? new Date(exec.finishedAt).toISOString() : null,
      exitCode: exec.exitCode ?? null, signal: exec.signal ?? null,
      instructionDigest: exec.instructionDigest ?? null, instructionBytes: exec.instructionBytes ?? null,
      eventsOverflow: exec.eventsOverflow === true,
    };
  }

  // 3) Canonical progress record (subordinate telemetry; never FSM authority).
  let progress = null;
  try {
    const r = D.readProgress({ stateDir, identityHash: id });
    if (r && r.ok && r.progress) progress = r.progress;
  } catch { /* fail-isolated */ }
  if (progress) {
    vm.currentStep = Number(progress.currentStep) || null;
    vm.totalSteps = Number(progress.totalSteps) || null;
    vm.todo = (Array.isArray(progress.steps) ? progress.steps : [])
      .slice().sort((a, b) => a.index - b.index)
      .map((s) => ({ index: s.index, name: s.name, status: s.status }));
    const done = vm.todo.filter((s) => s.status === 'COMPLETED').length;
    vm.progressPercent = vm.totalSteps ? Math.round((done / vm.totalSteps) * 100) : null;
  }

  // 4) Soc_Score telemetry (canonical event stream -> events + durations).
  let telemetryLines = [];
  try { telemetryLines = D.readTelemetry({ stateDir, identityHash: id }); } catch { telemetryLines = []; }
  const eventSources = [];
  for (const e of telemetryLines) {
    eventSources.push({ atMs: toMs(e.t), at: toMs(e.t) ? new Date(toMs(e.t)).toISOString() : null, kind: 'telemetry', label: e.event, detail: clip(e.detail == null ? '' : JSON.stringify(e.detail)) });
  }
  for (const e of (Array.isArray(session.lifecycle) ? session.lifecycle : [])) {
    eventSources.push({ atMs: toMs(e.at), at: e.at ?? null, kind: 'lifecycle', label: e.event, detail: clip(e.detail) });
  }
  eventSources.sort((a, b) => b.atMs - a.atMs);
  vm.recentEvents = eventSources.slice(0, RECENT_EVENTS_MAX);
  if (telemetryLines.length) {
    let summary = null;
    try { summary = D.summarize({ events: telemetryLines, identity: null }); } catch { summary = null; }
    vm.telemetry = {
      available: true,
      eventCount: telemetryLines.length,
      lastEventAt: vm.recentEvents.find((e) => e.kind === 'telemetry')?.at ?? null,
      durations: summary && summary.durations ? summary.durations : null,
    };
  }

  // lastMeaningfulActivityAt: latest canonical signal (progress update, telemetry
  // event, execution finish). NEVER from raw log lines.
  const candidates = [progress ? toMs(progress.updatedAt) : 0, exec ? toMs(exec.finishedAt) : 0,
    eventSources.length ? eventSources[0].atMs : 0];
  const latest = Math.max(...candidates);
  vm.lastMeaningfulActivityAt = latest ? new Date(latest).toISOString() : null;

  // 5) Phase + health + blocker + human action (deterministic presentation
  // tables over canonical facts only).
  vm.phase = PHASE_BY_STATE[session.state] ?? session.state;
  if (vm.phase === 'executing' && exec) {
    if (exec.status === 'STARTING') vm.phase = 'starting';
    else if (exec.status === 'EXITED' || exec.status === 'STOPPED' || exec.status === 'INTERRUPTED') vm.phase = 'recovering';
  }
  vm.health = deriveHealth({ canonicalState: session.state, execution: exec });
  if (HUMAN_GATE_STATES.includes(session.state)) {
    const g = session.humanGate || {};
    vm.humanActionRequired = { state: session.state, note: g.note ?? null, deliveryStatus: g.deliveryStatus ?? null };
  }
  if (session.state === 'BLOCKED') {
    const blocked = (session.lifecycle || []).filter((e) => e.event === 'BLOCKED').pop();
    vm.blocker = clip((blocked && blocked.detail) || exec?.reason || 'canonical state BLOCKED');
  } else if (exec && (exec.status === 'FAILED' || exec.status === 'INTERRUPTED' || (exec.status === 'EXITED' && exec.exitCode !== 0)) && exec.reason) {
    vm.blocker = clip(exec.reason);
  } else if (progress) {
    const b = vm.todo.find((s) => s.status === 'BLOCKED');
    if (b) vm.blocker = clip(`step ${b.index}: ${b.name}`);
  }

  // 6) Logs: observability passthrough (display only; never a state source).
  try {
    const r = D.readActivity({ stateDir, repo, issueNumber, maxLines: maxLogs });
    if (r && r.ok) vm.logs = r.items;
  } catch { /* fail-isolated */ }

  // 7) 3-layer runtime session projection (Issue #136, step 2): lifecycle is
  // canonical verbatim; "session active" is claimed ONLY on live process
  // evidence bound to this task — a historical SESSION_ACTIVE lifecycle event
  // never resurrects a dead session.
  vm.runtimeSession = projectRuntimeSession({ canonicalState: vm.canonicalState, execution: exec });

  return { ok: true, vm };
}
