#!/usr/bin/env node
// client-mcp-process-lifecycle.test.mjs — PROCESS-BACKED proof for the post-#175
// client model, with OpenCode/Cline as operator UI/client but NOT lifecycle
// authority. It complements tests/client-mcp.test.mjs (which proves the control
// surface LOGIC in-process) with REAL operating-system processes and the REAL
// production executor route (F1 rework):
//
//   soc.submit_goal -> canonical admission (taskStart) -> the PRODUCTION route
//   seam (createCanonicalRouteExecutor) -> executor-launcher.startExecution ->
//   a REAL detached executor OS process + a canonical ExecutionRecord and the
//   executionMode='executor' bind BOTH created by startExecution (never by this
//   test) -> client death (a real client-mcp OS process killed) -> executor
//   survives -> a FRESH client-mcp OS process reconnects to the SAME
//   task/session/identity/owner/execution/PID -> no duplicate execution/owner.
//
// The deterministic executor substitutes only the (absent) opencode binary via
// startExecution's OWN sanctioned dependency-injection points (spawn /
// resolveExecutable / preflight / verifyAuthority), exactly as
// tests/executor-launcher.test.mjs does — the launched child is a real OS process,
// and the ExecutionRecord + session bind are written by production code. This test
// does NOT fabricate an ExecutionRecord and does NOT set executionMode manually.
//
// F2 (transport/liveness coupling): with a production-created ExecutionRecord the
// authoritative liveness (reconcileExecutorLiveness: PID + immutable Win32
// PROCESS_START_TIME) is NOT removed by an executor-facing broker transport EOF
// (retireExecutorLease); a true executor exit is reconciled to terminal by
// production; and a stale / PID-reused identity fails closed. The residual
// interactive-executor (no ExecutionRecord) lease gap is characterized honestly
// as a known limitation (see the PR + follow-up), not claimed PASS.
//
// Every spawned OS process is tracked and force-killed in a finally so a failing
// assertion can never leak a child or hang the canonical runner (no per-test
// timeout is imposed). No gh, no network, no product-repo mutation.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';

import { identityHash } from '../packages/workspace/workspace.mjs';
import {
  sessionPathFor, readSessionRecord, taskRequestHumanGate, HUMAN_GATE_STATES,
} from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { publishExecutorLease, retireExecutorLease } from '../packages/runtime-sandbox/activity-lease.mjs';
import { readExecutionRecord, executionRecordPath, executionEventsPath, readActivityTail } from '../packages/executor-launcher/executor-launcher.mjs';
import { reconcileExecutorLiveness, classifyExecutor } from '../packages/executor-launcher/executor-reconcile.mjs';
import { isAlive, readWin32ProcessStartTime } from '../packages/temp-hygiene/temp-hygiene.mjs';
import { createClientControl, createCanonicalRouteExecutor } from '../packages/client-mcp/client-control.mjs';
import { createClientMcpServer } from '../packages/client-mcp/client-mcp.mjs';

const SERVER = fileURLToPath(new URL('../packages/client-mcp/client-mcp.mjs', import.meta.url));
const IS_WIN = process.platform === 'win32';
const TERMINAL = ['COMPLETED', 'FAILED', 'BLOCKED'];
const EXEC_TERMINAL = ['EXITED', 'FAILED', 'STOPPED', 'INTERRUPTED'];

const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-175-proc-'));
mkdirSync(path.join(TMP, 'wt'), { recursive: true });

// ---- deterministic REAL executor process (the opencode stand-in) ---------------
// Emits NDJSON "work" to stdout (which startExecution's passthrough records as
// canonical activity) and stays alive until killed or until its timer fires.
const STUB = path.join(TMP, 'executor-stub.mjs');
writeFileSync(STUB, [
  "const ms = Number(process.env.__STUB_MS || 20000);",
  "let n = 0; const tick = () => process.stdout.write(JSON.stringify({ type: 'text', part: { text: 'executor step ' + (++n) }, t: Date.now() }) + '\\n');",
  "tick(); const iv = setInterval(tick, 150);",
  "setTimeout(() => { clearInterval(iv); process.exit(0); }, ms);",
  "process.on('SIGTERM', () => process.exit(0));",
].join('\n'), 'utf8');

function deterministicExecutorDeps(spawned) {
  return {
    spawn: () => { const c = spawn(process.execPath, [STUB], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, __STUB_MS: process.env.__SOC_STUB_MS || '20000' } }); spawned.push(c); return c; },
    resolveExecutable: () => ({ ok: true, executable: process.execPath, source: 'deterministic-test', candidates: [] }),
    preflight: () => ({ ok: true, version: 'deterministic-test', agent: 'build', toolCaps: ['bash', 'edit', 'read', 'glob', 'grep', 'list'] }),
    verifyAuthority: () => ({ ok: true }),
  };
}

function callMcp(server, name, args) {
  const res = server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res && res.result, `no result for ${name}: ${JSON.stringify(res)}`);
  return JSON.parse(res.result.content[0].text);
}

// ---- disposable external git repo (same contract as the #175 fixtures) ---------
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

// ---- drive the REAL client-mcp stdio MCP server as an OS child process ----------
// Observer clients run with NO SOC_CONTROL_LANE -> they never spawn an executor.
function startClientMcp({ stateDir, worktreesRoot, controlLane } = {}) {
  const env = { ...process.env, SOC_CONTROL_STATE_DIR: stateDir, SOC_CONTROL_WORKTREES_ROOT: worktreesRoot };
  if (controlLane) env.SOC_CONTROL_LANE = controlLane; else delete env.SOC_CONTROL_LANE;
  const proc = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  proc.stderr.setEncoding('utf8'); let stderr = ''; proc.stderr.on('data', (d) => { stderr += d; });
  proc.stdout.setEncoding('utf8');
  let buf = ''; const pending = new Map();
  proc.stdout.on('data', (chunk) => {
    buf += chunk; const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) { const t = line.trim(); if (!t) continue; let m; try { m = JSON.parse(t); } catch { continue; } if (m && Object.prototype.hasOwnProperty.call(m, 'id') && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); } }
  });
  let seq = 0;
  function rpc(method, params) { const id = ++seq; return new Promise((resolve, reject) => { const to = setTimeout(() => { pending.delete(id); reject(new Error(`MCP rpc timeout ${method}`)); }, 45000); pending.set(id, { resolve: (m) => { clearTimeout(to); resolve(m); }, reject }); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }); }
  async function tool(name, args) { const res = await rpc('tools/call', { name, arguments: args }); if (res.error) throw new Error(`wire ${name}: ${JSON.stringify(res.error)}`); return JSON.parse(res.result.content[0].text); }
  const exited = new Promise((r) => proc.on('exit', (code, signal) => r({ code, signal, stderr })));
  async function handshake() { const i = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'proc-test', version: '1' } }); assert.equal(i.result.serverInfo.name, 'soc-brain-client'); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n'); }
  return { proc, tool, handshake, exited, kill: () => proc.kill('SIGKILL') };
}

function readRecord({ stateDir, repo, issueNumber }) { return readExecutionRecord({ stateDir, repo, issueNumber }); }
function oneExecFile({ stateDir, h }) { const dir = path.join(stateDir, 'executions'); try { return fs.readdirSync(dir).filter((f) => f.startsWith(h) && f.endsWith('.json') && !f.includes('events') && !f.includes('terminal')).length; } catch { return 0; } }

test('F1 E2E PROCESS-BACKED: soc.submit_goal -> production route -> REAL startExecution executor + production ExecutionRecord/bind -> kill a real client OS process -> executor survives -> fresh client OS process reconnects to SAME identity/execution/PID, no duplicate', async () => {
  const R = makeRepo('duongpdddic-droid/disposable-f1');
  const stateDir = path.join(TMP, 'state-f1'); mkdirSync(stateDir, { recursive: true });
  const lane = 'control-plane-f1';
  const spawned = [];
  let clientProc, clientB;
  try {
    // Client A: the production control surface + production route seam, driven over
    // the real MCP JSON-RPC wire handler. startExecution (production) launches the
    // deterministic REAL executor child and writes the record + executionMode bind.
    const controlA = createClientControl({ stateDir, worktreesRoot: path.join(TMP, 'wt'), controlLane: lane, routeExecutor: createCanonicalRouteExecutor(deterministicExecutorDeps(spawned)) });
    const serverA = createClientMcpServer({ control: controlA });
    const sub = callMcp(serverA, 'soc.submit_goal', { targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, goal: 'ship the widget behind a flag', issueNumber: 870001 });
    assert.ok(sub.ok, JSON.stringify(sub));
    assert.equal(sub.admitted, true);
    assert.ok(sub.execution && sub.execution.ok === true && sub.execution.status === 'RUNNING', `production route must launch a RUNNING executor, got ${JSON.stringify(sub.execution)}`);
    const h = sub.identityHash;
    const pid = sub.execution.pid;
    assert.ok(Number.isInteger(pid) && pid > 0, 'production startExecution returns a real executor PID');

    // The canonical ExecutionRecord was created by PRODUCTION, with a real identity.
    const rr = readRecord({ stateDir, repo: 'duongpdddic-droid/disposable-f1', issueNumber: 870001 });
    assert.ok(rr.ok, JSON.stringify(rr));
    const rec = rr.record;
    assert.equal(rec.pid, pid, 'record PID is the production-launched child');
    assert.equal(rec.identityHash, h);
    assert.equal(rec.terminalStatus, null, 'record is non-terminal while the executor runs');
    assert.equal(rec.pendingExecutorBind, false, 'production cleared the pre-spawn latch on strict bind');
    const probe = readWin32ProcessStartTime(pid);
    if (IS_WIN) assert.equal(rec.processStartTime, probe && probe.processStartTime, 'production captured the immutable Win32 start-time identity');
    // executionMode was promoted to 'executor' by startExecution (NOT by this test).
    const sessA = readSessionRecord(sessionPathFor({ stateDir, identityHash: h })).session;
    assert.equal(sessA.executionMode, 'executor', 'startExecution is the sole writer that binds executor context');
    assert.equal(sessA.mutationOwner.laneId, lane, 'owner is the control-plane lane, never the client');
    assert.ok(!TERMINAL.includes(sessA.state), 'admission is non-terminal');
    // meaningful deterministic executor work is being recorded as canonical activity
    assert.ok(fs.existsSync(executionEventsPath({ stateDir, identityHash: h })), 'activity events file created by startExecution passthrough');

    // A FRESH real OS client-mcp observer process sees the same RUNNING execution.
    clientProc = startClientMcp({ stateDir, worktreesRoot: path.join(TMP, 'wt') });
    await clientProc.handshake();
    const gpA = await clientProc.tool('soc.get_progress', { repo: R.ownerRepoName, issueNumber: 870001 });
    assert.ok(gpA.ok); assert.equal(gpA.execution.pid, pid);
    if (IS_WIN) { assert.equal(gpA.execution.liveness, 'RUNNING'); assert.equal(gpA.execution.identityProven, true); }

    // KILL a real client OS process -> the production executor is UNAFFECTED (the
    // client is not the executor's parent and holds no lifecycle).
    clientProc.kill(); const aExit = await clientProc.exited; clientProc = null;
    assert.ok(aExit.code !== 0 || aExit.signal, 'client OS process died from the kill');
    assert.equal(isAlive(pid), true, 'killing a client-mcp OS process must NOT cancel the executor');
    const sessAfter = readSessionRecord(sessionPathFor({ stateDir, identityHash: h })).session;
    assert.ok(!TERMINAL.includes(sessAfter.state), 'executor/client death must not terminalize the task');
    assert.equal(sessAfter.mutationOwner.laneId, lane);
    if (IS_WIN) assert.equal(reconcileExecutorLiveness(rec).liveness, 'RUNNING', 'PID-identity liveness survives client death');

    // A second FRESH real OS client-mcp process reconnects to the SAME identity.
    clientB = startClientMcp({ stateDir, worktreesRoot: path.join(TMP, 'wt') });
    await clientB.handshake();
    const gt = await clientB.tool('soc.get_task', { repo: R.ownerRepoName, issueNumber: 870001 });
    assert.ok(gt.ok); assert.equal(gt.task.identityHash, h); assert.equal(gt.task.taskId, sessA.taskId);
    assert.equal(gt.task.mutationOwner, lane); assert.equal(gt.task.executionMode, 'executor');
    const gpB = await clientB.tool('soc.get_progress', { repo: R.ownerRepoName, issueNumber: 870001 });
    assert.equal(gpB.execution.pid, pid, 'reconnect observes the SAME execution, not a new one');
    if (IS_WIN) { assert.equal(gpB.execution.liveness, 'RUNNING'); assert.equal(gpB.execution.identityProven, true); }
    // No canonical activity advanced by a foreign observer read; executor kept working.
    const tail = readActivityTail({ stateDir, repo: R.ownerRepoName, issueNumber: 870001 });
    assert.ok(tail.ok && tail.items.length >= 1, 'deterministic executor emitted canonical activity');

    // Re-submitting the SAME task via the production route mints NO duplicate:
    // startExecution returns EXECUTION_ALREADY_RUNNING and the PID is unchanged.
    const again = callMcp(serverA, 'soc.submit_goal', { targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, goal: 'ship the widget behind a flag', issueNumber: 870001 });
    assert.ok(again.ok);
    assert.equal(again.execution && again.execution.status, 'EXECUTION_ALREADY_RUNNING', 'production single-execution dedup');
    assert.equal(oneExecFile({ stateDir, h }), 1, 'exactly one canonical ExecutionRecord for the identity');
    const rec2 = readRecord({ stateDir, repo: 'duongpdddic-droid/disposable-f1', issueNumber: 870001 }).record;
    assert.equal(rec2.pid, pid, 'no second executor incarnation');

    // A foreign lane cannot hijack ownership (still proven at admission).
    const intruder = createClientControl({ stateDir, worktreesRoot: path.join(TMP, 'wt'), controlLane: 'lane-INTRUDER', routeExecutor: createCanonicalRouteExecutor(deterministicExecutorDeps(spawned)) });
    const clash = callMcp(createClientMcpServer({ control: intruder }), 'soc.submit_goal', { targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, goal: 'hijack', issueNumber: 870001 });
    assert.equal(clash.ok, false); assert.equal(clash.reason, 'MUTATION_OWNER_CONFLICT');
  } finally {
    if (clientProc) clientProc.kill(); if (clientB) clientB.kill();
    for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  }
});

test('P3 PROCESS-BACKED: Human Gate opened by a production-launched executor across a real client-OS death is answered exactly once by a fresh client OS process (stale/wrong reject; canonical resume)', async () => {
  const R = makeRepo('duongpdddic-droid/disposable-p3');
  const stateDir = path.join(TMP, 'state-p3'); mkdirSync(stateDir, { recursive: true });
  const lane = 'control-plane-p3';
  const spawned = []; let clientA, clientB;
  try {
    const controlA = createClientControl({ stateDir, worktreesRoot: path.join(TMP, 'wt'), controlLane: lane, routeExecutor: createCanonicalRouteExecutor(deterministicExecutorDeps(spawned)) });
    const sub = callMcp(createClientMcpServer({ control: controlA }), 'soc.submit_goal', { targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, goal: 'gate', issueNumber: 870003 });
    assert.ok(sub.ok && sub.execution.ok === true, JSON.stringify(sub));
    const h = sub.identityHash; const sPath = sessionPathFor({ stateDir, identityHash: h });
    // The executor (canonical broker-side primitive, not the client) opens the gate.
    assert.ok(taskRequestHumanGate({ sessionPath: sPath, note: 'Postgres or SQLite?' }).ok);
    assert.ok(HUMAN_GATE_STATES.includes(readSessionRecord(sPath).session.state));
    const pid = sub.execution.pid;

    clientA = startClientMcp({ stateDir, worktreesRoot: path.join(TMP, 'wt') }); await clientA.handshake();
    clientA.kill(); await clientA.exited; clientA = null;
    assert.equal(isAlive(pid), true, 'executor survives client death while parked at a gate');
    assert.ok(HUMAN_GATE_STATES.includes(readSessionRecord(sPath).session.state), 'gate is not lost on client death');

    clientB = startClientMcp({ stateDir, worktreesRoot: path.join(TMP, 'wt') }); await clientB.handshake();
    const gt = await clientB.tool('soc.get_task', { repo: R.ownerRepoName, issueNumber: 870003 });
    assert.ok(gt.ok && gt.task.humanGate && gt.task.humanGate.at, 'reconnected client reads the current checkpoint');
    const cp = gt.task.humanGate.at;
    const stale = await clientB.tool('soc.answer_human_gate', { repo: R.ownerRepoName, issueNumber: 870003, checkpointAt: '1970-01-01T00:00:00.000Z', response: 'PG' });
    assert.equal(stale.ok, false); assert.equal(stale.reason, 'GATE_CHECKPOINT_STALE');
    const wrong = await clientB.tool('soc.answer_human_gate', { repo: R.ownerRepoName, issueNumber: 859999, checkpointAt: cp, response: 'PG' });
    assert.equal(wrong.ok, false); assert.equal(wrong.reason, 'TASK_NOT_FOUND');
    const ans = await clientB.tool('soc.answer_human_gate', { repo: R.ownerRepoName, issueNumber: 870003, checkpointAt: cp, response: 'Postgres' });
    assert.ok(ans.ok, JSON.stringify(ans)); assert.equal(ans.state, 'SESSION_ACTIVE');
    const dup = await clientB.tool('soc.answer_human_gate', { repo: R.ownerRepoName, issueNumber: 870003, checkpointAt: cp, response: 'again' });
    assert.equal(dup.ok, false); assert.equal(dup.reason, 'GATE_NOT_ACTIVE');
    const sess = readSessionRecord(sPath).session;
    assert.equal(sess.state, 'SESSION_ACTIVE'); assert.equal(sess.humanGate.state, 'ANSWERED'); assert.equal(sess.humanGate.response, 'Postgres');
  } finally {
    if (clientA) clientA.kill(); if (clientB) clientB.kill();
    for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  }
});

test('P4 PROCESS-BACKED: clean MCP transport disconnect (stdin EOF) exits the client surface 0 and loses ONLY the transport; an unbound interactive client launches no executor', async () => {
  const R = makeRepo('duongpdddic-droid/disposable-p4');
  const stateDir = path.join(TMP, 'state-p4'); mkdirSync(stateDir, { recursive: true });
  let A, B;
  try {
    A = startClientMcp({ stateDir, worktreesRoot: path.join(TMP, 'wt') }); // NO lane -> admitted-only
    await A.handshake();
    const sub = await A.tool('soc.submit_goal', { targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, goal: 'g', issueNumber: 870004 });
    assert.ok(sub.ok, JSON.stringify(sub));
    const h = sub.identityHash;
    // An unbound interactive client admitted the task but spawned NOTHING.
    assert.ok(!fs.existsSync(executionRecordPath({ stateDir, identityHash: h })), 'unbound client must not create an ExecutionRecord');
    assert.ok(!fs.existsSync(path.join(stateDir, 'activity', 'live', `${h}.json`)), 'client surface owns no activity lease');
    A.proc.stdin.end(); const exit = await A.exited; A = null;
    assert.equal(exit.code, 0, 'clean EOF exits 0 — transport loss only');
    const s = readSessionRecord(sessionPathFor({ stateDir, identityHash: h })).session;
    assert.ok(!TERMINAL.includes(s.state));
    B = startClientMcp({ stateDir, worktreesRoot: path.join(TMP, 'wt') }); await B.handshake();
    const gt = await B.tool('soc.get_task', { repo: R.ownerRepoName, issueNumber: 870004 });
    assert.ok(gt.ok); assert.equal(gt.task.identityHash, h); assert.equal(gt.task.state, s.state);
  } finally { if (A) A.kill(); if (B) B.kill(); }
});

test('F2 PROCESS-BACKED: broker transport EOF does NOT remove authoritative (PID-identity) liveness for a production-launched executor; true exit is reconciled; stale/PID-reuse fails closed', async () => {
  const R = makeRepo('duongpdddic-droid/disposable-f2');
  const stateDir = path.join(TMP, 'state-f2'); mkdirSync(stateDir, { recursive: true });
  const lane = 'control-plane-f2';
  const spawned = [];
  try {
    const controlA = createClientControl({ stateDir, worktreesRoot: path.join(TMP, 'wt'), controlLane: lane, routeExecutor: createCanonicalRouteExecutor(deterministicExecutorDeps(spawned)) });
    const sub = callMcp(createClientMcpServer({ control: controlA }), 'soc.submit_goal', { targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, goal: 'work', issueNumber: 870002 });
    assert.ok(sub.ok && sub.execution.ok === true, JSON.stringify(sub));
    const h = sub.identityHash; const pid = sub.execution.pid;
    const rec = readRecord({ stateDir, repo: R.ownerRepoName, issueNumber: 870002 }).record;
    // activity lease exists (executor-facing broker registered liveness) and is LIVE
    const pub = publishExecutorLease({ stateDir, identity: { identityHash: h, pid, processStartTime: rec.processStartTime, repo: R.ownerRepoName, issueNumber: 870002 } });
    const leasePath = path.join(stateDir, 'activity', 'live', `${h}.json`);
    if (!IS_WIN) { assert.ok(true, 'non-Windows: PID-identity liveness unverifiable'); return; }
    assert.ok(pub.ok, JSON.stringify(pub)); assert.ok(fs.existsSync(leasePath));
    assert.equal(reconcileExecutorLiveness(rec).liveness, 'RUNNING');

    // Simulate the executor-facing broker transport EOF (the exact retire the broker
    // main() runs on stdin EOF/SIGTERM): remove the activity lease.
    const ret = retireExecutorLease({ stateDir, identityHash: h, pid, processStartTime: rec.processStartTime });
    assert.ok(ret.ok && ret.released === true);
    // Authoritative liveness is the ExecutionRecord identity, NOT the retired lease:
    // the executor stays live and reconcile is unaffected; the canonical record is
    // untouched (activity/liveness is not falsely removed on transport EOF).
    assert.ok(!fs.existsSync(leasePath), 'lease removed by transport EOF');
    assert.equal(isAlive(pid), true, 'transport EOF does not kill the executor OS process');
    assert.ok(fs.existsSync(executionRecordPath({ stateDir, identityHash: h })), 'transport EOF does not remove canonical execution state');
    assert.equal(reconcileExecutorLiveness(readRecord({ stateDir, repo: R.ownerRepoName, issueNumber: 870002 }).record).liveness, 'RUNNING', 'PID-identity liveness is decoupled from the transport/lease');

    // A TRUE executor exit is reconciled to terminal by production (startExecution
    // child 'exit' handler writes terminalStatus), and liveness follows.
    for (const c of spawned) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
    let final = null;
    for (let i = 0; i < 60; i++) {
      const r = readRecord({ stateDir, repo: R.ownerRepoName, issueNumber: 870002 });
      if (r.ok && EXEC_TERMINAL.includes(r.record.terminalStatus)) { final = r.record; break; }
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.ok(final, 'production finalizes a terminal ExecutionRecord after the real executor exits');
    assert.equal(isAlive(pid), false, 'executor is gone');
    assert.equal(reconcileExecutorLiveness(final).identityProven, true);
    assert.ok(EXEC_TERMINAL.includes(reconcileExecutorLiveness(final).liveness), 'gone executor reconciles to a terminal liveness (retires correctly)');

    // A stale / PID-reused identity fails closed (never auto-claims RUNNING).
    const reused = reconcileExecutorLiveness({ pid, processStartTime: rec.processStartTime, terminalStatus: null }, { isAlive: () => true, readStartTime: () => ({ processStartTime: (rec.processStartTime ?? 0) + 12345 }) });
    assert.equal(reused.liveness, 'PID_REUSED'); assert.equal(reused.identityProven, false);
    assert.equal(classifyExecutor({ record: rec, liveness: 'PID_REUSED' }).canMutate, false, 'PID reuse denies mutation');
  } finally {
    for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  }
});

test('F2b PROCESS-BACKED (known-gap characterization): an interactive executor with NO ExecutionRecord loses its only activity signal on broker transport EOF — documented, NOT claimed PASS', () => {
  const stateDir = path.join(TMP, 'state-f2b'); mkdirSync(stateDir, { recursive: true });
  const h = identityHash({ repo: 'duongpdddic-droid/disposable-f2b', issueNumber: 870009 });
  const spawned = [];
  try {
    // A live "broker" process registers the interactive-executor lease (no
    // ExecutionRecord exists for an interactive executor).
    const broker = spawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], { stdio: 'ignore', windowsHide: true }); spawned.push(broker);
    const st = readWin32ProcessStartTime(broker.pid);
    if (!IS_WIN) { assert.ok(true, 'non-Windows: unverifiable, skipped'); return; }
    const pub = publishExecutorLease({ stateDir, identity: { identityHash: h, pid: broker.pid, processStartTime: st && st.processStartTime } });
    assert.ok(pub.ok);
    const leasePath = path.join(stateDir, 'activity', 'live', `${h}.json`);
    assert.ok(fs.existsSync(leasePath));
    assert.ok(!fs.existsSync(executionRecordPath({ stateDir, identityHash: h })), 'interactive executor has no ExecutionRecord');
    // Transport EOF retires the lease -> for THIS class the only liveness signal is
    // gone even though the process is still alive. This is the residual #172 seam
    // that F2 keeps NOT-PASS pending a separate runtime task.
    retireExecutorLease({ stateDir, identityHash: h, pid: broker.pid, processStartTime: st && st.processStartTime });
    assert.ok(!fs.existsSync(leasePath), 'CHARACTERIZATION: lease removed on transport EOF');
    assert.equal(isAlive(broker.pid), true, 'CHARACTERIZATION: process still live while its lease is gone');
    assert.ok(!fs.existsSync(executionRecordPath({ stateDir, identityHash: h })), 'no PID-identity fallback record for an interactive executor -> supervisor can under-count activity (see follow-up)');
  } finally {
    for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  }
});
