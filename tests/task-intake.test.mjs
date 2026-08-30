// Regression + parity tests for packages/task-intake.
//
// Source: duongpdddic-droid/AI_PR_REVIEWER @ 9c104c88 (scripts/github-task-intake.mjs).
// Soc_brain adaptations are exercised as new tests (no parity coverage exists
// upstream for them).
//
// Test groups:
//   §1 labels normalization         (parity with source)
//   §2 ready-task classification    (parity with source)
//   §3 issue-state classification   (parity with source)
//   §4 claim-marker idempotency     (parity with source)
//   §5 canonical project identity   (Soc_brain; fail-closed)
//   §6 stable task identity         (Soc_brain; idempotency)
//   §7 intent classification        (Soc_brain; label + keyword)
//   §8 evidence compaction + redaction (Soc_brain; AC "compact, non-secret")
//   §9 evaluateIntake top-level     (Soc_brain; fail-closed decision)
//   §10 parity guard against upstream drift (Issue #9 AC traceable symbols)

import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  labelsToNames,
  hasLabels,
  isPullRequest,
  filterReadyTasks,
  classifyReadyTasks,
  classifyIssueState,
  parseClaimMarker,
  hasClaimMarker,
  buildClaimBody,
  safeTaskPayload,
  compactEvidence,
  validateCanonicalProject,
  deriveTaskIdentityKey,
  buildStableTaskId,
  classifyIntent,
  evaluateIntake,
} from "../packages/task-intake/task-intake.mjs";

const RESULTS = { pass: 0, fail: 0, skip: 0, log: [] };
const t0 = Date.now();
async function test(name, fn) {
  try {
    await fn();
    RESULTS.pass++;
    RESULTS.log.push("PASS " + name);
  } catch (e) {
    RESULTS.fail++;
    RESULTS.log.push("FAIL " + name + " :: " + (e && e.message ? e.message : String(e)));
  }
}
function skip(name, why) { RESULTS.skip++; RESULTS.log.push("SKIP " + name + " :: " + why); }

const CANON = "duongpdddic-droid/Soc_brain";
const CANON_HTML = "https://github.com/duongpdddic-droid/Soc_brain/issues/9";

function readyIssue(overrides = {}) {
  return {
    number: 9,
    state: "open",
    title: "Extract shared Task Intake primitives",
    body: "Implementation task.",
    html_url: CANON_HTML,
    labels: [{ name: "agent:cline" }, { name: "status:ready-for-cline" }],
    ...overrides,
  };
}

// ---- §1 labels normalization ----------------------------------------------

await test("§1 labelsToNames handles string + object forms", () => {
  assert.deepEqual(labelsToNames(["a", { name: "b" }, { name: "c" }]), ["a", "b", "c"]);
});
await test("§1 labelsToNames tolerates null/undefined", () => {
  assert.deepEqual(labelsToNames(undefined), []);
  assert.deepEqual(labelsToNames(null), []);
});
await test("§1 hasLabels requires all labels", () => {
  assert.equal(hasLabels({ labels: [{ name: "a" }, { name: "b" }] }, ["a"]), true);
  assert.equal(hasLabels({ labels: [{ name: "a" }] }, ["a", "b"]), false);
});

// ---- §2 ready-task classification -----------------------------------------

await test("§2 filterReadyTasks accepts only open Issue with both labels", () => {
  const ok = readyIssue();
  const closed = readyIssue({ state: "closed" });
  const pr = readyIssue({ pull_request: {} });
  const missingLabel = readyIssue({ labels: [{ name: "agent:cline" }] });
  assert.deepEqual(filterReadyTasks([ok, closed, pr, missingLabel]).map((i) => i.number), [9]);
});
await test("§2 classifyReadyTasks NO_TASK / READY / BLOCKED_MULTIPLE_TASKS", () => {
  assert.deepEqual(classifyReadyTasks([]), { status: "NO_TASK", numbers: [] });
  const one = classifyReadyTasks([{ number: 9 }]);
  assert.equal(one.status, "READY");
  assert.equal(one.task.number, 9);
  const many = classifyReadyTasks([{ number: 1 }, { number: 2 }]);
  assert.equal(many.status, "BLOCKED_MULTIPLE_TASKS");
  assert.deepEqual(many.numbers, [1, 2]);
});
await test("§2 classifyReadyTasks handles non-array", () => {
  assert.deepEqual(classifyReadyTasks(null), { status: "NO_TASK", numbers: [] });
  assert.deepEqual(classifyReadyTasks(undefined), { status: "NO_TASK", numbers: [] });
});

// ---- §3 issue-state classification ----------------------------------------

await test("§3 classifyIssueState READY / IN_PROGRESS / CLOSED / OTHER", () => {
  assert.equal(classifyIssueState({ state: "open", labels: [{ name: "status:ready-for-cline" }] }), "READY");
  assert.equal(classifyIssueState({ state: "open", labels: [{ name: "status:in-progress" }] }), "IN_PROGRESS");
  assert.equal(classifyIssueState({ state: "closed", labels: [] }), "CLOSED");
  assert.equal(classifyIssueState({ state: "open", labels: [] }), "OTHER");
  assert.equal(classifyIssueState(null), "OTHER");
});

// ---- §4 claim-marker idempotency ------------------------------------------

await test("§4 parseClaimMarker reads source-compatible marker", () => {
  const body = "<!-- cline-claim:9:abc:2026-08-30T00:00:00Z -->\nrest";
  assert.deepEqual(parseClaimMarker(body), { issueNumber: 9 });
});
await test("§4 parseClaimMarker rejects noise", () => {
  assert.equal(parseClaimMarker("nothing here"), null);
  assert.equal(parseClaimMarker(null), null);
});
await test("§4 hasClaimMarker finds matching issueNumber only", () => {
  const comments = [
    { body: "<!-- cline-claim:9:abc:2026 -->" },
    { body: "<!-- cline-claim:10:def:2026 -->" },
  ];
  assert.equal(hasClaimMarker(comments, 9), true);
  assert.equal(hasClaimMarker(comments, 10), true);
  assert.equal(hasClaimMarker(comments, 11), false);
  assert.equal(hasClaimMarker(null, 9), false);
});
await test("§4 buildClaimBody produces source-compatible marker", () => {
  const body = buildClaimBody({ issueNumber: 9, baseSha: "deadbeef", at: "2026-08-30T00:00:00Z" });
  assert.match(body, /^<!-- cline-claim:9:deadbeef:2026-08-30T00:00:00Z -->/);
  assert.deepEqual(parseClaimMarker(body), { issueNumber: 9 });
});

// ---- §5 canonical project identity (fail-closed) --------------------------

await test("§5 validateCanonicalProject accepts matching html_url", () => {
  const v = validateCanonicalProject({ issue: readyIssue(), canonicalRepo: CANON });
  assert.equal(v.ok, true);
  assert.equal(v.issueProject, "duongpdddic-droid/soc_brain");
});
await test("§5 validateCanonicalProject rejects missing issue", () => {
  assert.equal(validateCanonicalProject({ issue: null, canonicalRepo: CANON }).reason, "MISSING_ISSUE");
});
await test("§5 validateCanonicalProject rejects missing canonical", () => {
  assert.equal(validateCanonicalProject({ issue: readyIssue(), canonicalRepo: "" }).reason, "MISSING_CANONICAL_REPO");
});
await test("§5 validateCanonicalProject rejects conflicting identity", () => {
  const other = readyIssue({ html_url: "https://github.com/duongpdddic-droid/AI_PR_REVIEWER/issues/9" });
  const v = validateCanonicalProject({ issue: other, canonicalRepo: CANON });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "BLOCKED_PROJECT_MISMATCH");
});
await test("§5 validateCanonicalProject rejects missing project identity", () => {
  const v = validateCanonicalProject({ issue: { number: 1, labels: [] }, canonicalRepo: CANON });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "MISSING_PROJECT_IDENTITY");
});

// ---- §6 stable task identity (idempotency) -------------------------------

await test("§6 deriveTaskIdentityKey is deterministic and independent of `now`", () => {
  const a = deriveTaskIdentityKey({ repo: CANON, issueNumber: 9, now: "2026-01-01T00:00:00Z" });
  const b = deriveTaskIdentityKey({ repo: CANON, issueNumber: 9, now: "2099-12-31T23:59:59Z" });
  assert.equal(a, b);
  assert.equal(a.length, 64);
  const expected = crypto.createHash("sha256").update("task-intake|v1|" + CANON.toLowerCase() + "|9").digest("hex");
  assert.equal(a, expected);
});
await test("§6 deriveTaskIdentityKey rejects invalid inputs", () => {
  assert.equal(deriveTaskIdentityKey({ repo: "", issueNumber: 9 }), null);
  assert.equal(deriveTaskIdentityKey({ repo: CANON, issueNumber: 0 }), null);
  assert.equal(deriveTaskIdentityKey({ repo: CANON, issueNumber: -1 }), null);
  assert.equal(deriveTaskIdentityKey({ repo: CANON, issueNumber: 1.5 }), null);
});
await test("§6 deriveTaskIdentityKey rejects duplicates across different repos", () => {
  const a = deriveTaskIdentityKey({ repo: "owner/A", issueNumber: 1 });
  const b = deriveTaskIdentityKey({ repo: "owner/B", issueNumber: 1 });
  assert.notEqual(a, b);
});
await test("§6 buildStableTaskId slugifies title", () => {
  assert.equal(
    buildStableTaskId({ repo: CANON, issueNumber: 9, title: "Extract shared Task Intake primitives" }),
    "duongpdddic-droid/soc_brain#9-extract-shared-task-intake-primitives",
  );
});
await test("§6 buildStableTaskId fallback slug + invalid inputs", () => {
  assert.match(buildStableTaskId({ repo: CANON, issueNumber: 1, title: "" }), /^duongpdddic-droid\/soc_brain#1-/);
  assert.equal(buildStableTaskId({ repo: "", issueNumber: 1, title: "x" }), null);
  assert.equal(buildStableTaskId({ repo: CANON, issueNumber: 0, title: "x" }), null);
});

// ---- §7 intent classification ---------------------------------------------

await test("§7 classifyIntent label wins over keyword", () => {
  const issue = {
    title: "Investigate runtime leak",
    body: "Just a read-only audit.",
    labels: [{ name: "kind:read-only" }],
  };
  const r = classifyIntent(issue);
  assert.equal(r.intent, "READ_ONLY");
  assert.equal(r.source, "label");
});
await test("§7 classifyIntent keyword fallback", () => {
  const r = classifyIntent({
    title: "Port shared primitives",
    body: "Implement extraction for Soc_brain.",
    labels: [],
  });
  assert.equal(r.intent, "IMPLEMENT");
  assert.equal(r.source, "keyword");
});
await test("§7 classifyIntent default IMPLEMENT when no signal", () => {
  const r = classifyIntent({ title: "Foo bar baz", body: "No signal here.", labels: [] });
  assert.equal(r.intent, "IMPLEMENT");
  assert.equal(r.source, "default");
});
await test("§7 classifyIntent read-only keyword wins when label absent", () => {
  const r = classifyIntent({
    title: "Audit existing module",
    body: "Read-only inspection.",
    labels: [],
  });
  assert.equal(r.intent, "READ_ONLY");
});
await test("§7 classifyIntent null issue -> OTHER", () => {
  assert.equal(classifyIntent(null).intent, "OTHER");
});

// ---- §8 evidence compaction + redaction ------------------------------------

await test("§8 safeTaskPayload selects compact fields", () => {
  const out = safeTaskPayload({
    number: 9,
    title: "t",
    html_url: "u",
    body: "b",
    labels: [{ name: "x" }],
    extra: "should be dropped",
  });
  assert.deepEqual(Object.keys(out).sort(), ["body", "html_url", "labels", "number", "title"]);
});
await test("§8 compactEvidence redacts absolute home paths", () => {
  const issue = {
    number: 1,
    title: "t",
    html_url: "x",
    body: [
      "See C:\\Users\\Admin\\.soc-brain\\x.json for state",
      "/Users/alice/.config/y on macOS",
      "/home/bob/.zshrc on linux",
      "~/work/note.md short form",
      "no path here",
    ].join("\n"),
    labels: [],
  };
  const out = compactEvidence(issue);
  assert.equal(out.body.includes("Admin"), false);
  assert.equal(out.body.includes("alice"), false);
  assert.equal(out.body.includes("bob"), false);
  assert.equal(out.body.includes("~/work"), false);
  assert.ok(out.body.includes("<home>"));
  assert.equal(out.body.includes("no path here"), true);
  assert.equal(out.bodyTruncated, false);
});
await test("§8 compactEvidence caps oversized body", () => {
  const big = "x".repeat(3000);
  const out = compactEvidence({ number: 1, title: "t", html_url: "u", body: big, labels: [] });
  // BODY_MAX_CHARS = 2000 + 1 ellipsis char.
  assert.equal(out.body.length, 2001);
  assert.equal(out.bodyTruncated, true);
});

// ---- §9 evaluateIntake top-level ------------------------------------------

await test("§9 evaluateIntake ACCEPTED for ready issue", () => {
  const r = evaluateIntake({ issue: readyIssue(), canonicalRepo: CANON, now: "2026-08-30T00:00:00Z" });
  assert.equal(r.status, "ACCEPTED");
  assert.equal(r.accepted, true);
  assert.equal(r.state, "READY");
  assert.equal(r.identity.issueNumber, 9);
  assert.ok(r.identity.identityKey);
  assert.match(r.identity.stableTaskId, /^duongpdddic-droid\/soc_brain#9-/);
  assert.equal(r.intent.intent, "IMPLEMENT");
  assert.equal(r.evidence.bodyTruncated, false);
});
await test("§9 evaluateIntake rejects closed issue", () => {
  const r = evaluateIntake({ issue: readyIssue({ state: "closed" }), canonicalRepo: CANON });
  assert.equal(r.status, "BLOCKED_STATE_CLOSED");
  assert.equal(r.accepted, false);
  assert.equal(r.identity, null);
});
await test("§9 evaluateIntake rejects pull_request", () => {
  const r = evaluateIntake({ issue: readyIssue({ pull_request: { url: "x" } }), canonicalRepo: CANON });
  assert.equal(r.status, "BLOCKED_IS_PULL_REQUEST");
});
await test("§9 evaluateIntake rejects project mismatch", () => {
  const other = readyIssue({ html_url: "https://github.com/duongpdddic-droid/AI_PR_REVIEWER/issues/9" });
  const r = evaluateIntake({ issue: other, canonicalRepo: CANON });
  assert.equal(r.status, "BLOCKED_PROJECT_MISMATCH");
});
await test("§9 evaluateIntake rejects missing issue number", () => {
  const bad = readyIssue();
  delete bad.number;
  const r = evaluateIntake({ issue: bad, canonicalRepo: CANON });
  assert.equal(r.status, "BLOCKED_MISSING_ISSUE_NUMBER");
});
await test("§9 evaluateIntake returns BLOCKED_STATE_IN_PROGRESS for in-progress", () => {
  const inprog = readyIssue({ labels: [{ name: "agent:cline" }, { name: "status:in-progress" }] });
  const r = evaluateIntake({ issue: inprog, canonicalRepo: CANON });
  assert.equal(r.status, "BLOCKED_STATE_IN_PROGRESS");
  assert.equal(r.accepted, false);
  assert.equal(r.identity, null); // fail-closed: no partial identity surfaced
});
await test("§9 evaluateIntake idempotent identity across calls", () => {
  const a = evaluateIntake({ issue: readyIssue(), canonicalRepo: CANON, now: "2026-01-01T00:00:00Z" });
  const b = evaluateIntake({ issue: readyIssue(), canonicalRepo: CANON, now: "2099-12-31T23:59:59Z" });
  assert.equal(a.identity.identityKey, b.identity.identityKey);
  assert.equal(a.identity.stableTaskId, b.identity.stableTaskId);
});

// ---- §10 parity guard against upstream drift -----------------------------

await test("§10 parity: labelsToNames/hasLabels/filterReadyTasks match source semantics", () => {
  // Reference behavior re-derived from the pinned source primitives (no
  // git fetch — local reproduction). If the source ever changes, this test
  // forces a conscious decision on the Soc_brain side.
  const refLabelsToNames = (labels) => (labels || []).map((l) => (typeof l === "string" ? l : l.name));
  const refHasLabels = (issue, required) => {
    const names = new Set(refLabelsToNames(issue && issue.labels));
    return required.every((n) => names.has(n));
  };
  const refIsPullRequest = (issue) => Boolean(issue && issue.pull_request);
  const refFilterReady = (issues) =>
    (issues || []).filter(
      (i) => i && i.state === "open" && !refIsPullRequest(i) && refHasLabels(i, ["agent:cline", "status:ready-for-cline"]),
    );

  const sample = [
    readyIssue(),
    readyIssue({ number: 1, state: "closed" }),
    readyIssue({ number: 2, pull_request: {} }),
    { number: 3, state: "open", labels: [{ name: "agent:cline" }] },
  ];
  const refIds = refFilterReady(sample).map((i) => i.number);
  const ourIds = filterReadyTasks(sample).map((i) => i.number);
  assert.deepEqual(ourIds, refIds);
});

// ---- summary --------------------------------------------------------------

function summarize() {
  const dur = Date.now() - t0;
  for (const l of RESULTS.log) console.log(l);
  console.log("---");
  console.log("PASS " + RESULTS.pass);
  console.log("FAIL " + RESULTS.fail);
  console.log("SKIP " + RESULTS.skip);
  console.log("DUR ms " + dur);
  process.exit(RESULTS.fail === 0 ? 0 : 1);
}
summarize();