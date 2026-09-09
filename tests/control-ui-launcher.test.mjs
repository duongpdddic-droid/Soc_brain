#!/usr/bin/env node
// control-ui-launcher.test.mjs — tests for packages/control-ui/launcher.mjs.
// No framework. Exit 0 = PASS, 1 = FAIL. Fully injected: NO real server spawn,
// NO real browser, NO real repo. Deterministic, fast, offline.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  probeControlUi, runLauncher, resolveControlCwd, defaultSpawnServer,
} from '../packages/control-ui/launcher.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

// ---- helper: one-shot http server on an ephemeral loopback port ---------------
async function withServer(handler, fn) {
  const srv = http.createServer(handler);
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  try { await fn(port); } finally { await new Promise((res) => srv.close(res)); }
}

// ---- probeControlUi: shape-aware singleton check -------------------------------
{
  const up = await probeControlUi({ port: 9 }); // nothing listens on 9
  falsy('probe: dead port => false', up);

  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, schemaVersion: '1', task: null, execution: null }));
  }, async (port) => {
    tru('probe: control-ui shape => true', await probeControlUi({ port }));
  });

  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>not a control ui</html>');
  }, async (port) => {
    falsy('probe: foreign 200 server => false (shape check)', await probeControlUi({ port }));
  });

  await withServer((req, res) => {
    res.writeHead(503);
    res.end('{}');
  }, async (port) => {
    falsy('probe: 503 => false', await probeControlUi({ port }));
  });
}

// ---- runLauncher: singleton — never spawns when an instance is alive ------------
{
  const spawned = [];
  const opened = [];
  const r = await runLauncher({
    repo: 'o/r', port: 3117,
    probe: async () => true,
    spawnServer: (a) => { spawned.push(a); return { pid: 1 }; },
    openBrowser: (u) => opened.push(u),
  });
  tru('singleton: ok', r.ok);
  tru('singleton: alreadyRunning', r.alreadyRunning === true);
  eq('singleton: spawn NOT called', spawned.length, 0);
  eq('singleton: browser opened once with url', opened.join(','), 'http://127.0.0.1:3117/');
}

// ---- runLauncher: spawn path — polls until probe succeeds ------------------------
{
  const spawned = [];
  const opened = [];
  let probes = 0;
  const r = await runLauncher({
    repo: 'o/r', port: 3117, pollMs: 10,
    probe: async () => (++probes >= 3), // not ready, not ready, ready
    spawnServer: (a) => { spawned.push(a); return { pid: 4242, exitCode: null }; },
    openBrowser: (u) => opened.push(u),
  });
  tru('spawn: ok', r.ok);
  falsy('spawn: fresh instance (not alreadyRunning)', r.alreadyRunning);
  eq('spawn: pid surfaced', r.spawnedPid, 4242);
  eq('spawn: exactly one spawn with resolved args', JSON.stringify(spawned), JSON.stringify([{ repo: 'o/r', port: 3117 }]));
  eq('spawn: browser opened once', opened.length, 1);
  tru('spawn: polled more than once', probes >= 3);
}

// ---- runLauncher: --no-open equivalent (openBrowser null) still succeeds ---------
{
  const r = await runLauncher({
    repo: 'o/r', port: 3117, pollMs: 10,
    probe: async () => true,
    spawnServer: () => ({ pid: 1 }),
    openBrowser: null,
  });
  tru('no-open: ok without browser action', r.ok && r.alreadyRunning === true);
}

// ---- runLauncher: server dies before ready => observable failure ------------------
{
  const r = await runLauncher({
    repo: 'o/r', port: 3117, pollMs: 10,
    probe: async () => false,
    spawnServer: () => ({ pid: 7, exitCode: 1 }), // crashed instantly
    openBrowser: null,
  });
  falsy('dead-server: not ok', r.ok);
  eq('dead-server: reason', r.reason, 'SERVER_NOT_READY');
  tru('dead-server: detail observable', typeof r.detail === 'string' && r.detail.length > 0);
}

// ---- runLauncher: server never becomes ready within waitMs => timeout failure -----
{
  const t0 = Date.now();
  const r = await runLauncher({
    repo: 'o/r', port: 3117, waitMs: 120, pollMs: 30,
    probe: async () => false,
    spawnServer: () => ({ pid: 8, exitCode: null }), // hangs without listening
    openBrowser: null,
  });
  falsy('timeout: not ok', r.ok);
  eq('timeout: reason', r.reason, 'SERVER_NOT_READY');
  tru('timeout: bounded wait respected', Date.now() - t0 >= 100);
}

// ---- runLauncher: spawn throws => observable failure, no polling -------------------
{
  let probes = 0;
  const r = await runLauncher({
    repo: 'o/r', port: 3117,
    probe: async () => { probes++; return false; },
    spawnServer: () => { throw new Error('boom'); },
    openBrowser: null,
  });
  falsy('spawn-fail: not ok', r.ok);
  eq('spawn-fail: reason', r.reason, 'SPAWN_FAILED');
  tru('spawn-fail: detail carries error', String(r.detail).includes('boom'));
  eq('spawn-fail: no pointless polling', probes, 1); // singleton scan only; claim loop exits on throw
}

// ---- UI v2 runtime guard (Issue #132 hard guard) -----------------------------------
{
  const { validateV2Runtime } = await import('../packages/control-ui/launcher.mjs');
  const V2_SRC = "if (u.pathname === '/api/tasks') {}\n// ---- Soc_brain UI v2 (Issue #130) ----\n";
  const ok = validateV2Runtime({ cliPath: 'C:/x/control-ui.mjs', exists: () => true, read: () => V2_SRC });
  tru('guard: valid v2 runtime passes', ok.ok);
  const missing = validateV2Runtime({ cliPath: 'C:/x/control-ui.mjs', exists: () => false, read: () => '' });
  eq('guard: missing file => UI_V2_RUNTIME_NOT_VALID', `${missing.ok}:${missing.reason}`, 'false:UI_V2_RUNTIME_NOT_VALID');
  const v1 = validateV2Runtime({ cliPath: 'C:/x/control-ui.mjs', exists: () => true, read: () => "legacy server, no tasks route, DEMO DATA present" });
  eq('guard: v1-shaped source rejected', v1.ok, false);
  const noMarker = validateV2Runtime({ cliPath: 'C:/x/control-ui.mjs', exists: () => true, read: () => "if (u.pathname === '/api/tasks') {}" });
  eq('guard: /api/tasks but no UI v2 marker rejected', noMarker.ok, false);
  const demo = validateV2Runtime({ cliPath: 'C:/x/control-ui.mjs', exists: () => true, read: () => "if (u.pathname === '/api/tasks') {}\n// UI v2\nvar DEMO DATA = 1" });
  eq('guard: demo data rejected', demo.ok, false);
}

// ---- runLauncher: UI v2 runtime guard gates spawning --------------------------------
{
  const spawned = [];
  const r = await runLauncher({
    repo: 'o/r', port: 3117, waitMs: 100, pollMs: 25,
    probe: async () => false,
    spawnServer: ({ port }) => { spawned.push(port); return { pid: 21, exitCode: null }; },
    runtimeGuard: async () => ({ ok: false, reason: 'UI_V2_RUNTIME_NOT_VALID', detail: 'missing UI v2 marker' }),
    openBrowser: null,
  });
  falsy('guard: runLauncher refuses to spawn invalid runtime', r.ok);
  eq('guard: reason surfaced', r.reason, 'UI_V2_RUNTIME_NOT_VALID');
  eq('guard: nothing spawned', spawned.length, 0);
}
{
  const spawned = [];
  const r = await runLauncher({
    repo: 'o/r', port: 3117, waitMs: 100, pollMs: 25,
    probe: async () => false,
    spawnServer: ({ port }) => { spawned.push(port); return { pid: 22, exitCode: null }; },
    runtimeGuard: async () => ({ ok: true }),
    openBrowser: null,
  });
  eq('guard: valid runtime spawns normally', spawned.length, 1);
}

// ---- probe: stale UI v1 instance (answers /api/state only) is NEVER reused ----------
{
  const { probeControlUi } = await import('../packages/control-ui/launcher.mjs');
  let calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/api/tasks')) { const e = new Error('404'); e.status = 404; throw e; } // v1: no route
    return { ok: true, json: async () => ({ ok: true, schemaVersion: '1' }) };
  };
  const reused = await probeControlUi({ host: '127.0.0.1', port: 3117, fetchImpl });
  eq('probe: stale v1 (/api/state ok, /api/tasks 404) => not reusable', reused, false);
  const v2fetch = async (url) => ({ ok: true, json: async () => ({ ok: true, schemaVersion: '1' }) });
  const reusedV2 = await probeControlUi({ host: '127.0.0.1', port: 3117, fetchImpl: v2fetch });
  eq('probe: live v2 (/api/tasks ok) => reusable', reusedV2, true);
}

// ---- runLauncher: port-busy fallback chain (Issue #132) -----------------------------
{
  const spawned = [];
  const opened = [];
  const r = await runLauncher({
    repo: 'o/r', port: 3117, ports: [3118, 3119, 3120], waitMs: 400, pollMs: 25,
    probe: async ({ port }) => port === 3117, // live Control UI already on primary
    spawnServer: ({ port }) => { spawned.push(port); return { pid: 11, exitCode: null }; },
    openBrowser: (u) => opened.push(u),
  });
  tru('fallback: live UI on primary => singleton, url = primary', r.ok && r.alreadyRunning === true && r.url === 'http://127.0.0.1:3117/');
  eq('fallback: no spawn when primary live', spawned.length, 0);
  eq('fallback: browser opened once on primary', opened.join(','), 'http://127.0.0.1:3117/');
}
{
  const spawned = [];
  const opened = [];
  const listening = new Set();
  const r = await runLauncher({
    repo: 'o/r', port: 3117, ports: [3118, 3119, 3120], waitMs: 800, pollMs: 25,
    probe: async ({ port }) => listening.has(port),
    spawnServer: ({ port }) => {
      spawned.push(port);
      if (port === 3117) return { pid: 90, exitCode: 1 }; // busy/foreign: bind crash, never listens
      listening.add(port); // 3118 claims fine
      return { pid: 13, exitCode: null };
    },
    openBrowser: (u) => opened.push(u),
  });
  tru('fallback: busy primary => spawns on first free port 3118', r.ok && r.alreadyRunning === false && r.url === 'http://127.0.0.1:3118/');
  eq('fallback: tried 3117 then 3118, exactly once each', spawned.join(','), '3117,3118');
  eq('fallback: browser opened once on 3118', opened.join(','), 'http://127.0.0.1:3118/');
}
{
  const spawned = [];
  const r = await runLauncher({
    repo: 'o/r', port: 3117, ports: [3118], waitMs: 200, pollMs: 25,
    probe: async () => false, // nothing ever listens
    spawnServer: ({ port }) => { spawned.push(port); return { pid: 14, exitCode: null }; },
    openBrowser: null,
  });
  falsy('fallback: timeout is observable', r.ok);
  eq('fallback: SERVER_NOT_READY names the primary port', String(r.detail).includes('3117'), true);
  eq('fallback: overall deadline stops the chain (one spawn)', spawned.length, 1);
}

// ---- resolveControlCwd: canonical repo root + fail-closed guard (Issue #57) ------
{
  // The test file lives in <repo>/tests -> launcher dir = <repo>/packages/control-ui.
  const root = resolveControlCwd({
    launcherDir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'control-ui'),
  });
  tru('cwd: resolves to the repo checkout root', typeof root === 'string' && fs.existsSync(path.join(root, '.git')));

  // Fail-closed: no .git next to the launcher -> throw with observable reason.
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-cwd-'));
  try {
    fs.mkdirSync(path.join(fake, 'packages', 'control-ui'), { recursive: true });
    let err = null;
    try {
      resolveControlCwd({ launcherDir: path.join(fake, 'packages', 'control-ui'), exists: () => false });
    } catch (e) { err = e; }
    tru('cwd: missing .git => CONTROL_CWD_INVALID throw', err !== null && String(err.message).includes('CONTROL_CWD_INVALID'));

    // exists=false at the checkout root even with real dirs present.
    let err2 = null;
    try {
      resolveControlCwd({ launcherDir: path.join(fake, 'packages', 'control-ui'), exists: (p) => !String(p).endsWith('.git') });
    } catch (e) { err2 = e; }
    tru('cwd: .git-only check fails closed', err2 !== null && String(err2.message).includes('CONTROL_CWD_INVALID'));
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
  }
}

// ---- defaultSpawnServer: pins server cwd to the canonical repo root (#57) --------
{
  const calls = [];
  const child = defaultSpawnServer({
    repo: 'o/r', port: 3117,
    spawnImpl: (exe, argv, opts) => { calls.push({ exe, argv, opts }); return { pid: 99, unref() {} }; },
  });
  eq('spawn-server: exactly one spawn', calls.length, 1);
  tru('spawn-server: child returned', child && child.pid === 99);
  tru('spawn-server: node executable', String(calls[0].exe).endsWith('node.exe') || String(calls[0].exe).endsWith('node'));
  tru('spawn-server: control-ui.mjs argv', String(calls[0].argv[0]).endsWith('control-ui.mjs'));
  eq('spawn-server: repo arg', calls[0].argv[2], 'o/r');
  eq('spawn-server: port arg', calls[0].argv[4], '3117');
  // THE BUG (#57): server cwd must be the pinned repo root (resolvable origin/main),
  // never the inherited double-click cwd.
  eq('spawn-server: cwd pinned to repo root', calls[0].opts.cwd, resolveControlCwd({}));
  tru('spawn-server: detached', calls[0].opts.detached === true);

  // Fail-closed propagation: invalid checkout root -> SPAWN_FAILED result, no spawn.
  const r = await runLauncher({
    repo: 'o/r', port: 3117,
    probe: async () => false,
    spawnServer: () => defaultSpawnServer({
      repo: 'o/r', port: 3117,
      spawnImpl: () => { throw new Error('must not be called'); },
      exists: () => false, // no .git anywhere -> CONTROL_CWD_INVALID -> SPAWN_FAILED
    }),
    openBrowser: null,
  });
  falsy('spawn-server: invalid root => not ok', r.ok);
  eq('spawn-server: invalid root => SPAWN_FAILED', r.reason, 'SPAWN_FAILED');
  tru('spawn-server: invalid root detail observable', String(r.detail).includes('CONTROL_CWD_INVALID'));
}

// ---- report ------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'ok' : 'FAIL'}  ${c.name}${c.ok ? '' : `  got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
console.log(`control-ui-launcher.test: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);
