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
import {
  createTestRunRecorder, createActiveTestRunner, resolveTestGateCommand,
} from '../packages/executor-launcher/test-run-evidence.mjs';
import { buildTestPlan, provePlanCoverage, recomputePlanDigest } from '../packages/executor-launcher/test-plan.mjs';
import { buildReviewPromptForSession } from '../packages/control-loop/review-payload.mjs';

const HEAD40 = (c) => c.repeat(40);
const SHA_BASE = HEAD40('1');
const SHA_HEAD = HEAD40('2');
const IDENTITY = HEAD40('e');
const REPO = 'duongpdddic-droid/Soc_brain';

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

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
    { callID: 'call-tap', command: 'node --test tests/review-payload.test.mjs', output: 'TAP version 13\n# tests 17\n# pass 17\n# fail 0\nExit code: 0\n' },
    { callID: 'call-diff', command: 'git diff --check', output: 'Exit code: 0\n' },
  ];
  // The callID is mandatory: it is the only key that ties an output block to
  // the TestRunRecord that bracketed it (runId / toolCallId pairing).
  fs.writeFileSync(eventsPath, blocks
    .map((b) => JSON.stringify({ event: { part: { callID: b.callID, state: { input: { command: b.command }, output: b.output } } } }))
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
// One record per tool call, bracketed by THAT call's own `before`/`after`
// (never a shared rolling snapshot); `boundary: 'UNOBSERVED_START'` reproduces
// a runtime stream that never announced a start. The F4 regressions override
// before/after to reproduce "tested A, then edited B".
function writeTestRuns({
  stateDir, identityHash, worktreePath, commands,
  before = undefined, after = undefined, binding = 'PROVEN', boundary = 'OBSERVED_START', exitCode = 0,
}) {
  const fp = path.join(stateDir, `${identityHash}.testruns.jsonl`);
  const now = computeWorktreeContentBinding({ worktreePath });
  assert.equal(now.ok, true, String(now.reason));
  const b = before ?? now.value.contentDigest;
  const a = after ?? now.value.contentDigest;
  const observed = boundary === 'OBSERVED_START';
  fs.writeFileSync(fp, commands.map((c, i) => {
    const callID = c.callID || `run-${i}`;
    const finishedAt = new Date(Date.UTC(2026, 9, 1, 0, 1, 30, i)).toISOString();
    return JSON.stringify({
      schemaVersion: '1', kind: 'TestRunRecord',
      runId: callID, toolCallId: callID,
      identityHash, taskId: `${REPO}#264`, repo: REPO, issueNumber: 264,
      worktreePath, command: c.command, commandDigest: sha256(c.command),
      outputDigest: sha256(typeof c.output === 'string' ? c.output : ''),
      exitCode, result: exitCode === 0 ? 'PASS' : 'FAIL',
      outputBytes: Buffer.byteLength(c.output ?? '', 'utf8'),
      headSha: now.value.headSha,
      startedAt: observed ? new Date(Date.UTC(2026, 9, 1, 0, 1, 0, i)).toISOString() : null,
      finishedAt,
      // NEVER invented: no observed start boundary means no `before` at all.
      before: observed ? { contentDigest: b, fileCount: now.value.fileCount } : null,
      after: { contentDigest: a, fileCount: now.value.fileCount },
      boundary,
      binding: observed ? binding : 'UNPROVEN',
      capturedBy: 'executor-launcher/attachPassthrough',
      capturedAt: finishedAt,
    });
  }).join('\n') + '\n', 'utf8');
  return fp;
}

// Fully hand-authored events + run records, for the per-run pairing regressions
// where the default two-block fixture is too coarse.
function writeRaw({ stateDir, identityHash, worktreePath, events, runs }) {
  const eventsPath = path.join(stateDir, `${identityHash}.events.jsonl`);
  const runsPath = path.join(stateDir, `${identityHash}.testruns.jsonl`);
  fs.writeFileSync(eventsPath, events.map((e) => JSON.stringify({
    event: { part: { callID: e.callID, state: { input: { command: e.command }, output: e.output } } },
  })).join('\n'), 'utf8');
  const now = computeWorktreeContentBinding({ worktreePath });
  assert.equal(now.ok, true, String(now.reason));
  fs.writeFileSync(runsPath, runs.map((r, i) => {
    const observed = (r.boundary ?? 'OBSERVED_START') === 'OBSERVED_START';
    const finishedAt = r.finishedAt ?? new Date(Date.UTC(2026, 9, 1, 0, 2, 0, i)).toISOString();
    return JSON.stringify({
      schemaVersion: '1', kind: 'TestRunRecord',
      runId: r.callID, toolCallId: r.callID,
      identityHash, taskId: `${REPO}#264`, repo: REPO, issueNumber: 264,
      worktreePath, command: r.command, commandDigest: sha256(r.command),
      outputDigest: sha256(r.output),
      exitCode: r.exitCode ?? 0, result: (r.exitCode ?? 0) === 0 ? 'PASS' : 'FAIL',
      outputBytes: Buffer.byteLength(r.output ?? '', 'utf8'),
      headSha: now.value.headSha,
      startedAt: observed ? (r.startedAt ?? new Date(Date.UTC(2026, 9, 1, 0, 1, 30, i)).toISOString()) : null,
      finishedAt,
      before: observed
        ? { contentDigest: r.before ?? now.value.contentDigest, fileCount: now.value.fileCount }
        : null,
      after: { contentDigest: r.after ?? now.value.contentDigest, fileCount: now.value.fileCount },
      boundary: r.boundary ?? 'OBSERVED_START',
      binding: observed ? (r.binding ?? 'PROVEN') : 'UNPROVEN',
      capturedBy: 'executor-launcher/attachPassthrough',
      capturedAt: finishedAt,
      // (PR285/rework16 F4) A record may carry a PLAN. Coverage must then be
      // PROVEN from that plan, so a forged one (files emptied/narrowed) can never
      // lend supersession power.
      ...(r.plan ? { plan: r.plan } : {}),
      ...(r.runSource ? { runSource: r.runSource } : {}),
    });
  }).join('\n') + '\n', 'utf8');
  return { eventsPath, runsPath };
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
      { callID: 'call-tap', command: 'node --test tests/review-payload.test.mjs', output: 'TAP version 13\n# pass 17\nExit code: 0\n' },
      { callID: 'call-diff', command: 'git diff --check', output: 'Exit code: 0\n' },
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
  assert.match(r.value, /no recorded run of .* executed against the content now under review/);
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
  assert.match(r.value, /testRunBinding: 2\/2 required test command\(s\)/);
  assert.match(r.value, new RegExp(tested.slice(0, 32)), 'the tested digest is reported to the reviewer');
  assert.match(r.value, /headShaBinding is provenance ONLY/);
  assert.match(r.value, /TAP version 13/);
  assert.match(r.value, /Exit code: 0/);
});

// ---- Issue #263 F4 (per-run boundary + runId pairing) -----------------------
// The old design kept ONE rolling `before` shared by every command, and paired
// output to runs by raw command string. Each regression below pins one clause
// of the replacement: boundary per run, runId/outputDigest pairing, newest-run
// supersession, and never masking one test's failure with another's PASS.

test('F4(e). a tool call completed with NO observed start boundary -> UNVERIFIED, and `before` is never invented', () => {
  const stateDir = mkTmp('ev-f4e-');
  const wt = mkGitFixture().dir;
  const rec = mkExecutionRecord({ stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: SHA_BASE, testRuns: null });
  // A runtime stream that only ever reports `completed`/`error` — no start
  // event — so the control plane could not take a `before` for this call.
  writeTestRuns({
    stateDir, identityHash: IDENTITY, worktreePath: wt,
    commands: [
      { callID: 'call-tap', command: 'node --test tests/review-payload.test.mjs', output: 'TAP version 13\n# pass 17\nExit code: 0\n' },
      { callID: 'call-diff', command: 'git diff --check', output: 'Exit code: 0\n' },
    ],
    boundary: 'UNOBSERVED_START',
  });
  const stored = fs.readFileSync(rec.testRunsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(stored.every((r) => r.before === null), 'the control plane must NOT synthesize a starting snapshot');
  assert.ok(stored.every((r) => r.boundary === 'UNOBSERVED_START' && r.binding === 'UNPROVEN'));

  const r = readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, REVIEW_EVIDENCE_CODES.TEST_RUN_UNVERIFIED);
  assert.match(r.value, /MISSING EVIDENCE/);
  assert.match(r.value, /UNOBSERVED_START/);
});

test('F4(f). run1 FAIL+dirty then run2 clean PASS of the SAME test: the newest run supersedes, run1 is not re-blocked', () => {
  const stateDir = mkTmp('ev-f4f-');
  const wt = mkGitFixture().dir;
  const rec = mkExecutionRecord({ stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: SHA_BASE, testRuns: null });
  const live = computeWorktreeContentBinding({ worktreePath: wt }).value.contentDigest;
  const dirty = 'a'.repeat(64);
  const OUT1 = 'TAP version 13\n# tests 4\n# fail 4\nExit code: 1\nRUN1_FAILED\n';
  const OUT2 = 'TAP version 13\n# tests 4\n# pass 4\n# fail 0\nExit code: 0\nRUN2_PASSED\n';
  writeRaw({
    stateDir, identityHash: IDENTITY, worktreePath: wt,
    events: [
      { callID: 'run-1', command: 'node --test tests/f4f.test.mjs', output: OUT1 },
      { callID: 'run-2', command: 'node --test tests/f4f.test.mjs', output: OUT2 },
      { callID: 'run-3', command: 'git diff --check', output: 'Exit code: 0\n' },
    ],
    runs: [
      { callID: 'run-1', command: 'node --test tests/f4f.test.mjs', output: OUT1, exitCode: 1, before: live, after: dirty, finishedAt: '2026-10-01T00:01:00.000Z' },
      { callID: 'run-2', command: 'node --test tests/f4f.test.mjs', output: OUT2, exitCode: 0, before: live, after: live, finishedAt: '2026-10-01T00:05:00.000Z' },
      { callID: 'run-3', command: 'git diff --check', output: 'Exit code: 0\n', exitCode: 0, before: live, after: live, finishedAt: '2026-10-01T00:05:30.000Z' },
    ],
  });

  const r = readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.blocks, 2, 'only the newest admissible run of each required test is reported');
  assert.equal(r.hasFailures, false, 'the later clean pass supersedes the earlier failing run of the SAME test');
  assert.match(r.value, /RUN2_PASSED/);
  assert.doesNotMatch(r.value, /RUN1_FAILED/, 'the superseded run must not be merged into the log');
});

test('F4(g). the same command ran on A then on B: only B\'s output is admitted, A\'s log is never merged', () => {
  const stateDir = mkTmp('ev-f4g-');
  const wt = mkGitFixture().dir;
  const rec = mkExecutionRecord({ stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: SHA_BASE, testRuns: null });
  const live = computeWorktreeContentBinding({ worktreePath: wt }).value.contentDigest;
  const OLD = 'b'.repeat(64);
  const OUT_A = 'TAP version 13\n# pass 9\nExit code: 0\nTESTED_ON_A\n';
  const OUT_B = 'TAP version 13\n# pass 9\nExit code: 0\nTESTED_ON_B\n';
  const CMD = 'node --test tests/f4g.test.mjs';
  writeRaw({
    stateDir, identityHash: IDENTITY, worktreePath: wt,
    events: [
      { callID: 'call-on-a', command: CMD, output: OUT_A },
      { callID: 'call-on-b', command: CMD, output: OUT_B },
      { callID: 'call-diff', command: 'git diff --check', output: 'Exit code: 0\n' },
    ],
    runs: [
      { callID: 'call-on-a', command: CMD, output: OUT_A, exitCode: 0, before: OLD, after: OLD, finishedAt: '2026-10-01T00:01:00.000Z' },
      { callID: 'call-on-b', command: CMD, output: OUT_B, exitCode: 0, before: live, after: live, finishedAt: '2026-10-01T00:06:00.000Z' },
      { callID: 'call-diff', command: 'git diff --check', output: 'Exit code: 0\n', exitCode: 0, before: live, after: live, finishedAt: '2026-10-01T00:06:30.000Z' },
    ],
  });

  const r = readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.blocks, 2, 'the run bound to A is dropped, not blended');
  assert.match(r.value, /TESTED_ON_B/);
  assert.doesNotMatch(r.value, /TESTED_ON_A/, 'output from the older content must never ride along');
});

test('F4(h). test A FAIL + test B PASS on the same content: A\'s failure is retained, never masked', () => {
  const stateDir = mkTmp('ev-f4h-');
  const wt = mkGitFixture().dir;
  const rec = mkExecutionRecord({ stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: SHA_BASE, testRuns: null });
  const live = computeWorktreeContentBinding({ worktreePath: wt }).value.contentDigest;
  const FAIL_OUT = 'TAP version 13\n# tests 5\n# fail 2\nExit code: 1\n';
  const PASS_OUT = 'TAP version 13\n# tests 5\n# pass 5\n# fail 0\nExit code: 0\n';
  const FAIL_CMD = 'node --test tests/a.test.mjs';
  const PASS_CMD = 'node --test tests/b.test.mjs';
  writeRaw({
    stateDir, identityHash: IDENTITY, worktreePath: wt,
    events: [
      { callID: 'call-a', command: FAIL_CMD, output: FAIL_OUT },
      { callID: 'call-b', command: PASS_CMD, output: PASS_OUT },
      { callID: 'call-d', command: 'git diff --check', output: 'Exit code: 0\n' },
    ],
    runs: [
      { callID: 'call-a', command: FAIL_CMD, output: FAIL_OUT, exitCode: 1, before: live, after: live, finishedAt: '2026-10-01T00:01:00.000Z' },
      { callID: 'call-b', command: PASS_CMD, output: PASS_OUT, exitCode: 0, before: live, after: live, finishedAt: '2026-10-01T00:01:10.000Z' },
      { callID: 'call-d', command: 'git diff --check', output: 'Exit code: 0\n', exitCode: 0, before: live, after: live, finishedAt: '2026-10-01T00:01:20.000Z' },
    ],
  });

  const r = readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.blocks, 3, 'every required test is evaluated on its own');
  assert.equal(r.hasFailures, true, 'the PASS of another test must not mask this failure');
  assert.match(r.value, /ATTENTION/);
  assert.match(r.value, /1 of 3 captured commands report a NON-ZERO result/);
});

// ---- Issue #263 F4(2): timeline-first ranking + F4(1) active gate ------------
// The control plane now runs `test:gate` itself at VERIFY (F4(1)), and the
// reader ranks runs NEWEST-FIRST before any validity filtering (F4(2)), so a
// newer FAIL/UNVERIFIED run can never fall back to an older PASS of the same
// target while a later valid PASS still supersedes an older failure.

function writeEvents(stateDir, identityHash, blocks) {
  const eventsPath = path.join(stateDir, `${identityHash}.events.jsonl`);
  fs.writeFileSync(eventsPath, blocks.map((b) => JSON.stringify({
    event: { part: { callID: b.callID, state: { input: { command: b.command }, output: b.output } } },
  })).join('\n'), 'utf8');
  return eventsPath;
}

const GATE_CMD = 'node --test tests/gate.test.mjs';
function addGateFixture(dir) {
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'gate.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "test('gate passes', () => { assert.equal(1, 1); });\n", 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'gate-fixture', private: true, scripts: { 'test:gate': GATE_CMD } }, null, 2)}\n`,
    'utf8');
}

test('F4(i). run1 PASS (valid boundary) then run2 with NO start boundary: the NEWEST run decides — never ok:true', () => {
  const stateDir = mkTmp('ev-f4i-');
  const wt = mkGitFixture().dir;
  const rec = mkExecutionRecord({ stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: SHA_BASE, testRuns: null });
  const live = computeWorktreeContentBinding({ worktreePath: wt }).value.contentDigest;
  const CMD = 'node --test tests/f4i.test.mjs';
  const OUT1 = 'TAP version 13\n# pass 4\n# fail 0\nExit code: 0\nRUN1_PASSED\n';
  const OUT2 = 'TAP version 13\n# tests 4\n# fail 4\nExit code: 1\nRUN2_UNVERIFIED\n';
  const read = () => readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });

  // (1) newest run never observed a start boundary -> UNVERIFIED, full stop.
  writeRaw({
    stateDir, identityHash: IDENTITY, worktreePath: wt,
    events: [
      { callID: 'run-1', command: CMD, output: OUT1 },
      { callID: 'run-2', command: CMD, output: OUT2 },
    ],
    runs: [
      { callID: 'run-1', command: CMD, output: OUT1, exitCode: 0, before: live, after: live, finishedAt: '2026-10-01T00:01:00.000Z' },
      { callID: 'run-2', command: CMD, output: OUT2, exitCode: 1, boundary: 'UNOBSERVED_START', finishedAt: '2026-10-01T00:05:00.000Z' },
    ],
  });
  const r1 = read();
  assert.equal(r1.ok, false, JSON.stringify(r1));
  assert.equal(r1.code, REVIEW_EVIDENCE_CODES.TEST_RUN_UNVERIFIED);
  assert.match(r1.value, /UNOBSERVED_START/);
  assert.doesNotMatch(r1.value, /RUN1_PASSED/, 'the superseded PASS must never stand in for the newest run');
  assert.doesNotMatch(r1.value, /RUN2_UNVERIFIED/, 'output of a run that proved nothing is not evidence either');
  assert.doesNotMatch(r1.value, /All \d+ captured commands report fail=0/, 'never reported as a clean pass');

  // (2) a LATER valid PASS of the same target supersedes the unverified run.
  const OUT3 = 'TAP version 13\n# pass 4\n# fail 0\nExit code: 0\nRUN3_PASSED\n';
  writeRaw({
    stateDir, identityHash: IDENTITY, worktreePath: wt,
    events: [
      { callID: 'run-1', command: CMD, output: OUT1 },
      { callID: 'run-2', command: CMD, output: OUT2 },
      { callID: 'run-3', command: CMD, output: OUT3 },
    ],
    runs: [
      { callID: 'run-1', command: CMD, output: OUT1, exitCode: 0, before: live, after: live, finishedAt: '2026-10-01T00:01:00.000Z' },
      { callID: 'run-2', command: CMD, output: OUT2, exitCode: 1, boundary: 'UNOBSERVED_START', finishedAt: '2026-10-01T00:05:00.000Z' },
      { callID: 'run-3', command: CMD, output: OUT3, exitCode: 0, before: live, after: live, finishedAt: '2026-10-01T00:09:00.000Z' },
    ],
  });
  const r2 = read();
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.blocks, 1, 'one target, one newest admissible run');
  assert.match(r2.value, /RUN3_PASSED/);
  assert.doesNotMatch(r2.value, /RUN1_PASSED|RUN2_UNVERIFIED/, 'only the newest run of the target reaches the payload');
  assert.equal(r2.hasFailures, false);
});

test('F4(integration). real producer -> real consumer: the recorder AND the active gate run both reach the payload', () => {
  const stateDir = mkTmp('ev-f4int-');
  const wt = mkGitFixture().dir;
  addGateFixture(wt);
  const runsPath = path.join(stateDir, `${IDENTITY}.testruns.jsonl`);
  const diffCmd = 'git diff --check';

  // (1) REAL producer for the executor leg — the canonical recorder brackets a
  //     tool call with its own before/after snapshot.
  const recorder = createTestRunRecorder({
    worktreePath: wt, identityHash: IDENTITY, taskId: `${REPO}#264`, repo: REPO, issueNumber: 264,
    path: runsPath, clock: () => Date.UTC(2026, 9, 1, 0, 1, 0),
  });
  const tool = (callID, command, status, output) => ({
    kind: 'tool',
    event: { part: { callID, state: { status, input: { command }, ...(output != null ? { output } : {}) } } },
  });
  recorder.observe(tool('call-diff', diffCmd, 'running'));
  recorder.observe(tool('call-diff', diffCmd, 'completed', 'Exit code: 0\n'));
  // The executor's OWN claim of the gate command, with no start boundary — the
  // measured runtime reality (0 of 4269 events announce a start).
  recorder.observe(tool('call-gate-claim', GATE_CMD, 'completed',
    'FAKE_EXECUTOR_GATE_OUTPUT\nExit code: 0\n'));

  // (2) REAL active runner — the control plane spawns the gate itself.
  const runner = createActiveTestRunner({ clock: () => Date.now() });
  const gate = runner.runGate({
    record: {
      identityHash: IDENTITY, worktreePath: wt, taskId: `${REPO}#264`, repo: REPO,
      issueNumber: 264, testRunsPath: runsPath,
    },
  });
  assert.equal(gate.ok, true, JSON.stringify(gate));
  assert.equal(gate.exitCode, 0);

  // (3) ExecutionRecord + the executor's events log, then the real reader.
  const rec = mkExecutionRecord({
    stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: SHA_BASE, testRuns: null,
  });
  writeEvents(stateDir, IDENTITY, [
    { callID: 'call-diff', command: diffCmd, output: 'Exit code: 0\n' },
    { callID: 'call-gate-claim', command: GATE_CMD, output: 'FAKE_EXECUTOR_GATE_OUTPUT\nExit code: 0\n' },
  ]);

  const r = readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.blocks, 2, 'the active gate target and the bracketed executor target');
  assert.equal(r.activeRuns, 1);
  assert.equal(r.unverifiedClaims, 0, 'both claimed targets are accounted for');
  assert.equal(r.hasFailures, false);
  assert.match(r.value, /testRunBinding: 2\/2 required test command\(s\)/);
  assert.match(r.value, /activeTestGate: active-.*=PASS exit=0 .*logVerified=SHA256_MATCH/);
  // The gate section of the payload comes from the CONTROL PLANE's raw log —
  // the executor's own claim of the same command never substitutes for it.
  assert.match(r.value, /gate passes/);
  assert.match(r.value, /TAP version 13/);
  assert.match(r.value, /Exit code: 0/);
  assert.doesNotMatch(r.value, /FAKE_EXECUTOR_GATE_OUTPUT/,
    'the executor\'s unbracketed claim is superseded, not merged into the evidence');
  assert.match(rec.record.testRunsPath, /\.testruns\.jsonl$/);
});

test('F4(j). target A active PASS + target B whose newest run lacks a boundary: full acceptance is REFUSED', () => {
  const stateDir = mkTmp('ev-f4j-');
  const wt = mkGitFixture().dir;
  addGateFixture(wt);
  const runsPath = path.join(stateDir, `${IDENTITY}.testruns.jsonl`);
  const diffCmd = 'git diff --check';

  const recorder = createTestRunRecorder({
    worktreePath: wt, identityHash: IDENTITY, taskId: `${REPO}#264`, repo: REPO, issueNumber: 264,
    path: runsPath, clock: () => Date.UTC(2026, 9, 1, 0, 1, 0),
  });
  const tool = (callID, command, status, output) => ({
    kind: 'tool',
    event: { part: { callID, state: { status, input: { command }, ...(output != null ? { output } : {}) } } },
  });
  // Target B: a claim that only ever reported `completed` — no start boundary,
  // so the recorded run can never be admissible evidence.
  recorder.observe(tool('call-diff', diffCmd, 'completed', 'Exit code: 0\n'));

  // Target A: the control-plane gate really runs and really passes.
  const runner = createActiveTestRunner({ clock: () => Date.now() });
  const gate = runner.runGate({
    record: {
      identityHash: IDENTITY, worktreePath: wt, taskId: `${REPO}#264`, repo: REPO,
      issueNumber: 264, testRunsPath: runsPath,
    },
  });
  assert.equal(gate.ok, true, JSON.stringify(gate));

  const rec = mkExecutionRecord({
    stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: SHA_BASE, testRuns: null,
  });
  writeEvents(stateDir, IDENTITY, [
    { callID: 'call-diff', command: diffCmd, output: 'Exit code: 0\n' },
    { callID: 'call-gate', command: GATE_CMD, output: 'TAP version 13\nExit code: 0\n' },
  ]);

  const r = readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });
  // FAIL-CLOSED: A's PASS must never mask B's unverifiable run.
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, REVIEW_EVIDENCE_CODES.TEST_RUN_UNVERIFIED);
  assert.match(r.detail, /git diff --check/, 'the blocking target is NAMED');
  assert.match(r.value, /UNOBSERVED_START|never observed a start boundary/);
  assert.match(r.value, /UNVERIFIED, never PASS/);
  assert.doesNotMatch(r.value, /All \d+ captured commands report fail=0/,
    'an unverifiable target keeps the report out of "all clear" territory');
  assert.doesNotMatch(r.value, /unverifiedClaims: 1/,
    'a target WITH a run is never downgraded to a soft caveat');
});

test('F4(k). an executor claim with NO TestRunRecord at all is reported in ATTENTION, never gate evidence', () => {
  const stateDir = mkTmp('ev-f4k-');
  const wt = mkGitFixture().dir;
  addGateFixture(wt);
  const runsPath = path.join(stateDir, `${IDENTITY}.testruns.jsonl`);

  // Only the control plane records anything; the executor's own claim of
  // `git diff --check` never reaches the run store (0 of 4269 measured events
  // announce a start, and no control-plane run exists for it either).
  const runner = createActiveTestRunner({ clock: () => Date.now() });
  const gate = runner.runGate({
    record: {
      identityHash: IDENTITY, worktreePath: wt, taskId: `${REPO}#264`, repo: REPO,
      issueNumber: 264, testRunsPath: runsPath,
    },
  });
  assert.equal(gate.ok, true, JSON.stringify(gate));

  const rec = mkExecutionRecord({
    stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: SHA_BASE, testRuns: null,
  });
  writeEvents(stateDir, IDENTITY, [
    { callID: 'call-diff', command: 'git diff --check', output: 'Exit code: 0\n' },
    { callID: 'call-gate', command: GATE_CMD, output: 'TAP version 13\nExit code: 0\n' },
  ]);

  const r = readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.blocks, 1, 'only the control-plane-verified target counts');
  assert.equal(r.unverifiedClaims, 1);
  assert.match(r.value, /testRunBinding: 1\/1 required test command\(s\)/);
  assert.match(r.value, /unverifiedClaims: 1 executor-claimed test command\(s\)/);
  assert.match(r.value, /ATTENTION: .*executor-claimed test command\(s\) are UNVERIFIED and are NOT gate evidence/);
  assert.match(r.value, /"git diff --check" \(no canonical TestRunRecord\)/, 'the claim is NAMED, not silently dropped');
  assert.doesNotMatch(r.value, /All 1 captured commands report fail=0/,
    'an unverified claim keeps the report out of "all clear" territory');
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

// ---- Affected-test plan-mode consumer read-back (unified manifest/verifier) --
// The production gate runs in PLAN mode: argv comes from the deterministic
// plan built against the task BASE. The consumer does not trust the record's
// claims — it REVALIDATES manifest/plan digest, spawn argv equality and the
// TAP summary from the raw bytes, and a stored plan tampered AFTER the run is
// a refusal (TEST_RUN_UNVERIFIED), never PASS.
test('F4(plan). plan-mode active run reaches the payload; a tampered stored plan is refused at read-back', () => {
  const stateDir = mkTmp('ev-f4plan-');
  const wt = mkGitFixture().dir;
  addGateFixture(wt);
  // Commit the gate fixture so the ONLY remaining change is the manifest.
  git(wt, ['add', '-A']);
  git(wt, ['-c', 'user.email=ev@test', '-c', 'user.name=ev', 'commit', '-m', 'gate']);
  const base = git(wt, ['rev-parse', 'HEAD']);
  // The canonical manifest for this fixture — untracked, i.e. a real change
  // the planner must classify (unknown runtime .json -> full fallback).
  fs.writeFileSync(path.join(wt, 'tests', 'tiers.json'), `${JSON.stringify({
    version: '1',
    always: [],
    smoke: ['gate.test.mjs'],
    pathMappings: {},
    fullTriggerPaths: [],
    fullTriggerPrefixes: [],
    ignorePrefixes: [],
    ignoreSuffixes: [],
    coreSubsystems: {},
    tiers: { t1: { minTests: 1, files: ['gate.test.mjs'] } },
  }, null, 2)}\n`, 'utf8');

  const runsPath = path.join(stateDir, `${IDENTITY}.testruns.jsonl`);
  const runner = createActiveTestRunner({
    clock: () => Date.now(),
    planBuilder: ({ root, base: b, mode }) => buildTestPlan({ root, base: b, mode }),
  });
  const gate = runner.runGate({
    record: {
      identityHash: IDENTITY, worktreePath: wt, taskId: `${REPO}#264`, repo: REPO,
      issueNumber: 264, testRunsPath: runsPath, baseSha: base,
    },
  });
  assert.equal(gate.ok, true, JSON.stringify(gate).slice(0, 800));
  const stored = gate.record;
  assert.ok(stored.plan && stored.tap, 'plan + TAP evidence is embedded in the record');
  assert.equal(stored.tap.ok, true, JSON.stringify(stored.tap));
  const planCmd = `node --test --test-reporter=tap ${stored.plan.files.join(' ')}`;
  assert.deepEqual(stored.spawn.argv, ['--test', '--test-reporter=tap', ...stored.plan.files]);

  const rec = mkExecutionRecord({
    stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: base, testRuns: null,
  });
  writeEvents(stateDir, IDENTITY, [
    { callID: 'call-gate', command: planCmd, output: 'TAP version 13\nExit code: 0\n' },
  ]);
  const read = () => readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: base, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });

  // (1) the honest plan run: read-back revalidates digest + argv + TAP and
  //     the payload shows WHICH plan mode ran.
  const r = read();
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 900));
  assert.equal(r.activeRuns, 1);
  assert.equal(r.blocks, 1, 'the plan-derived gate target');
  assert.equal(r.hasFailures, false);
  assert.match(r.value, /activeTestGate: .*plan=(affected|full)\/READY/);
  assert.match(r.value, /logVerified=SHA256_MATCH/);

  // (2) the stored plan is tampered after the run -> plan read-back refuses;
  //     the gate can never go green on a plan whose bytes no longer hash.
  const lines = fs.readFileSync(runsPath, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'exactly one TestRunRecord');
  const tampered = JSON.parse(lines[0]);
  tampered.plan = { ...tampered.plan, files: [] }; // digest was taken over the real selection
  fs.writeFileSync(runsPath, `${JSON.stringify(tampered)}\n`, 'utf8');
  const r2 = read();
  assert.equal(r2.ok, false, JSON.stringify(r2).slice(0, 400));
  assert.equal(r2.code, REVIEW_EVIDENCE_CODES.TEST_RUN_UNVERIFIED);
  assert.match(r2.value, /failed plan read-back \(TEST_PLAN_INVALID\)/);
  assert.doesNotMatch(r2.value, /All \d+ captured commands report fail=0/);

  // (3) PR285-R3-01: a refusal the PRODUCER itself persisted (an
  //     ACTIVE_TEST_GATE_* outcome such as CONTENT_DRIFT) travels ON the
  //     record and is honoured at read-back. The pre-fix producer persisted no
  //     refusal (and no AFTER binding), so the very same run went green here.
  const withRefusal = {
    ...JSON.parse(lines[0]),
    refusal: {
      code: 'ACTIVE_TEST_GATE_CONTENT_DRIFT',
      reason: 'worktree content changed during the run (boundary abc123… -> after def456…): untracked drift the tracked snapshot cannot see',
    },
  };
  fs.writeFileSync(runsPath, `${JSON.stringify(withRefusal)}\n`, 'utf8');
  const r3 = read();
  assert.equal(r3.ok, false, JSON.stringify(r3).slice(0, 400));
  assert.equal(r3.code, REVIEW_EVIDENCE_CODES.TEST_RUN_UNVERIFIED);
  assert.match(r3.value, /failed plan read-back \(ACTIVE_TEST_GATE_CONTENT_DRIFT\)/);
  assert.doesNotMatch(r3.value, /All \d+ captured commands report fail=0/);
});

// ---- Round-2 rework regression (F3): canonical BASE binding is mandatory ---
// A plan-mode record is ONLY judgeable against the TASK's BASE (the
// ExecutionRecord/session binding). When that binding is absent or malformed
// the consumer must fail closed with a typed refusal — the plan's own baseSha
// can never vouch for itself, and the BASE comparison is never silently
// skipped (the pre-fix consumer passed `undefined` and validateTestPlan
// skipped its BASE check, letting the plan-mode run through as VALID).
test('F3(plan). a plan-mode run without a canonical task BASE is refused TEST_PLAN_BASE_BINDING_UNAVAILABLE — never a silent BASE skip', () => {
  const setup = () => {
    const stateDir = mkTmp('ev-f3base-');
    const wt = mkGitFixture().dir;
    addGateFixture(wt);
    git(wt, ['add', '-A']);
    git(wt, ['-c', 'user.email=ev@test', '-c', 'user.name=ev', 'commit', '-m', 'gate']);
    const base = git(wt, ['rev-parse', 'HEAD']);
    // The canonical manifest for this fixture — untracked, i.e. a real change
    // the planner must classify (unknown runtime .json -> full fallback).
    fs.writeFileSync(path.join(wt, 'tests', 'tiers.json'), `${JSON.stringify({
      version: '1',
      always: [],
      smoke: ['gate.test.mjs'],
      pathMappings: {},
      fullTriggerPaths: [],
      fullTriggerPrefixes: [],
      ignorePrefixes: [],
      ignoreSuffixes: [],
      coreSubsystems: {},
      tiers: { t1: { minTests: 1, files: ['gate.test.mjs'] } },
    }, null, 2)}\n`, 'utf8');
    const runsPath = path.join(stateDir, `${IDENTITY}.testruns.jsonl`);
    const runner = createActiveTestRunner({
      clock: () => Date.now(),
      planBuilder: ({ root, base: b, mode }) => buildTestPlan({ root, base: b, mode }),
    });
    const gate = runner.runGate({
      record: {
        identityHash: IDENTITY, worktreePath: wt, taskId: `${REPO}#264`, repo: REPO,
        issueNumber: 264, testRunsPath: runsPath, baseSha: base,
      },
    });
    assert.equal(gate.ok, true, JSON.stringify(gate).slice(0, 600));
    const planCmd = `node --test --test-reporter=tap ${gate.record.plan.files.join(' ')}`;
    writeEvents(stateDir, IDENTITY, [
      { callID: 'call-gate', command: planCmd, output: 'TAP version 13\nExit code: 0\n' },
    ]);
    return { stateDir, wt };
  };
  const refuse = (rec, session) => {
    const r = readExecutionTestLog({
      session,
      verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
    });
    assert.equal(r.ok, false, JSON.stringify(r).slice(0, 400));
    assert.equal(r.code, REVIEW_EVIDENCE_CODES.TEST_RUN_UNVERIFIED);
    assert.match(r.value, /failed plan read-back \(TEST_PLAN_BASE_BINDING_UNAVAILABLE\)/);
    assert.doesNotMatch(r.value, /All \d+ captured commands report fail=0/);
  };

  // (a) NEITHER the ExecutionRecord nor the session carries a BASE
  {
    const { stateDir, wt } = setup();
    const rec = mkExecutionRecord({
      stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: undefined, testRuns: null,
    });
    refuse(rec, sessionFor({ worktreePath: wt, baseSha: undefined, headSha: SHA_HEAD }));
  }
  // (b) a MALFORMED BASE is equally unavailing — only 40-hex canonical SHAs count
  {
    const { stateDir, wt } = setup();
    const rec = mkExecutionRecord({
      stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: 'not-a-sha', testRuns: null,
    });
    refuse(rec, sessionFor({ worktreePath: wt, baseSha: 'not-a-sha', headSha: SHA_HEAD }));
  }
});

// ---- PR-285 final-review F4: cross-TARGET supersession -----------------------
// The planner emits a NEW command every time the selection changes, so the
// store keeps runs of commands that no longer match the live worktree. Those
// stale targets must be RETIRED by proof (a strictly newer VALID run whose
// coverage ⊇ the old one), never by deleting history, and never by a run that
// is narrower, unproven or foreign. Independent commands have no proven
// coverage at all, so they keep blocking/flagging exactly as before.

test('rework17(F4): a plan whose CONTENT moved on proves NO coverage — the stale target keeps BLOCKING (fail-closed)', () => {
  const stateDir = mkTmp('ev-f4sup-');
  const wt = mkGitFixture().dir;
  addGateFixture(wt);
  fs.writeFileSync(path.join(wt, 'tests', 'extra.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "test('extra passes', () => { assert.equal(1, 1); });\n", 'utf8');
  fs.writeFileSync(path.join(wt, 'tracked.md'), 'v1\n', 'utf8');
  // Everything — MANIFEST INCLUDED — is committed, so each run's selection is
  // driven only by the change each step makes below.
  fs.writeFileSync(path.join(wt, 'tests', 'tiers.json'), `${JSON.stringify({
    version: '1',
    always: [],
    smoke: ['gate.test.mjs', 'extra.test.mjs'],
    pathMappings: {},
    fullTriggerPaths: [],
    fullTriggerPrefixes: [],
    ignorePrefixes: [],
    ignoreSuffixes: [],
    coreSubsystems: {},
    tiers: { t1: { minTests: 1, files: ['gate.test.mjs', 'extra.test.mjs'] } },
  }, null, 2)}\n`, 'utf8');
  git(wt, ['add', '-A']);
  git(wt, ['-c', 'user.email=ev@test', '-c', 'user.name=ev', 'commit', '-m', 'gate']);
  const base = git(wt, ['rev-parse', 'HEAD']);

  const runsPath = path.join(stateDir, `${IDENTITY}.testruns.jsonl`);
  const runner = createActiveTestRunner({
    clock: () => Date.now(),
    planBuilder: ({ root, base: b, mode }) => buildTestPlan({ root, base: b, mode }),
  });
  const rec0 = {
    identityHash: IDENTITY, worktreePath: wt, taskId: `${REPO}#264`, repo: REPO,
    issueNumber: 264, testRunsPath: runsPath, baseSha: base,
  };

  // STEP 1 — one tracked test changed: the planner emits the AFFECTED selection
  // (a single file). This run is proven at this content.
  fs.writeFileSync(path.join(wt, 'tests', 'gate.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "// step-1 edit: this must differ from the committed bytes, or the changeset\n"
    + "test('gate passes', () => { assert.equal(1, 1); });\n", 'utf8');
  const g1 = runner.runGate({ record: rec0 });
  assert.equal(g1.ok, true, JSON.stringify(g1).slice(0, 800));
  const files1 = g1.record.plan.files.slice();
  assert.deepEqual(files1, ['tests/gate.test.mjs'], JSON.stringify(files1));

  // STEP 2 — the content MOVES ON and a FULL run is taken at the NEW content.
  // That newer run genuinely covers the grown selection, but the older plan's
  // content binding no longer matches the live worktree: it cannot PROVE which
  // tests its command executed any more.
  fs.writeFileSync(path.join(wt, 'tracked.md'), 'v2 - unclassified change\n', 'utf8');
  const g2 = runner.runGate({ record: rec0 });
  assert.equal(g2.ok, true, JSON.stringify(g2).slice(0, 800));
  const files2 = g2.record.plan.files.slice();
  assert.ok(files2.length > files1.length, `the selection really grew: ${JSON.stringify({ files1, files2 })}`);
  for (const f of files1) assert.ok(files2.includes(f), `grown selection must cover ${f}: ${JSON.stringify(files2)}`);

  // Nothing is ever deleted to make the read-back green.
  const lines = fs.readFileSync(runsPath, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2, `both TestRunRecords survive: ${lines.length}`);

  const rec = mkExecutionRecord({
    stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: base, testRuns: null,
  });
  writeEvents(stateDir, IDENTITY, [
    { callID: 'call-g1', command: `node --test --test-reporter=tap ${files1.join(' ')}`, output: 'TAP version 13\nExit code: 0\n' },
    { callID: 'call-g2', command: `node --test --test-reporter=tap ${files2.join(' ')}`, output: 'TAP version 13\nExit code: 0\n' },
  ]);
  const r = readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: base, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });

  // (rework17 F4) The older plan is DRIFTED: the planner really produced it, but
  // it can no longer prove which tests its command ran against the LIVE content.
  // A worktree-independent integrity proof would accept it — and would equally
  // accept a `files` list NARROWED to a subset and re-hashed (the reviewer's
  // forgery) — so a drifted plan lends NO coverage: the stale target keeps
  // BLOCKING. Re-running the affected command at the new content is what clears
  // it; nothing is deleted and nothing is silently retired.
  assert.equal(r.ok, false, JSON.stringify(r).slice(0, 1000));
  assert.equal(r.code, REVIEW_EVIDENCE_CODES.TEST_RUN_UNVERIFIED);
  assert.match(r.value, /gate\.test\.mjs/, 'the blocked target is NAMED, never silently dropped');
  assert.doesNotMatch(r.value, /supersededRuns:/,
    'a drifted plan can never retire its own target');
});

// (rework17 F4) The complement of the test above: the NORMAL rework flow — an
// AFFECTED run and then a FULL run at the SAME content — must still retire the
// older, narrower target. Both plans were planned for the live content, so both
// PROVE their coverage; the retirement is a proof, never a declaration. This is
// what keeps the fail-closed drift rule from turning into a dead end.
test('rework17(F4): at the SAME content an AFFECTED target IS retired by a strictly newer VALID FULL run', () => {
  const stateDir = mkTmp('ev-r17ret-');
  const wt = mkGitFixture().dir;
  addGateFixture(wt);
  fs.writeFileSync(path.join(wt, 'tests', 'extra.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "test('extra passes', () => { assert.equal(1, 1); });\n", 'utf8');
  fs.writeFileSync(path.join(wt, 'tracked.md'), 'v1\n', 'utf8');
  fs.writeFileSync(path.join(wt, 'tests', 'tiers.json'), `${JSON.stringify({
    version: '1',
    always: [],
    smoke: ['gate.test.mjs', 'extra.test.mjs'],
    pathMappings: {},
    fullTriggerPaths: [],
    fullTriggerPrefixes: [],
    ignorePrefixes: [],
    ignoreSuffixes: [],
    coreSubsystems: {},
    tiers: { t1: { minTests: 1, files: ['gate.test.mjs', 'extra.test.mjs'] } },
  }, null, 2)}\n`, 'utf8');
  git(wt, ['add', '-A']);
  git(wt, ['-c', 'user.email=ev@test', '-c', 'user.name=ev', 'commit', '-m', 'gate']);
  const base = git(wt, ['rev-parse', 'HEAD']);

  // ONE tracked test edited: the canonical AFFECTED selection is a single file.
  fs.writeFileSync(path.join(wt, 'tests', 'gate.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "// rework17: this must differ from the committed bytes\n"
    + "test('gate passes', () => { assert.equal(1, 1); });\n", 'utf8');
  const aff = buildTestPlan({ root: wt, base, mode: 'affected' });
  assert.equal(aff.ok, true, JSON.stringify(aff));
  assert.deepEqual(aff.plan.files, ['tests/gate.test.mjs'], JSON.stringify(aff.plan.files));
  // The FULL selection is requested at the SAME content — no file is touched
  // between the two runs, which is exactly the normal rework flow.
  const full = buildTestPlan({ root: wt, base, mode: 'full' });
  assert.equal(full.ok, true, JSON.stringify(full));
  assert.ok(full.plan.files.length > aff.plan.files.length,
    `the FULL selection really grew: ${JSON.stringify(full.plan.files)}`);
  for (const f of aff.plan.files) assert.ok(full.plan.files.includes(f), `the FULL selection covers ${f}`);

  // BOTH plans are the planner's own output for THIS content, so both PROVE it.
  assert.deepEqual([...provePlanCoverage({ root: wt, plan: aff.plan })].sort(), ['tests/gate.test.mjs']);
  assert.deepEqual([...provePlanCoverage({ root: wt, plan: full.plan })].sort(), full.plan.files.slice().sort());

  const CMD_AFF = `node --test --test-reporter=tap ${aff.plan.files.join(' ')}`;
  const CMD_FULL = `node --test --test-reporter=tap ${full.plan.files.join(' ')}`;
  const OUT_AFF = 'TAP version 13\n# tests 1\n# pass 1\n# fail 0\nExit code: 0\nAFF_PASSED\n';
  const OUT_FULL = 'TAP version 13\n# tests 2\n# pass 2\n# fail 0\nExit code: 0\nFULL_PASSED\n';
  const rec = mkExecutionRecord({
    stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: SHA_BASE, testRuns: null,
  });
  writeRaw({
    stateDir, identityHash: IDENTITY, worktreePath: wt,
    events: [
      { callID: 'r17-aff', command: CMD_AFF, output: OUT_AFF },
      { callID: 'r17-full', command: CMD_FULL, output: OUT_FULL },
    ],
    runs: [
      // The older target is inadmissible for a reason UNRELATED to its plan (it
      // never observed a start boundary), so retirement is the only thing that
      // can stop enforcing it — and its plan still proves the live content.
      {
        callID: 'r17-aff', command: CMD_AFF, output: OUT_AFF, boundary: 'UNOBSERVED_START',
        plan: aff.plan, finishedAt: '2026-10-01T00:01:00.000Z',
      },
      {
        callID: 'r17-full', command: CMD_FULL, output: OUT_FULL, plan: full.plan,
        finishedAt: '2026-10-01T00:05:00.000Z',
      },
    ],
  });
  const r = readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 1200));
  assert.equal(r.blocks, 1, 'the retired target no longer demands a run of its own; the covering one does');
  assert.equal(r.hasFailures, false);
  assert.match(r.value, /supersededRuns:/, 'the retirement is REPORTED, never silent');
});

test('F4(supersede). a stale target is retired ONLY by a strictly newer VALID run whose coverage ⊇ its own', () => {
  const stateDir = mkTmp('ev-f4cov-');
  const wt = mkGitFixture().dir;
  const rec = mkExecutionRecord({
    stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: SHA_BASE, testRuns: null,
  });
  const live = computeWorktreeContentBinding({ worktreePath: wt }).value.contentDigest;
  const AB = 'node --test tests/a.test.mjs tests/b.test.mjs';
  const A = 'node --test tests/a.test.mjs';
  const ABC = 'node --test tests/a.test.mjs tests/b.test.mjs tests/c.test.mjs';
  const PASS = 'TAP version 13\n# tests 1\n# pass 1\n# fail 0\nExit code: 0\n';
  const FAIL = 'TAP version 13\n# tests 1\n# fail 1\nExit code: 1\n';
  const NO_BOUNDARY = 'TAP version 13\nNO_START_BOUNDARY_OBSERVED\n';
  // The OLD target's newest run never observed a start boundary: inadmissible
  // on its own, so only a covering newer VALID run can retire it.
  const staleOld = {
    callID: 'run-old', command: AB, output: NO_BOUNDARY, boundary: 'UNOBSERVED_START',
    finishedAt: '2026-10-01T00:01:00.000Z',
  };
  const read = () => readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });
  const withNewer = (newer) => {
    writeRaw({
      stateDir, identityHash: IDENTITY, worktreePath: wt,
      events: [
        { callID: 'run-old', command: AB, output: NO_BOUNDARY },
        { callID: newer.callID, command: newer.command, output: newer.output },
      ],
      runs: [staleOld, newer],
    });
    return read();
  };

  // (a) NARROWER newer PASS: {a} does not cover {a,b} -> the sibling test must
  //     never disappear behind a green run that never executed it.
  const rA = withNewer({
    callID: 'run-a', command: A, output: PASS, finishedAt: '2026-10-01T00:02:00.000Z',
  });
  assert.equal(rA.ok, false, JSON.stringify(rA).slice(0, 600));
  assert.equal(rA.code, REVIEW_EVIDENCE_CODES.TEST_RUN_UNVERIFIED);
  assert.ok(rA.value.includes(AB), `the uncovered target is still enforced: ${rA.value}`);
  assert.doesNotMatch(rA.value, /supersededRuns:/, 'nothing may be retired without coverage');

  // (b) covering but UNPROVEN (foreign/unbound) newer run: no supersession power.
  const rB = withNewer({
    callID: 'run-b', command: ABC, output: PASS, binding: 'UNPROVEN',
    finishedAt: '2026-10-01T00:02:00.000Z',
  });
  assert.equal(rB.ok, false, JSON.stringify(rB).slice(0, 600));
  assert.equal(rB.code, REVIEW_EVIDENCE_CODES.TEST_RUN_UNVERIFIED);
  assert.ok(rB.value.includes(AB), `an unproven run cannot retire a target: ${rB.value}`);
  assert.doesNotMatch(rB.value, /supersededRuns:/);

  // (c) covering + VALID + PASS: the stale target IS retired, reported, and the
  //     store keeps both records.
  const rC = withNewer({
    callID: 'run-c', command: ABC, output: PASS, finishedAt: '2026-10-01T00:02:00.000Z',
  });
  assert.equal(rC.ok, true, JSON.stringify(rC).slice(0, 600));
  assert.equal(rC.blocks, 1, 'only the covering target is enforced');
  assert.match(rC.value, /supersededRuns:/);
  assert.equal(rC.hasFailures, false);

  // (d) covering + VALID + FAIL: retirement still happens (the tests DID run),
  //     but the FAILURE travels with it — a green sibling never masks it.
  const rD = withNewer({
    callID: 'run-d', command: ABC, output: FAIL, exitCode: 1,
    finishedAt: '2026-10-01T00:02:00.000Z',
  });
  assert.equal(rD.ok, true, JSON.stringify(rD).slice(0, 600));
  assert.equal(rD.blocks, 1);
  assert.equal(rD.hasFailures, true, 'the covering run FAILED and that is never suppressed');
  assert.match(rD.value, /ATTENTION/);
  assert.match(rD.value, /supersededRuns:/);
});

test('F4(supersede). an INDEPENDENT command (git diff --check) has no proven coverage: it is never retired and keeps flagging', () => {
  const stateDir = mkTmp('ev-f4ind-');
  const wt = mkGitFixture().dir;
  const rec = mkExecutionRecord({
    stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: SHA_BASE, testRuns: null,
  });
  const live = computeWorktreeContentBinding({ worktreePath: wt }).value.contentDigest;
  const AB = 'node --test tests/a.test.mjs tests/b.test.mjs';
  const ABC = 'node --test tests/a.test.mjs tests/b.test.mjs tests/c.test.mjs';
  const DIFF = 'git diff --check';
  const PASS = 'TAP version 13\n# tests 1\n# pass 1\n# fail 0\nExit code: 0\n';
  const NO_BOUNDARY = 'TAP version 13\nNO_START_BOUNDARY_OBSERVED\n';
  writeRaw({
    stateDir, identityHash: IDENTITY, worktreePath: wt,
    events: [
      { callID: 'run-old', command: AB, output: NO_BOUNDARY },
      { callID: 'run-new', command: ABC, output: PASS },
      { callID: 'run-diff', command: DIFF, output: 'whitespace error\nExit code: 1\n' },
    ],
    runs: [
      { callID: 'run-old', command: AB, output: NO_BOUNDARY, boundary: 'UNOBSERVED_START', finishedAt: '2026-10-01T00:01:00.000Z' },
      { callID: 'run-new', command: ABC, output: PASS, before: live, after: live, finishedAt: '2026-10-01T00:02:00.000Z' },
      { callID: 'run-diff', command: DIFF, output: 'whitespace error\nExit code: 1\n', exitCode: 1, before: live, after: live, finishedAt: '2026-10-01T00:02:10.000Z' },
    ],
  });

  const r = readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });
  // The test target IS retired (a covering newer VALID run proves it) …
  assert.match(r.value, /supersededRuns:/, 'the stale test target is retired');
  assert.equal(r.blocks, 2, 'the covering test target + the independent command');
  // … while the independent command has NO proven coverage: it can neither be
  // retired nor retire anything, and its non-zero result keeps flagging.
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 700));
  assert.equal(r.hasFailures, true, 'the independent failure is never absorbed by a superseding test run');
  assert.match(r.value, /ATTENTION/);
  assert.match(r.value, /1 of 2 captured commands report a NON-ZERO result/);
  assert.ok(r.value.includes(DIFF), `the independent command stays in the report: ${r.value}`);
  assert.doesNotMatch(r.value, /no admissible run/);
});

test('F4(supersede N1). a SHARDED/FILTERED/unknown-option newer run proves NOTHING: it never retires the stale target', () => {
  const stateDir = mkTmp('ev-f4n1-');
  const wt = mkGitFixture().dir;
  const rec = mkExecutionRecord({
    stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: SHA_BASE, testRuns: null,
  });
  const AB = 'node --test tests/a.test.mjs tests/b.test.mjs';
  const PASS = 'TAP version 13\n# tests 1\n# pass 1\n# fail 0\nExit code: 0\n';
  const NO_BOUNDARY = 'TAP version 13\nNO_START_BOUNDARY_OBSERVED\n';
  const staleOld = {
    callID: 'run-old', command: AB, output: NO_BOUNDARY, boundary: 'UNOBSERVED_START',
    finishedAt: '2026-10-01T00:01:00.000Z',
  };
  const read = () => readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });
  const withNewer = (newer) => {
    writeRaw({
      stateDir, identityHash: IDENTITY, worktreePath: wt,
      events: [
        { callID: 'run-old', command: AB, output: NO_BOUNDARY },
        { callID: newer.callID, command: newer.command, output: newer.output },
      ],
      runs: [staleOld, newer],
    });
    return read();
  };

  // (N1) Coverage is only provable when the options are proven NOT to shrink
  // the executed set. A sharding/filter/unknown option runs a SUBSET of the
  // files it names; PRE-fix, coverageOf stripped every token that starts with
  // `--`, so such a run certified {a,b,c} and retired the unverified {a,b}
  // target behind a subset execution — a false green.
  for (const [label, opt] of [
    ['--test-shard=1/3', '--test-shard=1/3'],
    ['--test-name-pattern=x', '--test-name-pattern=x'],
    ['--test-skip-pattern=y', '--test-skip-pattern=y'],
    ['unknown --inspect-brk', '--inspect-brk'],
  ]) {
    const cmd = `node --test ${opt} tests/a.test.mjs tests/b.test.mjs tests/c.test.mjs`;
    const r = withNewer({
      callID: `run-new-${label.replace(/[^a-z]/g, '')}`, command: cmd, output: PASS,
      finishedAt: '2026-10-01T00:02:00.000Z',
    });
    assert.equal(r.ok, false,
      `${label}: a subset run must NOT retire the unverified target: ${JSON.stringify(r).slice(0, 500)}`);
    assert.equal(r.code, REVIEW_EVIDENCE_CODES.TEST_RUN_UNVERIFIED);
    assert.ok(r.value.includes(AB), `${label}: the stale target stays required: ${r.value}`);
    assert.doesNotMatch(r.value, /supersededRuns:/, `${label}: nothing may be retired by an unprovable command`);
  }

  // Direction control: the reporter option family affects OUTPUT, not the
  // selection — the covering run stays a legitimate retirement.
  const rOk = withNewer({
    callID: 'run-rep', command: `node --test --test-reporter=tap tests/a.test.mjs tests/b.test.mjs tests/c.test.mjs`,
    output: PASS, finishedAt: '2026-10-01T00:02:00.000Z',
  });
  assert.equal(rOk.ok, true, JSON.stringify(rOk).slice(0, 500));
  assert.match(rOk.value, /supersededRuns:/);
});

// ---- PR-285 rework16 F4: a plan lends coverage ONLY when it is PROVEN --------
// The reviewer's trigger: the OLD target ran {gate} and its stored plan was
// edited to `files: []` (digest left stale). `classifyRun` refused the plan, but
// the supersession loop still took coverage from that same `plan.files`, so an
// EMPTY set — vacuously covered by anything — retired the target and a strictly
// newer VALID run of an UNRELATED test turned the read-back green.
test('rework16(F4): an unproven plan lends NO coverage — an emptied/narrowed selection can never retire its own target', () => {
  const stateDir = mkTmp('ev-r16f4-');
  const wt = mkGitFixture().dir;
  addGateFixture(wt);
  fs.writeFileSync(path.join(wt, 'tests', 'extra.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "test('extra passes', () => { assert.equal(1, 1); });\n", 'utf8');
  fs.writeFileSync(path.join(wt, 'tracked.md'), 'v1\n', 'utf8');
  fs.writeFileSync(path.join(wt, 'tests', 'tiers.json'), `${JSON.stringify({
    version: '1',
    always: [],
    smoke: ['gate.test.mjs', 'extra.test.mjs'],
    pathMappings: {},
    fullTriggerPaths: [],
    fullTriggerPrefixes: [],
    ignorePrefixes: [],
    ignoreSuffixes: [],
    coreSubsystems: {},
    tiers: { t1: { minTests: 1, files: ['gate.test.mjs', 'extra.test.mjs'] } },
  }, null, 2)}\n`, 'utf8');
  git(wt, ['add', '-A']);
  git(wt, ['-c', 'user.email=ev@test', '-c', 'user.name=ev', 'commit', '-m', 'gate']);
  const base = git(wt, ['rev-parse', 'HEAD']);

  // An UNCLASSIFIED change makes the planner emit the FULL selection over BOTH
  // owned tests — a REAL plan with ≥2 files, so a narrowing is genuinely
  // narrower than the canonical authority.
  fs.writeFileSync(path.join(wt, 'tracked.md'), 'v3 - unclassified change\n', 'utf8');
  const built = buildTestPlan({ root: wt, base, mode: 'auto' });
  assert.equal(built.ok, true, JSON.stringify(built));
  const realFiles = built.plan.files.slice();
  assert.ok(realFiles.length >= 2,
    `the canonical selection must offer room to narrow: ${JSON.stringify(realFiles)}`);

  // (0) a genuine plan PROVES its coverage.
  const genuine = provePlanCoverage({ root: wt, plan: built.plan });
  assert.ok(genuine instanceof Set, 'a canonical plan proves its coverage');
  assert.deepEqual([...genuine].sort(), realFiles.slice().sort());

  // (1) files emptied, digest NOT recomputed — the reviewer repro.
  assert.equal(provePlanCoverage({ root: wt, plan: { ...built.plan, files: [] } }), null,
    'a plan whose digest no longer matches its bytes proves nothing');
  // (2) files emptied, digest RE-HASHED and status flipped (a self-consistent
  //     lie): still no coverage — and never an EMPTY set, which anything covers.
  const lie = { ...built.plan, files: [], status: 'NO_TESTS', reasons: {} };
  lie.planDigest = recomputePlanDigest(lie);
  assert.equal(provePlanCoverage({ root: wt, plan: lie }), null,
    'a self-consistent but non-canonical selection proves nothing');
  // (3) files NARROWED to a real subset, re-hashed, content still matching: the
  //     canonical authority catches it because the content it planned against
  //     is still on disk.
  const narrowed = { ...built.plan, files: realFiles.slice(0, 1) };
  assert.ok(narrowed.files.length < realFiles.length, 'the narrowing must really narrow');
  narrowed.planDigest = recomputePlanDigest(narrowed);
  assert.equal(provePlanCoverage({ root: wt, plan: narrowed }), null,
    'a narrowed selection is not the planner output the worktree still holds');

  // (5) (rework17) The DRIFT path is fail-closed too. A plan narrowed to a
  //     proper non-empty SUBSET whose contentBinding digest is replaced by an
  //     arbitrary 64-hex value (which forces the "content moved on" path) and
  //     whose planDigest is RE-HASHED satisfies every worktree-independent
  //     integrity check: self-consistent digest, valid contentBinding, READY
  //     status, manifest-owned files. PRE-fix that granted the NARROWED set as
  //     coverage, so a newer VALID run covering only the subset retired the
  //     unverified sibling target. No field of the record can break the tie —
  //     plan, command and digests live in the same artifact — so coverage now
  //     requires the LIVE canonical selection and a drifted plan proves NOTHING.
  const drifted = {
    ...built.plan,
    files: realFiles.slice(0, 1),
    contentBinding: {
      ...built.plan.contentBinding,
      digest: 'a'.repeat(64),        // no observed bytes can match this
      contentDigest: 'b'.repeat(64),
    },
  };
  drifted.planDigest = recomputePlanDigest(drifted);
  assert.ok(drifted.files.length < realFiles.length, 'the drifted narrowing must really narrow');
  assert.equal(provePlanCoverage({ root: wt, plan: drifted }), null,
    'a content-drifted plan can never lend coverage — narrowed OR full — to its own target');

  // (4) END TO END. The old target never observed a start boundary (so it is
  //     REQUIRED, never a soft caveat) and carries the tampered plan. The
  //     strictly newer VALID run covers the UNRELATED test only.
  const rec = mkExecutionRecord({ stateDir, identityHash: IDENTITY, headSha: SHA_HEAD, worktreePath: wt, baseSha: SHA_BASE, testRuns: null });
  const live = computeWorktreeContentBinding({ worktreePath: wt }).value.contentDigest;
  const CMD_OLD = 'node --test tests/gate.test.mjs';
  const CMD_NEW = 'node --test tests/extra.test.mjs';
  const OUT_OLD = 'TAP version 13\n# tests 1\n# pass 1\n# fail 0\nExit code: 0\nOLD_PASSED\n';
  const OUT_NEW = 'TAP version 13\n# tests 1\n# pass 1\n# fail 0\nExit code: 0\nNEW_PASSED\n';
  writeRaw({
    stateDir, identityHash: IDENTITY, worktreePath: wt,
    events: [
      { callID: 'r16-old', command: CMD_OLD, output: OUT_OLD },
      { callID: 'r16-new', command: CMD_NEW, output: OUT_NEW },
    ],
    runs: [
      {
        callID: 'r16-old', command: CMD_OLD, output: OUT_OLD,
        boundary: 'UNOBSERVED_START', plan: { ...built.plan, files: [] },
        finishedAt: '2026-10-01T00:01:00.000Z',
      },
      {
        callID: 'r16-new', command: CMD_NEW, output: OUT_NEW,
        before: live, after: live, finishedAt: '2026-10-01T00:05:00.000Z',
      },
    ],
  });
  const r = readExecutionTestLog({
    session: sessionFor({ worktreePath: wt, baseSha: SHA_BASE, headSha: SHA_HEAD }),
    verifyReport: { verdict: 'PASS', evidence: { executionRecordPath: rec.recordPath } },
  });
  // PRE-FIX: the empty coverage retired `node --test tests/gate.test.mjs`, so the
  // unrelated newer run made the read-back GREEN. The inadmissible target must
  // keep blocking instead.
  assert.equal(r.ok, false, JSON.stringify(r).slice(0, 900));
  assert.equal(r.code, REVIEW_EVIDENCE_CODES.TEST_RUN_UNVERIFIED);
  assert.match(r.value, /UNOBSERVED_START|never observed a start boundary/);
  assert.doesNotMatch(r.value, /supersededRuns:/,
    'an unprovable plan has no supersession power at all');
  assert.match(r.value, /gate\.test\.mjs/, 'the blocked target is NAMED');
});

console.log('review-evidence: all offline tests passed');
