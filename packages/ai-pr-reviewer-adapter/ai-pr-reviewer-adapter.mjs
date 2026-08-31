#!/usr/bin/env node
// ai-pr-reviewer-adapter.mjs — Soc_brain: minimal call-through adapter to the
// external AI_PR_REVIEWER reviewer (Issue #11).
//
// Source pin (read-only): duongpdddic-droid/AI_PR_REVIEWER
// Immutable source SHA:  9c104c88dddb3e9aad0388447e9be6ff74f78a06
// NOT used: PR #24, scripts/full-verify.mjs, reviewer policy, GPT approval
// flow, Test Evidence, .clinerules/* verbatim.
//
// Boundary contract (closed by reviewer findings 1–7 of PR #12 plus the
// 3 follow-up gaps in review 5062311773 plus the 3 deeper gaps in
// review 5062377060):
//   F1 PRE_REVIEW_PASS is NEVER final. Only an explicit `APPROVED` from
//      a `res.finalReview === true` transport can land on APPROVED, and
//      only when (a) the gate is absent/null OR an object with
//      `status === "PASS"` exactly, AND (b) `res.findings` and
//      `res.openBlocking` are both arrays with no recognized blocker
//      severity AND no malformed entry (fail-closed). Any non-object
//      `decisionGate` (string, number, array) blocks. A non-array
//      `openBlocking` (string, number, object, null) blocks. A blocking
//      severity in `findings` blocks even if `openBlocking` is empty
//      (the transport must not get a free pass on disagreement). A
//      malformed openBlocking entry (non-object, missing severity, or
//      unknown severity) is also a blocker (fail-closed). An open
//      Critical/Important finding or blocker must never produce
//      APPROVED. Otherwise the verdict is at most
//      VERIFIED_WITH_WARNINGS.
//   F2 Any `res.ok !== true` (incl. non-zero exit, UNKNOWN, ERROR,
//      MALFORMED_OUTPUT, TIMEOUT) fails closed BEFORE the HEAD lock
//      and BEFORE status normalization. A failure that happens to echo
//      the requested HEAD and say APPROVED is still rejected.
//   F3 Correlation key binds to (canonicalRepo, pr, full 40-char HEAD,
//      projectId). Same inputs => same key; any field change => new
//      key. HEAD and projectId are first-class identity, not optional.
//   F4 Every transport-derived string and object is run through
//      recursive secret + HOME-path redaction, including `detail`,
//      `decisionGate`, nested `findings`, and the
//      `e.message`/`e.stack` surface from a transport throw.
//   F5 Canonical identity is bound via the Project Registry. The
//      registered `repository` and `projectId` must equal the request
//      and the supplied `htmlUrl` must be a github.com pull URL whose
//      final number equals `request.pr`. Invalid identity does NOT
//      reach the transport.
//   F6 The default live transport is policy-neutral: with no stable
//      pinned live entrypoint that returns a final verdict for
//      (repo, pr, sha) without GitHub mutation, `defaultCallReviewer`
//      returns UNSUPPORTED_TRANSPORT — no dynamic import of
//      caller-supplied modules, no `child_process`. The race timer is
//      captured and `clearTimeout`-ed on settle so a never-resolving
//      transport still resolves TIMEOUT and a hung callback cannot keep
//      the Node process alive.
//
// Reuse (no reimplementation):
//   - packages/task-intake: parseProjectFromHtmlUrl, compactEvidence.
//   - packages/safe-git:   parseRepoFromRemoteUrl, remoteIsCanonical.
//   - packages/project-registry: loadRegistry (registry is the source
//     of truth for canonical projectId + repository binding).

import {
  parseProjectFromHtmlUrl,
  compactEvidence,
} from "../task-intake/task-intake.mjs";
import {
  parseRepoFromRemoteUrl,
  remoteIsCanonical,
} from "../safe-git/safe-git.mjs";
import { loadRegistry } from "../project-registry/project-registry.mjs";

const SHA40 = /^[0-9a-f]{40}$/;
const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// projectId shape: lowercase, alnum/dash/underscore, 1..64 chars.
const PROJECT_ID_RE = /^[a-z0-9_][a-z0-9_-]{0,63}$/;

export const STATUSES = Object.freeze([
  "APPROVED",
  "CHANGES_REQUESTED",
  "VERIFIED_WITH_WARNINGS",
  "BLOCKED",
  "ERROR",
]);

// ---------- redaction (recursive) -----------------------------------------

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


// ---------- correlation key (F3) ------------------------------------------

// Deterministic 64-bit FNV-1a, hex. Stable across processes; no I/O.
function fnv1a64Hex(str) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

// Build a deterministic correlation key from the immutable inputs.
// F3: same (repo, pr, headSha, projectId) => same key; any field change
// => new key. HEAD and projectId are part of the identity.
export function buildCorrelationKey({ repo, pr, headSha, projectId }) {
  if (!OWNER_REPO_RE.test(String(repo || ""))) return null;
  if (!Number.isInteger(Number(pr)) || Number(pr) <= 0) return null;
  if (!SHA40.test(String(headSha || "").toLowerCase())) return null;
  if (typeof projectId !== "string" || !projectId) return null;
  const seed = [
    "ai-pr-reviewer",
    "v1",
    String(repo).toLowerCase(),
    String(Number(pr)),
    String(headSha).toLowerCase(),
    String(projectId).toLowerCase(),
  ].join("|");
  return fnv1a64Hex(seed);
}

// ---------- request validation (F5) ---------------------------------------

export function validateRequest(request) {
  const errs = [];
  if (!request || typeof request !== "object") return { ok: false, reason: "REQUEST_MISSING" };
  const repo = String(request.repo || "").trim();
  if (!repo || !OWNER_REPO_RE.test(repo)) errs.push("INVALID_REPO");
  const pr = Number(request.pr);
  if (!Number.isInteger(pr) || pr <= 0) errs.push("INVALID_PR_NUMBER");
  const headSha = String(request.headSha || "").toLowerCase();
  if (!SHA40.test(headSha)) errs.push("INVALID_HEAD_SHA");
  const projectId = String(request.projectId || "").trim();
  if (!projectId) errs.push("INVALID_PROJECT_ID");
  else if (!PROJECT_ID_RE.test(projectId)) errs.push("INVALID_PROJECT_ID");
  if (errs.length) return { ok: false, reason: errs.join("|") };
  return { ok: true, normalized: { repo, pr, headSha, projectId } };
}

// Validate canonical identity against the Project Registry and the
// supplied htmlUrl. F5: projectId+repo must be registered; htmlUrl must
// be a github.com pull URL whose number equals request.pr.
export function validateCanonicalIdentity({ repo, pr, projectId, htmlUrl }, { registryPath } = {}) {
  let registry;
  try {
    registry = loadRegistry({ registryPath });
  } catch (e) {
    return { ok: false, reason: "REGISTRY_UNAVAILABLE", detail: String((e && e.message) || e) };
  }
  const projects = (registry && Array.isArray(registry.projects)) ? registry.projects : [];
  const entry = projects.find(function (p) { return p && p.projectId === projectId; });
  if (!entry) return { ok: false, reason: "UNKNOWN_PROJECT_ID" };
  if (String(entry.repository || "") !== String(repo)) {
    return { ok: false, reason: "REGISTRY_REPO_MISMATCH" };
  }
  if (typeof htmlUrl === "string" && htmlUrl) {
    const parsed = parseProjectFromHtmlUrl(htmlUrl, { require: "pull" });
    if (!parsed || parsed.type !== "pull") {
      return { ok: false, reason: "HTML_URL_NOT_PULL" };
    }
    if (parsed.owner + "/" + parsed.repo !== String(repo)) {
      return { ok: false, reason: "HTML_URL_REPO_MISMATCH" };
    }
    if (parsed.number !== pr) {
      return { ok: false, reason: "HTML_URL_PR_MISMATCH" };
    }
    if (!remoteIsCanonical("https://github.com/" + parsed.owner + "/" + parsed.repo, repo)) {
      return { ok: false, reason: "HTML_URL_REPO_MISMATCH" };
    }
  }
  return { ok: true, manifest: entry };
}

// ---------- status normalization (F1) -------------------------------------

// A locally-sourced pre-review verdict (`PRE_REVIEW_PASS`) is intrinsically
// non-final. It can land at most on VERIFIED_WITH_WARNINGS. Final APPROVED
// requires an explicit final-transport verdict (`APPROVED` from a
// `res.finalReview === true` call) AND a gate whose `status` is exactly
// `"PASS"` (not missing, not "ALLOW", not anything else) AND no open
// blocker (no recognized Critical/Important severity in either
// `findings` or `openBlocking` AND no malformed entry — fail-closed).
// `findings` and `openBlocking` are both cross-checked: a blocking
// severity in `findings` blocks even if `openBlocking` is empty. A
// non-object `decisionGate` (string, number, array) blocks. A
// non-array `openBlocking` (string, number, object, null) blocks.
// Anything else is at most VERIFIED_WITH_WARNINGS; any blocking
// finding, malformed entry, or non-PASS gate collapses the verdict to
// CHANGES_REQUESTED or BLOCKED.
const BLOCKING_SEVERITIES = new Set(["critical", "important", "blocker", "blocking"]);

function isOpenBlockingMalformed(ob) {
  // Anything that is not an object with a recognized blocker severity
  // counts as malformed and therefore fails closed. The transport must
  // not be allowed to approve with a non-conforming openBlocking list.
  if (ob == null) return true;
  if (typeof ob !== "object") return true;
  const s = String(ob.severity || "").toLowerCase();
  if (!s) return true;
  return !BLOCKING_SEVERITIES.has(s);
}

function isOpenBlocker(ob) {
  // An entry is an explicit blocker iff it is an object with a
  // recognized blocker severity.
  if (!ob || typeof ob !== "object") return false;
  const s = String(ob.severity || "").toLowerCase();
  return BLOCKING_SEVERITIES.has(s);
}

function isFindingBlocker(f) {
  // A finding is a blocker iff it is an object with a recognized blocker
  // severity. Per the pinned source, missing finding status defaults to
  // open and "Important" is blocking — so any finding carrying a
  // blocking severity is treated as an open blocker.
  if (!f || typeof f !== "object") return false;
  const s = String(f.severity || "").toLowerCase();
  return BLOCKING_SEVERITIES.has(s);
}

export function normalizeStatus(transportStatus, { findings = [], openBlocking, decisionGate, finalReview = false } = {}) {
  const s = String(transportStatus || "").toUpperCase();

  // openBlocking must be an explicit array. Anything else (string, number,
  // object, null, undefined) is malformed and blocks (fail-closed).
  if (openBlocking !== undefined && openBlocking !== null && !Array.isArray(openBlocking)) {
    return "CHANGES_REQUESTED";
  }
  const openBlockingList = Array.isArray(openBlocking) ? openBlocking : [];

  // findings must be an array if present. Anything else blocks (fail-closed).
  if (findings !== undefined && findings !== null && !Array.isArray(findings)) {
    return "CHANGES_REQUESTED";
  }
  const findingsList = Array.isArray(findings) ? findings : [];

  // Cross-check findings and openBlocking for blockers AND malformed
  // entries. A finding with a blocking severity blocks even if
  // openBlocking is empty; a malformed openBlocking entry blocks even
  // if findings is clean.
  const hasFindingsBlocker = findingsList.some(isFindingBlocker);
  const hasExplicitBlocker = openBlockingList.some(isOpenBlocker);
  const hasMalformedOpenBlocking = openBlockingList.some(isOpenBlockingMalformed);
  const hasBlocking = hasFindingsBlocker || hasExplicitBlocker || hasMalformedOpenBlocking;

  // decisionGate must be either absent/null OR an object whose
  // `status` is exactly "PASS". Any other value (string, number,
  // array, object without status, object with non-PASS status)
  // blocks (fail-closed).
  let gateBlocks = false;
  if (decisionGate !== undefined && decisionGate !== null) {
    if (typeof decisionGate !== "object" || Array.isArray(decisionGate)) {
      gateBlocks = true;
    } else {
      const gateStatus = String(decisionGate.status || "").toUpperCase();
      if (gateStatus !== "PASS") gateBlocks = true;
    }
  }
  const explicitFinalApproval =
    s === "APPROVED" && finalReview === true && !gateBlocks && !hasBlocking;

  if (hasBlocking || gateBlocks) {
    if (s === "APPROVED") {
      // A final-review verdict that surfaces a blocking finding or a
      // non-PASS gate collapses to CHANGES_REQUESTED. BLOCKED is reserved
      // for HEAD/identity issues handled upstream.
      return "CHANGES_REQUESTED";
    }
    if (s === "PRE_REVIEW_PASS" || s === "PRE_REVIEW_FINDINGS" || s === "CHANGES_REQUESTED" || s === "REQUEST_FIX") {
      return "CHANGES_REQUESTED";
    }
    if (s.startsWith("BLOCKED")) return "BLOCKED";
    return "CHANGES_REQUESTED";
  }

  if (s === "APPROVED") {
    return explicitFinalApproval ? "APPROVED" : "VERIFIED_WITH_WARNINGS";
  }
  if (s === "PRE_REVIEW_PASS") {
    // PRE_REVIEW_PASS is intrinsically non-final. Even if the transport
    // sets finalReview=true, a local pre-review is not a final transport
    // verdict. Always non-final: VERIFIED_WITH_WARNINGS at best.
    return "VERIFIED_WITH_WARNINGS";
  }
  if (s === "PRE_REVIEW_FINDINGS" || s === "CHANGES_REQUESTED" || s === "REQUEST_FIX") return "CHANGES_REQUESTED";
  if (s === "VERIFIED_WITH_WARNINGS") return "VERIFIED_WITH_WARNINGS";
  if (s === "BLOCKED" || s.startsWith("BLOCKED_")) return "BLOCKED";
  if (s === "ERROR" || s === "UNSUPPORTED_TRANSPORT" || s === "TIMEOUT") return "ERROR";
  return "ERROR";
}

// ---------- default live transport (F6) ----------------------------------

// No stable pinned live entrypoint at source pin returns a final verdict
// for (repo, pr, sha) without GitHub mutation. We therefore refuse
// rather than dynamic-import a caller-supplied module. Future wiring
// (a later issue) will replace this with a shim that reuses the
// reviewer's pure functions; until then `requestReview` defaults to
// UNSUPPORTED_TRANSPORT and the caller must inject a transport.
export async function defaultCallReviewer() {
  return {
    ok: false,
    reason: "UNSUPPORTED_TRANSPORT",
    detail: "no stable pinned live entrypoint returns (repo,pr,sha)->verdict; inject a transport or use VERIFIED_WITH_WARNINGS in tests",
  };
}
// ---------- main entrypoint -----------------------------------------------

export async function requestReview(request, options = {}) {
  const v = validateRequest(request);
  if (!v.ok) {
    return {
      status: "BLOCKED",
      correlationKey: null,
      requestedHeadSha: null,
      responseHeadSha: null,
      transportReason: v.reason,
      evidence: { redactionApplied: true, findingsCount: 0, openBlockingCount: 0 },
      accepted: false,
      detail: "request rejected: " + v.reason,
    };
  }
  const r = v.normalized;

  // F5 canonical identity. Fails closed before the transport is invoked.
  const id = validateCanonicalIdentity(
    { repo: r.repo, pr: r.pr, projectId: r.projectId, htmlUrl: request && request.htmlUrl },
    { registryPath: options.registryPath }
  );
  if (!id.ok) {
    return {
      status: "BLOCKED",
      correlationKey: null,
      requestedHeadSha: r.headSha,
      responseHeadSha: null,
      transportReason: id.reason,
      evidence: { redactionApplied: true, findingsCount: 0, openBlockingCount: 0 },
      accepted: false,
      detail: redactString("identity rejected: " + id.reason + (id.detail ? " (" + id.detail + ")" : "")),
    };
  }

  const correlationKey = buildCorrelationKey({
    repo: r.repo, pr: r.pr, headSha: r.headSha, projectId: r.projectId,
  });
  if (!correlationKey) {
    return {
      status: "BLOCKED",
      correlationKey: null,
      requestedHeadSha: r.headSha,
      responseHeadSha: null,
      transportReason: "IDENTITY_UNSTABLE",
      evidence: { redactionApplied: true, findingsCount: 0, openBlockingCount: 0 },
      accepted: false,
      detail: "could not derive correlation key from immutable inputs",
    };
  }

  const transport = typeof options.transport === "function"
    ? options.transport
    : function (req, ctx) { return defaultCallReviewer(req, ctx); };
  const ctx = {
    registryPath: options.registryPath,
    policy: options.policy,
    diffText: options.diffText,
  };

  // F2: any res.ok !== true, non-zero exit, TIMEOUT, UNKNOWN or
  // MALFORMED output fails closed BEFORE the HEAD lock.
  let res;
  let timer = null;
  try {
    res = await new Promise(function (resolve, reject) {
      let settled = false;
      const ms = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 1000;
      timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve({ ok: false, reason: "TIMEOUT", detail: "transport did not return within " + ms + "ms" });
      }, ms);
      // F6: keep timer referenced so a never-resolving transport cannot exit the process before TIMEOUT fires. clearTimeout in settle path still releases the handle.
      Promise.resolve()
        .then(function () { return transport(r, ctx); })
        .then(function (v2) {
          if (settled) return; settled = true;
          if (timer) { clearTimeout(timer); timer = null; }
          resolve(v2);
        }, function (e) {
          if (settled) return; settled = true;
          if (timer) { clearTimeout(timer); timer = null; }
          reject(e);
        });
    });
  } catch (e) {
    return {
      status: "ERROR",
      correlationKey,
      requestedHeadSha: r.headSha,
      responseHeadSha: null,
      transportReason: "TRANSPORT_EXCEPTION",
      evidence: { redactionApplied: true, findingsCount: 0, openBlockingCount: 0 },
      accepted: false,
      detail: redactString("transport threw: " + String((e && e.message) || e)),
    };
  } finally {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  if (!res || typeof res !== "object") {
    return {
      status: "ERROR",
      correlationKey,
      requestedHeadSha: r.headSha,
      responseHeadSha: null,
      transportReason: "MALFORMED_OUTPUT",
      evidence: { redactionApplied: true, findingsCount: 0, openBlockingCount: 0 },
      accepted: false,
      detail: "transport returned non-object",
    };
  }

  // F2: any ok !== true fails closed BEFORE HEAD lock.
  if (res.ok !== true) {
    const reason = String(res.reason || "TRANSPORT_FAIL");
    return {
      status: "ERROR",
      correlationKey,
      requestedHeadSha: r.headSha,
      responseHeadSha: null,
      transportReason: redactString(reason),
      evidence: redactValue({
        redactionApplied: true,
        findingsCount: 0,
        openBlockingCount: 0,
        decisionGate: res.decisionGate || null,
      }),
      accepted: false,
      detail: redactString(typeof res.detail === "string" ? res.detail : "transport reported failure"),
    };
  }

  // HEAD lock read-back. Drift or absence fails closed.
  const echoed = typeof res.reviewedHeadSha === "string" ? res.reviewedHeadSha.toLowerCase() : "";
  if (!SHA40.test(echoed)) {
    return {
      status: "BLOCKED",
      correlationKey,
      requestedHeadSha: r.headSha,
      responseHeadSha: null,
      transportReason: "MISSING_RESPONSE_HEAD",
      evidence: redactValue({ redactionApplied: true, findingsCount: 0, openBlockingCount: 0, decisionGate: res.decisionGate || null }),
      accepted: false,
      detail: "transport did not echo a full 40-char HEAD SHA",
    };
  }
  if (echoed !== r.headSha) {
    return {
      status: "BLOCKED",
      correlationKey,
      requestedHeadSha: r.headSha,
      responseHeadSha: echoed,
      transportReason: "HEAD_MISMATCH",
      evidence: redactValue({ redactionApplied: true, findingsCount: 0, openBlockingCount: 0, decisionGate: res.decisionGate || null }),
      accepted: false,
      detail: "transport reviewed a different HEAD than requested",
    };
  }

  // F1 + F4: status mapping and recursive redaction.
  // Pass `res.openBlocking` and `res.findings` through verbatim so
  // `normalizeStatus` can enforce strict shape (non-array openBlocking
  // or findings blocks). After normalization, rebuild a list to redact
  // and to count for the evidence.
  const status = normalizeStatus(res.verdict, {
    openBlocking: res.openBlocking,
    findings: res.findings,
    decisionGate: res.decisionGate,
    finalReview: res.finalReview === true,
  });
  const openBlockingRaw = Array.isArray(res.openBlocking) ? res.openBlocking : [];
  const findingsRaw = Array.isArray(res.findings) ? res.findings : [];
  const redactedFindings = findingsRaw.map(function (f) {
    if (!f || typeof f !== "object") return redactValue(f);
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
    evidence: redactValue({
      redactionApplied: true,
      findingsCount: redactedFindings.length,
      openBlockingCount: openBlockingRaw.length,
      decisionGate: res.decisionGate || null,
      findings: redactedFindings,
    }),
    accepted: status === "APPROVED",
    detail: redactString(typeof res.detail === "string" ? res.detail : "ok"),
  };
}
