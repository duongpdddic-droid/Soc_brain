import { reviewFixture, persistedDecision } from './fixtures/web2api-review.mjs';
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
  ROUTE_RETRY_SUPPORTED_CODES,
  EXECUTE_INSTRUCTION_RETRY_LIMIT,
  recordPreSubmitBoundaryReconciled,
  readTransitions,
  bindLoop,
  runControlLoop,
  assertTerminalizationAuthorized,
  bindTerminalizeTokenToSession,
  recoverDecisionContract,
} from '../packages/control-loop/control-loop.mjs';
import { resolveRunnerInstruction, readPersistedRouteGoal } from '../bin/soc-control-loop.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { decisionDigest, buildReworkRecord } from '../packages/control-loop/rework.mjs';
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

// Issue #260: a DECIDING-tail resume must REPLAY the decision persisted at the
// FINAL_REVIEWING->DECIDING boundary — the reviewer is never re-asked (a
// second prompt for an already-answered round is a duplicate submit). The seed
// mirrors the exact ledger the fresh walk + one rework round leave behind
// (see control-loop-rework.test.mjs R5): the round-1 dispatch marker
// (DECIDING->REWORK immediately followed by REWORK->EXECUTING) is present and
// the tail sits at DECIDING with the round-2 decision persisted as evidence.
function resumeDepsWithDecision(calls, decision) {
  return {
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: '/fake/exec.json' } }; },
    verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    finalReview: () => { calls.push('finalReview'); return { ok: true, value: decision }; },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
  };
}

test('Q10. DECIDING-tail resume REPLAYS the persisted decision; the reviewer is never re-asked', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID, session } = mkSession(stateDir, { controlPlane: { stateDir } });
  // Complete canonical decision object (mirror of reworkDecision() in
  // control-loop-rework.test.mjs): binding echoes the pinned session identity.
  const decision = {
    verdict: 'REWORK',
    findings: ['fix-x'],
    evidenceRequests: [],
    confidence: 0.8,
    metadata: {},
    binding: { repository: session.repo, issue: session.issueNumber, headSha: HEAD },
  };
  const digest = decisionDigest({ identityHash: ID, decision });
  seedLedger(sessionPath, stateDir, ID, [
    { from: 'ACCEPTED', to: 'ROUTED' },
    { from: 'ROUTED', to: 'EXECUTING', evidence: { executorKind: 'opencode', model: 'x' } },
    { from: 'EXECUTING', to: 'VERIFYING', evidence: { executionRecordPath: '/fake/exec.json' } },
    { from: 'VERIFYING', to: 'PRE_REVIEWING', evidence: { verdict: 'PASS', report: 'ok' } },
    { from: 'PRE_REVIEWING', to: 'FINAL_REVIEWING', evidence: { verdict: 'PASS', findings: [] } },
    // Round-1 boundary decision + its dispatch marker (exactly-once guard).
    { from: 'FINAL_REVIEWING', to: 'DECIDING', evidence: decision },
    { from: 'DECIDING', to: 'REWORK', reason: 'final-review-rework', evidence: { digest, round: 1 } },
    { from: 'REWORK', to: 'EXECUTING', evidence: { executionRecordPath: '/fake/rework.json' } },
    // Round-2 walk interrupted after the boundary persisted the decision and
    // before decide() returned: the ledger tail is DECIDING.
    { from: 'EXECUTING', to: 'VERIFYING', evidence: { verdict: 'PASS', report: 'ok' } },
    { from: 'VERIFYING', to: 'PRE_REVIEWING', evidence: { verdict: 'PASS', report: 'ok' } },
    { from: 'PRE_REVIEWING', to: 'FINAL_REVIEWING', evidence: { verdict: 'PASS', findings: [] } },
    { from: 'FINAL_REVIEWING', to: 'DECIDING', evidence: decision },
  ]);
  const calls = [];
  const deps = resumeDepsWithDecision(calls, decision);
  const before = readTransitions({ stateDir, identityHash: ID });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'REWORK_ALREADY_DISPATCHED', 'the replayed decision deterministically hits the dispatch-marker guard');
  assert.ok(!calls.includes('finalReview'), 'DECIDING-tail resume must never re-ask the reviewer');
  assert.ok(!calls.includes('delivery'), 'a replayed REWORK decision never reaches delivery');
  assert.deepEqual(calls, [], 'no adapter runs when the persisted decision is replayed');
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE', 'session state unchanged');
  const after = readTransitions({ stateDir, identityHash: ID });
  assert.equal(after.length, before.length, 'the replay appends no transition (no duplicate FINAL_REVIEWING->DECIDING)');
});

test('Q11. DECIDING tail whose persisted evidence lacks a usable verdict -> DECIDING_RESUME_DECISION_MISSING', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir } });
  seedLedger(sessionPath, stateDir, ID, [
    { from: 'ACCEPTED', to: 'ROUTED' },
    { from: 'ROUTED', to: 'EXECUTING', evidence: { executorKind: 'opencode', model: 'x' } },
    { from: 'EXECUTING', to: 'VERIFYING', evidence: { executionRecordPath: '/fake/exec.json' } },
    { from: 'VERIFYING', to: 'PRE_REVIEWING', evidence: { verdict: 'PASS', report: 'ok' } },
    { from: 'PRE_REVIEWING', to: 'FINAL_REVIEWING', evidence: { verdict: 'PASS', findings: [] } },
    { from: 'FINAL_REVIEWING', to: 'DECIDING', evidence: { note: 'interrupted before any verdict was persisted' } },
  ]);
  const calls = [];
  const deps = resumeDepsWithDecision(calls, { verdict: 'REWORK', findings: [], evidenceRequests: [] });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'DECIDING_RESUME_DECISION_MISSING');
  assert.ok(!calls.includes('finalReview'), 'a malformed DECIDING tail never re-asks the reviewer');
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE', 'session state unchanged');
});

test('Q12. contract-stale DECIDING replay -> REVIEW_DECISION_FINDINGS_MISSING before any transition', async () => {
  // Issue #260 guard: a decision persisted by the PRE-FIX transport carries
  // verdict REWORK + metadata.findingsCount but never published the findings /
  // evidenceRequests arrays. The DECIDING-tail replay calls
  // decide({decision: persisted}) DIRECTLY (it never passes through the
  // runner's finalReview closure), so without the decide()-seam contract check
  // the decision would reach runReworkLeg -> buildReworkRecord and crash with
  // an untyped `TypeError: decision.findings is not iterable`. Fail CLOSED
  // with a typed code BEFORE any transition — never re-ask the reviewer,
  // never substitute `[]`.
  //
  // FIXTURE CHANGE (recovery regression, recoverDecisionContract): the
  // ORIGINAL fixture also carried a parseable `rawText`
  // ('Off-by-one in bounds.\nVERDICT: CHANGES_REQUESTED'). The DECIDING-tail
  // replay now legitimately RECOVERS the contract arrays in-memory from such
  // a rawText (that shape is covered by Q13/Q16), so a rawText-bearing stale
  // decision no longer reaches this typed guard by design. This test keeps
  // the UNRECOVERABLE variant (stale decision, NO rawText) so the typed
  // fail-closed proof stays covered. ALL assertions below are unchanged.
  const stateDir = mkStateDir();
  const { sessionPath, id: ID, session } = mkSession(stateDir, { controlPlane: { stateDir } });
  const staleEvidence = {
    verdict: 'REWORK',
    rationale: 'r',
    metadata: { findingsCount: 50 },
    binding: { repository: session.repo, issue: session.issueNumber, headSha: HEAD },
  };
  const seeded = [
    { from: 'ACCEPTED', to: 'ROUTED' },
    { from: 'ROUTED', to: 'EXECUTING', evidence: { executorKind: 'opencode', model: 'x' } },
    { from: 'EXECUTING', to: 'VERIFYING', evidence: { executionRecordPath: '/fake/exec.json' } },
    { from: 'VERIFYING', to: 'PRE_REVIEWING', evidence: { verdict: 'PASS', report: 'ok' } },
    { from: 'PRE_REVIEWING', to: 'FINAL_REVIEWING', evidence: { verdict: 'PASS', findings: [] } },
    // Tail = DECIDING with a contract-stale decision: NO findings, NO
    // evidenceRequests (pre-fix transport shape).
    { from: 'FINAL_REVIEWING', to: 'DECIDING', evidence: staleEvidence },
  ];
  seedLedger(sessionPath, stateDir, ID, seeded);
  const calls = [];
  const deps = resumeDepsWithDecision(calls, { verdict: 'REWORK', findings: ['x'], evidenceRequests: [] });
  const before = readTransitions({ stateDir, identityHash: ID });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'REVIEW_DECISION_FINDINGS_MISSING');
  assert.ok(!calls.includes('finalReview'), 'DECIDING replay must never re-ask the reviewer');
  assert.ok(!calls.includes('delivery'), 'a contract-stale REWORK decision never reaches delivery');
  assert.deepEqual(calls, [], 'no adapter runs when the persisted decision fails the contract check');
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE', 'session state unchanged');
  const after = readTransitions({ stateDir, identityHash: ID });
  assert.equal(after.length, before.length, 'the typed fail-closed fires before any transition');
  assert.equal(after.length, seeded.length, 'the ledger still has exactly the seeded number of records');
});

// Issue #260 recovery (recoverDecisionContract): a contract-stale decision
// ALREADY PERSISTED at the FINAL_REVIEWING->DECIDING boundary carries the
// reviewer's own rawText. The DECIDING-tail replay re-derives
// {findings, evidenceRequests, confidence} IN-MEMORY through the canonical
// seam (normalizeReviewDecision -> parseReviewVerdict -> buildParsedDecision),
// NEVER rewriting the ledger, and then deterministically hits the round-1
// dispatch-marker guard: the run gets PAST the contract guard without
// re-asking the reviewer and without a second dispatch.
test('Q13. contract-stale DECIDING replay RECOVERS the contract from its own rawText; reviewer never re-asked; ledger evidence untouched', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID, session } = mkSession(stateDir, { controlPlane: { stateDir }, prNumber: 263 });
  // Exact #260 stale shape: ok/verdict/rationale/rawText/metadata/binding/
  // advisorGuidance present, findings + evidenceRequests ABSENT.
  const staleEvidence = {
    ok: true,
    verdict: 'REWORK',
    rationale: 'The patch regresses bounds handling.',
    rawText: [
      'Finding 1: off-by-one in resolveRange (src/range.mjs:42).',
      'Finding 2: missing null guard before dereference (src/range.mjs:57).',
      'Finding 3: stale changelog entry for the API change.',
      '',
      'VERDICT: CHANGES_REQUESTED',
    ].join('\n'),
    metadata: { conversationId: null, modelSlug: null, pollTimeout: false, findingsCount: 3 },
    binding: { repository: session.repo, issue: session.issueNumber, headSha: HEAD },
    advisorGuidance: 'Fix the root cause in resolveRange, not the symptom.',
  };
  const fixture = reviewFixture({ session, findings: ['Finding 1: off-by-one.', 'Finding 2: null guard missing.', 'Finding 3: stale changelog entry.'] });
  Object.assign(staleEvidence, persistedDecision(fixture));
  delete staleEvidence.findings; delete staleEvidence.evidenceRequests; delete staleEvidence.remediation;
  // Recovery is deterministic, so the round-1 dispatch-marker digest is
  // computed by running the SAME recovery on a copy of the seeded evidence.
  const recovered = recoverDecisionContract({ decision: { ...staleEvidence }, session });
  assert.equal(Array.isArray(recovered.findings), true, 'recovery re-derives the findings array');
  assert.equal(recovered.findings.length, 3, 'all three Finding lines are re-derived');
  assert.equal(recovered.findings.length, staleEvidence.metadata.findingsCount, 'findings.length equals the persisted metadata.findingsCount');
  assert.equal(Array.isArray(recovered.evidenceRequests), true, 'evidenceRequests is the parser canonical []');
  assert.equal(recovered.verdict, staleEvidence.verdict, 'recovery never flips the verdict');
  const digest = decisionDigest({ identityHash: ID, decision: recovered });
  // Round-1 rework record exactly as the first (already completed) dispatch
  // persisted it: buildReworkRecord must succeed on the RECOVERED decision.
  const round1 = buildReworkRecord({ identityHash: ID, round: 1, digest, decision: recovered });
  const recDir = path.join(stateDir, 'control-loop', ID, 'rework');
  fs.mkdirSync(recDir, { recursive: true });
  fs.writeFileSync(path.join(recDir, `${digest}.json`), JSON.stringify(round1, null, 2), 'utf8');

  seedLedger(sessionPath, stateDir, ID, [
    { from: 'ACCEPTED', to: 'ROUTED' },
    { from: 'ROUTED', to: 'EXECUTING', evidence: { executorKind: 'opencode', model: 'x' } },
    { from: 'EXECUTING', to: 'VERIFYING', evidence: { executionRecordPath: '/fake/exec.json' } },
    { from: 'VERIFYING', to: 'PRE_REVIEWING', evidence: { verdict: 'PASS', report: 'ok' } },
    { from: 'PRE_REVIEWING', to: 'FINAL_REVIEWING', evidence: { verdict: 'PASS', findings: [] } },
    // Round-1: decision consumed and dispatched exactly once (marker pair).
    { from: 'FINAL_REVIEWING', to: 'DECIDING', evidence: { verdict: 'REWORK', findings: ['round-1'], evidenceRequests: [] } },
    { from: 'DECIDING', to: 'REWORK', reason: 'final-review-rework', evidence: { digest, round: 1 } },
    { from: 'REWORK', to: 'EXECUTING', evidence: { executionRecordPath: '/fake/rework.json' } },
    // Round-2 walk interrupted AFTER the boundary persisted the contract-
    // stale decision and BEFORE decide() returned: the ledger tail is
    // DECIDING (the #260 live shape).
    { from: 'EXECUTING', to: 'VERIFYING', evidence: { verdict: 'PASS', report: 'ok' } },
    { from: 'VERIFYING', to: 'PRE_REVIEWING', evidence: { verdict: 'PASS', report: 'ok' } },
    { from: 'PRE_REVIEWING', to: 'FINAL_REVIEWING', evidence: { verdict: 'PASS', findings: [] } },
    { from: 'FINAL_REVIEWING', to: 'DECIDING', evidence: staleEvidence },
  ]);
  const before = readTransitions({ stateDir, identityHash: ID });
  const seededTailJson = JSON.stringify(before[before.length - 1]);
  const calls = [];
  const deps = resumeDepsWithDecision(calls, { verdict: 'REWORK', findings: ['x'], evidenceRequests: [] });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });

  // The run got PAST the contract guard (recovery worked) and stopped at the
  // already-dispatched guard instead of dispatching again.
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'REWORK_ALREADY_DISPATCHED');
  assert.notEqual(res.code, 'REVIEW_DECISION_FINDINGS_MISSING');
  assert.ok(!calls.includes('finalReview'), 'DECIDING replay must never re-ask the reviewer');
  assert.deepEqual(calls, [], 'no adapter runs when the recovered decision hits the dispatch-marker guard');

  // Recovery is in-memory at read time ONLY: the seeded
  // FINAL_REVIEWING->DECIDING evidence (and the whole ledger) is
  // byte-identical after the run (JSON.stringify equality).
  const after = readTransitions({ stateDir, identityHash: ID });
  assert.equal(JSON.stringify(after[after.length - 1]), seededTailJson, 'the seeded DECIDING evidence is byte-identical after the run');
  assert.equal(JSON.stringify(after), JSON.stringify(before), 'recovery never rewrites the ledger');

  // The persisted rework record (built from the RECOVERED decision) carries
  // the real contract arrays.
  const persistedRec = JSON.parse(fs.readFileSync(path.join(recDir, `${digest}.json`), 'utf8'));
  assert.equal(Array.isArray(persistedRec.findings), true, 'rework record findings is an array');
  assert.ok(persistedRec.findings.length > 0, 'rework record findings is a non-empty array');
  assert.equal(Array.isArray(persistedRec.evidenceRequests), true, 'rework record evidenceRequests is an array');

  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE', 'session state unchanged');
});

// recoverDecisionContract unit matrix: narrow recovery, fail-closed, and it
// NEVER flips a verdict (neither REWORK -> PASS nor PASS -> REWORK).
test('Q14. recoverDecisionContract unit matrix: complete passes through, stale recovers, unverifiable stays untouched', () => {
  const session = { repo: 'duongpdddic-droid/soc_brain', issueNumber: 69, prNumber: 263, headSha: HEAD };
  const binding = { repository: session.repo, issue: session.issueNumber, headSha: HEAD };

  // (a) complete decision (both contract fields are arrays) -> returned
  // deep-equal to the input; no parse is attempted.
  const complete = {
    verdict: 'REWORK', findings: ['f1'], evidenceRequests: ['e1'], confidence: 0.7,
    metadata: { findingsCount: 1 }, binding, rationale: 'r',
  };
  assert.deepEqual(recoverDecisionContract({ decision: complete, session }), complete);

  // (b) stale + valid VERDICT rawText -> contract re-derived; every other
  // field passed through byte-for-byte; verdict unchanged.
  const stale = {
    ok: true,
    verdict: 'REWORK',
    rationale: 'the reviewer reply rationale',
    rawText: 'Finding 1: off-by-one.\nFinding 2: null guard missing.\nVERDICT: CHANGES_REQUESTED',
    metadata: { conversationId: null, modelSlug: null, pollTimeout: false, findingsCount: 2 },
    binding,
    advisorGuidance: 'fix the root cause',
  };
  const fixture = reviewFixture({ session, findings: ['Finding 1: off-by-one.', 'Finding 2: null guard missing.'] });
  Object.assign(stale, persistedDecision(fixture));
  delete stale.findings; delete stale.evidenceRequests; delete stale.remediation;
  const rec = recoverDecisionContract({ decision: stale, session });
  assert.notEqual(rec, stale, 'a stale decision is recovered into a NEW object');
  assert.equal(Array.isArray(rec.findings), true, 'findings is an array');
  assert.equal(rec.findings.length, 2, 'findings.length equals the parsed count');
  assert.equal(rec.findings[0], 'Finding 1: off-by-one.');
  assert.equal(rec.findings[1], 'Finding 2: null guard missing.');
  assert.equal(Array.isArray(rec.evidenceRequests), true, 'evidenceRequests is an array');
  assert.equal(rec.verdict, stale.verdict, 'verdict unchanged: CHANGES_REQUESTED still maps to REWORK');
  assert.equal(rec.confidence, null, 'documented VERDICT-text confidence: null');
  assert.equal(rec.rawText, stale.rawText, 'rawText byte-identical');
  assert.equal(rec.rationale, stale.rationale, 'rationale byte-identical');
  assert.deepEqual(rec.binding, stale.binding, 'binding deep-equal to the original (never re-stamped)');
  assert.equal(rec.advisorGuidance, stale.advisorGuidance, 'advisorGuidance byte-identical');
  assert.deepEqual(rec.metadata, stale.metadata, 'metadata deep-equal to the original');
  assert.equal(rec.findings.length, stale.metadata.findingsCount, 'recovered count matches persisted findingsCount');

  // (c) stale + unparseable rawText ('...') -> re-parse fails -> UNCHANGED.
  const unparseable = { verdict: 'REWORK', rationale: 'r', rawText: '...', metadata: { findingsCount: 0 }, binding };
  assert.deepEqual(recoverDecisionContract({ decision: unparseable, session }), unparseable);

  // (d) stale + NO rawText key -> nothing to recover from -> UNCHANGED.
  const noRaw = { verdict: 'REWORK', rationale: 'r', metadata: { findingsCount: 50 }, binding };
  assert.deepEqual(recoverDecisionContract({ decision: noRaw, session }), noRaw);

  // (e) verdict PASS but the rawText parses to REWORK -> UNCHANGED: recovery
  // NEVER flips a verdict (assert deep-equal AND the verdict itself).
  const flipped = {
    verdict: 'PASS', rationale: 'r',
    rawText: 'Finding 1: x\nVERDICT: CHANGES_REQUESTED',
    metadata: {}, binding,
  };
  const outE = recoverDecisionContract({ decision: flipped, session });
  assert.deepEqual(outE, flipped, 'a verdict-mismatched re-parse is rejected: input unchanged');
  assert.equal(outE.verdict, 'PASS', 'recovery never turns PASS into REWORK');

  // (f) wrong-type findings ('oops', a STRING) with no rawText -> UNCHANGED,
  // so the typed decide() guard (not an array spread) handles it.
  const wrongType = { verdict: 'REWORK', findings: 'oops', metadata: {}, binding };
  assert.deepEqual(recoverDecisionContract({ decision: wrongType, session }), wrongType);

  // Binding is never part of the merge: recovery passes the original binding
  // through untouched (the canonical assertReworkBinding gate owns rejection
  // of a wrong binding — see Q16).
  assert.deepEqual(rec.binding, { repository: session.repo, issue: 69, pullRequest: 263, headSha: HEAD });
});

// Issue #260 guard, wrong-type variant: findings is a STRING (not an array)
// and there is NO rawText to recover from -> recovery passes the decision
// through unchanged, so the decide() typed contract check fires. The run
// returns a DETERMINISTIC code — never a TypeError from spreading a
// string/undefined — and no adapter (delivery/executor) ever runs.
test('Q15. DECIDING tail with wrong-type findings and no rawText -> typed REVIEW_DECISION_FINDINGS_MISSING, never TypeError', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID, session } = mkSession(stateDir, { controlPlane: { stateDir } });
  const staleEvidence = {
    verdict: 'REWORK',
    rationale: 'r',
    findings: 'oops', // wrong type: a STRING, not an array
    metadata: { findingsCount: 50 },
    binding: { repository: session.repo, issue: session.issueNumber, headSha: HEAD },
    // deliberately NO rawText: nothing recoverable, so the typed guard owns it
  };
  const seeded = [
    { from: 'ACCEPTED', to: 'ROUTED' },
    { from: 'ROUTED', to: 'EXECUTING', evidence: { executorKind: 'opencode', model: 'x' } },
    { from: 'EXECUTING', to: 'VERIFYING', evidence: { executionRecordPath: '/fake/exec.json' } },
    { from: 'VERIFYING', to: 'PRE_REVIEWING', evidence: { verdict: 'PASS', report: 'ok' } },
    { from: 'PRE_REVIEWING', to: 'FINAL_REVIEWING', evidence: { verdict: 'PASS', findings: [] } },
    { from: 'FINAL_REVIEWING', to: 'DECIDING', evidence: staleEvidence },
  ];
  seedLedger(sessionPath, stateDir, ID, seeded);
  const calls = [];
  const deps = resumeDepsWithDecision(calls, { verdict: 'REWORK', findings: ['x'], evidenceRequests: [] });
  const before = readTransitions({ stateDir, identityHash: ID });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps }); // must NOT throw
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'REVIEW_DECISION_FINDINGS_MISSING');
  assert.ok(!calls.includes('delivery'), 'no delivery call happened');
  assert.ok(!calls.includes('executor'), 'no executor call happened');
  assert.deepEqual(calls, [], 'the typed guard fires before any adapter runs');
  const after = readTransitions({ stateDir, identityHash: ID });
  assert.equal(after.length, before.length, 'the typed fail-closed fires before any transition');
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE', 'session unchanged');
});

// Recovery NEVER re-stamps the binding. A recovered decision whose persisted
// binding does not echo the canonical session identity is rejected by the
// canonical assertReworkBinding gate (REWORK_BINDING_STALE) BEFORE any
// transition or dispatch — and the reviewer is never re-asked.
test('Q16. recovered contract-stale decision with a WRONG binding -> REWORK_BINDING_STALE, no dispatch, reviewer never re-asked', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID, session } = mkSession(stateDir, { controlPlane: { stateDir } });
  const staleEvidence = {
    ok: true,
    verdict: 'REWORK',
    rationale: 'r',
    rawText: 'Finding 1: off-by-one in resolveRange (src/range.mjs:42).\nVERDICT: CHANGES_REQUESTED',
    metadata: { conversationId: null, modelSlug: null, pollTimeout: false, findingsCount: 1 },
    // WRONG head: the session pins HEAD, this echoes a foreign headSha.
    binding: { repository: session.repo, issue: session.issueNumber, headSha: 'c'.repeat(40) },
    advisorGuidance: null,
  };
  seedLedger(sessionPath, stateDir, ID, [
    { from: 'ACCEPTED', to: 'ROUTED' },
    { from: 'ROUTED', to: 'EXECUTING', evidence: { executorKind: 'opencode', model: 'x' } },
    { from: 'EXECUTING', to: 'VERIFYING', evidence: { executionRecordPath: '/fake/exec.json' } },
    { from: 'VERIFYING', to: 'PRE_REVIEWING', evidence: { verdict: 'PASS', report: 'ok' } },
    { from: 'PRE_REVIEWING', to: 'FINAL_REVIEWING', evidence: { verdict: 'PASS', findings: [] } },
    { from: 'FINAL_REVIEWING', to: 'DECIDING', evidence: staleEvidence },
  ]);
  const before = readTransitions({ stateDir, identityHash: ID });
  const calls = [];
  const deps = resumeDepsWithDecision(calls, { verdict: 'REWORK', findings: ['x'], evidenceRequests: [] });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'REVIEW_PROVENANCE_MISSING', 'legacy response has no request artifact; recovery cannot legitimize it');
  assert.ok(!calls.includes('finalReview'), 'the reviewer is never re-asked');
  assert.deepEqual(calls, [], 'no adapter runs: no dispatch, no delivery');
  const after = readTransitions({ stateDir, identityHash: ID });
  assert.equal(after.length, before.length, 'rejected before any transition');
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE', 'session state unchanged');
});

for (const variant of ['missing-provenance', 'wrong-request', 'wrong-binding', 'stale-head', 'malformed-findings', 'wrong-turn']) {
  test(`Web2API DECIDING replay ${variant}: no record, transition, publish or executor`, async (t) => {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID, session } = mkSession(stateDir, { controlPlane: { stateDir }, prNumber: 263 });
    const fixture = reviewFixture({ session }); t.after(fixture.cleanup);
    const decision = persistedDecision(fixture);
    if (variant === 'missing-provenance') delete decision.provenance;
    if (variant === 'wrong-request') decision.provenance = { ...decision.provenance, requestId: 'wrong' };
    if (variant === 'wrong-binding') decision.binding = { ...decision.binding, issue: 260 };
    if (variant === 'stale-head') decision.binding = { ...decision.binding, headSha: 'b'.repeat(40) };
    if (variant === 'malformed-findings') decision.findings = [7];
    if (variant === 'wrong-turn') decision.newTurnId = 'r-old';
    seedLedger(sessionPath, stateDir, ID, [
      { from: 'ACCEPTED', to: 'ROUTED' },
      { from: 'ROUTED', to: 'EXECUTING', evidence: { executorKind: 'opencode', model: 'x' } },
      { from: 'FINAL_REVIEWING', to: 'DECIDING', evidence: decision },
    ]);
    const before = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
    const sessionBefore = fs.readFileSync(sessionPath, 'utf8');
    const calls = [];
    const deps = resumeDepsWithDecision(calls, { verdict: 'PASS' });
    deps.pushExec = () => { calls.push('publish'); throw new Error('must not publish'); };
    const result = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.ok(/^REVIEW_/.test(result.code), result.code);
    assert.deepEqual(calls, []);
    assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), before);
    assert.equal(fs.readFileSync(sessionPath, 'utf8'), sessionBefore);
    assert.equal(fs.existsSync(path.join(stateDir, 'control-loop', ID, 'rework')), false);
  });
}

test('finalReview provenance failure at the step boundary never appends a transition', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  seedLedger(sessionPath, stateDir, ID, [{ from: 'PRE_REVIEWING', to: 'FINAL_REVIEWING' }]);
  const loop = bindLoop({ sessionPath, identityHash: ID, stateDir });
  const before = JSON.stringify(loop.readTransitions());
  const result = await loop.step({ name: 'finalReview', from: 'FINAL_REVIEWING', to: 'DECIDING', run: async () => ({ ok: false, code: 'REVIEW_RESPONSE_REQUEST_MISMATCH' }) });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(loop.readTransitions()), before);
});

// ---------------------------------------------------------------------------
// Pre-dispatch route retry (repair for the observed task #9000031 blocker:
// route:FAIL / MODEL_UNRESOLVED / "spawnSync opencode.exe ETIMEDOUT" in the
// model availability probe, BEFORE any executor dispatch - the loop had no
// recovery class for a route:FAIL tail and stayed fail-closed forever).
// Contract under test: ONE bounded retry of the SAME route step for the SAME
// identity; unreconciled dispatch side effects block; unsupported failures
// still block; the old failure evidence is preserved byte-for-byte.
// ---------------------------------------------------------------------------
function routeFailLedger(sessionPath, stateDir, ID, evidence) {
  seedLedger(sessionPath, stateDir, ID, [
    { from: 'ACCEPTED', to: 'ROUTED' },
    { from: 'ROUTED', to: 'BLOCKED', reason: 'route:FAIL', evidence },
  ]);
}

function routeRetryDeps(calls, overrides = {}) {
  const base = {
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: '/fake/exec.json' } }; },
    verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'BLOCKED', findings: [] } }; },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
  };
  return { ...base, ...overrides };
}

test('R0. route retry whitelist contract: frozen, exactly MODEL_UNRESOLVED, never general route failures', () => {
  assert.ok(Object.isFrozen(ROUTE_RETRY_SUPPORTED_CODES));
  assert.deepEqual([...ROUTE_RETRY_SUPPORTED_CODES], ['MODEL_UNRESOLVED']);
  assert.equal(ROUTE_RETRY_SUPPORTED_CODES.includes('ROUTE_FAILED'), false);
  assert.equal(ROUTE_RETRY_SUPPORTED_CODES.includes('EXECUTION_RECORD_MISSING'), false);
});

test('R1. pre-dispatch route:FAIL (MODEL_UNRESOLVED) tail: one bounded retry dispatches the same identity exactly once; old failure evidence preserved', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  routeFailLedger(sessionPath, stateDir, ID, { ok: false, code: 'MODEL_UNRESOLVED', detail: 'model probe failed: spawnSync opencode.exe ETIMEDOUT' });
  const before = readTransitions({ stateDir, identityHash: ID });
  assert.equal(before.length, 2, 'seeded ACCEPTED->ROUTED + ROUTED->BLOCKED');
  const oldRecord = JSON.parse(JSON.stringify(before[1]));
  const calls = [];
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: routeRetryDeps(calls) });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(calls, ['router', 'executor', 'verifier', 'preReview', 'finalReview'], 'ONE full walk after the retry (router once, executor once); no delivery for a BLOCKED verdict');
  const after = readTransitions({ stateDir, identityHash: ID });
  const oldNow = after.find((r) => r.from === 'ROUTED' && r.to === 'BLOCKED');
  assert.deepEqual(oldNow, oldRecord, 'the original route:FAIL record is preserved byte-for-byte');
  assert.equal(after.filter((r) => r.from === 'ROUTED' && r.to === 'BLOCKED').length, 1, 'a successful retry appends NO second failure record');
  assert.ok(after.some((r) => r.from === 'ROUTED' && r.to === 'EXECUTING'), 'retry appends ROUTED->EXECUTING (same identity, same step)');
  assert.equal(after.filter((r) => r.from === 'EXECUTING' && r.to === 'VERIFYING').length, 1, 'exactly one dispatch walk');
});

test('R2. a route retry that fails AGAIN appends a NEW attempt record, preserves the old one, and never dispatches', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  routeFailLedger(sessionPath, stateDir, ID, { ok: false, code: 'MODEL_UNRESOLVED', detail: 'model probe failed: spawnSync opencode.exe ETIMEDOUT' });
  const before = readTransitions({ stateDir, identityHash: ID });
  const oldRecord = JSON.parse(JSON.stringify(before[1]));
  const calls = [];
  const res = await runControlLoop({
    sessionPath, identityHash: ID, stateDir,
    deps: routeRetryDeps(calls, { router: () => { calls.push('router'); return { ok: false, code: 'MODEL_UNRESOLVED', detail: 'still timed out' }; } }),
  });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'ROUTE_FAILED');
  assert.deepEqual(calls, ['router'], 'the retry attempts the route step ONCE; executor never dispatched');
  const after = readTransitions({ stateDir, identityHash: ID });
  const routeFails = after.filter((r) => r.from === 'ROUTED' && r.to === 'BLOCKED' && String(r.reason || '').startsWith('route:FAIL'));
  assert.equal(routeFails.length, 2, 'old failure record + ONE new attempt record (append-only, bounded)');
  assert.deepEqual(routeFails.find((r) => r.ts === oldRecord.ts), oldRecord, 'the old attempt evidence stays byte-identical');
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE', 'a failed retry never terminalizes the session');
});

test('R3. an existing or unreadable ExecutionRecord blocks the route retry (reconcile first), zero mutation', async () => {
  const stateDir = mkStateDir();
  const s = mkSession(stateDir, { controlPlane: { stateDir }, baseSha: 'c'.repeat(40), worktreePath: stateDir });
  routeFailLedger(s.sessionPath, stateDir, s.id, { ok: false, code: 'MODEL_UNRESOLVED', detail: 'timeout' });
  const before = JSON.stringify(readTransitions({ stateDir, identityHash: s.id }));

  // (a) a canonical ExecutionRecord exists -> dispatch side effect present.
  const recPath = writeCanonicalExecRecord(stateDir, s);
  let calls = [];
  let res = await runControlLoop({ sessionPath: s.sessionPath, identityHash: s.id, stateDir, deps: routeRetryDeps(calls) });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'ROUTE_RETRY_BLOCKED_SIDE_EFFECT', 'reconcile-or-block, never re-dispatch');
  assert.deepEqual(calls, [], 'no adapter runs while the side effect is unreconciled');
  assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: s.id })), before, 'ledger untouched');

  // (b) the record is unreadable -> side effect unclear -> still blocked.
  fs.writeFileSync(recPath, '{not json', 'utf8');
  calls = [];
  res = await runControlLoop({ sessionPath: s.sessionPath, identityHash: s.id, stateDir, deps: routeRetryDeps(calls) });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'ROUTE_RETRY_BLOCKED_SIDE_EFFECT', 'unreadable execution evidence blocks too');
  assert.deepEqual(calls, [], 'no adapter runs on unclear side effects');
  assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: s.id })), before, 'ledger still untouched');
});

test('R4. route:FAIL tails outside the whitelist (other/missing evidence codes) still fail closed with zero mutation', async () => {
  for (const ev of [{ ok: false, code: 'ROUTE_FAILED', detail: 'transport refused' }, { ok: false, detail: 'no code at all' }, 'string-evidence']) {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    routeFailLedger(sessionPath, stateDir, ID, ev);
    const before = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
    const calls = [];
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: routeRetryDeps(calls) });
    assert.equal(res.ok, false, JSON.stringify(ev));
    assert.equal(res.code, 'ROUTE_FAILED', JSON.stringify(ev));
    assert.deepEqual(calls, [], `unsupported failure stays fail-closed: ${JSON.stringify(ev)}`);
    assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), before, 'no new transition appended');
  }
});

test('R5. concurrent relaunches of a whitelisted route:FAIL tail dispatch exactly ONE executor', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  routeFailLedger(sessionPath, stateDir, ID, { ok: false, code: 'MODEL_UNRESOLVED', detail: 'spawnSync opencode.exe ETIMEDOUT' });
  let dispatches = 0;
  const mk = () => ({
    router: async () => ({ ok: true, value: { executorKind: 'opencode', model: 'x' } }),
    // Mirrors the canonical startExecution contract: the FIRST dispatch wins,
    // every later caller gets EXECUTION_ALREADY_RUNNING (never a second spawn).
    executor: () => {
      if (dispatches > 0) return { ok: false, code: 'EXECUTION_ALREADY_RUNNING' };
      dispatches += 1;
      return { ok: true, value: { executionRecordPath: '/fake/exec.json' } };
    },
    verifier: () => ({ ok: true, value: { verdict: 'PASS', report: 'ok' } }),
    preReview: () => ({ ok: true, value: { verdict: 'PASS', findings: [] } }),
    finalReview: () => ({ ok: true, value: { verdict: 'BLOCKED', findings: [] } }),
    delivery: () => ({ ok: true, value: { shipped: true } }),
  });
  const results = await Promise.all([
    runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: mk() }),
    runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: mk() }),
  ]);
  assert.equal(dispatches, 1, 'exactly one dispatch across concurrent relaunches');
  assert.ok(results.every((r) => r && typeof r.ok === 'boolean'), 'both relaunches return a typed result');
  const after = readTransitions({ stateDir, identityHash: ID });
  assert.ok(
    after.some((r) => r.from === 'ROUTED' && r.to === 'BLOCKED' && String(r.reason || '').startsWith('route:FAIL')),
    'the original failure evidence survives the concurrent retry',
  );
  assert.ok(after.filter((r) => r.from === 'EXECUTING' && r.to === 'VERIFYING').length <= 1, 'never two dispatch walks');
});

// ---------------------------------------------------------------------------
// Instruction restoration + pre-spawn execute:FAIL checkpoint recovery
// (repair continuation for #9000031: bare CLI resume produced
// resolveRunnerInstruction -> null -> adapters INSTRUCTION_REQUIRED at the
// execute step, leaving the ledger at EXECUTING->BLOCKED with no dispatch).
// ---------------------------------------------------------------------------
function mkSessionWithIdentity(stateDir, overrides = {}) {
  const s = mkSession(stateDir, { controlPlane: { stateDir }, ...overrides });
  // the real admission record always carries these (taskStart projection)
  s.session.identityHash = s.id;
  s.session.controlLoop = { identityHash: s.id, boundAt: 'seed' };
  return s;
}

function writeRouteClaim(stateDir, s, goal, mutate = {}) {
  const dir = path.join(stateDir, 'client-mcp', 'routes');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${s.id}.control-loop.json`);
  const claim = {
    kind: 'soc-control-loop-route',
    identityHash: s.id,
    repo: s.session.repo,
    issueNumber: s.session.issueNumber,
    sessionPath: s.sessionPath,
    stateDir,
    goal,
    requestedAt: '2026-10-02T23:22:00.000Z',
    ...mutate,
  };
  fs.writeFileSync(p, JSON.stringify(claim), 'utf8');
  return p;
}

test('I1. bare resume restores the EXACT admitted goal from the validated route claim (read-only evidence)', () => {
  const stateDir = mkStateDir();
  const s = mkSessionWithIdentity(stateDir, { worktreePath: stateDir, baseSha: 'c'.repeat(40) });
  const goal = 'GOAL task #69 exactly as admitted at admission time';
  const p = writeRouteClaim(stateDir, s, goal);
  const before = fs.readFileSync(p, 'utf8');

  const direct = readPersistedRouteGoal({ session: s.session, sessionPath: s.sessionPath });
  assert.equal(direct.ok, true, JSON.stringify(direct));
  assert.equal(direct.goal, goal);

  const r = resolveRunnerInstruction({ instruction: null, goal: null, session: s.session, sessionPath: s.sessionPath });
  assert.equal(typeof r, 'string', JSON.stringify(r));
  assert.equal(r, goal, 'the admitted goal (never contract prose) becomes the instruction base');
  assert.equal(fs.readFileSync(p, 'utf8'), before, 'claim bytes untouched: requestedAt preserved, claim read as evidence only (no worker execution)');
});

test('I2. missing/foreign/unreadable instruction source returns a typed block (never a string)', () => {
  // (a) missing claim
  const s0 = mkSessionWithIdentity(mkStateDir());
  let r = resolveRunnerInstruction({ instruction: null, goal: null, session: s0.session, sessionPath: s0.sessionPath });
  assert.equal(r && r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'INSTRUCTION_SOURCE_MISSING');

  // (b) foreign/mismatched linkage fields each fail typed with the field named
  const variants = [
    [{ kind: 'other-route' }, 'kind'],
    [{ identityHash: 'f'.repeat(32) }, 'identityHash'],
    [{ repo: 'foreign/repo' }, 'repo'],
    [{ issueNumber: 999 }, 'issueNumber'],
    [{ stateDir: path.join(os.tmpdir(), 'foreign-state') }, 'stateDir'],
    [{ sessionPath: path.join(os.tmpdir(), 'foreign-session.json') }, 'sessionPath'],
  ];
  for (const [mutate, field] of variants) {
    const stateDir = mkStateDir();
    const s = mkSessionWithIdentity(stateDir, { worktreePath: stateDir });
    writeRouteClaim(stateDir, s, 'G', mutate);
    r = resolveRunnerInstruction({ instruction: null, goal: null, session: s.session, sessionPath: s.sessionPath });
    assert.equal(r && r.ok, false, JSON.stringify(mutate));
    assert.equal(r.code, 'INSTRUCTION_SOURCE_MISMATCH', JSON.stringify(mutate));
    assert.ok(Array.isArray(r.detail.failed) && r.detail.failed.includes(field), `${field} named in ${JSON.stringify(r.detail)}`);
  }

  // (c) unreadable JSON claim
  const s2 = mkSessionWithIdentity(mkStateDir());
  const p2 = writeRouteClaim(s2.session.controlPlane.stateDir, s2, 'G');
  fs.writeFileSync(p2, '{not json', 'utf8');
  r = resolveRunnerInstruction({ instruction: null, goal: null, session: s2.session, sessionPath: s2.sessionPath });
  assert.equal(r && r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'INSTRUCTION_SOURCE_UNREADABLE');

  // (d) empty goal in a valid claim
  const s3 = mkSessionWithIdentity(mkStateDir());
  writeRouteClaim(s3.session.controlPlane.stateDir, s3, '   ');
  r = resolveRunnerInstruction({ instruction: null, goal: null, session: s3.session, sessionPath: s3.sessionPath });
  assert.equal(r && r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'INSTRUCTION_SOURCE_MISSING');

  // (e) checkpoint owner linkage: controlLoop.identityHash must echo the identity
  const s4 = mkSessionWithIdentity(mkStateDir());
  writeRouteClaim(s4.session.controlPlane.stateDir, s4, 'G');
  s4.session.controlLoop = { identityHash: 'e'.repeat(32) };
  r = resolveRunnerInstruction({ instruction: null, goal: null, session: s4.session, sessionPath: s4.sessionPath });
  assert.equal(r && r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'INSTRUCTION_SOURCE_MISMATCH');
  assert.ok(r.detail.failed.includes('controlLoop'));

  // (f) caller input still WINS - no claim read needed
  const s5 = mkSessionWithIdentity(mkStateDir());
  const got = resolveRunnerInstruction({ instruction: null, goal: 'caller goal', session: s5.session, sessionPath: s5.sessionPath });
  assert.equal(typeof got, 'string', JSON.stringify(got));
  assert.ok(got.startsWith('caller goal'));
});

function executeFailLedger(sessionPath, stateDir, ID, { count = 1, code = 'INSTRUCTION_REQUIRED' } = {}) {
  const recs = [
    { from: 'ACCEPTED', to: 'ROUTED' },
    { from: 'ROUTED', to: 'EXECUTING', evidence: { executorKind: 'opencode', model: 'opencode/nemotron-3-ultra-free' } },
  ];
  for (let i = 0; i < count; i += 1) {
    recs.push({
      from: 'EXECUTING', to: 'BLOCKED', reason: 'execute:FAIL',
      evidence: { ok: false, code, recovery: { class: 'PRE_SPAWN_EFFECT_PROVEN', code, retried: i > 0, budgetRemaining: 0,
        cleanupProof: { record: 'ABSENT', checks: [{ check: 'recordExists', exists: false }] }, firstFailure: { code } } },
    });
  }
  seedLedger(sessionPath, stateDir, ID, recs);
}

function executeRetryDeps(calls, overrides = {}) {
  return {
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: '/fake/exec.json' } }; },
    verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'BLOCKED', findings: [] } }; },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
    ...overrides,
  };
}

test('E0. execute retry contract: limit is a frozen bounded budget', () => {
  assert.equal(Object.isFrozen(EXECUTE_INSTRUCTION_RETRY_LIMIT), true);
  assert.equal(EXECUTE_INSTRUCTION_RETRY_LIMIT, 2);
});

test('E1. INSTRUCTION_REQUIRED pre-spawn checkpoint: resume dispatches EXACTLY ONE executor, route never re-run, old evidence preserved', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  executeFailLedger(sessionPath, stateDir, ID);
  const before = JSON.parse(JSON.stringify(readTransitions({ stateDir, identityHash: ID })[2]));
  const calls = [];
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: executeRetryDeps(calls) });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(calls, ['executor', 'verifier', 'preReview', 'finalReview'], 'router NEVER runs (route proven in ledger); ONE dispatch');
  const after = readTransitions({ stateDir, identityHash: ID });
  const old = after.find((r) => r.from === 'EXECUTING' && r.to === 'BLOCKED');
  assert.deepEqual(old, before, 'the original execute:FAIL record is preserved byte-for-byte');
  assert.equal(after.filter((r) => String(r.reason || '').startsWith('execute:FAIL')).length, 1, 'no second failure record on success');
  assert.ok(after.some((r) => r.from === 'EXECUTING' && r.to === 'VERIFYING'), 'retry appended EXECUTING->VERIFYING');
  assert.equal(after.filter((r) => r.from === 'ROUTED' && r.to === 'EXECUTING').length, 1, 'no duplicate route transition');
});

test('E2. other execute failure codes are NOT retried: fail-closed at route, zero mutation, no spawn', async () => {
  for (const code of ['LAUNCH_FAILED', 'MODEL_UNRESOLVED', 'EXECUTION_RECORD_MISSING']) {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    executeFailLedger(sessionPath, stateDir, ID, { code });
    const before = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
    const calls = [];
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: executeRetryDeps(calls) });
    assert.equal(res.ok, false, `${code}: ${JSON.stringify(res)}`);
    assert.equal(res.code, 'ROUTE_FAILED', code);
    assert.deepEqual(calls, [], `${code}: no adapter runs`);
    assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), before, `${code}: ledger untouched`);
  }
});

test('E3. an existing or unreadable ExecutionRecord blocks the execute retry (reconcile first), zero mutation', async () => {
  const stateDir = mkStateDir();
  const s = mkSession(stateDir, { controlPlane: { stateDir }, baseSha: 'c'.repeat(40), worktreePath: stateDir });
  executeFailLedger(s.sessionPath, stateDir, s.id);
  const before = JSON.stringify(readTransitions({ stateDir, identityHash: s.id }));

  const recPath = writeCanonicalExecRecord(stateDir, s);
  let calls = [];
  let res = await runControlLoop({ sessionPath: s.sessionPath, identityHash: s.id, stateDir, deps: executeRetryDeps(calls) });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'EXECUTE_RETRY_BLOCKED_SIDE_EFFECT');
  assert.deepEqual(calls, [], 'no dispatch while a side effect exists');
  assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: s.id })), before, 'ledger untouched');

  fs.writeFileSync(recPath, '{broken', 'utf8');
  calls = [];
  res = await runControlLoop({ sessionPath: s.sessionPath, identityHash: s.id, stateDir, deps: executeRetryDeps(calls) });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'EXECUTE_RETRY_BLOCKED_SIDE_EFFECT', 'unreadable execution evidence blocks too');
  assert.deepEqual(calls, []);
  assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: s.id })), before, 'ledger still untouched');
});

test('E4. the attempt budget is ledger-enforced: at the limit the retry blocks typed, zero mutation', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  executeFailLedger(sessionPath, stateDir, ID, { count: EXECUTE_INSTRUCTION_RETRY_LIMIT });
  const before = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
  const calls = [];
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: executeRetryDeps(calls) });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'EXECUTE_RETRY_LIMIT_EXHAUSTED');
  assert.equal(res.detail.attempts, EXECUTE_INSTRUCTION_RETRY_LIMIT);
  assert.deepEqual(calls, [], 'no dispatch at the budget limit');
  assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), before, 'ledger untouched');
});

test('E5. relaunch/concurrent callers dispatch EXACTLY ONE executor from the instruction checkpoint', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  executeFailLedger(sessionPath, stateDir, ID);
  let dispatches = 0;
  const mk = () => executeRetryDeps([], {
    executor: () => {
      // mirror canonical startExecution: first dispatch wins, later callers
      // get EXECUTION_ALREADY_RUNNING (never a second spawn)
      if (dispatches > 0) return { ok: false, code: 'EXECUTION_ALREADY_RUNNING' };
      dispatches += 1;
      return { ok: true, value: { executionRecordPath: '/fake/exec.json' } };
    },
  });
  const results = await Promise.all([
    runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: mk() }),
    runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: mk() }),
  ]);
  assert.equal(dispatches, 1, 'exactly one dispatch across concurrent relaunches');
  assert.ok(results.every((r) => r && typeof r.ok === 'boolean'), 'both callers get typed results');
  const after = readTransitions({ stateDir, identityHash: ID });
  assert.ok(after.some((r) => r.from === 'EXECUTING' && r.to === 'BLOCKED' && String(r.reason || '').startsWith('execute:FAIL')), 'original failure evidence survives');
  assert.ok(after.filter((r) => r.from === 'EXECUTING' && r.to === 'VERIFYING').length <= 1, 'never two dispatch walks');
});

// ---------------------------------------------------------------------------
// preReview CDP_SEND_TIMEOUT recovery (observed #9000031 checkpoint:
// PRE_REVIEWING->BLOCKED reason=preReview:THREW evidence="CDP_SEND_TIMEOUT").
// Contract under test: ONLY the classified timeout recovers (exactly once per
// relaunch), ONLY with a proven pre-submit boundary and ZERO submit
// side-effect artifacts; everything else stays zero-mutation fail-closed.
// ---------------------------------------------------------------------------
function preReviewTimeoutLedger(sessionPath, stateDir, ID, { reason = 'preReview:THREW', evidence = 'CDP_SEND_TIMEOUT' } = {}) {
  seedLedger(sessionPath, stateDir, ID, [
    { from: 'ACCEPTED', to: 'ROUTED' },
    { from: 'ROUTED', to: 'EXECUTING', evidence: { executorKind: 'opencode', model: 'opencode/nemotron-3-ultra-free' } },
    { from: 'EXECUTING', to: 'VERIFYING', evidence: { executionRecordPath: '/fake/exec.json' } },
    { from: 'VERIFYING', to: 'PRE_REVIEWING', evidence: { verdict: 'PASS', report: 'ok' } },
    { from: 'PRE_REVIEWING', to: 'BLOCKED', reason, evidence },
  ]);
}

function preReviewRetryDeps(calls, overrides = {}) {
  return {
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: '/fake/exec.json' } }; },
    verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [], confidence: 0.5, metadata: {} } }; },
    finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'BLOCKED', findings: [] } }; },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
    ...overrides,
  };
}

function writeSubmitArtifact(stateDir, ID) {
  const dir = path.join(stateDir, 'web2api-review-requests', ID);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'x.submit.json');
  fs.writeFileSync(p, JSON.stringify({ state: 'WRITE_STARTED' }), 'utf8');
  return p;
}

function readReviewStoreCount(stateDir, ID) {
  try {
    return fs.readdirSync(path.join(stateDir, 'web2api-review-requests', ID)).length;
  } catch {
    return 0;
  }
}

test('P1. legacy THREW + EMPTY store but NO canonical boundary record -> typed BLOCK (artifact absence proves nothing)', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  preReviewTimeoutLedger(sessionPath, stateDir, ID);
  assert.equal(readReviewStoreCount(stateDir, ID), 0, 'store starts empty - and that alone must NOT authorize a retry');
  const before = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
  const calls = [];
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls) });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED');
  assert.equal(res.detail.reconcile.reason, 'RECORD_ABSENT', 'the missing canonical record is named');
  assert.deepEqual(calls, [], 'zero transition/submit: no adapter runs');
  assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), before, 'ledger untouched');
});

test('P1R. legacy THREW retries EXACTLY ONCE only via the canonical reconciled PRE_SUBMIT record (identity+checkpoint bound)', async () => {
  // (a) a record bound to THIS identity AND THIS checkpoint unlocks ONE retry
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  preReviewTimeoutLedger(sessionPath, stateDir, ID);
  const tail = readTransitions({ stateDir, identityHash: ID }).at(-1);
  const rec = recordPreSubmitBoundaryReconciled({
    stateDir,
    identityHash: ID,
    checkpoint: { ts: String(tail.ts), reason: String(tail.reason), evidence: String(tail.evidence) },
    source: 'offline-diagnosis:transport-log+code-order',
    basis: 'unit fixture: captured log lacked the pre-submit marker line; first send is the pre-submit Runtime.evaluate snapshot',
  });
  assert.equal(rec.ok, true, JSON.stringify(rec));
  assert.equal(rec.created, true);
  // idempotent: never launders a second basis over the same checkpoint
  const again = recordPreSubmitBoundaryReconciled({
    stateDir, identityHash: ID,
    checkpoint: { ts: String(tail.ts), reason: String(tail.reason), evidence: String(tail.evidence) },
    source: 'other', basis: 'other',
  });
  assert.equal(again.ok, true);
  assert.equal(again.created, false, 'first reconciliation wins');

  const before = JSON.parse(JSON.stringify(readTransitions({ stateDir, identityHash: ID })[4]));
  const calls = [];
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls) });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(calls, ['preReview', 'finalReview'], 'ONE preReview re-entry; router/executor/verifier never run');
  const after = readTransitions({ stateDir, identityHash: ID });
  assert.deepEqual(after.find((r) => r.reason === 'preReview:THREW'), before, 'original THREW record byte-preserved');
  assert.equal(after.filter((r) => String(r.reason || '').startsWith('preReview:THREW')).length, 1, 'exactly one THREW record');
  assert.ok(after.some((r) => r.from === 'PRE_REVIEWING' && r.to === 'FINAL_REVIEWING'), 'phase preserved: same preReview step re-entered once');

  // (b) record bound to a DIFFERENT checkpoint (other ts) -> that key has no
  // record -> block (content-addressing binds the checkpoint)
  const sd2 = mkStateDir();
  const s2 = mkSession(sd2);
  preReviewTimeoutLedger(s2.sessionPath, sd2, s2.id);
  recordPreSubmitBoundaryReconciled({
    stateDir: sd2, identityHash: s2.id,
    checkpoint: { ts: '1999-01-01T00:00:00.000Z', reason: 'preReview:THREW', evidence: 'CDP_SEND_TIMEOUT' },
    source: 'test', basis: 'wrong checkpoint fixture',
  });
  const calls2 = [];
  const res2 = await runControlLoop({ sessionPath: s2.sessionPath, identityHash: s2.id, stateDir: sd2, deps: preReviewRetryDeps(calls2) });
  assert.equal(res2 && res2.ok, false, JSON.stringify(res2));
  assert.equal(res2.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED');
  assert.equal(res2.detail.reconcile.reason, 'RECORD_ABSENT', 'a record for another checkpoint does not unlock this one');
  assert.deepEqual(calls2, []);

  // (c) tampered identity field inside the correctly-keyed file -> mismatch -> block
  const sd3 = mkStateDir();
  const s3 = mkSession(sd3);
  preReviewTimeoutLedger(s3.sessionPath, sd3, s3.id);
  const tail3 = readTransitions({ stateDir: sd3, identityHash: s3.id }).at(-1);
  const rec3 = recordPreSubmitBoundaryReconciled({
    stateDir: sd3, identityHash: s3.id,
    checkpoint: { ts: String(tail3.ts), reason: String(tail3.reason), evidence: String(tail3.evidence) },
    source: 'test', basis: 'fixture',
  });
  assert.equal(rec3.ok, true, JSON.stringify(rec3));
  const tampered = JSON.parse(fs.readFileSync(rec3.path, 'utf8'));
  tampered.identityHash = 'e'.repeat(32);
  fs.writeFileSync(rec3.path, JSON.stringify(tampered), 'utf8');
  const calls3 = [];
  const res3 = await runControlLoop({ sessionPath: s3.sessionPath, identityHash: s3.id, stateDir: sd3, deps: preReviewRetryDeps(calls3) });
  assert.equal(res3 && res3.ok, false, JSON.stringify(res3));
  assert.equal(res3.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED');
  assert.equal(res3.detail.reconcile.reason, 'RECORD_IDENTITY_MISMATCH', 'identity field binding is enforced');
  assert.deepEqual(calls3, []);
});

test('P1b. typed preReview:FAIL CDP_SEND_TIMEOUT proven PRE_SUBMIT also recovers (structured boundary)', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  preReviewTimeoutLedger(sessionPath, stateDir, ID, {
    reason: 'preReview:FAIL',
    evidence: { ok: false, code: 'CDP_SEND_TIMEOUT', detail: { method: 'Runtime.evaluate', stage: 'PRE_SUBMIT_SNAPSHOT', phase: 'PRE_SUBMIT', cdpTimeoutMs: 30000, submitEvidence: { submitted: false, reason: 'pre-submit' } } },
  });
  const calls = [];
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls) });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(calls, ['preReview', 'finalReview']);
});

test('P2. submit side effect present, or boundary UNPROVEN -> typed block, no resend, zero mutation', async () => {
  // (a) typed FAIL whose boundary is NOT proven pre-submit -> block
  {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    preReviewTimeoutLedger(sessionPath, stateDir, ID, {
      reason: 'preReview:FAIL',
      evidence: { ok: false, code: 'CDP_SEND_TIMEOUT', detail: { phase: 'SUBMIT', submitEvidence: { submitted: 'UNKNOWN' } } },
    });
    const before = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
    const calls = [];
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls) });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED');
    assert.deepEqual(calls, [], 'no preReview resend when the submit outcome is unknown');
    assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), before, 'ledger untouched');
  }
  // (b) THREW checkpoint BUT durable submit artifacts exist -> reconcile first
  {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    preReviewTimeoutLedger(sessionPath, stateDir, ID);
    writeSubmitArtifact(stateDir, ID);
    const before = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
    const calls = [];
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls) });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED');
    assert.ok(res.detail && res.detail.detail && res.detail.detail.present === true, 'the artifacts are named in the typed block');
    assert.ok(Array.isArray(res.detail.detail.files) && res.detail.detail.files.includes('x.submit.json'), 'artifact file listed');
    assert.deepEqual(calls, [], 'no resend while a submit side effect exists');
    assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), before, 'ledger untouched');
  }
});

test('P3. a preReview:THREW outside the supported class stays fail-closed (zero mutation, no spawn)', async () => {
  for (const evidence of ['CDP_WS_OPEN_TIMEOUT', 'GEMINI_TRANSPORT_EXCEPTION', 'something else']) {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    preReviewTimeoutLedger(sessionPath, stateDir, ID, { evidence });
    const before = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
    const calls = [];
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls) });
    assert.equal(res.ok, false, `${evidence}: ${JSON.stringify(res)}`);
    assert.equal(res.code, 'ROUTE_FAILED', evidence);
    assert.deepEqual(calls, [], `${evidence}: no adapter runs`);
    assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), before, `${evidence}: ledger untouched`);
  }
});

test('P4. relaunch after a successful recovery cannot create a second review attempt or executor', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  // recovery through the TYPED pre-submit boundary (the shape that needs no
  // reconcile record: the transport's own structured evidence)
  preReviewTimeoutLedger(sessionPath, stateDir, ID, {
    reason: 'preReview:FAIL',
    evidence: { ok: false, code: 'CDP_SEND_TIMEOUT', detail: { method: 'Runtime.evaluate', stage: 'PRE_SUBMIT_SNAPSHOT', phase: 'PRE_SUBMIT', cdpTimeoutMs: 30000, submitEvidence: { submitted: false, reason: 'pre-submit' } } },
  });
  const calls1 = [];
  const r1 = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls1) });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(calls1.filter((c) => c === 'preReview').length, 1);
  const ledgerAfterFirst = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
  const calls2 = [];
  const r2 = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls2) });
  assert.equal(r2.ok, false, JSON.stringify(r2));
  assert.deepEqual(calls2, [], 'the relaunch runs NO adapter: no second review attempt, no executor');
  assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), ledgerAfterFirst, 'ledger unchanged by the relaunch');
});







