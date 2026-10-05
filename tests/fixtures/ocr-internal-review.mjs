// tests/fixtures/ocr-internal-review.mjs — offline fixture for the OCR
// internal-review record the production composite attaches to a CLEAN verify
// result (packages/control-loop/pre-gate-review.mjs `buildInternalReviewEvidence`).
//
// WHY THIS EXISTS: the handoff gate (projectReviewReadyPacket) refuses to
// create READY_FOR_REVIEW without a candidate-bound OCR internal-review record
// in the loop ledger. Offline tests stub `deps.verifier`, so their verifier
// values must model that record honestly — bound to the SAME session identity
// and head the loop is walking, with verdict APPROVED / findingsCount 0.
//
// It is a FIXTURE, not evidence: mechanism/command name the fixture, the model
// is a fixture id, and no live OCR runs. Tests that assert the review RESULT
// (findings, staleness, drift) must build their own records instead of this
// happy-path helper.

import { readSessionRecord } from '../../packages/runtime-sandbox/runtime-sandbox.mjs';
import { identityHash as canonicalIdentityHash } from '../../packages/workspace/workspace.mjs';

export const FIXTURE_OCR_RUN_ID = '00000000-0000-4000-8000-000000000000';
export const FIXTURE_OCR_MODEL = 'fixture-model';
export const FIXTURE_CONTENT_DIGEST = 'e'.repeat(64);

export function fixtureInternalReview(session) {
  return {
    schemaVersion: '1',
    source: 'ocr-internal-review',
    mechanism: 'test fixture: modeled OCR pre-gate review record (no live OCR in offline tests)',
    command: 'fixture transport',
    runId: FIXTURE_OCR_RUN_ID,
    model: FIXTURE_OCR_MODEL,
    sidecarPath: null,
    sidecarWritten: false,
    correlationKey: null,
    candidate: {
      repo: session.repo ?? null,
      issueNumber: session.issueNumber ?? null,
      prNumber: Number.isInteger(session.prNumber) ? session.prNumber : null,
      identityHash: canonicalIdentityHash({ repo: session.repo, issueNumber: session.issueNumber }),
      headSha: typeof session.headSha === 'string' ? session.headSha.toLowerCase() : null,
      contentDigest: FIXTURE_CONTENT_DIGEST,
      baseSha: typeof session.baseSha === 'string' ? session.baseSha.toLowerCase() : null,
    },
    verdict: 'APPROVED',
    findingsCount: 0,
    findings: [],
    openBlockingCount: 0,
    at: '2026-01-01T00:00:00.000Z',
  };
}

// Wraps any stub verifier so a passing verify result carries the internal
// review record, derived from the SAME session the loop is walking (never a
// hardcoded head/identity). Failures and non-object values pass through
// untouched — the wrapper never fabricates a success.
export function withOcrInternalReview(inner) {
  return async function ocrFixtureVerifier(ctx = {}) {
    const r = await inner(ctx);
    if (!r || r.ok !== true || !r.value || typeof r.value !== 'object' || Array.isArray(r.value)) return r;
    if (r.value.internalReview && typeof r.value.internalReview === 'object') return r;
    const rs = ctx.sessionPath ? readSessionRecord(ctx.sessionPath) : null;
    if (!rs || !rs.ok || !rs.session) return r;
    return { ...r, value: { ...r.value, internalReview: fixtureInternalReview(rs.session) } };
  };
}
