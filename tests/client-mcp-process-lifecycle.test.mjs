#!/usr/bin/env node
// client-mcp-process-lifecycle.test.mjs — PROCESS-BACKED proof for the post-#175
// client model, with OpenCode/Cline acting as the client/operator UI but NOT the
// lifecycle authority.
//
// WHY this file exists: tests/client-mcp.test.mjs proves the #175 control-surface
// LOGIC, but every "client death" there is simulated by dropping an in-process JS
// object reference and building a fresh `createClientControl` over the same state
// dir, and `routeExecutor` is a synchronous stand-in that only flips
// `executionMode`. No OS process is ever spawned or killed, and no real detached
// executor exists. This file closes exactly that gap with REAL operating-system
// processes:
//   * the real stdio MCP server `packages/client-mcp/client-mcp.mjs` is spawned as
//     a child OS process and driven over real stdin/stdout JSON-RPC;
//   * a real, independent (sibling) detached executor process is launched by the
//     test harness (standing in for the control plane's production `routeExecutor`
//     wiring, which #175 shipped unwired), and its ExecutionRecord is written with
//     the OS process identity captured exactly the way `startExecution` captures
//     it;
//   * client A is TERMINATED with a real process kill / clean stdin EOF; and
//   * a FRESH client B OS process reconnects and must recover the SAME canonical
//     task/session/identity/owner/execution and the SAME Human-Gate checkpoint.
//
// The assertions reuse the SAME canonical primitives the production client surface
// uses (`reconcileExecutorLiveness`, PID + immutable Win32 PROCESS_START_TIME) so
// liveness is proven from the real OS, never faked. On non-Windows hosts where
// `readWin32ProcessStartTime` cannot prove identity the strict-RUNNING checks are
// skipped (unverifiable, not false).
//
// Every spawned OS process is tracked and force-killed in a finally so a failing
// assertion can never leave a live client child holding open stdio and hang the
// test runner. No gh, no network, no real coding executor, no product-repo mutation.

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
  sessionPathFor, readSessionRecord, taskRequestHumanGate,
  updateSessionUnderOwnershipLock, HUMAN_GATE_STATES,
} from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { publishExecutorLease, retireExecutorLease } from '../packages/runtime-sandbox/activity-lease.mjs';
import { executionRecordPath } from '../packages/executor-launcher/executor-launcher.mjs';
import { reconcileExecutorLiveness } from '../packages/executor-launcher/executor-reconcile.mjs';
import { isAlive, readWin32ProcessStartTime } from '../packages/temp-hygiene/temp-hygiene.mjs';

const SERVER = fileURLToPath(new URL('../packages/client-mcp/client-mcp.mjs', import.meta.url));
const IS_WIN = process.platform === 'win32';
const TERMINAL = ['COMPLETED', 'FAILED', 'BLOCKED'];

const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-175-proc-'));
mkdirSync(path.join(TMP, 'wt'), { recursive: true });

function forceKill(entry) {
  if (!entry) return;
  try { if (typeof entry.kill === 'function') entry.kill('SIGKILL'); else process.kill(entry, 'SIGKILL'); } catch { /* already gone */ }
}

// ---- disposable external git repo (identical contract to the #175 fixtures) ----
function makeRepo(ownerRepoName, files = { 'opencode.json': '{}\n', 'README.md': 'r\n' }) {
  const dir = mkdtempSync(path.join(TMP, 'repo-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const run = (args) => { try { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { throw new Error('git ' + args.join(' ') + ' failed: ' + ((e.stderr || '') + (e.stdout || '') || e.message)); } };
  run(['init', '--initial-branch=main', dir]);
  run(['-C', dir, 'config', 'user.email', 't@e.x']);
  run(['-C', dir, 'config', 'user.name', 't']);
  for (const [f, c] of Object.entries(files)) { writeFileSync(path.join(dir, f), c); run(['-C', dir, 'add', f]); }
  run(['-C', dir, 'commit', '-m', 'init']);
  const sha = run(['-C', dir, 'rev-parse', 'HEAD']);
  run(['-C', dir, 'remote', 'add', 'origin', `https://github.com/${ownerRepoName}.git`]);
  run(['-C', dir, 'update-ref', 'refs/remotes/origin/main', sha]);
  return { dir, ownerRepoName, sha };
}

// ---- drive the REAL client-mcp stdio MCP server as an OS child process ----------
function startClientMcp({ stateDir, worktreesRoot, controlLane } = {}) {
  const env = { ...process.env, SOC_CONTROL_STATE_DIR: stateDir, SOC_CONTROL_WORKTREES_ROOT: worktreesRoot };
  if (controlLane) env.SOC_CONTROL_LANE = controlLane; else delete env.SOC_CONTROL_LANE;
  const proc = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  proc.stderr.setEncoding('utf8');
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  proc.stdout.setEncoding('utf8');
  let buf = '';
  const pending = new Map();
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let msg; try { msg = JSON.parse(t); } catch { continue; }
      if (msg && Object.prototype.hasOwnProperty.call(msg, 'id') && pending.has(msg.id)) {
        pending.get(msg.id).resolve(msg); pending.delete(msg.id);
      }
    }
  });
  let seq = 0;
  function rpc(method, params) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => { pending.delete(id); reject(new Error(`MCP rpc timeout: ${method}`)); }, 45000);
      pending.set(id, { resolve: (m) => { clearTimeout(to); resolve(m); }, reject });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async function tool(name, args) {
    const res = await rpc('tools/call', { name, arguments: args });
    if (res.error) throw new Error(`tools/call ${name} wire error: ${JSON.stringify(res.error)}`);
    return JSON.parse(res.result.content[0].text);
  }
  const exited = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal, stderr })));
  async function handshake() {
    const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'proc-test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'soc-brain-client');
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    return init;
  }
  return { proc, rpc, tool, handshake, exited, kill: () => proc.kill('SIGKILL'), pid: proc.pid, get stderr() { return stderr; } };
}

// ---- a REAL, independent detached executor process (control-plane sibling) ------
function launchDetachedExecutor() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  const start = readWin32ProcessStartTime(child.pid);
  return { pid: child.pid, processStartTime: start && start.processStartTime != null ? start.processStartTime : null, kill: () => forceKill(child.pid) };
}

function writeExecutionRecord({ stateDir, session, executor, status = null }) {
  const recPath = executionRecordPath({ stateDir, identityHash: session.identityHash });
  const record = {
    schemaVersion: '1', kind: 'ExecutionRecord',
    identityHash: session.identityHash, taskId: session.taskId ?? null,
    repo: session.repo, issueNumber: session.issueNumber,
    baseSha: session.baseSha ?? null, branch: session.branch ?? null,
    worktreePath: session.worktreePath ?? null, executor: 'opencode',
    pid: executor.pid, processStartTime: executor.processStartTime,
    startedAt: Date.now(), finishedAt: null, exitCode: null, signal: null,
    terminalStatus: status, reason: null, sessionId: null,
    pendingExecutorBind: false, finalized: status != null,
  };
  mkdirSync(path.dirname(recPath), { recursive: true });
  const tmp = `${recPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, recPath);
  return { recPath, record };
}

function readExecutionRec({ stateDir, identityHash: h }) {
  return JSON.parse(fs.readFileSync(executionRecordPath({ stateDir, identityHash: h }), 'utf8'));
}
function hasLease({ stateDir, h }) { return fs.existsSync(path.join(stateDir, 'activity', 'live', `${h}.json`)); }

test('P1+P2+P4 PROCESS-BACKED: real client-A process death does not cancel the executor / lose the task; fresh client-B OS process recovers the SAME task/session/identity/owner/execution and mints no duplicate', async (t) => {
  const R = makeRepo('duongpdddic-droid/disposable-p1');
  const stateDir = path.join(TMP, 'state-p1');
  mkdirSync(stateDir, { recursive: true });
  const lane = 'control-plane-p1';
  let A, B, C, exec;
  try {
    A = startClientMcp({ stateDir, worktreesRoot: path.join(TMP, 'wt'), controlLane: lane });
    await A.handshake();
    const sub = await A.tool('soc.submit_goal', {
      targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, goal: 'ship behind a flag', issueNumber: 860001,
    });
    assert.ok(sub.ok, `submit_goal over real stdio failed: ${JSON.stringify(sub)}`);
    assert.equal(sub.admitted, true);
    const h = sub.identityHash;
    const sPath = sessionPathFor({ stateDir, identityHash: h });
    assert.ok(fs.existsSync(sPath), 'canonical session file missing after real-process admission');
    const s = readSessionRecord(sPath).session;
    assert.equal(s.mutationOwner.laneId, lane, 'mutation owner must be the control-plane lane, never the client');
    assert.ok(!TERMINAL.includes(s.state), 'admission must not be terminal');
    assert.ok(!fs.existsSync(executionRecordPath({ stateDir, identityHash: h })), 'client submit must not create an ExecutionRecord (it holds no lifecycle)');
    assert.ok(!hasLease({ stateDir, h }), 'client surface must not publish an activity lease');

    exec = launchDetachedExecutor();
    assert.ok(exec.pid > 0, 'detached executor must be a real OS process');
    writeExecutionRecord({ stateDir, session: s, executor: exec });
    updateSessionUnderOwnershipLock(sPath, (sess) => { sess.executionMode = 'executor'; return { session: sess }; });

    const pAlive = await A.tool('soc.get_progress', { repo: R.ownerRepoName, issueNumber: 860001 });
    assert.ok(pAlive.ok);
    assert.equal(pAlive.execution.pid, exec.pid, 'get_progress must report the real executor pid');
    if (IS_WIN) {
      assert.equal(pAlive.execution.liveness, 'RUNNING');
      assert.equal(pAlive.execution.identityProven, true, 'RUNNING must be identity-proven via real Win32 start-time probe');
    }

    A.kill();
    const aExit = await A.exited; A = null;
    assert.ok(aExit.code !== 0 || aExit.signal, 'client A should have died from the kill signal');

    assert.equal(isAlive(exec.pid), true, 'executor must NOT be canceled merely because the client process died');
    const sAfterA = readSessionRecord(sPath).session;
    assert.ok(!TERMINAL.includes(sAfterA.state), 'client death must not terminalize the canonical task');
    assert.equal(sAfterA.taskId, s.taskId);
    assert.equal(sAfterA.mutationOwner.laneId, lane, 'mutation owner must not change on client death');
    if (IS_WIN) assert.equal(reconcileExecutorLiveness(readExecutionRec({ stateDir, identityHash: h })).liveness, 'RUNNING', 'process identity/liveness must still prove RUNNING after client death');

    B = startClientMcp({ stateDir, worktreesRoot: path.join(TMP, 'wt'), controlLane: lane });
    await B.handshake();
    const gt = await B.tool('soc.get_task', { repo: R.ownerRepoName, issueNumber: 860001 });
    assert.ok(gt.ok, JSON.stringify(gt));
    assert.equal(gt.task.identityHash, h, 'client B must recover the SAME canonical identity');
    assert.equal(gt.task.taskId, s.taskId);
    assert.equal(gt.task.repo, 'duongpdddic-droid/disposable-p1');
    assert.equal(gt.task.issueNumber, 860001);
    assert.equal(gt.task.mutationOwner, lane, 'single mutation owner preserved across reconnect');
    assert.equal(gt.task.executionMode, 'executor');
    assert.equal(gt.task.state, sAfterA.state);
    const gp = await B.tool('soc.get_progress', { repo: R.ownerRepoName, issueNumber: 860001 });
    assert.ok(gp.ok);
    assert.equal(gp.execution.pid, exec.pid, 'reconnect observes the SAME execution, not a new one');
    if (IS_WIN) { assert.equal(gp.execution.liveness, 'RUNNING'); assert.equal(gp.execution.identityProven, true); }

    const dup = await B.tool('soc.submit_goal', { targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, goal: 'ship behind a flag', issueNumber: 860001 });
    assert.ok(dup.ok, JSON.stringify(dup));
    assert.equal(dup.identityHash, h, 'same explicit issue must reconcile to the SAME task (no duplicate)');
    assert.equal(fs.readdirSync(path.join(stateDir, 'sessions')).filter((f) => f.startsWith(h)).length, 1, 'exactly one canonical session for the identity');
    assert.ok(fs.existsSync(executionRecordPath({ stateDir, identityHash: h })), 'reconnect must not have dropped or duplicated the execution record');

    C = startClientMcp({ stateDir, worktreesRoot: path.join(TMP, 'wt'), controlLane: 'lane-INTRUDER' });
    await C.handshake();
    const clash = await C.tool('soc.submit_goal', { targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, goal: 'hijack', issueNumber: 860001 });
    assert.equal(clash.ok, false);
    assert.equal(clash.reason, 'MUTATION_OWNER_CONFLICT', 'a second mutation owner must fail closed even from a fresh process');
  } finally {
    if (A) A.kill(); if (B) B.kill(); if (C) C.kill();
    if (exec) exec.kill();
  }
});

test('P4 PROCESS-BACKED: clean MCP transport disconnect (stdin EOF) exits the client surface with code 0 and loses ONLY the transport, not the lifecycle', async () => {
  const R = makeRepo('duongpdddic-droid/disposable-p4');
  const stateDir = path.join(TMP, 'state-p4');
  mkdirSync(stateDir, { recursive: true });
  const lane = 'control-plane-p4';
  let A, B;
  try {
    A = startClientMcp({ stateDir, worktreesRoot: path.join(TMP, 'wt'), controlLane: lane });
    await A.handshake();
    const sub = await A.tool('soc.submit_goal', { targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, goal: 'g', issueNumber: 860004 });
    assert.ok(sub.ok, JSON.stringify(sub));
    const h = sub.identityHash;
    const sPath = sessionPathFor({ stateDir, identityHash: h });

    A.proc.stdin.end();
    const exit = await A.exited; A = null;
    assert.equal(exit.code, 0, 'client surface must exit cleanly (0) on transport EOF — no crash, no lifecycle side effect');
    const s = readSessionRecord(sPath).session;
    assert.ok(!TERMINAL.includes(s.state));
    assert.equal(s.mutationOwner.laneId, lane);
    assert.ok(!fs.existsSync(executionRecordPath({ stateDir, identityHash: h })), 'transport disconnect must not have minted execution');
    assert.ok(!hasLease({ stateDir, h }), 'client surface must never own an activity lease');

    B = startClientMcp({ stateDir, worktreesRoot: path.join(TMP, 'wt'), controlLane: lane });
    await B.handshake();
    const gt = await B.tool('soc.get_task', { repo: R.ownerRepoName, issueNumber: 860004 });
    assert.ok(gt.ok); assert.equal(gt.task.identityHash, h); assert.equal(gt.task.state, s.state);
  } finally {
    if (A) A.kill(); if (B) B.kill();
  }
});

test('P3 PROCESS-BACKED: Human Gate reached across client-A death is read + answered exactly once by a fresh client-B OS process (stale/wrong reject; canonical resume)', async () => {
  const R = makeRepo('duongpdddic-droid/disposable-p3');
  const stateDir = path.join(TMP, 'state-p3');
  mkdirSync(stateDir, { recursive: true });
  const lane = 'control-plane-p3';
  let A, B, exec;
  try {
    A = startClientMcp({ stateDir, worktreesRoot: path.join(TMP, 'wt'), controlLane: lane });
    await A.handshake();
    const sub = await A.tool('soc.submit_goal', { targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, goal: 'gate', issueNumber: 860003 });
    assert.ok(sub.ok, JSON.stringify(sub));
    const h = sub.identityHash;
    const sPath = sessionPathFor({ stateDir, identityHash: h });

    exec = launchDetachedExecutor();
    writeExecutionRecord({ stateDir, session: readSessionRecord(sPath).session, executor: exec });
    updateSessionUnderOwnershipLock(sPath, (sess) => { sess.executionMode = 'executor'; return { session: sess }; });
    assert.ok(taskRequestHumanGate({ sessionPath: sPath, note: 'Postgres or SQLite?' }).ok, 'executor-side gate request must succeed');
    assert.ok(HUMAN_GATE_STATES.includes(readSessionRecord(sPath).session.state));

    A.kill();
    await A.exited; A = null;
    assert.equal(isAlive(exec.pid), true, 'executor must survive client death while parked at a Human Gate');
    assert.ok(HUMAN_GATE_STATES.includes(readSessionRecord(sPath).session.state), 'gate must not be lost on client death');

    B = startClientMcp({ stateDir, worktreesRoot: path.join(TMP, 'wt'), controlLane: lane });
    await B.handshake();
    const gt = await B.tool('soc.get_task', { repo: R.ownerRepoName, issueNumber: 860003 });
    assert.ok(gt.ok && gt.task.humanGate && gt.task.humanGate.at, 'reconnected client must read the current Human Gate checkpoint');
    const cp = gt.task.humanGate.at;
    const gp = await B.tool('soc.get_progress', { repo: R.ownerRepoName, issueNumber: 860003 });
    assert.equal(gp.humanActionRequired, true);

    const stale = await B.tool('soc.answer_human_gate', { repo: R.ownerRepoName, issueNumber: 860003, checkpointAt: '1970-01-01T00:00:00.000Z', response: 'PG' });
    assert.equal(stale.ok, false); assert.equal(stale.reason, 'GATE_CHECKPOINT_STALE');
    const wrong = await B.tool('soc.answer_human_gate', { repo: R.ownerRepoName, issueNumber: 859999, checkpointAt: cp, response: 'PG' });
    assert.equal(wrong.ok, false); assert.equal(wrong.reason, 'TASK_NOT_FOUND');
    const ans = await B.tool('soc.answer_human_gate', { repo: R.ownerRepoName, issueNumber: 860003, checkpointAt: cp, response: 'Postgres' });
    assert.ok(ans.ok, JSON.stringify(ans));
    assert.equal(ans.resumed, true); assert.equal(ans.state, 'SESSION_ACTIVE');
    const dup = await B.tool('soc.answer_human_gate', { repo: R.ownerRepoName, issueNumber: 860003, checkpointAt: cp, response: 'Postgres' });
    assert.equal(dup.ok, false); assert.equal(dup.reason, 'GATE_NOT_ACTIVE');
    const sess = readSessionRecord(sPath).session;
    assert.equal(sess.state, 'SESSION_ACTIVE', 'control-loop resumes canonically from the answered gate');
    assert.equal(sess.humanGate.state, 'ANSWERED');
    assert.equal(sess.humanGate.response, 'Postgres', 'answer is DATA, never a lifecycle verdict');
  } finally {
    if (A) A.kill(); if (B) B.kill();
    if (exec) exec.kill();
  }
});

test('P5 PROCESS-BACKED: transport-loss retires the activity lease but does NOT kill the executor and does NOT corrupt PID-identity liveness (documents the #172 lease/transport coupling seam)', () => {
  const stateDir = path.join(TMP, 'state-p5');
  mkdirSync(stateDir, { recursive: true });
  const h = identityHash({ repo: 'duongpdddic-droid/disposable-p5', issueNumber: 860005 });
  const exec = launchDetachedExecutor();
  try {
    const session = { identityHash: h, repo: 'duongpdddic-droid/disposable-p5', issueNumber: 860005, taskId: 'T-p5' };
    const { record } = writeExecutionRecord({ stateDir, session, executor: exec });
    if (!IS_WIN) { t_skip(); return; }
    const pub = publishExecutorLease({ stateDir, identity: { identityHash: h, pid: exec.pid, processStartTime: exec.processStartTime, repo: session.repo, issueNumber: session.issueNumber } });
    assert.ok(pub.ok, JSON.stringify(pub));
    const leasePath = path.join(stateDir, 'activity', 'live', `${h}.json`);
    assert.ok(fs.existsSync(leasePath), 'lease published while executor live');
    assert.equal(reconcileExecutorLiveness(record).liveness, 'RUNNING');

    const ret = retireExecutorLease({ stateDir, identityHash: h, pid: exec.pid, processStartTime: exec.processStartTime });
    assert.ok(ret.ok && ret.released === true, 'retire removes exactly this incarnation lease');
    assert.ok(!fs.existsSync(leasePath), 'FINDING (residual seam): retire on transport EOF deletes the lease even though the executor may keep running headless');
    assert.equal(isAlive(exec.pid), true, 'transport disconnect must NOT kill the executor OS process');
    assert.ok(fs.existsSync(executionRecordPath({ stateDir, identityHash: h })), 'transport disconnect must NOT remove canonical execution state');
    assert.equal(reconcileExecutorLiveness(record).liveness, 'RUNNING', 'liveness authority (PID + Win32 start-time) is decoupled from the activity lease/transport');
    assert.equal(reconcileExecutorLiveness(record).identityProven, true);
  } finally {
    exec.kill();
  }
  function t_skip() { assert.ok(true, 'non-Windows: PID-identity liveness is unverifiable here; skipped rather than faked'); }
});
