#!/usr/bin/env node
// ai-pr-reviewer-adapter.test.mjs - deterministic tests for the Issue #11
// adapter. No live network, GitHub, or model calls. All transport calls
// are injected fakes.
// Run: node tests/ai-pr-reviewer-adapter.test.mjs
// Exit 0 = PASS, 1 = FAIL.

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import {
  validateRequest,
  buildCorrelationKey,
  normalizeStatus,
  requestReview,
  defaultCallReviewer,
  STATUSES,
} from "../packages/ai-pr-reviewer-adapter/ai-pr-reviewer-adapter.mjs";
import { parseProjectFromHtmlUrl, compactEvidence, deriveTaskIdentityKey } from "../packages/task-intake/task-intake.mjs";
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

function good(over) {
  return {
    repo: CANON, pr: 24, headSha: HEAD_A, projectId: PROJECT, htmlUrl: CANON_HTML,
    ...(over || {}),
  };
}

function fakeTransportPass() {
  return async function (req) {
    return {
      ok: true, reviewedHeadSha: req.headSha, verdict: "PRE_REVIEW_PASS",
      findings: [], openBlocking: [], decisionGate: null,
    };
  };
}

function fakeTransportFindings() {
  return async function (req) {
    return {
      ok: true, reviewedHeadSha: req.headSha, verdict: "PRE_REVIEW_FINDINGS",
      findings: [{ severity: "important", fileSymbol: "a.mjs", evidence: "x" }],
      openBlocking: [{ severity: "important" }], decisionGate: null,
    };
  };
}

// ---- §1 valid request -> APPROVED -----------------------------------------
await test("S1 valid request + transport PASS -> APPROVED", async () => {
  const r = await requestReview(good(), { transport: fakeTransportPass() });
  assert.equal(r.status, "APPROVED");
  assert.equal(r.accepted, true);
  assert.equal(r.requestedHeadSha, HEAD_A);
  assert.equal(r.responseHeadSha, HEAD_A);
  assert.ok(r.correlationKey);
  assert.equal(r.evidence.findingsCount, 0);
  assert.equal(r.evidence.openBlockingCount, 0);
  assert.equal(r.evidence.redactionApplied, true);
});

// ---- §2 CHANGES_REQUESTED and VERIFIED_WITH_WARNINGS ----------------------
await test("S2 PRE_REVIEW_FINDINGS -> CHANGES_REQUESTED", async () => {
  const r = await requestReview(good(), { transport: fakeTransportFindings() });
  assert.equal(r.status, "CHANGES_REQUESTED");
  assert.equal(r.accepted, false);
  assert.equal(r.evidence.findingsCount, 1);
  assert.equal(r.evidence.openBlockingCount, 1);
});

await test("S2 PRE_REVIEW_PASS with open blocking -> VERIFIED_WITH_WARNINGS", async () => {
  const transport = async function (req) {
    return {
      ok: true, reviewedHeadSha: req.headSha, verdict: "PRE_REVIEW_PASS",
      findings: [{ severity: "suggestion" }],
      openBlocking: [{ severity: "suggestion" }], decisionGate: null,
    };
  };
  const r = await requestReview(good(), { transport });
  assert.equal(r.status, "VERIFIED_WITH_WARNINGS");
  assert.equal(r.accepted, true);
});

// ---- §3 malformed inputs --------------------------------------------------
await test("S3 missing repo -> BLOCKED INVALID_REPO", async () => {
  const r = await requestReview(good({ repo: "" }), { transport: fakeTransportPass() });
  assert.equal(r.status, "BLOCKED");
  assert.ok(r.transportReason && r.transportReason.indexOf("INVALID_REPO") !== -1);
});
await test("S3 mismatched htmlUrl vs repo -> BLOCKED HTML_URL_REPO_MISMATCH", async () => {
  // htmlUrl is for one repo while the request is for the canonical repo.
  const r = await requestReview(good({ htmlUrl: "https://github.com/evil/repo/pull/1" }), { transport: fakeTransportPass() });
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.transportReason, "HTML_URL_REPO_MISMATCH");
});
await test("S3 bad-shape repo -> BLOCKED INVALID_REPO", async () => {
  const r = await requestReview(good({ repo: "evil ", htmlUrl: "https://github.com/duongpdddic-droid/Soc_brain/pull/24" }), { transport: fakeTransportPass() });
  assert.equal(r.status, "BLOCKED");
  assert.ok(r.transportReason && r.transportReason.indexOf("INVALID_REPO") !== -1);
});
await test("S3 pr=0 -> BLOCKED INVALID_PR_NUMBER", async () => {
  const r = await requestReview(good({ pr: 0 }), { transport: fakeTransportPass() });
  assert.equal(r.status, "BLOCKED");
  assert.ok(r.transportReason && r.transportReason.indexOf("INVALID_PR_NUMBER") !== -1);
});
await test("S3 pr negative -> BLOCKED INVALID_PR_NUMBER", async () => {
  const r = await requestReview(good({ pr: -1 }), { transport: fakeTransportPass() });
  assert.equal(r.status, "BLOCKED");
  assert.ok(r.transportReason && r.transportReason.indexOf("INVALID_PR_NUMBER") !== -1);
});
await test("S3 short HEAD -> BLOCKED INVALID_HEAD_SHA", async () => {
  const r = await requestReview(good({ headSha: "abc" }), { transport: fakeTransportPass() });
  assert.equal(r.status, "BLOCKED");
  assert.ok(r.transportReason && r.transportReason.indexOf("INVALID_HEAD_SHA") !== -1);
});
await test("S3 missing projectId -> BLOCKED INVALID_PROJECT_ID", async () => {
  const r = await requestReview(good({ projectId: "" }), { transport: fakeTransportPass() });
  assert.equal(r.status, "BLOCKED");
  assert.ok(r.transportReason && r.transportReason.indexOf("INVALID_PROJECT_ID") !== -1);
});
await test("S3 null request -> BLOCKED REQUEST_MISSING", async () => {
  const r = await requestReview(null, { transport: fakeTransportPass() });
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.transportReason, "REQUEST_MISSING");
});
await test("S3 invalid request never invokes transport", async () => {
  let called = 0;
  const transport = async function () { called++; return { ok: true, reviewedHeadSha: HEAD_A, verdict: "PRE_REVIEW_PASS", findings: [], openBlocking: [], decisionGate: null }; };
  await requestReview(good({ headSha: "short" }), { transport });
  assert.equal(called, 0, "transport must not be called for invalid request");
});

// ---- §4 missing / mismatched response HEAD --------------------------------
await test("S4 transport without reviewedHeadSha -> BLOCKED MISSING_RESPONSE_HEAD", async () => {
  const transport = async function () { return { ok: true, verdict: "PRE_REVIEW_PASS", findings: [], openBlocking: [] }; };
  const r = await requestReview(good(), { transport });
  assert.equal(r.status, "BLOCKED");
  assert.ok(r.transportReason && r.transportReason.indexOf("MISSING_RESPONSE_HEAD") !== -1);
});
await test("S4 transport with short reviewedHeadSha -> BLOCKED", async () => {
  const transport = async function () { return { ok: true, reviewedHeadSha: "abc", verdict: "PRE_REVIEW_PASS", findings: [], openBlocking: [] }; };
  const r = await requestReview(good(), { transport });
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.responseHeadSha, null);
});
await test("S4 transport with different full HEAD -> BLOCKED HEAD_MISMATCH", async () => {
  const transport = async function () {
    return { ok: true, reviewedHeadSha: HEAD_B, verdict: "PRE_REVIEW_PASS", findings: [], openBlocking: [] };
  };
  const r = await requestReview(good(), { transport });
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.transportReason, "HEAD_MISMATCH");
  assert.equal(r.requestedHeadSha, HEAD_A);
  assert.equal(r.responseHeadSha, HEAD_B);
});
await test("S4 BLOCKED verdict is never converted to APPROVED", async () => {
  const transport = async function (req) {
    return { ok: true, reviewedHeadSha: req.headSha, verdict: "BLOCKED_HEAD_MISMATCH", findings: [], openBlocking: [] };
  };
  const r = await requestReview(good(), { transport });
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.accepted, false);
});

// ---- §5 malformed output, timeout, transport exception --------------------
await test("S5 transport returns null -> ERROR MALFORMED_OUTPUT", async () => {
  const transport = async function () { return null; };
  const r = await requestReview(good(), { transport });
  assert.equal(r.status, "ERROR");
  assert.equal(r.transportReason, "MALFORMED_OUTPUT");
});
await test("S5 transport throws -> ERROR TRANSPORT_EXCEPTION", async () => {
  const transport = async function () { throw new Error("boom"); };
  const r = await requestReview(good(), { transport });
  assert.equal(r.status, "ERROR");
  assert.equal(r.transportReason, "TRANSPORT_EXCEPTION");
});
await test("S5 transport reports UNSUPPORTED_TRANSPORT -> ERROR", async () => {
  const transport = async function () { return { ok: false, reason: "UNSUPPORTED_TRANSPORT", detail: "no entry" }; };
  const r = await requestReview(good(), { transport });
  assert.equal(r.status, "ERROR");
  assert.equal(r.transportReason, "UNSUPPORTED_TRANSPORT");
});
await test("S5 transport times out -> ERROR TIMEOUT", async () => {
  const transport = function () { return new Promise(function (resolve) { setTimeout(resolve, 5000, { ok: true, reviewedHeadSha: HEAD_A, verdict: 'PRE_REVIEW_PASS', findings: [], openBlocking: [] }); }); };
  const r = await requestReview(good(), { transport, timeoutMs: 25 });
  assert.equal(r.status, "ERROR");
  assert.equal(r.transportReason, "TIMEOUT");
});

// ---- §6 secret + HOME redaction ------------------------------------------
await test("S6 transport findings containing secrets are redacted in evidence", async () => {
  const transport = async function (req) {
    return {
      ok: true, reviewedHeadSha: req.headSha, verdict: "PRE_REVIEW_FINDINGS",
      findings: [
        { severity: "important", fileSymbol: "a.mjs", evidence: "leaked ghp_abcdefghijklmnopqrstuvwxyz1234567890 in diff" },
      ],
      openBlocking: [{ severity: "important" }],
    };
  };
  const r = await requestReview(good(), { transport });
  assert.equal(r.status, "CHANGES_REQUESTED");
  const serialized = JSON.stringify(r.evidence);
  assert.equal(serialized.indexOf("ghp_abcdefghijklmnopqrstuvwxyz1234567890") === -1, true, "PAT must be redacted");
  assert.equal(serialized.indexOf("<secret:") !== -1, true, "redaction marker present");
});
await test("S6 transport detail containing HOME path is redacted", async () => {
  const transport = async function () {
    return { ok: false, reason: "ERROR", detail: "failed at C:\\Users\\Admin\\private\\config" };
  };
  const r = await requestReview(good(), { transport });
  assert.equal(r.status, "ERROR");
  assert.equal(typeof r.detail === "string", true);
  assert.equal(r.detail.indexOf("C:\\Users\\Admin") === -1, true, "HOME path must be redacted");
});

// ---- §7 stable correlation key -------------------------------------------
await test("S7 correlation key is stable for identical immutable inputs", () => {
  const a = buildCorrelationKey({ repo: CANON, pr: 24, headSha: HEAD_A, projectId: PROJECT });
  const b = buildCorrelationKey({ repo: CANON, pr: 24, headSha: HEAD_A, projectId: PROJECT });
  assert.ok(a); assert.equal(a, b);
});
await test("S7 correlation key differs when repo changes", () => {
  const a = buildCorrelationKey({ repo: CANON, pr: 24, headSha: HEAD_A, projectId: PROJECT });
  const b = buildCorrelationKey({ repo: "other/proj", pr: 24, headSha: HEAD_A, projectId: PROJECT });
  assert.notEqual(a, b);
});
await test("S7 correlation key differs when PR number changes", () => {
  const a = buildCorrelationKey({ repo: CANON, pr: 24, headSha: HEAD_A, projectId: PROJECT });
  const b = buildCorrelationKey({ repo: CANON, pr: 25, headSha: HEAD_A, projectId: PROJECT });
  assert.notEqual(a, b);
});
// deriveTaskIdentityKey is intentionally stable across HEAD changes; only
// (repo, pr) determine the identity. HEAD is verified via HEAD_MISMATCH (S4).
await test("S7 correlation key is identical across HEAD changes (identity = repo+pr)", () => {
  const a = buildCorrelationKey({ repo: CANON, pr: 24, headSha: HEAD_A, projectId: PROJECT });
  const b = buildCorrelationKey({ repo: CANON, pr: 24, headSha: HEAD_B, projectId: PROJECT });
  assert.ok(a);
  assert.equal(a, b);
});
await test("S7 correlation key is null on invalid inputs", () => {
  assert.equal(buildCorrelationKey({ repo: "", pr: 24, headSha: HEAD_A, projectId: PROJECT }), null);
  assert.equal(buildCorrelationKey({ repo: CANON, pr: 0, headSha: HEAD_A, projectId: PROJECT }), null);
  assert.equal(buildCorrelationKey({ repo: CANON, pr: 24, headSha: "short", projectId: PROJECT }), null);
  assert.equal(buildCorrelationKey({ repo: CANON, pr: 24, headSha: HEAD_A, projectId: "" }), null);
});

// ---- §8 deterministic, no Git/GitHub mutation -----------------------------
await test("S8 repeated execution is deterministic for identical inputs", async () => {
  const t = fakeTransportPass();
  const r1 = await requestReview(good(), { transport: t });
  const r2 = await requestReview(good(), { transport: t });
  assert.equal(r1.status, r2.status);
  assert.equal(r1.correlationKey, r2.correlationKey);
  assert.equal(r1.evidence.findingsCount, r2.evidence.findingsCount);
});
await test("S8 adapter does not import child_process or shell accessors", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "..", "packages", "ai-pr-reviewer-adapter", "ai-pr-reviewer-adapter.mjs"), "utf8");
  assert.equal(src.indexOf("child_process") === -1, true, "no child_process import");
  assert.equal(src.indexOf("spawn") === -1, true, "no spawn call");
  assert.equal(src.indexOf("exec(") === -1, true, "no exec call");
  assert.equal(src.indexOf("execFile") === -1, true, "no execFile call");
  assert.equal(src.indexOf("'gh'") === -1 && src.indexOf('"gh"') === -1, true, "no gh CLI invocation");
});
await test("S8 working tree is unchanged after running the adapter", async () => {
  await requestReview(good(), { transport: fakeTransportPass() });
  await requestReview(good(), { transport: fakeTransportFindings() });
  const cwd = path.dirname(fileURLToPath(import.meta.url));
  const entries = fs.readdirSync(cwd);
  for (const e of entries) {
    assert.equal(e.startsWith("ai-pr-reviewer-adapter.test.") && e !== "ai-pr-reviewer-adapter.test.mjs", false, "no stray test artifact: " + e);
  }
});

// ---- §9 reuse checks ------------------------------------------------------
await test("S9 adapter imports shared primitives (not reimplemented)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "..", "packages", "ai-pr-reviewer-adapter", "ai-pr-reviewer-adapter.mjs"), "utf8");
  assert.ok(src.indexOf("../task-intake/task-intake.mjs") !== -1, "imports task-intake");
  assert.ok(src.indexOf("../safe-git/safe-git.mjs") !== -1, "imports safe-git");
  assert.ok(src.indexOf("parseProjectFromHtmlUrl") !== -1, "uses parseProjectFromHtmlUrl");
  assert.ok(src.indexOf("deriveTaskIdentityKey") !== -1, "uses deriveTaskIdentityKey");
  assert.ok(src.indexOf("compactEvidence") !== -1, "uses compactEvidence");
  assert.ok(src.indexOf("parseRepoFromRemoteUrl") !== -1, "uses parseRepoFromRemoteUrl");
  assert.ok(src.indexOf("remoteIsCanonical") !== -1, "uses remoteIsCanonical");
});
await test("S9 htmlUrl from a different repo is rejected without reimplementation", async () => {
  const r = await requestReview(
    { ...good(), htmlUrl: "https://github.com/evil/repo/pull/1" },
    { transport: fakeTransportPass() }
  );
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.transportReason, "HTML_URL_REPO_MISMATCH");
});
await test("S9 shared helpers actually work for our input shape", () => {
  const parsed = parseProjectFromHtmlUrl(CANON_HTML);
  assert.ok(parsed);
  assert.equal(parsed.owner + "/" + parsed.repo, CANON);
  const key = deriveTaskIdentityKey({ repo: CANON, issueNumber: 24, now: HEAD_A });
  assert.ok(key);
  const compact = compactEvidence({ title: "", body: "leak ghp_abcdefghijklmnopqrstuvwxyz1234567890 here", labels: [], html_url: "" });
  assert.equal(compact.body.indexOf("ghp_") === -1, true, "compactEvidence redacts PAT");
  const rem = parseRepoFromRemoteUrl("https://github.com/duongpdddic-droid/Soc_brain.git");
  assert.equal(rem, CANON);
  assert.equal(remoteIsCanonical("https://github.com/duongpdddic-droid/Soc_brain.git", CANON), true);
});

// ---- §10 normalization mapping for the 5-status contract ------------------
await test("S10 normalizeStatus covers the 5-status contract", () => {
  assert.equal(normalizeStatus("PRE_REVIEW_PASS", { openBlockingCount: 0 }), "APPROVED");
  assert.equal(normalizeStatus("PRE_REVIEW_PASS", { openBlockingCount: 1 }), "VERIFIED_WITH_WARNINGS");
  assert.equal(normalizeStatus("PRE_REVIEW_FINDINGS"), "CHANGES_REQUESTED");
  assert.equal(normalizeStatus("BLOCKED_HEAD_MISMATCH"), "BLOCKED");
  assert.equal(normalizeStatus("UNSUPPORTED_TRANSPORT"), "ERROR");
  assert.equal(normalizeStatus("TIMEOUT"), "ERROR");
  assert.equal(normalizeStatus("UNKNOWN"), "ERROR");
  for (const s of STATUSES) assert.ok(s);
});

// ---- defaultCallReviewer live-unsupported evidence ------------------------
await test("SD1 defaultCallReviewer with no sourcePath -> UNSUPPORTED_TRANSPORT", async () => {
  const r = await defaultCallReviewer({ repo: CANON, pr: 24, headSha: HEAD_A, projectId: PROJECT }, {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, "UNSUPPORTED_TRANSPORT");
});
await test("SD2 defaultCallReviewer with non-existent sourcePath -> UNSUPPORTED_TRANSPORT", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const r = await defaultCallReviewer(
    { repo: CANON, pr: 24, headSha: HEAD_A, projectId: PROJECT },
    { sourcePath: path.join(here, "..", "packages", "ai-pr-reviewer-adapter", "NON_EXISTENT.mjs") }
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "UNSUPPORTED_TRANSPORT");
});

// ---- validateRequest direct coverage --------------------------------------
await test("SV validateRequest ok=true for valid request", () => {
  const r = validateRequest(good());
  assert.equal(r.ok, true);
  assert.ok(r.normalized);
  assert.equal(r.normalized.repo, CANON);
  assert.equal(r.normalized.pr, 24);
});
await test("SV validateRequest ok=false for missing repo", () => {
  const r = validateRequest(good({ repo: "" }));
  assert.equal(r.ok, false);
  assert.ok(typeof r.reason === "string" && r.reason.indexOf("INVALID_REPO") !== -1);
});

// ---- summary -------------------------------------------------------------
for (const l of RESULTS.log) console.log(l);
console.log("---");
console.log("PASS " + RESULTS.pass);
console.log("FAIL " + RESULTS.fail);
process.exit(RESULTS.fail === 0 ? 0 : 1);
