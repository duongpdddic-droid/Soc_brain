#!/usr/bin/env node
// executor-resume.test.mjs — Issue #194
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  resumeFinalizedExecution,
} from '../packages/executor-launcher/executor-recovery.mjs';
import {
  executionRecordPath,
} from '../packages/executor-launcher/executor-launcher.mjs';
import {
  sessionPathFor,
} from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import {
  identityHash,
} from '../packages/workspace/workspace.mjs';

const REPO = 'duongpdddic-droid/Soc_brain';
const ISSUE = 194;
const OLD_PID = 11220;
const OLD_START = 134343478475192350;
const NEW_PID = 22001;
const NEW_START = 134343999999999999;
const INSTRUCTION = [
  'Continue canonical Issue #194 in the existing admitted worktree.',
  'Preserve all existing patch/evidence.',
  'Read SOC_TASK_CONTRACT.md and current git diff.',
  'Continue from the smallest incomplete action.',
  'Do not reset, clean, stash, replace the worktree, or infer READY/PASS from prior exit.',
].join(' ');

function makeFixture({
  sessionState = 'SESSION_ACTIVE',
  worktreeMismatch = false,
  terminalStatus = 'EXITED',
  finalized = true,
} = {}) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'soc-executor-resume-'),
  );
  const stateDir = path.join(root, 'state');
  const worktreesRoot = path.join(root, 'worktrees');
  const id = identityHash({
    repo: REPO,
    issueNumber: ISSUE,
  });
  const worktreePath = path.join(worktreesRoot, 'agent', id);

  fs.mkdirSync(worktreePath, { recursive: true });
  const patchPath = path.join(worktreePath, 'existing-patch.txt');
  const patchBytes = 'preserve-me\n';
  fs.writeFileSync(patchPath, patchBytes, 'utf8');

  const sp = sessionPathFor({ stateDir, identityHash: id });
  fs.mkdirSync(path.dirname(sp), { recursive: true });

  const session = {
    schemaVersion: '1',
    state: sessionState,
    taskId: `${REPO.toLowerCase()}#${ISSUE}`,
    identityHash: id,
    repo: REPO,
    issueNumber: ISSUE,
    baseSha: '6672bf155cbd8b325e541d274c2c21ecdfc80995',
    branch: `agent/${id}`,
    headSha: '6672bf155cbd8b325e541d274c2c21ecdfc80995',
    worktreePath,
    worktreesRoot,
    lease: {
      token: 'test-lease-token-194',
      issuedAt: '2026-09-20T10:17:22.801Z',
    },
    capabilities: ['status', 'diff', 'run_registered_test', 'commit'],
    testRegistry: {},
    binding: { path: worktreePath },
    mutationOwner: {
      laneId: 'client-plane',
      since: '2026-09-20T10:17:22.801Z',
      acquiredVia: 'ADMISSION',
      history: [],
    },
    executionMode: 'executor',
  };
  fs.writeFileSync(sp, `${JSON.stringify(session, null, 2)}\n`, 'utf8');

  const ep = executionRecordPath({ stateDir, identityHash: id });
  fs.mkdirSync(path.dirname(ep), { recursive: true });

  const record = {
    schemaVersion: '1',
    kind: 'ExecutionRecord',
    identityHash: id,
    taskId: session.taskId,
    repo: REPO,
    issueNumber: ISSUE,
    baseSha: session.baseSha,
    branch: session.branch,
    worktreePath: worktreeMismatch
      ? path.join(root, 'foreign-worktree')
      : worktreePath,
    executor: 'opencode',
    pid: OLD_PID,
    processStartTime: OLD_START,
    pendingExecutorBind: false,
    startedAt: 1789899447532,
    finishedAt: 1789900002372,
    exitCode: 0,
    signal: null,
    terminalStatus,
    reason: null,
    finalized,
  };
  fs.writeFileSync(ep, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  function cleanup() {
    fs.rmSync(root, { recursive: true, force: true });
  }

  return {
    root,
    stateDir,
    worktreesRoot,
    worktreePath,
    patchPath,
    patchBytes,
    sessionPath: sp,
    executionPath: ep,
    identityHash: id,
    session,
    record,
    cleanup,
  };
}

function deadProcessProbe() {
  return {
    isAlive: () => false,
    readStartTime: () => null,
  };
}

function exactLiveProcessProbe() {
  return {
    isAlive: (pid) => pid === OLD_PID,
    readStartTime: (pid) => {
      if (pid !== OLD_PID) return null;
      return { pid, processStartTime: OLD_START };
    },
  };
}

function reusedPidProbe() {
  return {
    isAlive: (pid) => pid === OLD_PID,
    readStartTime: (pid) => {
      if (pid !== OLD_PID) return null;
      return { pid, processStartTime: OLD_START + 999 };
    },
  };
}

function unknownIdentityProbe() {
  return {
    isAlive: (pid) => pid === OLD_PID,
    readStartTime: () => null,
  };
}

function makeStartDouble(fixture) {
  const calls = [];
  const start = (args) => {
    calls.push(args);
    const next = {
      schemaVersion: '1',
      kind: 'ExecutionRecord',
      identityHash: args.binding.identityHash,
      taskId: args.binding.taskId,
      repo: args.binding.repo,
      issueNumber: args.binding.issueNumber,
      baseSha: args.binding.baseSha,
      branch: args.binding.branch,
      worktreePath: args.binding.path,
      executor: 'opencode',
      pid: NEW_PID,
      processStartTime: NEW_START,
      pendingExecutorBind: false,
      startedAt: 1789901000000,
      finishedAt: null,
      exitCode: null,
      signal: null,
      terminalStatus: null,
      reason: null,
      finalized: false,
    };
    fs.writeFileSync(fixture.executionPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return {
      ok: true,
      status: 'RUNNING',
      pid: NEW_PID,
      processStartTime: NEW_START,
      identityHash: args.binding.identityHash,
    };
  };
  return { start, calls };
}

function resumeArgs(fixture, probe, start) {
  return {
    stateDir: fixture.stateDir,
    identityHash: fixture.identityHash,
    repo: REPO,
    controlCwd: fixture.root,
    instruction: INSTRUCTION,
    isAlive: probe.isAlive,
    readStartTime: probe.readStartTime,
    start,
  };
}

test('R194-1 finalized EXITED resumes same task/worktree and preserves patch', () => {
  const f = makeFixture();
  const d = makeStartDouble(f);
  const probe = deadProcessProbe();
  try {
    const before = fs.readFileSync(f.patchPath, 'utf8');
    const r = resumeFinalizedExecution(resumeArgs(f, probe, d.start));
    assert.equal(r.ok, true);
    assert.equal(r.status, 'RUNNING');
    assert.equal(d.calls.length, 1);
    const call = d.calls[0];
    assert.equal(call.binding.identityHash, f.identityHash);
    assert.equal(call.binding.taskId, f.session.taskId);
    assert.equal(call.binding.repo, f.session.repo);
    assert.equal(call.binding.issueNumber, ISSUE);
    assert.equal(path.resolve(call.binding.path), path.resolve(f.worktreePath));
    assert.equal(call.session.leaseToken, f.session.lease.token);
    assert.equal(call.sessionPath, f.sessionPath);
    assert.equal(call.stateDir, f.stateDir);
    assert.equal(call.instruction, INSTRUCTION);
    assert.ok(call.instruction.trim().length > 0);
    assert.equal(fs.readFileSync(f.patchPath, 'utf8'), before);
    const next = JSON.parse(fs.readFileSync(f.executionPath, 'utf8'));
    assert.equal(next.identityHash, f.identityHash);
    assert.equal(next.taskId, f.session.taskId);
    assert.equal(path.resolve(next.worktreePath), path.resolve(f.worktreePath));
    assert.equal(next.pid, NEW_PID);
    assert.equal(next.processStartTime, NEW_START);
    assert.notEqual(next.pid, OLD_PID);
    assert.equal(next.finalized, false);
    assert.equal(next.terminalStatus, null);
  } finally {
    f.cleanup();
  }
});

test('R194-2 exact live prior executor is never duplicated', () => {
  const f = makeFixture();
  const d = makeStartDouble(f);
  const probe = exactLiveProcessProbe();
  try {
    const r = resumeFinalizedExecution(resumeArgs(f, probe, d.start));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'PRIOR_EXECUTOR_NOT_PROVEN_GONE');
    assert.equal(d.calls.length, 0);
    assert.equal(fs.readFileSync(f.patchPath, 'utf8'), f.patchBytes);
  } finally {
    f.cleanup();
  }
});

test('R194-3 PID reuse fails closed and does not spawn', () => {
  const f = makeFixture();
  const d = makeStartDouble(f);
  const probe = reusedPidProbe();
  try {
    const r = resumeFinalizedExecution(resumeArgs(f, probe, d.start));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'RECOVERY_IDENTITY_UNPROVEN');
    assert.equal(d.calls.length, 0);
    assert.equal(fs.readFileSync(f.patchPath, 'utf8'), f.patchBytes);
  } finally {
    f.cleanup();
  }
});

test('R194-4 unprovable process identity fails closed and does not spawn', () => {
  const f = makeFixture();
  const d = makeStartDouble(f);
  const probe = unknownIdentityProbe();
  try {
    const r = resumeFinalizedExecution(resumeArgs(f, probe, d.start));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'RECOVERY_IDENTITY_UNPROVEN');
    assert.equal(d.calls.length, 0);
    assert.equal(fs.readFileSync(f.patchPath, 'utf8'), f.patchBytes);
  } finally {
    f.cleanup();
  }
});

test('R194-5 BLOCKED/Human-Gate projection is never resumed', () => {
  const f = makeFixture({ sessionState: 'BLOCKED' });
  const d = makeStartDouble(f);
  const probe = deadProcessProbe();
  try {
    const r = resumeFinalizedExecution(resumeArgs(f, probe, d.start));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'SESSION_NOT_RESUMABLE');
    assert.equal(r.detail, 'BLOCKED');
    assert.equal(d.calls.length, 0);
    assert.equal(fs.readFileSync(f.patchPath, 'utf8'), f.patchBytes);
  } finally {
    f.cleanup();
  }
});

test('R194-6 worktree binding mismatch fails closed and preserves patch', () => {
  const f = makeFixture({ worktreeMismatch: true });
  const d = makeStartDouble(f);
  const probe = deadProcessProbe();
  try {
    const before = fs.readFileSync(f.patchPath, 'utf8');
    const r = resumeFinalizedExecution(resumeArgs(f, probe, d.start));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'WORKTREE_BINDING_MISMATCH');
    assert.equal(d.calls.length, 0);
    assert.equal(fs.readFileSync(f.patchPath, 'utf8'), before);
  } finally {
    f.cleanup();
  }
});

test('R194-7 repeated recovery is idempotent and creates no concurrent owner', () => {
  const f = makeFixture();
  const d = makeStartDouble(f);
  const oldGone = deadProcessProbe();
  try {
    const first = resumeFinalizedExecution(resumeArgs(f, oldGone, d.start));
    assert.equal(first.ok, true);
    assert.equal(d.calls.length, 1);

    const second = resumeFinalizedExecution(
      resumeArgs(
        f,
        {
          isAlive: (pid) => pid === NEW_PID,
          readStartTime: (pid) => {
            if (pid !== NEW_PID) return null;
            return { pid, processStartTime: NEW_START };
          },
        },
        d.start,
      ),
    );
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'PRIOR_EXECUTION_NOT_FINALIZED');
    assert.equal(d.calls.length, 1);
    const current = JSON.parse(fs.readFileSync(f.executionPath, 'utf8'));
    assert.equal(current.pid, NEW_PID);
    assert.equal(current.processStartTime, NEW_START);
    assert.equal(current.finalized, false);
    assert.equal(fs.readFileSync(f.patchPath, 'utf8'), f.patchBytes);
  } finally {
    f.cleanup();
  }
});
