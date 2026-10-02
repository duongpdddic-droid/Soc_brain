// tests/review-evidence.test.mjs — regression for the THREE review-payload
// evidence paths (Issue #263 payload repair):
//   (a) raw test log + real exit code, bound to THIS identity/HEAD
//   (b) artifact bundle resolved from the BOUND TASK WORKTREE and verified
//       against the changeset actually under review
//   (c) the PR changeset at the bound headSha, reconciled with the PR base
//
// These exist because the payload used to ship:
//   - `(no artifact bundle info provided)` (bundle looked up in the RUNNER's
//     PROJECT_ROOT, which is never the task worktree),
//   - `FAIL-CLOSED ... no test execution log provided` (no producer at all),
//   - a 1 KB `baseSha..headSha` diff labelled "Full PR Diff".
// The reviewer's findings were therefore structurally unsatisfiable.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import {
  REVIEW_EVIDENCE_CODES,
  readExecutionTestLog,
  buildPrChangeset,
  buildBundleInfoForSession,
} from '../packages/control-loop/review-evidence.mjs';
import { computeWorktreeContentBinding } from '../packages/executor-launcher/execution-content-binding.mjs';
import { buildReviewPromptForSession } from '../packages/control-loop/review-payload.mjs';

const HEAD40 = (c) => c.repeat(40);
const SHA_BASE = HEAD40('1');
const SHA_HEAD = HEAD40('2');
const IDENTITY = HEAD40('e');
const REPO = 'duongpdddic-droid/Soc_brain';

function mkTmp(prefix = 'ev-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }).trim();
}

// A real git fixture: base commit -> head commit -> dirty working tree.
function mkGitFixture() {
  const dir = mkTmp('ev-git-');
  git(dir, ['init']);
  git(dir, ['-c', 'user.email=ev@test', '-c', 'user.name=ev', 'commit', '--allow-empty', '-m', 'base']);
  const baseSha = git(dir, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(dir, 'tracked.md'), 'v1\n', 'utf8');
  git(dir, ['add', 'tracked.md']);
  git(dir, ['-c', 'user.email=ev@test', '-c', 'user.name=ev', 'commit', '-m', 'head']);
  const headSha = git(dir, ['rev-parse', 'HEAD']);
  // The PR base branch exists ONLY as a remote-tracking ref — exactly how a
  // worktree sees the GitHub base without any network.
  git(dir, ['update-ref', 'refs/remotes/origin/main', baseSha]);
  // Uncommitted remediation on top of the reviewed HEAD.
  fs.writeFileSync(path.join(dir, 'tracked.md'), 'v2\n', 'utf8');
  return { dir, baseSha, headSha };
}

function mkExecutionRecord({ stateDir, identityHash, headSha, worktreePath, baseSha, exitCode = 0, staleField = null, bindContent = true, overrideContentDigest = undefined, testRuns = 'auto' }) {
  const id = identityHash;
  const eventsPath = path.join(stateDir, `${id}.events.jsonl`);
  const testRunsPath = path.join(stateDir, `${id}.testruns.jsonl`);
  const blocks = [
    { command: 'node --test tests/review-payload.test.mjs', output: 'TAP version 13\n# tests 17\n# pass 17\n# fail 0\nExit code: 0\n' },
    { command: 'git diff --check', output: 'Exit code: 0\n' },
  ];
  fs.writeFileSync(eventsPath, blocks
    .map((b) => JSON.stringify({ event: { part: { state: { input: { command: b.command }, output: b.output } } } }))
    .join('\n'), 'utf8');
  const recordPath = path.join(stateDir, `${id}.json`);
  // Production-shaped stamp: executor-launcher contentBindingStamp() writes the
  // SAME three fields from the SAME helper at process exit. `bindContent:false`
  // reproduces the PRE-fix record (headSha/codeContentDigest absent), which the
  // reader must reject as UNBOUND instead of silently trusting.
  const stamp = bindContent ? computeWorktreeContentBinding({ worktreePath }) : { ok: false };
  const record = {
    schemaVersion: '1', kind: 'ExecutionRecord',
    identityHash: staleField === 'identityHash' ? HEAD40('d') : id,
    taskId: `${REPO}#264`, repo: REPO, issueNumber: 264,
    worktreePath, baseSha, headSha,
    exitCode, terminalStatus: exitCode === 0 ? 'EXITED' : 'FAILED', signal: null,
    startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:01:00.000Z',
    eventsPath,
    // Issue #263 F4: the canonical store that brackets every test command with
    // a control-plane before/after content snapshot. `testRuns: null` removes
    // it entirely, which the reader must report as UNVERIFIED (never PASS).
    testRunsPath,
    finalized: true,
    codeContentDigest: overrideContentDigest !== undefined
      ? overrideContentDigest
      : (stamp.ok ? stamp.value.contentDigest : null),
    codeContentFiles: stamp.ok ? stamp.value.fileCount : null,
    codeBindingAt: stamp.ok ? '2026-10-01T00:01:00.000Z' : null,
    codeBindingReason: stamp.ok ? null : (stamp.reason ?? 'not bound'),
  };
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2), 'utf8');
  if (testRuns !== null) {
    writeTestRuns({ stateDir, identityHash: id, worktreePath, commands: blocks });
  }
  return { recordPath, eventsPath, testRunsPath, record };
}

function sessionFor(over = {}) {
  return {
    repo: REPO, issueNumber: 264, identityHash: IDENTITY,
    taskId: `${REPO}#264`, prNumber: 266,
    ...over,
  };
}

// The canonical before/after snapshot store the CONTROL PLANE writes while a
// test command runs (executor-launcher attachPassthrough -> test-run-evidence).
// `before`/`after` default to the worktree's current content; the F4
// regressions override them to reproduce "tested A, then edited B".
function writeTestRuns({ stateDir, identityHash, worktreePath, commands, before = undefined, after = undefined, binding = 'PROVEN' }) {
  const fp = path.join(stateDir, `${identityHash}.testruns.jsonl`);
  const now = computeWorktreeContentBinding({ worktreePath });
  assert.equal(now.ok, true, String(now.reason));
  const b = before ?? now.value.contentDigest;
  const a = after ?? now.value.contentDigest;
  fs.writeFileSync(fp, commands.map((c) => JSON.stringify({
    schemaVersion: '1', kind: 'TestRunRecord',
    identityHash, taskId: `${REPO}#264`, repo: REPO, issueNumber: 264,
    worktreePath, command: c.command, commandDigest: 'c'.repeat(64),
    exitCode: 0, result: 'PASS',
    outputBytes: Buffer.byteLength(c.output ?? '', 'utf8'),
    headSha: now.value.headSha,
    before: { contentDigest: b, fileCount: now.value.fileCount },
    after: { contentDigest: a, fileCount: now.value.fileCount },
    binding,
    capturedBy: 'executor-launcher/attachPassthrough',
    capturedAt: '2026-10-01T00:01:00.000Z',
  })).join('\n') + '\n', 'utf8');
  return fp;
}

// ---------------------------------------------------------------------------
// (a) test log
// ---------------------------------------------------------------------------
test('readExecutionTestLog: raw TAP + real exit code, bound to this identity/HEAD', () => {
  const stateDir = mkTmp('ev-rec-');
  const wt = mkGitFixture().dir;
  const rec = mkExecutionRecord({ stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: SHA_BASE });
  const r = readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.value, /TAP version 13/);
  assert.match(r.value, /# pass 17/);
  assert.match(r.value, /Exit code: 0/);
  assert.match(r.value, new RegExp(IDENTITY));
  assert.match(r.value, new RegExp(SHA_HEAD));
  assert.match(r.value, /codeContentDigest: [0-9a-f]{64}/, 'the log now carries a verifiable code-version binding');
  assert.match(r.value, /content: MATCH/);
  assert.equal(r.blocks, 2);
  assert.equal(r.hasFailures, false);
});

test('readExecutionTestLog: NO producer -> truthful MISSING string, never a bare heading', () => {
  for (const report of [undefined, {}, { verdict: 'CHANGES_REQUESTED', evidence: {} }]) {
    const r = readExecutionTestLog({ session: sessionFor(), verifyReport: report });
    assert.equal(r.ok, false);
    assert.equal(typeof r.value, 'string');
    assert.ok(r.value.length > 0, 'a non-empty truth string must be handed to the payload');
    assert.match(r.value, /MISSING EVIDENCE/);
    assert.doesNotMatch(r.value, /^\s*$/, 'empty padding would recreate the unsatisfiable finding');
  }
});

test('readExecutionTestLog: the resume shape (bare evidence object) is NOT misread as "executor never ran tests"', () => {
  const stateDir = mkTmp('ev-rec-bare-');
  const wt = mkGitFixture().dir;
  const rec = mkExecutionRecord({ stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: SHA_BASE });
  // control-loop.mjs:1224 passes `vRec.evidence` on the resume leg.
  const r = readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: SHA_HEAD }),
    verifyReport: { executionRecordPath: rec.recordPath },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.value, /TAP version 13/);
  assert.match(r.value, /Exit code: 0/);
});

test('readExecutionTestLog: a non-PASS verdict still yields a truthful MISSING, not a silent log', () => {
  const stateDir = mkTmp('ev-rec-fail-v-');
  const wt = mkGitFixture().dir;
  const rec = mkExecutionRecord({ stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: SHA_BASE });
  const r = readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'CHANGES_REQUESTED', evidence: { executionRecordPath: rec.recordPath } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, REVIEW_EVIDENCE_CODES.VERIFY_REPORT_ABSENT);
  assert.match(r.value, /MISSING EVIDENCE/);
  assert.match(r.value, /CHANGES_REQUESTED/);
});

test('readExecutionTestLog: a record from ANOTHER identity/HEAD is STALE, not evidence', () => {
  const stateDir = mkTmp('ev-rec-stale-');
  const wt = mkGitFixture().dir;
  const rec = mkExecutionRecord({ stateDir, identityHash: HEAD40('d'), headSha: SHA_HEAD, worktreePath: wt, baseSha: SHA_BASE });
  const r = readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, REVIEW_EVIDENCE_CODES.EXECUTION_RECORD_STALE);
  assert.match(r.value, /MISSING EVIDENCE/);
});

test('readExecutionTestLog: non-zero executor exit code is reported as a failure, not smoothed over', () => {
  const stateDir = mkTmp('ev-rec-fail-');
  const wt = mkGitFixture().dir;
  const rec = mkExecutionRecord({ stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: SHA_BASE, exitCode: 1 });
  const r = readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.hasFailures, true);
  assert.match(r.value, /ATTENTION/);
  assert.match(r.value, /exited with code 1/);
});

// ---- Issue #263 reviewer finding 4: content/code-version binding ------------
// The PRE-fix ExecutionRecord carries NO headSha and NO content digest, so the
// old `record.headSha !== session.headSha` guard compared undefined against
// undefined and let a log from an OLDER code version pass as evidence for the
// HEAD under review. Both regressions below must fail closed.
test('readExecutionTestLog: a record with NO code-version binding is UNBOUND, never evidence', () => {
  const stateDir = mkTmp('ev-rec-unbound-');
  const wt = mkGitFixture().dir;
  const rec = mkExecutionRecord({ stateDir, identityHash: IDENTITY, headSha: null, worktreePath: wt, baseSha: SHA_BASE, bindContent: false });
  assert.equal(rec.record.codeContentDigest, null, 'reproduces the pre-fix record shape');
  const r = readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, REVIEW_EVIDENCE_CODES.EXECUTION_RECORD_UNBOUND);
  assert.match(r.value, /MISSING EVIDENCE/);
  assert.match(r.value, /code-version binding/);
});

test('readExecutionTestLog: a log produced against an OLDER code version is STALE by content, not by luck', () => {
  const stateDir = mkTmp('ev-rec-oldcode-');
  const wt = mkGitFixture().dir;
  // Stamp the binding, then move the code forward exactly as a later edit
  // would — the stamped digest must stop matching the worktree.
  const rec = mkExecutionRecord({ stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: SHA_BASE });
  fs.writeFileSync(path.join(wt, 'tracked.md'), 'v3 - post-test edit\n', 'utf8');
  const r = readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, REVIEW_EVIDENCE_CODES.EXECUTION_RECORD_STALE);
  assert.match(r.value, /codeContentDigest differs/);
  assert.match(r.value, /DIFFERENT code version/);
});

// ---- Issue #263 reviewer finding 4 (definitive): the TEST binding ---------
// The exit-time stamp binds the ExecutionRecord, not the test. These four
// regressions are the ones the reviewer specified.
test('F4(a). PASS on A -> edit B -> exit: the exit stamp matches live, but the TEST is rejected', () => {
  const stateDir = mkTmp('ev-f4a-');
  const wt = mkGitFixture().dir;
  const digestA = computeWorktreeContentBinding({ worktreePath: wt }).value.contentDigest;
  // 1. the suite ran against A and the control plane bracketed it there.
  // 2. only afterwards does the executor edit B, and 3. it exits — stamping B.
  fs.writeFileSync(path.join(wt, 'tracked.md'), 'v3 - post-test edit\n', 'utf8');
  const rec = mkExecutionRecord({ stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: SHA_BASE, testRuns: null });
  const digestB = computeWorktreeContentBinding({ worktreePath: wt }).value.contentDigest;
  assert.notEqual(digestA, digestB, 'the edit moved the content');
  assert.equal(rec.record.codeContentDigest, digestB, 'the EXIT stamp is B — exactly the lie this gate exists to catch');
  writeTestRuns({
    stateDir, identityHash: IDENTITY, worktreePath: wt,
    commands: [
      { command: 'node --test tests/review-payload.test.mjs', output: 'TAP version 13\n# pass 17\nExit code: 0\n' },
      { command: 'git diff --check', output: 'Exit code: 0\n' },
    ],
    before: digestA, after: digestA,
  });

  const r = readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, REVIEW_EVIDENCE_CODES.TEST_RUN_STALE);
  assert.match(r.value, /MISSING EVIDENCE/);
  assert.match(r.value, /no recorded test run executed against the content/);
  assert.match(r.value, /live is/, 'it names the content actually under review');
});

test('F4(b). content changed DURING the test command: STALE, never evidence', () => {
  const stateDir = mkTmp('ev-f4b-');
  const wt = mkGitFixture().dir;
  const digestA = computeWorktreeContentBinding({ worktreePath: wt }).value.contentDigest;
  const rec = mkExecutionRecord({ stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: SHA_BASE, testRuns: null });
  fs.writeFileSync(path.join(wt, 'tracked.md'), 'v3 - written while the suite was running\n', 'utf8');
  const digestB = computeWorktreeContentBinding({ worktreePath: wt }).value.contentDigest;
  const fp = writeTestRuns({
    stateDir, identityHash: IDENTITY, worktreePath: wt,
    commands: [
      { command: 'node --test tests/review-payload.test.mjs', output: 'TAP version 13\n# pass 17\nExit code: 0\n' },
      { command: 'git diff --check', output: 'Exit code: 0\n' },
    ],
    before: digestA, after: digestB,
  });
  // The record's exit stamp matches the LIVE content, so only the before/after
  // bracket can detect the in-run mutation.
  const live = computeWorktreeContentBinding({ worktreePath: wt }).value.contentDigest;
  const updated = { ...rec.record, codeContentDigest: live };
  fs.writeFileSync(rec.recordPath, JSON.stringify(updated, null, 2), 'utf8');

  const r = readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, REVIEW_EVIDENCE_CODES.TEST_RUN_CHANGED_DURING_TEST);
  assert.match(r.value, /content changed DURING the test command/);
  assert.ok(fs.existsSync(fp));
});

test('F4(c). NO test binding at all -> UNVERIFIED, never default PASS', () => {
  const stateDir = mkTmp('ev-f4c-');
  const wt = mkGitFixture().dir;
  const rec = mkExecutionRecord({ stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: SHA_BASE, testRuns: null });
  assert.equal(fs.existsSync(rec.testRunsPath), false, 'reproduces an execution with no canonical snapshot store');
  const r = readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, REVIEW_EVIDENCE_CODES.TEST_RUN_UNVERIFIED);
  assert.match(r.value, /MISSING EVIDENCE/);
  assert.match(r.value, /TestRunRecord absent/);
  assert.doesNotMatch(r.value, /PASS/, 'an unbound log is never reported as passing evidence');
});

test('F4(d). tested content == reviewed content -> valid (and a content-neutral commit does not invalidate it)', () => {
  const stateDir = mkTmp('ev-f4d-');
  const wt = mkGitFixture().dir;
  const rec = mkExecutionRecord({ stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: SHA_BASE });
  const tested = computeWorktreeContentBinding({ worktreePath: wt }).value.contentDigest;
  // A content-neutral commit moves HEAD without touching a single tracked byte
  // — the gate is content-based, so no re-run is forced.
  const labelOnly = HEAD40('7');
  const r = readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: labelOnly }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.blocks, 2);
  assert.match(r.value, /testRunBinding: 2\/2 canonical TestRunRecord\(s\)/);
  assert.match(r.value, new RegExp(tested.slice(0, 32)), 'the tested digest is reported to the reviewer');
  assert.match(r.value, /headShaBinding is provenance ONLY/);
  assert.match(r.value, /TAP version 13/);
  assert.match(r.value, /Exit code: 0/);
});

// ---------------------------------------------------------------------------
// (c) changeset
// ---------------------------------------------------------------------------
test('buildPrChangeset: uses the PR base branch, not session.baseSha', () => {
  const { dir, baseSha, headSha } = mkGitFixture();
  const r = buildPrChangeset({
    session: sessionFor({
      worktreePath: dir, baseSha: SHA_BASE /* deliberately WRONG */, headSha,
      controlLoop: { prBinding: { prNumber: 266, baseBranch: 'main', headSha } },
    }),
    exec: (cmd, argv) => execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.meta.baseSha, baseSha, 'must resolve origin/main, not the stale session.baseSha');
  assert.equal(r.value.meta.baseSource, 'origin/main');
  assert.equal(r.value.meta.headSha, headSha);
  assert.equal(r.value.meta.prNumber, 266);
  assert.equal(r.value.meta.bytes, Buffer.byteLength(r.value.diff, 'utf8'));
  assert.equal(r.value.meta.files, 1);
  assert.equal(r.value.meta.sha256, crypto.createHash('sha256').update(r.value.diff).digest('hex'));
  assert.match(r.value.diff, /tracked\.md/);
  assert.match(r.value.diff, /\+v1/);
});

test('buildPrChangeset: the uncommitted remediation is EXCLUDED from the PR diff and reported separately', () => {
  const { dir, baseSha, headSha } = mkGitFixture();
  const r = buildPrChangeset({
    session: sessionFor({
      worktreePath: dir, baseSha, headSha,
      controlLoop: { prBinding: { prNumber: 266, baseBranch: 'main', headSha } },
    }),
    exec: (cmd, argv) => execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.doesNotMatch(r.value.diff, /\+v2/, 'the working-tree change must never sit inside the PR changeset');
  assert.match(r.value.scopeDiff, /\+v2/, 'the outstanding change must be visible in the scope diff');
  assert.equal(r.value.meta.files, 1);
  assert.equal(r.value.meta.scopeFiles, 1);
  assert.notEqual(r.value.meta.scopeSha256, r.value.meta.sha256);
});

test('buildPrChangeset: session head != bound PR head fails closed (PR_HEAD_MISMATCH)', () => {
  const { dir, headSha } = mkGitFixture();
  const r = buildPrChangeset({
    session: sessionFor({
      worktreePath: dir, baseSha: SHA_BASE, headSha,
      controlLoop: { prBinding: { prNumber: 266, baseBranch: 'main', headSha: HEAD40('9') } },
    }),
    exec: (cmd, argv) => execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, REVIEW_EVIDENCE_CODES.PR_HEAD_MISMATCH);
});

test('buildPrChangeset: an unresolvable base fails closed instead of shipping an unproven diff', () => {
  const { dir, headSha } = mkGitFixture();
  const r = buildPrChangeset({
    session: sessionFor({ worktreePath: dir, baseSha: 'not-a-sha', headSha }),
    exec: () => '', // every git call "succeeds" with no answer
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, REVIEW_EVIDENCE_CODES.PR_DIFF_UNAVAILABLE);
});

// ---------------------------------------------------------------------------
// (b) bundle
// ---------------------------------------------------------------------------
test('buildBundleInfoForSession: MISSING bundle at the bound worktree is reported as MISSING', () => {
  const dir = mkTmp('ev-bundle-');
  const r = buildBundleInfoForSession({ session: sessionFor({ worktreePath: dir }), prNumber: 266, prDiff: 'diff --git a/x b/x\n' });
  assert.equal(r.ok, false);
  assert.equal(r.code, REVIEW_EVIDENCE_CODES.BUNDLE_MISSING);
  assert.match(r.value.note, /MISSING/);
  assert.match(r.value.note, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the note must name the BOUND task path');
});

test('buildBundleInfoForSession: a bundle byte-identical to the changeset VERIFIES', () => {
  const dir = mkTmp('ev-bundle-ok-');
  const diffDir = path.join(dir, 'artifacts', 'diffs');
  fs.mkdirSync(diffDir, { recursive: true });
  const diff = 'diff --git a/x b/x\n+ok\n';
  fs.writeFileSync(path.join(diffDir, 'pr-266-changes.diff'), diff, 'utf8');
  const r = buildBundleInfoForSession({ session: sessionFor({ worktreePath: dir }), prNumber: 266, prDiff: diff });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.value.note, /VERIFIED/);
  assert.equal(r.value.stale, false);
  assert.equal(r.value.diffSize, Buffer.byteLength(diff, 'utf8'));
});

test('buildBundleInfoForSession: a STALE bundle is flagged, never passed as delivery evidence', () => {
  const dir = mkTmp('ev-bundle-stale-');
  const diffDir = path.join(dir, 'artifacts', 'diffs');
  fs.mkdirSync(diffDir, { recursive: true });
  fs.writeFileSync(path.join(diffDir, 'pr-266-changes.diff'), 'diff --git a/old b/old\n+stale\n', 'utf8');
  const r = buildBundleInfoForSession({
    session: sessionFor({ worktreePath: dir }), prNumber: 266,
    prDiff: 'diff --git a/new b/new\n+fresh\n',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, REVIEW_EVIDENCE_CODES.BUNDLE_STALE);
  assert.equal(r.value.stale, true);
  assert.match(r.value.note, /STALE BUNDLE/);
  assert.match(r.value.note, /re-exported/);
});

// ---------------------------------------------------------------------------
// payload wiring: the sections must actually carry the evidence
// ---------------------------------------------------------------------------
test('payload: raw test log, verified bundle, changeset provenance and scope diff all reach the prompt', () => {
  const stateDir = mkTmp('ev-payload-');
  const { dir, baseSha, headSha } = mkGitFixture();
  const rec = mkExecutionRecord({ stateDir, identityHash: IDENTITY, headSha, worktreePath: dir, baseSha });

  const testLog = readExecutionTestLog({
    session: sessionFor({ worktreePath: dir, baseSha, headSha }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });
  assert.equal(testLog.ok, true);

  const cs = buildPrChangeset({
    session: sessionFor({ worktreePath: dir, baseSha, headSha, controlLoop: { prBinding: { prNumber: 266, baseBranch: 'main', headSha } } }),
    exec: (cmd, argv) => execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
  });
  assert.equal(cs.ok, true);

  // Export the bundle from the SAME changeset, as the canonical export does.
  const diffDir = path.join(dir, 'artifacts', 'diffs');
  fs.mkdirSync(diffDir, { recursive: true });
  fs.writeFileSync(path.join(diffDir, 'pr-266-changes.diff'), cs.value.diff, 'utf8');

  const bi = buildBundleInfoForSession({ session: sessionFor({ worktreePath: dir }), prNumber: 266, prDiff: cs.value.diff });
  assert.equal(bi.ok, true, JSON.stringify(bi));

  const built = buildReviewPromptForSession({
    session: sessionFor({ worktreePath: dir, baseSha, headSha, targetBranch: 'main' }),
    testLog: testLog.value,
    bundleInfo: bi.value,
    diff: cs.value.diff,
    changeset: cs.value.meta,
    scopeDiff: cs.value.scopeDiff,
  });
  assert.equal(built.ok, true, JSON.stringify(built));
  const p = built.prompt;
  // (a)
  assert.match(p, /TAP version 13/);
  assert.match(p, /Exit code: 0/);
  assert.match(p, new RegExp(IDENTITY));
  // (b)
  assert.match(p, /VERIFIED/);
  assert.doesNotMatch(p, /no artifact bundle info provided/);
  // (c)
  assert.match(p, /changeset provenance/);
  assert.match(p, new RegExp(baseSha));
  assert.match(p, new RegExp(headSha));
  assert.match(p, /## \[TASK-SCOPE DIFF/);
  assert.match(p, /\+v2/, 'the uncommitted remediation must be visible to the reviewer');
  // The working-tree change is ONLY in the scope section, never in the PR diff.
  assert.doesNotMatch(cs.value.diff, /\+v2/);
  assert.match(cs.value.scopeDiff, /\+v2/);
});

test('payload: missing evidence is rendered truthfully in the very sections the reviewer reads', () => {
  const built = buildReviewPromptForSession({
    session: sessionFor({ headSha: HEAD40('2') }),
    testLog: readExecutionTestLog({ session: sessionFor(), verifyReport: undefined }).value,
    bundleInfo: buildBundleInfoForSession({ session: sessionFor({ worktreePath: path.join(os.tmpdir(), 'no-such-worktree') }), prNumber: 266, prDiff: 'x' }).value,
    diff: 'diff --git a/x b/x\n+y\n  No newline at end of file',
  });
  assert.equal(built.ok, true, JSON.stringify(built));
  const p = built.prompt;
  // The heading alone would recreate the exact unsatisfiable finding this
  // repair exists to remove — the truth string must sit right under it.
  assert.match(p, /## \[TEST SUITE EXECUTION EVIDENCE\]\n\nMISSING EVIDENCE/);
  assert.match(p, /## \[DELIVERY ARTIFACTS VERIFICATION\]\n\n- bundle: MISSING at .*NOT evidence of delivery/);
  assert.doesNotMatch(p, /no test execution log provided/);
});

console.log('review-evidence: all offline tests passed');
