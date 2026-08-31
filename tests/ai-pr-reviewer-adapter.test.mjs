#!/usr/bin/env node
// ai-pr-reviewer-adapter.test.mjs - deterministic tests for the Issue #11
// adapter. No live network, GitHub, or model calls. All transport calls
// are injected fakes. Run: node tests/ai-pr-reviewer-adapter.test.mjs
// Exit 0 = PASS, 1 = FAIL.
// Tests are mapped 1:1 to the 7 findings from PR #12 review 5060830327
// plus the 3 follow-up gaps in review 5062311773 plus the 3 deeper
// gaps in review 5062377060 plus the 3 gaps in review 5062489059.

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";
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

// SNAP_BEFORE / SNAP_AFTER_CAPTURED are declared early so the S8
// baseline test (positioned right before S1) can assign to them
// before any adapter call. The actual baseline snapshot is taken
// immediately before that test runs.
let SNAP_BEFORE = null;
let SNAP_AFTER_CAPTURED = null;

// Build a per-run temp registry. Only paths CREATED by THIS run are
// tracked and removed at exit (review 5062377060 #3: no broad prefix
// sweep, no deletion of pre-existing worktree content). No removal of
// stale leftovers from prior runs.
const TEMP_PATHS = [];
function mkTmpDir(prefix) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_PATHS.push(p);
  return p;
}
function rmAllTemp() {
  for (const p of TEMP_PATHS) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
  TEMP_PATHS.length = 0;
}

const REG_DIR = mkTmpDir("socbrain-reg-");
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

// F1: a real final-review must mark finalReview=true AND have a gate
// whose status is exactly "PASS" (or no gate) AND no open blocker.
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
// S8 (early): worktree baseline snapshot captured BEFORE the first
// adapter call. review 5062377060 #3: the baseline must be taken
// before any adapter invocation, and the post-suite comparison must
// be byte-for-byte against this baseline. A clean worktree yields an
// empty porcelain string; the real assertion is the post-suite
// byte-for-byte equality with this baseline, not its length.
//
// review 5062489059 #2: the snapshot is taken via a READ-ONLY
// `git status --porcelain` call. No probe file is ever created inside
// the worktree; the helper's parsing/ordering logic is extracted into
// the pure `normalizePorcelain` function and tested with synthetic
// porcelain strings below.
// =====================================================================
SNAP_BEFORE = snapshotRepo();
await test("S8 worktree baseline captured before any adapter call", () => {
  // The baseline is captured at module top-level, immediately before
  // this test runs. It asserts the baseline is a string (possibly
  // empty when the worktree is clean). The post-suite S8 test then
  // re-snapshots and asserts byte-for-byte equality with this value.
  assert.equal(typeof SNAP_BEFORE, "string");
});

await test("S8 snapshot comparator is pure and read-only (synthetic porcelain)", () => {
  // review 5062489059 #2: do not mutate the worktree to test the
  // snapshot helper. The read-only `git status` output feeds a pure
  // parser; exercise that parser with synthetic porcelain strings
  // instead of touching any real file.
  assert.equal(normalizePorcelain(""), "", "clean worktree -> empty snapshot");
  assert.equal(normalizePorcelain("M  a\0?? b\0"), "?? b\0M  a", "trailing NUL dropped, entries sorted");
  assert.equal(normalizePorcelain("?? b\0M  a\0"), "?? b\0M  a", "ordering normalized to a canonical string");
  assert.notEqual(normalizePorcelain("?? c\0"), normalizePorcelain(""), "an added entry changes the snapshot");
  assert.notEqual(normalizePorcelain("M  a\0?? b"), normalizePorcelain("?? b\0"), "different states are distinguishable");
});

// =====================================================================
// S1: valid request + final-review PASS -> APPROVED
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

await test("S2 PRE_REVIEW_PASS with finalReview=true is STILL non-final -> VERIFIED_WITH_WARNINGS", async () => {
  const transport = async function (req) {
    return {
      ok: true, reviewedHeadSha: req.headSha, verdict: "PRE_REVIEW_PASS",
      findings: [], openBlocking: [], decisionGate: { status: "PASS" }, finalReview: true,
    };
  };
  const r = await requestReview(good(), opts({ transport }));
  assert.equal(r.status, "VERIFIED_WITH_WARNINGS", "PRE_REVIEW_PASS is never APPROVED");
  assert.equal(r.accepted, false);
});

await test("S2 PRE_REVIEW_FINDINGS -> CHANGES_REQUESTED", async () => {
  const r = await requestReview(good(), opts({ transport: fakePreReviewFindings() }));
  assert.equal(r.status, "CHANGES_REQUESTED");
  assert.equal(r.accepted, false);
  assert.equal(r.evidence.findingsCount, 1);
  assert.equal(r.evidence.openBlockingCount, 1);
});

await test("S2 APPROVED without finalReview -> VERIFIED_WITH_WARNINGS (never APPROVED)", async () => {
  const transport = async function (req) {
    return {
      ok: true, reviewedHeadSha: req.headSha, verdict: "APPROVED",
      findings: [], openBlocking: [], decisionGate: { status: "PASS" }, finalReview: false,
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

await test("S3 ok:false with reason containing PAT/HOME -> transportReason is redacted", async () => {
  // Review 5062311773 #2: even the reason field on a failed transport
  // response must be run through the recursive redactor.
  const transport = async function (req) {
    return {
      ok: false,
      reason: "leak C:\\Users\\Admin\\home\\.ssh\\id_rsa with ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      reviewedHeadSha: req.headSha,
      verdict: "APPROVED",
    };
  };
  const r = await requestReview(good(), opts({ transport }));
  assert.equal(r.status, "ERROR");
  assert.equal(typeof r.transportReason, "string", "transportReason is a string");
  assert.equal(r.transportReason.indexOf("ghp_"), -1, "PAT redacted in transportReason");
  assert.equal(r.transportReason.indexOf("Admin"), -1, "HOME user redacted in transportReason");
  const flat = JSON.stringify(r);
  assert.equal(flat.indexOf("ghp_"), -1, "no PAT leak anywhere in the response");
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
});

// =====================================================================
// S5: HEAD lock
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
await test("S6 transport finding containing PAT is redacted end-to-end (and blocks APPROVED)", async () => {
  // Review 5062377060 #1: a finding with severity "important" must
  // block APPROVED even when `openBlocking: []` and finalReview=true.
  // The PAT in the finding is still redacted.
  const transport = async function (req) {
    return {
      ok: true, reviewedHeadSha: req.headSha, verdict: "APPROVED",
      findings: [{ severity: "important", evidence: "leak ghp_abcdefghijklmnopqrstuvwxyz1234567890" }],
      openBlocking: [], decisionGate: { status: "PASS" }, finalReview: true,
    };
  };
  const r = await requestReview(good(), opts({ transport }));
  assert.equal(r.status, "CHANGES_REQUESTED", "an open Important finding blocks APPROVED");
  assert.equal(r.accepted, false);
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

await test("S6 requestReview: decisionGate=\"BLOCK\" (non-object) blocks", async () => {
  // Review 5062377060 #2: a non-object decisionGate must block, not be
  // silently coerced to null.
  const transport = async function (req) {
    return {
      ok: true, reviewedHeadSha: req.headSha, verdict: "APPROVED",
      findings: [], openBlocking: [],
      decisionGate: "BLOCK", finalReview: true,
    };
  };
  const r = await requestReview(good(), opts({ transport }));
  assert.equal(r.status, "CHANGES_REQUESTED");
  assert.equal(r.accepted, false);
});

await test("S6 requestReview: openBlocking=\"foo\" (non-array) blocks", async () => {
  // Review 5062377060 #2: a non-array openBlocking must block, not be
  // silently coerced to [].
  const transport = async function (req) {
    return {
      ok: true, reviewedHeadSha: req.headSha, verdict: "APPROVED",
      findings: [], openBlocking: "foo",
      decisionGate: { status: "PASS" }, finalReview: true,
    };
  };
  const r = await requestReview(good(), opts({ transport }));
  assert.equal(r.status, "CHANGES_REQUESTED");
  assert.equal(r.accepted, false);
});

await test("S6 requestReview: open blocker finding with openBlocking:[] still blocks", async () => {
  // Review 5062377060 #1: cross-check between findings and openBlocking.
  const transport = async function (req) {
    return {
      ok: true, reviewedHeadSha: req.headSha, verdict: "APPROVED",
      findings: [{ severity: "important" }], openBlocking: [],
      decisionGate: { status: "PASS" }, finalReview: true,
    };
  };
  const r = await requestReview(good(), opts({ transport }));
  assert.equal(r.status, "CHANGES_REQUESTED", "an open Important finding blocks APPROVED");
  assert.equal(r.accepted, false);
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

await test("S6 requestReview: final APPROVED with missing/null evidence fails closed (review 5062489059 #1)", async () => {
  // For an explicit final APPROVED, `findings` AND `openBlocking` must be
  // explicit arrays. Missing/null containers must NOT approve.
  const variants = [
    // both missing
    { verdict: "APPROVED", finalReview: true, decisionGate: { status: "PASS" } },
    // findings missing
    { verdict: "APPROVED", finalReview: true, decisionGate: { status: "PASS" }, findings: undefined, openBlocking: [] },
    // findings null
    { verdict: "APPROVED", finalReview: true, decisionGate: { status: "PASS" }, findings: null, openBlocking: [] },
    // openBlocking missing
    { verdict: "APPROVED", finalReview: true, decisionGate: { status: "PASS" }, findings: [], openBlocking: undefined },
    // openBlocking null
    { verdict: "APPROVED", finalReview: true, decisionGate: { status: "PASS" }, findings: [], openBlocking: null },
  ];
  for (const res of variants) {
    const transport = async function (req) {
      return { ok: true, reviewedHeadSha: req.headSha, ...res };
    };
    const r = await requestReview(good(), opts({ transport }));
    assert.equal(
      r.status, "CHANGES_REQUESTED",
      "missing/null container (" + JSON.stringify(res).slice(0, 80) + ") fails closed"
    );
    assert.equal(r.accepted, false);
  }
});

await test("S6 requestReview: final APPROVED with malformed findings entry fails closed (review 5062489059 #1)", async () => {
  const malformed = [[null], ["x"], [{}], [{ severity: "bogus" }], [{ severity: "info", status: "bogus" }]];
  for (const findings of malformed) {
    const transport = async function (req) {
      return {
        ok: true, reviewedHeadSha: req.headSha, verdict: "APPROVED",
        findings, openBlocking: [], decisionGate: { status: "PASS" }, finalReview: true,
      };
    };
    const r = await requestReview(good(), opts({ transport }));
    assert.equal(
      r.status, "CHANGES_REQUESTED",
      "malformed finding entry (" + JSON.stringify(findings) + ") fails closed"
    );
    assert.equal(r.accepted, false);
  }
});

await test("S6 requestReview: legitimate non-blocking finding still approves", async () => {
  const transport = async function (req) {
    return {
      ok: true, reviewedHeadSha: req.headSha, verdict: "APPROVED",
      findings: [{ severity: "info", status: "fixed" }],
      openBlocking: [], decisionGate: { status: "PASS" }, finalReview: true,
    };
  };
  const r = await requestReview(good(), opts({ transport }));
  assert.equal(r.status, "APPROVED");
  assert.equal(r.accepted, true);
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
// S8: deterministic, no child_process, worktree unchanged (pre/post snap)
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

// =====================================================================
// Worktree snapshot. The test takes a full porcelain snapshot of the
// worktree BEFORE the first adapter call and again AFTER the suite
// ends (review 5062377060 #3: byte-for-byte comparison, not just added
// untracked paths). The temp directory used for the per-run registry
// is OS tempdir, NOT in the worktree, so removing it does not affect
// the snapshot. The baseline is captured synchronously at module
// top-level (before any `await test(...)` call) so it cannot be
// polluted by anything the suite does.
//
// review 5062489059 #2: snapshotting is strictly READ-ONLY. The pure
// parsing/ordering logic lives in `normalizePorcelain`, exercised with
// synthetic porcelain strings in the S8 comparator test; the real
// worktree is never mutated.
// =====================================================================
function normalizePorcelain(porcelain) {
  // Normalize by sorting the NUL-separated entries so reordering of
  // git's output does not produce a false diff. We keep the full
  // "XY path" string for each entry (including renames which carry a
  // -> arrow inside the path field). Path-only is not enough for a
  // byte-for-byte worktree proof.
  const entries = porcelain.split("\0").filter(Boolean).sort();
  return entries.join("\0");
}

function snapshotRepo() {
  // Return the full porcelain output as a string (byte-for-byte
  // comparable). -uall shows individual untracked files; --ignored=no
  // keeps ignored entries out so we don't depend on .gitignore order.
  // -z separates entries with NUL so paths containing newlines are
  // still distinguishable. Read-only: never writes to the worktree.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const porcelain = execSync(
    "git -C " + JSON.stringify(root) + " status --porcelain -uall --ignored=no -z",
    { encoding: "utf8" }
  );
  return normalizePorcelain(porcelain);
}

// SNAP_BEFORE is captured at module top-level, BEFORE any adapter test
// runs. The first adapter call comes from the S1 test below; by the
// time S1 executes, the baseline is already frozen. SNAP_AFTER_CAPTURED
// and captureSnapAfter are declared near the top of the file.
function captureSnapAfter() {
  SNAP_AFTER_CAPTURED = snapshotRepo();
}
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
// S10: normalizeStatus contract (F1, post-review 5062311773)
// =====================================================================
await test("S10 normalizeStatus covers the 5-status contract", () => {
  // PRE_REVIEW_PASS is intrinsically non-final. finalReview=true does
  // not promote it to APPROVED — only an explicit `APPROVED` input can.
  assert.equal(normalizeStatus("PRE_REVIEW_PASS", { openBlocking: [], finalReview: false }), "VERIFIED_WITH_WARNINGS");
  assert.equal(normalizeStatus("PRE_REVIEW_PASS", { openBlocking: [], finalReview: true }), "VERIFIED_WITH_WARNINGS", "PRE_REVIEW_PASS is never final");
  assert.equal(normalizeStatus("PRE_REVIEW_PASS", { openBlocking: [{severity:"critical"}] }), "CHANGES_REQUESTED");
  // APPROVED requires finalReview=true, gate exactly {status:"PASS"} (or
  // no gate), no blocker, AND explicit `findings`/`openBlocking` arrays
  // (review 5062489059 #1).
  assert.equal(normalizeStatus("APPROVED", { finalReview: false }), "VERIFIED_WITH_WARNINGS");
  assert.equal(normalizeStatus("APPROVED", { finalReview: true, findings: [], openBlocking: [] }), "APPROVED", "no gate is acceptable");
  assert.equal(normalizeStatus("APPROVED", { finalReview: true, decisionGate: { status: "PASS" }, findings: [], openBlocking: [] }), "APPROVED");
  assert.equal(normalizeStatus("APPROVED", { finalReview: true, decisionGate: { status: "ALLOW" }, findings: [], openBlocking: [] }), "CHANGES_REQUESTED", "ALLOW is not PASS");
  assert.equal(normalizeStatus("APPROVED", { finalReview: true, decisionGate: { status: "BLOCK" }, findings: [], openBlocking: [] }), "CHANGES_REQUESTED");
  assert.equal(normalizeStatus("APPROVED", { finalReview: true, decisionGate: { }, findings: [], openBlocking: [] }), "CHANGES_REQUESTED", "missing status blocks");
  assert.equal(normalizeStatus("APPROVED", { finalReview: true, decisionGate: null, findings: [], openBlocking: [] }), "APPROVED", "no gate is acceptable");
  // Malformed openBlocking blocks.
  assert.equal(normalizeStatus("APPROVED", { finalReview: true, decisionGate: { status: "PASS" }, findings: [], openBlocking: [{ severity: "foo" }] }), "CHANGES_REQUESTED", "unknown severity blocks");
  assert.equal(normalizeStatus("APPROVED", { finalReview: true, decisionGate: { status: "PASS" }, findings: [], openBlocking: [null] }), "CHANGES_REQUESTED", "null entry blocks");
  assert.equal(normalizeStatus("APPROVED", { finalReview: true, decisionGate: { status: "PASS" }, findings: [], openBlocking: ["critical"] }), "CHANGES_REQUESTED", "string entry blocks (malformed)");
  // Other transport statuses.
  assert.equal(normalizeStatus("PRE_REVIEW_FINDINGS"), "CHANGES_REQUESTED");
  assert.equal(normalizeStatus("BLOCKED_HEAD_MISMATCH"), "BLOCKED");
  assert.equal(normalizeStatus("UNSUPPORTED_TRANSPORT"), "ERROR");
  assert.equal(normalizeStatus("TIMEOUT"), "ERROR");
  assert.equal(normalizeStatus("UNKNOWN"), "ERROR");
  for (const s of STATUSES) assert.ok(s);
});

await test("S10b findings vs openBlocking consistency (review 5062377060 #1)", () => {
  // A finding with a blocking severity must block even if openBlocking
  // is empty. A blocking openBlocking entry must block even if findings
  // is empty. The transport must not get a free pass on disagreement.
  assert.equal(
    normalizeStatus("APPROVED", {
      finalReview: true, decisionGate: { status: "PASS" },
      findings: [{ severity: "critical" }], openBlocking: [],
    }),
    "CHANGES_REQUESTED",
    "an open Critical finding blocks APPROVED"
  );
  assert.equal(
    normalizeStatus("APPROVED", {
      finalReview: true, decisionGate: { status: "PASS" },
      findings: [{ severity: "important" }], openBlocking: [],
    }),
    "CHANGES_REQUESTED",
    "an open Important finding blocks APPROVED"
  );
  assert.equal(
    normalizeStatus("APPROVED", {
      finalReview: true, decisionGate: { status: "PASS" },
      findings: [{ severity: "blocker" }], openBlocking: [],
    }),
    "CHANGES_REQUESTED",
    "an open Blocker finding blocks APPROVED"
  );
  assert.equal(
    normalizeStatus("APPROVED", {
      finalReview: true, decisionGate: { status: "PASS" },
      findings: [], openBlocking: [{ severity: "important" }],
    }),
    "CHANGES_REQUESTED",
    "openBlocking blocker blocks even if findings is clean"
  );
  assert.equal(
    normalizeStatus("APPROVED", {
      finalReview: true, decisionGate: { status: "PASS" },
      findings: [{ severity: "info" }], openBlocking: [],
    }),
    "APPROVED",
    "non-blocking findings do not block"
  );
  // Note: an openBlocking entry with a non-blocking severity is still
  // malformed (only recognized blocker severities are accepted), so it
  // blocks. This is the fail-closed posture the contract requires.
  assert.equal(
    normalizeStatus("APPROVED", {
      finalReview: true, decisionGate: { status: "PASS" },
      findings: [], openBlocking: [{ severity: "low" }],
    }),
    "CHANGES_REQUESTED",
    "openBlocking with unknown severity is malformed and blocks"
  );
  assert.equal(
    normalizeStatus("APPROVED", {
      finalReview: true, decisionGate: { status: "PASS" },
      findings: [], openBlocking: [],
    }),
    "APPROVED",
    "empty openBlocking + empty findings => APPROVED"
  );
});

await test("S10c malformed decisionGate blocks (review 5062377060 #2)", () => {
  // Non-object `decisionGate` (string, number, array) must block, not
  // be silently coerced to null and treated as "no gate".
  const cases = [
    ["BLOCK"],
    [""],
    [42],
    [true],
    [["PASS"]],
  ];
  for (const [gate] of cases) {
    assert.equal(
      normalizeStatus("APPROVED", { finalReview: true, decisionGate: gate, findings: [], openBlocking: [] }),
      "CHANGES_REQUESTED",
      "non-object decisionGate (" + JSON.stringify(gate) + ") blocks"
    );
  }
  assert.equal(
    normalizeStatus("APPROVED", { finalReview: true, decisionGate: {}, findings: [], openBlocking: [] }),
    "CHANGES_REQUESTED",
    "object gate without status blocks"
  );
  assert.equal(
    normalizeStatus("APPROVED", { finalReview: true, decisionGate: { status: "" }, findings: [], openBlocking: [] }),
    "CHANGES_REQUESTED",
    "empty status blocks"
  );
  assert.equal(
    normalizeStatus("APPROVED", { finalReview: true, findings: [], openBlocking: [] }),
    "APPROVED",
    "no decisionGate is acceptable"
  );
});

await test("S10d malformed openBlocking shape blocks (review 5062377060 #2)", () => {
  // Non-array `openBlocking` (string, number, object) must block, not be
  // silently coerced to [] and treated as "no blockers".
  const cases = [
    ["critical"],
    [{ severity: "critical" }],
    [42],
    [true],
  ];
  for (const [ob] of cases) {
    assert.equal(
      normalizeStatus("APPROVED", { finalReview: true, decisionGate: { status: "PASS" }, findings: [], openBlocking: ob }),
      "CHANGES_REQUESTED",
      "non-array openBlocking (" + JSON.stringify(ob) + ") blocks"
    );
  }
  // review 5062489059 #1: for an explicit final APPROVED, openBlocking
  // must be an explicit array. Missing/null openBlocking fails closed.
  assert.equal(
    normalizeStatus("APPROVED", { finalReview: true, decisionGate: { status: "PASS" }, findings: [] }),
    "CHANGES_REQUESTED",
    "missing openBlocking fails closed on final APPROVED"
  );
  assert.equal(
    normalizeStatus("APPROVED", { finalReview: true, decisionGate: { status: "PASS" }, findings: [], openBlocking: null }),
    "CHANGES_REQUESTED",
    "null openBlocking fails closed on final APPROVED"
  );
});

await test("S10e malformed findings shape blocks (review 5062377060 #2)", () => {
  // Non-array `findings` (string, number, object) must block.
  const cases = [
    ["x"],
    [{ severity: "critical" }],
    [42],
  ];
  for (const [f] of cases) {
    assert.equal(
      normalizeStatus("APPROVED", { finalReview: true, decisionGate: { status: "PASS" }, findings: f, openBlocking: [] }),
      "CHANGES_REQUESTED",
      "non-array findings (" + JSON.stringify(f) + ") blocks"
    );
  }
});

await test("S10f malformed findings entries fail closed (review 5062489059 #1)", () => {
  // Malformed findings entries (null, scalar, missing/unknown severity,
  // unknown status) must fail closed on a final APPROVED. A legitimate
  // non-blocking finding (recognized shape + severity + status) does not.
  const good = { finalReview: true, decisionGate: { status: "PASS" }, openBlocking: [] };
  const malformed = [null, "x", 42, {}, { severity: "bogus" }, { severity: "info", status: "bogus" }];
  for (const f of malformed) {
    assert.equal(
      normalizeStatus("APPROVED", { ...good, findings: [f] }),
      "CHANGES_REQUESTED",
      "malformed finding entry (" + JSON.stringify(f) + ") blocks"
    );
  }
  // Missing/null findings container on a final APPROVED fails closed.
  assert.equal(normalizeStatus("APPROVED", { ...good, findings: undefined }), "CHANGES_REQUESTED", "missing findings fails closed");
  assert.equal(normalizeStatus("APPROVED", { ...good, findings: null }), "CHANGES_REQUESTED", "null findings fails closed");
  // Legitimate non-blocking findings approve.
  assert.equal(
    normalizeStatus("APPROVED", { ...good, findings: [{ severity: "info" }] }),
    "APPROVED",
    "recognized non-blocking finding does not block"
  );
  assert.equal(
    normalizeStatus("APPROVED", { ...good, findings: [{ severity: "warning", status: "fixed" }] }),
    "APPROVED",
    "recognized non-blocking finding with explicit status does not block"
  );
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
  const r = validateRequest({ pr: 24, headSha: HEAD_A, projectId: PROJECT });
  assert.equal(r.ok, false);
  assert.ok(r.reason.indexOf("INVALID_REPO") !== -1);
});

await test("S11 validateRequest ok=false for short HEAD", () => {
  const r = validateRequest({ repo: CANON, pr: 24, headSha: "deadbeef", projectId: PROJECT });
  assert.equal(r.ok, false);
  assert.ok(r.reason.indexOf("INVALID_HEAD_SHA") !== -1);
});

await test("S11 validateRequest ok=false for invalid projectId shape", () => {
  const r = validateRequest({ repo: CANON, pr: 24, headSha: HEAD_A, projectId: "BAD ID!" });
  assert.equal(r.ok, false);
  assert.ok(r.reason.indexOf("INVALID_PROJECT_ID") !== -1);
});

await test("S11 validateCanonicalIdentity ok=true for canonical registered project", () => {
  const r = validateCanonicalIdentity(
    { repo: CANON, pr: 24, projectId: PROJECT, htmlUrl: CANON_HTML },
    { registryPath: REG_PATH }
  );
  assert.equal(r.ok, true);
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
// Worktree re-snapshot: full porcelain comparison (byte-for-byte) of
// the worktree after the suite vs the baseline captured before any
// adapter call. Cleanup of REG_DIR (a per-run temp path in OS
// tempdir, not the worktree) is verified by read-back.
// =====================================================================
await test("S8 worktree re-snapshot: byte-for-byte unchanged vs baseline, per-run temp cleaned", () => {
  // Capture the AFTER snapshot. We do this BEFORE rmAllTemp so the
  // captured string is the worktree state as it is right now. The
  // temp registry lives in os.tmpdir(), not the worktree, so removing
  // it does not affect the snapshot.
  captureSnapAfter();
  assert.equal(SNAP_AFTER_CAPTURED, SNAP_BEFORE, "worktree status must be byte-for-byte unchanged (no added/removed/renamed/modified entries)");

  // Now perform the cleanup we promised. The trailing finally below
  // will be a no-op once this completes.
  rmAllTemp();

  // Read-back: the per-run temp registry directory must be gone. The
  // temp paths we track are the ONLY ones we ever delete; this
  // verifies the suite only removed what it created.
  assert.equal(fs.existsSync(REG_DIR), false, "REG_DIR (" + REG_DIR + ") was cleaned up before the suite ended");
  assert.equal(fs.existsSync(REG_PATH), false, "REG_PATH was cleaned up");
});

// =====================================================================
// summary — natural exit (no process.exit). Node's exit code reflects
// the last non-zero assignment to process.exitCode. process.exit() is
// intentionally avoided so that any pending microtasks (and the
// finally cleanup registered below) get a chance to run.
// =====================================================================
let SUITE_FAILED = false;
try {
  for (const l of RESULTS.log) console.log(l);
  console.log("---");
  console.log("PASS " + RESULTS.pass);
  console.log("FAIL " + RESULTS.fail);
  SUITE_FAILED = RESULTS.fail !== 0;
} finally {
  // Always clean temp paths (REG_DIR et al.) before the process exits.
  rmAllTemp();
  process.exitCode = SUITE_FAILED ? 1 : 0;
}
