#!/usr/bin/env node
// review-mcp-http.phase2.test.mjs — Soc_brain Review MCP HTTP, Phase 2 (Issue #41).
// Chứng minh: capability surface đúng 3 read-only tools; identity binding
// (repository, issue, headSha); fail-closed khi stale/cross-task/malformed/
// unavailable; bounded payload + secret-safe; KHÔNG arbitrary file/path access;
// regression review.ping; e2e HTTP loopback round-trip.
//
// Run: node --test tests/review-mcp-http.phase2.test.mjs
// Exit 0 = PASS, 1 = FAIL. No network/GitHub.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  createReviewMcp,
  startHttpServer,
  parseRequestIdentity,
  loadReviewReadyArtifact,
  buildRequestPayload,
  buildEvidencePayload,
  redactSecrets,
  TOOL_NAMES,
  TOOL_NAME,
} from '../packages/review-mcp-http/review-mcp-http.mjs';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const HEAD_OTHER = 'fedcba9876543210fedcba9876543210fedcba98';
const REPO = 'duongpdddic-droid/Soc_brain';

const TEMPS = [];
function mkTmpDir(prefix) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMPS.push(p);
  return p;
}
function rmAll() {
  for (const p of TEMPS) try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}
function artifact({ repo = REPO, issue = 41, headSha = HEAD, pr = 42, extraBody = '## Body\n\nok' } = {}) {
  return [
    `# Review Ready — ${repo} Issue #${issue} · PR #${pr}`,
    '',
    '> Projection.',
    '',
    '## Identity',
    `- repository: ${repo}`,
    `- issue: ${issue}`,
    `- pullRequest: ${pr}`,
    `- branch: agent/issue-41-review-evidence`,
    `- headSha: ${headSha} (short ${headSha.slice(0, 7)})`,
    `- baseSha: ${HEAD_OTHER}`,
    `- prState: Open`,
    '',
    '## Scope',
    '- objective: Phase 2 PoC',
    '- acceptanceCriteria:',
    '  - canonical request resolved',
    '  - bounded evidence returned',
    '',
    '## Terminal status',
    '- status: **READY_FOR_REVIEW**',
    '',
    extraBody,
  ].join('\n');
}
function filenameFor(repo, issue, headSha) {
  return `${repo.replace(/\//g, '_')}_Issue-${issue}_PR-42_${headSha.slice(0, 7)}_review-ready.md`;
}
function writeArtifact(dir, name, content) {
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, content, 'utf8');
  return fp;
}
function newId(over = {}) { return { repository: REPO, issue: 41, headSha: HEAD, ...over }; }
function postJson(url, body, extra = {}) {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname,
      headers: { 'content-type': 'application/json', 'content-length': data.length, 'accept': 'application/json, text/event-stream', ...extra },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// =============================================================================
// §1 — Capability surface (exact)
// =============================================================================
test('capability surface: read-only tools unchanged from Phase 2; review.submit_decision is the Phase 3 boundary', () => {
  const { tools } = createReviewMcp();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['review.get_evidence', 'review.get_request', 'review.ping', 'review.submit_decision']);
  // Read-only invariant applies to the three Phase 1/2 tools only; review.submit_decision
  // (Phase 3) is the explicit boundary write and is covered by its own test suite
  // (review-mcp-http.phase3.test.mjs).
  const READ_ONLY = new Set(['review.get_evidence', 'review.get_request', 'review.ping']);
  for (const t of tools) {
    if (READ_ONLY.has(t.name)) {
      assert.equal(/(exec|write|git|github|broker|runtime|submit|approve|merge|delete|deploy|push|spawn|fs|shell)/i.test(t.name), false, `read-only tool rejected: ${t.name}`);
      if (t.name === TOOL_NAME) {
        assert.deepEqual(Object.keys(t.inputSchema.properties), []);
      } else {
        assert.equal(t.inputSchema.additionalProperties, false);
        assert.deepEqual(t.inputSchema.required.sort(), ['headSha', 'issue', 'repository']);
      }
    }
  }
});

// =============================================================================
// §2 — parseRequestIdentity: malformed identity → fail-closed
// =============================================================================
test('parseRequestIdentity: rejects non-object args', () => {
  for (const bad of [null, undefined, 'x', 1, [], true]) {
    const r = parseRequestIdentity(bad);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'ARGS_INVALID');
  }
});
test('parseRequestIdentity: rejects extra fields (no arbitrary path/file/repo)', () => {
  const r = parseRequestIdentity({ repository: REPO, issue: 1, headSha: HEAD, path: '/etc/passwd' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ARGS_INVALID');
});
test('parseRequestIdentity: rejects missing fields', () => {
  const r = parseRequestIdentity({ repository: REPO, issue: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ARGS_INVALID');
});
test('parseRequestIdentity: rejects bad repo (path traversal)', () => {
  const r = parseRequestIdentity({ repository: '../../etc/passwd', issue: 1, headSha: HEAD });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'REPO_INVALID');
});
test('parseRequestIdentity: rejects bad issue (zero, negative, float, non-integer)', () => {
  for (const bad of [0, -1, 1.5, null, [], 'NaN', Infinity]) {
    const r = parseRequestIdentity({ repository: REPO, issue: bad, headSha: HEAD });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'ISSUE_INVALID');
  }
});
test('parseRequestIdentity: rejects bad headSha (short, non-hex, path)', () => {
  for (const bad of ['short', 'Z'.repeat(40), '../' + HEAD, '']) {
    const r = parseRequestIdentity({ repository: REPO, issue: 1, headSha: bad });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'HEAD_SHA_INVALID');
  }
});
test('parseRequestIdentity: accepts valid triple, normalizes headSha to lowercase', () => {
  const upper = '0123456789ABCDEF0123456789ABCDEF01234567';
  const r = parseRequestIdentity({ repository: REPO, issue: 41, headSha: upper });
  assert.equal(r.ok, true);
  assert.equal(r.identity.headSha, upper.toLowerCase());
  assert.equal(r.identity.repository, REPO);
  assert.equal(r.identity.issue, 41);
});

// =============================================================================
// §3 — loadReviewReadyArtifact: resolve + stale-HEAD + cross-task guards
// =============================================================================
test('loadReviewReadyArtifact: valid identity resolves canonical file', () => {
  const dir = mkTmpDir('rr-ok-');
  const id = newId();
  const fn = filenameFor(id.repository, id.issue, id.headSha);
  writeArtifact(dir, fn, artifact());
  const r = loadReviewReadyArtifact(id, { dir });
  assert.equal(r.ok, true);
  assert.equal(r.filename, fn);
  assert.ok(r.content.includes('headSha: ' + id.headSha));
});
test('loadReviewReadyArtifact: artifact missing -> ARTIFACT_NOT_FOUND', () => {
  const dir = mkTmpDir('rr-miss-');
  const r = loadReviewReadyArtifact(newId(), { dir });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ARTIFACT_NOT_FOUND');
});
test('loadReviewReadyArtifact: stale HEAD (file exists but headSha mismatches) -> HEAD_SHA_MISMATCH', () => {
  const dir = mkTmpDir('rr-stale-');
  const id = newId();
  const fn = filenameFor(id.repository, id.issue, id.headSha);
  writeArtifact(dir, fn, artifact({ headSha: HEAD_OTHER }));
  const r = loadReviewReadyArtifact(id, { dir });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'HEAD_SHA_MISMATCH');
});
test('loadReviewReadyArtifact: wrong repo in file -> REPO_MISMATCH', () => {
  const dir = mkTmpDir('rr-repo-');
  const id = newId();
  const fn = filenameFor(id.repository, id.issue, id.headSha);
  writeArtifact(dir, fn, artifact({ repo: 'attacker/evil' }));
  const r = loadReviewReadyArtifact(id, { dir });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'REPO_MISMATCH');
});
test('loadReviewReadyArtifact: wrong issue in file -> ISSUE_MISMATCH', () => {
  const dir = mkTmpDir('rr-issue-');
  const id = newId();
  const fn = filenameFor(id.repository, id.issue, id.headSha);
  writeArtifact(dir, fn, artifact({ issue: 999 }));
  const r = loadReviewReadyArtifact(id, { dir });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ISSUE_MISMATCH');
});
test('loadReviewReadyArtifact: oversized file -> BOUNDED_PAYLOAD_EXCEEDED', () => {
  const dir = mkTmpDir('rr-big-');
  const id = newId();
  const fn = filenameFor(id.repository, id.issue, id.headSha);
  const content = artifact() + '\n' + 'A'.repeat(300 * 1024); // 300KB > 256KB
  writeArtifact(dir, fn, content);
  const r = loadReviewReadyArtifact(id, { dir });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BOUNDED_PAYLOAD_EXCEEDED');
});

// GPT-REV-134: artifact entry phải là regular file trực tiếp, KHÔNG được là
// symbolic link (chặn follow symlink tới file ngoài canonical dir).
test('loadReviewReadyArtifact: canonical regular file -> ok (regression baseline)', () => {
  const dir = mkTmpDir('rr-sym-ok-');
  const id = newId();
  const fn = filenameFor(id.repository, id.issue, id.headSha);
  writeArtifact(dir, fn, artifact());
  const r = loadReviewReadyArtifact(id, { dir });
  assert.equal(r.ok, true);
  assert.equal(r.filename, fn);
});
test('loadReviewReadyArtifact: symlink -> external regular file -> ARTIFACT_IS_SYMLINK', () => {
  const dir = mkTmpDir('rr-sym-ext-');
  // target file nằm NGOÀI canonical dir (chứa headSha giả mạo khác).
  const outside = mkTmpDir('rr-sym-target-');
  const targetFp = path.join(outside, 'malicious.md');
  fs.writeFileSync(targetFp, 'this file should never be readable through symlink', 'utf8');
  const id = newId();
  const fn = filenameFor(id.repository, id.issue, id.headSha);
  const linkFp = path.join(dir, fn);
  try {
    fs.symlinkSync(targetFp, linkFp);
  } catch (e) {
    // Some Windows runtimes without developer mode can't create symlinks.
    // Skip silently (test should not flake on platforms without symlink support).
    return;
  }
  const r = loadReviewReadyArtifact(id, { dir });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ARTIFACT_IS_SYMLINK');
});
test('loadReviewReadyArtifact: symlink -> file inside canonical dir -> ARTIFACT_IS_SYMLINK', () => {
  const dir = mkTmpDir('rr-sym-int-');
  // Một file regular hợp lệ đặt ở canonical dir nhưng dưới tên không match pattern
  // (để chứng minh kể cả khi symlink trỏ tới file trong cùng dir vẫn bị reject).
  const otherFp = path.join(dir, 'decoy.md');
  fs.writeFileSync(otherFp, 'decoy', 'utf8');
  const id = newId();
  const fn = filenameFor(id.repository, id.issue, id.headSha);
  const linkFp = path.join(dir, fn);
  try {
    fs.symlinkSync(otherFp, linkFp);
  } catch (e) {
    return; // skip on platforms without symlink support
  }
  const r = loadReviewReadyArtifact(id, { dir });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ARTIFACT_IS_SYMLINK');
});

// =============================================================================
// §4 — No arbitrary file/path access
// =============================================================================
test('no arbitrary file access: browser cannot smuggle path/file/repo', () => {
  // path field bị reject bởi ARGS_INVALID (extra field).
  const r1 = parseRequestIdentity({ repository: REPO, issue: 41, headSha: HEAD, path: '/etc/passwd' });
  assert.equal(r1.ok, false);
  // headSha chứa path traversal bị reject.
  const r2 = parseRequestIdentity({ repository: REPO, issue: 41, headSha: '../' + HEAD });
  assert.equal(r2.ok, false);
  // repo path traversal bị reject.
  const r3 = parseRequestIdentity({ repository: '../../etc/passwd', issue: 41, headSha: HEAD });
  assert.equal(r3.ok, false);
  // repo chứa dot-dot bị reject (segment ..) .
  const r4 = parseRequestIdentity({ repository: '../etc', issue: 41, headSha: HEAD });
  assert.equal(r4.ok, false);
  // repo segment bắt đầu . bị reject (ẩn file).
  const r5 = parseRequestIdentity({ repository: '.hidden/repo', issue: 41, headSha: HEAD });
  assert.equal(r5.ok, false);
});
test('no arbitrary file access: filename traversal cannot be coerced; canonical filename still required', () => {
  const dir = mkTmpDir('rr-trav-');
  // Identity valid nhưng canonical filename không tồn tại → ARTIFACT_NOT_FOUND.
  const r = loadReviewReadyArtifact(newId(), { dir });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ARTIFACT_NOT_FOUND');
});

// =============================================================================
// §5 — buildRequestPayload: valid canonical request, no evidence body re-exposed
// =============================================================================
test('buildRequestPayload: extracts identity + terminalStatus + objective', () => {
  const dir = mkTmpDir('rr-req-');
  const id = newId();
  const fn = filenameFor(id.repository, id.issue, id.headSha);
  writeArtifact(dir, fn, artifact());
  const r = buildRequestPayload(id, { dir });
  assert.equal(r.ok, true);
  assert.equal(r.request.identity.headSha, id.headSha);
  assert.equal(r.request.artifact.filename, fn);
  assert.equal(r.request.artifact.terminalStatus, 'READY_FOR_REVIEW');
  assert.equal(r.request.artifact.objective, 'Phase 2 PoC');
  assert.ok(r.request.artifact.acceptanceCriteria.includes('canonical request resolved'));
  // KHÔNG re-expose evidence body tại get_request.
  assert.equal(r.request.artifact.content, undefined);
  assert.equal(r.request.content, undefined);
});
test('buildRequestPayload: fails closed for cross-task (different issue) identity', () => {
  const dir = mkTmpDir('rr-cross-');
  const id = newId();
  const fn = filenameFor(id.repository, 99, id.headSha); // wrong issue
  writeArtifact(dir, fn, artifact({ issue: 99, pr: 99 }));
  const r = buildRequestPayload(id, { dir });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ARTIFACT_NOT_FOUND');
});

// =============================================================================
// §6 — buildEvidencePayload: bounded + secret-safe
// =============================================================================
test('buildEvidencePayload: returns bounded markdown content', () => {
  const dir = mkTmpDir('rr-ev-');
  const id = newId();
  const fn = filenameFor(id.repository, id.issue, id.headSha);
  const content = artifact();
  writeArtifact(dir, fn, content);
  const r = buildEvidencePayload(id, { dir });
  assert.equal(r.ok, true);
  assert.equal(r.evidence.contentType, 'text/markdown');
  assert.equal(r.evidence.content, content);
  assert.equal(r.evidence.artifact.bytes, Buffer.byteLength(content, 'utf8'));
});
test('redactSecrets: Bearer + GitHub PAT + Google API + AWS + Slack redacted', () => {
  const sample = [
    'Authorization: Bearer abc123def456ghi789jkl012mno345pqr',
    'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'oauth: gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'pat: github_pat_11AAAAAAA0AAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'google: AIzaSyA-aBcDeFgHiJkLmNoPqRsTuVwXyZ01234567',
    'aws: AKIAIOSFODNN7EXAMPLE',
    'slack: xoxb-1234567890-1234567890-abcdefghijklmnopqrstuvwx',
  ].join('\n');
  const r = redactSecrets(sample);
  assert.equal(r.includes('abc123def456ghi789jkl012mno345pqr'), false);
  assert.equal(r.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), false);
  assert.equal(r.includes('gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'), false);
  assert.equal(r.includes('AIzaSyA-aBcDeFgHiJkLmNoPqRsTuVwXyZ01234567'), false);
  assert.equal(r.includes('AKIAIOSFODNN7EXAMPLE'), false);
  assert.equal(r.includes('xoxb-1234567890-1234567890-abcdefghijklmnopqrstuvwx'), false);
  assert.ok(r.includes('[REDACTED]'));
});
test('buildEvidencePayload: applies redactSecrets to content', () => {
  const dir = mkTmpDir('rr-red-');
  const id = newId();
  const fn = filenameFor(id.repository, id.issue, id.headSha);
  const content = artifact({ extraBody: 'Authorization: Bearer abc123def456ghi789jkl012mno345pqr' });
  writeArtifact(dir, fn, content);
  const r = buildEvidencePayload(id, { dir });
  assert.equal(r.ok, true);
  assert.equal(r.evidence.content.includes('abc123def456ghi789jkl012mno345pqr'), false);
  assert.ok(r.evidence.content.includes('[REDACTED]'));
});
test('buildEvidencePayload: cross-repo identity -> ARTIFACT_NOT_FOUND (no read)', () => {
  const dir = mkTmpDir('rr-xrepo-');
  const id = newId({ repository: 'attacker/evil' });
  // Không file nào tồn tại cho repo lạ.
  const r = buildEvidencePayload(id, { dir });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ARTIFACT_NOT_FOUND');
});
test('buildEvidencePayload: stale HEAD -> HEAD_SHA_MISMATCH', () => {
  const dir = mkTmpDir('rr-stale2-');
  const id = newId();
  const fn = filenameFor(id.repository, id.issue, id.headSha);
  writeArtifact(dir, fn, artifact({ headSha: HEAD_OTHER }));
  const r = buildEvidencePayload(id, { dir });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'HEAD_SHA_MISMATCH');
});

// =============================================================================
// §7 — JSON-RPC handler integration (in-process)
// =============================================================================
test('handler: review.get_request valid identity returns request payload', () => {
  const dir = mkTmpDir('rr-h-');
  const id = newId();
  const fn = filenameFor(id.repository, id.issue, id.headSha);
  writeArtifact(dir, fn, artifact());
  const { handleRequest } = createReviewMcp({ requestDir: dir });
  const res = handleRequest({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'review.get_request', arguments: id } });
  assert.equal(res.result.isError, false);
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.request.identity.headSha, id.headSha);
});
test('handler: review.get_evidence valid identity returns bounded content', () => {
  const dir = mkTmpDir('rr-he-');
  const id = newId();
  const fn = filenameFor(id.repository, id.issue, id.headSha);
  writeArtifact(dir, fn, artifact());
  const { handleRequest } = createReviewMcp({ requestDir: dir });
  const res = handleRequest({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'review.get_evidence', arguments: id } });
  assert.equal(res.result.isError, false);
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.ok, true);
  assert.ok(payload.evidence.content.includes('## Identity'));
});
test('handler: review.get_request missing artifact -> toolError ARTIFACT_NOT_FOUND', () => {
  const dir = mkTmpDir('rr-miss2-');
  const { handleRequest } = createReviewMcp({ requestDir: dir });
  const res = handleRequest({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'review.get_request', arguments: newId() } });
  assert.equal(res.error.code, -32602);
  assert.equal(res.error.data.toolError, 'ARTIFACT_NOT_FOUND');
});
test('handler: review.get_request malformed identity -> toolError ARGS_INVALID', () => {
  const { handleRequest } = createReviewMcp();
  const res = handleRequest({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'review.get_request', arguments: { repository: REPO, issue: 1 } } });
  assert.equal(res.error.code, -32602);
  assert.equal(res.error.data.toolError, 'ARGS_INVALID');
});
test('handler: review.get_evidence cross-task -> toolError ARTIFACT_NOT_FOUND', () => {
  const dir = mkTmpDir('rr-cross2-');
  const id = newId();
  const fn = filenameFor(id.repository, 99, id.headSha);
  writeArtifact(dir, fn, artifact({ issue: 99, pr: 99 }));
  const { handleRequest } = createReviewMcp({ requestDir: dir });
  const res = handleRequest({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'review.get_evidence', arguments: id } });
  assert.equal(res.error.code, -32602);
  assert.equal(res.error.data.toolError, 'ARTIFACT_NOT_FOUND');
});
test('handler: unknown tool name -> Unknown tool error', () => {
  const { handleRequest } = createReviewMcp();
  const res = handleRequest({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'review.write_decision', arguments: { pass: true } } });
  assert.equal(res.error.code, -32602);
  assert.match(res.error.message, /Unknown tool/);
});
test('handler: review.ping still works (regression)', () => {
  const { handleRequest } = createReviewMcp();
  const res = handleRequest({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'review.ping', arguments: {} } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.deepEqual(payload, { ok: true, service: 'soc_brain', mode: 'review-readonly' });
});
test('handler: review.get_evidence with secret-bearing content -> redacted in payload', () => {
  const dir = mkTmpDir('rr-red2-');
  const id = newId();
  const fn = filenameFor(id.repository, id.issue, id.headSha);
  writeArtifact(dir, fn, artifact({ extraBody: 'curl -H "Authorization: Bearer abc123def456ghi789jkl012mno345pqr"' }));
  const { handleRequest } = createReviewMcp({ requestDir: dir });
  const res = handleRequest({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'review.get_evidence', arguments: id } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.evidence.content.includes('abc123def456ghi789jkl012mno345pqr'), false);
  assert.ok(payload.evidence.content.includes('[REDACTED]'));
});

// =============================================================================
// §8 — End-to-end HTTP round-trip on real loopback
// =============================================================================
test('http: review.get_request + review.get_evidence round-trip on real loopback', async () => {
  const dir = mkTmpDir('rr-http-');
  const id = newId();
  const fn = filenameFor(id.repository, id.issue, id.headSha);
  writeArtifact(dir, fn, artifact());

  const s = await startHttpServer({ host: '127.0.0.1', port: 0, requestDir: dir });
  try {
    const init = await postJson(s.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(init.status, 200);
    const sessionId = init.headers['mcp-session-id'];

    const list = await postJson(s.url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'mcp-session-id': sessionId });
    const listBody = JSON.parse(list.body);
    const names = listBody.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['review.get_evidence', 'review.get_request', 'review.ping', 'review.submit_decision']);

    const req = await postJson(s.url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'review.get_request', arguments: id } }, { 'mcp-session-id': sessionId });
    const reqBody = JSON.parse(req.body);
    assert.equal(reqBody.result.isError, false);
    const reqPayload = JSON.parse(reqBody.result.content[0].text);
    assert.equal(reqPayload.request.identity.headSha, id.headSha);
    assert.equal(reqPayload.request.artifact.terminalStatus, 'READY_FOR_REVIEW');

    const ev = await postJson(s.url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'review.get_evidence', arguments: id } }, { 'mcp-session-id': sessionId });
    const evBody = JSON.parse(ev.body);
    assert.equal(evBody.result.isError, false);
    const evPayload = JSON.parse(evBody.result.content[0].text);
    assert.ok(evPayload.evidence.content.includes('## Identity'));
  } finally {
    await s.close();
  }
});

test('http: review.get_request with malformed identity -> toolError JSON-RPC', async () => {
  const s = await startHttpServer({ host: '127.0.0.1', port: 0 });
  try {
    const init = await postJson(s.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const sessionId = init.headers['mcp-session-id'];
    const r = await postJson(s.url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'review.get_request', arguments: { repository: '../etc', issue: 1, headSha: HEAD } } }, { 'mcp-session-id': sessionId });
    const body = JSON.parse(r.body);
    assert.equal(body.error.code, -32602);
    assert.equal(body.error.data.toolError, 'REPO_INVALID');
  } finally { await s.close(); }
});

test('http: review.get_evidence with stale HEAD -> HEAD_SHA_MISMATCH', async () => {
  const dir = mkTmpDir('rr-http-stale-');
  const id = newId();
  const fn = filenameFor(id.repository, id.issue, id.headSha);
  writeArtifact(dir, fn, artifact({ headSha: HEAD_OTHER }));
  const s = await startHttpServer({ host: '127.0.0.1', port: 0, requestDir: dir });
  try {
    const init = await postJson(s.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const sessionId = init.headers['mcp-session-id'];
    const r = await postJson(s.url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'review.get_evidence', arguments: id } }, { 'mcp-session-id': sessionId });
    const body = JSON.parse(r.body);
    assert.equal(body.error.code, -32602);
    assert.equal(body.error.data.toolError, 'HEAD_SHA_MISMATCH');
  } finally { await s.close(); }
});

// cleanup at process exit.
process.on('exit', () => { try { rmAll(); } catch (_) {} });

