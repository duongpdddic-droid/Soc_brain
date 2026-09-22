#!/usr/bin/env node
// control-loop-s5-dispatcher.test.mjs — S5 Post-Final-Review Dispatcher tests.
//
// 100% offline/mock: no live HTTP, no live CDP, no live clipboard.
// Covers all 3 branches: PASS, REWORK, BLOCKED.
// Tests:
//   1. PASS branch: READY_FOR_HUMAN_GATE status, merge handoff payload
//   2. REWORK branch: findings packaging, bounded retry counter
//   3. BLOCKED branch: fail-closed halt, blocker alert, workspace lock
//   4. Edge cases: invalid verdicts, missing session, etc.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dispatchPostFinalReview,
  handlePassBranch,
  handleReworkBranch,
  handleBlockedBranch,
  generateMergeHandoffPayload,
  emitBlockerAlert,
  lockWorkspaceState,
  MAX_REWORK_RETRY_COUNTER,
  S5_DISPATCH_SCHEMA_VERSION,
} from '../packages/control-loop/s5-dispatcher.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { updateSessionUnderOwnershipLock, readSessionRecord } from '../packages/runtime-sandbox/runtime-sandbox.mjs';

// ---- helpers ----------------------------------------------------------------
function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 's5disp-')); }

const HEAD = 'a'.repeat(40);
const PR_NUMBER = 78;
const REPO = 'duongpdddic-droid/soc_brain';
const ISSUE = 77;

function mkSession(stateDir, overrides = {}) {
  const id = identityHash({ repo: REPO, issueNumber: ISSUE });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1',
    state: 'SESSION_ACTIVE',
    lifecycle: [],
    taskId: `${REPO}#${ISSUE}`,
    repo: REPO,
    issueNumber: ISSUE,
    prNumber: PR_NUMBER,
    headSha: HEAD,
    baseSha: 'f'.repeat(40),
    worktreePath: path.join(stateDir, `wt-issue-${ISSUE}`),
    worktreesRoot: stateDir,
    controlPlane: { stateDir },
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session, id };
}

function mkPacket(stateDir, session) {
  const dir = path.join(stateDir, 'review-ready');
  fs.mkdirSync(dir, { recursive: true });
  const slug = String(session.repo).replace(/\//g, '_');
  const name = `${slug}_Issue-${session.issueNumber}_PR-${PR_NUMBER}_abcdef0_review-ready.md`;
  const content = [
    `# Review Ready — ${session.repo} Issue #${session.issueNumber} · PR #${PR_NUMBER}`,
    '',
    '## Identity',
    `- repository: ${session.repo}`,
    `- issue: ${session.issueNumber}`,
    `- pullRequest: ${PR_NUMBER}`,
    '- branch: agent/test',
    `- headSha: ${HEAD} (short ${HEAD.slice(0, 7)})`,
    `- baseSha: ${'b'.repeat(40)}`,
    '- prState: OPEN',
    '',
    'Canonical packet body for semantic final review.',
  ].join('\n');
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
  return { dir, name, content };
}

// ---- 1. PASS Branch Tests --------------------------------------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, session, id } = mkSession(stateDir);
  mkPacket(stateDir, session);

  // Mock the result from runControlLoop for PASS branch
  const passResult = {
    state: 'COMPLETED',
    notification: { status: 'API_ACCEPTED', messageId: 901 },
    delivery: { shipped: true, cleanup: { worktreeRemoved: true } },
    terminalize: { ok: true },
  };

  const s5Result = dispatchPostFinalReview({
    result: passResult,
    sessionPath,
    stateDir,
    identityHash: id,
  });

  assert.equal(s5Result.ok, true, 'S5-1a: PASS branch dispatch succeeds');
  assert.equal(s5Result.value.branch, 'PASS', 'S5-1b: branch is PASS');
  assert.equal(s5Result.value.terminalStatus, 'READY_FOR_HUMAN_GATE', 'S5-1c: terminal status is READY_FOR_HUMAN_GATE');
  assert.equal(s5Result.value.prNumber, PR_NUMBER, 'S5-1d: PR number preserved');
  assert.equal(s5Result.value.headSha, HEAD, 'S5-1e: headSha preserved');
  assert.equal(s5Result.value.repo, REPO, 'S5-1f: repo preserved');
  assert.equal(s5Result.value.issueNumber, ISSUE, 'S5-1g: issueNumber preserved');

  // Verify handoff payload structure
  const handoff = s5Result.value.handoffPayload;
  assert.equal(handoff.schemaVersion, S5_DISPATCH_SCHEMA_VERSION, 'S5-1h: handoff payload schema version');
  assert.equal(handoff.kind, 'MERGE_HANDOFF', 'S5-1i: handoff kind is MERGE_HANDOFF');
  assert.equal(handoff.identity.repository, REPO, 'S5-1j: handoff identity repository');
  assert.equal(handoff.identity.issue, ISSUE, 'S5-1k: handoff identity issue');
  assert.equal(handoff.identity.pullRequest, PR_NUMBER, 'S5-1l: handoff identity pullRequest');
  assert.equal(handoff.identity.headSha, HEAD, 'S5-1m: handoff identity headSha');
  assert.equal(handoff.terminalStatus, 'READY_FOR_HUMAN_GATE', 'S5-1n: handoff terminal status');
  assert.equal(handoff.handoff.prLink, `https://github.com/${REPO}/pull/${PR_NUMBER}`, 'S5-1o: handoff PR link');
  assert.equal(handoff.handoff.readyForMerge, true, 'S5-1p: handoff ready for merge');
  assert.equal(handoff.handoff.requiresHumanApproval, true, 'S5-1q: handoff requires human approval');

  // Verify session persistence
  const rs = readSessionRecord(sessionPath);
  assert.equal(rs.ok, true, 'S5-1r: session readable after PASS dispatch');
  assert.equal(rs.session.controlLoop.s5Dispatcher.branch, 'PASS', 'S5-1s: session persisted PASS branch');
  assert.equal(rs.session.controlLoop.s5Dispatcher.terminalStatus, 'READY_FOR_HUMAN_GATE', 'S5-1t: session persisted READY_FOR_HUMAN_GATE');
}

// ---- 2. REWORK Branch Tests ------------------------------------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, session, id } = mkSession(stateDir);
  mkPacket(stateDir, session);

  // Mock the result from runControlLoop for REWORK branch
  const reworkResult = {
    state: 'REWORK',
    findings: ['fix-x', 'fix-y'],
    evidenceRequests: ['show diff D'],
    decision: { verdict: 'REWORK', findings: ['fix-x', 'fix-y'] },
  };

  const s5Result = dispatchPostFinalReview({
    result: reworkResult,
    sessionPath,
    stateDir,
    identityHash: id,
  });

  assert.equal(s5Result.ok, true, 'S5-2a: REWORK branch dispatch succeeds');
  assert.equal(s5Result.value.branch, 'REWORK', 'S5-2b: branch is REWORK');
  assert.equal(s5Result.value.terminalStatus, 'READY_FOR_REDISPATCH', 'S5-2c: terminal status is READY_FOR_REDISPATCH');
  assert.equal(s5Result.value.retryCounter, 1, 'S5-2d: retry counter incremented to 1');
  assert.equal(s5Result.value.maxRetries, MAX_REWORK_RETRY_COUNTER, 'S5-2e: max retries preserved');
  assert.deepEqual(s5Result.value.findings, ['fix-x', 'fix-y'], 'S5-2f: findings preserved');
  assert.deepEqual(s5Result.value.evidenceRequests, ['show diff D'], 'S5-2g: evidenceRequests preserved');

  // Verify session persistence
  const rs = readSessionRecord(sessionPath);
  assert.equal(rs.ok, true, 'S5-2h: session readable after REWORK dispatch');
  assert.equal(rs.session.controlLoop.s5Dispatcher.branch, 'REWORK', 'S5-2i: session persisted REWORK branch');
  assert.equal(rs.session.controlLoop.s5Dispatcher.retryCounter, 1, 'S5-2j: session persisted retry counter');
}

// ---- 3. REWORK Branch with Bounded Retry Counter ---------------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, session, id } = mkSession(stateDir, {
    controlLoop: {
      s5Dispatcher: {
        retryCounter: MAX_REWORK_RETRY_COUNTER,
      },
    },
  });
  mkPacket(stateDir, session);

  // Mock the result from runControlLoop for REWORK branch
  const reworkResult = {
    state: 'REWORK',
    findings: ['fix-x'],
    evidenceRequests: ['show test X'],
    decision: { verdict: 'REWORK', findings: ['fix-x'] },
  };

  const s5Result = dispatchPostFinalReview({
    result: reworkResult,
    sessionPath,
    stateDir,
    identityHash: id,
  });

  assert.equal(s5Result.ok, true, 'S5-3a: REWORK budget exhausted dispatch succeeds');
  assert.equal(s5Result.value.branch, 'BLOCKED', 'S5-3b: branch escalated to BLOCKED');
  assert.equal(s5Result.value.terminalStatus, 'REWORK_BUDGET_EXHAUSTED', 'S5-3c: terminal status is REWORK_BUDGET_EXHAUSTED');
  assert.equal(s5Result.value.retryCounter, MAX_REWORK_RETRY_COUNTER, 'S5-3d: retry counter shows exhausted budget');
  assert.equal(s5Result.value.maxRetries, MAX_REWORK_RETRY_COUNTER, 'S5-3e: max retries preserved');
}

// ---- 4. BLOCKED Branch Tests -----------------------------------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, session, id } = mkSession(stateDir);
  mkPacket(stateDir, session);

  // Mock the result from runControlLoop for BLOCKED branch
  const blockedResult = {
    state: 'BLOCKED',
    findings: ['security vulnerability found'],
    evidenceRequests: ['review security audit'],
    decision: { verdict: 'BLOCKED', findings: ['security vulnerability found'] },
  };

  const s5Result = dispatchPostFinalReview({
    result: blockedResult,
    sessionPath,
    stateDir,
    identityHash: id,
  });

  assert.equal(s5Result.ok, true, 'S5-4a: BLOCKED branch dispatch succeeds');
  assert.equal(s5Result.value.branch, 'BLOCKED', 'S5-4b: branch is BLOCKED');
  assert.equal(s5Result.value.terminalStatus, 'BLOCKED', 'S5-4c: terminal status is BLOCKED');
  assert.equal(s5Result.value.workspaceLocked, true, 'S5-4d: workspace is locked');
  assert.deepEqual(s5Result.value.findings, ['security vulnerability found'], 'S5-4e: findings preserved');
  assert.deepEqual(s5Result.value.evidenceRequests, ['review security audit'], 'S5-4f: evidenceRequests preserved');

  // Verify blocker alert structure
  const alert = s5Result.value.blockerAlert;
  assert.equal(alert.schemaVersion, S5_DISPATCH_SCHEMA_VERSION, 'S5-4g: blocker alert schema version');
  assert.equal(alert.kind, 'BLOCKER_ALERT', 'S5-4h: blocker alert kind');
  assert.equal(alert.identity.repository, REPO, 'S5-4i: blocker alert identity repository');
  assert.equal(alert.identity.issue, ISSUE, 'S5-4j: blocker alert identity issue');
  assert.equal(alert.identity.headSha, HEAD, 'S5-4k: blocker alert identity headSha');
  assert.deepEqual(alert.blocker.findings, ['security vulnerability found'], 'S5-4l: blocker alert findings');
  assert.equal(alert.metadata.severity, 'HIGH', 'S5-4m: blocker alert severity');
  assert.equal(alert.metadata.requiresImmediateAttention, true, 'S5-4n: blocker alert requires attention');

  // Verify session persistence
  const rs = readSessionRecord(sessionPath);
  assert.equal(rs.ok, true, 'S5-4o: session readable after BLOCKED dispatch');
  assert.equal(rs.session.controlLoop.s5Dispatcher.branch, 'BLOCKED', 'S5-4p: session persisted BLOCKED branch');
  assert.equal(rs.session.controlLoop.workspaceLocked, true, 'S5-4q: session persisted workspace lock');
}

// ---- 5. Edge Case: Invalid Result ------------------------------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);

  // Invalid result: null
  const s5ResultNull = dispatchPostFinalReview({
    result: null,
    sessionPath,
    stateDir,
    identityHash: id,
  });
  assert.equal(s5ResultNull.ok, false, 'S5-5a: null result fails');
  assert.equal(s5ResultNull.code, 'S5_DISPATCH_INVALID_RESULT', 'S5-5b: null result error code');

  // Invalid result: undefined
  const s5ResultUndef = dispatchPostFinalReview({
    result: undefined,
    sessionPath,
    stateDir,
    identityHash: id,
  });
  assert.equal(s5ResultUndef.ok, false, 'S5-5c: undefined result fails');

  // Invalid result: string
  const s5ResultStr = dispatchPostFinalReview({
    result: 'COMPLETED',
    sessionPath,
    stateDir,
    identityHash: id,
  });
  assert.equal(s5ResultStr.ok, false, 'S5-5d: string result fails');
}

// ---- 6. Edge Case: Missing Session Path ------------------------------------
{
  const stateDir = mkStateDir();
  const { id } = mkSession(stateDir);

  const s5Result = dispatchPostFinalReview({
    result: { state: 'COMPLETED' },
    sessionPath: null,
    stateDir,
    identityHash: id,
  });
  assert.equal(s5Result.ok, false, 'S5-6a: missing sessionPath fails');
  assert.equal(s5Result.code, 'S5_DISPATCH_MISSING_SESSION_PATH', 'S5-6b: missing sessionPath error code');
}

// ---- 7. Edge Case: Missing Identity Hash -----------------------------------
{
  const stateDir = mkStateDir();
  const { sessionPath } = mkSession(stateDir);

  const s5Result = dispatchPostFinalReview({
    result: { state: 'COMPLETED' },
    sessionPath,
    stateDir,
    identityHash: null,
  });
  assert.equal(s5Result.ok, false, 'S5-7a: missing identityHash fails');
  assert.equal(s5Result.code, 'S5_DISPATCH_MISSING_IDENTITY_HASH', 'S5-7b: missing identityHash error code');
}

// ---- 8. Edge Case: Missing State Dir ---------------------------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);

  const s5Result = dispatchPostFinalReview({
    result: { state: 'COMPLETED' },
    sessionPath,
    stateDir: null,
    identityHash: id,
  });
  assert.equal(s5Result.ok, false, 'S5-8a: missing stateDir fails');
  assert.equal(s5Result.code, 'S5_DISPATCH_MISSING_STATE_DIR', 'S5-8b: missing stateDir error code');
}

// ---- 9. Edge Case: Unknown State -------------------------------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);

  const s5Result = dispatchPostFinalReview({
    result: { state: 'UNKNOWN' },
    sessionPath,
    stateDir,
    identityHash: id,
  });
  assert.equal(s5Result.ok, false, 'S5-9a: unknown state fails');
  assert.equal(s5Result.code, 'S5_DISPATCH_UNKNOWN_STATE', 'S5-9b: unknown state error code');
}

// ---- 10. generateMergeHandoffPayload Unit Tests ----------------------------
{
  const session = { repo: REPO, issueNumber: ISSUE, prNumber: PR_NUMBER, headSha: HEAD };
  const handoff = generateMergeHandoffPayload({
    session,
    prNumber: PR_NUMBER,
    headSha: HEAD,
    repo: REPO,
    issueNumber: ISSUE,
    terminalStatus: 'READY_FOR_HUMAN_GATE',
    decision: { verdict: 'PASS' },
  });

  assert.equal(handoff.schemaVersion, S5_DISPATCH_SCHEMA_VERSION, 'S5-10a: handoff schema version');
  assert.equal(handoff.kind, 'MERGE_HANDOFF', 'S5-10b: handoff kind');
  assert.equal(handoff.identity.repository, REPO, 'S5-10c: handoff repository');
  assert.equal(handoff.identity.issue, ISSUE, 'S5-10d: handoff issue');
  assert.equal(handoff.identity.pullRequest, PR_NUMBER, 'S5-10e: handoff pullRequest');
  assert.equal(handoff.identity.headSha, HEAD, 'S5-10f: handoff headSha');
  assert.equal(handoff.handoff.prLink, `https://github.com/${REPO}/pull/${PR_NUMBER}`, 'S5-10g: handoff PR link');
  assert.equal(handoff.handoff.readyForMerge, true, 'S5-10h: handoff ready for merge');
  assert.equal(handoff.handoff.requiresHumanApproval, true, 'S5-10i: handoff requires human approval');
  assert.deepEqual(handoff.handoff.decision, { verdict: 'PASS' }, 'S5-10j: handoff decision');
}

// ---- 11. emitBlockerAlert Unit Tests ---------------------------------------
{
  const session = { repo: REPO, issueNumber: ISSUE, headSha: HEAD };
  const alert = emitBlockerAlert({
    session,
    findings: ['security issue'],
    evidenceRequests: ['review audit'],
    decision: { verdict: 'BLOCKED', findings: ['security issue'] },
  });

  assert.equal(alert.schemaVersion, S5_DISPATCH_SCHEMA_VERSION, 'S5-11a: alert schema version');
  assert.equal(alert.kind, 'BLOCKER_ALERT', 'S5-11b: alert kind');
  assert.equal(alert.identity.repository, REPO, 'S5-11c: alert repository');
  assert.equal(alert.identity.issue, ISSUE, 'S5-11d: alert issue');
  assert.equal(alert.identity.headSha, HEAD, 'S5-11e: alert headSha');
  assert.deepEqual(alert.blocker.findings, ['security issue'], 'S5-11f: alert findings');
  assert.deepEqual(alert.blocker.evidenceRequests, ['review audit'], 'S5-11g: alert evidenceRequests');
  assert.equal(alert.metadata.severity, 'HIGH', 'S5-11h: alert severity');
  assert.equal(alert.metadata.requiresImmediateAttention, true, 'S5-11i: alert requires attention');
}

// ---- 12. lockWorkspaceState Unit Tests --------------------------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);

  const lockResult = lockWorkspaceState({
    sessionPath,
    stateDir,
    identityHash: id,
  });

  assert.equal(lockResult.ok, true, 'S5-12a: workspace lock succeeds');
  assert.equal(lockResult.value.locked, true, 'S5-12b: workspace is locked');

  // Verify session persistence
  const rs = readSessionRecord(sessionPath);
  assert.equal(rs.ok, true, 'S5-12c: session readable after lock');
  assert.equal(rs.session.controlLoop.workspaceLocked, true, 'S5-12d: session persisted workspace lock');
  assert.equal(typeof rs.session.controlLoop.workspaceLockedAt, 'string', 'S5-12e: session persisted lock timestamp');
  assert.equal(rs.session.controlLoop.workspaceLockReason, 'BLOCKED by S5 dispatcher', 'S5-12f: session persisted lock reason');
}

// ---- 13. REWORK Branch with Multiple Retries -------------------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, session, id } = mkSession(stateDir, {
    controlLoop: {
      s5Dispatcher: {
        retryCounter: 2,
      },
    },
  });
  mkPacket(stateDir, session);

  // Mock the result from runControlLoop for REWORK branch
  const reworkResult = {
    state: 'REWORK',
    findings: ['fix-z'],
    evidenceRequests: ['show test Z'],
    decision: { verdict: 'REWORK', findings: ['fix-z'] },
  };

  const s5Result = dispatchPostFinalReview({
    result: reworkResult,
    sessionPath,
    stateDir,
    identityHash: id,
  });

  assert.equal(s5Result.ok, true, 'S5-13a: REWORK with retries succeeds');
  assert.equal(s5Result.value.branch, 'REWORK', 'S5-13b: branch is REWORK');
  assert.equal(s5Result.value.retryCounter, 3, 'S5-13c: retry counter incremented to 3');
  assert.equal(s5Result.value.maxRetries, MAX_REWORK_RETRY_COUNTER, 'S5-13d: max retries preserved');
}

// ---- 14. PASS Branch with No PR Number ------------------------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, session, id } = mkSession(stateDir, { prNumber: null });
  mkPacket(stateDir, session);

  // Mock the result from runControlLoop for PASS branch
  const passResult = {
    state: 'COMPLETED',
    notification: { status: 'API_ACCEPTED', messageId: 902 },
    delivery: { shipped: true },
  };

  const s5Result = dispatchPostFinalReview({
    result: passResult,
    sessionPath,
    stateDir,
    identityHash: id,
  });

  assert.equal(s5Result.ok, true, 'S5-14a: PASS branch with no PR succeeds');
  assert.equal(s5Result.value.branch, 'PASS', 'S5-14b: branch is PASS');
  assert.equal(s5Result.value.prNumber, null, 'S5-14c: PR number is null');
  assert.equal(s5Result.value.handoffPayload.identity.pullRequest, null, 'S5-14d: handoff PR is null');
  assert.equal(s5Result.value.handoffPayload.handoff.prLink, null, 'S5-14e: handoff PR link is null');
  assert.equal(s5Result.value.handoffPayload.handoff.readyForMerge, true, 'S5-14f: handoff ready for merge');
}

// ---- 15. BLOCKED Branch with No Findings -----------------------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, session, id } = mkSession(stateDir);
  mkPacket(stateDir, session);

  // Mock the result from runControlLoop for BLOCKED branch with no findings
  const blockedResult = {
    state: 'BLOCKED',
    findings: [],
    evidenceRequests: [],
    decision: { verdict: 'BLOCKED' },
  };

  const s5Result = dispatchPostFinalReview({
    result: blockedResult,
    sessionPath,
    stateDir,
    identityHash: id,
  });

  assert.equal(s5Result.ok, true, 'S5-15a: BLOCKED branch with no findings succeeds');
  assert.equal(s5Result.value.branch, 'BLOCKED', 'S5-15b: branch is BLOCKED');
  assert.deepEqual(s5Result.value.findings, [], 'S5-15c: findings is empty array');
  assert.deepEqual(s5Result.value.evidenceRequests, [], 'S5-15d: evidenceRequests is empty array');
  assert.equal(s5Result.value.blockerAlert.blocker.findings.length, 0, 'S5-15e: blocker alert findings is empty');
}

// ---- summary -----------------------------------------------------------------
console.log('control-loop-s5-dispatcher: all checks passed');
process.exit(0);
