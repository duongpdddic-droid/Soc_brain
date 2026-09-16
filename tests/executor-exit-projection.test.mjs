import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  reconcileExecutorExit, classifyExecutorExit, buildDurableProgress, deterministicExitVerification,
} from '../packages/control-loop/executor-exit-projection.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { sessionPathFor } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { executionRecordPath, executionEventsPath } from '../packages/executor-launcher/executor-launcher.mjs';
import { readTransitions } from '../packages/control-loop/control-loop.mjs';
import { readProgressRecord } from '../packages/task-progress/task-progress.mjs';
import { createClientControl } from '../packages/client-mcp/client-control.mjs';

const REPO = 'duongpdddic-droid/soc_brain';
const BASE = '1aded9a3bba83473c5ab6432c7c42669a10fe34e';
const HEAD = '0b29a1011111111111111111111111111111aaaa';

function tmpState() { return fs.mkdtempSync(path.join(os.tmpdir(), 'soc-exitproj-')); }
function write(o) { return JSON.stringify(o); }

function layDown({ stateDir, issueNumber, session = {}, record = null, events = null }) {
  const id = identityHash({ repo: REPO, issueNumber });
  fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'executions'), { recursive: true });
  const sp = sessionPathFor({ stateDir, identityHash: id });
  const s = {
    schemaVersion: '1', taskId: `${REPO}#${issueNumber}`, repo: REPO, issueNumber,
    state: 'SESSION_ACTIVE', baseSha: BASE, branch: `agent/${id}`,
    worktreePath: path.join(stateDir, 'wt', id), headSha: BASE,
    executionMode: 'executor', mutationOwner: { laneId: 'client-plane', acquiredVia: 'ADMISSION' },
    lease: { token: 'lease-' + id }, lifecycle: [], controlPlane: { stateDir },
    ...session,
  };
  fs.writeFileSync(sp, write(s) + '\n', 'utf8');
  if (record !== false) {
    const r = {
      schemaVersion: '1', kind: 'ExecutionRecord', identityHash: id, taskId: s.taskId,
      repo: REPO, issueNumber, baseSha: BASE, branch: s.branch, worktreePath: s.worktreePath,
      executor: 'opencode', pid: 4242, startedAt: 1, finishedAt: 2, exitCode: 0, signal: null,
      terminalStatus: 'EXITED', finalized: true, reason: null, processStartTime: 111,
      ...record,
    };
    fs.writeFileSync(executionRecordPath({ stateDir, identityHash: id }), write(r) + '\n', 'utf8');
  }
  if (events) {
    fs.writeFileSync(executionEventsPath({ stateDir, identityHash: id }), events.map((e) => write(e)).join('\n') + '\n', 'utf8');
  }
  return { id, sp };
}

const realLiveness = (rec) => ({ liveness: rec.terminalStatus || 'RUNNING', identityProven: Boolean(rec.terminalStatus), reason: 'TEST' });
const headAt = (h) => () => h;
const clock = () => '2026-09-15T17:23:47.000Z';

function ledgerTo(stateDir, id) { return readTransitions({ stateDir, identityHash: id }).map((t) => `${t.from}->${t.to}`); }

// ---- pure classifier --------------------------------------------------------
test('classify: EXITED+0+identity+head!=base+verify PASS -> READY', () => {
  const d = classifyExecutorExit({
    record: { terminalStatus: 'EXITED', exitCode: 0, signal: null },
    liveness: { identityProven: true }, headSha: HEAD, baseSha: BASE,
    verification: { verdict: 'PASS' },
  });
  assert.equal(d.disposition, 'READY');
});
test('classify: head==base (uncommitted residue) -> BLOCKED_INSUFFICIENT, never READY', () => {
  const d = classifyExecutorExit({
    record: { terminalStatus: 'EXITED', exitCode: 0, signal: null },
    liveness: { identityProven: true }, headSha: BASE, baseSha: BASE,
    verification: { verdict: 'PASS' },
  });
  assert.equal(d.disposition, 'BLOCKED_INSUFFICIENT');
});
test('classify: nonzero exit -> BLOCKED_ABNORMAL', () => {
  assert.equal(classifyExecutorExit({ record: { terminalStatus: 'FAILED', exitCode: 3, signal: null }, liveness: { identityProven: true }, headSha: HEAD, baseSha: BASE, verification: { verdict: 'PASS' } }).disposition, 'BLOCKED_ABNORMAL');
});
test('classify: signalled/killed -> BLOCKED_ABNORMAL', () => {
  assert.equal(classifyExecutorExit({ record: { terminalStatus: 'STOPPED', exitCode: null, signal: 'SIGTERM' }, liveness: { identityProven: true }, headSha: HEAD, baseSha: BASE, verification: { verdict: 'PASS' } }).disposition, 'BLOCKED_ABNORMAL');
});
test('classify: exitCode 0 but identity UNPROVEN (pid reuse) -> BLOCKED_ABNORMAL', () => {
  const d = classifyExecutorExit({ record: { terminalStatus: 'EXITED', exitCode: 0, signal: null }, liveness: { identityProven: false, liveness: 'PID_REUSED' }, headSha: HEAD, baseSha: BASE, verification: { verdict: 'PASS' } });
  assert.equal(d.disposition, 'BLOCKED_ABNORMAL'); assert.equal(d.code, 'EXECUTOR_IDENTITY_UNPROVEN');
});
test('classify: non-terminal -> RUNNING (fail closed, no projection)', () => {
  assert.equal(classifyExecutorExit({ record: { terminalStatus: null }, liveness: { identityProven: false }, headSha: HEAD, baseSha: BASE, verification: { verdict: 'PASS' } }).disposition, 'RUNNING');
});
test('deterministicExitVerification: binding mismatch -> no PASS', () => {
  const v = deterministicExitVerification({ record: { terminalStatus: 'EXITED', exitCode: 0, signal: null, worktreePath: '/other' }, session: { repo: REPO, issueNumber: 1, worktreePath: '/wt', baseSha: BASE } });
  assert.equal(v.verdict, null);
});

// ---- durable progress (A) ---------------------------------------------------
test('buildDurableProgress: counts operational events verbatim, no CoT', () => {
  const items = [
    { kind: 'tool', tool: 'edit' }, { kind: 'tool', tool: 'read' }, { kind: 'tool', tool: 'write' },
    { kind: 'step_finish' }, { kind: 'step_finish' }, { kind: 'output', line: 'Error: boom' },
  ];
  const dp = buildDurableProgress({ record: { terminalStatus: 'EXITED' }, activity: { ok: true, items } });
  assert.equal(dp.counters.tools, 3);
  assert.equal(dp.counters.writes, 2);
  assert.equal(dp.counters.stepFinishes, 2);
  assert.equal(dp.counters.errors, 1);
  assert.match(dp.message, /events=6 tools=3 write\+edit=2 stepFinish=2 errors=1 terminal=EXITED/);
});

// ---- reconcile end-to-end ---------------------------------------------------
test('RUNNING execution: durable progress projected, NO lifecycle walk (fail closed)', async () => {
  const stateDir = tmpState(); const issue = 9000001;
  layDown({ stateDir, issueNumber: issue, record: { terminalStatus: null, finalized: false, exitCode: null }, events: [{ kind: 'tool', tool: 'edit' }] });
  const r = await reconcileExecutorExit({ stateDir, repo: REPO, issueNumber: issue, headReader: headAt(BASE), livenessProbe: (rec) => ({ liveness: 'RUNNING', identityProven: false }), now: clock });
  assert.equal(r.disposition, 'RUNNING');
  const id = identityHash({ repo: REPO, issueNumber: issue });
  assert.equal(readTransitions({ stateDir, identityHash: id }).length, 0, 'no lifecycle transition while running');
  const pr = readProgressRecord({ stateDir, identityHash: id });
  assert.ok(pr.ok && pr.progress, 'durable progress is projected while running');
});

test('READY: EXITED+0 committed+verified -> ledger VERIFYING once + headSha pinned', async () => {
  const stateDir = tmpState(); const issue = 9000002;
  const { id, sp } = layDown({ stateDir, issueNumber: issue, events: [{ kind: 'step_finish' }] });
  const r = await reconcileExecutorExit({ stateDir, repo: REPO, issueNumber: issue, headReader: headAt(HEAD), livenessProbe: realLiveness, now: clock });
  assert.equal(r.disposition, 'READY');
  assert.deepEqual(ledgerTo(stateDir, id), ['ACCEPTED->ROUTED', 'ROUTED->EXECUTING', 'EXECUTING->VERIFYING']);
  assert.equal(JSON.parse(fs.readFileSync(sp, 'utf8')).headSha, HEAD, 'verified HEAD pinned onto session');
  // idempotency: a second reconcile must NOT re-walk or duplicate VERIFYING.
  const r2 = await reconcileExecutorExit({ stateDir, repo: REPO, issueNumber: issue, headReader: headAt(HEAD), livenessProbe: realLiveness, now: clock });
  assert.equal(r2.disposition, 'ALREADY_PROJECTED');
  assert.equal(ledgerTo(stateDir, id).filter((x) => x === 'EXECUTING->VERIFYING').length, 1, 'VERIFYING recorded exactly once');
});

test('NO FABRICATION: EXITED+0 but head==base -> recoverable BLOCKED, head not pinned', async () => {
  const stateDir = tmpState(); const issue = 9000003;
  const { id, sp } = layDown({ stateDir, issueNumber: issue });
  const r = await reconcileExecutorExit({ stateDir, repo: REPO, issueNumber: issue, headReader: headAt(BASE), livenessProbe: realLiveness, now: clock });
  assert.equal(r.disposition, 'BLOCKED_INSUFFICIENT');
  assert.ok(r.recoverable === true);
  assert.equal(JSON.parse(fs.readFileSync(sp, 'utf8')).headSha, BASE, 'HEAD stays ==base');
  const ledger = ledgerTo(stateDir, id);
  assert.deepEqual(ledger.slice(-1), ['EXECUTING->BLOCKED']);
  assert.ok(!ledger.includes('EXECUTING->VERIFYING'), 'never falsely READY');
});

test('abnormal exit (nonzero) -> BLOCKED_ABNORMAL surfaced, never READY', async () => {
  const stateDir = tmpState(); const issue = 9000004;
  const { id } = layDown({ stateDir, issueNumber: issue, record: { terminalStatus: 'FAILED', exitCode: 7, signal: null, finalized: true } });
  const r = await reconcileExecutorExit({ stateDir, repo: REPO, issueNumber: issue, headReader: headAt(HEAD), livenessProbe: realLiveness, now: clock });
  assert.equal(r.disposition, 'BLOCKED_ABNORMAL'); assert.equal(r.reason, 'EXECUTOR_FAILED');
  assert.ok(ledgerTo(stateDir, id).includes('EXECUTING->BLOCKED'));
});

test('killed/unfinalized record (not terminal) -> RUNNING, NO mutation (identity unprovable)', async () => {
  const stateDir = tmpState(); const issue = 9000005;
  const { id } = layDown({ stateDir, issueNumber: issue, record: { terminalStatus: null, finalized: false, exitCode: null, signal: 'SIGKILL', pid: 99 } });
  const r = await reconcileExecutorExit({ stateDir, repo: REPO, issueNumber: issue, headReader: headAt(BASE), livenessProbe: (rec) => ({ liveness: 'EXITED', identityProven: true, reason: 'PID_GONE' }), now: clock });
  assert.equal(r.disposition, 'RUNNING');
  assert.equal(readTransitions({ stateDir, identityHash: id }).length, 0);
});

test('Human Gate session is preserved (no projection, no progress mutation)', async () => {
  const stateDir = tmpState(); const issue = 9000006;
  const { id } = layDown({ stateDir, issueNumber: issue, session: { state: 'WAITING_FOR_INPUT' }, record: { terminalStatus: 'EXITED', exitCode: 0 } });
  const r = await reconcileExecutorExit({ stateDir, repo: REPO, issueNumber: issue, headReader: headAt(HEAD), livenessProbe: realLiveness, now: clock });
  assert.equal(r.disposition, 'PRESERVE_GATE');
  assert.equal(readTransitions({ stateDir, identityHash: id }).length, 0);
  const pr = readProgressRecord({ stateDir, identityHash: id });
  assert.ok(!(pr.ok && pr.progress), 'progress not touched while a gate is active');
});

test('residue reconciliation: SESSION_ACTIVE + EXITED + empty ledger no longer stays silent ACCEPTED', async () => {
  const stateDir = tmpState(); const issue = 9000007;
  const { id } = layDown({ stateDir, issueNumber: issue, record: { terminalStatus: 'EXITED', exitCode: 0, finalized: true } });
  // exact incident shape: head==base, no transitions yet.
  assert.equal(readTransitions({ stateDir, identityHash: id }).length, 0);
  const r = await reconcileExecutorExit({ stateDir, repo: REPO, issueNumber: issue, headReader: headAt(BASE), livenessProbe: realLiveness, now: clock });
  assert.equal(r.disposition, 'BLOCKED_INSUFFICIENT');
  const tail = readTransitions({ stateDir, identityHash: id });
  assert.equal(tail[tail.length - 1].to, 'BLOCKED', 'surfaced as explicit recoverable BLOCKED, never silent ACCEPTED/0');
});

test('client/MCP disappears: reconcile is independent of any client process (in-worker projection)', async () => {
  // The reconciler needs only the durable canonical files; no MCP handle is passed.
  const stateDir = tmpState(); const issue = 9000008;
  const { id } = layDown({ stateDir, issueNumber: issue, record: { terminalStatus: 'EXITED', exitCode: 0, finalized: true } });
  const r = await reconcileExecutorExit({ stateDir, repo: REPO, issueNumber: issue, headReader: headAt(HEAD), livenessProbe: realLiveness, now: clock });
  assert.equal(r.disposition, 'READY');
  assert.ok(readProgressRecord({ stateDir, identityHash: id }).progress, 'progress durable on disk');
});

test('cross-stream isolation: two identities never contaminate each other', async () => {
  const stateDir = tmpState();
  const a = 9000101, b = 9000102;
  layDown({ stateDir, issueNumber: a, record: { terminalStatus: 'EXITED', exitCode: 0, finalized: true } });
  layDown({ stateDir, issueNumber: b, record: { terminalStatus: 'FAILED', exitCode: 1, finalized: true } });
  const ra = await reconcileExecutorExit({ stateDir, repo: REPO, issueNumber: a, headReader: headAt(HEAD), livenessProbe: realLiveness, now: clock });
  const rb = await reconcileExecutorExit({ stateDir, repo: REPO, issueNumber: b, headReader: headAt(BASE), livenessProbe: realLiveness, now: clock });
  assert.equal(ra.disposition, 'READY'); assert.equal(rb.disposition, 'BLOCKED_ABNORMAL');
  assert.equal(ledgerTo(stateDir, identityHash({ repo: REPO, issueNumber: a })).slice(-1)[0], 'EXECUTING->VERIFYING');
  assert.equal(ledgerTo(stateDir, identityHash({ repo: REPO, issueNumber: b })).slice(-1)[0], 'EXECUTING->BLOCKED');
});

test('requestReview never fabricates READY_FOR_REVIEW while head==base (#9000006 gate)', async () => {
  const stateDir = tmpState(); const issue = 9000201;
  layDown({ stateDir, issueNumber: issue, record: { terminalStatus: 'EXITED', exitCode: 0, finalized: true } });
  const ctl = createClientControl({ stateDir, worktreesRoot: path.join(stateDir, 'worktrees'), controlLane: 'client-plane', deliveryCanonicalRepo: REPO });
  const before = ctl.requestReview({ repo: REPO, issueNumber: issue });
  assert.equal(before.review.terminalStatus, 'SESSION_ACTIVE', 'head==base is NOT ready');
  assert.equal(before.review.canContinue, false);
  // after reconcile pins a verified HEAD, review readiness legitimately appears
  await reconcileExecutorExit({ stateDir, repo: REPO, issueNumber: issue, headReader: headAt(HEAD), livenessProbe: realLiveness, now: clock });
  const after = ctl.requestReview({ repo: REPO, issueNumber: issue });
  assert.equal(after.review.terminalStatus, 'READY_FOR_REVIEW');
});
