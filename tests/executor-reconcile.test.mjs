// tests/executor-reconcile.test.mjs - Issue #160: MCP runtime disconnect
// recovery + executor reconciliation (REWORK F1/F2/F3). node:test, no framework.
// F3 uses the real Win32 processStartTime probe against an OWNED child.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { reconcileExecutorLiveness, classifyExecutor, reconcileReconnect, executorMutationDecision, reconcileMutationGate, terminateAndProveCleanup, resolveExecutionContext, pendingExecutorLatch, priorIncarnationProvenGone, EXECUTOR_CLASSIFICATIONS } from '../packages/executor-launcher/executor-reconcile.mjs';
import { effectiveStatus, readWin32ProcessStartTime, bindReadbackOk } from '../packages/executor-launcher/executor-launcher.mjs';

const PST = 1000;
const aliveRec = () => ({ pid: 4242, processStartTime: PST, terminalStatus: null, finalized: false });
const D_OK = { isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: PST }) };
const SESSION = { taskId: 'duongpdddic-droid/soc_brain#160', repo: 'duongpdddic-droid/soc_brain', issueNumber: 160, worktreePath: '/wt/160', identityHash: 'h160', mutationOwner: { laneId: 'lane-160' } };
const matchRec = (over = {}) => ({ taskId: SESSION.taskId, repo: SESSION.repo, issueNumber: 160, worktreePath: SESSION.worktreePath, identityHash: 'h160', pid: 4242, processStartTime: PST, terminalStatus: null, ...over });

test('R1 disconnect mid-execution, executor alive => RUNNING; transport loss != death', () => {
  const l = reconcileExecutorLiveness(aliveRec(), D_OK);
  assert.equal(l.liveness, 'RUNNING'); assert.equal(l.identityProven, true);
  assert.equal(classifyExecutor({ liveness: l.liveness, sessionValid: true, bindingValid: true }).classification, 'RUNNING');
});
test('R2 reconnect resumes ONLY after reconciliation', () => {
  const pre = reconcileReconnect({ record: aliveRec(), sessionValid: true, bindingValid: true, ownerMatches: false, ...D_OK });
  assert.equal(pre.ok, false); assert.equal(pre.reason, 'OWNER_MISMATCH');
  const post = reconcileReconnect({ record: aliveRec(), sessionValid: true, bindingValid: true, ownerMatches: true, ...D_OK });
  assert.equal(post.ok, true); assert.equal(post.classification, 'RUNNING');
});
test('R3 stale session => ORPHANED, no mutation', () => {
  const r = reconcileReconnect({ record: aliveRec(), sessionValid: false, bindingValid: true, ownerMatches: true, ...D_OK });
  assert.equal(r.ok, false); assert.equal(r.classification, 'ORPHANED_TASK_PROCESS'); assert.equal(r.orphan, true);
});
test('R4 PID reused (live pid, different startTime) => PID_REUSED', () => {
  const l = reconcileExecutorLiveness({ pid: 999, processStartTime: PST, terminalStatus: null }, { isAlive: () => true, readStartTime: () => ({ pid: 999, processStartTime: 5555 }) });
  assert.equal(l.liveness, 'PID_REUSED'); assert.equal(l.identityProven, false);
});
test('R5 process alive + binding lost => ORPHANED_TASK_PROCESS', () => {
  const c = classifyExecutor({ liveness: 'RUNNING', sessionValid: true, bindingValid: false });
  assert.equal(c.classification, 'ORPHANED_TASK_PROCESS'); assert.equal(c.canMutate, false);
});
test('R6 exited/interrupted classification', () => {
  assert.equal(reconcileExecutorLiveness({ terminalStatus: 'EXITED', pid: 1 }).liveness, 'EXITED');
  assert.equal(reconcileExecutorLiveness({ pid: 1, processStartTime: PST, finalized: true }, { isAlive: () => false }).liveness, 'INTERRUPTED');
  assert.equal(reconcileExecutorLiveness({ pid: 1, processStartTime: PST, finalized: false }, { isAlive: () => false }).liveness, 'EXITED');
});
test('R7 foreign owner => conflict, never self-mints', () => {
  const r = reconcileReconnect({ record: aliveRec(), sessionValid: true, bindingValid: true, ownerMatches: false, ...D_OK });
  assert.equal(r.ok, false); assert.equal(r.reason, 'OWNER_MISMATCH'); assert.equal('mintedOwner' in r, false);
});
test('R8 legacy record missing startTime => OWNERSHIP_UNKNOWN', () => {
  const l = reconcileExecutorLiveness({ pid: 4242, terminalStatus: null }, { isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: 1 }) });
  assert.equal(l.liveness, 'OWNERSHIP_UNKNOWN');
});
test('R9 server restart + reconnect same identity => RUNNING', () => {
  assert.equal(reconcileReconnect({ record: aliveRec(), sessionValid: true, bindingValid: true, ownerMatches: true, ...D_OK }).ok, true);
});
test('R10 no duplicate mutation owner', () => {
  assert.equal(reconcileReconnect({ record: aliveRec(), sessionValid: true, bindingValid: true, ownerMatches: false, ...D_OK }).canResumeMutation, false);
  assert.equal(reconcileReconnect({ record: aliveRec(), sessionValid: true, bindingValid: true, ownerMatches: true, ...D_OK }).canResumeMutation, true);
});
test('R11 cross-task isolation: cannot borrow another identity', () => {
  assert.equal(reconcileExecutorLiveness({ pid: 111, processStartTime: 1000, terminalStatus: null }, { isAlive: () => true, readStartTime: () => ({ pid: 111, processStartTime: 2000 }) }).liveness, 'PID_REUSED');
});
test('R12 effectiveStatus backward-compatible', () => {
  assert.equal(effectiveStatus(null, () => true), null);
  assert.equal(effectiveStatus({ terminalStatus: 'EXITED' }, () => false), 'EXITED');
  assert.equal(effectiveStatus({ terminalStatus: null, pid: null }, () => false), 'STARTING');
  assert.equal(effectiveStatus({ terminalStatus: null, pid: 1 }, () => true), 'RUNNING');
  assert.equal(effectiveStatus({ terminalStatus: null, pid: 1 }, () => false), 'RUNNING');
  assert.equal(effectiveStatus({ terminalStatus: null, pid: 1, finalized: true }, () => false), 'INTERRUPTED');
  assert.equal(effectiveStatus({ terminalStatus: null, pid: 1, processStartTime: 1000 }, () => true, () => ({ pid: 1, processStartTime: 2000 })), 'EXITED');
});
test('R13 classification vocabulary', () => {
  for (const k of ['RUNNING', 'EXITED', 'PID_REUSED', 'ORPHANED_TASK_PROCESS', 'OWNERSHIP_UNKNOWN', 'MCP_DISCONNECTED']) assert.ok(EXECUTOR_CLASSIFICATIONS.includes(k), k);
});
test('F1 no ExecutionRecord => DENY', () => {
  const d = executorMutationDecision({ record: null, session: SESSION, ownerMatches: true, ...D_OK });
  assert.equal(d.ok, false); assert.equal(d.reason, 'NO_EXECUTION_RECORD');
});
test('F1 stale record from a different attempt => DENY', () => {
  const d = executorMutationDecision({ record: matchRec({ worktreePath: '/wt/OLD', taskId: 'x#1' }), session: SESSION, ownerMatches: true, ...D_OK });
  assert.equal(d.ok, false); assert.equal(d.reason, 'EXECUTION_RECORD_IDENTITY_MISMATCH');
});
test('F1 same canonical execution + owner + match => ALLOW', () => {
  assert.equal(executorMutationDecision({ record: matchRec(), session: SESSION, ownerMatches: true, ...D_OK }).ok, true);
});
test('F1 foreign owner => DENY', () => {
  const d = executorMutationDecision({ record: matchRec(), session: SESSION, ownerMatches: false, ...D_OK });
  assert.equal(d.ok, false); assert.equal(d.reason, 'EXECUTOR_RECONCILIATION_REQUIRED');
});
test('F3 real Win32 probe: exact=RUNNING, mismatch=PID_REUSED, killed=EXITED', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},5000)'], { stdio: 'ignore', windowsHide: true });
  const pid = child.pid; assert.ok(Number.isInteger(pid) && pid > 0);
  let real = null; for (let i = 0; i < 60 && !real; i++) { real = readWin32ProcessStartTime(pid); if (!real) await new Promise(r => setTimeout(r, 100)); }
  assert.ok(real && real.pid === pid && real.processStartTime > 0, 'real probe returned live child start time');
  try {
    const exact = reconcileExecutorLiveness({ pid, processStartTime: real.processStartTime, terminalStatus: null });
    assert.equal(exact.liveness, 'RUNNING'); assert.equal(exact.identityProven, true);
    const mis = reconcileExecutorLiveness({ pid, processStartTime: real.processStartTime + 1000000000, terminalStatus: null });
    assert.equal(mis.liveness, 'PID_REUSED'); assert.equal(mis.identityProven, false);
  } finally { try { child.kill(); } catch {} }
  for (let i = 0; i < 60; i++) { let alive = true; try { process.kill(pid, 0); } catch { alive = false; } if (!alive) break; await new Promise(r => setTimeout(r, 100)); }
  assert.equal(reconcileExecutorLiveness({ pid, processStartTime: real.processStartTime, terminalStatus: null }).liveness, 'EXITED');
});

// ---- REWORK F2: reconcileMutationGate context model (pure) ----
test('F2 control-plane context + no ExecutionRecord => ALLOW (old authority path)', () => {
  const g = reconcileMutationGate({ session: { ...SESSION, executionMode: 'control-plane' }, record: null, ownerMatches: true, capabilityGranted: true, requiredCapability: 'commit' });
  assert.equal(g.ok, true); assert.equal(g.executionContext, 'control-plane');
});
test('F2 default (no executionMode) => control-plane path', () => {
  const g = reconcileMutationGate({ session: { ...SESSION }, record: null, ownerMatches: true, capabilityGranted: true });
  assert.equal(g.ok, true); assert.equal(g.executionContext, 'control-plane');
});
test('F2 control-plane but owner/capability fail => DENY (no bypass)', () => {
  assert.equal(reconcileMutationGate({ session: { executionMode: 'control-plane' }, ownerMatches: false }).reason, 'MUTATION_OWNER_CONFLICT');
  assert.equal(reconcileMutationGate({ session: { executionMode: 'control-plane' }, ownerMatches: true, capabilityGranted: false, requiredCapability: 'commit' }).reason, 'CAPABILITY_NOT_GRANTED');
});
test('F2 executor context: no record => DENY; valid same-attempt record => ALLOW', () => {
  const deny = reconcileMutationGate({ session: { ...SESSION, executionMode: 'executor' }, record: null, ownerMatches: true, isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: PST }) });
  assert.equal(deny.ok, false); assert.ok(['EXECUTOR_RECONCILIATION_REQUIRED','NO_EXECUTION_RECORD'].includes(deny.reason));
  const allow = reconcileMutationGate({ session: { ...SESSION, executionMode: 'executor' }, record: matchRec(), ownerMatches: true, isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: PST }) });
  assert.equal(allow.ok, true); assert.equal(allow.executionContext, 'executor');
});
test('F2 executor context: stale previous-attempt record => DENY', () => {
  const d = reconcileMutationGate({ session: { ...SESSION, executionMode: 'executor' }, record: matchRec({ baseSha: 'deadbeef', worktreePath: '/wt/OLD' }), ownerMatches: true, isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: PST }) });
  assert.equal(d.ok, false); assert.ok(['EXECUTION_RECORD_IDENTITY_MISMATCH','EXECUTOR_RECONCILIATION_REQUIRED'].includes(d.reason));
});
test('F2 unknown/malformed context => fail closed', () => {
  const d = reconcileMutationGate({ session: { ...SESSION, executionMode: 'sideways' }, record: matchRec(), ownerMatches: true });
  assert.equal(d.ok, false); assert.equal(d.reason, 'EXECUTION_CONTEXT_MALFORMED');
});
test('F2 client cannot forge context via absence in executor session (record still required)', () => {
  const g = reconcileMutationGate({ session: { ...SESSION, executionMode: 'executor' }, record: null, ownerMatches: true, isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: PST }) });
  assert.equal(g.ok, false, 'executor mode without record is never silently control-plane');
});


// ================= REWORK round-2: F1 / F2 / F3 =================
// ---- F3: authoritative-context API has NO caller override ----
test('R2-F3 reconcileMutationGate ignores any forged executionContext argument', () => {
  // passing executionContext must NOT override the authoritative session field.
  const forged = reconcileMutationGate({ session: { ...SESSION, executionMode: 'executor' }, record: null, ownerMatches: true, executionContext: 'control-plane' });
  assert.equal(forged.ok, false, 'forged control-plane arg cannot bypass executor reconcile');
});
test('R2-F3 malformed authoritative field still fails closed', () => {
  const d = reconcileMutationGate({ session: { ...SESSION, executionMode: 'weird' }, record: matchRec(), ownerMatches: true });
  assert.equal(d.ok, false); assert.equal(d.reason, 'EXECUTION_CONTEXT_MALFORMED');
});

// ---- F1: legacy/missing executionMode is ambiguous, not control-plane ----
test('R2-F1 missing executionMode resolves ambiguous, never defaults control-plane', () => {
  assert.equal(resolveExecutionContext({}).context, 'ambiguous');
  assert.equal(resolveExecutionContext({ executionMode: '' }).context, 'ambiguous');
});
test('R2-F1 legacy + live exact ExecutionRecord => reconciled (not bypassed), allow only if identity proven', () => {
  const legacy = { ...SESSION }; // no executionMode
  const allow = reconcileMutationGate({ session: legacy, record: matchRec(), ownerMatches: true, isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: PST }) });
  assert.equal(allow.ok, true); assert.equal(allow.executionContext, 'ambiguous-reconciled');
});
test('R2-F1 legacy + PID_REUSED => deny', () => {
  const d = reconcileMutationGate({ session: { ...SESSION }, record: matchRec(), ownerMatches: true, isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: 9999 }) });
  assert.equal(d.ok, false); assert.equal(d.classification, 'PID_REUSED');
});
test('R2-F1 legacy + ownership unknown (no startTime) => deny', () => {
  const d = reconcileMutationGate({ session: { ...SESSION }, record: { ...matchRec(), processStartTime: undefined }, ownerMatches: true, isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: 1 }) });
  assert.equal(d.ok, false); assert.equal(d.classification, 'OWNERSHIP_UNKNOWN');
});
test('R2-F1 genuine legacy control-plane (NO execution record at all) => old authority path', () => {
  const g = reconcileMutationGate({ session: { ...SESSION }, record: null, ownerMatches: true, capabilityGranted: true, requiredCapability: 'commit' });
  assert.equal(g.ok, true); assert.equal(g.executionContext, 'control-plane');
});
test('R2-F1 explicit executor + missing record => DENY (never control-plane fallback)', () => {
  const d = reconcileMutationGate({ session: { ...SESSION, executionMode: 'executor' }, record: null, ownerMatches: true });
  assert.equal(d.ok, false);
});

// ---- F2: terminateAndProveCleanup reconciles the ONE child, never foreign ----
test('R2-F2 child already gone => provenGone', () => {
  const r = terminateAndProveCleanup({ pid: 4242, startTime: 100, isAlive: () => false, readStartTime: () => ({ pid: 4242, processStartTime: 100 }), kill: () => { throw new Error('must not kill a dead pid'); }, sleep: () => {} });
  assert.equal(r.provenGone, true); assert.equal(r.cleanupRequired, false);
});
test('R2-F2 terminate then gone within bound', () => {
  let alive = true;
  const r = terminateAndProveCleanup({ pid: 4242, startTime: 100, isAlive: () => alive, readStartTime: () => ({ pid: 4242, processStartTime: 100 }), kill: () => { alive = false; }, sleep: () => {} });
  assert.equal(r.provenGone, true); assert.equal(r.action, 'TERMINATED');
});
test('R2-F2 cannot prove gone => cleanupRequired, session must not be usable control-plane', () => {
  const r = terminateAndProveCleanup({ pid: 4242, startTime: 100, isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: 100 }), kill: () => {}, sleep: () => {}, deadlineMs: 50, pollMs: 5 });
  assert.equal(r.provenGone, false); assert.equal(r.cleanupRequired, true);
});
test('R2-F2 pid reused (different startTime) => do NOT kill foreign, our child proven gone', () => {
  let killed = false;
  const r = terminateAndProveCleanup({ pid: 4242, startTime: 100, isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: 777 }), kill: () => { killed = true; }, sleep: () => {} });
  assert.equal(killed, false, 'must not kill a recycled pid');
  assert.equal(r.provenGone, true); assert.equal(r.foreign, true);
});


// ================= REWORK round-3: BLOCKER-1 & BLOCKER-2 =================
test('R3-B1 startTime unproven + child alive => ZERO kill, cleanupRequired', () => {
  let killed = false;
  const r = terminateAndProveCleanup({ pid: 4242, startTime: null, isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: 999 }), kill: () => { killed = true; }, sleep: () => {} });
  assert.equal(killed, false, 'must not kill when captured identity is unproven');
  assert.equal(r.provenGone, false); assert.equal(r.cleanupRequired, true);
});
test('R3-B1 live probe unavailable => never kill (cannot distinguish recycle)', () => {
  let killed = false;
  const r = terminateAndProveCleanup({ pid: 4242, startTime: 100, isAlive: () => true, readStartTime: () => null, kill: () => { killed = true; }, sleep: () => {} });
  assert.equal(killed, false); assert.equal(r.cleanupRequired, true);
});
test('R3-B1 reused pid => cleanup uses captured startA, skips B, no kill', () => {
  let killed = false;
  const r = terminateAndProveCleanup({ pid: 4242, startTime: 100, isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: 222 }), kill: () => { killed = true; }, sleep: () => {} });
  assert.equal(killed, false, 'B (a different process) must not be killed');
  assert.equal(r.foreign, true); assert.equal(r.provenGone, true);
});

// ---- BLOCKER-2: strict bind read-back predicate ----
test('R3-B2 bindReadbackOk rejects fail-open shapes', () => {
  assert.equal(bindReadbackOk({ ok: true, session: null }), false, 'ok:true + null session is a bind failure');
  assert.equal(bindReadbackOk({ ok: true }), false, 'ok:true with no session is a bind failure');
  assert.equal(bindReadbackOk({ ok: true, session: { executionMode: 'control-plane' } }), false, 'wrong mode is a bind failure');
  assert.equal(bindReadbackOk({ ok: true, session: {} }), false, 'missing mode is a bind failure');
  assert.equal(bindReadbackOk({ session: { executionMode: 'executor' } }), false, 'not ok cannot pass');
  assert.equal(bindReadbackOk(null), false);
});
test('R3-B2 bindReadbackOk accepts only exact executor read-back', () => {
  assert.equal(bindReadbackOk({ ok: true, session: { executionMode: 'executor' } }), true);
});


// ============ REWORK round-4: canonical identity / latch / relaunch ============
// BLOCKER-1: canonical processStartTime is the captured value; a later probe
// never establishes or upgrades it.
test('R4-B1 reconcile uses captured processStartTime; later probe cannot upgrade', () => {
  // record captured startA; live pid returns startB (recycled) => PID_REUSED (deny)
  const l = reconcileExecutorLiveness({ pid: 7, processStartTime: 1000, terminalStatus: null }, { isAlive: () => true, readStartTime: () => ({ pid: 7, processStartTime: 2000 }) });
  assert.equal(l.liveness, 'PID_REUSED');
});
test('R4-B1 captured startTime null stays unproven even if a later probe has a value', () => {
  const rec = { ...matchRec(), processStartTime: null };
  const d = reconcileMutationGate({ session: { ...SESSION, executionMode: 'executor' }, record: rec, ownerMatches: true, isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: 5 }) });
  assert.equal(d.ok, false);
  assert.equal(d.classification, 'OWNERSHIP_UNKNOWN');
});

// BLOCKER-2: latch predicate + relaunch proves the exact prior incarnation first.
test('R4-B2 pendingExecutorLatch detects bind and cleanup latches', () => {
  assert.equal(pendingExecutorLatch({ pendingExecutorBind: true }), true);
  assert.equal(pendingExecutorLatch({ cleanupRequired: true }), true);
  assert.equal(pendingExecutorLatch({ pendingExecutorBind: false, cleanupRequired: false }), false);
  assert.equal(pendingExecutorLatch(null), false);
});
test('R4-B2 relaunch DENIES while the exact prior child is alive', () => {
  const g = priorIncarnationProvenGone({ pid: 7, processStartTime: 1000, isAlive: () => true, readStartTime: () => ({ pid: 7, processStartTime: 1000 }) });
  assert.equal(g.provenGone, false); assert.equal(g.reason, 'PRIOR_CHILD_ALIVE');
});
test('R4-B2 relaunch allowed once prior pid dead or reused; unproven identity => not gone', () => {
  assert.equal(priorIncarnationProvenGone({ pid: 7, processStartTime: 1000, isAlive: () => false, readStartTime: () => null }).provenGone, true);
  assert.equal(priorIncarnationProvenGone({ pid: 7, processStartTime: 1000, isAlive: () => true, readStartTime: () => ({ pid: 7, processStartTime: 999 }) }).provenGone, true);
  assert.equal(priorIncarnationProvenGone({ pid: 7, processStartTime: null, isAlive: () => true, readStartTime: () => ({ pid: 7, processStartTime: 1 }) }).provenGone, false);
});

// BLOCKER-3: the latch denies EVERY mutation context, including explicit control-plane.
test('R4-B3 control-plane session with a pending/cleanup latch record => DENY (no bypass)', () => {
  const g = reconcileMutationGate({ session: { ...SESSION, executionMode: 'control-plane' }, record: { ...matchRec(), pendingExecutorBind: true }, ownerMatches: true, capabilityGranted: true });
  assert.equal(g.ok, false);
  assert.equal(g.detail, 'PENDING_BIND_OR_CLEANUP');
  assert.equal(g.executionContext, 'control-plane');
});
test('R4-B3 executor reconcile honors the latch before liveness', () => {
  const d = executorMutationDecision({ record: { ...matchRec(), pendingExecutorBind: true, terminalStatus: null }, session: { ...SESSION, executionMode: 'executor' }, ownerMatches: true, isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: PST }) });
  assert.equal(d.ok, false); assert.equal(d.reason, 'EXECUTOR_RECONCILIATION_REQUIRED');
});
test('R4-B3 cleared latch + proven identity => ALLOW (healthy executor mutates)', () => {
  const g = reconcileMutationGate({ session: { ...SESSION, executionMode: 'executor' }, record: { ...matchRec(), pendingExecutorBind: false }, ownerMatches: true, isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: PST }) });
  assert.equal(g.ok, true);
});
test('R4-B4 proven-gone cleanup clears latch => no permanent poison, relaunch ok', () => {
  const r = terminateAndProveCleanup({ pid: 4242, startTime: 100, isAlive: () => false, readStartTime: () => null, kill: () => {}, sleep: () => {} });
  assert.equal(r.provenGone, true); assert.equal(r.cleanupRequired, false);
  // with the latch cleared, a prior record is no longer pending for relaunch
  assert.equal(pendingExecutorLatch({ pendingExecutorBind: false, cleanupRequired: false, terminalStatus: 'STOPPED' }), false);
});
