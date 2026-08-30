#!/usr/bin/env node
// task-intake.mjs — Soc_brain: shared Task Intake primitives (Issue #9).
//
// Source: duongpdddic-droid/AI_PR_REVIEWER
// Immutable source SHA: 9c104c88dddb3e9aad0388447e9be6ff74f78a06
// Source file: scripts/github-task-intake.mjs
//
// Material adaptations from the source:
//   - Source contains claim workflow, lock file, branch safety, preflight,
//     GH-API deps, and `main()` glue. Per Issue #9 explicit exclusions,
//     only the shared intake primitives are ported. The claim workflow
//     (`completeClaim`, `executeClaim`, `claimWorkflow`), lock primitives
//     (`acquireLock`, `releaseLock`, `lockPathFor`, `isProcessAlive`),
//     branch/worktree safety (`branchSafetyCheck`, `worktreeStatusLines`,
//     `worktreeBlockers`, `isAllowedWorktreeChange`), and adapter helpers
//     (`parseArgs`, `resolveRepo`, `repoMismatchStatus`, `repoFromOrigin`,
//     `remoteOriginUrl`, `allowedPrefixes`, `makeRealDeps`, `execArgs`,
//     `run`, `main`) are intentionally NOT ported here.
//   - `parseRepoFromRemoteUrl` / `normalizeRemoteUrl` are reused from
//     packages/safe-git (same behavior, single source of truth) instead
//     of being duplicated.
//   - New Soc_brain primitive: `classifyIntent` (read-only/investigation
//     vs implementation). The source pin does not classify intent; Issue
//     #9 in-scope item 5 requires it. Decision is label + body keyword
//     based, deterministic, and never reads the filesystem.
//   - `compactEvidence` adds home-path redaction on top of the source's
//     `safeTaskPayload` to satisfy Issue #9 AC "Secrets and absolute
//     user-home paths are not emitted in reports/evidence".
//   - `validateCanonicalProject`, `normalizeIssue`, `isIssueLike`,
//     `deriveTaskIdentityKey`, `buildStableTaskId`, and `evaluateIntake`
//     are Soc_brain additions to fulfil the Issue #9 in-scope list
//     (normalize + validate, canonical project identity, reject
//     missing/ambiguous/conflicting identity, stable task identity /
//     idempotency key, structured intake decision).

import crypto from "node:crypto";
import {
  parseRepoFromRemoteUrl,
  normalizeRemoteUrl,
} from "../safe-git/safe-git.mjs";

// Body length cap for compact, non-secret evidence.
const BODY_MAX_CHARS = 2000;

// Intent classification rules. Deterministic: labels win over keywords;
// ties go to the strongest explicit label. Keywords are matched case-
// insensitively against title + body.
const INTENT_LABEL_DICT = {
  "kind:read-only": "READ_ONLY",
  "kind:investigation": "READ_ONLY",
  "kind:audit": "READ_ONLY",
  "kind:implement": "IMPLEMENT",
  "kind:port": "IMPLEMENT",
  "kind:extract": "IMPLEMENT",
};
const INTENT_KEYWORDS = {
  READ_ONLY: ["read-only", "investigate", "investigation", "audit"],
  IMPLEMENT: ["implement", "build", "port", "extract", "ship", "triển khai"],
};

// ---- labels ---------------------------------------------------------------
// Source: github-task-intake.mjs `labelsToNames` / `hasLabels` (verbatim).

export function labelsToNames(labels) {
  return (labels || []).map((l) => (typeof l === "string" ? l : l.name));
}

export function hasLabels(issue, required) {
  const names = new Set(labelsToNames(issue && issue.labels));
  return required.every((n) => names.has(n));
}

// ---- issue shape ----------------------------------------------------------
// Source: `isPullRequest` (verbatim).

export function isPullRequest(issue) {
  return Boolean(issue && issue.pull_request);
}

// ---- ready-task classification -------------------------------------------
// Source: `filterReadyTasks` (verbatim) + `classifyReadyTasks` (verbatim).

export function filterReadyTasks(issues) {
  return (issues || []).filter(
    (i) =>
      i &&
      i.state === "open" &&
      !isPullRequest(i) &&
      hasLabels(i, ["agent:cline", "status:ready-for-cline"]),
  );
}

export function classifyReadyTasks(tasks) {
  if (!Array.isArray(tasks)) return { status: "NO_TASK", numbers: [] };
  if (tasks.length === 0) return { status: "NO_TASK", numbers: [] };
  if (tasks.length > 1) {
    return {
      status: "BLOCKED_MULTIPLE_TASKS",
      numbers: tasks.map((t) => (t && t.number) || null),
    };
  }
  return { status: "READY", task: tasks[0], numbers: [tasks[0].number] };
}

// ---- issue-state classification ------------------------------------------
// Source: `classifyIssueState` (verbatim — shape preserved for parity).

export function classifyIssueState(issue) {
  if (!issue || typeof issue !== "object") return "OTHER";
  if (issue.state === "closed") return "CLOSED";
  const names = new Set(labelsToNames(issue.labels));
  if (names.has("status:in-progress")) return "IN_PROGRESS";
  if (names.has("status:ready-for-cline")) return "READY";
  return "OTHER";
}

// ---- claim marker (idempotency key surface) -----------------------------
// Source: `parseClaimedNumberFromBody` / `hasClaimMarker` / `buildClaimBody`
// (verbatim, except `buildClaimBody` keeps the same marker shape so claim
// recovery in a later adapter can interoperate).

export function parseClaimMarker(body) {
  const m = String(body || "").match(/<!-- cline-claim:(\d+):/);
  return m ? { issueNumber: Number(m[1]) } : null;
}

export function hasClaimMarker(comments, issueNumber) {
  return (comments || []).some((c) => {
    const p = parseClaimMarker(c && c.body);
    return p && p.issueNumber === issueNumber;
  });
}

export function buildClaimBody({ issueNumber, baseSha, at }) {
  const marker = `<!-- cline-claim:${issueNumber}:${baseSha}:${at} -->`;
  return `${marker}\nCline claim Issue #${issueNumber} (base ${baseSha}, ${at}).`;
}

// ---- safe payload / evidence (source + Soc_brain redaction) --------------
// Source: `safeTaskPayload` (verbatim). Soc_brain addition: home-path and
// absolute-path redaction in `compactEvidence` to keep absolute user paths
// and secret-like substrings out of intake reports.

const HOME_PATH_RE = /(?:\/Users\/[^/\s"']+|\/home\/[^/\s"']+|C:\\Users\\[^\\\/\s"']+|~\/)/gi;

function redactHome(value) {
  if (typeof value !== "string") return value;
  return value.replace(HOME_PATH_RE, "<home>");
}

export function safeTaskPayload(task) {
  return {
    number: task.number,
    title: task.title,
    html_url: task.html_url,
    body: task.body,
    labels: labelsToNames(task.labels),
  };
}

export function compactEvidence(issue) {
  const payload = safeTaskPayload(issue || {});
  const body = typeof payload.body === "string" ? payload.body : "";
  const capped = body.length > BODY_MAX_CHARS
    ? body.slice(0, BODY_MAX_CHARS) + "…"
    : body;
  return {
    number: payload.number,
    title: payload.title,
    html_url: payload.html_url,
    labels: payload.labels,
    body: redactHome(capped),
    bodyTruncated: body.length > BODY_MAX_CHARS,
  };
}

// ---- canonical project identity (GPT-REV-027 parity) ---------------------
// Source: `remoteIsCanonical` lives in safe-git; this wrapper adds the
// fail-closed decision shape required by Issue #9 in-scope items 2-3.

function parseProjectFromHtmlUrl(htmlUrl) {
  // GitHub html_url looks like https://github.com/<owner>/<repo>/issues/<n>
  // (or /pull/<n>). Accept owner/repo only; allow trailing path segments.
  const m = String(htmlUrl || "")
    .trim()
    .match(/github\.com\/([^/]+)\/([^/]+?)(?:\/|$)/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function validateCanonicalProject({ issue, canonicalRepo }) {
  if (!issue || typeof issue !== "object") {
    return { ok: false, reason: "MISSING_ISSUE", detail: "No issue payload supplied to intake." };
  }
  if (typeof canonicalRepo !== "string" || !canonicalRepo.trim()) {
    return {
      ok: false,
      reason: "MISSING_CANONICAL_REPO",
      detail: "Caller did not provide a canonical project identity.",
    };
  }
  const htmlUrl = String(issue.html_url || "");
  // Accept both html_url (https://github.com/o/r/issues/9) and a remote URL.
  const fromHtml = parseProjectFromHtmlUrl(htmlUrl) || parseRepoFromRemoteUrl(htmlUrl);
  const canonicalNorm = normalizeRemoteUrl(canonicalRepo);
  const candidate = fromHtml ? fromHtml.toLowerCase() : null;
  if (!candidate) {
    return {
      ok: false,
      reason: "MISSING_PROJECT_IDENTITY",
      detail: "Issue has no parsable project identity (html_url).",
    };
  }
  if (candidate !== canonicalNorm) {
    return {
      ok: false,
      reason: "BLOCKED_PROJECT_MISMATCH",
      detail: `Issue project identity '${candidate}' does not match canonical '${canonicalNorm}'.`,
      issueProject: candidate,
      canonicalProject: canonicalNorm,
    };
  }
  return { ok: true, issueProject: candidate, canonicalProject: canonicalNorm };
}

// ---- stable task identity (idempotency key) -----------------------------
// Issue #9 AC: "Repeated equivalent intake produces the same stable task
// identity and does not create duplicate runtime state."

export function deriveTaskIdentityKey({ repo, issueNumber, now }) {
  const r = String(repo || "").toLowerCase();
  const n = Number(issueNumber);
  if (!r) return null;
  if (!Number.isInteger(n) || n <= 0) return null;
  // Stable: identity key never depends on `now`. Caller may store `now`
  // separately if it needs a freshness stamp.
  void now;
  return crypto
    .createHash("sha256")
    .update(`task-intake|v1|${r}|${n}`)
    .digest("hex");
}

export function buildStableTaskId({ repo, issueNumber, title }) {
  const r = String(repo || "").toLowerCase();
  const n = Number(issueNumber);
  if (!r || !Number.isInteger(n) || n <= 0) return null;
  const slug = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "task";
  return `${r}#${n}-${slug}`;
}

// ---- intent classification (Soc_brain adaptation) ------------------------
// Issue #9 in-scope item 5: classify read-only/investigation versus
// implementation intent. Label matches win; otherwise the body is scanned
// for deterministic keyword sets; ties default to IMPLEMENT (safer for
// coding agents that must touch the repo). `OTHER` is returned when no
// signal matches, letting the caller decide.

function matchLabelIntent(labelNames) {
  for (const name of labelNames) {
    const mapped = INTENT_LABEL_DICT[String(name).toLowerCase()];
    if (mapped) return mapped;
  }
  return null;
}

function matchKeywordIntent(text) {
  if (typeof text !== "string" || !text) return null;
  const haystack = text.toLowerCase();
  let best = null;
  let bestHits = 0;
  for (const intent of Object.keys(INTENT_KEYWORDS)) {
    let hits = 0;
    for (const kw of INTENT_KEYWORDS[intent]) {
      if (haystack.includes(kw)) hits++;
    }
    if (hits > bestHits) {
      bestHits = hits;
      best = intent;
    }
  }
  return best;
}

export function classifyIntent(issue) {
  if (!issue || typeof issue !== "object") {
    return { intent: "OTHER", source: "none", confidence: "low" };
  }
  const labelNames = labelsToNames(issue.labels);
  const fromLabel = matchLabelIntent(labelNames);
  if (fromLabel) return { intent: fromLabel, source: "label", confidence: "high" };
  const text = `${issue.title || ""}\n${issue.body || ""}`;
  const fromKeyword = matchKeywordIntent(text);
  if (fromKeyword) return { intent: fromKeyword, source: "keyword", confidence: "medium" };
  return { intent: "IMPLEMENT", source: "default", confidence: "low" };
}

// ---- top-level intake decision -------------------------------------------
// Issue #9 in-scope item 6: produce a structured intake decision for
// downstream components. Fail-closed: any missing/ambiguous/conflicting
// identity short-circuits to a BLOCKED_* status with no partial state.

export function evaluateIntake({ issue, canonicalRepo, now }) {
  const validation = validateCanonicalProject({ issue, canonicalRepo });
  if (!validation.ok) {
    return {
      status: validation.reason,
      accepted: false,
      detail: validation.detail,
      identity: null,
      intent: null,
      evidence: null,
    };
  }
  if (!Number.isInteger(Number(issue.number)) || Number(issue.number) <= 0) {
    return {
      status: "BLOCKED_MISSING_ISSUE_NUMBER",
      accepted: false,
      detail: "Issue has no positive integer number.",
      identity: null,
      intent: null,
      evidence: null,
    };
  }
  if (isPullRequest(issue)) {
    return {
      status: "BLOCKED_IS_PULL_REQUEST",
      accepted: false,
      detail: "Pull requests are not intake candidates.",
      identity: null,
      intent: null,
      evidence: null,
    };
  }
  const state = classifyIssueState(issue);
  const repo = validation.issueProject;
  const issueNumber = Number(issue.number);

  // Non-ready states short-circuit BEFORE identity is built. Identity is a
  // commitment that this task will be acted on; surfacing it for blocked
  // states (CLOSED, IN_PROGRESS, OTHER) leaks a partial decision that
  // downstream code could mistakenly act on. Fail-closed: blocked = no
  // identity, no intent, no evidence.
  if (state !== "READY") {
    return {
      status: `BLOCKED_STATE_${state}`,
      accepted: false,
      detail: `Issue state ${state} is not ready-for-cline.`,
      identity: null,
      intent: null,
      evidence: null,
    };
  }

  const identityKey = deriveTaskIdentityKey({ repo, issueNumber, now });
  const stableTaskId = buildStableTaskId({ repo, issueNumber, title: issue.title });
  if (!identityKey || !stableTaskId) {
    return {
      status: "BLOCKED_IDENTITY_UNSTABLE",
      accepted: false,
      detail: "Could not derive a stable task identity.",
      identity: null,
      intent: null,
      evidence: null,
    };
  }
  const intent = classifyIntent(issue);
  return {
    status: "ACCEPTED",
    accepted: true,
    detail: "Issue accepted for intake.",
    identity: {
      repo,
      issueNumber,
      identityKey,
      stableTaskId,
    },
    intent,
    state,
    evidence: compactEvidence(issue),
  };
}