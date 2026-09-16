import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computeEffectiveState, buildOperationalView, EFFECTIVE_STATES } from '../packages/client-mcp/effective-state.mjs';
import { createFollowWatcher } from '../packages/client-mcp/follow-watcher.mjs';
import { createClientControl } from '../packages/client-mcp/client-control.mjs';
import { createClientMcpServer } from '../packages/client-mcp/client-mcp.mjs';
import { reconcileExecutorExit } from '../packages/control-loop/executor-exit-projection.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { sessionPathFor } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { executionRecordPath, executionEventsPath } from '../packages/executor-launcher/executor-launcher.mjs';

const REPO = 'duongpdddic-droid/soc_brain';
const BASE = '1aded9a3bba83473c5ab6432c7c42669a10fe34e';
const HEAD = '0b29a1011111111111111111111111111111aaaa';
const w = (o) => JSON.stringify(o);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'soc-attachobs-'));
const clock = () => '2026-09-16T00:00:00.000Z';

function laySession({ stateDir, issueNumber, session = {} }) {
  const id = identityHash({ repo: REPO, issueNumber });
  fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'executions'), { recursive: true });
  const sp = sessionPathFor({ stateDir, identityHash: id });
  const wt = path.join(stateDir, 'wt', id);
  const s = {
    schemaVersion: '1', taskId: `${REPO}#${issueNumber}`, repo: REPO, issueNumber,
    state: 'SESSION_ACTIVE', baseSha: BASE, branch: `agent/${id}`, worktreePath: wt,
    headSha: BASE, executionMode: 'executor', mutationOwner: { laneId: 'client-plane', acquiredVia: 'ADMISSION' },
    lease: { token: 'lt-' + id }, lifecycle: [], controlPlane: { stateDir }, ...session,
  };
  fs.writeFileSync(sp, w(s) + '\n', 'utf8');
  return { id, sp, wt };
}
function layExecution({ stateDir, id, wt, issueNumber, record }) {
  fs.writeFileSync(executionRecordPath({ stateDir, identityHash: id }), w({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: id, taskId: `${REPO}#${issueNumber}`,
    repo: REPO, issueNumber, baseSha: BASE, branch: `agent/${id}`, worktreePath: wt, executor: 'opencode',
    pid: 4242, startedAt: 1, finishedAt: 2, exitCode: 0, signal: null, terminalStatus: 'EXITED', finalized: true, processStartTime: 111,
    ...record,
  }) + '\n', 'utf8');
}

// ============================ F2: effective-state truth table =================
test('effective-state: vocabulary exported and stable', () => {
  assert.ok(EFFECTIVE_STATES.includes('RECOVERABLE_BLOCKED') && EFFECTIVE_STATES.includes('READY_FOR_REVIEW') && EFFECTIVE_STATES.includes('UNKNOWN'));
});
test('F2 residue: SESSION_ACTIVE + EXITED/GONE + ledger BLOCKED => RECOVERABLE_BLOCKED, notRunning, never READY/terminal', () => {
  const e = computeEffectiveState({
    session: { state: 'SESSION_ACTIVE', headSha: BASE, baseSha: BASE },
    execution: { status: 'EXITED', liveness: 'EXITED', identityProven: true },
    loop: { position: 3, currentStep: 'BLOCKED' }, progress: { currentStep: 1 },
  });
  assert.equal(e.effectiveState, 'RECOVERABLE_BLOCKED');
  assert.equal(e.notRunning, true); assert.equal(e.recoverable, true);
  assert.equal(e.readyForReview, false); assert.equal(e.terminal, false); assert.equal(e.running, false);
});
test('effective-state: live identity-proven executor => RUNNING', () => {
  const e = computeEffectiveState({ session: { state: 'SESSION_ACTIVE' }, execution: { liveness: 'RUNNING', identityProven: true }, loop: { currentStep: 'EXECUTING' } });
  assert.equal(e.effectiveState, 'RUNNING'); assert.equal(e.running, true); assert.equal(e.notRunning, false);
});
test('effective-state: clean exit + VERIFYING + committed HEAD => READY_FOR_REVIEW', () => {
  const e = computeEffectiveState({ session: { state: 'SESSION_ACTIVE', headSha: HEAD, baseSha: BASE }, execution: { liveness: 'EXITED', identityProven: true }, loop: { currentStep: 'VERIFYING' } });
  assert.equal(e.effectiveState, 'READY_FOR_REVIEW'); assert.equal(e.readyForReview, true);
});
test('effective-state: EXITED + VERIFYING but head==base => NOT READY (no fabrication)', () => {
  const e = computeEffectiveState({ session: { state: 'SESSION_ACTIVE', headSha: BASE, baseSha: BASE }, execution: { liveness: 'EXITED', identityProven: true }, loop: { currentStep: 'VERIFYING' } });
  assert.equal(e.effectiveState, 'PENDING_RECONCILIATION'); assert.equal(e.readyForReview, false);
});
test('effective-state: Human Gate session => HUMAN_GATE, humanActionRequired', () => {
  const e = computeEffectiveState({ session: { state: 'WAITING_FOR_INPUT' }, execution: { liveness: 'EXITED', identityProven: true }, loop: { currentStep: 'BLOCKED' } });
  assert.equal(e.effectiveState, 'HUMAN_GATE'); assert.equal(e.humanActionRequired, true);
});
test('effective-state: identity UNPROVEN live pid => UNKNOWN, never synthetic RUNNING', () => {
  const e = computeEffectiveState({ session: { state: 'SESSION_ACTIVE' }, execution: { liveness: 'PID_REUSED', identityProven: false }, loop: { currentStep: 'EXECUTING' } });
  assert.equal(e.effectiveState, 'UNKNOWN'); assert.equal(e.running, false);
});
test('effective-state: terminal session passes through verbatim', () => {
  assert.equal(computeEffectiveState({ session: { state: 'COMPLETED' }, execution: null, loop: null }).effectiveState, 'COMPLETED');
  assert.equal(computeEffectiveState({ session: { state: 'BLOCKED' }, execution: null, loop: null }).effectiveState, 'TERMINAL_BLOCKED');
});

// =================== F2: cross-consumer consistency (real durable state) ======
async function residueFixture(issueNumber) {
  const stateDir = tmp();
  const { id, wt } = laySession({ stateDir, issueNumber });
  layExecution({ stateDir, id, wt, issueNumber, record: { terminalStatus: 'EXITED', exitCode: 0, finalized: true } });
  await reconcileExecutorExit({ stateDir, repo: REPO, issueNumber, headReader: () => BASE, livenessProbe: (r) => ({ liveness: r.terminalStatus, identityProven: Boolean(r.terminalStatus) }), now: clock });
  return { stateDir, id };
}
test('F2: get_task, get_progress, follow, recover ALL report the SAME RECOVERABLE_BLOCKED for #9000006 residue', async () => {
  const issueNumber = 9000401;
  const { stateDir } = await residueFixture(issueNumber);
  const ctl = createClientControl({ stateDir, worktreesRoot: path.join(stateDir, 'worktrees'), controlLane: 'client-plane', deliveryCanonicalRepo: REPO });
  const gt = ctl.getTask({ repo: REPO, issueNumber });
  const gp = ctl.getProgress({ repo: REPO, issueNumber });
  const fo = ctl.follow({ repo: REPO, issueNumber });
  const rc = ctl.recover({ repo: REPO, issueNumber });
  const es = (o) => o.effectiveState?.effectiveState ?? o.effectiveState;
  const states = [es(gt.task), es(gp), es(fo), es(rc)].filter(Boolean);
  assert.ok(states.every((s) => s === 'RECOVERABLE_BLOCKED'), `all consumers agree RECOVERABLE_BLOCKED, got ${JSON.stringify(states)}`);
  // and NONE of them call it RUNNING or READY (no fabrication):
  assert.ok(!states.some((s) => s === 'RUNNING' || s === 'READY_FOR_REVIEW'));
  assert.equal(gt.task.effectiveState.notRunning, true);
  assert.equal(gp.effectiveState.notRunning, true);
});

// =================== F1: follow-watcher mechanics =============================
test('watcher: emits on change, dedupes unchanged, re-surfaces on resync, stops cleanly', () => {
  const events = [];
  let seq = 'v1';
  let cleared = 0;
  const wch = createFollowWatcher({
    identity: { identityHash: 'id-A' },
    snapshot: () => ({ ok: true, seq, payload: { state: seq } }),
    emit: (v) => { events.push(v); },
    setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => { cleared += 1; },
  });
  wch.start();
  assert.deepEqual(wch.tick().view, { state: 'v1' });
  assert.equal(wch.tick(), null, 'unchanged seq -> no emit (no flapping / no manual poll spam)');
  seq = 'v2'; wch.tick();
  seq = 'v2'; assert.equal(wch.tick(), null);
  wch.resync(); wch.tick(); // reconnect re-surface
  wch.stop();
  assert.deepEqual(events.map((e) => e.state), ['v1', 'v2', 'v2']);
  assert.equal(cleared, 1);
  assert.equal(wch.tick(), null, 'stopped watcher observes nothing');
});
test('watcher: snapshot failure is swallowed via onError, never crashes', () => {
  let err = 0;
  const wch = createFollowWatcher({ identity: { identityHash: 'x' }, snapshot: () => { throw new Error('fs'); }, emit: () => {}, onError: () => { err += 1; }, setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {} });
  wch.start(); wch.tick();
  assert.equal(err, 1);
});

// ============ F1: end-to-end AUTO-follow over the stdio transport (no poll) ===
function serverFixture(issueNumber) {
  const stateDir = tmp();
  const { id, wt } = laySession({ stateDir, issueNumber });
  return { stateDir, id, wt, issueNumber };
}
test('F1: after ONE submit/attach, operational changes surface automatically as notifications — zero manual get_task/get_progress', () => {
  const { stateDir, id, wt, issueNumber } = serverFixture(9000501);
  const notices = [];
  const ctl = createClientControl({ stateDir, worktreesRoot: path.join(stateDir, 'worktrees'), controlLane: 'client-plane', deliveryCanonicalRepo: REPO });
  const server = createClientMcpServer({
    control: ctl,
    notify: (m) => notices.push(m),
    scheduler: { setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {} },
  });
  // attach exactly as submit/recover does:
  server.attachFollow({ repo: REPO, issueNumber, identityHash: id });

  // (1) executor running + durable progress -> first tick surfaces the initial
  //     operational state (identity-bound). Exact label is liveness-dependent and
  //     not asserted here; the point is ONE automatic observation, then dedupe.
  layExecution({ stateDir, id, wt, issueNumber, record: { terminalStatus: null, finalized: false, exitCode: null } });
  const t1 = server.tickFollows();
  assert.equal(t1.length, 1, 'first observation auto-emits');
  assert.equal(t1[0].identityHash, id);
  // dedupe: another tick with no change emits nothing (no polling spam).
  assert.equal(server.tickFollows().length, 0);

  // (2) executor finishes EXITED, no commit -> reconciled recoverable BLOCKED.
  layExecution({ stateDir, id, wt, issueNumber, record: { terminalStatus: 'EXITED', exitCode: 0, finalized: true } });
  return reconcileExecutorExit({ stateDir, repo: REPO, issueNumber, headReader: () => BASE, livenessProbe: (r) => ({ liveness: r.terminalStatus, identityProven: true }), now: clock }).then(() => {
    const t2 = server.tickFollows();
    assert.equal(t2.length, 1, 'BLOCKED appears automatically');
    assert.equal(t2[0].effectiveState, 'RECOVERABLE_BLOCKED');
    assert.equal(t2[0].recoverable, true);
    // notification is an operational MCP logging notification, NOT a response:
    const last = notices[notices.length - 1];
    assert.equal(last.jsonrpc, '2.0'); assert.equal(last.method, 'notifications/message');
    assert.equal(last.id, undefined, 'server->client notification has no id');
    assert.equal(last.params.logger, 'soc-brain-client');
    assert.equal(last.params.data.effectiveState, 'RECOVERABLE_BLOCKED');
    server.stopAllFollows();
  });
});
test('F1: READY_FOR_REVIEW auto-surfaces after a committed+verified exit (no manual poll)', async () => {
  const { stateDir, id, wt, issueNumber } = serverFixture(9000502);
  const notices = [];
  const ctl = createClientControl({ stateDir, worktreesRoot: path.join(stateDir, 'worktrees'), controlLane: 'client-plane', deliveryCanonicalRepo: REPO });
  const server = createClientMcpServer({ control: ctl, notify: (m) => notices.push(m), scheduler: { setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {} } });
  server.attachFollow({ repo: REPO, issueNumber, identityHash: id });
  layExecution({ stateDir, id, wt, issueNumber, record: { terminalStatus: 'EXITED', exitCode: 0, finalized: true } });
  await reconcileExecutorExit({ stateDir, repo: REPO, issueNumber, headReader: () => HEAD, livenessProbe: (r) => ({ liveness: r.terminalStatus, identityProven: true }), now: clock });
  const surfaced = server.tickFollows();
  assert.ok(surfaced.some((v) => v.effectiveState === 'READY_FOR_REVIEW'), JSON.stringify(surfaced));
  assert.equal(surfaced[surfaced.length - 1].readyForReview, true);
  assert.ok(notices.every((n) => n.method === 'notifications/message'));
  server.stopAllFollows();
});
test('F1: Human Gate auto-surfaces with humanActionRequired', () => {
  const { stateDir, id, wt, issueNumber } = serverFixture(9000503);
  laySession({ stateDir, issueNumber, session: { state: 'WAITING_FOR_INPUT', humanGate: { state: 'WAITING_FOR_INPUT', at: 'gate-1' } } });
  const ctl = createClientControl({ stateDir, worktreesRoot: path.join(stateDir, 'worktrees'), controlLane: 'client-plane', deliveryCanonicalRepo: REPO });
  const server = createClientMcpServer({ control: ctl, notify: () => {}, scheduler: { setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {} } });
  server.attachFollow({ repo: REPO, issueNumber, identityHash: id });
  const t = server.tickFollows();
  assert.equal(t[0].effectiveState, 'HUMAN_GATE'); assert.equal(t[0].humanActionRequired, true);
  server.stopAllFollows();
});
test('F1: reconnect RESUMES following the SAME task (new server/adapter, one attach, no resubmit)', async () => {
  const { stateDir, id, wt, issueNumber } = serverFixture(9000504);
  const ctl = createClientControl({ stateDir, worktreesRoot: path.join(stateDir, 'worktrees'), controlLane: 'client-plane', deliveryCanonicalRepo: REPO });
  // executor completes EXITED no commit; residue reconciled to recoverable block BEFORE reconnect
  layExecution({ stateDir, id, wt, issueNumber, record: { terminalStatus: 'EXITED', exitCode: 0, finalized: true } });
  await reconcileExecutorExit({ stateDir, repo: REPO, issueNumber, headReader: () => BASE, livenessProbe: (r) => ({ liveness: r.terminalStatus, identityProven: true }), now: clock });
  // FRESH adapter (transport restart) reattaches by recover -> auto-follow resumes same identity.
  const notices = [];
  const server2 = createClientMcpServer({ control: createClientControl({ stateDir, worktreesRoot: path.join(stateDir, 'worktrees'), controlLane: 'client-plane', deliveryCanonicalRepo: REPO }), notify: (m) => notices.push(m), scheduler: { setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {} } });
  const rec = server2.dispatch({ params: { name: 'soc.recover', arguments: { repo: REPO, issueNumber } } });
  assert.equal(rec.ok, true); assert.equal(rec.transportState, 'RECOVERED');
  const t = server2.tickFollows();
  assert.ok(t.some((v) => v.effectiveState === 'RECOVERABLE_BLOCKED' && v.identityHash === id), 'reconnected follower shows the SAME task current state without resubmit');
  server2.stopAllFollows();
});
test('F1: concurrent tasks do not cross-stream (each follower emits only its own identity)', async () => {
  const stateDir = tmp();
  const A = 9000601, B = 9000602;
  const a = laySession({ stateDir, issueNumber: A });
  const b = laySession({ stateDir, issueNumber: B });
  // A -> committed READY; B -> recoverable BLOCKED
  layExecution({ stateDir, id: a.id, wt: a.wt, issueNumber: A, record: { terminalStatus: 'EXITED', exitCode: 0, finalized: true } });
  layExecution({ stateDir, id: b.id, wt: b.wt, issueNumber: B, record: { terminalStatus: 'EXITED', exitCode: 0, finalized: true } });
  await reconcileExecutorExit({ stateDir, repo: REPO, issueNumber: A, headReader: () => HEAD, livenessProbe: (r) => ({ liveness: r.terminalStatus, identityProven: true }), now: clock });
  await reconcileExecutorExit({ stateDir, repo: REPO, issueNumber: B, headReader: () => BASE, livenessProbe: (r) => ({ liveness: r.terminalStatus, identityProven: true }), now: clock });
  const ctl = createClientControl({ stateDir, worktreesRoot: path.join(stateDir, 'worktrees'), controlLane: 'client-plane', deliveryCanonicalRepo: REPO });
  const emitted = [];
  const server = createClientMcpServer({ control: ctl, notify: (m) => emitted.push(m), scheduler: { setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {} } });
  server.attachFollow({ repo: REPO, issueNumber: A, identityHash: a.id });
  server.attachFollow({ repo: REPO, issueNumber: B, identityHash: b.id });
  const views = server.tickFollows();
  const va = views.find((v) => v.identityHash === a.id);
  const vb = views.find((v) => v.identityHash === b.id);
  assert.equal(va.effectiveState, 'READY_FOR_REVIEW');
  assert.equal(vb.effectiveState, 'RECOVERABLE_BLOCKED');
  assert.ok(emitted.every((m) => m.params.data.identityHash === a.id || m.params.data.identityHash === b.id));
  server.stopAllFollows();
});
test('F1: operational notification carries NO reasoning/chain-of-thought fields', () => {
  const { stateDir, id, wt, issueNumber } = serverFixture(9000701);
  const ctl = createClientControl({ stateDir, worktreesRoot: path.join(stateDir, 'worktrees'), controlLane: 'client-plane', deliveryCanonicalRepo: REPO });
  const server = createClientMcpServer({ control: ctl, notify: () => {}, scheduler: { setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {} } });
  server.attachFollow({ repo: REPO, issueNumber, identityHash: id });
  const v = server.tickFollows()[0];
  assert.equal(v.kind, 'soc.operational');
  const flat = JSON.stringify(v).toLowerCase();
  assert.ok(!/thinking|reasoning|chain_of_thought|cot/.test(flat), 'no hidden reasoning surfaced');
  server.stopAllFollows();
});
