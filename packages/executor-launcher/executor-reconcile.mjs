// executor-reconcile.mjs - Issue #160: MCP runtime disconnect recovery +
// executor reconciliation. Pure, injectable classification. A dropped MCP
// transport (stdio EOF / socket loss) is NOT executor death, and a live pid is
// NOT proof of the same executor incarnation (Windows recycles pids). These
// primitives decide liveness from PID + immutable Win32 PROCESS_START_TIME and
// reconcile canonical ownership BEFORE any mutation may resume after a
// reconnect. They never kill a process and never mint a second mutation owner.
import { readWin32ProcessStartTime } from './executor-launcher.mjs';

export const EXECUTOR_LIVENESS = Object.freeze([
  'STARTING', 'RUNNING', 'EXITED', 'FAILED', 'STOPPED', 'INTERRUPTED',
  'PID_REUSED', 'STALE_CHILD', 'OWNERSHIP_UNKNOWN',
]);
export const EXECUTOR_CLASSIFICATIONS = Object.freeze([
  'STARTING', 'RUNNING', 'RUNNING_PROGRESSING', 'EXITED', 'FAILED', 'STOPPED',
  'INTERRUPTED', 'PID_REUSED', 'STALE_CHILD', 'ORPHANED_TASK_PROCESS',
  'OWNERSHIP_UNKNOWN', 'TERMINAL_CLEANUP_REQUIRED', 'MCP_DISCONNECTED',
]);

function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Strict process-identity liveness. Never claims RUNNING without proven identity:
// a live pid whose recorded processStartTime cannot be confirmed (absent, or
// probe unavailable) is OWNERSHIP_UNKNOWN; a live pid whose processStartTime
// differs is PID_REUSED. A gone pid is EXITED (INTERRUPTED when finalized).
export function reconcileExecutorLiveness(record, { isAlive = defaultIsAlive, readStartTime = readWin32ProcessStartTime } = {}) {
  if (!record || typeof record !== 'object') return { liveness: null, identityProven: false, reason: 'NO_RECORD' };
  if (record.terminalStatus) return { liveness: record.terminalStatus, identityProven: true, reason: 'TERMINAL' };
  if (record.pid == null) return { liveness: 'STARTING', identityProven: false, reason: 'NO_PID' };
  if (!isAlive(record.pid)) {
    return { liveness: record.finalized === true ? 'INTERRUPTED' : 'EXITED', identityProven: true, reason: 'PID_GONE' };
  }
  if (record.processStartTime == null) {
    return { liveness: 'OWNERSHIP_UNKNOWN', identityProven: false, reason: 'NO_RECORDED_START_TIME' };
  }
  const probe = readStartTime(record.pid);
  if (!probe || probe.processStartTime == null) {
    return { liveness: 'OWNERSHIP_UNKNOWN', identityProven: false, reason: 'START_TIME_PROBE_UNAVAILABLE' };
  }
  if (probe.processStartTime !== record.processStartTime) {
    return { liveness: 'PID_REUSED', identityProven: false, reason: 'START_TIME_MISMATCH' };
  }
  return { liveness: 'RUNNING', identityProven: true, reason: 'IDENTITY_MATCH' };
}

// Combine process liveness with canonical ownership validity. sessionValid /
// bindingValid come from the caller's verifySessionAuthority / verifyBinding
// results (never from the executor). A proven-alive executor whose canonical
// session or broker binding is no longer valid is an ORPHANED_TASK_PROCESS:
// flagged and blocked from mutation, never auto-killed (policy owns that).
export function classifyExecutor({ record = null, liveness = null, sessionValid = true, bindingValid = true, progressSignal = false } = {}) {
  const lv = liveness || reconcileExecutorLiveness(record).liveness;
  if (lv === 'EXITED' || lv === 'FAILED' || lv === 'STOPPED' || lv === 'INTERRUPTED') {
    return { classification: lv, canMutate: false, orphan: false };
  }
  if (lv === 'PID_REUSED' || lv === 'STALE_CHILD') {
    return { classification: 'PID_REUSED', canMutate: false, orphan: true };
  }
  if (lv === 'OWNERSHIP_UNKNOWN') return { classification: 'OWNERSHIP_UNKNOWN', canMutate: false, orphan: false };
  if (lv === 'STARTING') return { classification: 'STARTING', canMutate: false, orphan: false };
  if (lv === 'RUNNING') {
    if (sessionValid !== true || bindingValid !== true) {
      return { classification: 'ORPHANED_TASK_PROCESS', canMutate: false, orphan: true };
    }
    return { classification: progressSignal ? 'RUNNING_PROGRESSING' : 'RUNNING', canMutate: true, orphan: false };
  }
  return { classification: 'OWNERSHIP_UNKNOWN', canMutate: false, orphan: false };
}

// The reconnect gate. After an MCP transport reconnect, a mutation may resume
// ONLY when: the executor process identity is proven RUNNING, the canonical
// session and broker binding are valid, and the presenting lane is the single
// recorded mutation owner. Any unknown/stale/orphan/mismatch fails closed and
// never mints a second owner.
export function reconcileReconnect({ record = null, sessionValid = false, bindingValid = false, ownerMatches = false, progressSignal = false, isAlive, readStartTime } = {}) {
  const deps = {};
  if (typeof isAlive === 'function') deps.isAlive = isAlive;
  if (typeof readStartTime === 'function') deps.readStartTime = readStartTime;
  const live = reconcileExecutorLiveness(record, deps);
  const cls = classifyExecutor({ record, liveness: live.liveness, sessionValid, bindingValid, progressSignal });
  const canResumeMutation = cls.canMutate === true && ownerMatches === true;
  let reason = 'RECONCILED';
  if (!canResumeMutation) {
    if (cls.classification === 'ORPHANED_TASK_PROCESS') reason = 'ORPHANED_TASK_PROCESS';
    else if (cls.classification === 'PID_REUSED') reason = 'PID_REUSED';
    else if (cls.classification === 'OWNERSHIP_UNKNOWN') reason = live.reason || 'OWNERSHIP_UNKNOWN';
    else if (!ownerMatches) reason = 'OWNER_MISMATCH';
    else reason = cls.classification;
  }
  return {
    ok: canResumeMutation, canResumeMutation,
    classification: cls.classification, liveness: live.liveness,
    identityProven: live.identityProven, orphan: cls.orphan === true, reason,
  };
}

// Bind an ExecutionRecord to the CURRENT session/attempt and prove the full
// canonical chain (task/session/execution/owner/process identity) before a
// mutation may run. Pure + injectable so the production mcp-server gate and the
// tests share ONE decision. NEVER fail-opens on a missing record: an executor
// mutation with no canonical ExecutionRecord, or a record from a different
// attempt/session, is denied. A control-plane/adopt exemption is NOT inferred
// from record absence here — it must be an explicit, separately-proven context
// (the MCP mutation surface has no such context; it is always executor-driven).
// ---- Issue #160 REWORK r4: durable bind/cleanup latch -------------------------
// While a child has been spawned but the executor context is not yet strictly
// bound (or a bind-failure left the child unproven-gone), the ExecutionRecord
// carries a LATCH: pendingExecutorBind or cleanupRequired. From spawn until
// (a) strict bind success or (b) the exact child proven gone, NO mutation path
// may authorize - INCLUDING an explicit control-plane session (BLOCKER-3). The
// latch is the durable primary defense; a later best-effort terminal-record
// write is not the only thing standing between a live child and a mutation.
// Strict latch-clear commit predicate: the executor mutation latch may be
// considered cleared ONLY when the read-back ExecutionRecord shows
// pendingExecutorBind===false AND cleanupRequired!==true AND the canonical
// identity (pid + processStartTime) still equals the captured launch identity.
// Any other read-back (missing record, still-true latch, identity drift, or a
// null startTime when capture failed - matched only if the record also holds
// null) is NOT a committed clear.
export function evaluateLatchClear(readback, { pid, startTime } = {}) {
  if (!readback || typeof readback !== 'object') return { ok: false, reason: 'LATCH_READBACK_MISSING' };
  if (readback.pendingExecutorBind !== false) return { ok: false, reason: 'LATCH_STILL_SET', pendingExecutorBind: readback.pendingExecutorBind };
  if (readback.cleanupRequired === true) return { ok: false, reason: 'CLEANUP_REQUIRED_SET' };
  if (readback.pid !== pid) return { ok: false, reason: 'IDENTITY_PID_DRIFT', got: readback.pid, want: pid };
  if (readback.processStartTime !== startTime) return { ok: false, reason: 'IDENTITY_STARTTIME_DRIFT', got: readback.processStartTime, want: startTime };
  return { ok: true };
}

export function pendingExecutorLatch(record) {
  return !!(record && (record.pendingExecutorBind === true || record.cleanupRequired === true));
}

// Prove whether a PRIOR executor incarnation is gone so a relaunch is safe.
// Does NOT kill (that is #157/#167 reaper scope); only proves. A missing/
// unprovable identity is treated as NOT gone (fail-closed relaunch).
export function priorIncarnationProvenGone({ pid, processStartTime, isAlive, readStartTime } = {}) {
  const alive = typeof isAlive === 'function' ? isAlive : () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const read = typeof readStartTime === 'function' ? readStartTime : null;
  if (!Number.isInteger(pid) || pid <= 0) return { provenGone: true, reason: 'NO_PRIOR_PID' };
  if (!alive(pid)) return { provenGone: true, reason: 'PRIOR_PID_DEAD' };
  if (processStartTime == null || !read) return { provenGone: false, reason: 'PRIOR_IDENTITY_UNPROVEN' };
  const p = read(pid);
  if (!p || p.processStartTime == null) return { provenGone: false, reason: 'PRIOR_PROBE_UNAVAILABLE' };
  if (p.processStartTime !== processStartTime) return { provenGone: true, reason: 'PRIOR_PID_REUSED', foreign: true };
  return { provenGone: false, reason: 'PRIOR_CHILD_ALIVE' };
}

export function executorMutationDecision({ record = null, session, ownerMatches = false, isAlive, readStartTime } = {}) {
  if (!session || typeof session !== 'object') return { ok: false, reason: 'SESSION_REQUIRED' };
  if (!record) return { ok: false, reason: 'NO_EXECUTION_RECORD', detail: 'executor mutation requires a canonical ExecutionRecord; absence is fail-closed, never inferred as control-plane' };
  const mism = [];
  if (String(record.taskId || '') !== String(session.taskId || '')) mism.push('taskId');
  if (String(record.repo || '').toLowerCase() !== String(session.repo || '').toLowerCase()) mism.push('repo');
  if (Number(record.issueNumber) !== Number(session.issueNumber)) mism.push('issueNumber');
  if (String(record.worktreePath || '') !== String(session.worktreePath || '')) mism.push('worktreePath');
  if (record.identityHash && session.identityHash && record.identityHash !== session.identityHash) mism.push('identityHash');
  if (mism.length) return { ok: false, reason: 'EXECUTION_RECORD_IDENTITY_MISMATCH', fields: mism, detail: 'record is not the current session/attempt execution; a prior attempt or foreign identity cannot authorize mutation' };
  if (pendingExecutorLatch(record)) return { ok: false, reason: 'EXECUTOR_RECONCILIATION_REQUIRED', detail: 'PENDING_BIND_OR_CLEANUP' };
  const deps = {};
  if (typeof isAlive === 'function') deps.isAlive = isAlive;
  if (typeof readStartTime === 'function') deps.readStartTime = readStartTime;
  const rr = reconcileReconnect({ record, sessionValid: true, bindingValid: true, ownerMatches, ...deps });
  if (!rr.ok) return { ok: false, reason: 'EXECUTOR_RECONCILIATION_REQUIRED', classification: rr.classification, detail: rr.reason };
  return { ok: true, classification: rr.classification, executionId: record.instructionDigest ? String(record.instructionDigest).slice(0, 12) : null };
}

// ---- Issue #160 REWORK F2: canonical execution context -----------------------
// The mutation authority path depends on HOW the task is running, decided from
// a CONTROL-PLANE-OWNED field on the authoritative session — NEVER inferred
// from request/env and NEVER from the mere presence/absence of an
// ExecutionRecord. `startExecution` (executor-launcher) is the sole writer that
// promotes a session to 'executor'; a session that was never launched by
// startExecution is 'control-plane' (the default for adopt/ControlLoop
// lifecycle commits). Malformed/unknown context fails closed.
export const EXECUTION_CONTEXTS = Object.freeze(['executor', 'control-plane', 'ambiguous', 'invalid']);

// F1 (REWORK round-2): a missing/empty executionMode is NOT defaulted to
// control-plane. A session predating the field could still be a live executor,
// so it resolves to 'ambiguous' and is disambiguated only by canonical
// execution-lifecycle evidence (the ExecutionRecord), never by assuming
// control-plane. An out-of-vocabulary value is 'invalid' (fail closed).
export function resolveExecutionContext(session) {
  if (!session || typeof session !== 'object') return { ok: false, reason: 'SESSION_REQUIRED' };
  const m = session.executionMode;
  if (m === undefined || m === null || m === '') return { ok: true, context: 'ambiguous' };
  if (m === 'executor' || m === 'control-plane') return { ok: true, context: m };
  return { ok: false, context: 'invalid', reason: 'EXECUTION_CONTEXT_MALFORMED', detail: String(m).slice(0, 24) };
}

// F3 (REWORK round-2): NO caller-supplied executionContext override. The
// context is ALWAYS resolved from the authoritative session argument. Unit
// tests drive scenarios by setting session.executionMode / passing a record,
// never by injecting a bypass flag into the mutation-authority API.
export function reconcileMutationGate({
  session, record = null, ownerMatches = false, capabilityGranted = true, requiredCapability = null,
  isAlive, readStartTime,
} = {}) {
  const ctx = resolveExecutionContext(session);
  if (!ctx.ok) return { ok: false, reason: ctx.reason, detail: ctx.detail ?? null };
  if (record && pendingExecutorLatch(record)) return { ok: false, reason: 'EXECUTOR_RECONCILIATION_REQUIRED', detail: 'PENDING_BIND_OR_CLEANUP', executionContext: ctx.context };
  if (ctx.context === 'invalid') return { ok: false, reason: 'EXECUTION_CONTEXT_MALFORMED', detail: ctx.detail ?? null };
  if (ctx.context === 'executor') {
    // explicit executor: reconcile a same-attempt ExecutionRecord + proven
    // identity. A missing record is DENIED (never falls back to control-plane).
    const d = executorMutationDecision({ record, session, ownerMatches, isAlive, readStartTime });
    return { ...d, executionContext: 'executor' };
  }
  if (ctx.context === 'ambiguous') {
    // Disambiguate by canonical execution-lifecycle evidence. If an
    // ExecutionRecord exists for this identity, treat as executor and reconcile
    // (deny on reused/stale/unproven identity). If NO executor lifecycle
    // evidence exists at all, executor-absence is proven -> legacy genuine
    // control-plane authority path.
    if (record) {
      const d = executorMutationDecision({ record, session, ownerMatches, isAlive, readStartTime });
      return { ...d, executionContext: 'ambiguous-reconciled' };
    }
    return controlPlaneAuthority({ session, capabilityGranted, ownerMatches, requiredCapability });
  }
  // explicit control-plane: the pre-#160 authority path, no ExecutionRecord.
  return controlPlaneAuthority({ session, capabilityGranted, ownerMatches, requiredCapability });
}

function controlPlaneAuthority({ session, capabilityGranted, ownerMatches, requiredCapability }) {
  if (!session || typeof session !== 'object') return { ok: false, reason: 'SESSION_REQUIRED' };
  if (!capabilityGranted) return { ok: false, reason: 'CAPABILITY_NOT_GRANTED', capability: requiredCapability };
  if (!ownerMatches) return { ok: false, reason: 'MUTATION_OWNER_CONFLICT' };
  return { ok: true, executionContext: 'control-plane' };
}

// ---- Mechanical Circuit Breaker & Overthinking Breaker: pure budget policy ----
// Deterministic, side-effect free. Decides CONTINUE vs TRIP from observed
// evidence against bounded limits. Never kills, never probes processes.
// breakerReason is preserved separately from Issue #192 executionOutcome:
//   NO_MUTATION -> PROCESS_HUNG
//   EXECUTION_BUDGET_EXCEEDED -> UNKNOWN
// Missing/invalid evidence fails closed (CONTINUE, never TRIP).
// PROCESS_HUNG is never inferred from PID or elapsed time alone: it requires
// proven identity/aliveness plus an exceeded no-mutation interval with no
// qualifying worktree mutation/progress.
export const EXECUTION_BUDGET_DEFAULTS = Object.freeze({
  hardTimeMs: 600000,
  maxSteps: 10,
  noMutationMs: 600000,
});
export const BREAKER_ACTIONS = Object.freeze(['CONTINUE', 'TRIP']);
export const BREAKER_REASONS = Object.freeze(['NO_MUTATION', 'EXECUTION_BUDGET_EXCEEDED']);
export const BREAKER_OUTCOMES = Object.freeze(['PROCESS_HUNG', 'UNKNOWN']);
function toPositiveFinite(v, d) {
  return Number.isFinite(v) && v > 0 ? v : d;
}
export function evaluateExecutionBudget(evidence = {}, limits = {}) {
  const hardTimeMs = toPositiveFinite(limits && limits.hardTimeMs, EXECUTION_BUDGET_DEFAULTS.hardTimeMs);
  const maxSteps = toPositiveFinite(limits && limits.maxSteps, EXECUTION_BUDGET_DEFAULTS.maxSteps);
  const noMutationMs = toPositiveFinite(limits && limits.noMutationMs, EXECUTION_BUDGET_DEFAULTS.noMutationMs);
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { action: 'CONTINUE', breakerReason: null, executionOutcome: null, reason: 'INVALID_EVIDENCE', hardTimeMs, maxSteps, noMutationMs };
  }
  const elapsedMs = Number.isFinite(evidence.elapsedMs) && evidence.elapsedMs >= 0 ? evidence.elapsedMs : null;
  const stepCount = Number.isFinite(evidence.stepCount) && evidence.stepCount >= 0 ? Math.floor(evidence.stepCount) : null;
  const msSinceLastMutation = Number.isFinite(evidence.msSinceLastMutation) && evidence.msSinceLastMutation >= 0
    ? evidence.msSinceLastMutation
    : (Number.isFinite(evidence.timeSinceLastMutationMs) && evidence.timeSinceLastMutationMs >= 0 ? evidence.timeSinceLastMutationMs : null);
  const hasMutation = evidence.hasMutation === true;
  const identityProven = evidence.identityProven === true;
  const base = { hardTimeMs, maxSteps, noMutationMs, elapsedMs, stepCount, msSinceLastMutation, hasMutation, identityProven };
  if (identityProven === true && msSinceLastMutation !== null && msSinceLastMutation >= noMutationMs) {
    return { ...base, action: 'TRIP', breakerReason: 'NO_MUTATION', executionOutcome: 'PROCESS_HUNG', reason: 'NO_MUTATION_BEYOND_THRESHOLD' };
  }
  if (elapsedMs !== null && elapsedMs >= hardTimeMs) {
    return { ...base, action: 'TRIP', breakerReason: 'EXECUTION_BUDGET_EXCEEDED', executionOutcome: 'UNKNOWN', reason: 'HARD_TIME_EXCEEDED' };
  }
  if (stepCount !== null && stepCount >= maxSteps) {
    return { ...base, action: 'TRIP', breakerReason: 'EXECUTION_BUDGET_EXCEEDED', executionOutcome: 'UNKNOWN', reason: 'STEP_LIMIT_REACHED' };
  }
  return { ...base, action: 'CONTINUE', breakerReason: null, executionOutcome: null, reason: 'WITHIN_BUDGET' };
}

// F2 (REWORK round-2): bounded terminate-and-prove cleanup for the
// execution-context bind-failure path. Terminates ONLY the exact child identity
// it captured (PID + immutable Win32 processStartTime); if the pid has been
// reused by a foreign process it refuses to touch it. Never name-based, never a
// second reaper (does not reap unrelated dead executions - only reconciles the
// one child this launch created). Returns provenGone plus a cleanupRequired flag
// the caller uses to fail closed (session must NOT fall back to a usable
// control-plane while a live executor may exist).
export function terminateAndProveCleanup({ pid, startTime, isAlive, readStartTime, kill, sleep, deadlineMs = 10000, pollMs = 100 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { provenGone: true, action: 'NO_PID', cleanupRequired: false };
  const alive = () => isAlive(pid);
  const current = () => { const p = readStartTime(pid); return p && p.processStartTime != null ? p.processStartTime : null; };
  if (!alive()) return { provenGone: true, action: 'ALREADY_GONE', cleanupRequired: false };
  // Alive. We may ONLY terminate the pid we can positively prove is OUR captured
  // child (startExecution captured startTime right after spawn). Never kill on an
  // unproven identity: a missing startTime (capture failed) or a failed live probe
  // means we cannot distinguish our child from a recycled/foreign pid -> do not
  // kill; fail closed cleanupRequired for #157/#167 to reconcile later.
  if (startTime == null) return { provenGone: false, action: 'IDENTITY_UNPROVEN_NO_START_TIME', cleanupRequired: true, foreign: false };
  const now = current();
  if (now === null) return { provenGone: false, action: 'IDENTITY_UNPROVEN_PROBE_FAILED', cleanupRequired: true, foreign: false };
  if (now !== startTime) return { provenGone: true, action: 'PID_REUSED_SKIP', cleanupRequired: false, foreign: true };
  try { kill(pid); } catch { /* prove loop below */ }
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (!alive()) return { provenGone: true, action: 'TERMINATED', cleanupRequired: false };
    const n = current();
    if (n !== null && n !== startTime) return { provenGone: true, action: 'TERMINATED_REUSED', cleanupRequired: false, foreign: true };
    sleep(pollMs);
  }
  return { provenGone: false, action: 'STILL_ALIVE', cleanupRequired: true };
}
