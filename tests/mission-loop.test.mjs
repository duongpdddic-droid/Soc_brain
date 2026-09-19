// tests/mission-loop.test.mjs — MVP acceptance: ONE GOAL -> autonomous loop -> FINAL REVIEW PASS.
// No UI, no merge/deploy. Deterministic, no network, plain node:test.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MISSION_FINAL_REVIEW_ACCEPTED,
  MISSION_AWAITING_HUMAN_MERGE_DECISION,
  MISSION_AWAITING_HUMAN,
  MISSION_CLOSED_NOT_MERGED,
  MISSION_COMPLETED,
  createMissionRecord,
  persistMission,
  readMission,
  recover,
  planMission,
  dispatchChild,
  finalReviewVerdict,
  raiseHumanGate,
  approveMerge,
  rejectMerge,
  deferMerge,
  nextMachineAction,
  checkInvariant,
  isTrueHumanGate,
  runMissionLoop,
} from '../packages/mission-loop/mission-loop.mjs';

function mkStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mission-test-'));
}

// Scenario 1 (acceptance steps 1..10):
// submit ONE goal → implement → verify → final REWORK ≥1 → auto repair →
// re-verify → final again → PASS → MISSION_FINAL_REVIEW_ACCEPTED,
// HUMAN_ACTION_REQUIRED=false, zero manual prompts.
test('MVP-1: ONE goal -> REWORK -> auto repair -> FINAL PASS, no human action', async () => {
  const stateDir = mkStateDir();
  const c = createMissionRecord({ goal: 'autonomous loop MVP goal' });
  assert.equal(c.ok, true);
  let mission = c.value;
  assert.equal(persistMission({ stateDir, mission }).ok, true);

  let manualPrompts = 0;
  let repairs = 0;
  let finalCalls = 0;
  const actors = {
    planner: async (goal) => {
      assert.match(goal, /MVP goal/);
      return ['implement MVP loop'];
    },
    executor: async (child) => {
      assert.ok(child.childId);
      return { ok: true };
    },
    verifier: async () => ({ verdict: 'PASS' }),
    preReview: async () => ({ ok: true, actionable: false }),
    finalReviewer: async () => {
      finalCalls += 1;
      if (finalCalls === 1) {
        return { verdict: 'REWORK', findings: ['packages/mission-loop/mission-loop.mjs: missing null guard'], evidenceValid: true };
      }
      return { verdict: 'PASS', findings: [], evidenceValid: true };
    },
    repair: async () => { repairs += 1; },
  };

  const res = await runMissionLoop({ mission, actors, stateDir });
  // Universal loop: PASS -> AWAITING_HUMAN_MERGE_DECISION (non-terminal).
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'AWAITING_HUMAN_MERGE_DECISION');
  assert.equal(res.value.state, MISSION_AWAITING_HUMAN_MERGE_DECISION);
  assert.equal(res.value.finalReviewStatus, 'PASS');
  assert.equal(res.value.finalVerdict, 'PASS');
  assert.equal(res.value.humanActionRequired, false);
  assert.equal(res.value.humanGateRequired, false);
  assert.equal(manualPrompts, 0);
  assert.ok(finalCalls >= 2, 'final reviewer ran at least twice (REWORK then PASS)');
  assert.ok(repairs >= 1, 'system auto-routed findings to repair actor');
  assert.ok(res.trace.includes('planned'));
  assert.ok(res.trace.some((t) => t.startsWith('final:') && t.includes('REWORK')));
  assert.ok(res.trace.some((t) => t.startsWith('repair:')));
  assert.ok(res.trace.some((t) => t.startsWith('final:') && t.includes('PASS')));

  // Recovery from canonical state: non-terminal persists, checkpoints verified.
  const rec = recover({ stateDir, missionId: mission.missionId });
  assert.equal(rec.ok, true);
  assert.equal(rec.value.mission.state, MISSION_AWAITING_HUMAN_MERGE_DECISION);
  assert.ok(rec.value.verifiedCheckpoints.length >= 1);
});

// Scenario 2: machine-solvable BLOCKED dependency auto-resolves then resumes.
test('MVP-2: BLOCKED_ON dependency auto-solved, original task resumes, FINAL PASS', async () => {
  const stateDir = mkStateDir();
  const c = createMissionRecord({ goal: 'goal with machine dependency' });
  let mission = c.value;

  let depSolved = 0;
  let resumes = 0;
  const actors = {
    planner: async () => ['original task A'],
    executor: async (child) => {
      if (child.isDependency) {
        depSolved += 1;
        return { ok: true };
      }
      if (child.childId === 'c-1' && depSolved === 0 && resumes === 0) {
        resumes += 1; // first attempt reports machine-solvable blocker; controller must not ask HUMAN
        return { ok: false, blockedOn: 'missing infra artifact (machine-solvable)' };
      }
      return { ok: true };
    },
    verifier: async () => ({ verdict: 'PASS' }),
    finalReviewer: async () => ({ verdict: 'PASS', findings: [], evidenceValid: true }),
  };

  const res = await runMissionLoop({ mission, actors, stateDir });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'AWAITING_HUMAN_MERGE_DECISION');
  assert.equal(res.value.state, MISSION_AWAITING_HUMAN_MERGE_DECISION);
  assert.equal(res.value.humanActionRequired, false);
  assert.equal(depSolved, 1);
  assert.ok(res.trace.some((t) => t.startsWith('blocked_on:')));
  assert.ok(res.trace.some((t) => t.startsWith('dep-solved:')));
  // Root goal survived the BLOCKED child: mission record still carries the goal.
  assert.equal(res.value.goal, 'goal with machine dependency');
});

// Critical invariant: non-PASS + non-gated ⇒ deterministic NEXT_MACHINE_ACTION.
// False gates must never become human gates.
test('MVP-3: invariant + human-gate policy (false gates rejected, true gates pause)', () => {
  const c = createMissionRecord({ goal: 'invariant goal' });
  let m = c.value;
  const p = planMission({ mission: m, childGoals: ['child A'] });
  assert.equal(p.ok, true);
  m = p.value;
  const d = dispatchChild({ mission: m });
  assert.equal(d.ok, true);
  m = d.value; // CHILD_ACTIVE, finalReviewStatus NOT_RUN, no human gate
  const inv = checkInvariant(m);
  assert.equal(inv.ok, true, JSON.stringify(inv));
  const nxt = nextMachineAction(m);
  assert.equal(nxt.ok, true);
  assert.equal(nxt.value.actor, 'EXECUTOR');

  // Machine-solvable reasons must NOT pause the mission.
  const falseGates = ['EXECUTOR_EXITED', 'STALE_SESSION_ACTIVE', 'REVIEW_REWORK', 'TEST_FAIL',
    'EVIDENCE_TRANSPORT_FAIL', 'HANDOFF_PERSIST_FAIL', 'WORKTREE_INFRA',
    'MACHINE_SOLVABLE_DEPENDENCY', 'REPAIR_TASK_REQUIRED'];
  for (const g of falseGates) {
    assert.equal(isTrueHumanGate(g), false, g);
    const r = raiseHumanGate({ mission: m, reason: g });
    assert.equal(r.ok, false, g);
    assert.equal(r.code, 'NOT_A_HUMAN_GATE', g);
  }
  // True gates pause.
  for (const g of ['CREDENTIAL_REQUIRED', 'BUSINESS_DECISION_REQUIRED', 'DESTRUCTIVE_PRODUCTION_AUTHORITY', 'BRON_DATA_REQUIRED']) {
    assert.equal(isTrueHumanGate(g), true, g);
    const r = raiseHumanGate({ mission: m, reason: g });
    assert.equal(r.ok, true, g);
    assert.equal(r.value.state, MISSION_AWAITING_HUMAN);
    assert.equal(r.value.humanActionRequired, true);
  }
});

// Completion gate: only independent Final Reviewer PASS completes.
// OCR/executor/tests alone never terminate.
test('MVP-4: only final PASS terminates; REWORK routes to repair epoch', () => {
  const c = createMissionRecord({ goal: 'gate goal' });
  let m = planMission({ mission: c.value, childGoals: ['child A'] }).value;
  m = dispatchChild({ mission: m }).value;
  // REWORK keeps the mission alive with a deterministic repair action.
  const rw = finalReviewVerdict({ mission: m, childId: 'c-1', verdict: 'REWORK', findings: ['f1'] });
  assert.equal(rw.ok, true);
  assert.equal(rw.value.state, 'REWORK');
  assert.notEqual(rw.value.state, MISSION_FINAL_REVIEW_ACCEPTED);
  const inv = checkInvariant(rw.value);
  assert.equal(inv.ok, true);
  assert.equal(nextMachineAction(rw.value).value.actor, 'REPAIR');
  // PASS without valid canonical evidence is refused.
  const bad = finalReviewVerdict({ mission: m, childId: 'c-1', verdict: 'PASS', findings: [], evidenceValid: false });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'PASS_EVIDENCE_INVALID');
});

// Recovery: OpenCode window close / executor exit must not kill the loop;
// controller resumes from the nearest verified checkpoint without full rerun.
test('MVP-5: recovery resumes from verified checkpoint, root goal retained', async () => {
  const stateDir = mkStateDir();
  const c = createMissionRecord({ goal: 'recovery goal' });
  const actors = {
    planner: async () => ['child A'],
    executor: async () => ({ ok: true }),
    verifier: async () => ({ verdict: 'PASS' }),
    finalReviewer: async () => ({ verdict: 'PASS', findings: [], evidenceValid: true }),
  };
   const res = await runMissionLoop({ mission: c.value, actors, stateDir });
   assert.equal(res.ok, false);
   assert.equal(res.code, 'AWAITING_HUMAN_MERGE_DECISION');
   // Simulate a fresh process reattaching (transport restart): read canonical state.
   const back = readMission({ stateDir, missionId: c.value.missionId });
   assert.equal(back.ok, true);
   assert.equal(back.value.state, MISSION_AWAITING_HUMAN_MERGE_DECISION);
   assert.equal(back.value.goal, 'recovery goal');
   const rec = recover({ stateDir, missionId: c.value.missionId });
   assert.equal(rec.ok, true);
   assert.ok(rec.value.verifiedCheckpoints.includes('c-1'));
});

// Universal loop: Web2API PASS -> AWAITING_HUMAN_MERGE_DECISION (non-terminal).
test('U1: Web2API PASS -> AWAITING_HUMAN_MERGE_DECISION, non-terminal', async () => {
  const stateDir = mkStateDir();
  const c = createMissionRecord({ goal: 'universal loop pass->await-merge' });
  let mission = c.value;
  assert.equal(persistMission({ stateDir, mission }).ok, true);
  const actors = {
    planner: async () => ['child A'],
    executor: async () => ({ ok: true }),
    verifier: async () => ({ verdict: 'PASS' }),
    finalReviewer: async () => ({ verdict: 'PASS', findings: [], evidenceValid: true }),
  };
  const res = await runMissionLoop({ mission, actors, stateDir });
  // runMissionLoop returns non-terminal code for AWAITING_HUMAN_MERGE_DECISION.
  assert.equal(res.ok, false);
  assert.equal(res.code, 'AWAITING_HUMAN_MERGE_DECISION');
  assert.equal(res.value.state, MISSION_AWAITING_HUMAN_MERGE_DECISION);
  assert.equal(res.value.finalReviewStatus, 'PASS');
  assert.equal(res.value.finalVerdict, 'PASS');
  assert.equal(res.value.humanActionRequired, false);
  assert.equal(res.value.mergeAuthorized, false);
  assert.equal(res.value.nextMachineAction.do, 'review and approve/cancel/defer merge');
  const back = readMission({ stateDir, missionId: mission.missionId });
  assert.equal(back.value.state, MISSION_AWAITING_HUMAN_MERGE_DECISION);
});

// U2: APPROVE_MERGE requires explicit authority -> MISSION_COMPLETED.
test('U2: APPROVE_MERGE with authority -> MISSION_COMPLETED', () => {
  const m = createMissionRecord({ goal: 'approve merge test' }).value;
  m.state = MISSION_AWAITING_HUMAN_MERGE_DECISION;
  m.finalReviewStatus = 'PASS'; m.finalVerdict = 'PASS';
  const r = approveMerge({ mission: m, authority: 'Bố-APPROVE-MERGE' });
  assert.equal(r.ok, true);
  assert.equal(r.value.state, MISSION_COMPLETED);
  assert.equal(r.value.mergeAuthorized, true);
  assert.equal(r.value.mergeAuthority, 'Bố-APPROVE-MERGE');
});
test('U3: APPROVE_MERGE without authority -> FAIL', () => {
  const m = createMissionRecord({ goal: 'approve merge test' }).value;
  m.state = MISSION_AWAITING_HUMAN_MERGE_DECISION;
  m.finalReviewStatus = 'PASS'; m.finalVerdict = 'PASS';
  const r = approveMerge({ mission: m, authority: null });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MERGE_AUTHORITY_REQUIRED');
});
// U4: REJECT_MERGE -> MISSION_CLOSED_NOT_MERGED.
test('U4: REJECT_MERGE -> MISSION_CLOSED_NOT_MERGED', () => {
  const m = createMissionRecord({ goal: 'reject merge test' }).value;
  m.state = MISSION_AWAITING_HUMAN_MERGE_DECISION;
  m.finalReviewStatus = 'PASS'; m.finalVerdict = 'PASS';
  const r = rejectMerge({ mission: m, reason: 'REJECT_MERGE' });
  assert.equal(r.ok, true);
  assert.equal(r.value.state, MISSION_CLOSED_NOT_MERGED);
  assert.equal(r.value.mergeAuthorized, false);
});
// U5: DEFER -> stays AWAITING_HUMAN_MERGE_DECISION, non-terminal.
test('U5: DEFER -> stays AWAITING_HUMAN_MERGE_DECISION, non-terminal', () => {
  const m = createMissionRecord({ goal: 'defer merge test' }).value;
  m.state = MISSION_AWAITING_HUMAN_MERGE_DECISION;
  m.finalReviewStatus = 'PASS'; m.finalVerdict = 'PASS';
  const r = deferMerge({ mission: m });
  assert.equal(r.ok, true);
  assert.equal(r.value.state, MISSION_AWAITING_HUMAN_MERGE_DECISION);
});
// U6: REWORK -> repair -> commit new -> review HEAD new -> AWAITING_HUMAN_MERGE_DECISION.
test('U6: REWORK loop creates new epoch, fresh review HEAD new', async () => {
  const stateDir = mkStateDir();
  const c = createMissionRecord({ goal: 'rework loop test' });
  let mission = c.value;
  assert.equal(persistMission({ stateDir, mission }).ok, true);
  let reviewEpochs = [];
  const actors = {
    planner: async () => ['child A'],
    executor: async () => ({ ok: true }),
    verifier: async () => ({ verdict: 'PASS' }),
    finalReviewer: async (child, epoch) => {
      reviewEpochs.push(epoch);
      if (epoch === 1) return { verdict: 'REWORK', findings: ['fix needed'], evidenceValid: true };
      return { verdict: 'PASS', findings: [], evidenceValid: true };
    },
    repair: async () => {},
  };
  const res = await runMissionLoop({ mission, actors, stateDir });
  assert.equal(res.code, 'AWAITING_HUMAN_MERGE_DECISION');
  assert.equal(res.value.state, MISSION_AWAITING_HUMAN_MERGE_DECISION);
  assert.ok(reviewEpochs.length >= 2, `review epochs: ${reviewEpochs}`);
  assert.ok(reviewEpochs[0] < reviewEpochs[reviewEpochs.length - 1], 'new epoch after rework');
});
// U7: checkInvariant: AWAITING_HUMAN_MERGE_DECISION is non-terminal, idle allowed.
test('U7: checkInvariant: AWAITING_HUMAN_MERGE_DECISION non-terminal idle allowed', () => {
  const m = createMissionRecord({ goal: 'invariant test' }).value;
  m.state = MISSION_AWAITING_HUMAN_MERGE_DECISION;
  m.finalReviewStatus = 'PASS'; m.finalVerdict = 'PASS';
  const inv = checkInvariant(m);
  assert.equal(inv.ok, true);
  assert.equal(inv.value.invariant, 'AWAITING_HUMAN_MERGE_DECISION — human merge decision required');
});
// U8: MISSION_COMPLETED/MISSION_CLOSED_NOT_MERGED are terminal.
test('U8: completed/closed states are terminal', () => {
  for (const s of [MISSION_COMPLETED, MISSION_CLOSED_NOT_MERGED] ) {
    const m = createMissionRecord({ goal: 'terminal test' }).value;
    m.state = s;
    const nxt = nextMachineAction(m);
    assert.equal(nxt.ok, false, `${s} must be terminal`);
    assert.equal(nxt.code, 'MISSION_TERMINAL');
  }
});
