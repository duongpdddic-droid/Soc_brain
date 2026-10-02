import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiWeb2ApiReviewTransport, createGeminiWeb2ApiRawTransport, pollForModelResponse } from '../packages/control-loop/gemini-plus-web2api-copy.mjs';
import vm from 'node:vm';
import { recoverDecisionContract } from '../packages/control-loop/control-loop.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reviewFixture, persistedDecision } from './fixtures/web2api-review.mjs';
import { buildReviewPrompt } from '../packages/control-loop/review-payload.mjs';
import { persistReviewRequest, openReviewRound, resolveResumeReviewRound, persistReviewResponse, validateReviewProvenance, parseWeb2ApiReview, claimReviewSubmit, isTimeoutReviewResponse, readEffectiveReviewResponse, reconcileLateReviewResponse } from '../packages/control-loop/web2api-review-provenance.mjs';
import { buildReworkRecord, buildReworkInstruction } from '../packages/control-loop/rework.mjs';

test('Web2API refuses a response without a persisted request before accepting a verdict', async () => {
  const transport = await createGeminiWeb2ApiReviewTransport({ rawTransport: async () => ({ ok: true, text: 'VERDICT: APPROVED', rawText: 'VERDICT: APPROVED', newTurnId: 'r-new' }) });
  const result = await transport({ prompt: 'review' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'REVIEW_PROVENANCE_MISSING');
});

test('valid response preserves only findings plus complete remediation, raw DOM evidence and reviewer provenance', async (t) => {
  const remediation = 'Repair command and rationale. '.repeat(100);
  const fixture = reviewFixture({ findings: ['src/a.mjs:45 defect A', 'src/b.mjs:46 defect B'], remediation: [remediation], evidenceRequests: ['show regression output'], confidence: 0.9, analysis: Array.from({ length: 73 }, (_, i) => `diff summary ${i}`).join('\n') });
  t.after(fixture.cleanup);
  let calls = 0;
  const review = await createGeminiWeb2ApiReviewTransport({ rawTransport: async (ctx) => {
    calls++;
    const record = JSON.parse(fs.readFileSync(ctx.reviewRequest.requestPath, 'utf8'));
    assert.equal(record.submittedPrompt, ctx.prompt, 'exact submitted content exists before browser invocation');
    return fixture.response;
  } });
  const result = await review(fixture.ctx);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.findings, ['src/a.mjs:45 defect A', 'src/b.mjs:46 defect B']);
  assert.equal(result.rawText, fixture.response.rawText);
  const record = buildReworkRecord({ identityHash: 'id', round: 1, digest: 'd'.repeat(64), decision: result });
  assert.equal(record.provenance.source, 'gemini-web2api-review');
  assert.deepEqual(record.remediation, [remediation]);
  assert.ok(buildReworkInstruction({ session: fixture.session, record }).includes(remediation));
  const replay = await review(fixture.ctx);
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(calls, 1);
});

for (const [name, overrides, code] of [
  ['wrong request', { requestId: 'other-request' }, 'REVIEW_RESPONSE_REQUEST_MISMATCH'],
  ['wrong attempt', { attemptId: 'other-attempt' }, 'REVIEW_RESPONSE_REQUEST_MISMATCH'],
  ['wrong digest', { requestDigest: '0'.repeat(64) }, 'REVIEW_RESPONSE_REQUEST_MISMATCH'],
  ['wrong binding', { binding: { repository: 'other/repo', issue: 1, pullRequest: 1, headSha: 'b'.repeat(40) } }, 'REVIEW_PROVENANCE_MISMATCH'],
  ['malformed findings', { findings: [7] }, 'REVIEW_PAYLOAD_MALFORMED'],
  ['missing remediation', { remediation: undefined }, 'REVIEW_PAYLOAD_MALFORMED'],
  ['too many findings', { findings: Array(51).fill('defect') }, 'REVIEW_PAYLOAD_LIMIT_EXCEEDED'],
  ['oversize remediation', { remediation: ['x'.repeat(20001)] }, 'REVIEW_PAYLOAD_LIMIT_EXCEEDED'],
]) {
  test(`${name} fails typed; response evidence stays intact`, async (t) => {
    const fixture = reviewFixture({ payloadOverrides: overrides });
    t.after(fixture.cleanup);
    const review = await createGeminiWeb2ApiReviewTransport({ rawTransport: async () => fixture.response });
    const result = await review(fixture.ctx);
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(JSON.parse(fs.readFileSync(fixture.ctx.reviewRequest.responsePath, 'utf8')).rawText, fixture.response.rawText);
  });
}

test('recovery accepts only an existing exact request/response pair and rejects stale HEAD or edited decision', (t) => {
  const fixture = reviewFixture(); t.after(fixture.cleanup);
  const decision = persistedDecision(fixture);
  const stale = { ...decision }; delete stale.findings; delete stale.evidenceRequests; delete stale.remediation;
  assert.deepEqual(recoverDecisionContract({ decision: stale, session: fixture.session }).findings, ['Finding 1: defect']);
  assert.equal(validateReviewProvenance({ decision, session: { ...fixture.session, headSha: 'b'.repeat(40) } }).code, 'REVIEW_PROVENANCE_MISMATCH');
  assert.equal(validateReviewProvenance({ decision: { ...decision, findings: ['fabricated'] }, session: fixture.session }).code, 'REVIEW_DECISION_PAYLOAD_MISMATCH');
});

test('a replay missing remediation must recover it or block, never silently dispatch an empty instruction', (t) => {
  const fixture = reviewFixture({ remediation: ['Apply the complete reviewer repair.'] }); t.after(fixture.cleanup);
  const decision = persistedDecision(fixture); delete decision.remediation;
  const recovered = recoverDecisionContract({ decision, session: fixture.session });
  assert.deepEqual(recovered.remediation, ['Apply the complete reviewer repair.']);
  assert.equal(validateReviewProvenance({ decision, session: fixture.session }).code, 'REVIEW_DECISION_PAYLOAD_MISSING');
});

test('an unsubmitted request can be superseded by a fresh prompt; a submitted-unanswered request blocks it', (t) => {
  const fixture = reviewFixture(); t.after(fixture.cleanup);
  const reusable = persistReviewRequest({ session: fixture.session, prompt: 'Full diff and tests', storeDir: fixture.storeDir });
  assert.equal(reusable.ok, true);
  assert.equal(reusable.value.requestId, fixture.ctx.reviewRequest.requestId);

  // Never claimed a submit -> provably never reached Chrome/DOM, so a fresh
  // prompt is allowed to supersede it with its own request id.
  const superseded = persistReviewRequest({ session: fixture.session, prompt: 'same HEAD with a changed prompt timestamp', storeDir: fixture.storeDir });
  assert.equal(superseded.ok, true, JSON.stringify(superseded));
  assert.notEqual(superseded.value.requestId, fixture.ctx.reviewRequest.requestId, 'fresh prompt gets a fresh request id');
  assert.ok(fs.existsSync(superseded.value.requestPath), 'superseding record is resolvable in the lookup store');
  assert.ok(fs.existsSync(fixture.ctx.reviewRequest.requestPath), 'the superseded record is left intact, never deleted');

  // Submitted but never answered -> in flight: strictly fail closed.
  assert.equal(claimReviewSubmit(fixture.ctx.reviewRequest).ok, true);
  assert.equal(
    persistReviewRequest({ session: fixture.session, prompt: 'third prompt while round 1 is unanswered', storeDir: fixture.storeDir }).code,
    'REVIEW_REQUEST_UNRESOLVED',
  );

  assert.equal(persistReviewRequest({ session: fixture.session, prompt: 'x'.repeat(1_000_000), storeDir: fixture.storeDir }).code, 'REVIEW_REQUEST_PROMPT_TOO_LARGE');
  assert.equal(parseWeb2ApiReview('Heading\nFinding 1: defect\nVERDICT: CHANGES_REQUESTED').code, 'REVIEW_PAYLOAD_MALFORMED');
  assert.equal(parseWeb2ApiReview(fixture.response.text.replace('REVIEW_PAYLOAD_END', '')).code, 'REVIEW_PAYLOAD_MALFORMED');
});

test('binding JSON key order does not reject a valid reviewer echo', async (t) => {
  const fixture = reviewFixture({ payloadOverrides: { binding: { headSha: 'a'.repeat(40), pullRequest: 263, issue: 69, repository: 'duongpdddic-droid/soc_brain' } } });
  t.after(fixture.cleanup);
  const review = await createGeminiWeb2ApiReviewTransport({ rawTransport: async () => fixture.response });
  assert.equal((await review(fixture.ctx)).ok, true);
});

test('polling reads the submitted turn even when a different response is newest', async () => {
  const response = (id, text) => ({ innerText: text, querySelector: () => ({ getAttribute: () => `BardVeMetadataKey:${Buffer.from(JSON.stringify([[id, 'c-review']])).toString('base64')}` }) });
  const expected = 'The response belonging to the submitted request is complete.';
  const document = { querySelectorAll: (selector) => selector === 'model-response' ? [response('r-submitted', expected), response('r-foreign', 'Wrong response that must never be accepted.')] : [] };
  const session = { send: async (_, args) => ({ result: { result: { value: vm.runInNewContext(args.expression, { document, atob }) } } }) };
  const result = await pollForModelResponse(session, { expectedTurnId: 'r-submitted', pollIntervalMs: 1, minStableRounds: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.text, expected);
  assert.equal(result.newTurnId, 'r-submitted');
});

// Issue #263 D1: polling must never launder a header-only or partially
// rendered DOM snapshot into success (proven root cause of
// VERDICT_INPUT_INVALID on run #5: rawText "Gemini đã nói" + length>10
// fallback). Clock seam: tiny timeouts + ms-scale poll intervals, so no test
// ever waits out a real 120s deadline.
const pollHeader = 'Gemini đã nói';

function pollResponseElement(id, readText) {
  return {
    get innerText() { return readText(); },
    get textContent() { return readText(); },
    querySelector: (selector) => (selector === 'response-container[jslog]'
      ? { getAttribute: () => `BardVeMetadataKey:${Buffer.from(JSON.stringify([[id, 'c-review']])).toString('base64')}` }
      : null),
  };
}

function fakePollSession({ readText }) {
  let evaluations = 0;
  return {
    get evaluations() { return evaluations; },
    send: async (_method, args) => {
      evaluations += 1;
      const document = {
        querySelectorAll: (selector) => {
          if (selector === 'model-response') return [pollResponseElement('r-expected', () => readText(evaluations))];
          if (selector === 'button, [role="button"]') return [];
          return [];
        },
      };
      return { result: { result: { value: vm.runInNewContext(args.expression, { document, atob }) } } };
    },
  };
}

const pollOpts = { expectedTurnId: 'r-expected', timeoutMs: 50, initialWaitTimeoutMs: 30, pollIntervalMs: 2, minStableRounds: 2 };

test('a header-only reply that reaches the deadline is REVIEW_TIMEOUT, never success', async () => {
  const session = fakePollSession({ readText: () => pollHeader });
  const result = await pollForModelResponse(session, { ...pollOpts });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, 'REVIEW_TIMEOUT');
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(result.rawText, pollHeader, 'raw DOM snapshot stays attached for late-response reconciliation');
  assert.equal(result.newTurnId, 'r-expected', 'turn identity stays attached');
  assert.equal(result.timeout, true, 'timeout metadata stays attached');
});

test('a growing partial reply at the deadline is never accepted', async () => {
  const session = fakePollSession({ readText: (n) => `partial review chunk ${'x'.repeat(n * 8)}` });
  const result = await pollForModelResponse(session, { ...pollOpts });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, 'REVIEW_TIMEOUT');
  assert.equal(typeof result.text, 'undefined', 'partial content must never be laundered into a text payload');
});

test('the completed reply of the submitted turn is read verbatim', async () => {
  const full = `${pollHeader}\n\nFinding 1: defect A\nVERDICT: CHANGES_REQUESTED`;
  const session = fakePollSession({ readText: (n) => (n <= 2 ? pollHeader : full) });
  const result = await pollForModelResponse(session, { ...pollOpts });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.text, full);
  assert.equal(result.newTurnId, 'r-expected');
});

test('raw transport refuses a poll response carrying a different turn ID', async () => {
  let reads = 0;
  const raw = await createGeminiWeb2ApiRawTransport({
    listTargetsImpl: () => [{ type: 'page', url: 'https://gemini.google.com/app/abcdef', targetId: 'target', webSocketDebuggerUrl: 'ws://offline' }],
    cdpSessionFactory: () => ({ close() {} }),
    readTurnIdsImpl: async () => ++reads === 1 ? ['r-old'] : ['r-old', 'r-new'],
    submitImpl: async () => ({ ok: true }),
    pollImpl: async (_, opts) => { assert.equal(opts.expectedTurnId, 'r-new'); return { ok: true, text: 'stale response', newTurnId: 'r-old' }; },
  });
  assert.equal((await raw({ prompt: 'review' })).code, 'REVIEW_RESPONSE_TURN_MISMATCH');
});

test('pre-submit browser rejection keeps the immutable request retryable and submits once after recovery', async (t) => {
  const fixture = reviewFixture(); t.after(fixture.cleanup);
  const unavailable = await createGeminiWeb2ApiRawTransport({ listTargetsImpl: () => [] });
  const firstReview = await createGeminiWeb2ApiReviewTransport({ rawTransport: unavailable });
  assert.equal((await firstReview(fixture.ctx)).code, 'WEB2API_COPY_UNAVAILABLE');
  assert.equal(fs.existsSync(fixture.ctx.reviewRequest.requestPath.replace('.request.json', '.submit.json')), false);

  const reused = persistReviewRequest({ session: fixture.session, prompt: 'Full diff and tests', storeDir: fixture.storeDir });
  assert.equal(reused.ok, true, JSON.stringify(reused));
  assert.equal(reused.value.requestId, fixture.ctx.reviewRequest.requestId);
  let sends = 0;
  const recovered = await createGeminiWeb2ApiReviewTransport({ rawTransport: async (ctx) => {
    sends += 1;
    assert.equal((await ctx.onSubmitBoundary()).ok, true);
    return fixture.response;
  } });
  assert.equal((await recovered({ ...fixture.ctx, reviewRequest: reused.value, prompt: reused.prompt })).ok, true);
  assert.equal(sends, 1);
});

test('lost acknowledgement after browser write is ambiguous and never sends twice', async (t) => {
  const fixture = reviewFixture(); t.after(fixture.cleanup);
  let writes = 0;
  const raw = async (ctx) => {
    writes += 1;
    const boundary = await ctx.onSubmitBoundary();
    if (!boundary.ok) return boundary;
    return { ok: false, code: 'TURN_NOT_OBSERVED' };
  };
  const review = await createGeminiWeb2ApiReviewTransport({ rawTransport: raw });
  assert.equal((await review(fixture.ctx)).code, 'TURN_NOT_OBSERVED');
  assert.equal((await review(fixture.ctx)).code, 'REVIEW_REQUEST_ALREADY_SUBMITTED');
  assert.equal(writes, 2, 'retry enters reconciliation but browser write callback refuses the second send');
});

test('persisted response interrupted before DECIDING reconciles without another browser submit', async (t) => {
  const fixture = reviewFixture(); t.after(fixture.cleanup);
  let sends = 0;
  const review = await createGeminiWeb2ApiReviewTransport({ rawTransport: async (ctx) => {
    sends += 1;
    assert.equal((await ctx.onSubmitBoundary()).ok, true);
    return fixture.response;
  } });
  assert.equal((await review(fixture.ctx)).ok, true);
  const replay = await review(fixture.ctx);
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(sends, 1);
});

test('transport exceptions preserve the browser-write boundary across crash windows', async (t) => {
  const pre = reviewFixture(); t.after(pre.cleanup);
  const beforeWrite = await createGeminiWeb2ApiReviewTransport({ rawTransport: async () => { throw new Error('target vanished'); } });
  assert.equal((await beforeWrite(pre.ctx)).code, 'GEMINI_TRANSPORT_EXCEPTION');
  assert.equal(fs.existsSync(pre.ctx.reviewRequest.requestPath.replace('.request.json', '.submit.json')), false);
  assert.equal(persistReviewRequest({ session: pre.session, prompt: 'Full diff and tests', storeDir: pre.storeDir }).ok, true);

  const post = reviewFixture(); t.after(post.cleanup);
  let writes = 0;
  const afterWrite = await createGeminiWeb2ApiReviewTransport({ rawTransport: async (ctx) => {
    writes += 1;
    const boundary = await ctx.onSubmitBoundary();
    if (!boundary.ok) return boundary;
    throw new Error('socket lost after click');
  } });
  assert.equal((await afterWrite(post.ctx)).code, 'GEMINI_TRANSPORT_EXCEPTION');
  assert.equal((await afterWrite(post.ctx)).code, 'REVIEW_REQUEST_ALREADY_SUBMITTED');
  assert.equal(writes, 2);
  const history = fs.readFileSync(post.ctx.reviewRequest.requestPath.replace('.request.json', '.attempts.jsonl'), 'utf8');
  assert.match(history, /WRITE_STARTED/);
  assert.match(history, /SUBMIT_OUTCOME_UNKNOWN/);
});

test('legacy #260 rawText cannot manufacture provenance or recover missing fields', () => {
  const decision = { verdict: 'REWORK', rawText: 'Finding: broken\nVERDICT: CHANGES_REQUESTED' };
  assert.equal(recoverDecisionContract({ decision, session: { repo: 'duongpdddic-droid/Soc_brain', issueNumber: 260, headSha: 'a'.repeat(40) } }), decision);
});

test('a fully resolved previous round never blocks the next round request record', (t) => {
  const fixture = reviewFixture(); t.after(fixture.cleanup);
  assert.equal(persistedDecision(fixture).verdict, 'REWORK');

  const next = persistReviewRequest({ session: fixture.session, prompt: 'Full diff and tests (round 2 after rework)', storeDir: fixture.storeDir });
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.notEqual(next.value.requestId, fixture.ctx.reviewRequest.requestId, 'round 2 gets its own request id');
  assert.equal(next.reused, undefined, 'round 2 must not be reported as a reuse of round 1');
  assert.equal(fs.existsSync(next.value.requestPath), true, 'round 2 request id is resolvable in the lookup store');
  assert.equal(fs.existsSync(fixture.ctx.reviewRequest.requestPath), true, 'round 1 record stays intact');

  const inflight = reviewFixture(); t.after(inflight.cleanup);
  assert.equal(claimReviewSubmit(inflight.ctx.reviewRequest).ok, true);
  assert.equal(
    persistReviewRequest({ session: inflight.session, prompt: 'different prompt while round 1 is still in flight', storeDir: inflight.storeDir }).code,
    'REVIEW_REQUEST_UNRESOLVED',
    'an unanswered submitted request still fails closed',
  );
});

// ---- Issue #263: late-response reconciliation for run #5 ---------------------
// Run #5 persisted a header-only timeout snapshot (pollTimeout, text:'') and
// the reviewer's full reply arrived AFTER the deadline on the SAME turn. The
// canonical path must recover that late reply against the existing
// request/attempt record — never overwrite the timeout evidence, never
// resubmit a fresh Reviewer round.

function makeTimeoutPrimary(fixture) {
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
}

function lateRawFor(fixture, payloadOverrides = {}) {
  const payload = { ...fixture.payload, ...payloadOverrides };
  return `Gemini đã nói\nREVIEW_PAYLOAD_BEGIN\n${JSON.stringify(payload)}\nREVIEW_PAYLOAD_END\nVERDICT: CHANGES_REQUESTED`;
}

const latePathOf = (request) => request.requestPath.replace('.request.json', '.response.late.json');

test('timeout detection covers both persisted timeout shapes', () => {
  assert.equal(isTimeoutReviewResponse({ ok: true, text: '', rawText: 'Gemini đã nói', pollTimeout: true }), true, 'run #5 shape');
  assert.equal(isTimeoutReviewResponse({ ok: false, code: 'REVIEW_TIMEOUT', rawText: 'Gemini đã nói', timeout: true }), true, 'fail-closed shape');
  assert.equal(isTimeoutReviewResponse({ ok: true, text: 'VERDICT: APPROVED', rawText: 'x\nVERDICT: APPROVED', pollTimeout: false }), false, 'resolved round');
});

test('readEffectiveReviewResponse keeps a resolved round on its primary response', (t) => {
  const fixture = reviewFixture(); t.after(fixture.cleanup);
  persistedDecision(fixture);
  const eff = readEffectiveReviewResponse(fixture.ctx.reviewRequest);
  assert.equal(eff.ok, true, JSON.stringify(eff));
  assert.equal(eff.value.rawText, fixture.response.rawText);
  assert.equal(eff.value.lateReconciled, undefined);
});

test('a timeout round without a late reply stays the timeout snapshot', (t) => {
  const fixture = reviewFixture(); t.after(fixture.cleanup);
  makeTimeoutPrimary(fixture);
  const eff = readEffectiveReviewResponse(fixture.ctx.reviewRequest);
  assert.equal(eff.ok, true, JSON.stringify(eff));
  assert.equal(eff.value.pollTimeout, true);
  assert.equal(eff.value.text, '');
  assert.equal(fs.existsSync(latePathOf(fixture.ctx.reviewRequest)), false);
});

test('the late reply of the same turn reconciles a timeout round without a new submit', async (t) => {
  const fixture = reviewFixture(); t.after(fixture.cleanup);
  makeTimeoutPrimary(fixture);
  const lateRaw = lateRawFor(fixture);

  const result = reconcileLateReviewResponse({ request: fixture.ctx.reviewRequest, late: { rawText: lateRaw, newTurnId: 'r-new' } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.verdict, 'CHANGES_REQUESTED');
  assert.equal(fs.existsSync(latePathOf(fixture.ctx.reviewRequest)), true, 'late evidence is persisted as its own file');

  const eff = readEffectiveReviewResponse(fixture.ctx.reviewRequest);
  assert.equal(eff.ok, true, JSON.stringify(eff));
  assert.equal(eff.value.lateReconciled, true);
  assert.equal(eff.value.pollTimeout, false, 'the effective response no longer claims a timeout');
  assert.equal(eff.value.text, lateRaw.split('\n').slice(1).join('\n'), 'speaker label stripped from the late reply');

  let sends = 0;
  const review = await createGeminiWeb2ApiReviewTransport({ rawTransport: async () => { sends += 1; return fixture.response; } });
  const replay = await review(fixture.ctx);
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(sends, 0, 'reconciliation must never resubmit to the browser');
  assert.equal(replay.verdict, 'CHANGES_REQUESTED');
  assert.equal(replay.rawText, lateRaw);
  const attempts = fs.readFileSync(fixture.ctx.reviewRequest.requestPath.replace('.request.json', '.attempts.jsonl'), 'utf8');
  assert.match(attempts, /LATE_RESPONSE_RECONCILED/);
});

test('a late reply echoing a foreign request is rejected and never persisted', (t) => {
  const fixture = reviewFixture(); t.after(fixture.cleanup);
  makeTimeoutPrimary(fixture);
  const result = reconcileLateReviewResponse({ request: fixture.ctx.reviewRequest, late: { rawText: lateRawFor(fixture, { requestId: 'other-request' }), newTurnId: 'r-new' } });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, 'REVIEW_RESPONSE_REQUEST_MISMATCH');
  assert.equal(fs.existsSync(latePathOf(fixture.ctx.reviewRequest)), false);
});

test('a late reply from a different turn is rejected', (t) => {
  const fixture = reviewFixture(); t.after(fixture.cleanup);
  makeTimeoutPrimary(fixture);
  const result = reconcileLateReviewResponse({ request: fixture.ctx.reviewRequest, late: { rawText: lateRawFor(fixture), newTurnId: 'r-foreign' } });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, 'REVIEW_RESPONSE_TURN_MISMATCH');
  assert.equal(fs.existsSync(latePathOf(fixture.ctx.reviewRequest)), false);
});

test('a resolved round never accepts a late overwrite', (t) => {
  const fixture = reviewFixture(); t.after(fixture.cleanup);
  persistedDecision(fixture);
  const result = reconcileLateReviewResponse({ request: fixture.ctx.reviewRequest, late: { rawText: lateRawFor(fixture), newTurnId: 'r-new' } });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, 'REVIEW_LATE_RESPONSE_NOT_PENDING');
});

test('a late reply that is only a speaker header is rejected as invalid', (t) => {
  const fixture = reviewFixture(); t.after(fixture.cleanup);
  makeTimeoutPrimary(fixture);
  const result = reconcileLateReviewResponse({ request: fixture.ctx.reviewRequest, late: { rawText: 'Gemini đã nói', newTurnId: 'r-new' } });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, 'REVIEW_LATE_RESPONSE_INVALID');
});

test('reconciling twice is idempotent; a different late reply conflicts and the original evidence wins', (t) => {
  const fixture = reviewFixture(); t.after(fixture.cleanup);
  makeTimeoutPrimary(fixture);
  const lateRaw = lateRawFor(fixture);
  assert.equal(reconcileLateReviewResponse({ request: fixture.ctx.reviewRequest, late: { rawText: lateRaw, newTurnId: 'r-new' } }).ok, true);

  const again = reconcileLateReviewResponse({ request: fixture.ctx.reviewRequest, late: { rawText: lateRaw, newTurnId: 'r-new' } });
  assert.equal(again.ok, true, JSON.stringify(again));

  const conflicting = reconcileLateReviewResponse({ request: fixture.ctx.reviewRequest, late: { rawText: lateRawFor(fixture, { findings: ['a different finding'] }), newTurnId: 'r-new' } });
  assert.equal(conflicting.ok, false, JSON.stringify(conflicting));
  assert.equal(conflicting.code, 'REVIEW_LATE_RESPONSE_CONFLICT');
  assert.equal(JSON.parse(fs.readFileSync(latePathOf(fixture.ctx.reviewRequest), 'utf8')).rawText, lateRaw, 'first late evidence is never replaced');
});

test('the next round request record reuses the reconciled round instead of resubmitting', (t) => {
  const fixture = reviewFixture(); t.after(fixture.cleanup);
  makeTimeoutPrimary(fixture);
  assert.equal(reconcileLateReviewResponse({ request: fixture.ctx.reviewRequest, late: { rawText: lateRawFor(fixture), newTurnId: 'r-new' } }).ok, true);

  const next = persistReviewRequest({ session: fixture.session, prompt: 'Full diff and tests', storeDir: fixture.storeDir });
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal(next.reconciliation, 'LATE_RESPONSE_RECONCILED');
  assert.equal(next.value.requestId, fixture.ctx.reviewRequest.requestId);
  assert.equal(next.value.lateResponsePath, latePathOf(fixture.ctx.reviewRequest));
  assert.equal(next.value.responsePath, fixture.ctx.reviewRequest.responsePath, 'the primary response path binding stays canonical');
});

test('a poll timeout keeps the raw snapshot through the raw transport fail path', async () => {
  let reads = 0;
  const raw = await createGeminiWeb2ApiRawTransport({
    listTargetsImpl: () => [{ type: 'page', url: 'https://gemini.google.com/app/abcdef', targetId: 'target', webSocketDebuggerUrl: 'ws://offline' }],
    cdpSessionFactory: () => ({ close() {} }),
    readTurnIdsImpl: async () => (++reads === 1 ? ['r-old'] : ['r-old', 'r-new']),
    submitImpl: async () => ({ ok: true }),
    pollImpl: async (_, opts) => {
      assert.equal(opts.expectedTurnId, 'r-new');
      return { ok: false, code: 'REVIEW_TIMEOUT', verdict: 'BLOCKED', detail: 'Model response polling timed out', rawText: 'Gemini đã nói', newTurnId: 'r-new', timeout: true };
    },
  });
  const result = await raw({ prompt: 'review' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'REVIEW_TIMEOUT');
  assert.equal(result.rawText, 'Gemini đã nói');
  assert.equal(result.newTurnId, 'r-new');
  assert.equal(result.timeout, true);
});

test('a poll timeout persists the timeout response snapshot for later reconciliation', async (t) => {
  const fixture = reviewFixture(); t.after(fixture.cleanup);
  const review = await createGeminiWeb2ApiReviewTransport({ rawTransport: async (ctx) => {
    assert.equal((await ctx.onSubmitBoundary()).ok, true);
    return { ok: false, code: 'REVIEW_TIMEOUT', verdict: 'BLOCKED', detail: 'Model response polling timed out', rawText: 'Gemini đã nói', newTurnId: 'r-new', timeout: true };
  } });
  const result = await review(fixture.ctx);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'REVIEW_TIMEOUT');
  const persisted = JSON.parse(fs.readFileSync(fixture.ctx.reviewRequest.responsePath, 'utf8'));
  assert.equal(persisted.rawText, 'Gemini đã nói');
  assert.equal(persisted.newTurnId, 'r-new');
  assert.equal(persisted.timeout, true);
  assert.equal(persisted.requestId, fixture.ctx.reviewRequest.requestId);
  assert.equal(isTimeoutReviewResponse(persisted), true);
});

// ---------------------------------------------------------------------------
// Issue #263 — resume of an already-SENT review round.
// A FINAL_REVIEWING resume rebuilds the final-review prompt with a fresh
// `- timestamp:` line, so exact prompt equality can never find the round again:
// the resume used to write a SECOND request record and fire a second browser
// submit for a round the reviewer had already answered (the smoke run timed out
// and was reconciled late). These regressions pin the resume gate.
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mkStore(t) {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-resume-'));
  t.after(() => { try { fs.rmSync(storeDir, { recursive: true, force: true }); } catch { /* temp dir */ } });
  return storeDir;
}

const RESUME_SESSION = { repo: 'duongpdddic-droid/Soc_brain', issueNumber: 264, prNumber: 266, headSha: 'a'.repeat(40) };

function promptCommon(overrides = {}) {
  return {
    prNumber: 266,
    headSha: 'a'.repeat(40),
    diffContent: 'diff --git a/README.md b/README.md\n-old\n+new\n',
    contextMetadata: { repository: 'duongpdddic-droid/Soc_brain', issueNumber: 264, goal: 'Smoke rework', targetBranch: 'main', identityHash: 'ea3d278b380b297c43772cad738637d3' },
    testLog: '',
    bundleInfo: null,
    ...overrides,
  };
}

// The real final-review prompt builder: it stamps `- timestamp:` on every call,
// which is exactly what makes a resumed round unfindable by exact equality.
function buildPrompt(overrides = {}) {
  const built = buildReviewPrompt(promptCommon(overrides));
  assert.equal(built.ok, true, JSON.stringify(built));
  return built.prompt;
}

// A round exactly as run #5 left it: request written, browser submit claimed,
// poll timed out, and the SAME turn's real reply reconciled afterwards.
function seedSentReconciledRound(session, prompt, storeDir) {
  const prepared = persistReviewRequest({ session, prompt, storeDir });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const request = prepared.value;
  assert.equal(claimReviewSubmit(request).ok, true);
  assert.equal(persistReviewResponse({
    request,
    response: {
      ok: true, text: '', rawText: 'Gemini đã nói', newTurnId: 'r-new',
      targetId: 'target-review', conversationId: 'conversation-review',
      beforeTurnIds: ['r-old'], afterTurnIds: ['r-old', 'r-new'],
      pollTimeout: true, metadata: { pollTimeout: true },
    },
  }).ok, true);
  const record = JSON.parse(fs.readFileSync(request.requestPath, 'utf8'));
  const payload = {
    binding: record.binding, requestId: record.requestId, attemptId: record.attemptId, requestDigest: record.requestDigest,
    findings: [`late-finding-${record.requestId.slice(0, 8)}`], remediation: ['repair it'], evidenceRequests: ['show evidence'], confidence: 1,
  };
  const rawText = `Gemini đã nói\nREVIEW_PAYLOAD_BEGIN\n${JSON.stringify(payload)}\nREVIEW_PAYLOAD_END\nVERDICT: CHANGES_REQUESTED`;
  assert.equal(reconcileLateReviewResponse({ request, late: { rawText, newTurnId: 'r-new' } }).ok, true, 'the late reply of the same turn reconciles');
  return { ...request, record, rawText, payload };
}

test('Issue #263 (R1). a resumed prompt with a NEW timestamp consumes the reconciled round with zero browser submit', async (t) => {
  const storeDir = mkStore(t);
  const session = { ...RESUME_SESSION };
  const originalPrompt = buildPrompt();
  await sleep(3);
  const resumePrompt = buildPrompt();
  assert.notEqual(resumePrompt, originalPrompt, 'REPRO: the resume rebuilds the prompt with a fresh - timestamp: line');

  const round = seedSentReconciledRound(session, originalPrompt, storeDir);
  const requestCount = () => fs.readdirSync(storeDir).filter((n) => n.endsWith('.request.json')).length;
  const before = requestCount();

  const opened = openReviewRound({ session, prompt: resumePrompt, storeDir, consumedRequestIds: [] });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.resumed, true, 'the SENT round is resumed, never re-opened');
  assert.equal(opened.value.requestId, round.record.requestId);
  assert.equal(opened.reconciliation, 'LATE_RESPONSE_RECONCILED');
  assert.equal(opened.value.lateResponsePath, path.join(storeDir, `${round.record.requestId}.response.late.json`));
  assert.equal(opened.prompt, round.record.submittedPrompt, 'the ORIGINAL submitted prompt is replayed verbatim');
  assert.equal(requestCount(), before, 'no second request record was written');

  // Repeated resume: the same round is chosen again, still with no new record.
  const again = openReviewRound({ session, prompt: resumePrompt, storeDir, consumedRequestIds: [] });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.value.requestId, round.record.requestId, 'a repeated resume is idempotent');
  assert.equal(requestCount(), before, 'a repeated resume never opens a duplicate round');

  // The canonical transport, with ANY browser submit wired to throw.
  let submits = 0;
  const transport = await createGeminiWeb2ApiReviewTransport({
    rawTransport: async () => { submits += 1; throw new Error('MUST_NOT_RESUBMIT'); },
  });
  const decision = await transport({ prompt: opened.prompt, reviewRequest: opened.value, session });
  assert.equal(submits, 0, 'browser submit = 0: the replay guard finds the persisted response');
  assert.equal(decision.ok, true, JSON.stringify(decision));
  assert.equal(decision.verdict, 'CHANGES_REQUESTED');
  assert.deepEqual(decision.findings, [round.payload.findings[0]], 'the verdict IS the reconciled late reply');
  assert.equal(decision.provenance.requestId, round.record.requestId, 'the decision stays linked to the ORIGINAL round');
});

test('Issue #263 (R2). a wrong HEAD/round is never paired by HEAD alone and ambiguous candidates typed-block before any write or submit', async (t) => {
  const storeDir = mkStore(t);
  const session = { ...RESUME_SESSION };
  const p1 = buildPrompt();
  await sleep(3);
  const p2 = buildPrompt();
  await sleep(3);
  const p3 = buildPrompt();

  const round1 = seedSentReconciledRound(session, p1, storeDir);
  const round2 = seedSentReconciledRound(session, p2, storeDir);
  assert.notEqual(round1.record.requestId, round2.record.requestId, 'two separately SENT rounds exist');
  const requestCount = () => fs.readdirSync(storeDir).filter((n) => n.endsWith('.request.json')).length;
  assert.equal(requestCount(), 2);

  // (a) wrong HEAD: a round bound to another HEAD is never selected — a
  // response is never paired to a HEAD alone.
  const wrongHead = resolveResumeReviewRound({ session: { ...session, headSha: 'c'.repeat(40) }, prompt: p3, storeDir, consumedRequestIds: [] });
  assert.equal(wrongHead.ok, true, JSON.stringify(wrongHead));
  assert.equal(wrongHead.value, null, 'a round bound to a different HEAD is never selected');

  // (b) wrong round: a prompt whose diff content differs is a different round.
  const wrongRound = resolveResumeReviewRound({ session, prompt: buildPrompt({ diffContent: 'diff --git a/f b/f\n-different\n' }), storeDir, consumedRequestIds: [] });
  assert.equal(wrongRound.ok, true, JSON.stringify(wrongRound));
  assert.equal(wrongRound.value, null, 'a prompt with different diff content never matches');

  // (c) two indistinguishable candidates -> typed block BEFORE any request
  // record is written and before the transport can claim a browser submit.
  const ambiguous = openReviewRound({ session, prompt: p3, storeDir, consumedRequestIds: [] });
  assert.equal(ambiguous.ok, false, JSON.stringify(ambiguous));
  assert.equal(ambiguous.code, 'REVIEW_RESUME_ROUND_AMBIGUOUS');
  assert.deepEqual([...ambiguous.detail].sort(), [round1.record.requestId, round2.record.requestId].sort(), 'both candidates are reported');
  assert.equal(requestCount(), 2, 'no third request record was written on the typed block');

  // (d) the FSM checkpoint disambiguates deterministically: consuming one
  // round leaves exactly one candidate, which then resumes.
  const resolved = openReviewRound({ session, prompt: p3, storeDir, consumedRequestIds: [round1.record.requestId] });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.equal(resolved.resumed, true);
  assert.equal(resolved.value.requestId, round2.record.requestId, 'the consumed round is excluded, the live one resumes');
  assert.equal(requestCount(), 2, 'resolving the ambiguity writes nothing');
});

test('Issue #263 (R3). a consumed round is never replayed for a new round — the new round owns a fresh request and its own prompt', async (t) => {
  const storeDir = mkStore(t);
  const session = { ...RESUME_SESSION };
  const p1 = buildPrompt();
  await sleep(3);
  const p2 = buildPrompt();
  const round1 = seedSentReconciledRound(session, p1, storeDir);
  const requestCount = () => fs.readdirSync(storeDir).filter((n) => n.endsWith('.request.json')).length;

  // The FSM already consumed round 1 (its DECIDING evidence carries the
  // requestId). The same prompt must NOT replay that round's response.
  const consumedRequestIds = [round1.record.requestId];
  const opened = openReviewRound({ session, prompt: p2, storeDir, consumedRequestIds });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.resumed, false, 'a consumed round is never resumed');
  assert.notEqual(opened.value.requestId, round1.record.requestId, 'the new round owns a new requestId');
  const openedRecord = JSON.parse(fs.readFileSync(opened.value.requestPath, 'utf8'));
  assert.equal(opened.prompt, openedRecord.submittedPrompt, 'the new round submits ITS OWN stored prompt');
  assert.ok(opened.prompt.startsWith(p2), 'the new round carries the resume prompt itself');
  assert.notEqual(opened.prompt, round1.record.submittedPrompt, 'the old round submittedPrompt is never replayed');
  assert.equal(requestCount(), 2, 'the new round persists its own request record');
  assert.equal(fs.existsSync(opened.value.responsePath), false, 'the new round starts with no response to replay');
  assert.equal(validateReviewProvenance({ request: opened.value, session, requireResponse: false }).ok, true, 'the new request carries self-consistent digests');

  // The old round's late response stays bound to the old round only.
  const effective = readEffectiveReviewResponse(round1);
  assert.equal(effective.ok, true, JSON.stringify(effective));
  assert.equal(effective.value.lateReconciled, true);
  assert.notEqual(effective.value.requestId, opened.value.requestId, 'the old response never leaks into the new round');
  const second = openReviewRound({ session, prompt: p2, storeDir, consumedRequestIds });
  assert.equal(second.value.requestId, opened.value.requestId, 'opening again without the checkpoint is stable');
});
