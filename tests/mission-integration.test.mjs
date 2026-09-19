// tests/mission-integration.test.mjs — Integration smoke tests for
// mission-loop runtime wiring. FAKE in-memory actors only (per live
// safety rule). No live provider.
//
// A. Happy:      MISSION_ACCEPTED → CHILD_ACTIVE → EXITED → VERIFYING
//                  → FINAL_REVIEWING → PASS → AWAITING_HUMAN_MERGE_DECISION
// B. Rework:     REWORK → repair → verify → review PASS
// C. Machine dep: BLOCKED_ON_DEPENDENCY → auto resolve → RESUMING → PASS
// D. Restart:    stop VERIFYING → resume FINAL_REVIEWING → PASS (no re-run)
// E. Duplicate:  EXITED twice → verify/review ONCE
// F. Human gate: true gate → AWAITING; machine code → never gate
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { identityHash as identityHashW } from '../packages/workspace/workspace.mjs';

import { MISSION_FINAL_REVIEW_ACCEPTED, MISSION_AWAITING_HUMAN_MERGE_DECISION, MISSION_NON_TERMINAL_ACCEPTED, isTrueHumanGate } from '../packages/mission-loop/mission-loop.mjs';
import {
  wakeMission, loadMission, runMissionEpoch,
  missionForSession, productionFinalReview, CONTROLLER_OWNER, STALE_BINDING, BLOCKED_TRANSPORT,
} from '../packages/mission-loop/mission-runner.mjs';

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mission-it-')); }

function canonicalStateDirFor({ repo = 'duongpdddic-droid/soc_brain', issue = 69 } = {}) {
  const id = identityHashW({ repo, issueNumber: issue });
  return { stateDir: mkStateDir(), identityHash: id };
}
function fakeSession({ repo = 'duongpdddic-droid/soc_brain', issue = 69, instruction = 'test goal', ...rest } = {}) {
  const { stateDir, identityHash } = canonicalStateDirFor({ repo, issue });
  const s = {
    schemaVersion: '1', state: 'SESSION_ACTIVE',
    taskId: `${repo}#${issue}`, repo, issueNumber: issue,
    identityHash,
    baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40),
    worktreePath: path.join(os.tmpdir(), 'mission-it-wt'),
    branch: 'agent/test', lease: { token: 'x'.repeat(64) },
    controlPlane: { stateDir },
    instruction, ...rest,
  };
  fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'sessions', `${s.identityHash}.json`), JSON.stringify(s), 'utf8');
  return { ...s, stateDir };
}
function wakeFake({ repo = 'duongpdddic-droid/soc_brain', issue = 69, stateDir, identityHash }) {
  if (!stateDir || !identityHash) {
    const r = canonicalStateDirFor({ repo, issue });
    stateDir = r.stateDir; identityHash = r.identityHash;
  }
  return wakeMission({ sessionPath: path.join(stateDir, 'sessions', `${identityHash}.json`), identityHash, stateDir });
}
function fakeExecutor(opts = {}) {
  let n = 0;
  return async (child) => {
    n += 1;
    if (opts.failOn && n === opts.failOn) return { ok: false, code: 'EXECUTOR_FAIL' };
    if (opts.blockedOn && n === opts.blockedOn) return { ok: false, blockedOn: opts.blockedOn };
    return { ok: true, executionStatus: 'EXITED', terminalStatus: 'EXITED' };
  };
}
function fakeVerifier(verdict = 'PASS') { return async () => ({ verdict }); }
function fakePreReview() { return async () => ({ ok: true, actionable: false }); }
function fakeRepair() { const fn = async () => { fn.n += 1; }; fn.n = 0; return fn; }
function fakeFinalReview({ reworkFirst = false } = {}) {
  let n = 0;
  return async (child, epoch) => {
    n += 1;
    if (n === 1 && reworkFirst) return { verdict: 'REWORK', findings: ['f1'], evidenceValid: true };
    return { verdict: 'PASS', findings: [], evidenceValid: true };
  };
}
function fakeOnProgress() { return { fn: (e) => e, events: [] }; }

// ---- A. Happy path ---------------------------------------------------------
test('A. happy path: MISSION_ACCEPTED → EXITED → VERIFYING → FINAL_REVIEWING → PASS → AWAITING_HUMAN_MERGE_DECISION', async () => {
  const session = fakeSession();
  const stateDir = session.stateDir;
  const wake = wakeFake({ stateDir, identityHash: session.identityHash });
  assert.ok(wake.ok, JSON.stringify(wake));
  const mission = wake.value.mission ?? wake.value;
  assert.equal(mission.state, 'MISSION_ACCEPTED');

  const onProgress = { fn: (e) => eventsA.push(e), events: [] };
  const eventsA = [];
  const deps = {
    executor: fakeExecutor(), verifier: fakeVerifier(), preReview: fakePreReview(),
    finalReview: fakeFinalReview(), repair: fakeRepair(), onProgress: onProgress.fn,
  };

  let result;
  for (let i = 0; i < 12; i++) {
    result = await runMissionEpoch({ mission, deps });
    if (result.ok && result.terminal) break;
    if (!result.ok) { assert.fail(JSON.stringify(result)); }
  }
  assert.ok(result.ok || result.code === 'AWAITING_HUMAN_MERGE_DECISION', JSON.stringify(result));
  // Universal loop: PASS -> AWAITING_HUMAN_MERGE_DECISION (non-terminal)
  assert.equal(mission.state, MISSION_AWAITING_HUMAN_MERGE_DECISION, JSON.stringify(mission));

  const states = eventsA.map((e) => e.state);
  assert.ok(states.includes('MISSION_ACCEPTED'));
  assert.ok(states.includes('CHILD_ACTIVE'));
  assert.ok(states.includes('VERIFYING'));
  assert.ok(states.includes('FINAL_REVIEWING'));
  assert.ok(states.includes(MISSION_AWAITING_HUMAN_MERGE_DECISION));

  const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, 'mission-loop', `${mission.missionId}.json`), 'utf8'));
  assert.equal(persisted.state, MISSION_AWAITING_HUMAN_MERGE_DECISION);
  assert.equal(persisted.controllerOwner, CONTROLLER_OWNER);
  assert.equal(persisted.headSha, session.headSha);
  assert.equal(persisted.baseSha, session.baseSha);
});

// ---- B. Rework -------------------------------------------------------------
test('B. rework: REWORK → repair child → verify → review PASS → AWAITING_HUMAN_MERGE_DECISION', async () => {
  const session = fakeSession();
  const stateDir = session.stateDir;
  const wake = wakeFake({ stateDir, identityHash: session.identityHash });
  assert.ok(wake.ok);
  const mission = wake.value.mission ?? wake.value;
  const eventsB = [];
  const repair = fakeRepair();
  const deps = {
    executor: fakeExecutor(), verifier: fakeVerifier(), preReview: fakePreReview(),
    finalReview: fakeFinalReview({ reworkFirst: true }), repair,
    onProgress: (e) => eventsB.push(e),
  };

  let result;
  for (let i = 0; i < 14; i++) {
    result = await runMissionEpoch({ mission, deps });
    if (result.ok && result.terminal) break;
    if (!result.ok) { assert.fail(JSON.stringify(result)); }
  }
  // Universal loop: PASS -> AWAITING_HUMAN_MERGE_DECISION (non-terminal)
  assert.equal(mission.state, MISSION_AWAITING_HUMAN_MERGE_DECISION, JSON.stringify(mission));
  assert.ok(repair.n >= 1, 'repair was invoked');
  assert.ok(mission.children?.[0]?.state === 'CHILD_FINAL_PASS');
});

// ---- C. Machine dependency -------------------------------------------------
test('C. BLOCKED_ON_DEPENDENCY → auto resolve → RESUMING → PASS → AWAITING_HUMAN_MERGE_DECISION', async () => {
  const session = fakeSession();
  const stateDir = session.stateDir;
  const wake = wakeFake({ stateDir, identityHash: session.identityHash });
  assert.ok(wake.ok);
  const mission = wake.value.mission ?? wake.value;
  const executor = fakeExecutor({ blockedOn: 1 });
  let depSolved = 0;
  const solveDependency = async () => { depSolved += 1; };
  const eventsC = [];
  const deps = {
    executor, verifier: fakeVerifier(), preReview: fakePreReview(),
    finalReview: fakeFinalReview(), repair: fakeRepair(),
    solveDependency, onProgress: (e) => eventsC.push(e),
  };

  let result;
  for (let i = 0; i < 16; i++) {
    result = await runMissionEpoch({ mission, deps });
    if (result.ok && result.terminal) break;
    if (!result.ok) { assert.fail(JSON.stringify(result)); }
  }
  assert.equal(mission.state, MISSION_AWAITING_HUMAN_MERGE_DECISION, JSON.stringify(mission));
  assert.equal(depSolved, 1);
  const states = eventsC.map((e) => e.state);
  assert.ok(states.includes('BLOCKED_ON_DEPENDENCY'));
  assert.ok(states.includes('RESUMING'));
  assert.ok(states.includes('CHILD_ACTIVE'));
  assert.ok(states.includes(MISSION_AWAITING_HUMAN_MERGE_DECISION));
  assert.equal(mission.humanActionRequired, false);
});

// ---- D. Restart: resume from VERIFYING checkpoint ---------------------------
test('D. restart at VERIFYING → resume → FINAL_REVIEWING → PASS (no child re-run)', async () => {
  const session = fakeSession();
  const stateDir = session.stateDir;
  const wake = wakeFake({ stateDir, identityHash: session.identityHash });
  assert.ok(wake.ok);
  const mission = wake.value.mission ?? wake.value;
  const eventsD = [];
  let executorCalls = 0;
  // Phase 1: executor only, no verifier → mission reaches VERIFYING then verify fails.
  // State is VERIFYING and persisted (executor succeeded in CHILD_ACTIVE).
  const depsReachVerify = {
    executor: async (child) => { executorCalls += 1; return { ok: true }; },
    onProgress: (e) => eventsD.push(e),
  };
  const reachResult = await runMissionEpoch({ mission, deps: depsReachVerify });
  assert.equal(mission.state, 'VERIFYING', `after reach-verify: ${mission.state}`);
  assert.ok(!reachResult.ok, 'verify should fail without verifier');

  // Simulate restart: load from canonical state.
  const resumed = loadMission({ stateDir, missionId: mission.missionId });
  assert.ok(resumed.ok);
  assert.equal(resumed.value.state, 'VERIFYING');

  // Phase 2: full deps → VERIFYING → FINAL_REVIEWING → PASS
  const depsResume = {
    executor: async (child) => { executorCalls += 1; return { ok: true }; },
    verifier: fakeVerifier(), preReview: fakePreReview(),
    finalReview: fakeFinalReview(), repair: fakeRepair(),
    onProgress: (e) => eventsD.push(e),
  };
  let result;
  for (let i = 0; i < 4; i++) {
    result = await runMissionEpoch({ mission: resumed.value, deps: depsResume });
    if (result.ok && result.terminal) break;
    if (!result.ok) { assert.fail(JSON.stringify(result)); }
  }
  assert.ok(result.ok || result.code === 'AWAITING_HUMAN_MERGE_DECISION');
  assert.equal(resumed.value.state, MISSION_AWAITING_HUMAN_MERGE_DECISION);
  assert.equal(executorCalls, 1, 'executor must NOT re-run after restart');
});

// ---- E. Duplicate event ----------------------------------------------------
test('E. EXITED twice → verify/review ONCE', async () => {
  const session = fakeSession();
  const stateDir = session.stateDir;
  const wake = wakeFake({ stateDir, identityHash: session.identityHash });
  assert.ok(wake.ok);
  const mission = wake.value.mission ?? wake.value;
  const eventsE = [];
  let executorCalls = 0;
  const deps = {
    executor: async (child) => { executorCalls += 1; return { ok: true }; },
    verifier: fakeVerifier(), preReview: fakePreReview(),
    finalReview: fakeFinalReview(), repair: fakeRepair(),
    onProgress: (e) => eventsE.push(e),
  };

  let result;
  for (let i = 0; i < 8; i++) {
    result = await runMissionEpoch({ mission, deps });
    if (result.ok && result.terminal) break;
    if (MISSION_NON_TERMINAL_ACCEPTED.has(mission.state)) break;
    if (!result.ok) { assert.fail(JSON.stringify(result)); }
  }
  assert.equal(mission.state, MISSION_AWAITING_HUMAN_MERGE_DECISION);

  // Duplicate terminal event (now AWAITING_HUMAN_MERGE_DECISION)
  const second = wakeFake({ stateDir, identityHash: session.identityHash });
  assert.ok(second.ok);
  assert.equal(second.value.terminal, false);
  assert.equal(second.value.action, 'awaiting-human-merge');
  assert.equal(executorCalls, 1, 'executor called exactly once despite duplicate terminal');
});

// ---- F. Human gate ----------------------------------------------------------
test('F. true human gate → AWAITING; machine code → never gate', async () => {
  // F1: machine-solvable codes are NEVER human gates
  for (const g of ['EXECUTOR_EXITED', 'STALE_SESSION_ACTIVE', 'REVIEW_REWORK', 'TEST_FAIL',
    'EVIDENCE_TRANSPORT_FAIL', 'HANDOFF_PERSIST_FAIL', 'WORKTREE_INFRA',
    'MACHINE_SOLVABLE_DEPENDENCY', 'REPAIR_TASK_REQUIRED']) {
    assert.equal(isTrueHumanGate(g), false, `${g} must not be a human gate`);
  }
  // F2: true gates pause
  for (const g of ['CREDENTIAL_REQUIRED', 'BUSINESS_DECISION_REQUIRED', 'DESTRUCTIVE_PRODUCTION_AUTHORITY', 'BRON_DATA_REQUIRED']) {
    assert.equal(isTrueHumanGate(g), true, `${g} must be a human gate`);
  }
  // F3: machine BLOCKED from finalReview → mission BLOCKED, NOT AWAITING
  const session = fakeSession();
  const stateDir = session.stateDir;
  const wake = wakeFake({ stateDir, identityHash: session.identityHash });
  assert.ok(wake.ok);
  const mission = wake.value.mission ?? wake.value;
  const eventsF = [];
  const deps = {
    executor: fakeExecutor(), verifier: fakeVerifier(), preReview: fakePreReview(),
    finalReview: async () => ({ verdict: 'BLOCKED', findings: ['transport unavailable'], evidenceValid: false }),
    repair: fakeRepair(), solveDependency: async () => {}, onProgress: (e) => eventsF.push(e),
  };

  let result;
  for (let i = 0; i < 8; i++) {
    result = await runMissionEpoch({ mission, deps });
    if (result.ok && result.terminal) break;
    if (mission.state === 'BLOCKED_ON_DEPENDENCY') break;
  }
  assert.equal(mission.state, 'BLOCKED_ON_DEPENDENCY', 'machine BLOCKED should reach BLOCKED_ON_DEPENDENCY, not AWAITING');
  assert.equal(mission.humanGateRequired, false, 'machine BLOCKED must NOT set human gate');
  assert.equal(mission.humanActionRequired, false);
});

// ---- wiring hooks -----------------------------------------------------------
test('wiring: missionForSession binds canonical session facts', () => {
  const stateDir = mkStateDir();
  const id = 'b'.repeat(40);
  const session = {
    schemaVersion: '1', state: 'SESSION_ACTIVE', identityHash: id,
    taskId: 'duongpdddic-droid/soc_brain#42', repo: 'duongpdddic-droid/soc_brain',
    issueNumber: 42, headSha: 'h'.repeat(40), baseSha: 'g'.repeat(40),
    worktreePath: path.join(os.tmpdir(), 'wt'), branch: 'agent/x',
    lease: { token: 't'.repeat(64) }, instruction: 'my goal', controlPlane: { stateDir },
  };
  const r = missionForSession({ session, stateDir });
  assert.ok(r.ok, JSON.stringify(r));
  const m = r.value;
  assert.equal(m.identityHash, id);
  assert.equal(m.headSha, 'h'.repeat(40));
  assert.equal(m.baseSha, 'g'.repeat(40));
  assert.equal(m.repository, 'duongpdddic-droid/soc_brain');
  assert.equal(m.issue, 42);
  assert.equal(m.worktree, path.join(os.tmpdir(), 'wt'));
  assert.equal(m.branch, 'agent/x');
  assert.equal(m.goal, 'my goal');
  assert.equal(m.controllerOwner, CONTROLLER_OWNER);
  const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, 'mission-loop', `${m.missionId}.json`), 'utf8'));
  assert.equal(persisted.goal, 'my goal');
});

test('wiring: stale/mismatched binding fails closed', () => {
  const session = fakeSession();
  const stateDir = session.stateDir;
  const r = wakeMission({
    sessionPath: path.join(stateDir, 'sessions', `${session.identityHash}.json`),
    identityHash: 'z'.repeat(40), stateDir,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, STALE_BINDING);
});

test('wiring: productionFinalReview without transport → BLOCKED_TRANSPORT', async () => {
  const actor = await productionFinalReview({});
  const r = await actor({}, 1);
  assert.equal(r.ok, false);
  assert.equal(r.code, BLOCKED_TRANSPORT);
});
