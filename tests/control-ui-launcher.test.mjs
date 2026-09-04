#!/usr/bin/env node
// control-ui-launcher.test.mjs — tests for packages/control-ui/launcher.mjs.
// No framework. Exit 0 = PASS, 1 = FAIL. Fully injected: NO real server spawn,
// NO real browser, NO real repo. Deterministic, fast, offline.
import http from 'node:http';
import {
  probeControlUi, runLauncher,
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
  eq('spawn-fail: no pointless polling', probes, 1);
}

// ---- report ------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'ok' : 'FAIL'}  ${c.name}${c.ok ? '' : `  got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
console.log(`control-ui-launcher.test: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);
