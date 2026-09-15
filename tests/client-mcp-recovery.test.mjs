#!/usr/bin/env node
// client-mcp-recovery.test.mjs — MANUAL MCP restart / reattach failure matrix
// (post-#175/#179/#180). Every scenario is PROCESS-BACKED: real client-mcp OS
// processes are started, disconnected (EOF), SIGTERM/SIGKILLed, and a FRESH
// adapter process reattaches to the SAME canonical task via the read-only
// soc.recover seam. The executor is the real OS process launched by PRODUCTION
// startExecution through the production route seam (never fabricated; the test
// substitutes only the absent opencode binary via the sanctioned DI points,
// exactly like tests/client-mcp-process-lifecycle.test.mjs).
//
// North Star invariants asserted across the matrix:
//   * transport disconnect/restart never loses or mutates canonical
//     task/session/ExecutionRecord state (byte-stable session across restarts);
//   * never cancels the executor; never mints a duplicate execution or a second
//     mutation owner; never terminalizes lifecycle; never answers a gate;
//   * exact identity binding: repo + issue -> identityHash -> sessionPath ->
//     taskId -> ExecutionRecord {pid, processStartTime} -> checkpoint;
//   * stale/foreign/ambiguous reattach fails closed; reads are idempotent.
//
// Every spawned OS process is tracked and force-killed in a finally (no leaked
// children, no per-file timeouts, no masked cancellations).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { SECRET_KEY_NAME } from '../packages/safe-git/safe-git.mjs';
import { createClientControl, createCanonicalRouteExecutor } from '../packages/client-mcp/client-control.mjs';
import { createClientMcpServer } from '../packages/client-mcp/client-mcp.mjs';
import {
  recordAdapterBoot, recordTransportDisconnect, recordReattach, resolveRecoveryTarget,
  reportExecutionLiveness, transportStatePathFor, TRANSPORT_STATES,
} from '../packages/client-mcp/recovery.mjs';

const SERVER = fileURLToPath(new URL('../packages/client-mcp/client-mcp.mjs', import.meta.url));
const BROKER = fileURLToPath(new URL('../packages/runtime-sandbox/mcp-server.mjs', import.meta.url));
const IS_WIN = process.platform === 'win32';
const TERMINAL = ['COMPLETED', 'FAILED', 'BLOCKED'];

const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-rec-'));
mkdirSync(path.join(TMP, 'wt'), { recursive: true });

// ---- deterministic REAL executor process (the opencode stand-in) ---------------
const STUB = path.join(TMP, 'executor-stub.mjs');
writeFileSync(STUB, [
  "const ms = Number(process.env.__STUB_MS || 30000);",
  "let n = 0; const tick = () => { try { process.stdout.write(JSON.stringify({ type: 'text', part: { text: 'recovery step ' + (++n) }, t: Date.now() }) + '\\n'); } catch { } };",
  "tick(); const iv = setInterval(tick, 150);",
  "setTimeout(() => { clearInterval(iv); process.exit(0); }, ms);",
  "process.on('SIGTERM', () => process.exit(0));",
].join('\n'), 'utf8');

function deterministicExecutorDeps(spawned) {
  return {
    spawn: () => { const c = spawn(process.execPath, [STUB], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, __STUB_MS: '30000' } }); spawned.push(c); return c; },
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

// ---- drive the REAL client-mcp stdio adapter as an OS child process ------------
function startClientMcp({ stateDir, worktreesRoot = path.join(TMP, 'wt'), controlLane, extraEnv } = {}) {
  const env = { ...process.env, SOC_CONTROL_STATE_DIR: stateDir, SOC_CONTROL_WORKTREES_ROOT: worktreesRoot };
  if (controlLane) env.SOC_CONTROL_LANE = controlLane; else delete env.SOC_CONTROL_LANE;
  if (extraEnv) Object.assign(env, extraEnv);
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
  async function handshake() { const i = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'rec-test', version: '1' } }); assert.equal(i.result.serverInfo.name, 'soc-brain-client'); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n'); }
  return {
    proc, tool, handshake, exited, stderr: () => stderr,
    kill: (sig) => { try { proc.kill(sig || 'SIGKILL'); } catch { /* gone */ } },
    closeStdin: () => { try { proc.stdin.end(); } catch { /* gone */ } },
  };
}

function readTransport(stateDir) { try { return JSON.parse(fs.readFileSync(transportStatePathFor({ stateDir }), 'utf8')); } catch { return null; } }
function countFiles(dir, pred) { try { return fs.readdirSync(dir).filter(pred).length; } catch { return 0; } }
function execCount(stateDir, h) { return countFiles(path.join(stateDir, 'executions'), (f) => f.startsWith(h) && f.endsWith('.json') && !f.includes('events') && !f.includes('terminal')); }
function sessionCount(stateDir) { return countFiles(path.join(stateDir, 'sessions'), (f) => f.endsWith('.json')); }
function newSessions(stateDir) { return path.join(stateDir, 'sessions'); }
async function until(pred, timeoutMs = 15000) { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { if (pred()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; }
function laneStateDir(name) { const d = path.join(TMP, `state-${name}`); mkdirSync(d, { recursive: true }); return d; }

// Production admission + launch through the canonical route seam (mirrors #179).
function admitAndLaunch({ stateDir, repo, lane, issueNumber }) {
  const spawned = [];
  const control = createClientControl({ stateDir, worktreesRoot: path.join(TMP, 'wt'), controlLane: lane, routeExecutor: createCanonicalRouteExecutor(deterministicExecutorDeps(spawned)) });
  const server = createClientMcpServer({ control });
  const sub = callMcp(server, 'soc.submit_goal', { targetRepo: repo.ownerRepoName, localCheckoutPath: repo.dir, goal: 'recovery matrix work', issueNumber });
  assert.ok(sub.ok, JSON.stringify(sub));
  assert.ok(sub.execution && sub.execution.ok === true && sub.execution.status === 'RUNNING', `production route must launch RUNNING executor: ${JSON.stringify(sub.execution)}`);
  return { control, spawned, sub, identityHash: sub.identityHash, pid: sub.execution.pid };
}

// ------------------------------------------------------------------ S0 unit ----
test('S0 UNIT: recovery primitives — transport vocabulary isolated from task FSM, fail-closed discovery, liveness mapping', () => {
  assert.deepEqual([...TRANSPORT_STATES].sort(), ['CONNECTED', 'DISCONNECTED', 'REATTACHING', 'RECOVERED', 'RECOVERY_FAILED', 'RESTARTING', 'RECOVERY_SCHEDULED', 'HEALTHCHECK'].sort());
  assert.ok(!TRANSPORT_STATES.some((s) => TERMINAL.includes(s) || s === 'SESSION_ACTIVE' || s === 'HUMAN_GATE_REQUIRED'), 'transport states never collide with task/session FSM vocabulary');
  // unproven identity is NEVER reported as RUNNING (no synthetic liveness).
  assert.equal(reportExecutionLiveness({ liveness: 'RUNNING', identityProven: false }), 'UNKNOWN');
  assert.equal(reportExecutionLiveness({ liveness: 'RUNNING', identityProven: true }), 'RUNNING');
  assert.equal(reportExecutionLiveness({ liveness: 'OWNERSHIP_UNKNOWN' }), 'UNKNOWN');
  assert.equal(reportExecutionLiveness({ liveness: 'PID_REUSED' }), 'UNKNOWN');
  assert.equal(reportExecutionLiveness({ liveness: 'EXITED' }), 'GONE');
  assert.equal(reportExecutionLiveness(null), null);
  // explicit identity binds only when BOTH halves are present.
  assert.equal(resolveRecoveryTarget({ stateDir: TMP, repo: 'a/b' }).reason, 'RECOVERY_IDENTITY_INCOMPLETE');
  assert.equal(resolveRecoveryTarget({ stateDir: TMP, issueNumber: 5 }).reason, 'RECOVERY_IDENTITY_INCOMPLETE');
  // boot/reattach/disconnect observability (isolated temp stateDir).
  const S = laneStateDir('s0');
  const b = recordAdapterBoot({ stateDir: S, bootId: 'boot-1' });
  assert.ok(b.ok && b.state.transportState === 'RESTARTING' && b.state.restartCount === 1);
  assert.equal(recordAdapterBoot({ stateDir: S, bootId: 'boot-1' }).booted, false, 'boot is idempotent per adapter process');
  recordReattach({ stateDir: S, bootId: 'boot-1', result: { ok: true, currentTaskIdentity: { repo: 'a/b', issueNumber: 1, identityHash: 'h', taskId: 't' }, executionLiveness: 'RUNNING', humanGateState: 'NONE' } });
  assert.equal(readTransport(S).transportState, 'RECOVERED');
  assert.equal(recordTransportDisconnect({ stateDir: S, bootId: 'boot-1' }).recorded, true);
  assert.equal(readTransport(S).lastDisconnectKind, 'CLEAN');
  recordAdapterBoot({ stateDir: S, bootId: 'boot-2' });
  assert.equal(readTransport(S).lastDisconnectKind, 'CLEAN', 'clean EOF carries exact disconnect time forward');
  recordAdapterBoot({ stateDir: S, bootId: 'boot-3' });
  assert.equal(readTransport(S).lastDisconnectKind, 'UNGRACEFUL', 'a boot after an un-recorded death is UNGRACEFUL');
  const noDir = path.join(TMP, 's0-empty'); mkdirSync(noDir, { recursive: true });
  assert.equal(resolveRecoveryTarget({ stateDir: noDir }).reason, 'NO_ACTIVE_TASK');
});

// ------------------------------------------------------------------- R1 ------
test('R1 PROCESS-BACKED: clean stdin EOF disconnect -> fresh adapter soc.recover reattaches SAME task/executor; DISCONNECTED recorded CLEAN; task untouched', async () => {
  const R = makeRepo('duongpdddic-droid/disposable-rec-r1');
  const S = laneStateDir('r1');
  const lane = 'control-plane-r1';
  const { spawned, sub, pid } = admitAndLaunch({ stateDir: S, repo: R, lane, issueNumber: 872001 });
  let a1, a2;
  try {
    a1 = startClientMcp({ stateDir: S }); await a1.handshake();
    const rec1 = await a1.tool('soc.recover', {});
    assert.ok(rec1.ok, JSON.stringify(rec1));
    assert.equal(rec1.transportState, 'RECOVERED');
    assert.equal(rec1.discovered, true, 'single active task discovered WITHOUT operator re-entering identity');
    assert.equal(rec1.currentTaskIdentity.repo, R.ownerRepoName);
    assert.equal(rec1.currentTaskIdentity.issueNumber, 872001);
    assert.equal(rec1.currentTaskIdentity.identityHash, sub.identityHash);
    assert.equal(rec1.mutationOwner, lane, 'reattach keeps the SAME mutation owner');
    assert.equal(rec1.execution.pid, pid);
    assert.ok(rec1.execution.processStartTime === null || Number.isFinite(rec1.execution.processStartTime));
    if (IS_WIN) { assert.equal(rec1.executionLiveness, 'RUNNING'); assert.equal(rec1.execution.identityProven, true); }
    assert.equal(rec1.humanGateState, 'NONE');
    // get_task/get_progress work again THROUGH the reattached adapter (R0 step 9).
    const gt = await a1.tool('soc.get_task', { repo: R.ownerRepoName, issueNumber: 872001 });
    assert.ok(gt.ok && gt.task.taskId === rec1.currentTaskIdentity.taskId);
    // Clean EOF: exits 0, DISCONNECTED recorded by the dying adapter itself.
    a1.closeStdin(); const x = await a1.exited; a1 = null;
    assert.equal(x.code, 0, 'clean EOF still exits 0');
    assert.equal(x.stderr, '', 'adapter stays stderr-silent');
    const dead = readTransport(S);
    assert.equal(dead.transportState, 'DISCONNECTED'); assert.equal(dead.lastDisconnectKind, 'CLEAN');
    assert.ok(dead.lastDisconnectAt, 'lastDisconnectAt recorded');
    // FRESH adapter reattaches to the SAME canonical task; executor untouched.
    a2 = startClientMcp({ stateDir: S }); await a2.handshake();
    const rec2 = await a2.tool('soc.recover', {});
    assert.ok(rec2.ok); assert.equal(rec2.currentTaskIdentity.identityHash, sub.identityHash);
    assert.equal(rec2.execution.pid, pid, 'same execution pid across restart');
    if (IS_WIN) assert.equal(rec2.execution.processStartTime, rec1.execution.processStartTime, 'PROCESS_START_TIME stable across the transport restart');
    assert.equal(isAlive(pid), true, 'R1: transport EOF did not cancel the executor');
    assert.equal(rec2.transport.restartCount, 2);
    assert.equal(rec2.transport.lastDisconnectKind, 'CLEAN');
    assert.equal(execCount(S, sub.identityHash), 1, 'no duplicate ExecutionRecord');
    assert.equal(sessionCount(S), 1, 'no duplicate task/session');
    assert.ok(!fs.existsSync(path.join(S, 'client-mcp', 'submissions')), 'recovery NEVER resubmits goals (no submission ledger writes)');
  } finally { if (a1) a1.kill(); if (a2) a2.kill(); for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* gone */ } } }
});

// ------------------------------------------------------------------- R2 ------
test('R2 PROCESS-BACKED: adapter SIGTERM kill -> executor survives -> fresh adapter recovers SAME identity/execution; UNGRACEFUL classified; canonical state unmutated', async () => {
  const R = makeRepo('duongpdddic-droid/disposable-rec-r2');
  const S = laneStateDir('r2');
  const lane = 'control-plane-r2';
  const { spawned, sub, pid } = admitAndLaunch({ stateDir: S, repo: R, lane, issueNumber: 872002 });
  const sPath = sessionPathFor({ stateDir: S, identityHash: sub.identityHash });
  const sessionBytesBefore = fs.readFileSync(sPath);
  let a1, a2;
  try {
    a1 = startClientMcp({ stateDir: S }); await a1.handshake();
    assert.ok((await a1.tool('soc.recover', {})).ok);
    a1.kill('SIGTERM'); await a1.exited; a1 = null;
    assert.equal(isAlive(pid), true, 'R2: SIGTERMing the adapter does not cancel the executor');
    assert.deepEqual(fs.readFileSync(sPath), sessionBytesBefore, 'adapter death mutates NOTHING canonical (session byte-stable)');
    a2 = startClientMcp({ stateDir: S }); await a2.handshake();
    const rec = await a2.tool('soc.recover', {});
    assert.ok(rec.ok); assert.equal(rec.transportState, 'RECOVERED');
    assert.equal(rec.currentTaskIdentity.taskId, JSON.parse(sessionBytesBefore.toString()).taskId, 'same taskId');
    assert.equal(rec.mutationOwner, lane);
    assert.equal(rec.execution.pid, pid);
    if (IS_WIN) assert.equal(rec.executionLiveness, 'RUNNING');
    assert.equal(rec.transport.lastDisconnectKind, 'UNGRACEFUL', 'a kill (no EOF record) is honestly UNGRACEFUL');
    assert.equal(execCount(S, sub.identityHash), 1); assert.equal(sessionCount(S), 1);
  } finally { if (a1) a1.kill(); if (a2) a2.kill(); for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* gone */ } } }
});

// ------------------------------------------------------------------- R3 ------
test('R3 PROCESS-BACKED: adapter SIGKILL -> executor lives, progress canonical -> fresh adapter get_progress SAME pid+start-time, no second owner/execution', async () => {
  const R = makeRepo('duongpdddic-droid/disposable-rec-r3');
  const S = laneStateDir('r3');
  const lane = 'control-plane-r3';
  const { spawned, sub, pid } = admitAndLaunch({ stateDir: S, repo: R, lane, issueNumber: 872003 });
  const recPath = sessionPathFor({ stateDir: S, identityHash: sub.identityHash });
  const ownerBefore = readSessionRecord(recPath).session.mutationOwner.laneId;
  let a1, a2;
  try {
    a1 = startClientMcp({ stateDir: S }); await a1.handshake();
    const before = await a1.tool('soc.get_progress', { repo: R.ownerRepoName, issueNumber: 872003 });
    assert.ok(before.ok && before.execution.pid === pid);
    a1.kill('SIGKILL'); await a1.exited; a1 = null;
    assert.equal(isAlive(pid), true, 'R3: SIGKILL of the adapter cannot reach the executor');
    const sessMid = readSessionRecord(recPath).session;
    assert.ok(!TERMINAL.includes(sessMid.state), 'executor death by transport kill: task stays non-terminal');
    a2 = startClientMcp({ stateDir: S }); await a2.handshake();
    const gp = await a2.tool('soc.get_progress', { repo: R.ownerRepoName, issueNumber: 872003 });
    assert.ok(gp.ok); assert.equal(gp.execution.pid, pid, 'fresh adapter observes the SAME execution PID');
    if (IS_WIN) {
      const probe = readWin32ProcessStartTime(pid);
      assert.equal(gp.execution.processStartTime, probe.processStartTime, 'PROCESS_START_TIME identical across the restart');
      assert.equal(gp.execution.liveness, 'RUNNING');
    }
    assert.equal(readSessionRecord(recPath).session.mutationOwner.laneId, ownerBefore, 'mutation owner unchanged');
    assert.equal(execCount(S, sub.identityHash), 1, 'no duplicate execution record');
    const re = callMcpSafeRestart(S, R);
    assert.equal(re.status, 'EXECUTION_ALREADY_RUNNING', 'resubmit-style "recovery" is refused a second executor');
  } finally { if (a1) a1.kill(); if (a2) a2.kill(); for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* gone */ } } }
});
function callMcpSafeRestart(S, R) {
  // A lane-bound control surface retrying submit must NOT mint a second run:
  // canonical dedup answers EXECUTION_ALREADY_RUNNING (the R0 ban on submit-goal
  // "recovery" is enforced, not just documented).
  const control = createClientControl({ stateDir: S, worktreesRoot: path.join(TMP, 'wt'), controlLane: 'control-plane-r3', routeExecutor: createCanonicalRouteExecutor(deterministicExecutorDeps([])) });
  return control.submitGoal({ targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, goal: 'recovery matrix work', issueNumber: 872003 }).execution || {};
}

// ------------------------------------------------------------------- R4 ------
test('R4 PROCESS-BACKED: OpenCode client restart (adapter respawn via config) -> control restored on the SAME task without restarting it', async () => {
  const R = makeRepo('duongpdddic-droid/disposable-rec-r4');
  const S = laneStateDir('r4');
  const lane = 'control-plane-r4';
  const { spawned, sub, pid } = admitAndLaunch({ stateDir: S, repo: R, lane, issueNumber: 872004 });
  let a1, a2;
  try {
    a1 = startClientMcp({ stateDir: S }); await a1.handshake();
    assert.ok((await a1.tool('soc.recover', {})).ok);
    a1.kill('SIGKILL'); await a1.exited; a1 = null; // OpenCode process death takes the adapter with it
    a2 = startClientMcp({ stateDir: S }); await a2.handshake(); // fresh OpenCode spawns the adapter from config
    const probe = await a2.tool('soc.not_a_tool', {}); // unknown tool on the fresh wire stays fail-closed
    assert.equal(probe.ok, false); assert.equal(probe.reason, 'UNAUTHORIZED_TOOL_EXPOSED');
    const rec = await a2.tool('soc.recover', {});
    assert.ok(rec.ok, 'control surface restored');
    assert.equal(rec.currentTaskIdentity.identityHash, sub.identityHash);
    assert.equal(rec.execution.pid, pid, 'task/executor were NOT restarted');
    assert.ok(rec.transport.lastReattachAt, 'lastReattachAt observed');
  } finally { if (a1) a1.kill(); if (a2) a2.kill(); for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* gone */ } } }
});

// ------------------------------------------------------------------- R5 ------
test('R5 PROCESS-BACKED: executor-facing BROKER (runtime transport) restart -> fresh broker re-boots authority on the SAME session; task/executor untouched', async () => {
  const R = makeRepo('duongpdddic-droid/disposable-rec-r5');
  const S = laneStateDir('r5');
  const lane = 'control-plane-r5';
  const { spawned, sub, pid } = admitAndLaunch({ stateDir: S, repo: R, lane, issueNumber: 872005 });
  const sPath = sessionPathFor({ stateDir: S, identityHash: sub.identityHash });
  const sess = readSessionRecord(sPath).session;
  const brokerEnv = {
    ...process.env,
    SOC_SESSION_PATH: sPath,
    SOC_CONTROL_CWD: R.dir,
    SOC_LANE_ID: lane,
  };
  // Per-session lease token is a DYNAMIC canonical value (never a literal secret);
  // bind it via the canonical env-name constant so the line reads as a code
  // reference (the tracked-secret guard's documented pass shape for real lease
  // tokens), not a hard-coded `KEY: value`.
  brokerEnv[SECRET_KEY_NAME] = sess.lease.token;
  const startBroker = () => {
    const p = spawn(process.execPath, [BROKER], { env: brokerEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    p.stderr.setEncoding('utf8'); let err = ''; p.stderr.on('data', (d) => { err += d; });
    const exited = new Promise((r) => p.on('exit', (code, signal) => r({ code, signal, err })));
    let buf = ''; const pending = new Map();
    p.stdout.on('data', (c) => { buf += c; const ls = buf.split('\n'); buf = ls.pop(); for (const l of ls) { const t = l.trim(); if (!t) continue; let m; try { m = JSON.parse(t); } catch { continue; } if (m && Object.prototype.hasOwnProperty.call(m, 'id') && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
    let seq = 0;
    const rpc = (method, params) => new Promise((resolve, reject) => { const id = ++seq; const to = setTimeout(() => { pending.delete(id); reject(new Error('broker rpc timeout')); }, 30000); pending.set(id, (m) => { clearTimeout(to); resolve(m); }); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    return { p, rpc, exited, kill: (sig) => { try { p.kill(sig || 'SIGKILL'); } catch { /* gone */ } }, close: () => { try { p.stdin.end(); } catch { /* gone */ } }, stderr: () => err };
  };
  let b1, b2;
  try {
    b1 = startBroker();
    await b1.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'rec-r5', version: '1' } });
    const st1 = await b1.rpc('tools/call', { name: 'soc_broker_status', arguments: {} });
    assert.ok(st1.result && st1.result.isError !== true, 'broker 1 serves the bound session');
    b1.close(); const x1 = await b1.exited; b1 = null;
    assert.equal(x1.code, 0, 'broker exits 0 on clean EOF');
    assert.equal(x1.err, '', 'broker shutdown stays stderr-silent (#172 invariant)');
    // Broker death never touches canonical state:
    assert.equal(isAlive(pid), true);
    const after = readSessionRecord(sPath).session;
    assert.ok(!TERMINAL.includes(after.state));
    assert.equal(after.mutationOwner.laneId, lane);
    assert.equal(execCount(S, sub.identityHash), 1);
    // Runtime broker RESTART: a fresh broker re-bootstraps authority from the
    // SAME canonical session (lease token stable across restarts — no expiry).
    b2 = startBroker();
    await b2.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'rec-r5b', version: '1' } });
    const st2 = await b2.rpc('tools/call', { name: 'soc_broker_status', arguments: {} });
    assert.ok(st2.result && st2.result.isError !== true, 'fresh broker serves the SAME session without task restart');
    const leaseDir = path.join(S, 'activity', 'live');
    assert.equal(countFiles(leaseDir, (f) => f === `${sub.identityHash}.json`), 1, 'one activity lease slot for the identity — no second owner');
  } finally { if (b1) b1.kill(); if (b2) b2.kill(); for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* gone */ } } }
});

// ------------------------------------------------------------------- R7 ------
test('R7 PROCESS-BACKED: executor DIES while MCP is disconnected -> canonical production finalization settles it; fresh adapter reports GONE (never synthetic RUNNING); transport never terminalizes', async () => {
  const R = makeRepo('duongpdddic-droid/disposable-rec-r7');
  const S = laneStateDir('r7');
  const lane = 'control-plane-r7';
  const { control, spawned, sub, pid } = admitAndLaunch({ stateDir: S, repo: R, lane, issueNumber: 872007 });
  const sPath = sessionPathFor({ stateDir: S, identityHash: sub.identityHash });
  let a1, a2;
  try {
    a1 = startClientMcp({ stateDir: S }); await a1.handshake();
    assert.ok((await a1.tool('soc.recover', {})).ok);
    a1.kill('SIGKILL'); await a1.exited; a1 = null; // MCP disconnected
    for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* gone */ } } // executor dies while disconnected
    assert.ok(await until(() => { const r = readExecutionRecord({ stateDir: S, repo: R.ownerRepoName, issueNumber: 872007 }); return r.ok && !!r.record.terminalStatus; }), 'production finalization records the terminal status (canonical path, not the transport)');
    assert.equal(isAlive(pid), false);
    a2 = startClientMcp({ stateDir: S }); await a2.handshake();
    // F1 (#9000005 REWORK): a promoted executor whose process is PROVEN GONE is no
    // longer AUTO-discoverable on executionMode alone, so a NO-ARG reattach now fails
    // closed (NO_ACTIVE_TASK) instead of resurrecting stale SESSION_ACTIVE residue —
    // the exact failure class this task exists to fix. Observing the dead executor is
    // still fully supported via the EXPLICIT identity bind: reported GONE (never
    // synthetic RUNNING), and the transport still never terminalizes the task.
    const noArg = await a2.tool('soc.recover', {});
    assert.equal(noArg.ok, false, 'proven-gone promoted executor is NOT auto-discoverable (F1)');
    assert.equal(noArg.reason, 'NO_ACTIVE_TASK', 'dead promoted residue is excluded, never resurrected as active/ambiguous');
    const rec = await a2.tool('soc.recover', { repo: R.ownerRepoName, issueNumber: 872007 });
    assert.ok(rec.ok, 'explicit reattach still succeeds — a dead executor is observed, not hidden');
    assert.equal(rec.executionLiveness, 'GONE', 'dead executor reports GONE, never synthetic RUNNING');
    const sess = readSessionRecord(sPath).session;
    assert.ok(!TERMINAL.includes(sess.state), 'the transport/recovery layer did NOT terminalize the task — lifecycle stays with the canonical control loop');
    assert.equal(execCount(S, sub.identityHash), 1, 'executor death + reconnect did not mint a second execution');
    void control;
  } finally { if (a1) a1.kill(); if (a2) a2.kill(); for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* gone */ } } }
});

// ------------------------------------------------------------------- R8 ------
test('R8 PROCESS-BACKED: Human Gate WAITING across adapter kill+restart -> SAME checkpoint via soc.recover; restart never answers; answer exactly once, stale/wrong/dup fail closed', async () => {
  const R = makeRepo('duongpdddic-droid/disposable-rec-r8');
  const S = laneStateDir('r8');
  const lane = 'control-plane-r8';
  const { spawned, sub, pid } = admitAndLaunch({ stateDir: S, repo: R, lane, issueNumber: 872008 });
  const sPath = sessionPathFor({ stateDir: S, identityHash: sub.identityHash });
  assert.ok(taskRequestHumanGate({ sessionPath: sPath, note: 'Postgres or SQLite?' }).ok);
  const gateBefore = readSessionRecord(sPath).session.humanGate;
  assert.ok(HUMAN_GATE_STATES.includes(readSessionRecord(sPath).session.state));
  let a1, a2;
  try {
    a1 = startClientMcp({ stateDir: S }); await a1.handshake();
    const rec1 = await a1.tool('soc.recover', {});
    assert.ok(rec1.ok); assert.equal(rec1.humanGateState, 'WAITING', 'recover exposes the pending gate');
    assert.equal(rec1.task.humanGate.at, gateBefore.at);
    a1.kill('SIGKILL'); await a1.exited; a1 = null;
    const mid = readSessionRecord(sPath).session;
    assert.ok(HUMAN_GATE_STATES.includes(mid.state), 'R8: adapter kill never answers or drops the gate');
    assert.equal(mid.humanGate.at, gateBefore.at, 'checkpoint byte-identical across the restart');
    assert.equal(isAlive(pid), true, 'executor parked at a gate survives the transport restart');
    a2 = startClientMcp({ stateDir: S }); await a2.handshake();
    const rec2 = await a2.tool('soc.recover', {});
    assert.ok(rec2.ok); assert.equal(rec2.humanGateState, 'WAITING');
    assert.equal(rec2.task.humanGate.at, gateBefore.at, 'fresh adapter reattaches to the SAME checkpoint');
    const stale = await a2.tool('soc.answer_human_gate', { repo: R.ownerRepoName, issueNumber: 872008, checkpointAt: '1970-01-01T00:00:00.000Z', response: 'PG' });
    assert.equal(stale.ok, false); assert.equal(stale.reason, 'GATE_CHECKPOINT_STALE');
    const wrong = await a2.tool('soc.answer_human_gate', { repo: R.ownerRepoName, issueNumber: 872999, checkpointAt: gateBefore.at, response: 'PG' });
    assert.equal(wrong.ok, false); assert.equal(wrong.reason, 'TASK_NOT_FOUND');
    const ans = await a2.tool('soc.answer_human_gate', { repo: R.ownerRepoName, issueNumber: 872008, checkpointAt: gateBefore.at, response: 'Postgres' });
    assert.ok(ans.ok, JSON.stringify(ans)); assert.equal(ans.state, 'SESSION_ACTIVE');
    const dup = await a2.tool('soc.answer_human_gate', { repo: R.ownerRepoName, issueNumber: 872008, checkpointAt: gateBefore.at, response: 'again' });
    assert.equal(dup.ok, false); assert.equal(dup.reason, 'GATE_NOT_ACTIVE');
    const sess = readSessionRecord(sPath).session;
    assert.equal(sess.humanGate.state, 'ANSWERED'); assert.equal(sess.humanGate.response, 'Postgres');
  } finally { if (a1) a1.kill(); if (a2) a2.kill(); for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* gone */ } } }
});

// ------------------------------------------------------------------- R9 ------
test('R9 PROCESS-BACKED: repeated manual restarts (3 cycles) are idempotent — canonical session byte-stable, one execution, owner stable, restartCount monotonic', async () => {
  const R = makeRepo('duongpdddic-droid/disposable-rec-r9');
  const S = laneStateDir('r9');
  const lane = 'control-plane-r9';
  const { spawned, sub, pid } = admitAndLaunch({ stateDir: S, repo: R, lane, issueNumber: 872009 });
  const sPath = sessionPathFor({ stateDir: S, identityHash: sub.identityHash });
  const bytes0 = fs.readFileSync(sPath);
  let adapter;
  try {
    for (let i = 1; i <= 3; i++) {
      adapter = startClientMcp({ stateDir: S }); await adapter.handshake();
      const rec = await adapter.tool('soc.recover', {});
      assert.ok(rec.ok, `cycle ${i}`);
      assert.equal(rec.currentTaskIdentity.identityHash, sub.identityHash);
      assert.equal(rec.execution.pid, pid, `cycle ${i}: same execution every time`);
      assert.equal(rec.mutationOwner, lane);
      assert.equal(rec.transport.restartCount, i, 'restartCount increments exactly once per adapter boot');
      assert.ok(!fs.existsSync(path.join(S, 'client-mcp', 'submissions')), 'no cycle created a submission');
      adapter.kill('SIGKILL'); await adapter.exited; adapter = null;
    }
    assert.deepEqual(fs.readFileSync(sPath), bytes0, 'repeated recovery NEVER mutates the canonical session record');
    assert.equal(execCount(S, sub.identityHash), 1); assert.equal(sessionCount(S), 1);
    assert.equal(isAlive(pid), true);
  } finally { if (adapter) adapter.kill(); for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* gone */ } } }
});

// ------------------------------------------------------------------ R10 ------
test('R10 PROCESS-BACKED: two fresh adapters reattach CONCURRENTLY -> both bind the same identity, reads idempotent, no duplicate artifacts, transport.json stays valid', async () => {
  const R = makeRepo('duongpdddic-droid/disposable-rec-r10');
  const S = laneStateDir('r10');
  const lane = 'control-plane-r10';
  const { spawned, sub, pid } = admitAndLaunch({ stateDir: S, repo: R, lane, issueNumber: 872010 });
  let a1, a2;
  try {
    a1 = startClientMcp({ stateDir: S }); await a1.handshake();
    a2 = startClientMcp({ stateDir: S }); await a2.handshake();
    const [r1, r2] = await Promise.all([a1.tool('soc.recover', {}), a2.tool('soc.recover', {})]);
    assert.ok(r1.ok && r2.ok, JSON.stringify([r1, r2]));
    assert.deepEqual(r1.currentTaskIdentity, r2.currentTaskIdentity, 'concurrent reattach binds the EXACT same identity');
    assert.equal(r1.execution.pid, pid); assert.equal(r2.execution.pid, pid);
    const t = readTransport(S);
    assert.ok(t && ['RECOVERED', 'RESTARTING', 'DISCONNECTED', 'REATTACHING'].includes(t.transportState), 'observability record stays valid JSON under the race');
    assert.equal(execCount(S, sub.identityHash), 1); assert.equal(sessionCount(S), 1);
    assert.equal(countFiles(newSessions(S), (f) => f.endsWith('.json')), 1);
  } finally { if (a1) a1.kill(); if (a2) a2.kill(); for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* gone */ } } }
});

// ------------------------------------------------------------------ R11 ------
test('R11 PROCESS-BACKED: stale client reattach fails closed — wrong stateDir sees NO_ACTIVE_TASK (creates nothing); explicit terminal task observed truthfully; no synthetic state', async () => {
  const R = makeRepo('duongpdddic-droid/disposable-rec-r11');
  const S = laneStateDir('r11'); const EMPTY = laneStateDir('r11-empty');
  const lane = 'control-plane-r11';
  const { spawned, sub, pid } = admitAndLaunch({ stateDir: S, repo: R, lane, issueNumber: 872011 });
  let a1, a2;
  try {
    a1 = startClientMcp({ stateDir: EMPTY }); await a1.handshake();
    const miss = await a1.tool('soc.recover', {});
    assert.equal(miss.ok, false); assert.equal(miss.reason, 'NO_ACTIVE_TASK', 'a stale/mismatched adapter fails closed');
    assert.equal(miss.transportState, 'RECOVERY_FAILED');
    assert.equal(sessionCount(EMPTY), 0, 'failed recovery created NOTHING');
    assert.ok(readTransport(EMPTY)); assert.equal(readTransport(EMPTY).lastRecoveryReason, 'NO_ACTIVE_TASK');
    // Canonical completion through the CONTROL-PLANE seam (not the transport), then
    // a stale client explicitly re-binds the finished task: it must observe the
    // terminal truth, never resurrect or re-run anything.
    for (const c of spawned) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
    assert.ok(await until(() => { const r = readExecutionRecord({ stateDir: S, repo: R.ownerRepoName, issueNumber: 872011 }); return r.ok && !!r.record.terminalStatus; }), 'production finalizes the exited executor');
    assert.ok(taskFinish({ sessionPath: sessionPathFor({ stateDir: S, identityHash: sub.identityHash }), outcome: 'COMPLETED' }).ok);
    a2 = startClientMcp({ stateDir: S }); await a2.handshake();
    const gone = await a2.tool('soc.recover', { repo: R.ownerRepoName, issueNumber: 872011 });
    assert.ok(gone.ok, 'exact rebind to a terminal task is a truthful READ, not an error');
    assert.equal(gone.state, 'COMPLETED'); assert.equal(gone.executionLiveness, 'GONE');
    const discovery = await a2.tool('soc.recover', {});
    assert.equal(discovery.ok, false); assert.equal(discovery.reason, 'NO_ACTIVE_TASK', 'terminal tasks are never auto-attached');
    assert.equal(isAlive(pid), false);
    assert.equal(execCount(S, sub.identityHash), 1);
  } finally { if (a1) a1.kill(); if (a2) a2.kill(); for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* gone */ } } }
});

// ------------------------------------------------------------------ R12 ------
test('R12 PROCESS-BACKED: foreign repo/task identity fails closed — cross pairs never attach; ambiguity with 2 active tasks requires the exact bind; zero mutation', async () => {
  const RA = makeRepo('duongpdddic-droid/disposable-rec-r12a');
  const RB = makeRepo('duongpdddic-droid/disposable-rec-r12b');
  const S = laneStateDir('r12');
  const lane = 'control-plane-r12';
  const A = admitAndLaunch({ stateDir: S, repo: RA, lane, issueNumber: 872012 });
  const B = admitAndLaunch({ stateDir: S, repo: RB, lane, issueNumber: 872013 });
  const sessionsBefore = sessionCount(S);
  let a1;
  try {
    a1 = startClientMcp({ stateDir: S }); await a1.handshake();
    const amb = await a1.tool('soc.recover', {});
    assert.equal(amb.ok, false); assert.equal(amb.reason, 'AMBIGUOUS_ACTIVE_TASKS', 'with 2 active tasks recovery refuses to guess');
    assert.equal(amb.candidates.length, 2);
    const foreign = await a1.tool('soc.recover', { repo: RA.ownerRepoName, issueNumber: 872013 });
    assert.equal(foreign.ok, false); assert.equal(foreign.reason, 'TASK_NOT_FOUND', 'cross repo+issue pairing cannot smuggle a bind');
    const evil = await a1.tool('soc.recover', { repo: 'evil/owner', issueNumber: 872012 });
    assert.equal(evil.ok, false); assert.ok(['TASK_NOT_FOUND', 'REPO_IDENTITY_UNRESOLVABLE'].includes(evil.reason));
    const exact = await a1.tool('soc.recover', { repo: RB.ownerRepoName, issueNumber: 872013 });
    assert.ok(exact.ok); assert.equal(exact.currentTaskIdentity.identityHash, B.identityHash, 'the EXACT bind still recovers cleanly');
    assert.equal(exact.execution.pid, B.pid);
    assert.equal(sessionCount(S), sessionsBefore, 'failed foreign attempts minted no task');
    assert.equal(execCount(S, A.identityHash), 1); assert.equal(execCount(S, B.identityHash), 1);
  } finally { if (a1) a1.kill(); for (const c of [...A.spawned, ...B.spawned]) { try { c.kill('SIGKILL'); } catch { /* gone */ } } }
});

// ------------------------------------------------------------- PHASE-7 detach --
test('PHASE7-DETACH PROCESS-BACKED: soc.submit_goal on the REAL lane-bound adapter process launches via the production DETACHED route worker -> SIGKILL that launching adapter -> executor + worker survive -> fresh adapter recovers the SAME pid, one ExecutionRecord', async () => {
  const R = makeRepo('duongpdddic-droid/disposable-rec-detach');
  const S = laneStateDir('detach');
  const lane = 'control-plane-detach';
  const DEPS = path.join(TMP, 'route-deps-detach.mjs');
  writeFileSync(DEPS, [
    "import { spawn as nodeSpawnFn } from 'node:child_process';",
    `const STUB = ${JSON.stringify(STUB)};`,
    "export const spawn = () => nodeSpawnFn(process.execPath, [STUB], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, __STUB_MS: '60000' } });",
    "export const resolveExecutable = () => ({ ok: true, executable: process.execPath, source: 'deterministic-test', candidates: [] });",
    "export const preflight = () => ({ ok: true, version: 'deterministic-test', agent: 'build', toolCaps: ['bash', 'edit', 'read', 'glob', 'grep', 'list'] });",
    "export const verifyAuthority = () => ({ ok: true });",
  ].join('\n'), 'utf8');
  const killPid = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
  let a1, a2, execPid = null, workerPid = null;
  try {
    a1 = startClientMcp({ stateDir: S, controlLane: lane, extraEnv: { SOC_CLIENT_TEST_EXECUTOR_DEPS: DEPS } });
    await a1.handshake();
    const sub = await a1.tool('soc.submit_goal', { targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, goal: 'detached production route', issueNumber: 872030 });
    assert.ok(sub.ok, JSON.stringify(sub));
    assert.ok(sub.execution && sub.execution.ok === true, JSON.stringify(sub.execution));
    assert.equal(sub.execution.status, 'RUNNING', 'the production default control launched through the detached worker within the bounded wait');
    assert.equal(sub.execution.detached, true);
    execPid = sub.execution.pid;
    assert.ok(Number.isInteger(execPid) && isAlive(execPid), 'real executor OS process is running');
    const resultFile = fs.readdirSync(path.join(S, 'client-mcp', 'routes')).find((f) => f.endsWith('.result.json'));
    assert.ok(resultFile, 'route result record exists');
    workerPid = JSON.parse(fs.readFileSync(path.join(S, 'client-mcp', 'routes', resultFile), 'utf8')).workerPid;
    assert.ok(Number.isInteger(workerPid) && isAlive(workerPid), 'the route worker supervises the executor independent of the adapter');
    const sess = readSessionRecord(sessionPathFor({ stateDir: S, identityHash: sub.identityHash })).session;
    assert.equal(sess.executionMode, 'executor', 'startExecution (in the worker) is still the sole bind writer');
    assert.equal(sess.mutationOwner.laneId, lane);
    // KILL THE VERY ADAPTER THAT LAUNCHED IT — the exact production manual-restart case.
    a1.kill('SIGKILL'); await a1.exited; a1 = null;
    assert.equal(isAlive(execPid), true, 'R0/PHASE7: killing the launching MCP adapter must NOT cancel the executor');
    assert.equal(isAlive(workerPid), true, 'the transport sibling (route worker) outlives the transport');
    a2 = startClientMcp({ stateDir: S }); await a2.handshake();
    const rec = await a2.tool('soc.recover', {});
    assert.ok(rec.ok, JSON.stringify(rec));
    assert.equal(rec.currentTaskIdentity.identityHash, sub.identityHash);
    assert.equal(rec.execution.pid, execPid, 'fresh adapter reattaches to the SAME execution');
    if (IS_WIN) assert.equal(rec.executionLiveness, 'RUNNING');
    assert.equal(execCount(S, sub.identityHash), 1, 'no duplicate ExecutionRecord through the detached route');
    assert.equal(sessionCount(S), 1);
  } finally {
    if (a1) a1.kill(); if (a2) a2.kill();
    if (execPid) killPid(execPid);
    if (workerPid) killPid(workerPid);
  }
});

// ------------------------------------------------------------------ PH2 UX ---
test('RECOVERED summary: soc.recover returns the exact operator-facing recovery line (transport=RECOVERED, same task, same execution, gate state)', async () => {
  const R = makeRepo('duongpdddic-droid/disposable-rec-sum');
  const S = laneStateDir('sum');
  const lane = 'control-plane-sum';
  const { spawned, pid } = admitAndLaunch({ stateDir: S, repo: R, lane, issueNumber: 872020 });
  let a1;
  try {
    a1 = startClientMcp({ stateDir: S }); await a1.handshake();
    const rec = await a1.tool('soc.recover', {});
    assert.ok(rec.ok);
    for (const k of ['transportState', 'currentTaskIdentity', 'executionLiveness', 'humanGateState', 'mutationOwner']) assert.ok(k in rec, `recovery reports ${k}`);
    for (const k of ['transportState', 'lastDisconnectAt', 'lastRestartAt', 'lastReattachAt', 'restartCount', 'currentTaskIdentity', 'executionLiveness', 'humanGateState']) assert.ok(k in rec.transport, `observability exposes ${k}`);
    assert.equal(JSON.stringify(rec).match(/leaseToken|SOC_SESSION_TOKEN|worktreePath|[A-Za-z]:\\\\Users|\\"stateDir\\"/i), null, 'no lease tokens / absolute canonical paths leak into the recovery report');
    assert.equal(rec.execution.pid, pid);
  } finally { if (a1) a1.kill(); for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* gone */ } } }
});
