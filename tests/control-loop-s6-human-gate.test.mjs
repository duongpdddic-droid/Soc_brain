#!/usr/bin/env node
// control-loop-s6-human-gate.test.mjs — S6 Human Merge Gate tests.
//
// 100% offline/mock: no live HTTP, no live CDP, no live clipboard, no live gh.
// Covers: prerequisites validation, approve & merge, reject & block,
//         fail-closed error handling, edge cases.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateMergePrerequisites,
  executeHumanDecision,
  processHumanGate,
  S6_GATE_SCHEMA_VERSION,
  S6_VALID_ACTIONS,
} from '../packages/control-loop/s6-human-gate.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { updateSessionUnderOwnershipLock, readSessionRecord } from '../packages/runtime-sandbox/runtime-sandbox.mjs';

// ---- helpers ----------------------------------------------------------------
function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 's6gate-')); }

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
    controlLoop: {
      s5Dispatcher: {
        schemaVersion: '1',
        branch: 'PASS',
        terminalStatus: 'READY_FOR_HUMAN_GATE',
        handoffPayload: {
          schemaVersion: '1',
          kind: 'MERGE_HANDOFF',
          identity: {
            repository: REPO,
            issue: ISSUE,
            pullRequest: PR_NUMBER,
            headSha: HEAD,
          },
          terminalStatus: 'READY_FOR_HUMAN_GATE',
          handoff: {
            prLink: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
            readyForMerge: true,
            requiresHumanApproval: true,
            decision: { verdict: 'PASS' },
          },
          metadata: {
            generatedAt: new Date().toISOString(),
            schemaVersion: '1',
          },
        },
        dispatchedAt: new Date().toISOString(),
      },
    },
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session, id };
}

function mkExecSync(prState) {
  return (cmd, opts) => {
    if (cmd.startsWith('gh pr view')) {
      return JSON.stringify(prState);
    }
    if (cmd.startsWith('gh pr merge') || cmd.startsWith('gh pr edit')) {
      return '';
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
}

function mkExecSyncFailing(errMsg) {
  return (cmd, opts) => { throw new Error(errMsg); };
}

// ---- 1. Prerequisites Validation: PASS ------------------------------------
// Valid session with S5 PASS branch, READY_FOR_HUMAN_GATE, valid handoffPayload.
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);

  const result = validateMergePrerequisites({ sessionPath, stateDir, identityHash: id });

  assert.equal(result.ok, true, 'S6-1a: valid prerequisites pass');
  assert.equal(result.value.session.repo, REPO, 'S6-1b: session repo preserved');
  assert.equal(result.value.handoffPayload.kind, 'MERGE_HANDOFF', 'S6-1c: handoffPayload kind');
  assert.equal(result.value.handoffPayload.handoff.requiresHumanApproval, true, 'S6-1d: requiresHumanApproval');
  assert.equal(result.value.prNumber, PR_NUMBER, 'S6-1e: prNumber extracted');
  assert.equal(result.value.headSha, HEAD, 'S6-1f: headSha extracted');
}

// ---- 2. Prerequisites Validation: FAIL — Missing sessionPath ---------------
{
  const stateDir = mkStateDir();
  const { id } = mkSession(stateDir);

  const result = validateMergePrerequisites({ sessionPath: null, stateDir, identityHash: id });
  assert.equal(result.ok, false, 'S6-2a: null sessionPath fails');
  assert.equal(result.code, 'S6_MISSING_SESSION_PATH', 'S6-2b: correct error code');
}

// ---- 3. Prerequisites Validation: FAIL — Missing stateDir ------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);

  const result = validateMergePrerequisites({ sessionPath, stateDir: null, identityHash: id });
  assert.equal(result.ok, false, 'S6-3a: null stateDir fails');
  assert.equal(result.code, 'S6_MISSING_STATE_DIR', 'S6-3b: correct error code');
}

// ---- 4. Prerequisites Validation: FAIL — Missing identityHash --------------
{
  const stateDir = mkStateDir();
  const { sessionPath } = mkSession(stateDir);

  const result = validateMergePrerequisites({ sessionPath, stateDir, identityHash: null });
  assert.equal(result.ok, false, 'S6-4a: null identityHash fails');
  assert.equal(result.code, 'S6_MISSING_IDENTITY_HASH', 'S6-4b: correct error code');
}

// ---- 5. Prerequisites Validation: FAIL — S5 branch is BLOCKED --------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir, {
    controlLoop: {
      s5Dispatcher: {
        schemaVersion: '1',
        branch: 'BLOCKED',
        terminalStatus: 'BLOCKED',
        dispatchedAt: new Date().toISOString(),
      },
    },
  });

  const result = validateMergePrerequisites({ sessionPath, stateDir, identityHash: id });
  assert.equal(result.ok, false, 'S6-5a: BLOCKED branch fails');
  assert.equal(result.code, 'S6_PREREQUISITE_FAILED', 'S6-5b: correct error code');
  assert.ok(result.detail.includes('PASS'), 'S6-5c: detail mentions expected PASS');
}

// ---- 6. Prerequisites Validation: FAIL — No S5 dispatcher ------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir, {
    controlLoop: {},
  });

  const result = validateMergePrerequisites({ sessionPath, stateDir, identityHash: id });
  assert.equal(result.ok, false, 'S6-6a: no s5Dispatcher fails');
  assert.equal(result.code, 'S6_PREREQUISITE_FAILED', 'S6-6b: correct error code');
}

// ---- 7. Prerequisites Validation: FAIL — Missing handoffPayload ------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir, {
    controlLoop: {
      s5Dispatcher: {
        schemaVersion: '1',
        branch: 'PASS',
        terminalStatus: 'READY_FOR_HUMAN_GATE',
        dispatchedAt: new Date().toISOString(),
      },
    },
  });

  const result = validateMergePrerequisites({ sessionPath, stateDir, identityHash: id });
  assert.equal(result.ok, false, 'S6-7a: missing handoffPayload fails');
  assert.equal(result.code, 'S6_PREREQUISITE_FAILED', 'S6-7b: correct error code');
}

// ---- 8. Prerequisites Validation: FAIL — Wrong handoffPayload kind ----------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir, {
    controlLoop: {
      s5Dispatcher: {
        schemaVersion: '1',
        branch: 'PASS',
        terminalStatus: 'READY_FOR_HUMAN_GATE',
        handoffPayload: {
          schemaVersion: '1',
          kind: 'WRONG_KIND',
          handoff: { requiresHumanApproval: true },
        },
        dispatchedAt: new Date().toISOString(),
      },
    },
  });

  const result = validateMergePrerequisites({ sessionPath, stateDir, identityHash: id });
  assert.equal(result.ok, false, 'S6-8a: wrong handoffPayload kind fails');
  assert.equal(result.code, 'S6_PREREQUISITE_FAILED', 'S6-8b: correct error code');
}

// ---- 9. Prerequisites Validation: FAIL — Workspace locked ------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir, {
    controlLoop: {
      s5Dispatcher: {
        schemaVersion: '1',
        branch: 'PASS',
        terminalStatus: 'READY_FOR_HUMAN_GATE',
        handoffPayload: {
          schemaVersion: '1',
          kind: 'MERGE_HANDOFF',
          handoff: { requiresHumanApproval: true },
        },
        dispatchedAt: new Date().toISOString(),
      },
      workspaceLocked: true,
      workspaceLockedAt: new Date().toISOString(),
      workspaceLockReason: 'BLOCKED by S5 dispatcher',
    },
  });

  const result = validateMergePrerequisites({ sessionPath, stateDir, identityHash: id });
  assert.equal(result.ok, false, 'S6-9a: locked workspace fails');
  assert.equal(result.code, 'S6_PREREQUISITE_FAILED', 'S6-9b: correct error code');
}

// ---- 10. Prerequisites Validation: FAIL — requiresHumanApproval is false ----
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir, {
    controlLoop: {
      s5Dispatcher: {
        schemaVersion: '1',
        branch: 'PASS',
        terminalStatus: 'READY_FOR_HUMAN_GATE',
        handoffPayload: {
          schemaVersion: '1',
          kind: 'MERGE_HANDOFF',
          handoff: { requiresHumanApproval: false },
        },
        dispatchedAt: new Date().toISOString(),
      },
    },
  });

  const result = validateMergePrerequisites({ sessionPath, stateDir, identityHash: id });
  assert.equal(result.ok, false, 'S6-10a: requiresHumanApproval=false fails');
  assert.equal(result.code, 'S6_PREREQUISITE_FAILED', 'S6-10b: correct error code');
}

// ---- 11. Approve & Merge: Success -----------------------------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);

  const prState = {
    state: 'OPEN',
    labels: [{ name: 'status:approved' }, { name: 'status:in-progress' }],
  };

  const result = executeHumanDecision({
    action: 'APPROVE_AND_MERGE',
    sessionPath,
    stateDir,
    identityHash: id,
    deps: { execSync: mkExecSync(prState) },
  });

  assert.equal(result.ok, true, 'S6-11a: approve & merge succeeds');
  assert.equal(result.value.action, 'APPROVE_AND_MERGE', 'S6-11b: action recorded');
  assert.equal(result.value.status, 'MERGED', 'S6-11c: status is MERGED');
  assert.equal(result.value.prNumber, PR_NUMBER, 'S6-11d: PR number preserved');
  assert.equal(result.value.headSha, HEAD, 'S6-11e: headSha preserved');
  assert.equal(typeof result.value.mergedAt, 'string', 'S6-11f: mergedAt timestamp');

  // Verify session persistence
  const rs = readSessionRecord(sessionPath);
  assert.equal(rs.ok, true, 'S6-11g: session readable after merge');
  assert.equal(rs.session.controlLoop.s6HumanGate.status, 'MERGED', 'S6-11h: session persisted MERGED');
  assert.equal(rs.session.controlLoop.s6HumanGate.action, 'APPROVE_AND_MERGE', 'S6-11i: session persisted action');
  assert.equal(typeof rs.session.controlLoop.s6HumanGate.mergedAt, 'string', 'S6-11j: session persisted mergedAt');
}

// ---- 12. Approve & Merge: FAIL — PR not OPEN (CLOSED) ---------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);

  const prState = {
    state: 'CLOSED',
    labels: [{ name: 'status:approved' }],
  };

  const result = executeHumanDecision({
    action: 'APPROVE_AND_MERGE',
    sessionPath,
    stateDir,
    identityHash: id,
    deps: { execSync: mkExecSync(prState) },
  });

  assert.equal(result.ok, false, 'S6-12a: merge with closed PR fails');
  assert.equal(result.code, 'S6_MERGE_PR_NOT_OPEN', 'S6-12b: correct error code');
  assert.ok(result.detail.includes('CLOSED'), 'S6-12c: detail mentions CLOSED state');
}

// ---- 13. Approve & Merge: FAIL — Missing status:approved label -------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);

  const prState = {
    state: 'OPEN',
    labels: [{ name: 'status:in-progress' }],
  };

  const result = executeHumanDecision({
    action: 'APPROVE_AND_MERGE',
    sessionPath,
    stateDir,
    identityHash: id,
    deps: { execSync: mkExecSync(prState) },
  });

  assert.equal(result.ok, false, 'S6-13a: merge without approved label fails');
  assert.equal(result.code, 'S6_MERGE_MISSING_APPROVED_LABEL', 'S6-13b: correct error code');
}

// ---- 14. Approve & Merge: FAIL — No PR number in session -------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir, { prNumber: null });

  const result = executeHumanDecision({
    action: 'APPROVE_AND_MERGE',
    sessionPath,
    stateDir,
    identityHash: id,
    deps: { execSync: mkExecSync({}) },
  });

  assert.equal(result.ok, false, 'S6-14a: merge without PR number fails');
  assert.equal(result.code, 'S6_MERGE_NO_PR', 'S6-14b: correct error code');
}

// ---- 15. Approve & Merge: FAIL — gh pr view command fails ------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);

  const result = executeHumanDecision({
    action: 'APPROVE_AND_MERGE',
    sessionPath,
    stateDir,
    identityHash: id,
    deps: { execSync: mkExecSyncFailing('gh: command not found') },
  });

  assert.equal(result.ok, false, 'S6-15a: gh pr view failure propagates');
  assert.equal(result.code, 'S6_MERGE_PR_VIEW_FAILED', 'S6-15b: correct error code');
}

// ---- 16. Approve & Merge: FAIL — gh pr merge command fails -----------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);

  const prState = {
    state: 'OPEN',
    labels: [{ name: 'status:approved' }],
  };

  let callCount = 0;
  const execThatFailsOnMerge = (cmd, opts) => {
    if (cmd.startsWith('gh pr view')) return JSON.stringify(prState);
    if (cmd.startsWith('gh pr merge')) throw new Error('merge conflict');
    return '';
  };

  const result = executeHumanDecision({
    action: 'APPROVE_AND_MERGE',
    sessionPath,
    stateDir,
    identityHash: id,
    deps: { execSync: execThatFailsOnMerge },
  });

  assert.equal(result.ok, false, 'S6-16a: gh pr merge failure propagates');
  assert.equal(result.code, 'S6_MERGE_EXEC_FAILED', 'S6-16b: correct error code');
}

// ---- 17. Reject & Block: Success ------------------------------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);

  const edits = [];
  const mockExec = (cmd, opts) => {
    if (cmd.startsWith('gh pr edit')) { edits.push(cmd); return ''; }
    return '';
  };

  const result = executeHumanDecision({
    action: 'REJECT_AND_BLOCK',
    sessionPath,
    stateDir,
    identityHash: id,
    deps: { execSync: mockExec },
  });

  assert.equal(result.ok, true, 'S6-17a: reject & block succeeds');
  assert.equal(result.value.action, 'REJECT_AND_BLOCK', 'S6-17b: action recorded');
  assert.equal(result.value.status, 'BLOCKED', 'S6-17c: status is BLOCKED');
  assert.equal(result.value.prNumber, PR_NUMBER, 'S6-17d: PR number preserved');
  assert.equal(typeof result.value.blockedAt, 'string', 'S6-17e: blockedAt timestamp');
  assert.equal(result.value.workspaceLocked, true, 'S6-17f: workspace is locked');
  assert.equal(edits.length, 1, 'S6-17g: gh pr edit called once');
  assert.ok(edits[0].includes('status:blocked'), 'S6-17h: correct label added');

  // Verify session persistence
  const rs = readSessionRecord(sessionPath);
  assert.equal(rs.ok, true, 'S6-17i: session readable after reject');
  assert.equal(rs.session.controlLoop.s6HumanGate.status, 'BLOCKED', 'S6-17j: session persisted BLOCKED');
  assert.equal(rs.session.controlLoop.s6HumanGate.action, 'REJECT_AND_BLOCK', 'S6-17k: session persisted action');
  assert.equal(rs.session.controlLoop.workspaceLocked, true, 'S6-17l: workspace lock persisted');
}

// ---- 18. Reject & Block: FAIL — gh pr edit command fails -------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);

  const result = executeHumanDecision({
    action: 'REJECT_AND_BLOCK',
    sessionPath,
    stateDir,
    identityHash: id,
    deps: { execSync: mkExecSyncFailing('gh: not authenticated') },
  });

  assert.equal(result.ok, false, 'S6-18a: gh pr edit failure propagates');
  assert.equal(result.code, 'S6_REJECT_PR_LABEL_FAILED', 'S6-18b: correct error code');
}

// ---- 19. Invalid Action ---------------------------------------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);

  const result = executeHumanDecision({
    action: 'INVALID_ACTION',
    sessionPath,
    stateDir,
    identityHash: id,
    deps: { execSync: mkExecSync({}) },
  });

  assert.equal(result.ok, false, 'S6-19a: invalid action fails');
  assert.equal(result.code, 'S6_INVALID_ACTION', 'S6-19b: correct error code');
}

// ---- 20. processHumanGate: invalid action ----------------------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);

  const result = processHumanGate({
    action: 'WRONG',
    sessionPath,
    stateDir,
    identityHash: id,
  });

  assert.equal(result.ok, false, 'S6-20a: processHumanGate with bad action fails');
  assert.equal(result.code, 'S6_INVALID_ACTION', 'S6-20b: correct error code');
}

// ---- 21. Approve & Merge: PR state MERGED (already merged) ----------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);

  const prState = {
    state: 'MERGED',
    labels: [{ name: 'status:approved' }],
  };

  const result = executeHumanDecision({
    action: 'APPROVE_AND_MERGE',
    sessionPath,
    stateDir,
    identityHash: id,
    deps: { execSync: mkExecSync(prState) },
  });

  assert.equal(result.ok, false, 'S6-21a: merge with already-merged PR fails');
  assert.equal(result.code, 'S6_MERGE_PR_NOT_OPEN', 'S6-21b: correct error code');
}

// ---- 22. Approve & Merge: Multiple labels, only status:approved needed -----
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);

  const prState = {
    state: 'OPEN',
    labels: [
      { name: 'status:in-progress' },
      { name: 'bug' },
      { name: 'status:approved' },
      { name: 'priority:high' },
    ],
  };

  const result = executeHumanDecision({
    action: 'APPROVE_AND_MERGE',
    sessionPath,
    stateDir,
    identityHash: id,
    deps: { execSync: mkExecSync(prState) },
  });

  assert.equal(result.ok, true, 'S6-22a: merge succeeds with multiple labels');
  assert.equal(result.value.status, 'MERGED', 'S6-22b: status is MERGED');
}

// ---- 23. Reject & Block: No PR in session ---------------------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir, { prNumber: null });

  const result = executeHumanDecision({
    action: 'REJECT_AND_BLOCK',
    sessionPath,
    stateDir,
    identityHash: id,
    deps: { execSync: mkExecSync({}) },
  });

  assert.equal(result.ok, true, 'S6-23a: reject without PR succeeds');
  assert.equal(result.value.status, 'BLOCKED', 'S6-23b: status is BLOCKED');
  assert.equal(result.value.prNumber, null, 'S6-23c: prNumber is null');
  assert.equal(result.value.workspaceLocked, true, 'S6-23d: workspace is locked');
}

// ---- 24. S6 gate schema version constant -----------------------------------
{
  assert.equal(S6_GATE_SCHEMA_VERSION, '1', 'S6-24a: schema version is "1"');
}

// ---- 25. S6 valid actions constant ----------------------------------------
{
  assert.equal(S6_VALID_ACTIONS.has('APPROVE_AND_MERGE'), true, 'S6-25a: APPROVE_AND_MERGE is valid');
  assert.equal(S6_VALID_ACTIONS.has('REJECT_AND_BLOCK'), true, 'S6-25b: REJECT_AND_BLOCK is valid');
  assert.equal(S6_VALID_ACTIONS.has('INVALID'), false, 'S6-25c: INVALID is not valid');
}

// ---- 26. Prerequisites: session not found ----------------------------------
{
  const stateDir = mkStateDir();
  const id = identityHash({ repo: REPO, issueNumber: ISSUE });
  const fakeSessionPath = path.join(stateDir, 'sessions', `${id}.json`);

  const result = validateMergePrerequisites({ sessionPath: fakeSessionPath, stateDir, identityHash: id });
  assert.equal(result.ok, false, 'S6-26a: non-existent session fails');
  assert.equal(result.code, 'S6_SESSION_READ_FAILED', 'S6-26b: correct error code');
}

// ---- 27. Approve & Merge: gh pr view returns invalid JSON ------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);

  const result = executeHumanDecision({
    action: 'APPROVE_AND_MERGE',
    sessionPath,
    stateDir,
    identityHash: id,
    deps: { execSync: () => 'not json' },
  });

  assert.equal(result.ok, false, 'S6-27a: invalid JSON from gh fails');
  assert.equal(result.code, 'S6_MERGE_PR_VIEW_FAILED', 'S6-27b: correct error code');
}

// ---- 28. Reject & Block: session persistence check ------------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);

  const result = executeHumanDecision({
    action: 'REJECT_AND_BLOCK',
    sessionPath,
    stateDir,
    identityHash: id,
    deps: { execSync: mkExecSync({}) },
  });

  assert.equal(result.ok, true, 'S6-28a: reject succeeds');

  const rs = readSessionRecord(sessionPath);
  assert.equal(rs.ok, true, 'S6-28b: session readable');
  assert.equal(typeof rs.session.controlLoop.s6HumanGate.blockedAt, 'string', 'S6-28c: blockedAt persisted');
  assert.equal(rs.session.controlLoop.workspaceLocked, true, 'S6-28d: workspaceLocked persisted');
  assert.equal(typeof rs.session.controlLoop.workspaceLockedAt, 'string', 'S6-28e: workspaceLockedAt persisted');
  assert.ok(rs.session.controlLoop.workspaceLockReason.includes('S6'), 'S6-28f: lock reason mentions S6');
}

// ---- 29. Approve & Merge: empty labels array ------------------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);

  const prState = {
    state: 'OPEN',
    labels: [],
  };

  const result = executeHumanDecision({
    action: 'APPROVE_AND_MERGE',
    sessionPath,
    stateDir,
    identityHash: id,
    deps: { execSync: mkExecSync(prState) },
  });

  assert.equal(result.ok, false, 'S6-29a: merge with empty labels fails');
  assert.equal(result.code, 'S6_MERGE_MISSING_APPROVED_LABEL', 'S6-29b: correct error code');
}

// ---- 30. Approve & Merge: labels as plain strings -------------------------
{
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);

  const prState = {
    state: 'OPEN',
    labels: ['status:in-progress', 'status:approved', 'bug'],
  };

  const result = executeHumanDecision({
    action: 'APPROVE_AND_MERGE',
    sessionPath,
    stateDir,
    identityHash: id,
    deps: { execSync: mkExecSync(prState) },
  });

  assert.equal(result.ok, true, 'S6-30a: merge with string labels succeeds');
  assert.equal(result.value.status, 'MERGED', 'S6-30b: status is MERGED');
}

// ---- summary -----------------------------------------------------------------
console.log('control-loop-s6-human-gate: all checks passed');
process.exit(0);
