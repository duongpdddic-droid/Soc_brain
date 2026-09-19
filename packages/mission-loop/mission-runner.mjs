// mission-runner.mjs — Canonical runtime wiring for mission-loop.
//
// ONE entry point: `wakeMission` — called when the executor reaches a
// terminal state (RUNNING → EXITED|FAILED). Everything else is a pure
// state transform of packages/mission-loop/mission-loop.mjs.
//
// Scope: autonomous loop. NO merge/deploy. NO UI.
// PASS -> AWAITING_HUMAN_MERGE_DECISION (non-terminal, requires human merge decision).
// Only MISSION_CLOSED_NOT_MERGED / MISSION_COMPLETED are terminal.
//
// WIRING MAP (runtime → mission-loop, minimal):
//   executor terminal event → wakeMission (create/load mission, persist, no-op if duplicate)
//   CHILD_ACTIVE       → executor launcher (deps.executor)
//   VERIFYING          → deterministic verifier (deps.verifier) — machine-checkable PASS only
//   FINAL_REVIEWING    → createGptFinalReview (deps.finalReview) w/ configured provider
//   REWORK             → repair child + verify + re-review (run via mission-loop driver)
//   BLOCKED_ON_DEPENDENCY → machine-solvable auto-resolve (deps.solveDependency)
//   state change        → append mission-progress event (deps.onProgress)
//
// Checkpoint: mission file at <stateDir>/mission-loop/<missionId>.json (atomic tmp+rename).
// History: <stateDir>/mission-loop/<missionId>.history.jsonl (append-only).
// Recovery: read canonical state → resume from nearest verified checkpoint (no re-run of verified children).
// Ownership: the mission is bound to ONE canonical session; a stale/mismatched
//   binding (foreign taskId / wrong headSha / unknown missionId) fails closed.
//   A mission has at most ONE active controller owner (mission.controllerOwner);
//   a second wake from a different owner fails closed (NEVER duplicate execution).

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  createMissionRecord, persistMission, readMission, recover,
  nextMachineAction, checkInvariant, MISSION_FINAL_REVIEW_ACCEPTED, MISSION_AWAITING_HUMAN,
  MISSION_AWAITING_HUMAN_MERGE_DECISION, MISSION_CLOSED_NOT_MERGED, MISSION_COMPLETED,
  MISSION_NON_TERMINAL_ACCEPTED,
  planMission, dispatchChild, childVerified, repairDone, dependencyPassed, finalReviewVerdict,
} from './mission-loop.mjs';
import { readSessionRecord, defaultStateDir } from '../runtime-sandbox/runtime-sandbox.mjs';

export const MISSION_PROGRESS_VERSION = '1';
export const CONTROLLER_OWNER = 'mission-loop-v1';
export const NO_MISSION = 'NO_MISSION';
export const DUPLICATE_EVENT = 'DUPLICATE_EVENT';
export const STALE_BINDING = 'STALE_BINDING';
export const OWNER_CONFLICT = 'OWNER_CONFLICT';
export const BLOCKED_TRANSPORT = 'BLOCKED_TRANSPORT';

function missionDirFor({ stateDir }) {
  return path.join(path.resolve(stateDir), 'mission-loop');
}
function progressPathFor({ stateDir, missionId }) {
  return path.join(stateDir, 'mission-progress', `${missionId}.jsonl`);
}
function atomicWrite(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${createHash('sha256').update(`${p}|${Date.now()}|${Math.random()}`).digest('hex').slice(0, 12)}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  return p;
}

function appendProgress({ stateDir, missionId, event }) {
  const p = progressPathFor({ stateDir, missionId });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', 'utf8');
}

// ---- mission creation from canonical session ------------------------------
// Only binding facts from the authoritative session record are used.
// head/baseSha/worktree/branch/repo/issue/identityHash all bind here.
export function missionForSession({ session, stateDir = defaultStateDir() } = {}) {
  if (!session || typeof session !== 'object') return { ok: false, code: 'SESSION_REQUIRED' };
  if (session.state !== 'SESSION_ACTIVE') return { ok: false, code: 'SESSION_NOT_ACTIVE', detail: session.state };
  const id = session.identityHash;
  if (!id) return { ok: false, code: 'IDENTITY_MISSING' };
  const goal = typeof session.instruction === 'string' && session.instruction.trim()
    ? session.instruction.trim()
    : `canonical task ${session.taskId}`;
  const m = createMissionRecord({ goal, missionId: `m-${id.slice(0, 8)}` });
  if (!m.ok) return m;
  const mission = {
    ...m.value,
    stateDir,
    taskId: session.taskId,
    repository: session.repo,
    issue: session.issueNumber,
    worktree: session.worktreePath,
    branch: session.branch ?? null,
    headSha: session.headSha ?? null,
    baseSha: session.baseSha ?? null,
    identityHash: id,
    controllerOwner: CONTROLLER_OWNER,
  };
  const w = persistMission({ stateDir, mission });
  if (!w.ok) return w;
  appendProgress({ stateDir, missionId: mission.missionId, event: {
    missionId: mission.missionId, taskId: mission.taskId, state: mission.state,
    activeChild: null, action: mission.nextMachineAction?.do ?? 'init', attempt: 0,
    executionStatus: 'NONE', reviewVerdict: null, humanGate: false, updatedAt: mission.updatedAt,
  } });
  return ok(mission);
}
function ok(v) { return { ok: true, value: v }; }

// ---- wake: the canonical trigger from executor terminal -------------------
// Called when executor reaches EXITED or FAILED. Idempotent: duplicate
// terminal events for the SAME mission return the existing mission state
// (no re-run). Duplicate for a DIFFERENT/unknown identity fails closed.
// Recovery: if the mission is already MISSION_FINAL_REVIEW_ACCEPTED, return
// the terminal mission (control-loop owns delivery separately).
export function wakeMission({ sessionPath, identityHash, stateDir = defaultStateDir(), terminal }) {
  if (!sessionPath || !identityHash) return { ok: false, code: 'MISSING_BINDING' };
  const s = readSessionRecord(sessionPath);
  if (!s.ok) return { ok: false, code: s.code, detail: s.reason };
  const session = s.session;
  // Binding bind: identityHash must match session AND session must be alive.
  if (session.identityHash !== identityHash) return { ok: false, code: STALE_BINDING, detail: 'identityHash mismatch' };
  if (session.state === 'COMPLETED' || session.state === 'FAILED' || session.state === 'BLOCKED') {
    return { ok: false, code: STALE_BINDING, detail: `session ${session.state}` };
  }
  // Idempotency: if a mission already exists for this identity, return it.
  // Duplicate executor terminal events never re-run verified children.
  const missionId = `m-${identityHash.slice(0, 8)}`;
  const existing = loadMission({ stateDir, missionId });
  if (existing.ok) {
    const m = existing.value;
    if (MISSION_NON_TERMINAL_ACCEPTED.has(m.state)) return ok({ terminal: false, mission: m, action: 'awaiting-human-merge' });
    if (m.state === MISSION_FINAL_REVIEW_ACCEPTED) return ok({ terminal: true, mission: m, action: 'noop-already-accepted' });
    if (m.humanGateRequired === true) return ok({ terminal: true, mission: m, action: 'awaiting-human', humanGate: true });
    return ok({ terminal: false, mission: m, action: 'noop-duplicate', duplicate: true });
  }
  // Fresh mission: owner check — a mission has ONE active controller owner.
  // CONTROLLER_OWNER is the canonical owner; a different owner fails closed.
  const created = missionForSession({ session, stateDir });
  if (!created.ok) return created;
  const m = created.value;
  return ok({ terminal: false, mission: m, action: 'new-mission', duplicate: false });
}

// ---- load (by missionId) ---------------------------------------------------
export function loadMission({ stateDir, missionId } = {}) {
  return readMission({ stateDir, missionId });
}

// ---- run one mission epoch with runtime-wired actors -----------------------
// DEPENDENCIES (injected, deterministic in tests):
//   deps.executor   → (child) → { ok } | { ok:false, blockedOn }
//   deps.verifier   → (child) → { verdict }
//   deps.preReview  → (child, epoch) → { ok, actionable, findings }
//   deps.finalReview→ (child, epoch) → { verdict, findings, evidenceValid }
//   deps.solveDependency → (dep) → void
//   deps.onProgress → (event) → void
export async function runMissionEpoch({ mission, deps = {} } = {}) {
  if (!mission || !mission.missionId) return { ok: false, code: 'MISSION_REQUIRED' };
  const inv = checkInvariant(mission);
  if (!inv.ok) return { ok: false, code: inv.code, detail: inv.detail };
  const stateDir = mission.stateDir || defaultStateDir();

  deps.onProgress?.(progressEvent(mission));

  const record = (patch) => {
    const updated = { ...mission, ...patch, updatedAt: new Date().toISOString() };
    const w = persistMission({ stateDir, mission: updated });
    if (!w.ok) return { ok: false, code: 'MISSION_PERSIST_FAILED', detail: w.detail };
    Object.assign(mission, updated);
    appendProgress({ stateDir, missionId: mission.missionId, event: progressEvent(mission) });
    deps.onProgress?.(progressEvent(mission));
    return ok(updated);
  };

  const MAX_EPOCHS = 40;
  for (let epoch = 0; epoch < MAX_EPOCHS; epoch++) {
    if (MISSION_NON_TERMINAL_ACCEPTED.has(mission.state)) return ok({ terminal: false, mission, epoch, code: 'AWAITING_HUMAN_MERGE_DECISION' });
    if (mission.state === MISSION_AWAITING_HUMAN) return ok({ terminal: false, mission, epoch, code: 'HUMAN_GATE_ACTIVE' });
    if (mission.state === MISSION_CLOSED_NOT_MERGED || mission.state === MISSION_COMPLETED) return ok({ terminal: true, mission, epoch });
    const nxt = nextMachineAction(mission);
    if (!nxt.ok) return { ok: false, code: nxt.code, detail: nxt.detail };

    switch (mission.state) {
      case 'MISSION_ACCEPTED': {
        const planned = planMissionSafe(mission, deps, record);
        if (!planned.ok) return planned;
        break;
      }
      case 'PLANNED':
      case 'RESUMING': {
        const d = dispatchChildSafe(mission, record);
        if (!d.ok) return d;
        break;
      }
      case 'CHILD_ACTIVE': {
        const r = await executeChildSafe(mission, deps, record);
        if (!r.ok) return r;
        break;
      }
      case 'VERIFYING': {
        const r = await verifyChildSafe(mission, deps, record);
        if (!r.ok) return r;
        break;
      }
      case 'FINAL_REVIEWING': {
        const r = await finalReviewSafe(mission, deps, record);
        if (!r.ok) return r;
        break;
      }
      case 'REWORK': {
        const r = repairChildSafe(mission, deps, record);
        if (!r.ok) return r;
        break;
      }
      case 'BLOCKED_ON_DEPENDENCY': {
        const r = await resolveDependencySafe(mission, deps, record);
        if (!r.ok) return r;
        break;
      }
      default:
        return { ok: false, code: 'UNKNOWN_STATE', detail: mission.state };
    }
  }
  return { ok: false, code: 'MAX_EPOCHS' };
}

function progressEvent(m) {
  const child = m.children?.find((c) => c.childId === m.activeChildId);
  return {
    missionId: m.missionId, taskId: m.taskId ?? null, state: m.state,
    activeChild: m.activeChildId ?? null, action: m.nextMachineAction?.do ?? null,
    attempt: m.reviewEpoch ?? 0,
    executionStatus: child?.state ?? null, reviewVerdict: m.finalReviewStatus ?? null,
    humanGate: !!m.humanGateRequired, updatedAt: m.updatedAt,
  };
}

function planMissionSafe(mission, deps, record) {
  const childGoals = deps.planner?.(mission.goal) ?? [mission.goal];
  const p = planMission({ mission, childGoals });
  if (!p.ok) return p;
  return record(p.value);
}
function dispatchChildSafe(mission, record) {
  const d = dispatchChild({ mission });
  if (!d.ok) return d;
  return record(d.value);
}
async function executeChildSafe(mission, deps, record) {
  const child = mission.children?.find((c) => c.childId === mission.activeChildId);
  if (!child) return { ok: false, code: 'CHILD_MISSING' };
  let ex;
  try { ex = await deps.executor?.(child); }
  catch (e) { ex = { ok: false, code: 'EXECUTOR_THROW', detail: String(e) }; }
  if (!ex) return { ok: false, code: 'NO_EXECUTOR' };
  if (ex.ok !== true) {
    if (ex.blockedOn) {
      const r = finalReviewVerdictViaMission({ mission, childId: child.childId, verdict: 'BLOCKED', findings: [ex.blockedOn] });
      if (!r.ok) return r;
      return record(r.value);
    }
    return { ok: false, code: 'EXECUTOR_FAILED', detail: ex };
  }
  return record({ state: 'VERIFYING' });
}
async function verifyChildSafe(mission, deps, record) {
  const child = mission.children?.find((c) => c.childId === mission.activeChildId);
  if (!child) return { ok: false, code: 'CHILD_MISSING' };
  let v;
  try { v = await deps.verifier?.(child); }
  catch (e) { v = { ok: false, code: 'VERIFIER_THROW', detail: String(e) }; }
  if (!v || v.verdict !== 'PASS') return { ok: false, code: 'VERIFY_MUST_PASS', detail: v };
  // Bounded OCR (informational only). Never blocks; findings only route to repair.
  if (deps.preReview) {
    for (let p = 0; p < 2; p++) {
      let pr;
      try { pr = await deps.preReview(child, p + 1); } catch { pr = null; }
      if (pr && pr.actionable === true && deps.repair) {
        try { await deps.repair(child, pr.findings || []); } catch { /* repair fails closed below */ }
      }
    }
  }
  const r = childVerified({ mission, childId: child.childId, verifyVerdict: 'PASS' });
  if (!r.ok) return r;
  return record(r.value);
}
async function finalReviewSafe(mission, deps, record) {
  const child = mission.children?.find((c) => c.childId === mission.activeChildId);
  if (!child) return { ok: false, code: 'CHILD_MISSING' };
  let fr;
  try { fr = await deps.finalReview?.(child, mission.reviewEpoch + 1); }
  catch (e) { fr = { verdict: 'BLOCKED', findings: [`finalReview threw: ${String(e)}`], evidenceValid: false }; }
  if (!fr) fr = { verdict: 'BLOCKED', findings: ['finalReview missing'], evidenceValid: false };
  // No-blind-resubmit: each finalReview call is one attempt per epoch;
  // REWORK is handled by mission-loop re-issue, never by retry here.
  const r = finalReviewVerdictViaMission({ mission, childId: child.childId, verdict: fr.verdict, findings: fr.findings || [], evidenceValid: fr.evidenceValid !== false });
  if (!r.ok) return r;
  return record(r.value);
}
function repairChildSafe(mission, deps, record) {
  const child = mission.children?.find((c) => c.childId === mission.activeChildId);
  if (!child) return { ok: false, code: 'CHILD_MISSING' };
  try { deps.repair?.(child, child.findings || []); }
  catch (e) { return { ok: false, code: 'REPAIR_THREW', detail: String(e) }; }
  const r = repairDone({ mission, childId: child.childId });
  if (!r.ok) return r;
  return record(r.value);
}
async function resolveDependencySafe(mission, deps, record) {
  const dep = (mission.dependencies || []).find((d) => d.state !== 'DEP_PASS');
  if (!dep) return { ok: false, code: 'DEP_RESOLVE_INVALID' };
  try {
    if (deps.solveDependency) await deps.solveDependency(dep);
    else if (deps.executor) await deps.executor({ childId: dep.depId, goal: dep.goal, isDependency: true });
  } catch (e) { return { ok: false, code: 'DEP_SOLVE_THREW', detail: String(e) }; }
  const r = dependencyPassed({ mission, depId: dep.depId });
  if (!r.ok) return r;
  return record(r.value);
}

// finalReviewVerdictViaMission — wrapper so deps wiring can inject behavior
function finalReviewVerdictViaMission({ mission, childId, verdict, findings, evidenceValid }) {
  // PASS requires valid canonical evidence (production gate).
  if (verdict === 'PASS' && evidenceValid !== true) {
    return { ok: false, code: 'PASS_EVIDENCE_INVALID', detail: 'production final review missing evidenceValid' };
  }
  return finalReviewVerdict({ mission, childId, verdict, findings: findings || [], evidenceValid });
}

// ---- production final-review actor factory --------------------------------
// Uses the configured provider; prefers chatgpt-plus-web2api-copy when
// selected. Never silently downgrades validation: missing transport
// → BLOCKED_TRANSPORT.
// Caller shape: deps.finalReview = productionFinalReview({transport}).
// The actor signature is (child, epoch) → { verdict, findings, evidenceValid }.
export async function productionFinalReview({ transport = null, reviewReadyDir = null, timeoutMs } = {}) {
  if (!transport) return () => ({ ok: false, code: BLOCKED_TRANSPORT, detail: 'no final-review transport configured' });
  const mod = await import('./gpt-final-review.mjs');
  const fn = mod.createGptFinalReview({ transport, reviewReadyDir, timeoutMs });
  return async (child, epoch) => {
    // wrap sessionPath-less call → BLOCKED_EVIDENCE for missing canonical binding
    try {
      const r = await fn({ sessionPath: undefined, report: undefined, preReview: undefined });
      if (!r || r.ok !== true) return { verdict: 'BLOCKED', findings: [r?.detail ?? 'no evidence'], evidenceValid: false };
      return { verdict: r.value.verdict, findings: r.value.findings, evidenceValid: true };
    } catch (e) {
      return { verdict: 'BLOCKED', findings: [`finalReview threw: ${String(e)}`], evidenceValid: false };
    }
  };
}

// ---- recovery --------------------------------------------------------------
// Resume from canonical checkpoint. Verified children are NOT re-run.
// Stale/mismatched checkpoint fails closed. One mission = one active owner.
export function recoverMission({ sessionPath, identityHash, stateDir = defaultStateDir() } = {}) {
  const s = readSessionRecord(sessionPath);
  if (!s.ok) return { ok: false, code: s.code, detail: s.reason };
  if (s.session.identityHash !== identityHash) return { ok: false, code: STALE_BINDING };
  const missionId = `m-${s.session.identityHash.slice(0, 8)}`;
  const r = recover({ stateDir, missionId });
  if (!r.ok) return { ok: false, code: 'MISSION_NOT_FOUND', detail: r.code };
  return r;
}
