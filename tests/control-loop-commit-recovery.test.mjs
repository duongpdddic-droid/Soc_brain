// tests/control-loop-commit-recovery.test.mjs — Issue #264 option C.
//
// The pre-fix closed loop (reproduced offline at
// evidence/pr-263/<head>/commit-recovery-repro.log):
//   EXECUTING->VERIFYING -> runPublishChain -> PUSH_DIRTY_FOREIGN ->
//   publishChainFailure(recoverable:false, resumeState:'VERIFYING') -> resume
//   -> same tail -> same failure ... forever. ALLOWED_TRANSITIONS.VERIFYING has
//   no edge back to EXECUTING, so the executor was never told to commit.
//
// The fix dispatches exactly ONE recovery executor through the EXISTING
// adapter channel and re-enters the canonical publish chain — no FSM state, no
// transition, no admission-as-dispatch, and push.mjs still refuses every dirty
// worktree.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runControlLoop, readTransitions, ALLOWED_TRANSITIONS } from '../packages/control-loop/control-loop.mjs';
import { pushBranch, cleanPathspecsForPush } from '../packages/control-loop/push.mjs';
import {
  classifyCommitScope,
  assertPriorExecutorRelinquished,
  recoveryDigest,
  evaluateRecoveryLock,
  listCommitRecoveryRecords,
} from '../packages/control-loop/commit-recovery.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const BASE = 'f'.repeat(40);
const ISSUE = 264;
const BRANCH = 'agent/commit-recovery';
const REPO = 'duongpdddic-droid/soc_brain';
const TASK_OUTPUT = 'SMOKE_WEB2API_REVIEW_PROVENANCE.md';

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cl-crec-')); }

function mkSession(stateDir, overrides = {}) {
  const issue = overrides.issueNumber ?? ISSUE;
  const id = identityHash({ repo: REPO, issueNumber: issue });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1', state: 'SESSION_ACTIVE', lifecycle: [],
    taskId: `${REPO}#${issue}`, repo: REPO, issueNumber: issue, identityHash: id,
    headSha: HEAD_A, baseSha: BASE, branch: BRANCH,
    worktreePath: path.join(stateDir, 'wt'), worktreesRoot: stateDir,
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, id, session };
}

// In-memory git whose ONLY variable is the dirty set: while `st.dirty` is true
// `git status --porcelain` reports the given lines, otherwise it is clean.
function fakeGit({ head = HEAD_A, statusLines = [] } = {}) {
  const st = { head, remoteRef: null, pushes: 0, statusLines: [...statusLines] };
  const exec = (a0, opts) => {
    const a = (Array.isArray(a0) ? a0 : (opts && opts.args) || []).map(String);
    if (a[0] === 'rev-parse' && a[1] === 'HEAD') return { status: 0, stdout: `${st.head}\n`, stderr: '' };
    if (a[0] === 'status') return { status: 0, stdout: st.statusLines.length ? `${st.statusLines.join('\n')}\n` : '', stderr: '' };
    if (a[0] === 'diff') return { status: st.head === BASE ? 0 : 1, stdout: '', stderr: '' };
    if (a[0] === 'ls-remote') return { status: 0, stdout: st.remoteRef ? `${st.remoteRef}\t${a[2]}\n` : '', stderr: '' };
    if (a[0] === 'push') { st.remoteRef = a[2].split(':')[0]; st.pushes += 1; return { status: 0, stdout: '', stderr: '' }; }
    if (a[0] === 'merge-base') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: `unmocked git: ${a.join(' ')}` };
  };
  return { st, exec };
}

function fakeGh({ gitState, branch = BRANCH, number = 80 } = {}) {
  const calls = [];
  const st = { created: false };
  const j = (code, obj, stderr = '') => ({ code, stdout: obj === undefined ? '' : JSON.stringify(obj), stderr });
  function gh(args) {
    const a = args.map(String);
    calls.push(a.join(' '));
    if (a[0] === 'pr' && a[1] === 'list') return j(0, st.created ? [{ number, state: 'OPEN', headRefOid: gitState.remoteRef }] : []);
    if (a[0] === 'pr' && a[1] === 'create') { st.created = true; return { code: 0, stdout: `https://github.com/${REPO}/pull/${number}\n`, stderr: '' }; }
    if (a[0] === 'pr' && a[1] === 'view') {
      if (!st.created) return j(1, undefined, 'no PR');
      return j(0, { number, state: 'OPEN', headRefOid: gitState.remoteRef, headRefName: branch, baseRefName: 'main', headRepository: { nameWithOwner: REPO }, url: `https://github.com/${REPO}/pull/${number}`, body: `Closes #${ISSUE}\n\n<!-- soc-brain:identity=${identityHash({ repo: REPO, issueNumber: ISSUE })} -->` });
    }
    if (a[0] === 'issue' && a[1] === 'view') return j(0, { title: 't', body: 'b' });
    return { code: 1, stdout: '', stderr: `unmocked gh: ${a.join(' ')}` };
  }
  return { gh, calls, st };
}

function writeExecRecord(stateDir, id, overrides = {}) {
  const p = path.join(stateDir, 'executions', `${id}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: id,
    taskId: `${REPO}#${ISSUE}`, repo: REPO, issueNumber: ISSUE,
    worktreePath: path.join(stateDir, 'wt'),
    pid: 999999, processStartTime: 1, finalized: true,
    terminalStatus: 'EXITED', exitCode: 0, reason: 'EXECUTION_FINISHED',
    pendingExecutorBind: false, cleanupRequired: false,
    ...overrides,
  }, null, 2), 'utf8');
  return p;
}

function loopDeps({ git, fx, executor }) {
  return {
    pushExec: git.exec,
    gh: fx.gh,
    router: () => ({ ok: true, value: { executorKind: 'opencode', model: 'x' } }),
    executor,
    verifier: () => ({ ok: true, value: { verdict: 'PASS', report: 'ok' } }),
    preReview: () => ({ ok: true, value: { verdict: 'PASS', findings: [] } }),
    finalReview: () => ({ ok: true, value: { verdict: 'PASS', findings: [] } }),
    delivery: () => ({ ok: true, value: { shipped: true } }),
    telegramSpawn: () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 1 })}\n` }),
  };
}

const recoveryRecords = (stateDir, id) => listCommitRecoveryRecords({ stateDir, identityHash: id });

// Issue #263 reviewer finding 1: the ONLY authority for a recovery commit is
// the canonical scope/whitelist declared in this session's bound Task Contract.
// `namedPaths` from reviewer prose and "it is tracked" are never consulted.
function writeTaskContract(stateDir, scopeLines, issue = ISSUE) {
  const socDir = path.join(stateDir, 'wt', '.soc');
  fs.mkdirSync(socDir, { recursive: true });
  const file = path.join(socDir, 'task-contract.md');
  fs.writeFileSync(file, `# Task Contract - Task #${issue}\n\nProse that must NEVER be scraped for path-shaped tokens: see docs/whatever.md and src/other.mjs.\n\n## Scope\n${scopeLines.map((l) => `- ${l}`).join('\n')}\n`, 'utf8');
  return file;
}

// ---------------------------------------------------------------------------
// R1. Valid, in-scope dirty task output -> EXACTLY ONE recovery executor ->
//     commit -> the canonical publish/verify/review walk continues.
// ---------------------------------------------------------------------------
test('R1. in-scope dirty task output: one recovery executor commits, publish/verify/review continues', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  writeTaskContract(stateDir, [TASK_OUTPUT]);
  const git = fakeGit({ head: HEAD_A, statusLines: [` M ${TASK_OUTPUT}`] });
  const fx = fakeGh({ gitState: git.st });
  const execPath = writeExecRecord(stateDir, id);

  const calls = { initial: 0, recovery: 0 };
  const deps = loopDeps({
    git, fx,
    executor: async (ctx) => {
      if (ctx && typeof ctx.reworkInstruction === 'string') {
        calls.recovery += 1;
        assert.match(ctx.reworkInstruction, /COMMIT RECOVERY attempt 1/);
        assert.match(ctx.reworkInstruction, new RegExp(TASK_OUTPUT.replace(/[.]/g, '\\.')));
        assert.match(ctx.reworkInstruction, /NEVER `git add` an `artifacts\/\*\*` path/);
        // The recovery executor delivers the task output: clean tree, new HEAD.
        git.st.statusLines = [];
        git.st.head = HEAD_B;
        return { ok: true, value: { executionRecordPath: execPath } };
      }
      calls.initial += 1;
      return { ok: true, value: { executionRecordPath: execPath } };
    },
  });

  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');

  // Exactly ONE recovery executor — the initial walk ran once too.
  assert.equal(calls.initial, 1, 'initial execution');
  assert.equal(calls.recovery, 1, 'exactly one recovery executor, never two');
  assert.equal(git.st.pushes, 1, 'publish chain re-ran and pushed the NEW head');
  assert.equal(git.st.remoteRef, HEAD_B, 'the published head is the recovery commit');

  // Requirement 1: the VERIFYING checkpoint and every prior evidence record are
  // preserved — recovery emitted NO FSM transition of its own.
  const led = readTransitions({ stateDir, identityHash: id });
  assert.equal(led.filter((r) => r.from === 'EXECUTING' && r.to === 'VERIFYING').length, 1);
  assert.equal(led.filter((r) => r.from === 'REWORK').length, 0, 'recovery is not a rework round');

  // Requirement 1: the attempt is recorded by the CANONICAL API.
  const recs = recoveryRecords(stateDir, id);
  assert.equal(recs.length, 1, 'one canonical commit-recovery attempt record');
  assert.equal(recs[0].kind, 'commit-recovery-attempt');
  assert.equal(recs[0].attempt, 1);
  assert.equal(recs[0].status, 'DISPATCHED');
  assert.deepEqual(recs[0].scope.inScope, [TASK_OUTPUT]);
  assert.deepEqual(recs[0].scope.outScope, []);
  assert.equal(recs[0].checkpoint.state, 'VERIFYING', 'checkpoint preserved as evidence');
  assert.equal(recs[0].checkpoint.headSha, HEAD_A, 'checkpoint head captured before the recovery commit');
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'sessions', `${id}.json`), 'utf8')).headSha, HEAD_B);
});

// ---------------------------------------------------------------------------
// R2. Dirty paths outside the canonical scope, or an authority that is not
//     proven released -> typed block, NO recovery executor, NO push.
// ---------------------------------------------------------------------------
test('R2a. dirty path outside the canonical task/rework scope: typed block, no executor, no push', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  writeTaskContract(stateDir, [TASK_OUTPUT]);
  const git = fakeGit({ head: HEAD_A, statusLines: ['?? unknown-dirt.txt'] });
  const fx = fakeGh({ gitState: git.st });
  writeExecRecord(stateDir, id);
  let calls = 0;
  const deps = loopDeps({ git, fx, executor: async () => { calls += 1; return { ok: true, value: { executionRecordPath: 'x' } }; } });

  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'COMMIT_RECOVERY_SCOPE_VIOLATION');
  assert.deepEqual(res.detail.outScope, ['unknown-dirt.txt']);
  assert.equal(res.detail.recoverable, false);
  assert.equal(res.detail.resumeState, 'VERIFYING');
  assert.equal(calls, 1, 'no recovery executor was dispatched');
  assert.equal(git.st.pushes, 0, 'the dirty worktree was never pushed');
  assert.equal(recoveryRecords(stateDir, id).length, 0, 'a refusal never mints an attempt record');
});

test('R2b. no canonical ExecutionRecord: authority unproven -> typed block, no executor, no push', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  writeTaskContract(stateDir, [TASK_OUTPUT]);
  const git = fakeGit({ head: HEAD_A, statusLines: [` M ${TASK_OUTPUT}`] });
  const fx = fakeGh({ gitState: git.st });
  // deliberately NO executions/<id>.json
  let calls = 0;
  const deps = loopDeps({ git, fx, executor: async () => { calls += 1; return { ok: true, value: { executionRecordPath: 'x' } }; } });

  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.code, 'COMMIT_RECOVERY_AUTHORITY_UNPROVEN');
  assert.equal(res.detail.reason, 'EXECUTION_RECORD_MISSING');
  assert.equal(res.detail.readerReason, 'EXECUTION_NOT_FOUND', 'the canonical reader reports the missing record');
  assert.equal(calls, 1);
  assert.equal(git.st.pushes, 0);
  assert.equal(recoveryRecords(stateDir, id).length, 0);
});

test('R2c. prior executor not proven terminal: typed block, no executor, no push', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  writeTaskContract(stateDir, [TASK_OUTPUT]);
  const git = fakeGit({ head: HEAD_A, statusLines: [` M ${TASK_OUTPUT}`] });
  const fx = fakeGh({ gitState: git.st });
  // A record whose liveness is unprovable (this very pid is alive but the
  // immutable processStartTime was never captured) => OWNERSHIP_UNKNOWN, NOT a
  // proven terminal executor. No pid guessing, so the result is deterministic.
  writeExecRecord(stateDir, id, { terminalStatus: null, finalized: false, processStartTime: null, pid: process.pid });
  let calls = 0;
  const deps = loopDeps({ git, fx, executor: async () => { calls += 1; return { ok: true, value: { executionRecordPath: 'x' } }; } });

  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.code, 'COMMIT_RECOVERY_EXECUTOR_NOT_TERMINAL');
  assert.equal(res.detail.liveness, 'OWNERSHIP_UNKNOWN');
  assert.equal(calls, 1);
  assert.equal(git.st.pushes, 0);
  assert.equal(recoveryRecords(stateDir, id).length, 0);
});

test('R2d. foreign ExecutionRecord identity: canonical reader refuses it, no dispatch', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  writeTaskContract(stateDir, [TASK_OUTPUT]);
  const git = fakeGit({ head: HEAD_A, statusLines: [` M ${TASK_OUTPUT}`] });
  const fx = fakeGh({ gitState: git.st });
  // A record planted at this identity's path but bound to ANOTHER identity:
  // readExecutionRecord refuses it, so authority is unproven.
  writeExecRecord(stateDir, id, { identityHash: 'e'.repeat(64) });
  let calls = 0;
  const deps = loopDeps({ git, fx, executor: async () => { calls += 1; return { ok: true, value: { executionRecordPath: 'x' } }; } });
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.code, 'COMMIT_RECOVERY_AUTHORITY_UNPROVEN');
  assert.equal(res.detail.readerReason, 'EXECUTION_RECORD_INVALID');
  assert.equal(calls, 1);
  assert.equal(git.st.pushes, 0);
});

// ---------------------------------------------------------------------------
// R3. A relaunch during/after a recovery never dispatches a second executor.
// ---------------------------------------------------------------------------
test('R3. relaunch during and after recovery never spawns a duplicate recovery executor', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  writeTaskContract(stateDir, [TASK_OUTPUT]);
  const git = fakeGit({ head: HEAD_A, statusLines: [` M ${TASK_OUTPUT}`] });
  const fx = fakeGh({ gitState: git.st });
  const execPath = writeExecRecord(stateDir, id);

  const calls = { initial: 0, recovery: 0 };
  const deps = loopDeps({
    git, fx,
    executor: async (ctx) => {
      if (ctx && typeof ctx.reworkInstruction === 'string') {
        calls.recovery += 1;
        // The recovery executor runs but does NOT finish the commit — the
        // tree stays dirty, which is exactly the crash-mid-recovery shape.
        return { ok: true, value: { executionRecordPath: execPath } };
      }
      calls.initial += 1;
      return { ok: true, value: { executionRecordPath: execPath } };
    },
  });

  const first = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(first.code, 'COMMIT_RECOVERY_INCOMPLETE', JSON.stringify(first));
  assert.equal(calls.recovery, 1, 'exactly one recovery executor on the first pass');
  assert.equal(git.st.pushes, 0, 'the still-dirty worktree was never pushed');
  const recs = recoveryRecords(stateDir, id);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].status, 'DISPATCHED');

  // Relaunch #1 (during/after the recovery): the durable lock refuses a second
  // dispatch and the checkpoint is untouched.
  const second = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(second.code, 'COMMIT_RECOVERY_ALREADY_DISPATCHED', JSON.stringify(second));
  assert.equal(second.detail.recoverable, false);
  assert.equal(calls.recovery, 1, 'relaunch during recovery never dispatches twice');
  assert.equal(git.st.pushes, 0);

  // Relaunch #2: still exactly one.
  const third = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(third.code, 'COMMIT_RECOVERY_ALREADY_DISPATCHED');
  assert.equal(calls.recovery, 1);
  assert.equal(calls.initial, 1, 'the original execution is never repeated either');
  assert.equal(recoveryRecords(stateDir, id).length, 1, 'still exactly one attempt record');
  assert.equal(readTransitions({ stateDir, identityHash: id }).filter((r) => r.from === 'EXECUTING' && r.to === 'VERIFYING').length, 1);
});

// ---------------------------------------------------------------------------
// Issue #263 reviewer finding 1 regressions: tracked != in scope, and an
// undeclared scope is a typed block — never "everything tracked is fine".
// ---------------------------------------------------------------------------
test('R2e. a TRACKED file outside the declared scope: typed block, no dispatch, no commit, no push', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  // The contract authorizes ONLY the task output; the dirty path below is
  // already in the index (XY = " M"), which under the pre-fix rule meant
  // "in scope" and dispatched a recovery executor over a foreign file.
  writeTaskContract(stateDir, [TASK_OUTPUT]);
  const git = fakeGit({ head: HEAD_A, statusLines: [' M packages/control-loop/push.mjs'] });
  const fx = fakeGh({ gitState: git.st });
  writeExecRecord(stateDir, id);
  let calls = 0;
  const deps = loopDeps({ git, fx, executor: async () => { calls += 1; return { ok: true, value: { executionRecordPath: 'x' } }; } });

  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'COMMIT_RECOVERY_SCOPE_VIOLATION');
  assert.deepEqual(res.detail.outScope, ['packages/control-loop/push.mjs']);
  assert.equal(res.detail.recoverable, false);
  assert.equal(res.detail.resumeState, 'VERIFYING', 'typed-block BEFORE any transition');
  assert.equal(calls, 1, 'the initial walk only — no recovery executor was dispatched');
  assert.equal(git.st.pushes, 0, 'nothing was committed or pushed');
  assert.equal(recoveryRecords(stateDir, id).length, 0, 'a scope refusal never mints an attempt record');
});

test('R2f. NO declared scope: COMMIT_RECOVERY_SCOPE_UNDECLARED, never a free pass for tracked paths', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  // Deliberately NO <worktree>/.soc/task-contract.md: there is no whitelist to
  // read, so recovery must refuse instead of falling back to "tracked == ok".
  const git = fakeGit({ head: HEAD_A, statusLines: [` M ${TASK_OUTPUT}`] });
  const fx = fakeGh({ gitState: git.st });
  writeExecRecord(stateDir, id);
  let calls = 0;
  const deps = loopDeps({ git, fx, executor: async () => { calls += 1; return { ok: true, value: { executionRecordPath: 'x' } }; } });

  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'COMMIT_RECOVERY_SCOPE_UNDECLARED');
  assert.equal(res.detail.reason, 'SCOPE_UNDECLARED');
  assert.equal(res.detail.allowedPaths, null, 'no whitelist was read, and none was invented');
  assert.equal(res.detail.recoverable, false);
  assert.equal(res.detail.resumeState, 'VERIFYING');
  assert.equal(calls, 1, 'no recovery executor was dispatched');
  assert.equal(git.st.pushes, 0, 'the dirty worktree was never pushed');
  assert.equal(recoveryRecords(stateDir, id).length, 0);
});

test('R2g. reviewer prose naming a path never widens the declared scope', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  writeTaskContract(stateDir, [TASK_OUTPUT]);
  const git = fakeGit({ head: HEAD_A, statusLines: ['?? docs/new-required.md'] });
  const fx = fakeGh({ gitState: git.st });
  writeExecRecord(stateDir, id);
  let calls = 0;
  const deps = loopDeps({ git, fx, executor: async () => { calls += 1; return { ok: true, value: { executionRecordPath: 'x' } }; } });

  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'COMMIT_RECOVERY_SCOPE_VIOLATION');
  assert.deepEqual(res.detail.outScope, ['docs/new-required.md']);
  assert.equal(calls, 1, 'no recovery executor was dispatched');
  assert.equal(git.st.pushes, 0);
});

// ---------------------------------------------------------------------------
// R4. The push guard itself is untouched: a dirty worktree is still refused.
// ---------------------------------------------------------------------------
test('R4. push guard still refuses a dirty worktree (never bypassed by recovery)', () => {
  const session = { worktreePath: 'wt', branch: BRANCH, baseSha: BASE, headSha: HEAD_A };
  for (const line of [` M ${TASK_OUTPUT}`, '?? unknown-dirt.txt', ' M packages/control-loop/push.mjs']) {
    const st = { head: HEAD_A, remoteRef: null, pushes: 0 };
    const exec = (a0, opts) => {
      const a = (Array.isArray(a0) ? a0 : (opts && opts.args) || []).map(String);
      if (a[0] === 'rev-parse' && a[1] === 'HEAD') return { status: 0, stdout: `${st.head}\n`, stderr: '' };
      if (a[0] === 'status') return { status: 0, stdout: `${line}\n`, stderr: '' };
      if (a[0] === 'diff') return { status: 1, stdout: '', stderr: '' };
      if (a[0] === 'ls-remote') return { status: 0, stdout: st.remoteRef ? `${st.remoteRef}\t${a[2]}\n` : '', stderr: '' };
      if (a[0] === 'push') { st.remoteRef = a[2].split(':')[0]; st.pushes += 1; return { status: 0, stdout: '', stderr: '' }; }
      return { status: 1, stdout: '', stderr: `unmocked git: ${a.join(' ')}` };
    };
    const r = pushBranch({ session, exec });
    assert.equal(r.ok, false, line);
    assert.equal(r.code, 'PUSH_DIRTY_FOREIGN', line);
    assert.deepEqual(r.detail.foreignPaths, [line.slice(3)], line);
    assert.equal(st.pushes, 0, `nothing is pushed while dirty: ${line}`);
  }
  // Recovery never re-classifies the guard: cleanPathspecsForPush output is
  // what the scope check consumes.
  assert.deepEqual(cleanPathspecsForPush([`.soc`, 'opencode.json']), []);
});

// ---------------------------------------------------------------------------
// Pure-unit coverage of the three fail-closed decisions.
// ---------------------------------------------------------------------------
test('scope: only the DECLARED whitelist is in scope — tracked-ness and reviewer prose never authorize a path', () => {
  const statusLines = [` M ${TASK_OUTPUT}`, '?? docs/new-required.md', '?? unknown-dirt.txt', '?? .git/hooks/x', ' M ../escape.txt'];
  const declared = [TASK_OUTPUT, 'docs/new-required.md'];
  const r = classifyCommitScope({
    statusLines,
    foreignPaths: [TASK_OUTPUT, 'docs/new-required.md', 'unknown-dirt.txt', '.git/hooks/x', '../escape.txt'],
    allowedPaths: declared,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.inScope, declared);
  // A TRACKED path that the contract does not name is out of scope. This is the
  // whole of finding 1: ` M <file>` used to be treated as authorization.
  assert.deepEqual(r.outScope, ['unknown-dirt.txt']);
  assert.deepEqual(r.unclassified.sort(), ['.git/hooks/x', '../escape.txt'].sort(), 'unsafe pathspecs are refused outright, never classified into scope');
  assert.deepEqual(r.allowedPaths, declared);
  assert.deepEqual(r.trackedInScope, [TASK_OUTPUT], 'tracked-ness is recorded as evidence only');

  // Declared + tracked + safe: passes, and trackedInScope is informational.
  const good = classifyCommitScope({ statusLines: [` M ${TASK_OUTPUT}`], foreignPaths: [TASK_OUTPUT], allowedPaths: declared });
  assert.equal(good.ok, true);
  assert.deepEqual(good.inScope, [TASK_OUTPUT]);
  assert.deepEqual(good.trackedInScope, [TASK_OUTPUT]);

  // A path is in scope ONLY because the contract says so — even untracked.
  const newFile = classifyCommitScope({ statusLines: ['?? docs/new-required.md'], foreignPaths: ['docs/new-required.md'], allowedPaths: declared });
  assert.equal(newFile.ok, true);
  assert.deepEqual(newFile.inScope, ['docs/new-required.md']);
  assert.deepEqual(newFile.trackedInScope, [], 'an untracked declared path is in scope but is NOT tracked');

  // No whitelist at all -> typed UNDECLARED (never an implicit "tracked is fine").
  const undeclared = classifyCommitScope({ statusLines: [` M ${TASK_OUTPUT}`], foreignPaths: [TASK_OUTPUT], allowedPaths: null });
  assert.equal(undeclared.ok, false);
  assert.equal(undeclared.code, 'COMMIT_RECOVERY_SCOPE_UNDECLARED');
  assert.equal(undeclared.reason, 'SCOPE_UNDECLARED');
  assert.equal(undeclared.allowedPaths, null);

  const emptyList = classifyCommitScope({ statusLines: [` M ${TASK_OUTPUT}`], foreignPaths: [TASK_OUTPUT], allowedPaths: [] });
  assert.equal(emptyList.code, 'COMMIT_RECOVERY_SCOPE_UNDECLARED', 'an EMPTY whitelist is still an undeclared scope');

  // Nothing left inside the declared scope -> SCOPE_EMPTY, still a refusal.
  const nothing = classifyCommitScope({ statusLines: [], foreignPaths: [], allowedPaths: declared });
  assert.equal(nothing.ok, false);
  assert.equal(nothing.code, 'COMMIT_RECOVERY_SCOPE_EMPTY');
});

test('authority: only a terminal, unlatched, same-identity executor releases mutation authority', () => {
  const id = 'a'.repeat(64);
  const base = { identityHash: id, pid: 7, processStartTime: 1, finalized: true, pendingExecutorBind: false, cleanupRequired: false };
  assert.equal(assertPriorExecutorRelinquished({ identityHash: id, record: { ...base, terminalStatus: 'EXITED' } }).ok, true);
  assert.equal(assertPriorExecutorRelinquished({ identityHash: id, record: { ...base, terminalStatus: 'STOPPED' } }).ok, true);
  assert.equal(assertPriorExecutorRelinquished({ identityHash: id, record: { ...base, terminalStatus: 'FAILED' } }).ok, true);
  assert.equal(assertPriorExecutorRelinquished({ identityHash: id, record: { ...base, terminalStatus: 'INTERRUPTED' } }).ok, true);

  const alive = assertPriorExecutorRelinquished({ identityHash: id, record: { ...base, terminalStatus: null, finalized: false, pid: process.pid, processStartTime: null } });
  assert.equal(alive.ok, false);
  assert.equal(alive.code, 'COMMIT_RECOVERY_EXECUTOR_NOT_TERMINAL');

  const missing = assertPriorExecutorRelinquished({ identityHash: id, record: null });
  assert.equal(missing.code, 'COMMIT_RECOVERY_AUTHORITY_UNPROVEN');

  const latched = assertPriorExecutorRelinquished({ identityHash: id, record: { ...base, terminalStatus: 'EXITED', pendingExecutorBind: true } });
  assert.equal(latched.code, 'COMMIT_RECOVERY_AUTHORITY_UNPROVEN');
  assert.equal(latched.detail.reason, 'PENDING_BIND_OR_CLEANUP');

  const foreign = assertPriorExecutorRelinquished({ identityHash: id, record: { ...base, terminalStatus: 'EXITED', identityHash: 'b'.repeat(64) } });
  assert.equal(foreign.code, 'COMMIT_RECOVERY_AUTHORITY_UNPROVEN');
  assert.equal(foreign.detail.reason, 'IDENTITY_MISMATCH');
});

test('lock: one dispatch per dirty set, bounded per identity, digest is stable and head-bound', () => {
  const a = recoveryDigest({ identityHash: 'i', headSha: HEAD_A, foreignPaths: ['b.txt', 'a.txt'] });
  const b = recoveryDigest({ identityHash: 'i', headSha: HEAD_A, foreignPaths: ['a.txt', 'b.txt'] });
  assert.equal(a, b, 'path order must not change the digest');
  assert.notEqual(a, recoveryDigest({ identityHash: 'i', headSha: HEAD_B, foreignPaths: ['a.txt', 'b.txt'] }), 'a new head is a new attempt');

  const fresh = evaluateRecoveryLock({ records: [], digest: a });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.value.attempt, 1);

  const dup = evaluateRecoveryLock({ records: [{ digest: a, status: 'DISPATCHED', attempt: 1 }], digest: a });
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'COMMIT_RECOVERY_ALREADY_DISPATCHED');

  const other = evaluateRecoveryLock({ records: [{ digest: 'x'.repeat(64), status: 'DISPATCHED', attempt: 1 }], digest: a });
  assert.equal(other.ok, true, 'a different dirty set is a different attempt');
  assert.equal(other.value.attempt, 2);

  const exhausted = evaluateRecoveryLock({
    records: [{ digest: 'x'.repeat(64) }, { digest: 'y'.repeat(64) }, { digest: 'z'.repeat(64) }],
    digest: a,
  });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.code, 'COMMIT_RECOVERY_BUDGET_EXHAUSTED');
});

test('the FSM still offers no edge from VERIFYING back to EXECUTING', () => {
  assert.deepEqual([...ALLOWED_TRANSITIONS.VERIFYING].sort(), ['BLOCKED', 'PRE_REVIEWING']);
});
