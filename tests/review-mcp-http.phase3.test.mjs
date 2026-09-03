#!/usr/bin/env node
// review-mcp-http.phase3.test.mjs — Soc_brain Review MCP HTTP, Phase 3 (Issue #43).
// Covers the new `review.submit_decision` tool end-to-end through the MCP server:
//   - capability surface includes the new tool
//   - valid submission → persisted=true, deterministic file written, no symlink
//   - replay identical → DUPLICATE_NOOP
//   - replay different payload → DUPLICATE_CONFLICT
//   - boundary verdict → canonical enum mapping
//   - all negative codes from Issue #43 acceptance criteria
//   - secret redaction persists in decision file
// No network/GitHub. Run: node --test tests/review-mcp-http.phase3.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReviewMcp, TOOL_NAMES } from '../packages/review-mcp-http/review-mcp-http.mjs';
import { BOUNDARY_VERDICTS } from '../packages/review-mcp-http/submit-decision.mjs';

// ---- helpers -----------------------------------------------------------------
const REPO = 'duongpdddic-droid/soc_brain';
const HEAD = 'abcdef1234567890abcdef1234567890abcdef12'; // 40 hex
const ISSUE = 43;

function writeFakeReviewReady(dir, { repository = REPO, issue = ISSUE, headSha = HEAD, pr = 43, status = 'READY_FOR_REVIEW', extra = '' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const slug = repository.replace(/\//g, '_');
  const shortHead = headSha.slice(0, 7);
  const filename = `${slug}_Issue-${issue}_PR-${pr}_${shortHead}_review-ready.md`;
  const filePath = path.join(dir, filename);
  const reportDigest = createHash('sha256').update(`fake-report-${filePath}`, 'utf8').digest('hex');
  const content =
    `# Review Ready — ${repository} Issue #${issue} · PR #${pr}\n` +
    `\n## Identity\n` +
    `- repository: ${repository}\n` +
    `- issue: ${issue}\n` +
    `- pullRequest: ${pr}\n` +
    `- headSha: ${headSha} (short ${shortHead})\n` +
    `- reportDigest: ${reportDigest}\n` +
    `- status: **${status}**\n` +
    extra;
  fs.writeFileSync(filePath, content, 'utf8');
  return { filePath, content, reportDigest, contentDigest: createHash('sha256').update(content, 'utf8').digest('hex') };
}

function makeRequest(art, extras = {}) {
  return {
    repository: REPO,
    issue: ISSUE,
    headSha: HEAD,
    requestDigest: art.reportDigest,
    contentDigest: art.contentDigest,
    verdict: 'PASS',
    findings: [],
    evidenceRequests: [],
    submittedBy: 'chatgpt-web:test',
    ...extras,
  };
}

function makeServer({ requestDir, baseDir }) {
  // baseDir is the parent of the artifact dir; the server puts decisions in <baseDir>/_decisions.
  // We point the server at baseDir (which holds the fake review-ready file).
  return createReviewMcp({ requestDir: baseDir });
}

function call(server, toolName, args) {
  return server.handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  });
}

// ---- tests -------------------------------------------------------------------
test('capability surface: review.submit_decision exposed (Phase 3, AC: tool surface)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const s = makeServer({ requestDir: tmp });
    const list = s.handleRequest({ id: 1, method: 'tools/list' });
    const names = list.result.tools.map((t) => t.name);
    assert.deepEqual(names.sort(), ['review.get_evidence', 'review.get_request', 'review.ping', 'review.submit_decision'].sort());
    const sub = list.result.tools.find((t) => t.name === TOOL_NAMES.submitDecision);
    assert.ok(sub, 'submitDecision tool present');
    assert.deepEqual(sub.inputSchema.required, ['repository', 'issue', 'headSha', 'requestDigest', 'contentDigest', 'verdict']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('positive: valid PASS submission persisted to deterministic path (AC: write path + boundary verdict)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    const res = call(s, TOOL_NAMES.submitDecision, makeRequest(art, { verdict: 'PASS' }));
    assert.equal(res.result.isError, false);
    const payload = JSON.parse(res.result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.persisted, true);
    assert.equal(payload.code, 'PERSISTED');
    assert.equal(payload.decision.verdict, 'PASS');
    assert.equal(payload.decision.canonicalVerdict, 'APPROVED');
    assert.ok(payload.filePath.endsWith('.json'));
    const filename = path.basename(payload.filePath);
    assert.ok(filename.startsWith('duongpdddic-droid_soc_brain_Issue-43_PR-43_abcdef1_'), 'filename prefix: ' + filename);
    assert.equal(filename.length, 'duongpdddic-droid_soc_brain_Issue-43_PR-43_abcdef1_'.length + 12 + '.json'.length);
    const st = fs.lstatSync(payload.filePath);
    assert.equal(st.isFile(), true);
    assert.equal(st.isSymbolicLink(), false);
    assert.ok(st.size > 0 && st.size <= 256 * 1024);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('positive: replay identical submission returns DUPLICATE_NOOP (AC: idempotency)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    const req = makeRequest(art, { verdict: 'REWORK' });
    const r1 = JSON.parse(call(s, TOOL_NAMES.submitDecision, req).result.content[0].text);
    const r2 = JSON.parse(call(s, TOOL_NAMES.submitDecision, req).result.content[0].text);
    assert.equal(r1.persisted, true);
    assert.equal(r2.persisted, false);
    assert.equal(r2.code, 'DUPLICATE_NOOP');
    assert.equal(r1.filePath, r2.filePath);
    assert.equal(r1.decision.payloadDigest, r2.decision.payloadDigest);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('positive: verdict enum mapping boundary → canonical (AC: verdict mapping)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const cases = [
      { v: 'PASS', c: 'APPROVED' },
      { v: 'REWORK', c: 'CHANGES_REQUESTED' },
      { v: 'BLOCKED', c: 'BLOCKED' },
    ];
    for (const { v, c } of cases) {
      const sub = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
      try {
        const a = writeFakeReviewReady(sub);
        const ss = makeServer({ baseDir: sub });
        const r = JSON.parse(call(ss, TOOL_NAMES.submitDecision, makeRequest(a, { verdict: v })).result.content[0].text);
        assert.equal(r.decision.verdict, v);
        assert.equal(r.decision.canonicalVerdict, c);
      } finally { fs.rmSync(sub, { recursive: true, force: true }); }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('positive: secret-like submittedBy is redacted in persisted file (AC: redactSecrets applied)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    const req = makeRequest(art, {
      verdict: 'REWORK',
      submittedBy: 'agent: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789XX',
    });
    const r = JSON.parse(call(s, TOOL_NAMES.submitDecision, req).result.content[0].text);
    assert.equal(r.persisted, true);
    const onDisk = fs.readFileSync(r.filePath, 'utf8');
    assert.ok(onDisk.includes('Bearer [REDACTED]'), 'bearer redacted in disk file');
    assert.ok(!onDisk.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789XX'), 'raw token not on disk');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- NEGATIVE TESTS (fail-closed) ------------------------------------------
function expectErrorCode(res, code) {
  assert.ok(res.error, 'expected error response');
  const te = res.error.data && res.error.data.toolError;
  if (te === code) return; // single-code path
  if (te === 'VALIDATION_FAILED') {
    const codes = (res.error.data.errors || []).map((e) => e.code);
    assert.ok(codes.includes(code), `expected code=${code} in errors[], got ${JSON.stringify(codes)}`);
    return;
  }
  assert.fail(`expected toolError=${code} or VALIDATION_FAILED containing ${code}, got ${JSON.stringify(res.error.data)}`);
}

test('negative: ARGS_INVALID when args not object (AC: ARGS_INVALID)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const s = makeServer({ baseDir: tmp });
    const r = call(s, TOOL_NAMES.submitDecision, null);
    expectErrorCode(r, 'ARGS_INVALID');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('negative: REPO_INVALID (AC: REPO_INVALID)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    const r = call(s, TOOL_NAMES.submitDecision, { ...makeRequest(writeFakeReviewReady(tmp)), repository: '../etc' });
    expectErrorCode(r, 'REPO_INVALID');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('negative: ISSUE_INVALID (AC: ISSUE_INVALID)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    const r = call(s, TOOL_NAMES.submitDecision, { ...makeRequest(art), issue: 'banana' });
    expectErrorCode(r, 'ISSUE_INVALID');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('negative: HEAD_SHA_INVALID (AC: HEAD_SHA_INVALID)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    const r = call(s, TOOL_NAMES.submitDecision, { ...makeRequest(art), headSha: 'abc' });
    expectErrorCode(r, 'HEAD_SHA_INVALID');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('negative: VERDICT_INVALID (AC: VERDICT_INVALID)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    const r = call(s, TOOL_NAMES.submitDecision, { ...makeRequest(art), verdict: 'APPROVED' });
    expectErrorCode(r, 'VERDICT_INVALID');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('negative: REQUEST_DIGEST_INVALID + CONTENT_DIGEST_INVALID (AC: digest validation)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    const r = call(s, TOOL_NAMES.submitDecision, { ...makeRequest(art), requestDigest: 'nope', contentDigest: 'nope' });
    assert.equal(r.error.data.toolError, 'VALIDATION_FAILED');
    const codes = r.error.data.errors.map((e) => e.code).sort();
    assert.ok(codes.includes('REQUEST_DIGEST_INVALID'));
    assert.ok(codes.includes('CONTENT_DIGEST_INVALID'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('negative: FINDINGS_TOO_MANY, FINDING_TEXT_TOO_LARGE, FINDINGS_NOT_ARRAY (AC: findings bounds)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    // not array
    let r = call(s, TOOL_NAMES.submitDecision, { ...makeRequest(art), findings: 'nope' });
    expectErrorCode(r, 'FINDINGS_NOT_ARRAY');
    // too many (65)
    r = call(s, TOOL_NAMES.submitDecision, {
      ...makeRequest(art),
      findings: Array.from({ length: 65 }, (_, i) => ({ severity: 'low', text: `f${i}` })),
    });
    expectErrorCode(r, 'FINDINGS_TOO_MANY');
    // single finding too large
    r = call(s, TOOL_NAMES.submitDecision, {
      ...makeRequest(art),
      findings: [{ severity: 'low', text: 'x'.repeat(9 * 1024) }],
    });
    expectErrorCode(r, 'FINDING_TEXT_TOO_LARGE');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('negative: EVIDENCE_REQUESTS_TOO_MANY / NOTE_TOO_LARGE (AC: evidenceRequests bounds)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    let r = call(s, TOOL_NAMES.submitDecision, {
      ...makeRequest(art),
      evidenceRequests: Array.from({ length: 33 }, () => ({ kind: 'log', note: 'x' })),
    });
    expectErrorCode(r, 'EVIDENCE_REQUESTS_TOO_MANY');
    r = call(s, TOOL_NAMES.submitDecision, {
      ...makeRequest(art),
      evidenceRequests: [{ kind: 'log', note: 'x'.repeat(3 * 1024) }],
    });
    expectErrorCode(r, 'EVIDENCE_REQUEST_NOTE_TOO_LARGE');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('negative: METADATA_TOO_DEEP, METADATA_TOO_LARGE, METADATA_NOT_OBJECT (AC: metadata)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    let r = call(s, TOOL_NAMES.submitDecision, { ...makeRequest(art), metadata: { nested: { a: 1 } } });
    expectErrorCode(r, 'METADATA_TOO_DEEP');
    r = call(s, TOOL_NAMES.submitDecision, { ...makeRequest(art), metadata: 'string' });
    expectErrorCode(r, 'METADATA_NOT_OBJECT');
    r = call(s, TOOL_NAMES.submitDecision, { ...makeRequest(art), metadata: { big: 'x'.repeat(5 * 1024) } });
    expectErrorCode(r, 'METADATA_TOO_LARGE');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('negative: CONFIDENCE_OUT_OF_RANGE (AC: confidence bounds)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    let r = call(s, TOOL_NAMES.submitDecision, { ...makeRequest(art), confidence: 1.5 });
    expectErrorCode(r, 'CONFIDENCE_OUT_OF_RANGE');
    r = call(s, TOOL_NAMES.submitDecision, { ...makeRequest(art), confidence: -0.1 });
    expectErrorCode(r, 'CONFIDENCE_OUT_OF_RANGE');
    r = call(s, TOOL_NAMES.submitDecision, { ...makeRequest(art), confidence: 'high' });
    expectErrorCode(r, 'CONFIDENCE_OUT_OF_RANGE');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('negative: SUBMITTED_BY_INVALID (AC: submittedBy bounds)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    const r = call(s, TOOL_NAMES.submitDecision, { ...makeRequest(art), submittedBy: '' });
    expectErrorCode(r, 'SUBMITTED_BY_INVALID');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('negative: REQUEST_DIGEST_MISMATCH (AC: requestDigest must match artifact)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    const fakeReportDigest = createHash('sha256').update('not-the-real-one', 'utf8').digest('hex');
    const r = call(s, TOOL_NAMES.submitDecision, { ...makeRequest(art), requestDigest: fakeReportDigest });
    expectErrorCode(r, 'REQUEST_DIGEST_MISMATCH');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('negative: CONTENT_DIGEST_MISMATCH (AC: contentDigest must match artifact bytes)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    const fakeContentDigest = createHash('sha256').update('tampered', 'utf8').digest('hex');
    const r = call(s, TOOL_NAMES.submitDecision, { ...makeRequest(art), contentDigest: fakeContentDigest });
    expectErrorCode(r, 'CONTENT_DIGEST_MISMATCH');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('negative: ARTIFACT_NOT_READY when terminal status != READY_FOR_REVIEW (AC: pre-gated artifact only)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp, { status: 'BLOCKED' });
    const s = makeServer({ baseDir: tmp });
    const r = call(s, TOOL_NAMES.submitDecision, makeRequest(art));
    expectErrorCode(r, 'ARTIFACT_NOT_READY');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('negative: ARTIFACT_IS_SYMLINK when decisions subdir is a symlink (AC: refuse symlinks)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-target-'));
  try {
    const art = writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    const decDir = path.join(tmp, '_decisions');
    try { fs.rmSync(decDir, { recursive: true, force: true }); } catch { /* ignore */ }
    fs.symlinkSync(target, decDir, 'dir');
    const r = call(s, TOOL_NAMES.submitDecision, makeRequest(art));
    expectErrorCode(r, 'ARTIFACT_IS_SYMLINK');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});


test('negative: DUPLICATE_CONFLICT when same path has different payload (AC: idempotency conflict path)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    const base = makeRequest(art, { verdict: 'REWORK' });
    const r1 = JSON.parse(call(s, TOOL_NAMES.submitDecision, base).result.content[0].text);
    assert.equal(r1.persisted, true);
    const different = { ...base, verdict: 'PASS' };
    const r2 = call(s, TOOL_NAMES.submitDecision, different);
    expectErrorCode(r2, 'DUPLICATE_CONFLICT');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('negative: BOUNDED_PAYLOAD_EXCEEDED via FINDINGS_TOTAL_TOO_LARGE (AC: hard 64 KiB findings cap)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    const big = 'x'.repeat(8 * 1024);
    const r = call(s, TOOL_NAMES.submitDecision, {
      ...makeRequest(art),
      findings: Array.from({ length: 9 }, () => ({ severity: 'low', text: big })),
    });
    expectErrorCode(r, 'FINDINGS_TOTAL_TOO_LARGE');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('negative: DECISION_PERSIST_FAILED when target path collides with existing directory (AC: write-time guard)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    const base = makeRequest(art, { verdict: 'REWORK' });
    const r1 = JSON.parse(call(s, TOOL_NAMES.submitDecision, base).result.content[0].text);
    assert.equal(r1.persisted, true);
    const decDir = path.join(tmp, '_decisions');
    const filename = path.basename(r1.filePath);
    fs.unlinkSync(r1.filePath);
    fs.mkdirSync(path.join(decDir, filename));
    const r2 = call(s, TOOL_NAMES.submitDecision, base);
    expectErrorCode(r2, 'DECISION_PERSIST_FAILED');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('inputSchema: submitDecision advertises additionalProperties:false (AC: schema-level reject hint)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const s = makeServer({ baseDir: tmp });
    const sub = s.handleRequest({ id: 1, method: 'tools/list' }).result.tools.find(t => t.name === TOOL_NAMES.submitDecision);
    assert.equal(sub.inputSchema.additionalProperties, false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ---- GPT-REV-135: PR != Issue binding -----------------------------------------
// Regression: buildDecisionFilename MUST use pullRequest from the canonical
// artifact, not identity.issue. PR and Issue are independent GitHub entities.
test('GPT-REV-135: decision path binds canonical pullRequest from artifact (PR=99, Issue=43)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp, { issue: 43, pr: 99 });
    const s = makeServer({ baseDir: tmp });
    const r = JSON.parse(call(s, TOOL_NAMES.submitDecision, makeRequest(art, { verdict: 'PASS' })).result.content[0].text);
    assert.equal(r.persisted, true);
    const filename = path.basename(r.filePath);
    assert.ok(filename.includes('_Issue-43_PR-99_'), 'filename must bind PR from artifact, got: ' + filename);
    assert.ok(!filename.includes('_PR-43_'), 'filename must NOT alias issue as PR, got: ' + filename);
    const onDisk = JSON.parse(fs.readFileSync(r.filePath, 'utf8'));
    assert.equal(onDisk.identity.pullRequest, 99);
    assert.equal(onDisk.identity.issue, 43);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('GPT-REV-135: PR_MISSING_IN_ARTIFACT fail-closed when artifact has no pullRequest', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    fs.mkdirSync(tmp, { recursive: true });
    const slug = REPO.replace(/\//g, '_');
    const shortHead = HEAD.slice(0, 7);
    const filename = `${slug}_Issue-${ISSUE}_PR-1_${shortHead}_review-ready.md`;
    const filePath = path.join(tmp, filename);
    const reportDigest = createHash('sha256').update(`no-pr-${filePath}`, 'utf8').digest('hex');
    const content =
      `# Review Ready\n\n## Identity\n` +
      `- repository: ${REPO}\n` +
      `- issue: ${ISSUE}\n` +
      `- headSha: ${HEAD} (short ${shortHead})\n` +
      `- reportDigest: ${reportDigest}\n` +
      `- status: **READY_FOR_REVIEW**\n`;
    fs.writeFileSync(filePath, content, 'utf8');
    const contentDigest = createHash('sha256').update(content, 'utf8').digest('hex');
    const s = makeServer({ baseDir: tmp });
    const r = call(s, TOOL_NAMES.submitDecision, {
      repository: REPO, issue: ISSUE, headSha: HEAD,
      requestDigest: reportDigest, contentDigest, verdict: 'PASS',
    });
    expectErrorCode(r, 'PR_MISSING_IN_ARTIFACT');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('GPT-REV-135: PR_MALFORMED_IN_ARTIFACT fail-closed on non-numeric pullRequest', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    fs.mkdirSync(tmp, { recursive: true });
    const slug = REPO.replace(/\//g, '_');
    const shortHead = HEAD.slice(0, 7);
    const filename = `${slug}_Issue-${ISSUE}_PR-1_${shortHead}_review-ready.md`;
    const filePath = path.join(tmp, filename);
    const reportDigest = createHash('sha256').update(`bad-pr-${filePath}`, 'utf8').digest('hex');
    const content =
      `# Review Ready\n\n## Identity\n` +
      `- repository: ${REPO}\n` +
      `- issue: ${ISSUE}\n` +
      `- pullRequest: not-a-number\n` +
      `- headSha: ${HEAD} (short ${shortHead})\n` +
      `- reportDigest: ${reportDigest}\n` +
      `- status: **READY_FOR_REVIEW**\n`;
    fs.writeFileSync(filePath, content, 'utf8');
    const contentDigest = createHash('sha256').update(content, 'utf8').digest('hex');
    const s = makeServer({ baseDir: tmp });
    const r = call(s, TOOL_NAMES.submitDecision, {
      repository: REPO, issue: ISSUE, headSha: HEAD,
      requestDigest: reportDigest, contentDigest, verdict: 'PASS',
    });
    expectErrorCode(r, 'PR_MALFORMED_IN_ARTIFACT');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ---- GPT-REV-136: no-clobber / DUPLICATE_NOOP / DUPLICATE_CONFLICT under EEXIST -
// Regression: prior read-existing → rename flow had a TOCTOU window where
// two concurrent submissions could both pass the read and both rename. Fixed
// flow uses linkSync (atomic EEXIST) to make the path exclusive, and
// reconciles EEXIST against the existing payload digest.
test('GPT-REV-136: pre-existing file with different payload digest → DUPLICATE_CONFLICT (no overwrite)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    const decDir = path.join(tmp, '_decisions');
    fs.mkdirSync(decDir, { recursive: true });
    // Pre-place a file at the deterministic path with a STALE digest.
    // artifact has pr=43, issue=43 by default → PR-43, Issue-43.
    const staleFilename = `duongpdddic-droid_soc_brain_Issue-43_PR-43_${HEAD.slice(0, 7)}_${art.reportDigest.slice(0, 12)}.json`;
    const stalePath = path.join(decDir, staleFilename);
    const staleRecord = {
      schemaVersion: '1.0.0',
      persistedAt: '2020-01-01T00:00:00.000Z',
      payloadDigest: 'a'.repeat(64), // wrong digest on purpose
      identity: { repository: REPO, issue: 43, headSha: HEAD, pullRequest: 43 },
      requestDigest: art.reportDigest,
      contentDigest: art.contentDigest,
      verdict: 'REWORK',
      canonicalVerdict: 'CHANGES_REQUESTED',
      findings: [], evidenceRequests: [], confidence: null, metadata: null, submittedBy: 'stale',
    };
    fs.writeFileSync(stalePath, JSON.stringify(staleRecord, null, 2), 'utf8');
    const r = call(s, TOOL_NAMES.submitDecision, makeRequest(art, { verdict: 'PASS' }));
    expectErrorCode(r, 'DUPLICATE_CONFLICT');
    // The stale file must NOT be overwritten.
    const after = JSON.parse(fs.readFileSync(stalePath, 'utf8'));
    assert.equal(after.payloadDigest, 'a'.repeat(64), 'stale digest must be preserved (no clobber)');
    assert.equal(after.persistedAt, '2020-01-01T00:00:00.000Z', 'stale timestamp must be preserved');
    assert.equal(after.verdict, 'REWORK', 'stale verdict must be preserved');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('GPT-REV-136: pre-existing file with matching payload digest → DUPLICATE_NOOP (no overwrite, mtime unchanged)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    const req = makeRequest(art, { verdict: 'PASS' });
    // First submission: persists.
    const r1 = JSON.parse(call(s, TOOL_NAMES.submitDecision, req).result.content[0].text);
    assert.equal(r1.persisted, true);
    const firstMtime = fs.lstatSync(r1.filePath).mtimeMs;
    // Wait briefly to ensure any (forbidden) rewrite would change mtime.
    const wait0 = Date.now();
    while (Date.now() - wait0 < 10) { /* spin briefly */ }
    // Second submission: must report DUPLICATE_NOOP and must NOT touch the file.
    const r2 = JSON.parse(call(s, TOOL_NAMES.submitDecision, req).result.content[0].text);
    assert.equal(r2.persisted, false);
    assert.equal(r2.code, 'DUPLICATE_NOOP');
    assert.equal(r1.filePath, r2.filePath);
    assert.equal(r1.decision.payloadDigest, r2.decision.payloadDigest);
    const secondMtime = fs.lstatSync(r1.filePath).mtimeMs;
    assert.equal(secondMtime, firstMtime, 'file mtime must be unchanged (no rewrite on NOOP)');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ---- Bound fix: UTF-8 byte counting on multibyte strings ---------------------
// Regression: prior safeString used String.length which counts UTF-16 code
// units, not UTF-8 bytes. CJK / emoji strings would slip past the cap. Bound
// is now measured in UTF-8 bytes; 8 KiB of CJK (3 bytes/char) must be rejected
// even when String.length looks small.
test('bound fix: finding.text bound is measured in UTF-8 bytes (rejects CJK above 8 KiB)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    // 8*1024/3 + 1 CJK chars = 8195 UTF-8 bytes (above 8 KiB bound).
    // String.length is 2731, well under any naive JS length limit.
    const cjk = '\u4e2d'.repeat(8 * 1024 / 3 + 1);
    assert.equal(Buffer.byteLength(cjk, 'utf8') > 8 * 1024, true, 'CJK string must exceed 8 KiB UTF-8 bound');
    const r = call(s, TOOL_NAMES.submitDecision, {
      ...makeRequest(art),
      findings: [{ severity: 'low', text: cjk }],
    });
    expectErrorCode(r, 'FINDING_TEXT_TOO_LARGE');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('bound fix: finding.text bound accepts CJK within 8 KiB UTF-8', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    // 2*1024 CJK chars = 6144 UTF-8 bytes (under 8 KiB).
    const cjk = '\u4e2d'.repeat(2 * 1024);
    assert.equal(Buffer.byteLength(cjk, 'utf8') < 8 * 1024, true);
    const r = JSON.parse(call(s, TOOL_NAMES.submitDecision, {
      ...makeRequest(art),
      findings: [{ severity: 'low', text: cjk }],
    }).result.content[0].text);
    assert.equal(r.persisted, true);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('bound fix: evidenceRequest.note bound rejects emoji above 2 KiB', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-p3-'));
  try {
    const art = writeFakeReviewReady(tmp);
    const s = makeServer({ baseDir: tmp });
    // Emoji is 4 UTF-8 bytes per code point. 600 emoji = 2400 bytes > 2 KiB.
    const emoji = '\u{1F600}'.repeat(600);
    assert.equal(Buffer.byteLength(emoji, 'utf8') > 2 * 1024, true);
    const r = call(s, TOOL_NAMES.submitDecision, {
      ...makeRequest(art),
      evidenceRequests: [{ kind: 'log', note: emoji }],
    });
    expectErrorCode(r, 'EVIDENCE_REQUEST_NOTE_TOO_LARGE');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
