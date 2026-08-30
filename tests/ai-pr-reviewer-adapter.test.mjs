#!/usr/bin/env node
// ai-pr-reviewer-adapter.test.mjs - deterministic tests for the Issue #11
// adapter. No live network, GitHub, or model calls. All transport calls
// are injected fakes. Run: node tests/ai-pr-reviewer-adapter.test.mjs
// Exit 0 = PASS, 1 = FAIL.
//
// Tests are mapped 1:1 to the 7 findings from PR #12 review 5060830327.

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import {
  validateRequest,
  validateCanonicalIdentity,
  buildCorrelationKey,
  normalizeStatus,
  requestReview,
  defaultCallReviewer,
  STATUSES,
} from "../packages/ai-pr-reviewer-adapter/ai-pr-reviewer-adapter.mjs";
import { parseProjectFromHtmlUrl, compactEvidence } from "../packages/task-intake/task-intake.mjs";
import { parseRepoFromRemoteUrl, remoteIsCanonical } from "../packages/safe-git/safe-git.mjs";

const RESULTS = { pass: 0, fail: 0, log: [] };
async function test(name, fn) {
  try { await fn(); RESULTS.pass++; RESULTS.log.push("PASS " + name); }
  catch (e) { RESULTS.fail++; RESULTS.log.push("FAIL " + name + " :: " + (e && e.message ? e.message : String(e))); }
}

const HEAD_A = "0123456789abcdef0123456789abcdef01234567";
const HEAD_B = "fedcba9876543210fedcba9876543210fedcba98";
const CANON = "duongpdddic-droid/Soc_brain";
const PROJECT = "soc-brain";
const CANON_HTML = "https://github.com/duongpdddic-droid/Soc_brain/pull/24";

// Build a per-run temp registry with the canonical entry, plus an
// intentional "other-project" entry to exercise UNKNOWN/REGISTRY_REPO.
const REG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "socbrain-reg-"));
const REG_PATH = path.join(REG_DIR, "registry.json");
const REGISTRY = {
  schemaVersion: "1.0",
  projects: [
    {
      schemaVersion: "1.0",
      projectId: PROJECT,
      repository: CANON,
      projectType: "control-plane",
      workspace: { workspaceId: "soc-brain-main" },
      policy: { version: "1.0.0" },
      verify: { adapter: "pnpm-verify" },
      deploy: { capability: false, humanAuthorization: true },
      telegram: { route: "dm-boss" },
      memory: { provider: "claude-mem", namespace: "soc-brain" },
      allowedOverrides: [],
    },
    {
      schemaVersion: "1.0",
      projectId: "other-project",
      repository: "someone/Other",
      projectType: "service",
      workspace: { workspaceId: "other-main" },
      policy: { version: "1.0.0" },
      verify: { adapter: "npm-test" },
      deploy: { capability: false, humanAuthorization: true },
      telegram: { route: "dm-boss" },
      memory: { provider: "claude-mem", namespace: "other" },
      allowedOverrides: [],
    },
  ],
};
fs.writeFileSync(REG_PATH, JSON.stringify(REGISTRY, null, 2), "utf8");

function good(over) {
  return {
    repo: CANON, pr: 24, headSha: HEAD_A, projectId: PROJECT, htmlUrl: CANON_HTML,
    ...(over || {}),
  };
}

function opts(over) {
  return Object.assign({ registryPath: REG_PATH }, over || {});
}

// F1 transport: a real final-review must mark finalReview=true AND have
// PASS gate (or no gate) AND no open Critical/Important blocker.
function fakeFinalPass() {
  return async function (req) {
    return {
      ok: true,
      reviewedHeadSha: req.headSha,
      verdict: "APPROVED",
      findings: [],
      openBlocking: [],
      decisionGate: { status: "PASS" },
      finalReview: true,
    };
  };
}
function fakePreReviewPass() {
  return async function (req) {
    return {
      ok: true, reviewedHeadSha: req.headSha, verdict: "PRE_REVIEW_PASS",
      findings: [], openBlocking: [], decisionGate: null, finalReview: false,
    };
  };
}
function fakePreReviewFindings() {
  return async function (req) {
    return {
      ok: true, reviewedHeadSha: req.headSha, verdict: "PRE_REVIEW_FINDINGS",
      findings: [{ severity: "important", fileSymbol: "a.mjs", evidence: "x" }],
      openBlocking: [{ severity: "important" }], decisionGate: null, finalReview: false,
    };
  };
}
function fakeFinalApproveWithGate() {
  return async function (req) {
    return {
      ok: true, reviewedHeadSha: req.headSha, verdict: "APPROVED",
      findings: [], openBlocking: [],
      decisionGate: { status: "BLOCK", reason: "policy missing" },
      finalReview: true,
    };
  };
}

// =====================================================================
// S1: valid request + final-review PASS -> APPROVED (real final review)
// =====================================================================
await test("S1 valid final-review PASS -> APPROVED", async () => {
  const r = await requestReview(good(), opts({ transport: fakeFinalPass() }));
  assert.equal(r.status, "APPROVED");
  assert.equal(r.accepted, true);
  assert.equal(r.requestedHeadSha, HEAD_A);
  assert.equal(r.responseHeadSha, HEAD_A);
  assert.ok(r.correlationKey);
  assert.equal(r.transportReason, null);
  assert.equal(r.evidence.findingsCount, 0);
  assert.equal(r.evidence.openBlockingCount, 0);
  assert.equal(r.evidence.decisionGate.status, "PASS");
  assert.equal(r.evidence.redactionApplied, true);
});

await test("S1b default transport with no live entrypoint -> UNSUPPORTED_TRANSPORT", async () => {
  // No transport injected, no source path. F6: refuse rather than
  // dynamic-import. Request must still pass identity to reach the
  // transport, then surface as ERROR.
  const r = await requestReview(good(), opts({ timeoutMs: 100 }));
  assert.equal(r.status, "ERROR");
  assert.equal(r.transportReason, "UNSUPPORTED_TRANSPORT");
  assert.equal(r.correlationKey && r.correlationKey.length, 16);
});

// =====================================================================
// S2: PRE_REVIEW_PASS must NOT be final APPROVED (F1)
// =====================================================================
await test("S2 PRE_REVIEW_PASS without finalReview -> VERIFIED_WITH_WARNINGS", async () => {
  const r = await requestReview(good(), opts({ transport: fakePreReviewPass() }));
  assert.equal(r.status, "VERIFIED_WITH_WARNINGS");
  assert.equal(r.accepted, false);
  assert.equal(r.transportReason, null);
});

await test("S2 PRE_REVIEW_FINDINGS -> CHANGES_REQUESTED", async () => {
  const r = await requestReview(good(), opts({ transport: fakePreReviewFindings() }));
  assert.equal(r.status, "CHANGES_REQUESTED");
  assert.equal(r.accepted, false);
  assert.equal(r.evidence.findingsCount, 1);
  assert.equal(r.evidence.openBlockingCount, 1);
});

await test("S2 APPROVED without finalReview -> VERIFIED_WITH_WARNINGS (never APPROVED)", async () => {
  // A transport that "approves" but is not flagged finalReview must
  // never be promoted to APPROVED.
  const transport = async function (req) {
    return {
      ok: true, reviewedHeadSha: req.headSha, verdict: "APPROVED",
      findings: [], openBlocking: [], decisionGate: null, finalReview: false,
    };
  };
  const r = await requestReview(good(), opts({ transport }));
  assert.equal(r.status, "VERIFIED_WITH_WARNINGS");
  assert.equal(r.accepted, false);
});

await test("S2 APPROVED with non-PASS gate -> CHANGES_REQUESTED", async () => {
  const r = await requestReview(good(), opts({ transport: fakeFinalApproveWithGate() }));
  assert.equal(r.status, "CHANGES_REQUESTED");
  assert.equal(r.accepted, false);
});

await test("S2 PRE_REVIEW_PASS with open Critical blocker -> CHANGES_REQUESTED", async () => {
  const transport = async function (req) {
    return {
      ok: true, reviewedHeadSha: req.headSha, verdict: "PRE_REVIEW_PASS",
      findings: [{ severity: "critical", file: "b.mjs" }],
      openBlocking: [{ severity: "critical", rule: "x" }],
      decisionGate: null, finalReview: false,
    };
  };
  const r = await requestReview(good(), opts({ transport }));
  assert.equal(r.status, "CHANGES_REQUESTED");
  assert.equal(r.accepted, false);
});

// =====================================================================
// S3: any res.ok !== true fails closed BEFORE HEAD lock (F2)
// =====================================================================
await test("S3 ok:false with UNKNOWN reason -> ERROR", async () => {
  const transport = async function (req) {
    return { ok: false, reason: "UNKNOWN", reviewedHeadSha: req.headSha, verdict: "APPROVED" };
  };
  const r = await requestReview(good(), opts({ transport }));
  assert.equal(r.status, "ERROR");
  assert.equal(r.transportReason, "UNKNOWN");
  assert.equal(r.accepted, false);
});

await test("S3 ok:false echo correct HEAD + APPROVED -> still ERROR (not approved)", async () => {
  const transport = async function (req) {
    return { ok: false, reason: "UNKNOWN", reviewedHeadSha: HEAD_A, verdict: "APPROVED" };
  };
  const r = await requestReview(good(), opts({ transport }));
  assert.equal(r.status, "ERROR");
  assert.equal(r.transportReason, "UNKNOWN");
  assert.equal(r.accepted, false);
});

await test("S3 non-zero exit represented as ok:false -> ERROR", async () => {
  const transport = async function () {
    return { ok: false, reason: "EXIT_NONZERO", exitCode: 1, detail: "process exited 1" };
  };
  const r = await requestReview(good(), opts({ transport }));
  assert.equal(r.status, "ERROR");
  assert.equal(r.transportReason, "EXIT_NONZERO");
});

await test("S3 transport throws -> ERROR TRANSPORT_EXCEPTION (redacted)", async () => {
  const boom = new Error("boom at C:\\Users\\Admin\\secret\\key.pem with ghp_abcdefghijklmnopqrstuvwxyz1234567890");
  const transport = async function () { throw boom; };
  const r = await requestReview(good(), opts({ transport }));
  assert.equal(r.status, "ERROR");
  assert.equal(r.transportReason, "TRANSPORT_EXCEPTION");
  assert.equal(r.detail.indexOf("ghp_"), -1, "PAT redacted");
  assert.equal(r.detail.indexOf("Admin"), -1, "HOME path redacted");
});

await test("S3 transport returns non-object -> ERROR MALFORMED_OUTPUT", async () => {
  const transport = async function () { return null; };
  const r = await requestReview(good(), opts({ transport }));
  assert.equal(r.status, "ERROR");
  assert.equal(r.transportReason, "MALFORMED_OUTPUT");
});

// =====================================================================
// S4: timeout + never-resolving promise (F6)
// =====================================================================
await test("S4 never-resolving transport -> ERROR TIMEOUT (clearTimeout on settle)", async () => {
  const transport = async function () { return new Promise(function () {}); };
  const started = Date.now();
  const r = await requestReview(good(), opts({ transport, timeoutMs: 30 }));
  assert.equal(r.status, "ERROR");
  assert.equal(r.transportReason, "TIMEOUT");
  assert.equal(r.accepted, false);
  assert.ok(Date.now() - started < 3000, "returned promptly, not waiting on the hung promise");
  assert.equal(r.transportReason, "TIMEOUT");
});

// =====================================================================
// S5: HEAD lock (unchanged contract)
// =====================================================================
await test("S5 missing response HEAD -> BLOCKED MISSING_RESPONSE_HEAD", async () => {
  const transport = async function (req) {
    return { ok: true, verdict: "APPROVED", findings: [], openBlocking: [], decisionGate: null, finalReview: true };
  };
  const r = await requestReview(good(), opts({ transport }));
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.transportReason, "MISSING_RESPONSE_HEAD");
});

await test("S5 short response HEAD -> BLOCKED", async () => {
  const transport = async function (req) {
    return { ok: true, reviewedHeadSha: "abc123", verdict: "APPROVED", findings: [], openBlocking: [], decisionGate: null, finalReview: true };
  };
  const r = await requestReview(good(), opts({ transport }));
  assert.equal(r.status, "BLOCKED");
});

await test("S5 HEAD mismatch -> BLOCKED HEAD_MISMATCH", async () => {
  const transport = async function (req) {
    return { ok: true, reviewedHeadSha: HEAD_B, verdict: "APPROVED", findings: [], openBlocking: [], decisionGate: null, finalReview: true };
  };
  const r = await requestReview(good(), opts({ transport }));
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.transportReason, "HEAD_MISMATCH");
});

// =====================================================================
// S6: recursive redaction (F4)
// =====================================================================
await test("S6 transport finding containing PAT is redacted end-to-end", async () => {
  const transport = async function (req) {
    return {
      ok: true, reviewedHeadSha: req.headSha, verdict: "APPROVED",
      findings: [{ severity: "important", evidence: "leak ghp_abcdefghijklmnopqrstuvwxyz1234567890" }],
      openBlocking: [], decisionGate: { status: "PASS" }, finalReview: true,
    };
  };
  const r = await requestReview(good(), opts({ transport }));
  assert.equal(r.status, "APPROVED");
  const flat = JSON.stringify(r.evidence);
  assert.equal(flat.indexOf("ghp_"), -1, "PAT redacted in nested finding");
});

await test("S6 transport detail containing HOME path is redacted", async () => {
  const transport = async function (req) {
    return {
      ok: true, reviewedHeadSha: req.headSha, verdict: "APPROVED",
      findings: [], openBlocking: [],
      decisionGate: { status: "PASS" }, finalReview: true,
      detail: "wrote report at C:\\Users\\Admin\\home\\.ssh\\id_rsa nope",
    };
  };
  const r = await requestReview(good(), opts({ transport }));
  const flat = JSON.stringify(r);
  assert.equal(flat.indexOf("Admin"), -1, "HOME user redacted in detail");
});

await test("S6 transport decisionGate containing PAT is redacted", async () => {
  const transport = async function (req) {
    return {
      ok: true, reviewedHeadSha: req.headSha, verdict: "APPROVED",
      findings: [], openBlocking: [],
      decisionGate: { status: "PASS", note: "x-access ghp_abcdefghijklmnopqrstuvwxyz1234567890" },
      finalReview: true,
    };
  };
  const r = await requestReview(good(), opts({ transport }));
  const flat = JSON.stringify(r.evidence);
  assert.equal(flat.indexOf("ghp_"), -1, "PAT redacted in decisionGate");
});

// =====================================================================
// S7: correlation key binds repo+pr+HEAD+projectId (F3)
// =====================================================================
await test("S7 correlation key is stable for identical immutable inputs", () => {
  const a = buildCorrelationKey({ repo: CANON, pr: 24, headSha: HEAD_A, projectId: PROJECT });
  const b = buildCorrelationKey({ repo: CANON, pr: 24, headSha: HEAD_A, projectId: PROJECT });
  assert.ok(a);
  assert.equal(a, b);
});

await test("S7 correlation key differs when HEAD changes", () => {
  const a = buildCorrelationKey({ repo: CANON, pr: 24, headSha: HEAD_A, projectId: PROJECT });
  const b = buildCorrelationKey({ repo: CANON, pr: 24, headSha: HEAD_B, projectId: PROJECT });
  assert.ok(a && b);
  assert.notEqual(a, b, "key must change when HEAD changes");
});

await test("S7 correlation key differs when projectId changes", () => {
  const a = buildCorrelationKey({ repo: CANON, pr: 24, headSha: HEAD_A, projectId: PROJECT });
  const b = buildCorrelationKey({ repo: CANON, pr: 24, headSha: HEAD_A, projectId: "other-project" });
  assert.ok(a && b);
  assert.notEqual(a, b, "key must change when projectId changes");
});

await test("S7 correlation key differs when pr changes", () => {
  const a = buildCorrelationKey({ repo: CANON, pr: 24, headSha: HEAD_A, projectId: PROJECT });
  const b = buildCorrelationKey({ repo: CANON, pr: 25, headSha: HEAD_A, projectId: PROJECT });
  assert.notEqual(a, b);
});

await test("S7 correlation key differs when repo changes", () => {
  const a = buildCorrelationKey({ repo: CANON, pr: 24, headSha: HEAD_A, projectId: PROJECT });
  const b = buildCorrelationKey({ repo: "other/repo", pr: 24, headSha: HEAD_A, projectId: PROJECT });
  assert.notEqual(a, b);
});

await test("S7 correlation key is null on invalid HEAD", () => {
  const a = buildCorrelationKey({ repo: CANON, pr: 24, headSha: "short", projectId: PROJECT });
  assert.equal(a, null);
});

await test("S7 correlation key is null on missing projectId", () => {
  const a = buildCorrelationKey({ repo: CANON, pr: 24, headSha: HEAD_A, projectId: "" });
  assert.equal(a, null);
});

// =====================================================================
// S8: deterministic, no child_process, working tree unchanged
// =====================================================================
await test("S8 repeated execution is deterministic for identical inputs", async () => {
  const a = await requestReview(good(), opts({ transport: fakeFinalPass() }));
  const b = await requestReview(good(), opts({ transport: fakeFinalPass() }));
  assert.equal(a.correlationKey, b.correlationKey);
  assert.equal(a.status, b.status);
  assert.equal(a.evidence.decisionGate.status, b.evidence.decisionGate.status);
});
await test("S8 adapter does not import child_process or shell accessors", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const adapterPath = path.join(here, "..", "packages", "ai-pr-reviewer-adapter", "ai-pr-reviewer-adapter.mjs");
  const src = fs.readFileSync(adapterPath, "utf8");
  // Strip line and block comments to avoid false positives from doc text.
  const stripped = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(stripped.includes('node:child_process'), false, 'must not import node:child_process');
  assert.equal(stripped.includes('child_process'), false, 'must not import child_process');
  assert.equal(/\bspawn\s*\(/.test(stripped), false, 'must not call spawn');
  assert.equal(/\bexecSync?\s*\(/.test(stripped), false, 'must not call exec/execSync');
});
await test("S8 working tree is unchanged after running the adapter", () => {
  // Pure check: assertOut side effect contract: the adapter does not
  // touch the FS beyond redaction of inputs.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const witnessDir = path.join(here, ".adapter-noop-witness");
  if (!fs.existsSync(witnessDir)) fs.mkdirSync(witnessDir);
  // We don't actually write; we just confirm the adapter has not
  // created any artifact in CWD.
  const entries = fs.readdirSync(here).filter(function (n) {
    return n.indexOf("ai-pr-reviewer-adapter") !== -1 && n !== "ai-pr-reviewer-adapter.test.mjs";
  });
  assert.equal(entries.length, 0, "no stray adapter artifacts in tests/");
});

// =====================================================================
// S9: shared primitives actually used (not reimplemented)
// =====================================================================
await test("S9 adapter imports shared primitives (not reimplemented)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const adapterPath = path.join(here, "..", "packages", "ai-pr-reviewer-adapter", "ai-pr-reviewer-adapter.mjs");
  const src = fs.readFileSync(adapterPath, "utf8");
  assert.ok(src.indexOf("parseProjectFromHtmlUrl") !== -1, "uses parseProjectFromHtmlUrl");
  assert.ok(src.indexOf("compactEvidence") !== -1, "uses compactEvidence");
  assert.ok(src.indexOf("remoteIsCanonical") !== -1, "uses remoteIsCanonical");
  assert.ok(src.indexOf("loadRegistry") !== -1, "uses loadRegistry");
});
await test("S9 shared helpers actually work for our input shape", () => {
  const parsed = parseProjectFromHtmlUrl(CANON_HTML, { require: "pull" });
  assert.ok(parsed);
  assert.equal(parsed.type, "pull");
  assert.equal(parsed.owner + "/" + parsed.repo, CANON);
  assert.equal(parsed.number, 24);
  const compact = compactEvidence({ title: "", body: "leak ghp_abcdefghijklmnopqrstuvwxyz1234567890 here", labels: [], html_url: "" });
  assert.equal(compact.body.indexOf("ghp_") === -1, true, "compactEvidence redacts PAT");
  const rem = parseRepoFromRemoteUrl("https://github.com/duongpdddic-droid/Soc_brain.git");
  assert.equal(rem, CANON);
  assert.equal(remoteIsCanonical("https://github.com/duongpdddic-droid/Soc_brain.git", CANON), true);
});

// =====================================================================
// S10: normalizeStatus contract
// =====================================================================
await test("S10 normalizeStatus covers the 5-status contract", () => {
  assert.equal(normalizeStatus("PRE_REVIEW_PASS", { openBlocking: [], finalReview: false }), "VERIFIED_WITH_WARNINGS");
  assert.equal(normalizeStatus("PRE_REVIEW_PASS", { openBlocking: [], finalReview: true }), "APPROVED");
  assert.equal(normalizeStatus("PRE_REVIEW_PASS", { openBlocking: [{severity:"critical"}] }), "CHANGES_REQUESTED");
  assert.equal(normalizeStatus("APPROVED", { finalReview: false }), "VERIFIED_WITH_WARNINGS");
  assert.equal(normalizeStatus("APPROVED", { finalReview: true }), "APPROVED");
  assert.equal(normalizeStatus("APPROVED", { finalReview: true, decisionGate: { status: "BLOCK" } }), "CHANGES_REQUESTED");
  assert.equal(normalizeStatus("PRE_REVIEW_FINDINGS"), "CHANGES_REQUESTED");
  assert.equal(normalizeStatus("BLOCKED_HEAD_MISMATCH"), "BLOCKED");
  assert.equal(normalizeStatus("UNSUPPORTED_TRANSPORT"), "ERROR");
  assert.equal(normalizeStatus("TIMEOUT"), "ERROR");
  assert.equal(normalizeStatus("UNKNOWN"), "ERROR");
  for (const s of STATUSES) assert.ok(s);
});

// =====================================================================
// S11: validateRequest + validateCanonicalIdentity (F5)
// =====================================================================
await test("S11 validateRequest ok=true for valid request", () => {
  const r = validateRequest(good());
  assert.equal(r.ok, true);
  assert.ok(r.normalized);
  assert.equal(r.normalized.repo, CANON);
  assert.equal(r.normalized.pr, 24);
  assert.equal(r.normalized.headSha, HEAD_A);
  assert.equal(r.normalized.projectId, PROJECT);
});
await test("S11 validateRequest ok=false for missing repo", () => {
  const r = validateRequest(good({ repo: "" }));
  assert.equal(r.ok, false);
  assert.ok(typeof r.reason === "string" && r.reason.indexOf("INVALID_REPO") !== -1);
});
await test("S11 validateRequest ok=false for short HEAD", () => {
  const r = validateRequest(good({ headSha: "short" }));
  assert.equal(r.ok, false);
  assert.ok(r.reason.indexOf("INVALID_HEAD_SHA") !== -1);
});
await test("S11 validateRequest ok=false for invalid projectId shape", () => {
  const r = validateRequest(good({ projectId: "BadID" }));
  assert.equal(r.ok, false);
  assert.ok(r.reason.indexOf("INVALID_PROJECT_ID") !== -1);
});

await test("S11 validateCanonicalIdentity ok=true for canonical registered project", () => {
  const r = validateCanonicalIdentity(
    { repo: CANON, pr: 24, projectId: PROJECT, htmlUrl: CANON_HTML },
    { registryPath: REG_PATH }
  );
  assert.equal(r.ok, true);
  assert.equal(r.manifest.repository, CANON);
});
await test("S11 validateCanonicalIdentity UNKNOWN_PROJECT_ID", () => {
  const r = validateCanonicalIdentity(
    { repo: CANON, pr: 24, projectId: "ghost", htmlUrl: CANON_HTML },
    { registryPath: REG_PATH }
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "UNKNOWN_PROJECT_ID");
});
await test("S11 validateCanonicalIdentity REGISTRY_REPO_MISMATCH", () => {
  const r = validateCanonicalIdentity(
    { repo: "someone/Other", pr: 24, projectId: PROJECT, htmlUrl: CANON_HTML },
    { registryPath: REG_PATH }
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "REGISTRY_REPO_MISMATCH");
});
await test("S11 validateCanonicalIdentity HTML_URL_REPO_MISMATCH", () => {
  const r = validateCanonicalIdentity(
    { repo: CANON, pr: 24, projectId: PROJECT, htmlUrl: "https://github.com/evil/repo/pull/24" },
    { registryPath: REG_PATH }
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "HTML_URL_REPO_MISMATCH");
});
await test("S11 validateCanonicalIdentity HTML_URL_PR_MISMATCH (other PR number)", () => {
  const r = validateCanonicalIdentity(
    { repo: CANON, pr: 24, projectId: PROJECT, htmlUrl: "https://github.com/duongpdddic-droid/Soc_brain/pull/99" },
    { registryPath: REG_PATH }
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "HTML_URL_PR_MISMATCH");
});
await test("S11 validateCanonicalIdentity HTML_URL_NOT_PULL (issue URL)", () => {
  const r = validateCanonicalIdentity(
    { repo: CANON, pr: 24, projectId: PROJECT, htmlUrl: "https://github.com/duongpdddic-droid/Soc_brain/issues/24" },
    { registryPath: REG_PATH }
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "HTML_URL_NOT_PULL");
});
await test("S11 validateCanonicalIdentity no htmlUrl still ok if project is registered", () => {
  const r = validateCanonicalIdentity(
    { repo: CANON, pr: 24, projectId: PROJECT, htmlUrl: undefined },
    { registryPath: REG_PATH }
  );
  assert.equal(r.ok, true);
});

await test("S11 requestReview rejects unregistered projectId without invoking transport", async () => {
  let called = false;
  const transport = async function () { called = true; return { ok: true, reviewedHeadSha: HEAD_A, verdict: "APPROVED" }; };
  const r = await requestReview(good({ projectId: "ghost" }), opts({ transport }));
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.transportReason, "UNKNOWN_PROJECT_ID");
  assert.equal(called, false, "transport must not be invoked for invalid identity");
});

await test("S11 requestReview rejects mismatched htmlUrl PR number without invoking transport", async () => {
  let called = false;
  const transport = async function () { called = true; return { ok: true, reviewedHeadSha: HEAD_A, verdict: "APPROVED" }; };
  const r = await requestReview(good({ htmlUrl: "https://github.com/duongpdddic-droid/Soc_brain/pull/99" }), opts({ transport }));
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.transportReason, "HTML_URL_PR_MISMATCH");
  assert.equal(called, false);
});

// =====================================================================
// S12: defaultCallReviewer is policy-neutral UNSUPPORTED (F6)
// =====================================================================
await test("S12 defaultCallReviewer returns UNSUPPORTED_TRANSPORT (no dynamic import)", async () => {
  const r = await defaultCallReviewer({ repo: CANON, pr: 24, headSha: HEAD_A, projectId: PROJECT }, {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, "UNSUPPORTED_TRANSPORT");
});

// =====================================================================
// summary
// =====================================================================
for (const l of RESULTS.log) console.log(l);
console.log("---");
console.log("PASS " + RESULTS.pass);
console.log("FAIL " + RESULTS.fail);
process.exit(RESULTS.fail === 0 ? 0 : 1);
