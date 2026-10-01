import { reviewFixture } from './fixtures/web2api-review.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findGeminiPageTarget,
  conversationIdFromTargetUrl,
  TURN_IDS_EXPRESSION,
  isStreaming,
  submitViaClick,
  readTurnIds,
  readConversationId,
  createGeminiFinalReviewFallbackTransport,
  createGeminiFinalReviewWithDiffTransport,
  createGeminiWeb2ApiRawTransport,
  createGeminiWeb2ApiRawLazyTransport,
  createGeminiWeb2ApiReviewTransport,
  createGeminiWeb2ApiAdvisorTransport,
  normalizeExtractedReply,
} from '../packages/control-loop/gemini-plus-web2api-copy.mjs';

function geminiPage(url = 'https://gemini.google.com/app/abc123def', id = 't1', ws = 'ws://127.0.0.1:9222/tab1') {
  return { type: 'page', url, webSocketDebuggerUrl: ws, targetId: id };
}

function nonGeminiPage(url = 'https://example.com', id = 't2', ws = 'ws://127.0.0.1:9222/tab2') {
  return { type: 'page', url, webSocketDebuggerUrl: ws, targetId: id };
}

function mkSession({ evalResponses = [], sendLog = [] } = {}) {
  let evalIdx = 0;
  return {
    sendLog,
    send(method, params) {
      sendLog.push({ method, params });
      if (method === 'Runtime.evaluate') {
        const response = evalResponses[Math.min(evalIdx++, evalResponses.length - 1)];
        return Promise.resolve({ result: { result: { value: response } } });
      }
      return Promise.resolve({ result: {} });
    },
    close() {},
  };
}

// ---- findGeminiPageTarget ----
test('findGeminiPageTarget returns null for non-array', () => {
  assert.equal(findGeminiPageTarget(null), null);
  assert.equal(findGeminiPageTarget(undefined), null);
  assert.equal(findGeminiPageTarget('string'), null);
});

test('findGeminiPageTarget returns null when no gemini page found', () => {
  const targets = [nonGeminiPage()];
  assert.equal(findGeminiPageTarget(targets), null);
});

test('findGeminiPageTarget finds gemini page among mixed targets', () => {
  const gp = geminiPage();
  const targets = [nonGeminiPage(), gp, nonGeminiPage()];
  assert.equal(findGeminiPageTarget(targets), gp);
});

test('findGeminiPageTarget skips non-page targets', () => {
  const targets = [{ type: 'iframe', url: 'https://gemini.google.com/app/x', targetId: 'i1' }];
  assert.equal(findGeminiPageTarget(targets), null);
});

test('findGeminiPageTarget handles missing url', () => {
  const targets = [{ type: 'page', targetId: 't1', webSocketDebuggerUrl: 'ws://x' }];
  assert.equal(findGeminiPageTarget(targets), null);
});

// ---- conversationIdFromTargetUrl ----
test('conversationIdFromTargetUrl extracts id from /app/ path', () => {
  assert.equal(conversationIdFromTargetUrl('https://gemini.google.com/app/abc123def'), 'abc123def');
});

test('conversationIdFromTargetUrl extracts id from /gem/ path', () => {
  assert.equal(conversationIdFromTargetUrl('https://gemini.google.com/gem/abc123/def456'), 'def456');
});

test('conversationIdFromTargetUrl returns null for no match', () => {
  assert.equal(conversationIdFromTargetUrl('https://gemini.google.com/'), null);
  assert.equal(conversationIdFromTargetUrl(''), null);
  assert.equal(conversationIdFromTargetUrl(null), null);
});

// ---- BardVeMetadataKey regex (embedded in TURN_IDS_EXPRESSION) ----
test('TURN_IDS_EXPRESSION is a string containing BardVeMetadataKey', () => {
  assert.equal(typeof TURN_IDS_EXPRESSION, 'string');
  assert.ok(TURN_IDS_EXPRESSION.includes('BardVeMetadataKey'));
});

test('BardVeMetadataKey regex matches valid base64 keys', () => {
  const regex = /BardVeMetadataKey:([A-Za-z0-9+/=_-]+)/;
  const sample = 'BardVeMetadataKey:SGVsbG8gV29ybGQ=';
  const m = regex.exec(sample);
  assert.ok(m);
  assert.equal(m[1], 'SGVsbG8gV29ybGQ=');
});

test('BardVeMetadataKey regex does not match when key group is missing', () => {
  const regex = /BardVeMetadataKey:([A-Za-z0-9+/=_-]+)/;
  assert.equal(regex.exec('SomeOtherKey:value'), null);
});

// ---- isStreaming ----
test('isStreaming returns false when no stop button found', async () => {
  const session = mkSession({ evalResponses: [false] });
  assert.equal(await isStreaming(session), false);
});

test('isStreaming returns true when stop button detected', async () => {
  const session = mkSession({ evalResponses: [true] });
  assert.equal(await isStreaming(session), true);
});

// ---- submitViaClick ----
test('submitViaClick returns error when model is streaming', async () => {
  const session = mkSession({ evalResponses: [true] });
  const result = await submitViaClick(session, 'hello');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'model_is_streaming');
});

test('submitViaClick returns error when editor not found', async () => {
  const session = mkSession({ evalResponses: [false, JSON.stringify({ ok: false, reason: 'editor_not_found' })] });
  const result = await submitViaClick(session, 'hello');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'editor_not_found');
});

test('submitViaClick succeeds when not streaming and editor found', async () => {
  const session = mkSession({
    evalResponses: [
      false,
      JSON.stringify({ ok: true }),
      JSON.stringify({ clicked: true }),
    ],
  });
  const result = await submitViaClick(session, 'hello');
  assert.equal(result.ok, true);
});

test('submitViaClick falls back to Enter key when send button not found', async () => {
  const session = mkSession({
    evalResponses: [
      false,
      JSON.stringify({ ok: true }),
      JSON.stringify({ clicked: false }),
    ],
  });
  const result = await submitViaClick(session, 'hello');
  assert.equal(result.ok, true);
  const keyDown = session.sendLog.find((l) => l.method === 'Input.dispatchKeyEvent' && l.params.type === 'rawKeyDown');
  assert.ok(keyDown, 'should dispatch Enter keyDown');
  assert.equal(keyDown.params.windowsVirtualKeyCode, 13);
});

// ---- readTurnIds ----
test('readTurnIds parses turn IDs from session', async () => {
  const session = mkSession({ evalResponses: [JSON.stringify(['turn-a', 'turn-b'])] });
  const ids = await readTurnIds(session);
  assert.deepEqual(ids, ['turn-a', 'turn-b']);
});

test('readTurnIds returns empty array for null response', async () => {
  const session = mkSession({ evalResponses: [null] });
  const ids = await readTurnIds(session);
  assert.deepEqual(ids, []);
});

// ---- readConversationId ----
test('readConversationId parses conversation ID', async () => {
  const session = mkSession({ evalResponses: ['"abc123"'] });
  const id = await readConversationId(session);
  assert.equal(id, 'abc123');
});

test('readConversationId returns null for null response', async () => {
  const session = mkSession({ evalResponses: [null] });
  const id = await readConversationId(session);
  assert.equal(id, null);
});

// ---- createGeminiFinalReviewFallbackTransport ----
test('transport returns GEMINI_PROMPT_INVALID for empty prompt', async () => {
  const transport = createGeminiFinalReviewFallbackTransport({});
  const r = await transport({ prompt: '' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'GEMINI_PROMPT_INVALID');
});

test('transport returns GEMINI_PROMPT_INVALID for missing prompt', async () => {
  const transport = createGeminiFinalReviewFallbackTransport({});
  const r = await transport({});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'GEMINI_PROMPT_INVALID');
});

test('transport returns GEMINI_PROMPT_INVALID for non-string prompt', async () => {
  const transport = createGeminiFinalReviewFallbackTransport({});
  const r = await transport({ prompt: 123 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'GEMINI_PROMPT_INVALID');
});

test('transport returns UNAVAILABLE when no Gemini page target found', async () => {
  const runner = () => ({ status: 0, stdout: '[]', stderr: '' });
  const transport = createGeminiFinalReviewFallbackTransport({ runner });
  const r = await transport({ prompt: 'test prompt' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WEB2API_COPY_UNAVAILABLE');
});

// ---- MODEL_SLUG_EXPRESSION regex (EN+VI) ----
test('MODEL_SLUG_EXPRESSION supports Vietnamese pattern', () => {
  const label = 'Hiện tại là Gemini 2.5 Pro';
  const m = label.match(/(?:hiện tại là|current model is|currently)\s+(.+)$/i);
  assert.ok(m);
  assert.equal(m[1].trim(), 'Gemini 2.5 Pro');
});

test('MODEL_SLUG_EXPRESSION supports English pattern "current model is"', () => {
  const label = 'Current model is Gemini 2.5 Flash';
  const m = label.match(/(?:hiện tại là|current model is|currently)\s+(.+)$/i);
  assert.ok(m);
  assert.equal(m[1].trim(), 'Gemini 2.5 Flash');
});

test('MODEL_SLUG_EXPRESSION supports English pattern "currently"', () => {
  const label = 'currently Gemini 1.5 Pro';
  const m = label.match(/(?:hiện tại là|current model is|currently)\s+(.+)$/i);
  assert.ok(m);
  assert.equal(m[1].trim(), 'Gemini 1.5 Pro');
});

test('MODEL_SLUG_EXPRESSION rejects unmatched text', () => {
  const label = 'No model info here';
  const m = label.match(/(?:hiện tại là|current model is|currently)\s+(.+)$/i);
  assert.equal(m, null);
});

// ---- send button locale-independence ----
test('submitViaClick send button matches Vietnamese label', async () => {
  const session = mkSession({
    evalResponses: [
      false,
      JSON.stringify({ ok: true }),
      JSON.stringify({ clicked: true }),
    ],
  });
  const result = await submitViaClick(session, 'test');
  assert.equal(result.ok, true);
});

test('submitViaClick send button matches English label', async () => {
  const session = mkSession({
    evalResponses: [
      false,
      JSON.stringify({ ok: true }),
      JSON.stringify({ clicked: true }),
    ],
  });
  const result = await submitViaClick(session, 'test');
  assert.equal(result.ok, true);
});

// ==== Issue #262: tiered Web2API transport contract (offline, injected fakes) ====
// Layer 1 (raw) -> Layer 2 consumers with THEIR OWN contracts:
//   pre-review  = strict JSON {verdict: PASS|REWORK, findings, confidence, metadata}
//   final review= a `VERDICT: APPROVED|CHANGES_REQUESTED|BLOCKED` line
//   advisor     = plain reply content as guidance (no VERDICT header ever required)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { geminiPreReviewAdapter } from '../packages/control-loop/adapters.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { buildReworkRecord, buildReworkInstruction } from '../packages/control-loop/rework.mjs';
import { normalizeReviewDecision } from '../packages/control-loop/verdict-parser.mjs';

const RAW_JSON_REPLY = JSON.stringify({ verdict: 'PASS', findings: ['f1'], confidence: 0.95, metadata: {} });
const RAW_FREE_TEXT_REPLY = 'I inspected the diff but I am not going to give you a machine-readable answer.';
const mkRawOk = (text, rawText = text) => async () => ({ ok: true, text, rawText });

function mkPreReviewStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-')); }

function mkPreReviewSession(stateDir, overrides = {}) {
  const repo = overrides.repo || 'duongpdddic-droid/soc_brain';
  const issueNumber = overrides.issueNumber || 75;
  const id = identityHash({ repo, issueNumber });
  const sessionPath = path.join(stateDir, 'sessions', id + '.json');
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1',
    state: 'SESSION_ACTIVE',
    taskId: repo + '#' + issueNumber,
    repo,
    issueNumber,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    worktreePath: path.join(stateDir, 'wt'),
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session };
}

function mkPreReviewPacket(stateDir, session) {
  const dir = path.join(stateDir, 'review-ready');
  fs.mkdirSync(dir, { recursive: true });
  const slug = String(session.repo).replace(/\//g, '_');
  const name = slug + '_Issue-' + session.issueNumber + '_PR-76_abcdef0_review-ready.md';
  const head = String(session.headSha).toLowerCase();
  const content = [
    '# Review Ready - ' + session.repo + ' Issue #' + session.issueNumber + ' - PR #76',
    '',
    '## Identity',
    '- repository: ' + session.repo,
    '- issue: ' + session.issueNumber,
    '- pullRequest: 76',
    '- branch: agent/test',
    '- headSha: ' + head + ' (short ' + head.slice(0, 7) + ')',
    '- baseSha: ' + 'b'.repeat(40),
    '- prState: OPEN',
    '',
    'Canonical packet body for semantic pre-review.',
    '',
    '## Terminal status',
    '- status: **READY_FOR_REVIEW**',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
  return { dir, name, content };
}

// ---- Layer 1: raw transport payload + race-order contract --------------------
test('Issue #262 raw: snapshots turn ids BEFORE submit; success carries BOTH text and rawText', async () => {
  const order = [];
  let reads = 0;
  const raw = await createGeminiWeb2ApiRawTransport({
    listTargetsImpl: () => [{ type: 'page', url: 'https://gemini.google.com/app/x', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/x' }],
    cdpSessionFactory: () => ({ send: async () => ({ result: {} }), close() {} }),
    readTurnIdsImpl: async () => { order.push('readTurnIds'); reads += 1; return reads === 1 ? ['t-old'] : ['t-old', 't-new']; },
    submitImpl: async () => { order.push('submit'); return { ok: true }; },
    pollImpl: async () => { order.push('poll'); return { ok: true, text: 'REPLY', newTurnId: 't-new' }; },
    sleepImpl: async () => {},
  });
  const r = await raw({ prompt: 'review please' });
  assert.equal(r.ok, true);
  assert.deepEqual(order, ['readTurnIds', 'submit', 'readTurnIds', 'poll', 'readTurnIds']);
  assert.equal(r.text, 'REPLY');
  assert.equal(r.rawText, 'REPLY');
  assert.equal(r.newTurnId, 't-new');
  assert.equal(typeof r.metadata, 'object');
});

test('Issue #262 raw: fail-closed seams (prompt/page/submit/turn/poll)', async () => {
  const mk = (over = {}) => createGeminiWeb2ApiRawTransport({
    listTargetsImpl: () => [{ type: 'page', url: 'https://gemini.google.com/app/x', webSocketDebuggerUrl: 'ws://x' }],
    cdpSessionFactory: () => ({ send: async () => ({ result: {} }), close() {} }),
    readTurnIdsImpl: async () => ['t'],
    submitImpl: async () => ({ ok: true }),
    pollImpl: async () => ({ ok: true, text: 'R' }),
    sleepImpl: async () => {},
    ...over,
  });
  assert.equal((await (await mk())({ prompt: '' })).code, 'GEMINI_PROMPT_INVALID');
  assert.equal((await (await mk())({})).code, 'GEMINI_PROMPT_INVALID');
  assert.equal((await (await mk({ listTargetsImpl: () => [] }))({ prompt: 'p' })).code, 'WEB2API_COPY_UNAVAILABLE');
  assert.equal((await (await mk({ listTargetsImpl: () => { throw new Error('curl dead'); } }))({ prompt: 'p' })).code, 'WEB2API_COPY_UNAVAILABLE');
  assert.equal((await (await mk({ submitImpl: async () => ({ ok: false, reason: 'model_is_streaming' }) }))({ prompt: 'p' })).code, 'model_is_streaming');
  const timed = (() => { let t = 0; return () => (t += 100000); })();
  assert.equal((await (await mk({ nowImpl: timed }))({ prompt: 'p' })).code, 'TURN_NOT_OBSERVED');
  let pollTurnReads = 0;
  const pollFail = await (await mk({
    readTurnIdsImpl: async () => { pollTurnReads += 1; return pollTurnReads === 1 ? ['t'] : ['t', 't2']; },
    pollImpl: async () => ({ ok: false, code: 'REVIEW_TIMEOUT', detail: 'x' }),
  }))({ prompt: 'p' });
  assert.equal(pollFail.ok, false);
  assert.equal(pollFail.code, 'REVIEW_TIMEOUT');
  assert.equal(pollFail.detail, 'x');
});

// ---- Layer 1: bounded chrome normalization ----------------------------------
test('Issue #262 normalizeExtractedReply strips only leading non-JSON lines', () => {
  const body = '{\n  "verdict": "PASS"\n}';
  assert.equal(normalizeExtractedReply('Gemini said\nJSON\n' + body), body);
  assert.equal(normalizeExtractedReply(body), body);
  assert.equal(normalizeExtractedReply(RAW_FREE_TEXT_REPLY), RAW_FREE_TEXT_REPLY);
  assert.equal(normalizeExtractedReply(''), '');
  assert.equal(normalizeExtractedReply(null), '');
  assert.equal(normalizeExtractedReply('preamble line\n```json\n{"a":1}\n```'), 'preamble line\n```json\n{"a":1}\n```');
});

// ---- Pre-review consumer: strict JSON contract (parseGeminiReview) -----------
test('Issue #262 pre-review: raw JSON reply -> ok verdict PASS (regression: never VERDICT_NOT_FOUND)', async () => {
  const stateDir = mkPreReviewStateDir();
  const { sessionPath, session } = mkPreReviewSession(stateDir);
  const packet = mkPreReviewPacket(stateDir, session);
  let sawPrompt = null;
  const raw = async ({ prompt } = {}) => {
    sawPrompt = prompt;
    return { ok: true, text: RAW_JSON_REPLY, rawText: 'Gemini said\nJSON\n' + RAW_JSON_REPLY };
  };
  const r = await geminiPreReviewAdapter({ transport: raw, reviewReadyDir: packet.dir })({
    sessionPath,
    report: { verdict: 'PASS', findings: [] },
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.verdict, 'PASS');
  assert.equal(r.value.findings.length, 1);
  assert.equal(r.value.metadata.source, 'gemini-pre-review');
  assert.ok(typeof sawPrompt === 'string' && sawPrompt.includes('Canonical review-ready packet'));
});

test('Issue #262 pre-review: raw free-text reply -> GEMINI_RESPONSE_MALFORMED (fail-closed, never PASS)', async () => {
  const stateDir = mkPreReviewStateDir();
  const { sessionPath } = mkPreReviewSession(stateDir);
  const packet = mkPreReviewPacket(stateDir, mkPreReviewSession(stateDir).session);
  const r = await geminiPreReviewAdapter({ transport: mkRawOk(RAW_FREE_TEXT_REPLY), reviewReadyDir: packet.dir })({
    sessionPath,
    report: { verdict: 'PASS', findings: [] },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'GEMINI_RESPONSE_MALFORMED');
});

test('Issue #262 pre-review: failed transport detail echo bounded to 2KB (ledger bloat guard)', async () => {
  const stateDir = mkPreReviewStateDir();
  const { sessionPath, session } = mkPreReviewSession(stateDir);
  const packet = mkPreReviewPacket(stateDir, session);
  const huge = 'R'.repeat(5000);
  const failing = async () => ({ ok: false, code: 'COPY_EMPTY', rawText: huge, detail: { rawText: huge } });
  const r = await geminiPreReviewAdapter({ transport: failing, reviewReadyDir: packet.dir })({
    sessionPath,
    report: { verdict: 'PASS', findings: [] },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'COPY_EMPTY');
  assert.equal(r.detail.rawText.length, 2049); // 2048 chars + ellipsis marker
  assert.equal(r.detail.detail.rawText.length, 2049);
});

// ---- Advisor consumer: plain guidance, no VERDICT header --------------------
test('Issue #262 advisor: raw free-text reply becomes guidance (no VERDICT_NOT_FOUND special case)', async () => {
  const advisor = await createGeminiWeb2ApiAdvisorTransport({ rawTransport: mkRawOk(RAW_FREE_TEXT_REPLY) });
  const r = await advisor({ prompt: 'how should the executor fix this?' });
  assert.equal(r.ok, true);
  assert.equal(r.guidance, RAW_FREE_TEXT_REPLY);
  assert.equal(r.text, RAW_FREE_TEXT_REPLY);
  assert.equal(r.rawText, RAW_FREE_TEXT_REPLY);
  assert.equal(r.source, 'gemini-web2api-advisor');
});

test('Issue #262 advisor: Layer-1 failure passes through fail-closed (no synthesized guidance)', async () => {
  const advisor = await createGeminiWeb2ApiAdvisorTransport({ rawTransport: async () => ({ ok: false, code: 'CDP_LOST' }) });
  const r = await advisor({ prompt: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CDP_LOST');
  assert.equal(r.guidance, undefined);
});

// ---- Final review consumer: VERDICT line contract (parseReviewVerdict) ------
test('Issue #262 final review: raw reply WITHOUT a VERDICT line -> VERDICT_NOT_FOUND (fail-closed)', async () => {
  const fixture = reviewFixture();
  const review = await createGeminiWeb2ApiReviewTransport({ rawTransport: async () => ({ ...fixture.response, text: RAW_FREE_TEXT_REPLY, rawText: RAW_FREE_TEXT_REPLY }) });
  const r = await review(fixture.ctx);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'VERDICT_NOT_FOUND');
  assert.equal(r.verdict, 'BLOCKED');
  assert.equal(r.rawText, RAW_FREE_TEXT_REPLY);
});

test('Issue #262 final review: Layer-1 failure -> verdict BLOCKED with code passthrough', async () => {
  const review = await createGeminiWeb2ApiReviewTransport({ rawTransport: async () => ({ ok: false, code: 'TURN_NOT_OBSERVED' }) });
  const fixture = reviewFixture();
  const r = await review(fixture.ctx);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TURN_NOT_OBSERVED');
  assert.equal(r.verdict, 'BLOCKED');
});

test('Issue #262 final review: reply with a final VERDICT line -> ok APPROVED (contract preserved)', async () => {
  const fixture = reviewFixture({ verdict: 'APPROVED', findings: ['Non-blocking observation'] });
  const reply = fixture.response.rawText;
  const review = await createGeminiWeb2ApiReviewTransport({ rawTransport: async () => fixture.response });
  const r = await review(fixture.ctx);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'APPROVED');
  assert.equal(r.rawText, reply);
  assert.ok(r.metadata.findingsCount >= 1);
  assert.equal(typeof r.rationale, 'string');
});

// ---- MAX_CLIPBOARD_CHARS import + oversized-prompt fail-closed ---------------
test('Issue #262: MAX_CLIPBOARD_CHARS is imported where it is used (no ReferenceError path)', async () => {
  const srcPath = fileURLToPath(new URL('../packages/control-loop/gemini-plus-web2api-copy.mjs', import.meta.url));
  const src = fs.readFileSync(srcPath, 'utf8');
  assert.match(src, /import\s*\{[^}]*MAX_CLIPBOARD_CHARS[^}]*\}\s*from\s*'\.\/review-payload\.mjs'/);
  const t = await createGeminiFinalReviewWithDiffTransport({});
  const r = await t({ prNumber: 9999, headSha: 'a'.repeat(40), diff: 'x'.repeat(1100000) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REVIEW_PROMPT_TOO_LARGE');
  assert.equal(r.verdict, 'BLOCKED');
});

// ==== Web2API/CDP profile contract: lazy transport forwards the resolved
// profile (SOC_CDP_USER_DATA_DIR / SOC_CDP_PROFILE_DIRECTORY) to the CDP
// supervisor. All offline: the supervisor is an injected fake, never a browser.
// SOC_CWA_* is CWA-only configuration and is never read on this path. ====

function mkLazySupervisor({ chromeResult = { ok: true }, targetResult = { ok: true, target: {} } } = {}) {
  const state = { opts: null, targetCalls: 0 };
  const supervisorFactory = (opts) => {
    state.opts = opts;
    return {
      ensureChromeRunning: async () => chromeResult,
      ensureTargetPage: async () => { state.targetCalls += 1; return targetResult; },
    };
  };
  return { state, supervisorFactory };
}

test('profile contract: lazy transport forwards default port/null profile to the supervisor', async () => {
  const { state, supervisorFactory } = mkLazySupervisor();
  const dispatch = await createGeminiWeb2ApiRawLazyTransport({ supervisorFactory });
  await dispatch({ prompt: 'x' });
  assert.ok(state.opts, 'supervisor factory must be invoked');
  assert.equal(state.opts.port, 9222);
  assert.equal(state.opts.userDataDir, null);
  assert.equal(state.opts.profileDirectory, null);
});

test('profile contract: lazy transport forwards explicit cdpPort/userDataDir/profileDirectory verbatim', async () => {
  const { state, supervisorFactory } = mkLazySupervisor();
  const dispatch = await createGeminiWeb2ApiRawLazyTransport({
    cdpPort: 9333,
    userDataDir: 'C:\\ud',
    profileDirectory: 'Profile 1',
    supervisorFactory,
  });
  await dispatch({ prompt: 'x' });
  assert.ok(state.opts, 'supervisor factory must be invoked');
  assert.equal(state.opts.port, 9333);
  assert.equal(state.opts.userDataDir, 'C:\\ud');
  assert.equal(state.opts.profileDirectory, 'Profile 1');
});

test('profile contract: USER_DATA_DIR_OCCUPIED from ensureChromeRunning fails closed, ensureTargetPage never called', async () => {
  const { state, supervisorFactory } = mkLazySupervisor({
    chromeResult: { ok: false, code: 'CDP_SUPERVISOR_USER_DATA_DIR_OCCUPIED', error: 'occupied' },
  });
  const dispatch = await createGeminiWeb2ApiRawLazyTransport({ supervisorFactory });
  const r = await dispatch({ prompt: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CDP_SUPERVISOR_USER_DATA_DIR_OCCUPIED');
  assert.equal(r.detail, 'occupied');
  assert.equal(state.targetCalls, 0, 'ensureTargetPage must never run when Chrome is refused');
});

test('profile contract: ensureTargetPage failure passes through fail-closed with its code', async () => {
  const { supervisorFactory } = mkLazySupervisor({
    targetResult: { ok: false, code: 'CDP_SUPERVISOR_TARGET_NOT_FOUND', error: 'no gemini' },
  });
  const dispatch = await createGeminiWeb2ApiRawLazyTransport({ supervisorFactory });
  const r = await dispatch({ prompt: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CDP_SUPERVISOR_TARGET_NOT_FOUND');
});

test('profile contract: supervisor+target OK reaches the raw transport (empty prompt -> GEMINI_PROMPT_INVALID from inside)', async () => {
  const { supervisorFactory } = mkLazySupervisor();
  const dispatch = await createGeminiWeb2ApiRawLazyTransport({ supervisorFactory });
  // GEMINI_PROMPT_INVALID is produced ONLY inside createGeminiWeb2ApiRawTransport,
  // so this proves the supervisor -> target -> raw-transport chain is wired
  // without any browser.
  const r = await dispatch({ prompt: '' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'GEMINI_PROMPT_INVALID');
});

test('profile contract: static source regression — lazy transport binds the profile; run.js resolves cdp config', () => {
  const srcPath = fileURLToPath(new URL('../packages/control-loop/gemini-plus-web2api-copy.mjs', import.meta.url));
  const src = fs.readFileSync(srcPath, 'utf8');
  const fnStart = src.indexOf('export async function createGeminiWeb2ApiRawLazyTransport');
  assert.ok(fnStart >= 0, 'createGeminiWeb2ApiRawLazyTransport must exist');
  const fnBody = src.slice(fnStart, fnStart + 1200);
  assert.match(fnBody, /userDataDir/, 'lazy transport must accept userDataDir');
  assert.match(fnBody, /profileDirectory/, 'lazy transport must accept profileDirectory');
  const runPath = fileURLToPath(new URL('../packages/control-loop/run.js', import.meta.url));
  const runSrc = fs.readFileSync(runPath, 'utf8');
  assert.match(runSrc, /resolveCdpConfig/, 'run.js must resolve the CDP profile contract');
});

// ==== Issue #260 regression: the REWORK (CHANGES_REQUESTED) response shape
// actually seen in the live smoke on task #260. The Layer-2 success payload
// used to drop `findings`/`evidenceRequests`, which buildReworkRecord copies
// VERBATIM (rework.mjs:49/52) -> uncaught `decision.findings is not
// iterable`, exit 1. Offline, injected rawTransport fakes only. Existing
// Issue #262 APPROVED tests above stay untouched. ====

// Built like the live reply: a Finding 1:/Finding 2: pair above the
// `VERDICT: CHANGES_REQUESTED` line.
const LIVE_CHANGES_REQUESTED_REPLY = [
  'Finding 1: bounds check off by one in resolveRange (src/range.mjs:42).',
  'Finding 2: missing null guard before dereference (src/range.mjs:57).',
  '',
  'VERDICT: CHANGES_REQUESTED',
].join('\n');

test('Issue #260 final review: live CHANGES_REQUESTED reply -> ok verdict CHANGES_REQUESTED with findings + evidenceRequests published', async () => {
  const fixture = reviewFixture({ findings: LIVE_CHANGES_REQUESTED_REPLY.split('\n').filter((l) => l.startsWith('Finding')), ...(typeof session !== 'undefined' ? { session: { ...session, prNumber: 263 } } : {}) });
  const review = await createGeminiWeb2ApiReviewTransport({ rawTransport: async () => fixture.response });
  const r = await review(fixture.ctx);
  assert.equal(r.ok, true);
  // Verdict mapping invariant: CHANGES_REQUESTED stays CHANGES_REQUESTED at
  // the transport — it must NEVER surface as 'APPROVED' or 'PASS' (the REWORK
  // FSM mapping happens only via the existing REVIEW_VERDICT_TO_FSM seam).
  assert.equal(r.verdict, 'CHANGES_REQUESTED');
  assert.notEqual(r.verdict, 'APPROVED');
  assert.notEqual(r.verdict, 'PASS');
  assert.equal(Array.isArray(r.findings), true, 'findings must be published as an array (canonical decision contract)');
  assert.ok(r.findings.length > 0, 'the real parsed findings must not be empty');
  assert.equal(r.findings.length, r.metadata.findingsCount, 'findings.length must equal metadata.findingsCount');
  assert.equal(Array.isArray(r.evidenceRequests), true, 'evidenceRequests must be published as an array');
  assert.ok(String(r.rationale).includes('bounds check off by one'), 'rationale still contains the finding text');
});

test('Issue #260 rework record: buildReworkRecord spreads the transport payload without throwing', async () => {
  const fixture = reviewFixture({ findings: LIVE_CHANGES_REQUESTED_REPLY.split('\n').filter((l) => l.startsWith('Finding')), ...(typeof session !== 'undefined' ? { session: { ...session, prNumber: 263 } } : {}) });
  const review = await createGeminiWeb2ApiReviewTransport({ rawTransport: async () => fixture.response });
  const payload = await review(fixture.ctx);
  assert.equal(payload.ok, true);
  const record = buildReworkRecord({
    identityHash: 'a'.repeat(64),
    round: 1,
    digest: 'd'.repeat(64),
    decision: payload,
  });
  assert.deepEqual(record.findings, payload.findings, 'record.findings deep-equals the payload findings (verbatim copy)');
  assert.deepEqual(record.evidenceRequests, payload.evidenceRequests, 'record.evidenceRequests deep-equals the payload evidenceRequests (verbatim copy)');
  const instruction = buildReworkInstruction({ session: { repo: 'r', issueNumber: 1 }, record });
  assert.equal(typeof instruction, 'string');
  assert.ok(instruction.includes('Finding'), 'the rework instruction carries the finding text to the executor');
});

test('Issue #260 boundary guard target: buildReworkRecord on a REWORK decision WITHOUT findings throws the exact TypeError the typed boundary check exists to prevent', () => {
  // Pins the EXACT failure class the REVIEW_DECISION_FINDINGS_MISSING /
  // REVIEW_DECISION_EVIDENCE_MISSING boundary checks in
  // bin/soc-control-loop.mjs guard against: at the unit level this is a
  // TypeError from `[...decision.findings]` (rework.mjs:49); at the
  // transport->decision boundary it must instead surface as a typed,
  // observable error — never an uncaught TypeError, never a `findings = []`
  // data substitute.
  assert.throws(
    () => buildReworkRecord({
      identityHash: 'a'.repeat(64),
      round: 1,
      digest: 'd'.repeat(64),
      decision: { verdict: 'REWORK' },
    }),
    (err) => err instanceof TypeError && err.message === 'decision.findings is not iterable',
  );
});

// ==== Issue #260 full chain: transport -> normalizeReviewDecision (the
// decide() seam) -> buildReworkRecord preserves findings / evidenceRequests /
// confidence / binding at every stage. Offline injected fakes only; the
// existing Issue #262 APPROVED tests above stay untouched. ====

test('Issue #260 full chain: transport -> decision -> rework record preserves findings, evidenceRequests, confidence and binding', async () => {
  const stateDir = mkPreReviewStateDir();
  const { session } = mkPreReviewSession(stateDir); // carries repo/issueNumber/headSha
  const fixture = reviewFixture({ findings: LIVE_CHANGES_REQUESTED_REPLY.split('\n').filter((l) => l.startsWith('Finding')), ...(typeof session !== 'undefined' ? { session: { ...session, prNumber: 263 } } : {}) });
  const review = await createGeminiWeb2ApiReviewTransport({ rawTransport: async () => fixture.response });

  // ---- Stage 1: transport (the real Layer-2 success payload) ----
  const payload = await review(fixture.ctx);
  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.equal(payload.verdict, 'CHANGES_REQUESTED', 'verdict is still CHANGES_REQUESTED at the transport');
  assert.equal(Array.isArray(payload.findings), true, 'transport publishes findings as an array');
  assert.ok(payload.findings.length >= 2, 'the live reply yields 2+ Finding lines');
  assert.equal(Array.isArray(payload.evidenceRequests), true, 'evidenceRequests is an array at the transport stage');
  assert.equal(payload.confidence, null, 'confidence present: documented null for a VERDICT-text reply');

  // ---- Stage 2: normalizeReviewDecision (the ONE decide() seam) ----
  const nd = normalizeReviewDecision({ decision: payload, session });
  assert.equal(nd.ok, true, JSON.stringify(nd));
  const decision = nd.value;
  assert.equal(decision.verdict, 'REWORK', 'CHANGES_REQUESTED maps to the FSM REWORK verdict at normalization');
  assert.deepEqual(decision.findings, payload.findings, 'findings deep-equal across transport -> decision');
  assert.deepEqual(decision.evidenceRequests, payload.evidenceRequests, 'evidenceRequests deep-equal across transport -> decision');
  assert.equal(decision.confidence, null, 'confidence present (documented null) across transport -> decision');

  // ---- Stage 3: buildReworkRecord ----
  const record = buildReworkRecord({
    identityHash: 'a'.repeat(64), round: 1, digest: 'd'.repeat(64), decision,
  });
  assert.deepEqual(record.findings, payload.findings, 'findings deep-equal across transport -> decision -> record');
  assert.equal(Array.isArray(record.evidenceRequests), true, 'evidenceRequests is an array at the record stage');
  assert.deepEqual(record.evidenceRequests, payload.evidenceRequests, 'evidenceRequests deep-equal across transport -> decision -> record');
  assert.equal(record.provenance.reviewerConfidence, null, 'confidence lands in record.provenance.reviewerConfidence');

  // ---- Binding identity across the chain ----
  // The VERDICT-text transport payload carries NO reviewer binding echo by
  // design; normalize stamps the loop-owned CANONICAL SESSION identity, and
  // buildReworkRecord copies that binding VERBATIM. So from the moment the
  // binding exists (decision) through the record, repository/issue/headSha
  // are identical — and they equal the session identity the transport ran
  // against.
  const B = { repository: session.repo.toLowerCase(), issue: session.issueNumber, headSha: session.headSha.toLowerCase(), pullRequest: 263 };
  assert.deepEqual(payload.binding, B, 'transport carries the reviewer echo validated against the persisted request');
  assert.deepEqual(decision.binding, B, 'decision.binding is the canonical session identity');
  assert.deepEqual(record.binding, decision.binding, 'record.binding deep-equals decision.binding');
  assert.equal(record.binding.repository, B.repository, 'binding.repository identical across stages');
  assert.equal(record.binding.issue, B.issue, 'binding.issue identical across stages');
  assert.equal(record.binding.headSha, B.headSha, 'binding.headSha identical across stages');
});

test('Issue #260 full chain (negative): a REWORK decision with findings missing and NO rawText survives normalize and hits the exact TypeError the typed guard exists to prevent', () => {
  // normalizeReviewDecision passes a STRUCTURED REWORK verdict through
  // byte-identical and NEVER substitutes `[]` for a missing field, so the
  // pre-fix payload shape (verdict + metadata.findingsCount, NO findings, NO
  // rawText) reaches buildReworkRecord unchanged and throws
  // `decision.findings is not iterable`. This pins the exact failure the
  // REVIEW_DECISION_FINDINGS_MISSING typed boundary guard exists to prevent
  // — the guard must fire BEFORE this spread in decide()/bin/soc-control-loop.
  const session = { repo: 'duongpdddic-droid/soc_brain', issueNumber: 260, headSha: 'a'.repeat(40) };
  const staleDecision = {
    verdict: 'REWORK',
    rationale: 'contract-stale pre-fix payload',
    metadata: { conversationId: null, modelSlug: null, pollTimeout: false, findingsCount: 50 },
    binding: { repository: session.repo, issue: session.issueNumber, headSha: session.headSha },
    // findings ABSENT, evidenceRequests ABSENT, rawText ABSENT (on purpose)
  };
  const nd = normalizeReviewDecision({ decision: staleDecision, session });
  assert.equal(nd.ok, true, 'normalize passes a structured REWORK decision through unchanged');
  assert.equal(nd.value.findings, undefined, 'normalize never substitutes [] for a missing field');
  assert.equal(nd.value.evidenceRequests, undefined, 'normalize never substitutes [] for a missing evidenceRequests either');
  assert.throws(
    () => buildReworkRecord({
      identityHash: 'a'.repeat(64),
      round: 1,
      digest: 'd'.repeat(64),
      decision: nd.value,
    }),
    (err) => err instanceof TypeError && err.message === 'decision.findings is not iterable',
    'buildReworkRecord on the unrecovered stale decision throws the exact TypeError the typed guard prevents',
  );
});

console.log('control-loop-gemini-web2api-copy: all offline tests passed');
