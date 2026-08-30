#!/usr/bin/env node
// ai-pr-reviewer-adapter.mjs — Soc_brain: minimal call-through adapter to the
// external AI_PR_REVIEWER reviewer (Issue #11).
//
// Source pin (read-only): duongpdddic-droid/AI_PR_REVIEWER
// Immutable source SHA:  9c104c88dddb3e9aad0388447e9be6ff74f78a06
// NOT used: PR #24, scripts/full-verify.mjs, reviewer policy, GPT approval
// flow, Test Evidence, .clinerules/* verbatim.
//
// Boundary contract:
//   - The adapter is policy-neutral. It does NOT copy reviewer policy, the
//     approval flow, the head-lock gate, or Test Evidence.
//   - The adapter validates canonical identity, PR number, full 40-char HEAD,
//     project identity, and builds a correlation key from immutable inputs.
//   - The adapter accepts an injected `transport` so deterministic tests run
//     without network or GitHub calls. The default transport attempts to
//     dynamic-import the immutable source module
//     (scripts/review-contract.mjs at the pin) and call its pure
//     `runSemanticPreReview(policy, diffText)` function. There is no stable
//     read-only entrypoint that takes (repo, pr, sha) and returns a final
//     verdict without GitHub mutation at the source pin — the Issue's
//     "explicit unsupported-transport result" path applies for live calls.
//   - HEAD is locked end-to-end: any approval/changes-requested result that
//     does not echo the requested full HEAD SHA fails closed with BLOCKED.
//   - Response is normalized to one of:
//        APPROVED, CHANGES_REQUESTED, VERIFIED_WITH_WARNINGS, BLOCKED, ERROR
//   - Evidence is compact and runs every string through secret + HOME-path
//     redaction before it is returned.
//   - Read-back: after the transport completes, the adapter re-reads the
//     normalized result from the transport return value and the input
//     request to ensure they describe the same immutable inputs.
//
// Reuse (no reimplementation):
//   - packages/task-intake: parseProjectFromHtmlUrl, deriveTaskIdentityKey,
//     compactEvidence.
//   - packages/safe-git:   parseRepoFromRemoteUrl, remoteIsCanonical.
//   - packages/project-registry: ownership matrix + canonical owner/repo shape.
//   - packages/temp-hygiene: assertOutsideWorktree (callers may stage artifacts).

import {
  parseProjectFromHtmlUrl,
  deriveTaskIdentityKey,
  compactEvidence,
} from "../task-intake/task-intake.mjs";
import {
  parseRepoFromRemoteUrl,
  remoteIsCanonical,
} from "../safe-git/safe-git.mjs";

const SHA40 = /^[0-9a-f]{40}$/;
const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const STATUSES = Object.freeze([
  "APPROVED",
  "CHANGES_REQUESTED",
  "VERIFIED_WITH_WARNINGS",
  "BLOCKED",
  "ERROR",
]);

function redactString(s) {
  if (typeof s !== "string" || !s) return s;
  return compactEvidence({ title: "", body: s, labels: [], html_url: "" }).body;
}

function redactValue(v) {
  if (v == null) return v;
  if (typeof v === "string") return redactString(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = redactValue(val);
    return out;
  }
  return v;
}

// Build a deterministic correlation key from the immutable inputs. Same
// (repo, pr, head, projectId) -> same key. Any change -> different key.
export function buildCorrelationKey({ repo, pr, headSha, projectId }) {
  if (!OWNER_REPO_RE.test(String(repo || ''))) return null;
  if (!Number.isInteger(Number(pr)) || Number(pr) <= 0) return null;
  if (!SHA40.test(String(headSha || '').toLowerCase())) return null;
  if (typeof projectId !== 'string' || !projectId) return null;
  return deriveTaskIdentityKey({
    repo: String(repo),
    issueNumber: Number(pr),
    now: headSha.toLowerCase(),
    projectId,
  });
}

export function validateRequest(request) {
  const errs = [];
  if (!request || typeof request !== 'object') return { ok: false, reason: 'REQUEST_MISSING' };
  const repo = String(request.repo || '').trim();
  if (!repo || !OWNER_REPO_RE.test(repo)) errs.push('INVALID_REPO');
  const pr = Number(request.pr);
  if (!Number.isInteger(pr) || pr <= 0) errs.push('INVALID_PR_NUMBER');
  const headSha = String(request.headSha || '').toLowerCase();
  if (!SHA40.test(headSha)) errs.push('INVALID_HEAD_SHA');
  const projectId = String(request.projectId || '').trim();
  if (!projectId) errs.push('INVALID_PROJECT_ID');
  if (errs.length) return { ok: false, reason: errs.join('|') };
  return { ok: true, normalized: { repo, pr, headSha, projectId } };
}

export function normalizeStatus(transportStatus, { openBlockingCount = 0 } = {}) {
  const s = String(transportStatus || '').toUpperCase();
  if (s === 'PRE_REVIEW_PASS' && openBlockingCount === 0) return 'APPROVED';
  if (s === 'PRE_REVIEW_PASS' && openBlockingCount > 0) return 'VERIFIED_WITH_WARNINGS';
  if (s === 'PRE_REVIEW_FINDINGS') return 'CHANGES_REQUESTED';
  if (s === 'CHANGES_REQUESTED' || s === 'REQUEST_FIX') return 'CHANGES_REQUESTED';
  if (s === 'BLOCKED' || s.startsWith('BLOCKED_')) return 'BLOCKED';
  if (s === 'APPROVED') return 'APPROVED';
  if (s === 'VERIFIED_WITH_WARNINGS') return 'VERIFIED_WITH_WARNINGS';
  if (s === 'ERROR' || s === 'UNSUPPORTED_TRANSPORT' || s === 'TIMEOUT') return 'ERROR';
  return 'ERROR';
}

// Default transport: dynamic-import the pinned source's review-contract
// module and call its pure runSemanticPreReview(policy, diffText).
// Documented limitation: no read-only entrypoint at the source pin
// returns a final verdict for (repo, pr, sha) without GitHub mutation.
export async function defaultCallReviewer(request, { sourcePath, policy, diffText } = {}) {
  if (typeof sourcePath !== 'string' || !sourcePath) {
    return { ok: false, reason: 'UNSUPPORTED_TRANSPORT', detail: 'no sourcePath; no live read-only entrypoint at source pin' };
  }
  let mod;
  try {
    mod = await import(sourcePath);
  } catch (e) {
    return { ok: false, reason: 'UNSUPPORTED_TRANSPORT', detail: 'cannot import source review-contract: ' + String((e && e.message) || e) };
  }
  if (typeof mod.runSemanticPreReview !== 'function') {
    return { ok: false, reason: 'UNSUPPORTED_TRANSPORT', detail: 'source module missing runSemanticPreReview' };
  }
  let r;
  try {
    r = mod.runSemanticPreReview(policy || {}, typeof diffText === 'string' ? diffText : '');
  } catch (e) {
    return { ok: false, reason: 'ERROR', detail: 'runSemanticPreReview threw: ' + String((e && e.message) || e) };
  }
  if (!r || typeof r !== 'object') return { ok: false, reason: 'ERROR', detail: 'transport returned non-object' };
  return {
    ok: true,
    verdict: r.verdict,
    findings: Array.isArray(r.findings) ? r.findings : [],
    openBlocking: Array.isArray(r.openBlocking) ? r.openBlocking : [],
    decisionGate: r.decisionGate || null,
  };
}

export async function requestReview(request, options = {}) {
  const v = validateRequest(request);
  if (!v.ok) {
    return {
      status: 'BLOCKED',
      correlationKey: null,
      requestedHeadSha: null,
      responseHeadSha: null,
      transportReason: v.reason,
      evidence: { redactionApplied: true, findingsCount: 0, openBlockingCount: 0 },
      accepted: false,
      detail: 'request rejected: ' + v.reason,
    };
  }
  const r = v.normalized;
  const correlationKey = buildCorrelationKey({
    repo: r.repo,
    pr: r.pr,
    headSha: r.headSha,
    projectId: r.projectId,
  });
  if (!correlationKey) {
    return {
      status: 'BLOCKED',
      correlationKey: null,
      requestedHeadSha: r.headSha,
      responseHeadSha: null,
      transportReason: 'IDENTITY_UNSTABLE',
      evidence: { redactionApplied: true, findingsCount: 0, openBlockingCount: 0 },
      accepted: false,
      detail: 'could not derive correlation key from immutable inputs',
    };
  }

  // Canonical-repo check using safe-git + task-intake parsers, reused
  // without reimplementation. Fail-closed if htmlUrl is given but does
  // not match the canonical owner/repo.
  if (request && typeof request.htmlUrl === 'string' && request.htmlUrl) {
    const parsed = parseProjectFromHtmlUrl(request.htmlUrl);
    // Accept any well-formed owner/repo shape (repo / pull / issue / other)
    // as long as owner+repo are present and match the canonical request.
    const ok = parsed && parsed.owner && parsed.repo
      ? remoteIsCanonical('https://github.com/' + parsed.owner + '/' + parsed.repo, r.repo)
      : false;
    if (!ok) {
      return {
        status: 'BLOCKED',
        correlationKey,
        requestedHeadSha: r.headSha,
        responseHeadSha: null,
        transportReason: 'HTML_URL_REPO_MISMATCH',
        evidence: { redactionApplied: true, findingsCount: 0, openBlockingCount: 0 },
        accepted: false,
        detail: 'htmlUrl owner/repo does not match canonical request repo',
      };
    }
  }

  const transport = typeof options.transport === 'function'
    ? options.transport
    : function (req, ctx) { return defaultCallReviewer(req, ctx); };
  const ctx = {
    sourcePath: options.sourcePath,
    policy: options.policy,
    diffText: options.diffText,
  };

  let res;
  try {
    res = await Promise.race([
      Promise.resolve().then(function () { return transport(r, ctx); }),
      new Promise(function (resolve) {
        const ms = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 1000;
        const t = setTimeout(function () { resolve({ ok: false, reason: 'TIMEOUT' }); }, ms);
        if (t && typeof t.unref === 'function') t.unref();
      }),
    ]);
  } catch (e) {
    return {
      status: 'ERROR',
      correlationKey,
      requestedHeadSha: r.headSha,
      responseHeadSha: null,
      transportReason: 'TRANSPORT_EXCEPTION',
      evidence: { redactionApplied: true, findingsCount: 0, openBlockingCount: 0 },
      accepted: false,
      detail: 'transport threw: ' + String((e && e.message) || e),
    };
  }

  if (!res || typeof res !== 'object') {
    return {
      status: 'ERROR',
      correlationKey,
      requestedHeadSha: r.headSha,
      responseHeadSha: null,
      transportReason: 'MALFORMED_OUTPUT',
      evidence: { redactionApplied: true, findingsCount: 0, openBlockingCount: 0 },
      accepted: false,
      detail: 'transport returned non-object',
    };
  }

  // Transport-level error reason checked BEFORE HEAD lock so a
  // transport that cannot run (UNSUPPORTED_TRANSPORT, TIMEOUT, ERROR)
  // surfaces as ERROR, not a misleading HEAD-mismatch BLOCKED.
  if (res.reason === 'UNSUPPORTED_TRANSPORT' || res.reason === 'TIMEOUT' || res.reason === 'ERROR') {
    return {
      status: 'ERROR',
      correlationKey,
      requestedHeadSha: r.headSha,
      responseHeadSha: null,
      transportReason: res.reason,
      evidence: { redactionApplied: true, findingsCount: 0, openBlockingCount: 0, decisionGate: res.decisionGate || null },
      accepted: false,
      detail: redactString(typeof res.detail === 'string' ? res.detail : 'transport reported error'),
    };
  }

  // HEAD lock read-back. Transport MUST echo the full 40-char HEAD it
  // reviewed, and it MUST equal the requested HEAD. Drift or absence
  // fails closed.
  const echoed = res && typeof res.reviewedHeadSha === 'string' ? res.reviewedHeadSha.toLowerCase() : '';
  if (!/^[0-9a-f]{40}$/.test(echoed)) {
    return {
      status: 'BLOCKED',
      correlationKey,
      requestedHeadSha: r.headSha,
      responseHeadSha: null,
      transportReason: 'MISSING_RESPONSE_HEAD',
      evidence: { redactionApplied: true, findingsCount: 0, openBlockingCount: 0 },
      accepted: false,
      detail: 'transport did not echo a full 40-char HEAD SHA',
    };
  }
  if (echoed !== r.headSha) {
    return {
      status: 'BLOCKED',
      correlationKey,
      requestedHeadSha: r.headSha,
      responseHeadSha: echoed,
      transportReason: 'HEAD_MISMATCH',
      evidence: { redactionApplied: true, findingsCount: 0, openBlockingCount: 0 },
      accepted: false,
      detail: 'transport reviewed a different HEAD than requested',
    };
  }

  const openBlockingCount = Array.isArray(res.openBlocking) ? res.openBlocking.length : 0;
  const status = normalizeStatus(res.verdict, { openBlockingCount });
  const findings = Array.isArray(res.findings) ? res.findings : [];
  const redactedFindings = findings.map(function (f) {
    if (!f || typeof f !== 'object') return f;
    const o = {};
    for (const [k, val] of Object.entries(f)) o[k] = redactValue(val);
    return o;
  });

  return {
    status,
    correlationKey,
    requestedHeadSha: r.headSha,
    responseHeadSha: echoed,
    transportReason: null,
    evidence: {
      redactionApplied: true,
      findingsCount: redactedFindings.length,
      openBlockingCount,
      decisionGate: res.decisionGate || null,
      findings: redactedFindings,
    },
    accepted: status === 'APPROVED' || status === 'VERIFIED_WITH_WARNINGS',
    detail: 'ok',
  };
}
