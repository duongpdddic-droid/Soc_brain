// tests/review-eval.test.mjs — deterministic tests for the review-eval
// primitive (Issue #100). node:test, zero new deps.
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
} from '../packages/review-eval/review-eval.mjs';

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rev-eval-')); }

const PKT_SHA = 'c'.repeat(64);
const modelReview = (overrides = {}) => ({
  ok: true,
  value: {
    verdict: 'PASS',
    findings: ['a', 'b'],
    confidence: 0.9,
    metadata: {
      model: 'gemini-test',
      source: 'gemini-pre-review',
      packet: { name: 'pkt_review-ready.md', sha256: PKT_SHA, truncated: false },
    },
    ...overrides,
  },
});

test('review-eval: append+read roundtrip (one JSON record per line, identity-scoped path)', () => {
  const stateDir = mkStateDir();
  const id = 'identity-abc';
  const r = appendReviewEvaluation({ stateDir, identityHash: id, kind: 'PRE_REVIEW', review: modelReview(), reviewDurationMs: 1234 });
  assert.equal(r.ok, true, JSON.stringify(r));
  const expectedPath = path.join(stateDir, 'review-eval', id, 'evaluations.jsonl');
  assert.equal(r.value.path, expectedPath);
  assert.ok(fs.existsSync(expectedPath));

  const recs = readReviewEvaluations({ stateDir, identityHash: id });
  assert.equal(recs.length, 1);
  const rec = recs[0];
  assert.equal(rec.schemaVersion, 1);
  assert.ok(typeof rec.ts === 'string' && !Number.isNaN(Date.parse(rec.ts)));
  assert.equal(rec.kind, 'PRE_REVIEW');
  assert.equal(rec.identityHash, id);
  assert.equal(rec.verdict, 'PASS');
  assert.equal(rec.score, null);
  assert.equal(rec.findingsCount, 2);
  assert.equal(rec.durationMs, 1234);
  assert.ok(/^[0-9a-f]{64}$/.test(rec.digest));
  assert.equal(rec.packetSha256, PKT_SHA);
  assert.equal(rec.packetName, 'pkt_review-ready.md');
  assert.equal(rec.packetTruncated, false);
  // Other identities are isolated: no cross-identity leakage.
  assert.deepEqual(readReviewEvaluations({ stateDir, identityHash: 'other' }), []);
});

test('review-eval: digest determinism (same payload => same digest; different payload => different)', () => {
  const stateDir = mkStateDir();
  const id = 'identity-digest';
  const r1 = appendReviewEvaluation({ stateDir, identityHash: id, kind: 'FINAL_REVIEW', review: modelReview(), reviewDurationMs: 1 });
  // Same logical payload, different key insertion order => same digest.
  const reordered = {
    ok: true,
    value: {
      metadata: {
        packet: { truncated: false, sha256: PKT_SHA, name: 'pkt_review-ready.md' },
        source: 'gemini-pre-review',
        model: 'gemini-test',
      },
      confidence: 0.9,
      findings: ['a', 'b'],
      verdict: 'PASS',
    },
  };
  const r2 = appendReviewEvaluation({ stateDir, identityHash: id, kind: 'FINAL_REVIEW', review: reordered, reviewDurationMs: 2 });
  assert.equal(r1.ok && r2.ok, true);
  assert.equal(r1.value.record.digest, r2.value.record.digest);

  const r3 = appendReviewEvaluation({ stateDir, identityHash: id, kind: 'FINAL_REVIEW', review: modelReview({ verdict: 'REWORK' }), reviewDurationMs: 3 });
  assert.notEqual(r1.value.record.digest, r3.value.record.digest);
  // Digest equals the sha256 of the canonical JSON of review.value (verifiable independently).
  const canon = (v) => (v === null || typeof v !== 'object'
    ? JSON.stringify(v ?? null)
    : Array.isArray(v)
      ? `[${v.map(canon).join(',')}]`
      : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`);
  assert.equal(r1.value.record.digest, createHash('sha256').update(canon(modelReview().value), 'utf8').digest('hex'));
});

test('review-eval: missing storage => [] (not an error); malformed lines skipped', () => {
  const stateDir = mkStateDir();
  assert.deepEqual(readReviewEvaluations({ stateDir, identityHash: 'missing' }), []);
  // Append one record, then corrupt the file with a malformed line.
  const id = 'identity-skip';
  appendReviewEvaluation({ stateDir, identityHash: id, kind: 'PRE_REVIEW', review: modelReview(), reviewDurationMs: null });
  const fp = path.join(stateDir, 'review-eval', id, 'evaluations.jsonl');
  fs.appendFileSync(fp, '{not-json\n', 'utf8');
  const recs = readReviewEvaluations({ stateDir, identityHash: id });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, 'PRE_REVIEW');
});

test('review-eval: fail-closed invalid input (bad kind, review.ok !== true, missing metadata.model)', () => {
  const stateDir = mkStateDir();
  const id = 'identity-fc';
  const badKind = appendReviewEvaluation({ stateDir, identityHash: id, kind: 'SOMETHING_ELSE', review: modelReview(), reviewDurationMs: 1 });
  assert.equal(badKind.ok, false);
  assert.equal(badKind.code, 'KIND_INVALID');

  const notOk = appendReviewEvaluation({ stateDir, identityHash: id, kind: 'PRE_REVIEW', review: { ok: false, code: 'GEMINI_VERDICT_INVALID' }, reviewDurationMs: 1 });
  assert.equal(notOk.ok, false);
  assert.equal(notOk.code, 'REVIEW_INVALID');

  const noValue = appendReviewEvaluation({ stateDir, identityHash: id, kind: 'PRE_REVIEW', review: { ok: true }, reviewDurationMs: 1 });
  assert.equal(noValue.ok, false);
  assert.equal(noValue.code, 'REVIEW_INVALID');

  const noModel = appendReviewEvaluation({
    stateDir, identityHash: id, kind: 'PRE_REVIEW', reviewDurationMs: 1,
    review: { ok: true, value: { verdict: 'PASS', findings: [], metadata: {} } },
  });
  assert.equal(noModel.ok, false);
  assert.equal(noModel.code, 'MODEL_INVALID');

  const emptyModel = appendReviewEvaluation({
    stateDir, identityHash: id, kind: 'FINAL_REVIEW', reviewDurationMs: 1,
    review: { ok: true, value: { verdict: 'PASS', findings: [], metadata: { model: '' } } },
  });
  assert.equal(emptyModel.ok, false);
  assert.equal(emptyModel.code, 'MODEL_INVALID');

  const missingMetadata = appendReviewEvaluation({
    stateDir, identityHash: id, kind: 'FINAL_REVIEW', reviewDurationMs: 1,
    review: { ok: true, value: { verdict: 'PASS', findings: [] } },
  });
  assert.equal(missingMetadata.ok, false);
  assert.equal(missingMetadata.code, 'MODEL_INVALID');

  // Issue #100 rework: packet evidence binding is fail-closed, never coerced.
  const noPacket = appendReviewEvaluation({
    stateDir, identityHash: id, kind: 'PRE_REVIEW', reviewDurationMs: 1,
    review: { ok: true, value: { verdict: 'PASS', findings: [], metadata: { model: 'm' } } },
  });
  assert.equal(noPacket.ok, false);
  assert.equal(noPacket.code, 'PACKET_EVIDENCE_INVALID');

  const badPacketSha = appendReviewEvaluation({
    stateDir, identityHash: id, kind: 'FINAL_REVIEW', reviewDurationMs: 1,
    review: { ok: true, value: { verdict: 'PASS', findings: [], metadata: { model: 'm', packet: { name: 'p.md', sha256: 'zz', truncated: false } } } },
  });
  assert.equal(badPacketSha.ok, false);
  assert.equal(badPacketSha.code, 'PACKET_EVIDENCE_INVALID');

  // Nothing was persisted by the rejected appends.
  assert.deepEqual(readReviewEvaluations({ stateDir, identityHash: id }), []);
});

test('review-eval: compareReviewEvaluations aggregation counts', () => {
  const stateDir = mkStateDir();
  const id = 'identity-agg';
  appendReviewEvaluation({ stateDir, identityHash: id, kind: 'PRE_REVIEW', review: modelReview(), reviewDurationMs: 1 });
  appendReviewEvaluation({ stateDir, identityHash: id, kind: 'FINAL_REVIEW', review: modelReview({ verdict: 'REWORK' }), reviewDurationMs: 2 });
  appendReviewEvaluation({ stateDir, identityHash: id, kind: 'FINAL_REVIEW', review: modelReview(), reviewDurationMs: 3 });
  const recs = readReviewEvaluations({ stateDir, identityHash: id });
  const agg = compareReviewEvaluations(recs);
  assert.equal(agg.total, 3);
  assert.deepEqual(agg.byKind, { PRE_REVIEW: 1, FINAL_REVIEW: 2 });
  assert.deepEqual(agg.byVerdict, { PASS: 2, REWORK: 1 });
  // Empty/degenerate inputs are safe.
  assert.deepEqual(compareReviewEvaluations([]), { total: 0, byKind: {}, byVerdict: {}, pairs: [] });
  assert.equal(compareReviewEvaluations(undefined).total, 0);
});

test('review-eval: compareReviewEvaluations pairs ONLY same-packet-evidence PRE/FINAL (#100 rework)', () => {
  const stateDir = mkStateDir();
  const id = 'identity-pairs';
  const SHA1 = '1'.repeat(64);
  const SHA2 = '2'.repeat(64);
  const review = (sha, name, overrides = {}) => modelReview({
    metadata: { model: 'm', source: 's', packet: { name, sha256: sha, truncated: false } },
    ...overrides,
  });
  // PRE(sha1) + FINAL(sha1) => one pair; PRE(sha2) => unpaired (no final).
  appendReviewEvaluation({ stateDir, identityHash: id, kind: 'PRE_REVIEW', review: review(SHA1, 'pkt_1111.md', { verdict: 'REWORK' }), reviewDurationMs: 1 });
  appendReviewEvaluation({ stateDir, identityHash: id, kind: 'FINAL_REVIEW', review: review(SHA1, 'pkt_1111.md', { metadata: { model: 'gpt', source: 'gpt-final-review', packet: { name: 'pkt_1111.md', sha256: SHA1, truncated: false } } }), reviewDurationMs: 2 });
  appendReviewEvaluation({ stateDir, identityHash: id, kind: 'PRE_REVIEW', review: review(SHA2, 'pkt_2222.md'), reviewDurationMs: 3 });
  const recs = readReviewEvaluations({ stateDir, identityHash: id });
  const cmp = compareReviewEvaluations(recs);
  assert.equal(cmp.total, 3);
  assert.equal(cmp.pairs.length, 1);
  const pr = cmp.pairs[0];
  assert.equal(pr.packetSha256, SHA1);
  assert.equal(pr.packetName, 'pkt_1111.md');
  assert.equal(pr.pre.verdict, 'REWORK');
  assert.equal(pr.final.verdict, 'PASS');
  assert.equal(pr.sameVerdict, false);
  // Cross-evidence comparison (FINAL saw a DIFFERENT packet) must never pair.
  assert.ok(!cmp.pairs.some((x) => x.packetSha256 === SHA2));
  // Each FINAL pairs at most once: a second PRE with the same sha has no FINAL left.
  appendReviewEvaluation({ stateDir, identityHash: id, kind: 'PRE_REVIEW', review: review(SHA1, 'pkt_1111.md'), reviewDurationMs: 4 });
  const cmp2 = compareReviewEvaluations(readReviewEvaluations({ stateDir, identityHash: id }));
  assert.equal(cmp2.pairs.length, 1);
});
