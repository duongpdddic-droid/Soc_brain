import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCdpSupervisor,
  CDP_ERROR_CODES,
  DEFAULT_CDP_POLICY,
} from '../packages/control-loop/cdp-supervisor.mjs';

function mockFetch({ versionResponse = null, listResponse = null, createResponse = null, callLog = [] } = {}) {
  return async (url, options = {}) => {
    callLog.push({ url, method: options.method || 'GET' });
    const u = String(url);
    if (u.includes('/json/version')) {
      if (!versionResponse) throw new Error('ECONNREFUSED');
      return versionResponse;
    }
    if (u.includes('/json/list')) {
      if (!listResponse) throw new Error('ECONNREFUSED');
      return listResponse;
    }
    if (u.includes('/json/new')) {
      if (!createResponse) throw new Error('ECONNREFUSED');
      return createResponse;
    }
    return { ok: false, status: 404 };
  };
}

function okVersionResponse(wsUrl = 'ws://127.0.0.1:9224/devtools/browser/abc') {
  return { ok: true, status: 200, text: async () => JSON.stringify({ webSocketDebuggerUrl: wsUrl }), json: async () => ({ webSocketDebuggerUrl: wsUrl }), body: { webSocketDebuggerUrl: wsUrl } };
}

function okListResponse(targets = []) {
  return { ok: true, status: 200, text: async () => JSON.stringify(targets), json: async () => targets, body: targets };
}

function okCreateResponse(url = 'https://gemini.google.com') {
  return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'new-target', url, webSocketDebuggerUrl: 'ws://127.0.0.1:9224/tab/new' }), json: async () => ({ id: 'new-target', url, webSocketDebuggerUrl: 'ws://127.0.0.1:9224/tab/new' }), body: { id: 'new-target', url, webSocketDebuggerUrl: 'ws://127.0.0.1:9224/tab/new' } };
}

function unreachableResponse() {
  return { ok: false, status: 0, text: async () => 'ECONNREFUSED' };
}

function geminiTarget(url = 'https://gemini.google.com/app/abc', id = 't1', ws = 'ws://127.0.0.1:9224/tab1') {
  return { type: 'page', url, webSocketDebuggerUrl: ws, targetId: id };
}

function chatgptTarget(url = 'https://chatgpt.com/c/conv-1', id = 't1', ws = 'ws://127.0.0.1:9224/tab1') {
  return { type: 'page', url, webSocketDebuggerUrl: ws, targetId: id };
}

// ---- ensureChromeRunning ----

test('ensureChromeRunning reuses existing Chrome', async () => {
  const fetchImpl = mockFetch({ versionResponse: okVersionResponse() });
  const supervisor = createCdpSupervisor({ port: 9224, fetchImpl, log: () => {} });
  const result = await supervisor.ensureChromeRunning();
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  supervisor.cleanup();
});

test('ensureChromeRunning returns error when Chrome not reachable', async () => {
  const fetchImpl = mockFetch({ versionResponse: unreachableResponse() });
  const supervisor = createCdpSupervisor({ port: 9224, fetchImpl, log: () => {}, policy: { startupTimeoutMs: 100, pollIntervalMs: 10 } });
  const result = await supervisor.ensureChromeRunning();
  assert.equal(result.ok, false);
  assert.equal(result.code, CDP_ERROR_CODES.HEALTH_TIMEOUT);
  supervisor.cleanup();
});

test('ensureChromeRunning returns error when version response missing webSocketDebuggerUrl', async () => {
  const fetchImpl = mockFetch({ versionResponse: { ok: true, status: 200, text: async () => '{}', json: async () => ({}), body: {} } });
  const supervisor = createCdpSupervisor({ port: 9224, fetchImpl, log: () => {}, policy: { startupTimeoutMs: 100, pollIntervalMs: 10 } });
  const result = await supervisor.ensureChromeRunning();
  assert.equal(result.ok, false);
  supervisor.cleanup();
});

// ---- ensureTargetPage ----

test('ensureTargetPage reuses existing matching target', async () => {
  const targets = [geminiTarget()];
  const fetchImpl = mockFetch({ listResponse: okListResponse(targets) });
  const supervisor = createCdpSupervisor({ port: 9224, fetchImpl, log: () => {} });
  const result = await supervisor.ensureTargetPage({ urlPattern: /gemini\.google\.com/ });
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(result.target.targetId, 't1');
  supervisor.cleanup();
});

test('ensureTargetPage creates new target when no match', async () => {
  const fetchImpl = mockFetch({
    listResponse: okListResponse([]),
    createResponse: okCreateResponse('https://gemini.google.com'),
  });
  const supervisor = createCdpSupervisor({ port: 9224, fetchImpl, log: () => {} });
  const result = await supervisor.ensureTargetPage({ urlPattern: /gemini\.google\.com/, defaultUrl: 'https://gemini.google.com' });
  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
  assert.equal(result.target.id, 'new-target');
  supervisor.cleanup();
});

test('ensureTargetPage returns error when list fails', async () => {
  const fetchImpl = mockFetch({ listResponse: unreachableResponse() });
  const supervisor = createCdpSupervisor({ port: 9224, fetchImpl, log: () => {} });
  const result = await supervisor.ensureTargetPage();
  assert.equal(result.ok, false);
  assert.equal(result.code, CDP_ERROR_CODES.UNAVAILABLE);
  supervisor.cleanup();
});

test('ensureTargetPage returns error when create fails', async () => {
  const fetchImpl = mockFetch({
    listResponse: okListResponse([]),
    createResponse: { ok: false, status: 500, text: async () => 'HTTP 500' },
  });
  const supervisor = createCdpSupervisor({ port: 9224, fetchImpl, log: () => {} });
  const result = await supervisor.ensureTargetPage({ urlPattern: /gemini\.google\.com/, defaultUrl: 'https://gemini.google.com' });
  assert.equal(result.ok, false);
  assert.equal(result.code, CDP_ERROR_CODES.TARGET_CREATE_FAILED);
  supervisor.cleanup();
});

test('ensureTargetPage creates target without pattern (no match required)', async () => {
  const fetchImpl = mockFetch({
    listResponse: okListResponse([]),
    createResponse: okCreateResponse('about:blank'),
  });
  const supervisor = createCdpSupervisor({ port: 9224, fetchImpl, log: () => {} });
  const result = await supervisor.ensureTargetPage({ defaultUrl: 'about:blank' });
  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
  supervisor.cleanup();
});

// ---- withAutoRecover ----

test('withAutoRecover passes through on success', async () => {
  const fetchImpl = mockFetch({ versionResponse: okVersionResponse() });
  const supervisor = createCdpSupervisor({ port: 9224, fetchImpl, log: () => {} });
  const result = await supervisor.withAutoRecover(async () => 'success');
  assert.equal(result, 'success');
  supervisor.cleanup();
});

test('withAutoRecover retries on CDP_LOST error and recovers', async () => {
  let attempts = 0;
  const fetchImpl = mockFetch({
    versionResponse: okVersionResponse(),
    listResponse: okListResponse([geminiTarget()]),
    createResponse: okCreateResponse('https://gemini.google.com'),
  });
  const supervisor = createCdpSupervisor({ port: 9224, fetchImpl, log: () => {}, policy: { recoveryBackoffMs: 10, startupTimeoutMs: 100 } });
  const result = await supervisor.withAutoRecover(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('CDP_LOST: connection closed');
    return 'recovered';
  }, { urlPattern: /gemini\.google\.com/, defaultUrl: 'https://gemini.google.com' });
  assert.equal(result, 'recovered');
  assert.equal(attempts, 2);
  supervisor.cleanup();
});

test('withAutoRecover retries on WebSocket error and recovers', async () => {
  let attempts = 0;
  const fetchImpl = mockFetch({
    versionResponse: okVersionResponse(),
    listResponse: okListResponse([chatgptTarget()]),
    createResponse: okCreateResponse('https://chatgpt.com'),
  });
  const supervisor = createCdpSupervisor({ port: 9224, fetchImpl, log: () => {}, policy: { recoveryBackoffMs: 10, startupTimeoutMs: 100 } });
  const result = await supervisor.withAutoRecover(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('WebSocket connection failed');
    return 'ok';
  }, { urlPattern: /chatgpt\.com/, defaultUrl: 'https://chatgpt.com' });
  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  supervisor.cleanup();
});

test('withAutoRecover does not retry non-CDP errors', async () => {
  const fetchImpl = mockFetch({ versionResponse: okVersionResponse() });
  const supervisor = createCdpSupervisor({ port: 9224, fetchImpl, log: () => {} });
  await assert.rejects(
    () => supervisor.withAutoRecover(async () => { throw new Error('UNRELATED_ERROR'); }),
    { message: /UNRELATED_ERROR/ },
  );
  supervisor.cleanup();
});

test('withAutoRecover throws RECOVERY_FAILED after max attempts', async () => {
  const fetchImpl = mockFetch({
    versionResponse: okVersionResponse(),
    listResponse: okListResponse([geminiTarget()]),
    createResponse: okCreateResponse('https://gemini.google.com'),
  });
  const supervisor = createCdpSupervisor({ port: 9224, fetchImpl, log: () => {}, policy: { maxRecoveryAttempts: 1, recoveryBackoffMs: 10, startupTimeoutMs: 100 } });
  await assert.rejects(
    () => supervisor.withAutoRecover(async () => { throw new Error('CDP_LOST'); }, { urlPattern: /gemini\.google\.com/, defaultUrl: 'https://gemini.google.com' }),
    { message: /CDP_SUPERVISOR_RECOVERY_FAILED/ },
  );
  supervisor.cleanup();
});

test('withAutoRecover recovers after multiple failures then success', async () => {
  let attempts = 0;
  const fetchImpl = mockFetch({
    versionResponse: okVersionResponse(),
    listResponse: okListResponse([geminiTarget()]),
    createResponse: okCreateResponse('https://gemini.google.com'),
  });
  const supervisor = createCdpSupervisor({ port: 9224, fetchImpl, log: () => {}, policy: { maxRecoveryAttempts: 3, recoveryBackoffMs: 10, startupTimeoutMs: 100 } });
  const result = await supervisor.withAutoRecover(async () => {
    attempts += 1;
    if (attempts <= 2) throw new Error('CDP_WS_ERROR');
    return 'finally';
  }, { urlPattern: /gemini\.google\.com/, defaultUrl: 'https://gemini.google.com' });
  assert.equal(result, 'finally');
  assert.equal(attempts, 3);
  supervisor.cleanup();
});

// ---- checkHealth ----

test('checkHealth returns ok for valid version response', async () => {
  const fetchImpl = mockFetch({ versionResponse: okVersionResponse() });
  const supervisor = createCdpSupervisor({ port: 9224, fetchImpl, log: () => {} });
  const result = await supervisor.checkHealth();
  assert.equal(result.ok, true);
  assert.ok(result.version);
  supervisor.cleanup();
});

test('checkHealth returns error for unreachable', async () => {
  const fetchImpl = mockFetch({ versionResponse: unreachableResponse() });
  const supervisor = createCdpSupervisor({ port: 9224, fetchImpl, log: () => {} });
  const result = await supervisor.checkHealth();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'UNREACHABLE');
  supervisor.cleanup();
});

// ---- listTargets ----

test('listTargets returns targets array', async () => {
  const targets = [
    geminiTarget('https://gemini.google.com/app/abc', 't1', 'ws://127.0.0.1:9224/tab1'),
    chatgptTarget('https://chatgpt.com/c/conv-1', 't2', 'ws://127.0.0.1:9224/tab2'),
  ];
  const fetchImpl = mockFetch({ listResponse: okListResponse(targets) });
  const supervisor = createCdpSupervisor({ port: 9224, fetchImpl, log: () => {} });
  const result = await supervisor.listTargets();
  assert.equal(result.ok, true);
  assert.equal(result.targets.length, 2);
  supervisor.cleanup();
});

test('listTargets returns empty array for empty list', async () => {
  const fetchImpl = mockFetch({ listResponse: okListResponse([]) });
  const supervisor = createCdpSupervisor({ port: 9224, fetchImpl, log: () => {} });
  const result = await supervisor.listTargets();
  assert.equal(result.ok, true);
  assert.equal(result.targets.length, 0);
  supervisor.cleanup();
});

// ---- cleanup ----

test('cleanup does not throw', async () => {
  const fetchImpl = mockFetch({ versionResponse: okVersionResponse() });
  const supervisor = createCdpSupervisor({ port: 9224, fetchImpl, log: () => {} });
  supervisor.cleanup();
  supervisor.cleanup(); // double cleanup safe
});

// ---- policy defaults ----

test('default policy has correct values', () => {
  assert.equal(DEFAULT_CDP_POLICY.port, 9224);
  assert.equal(DEFAULT_CDP_POLICY.maxRecoveryAttempts, 2);
  assert.equal(DEFAULT_CDP_POLICY.startupTimeoutMs, 15000);
  assert.equal(DEFAULT_CDP_POLICY.recoveryBackoffMs, 2000);
});

test('createCdpSupervisor accepts custom policy overrides', async () => {
  const fetchImpl = mockFetch({ versionResponse: okVersionResponse() });
  const supervisor = createCdpSupervisor({ port: 9333, fetchImpl, log: () => {} });
  assert.equal(supervisor.policy.port, 9333);
  supervisor.cleanup();
});
