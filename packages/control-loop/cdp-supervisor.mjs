// cdp-supervisor.mjs — CDP singleton & auto-recovery supervisor for web2api transports.
//
// NORTH STAR: this module ensures a Chrome DevTools Protocol endpoint is
// running and reachable, with exactly one target page available for CDP
// interaction. It reuses the healthcheck/recovery pattern from
// packages/client-mcp/supervisor.mjs — adapted for CDP's HTTP endpoints
// (/json/version, /json/list) instead of MCP's /mcp control surface.
//
// AUTHORITY BOUNDARY (hard):
//   owns    : Chrome process lifecycle (ensure/respawn), CDP health checks,
//             target page creation, auto-recovery wrapper.
//   never   : task FSM, session lifecycle, review verdicts, merge authorization,
//             goal submission, executor lifecycle.
//   guards  : single chrome process via /json/version healthcheck, bounded
//             retry with backoff, fail-closed on unrecoverable errors.

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

export const CDP_SUPERVISOR_SCHEMA_VERSION = '1';

export const DEFAULT_CDP_POLICY = Object.freeze({
  port: 9224,
  userDataDir: null,
  headless: false,
  startupTimeoutMs: 15000,
  healthTimeoutMs: 10000,
  maxRecoveryAttempts: 2,
  recoveryBackoffMs: 2000,
  httpTimeoutMs: 5000,
  pollIntervalMs: 500,
});

export const CDP_ERROR_CODES = Object.freeze({
  UNAVAILABLE: 'CDP_SUPERVISOR_UNAVAILABLE',
  SPAWN_FAILED: 'CDP_SUPERVISOR_SPAWN_FAILED',
  HEALTH_TIMEOUT: 'CDP_SUPERVISOR_HEALTH_TIMEOUT',
  TARGET_NOT_FOUND: 'CDP_SUPERVISOR_TARGET_NOT_FOUND',
  TARGET_CREATE_FAILED: 'CDP_SUPERVISOR_TARGET_CREATE_FAILED',
  RECOVERY_FAILED: 'CDP_SUPERVISOR_RECOVERY_FAILED',
  CDP_LOST: 'CDP_SUPERVISOR_CDP_LOST',
});

function httpGet(url, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); resolve({ ok: false, status: 0, text: 'HTTP_TIMEOUT' }); }, timeoutMs);
    fetchImpl(url, { signal: controller.signal })
      .then((res) => {
        clearTimeout(timer);
        if (!res.ok) return resolve({ ok: false, status: res.status, text: `HTTP ${res.status}` });
        return res.text().then((text) => {
          let body = null;
          try { body = JSON.parse(text); } catch { /* non-JSON */ }
          resolve({ ok: true, status: res.status, body });
        });
      })
      .catch((e) => {
        clearTimeout(timer);
        resolve({ ok: false, status: 0, text: String((e && e.message) || e) });
      });
  });
}

function httpPutJson(url, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); resolve({ ok: false, status: 0, text: 'HTTP_TIMEOUT' }); }, timeoutMs);
    fetchImpl(url, { method: 'PUT', signal: controller.signal })
      .then((res) => {
        clearTimeout(timer);
        if (!res.ok) return resolve({ ok: false, status: res.status, text: `HTTP ${res.status}` });
        return res.text().then((text) => {
          let body = null;
          try { body = JSON.parse(text); } catch { /* non-JSON */ }
          resolve({ ok: true, status: res.status, body });
        });
      })
      .catch((e) => {
        clearTimeout(timer);
        resolve({ ok: false, status: 0, text: String((e && e.message) || e) });
      });
  });
}

function findChromePath() {
  if (platform() !== 'win32') return 'google-chrome';
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  return 'chrome.exe';
}

function spawnChrome({ port, userDataDir, headless, chromePath, log }) {
  const args = [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (userDataDir) args.push(`--user-data-dir=${userDataDir}`);
  if (headless) args.push('--headless=new');

  const chrome = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  chrome.unref();
  log(`[cdp-supervisor] spawned chrome pid=${chrome.pid} port=${port}`);
  return chrome;
}

export function createCdpSupervisor({
  port = DEFAULT_CDP_POLICY.port,
  userDataDir = DEFAULT_CDP_POLICY.userDataDir,
  headless = DEFAULT_CDP_POLICY.headless,
  policy = {},
  fetchImpl = globalThis.fetch,
  runner = null,
  log = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  chromePath = null,
} = {}) {
  const pol = { ...DEFAULT_CDP_POLICY, port, userDataDir, headless, ...policy };
  const baseUrl = `http://127.0.0.1:${pol.port}`;
  const effectiveChromePath = chromePath || findChromePath();
  let spawnedProcess = null;

  function runnerHttpGet(route) {
    if (!runner) return null;
    try {
      const result = runner({ command: 'curl.exe', args: ['-s', '--max-time', '10', `${baseUrl}${route}`], timeoutMs: pol.httpTimeoutMs });
      if (result.status !== 0) return null;
      return JSON.parse(result.stdout || 'null');
    } catch { return null; }
  }

  async function checkHealth() {
    if (runner) {
      const version = runnerHttpGet('/json/version');
      if (!version || !version.webSocketDebuggerUrl) {
        return { ok: false, reason: version ? 'INVALID_RESPONSE' : 'UNREACHABLE', detail: version ? 'missing webSocketDebuggerUrl' : 'curl failed' };
      }
      return { ok: true, version };
    }
    const res = await httpGet(`${baseUrl}/json/version`, { fetchImpl, timeoutMs: pol.httpTimeoutMs });
    if (!res.ok) return { ok: false, reason: 'UNREACHABLE', detail: res.text };
    const version = res.body;
    if (!version || !version.webSocketDebuggerUrl) {
      return { ok: false, reason: 'INVALID_RESPONSE', detail: 'missing webSocketDebuggerUrl' };
    }
    return { ok: true, version };
  }

  async function listTargets() {
    if (runner) {
      const targets = runnerHttpGet('/json/list');
      if (targets === null) return { ok: false, reason: 'UNREACHABLE', detail: 'curl failed' };
      return { ok: true, targets: Array.isArray(targets) ? targets : [] };
    }
    const res = await httpGet(`${baseUrl}/json/list`, { fetchImpl, timeoutMs: pol.httpTimeoutMs });
    if (!res.ok) return { ok: false, reason: 'UNREACHABLE', detail: res.text };
    return { ok: true, targets: Array.isArray(res.body) ? res.body : [] };
  }

  async function ensureChromeRunning() {
    const health = await checkHealth();
    if (health.ok) {
      log(`[cdp-supervisor] chrome already running on port ${pol.port}`);
      return { ok: true, reused: true };
    }

    log(`[cdp-supervisor] chrome not running, spawning...`);
    try {
      spawnedProcess = spawnChrome({
        port: pol.port,
        userDataDir: pol.userDataDir,
        headless: pol.headless,
        chromePath: effectiveChromePath,
        log,
      });
    } catch (e) {
      return { ok: false, code: CDP_ERROR_CODES.SPAWN_FAILED, error: String((e && e.message) || e) };
    }

    const deadline = now() + pol.startupTimeoutMs;
    while (now() < deadline) {
      await sleep(pol.pollIntervalMs);
      const h = await checkHealth();
      if (h.ok) {
        log(`[cdp-supervisor] chrome started successfully pid=${spawnedProcess.pid}`);
        return { ok: true, reused: false, pid: spawnedProcess.pid };
      }
    }

    return { ok: false, code: CDP_ERROR_CODES.HEALTH_TIMEOUT, error: 'chrome did not become ready within timeout' };
  }

  async function ensureTargetPage({ urlPattern = null, defaultUrl = 'about:blank' } = {}) {
    const targets = await listTargets();
    if (!targets.ok) {
      return { ok: false, code: CDP_ERROR_CODES.UNAVAILABLE, error: targets.detail };
    }

    if (urlPattern) {
      const pattern = typeof urlPattern === 'string' ? new RegExp(urlPattern) : urlPattern;
      const match = targets.targets.find((t) => t && t.type === 'page' && pattern.test(t.url || ''));
      if (match) {
        log(`[cdp-supervisor] found existing target: ${match.url}`);
        return { ok: true, target: match, reused: true };
      }
    }

    log(`[cdp-supervisor] creating new target for ${defaultUrl}`);
    const createRes = await httpPutJson(
      `${baseUrl}/json/new?${encodeURIComponent(defaultUrl)}`,
      { fetchImpl, timeoutMs: pol.httpTimeoutMs },
    );
    if (!createRes.ok) {
      return { ok: false, code: CDP_ERROR_CODES.TARGET_CREATE_FAILED, error: createRes.text || `HTTP ${createRes.status}` };
    }
    const target = createRes.body;
    if (!target || !target.webSocketDebuggerUrl) {
      return { ok: false, code: CDP_ERROR_CODES.TARGET_CREATE_FAILED, error: 'no webSocketDebuggerUrl in response' };
    }
    log(`[cdp-supervisor] created target: ${target.url} id=${target.id}`);
    return { ok: true, target, reused: false };
  }

  async function waitForRecovery({ sleepMs = pol.recoveryBackoffMs } = {}) {
    await sleep(sleepMs);
    const deadline = now() + pol.startupTimeoutMs;
    while (now() < deadline) {
      const h = await checkHealth();
      if (h.ok) return { ok: true };
      await sleep(pol.pollIntervalMs);
    }
    return { ok: false, code: CDP_ERROR_CODES.HEALTH_TIMEOUT };
  }

  async function withAutoRecover(fn, { urlPattern = null, defaultUrl = 'about:blank', maxAttempts = pol.maxRecoveryAttempts } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const msg = String((e && e.message) || e);
        const isCdpError = /CDP_LOST|CDP_WS_ERROR|CDP_SEND_TIMEOUT|CDP_ERROR|WebSocket|ECONNREFUSED|ECONNRESET/i.test(msg);
        if (!isCdpError) throw e;

        lastError = e;
        log(`[cdp-supervisor] CDP error on attempt ${attempt + 1}: ${msg}`);

        if (attempt >= maxAttempts) break;

        log(`[cdp-supervisor] attempting recovery (attempt ${attempt + 1}/${maxAttempts})...`);
        const spawnResult = await ensureChromeRunning();
        if (!spawnResult.ok) {
          log(`[cdp-supervisor] recovery failed: chrome not running`);
          break;
        }
        const targetResult = await ensureTargetPage({ urlPattern, defaultUrl });
        if (!targetResult.ok) {
          log(`[cdp-supervisor] recovery failed: target not created`);
          break;
        }
        await sleep(pol.recoveryBackoffMs);
      }
    }

    throw new Error(`${CDP_ERROR_CODES.RECOVERY_FAILED}: ${lastError ? lastError.message : 'unknown'}`);
  }

  function cleanup() {
    if (spawnedProcess) {
      try { spawnedProcess.kill(); } catch { /* already dead */ }
      spawnedProcess = null;
    }
  }

  return {
    ensureChromeRunning,
    ensureTargetPage,
    withAutoRecover,
    checkHealth,
    listTargets,
    waitForRecovery,
    cleanup,
    baseUrl,
    policy: pol,
  };
}
