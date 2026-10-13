// tests/control-loop-blocked-recovery.test.mjs — bounded failure recovery for
// soc_control stuck-after-failure (the observed production class: a failing
// step appended X->BLOCKED and NOTHING terminalized, so the task waited in
// SESSION_ACTIVE forever — no retry, no canonical BLOCKED, no operator alert).
//
// Contract under test (runControlLoop wrapper = the single choke point):
//   T1  transient failure  -> exactly ONE in-process retry of the SAME
//                             operation, then the walk completes (PASS).
//   T2  always-failing     -> ledger budget spent (2 records), canonical
//                             BLOCKED persisted + TASK_BLOCKED dispatched.
//   T3  executor failure   -> NO blind retry (non-retryable shape), original
//                             typed code preserved, canonical BLOCKED.
//   T4  UNKNOWN_OUTCOME with an existing ExecutionRecord -> reconcile, never a
//                             duplicate dispatch (executor never called).
//   T5  executor throw     -> one attempt, canonical BLOCKED.
//   T6  late call after BLOCKED -> ALREADY_TERMINAL, zero adapter work.
//   T7  delivery failure (non-BLOCKED tail) keeps SESSION_ACTIVE and later
//                             resumes to COMPLETED without re-running the gate.
//   T8  TASK_BLOCKED delivery failure can never roll the terminal state back.
//   T9  budget counted from the append-only ledger survives a restart:
//                             2 pre-existing failure records -> zero re-entry.
//   T10 pending-recovery code (side effect exists) -> session STAYS ACTIVE.
//   T11 a reconcile refusal from the RETRY (zero ledger mutation) wins over
//       the original failure: reported outcome is the refusal, the original
//       failure survives as evidence, nothing is terminalized.
//   T12 interleaved rebind: another writer binds ITS terminalize token while
//       this attempt fails -> the conditional BLOCKED write is refused
//       (TERMINALIZATION_TOKEN_MISMATCH), zero lifecycle, zero notification.
//   T13 interleaved completion: another writer COMPLETES the task during the
//       retry -> COMPLETED survives (never clobbered to BLOCKED), zero
//       duplicate TASK_BLOCKED.
//   T14 the conditional write's guards, unit level: already-terminal state,
//       foreign token and moved ledger each refuse typed with zero mutation;
//       the correct token + unchanged checkpoint DOES write (not a blanket
//       refusal).
//   T15 two terminalizations racing through the conditional write: exactly
//       ONE lifecycle event and ONE notification.
//   T16 entrypoint (finding 2): the verifier fails ONCE and NO manual resume
//       call ever comes -> canonical BLOCKED in the same call, never an
//       unowned SESSION_ACTIVE wait.
//   T17 entrypoint (finding 2): the rework executor fails ONCE with no manual
//       resume call -> canonical BLOCKED (never blindly re-dispatched).
//   T18 review finding 1: a FAILED session (taskFinish) is terminal for the
//       conditional write — typed SESSION_ALREADY_TERMINAL refusal, byte-
//       identical record, zero BLOCKED lifecycle/notification.
//   T19 review finding 3 (PROCESS-BACKED): two OS processes race the real
//       conditional write across the ownership lock file -> exactly ONE
//       winner, ONE typed refusal, ONE lifecycle, ONE notification.
//   S1  route worker: runner failure with an FSM-BLOCKED tail writes the typed
//       result and skips the duplicate GATEWAY_RUNNER_FAILED notification.
//
// No sleeps, no network: every adapter/spawn is an injected fake and the
// budget is read from the ledger (controlled fixtures), never from time.
// (T19 is the one deliberate exception: it spawns real OS processes and gates
//  them on READY/GO over stdin — synchronization is explicit, never timed.)
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as spawnChild } from 'node:child_process';

import {
  LOOP_FAILURE_MAX_ATTEMPTS,
  readTransitions,
  bindLoop,
  bindTerminalizeTokenToSession,
  ledgerCheckpoint,
  runControlLoop,
  terminalizePrecondition,
} from '../packages/control-loop/control-loop.mjs';
import { taskBlock, taskFinish } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { runControlLoopRoute } from '../packages/client-mcp/control-loop-route-worker.mjs';
import { identityHash as canonicalIdentityHash } from '../packages/workspace/workspace.mjs';

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cl-blocked-')); }

const HEAD = 'a'.repeat(40);
const BASE = 'f'.repeat(40);
const WORKTREES_ROOT = path.join(os.tmpdir(), 'cl-blocked-wt-root');

// Canonical session fixture at stateDir/sessions/<identityHash>.json (the
// same shape runtime-sandbox taskStart persists).
function mkSession(stateDir, overrides = {}) {
  const repo = overrides.repo || 'duongpdddic-droid/soc_brain';
  const issueNumber = overrides.issueNumber || 69;
  const id = identityHashOf(repo, issueNumber);
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1',
    state: 'SESSION_ACTIVE',
    lifecycle: [],
    taskId: `${repo}#${issueNumber}`,
    repo,
    issueNumber,
    headSha: HEAD,
    baseSha: BASE,
    worktreePath: path.join(WORKTREES_ROOT, `issue-${issueNumber}`),
    worktreesRoot: WORKTREES_ROOT,
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session, id };
}

// identityHash is a pure function of (repo, issueNumber); computing it through
// the canonical helper keeps the fixture byte-compatible with production.
function identityHashOf(repo, issueNumber) {
  return canonicalIdentityHash({ repo, issueNumber });
}

function readSession(sessionPath) { return JSON.parse(fs.readFileSync(sessionPath, 'utf8')); }

function seedLedger(sessionPath, stateDir, id, records) {
  const loop = bindLoop({ sessionPath, identityHash: id, stateDir });
  for (const r of records) {
    const t = loop.transition({ from: r.from, to: r.to, reason: r.reason || 'seed', evidence: r.evidence ?? null });
    assert.ok(t.ok, `seed ${r.from}->${r.to}: ${JSON.stringify(t)}`);
  }
}

function spawnOk(calls) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, input: JSON.parse(String(opts.input).trim()) });
    return { stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 901 })}\n` };
  };
}

// Full happy-path adapters (route -> execute -> verify -> reviews -> delivery),
// overridable per test.
function happyDeps(overrides = {}) {
  return {
    router: () => ({ ok: true, value: { executorKind: 'opencode', model: 'x' } }),
    executor: () => ({ ok: true, value: { executionRecordPath: '/fake/execution.json' } }),
    verifier: () => ({ ok: true, value: { verdict: 'PASS', report: 'ok' } }),
    preReview: () => ({ ok: true, value: { verdict: 'PASS', findings: [] } }),
    finalReview: () => ({ ok: true, value: { verdict: 'PASS', findings: [] } }),
    delivery: () => ({ ok: true, value: { shipped: true } }),
    telegramSpawn: spawnOk([]),
    ...overrides,
  };
}

// ---- T1: transient -> bounded in-process retry -> PASS ----------------------
test('T1. transient route failure: the SAME operation is retried exactly once in-process and the walk completes', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  let routeCalls = 0;
  const deps = happyDeps({
    router: () => {
      routeCalls += 1;
      return routeCalls === 1
        ? { ok: false, code: 'MODEL_UNRESOLVED', detail: 'model probe ETIMEDOUT' }
        : { ok: true, value: { executorKind: 'opencode', model: 'x' } };
    },
  });
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  assert.equal(routeCalls, 2, 'transient failure is retried ONCE, not spun and not skipped');
  const records = readTransitions({ stateDir, identityHash: id });
  assert.equal(records.filter((r) => r.reason === 'route:FAIL').length, 1, 'the failure record stays in the append-only ledger');
  assert.ok(records.some((r) => r.from === 'ROUTED' && r.to === 'EXECUTING'), 'the retry appended the real progress transition');
  assert.equal(readSession(sessionPath).state, 'COMPLETED');
});

// ---- T2: budget exhausted -> canonical BLOCKED + TASK_BLOCKED ---------------
test('T2. a permanently failing route spends the ledger budget, then canonicalizes BLOCKED and dispatches TASK_BLOCKED', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  let routeCalls = 0;
  const dispatchCalls = [];
  const deps = happyDeps({
    router: () => { routeCalls += 1; return { ok: false, code: 'MODEL_UNRESOLVED', detail: 'still timed out' }; },
    telegramSpawn: spawnOk(dispatchCalls),
  });
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'ROUTE_FAILED');
  assert.equal(res.terminalized, 'BLOCKED', 'the wrapper canonicalizes instead of waiting forever');
  assert.equal(routeCalls, LOOP_FAILURE_MAX_ATTEMPTS, 'bounded: attempt + ONE in-process retry, then stop');
  const records = readTransitions({ stateDir, identityHash: id });
  assert.equal(records.filter((r) => r.reason === 'route:FAIL').length, LOOP_FAILURE_MAX_ATTEMPTS, 'both failure records are preserved');
  const sess = readSession(sessionPath);
  assert.equal(sess.state, 'BLOCKED');
  assert.equal(sess.deliveryEvidence.event, 'TASK_BLOCKED', 'the canonical BLOCKED notification was dispatched');
  assert.equal(sess.deliveryEvidence.status, 'API_ACCEPTED');
  assert.equal(dispatchCalls.length, 1, 'exactly one TASK_BLOCKED worker send');
});

// ---- T3: permanent adapter failure -> no blind retry ------------------------
test('T3. a non-retryable executor failure is never blind-retried: original code preserved, canonical BLOCKED', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  let routerCalls = 0;
  let executorCalls = 0;
  const deps = happyDeps({
    router: () => { routerCalls += 1; return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: () => { executorCalls += 1; return { ok: false, code: 'EXECUTOR_DOWN' }; },
  });
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'EXECUTE_FAILED', 'the ORIGINAL typed failure is reported, never masked by the classifier re-entry');
  assert.equal(res.terminalized, 'BLOCKED');
  assert.equal(executorCalls, 1, 'no blind retry of a non-retryable adapter failure');
  assert.equal(routerCalls, 1, 'the re-entry refuses at the route gate without re-routing');
  const records = readTransitions({ stateDir, identityHash: id });
  assert.equal(records.filter((r) => String(r.reason || '').startsWith('execute:FAIL')).length, 1, 'zero extra failure records');
  assert.equal(readSession(sessionPath).state, 'BLOCKED');
});

// ---- T4: UNKNOWN_OUTCOME with a side effect -> reconcile, never dispatch ----
test('T4. UNKNOWN_OUTCOME with an existing ExecutionRecord never dispatches again: reconcile, canonical BLOCKED', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  seedLedger(sessionPath, stateDir, id, [
    { from: 'ACCEPTED', to: 'ROUTED' },
    { from: 'ROUTED', to: 'EXECUTING', evidence: { executorKind: 'opencode', model: 'x' } },
    { from: 'EXECUTING', to: 'BLOCKED', reason: 'execute:FAIL', evidence: { ok: false, code: 'UNKNOWN_OUTCOME', detail: 'timeout after dispatch' } },
  ]);
  // A real ExecutionRecord proves a dispatch already happened.
  const recPath = path.join(stateDir, 'executions', `${id}.json`);
  fs.mkdirSync(path.dirname(recPath), { recursive: true });
  fs.writeFileSync(recPath, JSON.stringify({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: id,
    taskId: 'duongpdddic-droid/soc_brain#69', repo: 'duongpdddic-droid/soc_brain', issueNumber: 69,
    baseSha: BASE, branch: 'agent/test', worktreePath: path.join(WORKTREES_ROOT, 'issue-69'),
    executor: 'opencode', executable: 'opencode', model: null, pid: 4242,
    startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, signal: null,
    terminalStatus: 'RUNNING', reason: null, instructionDigest: 'd'.repeat(64), instructionBytes: 4,
    sessionId: null, eventsPath: recPath.replace(/\.json$/, '.events.jsonl'), eventsOverflow: false,
  }, null, 2), 'utf8');
  const before = JSON.stringify(readTransitions({ stateDir, identityHash: id }));
  let routerCalls = 0;
  let executorCalls = 0;
  const deps = happyDeps({
    router: () => { routerCalls += 1; return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: () => { executorCalls += 1; return { ok: true, value: { executionRecordPath: '/fake/execution.json' } }; },
  });
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'ROUTE_FAILED', 'the classifier refuses at the gate instead of re-dispatching');
  assert.equal(res.terminalized, 'BLOCKED');
  assert.equal(executorCalls, 0, 'NEVER a duplicate dispatch while a side effect exists');
  assert.equal(routerCalls, 0, 'no route work either');
  assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: id })), before, 'ledger untouched: the original evidence survives');
  assert.equal(readSession(sessionPath).state, 'BLOCKED');
});

// ---- T5: executor throw -> one attempt, BLOCKED -----------------------------
test('T5. a throwing executor never waits forever: one attempt, typed EXECUTE_FAILED, canonical BLOCKED', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  let executorCalls = 0;
  const deps = happyDeps({
    executor: () => { executorCalls += 1; throw new Error('spawn blew up'); },
  });
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'EXECUTE_FAILED');
  assert.equal(res.terminalized, 'BLOCKED');
  assert.equal(executorCalls, 1, 'a throw is not retried blindly');
  assert.equal(readSession(sessionPath).state, 'BLOCKED');
  const records = readTransitions({ stateDir, identityHash: id });
  assert.equal(records.filter((r) => String(r.reason || '').startsWith('execute:THREW')).length, 1);
});

// ---- T6: late/duplicate call after BLOCKED -> zero work ---------------------
test('T6. a late call after canonical BLOCKED is refused ALREADY_TERMINAL with zero adapter work', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  let routerCalls = 0;
  let executorCalls = 0;
  const counting = () => ({
    router: () => { routerCalls += 1; return { ok: false, code: 'MODEL_UNRESOLVED' }; },
    executor: () => { executorCalls += 1; return { ok: true, value: { executionRecordPath: '/fake/execution.json' } }; },
  });
  const first = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: happyDeps(counting()) });
  assert.equal(first.terminalized, 'BLOCKED', JSON.stringify(first));
  const ledgerAfterFirst = JSON.stringify(readTransitions({ stateDir, identityHash: id }));
  const routerBefore = routerCalls;
  const executorBefore = executorCalls;

  const second = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: happyDeps(counting()) });
  assert.equal(second.ok, false, JSON.stringify(second));
  assert.equal(second.code, 'ALREADY_TERMINAL');
  assert.equal(second.terminalized, undefined, 'a terminal session is never re-terminalized');
  assert.equal(routerCalls, routerBefore, 'zero route work on the late call');
  assert.equal(executorCalls, executorBefore, 'zero executor work on the late call');
  assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: id })), ledgerAfterFirst, 'ledger untouched by the late call');
  assert.equal(readSession(sessionPath).state, 'BLOCKED');
});

// ---- T7: delivery failure keeps a resumable ACTIVE session ------------------
test('T7. delivery failure (non-BLOCKED tail) stays SESSION_ACTIVE and later resumes to COMPLETED without re-running the gate', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  let deliveryOk = false;
  let deliveryCalls = 0;
  let finalReviewCalls = 0;
  const dispatchCalls = [];
  const deps = happyDeps({
    finalReview: () => { finalReviewCalls += 1; return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    delivery: () => { deliveryCalls += 1; return deliveryOk ? { ok: true, value: { shipped: true } } : { ok: false, code: 'DELIVERY_TRANSPORT_DOWN' }; },
    telegramSpawn: spawnOk(dispatchCalls),
  });

  const res1 = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res1.ok, false, JSON.stringify(res1));
  assert.equal(res1.terminalized, undefined, 'a DELIVERING tail is NOT this recovery class: no terminalize');
  assert.equal(deliveryCalls, 1, 'no in-process re-entry on a non-BLOCKED failure tail');
  assert.equal(finalReviewCalls, 1);
  assert.equal(readSession(sessionPath).state, 'SESSION_ACTIVE', 'the tail stays resumable');

  deliveryOk = true;
  const res2 = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res2.ok, true, JSON.stringify(res2));
  assert.equal(res2.value.state, 'COMPLETED');
  assert.equal(deliveryCalls, 2, 'the resumed delivery re-attempts exactly the failed operation');
  assert.equal(finalReviewCalls, 1, 'the PASS gate is NEVER re-run on resume');
  assert.equal(dispatchCalls.length, 1, 'READY_FOR_REVIEW is dispatched once, never duplicated across the resume');
  assert.equal(readSession(sessionPath).state, 'COMPLETED');
});

// ---- T8: notification failure can never lose the BLOCKED state --------------
test('T8. a failed TASK_BLOCKED delivery never rolls the canonical BLOCKED state back', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const deps = happyDeps({
    router: () => ({ ok: false, code: 'MODEL_UNRESOLVED', detail: 'timeout' }),
    telegramSpawn: () => { throw new Error('ETIMEDOUT'); },
  });
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.terminalized, 'BLOCKED');
  const sess = readSession(sessionPath);
  assert.equal(sess.state, 'BLOCKED', 'state is persisted BEFORE the dispatch attempt');
  assert.notEqual(sess.deliveryEvidence && sess.deliveryEvidence.status, 'API_ACCEPTED', 'delivery evidence stays truthful (no fake success)');
});

// ---- T9: the budget is ledger-counted and restart-safe ----------------------
test('T9. restart budget: two pre-existing failure records exhaust the budget with ZERO re-entry', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const evidence = { ok: false, code: 'MODEL_UNRESOLVED', detail: 'attempt 1 timed out' };
  seedLedger(sessionPath, stateDir, id, [
    { from: 'ACCEPTED', to: 'ROUTED' },
    { from: 'ROUTED', to: 'BLOCKED', reason: 'route:FAIL', evidence },
    { from: 'ROUTED', to: 'BLOCKED', reason: 'route:FAIL', evidence: { ...evidence, detail: 'attempt 2 timed out' } },
  ]);
  const before = JSON.stringify(readTransitions({ stateDir, identityHash: id }));
  let routeCalls = 0;
  const deps = happyDeps({ router: () => { routeCalls += 1; return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; } });
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'ROUTE_FAILED');
  assert.equal(res.terminalized, 'BLOCKED');
  assert.equal(routeCalls, 0, 'the budget was already spent before this process started: no re-entry at all');
  assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: id })), before, 'zero new records');
  assert.equal(readSession(sessionPath).state, 'BLOCKED');
});

// ---- T10: pending-recovery code keeps the session resumable -----------------
test('T10. a defined reconcile path (side effect exists) never terminalizes: session stays SESSION_ACTIVE', async () => {
  const stateDir = mkStateDir();
  const s = mkSession(stateDir, { controlPlane: { stateDir } });
  seedLedger(s.sessionPath, stateDir, s.id, [
    { from: 'ACCEPTED', to: 'ROUTED' },
    { from: 'ROUTED', to: 'EXECUTING', evidence: { executorKind: 'opencode', model: 'x' } },
    { from: 'EXECUTING', to: 'BLOCKED', reason: 'execute:FAIL', evidence: { ok: false, code: 'INSTRUCTION_REQUIRED' } },
  ]);
  // The dispatch side effect exists: reconcile first, never a duplicate spawn.
  const recPath = path.join(stateDir, 'executions', `${s.id}.json`);
  fs.mkdirSync(path.dirname(recPath), { recursive: true });
  fs.writeFileSync(recPath, JSON.stringify({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: s.id,
    taskId: s.session.taskId, repo: s.session.repo, issueNumber: s.session.issueNumber,
    baseSha: s.session.baseSha, branch: 'agent/test', worktreePath: s.session.worktreePath,
    executor: 'opencode', executable: 'opencode', model: null, pid: 4242,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0, signal: null,
    terminalStatus: 'EXITED', reason: null, instructionDigest: 'd'.repeat(64), instructionBytes: 4,
    sessionId: null, eventsPath: recPath.replace(/\.json$/, '.events.jsonl'), eventsOverflow: false,
  }, null, 2), 'utf8');
  const before = JSON.stringify(readTransitions({ stateDir, identityHash: s.id }));
  let routerCalls = 0;
  let executorCalls = 0;
  const deps = happyDeps({
    router: () => { routerCalls += 1; return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: () => { executorCalls += 1; return { ok: true, value: { executionRecordPath: '/fake/execution.json' } }; },
  });
  const res = await runControlLoop({ sessionPath: s.sessionPath, identityHash: s.id, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'EXECUTE_RETRY_BLOCKED_SIDE_EFFECT');
  assert.equal(res.terminalized, undefined, 'pending-recovery codes are never terminalized');
  assert.equal(routerCalls, 0);
  assert.equal(executorCalls, 0);
  assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: s.id })), before, 'ledger untouched');
  assert.equal(readSession(s.sessionPath).state, 'SESSION_ACTIVE', 'the reconcile path stays available');
});

// ---- T11: a retry's reconcile refusal WINS (finding 3) ----------------------
test('T11. the retry refuses typed with ZERO ledger mutation: its refusal is the outcome, the original failure survives, nothing is terminalized', async () => {
  const stateDir = mkStateDir();
  const s = mkSession(stateDir, { controlPlane: { stateDir } });
  // A canonical ExecutionRecord appears AFTER the first probe failed and
  // BEFORE the wrapper re-enters: a dispatch side effect is now alive.
  const writeExecRecord = () => {
    const recPath = path.join(stateDir, 'executions', `${s.id}.json`);
    fs.mkdirSync(path.dirname(recPath), { recursive: true });
    fs.writeFileSync(recPath, JSON.stringify({
      schemaVersion: '1', kind: 'ExecutionRecord', identityHash: s.id,
      taskId: s.session.taskId, repo: s.session.repo, issueNumber: s.session.issueNumber,
      baseSha: s.session.baseSha, branch: 'agent/test', worktreePath: s.session.worktreePath,
      executor: 'opencode', executable: 'opencode', model: null, pid: 4242,
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0, signal: null,
      terminalStatus: 'EXITED', reason: null, instructionDigest: 'd'.repeat(64), instructionBytes: 4,
      sessionId: null, eventsPath: recPath.replace(/\.json$/, '.events.jsonl'), eventsOverflow: false,
    }, null, 2), 'utf8');
    return recPath;
  };
  let routeCalls = 0;
  const deps = happyDeps({
    router: () => {
      routeCalls += 1;
      if (routeCalls === 1) {
        writeExecRecord();
        return { ok: false, code: 'MODEL_UNRESOLVED', detail: 'model probe timed out' };
      }
      return { ok: true, value: { executorKind: 'opencode', model: 'x' } };
    },
    executor: () => { throw new Error('the executor must NEVER run while the side effect is unreconciled'); },
  });
  const res = await runControlLoop({ sessionPath: s.sessionPath, identityHash: s.id, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'ROUTE_RETRY_BLOCKED_SIDE_EFFECT', 'the RETRY attempt\'s typed refusal decides — not the original failure');
  assert.equal(res.originalFailure && res.originalFailure.code, 'ROUTE_FAILED', 'the original failure is kept as evidence, never dropped');
  assert.equal(res.terminalized, undefined, 'an unreconciled live side effect is never terminalized blind');
  assert.equal(routeCalls, 1, 'the router is never called again while the side effect exists');
  const records = readTransitions({ stateDir, identityHash: s.id });
  assert.equal(records.filter((r) => String(r.reason || '').startsWith('route:FAIL')).length, 1, 'the refusal appended ZERO ledger records');
  assert.equal(readSession(s.sessionPath).state, 'SESSION_ACTIVE', 'the reconcile path stays available');
});

// ---- T12: interleaved REBIND — the conditional write refuses (finding 1) ----
test('T12. another writer rebinds the terminalize token mid-flight: the BLOCKED write is refused with zero mutation and zero notification', async () => {
  const stateDir = mkStateDir();
  const s = mkSession(stateDir, { controlPlane: { stateDir } });
  const dispatchCalls = [];
  const foreignToken = 'b'.repeat(64);
  const deps = happyDeps({
    executor: () => {
      // Attempt A is failing while attempt B (another live loop) binds ITS
      // token: A must no longer be able to terminalize with a stale authority.
      const foreign = bindTerminalizeTokenToSession({ sessionPath: s.sessionPath, identityHash: s.id, token: foreignToken, stateDir });
      assert.ok(foreign.ok, JSON.stringify(foreign));
      return { ok: false, code: 'EXECUTOR_DOWN' };
    },
    telegramSpawn: spawnOk(dispatchCalls),
  });
  const res = await runControlLoop({ sessionPath: s.sessionPath, identityHash: s.id, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'EXECUTE_FAILED', 'the original typed failure is still reported');
  assert.equal(res.terminalized, undefined, 'no terminal state is claimed on a refused write');
  assert.equal(res.terminalize && res.terminalize.ok, false, JSON.stringify(res.terminalize));
  assert.equal(res.terminalize && res.terminalize.reason, 'TERMINALIZATION_TOKEN_MISMATCH');
  const sess = readSession(s.sessionPath);
  assert.equal(sess.state, 'SESSION_ACTIVE', 'the concurrent binder\'s authority wins: no clobber');
  assert.equal(sess.controlLoop && sess.controlLoop.terminalizeToken, foreignToken, 'the other writer\'s token stays bound');
  assert.equal(dispatchCalls.length, 0, 'zero TASK_BLOCKED notification on a refused write');
  assert.equal((sess.lifecycle || []).filter((e) => e.event === 'TASK_BLOCKED').length, 0, 'zero lifecycle event on a refused write');
});

// ---- T13: interleaved COMPLETION — COMPLETED survives (finding 1) -----------
test('T13. another writer completes the task during the retry: COMPLETED survives, zero duplicate lifecycle or notification', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const dispatchCalls = [];
  let routeCalls = 0;
  const deps = happyDeps({
    router: () => {
      routeCalls += 1;
      if (routeCalls === 1) return { ok: false, code: 'MODEL_UNRESOLVED', detail: 'probe timed out' };
      // On the in-process retry a concurrent writer finalizes the task FIRST.
      const fin = taskFinish({ sessionPath, outcome: 'COMPLETED', dispatchOptions: { stateDir } });
      assert.ok(fin.ok, JSON.stringify(fin));
      return { ok: false, code: 'MODEL_UNRESOLVED', detail: 'probe timed out again' };
    },
    telegramSpawn: spawnOk(dispatchCalls),
  });
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.terminalized, undefined, 'the wrapper never claims BLOCKED after the session was finalized');
  const sess = readSession(sessionPath);
  assert.equal(sess.state, 'COMPLETED', 'a concurrently persisted COMPLETED is never overwritten with BLOCKED');
  assert.equal((sess.lifecycle || []).filter((e) => e.event === 'TASK_COMPLETED').length, 1, 'exactly one completion lifecycle event');
  assert.equal((sess.lifecycle || []).filter((e) => e.event === 'TASK_BLOCKED').length, 0, 'zero duplicate BLOCKED lifecycle');
  assert.equal(dispatchCalls.length, 0, 'zero TASK_BLOCKED notification');
  assert.equal(routeCalls, 2, 'the retry really re-entered before the interleaving landed');
});

// ---- T14: the conditional write's guards, unit level (finding 1) ------------
test('T14. conditional BLOCKED write: terminal state / foreign token / moved ledger each refuse typed with zero mutation, the correct path still writes', async () => {
  // (a) foreign token while the session is ACTIVE -> refused.
  {
    const stateDir = mkStateDir();
    const { sessionPath, id } = mkSession(stateDir);
    seedLedger(sessionPath, stateDir, id, [{ from: 'ACCEPTED', to: 'ROUTED' }]);
    bindTerminalizeTokenToSession({ sessionPath, identityHash: id, token: 'a'.repeat(64), stateDir });
    const cp = ledgerCheckpoint(readTransitions({ stateDir, identityHash: id }));
    const r = taskBlock({ sessionPath, precondition: terminalizePrecondition({ authority: { token: 'b'.repeat(64) }, stateDir, identityHash: id, checkpoint: cp }) });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.reason, 'TERMINALIZATION_TOKEN_MISMATCH');
    const sess = readSession(sessionPath);
    assert.equal(sess.state, 'SESSION_ACTIVE', 'a refused write never mutates state');
    assert.equal((sess.lifecycle || []).filter((e) => e.event === 'TASK_BLOCKED').length, 0, 'zero lifecycle event');
  }

  // (b) another writer already COMPLETED the session -> refused, never clobbered.
  {
    const stateDir = mkStateDir();
    const { sessionPath, id } = mkSession(stateDir);
    seedLedger(sessionPath, stateDir, id, [{ from: 'ACCEPTED', to: 'ROUTED' }]);
    const token = 'a'.repeat(64);
    bindTerminalizeTokenToSession({ sessionPath, identityHash: id, token, stateDir });
    const fin = taskFinish({ sessionPath, outcome: 'COMPLETED', dispatchOptions: { stateDir } });
    assert.ok(fin.ok, JSON.stringify(fin));
    const cp = ledgerCheckpoint(readTransitions({ stateDir, identityHash: id }));
    const r = taskBlock({ sessionPath, precondition: terminalizePrecondition({ authority: { token }, stateDir, identityHash: id, checkpoint: cp }) });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.reason, 'SESSION_ALREADY_TERMINAL');
    assert.equal(readSession(sessionPath).state, 'COMPLETED', 'the completed task stays COMPLETED');
  }

  // (c) the ledger moved after the checkpoint was taken -> refused.
  {
    const stateDir = mkStateDir();
    const { sessionPath, id } = mkSession(stateDir);
    seedLedger(sessionPath, stateDir, id, [{ from: 'ACCEPTED', to: 'ROUTED' }]);
    const token = 'a'.repeat(64);
    bindTerminalizeTokenToSession({ sessionPath, identityHash: id, token, stateDir });
    const staleCp = ledgerCheckpoint(readTransitions({ stateDir, identityHash: id }));
    seedLedger(sessionPath, stateDir, id, [{ from: 'ROUTED', to: 'EXECUTING', evidence: { executorKind: 'opencode', model: 'x' } }]);
    const r = taskBlock({ sessionPath, precondition: terminalizePrecondition({ authority: { token }, stateDir, identityHash: id, checkpoint: staleCp }) });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.reason, 'LEDGER_CHECKPOINT_MOVED');
    assert.equal(readSession(sessionPath).state, 'SESSION_ACTIVE', 'a stale decision never writes');
  }

  // (d) correct token + ACTIVE session + unchanged checkpoint -> the write goes
  // through (the guard is a precondition, not a blanket refusal).
  {
    const stateDir = mkStateDir();
    const { sessionPath, id } = mkSession(stateDir);
    const dispatchCalls = [];
    seedLedger(sessionPath, stateDir, id, [{ from: 'ACCEPTED', to: 'ROUTED' }]);
    const token = 'a'.repeat(64);
    bindTerminalizeTokenToSession({ sessionPath, identityHash: id, token, stateDir });
    const cp = ledgerCheckpoint(readTransitions({ stateDir, identityHash: id }));
    const r = taskBlock({
      sessionPath,
      dispatchOptions: { stateDir, spawn: spawnOk(dispatchCalls), allowNonCanonicalStateRoot: true },
      precondition: terminalizePrecondition({ authority: { token }, stateDir, identityHash: id, checkpoint: cp }),
    });
    assert.equal(r && r.ok, true, JSON.stringify(r));
    const sess = readSession(sessionPath);
    assert.equal(sess.state, 'BLOCKED');
    assert.equal((sess.lifecycle || []).filter((e) => e.event === 'TASK_BLOCKED').length, 1);
    assert.equal(dispatchCalls.length, 1, 'exactly one notification when the guards pass');
  }
});

// ---- T15: racing terminalizations -> exactly one lifecycle + one dispatch ---
test('T15. two terminalizations through the conditional write: exactly ONE TASK_BLOCKED lifecycle and ONE notification', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const dispatchCalls = [];
  seedLedger(sessionPath, stateDir, id, [{ from: 'ACCEPTED', to: 'ROUTED' }]);
  const token = 'a'.repeat(64);
  bindTerminalizeTokenToSession({ sessionPath, identityHash: id, token, stateDir });
  const pre = () => terminalizePrecondition({ authority: { token }, stateDir, identityHash: id, checkpoint: ledgerCheckpoint(readTransitions({ stateDir, identityHash: id })) });
  const opts = () => ({ stateDir, spawn: spawnOk(dispatchCalls), allowNonCanonicalStateRoot: true });
  const first = taskBlock({ sessionPath, dispatchOptions: opts(), precondition: pre() });
  assert.equal(first && first.ok, true, JSON.stringify(first));
  const second = taskBlock({ sessionPath, dispatchOptions: opts(), precondition: pre() });
  assert.equal(second && second.ok, false, JSON.stringify(second));
  assert.equal(second && second.reason, 'SESSION_ALREADY_TERMINAL', 'the second writer is refused instead of re-blocking');
  const sess = readSession(sessionPath);
  assert.equal(sess.state, 'BLOCKED');
  assert.equal((sess.lifecycle || []).filter((e) => e.event === 'TASK_BLOCKED').length, 1, 'exactly one lifecycle event');
  assert.equal(dispatchCalls.length, 1, 'exactly one notification (no duplicate operator noise)');
});

// ---- T16: verify fails once, NO manual resume -> BLOCKED (finding 2) --------
test('T16. entrypoint: the verifier fails ONCE with no manual resume call — canonical BLOCKED in the same call, never an unowned active wait', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const dispatchCalls = [];
  let verifyCalls = 0;
  const deps = happyDeps({
    verifier: () => { verifyCalls += 1; return { ok: false, code: 'VERIFY_DOWN', detail: 'verifier transport down' }; },
    telegramSpawn: spawnOk(dispatchCalls),
  });
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'VERIFY_FAILED', 'the typed failure is preserved');
  assert.equal(verifyCalls, 1, 'no blind second verification');
  assert.equal(res.terminalized, 'BLOCKED', JSON.stringify(res.terminalize || null));
  const sess = readSession(sessionPath);
  assert.equal(sess.state, 'BLOCKED', 'ONE call, zero manual resume: the task is never left hanging in SESSION_ACTIVE');
  assert.equal(sess.deliveryEvidence && sess.deliveryEvidence.event, 'TASK_BLOCKED', 'the operator is alerted');
  assert.equal(dispatchCalls.length, 1, 'exactly one TASK_BLOCKED notification');
});

// ---- T17: rework executor fails once -> BLOCKED (finding 2) -----------------
test('T17. entrypoint: the rework executor fails ONCE with no manual resume call — canonical BLOCKED, never blindly re-dispatched', async () => {
  const stateDir = mkStateDir();
  const s = mkSession(stateDir, { controlPlane: { stateDir } });
  const rw = {
    verdict: 'REWORK', findings: ['fix-the-flaky-test'], evidenceRequests: ['provide logs'],
    confidence: 0.8, metadata: {},
    binding: { repository: s.session.repo, issue: s.session.issueNumber, headSha: HEAD },
  };
  let initialExecutorCalls = 0;
  let reworkExecutorCalls = 0;
  const deps = happyDeps({
    finalReview: () => ({ ok: true, value: rw }),
    executor: (ctx) => {
      if (ctx && ctx.reworkInstruction) {
        reworkExecutorCalls += 1;
        return { ok: false, code: 'EXECUTOR_TIMEOUT' };
      }
      initialExecutorCalls += 1;
      return { ok: true, value: { executionRecordPath: '/fake/execution.json' } };
    },
  });
  const res = await runControlLoop({ sessionPath: s.sessionPath, identityHash: s.id, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'REWORK_EXECUTE_FAILED', 'the typed failure is preserved');
  assert.equal(initialExecutorCalls, 1);
  assert.equal(reworkExecutorCalls, 1, 'the failed rework dispatch is NEVER blindly re-run in the same call');
  assert.equal(res.terminalized, 'BLOCKED', JSON.stringify(res.terminalize || null));
  const sess = readSession(s.sessionPath);
  assert.equal(sess.state, 'BLOCKED', 'ONE call, zero manual resume: never left hanging in SESSION_ACTIVE');
  assert.equal((sess.lifecycle || []).filter((e) => e.event === 'TASK_BLOCKED').length, 1, 'exactly one BLOCKED lifecycle event');
  const tos = readTransitions({ stateDir, identityHash: s.id }).map((r) => r.to);
  assert.ok(!tos.includes('COMPLETED'), 'a failed dispatch is never dressed up as success');
});

// ---- T18: FAILED is terminal for the conditional write (review finding 1) ---
test('T18. a FAILED session is never overwritten by the conditional BLOCKED write: typed refusal, byte-identical record, zero notification', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const dispatchCalls = [];
  seedLedger(sessionPath, stateDir, id, [{ from: 'ACCEPTED', to: 'ROUTED' }]);
  const token = 'a'.repeat(64);
  bindTerminalizeTokenToSession({ sessionPath, identityHash: id, token, stateDir });
  // The task fails canonically (taskFinish FAILED persists a terminal SESSION
  // record state that is NOT in the ledger-tail TERMINAL_STATES set).
  const fin = taskFinish({
    sessionPath, outcome: 'FAILED',
    dispatchOptions: { stateDir, spawn: spawnOk(dispatchCalls), allowNonCanonicalStateRoot: true },
  });
  assert.ok(fin.ok, JSON.stringify(fin));
  const dispatchesAfterFinish = dispatchCalls.length;
  const before = fs.readFileSync(sessionPath, 'utf8');
  const cp = ledgerCheckpoint(readTransitions({ stateDir, identityHash: id }));
  // Correct token + unchanged checkpoint: without the terminal-state guard
  // this write would clobber FAILED into BLOCKED (the review finding).
  const r = taskBlock({
    sessionPath,
    dispatchOptions: { stateDir, spawn: spawnOk(dispatchCalls), allowNonCanonicalStateRoot: true },
    precondition: terminalizePrecondition({ authority: { token }, stateDir, identityHash: id, checkpoint: cp }),
  });
  assert.equal(r && r.ok, false, JSON.stringify(r));
  assert.equal(r.reason, 'SESSION_ALREADY_TERMINAL', 'FAILED is terminal — same typed refusal as COMPLETED/BLOCKED');
  assert.equal(r.state, 'FAILED');
  assert.equal(fs.readFileSync(sessionPath, 'utf8'), before, 'the FAILED record is byte-identical: zero mutation on a refused write');
  const sess = readSession(sessionPath);
  assert.equal(sess.state, 'FAILED', 'the task stays FAILED, never dressed up as BLOCKED');
  assert.equal((sess.lifecycle || []).filter((e) => e.event === 'TASK_BLOCKED').length, 0, 'zero BLOCKED lifecycle event');
  assert.equal((sess.lifecycle || []).filter((e) => e.event === 'TASK_FAILED').length, 1, 'the original FAILED lifecycle stays exactly once');
  assert.equal(dispatchCalls.length, dispatchesAfterFinish, 'zero TASK_BLOCKED notification on the refused write');
});

// ---- T19: PROCESS-BACKED racing terminalizations (review finding 3) ----------
test('T19. PROCESS-BACKED: two OS processes race the real conditional write — exactly ONE winner, ONE typed refusal, ONE lifecycle, ONE notification', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const markerPath = path.join(stateDir, 'dispatch-marker.log');
  seedLedger(sessionPath, stateDir, id, [{ from: 'ACCEPTED', to: 'ROUTED' }]);
  const token = 'a'.repeat(64);
  bindTerminalizeTokenToSession({ sessionPath, identityHash: id, token, stateDir });
  const fixture = path.resolve('tests', 'fixtures', 'conditional-blocked-racer.mjs');
  const args = JSON.stringify({ sessionPath, identityHash: id, stateDir, token, markerPath });

  const racers = [0, 1].map(() => {
    const child = spawnChild(process.execPath, [fixture, args], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    // Attach the close promise IMMEDIATELY: a fast racer can exit before we
    // finish reading its DONE line, and a late listener would never fire
    // (leaving this test pending with an empty event loop).
    const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    const out = { ready: null, done: null, buffer: '' };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out.buffer += chunk;
      let nl;
      while ((nl = out.buffer.indexOf('\n')) >= 0) {
        const line = out.buffer.slice(0, nl);
        out.buffer = out.buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.event === 'READY') out.ready = msg;
        else if (msg.event === 'DONE') out.done = msg;
      }
    });
    return { child, out, closed };
  });

  // Both racers must be READY (checkpoint taken, blocked on stdin) before the
  // parent releases them — the contention window is real, not simulated, and
  // the wait is an explicit READY handshake, never a timed sleep.
  const waitReadyDeadline = Date.now() + 20000;
  while ((!racers[0].out.ready || !racers[1].out.ready) && Date.now() < waitReadyDeadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(racers[0].out.ready && racers[1].out.ready,
    `both racers must report READY: ${JSON.stringify(racers.map((r) => r.out.ready))}`);
  const readyPids = racers.map((r) => r.out.ready.pid);
  assert.equal(new Set(readyPids).size, 2, `two DISTINCT OS processes: ${JSON.stringify(readyPids)}`);
  for (const r of racers) assert.ok(r.out.ready.startedAt, 'each racer reports its real start time');

  // GO: release both racers within the same tick — whoever wins the ownership
  // lock writes; the loser must be refused TYPED against the persisted state.
  for (const r of racers) r.child.stdin.write('GO');
  const waitDoneDeadline = Date.now() + 20000;
  while ((!racers[0].out.done || !racers[1].out.done) && Date.now() < waitDoneDeadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(racers[0].out.done && racers[1].out.done,
    `both racers must report DONE: ${JSON.stringify(racers.map((r) => r.out.done))}`);
  const exits = await Promise.all(racers.map((r) => r.closed));
  for (const e of exits) assert.equal(e.code, 0, `racer must exit cleanly: ${JSON.stringify(e)}`);

  const results = racers.map((r) => r.out.done);
  const winners = results.filter((r) => r.ok === true);
  const losers = results.filter((r) => r.ok === false);
  assert.equal(winners.length, 1, `exactly ONE writer wins the critical section: ${JSON.stringify(results)}`);
  assert.equal(losers.length, 1, `exactly one loser: ${JSON.stringify(results)}`);
  assert.equal(losers[0].reason, 'SESSION_ALREADY_TERMINAL',
    'the loser is refused TYPED against the persisted BLOCKED state — never last-writer-wins');

  const sess = readSession(sessionPath);
  assert.equal(sess.state, 'BLOCKED');
  assert.equal((sess.lifecycle || []).filter((e) => e.event === 'TASK_BLOCKED').length, 1,
    'exactly ONE TASK_BLOCKED lifecycle event across both processes');
  const markers = fs.existsSync(markerPath)
    ? fs.readFileSync(markerPath, 'utf8').split('\n').filter(Boolean)
    : [];
  assert.equal(markers.length, 1, `exactly ONE notification dispatch across both processes: ${JSON.stringify(markers)}`);
  assert.equal(markers[0], String(winners[0].pid), 'the notification comes from the single winner');
});

// ---- S1: route worker smoke ------------------------------------------------
function writeRouteRequest({ stateDir, sessionPath, id }) {
  const routesDir = path.join(stateDir, 'client-mcp', 'routes');
  fs.mkdirSync(routesDir, { recursive: true });
  const requestPath = path.join(routesDir, `${id}.control-loop.json`);
  fs.writeFileSync(requestPath, JSON.stringify({
    kind: 'soc-control-loop-route',
    sessionPath,
    stateDir,
    identityHash: id,
    repo: 'duongpdddic-droid/soc_brain',
    issueNumber: 69,
    goal: 'fix the stuck control loop',
    requestedAt: new Date().toISOString(),
  }), 'utf8');
  return requestPath;
}

function sessionForWorker(stateDir) {
  const s = mkSession(stateDir, { controlPlane: { stateDir } });
  // The worker binds the request to the canonical session identity marker.
  const sess = readSession(s.sessionPath);
  sess.identityHash = s.id;
  fs.writeFileSync(s.sessionPath, JSON.stringify(sess, null, 2), 'utf8');
  return s;
}

test('S1a. route worker: runner failure with a non-BLOCKED tail still notifies GATEWAY_RUNNER_FAILED once', async () => {
  const stateDir = mkStateDir();
  const s = sessionForWorker(stateDir);
  const requestPath = writeRouteRequest({ stateDir, sessionPath: s.sessionPath, id: s.id });
  const dispatched = [];
  const res = await runControlLoopRoute({
    requestPath,
    run: async () => ({ ok: false, code: 'LOOP_RUNNER_FAILED', detail: 'gateway runner blew up' }),
    dispatch: (o) => { dispatched.push(o); return { ok: true, status: 'API_ACCEPTED' }; },
  });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'LOOP_RUNNER_FAILED');
  const out = JSON.parse(fs.readFileSync(`${requestPath}.result.json`, 'utf8'));
  assert.equal(out.code, 'LOOP_RUNNER_FAILED', 'the typed result is persisted for the gateway');
  assert.equal(dispatched.length, 1, 'no FSM BLOCKED record: the runner-failure alert is dispatched');
  assert.equal(dispatched[0].event, 'GATEWAY_RUNNER_FAILED');
});

test('S1b. route worker: an FSM-BLOCKED tail suppresses the duplicate GATEWAY_RUNNER_FAILED notification', async () => {
  const stateDir = mkStateDir();
  const s = sessionForWorker(stateDir);
  seedLedger(s.sessionPath, stateDir, s.id, [
    { from: 'ACCEPTED', to: 'ROUTED' },
    { from: 'ROUTED', to: 'BLOCKED', reason: 'route:FAIL', evidence: { ok: false, code: 'MODEL_UNRESOLVED' } },
  ]);
  const requestPath = writeRouteRequest({ stateDir, sessionPath: s.sessionPath, id: s.id });
  const dispatched = [];
  const res = await runControlLoopRoute({
    requestPath,
    run: async () => ({ ok: false, code: 'EXECUTE_FAILED', detail: 'executor down' }),
    dispatch: (o) => { dispatched.push(o); return { ok: true, status: 'API_ACCEPTED' }; },
  });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'EXECUTE_FAILED');
  const out = JSON.parse(fs.readFileSync(`${requestPath}.result.json`, 'utf8'));
  assert.equal(out.ok, false, 'the typed failure is still persisted');
  assert.equal(dispatched.length, 0, 'the FSM already carries BLOCKED (TASK_BLOCKED dispatched): no duplicate noise');
});
