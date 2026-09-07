#!/usr/bin/env node
// review-eval.mjs — persistent review evaluation store (Issue #92 P1-1).
//
// Append-only JSONL evidence store for control-loop review outcomes, plus a
// comparison/aggregation helper. Storage layout:
//   <stateDir>/review-eval/<identityHash>/evaluations.jsonl
// One JSON object per line, atomic single-line append (same append pattern as
// control-loop's transitions ledger).
//
// Ownership rules (hard invariants, mirroring the repo's adapter contract):
//   - This module is pure EVIDENCE storage: it never touches the canonical
//     session record, never terminalizes, never dispatches, never merges.
//   - Fail-closed at the input boundary: invalid input throws an explicit
//     coded error (ReviewEvalInputError.code); append/IO errors propagate to
//     the caller — the control-loop sink wrapper owns the persistence policy
//     (evidence.evalPersisted=false on failure, FSM state/reason unchanged).
//   - digest = sha256 hex of the canonical review payload
//     JSON.stringify({ verdict, score, findings }) — deterministic, so two
//     byte-identical reviews always produce the same digest.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const REVIEW_EVAL_SCHEMA_VERSION = 1;
export const REVIEW_EVAL_KINDS = Object.freeze(['PRE_REVIEW', 'FINAL_REVIEW']);

// Coded input-validation error (fail-closed boundary). Callers may branch on
// `.code` without string-matching messages.
export class ReviewEvalInputError extends Error {
  constructor(code, detail) {
    super(`REVIEW_EVAL_${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'ReviewEvalInputError';
    this.code = `REVIEW_EVAL_${code}`;
    this.detail = detail ?? null;
  }
}

// identityHash is a filesystem segment — path-safety gate (no separators, no
// traversal), same failure philosophy as review-ready's FILENAME_RE gate.
function assertIdentityHash(identityHash) {
  if (typeof identityHash !== 'string' || !/^[A-Za-z0-9._-]+$/.test(identityHash) || identityHash.includes('..')) {
    throw new ReviewEvalInputError('IDENTITY_HASH_INVALID', `identityHash=${JSON.stringify(identityHash)}`);
  }
}

function evaluationsPathFor({ stateDir, identityHash } = {}) {
  if (typeof stateDir !== 'string' || !stateDir.trim()) {
    throw new ReviewEvalInputError('STATE_DIR_INVALID', 'stateDir must be a non-empty string');
  }
  assertIdentityHash(identityHash);
  return path.join(stateDir, 'review-eval', identityHash, 'evaluations.jsonl');
}

// sha256 hex of the canonical review payload — JSON.stringify of
// { verdict, score, findings } (fixed key order via the literal below, so the
// digest is independent of the review object's own key order).
export function reviewEvalDigest(review) {
  return createHash('sha256')
    .update(JSON.stringify({
      verdict: review ? review.verdict : undefined,
      score: review ? review.score : undefined,
      findings: review ? review.findings : undefined,
    }))
    .digest('hex');
}

// Append one evaluation record. Returns { ok, record, path }. Append errors
// propagate (fail-closed); the caller (sink wrapper) decides policy.
export function appendReviewEvaluation({
  stateDir, identityHash, kind, review, reviewDurationMs,
  now = () => new Date().toISOString(),
} = {}) {
  const fp = evaluationsPathFor({ stateDir, identityHash });
  if (kind !== 'PRE_REVIEW' && kind !== 'FINAL_REVIEW') {
    throw new ReviewEvalInputError('KIND_INVALID', `kind must be PRE_REVIEW|FINAL_REVIEW, got ${JSON.stringify(kind)}`);
  }
  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    throw new ReviewEvalInputError('REVIEW_INVALID', 'review must be a non-null object');
  }
  if (!Number.isFinite(reviewDurationMs) || reviewDurationMs < 0) {
    throw new ReviewEvalInputError('DURATION_INVALID', `reviewDurationMs=${String(reviewDurationMs)}`);
  }
  const record = {
    schemaVersion: REVIEW_EVAL_SCHEMA_VERSION,
    ts: now(),
    kind,
    identityHash,
    verdict: review.verdict,
    score: review.score,
    findingsCount: Array.isArray(review.findings) ? review.findings.length : 0,
    durationMs: reviewDurationMs,
    digest: reviewEvalDigest(review),
  };
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.appendFileSync(fp, `${JSON.stringify(record)}\n`, 'utf8');
  return { ok: true, record, path: fp };
}

// Parsed records, oldest first. Missing dir/file => [] (never throws for
// absent storage); malformed lines are skipped (readTransitions pattern).
export function readReviewEvaluations({ stateDir, identityHash } = {}) {
  const fp = evaluationsPathFor({ stateDir, identityHash });
  let raw;
  try { raw = fs.readFileSync(fp, 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function mean(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

// Derive comparison counts from evaluation records:
//   { total, preReview, finalReview, approvals, changesRequested,
//     avgPreReviewMs, avgFinalReviewMs, avgFindings }
// approvals = verdict PASS; changesRequested = verdict REWORK (BLOCKED counts
// in neither bucket — it is an escalation, not a change request).
export function compareReviewEvaluations(records) {
  const rs = Array.isArray(records) ? records : [];
  const kind = (k) => rs.filter((r) => r && r.kind === k);
  const pre = kind('PRE_REVIEW');
  const fin = kind('FINAL_REVIEW');
  const dur = (list) => mean(list.map((r) => r && r.durationMs).filter(Number.isFinite));
  return {
    total: rs.length,
    preReview: pre.length,
    finalReview: fin.length,
    approvals: rs.filter((r) => r && r.verdict === 'PASS').length,
    changesRequested: rs.filter((r) => r && r.verdict === 'REWORK').length,
    avgPreReviewMs: dur(pre),
    avgFinalReviewMs: dur(fin),
    avgFindings: mean(rs.map((r) => (r && Number.isFinite(r.findingsCount)) ? r.findingsCount : null).filter((v) => v !== null)),
  };
}
