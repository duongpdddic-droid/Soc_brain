import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notifyFinalizedGatewayExecution, notifyProvenBreakerStop } from '../packages/client-mcp/route-worker.mjs';
import { taskSubmitExecutorReport, taskRequestHumanGate, readSessionRecord, SESSION_SCHEMA_VERSION } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { dispatchLifecycleEvent } from '../packages/telegram-dispatch/telegram-dispatch.mjs';
import { createDetachedControlLoopExecutor } from '../packages/client-mcp/client-control.mjs';
import { runControlLoopRoute } from '../packages/client-mcp/control-loop-route-worker.mjs';

test('OpenCode soc_control profile opts into the canonical full-loop Gateway route', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../.opencode/opencode.json', import.meta.url), 'utf8'));
  const env = config.mcp['soc-brain-gateway'].environment;
  assert.equal(env.SOC_CONTROL_LANE, 'opencode-control-lane');
  assert.equal(env.SOC_GATEWAY_FULL_LOOP, '1');
});

test('gateway stop notification requires a finalized record bound to the same task', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-gateway-stop-'));
  try {
    const session = { repo: 'owner/repo', issueNumber: 42, identityHash: identityHash({ repo: 'owner/repo', issueNumber: 42 }), state: 'SESSION_ACTIVE' };
    const recordPath = path.join(dir, 'execution.json');
    const record = { repo: session.repo, issueNumber: 42, identityHash: session.identityHash, terminalStatus: 'EXITED', exitCode: 0, finalized: false };
    const calls = [];
    const dispatch = (args) => { calls.push(args); return { status: 'API_ACCEPTED' }; };
    fs.writeFileSync(recordPath, JSON.stringify(record));
    assert.equal(notifyFinalizedGatewayExecution({ session, stateDir: dir, recordPath, dispatch }).reason, 'FINALIZED_RECORD_NOT_PROVEN');
    record.finalized = true;
    record.identityHash = 'foreign';
    fs.writeFileSync(recordPath, JSON.stringify(record));
    assert.equal(notifyFinalizedGatewayExecution({ session, stateDir: dir, recordPath, dispatch }).reason, 'FINALIZED_RECORD_NOT_PROVEN');
    record.identityHash = session.identityHash;
    fs.writeFileSync(recordPath, JSON.stringify(record));
    assert.equal(notifyFinalizedGatewayExecution({ session, stateDir: dir, recordPath, dispatch }).status, 'API_ACCEPTED');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].event, 'EXECUTOR_STOPPED');
    assert.match(calls[0].eventKey, /^[0-9a-f]{64}$/);
    assert.match(calls[0].note, /EXITED; exitCode=0; task state remains SESSION_ACTIVE/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('breaker warning needs positive proof that the executor is gone', () => {
  const session = { repo: 'owner/repo', issueNumber: 46, identityHash: 'bound', state: 'SESSION_ACTIVE' };
  const calls = [];
  const dispatch = (args) => { calls.push(args); return { status: 'API_ACCEPTED' }; };
  const input = { session, stateDir: '/tmp/state', requestPath: '/tmp/request.json', dispatch };
  assert.equal(notifyProvenBreakerStop({ ...input, supervision: { tripped: true, pid: 123, cleanup: { provenGone: false } } }).reason, 'BREAKER_STOP_NOT_PROVEN');
  assert.equal(calls.length, 0);
  assert.equal(notifyProvenBreakerStop({ ...input, supervision: { tripped: true, pid: 123, breakerReason: 'EXECUTION_BUDGET_EXCEEDED', cleanup: { provenGone: true } } }).status, 'API_ACCEPTED');
  assert.equal(calls.length, 1);
  assert.match(calls[0].note, /EXECUTION_BUDGET_EXCEEDED/);
});

test('two finalized executor attempts notify separately; replay of one attempt dedupes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-gateway-attempt-'));
  try {
    const session = { repo: 'owner/repo', issueNumber: 45, identityHash: identityHash({ repo: 'owner/repo', issueNumber: 45 }), state: 'SESSION_ACTIVE' };
    const spawn = () => ({ stdout: JSON.stringify({ status: 'API_ACCEPTED', messageId: 1 }), status: 0 });
    const call = (eventKey) => dispatchLifecycleEvent({ session, event: 'EXECUTOR_STOPPED', eventKey, stateDir: dir, allowNonCanonicalStateRoot: true, spawn });
    assert.equal(call('attempt-one').deduped, undefined);
    assert.equal(call('attempt-one').deduped, true);
    assert.equal(call('attempt-two').deduped, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('report notification follows a persisted, nonterminal session report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-gateway-report-'));
  try {
    const stateDir = path.join(dir, 'state');
    const repo = 'owner/repo';
    const issueNumber = 43;
    const id = identityHash({ repo, issueNumber });
    const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, JSON.stringify({ schemaVersion: SESSION_SCHEMA_VERSION, repo, issueNumber, identityHash: id, state: 'SESSION_ACTIVE', lifecycle: [] }));
    assert.equal(taskSubmitExecutorReport({ sessionPath, note: '' }).reason, 'EXECUTOR_REPORT_INVALID');
    const result = taskSubmitExecutorReport({ sessionPath, note: 'Đã nộp PR #43; chờ review.', dispatchOptions: { stateDir } });
    assert.equal(result.ok, true);
    const back = readSessionRecord(sessionPath);
    assert.equal(back.ok, true);
    assert.equal(back.session.state, 'SESSION_ACTIVE');
    assert.equal(back.session.executorReports[0].note, 'Đã nộp PR #43; chờ review.');
    assert.equal(back.session.lifecycle.at(-1).event, 'EXECUTOR_REPORT_SUBMITTED');
    assert.equal(result.telegramDispatch.status, 'NOT_ATTEMPTED'); // isolated root; no network
    const replay = taskSubmitExecutorReport({ sessionPath, note: 'Đã nộp PR #43; chờ review.', dispatchOptions: { stateDir } });
    assert.equal(replay.replayed, true);
    assert.equal(readSessionRecord(sessionPath).session.executorReports.length, 1);
    assert.equal(taskSubmitExecutorReport({ sessionPath, note: 'Báo cáo vòng sửa tiếp theo.', dispatchOptions: { stateDir } }).ok, true);
    assert.equal(readSessionRecord(sessionPath).session.executorReports.length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failed question delivery retains the question for canonical recovery and status', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-gateway-question-'));
  try {
    const stateDir = path.join(dir, 'state');
    const repo = 'owner/repo';
    const issueNumber = 44;
    const id = identityHash({ repo, issueNumber });
    const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, JSON.stringify({ schemaVersion: SESSION_SCHEMA_VERSION, repo, issueNumber, identityHash: id, state: 'SESSION_ACTIVE', lifecycle: [] }));
    const result = taskRequestHumanGate({ sessionPath, note: 'Bố chọn phương án A hay B?', dispatchOptions: { stateDir } });
    assert.equal(result.ok, true);
    assert.equal(result.telegramDispatch.status, 'NOT_ATTEMPTED');
    const back = readSessionRecord(sessionPath);
    assert.equal(back.session.state, 'HUMAN_GATE_REQUIRED');
    assert.equal(back.session.humanGate.note, 'Bố chọn phương án A hay B?');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('full-loop gateway route launches the canonical runner once per task identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-gateway-loop-route-'));
  try {
    const stateDir = path.join(dir, 'state');
    const repo = 'duongpdddic-droid/soc_brain';
    const issueNumber = 47;
    const id = identityHash({ repo, issueNumber });
    const session = { repo, issueNumber, identityHash: id, controlPlane: { stateDir } };
    const launches = [];
    const route = createDetachedControlLoopExecutor({
      workerPath: path.join(dir, 'packages', 'client-mcp', 'control-loop-route-worker.mjs'),
      spawnWorker: (opts) => { launches.push(opts); return { pid: 777, unref() {} }; },
    });
    const input = { sessionPath: path.join(stateDir, 'sessions', `${id}.json`), session, goal: 'fix task' };
    assert.equal(route({ ...input, session: { ...session, repo: 'owner/foreign' } }).reason, 'LOOP_REPO_UNSUPPORTED');
    assert.equal(route(input).status, 'LOOP_STARTED');
    assert.equal(route(input).status, 'LOOP_ALREADY_ROUTED');
    assert.equal(launches.length, 1);
    assert.deepEqual(launches[0].args.slice(1), [path.join(stateDir, 'client-mcp', 'routes', `${id}.control-loop.json`)]);
    const request = JSON.parse(fs.readFileSync(path.join(stateDir, 'client-mcp', 'routes', `${id}.control-loop.json`), 'utf8'));
    assert.equal(request.identityHash, id);
    assert.equal(request.goal, 'fix task');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('full-loop worker binds its request to the session and persists a typed runner failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-gateway-loop-worker-'));
  try {
    const stateDir = path.join(dir, 'state');
    const repo = 'duongpdddic-droid/soc_brain';
    const issueNumber = 48;
    const id = identityHash({ repo, issueNumber });
    const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
    const requestPath = path.join(stateDir, 'client-mcp', 'routes', `${id}.control-loop.json`);
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.mkdirSync(path.dirname(requestPath), { recursive: true });
    const session = { schemaVersion: SESSION_SCHEMA_VERSION, repo, issueNumber, identityHash: id, state: 'SESSION_ACTIVE', controlPlane: { stateDir } };
    fs.writeFileSync(sessionPath, JSON.stringify(session));
    fs.writeFileSync(requestPath, JSON.stringify({ kind: 'soc-control-loop-route', repo, issueNumber, identityHash: id, sessionPath, stateDir, goal: 'fix', requestedAt: new Date().toISOString() }));
    const calls = [];
    const run = async (args) => { calls.push(args); return { ok: false, code: 'SESSION_ADMISSION_FAILED' }; };
    const notices = [];
    const result = await runControlLoopRoute({ requestPath, run, dispatch: (args) => notices.push(args) });
    assert.equal(result.code, 'SESSION_ADMISSION_FAILED');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].issueNumber, issueNumber);
    assert.equal(calls[0].bootstrap, true);
    assert.equal(JSON.parse(fs.readFileSync(`${requestPath}.result.json`, 'utf8')).code, 'SESSION_ADMISSION_FAILED');
    assert.equal(notices[0].event, 'GATEWAY_RUNNER_FAILED');
    session.identityHash = 'foreign';
    fs.writeFileSync(sessionPath, JSON.stringify(session));
    assert.equal((await runControlLoopRoute({ requestPath, run })).code, 'LOOP_SESSION_IDENTITY_MISMATCH');
    assert.equal(calls.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
