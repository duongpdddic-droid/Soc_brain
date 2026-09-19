#!/usr/bin/env node
// mission-loop.mjs — MVP autonomous loop controller (ONE GOAL → FINAL REVIEW PASS).
//
// Scope (explicit, per MVP reprioritization):
// - IN SCOPE: root mission owns the loop; plan → child task → executor →
//   self-verify → bounded OCR/pre-review → repair → canonical evidence/handoff
//   → independent Final Reviewer → PASS, or REWORK → auto repair → re-verify →
//   re-review until PASS; machine-solvable BLOCKED_ON dependency auto-resolve
//   then auto-resume; recovery from canonical persisted state; deterministic
//   NEXT_MACHINE_ACTION invariant.
// - OUT OF SCOPE (deferred, never executed here): UI/progress dashboard,
//   MERGE/DEPLOY/CLOSE/CLEANUP delivery. Terminal success is
//   MISSION_FINAL_REVIEW_ACCEPTED — distinct from MERGED/DEPLOYED/CLOSED.
//   This module never merges, deploys, closes or cleans up.
//
// Authority:
// - Only the independent Final Reviewer verdict PASS (read from canonical
//   evidence) satisfies the completion gate. OCR/pre-review PASS, executor
//   "done", tests green, or request_review receipts never complete the mission.
// - TRUE HUMAN GATE only: credential/permission missing, mandatory business
//   decision, destructive/production authority, data only Bố holds.
//   Everything else (executor EXITED, stale SESSION_ACTIVE, REWORK, test fail,
//   evidence transport fail, handoff persistence fail, worktree infra,
//   machine-solvable dependency, create/resume repair task) is NOT a human
//   gate and MUST yield a deterministic machine action.
//
// Persistence / recovery:
// - Canonical state: <stateDir>/mission-loop/<missionId>.json (tmp+rename).
// - History ledger: <stateDir>/mission-loop/<missionId>.history.jsonl.
// - recover() re-reads canonical state and resumes from the nearest verified
//   checkpoint (completed child checkpoints are never re-executed).
//
// Pure where possible: all transition functions are deterministic and
// side-effect free except persist()/appendHistory().

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const MISSION_LOOP_VERSION = '1';

// Terminal success — NON-TERMINAL: Web2API PASS is technical evidence,
// not delivery. Always transitions to AWAITING_HUMAN_MERGE_DECISION.
export const MISSION_FINAL_REVIEW_ACCEPTED = 'MISSION_FINAL_REVIEW_ACCEPTED';
// Non-terminal: awaiting human merge decision after PASS.
export const MISSION_AWAITING_HUMAN_MERGE_DECISION = 'AWAITING_HUMAN_MERGE_DECISION';
// Terminal pause — ONLY on a TRUE human gate.
export const MISSION_AWAITING_HUMAN = 'MISSION_AWAITING_HUMAN';
// Closed without merge.
export const MISSION_CLOSED_NOT_MERGED = 'MISSION_CLOSED_NOT_MERGED';
// Completed after merge/read-back.
export const MISSION_COMPLETED = 'MISSION_COMPLETED';

export const MISSION_STATES = Object.freeze([
  'MISSION_ACCEPTED',
  'PLANNED',
  'CHILD_ACTIVE',
  'VERIFYING',
  'FINAL_REVIEWING',
  'REWORK',
  'BLOCKED_ON_DEPENDENCY',
  'RESUMING',
  MISSION_FINAL_REVIEW_ACCEPTED,
  MISSION_AWAITING_HUMAN_MERGE_DECISION,
  MISSION_AWAITING_HUMAN,
  MISSION_CLOSED_NOT_MERGED,
  MISSION_COMPLETED,
]);

export const MISSION_TERMINAL_STATES = Object.freeze(
  new Set([MISSION_AWAITING_HUMAN, MISSION_CLOSED_NOT_MERGED, MISSION_COMPLETED]),
);
// NON-TERMINAL terminal-ish states (require human merge decision):
export const MISSION_NON_TERMINAL_ACCEPTED = Object.freeze(
  new Set([MISSION_FINAL_REVIEW_ACCEPTED, MISSION_AWAITING_HUMAN_MERGE_DECISION]),
);

// ---- Human-gate policy (allowlist true, denylist false) ----------------------
// TRUE gates (pause allowed):
export const TRUE_HUMAN_GATES = Object.freeze([
  'CREDENTIAL_REQUIRED',
  'PERMISSION_REQUIRED',
  'BUSINESS_DECISION_REQUIRED',
  'DESTRUCTIVE_PRODUCTION_AUTHORITY',
  'BRON_DATA_REQUIRED',
]);
// Machine-solvable — NEVER a human gate:
export const NON_HUMAN_GATES = Object.freeze([
  'EXECUTOR_EXITED',
  'STALE_SESSION_ACTIVE',
  'REVIEW_REWORK',
  'TEST_FAIL',
  'EVIDENCE_TRANSPORT_FAIL',
  'HANDOFF_PERSIST_FAIL',
  'WORKTREE_INFRA',
  'MACHINE_SOLVABLE_DEPENDENCY',
  'REPAIR_TASK_REQUIRED',
]);

export function isTrueHumanGate(reasonCode) {
  const c = String(reasonCode || '');
  if (TRUE_HUMAN_GATES.includes(c)) return true;
  return false;
}

export function assertNotHumanGate(reasonCode) {
  if (isTrueHumanGate(reasonCode)) {
    return { ok: false, code: 'IS_TRUE_HUMAN_GATE', detail: reasonCode };
  }
  return { ok: true };
}

function fail(code, detail) {
  return { ok: false, code, detail: detail ?? null };
}
function ok(value, extra = {}) {
  return { ok: true, value, ...extra };
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function missionFileFor({ stateDir, missionId }) {
  return path.join(stateDir, 'mission-loop', `${missionId}.json`);
}

export function missionHistoryFor({ stateDir, missionId }) {
  return path.join(stateDir, 'mission-loop', `${missionId}.history.jsonl`);
}

export function newMissionId() {
  return `m-${randomUUID().slice(0, 8)}`;
}

// ---- Mission record ----------------------------------------------------------
export function createMissionRecord({ goal, missionId = newMissionId(), now = () => new Date().toISOString() } = {}) {
  if (typeof goal !== 'string' || !goal.trim()) return fail('GOAL_REQUIRED');
  const id = String(missionId);
  return ok({
    schemaVersion: MISSION_LOOP_VERSION,
    missionId: id,
    goal: goal.trim(),
    state: 'MISSION_ACCEPTED',
    children: [],
    activeChildId: null,
    dependencies: [],
    reviewEpoch: 0,
    finalReviewStatus: 'NOT_RUN',
    finalVerdict: null,
    humanGateRequired: false,
    humanGateReason: null,
    nextMachineAction: { actor: 'PLANNER', do: 'decompose goal into canonical child tasks', verify: 'child list persisted', stop: 'no merge/deploy' },
    humanActionRequired: false,
    history: [],
    createdAt: now(),
    updatedAt: now(),
  });
}

export function persistMission({ stateDir, mission }) {
  if (!mission || typeof mission.missionId !== 'string') return fail('MISSION_REQUIRED');
  const fp = missionFileFor({ stateDir, missionId: mission.missionId });
  const tmp = `${fp}.tmp-${randomUUID()}`;
  try {
    ensureDir(path.dirname(fp));
    fs.writeFileSync(tmp, JSON.stringify(mission, null, 2), 'utf8');
    fs.renameSync(tmp, fp);
    return ok({ path: fp });
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    return fail('MISSION_PERSIST_FAILED', String((e && e.message) || e));
  }
}

export function readMission({ stateDir, missionId }) {
  const fp = missionFileFor({ stateDir, missionId });
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const m = JSON.parse(raw);
    if (!m || m.missionId !== missionId) return fail('MISSION_IDENTITY_MISMATCH', fp);
    return ok(m, { path: fp });
  } catch (e) {
    return fail('MISSION_READ_FAILED', String((e && e.message) || e));
  }
}

export function appendHistory({ stateDir, missionId, event }) {
  const fp = missionHistoryFor({ stateDir, missionId });
  try {
    ensureDir(path.dirname(fp));
    fs.appendFileSync(fp, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', 'utf8');
    return ok({ path: fp });
  } catch (e) {
    return fail('HISTORY_APPEND_FAILED', String((e && e.message) || e));
  }
}

// recover(): READ-ONLY reattach to canonical state. Never resubmits the goal,
// never creates a second mission, never re-executes verified checkpoints.
export function recover({ stateDir, missionId }) {
  const r = readMission({ stateDir, missionId });
  if (!r.ok) return r;
  const m = r.value;
  const verifiedCheckpoints = (m.children || []).filter((c) => c.checkpointVerified === true).map((c) => c.childId);
  const nxt = nextMachineAction(m);
  return ok({
    mission: m,
    verifiedCheckpoints,
    nextMachineAction: nxt.ok ? nxt.value : null,
    nextError: nxt.ok ? null : nxt,
  });
}

// ---- Core invariant -----------------------------------------------------------
// If FINAL_REVIEW_STATUS != PASS AND HUMAN_GATE_REQUIRED != true,
// the mission MUST NOT idle: a deterministic NEXT_MACHINE_ACTION must exist.
export function nextMachineAction(mission) {
  if (!mission || typeof mission !== 'object') return fail('MISSION_REQUIRED');
  if (MISSION_NON_TERMINAL_ACCEPTED.has(mission.state)) {
    return fail('NON_TERMINAL_ACCEPTED', 'PASS received but awaiting human merge decision — no machine action');
  }
  if (mission.state === MISSION_AWAITING_HUMAN_MERGE_DECISION) {
    return fail('AWAITING_HUMAN_MERGE_DECISION', 'non-terminal: awaiting human merge decision');
  }
  if (mission.state === MISSION_CLOSED_NOT_MERGED || mission.state === MISSION_COMPLETED) {
    return fail('MISSION_TERMINAL', `${mission.state} — no further machine action`);
  }
  if (mission.state === MISSION_AWAITING_HUMAN) {
    if (mission.humanGateRequired === true && isTrueHumanGate(mission.humanGateReason)) {
      return fail('HUMAN_GATE_ACTIVE', mission.humanGateReason);
    }
    // Corrupt terminal: claims awaiting human without a true gate → repair to machine action.
    return ok({ actor: 'CONTROLLER', do: 'clear spurious human gate; resume from verified checkpoint', verify: 'humanGateRequired=false', stop: 'no merge/deploy' });
  }
  if (mission.humanGateRequired === true) {
    if (isTrueHumanGate(mission.humanGateReason)) {
      return fail('HUMAN_GATE_ACTIVE', mission.humanGateReason);
    }
    return fail('INVALID_HUMAN_GATE', `reason ${mission.humanGateReason} is machine-solvable and MUST NOT pause the mission`);
  }
  if (mission.finalReviewStatus === 'PASS' || mission.finalVerdict === 'PASS') {
    return fail('MISSING_TERMINAL_TRANSITION', 'verdict PASS recorded but terminal transition not yet applied — controller must apply AWAITING_HUMAN_MERGE_DECISION');
  }
  // Deterministic routing by state — every non-terminal, non-gated state maps
  // to exactly one machine actor. Root goal never disappears on child end.
  switch (mission.state) {
    case 'MISSION_ACCEPTED':
      return ok({ actor: 'PLANNER', do: 'decompose goal into canonical child tasks', verify: 'child list persisted', stop: 'no merge/deploy' });
    case 'PLANNED':
      return ok({ actor: 'DISPATCHER', do: `dispatch next idle child (activeChild=${mission.activeChildId ?? 'none'})`, verify: 'child state=CHILD_ACTIVE', stop: 'no merge/deploy' });
    case 'CHILD_ACTIVE':
      return ok({ actor: 'EXECUTOR', do: `implement child ${mission.activeChildId}`, verify: 'self-verify + evidence persisted', stop: 'no merge/deploy/terminalize' });
    case 'VERIFYING':
      return ok({ actor: 'VERIFIER', do: `deterministic verify child ${mission.activeChildId}`, verify: 'verdict persisted', stop: 'tests-green alone never completes mission' });
    case 'FINAL_REVIEWING':
      return ok({ actor: 'FINAL_REVIEWER', do: 'independent final review of canonical evidence', verify: 'strict verdict PASS|REWORK|BLOCKED + binding', stop: 'OCR PASS never substitutes final PASS' });
    case 'REWORK':
      return ok({ actor: 'REPAIR', do: `repair epoch ${mission.reviewEpoch} findings for child ${mission.activeChildId}, then re-verify`, verify: 'targeted + regression evidence', stop: 'no scope expansion' });
    case 'BLOCKED_ON_DEPENDENCY': {
      const dep = (mission.dependencies || []).find((d) => d.state !== 'DEP_PASS');
      if (!dep) return ok({ actor: 'CONTROLLER', do: `no pending dep — resume child ${mission.activeChildId}`, verify: 'child state=RESUMING', stop: 'no merge/deploy' });
      return ok({ actor: 'DEPENDENCY_SOLVER', do: `solve dependency ${dep.depId} blocking ${dep.blocksChildId}`, verify: 'dep state=DEP_PASS then resume', stop: 'never return coordination to HUMAN' });
    }
    case 'RESUMING':
      return ok({ actor: 'CONTROLLER', do: `resume child ${mission.activeChildId} from verified checkpoint`, verify: 'no full rerun from scratch', stop: 'no merge/deploy' });
    default:
      return fail('UNKNOWN_MISSION_STATE', mission.state);
  }
}

export function checkInvariant(mission) {
  const finalPass = mission.finalReviewStatus === 'PASS' || mission.finalVerdict === 'PASS';
  const nonTerminalAccepted = MISSION_NON_TERMINAL_ACCEPTED.has(mission.state);
  if (finalPass && !nonTerminalAccepted && mission.state !== MISSION_FINAL_REVIEW_ACCEPTED) {
    return fail('INVARIANT_PENDING_TERMINAL', 'PASS recorded but non-terminal transition not yet applied');
  }
  if (nonTerminalAccepted) return ok({ invariant: 'AWAITING_HUMAN_MERGE_DECISION — human merge decision required', state: mission.state });
  if (mission.state === MISSION_CLOSED_NOT_MERGED || mission.state === MISSION_COMPLETED) return ok({ invariant: 'terminal — idle allowed' });
  if (mission.humanGateRequired === true) {
    if (!isTrueHumanGate(mission.humanGateReason)) {
      return fail('INVARIANT_VIOLATED', `spurious human gate ${mission.humanGateReason}: machine-solvable work must not idle`);
    }
    return ok({ invariant: 'true human gate — pause allowed' });
  }
  const nxt = nextMachineAction(mission);
  if (!nxt.ok) return fail('INVARIANT_VIOLATED', `no deterministic NEXT_MACHINE_ACTION: ${nxt.code} ${JSON.stringify(nxt.detail ?? null)}`);
  return ok({ invariant: 'NEXT_MACHINE_ACTION exists', next: nxt.value });
}

// ---- Transitions (deterministic, root goal survives child end) ----------------
function touch(mission, now) {
  return { ...mission, updatedAt: now() };
}

export function planMission({ mission, childGoals, now = () => new Date().toISOString() } = {}) {
  if (!mission || mission.state !== 'MISSION_ACCEPTED') return fail('PLAN_STATE_INVALID', mission && mission.state);
  if (!Array.isArray(childGoals) || !childGoals.length) return fail('CHILD_GOALS_REQUIRED');
  const children = childGoals.map((g, i) => ({
    childId: `c-${i + 1}`,
    goal: String(g),
    state: 'CHILD_QUEUED',
    reviewEpoch: 0,
    verdict: null,
    findings: [],
    checkpointVerified: false,
  }));
  const m = touch({ ...mission, state: 'PLANNED', children, activeChildId: children[0].childId }, now);
  m.nextMachineAction = nextMachineAction(m).ok ? nextMachineAction(m).value : null;
  return ok(m);
}

export function dispatchChild({ mission, now = () => new Date().toISOString() } = {}) {
  if (!mission || (mission.state !== 'PLANNED' && mission.state !== 'RESUMING')) {
    return fail('DISPATCH_STATE_INVALID', mission && mission.state);
  }
  const next = (mission.children || []).find((c) => c.state === 'CHILD_QUEUED' || c.state === 'CHILD_RESUMED')
    || (mission.children || []).find((c) => c.childId === mission.activeChildId);
  if (!next) return fail('NO_CHILD_TO_DISPATCH');
  const children = mission.children.map((c) => (c.childId === next.childId ? { ...c, state: 'CHILD_ACTIVE' } : c));
  const m = touch({ ...mission, state: 'CHILD_ACTIVE', children, activeChildId: next.childId }, now);
  m.nextMachineAction = nextMachineAction(m).ok ? nextMachineAction(m).value : null;
  return ok(m);
}

export function childVerified({ mission, childId, verifyVerdict, now = () => new Date().toISOString() } = {}) {
  if (!mission || (mission.state !== 'CHILD_ACTIVE' && mission.state !== 'VERIFYING')) return fail('VERIFY_STATE_INVALID', mission && mission.state);
  if (verifyVerdict !== 'PASS') return fail('VERIFY_MUST_PASS_TO_ADVANCE', verifyVerdict);
  const children = (mission.children || []).map((c) => (c.childId === childId ? { ...c, state: 'VERIFY_PASS' } : c));
  const m = touch({ ...mission, state: 'FINAL_REVIEWING', children }, now);
  m.nextMachineAction = nextMachineAction(m).ok ? nextMachineAction(m).value : null;
  return ok(m);
}

// The ONLY completion path: independent Final Reviewer verdict PASS on valid
// canonical evidence. Never OCR, never executor-done, never tests-green alone.
export function finalReviewVerdict({ mission, childId, verdict, findings = [], evidenceValid = true, now = () => new Date().toISOString() } = {}) {
  if (!mission) return fail('MISSION_REQUIRED');
  if (!['PASS', 'REWORK', 'BLOCKED'].includes(verdict)) return fail('VERDICT_INVALID', verdict);
  if (verdict === 'PASS' && evidenceValid !== true) {
    return fail('PASS_EVIDENCE_INVALID', 'PASS requires valid canonical evidence');
  }
  if (verdict === 'PASS') {
    const children = (mission.children || []).map((c) => (
      c.childId === childId ? { ...c, state: 'CHILD_FINAL_PASS', verdict: 'PASS', checkpointVerified: true } : c
    ));
    const allPass = children.length > 0 && children.every((c) => c.state === 'CHILD_FINAL_PASS');
    if (!allPass) {
      // More children remain: root goal survives, controller dispatches next.
      const nextQ = children.find((c) => c.state === 'CHILD_QUEUED');
      const m = touch({
        ...mission,
        state: nextQ ? 'PLANNED' : 'FINAL_REVIEWING',
        children,
        activeChildId: nextQ ? nextQ.childId : mission.activeChildId,
        reviewEpoch: mission.reviewEpoch + 1,
        finalReviewStatus: 'PARTIAL_PASS',
        finalVerdict: null,
      }, now);
      m.nextMachineAction = { actor: 'DISPATCHER', do: nextQ ? `dispatch next child ${nextQ.childId}` : 'await remaining children', verify: 'root goal retained', stop: 'no merge/deploy' };
      return ok(m);
    }
    const m = touch({
      ...mission,
      state: MISSION_AWAITING_HUMAN_MERGE_DECISION,
      children,
      reviewEpoch: mission.reviewEpoch + 1,
      finalReviewStatus: 'PASS',
      finalVerdict: 'PASS',
      humanGateRequired: false,
      humanGateReason: null,
      humanActionRequired: false,
      mergeAuthorized: false,
      mergeHeadShaReadBack: null,
      nextMachineAction: { actor: 'HUMAN', do: 'review and approve/cancel/defer merge', verify: 'human merge decision recorded', stop: 'no auto-merge' },
    }, now);
    return ok(m);
  }
  if (verdict === 'REWORK') {
    const children = (mission.children || []).map((c) => (
      c.childId === childId
        ? { ...c, state: 'REWORK', verdict: 'REWORK', findings: [...findings], reviewEpoch: (c.reviewEpoch || 0) + 1 }
        : c
    ));
    const m = touch({
      ...mission, state: 'REWORK', children, reviewEpoch: mission.reviewEpoch + 1,
      finalReviewStatus: 'REWORK', finalVerdict: 'REWORK',
    }, now);
    m.nextMachineAction = nextMachineAction(m).ok ? nextMachineAction(m).value : null;
    return ok(m);
  }
  // verdict BLOCKED: machine-solvable → BLOCKED_ON_DEPENDENCY (auto), never human.
  const depId = `d-${(mission.dependencies || []).length + 1}`;
  const dep = { depId, goal: `resolve blocker for ${childId}: ${(findings[0] || 'blocked dependency')}`.slice(0, 280), state: 'DEP_ACTIVE', blocksChildId: childId, findings: [...findings] };
  const children = (mission.children || []).map((c) => (c.childId === childId ? { ...c, state: 'BLOCKED_ON' } : c));
  const m = touch({
    ...mission, state: 'BLOCKED_ON_DEPENDENCY', children,
    dependencies: [...(mission.dependencies || []), dep],
    finalReviewStatus: 'BLOCKED', finalVerdict: 'BLOCKED',
  }, now);
  m.nextMachineAction = nextMachineAction(m).ok ? nextMachineAction(m).value : null;
  return ok(m);
}

export function repairDone({ mission, childId, now = () => new Date().toISOString() } = {}) {
  if (!mission || mission.state !== 'REWORK') return fail('REPAIR_STATE_INVALID', mission && mission.state);
  const children = (mission.children || []).map((c) => (c.childId === childId ? { ...c, state: 'CHILD_ACTIVE', verdict: null, findings: [] } : c));
  const m = touch({ ...mission, state: 'VERIFYING', children }, now);
  m.nextMachineAction = nextMachineAction(m).ok ? nextMachineAction(m).value : null;
  return ok(m);
}

export function dependencyPassed({ mission, depId, now = () => new Date().toISOString() } = {}) {
  if (!mission || mission.state !== 'BLOCKED_ON_DEPENDENCY') return fail('DEP_STATE_INVALID', mission && mission.state);
  const dep = (mission.dependencies || []).find((d) => d.depId === depId);
  if (!dep) return fail('DEP_NOT_FOUND', depId);
  const dependencies = (mission.dependencies || []).map((d) => (d.depId === depId ? { ...d, state: 'DEP_PASS' } : d));
  const children = (mission.children || []).map((c) => (c.childId === dep.blocksChildId ? { ...c, state: 'CHILD_RESUMED' } : c));
  const m = touch({
    ...mission, state: 'RESUMING', dependencies, children,
    activeChildId: dep.blocksChildId, finalReviewStatus: 'RESUMED', finalVerdict: null,
  }, now);
  m.nextMachineAction = nextMachineAction(m).ok ? nextMachineAction(m).value : null;
  return ok(m);
}

// Human gate: ONLY true gates may pause. Anything else fails closed.
export function raiseHumanGate({ mission, reason, now = () => new Date().toISOString() } = {}) {
  if (!mission) return fail('MISSION_REQUIRED');
  if (!isTrueHumanGate(reason)) {
    return fail('NOT_A_HUMAN_GATE', `${reason} is machine-solvable and MUST NOT pause the mission`);
  }
  const m = touch({
    ...mission, state: MISSION_AWAITING_HUMAN,
    humanGateRequired: true, humanGateReason: reason, humanActionRequired: true,
    nextMachineAction: null,
  }, now);
  return ok(m);
}

// ---- Human merge decision (Part D) -----------------------------------
// Only three valid decisions. APPROVE_MERGE requires explicit authority.
export function approveMerge({ mission, authority, now = () => new Date().toISOString() } = {}) {
  if (!mission) return fail('MISSION_REQUIRED');
  if (mission.state !== MISSION_AWAITING_HUMAN_MERGE_DECISION) {
    return fail('MERGE_STATE_INVALID', `expected AWAITING_HUMAN_MERGE_DECISION, got ${mission.state}`);
  }
  if (!authority) return fail('MERGE_AUTHORITY_REQUIRED', 'APPROVE_MERGE requires explicit human authorization');
  const m = touch({
    ...mission, state: MISSION_COMPLETED,
    mergeAuthorized: true, mergeAuthority: authority,
    humanActionRequired: false, nextMachineAction: null,
  }, now);
  return ok(m);
}
export function rejectMerge({ mission, reason, now = () => new Date().toISOString() } = {}) {
  if (!mission) return fail('MISSION_REQUIRED');
  if (![MISSION_AWAITING_HUMAN_MERGE_DECISION, MISSION_FINAL_REVIEW_ACCEPTED].includes(mission.state)) {
    return fail('MERGE_STATE_INVALID', `expected AWAITING_HUMAN_MERGE_DECISION or FINAL_REVIEW_ACCEPTED, got ${mission.state}`);
  }
  const m = touch({
    ...mission, state: MISSION_CLOSED_NOT_MERGED,
    mergeAuthorized: false, mergeRejectReason: reason ?? 'REJECT_MERGE',
    humanActionRequired: false, nextMachineAction: null,
  }, now);
  return ok(m);
}
export function deferMerge({ mission, now = () => new Date().toISOString() } = {}) {
  if (!mission) return fail('MISSION_REQUIRED');
  if (mission.state !== MISSION_AWAITING_HUMAN_MERGE_DECISION) {
    return fail('MERGE_STATE_INVALID', `expected AWAITING_HUMAN_MERGE_DECISION, got ${mission.state}`);
  }
  // DEFER: stay non-terminal, no auto-merge, no repeated polling.
  return ok(touch({ ...mission, nextMachineAction: null }, now));
}

// ---- Deterministic driver (used by the acceptance test AND as the canonical
// reference loop; production wires real actors with the same shape) -------------
// actors: { planner(goal)->childGoals[], executor(child)->{ok|blockedOn},
//   verifier(child)->{verdict}, preReview(child, epoch)->{ok},
//   finalReviewer(child, epoch)->{verdict,findings,evidenceValid},
//   repair(child, findings)->void, solveDependency(dep)->void }
// Returns the mission. AWAITING_HUMAN_MERGE_DECISION is non-terminal
// (requires human merge decision); only MISSION_CLOSED_NOT_MERGED /
// MISSION_COMPLETED are terminal. humanActionRequired stays false
// throughout unless a TRUE human gate was raised.
export async function runMissionLoop({ mission, actors = {}, stateDir = null, maxEpochs = 20 } = {}) {
  let m = mission;
  const trace = [];
  const persist = () => {
    if (stateDir) {
      persistMission({ stateDir, mission: m });
      appendHistory({ stateDir, missionId: m.missionId, event: { state: m.state, activeChild: m.activeChildId, epoch: m.reviewEpoch, final: m.finalReviewStatus } });
    }
  };
  persist();
  for (let i = 0; i < maxEpochs; i++) {
    const inv = checkInvariant(m);
    if (!inv.ok) return { ok: false, code: inv.code, detail: inv.detail, mission: m, trace };
    // MISSION_FINAL_REVIEW_ACCEPTED / AWAITING_HUMAN_MERGE_DECISION:
    // non-terminal — loop must NOT end here; human merge decision required.
    if (MISSION_NON_TERMINAL_ACCEPTED.has(m.state)) return { ok: false, code: 'AWAITING_HUMAN_MERGE_DECISION', detail: 'PASS received; awaiting human merge decision', value: m, trace };
    if (m.state === MISSION_AWAITING_HUMAN) return { ok: false, code: 'HUMAN_GATE_ACTIVE', detail: m.humanGateReason, value: m, trace };
    if (m.state === MISSION_CLOSED_NOT_MERGED || m.state === MISSION_COMPLETED) return { ok: true, value: m, trace };

    switch (m.state) {
      case 'MISSION_ACCEPTED': {
        const childGoals = await actors.planner(m.goal);
        const r = planMission({ mission: m, childGoals });
        if (!r.ok) return { ok: false, code: r.code, detail: r.detail, mission: m, trace };
        m = r.value; trace.push('planned'); persist(); break;
      }
      case 'PLANNED':
      case 'RESUMING': {
        const r = dispatchChild({ mission: m });
        if (!r.ok) return { ok: false, code: r.code, detail: r.detail, mission: m, trace };
        m = r.value; trace.push(`dispatched:${m.activeChildId}`); persist(); break;
      }
      case 'CHILD_ACTIVE': {
        const child = m.children.find((c) => c.childId === m.activeChildId);
        const ex = await actors.executor(child);
        trace.push(`executed:${child.childId}`);
        if (ex && ex.blockedOn) {
          const r = finalReviewVerdict({ mission: m, childId: child.childId, verdict: 'BLOCKED', findings: [ex.blockedOn] });
          if (!r.ok) return { ok: false, code: r.code, detail: r.detail, mission: m, trace };
          m = r.value; trace.push(`blocked_on:${ex.blockedOn}`); persist(); break;
        }
        if (!ex || ex.ok !== true) return { ok: false, code: 'EXECUTOR_FAILED', detail: ex ?? null, mission: m, trace };
        m = { ...m, state: 'VERIFYING' };
        m.nextMachineAction = nextMachineAction(m).ok ? nextMachineAction(m).value : null;
        persist(); break;
      }
      case 'VERIFYING': {
        const child = m.children.find((c) => c.childId === m.activeChildId);
        const v = await actors.verifier(child);
        trace.push(`verified:${child.childId}=${v && v.verdict}`);
        if (!v || v.verdict !== 'PASS') return { ok: false, code: 'VERIFY_MUST_PASS', detail: v ?? null, mission: m, trace };
        // Bounded OCR/pre-review (informational only, never completes).
        if (actors.preReview) {
          for (let p = 0; p < 2; p++) {
            const pr = await actors.preReview(child, p + 1);
            trace.push(`ocr:${child.childId}:pass${p + 1}`);
            if (pr && pr.actionable === true && actors.repair) {
              await actors.repair(child, pr.findings || []);
              trace.push(`ocr-repair:${child.childId}`);
            }
          }
        }
        const r = childVerified({ mission: m, childId: child.childId, verifyVerdict: 'PASS' });
        if (!r.ok) return { ok: false, code: r.code, detail: r.detail, mission: m, trace };
        m = r.value; trace.push('verify-pass'); persist(); break;
      }
      case 'FINAL_REVIEWING': {
        const child = m.children.find((c) => c.childId === m.activeChildId);
        const fr = await actors.finalReviewer(child, m.reviewEpoch + 1);
        trace.push(`final:${child.childId}=${fr && fr.verdict}:epoch${m.reviewEpoch + 1}`);
        const r = finalReviewVerdict({
          mission: m, childId: child.childId,
          verdict: fr.verdict, findings: fr.findings || [], evidenceValid: fr.evidenceValid !== false,
        });
        if (!r.ok) return { ok: false, code: r.code, detail: r.detail, mission: m, trace };
        m = r.value; persist(); break;
      }
      case 'REWORK': {
        const child = m.children.find((c) => c.childId === m.activeChildId);
        if (actors.repair) {
          await actors.repair(child, child.findings || []);
          trace.push(`repair:${child.childId}:epoch${m.reviewEpoch}`);
        }
        const r = repairDone({ mission: m, childId: child.childId });
        if (!r.ok) return { ok: false, code: r.code, detail: r.detail, mission: m, trace };
        m = r.value; persist(); break;
      }
      case 'BLOCKED_ON_DEPENDENCY': {
        const dep = (m.dependencies || []).find((d) => d.state !== 'DEP_PASS');
        if (!dep) return { ok: false, code: 'DEP_RESOLVE_INVALID', mission: m, trace };
        // Machine-solvable by contract: solve inline, never hand to HUMAN.
        if (actors.solveDependency) {
          await actors.solveDependency(dep);
          trace.push(`dep-solved:${dep.depId}`);
        } else if (actors.executor) {
          await actors.executor({ childId: dep.depId, goal: dep.goal, isDependency: true });
          trace.push(`dep-solved:${dep.depId}`);
        }
        const r = dependencyPassed({ mission: m, depId: dep.depId });
        if (!r.ok) return { ok: false, code: r.code, detail: r.detail, mission: m, trace };
        m = r.value; persist(); break;
      }
      default:
        return { ok: false, code: 'UNKNOWN_MISSION_STATE', detail: m.state, mission: m, trace };
    }
  }
  return { ok: false, code: 'MAX_EPOCHS_EXCEEDED', mission: m, trace };
}
