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
  createGptFinalReview, computeRequestDigest, GPT_FINAL_VERDICTS,
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
  const p = buildFinalReviewPrompt({ session, report: { verdict: 'PASS', findings: ['verify-ok'] }, ledger: [{ from: 'PRE_REVIEWING', to: 'FINAL_REVIEWING', reason: 'ok' }], packet: { ok: true, name: packet.name, excerpt: packet.content, truncated: false }, preReview: geminiValue });
  const iPacket = p.indexOf('Canonical packet body');
  const iSecondary = p.indexOf('SECONDARY');
  tru('B1 canonical packet comes FIRST', iPacket >= 0 && iPacket < iSecondary);
  tru('B2 gemini clearly labeled secondary', p.includes('Gemini pre-review verdict') && p.includes('INFORM') && p.includes('do not'));
  tru('B3 anti-anchoring instruction present', p.includes('may be wrong'));
  tru('B4 binding echo targets present', p.includes('"repository": "duongpdddic-droid/soc_brain"') && p.includes('"issue": 77'));
  tru('B5 gemini verdict embedded as data', p.includes('gemini-thinks-x'));
  let threw = false;
  try { buildFinalReviewPrompt({ session, report: {}, ledger: [], packet: { ok: false, code: 'NO_REVIEW_PACKET' }, preReview: null }); } catch { threw = true; }
  tru('B6 non-ok packet refused (fail-closed)', threw);
  // F1+F3: prompt includes requestDigest line when provided
  const digest = 'a'.repeat(64);
  const pWithDigest = buildFinalReviewPrompt({ session, report: { verdict: 'PASS', findings: [] }, ledger: [], packet: { ok: true, name: packet.name, excerpt: packet.content, truncated: false }, preReview: null, requestDigest: digest });
  tru('B7 requestDigest in prompt', pWithDigest.includes(`Request digest (include in metadata.requestDigest): ${digest}`));
  // F4: prompt includes pullRequest context when session has prNumber
  const pWithPr = buildFinalReviewPrompt({ session: { ...session, prNumber: 78 }, report: { verdict: 'PASS', findings: [] }, ledger: [], packet: { ok: true, name: packet.name, excerpt: packet.content, truncated: false }, preReview: null });
  tru('B8 pullRequest in prompt context', pWithPr.includes('pullRequest: 78'));
  const pNoPr = buildFinalReviewPrompt({ session, report: { verdict: 'PASS', findings: [] }, ledger: [], packet: { ok: true, name: packet.name, excerpt: packet.content, truncated: false }, preReview: null });
  tru('B9 no pullRequest -> omit instruction', pNoPr.includes('omit from binding'));
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

// ---- summary ------------------------------------------------------------------
let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : ` — got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
}
console.log(`control-loop-gpt-final: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exit(1);
// end of control-loop-gpt-final.test.mjs — no trailing marker.
