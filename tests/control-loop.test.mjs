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
import { deterministicVerifierAdapter } from '../packages/control-loop/adapters.mjs';
import { resolveGptFinalTimeoutMs } from '../packages/control-loop/gpt-final-review.mjs';

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cl-test-')); }

// P0-F canonical-delivery fixture constants (canonical session shape).
const HEAD = 'a'.repeat(40);
const BASE = 'f'.repeat(40);
const WORKTREES_ROOT = path.join(os.tmpdir(), 'cl-wt-root');

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
    headSha: HEAD,
    baseSha: BASE,
    worktreePath: path.join(WORKTREES_ROOT, `issue-${issueNumber}`),
    worktreesRoot: WORKTREES_ROOT,
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

test('D. runControlLoop REWORK verdict: dispatches the rework leg, never terminalizes on the verdict', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir } });
  const execPath = path.join(stateDir, 'executions', `${ID}.json`);
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.writeFileSync(execPath, JSON.stringify({ schemaVersion: '1', kind: 'ExecutionRecord', identityHash: ID, taskId: 'duongpdddic-droid/soc_brain#69', repo: 'duongpdddic-droid/soc_brain', issueNumber: 69, terminalStatus: 'ok', exitCode: 0 }, null, 2), 'utf8');
  const calls = [];
  const rw = { verdict: 'REWORK', findings: ['f1'], evidenceRequests: [], confidence: 0.8, metadata: {}, binding: { repository: 'duongpdddic-droid/soc_brain', issue: 69, headSha: 'a'.repeat(40) } };
  const pass = { verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.99, metadata: {} };
  let n = 0;
  const deps = {
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: (ctx) => { calls.push(ctx.reworkInstruction ? 'executor:rework' : 'executor'); return { ok: true, value: { executionRecordPath: execPath } }; },
    verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    finalReview: () => { calls.push('finalReview'); n += 1; return { ok: true, value: n === 1 ? rw : pass }; },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
    telegramSpawn: () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 900 })}\n` }),
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  // The REWORK verdict itself never terminalizes: the loop re-dispatches the
  // SAME executor authority and only the round-2 PASS completes delivery.
  assert.equal(res.value.state, 'COMPLETED');
  assert.deepEqual(calls, ['router', 'executor', 'verifier', 'preReview', 'finalReview', 'executor:rework', 'verifier', 'preReview', 'finalReview', 'delivery']);
  const records = readTransitions({ stateDir, identityHash: ID });
  assert.ok(records.some((r) => r.from === 'DECIDING' && r.to === 'REWORK' && r.reason === 'final-review-rework'));
  assert.equal(records.filter((r) => r.from === 'REWORK' && r.to === 'EXECUTING').length, 1);
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
    delivery: () => ({ ok: true, value: { shipped: true } }),
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
  // P0-F: the DELIVERING->COMPLETED boundary now rides the canonical delivery
  // step (loop.step), so the boundary record's reason is the step name, not a
  // notification-only reason string.
  assert.ok(recsC[recsC.length - 1].from === 'DELIVERING');
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
    delivery: () => ({ ok: true, value: { shipped: true } }),
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

// P0-B (Issue #73): the real deterministic verifier primitive consumes the
// executor-produced canonical execution record through runControlLoop.
test('P. real deterministic verifier: PASS evidence threads the loop; failing evidence never reaches reviewers', async () => {
  const verifierDeps = (recPath) => ({
    router: () => ({ ok: true, value: { executorKind: 'opencode', model: 'x' } }),
    executor: () => ({ ok: true, value: { executionStatus: 'EXITED', terminalStatus: 'EXITED', reason: null, executionRecordPath: recPath } }),
    verifier: deterministicVerifierAdapter(),
    preReview: () => ({ ok: true, value: { verdict: 'PASS', findings: [] } }),
    finalReview: () => ({ ok: true, value: { verdict: 'PASS', findings: [] } }),
    delivery: () => ({ ok: true, value: { shipped: true } }),
    reviewReadyDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rr-')),
    telegramSpawn: spawnOk([]),
  });
  const writeRec = (stateDir, s, terminalStatus, exitCode, finishedAt) => {
    const recPath = path.join(stateDir, 'executions', `${s.id}.json`);
    fs.mkdirSync(path.dirname(recPath), { recursive: true });
    fs.writeFileSync(recPath, JSON.stringify({
      schemaVersion: '1', kind: 'ExecutionRecord', identityHash: s.id,
      taskId: s.session.taskId, repo: s.session.repo, issueNumber: s.session.issueNumber,
      baseSha: s.session.baseSha, branch: 'agent/test', worktreePath: s.session.worktreePath,
      executor: 'opencode', executable: 'opencode', model: null, pid: 1,
      startedAt: new Date().toISOString(), finishedAt, exitCode, signal: null,
      terminalStatus, reason: null, instructionDigest: 'd'.repeat(64), instructionBytes: 4,
      sessionId: null, eventsPath: recPath.replace(/\.json$/, '.events.jsonl'), eventsOverflow: false,
    }), 'utf8');
    return recPath;
  };
  const loopSession = (stateDir) => mkSession(stateDir, {
    controlPlane: { stateDir }, baseSha: 'c'.repeat(40), worktreePath: stateDir,
  });

  // Scenario 1: a still-running (non-terminal) record -> verify fails closed,
  // the loop never crosses to PRE_REVIEWING and never terminalizes.
  const sd1 = mkStateDir();
  const s1 = loopSession(sd1);
  const rec1 = writeRec(sd1, s1, null, null, null);
  const res1 = await runControlLoop({ sessionPath: s1.sessionPath, identityHash: s1.id, stateDir: sd1, deps: verifierDeps(rec1) });
  assert.equal(res1.ok, false);
  assert.equal(res1.code, 'VERIFY_FAILED');
  const recs1 = readTransitions({ stateDir: sd1, identityHash: s1.id });
  assert.equal(recs1.some((r) => r.to === 'PRE_REVIEWING'), false, 'unverified execution must not reach reviewers');
  assert.equal(recs1.some((r) => r.to === 'COMPLETED'), false);
  const sess1 = JSON.parse(fs.readFileSync(s1.sessionPath, 'utf8'));
  assert.notEqual(sess1.state, 'COMPLETED', 'verifier never terminalizes');

  // Scenario 2: canonical EXITED/0 record -> PASS with structured deterministic
  // evidence in the transition ledger; loop completes the full chain.
  const sd2 = mkStateDir();
  const s2 = loopSession(sd2);
  const rec2 = writeRec(sd2, s2, 'EXITED', 0, new Date().toISOString());
  const res2 = await runControlLoop({ sessionPath: s2.sessionPath, identityHash: s2.id, stateDir: sd2, deps: verifierDeps(rec2) });
  assert.equal(res2.ok, true, JSON.stringify(res2));
  assert.equal(res2.value.state, 'COMPLETED');
  const recs2 = readTransitions({ stateDir: sd2, identityHash: s2.id });
  const vRec = recs2.find((r) => r.from === 'VERIFYING' && r.to === 'PRE_REVIEWING');
  assert.ok(vRec, 'verify boundary transition recorded');
  assert.equal(vRec.evidence.verdict, 'PASS');
  assert.equal(vRec.evidence.evidence.exitCode, 0);
  assert.equal(vRec.evidence.evidence.executionRecordPath, rec2);
});

test('N. REWORK/BLOCKED verdicts never trigger the READY_FOR_REVIEW notification', async () => {
  const spawnCalls = [];
  const spawnProbe = (cmd, args, opts) => { spawnCalls.push(JSON.parse(String(opts.input).trim())); return { stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 1 })}\n` }; };

  const sdR = mkStateDir();
  const r = mkSession(sdR, { controlPlane: { stateDir: sdR } });
  const execR = path.join(sdR, 'executions', `${r.id}.json`);
  fs.mkdirSync(path.dirname(execR), { recursive: true });
  fs.writeFileSync(execR, JSON.stringify({ schemaVersion: '1', kind: 'ExecutionRecord', identityHash: r.id, taskId: r.session.taskId, repo: r.session.repo, issueNumber: r.session.issueNumber, terminalStatus: 'ok', exitCode: 0 }, null, 2), 'utf8');
  const rw = { verdict: 'REWORK', findings: ['f'], evidenceRequests: [], confidence: 0.8, metadata: {}, binding: { repository: 'duongpdddic-droid/soc_brain', issue: 69, headSha: 'a'.repeat(40) } };
  const pass = { verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.99, metadata: {} };
  let n = 0;
  const resR = await runControlLoop({
    sessionPath: r.sessionPath, identityHash: r.id, stateDir: sdR,
    deps: happyDeps({
      executor: (ctx) => ({ ok: true, value: { executionRecordPath: execR } }),
      finalReview: () => { n += 1; return { ok: true, value: n === 1 ? rw : pass }; },
      telegramSpawn: spawnProbe,
    }),
  });
  // A REWORK verdict drives the re-dispatch leg — the notification obligation
  // fires ONLY after the round-2 PASS reaches the DELIVERING boundary; the
  // REWORK verdict itself never dispatched READY_FOR_REVIEW.
  assert.equal(resR.ok, true, JSON.stringify(resR));
  assert.equal(resR.value.state, 'COMPLETED');
  assert.equal(spawnCalls.length, 1, 'exactly one READY_FOR_REVIEW dispatch, after the rework leg');

  const sdB = mkStateDir();
  const b = mkSession(sdB);
  const beforeBlocked = spawnCalls.length;
  const resB = await runControlLoop({
    sessionPath: b.sessionPath, identityHash: b.id, stateDir: sdB,
    deps: happyDeps({ finalReview: () => ({ ok: true, value: { verdict: 'BLOCKED', findings: ['x'] } }), telegramSpawn: spawnProbe }),
  });
  assert.equal(resB.ok, true);
  assert.equal(resB.value.state, 'BLOCKED');
  assert.equal(spawnCalls.length, beforeBlocked, 'no READY_FOR_REVIEW dispatch outside the DELIVERING boundary');
});

// Issue #110: VERIFYING/PRE_REVIEWING ledger-tail resume (interrupted run).
// Route and execute must NEVER re-run for these tails; the walk re-enters at
// the SAME step invocation the normal path uses and continues to decide().
// An EXECUTING tail (mid-round rework crash) still fails closed at route.
function seedLedger(sessionPath, stateDir, ID, records) {
  const loop = bindLoop({ sessionPath, identityHash: ID, stateDir });
  for (const r of records) {
    const t = loop.transition({ from: r.from, to: r.to, reason: r.reason || 'seed', evidence: r.evidence ?? null });
    assert.ok(t.ok, `seed ${r.from}->${r.to}`);
  }
}

test('Q1. VERIFYING-tail resume: route/executor never re-run, walk re-enters at verify, reaches DECIDING', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  seedLedger(sessionPath, stateDir, ID, [
    { from: 'ACCEPTED', to: 'ROUTED' },
    { from: 'ROUTED', to: 'EXECUTING', evidence: { executorKind: 'opencode', model: 'x' } },
    { from: 'EXECUTING', to: 'VERIFYING', evidence: { executionRecordPath: '/fake/exec.json' } },
  ]);
  const calls = [];
  let seenPath;
  const deps = {
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: '/fake/exec.json' } }; },
    verifier: (ctx) => { calls.push('verifier'); seenPath = ctx.executionRecordPath; return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'BLOCKED', findings: [] } }; },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(calls, ['verifier', 'preReview', 'finalReview'], 'route/executor NEVER re-run on a VERIFYING tail');
  assert.equal(seenPath, '/fake/exec.json', 'verify re-enters with the ledger execution read-back evidence');
  const tos = readTransitions({ stateDir, identityHash: ID }).map((r) => r.to);
  assert.ok(tos.includes('DECIDING'), 'tail resume reaches DECIDING');
});

test('Q2. PRE_REVIEWING-tail resume: verify never re-runs (report from ledger), reaches DECIDING', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  seedLedger(sessionPath, stateDir, ID, [
    { from: 'ACCEPTED', to: 'ROUTED' },
    { from: 'ROUTED', to: 'EXECUTING', evidence: { executorKind: 'opencode', model: 'x' } },
    { from: 'EXECUTING', to: 'VERIFYING', evidence: { executionRecordPath: '/fake/exec.json' } },
    { from: 'VERIFYING', to: 'PRE_REVIEWING', evidence: { verdict: 'PASS', report: 'ok' } },
  ]);
  const calls = [];
  const deps = {
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: '/fake/exec.json' } }; },
    verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: (ctx) => { calls.push('preReview'); assert.deepEqual(ctx.report, { verdict: 'PASS', report: 'ok' }); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'BLOCKED', findings: [] } }; },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(calls, ['preReview', 'finalReview'], 'verify NEVER re-runs on a PRE_REVIEWING tail');
  const tos = readTransitions({ stateDir, identityHash: ID }).map((r) => r.to);
  assert.ok(tos.includes('DECIDING'), 'tail resume reaches DECIDING');
});

// Issue #114 item 1: the EXECUTING->VERIFYING evidence on a VERIFYING tail may
// be the fresh-walk shape ({executionRecordPath, ...}) OR the rework-leg shape
// ({verdict, evidence:{executionRecordPath, ...}}) — rework rounds write the
// verifier capture-'value' result under the same transition. Resume must
// extract the path from BOTH shapes (no EXECUTION_RECORD_MISSING).
function writeCanonicalExecRecord(stateDir, s) {
  const recPath = path.join(stateDir, 'executions', `${s.id}.json`);
  fs.mkdirSync(path.dirname(recPath), { recursive: true });
  fs.writeFileSync(recPath, JSON.stringify({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: s.id,
    taskId: s.session.taskId, repo: s.session.repo, issueNumber: s.session.issueNumber,
    baseSha: s.session.baseSha, branch: 'agent/test', worktreePath: s.session.worktreePath,
    executor: 'opencode', executable: 'opencode', model: null, pid: 1,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0, signal: null,
    terminalStatus: 'EXITED', reason: null, instructionDigest: 'd'.repeat(64), instructionBytes: 4,
    sessionId: null, eventsPath: recPath.replace(/\.json$/, '.events.jsonl'), eventsOverflow: false,
  }), 'utf8');
  return recPath;
}

function resumeDeps(calls) {
  const deterministicVerifier = deterministicVerifierAdapter();
  return {
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: '/fake/exec.json' } }; },
    // Q4 asserts the verify step re-runs on a VERIFYING-tail resume, so the
    // deterministic verifier (real canonical ExecutionRecord read-back) is
    // wrapped to record the call — the raw adapter records nothing.
    verifier: (ctx) => { calls.push('verifier'); return deterministicVerifier(ctx); },
    preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'BLOCKED', findings: [] } }; },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
  };
}

test('Q4. VERIFYING-tail resume: rework-verify evidence shape (nested path) and fresh-walk shape both resume verify', async () => {
  // (a) rework-leg shape: EXECUTING->VERIFYING evidence = verifier
  // capture-'value' result ({verdict, evidence:{executionRecordPath, ...}}).
  const sd1 = mkStateDir();
  const s1 = mkSession(sd1, { controlPlane: { stateDir: sd1 }, baseSha: 'c'.repeat(40), worktreePath: sd1 });
  const rec1 = writeCanonicalExecRecord(sd1, s1);
  seedLedger(s1.sessionPath, sd1, s1.id, [
    { from: 'ACCEPTED', to: 'ROUTED' },
    { from: 'ROUTED', to: 'EXECUTING', evidence: { executorKind: 'opencode', model: 'x' } },
    { from: 'EXECUTING', to: 'VERIFYING', evidence: { verdict: 'PASS', evidence: { executionRecordPath: rec1, exitCode: 0 } } },
  ]);
  const calls1 = [];
  const res1 = await runControlLoop({
    sessionPath: s1.sessionPath, identityHash: s1.id, stateDir: sd1, deps: resumeDeps(calls1),
  });
  assert.equal(res1.ok, true, JSON.stringify(res1));
  assert.deepEqual(calls1, ['verifier', 'preReview', 'finalReview'], 'route/executor never re-run on a VERIFYING tail');
  const tos1 = readTransitions({ stateDir: sd1, identityHash: s1.id }).map((r) => r.to);
  assert.ok(tos1.includes('PRE_REVIEWING') && tos1.includes('DECIDING'), 'nested rework-verify path resumes verify, no EXECUTION_RECORD_MISSING');

  // (b) fresh-walk shape (flat executionRecordPath) still resumes.
  const sd2 = mkStateDir();
  const s2 = mkSession(sd2, { controlPlane: { stateDir: sd2 }, baseSha: 'c'.repeat(40), worktreePath: sd2 });
  const rec2 = writeCanonicalExecRecord(sd2, s2);
  seedLedger(s2.sessionPath, sd2, s2.id, [
    { from: 'ACCEPTED', to: 'ROUTED' },
    { from: 'ROUTED', to: 'EXECUTING', evidence: { executorKind: 'opencode', model: 'x' } },
    { from: 'EXECUTING', to: 'VERIFYING', evidence: { executionStatus: 'EXITED', terminalStatus: 'EXITED', executionRecordPath: rec2 } },
  ]);
  const calls2 = [];
  const res2 = await runControlLoop({
    sessionPath: s2.sessionPath, identityHash: s2.id, stateDir: sd2, deps: resumeDeps(calls2),
  });
  assert.equal(res2.ok, true, JSON.stringify(res2));
  assert.deepEqual(calls2, ['verifier', 'preReview', 'finalReview'], 'fresh-walk shape still resumes verify');
  const tos2 = readTransitions({ stateDir: sd2, identityHash: s2.id }).map((r) => r.to);
  assert.ok(tos2.includes('PRE_REVIEWING') && tos2.includes('DECIDING'));
});

test('Q3. EXECUTING mid-round tail still fails closed at route, no new transition appended', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  seedLedger(sessionPath, stateDir, ID, [
    { from: 'ACCEPTED', to: 'ROUTED' },
    { from: 'ROUTED', to: 'EXECUTING', evidence: { executorKind: 'opencode', model: 'x' } },
    { from: 'EXECUTING', to: 'VERIFYING', evidence: { executionRecordPath: '/fake/exec.json' } },
    { from: 'VERIFYING', to: 'PRE_REVIEWING', evidence: { verdict: 'PASS', report: 'ok' } },
    { from: 'PRE_REVIEWING', to: 'FINAL_REVIEWING', evidence: { verdict: 'PASS', findings: [] } },
    { from: 'FINAL_REVIEWING', to: 'DECIDING', evidence: { verdict: 'REWORK' } },
    { from: 'DECIDING', to: 'REWORK', reason: 'final-review-rework' },
    { from: 'REWORK', to: 'EXECUTING', evidence: { executionRecordPath: '/fake/rework.json' } },
  ]);
  const calls = [];
  const deps = {
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: '/fake/exec.json' } }; },
    verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
  };
  const before = readTransitions({ stateDir, identityHash: ID });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'ROUTE_FAILED', 'EXECUTING tail fails closed at the route step');
  assert.deepEqual(calls, [], 'no adapter runs on a fail-closed EXECUTING tail');
  const after = readTransitions({ stateDir, identityHash: ID });
  assert.equal(after.length, before.length, 'fail-closed route leaves the ledger unmutated');
});

// Issue #114 item 2: bounded explicit retry for a recoverable verify failure.
// A VERIFYING->BLOCKED tail whose reason is the verify step's own
// side-transition ('verify:FAIL...') re-enters the SAME verify step invocation
// on resume (ONE attempt per relaunch, no auto-loop); every other BLOCKED
// tail stays fail-closed at route without mutation.
function verifyFailLedger(sessionPath, stateDir, ID, reason) {
  seedLedger(sessionPath, stateDir, ID, [
    { from: 'ACCEPTED', to: 'ROUTED' },
    { from: 'ROUTED', to: 'EXECUTING', evidence: { executorKind: 'opencode', model: 'x' } },
    { from: 'EXECUTING', to: 'VERIFYING', evidence: { executionRecordPath: '/fake/exec.json' } },
    { from: 'VERIFYING', to: 'BLOCKED', reason, evidence: { code: 'EXECUTION_RECORD_MISSING' } },
  ]);
}

test('Q5. verify:FAIL BLOCKED tail: resume re-enters verify once, reaches PRE_REVIEWING and DECIDING', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  verifyFailLedger(sessionPath, stateDir, ID, 'verify:FAIL');
  const calls = [];
  let seenPath;
  const deps = {
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: '/fake/exec.json' } }; },
    verifier: (ctx) => { calls.push('verifier'); seenPath = ctx.executionRecordPath; return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'BLOCKED', findings: [] } }; },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(calls, ['verifier', 'preReview', 'finalReview'], 'only the SAME verify step re-enters; route/executor never re-run');
  assert.equal(seenPath, '/fake/exec.json', 'retry re-enters verify with the ledger execution read-back evidence');
  const records = readTransitions({ stateDir, identityHash: ID });
  const failRecs = records.filter((r) => r.from === 'VERIFYING' && r.to === 'BLOCKED' && String(r.reason || '').startsWith('verify:FAIL'));
  assert.equal(failRecs.length, 1, 'the FAIL record stays in the append-only ledger');
  assert.ok(records.some((r) => r.from === 'VERIFYING' && r.to === 'PRE_REVIEWING'), 'retry success appends VERIFYING->PRE_REVIEWING');
  const tos = records.map((r) => r.to);
  assert.ok(tos.includes('PRE_REVIEWING') && tos.includes('DECIDING'));
});

test('Q6. verify retry that fails again appends a second VERIFYING->BLOCKED record, no fake success', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  verifyFailLedger(sessionPath, stateDir, ID, 'verify:FAIL');
  const calls = [];
  const deps = {
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: '/fake/exec.json' } }; },
    verifier: () => { calls.push('verifier'); return { ok: false, code: 'EXECUTION_RECORD_MISSING' }; },
    preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'VERIFY_FAILED');
  const records = readTransitions({ stateDir, identityHash: ID });
  const failRecs = records.filter((r) => r.from === 'VERIFYING' && r.to === 'BLOCKED' && String(r.reason || '').startsWith('verify:FAIL'));
  assert.equal(failRecs.length, 2, 'history preserved: the retry failure side-transitions BLOCKED again');
  assert.equal(records.some((r) => r.to === 'PRE_REVIEWING'), false, 'no fake success');
  const sess = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(sess.state, 'SESSION_ACTIVE', 'no terminalize on a failed retry');
});

// Issue #116 item 1: FINAL_REVIEWING->BLOCKED 'finalReview:FAIL' tail resume
// (same recovery class as the #114 verify:FAIL tail). The tail re-obtains the
// final review ONCE via the SAME finalReview step invocation (retryOnOwnFail),
// then enters the decision policy; every other BLOCKED shape stays fail-closed
// at route with no mutation.
function finalReviewFailLedger(sessionPath, stateDir, ID, reason, from = 'FINAL_REVIEWING') {
  seedLedger(sessionPath, stateDir, ID, [
    { from: 'ACCEPTED', to: 'ROUTED' },
    { from: 'ROUTED', to: 'EXECUTING', evidence: { executorKind: 'opencode', model: 'x' } },
    { from: 'EXECUTING', to: 'VERIFYING', evidence: { executionRecordPath: '/fake/exec.json' } },
    { from: 'VERIFYING', to: 'PRE_REVIEWING', evidence: { verdict: 'PASS', report: 'ok' } },
    { from: 'PRE_REVIEWING', to: 'FINAL_REVIEWING', evidence: { verdict: 'PASS', findings: [] } },
    { from, to: 'BLOCKED', reason, evidence: { code: 'GPT_TRANSPORT_TIMEOUT' } },
  ]);
}

test('Q8. finalReview:FAIL BLOCKED tail: review re-obtained exactly once, loop reaches DECIDING', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  finalReviewFailLedger(sessionPath, stateDir, ID, 'finalReview:FAIL');
  const calls = [];
  const deps = {
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: '/fake/exec.json' } }; },
    verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'BLOCKED', findings: [] } }; },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'BLOCKED', 're-obtained verdict is consumed by the decision policy');
  assert.deepEqual(calls, ['finalReview'], 'route/executor/verify/preReview never re-run; review re-obtained exactly once');
  const records = readTransitions({ stateDir, identityHash: ID });
  assert.equal(records.filter((r) => r.from === 'FINAL_REVIEWING' && r.to === 'BLOCKED' && String(r.reason || '').startsWith('finalReview:FAIL')).length, 1, 'the own-FAIL record stays in the append-only ledger');
  assert.ok(records.some((r) => r.from === 'FINAL_REVIEWING' && r.to === 'DECIDING'), 'resume reaches DECIDING');
  assert.equal(records[records.length - 1].to, 'BLOCKED');
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'BLOCKED');
});

test('Q9. BLOCKED tail with a different reason/from stays fail-closed at route, no new transition', async () => {
  for (const [from, reason] of [['FINAL_REVIEWING', 'preReview:FAIL'], ['VERIFYING', 'finalReview:FAIL']]) {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    finalReviewFailLedger(sessionPath, stateDir, ID, reason, from);
    const calls = [];
    const deps = {
      router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
      executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: '/fake/exec.json' } }; },
      verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
      preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
      finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
      delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
    };
    const before = readTransitions({ stateDir, identityHash: ID });
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
    assert.equal(res.ok, false, `${from}->BLOCKED ${reason}`);
    assert.equal(res.code, 'ROUTE_FAILED', 'a non-finalReview:FAIL BLOCKED tail stays fail-closed at route');
    assert.deepEqual(calls, [], 'no adapter runs on a fail-closed BLOCKED tail');
    const after = readTransitions({ stateDir, identityHash: ID });
    assert.equal(after.length, before.length, 'no new transition appended');
  }
});

// Issue #116 item 2: the hard GPT final-review timeout (300000 default) is
// overridable via SOC_GPT_FINAL_TIMEOUT_MS; ONLY integer > 0 is honored —
// invalid/unset/zero/negative/Infinity fall back to the default (never 0 or
// Infinity reaches the transport race).
test('R. SOC_GPT_FINAL_TIMEOUT_MS env override: valid integer wins, everything else -> default', () => {
  const env = (v) => (v === undefined ? {} : { SOC_GPT_FINAL_TIMEOUT_MS: v });
  assert.equal(resolveGptFinalTimeoutMs(env()), 300000, 'unset -> default');
  assert.equal(resolveGptFinalTimeoutMs(env('900000')), 900000, 'valid integer -> honored');
  assert.equal(resolveGptFinalTimeoutMs(env('abc')), 300000, 'non-numeric -> default');
  assert.equal(resolveGptFinalTimeoutMs(env('-5')), 300000, 'negative -> default');
  assert.equal(resolveGptFinalTimeoutMs(env('0')), 300000, 'zero -> default');
  assert.equal(resolveGptFinalTimeoutMs(env('2.5')), 300000, 'fractional -> default');
  assert.equal(resolveGptFinalTimeoutMs(env('Infinity')), 300000, 'Infinity -> default');
  assert.equal(resolveGptFinalTimeoutMs(env('')), 300000, 'empty string -> default');
});

test('Q7. a BLOCKED tail with a different reason stays fail-closed at route, ledger unmutated', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  verifyFailLedger(sessionPath, stateDir, ID, 'preReview:FAIL');
  const calls = [];
  const deps = {
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: '/fake/exec.json' } }; },
    verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
  };
  const before = readTransitions({ stateDir, identityHash: ID });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'ROUTE_FAILED', 'a non-verify:FAIL BLOCKED tail stays fail-closed at route');
  assert.deepEqual(calls, [], 'no adapter runs on a fail-closed BLOCKED tail');
  const after = readTransitions({ stateDir, identityHash: ID });
  assert.equal(after.length, before.length, 'no new transition appended');
});






