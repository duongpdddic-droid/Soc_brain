#!/usr/bin/env node
// review-delegate-evidence.mjs — strict ReviewEvidence v1 contract for the
// REVIEW-ONLY OpenCode leg (Issue #2 rework, OCR migration).
//
// Pure, deterministic, authority-free: this module validates, canonicalizes
// and digests the structured evidence produced by the REVIEW-ONLY OpenCode
// leg (OCR delegate preview/rule + host semantic review, skipped==0). It is
// NOT connected to the FSM/runtime here — no OCR/OpenCode invocation, no
// Gemini wiring change, no verdict authority.
//
// Closed-world v1 (post-rework):
// - NO `metadata` field. Unknown top-level keys are rejected.
// - Unknown nested keys in binding / target / ocr / excludedFiles items /
//   finding items are rejected.
// - target.mode is ONLY `range` | `commit` (`workspace` forbidden).
// - Empty reviewableFiles (0/0) fails with EVIDENCE_EMPTY_SCOPE.
// - Telemetry is a SEPARATE artifact/channel, never part of ReviewEvidence
//   and never part of the authority digest.
// - ReviewEvidence NEVER carries verdict / PASS / REWORK / BLOCKED authority.
//
// Authority hardening (enforced by tests/review-delegate-evidence.test.mjs):
// no taskFinish/taskBlock, no delivery, no loop token, no session/ledger
// write, no spawn, no network/fetch, no API-key read, no verdict decision.
// Only import is node:crypto (digest). No other imports.

import { createHash } from 'node:crypto';

export const REVIEW_EVIDENCE_SCHEMA_VERSION = '1';
export const REVIEW_EVIDENCE_SOURCE = 'ocr-delegate+opencode-host';
// Stable resume code for a PRE_REVIEWING tail whose evidence is NOT a v1
// ReviewEvidence (e.g. legacy Gemini shape). Declared here so Issue #3+ can
// fail closed without inventing a new code; the resume/FSM itself is UNCHANGED
// in this Issue.
export const RESUME_PRE_REVIEW_SHAPE_MISMATCH = 'RESUME_PRE_REVIEW_SHAPE_MISMATCH';

const IDENTITY_HASH_RE = /^[0-9a-f]{32}$/i;
const SHA40_RE = /^[0-9a-f]{40}$/i;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const OCR_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+._A-Za-z0-9]*)$/;
const TARGET_MODES = Object.freeze(['range', 'commit']);
const FINDING_CATEGORIES = Object.freeze(['bug', 'security', 'performance', 'maintainability', 'test', 'style', 'documentation', 'other']);
const FINDING_SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);
const FINDING_CONTENT_MAX_CHARS = 5000;

// Closed-world key sets (exact).
const TOP_LEVEL_KEYS = Object.freeze([
  'schemaVersion',
  'source',
  'binding',
  'target',
  'ocr',
  'reviewableFiles',
  'excludedFiles',
  'reviewedFiles',
  'skippedFiles',
  'coverageRate',
  'findings',
  'reflectionCompleted',
  'durationMs',
]);
const BINDING_KEYS = Object.freeze(['identityHash', 'repo', 'issueNumber', 'baseSha', 'headSha']);
const RANGE_TARGET_KEYS = Object.freeze(['mode', 'from', 'to']);
const COMMIT_TARGET_KEYS = Object.freeze(['mode', 'commit']);
const OCR_KEYS = Object.freeze(['version', 'ruleGroups']);
const EXCLUSION_KEYS = Object.freeze(['path', 'reason']);
const FINDING_KEYS = Object.freeze(['path', 'content', 'startLine', 'endLine', 'category', 'severity']);

function fail(code, detail) { return { ok: false, code, detail: detail ?? null }; }

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function unknownKeys(obj, allowed) {
  const set = new Set(allowed);
  return Object.keys(obj).filter((k) => !set.has(k));
}

function isValidPath(p) {
  if (typeof p !== 'string') return false;
  if (!p.trim() || p !== p.trim()) return false;
  if (p.includes('\0')) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  if (p.includes('\\')) return false;
  if (p === '.' || p.startsWith('./') || p.startsWith('../')) return false;
  const segs = p.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return false;
  return true;
}

function findDuplicate(arr) {
  const seen = new Set();
  for (const v of arr) {
    if (seen.has(v)) return v;
    seen.add(v);
  }
  return null;
}

function sameStringSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (isPlainObject(v)) {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function cmpFinding(a, b) {
  return cmpStr(a.path, b.path)
    || ((a.startLine ?? 0) - (b.startLine ?? 0))
    || ((a.endLine ?? 0) - (b.endLine ?? 0))
    || cmpStr(a.category, b.category)
    || cmpStr(a.severity, b.severity)
    || cmpStr(a.content, b.content);
}

// Lightweight discriminator: is this value shaped like a v1 ReviewEvidence?
// Structural hint only (schemaVersion + source); full gate is
// validateReviewEvidence.
export function isReviewEvidenceV1(v) {
  return isPlainObject(v)
    && v.schemaVersion === REVIEW_EVIDENCE_SCHEMA_VERSION
    && v.source === REVIEW_EVIDENCE_SOURCE;
}

// Legacy Gemini pre-review shape detector ({verdict, findings, confidence,
// metadata}). Gemini evidence must NEVER validate/convert into a v1
// ReviewEvidence; validateReviewEvidence rejects it fail-closed.
export function isLegacyGeminiPreReview(v) {
  return isPlainObject(v)
    && typeof v.verdict === 'string'
    && Array.isArray(v.findings)
    && typeof v.confidence === 'number'
    && isPlainObject(v.metadata);
}

function checkBinding(binding) {
  if (!isPlainObject(binding)) return fail('BINDING_INVALID', 'binding must be an object');
  const unknown = unknownKeys(binding, BINDING_KEYS);
  if (unknown.length !== 0) return fail('BINDING_UNKNOWN_FIELD', `binding unknown keys: ${unknown.sort().join(',')}`);
  const { identityHash, repo, issueNumber, baseSha, headSha } = binding;
  if (typeof identityHash !== 'string' || !IDENTITY_HASH_RE.test(identityHash)) {
    return fail('BINDING_INVALID', 'binding.identityHash must be 32-hex');
  }
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) {
    return fail('BINDING_INVALID', 'binding.repo must be owner/name');
  }
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return fail('BINDING_INVALID', 'binding.issueNumber must be a positive integer');
  }
  if (typeof baseSha !== 'string' || !SHA40_RE.test(baseSha)) {
    return fail('BINDING_INVALID', 'binding.baseSha must be 40-hex');
  }
  if (typeof headSha !== 'string' || !SHA40_RE.test(headSha)) {
    return fail('BINDING_INVALID', 'binding.headSha must be 40-hex');
  }
  return { ok: true };
}

function checkExpectedBinding(evBinding, expected) {
  if (!isPlainObject(expected)) return fail('BINDING_MISMATCH', 'expected binding malformed');
  const fields = ['identityHash', 'repo', 'issueNumber', 'baseSha', 'headSha'];
  for (const f of fields) {
    if (expected[f] === undefined) return fail('BINDING_MISMATCH', `expected binding missing ${f}`);
  }
  const norm = (v) => (typeof v === 'string' ? v.toLowerCase() : v);
  if (norm(evBinding.identityHash) !== norm(expected.identityHash)) {
    return fail('BINDING_MISMATCH', 'binding.identityHash mismatch');
  }
  if (String(evBinding.repo).toLowerCase() !== String(expected.repo).toLowerCase()) {
    return fail('BINDING_MISMATCH', 'binding.repo mismatch');
  }
  if (Number(evBinding.issueNumber) !== Number(expected.issueNumber)) {
    return fail('BINDING_MISMATCH', 'binding.issueNumber mismatch');
  }
  if (norm(evBinding.baseSha) !== norm(expected.baseSha)) {
    return fail('BINDING_MISMATCH', 'binding.baseSha mismatch');
  }
  if (norm(evBinding.headSha) !== norm(expected.headSha)) {
    return fail('BINDING_MISMATCH', 'binding.headSha mismatch');
  }
  return { ok: true };
}

function hasRef(v) {
  return v !== undefined && v !== null;
}

function checkTarget(target, binding) {
  if (!isPlainObject(target)) return fail('TARGET_INVALID', 'target must be an object');
  const { mode } = target;
  if (typeof mode !== 'string' || !TARGET_MODES.includes(mode)) {
    return fail('TARGET_MODE_INVALID', `target.mode must be one of ${TARGET_MODES.join('|')}`);
  }
  if (mode === 'range') {
    const unknown = unknownKeys(target, RANGE_TARGET_KEYS);
    if (unknown.length !== 0) return fail('TARGET_UNKNOWN_FIELD', `range target unknown keys: ${unknown.sort().join(',')}`);
    const { from, to, commit } = target;
    if (typeof from !== 'string' || !SHA40_RE.test(from)) return fail('TARGET_INVALID', 'range target.from must be 40-hex');
    if (typeof to !== 'string' || !SHA40_RE.test(to)) return fail('TARGET_INVALID', 'range target.to must be 40-hex');
    if (hasRef(commit)) return fail('TARGET_MISMATCH', 'range target must not carry commit');
    if (from.toLowerCase() !== binding.baseSha.toLowerCase()) return fail('TARGET_MISMATCH', 'range from != binding.baseSha');
    if (to.toLowerCase() !== binding.headSha.toLowerCase()) return fail('TARGET_MISMATCH', 'range to != binding.headSha');
    return { ok: true };
  }
  // mode === 'commit'
  const unknown = unknownKeys(target, COMMIT_TARGET_KEYS);
  if (unknown.length !== 0) return fail('TARGET_UNKNOWN_FIELD', `commit target unknown keys: ${unknown.sort().join(',')}`);
  const { commit, from, to } = target;
  if (typeof commit !== 'string' || !SHA40_RE.test(commit)) return fail('TARGET_INVALID', 'commit target.commit must be 40-hex');
  if (hasRef(from) || hasRef(to)) return fail('TARGET_MISMATCH', 'commit target must not carry from/to');
  if (commit.toLowerCase() !== binding.headSha.toLowerCase()) return fail('TARGET_MISMATCH', 'commit != binding.headSha');
  return { ok: true };
}

function checkOcr(ocr) {
  if (!isPlainObject(ocr)) return fail('OCR_METADATA_INVALID', 'ocr must be an object');
  const unknown = unknownKeys(ocr, OCR_KEYS);
  if (unknown.length !== 0) return fail('OCR_UNKNOWN_FIELD', `ocr unknown keys: ${unknown.sort().join(',')}`);
  if (typeof ocr.version !== 'string' || !ocr.version.trim() || !OCR_VERSION_RE.test(ocr.version.trim())) {
    return fail('OCR_METADATA_INVALID', 'ocr.version must be a semver-like string');
  }
  if (!Number.isInteger(ocr.ruleGroups) || ocr.ruleGroups < 0) {
    return fail('OCR_METADATA_INVALID', 'ocr.ruleGroups must be an integer >= 0');
  }
  return { ok: true };
}

function checkFinding(f, i, reviewableSet) {
  if (!isPlainObject(f)) return fail('FINDING_MALFORMED', `findings[${i}] must be an object`);
  const unknown = unknownKeys(f, FINDING_KEYS);
  if (unknown.length !== 0) return fail('FINDING_UNKNOWN_FIELD', `findings[${i}] unknown keys: ${unknown.sort().join(',')}`);
  if (typeof f.path !== 'string' || !isValidPath(f.path)) return fail('FINDING_MALFORMED', `findings[${i}].path invalid`);
  if (!reviewableSet.has(f.path)) return fail('FINDING_PATH_FOREIGN', `findings[${i}].path not in reviewableFiles`);
  if (typeof f.content !== 'string' || !f.content.trim() || f.content.length > FINDING_CONTENT_MAX_CHARS) {
    return fail('FINDING_MALFORMED', `findings[${i}].content must be 1..${FINDING_CONTENT_MAX_CHARS} chars`);
  }
  const { startLine, endLine, category, severity } = f;
  if (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1)) {
    return fail('FINDING_LINE_INVALID', `findings[${i}].startLine must be an integer >= 1`);
  }
  if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < 1)) {
    return fail('FINDING_LINE_INVALID', `findings[${i}].endLine must be an integer >= 1`);
  }
  if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
    return fail('FINDING_LINE_INVALID', `findings[${i}].startLine must be <= endLine`);
  }
  if (typeof category !== 'string' || !FINDING_CATEGORIES.includes(category)) {
    return fail('FINDING_CATEGORY_INVALID', `findings[${i}].category must be one of ${FINDING_CATEGORIES.join('|')}`);
  }
  if (typeof severity !== 'string' || !FINDING_SEVERITIES.includes(severity)) {
    return fail('FINDING_SEVERITY_INVALID', `findings[${i}].severity must be one of ${FINDING_SEVERITIES.join('|')}`);
  }
  return { ok: true };
}

// Strict fail-closed validator. expectedBinding (optional) is the canonical
// {identityHash, repo, issueNumber, baseSha, headSha} the evidence must echo.
export function validateReviewEvidence(evidence, expectedBinding = null) {
  if (!isPlainObject(evidence)) return fail('EVIDENCE_MALFORMED', 'evidence must be an object');
  if ('verdict' in evidence) return fail('EVIDENCE_VERDICT_FORBIDDEN', 'advisory verdict must never ride ReviewEvidence');
  const unknownTop = unknownKeys(evidence, TOP_LEVEL_KEYS);
  if (unknownTop.length !== 0) return fail('EVIDENCE_UNKNOWN_FIELD', `unknown top-level keys: ${unknownTop.sort().join(',')}`);
  if (evidence.schemaVersion !== REVIEW_EVIDENCE_SCHEMA_VERSION) {
    return fail('EVIDENCE_SCHEMA_VERSION_INVALID', `schemaVersion must be ${JSON.stringify(REVIEW_EVIDENCE_SCHEMA_VERSION)}`);
  }
  if (evidence.source !== REVIEW_EVIDENCE_SOURCE) {
    return fail('EVIDENCE_SOURCE_INVALID', `source must be ${JSON.stringify(REVIEW_EVIDENCE_SOURCE)}`);
  }
  const bb = checkBinding(evidence.binding);
  if (!bb.ok) return bb;
  const binding = evidence.binding;
  if (expectedBinding !== null && expectedBinding !== undefined) {
    const eb = checkExpectedBinding(binding, expectedBinding);
    if (!eb.ok) return eb;
  }
  const tt = checkTarget(evidence.target, binding);
  if (!tt.ok) return tt;
  const oc = checkOcr(evidence.ocr);
  if (!oc.ok) return oc;
  const reviewable = evidence.reviewableFiles;
  if (!Array.isArray(reviewable)) return fail('PATH_INVALID', 'reviewableFiles must be an array');
  if (reviewable.length === 0) return fail('EVIDENCE_EMPTY_SCOPE', 'reviewableFiles must be non-empty; 0/0 is never 100% coverage');
  for (let i = 0; i < reviewable.length; i++) {
    if (!isValidPath(reviewable[i])) return fail('PATH_INVALID', `reviewableFiles[${i}] invalid`);
  }
  const dupR = findDuplicate(reviewable);
  if (dupR !== null) return fail('PATH_DUPLICATE', `reviewableFiles duplicate: ${dupR}`);
  const excluded = evidence.excludedFiles;
  if (!Array.isArray(excluded)) return fail('PATH_INVALID', 'excludedFiles must be an array');
  const excludedPaths = [];
  for (let i = 0; i < excluded.length; i++) {
    const e = excluded[i];
    if (!isPlainObject(e)) return fail('PATH_INVALID', `excludedFiles[${i}] must be an object`);
    const unknown = unknownKeys(e, EXCLUSION_KEYS);
    if (unknown.length !== 0) return fail('EXCLUSION_UNKNOWN_FIELD', `excludedFiles[${i}] unknown keys: ${unknown.sort().join(',')}`);
    if (!isValidPath(e.path)) return fail('PATH_INVALID', `excludedFiles[${i}].path invalid`);
    if (typeof e.reason !== 'string' || !e.reason.trim()) {
      return fail('EXCLUSION_REASON_MISSING', `excludedFiles[${i}].reason required`);
    }
    excludedPaths.push(e.path);
  }
  const dupE = findDuplicate(excludedPaths);
  if (dupE !== null) return fail('PATH_DUPLICATE', `excludedFiles duplicate: ${dupE}`);
  const reviewableSet = new Set(reviewable);
  for (const p of excludedPaths) {
    if (reviewableSet.has(p)) return fail('SCOPE_OVERLAP', `path in both reviewable and excluded: ${p}`);
  }
  const reviewed = evidence.reviewedFiles;
  if (!Array.isArray(reviewed)) return fail('PATH_INVALID', 'reviewedFiles must be an array');
  for (let i = 0; i < reviewed.length; i++) {
    if (!isValidPath(reviewed[i])) return fail('PATH_INVALID', `reviewedFiles[${i}] invalid`);
  }
  const dupV = findDuplicate(reviewed);
  if (dupV !== null) return fail('PATH_DUPLICATE', `reviewedFiles duplicate: ${dupV}`);
  if (!sameStringSet(reviewed, reviewable)) {
    const missing = [...reviewableSet].filter((p) => !reviewed.includes(p)).sort();
    const extra = reviewed.filter((p) => !reviewableSet.has(p)).sort();
    return fail('REVIEWED_MISMATCH', { missing, extra });
  }
  const skipped = evidence.skippedFiles;
  if (!Array.isArray(skipped)) return fail('SKIPPED_NON_EMPTY', 'skippedFiles must be an array');
  if (skipped.length !== 0) return fail('SKIPPED_NON_EMPTY', `skippedFiles must be empty (got ${skipped.length})`);
  if (evidence.coverageRate !== 1) return fail('COVERAGE_INVALID', 'coverageRate must be 1');
  const findings = evidence.findings;
  if (!Array.isArray(findings)) return fail('FINDING_MALFORMED', 'findings must be an array');
  for (let i = 0; i < findings.length; i++) {
    const cf = checkFinding(findings[i], i, reviewableSet);
    if (!cf.ok) return cf;
  }
  if (evidence.reflectionCompleted !== true) return fail('REFLECTION_INCOMPLETE', 'reflectionCompleted must be true');
  if (typeof evidence.durationMs !== 'number' || !Number.isFinite(evidence.durationMs) || evidence.durationMs < 0) {
    return fail('DURATION_INVALID', 'durationMs must be a finite number >= 0');
  }
  const canonical = canonicalizeReviewEvidence(evidence);
  return { ok: true, value: { canonical, digest: reviewEvidenceDigest(evidence), findingsCount: findings.length } };
}

// Deterministic canonical form: fixed key order, sets sorted, findings
// sorted. Closed-world: only contract keys survive; no metadata, no extras.
// Pure transform — callers must validate first; no semantic dedupe/drop
// happens here.
export function canonicalizeReviewEvidence(evidence) {
  const b = evidence.binding;
  const t = evidence.target;
  const o = evidence.ocr;
  const sortedFindings = [...evidence.findings].sort(cmpFinding).map((f) => {
    const out = { path: f.path, content: f.content };
    if (f.startLine !== undefined) out.startLine = f.startLine;
    if (f.endLine !== undefined) out.endLine = f.endLine;
    out.category = f.category;
    out.severity = f.severity;
    return out;
  });
  const target = t.mode === 'range'
    ? { mode: 'range', from: t.from.toLowerCase(), to: t.to.toLowerCase() }
    : { mode: 'commit', commit: t.commit.toLowerCase() };
  return {
    schemaVersion: REVIEW_EVIDENCE_SCHEMA_VERSION,
    source: REVIEW_EVIDENCE_SOURCE,
    binding: {
      identityHash: b.identityHash.toLowerCase(),
      repo: b.repo,
      issueNumber: b.issueNumber,
      baseSha: b.baseSha.toLowerCase(),
      headSha: b.headSha.toLowerCase(),
    },
    target,
    ocr: { version: o.version.trim(), ruleGroups: o.ruleGroups },
    reviewableFiles: [...evidence.reviewableFiles].sort(cmpStr),
    excludedFiles: [...evidence.excludedFiles]
      .sort((a, c) => cmpStr(a.path, c.path))
      .map((e) => ({ path: e.path, reason: e.reason })),
    reviewedFiles: [...evidence.reviewedFiles].sort(cmpStr),
    skippedFiles: [],
    coverageRate: 1,
    findings: sortedFindings,
    reflectionCompleted: true,
    durationMs: evidence.durationMs,
  };
}

// Authority digest over SEMANTIC evidence only: durationMs is informational
// runtime telemetry and never enters the digest. Set-order and object-key
// order independent via canonicalization + stable stringify.
export function reviewEvidenceDigest(evidence) {
  const c = canonicalizeReviewEvidence(evidence);
  const authority = {
    schemaVersion: c.schemaVersion,
    source: c.source,
    binding: c.binding,
    target: c.target,
    ocr: c.ocr,
    reviewableFiles: c.reviewableFiles,
    excludedFiles: c.excludedFiles,
    reviewedFiles: c.reviewedFiles,
    skippedFiles: c.skippedFiles,
    coverageRate: c.coverageRate,
    findings: c.findings,
    reflectionCompleted: c.reflectionCompleted,
  };
  return createHash('sha256').update(stableStringify(authority), 'utf8').digest('hex');
}
