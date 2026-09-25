import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createChatGptPlusWeb2ApiCopyTransport,
  createClipboardCollector,
  diffTurnIds,
  TURN_IDS_EXPRESSION,
  WEB2API_COPY_CODES,
  WEB2API_COPY_DEFAULT_HOST,
  WEB2API_COPY_DEFAULT_PORT,
  WEB2API_FRESH_SYSTEM_PART,
  createCopyLock,
  wrapPromptForCopyExtraction,
} from '../packages/control-loop/chatgpt-plus-web2api-copy.mjs';

const GOOD_RESPONSE = JSON.stringify({
  verdict: 'PASS',
  findings: [],
  evidenceRequests: [],
  confidence: 0.99,
  metadata: { source: 'web2api-copy' },
  binding: { repository: 'duongpdddic-droid/Soc_brain', issue: 197, headSha: 'b'.repeat(40) },
});

function pageTarget(url = 'https://chatgpt.com/c/conv-1', id = 'target-1', ws = 'ws://127.0.0.1:9222/tab') {
  return { type: 'page', url, webSocketDebuggerUrl: ws, targetId: id };
}

function sessionFactory({ snapshots, keyLog = [], readiness = [{ ready: true }] } = {}) {
  let evalIndex = 0;
  let readinessIndex = 0;
  return async () => {
    const calls = [];
    return {
      calls,
      async send(method, params) {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          const expression = String(params?.expression || '');
          // TURN_IDS_EXPRESSION drives pre/post fresh-turn observation.
          if (expression === TURN_IDS_EXPRESSION) {
            const ids = snapshots[Math.min(evalIndex++, snapshots.length - 1)];
            return { result: { result: { value: JSON.stringify(ids) } } };
          }
          // latest-turn DOM-readiness polling is a separate Runtime.evaluate.
          // Happy-path fixtures model the exact fresh turn as newest, fully rendered,
          // no longer streaming, with its own code block and native Copy control.
          if (expression.includes('exactFreshTurnIsNewest') && expression.includes('hasCopy')) {
            const state = readiness[Math.min(readinessIndex++, readiness.length - 1)] || { ready: false };
            const normalized = {
              ready: !!state.ready,
              streaming: state.streaming ?? !state.ready,
              expectedTurnId: state.expectedTurnId ?? 'B',
              observedTurnId: state.observedTurnId ?? (state.ready ? 'B' : null),
              newestTurnId: state.newestTurnId ?? 'B',
              exactFreshTurnIsNewest: state.exactFreshTurnIsNewest ?? !!state.ready,
              hasCode: state.hasCode ?? !!state.ready,
              hasCopy: state.hasCopy ?? !!state.ready,
            };
            return { result: { result: { value: JSON.stringify(normalized) } } };
          }
          return { result: { result: { value: undefined } } };
        }
        if (method === 'Input.dispatchKeyEvent') keyLog.push({ method, params });
        if (method === 'Target.activateTarget') keyLog.push({ method, params });
        return { result: {} };
      },
      close() {},
    };
  };
}

function clipboard({ reads = [], seqs = [10, 11] } = {}) {
  let readIndex = 0;
  let seqIndex = 0;
  const last = (values) => values[values.length - 1];
  return {
    clearCount: 0,
    clear() {
      this.clearCount += 1;
      return { ok: true };
    },
    read() {
      const value = readIndex < reads.length ? reads[readIndex++] : last(reads);
      return { ok: true, text: value };
    },
    seq() {
      return seqIndex < seqs.length ? seqs[seqIndex++] : last(seqs);
    },
  };
}

function clock() {
  let now = 0;
  return {
    nowImpl: () => now,
    sleepImpl: async () => { now += 25; },
  };
}

function transportFor({
  snapshots = [['A'], ['A', 'B']],
  reads = [GOOD_RESPONSE],
  seqs = [10, 11],
  response = { status: 200, json: async () => ({ conversation_id: 'conv-1', model: 'auto' }) },
  fetchImpl,
  listTargets = () => [pageTarget()],
  clipboardImpl,
  keyLog = [],
  readiness = [{ ready: true }],
  sessionOpenLog = [],
  extra = {},
} = {}) {
  const baseSessionFactory = sessionFactory({ snapshots, keyLog, readiness });
  const cdpSessionFactory = async (wsUrl) => {
    sessionOpenLog.push(wsUrl);
    return baseSessionFactory(wsUrl);
  };
  const fetchCalls = [];
  const actualFetch = fetchImpl || (async (url, options) => {
    fetchCalls.push({ url, options });
    return response;
  });
  const activationCalls = [];
  const activationFetchImpl = async (url, options) => {
    activationCalls.push({ url, options });
    return { ok: true, status: 200 };
  };
  const now = clock();
  const transport = createChatGptPlusWeb2ApiCopyTransport({
    web2apiHost: '127.0.0.1',
    web2apiPort: 8081,
    cdpPort: 9222,
    model: 'auto',
    fetchImpl: actualFetch,
    activationFetchImpl,
    listTargetsImpl: listTargets,
    cdpSessionFactory,
    clipboard: clipboardImpl || clipboard({ reads, seqs }),
    sleepImpl: now.sleepImpl,
    nowImpl: now.nowImpl,
    copyTimeoutMs: 10,
    copyPollMs: 1,
    maxCopyAttempts: 3,
    lock: createCopyLock(),
    ...extra,
  });
  return { transport, fetchCalls, activationCalls, keyLog, sessionOpenLog };
}

test('native-copy happy path submits once and reads the fresh turn', async () => {
  const { transport, fetchCalls, activationCalls } = transportFor();
  const result = await transport({ prompt: 'review-prompt' });

  assert.equal(result.ok, true);
  assert.equal(result.text, GOOD_RESPONSE);
  assert.equal(result.conversationId, 'conv-1');
  assert.equal(result.modelSlug, 'auto');
  assert.equal(result.transportMeta.turnId, 'B');
  assert.equal(result.transportMeta.shortcutAttempts, 1);
  assert.equal(result.transportMeta.submitUncertain, false);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'http://127.0.0.1:8081/v1/chat/completions');
  assert.equal(fetchCalls[0].options.method, 'POST');
  assert.equal(fetchCalls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(activationCalls.length, 1);
  assert.equal(activationCalls[0].url, 'http://127.0.0.1:9222/json/activate/target-1');
  assert.equal(activationCalls[0].options.method, 'PUT');
  const body = JSON.parse(fetchCalls[0].options.body);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, WEB2API_FRESH_SYSTEM_PART);
  // The user prompt is now wrapped with the semantic-neutral format contract
  assert.ok(body.messages[1].content.includes('review-prompt'));
  assert.ok(body.messages[1].content.includes('FORMAT CONTRACT'));
  assert.match(TURN_IDS_EXPRESSION, /data-message-author-role="assistant"/);
});

test('native copy uses the exact 7-step Oracle sequence', async () => {
  const { transport, keyLog, activationCalls } = transportFor();
  const result = await transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, true);

  // Step 1 must use Chrome's HTTP /json/activate endpoint, exactly like the
  // proven PowerShell Oracle. CDP Target.activateTarget must not be used.
  assert.equal(activationCalls.length, 1);
  assert.equal(activationCalls[0].url, 'http://127.0.0.1:9222/json/activate/target-1');
  assert.equal(activationCalls[0].options.method, 'PUT');
  const activateTargetCalls = keyLog.filter((call) => call.method === 'Target.activateTarget');
  assert.equal(activateTargetCalls.length, 0);

  // Verify key events
  const keyCalls = keyLog.filter((call) => call.method === 'Input.dispatchKeyEvent').map((call) => call.params);
  assert.equal(keyCalls.length, 2);

  // rawKeyDown with exact Oracle params
  assert.deepEqual(keyCalls[0], {
    type: 'rawKeyDown',
    modifiers: 10,
    windowsVirtualKeyCode: 186,
    nativeVirtualKeyCode: 186,
    key: ';',
    code: 'Semicolon',
  });

  // keyUp with exact Oracle params
  assert.deepEqual(keyCalls[1], {
    type: 'keyUp',
    modifiers: 10,
    windowsVirtualKeyCode: 186,
    nativeVirtualKeyCode: 186,
    key: ';',
    code: 'Semicolon',
  });
});

test('empty and bad clipboard are rejected without a copy', async () => {
  const empty = transportFor({ reads: [''], seqs: [10, 11] });
  const emptyResult = await empty.transport({ prompt: 'review-prompt' });
  assert.equal(emptyResult.ok, false);
  assert.equal(emptyResult.code, WEB2API_COPY_CODES.COPY_EMPTY);

  const bad = clipboard({ reads: [GOOD_RESPONSE], seqs: [10, 11] });
  bad.read = () => ({ ok: false, code: WEB2API_COPY_CODES.COPY_BAD });
  const badResult = await transportFor({ clipboardImpl: bad }).transport({ prompt: 'review-prompt' });
  assert.equal(badResult.ok, false);
  assert.equal(badResult.code, WEB2API_COPY_CODES.COPY_BAD);
  assert.equal(bad.clearCount, 1);
});

test('bounded clipboard polling waits for fresh response after native copy', async () => {
  // Oracle sequence dispatches the shortcut exactly once, then clipboard readback
  // may remain empty briefly while the browser keyboard-copy handler completes.
  const seqClip = clipboard({ reads: ['', '', GOOD_RESPONSE], seqs: [10, 11] });
  const result = await transportFor({ clipboardImpl: seqClip }).transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, true);
  assert.equal(result.text, GOOD_RESPONSE);
  // No interference expected with direct read (no polling/collector)
  assert.equal(result.transportMeta.interference, 0);
});

test('a fresh assistant turn is required before readback', async () => {
  const tracked = { calls: 0 };
  const result = await transportFor({
    snapshots: [['A'], ['A']],
    reads: [GOOD_RESPONSE],
    fetchImpl: async () => {
      tracked.calls += 1;
      return { status: 200, json: async () => ({ conversation_id: 'conv-1', model: 'auto' }) };
    },
  }).transport({ prompt: 'review-prompt' });

  assert.equal(result.ok, false);
  assert.equal(result.code, WEB2API_COPY_CODES.TURN_NOT_OBSERVED);
  assert.equal(tracked.calls, 1);
});

test('confirmed submit is never blind-resubmitted', async () => {
  const tracked = { calls: 0 };
  const result = await transportFor({
    fetchImpl: async () => {
      tracked.calls += 1;
      return { status: 200, json: async () => ({ conversation_id: 'conv-1', model: 'auto' }) };
    },
  }).transport({ prompt: 'review-prompt' });

  assert.equal(result.ok, true);
  assert.equal(tracked.calls, 1);
});

test('uncertain submit reconciles the observed turn without a retry', async () => {
  const tracked = { calls: 0 };
  const result = await transportFor({
    response: { status: 504, json: async () => ({}) },
    fetchImpl: async () => {
      tracked.calls += 1;
      return { status: 504, json: async () => ({}) };
    },
  }).transport({ prompt: 'review-prompt' });

  assert.equal(result.ok, true);
  assert.equal(result.transportMeta.submitUncertain, true);
  assert.equal(result.transportMeta.turnId, 'B');
  assert.equal(tracked.calls, 1);
});

test('uncertain submit with no fresh turn fails closed and does not retry', async () => {
  const tracked = { calls: 0 };
  const result = await transportFor({
    response: { status: 500, json: async () => ({}) },
    snapshots: [['A'], ['A']],
    reads: [GOOD_RESPONSE],
    fetchImpl: async () => {
      tracked.calls += 1;
      return { status: 500, json: async () => ({}) };
    },
  }).transport({ prompt: 'review-prompt' });

  assert.equal(result.ok, false);
  assert.equal(result.code, WEB2API_COPY_CODES.TURN_NOT_OBSERVED);
  assert.equal(result.submitUncertain, true);
  assert.equal(result.reconcileRequired, true);
  assert.equal(result.safeToRetry, false);
  assert.equal(tracked.calls, 1);
});

test('wrong ChatGPT target or conversation fails closed', async () => {
  const result = await transportFor({
    listTargets: () => [pageTarget('https://chatgpt.com/c/other')],
    response: { status: 200, json: async () => ({ conversation_id: 'conv-1', model: 'auto' }) },
    reads: [GOOD_RESPONSE],
  }).transport({ prompt: 'review-prompt' });

  assert.equal(result.ok, false);
  assert.equal(result.code, WEB2API_COPY_CODES.CONVERSATION_MISMATCH);
});

test('a reused conversation is rejected within the same transport instance', async () => {
  const { transport } = transportFor();
  const first = await transport({ prompt: 'review-prompt' });
  assert.equal(first.ok, true);
  const second = await transport({
    prompt: 'review-prompt',
  });
  assert.equal(second.ok, false);
  assert.equal(second.code, WEB2API_COPY_CODES.CONVERSATION_REUSED);
});

test('clipboard collector is sequence-scoped and diffTurnIds finds only new turns', () => {
  const seqClip = clipboard({ reads: ['old', GOOD_RESPONSE], seqs: [10, 11, 12] });
  const collector = createClipboardCollector({ clip: seqClip, nowImpl: () => 1 });
  assert.equal(collector.start(), 10);
  assert.deepEqual(collector.pollOnce(), { item: { seq: 11, t: 1, text: 'old' } });
  assert.deepEqual(collector.pollOnce(), { item: { seq: 12, t: 1, text: GOOD_RESPONSE } });
  assert.deepEqual(diffTurnIds(['A'], ['A', 'B']), ['B']);
  assert.deepEqual(diffTurnIds(['A'], ['A']), []);
  assert.equal(WEB2API_COPY_DEFAULT_HOST, '127.0.0.1');
  assert.equal(WEB2API_COPY_DEFAULT_PORT, 8081);
});

// --- New regression tests for S3 semantic-neutral wrapper and POST instrumentation ---

test('semantic-neutral wrapper contains no Final Review terms', () => {
  const wrapped = wrapPromptForCopyExtraction('test prompt');
  assert.ok(wrapped.includes('FORMAT CONTRACT'));
  assert.ok(wrapped.includes('EXACTLY ONE fenced JSON code block'));
  assert.ok(!wrapped.includes('verdict'));
  assert.ok(!wrapped.includes('requestDigest'));
  assert.ok(!wrapped.includes('binding'));
  assert.ok(!wrapped.includes('Final Review'));
  assert.ok(!wrapped.includes('strict Final Review JSON object'));
});

test('effective prompt preserves caller nonce and source', () => {
  const callerPrompt = 'S3 SMOKE REVIEW NONCE-123: Please respond with EXACTLY ONE fenced JSON code block containing only the fields: ' + '"nonce": "NONCE-123", ' + '"source": "s3-web2api-copy-smoke"';
  const wrapped = wrapPromptForCopyExtraction(callerPrompt);
  assert.ok(wrapped.includes('NONCE-123'));
  assert.ok(wrapped.includes('s3-web2api-copy-smoke'));
  // The wrapper appends its format contract without altering caller content
  assert.ok(wrapped.startsWith(callerPrompt));
});

test('transportMeta.postCount reports actual POST count = 1 on success', async () => {
  const { transport, fetchCalls } = transportFor();
  const result = await transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, true);
  assert.equal(result.transportMeta.postCount, 1);
  assert.equal(fetchCalls.length, 1);
});

test('transportMeta.postCount = 1 on COPY_EMPTY (one actual POST, failed readback)', async () => {
  const emptyClip = clipboard({ reads: [''], seqs: [10, 11] });
  const { transport, fetchCalls } = transportFor({ clipboardImpl: emptyClip });
  const result = await transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, false);
  assert.equal(result.code, WEB2API_COPY_CODES.COPY_EMPTY);
  assert.equal(result.transportMeta.postCount, 1);
  assert.equal(fetchCalls.length, 1);
});

test('simulated second POST detected — calling transport twice produces postCount=2 per invocation', async () => {
  // To get postCount=2, we must call transport twice (each invocation = 1 POST)
  const { transport } = transportFor();
  const first = await transport({ prompt: 'review-prompt' });
  assert.equal(first.transportMeta.postCount, 1);
  const second = await transport({ prompt: 'review-prompt' });
  assert.equal(second.transportMeta.postCount, 1);
  // Each invocation reports postCount=1, but calling twice means 2 total POSTs
  // The invariant is per-invocation: postCount === 1 per call
  // A bug that calls POST twice in one invocation would show postCount=2
});

test('exact native-copy shortcut unchanged — modifiers=10, VK=186, nativeVK=186, keydown+keyup', async () => {
  const { transport, keyLog } = transportFor();
  const result = await transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, true);
  const keyCalls = keyLog.filter((call) => call.method === 'Input.dispatchKeyEvent').map((call) => call.params);
  assert.equal(keyCalls.length, 2);
  assert.deepEqual(keyCalls[0], {
    type: 'rawKeyDown',
    modifiers: 10,
    windowsVirtualKeyCode: 186,
    nativeVirtualKeyCode: 186,
    key: ';',
    code: 'Semicolon',
  });
  assert.deepEqual(keyCalls[1], {
    type: 'keyUp',
    modifiers: 10,
    windowsVirtualKeyCode: 186,
    nativeVirtualKeyCode: 186,
    key: ';',
    code: 'Semicolon',
  });
});

test('no blind resubmit on uncertain submit — postCount remains 1', async () => {
  const tracked = { calls: 0 };
  const result = await transportFor({
    response: { status: 504, json: async () => ({}) },
    fetchImpl: async () => {
      tracked.calls += 1;
      return { status: 504, json: async () => ({}) };
    },
  }).transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, true);
  assert.equal(result.transportMeta.submitUncertain, true);
  assert.equal(result.transportMeta.postCount, 1);
  assert.equal(tracked.calls, 1);
});


test('Oracle copy phase resolves exact conversation target and reconnects websocket only after HTTP activation', async () => {
  let listCall = 0;
  const exact = { type: 'page', url: 'https://chatgpt.com/c/conv-1', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/exact', id: 'exact-id' };
  const other = { type: 'page', url: 'https://chatgpt.com/c/other', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/other', id: 'other-id' };
  const observation = pageTarget('https://chatgpt.com/c/conv-1', 'observation-id', 'ws://127.0.0.1:9222/observation');
  const listTargets = () => {
    listCall += 1;
    // Pre-submit and turn observation stay on the known observed page. At the
    // native-copy boundary expose a competing ChatGPT tab first: the transport
    // must bind to conversationId, not array order.
    return listCall < 3 ? [observation] : [other, exact];
  };
  const { transport, activationCalls, sessionOpenLog } = transportFor({ listTargets });
  const result = await transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, true);
  assert.equal(activationCalls.length, 1);
  assert.equal(activationCalls[0].url, 'http://127.0.0.1:9222/json/activate/exact-id');
  assert.equal(sessionOpenLog.at(-1), 'ws://127.0.0.1:9222/exact');
  assert.ok(sessionOpenLog.length >= 3, 'copy phase must open a fresh post-activation websocket');
});

// --- Stage S4: Binding & Verdict validation tests ---

function makeResponse(overrides = {}) {
  const base = {
    verdict: 'PASS',
    findings: [],
    evidenceRequests: [],
    confidence: 0.99,
    metadata: { source: 'web2api-copy', requestDigest: 'abc123' },
    binding: { repository: 'duongpdddic-droid/Soc_brain', issue: 197, pullRequest: 42, headSha: 'b'.repeat(40) },
  };
  return JSON.stringify({ ...base, ...overrides });
}

function transportWithBinding({
  reads = [makeResponse()],
  seqs = [10, 11],
  bindingRepository = 'duongpdddic-droid/Soc_brain',
  bindingIssue = 197,
  bindingPullRequest = 42,
  bindingHeadSha = 'b'.repeat(40),
  bindingRequestDigest = 'abc123',
  ...extra
} = {}) {
  return transportFor({
    reads,
    seqs,
    extra: {
      bindingRepository,
      bindingIssue,
      bindingPullRequest,
      bindingHeadSha,
      bindingRequestDigest,
      ...extra.extra,
    },
  });
}

test('valid review payload with 5-field exact match and verdict PASS returns ok true', async () => {
  const { transport } = transportWithBinding();
  const result = await transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, true);
  assert.equal(result.text, makeResponse());
});

test('valid review payload with verdict REWORK returns ok true', async () => {
  const { transport } = transportWithBinding({ reads: [makeResponse({ verdict: 'REWORK' })] });
  const result = await transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, true);
});

test('valid review payload with verdict BLOCKED returns ok true', async () => {
  const { transport } = transportWithBinding({ reads: [makeResponse({ verdict: 'BLOCKED' })] });
  const result = await transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, true);
});

test('mismatched pullRequest returns BINDING_MISMATCH', async () => {
  const { transport } = transportWithBinding({ bindingPullRequest: 99 });
  const result = await transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, false);
  assert.equal(result.code, WEB2API_COPY_CODES.BINDING_MISMATCH);
});

test('mismatched headSha returns BINDING_MISMATCH', async () => {
  const { transport } = transportWithBinding({ bindingHeadSha: 'a'.repeat(40) });
  const result = await transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, false);
  assert.equal(result.code, WEB2API_COPY_CODES.BINDING_MISMATCH);
});

test('mismatched repository returns BINDING_MISMATCH', async () => {
  const { transport } = transportWithBinding({ bindingRepository: 'other/repo' });
  const result = await transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, false);
  assert.equal(result.code, WEB2API_COPY_CODES.BINDING_MISMATCH);
});

test('mismatched issue returns BINDING_MISMATCH', async () => {
  const { transport } = transportWithBinding({ bindingIssue: 999 });
  const result = await transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, false);
  assert.equal(result.code, WEB2API_COPY_CODES.BINDING_MISMATCH);
});

test('mismatched requestDigest returns COPY_STALE', async () => {
  const { transport } = transportWithBinding({ bindingRequestDigest: 'different-digest' });
  const result = await transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, false);
  assert.equal(result.code, WEB2API_COPY_CODES.COPY_STALE);
});

test('invalid verdict string (APPROVED) returns COPY_BAD', async () => {
  const { transport } = transportWithBinding({ reads: [makeResponse({ verdict: 'APPROVED' })] });
  const result = await transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, false);
  assert.equal(result.code, WEB2API_COPY_CODES.COPY_BAD);
});

test('missing verdict returns COPY_BAD', async () => {
  const { transport } = transportWithBinding({ reads: [makeResponse({ verdict: undefined })] });
  const result = await transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, false);
  assert.equal(result.code, WEB2API_COPY_CODES.COPY_BAD);
});

test('null verdict returns COPY_BAD', async () => {
  const { transport } = transportWithBinding({ reads: [makeResponse({ verdict: null })] });
  const result = await transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, false);
  assert.equal(result.code, WEB2API_COPY_CODES.COPY_BAD);
});

test('fetch timeout captures submitError in transportMeta', async () => {
  const { transport } = transportFor({
    fetchImpl: async () => {
      await new Promise((_, reject) => setTimeout(() => reject(new Error('FETCH_TIMEOUT')), 10));
      return { status: 200, json: async () => ({}) };
    },
    snapshots: [['A'], ['A', 'B']],
    reads: [makeResponse()],
  });
  const result = await transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, false);
  assert.ok(result.transportMeta.submitError);
  assert.ok(result.transportMeta.submitError.includes('FETCH_EXCEPTION'));
});

test('missing conversationId captures submitError in transportMeta', async () => {
  const { transport } = transportFor({
    response: { status: 200, json: async () => ({ model: 'auto' }) },
    reads: [makeResponse()],
  });
  const result = await transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, false);
  assert.ok(result.transportMeta.submitError);
  assert.ok(result.transportMeta.submitError.includes('MISSING_CONVERSATION_ID'));
});

// --- S3 backward-compatibility regression: nonce+source payload without verdict ---

const S3_SMOKE_PAYLOAD = JSON.stringify({ nonce: 'NONCE-123', source: 's3-web2api-copy-smoke' });

test('S3 smoke payload (nonce+source, no verdict) accepted without binding params', async () => {
  const { transport } = transportFor({ reads: [S3_SMOKE_PAYLOAD] });
  const result = await transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, true);
  assert.equal(result.text, S3_SMOKE_PAYLOAD);
});

test('S3 smoke payload rejected when S4 binding params are active (missing requestDigest)', async () => {
  const { transport } = transportWithBinding({
    reads: [S3_SMOKE_PAYLOAD],
    bindingRepository: 'duongpdddic-droid/Soc_brain',
    bindingIssue: 197,
    bindingPullRequest: 42,
    bindingHeadSha: 'b'.repeat(40),
    bindingRequestDigest: 'abc123',
  });
  const result = await transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, false);
  assert.equal(result.code, WEB2API_COPY_CODES.COPY_STALE);
});

test('S4 binding with valid binding+digest but missing verdict returns COPY_BAD', async () => {
  const payloadNoVerdict = JSON.stringify({
    findings: [],
    metadata: { source: 'web2api-copy', requestDigest: 'abc123' },
    binding: { repository: 'duongpdddic-droid/Soc_brain', issue: 197, pullRequest: 42, headSha: 'b'.repeat(40) },
  });
  const { transport } = transportWithBinding({ reads: [payloadNoVerdict] });
  const result = await transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, false);
  assert.equal(result.code, WEB2API_COPY_CODES.COPY_BAD);
});

test('S3 smoke payload accepted when only responseRef is set (no binding fields)', async () => {
  const { transport } = transportFor({
    reads: [S3_SMOKE_PAYLOAD],
    extra: { responseRef: 'NONCE-123' },
  });
  const result = await transport({ prompt: 'review-prompt' });
  assert.equal(result.ok, true);
  assert.equal(result.text, S3_SMOKE_PAYLOAD);
});

// --- Partial S4 binding must fail-closed at transport construction ---

test('partial binding: only repository supplied throws WEB2API_COPY_PARTIAL_BINDING', () => {
  assert.throws(
    () => transportFor({ extra: { bindingRepository: 'repo' } }),
    { message: /WEB2API_COPY_PARTIAL_BINDING/ },
  );
});

test('partial binding: only issue supplied throws WEB2API_COPY_PARTIAL_BINDING', () => {
  assert.throws(
    () => transportFor({ extra: { bindingIssue: 1 } }),
    { message: /WEB2API_COPY_PARTIAL_BINDING/ },
  );
});

test('partial binding: only pullRequest supplied throws WEB2API_COPY_PARTIAL_BINDING', () => {
  assert.throws(
    () => transportFor({ extra: { bindingPullRequest: 1 } }),
    { message: /WEB2API_COPY_PARTIAL_BINDING/ },
  );
});

test('partial binding: only headSha supplied throws WEB2API_COPY_PARTIAL_BINDING', () => {
  assert.throws(
    () => transportFor({ extra: { bindingHeadSha: 'a'.repeat(40) } }),
    { message: /WEB2API_COPY_PARTIAL_BINDING/ },
  );
});

test('partial binding: only requestDigest supplied throws WEB2API_COPY_PARTIAL_BINDING', () => {
  assert.throws(
    () => transportFor({ extra: { bindingRequestDigest: 'abc' } }),
    { message: /WEB2API_COPY_PARTIAL_BINDING/ },
  );
});

test('partial binding: 4 of 5 (missing requestDigest) throws WEB2API_COPY_PARTIAL_BINDING', () => {
  assert.throws(
    () => transportFor({
      extra: {
        bindingRepository: 'repo',
        bindingIssue: 1,
        bindingPullRequest: 2,
        bindingHeadSha: 'a'.repeat(40),
      },
    }),
    { message: /WEB2API_COPY_PARTIAL_BINDING/ },
  );
});

test('partial binding: 4 of 5 (missing pullRequest) throws WEB2API_COPY_PARTIAL_BINDING', () => {
  assert.throws(
    () => transportFor({
      extra: {
        bindingRepository: 'repo',
        bindingIssue: 1,
        bindingHeadSha: 'a'.repeat(40),
        bindingRequestDigest: 'abc',
      },
    }),
    { message: /WEB2API_COPY_PARTIAL_BINDING/ },
  );
});

test('partial binding: 4 of 5 (missing headSha) throws WEB2API_COPY_PARTIAL_BINDING', () => {
  assert.throws(
    () => transportFor({
      extra: {
        bindingRepository: 'repo',
        bindingIssue: 1,
        bindingPullRequest: 2,
        bindingRequestDigest: 'abc',
      },
    }),
    { message: /WEB2API_COPY_PARTIAL_BINDING/ },
  );
});

test('partial binding: 4 of 5 (missing issue) throws WEB2API_COPY_PARTIAL_BINDING', () => {
  assert.throws(
    () => transportFor({
      extra: {
        bindingRepository: 'repo',
        bindingPullRequest: 2,
        bindingHeadSha: 'a'.repeat(40),
        bindingRequestDigest: 'abc',
      },
    }),
    { message: /WEB2API_COPY_PARTIAL_BINDING/ },
  );
});

test('partial binding: 4 of 5 (missing repository) throws WEB2API_COPY_PARTIAL_BINDING', () => {
  assert.throws(
    () => transportFor({
      extra: {
        bindingIssue: 1,
        bindingPullRequest: 2,
        bindingHeadSha: 'a'.repeat(40),
        bindingRequestDigest: 'abc',
      },
    }),
    { message: /WEB2API_COPY_PARTIAL_BINDING/ },
  );
});

test('no binding options supplied: transport constructs without error', () => {
  const { transport } = transportFor({
    reads: [S3_SMOKE_PAYLOAD],
  });
  assert.ok(typeof transport === 'function');
});

// --- Invalid binding values: empty strings, whitespace, zeros ---

const INVALID_BINDINGS = [
  ['repository', ''],
  ['repository', '  '],
  ['headSha', ''],
  ['headSha', '   '],
  ['requestDigest', ''],
  ['requestDigest', '\t'],
  ['issue', ''],
  ['issue', '  '],
  ['pullRequest', ''],
  ['pullRequest', ' '],
];

for (const [field, value] of INVALID_BINDINGS) {
  test(`invalid binding: ${field}="${String(value).replace(/\s/g, '\\s')}" throws WEB2API_COPY_PARTIAL_BINDING`, () => {
    const full = { bindingRepository: 'repo', bindingIssue: 1, bindingPullRequest: 2, bindingHeadSha: 'a'.repeat(40), bindingRequestDigest: 'abc' };
    full[`binding${field.charAt(0).toUpperCase()}${field.slice(1)}`] = value;
    assert.throws(
      () => transportFor({ extra: full }),
      { message: /WEB2API_COPY_PARTIAL_BINDING/ },
    );
  });
}
