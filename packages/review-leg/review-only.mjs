#!/usr/bin/env node
// review-only.mjs — REVIEW-ONLY OpenCode execution role (Issue #3, OCR migration).
//
// Production PRE_REVIEWING leg, wired into the control loop via
// packages/control-loop/review-leg-adapter.mjs (Issue #4C). Gemini critical
// path, GPT authority, FSM, resume and delivery semantics are UNCHANGED by
// this module (it produces informational evidence only; sole verdict authority
// stays with GPT final review).
//
// Enforcement architecture (runtime/capability boundaries, NOT prompt-only):
//   1. Review-only opencode.json projection written into a DISPOSABLE snapshot
//      worktree ONLY (never the task worktree / main checkout):
//      edit:deny + bash:deny at config level (same enforcement class as the
//      existing external_directory:deny hard boundary; headless OpenCode
//      auto-rejects non-allowed tools), read/glob/grep/list/skill allow,
//      task deny (no subagents: the child never needs to delegate),
//      webfetch/websearch deny, external_directory deny, secret read denies,
//      and NO `mcp` section at all.
//   2. No broker transport: with no `mcp` section the review child has NO
//      soc_broker_* tools, so commit/finish/block/human-gate/progress are
//      structurally unavailable (not merely unprompted).
//   3. No session authority: the child env is the bounded allowlist WITHOUT
//      any SOC_SESSION_*/SOC_LANE_ID values, so even a hypothetical transport
//      could not obtain loop mutation authority. The host model provider key
//      (e.g. NINE_ROUTER_API_KEY) still passes through so the semantic review
//      can run.
//   4. TARGET-pinning by construction: the snapshot is `git worktree add
//      --detach <snap> <headSha>` — exactly the committed headSha content.
//      Dirty task-worktree content is NEVER copied. Range context
//      (baseSha..headSha) is materialized by DETERMINISTIC Node git readers
//      (fixed argv, no shell) in the control checkout; the model never runs
//      git itself (bash denied).
//   5. OCR delegate preview/rule run by deterministic Node code (fixed argv,
//      no shell, no LLM), never by the model. The model supplies ONLY semantic
//      content ({reviewedFiles, findings, reflectionCompleted}); binding,
//      target, ocr provenance and scope are launcher-owned and assembled here.
//      Full evidence is gated by the Issue-2 strict validator: any failure is
//      fail-closed with NO fabricated evidence.
//   6. This module never imports taskFinish/taskBlock/delivery/terminalize,
//      never touches sessions/ledgers/tokens, never spawns a shell, never
//      fetches the network.
//
// Authority note: PASS/REWORK/BLOCKED stays SOLELY with GPT-5.6 Sol final
// review. This leg produces informational evidence only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildChildEnv, resolveOpenCodeExecutable } from '../executor-launcher/executor-launcher.mjs';
import {
  validateReviewEvidence,
  REVIEW_EVIDENCE_SOURCE,
} from '../control-loop/review-delegate-evidence.mjs';

export const REVIEW_LEG_SCHEMA_VERSION = '1';
export const REVIEW_AGENT = 'plan';
export const REVIEW_INSTRUCTION_MAX_BYTES = 8192;
export const REVIEW_DIFF_MAX_BYTES = 64 * 1024;
export const REVIEW_RULES_MAX_CHARS = 16 * 1024;
export const REVIEW_SPAWN_TIMEOUT_MS = 10 * 60 * 1000;
// Leg-level aggregate findings bound (F1): the old Gemini path bounded model
// findings post-validation; the v1 validator stays pure closed-world, so the
// bound lives here — before evidence is assembled, persisted or forwarded.
// No truncation, no silent drop: over-bound fails closed.
export const REVIEW_MAX_FINDINGS = 500;
export const OCR_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+._A-Za-z0-9]*)$/;
export const OCR_VERSION_OUTPUT_RE = /open-code-review\s+v([0-9]+\.[0-9]+\.[0-9]+(?:[-+._A-Za-z0-9]*))/i;
const SHA40_RE = /^[0-9a-f]{40}$/i;
const IDENTITY_HASH_RE = /^[0-9a-f]{32}$/i;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MODEL_RE = /^[A-Za-z0-9._/-]{1,120}$/;
const REVIEWER_RESULT_KEYS = Object.freeze(['reviewedFiles', 'findings', 'reflectionCompleted']);

function fail(code, detail) { return { ok: false, code, detail: detail ?? null }; }

// Best-effort, non-authoritative telemetry sink: { record(event, detail) }.
// A throwing/missing sink must never change the result.
function tele(sink, event, detail) {
  try {
    if (sink && typeof sink.record === 'function') sink.record(event, detail);
  } catch { /* telemetry never breaks the review leg */ }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---- 1. Review-only opencode.json projection --------------------------------
// allow = read-only discovery + skill (read-only content). task is DENIED:
// the review child never needs subagents to complete semantic review, and no
// unneeded capability is kept. deny = every mutation/network surface. No `mcp`
// key: the broker transport does not exist for the review child.
export function buildReviewOnlyConfig() {
  return {
    $schema: 'https://opencode.ai/config.json',
    permission: {
      bash: 'deny',
      edit: 'deny',
      read: {
        '*': 'allow',
        '*.env': 'deny',
        '*.env.*': 'deny',
        '*.env.example': 'allow',
        '*.pem': 'deny',
        '*.key': 'deny',
      },
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      skill: 'allow',
      task: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      external_directory: 'deny',
    },
  };
}

// Preflight (pure, fail-closed): the projection on disk must be EXACTLY the
// review surface. Coding profiles (edit/bash allow), wildcard-ask profiles
// and any broker tool keys fail BEFORE spawn.
export function evaluateReviewOnlyCapabilities(config) {
  const perm = config && typeof config === 'object' ? config.permission : null;
  if (!perm || typeof perm !== 'object') return fail('REVIEW_PREFLIGHT_FAILED', 'permission block missing');
  if (perm.bash !== 'deny') return fail('REVIEW_PREFLIGHT_FAILED', 'bash must be deny');
  if (perm.edit !== 'deny') return fail('REVIEW_PREFLIGHT_FAILED', 'edit must be deny');
  if (perm.external_directory !== 'deny') return fail('REVIEW_PREFLIGHT_FAILED', 'external_directory must be deny');
  const allows = (v) => v === 'allow' || (isPlainObject(v) && v['*'] === 'allow');
  for (const k of ['read', 'glob', 'grep', 'list', 'skill']) {
    if (!allows(perm[k])) return fail('REVIEW_PREFLIGHT_FAILED', `${k} must be allow`);
  }
  for (const k of ['webfetch', 'websearch', 'task']) {
    if (perm[k] !== 'deny') return fail('REVIEW_PREFLIGHT_FAILED', `${k} must be deny`);
  }
  if ('mcp' in config) return fail('REVIEW_PREFLIGHT_FAILED', 'mcp section forbidden in review projection');
  for (const k of Object.keys(perm)) {
    if (k.startsWith('soc-brain_soc_broker_') || k.startsWith('soc_')) {
      return fail('REVIEW_PREFLIGHT_FAILED', `broker tool key forbidden: ${k}`);
    }
  }
  return { ok: true };
}

export function readReviewConfig({ snapshotPath }) {
  const p = path.join(path.resolve(snapshotPath), 'opencode.json');
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (e) { return fail('REVIEW_CONFIG_FAILED', `read failed: ${String((e && e.message) || e)}`); }
  try {
    const config = JSON.parse(raw);
    if (!isPlainObject(config)) return fail('REVIEW_CONFIG_FAILED', 'config is not an object');
    return { ok: true, config, path: p };
  } catch (e) { return fail('REVIEW_CONFIG_FAILED', `parse failed: ${String((e && e.message) || e)}`); }
}

// ---- 2. Review launch argv (pure; data-only) --------------------------------
// Fixed supported interface. --agent plan: the native read-only agent PLUS the
// deny projection (defense in depth). Never --auto. Instruction is DATA: a
// single argv element, shell-less spawn.
export function buildReviewArgv({ instruction, model = null, agent = REVIEW_AGENT } = {}) {
  if (typeof instruction !== 'string' || !instruction.trim()) {
    return fail('REVIEW_INSTRUCTION_INVALID', 'instruction must be a non-empty string');
  }
  const bytes = Buffer.byteLength(instruction, 'utf8');
  if (bytes > REVIEW_INSTRUCTION_MAX_BYTES) {
    return fail('REVIEW_INSTRUCTION_INVALID', `instruction exceeds ${REVIEW_INSTRUCTION_MAX_BYTES} bytes (${bytes})`);
  }
  if (typeof agent !== 'string' || !agent.trim() || agent.length > 120) {
    return fail('REVIEW_INSTRUCTION_INVALID', 'agent must be a non-empty string');
  }
  if (model !== null && !(typeof model === 'string' && MODEL_RE.test(model))) {
    return fail('REVIEW_INSTRUCTION_INVALID', 'model malformed');
  }
  const argv = ['run', '--format', 'json', '--agent', agent, '--print-logs', '--log-level', 'INFO'];
  if (model) argv.push('--model', model);
  argv.push(instruction);
  return { ok: true, argv };
}

// ---- 3. Deterministic OCR delegate readers ----------------------------------
// Fixed argv, no shell, no LLM, no provider flags. The `ocr review` / `ocr llm`
// orchestrator surface is NEVER invoked by this leg.
//
// Executable resolution: on Windows the `ocr` entry is commonly an npm shim
// (`ocr.ps1`/`.cmd`) that Node cannot spawn shell-less (same class as the
// opencode 1.18.18-shadowing bug). resolveOcrExecutable therefore prefers a
// real executable and falls back to `node <global>/ocr.js` with an argv
// prefix. An `ocr` value is always { exe, prefix } after normalizeOcr.
export function normalizeOcr(ocr) {
  if (typeof ocr === 'string') return { exe: ocr, prefix: [] };
  if (isPlainObject(ocr) && typeof ocr.exe === 'string' && Array.isArray(ocr.prefix)) {
    return { exe: ocr.exe, prefix: [...ocr.prefix] };
  }
  return null;
}

function ocrJsCandidates({ env = process.env } = {}) {
  const out = [];
  const nodeDir = path.dirname(process.execPath);
  out.push(path.join(nodeDir, 'node_modules', '@alibaba-group', 'open-code-review', 'bin', 'ocr.js'));
  if (env.APPDATA) out.push(path.join(env.APPDATA, 'npm', 'node_modules', '@alibaba-group', 'open-code-review', 'bin', 'ocr.js'));
  return out;
}

export function resolveOcrExecutable({ env = process.env, exec = execFileSync, exists = fs.existsSync } = {}) {
  if (env.SOC_OCR_BIN && typeof env.SOC_OCR_BIN === 'string' && env.SOC_OCR_BIN.trim()) {
    if (exists(env.SOC_OCR_BIN)) return { ok: true, ocr: { exe: env.SOC_OCR_BIN, prefix: [] }, source: 'env:SOC_OCR_BIN' };
    return fail('REVIEW_OCR_UNAVAILABLE', 'SOC_OCR_BIN does not exist');
  }
  try {
    const probe = String(exec('ocr', ['version'], { encoding: 'utf8', timeout: 15000, windowsHide: true }) || '');
    if (OCR_VERSION_OUTPUT_RE.test(probe)) return { ok: true, ocr: { exe: 'ocr', prefix: [] }, source: 'path' };
  } catch { /* fall through to node+ocr.js */ }
  for (const js of ocrJsCandidates({ env })) {
    try {
      if (exists(js)) return { ok: true, ocr: { exe: process.execPath, prefix: [js] }, source: 'node:ocr.js' };
    } catch { /* next candidate */ }
  }
  return fail('REVIEW_OCR_UNAVAILABLE', 'ocr binary not found (no PATH exe, no SOC_OCR_BIN, no global ocr.js)');
}

export function ocrPreviewArgv({ ocr = 'ocr', ocrBin, repo, from, to }) {
  const o = normalizeOcr(ocrBin !== undefined ? ocrBin : ocr);
  return [o.exe, [...o.prefix, 'delegate', 'preview', '--from', from, '--to', to, '-f', 'json', '--color', 'never', '--repo', repo]];
}

export function ocrRuleArgv({ ocr = 'ocr', ocrBin, repo, from, to, paths }) {
  const o = normalizeOcr(ocrBin !== undefined ? ocrBin : ocr);
  return [o.exe, [...o.prefix, 'delegate', 'rule', ...paths, '--from', from, '--to', to, '-f', 'json', '--color', 'never', '--repo', repo]];
}

function runJsonCmd({ exec, exe, args, timeoutMs = 60000, maxBytes = 4 * 1024 * 1024 }) {
  let raw;
  try {
    raw = exec(exe, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: maxBytes + 1, windowsHide: true });
  } catch (e) {
    return { ok: false, exit: e, raw: String((e && e.stdout) || '') };
  }
  return { ok: true, raw: String(raw == null ? '' : raw) };
}

function isValidEvidencePath(p) {
  if (typeof p !== 'string' || !p.trim() || p !== p.trim() || p.includes('\0')) return false;
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p) || p.includes('\\')) return false;
  if (p === '.' || p.startsWith('./') || p.startsWith('../')) return false;
  if (p.split('/').some((s) => s === '' || s === '.' || s === '..')) return false;
  return true;
}

export function runOcrPreview({ ocr = 'ocr', ocrBin, repo, from, to, exec = execFileSync } = {}) {
  if (typeof repo !== 'string' || !repo) return fail('REVIEW_PREVIEW_FAILED', 'repo required');
  if (typeof from !== 'string' || !SHA40_RE.test(from)) return fail('REVIEW_PREVIEW_FAILED', 'from must be 40-hex');
  if (typeof to !== 'string' || !SHA40_RE.test(to)) return fail('REVIEW_PREVIEW_FAILED', 'to must be 40-hex');
  const o = normalizeOcr(ocrBin !== undefined ? ocrBin : ocr);
  if (!o) return fail('REVIEW_OCR_UNAVAILABLE', 'ocr executable malformed');
  const [, args] = ocrPreviewArgv({ ocr: o, repo, from, to });
  let r;
  try {
    r = runJsonCmd({ exec, exe: o.exe, args });
  } catch (e) {
    return fail('REVIEW_OCR_UNAVAILABLE', `ocr spawn failed: ${String((e && e.message) || e)}`);
  }
  if (!r.ok) {
    const msg = r.exit && r.exit.code === 'ENOENT' ? 'ocr binary not found' : `exit ${String((r.exit && r.exit.status) ?? r.exit)}`;
    return fail(r.exit && r.exit.code === 'ENOENT' ? 'REVIEW_OCR_UNAVAILABLE' : 'REVIEW_PREVIEW_FAILED', msg);
  }
  let obj;
  try {
    obj = JSON.parse(r.raw);
  } catch (e) {
    return fail('REVIEW_PREVIEW_MALFORMED', `preview JSON parse failed: ${String((e && e.message) || e)}`);
  }
  if (!isPlainObject(obj)) return fail('REVIEW_PREVIEW_MALFORMED', 'preview must be an object');
  if (obj.schema_version !== '1') return fail('REVIEW_PREVIEW_MALFORMED', 'preview schema_version must be "1"');
  if (obj.mode !== 'range') return fail('REVIEW_TARGET_MISMATCH', `preview mode must be range (got ${JSON.stringify(obj.mode)})`);
  if (obj.from !== from || obj.to !== to) {
    return fail('REVIEW_TARGET_MISMATCH', `preview from/to mismatch: ${JSON.stringify(obj.from)}..${JSON.stringify(obj.to)}`);
  }
  const reviewable = obj.reviewable_files;
  const excluded = obj.excluded_files;
  if (!Array.isArray(reviewable) || !Array.isArray(excluded)) {
    return fail('REVIEW_PREVIEW_MALFORMED', 'reviewable_files/excluded_files must be arrays');
  }
  const reviewableFiles = [];
  for (const f of reviewable) {
    if (!isPlainObject(f) || !isValidEvidencePath(f.path)) {
      return fail('REVIEW_PREVIEW_MALFORMED', `reviewable path invalid: ${JSON.stringify(f && f.path)}`);
    }
    reviewableFiles.push(f.path);
  }
  const excludedFiles = [];
  for (const f of excluded) {
    if (!isPlainObject(f) || !isValidEvidencePath(f.path)) {
      return fail('REVIEW_PREVIEW_MALFORMED', `excluded path invalid: ${JSON.stringify(f && f.path)}`);
    }
    if (typeof f.exclude_reason !== 'string' || !f.exclude_reason.trim()) {
      return fail('REVIEW_PREVIEW_MALFORMED', `excluded reason missing: ${f.path}`);
    }
    excludedFiles.push({ path: f.path, reason: f.exclude_reason });
  }
  if (reviewableFiles.length === 0) return fail('REVIEW_SCOPE_EMPTY', 'preview reviewable set is empty; 0/0 is never 100% coverage');
  return { ok: true, value: { reviewableFiles, excludedFiles, mergeBase: obj.merge_base ?? null } };
}

export function runOcrRule({ ocr = 'ocr', ocrBin, repo, from, to, paths, exec = execFileSync } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) return fail('REVIEW_RULE_FAILED', 'paths required');
  const o = normalizeOcr(ocrBin !== undefined ? ocrBin : ocr);
  if (!o) return fail('REVIEW_OCR_UNAVAILABLE', 'ocr executable malformed');
  const [, args] = ocrRuleArgv({ ocr: o, repo, from, to, paths });
  let r;
  try {
    r = runJsonCmd({ exec, exe: o.exe, args });
  } catch (e) {
    return fail('REVIEW_OCR_UNAVAILABLE', `ocr spawn failed: ${String((e && e.message) || e)}`);
  }
  if (!r.ok) {
    const msg = r.exit && r.exit.code === 'ENOENT' ? 'ocr binary not found' : `exit ${String((r.exit && r.exit.status) ?? r.exit)}`;
    return fail(r.exit && r.exit.code === 'ENOENT' ? 'REVIEW_OCR_UNAVAILABLE' : 'REVIEW_RULE_FAILED', msg);
  }
  let obj;
  try {
    obj = JSON.parse(r.raw);
  } catch (e) {
    return fail('REVIEW_RULE_MALFORMED', `rule JSON parse failed: ${String((e && e.message) || e)}`);
  }
  if (!isPlainObject(obj) || !Array.isArray(obj.groups)) {
    return fail('REVIEW_RULE_MALFORMED', 'rule must carry groups[]');
  }
  let text = '';
  for (const g of obj.groups) {
    if (!isPlainObject(g) || typeof g.rule !== 'string') {
      return fail('REVIEW_RULE_MALFORMED', 'rule group malformed');
    }
    text += `\n\n### rule (${g.pattern || g.source || g.group_id}):\n${g.rule}`;
  }
  text = text.trim();
  const truncated = text.length > REVIEW_RULES_MAX_CHARS;
  if (truncated) text = text.slice(0, REVIEW_RULES_MAX_CHARS);
  return { ok: true, value: { ruleGroups: obj.groups.length, rulesText: text, rulesTruncated: truncated, rulesDigest: ocrRulesDigest(obj.groups) } };
}

// ---- 3b. Deterministic OCR rule canonicalization (Issue #4R F01) -------------
// rulesDigest binds the resume cache to the ACTUAL semantic rule payload, not
// just version/count. Canonical form: groups sorted deterministically, each
// carrying only semantic fields (pattern/source/rule + sorted files); object
// key order never affects the digest; telemetry/duration never enters it.
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function canonicalizeOcrRules(groups) {
  if (!Array.isArray(groups)) return null;
  const norm = [];
  for (const g of groups) {
    if (!g || typeof g !== 'object' || typeof g.rule !== 'string') return null;
    const files = Array.isArray(g.files) ? [...g.files].filter((f) => typeof f === 'string').sort() : [];
    norm.push({
      pattern: typeof g.pattern === 'string' ? g.pattern : null,
      source: typeof g.source === 'string' ? g.source : null,
      files,
      rule: g.rule,
    });
  }
  norm.sort((a, b) => stableStringify(a) < stableStringify(b) ? -1 : 1);
  return norm;
}

export function ocrRulesDigest(groups) {
  const canon = canonicalizeOcrRules(groups);
  if (!canon) return null;
  return createHash('sha256').update(stableStringify(canon), 'utf8').digest('hex');
}

export function readOcrVersion({ ocr = 'ocr', ocrBin, exec = execFileSync } = {}) {
  const o = normalizeOcr(ocrBin !== undefined ? ocrBin : ocr);
  if (!o) return fail('REVIEW_OCR_UNAVAILABLE', 'ocr executable malformed');
  let raw;
  try {
    raw = String(exec(o.exe, [...o.prefix, 'version'], { encoding: 'utf8', timeout: 15000, windowsHide: true }) || '');
  } catch (e) {
    if (e && e.code === 'ENOENT') return fail('REVIEW_OCR_UNAVAILABLE', 'ocr binary not found');
    return fail('REVIEW_OCR_UNAVAILABLE', `ocr version failed: ${String((e && e.message) || e)}`);
  }
  const m = raw.match(OCR_VERSION_OUTPUT_RE);
  if (!m || !OCR_VERSION_RE.test(m[1])) return fail('REVIEW_OCR_UNAVAILABLE', 'ocr version unparseable');
  return { ok: true, version: m[1] };
}

// ---- 4. Deterministic read-only git readers ---------------------------------
// Allowlist: diff/show/log/rev-parse only, explicit SHAs, no shell. Every
// other verb (commit/push/merge/reset/checkout/stash/add/...) is rejected by
// construction — there is no code path that can emit it.
const READONLY_GIT_VERBS = Object.freeze(['diff', 'show', 'log', 'rev-parse']);
const GIT_MUTATION_RE = /^(commit|push|merge|reset|checkout|switch|restore|stash|add|rm|mv|clean|rebase|cherry-pick|revert|am|apply|fetch|pull|clone|tag|branch|update-index|read-tree|worktree)$/;

export function isReadOnlyGitArgs(args) {
  if (!Array.isArray(args) || args.length === 0) return false;
  const [verb] = args;
  if (GIT_MUTATION_RE.test(String(verb))) return false;
  return READONLY_GIT_VERBS.includes(String(verb));
}

function runReadOnlyGit({ exec, repo, args, maxBytes }) {
  if (!isReadOnlyGitArgs(args)) return fail('REVIEW_GIT_FORBIDDEN', `git verb forbidden: ${JSON.stringify(args && args[0])}`);
  let raw;
  try {
    raw = exec('git', args, { cwd: repo, encoding: 'utf8', timeout: 60000, maxBuffer: maxBytes + 1, windowsHide: true });
  } catch (e) {
    return fail('REVIEW_GIT_FAILED', String((e && e.message) || e));
  }
  let text = String(raw == null ? '' : raw).replace(/\r\n/g, '\n');
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return fail('REVIEW_DIFF_TOO_LARGE', `range diff exceeds ${maxBytes} bytes; refusing partial review`);
  }
  return { ok: true, text };
}

export function readRangeDiff({ repo, from, to, paths, exec = execFileSync, maxBytes = REVIEW_DIFF_MAX_BYTES } = {}) {
  if (!SHA40_RE.test(from || '') || !SHA40_RE.test(to || '')) return fail('REVIEW_GIT_FAILED', 'from/to must be 40-hex');
  if (!Array.isArray(paths) || paths.length === 0) return fail('REVIEW_GIT_FAILED', 'paths required');
  return runReadOnlyGit({ exec, repo, args: ['diff', '--no-color', from, to, '--', ...paths], maxBytes });
}

export function readRangeFileList({ repo, from, to, exec = execFileSync } = {}) {
  if (!SHA40_RE.test(from || '') || !SHA40_RE.test(to || '')) return fail('REVIEW_GIT_FAILED', 'from/to must be 40-hex');
  const r = runReadOnlyGit({ exec, repo, args: ['diff', '--name-only', from, to, '--'], maxBytes: 1024 * 1024 });
  if (!r.ok) return r;
  return { ok: true, files: r.text.split('\n').map((s) => s.trim()).filter(Boolean) };
}

// ---- 5. Snapshot (TARGET-pinned by construction) ----------------------------
// Disposable detached worktree at EXACTLY headSha. Dirty task-worktree content
// is never copied: the snapshot carries only committed headSha bytes plus the
// review-only opencode.json written by THIS launcher.
export function createReviewSnapshot({ repo, headSha, exec = execFileSync, mkdtemp = fs.mkdtempSync, writeConfig = null } = {}) {
  if (!SHA40_RE.test(headSha || '')) return fail('REVIEW_SNAPSHOT_FAILED', 'headSha must be 40-hex');
  let snap;
  try {
    snap = mkdtemp(path.join(os.tmpdir(), 'soc-review-'));
  } catch (e) {
    return fail('REVIEW_SNAPSHOT_FAILED', `mkdtemp failed: ${String((e && e.message) || e)}`);
  }
  try {
    exec('git', ['worktree', 'add', '--detach', snap, headSha], { cwd: repo, encoding: 'utf8', timeout: 120000, windowsHide: true });
  } catch (e) {
    try { fs.rmSync(snap, { recursive: true, force: true }); } catch { /* best-effort */ }
    return fail('REVIEW_SNAPSHOT_FAILED', `worktree add failed: ${String((e && e.message) || e)}`);
  }
  try {
    const config = buildReviewOnlyConfig();
    if (writeConfig) {
      const w = writeConfig({ snapshotPath: snap, config });
      if (!w || !w.ok) throw new Error((w && (w.detail || w.reason)) || 'writeConfig failed');
    } else {
      fs.writeFileSync(path.join(snap, 'opencode.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    }
  } catch (e) {
    destroyReviewSnapshot({ repo, snap, exec });
    return fail('REVIEW_CONFIG_FAILED', `review projection write failed: ${String((e && e.message) || e)}`);
  }
  return { ok: true, snap };
}

export function destroyReviewSnapshot({ repo, snap, exec = execFileSync } = {}) {
  if (!snap) return { ok: true };
  try {
    exec('git', ['worktree', 'remove', '--force', snap], { cwd: repo, encoding: 'utf8', timeout: 120000, windowsHide: true });
  } catch { /* best-effort: fall through to rm */ }
  try { fs.rmSync(snap, { recursive: true, force: true }); } catch { /* best-effort */ }
  return { ok: true };
}

// ---- 6. Review prompt (advisory contract; enforcement lives in §1-§5) --------
export function buildReviewPrompt({ binding, target, reviewableFiles, excludedFiles, rulesText, rulesTruncated, diffText }) {
  const lines = [
    'You are a REVIEW-ONLY code reviewer. You have NO mutation authority: do not edit, write, commit, push, merge, delegate to subagents, or run shell commands. Read-only inspection only.',
    'Provenance: the review scope and rules below were derived by the trusted deterministic launcher using the Alibaba OCR Delegate CLI (`ocr delegate preview` / `ocr delegate rule`); the delegate skill is NOT a runtime dependency of this review. Do NOT invoke OCR, skills that run commands, LLM review commands, or any model/provider yourself — review ONLY the launcher-provided scope, rules and diff.',
    `Target: ${target.mode} ${target.mode === 'range' ? `${binding.baseSha}..${binding.headSha}` : binding.headSha} in ${binding.repo}#${binding.issueNumber}.`,
    `Review EVERY reviewable file (100% coverage, no skips). Reviewable files (${reviewableFiles.length}):`,
    ...reviewableFiles.map((f) => `- ${f}`),
    `OCR excluded files (do NOT review, already excluded with reason):`,
    ...excludedFiles.map((f) => `- ${f.path} (${f.reason})`),
    rulesTruncated ? 'Resolved OCR rules (TRUNCATED to budget; apply the visible portion):' : 'Resolved OCR rules:',
    rulesText || '(no rules)',
    'Range diff (base..head, read-only context; always read each full file before judging):',
    diffText,
    'Perform semantic review of every reviewable file, then reflect and dedupe overlapping findings.',
    'FINAL MESSAGE CONTRACT: your last message must be EXACTLY one fenced block ```json ... ``` containing ONLY this object shape (no verdict, no metadata, no extra keys):',
    '{"reviewedFiles": ["<every reviewable path>"], "findings": [{"path": "<reviewable path>", "content": "<non-empty>", "startLine": 1, "endLine": 1, "category": "bug|security|performance|maintainability|test|style|documentation|other", "severity": "critical|high|medium|low"}], "reflectionCompleted": true}',
    'startLine/endLine are optional (>=1, startLine<=endLine). reviewedFiles must equal the reviewable set exactly. skippedFiles do not exist: every reviewable file must be reviewed.',
  ];
  return lines.join('\n');
}

// ---- 6b. Deterministic batching (Issue #4B) -----------------------------------
// Windows CreateProcess argv caps (~32KiB) and REVIEW_INSTRUCTION_MAX_BYTES
// mean large diffs can NEVER travel inline. Batches therefore travel as files
// inside the disposable snapshot (.soc-review/): per-file diffs are read
// individually (never truncated: over-bound reads fail closed), packed at
// file boundaries, oversized single files split deterministically by lines
// with explicit path/range provenance. Every batch is reviewed by its own
// child run; a final reflection run dedupes aggregate findings before the
// Issue-2 gate. Any batch failure fails the whole leg; no partial evidence
// is ever forwarded.
export const REVIEW_BATCH_MAX_BYTES = 48 * 1024;
export const REVIEW_TOTAL_DIFF_MAX_BYTES = 512 * 1024;
export const REVIEW_MAX_BATCHES = 16;
export const REVIEW_CONTEXT_DIR = '.soc-review';

export function readFileDiff({ repo, from, to, file, exec = execFileSync, maxBytes = REVIEW_TOTAL_DIFF_MAX_BYTES } = {}) {
  if (!SHA40_RE.test(from || '') || !SHA40_RE.test(to || '')) return fail('REVIEW_GIT_FAILED', 'from/to must be 40-hex');
  if (typeof file !== 'string' || !file) return fail('REVIEW_GIT_FAILED', 'file required');
  return runReadOnlyGit({ exec, repo, args: ['diff', '--no-color', from, to, '--', file], maxBytes });
}

// Pure planner: greedy file-boundary packing by bytes (input sorted by path
// for determinism). SINGLE SOURCE OF TRUTH (F2): an oversized file is split
// by the SAME chunkDiffText the execution consumes — the planner materializes
// actual chunks (with text) instead of estimating a count via ceil, so plan
// and execution can never disagree. Oversized entries without text fail
// closed; there is no estimate fallback.
export function planReviewBatches(fileDiffs) {
  if (!Array.isArray(fileDiffs) || fileDiffs.length === 0) return fail('REVIEW_BATCH_FAILED', 'fileDiffs required');
  const sorted = [...fileDiffs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const batches = [];
  let cur = { files: [], bytes: 0 };
  const flush = () => { if (cur.files.length !== 0) { batches.push(cur); cur = { files: [], bytes: 0 }; } };
  for (const f of sorted) {
    if (typeof f.path !== 'string' || !Number.isInteger(f.bytes) || f.bytes < 0) {
      return fail('REVIEW_BATCH_FAILED', 'fileDiff entry malformed');
    }
    if (f.bytes > REVIEW_BATCH_MAX_BYTES) {
      if (typeof f.text !== 'string') {
        return fail('REVIEW_BATCH_FAILED', `oversized file requires text for deterministic chunking: ${f.path}`);
      }
      flush();
      const chunks = chunkDiffText(f.text, REVIEW_BATCH_MAX_BYTES);
      for (let i = 0; i < chunks.length; i++) {
        batches.push({
          files: [{ path: f.path, chunkIndex: i, chunks: chunks.length }],
          bytes: Buffer.byteLength(chunks[i], 'utf8'),
          chunked: true,
          chunkText: chunks[i],
        });
      }
      continue;
    }
    if (cur.bytes + f.bytes > REVIEW_BATCH_MAX_BYTES) flush();
    cur.files.push({ path: f.path });
    cur.bytes += f.bytes;
  }
  flush();
  if (batches.length > REVIEW_MAX_BATCHES) {
    return fail('REVIEW_BATCH_LIMIT_EXCEEDED', `${batches.length} batches exceed limit ${REVIEW_MAX_BATCHES}; refusing unbounded review`);
  }
  return { ok: true, batches };
}

// Deterministic line-split of one file diff into byte-bounded chunks.
export function chunkDiffText(text, maxBytes) {
  const lines = String(text == null ? '' : text).split('\n');
  const chunks = [];
  let cur = [];
  let curBytes = 0;
  for (const ln of lines) {
    const lb = Buffer.byteLength(ln, 'utf8') + 1;
    if (cur.length !== 0 && curBytes + lb > maxBytes) {
      chunks.push(cur.join('\n'));
      cur = [];
      curBytes = 0;
    }
    cur.push(ln);
    curBytes += lb;
  }
  if (cur.length !== 0) chunks.push(cur.join('\n'));
  return chunks.length === 0 ? [''] : chunks;
}

function setsEqual(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function writeContextFile(snap, rel, content) {
  const full = path.join(snap, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return rel;
}

export function buildBatchPrompt({ binding, target, batchFiles, batchLabel, diffRel, rulesRel, excludedFiles, remainingCount }) {
  const lines = [
    'You are a REVIEW-ONLY code reviewer. You have NO mutation authority: do not edit, write, commit, push, merge, delegate to subagents, or run shell commands. Read-only inspection only.',
    'Provenance: the review scope and rules below were derived by the trusted deterministic launcher using the Alibaba OCR Delegate CLI (`ocr delegate preview` / `ocr delegate rule`); the delegate skill is NOT a runtime dependency of this review. Do NOT invoke OCR, skills that run commands, LLM review commands, or any model/provider yourself — review ONLY the launcher-provided scope, rules and diff.',
    `Target: ${target.mode} ${target.mode === 'range' ? `${binding.baseSha}..${binding.headSha}` : binding.headSha} in ${binding.repo}#${binding.issueNumber}.`,
    `This is batch ${batchLabel} of a deterministically batched review. Review EVERY file listed below (no skips within this batch; ${remainingCount} other file(s) are covered by sibling batches):`,
    ...batchFiles.map((f) => `- ${f}`),
    'OCR excluded files (do NOT review, already excluded with reason):',
    ...excludedFiles.map((f) => `- ${f.path} (${f.reason})`),
    `Resolved OCR rules: read ${rulesRel} (launcher-derived, read-only context).`,
    `Batch diff context: read ${diffRel} (read-only; always read each full file before judging).`,
    'Perform semantic review of every batch file, then reflect and dedupe overlapping findings within this batch.',
    'FINAL MESSAGE CONTRACT: your last message must be EXACTLY one fenced block ```json ... ``` containing ONLY this object shape (no verdict, no metadata, no extra keys):',
    '{"reviewedFiles": ["<every batch file path>"], "findings": [{"path": "<batch file path>", "content": "<non-empty>", "startLine": 1, "endLine": 1, "category": "bug|security|performance|maintainability|test|style|documentation|other", "severity": "critical|high|medium|low"}], "reflectionCompleted": true}',
    'startLine/endLine are optional (>=1, startLine<=endLine). reviewedFiles must equal the batch file set exactly.',
  ];
  return lines.join('\n');
}

export function buildReflectionPrompt({ binding, target, reviewableFiles, excludedFiles, rulesRel, candidatesRel, batchCount }) {
  const lines = [
    'You are a REVIEW-ONLY code reviewer. You have NO mutation authority: do not edit, write, commit, push, merge, delegate to subagents, or run shell commands. Read-only inspection only.',
    'Provenance: the review scope, rules and candidate findings below were derived by the trusted deterministic launcher (Alibaba OCR Delegate CLI scope/rules + batched sibling reviews); the delegate skill is NOT a runtime dependency of this review. Do NOT invoke OCR, skills that run commands, LLM review commands, or any model/provider yourself.',
    `Target: ${target.mode} ${target.mode === 'range' ? `${binding.baseSha}..${binding.headSha}` : binding.headSha} in ${binding.repo}#${binding.issueNumber}.`,
    `This is the FINAL reflection over ${batchCount} deterministically batched sibling reviews. Review EVERY reviewable file (${reviewableFiles.length}, 100% coverage, no skips):`,
    ...reviewableFiles.map((f) => `- ${f}`),
    'OCR excluded files (do NOT review, already excluded with reason):',
    ...excludedFiles.map((f) => `- ${f.path} (${f.reason})`),
    `Resolved OCR rules: read ${rulesRel}.`,
    `Candidate findings from sibling batches: read ${candidatesRel}. Dedupe overlaps, drop findings refuted by full-file reads, keep the rest verbatim where still valid.`,
    'FINAL MESSAGE CONTRACT: your last message must be EXACTLY one fenced block ```json ... ``` containing ONLY this object shape (no verdict, no metadata, no extra keys):',
    '{"reviewedFiles": ["<every reviewable path>"], "findings": [{"path": "<reviewable path>", "content": "<non-empty>", "startLine": 1, "endLine": 1, "category": "bug|security|performance|maintainability|test|style|documentation|other", "severity": "critical|high|medium|low"}], "reflectionCompleted": true}',
    'reviewedFiles must equal the reviewable set exactly. skippedFiles do not exist: every reviewable file must be reviewed.',
  ];
  return lines.join('\n');
}

// One child run: spawn + parse + shape-check. Returns {ok, reviewerResult}
// or a fail-closed REVIEW_* result. Never fabricates.
function spawnReviewerStep({ instruction, model, snap, ex, spawnReview, timeoutMs, env, phase }) {
  if (Buffer.byteLength(instruction, 'utf8') > REVIEW_INSTRUCTION_MAX_BYTES) {
    return fail('REVIEW_INSTRUCTION_INVALID', `${phase}: instruction exceeds budget; refusing partial-scope review`);
  }
  const av = buildReviewArgv({ instruction, model });
  if (!av.ok) return av;
  let out;
  try {
    out = spawnReview(ex.executable, av.argv, {
      cwd: snap,
      env: buildChildEnv(env),
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    });
  } catch (e) {
    return fail('REVIEW_SPAWN_FAILED', `${phase}: ${String((e && e.message) || e)}`);
  }
  if (out && out.error && (out.error.code === 'ETIMEDOUT' || out.status === null)) {
    // F3: stdout overflow (ENOBUFS) is NOT a timeout — explicit fail-closed
    // code, no evidence either way.
    if (out.error.code === 'ENOBUFS') {
      return fail('REVIEW_OUTPUT_OVERFLOW', `${phase}: reviewer output exceeded the process buffer; refusing truncated parse`);
    }
    return fail('REVIEW_TIMEOUT', `${phase}: review run exceeded ${timeoutMs}ms`);
  }
  if (!out || out.status !== 0) {
    return fail(phase === 'review' ? 'REVIEW_EXIT_NONZERO' : 'REVIEW_BATCH_FAILED', `${phase}: exit ${out && out.status} ${String((out && out.stderr) || '').slice(0, 500)}`);
  }
  const jb = extractLastJsonBlock(collectTextEvents(out.stdout));
  if (!jb.ok) return jb;
  const ck = checkReviewerResult(jb.value);
  if (!ck.ok) return ck;
  return { ok: true, reviewerResult: jb.value };
}

// ---- 7. Reviewer-result parser (model supplies SEMANTICS only) --------------
export function extractLastJsonBlock(text) {
  const s = String(text == null ? '' : text);
  const fenceRe = /```json\s*([\s\S]*?)```/gi;
  let m;
  let last = null;
  while ((m = fenceRe.exec(s)) !== null) last = m[1];
  if (last === null) return fail('REVIEW_RESULT_MALFORMED', 'no fenced ```json block in reviewer output');
  try {
    return { ok: true, value: JSON.parse(last) };
  } catch (e) {
    return fail('REVIEW_RESULT_MALFORMED', `reviewer JSON parse failed: ${String((e && e.message) || e)}`);
  }
}

export function checkReviewerResult(obj) {
  if (!isPlainObject(obj)) return fail('REVIEW_RESULT_MALFORMED', 'reviewer result must be an object');
  if ('verdict' in obj) return fail('REVIEW_RESULT_VERDICT_FORBIDDEN', 'reviewer must never emit verdict');
  if ('metadata' in obj) return fail('REVIEW_RESULT_MALFORMED', 'reviewer must never emit metadata');
  const unknown = Object.keys(obj).filter((k) => !REVIEWER_RESULT_KEYS.includes(k));
  if (unknown.length !== 0) return fail('REVIEW_RESULT_MALFORMED', `unknown reviewer keys: ${unknown.sort().join(',')}`);
  if (!Array.isArray(obj.reviewedFiles)) return fail('REVIEW_RESULT_MALFORMED', 'reviewedFiles must be an array');
  if (!Array.isArray(obj.findings)) return fail('REVIEW_RESULT_MALFORMED', 'findings must be an array');
  if (obj.reflectionCompleted !== true) return fail('REVIEW_RESULT_MALFORMED', 'reflectionCompleted must be true');
  return { ok: true };
}

// ---- 8. Evidence assembly (launcher-owned provenance + Issue-2 gate) ---------
export function assembleReviewEvidence({ binding, target, ocr, reviewableFiles, excludedFiles, reviewerResult, durationMs }) {
  if (!isPlainObject(binding)) return fail('REVIEW_EVIDENCE_INVALID', 'binding required');
  for (const f of ['identityHash', 'repo', 'issueNumber', 'baseSha', 'headSha']) {
    if (binding[f] === undefined) return fail('REVIEW_EVIDENCE_INVALID', `binding missing ${f}`);
  }
  if (!isPlainObject(target) || (target.mode !== 'range' && target.mode !== 'commit')) {
    return fail('REVIEW_WORKSPACE_FORBIDDEN', 'target.mode must be range|commit (workspace forbidden)');
  }
  if (!isPlainObject(ocr) || typeof ocr.version !== 'string' || !Number.isInteger(ocr.ruleGroups)) {
    return fail('REVIEW_EVIDENCE_INVALID', 'ocr provenance required');
  }
  if (!Array.isArray(reviewerResult.findings) || reviewerResult.findings.length > REVIEW_MAX_FINDINGS) {
    return fail('REVIEW_EVIDENCE_INVALID', `findings count exceeds leg bound ${REVIEW_MAX_FINDINGS}; refusing unbounded evidence`);
  }
  const evidence = {
    schemaVersion: '1',
    source: REVIEW_EVIDENCE_SOURCE,
    binding: {
      identityHash: binding.identityHash,
      repo: binding.repo,
      issueNumber: binding.issueNumber,
      baseSha: binding.baseSha,
      headSha: binding.headSha,
    },
    target,
    ocr: { version: ocr.version, ruleGroups: ocr.ruleGroups },
    reviewableFiles: [...reviewableFiles],
    excludedFiles: excludedFiles.map((e) => ({ path: e.path, reason: e.reason })),
    reviewedFiles: [...reviewerResult.reviewedFiles],
    skippedFiles: [],
    coverageRate: 1,
    findings: reviewerResult.findings,
    reflectionCompleted: reviewerResult.reflectionCompleted,
    durationMs,
  };
  const v = validateReviewEvidence(evidence, binding);
  if (!v.ok) return fail('REVIEW_EVIDENCE_INVALID', `${v.code}: ${JSON.stringify(v.detail)}`);
  return { ok: true, value: v.value };
}

// ---- 9. Orchestrator (no FSM, no session, no token) --------------------------
export function checkReviewBinding({ repo, issueNumber, identityHash, baseSha, headSha }) {
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) return fail('REVIEW_BINDING_INVALID', 'repo must be owner/name');
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return fail('REVIEW_BINDING_INVALID', 'issueNumber must be positive integer');
  if (typeof identityHash !== 'string' || !IDENTITY_HASH_RE.test(identityHash)) return fail('REVIEW_BINDING_INVALID', 'identityHash must be 32-hex');
  if (typeof baseSha !== 'string' || !SHA40_RE.test(baseSha)) return fail('REVIEW_BINDING_INVALID', 'baseSha must be 40-hex');
  if (typeof headSha !== 'string' || !SHA40_RE.test(headSha)) return fail('REVIEW_BINDING_INVALID', 'headSha must be 40-hex');
  return { ok: true };
}

function collectTextEvents(stdout) {
  const texts = [];
  for (const line of String(stdout == null ? '' : stdout).split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      const part = ev && typeof ev === 'object' ? ev.part : null;
      if (ev && ev.type === 'text' && part && typeof part.text === 'string') texts.push(part.text);
      else if (part && typeof part.text === 'string') texts.push(part.text);
    } catch {
      texts.push(line);
    }
  }
  return texts.join('\n');
}

export function runReviewOnlyLeg({
  repo,
  issueNumber,
  identityHash,
  baseSha,
  headSha,
  targetMode = 'range',
  model = null,
  controlRepo,
  ocrBin,
  ocr,
  resolveOcr = resolveOcrExecutable,
  clock = Date.now,
  exec = execFileSync,
  spawnReview = spawnSync,
  resolveExecutable = resolveOpenCodeExecutable,
  mkdtemp = fs.mkdtempSync,
  timeoutMs = REVIEW_SPAWN_TIMEOUT_MS,
  env = process.env,
  telemetry = null,
} = {}) {
  const t0 = clock();
  const durationMs = () => Math.max(0, clock() - t0);
  const bb = checkReviewBinding({ repo, issueNumber, identityHash, baseSha, headSha });
  if (!bb.ok) return bb;
  if (targetMode !== 'range' && targetMode !== 'commit') return fail('REVIEW_WORKSPACE_FORBIDDEN', 'targetMode must be range|commit');
  if (typeof controlRepo !== 'string' || !controlRepo) return fail('REVIEW_BINDING_INVALID', 'controlRepo required');
  const binding = { identityHash, repo, issueNumber, baseSha, headSha };
  const target = targetMode === 'range'
    ? { mode: 'range', from: baseSha, to: headSha }
    : { mode: 'commit', commit: headSha };

  let ocrVal = ocrBin !== undefined ? normalizeOcr(ocrBin) : (ocr !== undefined ? normalizeOcr(ocr) : null);
  if (!ocrVal) {
    const auto = resolveOcr({ exec, env });
    if (!auto.ok) return auto;
    ocrVal = auto.ocr;
  }
  const ver = readOcrVersion({ ocr: ocrVal, exec });
  if (!ver.ok) return ver;
  const preview = runOcrPreview({ ocr: ocrVal, repo: controlRepo, from: baseSha, to: headSha, exec });
  if (!preview.ok) return preview;
  const { reviewableFiles, excludedFiles } = preview.value;
  const rule = runOcrRule({ ocr: ocrVal, repo: controlRepo, from: baseSha, to: headSha, paths: reviewableFiles, exec });
  if (!rule.ok) return rule;
  // Per-file diffs (never whole-range: over-bound reads fail closed, never
  // truncate). Decides the single inline path vs the batched file-context path.
  const fileDiffs = [];
  let totalDiffBytes = 0;
  for (const f of reviewableFiles) {
    const fd = readFileDiff({ repo: controlRepo, from: baseSha, to: headSha, file: f, exec });
    if (!fd.ok) return fd;
    const bytes = Buffer.byteLength(fd.text, 'utf8');
    totalDiffBytes += bytes;
    fileDiffs.push({ path: f, bytes, text: fd.text });
  }
  if (totalDiffBytes > REVIEW_TOTAL_DIFF_MAX_BYTES) {
    return fail('REVIEW_DIFF_TOO_LARGE', `range diff ${totalDiffBytes} bytes exceeds hard bound ${REVIEW_TOTAL_DIFF_MAX_BYTES}; refusing partial review`);
  }
  const batched = totalDiffBytes > REVIEW_BATCH_MAX_BYTES || fileDiffs.some((f) => f.bytes > REVIEW_BATCH_MAX_BYTES);

  const snap = createReviewSnapshot({ repo: controlRepo, headSha, exec, mkdtemp });
  if (!snap.ok) return snap;
  let result;
  try {
    const rc = readReviewConfig({ snapshotPath: snap.snap });
    if (!rc.ok) {
      result = rc;
    } else {
      const cap = evaluateReviewOnlyCapabilities(rc.config);
      if (!cap.ok) {
        result = cap;
      } else {
        const ex = resolveExecutable({ env });
        if (!ex.ok) {
          result = fail('REVIEW_EXECUTOR_UNAVAILABLE', ex.reason || 'opencode unavailable');
        } else if (!batched) {
          result = runInlineReview({
            binding, target, reviewableFiles, excludedFiles, rule, diffText: fileDiffs[0] ? fileDiffs.map((f) => f.text).join('\n') : '',
            model, snap: snap.snap, ex, spawnReview, timeoutMs, env, durationMs,
            ocr: { version: ver.version, ruleGroups: rule.value.ruleGroups },
          });
        } else {
          result = runBatchedReview({
            binding, target, reviewableFiles, excludedFiles, rule, fileDiffs,
            model, snap: snap.snap, ex, spawnReview, timeoutMs, env, durationMs,
            ocr: { version: ver.version, ruleGroups: rule.value.ruleGroups },
          });
        }
        if (result && result.ok) {
          result.batch = batched
            ? { batched: true, batches: result.batchCount, totalDiffBytes }
            : { batched: false, batches: 1, totalDiffBytes };
          delete result.batchCount;
          // F01: the semantic rule payload digest travels with the result so
          // the resume cache can bind to actual rules, not just version/count.
          result.rulesDigest = rule.value.rulesDigest;
        }
      }
    }
  } finally {
    destroyReviewSnapshot({ repo: controlRepo, snap: snap.snap, exec });
  }
  tele(telemetry, 'REVIEW_LEG_FINISHED', {
    ok: result && result.ok === true,
    code: result && result.ok === true ? null : (result && result.code),
    batches: result && result.batch ? result.batch.batches : null,
    findingsCount: result && result.value ? result.value.findingsCount : null,
    digest: result && result.value ? result.value.digest : null,
    durationMs: durationMs(),
  });
  return result;
}

// Single inline run (live-proven 4A path): whole diff fits the batch bound,
// prompt carries scope/rules/diff inline.
function runInlineReview({ binding, target, reviewableFiles, excludedFiles, rule, diffText, model, snap, ex, spawnReview, timeoutMs, env, durationMs, ocr }) {
  const instruction = buildReviewPrompt({
    binding, target, reviewableFiles, excludedFiles,
    rulesText: rule.value.rulesText, rulesTruncated: rule.value.rulesTruncated,
    diffText,
  });
  const step = spawnReviewerStep({ instruction, model, snap, ex, spawnReview, timeoutMs, env, phase: 'review' });
  if (!step.ok) return step;
  return assembleReviewEvidence({
    binding, target, ocr, reviewableFiles, excludedFiles,
    reviewerResult: step.reviewerResult, durationMs: durationMs(),
  });
}

// Batched run: per-batch diff files + shared scope/rules files in the
// snapshot; sibling batch runs; reflection run over the aggregate; Issue-2
// gate on the final result. Any failure fails the whole leg.
function runBatchedReview({ binding, target, reviewableFiles, excludedFiles, rule, fileDiffs, model, snap, ex, spawnReview, timeoutMs, env, durationMs, ocr }) {
  const byPath = new Map(fileDiffs.map((f) => [f.path, f.text]));
  const plan = planReviewBatches(fileDiffs.map((f) => ({ path: f.path, bytes: f.bytes, text: f.text })));
  if (!plan.ok) return plan;
  const rulesRel = writeContextFile(snap, `${REVIEW_CONTEXT_DIR}/rules.md`, rule.value.rulesText || '(no rules)');
  writeContextFile(snap, `${REVIEW_CONTEXT_DIR}/scope.json`, JSON.stringify({ binding, target, reviewableFiles, excludedFiles }, null, 2));
  const aggregate = [];
  const covered = [];
  for (let bi = 0; bi < plan.batches.length; bi++) {
    const b = plan.batches[bi];
    const label = `${bi + 1}/${plan.batches.length}`;
    let batchFiles;
    let diffText;
    if (b.chunked) {
      // F2: chunk text comes from the planner (single source of truth) — no
      // recount, no estimate to disagree with; provenance labels actual N.
      const only = b.files[0];
      const c = b.chunkText;
      diffText = `### chunk ${only.chunkIndex + 1}/${only.chunks} ${only.path} (deterministic line split, complete coverage across chunks)\n${c}`;
      batchFiles = [only.path];
    } else {
      batchFiles = b.files.map((f) => f.path);
      diffText = b.files.map((f) => `### file ${f.path}\n${byPath.get(f.path)}`).join('\n');
    }
    const diffRel = writeContextFile(snap, `${REVIEW_CONTEXT_DIR}/diff-batch-${bi + 1}.diff`, diffText);
    const instruction = buildBatchPrompt({
      binding, target, batchFiles, batchLabel: label, diffRel, rulesRel,
      excludedFiles, remainingCount: reviewableFiles.length - new Set(covered).size - batchFiles.length,
    });
    const step = spawnReviewerStep({ instruction, model, snap, ex, spawnReview, timeoutMs, env, phase: `batch-${bi + 1}` });
    if (!step.ok) return fail('REVIEW_BATCH_FAILED', `${step.code}: ${JSON.stringify(step.detail)}`);
    if (!setsEqual(step.reviewerResult.reviewedFiles, batchFiles)) {
      return fail('REVIEW_BATCH_COVERAGE', `batch ${label}: reviewed != batch files`);
    }
    aggregate.push(...step.reviewerResult.findings);
    covered.push(...step.reviewerResult.reviewedFiles);
  }
  if (!setsEqual([...new Set(covered)], reviewableFiles)) {
    return fail('REVIEW_BATCH_COVERAGE', 'batch union != reviewable set');
  }
  // F1: aggregate bound before reflection — over-bound fails the whole leg;
  // no partial evidence is forwarded.
  if (aggregate.length > REVIEW_MAX_FINDINGS) {
    return fail('REVIEW_BATCH_FAILED', `aggregate findings ${aggregate.length} exceed leg bound ${REVIEW_MAX_FINDINGS}`);
  }
  const candidatesRel = writeContextFile(snap, `${REVIEW_CONTEXT_DIR}/candidates.json`, JSON.stringify(aggregate, null, 2));
  const reflection = buildReflectionPrompt({
    binding, target, reviewableFiles, excludedFiles, rulesRel, candidatesRel, batchCount: plan.batches.length,
  });
  const fin = spawnReviewerStep({ instruction: reflection, model, snap, ex, spawnReview, timeoutMs, env, phase: 'reflection' });
  if (!fin.ok) return fail('REVIEW_BATCH_FAILED', `reflection: ${fin.code}: ${JSON.stringify(fin.detail)}`);
  const assembled = assembleReviewEvidence({
    binding, target, ocr, reviewableFiles, excludedFiles,
    reviewerResult: fin.reviewerResult, durationMs: durationMs(),
  });
  if (!assembled.ok) return assembled;
  assembled.batchCount = plan.batches.length;
  return assembled;
}
