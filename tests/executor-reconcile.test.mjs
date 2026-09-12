// tests/executor-reconcile.test.mjs - Issue #160: MCP runtime disconnect
// recovery + executor reconciliation. Pure, injected isAlive/readStartTime.
// No real Win32 probe, no process kill. node:test.
import { test } from 'node:test';
import assert from 'node:assert';
import { reconcileExecutorLiveness, classifyExecutor, reconcileReconnect, EXECUTOR_CLASSIFICATIONS } from '../packages/executor-launcher/executor-reconcile.mjs';
import { effectiveStatus } from '../packages/executor-launcher/executor-launcher.mjs';

const alive = (pid) => ({ ok: true, isAlive: () => true, readStartTime: () => ({ pid, processStartTime: 1000 }) });
const PST = 1000;

test('R1 disconnect mid-execution, executor still alive => RUNNING, transport loss != death', () => {
  const rec = { pid: 4242, processStartTime: PST, terminalStatus: null, finalized: false };
  const l = reconcileExecutorLiveness(rec, { isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: PST }) });
  assert.equal(l.liveness, 'RUNNING');
  assert.equal(l.identityProven, true);
  // A transport EOF/disconnect event never maps to EXITED by itself: liveness is
  // decided only from pid+startTime, independent of the socket.
  const cls = classifyExecutor({ liveness: l.liveness, sessionValid: true, bindingValid: true });
  assert.equal(cls.classification, 'RUNNING');
  assert.equal(cls.canMutate, true);
});

test('R2 reconnect + same execution resumes ONLY after reconciliation', () => {
  const rec = { pid: 4242, processStartTime: PST, terminalStatus: null };
  const deps = { isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: PST }) };
  // before owner reconciliation (ownerMatches false): must NOT resume
  const pre = reconcileReconnect({ record: rec, sessionValid: true, bindingValid: true, ownerMatches: false, ...deps });
  assert.equal(pre.ok, false);
  assert.equal(pre.reason, 'OWNER_MISMATCH');
  // after full reconciliation: resume
  const post = reconcileReconnect({ record: rec, sessionValid: true, bindingValid: true, ownerMatches: true, ...deps });
  assert.equal(post.ok, true);
  assert.equal(post.classification, 'RUNNING');
});

test('R3 reconnect but session stale => fail-closed (orphan), no mutation', () => {
  const rec = { pid: 4242, processStartTime: PST, terminalStatus: null };
  const r = reconcileReconnect({ record: rec, sessionValid: false, bindingValid: true, ownerMatches: true, isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: PST }) });
  assert.equal(r.ok, false);
  assert.equal(r.classification, 'ORPHANED_TASK_PROCESS');
  assert.equal(r.orphan, true);
});

test('R4 PID reused (live pid, different startTime) => PID_REUSED, not RUNNING', () => {
  const rec = { pid: 999, processStartTime: PST, terminalStatus: null };
  const l = reconcileExecutorLiveness(rec, { isAlive: () => true, readStartTime: () => ({ pid: 999, processStartTime: 5555 }) });
  assert.equal(l.liveness, 'PID_REUSED');
  assert.equal(l.identityProven, false);
  const cls = classifyExecutor({ liveness: l.liveness });
  assert.equal(cls.classification, 'PID_REUSED');
  assert.equal(cls.canMutate, false);
});

test('R5 process alive + broker binding lost => ORPHANED_TASK_PROCESS', () => {
  const cls = classifyExecutor({ liveness: 'RUNNING', sessionValid: true, bindingValid: false });
  assert.equal(cls.classification, 'ORPHANED_TASK_PROCESS');
  assert.equal(cls.canMutate, false);
  assert.equal(cls.orphan, true);
});

test('R6 executor truly exited => EXITED; finalized-gone => INTERRUPTED', () => {
  assert.equal(reconcileExecutorLiveness({ terminalStatus: 'EXITED', pid: 1 }).liveness, 'EXITED');
  const gone = reconcileExecutorLiveness({ pid: 1, processStartTime: PST, finalized: true }, { isAlive: () => false, readStartTime: () => null });
  assert.equal(gone.liveness, 'INTERRUPTED');
  const goneNoFinal = reconcileExecutorLiveness({ pid: 1, processStartTime: PST, finalized: false }, { isAlive: () => false, readStartTime: () => null });
  assert.equal(goneNoFinal.liveness, 'EXITED');
});

test('R7 concurrent foreign lane => conflict (owner mismatch), no second owner', () => {
  const rec = { pid: 4242, processStartTime: PST, terminalStatus: null };
  const r = reconcileReconnect({ record: rec, sessionValid: true, bindingValid: true, ownerMatches: false, isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: PST }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'OWNER_MISMATCH');
  // reconcile NEVER reports a minted owner; it only gates on the presented one.
  assert.equal(Object.prototype.hasOwnProperty.call(r, 'mintedOwner'), false);
});

test('R8 legacy record missing processStartTime => OWNERSHIP_UNKNOWN (fail-closed)', () => {
  const l = reconcileExecutorLiveness({ pid: 4242, terminalStatus: null }, { isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: 1 }) });
  assert.equal(l.liveness, 'OWNERSHIP_UNKNOWN');
  assert.equal(l.identityProven, false);
  const r = reconcileReconnect({ record: { pid: 4242, terminalStatus: null }, sessionValid: true, bindingValid: true, ownerMatches: true, isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: 1 }) });
  assert.equal(r.ok, false);
});

test('R9 server restart + reconnect: same identity => RUNNING again', () => {
  const rec = { pid: 4242, processStartTime: PST, terminalStatus: null };
  const r = reconcileReconnect({ record: rec, sessionValid: true, bindingValid: true, ownerMatches: true, isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: PST }) });
  assert.equal(r.ok, true);
  assert.equal(r.classification, 'RUNNING');
});

test('R10 no duplicate mutation owner: gate requires ownerMatches, never self-mints', () => {
  const rec = { pid: 4242, processStartTime: PST, terminalStatus: null };
  const deps = { isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: PST }) };
  const denied = reconcileReconnect({ record: rec, sessionValid: true, bindingValid: true, ownerMatches: false, ...deps });
  const allowed = reconcileReconnect({ record: rec, sessionValid: true, bindingValid: true, ownerMatches: true, ...deps });
  assert.equal(denied.canResumeMutation, false);
  assert.equal(allowed.canResumeMutation, true);
});

test('R11 cross-task isolation: cannot borrow another process identity', () => {
  // record pins pid 111 startTime 1000; the live pid 111 now belongs to a
  // different incarnation (2000) => PID_REUSED, never RUNNING from another task.
  const l = reconcileExecutorLiveness({ pid: 111, processStartTime: 1000, terminalStatus: null }, { isAlive: () => true, readStartTime: () => ({ pid: 111, processStartTime: 2000 }) });
  assert.equal(l.liveness, 'PID_REUSED');
});

test('R12 effectiveStatus backward-compatible (existing contract preserved)', () => {
  assert.equal(effectiveStatus(null, () => true), null);
  assert.equal(effectiveStatus({ terminalStatus: 'EXITED' }, () => false), 'EXITED');
  assert.equal(effectiveStatus({ terminalStatus: null, pid: null }, () => false), 'STARTING');
  assert.equal(effectiveStatus({ terminalStatus: null, pid: 1 }, () => true), 'RUNNING');
  assert.equal(effectiveStatus({ terminalStatus: null, pid: 1 }, () => false), 'RUNNING');
  assert.equal(effectiveStatus({ terminalStatus: null, pid: 1, finalized: true }, () => false), 'INTERRUPTED');
  // additive: live pid + recorded startTime + probe mismatch => EXITED (Issue #160)
  assert.equal(effectiveStatus({ terminalStatus: null, pid: 1, processStartTime: 1000 }, () => true, () => ({ pid: 1, processStartTime: 2000 })), 'EXITED');
  // additive: live pid + recorded startTime + probe match => RUNNING
  assert.equal(effectiveStatus({ terminalStatus: null, pid: 1, processStartTime: 1000 }, () => true, () => ({ pid: 1, processStartTime: 1000 })), 'RUNNING');
});

test('R13 classification vocabulary is the documented set', () => {
  for (const k of ['RUNNING', 'EXITED', 'PID_REUSED', 'ORPHANED_TASK_PROCESS', 'OWNERSHIP_UNKNOWN', 'MCP_DISCONNECTED']) {
    assert.ok(EXECUTOR_CLASSIFICATIONS.includes(k), k);
  }
});
