#!/usr/bin/env node
// task-server-intake.test.mjs — Issue #132 rework: REAL task-server seam
// (scripts/task-server-intake.mjs claimAndIntake). Proves:
//   1. claim xong canonical session record tồn tại NGAY (identity-addressed path,
//      terminalize token bound at intake) — the seam proof;
//   2. downstream canonical reads: terminalizeDeliveredTask({repo, issueNumber})
//      resolves identity through the canonical session reader, never free-form;
//   3. legacy task (no session) fails closed with SESSION_NOT_FOUND — no backfill;
//   4. ExecutionRecord identity chain: wrong/missing execution record fails
//      closed BEFORE any remote call; the correct record carries the ONE
//      identityHash + worktreePath of the session;
//   5. delivery -> DELIVERING->COMPLETED -> persisted/read-back COMPLETED ->
//      TASK_COMPLETED exactly once; replay = zero transport attempts;
//   6. cleanup ownership: canonical cleanup removes ONLY this identity's
//      worktree + binding;
//   7. rework budget MAX_REWORK_ROUNDS = 3 gates the task-server terminalize leg
//      through the SAME crash-safe ledger the canonical rework leg uses.
// Real git fixtures + fake gh (labels + delivery) + temp worktrees/state roots.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { claimAndIntake } from '../scripts/task-server-intake.mjs';
import { provision, identityHash, cleanup } from '../packages/workspace/workspace.mjs';
import { sessionPathFor, readSessionRecord } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { dispatchPathFor, readDispatchRecords } from '../packages/telegram-dispatch/telegram-dispatch.mjs';
import { readTransitions, refreshCanonicalHead, terminalizeDeliveredTask, MAX_REWORK_ROUNDS } from '../packages/control-loop/control-loop.mjs';
import { sessionAtIntake } from '../packages/task-intake/session-at-intake.mjs';
import { fakeGh } from './fake-gh.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

const CANON = 'duongpdddic-droid/Soc_brain';
const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-tsi-'));
const TMP_ROOT = path.join(TMP, 'worktrees');
const TMP_STATE = path.join(TMP, 'state');
mkdirSync(TMP_ROOT, { recursive: true });

function makeRepo() {
  const dir = mkdtempSync(path.join(TMP, 'repo-'));
  const run = (args, cwd = dir) => {
    try {
      return execFileSync('git', args, {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_AUTHOR_NAME: 'tester', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 'tester', GIT_COMMITTER_EMAIL: 't@e.x', GIT_CONFIG_GLOBAL: '/dev/null' },
      }).trim();
    } catch (e) {
      throw new Error('git ' + args.join(' ') + ' failed: ' + ((e.stderr || '') + (e.stdout || '') || e.message));
    }
  };
  run(['init', '--initial-branch=main', dir]);
  run(['config', 'user.email', 't@e.x']);
  run(['config', 'user.name', 'tester']);
  return {
    dir, run,
    commit: (file, content) => {
      writeFileSync(path.join(dir, file), content);
      run(['add', file]);
      run(['commit', '-m', 'c']);
      return run(['rev-parse', 'HEAD']);
    },
    setRemote: (name, url) => run(['remote', 'add', name, url]),
    dispose: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

function gitIn(dir, args) {
  return execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'tester', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 'tester', GIT_COMMITTER_EMAIL: 't@e.x', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}

// fakeGhLabels — in-memory gh for the claim leg (view/edit/comment on labels).
function fakeGhLabels(initial) {
  const st = initial; // Map<number, { state, labels: string[], comments: string[] }>
  const log = [];
  return {
    st, log,
    gh(args) {
      const a = args.map(String);
      log.push(a.join(' '));
      const n = Number(a[2]);
      const it = st.get(n);
      if (a[0] === 'issue' && a[1] === 'view') {
        if (!it) return { code: 1, stdout: '', stderr: 'issue not found' };
        return { code: 0, stdout: JSON.stringify({ number: n, state: it.state, labels: it.labels.map((name) => ({ name })) }), stderr: '' };
      }
      if (a[0] === 'issue' && a[1] === 'edit') {
        for (let i = 0; i < a.length; i++) {
          if (a[i] === '--remove-label') it.labels = it.labels.filter((l) => l !== a[i + 1]);
          if (a[i] === '--add-label' && !it.labels.includes(a[i + 1])) it.labels.push(a[i + 1]);
        }
        return { code: 0, stdout: '', stderr: '' };
      }
      if (a[0] === 'issue' && a[1] === 'comment') {
        it.comments.push(a.slice(a.indexOf('--body') + 1).join(' '));
        return { code: 0, stdout: '', stderr: '' };
      }
      throw new Error('UNMOCKED gh: ' + a.join(' '));
    },
  };
}

// Canonical ExecutionRecord shape (mirror of executor-launcher's persisted
// record) — built FROM the session's own canonical values.
function writeExecRecord(stateDir, session) {
  const p = path.join(stateDir, 'executions', `${session.identityHash}.json`);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: session.identityHash,
    taskId: session.taskId, repo: session.repo, issueNumber: session.issueNumber,
    baseSha: session.baseSha, branch: session.branch, worktreePath: session.worktreePath,
    executor: 'opencode', terminalStatus: 'ok', exitCode: 0,
  }, null, 2), 'utf8');
  return p;
}

const gitTransportFor = (repo) => (args) => {
  try { return { ok: true, stdout: repo.run(args), stderr: '' }; }
  catch (e) { return { ok: false, detail: String(e.message) }; }
};


// ---- Scenario 1: legacy task (no session) — canonical terminalize fails closed
{
  const repo = makeRepo();
  const baseSha = repo.commit('opencode.json', '{}\n');
  repo.commit('README.md', 'r\n');
  repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
  repo.run(['update-ref', 'refs/remotes/origin/main', baseSha]);
  const issueNumber = 882;
  const p = provision({ worktreesRoot: TMP_ROOT, repo: CANON, issueNumber, baseSha, cwd: repo.dir });
  tru('S1 legacy provision ok', p.ok);
  const h = identityHash({ repo: CANON, issueNumber });
  const sPath = sessionPathFor({ stateDir: TMP_STATE, identityHash: h });
  tru('S1 legacy task has no canonical session', !fs.existsSync(sPath));
  const fg = fakeGh({ issue: issueNumber, headSha: baseSha, baseSha, prNumber: issueNumber });
  const t1 = await terminalizeDeliveredTask({ repo: CANON, issueNumber, stateDir: TMP_STATE, worktreesRoot: TMP_ROOT, deps: { gh: fg.gh } });
  falsy('S1 canonical terminalize fails closed on legacy task', t1.ok);
  eq('S1 reason SESSION_NOT_FOUND', t1.ok ? null : t1.code, 'SESSION_NOT_FOUND');
  tru('S1 nothing backfilled', !fs.existsSync(sPath));
  tru('S1 zero transport attempts', fg.order.length === 0);
  const t2 = await terminalizeDeliveredTask({ repo: CANON, issueNumber: 999991, stateDir: TMP_STATE, worktreesRoot: TMP_ROOT, deps: { gh: fg.gh } });
  falsy('S1 unknown issue fails closed', t2.ok);
  eq('S1 unknown-issue reason SESSION_NOT_FOUND', t2.ok ? null : t2.code, 'SESSION_NOT_FOUND');
  repo.dispose();
}

// ---- Scenario 2: REAL seam claim -> session NGAY -> lifecycle -> terminalize
{
  const repo = makeRepo();
  const baseSha = repo.commit('opencode.json', '{}\n');
  repo.commit('README.md', 'r\n');
  repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
  repo.run(['update-ref', 'refs/remotes/origin/main', baseSha]);
  const issueNumber = 881;
  const h = identityHash({ repo: CANON, issueNumber });
  const sPath = sessionPathFor({ stateDir: TMP_STATE, identityHash: h });

  // Counting fake Telegram worker spawn: records every actual worker process.
  // Passed THROUGH the seam so intake dispatches TASK_STARTED like a real run.
  let workerAttempts = 0;
  const fakeSpawn = () => { workerAttempts += 1; return { status: 0, stdout: `${JSON.stringify({ status: 'API_ACCEPTED', messageId: 1 })}\n`, stderr: '' }; };
  const dispatchOptions = { spawn: fakeSpawn, stateDir: TMP_STATE, allowNonCanonicalStateRoot: true };

  // (2a) Claim qua seam thật: label flip + marker + read-back + provision +
  // sessionAtIntake. Session PHẢI tồn tại ngay sau claim.
  const st = new Map([[issueNumber, { state: 'OPEN', labels: ['agent:cline', 'status:ready-for-cline'], comments: [] }]]);
  const fl = fakeGhLabels(st);
  const r1 = claimAndIntake({ repo: CANON, issueNumber, gh: fl.gh, git: gitTransportFor(repo), repoRoot: repo.dir, worktreesRoot: TMP_ROOT, stateDir: TMP_STATE, dispatchOptions });
  tru('S2 claimAndIntake ok', r1.status === 'CLAIMED' || r1.status === 'ALREADY_CLAIMED');
  if (r1.status !== 'CLAIMED' && r1.status !== 'ALREADY_CLAIMED') console.error('S2 claim failure:', JSON.stringify(r1, null, 2));
  eq('S2 seam flipped the claim label', st.get(issueNumber).labels.includes('status:in-progress') && !st.get(issueNumber).labels.includes('status:ready-for-cline'), true);
  eq('S2 seam posted the claim marker', st.get(issueNumber).comments.length, 1);
  eq('S2 session exists IMMEDIATELY after claim', fs.existsSync(sPath), true);
  eq('S2 seam identityHash is the canonical identity', (r1.status === 'CLAIMED' || r1.status === 'ALREADY_CLAIMED') ? r1.identityHash : null, h);
  eq('S2 seam session path matches identity chain', (r1.status === 'CLAIMED' || r1.status === 'ALREADY_CLAIMED') ? r1.sessionPath : null, sPath);
  eq('S2 terminalize token bound at intake', (r1.status === 'CLAIMED' || r1.status === 'ALREADY_CLAIMED') ? r1.tokenBound : null, true);
  const rs = readSessionRecord(sPath);
  tru('S2 session record readable at canonical path', rs.ok);
  eq('S2 session.identityHash == h', rs.ok ? rs.session.identityHash : null, h);
  eq('S2 session.worktreePath == provisioned worktree', rs.ok ? rs.session.worktreePath : null, r1.worktreePath);
  tru('S2 session.controlLoop.terminalizeToken persisted', rs.ok && typeof (rs.session.controlLoop && rs.session.controlLoop.terminalizeToken) === 'string' && rs.session.controlLoop.terminalizeToken.length > 0);
  // Idempotent re-claim (already in-progress) reuses the SAME session.
  const r2 = claimAndIntake({ repo: CANON, issueNumber, gh: fl.gh, git: gitTransportFor(repo), repoRoot: repo.dir, worktreesRoot: TMP_ROOT, stateDir: TMP_STATE });
  eq('S2 re-claim returns ALREADY_CLAIMED', r2.status, 'ALREADY_CLAIMED');
  eq('S2 re-claim posts NO extra marker', st.get(issueNumber).comments.length, 1);

  // (2b) Downstream legs read CANONICAL state — free-form arguments rejected
  // (no sessionPath/identityHash given at all here).
  const wt = r1.worktreePath;
  writeFileSync(path.join(wt, 'feature.txt'), 'f\n');
  // The executor leg commits its work INCLUDING the session's opencode.json
  // projection (canonical executor behavior) — the worktree is clean after.
  gitIn(wt, ['add', 'feature.txt']);
  gitIn(wt, ['add', 'opencode.json']);
  gitIn(wt, ['commit', '-m', 'feat: canonical task delivery (#881)']);
  const head = gitIn(wt, ['rev-parse', 'HEAD']);
  const rf = refreshCanonicalHead({ sessionPath: sPath, stateDir: TMP_STATE });
  tru('S2 canonical head refresh ok', rf.ok);
  eq('S2 session.headSha == executor head', rf.ok ? rf.value.headSha : null, head);

  // (2c) ExecutionRecord identity chain: missing/wrong record fails closed
  // BEFORE any remote call; the correct record carries the ONE chain.
  const fg = fakeGh({ issue: issueNumber, headSha: head, baseSha, prNumber: issueNumber });
  fg.state.merged = true;
  fg.state.closed = true;
  fg.state.mergeCommitOid = 'd'.repeat(40);
  const tMissing = await terminalizeDeliveredTask({ repo: CANON, issueNumber, stateDir: TMP_STATE, worktreesRoot: TMP_ROOT, deps: { gh: fg.gh } });
  falsy('S2 missing ExecutionRecord fails closed', tMissing.ok);
  eq('S2 missing-record reason EXECUTION_IDENTITY_MISSING', tMissing.ok ? null : tMissing.code, 'EXECUTION_IDENTITY_MISSING');
  eq('S2 zero gh calls before execution-chain gate', fg.order.length, 0);
  // Wrong worktree in the record (outside the chain) -> EXECUTION_IDENTITY_MISMATCH.
  writeExecRecord(TMP_STATE, { ...rs.session, worktreePath: path.join(TMP, 'not-the-worktree') });
  const tWrong = await terminalizeDeliveredTask({ repo: CANON, issueNumber, stateDir: TMP_STATE, worktreesRoot: TMP_ROOT, deps: { gh: fg.gh } });
  falsy('S2 wrong-worktree record fails closed', tWrong.ok);
  eq('S2 wrong-record reason EXECUTION_IDENTITY_MISMATCH', tWrong.ok ? null : tWrong.code, 'EXECUTION_IDENTITY_MISMATCH');
  eq('S2 still zero gh calls', fg.order.length, 0);
  // The CORRECT record: the launcher's persisted identity-chain echo.
  writeExecRecord(TMP_STATE, rs.session);

  // (2d) Canonical terminalize: DELIVERING->COMPLETED + persisted read-back +
  // TASK_COMPLETED exactly once (dispatch ledger dedupes TASK_STARTED).
  const t = await terminalizeDeliveredTask({ repo: CANON, issueNumber, stateDir: TMP_STATE, worktreesRoot: TMP_ROOT, dispatchOptions, deps: { gh: fg.gh } });
  tru('S2 canonical terminalize ok', t.ok);
  if (!t.ok) console.error('S2 terminalize failure:', JSON.stringify(t, null, 2));
  eq('S2 session COMPLETED (read-back)', JSON.parse(fs.readFileSync(sPath, 'utf8')).state, 'COMPLETED');
  tru('S2 ledger carries DELIVERING->COMPLETED', readTransitions({ stateDir: TMP_STATE, identityHash: h }).some((x) => x.from === 'DELIVERING' && x.to === 'COMPLETED'));
  eq('S2 worker attempts: TASK_STARTED + TASK_COMPLETED', workerAttempts, 2);
  const tc = readDispatchRecords(dispatchPathFor({ stateDir: TMP_STATE, identityHash: h })).filter((x) => x && x.event === 'TASK_COMPLETED');
  eq('S2 exactly one TASK_COMPLETED API_ACCEPTED', tc.filter((x) => x.status === 'API_ACCEPTED').length, 1);
  // (2e) Replay: zero transport attempts.
  const before = workerAttempts;
  const tReplay = await terminalizeDeliveredTask({ repo: CANON, issueNumber, stateDir: TMP_STATE, worktreesRoot: TMP_ROOT, deps: { gh: fg.gh } });
  tru('S2 replay ok/deduped', tReplay.ok && tReplay.value.deduped === true);
  eq('S2 replay sends ZERO transport attempts', workerAttempts - before, 0);

  // (2f) Cleanup ownership: canonical cleanup removes ONLY this identity's
  // worktree + binding (worktree clean again after the completed task).
  const c = cleanup({ worktreesRoot: TMP_ROOT, repo: CANON, issueNumber, baseSha, cwd: repo.dir });
  tru('S2 cleanup ok', c.ok);
  if (!c.ok) console.error('S2 cleanup failure:', JSON.stringify(c, null, 2));
  tru('S2 removed the worktree', Array.isArray(c.removed) && c.removed.includes('worktree'));
  tru('S2 kept the task branch', c.ok && typeof c.keptBranch === 'string' && c.keptBranch.startsWith('agent/'));
  repo.dispose();

// ---- Scenario 3: rework budget MAX_REWORK_ROUNDS gates the task-server flow
// through the SAME crash-safe ledger the canonical rework leg persists/counts.
{
  eq('S3 rework budget is 3', MAX_REWORK_ROUNDS, 3);
  const repo = makeRepo();
  const baseSha = repo.commit('opencode.json', '{}\n');
  repo.commit('README.md', 'r\n');
  repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
  repo.run(['update-ref', 'refs/remotes/origin/main', baseSha]);
  const issueNumber = 883;
  const h = identityHash({ repo: CANON, issueNumber });
  const p3 = provision({ worktreesRoot: TMP_ROOT, repo: CANON, issueNumber, baseSha, cwd: repo.dir });
  tru('S3 provision ok', p3.ok);
  const intake = sessionAtIntake({ repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir: TMP_STATE, controlCwd: repo.dir });
  tru('S3 intake ok', intake.ok);
  const sPath = sessionPathFor({ stateDir: TMP_STATE, identityHash: h });
  const s3 = readSessionRecord(sPath);
  tru('S3 session readable', s3.ok);
  // The canonical rework ledger for THIS identity: 3 persisted rounds (the
  // same layout `runReworkLeg` writes). The delivery leg must refuse.
  const reworkDir = path.join(TMP_STATE, 'control-loop', h, 'rework');
  mkdirSync(reworkDir, { recursive: true });
  for (let i = 1; i <= MAX_REWORK_ROUNDS; i++) {
    writeFileSync(path.join(reworkDir, `digest-round-${i}.json`), JSON.stringify({ round: i, source: 'task-server-flow-fixture' }), 'utf8');
  }
  writeExecRecord(TMP_STATE, s3.session);
  const fg3 = fakeGh({ issue: issueNumber, headSha: baseSha, baseSha, prNumber: issueNumber });
  fg3.state.merged = true;
  fg3.state.closed = true;
  fg3.state.mergeCommitOid = 'e'.repeat(40);
  const t3 = await terminalizeDeliveredTask({ repo: CANON, issueNumber, stateDir: TMP_STATE, worktreesRoot: TMP_ROOT, deps: { gh: fg3.gh } });
  falsy('S3 exhausted budget fails closed', t3.ok);
  eq('S3 reason REWORK_BUDGET_EXHAUSTED', t3.ok ? null : t3.code, 'REWORK_BUDGET_EXHAUSTED');
  eq('S3 budget reports rounds == max', t3.ok ? null : (t3.detail && t3.detail.rounds), MAX_REWORK_ROUNDS);
  tru('S3 zero remote calls (budget gate before verification)', fg3.order.length === 0);
  eq('S3 session NOT terminalized', JSON.parse(fs.readFileSync(sPath, 'utf8')).state !== 'COMPLETED', true);
  // 2 rounds left budget -> the same leg passes and completes (exactly-once).
  rmSync(path.join(reworkDir, 'digest-round-3.json'));
  const t4 = await terminalizeDeliveredTask({ repo: CANON, issueNumber, stateDir: TMP_STATE, worktreesRoot: TMP_ROOT, deps: { gh: fg3.gh } });
  tru('S3 within-budget terminalize ok', t4.ok);
  eq('S3 session COMPLETED after within-budget terminalize', JSON.parse(fs.readFileSync(sPath, 'utf8')).state, 'COMPLETED');
  repo.dispose();
}

// ---- summary --------------------------------------------------------------------
const pass = checks.filter((c) => c.ok).length;
for (const c of checks) if (!c.ok) console.log('FAIL', c.name, '=>', JSON.stringify(c.got), 'want', JSON.stringify(c.want));
console.log('\nTotal: ' + pass + '/' + checks.length + ' PASS');
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(pass === checks.length ? 0 : 1);

}
