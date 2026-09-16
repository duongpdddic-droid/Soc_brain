#!/usr/bin/env node
// effective-state.mjs — F2 (P0): the SINGLE authoritative "effective operational
// state" derived from durable canonical reads, shared by EVERY public consumer
// (get_task, get_progress, recover/discovery, the attached follower/UI) so they
// cannot disagree.
//
// WHY: a detached executor can finalize its ExecutionRecord (EXITED/GONE) and the
// reconciled canonical ledger can sit at BLOCKED while the SESSION record still
// reads SESSION_ACTIVE. Raw `session.state` alone then LOOKS "active/running" to a
// consumer even though nothing is running — the exact #9000006 residue confusion.
// This projects the EFFECTIVE state without mutating or fabricating anything.
//
// HARD RULES:
//   * Read-only derivation over canonical facts (session/execution/ledger/progress
//     + #160 identity liveness). It NEVER writes, NEVER terminalizes, NEVER emits
//     a review verdict.
//   * It MUST NOT fabricate READY or a terminal review verdict to make fields
//     agree. READY only when a verified, committed HEAD legitimately backs it.
//   * UNKNOWN stays UNKNOWN and NOT running (fail closed); EXITED/GONE is always
//     notRunning, never a synthetic RUNNING.
//   * RECOVERABLE_BLOCKED is the surfaced, resumable executor-boundary block — it
//     is NOT the terminal session BLOCKED and NOT a failure verdict.

export const EFFECTIVE_STATES = Object.freeze([
  'RUNNING', 'STARTING', 'HUMAN_GATE', 'READY_FOR_REVIEW',
  'RECOVERABLE_BLOCKED', 'PENDING_RECONCILIATION', 'UNKNOWN',
  'COMPLETED', 'FAILED', 'TERMINAL_BLOCKED',
]);

const HUMAN_GATE_STATES = ['HUMAN_GATE_REQUIRED', 'WAITING_FOR_INPUT'];
const TERMINAL_SESSION = ['COMPLETED', 'FAILED', 'BLOCKED'];
// Ledger steps that live PAST the executor boundary and indicate review handoff.
const REVIEW_HANDOFF_STEPS = ['VERIFYING', 'PRE_REVIEWING', 'FINAL_REVIEWING', 'DECIDING', 'DELIVERING'];

function headReadyForReview(session) {
  const head = typeof session?.headSha === 'string' ? session.headSha : '';
  const base = typeof session?.baseSha === 'string' ? session.baseSha : '';
  return /^[0-9a-f]{40}$/i.test(head) && head.toLowerCase() !== base.toLowerCase();
}

// inputs:
//   session   { state, headSha, baseSha }        (runtime-sandbox canonical record)
//   execution { status, liveness, identityProven, terminalStatus } (from #160) or null
//   loop      { position, currentStep } | null    (control-loop ledger projection)
//   progress  { currentStep,totalSteps,... } | null (task-progress telemetry)
export function computeEffectiveState({ session = null, execution = null, loop = null, progress = null } = {}) {
  const state = session && typeof session === 'object' ? session.state : null;

  const seqParts = [
    state ?? '-',
    execution && (execution.liveness || execution.status) || 'noexec',
    execution && execution.identityProven ? 'id' : 'noid',
    loop ? `${loop.position ?? 0}:${loop.currentStep ?? 'ACCEPTED'}` : '0:ACCEPTED',
    headReadyForReview(session) ? 'hdiff' : 'hbase',
    progress ? (progress.updatedAt ?? progress.currentStep ?? '-') : '-',
  ];
  const seq = seqParts.join('|');

  const base = { effectiveState: null, notRunning: false, running: false, humanActionRequired: false, recoverable: false, readyForReview: false, terminal: false, seq };

  // 1) terminal session wins (verbatim; never reinterpreted).
  if (state === 'COMPLETED') return { ...base, effectiveState: 'COMPLETED', terminal: true, notRunning: true };
  if (state === 'FAILED') return { ...base, effectiveState: 'FAILED', terminal: true, notRunning: true };
  if (state === 'BLOCKED') return { ...base, effectiveState: 'TERMINAL_BLOCKED', terminal: true, notRunning: true };

  // 2) Human Gate preserved ahead of executor/ledger signals.
  if (HUMAN_GATE_STATES.includes(state)) {
    return { ...base, effectiveState: 'HUMAN_GATE', humanActionRequired: true, notRunning: true };
  }

  const lv = execution ? (execution.liveness || execution.status) : null;
  const identityProven = Boolean(execution && execution.identityProven);
  const currentStep = loop ? loop.currentStep : null;

  // 3) identity-proven live executor.
  if (lv === 'RUNNING' || lv === 'RUNNING_PROGRESSING') {
    if (!identityProven) return { ...base, effectiveState: 'UNKNOWN', notRunning: false }; // unprovable -> UNKNOWN, never synthetic RUNNING
    if (currentStep === 'BLOCKED') return { ...base, effectiveState: 'RECOVERABLE_BLOCKED', recoverable: true, notRunning: true };
    return { ...base, effectiveState: 'RUNNING', running: true };
  }
  if (lv === 'STARTING') return { ...base, effectiveState: 'STARTING', running: true };
  if (lv === 'OWNERSHIP_UNKNOWN' || lv === 'PID_REUSED' || lv === 'STALE_CHILD') {
    return { ...base, effectiveState: 'UNKNOWN' };
  }

  // 4) executor gone / terminal (EXITED/FAILED/STOPPED/INTERRUPTED) while session
  //    is still SESSION_ACTIVE: project the reconciled canonical boundary.
  if (lv === 'EXITED' || lv === 'FAILED' || lv === 'STOPPED' || lv === 'INTERRUPTED' || lv === 'GONE') {
    if (currentStep === 'BLOCKED') {
      return { ...base, effectiveState: 'RECOVERABLE_BLOCKED', recoverable: true, notRunning: true };
    }
    if (REVIEW_HANDOFF_STEPS.includes(currentStep) && headReadyForReview(session)) {
      return { ...base, effectiveState: 'READY_FOR_REVIEW', readyForReview: true, notRunning: true };
    }
    if (REVIEW_HANDOFF_STEPS.includes(currentStep)) {
      return { ...base, effectiveState: 'PENDING_RECONCILIATION', notRunning: true };
    }
    // EXITED but the ledger was never projected past the executor boundary: NOT
    // running and NOT ready — explicit pending-reconciliation, never silent-active.
    return { ...base, effectiveState: 'PENDING_RECONCILIATION', notRunning: true };
  }

  // 5) no execution evidence at all yet (dispatch window / admitted-only).
  if (!execution || lv == null) {
    return { ...base, effectiveState: 'PENDING_RECONCILIATION', notRunning: false };
  }
  return { ...base, effectiveState: 'UNKNOWN' };
}

// Operational notification surface for the attached follower. OPERATIONAL fields
// only — never chain-of-thought / reasoning text. progress carries the bounded
// executor step telemetry + counters already projected durably.
export function buildOperationalView({ session, identityHash, execution, loop, progress, effective }) {
  const gate = session && session.humanGate ? session.humanGate : null;
  return {
    kind: 'soc.operational',
    taskId: session ? session.taskId ?? null : null,
    identityHash: identityHash ?? null,
    repo: session ? session.repo ?? null : null,
    issueNumber: session ? session.issueNumber ?? null : null,
    effectiveState: effective.effectiveState,
    notRunning: effective.notRunning === true,
    running: effective.running === true,
    humanActionRequired: effective.humanActionRequired === true,
    recoverable: effective.recoverable === true,
    readyForReview: effective.readyForReview === true,
    terminal: effective.terminal === true,
    seq: effective.seq,
    loop: loop ? { position: loop.position ?? 0, currentStep: loop.currentStep ?? 'ACCEPTED' } : { position: 0, currentStep: 'ACCEPTED' },
    progress: progress ? { currentStep: progress.currentStep ?? null, totalSteps: progress.totalSteps ?? null, message: progress.message ?? null, updatedAt: progress.updatedAt ?? null } : null,
    execution: execution ? { status: execution.status ?? null, liveness: execution.liveness ?? null, identityProven: execution.identityProven === true } : null,
    humanGate: gate ? { state: gate.state ?? null, at: gate.at ?? null } : null,
  };
}
