#!/usr/bin/env node
// executor-liveness-transport-independence.test.mjs — Issue #180 process-backed
// acceptance (A1..A8): executor liveness must NOT depend on MCP broker stdio
// transport lifetime.
//
// Production model that this mirrors: runtime-sandbox buildOpenCodeConfig wires
// the interactive executor (OpenCode/Cline) to spawn
// `node packages/runtime-sandbox/mcp-server.mjs` as its MCP STDIO CHILD. The
// broker's OS parent process IS the interactive executor process. The fix binds
// the activity lease to THAT parent identity (PID + immutable Win32
// PROCESS_START_TIME) and gates retire on provenExecutorIdentityGone; a
// transport EOF / SIGTERM / SIGINT / broker exit alone cannot retire the lease.
//
// Design: a tiny HOST wrapper (spawned by the test as a real OS child) uses the
// SAME `resolveExecutorHostIdentity` from mcp-server.mjs + the SAME
// `createExecutorLiveness` from activity-lease.mjs and the SAME shutdown gate
// that main() installs. This proves the PRODUCTION code path end-to-end against
// real OS processes on Windows without requiring a full session/taskStart
// bootstrap (the primitives are what #180 changes).
//
// Every spawned OS process is tracked and force-killed in a finally so a failing
// assertion cannot leak a child or hang the canonical runner. Non-Windows:
// PROCESS_START_TIME cannot be probed; the OS-injected primitives are still
// exercised (see A4), and process-backed scenarios short-circuit cleanly.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';

import { identityHash } from '../packages/workspace/workspace.mjs';
import {
  createExecutorLiveness, publishExecutorLease, provenExecutorIdentityGone,
  activityLeasePathFor, ACTIVITY_LEASE_SUBDIR,
} from '../packages/runtime-sandbox/activity-lease.mjs';
import { resolveExecutorHostIdentity } from '../packages/runtime-sandbox/mcp-server.mjs';
import { scanCanonicalActivity, createIdleSupervisor, IDLE_SUPERVISOR_SCHEMA_VERSION } from '../packages/idle-supervisor/idle-supervisor.mjs';
import { classifyExecutor, reconcileExecutorLiveness } from '../packages/executor-launcher/executor-reconcile.mjs';
import { isAlive, readWin32ProcessStartTime } from '../packages/temp-hygiene/temp-hygiene.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const DAY0 = new Date(2026, 8, 10);
const MIN = 60 * 1000;
const at = (h, m, s = 0) => { const d = new Date(DAY0); d.setHours(h, m, s, 0); return d; };

const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-180-'));

// The WRAP script is a REAL OS child that stands in for mcp-server.mjs main():
// it calls the SAME resolveExecutorHostIdentity + createExecutorLiveness +
// isProvenGone-gated retire path that production wires.
const WRAP = path.join(TMP, 'wrap.cjs');
writeFileSync(WRAP, [
  "const path = require('node:path');",
  "const PKG = process.env.SOC_TEST_PKG;",
  "(async () => {",
  "  const u = (p) => 'file:///' + path.resolve(PKG, p).replace(/\\\\/g, '/');",
  "  const { createExecutorLiveness } = await import(u('runtime-sandbox/activity-lease.mjs'));",
  "  const { resolveExecutorHostIdentity } = await import(u('runtime-sandbox/mcp-server.mjs'));",
  "  const host = resolveExecutorHostIdentity();",
  "  const lv = createExecutorLiveness({ stateDir: process.env.SOC_TEST_STATE_DIR, identityHash: process.env.SOC_TEST_IDENTITY_HASH, repo: process.env.SOC_TEST_REPO, issueNumber: Number(process.env.SOC_TEST_ISSUE), pid: host.pid, processStartTime: host.processStartTime });",
  "  const r = lv.start();",
  "  process.stdout.write(JSON.stringify({ evt:'wrap-bind', ok:!!(r&&r.ok), reason:(r&&r.reason)||null, boundTo:host.boundTo, leasePid:host.pid, hostPid:process.pid }) + '\\n');",
  "  let retired = false;",
  "  function onShutdown(fast){ if (retired) return; let p; try { p = lv.isProvenGone(fast ? { deps: { readStartTime: () => null } } : {}); } catch { p = { provenGone:false }; } if (!p.provenGone) return; retired = true; try { lv.retire(); } catch {} }",
  "  process.stdin.on('end', () => { onShutdown(false); process.exit(0); });",
  "  process.on('SIGTERM', () => { onShutdown(false); process.exit(0); });",
  "  process.stdin.resume();",
  "  setInterval(() => {}, 30000);",
  "})().catch((e)=>{ process.stderr.write(String((e && e.stack) || e)); process.exit(2); });",
].join('\n'), 'utf8');

// The HOST is the interactive-executor stand-in. It spawns the WRAP as its MCP
// stdio child (WRAP's ppid == HOST pid == the interactive executor OS process).
// The test drives WRAP's transport lifecycle WITHOUT terminating HOST (A1),
// respawns a fresh WRAP under the SAME HOST (A2), terminates HOST (A3/A8),
// SIGKILLs WRAP (A5/A6).
const HOST = path.join(TMP, 'host.cjs');
writeFileSync(HOST, [
  "const { spawn } = require('node:child_process');",
  "let child = null;",
  "function spawnWrap() {",
  "  const c = spawn(process.execPath, [process.env.__WRAP], { stdio: ['pipe','pipe','pipe'], env: process.env, windowsHide: true });",
  "  c.stderr.on('data', (d) => process.stderr.write(String(d)));",
  "  c.stdout.on('data', (d) => process.stdout.write(String(d)));",
  "  c.on('exit', (code, sig) => { process.stdout.write(JSON.stringify({ evt:'wrap-exit', code, sig, wrapPid: c.pid }) + '\\n'); });",
  "  return c;",
  "}",
  "child = spawnWrap();",
  "process.stdin.setEncoding('utf8');",
  "let buf = '';",
  "process.stdin.on('data', (chunk) => {",
  "  buf += chunk; const lines = buf.split('\\n'); buf = lines.pop();",
  "  for (const raw of lines) { const t = raw.trim(); if (!t) continue;",
  "    let m; try { m = JSON.parse(t); } catch { continue; }",
  "    if (m.cmd === 'close-wrap-stdin') { if (child) try { child.stdin.end(); } catch {} }",
  "    else if (m.cmd === 'kill-wrap') { if (child) { try { child.kill('SIGKILL'); } catch {} } }",
  "    else if (m.cmd === 'respawn-wrap') { try { if (child) child.stdin.end(); } catch {} child = spawnWrap(); }",
  "    else if (m.cmd === 'host-exit') { process.exit(0); }",
  "  }",
  "});",
  "process.on('SIGTERM', () => process.exit(0));",
  "setInterval(() => {}, 30000);",
].join('\n'), 'utf8');

function startHost({ stateDir, repo, issueNumber }) {
  const env = {
    ...process.env,
    __WRAP: WRAP,
    SOC_TEST_PKG: path.join(REPO_ROOT, 'packages'),
    SOC_TEST_STATE_DIR: stateDir,
    SOC_TEST_IDENTITY_HASH: identityHash({ repo, issueNumber }),
    SOC_TEST_REPO: repo,
    SOC_TEST_ISSUE: String(issueNumber),
  };
  const proc = spawn(process.execPath, [HOST], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
  let outBuf = ''; const events = [];
  proc.stdout.on('data', (c) => { outBuf += c; const lines = outBuf.split('\n'); outBuf = lines.pop(); for (const l of lines) { const t = l.trim(); if (!t) continue; try { events.push(JSON.parse(t)); } catch { /* ignore */ } } });
  let errBuf = ''; proc.stderr.on('data', (d) => { errBuf += d; });
  const send = (obj) => { try { proc.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* gone */ } };
  async function waitForEvt(pred, timeoutMs = 25000) { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { const m = events.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 50)); } return null; }
  async function waitForStderr(re, timeoutMs = 25000) { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { if (re.test(errBuf)) return { match: true, err: errBuf }; await new Promise((r) => setTimeout(r, 50)); } return { match: false, err: errBuf }; }
  const exited = new Promise((r) => proc.on('exit', (code, sig) => r({ code, sig })));
  return { proc, pid: proc.pid, send, events, waitForEvt, waitForStderr, stderr: () => errBuf, exited, kill: () => { try { proc.kill('SIGKILL'); } catch {} } };
}

async function untilFile(p, present, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fs.existsSync(p) === present) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const CONFIG = {
  schemaVersion: IDLE_SUPERVISOR_SCHEMA_VERSION, enabled: true,
  dayGraceMs: 20 * MIN, nightGraceMs: 10 * MIN, nightStart: { h: 0, m: 0 }, nightEnd: { h: 6, m: 0 },
  pollSec: 30, allowRealHibernate: false, stateDir: null,
};

let counter = 0;
function mkState() { const d = path.join(TMP, `s-${++counter}`); mkdirSync(path.join(d, 'sessions'), { recursive: true }); mkdirSync(path.join(d, ACTIVITY_LEASE_SUBDIR), { recursive: true }); return d; }
function leasePathFor(stateDir, ihv) { return path.join(stateDir, ACTIVITY_LEASE_SUBDIR, `${ihv}.json`); }
function scanReal(stateDir) {
  return scanCanonicalActivity({
    stateDir, clock: () => at(12, 0).getTime(),
    isAlive, readStartTime: (p) => readWin32ProcessStartTime(p), bootId: null,
  });
}

// ---- A1 ------------------------------------------------------------------
test('A1 PROCESS-BACKED: live interactive executor + broker transport EOF -> lease survives; supervisor still LIVE; no ExecutionRecord', async () => {
  if (!IS_WIN) { assert.ok(true, 'non-Windows: PROCESS_START_TIME probe unverifiable'); return; }
  const S = mkState();
  const ihv = identityHash({ repo: 'duongpdddic-droid/disposable-180-a1', issueNumber: 180001 });
  const h = startHost({ stateDir: S, repo: 'duongpdddic-droid/disposable-180-a1', issueNumber: 180001 });
  try {
    const bind = await h.waitForEvt((e) => e.evt === 'wrap-bind');
    assert.ok(bind, 'broker bind event received');
    assert.equal(bind.ok, true, JSON.stringify(bind));
    assert.equal(bind.boundTo, 'parent', 'A1: identity bound to the executor host (parent), not the broker');
    assert.equal(bind.leasePid, h.pid, 'A1: lease pid == the HOST OS process pid');
    const p = leasePathFor(S, ihv);
    assert.ok(await untilFile(p, true), 'A1: lease file exists after bind');
    const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(rec.pid, h.pid);
    assert.ok(rec.processStartTime, 'A1: lease has an immutable PROCESS_START_TIME');
    assert.ok(!fs.existsSync(path.join(S, 'executions')), 'A1: interactive executor has no ExecutionRecord (the exact gap class)');
    // Drive transport EOF WITHOUT killing the host.
    h.send({ cmd: 'close-wrap-stdin' });
    await h.waitForEvt((e) => e.evt === 'wrap-exit', 15000);
    // The broker ran its proven-gone gate on EOF; because the executor HOST (its
    // OS parent) is still alive, the gate refuses to retire => the lease is
    // retained. Verify the SAME gate the production broker used:
    const gate = createExecutorLiveness({ stateDir: S, identityHash: ihv, pid: h.pid, processStartTime: rec.processStartTime }).isProvenGone();
    assert.equal(gate.provenGone, false, 'A1: a live executor identity is NOT positively gone -> transport EOF cannot retire it');
    assert.equal(gate.reason, 'EXECUTOR_ALIVE');
    assert.ok(fs.existsSync(p), 'A1: transport EOF must NOT remove the lease (identity is bound to the parent)');
    // Clean transport shutdown stays stderr-silent (#172 invariant preserved).
    assert.ok(!/MCP_DISCONNECTED/.test(h.stderr()), 'A1: shutdown is stderr-silent (no false-death log)');
    const a = scanReal(S);
    assert.ok(a.liveExecutors >= 1, `A1: supervisor still counts >=1 live executor (live=${a.liveExecutors} unknown=${JSON.stringify(a.unknown)})`);
    assert.equal(a.known, true, 'A1: scan is authoritative');
    const sup = createIdleSupervisor({ config: CONFIG, stateDir: S });
    assert.equal(sup.tick({ activity: a, userIdleMs: 60 * MIN, now: at(12, 0).getTime() }).state, 'BUSY', 'A1: hibernate stays blocked purely from executor liveness');
  } finally { h.kill(); }
});

// ---- A2 ------------------------------------------------------------------
test('A2 PROCESS-BACKED: same-executor reconnect proves identity via PID + PROCESS_START_TIME; no duplicate lease owner; activity resumes', async () => {
  if (!IS_WIN) { assert.ok(true, 'non-Windows: PROCESS_START_TIME probe unverifiable'); return; }
  const S = mkState();
  const ihv = identityHash({ repo: 'duongpdddic-droid/disposable-180-a2', issueNumber: 180002 });
  const h = startHost({ stateDir: S, repo: 'duongpdddic-droid/disposable-180-a2', issueNumber: 180002 });
  try {
    const b1 = await h.waitForEvt((e) => e.evt === 'wrap-bind' && e.ok === true);
    assert.ok(b1);
    const p = leasePathFor(S, ihv);
    await untilFile(p, true);
    const rec1 = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(rec1.pid, h.pid);
    h.send({ cmd: 'close-wrap-stdin' });
    await h.waitForEvt((e) => e.evt === 'wrap-exit', 15000);
    assert.ok(fs.existsSync(p), 'A2: pre-reconnect lease still present');
    // Fresh broker under the SAME host: ppid unchanged => sameIncarnation=true
    // => publish refreshes the existing lease (no second owner).
    h.send({ cmd: 'respawn-wrap' });
    const b2 = await h.waitForEvt((e) => e.evt === 'wrap-bind' && e.ok === true && e.leasePid === h.pid);
    assert.ok(b2, 'A2: reconnect bind under same host pid');
    assert.equal(b2.boundTo, 'parent', 'A2: reconnect also binds to parent (same host)');
    const rec2 = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(rec2.pid, rec1.pid, 'A2: reconnect keeps SAME pid');
    assert.equal(rec2.processStartTime, rec1.processStartTime, 'A2: same PROCESS_START_TIME (Win32 immutable) proves same executor identity');
    // Exactly ONE lease file for this identity — no second mutation owner.
    const jsons = fs.readdirSync(path.join(S, ACTIVITY_LEASE_SUBDIR)).filter((n) => n.endsWith('.json'));
    assert.equal(jsons.length, 1, 'A2: reconnect must not mint a second lease owner');
    // Activity resumes canonically via the SAME liveness primitive.
    const lv = createExecutorLiveness({ stateDir: S, identityHash: ihv, pid: h.pid, processStartTime: rec2.processStartTime });
    const hb = lv.heartbeat();
    assert.ok(hb.ok, 'A2: heartbeat on the reconnect owner succeeds');
  } finally { h.kill(); }
});

// ---- A3 ------------------------------------------------------------------
test('A3 PROCESS-BACKED: true executor host exit -> no stale LIVE; reconcile retires the lease (idempotent)', async () => {
  if (!IS_WIN) { assert.ok(true, 'non-Windows: PROCESS_START_TIME probe unverifiable'); return; }
  const S = mkState();
  const ihv = identityHash({ repo: 'duongpdddic-droid/disposable-180-a3', issueNumber: 180003 });
  const h = startHost({ stateDir: S, repo: 'duongpdddic-droid/disposable-180-a3', issueNumber: 180003 });
  let recorded = null;
  try {
    const b = await h.waitForEvt((e) => e.evt === 'wrap-bind' && e.ok === true);
    assert.ok(b);
    const p = leasePathFor(S, ihv);
    await untilFile(p, true);
    recorded = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(recorded.pid, h.pid);
    // Terminate the HOST (the interactive executor OS process). WRAP's stdin
    // sees EOF and runs its proven-gone gate; whether it can unlink before the
    // OS finishes tearing down HOST is a benign race. The AUTHORITATIVE safety
    // property is that the supervisor's identity reader proves the executor GONE
    // (no stale LIVE), and that a reconcile actor can retire the inert file.
    h.send({ cmd: 'host-exit' });
    await h.exited;
  } finally { h.kill(); }
  await new Promise((r) => setTimeout(r, 500)); // let the OS fully retire the host pid
  assert.ok(!isAlive(h.pid), 'A3 precondition: host OS pid is gone');
  const p = leasePathFor(S, ihv);
  // Case 1: the broker's own exit gate already retired it. Case 2: the file
  // lingered; a canonical reconcile (identity-gated retire) removes it. Both are
  // correct outcomes of "true exit must eventually clean up".
  if (fs.existsSync(p)) {
    const gone = provenExecutorIdentityGone({ pid: recorded.pid, processStartTime: recorded.processStartTime });
    assert.equal(gone.provenGone, true, 'A3: recorded executor identity is positively gone after host exit');
    const ret = createExecutorLiveness({ stateDir: S, identityHash: ihv, pid: recorded.pid, processStartTime: recorded.processStartTime }).retire();
    assert.equal(ret.released, true, 'A3: reconcile retire removes the inert lease');
  }
  assert.ok(!fs.existsSync(p), 'A3: lease is gone after true exit (via broker gate or reconcile)');
  const a = scanReal(S);
  assert.equal(a.liveExecutors, 0, 'A3: no live executor after true host exit');
  assert.equal(a.known, true, 'A3: identity reader settles to terminal (authoritative, not ambiguous)');
  const sup = createIdleSupervisor({ config: CONFIG, stateDir: S });
  const st = sup.tick({ activity: a, userIdleMs: 60 * MIN, now: at(12, 0).getTime() }).state;
  assert.notEqual(st, 'BUSY', 'A3: no stale LIVE keeps the machine BUSY after true exit');
});

// ---- A4 ------------------------------------------------------------------
test('A4 PROCESS-BACKED: PID reuse / stale incarnation -> REUSED classification; canMutate=false; new process cannot attach to old lease', () => {
  // Uses INJECTED start-time probes to deterministically model PID reuse on any
  // OS. Fabricating a real Win32 pid-recycle race is non-deterministic; the
  // existing #160/#172 tests (executor-reconcile, executor-liveness-lease
  // R-F1E) also use injected probes and are the canonical primitive contract.
  const stateDir = mkState();
  const ihv = identityHash({ repo: 'duongpdddic-droid/disposable-180-a4', issueNumber: 180004 });
  const ORIG_START = 134337708316584740;
  const NEW_START = ORIG_START + 987654321;
  publishExecutorLease({ stateDir, identity: { identityHash: ihv, pid: 42424, processStartTime: ORIG_START }, deps: { isAlive: () => true, readStartTime: (p) => ({ pid: p, processStartTime: ORIG_START }) } });
  const path = activityLeasePathFor({ stateDir, identityHash: ihv });
  assert.ok(fs.existsSync(path), 'A4 precondition: lease exists for original incarnation');

  const proven = provenExecutorIdentityGone({ pid: 42424, processStartTime: ORIG_START, deps: { isAlive: () => true, readStartTime: (p) => ({ pid: p, processStartTime: NEW_START }) } });
  assert.equal(proven.provenGone, true, 'A4: pid reuse IS positively gone for the recorded incarnation');
  assert.equal(proven.foreign, true, 'A4: reason is PID_REUSED_FOREIGN');
  assert.equal(proven.reason, 'PID_REUSED_FOREIGN');

  const lv = createExecutorLiveness({ stateDir, identityHash: ihv, pid: 42424, processStartTime: ORIG_START, deps: { isAlive: () => true, readStartTime: (p) => ({ pid: p, processStartTime: NEW_START }) } });
  const pg = lv.isProvenGone();
  assert.equal(pg.provenGone, true, 'A4: broker exit-time gate sees foreign-reused pid as proven gone');
  const ret = lv.retire();
  assert.equal(ret.released, true, 'A4: proven-gone gate permits retire of the stale lease');
  assert.equal(fs.existsSync(path), false, 'A4: stale lease removed after proven-gone proof');

  const a = scanCanonicalActivity({ stateDir, clock: () => at(12, 0).getTime(), isAlive: () => true, readStartTime: (p) => ({ pid: p, processStartTime: NEW_START }), bootId: null });
  assert.equal(a.liveExecutors, 0, 'A4: no live executor counted from a reused/stale identity');

  // Record-shaped identity via the canonical #160 primitive (must remain fail-closed
  // regardless of the lease).
  const bad = reconcileExecutorLiveness({ pid: 42424, processStartTime: ORIG_START }, { isAlive: () => true, readStartTime: (p) => ({ pid: p, processStartTime: NEW_START }) });
  assert.equal(bad.liveness, 'PID_REUSED', 'A4: reconcileExecutorLiveness classifies as PID_REUSED');
  assert.equal(bad.identityProven, false);
  assert.equal(classifyExecutor({ record: { pid: 42424, processStartTime: ORIG_START }, liveness: bad.liveness }).canMutate, false, 'A4: PID-reused identity fails closed for mutation (#160 invariant preserved)');

  // No-clobber: a NEW live incarnation with a DIFFERENT identity cannot attach
  // to the current owner's lease.
  publishExecutorLease({ stateDir, identity: { identityHash: ihv, pid: 42424, processStartTime: ORIG_START }, deps: { isAlive: () => true, readStartTime: (p) => ({ pid: p, processStartTime: ORIG_START }) } });
  const clobber = publishExecutorLease({ stateDir, identity: { identityHash: ihv, pid: 42425, processStartTime: NEW_START }, deps: { isAlive: (p) => p === 42424 || p === 42425, readStartTime: (p) => ({ pid: p, processStartTime: p === 42425 ? NEW_START : ORIG_START }) } });
  assert.equal(clobber.ok, false, 'A4: a different LIVE incarnation cannot clobber the current owner');
  assert.equal(clobber.reason, 'LEASE_HELD_BY_LIVE_INCARNATION');
  // But after proven-gone, a NEW incarnation CAN attach.
  const gone = createExecutorLiveness({ stateDir, identityHash: ihv, pid: 42424, processStartTime: ORIG_START, deps: { isAlive: () => true, readStartTime: (p) => ({ pid: p, processStartTime: NEW_START }) } });
  assert.equal(gone.isProvenGone().provenGone, true);
  gone.retire();
  const attach = publishExecutorLease({ stateDir, identity: { identityHash: ihv, pid: 42425, processStartTime: NEW_START }, deps: { isAlive: (p) => p === 42425, readStartTime: (p) => ({ pid: p, processStartTime: NEW_START }) } });
  assert.ok(attach.ok, 'A4: after proven-gone retire of the OLD incarnation, the new owner may publish cleanly');
});

// ---- A5 ------------------------------------------------------------------
test('A5 PROCESS-BACKED: broker dies unexpectedly while executor host lives -> lifecycle remains observable', async () => {
  if (!IS_WIN) { assert.ok(true, 'non-Windows: PROCESS_START_TIME probe unverifiable'); return; }
  const S = mkState();
  const ihv = identityHash({ repo: 'duongpdddic-droid/disposable-180-a5', issueNumber: 180005 });
  const h = startHost({ stateDir: S, repo: 'duongpdddic-droid/disposable-180-a5', issueNumber: 180005 });
  try {
    const b = await h.waitForEvt((e) => e.evt === 'wrap-bind' && e.ok === true);
    assert.ok(b);
    const p = leasePathFor(S, ihv);
    await untilFile(p, true);
    // SIGKILL the broker child (bypasses every handler).
    h.send({ cmd: 'kill-wrap' });
    await h.waitForEvt((e) => e.evt === 'wrap-exit' && e.sig === 'SIGKILL', 15000);
    assert.ok(fs.existsSync(p), 'A5: SIGKILLed broker did not run handlers; lease file is intact');
    const a = scanReal(S);
    assert.ok(a.liveExecutors >= 1, 'A5: supervisor still sees the executor host as LIVE after broker loss');
    const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
    const cur = readWin32ProcessStartTime(h.pid);
    assert.ok(cur && cur.processStartTime === rec.processStartTime, 'A5: host PROCESS_START_TIME unchanged after broker death');
    // Reconnect under the SAME host (identity unchanged) — activity resumes.
    h.send({ cmd: 'respawn-wrap' });
    const b2 = await h.waitForEvt((e) => e.evt === 'wrap-bind' && e.ok === true);
    assert.ok(b2, 'A5: recovery via reconnect under same identity succeeds');
    assert.equal(b2.leasePid, h.pid);
  } finally { h.kill(); }
});

// ---- A6 ------------------------------------------------------------------
test('A6 PROCESS-BACKED: broker dies AND executor dies -> reconcile eventually terminal; cleanup safe and idempotent', async () => {
  if (!IS_WIN) { assert.ok(true, 'non-Windows: PROCESS_START_TIME probe unverifiable'); return; }
  const S = mkState();
  const ihv = identityHash({ repo: 'duongpdddic-droid/disposable-180-a6', issueNumber: 180006 });
  const h = startHost({ stateDir: S, repo: 'duongpdddic-droid/disposable-180-a6', issueNumber: 180006 });
  let recorded = null;
  try {
    const b = await h.waitForEvt((e) => e.evt === 'wrap-bind' && e.ok === true);
    assert.ok(b);
    const p = leasePathFor(S, ihv);
    await untilFile(p, true);
    recorded = JSON.parse(fs.readFileSync(p, 'utf8'));
    h.send({ cmd: 'kill-wrap' });
    await h.waitForEvt((e) => e.evt === 'wrap-exit' && e.sig === 'SIGKILL', 15000);
    h.send({ cmd: 'host-exit' });
    await h.exited;
  } finally { h.kill(); }
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!isAlive(h.pid), 'A6 precondition: host OS pid gone');
  // Both broker (SIGKILLed -> no handler) and executor died, so the file
  // physically lingers. The supervisor's identity reader must classify it
  // terminal (not trusted, no deny). Idempotence: repeated scans converge.
  const p = leasePathFor(S, ihv);
  const a1 = scanReal(S);
  const a2 = scanReal(S);
  assert.equal(a1.liveExecutors, 0, 'A6: no live executor after both broker and host die (scan1)');
  assert.equal(a2.liveExecutors, 0, 'A6: same result on rescan (idempotent)');
  assert.equal(a1.known, true, 'A6: identity reader settles to authoritative (not ambiguous)');
  // A new same-identity launch reclaims the inert file cleanly.
  const p2 = publishExecutorLease({ stateDir: S, identity: { identityHash: ihv, pid: process.pid, processStartTime: (readWin32ProcessStartTime(process.pid) || {}).processStartTime } });
  assert.ok(p2.ok, 'A6: fresh same-identity launch overwrites the inert file cleanly');
  assert.ok(fs.existsSync(p));
  // Idempotent cleanup through the primitive: retire once releases, second call
  // sees LEASE_ABSENT and reports released=false (safe).
  const myStart = (readWin32ProcessStartTime(process.pid) || {}).processStartTime;
  const r1 = createExecutorLiveness({ stateDir: S, identityHash: ihv, pid: process.pid, processStartTime: myStart }).retire();
  assert.equal(r1.released, true);
  const r2 = createExecutorLiveness({ stateDir: S, identityHash: ihv, pid: process.pid, processStartTime: myStart }).retire();
  assert.equal(r2.released, false);
  assert.equal(r2.reason, 'LEASE_ABSENT');
});


// ---- A7 ------------------------------------------------------------------
test('A7 PROCESS-BACKED: record-backed ExecutionRecord path is unaffected by the interactive-only fix', async () => {
  if (!IS_WIN) { assert.ok(true, 'non-Windows: PROCESS_START_TIME probe unverifiable'); return; }
  const S = mkState();
  const ihv = identityHash({ repo: 'duongpdddic-droid/disposable-180-a7', issueNumber: 180007 });
  const h = startHost({ stateDir: S, repo: 'duongpdddic-droid/disposable-180-a7', issueNumber: 180007 });
  try {
    const b = await h.waitForEvt((e) => e.evt === 'wrap-bind' && e.ok === true);
    assert.ok(b);
    const p = leasePathFor(S, ihv);
    await untilFile(p, true);
    // Reconcile the HOST pid via the canonical ExecutionRecord-style primitive
    // (which the record-backed production path uses, e.g. F2 in
    // client-mcp-process-lifecycle.test.mjs). The lease identity does NOT
    // change this decision — record-backed path remains authoritative.
    const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
    const rr = reconcileExecutorLiveness({ pid: rec.pid, processStartTime: rec.processStartTime }, { isAlive, readStartTime: (pp) => readWin32ProcessStartTime(pp) });
    assert.equal(rr.liveness, 'RUNNING', 'A7: ExecutionRecord-style identity check unchanged (#160 preserved)');
    assert.equal(rr.identityProven, true);
    // A stale/PID-reused ExecutionRecord-shaped record STILL fails closed
    // independent of the lease.
    const bad = reconcileExecutorLiveness({ pid: rec.pid, processStartTime: rec.processStartTime + 12345 }, { isAlive, readStartTime: (pp) => readWin32ProcessStartTime(pp) });
    assert.equal(bad.liveness, 'PID_REUSED');
    assert.equal(bad.identityProven, false);
    assert.equal(classifyExecutor({ record: { pid: rec.pid, processStartTime: rec.processStartTime + 12345 }, liveness: bad.liveness }).canMutate, false);
  } finally { h.kill(); }
});

// ---- A8 ------------------------------------------------------------------
test('A8 PROCESS-BACKED: idle-supervisor integration — LIVE lease blocks hibernate; proven-gone does not block after identity reconcile', async () => {
  if (!IS_WIN) { assert.ok(true, 'non-Windows: PROCESS_START_TIME probe unverifiable'); return; }
  const S = mkState();
  const ihvLive = identityHash({ repo: 'duongpdddic-droid/disposable-180-a8-live', issueNumber: 180008 });
  const ihvGone = identityHash({ repo: 'duongpdddic-droid/disposable-180-a8-gone', issueNumber: 180010 });
  const h = startHost({ stateDir: S, repo: 'duongpdddic-droid/disposable-180-a8-live', issueNumber: 180008 });
  try {
    const b = await h.waitForEvt((e) => e.evt === 'wrap-bind' && e.ok === true);
    assert.ok(b);
    await untilFile(leasePathFor(S, ihvLive), true);
    // Synthetic proven-gone lease (a pid that clearly does not exist).
    publishExecutorLease({ stateDir: S, identity: { identityHash: ihvGone, pid: 99997, processStartTime: 54321 } });
    const a = scanReal(S);
    assert.ok(a.liveExecutors >= 1, 'A8: the real live host lease is counted');
    assert.equal(a.known, true, 'A8: proven-gone lease does NOT push the scan to UNKNOWN');
    const sup = createIdleSupervisor({ config: CONFIG, stateDir: S });
    assert.equal(sup.tick({ activity: a, userIdleMs: 60 * MIN, now: at(12, 0).getTime() }).state, 'BUSY', 'A8: live executor blocks idle/hibernate');
    // Now simulate true-gone (kill host) and rescan.
    h.send({ cmd: 'host-exit' });
    await h.exited;
    await new Promise((r) => setTimeout(r, 400));
    const a2 = scanReal(S);
    assert.equal(a2.liveExecutors, 0, 'A8: after true-gone reconcile no live executor counted');
    const st = sup.tick({ activity: a2, userIdleMs: 60 * MIN, now: at(12, 0).getTime() }).state;
    assert.notEqual(st, 'BUSY', 'A8: proven-gone does NOT block idle');
  } finally { h.kill(); }
});

// Deterministic sanity that the exported helper itself composes correctly with
// the same primitives mcp-server main() uses. Windows-only (PROCESS_START_TIME).
test('S0 UNIT: resolveExecutorHostIdentity binds parent identity when probe succeeds and falls back to self otherwise', () => {
  const okHost = resolveExecutorHostIdentity({ ppid: 4242, selfPid: 9999, readStartTime: (p) => (p === 4242 ? { pid: p, processStartTime: 111111 } : { pid: p, processStartTime: 222222 }) });
  assert.equal(okHost.boundTo, 'parent');
  assert.equal(okHost.pid, 4242);
  assert.equal(okHost.processStartTime, 111111);
  const failParent = resolveExecutorHostIdentity({ ppid: 4242, selfPid: 9999, readStartTime: (p) => (p === 4242 ? null : { pid: p, processStartTime: 222222 }) });
  assert.equal(failParent.boundTo, 'self_fallback');
  assert.equal(failParent.pid, 9999);
  const noPpid = resolveExecutorHostIdentity({ ppid: 0, selfPid: 9999, readStartTime: (p) => ({ pid: p, processStartTime: 222222 }) });
  assert.equal(noPpid.boundTo, 'self_fallback');
});
