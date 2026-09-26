#!/usr/bin/env node
// control-loop-s4-final-review-integration.test.mjs — S4 Final Review Transaction Integration.
//
// 100% offline/mock: no live HTTP, no live CDP, no live clipboard.
// Covers:
//   1. Canonical requestDigest lives in metadata.requestDigest
//   2. Exact semantic digest inputs (all 8 fields)
//   3. Unconditional pullRequest binding gate
//   4. Per-transaction transportFactory path
//   5. Real classifyCapturedItem: exact match accepted
//   6. Real classifyCapturedItem: identity mismatch returns BINDING_MISMATCH
//   7. Real classifyCapturedItem: requestDigest mismatch returns COPY_STALE
//   8. Digest sensitivity beyond previous 20/10 boundaries + verbatim packet
//   9. All five binding values reach the factory
//  10. Exactly one invocation, no fallback/retry

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeRequestDigest,
  normalizeFinalReviewRequest,
  parseGptFinalReview,
  assertFinalBinding,
  createGptFinalReview,
} from '../packages/control-loop/gpt-final-review.mjs';
import {
  web2ApiCopyFinalReviewAdapter,
  gptFinalReviewAdapter,
} from '../packages/control-loop/adapters.mjs';
import { classifyCapturedItem } from '../packages/control-loop/chatgpt-plus-web2api-copy.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

// ---- helpers ----------------------------------------------------------------
function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 's4int-')); }

const HEAD = 'a'.repeat(40);
const PR_NUMBER = 78;
const REPO = 'duongpdddic-droid/soc_brain';
const ISSUE = 77;

function mkSession(stateDir, overrides = {}) {
  const id = identityHash({ repo: REPO, issueNumber: ISSUE });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1',
    state: 'SESSION_ACTIVE',
    lifecycle: [],
    taskId: `${REPO}#${ISSUE}`,
    repo: REPO,
    issueNumber: ISSUE,
    prNumber: PR_NUMBER,
    headSha: HEAD,
    baseSha: 'f'.repeat(40),
    worktreePath: path.join(stateDir, `wt-issue-${ISSUE}`),
    worktreesRoot: stateDir,
    controlPlane: { stateDir },
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session, id };
}

function mkPacket(stateDir, session) {
  const dir = path.join(stateDir, 'review-ready');
  fs.mkdirSync(dir, { recursive: true });
  const slug = String(session.repo).replace(/\//g, '_');
  const name = `${slug}_Issue-${session.issueNumber}_PR-${PR_NUMBER}_abcdef0_review-ready.md`;
  const content = [
    `# Review Ready — ${session.repo} Issue #${session.issueNumber} · PR #${PR_NUMBER}`,
    '',
    '## Identity',
    `- repository: ${session.repo}`,
    `- issue: ${session.issueNumber}`,
    `- pullRequest: ${PR_NUMBER}`,
    '- branch: agent/test',
    `- headSha: ${HEAD} (short ${HEAD.slice(0, 7)})`,
    `- baseSha: ${'b'.repeat(40)}`,
    '- prState: OPEN',
    '',
    'Canonical packet body for semantic final review.',
    // Full canonical section set (renderReviewReady contract) — the structured
    // packet projection (Issue #155 round-6) fail-closes on absent headings.
    '',
    '## Scope',
    '- 1. note=scope under review',
    '',
    '## Code evidence',
    '- 1. commits=abcdef0 · files=3 · diffStat=+120/-22',
    '',
    '## Finding resolution',
    '- 1. note=first canonical pass — no prior review findings yet',
    '',
    '## Tests',
    '- 1. testExecution=787/787 passed · exitCode=0 · headSha=aaaaaaaa',
    '',
    '## Verification',
    '- 1. legacyEvidenceVerify=PASS · failClosedVerifierCodes=none',
    '',
    '## Safety and mutation analysis',
    '- 1. controlLoopTrace=PRE_REVIEWING->FINAL_REVIEWING (ok)',
    '',
    '## Unverified risks',
    '- 1. semantic review pending',
    '',
    '## Delivery',
    `- 1. pr=${PR_NUMBER} · prState=OPEN · baseBranch=main`,
    '',
    '## Terminal status',
    '- status: **READY_FOR_REVIEW**',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
  return { dir, name, content };
}

// Build a valid review reply with digest in metadata.requestDigest (NOT in binding).
function mkReviewJson(digest, overrides = {}) {
  const obj = {
    verdict: 'PASS',
    findings: [],
    evidenceRequests: [],
    confidence: 0.95,
    metadata: { requestDigest: digest, note: 's4-test' },
    binding: { repository: REPO, issue: ISSUE, pullRequest: PR_NUMBER, headSha: HEAD },
    ...overrides,
  };
  if (!obj.metadata) obj.metadata = {};
  if (!obj.metadata.requestDigest) obj.metadata.requestDigest = digest;
  return JSON.stringify(obj);
}

// Transport helper: extracts digest from prompt, injects into reply metadata.
function mkTransport(replyFn) {
  return async ({ prompt }) => {
    const digestMatch = /Request digest \(include in metadata\.requestDigest\):\s*([0-9a-f]{64})/i.exec(prompt || '');
    const digest = digestMatch ? digestMatch[1] : '0'.repeat(64);
    const obj = JSON.parse(replyFn(digest));
    if (!obj.metadata) obj.metadata = {};
    obj.metadata.requestDigest = digest;
    return { ok: true, text: JSON.stringify(obj) };
  };
}

// ---- 1. Canonical requestDigest location: metadata.requestDigest --------------
{
  const stateDir = mkStateDir();
  const { sessionPath, session } = mkSession(stateDir);
  const rr = mkPacket(stateDir, session);
  const digest = computeRequestDigest({
    repository: session.repo, issue: session.issueNumber, pullRequest: session.prNumber,
    headSha: session.headSha, packetExcerpt: rr.content,
    report: { verdict: 'PASS', findings: [] }, ledger: [], preReview: null,
  });

  const adapter = gptFinalReviewAdapter({ transport: mkTransport((d) => mkReviewJson(d)), reviewReadyDir: rr.dir });
  const result = await adapter({ sessionPath, report: { verdict: 'PASS', findings: [] }, preReview: null });
  assert.equal(result.ok, true, 'S4-1a: adapter succeeds');
  assert.equal(typeof result.value.metadata.requestDigest, 'string', 'S4-1b: digest in metadata');
  assert.equal(result.value.metadata.requestDigest.length, 64, 'S4-1c: digest is 64-hex');
  assert.equal(result.value.metadata.requestDigest, digest, 'S4-1d: digest matches computed');
  assert.equal(result.value.binding.requestDigest, undefined, 'S4-1e: digest NOT in binding');
}

// ---- 2. Exact semantic digest inputs -----------------------------------------
{
  const base = { repository: REPO, issue: ISSUE, pullRequest: PR_NUMBER, headSha: HEAD, packetExcerpt: 'body',
    report: { verdict: 'PASS', findings: [] }, ledger: [], preReview: null };
  const d1 = computeRequestDigest(base);
  const d2 = computeRequestDigest(base);
  assert.equal(d1, d2, 'S4-2a: deterministic');
  assert.equal(d1.length, 64, 'S4-2b: 64 hex');
  assert.ok(/^[0-9a-f]{64}$/.test(d1), 'S4-2c: hex only');
  assert.notEqual(d1, computeRequestDigest({ ...base, repository: 'other' }), 'S4-2d: repo');
  assert.notEqual(d1, computeRequestDigest({ ...base, issue: 99 }), 'S4-2e: issue');
  assert.notEqual(d1, computeRequestDigest({ ...base, pullRequest: 99 }), 'S4-2f: pullRequest');
  assert.notEqual(d1, computeRequestDigest({ ...base, headSha: 'b'.repeat(40) }), 'S4-2g: headSha');
  assert.notEqual(d1, computeRequestDigest({ ...base, packetExcerpt: 'other' }), 'S4-2h: packetExcerpt');
  assert.notEqual(d1, computeRequestDigest({ ...base, report: { verdict: 'REWORK', findings: [] } }), 'S4-2i: report');
  assert.notEqual(d1, computeRequestDigest({ ...base, ledger: [{ from: 'A', to: 'B' }] }), 'S4-2j: ledger');
  assert.notEqual(d1, computeRequestDigest({ ...base, preReview: { verdict: 'PASS', findings: [], confidence: 0.5 } }), 'S4-2k: preReview');
}

// ---- 3. Unconditional pullRequest binding gate --------------------------------
{
  const ident = { ok: true, repository: REPO, issue: ISSUE, headSha: HEAD };
  assert.ok(assertFinalBinding({ repository: REPO, issue: ISSUE, pullRequest: PR_NUMBER, headSha: HEAD }, { ident, prNumber: PR_NUMBER }).ok, 'S4-3a: match');
  assert.equal(assertFinalBinding({ repository: REPO, issue: ISSUE, headSha: HEAD }, { ident, prNumber: PR_NUMBER }).code, 'GPT_BINDING_MISMATCH', 'S4-3b: missing PR');
  assert.equal(assertFinalBinding({ repository: REPO, issue: ISSUE, pullRequest: 99, headSha: HEAD }, { ident, prNumber: PR_NUMBER }).code, 'GPT_BINDING_MISMATCH', 'S4-3c: wrong PR');
  assert.ok(assertFinalBinding({ repository: REPO, issue: ISSUE, headSha: HEAD }, { ident, prNumber: null }).ok, 'S4-3d: no PR required');
}

// ---- 4. Per-transaction transportFactory path ---------------------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, session } = mkSession(stateDir);
  const rr = mkPacket(stateDir, session);
  const digest = computeRequestDigest({
    repository: session.repo, issue: session.issueNumber, pullRequest: session.prNumber,
    headSha: session.headSha, packetExcerpt: rr.content,
    report: { verdict: 'PASS', findings: [] }, ledger: [], preReview: null,
  });

  const factoryCalls = [];
  const adapter = createGptFinalReview({
    transportFactory: (binding) => {
      factoryCalls.push(binding);
      return async ({ prompt }) => ({ ok: true, text: mkReviewJson(digest) });
    },
    reviewReadyDir: rr.dir,
  });
  const result = await adapter({ sessionPath, report: { verdict: 'PASS', findings: [] }, preReview: null });
  assert.equal(result.ok, true, 'S4-4a: factory succeeds');
  assert.equal(factoryCalls.length, 1, 'S4-4b: factory called once');
  const b = factoryCalls[0];
  assert.equal(b.repository, REPO, 'S4-4c: factory receives repository');
  assert.equal(b.issue, ISSUE, 'S4-4d: factory receives issue');
  assert.equal(b.pullRequest, PR_NUMBER, 'S4-4e: factory receives pullRequest');
  assert.equal(b.headSha, HEAD, 'S4-4f: factory receives headSha');
  assert.equal(typeof b.requestDigest, 'string', 'S4-4g: factory receives requestDigest');
  assert.equal(b.requestDigest.length, 64, 'S4-4h: requestDigest is 64-hex');
  assert.equal(b.requestDigest, digest, 'S4-4i: requestDigest matches computed');
}

// ---- 5. Real classifyCapturedItem: exact match accepted -----------------------
{
  const digest = 'ab'.repeat(32);
  const ref = { repository: REPO, issue: ISSUE, pullRequest: PR_NUMBER, headSha: HEAD, requestDigest: digest };
  const text = mkReviewJson(digest);
  assert.equal(classifyCapturedItem(text, ref), 'valid', 'S4-5a: exact match accepted');
  // Verdict variants
  assert.equal(classifyCapturedItem(mkReviewJson(digest, { verdict: 'REWORK' }), ref), 'valid', 'S4-5b: REWORK accepted');
  assert.equal(classifyCapturedItem(mkReviewJson(digest, { verdict: 'BLOCKED' }), ref), 'valid', 'S4-5c: BLOCKED accepted');
}

// ---- 6. Real classifyCapturedItem: identity mismatch returns BINDING_MISMATCH --
{
  const digest = 'ab'.repeat(32);
  const ref = { repository: REPO, issue: ISSUE, pullRequest: PR_NUMBER, headSha: HEAD, requestDigest: digest };
  // Wrong repository
  const wrongRepo = mkReviewJson(digest, { binding: { repository: 'other/repo', issue: ISSUE, pullRequest: PR_NUMBER, headSha: HEAD } });
  assert.equal(classifyCapturedItem(wrongRepo, ref), 'binding-bad', 'S4-6a: wrong repo -> binding-bad');
  // Wrong issue
  const wrongIssue = mkReviewJson(digest, { binding: { repository: REPO, issue: 99, pullRequest: PR_NUMBER, headSha: HEAD } });
  assert.equal(classifyCapturedItem(wrongIssue, ref), 'binding-bad', 'S4-6b: wrong issue -> binding-bad');
  // Wrong pullRequest
  const wrongPr = mkReviewJson(digest, { binding: { repository: REPO, issue: ISSUE, pullRequest: 99, headSha: HEAD } });
  assert.equal(classifyCapturedItem(wrongPr, ref), 'binding-bad', 'S4-6c: wrong pullRequest -> binding-bad');
  // Wrong headSha
  const wrongHead = mkReviewJson(digest, { binding: { repository: REPO, issue: ISSUE, pullRequest: PR_NUMBER, headSha: 'b'.repeat(40) } });
  assert.equal(classifyCapturedItem(wrongHead, ref), 'binding-bad', 'S4-6d: wrong headSha -> binding-bad');
}

// ---- 7. Real classifyCapturedItem: requestDigest mismatch returns COPY_STALE --
{
  const ref = { repository: REPO, issue: ISSUE, pullRequest: PR_NUMBER, headSha: HEAD, requestDigest: 'ab'.repeat(32) };
  const wrongDigest = mkReviewJson('cd'.repeat(32));
  assert.equal(classifyCapturedItem(wrongDigest, ref), 'stale-digest', 'S4-7a: wrong digest -> stale-digest');
  // Missing digest in metadata
  const noDigest = JSON.stringify({ verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.9, metadata: {}, binding: { repository: REPO, issue: ISSUE, pullRequest: PR_NUMBER, headSha: HEAD } });
  assert.equal(classifyCapturedItem(noDigest, ref), 'stale-digest', 'S4-7b: missing digest -> stale-digest');
  // Invalid verdict with S4 binding active
  const badVerdict = mkReviewJson('ab'.repeat(32), { verdict: 'APPROVED' });
  assert.equal(classifyCapturedItem(badVerdict, ref), 'not-json', 'S4-7c: invalid verdict -> not-json');
}

// ---- 8. Digest sensitivity beyond previous 20/10 boundaries + verbatim packet -
{
  const base = { repository: REPO, issue: ISSUE, pullRequest: PR_NUMBER, headSha: HEAD,
    packetExcerpt: 'x'.repeat(8192), report: { verdict: 'PASS', findings: Array.from({ length: 20 }, (_, i) => `f${i}`) },
    ledger: Array.from({ length: 20 }, (_, i) => ({ from: `A${i}`, to: `B${i}`, reason: `r${i}` })),
    preReview: { verdict: 'PASS', findings: Array.from({ length: 10 }, (_, i) => `g${i}`), confidence: 0.9 } };
  const d1 = computeRequestDigest(base);
  // Content within boundary changes digest
  const d2 = computeRequestDigest({ ...base, packetExcerpt: 'y'.repeat(8192) });
  assert.notEqual(d1, d2, 'S4-8a: packetExcerpt within 8192 changes digest');
  // Content beyond the old 8192 boundary changes the digest → NO silent
  // truncation (Issue #155 round-6: normalization keeps the packet excerpt
  // verbatim; only the fail-closed structured projection bounds the prompt).
  const d3 = computeRequestDigest({ ...base, packetExcerpt: 'x'.repeat(8192) + 'Y' });
  assert.notEqual(d1, d3, 'S4-8b: packetExcerpt beyond 8192 NOT truncated → digest changes');
  // 21st finding: normalized includes exactly 20, extra is dropped → same digest
  const d4 = computeRequestDigest({ ...base, report: { verdict: 'PASS', findings: Array.from({ length: 21 }, (_, i) => `f${i}`) } });
  assert.equal(d1, d4, 'S4-8c: 21st finding truncated → same digest');
  // 11th preReview finding: normalized includes exactly 10, extra is dropped → same digest
  const d5 = computeRequestDigest({ ...base, preReview: { verdict: 'PASS', findings: Array.from({ length: 11 }, (_, i) => `g${i}`), confidence: 0.9 } });
  assert.equal(d1, d5, 'S4-8d: 11th preReview finding truncated → same digest');
  // 21st ledger entry: slice(-20) shifts the window → digest changes (proves boundary enforced)
  const d6 = computeRequestDigest({ ...base, ledger: Array.from({ length: 21 }, (_, i) => ({ from: `A${i}`, to: `B${i}`, reason: `r${i}` })) });
  assert.notEqual(d1, d6, 'S4-8e: 21st ledger entry shifts slice(-20) window → digest changes');
  // Finding content within 280 chars changes digest
  const d7 = computeRequestDigest({ ...base, report: { verdict: 'PASS', findings: ['a'.repeat(280)] } });
  const d8 = computeRequestDigest({ ...base, report: { verdict: 'PASS', findings: ['b'.repeat(280)] } });
  assert.notEqual(d7, d8, 'S4-8f: finding content within 280 chars changes digest');
  // Finding content beyond 280 chars is truncated → same digest
  const d9 = computeRequestDigest({ ...base, report: { verdict: 'PASS', findings: ['a'.repeat(280) + 'Z'] } });
  assert.equal(d7, d9, 'S4-8g: finding content beyond 280 chars truncated → same digest');
  // Verify normalization boundaries are enforced
  const nr = normalizeFinalReviewRequest({ ...base, packetExcerpt: 'x'.repeat(10000) });
  assert.equal(nr.packetExcerpt.length, 10000, 'S4-8h: packetExcerpt preserved verbatim (projection is the only bound)');
  const nr2 = normalizeFinalReviewRequest({ ...base, report: { verdict: 'PASS', findings: Array.from({ length: 30 }, (_, i) => `f${i}`) } });
  assert.equal(nr2.report.findings.length, 20, 'S4-8i: report findings truncated to 20');
  const nr3 = normalizeFinalReviewRequest({ ...base, preReview: { verdict: 'PASS', findings: Array.from({ length: 15 }, (_, i) => `g${i}`), confidence: 0.9 } });
  assert.equal(nr3.preReview.findings.length, 10, 'S4-8j: preReview findings truncated to 10');
}

// ---- 9. All five binding values reach the factory -----------------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, session } = mkSession(stateDir);
  const rr = mkPacket(stateDir, session);
  const digest = computeRequestDigest({
    repository: session.repo, issue: session.issueNumber, pullRequest: session.prNumber,
    headSha: session.headSha, packetExcerpt: rr.content,
    report: { verdict: 'PASS', findings: [] }, ledger: [], preReview: null,
  });

  let capturedBinding = null;
  const adapter = createGptFinalReview({
    transportFactory: (binding) => {
      capturedBinding = { ...binding };
      return async () => ({ ok: true, text: mkReviewJson(digest) });
    },
    reviewReadyDir: rr.dir,
  });
  await adapter({ sessionPath, report: { verdict: 'PASS', findings: [] }, preReview: null });
  assert.deepEqual(Object.keys(capturedBinding).sort(), ['headSha', 'issue', 'pullRequest', 'repository', 'requestDigest'], 'S4-9a: exactly five keys');
  assert.equal(capturedBinding.repository, REPO, 'S4-9b: repository');
  assert.equal(capturedBinding.issue, ISSUE, 'S4-9c: issue');
  assert.equal(capturedBinding.pullRequest, PR_NUMBER, 'S4-9d: pullRequest');
  assert.equal(capturedBinding.headSha, HEAD, 'S4-9e: headSha');
  assert.equal(capturedBinding.requestDigest, digest, 'S4-9f: requestDigest');
}

// ---- 10. Exactly one invocation, no fallback/retry ----------------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, session } = mkSession(stateDir);
  const rr = mkPacket(stateDir, session);
  const digest = computeRequestDigest({
    repository: session.repo, issue: session.issueNumber, pullRequest: session.prNumber,
    headSha: session.headSha, packetExcerpt: rr.content,
    report: { verdict: 'PASS', findings: [] }, ledger: [], preReview: null,
  });

  let factoryInvocations = 0;
  let transportInvocations = 0;
  const adapter = createGptFinalReview({
    transportFactory: () => {
      factoryInvocations++;
      return async () => { transportInvocations++; return { ok: true, text: mkReviewJson(digest) }; };
    },
    reviewReadyDir: rr.dir,
  });
  await adapter({ sessionPath, report: { verdict: 'PASS', findings: [] }, preReview: null });
  assert.equal(factoryInvocations, 1, 'S4-10a: factory invoked exactly once');
  assert.equal(transportInvocations, 1, 'S4-10b: transport invoked exactly once');
}

// ---- summary -----------------------------------------------------------------
console.log('control-loop-s4-final-review-integration: all checks passed');
process.exit(0);
