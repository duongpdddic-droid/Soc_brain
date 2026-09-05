// tests/control-loop.test.mjs — deterministic regression tests for Issue #69.
// No external framework; plain node:test.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CONTROL_LOOP_SCHEMA_VERSION,
  LOOP_STATES,
  TERMINAL_STATES,
  readTransitions,
  bindLoop,
  runControlLoop,
  assertTerminalizationAuthorized,
  bindTerminalizeTokenToSession,
} from '../packages/control-loop/control-loop.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cl-test-')); }

// Build a fake canonical session record at stateDir/sessions/<id>.json,
// mirroring what runtime-sandbox taskStart writes. readSessionRecord enforces
// the canonical control-plane location, so the filename must be the real
// identityHash of (repo, issueNumber).
function mkSession(stateDir, overrides = {}) {
  const repo = overrides.repo || 'duongpdddic-droid/soc_brain';
  const issueNumber = overrides.issueNumber || 69;
  const id = identityHash({ repo, issueNumber });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1',
    state: 'SESSION_ACTIVE',
    lifecycle: [],
    taskId: `${repo}#${issueNumber}`,
    repo,
    issueNumber,
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session, id };
}

test('A. module surface: schema, states, terminal set', () => {
  assert.equal(CONTROL_LOOP_SCHEMA_VERSION, '1');
  assert.ok(LOOP_STATES.includes('ACCEPTED') && LOOP_STATES.includes('COMPLETED') && LOOP_STATES.includes('BLOCKED'));
  assert.ok(TERMINAL_STATES.has('COMPLETED') && TERMINAL_STATES.has('BLOCKED'));
  assert.ok(Object.isFrozen(LOOP_STATES));
});

test('B. bindLoop: legal + illegal transitions and transition ledger', () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const loop = bindLoop({ sessionPath, identityHash: ID, stateDir });
  assert.ok(loop.token && loop.token.length === 64);

  const t1 = loop.transition({ from: 'ACCEPTED', to: 'ROUTED', reason: 'test' });
  assert.ok(t1.ok);
  const t2 = loop.transition({ from: 'ACCEPTED', to: 'COMPLETED' }); // illegal
  assert.equal(t2.ok, false);
  assert.equal(t2.code, 'ILLEGAL_TRANSITION');
  const t3 = loop.transition({ from: 'ROUTED', to: 'ACCEPTED' }); // illegal (no backedge)
  assert.equal(t3.ok, false);

  const records = loop.readTransitions();
  assert.equal(records.length, 1);
  assert.equal(records[0].from, 'ACCEPTED');
  assert.equal(records[0].to, 'ROUTED');
  assert.equal(records[0].identityHash, ID);
});

test('C. runControlLoop happy path: PASS verdict -> COMPLETED via ControlLoop terminalize', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, session, id: ID } = mkSession(stateDir);
  const calls = [];
  const deps = {
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: '/fake/execution.json' } }; },
    verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
    telegramSpawn: () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 900 })}\n` }),
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  assert.ok(res.value.terminalize.ok, JSON.stringify(res.value.terminalize));
  assert.deepEqual(calls, ['router', 'executor', 'verifier', 'preReview', 'finalReview', 'delivery']);

  // Session record must now be terminal, and terminalization came from the loop.
  const rec = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(rec.state, 'COMPLETED');
});

test('D. runControlLoop REWORK verdict: does NOT terminalize', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const deps = {
    router: () => ({ ok: true, value: { executorKind: 'opencode', model: 'x' } }),
    executor: () => ({ ok: true, value: { executionRecordPath: '/fake/execution.json' } }),
    verifier: () => ({ ok: true, value: { verdict: 'PASS', report: 'ok' } }),
    preReview: () => ({ ok: true, value: { verdict: 'PASS', findings: [] } }),
    finalReview: () => ({ ok: true, value: { verdict: 'REWORK', findings: ['f1'] } }),
    delivery: () => { assert.fail('delivery must NOT be called on REWORK'); },
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true);
  assert.equal(res.value.state, 'REWORK');
  assert.equal(res.value.terminalize, undefined);
  const rec = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(rec.state, 'SESSION_ACTIVE'); // not terminalized
  const records = readTransitions({ stateDir, identityHash: ID });
  const last = records[records.length - 1];
  assert.equal(last.to, 'REWORK');
});

test('E. runControlLoop BLOCKED verdict -> BLOCKED terminal', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const deps = {
    router: () => ({ ok: true, value: { executorKind: 'opencode', model: 'x' } }),
    executor: () => ({ ok: true, value: { executionRecordPath: '/fake/execution.json' } }),
    verifier: () => ({ ok: true, value: { verdict: 'PASS', report: 'ok' } }),
    preReview: () => ({ ok: true, value: { verdict: 'PASS', findings: [] } }),
    finalReview: () => ({ ok: true, value: { verdict: 'BLOCKED', findings: ['security'] } }),
    delivery: () => { assert.fail('delivery must NOT be called on BLOCKED'); },
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true);
  assert.equal(res.value.state, 'BLOCKED');
  const rec = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(rec.state, 'BLOCKED');
});

test('F. adapter failure -> BLOCKED side-transition, no terminalize, fail-closed', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const deps = {
    router: () => ({ ok: true, value: { executorKind: 'opencode', model: 'x' } }),
    executor: () => ({ ok: false, code: 'EXECUTOR_DOWN' }),
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'EXECUTE_FAILED');
  const rec = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  // Adapter failure side-transition is BLOCKED but NOT terminalized — no
  // canonical taskFinish/taskBlock happened; the task is still recoverable.
  const records = readTransitions({ stateDir, identityHash: ID });
  const last = records[records.length - 1];
  assert.equal(last.to, 'BLOCKED');
  assert.equal(last.reason, 'execute:FAIL');
  assert.equal(rec.state, 'SESSION_ACTIVE');
});

test('G. terminalization guard: non-ControlLoop caller is rejected', () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  // No controlLoop binding yet.
  const r1 = assertTerminalizationAuthorized({ sessionPath, identityHash: ID, presentedToken: 'whatever', stateDir });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'NOT_CONTROL_LOOP_BOUND');

  // Bind a token, then present wrong token.
  bindTerminalizeTokenToSession({ sessionPath, identityHash: ID, token: 'a'.repeat(64), stateDir });
  const r2 = assertTerminalizationAuthorized({ sessionPath, identityHash: ID, presentedToken: 'b'.repeat(64), stateDir });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'TERMINALIZATION_TOKEN_MISMATCH');

  // Correct token authorizes.
  const r3 = assertTerminalizationAuthorized({ sessionPath, identityHash: ID, presentedToken: 'a'.repeat(64), stateDir });
  assert.equal(r3.ok, true);
});

test('H. idempotent resume: step re-run with same from->to does not re-execute', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const loop = bindLoop({ sessionPath, identityHash: ID, stateDir });
  loop.transition({ from: 'ACCEPTED', to: 'ROUTED', reason: 'seed' });
  let n = 0;
  const r1 = await loop.step({ name: 'route', from: 'ROUTED', to: 'EXECUTING', run: () => { n += 1; return { ok: true, value: { executorKind: 'x' } }; } });
  assert.ok(r1.ok);
  const r2 = await loop.step({ name: 'route', from: 'ROUTED', to: 'EXECUTING', run: () => { n += 1; return { ok: true, value: { executorKind: 'x' } }; } });
  assert.ok(r2.ok);
  assert.equal(r2.result.resumed, true);
  assert.equal(n, 1);
});

test('I. identity mismatch: runControlLoop refuses to run on foreign taskId', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { taskId: 'someone-else/repo#1', repo: 'someone-else/repo', issueNumber: 1 });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: {} });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'IDENTITY_MISMATCH');
});

test('J. already-terminal session: runControlLoop refuses', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { state: 'COMPLETED' });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: {} });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'ALREADY_TERMINAL');
});

test('K. adapter throwing -> STEP_THREW + BLOCKED side-transition, no terminalize', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const deps = {
    router: () => { throw new Error('boom'); },
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'ROUTE_FAILED');
  const records = readTransitions({ stateDir, identityHash: ID });
  const last = records[records.length - 1];
  assert.equal(last.to, 'BLOCKED');
  assert.equal(last.reason, 'route:THREW');
});

// ---- READY_FOR_REVIEW notification obligation (review round-2 blocker) -----

function spawnOk(calls) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, input: JSON.parse(String(opts.input).trim()) });
    return { stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 901 })}\n` };
  };
}

function happyDeps(overrides = {}) {
  return {
    router: () => ({ ok: true, value: { executorKind: 'opencode', model: 'x' } }),
    executor: () => ({ ok: true, value: { executionRecordPath: '/fake/execution.json' } }),
    verifier: () => ({ ok: true, value: { verdict: 'PASS', report: 'ok' } }),
    preReview: () => ({ ok: true, value: { verdict: 'PASS', findings: [] } }),
    finalReview: () => ({ ok: true, value: { verdict: 'PASS', findings: [] } }),
    reviewReadyDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rr-')), // empty: no packet, deterministic
    ...overrides,
  };
}

test('L. READY_FOR_REVIEW obligation: absent/failed evidence blocks COMPLETED; delivered evidence continues', async () => {
  // (a) Transport present but no config (NOT_ATTEMPTED, nothing reached the
  // network) and no prior ledger evidence -> obligation fails closed.
  const sdA = mkStateDir();
  const a = mkSession(sdA);
  const resA = await runControlLoop({
    sessionPath: a.sessionPath, identityHash: a.id, stateDir: sdA,
    deps: happyDeps({
      telegramSpawn: () => ({ stdout: `${JSON.stringify({ ok: false, status: 'NOT_ATTEMPTED', reason: 'TELEGRAM_CONFIG_UNAVAILABLE' })}\n` }),
    }),
  });
  assert.equal(resA.ok, false, JSON.stringify(resA));
  assert.equal(resA.code, 'DELIVER_FAILED');
  // The boundary transition happened, but COMPLETED never did.
  const recsA = readTransitions({ stateDir: sdA, identityHash: a.id });
  const lastA = recsA[recsA.length - 1];
  assert.equal(lastA.from, 'DECIDING');
  assert.equal(lastA.to, 'DELIVERING');
  assert.ok(!recsA.some((r) => r.to === 'COMPLETED'), 'must not continue to COMPLETED without evidence');
  const rec = JSON.parse(fs.readFileSync(a.sessionPath, 'utf8'));
  assert.equal(rec.state, 'SESSION_ACTIVE', 'session must stay non-terminal when the notification obligation is unsatisfied');

  // (b) Transport dead (spawn throws) -> DELIVER_FAILED, still no terminalize.
  const sdB = mkStateDir();
  const b = mkSession(sdB);
  const resB = await runControlLoop({
    sessionPath: b.sessionPath, identityHash: b.id, stateDir: sdB,
    deps: happyDeps({ telegramSpawn: () => { throw new Error('ETIMEDOUT'); } }),
  });
  assert.equal(resB.ok, false);
  assert.equal(resB.code, 'DELIVER_FAILED');
  assert.equal(JSON.parse(fs.readFileSync(b.sessionPath, 'utf8')).state, 'SESSION_ACTIVE');
});

test('L2. delivered evidence: loop dispatches on boundary, one send, ledger persists message identity', async () => {
  const sdC = mkStateDir();
  const c = mkSession(sdC);
  const calls = [];
  const resC = await runControlLoop({
    sessionPath: c.sessionPath, identityHash: c.id, stateDir: sdC,
    deps: happyDeps({ telegramSpawn: spawnOk(calls) }),
  });
  assert.equal(resC.ok, true, JSON.stringify(resC));
  assert.equal(resC.value.state, 'COMPLETED');
  assert.equal(calls.length, 1, 'exactly one worker send attempt');
  assert.ok(calls[0].input.text.includes('READY_FOR_REVIEW'));
  const recsC = readTransitions({ stateDir: sdC, identityHash: c.id });
  const boundary = recsC.find((r) => r.from === 'DECIDING' && r.to === 'DELIVERING');
  assert.ok(boundary, 'boundary transition is appended BEFORE the notification side-effect');
  assert.equal(recsC[recsC.length - 1].to, 'COMPLETED');
  assert.equal(recsC[recsC.length - 1].reason, 'notification-evidence-ok');
  // The dispatch ledger persisted the delivery result with message identity.
  const ledger = fs.readFileSync(path.join(sdC, 'telegram-dispatch', `${c.id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(ledger.some((r) => r.event === 'READY_FOR_REVIEW' && r.status === 'API_ACCEPTED' && r.messageId === 901));
});

test('L3. canonical review packet travels with the READY_FOR_REVIEW dispatch', async () => {
  const sdD = mkStateDir();
  const d = mkSession(sdD);
  const rrDir = path.join(sdD, 'review-ready');
  fs.mkdirSync(rrDir, { recursive: true });
  const packetFile = path.join(rrDir, 'duongpdddic-droid_Soc_brain_Issue-69_PR-70_9b480da_review-ready.md');
  fs.writeFileSync(packetFile, '# Review Ready — 69/70 @ 9b480da\n', 'utf8');
  const calls = [];
  const resD = await runControlLoop({
    sessionPath: d.sessionPath, identityHash: d.id, stateDir: sdD,
    deps: happyDeps({ reviewReadyDir: rrDir, telegramSpawn: spawnOk(calls) }),
  });
  assert.equal(resD.ok, true, JSON.stringify(resD));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.documentPath, packetFile, 'worker receives the canonical packet as documentPath');
  assert.ok(calls[0].input.caption.includes('READY_FOR_REVIEW'));
  assert.equal(resD.value.notification.packet, path.basename(packetFile));
});

test('M. retry/re-entry does not duplicate: ledger API_ACCEPTED dedupes with zero sends', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  // Seed the ledger with terminal API_ACCEPTED evidence (as if a previous
  // loop entry already delivered the notification).
  const dp = path.join(stateDir, 'telegram-dispatch', `${ID}.jsonl`);
  fs.mkdirSync(path.dirname(dp), { recursive: true });
  const seed = { schemaVersion: '2', at: new Date().toISOString(), event: 'READY_FOR_REVIEW', identityHash: ID, taskId: 'duongpdddic-droid/soc_brain#69', repo: 'duongpdddic-droid/soc_brain', issueNumber: 69, status: 'API_ACCEPTED', messageId: 555, chatId: 42, error: null, phase: 'result', attemptN: 1 };
  fs.writeFileSync(dp, `${JSON.stringify(seed)}\n`, 'utf8');

  const calls = [];
  const res = await runControlLoop({
    sessionPath, identityHash: ID, stateDir,
    deps: happyDeps({
      telegramSpawn: (cmd, args, opts) => { calls.push(opts && opts.input); return { stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 999 })}\n` }; },
    }),
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  assert.equal(calls.length, 0, 're-entry must NOT re-send: zero transport attempts');
  const ledger = fs.readFileSync(dp, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const rrf = ledger.filter((r) => r.event === 'READY_FOR_REVIEW');
  assert.equal(rrf.length, 1, 'no new dispatch records for the deduped event');
  assert.equal(rrf[0].messageId, 555);
});

test('O. real executor value threads executionRecordPath into the verifier context (P0-A)', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  let seenByVerifier = null;
  const recPath = 'C:/state/executions/rec.json';
  const deps = {
    router: () => ({ ok: true, value: { executorKind: 'opencode', model: 'x' } }),
    executor: () => ({ ok: true, value: { executionStatus: 'EXITED', terminalStatus: 'EXITED', reason: null, executionRecordPath: recPath } }),
    verifier: (ctx) => { seenByVerifier = ctx; return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: () => ({ ok: true, value: { verdict: 'PASS', findings: [] } }),
    finalReview: () => ({ ok: true, value: { verdict: 'PASS', findings: [] } }),
    reviewReadyDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rr-')),
    telegramSpawn: spawnOk([]),
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(seenByVerifier.executionRecordPath, recPath, 'verifier receives the canonical execution record path from the executor value');
  const recs = readTransitions({ stateDir, identityHash: ID });
  const execRec = recs.find((r) => r.from === 'EXECUTING' && r.to === 'VERIFYING');
  assert.equal(execRec.evidence.executionRecordPath, recPath, 'transition evidence carries the executor result value');
});

test('N. REWORK/BLOCKED verdicts never trigger the READY_FOR_REVIEW notification', async () => {
  const spawnCalls = [];
  const spawnProbe = (cmd, args, opts) => { spawnCalls.push(JSON.parse(String(opts.input).trim())); return { stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 1 })}\n` }; };

  const sdR = mkStateDir();
  const r = mkSession(sdR);
  const resR = await runControlLoop({
    sessionPath: r.sessionPath, identityHash: r.id, stateDir: sdR,
    deps: happyDeps({ finalReview: () => ({ ok: true, value: { verdict: 'REWORK', findings: ['f'] } }), telegramSpawn: spawnProbe }),
  });
  assert.equal(resR.ok, true);
  assert.equal(resR.value.state, 'REWORK');
  assert.equal(spawnCalls.length, 0);

  const sdB = mkStateDir();
  const b = mkSession(sdB);
  const resB = await runControlLoop({
    sessionPath: b.sessionPath, identityHash: b.id, stateDir: sdB,
    deps: happyDeps({ finalReview: () => ({ ok: true, value: { verdict: 'BLOCKED', findings: ['x'] } }), telegramSpawn: spawnProbe }),
  });
  assert.equal(resB.ok, true);
  assert.equal(resB.value.state, 'BLOCKED');
  assert.equal(spawnCalls.length, 0, 'no READY_FOR_REVIEW dispatch outside the DELIVERING boundary');
});





