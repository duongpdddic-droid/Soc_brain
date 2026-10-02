#!/usr/bin/env node
// gateway-mcp.test.mjs — P0 TUI Gateway MCP server contract.
// Deterministic/offline: injected client-control, disposable git fixtures, no
// network, no live OpenCode. Covers the single-tool surface, delegation, and
// the PRIMARY_DIRTY_REF_HEAD_REQUIRED fail-closed branch as it is seen by a
// caller on the MCP wire (i.e. through the gateway, not just at client-control).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  createGatewayMcpServer, GATEWAY_TOOL_NAME, GATEWAY_EXECUTION_STATUS,
} from '../packages/client-mcp/gateway-mcp.mjs';
import { createClientControl } from '../packages/client-mcp/client-control.mjs';
// Same identity probe the reconcile decision uses, so the G10 fixtures carry a
// REAL processStartTime for THIS pid instead of a guessed value.
import { readWin32ProcessStartTime } from '../packages/executor-launcher/executor-launcher.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-gw-'));

// Deterministic REAL executor stand-in + the sanctioned route test seam
// (SOC_CLIENT_TEST_EXECUTOR_DEPS — the same DI module route-worker.mjs accepts).
const STUB = path.join(TMP, 'gw-executor-stub.mjs');
fs.writeFileSync(STUB, [
  "const ms = Number(process.env.__STUB_MS || 30000);",
  "let n = 0; const tick = () => { try { process.stdout.write(JSON.stringify({ type: 'text', part: { text: 'gw step ' + (++n) }, t: Date.now() }) + '\\n'); } catch { } };",
  "tick(); const iv = setInterval(tick, 150);",
  "setTimeout(() => { clearInterval(iv); process.exit(0); }, ms);",
  "process.on('SIGTERM', () => process.exit(0));",
].join('\n'), 'utf8');

function makeRepo(ownerRepoName) {
  const dir = fs.mkdtempSync(path.join(TMP, 'repo-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  run(['init', '--initial-branch=main', dir]);
  run(['-C', dir, 'config', 'user.email', 't@e.x']);
  run(['-C', dir, 'config', 'user.name', 't']);
  // Tracked content (mirrors the canonical fixtures): the executor route resolves
  // its model from the provisioned worktree's opencode.json first.
  fs.writeFileSync(path.join(dir, 'opencode.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'r\n');
  run(['-C', dir, 'add', 'opencode.json']);
  run(['-C', dir, 'add', 'README.md']);
  run(['-C', dir, 'commit', '-m', 'init']);
  const sha = run(['-C', dir, 'rev-parse', 'HEAD']);
  run(['-C', dir, 'remote', 'add', 'origin', `https://github.com/${ownerRepoName}.git`]);
  run(['-C', dir, 'update-ref', 'refs/remotes/origin/main', sha]);
  return { dir, ownerRepoName, sha };
}

function newServer() {
  const control = createClientControl({
    stateDir: path.join(TMP, 'state-' + Math.random().toString(36).slice(2, 8)),
    worktreesRoot: path.join(TMP, 'wt'),
    controlLane: null,
  });
  return { server: createGatewayMcpServer({ control }), control };
}
const call = (server, params) => server.handleRequest({ jsonrpc: '2.0', id: 7, method: 'tools/call', params });
function payload(res) {
  assert.ok(res && res.result && res.result.content && res.result.content[0], `malformed result: ${JSON.stringify(res)}`);
  return JSON.parse(res.result.content[0].text);
}

// ---- helpers for execution-honesty assertions --------------------------------
const isAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
};
const killPid = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
function execRecordFiles(stateDir) {
  const dir = path.join(stateDir, 'executions');
  let files = []; try { files = fs.readdirSync(dir); } catch { return []; }
  return files.filter((f) => f.endsWith('.json') && !f.includes('events') && !f.includes('terminal'));
}
function countExecRecords(stateDir, identityHash) {
  return execRecordFiles(stateDir).filter((f) => f.startsWith(identityHash)).length;
}
function routeRequestFiles(stateDir) {
  const dir = path.join(stateDir, 'client-mcp', 'routes');
  let files = []; try { files = fs.readdirSync(dir); } catch { return []; }
  return files.filter((f) => !f.endsWith('.result.json'));
}
function laneEnv(stateDir, lane) {
  const env = { ...process.env, SOC_CONTROL_STATE_DIR: stateDir, SOC_CONTROL_WORKTREES_ROOT: path.join(TMP, 'wt') };
  if (lane) env.SOC_CONTROL_LANE = lane; else delete env.SOC_CONTROL_LANE;
  return env;
}

test('G1. initialize + tools/list expose exactly ONE tool: gateway', () => {
  const { server } = newServer();
  const init = server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.serverInfo.name, 'soc-brain-gateway');
  const list = server.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), [GATEWAY_TOOL_NAME]);
  assert.deepEqual(list.result.tools[0].inputSchema.properties.operation.enum, ['submit', 'status', 'recover']);
  // P0: the execution-claim vocabulary is part of the published contract, so an
  // agent reading tools/list cannot be misled about what an answer means.
  for (const s of GATEWAY_EXECUTION_STATUS) {
    assert.ok(list.result.tools[0].description.includes(s), `tool description must document ${s}`);
  }
});

test('G2. any tool other than gateway is rejected by the server', () => {
  const { server } = newServer();
  for (const name of ['bash', 'edit', 'task', 'read', 'soc.submit_goal']) {
    const res = call(server, { name, arguments: {} });
    assert.equal(res.error.code, -32601, `${name}: ${JSON.stringify(res)}`);
    assert.match(res.error.message, /Unknown tool/);
  }
});

test('G3. submit on a DIRTY primary checkout without targetRef/expectedHead fails closed ON THE WIRE', () => {
  const { server } = newServer();
  const R = makeRepo('duongpdddic-droid/gw-dirty');
  fs.writeFileSync(path.join(R.dir, 'README.md'), 'uncommitted\n');

  const res = call(server, {
    name: GATEWAY_TOOL_NAME,
    arguments: { operation: 'submit', goal: 'gw goal', targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, clientRequestId: 'gw-dirty-0001' },
  });

  assert.equal(res.result.isError, true, JSON.stringify(res));
  const p = payload(res);
  assert.equal(p.ok, false);
  assert.equal(p.reason, 'PRIMARY_DIRTY_REF_HEAD_REQUIRED');
  assert.ok(p.dirtyPaths.includes('README.md'), JSON.stringify(p));
  // Fail-closed before taskStart: no session, no burned task number.
  assert.ok(!fs.existsSync(path.join(server.control.config.stateDir, 'sessions')), 'no session');
  assert.ok(!fs.existsSync(path.join(server.control.config.stateDir, 'local-tasks', 'sequence.json')), 'no task number');
});

test('G4. the SAME submit on a clean checkout is admitted through the gateway', () => {
  const { server } = newServer();
  const R = makeRepo('duongpdddic-droid/gw-clean');

  const res = call(server, {
    name: GATEWAY_TOOL_NAME,
    arguments: { operation: 'submit', goal: 'gw clean goal', targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, clientRequestId: 'gw-clean-0001' },
  });

  const p = payload(res);
  assert.ok(p.ok, JSON.stringify(p));
  assert.equal(p.admitted, true);
  assert.equal(res.result.isError, false);
  // This server has no control lane, so no route is wired: the answer must be
  // honestly admitted-only and must NOT claim an execution.
  assert.equal(p.executionStatus, 'ADMITTED_ONLY');
  assert.equal(p.execution, null, 'no route -> no execution object at all');
  assert.equal(routeRequestFiles(server.control.config.stateDir).length, 0, 'no route request without a control lane');
});

test('G5. unknown operation and read-only status stay fail-closed / non-mutating', () => {
  const { server } = newServer();
  const bad = payload(call(server, { name: GATEWAY_TOOL_NAME, arguments: { operation: 'rm-rf' } }));
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'GATEWAY_OPERATION_UNKNOWN');

  const status = payload(call(server, { name: GATEWAY_TOOL_NAME, arguments: { operation: 'status', repo: 'duongpdddic-droid/none', issueNumber: 1 } }));
  assert.equal(status.ok, false);
  assert.equal(status.reason, 'TASK_NOT_FOUND');
  assert.ok(!fs.existsSync(path.join(server.control.config.stateDir, 'sessions')), 'status must not create state');
});

// ---------------------------------------------------------------------------
// P0 REWORK — Req 1: production route wiring + admitted-only vs execution truth
// ---------------------------------------------------------------------------

test('G6. WITHOUT a control lane the gateway wires NO route: submit is admitted-only, zero route requests, zero executors', () => {
  const stateDir = path.join(TMP, 'state-g6');
  fs.mkdirSync(stateDir, { recursive: true });
  const server = createGatewayMcpServer({ env: laneEnv(stateDir, null) });
  assert.equal(server.control.config.controlLane, null, 'lane must stay unbound without SOC_CONTROL_LANE');
  assert.equal(server.control.config.stateDir, stateDir);

  const R = makeRepo('duongpdddic-droid/gw-nolane');
  const p = payload(call(server, {
    name: GATEWAY_TOOL_NAME,
    arguments: { operation: 'submit', goal: 'gw no-lane goal', targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, clientRequestId: 'gw-nolane-0001' },
  }));

  assert.ok(p.ok, JSON.stringify(p));
  assert.equal(p.admitted, true);
  assert.equal(p.executionStatus, 'ADMITTED_ONLY', 'admission without a lane must be reported as admitted-only');
  assert.equal(p.execution, null, 'no route is wired, so there is nothing to claim');
  assert.equal(routeRequestFiles(stateDir).length, 0, 'the detached route must not be invoked at all');
  assert.equal(execRecordFiles(stateDir).length, 0, 'no ExecutionRecord may exist');
});

test('G7. WITH a trusted lane the gateway uses the EXISTING detached production route: exactly ONE executor, status reads its process', () => {
  const stateDir = path.join(TMP, 'state-g7');
  fs.mkdirSync(stateDir, { recursive: true });
  const DEPS = path.join(TMP, 'gw-route-deps.mjs');
  fs.writeFileSync(DEPS, [
    "import { spawn as nodeSpawnFn } from 'node:child_process';",
    `const STUB = ${JSON.stringify(STUB)};`,
    "export const spawn = () => nodeSpawnFn(process.execPath, [STUB], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, __STUB_MS: '60000' } });",
    "export const resolveExecutable = () => ({ ok: true, executable: process.execPath, source: 'deterministic-test', candidates: [] });",
    "export const preflight = () => ({ ok: true, version: 'deterministic-test', agent: 'build', toolCaps: ['bash', 'edit', 'read', 'glob', 'grep', 'list'] });",
    "export const verifyAuthority = () => ({ ok: true });",
  ].join('\n'), 'utf8');

  // Operator-pinned availability set (the documented offline availability
  // source in model-resolution.mjs): `resolveAvailableModels` prefers it over
  // spawning `opencode models`, so the detached worker proves model availability
  // deterministically without touching the network or the real CLI.
  const savedEnv = {
    DEPS: process.env.SOC_CLIENT_TEST_EXECUTOR_DEPS,
    MODEL: process.env.SOC_MODEL,
    AVAILABLE: process.env.SOC_MODELS_AVAILABLE,
  };
  let execPid = null, workerPid = null;
  process.env.SOC_CLIENT_TEST_EXECUTOR_DEPS = DEPS;
  process.env.SOC_MODEL = 'nine-router/Soc_OR_free_act';
  process.env.SOC_MODELS_AVAILABLE = 'nine-router/Soc_OR_free_act opencode/nemotron-3-ultra-free';
  try {
    const server = createGatewayMcpServer({ env: laneEnv(stateDir, 'control-plane-gw') });
    assert.equal(server.control.config.controlLane, 'control-plane-gw', 'lane must be read from trusted config');

    const R = makeRepo('duongpdddic-droid/gw-lane');
    const args = { operation: 'submit', goal: 'gw production route goal', targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, clientRequestId: 'gw-lane-0001' };
    const p1 = payload(call(server, { name: GATEWAY_TOOL_NAME, arguments: args }));

    assert.ok(p1.ok, JSON.stringify(p1));
    assert.equal(p1.admitted, true);
    assert.equal(p1.executionStatus, 'EXECUTING', 'a bound, live ExecutionRecord is the only way to claim execution');
    assert.ok(p1.execution && p1.execution.ok === true, JSON.stringify(p1.execution));
    assert.equal(p1.execution.status, 'RUNNING', 'the detached route reached RUNNING within its bounded wait');
    assert.equal(p1.execution.detached, true, 'the executor is launched by the detached worker, not by this process');
    execPid = p1.execution.pid;
    assert.ok(Number.isInteger(execPid) && isAlive(execPid), `executor pid ${execPid} must be a live OS process`);
    assert.equal(p1.executionRecord.pid, execPid, 'the reported record binds the same pid');
    assert.equal(p1.executionRecord.identityProven, true, 'pid + processStartTime identity is proven');

    // ---- "exactly ONE Executor" ----
    assert.equal(execRecordFiles(stateDir).length, 1, 'exactly one canonical ExecutionRecord in this stateDir');
    assert.equal(countExecRecords(stateDir, p1.identityHash), 1, 'exactly one record for this identity');
    assert.equal(routeRequestFiles(stateDir).length, 1, 'exactly one route request -> one detached launch');
    const resultFile = fs.readdirSync(path.join(stateDir, 'client-mcp', 'routes')).find((f) => f.endsWith('.result.json'));
    assert.ok(resultFile, 'the detached worker wrote its result');
    workerPid = JSON.parse(fs.readFileSync(path.join(stateDir, 'client-mcp', 'routes', resultFile), 'utf8')).workerPid;
    assert.ok(Number.isInteger(workerPid) && isAlive(workerPid), 'the route worker supervises the executor');

    // ---- status reads the execution truth ----
    const st = payload(call(server, { name: GATEWAY_TOOL_NAME, arguments: { operation: 'status', repo: p1.repo, issueNumber: p1.issueNumber } }));
    assert.ok(st.ok, JSON.stringify(st));
    assert.equal(st.progress.execution.pid, execPid, 'status exposes the same executor pid');
    assert.equal(st.progress.execution.identityHash, p1.identityHash);
    assert.equal(st.progress.execution.liveness, 'RUNNING', 'liveness is read from the live process, not assumed');
    // status carries the SAME top-level execution projection as submit, so an
    // agent never has to infer EXECUTING from progress.execution.
    assert.equal(st.executionStatus, 'EXECUTING', 'status must project EXECUTING for a proven RUNNING record');
    assert.equal(st.reconcileRequired, false, 'a proven RUNNING record needs no reconcile');
    assert.equal(st.executionRecord.identityProven, true, 'EXECUTING requires proven identity');
    assert.equal(st.executionRecord.pid, execPid, 'the status record binds the same pid');

    // ---- retry with the SAME clientRequestId must not mint a second executor ----
    const p2 = payload(call(server, { name: GATEWAY_TOOL_NAME, arguments: args }));
    assert.ok(p2.ok, JSON.stringify(p2));
    assert.equal(p2.replayed, true, 'same clientRequestId -> replay of the canonical submission');
    assert.equal(p2.identityHash, p1.identityHash, 'the retry reconciles to the SAME canonical task');
    assert.equal(p2.executionStatus, 'EXECUTING', 'the replay is still projected through the execution-honesty gate');
    assert.equal(p2.executionRecord.pid, execPid, 'the replay reports the SAME execution, not a new one');
    assert.equal(execRecordFiles(stateDir).length, 1, 'a retry must never create a second ExecutionRecord');
    assert.equal(routeRequestFiles(stateDir).length, 1, 'a retry must never issue a second route request');
  } finally {
    const restore = (key, v) => { if (v === undefined) delete process.env[key]; else process.env[key] = v; };
    restore('SOC_CLIENT_TEST_EXECUTOR_DEPS', savedEnv.DEPS);
    restore('SOC_MODEL', savedEnv.MODEL);
    restore('SOC_MODELS_AVAILABLE', savedEnv.AVAILABLE);
    if (execPid) killPid(execPid);
    if (workerPid) killPid(workerPid);
  }
});

test('G8. a route claim with NO canonical ExecutionRecord is downgraded to UNDETERMINED (never EXECUTING, never ADMITTED_ONLY)', () => {
  const stateDir = path.join(TMP, 'state-g8');
  fs.mkdirSync(stateDir, { recursive: true });
  // A route that LIES: it answers "RUNNING" but never writes a record (the exact
  // failure the honesty gate exists to catch). A route WAS invoked, so this is
  // NOT admitted-only either: the true state is undetermined until reconciled.
  const control = createClientControl({
    stateDir,
    worktreesRoot: path.join(TMP, 'wt'),
    controlLane: 'lane-x',
    routeExecutor: () => ({ ok: true, status: 'RUNNING', pid: 9999999, detached: true }),
  });
  const server = createGatewayMcpServer({ control });

  const R = makeRepo('duongpdddic-droid/gw-fakeroute');
  const p = payload(call(server, {
    name: GATEWAY_TOOL_NAME,
    arguments: { operation: 'submit', goal: 'gw fake route', targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, clientRequestId: 'gw-fake-0001' },
  }));

  assert.ok(p.ok, 'admission itself still stands');
  assert.equal(p.admitted, true);
  // Field-level assertions (not a JSON.stringify substring search): every claim
  // that could be mistaken for a real execution is checked where it lives.
  assert.equal(p.executionStatus, 'UNDETERMINED', 'a route-invoked answer with no record is undetermined, not EXECUTING/ADMITTED_ONLY');
  assert.equal(p.executionStatusReason, 'NO_EXECUTION_RECORD', 'the real reason is surfaced verbatim');
  assert.equal(p.reconcileRequired, true, 'an undetermined state always asks for a reconcile');
  assert.equal(p.executionRecord, null, 'no record facts may be invented');
  assert.equal(execRecordFiles(stateDir).length, 0, 'there really is no record');
  assert.ok(p.execution && typeof p.execution === 'object', 'the route answer is present but rewritten');
  assert.equal(p.execution.ok, false, 'the unbacked route claim must not be forwarded as success');
  assert.equal(p.execution.status, 'UNDETERMINED', 'execution.status must agree with executionStatus');
  assert.equal(p.execution.reason, 'NO_EXECUTION_RECORD');
  assert.ok(!('pid' in p.execution), 'the fake pid must not be forwarded');
  assert.ok(!('detached' in p.execution), 'the fake detached flag must not be forwarded');
  assert.equal(p.executionRecord, null, 'the fake pid must not appear as record facts');
});

// ---------------------------------------------------------------------------
// P0 REWORK r3 — Req: execution truth projection covers EVERY record branch
// ---------------------------------------------------------------------------

test('G10. status and submit-replay project UNDETERMINED/EXECUTION_ENDED from latched, gone, reused, unproven, corrupt and terminal records', () => {
  const stateDir = path.join(TMP, 'state-g10');
  fs.mkdirSync(stateDir, { recursive: true });
  const server = createGatewayMcpServer({ env: laneEnv(stateDir, null) });

  const R = makeRepo('duongpdddic-droid/gw-branches');
  const args = { operation: 'submit', goal: 'gw branches goal', targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, clientRequestId: 'gw-branch-0001' };
  const p1 = payload(call(server, { name: GATEWAY_TOOL_NAME, arguments: args }));
  assert.ok(p1.ok, JSON.stringify(p1));
  assert.equal(p1.executionStatus, 'ADMITTED_ONLY', 'baseline: no lane, no record');
  const recordPath = path.join(stateDir, 'executions', `${p1.identityHash}.json`);
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });

  const myStart = readWin32ProcessStartTime(process.pid);
  const base = {
    schemaVersion: '1',
    identityHash: p1.identityHash,
    repo: p1.repo,
    issueNumber: p1.issueNumber,
    taskId: p1.taskId ?? null,
    pendingExecutorBind: false,
    cleanupRequired: false,
    terminalStatus: null,
    finalized: false,
  };
  const writeRecord = (fields) => fs.writeFileSync(recordPath, JSON.stringify({ ...base, ...fields }), 'utf8');
  // A pid that is provably gone: a child we already reaped.
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  const deadPid = dead.pid;
  assert.ok(Number.isInteger(deadPid), 'the fixture child has a pid');
  assert.equal(isAlive(deadPid), false, 'the fixture child must be dead');

  const cases = [
    {
      name: 'latched (pending bind) short-circuits before any RUNNING proof',
      fields: { pid: process.pid, processStartTime: myStart ? myStart.processStartTime : null, pendingExecutorBind: true },
      status: 'UNDETERMINED', reason: 'EXECUTOR_RECONCILIATION_REQUIRED', reconcile: true, liveness: null, proven: false,
    },
    {
      name: 'cleanup-required latch is also undetermined',
      fields: { pid: process.pid, processStartTime: myStart ? myStart.processStartTime : null, cleanupRequired: true },
      status: 'UNDETERMINED', reason: 'EXECUTOR_RECONCILIATION_REQUIRED', reconcile: true, liveness: null, proven: false,
    },
    {
      name: 'a gone pid is undetermined (reconcile), never EXECUTING',
      fields: { pid: deadPid, processStartTime: 1 },
      status: 'UNDETERMINED', reason: 'PID_GONE', reconcile: true, liveness: 'EXITED', proven: true,
    },
    {
      name: 'a live pid with a DIFFERENT start time is a reused pid',
      // NB: this Win32 start time is ~1.3e17, where Number.ULP === 16, so a +1
      // delta would silently round back to the same value and prove nothing.
      fields: { pid: process.pid, processStartTime: (myStart && myStart.processStartTime != null) ? Number(myStart.processStartTime) + 1000000 : 1000000 },
      status: 'UNDETERMINED', reason: 'START_TIME_MISMATCH', reconcile: true, liveness: 'PID_REUSED', proven: false,
    },
    {
      name: 'a live pid with NO recorded start time is unproven ownership',
      fields: { pid: process.pid, processStartTime: null },
      status: 'UNDETERMINED', reason: 'NO_RECORDED_START_TIME', reconcile: true, liveness: 'OWNERSHIP_UNKNOWN', proven: false,
    },
    {
      name: 'a terminal record reports the ended execution verbatim',
      fields: { pid: deadPid, processStartTime: 1, terminalStatus: 'COMPLETED' },
      status: 'EXECUTION_ENDED', reason: 'TERMINAL', reconcile: false, liveness: 'COMPLETED', proven: true,
    },
  ];

  for (const c of cases) {
    writeRecord(c.fields);
    const st = payload(call(server, { name: GATEWAY_TOOL_NAME, arguments: { operation: 'status', repo: p1.repo, issueNumber: p1.issueNumber } }));
    assert.ok(st.ok, `${c.name}: ${JSON.stringify(st)}`);
    assert.equal(st.executionStatus, c.status, `${c.name}: status executionStatus`);
    assert.equal(st.executionStatusReason, c.reason, `${c.name}: status reason`);
    assert.equal(st.reconcileRequired, c.reconcile, `${c.name}: status reconcileRequired`);
    if (st.executionStatus !== 'ADMITTED_ONLY') {
      assert.equal(st.executionRecord.liveness, c.liveness, `${c.name}: status liveness`);
      assert.equal(st.executionRecord.identityProven, c.proven, `${c.name}: status identityProven`);
    }

    const rp = payload(call(server, { name: GATEWAY_TOOL_NAME, arguments: args }));
    assert.ok(rp.ok, `${c.name}: ${JSON.stringify(rp)}`);
    assert.equal(rp.replayed, true, `${c.name}: same clientRequestId stays idempotent`);
    assert.equal(rp.executionStatus, c.status, `${c.name}: submit-replay executionStatus`);
    assert.equal(rp.executionStatusReason, c.reason, `${c.name}: submit-replay reason`);
    assert.equal(rp.reconcileRequired, c.reconcile, `${c.name}: submit-replay reconcileRequired`);
    if (rp.executionStatus !== 'ADMITTED_ONLY') {
      assert.equal(rp.executionRecord.liveness, c.liveness, `${c.name}: submit-replay liveness`);
      assert.equal(rp.executionRecord.identityProven, c.proven, `${c.name}: submit-replay identityProven`);
    }
  }

  // Unreadable/corrupt record -> undetermined with the record's real reason.
  fs.writeFileSync(recordPath, '{not json', 'utf8');
  for (const op of [
    { operation: 'status', repo: p1.repo, issueNumber: p1.issueNumber },
    args,
  ]) {
    const r = payload(call(server, { name: GATEWAY_TOOL_NAME, arguments: op }));
    assert.equal(r.executionStatus, 'UNDETERMINED', `corrupt record: ${JSON.stringify(r)}`);
    assert.equal(r.executionStatusReason, 'EXECUTION_RECORD_INVALID', 'the real read error is surfaced');
    assert.equal(r.reconcileRequired, true);
    assert.equal(r.executionRecord, null, 'no record facts may be invented from a corrupt file');
  }
});

// ---------------------------------------------------------------------------
// P0 REWORK r4 — Req 1: ONE state per response (no contradictory execution)
// ---------------------------------------------------------------------------

test('G11. a route answering RUNNING while the canonical record is already terminal comes back ENDED everywhere — no RUNNING survives', () => {
  const stateDir = path.join(TMP, 'state-g11');
  fs.mkdirSync(stateDir, { recursive: true });
  // A fixture child we already reaped: a REAL pid that is provably gone.
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  const recordPid = dead.pid;
  assert.ok(Number.isInteger(recordPid), 'the fixture child has a pid');
  assert.equal(isAlive(recordPid), false, 'the fixture child must be dead');

  let routeSawHash = null;
  const control = createClientControl({
    stateDir,
    worktreesRoot: path.join(TMP, 'wt'),
    controlLane: 'lane-g11',
    // The route LIES at the exact moment the gateway answers: the canonical
    // record is already terminal, while the route still claims RUNNING (and a
    // pid that is not even the record's). This is the r3 leftover where the
    // top-level said EXECUTION_ENDED but execution.status stayed RUNNING.
    routeExecutor: ({ session } = {}) => {
      routeSawHash = session && session.identityHash;
      const recordPath = path.join(stateDir, 'executions', `${session.identityHash}.json`);
      fs.mkdirSync(path.dirname(recordPath), { recursive: true });
      fs.writeFileSync(recordPath, JSON.stringify({
        schemaVersion: '1',
        identityHash: session.identityHash,
        repo: session.repo,
        issueNumber: session.issueNumber,
        taskId: session.taskId ?? null,
        pid: recordPid,
        processStartTime: 1,
        pendingExecutorBind: false,
        cleanupRequired: false,
        terminalStatus: 'COMPLETED',
        finalized: true,
      }), 'utf8');
      return { ok: true, status: 'RUNNING', pid: 9999999, detached: true };
    },
  });
  const server = createGatewayMcpServer({ control });

  const R = makeRepo('duongpdddic-droid/gw-terminal');
  const p = payload(call(server, {
    name: GATEWAY_TOOL_NAME,
    arguments: { operation: 'submit', goal: 'gw terminal truth', targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, clientRequestId: 'gw-term-0001' },
  }));

  assert.ok(p.ok, JSON.stringify(p));
  assert.equal(p.admitted, true);
  assert.ok(routeSawHash, 'the route really was invoked');

  // ---- top-level: ended, from the canonical record ----
  assert.equal(p.executionStatus, 'EXECUTION_ENDED');
  assert.equal(p.executionStatusReason, 'TERMINAL');
  assert.equal(p.reconcileRequired, false);
  assert.equal(p.executionRecord.terminalStatus, 'COMPLETED');
  assert.equal(p.executionRecord.pid, recordPid, 'record facts carry the canonical pid');
  assert.equal(p.executionRecord.liveness, 'COMPLETED');

  // ---- execution: normalized to the SAME projection — the lie never survives ----
  assert.ok(p.execution && typeof p.execution === 'object', JSON.stringify(p.execution));
  assert.notEqual(p.execution.status, 'RUNNING', 'the route RUNNING claim must not survive a terminal record');
  assert.equal(p.execution.status, 'COMPLETED', 'execution.status reports the terminal status verbatim');
  assert.equal(p.execution.terminalStatus, 'COMPLETED');
  assert.equal(p.execution.pid, recordPid, 'pid comes from the canonical record, never from the route');
  assert.notEqual(p.execution.pid, 9999999, 'the route pid must not be forwarded');
  assert.equal(p.execution.ok, true, 'a proven terminal answer is a real answer');
  assert.equal(p.execution.detached, true, 'the transport fact is kept');
  assert.ok(!JSON.stringify(p.execution).includes('RUNNING'), `no RUNNING anywhere: ${JSON.stringify(p.execution)}`);

  // ---- status sees the SAME ended state ----
  const st = payload(call(server, { name: GATEWAY_TOOL_NAME, arguments: { operation: 'status', repo: p.repo, issueNumber: p.issueNumber } }));
  assert.ok(st.ok, JSON.stringify(st));
  assert.equal(st.executionStatus, 'EXECUTION_ENDED', 'status agrees with submit');
  assert.equal(st.executionRecord.terminalStatus, 'COMPLETED');
  assert.equal(st.progress.execution.status, 'COMPLETED', 'progress evidence is the canonical terminal status too');
});

// ---------------------------------------------------------------------------
// P0 REWORK r4 — Req 2: only ENOENT means "no route request"; read errors are
// UNDETERMINED (never ADMITTED_ONLY)
// ---------------------------------------------------------------------------

test('G12. an unreadable route-request dir (ENOTDIR) projects UNDETERMINED — never ADMITTED_ONLY — on submit, replay and status', () => {
  const stateDir = path.join(TMP, 'state-g12');
  // `client-mcp/routes` exists as a FILE -> readdirSync fails with ENOTDIR.
  fs.mkdirSync(path.join(stateDir, 'client-mcp'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'client-mcp', 'routes'), 'I am a file, not a dir\n', 'utf8');
  const server = createGatewayMcpServer({ env: laneEnv(stateDir, null) });

  const expectUndetermined = (r, label) => {
    assert.ok(r, label);
    assert.equal(r.executionStatus, 'UNDETERMINED', `${label}: ${JSON.stringify(r)}`);
    assert.equal(r.executionStatusReason, 'ROUTE_REQUEST_READ_FAILED', `${label}: reason names the read failure`);
    assert.equal(r.reconcileRequired, true, `${label}: undetermined always asks for reconcile`);
    assert.notEqual(r.executionStatus, 'ADMITTED_ONLY', `${label}: a read failure must never be reported as admitted-only`);
    assert.match(String(r.executionStatusDetail), /ENOTDIR/, `${label}: the real read error is surfaced: ${r.executionStatusDetail}`);
    assert.equal(r.executionRecord, null, `${label}: no record facts may be invented`);
  };

  const R = makeRepo('duongpdddic-droid/gw-notdir');
  const args = { operation: 'submit', goal: 'gw unreadable routes', targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, clientRequestId: 'gw-notdir-0001' };

  // ---- fresh submit (no `execution` key -> the dir is the only evidence) ----
  const p1 = payload(call(server, { name: GATEWAY_TOOL_NAME, arguments: args }));
  assert.ok(p1.ok, JSON.stringify(p1));
  assert.equal(p1.admitted, true, 'admission itself still stands');
  expectUndetermined(p1, 'submit');
  assert.equal(p1.execution, null, 'there is no route answer to normalize');

  // ---- idempotent replay of the SAME clientRequestId ----
  const p2 = payload(call(server, { name: GATEWAY_TOOL_NAME, arguments: args }));
  assert.equal(p2.replayed, true, 'same clientRequestId stays idempotent');
  expectUndetermined(p2, 'replay');

  // ---- read-only status ----
  const st = payload(call(server, { name: GATEWAY_TOOL_NAME, arguments: { operation: 'status', repo: p1.repo, issueNumber: p1.issueNumber } }));
  assert.ok(st.ok, JSON.stringify(st));
  expectUndetermined(st, 'status');
});

// ---------------------------------------------------------------------------
// P0 REWORK r5 — Req: a FAILED route keeps its structured diagnostics instead
// of being flattened into the generic NO_EXECUTION_RECORD
// ---------------------------------------------------------------------------

test('G13. a route FAILURE with no ExecutionRecord stays UNDETERMINED and keeps its reason/code/detail verbatim (never EXECUTING, never NO_EXECUTION_RECORD)', () => {
  const cases = [
    {
      name: 'structured route error (MODEL_UNRESOLVED)',
      // The canonical shape createCanonicalRouteExecutor returns for a failed
      // model resolution: reason/code/detail as separate fields, plus an
      // unverified pid the gateway must never forward.
      route: () => ({
        ok: false,
        status: 'MODEL_UNRESOLVED',
        reason: 'MODEL_UNRESOLVED',
        code: 'MODEL_UNRESOLVED',
        detail: 'model probe failed: availability not provable',
        pid: 9999999,
        detached: true,
      }),
      reason: 'MODEL_UNRESOLVED',
      code: 'MODEL_UNRESOLVED',
      detail: 'model probe failed: availability not provable',
    },
    {
      name: 'route throws before it can answer',
      route: () => { throw new Error('route worker crashed before launch'); },
      reason: 'ROUTE_ERROR',
      code: null,
      detail: 'route worker crashed before launch',
    },
  ];

  cases.forEach((c, i) => {
    const stateDir = path.join(TMP, `state-g13-${i}`);
    fs.mkdirSync(stateDir, { recursive: true });
    const control = createClientControl({
      stateDir,
      worktreesRoot: path.join(TMP, 'wt'),
      controlLane: 'lane-g13',
      routeExecutor: c.route,
    });
    const server = createGatewayMcpServer({ control });
    const R = makeRepo(`duongpdddic-droid/gw-routefail-${i}`);
    const p = payload(call(server, {
      name: GATEWAY_TOOL_NAME,
      arguments: { operation: 'submit', goal: 'gw route failure', targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, clientRequestId: `gw-rfail-000${i}` },
    }));

    // ---- fail-closed state: UNDETERMINED, never EXECUTING ----
    assert.ok(p.ok, `${c.name}: ${JSON.stringify(p)}`);
    assert.equal(p.admitted, true, `${c.name}: admission itself still stands`);
    assert.equal(p.executionStatus, 'UNDETERMINED', c.name);
    assert.notEqual(p.executionStatus, 'EXECUTING', c.name);
    assert.equal(p.reconcileRequired, true, c.name);
    assert.equal(p.executionRecord, null, `${c.name}: no record may be invented`);
    assert.equal(execRecordFiles(stateDir).length, 0, `${c.name}: no ExecutionRecord exists`);

    // ---- the REAL cause is reported, not the generic NO_EXECUTION_RECORD ----
    assert.equal(p.executionStatusReason, c.reason, `${c.name}: reason comes from the route`);
    assert.notEqual(p.executionStatusReason, 'NO_EXECUTION_RECORD',
      `${c.name}: the generic cause must not swallow the route error`);
    assert.ok(String(p.executionStatusDetail).includes(c.detail),
      `${c.name}: the operator-facing detail carries the route detail: ${p.executionStatusDetail}`);

    // ---- structured diagnostics, verbatim and free of unverified claims ----
    assert.ok(p.routeDiagnostics && typeof p.routeDiagnostics === 'object', `${c.name}: routeDiagnostics present`);
    assert.equal(p.routeDiagnostics.ok, false, c.name);
    assert.equal(p.routeDiagnostics.status, c.reason, c.name);
    assert.equal(p.routeDiagnostics.reason, c.reason, c.name);
    assert.equal(p.routeDiagnostics.code, c.code, c.name);
    assert.equal(p.routeDiagnostics.detail, c.detail, `${c.name}: detail preserved verbatim`);
    assert.ok(!('pid' in p.routeDiagnostics), `${c.name}: no unverified pid in diagnostics`);

    // ---- execution mirrors the SAME projection: no RUNNING, no unverified pid ----
    assert.ok(p.execution && typeof p.execution === 'object', `${c.name}: execution object present`);
    assert.equal(p.execution.ok, false, c.name);
    assert.equal(p.execution.status, 'UNDETERMINED', `${c.name}: execution.status agrees with executionStatus`);
    assert.equal(p.execution.reason, c.reason, `${c.name}: execution.reason is the real cause`);
    assert.ok(String(p.execution.detail).includes(c.detail), `${c.name}: execution.detail carries the route detail`);
    assert.notEqual(p.execution.status, 'RUNNING', c.name);
    assert.ok(!('pid' in p.execution), `${c.name}: the route pid must not be forwarded`);
    assert.ok(!('detached' in p.execution), `${c.name}: no detached claim without a proven record`);
    assert.ok(!JSON.stringify(p.execution).includes('9999999'), `${c.name}: the unverified pid appears nowhere`);
    assert.ok(!JSON.stringify({ routeDiagnostics: p.routeDiagnostics }).includes('9999999'),
      `${c.name}: the unverified pid appears nowhere in diagnostics`);
  });
});

// ---------------------------------------------------------------------------
// GAP-3 — ADMITTED_ONLY must NAME why no route exists instead of staying vague.
// The status vocabulary and the "no execution object" rule are UNCHANGED: only
// executionStatusReason / executionStatusDetail gain the missing signature.
// ---------------------------------------------------------------------------

test('G14. no control lane: ADMITTED_ONLY now names CONTROL_LANE_UNCONFIGURED (execution stays null)', () => {
  const stateDir = path.join(TMP, 'state-g14');
  fs.mkdirSync(stateDir, { recursive: true });
  const server = createGatewayMcpServer({ env: laneEnv(stateDir, null) });
  assert.equal(server.control.config.controlLane, null, 'lane must stay unbound without SOC_CONTROL_LANE');

  const R = makeRepo('duongpdddic-droid/gw-nolane-reason');
  const p = payload(call(server, {
    name: GATEWAY_TOOL_NAME,
    arguments: { operation: 'submit', goal: 'gw no-lane reason', targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, clientRequestId: 'gw-nolane-r-0001' },
  }));

  assert.ok(p.ok, JSON.stringify(p));
  assert.equal(p.admitted, true);
  // The CLAIM is unchanged: admission only, no execution.
  assert.equal(p.executionStatus, 'ADMITTED_ONLY', 'the vocabulary must not change (G6 contract)');
  assert.equal(p.executionStatusReason, 'CONTROL_LANE_UNCONFIGURED', 'the answer now NAMES the missing lane');
  assert.match(String(p.executionStatusDetail), /SOC_CONTROL_LANE/, `detail must name the lane source: ${p.executionStatusDetail}`);
  assert.match(String(p.executionStatusDetail), /no route was wired/i, `detail must stay admitted-only: ${p.executionStatusDetail}`);
  assert.equal(p.execution, null, 'no route -> no execution object at all');
  assert.equal(p.executionRecord, null, 'no record facts may be invented');
  assert.equal(p.reconcileRequired, false, 'admission without a lane still needs no reconcile');
  assert.equal(routeRequestFiles(stateDir).length, 0, 'the detached route must not be invoked at all');
  assert.equal(execRecordFiles(stateDir).length, 0, 'no ExecutionRecord may exist');

  // GAP-2 on the REAL gateway wire: the admission answer carries the canonical
  // telegramDispatch evidence (submitGoal surfaces it, withExecutionTruth forwards
  // it verbatim). Only membership in the truthful status set is asserted - this
  // fixture's state root is NOT the canonical control-plane root, so the dispatch is
  // gated to NOT_ATTEMPTED and never reaches the network.
  assert.ok(p.telegramDispatch !== null && typeof p.telegramDispatch === 'object',
    'gateway submit must surface telegramDispatch: ' + JSON.stringify(p.telegramDispatch));
  assert.ok(['API_ACCEPTED', 'NOT_ATTEMPTED', 'DELIVERY_FAILED'].includes(p.telegramDispatch.status),
    'telegramDispatch.status must be truthful: ' + JSON.stringify(p.telegramDispatch));

  // The SAME reason must come from the read-only status operation (call site 2), so
  // submit and status can never disagree about why no route was wired.
  const st = payload(call(server, { name: GATEWAY_TOOL_NAME, arguments: { operation: 'status', repo: p.repo, issueNumber: p.issueNumber } }));
  assert.ok(st.ok, JSON.stringify(st));
  assert.equal(st.executionStatus, 'ADMITTED_ONLY');
  assert.equal(st.executionStatusReason, 'CONTROL_LANE_UNCONFIGURED');
  assert.equal(st.executionRecord, null, 'status must not invent record facts');
});

test('G15. lane configured but no route wired: ADMITTED_ONLY names CANONICAL_ROUTE_MISSING (execution stays null)', () => {
  const stateDir = path.join(TMP, 'state-g15');
  fs.mkdirSync(stateDir, { recursive: true });
  // A TRUSTED lane IS configured, but deliberately NO routeExecutor is injected,
  // so nothing is spawned and no route request is ever written. The admitted-only
  // answer must say THAT, not pretend the lane is missing.
  const control = createClientControl({
    stateDir,
    worktreesRoot: path.join(TMP, 'wt'),
    controlLane: 'control-plane-gw',
  });
  const server = createGatewayMcpServer({ control });
  assert.equal(server.control.config.controlLane, 'control-plane-gw', 'the lane is configured');

  const R = makeRepo('duongpdddic-droid/gw-lane-noroute');
  const p = payload(call(server, {
    name: GATEWAY_TOOL_NAME,
    arguments: { operation: 'submit', goal: 'gw lane without route', targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, clientRequestId: 'gw-lane-noroute-0001' },
  }));

  assert.ok(p.ok, JSON.stringify(p));
  assert.equal(p.admitted, true);
  assert.equal(p.executionStatus, 'ADMITTED_ONLY', 'the vocabulary must not change (G6 contract)');
  assert.equal(p.executionStatusReason, 'CANONICAL_ROUTE_MISSING', 'a configured lane with no route request is now named');
  assert.match(String(p.executionStatusDetail), /control-plane-gw/, `detail must name the configured lane: ${p.executionStatusDetail}`);
  assert.match(String(p.executionStatusDetail), /no route request/i, `detail must say no route request was wired: ${p.executionStatusDetail}`);
  assert.equal(p.execution, null, 'no execution object may be invented');
  assert.equal(p.executionRecord, null, 'no record facts may be invented');
  assert.equal(routeRequestFiles(stateDir).length, 0, 'no routeExecutor -> no route request');
  assert.equal(execRecordFiles(stateDir).length, 0, 'no ExecutionRecord may exist');

  // The SAME signature must come from the read-only status operation (call site 2).
  const st = payload(call(server, { name: GATEWAY_TOOL_NAME, arguments: { operation: 'status', repo: p.repo, issueNumber: p.issueNumber } }));
  assert.ok(st.ok, JSON.stringify(st));
  assert.equal(st.executionStatus, 'ADMITTED_ONLY');
  assert.equal(st.executionStatusReason, 'CANONICAL_ROUTE_MISSING');
  assert.equal(st.executionRecord, null, 'status must not invent record facts');
});

test('G16. a failed canonical runner with no ExecutionRecord stays UNDETERMINED with its exact code', () => {
  const stateDir = path.join(TMP, 'state-g16');
  fs.mkdirSync(stateDir, { recursive: true });
  const control = createClientControl({ stateDir, worktreesRoot: path.join(TMP, 'wt'), controlLane: 'control-plane-gw',
    routeExecutor: ({ session }) => {
      const requestPath = path.join(stateDir, 'client-mcp', 'routes', `${session.identityHash}.control-loop.json`);
      fs.mkdirSync(path.dirname(requestPath), { recursive: true });
      fs.writeFileSync(requestPath, JSON.stringify({ identityHash: session.identityHash }));
      fs.writeFileSync(`${requestPath}.result.json`, JSON.stringify({ ok: false, code: 'SESSION_ADMISSION_FAILED' }));
      return { ok: true, status: 'LOOP_STARTED' };
    },
  });
  const server = createGatewayMcpServer({ control });
  const R = makeRepo('duongpdddic-droid/gw-loop-result');
  const p = payload(call(server, { name: GATEWAY_TOOL_NAME, arguments: {
    operation: 'submit', goal: 'runner failure evidence', targetRepo: R.ownerRepoName,
    localCheckoutPath: R.dir, clientRequestId: 'gw-loop-result-0001',
  } }));
  assert.equal(p.executionStatus, 'UNDETERMINED');
  assert.equal(p.executionStatusReason, 'SESSION_ADMISSION_FAILED');
  assert.equal(p.executionRecord, null);
  const st = payload(call(server, { name: GATEWAY_TOOL_NAME, arguments: { operation: 'status', repo: p.repo, issueNumber: p.issueNumber } }));
  assert.equal(st.executionStatus, 'UNDETERMINED');
  assert.equal(st.executionStatusReason, 'SESSION_ADMISSION_FAILED');
});

// ---------------------------------------------------------------------------
// P0 REWORK — Req 2: real issue identity only + stable clientRequestId on retry
// ---------------------------------------------------------------------------

test('G9. schema and wire: no fake issueNumber, goal-only submit requires one stable clientRequestId', () => {
  const { server } = newServer();
  const list = server.handleRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  const props = list.result.tools[0].inputSchema.properties;

  assert.match(props.issueNumber.description, /REAL issue number/i, 'issueNumber must be documented as a real issue');
  assert.match(props.issueNumber.description, /never invent/i, 'issueNumber must forbid invention');
  assert.doesNotMatch(props.issueNumber.description, /dummy/i, 'the instruction surface must not offer a dummy issue number');
  assert.match(props.clientRequestId.description, /REUSE/i, 'the schema must tell the caller to reuse the id on retry');
  assert.match(props.clientRequestId.description, /retry/i, 'the schema must tie reuse to retries');

  // A goal without an issue and without a stable id must fail closed BEFORE any
  // canonical work (no session, no burned task number).
  const R = makeRepo('duongpdddic-droid/gw-crid');
  const p = payload(call(server, {
    name: GATEWAY_TOOL_NAME,
    arguments: { operation: 'submit', goal: 'gw missing clientRequestId', targetRepo: R.ownerRepoName, localCheckoutPath: R.dir },
  }));
  assert.equal(p.ok, false);
  assert.equal(p.reason, 'SUBMIT_CLIENT_REQUEST_ID_REQUIRED');
  assert.ok(!fs.existsSync(path.join(server.control.config.stateDir, 'sessions')), 'no session may be created');
  assert.ok(!fs.existsSync(path.join(server.control.config.stateDir, 'local-tasks', 'sequence.json')), 'no task number may be burned');
});
