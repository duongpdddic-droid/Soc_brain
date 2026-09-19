#!/usr/bin/env node
// final-review-exchange-contract.test.mjs — policy tests for
// FINAL_REVIEW_EXCHANGE_CONTRACT.md v1 (Soc_brain <-> Final Reviewer,
// automation-first over Web2API/CWA).
//
// Scope of THIS turn (policy only):
//   - NO Web2API/CWA implementation change, NO live smoke, NO commit/push/merge/deploy.
//   - NO ZIP proof artifact is created; ZIP/manifest rules are validated purely.
//   - Validators below are TEST-LOCAL mirrors of the contract (§3, §5, §6, §8).
//     They are intentionally not production parsers (out of scope per task §14.9).
// Run: node tests/final-review-exchange-contract.test.mjs. Exit 0 = PASS, 1 = FAIL.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CONTRACT_PATH = path.join(ROOT, "FINAL_REVIEW_EXCHANGE_CONTRACT.md");
const AGENTS_PATH = path.join(ROOT, "AGENTS.md");

const RESULTS = { pass: 0, fail: 0, log: [] };
async function test(name, fn) {
  try { await fn(); RESULTS.pass++; RESULTS.log.push("PASS " + name); }
  catch (e) { RESULTS.fail++; RESULTS.log.push("FAIL " + name + " :: " + (e && e.message ? e.message : String(e))); }
}

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const ARCHIVE_RE = /^final-review-evidence-[0-9a-f]{4,64}\.zip$/;

const contract = fs.readFileSync(CONTRACT_PATH, "utf8");
const agents = fs.readFileSync(AGENTS_PATH, "utf8");

// ---- A. contract document: required normative sections -----------------------
await test("A1 contract declares version 1", () => {
  assert.ok(contract.includes('`1.0.0`') && contract.includes("FINAL_REVIEW_EXCHANGE_VERSION"));
});

await test("A2 authority boundary (Soc_brain sole authority; reviewer read-only)", () => {
  assert.ok(contract.includes("Soc_brain là authority DUY NHẤT"));
  assert.ok(contract.includes("Final Reviewer KHÔNG được"));
  assert.ok(contract.includes("DATA-only") || contract.includes("DATA only"));
});

await test("A3 transport order GitHub > inline > single ZIP", () => {
  assert.ok(contract.includes("GitHub immutable reference"));
  assert.ok(contract.includes("Inline structured evidence"));
  assert.ok(contract.includes("Single ZIP evidence"));
  assert.ok(contract.includes("đúng MỘT file ZIP"));
  assert.ok(contract.includes("final-review-evidence-<requestDigest-prefix>.zip"));
});

await test("A4 manifest shape + hash-loop rule", () => {
  for (const f of ["requestDigest", "archiveName", "archiveSha256", '"files"', '"testRuns"', "containsSecrets", "logSha256"]) {
    assert.ok(contract.includes(f), "missing " + f);
  }
  assert.ok(contract.includes("Không tự tạo vòng lặp hash"));
});

await test("A5 no-ZIP rules + EVIDENCE_TRANSPORT_UNAVAILABLE", () => {
  assert.ok(contract.includes("Quy tắc không dùng ZIP"));
  assert.ok(contract.includes("EVIDENCE_TRANSPORT_UNAVAILABLE"));
  assert.ok(contract.includes("không yêu cầu Bố tải và gửi ZIP"));
});

await test("A6 chunk fallback shape + partial-is-not-evidence", () => {
  assert.ok(contract.includes("EVIDENCE_CHUNK"));
  assert.ok(contract.includes("chunkSha256"));
  assert.ok(contract.includes("contentSha256"));
  assert.ok(contract.includes("Không được coi\npartial artifact là evidence") || contract.includes("partial artifact là evidence hoàn chỉnh"));
});

await test("A7 trust levels A/B/C/D + C-never-alone + D-not-evidence", () => {
  assert.ok(contract.includes("STRONG"));
  assert.ok(contract.includes("PROVISIONAL"));
  assert.ok(contract.includes("SUPPORTING_ONLY"));
  assert.ok(contract.includes("NOT_EVIDENCE"));
  assert.ok(contract.includes("Mức C không bao giờ"));
});

await test("A8 evidence-request loop + no-blind-resubmit", () => {
  assert.ok(contract.includes("EVIDENCE_REQUEST"));
  assert.ok(contract.includes("preferredTransport"));
  assert.ok(contract.includes("không blind resubmit") || contract.includes("Không blind resubmit"));
});

await test("A9 response contract + strict binding validation", () => {
  assert.ok(contract.includes("PASS|CHANGES_REQUIRED|NEEDS_EVIDENCE|DESIGN_BLOCKED"));
  assert.ok(contract.includes("evidenceAccepted"));
  assert.ok(contract.includes("residualRisks"));
  assert.ok(contract.includes("Sai hoặc thiếu bất kỳ binding field nào phải bị"));
});

await test("A10 backward enum mapping without code change", () => {
  assert.ok(contract.includes("CHANGES_REQUIRED` → `REWORK`"));
  assert.ok(contract.includes("NEEDS_EVIDENCE` → `BLOCKED`"));
  assert.ok(contract.includes("Không tự ý thêm enum value"));
});

await test("A11 verdict rules + human-gate + transport + continuation", () => {
  assert.ok(contract.includes("`PASS` chỉ hợp lệ khi"));
  assert.ok(contract.includes("Không gọi Bố chỉ để"));
  assert.ok(contract.includes("chatgpt-plus-web2api-copy"));
  assert.ok(contract.includes("fresh conversation"));
  assert.ok(contract.includes("Automatic continuation") || contract.includes("Sau mỗi verdict"));
  assert.ok(contract.includes("PASS` → tiếp tục lifecycle"));
});

await test("A12 per-task one-line reference + R1 isolation note", () => {
  assert.ok(contract.includes("FINAL_REVIEW_EXCHANGE_CONTRACT.md v1 (repo-root canonical)"));
  assert.ok(contract.includes("R1 isolation"));
});

await test("A13 no-weakening clause for future changes", () => {
  assert.ok(contract.includes("Không suy yếu policy"));
});

// ---- B. AGENTS.md: pointer only, never a full copy ---------------------------
await test("B1 AGENTS.md references the canonical contract", () => {
  assert.ok(agents.includes("FINAL_REVIEW_EXCHANGE_CONTRACT.md"));
});

await test("B2 AGENTS.md does not embed the contract body", () => {
  assert.equal(agents.includes("EVIDENCE_CHUNK"), false);
  assert.equal(agents.includes("EVIDENCE_TRANSPORT_UNAVAILABLE"), false);
  assert.equal(agents.includes("final-review-evidence-<requestDigest-prefix>.zip"), false);
});

// ---- C. test-local mirror validators (§3 manifest) ----------------------------
const MANIFEST_KINDS = new Set(["SOURCE", "DIFF", "TEST_LOG", "REVIEW_MATRIX", "OTHER"]);

function badPath(p) {
  if (typeof p !== "string" || !p) return "empty";
  if (path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)) return "absolute";
  if (p.includes("..")) return "dotdot";
  if (p.startsWith("/") || p.startsWith("\\")) return "rooted";
  return null;
}

function validateManifest(m) {
  const errs = [];
  if (!m || typeof m !== "object") return ["not-object"];
  if (m.schemaVersion !== "1") errs.push("schemaVersion");
  if (typeof m.requestDigest !== "string" || !HEX64.test(m.requestDigest)) errs.push("requestDigest");
  if (typeof m.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(m.repository)) errs.push("repository");
  if (!Number.isInteger(m.issue) || m.issue <= 0) errs.push("issue");
  if (!Number.isInteger(m.pullRequest) || m.pullRequest <= 0) errs.push("pullRequest");
  if (typeof m.baseSha !== "string" || !HEX40.test(m.baseSha)) errs.push("baseSha");
  if (typeof m.headSha !== "string" || !HEX40.test(m.headSha)) errs.push("headSha");
  if (typeof m.createdAt !== "string" || Number.isNaN(Date.parse(m.createdAt))) errs.push("createdAt");
  if (typeof m.archiveName !== "string" || !ARCHIVE_RE.test(m.archiveName)) errs.push("archiveName");
  if (!(m.archiveSha256 === null || (typeof m.archiveSha256 === "string" && HEX64.test(m.archiveSha256)))) errs.push("archiveSha256");
  if (!Array.isArray(m.files)) errs.push("files");
  else for (const [i, f] of m.files.entries()) {
    const w = badPath(f && f.path);
    if (w) errs.push(`files[${i}].path:${w}`);
    if (!MANIFEST_KINDS.has(f && f.kind)) errs.push(`files[${i}].kind`);
    if (!Number.isInteger(f && f.bytes) || f.bytes < 0) errs.push(`files[${i}].bytes`);
    if (typeof (f && f.sha256) !== "string" || !HEX64.test(f.sha256)) errs.push(`files[${i}].sha256`);
  }
  if (!Array.isArray(m.testRuns)) errs.push("testRuns");
  else for (const [i, t] of m.testRuns.entries()) {
    if (typeof (t && t.command) !== "string" || !t.command.trim()) errs.push(`testRuns[${i}].command`);
    for (const k of ["passed", "failed", "skipped", "cancelled", "exitCode"]) {
      if (!Number.isInteger(t && t[k]) || t[k] < 0) errs.push(`testRuns[${i}].${k}`);
    }
    const lp = badPath(t && t.logPath);
    if (lp || !(t && typeof t.logPath === "string" && t.logPath.startsWith("tests/"))) errs.push(`testRuns[${i}].logPath`);
    if (typeof (t && t.logSha256) !== "string" || !HEX64.test(t.logSha256)) errs.push(`testRuns[${i}].logSha256`);
  }
  if (m.containsSecrets !== false) errs.push("containsSecrets");
  return errs;
}

const DIGEST = "a".repeat(64);
const HEAD = "b".repeat(40);
const BASE = "c".repeat(40);
function goodManifest() {
  return {
    schemaVersion: "1",
    requestDigest: DIGEST,
    repository: "owner/repo",
    issue: 1,
    pullRequest: 2,
    baseSha: BASE,
    headSha: HEAD,
    createdAt: "2026-09-18T00:00:00.000Z",
    archiveName: `final-review-evidence-${DIGEST.slice(0, 12)}.zip`,
    archiveSha256: null, // hash-loop rule: null + external envelope
    files: [{ path: "diff/fix.patch", kind: "DIFF", bytes: 10, sha256: sha256("x"), generated: false }],
    testRuns: [{ command: "node --test tests/a.test.mjs", freshRun: true, passed: 3, failed: 0, skipped: 0, cancelled: 0, exitCode: 0, logPath: "tests/a.log", logSha256: sha256("log") }],
    containsSecrets: false,
  };
}

await test("C1 valid manifest passes (archiveSha256 null allowed)", () => {
  assert.deepEqual(validateManifest(goodManifest()), []);
});

await test("C2 manifest rejects bad digest/shas/name", () => {
  const m = goodManifest();
  m.requestDigest = "zzz"; m.headSha = "abc"; m.archiveName = "evidence.zip";
  const e = validateManifest(m);
  assert.ok(e.includes("requestDigest") && e.includes("headSha") && e.includes("archiveName"));
});

await test("C3 manifest rejects traversal/absolute paths", () => {
  const m1 = goodManifest(); m1.files[0].path = "../evil.patch";
  assert.ok(validateManifest(m1).some((e) => e.startsWith("files[0].path")));
  const m2 = goodManifest(); m2.files[0].path = "/abs/evil.patch";
  assert.ok(validateManifest(m2).some((e) => e.startsWith("files[0].path")));
  const m3 = goodManifest(); m3.testRuns[0].logPath = "logs/a.log";
  assert.ok(validateManifest(m3).some((e) => e.startsWith("testRuns[0].logPath")));
});

await test("C4 manifest rejects bad kind and secrets", () => {
  const m = goodManifest(); m.files[0].kind = "SECRET_DUMP"; m.containsSecrets = true;
  const e = validateManifest(m);
  assert.ok(e.includes("files[0].kind") && e.includes("containsSecrets"));
});

// ---- D. test-local mirror: chunk reassembly (§5) ------------------------------
function validateChunks(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return { ok: false, code: "EMPTY" };
  const first = chunks[0];
  for (const c of chunks) {
    if (c.type !== "EVIDENCE_CHUNK" || c.requestDigest !== first.requestDigest || c.artifactId !== first.artifactId) {
      return { ok: false, code: "BINDING_MISMATCH" };
    }
    if (sha256(c.content) !== c.chunkSha256) return { ok: false, code: "CHUNK_HASH_MISMATCH" };
  }
  const ordered = [...chunks].sort((a, b) => a.index - b.index);
  if (ordered.length !== first.total || !ordered.every((c, i) => c.index === i + 1 && c.total === first.total)) {
    return { ok: false, code: "INCOMPLETE", received: ordered.length, total: first.total };
  }
  const full = ordered.map((c) => c.content).join("");
  if (sha256(full) !== first.contentSha256) return { ok: false, code: "ARTIFACT_HASH_MISMATCH" };
  return { ok: true, content: full };
}

function mkChunks(parts, digest = DIGEST) {
  const full = parts.join("");
  return parts.map((content, i) => ({
    type: "EVIDENCE_CHUNK",
    requestDigest: digest,
    artifactId: "diff/fix.patch",
    path: "diff/fix.patch",
    index: i + 1,
    total: parts.length,
    contentSha256: sha256(full),
    chunkSha256: sha256(content),
    content,
  }));
}

await test("D1 complete ordered chunks verify", () => {
  const r = validateChunks(mkChunks(["ab", "cd"]));
  assert.equal(r.ok, true);
  assert.equal(r.content, "abcd");
});

await test("D2 partial artifact is INCOMPLETE, never evidence", () => {
  const all = mkChunks(["ab", "cd", "ef"]);
  const r = validateChunks(all.slice(0, 2));
  assert.equal(r.ok, false);
  assert.equal(r.code, "INCOMPLETE");
});

await test("D3 tampered chunk fails closed", () => {
  const all = mkChunks(["ab", "cd"]);
  all[1].content = "XX";
  assert.equal(validateChunks(all).code, "CHUNK_HASH_MISMATCH");
});

await test("D4 foreign digest fails closed", () => {
  const all = mkChunks(["ab", "cd"]);
  all[1].requestDigest = "f".repeat(64);
  assert.equal(validateChunks(all).code, "BINDING_MISMATCH");
});

// ---- E. test-local mirror: response binding (§8) + trust levels (§6) ----------
const RESPONSE_VERDICTS = new Set(["PASS", "CHANGES_REQUIRED", "NEEDS_EVIDENCE", "DESIGN_BLOCKED"]);
function validateResponseBinding(resp, expected) {
  const errs = [];
  if (!resp || typeof resp !== "object") return ["not-object"];
  for (const k of ["requestDigest", "repository", "issue", "pullRequest", "headSha", "verdict"]) {
    if (resp[k] === undefined) errs.push("missing:" + k);
  }
  if (errs.length) return errs;
  if (resp.requestDigest !== expected.requestDigest) errs.push("requestDigest");
  if (String(resp.repository).toLowerCase() !== String(expected.repository).toLowerCase()) errs.push("repository");
  if (Number(resp.issue) !== Number(expected.issue)) errs.push("issue");
  if (Number(resp.pullRequest) !== Number(expected.pullRequest)) errs.push("pullRequest");
  if (String(resp.headSha).toLowerCase() !== String(expected.headSha).toLowerCase()) errs.push("headSha");
  if (!RESPONSE_VERDICTS.has(resp.verdict)) errs.push("verdict");
  return errs;
}

function classifyTrust(ev) {
  if (ev.immutableCiRef && ev.headSha && ev.command && Number.isInteger(ev.exitCode)) return "A";
  if (ev.freshRun && ev.headSha && ev.command && Number.isInteger(ev.exitCode) && ev.rawLog) return "B";
  if (ev.summaryOnly || ev.scanOnly) return "C";
  return "D";
}

await test("E1 response binding exact match passes", () => {
  const exp = { requestDigest: DIGEST, repository: "owner/repo", issue: 1, pullRequest: 2, headSha: HEAD };
  assert.deepEqual(validateResponseBinding({ ...exp, verdict: "PASS", findings: [] }, exp), []);
});

await test("E2 stale headSha / wrong digest rejected", () => {
  const exp = { requestDigest: DIGEST, repository: "owner/repo", issue: 1, pullRequest: 2, headSha: HEAD };
  assert.ok(validateResponseBinding({ ...exp, verdict: "PASS", headSha: BASE }, exp).includes("headSha"));
  assert.ok(validateResponseBinding({ ...exp, verdict: "PASS", requestDigest: "f".repeat(64) }, exp).includes("requestDigest"));
  assert.ok(validateResponseBinding({ ...exp, verdict: "REWORK" }, exp).includes("verdict"));
});

await test("E3 trust levels A/B/C/D classified", () => {
  assert.equal(classifyTrust({ immutableCiRef: "https://ci/run/1", headSha: HEAD, command: "npm test", exitCode: 0 }), "A");
  assert.equal(classifyTrust({ freshRun: true, headSha: HEAD, command: "npm test", exitCode: 1, rawLog: "not ok" }), "B");
  assert.equal(classifyTrust({ summaryOnly: true }), "C");
  assert.equal(classifyTrust({}), "D");
  assert.equal(classifyTrust({ staleLog: true }), "D");
});

// ---- summary ------------------------------------------------------------------
const total = RESULTS.pass + RESULTS.fail;
for (const line of RESULTS.log) console.log(line);
console.log(`final-review-exchange-contract: ${RESULTS.pass}/${total} passed${RESULTS.fail ? ", " + RESULTS.fail + " FAILED" : ""}`);
// Limitation (ghi rõ theo task §14.9): repo có cơ chế test contract (tests/*.test.mjs)
// nên policy test này kiểm tra document + mirror validators; KHÔNG tạo parser/production
// validator phức tạp, KHÔNG chạy live smoke Web2API/CWA, KHÔNG tạo ZIP minh họa.
process.exit(RESULTS.fail === 0 ? 0 : 1);
