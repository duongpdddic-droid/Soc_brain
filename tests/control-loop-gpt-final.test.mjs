#!/usr/bin/env node
// control-loop-gpt-final.test.mjs — Issue #77 P0-D deterministic tests.
// GPT-5.6 Sol FINAL_REVIEWING via ChatGPT Web CDP transport (injected fake in
// tests; real transport in packages/control-loop/chatgpt-web-cdp.mjs).
// Covers the 8 required cases: valid PASS -> DECIDING, valid REWORK with
// findings, malformed output fail-closed, stale/binding mismatch fail-closed,
// transport failure/timeout never reach DECIDING, Gemini PASS alone never
// reaches DECIDING, adapter carries no terminalization/merge/dispatch
// authority, and module/transport fail-closed seams.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseGptFinalReview, buildFinalReviewPrompt, assertFinalBinding,
  createGptFinalReview, computeRequestDigest, normalizeFinalReviewRequest, GPT_FINAL_VERDICTS,
  buildStructuredPacketDigest, GPT_PACKET_DIGEST_BUDGET,
} from '../packages/control-loop/gpt-final-review.mjs';
import { createChatGptWebCdpTransport, findChatGptPageTarget, parseSseCapture, extractJsonObject, buildUiSendExpression } from '../packages/control-loop/chatgpt-web-cdp.mjs';
import { geminiPreReviewAdapter, gptFinalReviewAdapter } from '../packages/control-loop/adapters.mjs';
import { runControlLoop, readTransitions } from '../packages/control-loop/control-loop.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'clgpt-')); }

const HEAD = 'a'.repeat(40);

function mkSession(stateDir, overrides = {}) {
  const repo = overrides.repo || 'duongpdddic-droid/soc_brain';
  const issueNumber = overrides.issueNumber || 77;
  const id = identityHash({ repo, issueNumber });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1',
    state: 'SESSION_ACTIVE',
    lifecycle: [],
    taskId: `${repo}#${issueNumber}`,
    repo,
    issueNumber,
    headSha: HEAD,
    baseSha: 'f'.repeat(40),
    worktreePath: path.join(stateDir, `wt-issue-${issueNumber}`),
    worktreesRoot: stateDir,
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session, id };
}

function mkPacket(stateDir, session) {
  const dir = path.join(stateDir, 'review-ready');
  fs.mkdirSync(dir, { recursive: true });
  const slug = String(session.repo).replace(/\//g, '_');
  const name = `${slug}_Issue-${session.issueNumber}_PR-78_abcdef0_review-ready.md`;
  const content = [
    `# Review Ready — ${session.repo} Issue #${session.issueNumber} · PR #78`,
    '',
    '## Identity',
    `- repository: ${session.repo}`,
    `- issue: ${session.issueNumber}`,
    '- pullRequest: 78',
    '- branch: agent/test',
    `- headSha: ${HEAD} (short ${HEAD.slice(0, 7)})`,
    `- baseSha: ${'b'.repeat(40)}`,
    '- prState: OPEN',
    '',
    'Canonical packet body for semantic final review.',
    // Full canonical section set (renderReviewReady contract): the structured
    // packet projection (Issue #155 round-6) fails closed on absent headings,
    // so fixtures mirror what renderReviewReady always emits.
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
    '- 1. pr=78 · prState=OPEN · baseBranch=main',
    '',
    '## Terminal status',
    '- status: **READY_FOR_REVIEW**',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
  return { dir, name, content };
}

// Base reply shape without requestDigest — the adapter now validates it.
const baseReply = (overrides = {}) => ({
  verdict: 'PASS',
  findings: [],
  evidenceRequests: [],
  confidence: 0.93,
  metadata: { note: 'ok' },
  binding: { repository: 'duongpdddic-droid/soc_brain', issue: 77, headSha: HEAD },
  ...overrides,
});

// Reply helper that extracts the digest from the prompt and injects it into
// metadata.requestDigest. The transport receives { prompt }, which contains the
// requestDigest line; we parse it out and echo it back so the adapter's
// validation passes.
function mkReplyTransport(replyFn) {
  return async ({ prompt }) => {
    const digestMatch = /Request digest \(include in metadata\.requestDigest\):\s*([0-9a-f]{64})/i.exec(prompt || '');
    const digest = digestMatch ? digestMatch[1] : '0'.repeat(64);
    const reply = replyFn();
    // Inject requestDigest into metadata if not already present
    const obj = JSON.parse(reply);
    if (!obj.metadata) obj.metadata = {};
    obj.metadata.requestDigest = digest;
    return { ok: true, text: JSON.stringify(obj) };
  };
}

// For tests that need a WRONG digest to trigger mismatch
function mkBadDigestTransport(replyFn) {
  return async ({ prompt }) => {
    const reply = replyFn();
    const obj = JSON.parse(reply);
    if (!obj.metadata) obj.metadata = {};
    obj.metadata.requestDigest = 'b'.repeat(64); // wrong digest
    return { ok: true, text: JSON.stringify(obj) };
  };
}

// For A-section tests that call parseGptFinalReview directly (no adapter)
const reply = (overrides = {}) => JSON.stringify(baseReply(overrides));

// ---- A. strict semantic response validation ---------------------------------
{
  const p = parseGptFinalReview(reply());
  eq('A1 valid shape ok', p.ok, true);
  eq('A2 verdict PASS', p.value.verdict, 'PASS');
  eq('A3 confidence passthrough', p.value.confidence, 0.93);
  eq('A4 binding headSha normalized', p.value.binding.headSha, HEAD);
  eq('A5 confidence clamped', parseGptFinalReview(reply({ confidence: 5 })).value.confidence, 1);
  eq('A6 confidence clamped low', parseGptFinalReview(reply({ confidence: -1 })).value.confidence, 0);
  eq('A7 findings bounded', parseGptFinalReview(reply({ findings: Array.from({ length: 60 }, (_, i) => 'f' + i) })).value.findings.length, 50);
  eq('A8 evidenceRequests bounded', parseGptFinalReview(reply({ evidenceRequests: Array.from({ length: 40 }, (_, i) => 'e' + i) })).value.evidenceRequests.length, 32);
  // prose + fences tolerated via balanced-object extraction; garbage is not
  eq('A9 prose-wrapped JSON ok', parseGptFinalReview('Sure! Here it is:\n```json\n' + reply() + '\n```\nDone.').ok, true);
  eq('A10 empty body', parseGptFinalReview('').code, 'GPT_RESPONSE_MALFORMED');
  eq('A11 non-json', parseGptFinalReview('not json {{').code, 'GPT_RESPONSE_MALFORMED');
  eq('A12 missing evidenceRequests', parseGptFinalReview(JSON.stringify({ verdict: 'PASS', findings: [], confidence: 0.5, metadata: {}, binding: { repository: 'r', issue: 1, headSha: HEAD } })).code, 'GPT_RESPONSE_MALFORMED');
  eq('A13 findings non-string element', parseGptFinalReview(reply({ findings: [3] })).code, 'GPT_RESPONSE_MALFORMED');
  eq('A14 verdict outside enum', parseGptFinalReview(reply({ verdict: 'ISSUES' })).code, 'GPT_VERDICT_INVALID');
  eq('A15 binding short headSha', parseGptFinalReview(reply({ binding: { repository: 'r', issue: 1, headSha: 'abc' } })).code, 'GPT_RESPONSE_MALFORMED');
  eq('A16 binding missing', parseGptFinalReview('{"verdict":"PASS","findings":[],"evidenceRequests":[],"confidence":0.5,"metadata":{}}').code, 'GPT_RESPONSE_MALFORMED');
  eq('A17 BLOCKED verdict valid', parseGptFinalReview(reply({ verdict: 'blocked' })).value.verdict, 'BLOCKED');
  tru('A18 verdicts exported', GPT_FINAL_VERDICTS.join(',') === 'PASS,REWORK,BLOCKED');
  // F4: pullRequest in binding is optional but validated when present
  eq('A19 pullRequest valid', parseGptFinalReview(reply({ binding: { repository: 'r', issue: 1, pullRequest: 78, headSha: HEAD } })).ok, true);
  eq('A20 pullRequest invalid type', parseGptFinalReview(reply({ binding: { repository: 'r', issue: 1, pullRequest: 'abc', headSha: HEAD } })).code, 'GPT_RESPONSE_MALFORMED');
  eq('A21 pullRequest negative', parseGptFinalReview(reply({ binding: { repository: 'r', issue: 1, pullRequest: -1, headSha: HEAD } })).code, 'GPT_RESPONSE_MALFORMED');
}

// ---- B. bounded deterministic prompt: canonical FIRST, Gemini SECONDARY ------
{
  const stateDir = mkStateDir();
  const { session } = mkSession(stateDir);
  const packet = mkPacket(stateDir, session);
  const geminiValue = { verdict: 'REWORK', findings: ['gemini-thinks-x'], confidence: 0.4 };
  const nr = normalizeFinalReviewRequest({
    repository: session.repo, issue: session.issueNumber, pullRequest: session.prNumber ?? null,
    headSha: session.headSha, packetExcerpt: packet.content,
    report: { verdict: 'PASS', findings: ['verify-ok'] },
    ledger: [{ from: 'PRE_REVIEWING', to: 'FINAL_REVIEWING', reason: 'ok' }],
    preReview: geminiValue,
  });
  const p = buildFinalReviewPrompt({ session, normalizedRequest: nr });
  const iPacket = p.indexOf('Canonical packet body');
  const iSecondary = p.indexOf('SECONDARY');
  tru('B1 canonical packet comes FIRST', iPacket >= 0 && iPacket < iSecondary);
  tru('B2 gemini clearly labeled secondary', p.includes('Gemini pre-review verdict') && p.includes('INFORM') && p.includes('do not'));
  tru('B3 anti-anchoring instruction present', p.includes('may be wrong'));
  tru('B4 binding echo targets present', p.includes('"repository": "duongpdddic-droid/soc_brain"') && p.includes('"issue": 77'));
  tru('B5 gemini verdict embedded as data', p.includes('gemini-thinks-x'));
  let threw = false;
  try { buildFinalReviewPrompt({ session, normalizedRequest: null }); } catch { threw = true; }
  tru('B6 non-null normalizedRequest required', threw);
  // F1+F3: prompt includes requestDigest line when provided
  const digest = 'a'.repeat(64);
  const nrDigest = normalizeFinalReviewRequest({
    repository: session.repo, issue: session.issueNumber, pullRequest: session.prNumber ?? null,
    headSha: session.headSha, packetExcerpt: packet.content,
    report: { verdict: 'PASS', findings: [] }, ledger: [], preReview: null,
  });
  const pWithDigest = buildFinalReviewPrompt({ session, normalizedRequest: nrDigest, requestDigest: digest });
  tru('B7 requestDigest in prompt', pWithDigest.includes(`Request digest (include in metadata.requestDigest): ${digest}`));
  // F4: prompt includes pullRequest context when session has prNumber
  const pWithPr = buildFinalReviewPrompt({ session: { ...session, prNumber: 78 }, normalizedRequest: nrDigest });
  tru('B8 pullRequest in prompt context', pWithPr.includes('pullRequest: 78'));
  const pNoPr = buildFinalReviewPrompt({ session, normalizedRequest: nrDigest });
  tru('B9 no pullRequest -> omit instruction', pNoPr.includes('omit from binding'));
}

// ---- B2. canonical preReview binding: only normalizedRequest.preReview in prompt --
{
  const stateDir = mkStateDir();
  const { session } = mkSession(stateDir);
  const packet = mkPacket(stateDir, session);
  // 11 findings: normalizedRequest keeps 10, prompt must show only those 10.
  const rawFindings = Array.from({ length: 11 }, (_, i) => `finding-${i}`);
  const rawPreReview = { verdict: 'REWORK', findings: rawFindings, confidence: 0.5 };
  const nr = normalizeFinalReviewRequest({
    repository: session.repo, issue: session.issueNumber, pullRequest: null,
    headSha: session.headSha, packetExcerpt: packet.content,
    report: { verdict: 'PASS', findings: [] }, ledger: [], preReview: rawPreReview,
  });
  const p = buildFinalReviewPrompt({ session, normalizedRequest: nr });
  // finding-10 (11th) must be absent
  falsy('B10 11th preReview finding absent from prompt', p.includes('finding-10'));
  // findings 0-9 must be present
  tru('B10b 1st preReview finding present', p.includes('finding-0'));
  tru('B10c 10th preReview finding present', p.includes('finding-9'));

  // Long finding: 300 chars, normalized to 280; prompt must not contain the full 300-char string.
  const longStr = 'X'.repeat(300);
  const nrLong = normalizeFinalReviewRequest({
    repository: session.repo, issue: session.issueNumber, pullRequest: null,
    headSha: session.headSha, packetExcerpt: packet.content,
    report: { verdict: 'PASS', findings: [] }, ledger: [],
    preReview: { verdict: 'PASS', findings: [longStr], confidence: 0.9 },
  });
  const pLong = buildFinalReviewPrompt({ session, normalizedRequest: nrLong });
  // The full 300-char string must NOT appear; the truncated 280-char version should.
  falsy('B11 full 300-char finding absent from prompt', pLong.includes(longStr));
  tru('B11b truncated 280-char finding in prompt', pLong.includes('X'.repeat(280)));

  // Equality: rendered preReview in prompt must match normalizedRequest.preReview exactly.
  const nrEq = normalizeFinalReviewRequest({
    repository: session.repo, issue: session.issueNumber, pullRequest: null,
    headSha: session.headSha, packetExcerpt: packet.content,
    report: { verdict: 'PASS', findings: [] }, ledger: [],
    preReview: { verdict: 'PASS', findings: ['alpha', 'beta'], confidence: 0.75 },
  });
  const pEq = buildFinalReviewPrompt({ session, normalizedRequest: nrEq });
  const renderedPreReview = JSON.stringify({
    verdict: nrEq.preReview.verdict ?? null,
    findings: nrEq.preReview.findings ?? [],
    confidence: nrEq.preReview.confidence ?? null,
  });
  tru('B12 rendered preReview equals normalizedRequest.preReview', pEq.includes(renderedPreReview));
}

// ---- C. echoed-binding gate ---------------------------------------------------
{
  const ident = { ok: true, repository: 'duongpdddic-droid/soc_brain', issue: 77, headSha: HEAD };
  eq('C1 match ok', assertFinalBinding({ repository: 'DUONGPDDDIC-DROID/SOC_BRAIN', issue: 77, headSha: HEAD.toUpperCase() }, { ident }).ok, true);
  eq('C2 wrong repo', assertFinalBinding({ repository: 'other/repo', issue: 77, headSha: HEAD }, { ident }).code, 'GPT_BINDING_MISMATCH');
  eq('C3 wrong issue', assertFinalBinding({ repository: 'duongpdddic-droid/soc_brain', issue: 75, headSha: HEAD }, { ident }).code, 'GPT_BINDING_MISMATCH');
  eq('C4 stale headSha', assertFinalBinding({ repository: 'duongpdddic-droid/soc_brain', issue: 77, headSha: 'f'.repeat(40) }, { ident }).code, 'GPT_BINDING_MISMATCH');
  // F4: unconditional pullRequest gate
  eq('C5 pullRequest match ok', assertFinalBinding({ repository: 'duongpdddic-droid/soc_brain', issue: 77, pullRequest: 78, headSha: HEAD }, { ident, prNumber: 78 }).ok, true);
  eq('C6 pullRequest mismatch', assertFinalBinding({ repository: 'duongpdddic-droid/soc_brain', issue: 77, pullRequest: 99, headSha: HEAD }, { ident, prNumber: 78 }).code, 'GPT_BINDING_MISMATCH');
  eq('C7 pullRequest missing from binding', assertFinalBinding({ repository: 'duongpdddic-droid/soc_brain', issue: 77, headSha: HEAD }, { ident, prNumber: 78 }).code, 'GPT_BINDING_MISMATCH');
  eq('C8 no prNumber required -> ok without pullRequest', assertFinalBinding({ repository: 'duongpdddic-droid/soc_brain', issue: 77, headSha: HEAD }, { ident, prNumber: null }).ok, true);
  eq('C9 no prNumber required -> ok with pullRequest', assertFinalBinding({ repository: 'duongpdddic-droid/soc_brain', issue: 77, pullRequest: 78, headSha: HEAD }, { ident, prNumber: null }).ok, true);
}

// ---- D. adapter composition (transport injected, deterministic) --------------
{
  const stateDir = mkStateDir();
  const { sessionPath } = mkSession(stateDir);
  const rr = mkPacket(stateDir, { repo: 'duongpdddic-droid/soc_brain', issueNumber: 77 });
  const args = { sessionPath, report: { verdict: 'PASS', findings: [] }, preReview: { verdict: 'PASS', findings: [], confidence: 0.8 } };
  eq('D1 NO_GPT_TRANSPORT fail-closed', (await gptFinalReviewAdapter({ transport: null, reviewReadyDir: rr.dir })(args)).code, 'NO_GPT_TRANSPORT');
  eq('D2 transport failure passthrough', (await gptFinalReviewAdapter({ transport: async () => ({ ok: false, code: 'CDP_WS_ERROR' }), reviewReadyDir: rr.dir })(args)).code, 'CDP_WS_ERROR');
  eq('D3 transport throw', (await gptFinalReviewAdapter({ transport: async () => { throw new Error('boom'); }, reviewReadyDir: rr.dir })(args)).code, 'GPT_TRANSPORT_THROW');
  eq('D4 timeout', (await createGptFinalReview({ transport: () => new Promise(() => {}), reviewReadyDir: rr.dir, timeoutMs: 30 })(args)).code, 'GPT_TRANSPORT_TIMEOUT');
  eq('D5 malformed', (await gptFinalReviewAdapter({ transport: mkReplyTransport(() => reply({ verdict: 'NOT_A_VERDICT' })), reviewReadyDir: rr.dir })(args)).code, 'GPT_VERDICT_INVALID');
  eq('D6 binding mismatch', (await gptFinalReviewAdapter({ transport: mkReplyTransport(() => reply({ binding: { repository: 'duongpdddic-droid/soc_brain', issue: 77, headSha: 'f'.repeat(40) } })), reviewReadyDir: rr.dir })(args)).code, 'GPT_BINDING_MISMATCH');
  eq('D7 missing packet fail-closed before transport', (await gptFinalReviewAdapter({ transport: mkReplyTransport(() => reply()), reviewReadyDir: path.join(stateDir, 'none') })(args)).code, 'NO_REVIEW_PACKET');
  const good = await gptFinalReviewAdapter({ transport: mkReplyTransport(() => reply({ findings: ['fix-x'], evidenceRequests: ['show test X'] })), reviewReadyDir: rr.dir })(args);
  eq('D8 happy ok', good.ok, true);
  eq('D9 verdict', good.value.verdict, 'PASS');
  eq('D10 findings intact', good.value.findings.join(','), 'fix-x');
  eq('D11 evidenceRequests intact', good.value.evidenceRequests.join(','), 'show test X');
  eq('D12 source tag', good.value.metadata.source, 'gpt-final-review');
  tru('D13 value is DATA: exact key set', Object.keys(good.value).sort().join(',') === 'binding,confidence,evidenceRequests,findings,metadata,verdict');
  // Reply stuffed with authority-shaped fields must not leak them through.
  const leakyObj = { ...baseReply(), taskFinish: 'COMPLETED', terminalizeToken: 't', loopToken: 'x', merge: true };
  const leaked = await gptFinalReviewAdapter({ transport: mkReplyTransport(() => JSON.stringify(leakyObj)), reviewReadyDir: rr.dir })(args);
  tru('D14 authority fields dropped', !('taskFinish' in leaked.value) && !('terminalizeToken' in leaked.value) && !('loopToken' in leaked.value));
  tru('D15 no token/authority anywhere in value', !JSON.stringify(leaked.value).includes('terminalizeToken') && !JSON.stringify(leaked.value).includes('loopToken'));
  const rew = await gptFinalReviewAdapter({ transport: mkReplyTransport(() => reply({ verdict: 'REWORK', findings: ['f1', 'f2'] })), reviewReadyDir: rr.dir })(args);
  eq('D16 REWORK verdict', rew.value.verdict, 'REWORK');
  eq('D17 REWORK findings intact', rew.value.findings.length, 2);
  // Issue #98: canonical model identity fallback — reply-provided non-empty
  // metadata.model wins; else non-empty t.modelSlug; else literal 'unknown'
  // (same precedence as PR #95 D13d/D13e/D13f). A successful review value
  // never carries an absent/empty metadata.model.
  const mUnknown = await gptFinalReviewAdapter({ transport: mkReplyTransport(() => reply()), reviewReadyDir: rr.dir })(args);
  eq('D13d no reply model + no modelSlug -> metadata.model "unknown"', mUnknown.value.metadata.model, 'unknown');
  const mSlug = await gptFinalReviewAdapter({ transport: async ({ prompt }) => {
    const digestMatch = /Request digest \(include in metadata\.requestDigest\):\s*([0-9a-f]{64})/i.exec(prompt || '');
    const digest = digestMatch ? digestMatch[1] : '0'.repeat(64);
    const obj = baseReply();
    if (!obj.metadata) obj.metadata = {};
    obj.metadata.requestDigest = digest;
    return { ok: true, text: JSON.stringify(obj), modelSlug: 'gpt-5.6-sol' };
  }, reviewReadyDir: rr.dir })(args);
  eq('D13e transport modelSlug used when reply omits model', mSlug.value.metadata.model, 'gpt-5.6-sol');
  const mReply = await gptFinalReviewAdapter({ transport: async ({ prompt }) => {
    const digestMatch = /Request digest \(include in metadata\.requestDigest\):\s*([0-9a-f]{64})/i.exec(prompt || '');
    const digest = digestMatch ? digestMatch[1] : '0'.repeat(64);
    const obj = baseReply({ metadata: { model: 'reply-model' } });
    obj.metadata.requestDigest = digest;
    return { ok: true, text: JSON.stringify(obj), modelSlug: 'gpt-5.6-sol' };
  }, reviewReadyDir: rr.dir })(args);
  eq('D13f reply metadata.model wins over modelSlug', mReply.value.metadata.model, 'reply-model');
  // F1: metadata.requestDigest is carried through to the result
  tru('D18 requestDigest in result metadata', typeof good.value.metadata.requestDigest === 'string' && good.value.metadata.requestDigest.length === 64);
  // F1: requestDigest mismatch fails closed
  eq('D19 requestDigest mismatch fails closed', (await gptFinalReviewAdapter({ transport: mkBadDigestTransport(() => reply()), reviewReadyDir: rr.dir })(args)).code, 'GPT_REQUEST_DIGEST_MISMATCH');
  // transportFactory: factory is called per-transaction with all five binding values
  const factoryCalls = [];
  const factoryAdapter = createGptFinalReview({
    transportFactory: (binding) => {
      factoryCalls.push(binding);
      return mkReplyTransport(() => reply({ findings: ['factory-ok'] }));
    },
    reviewReadyDir: rr.dir,
  });
  const factoryResult = await factoryAdapter(args);
  eq('D20 transportFactory ok', factoryResult.ok, true);
  eq('D21 transportFactory findings', factoryResult.value.findings.join(','), 'factory-ok');
  eq('D22 transportFactory called once', factoryCalls.length, 1);
  tru('D23 transportFactory binding has repository', factoryCalls[0].repository === 'duongpdddic-droid/soc_brain');
  eq('D24 transportFactory binding has issue', factoryCalls[0].issue, 77);
  eq('D25 transportFactory binding has headSha', factoryCalls[0].headSha, HEAD);
  tru('D26 transportFactory binding has requestDigest', typeof factoryCalls[0].requestDigest === 'string' && factoryCalls[0].requestDigest.length === 64);
  // Neither transportFactory nor transport -> NO_GPT_TRANSPORT
  eq('D27 no factory no transport', (await createGptFinalReview({ reviewReadyDir: rr.dir })(args)).code, 'NO_GPT_TRANSPORT');
  // transportFactory takes precedence over transport when both provided
  const precedenceCalls = [];
  const precedenceResult = await createGptFinalReview({
    transportFactory: (binding) => { precedenceCalls.push('factory'); return mkReplyTransport(() => reply()); },
    transport: () => { precedenceCalls.push('static'); return Promise.resolve({ ok: true, text: reply() }); },
    reviewReadyDir: rr.dir,
  })(args);
  eq('D28 transportFactory precedence', precedenceCalls[0], 'factory');
}

// ---- E. CDP transport module fail-closed seams (no live browser needed) ------
{
  const t0 = createChatGptWebCdpTransport({ spawnSyncImpl: () => ({ error: new Error('conn refused'), status: 1 }) });
  eq('E1 CDP_TARGETS_FAILED', (await t0({ prompt: 'p' })).code, 'CDP_TARGETS_FAILED');
  const t1 = createChatGptWebCdpTransport({ spawnSyncImpl: () => ({ status: 0, stdout: '[]' }) });
  eq('E2 CDP_NO_CHATGPT_TARGET', (await t1({ prompt: 'p' })).code, 'CDP_NO_CHATGPT_TARGET');
  eq('E3 prompt invalid', (await t1({ prompt: ' ' })).code, 'GPT_PROMPT_INVALID');
  eq('E4 findChatGptPageTarget picks chatgpt.com page', findChatGptPageTarget([{ type: 'page', url: 'https://evil.test' }, { type: 'page', url: 'https://chatgpt.com/c/x', webSocketDebuggerUrl: 'ws://x' }]).webSocketDebuggerUrl, 'ws://x');
  eq('E5 findChatGptPageTarget null on none', findChatGptPageTarget([{ type: 'page', url: 'https://evil.test' }]), null);
  const sse = 'data: {"conversation_id":"c1"}\ndata: {"message":{"author":{"role":"assistant"},"content":{"parts":["Hello WORLD"]}}}\ndata: [DONE]\n';
  eq('E6 parseSseCapture text', parseSseCapture(sse).text, 'Hello WORLD');
  eq('E7 parseSseCapture conversation', parseSseCapture(sse).conversationId, 'c1');
  eq('E8 extractJsonObject balanced', extractJsonObject('x {"a":{"b":1}} y'), '{"a":{"b":1}}');
  eq('E9 extractJsonObject null', extractJsonObject('no object'), null);
  const expr = buildUiSendExpression('PROMPT-XYZ', { mustInclude: 'PROMPT-XYZ' });
  tru('E10 ui send expression binds prompt', expr.includes('PROMPT-XYZ') && expr.includes('send-button'));
  const expr2 = buildUiSendExpression('Q');
  tru('E11 no mustInclude -> sentinel check disabled', expr2.includes('const required = null;'));
}

// ---- F. LOOP-LEVEL authority (runControlLoop, deterministic fake transports) --
// runControlLoop requires an EMPTY ledger (it seeds ACCEPTED->ROUTED itself);
// router/executor/verifier are faked; preReview uses the REAL gemini adapter
// with a fake PASS transport; finalReview uses the REAL gpt adapter with the
// injected test transport — the exact production chain with deterministic IO.
function baseDeps(stateDir, calls, gptTransport, geminiTransport) {
  const rr = mkPacket(stateDir, { repo: 'duongpdddic-droid/soc_brain', issueNumber: 77 });
  return {
    reviewReadyDir: rr.dir,
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: '/fake/execution.json' } }; },
    verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', findings: [], report: 'ok' } }; },
    preReview: geminiPreReviewAdapter({ transport: geminiTransport, reviewReadyDir: rr.dir }),
    finalReview: gptFinalReviewAdapter({ transport: gptTransport, reviewReadyDir: rr.dir }),
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
    telegramSpawn: () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 901 })}\n` }),
  };
}
const geminiPass = async () => ({ ok: true, text: JSON.stringify({ verdict: 'PASS', findings: [], confidence: 0.9, metadata: {} }) });
const reachedDeciding = (stateDir, id) => readTransitions({ stateDir, identityHash: id }).some((t) => t.from === 'FINAL_REVIEWING' && t.to === 'DECIDING');

// F1 — required case 1: valid bound GPT PASS reaches DECIDING (and completes).
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const calls = [];
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: baseDeps(stateDir, calls, mkReplyTransport(() => reply()), geminiPass) });
  eq('F1 completed', res.value && res.value.state, 'COMPLETED');
  tru('F1b FINAL_REVIEWING->DECIDING reached', reachedDeciding(stateDir, id));
  tru('F1c DECIDING->DELIVERING reached', readTransitions({ stateDir, identityHash: id }).some((t) => t.from === 'DECIDING' && t.to === 'DELIVERING'));
}

// F2 — required case 2 (P0-E, Issue #79): valid bound GPT REWORK drives the
// rework leg — one re-dispatch through the same executor authority,
// findings/evidenceRequests preserved in the ledger, and the round-2 GPT PASS
// completes the loop.
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir, { controlPlane: { stateDir } });
  const execPath = path.join(stateDir, 'executions', `${id}.json`);
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.writeFileSync(execPath, JSON.stringify({ schemaVersion: '1', kind: 'ExecutionRecord', identityHash: id, taskId: 'duongpdddic-droid/soc_brain#77', repo: 'duongpdddic-droid/soc_brain', issueNumber: 77, terminalStatus: 'ok', exitCode: 0 }, null, 2), 'utf8');
  let gptCall = 0;
  const deps = baseDeps(stateDir, [], mkReplyTransport(() => (gptCall++ === 0)
    ? reply({ verdict: 'REWORK', findings: ['fix-x', 'fix-y'], evidenceRequests: ['show diff D'] })
    : reply()), geminiPass);
  deps.executor = () => ({ ok: true, value: { executionStatus: 'EXITED', terminalStatus: 'ok', exitCode: 0, executionRecordPath: execPath } });
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  eq('F2 rework leg completes on round-2 PASS', res.value && res.value.state, 'COMPLETED');
  const ledger = readTransitions({ stateDir, identityHash: id });
  const rwT = ledger.find((t) => t.from === 'DECIDING' && t.to === 'REWORK');
  eq('F2b findings intact', rwT && rwT.evidence.findings.join(','), 'fix-x,fix-y');
  eq('F2c evidenceRequests intact', rwT && rwT.evidence.evidenceRequests.join(','), 'show diff D');
  tru('F2d DECIDING reached', reachedDeciding(stateDir, id));
  tru('F2e DECIDING->REWORK recorded', Boolean(rwT));
  eq('F2f exactly one executor re-dispatch', ledger.filter((t) => t.from === 'REWORK' && t.to === 'EXECUTING').length, 1);
}

// F3 — required case 3: malformed GPT output fails closed (never DECIDING).
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: baseDeps(stateDir, [], async () => ({ ok: true, text: 'garbage not json' }), geminiPass) });
  falsy('F3 loop fails closed', res.ok);
  eq('F3b code', res.code, 'FINAL_REVIEW_FAILED');
  falsy('F3c never DECIDING', reachedDeciding(stateDir, id));
}

// F4 — required case 4: stale/wrong binding echo fails closed.
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const stale = mkReplyTransport(() => reply({ binding: { repository: 'duongpdddic-droid/soc_brain', issue: 77, headSha: 'f'.repeat(40) } }));
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: baseDeps(stateDir, [], stale, geminiPass) });
  falsy('F4 stale binding fails closed', res.ok);
  eq('F4b code', res.code, 'FINAL_REVIEW_FAILED');
  falsy('F4c never DECIDING', reachedDeciding(stateDir, id));
}

// F5 — required case 5: CDP transport failure/timeout cannot reach DECIDING.
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: baseDeps(stateDir, [], async () => ({ ok: false, code: 'CDP_WS_ERROR' }), geminiPass) });
  falsy('F5 transport failure fails closed', res.ok);
  eq('F5b code', res.code, 'FINAL_REVIEW_FAILED');
  falsy('F5c never DECIDING', reachedDeciding(stateDir, id));
  const rr = mkPacket(stateDir, { repo: 'duongpdddic-droid/soc_brain', issueNumber: 77 });
  const res2 = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: { ...baseDeps(stateDir, [], () => new Promise(() => {}), geminiPass), finalReview: gptFinalReviewAdapter({ transport: () => new Promise(() => {}), reviewReadyDir: rr.dir, timeoutMs: 30 }) } });
  falsy('F5d hanging transport fails closed (timeout bound)', res2.ok);
}

// F6 — required case 6: Gemini PASS without a GPT final result cannot reach DECIDING.
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: baseDeps(stateDir, [], null, geminiPass) });
  falsy('F6 gemini PASS alone insufficient', res.ok);
  eq('F6b code', res.code, 'FINAL_REVIEW_FAILED');
  falsy('F6c never DECIDING', reachedDeciding(stateDir, id));
  tru('F6d gemini pre-review DID run (PASS)', readTransitions({ stateDir, identityHash: id }).some((t) => t.from === 'PRE_REVIEWING' && t.to === 'FINAL_REVIEWING'));
}

// F7 — required case 7: adapter has no terminalization/merge/dispatch authority.
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const leakyObj = { ...baseReply(), taskFinish: 'COMPLETED', terminalizeToken: 'evil', merge: true, dispatch: 'opencode' };
  const leaky = mkReplyTransport(() => JSON.stringify(leakyObj));
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: baseDeps(stateDir, [], leaky, geminiPass) });
  eq('F7 loop completes via its OWN path', res.value && res.value.state, 'COMPLETED');
  const all = JSON.stringify(readTransitions({ stateDir, identityHash: id }));
  tru('F7b no authority leakage in transitions', !all.includes('terminalizeToken') && !all.includes('"merge":true') && !all.includes('"dispatch":"opencode"'));
  tru('F7c verdict evidence is clean data', all.includes('"source":"gpt-final-review"'));
}

// ---- G. computeRequestDigest deterministic properties -----------------------
{
  const d1 = computeRequestDigest({ repository: 'r', issue: 1, headSha: HEAD, packetExcerpt: 'body', report: { verdict: 'PASS', findings: [] }, ledger: [], preReview: null });
  const d2 = computeRequestDigest({ repository: 'r', issue: 1, headSha: HEAD, packetExcerpt: 'body', report: { verdict: 'PASS', findings: [] }, ledger: [], preReview: null });
  eq('G1 deterministic', d1, d2);
  eq('G2 64 hex chars', d1.length, 64);
  tru('G3 hex only', /^[0-9a-f]{64}$/.test(d1));
  const d3 = computeRequestDigest({ repository: 'r', issue: 1, headSha: HEAD, packetExcerpt: 'body', report: { verdict: 'REWORK', findings: [] }, ledger: [], preReview: null });
  tru('G4 change-sensitive (report)', d1 !== d3);
  const d4 = computeRequestDigest({ repository: 'r', issue: 2, headSha: HEAD, packetExcerpt: 'body', report: { verdict: 'PASS', findings: [] }, ledger: [], preReview: null });
  tru('G5 change-sensitive (issue)', d1 !== d4);
  const d5 = computeRequestDigest({ repository: 'r', issue: 1, headSha: HEAD, packetExcerpt: 'body', report: { verdict: 'PASS', findings: [] }, ledger: [{ from: 'A', to: 'B', reason: 'x' }], preReview: null });
  tru('G6 change-sensitive (ledger)', d1 !== d5);
  const d6 = computeRequestDigest({ repository: 'r', issue: 1, pullRequest: 78, headSha: HEAD, packetExcerpt: 'body', report: { verdict: 'PASS', findings: [] }, ledger: [], preReview: null });
  tru('G7 change-sensitive (pullRequest)', d1 !== d6);
}

// ---- H. structured packet projection (Issue #155 round-6) --------------------
// Replaces the old blind 8192 slice: section-aware projection, review-critical
// evidence kept at the real budget, digest binds the exact submitted content,
// oversized packets fail closed BEFORE the transport with the offending
// sections named, and the legacy verification line is truthfully worded.
{
  const stateDir = mkStateDir();
  const { session } = mkSession(stateDir);
  const packet = mkPacket(stateDir, session);

  // H1: an in-budget canonical packet projects VERBATIM (digest identity — the
  // external computeRequestDigest over the source equals the in-flight digest).
  const h1 = buildStructuredPacketDigest(packet.content, { packetName: packet.name });
  eq('H1 projection ok', h1.ok, true);
  eq('H1b in-budget projection is verbatim', h1.value, packet.content);

  // H2: a missing canonical heading fails closed, naming every absent section.
  const noTerm = packet.content.replace(/\n## Terminal status[\s\S]*$/, '\n');
  const h2 = buildStructuredPacketDigest(noTerm, { packetName: packet.name });
  eq('H2 missing section code', h2.code, 'GPT_PACKET_SECTION_MISSING');
  tru('H2b missing names Terminal status', Array.isArray(h2.detail.missing) && h2.detail.missing.includes('Terminal status'));

  // H3: bulky Code evidence is reduced ONLY with an explicit marker; the head
  // (diffStat/commits) and every review-critical section survive.
  const bulky = packet.content.replace(
    '## Code evidence\n- 1. commits=abcdef0 · files=3 · diffStat=+120/-22',
    '## Code evidence\n- 1. commits=abcdef0 · files=3 · diffStat=+120/-22\n' + 'z'.repeat(20000),
  );
  const h3 = buildStructuredPacketDigest(bulky, { packetName: packet.name });
  eq('H3 bulky projection ok', h3.ok, true);
  tru('H3b explicit reduction marker', h3.value.includes('intentionally reduced from'));
  tru('H3c diffStat head survives trim', h3.value.includes('diffStat=+120/-22'));
  tru('H3d Tests section kept verbatim', h3.value.includes('testExecution=787/787'));
  tru('H3e fits budget', h3.value.length <= GPT_PACKET_DIGEST_BUDGET);

  // H4: a review-critical section that cannot fit fails closed with a typed
  // code + the exact offending section sizes (nothing is silently cut).
  const over = packet.content.replace('## Verification\n- 1.', '## Verification\n- 1. pad=' + 'v'.repeat(40000) + '\n- 1.');
  const h4 = buildStructuredPacketDigest(over, { packetName: packet.name });
  eq('H4 oversized code', h4.code, 'GPT_PACKET_BUDGET_EXCEEDED');
  eq('H4b budget reported', h4.detail.budget, GPT_PACKET_DIGEST_BUDGET);
  tru('H4c sections name the overflow', Array.isArray(h4.detail.sections)
    && h4.detail.sections.some((s) => s.title === 'Verification' && s.length > 40000));

  // H5: an embedded same-title heading inside bulky content CANNOT displace the
  // real section (forward search starts at the previous real heading).
  const embedded = packet.content.replace('## Code evidence\n', '## Code evidence\n## Tests\n- fake embedded tests heading\n');
  const h5 = buildStructuredPacketDigest(embedded, { packetName: packet.name });
  eq('H5 embedded-fake projection ok', h5.ok, true);
  tru('H5b real Tests stays after Finding resolution',
    h5.value.indexOf('## Finding resolution') < h5.value.indexOf('- 1. testExecution=787/787'));

  // H6: END-TO-END at the real packet shape — >64 KiB file forces the full
  // re-read path, the deep tail sections (beyond 8192 AND beyond the 64 KiB
  // excerpt) reach the prompt, the prompt stays inside the budget, and the
  // echoed requestDigest equals the digest over the exact projected content.
  const stateDirB = mkStateDir();
  const big = mkSession(stateDirB);
  const dirB = path.join(stateDirB, 'review-ready');
  fs.mkdirSync(dirB, { recursive: true });
  const slugB = String(big.session.repo).replace(/\//g, '_');
  const nameB = `${slugB}_Issue-${big.session.issueNumber}_PR-78_abcdef0_review-ready.md`;
  const bigContent = [
    `# Review Ready — ${big.session.repo} Issue #${big.session.issueNumber} · PR #78`,
    '',
    '## Identity',
    `- repository: ${big.session.repo}`,
    `- issue: ${big.session.issueNumber}`,
    '- pullRequest: 78',
    '- branch: agent/test',
    `- headSha: ${HEAD} (short ${HEAD.slice(0, 7)})`,
    `- baseSha: ${'b'.repeat(40)}`,
    '- prState: OPEN',
    '',
    '## Scope',
    '- 1. note=deep packet under review',
    '',
    '## Code evidence',
    '- 1. commits=deep0001 · files=5 · diffStat=+900/-100',
    'x'.repeat(15000),
    '## Tests\n- fake embedded tests heading (beyond the trim point)\n',
    'y'.repeat(115000),
    '',
    '## Finding resolution',
    '- 1. note=first canonical pass — no prior review findings yet',
    '',
    '## Tests',
    '- 1. testExecution=DEEP-787/787 passed · exitCode=0 · headSha=aaaaaaaa',
    '',
    '## Verification',
    '- 1. legacyEvidenceVerify=PASS · failClosedVerifierCodes=TEST_ONE · prReadBack={"head":"deep"}',
    '',
    '## Safety and mutation analysis',
    '- 1. controlLoopTrace=PRE_REVIEWING->FINAL_REVIEWING (deep)',
    '',
    '## Unverified risks',
    '- 1. semantic review pending',
    '',
    '## Delivery',
    '- 1. pr=78 · prState=OPEN · baseBranch=main',
    '',
    '## Terminal status',
    '- status: **READY_FOR_REVIEW**',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dirB, nameB), bigContent, 'utf8');
  tru('H6a fixture exceeds the 64 KiB collect excerpt', Buffer.byteLength(bigContent, 'utf8') > 64 * 1024);

  let capturedPrompt = null;
  const h6 = await createGptFinalReview({
    transport: async ({ prompt }) => {
      capturedPrompt = prompt;
      const m = /Request digest \(include in metadata\.requestDigest\):\s*([0-9a-f]{64})/i.exec(String(prompt || ''));
      const obj = baseReply({ findings: ['deep-ok'] });
      obj.metadata.requestDigest = m ? m[1] : '0'.repeat(64);
      return { ok: true, text: JSON.stringify(obj) };
    },
    reviewReadyDir: dirB,
  })({ sessionPath: big.sessionPath });
  eq('H6b big-packet review ok', h6.ok, true);
  tru('H6c deep Tests section reached the prompt (beyond 8192 and 64 KiB)',
    typeof capturedPrompt === 'string' && capturedPrompt.includes('testExecution=DEEP-787/787'));
  tru('H6d deep Verification evidence reached the prompt',
    capturedPrompt.includes('failClosedVerifierCodes=TEST_ONE') && capturedPrompt.includes('legacyEvidenceVerify=PASS'));
  tru('H6e safety trace + terminal status reached the prompt',
    capturedPrompt.includes('controlLoopTrace=') && capturedPrompt.includes('READY_FOR_REVIEW'));
  tru('H6f bulky reduction marker present', capturedPrompt.includes('intentionally reduced from'));
  tru('H6g prompt stays at the real budget',
    capturedPrompt.length < GPT_PACKET_DIGEST_BUDGET + 6000);
  const projB = buildStructuredPacketDigest(bigContent, { packetName: nameB });
  eq('H6h projection of big packet ok', projB.ok, true);
  const expectedDigest = computeRequestDigest({
    repository: big.session.repo, issue: big.session.issueNumber, pullRequest: big.session.prNumber ?? null,
    headSha: big.session.headSha, packetExcerpt: projB.value,
    report: {}, ledger: [], preReview: null,
  });
  eq('H6i requestDigest binds the exact projected content submitted',
    h6.value.metadata.requestDigest, expectedDigest);
  eq('H6j embedded fake heading was trimmed away (only the real section remains)',
    (projB.value.match(/^## Tests$/gm) || []).length, 1);

  // H7: missing-section packet fails closed BEFORE the transport is touched.
  const stateDirC = mkStateDir();
  const miss = mkSession(stateDirC);
  const dirC = path.join(stateDirC, 'review-ready');
  fs.mkdirSync(dirC, { recursive: true });
  const slugC = String(miss.session.repo).replace(/\//g, '_');
  const nameC = `${slugC}_Issue-${miss.session.issueNumber}_PR-78_abcdef0_review-ready.md`;
  const noVer = packet.content.replace(/\n## Verification\n[\s\S]*?(?=\n## Safety and mutation analysis)/, '\n');
  fs.writeFileSync(path.join(dirC, nameC), noVer, 'utf8');
  let transportCalls = 0;
  const h7 = await createGptFinalReview({
    transport: async () => { transportCalls += 1; return { ok: true, text: reply() }; },
    reviewReadyDir: dirC,
  })({ sessionPath: miss.sessionPath });
  eq('H7 missing-section fail-closed code', h7.code, 'GPT_PACKET_SECTION_MISSING');
  eq('H7b transport NEVER invoked on fail-closed projection', transportCalls, 0);

  // H8: legacy verification wording — expected-not-missing, never a fake PASS;
  // the canonical path keeps the historical UNKNOWN wording.
  const legacySession = { ...session, evidenceMode: 'legacy', provenance: { provenance: 'legacy-adoption' } };
  const nrLegacy = normalizeFinalReviewRequest({
    repository: session.repo, issue: session.issueNumber, pullRequest: null,
    headSha: HEAD, packetExcerpt: 'p', report: undefined, ledger: [], preReview: null,
  });
  const pLegacy = buildFinalReviewPrompt({ session: legacySession, normalizedRequest: nrLegacy });
  tru('H8 legacy verdict named LEGACY_EXTERNAL_NOT_CANONICAL',
    pLegacy.includes('Verification verdict: LEGACY_EXTERNAL_NOT_CANONICAL'));
  falsy('H8b no UNKNOWN verdict for legacy sessions', pLegacy.includes('Verification verdict: UNKNOWN'));
  falsy('H8c legacy path never claims a PASS verdict', /Verification verdict: PASS/.test(pLegacy));
  const pCanonical = buildFinalReviewPrompt({ session, normalizedRequest: nrLegacy });
  tru('H8d non-legacy keeps UNKNOWN verdict wording', pCanonical.includes('Verification verdict: UNKNOWN'));
}

// ---- summary ------------------------------------------------------------------
let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : ` — got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
}
console.log(`control-loop-gpt-final: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exit(1);
// end of control-loop-gpt-final.test.mjs — no trailing marker.
