#!/usr/bin/env node
// client-mcp-supervisor.test.mjs — AUTO MCP recovery supervisor failure matrix
// (R1–R16, post-#182 manual recovery). PROCESS-BACKED: real client-mcp.mjs
// adapter OS processes, real mcp-supervisor.mjs OS processes, and a FAKE
// OpenCode client that mirrors the runtime-proven OpenCode 1.18.27 stdio
// semantics exactly (verified against sst/opencode tag v1.18.27, file
// packages/opencode/src/mcp/index.ts, plus live `opencode serve` evidence):
//   * the CLIENT (pipe owner) spawns local stdio adapters; onclose only marks
//     {status:'failed', error:'Connection closed'} — NO automatic respawn;
//   * POST /mcp/:name/connect re-runs connectLocal: spawns a FRESH stdio child
//     under the SAME running client, answers true, and only reports
//     'connected' after the initialize + tools/list handshake succeeds.
// So every kill/restart below drives a REAL adapter process lifecycle through
// the same seam production uses (native rebind — no second spawner, no proxy).
//
// North Star asserted everywhere: transport recovery never restarts the task,
// session, executor or execution; never mints a second ExecutionRecord/mutation
// owner; never answers the Human Gate; never terminalizes; never replays a
// mutation; UNKNOWN liveness fails closed; GONE is reported truthfully.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';

import {
  sessionPathFor, readSessionRecord, taskRequestHumanGate, taskFinish, HUMAN_GATE_STATES,
} from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { readExecutionRecord } from '../packages/executor-launcher/executor-launcher.mjs';
import { isAlive, readWin32ProcessStartTime } from '../packages/temp-hygiene/temp-hygiene.mjs';
import { createClientControl, createCanonicalRouteExecutor } from '../packages/client-mcp/client-control.mjs';
import { createClientMcpServer } from '../packages/client-mcp/client-mcp.mjs';
import { recordAdapterBoot, recordReattach, transportStatePathFor } from '../packages/client-mcp/recovery.mjs';
import { createMcpSupervisor, acquireSupervisorLock, supervisorStatePathFor, supervisorLockPathFor, classifyHolderIdentity, HOLDER_LIVE, HOLDER_STALE_PROVEN, HOLDER_UNKNOWN } from '../packages/client-mcp/supervisor.mjs';

const SERVER = fileURLToPath(new URL('../packages/client-mcp/client-mcp.mjs', import.meta.url));
const ENTRY = fileURLToPath(new URL('../packages/client-mcp/mcp-supervisor.mjs', import.meta.url));
const NAME = 'soc-brain-client';
const IS_WIN = process.platform === 'win32';
const TERMINAL = ['COMPLETED', 'FAILED', 'BLOCKED'];

const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-sup-'));
mkdirSync(path.join(TMP, 'wt'), { recursive: true });

// ---- deterministic REAL executor process (same sanctioned seam as #179/#182) ----
const STUB = path.join(TMP, 'executor-stub.mjs');
writeFileSync(STUB, [
  "const ms = Number(process.env.__STUB_MS || 120000);",
  "let n = 0; const tick = () => { try { process.stdout.write(JSON.stringify({ type: 'text', part: { text: 'sup step ' + (++n) }, t: Date.now() }) + '\\n'); } catch { } };",
  "tick(); const iv = setInterval(tick, 150);",
  "setTimeout(() => { clearInterval(iv); process.exit(0); }, ms);",
  "process.on('SIGTERM', () => process.exit(0));",
].join('\n'), 'utf8');

function deterministicExecutorDeps(spawned) {
  return {
    spawn: () => { const c = spawn(process.execPath, [STUB], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, __STUB_MS: '120000' } }); spawned.push(c); return c; },
    resolveExecutable: () => ({ ok: true, executable: process.execPath, source: 'deterministic-test', candidates: [] }),
    preflight: () => ({ ok: true, version: 'deterministic-test', agent: 'build', toolCaps: ['bash', 'edit', 'read', 'glob', 'grep', 'list'] }),
    verifyAuthority: () => ({ ok: true }),
  };
}

function makeRepo(ownerRepoName) {
  const dir = mkdtempSync(path.join(TMP, 'repo-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const run = (args) => { try { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { throw new Error('git ' + args.join(' ') + ' failed: ' + ((e.stderr || '') + (e.stdout || '') || e.message)); } };
  run(['init', '--initial-branch=main', dir]);
  run(['-C', dir, 'config', 'user.email', 't@e.x']); run(['-C', dir, 'config', 'user.name', 't']);
  writeFileSync(path.join(dir, 'opencode.json'), '{}\n'); writeFileSync(path.join(dir, 'README.md'), 'r\n');
  run(['-C', dir, 'add', 'opencode.json']); run(['-C', dir, 'add', 'README.md']); run(['-C', dir, 'commit', '-m', 'init']);
  const sha = run(['-C', dir, 'rev-parse', 'HEAD']);
  run(['-C', dir, 'remote', 'add', 'origin', `https://github.com/${ownerRepoName}.git`]);
  run(['-C', dir, 'update-ref', 'refs/remotes/origin/main', sha]);
  return { dir, ownerRepoName, sha };
}

function callMcp(server, name, args) {
  const res = server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res && res.result, `no result for ${name}`);
  return JSON.parse(res.result.content[0].text);
}

function admitAndLaunch({ stateDir, repo, lane, issueNumber, spawned }) {
  const control = createClientControl({ stateDir, worktreesRoot: path.join(TMP, 'wt'), controlLane: lane, routeExecutor: createCanonicalRouteExecutor(deterministicExecutorDeps(spawned)) });
  const server = createClientMcpServer({ control });
  const out = callMcp(server, 'soc.submit_goal', { targetRepo: repo.ownerRepoName, localCheckoutPath: repo.dir, goal: 'supervisor matrix work', issueNumber });
  assert.ok(out.ok, JSON.stringify(out));
  assert.ok(out.execution && out.execution.ok === true && out.execution.status === 'RUNNING', JSON.stringify(out.execution));
  return out;
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function readTransport(S) { return readJson(transportStatePathFor({ stateDir: S })); }
function readSup(S) { return readJson(supervisorStatePathFor({ stateDir: S })); }
function countFiles(dir, pred) { try { return fs.readdirSync(dir).filter(pred).length; } catch { return 0; } }
function execCount(S, h) { return countFiles(path.join(S, 'executions'), (f) => f.startsWith(h) && f.endsWith('.json') && !f.includes('events') && !f.includes('terminal')); }
function sessionCount(S) { return countFiles(path.join(S, 'sessions'), (f) => f.endsWith('.json')); }
async function until(pred, timeoutMs = 30000) { const t0 = Date.now(); for (;;) { const v = pred(); if (v) return v; if (Date.now() - t0 > timeoutMs) return null; await new Promise((r) => setTimeout(r, 100)); } }
function laneStateDir(name) { const d = path.join(TMP, `state-${name}`); mkdirSync(d, { recursive: true }); return d; }
function canonicalFingerprint(S) {
  return JSON.stringify({ sessions: fingerprintDir(path.join(S, 'sessions')), executions: fingerprintDir(path.join(S, 'executions')), activity: fingerprintDir(path.join(S, 'activity')) });
}
function fingerprintDir(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (!e.name.endsWith('.events.jsonl')) out[path.relative(dir, p)] = fs.readFileSync(p).length; } };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

// ---- adapter stdio client harness (exactly what the MCP client pipe does) -------
function wrapAdapter(proc) {
  proc.stdout.setEncoding('utf8');
  let buf = ''; const pending = new Map();
  proc.stdout.on('data', (c) => {
    buf += c; const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) { const t = l.trim(); if (!t) continue; let m; try { m = JSON.parse(t); } catch { continue; } if (m && Object.prototype.hasOwnProperty.call(m, 'id') && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } }
  });
  let seq = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => { const id = ++seq; const to = setTimeout(() => { pending.delete(id); reject(new Error(`adapter rpc timeout ${method}`)); }, 8000); pending.set(id, (m) => { clearTimeout(to); resolve(m); }); try { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); } catch (e) { clearTimeout(to); reject(e); } });
  const exited = new Promise((r) => proc.on('close', (code, signal) => r({ code, signal })));
  return {
    proc, rpc, exited,
    async handshake() { const i = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fake-opencode', version: '1' } }); if (!i.result || i.result.serverInfo.name !== 'soc-brain-client') throw new Error('bad initialize'); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n'); const tl = await rpc('tools/list', {}); if (!tl.result || !Array.isArray(tl.result.tools) || !tl.result.tools.length) throw new Error('tools/list empty'); },
    kill: (sig) => { try { proc.kill(sig || 'SIGKILL'); } catch { /* gone */ } },
    closeStdin: () => { try { proc.stdin.end(); } catch { /* gone */ } },
    breakPipes: () => { try { proc.stdout.destroy(); } catch { /* gone */ } try { proc.stdin.destroy(); } catch { /* gone */ } },
  };
}

// ---- FAKE OpenCode client (mirrors the proven v1.18.27 connect/onclose seam) ----
function startFakeOpenCode({ stateDir, worktreesRoot, autoRecover = '1' }) {
  const f = { mode: 'normal', connects: 0, spawns: 0, current: null, status: { status: 'failed', error: 'not started' }, children: [], server: null, url: null };
  const connectAdapter = async () => {
    if (f.current) { const old = f.current; f.current = null; try { old.kill('SIGKILL'); } catch { /* gone */ } } // storeClient closes the previous client
    f.spawns += 1;
    const env = { ...process.env, SOC_CONTROL_STATE_DIR: stateDir, SOC_CONTROL_WORKTREES_ROOT: worktreesRoot };
    delete env.SOC_CONTROL_LANE;
    if (autoRecover) env.SOC_MCP_AUTO_RECOVER = String(autoRecover); else delete env.SOC_MCP_AUTO_RECOVER;
    const args = f.mode === 'deadly' ? ['-e', 'process.exit(1)'] : [SERVER];
    const proc = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    f.children.push(proc); proc.stderr.resume();
    const a = wrapAdapter(proc);
    if (f.mode === 'deadly') { await a.exited; f.status = { status: 'failed', error: 'Connection closed' }; return; }
    const markClosed = () => { if (f.current === a) { f.current = null; f.status = { status: 'failed', error: 'Connection closed' }; } };
    proc.on('close', markClosed); proc.stdout.on('close', markClosed);
    try { await a.handshake(); } catch { markClosed(); try { a.kill('SIGKILL'); } catch { /* gone */ } return; }
    f.current = a; f.status = { status: 'connected' };
  };
  const route = (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && u.pathname === '/mcp') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ [NAME]: f.status })); return; }
    const m = u.pathname.match(/^\/mcp\/([^/]+)\/connect$/);
    if (req.method === 'POST' && m && decodeURIComponent(m[1]) === NAME) {
      f.connects += 1;
      if (f.mode === 'refuse' || (f.mode === 'fail-first' && f.connects === f.firstConnectRefusedAt)) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"connect refused"}'); return; }
      connectAdapter().catch(() => { /* status reflects the outcome */ });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('true'); return;
    }
    res.writeHead(404); res.end();
  };
  f.listen = (port = 0) => new Promise((resolve, reject) => {
    f.server = http.createServer(route);
    f.server.once('error', reject);
    f.server.listen(port, '127.0.0.1', () => { f.url = `http://127.0.0.1:${f.server.address().port}`; resolve(f.url); });
  });
  f.admitConnect = connectAdapter;
  f.restart = async () => {
    const port = f.server.address().port;
    if (f.current) { try { f.current.kill('SIGKILL'); } catch { /* gone */ } f.current = null; }
    await new Promise((r) => { f.server.on('close', r); f.server.close(); });
    f.status = { status: 'failed', error: 'not started' }; f.mode = 'normal';
    const base = { connects: f.connects, spawns: f.spawns };
    let lastErr = null;
    for (let i = 0; i < 20; i++) { try { await f.listen(port); lastErr = null; break; } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 100)); } }
    if (lastErr) throw lastErr;
    await connectAdapter(); // OpenCode spawns configured local servers at startup
    f.connects = base.connects; f.spawns = base.spawns; // keep cumulative counters for assertions
    return f.url;
  };
  f.tool = async (name, args) => { if (!f.current) throw new Error('no live adapter'); const r = await f.current.rpc('tools/call', { name, arguments: args }); if (r.error) throw new Error(JSON.stringify(r.error)); return JSON.parse(r.result.content[0].text); };
  f.kill = async (kind) => {
    const a = f.current; if (!a) return;
    f.current = null; f.status = { status: 'failed', error: 'Connection closed' };
    if (kind === 'clean') a.closeStdin();
    else if (kind === 'break') { a.breakPipes(); setTimeout(() => { try { a.kill('SIGKILL'); } catch { /* gone */ } }, 400); }
    else a.kill(kind === 'term' ? 'SIGTERM' : 'SIGKILL');
  };
  f.close = () => { for (const c of f.children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } try { if (f.current) f.current.kill('SIGKILL'); } catch { /* gone */ } try { if (f.server) f.server.close(); } catch { /* gone */ } };
  return f;
}

// ---- supervisor OS process -------------------------------------------------------
function startSupervisor({ url, S, maxAttempts = '3', baseMs = '150', capMs = '400', healthMs = '2500', reattachMs = '6000', password }) {
  const env = {
    ...process.env,
    SOC_OPENCODE_CONTROL_URL: url, SOC_CONTROL_STATE_DIR: S, SOC_OPENCODE_MCP_SERVER: NAME,
    SOC_SUPERVISOR_POLL_MS: '120', SOC_SUPERVISOR_BACKOFF_BASE_MS: baseMs, SOC_SUPERVISOR_BACKOFF_CAP_MS: capMs,
    SOC_SUPERVISOR_MAX_ATTEMPTS: maxAttempts, SOC_SUPERVISOR_HEALTH_TIMEOUT_MS: healthMs, SOC_SUPERVISOR_REATTACH_TIMEOUT_MS: reattachMs,
  };
  if (password) env.SOC_OPENCODE_SERVER_PASSWORD = password; else delete env.SOC_OPENCODE_SERVER_PASSWORD;
  const proc = spawn(process.execPath, [ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
  const events = []; proc.stdout.on('data', (d) => { for (const l of d.split('\n')) { const t = l.trim(); if (!t) continue; try { events.push(JSON.parse(t)); } catch { events.push({ raw: t }); } } });
  const stderr = []; proc.stderr.on('data', (d) => stderr.push(String(d)));
  const exited = new Promise((r) => proc.on('exit', (code) => r(code)));
  return {
    proc, events, stderr, exited,
    kill: () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } },
    waitFor: async (pred, timeoutMs = 30000) => await until(() => { const s = readSup(S); return s && s.supervisorPid === proc.pid && pred(s) ? s : null; }, timeoutMs),
  };
}

async function withRig(name, issue, fn, opts = {}) {
  const R = makeRepo(`duongpdddic-droid/disposable-sup-${name}`);
  const S = laneStateDir(name);
  const lane = `control-plane-${name}`;
  const spawned = [];
  const sub = admitAndLaunch({ stateDir: S, repo: R, lane, issueNumber: issue, spawned });
  const pid = sub.execution.pid;
  // Fresh-plane rigs bootstrap the FIRST attach explicitly (documented
  // SOC_MCP_AUTO_RECOVER=bootstrap mode); after that pin exists, every respawn
  // binds exactly (STRICT semantics) in every mode. SR13b overrides to '1' to
  // prove strict never falls back to discovery.
  const f = startFakeOpenCode({ stateDir: S, worktreesRoot: path.join(TMP, 'wt'), autoRecover: opts.autoRecover !== undefined ? opts.autoRecover : 'bootstrap' });
  const url = await f.listen();
  const state = { sup: null };
  const supStart = (opts = {}) => { state.sup = startSupervisor({ url, S, ...opts }); return state.sup; };
  try { await fn({ R, S, lane, sub, pid, spawned, f, url, supStart, sup: () => state.sup }); }
  finally {
    if (state.sup) state.sup.kill();
    f.close();
    for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  }
}

// Establish: adapter #1 connected + auto-reattached, supervisor baseline RECOVERED.
async function establish(ctx, supOpts = {}) {
  const { f, S, sub } = ctx;
  await f.admitConnect();
  assert.equal(f.status.status, 'connected', 'fake OpenCode adapter handshake OK');
  const t1 = await until(() => { const t = readTransport(S); return t && t.transportState === 'RECOVERED' ? t : null; });
  assert.ok(t1, 'adapter boot auto-reattach wrote transport.json RECOVERED');
  assert.equal(t1.currentTaskIdentity.identityHash, sub.identityHash);
  const sup = ctx.supStart(supOpts);
  assert.ok(await sup.waitFor((s) => s.transportState === 'RECOVERED' && s.currentTaskIdentity && s.currentTaskIdentity.identityHash === sub.identityHash), `supervisor baseline RECOVERED: ${JSON.stringify(readSup(S))}`);
  return { sup, boot1: t1.lastBootId, apid1: t1.lastPid };
}

// ------------------------------------------------------------------- SR1 ---------
test('SR1/A1/A2/A3/A16 PROCESS-BACKED: clean EOF auto-detected -> auto rebind via native connect -> RECOVERED SAME task+execution, zero operator action', async () => {
  await withRig('sr1', 880101, async (ctx) => {
    const { S, sub, pid, f, R } = ctx;
    const { sup, boot1 } = await establish(ctx);
    const sessPath = sessionPathFor({ stateDir: S, identityHash: sub.identityHash });
    const sess0 = fs.readFileSync(sessPath);
    await f.kill('clean');
    const fin = await sup.waitFor((s) => s.transportState === 'RECOVERED' && s.adapterBootId && s.adapterBootId !== boot1, 30000);
    assert.ok(fin, `auto recovery completed: ${JSON.stringify(readSup(S))}`);
    assert.equal(fin.currentTaskIdentity.identityHash, sub.identityHash, 'A3: SAME canonical task/session');
    assert.ok(fin.lastDisconnectAt, 'lastDisconnectAt exposed');
    assert.ok(fin.lastRecoveryResult && fin.lastRecoveryResult.ok === true, 'lastRecoveryResult recorded');
    assert.equal(fin.recoveryAttemptCount, 0, 'attempt budget resets after success');
    assert.equal(fin.supervisorPid, sup.proc.pid, 'supervisorPid exposed');
    assert.ok(Number.isInteger(fin.adapterPid) && isAlive(fin.adapterPid), 'fresh adapter OS process alive');
    if (IS_WIN) assert.equal(fin.executionLiveness, 'RUNNING', 'A4: SAME executor proven still RUNNING');
    assert.equal(fin.humanGateState, 'NONE');
    assert.equal(isAlive(pid), true, 'A4: executor never restarted');
    assert.deepEqual(fs.readFileSync(sessPath), sess0, 'canonical session byte-stable');
    assert.equal(execCount(S, sub.identityHash), 1, 'A5: exactly one ExecutionRecord');
    assert.ok(!fs.existsSync(path.join(S, 'client-mcp', 'submissions')), 'never resubmitted the goal');
    for (const k of ['transportState', 'adapterPid', 'supervisorPid', 'lastDisconnectAt', 'lastRecoveryAttemptAt', 'recoveryAttemptCount', 'lastRecoveryResult', 'currentTaskIdentity', 'executionLiveness', 'humanGateState']) assert.ok(k in fin, `PHASE9 observability exposes ${k}`);
    assert.equal(JSON.stringify(fin).match(/leaseToken|SOC_SESSION_TOKEN|[A-Za-z]:\\\\Users|absolute/i), null, 'no secrets/absolute paths in supervisor.json');
    const gt = await f.tool('soc.get_task', { repo: R.ownerRepoName, issueNumber: 880101 });
    assert.ok(gt.ok && gt.task.identityHash === sub.identityHash, 'control surface usable after auto recovery');
  });
});

// ------------------------------------------------------------------- SR2/R6 ------
test('SR2+A4/A6 PROCESS-BACKED: adapter SIGTERM while the EXECUTOR keeps running -> UNGRACEFUL observed, executor + ExecutionRecord untouched, RECOVERED same owner', async () => {
  await withRig('sr2', 880102, async (ctx) => {
    const { S, lane, sub, pid } = ctx;
    const { sup, boot1 } = await establish(ctx);
    const rec0 = readExecutionRecord({ stateDir: S, repo: 'duongpdddic-droid/disposable-sup-sr2', issueNumber: 880102 });
    assert.ok(rec0.ok);
    await ctx.f.kill('term');
    const fin = await sup.waitFor((s) => s.transportState === 'RECOVERED' && s.adapterBootId && s.adapterBootId !== boot1, 30000);
    assert.ok(fin, JSON.stringify(readSup(S)));
    assert.equal(isAlive(pid), true, 'R6: adapter SIGTERM cannot touch the executor');
    assert.equal(fin.currentTaskIdentity.executionPid, pid, 'the SAME execution pid is pinned across recovery');
    const rec1 = readExecutionRecord({ stateDir: S, repo: 'duongpdddic-droid/disposable-sup-sr2', issueNumber: 880102 });
    assert.equal(JSON.stringify(rec1.record), JSON.stringify(rec0.record), 'ExecutionRecord unchanged by transport recovery');
    assert.equal(readTransport(S).lastDisconnectKind, 'UNGRACEFUL', 'a kill stays honestly UNGRACEFUL');
    assert.equal(readTransport(S).mutationOwner, lane, 'A6: mutation owner unchanged');
    assert.equal(fin.currentTaskIdentity.mutationOwner, lane);
  });
});

// ------------------------------------------------------------------- SR3 ---------
test('SR3+A5/A10 PROCESS-BACKED: adapter SIGKILL -> exactly ONE fresh adapter respawned (no double-mint), one ExecutionRecord, one session', async () => {
  await withRig('sr3', 880103, async (ctx) => {
    const { S, sub, pid, f } = ctx;
    const { sup, boot1 } = await establish(ctx);
    const spawns0 = f.spawns;
    await f.kill('kill');
    const fin = await sup.waitFor((s) => s.transportState === 'RECOVERED' && s.adapterBootId && s.adapterBootId !== boot1, 30000);
    assert.ok(fin, JSON.stringify(readSup(S)));
    assert.equal(f.spawns - spawns0, 1, 'A10: exactly one adapter respawn for one outage');
    assert.equal(execCount(S, sub.identityHash), 1);
    assert.equal(sessionCount(S), 1);
    assert.equal(isAlive(pid), true);
    const live = f.children.filter((c) => c.exitCode === null && !c.killed);
    assert.ok(live.length >= 1, 'a live adapter exists');
    assert.equal(isAlive(fin.adapterPid), true, 'the pinned adapterPid is the live one');
  });
});

// ------------------------------------------------------------- SR4+R10 -----------
test('SR4/R4/A8/A9 PROCESS-BACKED: adapter crash loop -> bounded attempts + real backoff (no tight loop) -> RECOVERY_FAILED, canonical fingerprint identical', async () => {
  await withRig('sr4', 880104, async (ctx) => {
    const { S, sub, f } = ctx;
    const { sup, boot1 } = await establish(ctx, { maxAttempts: '2', baseMs: '200', capMs: '300', healthMs: '500', reattachMs: '500' });
    f.mode = 'deadly'; // every respawned adapter dies instantly
    const fp0 = canonicalFingerprint(S);
    const sessPath = sessionPathFor({ stateDir: S, identityHash: sub.identityHash });
    const sess0 = fs.readFileSync(sessPath);
    const t0 = Date.now();
    const connects0 = f.connects;
    await f.kill('kill');
    const fin = await sup.waitFor((s) => s.transportState === 'RECOVERY_FAILED', 30000);
    assert.ok(fin, `RECOVERY_FAILED reached: ${JSON.stringify(readSup(S))}`);
    const elapsed = Date.now() - t0;
    assert.equal(fin.recoveryAttemptCount, 2, 'A8: attempt cap enforced (2), not unbounded');
    assert.ok(f.connects - connects0 <= 2, 'no more rebind attempts than the budget');
    assert.ok(elapsed >= 200 + 2 * 500, `backoff+health timeouts observed (${elapsed}ms >= 1200ms): no tight crash loop`);
    assert.deepEqual(canonicalFingerprint(S), fp0, 'R10/A9: exhaustion left task/session/ExecutionRecord/lease identical (append-only executor telemetry journal excluded — it is canonical runtime output, not transport mutation)');
    assert.deepEqual(fs.readFileSync(sessPath), sess0);
    assert.ok(sup.exited instanceof Promise); // supervisor process stayed alive, fail-closed not crashed
    const err = await Promise.race([sup.exited.then(() => 'exited'), new Promise((r) => setTimeout(() => r('alive'), 300))]);
    assert.equal(err, 'alive', 'supervisor keeps running after exhaustion (observability continues, no restart)');
    assert.ok(!fs.existsSync(path.join(S, 'client-mcp', 'submissions')), 'never auto-submitted on exhaustion');
  });
});

// ------------------------------------------------------------------- SR5 ---------
test('SR5/R5 PROCESS-BACKED: transport pipe break (streams destroyed, not a clean exit) -> detected -> RECOVERED', async () => {
  await withRig('sr5', 880105, async (ctx) => {
    const { S, sub } = ctx;
    const { sup, boot1 } = await establish(ctx);
    await ctx.f.kill('break');
    const fin = await sup.waitFor((s) => s.transportState === 'RECOVERED' && s.adapterBootId && s.adapterBootId !== boot1, 30000);
    assert.ok(fin, JSON.stringify(readSup(S)));
    assert.equal(fin.currentTaskIdentity.identityHash, sub.identityHash);
  });
});

// ------------------------------------------------------------------- SR7 ---------
test('SR7/A12 PROCESS-BACKED: executor dies while the transport is down -> canonical finalization settles it -> auto recovery reports GONE truthfully, never terminalizes, never synthesizes RUNNING', async () => {
  await withRig('sr7', 880107, async (ctx) => {
    const { S, sub, pid, f, spawned } = ctx;
    const { sup, boot1 } = await establish(ctx, { reattachMs: '8000' });
    await f.kill('kill'); // transport down
    for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* gone */ } } // executor dies while down
    assert.ok(await until(() => { const r = readExecutionRecord({ stateDir: S, repo: 'duongpdddic-droid/disposable-sup-sr7', issueNumber: 880107 }); return r.ok && !!r.record.terminalStatus; }), 'production finalization records the terminal status (canonical, not the transport)');
    assert.equal(isAlive(pid), false);
    const fin = await sup.waitFor((s) => s.transportState === 'RECOVERED' && s.adapterBootId && s.adapterBootId !== boot1, 30000);
    assert.ok(fin, JSON.stringify(readSup(S)));
    assert.equal(fin.executionLiveness, 'GONE', 'dead executor reported GONE — never synthetic RUNNING');
    assert.equal(fin.currentTaskIdentity.identityHash, sub.identityHash, 'the SAME canonical attempt was reattached');
    const sess = readSessionRecord(sessionPathFor({ stateDir: S, identityHash: sub.identityHash })).session;
    assert.ok(!TERMINAL.includes(sess.state), 'recovery never terminalized the task — lifecycle stays canonical');
    assert.equal(execCount(S, sub.identityHash), 1, 'executor death + auto recovery minted no second execution');
  });
});

// ------------------------------------------------------------------- SR8 ---------
test('SR8/A7 PROCESS-BACKED: Human Gate WAITING across auto recovery -> SAME checkpoint visible, never auto-answered -> exactly one human answer accepted, replay fails closed', async () => {
  await withRig('sr8', 880108, async (ctx) => {
    const { S, sub, pid, f, R } = ctx;
    const { sup, boot1 } = await establish(ctx);
    const sessPath = sessionPathFor({ stateDir: S, identityHash: sub.identityHash });
    assert.ok(taskRequestHumanGate({ sessionPath: sessPath, note: 'Postgres or SQLite?' }).ok);
    const gateAt = readSessionRecord(sessPath).session.humanGate.at;
    await f.kill('kill');
    const fin = await sup.waitFor((s) => s.transportState === 'RECOVERED' && s.adapterBootId && s.adapterBootId !== boot1, 30000);
    assert.ok(fin, JSON.stringify(readSup(S)));
    assert.equal(fin.humanGateState, 'WAITING', 'gate survives the transport recovery');
    assert.equal(readTransport(S).humanGateAt, gateAt, 'SAME checkpoint pinned');
    const mid = readSessionRecord(sessPath).session;
    assert.ok(HUMAN_GATE_STATES.includes(mid.state), 'A7: the supervisor never auto-answered the gate');
    assert.equal(isAlive(pid), true, 'gate-parked executor survived the transport restart');
    const stale = await f.tool('soc.answer_human_gate', { repo: R.ownerRepoName, issueNumber: 880108, checkpointAt: '1970-01-01T00:00:00.000Z', response: 'PG' });
    assert.equal(stale.ok, false); assert.equal(stale.reason, 'GATE_CHECKPOINT_STALE');
    const ans = await f.tool('soc.answer_human_gate', { repo: R.ownerRepoName, issueNumber: 880108, checkpointAt: gateAt, response: 'Postgres' });
    assert.ok(ans.ok, JSON.stringify(ans)); assert.equal(ans.state, 'SESSION_ACTIVE');
    const dup = await f.tool('soc.answer_human_gate', { repo: R.ownerRepoName, issueNumber: 880108, checkpointAt: gateAt, response: 'again' });
    assert.equal(dup.ok, false); assert.equal(dup.reason, 'GATE_NOT_ACTIVE', 'protections unchanged post-recovery');
  });
});

// ------------------------------------------------------------------- SR9 ---------
test('SR9 PROCESS-BACKED: first rebind attempt refused -> bounded retry succeeds on attempt 2 -> RECOVERED', async () => {
  await withRig('sr9', 880109, async (ctx) => {
    const { S, sub, f } = ctx;
    const { sup, boot1 } = await establish(ctx, { baseMs: '100', capMs: '200' });
    const connects0 = f.connects;
    f.mode = 'fail-first'; f.firstConnectRefusedAt = connects0 + 1;
    await f.kill('kill');
    const fin = await sup.waitFor((s) => s.transportState === 'RECOVERED' && s.adapterBootId && s.adapterBootId !== boot1, 30000);
    assert.ok(fin, JSON.stringify(readSup(S)));
    assert.equal(f.connects - connects0, 2, 'one failed rebind + one successful rebind');
    assert.equal(fin.currentTaskIdentity.identityHash, sub.identityHash);
    assert.equal(fin.recoveryAttemptCount, 0, 'budget reset after the success');
  });
});

// ------------------------------------------------------------------- SR11 --------
test('SR11/A10 PROCESS-BACKED: two supervisor instances -> only the lock holder ever rebinds; the loser exits without touching the transport; one adapter per outage', async () => {
  await withRig('sr11', 880111, async (ctx) => {
    const { S, sub, f } = ctx;
    const { sup, boot1 } = await establish(ctx);
    const rival = startSupervisor({ url: ctx.url || f.url, S });
    const code = await rival.exited.then((c) => c).catch(() => 'hang');
    assert.equal(code, 1, 'the second supervisor refuses to dual-manage and exits');
    assert.ok(rival.events.some((e) => e.event === 'SUPERVISOR_ALREADY_RUNNING') || String(rival.stderr.join('')).includes('SUPERVISOR'), 'loser reports why it exited');
    const spawns0 = f.spawns;
    await f.kill('kill');
    const fin = await sup.waitFor((s) => s.transportState === 'RECOVERED' && s.adapterBootId && s.adapterBootId !== boot1, 30000);
    assert.ok(fin, JSON.stringify(readSup(S)));
    assert.equal(f.spawns - spawns0, 1, 'A10: duplicate supervisor/restart race mints no second adapter');
    assert.equal(fin.currentTaskIdentity.identityHash, sub.identityHash);
  });
});

// --------------------------------------------------------- SR11b (F1 RACE) ------
test('SR11b/F1 PROCESS-BACKED: two supervisors started TRULY CONCURRENTLY on a cold lock -> exactly one winner via atomic no-clobber acquisition; exactly one POST connect + one fresh adapter; loser writes zero', async () => {
  await withRig('sr11b', 880118, async (ctx) => {
    const { S, sub, f } = ctx;
    await f.admitConnect(); // single pinned baseline exists, NO supervisor yet
    const t0 = await until(() => { const t = readTransport(S); return t && t.transportState === 'RECOVERED' ? t : null; });
    assert.ok(t0, 'baseline pinned before the race');
    const boot1 = t0.lastBootId;
    const connects0 = f.connects, spawns0 = f.spawns;
    // COLD LOCK + both processes admitted on the same tick — the acquisition
    // itself is the race (no pre-existing holder serializes them):
    const a = ctx.supStart({});
    const b = startSupervisor({ url: f.url, S });
    await f.kill('kill'); // induce the ONE outage both cold instances now face
    try {
      const sameFence = (s) => s.transportState === 'RECOVERED' && s.adapterBootId && s.adapterBootId !== boot1;
      let aWon = null, bWon = null;
      for (let i = 0; i < 300 && !aWon && !bWon; i++) {
        aWon = await (async () => { const s = readSup(S); return s && s.supervisorPid === a.proc.pid && sameFence(s) ? s : null; })();
        bWon = await (async () => { const s = readSup(S); return s && s.supervisorPid === b.proc.pid && sameFence(s) ? s : null; })();
        if (!aWon && !bWon) await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(aWon || bWon, 'one of the two cold racing supervisors recovered the transport');
      const winner = aWon ? a : b, loser = aWon ? b : a;
      assert.ok(!(aWon && bWon), 'exactly ONE winner');
      const loserCode = await Promise.race([loser.exited, new Promise((r) => setTimeout(() => r('hang'), 15000))]);
      assert.equal(loserCode, 1, 'loser terminated with the already-running exit (never dual-managed)');
      assert.ok(loser.events.some((e) => e.event === 'SUPERVISOR_ALREADY_RUNNING'), 'loser exited on the atomic fence, not on a lost write race');
      const fin = winner === a ? aWon : bWon;
      assert.equal(fin.currentTaskIdentity.identityHash, sub.identityHash, 'winner completed the SAME-identity recovery');
      assert.equal(f.connects - connects0, 1, 'exactly ONE POST /mcp/connect across the race');
      assert.equal(f.spawns - spawns0, 1, 'exactly ONE fresh adapter minted');
      assert.equal(readSup(S).supervisorPid, winner.proc.pid, 'loser wrote ZERO observability');
    } finally { b.kill(); }
  });
});

// --------------------------------------------------------- SR11c (F1 UNKNOWN) ---
test('SR11c/F1 PROCESS+DETERMINISTIC: a LIVE-but-identity-UNPROVEN holder can NEVER be stolen (fail-closed SUPERVISOR_IDENTITY_UNPROVEN, zero side effects); only positively-STALE_PROVEN owners are taken over', async () => {
  // (0) classifier matrix — fully deterministic via DI (forced win32 semantics):
  const W = { platform: 'win32' };
  assert.equal(classifyHolderIdentity({ pid: 0 }, { ...W, alive: () => true }), HOLDER_STALE_PROVEN, 'malformed pid cannot name a live owner');
  assert.equal(classifyHolderIdentity({ pid: 4242, startTime: 111 }, { ...W, alive: () => false, readStartTime: () => null }), HOLDER_STALE_PROVEN, 'dead PID -> proven stale');
  assert.equal(classifyHolderIdentity({ pid: 4242, startTime: null }, { ...W, alive: () => true, readStartTime: () => ({ processStartTime: 9 }) }), HOLDER_UNKNOWN, 'alive + stored startTime null -> UNKNOWN');
  assert.equal(classifyHolderIdentity({ pid: 4242, startTime: 111 }, { ...W, alive: () => true, readStartTime: () => null }), HOLDER_UNKNOWN, 'alive + probe unavailable -> UNKNOWN');
  assert.equal(classifyHolderIdentity({ pid: 4242, startTime: 111 }, { ...W, alive: () => true, readStartTime: () => ({ processStartTime: 111 }) }), HOLDER_LIVE, 'alive + exact start-time match -> LIVE');
  assert.equal(classifyHolderIdentity({ pid: 4242, startTime: 111 }, { ...W, alive: () => true, readStartTime: () => ({ processStartTime: 222 }) }), HOLDER_STALE_PROVEN, 'alive + positive mismatch (pid reuse) -> STALE_PROVEN');

  // (A+B) real supervisor OS process B against a persisted UNKNOWN holder:
  // holder A = the live test process pid with a null stored startTime (exactly
  // what acquire itself persists when the start-time probe failed at boot).
  const S = laneStateDir('sr11c');
  const lockPath = supervisorLockPathFor({ stateDir: S });
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const holderA = { schemaVersion: '1', bootId: 'holder-A-live', pid: process.pid, startTime: null, acquiredAt: new Date().toISOString(), updatedAt: new Date().toISOString(), takeoverFrom: null };
  fs.writeFileSync(lockPath, `${JSON.stringify(holderA, null, 2)}\n`, 'utf8');
  const lockBytes0 = fs.readFileSync(lockPath);
  const f = startFakeOpenCode({ stateDir: S, worktreesRoot: path.join(TMP, 'wt') }); // would answer connects if B were ever allowed to act
  const url = await f.listen();
  let b;
  try {
    b = startSupervisor({ url, S });
    const code = await Promise.race([b.exited, new Promise((r) => setTimeout(() => r('hang'), 20000))]);
    assert.equal(code, 1, 'D/E: contender B fails closed with a deterministic reason instead of stealing');
    const ev = b.events.find((e) => e.event);
    assert.ok(ev, 'B emitted its fail-closed event');
    assert.equal(ev.event, IS_WIN ? 'SUPERVISOR_IDENTITY_UNPROVEN' : 'SUPERVISOR_ALREADY_RUNNING', 'UNKNOWN holder -> SUPERVISOR_IDENTITY_UNPROVEN (win32); non-win32 keeps the pid-liveness convention');
    // (C/D/E/F) zero side effects:
    assert.equal(f.connects, 0, 'F: ZERO POST /mcp/:name/connect by B');
    assert.equal(f.spawns, 0, 'F: ZERO adapter effects');
    assert.equal(fs.existsSync(supervisorStatePathFor({ stateDir: S })), false, 'F: ZERO contender supervisor.json writes');
    assert.deepEqual(fs.readFileSync(lockPath), lockBytes0, 'G: holder A retains the lock byte-intact (no rename/quarantine)');
    const leftovers = fs.readdirSync(path.join(S, 'client-mcp')).filter((n) => n !== 'supervisor.lock');
    assert.deepEqual(leftovers, [], 'D: no .stale/.corrupt/.build residue — B never touched the store');
  } finally { if (b) b.kill(); f.close(); }

  // (H) LIVE pid with a POSITIVELY mismatched immutable start-time is
  // STALE_PROVEN -> safe takeover through the real acquisition path:
  const S2 = laneStateDir('sr11c-h');
  const lock2 = supervisorLockPathFor({ stateDir: S2 });
  mkdirSync(path.dirname(lock2), { recursive: true });
  fs.writeFileSync(lock2, `${JSON.stringify({ schemaVersion: '1', bootId: 'holder-H', pid: process.pid, startTime: 111111, acquiredAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  const acq = acquireSupervisorLock({ stateDir: S2, bootId: 'challenger-H', pid: process.pid, selfStartTime: 333333, holderOpts: { platform: 'win32', alive: () => true, readStartTime: () => ({ processStartTime: 222222 }) } });
  assert.ok(acq.ok && acq.acquired === true, 'H: proven-stale (positive mismatch) holder is replaced safely');
  const now = readJson(lock2);
  assert.equal(now.bootId, 'challenger-H', 'takeover recorded through the exclusive publication');
  assert.equal(now.takeoverFrom && now.takeoverFrom.bootId, 'holder-H', 'audit trail names the replaced stale holder');
  assert.deepEqual(fs.readdirSync(path.dirname(lock2)).filter((n) => n.startsWith('supervisor.lock.')), [], 'takeover leaves no quarantine residue');
});

// ------------------------------------------------------------------- SR12 --------
test('SR12/R12 PROCESS+UNIT-BACKED: dead holder lock is taken over; a STALE fenced instance can never seize the transport (no writes, no connect)', async () => {
  // unit: stale fence
  const S = laneStateDir('sr12-unit');
  seedTransport(S, { bootId: 'boot-live', identity: { repo: 'a/b', issueNumber: 5, identityHash: 'hx', taskId: 't-x' } });
  const acq = acquireSupervisorLock({ stateDir: S, bootId: 'fence-live', pid: process.pid, selfStartTime: IS_WIN ? (readWin32ProcessStartTime(process.pid) || {}).processStartTime : null });
  assert.ok(acq.ok, 'live owner holds the fence');
  let posts = 0;
  const stale = createMcpSupervisor({
    serverName: NAME, controlUrl: 'http://127.0.0.1:1', stateDir: S, bootId: 'fence-STALE',
    policy: { maxAttempts: 1, pollMs: 10 },
    fetchImpl: async (url, opts) => { if (opts.method === 'POST') posts += 1; return { ok: false, status: 0, async text() { return 'null'; } }; },
    sleep: async () => { },
  });
  const r = await stale.runCycle();
  assert.equal(r.action, 'stopped'); assert.equal(r.reason, 'SUPERVISOR_LOCK_LOST');
  assert.equal(posts, 0, 'stale supervisor issued NO rebind');
  assert.equal(fs.existsSync(supervisorStatePathFor({ stateDir: S })), false, 'stale supervisor wrote NO observability');
  // process: dead-holder takeover
  await withRig('sr12', 880112, async (ctx) => {
    const { S: P, sub, pid, f } = ctx;
    const { sup, boot1 } = await establish(ctx);
    sup.kill(); await sup.exited; // owner dies holding the lock
    await f.kill('kill');
    const sup2 = ctx.supStart({});
    const fin = await sup2.waitFor((s) => s.transportState === 'RECOVERED' && s.adapterBootId && s.adapterBootId !== boot1, 30000);
    assert.ok(fin, `dead holder's lock was replaced; recovery proceeded: ${JSON.stringify(readSup(P))}`);
    assert.equal(fin.currentTaskIdentity.identityHash, sub.identityHash);
    assert.equal(isAlive(pid), true);
  });
});

// ------------------------------------------------------------------- SR13 --------
test('SR13/A11 PROCESS-BACKED: during the outage the pinned task goes terminal and a FOREIGN task appears -> the pinned identity is observed truthfully, the foreign task NEVER auto-attaches', async () => {
  await withRig('sr13', 880113, async (ctx) => {
    const { S, sub, f, spawned } = ctx;
    const { sup, boot1 } = await establish(ctx, { reattachMs: '8000' });
    await f.kill('kill'); // outage begins with X pinned
    for (const c of spawned) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
    assert.ok(await until(() => { const r = readExecutionRecord({ stateDir: S, repo: 'duongpdddic-droid/disposable-sup-sr13', issueNumber: 880113 }); return r.ok && !!r.record.terminalStatus; }));
    assert.ok(taskFinish({ sessionPath: sessionPathFor({ stateDir: S, identityHash: sub.identityHash }), outcome: 'COMPLETED' }).ok, 'canonical terminalization of X (control-plane authority)');
    const R2 = makeRepo('duongpdddic-droid/disposable-sup-sr13-foreign');
    const Y = admitAndLaunch({ stateDir: S, repo: R2, lane: 'control-plane-sr13-f', issueNumber: 880114, spawned });
    assert.ok(Y.ok);
    const fin = await sup.waitFor((s) => s.transportState === 'RECOVERED' && s.adapterBootId && s.adapterBootId !== boot1, 30000);
    assert.ok(fin, `the pinned exact bind survives (truthful terminal observation): ${JSON.stringify(readSup(S))}`);
    assert.equal(fin.currentTaskIdentity.identityHash, sub.identityHash, 'attached identity is the PINNED task X');
    assert.notEqual(fin.currentTaskIdentity.identityHash, Y.identityHash, 'A11: the foreign/new active task Y was never auto-attached');
    assert.equal(execCount(S, Y.identityHash), 1, 'Y untouched');
  });
});

// --------------------------------------------------------- SR13b (F3 AUTO PIN) --
test('SR13b/F3 PROCESS-BACKED: STRICT auto boot with NO valid pin + one unrelated active task -> NEVER attaches by discovery, NEVER publishes RECOVERED, canonical unchanged (manual soc.recover discovery still works)', async () => {
  await withRig('sr13b', 880119, async (ctx) => {
    const { S, sub, f } = ctx; // `sub` IS the unrelated active task; no transport.json ever existed
    const sessPath = sessionPathFor({ stateDir: S, identityHash: sub.identityHash });
    const sess0 = fs.readFileSync(sessPath);
    await f.admitConnect(); // adapter #1 boots in STRICT mode with no pin
    const t1 = await until(() => { const t = readTransport(S); return t && t.transportState === 'RECOVERY_FAILED' ? t : null; });
    assert.ok(t1, 'strict boot records a deterministic failure instead of discovering');
    assert.equal(t1.lastRecoveryReason, 'AUTO_RECOVERY_PIN_MISSING');
    assert.equal(t1.currentTaskIdentity, null, 'F3: the unrelated active task was NOT attached');
    const sup = ctx.supStart({});
    const fin = await sup.waitFor((s) => s.transportState === 'RECOVERY_FAILED', 30000);
    assert.ok(fin, `supervisor fail-closes on unverifiable pin-missing transport: ${JSON.stringify(readSup(S))}`);
    assert.equal(fin.currentTaskIdentity, null, 'RECOVERED is never published and no identity is adopted');
    await f.kill('kill'); // another outage: same strict rule applies to the respawn
    const t2 = await until(() => { const t = readTransport(S); return t && t.transportState === 'RECOVERY_FAILED' && t.lastBootId !== t1.lastBootId ? t : null; }, 20000);
    assert.ok(t2, 'the respawned strict adapter failed closed again (never a RESTARTING-window false negative)');
    assert.equal(t2.lastRecoveryReason, 'AUTO_RECOVERY_PIN_MISSING');
    assert.equal(t2.currentTaskIdentity, null, 'still never attached by discovery');
    assert.notEqual(readSup(S).transportState, 'RECOVERED', 'never RECOVERED across the second outage');
    assert.deepEqual(fs.readFileSync(sessPath), sess0, 'canonical session unchanged by auto boot attempts');
    assert.equal(execCount(S, sub.identityHash), 1);
    // MANUAL discovery behavior is explicitly UNCHANGED: an operator/model call
    // on the live adapter may still attach the single active task (that is the
    // #182 seam; only the automatic path is pin-mandatory).
    // Issue #209: t2 above is ADAPTER-written transport.json — under
    // parallel-suite load it becomes observable BEFORE the parent-side
    // handshake inside connectAdapter() sets f.current, so f.tool raced ahead
    // and threw 'no live adapter'. Bind the manual call to client-side
    // liveness (bounded + fail-closed with a precise reason on timeout).
    const live = await until(() => Boolean(f.current), 30000);
    assert.ok(live, `respawned adapter handshake completed (f.current live) before manual soc.recover; status=${JSON.stringify(f.status)}`);
    const rec = await f.tool('soc.recover', {});
    assert.ok(rec.ok && rec.discovered === true && rec.currentTaskIdentity.identityHash === sub.identityHash, 'manual soc.recover({}) discovery preserved');
  }, { autoRecover: '1' });
});

// ------------------------------------------------------------------- SR14 --------
test('SR14/R14/A17 PROCESS-BACKED: the OpenCode client (pipe owner) restarts while supervisor+task remain -> the supervisor ADOPTS the startup-spawned fresh adapter with NO rebind call', async () => {
  await withRig('sr14', 880114, async (ctx) => {
    const { S, sub, f, url } = ctx;
    void url;
    const { sup, boot1 } = await establish(ctx, { reattachMs: '8000' });
    await f.restart(); // same port: client restart + startup adapter (fresh boot, auto recover)
    const fin = await sup.waitFor((s) => (s.transportState === 'RECOVERED' || s.transportState === 'CONNECTED') && s.adapterBootId && s.adapterBootId !== boot1, 30000);
    assert.ok(fin, `supervisor adopted the restarted client's startup adapter: ${JSON.stringify(readSup(S))}`);
    assert.equal(fin.currentTaskIdentity.identityHash, sub.identityHash, 'SAME canonical attempt across the client restart');
    assert.equal(f.connects, 0, 'R14: no supervisor-issued connect on the new client instance (its startup spawn sufficed)');
  });
});

// ------------------------------------------------------------------- SR15 --------
test('SR15/R15 PROCESS-BACKED: supervisor restart while the executor keeps running -> successor continues supervision, next outage auto-recovers, executor untouched', async () => {
  await withRig('sr15', 880115, async (ctx) => {
    const { S, sub, pid, f } = ctx;
    const { sup, boot1 } = await establish(ctx);
    const fp0 = canonicalFingerprint(S);
    sup.kill(); await sup.exited;
    assert.equal(canonicalFingerprint(S), fp0, 'supervisor death mutates no canonical state');
    assert.equal(isAlive(pid), true, 'R15: executor outlives the supervisor');
    await f.kill('kill'); // outage while unsupervised: nothing happens automatically...
    await new Promise((r) => setTimeout(r, 600));
    const sup2 = ctx.supStart({});
    const fin = await sup2.waitFor((s) => s.transportState === 'RECOVERED' && s.adapterBootId && s.adapterBootId !== boot1, 30000);
    assert.ok(fin, `successor recovered the pending outage: ${JSON.stringify(readSup(S))}`);
    assert.equal(fin.currentTaskIdentity.identityHash, sub.identityHash);
    assert.equal(isAlive(pid), true, 'still the SAME executor process');
  });
});

// ------------------------------------------------------------------- SR16 --------
test('SR16/A5/A6 PROCESS-BACKED: three consecutive auto recoveries -> ONE ExecutionRecord, SAME owner, byte-stable session, budget reset every cycle', async () => {
  await withRig('sr16', 880116, async (ctx) => {
    const { S, sub, pid, f } = ctx;
    const { sup } = await establish(ctx);
    const sessPath = sessionPathFor({ stateDir: S, identityHash: sub.identityHash });
    const sess0 = fs.readFileSync(sessPath);
    let boot = readTransport(S).lastBootId;
    for (let i = 1; i <= 3; i++) {
      await f.kill('kill');
      const fin = await sup.waitFor((s) => s.transportState === 'RECOVERED' && s.adapterBootId && s.adapterBootId !== boot, 30000);
      assert.ok(fin, `cycle ${i} recovered: ${JSON.stringify(readSup(S))}`);
      assert.equal(fin.currentTaskIdentity.identityHash, sub.identityHash, `cycle ${i}: same task`);
      assert.equal(fin.recoveryAttemptCount, 0, `cycle ${i}: bounded budget resets per outage`);
      boot = fin.adapterBootId;
    }
    assert.deepEqual(fs.readFileSync(sessPath), sess0, 'repeated recoveries NEVER mutate the session');
    assert.equal(execCount(S, sub.identityHash), 1, 'A5: one ExecutionRecord across all recoveries');
    assert.equal(readTransport(S).mutationOwner, ctx.lane, 'A6: owner stable across repeated recoveries');
    assert.ok(readTransport(S).restartCount >= 4, 'adapter boots counted (observability)');
    assert.equal(isAlive(pid), true, 'one executor through it all');
  });
});

// ============================================================ FSM unit matrix ===
const ID_X = { repo: 'a/b', issueNumber: 5, identityHash: 'hx', taskId: 't-x' };
const ID_Y = { repo: 'c/d', issueNumber: 9, identityHash: 'hy', taskId: 't-y' };
function seedTransport(S, { bootId, identity, ok = true, liveness = 'RUNNING', owner = 'lane-u', execPid = 4242, startTime = 99999, gateAt = null, reason = null }) {
  recordAdapterBoot({ stateDir: S, bootId });
  recordReattach({
    stateDir: S, bootId,
    result: ok
      ? { ok: true, currentTaskIdentity: identity, executionLiveness: liveness, humanGateState: gateAt ? 'WAITING' : 'NONE', mutationOwner: owner, execution: { pid: execPid, processStartTime: startTime }, task: { humanGate: gateAt ? { at: gateAt } : null } }
      : { ok: false, reason },
  });
}
function jsonResponse(status, body) { return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } }; }
function unitSup(name, script, policy = {}) {
  const S = laneStateDir(name);
  const clock = { t: 100000 };
  const acq = acquireSupervisorLock({ stateDir: S, bootId: 'unit-boot', pid: process.pid });
  assert.ok(acq.ok);
  const sup = createMcpSupervisor({
    serverName: NAME, controlUrl: 'http://127.0.0.1:59999', stateDir: S, bootId: 'unit-boot',
    now: () => clock.t, sleep: async (ms) => { clock.t += ms; },
    policy: { pollMs: 10, backoffBaseMs: 100, backoffCapMs: 400, maxAttempts: 3, healthTimeoutMs: 50, reattachTimeoutMs: 50, ...policy },
    fetchImpl: async (url, opts) => { clock.t += 20; return script(new URL(url), opts, clock, S); },
  });
  return { sup, S, clock };
}

test('U1 FSM: persistent transport failure -> exponential backoff -> attempt cap -> RECOVERY_FAILED (never unbounded)', async () => {
  const { sup, S } = unitSup('u1', async (u, o) => {
    if (o.method === 'POST') return jsonResponse(200, true);
    return jsonResponse(200, { [NAME]: { status: 'failed', error: 'Connection closed' } });
  });
  for (let i = 0; i < 40; i++) { await sup.runCycle(); const cur = readSup(S); if (cur && cur.transportState === 'RECOVERY_FAILED') break; }
  const s = readSup(S);
  assert.equal(s.transportState, 'RECOVERY_FAILED');
  assert.equal(s.recoveryAttemptCount, 3, 'capped at maxAttempts=3');
  assert.ok(['ATTEMPTS_EXHAUSTED', 'HEALTHCHECK_TIMEOUT'].includes(s.lastRecoveryResult.reason));
  assert.ok(!fs.existsSync(path.join(S, 'client-mcp', 'submissions')));
});

test('U2 FSM: respawned adapter reattaches a DIFFERENT identity -> RECOVERY_IDENTITY_MISMATCH fail-closed (never claims the foreign bind)', async () => {
  let phase = 0;
  const { sup, S } = unitSup('u2', async (u, o, _clock, stateDir) => {
    if (o.method === 'POST') { seedTransport(stateDir, { bootId: 'boot-2', identity: ID_Y }); phase = 1; return jsonResponse(200, true); }
    return jsonResponse(200, { [NAME]: { status: phase ? 'connected' : 'failed', error: 'Connection closed' } });
  });
  seedTransport(S, { bootId: 'boot-1', identity: ID_X });
  for (let i = 0; i < 40; i++) { const r = await sup.runCycle(); if (r.action === 'failed' || r.action === 'exhausted') break; }
  const s = readSup(S);
  assert.equal(s.transportState, 'RECOVERY_FAILED');
  assert.equal(s.lastRecoveryResult.reason, 'RECOVERY_IDENTITY_MISMATCH');
  assert.equal(s.currentTaskIdentity, null, 'a mismatched identity is never published as recovered');
});

test('U3 FSM: UNKNOWN liveness fails closed; GONE is accepted truthfully (same attempt)', async () => {
  let phase = 0;
  const a = unitSup('u3a', async (u, o, _c, stateDir) => {
    if (o.method === 'POST') { seedTransport(stateDir, { bootId: 'boot-2', identity: ID_X, liveness: 'UNKNOWN' }); phase = 1; return jsonResponse(200, true); }
    return jsonResponse(200, { [NAME]: { status: phase ? 'connected' : 'failed', error: 'Connection closed' } });
  });
  seedTransport(a.S, { bootId: 'boot-1', identity: ID_X });
  for (let i = 0; i < 40; i++) { const r = await a.sup.runCycle(); if (r.action === 'failed' || r.action === 'exhausted') break; }
  assert.equal(readSup(a.S).transportState, 'RECOVERY_FAILED');
  assert.equal(readSup(a.S).lastRecoveryResult.reason, 'EXECUTION_IDENTITY_UNKNOWN', 'no synthetic RUNNING, ever');
  phase = 0;
  const b = unitSup('u3b', async (u, o, _c, stateDir) => {
    if (o.method === 'POST') { seedTransport(stateDir, { bootId: 'boot-2', identity: ID_X, liveness: 'GONE' }); phase = 1; return jsonResponse(200, true); }
    return jsonResponse(200, { [NAME]: { status: phase ? 'connected' : 'failed', error: 'Connection closed' } });
  });
  seedTransport(b.S, { bootId: 'boot-1', identity: ID_X });
  await b.sup.runCycle();
  assert.equal(readSup(b.S).transportState, 'RECOVERED');
  assert.equal(readSup(b.S).executionLiveness, 'GONE', 'truth preserved; canonical reconcile owns the lifecycle');
});

test('U4 FSM: operator-disabled server is respected, never re-enabled, no retry loop', async () => {
  let posts = 0;
  const { sup, S } = unitSup('u4', async (u, o) => { if (o.method === 'POST') { posts += 1; return jsonResponse(200, true); } return jsonResponse(200, { [NAME]: { status: 'disabled' } }); });
  await sup.runCycle(); await sup.runCycle();
  const s = readSup(S);
  assert.equal(posts, 0, 'disabled is not treated as a failure to rebind over');
  assert.equal(s.transportState, 'CONNECTED');
  assert.equal(s.lastRecoveryResult.reason, 'MCP_DISABLED_BY_POLICY');
});

test('U5 policy: non-loopback control URL fails closed at construction (local transport only)', () => {
  assert.throws(() => createMcpSupervisor({ controlUrl: 'http://evil.example.com:8080', stateDir: TMP }), /LOOPBACK/);
});

test('U6/F2 FSM: pinned Human-Gate checkpoint must survive EXACTLY — X->null and X->Y fail closed, X->X passes', async () => {
  async function gateCase(gateAfter) {
    let phase = 0;
    const { sup, S } = unitSup(`u6-${String(gateAfter)}`, async (u, o, _c, stateDir) => {
      if (o.method === 'POST') {
        seedTransport(stateDir, { bootId: 'boot-2', identity: ID_X, liveness: 'RUNNING', gateAt: gateAfter });
        phase = 1;
        return jsonResponse(200, true);
      }
      return jsonResponse(200, { [NAME]: { status: phase ? 'connected' : 'failed', error: 'Connection closed' } });
    });
    seedTransport(S, { bootId: 'boot-1', identity: ID_X, gateAt: 'cp-X' });
    for (let i = 0; i < 40; i++) { const r = await sup.runCycle(); if (r && (r.action === 'failed' || r.action === 'exhausted' || r.action === 'recovered')) break; }
    return readSup(S);
  }
  const lost = await gateCase(null);
  assert.equal(lost.transportState, 'RECOVERY_FAILED', 'F2: a vanished checkpoint must never pass as the same wait');
  assert.equal(lost.lastRecoveryResult.reason, 'RECOVERY_IDENTITY_MISMATCH');
  assert.equal(lost.lastRecoveryResult.detail, 'humanGateAt');
  const moved = await gateCase('cp-Y');
  assert.equal(moved.transportState, 'RECOVERY_FAILED', 'F2: a different checkpoint is not the pinned wait');
  assert.equal(moved.lastRecoveryResult.reason, 'RECOVERY_IDENTITY_MISMATCH');
  assert.equal(moved.lastRecoveryResult.detail, 'humanGateAt');
  const same = await gateCase('cp-X');
  assert.equal(same.transportState, 'RECOVERED', 'X->X passes (the canonical wait itself may later be answered by human paths, never by the supervisor)');
  assert.equal(same.humanGateState, 'WAITING');
});
