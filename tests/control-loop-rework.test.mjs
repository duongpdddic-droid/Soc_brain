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
  MAX_REWORK_ROUNDS,
  assertReworkBinding,
} from '../packages/control-loop/control-loop.mjs';
import { decisionDigest } from '../packages/control-loop/rework.mjs';
import { gptFinalReviewAdapter } from '../packages/control-loop/adapters.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

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
  // Re-invocation (retry): the resume branch re-obtains the review ONCE, the
  // replayed decision hits the dispatch-marker guard — still exactly one
  // rework dispatch, no executor call, session untouched.
  calls.length = 0;
  const res2 = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res2.ok, false);
  assert.equal(res2.code, 'REWORK_ALREADY_DISPATCHED');
  assert.deepEqual(calls, ['finalReview']);
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
    '', 'body', '',
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
