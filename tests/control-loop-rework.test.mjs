// tests/control-loop-rework.test.mjs — P0-E rework leg (Issue #79).
// Deterministic coverage: validated REWORK -> same-authority re-dispatch,
// findings/evidenceRequests preservation, stale/wrong binding fail-closed,
// PASS never reworks, replayed ReviewResult never double-dispatches,
// dispatch failure stays recoverable, GPT adapter holds no executor authority.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runControlLoop,
  readTransitions,
  bindLoop,
  MAX_REWORK_ROUNDS,
  assertReworkBinding,
} from '../packages/control-loop/control-loop.mjs';
import { decisionDigest, buildReworkInstruction, buildReworkRecord } from '../packages/control-loop/rework.mjs';
import { gptFinalReviewAdapter } from '../packages/control-loop/adapters.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { reviewFixture, persistedDecision } from './fixtures/web2api-review.mjs';
import { createGeminiWeb2ApiReviewTransport } from '../packages/control-loop/gemini-plus-web2api-copy.mjs';
import {
  claimReviewSubmit, persistReviewResponse, reconcileLateReviewResponse,
} from '../packages/control-loop/web2api-review-provenance.mjs';

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'clr-')); }

function mkSession(stateDir, overrides = {}) {
  const repo = overrides.repo || 'duongpdddic-droid/soc_brain';
  const issueNumber = overrides.issueNumber || 79;
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
    headSha: 'a'.repeat(40),
    baseSha: 'f'.repeat(40),
    worktreePath: path.join(stateDir, `wt-issue-${issueNumber}`),
    worktreesRoot: stateDir,
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session, id };
}

// Canonical execution record the rework read-back gate requires.
function mkExecRecord(stateDir, id, repo = 'duongpdddic-droid/soc_brain', issueNumber = 79) {
  const p = path.join(stateDir, 'executions', `${id}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: id,
    taskId: `${repo}#${issueNumber}`, repo, issueNumber,
    terminalStatus: 'ok', exitCode: 0,
  }, null, 2), 'utf8');
  return p;
}

function baseDeps(stateDir, calls, execPath) {
  return {
    reviewReadyDir: path.join(stateDir, 'review-ready'),
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: (ctx) => {
      calls.push(`executor:${ctx.reworkInstruction ? 'rework' : 'initial'}`);
      return { ok: true, value: { executionStatus: 'EXITED', terminalStatus: 'ok', exitCode: 0, executionRecordPath: execPath } };
    },
    verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
    telegramSpawn: () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 900 })}\n` }),
  };
}

const reworkDecision = (findings = ['fix-the-flaky-test'], evidenceRequests = ['provide logs'], headSha = 'a'.repeat(40)) => ({
  verdict: 'REWORK', findings, evidenceRequests, confidence: 0.8, metadata: {},
  binding: { repository: 'duongpdddic-droid/soc_brain', issue: 79, headSha },
});

test('Web2API valid REWORK dispatch uses the reviewed published HEAD, preserves remediation and provenance', async (t) => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir }, prNumber: 263 });
  const calls = [];
  const execPath = mkExecRecord(stateDir, ID);
  const deps = baseDeps(stateDir, calls, execPath);
  deps.verifier = () => {
    const current = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    fs.writeFileSync(sessionPath, JSON.stringify({ ...current, headSha: 'b'.repeat(40) }));
    return { ok: true, value: { verdict: 'PASS' } };
  };
  let round = 0;
  deps.finalReview = () => {
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    const fixture = reviewFixture({ session, verdict: ++round === 1 ? 'CHANGES_REQUESTED' : 'APPROVED', findings: round === 1 ? ['src/a.mjs:42 incorrect bounds'] : [], remediation: ['Preserve every detail of the repair.'] });
    t.after(fixture.cleanup);
    return { ok: true, value: persistedDecision(fixture) };
  };
  const originalExecutor = deps.executor;
  let instruction;
  deps.executor = (ctx) => { if (ctx.reworkInstruction) instruction = ctx.reworkInstruction; return originalExecutor(ctx); };
  const result = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.filter((c) => c === 'executor:rework').length, 1);
  assert.ok(instruction.includes('Preserve every detail of the repair.'));
  assert.ok(instruction.includes('bbbbbbbbbbbb'));
});

test('R1. validated REWORK re-dispatches the SAME executor with rework context, then COMPLETED on round-2 PASS', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir } });
  const execPath = mkExecRecord(stateDir, ID);
  const calls = [];
  const deps = baseDeps(stateDir, calls, execPath);
  const pass = { verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.99, metadata: {} };
  const rw = reworkDecision();
  const digest = decisionDigest({ identityHash: ID, decision: rw });
  deps.finalReview = () => { calls.push('finalReview'); return { ok: true, value: calls.filter((c) => c === 'finalReview').length === 1 ? rw : pass }; };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  assert.deepEqual(calls, ['router', 'executor:initial', 'verifier', 'preReview', 'finalReview', 'executor:rework', 'verifier', 'preReview', 'finalReview', 'delivery']);
  const ledger = readTransitions({ stateDir, identityHash: ID });
  const reworkExec = ledger.find((r) => r.from === 'REWORK' && r.to === 'EXECUTING');
  assert.ok(reworkExec, 'REWORK -> EXECUTING transition recorded');
  const reworkEntry = ledger.find((r) => r.from === 'DECIDING' && r.to === 'REWORK' && r.reason === 'final-review-rework');
  assert.ok(reworkEntry, 'DECIDING -> REWORK recorded');
  assert.equal(reworkEntry.evidence.round, 1);
  assert.ok(reworkEntry.evidence.findings.includes('fix-the-flaky-test'));
  const recPath = path.join(stateDir, 'control-loop', ID, 'rework', `${digest}.json`);
  assert.ok(fs.existsSync(recPath), `rework record at ${recPath}`);
});

test('R2. findings/evidenceRequests preserved verbatim with provenance; instruction carries them to the executor', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir } });
  const execPath = mkExecRecord(stateDir, ID);
  const calls = [];
  const deps = baseDeps(stateDir, calls, execPath);
  const findings = ['finding-ONE verbatim', 'finding-TWO verbatim'];
  const evidenceRequests = ['request-A: attach logs', 'request-B: attach diff'];
  const rw = reworkDecision(findings, evidenceRequests);
  const digest = decisionDigest({ identityHash: ID, decision: rw });
  const pass = { verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.99, metadata: {} };
  let seenInstruction = null;
  deps.executor = (ctx) => { if (ctx.reworkInstruction) seenInstruction = ctx.reworkInstruction; calls.push(`executor:${ctx.reworkInstruction ? 'rework' : 'initial'}`); return { ok: true, value: { executionStatus: 'EXITED', terminalStatus: 'ok', exitCode: 0, executionRecordPath: execPath } }; };
  deps.finalReview = () => { calls.push('finalReview'); return { ok: true, value: calls.filter((c) => c === 'finalReview').length === 1 ? rw : pass }; };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  const recPath = path.join(stateDir, 'control-loop', ID, 'rework', `${digest}.json`);
  const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
  assert.deepEqual(rec.findings, findings);
  assert.deepEqual(rec.evidenceRequests, evidenceRequests);
  assert.equal(rec.provenance.dispatchAuthority, 'Soc_brain ControlLoop only (Issue #79); GPT has no executor authority');
  assert.ok(rec.provenance.source.includes('gpt-final-review'));
  assert.ok(seenInstruction.includes('finding-ONE verbatim') && seenInstruction.includes('finding-TWO verbatim'));
  assert.ok(seenInstruction.includes('R1. request-A: attach logs') && seenInstruction.includes('R2. request-B: attach diff'));
  assert.ok(seenInstruction.includes('Do NOT merge'));
});

test('R3. stale / wrong / missing binding -> NO dispatch (fail-closed, recoverable)', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID, session } = mkSession(stateDir, {
    controlPlane: { stateDir },
    headSha: 'b'.repeat(40),
  });
  const calls = [];
  const deps = baseDeps(stateDir, calls, mkExecRecord(stateDir, ID));
  // Decision echoes a DIFFERENT head than the pinned session head -> stale.
  deps.finalReview = () => { calls.push('finalReview'); return { ok: true, value: reworkDecision(['f'], ['r'], 'c'.repeat(40)) }; };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'REWORK_BINDING_STALE');
  assert.deepEqual(calls, ['router', 'executor:initial', 'verifier', 'preReview', 'finalReview']);
  const tos = readTransitions({ stateDir, identityHash: ID }).map((r) => r.to);
  assert.ok(!tos.includes('REWORK'));
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE');
  assert.ok(session);
  const tok = readTransitions({ stateDir, identityHash: ID });
  const last = tok[tok.length - 1];
  // The gate fires inside the rework leg, i.e. AFTER the first-pass
  // FINAL_REVIEWING->DECIDING step: the ledger tail stays at DECIDING and the
  // loop is retryable (a corrected binding echoes the pinned head).
  assert.equal(last.to, 'DECIDING');
  assert.equal(last.from, 'FINAL_REVIEWING');

  // Foreign repo echo (never dispatches — binding gate fires first).
  const s2 = mkStateDir();
  const m2 = mkSession(s2, { controlPlane: { stateDir: s2 } });
  const d2 = baseDeps(s2, [], mkExecRecord(s2, m2.id));
  d2.finalReview = () => ({ ok: true, value: { verdict: 'REWORK', findings: ['f'], evidenceRequests: ['r'], confidence: 0.5, metadata: {}, binding: { repository: 'other/repo', issue: 79, headSha: 'a'.repeat(40) } } });
  const r2 = await runControlLoop({ sessionPath: m2.sessionPath, identityHash: m2.id, stateDir: s2, deps: d2 });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'REWORK_BINDING_MISMATCH');

  // Malformed echo (no binding at all).
  const s3 = mkStateDir();
  const m3 = mkSession(s3, { controlPlane: { stateDir: s3 } });
  const d3 = baseDeps(s3, [], mkExecRecord(s3, m3.id));
  d3.finalReview = () => ({ ok: true, value: { verdict: 'REWORK', findings: ['f'], evidenceRequests: [], confidence: 0.5, metadata: {} } });
  const r3 = await runControlLoop({ sessionPath: m3.sessionPath, identityHash: m3.id, stateDir: s3, deps: d3 });
  assert.equal(r3.ok, false);
  assert.equal(r3.code, 'REWORK_BINDING_MISSING');
});

test('R4. PASS verdict never enters the rework leg', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir } });
  const calls = [];
  const deps = baseDeps(stateDir, calls, mkExecRecord(stateDir, ID));
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true);
  assert.equal(res.value.state, 'COMPLETED');
  const tos = readTransitions({ stateDir, identityHash: ID }).map((r) => r.to);
  assert.ok(!tos.includes('REWORK'));
  assert.deepEqual(calls.filter((c) => c.startsWith('executor:')), ['executor:initial']);
  assert.ok(!fs.existsSync(path.join(stateDir, 'control-loop', ID, 'rework')));
});

test('R5. duplicate/replayed ReviewResult -> NO duplicate dispatch; re-invocation stays single-dispatch', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir } });
  const execPath = mkExecRecord(stateDir, ID);
  const calls = [];
  const deps = baseDeps(stateDir, calls, execPath);
  const rw = reworkDecision();
  deps.finalReview = () => { calls.push('finalReview'); return { ok: true, value: rw }; };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  // First run: one dispatch, follow-up decision is the same REWORK again ->
  // replay guard fires (no second dispatch, no terminalize).
  assert.equal(res.ok, false);
  assert.equal(res.code, 'REWORK_ALREADY_DISPATCHED');
  assert.deepEqual(calls.filter((c) => c.startsWith('executor:')), ['executor:initial', 'executor:rework']);
  assert.equal(fs.readdirSync(path.join(stateDir, 'control-loop', ID, 'rework')).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE');
  // Re-invocation (retry): the resume REPLAYS the decision persisted at the
  // FINAL_REVIEWING->DECIDING transition — the reviewer is never re-asked —
  // and the replayed decision hits the dispatch-marker guard: still exactly one
  // rework dispatch, no executor call, session untouched.
  calls.length = 0;
  const res2 = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res2.ok, false);
  assert.equal(res2.code, 'REWORK_ALREADY_DISPATCHED');
  assert.deepEqual(calls, []);
  assert.deepEqual(calls.filter((c) => c.startsWith('executor:')), []);
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE');
});

test('R6. rework dispatch failure -> fail-closed, recoverable, NEVER terminalized', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir } });
  const execPath = mkExecRecord(stateDir, ID);
  const calls = [];
  const deps = baseDeps(stateDir, calls, execPath);
  const rw = reworkDecision();
  const pass = { verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.99, metadata: {} };
  let n = 0;
  deps.executor = (ctx) => {
    if (ctx.reworkInstruction) { calls.push('executor:rework'); return { ok: false, code: 'EXECUTOR_TIMEOUT' }; }
    calls.push('executor:initial');
    return { ok: true, value: { executionStatus: 'EXITED', terminalStatus: 'ok', exitCode: 0, executionRecordPath: execPath } };
  };
  deps.finalReview = () => { calls.push('finalReview'); n += 1; return { ok: true, value: n === 1 ? rw : pass }; };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'REWORK_EXECUTE_FAILED');
  // Canonical session is NOT terminal (no terminalize on dispatch failure).
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE');
  // The rework decision stays persisted with provenance; a retry hits the
  // dedupe marker only after a COMPLETED dispatch — here the dispatch failed,
  // so the retry re-enters the leg without a duplicate terminalize.
  assert.equal(fs.readdirSync(path.join(stateDir, 'control-loop', ID, 'rework')).length, 1);
  const tos = readTransitions({ stateDir, identityHash: ID }).map((r) => r.to);
  assert.ok(!tos.includes('COMPLETED'));
});

test('R7. dispatch read-back: fresh execution record must exist at the canonical location for THIS identity', async () => {
  // (a) executor reports a path that has no canonical record.
  {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir } });
    const calls = [];
    const deps = baseDeps(stateDir, calls, path.join(stateDir, 'executions', 'missing.json'));
    deps.finalReview = () => ({ ok: true, value: reworkDecision() });
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'REWORK_DISPATCH_READBACK_FAILED');
    const tos = readTransitions({ stateDir, identityHash: ID }).map((r) => r.to);
    // No verification ran after the failed read-back; no delivery either.
    assert.deepEqual(tos.filter((t) => t === 'VERIFYING').length, 1); // first pass only
    assert.ok(!tos.includes('COMPLETED'));
  }
  // (b) canonical record belongs to a FOREIGN identity.
  {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir } });
    mkExecRecord(stateDir, identityHash({ repo: 'duongpdddic-droid/soc_brain', issueNumber: 1 }));
    const deps = baseDeps(stateDir, [], path.join(stateDir, 'executions', `${identityHash({ repo: 'duongpdddic-droid/soc_brain', issueNumber: 1 })}.json`));
    deps.finalReview = () => ({ ok: true, value: reworkDecision() });
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'REWORK_DISPATCH_READBACK_FAILED');
  }
});

test('R8. rework budget: MAX_REWORK_ROUNDS distinct rejections then canonical BLOCKED escalation', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir } });
  const execPath = mkExecRecord(stateDir, ID);
  const calls = [];
  const deps = baseDeps(stateDir, calls, execPath);
  let n = 0;
  deps.finalReview = () => {
    calls.push('finalReview');
    n += 1;
    return { ok: true, value: { verdict: 'REWORK', findings: [`reject-${n}`], evidenceRequests: [], confidence: 0.8, metadata: {}, binding: { repository: 'duongpdddic-droid/soc_brain', issue: 79, headSha: 'a'.repeat(40) } } };
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'BLOCKED');
  assert.equal(res.value.reason, 'REWORK_BUDGET_EXHAUSTED');
  assert.ok(res.value.terminalize.ok, 'terminalize BLOCKED succeeded');
  assert.equal(MAX_REWORK_ROUNDS, 3);
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'BLOCKED');
  assert.equal(fs.readdirSync(path.join(stateDir, 'control-loop', ID, 'rework')).length, MAX_REWORK_ROUNDS);
  const ledger = readTransitions({ stateDir, identityHash: ID });
  assert.equal(ledger.filter((r) => r.reason === 'rework-budget-exhausted').length, 1);
  // Each rejected round dispatched exactly once: 4 executor calls (initial + 3 reworks).
  assert.equal(calls.filter((c) => c.startsWith('executor:')).length, 1 + MAX_REWORK_ROUNDS);
});

test('R9. GPT adapter holds NO executor authority (raw reply payload stripped to DATA)', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir } });
  const execPath = mkExecRecord(stateDir, ID);
  const rr = { dir: path.join(stateDir, 'review-ready') };
  fs.mkdirSync(rr.dir, { recursive: true });
  const slug = 'duongpdddic-droid_soc_brain';
  const name = `${slug}_Issue-79_PR-80_abcdef0_review-ready.md`;
  const head = 'a'.repeat(40);
  fs.writeFileSync(path.join(rr.dir, name), [
    '# Review Ready', '', '## Identity',
    '- repository: duongpdddic-droid/soc_brain',
    '- issue: 79',
    `- headSha: ${head} (short ${head.slice(0, 7)})`,
    '', 'body',
    // Full canonical section set (renderReviewReady contract) — required by
    // the structured packet projection (Issue #155 round-6).
    '',
    '## Scope',
    '- 1. note=scope under review',
    '',
    '## Code evidence',
    '- 1. commits=abcdef0 · files=3 · diffStat=+120/-22',
    '',
    '## Finding resolution',
    '- 1. note=first canonical pass — no prior review findings yet',
    '',
    '## Tests',
    '- 1. testExecution=787/787 passed · exitCode=0 · headSha=aaaaaaaa',
    '',
    '## Verification',
    '- 1. legacyEvidenceVerify=PASS · failClosedVerifierCodes=none',
    '',
    '## Safety and mutation analysis',
    '- 1. controlLoopTrace=PRE_REVIEWING->FINAL_REVIEWING (ok)',
    '',
    '## Unverified risks',
    '- 1. semantic review pending',
    '',
    '## Delivery',
    '- 1. pr=80 · prState=OPEN · baseBranch=main',
    '',
    '## Terminal status',
    '- status: **READY_FOR_REVIEW**',
    '',
  ].join('\n'), 'utf8');
  // Malicious transport: authority-shaped fields attached to a REWORK verdict.
  // The reply must still satisfy the adapter's requestDigest gate (stale-mock
  // repair: R9 is the only test here wiring the REAL gptFinalReviewAdapter,
  // whose S4 digest validation rejects metadata without the echoed digest —
  // same prompt-echo helper pattern as control-loop-gpt-final.test.mjs).
  const withDigest = (payload) => async ({ prompt } = {}) => {
    const m = /Request digest \(include in metadata\.requestDigest\):\s*([0-9a-f]{64})/i.exec(String(prompt || ''));
    const obj = {
      ...payload,
      metadata: { ...(payload.metadata || {}), requestDigest: m ? m[1] : '0'.repeat(64) },
    };
    return { ok: true, text: JSON.stringify(obj) };
  };
  const leaky = withDigest({
    verdict: 'REWORK', findings: ['f'], evidenceRequests: [], confidence: 0.9, metadata: {},
    binding: { repository: 'duongpdddic-droid/soc_brain', issue: 79, headSha: head },
    taskFinish: 'COMPLETED', terminalizeToken: 'evil', merge: true, dispatch: 'opencode',
  });
  const calls = [];
  const deps = baseDeps(stateDir, calls, execPath);
  deps.reviewReadyDir = rr.dir;
  deps.preReview = () => ({ ok: true, value: { verdict: 'PASS', findings: [] } });
  deps.finalReview = gptFinalReviewAdapter({ transport: leaky, reviewReadyDir: rr.dir });
  let reworkCtx = null;
  deps.executor = (ctx) => { if (ctx.reworkInstruction) reworkCtx = { ...ctx }; return { ok: true, value: { executionStatus: 'EXITED', terminalStatus: 'ok', exitCode: 0, executionRecordPath: execPath } }; };
  // Second GPT call returns PASS via a clean transport.
  let gptCall = 0;
  const clean = withDigest({ verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.9, metadata: {}, binding: { repository: 'duongpdddic-droid/soc_brain', issue: 79, headSha: head } });
  const leakyThenClean = (n) => (n === 1 ? leaky : clean);
  const firstAdapter = gptFinalReviewAdapter({ transport: leakyThenClean(1), reviewReadyDir: rr.dir });
  deps.finalReview = (...a) => { gptCall += 1; return gptCall === 1 ? firstAdapter(...a) : gptFinalReviewAdapter({ transport: leakyThenClean(2), reviewReadyDir: rr.dir })(...a); };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  // The dispatch came from the ControlLoop with the BOUNDED rework instruction
  // derived from findings — not from GPT's injected authority payload.
  assert.ok(reworkCtx, 'rework dispatch happened via ControlLoop');
  assert.ok(!('terminalizeToken' in reworkCtx) && !('dispatch' in reworkCtx));
  const all = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
  assert.ok(!all.includes('terminalizeToken') && !all.includes('"merge":true') && !all.includes('"dispatch":"opencode"'));
});

test('R10. REWORK decision with findings but no evidenceRequests -> REVIEW_DECISION_EVIDENCE_MISSING before the rework leg', async () => {
  // Issue #260 guard: buildReworkRecord (rework.mjs:52) spreads
  // evidenceRequests VERBATIM, so a REWORK decision that publishes findings
  // but never publishes the evidenceRequests array must fail CLOSED with the
  // typed contract code at the decide() seam — before runReworkLeg ever runs
  // (no rework record, no dispatch, no untyped TypeError).
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir } });
  const execPath = mkExecRecord(stateDir, ID);
  const calls = [];
  const deps = baseDeps(stateDir, calls, execPath);
  deps.finalReview = () => {
    calls.push('finalReview');
    // findings present, evidenceRequests ABSENT (pre-fix transport shape).
    return { ok: true, value: { verdict: 'REWORK', findings: ['fix-it'], confidence: 0.8, metadata: {}, binding: { repository: 'duongpdddic-droid/soc_brain', issue: 79, headSha: 'a'.repeat(40) } } };
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'REVIEW_DECISION_EVIDENCE_MISSING');
  assert.deepEqual(calls, ['router', 'executor:initial', 'verifier', 'preReview', 'finalReview'], 'the leg stops at the decision seam: no rework dispatch, no delivery');
  assert.ok(!calls.includes('executor:rework'), 'the executor is never re-dispatched for a contract-stale decision');
  assert.equal(fs.existsSync(path.join(stateDir, 'control-loop', ID, 'rework')), false, 'buildReworkRecord never runs');
  const tos = readTransitions({ stateDir, identityHash: ID }).map((r) => r.to);
  assert.ok(!tos.includes('REWORK'), 'no DECIDING->REWORK transition for a contract-stale decision');
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE', 'session untouched');
});

// ---- Issue #263 resume leg: route authority on a finalReview:FAIL tail -----
// A resume re-enters decide() WITHOUT running the ROUTED step, so routeValue
// would still be null and the dispatch would dereference it. The loop's own
// ROUTED->EXECUTING record is the ONLY authority for the route: it is
// restored from the ledger (never guessed, never caller-supplied), it must
// belong to THIS identity/session, and a missing/wrong record must typed-block
// BEFORE the DECIDING->REWORK transition or any executor dispatch.

const RECORDED_ROUTE = { executorKind: 'opencode', model: 'recorded-route-model' };

// Seeds the ledger exactly as an interrupted run leaves it: one routed
// execution, a full review walk, and a finalReview:FAIL own-FAIL tail. The
// ROUTED->EXECUTING record is appended raw so a fixture can express missing /
// foreign / malformed route evidence without touching any other transition.
function seedFinalReviewFailLedger(sessionPath, stateDir, ID, routeRecord) {
  const loop = bindLoop({ sessionPath, identityHash: ID, stateDir });
  const tPath = path.join(stateDir, 'control-loop', ID, 'transitions.jsonl');
  const seed = (from, to, evidence = null, reason = 'seed') => {
    assert.ok(loop.transition({ from, to, reason, evidence }).ok, `seed ${from}->${to}`);
  };
  const seedRaw = (record) => fs.appendFileSync(
    tPath,
    `${JSON.stringify({ schemaVersion: '1', ts: new Date().toISOString(), reason: 'seed', ...record })}\n`,
    'utf8',
  );
  seed('ACCEPTED', 'ROUTED');
  if (routeRecord !== null) {
    seedRaw({
      from: 'ROUTED', to: 'EXECUTING',
      evidence: routeRecord.evidence,
      identityHash: routeRecord.identityHash ?? ID,
      sessionPath: routeRecord.sessionPath ?? sessionPath,
    });
  }
  seed('EXECUTING', 'VERIFYING', { executionRecordPath: '/fake/exec.json' });
  seed('VERIFYING', 'PRE_REVIEWING', { verdict: 'PASS', report: 'ok' });
  seed('PRE_REVIEWING', 'FINAL_REVIEWING', { verdict: 'PASS', findings: [] });
  seed('FINAL_REVIEWING', 'BLOCKED', { ok: false, code: 'VERDICT_INPUT_INVALID', detail: 'response text is empty' }, 'finalReview:FAIL');
}

test('R11. finalReview:FAIL resume consumes the reconciled LATE response and re-dispatches with the recorded route authority', async (t) => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID, session } = mkSession(stateDir, { controlPlane: { stateDir }, prNumber: 266 });
  const execPath = mkExecRecord(stateDir, ID);
  const calls = [];
  const deps = baseDeps(stateDir, calls, execPath);

  // run #5 shape: the primary is a timeout snapshot and the SAME turn's full
  // reply arrives late and is reconciled against the existing request record.
  const fixture = reviewFixture({
    session: {
      repo: session.repo, issueNumber: session.issueNumber,
      prNumber: session.prNumber, headSha: session.headSha,
    },
    findings: ['finding-A', 'finding-B', 'finding-C'],
    remediation: ['repair-A', 'repair-B', 'repair-C'],
    evidenceRequests: ['evidence-A'],
  });
  t.after(fixture.cleanup);
  assert.equal(claimReviewSubmit(fixture.ctx.reviewRequest).ok, true);
  assert.equal(persistReviewResponse({
    request: fixture.ctx.reviewRequest,
    response: {
      ok: true, text: '', rawText: 'Gemini đã nói', newTurnId: 'r-new',
      targetId: 'target-review', conversationId: 'conversation-review',
      beforeTurnIds: ['r-old'], afterTurnIds: ['r-old', 'r-new'],
      pollTimeout: true, metadata: { pollTimeout: true },
    },
  }).ok, true);
  const lateRaw = `Gemini đã nói\nREVIEW_PAYLOAD_BEGIN\n${JSON.stringify(fixture.payload)}\nREVIEW_PAYLOAD_END\nVERDICT: CHANGES_REQUESTED`;
  assert.equal(reconcileLateReviewResponse({
    request: fixture.ctx.reviewRequest, late: { rawText: lateRaw, newTurnId: 'r-new' },
  }).ok, true);

  seedFinalReviewFailLedger(sessionPath, stateDir, ID, { evidence: RECORDED_ROUTE });

  // The canonical Web2API transport, wired so ANY browser submit throws: the
  // resume must resolve the round from the reconciled late reply alone.
  let submits = 0;
  const transport = await createGeminiWeb2ApiReviewTransport({
    rawTransport: async () => { submits += 1; throw new Error('MUST_NOT_RESUBMIT'); },
  });
  let finalReviewCalls = 0;
  deps.finalReview = async () => {
    calls.push('finalReview');
    finalReviewCalls += 1;
    if (finalReviewCalls > 1) {
      return { ok: true, value: { verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.99, metadata: {} } };
    }
    const r = await transport({ ...fixture.ctx, session: fixture.session });
    return r && r.ok === true ? { ok: true, value: r } : r;
  };
  let reworkCtx = null;
  const innerExecutor = deps.executor;
  deps.executor = (ctx) => {
    if (ctx.reworkInstruction) reworkCtx = { ...ctx };
    return innerExecutor(ctx);
  };

  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });

  assert.equal(submits, 0, 'the reconciled late response is consumed without a new browser submit');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  assert.deepEqual(calls, ['finalReview', 'executor:rework', 'verifier', 'preReview', 'finalReview', 'delivery']);
  assert.ok(reworkCtx, 'the rework leg dispatched exactly one executor');
  assert.equal(reworkCtx.executorKind, RECORDED_ROUTE.executorKind, 'executor authority comes from the ROUTED->EXECUTING record');
  assert.equal(reworkCtx.model, RECORDED_ROUTE.model, 'route comes from the ROUTED->EXECUTING record, never guessed');

  const ledger = readTransitions({ stateDir, identityHash: ID });
  const consumed = ledger.find((r) => r.from === 'FINAL_REVIEWING' && r.to === 'DECIDING' && r.reason === 'rework-leg-resume-review');
  assert.ok(consumed, 'the resume consumed the review at the DECIDING boundary');
  assert.equal(consumed.evidence.rawText, lateRaw, 'the consumed decision IS the reconciled late response');
  assert.ok(ledger.some((r) => r.from === 'DECIDING' && r.to === 'REWORK' && r.evidence.round === 1), 'DECIDING->REWORK recorded');
  assert.ok(ledger.some((r) => r.from === 'REWORK' && r.to === 'EXECUTING'), 'REWORK->EXECUTING recorded');
  assert.ok(!ledger.some((r) => r.from === 'REWORK' && r.to === 'BLOCKED'), 'never lands on rework-execute:THREW');
});

test('R12. missing or wrong route evidence typed-blocks BEFORE the rework transition and any dispatch', async () => {
  const cases = [
    ['no ROUTED->EXECUTING record at all', null, 'RESUME_ROUTE_EVIDENCE_MISSING'],
    ['route record without evidence', { evidence: null }, 'RESUME_ROUTE_EVIDENCE_MISSING'],
    ['authority without a model', { evidence: { executorKind: 'opencode' } }, 'RESUME_ROUTE_EVIDENCE_INVALID'],
    ['authority without an executorKind', { evidence: { model: 'x' } }, 'RESUME_ROUTE_EVIDENCE_INVALID'],
    ['route record from a foreign identity', { evidence: RECORDED_ROUTE, identityHash: 'f'.repeat(64) }, 'RESUME_ROUTE_EVIDENCE_INVALID'],
    ['route record from a foreign session', { evidence: RECORDED_ROUTE, sessionPath: '/foreign/sessions/x.json' }, 'RESUME_ROUTE_EVIDENCE_INVALID'],
  ];
  for (const [label, routeRecord, expected] of cases) {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir } });
    const calls = [];
    const deps = baseDeps(stateDir, calls, mkExecRecord(stateDir, ID));
    deps.finalReview = () => { calls.push('finalReview'); return { ok: true, value: reworkDecision() }; };
    seedFinalReviewFailLedger(sessionPath, stateDir, ID, routeRecord);

    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });

    assert.equal(res.ok, false, `${label}: ${JSON.stringify(res)}`);
    assert.equal(res.code, expected, label);
    const ledger = readTransitions({ stateDir, identityHash: ID });
    assert.ok(!ledger.some((r) => r.from === 'DECIDING' && r.to === 'REWORK'), `${label}: no DECIDING->REWORK`);
    assert.ok(!ledger.some((r) => r.from === 'REWORK'), `${label}: no REWORK edge at all`);
    assert.deepEqual(calls, ['finalReview'], `${label}: the reviewer round is consumed but no executor is dispatched`);
    assert.ok(!fs.existsSync(path.join(stateDir, 'control-loop', ID, 'rework')), `${label}: no rework record persisted`);
    assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE', `${label}: session untouched`);
  }
});

test('R13. relaunch after a completed rework dispatch never spawns a second executor', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir } });
  const execPath = mkExecRecord(stateDir, ID);
  const calls = [];
  const deps = baseDeps(stateDir, calls, execPath);

  // The dispatch marker shape a completed round leaves behind: the persisted
  // DECIDING->REWORK record immediately followed by REWORK->EXECUTING, then a
  // later finalReview:FAIL tail (the round-2 review never came back).
  const decision = reworkDecision();
  const digest = decisionDigest({ identityHash: ID, decision });
  const loop = bindLoop({ sessionPath, identityHash: ID, stateDir });
  const seed = (from, to, evidence = null, reason = 'seed') => {
    assert.ok(loop.transition({ from, to, reason, evidence }).ok, `seed ${from}->${to}`);
  };
  seed('ACCEPTED', 'ROUTED');
  seed('ROUTED', 'EXECUTING', RECORDED_ROUTE);
  seed('EXECUTING', 'VERIFYING', { executionRecordPath: execPath });
  seed('VERIFYING', 'PRE_REVIEWING', { verdict: 'PASS', report: 'ok' });
  seed('PRE_REVIEWING', 'FINAL_REVIEWING', { verdict: 'PASS', findings: [] });
  seed('FINAL_REVIEWING', 'DECIDING', decision, 'rework-leg-resume-review');
  seed('DECIDING', 'REWORK', { digest, round: 1, reworkPath: '/fake/rework.json', binding: decision.binding, findings: decision.findings, evidenceRequests: decision.evidenceRequests }, 'final-review-rework');
  seed('REWORK', 'EXECUTING', { executionRecordPath: execPath });
  seed('EXECUTING', 'VERIFYING', { executionRecordPath: execPath });
  seed('VERIFYING', 'PRE_REVIEWING', { verdict: 'PASS', report: 'ok' });
  seed('PRE_REVIEWING', 'FINAL_REVIEWING', { verdict: 'PASS', findings: [] });
  seed('FINAL_REVIEWING', 'BLOCKED', { ok: false, code: 'VERDICT_INPUT_INVALID', detail: 'response text is empty' }, 'finalReview:FAIL');

  deps.finalReview = () => { calls.push('finalReview'); return { ok: true, value: decision }; };

  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });

  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'REWORK_ALREADY_DISPATCHED');
  assert.deepEqual(calls, ['finalReview'], 'the review round is consumed but no second executor is spawned');
  const ledger = readTransitions({ stateDir, identityHash: ID });
  assert.equal(ledger.filter((r) => r.from === 'DECIDING' && r.to === 'REWORK').length, 1, 'no duplicate DECIDING->REWORK');
  assert.equal(ledger.filter((r) => r.from === 'REWORK' && r.to === 'EXECUTING').length, 1, 'no duplicate REWORK->EXECUTING');
  assert.ok(!ledger.some((r) => r.from === 'REWORK' && r.to === 'BLOCKED'), 'the already-dispatched guard fires before rework-execute');
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE');
});


test('R14. a repeated resume never spawns a second rework executor', async () => {
  // Phase A: the rework dispatch already happened (dispatch marker rows) and
  // the next review round never came back. Resuming twice must dispatch ZERO
  // additional executors and must not duplicate any dispatch row.
  {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir } });
    const execPath = mkExecRecord(stateDir, ID);
    const calls = [];
    const deps = baseDeps(stateDir, calls, execPath);
    const decision = reworkDecision();
    const digest = decisionDigest({ identityHash: ID, decision });
    const loop = bindLoop({ sessionPath, identityHash: ID, stateDir });
    const seed = (from, to, evidence = null, reason = 'seed') => {
      assert.ok(loop.transition({ from, to, reason, evidence }).ok, `seed ${from}->${to}`);
    };
    seed('ACCEPTED', 'ROUTED');
    seed('ROUTED', 'EXECUTING', RECORDED_ROUTE);
    seed('EXECUTING', 'VERIFYING', { executionRecordPath: execPath });
    seed('VERIFYING', 'PRE_REVIEWING', { verdict: 'PASS', report: 'ok' });
    seed('PRE_REVIEWING', 'FINAL_REVIEWING', { verdict: 'PASS', findings: [] });
    seed('FINAL_REVIEWING', 'DECIDING', decision, 'rework-leg-resume-review');
    seed('DECIDING', 'REWORK', { digest, round: 1, reworkPath: '/fake/rework.json', binding: decision.binding, findings: decision.findings, evidenceRequests: decision.evidenceRequests }, 'final-review-rework');
    seed('REWORK', 'EXECUTING', { executionRecordPath: execPath });
    seed('EXECUTING', 'VERIFYING', { executionRecordPath: execPath });
    seed('VERIFYING', 'PRE_REVIEWING', { verdict: 'PASS', report: 'ok' });
    seed('PRE_REVIEWING', 'FINAL_REVIEWING', { verdict: 'PASS', findings: [] });
    seed('FINAL_REVIEWING', 'BLOCKED', { ok: false, code: 'VERDICT_INPUT_INVALID', detail: 'response text is empty' }, 'finalReview:FAIL');
    deps.finalReview = () => { calls.push('finalReview'); return { ok: true, value: decision }; };

    const first = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
    assert.equal(first.ok, false, JSON.stringify(first));
    assert.equal(first.code, 'REWORK_ALREADY_DISPATCHED', 'the first resume stops at the dispatch marker');

    const second = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
    assert.equal(second.ok, false, JSON.stringify(second));
    assert.equal(second.code, 'REWORK_ALREADY_DISPATCHED', 'a repeated resume blocks exactly the same way');

    const ledger = readTransitions({ stateDir, identityHash: ID });
    assert.equal(calls.filter((c) => c === 'executor:rework').length, 0, 'neither resume reaches a rework executor');
    assert.equal(calls.filter((c) => c === 'executor:initial').length, 0, 'no initial executor either');
    assert.deepEqual(calls, ['finalReview'], 'the first resume consumes the round; the repeated resume reuses the already-obtained DECIDING tail instead of re-prompting the reviewer');
    assert.equal(ledger.filter((r) => r.from === 'DECIDING' && r.to === 'REWORK').length, 1, 'no duplicate DECIDING->REWORK');
    assert.equal(ledger.filter((r) => r.from === 'REWORK' && r.to === 'EXECUTING').length, 1, 'no duplicate REWORK->EXECUTING');
    assert.ok(!ledger.some((r) => r.from === 'REWORK' && r.to === 'BLOCKED'), 'never lands on rework-execute:THREW');
    assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE', 'the session stays resumable');
    assert.equal(fs.readdirSync(path.join(stateDir, 'executions')).length, 1, 'a single ExecutionRecord');
  }

  // Phase B: the rework has NOT been dispatched yet. The first resume
  // dispatches exactly one executor; the relaunch after it completed must
  // never dispatch a second one.
  {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir }, prNumber: 266 });
    const execPath = mkExecRecord(stateDir, ID);
    const calls = [];
    const deps = baseDeps(stateDir, calls, execPath);
    seedFinalReviewFailLedger(sessionPath, stateDir, ID, { evidence: RECORDED_ROUTE });
    let rounds = 0;
    deps.finalReview = () => {
      calls.push('finalReview');
      rounds += 1;
      return { ok: true, value: rounds === 1 ? reworkDecision() : { verdict: 'PASS', findings: [] } };
    };

    const first = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.value.state, 'COMPLETED');
    assert.equal(calls.filter((c) => c === 'executor:rework').length, 1, 'the first resume dispatches exactly one rework executor');

    const second = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
    assert.equal(second.ok, false, JSON.stringify(second));
    assert.equal(second.code, 'ALREADY_TERMINAL', 'a completed session refuses to run again');
    assert.equal(calls.filter((c) => c === 'executor:rework').length, 1, 'the relaunch never spawns a second rework executor');
    assert.equal(calls.filter((c) => c === 'executor:initial').length, 0, 'no initial executor either');

    const ledger = readTransitions({ stateDir, identityHash: ID });
    assert.equal(ledger.filter((r) => r.from === 'DECIDING' && r.to === 'REWORK').length, 1, 'exactly one DECIDING->REWORK');
    assert.equal(ledger.filter((r) => r.from === 'REWORK' && r.to === 'EXECUTING').length, 1, 'exactly one REWORK->EXECUTING');
    assert.equal(fs.readdirSync(path.join(stateDir, 'executions')).length, 1, 'a single ExecutionRecord');
  }
});

// Issue #264 — read off the BYTE-EXACT round-2 rework instruction: it rendered
// the reviewer's findings verbatim and never once told the executor to commit,
// while one remediation line asked it to commit `artifacts/diffs/pr-266-…`,
// which .gitignore excludes. The publish chain refuses to push a dirty
// worktree, so a round that does not advance HEAD can never be reviewed — the
// non-committing executor was following its instruction to the letter.
test('R15. the rework instruction states the commit obligation and separates the gitignored evidence export', () => {
  const stateDir = mkStateDir();
  const { id } = mkSession(stateDir, { controlPlane: { stateDir } });
  const decision = {
    verdict: 'REWORK',
    binding: { repository: 'duongpdddic-droid/soc_brain', issue: 79, pullRequest: 266, headSha: 'a'.repeat(40) },
    findings: ['marker file has no trailing newline'],
    remediation: ['Commit the newline fix and artifacts/diffs/pr-266-changes.diff to the task worktree'],
    evidenceRequests: ['attach the exported bundle'],
    confidence: 0.9,
  };
  const digest = decisionDigest({ identityHash: id, decision });
  const record = buildReworkRecord({ identityHash: id, round: 1, digest, decision });
  const instruction = buildReworkInstruction({
    session: { repo: 'duongpdddic-droid/soc_brain', issueNumber: 79 }, record,
  });

  // Issue #79 contract: the reviewer's payload still reaches the executor verbatim.
  assert.ok(instruction.includes('marker file has no trailing newline'));
  assert.ok(instruction.includes('Commit the newline fix and artifacts/diffs/pr-266-changes.diff'));
  assert.ok(instruction.includes('R1. attach the exported bundle'));

  // Issue #264: the commit obligation must be explicit and actionable.
  assert.ok(instruction.includes('COMMIT OBLIGATION'), 'the instruction must ask for the commit');
  assert.ok(instruction.includes('soc_broker_commit'), 'the canonical commit tool must be named');
  assert.ok(instruction.includes('git rev-parse HEAD'), 'HEAD read-back must be required before reporting done');

  // …and the unsatisfiable artifacts/** commit must be separated from it.
  assert.ok(instruction.includes('.gitignore'), 'the gitignored export path must be explained');
  assert.ok(instruction.includes('artifacts/**'), 'the exact non-committable glob must be named');
  assert.ok(instruction.includes('NEVER `git add`'), 'the executor must be told never to add it');

  // Scope + no test gaming stay in force alongside the new obligation.
  assert.ok(instruction.includes('Do NOT modify, skip, or weaken tests'));
  assert.ok(instruction.includes('Do NOT merge'));
});
