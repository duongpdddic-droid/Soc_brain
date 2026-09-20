#!/usr/bin/env node
// executor-launcher — THIN ADAPTER between the Soc_brain control plane and an
// OpenCode headless run (Issue #53).
//
// ARCHITECTURE BOUNDARY (Issue #53 correction — binding):
//   Soc_brain owns control-plane concerns only: task/project authority,
//   canonical worktree/session, policy, executor selection, executor
//   launch/stop, verification/review lifecycle. OpenCode owns its internal
//   coding loop (reason -> read/search -> edit -> tools -> test -> iterate).
//   This module therefore tracks ONLY process-level lifecycle facts
//   (STARTING/RUNNING/EXITED/FAILED/STOPPED + pid/startedAt/finishedAt/
//   exitCode/sessionId) for process ownership and diagnostics.
//   Everything the executor emits through its SUPPORTED interface
//   (`opencode run --format json` NDJSON events on stdout + stderr logs) is
//   passed through verbatim as OBSERVABILITY: no interpretation, no text
//   mining, no TUI scraping, no hidden chain-of-thought capture, no agent FSM.
//
// Security invariants:
//   - instruction is DATA: passed as a single argv element to a shell-less
//     spawn; never interpolated into a shell.
//   - spawn cwd is ALWAYS the taskStart-verified worktree (binding.path).
//   - launch is gated by a capability preflight: the worktree opencode.json
//     projection must grant the minimum coding tool surface (bash/edit/read/
//     glob/grep/list = allow) or the launch fails closed BEFORE spawn
//     (EXECUTOR_PREFLIGHT_FAILED) — headless OpenCode would otherwise silently
//     auto-reject every denied tool (GPT-REV-137).
//   - executable is resolved from canonical, control-plane-owned locations
//     (env override or npm global install) — never from request input.
//   - child env is a bounded allowlist.
//
// No framework. Node >= 22.

import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifySessionAuthority, readSessionRecord, updateSessionUnderOwnershipLock } from '../runtime-sandbox/runtime-sandbox.mjs';
import { terminateAndProveCleanup, pendingExecutorLatch, priorIncarnationProvenGone, evaluateLatchClear } from './executor-reconcile.mjs';
import {
  readOpenCodeConfig, evaluateCodingCapabilities,
} from '../runtime-sandbox/opencode-adapter.mjs';
import { identityHash } from '../workspace/workspace.mjs';
import { readWin32ProcessStartTime } from '../temp-hygiene/temp-hygiene.mjs';
import {
  COMMAND_CODE_EXECUTOR_ID,
  buildCommandCodeLaunchArgv,
  classifyCommandCodeEvent,
  classifyCommandCodeOutcome,
  resolveCommandCodeExecutable,
} from './command-code-provider.mjs';

export const EXECUTION_SCHEMA_VERSION = '1';
export const EXECUTOR_ID = 'opencode';

// Issue #160 REWORK r3 BLOCKER-2: startExecution succeeds only on a STRICTLY
// proven execution-context read-back. Exported pure so the bind rule is unit-
// testable without spawning. {ok:true} without a session, or a session whose
// executionMode is not exactly 'executor', is a bind failure (never fail-open).
export function bindReadbackOk(em) {
  return !!(em && em.ok === true && em.session && typeof em.session === 'object' && em.session.executionMode === 'executor');
}
// Process-level statuses only (see boundary comment). INTERRUPTED is a
// PROJECTION for a non-terminal record whose pid is gone (stale evidence),
// never an authoritative terminal status.
export const EXECUTION_STATUSES = Object.freeze([
  'STARTING', 'RUNNING', 'EXITED', 'FAILED', 'STOPPED', 'INTERRUPTED',
]);
export const INSTRUCTION_MAX_BYTES = 8192;
export const ACTIVITY_TAIL_MAX_LINES = 512;
export const ACTIVITY_LINE_MAX_BYTES = 16 * 1024;
export const ACTIVITY_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const TERMINAL_EVIDENCE_MAX_LINES = 64;
export const MODEL_RE = /^[A-Za-z0-9._/-]{1,120}$/;

// ---- executable resolution (control-plane owned, fail-closed) --------------
// Candidates, in order (first real .exe file wins):
//   1. SOC_OPENCODE_BIN env override (operator escape hatch; must exist)
//   2. PATH-order scan, mirroring user-facing `opencode` resolution WITHOUT a
//      shell: a PATH dir participates only if it actually serves an `opencode`
//      entry — a real opencode.exe, or an npm shim (opencode/opencode.cmd/
//      opencode.ps1) whose package exe exists at
//      <dir>/node_modules/opencode-ai/bin/opencode.exe. A stale node_modules
//      copy with no shim (invisible to the shell) is never picked — that is the
//      1.18.18-shadowing class of bug this scan exists to prevent.
//   3. <APPDATA>/npm/node_modules/opencode-ai/bin/opencode.exe (npm -g layout)
//   4. <node dir>/node_modules/opencode-ai/bin/opencode.exe (nvm4w layout)
// Only real .exe files are considered: Node refuses to spawn .cmd/.bat without
// a shell, and shims must never be spawned (shell boundary).
// Invariant: the resolved path is the SINGLE source — the version probe, the
// spawned process, and the persisted record all use exactly this path.
export function resolveOpenCodeExecutable({ env = process.env, exists = fs.existsSync } = {}) {
  const candidates = [];
  if (env.SOC_OPENCODE_BIN) candidates.push({ path: env.SOC_OPENCODE_BIN, source: 'env:SOC_OPENCODE_BIN' });
  for (const rawDir of String(env.PATH || '').split(path.delimiter)) {
    const dir = String(rawDir || '').replace(/^"+|"+$/g, '');
    if (!dir) continue;
    candidates.push({ path: path.join(dir, 'opencode.exe'), source: 'path' });
    const servesShim = exists(path.join(dir, 'opencode.cmd')) || exists(path.join(dir, 'opencode.ps1')) || exists(path.join(dir, 'opencode'));
    if (servesShim) candidates.push({ path: path.join(dir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'), source: 'path' });
  }
  if (env.APPDATA) candidates.push({ path: path.join(env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'), source: 'npm-global' });
  candidates.push({ path: path.join(path.dirname(process.execPath), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'), source: 'npm-global' });
  for (const c of candidates) {
    try {
      if (exists(c.path) && fs.statSync(c.path).isFile()) {
        return { ok: true, executable: c.path, source: c.source, candidates };
      }
    } catch { /* next candidate */ }
  }
  return { ok: false, reason: 'EXECUTOR_UNAVAILABLE', candidates };
}

// ---- launch argv (pure; data-only) -----------------------------------------
export function buildLaunchArgv({ instruction, model = null } = {}) {
  if (typeof instruction !== 'string' || !instruction.trim()) {
    return { ok: false, reason: 'INSTRUCTION_INVALID', detail: 'instruction must be a non-empty string.' };
  }
  const bytes = Buffer.byteLength(instruction, 'utf8');
  if (bytes > INSTRUCTION_MAX_BYTES) {
    return { ok: false, reason: 'INSTRUCTION_INVALID', detail: `instruction exceeds ${INSTRUCTION_MAX_BYTES} bytes (${bytes}).` };
  }
  if (model !== null && !(typeof model === 'string' && MODEL_RE.test(model))) {
    return { ok: false, reason: 'MODEL_INVALID', model };
  }
  // Fixed, supported interface only (verified against `opencode run --help`).
  // --agent build: pin the CODING agent (the CLI default is the read-only
  // `plan` agent — useless for a coding executor). No --auto: the permission
  // policy lives in the canonical opencode.json (executor-autonomy profile,
  // no ask keys => 0 prompts by construction) and is enforced by the launch
  // preflight. No --thinking (no hidden CoT capture).
  const argv = ['run', '--format', 'json', '--agent', 'build', '--print-logs', '--log-level', 'INFO'];
  if (model) argv.push('--model', model);
  argv.push(instruction); // DATA: single argv element, shell-less spawn
  return { ok: true, argv };
}

// ---- event classification (OBSERVABILITY PASSTHROUGH) ----------------------
// The ONLY derived field is `kind`, used for presentation (which pane/style).
// The parsed event is carried verbatim. Never infers agent-loop state.
export function classifyEvent(line) {
  const s = String(line);
  if (!s.trim()) return null;
  try {
    const ev = JSON.parse(s);
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) throw new Error('not an object');
    const part = ev.part && typeof ev.part === 'object' ? ev.part : null;
    if (ev.type === 'text' && part && typeof part.text === 'string') {
      return { kind: 'text', event: ev, text: part.text };
    }
    if (ev.type === 'tool' || (part && part.type === 'tool')) {
      return { kind: 'tool', event: ev, tool: (part && part.tool) || ev.tool || null };
    }
    if (ev.type === 'step_start' || ev.type === 'step_finish') {
      return { kind: ev.type, event: ev };
    }
    return { kind: 'event', event: ev };
  } catch {
    return {
      kind: 'output',
      line: s.length > ACTIVITY_LINE_MAX_BYTES ? s.slice(0, ACTIVITY_LINE_MAX_BYTES) + '…[truncated]' : s,
    };
  }
}

// ---- record paths + fail-closed reads ---------------------------------------
export function executionRecordPath({ stateDir, identityHash: h }) {
  return path.join(path.resolve(stateDir), 'executions', `${h}.json`);
}
export function executionEventsPath({ stateDir, identityHash: h }) {
  return path.join(path.resolve(stateDir), 'executions', `${h}.events.jsonl`);
}
export function executionTerminalEvidencePath({ stateDir, identityHash: h }) {
  return path.join(path.resolve(stateDir), 'executions', `${h}.terminal-evidence.json`);
}

export function effectiveStatus(record, isAlive, readStartTime) {
  if (!record || typeof record !== 'object') return null;
  if (record.terminalStatus) return record.terminalStatus;
  if (record.pid == null) return 'STARTING';
  const alive = typeof isAlive === 'function' ? isAlive(record.pid) : pidAlive(record.pid);
  // Issue #93: in the window between child-exit and the exit-handler's atomic
  // finalize write, a poll must not project INTERRUPTED for a successful run.
  // Dead pid + not finalized = finalization in flight => RUNNING (the 30m poll
  // deadline bounds pathological cases). Legacy dead records without finalized
  // also stay RUNNING (safe direction).
  if (!alive) return record.finalized === true ? 'INTERRUPTED' : 'RUNNING';
  // Issue #160: a live pid is NOT proof of the SAME executor incarnation
  // (Windows recycles pids). When the record pinned a processStartTime AND a
  // probe is supplied, a mismatch means the pid was reused => EXITED. With no
  // recorded startTime or no probe, the prior RUNNING projection is preserved
  // (backward compatibility); the STRICT identity decision lives in
  // reconcileExecutorLiveness (executor-reconcile.mjs) used by the reconnect
  // gate, which never auto-claims RUNNING without proven identity.
  if (record.processStartTime != null && typeof readStartTime === 'function') {
    const probe = readStartTime(record.pid);
    if (probe && probe.processStartTime != null && probe.processStartTime !== record.processStartTime) {
      return 'EXITED';
    }
  }
  return 'RUNNING';
}

function resolveIdentity({ repo, issueNumber }) {
  const h = identityHash({ repo, issueNumber });
  if (!h) return null;
  return { identityHash: h };
}

export function readExecutionRecord({ stateDir, repo, issueNumber }) {
  const id = resolveIdentity({ repo, issueNumber });
  if (!id) return { ok: false, reason: 'EXECUTION_IDENTITY_INVALID' };
  const p = executionRecordPath({ stateDir, identityHash: id.identityHash });
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return { ok: false, reason: 'EXECUTION_NOT_FOUND', path: p }; }
  let record;
  try { record = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'EXECUTION_RECORD_INVALID', detail: String((e && e.message) || e) }; }
  if (!record || record.schemaVersion !== EXECUTION_SCHEMA_VERSION || record.identityHash !== id.identityHash) {
    return { ok: false, reason: 'EXECUTION_RECORD_INVALID', detail: 'Record is schema-mismatched or not at its canonical location.' };
  }
  return { ok: true, record, path: p };
}

// Isolated activity read: a missing/corrupt stream MUST NOT corrupt lifecycle
// facts (Issue #53 correction, item C).
export function readActivityTail({
  stateDir, repo, issueNumber,
  maxLines = ACTIVITY_TAIL_MAX_LINES, clock = Date.now,
} = {}) {
  const id = resolveIdentity({ repo, issueNumber });
  if (!id) return { ok: false, reason: 'EXECUTION_IDENTITY_INVALID' };
  const p = executionEventsPath({ stateDir, identityHash: id.identityHash });
  let raw = '';
  let mainAvailable = true;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { mainAvailable = false; }
  const terminal = readTerminalEvidenceItems(executionTerminalEvidencePath({ stateDir, identityHash: id.identityHash })) ?? [];
  if (!mainAvailable && terminal.length === 0) return { ok: false, reason: 'ACTIVITY_UNAVAILABLE', path: p };
  const lines = raw.split('\n').filter((l) => l.length > 0);
  const total = lines.length;
  const kept = lines.slice(Math.max(0, total - maxLines));
  const items = [];
  for (const l of kept) {
    // Stored lines are already wrapped items (written by attachPassthrough).
    // No re-classification: the passthrough payload stays verbatim.
    let obj;
    try { obj = JSON.parse(l); } catch { obj = null; }
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      items.push({ seq: 0, t: 0, stream: 'stdout', ...obj });
    } else {
      items.push({ kind: 'output', line: l.length > ACTIVITY_LINE_MAX_BYTES ? l.slice(0, ACTIVITY_LINE_MAX_BYTES) + '…[truncated]' : l });
    }
  }
  items.push(...terminal);
  return { ok: true, items, totalLines: total, truncated: total > kept.length, terminalEvidenceIncluded: terminal.length > 0 };
}

// ---- child env (bounded allowlist) ------------------------------------------
export function buildChildEnv(env = process.env) {
  // ponytail: fixed allowlist; extend with provider env vars only when a
  // second executor/provider needs them (upgrade path: named prefix rule).
  const allowlist = [
    'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'TEMP', 'TMP',
    'USERPROFILE', 'HOME', 'OS', 'ComSpec', 'PROCESSOR_ARCHITECTURE',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMDATA',
    // Issue #83 (P0-G): the operator's opencode provider config resolves
    // {env:NINE_ROUTER_API_KEY}; without it the headless executor 401s
    // ("Missing API key") on every real run. Documented upgrade path.
    'NINE_ROUTER_API_KEY',
  ];
  const out = {};
  for (const k of allowlist) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

// ---- capability preflight (fail fast BEFORE spawn) -----------------------------
// A coding task needs shell + edit + test + discovery. The permission lives in
// the worktree opencode.json projection (canonical, written by taskStart) —
// preflight reads it back from disk and fails closed on any missing/ask key:
// headless OpenCode silently auto-rejects those (GPT-REV-137), which would look
// like a successful launch that does nothing.
export function preflightCodingCapabilities({ executable, worktreePath, spawnSync = nodeSpawnSync } = {}) {
  let version = null;
  try {
    const r = spawnSync(executable, ['--version'], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
    const m = String(r.stdout || '').match(/(\d+\.\d+\.\d+)/);
    if (m) version = m[1];
  } catch { /* diagnostics only: launch continues with version null */ }
  const cfg = readOpenCodeConfig({ worktreePath });
  if (!cfg.ok) return { ok: false, reason: cfg.reason, detail: cfg.detail, path: cfg.path, version };
  const caps = evaluateCodingCapabilities(cfg.config);
  if (!caps.ok) return { ok: false, ...caps, version };
  return { ok: true, version, agent: 'build', toolCaps: caps.toolCaps };
}

export function preflightCommandCodeCapabilities({ executable, argvPrefix = [], spawnSync = nodeSpawnSync } = {}) {
  try {
    const r = spawnSync(executable, [...argvPrefix, '--version'], {
      timeout: 10000,
      windowsHide: true,
      encoding: 'utf8',
      shell: false,
    });
    if (r.error || r.status !== 0) {
      return {
        ok: false,
        reason: 'COMMAND_CODE_PREFLIGHT_FAILED',
        detail: String(r.error?.message || r.stderr || `exit ${r.status}`),
      };
    }
    const version = String(r.stdout || '').match(/(\d+\.\d+\.\d+)/)?.[1] || null;
    return { ok: true, version, agent: 'headless', toolCaps: { read: true, edit: true, shell: true } };
  } catch (e) {
    return { ok: false, reason: 'COMMAND_CODE_PREFLIGHT_FAILED', detail: String(e?.message || e) };
  }
}

function classifyOpenCodeOutcome({ exitCode, signal = null }) {
  const ok = exitCode === 0 && !signal;
  return {
    terminalStatus: ok ? 'EXITED' : 'FAILED',
    executionOutcome: ok ? 'COMPLETED' : 'FAILED',
    retryable: false,
    reason: ok ? null : `EXECUTOR_EXIT_CODE_${exitCode ?? 'null'}_SIGNAL_${signal ?? 'null'}`,
  };
}

export function resolveExecutorProvider(executor = EXECUTOR_ID) {
  if (executor === EXECUTOR_ID) {
    return {
      id: EXECUTOR_ID,
      resolveExecutable: resolveOpenCodeExecutable,
      buildLaunchArgv,
      preflight: preflightCodingCapabilities,
      classifyEvent,
      classifyOutcome: classifyOpenCodeOutcome,
    };
  }
  if (executor === COMMAND_CODE_EXECUTOR_ID) {
    return {
      id: COMMAND_CODE_EXECUTOR_ID,
      resolveExecutable: resolveCommandCodeExecutable,
      buildLaunchArgv: buildCommandCodeLaunchArgv,
      preflight: preflightCommandCodeCapabilities,
      classifyEvent: classifyCommandCodeEvent,
      classifyOutcome: classifyCommandCodeOutcome,
    };
  }
  return null;
}

// ---- launch -------------------------------------------------------------------
// Synchronous through record write (single-threaded handler => no double-launch
// interleaving). `session`/`binding`/`sessionPath` come from taskStart's
// verified return; authority is re-derived via verifySessionAuthority (never
// trusted from the caller alone).
// ---- Issue #132 (rework step 2): mandatory execution-identity assert ---------
// The ExecutionRecord must be bound into the SAME repo/issue/identityHash/
// session/worktree chain as the taskStart session it is launched from. The
// session is re-read FROM ITS CANONICAL LOCATION (never the caller's copy) and
// every identity field must match the launch binding; any mismatch fails
// closed BEFORE spawn — no executor process is ever started outside the chain.
export function assertExecutionIdentity({ sessionPath, binding }) {
  const rs = readSessionRecord(sessionPath);
  if (!rs.ok) return { ok: false, reason: 'EXECUTION_IDENTITY_MISMATCH', detail: `session read failed: ${rs.reason || 'unknown'}` };
  const s = rs.session;
  const b = binding || {};
  const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : v);
  const checks = [
    ['identityHash', s.identityHash, b.identityHash],
    ['worktreePath', s.worktreePath, b.path],
    ['baseSha', s.baseSha, b.baseSha],
    ['branch', s.branch, b.branch],
    ['repo', lower(s.repo), lower(b.repo)],
    ['issueNumber', Number(s.issueNumber), Number(b.issueNumber)],
    ['taskId', s.taskId, b.taskId],
  ];
  for (const [field, sessionValue, bindingValue] of checks) {
    if (sessionValue !== bindingValue) {
      return { ok: false, reason: 'EXECUTION_IDENTITY_MISMATCH', detail: `session.${field}=${JSON.stringify(sessionValue)} binding.${field}=${JSON.stringify(bindingValue)}` };
    }
  }
  return { ok: true, session: s };
}

export function startExecution({
  sessionPath, session, binding, instruction, model = null,
  stateDir, controlCwd = process.cwd(), env = process.env,
  spawn = nodeSpawn, clock = Date.now, isAlive = pidAlive,
  executor = EXECUTOR_ID, resumeSessionId = null,
  resolveExecutable = null,
  verifyAuthority = verifySessionAuthority,
  preflight = null,
  telemetry = null,
} = {}) {
  const provider = resolveExecutorProvider(executor);
  if (!provider) return { ok: false, reason: 'EXECUTOR_PROVIDER_UNSUPPORTED', executor };
  if (!session || !session.leaseToken) return { ok: false, reason: 'SESSION_AUTHORITY_REJECTED', detail: 'session with leaseToken is required.' };
  if (!binding || !binding.path || !binding.identityHash) return { ok: false, reason: 'SESSION_AUTHORITY_REJECTED', detail: 'taskStart binding is required.' };
  if (typeof sessionPath !== 'string' || !sessionPath) return { ok: false, reason: 'SESSION_AUTHORITY_REJECTED', detail: 'sessionPath is required for the mandatory execution-identity assert.' };
  const av = verifyAuthority({ sessionPath, leaseToken: session.leaseToken, controlCwd });
  if (!av || !av.ok) {
    return { ok: false, reason: 'SESSION_AUTHORITY_REJECTED', detail: (av && av.reason) || 'verify failed' };
  }
  // Issue #132 rework step 2: mandatory execution-identity assert BEFORE spawn.
  const idc = assertExecutionIdentity({ sessionPath, binding });
  if (!idc.ok) return idc;
  const iv = provider.buildLaunchArgv({ instruction, model, resumeSessionId });
  if (!iv.ok) return { ok: false, ...iv };
  const ex = (resolveExecutable || provider.resolveExecutable)({ env });
  if (!ex.ok) return { ok: false, ...ex };
  // Capability preflight: fail fast BEFORE spawn if the worktree projection
  // lacks the minimum coding tool surface (missing/ask keys auto-reject
  // headless — GPT-REV-137 — and would look like a no-op launch).
  const pref = (preflight || provider.preflight)({
    executable: ex.executable,
    argvPrefix: ex.argvPrefix || [],
    worktreePath: binding.path,
  });
  if (!pref.ok) return { ok: false, ...pref }; // specific preflight reason passes through

  const recPath = executionRecordPath({ stateDir, identityHash: binding.identityHash });
  const prev = readExecutionRecord({ stateDir, repo: binding.repo, issueNumber: binding.issueNumber });
  if (prev.ok && prev.record && pendingExecutorLatch(prev.record)) {
    // Issue #160 BLOCKER-2: a prior launch left a bind/cleanup LATCH. Refuse to
    // spawn a second executor until the EXACT prior incarnation (PID +
    // processStartTime) is proven gone or reused. Prove only - do NOT kill (that
    // is #157/#167 reaper scope).
    const priorGone = priorIncarnationProvenGone({
      pid: prev.record.pid, processStartTime: prev.record.processStartTime,
      isAlive, readStartTime: readWin32ProcessStartTime,
    });
    if (!priorGone.provenGone) {
      return { ok: false, reason: 'EXECUTION_CLEANUP_REQUIRED', status: 'BLOCKED', detail: priorGone.reason, pid: prev.record.pid ?? null };
    }
  } else if (prev.ok) {
    const st = effectiveStatus(prev.record, isAlive);
    if (st === 'RUNNING' || st === 'STARTING') {
      return { ok: false, reason: 'EXECUTION_ALREADY_RUNNING', status: st, pid: prev.record.pid };
    }
    // EXITED/FAILED/STOPPED/INTERRUPTED with no latch: relaunch overwrites.
  }

  fs.mkdirSync(path.dirname(recPath), { recursive: true });
  const eventsPath = executionEventsPath({ stateDir, identityHash: binding.identityHash });
  try { fs.writeFileSync(eventsPath, '', 'utf8'); } catch { /* append-only below */ }

  // Issue #160 BLOCKER-3: durable PRE-SPAWN latch, persisted + read-back BEFORE
  // the spawn side effect. From the moment a child may exist until strict bind
  // success or proven-gone cleanup, every mutation path (incl. explicit
  // control-plane) is denied via this record. If it cannot be proven durable we
  // must NOT spawn.
  {
    const latchRecord = {
      schemaVersion: EXECUTION_SCHEMA_VERSION, kind: 'ExecutionRecord',
      identityHash: binding.identityHash, taskId: binding.taskId, repo: binding.repo,
      issueNumber: binding.issueNumber, baseSha: binding.baseSha, branch: binding.branch,
      worktreePath: binding.path, executor: provider.id, pid: null, processStartTime: null,
      startedAt: clock(), finishedAt: null, exitCode: null, signal: null, terminalStatus: null,
      reason: null, sessionId: null, pendingExecutorBind: true,
    };
    writeRecordAtomic(recPath, latchRecord);
    const back = readRecord(recPath);
    if (!back || back.pendingExecutorBind !== true) {
      return { ok: false, reason: 'LAUNCH_LATCH_PERSIST_FAILED', detail: 'durable pre-spawn latch could not be persisted + read back; refusing to spawn' };
    }
  }

  const launchArgv = [...(Array.isArray(ex.argvPrefix) ? ex.argvPrefix : []), ...iv.argv];
  const child = spawn(ex.executable, launchArgv, {
    cwd: binding.path, // taskStart-verified worktree ONLY
    env: buildChildEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  const startedAt = clock();
  // Issue #160 r3/r4 BLOCKER-1: capture the child's immutable identity (PID +
  // Win32 processStartTime) SYNCHRONOUSLY now. This captured value is the ONLY
  // canonical process identity; no later probe may establish or replace it.
  let launchStartTime = null;
  try { const p0 = readWin32ProcessStartTime(child.pid); launchStartTime = p0 && p0.processStartTime != null ? p0.processStartTime : null; } catch { launchStartTime = null; }
  let stopRequested = false; // closure-scoped per execution
  const record = {
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    kind: 'ExecutionRecord',
    identityHash: binding.identityHash,
    taskId: binding.taskId,
    repo: binding.repo,
    issueNumber: binding.issueNumber,
    baseSha: binding.baseSha,
    branch: binding.branch,
    worktreePath: binding.path,
    executor: provider.id,
    executable: ex.executable,
    executableArgvPrefix: ex.argvPrefix || [],
    executorVersion: pref.version ?? null,
    agent: pref.agent ?? 'build',
    toolCaps: pref.toolCaps ?? null,
    model: model || null,
    pid: child.pid ?? null,
    processStartTime: launchStartTime,          // canonical, immutable (null -> unproven)
    pendingExecutorBind: true,                 // cleared only on strict bind success
    startedAt,
    finishedAt: null,
    exitCode: null,
    signal: null,
    terminalStatus: null,
    reason: null,
    instructionDigest: createHash('sha256').update(instruction).digest('hex'),
    instructionBytes: Buffer.byteLength(instruction, 'utf8'),
    sessionId: null,
    eventsPath,
    eventsOverflow: false,
  };
  writeRecordAtomic(recPath, record);
  let overflow = false;
  const passthrough = attachPassthrough({
    child,
    eventsPath,
    record,
    clock,
    classify: provider.classifyEvent,
    setOverflow: (v) => { overflow = v; },
    onSessionId: (sessionId) => {
      if (!sessionId) return;
      try {
        const cur = readRecord(recPath);
        if (cur && !cur.sessionId) writeRecordAtomic(recPath, { ...cur, sessionId });
      } catch { /* diagnostic persistence is best effort */ }
    },
  });

  // Diagnostic only: a later probe may record probeProcessStartTime but MUST NOT
  // mutate the canonical processStartTime (stays the captured launchStartTime).
  const pst = setTimeout(() => {
    try {
      const cur = readRecord(recPath);
      if (!cur || cur.terminalStatus) return;
      const p0 = readWin32ProcessStartTime(child.pid);
      if (p0) writeRecordAtomic(recPath, { ...cur, probeProcessStartTime: p0.processStartTime });
    } catch { /* diagnostics only */ }
  }, 0);
  if (typeof pst.unref === 'function') pst.unref();

  child.on('error', (e) => {
    const cur = readRecord(recPath);
    const merged = {
      ...(cur || record),
      finishedAt: clock(),
      exitCode: null,
      signal: null,
      terminalStatus: 'FAILED',
      reason: `EXECUTOR_SPAWN_FAILED: ${String((e && e.message) || e)}`,
      finalized: true,
      sessionId: record.sessionId,
      eventsOverflow: overflow,
    };
    writeRecordAtomic(recPath, merged);
    record.terminalStatus = 'FAILED';
    if (overflow) appendTerminalEvidence({ stateDir, identityHash: binding.identityHash, event: { kind: 'EXECUTOR_TERMINAL', terminalStatus: 'FAILED', exitCode: null, signal: null, reason: merged.reason, finalized: true, eventsOverflow: true }, clock });
    if (telemetry) safeRecord(telemetry, 'EXECUTOR_FINISHED', { ok: false, reason: merged.reason });
  });
  child.on('exit', (code, signal) => {
    const outcome = stopRequested
      ? { terminalStatus: 'STOPPED', executionOutcome: 'STOPPED', retryable: false, reason: 'CONTROL_PLANE_STOP' }
      : provider.classifyOutcome({ exitCode: code, signal: signal || null, result: passthrough.result() });
    const terminal = outcome.terminalStatus;
    const cur = readRecord(recPath);
    const merged = {
      ...(cur || record),
      finishedAt: clock(),
      exitCode: code,
      signal: signal || null,
      terminalStatus: terminal,
      executionOutcome: outcome.executionOutcome,
      retryable: outcome.retryable,
      reason: outcome.reason,
      finalized: true,
      sessionId: record.sessionId,
      eventsOverflow: overflow,
    };
    writeRecordAtomic(recPath, merged);
    record.terminalStatus = terminal;
    if (overflow) appendTerminalEvidence({ stateDir, identityHash: binding.identityHash, event: { kind: 'EXECUTOR_TERMINAL', terminalStatus: terminal, executionOutcome: outcome.executionOutcome, exitCode: code, signal: signal || null, reason: merged.reason, finalized: true, eventsOverflow: true }, clock });
    if (telemetry) safeRecord(telemetry, 'EXECUTOR_FINISHED', { ok: terminal === 'EXITED', exitCode: code, signal, terminalStatus: terminal, executionOutcome: outcome.executionOutcome, retryable: outcome.retryable });
  });

  if (telemetry) safeRecord(telemetry, 'EXECUTOR_STARTED', { pid: record.pid, model: record.model, executable: ex.executable });

  {
    // Issue #160 REWORK F2: promote the authoritative session to executor context
    // (control-plane-owned). The MCP mutation gate requires a reconciled same-
    // attempt ExecutionRecord + proven process identity only in this mode; a
    // session never launched here stays control-plane. Fail-closed if the marker
    // cannot be persisted + read back.
    const em = updateSessionUnderOwnershipLock(sessionPath, (auth) => { auth.executionMode = 'executor'; return { session: auth }; });
    // Issue #160 REWORK r3 BLOCKER-2: success ONLY on a strictly proven read-back.
    // em.ok===true with a missing/null session or a non-'executor' read-back value
    // is a BIND FAILURE (no fail-open).
    const bindOk = bindReadbackOk(em);
    if (!bindOk) {
      const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* non-blocking env */ } };
      // Cleanup uses ONLY the identity captured synchronously at spawn. If that
      // capture was unavailable (launchStartTime === null), terminateAndProveCleanup
      // refuses to kill (cannot prove the live pid is our child) -> cleanupRequired.
      const cl = terminateAndProveCleanup({
        pid: child.pid,
        startTime: launchStartTime,
        isAlive: (p) => { try { process.kill(p, 0); return true; } catch { return false; } },
        readStartTime: (p) => readWin32ProcessStartTime(p),
        kill: (p) => { try { process.kill(p); } catch { /* handled in prove loop */ } },
        sleep: sleepSync,
      });
      // Persist the reconciled terminal state so the session is never a usable
      // control-plane/executor mutation path: executor-mode requires a live,
      // identity-proven record; STOPPED/INTERRUPTED + cleanupRequired deny until a
      // successful relaunch overwrites it. Best-effort; if this write fails the
      // mutation still fails closed (no proven RUNNING executor).
      // Keep the durable pendingExecutorBind latch when the child is NOT proven gone, so a failed best-effort write here still leaves the pre-spawn pendingExecutorBind:true record on disk denying every mutation path. When proven gone, clear the latch (no permanent poison) and mark STOPPED.
      try { writeRecordAtomic(recPath, { ...record, processStartTime: launchStartTime, terminalStatus: cl.provenGone ? 'STOPPED' : 'INTERRUPTED', cleanupRequired: !cl.provenGone, pendingExecutorBind: !cl.provenGone, finalized: cl.provenGone, reason: 'EXECUTION_CONTEXT_BIND_FAILED' }); } catch { /* pre-spawn pendingExecutorBind:true record stays -> still fail-closed */ }
      return { ok: false, reason: 'EXECUTION_CONTEXT_BIND_FAILED', cleanupRequired: !cl.provenGone, provenGone: cl.provenGone, identityProven: launchStartTime != null, detail: { bind: (em && (em.reason || em.detail)) || 'read-back mismatch', cleanup: cl.action } };
    }
    // LATCH-CLEAR COMMIT (final blocker): startExecution may report success ONLY
    // after pendingExecutorBind:false is persisted AND read back with the
    // canonical captured identity intact. Any persist/read-back shortfall is NOT
    // success: reconcile the exact child by captured PID+processStartTime and
    // preserve the durable fail-closed latch (never a second owner).
    {
      const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* non-blocking env */ } };
      try { const cur = readRecord(recPath); writeRecordAtomic(recPath, { ...(cur || record), pid: child.pid, processStartTime: launchStartTime, pendingExecutorBind: false, cleanupRequired: false }); } catch { /* fall through to read-back; a failed write leaves the durable true latch on disk */ }
      let clearRb = null; try { clearRb = readRecord(recPath); } catch { clearRb = null; }
      const clearCommitted = evaluateLatchClear(clearRb, { pid: child.pid, startTime: launchStartTime }).ok;
      if (!clearCommitted) {
        const cl = terminateAndProveCleanup({
          pid: child.pid, startTime: launchStartTime,
          isAlive: (p) => { try { process.kill(p, 0); return true; } catch { return false; } },
          readStartTime: (p) => readWin32ProcessStartTime(p),
          kill: (p) => { try { process.kill(p); } catch { /* prove loop */ } },
          sleep: sleepSync,
        });
        // Keep/restore the durable latch when the child is not proven gone; if it is
        // proven gone, clear poison with a terminal STOPPED record. Best-effort: the
        // pre-spawn pendingExecutorBind:true remains the fallback defense on write fail.
        try { const cur = readRecord(recPath); writeRecordAtomic(recPath, { ...(cur || record), pid: child.pid, processStartTime: launchStartTime, terminalStatus: cl.provenGone ? 'STOPPED' : 'INTERRUPTED', pendingExecutorBind: !cl.provenGone, cleanupRequired: !cl.provenGone, finalized: cl.provenGone, reason: 'EXECUTION_LATCH_CLEAR_FAILED' }); } catch { /* durable latch still denies */ }
        return { ok: false, reason: 'EXECUTION_LATCH_CLEAR_FAILED', cleanupRequired: !cl.provenGone, provenGone: cl.provenGone, identityProven: launchStartTime != null, detail: { cleanup: cl.action } };
      }
      record.pendingExecutorBind = false;
    }
  }

  return {
    ok: true,
    identityHash: binding.identityHash,
    taskId: binding.taskId,
    pid: record.pid,
    child,
    markStopRequested: () => { stopRequested = true; },
    status: 'RUNNING',
    startedAt,
    recordPath: recPath,
    eventsPath,
  };
}

// OBSERVABILITY PASSTHROUGH plumbing: pipes child stdout (NDJSON events) and
// stderr (opencode logs) verbatim into the append-only activity file. The only
// derived fields are seq/t/stream and the presentation kind. sessionID is
// captured once as a supported diagnostics fact.
function attachPassthrough({ child, eventsPath, record, clock, setOverflow, classify = classifyEvent, onSessionId = null }) {
  let seq = 0;
  let fileOverflow = false;
  let resultFrame = null;
  const markOverflow = () => { if (!fileOverflow) { fileOverflow = true; setOverflow(true); } };
  const append = (stream, chunk) => {
    if (fileOverflow) return;
    try {
      if (fs.statSync(eventsPath).size > ACTIVITY_FILE_MAX_BYTES) { markOverflow(); return; }
    } catch { markOverflow(); return; } // stat failure => stop appending (fail-closed)
    for (const line of String(chunk).split(/\r?\n/)) {
      const c = classify(line);
      if (!c) continue;
      seq += 1;
      const sessionId = c.sessionId || (c.event && (c.event.sessionID || c.event.sessionId));
      if (typeof sessionId === 'string' && !record.sessionId) {
        record.sessionId = sessionId;
        if (typeof onSessionId === 'function') onSessionId(sessionId);
      }
      if (c.kind === 'result') resultFrame = c.event;
      const out = { seq, t: clock(), stream, ...c };
      try { fs.appendFileSync(eventsPath, `${JSON.stringify(out)}\n`, 'utf8'); } catch { markOverflow(); return; }
    }
  };
  let stdoutBuf = '';
  if (child.stdout) {
    child.stdout.on('data', (d) => {
      stdoutBuf += String(d);
      const parts = stdoutBuf.split(/\r?\n/);
      stdoutBuf = parts.pop();
      if (parts.length) append('stdout', parts.join('\n'));
    });
    child.stdout.on('end', () => { if (stdoutBuf) { append('stdout', stdoutBuf); stdoutBuf = ''; } });
  }
  if (child.stderr) child.stderr.on('data', (d) => append('stderr', d));
  return { result: () => resultFrame };
}

// ---- stop (control-plane launch/stop authority) --------------------------------
// Kills the task-owned child launched by THIS process. Cross-process stop is
// not supported in v0 (a restarted server observes INTERRUPTED and may relaunch).
export function stopExecution({ handle, kill = (c, sig) => c.kill(sig) } = {}) {
  if (!handle || !handle.child) return { ok: false, reason: 'NO_ACTIVE_EXECUTION' };
  if (typeof handle.markStopRequested === 'function') handle.markStopRequested();
  try { kill(handle.child, 'SIGTERM'); } catch (e) {
    return { ok: false, reason: 'STOP_FAILED', detail: String((e && e.message) || e) };
  }
  return { ok: true, pid: handle.pid ?? null, signal: 'SIGTERM' };
}

// Win32 pid/startTime liveness primitive lives in the temp-hygiene leaf so the
// idle sleep supervisor singleton can share it without importing this module.
// Re-exported here to preserve the executor-launcher public surface.
export { readWin32ProcessStartTime };

// ---- status projection -----------------------------------------------------------
export function readExecutionStatus({
  stateDir, repo, issueNumber,
  isAlive = pidAlive, clock = Date.now, tailMaxLines = ACTIVITY_TAIL_MAX_LINES,
  includeActivity = true,
} = {}) {
  const r = readExecutionRecord({ stateDir, repo, issueNumber });
  if (!r.ok) return r;
  const record = r.record;
  const status = effectiveStatus(record, isAlive);
  const finishedAt = record.finishedAt ?? ((status === 'RUNNING' || status === 'STARTING') ? clock() : null);
  const activity = includeActivity
    ? readActivityTail({ stateDir, repo, issueNumber, maxLines: tailMaxLines, clock })
    : null;
  // Public projection: process facts + diagnostics. instruction CONTENT is
  // never persisted here (digest only); paths stay internal to the control plane.
  return {
    ok: true,
    execution: {
      status,
      terminalStatus: record.terminalStatus ?? null,
      reason: record.reason ?? null,
      pid: record.pid,
      executor: record.executor,
      executable: record.executable ?? null,
      executorVersion: record.executorVersion ?? null,
      agent: record.agent ?? null,
      toolCaps: record.toolCaps ?? null,
      processStartTime: record.processStartTime ?? null,
      model: record.model,
      sessionId: record.sessionId,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      exitCode: record.exitCode,
      signal: record.signal,
      instructionDigest: record.instructionDigest,
      instructionBytes: record.instructionBytes,
      eventsOverflow: record.eventsOverflow === true,
      elapsedMs: record.startedAt != null && finishedAt != null ? Math.max(0, finishedAt - record.startedAt) : null,
    },
    activity,
  };
}

// ---- internals --------------------------------------------------------------------
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function readRecord(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
// Shared with the #157 reaper (executor-reaper.mjs): one canonical atomic
// record-publish path (tmp file + rename), never a second implementation.
export function writeRecordAtomic(p, obj) {
  const tmp = `${p}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, p);
}
// Issue #157 REWORK r3 (stale-observer TOCTOU): generation-bound
// CAS-equivalent publication. read->compare->rename over a mutable pathname
// is NOT a conditional update: a replacement can land between the compare and
// the rename, and the rename then destroys it. Here the atomic arbitration is
// CONSUME: the source pathname is atomically renamed into a private, unique
// quarantine name. Whatever file object the rename moved is now exclusively
// ours to inspect - if its exact bytes are not the source generation the
// caller examined, we lost the generation race and the primitive commits
// NOTHING: the consumed replacement is restored with an EXCLUSIVE hard-link
// (CreateHardLink fails with EEXIST on Windows - it can physically never
// overwrite an existing pathname), and a newer occupant is left untouched.
// Commit of the new generation uses the same create-only link, so a stale
// observer has zero overwrite-capable operations against the canonical name.
// A crash mid-arbitration leaves recoverable *.tmp residue (consumed/staging):
// recoveryExecutionCasQuarantine below is the bounded recovery protocol; the
// consumed quarantine can be the ONLY surviving canonical generation and is
// protected from generic temp-hygiene deletion until reconciled. Bytes are
// never destroyed by this primitive.
export function casReplaceIfCurrent(p, expectedRaw, obj, { afterConsume = null } = {}) {
  const dir = path.dirname(p);
  const base = path.basename(p);
  const uniq = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const consumed = path.join(dir, `.${base}.cas-${uniq}.consumed.tmp`);
  const staging = path.join(dir, `.${base}.cas-${uniq}.staging.tmp`);
  const nextRaw = `${JSON.stringify(obj, null, 2)}\n`;
  try { fs.writeFileSync(staging, nextRaw, 'utf8'); } catch (e) {
    try { fs.unlinkSync(staging); } catch { /* residue */ }
    return { ok: false, reason: 'PUBLISH_PREP_FAILED', detail: String((e && e.code) || e.message || e), committed: false };
  }
  // ATOMIC ARBITRATION POINT: consume whatever is currently canonical.
  try { fs.renameSync(p, consumed); } catch (e) {
    try { fs.unlinkSync(staging); } catch { /* residue */ }
    return { ok: false, reason: e && e.code === 'ENOENT' ? 'SOURCE_MISSING' : 'CONSUME_FAILED', committed: false };
  }
  // Controllable mid-flight barrier (deterministic cross-writer race seam used
  // by the #157 rework regressions; null in production).
  if (typeof afterConsume === 'function') afterConsume({ consumedPath: consumed, stagingPath: staging, canonicalPath: p });
  let consumedRaw = null;
  try { consumedRaw = fs.readFileSync(consumed, 'utf8'); } catch { /* treat as missing */ }
  if (consumedRaw === null) return { ok: false, reason: 'SOURCE_MISSING', committed: false, restored: false, consumedPath: consumed };
  if (consumedRaw !== expectedRaw) {
    // We consumed a NEWER generation (its rename won before ours). Restore it
    // create-only; the quarantine file keeps the exact bytes if p is taken.
    const restored = restoreQuarantine(consumed, p);
    try { fs.unlinkSync(staging); } catch { /* residue */ }
    return { ok: false, reason: 'SOURCE_CHANGED', committed: false, restored, consumedPath: consumed };
  }
  // Won the generation: canonical was S and is now absent. Commit create-only.
  try { fs.linkSync(staging, p); } catch (e) {
    // EEXIST: a fresh rename landed in the open slot first - it is untouched;
    // restore our source generation the same create-only way, lose cleanly.
    const restored = restoreQuarantine(consumed, p);
    try { fs.unlinkSync(staging); } catch { /* residue */ }
    return { ok: false, reason: 'COMMIT_RACE_LOST', committed: false, restored, consumedPath: consumed };
  }
  try { fs.unlinkSync(consumed); } catch { /* residue */ } // retires the consumed S generation
  try { fs.unlinkSync(staging); } catch { /* residue */ }  // p keeps the committed binding
  return { ok: true, committed: true, raw: nextRaw };
}
// Re-attach the quarantined generation at p ONLY while p is absent.
// linkSync/create-hardlink fails EEXIST on Windows: this can never overwrite
// a newer occupant. Returns whether the canonical binding was restored.
function restoreQuarantine(consumedPath, p) {
  try { fs.linkSync(consumedPath, p); } catch { return false; }
  try { fs.unlinkSync(consumedPath); } catch { /* residue */ }
  return true;
}
// ---- Issue #157 REWORK r4: bounded quarantine recovery ----------------------
// A crash between the CAS consume rename and the commit/restore link can leave
// the canonical ExecutionRecord ABSENT while its only surviving generation
// sits in a private `.cas-*.consumed.tmp` quarantine beside it.
// recoverExecutionCasQuarantine is the control-plane recovery protocol for
// exactly one canonical record location. It is create-only and byte-exact:
//   - quarantine ownership: name must sit at the record's canonical directory
//     carrying that record's base prefix, and content must validate as an
//     ExecutionRecord generation of the EXACT identity (kind/schemaVersion/
//     identityHash/repo/issueNumber) - foreign or malformed files are
//     reported and NEVER deleted;
//   - canonical present  -> never overwrite anything; only a quarantine whose
//     bytes are byte-identical to canonical is a proven-redundant binding
//     (crash between commit-link and retire-unlink) and is retired; any other
//     generation is RETAINED for reconciliation;
//   - canonical absent + exactly one distinct valid generation -> restore via
//     create-only link (loses cleanly to any concurrent writer), then a
//     byte-exact read-back plus the canonical-location validation must pass
//     before the quarantine names are retired;
//   - canonical absent + conflicting generations -> AMBIGUOUS, fail closed,
//     zero deletions, no guessing;
//   - replay is idempotent (NO_QUARANTINE / NOOP_CANONICAL_PRESENT).
// Reproducible `.staging.tmp` residue (candidate bytes that were never
// canonical, regenerable from any snapshot) is retired only on reconciled
// paths. This is state restoration, not mutation authority: it never decides
// liveness, verdicts, or session state.
export function recoverExecutionCasQuarantine({ stateDir, repo, issueNumber } = {}) {
  const h = identityHash({ repo, issueNumber });
  if (!h) return { ok: false, reason: 'EXECUTION_IDENTITY_INVALID' };
  const p = executionRecordPath({ stateDir, identityHash: h });
  const dir = path.dirname(p);
  const base = path.basename(p);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return { ok: true, action: 'NO_QUARANTINE', recordPath: p }; }
  const consumedNames = entries.filter((n) => n.startsWith(`.${base}.cas-`) && n.endsWith('.consumed.tmp'));
  const stagingNames = entries.filter((n) => n.startsWith(`.${base}.cas-`) && n.endsWith('.staging.tmp'));
  if (consumedNames.length === 0) {
    // Nothing to recover: staging residue alone holds no surviving canonical
    // generation (pure candidate bytes) and is safe to retire.
    for (const n of stagingNames) { try { fs.unlinkSync(path.join(dir, n)); } catch { /* residue */ } }
    return { ok: true, action: 'NO_QUARANTINE', recordPath: p };
  }
  let curRaw = null;
  try { curRaw = fs.readFileSync(p, 'utf8'); } catch { curRaw = null; }
  const valid = [];
  const unowned = [];
  for (const n of consumedNames) {
    let raw = null;
    try { raw = fs.readFileSync(path.join(dir, n), 'utf8'); } catch { unowned.push(n); continue; }
    let obj = null;
    try { obj = JSON.parse(raw); } catch { unowned.push(n); continue; }
    const own = obj && typeof obj === 'object' && obj.kind === 'ExecutionRecord'
      && obj.schemaVersion === EXECUTION_SCHEMA_VERSION && obj.identityHash === h
      && String(obj.repo || '') === String(repo) && Number(obj.issueNumber) === Number(issueNumber);
    if (!own) { unowned.push(n); continue; }
    valid.push({ name: n, raw });
  }
  const retainedReport = unowned.slice();
  if (curRaw !== null) {
    // Canonical exists (a newer generation legitimately won the slot). NEVER
    // overwrite or re-link; only proven-redundant identical bindings retire.
    let retired = 0;
    for (const q of valid) {
      if (q.raw === curRaw) { try { fs.unlinkSync(path.join(dir, q.name)); retired += 1; } catch { retainedReport.push(q.name); } }
      else retainedReport.push(q.name);
    }
    for (const n of stagingNames) { try { fs.unlinkSync(path.join(dir, n)); } catch { retainedReport.push(n); } }
    return { ok: true, action: 'NOOP_CANONICAL_PRESENT', recordPath: p, retiredRedundant: retired, retained: retainedReport };
  }
  if (valid.length === 0) {
    return { ok: false, reason: 'RECOVERY_NO_VALID_GENERATION', unowned: retainedReport.length, retained: retainedReport, recordPath: p };
  }
  const byRaw = new Map();
  for (const q of valid) { if (!byRaw.has(q.raw)) byRaw.set(q.raw, []); byRaw.get(q.raw).push(q.name); }
  if (byRaw.size > 1) {
    // Multiple conflicting generations: fail closed, retain EVERYTHING.
    const all = valid.map((q) => q.name).concat(retainedReport, stagingNames);
    return { ok: false, reason: 'RECOVERY_AMBIGUOUS_GENERATIONS', groups: byRaw.size, retained: all, recordPath: p };
  }
  const [raw, groupNames] = [...byRaw.entries()][0];
  try { fs.linkSync(path.join(dir, groupNames[0]), p); } catch {
    // Slot refilled concurrently: create-only link loses; nothing is destroyed.
    const all = valid.map((q) => q.name).concat(retainedReport);
    return { ok: true, action: 'LOST_RACE_CANONICAL_PRESENT', recordPath: p, retained: all };
  }
  let back = null;
  try { back = fs.readFileSync(p, 'utf8'); } catch { /* below */ }
  const checked = back === raw ? readExecutionRecord({ stateDir, repo, issueNumber }) : { ok: false, reason: 'RECOVERY_BYTES_NOT_EXACT' };
  if (!checked.ok) {
    // Cannot prove the restore is the exact valid generation: keep every name
    // (canonical now holds the bytes; quarantine stays as forensic residue).
    return { ok: false, reason: 'RECOVERY_READBACK_INVALID', detail: checked.reason, retained: groupNames.concat(retainedReport), recordPath: p };
  }
  let retired = 0;
  for (const n of groupNames) { try { fs.unlinkSync(path.join(dir, n)); retired += 1; } catch { /* retry closes it */ } }
  for (const n of stagingNames) { try { fs.unlinkSync(path.join(dir, n)); } catch { /* residue */ } }
  return { ok: true, action: 'RESTORED', recordPath: p, retired, unownedRetained: unowned.length };
}
function safeRecord(recorder, event, detail) {
  try { recorder.record(event, detail); } catch { /* telemetry never breaks lifecycle */ }
}

// Issue #167: bounded terminal-evidence tail. It is observability only: it does
// not create or mutate the canonical ExecutionRecord and therefore has no
// mutation-owner conflict with #157/#160. Concurrent append uses the canonical
// generation-bound CAS primitive above: each writer observes one source
// generation, retries if that generation was replaced, and never performs a
// read-modify-rename that can silently overwrite another writer.
const TERMINAL_EVIDENCE_CAS_ATTEMPTS = 5;

function evidenceFromRaw(raw) {
  if (raw === '') return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    return [{ schemaVersion: '1', t: 0, kind: 'TERMINAL_EVIDENCE', event: { kind: 'TERMINAL_EVIDENCE_MALFORMED', detail: String(raw).slice(0, 4096) } }];
  }
  if (parsed && Array.isArray(parsed.entries)) return parsed.entries.slice(-TERMINAL_EVIDENCE_MAX_LINES);
  return [{ schemaVersion: '1', t: 0, kind: 'TERMINAL_EVIDENCE', event: { kind: 'TERMINAL_EVIDENCE_MALFORMED', detail: 'UNEXPECTED_GENERATION_SHAPE' } }];
}

function createEvidenceGenerationIfAbsent(p, obj) {
  const raw = `${JSON.stringify(obj, null, 2)}\n`;
  const staging = `${p}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.create.tmp`;
  try {
    fs.writeFileSync(staging, raw, 'utf8');
    try {
      fs.linkSync(staging, p);
      try { fs.unlinkSync(staging); } catch { /* committed binding */ }
      return { created: true };
    } catch (e) {
      try { fs.unlinkSync(staging); } catch { /* residue */ }
      if (e && e.code === 'EEXIST') return { created: false };
      return { created: false, detail: String((e && e.code) || e.message || e) };
    }
  } catch (e) {
    try { fs.unlinkSync(staging); } catch { /* residue */ }
    return { created: false, detail: String((e && e.code) || e.message || e) };
  }
}

export function appendTerminalEvidence({
  stateDir, identityHash, event, clock = Date.now,
  afterConsume = null, beforeCas = null,
} = {}) {
  try {
    const p = executionTerminalEvidencePath({ stateDir, identityHash });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const entry = { seq: 0, t: clock(), stream: 'terminal', schemaVersion: '1', kind: 'TERMINAL_EVIDENCE', event };
    const failures = [];
    let retiredQuarantine = 0;
    let seamUsed = false;
    for (let attempt = 0; attempt < TERMINAL_EVIDENCE_CAS_ATTEMPTS; attempt++) {
      let raw = null;
      try {
        raw = fs.readFileSync(p, 'utf8');
      } catch (e) {
        const init = createEvidenceGenerationIfAbsent(p, { schemaVersion: '1', entries: [] });
        if (init.created) continue;
        failures.push({ attempt: attempt + 1, reason: 'EVIDENCE_SOURCE_UNAVAILABLE', detail: init.detail ?? String((e && e.code) || e.message || e) });
        continue;
      }
      const next = evidenceFromRaw(raw).concat(entry).slice(-TERMINAL_EVIDENCE_MAX_LINES);
      if (!seamUsed && typeof beforeCas === 'function') { seamUsed = true; beforeCas({ sourceRaw: raw, canonicalPath: p, attempt }); }
      const pub = casReplaceIfCurrent(p, raw, { schemaVersion: '1', entries: next }, { afterConsume });
      if (pub.ok) {
        for (const q of failures) {
          try { fs.unlinkSync(q.consumedPath); retiredQuarantine++; } catch { /* superseded bytes remain for reconciliation */ }
        }
        return { ok: true, path: p, attempts: attempt + 1, entries: next, retiredQuarantine };
      }
      if (pub.reason === 'SOURCE_CHANGED' || pub.reason === 'COMMIT_RACE_LOST' || pub.reason === 'SOURCE_MISSING') {
        if (pub.consumedPath && pub.restored === false) failures.push({ attempt: attempt + 1, reason: pub.reason, consumedPath: pub.consumedPath });
        continue;
      }
      return { ok: false, path: p, reason: 'TERMINAL_EVIDENCE_PUBLISH_FAILED', detail: pub.reason, attempts: attempt + 1, failures };
    }
    return { ok: false, path: p, reason: 'TERMINAL_EVIDENCE_CAS_RETRY_EXHAUSTED', attempts: TERMINAL_EVIDENCE_CAS_ATTEMPTS, failures };
  } catch (e) {
    return { ok: false, path: null, reason: 'TERMINAL_EVIDENCE_APPEND_FAILED', detail: String((e && e.message) || e) };
  }
}

function readTerminalEvidenceItems(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return null; }
  return evidenceFromRaw(raw);
}
