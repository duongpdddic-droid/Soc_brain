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
