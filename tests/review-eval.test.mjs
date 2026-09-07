// tests/review-eval.test.mjs — Issue #92 (P1-1) deterministic tests for the
// persistent review evaluation store. Plain node:test, no new deps.
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
  reviewEvalDigest,
  REVIEW_EVAL_SCHEMA_VERSION,
} from '../packages/review-eval/review-eval.mjs';

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rev-eval-')); }
const ID = 'a'.repeat(32);

function expectCode(fn, code) {
  try { fn(); } catch (e) {
    assert.equal(e.code, code, `expected code ${code}, got ${e.code}: ${e.message}`);
    return;
  }
  assert.fail(`expected throw with code ${code}`);
}

test('A. append+read roundtrip: canonical record shape, one JSON object per line', () => {
  const stateDir = mkStateDir();
  const r1 = appendReviewEvaluation({
    stateDir, identityHash: ID, kind: 'PRE_REVIEW',
    review: { verdict: 'PASS', score: 0.9, findings: ['f1', 'f2'] },
    reviewDurationMs: 1234,
    now: () => '2026-01-01T00:00:00.000Z',
  });
  const r2 = appendReviewEvaluation({
    stateDir, identityHash: ID, kind: 'FINAL_REVIEW',
    review: { verdict: 'REWORK', score: null, findings: [] },
    reviewDurationMs: 0,
    now: () => '2026-01-01T00:00:01.000Z',
  });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);

  // canonical record fields
  assert.equal(r1.record.schemaVersion, REVIEW_EVAL_SCHEMA_VERSION);
  assert.equal(r1.record.schemaVersion, 1);
  assert.equal(r1.record.ts, '2026-01-01T00:00:00.000Z');
  assert.equal(r1.record.kind, 'PRE_REVIEW');
  assert.equal(r1.record.identityHash, ID);
  assert.equal(r1.record.verdict, 'PASS');
  assert.equal(r1.record.score, 0.9);
  assert.equal(r1.record.findingsCount, 2);
  assert.equal(r1.record.durationMs, 1234);
  assert.match(r1.record.digest, /^[0-9a-f]{64}$/);
  assert.equal(r2.record.findingsCount, 0);
  assert.equal(r2.record.verdict, 'REWORK');

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

test('B. digest determinism: sha256 of canonical {verdict,score,findings} payload', () => {
  const review = { verdict: 'REWORK', score: null, findings: ['a', 'b'] };
  const expected = createHash('sha256')
    .update(JSON.stringify({ verdict: review.verdict, score: review.score, findings: review.findings }))
    .digest('hex');
  assert.equal(reviewEvalDigest(review), expected);
  // key order of the review object must not change the canonical digest
  assert.equal(reviewEvalDigest({ findings: ['a', 'b'], score: null, verdict: 'REWORK' }), expected);
  // any payload change changes the digest
  assert.notEqual(reviewEvalDigest({ ...review, findings: ['a'] }), expected);
  assert.notEqual(reviewEvalDigest({ ...review, verdict: 'PASS' }), expected);
  assert.notEqual(reviewEvalDigest({ ...review, score: 1 }), expected);
  // stored record carries exactly the payload digest
  const stateDir = mkStateDir();
  const r = appendReviewEvaluation({
    stateDir, identityHash: ID, kind: 'PRE_REVIEW', review, reviewDurationMs: 5,
  });
  assert.equal(r.record.digest, expected);
});

test('C. compareReviewEvaluations aggregation: counts + averages', () => {
  const rs = [
    { kind: 'PRE_REVIEW', verdict: 'PASS', findingsCount: 1, durationMs: 100 },
    { kind: 'PRE_REVIEW', verdict: 'REWORK', findingsCount: 3, durationMs: 300 },
    { kind: 'FINAL_REVIEW', verdict: 'PASS', findingsCount: 0, durationMs: 500 },
    { kind: 'FINAL_REVIEW', verdict: 'REWORK', findingsCount: 2, durationMs: 700 },
  ];
  assert.deepEqual(compareReviewEvaluations(rs), {
    total: 4,
    preReview: 2,
    finalReview: 2,
    approvals: 2,
    changesRequested: 2,
    avgPreReviewMs: 200,
    avgFinalReviewMs: 600,
    avgFindings: 1.5,
  });
  // empty ledger: zero counts, null averages (no fabricated samples)
  assert.deepEqual(compareReviewEvaluations([]), {
    total: 0, preReview: 0, finalReview: 0,
    approvals: 0, changesRequested: 0,
    avgPreReviewMs: null, avgFinalReviewMs: null, avgFindings: null,
  });
  // BLOCKED is an escalation: neither approval nor change request
  const blockedOnly = compareReviewEvaluations([{ kind: 'FINAL_REVIEW', verdict: 'BLOCKED', findingsCount: 1 }]);
  assert.equal(blockedOnly.approvals, 0);
  assert.equal(blockedOnly.changesRequested, 0);
  assert.equal(blockedOnly.finalReview, 1);
  // non-finite durations are excluded from averages, not treated as 0
  const mixed = compareReviewEvaluations([
    { kind: 'PRE_REVIEW', verdict: 'PASS', findingsCount: 0, durationMs: 100 },
    { kind: 'PRE_REVIEW', verdict: 'PASS', findingsCount: 0 },
  ]);
  assert.equal(mixed.avgPreReviewMs, 100);
});

test('D. missing storage reads back empty (no dir, no file)', () => {
  const stateDir = mkStateDir();
  assert.deepEqual(readReviewEvaluations({ stateDir, identityHash: 'c'.repeat(32) }), []);
  // deep-but-empty chain: stateDir exists, review-eval/<id> does not
  assert.deepEqual(readReviewEvaluations({ stateDir: path.join(stateDir, 'nested'), identityHash: 'd'.repeat(32) }), []);
});

test('E. fail-closed: invalid inputs throw explicit coded errors, storage untouched', () => {
  const stateDir = mkStateDir();
  const good = { stateDir, identityHash: ID, kind: 'PRE_REVIEW', review: { verdict: 'PASS', score: 1, findings: [] }, reviewDurationMs: 1 };
  expectCode(() => appendReviewEvaluation({ ...good, stateDir: '' }), 'REVIEW_EVAL_STATE_DIR_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, stateDir: null }), 'REVIEW_EVAL_STATE_DIR_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, identityHash: '../evil' }), 'REVIEW_EVAL_IDENTITY_HASH_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, identityHash: 'a/b' }), 'REVIEW_EVAL_IDENTITY_HASH_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, identityHash: '' }), 'REVIEW_EVAL_IDENTITY_HASH_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, kind: 'REVIEW' }), 'REVIEW_EVAL_KIND_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, kind: null }), 'REVIEW_EVAL_KIND_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, review: null }), 'REVIEW_EVAL_REVIEW_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, review: 'PASS' }), 'REVIEW_EVAL_REVIEW_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, review: [] }), 'REVIEW_EVAL_REVIEW_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, reviewDurationMs: -1 }), 'REVIEW_EVAL_DURATION_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, reviewDurationMs: 'fast' }), 'REVIEW_EVAL_DURATION_INVALID');
  expectCode(() => appendReviewEvaluation({ ...good, reviewDurationMs: Number.NaN }), 'REVIEW_EVAL_DURATION_INVALID');
  // read path validates identity too (fail-closed, no silent broad reads)
  expectCode(() => readReviewEvaluations({ stateDir, identityHash: '' }), 'REVIEW_EVAL_IDENTITY_HASH_INVALID');
  expectCode(() => readReviewEvaluations({ identityHash: ID }), 'REVIEW_EVAL_STATE_DIR_INVALID');
  // nothing was written by the failed attempts
  assert.deepEqual(readReviewEvaluations(good), []);
});
