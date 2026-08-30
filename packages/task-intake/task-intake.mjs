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
//     of being duplicated. task-intake itself only needs
//     `normalizeRemoteUrl`; the html_url parser is a strict local
//     `parseProjectFromHtmlUrl` that uses `new URL()` and an exact
//     `github.com` host check to defeat substring-spoofing.
//   - New Soc_brain primitive: `classifyIntent` (read-only/investigation
//     vs implementation). The source pin does not classify intent; Issue
//     #9 in-scope item 5 requires it. Decision is label + body keyword
//     based, deterministic, and never reads the filesystem.
//   - `compactEvidence` adds home-path redaction on top of the source's
//     `safeTaskPayload` to satisfy Issue #9 AC "Secrets and absolute
//     user-home paths are not emitted in reports/evidence".
//   - `validateCanonicalProject`, `parseProjectFromHtmlUrl`,
//     `deriveTaskIdentityKey`, `buildStableTaskId`, `buildTaskSlug`,
//     `classifyIntent`, `compactEvidence` (with home-path AND secret
//     redaction), and `evaluateIntake` are Soc_brain additions to fulfil
//     the Issue #9 in-scope list (normalize + validate, canonical project
//     identity, reject missing/ambiguous/conflicting identity, stable
//     task identity / idempotency key, structured intake decision, and
//     compact non-secret evidence).

import crypto from "node:crypto";
import {
  normalizeRemoteUrl,
} from "../safe-git/safe-git.mjs";

// Body length cap for compact, non-secret evidence.
const BODY_MAX_CHARS = 2000;

// Secret-like patterns that must never appear verbatim in reports/evidence.
// Each pattern is matched case-sensitively; the redaction marker preserves
// the category (token/key/header) for downstream debugging while removing
// the secret material itself. Issue #9 AC: "Secrets and absolute user-home
// paths are not emitted in reports/evidence."
//
// Patterns cover:
//   - GitHub classic PAT (ghp_...) and fine-grained PAT (github_pat_...)
//   - HTTP Authorization: Bearer ...
//   - `key=value` style assignments for password / api_key / secret / token
//   - PEM private key blocks
const SECRET_PATTERNS = [
  { kind: "github_pat", re: /ghp_[A-Za-z0-9]{20,}/g },
  { kind: "github_fine_pat", re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { kind: "bearer", re: /Bearer\s+[A-Za-z0-9._\-]+/g },
  {
    kind: "kv_secret",
    re: /\b(?:password|api[_-]?key|secret|token|private[_-]?key)\s*[:=]\s*["']?[^\s"',;}{)<>]{6,}/gi,
  },
  { kind: "pem_private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];

function redactSecret(value) {
  if (typeof value !== "string" || !value) return value;
  // Two-pass: first redact structural patterns (PATs, Bearer, PEM blocks)
  // because they are unambiguous. Then run `kv_secret` ONLY on the
  // non-redacted gaps so that a phrase like `token <secret:github_pat>`
  // (where the PAT has already been replaced) does not get re-wrapped
  // into a generic kv_secret marker, which would lose the PAT kind.
  const slots = [];
  let pass1 = value;
  for (const { kind, re } of SECRET_PATTERNS) {
    if (kind === "kv_secret") continue;
    pass1 = pass1.replace(re, (m) => `\u0000${slots.push(`<secret:${kind}>`) - 1}\u0000`);
  }
  const kvRe = SECRET_PATTERNS.find((p) => p.kind === "kv_secret").re;
  const gaps = pass1.split("\u0000");
  for (let i = 0; i < gaps.length; i++) {
    if (i % 2 === 0) {
      // Outside a marker slot: safe to apply kv_secret.
      gaps[i] = gaps[i].replace(kvRe, () => {
        return `\u0000${slots.push(`<secret:kv_secret>`) - 1}\u0000`;
      });
    }
  }
  return gaps
    .join("\u0000")
    .replace(/\u0000(\d+)\u0000/g, (_, n) => slots[Number(n)]);
}

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
  const rawTitle = typeof payload.title === "string" ? payload.title : "";
  const rawBody = typeof payload.body === "string" ? payload.body : "";
  const rawLabels = Array.isArray(payload.labels) ? payload.labels : [];
  // Redaction order: secret first, then home-path. Secret redaction is
  // applied before length capping so a long secret body still yields
  // a body whose length is bounded by BODY_MAX_CHARS plus ellipsis.
  const title = redactHome(redactSecret(rawTitle));
  const bodySecret = redactHome(redactSecret(rawBody));
  const capped = bodySecret.length > BODY_MAX_CHARS
    ? bodySecret.slice(0, BODY_MAX_CHARS) + "…"
    : bodySecret;
  // Every string emitted into evidence must pass through the secret
  // redaction. Review 5059717485: a label named e.g. `password=hunter2`
  // would survive the previous implementation. We redacted value, never
  // the name itself — GitHub label names are part of the project taxonomy
  // and changing them silently would corrupt audit trails.
  const labels = rawLabels.map((name) => String(name)).map(redactSecret);
  // Sanitize html_url: keep only the canonical https://github.com/<o>/<r>
  // form. Any query/fragment is dropped here defensively even though
  // parseProjectFromHtmlUrl already rejects them — defense in depth so
  // the URL that reaches downstream evidence never carries `?token=...`.
  const htmlUrl = sanitizeHtmlUrlForEvidence(payload.html_url);
  return {
    number: payload.number,
    title,
    html_url: htmlUrl,
    labels,
    body: capped,
    bodyTruncated: rawBody.length > BODY_MAX_CHARS,
  };
}

// Build a non-secret html_url suitable for emission into evidence. The
// function preserves only the GitHub repository page (no trailing
// /issues/N, /pull/N, no query, no fragment). If the URL fails the same
// strict checks parseProjectFromHtmlUrl uses, returns an empty string so
// downstream consumers can detect a corrupted value.
function sanitizeHtmlUrlForEvidence(htmlUrl) {
  const s = String(htmlUrl || "").trim();
  if (!s) return "";
  let u;
  try {
    u = new URL(s);
  } catch {
    return "";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  if (u.username || u.password || u.port) return "";
  if ((u.hostname || "").toLowerCase() !== "github.com") return "";
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length < 2) return "";
  const owner = segs[0];
  const repo = segs[1];
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return "";
  return `${u.protocol}//${u.hostname}/${owner}/${repo}`;
}

// ---- canonical project identity (GPT-REV-027 parity) ---------------------
// Source: `remoteIsCanonical` lives in safe-git; this wrapper adds the
// fail-closed decision shape required by Issue #9 in-scope items 2-3.

// Strict GitHub html_url parser. Returns one of:
//   - null (unparseable / not GitHub / unsafe shape)
//   - { owner, repo, type: "repo" }            → only owner/repo requested
//   - { owner, repo, type: "issue", number }   → require: "issue"
//   - { owner, repo, type: "pull",  number }   → require: "pull"
//   - { owner, repo, type: "other" }            → owner/repo matched but
//                                                the trailing path is
//                                                neither issues/<n> nor
//                                                pull/<n>
//
// Strictness contract (single-sourced):
//   - Host MUST be github.com (case-insensitive, no user-info, no port).
//   - Scheme must be https: or http:. Anything else returns null.
//   - Query and fragment MUST be empty; `?token=...` would leak secrets
//     through evidence copies of the URL.
//   - Path MUST begin with /<owner>/<repo> where both segments match
//     [A-Za-z0-9._-]+. Encoded slashes / control bytes are rejected.
//   - `.git` suffix on the repo segment is REJECTED for ALL callers
//     (canonical GitHub html_url never carries `.git`). This is the
//     single documented behavior — the previous "strip-and-accept"
//     variant was removed by review 5059717485.
//
// Why not a regex: a substring match for `github.com/` is spoofable by
// hostile hosts such as `https://evil.example/github.com/o/r/issues/9`.
// new URL() is the only safe primitive here.
export function parseProjectFromHtmlUrl(htmlUrl, { require } = {}) {
  const s = String(htmlUrl || "").trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  if (u.port) return null;
  if ((u.hostname || "").toLowerCase() !== "github.com") return null;
  if (u.search || u.hash) return null;
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length < 2) return null;
  const owner = segs[0];
  const repoRaw = segs[1];
  if (!owner || !repoRaw) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(owner)) return null;
  if (repoRaw.toLowerCase().endsWith(".git")) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(repoRaw)) return null;
  const base = { owner, repo: repoRaw };
  if (segs.length === 2) {
    if (require === "issue" || require === "pull") return null;
    return { ...base, type: "repo" };
  }
  if (segs.length > 4) {
    if (require === "issue" || require === "pull") return null;
    return { ...base, type: "other" };
  }
  const kind = (segs[2] || "").toLowerCase();
  const numStr = segs[3];
  if (kind === "issues") {
    if (!numStr || !/^\d+$/.test(numStr)) {
      if (require === "issue") return null;
      return { ...base, type: "other" };
    }
    const number = Number(numStr);
    if (!Number.isInteger(number) || number <= 0) {
      if (require === "issue") return null;
      return { ...base, type: "other" };
    }
    if (require === "pull") return null;
    return { ...base, type: "issue", number };
  }
  if (kind === "pull") {
    if (!numStr || !/^\d+$/.test(numStr)) {
      if (require === "pull") return null;
      return { ...base, type: "other" };
    }
    const number = Number(numStr);
    if (!Number.isInteger(number) || number <= 0) {
      if (require === "pull") return null;
      return { ...base, type: "other" };
    }
    if (require === "issue") return null;
    return { ...base, type: "pull", number };
  }
  if (require === "issue" || require === "pull") return null;
  return { ...base, type: "other" };
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
  // html_url is a strict GitHub URL; do NOT fall back to remote-URL parsing
  // here — a remote URL looks like git@github.com:o/r.git and would be
  // parsed by parseRepoFromRemoteUrl, but accepting both would let a
  // caller hide a non-GitHub identity behind a remote URL. If html_url
  // is missing or malformed, this is a MISSING_PROJECT_IDENTITY.
  const fromHtml = parseProjectFromHtmlUrl(htmlUrl, { require: "issue" });
  const canonicalNorm = normalizeRemoteUrl(canonicalRepo);
  if (!fromHtml || fromHtml.type !== "issue") {
    return {
      ok: false,
      reason: "MISSING_PROJECT_IDENTITY",
      detail: "Issue has no parsable GitHub project identity (html_url).",
    };
  }
  const candidate = `${fromHtml.owner}/${fromHtml.repo}`.toLowerCase();
  if (candidate !== canonicalNorm) {
    return {
      ok: false,
      reason: "BLOCKED_PROJECT_MISMATCH",
      detail: `Issue project identity '${candidate}' does not match canonical '${canonicalNorm}'.`,
      issueProject: candidate,
      canonicalProject: canonicalNorm,
    };
  }
  // html_url number MUST equal issue.number. A payload with
  // issue.number=9 and html_url=.../issues/10 is the spoof vector
  // flagged by review 5059717485 — accept nothing silently. If
  // issue.number is absent / non-integer / non-positive we fall through
  // and let evaluateIntake produce BLOCKED_MISSING_ISSUE_NUMBER (single
  // source of that verdict).
  const issueNumber = Number(issue.number);
  if (Number.isInteger(issueNumber) && issueNumber > 0) {
    if (fromHtml.number !== issueNumber) {
      return {
        ok: false,
        reason: "BLOCKED_URL_NUMBER_MISMATCH",
        detail: `Issue html_url points to #${fromHtml.number} but issue.number=${issueNumber}; refusing to derive identity from a conflicting URL.`,
        issueProject: candidate,
        canonicalProject: canonicalNorm,
        urlNumber: fromHtml.number,
        issueNumber,
      };
    }
  }
  return {
    ok: true,
    issueProject: candidate,
    canonicalProject: canonicalNorm,
    urlNumber: fromHtml.number,
  };
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

export function buildStableTaskId({ repo, issueNumber }) {
  // Stable task ID is derived ONLY from normalized repo + positive issue
  // number. Title is intentionally excluded: it is mutable Issue metadata
  // and including it would let a rename of the same `repo#issue` produce a
  // new runtime namespace, which the Issue #9 AC explicitly forbids.
  // Use `buildTaskSlug` if you need a human-readable display form.
  const r = String(repo || "").toLowerCase();
  const n = Number(issueNumber);
  if (!r || !Number.isInteger(n) || n <= 0) return null;
  return `${r}#${n}`;
}

export function buildTaskSlug({ repo, issueNumber, title }) {
  // Human-readable display form. NOT used as a runtime/task identity.
  // Title is mutable; callers that need identity MUST use buildStableTaskId.
  const stable = buildStableTaskId({ repo, issueNumber });
  if (!stable) return null;
  const slug = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "task";
  return `${stable}-${slug}`;
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
  const stableTaskId = buildStableTaskId({ repo, issueNumber });
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
  const evidence = compactEvidence(issue);
  // taskSlug MUST derive from the already-redacted title, never from the
  // raw one — review 5059717485 proved a title containing `ghp_...` or
  // `password=...` leaked verbatim through the slug. buildTaskSlug is
  // agnostic; feeding it redacted text keeps every evidence string clean.
  const taskSlug = buildTaskSlug({ repo, issueNumber, title: evidence.title });
  evidence.taskSlug = taskSlug;
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
    evidence,
  };
}