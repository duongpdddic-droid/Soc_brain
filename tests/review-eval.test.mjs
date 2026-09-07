// tests/review-eval.test.mjs — Issue #92 (P1-1, rework round 3) deterministic
// tests for the evidence-bound persistent review evaluation store. Plain
// node:test, no new deps.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  appendReviewEvaluation,
  readReviewEvaluations,
  compareReviewEvaluations,
  REVIEW_EVAL_SCHEMA_VERSION,
  REVIEW_EVAL_NOT_COMPARABLE,
} from '../packages/review-eval/review-eval.mjs';

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rev-eval-')); }
const ID = 'a'.repeat(32);
const HEAD = 'a'.repeat(40);
const TARGET = { repository: 'duongpdddic-droid/soc_brain', issue: 92, headSha: HEAD };

// Canonical review-ready packet fixture: evidenceDigest must be the sha256 of
// the EXACT bytes the model reviewed (the old verdict-payload digest is gone).
const PACKET_BYTES = Buffer.from([
  '# Review Ready — duongpdddic-droid/soc_brain Issue #92 · PR #93', '', '## Identity',
  '- repository: duongpdddic-droid/soc_brain', '- issue: 92', '- pullRequest: 93',
  `- headSha: ${HEAD} (short ${HEAD.slice(0, 7)})`, `- baseSha: ${'b'.repeat(40)}`, '- prState: OPEN', '',
  'Canonical packet body.',
].join('\n'), 'utf8');
const EV_DIGEST = createHash('sha256').update(PACKET_BYTES).digest('hex');

function mkReview(valueOverrides = {}, topOverrides = {}) {
  return {
    ok: true,
    value: {
      verdict: 'PASS',
      findings: [],
      confidence: 0.9,
      metadata: { model: 'gemini-test', source: 'test' },
      reviewTarget: TARGET,
      evidenceDigest: EV_DIGEST,
      ...valueOverrides,
    },
    ...topOverrides,
  };
}

function expectCode(fn, code) {
  try { fn(); } catch (e) {
    assert.equal(e.code, code, `expected code ${code}, got ${e.code}: ${e.message}`);
    return;
  }
  assert.fail(`expected throw with code ${code}`);
}

test('A. append+read roundtrip: evidence-bound record shape, one JSON object per line', () => {
  const stateDir = mkStateDir();
  const r1 = appendReviewEvaluation({
    stateDir, identityHash: ID, kind: 'PRE_REVIEW',
    review: mkReview({ findings: ['plain finding', { severity: 'high', message: 'structured finding' }] }),
    reviewDurationMs: 1234,
    now: () => '2026-01-01T00:00:00.000Z',
  });
  const r2 = appendReviewEvaluation({
    stateDir, identityHash: ID, kind: 'FINAL_REVIEW',
    review: mkReview({ verdict: 'REWORK', confidence: 0.6, metadata: { model: 'gpt-test' } }),
    reviewDurationMs: 0,
    now: () => '2026-01-01T00:00:01.000Z',
  });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);

  // canonical record fields: model, reviewTarget, evidenceDigest, verdict,
  // findings (normalized w/ severity), confidence, durationMs, recordedAt
  assert.equal(r1.record.schemaVersion, REVIEW_EVAL_SCHEMA_VERSION);
  assert.equal(r1.record.schemaVersion, 2);
  assert.equal(r1.record.kind, 'PRE_REVIEW');
  assert.equal(r1.record.identityHash, ID);
  assert.equal(r1.record.model, 'gemini-test');
  assert.deepEqual(r1.record.reviewTarget, TARGET);
  assert.equal(r1.record.evidenceDigest, EV_DIGEST);
  assert.equal(r1.record.verdict, 'PASS');
  assert.deepEqual(r1.record.findings, [
    { message: 'plain finding', severity: null },
    { severity: 'high', message: 'structured finding' },
  ]);
  assert.equal(r1.record.confidence, 0.9);
  assert.equal(r1.record.durationMs, 1234);
  assert.equal(r1.record.recordedAt, '2026-01-01T00:00:00.000Z');

  // the old reduced fields must not reappear
  assert.ok(!('score' in r1.record));
  assert.ok(!('digest' in r1.record));
  assert.ok(!('findingsCount' in r1.record));

  // storage layout: <stateDir>/review-eval/<identityHash>/evaluations.jsonl
  const fp = path.join(stateDir, 'review-eval', ID, 'evaluations.jsonl');
  assert.equal(r1.path, fp);
  const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2, 'append-only: one JSON object per line');
  assert.deepEqual(JSON.parse(lines[0]), r1.record);
  assert.deepEqual(JSON.parse(lines[1]), r2.record);

  // read-back roundtrip preserves order and content
  const rs = readReviewEvaluations({ stateDir, identityHash: ID });
  assert.deepEqual(rs, [r1.record, r2.record]);

  // separate identities never share a store
  assert.deepEqual(readReviewEvaluations({ stateDir, identityHash: 'b'.repeat(32) }), []);
});

test('B. evidenceDigest binds the EXACT canonical packet bytes — never the verdict payload', () => {
  assert.equal(EV_DIGEST, createHash('sha256').update(PACKET_BYTES).digest('hex'));
  const stateDir = mkStateDir();
  const r = appendReviewEvaluation({
    stateDir, identityHash: ID, kind: 'PRE_REVIEW', review: mkReview(), reviewDurationMs: 5,
  });
  assert.equal(r.record.evidenceDigest, EV_DIGEST);
  assert.notEqual(
    r.record.evidenceDigest,
    createHash('sha256').update(JSON.stringify({ verdict: 'PASS', score: undefined, findings: [] })).digest('hex'),
    'the old reduced review-payload digest must never reappear',
  );
  // identical verdict payloads at different evidence are DIFFERENT evaluations
  const r2 = appendReviewEvaluation({
    stateDir, identityHash: ID, kind: 'FINAL_REVIEW',
    review: mkReview({ evidenceDigest: 'f'.repeat(64), metadata: { model: 'gpt-test' } }),
    reviewDurationMs: 6,
  });
  assert.notEqual(r2.record.evidenceDigest, r.record.evidenceDigest);
  assert.equal(r2.record.verdict, r.record.verdict);
});

test('C. findings normalization: strings -> severity:null, {severity,message} objects preserved', () => {
  const stateDir = mkStateDir();
  const r = appendReviewEvaluation({
    stateDir, identityHash: ID, kind: 'PRE_REVIEW',
    review: mkReview({ findings: ['s1', { severity: 'low', message: 'o1' }, { severity: null, message: 'o2' }] }),
    reviewDurationMs: 1,
  });
  assert.deepEqual(r.record.findings, [
    { message: 's1', severity: null },
    { severity: 'low', message: 'o1' },
    { severity: null, message: 'o2' },
  ]);
});

test('D. compareReviewEvaluations: evidence-bound comparability + verdictAgreement', () => {
  const rec = (kind, overrides = {}) => ({
    schemaVersion: 2, kind, identityHash: ID, model: 'm',
    reviewTarget: TARGET, evidenceDigest: EV_DIGEST,
    verdict: 'PASS', findings: [], confidence: 0.9, durationMs: 100,
    recordedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

  // comparable Gemini/GPT pair on the same target + evidence
  const agg = compareReviewEvaluations([rec('PRE_REVIEW'), rec('FINAL_REVIEW', { durationMs: 500 })]);
  assert.equal(agg.comparable, true);
  assert.equal(agg.notComparableReason, null);
  assert.equal(agg.verdictAgreement, true);
  assert.deepEqual(agg.reviewTarget, TARGET);
  assert.equal(agg.evidenceDigest, EV_DIGEST);
  assert.equal(agg.total, 2);
  assert.equal(agg.approvals, 2);
  assert.equal(agg.preReview, 1);
  assert.equal(agg.finalReview, 1);
  assert.equal(agg.avgPreReviewMs, 100);
  assert.equal(agg.avgFinalReviewMs, 500);

  // disagreement is comparable too
  assert.equal(
    compareReviewEvaluations([rec('PRE_REVIEW'), rec('FINAL_REVIEW', { verdict: 'REWORK' })]).verdictAgreement,
    false,
  );

  // different evidence bytes at the same target -> not comparable
  const diffDigest = compareReviewEvaluations([rec('PRE_REVIEW'), rec('FINAL_REVIEW', { evidenceDigest: 'f'.repeat(64) })]);
  assert.equal(diffDigest.comparable, false);
  assert.equal(diffDigest.notComparableReason, 'EVIDENCE_DIGEST_MISMATCH');
  assert.equal(diffDigest.verdictAgreement, null);
  assert.equal(diffDigest.evidenceDigest, null);

  // different target -> not comparable
  const diffTarget = compareReviewEvaluations([rec('PRE_REVIEW'), rec('FINAL_REVIEW', { reviewTarget: { ...TARGET, issue: 93 } })]);
  assert.equal(diffTarget.comparable, false);
  assert.equal(diffTarget.notComparableReason, 'REVIEW_TARGET_MISMATCH');

  // missing kind at the same binding -> not comparable
  const missingKind = compareReviewEvaluations([rec('PRE_REVIEW'), rec('PRE_REVIEW', { verdict: 'REWORK' })]);
  assert.equal(missingKind.comparable, false);
  assert.equal(missingKind.notComparableReason, 'MISSING_REVIEW_KIND');

  // legacy/unbound records (no reviewTarget/evidenceDigest) -> NO_BOUND_EVALUATIONS
  const unbound = compareReviewEvaluations([{ kind: 'PRE_REVIEW', verdict: 'PASS' }, { kind: 'FINAL_REVIEW', verdict: 'REWORK' }]);
  assert.equal(unbound.comparable, false);
  assert.equal(unbound.notComparableReason, 'NO_BOUND_EVALUATIONS');
  assert.equal(unbound.verdictAgreement, null);
  assert.equal(unbound.total, 2);
  assert.equal(unbound.approvals, 1);

  // latest bound round wins (a rework leg re-projects the packet at a new head)
  const latest = compareReviewEvaluations([
    rec('PRE_REVIEW', { evidenceDigest: '1'.repeat(64), verdict: 'REWORK' }),
    rec('FINAL_REVIEW', { evidenceDigest: '1'.repeat(64), verdict: 'REWORK' }),
    rec('PRE_REVIEW', { evidenceDigest: '2'.repeat(64) }),
    rec('FINAL_REVIEW', { evidenceDigest: '2'.repeat(64) }),
  ]);
  assert.equal(latest.comparable, true);
  assert.equal(latest.evidenceDigest, '2'.repeat(64));
  assert.equal(latest.verdictAgreement, true);

  // canonicalization is case-insensitive on repository/headSha
  const cased = compareReviewEvaluations([
    rec('PRE_REVIEW', { reviewTarget: { repository: 'DUONGPDDDIC-DROID/SOC_BRAIN', issue: 92, headSha: HEAD.toUpperCase() } }),
    rec('FINAL_REVIEW'),
  ]);
  assert.equal(cased.comparable, true);
  assert.deepEqual(cased.reviewTarget, TARGET);

  // aggregates from normalized findings arrays; BLOCKED is an escalation
  const mixed = compareReviewEvaluations([
    rec('PRE_REVIEW', { findings: ['a', 'b'] }),
    rec('FINAL_REVIEW', { verdict: 'BLOCKED', findings: [{ severity: 'high', message: 'x' }] }),
  ]);
  assert.equal(mixed.comparable, true);
  assert.equal(mixed.verdictAgreement, false);
  assert.equal(mixed.approvals, 1);
  assert.equal(mixed.changesRequested, 0);
  assert.equal(mixed.avgFindings, 1.5);

  // empty ledger: zero counts, null averages, not comparable
  assert.deepEqual(compareReviewEvaluations([]), {
    comparable: false, notComparableReason: 'NO_BOUND_EVALUATIONS',
    reviewTarget: null, evidenceDigest: null, verdictAgreement: null,
    total: 0, preReview: 0, finalReview: 0, approvals: 0, changesRequested: 0,
    avgPreReviewMs: null, avgFinalReviewMs: null, avgFindings: null,
  });

  // non-finite durations are excluded from averages, not treated as 0
  const mixedDur = compareReviewEvaluations([
    rec('PRE_REVIEW', { durationMs: 100 }),
    rec('FINAL_REVIEW', { durationMs: Number.NaN }),
  ]);
  assert.equal(mixedDur.avgPreReviewMs, 100);
  assert.equal(mixedDur.avgFinalReviewMs, null);

  // exported reason set is exactly the deterministic enum
  assert.deepEqual(
    [...REVIEW_EVAL_NOT_COMPARABLE].sort(),
    ['EVIDENCE_DIGEST_MISMATCH', 'MISSING_REVIEW_KIND', 'NO_BOUND_EVALUATIONS', 'REVIEW_TARGET_MISMATCH'],
  );
});

test('E. missing storage reads back empty (no dir, no file)', () => {
  const stateDir = mkStateDir();
  assert.deepEqual(readReviewEvaluations({ stateDir, identityHash: 'c'.repeat(32) }), []);
  // deep-but-empty chain: stateDir exists, review-eval/<id> does not
  assert.deepEqual(readReviewEvaluations({ stateDir: path.join(stateDir, 'nested'), identityHash: 'd'.repeat(32) }), []);
});

test('F. fail-closed: malformed successful-looking reviews NEVER create records', () => {
  const stateDir = mkStateDir();
  const good = { stateDir, identityHash: ID, kind: 'PRE_REVIEW', review: mkReview(), reviewDurationMs: 1 };
  // storage/identity/kind/duration gates (unchanged)
  expectCode(() => appendReviewEvaluation({ ...good, stateDir: '' }), 'REVIEW_EVAL_STATE_DIR_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, stateDir: null }), 'REVIEW_EVAL_STATE_DIR_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, identityHash: '../evil' }), 'REVIEW_EVAL_IDENTITY_HASH_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, identityHash: 'a/b' }), 'REVIEW_EVAL_IDENTITY_HASH_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, kind: 'REVIEW' }), 'REVIEW_EVAL_KIND_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, kind: null }), 'REVIEW_EVAL_KIND_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, reviewDurationMs: -1 }), 'REVIEW_EVAL_DURATION_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, reviewDurationMs: 'fast' }), 'REVIEW_EVAL_DURATION_INVALID');
  // review gate: the FULL adapter result is required (review.ok enforced)
  expectCode(() => appendReviewEvaluation({ ...good, review: null }), 'REVIEW_EVAL_REVIEW_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, review: 'PASS' }), 'REVIEW_EVAL_REVIEW_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, review: [] }), 'REVIEW_EVAL_REVIEW_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, review: { ok: false, value: mkReview().value } }), 'REVIEW_EVAL_REVIEW_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, review: { ok: true } }), 'REVIEW_EVAL_REVIEW_INVALID');
  // required evidence-bound fields: verdict/confidence/model/reviewTarget/evidenceDigest/findings
  expectCode(() => appendReviewEvaluation({ ...good, review: mkReview({ verdict: 'MAYBE' }) }), 'REVIEW_EVAL_VERDICT_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, review: mkReview({ confidence: 'high' }) }), 'REVIEW_EVAL_CONFIDENCE_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, review: mkReview({ metadata: {} }) }), 'REVIEW_EVAL_MODEL_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, review: mkReview({ metadata: { model: '  ' } }) }), 'REVIEW_EVAL_MODEL_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, review: mkReview({ reviewTarget: null }) }), 'REVIEW_EVAL_REVIEW_TARGET_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, review: mkReview({ reviewTarget: { ...TARGET, issue: 0 } }) }), 'REVIEW_EVAL_REVIEW_TARGET_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, review: mkReview({ reviewTarget: { ...TARGET, headSha: 'abc' } }) }), 'REVIEW_EVAL_REVIEW_TARGET_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, review: mkReview({ evidenceDigest: 'nothex' }) }), 'REVIEW_EVAL_EVIDENCE_DIGEST_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, review: mkReview({ evidenceDigest: 'A'.repeat(64) }) }), 'REVIEW_EVAL_EVIDENCE_DIGEST_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, review: mkReview({ findings: 'none' }) }), 'REVIEW_EVAL_FINDINGS_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, review: mkReview({ findings: [42] }) }), 'REVIEW_EVAL_FINDING_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, review: mkReview({ findings: [{ message: 'x' }] }) }), 'REVIEW_EVAL_FINDING_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, review: mkReview({ findings: [{ severity: 'high' }] }) }), 'REVIEW_EVAL_FINDING_INVALID');
  // read path validates identity too (fail-closed, no silent broad reads)
  expectCode(() => readReviewEvaluations({ stateDir, identityHash: '' }), 'REVIEW_EVAL_IDENTITY_HASH_INVALID');
  expectCode(() => readReviewEvaluations({ identityHash: ID }), 'REVIEW_EVAL_STATE_DIR_INVALID');
  // nothing was written by the failed attempts
  assert.deepEqual(readReviewEvaluations(good), []);
});
