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
import crypto from 'node:crypto';

const IDENTITY = 'e'.repeat(40);
const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');

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

// A tool event as the runtime really emits it: `part.callID` plus
// `part.state.status`. `status`/`callID` are settable so a test can drive the
// START boundary (`running`) and the END boundary (`completed`) separately.
const toolEvent = (tool, command = null, output = null, { status = 'completed', callID = null } = {}) => ({
  kind: 'tool',
  tool,
  event: {
    part: {
      ...(callID ? { callID } : {}),
      state: {
        ...(command ? { input: { command } } : {}),
        ...(output !== null ? { output } : {}),
        status,
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

test('the recorder brackets ONE run with ITS OWN before/after snapshot — no shared rolling state', () => {
  const wt = mkWorktree();
  const runsPath = path.join(os.tmpdir(), `tre-${Date.now()}.testruns.jsonl`);
  const rec = createTestRunRecorder({
    worktreePath: wt, identityHash: IDENTITY, taskId: 't#1', repo: 'o/r', issueNumber: 1, path: runsPath,
  });

  const d0 = digestOf(wt);
  // Non-content events must not move the tracked-content state.
  rec.observe(textEvent);
  rec.observe(toolEvent('read', null, null, { callID: 'c-read' }));
  rec.observe(toolEvent('glob', null, null, { callID: 'c-glob' }));
  assert.equal(rec.snapshot().contentDigest, d0, 'read-only tools leave the content state where it was');

  // A content-capable tool event is seen, so the next snapshot reflects it.
  fs.writeFileSync(path.join(wt, 'tracked.md'), 'v2\n', 'utf8');
  rec.observe(toolEvent('edit', null, null, { callID: 'c-edit' }));
  const d1 = digestOf(wt);
  assert.equal(rec.snapshot().contentDigest, d1, 'the edit is visible before any test runs');

  // START boundary of THIS call captures ITS `before` — d1, not d0 and not a
  // value shared with any other call.
  const CMD = 'node --test tests/x.test.mjs';
  const OUT = 'TAP version 13\n# pass 1\nExit code: 0\n';
  rec.observe(toolEvent('bash', CMD, null, { status: 'running', callID: 'call-1' }));
  // ... then the content moves AGAIN before the run reports its output: only
  // the per-call `before` can freeze the starting state for call-1.
  fs.writeFileSync(path.join(wt, 'tracked.md'), 'v3 - while the suite ran\n', 'utf8');
  const d2 = digestOf(wt);
  rec.observe(toolEvent('bash', CMD, OUT, { callID: 'call-1' }));

  const runs = readTestRunRecords(runsPath);
  assert.equal(runs.length, 1, 'exactly one TestRunRecord per tool call');
  const r = runs[0];
  assert.equal(r.kind, 'TestRunRecord');
  assert.equal(r.runId, 'call-1', 'the runId IS the tool call id, so start and end cannot cross over');
  assert.equal(r.toolCallId, 'call-1');
  assert.equal(r.boundary, 'OBSERVED_START');
  assert.equal(r.identityHash, IDENTITY);
  assert.equal(r.worktreePath, wt);
  assert.equal(r.command, CMD);
  assert.equal(r.commandDigest, sha256(CMD));
  assert.equal(r.outputDigest, sha256(OUT), 'the output digest is what pairs this run to its log block');
  assert.equal(r.exitCode, 0);
  assert.equal(r.result, 'PASS');
  assert.equal(r.before.contentDigest, d1, 'before == the content at THIS call\'s start boundary');
  assert.equal(r.after.contentDigest, d2, 'after == the content at THIS call\'s end boundary');
  assert.notEqual(r.before.contentDigest, r.after.contentDigest, 'the in-run mutation stays visible');
  assert.equal(r.binding, 'PROVEN');
  assert.equal(r.capturedBy, 'executor-launcher/attachPassthrough');
  assert.ok(typeof r.startedAt === 'string' && typeof r.finishedAt === 'string');

  // Byte-identical to the reviewer's one-shot recomputation — otherwise no
  // `after` snapshot could ever match the live worktree.
  assert.equal(r.after.contentDigest, computeWorktreeContentBinding({ worktreePath: wt }).value.contentDigest);
});

test('content mutated while the command runs is visible as before != after', () => {
  const wt = mkWorktree();
  const runsPath = path.join(os.tmpdir(), `tre-mid-${Date.now()}.testruns.jsonl`);
  const rec = createTestRunRecorder({ worktreePath: wt, identityHash: IDENTITY, path: runsPath });
  const before = digestOf(wt);
  rec.observe(toolEvent('bash', 'npm test', null, { status: 'pending', callID: 'call-mid' }));
  fs.writeFileSync(path.join(wt, 'tracked.md'), 'mutated while the suite ran\n', 'utf8');
  rec.observe(toolEvent('bash', 'npm test', 'Exit code: 0\n', { callID: 'call-mid' }));
  const [r] = readTestRunRecords(runsPath);
  assert.equal(r.boundary, 'OBSERVED_START');
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
  rec.observe(toolEvent('bash', 'git diff --check', null, { status: 'running', callID: 'call-broken' }));
  rec.observe(toolEvent('bash', 'git diff --check', 'Exit code: 0\n', { callID: 'call-broken' }));
  const [r] = readTestRunRecords(runsPath);
  assert.equal(r.boundary, 'OBSERVED_START');
  assert.equal(r.binding, 'UNPROVEN');
  assert.equal(r.before, null);
  assert.equal(r.after, null);
  // ... and the reader refuses exactly this shape (see review-evidence F4(e)).
});

test('F4(e). a run with NO observed start boundary is UNOBSERVED_START with before=null — never synthesized', () => {
  const wt = mkWorktree();
  const runsPath = path.join(os.tmpdir(), `tre-nostart-${Date.now()}.testruns.jsonl`);
  const rec = createTestRunRecorder({ worktreePath: wt, identityHash: IDENTITY, path: runsPath });

  // The runtime only ever reports `completed` — no start event was seen.
  rec.observe(toolEvent('bash', 'node --test tests/x.test.mjs', 'TAP version 13\n# pass 1\nExit code: 0\n', { callID: 'call-nostart' }));
  // ... and a second call that never even carried a callID.
  rec.observe(toolEvent('bash', 'git diff --check', 'Exit code: 0\n'));

  const runs = readTestRunRecords(runsPath);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].boundary, 'UNOBSERVED_START');
  assert.equal(runs[0].binding, 'UNPROVEN');
  assert.equal(runs[0].before, null, 'the control plane must NOT invent a starting snapshot');
  assert.equal(runs[0].toolCallId, 'call-nostart');
  assert.equal(runs[1].boundary, 'UNOBSERVED_START');
  assert.equal(runs[1].before, null);
  assert.ok(runs[1].runId, 'a runId still exists so the record stays addressable');
  // A START for one call must never satisfy a DIFFERENT call's boundary.
  rec.observe(toolEvent('bash', 'node --test tests/x.test.mjs', null, { status: 'running', callID: 'call-a' }));
  rec.observe(toolEvent('bash', 'node --test tests/x.test.mjs', 'Exit code: 0\n', { callID: 'call-b' }));
  const after = readTestRunRecords(runsPath);
  assert.equal(after.length, 3);
  assert.equal(after[2].boundary, 'UNOBSERVED_START', 'call-b had no start of its own');
});

test('a `git add` invalidates the tracked-path cache so the next snapshot sees the new file', () => {
  const wt = mkWorktree();
  const runsPath = path.join(os.tmpdir(), `tre-index-${Date.now()}.testruns.jsonl`);
  const rec = createTestRunRecorder({ worktreePath: wt, identityHash: IDENTITY, path: runsPath });
  const before = digestOf(wt);
  fs.writeFileSync(path.join(wt, 'new.md'), 'x\n', 'utf8');
  assert.equal(rec.snapshot().contentDigest, before, 'still untracked, so the digest is unchanged');
  git(wt, ['add', 'new.md']);
  rec.observe(toolEvent('bash', 'git add new.md', null, { callID: 'c-gitadd', status: 'running' }));
  assert.notEqual(rec.snapshot().contentDigest, before, 'the index change must be noticed immediately');
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
