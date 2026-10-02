// tests/test-run-evidence.test.mjs — Issue #263 reviewer finding 4 (definitive).
//
// The PRODUCER side of the test binding: the control plane must bracket every
// test command with a content snapshot taken immediately before and
// immediately after it, persist it outside the worktree, and never accept a
// snapshot it could not prove. These are the regressions that stop the
// executor-exit stamp from being used as the test binding.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  createTestRunRecorder, readTestRunRecords, testRunsPathFor, isTestCommand, parseExitCode,
} from '../packages/executor-launcher/test-run-evidence.mjs';
import {
  computeWorktreeContentBinding, createContentTracker,
} from '../packages/executor-launcher/execution-content-binding.mjs';

const IDENTITY = 'e'.repeat(40);

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }).trim();
}

function mkWorktree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tre-'));
  git(dir, ['init']);
  fs.writeFileSync(path.join(dir, 'tracked.md'), 'v1\n', 'utf8');
  git(dir, ['add', 'tracked.md']);
  git(dir, ['-c', 'user.email=tre@test', '-c', 'user.name=tre', 'commit', '-m', 'head']);
  return dir;
}

const toolEvent = (tool, command = null, output = null) => ({
  kind: 'tool',
  tool,
  event: {
    part: {
      state: {
        ...(command ? { input: { command } } : {}),
        ...(output !== null ? { output } : {}),
        status: 'completed',
      },
    },
  },
});
const textEvent = { kind: 'text', event: { type: 'text', part: { text: 'hi' } } };

function digestOf(dir) {
  const r = computeWorktreeContentBinding({ worktreePath: dir });
  assert.equal(r.ok, true, String(r.reason));
  return r.value.contentDigest;
}

test('the recorder brackets a test command with before/after snapshots the reader can recompute', () => {
  const wt = mkWorktree();
  const runsPath = path.join(os.tmpdir(), `tre-${Date.now()}.testruns.jsonl`);
  const rec = createTestRunRecorder({
    worktreePath: wt, identityHash: IDENTITY, taskId: 't#1', repo: 'o/r', issueNumber: 1, path: runsPath,
  });

  const d0 = digestOf(wt);
  // Non-content events must not move the rolling snapshot.
  rec.observe(textEvent);
  rec.observe(toolEvent('read'));
  rec.observe(toolEvent('glob'));
  assert.equal(rec.rolling.contentDigest, d0, 'read-only tools leave the rolling snapshot where it was');

  // A content-capable tool event advances it, so the NEXT command's `before`
  // is the real pre-command state rather than the launch state.
  fs.writeFileSync(path.join(wt, 'tracked.md'), 'v2\n', 'utf8');
  rec.observe(toolEvent('edit'));
  const d1 = digestOf(wt);
  assert.equal(rec.rolling.contentDigest, d1, 'the edit is captured before any test runs');

  // The test command completes -> one canonical record is appended.
  rec.observe(toolEvent('bash', 'node --test tests/x.test.mjs', 'TAP version 13\n# pass 1\nExit code: 0\n'));
  const runs = readTestRunRecords(runsPath);
  assert.equal(runs.length, 1, 'exactly one TestRunRecord per completed test command');
  const r = runs[0];
  assert.equal(r.kind, 'TestRunRecord');
  assert.equal(r.identityHash, IDENTITY);
  assert.equal(r.worktreePath, wt);
  assert.equal(r.command, 'node --test tests/x.test.mjs');
  assert.equal(r.exitCode, 0);
  assert.equal(r.result, 'PASS');
  assert.equal(r.before.contentDigest, d1, 'before == the content the command started from');
  assert.equal(r.after.contentDigest, d1, 'after == the content it finished on');
  assert.equal(r.binding, 'PROVEN');
  assert.equal(r.capturedBy, 'executor-launcher/attachPassthrough');

  // The digests are byte-identical to the reviewer's one-shot recomputation —
  // otherwise no `after` snapshot could ever match the live worktree.
  assert.equal(r.after.contentDigest, computeWorktreeContentBinding({ worktreePath: wt }).value.contentDigest);
});

test('content mutated while the command runs is visible as before != after', () => {
  const wt = mkWorktree();
  const runsPath = path.join(os.tmpdir(), `tre-mid-${Date.now()}.testruns.jsonl`);
  const rec = createTestRunRecorder({ worktreePath: wt, identityHash: IDENTITY, path: runsPath });
  const before = digestOf(wt);
  fs.writeFileSync(path.join(wt, 'tracked.md'), 'mutated while the suite ran\n', 'utf8');
  rec.observe(toolEvent('bash', 'npm test', 'Exit code: 0\n'));
  const [r] = readTestRunRecords(runsPath);
  assert.equal(r.before.contentDigest, before);
  assert.notEqual(r.after.contentDigest, before, 'the in-run mutation must be visible to the reader');
  assert.equal(r.binding, 'PROVEN', 'both snapshots were taken by the control plane');
});

test('a snapshot the control plane could not prove is recorded UNPROVEN, never as a digest', () => {
  const wt = mkWorktree();
  const runsPath = path.join(os.tmpdir(), `tre-unproven-${Date.now()}.testruns.jsonl`);
  const brokenTracker = {
    markIndexStale() {},
    headSha: null,
    snapshot: () => ({ ok: false, reason: 'worktree unavailable' }),
  };
  const rec = createTestRunRecorder({ worktreePath: wt, identityHash: IDENTITY, path: runsPath, tracker: brokenTracker });
  rec.observe(toolEvent('bash', 'git diff --check', 'Exit code: 0\n'));
  const [r] = readTestRunRecords(runsPath);
  assert.equal(r.binding, 'UNPROVEN');
  assert.equal(r.before, null);
  assert.equal(r.after, null);
  // ... and the reader refuses exactly this shape (see review-evidence F4(c)).
});

test('only real test commands are recorded, and exit codes are parsed truthfully', () => {
  assert.equal(isTestCommand('node --test tests/a.test.mjs'), true);
  assert.equal(isTestCommand('npm run test:gate'), true);
  assert.equal(isTestCommand('git diff --check'), true);
  assert.equal(isTestCommand('ls -la'), false);
  assert.equal(isTestCommand(undefined), false);
  assert.equal(parseExitCode('Exit code: 0\n'), 0);
  assert.equal(parseExitCode('Exit code: 3\n'), 3);
  assert.equal(parseExitCode('no exit marker'), null);
});

test('testRunsPathFor derives the canonical sibling of the events log', () => {
  const events = path.join('C:', 'state', 'executions', `${IDENTITY}.events.jsonl`);
  assert.equal(testRunsPathFor({ eventsPath: events }), path.join('C:', 'state', 'executions', `${IDENTITY}.testruns.jsonl`));
  assert.equal(testRunsPathFor({ stateDir: 'C:/state', identityHash: IDENTITY }), path.join('C:', 'state', 'executions', `${IDENTITY}.testruns.jsonl`));
  assert.equal(testRunsPathFor({ eventsPath: 'no-suffix.json', stateDir: null, identityHash: null }), null, 'an unrecognised path never yields a guess');
  assert.deepEqual(readTestRunRecords(null), [], 'an absent store reads as ZERO runs, never as PASS');
  assert.deepEqual(readTestRunRecords(path.join(os.tmpdir(), 'does-not-exist.testruns.jsonl')), []);
});

test('the incremental tracker digests byte-identically to the one-shot binding', () => {
  const wt = mkWorktree();
  const oneShot = computeWorktreeContentBinding({ worktreePath: wt });
  const tr = createContentTracker({ worktreePath: wt });
  const first = tr.snapshot({ withHead: true });
  assert.equal(first.ok, true, String(first.reason));
  assert.equal(first.value.contentDigest, oneShot.value.contentDigest);
  assert.equal(first.value.fileCount, oneShot.value.fileCount);
  assert.equal(first.value.headSha, oneShot.value.headSha);
  // A no-op refresh must not move the digest.
  assert.equal(tr.snapshot().value.contentDigest, oneShot.value.contentDigest);
  // ... and a real change must.
  fs.writeFileSync(path.join(wt, 'tracked.md'), 'v9\n', 'utf8');
  assert.notEqual(tr.snapshot().value.contentDigest, oneShot.value.contentDigest);
});

console.log('test-run-evidence: all offline tests passed');
