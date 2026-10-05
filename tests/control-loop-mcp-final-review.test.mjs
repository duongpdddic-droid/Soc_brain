#!/usr/bin/env node
// control-loop-mcp-final-review.test.mjs - MCP final-review leg.
//
// Verdict của FINAL_REVIEW chỉ đi qua <packetDir>/_decisions (GPT submit qua
// review-mcp-http); Web2API chỉ nhận activation prompt ĐÚNG MỘT LẦN mỗi lượt
// review và text reply (ack) KHÔNG BAO GIỜ là verdict.
// 100% offline: fake activation transport, temp dirs - không HTTP/CDP thật.
//
// Coverage:
//   A. resolveReviewVia / parsePacketMeta / buildMcpActivationPrompt /
//      expectedDecisionPath / validateMcpDecision (binding, HEAD, digest
//      canonical, stale, duplicate, verdict boundary).
//   B. createMcpFinalReview: dir alignment fail-closed, missing reportDigest
//      không được kích hoạt, happy path 1 activation, ack-không-phải-verdict
//      timeout, resume trong cùng cửa sổ KHÔNG gửi trùng activation, quyết
//      định có sẵn consume không kích hoạt lại, stale/exhausted/activation
//      failed fail-closed.
//   C. Wiring bin/soc-control-loop.mjs: SOC_FINAL_REVIEW_VIA invalid fail-
//      closed trước FSM; via=mcp end-to-end (packet project CÓ reportDigest,
//      đúng 1 activation, PASS vào FINAL_REVIEW -> DECIDING).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MCP_REVIEW_CODES,
  MCP_MAX_ACTIVATIONS,
  resolveReviewVia,
  sha256Hex,
  parsePacketMeta,
  buildMcpActivationPrompt,
  expectedDecisionPath,
  validateMcpDecision,
  createMcpFinalReview,
  attemptPhase,
  hasValidActivation,
} from '../packages/control-loop/mcp-final-review.mjs';
import { computePayloadDigest, buildDecisionFilename } from '../packages/review-mcp-http/submit-decision.mjs';
import { runSocControlLoop } from '../bin/soc-control-loop.mjs';
import { readTransitions } from '../packages/control-loop/control-loop.mjs';
import {
  identityHash, worktreePathFor, worktreeBranchFor, bindingPathFor,
} from '../packages/workspace/workspace.mjs';

const REPO = 'duongpdddic-droid/soc_brain';
const ISSUE = 77;
const PR = 78;
const HEAD = 'a'.repeat(40);
const BASE = 'f'.repeat(40);

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mcpfr-')); }

// ---- fixtures ---------------------------------------------------------------
function packetText({
  repo = REPO, issue = ISSUE, pr = PR, head = HEAD,
  reportDigest = sha256Hex('report-v1'), status = 'READY_FOR_REVIEW',
} = {}) {
  const lines = [
    `# Review Ready - ${repo} Issue #${issue} - PR #${pr}`,
    '',
    '## Identity',
    `- repository: ${repo}`,
    `- issue: ${issue}`,
    `- pullRequest: ${pr}`,
    `- headSha: ${head} (short ${head.slice(0, 7)})`,
    `- baseSha: ${BASE}`,
    '- prState: OPEN',
    '',
    '## Scope',
    '- 1. note=scope under review',
    '',
    '## Code evidence',
    '- 1. commits=abc1234 - files=3 - diffStat=+120/-22',
    '',
    '## Finding resolution',
    '- 1. note=first canonical pass',
    '',
    '## Tests',
    '- 1. testExecution=87/87 passed - exitCode=0',
    '',
    '## Verification',
    '- 1. legacyEvidenceVerify=PASS',
    '',
    '## Safety and mutation analysis',
    '- 1. controlLoopTrace=PRE_REVIEWING->FINAL_REVIEWING (ok)',
    '',
    '## Unverified risks',
    '- 1. semantic review pending',
    '',
    '## Delivery',
    `- 1. pr=${pr} - prState=OPEN - baseBranch=main`,
    '',
    '## Terminal status',
    `- status: **${status}**`,
    '',
  ];
  if (reportDigest) {
    // dòng top-level, regex consumer: /^- reportDigest:\s*([0-9a-f]{64})\s*$/m
    lines.splice(11, 0, `- reportDigest: ${reportDigest}`);
  }
  return lines.join('\n');
}

function packetFileName({ repo = REPO, issue = ISSUE, pr = PR, head = HEAD } = {}) {
  const slug = repo.replace(/\//g, '_').replace(/[^A-Za-z0-9._-]+/g, '_');
  return `${slug}_Issue-${issue}_PR-${pr}_${head.slice(0, 7)}_review-ready.md`;
}

function writePacket(packetDir, opts = {}) {
  fs.mkdirSync(packetDir, { recursive: true });
  const content = packetText(opts);
  const filePath = path.join(packetDir, packetFileName(opts));
  fs.writeFileSync(filePath, content, 'utf8');
  return { content, filePath };
}

function readMeta(content) {
  const r = parsePacketMeta(content);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.meta;
}

function mkDecisionRecord({
  meta, contentDigest, verdict = 'PASS',
  persistedAt = new Date().toISOString(),
  findings = [], evidenceRequests = [], confidence = 0.9,
  submittedBy = 'chatgpt-plus-mcp', identity = null, requestDigest = null,
  contentDigestOverride = null, canonicalVerdict = null, metadata = {},
}) {
  const canonicalMap = { PASS: 'APPROVED', REWORK: 'CHANGES_REQUESTED', BLOCKED: 'BLOCKED' };
  const base = {
    identity: identity || {
      repository: meta.repository,
      issue: meta.issue,
      pullRequest: meta.pullRequest,
      headSha: meta.headSha,
    },
    requestDigest: requestDigest !== null ? requestDigest : meta.requestDigest,
    contentDigest: contentDigestOverride !== null ? contentDigestOverride : contentDigest,
    verdict,
    canonicalVerdict: canonicalVerdict !== null ? canonicalVerdict : canonicalMap[verdict],
    findings,
    evidenceRequests,
    confidence,
    metadata,
    submittedBy,
  };
  return {
    schemaVersion: '1.0.0',
    persistedAt,
    payloadDigest: computePayloadDigest(base),
    ...base,
  };
}

function writeDecisionAt(decisionPath, record) {
  fs.mkdirSync(path.dirname(decisionPath), { recursive: true });
  fs.writeFileSync(decisionPath, JSON.stringify(record, null, 2), 'utf8');
}

function journalPathFor(stateDir, meta) {
  const slug = meta.repository.replace(/[^A-Za-z0-9._-]+/g, '_');
  const key = `${slug}_Issue-${meta.issue}_${meta.headSha.slice(0, 7)}_${meta.requestDigest.slice(0, 12)}`;
  return path.join(stateDir, 'mcp-review', `${key}.json`);
}

function writeJournal(stateDir, meta, contentDigest, patch = {}) {
  const jp = journalPathFor(stateDir, meta);
  fs.mkdirSync(path.dirname(jp), { recursive: true });
  const base = {
    schemaVersion: '1',
    key: path.basename(jp, '.json'),
    identity: {
      repository: meta.repository, issue: meta.issue,
      pullRequest: meta.pullRequest, headSha: meta.headSha,
    },
    requestDigest: meta.requestDigest,
    contentDigest,
    firstActivatedAt: new Date(Date.now() - 60_000).toISOString(),
    attempts: [{
      at: new Date(Date.now() - 30_000).toISOString(),
      ok: true, code: null, conversationId: null, postCount: 1, modelSlug: null,
    }],
    consumedPayloadDigest: null,
  };
  const j = { ...base, ...patch };
  fs.writeFileSync(jp, JSON.stringify(j, null, 2), 'utf8');
  return jp;
}

function makeLeg({ packetDir, stateDir, env = {}, createActivationTransport, timeoutMs = 5000, pollMs = 10, log = () => {} } = {}) {
  return createMcpFinalReview({
    reviewReadyDir: packetDir,
    stateDir,
    env: { REVIEW_MCP_REQUEST_DIR: packetDir, ...env },
    createActivationTransport,
    timeoutMs,
    pollMs,
    log,
  });
}

// ===========================================================================
// A. unit: mode switch / packet meta / activation prompt / decision validation
// ===========================================================================
test('A1 resolveReviewVia: mặc định web2api, mcp bật theo env, invalid fail-closed', () => {
  assert.deepEqual(resolveReviewVia({}), { ok: true, via: 'web2api' });
  assert.deepEqual(resolveReviewVia({ SOC_FINAL_REVIEW_VIA: '' }), { ok: true, via: 'web2api' });
  assert.deepEqual(resolveReviewVia({ SOC_FINAL_REVIEW_VIA: 'web2api' }), { ok: true, via: 'web2api' });
  assert.deepEqual(resolveReviewVia({ SOC_FINAL_REVIEW_VIA: ' MCP ' }), { ok: true, via: 'mcp' });
  const bad = resolveReviewVia({ SOC_FINAL_REVIEW_VIA: 'banana' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'REVIEW_VIA_INVALID');
});

test('A2 parsePacketMeta: hợp lệ và các nhánh fail-closed', () => {
  const ok = parsePacketMeta(packetText());
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.meta, {
    repository: REPO, issue: ISSUE, pullRequest: PR,
    headSha: HEAD, requestDigest: sha256Hex('report-v1'), terminalStatus: 'READY_FOR_REVIEW',
  });

  const noDigest = parsePacketMeta(packetText({ reportDigest: null }));
  assert.equal(noDigest.ok, false);
  assert.equal(noDigest.code, MCP_REVIEW_CODES.PACKET_NO_REPORT_DIGEST);

  const badStatus = parsePacketMeta(packetText({ status: 'DRAFT' }));
  assert.equal(badStatus.ok, false);
  assert.equal(badStatus.code, MCP_REVIEW_CODES.PACKET_NOT_FOUND);

  const noPr = parsePacketMeta(packetText().replace(/^- pullRequest:.*\n/m, ''));
  assert.equal(noPr.ok, false);
  assert.equal(noPr.code, MCP_REVIEW_CODES.PACKET_IDENTITY);

  const noHead = parsePacketMeta(packetText().replace(/^- headSha:.*\n/m, ''));
  assert.equal(noHead.ok, false);
  assert.equal(noHead.code, MCP_REVIEW_CODES.PACKET_IDENTITY);
});

test('A3 buildMcpActivationPrompt: mang binding digests + quy trình MCP, không chứa evidence', () => {
  const meta = readMeta(packetText());
  const contentDigest = sha256Hex(packetText());
  const prompt = buildMcpActivationPrompt({ meta, contentDigest });
  assert.match(prompt, /review\.get_request/);
  assert.match(prompt, /review\.get_evidence/);
  assert.match(prompt, /review\.submit_decision/);
  assert.ok(prompt.includes(meta.requestDigest));
  assert.ok(prompt.includes(contentDigest));
  assert.ok(prompt.includes(`"issue":${ISSUE}`) || prompt.includes(`"issue": ${ISSUE}`));
  assert.match(prompt, /ack.*mcp-review-activation/);
  // Activation ack là reply CHỈ chứa fenced JSON ack - không có verdict trong reply.
  assert.doesNotMatch(prompt, /VERDICT:/);
  // Evidence KHÔNG đi trong prompt (GPT tự đọc qua MCP).
  assert.ok(!prompt.includes('testExecution=87/87'), 'prompt không được chứa evidence packet');
});

test('A4 expectedDecisionPath khớp builder của review-mcp-http (SSOT filename)', () => {
  const meta = readMeta(packetText());
  const packetDir = path.join('x', 'review-ready');
  const got = expectedDecisionPath({ packetDir, meta });
  const want = path.join(packetDir, '_decisions', buildDecisionFilename({
    identity: {
      repository: meta.repository, issue: meta.issue,
      pullRequest: meta.pullRequest, headSha: meta.headSha,
    },
    requestDigest: meta.requestDigest,
  }));
  assert.equal(got, want);
});

test('A5 validateMcpDecision: PASS hợp lệ + matrix binding/HEAD/digest/stale/duplicate', () => {
  const content = packetText();
  const meta = readMeta(content);
  const contentDigest = sha256Hex(content);
  const expected = {
    repository: meta.repository, issue: meta.issue, pullRequest: meta.pullRequest,
    headSha: meta.headSha, requestDigest: meta.requestDigest, contentDigest,
  };
  const journal = {
    firstActivatedAt: '2026-10-04T10:00:00.000Z',
    attempts: [{ at: '2026-10-04T10:00:00.000Z', postCount: 1 }],
    consumedPayloadDigest: null,
  };
  const good = () => mkDecisionRecord({
    meta, contentDigest, persistedAt: '2026-10-04T10:01:00.000Z',
  });

  // 1. PASS hợp lệ -> value(binding đúng, metadata.source = mcp-final-review)
  const ok = validateMcpDecision({ record: good(), expected, journal });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.value.verdict, 'PASS');
  assert.deepEqual(ok.value.binding, { repository: REPO, issue: ISSUE, headSha: HEAD });
  assert.equal(ok.value.metadata.source, 'mcp-final-review');
  assert.equal(ok.value.metadata.requestDigest, meta.requestDigest);

  // 2. headSha sai -> BINDING_MISMATCH
  const wrongHead = mkDecisionRecord({
    meta, contentDigest, persistedAt: '2026-10-04T10:01:00.000Z',
    identity: { repository: REPO, issue: ISSUE, pullRequest: PR, headSha: 'b'.repeat(40) },
  });
  const rHead = validateMcpDecision({ record: wrongHead, expected, journal });
  assert.equal(rHead.ok, false);
  assert.equal(rHead.code, MCP_REVIEW_CODES.BINDING_MISMATCH);

  // 3. requestDigest sai -> DIGEST_MISMATCH
  const wrongReq = mkDecisionRecord({
    meta, contentDigest, persistedAt: '2026-10-04T10:01:00.000Z', requestDigest: 'e'.repeat(64),
  });
  const rReq = validateMcpDecision({ record: wrongReq, expected, journal });
  assert.equal(rReq.ok, false);
  assert.equal(rReq.code, MCP_REVIEW_CODES.DIGEST_MISMATCH);
  assert.equal(rReq.detail.field, 'requestDigest');

  // 4. contentDigest sai -> DIGEST_MISMATCH
  const wrongContent = mkDecisionRecord({
    meta, contentDigest, persistedAt: '2026-10-04T10:01:00.000Z', contentDigestOverride: 'e'.repeat(64),
  });
  const rContent = validateMcpDecision({ record: wrongContent, expected, journal });
  assert.equal(rContent.ok, false);
  assert.equal(rContent.code, MCP_REVIEW_CODES.DIGEST_MISMATCH);
  assert.equal(rContent.detail.field, 'contentDigest');

  // 5. payloadDigest bị sửa (file bị touch) -> DIGEST_MISMATCH
  const tampered = { ...good(), payloadDigest: 'f'.repeat(64) };
  const rTamper = validateMcpDecision({ record: tampered, expected, journal });
  assert.equal(rTamper.ok, false);
  assert.equal(rTamper.code, MCP_REVIEW_CODES.DIGEST_MISMATCH);
  assert.equal(rTamper.detail.field, 'payloadDigest');

  // 6. verdict ngoài boundary -> VERDICT_INVALID
  const badVerdict = mkDecisionRecord({
    meta, contentDigest, persistedAt: '2026-10-04T10:01:00.000Z',
    verdict: 'APPROVED', canonicalVerdict: 'APPROVED',
  });
  const rVerdict = validateMcpDecision({ record: badVerdict, expected, journal });
  assert.equal(rVerdict.ok, false);
  assert.equal(rVerdict.code, MCP_REVIEW_CODES.VERDICT_INVALID);

  // 7. canonicalVerdict lệch verdict -> VERDICT_INVALID
  const badCanonical = mkDecisionRecord({
    meta, contentDigest, persistedAt: '2026-10-04T10:01:00.000Z',
    verdict: 'REWORK', canonicalVerdict: 'APPROVED',
  });
  const rCanonical = validateMcpDecision({ record: badCanonical, expected, journal });
  assert.equal(rCanonical.ok, false);
  assert.equal(rCanonical.code, MCP_REVIEW_CODES.VERDICT_INVALID);

  // 8. verdict cũ hơn lượt kích hoạt -> STALE
  const oldRecord = mkDecisionRecord({
    meta, contentDigest, persistedAt: '2026-10-04T09:59:59.000Z',
  });
  const rStale = validateMcpDecision({ record: oldRecord, expected, journal });
  assert.equal(rStale.ok, false);
  assert.equal(rStale.code, MCP_REVIEW_CODES.STALE);

  // 9. quyết định khi CHƯA từng kích hoạt (không journal) -> STALE
  const rNoJournal = validateMcpDecision({ record: good(), expected, journal: null });
  assert.equal(rNoJournal.ok, false);
  assert.equal(rNoJournal.code, MCP_REVIEW_CODES.STALE);

  // 10. đã consume payload KHÁC -> DUPLICATE
  const rDup = validateMcpDecision({
    record: good(), expected,
    journal: { ...journal, consumedPayloadDigest: 'd'.repeat(64) },
  });
  assert.equal(rDup.ok, false);
  assert.equal(rDup.code, MCP_REVIEW_CODES.DUPLICATE);

  // 11. replay idempotent: cùng payloadDigest đã consume -> ok (FSM resume)
  const good2 = good();
  const rReplay = validateMcpDecision({
    record: good2, expected,
    journal: { ...journal, consumedPayloadDigest: good2.payloadDigest },
  });
  assert.equal(rReplay.ok, true, JSON.stringify(rReplay));

  // 12. REWORK có findings/evidenceRequests -> value giữ mảng (REWORK guard của bin)
  const rework = mkDecisionRecord({
    meta, contentDigest, persistedAt: '2026-10-04T10:01:00.000Z',
    verdict: 'REWORK', findings: [{ severity: 'high', code: 'X1', text: 'sửa đi' }],
    evidenceRequests: [{ kind: 'log', note: 'cần log' }],
  });
  const rRework = validateMcpDecision({ record: rework, expected, journal });
  assert.equal(rRework.ok, true, JSON.stringify(rRework));
  assert.equal(rRework.value.verdict, 'REWORK');
  assert.equal(rRework.value.findings.length, 1);
  assert.match(rRework.value.findings[0], /\[high\/X1\] sửa đi/);
  assert.equal(rRework.value.evidenceRequests.length, 1);
});

// ===========================================================================
// B. integration: createMcpFinalReview (fake transport, temp dirs)
// ===========================================================================
test('B1 dir alignment: server dir lệch packet dir -> DIR_MISMATCH, không kích hoạt', async () => {
  const stateDir = mkStateDir();
  const packetDir = path.join(stateDir, 'review-ready');
  writePacket(packetDir);
  let activations = 0;
  const leg = makeLeg({
    packetDir, stateDir,
    env: { REVIEW_MCP_REQUEST_DIR: path.join(stateDir, 'other-dir') },
    createActivationTransport: () => async () => { activations += 1; return { ok: true }; },
  });
  const r = await leg({ session: { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD } });
  assert.equal(r.ok, false);
  assert.equal(r.code, MCP_REVIEW_CODES.DIR_MISMATCH);
  assert.equal(activations, 0, 'không được kích hoạt khi dir lệch');
});

test('B2 packet thiếu reportDigest -> NO_REPORT_DIGEST, KHÔNG kích hoạt Web2API', async () => {
  const stateDir = mkStateDir();
  const packetDir = path.join(stateDir, 'review-ready');
  writePacket(packetDir, { reportDigest: null });
  let activations = 0;
  const leg = makeLeg({
    packetDir, stateDir,
    createActivationTransport: () => async () => { activations += 1; return { ok: true }; },
  });
  const r = await leg({ session: { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD } });
  assert.equal(r.ok, false);
  assert.equal(r.code, MCP_REVIEW_CODES.PACKET_NO_REPORT_DIGEST);
  assert.equal(activations, 0, 'packet không có reportDigest thì server sẽ từ chối - không được kích hoạt');
});

test('B3 happy path: đúng 1 activation, ack không phải verdict, PASS qua validate', async () => {
  const stateDir = mkStateDir();
  const packetDir = path.join(stateDir, 'review-ready');
  const { content } = writePacket(packetDir);
  const meta = readMeta(content);
  const contentDigest = sha256Hex(content);
  const prompts = [];
  const leg = makeLeg({
    packetDir, stateDir,
    createActivationTransport: () => async ({ prompt }) => {
      prompts.push(prompt);
      // GPT (qua MCP) submit quyết định TRONG phiên activation.
      const decisionPath = expectedDecisionPath({ packetDir, meta });
      writeDecisionAt(decisionPath, mkDecisionRecord({ meta, contentDigest }));
      return { ok: true, value: '```json\n{ "ack": "mcp-review-activation" }\n```', transportMeta: { postCount: 1 } };
    },
  });
  const r = await leg({ session: { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.verdict, 'PASS');
  assert.equal(r.value.metadata.source, 'mcp-final-review');
  assert.equal(r.value.binding.headSha, HEAD);
  assert.equal(prompts.length, 1, 'một lượt review = đúng một activation');
  // Activation prompt phải mang digest canonical của CHÍNH packet này.
  assert.ok(prompts[0].includes(meta.requestDigest));
  assert.ok(prompts[0].includes(contentDigest));
  // Journal ghi nhận đúng 1 attempt.
  const jp = journalPathFor(stateDir, meta);
  const journal = JSON.parse(fs.readFileSync(jp, 'utf8'));
  assert.equal(journal.attempts.length, 1);
  assert.equal(journal.attempts[0].postCount, 1);
  assert.equal(journal.consumedPayloadDigest, computePayloadDigest(mkDecisionRecord({ meta, contentDigest })));
});

test('B4 ack không bao giờ là verdict: không có quyết định -> VERDICT_TIMEOUT', async () => {
  const stateDir = mkStateDir();
  const packetDir = path.join(stateDir, 'review-ready');
  writePacket(packetDir);
  let activations = 0;
  const leg = makeLeg({
    packetDir, stateDir, timeoutMs: 150, pollMs: 10,
    createActivationTransport: () => async () => {
      activations += 1;
      // Web2API trả về ack đẹp nhưng KHÔNG có quyết định trong _decisions/
      return { ok: true, value: '```json\n{ "ack": "mcp-review-activation" }\n```', transportMeta: { postCount: 1 } };
    },
  });
  const r = await leg({ session: { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD } });
  assert.equal(r.ok, false);
  assert.equal(r.code, MCP_REVIEW_CODES.VERDICT_TIMEOUT);
  assert.equal(activations, 1, 'vẫn đúng một lần kích hoạt trong lượt');
});

test('B5 resume trong cùng cửa sổ activation: KHÔNG gửi trùng prompt, vẫn consume được verdict', async () => {
  const stateDir = mkStateDir();
  const packetDir = path.join(stateDir, 'review-ready');
  const { content } = writePacket(packetDir);
  const meta = readMeta(content);
  const contentDigest = sha256Hex(content);
  // Journal từ lượt trước: activation 1s trước (postCount>0) - CHƯA có quyết định.
  writeJournal(stateDir, meta, contentDigest, {
    firstActivatedAt: new Date(Date.now() - 1000).toISOString(),
    attempts: [{ at: new Date(Date.now() - 1000).toISOString(), ok: true, code: null, conversationId: null, postCount: 1, modelSlug: null }],
  });
  let activations = 0;
  const leg = makeLeg({
    packetDir, stateDir, timeoutMs: 5000, pollMs: 10,
    createActivationTransport: () => async () => { activations += 1; return { ok: true, transportMeta: { postCount: 1 } }; },
  });
  // "GPT bên ngoài" submit quyết định sau 50ms (trong lúc leg poll).
  setTimeout(() => {
    writeDecisionAt(expectedDecisionPath({ packetDir, meta }), mkDecisionRecord({ meta, contentDigest }));
  }, 50);
  const r = await leg({ session: { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.verdict, 'PASS');
  assert.equal(activations, 0, 'resume trong cửa sổ: tuyệt đối không gửi activation trùng');
});

test('B6 quyết định đã tồn tại từ lượt trước -> consume ngay, không kích hoạt', async () => {
  const stateDir = mkStateDir();
  const packetDir = path.join(stateDir, 'review-ready');
  const { content } = writePacket(packetDir);
  const meta = readMeta(content);
  const contentDigest = sha256Hex(content);
  const decisionPath = expectedDecisionPath({ packetDir, meta });
  const record = mkDecisionRecord({ meta, contentDigest });
  writeDecisionAt(decisionPath, record);
  writeJournal(stateDir, meta, contentDigest, {
    firstActivatedAt: new Date(Date.now() - 60_000).toISOString(),
    attempts: [{ at: new Date(Date.now() - 60_000).toISOString(), ok: true, code: null, conversationId: null, postCount: 1, modelSlug: null }],
  });
  let activations = 0;
  const leg = makeLeg({
    packetDir, stateDir,
    createActivationTransport: () => async () => { activations += 1; return { ok: true, transportMeta: { postCount: 1 } }; },
  });
  const r = await leg({ session: { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.verdict, 'PASS');
  assert.equal(activations, 0, 'verdict cũ hơn activation mới là không được gửi prompt mới');

  // Replay cùng record (FSM resume lần nữa) -> idempotent, vẫn không kích hoạt.
  let activations2 = 0;
  const leg2 = makeLeg({
    packetDir, stateDir,
    createActivationTransport: () => async () => { activations2 += 1; return { ok: true, transportMeta: { postCount: 1 } }; },
  });
  const r2 = await leg2({ session: { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD } });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(activations2, 0);
});

test('B7 quyết định cũ hơn firstActivatedAt -> STALE fail-closed', async () => {
  const stateDir = mkStateDir();
  const packetDir = path.join(stateDir, 'review-ready');
  const { content } = writePacket(packetDir);
  const meta = readMeta(content);
  const contentDigest = sha256Hex(content);
  writeDecisionAt(expectedDecisionPath({ packetDir, meta }),
    mkDecisionRecord({ meta, contentDigest, persistedAt: new Date(Date.now() - 120_000).toISOString() }));
  // Journal mới tạo SAU thời điểm record (firstActivatedAt = -60s... record -120s:
  // để chắc, ép journal firstActivatedAt = now - 10s > record -120s).
  writeJournal(stateDir, meta, contentDigest, {
    firstActivatedAt: new Date(Date.now() - 10_000).toISOString(),
    attempts: [{ at: new Date(Date.now() - 10_000).toISOString(), ok: true, code: null, conversationId: null, postCount: 1, modelSlug: null }],
  });
  const leg = makeLeg({ packetDir, stateDir, createActivationTransport: () => async () => {
    throw new Error('stale decision không bao giờ được kích hoạt lại');
  } });
  const r = await leg({ session: { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD } });
  assert.equal(r.ok, false);
  assert.equal(r.code, MCP_REVIEW_CODES.STALE);
});

test('B8 activation fail (postCount=0) -> MCP_ACTIVATION_FAILED, không poll vô ích', async () => {
  const stateDir = mkStateDir();
  const packetDir = path.join(stateDir, 'review-ready');
  writePacket(packetDir);
  let activations = 0;
  const leg = makeLeg({
    packetDir, stateDir, timeoutMs: 100, pollMs: 10,
    createActivationTransport: () => async () => {
      activations += 1;
      return { ok: false, code: 'HTTP_500', error: 'connection refused', transportMeta: { postCount: 0 } };
    },
  });
  const r = await leg({ session: { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD } });
  assert.equal(r.ok, false);
  assert.equal(r.code, MCP_REVIEW_CODES.ACTIVATION_FAILED);
  assert.equal(activations, 1);
});

test('B9 vượt tối đa lần CHƯA gửi (toàn failed postCount=0) -> ACTIVATION_EXHAUSTED', async () => {
  const stateDir = mkStateDir();
  const packetDir = path.join(stateDir, 'review-ready');
  const { content } = writePacket(packetDir);
  const meta = readMeta(content);
  const contentDigest = sha256Hex(content);
  const old = new Date(Date.now() - 600_000).toISOString();
  // Chỉ được retry khi chứng minh CHƯA gửi: attempts toàn phase=failed (postCount=0).
  writeJournal(stateDir, meta, contentDigest, {
    attempts: Array.from({ length: MCP_MAX_ACTIVATIONS }, () => ({
      at: old, phase: 'failed', ok: false, code: 'HTTP_500', conversationId: null, postCount: 0, modelSlug: null,
    })),
  });
  let activations = 0;
  const leg = makeLeg({
    packetDir, stateDir, timeoutMs: 1000, pollMs: 10,
    createActivationTransport: () => async () => { activations += 1; return { ok: true, transportMeta: { postCount: 1 } }; },
  });
  const r = await leg({ session: { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD } });
  assert.equal(r.ok, false);
  assert.equal(r.code, MCP_REVIEW_CODES.ACTIVATION_EXHAUSTED);
  assert.equal(activations, 0, 'hết quyền kích hoạt thì không gửi thêm');
});

test('B10 session head khác packet head -> PACKET_STALE (không đọc packet cũ)', async () => {
  const stateDir = mkStateDir();
  const packetDir = path.join(stateDir, 'review-ready');
  writePacket(packetDir); // head = HEAD
  let activations = 0;
  const leg = makeLeg({
    packetDir, stateDir,
    createActivationTransport: () => async () => { activations += 1; return { ok: true, transportMeta: { postCount: 1 } }; },
  });
  const r = await leg({ session: { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: 'b'.repeat(40) } });
  assert.equal(r.ok, false);
  assert.equal(r.code, MCP_REVIEW_CODES.PACKET_STALE);
  assert.equal(activations, 0);
});

// ===========================================================================
// R. Regression bắt buộc của REWORK (at-most-once activation, journal atomic)
// ===========================================================================
test('R1 timeout -> resume cùng packet: tổng POST vẫn đúng 1, không gửi lại', async () => {
  const stateDir = mkStateDir();
  const packetDir = path.join(stateDir, 'review-ready');
  writePacket(packetDir);
  let activations = 0;
  const legFactory = () => makeLeg({
    packetDir, stateDir, timeoutMs: 150, pollMs: 10,
    createActivationTransport: () => async () => {
      activations += 1;
      return { ok: true, transportMeta: { postCount: 1 } };
    },
  });
  // Lượt 1: gửi 1 lần, không có verdict -> VERDICT_TIMEOUT.
  const r1 = await legFactory()({ session: { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD } });
  assert.equal(r1.code, MCP_REVIEW_CODES.VERDICT_TIMEOUT, JSON.stringify(r1));
  assert.equal(activations, 1);
  // Resume (lượt 2, cùng packet/journal): KHÔNG gửi thêm, vẫn báo timeout rõ ràng.
  const r2 = await legFactory()({ session: { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD } });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, MCP_REVIEW_CODES.VERDICT_TIMEOUT, JSON.stringify(r2));
  assert.equal(r2.detail.atMostOnce, true, 'timeout sau resume phải ghi nhận at-most-once');
  // Resume lần 3 nữa: vẫn 0 POST mới.
  const r3 = await legFactory()({ session: { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD } });
  assert.equal(r3.ok, false);
  assert.equal(activations, 1, 'tổng POST qua 3 lượt resume phải là 1');
  // Journal ghi đúng 1 attempt sent.
  const jp = journalPathFor(stateDir, readMeta(packetText()));
  const j = JSON.parse(fs.readFileSync(jp, 'utf8'));
  assert.equal(j.attempts.length, 1);
  assert.equal(j.attempts[0].phase, 'sent');
});

test('R2a crash SAU gửi TRƯỚC ghi kết quả (journal pending): resume KHÔNG POST, trả uncertain', async () => {
  const stateDir = mkStateDir();
  const packetDir = path.join(stateDir, 'review-ready');
  const { content } = writePacket(packetDir);
  const meta = readMeta(content);
  const contentDigest = sha256Hex(content);
  // Mô phỏng: attempt đã được ghi pending TRƯỚC transport, process chết ngay
  // sau POST mà chưa ghi kết quả -> journal còn nguyên phase='pending'.
  writeJournal(stateDir, meta, contentDigest, {
    firstActivatedAt: new Date(Date.now() - 100).toISOString(),
    attempts: [{ at: new Date(Date.now() - 50).toISOString(), phase: 'pending', postCount: null, ok: null, code: null, conversationId: null, modelSlug: null }],
  });
  let activations = 0;
  const leg = makeLeg({
    packetDir, stateDir, timeoutMs: 150, pollMs: 10,
    createActivationTransport: () => async () => { activations += 1; return { ok: true, transportMeta: { postCount: 1 } }; },
  });
  const r = await leg({ session: { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD } });
  assert.equal(r.ok, false);
  assert.equal(r.code, MCP_REVIEW_CODES.ACTIVATION_PENDING, JSON.stringify(r));
  assert.equal(activations, 0, 'không chứng minh được đã/chưa gửi -> KHÔNG POST thêm');
});

test('R2b crash pending nhưng verdict đã về: consume hợp lệ, 0 POST + replay idempotent', async () => {
  const stateDir = mkStateDir();
  const packetDir = path.join(stateDir, 'review-ready');
  const { content } = writePacket(packetDir);
  const meta = readMeta(content);
  const contentDigest = sha256Hex(content);
  writeJournal(stateDir, meta, contentDigest, {
    firstActivatedAt: new Date(Date.now() - 60_000).toISOString(),
    attempts: [{ at: new Date(Date.now() - 60_000).toISOString(), phase: 'pending', postCount: null, ok: null, code: null, conversationId: null, modelSlug: null }],
  });
  writeDecisionAt(expectedDecisionPath({ packetDir, meta }), mkDecisionRecord({ meta, contentDigest }));
  let activations = 0;
  const mk = () => makeLeg({
    packetDir, stateDir,
    createActivationTransport: () => async () => { activations += 1; return { ok: true, transportMeta: { postCount: 1 } }; },
  });
  // Lượt 1: pending + verdict hợp lệ -> consume (pending là activation hợp lệ).
  const r1 = await mk()({ session: { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD } });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(r1.value.verdict, 'PASS');
  assert.equal(activations, 0);
  // Replay (FSM resume lần nữa): idempotent, vẫn 0 POST.
  const r2 = await mk()({ session: { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD } });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.value.verdict, 'PASS');
  assert.equal(activations, 0, 'pending/resume không bao giờ tự POST');
});

test('R3 journal corrupt -> JOURNAL_CORRUPT typed-fail, 0 POST', async () => {
  const stateDir = mkStateDir();
  const packetDir = path.join(stateDir, 'review-ready');
  const { content } = writePacket(packetDir);
  const meta = readMeta(content);
  const jp = journalPathFor(stateDir, meta);
  fs.mkdirSync(path.dirname(jp), { recursive: true });
  fs.writeFileSync(jp, '{ "firstActivatedAt": "2026-10-04T', 'utf8'); // JSON cụt
  let activations = 0;
  const leg = makeLeg({
    packetDir, stateDir,
    createActivationTransport: () => async () => { activations += 1; return { ok: true, transportMeta: { postCount: 1 } }; },
  });
  const r = await leg({ session: { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD } });
  assert.equal(r.ok, false);
  assert.equal(r.code, MCP_REVIEW_CODES.JOURNAL_CORRUPT, JSON.stringify(r));
  assert.equal(activations, 0, 'journal corrupt -> typed-fail, không reset, không gửi');
});

test('R3b journal unreadable (khác ENOENT) -> JOURNAL_UNREADABLE typed-fail, 0 POST', async () => {
  const stateDir = mkStateDir();
  const packetDir = path.join(stateDir, 'review-ready');
  const { content } = writePacket(packetDir);
  const meta = readMeta(content);
  const jp = journalPathFor(stateDir, meta);
  // Ép read lỗi khác ENOENT: path là THƯ MỤC (EISDIR khi readFileSync).
  fs.mkdirSync(jp, { recursive: true });
  let activations = 0;
  const leg = makeLeg({
    packetDir, stateDir,
    createActivationTransport: () => async () => { activations += 1; return { ok: true, transportMeta: { postCount: 1 } }; },
  });
  const r = await leg({ session: { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD } });
  assert.equal(r.ok, false);
  assert.equal(r.code, MCP_REVIEW_CODES.JOURNAL_UNREADABLE, JSON.stringify(r));
  assert.equal(activations, 0, 'journal unreadable -> typed-fail, không gửi');
});

test('R4 journal binding/digests lệch key -> JOURNAL_MISMATCH, không reset, 0 POST', async () => {
  const stateDir = mkStateDir();
  const packetDir = path.join(stateDir, 'review-ready');
  const { content } = writePacket(packetDir);
  const meta = readMeta(content);
  const contentDigest = sha256Hex(content);
  // Journal cùng key nhưng contentDigest khác (foreign/corrupt) -> không reset.
  writeJournal(stateDir, meta, contentDigest, { contentDigest: 'e'.repeat(64) });
  let activations = 0;
  const leg = makeLeg({
    packetDir, stateDir,
    createActivationTransport: () => async () => { activations += 1; return { ok: true, transportMeta: { postCount: 1 } }; },
  });
  const r = await leg({ session: { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD } });
  assert.equal(r.ok, false);
  assert.equal(r.code, MCP_REVIEW_CODES.JOURNAL_MISMATCH, JSON.stringify(r));
  assert.equal(activations, 0, 'journal lệch -> không reset, không gửi');
});

test('R5 baseline attempts=[] + decision có sẵn -> reject NO_ACTIVATION, 0 POST', async () => {
  const stateDir = mkStateDir();
  const packetDir = path.join(stateDir, 'review-ready');
  const { content } = writePacket(packetDir);
  const meta = readMeta(content);
  const contentDigest = sha256Hex(content);
  // Baseline CHƯA từng kích hoạt (attempts=[]) nhưng decision đã tồn tại.
  writeJournal(stateDir, meta, contentDigest, { attempts: [] });
  writeDecisionAt(expectedDecisionPath({ packetDir, meta }), mkDecisionRecord({ meta, contentDigest }));
  let activations = 0;
  const leg = makeLeg({
    packetDir, stateDir,
    createActivationTransport: () => async () => { activations += 1; return { ok: true, transportMeta: { postCount: 1 } }; },
  });
  const r = await leg({ session: { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD } });
  assert.equal(r.ok, false);
  assert.equal(r.code, MCP_REVIEW_CODES.NO_ACTIVATION, JSON.stringify(r));
  assert.equal(activations, 0, 'baseline không đủ bằng chứng -> reject, không gửi');
});

test('R6 journal unit: attemptPhase suy ra từ postCount, hasValidActivation baseline=false', () => {
  assert.equal(attemptPhase({ phase: 'pending', postCount: null }), 'pending');
  assert.equal(attemptPhase({ phase: 'sent', postCount: 1 }), 'sent');
  assert.equal(attemptPhase({ phase: 'failed', postCount: 0 }), 'failed');
  // Attempt journal cũ thiếu phase -> suy ra từ postCount.
  assert.equal(attemptPhase({ postCount: 1 }), 'sent');
  assert.equal(attemptPhase({ postCount: 0 }), 'failed');
  assert.equal(attemptPhase({}), 'pending', 'thiếu dữ liệu -> hướng an toàn: pending');
  assert.equal(hasValidActivation({ attempts: [] }), false, 'baseline attempts=[] không đủ');
  assert.equal(hasValidActivation({ attempts: [{ phase: 'pending' }] }), true);
  assert.equal(hasValidActivation({ attempts: [{ phase: 'sent' }] }), true);
  assert.equal(hasValidActivation({ attempts: [{ phase: 'failed', postCount: 0 }] }), false);
  assert.equal(hasValidActivation(null), false);
});

// ===========================================================================
// R7-R9. Regression: CHỈ integer postCount trả về từ transport mới là bằng chứng
// (0 = chưa gửi -> retry; >0 = đã gửi -> at-most-once). Throw / thiếu / sai
// postCount -> giữ pending, trả MCP_ACTIVATION_UNCERTAIN, resume KHÔNG gọi
// transport thêm.
// ===========================================================================
test('R7 transport THROW -> giữ pending (postCount null), trả UNCERTAIN, resume 0 POST mới', async () => {
  const stateDir = mkStateDir();
  const packetDir = path.join(stateDir, 'review-ready');
  const { content } = writePacket(packetDir);
  const meta = readMeta(content);
  let calls = 0;
  const mk = () => makeLeg({
    packetDir, stateDir, timeoutMs: 150, pollMs: 10,
    createActivationTransport: () => async () => {
      calls += 1;
      throw new Error('CDP collapsed mid-flight (không rõ đã POST hay chưa)');
    },
  });
  const session = { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD };
  // Lượt 1: throw KHÔNG được ghi thành failed (bằng chứng chưa gửi) ->
  // phải giữ pending + báo uncertain.
  const r1 = await mk()({ session });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, MCP_REVIEW_CODES.ACTIVATION_PENDING, JSON.stringify(r1));
  assert.equal(calls, 1);
  const jp = journalPathFor(stateDir, meta);
  const j1 = JSON.parse(fs.readFileSync(jp, 'utf8'));
  assert.equal(j1.attempts.length, 1);
  assert.equal(j1.attempts[0].phase, 'pending', 'throw không chứng minh được gì -> phải giữ pending');
  assert.equal(j1.attempts[0].postCount, null, 'pending không được ghi postCount=0 (đó là bằng chứng CHƯA gửi)');
  // Lượt 2 (resume): KHÔNG gọi transport thêm, vẫn uncertain.
  const r2 = await mk()({ session });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, MCP_REVIEW_CODES.ACTIVATION_PENDING, JSON.stringify(r2));
  assert.equal(calls, 1, 'resume thấy pending -> KHÔNG gọi transport thêm');
  const j2 = JSON.parse(fs.readFileSync(jp, 'utf8'));
  assert.equal(j2.attempts.length, 1, 'không thêm attempt mới');
  assert.equal(j2.attempts[0].phase, 'pending');
});

test('R8 postCount THIẾU/SAI (không integer) -> giữ pending, trả UNCERTAIN, resume 0 POST mới', async () => {
  const cases = [
    { name: 'không có transportMeta', result: { ok: false, code: 'NO_META' } },
    { name: 'transportMeta rỗng (thiếu postCount)', result: { ok: true, transportMeta: {} } },
    { name: 'postCount là string', result: { ok: false, code: 'HTTP_500', transportMeta: { postCount: '1' } } },
    { name: 'postCount âm', result: { ok: false, code: 'HTTP_500', transportMeta: { postCount: -3 } } },
    { name: 'postCount float', result: { ok: false, code: 'HTTP_500', transportMeta: { postCount: 1.5 } } },
  ];
  for (const c of cases) {
    const stateDir = mkStateDir();
    const packetDir = path.join(stateDir, 'review-ready');
    const { content } = writePacket(packetDir);
    const meta = readMeta(content);
    let calls = 0;
    const mk = () => makeLeg({
      packetDir, stateDir, timeoutMs: 150, pollMs: 10,
      createActivationTransport: () => async () => { calls += 1; return c.result; },
    });
    const session = { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD };
    const r1 = await mk()({ session });
    assert.equal(r1.ok, false, c.name);
    assert.equal(r1.code, MCP_REVIEW_CODES.ACTIVATION_PENDING, `${c.name}: ${JSON.stringify(r1)}`);
    assert.equal(calls, 1, c.name);
    const jp = journalPathFor(stateDir, meta);
    const j1 = JSON.parse(fs.readFileSync(jp, 'utf8'));
    assert.equal(j1.attempts[0].phase, 'pending', `${c.name}: phải giữ pending`);
    assert.equal(j1.attempts[0].postCount, null, `${c.name}: postCount không integer -> không được ghi bằng chứng`);
    const r2 = await mk()({ session });
    assert.equal(r2.code, MCP_REVIEW_CODES.ACTIVATION_PENDING, `${c.name}: ${JSON.stringify(r2)}`);
    assert.equal(calls, 1, `${c.name}: resume KHÔNG gọi transport thêm`);
  }
});

test('R9 ranh giới bằng chứng: đúng integer postCount=0 -> failed + retry được; >0 -> sent, không retry', async () => {
  // 0: chứng minh CHƯA gửi -> ghi failed, lượt sau được gửi lại.
  const stateDir = mkStateDir();
  const packetDir = path.join(stateDir, 'review-ready');
  const { content } = writePacket(packetDir);
  const meta = readMeta(content);
  let calls = 0;
  const mk = () => makeLeg({
    packetDir, stateDir, timeoutMs: 100, pollMs: 10,
    createActivationTransport: () => async () => {
      calls += 1;
      return { ok: false, code: 'HTTP_500', transportMeta: { postCount: 0 } };
    },
  });
  const session = { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD };
  const r1 = await mk()({ session });
  assert.equal(r1.code, MCP_REVIEW_CODES.ACTIVATION_FAILED, JSON.stringify(r1));
  const jp = journalPathFor(stateDir, meta);
  const j1 = JSON.parse(fs.readFileSync(jp, 'utf8'));
  assert.equal(j1.attempts[0].phase, 'failed');
  assert.equal(j1.attempts[0].postCount, 0);
  // Retry thật sự được phép (integer 0 = chứng minh chưa gửi).
  const r2 = await mk()({ session });
  assert.equal(r2.code, MCP_REVIEW_CODES.ACTIVATION_FAILED, JSON.stringify(r2));
  assert.equal(calls, 2, 'integer postCount=0 -> mới được retry');
  // >0: chứng minh ĐÃ GỬI -> ghi sent, không bao giờ gửi lại.
  const stateDir2 = mkStateDir();
  const packetDir2 = path.join(stateDir2, 'review-ready');
  writePacket(packetDir2);
  let calls2 = 0;
  const mk2 = () => makeLeg({
    packetDir: packetDir2, stateDir: stateDir2, timeoutMs: 100, pollMs: 10,
    createActivationTransport: () => async () => {
      calls2 += 1;
      return { ok: true, transportMeta: { postCount: 1 } };
    },
  });
  const r3 = await mk2()({ session });
  assert.equal(r3.code, MCP_REVIEW_CODES.VERDICT_TIMEOUT, JSON.stringify(r3));
  const meta2 = readMeta(packetText());
  const j3 = JSON.parse(fs.readFileSync(journalPathFor(stateDir2, meta2), 'utf8'));
  assert.equal(j3.attempts[0].phase, 'sent');
  const r4 = await mk2()({ session });
  assert.equal(r4.code, MCP_REVIEW_CODES.VERDICT_TIMEOUT, JSON.stringify(r4));
  assert.equal(calls2, 1, 'postCount>0 -> sent, resume KHÔNG gửi lại');
});

// ===========================================================================
// R10-R11. Regression: validate TỪNG journal attempt (object, timestamp,
// phase/count nhất quán). failed+postCount>0 hoặc malformed -> JOURNAL_CORRUPT,
// KHÔNG gửi activation.
// ===========================================================================
test('R10 journal attempt failed + postCount>0 (mâu thuẫn) -> JOURNAL_CORRUPT, 0 POST', async () => {
  const stateDir = mkStateDir();
  const packetDir = path.join(stateDir, 'review-ready');
  const { content } = writePacket(packetDir);
  const meta = readMeta(content);
  const contentDigest = sha256Hex(content);
  // Attempt tự mâu thuẫn: nói "failed" (chưa gửi) nhưng postCount=3 (đã gửi 3 lần).
  writeJournal(stateDir, meta, contentDigest, {
    attempts: [{
      at: new Date(Date.now() - 30_000).toISOString(),
      phase: 'failed', ok: false, code: 'HTTP_500', conversationId: null,
      postCount: 3, modelSlug: null,
    }],
  });
  let calls = 0;
  const leg = makeLeg({
    packetDir, stateDir, timeoutMs: 150, pollMs: 10,
    createActivationTransport: () => async () => { calls += 1; return { ok: true, transportMeta: { postCount: 1 } }; },
  });
  const r = await leg({ session: { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD } });
  assert.equal(r.ok, false);
  assert.equal(r.code, MCP_REVIEW_CODES.JOURNAL_CORRUPT, JSON.stringify(r));
  assert.equal(calls, 0, 'journal attempt mâu thuẫn -> typed-fail, KHÔNG gửi activation');
});

test('R11 journal attempt malformed (object/timestamp/phase/count) -> JOURNAL_CORRUPT, 0 POST', async () => {
  const iso = new Date(Date.now() - 30_000).toISOString();
  const cases = [
    { name: 'attempt là null', attempts: [null] },
    { name: 'attempt là array', attempts: [[]] },
    { name: 'thiếu timestamp at', attempts: [{ phase: 'sent', postCount: 1 }] },
    { name: 'at không phải timestamp', attempts: [{ at: 'not-a-date', phase: 'pending', postCount: null }] },
    { name: 'phase lạ', attempts: [{ at: iso, phase: 'sending', postCount: 1 }] },
    { name: 'sent nhưng postCount=0', attempts: [{ at: iso, phase: 'sent', postCount: 0 }] },
    { name: 'sent nhưng postCount=null', attempts: [{ at: iso, phase: 'sent', postCount: null }] },
    { name: 'pending nhưng postCount>0', attempts: [{ at: iso, phase: 'pending', postCount: 5 }] },
    { name: 'failed nhưng postCount=null', attempts: [{ at: iso, phase: 'failed', postCount: null }] },
    { name: 'legacy thiếu phase + postCount string', attempts: [{ at: iso, postCount: '1' }] },
    { name: 'legacy thiếu phase, không có postCount', attempts: [{ at: iso }] },
  ];
  for (const c of cases) {
    const stateDir = mkStateDir();
    const packetDir = path.join(stateDir, 'review-ready');
    const { content } = writePacket(packetDir);
    const meta = readMeta(content);
    writeJournal(stateDir, meta, sha256Hex(content), { attempts: c.attempts });
    let calls = 0;
    const leg = makeLeg({
      packetDir, stateDir, timeoutMs: 150, pollMs: 10,
      createActivationTransport: () => async () => { calls += 1; return { ok: true, transportMeta: { postCount: 1 } }; },
    });
    const r = await leg({ session: { repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD } });
    assert.equal(r.ok, false, c.name);
    assert.equal(r.code, MCP_REVIEW_CODES.JOURNAL_CORRUPT, `${c.name}: ${JSON.stringify(r)}`);
    assert.equal(calls, 0, `${c.name}: journal attempt malformed -> không gửi activation`);
  }
});

// ===========================================================================
// C. wiring bin/soc-control-loop.mjs
// ===========================================================================
test('C1 SOC_FINAL_REVIEW_VIA invalid -> REVIEW_VIA_INVALID fail-closed trước FSM', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id, deps } = agentFixture(stateDir);
  deps.mcpEnv = { SOC_FINAL_REVIEW_VIA: 'banana' };
  const res = await runSocControlLoop({
    repo: REPO, issueNumber: ISSUE, goal: 'mcp wiring invalid via', stateDir, bootstrap: true, deps,
  });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'REVIEW_VIA_INVALID');
  assert.equal(readTransitions({ stateDir, identityHash: id }).length, 0,
    'invalid via phải fail trước khi FSM ghi transition nào');
  assert.ok(fs.existsSync(sessionPath), 'session fixture giữ nguyên');
});

// ---- fixture cho wiring C1/C2 (lấy đúng shape của soc-control-agent fixtures) ----
function agentFixture(stateDir) {
  const id = identityHash({ repo: REPO, issueNumber: ISSUE });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  const bindingPath = bindingPathFor({ worktreesRoot: stateDir, identityHash: id });
  const worktreePath = worktreePathFor({ worktreesRoot: stateDir, identityHash: id });
  const branch = worktreeBranchFor({ identityHash: id });
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1',
    state: 'SESSION_ACTIVE',
    lifecycle: [],
    taskId: `${REPO}#${ISSUE}`,
    repo: REPO,
    issueNumber: ISSUE,
    identityHash: id,
    headSha: HEAD,
    baseSha: BASE,
    branch,
    worktreePath,
    worktreesRoot: stateDir,
    lease: { token: `lease-${id}` },
    controlPlane: { stateDir, sessionPath, bindingPath, worktreesRoot: stateDir },
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  fs.mkdirSync(path.dirname(bindingPath), { recursive: true });
  fs.writeFileSync(bindingPath, JSON.stringify({
    schemaVersion: '1.0',
    taskId: session.taskId,
    repo: REPO,
    issueNumber: ISSUE,
    baseSha: session.baseSha,
    branch: session.branch,
    remote: REPO,
    path: session.worktreePath,
    identityHash: id,
  }, null, 2), 'utf8');

  const execPath = path.join(stateDir, 'executions', `${id}.json`);
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.writeFileSync(execPath, JSON.stringify({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: id,
    taskId: `${REPO}#${ISSUE}`, repo: REPO, issueNumber: ISSUE,
    terminalStatus: 'ok', exitCode: 0,
  }, null, 2), 'utf8');

  const committed = 'b'.repeat(40);
  const calls = [];
  const deps = {
    pushExec: undefined,
    router: () => ({ ok: true, value: { executorKind: 'opencode', model: 'x' } }),
    executor: () => ({ ok: true, value: { executionStatus: 'EXITED', terminalStatus: 'ok', exitCode: 0, executionRecordPath: execPath } }),
    verifier: () => ({ ok: true, value: { verdict: 'PASS', report: 'ok' } }),
    preReview: () => ({ ok: true, value: { verdict: 'PASS', findings: [] } }),
    telegramSpawn: () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 901 })}\n` }),
    execGit: () => '1\n',
    spawnBootstrapper: () => { throw new Error('PR publication belongs to the canonical post-executor chain'); },
    pushExec: (a0, opts) => {
      const a = Array.isArray(a0) ? a0 : opts.args;
      if (a[0] === 'rev-parse') return { status: 0, stdout: `${committed}\n` };
      if (a[0] === 'merge-base' || a[0] === 'status') return { status: 0, stdout: '' };
      if (a[0] === 'diff') return { status: a.includes('--quiet') ? 1 : 0, stdout: 'diff --git a/smoke.md b/smoke.md\n+verified lifecycle\n' };
      if (a[0] === 'ls-remote') return { status: 0, stdout: `${committed}\trefs/heads/${branch}\n` };
      if (a[0] === 'push') return { status: 0, stdout: '' };
      return { status: 1, stderr: `unhandled git ${a}` };
    },
    gh: (a) => {
      if (a[0] === 'pr' && a[1] === 'list') return { code: 0, stdout: '[]' };
      if (a[0] === 'pr' && a[1] === 'create') return { code: 0, stdout: `https://github.com/${REPO}/pull/${PR}` };
      if (a[0] === 'pr' && a[1] === 'view') {
        return {
          code: 0,
          stdout: JSON.stringify({
            number: PR, state: 'OPEN', headRefOid: committed, headRefName: branch,
            baseRefName: 'main', headRepository: { nameWithOwner: REPO },
            url: `https://github.com/${REPO}/pull/${PR}`,
            body: `Closes #${ISSUE}\n\n<!-- soc-brain:identity=${id} -->`,
          }),
        };
      }
      return { code: 1, stderr: 'no issue fixture' };
    },
    calls,
  };
  return { sessionPath, id, deps, committed, execPath, branch };
}

test('C2 via=mcp end-to-end: packet project CÓ reportDigest, đúng 1 activation, PASS vào DECIDING', async () => {
  const stateDir = mkStateDir();
  const { id, deps, committed } = agentFixture(stateDir);
  const packetDir = path.resolve(path.join(stateDir, 'review-ready'));
  deps.mcpEnv = {
    SOC_FINAL_REVIEW_VIA: 'mcp',
    REVIEW_MCP_REQUEST_DIR: packetDir,
    SOC_MCP_VERDICT_TIMEOUT_MS: '5000',
  };
  const prompts = [];
  deps.createMcpActivationTransport = () => async ({ prompt }) => {
    prompts.push(prompt);
    // Mô phỏng GPT đọc packet qua MCP rồi submit PASS (offline, cùng process).
    const files = fs.readdirSync(packetDir).filter((f) => f.endsWith('_review-ready.md'));
    assert.equal(files.length, 1, `packet phải project đúng 1 file, got: ${files.join(', ')}`);
    const content = fs.readFileSync(path.join(packetDir, files[0]), 'utf8');
    // Bằng chứng producer stamp digest (review-mcp-http reject nếu thiếu).
    const digestLine = /^- reportDigest:\s*([0-9a-f]{64})\s*$/m.exec(content);
    assert.ok(digestLine, 'projectReviewReadyPacket PHẢI stamp reportDigest');
    const meta = readMeta(content);
    assert.equal(meta.headSha, committed, 'packet bind đúng head sau publish');
    const contentDigest = sha256Hex(content);
    writeDecisionAt(expectedDecisionPath({ packetDir, meta }), mkDecisionRecord({ meta, contentDigest }));
    return { ok: true, value: '```json\n{ "ack": "mcp-review-activation" }\n```', transportMeta: { postCount: 1 } };
  };

  const res = await runSocControlLoop({
    repo: REPO, issueNumber: ISSUE, goal: 'mcp final review end-to-end', stateDir, bootstrap: true, deps,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.decision.verdict, 'PASS');
  assert.equal(res.value.decision.binding.headSha, committed);
  assert.equal(res.value.decision.metadata.source, 'mcp-final-review');
  assert.equal(prompts.length, 1, 'một lượt review = đúng một activation Web2API');
  assert.match(prompts[0], /review\.submit_decision/);

  const ledger = readTransitions({ stateDir, identityHash: id });
  const toDeciding = ledger.find((t) => t.from === 'FINAL_REVIEWING' && t.to === 'DECIDING');
  assert.ok(toDeciding, `FINAL_REVIEWING->DECIDING phải ghi được: ${JSON.stringify(ledger.map((t) => `${t.from}->${t.to}`))}`);
  // Activation là duy nhất: không lần chạy nào quay lại kích hoạt lần 2.
  assert.equal(ledger.filter((t) => t.from === 'FINAL_REVIEWING').length, 1, 'chỉ một lượt FINAL_REVIEWING');
});
