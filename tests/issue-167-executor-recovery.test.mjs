// tests/issue-167-executor-recovery.test.mjs — Issue #167 deterministic
// startup/recovery composition, event terminal evidence, and 6-phase harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { readSessionRecord, sessionPathFor } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import {
  EXECUTION_SCHEMA_VERSION, effectiveStatus, readExecutionRecord, readActivityTail,
  startExecution, appendTerminalEvidence, executionTerminalEvidencePath,
} from '../packages/executor-launcher/executor-launcher.mjs';
import { reapInterruptedExecution } from '../packages/executor-launcher/executor-reaper.mjs';
import { recoverNonterminalExecutions } from '../packages/executor-launcher/executor-recovery.mjs';
import { analyzeExecutorRun, HARNESS_CLASSIFICATIONS, runExecutorHarness } from '../packages/executor-launcher/executor-finalization-harness.mjs';
import { createControlPlane } from '../packages/control-ui/control-ui.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-167-'));
const IDH = identityHash({ repo: 'o/r', issueNumber: 1 });
const WT = path.join(TMP, 'wt');
fs.mkdirSync(WT, { recursive: true });
const okVerify = () => ({ ok: true });
const DEAD = { isAlive: () => false };
const LIVE_SAME = { isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: 1000 }) };
const LIVE_FOREIGN = { isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: 5555 }) };

function fixture(over = {}) {
  const S = fs.mkdtempSync(path.join(TMP, 'st-'));
  const sessPath = sessionPathFor({ stateDir: S, identityHash: IDH });
  fs.mkdirSync(path.dirname(sessPath), { recursive: true });
  const session = {
    schemaVersion: '1', state: 'SESSION_ACTIVE', lifecycle: [],
    taskId: 'o/r#1', repo: 'o/r', issueNumber: 1, baseSha: 'a'.repeat(40),
    branch: 'soc/task-h', worktreePath: WT, identityHash: IDH,
    lease: { token: 'tok-123' }, controlPlane: { stateDir: S },
  };
  fs.writeFileSync(sessPath, JSON.stringify(session, null, 2), 'utf8');
  const dir = path.join(S, 'executions');
  fs.mkdirSync(dir, { recursive: true });
  const eventsPath = path.join(dir, `${IDH}.events.jsonl`);
  fs.writeFileSync(eventsPath, '', 'utf8');
  const record = {
    schemaVersion: EXECUTION_SCHEMA_VERSION, kind: 'ExecutionRecord',
    identityHash: IDH, taskId: 'o/r#1', repo: 'o/r', issueNumber: 1,
    baseSha: 'a'.repeat(40), branch: 'soc/task-h', worktreePath: WT,
    executor: 'opencode', pid: 4242, processStartTime: 1000, startedAt: 1,
    finishedAt: null, exitCode: null, signal: null, terminalStatus: null,
    reason: null, sessionId: null, eventsPath, eventsOverflow: false,
    pendingExecutorBind: false, finalized: false,
    ...over,
  };
  fs.writeFileSync(path.join(dir, `${IDH}.json`), JSON.stringify(record, null, 2), 'utf8');
  return { S, sessPath };
}

function sweep(S, deps = {}) {
  const reap = (a) => reapInterruptedExecution({ ...a, verifyAuthority: okVerify });
  return recoverNonterminalExecutions({ stateDir: S, repo: 'o/r', controlCwd: WT, reap, clock: () => 1234567890000, ...deps });
}
const one = (r) => assert.equal(r.evidence.results.length, 1), result = (r) => r.evidence.results[0];

test('#167 stranded dead unfinalized is projected RUNNING before recovery and canonically interrupted after', () => {
  const f = fixture();
  assert.equal(effectiveStatus(readExecutionRecord({ stateDir: f.S, repo: 'o/r', issueNumber: 1 }).record, () => false), 'RUNNING');
  const before = fs.readFileSync(f.sessPath);
  const r = sweep(f.S, DEAD);
  assert.equal(r.ok, true);
  one(r);
  assert.equal(result(r).classification, 'EXITED');
  assert.equal(result(r).action, 'REAPED');
  assert.equal(result(r).status, 'INTERRUPTED');
  assert.equal(result(r).mutationOwner, 'executor-reaper');
  assert.equal(r.evidence.secondMutationOwner, false);
  const rec = readExecutionRecord({ stateDir: f.S, repo: 'o/r', issueNumber: 1 }).record;
  assert.equal(rec.terminalStatus, 'INTERRUPTED');
  assert.equal(rec.finalized, true);
  assert.equal(effectiveStatus(rec, () => false), 'INTERRUPTED');
  assert.notEqual(rec.terminalStatus, 'EXITED');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.S, 'recovery', 'execution-sweeps.jsonl'), 'utf8').trim()).results, r.evidence.results);
  assert.equal(fs.readFileSync(f.sessPath).equals(before), true);
  const tail = readActivityTail({ stateDir: f.S, repo: 'o/r', issueNumber: 1 });
  assert.equal(tail.ok, true);
  assert.equal(tail.terminalEvidenceIncluded, true);
  assert.equal(tail.items.at(-1).event.kind, 'EXECUTION_RECOVERY_FINALIZED');
});

test('#167 PID reuse, ownership unknown and live exact identity fail closed without invoking the reaper', () => {
  for (const [caseName, over, deps, classification] of [
    ['pid_reuse', {}, LIVE_FOREIGN, 'PID_REUSED'],
    ['ownership_unknown', { processStartTime: null }, { isAlive: () => true, readStartTime: () => null }, 'OWNERSHIP_UNKNOWN'],
    ['live_exact', {}, LIVE_SAME, 'RUNNING'],
  ]) {
    const f = fixture(over);
    let reapCalled = false;
    const r = recoverNonterminalExecutions({
      stateDir: f.S, repo: 'o/r', controlCwd: WT, clock: () => 2222,
      reap: () => { reapCalled = true; return { ok: true, action: 'REAPED' }; }, ...deps,
    });
    assert.equal(r.ok, true);
    assert.equal(result(r).classification, classification);
    assert.equal(reapCalled, false);
    assert.equal(readExecutionRecord({ stateDir: f.S, repo: 'o/r', issueNumber: 1 }).record.terminalStatus, null);
  }
});

test('#167 control-plane startup invokes the recovery sweep exactly once', () => {
  const f = fixture();
  let calls = 0;
  const cp = createControlPlane({
    repo: 'o/r', stateDir: f.S, controlCwd: WT,
    deps: { readUpstreamHead: () => null, startupRecovery: () => { calls++; return sweep(f.S, DEAD); } },
  });
  assert.equal(cp.ok, true);
  assert.equal(calls, 1);
  assert.equal(cp.startupRecovery.evidence.results[0].action, 'REAPED');
});

test('#167 event-log overflow preserves canonical terminal evidence in the bounded tail', () => {
  const f = fixture({ eventsOverflow: true });
  const lines = Array.from({ length: 600 }, (_, i) => JSON.stringify({ seq: i + 1, t: i, stream: 'stdout', kind: 'event', event: { i } }));
  fs.writeFileSync(path.join(f.S, 'executions', `${IDH}.events.jsonl`), lines.join('\n') + '\n', 'utf8');
  appendTerminalEvidence({
    stateDir: f.S, identityHash: IDH, clock: () => 999,
    event: { kind: 'EXECUTOR_TERMINAL', terminalStatus: 'EXITED', finalized: true },
  });
  const tail = readActivityTail({ stateDir: f.S, repo: 'o/r', issueNumber: 1 });
  assert.equal(tail.ok, true);
  assert.equal(tail.totalLines, 600);
  assert.equal(tail.truncated, true);
  assert.equal(tail.terminalEvidenceIncluded, true);
  assert.equal(tail.items.at(-1).kind, 'TERMINAL_EVIDENCE');
  assert.equal(tail.items.at(-1).event.terminalStatus, 'EXITED');
});

test('#167 normal clean finalization does not create an alternate terminal tail', async () => {
  const S = fs.mkdtempSync(path.join(TMP, 'clean-'));
  const sessionPath = sessionPathFor({ stateDir: S, identityHash: IDH });
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, JSON.stringify({
    schemaVersion: '1', state: 'SESSION_ACTIVE', lifecycle: [],
    taskId: 'o/r#1', repo: 'o/r', issueNumber: 1, baseSha: 'a'.repeat(40),
    branch: 'soc/task-h', worktreePath: WT, identityHash: IDH, lease: { token: 'tok-123' },
  }), 'utf8');
  const session = { leaseToken: 'tok-123' };
  const binding = { identityHash: IDH, taskId: 'o/r#1', repo: 'o/r', issueNumber: 1, baseSha: 'a'.repeat(40), branch: 'soc/task-h', path: WT };
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const r = startExecution({
    session, sessionPath, binding, instruction: 'clean', stateDir: S,
    env: { SOC_OPENCODE_BIN: 'opencode.exe' }, spawn: () => child,
    isAlive: () => true, resolveExecutable: () => ({ ok: true, executable: 'opencode.exe', source: 'test' }),
    verifyAuthority: okVerify, preflight: () => ({ ok: true, version: 'test', agent: 'build', toolCaps: {} }),
  });
  assert.equal(r.ok, true);
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'text', part: { type: 'text', text: 'done' } }) + '\n'));
  child.emit('exit', 0, null);
  await new Promise(setImmediate);
  const rec = readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 1 }).record;
  assert.equal(rec.terminalStatus, 'EXITED');
  assert.equal(rec.finalized, true);
  assert.equal(fs.existsSync(executionTerminalEvidencePath({ stateDir: S, identityHash: IDH })), false);
  assert.equal(readActivityTail({ stateDir: S, repo: 'o/r', issueNumber: 1 }).items.length, 1);
});

test('#167 harness emits six phases and every required classification deterministically', () => {
  const events = [
    { stream: 'stdout', kind: 'tool', t: 20, event: { part: { type: 'tool', status: 'completed' } } },
    { stream: 'stdout', kind: 'text', t: 30, text: 'summary' },
  ];
  const record = { pid: 7, processStartTime: 8, startedAt: 1, finishedAt: 40, terminalStatus: 'EXITED', finalized: true };
  const pass = analyzeExecutorRun({ record, events, childClosedAt: 45, terminalEvidenceAvailable: true });
  assert.deepEqual(Object.keys(pass.timestamps), ['commandStartedAt', 'identityCapturedAt', 'finalSummaryAt', 'processExitedAt', 'toolCompletionAt', 'resumeAt']);
  assert.equal(pass.classification, 'PASS');
  for (const k of HARNESS_CLASSIFICATIONS) {
    if (k === 'PASS') continue;
    let expected = k;
    let input = { record: { ...record, terminalStatus: null, finalized: false }, events, processDead: true };
    if (k === 'RESPONSE_LOST') input = { record: { ...record, finalized: true }, events: [], childClosedAt: 45 };
    if (k === 'TOOL_COMPLETION_NOT_PROPAGATED') input = { record: { ...record, finalized: true }, events: [events[0]], childClosedAt: 45 };
    if (k === 'CHILD_HANDLE_LEAK') input = { record, events };
    if (k === 'EXECUTOR_PROCESS_TERMINATION') input = { record: { ...record, terminalStatus: 'FAILED' }, events, childClosedAt: 45, terminalEvidenceAvailable: true };
    if (k === 'EVENT_LOG_OVERFLOW') input = { record: { ...record, eventsOverflow: true }, events, childClosedAt: 45 };
    assert.equal(analyzeExecutorRun(input).classification, expected, expected);
  }
  assert.equal(analyzeExecutorRun({ executor: 'cline', record, events }).ok, false);
});

test('#167 harness runner captures six phases and classifies clean OpenCode-shaped completion', async () => {
  const child = new EventEmitter();
  child.pid = 7;
  child.stdout = new EventEmitter();
  child.kill = () => {};
  let now = 0;
  const run = runExecutorHarness({
    command: 'opencode.exe', args: ['run'], readStartTime: () => ({ processStartTime: 8 }),
    clock: () => ++now, spawn: () => child,
  });
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'tool', part: { type: 'tool', status: 'completed' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'text', part: { type: 'text', text: 'summary' } }) + '\n'));
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  const r = await run;
  assert.equal(r.ok, true);
  assert.equal(r.classification, 'PASS');
  assert.deepEqual(r.timestamps, {
    commandStartedAt: 1, identityCapturedAt: 1, finalSummaryAt: 3,
    processExitedAt: 4, toolCompletionAt: 2, resumeAt: 3,
  });
});
