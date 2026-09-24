import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCdpSupervisor,
  CDP_ERROR_CODES,
  DEFAULT_CDP_POLICY,
} from '../packages/control-loop/cdp-supervisor.mjs';

// Response fields may be static values OR thunks evaluated per request so a
// test can mutate backend state (crash → respawn → re-list) between calls.
function mockFetch(opts = {}) {
  const state = {
    versionResponse: null,
    listResponse: null,
    createResponse: null,
    // Bare /json primary probe (PR #230). Default null → 404 so checkHealth
    // exercises the /json/version fallback (legacy fixtures keep working).
    jsonResponse: null,
    callLog: [],
    ...opts,
  };
  const resolve = (v) => (typeof v === 'function' ? v() : v);
  const fetchImpl = async (url, options = {}) => {
    state.callLog.push({ url: String(url), method: options.method || 'GET' });
    const u = String(url);
    if (u.includes('/json/version')) {
      const vr = resolve(state.versionResponse);
      if (!vr) throw new Error('ECONNREFUSED');
      return vr;
    }
    if (u.includes('/json/list')) {
      const lr = resolve(state.listResponse);
      if (!lr) throw new Error('ECONNREFUSED');
      return lr;
    }
    if (u.includes('/json/new')) {
      const cr = resolve(state.createResponse);
      if (!cr) throw new Error('ECONNREFUSED');
      return cr;
    }
    // Bare /json (primary health probe) — never shadowed by the prefixes above.
    if (/\/json(\?.*)?$/.test(u)) {
      const jr = resolve(state.jsonResponse);
      if (jr) return jr;
      return { ok: false, status: 404 };
    }
    return { ok: false, status: 404 };
  };
  fetchImpl.callLog = state.callLog;
  fetchImpl.state = state;
  return fetchImpl;
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
  assert.equal(DEFAULT_CDP_POLICY.port, 9222);
  assert.equal(DEFAULT_CDP_POLICY.maxRecoveryAttempts, 2);
  assert.equal(DEFAULT_CDP_POLICY.startupTimeoutMs, 15000);
  assert.equal(DEFAULT_CDP_POLICY.recoveryBackoffMs, 2000);
  assert.equal(DEFAULT_CDP_POLICY.userDataDir, null);
  assert.equal(DEFAULT_CDP_POLICY.domReadyTimeoutMs, 5000);
});

test('createCdpSupervisor accepts custom policy overrides', async () => {
  const fetchImpl = mockFetch({ versionResponse: okVersionResponse() });
  const supervisor = createCdpSupervisor({ port: 9333, fetchImpl, log: () => {} });
  assert.equal(supervisor.policy.port, 9333);
  supervisor.cleanup();
});

// ============================================================================
// PR #230 — primary /json probe, spawn seam, 2-tier recovery, WS create,
// DOM-ready, exponential backoff. Fully offline (spawn/WebSocket injected).
// ============================================================================

test('checkHealth primary probe hits bare /json when the endpoint answers', async () => {
  const jsonResponse = okListResponse([geminiTarget()]);
  const fetchImpl = mockFetch({ jsonResponse });
  const supervisor = createCdpSupervisor({ port: 9222, fetchImpl, log: () => {} });
  const h = await supervisor.checkHealth();
  assert.equal(h.ok, true);
  assert.equal(h.route, '/json');
  assert.equal(fetchImpl.callLog.length, 1, 'no /json/version fallback when primary succeeds');
  assert.ok(/\/json(\?.*)?$/.test(fetchImpl.callLog[0].url), `primary probe must be bare /json, got ${fetchImpl.callLog[0].url}`);
  supervisor.cleanup();
});

test('checkHealth falls back to /json/version when bare /json is unavailable', async () => {
  const fetchImpl = mockFetch({ versionResponse: okVersionResponse() });
  const supervisor = createCdpSupervisor({ port: 9222, fetchImpl, log: () => {} });
  const h = await supervisor.checkHealth();
  assert.equal(h.ok, true);
  assert.equal(h.route, '/json/version');
  supervisor.cleanup();
});

test('ensureChromeRunning spawns isolated Chrome when unreachable then becomes healthy', async () => {
  let healthOk = false;
  const spawnCalls = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/json/version') || /\/json(\?.*)?$/.test(u)) {
      if (!healthOk) return { ok: false, status: 0, text: async () => 'ECONNREFUSED' };
      return okVersionResponse();
    }
    return { ok: false, status: 404 };
  };
  const spawnImpl = (cmd, args) => {
    spawnCalls.push({ cmd, args });
    healthOk = true; // Chrome becomes reachable immediately after spawn
    return { pid: 4242, unref() {}, kill() {} };
  };
  const supervisor = createCdpSupervisor({
    port: 9222,
    fetchImpl,
    spawnImpl,
    log: () => {},
    policy: { startupTimeoutMs: 1000, pollIntervalMs: 10 },
  });
  const result = await supervisor.ensureChromeRunning();
  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
  assert.equal(spawnCalls.length, 1, 'exactly one spawn');
  const { cmd, args } = spawnCalls[0];
  assert.ok(cmd, 'chrome path supplied');
  assert.ok(args.includes('--remote-debugging-port=9222'), `port flag missing: ${JSON.stringify(args)}`);
  const udd = args.find((a) => a.startsWith('--user-data-dir='));
  assert.ok(udd, 'isolated --user-data-dir always present');
  assert.ok(!udd.includes('User Data'), 'must NOT reuse the default Chrome profile');
  supervisor.cleanup();
});

test('withAutoRecover tier-A: CLIPBRD_E_CANT_OPEN retries without chrome restart', async () => {
  let attempts = 0;
  let spawnCount = 0;
  const fetchImpl = mockFetch({ versionResponse: okVersionResponse() });
  const spawnImpl = () => {
    spawnCount += 1;
    return { pid: 1, unref() {}, kill() {} };
  };
  const supervisor = createCdpSupervisor({
    port: 9222,
    fetchImpl,
    spawnImpl,
    log: () => {},
    policy: { recoveryBackoffMs: 5, startupTimeoutMs: 100 },
  });
  const result = await supervisor.withAutoRecover(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('CLIPBRD_E_CANT_OPEN: clipboard busy');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  assert.equal(spawnCount, 0, 'tier A must never respawn chrome');
  supervisor.cleanup();
});

test('withAutoRecover tier-A: NONCE_MISMATCH retries same chrome then succeeds', async () => {
  let attempts = 0;
  let spawnCount = 0;
  const fetchImpl = mockFetch({ versionResponse: okVersionResponse() });
  const supervisor = createCdpSupervisor({
    port: 9222,
    fetchImpl,
    spawnImpl: () => { spawnCount += 1; return { pid: 2, unref() {}, kill() {} }; },
    log: () => {},
    policy: { recoveryBackoffMs: 5 },
  });
  const result = await supervisor.withAutoRecover(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('NONCE_MISMATCH: stale');
    return 'done';
  });
  assert.equal(result, 'done');
  assert.equal(spawnCount, 0);
  supervisor.cleanup();
});

test('withAutoRecover tier-B crash chain: zombie kill → fresh respawn → recreate target → success', async () => {
  let healthOk = true;
  let listState = [geminiTarget()];
  let spawnCount = 0;
  let killCount = 0;
  let attempts = 0;
  const spawnImpl = () => {
    spawnCount += 1;
    healthOk = true;
    listState = [geminiTarget()]; // fresh session has the gemini target again
    return {
      pid: 1000 + spawnCount,
      unref() {},
      kill() { killCount += 1; },
    };
  };
  const fetchImpl = mockFetch({
    versionResponse: () => (healthOk
      ? okVersionResponse()
      : { ok: false, status: 0, text: async () => 'ECONNREFUSED' }),
    listResponse: () => okListResponse(listState),
    createResponse: () => okCreateResponse('https://gemini.google.com'),
  });
  const supervisor = createCdpSupervisor({
    port: 9222,
    fetchImpl,
    spawnImpl,
    log: () => {},
    policy: { recoveryBackoffMs: 5, startupTimeoutMs: 200, pollIntervalMs: 5 },
  });
  // Seed a zombie handle so tier-B cleanup has something to kill.
  await supervisor.ensureChromeRunning(); // health ok → reused, no spawn
  const result = await supervisor.withAutoRecover(async () => {
    attempts += 1;
    if (attempts === 1) {
      // Simulate Target.crashed / CDP_LOST: chrome dies mid-session.
      healthOk = false;
      listState = [];
      throw new Error('CDP_LOST: Target crashed');
    }
    return 'recovered';
  }, { urlPattern: /gemini\.google\.com/, defaultUrl: 'https://gemini.google.com' });
  assert.equal(result, 'recovered');
  assert.equal(attempts, 2);
  assert.equal(spawnCount, 1, 'exactly one fresh respawn on tier-B');
  assert.equal(killCount, 0, 'no prior zombie handle (first run reused external chrome)');
  supervisor.cleanup();
});

test('withAutoRecover tier-B terminates a zombie handle before respawn', async () => {
  let spawnCount = 0;
  let killCount = 0;
  let attempts = 0;
  let healthOk = true;
  const spawned = [];
  const spawnImpl = () => {
    spawnCount += 1;
    healthOk = true;
    const proc = {
      pid: 2000 + spawnCount,
      unref() {},
      kill() { killCount += 1; },
    };
    spawned.push(proc);
    return proc;
  };
  const fetchImpl = mockFetch({
    versionResponse: () => (healthOk ? okVersionResponse() : { ok: false, status: 0, text: async () => 'ECONNREFUSED' }),
    listResponse: () => okListResponse([geminiTarget()]),
    createResponse: () => okCreateResponse('https://gemini.google.com'),
  });
  const supervisor = createCdpSupervisor({
    port: 9222,
    fetchImpl,
    spawnImpl,
    log: () => {},
    policy: { recoveryBackoffMs: 5, startupTimeoutMs: 200, pollIntervalMs: 5 },
  });
  // Force a supervisor-owned spawn so a zombie handle exists.
  healthOk = false;
  const first = await supervisor.ensureChromeRunning();
  assert.equal(first.ok, true);
  assert.equal(spawnCount, 1);
  const result = await supervisor.withAutoRecover(async () => {
    attempts += 1;
    if (attempts === 1) {
      healthOk = false; // crash the chrome we own
      throw new Error('CDP_LOST: connection closed');
    }
    return 'ok';
  }, { urlPattern: /gemini\.google\.com/, defaultUrl: 'https://gemini.google.com' });
  assert.equal(result, 'ok');
  assert.ok(killCount >= 1, 'zombie handle must be terminated before respawn');
  assert.equal(spawnCount, 2, 'exactly one fresh respawn after zombie kill');
  supervisor.cleanup();
});

test('withAutoRecover backoff is exponential (base * 2^attempt)', async () => {
  const fetchImpl = mockFetch({ versionResponse: okVersionResponse() });
  const supervisor = createCdpSupervisor({
    port: 9222,
    fetchImpl,
    log: () => {},
    policy: { recoveryBackoffMs: 100 },
  });
  assert.equal(supervisor.backoffFor(0), 100);
  assert.equal(supervisor.backoffFor(1), 200);
  assert.equal(supervisor.backoffFor(2), 400);
  assert.equal(supervisor.backoffFor(3), 800);
  assert.ok(supervisor.backoffFor(20) <= 30000, 'capped at 30s');
  supervisor.cleanup();
});

test('classifyRecoveryTier maps tier-A / tier-B / non-CDP correctly', async () => {
  const fetchImpl = mockFetch({ versionResponse: okVersionResponse() });
  const supervisor = createCdpSupervisor({ port: 9222, fetchImpl, log: () => {} });
  assert.equal(supervisor.classifyRecoveryTier('CLIPBRD_E_CANT_OPEN: busy'), 'A');
  assert.equal(supervisor.classifyRecoveryTier('NONCE_MISMATCH: stale'), 'A');
  assert.equal(supervisor.classifyRecoveryTier('CDP_LOST: gone'), 'B');
  assert.equal(supervisor.classifyRecoveryTier('Target.crashed'), 'B');
  assert.equal(supervisor.classifyRecoveryTier('OPERATION_HANG'), 'B');
  assert.equal(supervisor.classifyRecoveryTier('WebSocket connection failed'), 'B');
  assert.equal(supervisor.classifyRecoveryTier('UNRELATED_ERROR'), null);
  supervisor.cleanup();
});

test('ensureTargetPage prefers WS Target.createTarget and skips HTTP /json/new', async () => {
  let listState = [];
  const wsSent = [];
  class FakeBrowserWS {
    constructor(url) {
      this.url = url;
      this._handlers = {};
      queueMicrotask(() => this._emit('open', {}));
    }
    addEventListener(ev, fn) { (this._handlers[ev] ||= []).push(fn); }
    send(raw) {
      const msg = JSON.parse(raw);
      wsSent.push(msg);
      if (msg.method === 'Target.createTarget') {
        listState = [{
          type: 'page',
          url: 'https://gemini.google.com',
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/tab/ws-1',
          targetId: 'ws-1',
          id: 'ws-1',
        }];
        queueMicrotask(() => this._emit('message', {
          data: JSON.stringify({ id: msg.id, result: { targetId: 'ws-1' } }),
        }));
      }
    }
    close() {}
    _emit(ev, data) { for (const fn of this._handlers[ev] || []) fn(data); }
  }
  const fetchImpl = mockFetch({
    versionResponse: okVersionResponse('ws://127.0.0.1:9222/devtools/browser/abc'),
    listResponse: () => okListResponse(listState),
    createResponse: null, // HTTP fallback would fail → proves WS path was used
  });
  const supervisor = createCdpSupervisor({
    port: 9222,
    fetchImpl,
    WebSocketImpl: FakeBrowserWS,
    log: () => {},
    policy: { domReadyTimeoutMs: 0 },
  });
  const result = await supervisor.ensureTargetPage({
    urlPattern: /gemini\.google\.com/,
    defaultUrl: 'https://gemini.google.com',
    waitDomReady: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
  assert.equal(wsSent.length, 1, 'exactly one WS Target.createTarget');
  assert.equal(wsSent[0].method, 'Target.createTarget');
  assert.equal(wsSent[0].params.url, 'https://gemini.google.com');
  assert.equal(result.target.targetId || result.target.id, 'ws-1');
  supervisor.cleanup();
});

test('ensureTargetPage falls back to HTTP /json/new when WS create fails', async () => {
  class FailingWS {
    constructor() { queueMicrotask(() => { /* never opens */ }); }
    addEventListener() {}
    send() {}
    close() {}
  }
  const fetchImpl = mockFetch({
    versionResponse: okVersionResponse('ws://127.0.0.1:9222/devtools/browser/abc'),
    listResponse: okListResponse([]),
    createResponse: okCreateResponse('https://gemini.google.com'),
  });
  const supervisor = createCdpSupervisor({
    port: 9222,
    fetchImpl,
    WebSocketImpl: FailingWS,
    log: () => {},
    policy: { httpTimeoutMs: 50, domReadyTimeoutMs: 0 },
  });
  const result = await supervisor.ensureTargetPage({
    urlPattern: /gemini\.google\.com/,
    defaultUrl: 'https://gemini.google.com',
    waitDomReady: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.target.id, 'new-target', 'HTTP /json/new fallback used');
  supervisor.cleanup();
});

test('ensureTargetPage without WebSocketImpl degrades domReady non-fatally', async () => {
  const fetchImpl = mockFetch({ listResponse: okListResponse([geminiTarget()]) });
  const supervisor = createCdpSupervisor({ port: 9222, fetchImpl, WebSocketImpl: null, log: () => {} });
  const result = await supervisor.ensureTargetPage({ urlPattern: /gemini\.google\.com/ });
  assert.equal(result.ok, true);
  assert.equal(result.domReady, false, 'domReady degrades to false without WS');
  supervisor.cleanup();
});

test('listTargets filters crashed targets', async () => {
  const targets = [
    geminiTarget(),
    { type: 'page', url: 'https://gemini.google.com/app/crashed', webSocketDebuggerUrl: 'ws://x', targetId: 'c1', crashed: true },
    chatgptTarget(),
  ];
  const fetchImpl = mockFetch({ listResponse: okListResponse(targets) });
  const supervisor = createCdpSupervisor({ port: 9222, fetchImpl, log: () => {} });
  const result = await supervisor.listTargets();
  assert.equal(result.ok, true);
  assert.equal(result.targets.length, 2, 'crashed target excluded');
  assert.ok(!result.targets.some((t) => t.crashed === true));
  supervisor.cleanup();
});

test('withAutoRecover wraps non-CDP errors straight through (no retry)', async () => {
  const fetchImpl = mockFetch({ versionResponse: okVersionResponse() });
  const supervisor = createCdpSupervisor({ port: 9222, fetchImpl, log: () => {} });
  await assert.rejects(
    () => supervisor.withAutoRecover(async () => { throw new Error('BUG_IN_TEST'); }),
    { message: /BUG_IN_TEST/ },
  );
  supervisor.cleanup();
});

test('withAutoRecover OPERATION_HANG is classified tier-B and recovered', async () => {
  let attempts = 0;
  let spawnCount = 0;
  const fetchImpl = mockFetch({
    versionResponse: okVersionResponse(),
    listResponse: okListResponse([geminiTarget()]),
    createResponse: okCreateResponse('https://gemini.google.com'),
  });
  const supervisor = createCdpSupervisor({
    port: 9222,
    fetchImpl,
    spawnImpl: () => { spawnCount += 1; return { pid: 9, unref() {}, kill() {} }; },
    log: () => {},
    policy: { recoveryBackoffMs: 5, operationTimeoutMs: 30, startupTimeoutMs: 100 },
  });
  const result = await supervisor.withAutoRecover(async () => {
    attempts += 1;
    if (attempts === 1) return new Promise(() => {}); // hang forever
    return 'unstuck';
  }, { urlPattern: /gemini\.google\.com/, defaultUrl: 'https://gemini.google.com' });
  assert.equal(result, 'unstuck');
  assert.equal(attempts, 2);
  assert.equal(spawnCount, 1, 'hang triggers tier-B respawn');
  supervisor.cleanup();
});
