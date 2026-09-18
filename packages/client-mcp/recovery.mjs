// recovery.mjs — manual MCP restart / reattach transport seam (post-#175/#179/#180).
//
// WHY: OpenCode (and every stdio MCP client) has NO native runtime restart of a
// local MCP server — a local server is spawned at OpenCode startup, so recovering
// a dead `soc-brain` adapter means RESTARTING THE TRANSPORT ONLY (fresh adapter
// process), never the task. The canonical task/session/ExecutionRecord/lease/
// Human-Gate checkpoint already live on disk under stateDir (client-mcp is
// stateless by design, #175; executor liveness is transport-independent, #180).
// What was missing is the READ-ONLY reattach seam: a fresh adapter must be able
// to resolve the SAME canonical task WITHOUT the operator re-typing identity,
// plus a transport-level connection state model that is strictly separate from
// the task FSM.
//
// HARD BOUNDARY (North Star): nothing here mutates canonical lifecycle state.
// The ONLY file this module writes is the client-namespace observability record
// <stateDir>/client-mcp/transport.json (same namespace as the submissions
// ledger; no lease tokens, no absolute paths). It never touches sessions/,
// executions/, activity/live/, the control-loop ledger, Human Gate state, or
// mutation ownership. It cannot submit, launch, answer gates, or authorize
// merges — recovery is read/reconcile only.
//
// Transport state model (client-local vocabulary; NOT task states):
//   RESTARTING          fresh adapter boot observed
//   REATTACHING         a recover attempt is resolving the canonical target
//   RECOVERED           exact task/session/execution identity re-read OK
//   RECOVERY_FAILED     a recover attempt failed closed (reason recorded)
//   DISCONNECTED        clean stdin EOF recorded by the dying adapter itself
//   CONNECTED           implicit while the adapter answers (not persisted)
//   RECOVERY_SCHEDULED  auto-supervisor: rebind backoff pending (supervisor.json)
//   HEALTHCHECK         auto-supervisor: waiting for the MCP handshake to return
// TRANSPORT_DISCONNECTED != EXECUTOR_GONE != TASK_FAILED != SESSION_TERMINAL —
// enforced by keeping every canonical read on the existing primitives.
//
// ponytail: transport.json is a best-effort observability record — concurrent
// restarts are last-writer-wins (atomic rename, always-valid JSON) and
// restartCount may undercount under a strict race. Upgrade path if the count
// must become authoritative: serialize through the execution-broker lock; not
// worth a new lock for telemetry.

import fs from 'node:fs';
import path from 'node:path';
import { readSessionRecord } from '../runtime-sandbox/runtime-sandbox.mjs';
import { readExecutionRecord } from '../executor-launcher/executor-launcher.mjs';
import { canonicalTaskActivityVerdict } from '../executor-launcher/executor-reconcile.mjs';

export const TRANSPORT_SCHEMA_VERSION = '1';
// The two AUTO-supervisor states (RECOVERY_SCHEDULED, HEALTHCHECK) extend the
// #182 manual vocabulary; they are still TRANSPORT-only — never task FSM states.
export const TRANSPORT_STATES = Object.freeze([
  'CONNECTED', 'DISCONNECTED', 'RECOVERY_SCHEDULED', 'RESTARTING', 'HEALTHCHECK', 'REATTACHING', 'RECOVERED', 'RECOVERY_FAILED',
]);
export const TERMINAL_TASK_STATES = Object.freeze(['COMPLETED', 'FAILED', 'BLOCKED']);

export function transportStatePathFor({ stateDir }) {
  return path.join(path.resolve(stateDir), 'client-mcp', 'transport.json');
}

function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function writeAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  try { fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8'); fs.renameSync(tmp, p); return true; }
  catch { try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ } return false; }
}

export function readTransportState({ stateDir }) {
  const cur = readJsonSafe(transportStatePathFor({ stateDir }));
  return { ok: true, state: cur && typeof cur === 'object' ? cur : null };
}

function stamp(now) { return new Date(now()).toISOString(); }

// Fresh-adapter boot: idempotent PER PROCESS (keyed by bootId), so repeated
// recover calls never double-count. If the previous adapter never recorded a
// clean disconnect, its death is classified UNGRACEFUL (kill/crash) and
// lastDisconnectAt approximates its final update — observability only, never a
// lifecycle fact.
export function recordAdapterBoot({ stateDir, bootId, now = () => Date.now() } = {}) {
  if (!stateDir || !bootId) return { ok: false, reason: 'TRANSPORT_BOOT_IDENTITY_MISSING' };
  const p = transportStatePathFor({ stateDir });
  const prev = readJsonSafe(p);
  if (prev && prev.lastBootId === bootId) return { ok: true, booted: false, state: prev };
  const at = stamp(now);
  let lastDisconnectAt = prev && prev.lastDisconnectAt != null ? prev.lastDisconnectAt : null;
  let lastDisconnectKind = prev && prev.lastDisconnectKind != null ? prev.lastDisconnectKind : null;
  if (prev && prev.closedCleanly === false && prev.lastBootId) {
    lastDisconnectAt = prev.updatedAt || at;
    lastDisconnectKind = 'UNGRACEFUL';
  }
  const state = {
    schemaVersion: TRANSPORT_SCHEMA_VERSION,
    transportState: 'RESTARTING',
    lastBootId: bootId,
    lastPid: process.pid,
    lastDisconnectAt, lastDisconnectKind,
    lastRestartAt: at,
    lastReattachAt: prev && prev.lastReattachAt != null ? prev.lastReattachAt : null,
    restartCount: (Number.isInteger(prev && prev.restartCount) ? prev.restartCount : 0) + 1,
    currentTaskIdentity: null,
    executionLiveness: null,
    humanGateState: null,
    lastRecoveryReason: null,
    closedCleanly: false,
    updatedAt: at,
  };
  const wrote = writeAtomic(p, state);
  return { ok: wrote, state };
}

// Clean stdin EOF: recorded by the exiting adapter itself so a later boot can
// distinguish a graceful transport close from a kill. Best-effort + silent —
// observability must never block or alter the exit path.
export function recordTransportDisconnect({ stateDir, bootId, now = () => Date.now() } = {}) {
  try {
    const p = transportStatePathFor({ stateDir });
    const cur = readJsonSafe(p);
    if (!cur || cur.lastBootId !== bootId || cur.closedCleanly === true) return { ok: true, recorded: false };
    cur.transportState = 'DISCONNECTED';
    cur.lastDisconnectAt = stamp(now);
    cur.lastDisconnectKind = 'CLEAN';
    cur.closedCleanly = true;
    cur.updatedAt = cur.lastDisconnectAt;
    return { ok: writeAtomic(p, cur), recorded: true };
  } catch { return { ok: false, recorded: false }; }
}

// Persist the outcome of ONE recover attempt (transport observability only).
// The success record also pins the exact identity binding (mutation owner,
// execution pid + immutable PROCESS_START_TIME, Human-Gate checkpoint) so the
// auto-recovery supervisor can verify the SAME canonical attempt read-only.
export function recordReattach({ stateDir, bootId, result, now = () => Date.now() } = {}) {
  const p = transportStatePathFor({ stateDir });
  const cur = readJsonSafe(p) || { schemaVersion: TRANSPORT_SCHEMA_VERSION, restartCount: 0 };
  if (cur.lastBootId !== bootId) return { ok: cur.closedCleanly === true, state: cur };
  const ok = result.ok === true;
  cur.transportState = ok ? 'RECOVERED' : 'RECOVERY_FAILED';
  cur.lastReattachAt = stamp(now);
  cur.updatedAt = cur.lastReattachAt;
  cur.currentTaskIdentity = ok ? (result.currentTaskIdentity ?? null) : null;
  cur.executionLiveness = ok ? (result.executionLiveness ?? null) : null;
  cur.humanGateState = ok ? (result.humanGateState ?? null) : 'NONE';
  cur.mutationOwner = ok ? (result.mutationOwner ?? null) : null;
  cur.executionPid = ok ? ((result.execution && result.execution.pid) ?? null) : null;
  cur.executionProcessStartTime = ok ? ((result.execution && result.execution.processStartTime) ?? null) : null;
  cur.humanGateAt = ok ? ((result.task && result.task.humanGate && result.task.humanGate.at) ?? null) : null;
  cur.lastRecoveryReason = ok ? null : (result.reason ?? 'UNKNOWN');
  return { ok: writeAtomic(p, cur), state: cur };
}

const HUMAN_GATE_WAITING_STATES = ['HUMAN_GATE_REQUIRED', 'WAITING_FOR_INPUT'];

// Canonical discovery WITHOUT operator re-entry: enumerate GENUINELY ACTIVE
// (non-terminal) task sessions straight from <stateDir>/sessions (readSessionRecord
// is the fail-closed canonical reader — identity-re-derived, tamper rejecting).
// ACTIVE-TASK INVARIANT (Issue #9000005, hardened by REWORK F1): a session is
// discovered ONLY when canonical evidence PROVES it active — an active Human Gate /
// resumable canonical wait, or a live identity-proven RUNNING executor (PID +
// immutable PROCESS_START_TIME). A PROMOTED executor attempt (executionMode ===
// 'executor') is NOT auto-discoverable on mode alone: it is judged on the SAME
// canonical liveness, so once its process is PROVEN GONE its SESSION_ACTIVE residue
// is excluded (never recovery-active indefinitely, never reproduces
// AMBIGUOUS_ACTIVE_TASKS). It is NEVER auto-discoverable merely because
// session.state === 'SESSION_ACTIVE': stale residue whose executor is gone (or which
// was never executed) is classified PARKED/UNKNOWN and excluded, so a transport
// reattach cannot be sent to a dead or never-started attempt. UNKNOWN/unprovable
// evidence fails closed (never treated as active); unreadable session records are
// counted so recovery refuses to guess in the ambiguous case.
function discoverableExecutionRecord({ stateDir, session }) {
  try {
    const r = readExecutionRecord({ stateDir, repo: session.repo, issueNumber: session.issueNumber });
    return r.ok ? r.record : null;
  } catch { return null; }
}

export function enumerateActiveTasks({ stateDir, isAlive, readStartTime } = {}) {
  const dir = path.join(path.resolve(stateDir), 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); }
  catch { return { ok: true, tasks: [], unreadable: 0, unknown: 0 }; }
  const tasks = [];
  let unreadable = 0;
  let unknown = 0;
  for (const name of names.sort()) {
    const rs = readSessionRecord(path.join(dir, name));
    if (!rs.ok || !rs.session || typeof rs.session !== 'object') { unreadable += 1; continue; }
    const s = rs.session;
    if (TERMINAL_TASK_STATES.includes(s.state)) continue;
    const isGate = HUMAN_GATE_WAITING_STATES.includes(s.state);
    // Feed the SAME canonical execution evidence to the predicate for every
    // non-gate session — promoted executor attempts included — so the decision is
    // made on liveness, never on executionMode alone (F1).
    const execution = !isGate ? discoverableExecutionRecord({ stateDir, session: s }) : null;
    const v = canonicalTaskActivityVerdict({ session: s, execution, isAlive, readStartTime });
    if (v.verdict === 'UNKNOWN') { unknown += 1; continue; }
    if (!v.active) continue;
    tasks.push({
      repo: s.repo ?? null,
      issueNumber: s.issueNumber ?? null,
      identityHash: s.identityHash ?? null,
      taskId: s.taskId ?? null,
      state: s.state ?? null,
      humanGateState: isGate ? 'WAITING' : 'NONE',
      activityReason: v.reason,
      updatedAt: (s.lease && s.lease.issuedAt) || null,
    });
  }
  return { ok: true, tasks, unreadable, unknown };
}

// Resolve the exact recovery target. Explicit {repo, issueNumber} binds the
// EXACT canonical identity (mismatch/unfound fails closed downstream in
// getTask/resolveSession). Discovery (no args) attaches ONLY to a SINGLE active
// task; anything ambiguous fails closed — recovery never guesses a task.
// No-arg discovery also refuses when canonical evidence is UNKNOWN/unprovable
// (disc.unknown > 0): such sessions are neither provably-active NOR terminal,
// so recovery must not guess. Explicit binds may still report UNKNOWN truthfully.
export function resolveRecoveryTarget({ stateDir, repo, issueNumber, isAlive, readStartTime } = {}) {
  const hasRepo = typeof repo === 'string' && repo.trim() !== '';
  const hasIssue = Number.isInteger(issueNumber) && issueNumber > 0;
  if (hasRepo || hasIssue) {
    if (!hasRepo || !hasIssue) {
      return { ok: false, reason: 'RECOVERY_IDENTITY_INCOMPLETE', detail: 'explicit recovery must present BOTH repo and issueNumber; omit both to attach to the single active canonical task.' };
    }
    return { ok: true, exact: true, repo, issueNumber };
  }
  const disc = enumerateActiveTasks({ stateDir, isAlive, readStartTime });
  if (disc.unknown > 0) {
    return { ok: false, reason: 'RECOVERY_ACTIVITY_UNKNOWN', detail: `${disc.unknown} canonical task(s) with UNKNOWN/unprovable recovery activity; refusing to guess. (${disc.tasks.length} provably-active.)`, unknown: disc.unknown, active: disc.tasks.length, unreadable: disc.unreadable };
  }
  if (disc.tasks.length === 0) {
    return { ok: false, reason: disc.unreadable > 0 ? 'RECOVERY_STATE_UNREADABLE' : 'NO_ACTIVE_TASK', detail: disc.unreadable > 0 ? `${disc.unreadable} canonical session record(s) failed fail-closed validation; refusing to guess.` : 'no active (non-terminal) task exists in canonical state.' };
  }
  if (disc.tasks.length > 1) {
    return { ok: false, reason: 'AMBIGUOUS_ACTIVE_TASKS', detail: 'multiple active tasks: recovery requires the exact {repo, issueNumber}; never auto-picks.', candidates: disc.tasks.map((t) => ({ repo: t.repo, issueNumber: t.issueNumber, state: t.state })) };
  }
  const t = disc.tasks[0];
  return { ok: true, exact: false, repo: t.repo, issueNumber: t.issueNumber, discovered: t };
}

// Canonical executor liveness -> TRANSPORT reporting vocabulary (phase 5). This
// is display mapping ONLY; the classification source stays reconcileExecutorLiveness
// (#160). A proven RUNNING stays RUNNING; unprovable identity stays UNKNOWN;
// terminal stays GONE. There is no synthetic RUNNING and no task mutation.
export function reportExecutionLiveness(execution) {
  if (!execution || typeof execution !== 'object') return null;
  const lv = execution.liveness ?? execution.status ?? null;
  if (lv == null) return null;
  if (lv === 'RUNNING' || lv === 'RUNNING_PROGRESSING') return execution.identityProven === true ? 'RUNNING' : 'UNKNOWN';
  if (lv === 'STARTING') return 'STARTING';
  if (lv === 'EXITED' || lv === 'FAILED' || lv === 'STOPPED' || lv === 'INTERRUPTED') return 'GONE';
  return 'UNKNOWN';
}
