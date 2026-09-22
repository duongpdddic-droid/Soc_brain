#!/usr/bin/env node
// s5-dispatcher.mjs — Stage S5 Post-Final-Review Dispatcher (Issue #S5).
//
// Responsibilities (transport-free, loop-free):
//   1. PASS branch: Set terminal status to READY_FOR_HUMAN_GATE, generate
//      merge handoff payload with PR link, and exit cleanly.
//   2. BLOCKED branch: Fail-closed halt, emit blocker alert, and lock
//      workspace state.
//
// Authority (hard invariant): this module is a POST-PROCESSING layer that
// receives the already-terminal result from runControlLoop(). It NEVER
// modifies the FSM transitions, NEVER terminalizes, and NEVER dispatches
// executors. It only performs S5-specific side effects based on the
// validated terminal state.
//
// Actual runControlLoop() output contracts (control-loop.mjs):
//   PASS:     { ok: true,  value: { state: 'COMPLETED', notification, delivery, terminalize, loopToken } }
//   BLOCKED:  { ok: true,  value: { state: 'BLOCKED',   terminalize, loopToken } }
//   Error:    { ok: false, code, detail }
//
// NOTE: The control loop NEVER returns state === 'REWORK' in the final
// output. The rework leg is handled internally by decide() and
// runReworkLeg(). The S5 dispatcher only sees terminal states (COMPLETED
// or BLOCKED). REWORK verdicts are consumed by the control loop's DECIDING
// policy and either re-dispatch internally or escalate to BLOCKED on
// budget exhaustion.

import fs from 'node:fs';
import path from 'node:path';
import { updateSessionUnderOwnershipLock, readSessionRecord } from '../runtime-sandbox/runtime-sandbox.mjs';
import { identityHash } from '../workspace/workspace.mjs';

// ---- Schema & constants ----------------------------------------------------
export const S5_DISPATCH_SCHEMA_VERSION = '1';

// Terminal states that the S5 dispatcher recognizes from runControlLoop()
export const S5_TERMINAL_STATES = Object.freeze(new Set(['COMPLETED', 'BLOCKED']));

// ---- Helpers ----------------------------------------------------------------
function ok(v, extra = {}) { return { ok: true, value: v, ...extra }; }
function fail(code, detail) { return { ok: false, code, detail: detail ?? null }; }

function readSessionByHash({ stateDir, identityHash: id }) {
  const sp = path.join(stateDir, 'sessions', `${id}.json`);
  return readSessionRecord(sp);
}

// ---- PASS Branch Handler ---------------------------------------------------
// Sets terminal status to READY_FOR_HUMAN_GATE, generates merge handoff
// payload with PR link, and exits cleanly.
// Contract: result = { state: 'COMPLETED', notification, delivery, terminalize, loopToken }
export function handlePassBranch({ result, sessionPath, stateDir, identityHash: id }) {
  if (!result || result.state !== 'COMPLETED') {
    return fail('S5_PASS_INVALID_STATE', `expected COMPLETED, got ${result && result.state}`);
  }

  // Read the persisted session to get PR number and other metadata
  const rs = readSessionByHash({ stateDir, identityHash: id });
  if (!rs.ok) return fail('S5_PASS_SESSION_READ_FAILED', rs.reason);

  const session = rs.session;
  const prNumber = session.prNumber || null;
  const headSha = session.headSha || null;
  const repo = session.repo || null;
  const issueNumber = session.issueNumber || null;

  // Generate merge handoff payload
  const handoffPayload = generateMergeHandoffPayload({
    session,
    prNumber,
    headSha,
    repo,
    issueNumber,
    terminalStatus: 'READY_FOR_HUMAN_GATE',
    decision: result.delivery || null,
  });

  // Persist READY_FOR_HUMAN_GATE status (ownership-safe)
  const persisted = updateSessionUnderOwnershipLock(sessionPath, (auth) => {
    auth.controlLoop = auth.controlLoop && typeof auth.controlLoop === 'object' ? auth.controlLoop : {};
    auth.controlLoop.s5Dispatcher = {
      schemaVersion: S5_DISPATCH_SCHEMA_VERSION,
      branch: 'PASS',
      terminalStatus: 'READY_FOR_HUMAN_GATE',
      handoffPayload,
      dispatchedAt: new Date().toISOString(),
    };
    return { session: auth };
  });

  if (!persisted.ok) {
    return fail('S5_PASS_PERSIST_FAILED', persisted.detail ?? persisted.reason);
  }

  return ok({
    branch: 'PASS',
    terminalStatus: 'READY_FOR_HUMAN_GATE',
    handoffPayload,
    prNumber,
    headSha,
    repo,
    issueNumber,
  });
}

// ---- BLOCKED Branch Handler ------------------------------------------------
// Fail-closed halt, emits blocker alert, and locks workspace state.
// Contract: result = { state: 'BLOCKED', terminalize, loopToken }
//   May also carry: reason (e.g., 'REWORK_BUDGET_EXHAUSTED')
export function handleBlockedBranch({ result, sessionPath, stateDir, identityHash: id }) {
  if (!result || result.state !== 'BLOCKED') {
    return fail('S5_BLOCKED_INVALID_STATE', `expected BLOCKED, got ${result && result.state}`);
  }

  // Read the persisted session to get metadata
  const rs = readSessionByHash({ stateDir, identityHash: id });
  if (!rs.ok) return fail('S5_BLOCKED_SESSION_READ_FAILED', rs.reason);

  const session = rs.session;

  // Extract blocker information from the result
  // The BLOCKED result may carry: reason, terminalize.evidence (findings from decision)
  const reason = result.reason || null;
  const terminalizeEvidence = result.terminalize && result.terminalize.evidence
    ? result.terminalize.evidence
    : null;
  const findings = (terminalizeEvidence && terminalizeEvidence.findings) || [];
  const evidenceRequests = (terminalizeEvidence && terminalizeEvidence.evidenceRequests) || [];
  const decision = terminalizeEvidence || null;

  // Emit blocker alert (best-effort, evidence recorded)
  const blockerAlert = emitBlockerAlert({ session, findings, evidenceRequests, decision, reason });

  // Lock workspace state (ownership-safe)
  const lockResult = lockWorkspaceState({ sessionPath, stateDir, identityHash: id });

  // Persist BLOCKED status with alert evidence
  const persisted = updateSessionUnderOwnershipLock(sessionPath, (auth) => {
    auth.controlLoop = auth.controlLoop && typeof auth.controlLoop === 'object' ? auth.controlLoop : {};
    auth.controlLoop.s5Dispatcher = {
      schemaVersion: S5_DISPATCH_SCHEMA_VERSION,
      branch: 'BLOCKED',
      terminalStatus: 'BLOCKED',
      blockerAlert,
      workspaceLocked: lockResult.ok === true,
      reason,
      findings,
      evidenceRequests,
      decision,
      dispatchedAt: new Date().toISOString(),
    };
    return { session: auth };
  });

  if (!persisted.ok) {
    return fail('S5_BLOCKED_PERSIST_FAILED', persisted.detail ?? persisted.reason);
  }

  return ok({
    branch: 'BLOCKED',
    terminalStatus: 'BLOCKED',
    blockerAlert,
    workspaceLocked: lockResult.ok === true,
    reason,
    findings,
    evidenceRequests,
  });
}

// ---- Merge Handoff Payload Generator ----------------------------------------
// Generates a structured payload for human merge authorization.
export function generateMergeHandoffPayload({ session, prNumber, headSha, repo, issueNumber, terminalStatus, decision }) {
  const payload = {
    schemaVersion: S5_DISPATCH_SCHEMA_VERSION,
    kind: 'MERGE_HANDOFF',
    identity: {
      repository: repo || null,
      issue: issueNumber || null,
      pullRequest: prNumber || null,
      headSha: headSha || null,
    },
    terminalStatus: terminalStatus || 'READY_FOR_HUMAN_GATE',
    handoff: {
      prLink: prNumber ? `https://github.com/${repo}/pull/${prNumber}` : null,
      readyForMerge: terminalStatus === 'READY_FOR_HUMAN_GATE',
      requiresHumanApproval: true,
      decision: decision || null,
    },
    metadata: {
      generatedAt: new Date().toISOString(),
      schemaVersion: S5_DISPATCH_SCHEMA_VERSION,
    },
  };

  return payload;
}

// ---- Blocker Alert Emitter -------------------------------------------------
// Emits a structured blocker alert for the BLOCKED branch.
export function emitBlockerAlert({ session, findings, evidenceRequests, decision, reason }) {
  const alert = {
    schemaVersion: S5_DISPATCH_SCHEMA_VERSION,
    kind: 'BLOCKER_ALERT',
    identity: {
      repository: session.repo || null,
      issue: session.issueNumber || null,
      headSha: session.headSha || null,
    },
    blocker: {
      findings: findings || [],
      evidenceRequests: evidenceRequests || [],
      decision: decision || null,
      reason: reason || (decision && decision.findings ? decision.findings.join('; ') : 'BLOCKED verdict received'),
    },
    metadata: {
      emittedAt: new Date().toISOString(),
      severity: 'HIGH',
      requiresImmediateAttention: true,
    },
  };

  // Best-effort dispatch to Telegram if available
  try {
    const telegramDispatch = dispatchBlockerAlert(alert);
    alert.telegramDispatch = telegramDispatch;
  } catch (e) {
    alert.telegramDispatch = { status: 'NOT_ATTEMPTED', error: String((e && e.message) || e) };
  }

  return alert;
}

// ---- Workspace State Locker ------------------------------------------------
// Locks workspace state to prevent further mutations.
export function lockWorkspaceState({ sessionPath, stateDir, identityHash: id }) {
  try {
    const persisted = updateSessionUnderOwnershipLock(sessionPath, (auth) => {
      auth.controlLoop = auth.controlLoop && typeof auth.controlLoop === 'object' ? auth.controlLoop : {};
      auth.controlLoop.workspaceLocked = true;
      auth.controlLoop.workspaceLockedAt = new Date().toISOString();
      auth.controlLoop.workspaceLockReason = 'BLOCKED by S5 dispatcher';
      return { session: auth };
    });

    if (!persisted.ok) {
      return fail('WORKSPACE_LOCK_FAILED', persisted.detail ?? persisted.reason);
    }

    return ok({ locked: true, at: new Date().toISOString() });
  } catch (e) {
    return fail('WORKSPACE_LOCK_ERROR', String((e && e.message) || e));
  }
}

// ---- Telegram Blocker Alert Dispatcher (best-effort) -----------------------
function dispatchBlockerAlert(alert) {
  // Best-effort: if telegram-dispatch is available, use it
  try {
    // This is a placeholder for actual Telegram dispatch
    // In production, this would call dispatchLifecycleEvent
    return { status: 'NOT_ATTEMPTED', reason: 'S5_BLOCKER_ALERT_PLACEHOLDER' };
  } catch (e) {
    return { status: 'NOT_ATTEMPTED', error: String((e && e.message) || e) };
  }
}

// ---- Main S5 Dispatcher ----------------------------------------------------
// Main entry point that dispatches based on the terminal state from
// runControlLoop().
//
// Actual runControlLoop() output contracts:
//   PASS:    { ok: true,  value: { state: 'COMPLETED', ... } }
//   BLOCKED: { ok: true,  value: { state: 'BLOCKED', ... } }
//   Error:   { ok: false, code, detail }
//
// The control loop NEVER returns state === 'REWORK'. REWORK verdicts are
// consumed internally by the control loop's DECIDING policy and either
// re-dispatch the executor or escalate to BLOCKED on budget exhaustion.
export function dispatchPostFinalReview({ result, sessionPath, stateDir, identityHash: id, deps = {} } = {}) {
  if (!result || typeof result !== 'object') {
    return fail('S5_DISPATCH_INVALID_RESULT', 'result must be a non-null object');
  }
  if (typeof sessionPath !== 'string' || !sessionPath) {
    return fail('S5_DISPATCH_MISSING_SESSION_PATH', 'sessionPath is required');
  }
  if (typeof id !== 'string' || !id) {
    return fail('S5_DISPATCH_MISSING_IDENTITY_HASH', 'identityHash is required');
  }
  if (typeof stateDir !== 'string' || !stateDir) {
    return fail('S5_DISPATCH_MISSING_STATE_DIR', 'stateDir is required');
  }

  // Determine the branch based on the result state
  const state = result.state;

  if (state === 'COMPLETED') {
    return handlePassBranch({ result, sessionPath, stateDir, identityHash: id });
  }

  if (state === 'BLOCKED') {
    return handleBlockedBranch({ result, sessionPath, stateDir, identityHash: id });
  }

  return fail('S5_DISPATCH_UNKNOWN_STATE', `unknown terminal state: ${state}`);
}

// end of s5-dispatcher.mjs — no trailing marker.
