// packages/control-loop/task-status.mjs — LOOP-01 per-task status board.
//
// WHAT THIS IS: a READ-ONLY projection that turns the records the ControlLoop
// already persists into ONE table per task:
//
//   taskId/identity · checkpoint · currentStep · owner/runner liveness ·
//   candidate binding per step · evidence/result · missingRequired ·
//   nextAction + reason · checklist (REQUIRED / CONDITIONAL / OPTIONAL)
//
// WHAT THIS IS NOT (hard invariants, enforced by tests):
//   - it NEVER writes: no session, no ledger, no ExecutionRecord, no delivery
//     ledger, no rework record. It only reads what the canonical producers
//     already wrote (no producer is asked to rewrite a record for us);
//   - it NEVER derives authority or a lifecycle state. The session record is
//     the canonical FSM truth and the transition ledger is the audit trail;
//     this board only projects them and says what a caller should DO next;
//   - it NEVER terminalizes, NEVER marks a review PASS, NEVER merges, and
//     never recommends spawning a second owner/executor;
//   - output carries no lease token, no absolute path and no secret (this
//     board is rendered on the client-facing soc.get_progress surface).
//
// STEP MODEL — derived from the real production call-chain (control-loop.mjs):
//
//   route -> execute -> publish(push+PR bind) -> verify(internal review FIRST,
//   then the deterministic required gate) -> preReview -> finalReview ->
//   decide -> {REWORK leg | DELIVERING -> human gate | BLOCKED}
//
// PUBLISH precedes VERIFY on purpose: pre-gate-review's deriveReviewCandidate
// fails with INTERNAL_REVIEW_PR_UNBOUND until session.prNumber is bound, so an
// internal review cannot exist before the publish chain ran.
//
// A step is marked DONE only when every REQUIRED field of that step is present
// AND its result is machine-valid. Anything else is PENDING (still due, runner
// alive), MISSING (past-due gap -> missingRequired), NOT_DUE or NOT_APPLICABLE.

import fs from 'node:fs';
import path from 'node:path';

import {
  readSessionRecord,
  sessionPathFor,
  HUMAN_GATE_STATES,
} from '../runtime-sandbox/runtime-sandbox.mjs';
import { readExecutionRecord } from '../executor-launcher/executor-launcher.mjs';
import { reconcileExecutorLiveness } from '../executor-launcher/executor-reconcile.mjs';
import { readProgressRecord } from '../task-progress/task-progress.mjs';
import { readTransitions, MAX_REWORK_ROUNDS } from './control-loop.mjs';
import { readDeliveryLedger } from './delivery.mjs';
import { buildReviewReadyFilename } from '../review-ready/review-ready.mjs';

export const TASK_STATUS_SCHEMA_VERSION = '1';

// Canonical step order of the production chain (index = position).
export const TASK_STEPS = Object.freeze([
  'ADMISSION', 'ROUTE', 'EXECUTE', 'PUBLISH', 'VERIFY',
  'PRE_REVIEW', 'FINAL_REVIEW', 'DECIDE', 'DELIVER',
]);

export const CHECKLIST_KINDS = Object.freeze(['REQUIRED', 'CONDITIONAL', 'OPTIONAL']);

// DONE          required/conditional field present with a valid result
// PENDING       the step is the current checkpoint and the runner is still due
// MISSING       past-due required/conditional field absent -> missingRequired
// NOT_DUE       the step has not been reached yet (never a gap)
// NOT_APPLICABLE conditional whose `when` is false (counts as satisfied)
// ABSENT        OPTIONAL field simply not present (never blocks anything)
export const ITEM_STATUSES = Object.freeze([
  'DONE', 'PENDING', 'MISSING', 'NOT_DUE', 'NOT_APPLICABLE', 'ABSENT',
]);

export const STEP_STATUSES = Object.freeze([
  'DONE', 'IN_FLIGHT', 'NOT_DUE', 'GAP', 'NOT_APPLICABLE', 'BLOCKED',
]);

// Runner/owner categories. UNPROVEN is deliberately distinct from DEAD: an
// unproven liveness must be reconciled before anything is resumed, a proven
// dead runner at EXECUTE must go through the canonical reaper, and neither
// may ever be answered by minting a second executor.
export const OWNER_CATEGORIES = Object.freeze([
  'ALIVE', 'DEAD', 'UNPROVEN', 'RUNNER_FINISHED', 'NO_RUNNER', 'NO_TASK',
]);

export const NEXT_ACTIONS = Object.freeze([
  'READ_BACK_SESSION',            // no canonical session at the expected path
  'NONE_TERMINAL',                // session already terminal (COMPLETED/FAILED)
  'INSPECT_BLOCKED_EVIDENCE',     // terminal BLOCKED: read the evidence, never re-block blindly
  'AWAIT_HUMAN_GATE',             // stopped at the Human Gate on purpose
  'CONTINUE_LOOP_NOT_BOUND',      // session alive, loop ledger not bound yet
  'RECONCILE_LIVENESS',           // owner/runner liveness UNKNOWN -> observe/reconcile first
  'ATTACH_OBSERVE',               // a live runner owns the task: attach, never spawn a second
  'RECONCILE_EXISTING_ATTEMPT',   // an attempt/runner already exists: reconcile, no duplicate dispatch
  'REAP_DEAD_RUNNER',             // proven-dead runner mid-EXECUTE: use the canonical reaper seam
  'RECONCILE_BEFORE_RESUBMIT',    // UNKNOWN/IN_FLIGHT/POST_SUBMIT side effect: typed refusal, no blind retry
  'BLOCKED_BUDGET_EXHAUSTED',     // rework rounds exhausted
  'REVIEW_CANDIDATE_AGAIN',       // candidate drift/stale evidence: re-review before any gate
  'READ_BACK_BLOCKED_TAIL',       // recoverable BLOCKED side-transition: read the tail, re-enter the loop
  'FILL_MISSING_REQUIRED',        // required checklist fields missing for a past-due step
  'CONTINUE',                     // nothing blocking: continue from the checkpoint
]);

const SHA40 = /^[0-9a-f]{40}$/i;
// Canonical task identity shape: hex digest (identityHash({repo, issueNumber})).
const HEX_DIGEST = /^[0-9a-f]+$/i;
const VALID_VERDICTS = Object.freeze(['PASS', 'REWORK', 'BLOCKED']);
// A PROVEN pre-submit observation (nothing ever hit the submit pipeline) may
// fall back to the ordinary blocked-tail read-back; every other or absent
// stage must be reconciled first and is NEVER answered by a blind re-submit.
// TARGET_SETUP / PRE_SUBMIT_SNAPSHOT are the canonical transport stages whose
// submitState is NOT_SUBMITTED (boundary-observation STAGE_OBSERVATION_STAGE_MAP);
// the remaining labels are accepted legacy/fixture vocabulary for the same
// proven-absent claim.
const SUBMIT_SAFE_STAGES = Object.freeze([
  'TARGET_SETUP', 'PRE_SUBMIT_SNAPSHOT',
  'NOT_SUBMITTED', 'PRE_SUBMITTED', 'PRE_SUBMIT',
]);

function safe(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

function lower(v) { return typeof v === 'string' ? v.toLowerCase() : null; }

// ---------------------------------------------------------------------------
// Checklist policy. Every entry is { step, kind, item, when?, why } where
// `when` (CONDITIONAL only) decides whether the item is required *right now*.
// Evaluation is generic: `satisfied(ctx)` -> { ok, result? }.
// ---------------------------------------------------------------------------
const is40 = (v) => typeof v === 'string' && SHA40.test(v);

const CHECKLIST = [
  // ---- ADMISSION --------------------------------------------------------
  { step: 'ADMISSION', kind: 'REQUIRED', item: 'session.record', why: 'canonical session record at the expected control-plane path',
    satisfied: (c) => ({ ok: c.sessionOk === true }) },
  { step: 'ADMISSION', kind: 'REQUIRED', item: 'session.identity', why: 'taskId + repo + issueNumber bound (identityHash, when recorded, must equal the requested identity)',
    satisfied: (c) => ({
      ok: Boolean(c.session && c.session.taskId && c.session.repo && Number(c.session.issueNumber) > 0
        && (!c.session.identityHash || c.session.identityHash === c.id)),
      result: c.session ? (c.session.taskId ?? null) : null,
    }) },
  { step: 'ADMISSION', kind: 'CONDITIONAL', item: 'admission.owner', why: 'a mutation owner must be recorded once a control lane owns the task',
    when: (c) => Boolean(c.session && c.session.mutationOwner && typeof c.session.mutationOwner === 'object'),
    satisfied: (c) => ({ ok: Boolean(c.session && c.session.mutationOwner && c.session.mutationOwner.laneId) }) },
  { step: 'ADMISSION', kind: 'OPTIONAL', item: 'progress.telemetry', why: 'executor progress projection (subordinate telemetry)',
    satisfied: (c) => ({ ok: Boolean(c.progress) }) },

  // ---- ROUTE ------------------------------------------------------------
  { step: 'ROUTE', kind: 'REQUIRED', item: 'ledger.accepted_to_routed', why: 'loop bound: ACCEPTED->ROUTED in the transition ledger',
    satisfied: (c) => ({ ok: c.hasTransition('ACCEPTED', 'ROUTED'), result: c.evidence('ACCEPTED', 'ROUTED') }) },
  { step: 'ROUTE', kind: 'REQUIRED', item: 'session.branch', why: 'task branch pinned for the publish chain',
    satisfied: (c) => ({ ok: Boolean(c.session && typeof c.session.branch === 'string' && c.session.branch) }) },
  { step: 'ROUTE', kind: 'CONDITIONAL', item: 'route.dispatch', why: 'route evidence must record which executor/model was dispatched',
    when: (c) => c.hasTransition('ROUTED', 'EXECUTING'),
    satisfied: (c) => { const e = c.evidence('ROUTED', 'EXECUTING'); return { ok: Boolean(e && e.executorKind) }; } },
  { step: 'ROUTE', kind: 'OPTIONAL', item: 'route.model', why: 'model candidate recorded by the router',
    satisfied: (c) => { const e = c.evidence('ROUTED', 'EXECUTING'); return { ok: Boolean(e && e.model) }; } },

  // ---- EXECUTE ----------------------------------------------------------
  { step: 'EXECUTE', kind: 'REQUIRED', item: 'ledger.routed_to_executing', why: 'route completed: ROUTED->EXECUTING',
    satisfied: (c) => ({ ok: c.hasTransition('ROUTED', 'EXECUTING'), result: c.evidence('ROUTED', 'EXECUTING') }) },
  { step: 'EXECUTE', kind: 'REQUIRED', item: 'execution.record', why: 'canonical ExecutionRecord bound to this identity',
    satisfied: (c) => ({ ok: Boolean(c.execution && c.execution.identityProven !== false && typeof c.execution.identityHash === 'string' && HEX_DIGEST.test(c.execution.identityHash) && c.execution.identityHash === c.id) }) },
  { step: 'EXECUTE', kind: 'REQUIRED', item: 'execution.result', why: 'machine-valid result: EXITED/exitCode 0 bound to this identity',
    satisfied: (c) => ({ ok: c.executionResultValid === true }) },
  { step: 'EXECUTE', kind: 'REQUIRED', item: 'ledger.executing_to_verifying', why: 'execute completed: EXECUTING->VERIFYING with execution evidence',
    satisfied: (c) => ({ ok: c.hasTransition('EXECUTING', 'VERIFYING'), result: c.evidence('EXECUTING', 'VERIFYING') }) },
  { step: 'EXECUTE', kind: 'CONDITIONAL', item: 'execution.instructionDigest', why: 'a dispatched executor must record the instruction digest it ran',
    when: (c) => Boolean(c.execution),
    satisfied: (c) => ({ ok: Boolean(c.execution && c.execution.instructionDigest) }) },
  { step: 'EXECUTE', kind: 'OPTIONAL', item: 'execution.activity', why: 'executor activity stream (display only)',
    satisfied: (c) => ({ ok: Boolean(c.execution && (c.execution.finishedAt || c.execution.startedAt)) }) },

  // ---- PUBLISH (push + PR bind; runs BEFORE the internal review) --------
  { step: 'PUBLISH', kind: 'REQUIRED', item: 'publish.headSha', why: 'candidate head pinned on the session (binding source for every review)',
    satisfied: (c) => ({ ok: is40(c.session && c.session.headSha), result: (c.session && c.session.headSha) || null }) },
  { step: 'PUBLISH', kind: 'CONDITIONAL', item: 'publish.prNumber', why: 'the review candidate requires a bound PR (INTERNAL_REVIEW_PR_UNBOUND otherwise)',
    when: (c) => c.publishApplicable === true,
    satisfied: (c) => ({ ok: Number.isInteger(c.session && c.session.prNumber) && c.session.prNumber > 0, result: (c.session && c.session.prNumber) || null }) },
  { step: 'PUBLISH', kind: 'OPTIONAL', item: 'publish.reviewPacket', why: 'canonical review-ready packet projected for reviewers',
    satisfied: (c) => ({ ok: c.reviewPacket === true }) },

  // ---- VERIFY (internal review FIRST, then the required gate) ----------
  { step: 'VERIFY', kind: 'REQUIRED', item: 'ledger.executing_to_verifying', why: 'execute evidence must exist before the internal review may run',
    satisfied: (c) => ({ ok: c.hasTransition('EXECUTING', 'VERIFYING'), result: c.evidence('EXECUTING', 'VERIFYING') }) },
  { step: 'VERIFY', kind: 'REQUIRED', item: 'verify.result', why: 'verifier value persisted on VERIFYING->PRE_REVIEWING with a valid verdict',
    satisfied: (c) => { const e = c.evidence('VERIFYING', 'PRE_REVIEWING'); return { ok: Boolean(e && VALID_VERDICTS.includes(e.verdict)), result: e ? (e.verdict ?? null) : null }; } },
  { step: 'VERIFY', kind: 'CONDITIONAL', item: 'verify.boundary', why: 'a reconciled pre-submit boundary must stay bound to its checkpoint',
    when: (c) => c.submitBoundary !== null,
    satisfied: (c) => ({ ok: Boolean(c.submitBoundary && c.submitBoundary.reason && c.submitBoundary.checkpointTs) }) },
  { step: 'VERIFY', kind: 'OPTIONAL', item: 'verify.report', why: 'human-readable gate report',
    satisfied: (c) => { const e = c.evidence('VERIFYING', 'PRE_REVIEWING'); return { ok: Boolean(e && (e.report || e.evidence)) }; } },

  // ---- PRE_REVIEW -------------------------------------------------------
  { step: 'PRE_REVIEW', kind: 'REQUIRED', item: 'ledger.verifying_to_pre_reviewing', why: 'internal review + gate completed: VERIFYING->PRE_REVIEWING',
    satisfied: (c) => ({ ok: c.hasTransition('VERIFYING', 'PRE_REVIEWING'), result: c.evidence('VERIFYING', 'PRE_REVIEWING') }) },
  { step: 'PRE_REVIEW', kind: 'CONDITIONAL', item: 'pre_review.findings', why: 'when the pre-review returns findings they must travel with the verdict',
    when: (c) => { const e = c.evidence('VERIFYING', 'PRE_REVIEWING'); return Boolean(e && Object.prototype.hasOwnProperty.call(e, 'findings')); },
    satisfied: (c) => { const e = c.evidence('VERIFYING', 'PRE_REVIEWING'); return { ok: Array.isArray(e && e.findings) }; } },
  { step: 'PRE_REVIEW', kind: 'OPTIONAL', item: 'pre_review.confidence', why: 'reviewer confidence/metadata (display only)',
    satisfied: (c) => { const e = c.evidence('PRE_REVIEWING', 'FINAL_REVIEWING'); return { ok: Boolean(e && ((e.confidence !== null && e.confidence !== undefined) || e.metadata)) }; } },

  // ---- FINAL_REVIEW (independent reviewer) ------------------------------
  { step: 'FINAL_REVIEW', kind: 'REQUIRED', item: 'ledger.pre_reviewing_to_final_reviewing', why: 'pre-review completed: PRE_REVIEWING->FINAL_REVIEWING',
    satisfied: (c) => ({ ok: c.hasTransition('PRE_REVIEWING', 'FINAL_REVIEWING'), result: c.evidence('PRE_REVIEWING', 'FINAL_REVIEWING') }) },
  { step: 'FINAL_REVIEW', kind: 'REQUIRED', item: 'ledger.final_reviewing_to_deciding', why: 'independent verdict consumed: FINAL_REVIEWING->DECIDING',
    satisfied: (c) => ({ ok: c.hasTransition('FINAL_REVIEWING', 'DECIDING'), result: c.evidence('FINAL_REVIEWING', 'DECIDING') }) },
  { step: 'FINAL_REVIEW', kind: 'REQUIRED', item: 'decision.verdict', why: 'a valid PASS/REWORK/BLOCKED verdict persisted on the DECIDING boundary',
    satisfied: (c) => { const e = c.evidence('FINAL_REVIEWING', 'DECIDING'); return { ok: Boolean(e && VALID_VERDICTS.includes(e.verdict)), result: e ? (e.verdict ?? null) : null }; } },
  { step: 'FINAL_REVIEW', kind: 'CONDITIONAL', item: 'decision.binding', why: 'a REWORK verdict must echo repository/issue/headSha of the reviewed candidate',
    when: (c) => { const e = c.evidence('FINAL_REVIEWING', 'DECIDING'); return Boolean(e && e.verdict === 'REWORK'); },
    satisfied: (c) => { const b = (c.evidence('FINAL_REVIEWING', 'DECIDING') || {}).binding; return { ok: Boolean(b && b.repository && Number(b.issue) > 0 && is40(b.headSha)), result: b && is40(b.headSha) ? b.headSha : null }; } },
  { step: 'FINAL_REVIEW', kind: 'CONDITIONAL', item: 'decision.provenance', why: 'a transport-sourced verdict must carry review provenance',
    when: (c) => { const e = c.evidence('FINAL_REVIEWING', 'DECIDING'); return Boolean(e && typeof e.rawText === 'string') || Boolean(e && e.provenance); },
    satisfied: (c) => { const e = c.evidence('FINAL_REVIEWING', 'DECIDING') || {}; return { ok: Boolean(e.provenance && e.provenance.source) }; } },
  { step: 'FINAL_REVIEW', kind: 'OPTIONAL', item: 'decision.confidence', why: 'reviewer confidence/metadata (display only)',
    satisfied: (c) => { const e = c.evidence('FINAL_REVIEWING', 'DECIDING') || {}; return { ok: Boolean((e.confidence !== null && e.confidence !== undefined) || e.metadata) }; } },

  // ---- DECIDE -----------------------------------------------------------
  { step: 'DECIDE', kind: 'REQUIRED', item: 'ledger.deciding_outcome', why: 'the decision produced a boundary: REWORK / DELIVERING / BLOCKED',
    satisfied: (c) => ({ ok: c.decideOutcome !== null, result: c.decideOutcome }) },
  { step: 'DECIDE', kind: 'CONDITIONAL', item: 'rework.record', why: 'every REWORK round must persist its findings + binding digest',
    when: (c) => c.decideOutcome === 'REWORK' || (c.rounds ?? 0) > 0,
    satisfied: (c) => ({ ok: c.reworkRecords.length > 0, result: c.reworkRecords.length }) },
  { step: 'DECIDE', kind: 'CONDITIONAL', item: 'decision.findings', why: 'a REWORK outcome must carry the findings handed back to the executor',
    when: (c) => c.decideOutcome === 'REWORK',
    satisfied: (c) => { const list = c.reworkRecords; return { ok: list.length > 0 && Array.isArray(list[list.length - 1].findings) && list[list.length - 1].findings.length > 0 }; } },
  { step: 'DECIDE', kind: 'OPTIONAL', item: 'rework.advisorGuidance', why: 'advisor guidance recorded with the round (optional)',

    satisfied: (c) => ({ ok: c.reworkRecords.some((r) => Boolean(r.advisorGuidance)) }) },

  // ---- DELIVER (stops at the Human Gate by default) ---------------------
  { step: 'DELIVER', kind: 'REQUIRED', item: 'ledger.delivering_to_completed', why: 'canonical delivery finished: DELIVERING->COMPLETED',
    whenTerminal: true,
    satisfied: (c) => ({ ok: c.hasTransition('DELIVERING', 'COMPLETED'), result: c.evidence('DELIVERING', 'COMPLETED') }) },
  { step: 'DELIVER', kind: 'CONDITIONAL', item: 'human_gate.s5_ready', why: 'S5 must report READY_FOR_HUMAN_GATE before S6 may approve',
    when: (c) => c.humanGateArmed === true,
    satisfied: (c) => ({ ok: Boolean(c.session && c.session.controlLoop && c.session.controlLoop.s5Dispatcher && c.session.controlLoop.s5Dispatcher.terminalStatus === 'READY_FOR_HUMAN_GATE') }) },
  { step: 'DELIVER', kind: 'CONDITIONAL', item: 'human_gate.s6_decision', why: 'an S6 approve must record its own decision block before merge authorization',
    when: (c) => Boolean(c.session && c.session.controlLoop && c.session.controlLoop.s6HumanGate),
    satisfied: (c) => ({ ok: Boolean(c.session && c.session.controlLoop && c.session.controlLoop.s6HumanGate && c.session.controlLoop.s6HumanGate.decision) }) },
  { step: 'DELIVER', kind: 'OPTIONAL', item: 'delivery.ledger', why: 'crash-safe delivery ledger (adopted side effects)',
    satisfied: (c) => ({ ok: Boolean(c.delivery) }) },
];

// ---------------------------------------------------------------------------
// Record readers (all read-only; every failure degrades to "absent", never to
// a throw — a projection must not break the surface that renders it).
// ---------------------------------------------------------------------------
function readSubmitBoundary({ stateDir, id }) {
  const dir = path.join(path.resolve(String(stateDir)), 'control-loop', String(id), 'pre-submit-boundary');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return null; }
  if (names.length === 0) return null;
  let newest = null;
  for (const n of names) {
    const rec = safe(() => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')), null);
    if (!rec || typeof rec !== 'object') continue;
    const at = (rec.checkpoint && rec.checkpoint.ts) || rec.reconciledAt || '';
    if (!newest || at >= newest.at) {
      // Production records bind the proven transport observation at
      // record.boundary.observation (control-loop recordPreSubmitBoundaryReconciled);
      // reading a top-level observation alone makes every production stage come
      // back null (permanent unknown + SUBMIT_STAGE_UNKNOWN). Top-level
      // observation/record.stage stays tolerated for adopted/legacy records.
      const obs = (rec.boundary && rec.boundary.observation) || rec.observation || null;
      newest = {
        at,
        reason: (rec.checkpoint && rec.checkpoint.reason) || null,
        checkpointTs: (rec.checkpoint && rec.checkpoint.ts) || null,
        stage: (obs && obs.stage) || rec.stage || null,
        reconciled: rec.kind === 'PRE_SUBMIT_BOUNDARY_RECONCILED',
      };
    }
  }
  return newest;
}

function readReworkRecords({ stateDir, id }) {
  const dir = path.join(path.resolve(String(stateDir)), 'control-loop', String(id), 'rework');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const rec = safe(() => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')), null);
    if (rec && typeof rec === 'object') out.push(rec);
  }
  return out.sort((a, b) => (Number(a.round) || 0) - (Number(b.round) || 0));
}

function readReviewPacket({ stateDir, session }) {
  // The canonical packet name is <repo-slug>_Issue-<n>_PR-<p>_<head7>_review-ready.md
  // (review-ready buildReviewReadyFilename): it never contains the identityHash,
  // so identity-based matching would report ABSENT forever. Match the EXACT
  // filename of THIS candidate (repo + issue + pr + current head) — a packet of
  // another head/PR is not this candidate's packet (drift is surfaced separately).
  const name = buildReviewReadyFilename({
    repo: session && session.repo,
    issue: session && session.issueNumber,
    pr: session && session.prNumber,
    headSha: session && session.headSha ? String(session.headSha).toLowerCase() : null,
  });
  if (!name) return false;
  const dir = path.join(path.resolve(String(stateDir)), 'review-ready');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return false; }
  return names.includes(name);
}

// ---------------------------------------------------------------------------
// Checkpoint derivation: ledger tail -> step model.
// ---------------------------------------------------------------------------
const STEP_OF_STATE = Object.freeze({
  ACCEPTED: 'ADMISSION',
  ROUTED: 'ROUTE',
  EXECUTING: 'EXECUTE',
  VERIFYING: 'PUBLISH',
  PRE_REVIEWING: 'PRE_REVIEW',
  FINAL_REVIEWING: 'FINAL_REVIEW',
  DECIDING: 'DECIDE',
  REWORK: 'EXECUTE',
  DELIVERING: 'DELIVER',
  COMPLETED: null,
  BLOCKED: null,
});

// `loop.step({name})` side-transitions read `<name>:FAIL` / `<name>:THREW`.
const STEP_OF_STEP_NAME = Object.freeze({
  route: 'ROUTE', execute: 'EXECUTE', verify: 'VERIFY',
  preReview: 'PRE_REVIEW', finalReview: 'FINAL_REVIEW',
});

function deriveCheckpoint({ transitions }) {
  const tail = transitions.length ? transitions[transitions.length - 1] : null;
  if (!tail) {
    return {
      state: 'ACCEPTED', step: 'ADMISSION', index: 0, known: true, reason: 'NO_LEDGER',
      ts: null, ledgerLength: 0, blocked: false, round: 0,
    };
  }
  const state = tail.to;
  const round = transitions.filter((t) => t.to === 'REWORK').length;
  const blocked = state === 'BLOCKED';
  let step;
  if (blocked) {
    const m = /^(route|execute|verify|preReview|finalReview):/.exec(String(tail.reason || ''));
    step = (m && STEP_OF_STEP_NAME[m[1]]) || STEP_OF_STATE[String(tail.from)] || 'DECIDE';
  } else {
    // VERIFYING maps to PUBLISH in STEP_OF_STATE regardless of prNumber binding
    // (an earlier `publishDone !== true` special case was redundant: both
    // branches yielded PUBLISH — M9 pins this with prNumber bound).
    step = STEP_OF_STATE[state] ?? 'DECIDE';
  }
  const index = TASK_STEPS.indexOf(step);
  return {
    state,
    step,
    index: index < 0 ? 0 : index,
    known: step !== null,
    reason: tail.reason ?? null,
    ts: tail.ts ?? null,
    ledgerLength: transitions.length,
    blocked,
    round,
    blockedReason: blocked ? (tail.reason ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// Owner / runner liveness.
// ---------------------------------------------------------------------------
function deriveOwner({ execution, session, inFlightStep }) {
  if (!session) return { category: 'NO_TASK', liveness: null, identityProven: false, pid: null };
  if (!execution) {
    return {
      category: 'NO_RUNNER', liveness: 'NO_RECORD', identityProven: false,
      pid: null, runner: null, terminal: false,
    };
  }
  const liveness = execution.liveness ?? null;
  const identityProven = execution.identityProven === true;
  const base = {
    liveness, identityProven,
    pid: Number.isInteger(execution.pid) ? execution.pid : null,
    runner: execution.executor ?? null,
    terminal: Boolean(execution.terminalStatus),
  };
  if (execution.terminalStatus) return { ...base, category: 'RUNNER_FINISHED' };
  if (liveness === 'RUNNING' || liveness === 'STARTING') {
    return { ...base, category: identityProven ? 'ALIVE' : 'UNPROVEN' };
  }
  if (liveness === 'OWNERSHIP_UNKNOWN' || liveness === 'PID_REUSED' || liveness === 'STALE_CHILD') {
    return { ...base, category: 'UNPROVEN' };
  }
  if (liveness === 'EXITED' || liveness === 'FAILED' || liveness === 'STOPPED' || liveness === 'INTERRUPTED') {
    // A proven-gone runner while the loop still expects execution is the reaper
    // case; anywhere else it is simply a finished runner the loop can read back.
    return { ...base, category: inFlightStep === 'EXECUTE' ? 'DEAD' : 'RUNNER_FINISHED' };
  }
  return { ...base, category: 'UNPROVEN' };
}

// ---------------------------------------------------------------------------
// Candidate binding + drift.
// ---------------------------------------------------------------------------
function deriveCandidate({ session, transitions, reworkRecords, delivery }) {
  const bindings = [];
  const push = (step, source, binding) => { if (binding) bindings.push({ step, source, binding }); };

  const routeEv = lastEvidence(transitions, 'ROUTED', 'EXECUTING');
  if (routeEv) push('ROUTE', 'ledger:ROUTED->EXECUTING', { executorKind: projectEvidence(routeEv.executorKind ?? null), model: projectEvidence(routeEv.model ?? null) });
  const execEv = lastEvidence(transitions, 'EXECUTING', 'VERIFYING');
  if (execEv) push('EXECUTE', 'ledger:EXECUTING->VERIFYING', { executionStatus: projectEvidence(execEv.executionStatus ?? null), terminalStatus: projectEvidence(execEv.terminalStatus ?? null) });
  const verEv = lastEvidence(transitions, 'VERIFYING', 'PRE_REVIEWING');
  if (verEv) push('VERIFY', 'ledger:VERIFYING->PRE_REVIEWING', { verdict: projectEvidence(verEv.verdict ?? null) });
  const preEv = lastEvidence(transitions, 'PRE_REVIEWING', 'FINAL_REVIEWING');
  if (preEv) push('PRE_REVIEW', 'ledger:PRE_REVIEWING->FINAL_REVIEWING', { verdict: projectEvidence(preEv.verdict ?? null), findingsCount: Array.isArray(preEv.findings) ? preEv.findings.length : null });
  const finEv = lastEvidence(transitions, 'FINAL_REVIEWING', 'DECIDING');
  if (finEv) {
    const b = finEv.binding || null;
    push('FINAL_REVIEW', 'ledger:FINAL_REVIEWING->DECIDING', {
      verdict: projectEvidence(finEv.verdict ?? null),
      repository: b ? (b.repository ?? null) : null,
      issue: b ? (b.issue ?? null) : null,
      headSha: b ? (b.headSha ?? null) : null,
      findingsCount: Array.isArray(finEv.findings) ? finEv.findings.length : null,
    });
  }
  for (const r of reworkRecords) {
    push('DECIDE', `rework:${r.digest || r.round}`, {
      round: r.round ?? null,
      repository: r.binding ? (r.binding.repository ?? null) : null,
      issue: r.binding ? (r.binding.issue ?? null) : null,
      headSha: r.binding ? (r.binding.headSha ?? null) : null,
      findingsCount: Array.isArray(r.findings) ? r.findings.length : null,
    });
  }
  if (delivery && delivery.spec) {
    push('DELIVER', 'delivery-ledger', {
      headSha: delivery.spec.headSha ?? null,
      merged: Boolean(delivery.merged),
      closed: Boolean(delivery.closed),
    });
  }

  const sessionHead = is40(session && session.headSha) ? lower(session.headSha) : null;
  // Canonical binding order: an edge of the CURRENT cycle outranks any
  // historical rework record (a rework round burned at head A must never make
  // a newer PASS review of head B look like drift).
  const withHead = bindings.filter((b) => is40(b.binding.headSha));
  const stepRank = (b) => { const i = TASK_STEPS.indexOf(b.step); return i < 0 ? 99 : i; };
  const roundRank = (b) => Number(b.binding.round ?? 0);
  const newest = (list, rank) => list.slice().sort((a, b) => rank(b) - rank(a));
  const edges = withHead.filter((b) => b.step !== 'DECIDE');
  const reworks = withHead.filter((b) => b.step === 'DECIDE');
  let bound = null;
  if (sessionHead) {
    // (1) a binding that MATCHES the candidate head is the current binding;
    //     prefer the newest cycle's edge, then the newest matching rework record.
    bound = newest(edges.filter((b) => lower(b.binding.headSha) === sessionHead), stepRank)[0]
      || newest(reworks.filter((b) => lower(b.binding.headSha) === sessionHead), roundRank)[0]
      || null;
  }
  // (2) no head ever matched the candidate: fall back to the newest cycle's
  //     edge binding, else the most recent rework record (history is all we have).
  if (!bound) {
    bound = newest(edges, stepRank)[0] || newest(reworks, roundRank)[0] || null;
  }
  const boundHead = bound ? lower(bound.binding.headSha) : null;
  const drifted = Boolean(sessionHead && boundHead && sessionHead !== boundHead);
  return {
    headSha: sessionHead,
    baseSha: is40(session && session.baseSha) ? lower(session.baseSha) : null,
    branch: (session && session.branch) || null,
    prNumber: Number.isInteger(session && session.prNumber) ? session.prNumber : null,
    boundHeadSha: boundHead,
    boundAt: bound ? bound.source : null,
    bindings,
    drift: drifted
      ? { detected: true, expected: sessionHead, actual: boundHead, source: bound.source, step: bound.step }
      : { detected: false, expected: sessionHead, actual: boundHead, source: null, step: null },
  };
}

function lastEvidence(transitions, from, to) {
  for (let i = transitions.length - 1; i >= 0; i--) {
    const t = transitions[i];
    if (t && t.from === from && t.to === to && t.evidence && typeof t.evidence === 'object') return t.evidence;
  }
  return null;
}

// Evidence rows on the status board expose ONLY allowlisted scalar fields.
// Raw evidence objects (record paths, nested artifacts, env maps, secrets,
// free-text reports) never reach the projection.
const EVIDENCE_SCALAR_KEYS = Object.freeze(new Set([
  'ts', 'verdict', 'executorKind', 'model', 'executionStatus', 'terminalStatus',
  'exitCode', 'confidence', 'digest', 'stage', 'round', 'max', 'code', 'ok',
  'reason', 'boundAt',
]));
const EVIDENCE_SENSITIVE_RE = /[A-Za-z]:[\\/]|^[\\/]|api[_-]?key|token|secret|password|bearer|sk-/i;

// Recognised scalar-string domains: anything else (free-form text, paths,
// tokens) is dropped fail-closed rather than passed through.
const EVIDENCE_TASK_ID_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#[0-9]+$/;
const EVIDENCE_PR_REF_RE = /^PR #[0-9]+$/;
const EVIDENCE_COUNT_RE = /^[0-9]+(\/[0-9]+)?$/;
const EVIDENCE_STATUS_CODE_RE = /^[A-Z][A-Z0-9_]*$/;
const EVIDENCE_ENUM_RE = /^[a-z][a-z0-9._-]*$/;

// Per-key string domains for OBJECT evidence: each allowlisted key keeps only
// values of its own domain — a key name or a generic "not sensitive" test is
// never treated as proof of safety (an embedded POSIX path mid-string would
// pass a leading-slash-only check).
const EVIDENCE_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/;
const EVIDENCE_DIGEST_RE = /^[0-9a-f]{32,64}$/i;
const EVIDENCE_TOKEN_RE = /^[A-Za-z][A-Za-z0-9_:.\-]*$/;
const EVIDENCE_BOUND_AT_RE = /^delivery-ledger$|^[a-z]+(:[A-Za-z0-9_>-]+)+$/;
const EVIDENCE_STRING_DOMAINS = Object.freeze({
  ts: (s) => EVIDENCE_TS_RE.test(s),
  verdict: (s) => VALID_VERDICTS.includes(s),
  executorKind: (s) => EVIDENCE_ENUM_RE.test(s),
  model: (s) => EVIDENCE_ENUM_RE.test(s),
  confidence: (s) => EVIDENCE_ENUM_RE.test(s),
  executionStatus: (s) => EVIDENCE_STATUS_CODE_RE.test(s),
  terminalStatus: (s) => EVIDENCE_STATUS_CODE_RE.test(s),
  stage: (s) => EVIDENCE_STATUS_CODE_RE.test(s),
  code: (s) => EVIDENCE_STATUS_CODE_RE.test(s),
  reason: (s) => EVIDENCE_TOKEN_RE.test(s),
  boundAt: (s) => EVIDENCE_BOUND_AT_RE.test(s),
  digest: (s) => EVIDENCE_DIGEST_RE.test(s),
});

function projectEvidenceString(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (EVIDENCE_SENSITIVE_RE.test(value)) return null;
  if (VALID_VERDICTS.includes(value)) return value;               // PASS / REWORK / BLOCKED
  if (is40(value)) return value;                                  // 40-hex SHA
  if (EVIDENCE_COUNT_RE.test(value)) return value;                // numbers, "3/3"
  if (EVIDENCE_STATUS_CODE_RE.test(value)) return value;          // EXITED, DELIVERING, ...
  if (EVIDENCE_TASK_ID_RE.test(value)) return value;              // repo#issue
  if (EVIDENCE_PR_REF_RE.test(value)) return value;               // "PR #41"
  if (EVIDENCE_ENUM_RE.test(value)) return value;                 // opencode, mimo-...
  return null;                                                    // unrecognised -> dropped
}

function projectEvidence(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return projectEvidenceString(value);
  if (typeof value !== 'object') return null;
  if (Array.isArray(value)) return null;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'findings' && Array.isArray(v)) { out.findingsCount = v.length; continue; }
    if (!EVIDENCE_SCALAR_KEYS.has(k)) continue;
    if (v !== null && typeof v === 'object') continue;
    if (typeof v === 'string') {
      // BOTH gates must pass: the sensitive check (paths/tokens/secrets) and
      // the per-key domain — matching an enum/token domain is never by itself
      // proof that a string is safe (e.g. `sk-secret-value` fits the enum).
      if (EVIDENCE_SENSITIVE_RE.test(v)) continue;
      const domain = EVIDENCE_STRING_DOMAINS[k];
      if (!domain || !domain(v)) continue;
    }
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function hasTransition(transitions, from, to) {
  return transitions.some((t) => t.from === from && t.to === to);
}

// ---------------------------------------------------------------------------
// main derivation
// ---------------------------------------------------------------------------
export function deriveTaskStatus({
  stateDir,
  identityHash: id = null,
  sessionPath = null,
  deps = {},
} = {}) {
  if (typeof stateDir !== 'string' || !stateDir.trim()) {
    return { ok: false, code: 'STATUS_MALFORMED_REQUEST', field: 'stateDir' };
  }
  const sd = path.resolve(stateDir);
  const D = {
    readSession: deps.readSession || readSessionRecord,
    sessionPathFor: deps.sessionPathFor || sessionPathFor,
    readTransitions: deps.readTransitions || readTransitions,
    readExecution: deps.readExecution || readExecutionRecord,
    readProgress: deps.readProgress || readProgressRecord,
    readDelivery: deps.readDelivery || readDeliveryLedger,
    reconcileLiveness: deps.reconcileLiveness || reconcileExecutorLiveness,
    isAlive: deps.isAlive,
    readStartTime: deps.readStartTime,
  };

  const rs = safe(() => {
    const p = sessionPath || (id ? D.sessionPathFor({ stateDir: sd, identityHash: id }) : null);
    if (!p) return { ok: false, reason: 'IDENTITY_MISSING' };
    return D.readSession(p);
  }, { ok: false, reason: 'SESSION_UNREADABLE' });
  if (!rs || rs.ok !== true || !rs.session) {
    return {
      ok: true,
      status: {
        schemaVersion: TASK_STATUS_SCHEMA_VERSION,
        taskId: null,
        identity: { identityHash: id, repo: null, issueNumber: null },
        checkpoint: { state: null, step: null, index: 0, known: false, reason: 'NO_SESSION', ts: null, ledgerLength: 0, blocked: false, round: 0 },
        currentStep: { loop: null, executor: null },
        owner: { category: 'NO_TASK', liveness: null, identityProven: false, pid: null },
        candidate: { headSha: null, baseSha: null, branch: null, prNumber: null, boundHeadSha: null, bindings: [], drift: { detected: false } },
        evidence: {},
        checklist: [],
        missingRequired: [],
        rework: { rounds: 0, budget: MAX_REWORK_ROUNDS, remaining: MAX_REWORK_ROUNDS },
        submitBoundary: null,
        nextAction: { action: 'READ_BACK_SESSION', reason: String((rs && rs.reason) || 'NO_SESSION') },
        unknown: ['session'],
      },
    };
  }

  const session = rs.session;
  const identity = id || session.identityHash || null;
  if (!identity) return { ok: false, code: 'IDENTITY_UNSTABLE' };

  const transitions = safe(() => D.readTransitions({ stateDir: sd, identityHash: identity }), []) || [];
  const progressRec = safe(() => D.readProgress({ stateDir: sd, identityHash: identity }), null);
  const progress = progressRec && progressRec.ok ? progressRec.progress : null;

  const livenessOpts = {};
  if (typeof D.isAlive === 'function') livenessOpts.isAlive = D.isAlive;
  if (typeof D.readStartTime === 'function') livenessOpts.readStartTime = D.readStartTime;
  const exRec = safe(() => D.readExecution({ stateDir: sd, repo: session.repo, issueNumber: session.issueNumber }), null);
  const executionRecord = exRec && exRec.ok ? exRec.record : null;
  let execution = null;
  if (executionRecord) {
    const live = safe(() => D.reconcileLiveness(executionRecord, livenessOpts), { liveness: null, identityProven: false });
    execution = {
      liveness: live.liveness ?? null,
      identityProven: live.identityProven === true,
      pid: Number.isInteger(executionRecord.pid) ? executionRecord.pid : null,
      executor: executionRecord.executor ?? null,
      terminalStatus: executionRecord.terminalStatus ?? null,
      exitCode: Number.isInteger(executionRecord.exitCode) ? executionRecord.exitCode : null,
      identityHash: executionRecord.identityHash ?? null,
      instructionDigest: executionRecord.instructionDigest ?? null,
      startedAt: executionRecord.startedAt ?? null,
      finishedAt: executionRecord.finishedAt ?? null,
    };
  }

  const delivery = safe(() => D.readDelivery({ stateDir: sd, identityHash: identity }), null);
  const reworkRecords = safe(() => readReworkRecords({ stateDir: sd, id: identity }), []) || [];
  const submitBoundary = safe(() => readSubmitBoundary({ stateDir: sd, id: identity }), null);
  const reviewPacket = safe(() => readReviewPacket({ stateDir: sd, session }), false) === true;

  const sessionState = session.state ?? null;
  const terminal = sessionState === 'COMPLETED' || sessionState === 'FAILED' || sessionState === 'BLOCKED';
  const humanGate = HUMAN_GATE_STATES.includes(sessionState);

  const publishDone = Number.isInteger(session.prNumber) && session.prNumber > 0;
  const checkpoint = deriveCheckpoint({ transitions });

  // A COMPLETED session has walked past the last step: everything is past-due
  // there, so an incomplete ledger stays visible as a GAP instead of being
  // silently painted green (a terminal state never launders missing evidence).
  if (sessionState === 'COMPLETED') {
    checkpoint.state = 'COMPLETED';
    checkpoint.step = 'DELIVER';
    checkpoint.index = TASK_STEPS.length;
    checkpoint.completed = true;
  }

  const owner = deriveOwner({ execution, session, inFlightStep: checkpoint.step });
  const candidate = deriveCandidate({ session, transitions, reworkRecords, delivery });

  // Terminal contract: a machine-valid result is EXECUTED AND TERMINATED -
  // ExecutionRecord present, terminalStatus 'EXITED', exitCode 0, and bound to
  // this identity: identityHash must be PRESENT, a well-formed canonical
  // identity (sha256 hex) and exactly equal to the session identity.
  // STOPPED/FAILED/INTERRUPTED (even with exit 0), a missing terminal field,
  // a contradictory pair (EXITED + non-zero) or an unbound/mismatched identity
  // never pass.
  const executionResultValid = Boolean(
    executionRecord
    && executionRecord.terminalStatus === 'EXITED'
    && executionRecord.exitCode === 0
    && typeof executionRecord.identityHash === 'string'
    && HEX_DIGEST.test(executionRecord.identityHash)
    && executionRecord.identityHash === identity,
  );

  const decideOutcome = safe(() => {
    for (let i = transitions.length - 1; i >= 0; i--) {
      const t = transitions[i];
      if (t.from === 'DECIDING' && (t.to === 'REWORK' || t.to === 'DELIVERING' || t.to === 'BLOCKED')) return t.to;
    }
    return null;
  }, null);

  // A rework round is entered from DECIDING (independent reviewer) OR from
  // VERIFYING (internal pre-gate findings, sourceFrom='VERIFYING'); both burn
  // the same MAX_REWORK_ROUNDS budget, so both count.
  const rounds = transitions.filter((t) => t.to === 'REWORK').length;
  const remaining = Math.max(0, MAX_REWORK_ROUNDS - rounds);
  const s5 = session.controlLoop && session.controlLoop.s5Dispatcher ? session.controlLoop.s5Dispatcher : null;
  const humanGateArmed = humanGate
    || (s5 && s5.terminalStatus === 'READY_FOR_HUMAN_GATE')
    || checkpoint.state === 'DELIVERING';

  // publishApplicable: the publish chain is required once a review could run
  // (review-only/legacy fixtures without a git transport never bind a PR, and
  // must not be reported as a permanent gap).
  const publishApplicable = publishDone
    || hasTransition(transitions, 'VERIFYING', 'PRE_REVIEWING')
    || hasTransition(transitions, 'PRE_REVIEWING', 'FINAL_REVIEWING');

  const ctx = {
    id: identity,
    sessionOk: true,
    session,
    progress,
    execution,
    executionResultValid,
    transitions,
    publishApplicable,
    reviewPacket,
    submitBoundary,
    delivery,
    reworkRecords,
    decideOutcome,
    rounds,
    humanGateArmed: Boolean(humanGateArmed),
    hasTransition: (from, to) => hasTransition(transitions, from, to),
    evidence: (from, to) => lastEvidence(transitions, from, to),
  };

  // ---- checklist evaluation ------------------------------------------------
  const checklist = [];
  const missingRequired = [];
  for (const def of CHECKLIST) {
    const stepIndex = TASK_STEPS.indexOf(def.step);
    if (stepIndex < 0) continue;
    const isCurrent = stepIndex === checkpoint.index;
    const terminalDone = sessionState === 'COMPLETED';

    // Conditional applicability.
    if (def.kind === 'CONDITIONAL') {
      const applies = def.when ? def.when(ctx) === true : true;
      if (!applies) {
        checklist.push({ step: def.step, kind: def.kind, item: def.item, status: 'NOT_APPLICABLE', result: null, why: def.why });
        continue;
      }
    }
    if (def.kind === 'OPTIONAL' && stepIndex > checkpoint.index && !terminalDone) {
      checklist.push({ step: def.step, kind: def.kind, item: def.item, status: 'NOT_DUE', result: null, why: def.why });
      continue;
    }
    // A terminal DELIVER requirement only exists for a COMPLETED session.
    if (def.whenTerminal === true && !terminalDone && !hasTransition(transitions, 'DELIVERING', 'COMPLETED')) {
      const status = checkpoint.step === 'DELIVER' && !checkpoint.blocked ? 'PENDING' : 'NOT_APPLICABLE';
      checklist.push({ step: def.step, kind: def.kind, item: def.item, status, result: null, why: def.why });
      continue;
    }

    let r;
    try { r = def.satisfied(ctx); } catch { r = { ok: false }; }
    const okItem = r && r.ok === true;
    let status;
    if (okItem) status = 'DONE';
    else if (def.kind === 'OPTIONAL') status = stepIndex > checkpoint.index ? 'NOT_DUE' : 'ABSENT';
    else if (stepIndex > checkpoint.index) status = 'NOT_DUE';
    else if (isCurrent) status = 'PENDING';
    else status = 'MISSING';

    checklist.push({ step: def.step, kind: def.kind, item: def.item, status, result: projectEvidence(r ? r.result : null), why: def.why });
    if (status === 'MISSING' && def.kind !== 'OPTIONAL') {
      missingRequired.push({ step: def.step, item: def.item, kind: def.kind, why: def.why });
    }
  }

  // A REWORK round without its persisted rework record means the findings never
  // travelled back to the executor. The record is written BEFORE the
  // <sourceFrom>->REWORK transition (control-loop `runReworkLeg`), so a count
  // mismatch is a real lost-handoff — and the checkpoint has already moved back
  // to EXECUTE, which would otherwise hide it behind NOT_DUE.
  if (rounds > reworkRecords.length) {
    const it = checklist.find((c) => c.step === 'DECIDE' && c.item === 'rework.record');
    if (it) {
      it.status = 'MISSING';
      it.result = `${reworkRecords.length}/${rounds}`;
      missingRequired.push({ step: it.step, item: it.item, kind: it.kind, why: it.why });
    }
  }

  // A step is DONE only when every REQUIRED/CONDITIONAL item of that step is
  // DONE or NOT_APPLICABLE (a false `when` is not a gap). OPTIONAL items never
  // gate a step. NOT_APPLICABLE counts as satisfied.
  const satisfiedBlocking = (items) => items
    .filter((c) => c.kind !== 'OPTIONAL')
    .every((c) => c.status === 'DONE' || c.status === 'NOT_APPLICABLE');

  const steps = TASK_STEPS.map((name, i) => {
    const items = checklist.filter((c) => c.step === name);
    let status;
    if (items.length === 0) status = 'NOT_APPLICABLE';
    // A step the loop has not reached is NEVER painted green, even when stale
    // evidence from an earlier round happens to satisfy its fields.
    else if (i > checkpoint.index) status = 'NOT_DUE';
    else if (checkpoint.blocked && i === checkpoint.index) status = 'BLOCKED';
    // DONE strictly requires every REQUIRED/CONDITIONAL field present AND valid.
    else if (satisfiedBlocking(items)) status = 'DONE';
    else if (i === checkpoint.index) status = 'IN_FLIGHT';
    else status = 'GAP';
    return { index: i, step: name, status, items: items.length };
  });

  // ---- evidence / result per step ----------------------------------------
  // Every row value passes the SAME projection as checklist results: a
  // primitive coming from evidence is never passed through unreviewed.
  const evidenceRows = [
    { step: 'ROUTE', source: 'ledger:ROUTED->EXECUTING', result: projectEvidence((lastEvidence(transitions, 'ROUTED', 'EXECUTING') || {}).executorKind ?? null) },
    { step: 'EXECUTE', source: 'ledger:EXECUTING->VERIFYING', result: projectEvidence((lastEvidence(transitions, 'EXECUTING', 'VERIFYING') || {}).terminalStatus ?? null) },
    { step: 'PUBLISH', source: 'session', result: projectEvidence(publishDone ? `PR #${session.prNumber}` : null) },
    { step: 'VERIFY', source: 'ledger:VERIFYING->PRE_REVIEWING', result: projectEvidence((lastEvidence(transitions, 'VERIFYING', 'PRE_REVIEWING') || {}).verdict ?? null) },
    { step: 'PRE_REVIEW', source: 'ledger:PRE_REVIEWING->FINAL_REVIEWING', result: projectEvidence((lastEvidence(transitions, 'PRE_REVIEWING', 'FINAL_REVIEWING') || {}).verdict ?? null) },
    { step: 'FINAL_REVIEW', source: 'ledger:FINAL_REVIEWING->DECIDING', result: projectEvidence((lastEvidence(transitions, 'FINAL_REVIEWING', 'DECIDING') || {}).verdict ?? null) },
    { step: 'DECIDE', source: 'ledger', result: projectEvidence(decideOutcome) },
    { step: 'DELIVER', source: delivery ? 'delivery-ledger' : null, result: projectEvidence(delivery ? (delivery.merged ? 'MERGED' : 'IN_PROGRESS') : null) },
  ].filter((e) => e.result !== null);

  // ---- nextAction policy (ordered; each row is a matrix case) --------------
  const unknown = [];
  const nextAction = resolveNextAction({
    session, sessionState, humanGate, checkpoint, owner, candidate,
    missingRequired, rounds, remaining, submitBoundary,
  });

  if (!executionRecord && !terminal) unknown.push('execution');
  if (transitions.length === 0) unknown.push('ledger');
  if (submitBoundary && !submitBoundary.stage) unknown.push('submitBoundary.stage');
  if (owner.category === 'UNPROVEN') unknown.push('owner.liveness');

  const status = {
    schemaVersion: TASK_STATUS_SCHEMA_VERSION,
    taskId: session.taskId ?? `${session.repo}#${session.issueNumber}`,
    identity: { identityHash: identity, repo: session.repo ?? null, issueNumber: session.issueNumber ?? null },
    checkpoint,
    currentStep: {
      loop: checkpoint.step,
      executor: progress
        ? { current: progress.currentStep ?? null, total: progress.totalSteps ?? null, step: (progress.steps || []).find((s) => s.index === progress.currentStep) || null, updatedAt: progress.updatedAt ?? null }
        : null,
    },
    owner,
    candidate,
    evidence: { rows: evidenceRows, humanGate: humanGateArmed === true, sessionState },
    steps,
    checklist,
    missingRequired,
    rework: { rounds, budget: MAX_REWORK_ROUNDS, remaining },
    submitBoundary,
    nextAction,
    unknown,
  };
  return { ok: true, status };
}

function resolveNextAction({
  session, sessionState, humanGate, checkpoint, owner, candidate,
  missingRequired, rounds, remaining, submitBoundary,
}) {
  // 1) identity/session read-back
  if (!session) return { action: 'READ_BACK_SESSION', reason: 'NO_SESSION' };

  // 2) terminal states — never re-block, never re-complete
  if (sessionState === 'COMPLETED' || sessionState === 'FAILED') {
    return { action: 'NONE_TERMINAL', reason: `SESSION_${sessionState}` };
  }
  if (sessionState === 'BLOCKED') {
    return { action: 'INSPECT_BLOCKED_EVIDENCE', reason: checkpoint.blockedReason || 'SESSION_BLOCKED' };
  }

  // 3) the Human Gate is a deliberate stop
  if (humanGate) return { action: 'AWAIT_HUMAN_GATE', reason: `SESSION_${sessionState}` };
  if (checkpoint.state === 'DELIVERING') return { action: 'AWAIT_HUMAN_GATE', reason: 'AT_DELIVERING_BOUNDARY' };

  // 4) loop not bound yet
  if (checkpoint.ledgerLength === 0) return { action: 'CONTINUE_LOOP_NOT_BOUND', reason: 'NO_LEDGER' };

  // 5) owner/runner liveness — only meaningful while a runner is expected
  const runnerBound = checkpoint.step === 'ROUTE' || checkpoint.step === 'EXECUTE';
  if (runnerBound) {
    if (owner.category === 'UNPROVEN') return { action: 'RECONCILE_LIVENESS', reason: `LIVENESS_${owner.liveness || 'UNKNOWN'}` };
    if (owner.category === 'ALIVE') {
      return checkpoint.step === 'ROUTE'
        ? { action: 'RECONCILE_EXISTING_ATTEMPT', reason: 'RUNNER_ALIVE_BEFORE_ROUTE' }
        : { action: 'ATTACH_OBSERVE', reason: `RUNNER_${owner.liveness || 'ALIVE'}` };
    }
    if (owner.category === 'DEAD') {
      return checkpoint.step === 'EXECUTE'
        ? { action: 'REAP_DEAD_RUNNER', reason: `LIVENESS_${owner.liveness || 'DEAD'}` }
        : { action: 'RECONCILE_EXISTING_ATTEMPT', reason: 'PRIOR_RUNNER_GONE' };
    }
  }

  // 6) rework budget: only the request for a round BEYOND the budget is
  //    blocked. Rounds 1..MAX are GRANTED by the canonical loop and must be
  //    allowed to COMPLETE (verify/review/decide PASS); the loop itself
  //    refuses round > MAX with a `rework-budget-exhausted` BLOCKED tail.
  if (checkpoint.blocked && /rework-budget-exhausted/.test(String(checkpoint.blockedReason || ''))) {
    return { action: 'BLOCKED_BUDGET_EXHAUSTED', reason: `ROUNDS_${rounds}_OF_${MAX_REWORK_ROUNDS}` };
  }
  if (rounds > MAX_REWORK_ROUNDS) {
    return { action: 'BLOCKED_BUDGET_EXHAUSTED', reason: `ROUNDS_${rounds}_OF_${MAX_REWORK_ROUNDS}` };
  }

  // 7) an UNKNOWN/in-flight/POST_SUBMIT side effect must never be retried blindly
  if (checkpoint.blocked && submitBoundary && submitBoundary.stage
    && !SUBMIT_SAFE_STAGES.includes(submitBoundary.stage)
    && /^(preReview|finalReview):/.test(String(checkpoint.blockedReason || ''))) {
    return { action: 'RECONCILE_BEFORE_RESUBMIT', reason: `SUBMIT_STAGE_${submitBoundary.stage}` };
  }
  if (checkpoint.blocked && submitBoundary && !submitBoundary.stage
    && /^(preReview|finalReview):/.test(String(checkpoint.blockedReason || ''))) {
    return { action: 'RECONCILE_BEFORE_RESUBMIT', reason: 'SUBMIT_STAGE_UNKNOWN' };
  }

  // 8) recoverable BLOCKED side-transition: read the tail, re-enter the loop
  if (checkpoint.blocked) return { action: 'READ_BACK_BLOCKED_TAIL', reason: String(checkpoint.blockedReason || 'STEP_BLOCKED') };

  // 9) candidate drift / stale evidence: re-review before any gate
  if (candidate && candidate.drift && candidate.drift.detected) {
    return { action: 'REVIEW_CANDIDATE_AGAIN', reason: 'CANDIDATE_DRIFT', detail: { expected: candidate.drift.expected, actual: candidate.drift.actual, source: candidate.drift.source } };
  }

  // 10) required checklist fields missing for a past-due step
  if (missingRequired.length > 0) {
    return { action: 'FILL_MISSING_REQUIRED', reason: missingRequired.map((m) => `${m.step}.${m.item}`).slice(0, 5).join(','), detail: { count: missingRequired.length } };
  }

  // 11) nothing blocking
  return { action: 'CONTINUE', reason: `${checkpoint.step}:${checkpoint.state}`, detail: { round: checkpoint.round, remaining } };
}

// ---------------------------------------------------------------------------
// Render: one table per task (display only — never a truth source).
// ---------------------------------------------------------------------------
// Display marks as lookups (identical output, no nested ternaries).
const STEP_MARK = Object.freeze({ DONE: '✓', IN_FLIGHT: '▶', GAP: '⊗', BLOCKED: '⊗' });
const ITEM_MARK = Object.freeze({ DONE: '✓', MISSING: '⊗', PENDING: '▶', NOT_APPLICABLE: '–' });

export function renderTaskStatus(status) {
  if (!status || typeof status !== 'object') return 'NO_STATUS';
  const L = [];
  const id = status.identity || {};
  L.push(`Task: ${status.taskId || 'UNKNOWN'} · identity ${id.identityHash || 'UNKNOWN'} · schema v${status.schemaVersion}`);
  const ck = status.checkpoint || {};
  L.push(`Checkpoint: ${ck.state ?? '?'} → next step ${ck.step ?? '?'}${ck.blocked ? ` (BLOCKED: ${ck.blockedReason ?? '?'})` : ''} · round ${ck.round ?? 0}/${(status.rework && status.rework.budget) ?? '?'} · ledger ${ck.ledgerLength ?? 0}`);
  const cs = status.currentStep || {};
  L.push(`CurrentStep: loop=${cs.loop ?? '?'}${cs.executor ? ` · executor=${cs.executor.current}/${cs.executor.total}` : ' · executor=n/a'}`);
  const o = status.owner || {};
  L.push(`Owner: ${o.category ?? '?'} · liveness=${o.liveness ?? '?'} · identityProven=${o.identityProven === true} · pid=${o.pid ?? 'none'}${o.runner ? ` · runner=${o.runner}` : ''}`);
  const c = status.candidate || {};
  L.push(`Candidate: head=${c.headSha ?? 'none'} · bound=${c.boundHeadSha ?? 'none'} · PR=${c.prNumber ?? 'none'} · drift=${c.drift && c.drift.detected ? `YES (${c.drift.source})` : 'no'}`);
  L.push('');
  L.push('Steps:');
  for (const s of status.steps || []) {
    const mark = STEP_MARK[s.status] || '○';
    L.push(`  ${mark} ${String(s.index + 1).padStart(2)}. ${s.step.padEnd(12)} ${s.status}`);
  }
  L.push('');
  L.push('Checklist (REQUIRED / CONDITIONAL / OPTIONAL):');
  for (const it of status.checklist || []) {
    const mark = ITEM_MARK[it.status] || '○';
    L.push(`  ${mark} [${it.kind.padEnd(11)}] ${it.step}.${it.item} = ${it.status}${it.result !== null && it.result !== undefined ? ` (${typeof it.result === 'object' ? 'evidence' : it.result})` : ''}`);
  }
  const miss = status.missingRequired || [];
  L.push('');
  L.push(`missingRequired: ${miss.length ? miss.map((m) => `${m.step}.${m.item}`).join(', ') : 'none'}`);
  const na = status.nextAction || {};
  L.push(`nextAction: ${na.action ?? '?'} — ${na.reason ?? '?'}${na.detail ? ` ${JSON.stringify(na.detail)}` : ''}`);
  if (status.unknown && status.unknown.length) L.push(`unknown: ${status.unknown.join(', ')}`);
  return L.join('\n');
}
