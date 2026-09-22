#!/usr/bin/env node
// s5-dispatcher.mjs — Stage S5 Post-Final-Review Dispatcher (Issue #S5).
//
// Responsibilities (transport-free, loop-free):
//   1. PASS branch: Set terminal status to READY_FOR_HUMAN_GATE, generate
//      merge handoff payload with PR link, and exit cleanly.
//   2. REWORK branch: Package reviewer findings and re-queue/re-enter the
//      task to the executor session with bounded retry counter.
//   3. BLOCKED branch: Fail-closed halt, emit blocker alert, and lock
//      workspace state.
//
// Authority (hard invariant): this module is a POST-PROCESSING layer that
// receives the already-terminal result from runControlLoop(). It NEVER
// modifies the FSM transitions, NEVER terminalizes, and NEVER dispatches
// executors. It only performs S5-specific side effects based on the
// validated terminal state.

import fs from 'node:fs';
import path from 'node:path';
import { updateSessionUnderOwnershipLock, readSessionRecord } from '../runtime-sandbox/runtime-sandbox.mjs';
import { identityHash } from '../workspace/workspace.mjs';

// ---- Schema & constants ----------------------------------------------------
export const S5_DISPATCH_SCHEMA_VERSION = '1';
export const MAX_REWORK_RETRY_COUNTER = 3;

// Terminal states that the S5 dispatcher recognizes
export const S5_TERMINAL_STATES = Object.freeze(new Set(['COMPLETED', 'BLOCKED', 'REWORK']));

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

// ---- REWORK Branch Handler -------------------------------------------------
// Packages reviewer findings and re-queues/re-enters the task to the executor
// session with bounded retry counter.
export function handleReworkBranch({ result, sessionPath, stateDir, identityHash: id }) {
  if (!result || result.state !== 'REWORK') {
    return fail('S5_REWORK_INVALID_STATE', `expected REWORK, got ${result && result.state}`);
  }

  // Read the persisted session to get metadata
  const rs = readSessionByHash({ stateDir, identityHash: id });
  if (!rs.ok) return fail('S5_REWORK_SESSION_READ_FAILED', rs.reason);

  const session = rs.session;

  // Extract findings from the result
  const findings = result.findings || [];
  const evidenceRequests = result.evidenceRequests || [];
  const decision = result.decision || null;

  // Get current retry counter from session
  const currentRetryCount = (session.controlLoop && session.controlLoop.s5Dispatcher
    && session.controlLoop.s5Dispatcher.retryCounter) || 0;

  // Check bounded retry counter
  if (currentRetryCount >= MAX_REWORK_RETRY_COUNTER) {
    // Retry budget exhausted - escalate to BLOCKED
    const persisted = updateSessionUnderOwnershipLock(sessionPath, (auth) => {
      auth.controlLoop = auth.controlLoop && typeof auth.controlLoop === 'object' ? auth.controlLoop : {};
      auth.controlLoop.s5Dispatcher = {
        schemaVersion: S5_DISPATCH_SCHEMA_VERSION,
        branch: 'BLOCKED',
        terminalStatus: 'REWORK_BUDGET_EXHAUSTED',
        retryCounter: currentRetryCount,
        maxRetries: MAX_REWORK_RETRY_COUNTER,
        dispatchedAt: new Date().toISOString(),
      };
      return { session: auth };
    });

    return ok({
      branch: 'BLOCKED',
      terminalStatus: 'REWORK_BUDGET_EXHAUSTED',
      retryCounter: currentRetryCount,
      maxRetries: MAX_REWORK_RETRY_COUNTER,
      findings,
      evidenceRequests,
    });
  }

  // Increment retry counter and persist
  const newRetryCount = currentRetryCount + 1;
  const persisted = updateSessionUnderOwnershipLock(sessionPath, (auth) => {
    auth.controlLoop = auth.controlLoop && typeof auth.controlLoop === 'object' ? auth.controlLoop : {};
    auth.controlLoop.s5Dispatcher = {
      schemaVersion: S5_DISPATCH_SCHEMA_VERSION,
      branch: 'REWORK',
      terminalStatus: 'READY_FOR_REDISPATCH',
      retryCounter: newRetryCount,
      maxRetries: MAX_REWORK_RETRY_COUNTER,
      findings,
      evidenceRequests,
      decision,
      dispatchedAt: new Date().toISOString(),
    };
    return { session: auth };
  });

  if (!persisted.ok) {
    return fail('S5_REWORK_PERSIST_FAILED', persisted.detail ?? persisted.reason);
  }

  return ok({
    branch: 'REWORK',
    terminalStatus: 'READY_FOR_REDISPATCH',
    retryCounter: newRetryCount,
    maxRetries: MAX_REWORK_RETRY_COUNTER,
    findings,
    evidenceRequests,
    decision,
  });
}

// ---- BLOCKED Branch Handler ------------------------------------------------
// Fail-closed halt, emits blocker alert, and locks workspace state.
export function handleBlockedBranch({ result, sessionPath, stateDir, identityHash: id }) {
  if (!result || result.state !== 'BLOCKED') {
    return fail('S5_BLOCKED_INVALID_STATE', `expected BLOCKED, got ${result && result.state}`);
  }

  // Read the persisted session to get metadata
  const rs = readSessionByHash({ stateDir, identityHash: id });
  if (!rs.ok) return fail('S5_BLOCKED_SESSION_READ_FAILED', rs.reason);

  const session = rs.session;

  // Extract blocker information
  const findings = result.findings || [];
  const evidenceRequests = result.evidenceRequests || [];
  const decision = result.decision || null;

  // Emit blocker alert (best-effort, evidence recorded)
  const blockerAlert = emitBlockerAlert({ session, findings, evidenceRequests, decision });

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
export function emitBlockerAlert({ session, findings, evidenceRequests, decision }) {
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
      reason: decision && decision.findings ? decision.findings.join('; ') : 'BLOCKED verdict received',
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

  if (state === 'REWORK') {
    return handleReworkBranch({ result, sessionPath, stateDir, identityHash: id });
  }

  if (state === 'BLOCKED') {
    return handleBlockedBranch({ result, sessionPath, stateDir, identityHash: id });
  }

  return fail('S5_DISPATCH_UNKNOWN_STATE', `unknown terminal state: ${state}`);
}

// end of s5-dispatcher.mjs — no trailing marker.
