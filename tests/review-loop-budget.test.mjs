#!/usr/bin/env node
// review-loop-budget.test.mjs — targeted tests for REVIEW_LOOP_CONTRACT.md v1
// (OCR pre-review budget + REWORK convergence) and its enforcement module
// packages/review-leg/review-loop-budget.mjs.
//
// Proves the 9 GATE-8 points. No network, no spawn, no FSM, no lifecycle
// mutation. Run: node tests/review-loop-budget.test.mjs. Exit 0 = PASS, 1 = FAIL.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REVIEW_LOOP_VERSION,
  OCR_MAX_PASSES_PER_EPOCH,
  OCR_AUTHORITY,
  OCR_BUDGET_EXHAUSTED,
  HANDOFF_EVIDENCE_INCOMPLETE,
  ACTIONABLE_REQUIRED_FIELDS,
  PRE_HANDOFF_GATES,
  nextOcrPass,
  classifyOcrSignal,
  isActionableRepairFinding,
  batchRepairPlan,
  convergenceScope,
  planRepairEpoch,
  preHandoffCheck,
  assertNoFinalAuthority,
  buildNextActorInstruction,
} from "../packages/review-leg/review-loop-budget.mjs";
import { validateReviewEvidence } from "../packages/control-loop/review-delegate-evidence.mjs";
import {
  TERMINAL_STATES,
  MAX_REWORK_ROUNDS,
} from "../packages/control-loop/control-loop.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const contract = fs.readFileSync(path.join(ROOT, "REVIEW_LOOP_CONTRACT.md"), "utf8");
const agents = fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");

const RESULTS = { pass: 0, fail: 0, log: [] };
async function test(name, fn) {
  try { await fn(); RESULTS.pass++; RESULTS.log.push("PASS " + name); }
  catch (e) { RESULTS.fail++; RESULTS.log.push("FAIL " + name + " :: " + (e && e.message ? e.message : String(e))); }
}

const BIND = {
  identityHash: "a".repeat(32),
  repo: "owner/repo",
  issueNumber: 1,
  baseSha: "b".repeat(40),
  headSha: "c".repeat(40),
};
function mkEvidence(over = {}) {
  return {
    schemaVersion: "1",
    source: "ocr-delegate+opencode-host",
    binding: { ...BIND },
    target: { mode: "range", from: BIND.baseSha, to: BIND.headSha },
    ocr: { version: "1.12.4", ruleGroups: 2 },
    reviewableFiles: ["src/a.mjs"],
    excludedFiles: [],
    reviewedFiles: ["src/a.mjs"],
    skippedFiles: [],
    coverageRate: 1,
    findings: [{ path: "src/a.mjs", content: "null check missing on user input", startLine: 10, endLine: 12, category: "bug", severity: "high" }],
    reflectionCompleted: true,
    durationMs: 5,
    ...over,
  };
}
function mkRepairFinding(over = {}) {
  return {
    file: "src/a.mjs",
    observedBehavior: "throws TypeError on empty input",
    invariant: "validate before use",
    consequence: "executor crashes, loop BLOCKED",
    fixBoundary: "src/a.mjs guard only",
    testEvidence: "tests/a.test.mjs empty-input case",
    passGate: "empty input returns {ok:false}",
    ...over,
  };
}
function allProvenGates() {
  const g = {};
  for (const name of PRE_HANDOFF_GATES) g[name] = { proven: true };
  return g;
}

// ---- GATE 8.1: OCR has no final-review authority -----------------------------
await test("1a closed-world validator forbids verdict-bearing evidence", () => {
  assert.equal(validateReviewEvidence(mkEvidence({ verdict: "PASS" })).code, "EVIDENCE_VERDICT_FORBIDDEN");
  assert.equal(validateReviewEvidence(mkEvidence({ verdict: "REWORK" })).code, "EVIDENCE_VERDICT_FORBIDDEN");
  assert.equal(validateReviewEvidence(mkEvidence()).ok, true);
});

await test("1b authority detector rejects verdict/terminalize-shaped fields", () => {
  assert.equal(assertNoFinalAuthority({ findings: [] }).ok, true);
  assert.equal(assertNoFinalAuthority({ verdict: "PASS" }).ok, false);
  assert.equal(assertNoFinalAuthority({ metadata: { terminalizeToken: "x" } }).code, "OCR_AUTHORITY_VIOLATION");
  assert.equal(assertNoFinalAuthority(mkEvidence()).authority, OCR_AUTHORITY);
});

await test("1c contract pins OCR as INFORMATIONAL, never final PASS", () => {
  assert.ok(contract.includes("INFORMATIONAL"));
  assert.ok(contract.includes("không được"));
  assert.ok(contract.includes("SUPPORTING_ONLY"));
});

// ---- GATE 8.2: OCR budget max 2 passes / review epoch -------------------------
await test("2a nextOcrPass: 0->DISCOVERY, 1->CONVERGENCE", () => {
  assert.deepEqual(
    [nextOcrPass({ passesUsed: 0 }).action, nextOcrPass({ passesUsed: 1 }).action],
    ["RUN_DISCOVERY", "RUN_CONVERGENCE"],
  );
  assert.equal(nextOcrPass({ passesUsed: 0 }).role, "DISCOVERY");
  assert.equal(nextOcrPass({ passesUsed: 1 }).role, "CONVERGENCE");
  assert.equal(OCR_MAX_PASSES_PER_EPOCH, 2);
});

await test("2b invalid budget input fails closed", () => {
  assert.equal(nextOcrPass({}).ok, false);
  assert.equal(nextOcrPass({ passesUsed: -1 }).ok, false);
  assert.equal(nextOcrPass({ passesUsed: 1.5 }).ok, false);
});

// ---- GATE 8.3: OCR-1 findings batch-repaired ----------------------------------
await test("3a batch plan groups all actionable into ONE batch", () => {
  const findings = [
    { path: "src/a.mjs", content: "null check missing on user input causes crash", category: "bug", severity: "high" },
    { path: "src/b.mjs", content: "unsanitized path reaches filesystem write", category: "security", severity: "critical" },
    { path: "src/c.mjs", content: "nit: rename for style", category: "style", severity: "low" },
  ];
  const plan = batchRepairPlan(findings);
  assert.equal(plan.singleBatch, true);
  assert.equal(plan.batch.length, 2);
  assert.equal(plan.advisory.length, 1);
  assert.ok(plan.instruction.includes("single cycle") || plan.instruction.includes("BATCH REPAIR"));
});

// ---- GATE 8.4: OCR-2 never expands scope via advisory --------------------------
await test("4a convergence excludes advisory, disables discovery", () => {
  const scope = convergenceScope({
    ocr1Findings: [
      { path: "src/a.mjs", content: "null check missing on user input causes crash", category: "bug", severity: "high" },
      { path: "src/b.mjs", content: "Consider renaming for consistency", category: "style", severity: "low" },
      { path: "src/c.mjs", content: "x", category: "bug", severity: "high" },
    ],
    repairPaths: ["src/a.mjs", "src/a.mjs"],
  });
  assert.equal(scope.verifyClosed.length, 1);
  assert.equal(scope.excludedAdvisory, 2);
  assert.deepEqual(scope.directRegression, ["src/a.mjs"]);
  assert.equal(scope.discoveryEnabled, false);
});

await test("4b classifier fail-direction is advisory", () => {
  assert.equal(classifyOcrSignal(null).status, "ADVISORY");
  assert.equal(classifyOcrSignal({ path: "src/a.mjs", content: "short", category: "bug", severity: "high" }).status, "ADVISORY");
  assert.equal(classifyOcrSignal({ content: "detailed crash description here", category: "bug", severity: "high" }).status, "ADVISORY");
  assert.equal(classifyOcrSignal({ path: "src/a.mjs", content: "Food for thought: maybe restructure", category: "maintainability", severity: "medium" }).status, "ADVISORY");
});

// ---- GATE 8.5: no OCR-3 after OCR-2 --------------------------------------------
await test("5a passesUsed>=2 always STOPs with budget code", () => {
  for (const n of [2, 3, 99]) {
    const r = nextOcrPass({ passesUsed: n });
    assert.equal(r.stop, true);
    assert.equal(r.action, "STOP");
    assert.equal(r.stopCode, OCR_BUDGET_EXHAUSTED);
  }
});

// ---- GATE 8.6: Final-review REWORK creates a repair epoch ----------------------
await test("6a repair epoch focuses final findings, no scratch discovery", () => {
  const epoch = planRepairEpoch({
    reworkFindings: [mkRepairFinding(), { file: "src/b.mjs", observedBehavior: "x" }],
    repairPaths: ["src/a.mjs"],
    newSignals: [{ path: "src/c.mjs", content: "data race on shared counter under load", category: "bug", severity: "critical" }],
  });
  assert.deepEqual(epoch.focusOrder, ["FINAL_FINDINGS", "DIRECT_REGRESSION", "NEW_BLOCKERS"]);
  assert.equal(epoch.finalFindings.length, 1);
  assert.equal(epoch.finalFindingsMissingFields, 1);
  assert.deepEqual(epoch.directRegression, ["src/a.mjs"]);
  assert.equal(epoch.newBlockers.length, 1);
  assert.equal(epoch.discoveryFromScratch, false);
});

// ---- GATE 8.7: repair-epoch OCR targets finals + direct regression -------------
await test("7a low/style advisory never enters repair-epoch scope", () => {
  const epoch = planRepairEpoch({
    reworkFindings: [mkRepairFinding()],
    repairPaths: [],
    newSignals: [
      { path: "src/s.mjs", content: "trailing whitespace style cleanup opportunity", category: "style", severity: "low" },
      { path: "src/d.mjs", content: "short", category: "bug", severity: "high" },
    ],
  });
  assert.equal(epoch.newBlockers.length, 0);
});

// ---- GATE 8.8: missing required evidence never READY_FOR_REVIEW ----------------
await test("8a all gates proven -> ok", () => {
  const r = preHandoffCheck({ gates: allProvenGates() });
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
});

await test("8b unproven gate -> BLOCKED with missing + next actor", () => {
  const gates = allProvenGates();
  delete gates.diffCheck;
  gates.targetedTests = { proven: false };
  const r = preHandoffCheck({ gates });
  assert.equal(r.ok, false);
  assert.equal(r.code, HANDOFF_EVIDENCE_INCOMPLETE);
  assert.ok(r.missing.includes("diffCheck") && r.missing.includes("targetedTests"));
  assert.equal(r.nextActor.actor, "EXECUTOR");
  assert.ok(r.nextActor.do.length >= 2);
});

await test("8c malformed gates input fails closed", () => {
  const r = preHandoffCheck({ gates: null });
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, PRE_HANDOFF_GATES.length);
});

// ---- GATE 8.9: canonical lifecycle semantics unchanged --------------------------
await test("9a terminal states still COMPLETED + BLOCKED", () => {
  assert.ok(TERMINAL_STATES.has("COMPLETED") && TERMINAL_STATES.has("BLOCKED"));
  assert.ok(Number.isInteger(MAX_REWORK_ROUNDS) && MAX_REWORK_ROUNDS >= 1);
});

await test("9b budget module imports nothing and calls no authority", () => {
  const src = fs.readFileSync(path.join(ROOT, "packages/review-leg/review-loop-budget.mjs"), "utf8");
  assert.equal(/^import\s/m.test(src), false);
  assert.equal(/child_process|node:|require\(/ .test(src), false);
  assert.equal(/\b(terminalize|taskFinish|taskBlock|dispatch|spawn|fetch)\s*\(/.test(src), false);
  assert.ok(src.includes("AUTHORITY_KEYS"));
  assert.ok(src.includes(REVIEW_LOOP_VERSION));
});

// ---- contract doc + AGENTS pointer ---------------------------------------------
await test("doc contract covers gates 2-7 + version", () => {
  assert.ok(contract.includes(REVIEW_LOOP_VERSION));
  assert.ok(contract.includes("OCR-1"));
  assert.ok(contract.includes("OCR-2"));
  assert.ok(contract.includes("Không tự tạo OCR-3"));
  assert.ok(contract.includes("ADVISORY/INFORMATIONAL"));
  assert.ok(contract.includes("repair epoch"));
  assert.ok(contract.includes("READY_FOR_REVIEW"));
  assert.ok(contract.includes("NEXT_ACTOR"));
  assert.ok(contract.includes("FINAL_REVIEW_EXCHANGE_CONTRACT.md"));
});

await test("doc AGENTS.md points at the loop contract (no body copy)", () => {
  assert.ok(agents.includes("REVIEW_LOOP_CONTRACT.md"));
  assert.equal(agents.includes("OCR_BUDGET_EXHAUSTED"), false);
});

await test("doc next-actor instruction shape", () => {
  const text = buildNextActorInstruction({ actor: "EXECUTOR", epoch: 2, findings: ["fix guard"], verify: "run tests", stop: "no merge" });
  assert.ok(text.includes("NEXT_ACTOR: EXECUTOR"));
  assert.ok(text.includes("REPAIR_EPOCH: 2"));
  assert.ok(text.includes("VERIFY: run tests"));
  assert.ok(text.includes("STOP: no merge"));
});

// ---- summary ------------------------------------------------------------------
const total = RESULTS.pass + RESULTS.fail;
for (const line of RESULTS.log) console.log(line);
console.log(`review-loop-budget: ${RESULTS.pass}/${total} passed${RESULTS.fail ? ", " + RESULTS.fail + " FAILED" : ""}`);
process.exit(RESULTS.fail === 0 ? 0 : 1);
