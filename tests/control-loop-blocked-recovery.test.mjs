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
//   S1  route worker: runner failure with an FSM-BLOCKED tail writes the typed
//       result and skips the duplicate GATEWAY_RUNNER_FAILED notification.
//
// No sleeps, no network: every adapter/spawn is an injected fake and the
// budget is read from the ledger (controlled fixtures), never from time.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  LOOP_FAILURE_MAX_ATTEMPTS,
  readTransitions,
  bindLoop,
  runControlLoop,
} from '../packages/control-loop/control-loop.mjs';
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
