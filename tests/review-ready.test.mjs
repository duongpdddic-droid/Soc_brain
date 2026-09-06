#!/usr/bin/env node
// review-ready.test.mjs - deterministic tests for packages/review-ready.
// No network/GitHub. Run: node tests/review-ready.test.mjs. Exit 0 = PASS, 1 = FAIL.
// Chứng minh additive: generator chỉ đọc canonical evidence + ghi file ngoài worktree;
// không động vào validator/contract/state machine (không import chúng).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_REVIEW_READY_DIR,
  buildReviewReadyFilename,
  renderReviewReady,
  writeReviewReady,
} from "../packages/review-ready/review-ready.mjs";

const RESULTS = { pass: 0, fail: 0, log: [] };
async function test(name, fn) {
  try { await fn(); RESULTS.pass++; RESULTS.log.push("PASS " + name); }
  catch (e) { RESULTS.fail++; RESULTS.log.push("FAIL " + name + " :: " + (e && e.message ? e.message : String(e))); }
}

const HEAD_A = "0123456789abcdef0123456789abcdef01234567";
const HEAD_B = "fedcba9876543210fedcba9876543210fedcba98";
const DIGEST = "a".repeat(64);

// Temp dirs tracked + removed at exit (convention từ ai-pr-reviewer-adapter.test).
const TEMP_PATHS = [];
function mkTmpDir(prefix) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_PATHS.push(p);
  return p;
}
function rmAllTemp() {
  for (const p of TEMP_PATHS) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
  TEMP_PATHS.length = 0;
}

// deepMerge 1 cấp theo section (tương đương contract sampleReport + overrides).
function merge(base, overrides) {
  if (!overrides || typeof overrides !== "object") return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== null && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object") {
      out[k] = { ...base[k], ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Report đúng canonical shape 10 sections (Issue #32 REVIEW HANDOFF CONTRACT).
function sampleReport(overrides = {}) {
  const base = {
    contractVersion: "1.0.0",
    identity: {
      repository: "duongpdddic-droid/AI_PR_REVIEWER",
      issue: 32,
      pullRequest: 40,
      branch: "feat/issue-32-review-handoff-contract",
      headSha: HEAD_A,
      baseSha: HEAD_B,
      prState: "Draft",
      noForcePushMergeDeploy: true,
    },
    scope: {
      objective: "Add canonical Review Handoff Contract",
      acceptanceCriteria: ["canonical contract", "validator", "gate"],
      changedFiles: ["scripts/review-handoff-contract.mjs"],
      exclusions: [],
      deviations: [],
    },
    codeEvidence: { items: [{ file: "scripts/review-handoff-contract.mjs", lines: "1-70", symbol: "validateHandoff", before: "missing", after: "structured errors" }] },
    findingResolution: { items: [{ findingId: "GPT-REV-000", severity: "low", status: "fixed" }] },
    tests: { items: [{ name: "happy path", location: "scripts/test-review-handoff-contract.mjs", result: "PASS", exitCode: 0 }] },
    verification: { commands: ["node scripts/test-review-handoff-contract.mjs"], exitCodes: [0], passCount: 1, failCount: 0, diffCheck: "clean", worktreeStatus: "clean", remainingFailures: [] },
    safety: { inputsMutated: false, preExistingOverwrite: false, sharedPathnameTouched: false, toctouRace: "none", accessOutsideWorktree: false, remoteMutation: false, rollbackScope: "only current invocation state" },
    unverifiedRisks: { items: [] },
    delivery: { commitSha: HEAD_A, pushResult: "pushed", prActions: "Draft PR #40 opened", headReadBack: true, noApprovalClaim: true },
    terminalStatus: { status: "READY_FOR_REVIEW" },
  };
  return merge(base, overrides);
}

// ---- filename -------------------------------------------------------------
await test("buildReviewReadyFilename exact", () => {
  const name = buildReviewReadyFilename({ repo: "duongpdddic-droid/AI_PR_REVIEWER", issue: 32, pr: 40, headSha: HEAD_A });
  assert.equal(name, "duongpdddic-droid_AI_PR_REVIEWER_Issue-32_PR-40_0123456_review-ready.md");
});

await test("buildReviewReadyFilename rejects bad pr/headSha", () => {
  assert.equal(buildReviewReadyFilename({ repo: "o/r", issue: 1, pr: 0, headSha: HEAD_A }), null);
  assert.equal(buildReviewReadyFilename({ repo: "o/r", issue: 1, pr: 1, headSha: "abc" }), null);
  assert.equal(buildReviewReadyFilename({}), null);
});

await test("buildReviewReadyFilename sanitizes repo slug (no path traversal)", () => {
  const name = buildReviewReadyFilename({ repo: "o/r", issue: 1, pr: 1, headSha: HEAD_A });
  assert.equal(name.includes("/"), false);
  assert.equal(name.includes("\\"), false);
  assert.equal(name.includes(".."), false);
});

// ---- render: happy path ---------------------------------------------------
await test("renderReviewReady READY_FOR_REVIEW ok + content projection", () => {
  const r = renderReviewReady(sampleReport());
  assert.equal(r.ok, true);
  assert.ok(r.content.includes("# Review Ready — duongpdddic-droid/AI_PR_REVIEWER Issue #32 · PR #40"));
  assert.ok(r.content.includes("## Scope"));
  assert.ok(r.content.includes("objective: Add canonical Review Handoff Contract"));
  assert.ok(r.content.includes("scripts/review-handoff-contract.mjs"));
  assert.ok(r.content.includes("symbol=validateHandoff"));
  assert.ok(r.content.includes("passCount: 1"));
  assert.ok(r.content.includes("status: **READY_FOR_REVIEW**"));
  assert.ok(r.content.includes("headSha: " + HEAD_A + " (short 0123456)"));
});

await test("renderReviewReady deterministic", () => {
  const a = renderReviewReady(sampleReport());
  const b = renderReviewReady(sampleReport());
  assert.equal(a.content, b.content);
  assert.equal(a.filename, b.filename);
});

await test("renderReviewReady stamps digest when valid", () => {
  const r = renderReviewReady(sampleReport(), { digest: DIGEST });
  assert.equal(r.ok, true);
  assert.ok(r.content.includes("reportDigest: " + DIGEST));
});

// ---- render: fail-closed --------------------------------------------------
await test("renderReviewReady rejects non-READY status", () => {
  const r = renderReviewReady(sampleReport({ terminalStatus: { status: "BLOCKED" } }));
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, "NOT_READY_FOR_REVIEW");
});

await test("renderReviewReady rejects missing identity", () => {
  const r = renderReviewReady(sampleReport({ identity: null }));
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, "IDENTITY_MISSING");
});

await test("renderReviewReady rejects bad headSha", () => {
  const r = renderReviewReady(sampleReport({ identity: { headSha: "short" } }));
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, "IDENTITY_HEAD_SHA_INVALID");
});

await test("renderReviewReady rejects invalid digest", () => {
  const r = renderReviewReady(sampleReport(), { digest: "nothex" });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, "DIGEST_INVALID");
});

// ---- write ----------------------------------------------------------------
await test("writeReviewReady writes outside worktree", () => {
  const out = mkTmpDir("rr-out-");
  const wt = mkTmpDir("rr-wt-"); // worktree riêng — outputDir không nằm trong đó
  const r = writeReviewReady(sampleReport(), { outputDir: out, worktreePath: wt });
  assert.equal(r.ok, true);
  const expected = "duongpdddic-droid_AI_PR_REVIEWER_Issue-32_PR-40_0123456_review-ready.md";
  assert.equal(r.filename, expected);
  assert.equal(r.filePath, path.join(path.resolve(out), expected));
  assert.equal(fs.existsSync(r.filePath), true);
  assert.equal(fs.readFileSync(r.filePath, "utf8"), r.content);
  assert.equal(fs.existsSync(path.join(wt, expected)), false); // ngoài worktree
});

await test("writeReviewReady fails closed when outputDir inside worktree", () => {
  const wt = mkTmpDir("rr-wt2-");
  const inside = path.join(wt, "sub"); // nằm trong worktree
  const r = writeReviewReady(sampleReport(), { outputDir: inside, worktreePath: wt });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, "OUTPUT_INSIDE_WORKTREE");
  assert.equal(fs.existsSync(inside), false); // không tạo dir, không ghi
});

await test("writeReviewReady fails closed on non-READY (no file written)", () => {
  const out = mkTmpDir("rr-out2-");
  const r = writeReviewReady(sampleReport({ terminalStatus: { status: "BLOCKED" } }), { outputDir: out });
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(path.join(out, "duongpdddic-droid_AI_PR_REVIEWER_Issue-32_PR-40_0123456_review-ready.md")), false);
});

await test("DEFAULT_REVIEW_READY_DIR outside worktree convention", () => {
  const dir = DEFAULT_REVIEW_READY_DIR();
  assert.ok(dir.endsWith(path.join(".soc-brain", "review-ready")));
  // NOTE (P0-E #79): the old `assert.equal(fs.existsSync(dir), false)` was
  // machine-state dependent — on operator machines with real review packets
  // (written by earlier verification phases) the default dir legitimately
  // exists. The convention assertion above is the hermetic invariant.
});

// ---- summary --------------------------------------------------------------
rmAllTemp();
const total = RESULTS.pass + RESULTS.fail;
for (const line of RESULTS.log) console.log(line);
console.log(`review-ready: ${RESULTS.pass}/${total} passed${RESULTS.fail ? ", " + RESULTS.fail + " FAILED" : ""}`);
process.exit(RESULTS.fail === 0 ? 0 : 1);
