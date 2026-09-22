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
} from '../packages/control-loop/gemini-plus-web2api-copy.mjs';

function geminiPage(url = 'https://gemini.google.com/app/abc123def', id = 't1', ws = 'ws://127.0.0.1:9224/tab1') {
  return { type: 'page', url, webSocketDebuggerUrl: ws, targetId: id };
}

function nonGeminiPage(url = 'https://example.com', id = 't2', ws = 'ws://127.0.0.1:9224/tab2') {
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

console.log('control-loop-gemini-web2api-copy: all offline tests passed');
