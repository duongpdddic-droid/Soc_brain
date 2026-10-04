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

import fs from 'node:fs';
import path from 'node:path';

import { runReviewOnlyLeg } from '../review-leg/review-only.mjs';

function fail(reason, detail = null) {
  return { ok: false, reason, detail: detail ?? null };
}

// Findings coming back from the leg are passed through verbatim to the
// adapter's fail-closed normalizer (unrecognized shape => not CLEAN).
function mapFindings(findings) {
  return Array.isArray(findings) ? [...findings] : [];
}

// PRE-GATE-REVIEW-01 evidence sidecar (AUDIT-01: raw response / prompt digest
// were UNKNOWN). Writes the reviewer provenance the leg captured OUTSIDE its
// closed-world v1 evidence: model, executable, promptSha256, stdoutSha256,
// bounded stdout tail, per-step batch phases. Default dir is gitignored
// (artifacts/) so raw reviewer output never enters a commit. A sidecar write
// failure NEVER changes the review verdict (fail-open on the sidecar only);
// the returned `sidecar` field makes written/skipped explicit either way.
function writeEvidenceSidecar({ dir, payload }) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    const atFile = at.replace(/[:.]/g, '-');
    const file = path.join(dir, `${payload.candidate.identityHash}-${payload.candidate.headSha.slice(0, 12)}-${atFile}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...payload, at }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return { written: true, path: file };
  } catch (e) {
    return { written: false, error: String((e && e.message) || e) };
  }
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
  evidenceDir = null,
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

    const sidecarDir = typeof evidenceDir === 'string' && evidenceDir
      ? evidenceDir
      : path.join(repoControlPath, 'artifacts', 'evidence', 'ocr');
    const sidecarBase = {
      schemaVersion: '1',
      source: 'ocr-review-transport',
      request: {
        repo: req.repo,
        pr: req.pr ?? null,
        headSha: req.headSha,
        projectId: typeof req.projectId === 'string' ? req.projectId : null,
      },
      candidate: {
        identityHash: cand.identityHash,
        issueNumber: cand.issueNumber,
        headSha: cand.headSha,
        baseSha: cand.baseSha,
      },
    };

    let r;
    try {
      r = runLeg(args);
    } catch (e) {
      const sidecar = writeEvidenceSidecar({
        dir: sidecarDir,
        payload: { ...sidecarBase, outcome: 'exception', failure: { reason: 'REVIEW_LEG_EXCEPTION', detail: String((e && e.message) || e) }, observability: null },
      });
      return { ...fail('REVIEW_LEG_EXCEPTION', String((e && e.message) || e)), sidecar };
    }
    if (!r || typeof r !== 'object' || r.ok !== true) {
      const reason = r && typeof r === 'object' ? (r.code || 'REVIEW_LEG_FAILED') : 'REVIEW_LEG_MALFORMED';
      const detail = r && typeof r === 'object' ? (r.detail ?? null) : null;
      // A refused leg leaves its provenance on disk too: a missing sidecar
      // must never be readable as "no attempt happened".
      const sidecar = writeEvidenceSidecar({
        dir: sidecarDir,
        payload: { ...sidecarBase, outcome: 'refused', failure: { reason, detail }, observability: r && typeof r === 'object' && r.observability ? r.observability : null },
      });
      return { ...fail(reason, detail), sidecar };
    }
    const evidence = r.value;
    const findings = Array.isArray(evidence && evidence.findings) ? evidence.findings : [];
    const sidecar = writeEvidenceSidecar({
      dir: sidecarDir,
      payload: {
        ...sidecarBase,
        outcome: 'completed',
        verdict: findings.length === 0 ? 'APPROVED' : 'CHANGES_REQUESTED',
        findingsCount: findings.length,
        leg: {
          batch: r.batch ?? null,
          rulesDigest: typeof r.rulesDigest === 'string' ? r.rulesDigest : null,
        },
        observability: r.observability ?? null,
      },
    });
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
        sidecar,
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
      sidecar,
    };
  };
}
