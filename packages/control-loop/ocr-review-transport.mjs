// packages/control-loop/ocr-review-transport.mjs — PRE-GATE-REVIEW-01.
//
// Real, read-only review transport for the pre-gate composite. It drives
// the REVIEW-ONLY OpenCode/OCR leg vendored from the
// ocr/review-only-leg lineage (packages/review-leg/review-only.mjs) and
// normalizes its ReviewEvidence v1 into the AI_PR_REVIEWER transport
// response contract that requestReview() expects:
//   { ok: true, verdict, reviewedHeadSha, finalReview, decisionGate,
//     findings, openBlocking }
//
// Authority: none. The leg runs in a disposable snapshot worktree with
// edit:deny + bash:deny; this transport never edits, commits, or merges.
// A leg failure (timeout, unavailable ocr/opencode, binding invalid,
// diff over-bound) is a typed refusal: { ok: false, reason } and the
// composite blocks the gate — it is never a CLEAN review.

import { runReviewOnlyLeg } from '../review-leg/review-only.mjs';

function fail(reason, detail = null) {
  return { ok: false, reason, detail: detail ?? null };
}

// Findings coming back from the leg are passed through verbatim to the
// adapter's fail-closed normalizer (unrecognized shape => not CLEAN).
function mapFindings(findings) {
  return Array.isArray(findings) ? [...findings] : [];
}

export function createOcrReviewTransport({
  controlRepo = null,
  ocrBin = undefined,
  ocr = undefined,
  model = null,
  timeoutMs = 10 * 60 * 1000,
  env = process.env,
  exec = undefined,
  spawnReview = undefined,
  resolveExecutable = undefined,
  resolveOcr = undefined,
  runLeg = runReviewOnlyLeg,
} = {}) {
  return async function ocrReviewTransport(req, ctx) {
    const cand = ctx && typeof ctx === 'object' ? ctx.candidate : null;
    if (!cand || typeof cand !== 'object') {
      return fail('CANDIDATE_MISSING', 'review transport requires a bound candidate from the composite');
    }
    if (typeof req.headSha !== 'string' || req.headSha !== cand.headSha) {
      return fail('HEAD_DRIFT', `request headSha ${req.headSha} != candidate headSha ${cand.headSha}`);
    }
    if (!cand.baseSha || !cand.identityHash || !cand.worktreePath) {
      return fail('CANDIDATE_INCOMPLETE', 'candidate must carry baseSha, identityHash and worktreePath');
    }
    const repoControlPath = typeof controlRepo === 'string' && controlRepo ? controlRepo : cand.worktreePath;
    const args = {
      repo: req.repo,
      issueNumber: cand.issueNumber,
      identityHash: cand.identityHash,
      baseSha: cand.baseSha,
      headSha: cand.headSha,
      controlRepo: repoControlPath,
      model,
      timeoutMs,
      env,
    };
    if (ocrBin !== undefined) args.ocrBin = ocrBin;
    if (ocr !== undefined) args.ocr = ocr;
    if (exec !== undefined) args.exec = exec;
    if (spawnReview !== undefined) args.spawnReview = spawnReview;
    if (resolveExecutable !== undefined) args.resolveExecutable = resolveExecutable;
    if (resolveOcr !== undefined) args.resolveOcr = resolveOcr;

    let r;
    try {
      r = runLeg(args);
    } catch (e) {
      return fail('REVIEW_LEG_EXCEPTION', String((e && e.message) || e));
    }
    if (!r || typeof r !== 'object' || r.ok !== true) {
      return fail(r && typeof r === 'object' ? (r.code || 'REVIEW_LEG_FAILED') : 'REVIEW_LEG_MALFORMED', r && typeof r === 'object' ? (r.detail ?? null) : null);
    }
    const evidence = r.value;
    const findings = Array.isArray(evidence && evidence.findings) ? evidence.findings : [];
    // A clean leg run is the only path to APPROVED; any finding blocks.
    if (findings.length === 0) {
      return {
        ok: true,
        verdict: 'APPROVED',
        reviewedHeadSha: cand.headSha,
        finalReview: true,
        decisionGate: { status: 'PASS' },
        findings: [],
        openBlocking: [],
        detail: 'ocr leg clean',
      };
    }
    return {
      ok: true,
      verdict: 'CHANGES_REQUESTED',
      reviewedHeadSha: cand.headSha,
      finalReview: true,
      decisionGate: { status: 'PASS' },
      findings: mapFindings(findings),
      openBlocking: [],
      detail: 'ocr leg findings',
    };
  };
}
