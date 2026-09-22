#!/usr/bin/env node
// s6-human-gate.mjs — Stage S6 Human Merge Gate.
//
// Consumes the MERGE_HANDOFF payload from Stage S5 and enforces the human
// decision gate before merge execution.
//
// Authority (hard invariant):
//   - This module is a POST-PROCESSING layer that runs AFTER S5 has set
//     terminalStatus to READY_FOR_HUMAN_GATE.
//   - It NEVER modifies FSM transitions, NEVER terminalizes, NEVER dispatches.
//   - A GPT PASS must never substitute for human merge authorization.
//   - A human APPROVE_AND_MERGE decision must never substitute for a validated
//     GPT PASS.
//   - Merge only happens when BOTH conditions are met:
//     1. GPT FINAL_REVIEW verdict is PASS (enforced by S5 handoff)
//     2. Human explicitly approves via APPROVE_AND_MERGE
//
// Fail-Closed: every validation failure returns { ok: false, code, detail }
// and the caller MUST NOT proceed.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { updateSessionUnderOwnershipLock, readSessionRecord } from '../runtime-sandbox/runtime-sandbox.mjs';
import { identityHash } from '../workspace/workspace.mjs';

// ---- Schema & constants ----------------------------------------------------
export const S6_GATE_SCHEMA_VERSION = '1';
export const S6_VALID_ACTIONS = Object.freeze(new Set(['APPROVE_AND_MERGE', 'REJECT_AND_BLOCK']));
export const S6_REQUIRED_LABEL_APPROVE = 'status:approved';
export const S6_REQUIRED_LABEL_BLOCKED = 'status:blocked';
export const S6_PR_STATE_OPEN = 'OPEN';

// ---- Helpers ----------------------------------------------------------------
function ok(v, extra = {}) { return { ok: true, value: v, ...extra }; }
function fail(code, detail) { return { ok: false, code, detail: detail ?? null }; }

function readSessionByHash({ stateDir, identityHash: id }) {
  const sp = path.join(stateDir, 'sessions', `${id}.json`);
  return readSessionRecord(sp);
}

// ---- Validate Merge Prerequisites ------------------------------------------
// Reads the session record and checks all S6 prerequisites (Fail-Closed).
export function validateMergePrerequisites({ sessionPath, stateDir, identityHash: id } = {}) {
  if (typeof sessionPath !== 'string' || !sessionPath) {
    return fail('S6_MISSING_SESSION_PATH', 'sessionPath is required');
  }
  if (typeof stateDir !== 'string' || !stateDir) {
    return fail('S6_MISSING_STATE_DIR', 'stateDir is required');
  }
  if (typeof id !== 'string' || !id) {
    return fail('S6_MISSING_IDENTITY_HASH', 'identityHash is required');
  }

  // Read persisted session
  const rs = readSessionByHash({ stateDir, identityHash: id });
  if (!rs.ok) {
    return fail('S6_SESSION_READ_FAILED', rs.reason);
  }

  const session = rs.session;

  // 1. S5 dispatcher must have run and set PASS branch
  const s5 = session.controlLoop && session.controlLoop.s5Dispatcher;
  if (!s5 || typeof s5 !== 'object') {
    return fail('S6_PREREQUISITE_FAILED', 'S5 dispatcher has not run — no controlLoop.s5Dispatcher in session');
  }

  if (s5.branch !== 'PASS') {
    return fail('S6_PREREQUISITE_FAILED', `S5 branch is ${s5.branch ?? 'undefined'}, expected PASS`);
  }

  if (s5.terminalStatus !== 'READY_FOR_HUMAN_GATE') {
    return fail('S6_PREREQUISITE_FAILED', `S5 terminalStatus is ${s5.terminalStatus ?? 'undefined'}, expected READY_FOR_HUMAN_GATE`);
  }

  // 2. handoffPayload must exist and be valid
  const handoff = s5.handoffPayload;
  if (!handoff || typeof handoff !== 'object') {
    return fail('S6_PREREQUISITE_FAILED', 'handoffPayload is missing or invalid');
  }

  if (handoff.kind !== 'MERGE_HANDOFF') {
    return fail('S6_PREREQUISITE_FAILED', `handoffPayload.kind is ${handoff.kind ?? 'undefined'}, expected MERGE_HANDOFF`);
  }

  if (handoff.handoff && handoff.handoff.requiresHumanApproval !== true) {
    return fail('S6_PREREQUISITE_FAILED', 'handoffPayload.handoff.requiresHumanApproval is not true');
  }

  // 3. Workspace must not be locked
  if (session.controlLoop && session.controlLoop.workspaceLocked === true) {
    return fail('S6_PREREQUISITE_FAILED', 'workspace is locked — cannot proceed with merge gate');
  }

  return ok({
    session,
    handoffPayload: handoff,
    prNumber: session.prNumber || null,
    headSha: session.headSha || null,
    repo: session.repo || null,
    issueNumber: session.issueNumber || null,
  });
}

// ---- Execute Human Decision ------------------------------------------------
// Processes the human decision: APPROVE_AND_MERGE or REJECT_AND_BLOCK.
export function executeHumanDecision({ action, sessionPath, stateDir, identityHash: id, deps = {} } = {}) {
  if (!S6_VALID_ACTIONS.has(action)) {
    return fail('S6_INVALID_ACTION', `action must be one of: ${[...S6_VALID_ACTIONS].join(', ')}`);
  }

  // Validate prerequisites first (Fail-Closed)
  const prereq = validateMergePrerequisites({ sessionPath, stateDir, identityHash: id });
  if (!prereq.ok) return prereq;

  const { session, handoffPayload, prNumber, headSha, repo, issueNumber } = prereq.value;

  // Extract execSync from deps or use default
  const exec = deps.execSync || execSync;

  if (action === 'APPROVE_AND_MERGE') {
    return executeApproveAndMerge({ session, sessionPath, stateDir, identityHash: id, prNumber, headSha, repo, issueNumber, handoffPayload, exec, deps });
  }

  if (action === 'REJECT_AND_BLOCK') {
    return executeRejectAndBlock({ session, sessionPath, stateDir, identityHash: id, prNumber, repo, issueNumber, exec, deps });
  }

  return fail('S6_INVALID_ACTION', `unhandled action: ${action}`);
}

// ---- Approve & Merge -------------------------------------------------------
// Checks PR state + labels on GitHub, merges via squash, updates session record.
function executeApproveAndMerge({ session, sessionPath, stateDir, identityHash: id, prNumber, headSha, repo, issueNumber, handoffPayload, exec, deps }) {
  if (!prNumber) {
    return fail('S6_MERGE_NO_PR', 'no PR number in session — cannot merge');
  }

  // Check PR state and labels via GitHub CLI
  let prState;
  try {
    const prJson = exec(`gh pr view ${prNumber} --json state,labels`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    prState = JSON.parse(prJson);
  } catch (e) {
    return fail('S6_MERGE_PR_VIEW_FAILED', `gh pr view failed: ${String((e && e.message) || e)}`);
  }

  if (!prState || typeof prState !== 'object') {
    return fail('S6_MERGE_PR_VIEW_INVALID', 'gh pr view returned invalid JSON');
  }

  // PR must be OPEN
  if (prState.state !== S6_PR_STATE_OPEN) {
    return fail('S6_MERGE_PR_NOT_OPEN', `PR is in state ${prState.state}, expected OPEN`);
  }

  // Must have status:approved label
  const labels = (prState.labels || []).map(l => typeof l === 'string' ? l : (l.name || ''));
  if (!labels.includes(S6_REQUIRED_LABEL_APPROVE)) {
    return fail('S6_MERGE_MISSING_APPROVED_LABEL', `PR is missing required label "${S6_REQUIRED_LABEL_APPROVE}"`);
  }

  // Execute squash merge
  try {
    exec(`gh pr merge ${prNumber} --squash --delete-branch`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return fail('S6_MERGE_EXEC_FAILED', `gh pr merge failed: ${String((e && e.message) || e)}`);
  }

  // Update session record with merge status
  const now = new Date().toISOString();
  const persisted = updateSessionUnderOwnershipLock(sessionPath, (auth) => {
    auth.controlLoop = auth.controlLoop && typeof auth.controlLoop === 'object' ? auth.controlLoop : {};
    auth.controlLoop.s6HumanGate = {
      schemaVersion: S6_GATE_SCHEMA_VERSION,
      action: 'APPROVE_AND_MERGE',
      status: 'MERGED',
      prNumber,
      headSha,
      mergedAt: now,
    };
    return { session: auth };
  });

  if (!persisted.ok) {
    return fail('S6_MERGE_PERSIST_FAILED', persisted.detail ?? persisted.reason);
  }

  return ok({
    action: 'APPROVE_AND_MERGE',
    status: 'MERGED',
    prNumber,
    headSha,
    mergedAt: now,
  });
}

// ---- Reject & Block --------------------------------------------------------
// Adds status:blocked label to PR and locks workspace.
function executeRejectAndBlock({ session, sessionPath, stateDir, identityHash: id, prNumber, repo, issueNumber, exec, deps }) {
  // Add status:blocked label to PR (if PR exists)
  if (prNumber) {
    try {
      exec(`gh pr edit ${prNumber} --add-label "${S6_REQUIRED_LABEL_BLOCKED}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return fail('S6_REJECT_PR_LABEL_FAILED', `gh pr edit failed: ${String((e && e.message) || e)}`);
    }
  }

  // Lock workspace state
  const lockResult = lockWorkspace({ sessionPath, stateDir, identityHash: id });

  // Update session record
  const now = new Date().toISOString();
  const persisted = updateSessionUnderOwnershipLock(sessionPath, (auth) => {
    auth.controlLoop = auth.controlLoop && typeof auth.controlLoop === 'object' ? auth.controlLoop : {};
    auth.controlLoop.s6HumanGate = {
      schemaVersion: S6_GATE_SCHEMA_VERSION,
      action: 'REJECT_AND_BLOCK',
      status: 'BLOCKED',
      prNumber: prNumber || null,
      blockedAt: now,
    };
    return { session: auth };
  });

  if (!persisted.ok) {
    return fail('S6_REJECT_PERSIST_FAILED', persisted.detail ?? persisted.reason);
  }

  return ok({
    action: 'REJECT_AND_BLOCK',
    status: 'BLOCKED',
    prNumber: prNumber || null,
    blockedAt: now,
    workspaceLocked: lockResult.ok === true,
  });
}

// ---- Workspace Locker ------------------------------------------------------
function lockWorkspace({ sessionPath, stateDir, identityHash: id }) {
  try {
    const persisted = updateSessionUnderOwnershipLock(sessionPath, (auth) => {
      auth.controlLoop = auth.controlLoop && typeof auth.controlLoop === 'object' ? auth.controlLoop : {};
      auth.controlLoop.workspaceLocked = true;
      auth.controlLoop.workspaceLockedAt = new Date().toISOString();
      auth.controlLoop.workspaceLockReason = 'BLOCKED by S6 human gate (REJECT)';
      return { session: auth };
    });

    if (!persisted.ok) {
      return fail('S6_WORKSPACE_LOCK_FAILED', persisted.detail ?? persisted.reason);
    }

    return ok({ locked: true, at: new Date().toISOString() });
  } catch (e) {
    return fail('S6_WORKSPACE_LOCK_ERROR', String((e && e.message) || e));
  }
}

// ---- Main S6 Human Gate Entry Point ----------------------------------------
// Dispatches based on the human action (approve or reject).
export function processHumanGate({ action, sessionPath, stateDir, identityHash: id, deps = {} } = {}) {
  if (!action || !S6_VALID_ACTIONS.has(action)) {
    return fail('S6_INVALID_ACTION', `action must be one of: ${[...S6_VALID_ACTIONS].join(', ')}`);
  }
  return executeHumanDecision({ action, sessionPath, stateDir, identityHash: id, deps });
}

// end of s6-human-gate.mjs
