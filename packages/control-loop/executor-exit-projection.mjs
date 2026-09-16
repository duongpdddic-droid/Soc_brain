#!/usr/bin/env node
// executor-exit-projection.mjs — P0: durable, transport-INDEPENDENT projection of
// an executor's terminal exit onto the canonical task lifecycle, plus durable
// operational progress. It closes the gap where a detached route-worker finalized
// the ExecutionRecord (EXITED/exitCode 0) but the canonical loop never advanced
// (transitions stayed empty -> loop.position 0/currentStep ACCEPTED, progress null,
// session stuck SESSION_ACTIVE). See the incident duongpdddic-droid/soc_brain#9000006.
//
// WHY THIS OWNS THE SEAM (and nothing more):
//   * The ONLY canonical lifecycle/progress projection point that is already
//     transport-independent is the detached route-worker: it supervises the child
//     to exit and runs startExecution's in-process finalization. This module is
//     what that worker calls once the child is terminal, so completion never
//     depends on the MCP/client lifetime NOR on the executor making one final
//     voluntary tool/progress call.
//   * It drives the canonical FSM ONLY through the existing control-loop ledger
//     seam (bindLoop().transition) and the ownership-safe session update primitive
//     (updateSessionUnderOwnershipLock). It is append-only, validated against
//     ALLOWED_TRANSITIONS, and idempotent on the ledger tail. It is NOT a second
//     lifecycle: a later full runControlLoop --resume reads the same tail and
//     continues without re-walking (control-loop.step/transition semantics).
//
// HARD INVARIANTS preserved:
//   * EXITED alone MUST NOT fabricate PASS/readiness: a READY projection requires
//     terminal EXITED + exitCode 0 + no signal + identity-proven liveness + a real
//     committed HEAD (headSha != baseSha) + deterministic executor-boundary
//     verification PASS. Anything less never becomes READY.
//   * exitCode 0 is EXECUTION evidence, NOT a review verdict. This module never
//     touches review authority, never merges/deploys/terminalizes COMPLETED, and
//     never calls taskFinish/taskBlock (terminalization stays the loop's token
//     authority). A blocked projection here is a RECOVERABLE, surfaced ledger
//     BLOCKED at the executor boundary — never a silent SESSION_ACTIVE residue.
//   * UNKNOWN fails closed: a non-terminal/unproven identity or an already-
//     projected/terminal session yields NO mutation. No blind retry/resubmit.
//   * Human Gate preserved: a session in HUMAN_GATE_REQUIRED/WAITING_FOR_INPUT is
//     never projected over.
//   * No hidden chain-of-thought: durable progress is derived only from the
//     operational events already captured verbatim by executor-launcher
//     (counts/kind), never from reasoning text.

import { execFileSync } from 'node:child_process';
import { readExecutionRecord, readActivityTail } from '../executor-launcher/executor-launcher.mjs';
import { reconcileExecutorLiveness } from '../executor-launcher/executor-reconcile.mjs';
import { applyTaskProgressUpdate } from '../task-progress/task-progress.mjs';
import {
  sessionPathFor, readSessionRecord, updateSessionUnderOwnershipLock,
  appendSessionLifecycleEvent, HUMAN_GATE_STATES,
} from '../runtime-sandbox/runtime-sandbox.mjs';
import { identityHash } from '../workspace/workspace.mjs';
import { bindLoop, readTransitions } from './control-loop.mjs';

const SHA40 = /^[0-9a-f]{40}$/i;
const EXECUTOR_ID = 'opencode';

// Canonical executor-boundary dispositions. `READY` is the ONLY one that may
// advance the ledger toward review; the rest are explicit recoverable/blocked or
// no-op (fail-closed).
export const EXIT_DISPOSITIONS = Object.freeze([
  'RUNNING', 'PRESERVE_GATE', 'NO_RECORD', 'ALREADY_PROJECTED',
  'READY', 'BLOCKED_INSUFFICIENT', 'BLOCKED_ABNORMAL',
]);

// Pure classifier — no fs, no mutation. Consumes an already-read canonical view.
// `verification.verdict === 'PASS'` here is the DETERMINISTIC executor-boundary
// verification (terminal/exit-code/identity), NOT a review verdict.
export function classifyExecutorExit({ record = null, liveness = null, headSha = null, baseSha = null, verification = null } = {}) {
  if (!record || typeof record !== 'object') return { disposition: 'NO_RECORD', code: 'NO_EXECUTION_RECORD' };
  const terminal = record.terminalStatus || null;
  if (!terminal) return { disposition: 'RUNNING', code: 'EXECUTION_NOT_TERMINAL' };

  const identityProven = liveness ? liveness.identityProven === true : false;

  // Abnormal terminal (FAILED/STOPPED/INTERRUPTED), non-zero, or signalled exit.
  if (terminal !== 'EXITED') {
    return { disposition: 'BLOCKED_ABNORMAL', code: `EXECUTOR_${terminal}`, detail: { terminalStatus: terminal, reason: record.reason ?? null, exitCode: record.exitCode ?? null, signal: record.signal ?? null } };
  }
  if (record.exitCode !== 0 || (record.signal != null && record.signal !== '')) {
    return { disposition: 'BLOCKED_ABNORMAL', code: 'EXECUTOR_EXIT_NONZERO', detail: { exitCode: record.exitCode ?? null, signal: record.signal ?? null } };
  }
  // exitCode 0 but the terminal fact is not identity-proven (e.g. PID_REUSED /
  // OWNERSHIP_UNKNOWN) — cannot be trusted as THIS attempt's clean completion.
  if (!identityProven) {
    return { disposition: 'BLOCKED_ABNORMAL', code: 'EXECUTOR_IDENTITY_UNPROVEN', detail: { liveness: liveness ? liveness.liveness : null, reason: liveness ? liveness.reason : null } };
  }

  // A real committed change must exist and deterministic verification must PASS.
  const committedHead = typeof headSha === 'string' && SHA40.test(headSha)
    && (typeof baseSha !== 'string' || headSha.toLowerCase() !== String(baseSha).toLowerCase());
  const verifyPass = verification && verification.verdict === 'PASS';
  if (!committedHead || !verifyPass) {
    return {
      disposition: 'BLOCKED_INSUFFICIENT',
      code: 'EXECUTOR_EXIT_WITHOUT_READINESS_EVIDENCE',
      detail: { committedHead: committedHead === true, verifyPass: verifyPass === true, headSha: headSha ?? null, baseSha: baseSha ?? null },
    };
  }
  return { disposition: 'READY', code: 'EXECUTOR_VERIFIED_READY', detail: { headSha, exitCode: 0, evidence: verification.evidence ?? null } };
}

// Deterministic executor-boundary verification. Mirrors the fixed mapping used
// by control-loop/adapters#deterministicVerifierAdapter (EXITED + exitCode 0 +
// no signal + binding matches this session -> PASS) but stays self-contained so
// the detached route-worker does not import the heavier review/delivery graph.
// It never approves review and never terminalizes.
export function deterministicExitVerification({ record, session }) {
  if (!record || !session) return { verdict: null, evidence: null };
  if (record.repo && String(record.repo).toLowerCase() !== String(session.repo).toLowerCase()) return { verdict: null, evidence: null };
  if (Number(record.issueNumber) !== Number(session.issueNumber)) return { verdict: null, evidence: null };
  if (record.taskId && session.taskId && record.taskId !== session.taskId) return { verdict: null, evidence: null };
  if (session.worktreePath && record.worktreePath && record.worktreePath !== session.worktreePath) return { verdict: null, evidence: null };
  if (session.baseSha && record.baseSha && record.baseSha !== session.baseSha) return { verdict: null, evidence: null };
  if (record.terminalStatus === 'EXITED' && record.exitCode === 0 && (record.signal == null || record.signal === '')) {
    return { verdict: 'PASS', evidence: { kind: 'ExecutionRecord', identityHash: record.identityHash ?? null, exitCode: 0, finishedAt: record.finishedAt ?? null } };
  }
  return { verdict: null, evidence: null };
}

// Durable operational progress derived ONLY from already-captured events
// (counts/kind). totalSteps stays a single honest "executor run" step so no
// fabricated step-plan is projected; message carries operational counters only.
export function buildDurableProgress({ record, activity, currentStepName = 'Executor run', status = null } = {}) {
  const items = activity && activity.ok && Array.isArray(activity.items) ? activity.items : [];
  let tools = 0, writes = 0, errors = 0, stepFinishes = 0;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (it.kind === 'tool') {
      tools += 1;
      const t = it.tool || (it.event && it.event.part && it.event.part.tool);
      if (t === 'write' || t === 'edit' || t === 'Write' || t === 'Edit') writes += 1;
    }
    if (it.kind === 'step_finish') stepFinishes += 1;
    if (it.kind === 'output' && typeof it.line === 'string' && /\berror\b/i.test(it.line)) errors += 1;
  }
  const terminal = Boolean(record && record.terminalStatus);
  const stepStatus = status || (terminal ? 'COMPLETED' : 'IN_PROGRESS');
  return {
    currentStep: 1,
    totalSteps: 1,
    steps: [{ index: 1, name: currentStepName, status: stepStatus }],
    message: `events=${items.length} tools=${tools} write+edit=${writes} stepFinish=${stepFinishes} errors=${errors}` + (record && record.terminalStatus ? ` terminal=${record.terminalStatus}` : ''),
    counters: { events: items.length, tools, writes, stepFinishes, errors },
  };
}

function readWorktreeHead(worktreePath, exec) {
  if (typeof worktreePath !== 'string' || !worktreePath) return null;
  try {
    const out = exec('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const sha = String(out || '').trim();
    return SHA40.test(sha) ? sha.toLowerCase() : null;
  } catch { return null; }
}

// ---- applicator --------------------------------------------------------------
// Everything is injectable so the whole matrix is testable in-process against a
// temp stateDir with fabricated records (the house test style). Defaults are the
// real primitives.
export async function reconcileExecutorExit({
  repo, issueNumber, stateDir,
  now = () => new Date().toISOString(),
  clock = Date.now,
  exec = execFileSync,
  // primitives (overridable in tests)
  readRecord = readExecutionRecord,
  readTail = readActivityTail,
  livenessProbe = reconcileExecutorLiveness,
  readLedger = readTransitions,
  bind = bindLoop,
  readSession = readSessionRecord,
  updateSession = updateSessionUnderOwnershipLock,
  appendEvent = appendSessionLifecycleEvent,
  applyProgress = applyTaskProgressUpdate,
  headReader = readWorktreeHead,
  projectProgress = true,
} = {}) {
  const id = identityHash({ repo, issueNumber });
  if (!id) return { ok: false, reason: 'IDENTITY_INVALID' };
  const sp = sessionPathFor({ stateDir, identityHash: id });

  const rs = readSession(sp);
  if (!rs.ok) return { ok: false, reason: 'SESSION_UNBOUND', detail: rs.reason ?? null, identityHash: id };
  const session = rs.session;
  if (['COMPLETED', 'FAILED', 'BLOCKED'].includes(session.state)) {
    return { ok: true, disposition: 'ALREADY_PROJECTED', reason: 'SESSION_TERMINAL', state: session.state, identityHash: id };
  }
  if (HUMAN_GATE_STATES.includes(session.state)) {
    return { ok: true, disposition: 'PRESERVE_GATE', reason: 'HUMAN_GATE_ACTIVE', state: session.state, identityHash: id };
  }

  const rr = readRecord({ stateDir, repo, issueNumber });
  if (!rr.ok || !rr.record) {
    return { ok: true, disposition: 'NO_RECORD', reason: rr.reason || 'EXECUTION_NOT_FOUND', identityHash: id };
  }
  const record = rr.record;
  const live = livenessProbe(record);

  const headSha = headReader(session.worktreePath, exec);
  const verification = deterministicExitVerification({ record, session });
  const cls = classifyExecutorExit({ record, liveness: live, headSha, baseSha: session.baseSha ?? null, verification });

  // ---- durable operational progress (A): projected whenever an execution exists
  let progress = null;
  if (projectProgress && typeof applyProgress === 'function') {
    try {
      const activity = readTail({ stateDir, repo, issueNumber, clock });
      const dp = buildDurableProgress({
        record, activity,
        status: cls.disposition === 'RUNNING' ? 'IN_PROGRESS' : 'COMPLETED',
      });
      const pr = applyProgress({
        stateDir,
        update: {
          repo, issueNumber: Number(issueNumber), executorId: EXECUTOR_ID,
          executorKind: EXECUTOR_ID, executionEpoch: 1,
          currentStep: dp.currentStep, totalSteps: dp.totalSteps, steps: dp.steps,
          message: dp.message,
        },
      });
      progress = pr && pr.ok ? { applied: true, currentStep: pr.progress.currentStep, totalSteps: pr.progress.totalSteps } : { applied: false, code: pr && pr.code };
    } catch (e) {
      progress = { applied: false, code: 'PROGRESS_THREW', detail: String((e && e.message) || e) };
    }
  }

  // Non-terminal / unknown-but-not-terminal / unproven-while-running: NO lifecycle
  // mutation (fail closed; the worker will reconcile again at true terminal, and
  // a later loop --resume can drive it). identity-unproven at a TERMINAL status is
  // still classified BLOCKED_ABNORMAL below (a dead, unprovable executor must not
  // stay silent) — but ONLY when the record itself already carries terminalStatus.
  if (cls.disposition === 'RUNNING' || cls.disposition === 'NO_RECORD') {
    return { ok: true, disposition: cls.disposition, reason: cls.code, identityHash: id, progress, headSha: headSha ?? null };
  }

  // ---- ledger projection (single canonical seam) ------------------------------
  const ledger = readLedger({ stateDir, identityHash: id });
  const tail = ledger.length ? ledger[ledger.length - 1].to : 'ACCEPTED';
  const PAST = new Set(['VERIFYING', 'PRE_REVIEWING', 'FINAL_REVIEWING', 'DECIDING', 'REWORK', 'DELIVERING', 'COMPLETED', 'BLOCKED']);
  // If the loop already owns the walk past the executor boundary (or already
  // terminalized), this reconciler must NOT force a second projection.
  if (PAST.has(tail) && tail !== 'EXECUTING') {
    return { ok: true, disposition: 'ALREADY_PROJECTED', reason: 'LEDGER_PAST_EXECUTOR_BOUNDARY', tail, identityHash: id, progress, headSha: headSha ?? null };
  }

  const loop = bind({ sessionPath: sp, identityHash: id, stateDir, now });
  if (!loop || typeof loop.transition !== 'function') {
    return { ok: false, reason: 'LEDGER_BIND_FAILED', identityHash: id };
  }
  const appended = [];
  const walk = (from, to, reason, evidence) => {
    const r = loop.transition({ from, to, reason, evidence });
    if (r && r.ok) appended.push({ from, to, reason });
    return r;
  };
  // Drive only the steps needed to reach the executor boundary from the real tail.
  // tail is provably one of ACCEPTED/ROUTED/EXECUTING here (everything else was
  // short-circuited above), so this walk is legal and lands exactly at EXECUTING.
  if (tail === 'ACCEPTED') { const r = walk('ACCEPTED', 'ROUTED', 'reconcile-route'); if (!r || !r.ok) return { ok: false, reason: 'TRANSITION_REJECTED', at: 'ACCEPTED->ROUTED', identityHash: id, appended }; }
  if (tail === 'ACCEPTED' || tail === 'ROUTED') { const r = walk('ROUTED', 'EXECUTING', 'reconcile-executing'); if (!r || !r.ok) return { ok: false, reason: 'TRANSITION_REJECTED', at: 'ROUTED->EXECUTING', identityHash: id, appended }; }

  const boundaryEvidence = {
    terminalStatus: record.terminalStatus ?? null, exitCode: record.exitCode ?? null,
    signal: record.signal ?? null, identityProven: live && live.identityProven === true,
    liveness: live ? live.liveness : null, pid: record.pid ?? null,
    headSha: headSha ?? null, baseSha: session.baseSha ?? null,
    finishedAt: record.finishedAt ?? null, reconciledBy: 'executor-exit-projection',
  };

  if (cls.disposition === 'READY') {
    const r = loop.transition({ from: 'EXECUTING', to: 'VERIFYING', reason: cls.code, evidence: { ...boundaryEvidence, verdict: 'PASS' } });
    if (!r || !r.ok) return { ok: false, reason: 'TRANSITION_REJECTED', at: 'EXECUTING->VERIFYING', detail: r && r.code, identityHash: id, appended };
    appended.push({ from: 'EXECUTING', to: 'VERIFYING', reason: cls.code });
    // Pin the verified committed HEAD onto the session (ownership-safe), so the
    // canonical handoff (requestReview) legitimately reports READY_FOR_REVIEW
    // WITHOUT this module ever asserting a review verdict.
    const up = updateSession(sp, (s) => {
      if (s.state === 'COMPLETED' || s.state === 'FAILED' || s.state === 'BLOCKED') return { ok: false, reason: 'SESSION_TERMINAL_RACE' };
      if (HUMAN_GATE_STATES.includes(s.state)) return { ok: false, reason: 'HUMAN_GATE_ACTIVE' };
      const cur = typeof s.headSha === 'string' && SHA40.test(s.headSha) ? s.headSha.toLowerCase() : null;
      const base = typeof s.baseSha === 'string' ? s.baseSha.toLowerCase() : null;
      // Allow pinning when nothing is committed yet (absent HEAD or HEAD still ==
      // base, the exact never-committed residue) — but never clobber a genuinely
      // different committed HEAD that this reconciler did not produce.
      if (cur && cur !== headSha.toLowerCase() && cur !== base) {
        return { ok: false, reason: 'HEAD_CONFLICT', detail: 'session already pins a different committed HEAD; reconciler will not clobber' };
      }
      s.headSha = headSha;
      if (!Array.isArray(s.lifecycle)) s.lifecycle = [];
      return { session: s };
    });
    if (appendEvent) { try { appendEvent({ sessionPath: sp, event: 'EXECUTOR_EXIT_RECONCILED', detail: 'READY_FOR_REVIEW handoff boundary (executor-boundary verification PASS; not a review verdict)' }); } catch { /* telemetry */ } }
    return { ok: true, disposition: 'READY', reason: cls.code, headSha, identityHash: id, appended, progress, sessionUpdate: up && up.ok ? 'pinned' : (up && (up.reason || 'update_failed')), reviewBoundary: 'READY_FOR_REVIEW' };
  }

  // BLOCKED_INSUFFICIENT / BLOCKED_ABNORMAL -> explicit, surfaced, RECOVERABLE
  // ledger BLOCKED at the executor boundary (never fabricated READY; loop/terminal
  // session taskBlock stays with its token owner).
  const r = loop.transition({ from: 'EXECUTING', to: 'BLOCKED', reason: cls.code, evidence: { ...boundaryEvidence, ...('detail' in cls ? { detail: cls.detail } : {}) } });
  if (!r || !r.ok) return { ok: false, reason: 'TRANSITION_REJECTED', at: 'EXECUTING->BLOCKED', detail: r && r.code, identityHash: id, appended };
  appended.push({ from: 'EXECUTING', to: 'BLOCKED', reason: cls.code });
  if (appendEvent) { try { appendEvent({ sessionPath: sp, event: 'EXECUTOR_EXIT_RECONCILED', detail: `${cls.disposition}:${cls.code} (recoverable executor-boundary block; not terminalized)` }); } catch { /* telemetry */ } }
  return { ok: true, disposition: cls.disposition, reason: cls.code, identityHash: id, appended, progress, headSha: headSha ?? null, recoverable: true };
}
