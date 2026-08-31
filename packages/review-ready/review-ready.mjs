#!/usr/bin/env node
// review-ready.mjs — Soc_brain: additive review-ready projection (shared package).
//
// Sau khi canonical handoff validate thành công (report READY_FOR_REVIEW theo Issue #32
// REVIEW HANDOFF CONTRACT), sinh ephemeral file:
//   <repo>_Issue-<n>_PR-<n>_<shortHEAD>_review-ready.md
// viết NGOÀI repo/worktree (mặc định ~/.soc-brain/review-ready/), dùng cho final response
// và Telegram. Nội dung là projection từ CHÍNH canonical evidence (không re-fetch GitHub).
//
// Additive & fail-closed:
//   - KHÔNG sửa schema, validator, approval logic, GitHub state machine hay contract.
//   - Report không READY_FOR_REVIEW / identity thiếu hoặc sai dạng → { ok:false, errors },
//     KHÔNG sinh file (không mutation mới khi dữ liệu không đáng tin).
//   - outputDir nằm trong worktreePath (nếu truyền) → fail-closed, không ghi.
// Canonical handoff/report vẫn là SSOT; file này là runtime artifact ephemeral.
//
// Không có upstream source: đây là primitive mới của Soc_brain (không port từ AI_PR_REVIEWER).
// Validator canonical nằm tại AI_PR_REVIEWER (scripts/review-handoff-contract.mjs) — package
// này tự chứa gate fail-closed tối thiểu tại ranh giới sinh file, không import lại validator.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isInside } from "../temp-hygiene/temp-hygiene.mjs";

export const CONTRACT_VERSION = "1.0.0";
export const TERMINAL_READY = "READY_FOR_REVIEW";

// Nơi ghi mặc định — ngoài repo/worktree, cùng root runtime với temp-hygiene DEFAULT_TEMP_ROOT.
export const DEFAULT_REVIEW_READY_DIR = () => join(homedir(), ".soc-brain", "review-ready");

const HEAD_SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
// repository phải dạng owner/name (cùng chuẩn validateCanonicalRef của contract).
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// filename sau khi sanitize phải khớp (chặn path traversal/separator).
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// ---- identity gate (fail-closed) ---------------------------------------------
// Chỉ nhận identity đúng canonical shape; mọi lỗi → trả errors, không sinh file.
// Report đã được server verify (verifyHandoffIdentity) trước khi tới đây; gate này là
// phòng thủ tầng 2 tại ranh giới sinh file.
function extractIdentity(report) {
  const id = report && typeof report === "object" ? report.identity : null;
  if (!id || typeof id !== "object" || Array.isArray(id)) {
    return { ok: false, errors: [{ code: "IDENTITY_MISSING", section: "identity", field: null, message: "handoffReport.identity bắt buộc (object)" }] };
  }
  const errors = [];
  const repository = id.repository;
  if (typeof repository !== "string" || !REPO_RE.test(repository)) {
    errors.push({ code: "IDENTITY_REPO_INVALID", section: "identity", field: "repository", message: `repository phải dạng owner/name: ${String(repository)}` });
  }
  const issue = Number(id.issue);
  if (!Number.isInteger(issue) || issue <= 0) {
    errors.push({ code: "IDENTITY_ISSUE_INVALID", section: "identity", field: "issue", message: `issue phải là số dương: ${String(id.issue)}` });
  }
  const pr = Number(id.pullRequest);
  if (!Number.isInteger(pr) || pr <= 0) {
    errors.push({ code: "IDENTITY_PR_INVALID", section: "identity", field: "pullRequest", message: `pullRequest phải là số dương: ${String(id.pullRequest)}` });
  }
  const headSha = id.headSha;
  if (typeof headSha !== "string" || !HEAD_SHA_RE.test(headSha)) {
    errors.push({ code: "IDENTITY_HEAD_SHA_INVALID", section: "identity", field: "headSha", message: `headSha phải là full 40-hex: ${String(headSha)}` });
  }
  return {
    ok: errors.length === 0,
    errors,
    identity: { repository, issue, pr, headSha, branch: id.branch, baseSha: id.baseSha, prState: id.prState },
  };
}

// repo slug cho filename: `owner/name` → `owner_name` (bỏ path separator/traversal).
function repoToSlug(repo) {
  return String(repo).replace(/\//g, "_").replace(/[^A-Za-z0-9._-]+/g, "_");
}

// Filename theo spec: <repo>_Issue-<n>_PR-<n>_<shortHEAD>_review-ready.md
export function buildReviewReadyFilename({ repo, issue, pr, headSha } = {}) {
  const slug = repoToSlug(repo);
  const n = Number(issue);
  const p = Number(pr);
  const h = String(headSha || "").slice(0, 7);
  if (!slug || !Number.isInteger(n) || n <= 0 || !Number.isInteger(p) || p <= 0 || !/^[0-9a-f]{7}$/.test(h)) return null;
  const name = `${slug}_Issue-${n}_PR-${p}_${h}_review-ready.md`;
  return FILENAME_RE.test(name) && !name.includes("..") ? name : null;
}

// ---- rendering ----------------------------------------------------------------
function fmt(value) {
  if (value === undefined || value === null) return "-";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.length ? value.map((v) => (typeof v === "object" && v ? JSON.stringify(v) : String(v))).join(", ") : "(none)";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function renderFields(obj) {
  return Object.entries(obj).map(([k, v]) => `- ${k}: ${fmt(v)}`);
}

function renderItems(items) {
  const arr = Array.isArray(items) ? items : [];
  if (arr.length === 0) return ["- (none)"];
  return arr.map((it, i) => {
    if (it === null || typeof it !== "object") return `- ${i + 1}. ${fmt(it)}`;
    return `- ${i + 1}. ${Object.entries(it).map(([k, v]) => `${k}=${fmt(v)}`).join(" · ")}`;
  });
}

const SECTION_ORDER = ["scope", "codeEvidence", "findingResolution", "tests", "verification", "safety", "unverifiedRisks", "delivery"];
const SECTION_TITLES = {
  scope: "Scope",
  codeEvidence: "Code evidence",
  findingResolution: "Finding resolution",
  tests: "Tests",
  verification: "Verification",
  safety: "Safety and mutation analysis",
  unverifiedRisks: "Unverified risks",
  delivery: "Delivery",
};

export function renderReviewReady(report, { digest = null } = {}) {
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    return { ok: false, errors: [{ code: "INVALID_REPORT", section: null, field: null, message: "Report không phải object" }] };
  }
  const ts = report.terminalStatus && report.terminalStatus.status;
  if (ts !== TERMINAL_READY) {
    return { ok: false, errors: [{ code: "NOT_READY_FOR_REVIEW", section: "terminalStatus", field: "status", message: `Chỉ sinh review-ready khi terminalStatus=${TERMINAL_READY} (hiện tại: ${String(ts)})` }] };
  }
  if (digest !== null && digest !== undefined && !DIGEST_RE.test(digest)) {
    return { ok: false, errors: [{ code: "DIGEST_INVALID", section: null, field: null, message: "digest phải là sha256 hex 64 ký tự" }] };
  }
  const gate = extractIdentity(report);
  if (!gate.ok) return { ok: false, errors: gate.errors };

  const { repository, issue, pr, headSha, branch, baseSha, prState } = gate.identity;
  const filename = buildReviewReadyFilename({ repo: repository, issue, pr, headSha });
  if (!filename) {
    return { ok: false, errors: [{ code: "FILENAME_INVALID", section: "identity", field: null, message: "Không build được filename an toàn từ identity" }] };
  }

  const lines = [];
  lines.push(`# Review Ready — ${repository} Issue #${issue} · PR #${pr}`);
  lines.push("");
  lines.push(`> Projection từ canonical handoff evidence — REVIEW HANDOFF CONTRACT v${CONTRACT_VERSION}. Canonical report/digest là SSOT duy nhất; file này là runtime artifact ephemeral cho final response/Telegram.`);
  lines.push("");
  lines.push("## Identity");
  lines.push(`- repository: ${repository}`);
  lines.push(`- issue: ${issue}`);
  lines.push(`- pullRequest: ${pr}`);
  lines.push(`- branch: ${fmt(branch)}`);
  lines.push(`- headSha: ${headSha} (short ${headSha.slice(0, 7)})`);
  lines.push(`- baseSha: ${fmt(baseSha)}`);
  lines.push(`- prState: ${fmt(prState)}`);
  if (digest) lines.push(`- reportDigest: ${digest}`);
  lines.push("");
  for (const id of SECTION_ORDER) {
    const sec = report[id];
    lines.push(`## ${SECTION_TITLES[id]}`);
    if (!sec || typeof sec !== "object" || Array.isArray(sec)) {
      lines.push("- (missing/invalid section in canonical evidence)");
      lines.push("");
      continue;
    }
    const { items, ...fields } = sec;
    if (items !== undefined) lines.push(...renderItems(items));
    if (Object.keys(fields).length) lines.push(...renderFields(fields));
    lines.push("");
  }
  lines.push("## Terminal status");
  lines.push(`- status: **${TERMINAL_READY}**`);
  lines.push("");
  return { ok: true, content: lines.join("\n"), filename, repo: repository, issue, pr, headSha };
}

// Ghi file ngoài worktree. outputDir mặc định ~/.soc-brain/review-ready/. Nếu worktreePath
// được truyền và outputDir nằm trong đó → fail-closed, không ghi.
export function writeReviewReady(report, { outputDir = null, worktreePath = null, digest = null } = {}) {
  const rendered = renderReviewReady(report, { digest });
  if (!rendered.ok) return rendered;
  const dir = resolve(outputDir ?? DEFAULT_REVIEW_READY_DIR());
  if (worktreePath && (isInside(worktreePath, dir) || resolve(worktreePath) === dir)) {
    return { ok: false, errors: [{ code: "OUTPUT_INSIDE_WORKTREE", section: null, field: null, message: `outputDir nằm trong worktree → từ chối ghi: ${dir}` }] };
  }
  try {
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, rendered.filename);
    writeFileSync(filePath, rendered.content, "utf8");
    return { ok: true, content: rendered.content, filePath, filename: rendered.filename, repo: rendered.repo, issue: rendered.issue, pr: rendered.pr, headSha: rendered.headSha };
  } catch (err) {
    return { ok: false, errors: [{ code: "WRITE_FAILED", section: null, field: null, message: err.message }] };
  }
}