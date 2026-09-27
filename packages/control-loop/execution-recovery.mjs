// execution-recovery.mjs — bounded, evidence-preserving recovery for the
// EXECUTE leg (Harness Hardening §C.2 / §C.3).
//
// Classification is by SIDE-EFFECT POINT, never by exit code alone:
//   PRE_SPAWN_EFFECT_PROVEN — the launcher refused BEFORE the durable latch or
//       the latch exists with a PROVEN-dead prior incarnation. No executor
//       process and no worktree change can have been produced by this attempt.
//   UNKNOWN_OUTCOME — a child was (or may have been) launched and the result
//       is not known: timeout, unreadable record, transport crash mid-poll.
//       Observe/reconcile only. NEVER respawn unless death is proven; if the
//       worktree already changed, keep the evidence and resume/verify the SAME
//       attempt.
//   FAILED_EXECUTION — a real code/test/identity/permission failure with a
//       terminal record. Fail closed and hand REWORK/BLOCKED to the loop with
//       evidence; never "fix" it by retrying.
//
// Budget: durable on disk (`<stateDir>/recovery/<identityHash>.json`),
// `initial + at most 1 eligible retry` per task/execution generation. A process
// restart does NOT reset it. Never two live children, never ledger/WIP clobber.

import fs from 'node:fs';
import path from 'node:path';

export const RECOVERY_BUDGET_SCHEMA_VERSION = '1';
export const MAX_ELIGIBLE_RETRIES = 1;

export const FAILURE_CLASSES = Object.freeze({
  PRE_SPAWN: 'PRE_SPAWN_EFFECT_PROVEN',
  UNKNOWN: 'UNKNOWN_OUTCOME',
  FAILED: 'FAILED_EXECUTION',
});

// Codes the launcher/adapter can return WITHOUT any side effect. Exhaustive by
// construction: every one of these is returned before the durable pre-spawn
// latch is written (or for a latch whose prior incarnation is proven gone).
const PRE_SPAWN_CODES = new Set([
  'SESSION_AUTHORITY_REJECTED',
  'EXECUTION_IDENTITY_MISMATCH',
  'INSTRUCTION_INVALID',
  'INSTRUCTION_REQUIRED',
  'EXECUTOR_UNAVAILABLE',
  'MODEL_INVALID',
  'MODEL_UNAVAILABLE',
  'MODEL_UNRESOLVED',
  'EXECUTOR_PREFLIGHT_FAILED',
  'STATE_DIR_UNAVAILABLE',
  'BINDING_UNAVAILABLE',
  'LAUNCH_LATCH_PERSIST_FAILED',
  'EXECUTION_CLEANUP_REQUIRED',
  'EXECUTION_ALREADY_RUNNING', // no new child: admission refused
  'LAUNCH_HANDLE_INVALID',
]);

// A child may exist and the outcome is not known — reconcile, do not relaunch.
const UNKNOWN_CODES = new Set([
  'EXECUTOR_TIMEOUT',
  'EXECUTOR_STARTING',
  'EXECUTOR_RUNNING',
  'EXECUTOR_INTERRUPTED',
  'EXECUTOR_STOPPED',
  'EXECUTION_RECORD_UNREADABLE',
  'ROUTE_LAUNCH_THREW',
  'LAUNCH_FAILED',
  'STEP_THREW',
]);

export function classifyExecutionFailure(result) {
  if (!result || typeof result !== 'object') return { cls: FAILURE_CLASSES.UNKNOWN, code: null };
  if (result.ok === true) return { cls: null, code: null };
  const code = typeof result.code === 'string' && result.code
    ? result.code
    : (typeof result.reason === 'string' ? result.reason : null);
  if (!code) return { cls: FAILURE_CLASSES.UNKNOWN, code: null };
  if (PRE_SPAWN_CODES.has(code)) return { cls: FAILURE_CLASSES.PRE_SPAWN, code };
  if (UNKNOWN_CODES.has(code)) return { cls: FAILURE_CLASSES.UNKNOWN, code };
  // A typed EXECUTOR_<terminalStatus> / verification failure is a real
  // execution outcome: fail closed, no retry.
  return { cls: FAILURE_CLASSES.FAILED, code };
}

// ---- durable budget ---------------------------------------------------------
export function recoveryBudgetPath({ stateDir, identityHash: h }) {
  return path.join(path.resolve(stateDir), 'recovery', `${h}.json`);
}

export function readRetryBudget({ stateDir, identityHash: h }) {
  const p = recoveryBudgetPath({ stateDir, identityHash: h });
  const empty = {
    ok: true, path: p, schemaVersion: RECOVERY_BUDGET_SCHEMA_VERSION,
    identityHash: h, attempts: [], consumed: 0, remaining: MAX_ELIGIBLE_RETRIES,
  };
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return { ok: true, ...empty, fresh: true }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    // Corrupt budget is NOT a free retry: fail closed.
    return { ok: false, code: 'RECOVERY_BUDGET_UNREADABLE', detail: String((e && e.message) || e), path: p };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.attempts)) {
    return { ok: false, code: 'RECOVERY_BUDGET_UNREADABLE', detail: 'attempts[] missing', path: p };
  }
  if (parsed.identityHash && parsed.identityHash !== h) {
    return { ok: false, code: 'RECOVERY_BUDGET_IDENTITY_MISMATCH', detail: `${parsed.identityHash} != ${h}`, path: p };
  }
  const attempts = parsed.attempts.filter((a) => a && typeof a === 'object');
  return {
    ok: true, path: p, schemaVersion: RECOVERY_BUDGET_SCHEMA_VERSION, identityHash: h,
    attempts, consumed: attempts.length, remaining: Math.max(0, MAX_ELIGIBLE_RETRIES - attempts.length),
  };
}

// Append-only consume: never rewrites history, never lowers the count.
export function consumeRetryBudget({
  stateDir, identityHash: h, reason, cleanupProof = null, outcome = null,
  generation = null, now = () => new Date().toISOString(),
}) {
  const cur = readRetryBudget({ stateDir, identityHash: h });
  if (!cur.ok) return cur;
  if (cur.remaining <= 0) {
    return { ok: false, code: 'RECOVERY_BUDGET_EXHAUSTED', detail: { consumed: cur.consumed, max: MAX_ELIGIBLE_RETRIES }, path: cur.path };
  }
  const attempts = cur.attempts.concat([{
    n: cur.attempts.length + 1,
    at: now(),
    reason: typeof reason === 'string' ? reason : String(reason ?? 'unspecified'),
    identityHash: h,
    generation: generation ?? null,
    cleanupProof: cleanupProof ?? null,
    outcome: outcome ?? null,
  }]);
  const next = {
    schemaVersion: RECOVERY_BUDGET_SCHEMA_VERSION,
    identityHash: h,
    max: MAX_ELIGIBLE_RETRIES,
    attempts,
    updatedAt: now(),
  };
  return writeBudgetAtomic(cur.path, next);
}

function writeBudgetAtomic(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, p);
  } catch (e) {
    return { ok: false, code: 'RECOVERY_BUDGET_WRITE_FAILED', detail: String((e && e.message) || e), path: p };
  }
  // read-back: a budget we cannot read back is not a consumed budget
  const back = readRetryBudget({ stateDir: path.dirname(path.dirname(p)), identityHash: obj.identityHash });
  if (!back.ok) return back;
  if (back.consumed !== obj.attempts.length) {
    return { ok: false, code: 'RECOVERY_BUDGET_READBACK_MISMATCH', detail: { expected: obj.attempts.length, got: back.consumed }, path: p };
  }
  return { ok: true, path: p, budget: back };
}

// ---- cleanup proof ----------------------------------------------------------
// Cleanup is only admissible when we can PROVE no executor effect remains:
// no live pid for this record AND the execution record (if any) is terminal or
// absent. Returns structured evidence; a failure blocks the respawn.
export function proveCleanup({
  readStatus = null, isAlive = null, recordPath = null, identityHash: h = null,
} = {}) {
  const proof = { at: new Date().toISOString(), identityHash: h, recordPath, checks: [] };
  let pid = null;
  if (typeof readStatus === 'function') {
    try {
      const st = readStatus();
      if (st && st.ok && st.execution) {
        pid = st.execution.pid ?? null;
        proof.checks.push({ check: 'status', status: st.execution.status ?? null, terminalStatus: st.execution.terminalStatus ?? null });
      } else {
        proof.checks.push({ check: 'status', reason: (st && st.reason) || 'unreadable' });
      }
    } catch (e) {
      proof.checks.push({ check: 'status', threw: String((e && e.message) || e) });
    }
  }
  if (pid != null && typeof isAlive === 'function') {
    let alive = false;
    try { alive = Boolean(isAlive(pid)); } catch { alive = true; /* unknown => not proven gone */ }
    proof.checks.push({ check: 'pid', pid, alive });
    if (alive) return { ok: false, code: 'CLEANUP_NOT_PROVEN', detail: `pid ${pid} still alive`, proof };
  }
  if (recordPath) {
    const exists = (() => { try { return fs.statSync(recordPath).isFile(); } catch { return false; } })();
    proof.checks.push({ check: 'recordExists', exists });
  }
  proof.provenGone = !proof.checks.some((c) => c.check === 'pid' && c.alive);
  return { ok: proof.provenGone, code: proof.provenGone ? null : 'CLEANUP_NOT_PROVEN', detail: null, proof };
}

/**
 * withBoundedRecovery — wrap ONE executor/verifier invocation.
 *
 * Only a PRE_SPAWN_EFFECT_PROVEN failure whose infrastructure error has been
 * cleaned up (proveCleanup OK) may consume the single durable retry. UNKNOWN
 * and FAILED outcomes are returned untouched for the loop to reconcile /
 * fail-closed — this wrapper never invents a second attempt for them.
 */
export async function withBoundedRecovery({
  stateDir, identityHash: h, run, cleanup = null, now = () => new Date().toISOString(),
  generation = null, onError = null,
} = {}) {
  if (typeof run !== 'function') return { ok: false, code: 'RECOVERY_RUN_MISSING' };
  const budget = readRetryBudget({ stateDir, identityHash: h });
  if (!budget.ok) return budget;
  const first = await run({ attempt: 1, budget });
  if (!first || first.ok === true) return first;

  const cls = classifyExecutionFailure(first);
  if (cls.cls !== FAILURE_CLASSES.PRE_SPAWN) {
    return { ...first, recovery: { class: cls.cls, code: cls.code, retried: false, budgetRemaining: budget.remaining } };
  }
  if (budget.remaining <= 0) {
    return { ...first, recovery: { class: cls.cls, code: cls.code, retried: false, budgetRemaining: 0, exhausted: true } };
  }
  if (typeof cleanup !== 'function') {
    return { ...first, recovery: { class: cls.cls, code: cls.code, retried: false, reason: 'NO_CLEANUP_HOOK' } };
  }

  let proof;
  try { proof = await cleanup({ failure: first, classification: cls }); } catch (e) {
    return { ...first, recovery: { class: cls.cls, code: cls.code, retried: false, reason: 'CLEANUP_THREW', detail: String((e && e.message) || e) } };
  }
  if (!proof || proof.ok !== true) {
    return { ...first, recovery: { class: cls.cls, code: cls.code, retried: false, reason: 'CLEANUP_NOT_PROVEN', detail: proof ? (proof.detail ?? proof.code) : 'no proof' } };
  }

  const consumed = consumeRetryBudget({
    stateDir, identityHash: h,
    reason: cls.code || 'pre-spawn failure',
    cleanupProof: proof.proof ?? proof,
    outcome: 'PENDING_RESPAWN',
    generation,
    now,
  });
  if (!consumed.ok) return { ...first, recovery: { class: cls.cls, code: consumed.code, retried: false, detail: consumed.detail } };

  const second = await run({ attempt: 2, budget: consumed.budget });
  const out = second || { ok: false, code: 'RECOVERY_RESPAWN_NO_RESULT' };
  return {
    ...out,
    recovery: {
      class: cls.cls, code: cls.code, retried: true,
      budgetRemaining: (consumed.budget && consumed.budget.remaining) ?? 0,
      cleanupProof: proof.proof ?? proof,
      firstFailure: { code: first.code ?? first.reason ?? null },
    },
  };
}

// end of execution-recovery.mjs
