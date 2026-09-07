#!/usr/bin/env node
// review-eval.mjs — evidence-bound persistent review evaluation store
// (Issue #92 P1-1, rework round 3).
//
// Append-only JSONL evidence store for control-loop review outcomes, plus a
// comparability helper. Storage layout:
//   <stateDir>/review-eval/<identityHash>/evaluations.jsonl
// One JSON object per line, atomic single-line append (same append pattern as
// control-loop's transitions ledger).
//
// Evidence binding (Issue #92 rework — hard contract):
//   - reviewTarget = { repository, issue, headSha } — the canonical identity
//     the reviewed review-ready packet self-identifies with (identity-gated
//     by collectPreReviewEvidence).
//   - evidenceDigest = sha256 hex of the EXACT canonical review-ready packet
//     bytes the model reviewed (collectPreReviewEvidence packet.sha256 — one
//     read from disk). It is NEVER a digest of the verdict payload.
//   - model = the reviewer model identity (review.value.metadata.model).
//   - findings are persisted normalized: a string finding becomes
//     { message, severity: null }; an object { severity, message } finding is
//     preserved verbatim.
// Two evaluations are comparable ONLY when they carry identical reviewTarget
// AND evidenceDigest (same target, same evidence bytes).
//
// Ownership rules (hard invariants, mirroring the repo's adapter contract):
//   - This module is pure EVIDENCE storage: it never touches the canonical
//     session record, never terminalizes, never dispatches, never merges.
//   - Fail-closed at the input boundary: invalid input throws an explicit
//     coded error (ReviewEvalInputError.code) BEFORE any append — malformed
//     successful-looking reviews can never create a non-conforming record.
//     Append/IO errors propagate to the caller — the control-loop sink
//     wrapper owns the persistence policy (evidence.evalPersisted=false on
//     failure, FSM state/reason unchanged).

import fs from 'node:fs';
import path from 'node:path';

export const REVIEW_EVAL_SCHEMA_VERSION = 2;
export const REVIEW_EVAL_KINDS = Object.freeze(['PRE_REVIEW', 'FINAL_REVIEW']);
export const REVIEW_EVAL_VERDICTS = Object.freeze(['PASS', 'REWORK', 'BLOCKED']);
export const REVIEW_EVAL_NOT_COMPARABLE = Object.freeze([
  'NO_BOUND_EVALUATIONS', 'MISSING_REVIEW_KIND', 'REVIEW_TARGET_MISMATCH', 'EVIDENCE_DIGEST_MISMATCH',
]);

const SHA256_RE = /^[0-9a-f]{64}$/;
const HEAD_SHA_RE = /^[0-9a-f]{40}$/;

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

const snippet = (x) => {
  try { const s = JSON.stringify(x); return (s && s.length > 120) ? `${s.slice(0, 120)}…` : s; }
  catch { return String(x); }
};

// Fail-closed validation of the FULL adapter result (the loop's sink receives
// { ok, value }): every required evidence-bound field is enforced before any
// append. Returns the extracted, canonicalized fields or throws.
function assertEvidenceBoundReview(review) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    throw new ReviewEvalInputError('REVIEW_INVALID', 'review must be a non-null adapter result');
  }
  if (review.ok !== true) {
    throw new ReviewEvalInputError('REVIEW_INVALID', 'review.ok must be true — only successful reviews are recorded');
  }
  const v = review.value;
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new ReviewEvalInputError('REVIEW_INVALID', 'review.value must be a non-null object');
  }
  if (typeof v.verdict !== 'string' || !REVIEW_EVAL_VERDICTS.includes(v.verdict)) {
    throw new ReviewEvalInputError('VERDICT_INVALID', `verdict=${snippet(v.verdict)} must be one of ${REVIEW_EVAL_VERDICTS.join('|')}`);
  }
  if (!Number.isFinite(v.confidence)) {
    throw new ReviewEvalInputError('CONFIDENCE_INVALID', `confidence=${snippet(v.confidence)} must be a finite number`);
  }
  const md = v.metadata;
  if (!md || typeof md !== 'object' || Array.isArray(md) || typeof md.model !== 'string' || !md.model.trim()) {
    throw new ReviewEvalInputError('MODEL_INVALID', 'review.value.metadata.model must be a non-empty string');
  }
  const t = v.reviewTarget;
  if (!t || typeof t !== 'object' || Array.isArray(t)
    || typeof t.repository !== 'string' || !t.repository.trim()
    || !Number.isInteger(t.issue) || t.issue <= 0
    || typeof t.headSha !== 'string' || !HEAD_SHA_RE.test(t.headSha)) {
    throw new ReviewEvalInputError('REVIEW_TARGET_INVALID', `reviewTarget=${snippet(t)} must be {repository, issue>0, headSha(40-hex)}`);
  }
  if (typeof v.evidenceDigest !== 'string' || !SHA256_RE.test(v.evidenceDigest)) {
    throw new ReviewEvalInputError('EVIDENCE_DIGEST_INVALID', `evidenceDigest=${snippet(v.evidenceDigest)} must be 64 lowercase hex (sha256 of the exact packet bytes)`);
  }
  if (!Array.isArray(v.findings)) {
    throw new ReviewEvalInputError('FINDINGS_INVALID', 'review.value.findings must be an array');
  }
  const findings = v.findings.map((f) => {
    if (typeof f === 'string') return { message: f, severity: null };
    if (f && typeof f === 'object' && !Array.isArray(f)
      && typeof f.message === 'string'
      && (f.severity === null || typeof f.severity === 'string')) {
      return f; // structured finding preserved verbatim
    }
    throw new ReviewEvalInputError('FINDING_INVALID', `finding=${snippet(f)} must be a string or {message: string, severity: string|null}`);
  });
  return {
    verdict: v.verdict,
    confidence: v.confidence,
    model: md.model,
    reviewTarget: { repository: t.repository, issue: t.issue, headSha: t.headSha.toLowerCase() },
    evidenceDigest: v.evidenceDigest,
    findings,
  };
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
  const ev = assertEvidenceBoundReview(review);
  if (!Number.isFinite(reviewDurationMs) || reviewDurationMs < 0) {
    throw new ReviewEvalInputError('DURATION_INVALID', `reviewDurationMs=${String(reviewDurationMs)}`);
  }
  const record = {
    schemaVersion: REVIEW_EVAL_SCHEMA_VERSION,
    kind,
    identityHash,
    model: ev.model,
    reviewTarget: ev.reviewTarget,
    evidenceDigest: ev.evidenceDigest,
    verdict: ev.verdict,
    findings: ev.findings,
    confidence: ev.confidence,
    durationMs: reviewDurationMs,
    recordedAt: now(),
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

// Canonical target binding — case-insensitive on repository/headSha so the
// packet's own casing can never split one identity into two.
function canonicalTarget(t) {
  return {
    repository: String(t.repository).toLowerCase(),
    issue: Number(t.issue),
    headSha: String(t.headSha).toLowerCase(),
  };
}

function hasBinding(r) {
  return Boolean(r && typeof r === 'object'
    && r.reviewTarget && typeof r.reviewTarget === 'object' && !Array.isArray(r.reviewTarget)
    && typeof r.reviewTarget.repository === 'string' && r.reviewTarget.repository.trim()
    && Number.isInteger(r.reviewTarget.issue) && r.reviewTarget.issue > 0
    && typeof r.reviewTarget.headSha === 'string' && HEAD_SHA_RE.test(r.reviewTarget.headSha)
    && typeof r.evidenceDigest === 'string' && SHA256_RE.test(r.evidenceDigest));
}

function bindingKey(r) {
  const t = canonicalTarget(r.reviewTarget);
  return `${t.repository}#${t.issue}@${t.headSha}|${r.evidenceDigest.toLowerCase()}`;
}

const targetKey = (r) => {
  const t = canonicalTarget(r.reviewTarget);
  return `${t.repository}#${t.issue}@${t.headSha}`;
};

// Evidence-bound comparability (Issue #92 rework): aggregates PLUS the
// reviewTarget/evidenceDigest gate. comparable=true ONLY for a PRE_REVIEW +
// FINAL_REVIEW pair with IDENTICAL reviewTarget AND evidenceDigest (latest
// round wins); verdictAgreement is then preReview.verdict ===
// finalReview.verdict. Anything else is not comparable with a deterministic
// reason and verdictAgreement=null.
export function compareReviewEvaluations(records) {
  const rs = Array.isArray(records) ? records : [];
  const kind = (k) => rs.filter((r) => r && r.kind === k);
  const pre = kind('PRE_REVIEW');
  const fin = kind('FINAL_REVIEW');
  const dur = (list) => mean(list.map((r) => r && r.durationMs).filter(Number.isFinite));
  const aggregates = {
    total: rs.length,
    preReview: pre.length,
    finalReview: fin.length,
    approvals: rs.filter((r) => r && r.verdict === 'PASS').length,
    changesRequested: rs.filter((r) => r && r.verdict === 'REWORK').length,
    avgPreReviewMs: dur(pre),
    avgFinalReviewMs: dur(fin),
    avgFindings: mean(rs.map((r) => (r && Array.isArray(r.findings)) ? r.findings.length : null).filter((v) => v !== null)),
  };
  const bound = rs.filter(hasBinding);
  if (!bound.length) {
    return { comparable: false, notComparableReason: 'NO_BOUND_EVALUATIONS', reviewTarget: null, evidenceDigest: null, verdictAgreement: null, ...aggregates };
  }
  // The latest bound evaluation pins the candidate round.
  const K = bindingKey(bound[bound.length - 1]);
  const preK = [...bound].reverse().find((r) => r.kind === 'PRE_REVIEW' && bindingKey(r) === K) ?? null;
  const finK = [...bound].reverse().find((r) => r.kind === 'FINAL_REVIEW' && bindingKey(r) === K) ?? null;
  if (preK && finK) {
    const last = bound[bound.length - 1];
    return {
      comparable: true,
      notComparableReason: null,
      reviewTarget: canonicalTarget(last.reviewTarget),
      evidenceDigest: last.evidenceDigest.toLowerCase(),
      verdictAgreement: preK.verdict === finK.verdict,
      ...aggregates,
    };
  }
  const pres = bound.filter((r) => r.kind === 'PRE_REVIEW');
  const fins = bound.filter((r) => r.kind === 'FINAL_REVIEW');
  let reason;
  if (!pres.length || !fins.length) {
    reason = 'MISSING_REVIEW_KIND';
  } else {
    const pT = new Set(pres.map(targetKey));
    const fT = new Set(fins.map(targetKey));
    reason = (pT.size === 1 && fT.size === 1 && [...pT][0] === [...fT][0])
      ? 'EVIDENCE_DIGEST_MISMATCH'
      : 'REVIEW_TARGET_MISMATCH';
  }
  return { comparable: false, notComparableReason: reason, reviewTarget: null, evidenceDigest: null, verdictAgreement: null, ...aggregates };
}
