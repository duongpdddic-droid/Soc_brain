import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { reconcileExecutorExit } from '../packages/control-loop/executor-exit-projection.mjs';
import { createClientControl } from '../packages/client-mcp/client-control.mjs';
import { createClientMcpServer } from '../packages/client-mcp/client-mcp.mjs';
import { pinFollow, readFollowBinding } from '../packages/client-mcp/follow-binding.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { sessionPathFor } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { executionRecordPath } from '../packages/executor-launcher/executor-launcher.mjs';

const REPO = 'duongpdddic-droid/soc_brain';
const BASE = '1aded9a3bba83473c5ab6432c7c42669a10fe34e';
const HEAD = '0b29a1011111111111111111111111111111aaaa';
const w = (o) => JSON.stringify(o);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'soc-recon-'));
const clock = () => '2026-09-16T00:00:00.000Z';
const termLiveness = (r) => ({ liveness: r.terminalStatus, identityProven: Boolean(r.terminalStatus) });

function mk({ stateDir, issueNumber, session = {} }) {
  const id = identityHash({ repo: REPO, issueNumber });
  fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'executions'), { recursive: true });
  const sp = sessionPathFor({ stateDir, identityHash: id });
  const wt = path.join(stateDir, 'wt', id);
  fs.writeFileSync(sp, w({
    schemaVersion: '1', taskId: `${REPO}#${issueNumber}`, repo: REPO, issueNumber, state: 'SESSION_ACTIVE',
    baseSha: BASE, branch: `agent/${id}`, worktreePath: wt, headSha: BASE, executionMode: 'executor',
    mutationOwner: { laneId: 'client-plane', acquiredVia: 'ADMISSION' }, lease: { token: 'lt' + id }, lifecycle: [], controlPlane: { stateDir }, ...session,
  }) + '\n', 'utf8');
  // executor has EXITED (gone) BEFORE the client reconnects.
  fs.writeFileSync(executionRecordPath({ stateDir, identityHash: id }), w({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: id, taskId: `${REPO}#${issueNumber}`, repo: REPO, issueNumber,
    baseSha: BASE, branch: `agent/${id}`, worktreePath: wt, executor: 'opencode', pid: 4242, startedAt: 1, finishedAt: 2,
    exitCode: 0, signal: null, terminalStatus: 'EXITED', finalized: true, processStartTime: 111,
  }) + '\n', 'utf8');
  return { id, wt, sp };
}

// Full F5 flow for one state: submit-pin -> (client disconnects) -> canonical state
// advances while absent -> fresh client boots -> followPinned resumes SAME identity
// -> follower attaches automatically -> current state surfaced -> no resubmit, no
// manual status polling.
async function reconnectScenario({ issueNumber, build }) {
  const stateDir = tmp();
  const { id } = mk({ stateDir, issueNumber, session: build.session || {} });
  // (submit) pin the observable binding for the exact task.
  pinFollow({ stateDir, repo: REPO, issueNumber, identityHash: id });
  // (state advances while the client is absent)
  await build.advance({ stateDir, repo: REPO, issueNumber });
  // ---- client restart: brand-new control + server (no resubmit) ----
  const ctl = createClientControl({ stateDir, worktreesRoot: path.join(stateDir, 'wt'), controlLane: 'client-plane', deliveryCanonicalRepo: REPO });
  // followPinned is the SEPARATE observable-resume path (NOT control.recover/liveness).
  const pinned = ctl.followPinned();
  assert.equal(pinned.ok, true, 'followPinned resumes the observable binding');
  assert.equal(pinned.identityHash, id);
  assert.equal(pinned.resumed, true);
  assert.equal(pinned.effectiveState, build.expect);
  // the adapter boot resumes the FOLLOWER automatically and surfaces current state.
  const notices = [];
  const server = createClientMcpServer({ control: ctl, notify: (m) => notices.push(m), scheduler: { setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {} } });
  const pin = readFollowBinding({ stateDir }).binding; // what boot reads
  server.attachFollow({ repo: pin.repo, issueNumber: pin.issueNumber, identityHash: pin.identityHash });
  const t = server.tickFollows();
  assert.equal(t.length, 1, 'follower re-surfaces current state on first tick after reconnect');
  assert.equal(t[0].identityHash, id);
  assert.equal(t[0].effectiveState, build.expect);
  assert.ok(notices.every((n) => n.method === 'notifications/message'));
  server.stopAllFollows();
  return { pinned };
}

test('F5/RECOVERABLE_BLOCKED: reconnect after executor gone resumes follower, surfaces BLOCKED (no resubmit/poll)', async () => {
  await reconnectScenario({
    issueNumber: 9001001,
    build: {
      expect: 'RECOVERABLE_BLOCKED',
      advance: async (ctx) => { await reconcileExecutorExit({ ...ctx, headReader: () => BASE, livenessProbe: termLiveness, now: clock }); },
    },
  });
});

test('F5/HUMAN_GATE: reconnect after executor gone resumes follower, surfaces HUMAN_GATE (no resubmit/poll)', async () => {
  await reconnectScenario({
    issueNumber: 9001002,
    build: {
      session: { state: 'WAITING_FOR_INPUT', humanGate: { state: 'WAITING_FOR_INPUT', at: 'gate-x', note: 'confirm' } },
      expect: 'HUMAN_GATE',
      // state advanced to gate while absent; reconcile preserves the gate (no walk).
      advance: async (ctx) => { await reconcileExecutorExit({ ...ctx, headReader: () => BASE, livenessProbe: termLiveness, now: clock }); },
    },
  });
});

test('F5/READY_FOR_REVIEW: reconnect after executor gone resumes follower, surfaces READY (no resubmit/poll)', async () => {
  await reconnectScenario({
    issueNumber: 9001003,
    build: {
      expect: 'READY_FOR_REVIEW',
      advance: async (ctx) => { await reconcileExecutorExit({ ...ctx, headReader: () => HEAD, livenessProbe: termLiveness, now: clock }); },
    },
  });
});

test('F5: observable resume is INDEPENDENT of control.recover() and never fakes READY/verdict', async () => {
  const stateDir = tmp(); const issueNumber = 9001004;
  const { id } = mk({ stateDir, issueNumber });
  pinFollow({ stateDir, repo: REPO, issueNumber, identityHash: id });
  // residue: executor EXITED + no commit. followPinned must report RECOVERABLE_BLOCKED,
  // NOT READY, and must not require a live-execution recover().
  await reconcileExecutorExit({ stateDir, repo: REPO, issueNumber, headReader: () => BASE, livenessProbe: termLiveness, now: clock });
  const ctl = createClientControl({ stateDir, worktreesRoot: path.join(stateDir, 'wt'), controlLane: 'client-plane', deliveryCanonicalRepo: REPO });
  const pinned = ctl.followPinned();
  assert.equal(pinned.effectiveState, 'RECOVERABLE_BLOCKED');
  assert.equal(pinned.readyForReview, false);
  assert.equal(pinned.recoverable, true);
  // and it agrees with the authoritative consumers (F2 consistency holds after resume):
  assert.equal(ctl.getTask({ repo: REPO, issueNumber }).task.effectiveState.effectiveState, 'RECOVERABLE_BLOCKED');
  assert.equal(ctl.getProgress({ repo: REPO, issueNumber }).effectiveState.effectiveState, 'RECOVERABLE_BLOCKED');
});

test('F5: no follow binding -> followPinned is a clean no-op (never guesses a task)', () => {
  const stateDir = tmp();
  const ctl = createClientControl({ stateDir, worktreesRoot: path.join(stateDir, 'wt'), controlLane: 'client-plane', deliveryCanonicalRepo: REPO });
  const pinned = ctl.followPinned();
  assert.equal(pinned.ok, false); assert.equal(pinned.reason, 'NO_FOLLOW_BINDING');
});
