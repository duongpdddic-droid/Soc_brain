// cdp-supervisor.mjs — CDP singleton & auto-recovery supervisor for web2api transports.
//
// NORTH STAR: this module ensures a Chrome DevTools Protocol endpoint is
// running and reachable, with exactly one target page available for CDP
// interaction. It reuses the healthcheck/recovery pattern from
// packages/client-mcp/supervisor.mjs — adapted for CDP's HTTP endpoints
// (/json primary probe, /json/version fallback, /json/list) instead of MCP's
// /mcp control surface.
//
// AUTHORITY BOUNDARY (hard):
//   owns    : Chrome process lifecycle (ensure/respawn/zombie terminate),
//             CDP health checks, target page creation (WS Target.createTarget
//             primary + HTTP /json/new fallback), best-effort DOM-ready wait,
//             auto-recovery wrapper (2-tier: Tier A transport retry without
//             restart; Tier B full respawn + target recreate).
//   never   : task FSM, session lifecycle, review verdicts, merge authorization,
//             goal submission, executor lifecycle.
//   guards  : single chrome process via /json healthcheck, bounded retry with
//             exponential backoff, fail-closed on unrecoverable errors.
//
// OFFLINE-SAFE (PR #230): spawnImpl and WebSocketImpl are injectable seams so
// unit tests exercise spawn/crash/recover chains with zero real Chrome/network.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as defaultSpawn } from 'node:child_process';
import { platform } from 'node:os';

export const CDP_SUPERVISOR_SCHEMA_VERSION = '1';

export const DEFAULT_CDP_POLICY = Object.freeze({
  // Canonical CDP port for the Soc_brain Gemini/ChatGPT review transports
  // (aligned with GEMINI_WEB2API_DEFAULT_CDP_PORT and bin/soc-control-loop).
  port: 9222,
  // null → resolved to an isolated per-host profile under os.tmpdir()
  // (never the operator's default Chrome profile).
  userDataDir: null,
  headless: false,
  startupTimeoutMs: 15000,
  healthTimeoutMs: 10000,
  maxRecoveryAttempts: 2,
  recoveryBackoffMs: 2000,
  httpTimeoutMs: 5000,
  pollIntervalMs: 500,
  // Best-effort DOM-ready wait after target create/reuse (0 = skip).
  domReadyTimeoutMs: 5000,
});

export const CDP_ERROR_CODES = Object.freeze({
  UNAVAILABLE: 'CDP_SUPERVISOR_UNAVAILABLE',
  SPAWN_FAILED: 'CDP_SUPERVISOR_SPAWN_FAILED',
  HEALTH_TIMEOUT: 'CDP_SUPERVISOR_HEALTH_TIMEOUT',
  TARGET_NOT_FOUND: 'CDP_SUPERVISOR_TARGET_NOT_FOUND',
  TARGET_CREATE_FAILED: 'CDP_SUPERVISOR_TARGET_CREATE_FAILED',
  RECOVERY_FAILED: 'CDP_SUPERVISOR_RECOVERY_FAILED',
  CDP_LOST: 'CDP_SUPERVISOR_CDP_LOST',
  TARGET_CRASHED: 'CDP_SUPERVISOR_TARGET_CRASHED',
});

// Tier A — transient transport errors: retry the SAME Chrome (no restart).
const TIER_A_RE = /CLIPBRD_E_CANT_OPEN|NONCE_MISMATCH/i;
// Tier B — lost/crashed/hung CDP session: terminate zombie + fresh respawn
// + recreate target.
const TIER_B_RE = /CDP_LOST|CDP_WS_ERROR|CDP_SEND_TIMEOUT|CDP_ERROR|WebSocket|ECONNREFUSED|ECONNRESET|ETIMEDOUT|Target\.crashed|TARGET_CRASHED|OPERATION_HANG/i;

function classifyRecoveryTier(msg) {
  if (TIER_A_RE.test(msg)) return 'A';
  if (TIER_B_RE.test(msg)) return 'B';
  return null;
}

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

// Isolated profile: never reuse the operator's default Chrome profile.
function resolveProfileDir(userDataDir) {
  if (userDataDir) return userDataDir;
  return path.join(os.tmpdir(), 'soc-brain-cdp-profile');
}

function spawnChrome({ port, userDataDir, headless, chromePath, log, spawnImpl }) {
  const args = [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${resolveProfileDir(userDataDir)}`,
  ];
  if (headless) args.push('--headless=new');

  const chrome = spawnImpl(chromePath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  if (chrome && typeof chrome.unref === 'function') chrome.unref();
  log(`[cdp-supervisor] spawned chrome pid=${chrome && chrome.pid} port=${port}`);
  return chrome;
}

// Normalize a /json or /json/version probe body into a health verdict.
function normalizeProbeBody(body) {
  if (Array.isArray(body)) {
    // /json → array of targets. Endpoint responding proves Chrome is up.
    const first = body.find((t) => t && t.webSocketDebuggerUrl) || null;
    return {
      ok: true,
      version: { webSocketDebuggerUrl: first ? first.webSocketDebuggerUrl : null, targets: body },
      route: '/json',
    };
  }
  if (body && typeof body === 'object' && body.webSocketDebuggerUrl) {
    return { ok: true, version: body, route: '/json/version' };
  }
  return { ok: false, reason: 'INVALID_RESPONSE', detail: 'missing webSocketDebuggerUrl' };
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
  // Injectable seams (offline unit tests): real spawn/WebSocket by default.
  spawnImpl = defaultSpawn,
  WebSocketImpl = globalThis.WebSocket,
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

  // Primary probe: /json (task contract). Fallback: /json/version (legacy
  // Chrome builds + existing mock fixtures). Either route proving healthy
  // is sufficient.
  async function probeEndpoint(route) {
    if (runner) {
      const body = runnerHttpGet(route);
      if (body === null) return { ok: false, reason: 'UNREACHABLE', detail: 'curl failed', route };
      const n = normalizeProbeBody(body);
      return { ...n, route };
    }
    const res = await httpGet(`${baseUrl}${route}`, { fetchImpl, timeoutMs: pol.httpTimeoutMs });
    if (!res.ok) return { ok: false, reason: 'UNREACHABLE', detail: res.text, route };
    const n = normalizeProbeBody(res.body);
    return { ...n, route };
  }

  async function checkHealth() {
    const primary = await probeEndpoint('/json');
    if (primary.ok) return primary;
    const fallback = await probeEndpoint('/json/version');
    if (fallback.ok) return fallback;
    // Prefer the more specific INVALID_RESPONSE when either route answered
    // with a body that is missing webSocketDebuggerUrl.
    if (primary.reason === 'INVALID_RESPONSE') return primary;
    if (fallback.reason === 'INVALID_RESPONSE') return fallback;
    return primary;
  }

  async function listTargets() {
    if (runner) {
      const targets = runnerHttpGet('/json/list');
      if (targets === null) return { ok: false, reason: 'UNREACHABLE', detail: 'curl failed' };
      return { ok: true, targets: Array.isArray(targets) ? targets : [] };
    }
    const res = await httpGet(`${baseUrl}/json/list`, { fetchImpl, timeoutMs: pol.httpTimeoutMs });
    if (!res.ok) return { ok: false, reason: 'UNREACHABLE', detail: res.text };
    // Filter crashed targets (Chrome may still list a crashed page).
    const list = Array.isArray(res.body) ? res.body : [];
    return { ok: true, targets: list.filter((t) => t && t.crashed !== true) };
  }

  async function ensureChromeRunning({ force = false } = {}) {
    // force=true (tier-B after OPERATION_HANG / owned zombie): skip the reuse
    // short-circuit — a hung process can still answer /json but the session
    // is dead, so a fresh respawn is required.
    if (!force) {
      const health = await checkHealth();
      if (health.ok) {
        log(`[cdp-supervisor] chrome already running on port ${pol.port}`);
        return { ok: true, reused: true };
      }
    }

    log(`[cdp-supervisor] ${force ? 'force-respawning' : 'chrome not running, spawning...'}...`);
    // Terminate a prior zombie handle before respawning (Tier B path may
    // already have called cleanup; this is a second line of defence).
    terminateZombie();
    try {
      spawnedProcess = spawnChrome({
        port: pol.port,
        userDataDir: pol.userDataDir,
        headless: pol.headless,
        chromePath: effectiveChromePath,
        log,
        spawnImpl,
      });
    } catch (e) {
      return { ok: false, code: CDP_ERROR_CODES.SPAWN_FAILED, error: String((e && e.message) || e) };
    }

    const deadline = now() + pol.startupTimeoutMs;
    while (now() < deadline) {
      await sleep(pol.pollIntervalMs);
      const h = await checkHealth();
      if (h.ok) {
        log(`[cdp-supervisor] chrome started successfully pid=${spawnedProcess && spawnedProcess.pid}`);
        return { ok: true, reused: false, pid: spawnedProcess && spawnedProcess.pid };
      }
    }

    return { ok: false, code: CDP_ERROR_CODES.HEALTH_TIMEOUT, error: 'chrome did not become ready within timeout' };
  }

  // WS Target.createTarget (primary). Returns a target skeleton or null on
  // any failure — caller falls back to HTTP /json/new.
  // REENTRANCY (root cause of the stack overflow): ws.close() can fire the
  // 'close'/'error' listeners SYNCHRONOUSLY, which re-enter finish() before
  // the first resolve() returns. A settled latch makes finish() idempotent
  // and breaks the cycle — no recursive close→onClose→finish chain.
  async function createTargetViaWs(defaultUrl) {
    const health = await checkHealth();
    const browserWs = health && health.ok && health.version && health.version.webSocketDebuggerUrl;
    if (!browserWs || !WebSocketImpl) return null;
    return new Promise((resolve) => {
      let ws;
      try {
        ws = new WebSocketImpl(browserWs);
      } catch {
        resolve(null);
        return;
      }
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* ignore */ }
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), pol.httpTimeoutMs);
      const onOpen = () => {
        if (settled) return;
        try {
          ws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: defaultUrl } }));
        } catch {
          finish(null);
        }
      };
      const onMessage = (ev) => {
        if (settled) return;
        try {
          const raw = ev && typeof ev.data === 'string' ? ev.data : String((ev && ev.data) ?? '');
          const msg = JSON.parse(raw);
          if (msg.id !== 1) return;
          if (msg.error || !msg.result || !msg.result.targetId) {
            finish(null);
            return;
          }
          const targetId = msg.result.targetId;
          finish({
            targetId,
            id: targetId,
            url: defaultUrl,
            type: 'page',
            webSocketDebuggerUrl: null,
            viaWs: true,
          });
        } catch { /* partial frame — wait */ }
      };
      const onError = () => finish(null);
      const onClose = () => finish(null);
      if (typeof ws.addEventListener === 'function') {
        ws.addEventListener('open', onOpen);
        ws.addEventListener('message', onMessage);
        ws.addEventListener('error', onError);
        ws.addEventListener('close', onClose);
      } else if (typeof ws.on === 'function') {
        ws.on('open', onOpen);
        ws.on('message', onMessage);
        ws.on('error', onError);
        ws.on('close', onClose);
      } else {
        finish(null);
      }
    });
  }

  // Best-effort DOM-ready wait (non-fatal). Returns { ok:true, domReady }.
  // Bounded: absolute deadline (domReadyTimeoutMs) + per-attempt timer + sleep
  // tick between attempts — never a synchronous recursive poll.
  // Connection failure (error/close before a readyState answer) FAILS FAST
  // out of the loop: polling a dead endpoint until the deadline only burns
  // wall-clock. Same settled latch as createTargetViaWs — ws.close() firing
  // 'close' synchronously must not re-enter finish() (stack overflow fix).
  async function waitForDomReady(target) {
    if (!(pol.domReadyTimeoutMs > 0)) return { ok: true, domReady: false, skipped: true };
    if (!target || !target.webSocketDebuggerUrl || !WebSocketImpl) {
      return { ok: true, domReady: false, degraded: true };
    }
    const wsUrl = target.webSocketDebuggerUrl;
    const deadline = now() + pol.domReadyTimeoutMs;
    const attemptTimeoutMs = Math.min(1500, Math.max(250, pol.httpTimeoutMs));
    while (now() < deadline) {
      // outcome: {ready:true} | {ready:false} | {failed:true} (no connection)
      const outcome = await new Promise((resolve) => {
        let ws;
        try {
          ws = new WebSocketImpl(wsUrl);
        } catch {
          resolve({ failed: true });
          return;
        }
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch { /* ignore */ }
          resolve(value);
        };
        const timer = setTimeout(() => finish({ ready: false }), attemptTimeoutMs);
        const onOpen = () => {
          if (settled) return;
          try {
            ws.send(JSON.stringify({
              id: 1,
              method: 'Runtime.evaluate',
              params: { expression: 'document.readyState', returnByValue: true },
            }));
          } catch {
            finish({ failed: true });
          }
        };
        const onMessage = (ev) => {
          if (settled) return;
          try {
            const raw = ev && typeof ev.data === 'string' ? ev.data : String((ev && ev.data) ?? '');
            const msg = JSON.parse(raw);
            if (msg.id !== 1) return;
            const value = msg.result && msg.result.result && msg.result.result.value;
            finish({ ready: value === 'complete' || value === 'interactive' });
          } catch { /* partial */ }
        };
        // error/close BEFORE a readyState answer ⇒ endpoint unreachable.
        const onError = () => finish({ failed: true });
        const onClose = () => finish({ failed: true });
        if (typeof ws.addEventListener === 'function') {
          ws.addEventListener('open', onOpen);
          ws.addEventListener('message', onMessage);
          ws.addEventListener('error', onError);
          ws.addEventListener('close', onClose);
        } else if (typeof ws.on === 'function') {
          ws.on('open', onOpen);
          ws.on('message', onMessage);
          ws.on('error', onError);
          ws.on('close', onClose);
        } else {
          finish({ failed: true });
        }
      });
      if (outcome && outcome.ready) return { ok: true, domReady: true };
      if (outcome && outcome.failed) return { ok: true, domReady: false, degraded: true };
      // Connected but not ready yet — async tick before the next attempt.
      await sleep(Math.min(pol.pollIntervalMs, 500));
    }
    return { ok: true, domReady: false, degraded: true };
  }

  async function ensureTargetPage({ urlPattern = null, defaultUrl = 'about:blank', waitDomReady = true } = {}) {
    const targets = await listTargets();
    if (!targets.ok) {
      return { ok: false, code: CDP_ERROR_CODES.UNAVAILABLE, error: targets.detail };
    }

    let target = null;
    let reused = false;
    if (urlPattern) {
      const pattern = typeof urlPattern === 'string' ? new RegExp(urlPattern) : urlPattern;
      const match = targets.targets.find((t) => t && t.type === 'page' && pattern.test(t.url || ''));
      if (match) {
        log(`[cdp-supervisor] found existing target: ${match.url}`);
        target = match;
        reused = true;
      }
    }

    if (!target) {
      log(`[cdp-supervisor] creating new target for ${defaultUrl}`);
      // Primary: WS Target.createTarget via the browser endpoint.
      let created = await createTargetViaWs(defaultUrl);
      if (created && !created.webSocketDebuggerUrl) {
        // Re-list to resolve the full target record (wsDebuggerUrl etc.).
        const relist = await listTargets();
        if (relist.ok) {
          const fresh = relist.targets.find((t) => t && (t.targetId === created.targetId || t.id === created.targetId));
          if (fresh) created = fresh;
        }
      }
      if (!created) {
        // Fallback: legacy HTTP PUT /json/new.
        const createRes = await httpPutJson(
          `${baseUrl}/json/new?${encodeURIComponent(defaultUrl)}`,
          { fetchImpl, timeoutMs: pol.httpTimeoutMs },
        );
        if (!createRes.ok) {
          return { ok: false, code: CDP_ERROR_CODES.TARGET_CREATE_FAILED, error: createRes.text || `HTTP ${createRes.status}` };
        }
        created = createRes.body;
      }
      if (!created || (!created.webSocketDebuggerUrl && !created.targetId && !created.id)) {
        return { ok: false, code: CDP_ERROR_CODES.TARGET_CREATE_FAILED, error: 'no webSocketDebuggerUrl in response' };
      }
      target = created;
      log(`[cdp-supervisor] created target: ${target.url || defaultUrl} id=${target.targetId || target.id}`);
    }

    let dom = { ok: true, domReady: false, skipped: true };
    if (waitDomReady) {
      try {
        dom = await waitForDomReady(target);
      } catch {
        dom = { ok: true, domReady: false, degraded: true };
      }
    }
    return { ok: true, target, reused, domReady: dom.domReady === true, dom };
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

  // Exponential backoff: base * 2^attempt (capped to avoid runaway waits).
  function backoffFor(attempt) {
    const base = pol.recoveryBackoffMs;
    const delay = base * (2 ** attempt);
    return Math.min(delay, 30000);
  }

  // Optional hang guard: race fn against operationTimeoutMs (0 = disabled).
  async function withOperationTimeout(fn) {
    if (!(pol.operationTimeoutMs > 0)) return fn();
    let timer;
    try {
      return await Promise.race([
        fn(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('OPERATION_HANG')), pol.operationTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Terminate a zombie chrome handle we previously spawned (Tier B).
  function terminateZombie() {
    if (spawnedProcess) {
      try { spawnedProcess.kill('SIGKILL'); } catch { /* already dead */ }
      try { if (typeof spawnedProcess.kill === 'function') spawnedProcess.kill(); } catch { /* ignore */ }
      spawnedProcess = null;
    }
  }

  async function withAutoRecover(fn, { urlPattern = null, defaultUrl = 'about:blank', maxAttempts = pol.maxRecoveryAttempts } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      try {
        return await withOperationTimeout(fn);
      } catch (e) {
        const msg = String((e && e.message) || e);
        const tier = classifyRecoveryTier(msg);
        if (!tier) throw e;

        lastError = e;
        log(`[cdp-supervisor] CDP error on attempt ${attempt + 1} (tier ${tier}): ${msg}`);

        if (attempt >= maxAttempts) break;

        const delay = backoffFor(attempt);
        if (tier === 'A') {
          // Tier A: transient clipboard/nonce — retry same Chrome, no restart.
          log(`[cdp-supervisor] tier-A backoff ${delay}ms (no chrome restart)...`);
          await sleep(delay);
          continue;
        }

        // Tier B: lost/crashed/hung — zombie terminate + fresh respawn +
        // recreate target, then exponential backoff before the next attempt.
        log(`[cdp-supervisor] tier-B recovery attempt ${attempt + 1}/${maxAttempts}...`);
        terminateZombie();
        // A hung session (OPERATION_HANG) means HTTP /json may still answer
        // while the CDP session is dead — force a fresh respawn in that case.
        const force = /OPERATION_HANG/.test(msg);
        const spawnResult = await ensureChromeRunning({ force });
        if (!spawnResult.ok) {
          log(`[cdp-supervisor] recovery failed: chrome not running`);
          break;
        }
        const targetResult = await ensureTargetPage({ urlPattern, defaultUrl });
        if (!targetResult.ok) {
          log(`[cdp-supervisor] recovery failed: target not created`);
          break;
        }
        await sleep(delay);
      }
    }

    throw new Error(`${CDP_ERROR_CODES.RECOVERY_FAILED}: ${lastError ? lastError.message : 'unknown'}`);
  }

  function cleanup() {
    terminateZombie();
  }

  return {
    ensureChromeRunning,
    ensureTargetPage,
    withAutoRecover,
    checkHealth,
    listTargets,
    waitForRecovery,
    waitForDomReady,
    cleanup,
    baseUrl,
    policy: pol,
    // Exposed for tests / advanced callers (not part of the FSM authority).
    classifyRecoveryTier,
    backoffFor,
  };
}
