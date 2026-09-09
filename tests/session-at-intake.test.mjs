#!/usr/bin/env node
// session-at-intake.test.mjs — Issue #132 regression. The task-server/worktree
// flow MUST bind the canonical ControlLoop session AT INTAKE (session exists
// immediately after claim/start, one identityHash across binding/session/FSM,
// controlLoop.terminalizeToken persisted), and the task-server terminalize leg
// must be fail-closed (token gate, remote delivery read-back) and exactly-once
// (TASK_COMPLETED dispatched once; replay dedupes with zero transport
// attempts). Legacy tasks without a canonical session are never backfilled.
// Real-FS fixtures follow the workspace/runtime-sandbox test pattern; GitHub
// is simulated by tests/fake-gh.mjs; the Telegram worker by a counting spawn.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { provision, identityHash } from '../packages/workspace/workspace.mjs';
import { sessionPathFor, readSessionRecord } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { dispatchPathFor, readDispatchRecords } from '../packages/telegram-dispatch/telegram-dispatch.mjs';
import { readTransitions, refreshCanonicalHead, terminalizeDeliveredTask } from '../packages/control-loop/control-loop.mjs';
import { sessionAtIntake, readCanonicalTask } from '../packages/task-intake/session-at-intake.mjs';
import { fakeGh } from './fake-gh.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

const CANON = 'duongpdddic-droid/Soc_brain';
const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-intake-'));
const TMP_ROOT = path.join(TMP, 'worktrees');
const TMP_STATE = path.join(TMP, 'state');
mkdirSync(TMP_ROOT, { recursive: true });

function makeRepo() {
  const dir = mkdtempSync(path.join(TMP, 'repo-'));
  const run = (args) => {
    try {
      return execFileSync('git', args, {
        cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
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

// ---- Scenario A: legacy task without intake — fail-closed, never backfilled ---
{
  const repo = makeRepo();
  const baseSha = repo.commit('opencode.json', '{}\n');
  repo.commit('README.md', 'r\n');
  repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
  // (a) intake refuses when NO canonical workspace binding exists at all.
  const hA = identityHash({ repo: CANON, issueNumber: 779 });
  const a1 = sessionAtIntake({ repo: CANON, issueNumber: 779, baseSha, worktreesRoot: TMP_ROOT, stateDir: TMP_STATE, controlCwd: repo.dir });
  falsy('no-binding intake fails closed', a1.ok);
  eq('no-binding reason', a1.ok ? null : a1.reason, 'SESSION_INTAKE_NO_BINDING');
  tru('no session backfilled (no binding)', !fs.existsSync(sessionPathFor({ stateDir: TMP_STATE, identityHash: hA })));
  // (b) provision-only legacy task (the old task-server shape): reader and
  // terminalize refuse; NOTHING is ever created for it in the state dir.
  const pB = provision({ worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: 778, baseSha, cwd: repo.dir });
  tru('legacy provision ok', pB.ok);
  const hB = identityHash({ repo: CANON, issueNumber: 778 });
  const sPathB = sessionPathFor({ stateDir: TMP_STATE, identityHash: hB });
  tru('legacy task has no canonical session', !fs.existsSync(sPathB));
  const rcB = readCanonicalTask({ repo: CANON, issueNumber: 778, stateDir: TMP_STATE, worktreesRoot: TMP_ROOT });
  falsy('legacy reader fails closed', rcB.ok);
  eq('legacy reader reason SESSION_NOT_FOUND', rcB.ok ? null : rcB.reason, 'SESSION_NOT_FOUND');
  const tB = await terminalizeDeliveredTask({ sessionPath: sPathB, identityHash: hB, stateDir: TMP_STATE, deps: { gh: () => ({ code: 0, stdout: '[]' }) } });
  falsy('legacy terminalize fails closed', tB.ok);
  eq('legacy terminalize reason SESSION_NOT_FOUND', tB.ok ? null : tB.code, 'SESSION_NOT_FOUND');
  tru('legacy terminalize did not backfill a session', !fs.existsSync(sPathB));
  repo.dispose();
}

// ---- Scenario B: full session-at-intake lifecycle (the regression) ------------
{
  const repo = makeRepo();
  const baseSha = repo.commit('opencode.json', '{}\n');
  repo.commit('README.md', 'r\n');
  repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');

  // Counting fake Telegram worker spawn: records every actual worker process.
  let workerAttempts = 0;
  const fakeSpawn = () => { workerAttempts += 1; return { status: 0, stdout: `${JSON.stringify({ status: 'API_ACCEPTED', messageId: 1 })}\n`, stderr: '' }; };
  const dispatchOptions = { spawn: fakeSpawn, stateDir: TMP_STATE, allowNonCanonicalStateRoot: true };

  // STEP 1 — claim/start (task-server): canonical workspace primitives
  // provision the worktree, then sessionAtIntake binds the canonical session.
  const p = provision({ worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: 777, baseSha, cwd: repo.dir });
  tru('provision ok', p.ok);
  const h = identityHash({ repo: CANON, issueNumber: 777 });
  const sPath = sessionPathFor({ stateDir: TMP_STATE, identityHash: h });
  tru('no session before intake', !fs.existsSync(sPath));
  const intake = sessionAtIntake({ repo: CANON, issueNumber: 777, baseSha, worktreesRoot: TMP_ROOT, stateDir: TMP_STATE, controlCwd: repo.dir, dispatchOptions });
  tru('sessionAtIntake ok', intake.ok);
  if (!intake.ok) console.error('intake failure:', JSON.stringify(intake, null, 2));
  eq('session exists IMMEDIATELY after claim/start', fs.existsSync(sPath), true);
  eq('intake returns the canonical identityHash', intake.ok ? intake.sessionAtIntake.identityHash : null, h);
  eq('intake token bound at intake', intake.ok ? intake.sessionAtIntake.tokenBound : null, true);
  eq('intake session path matches identity chain', intake.ok ? intake.sessionAtIntake.sessionPath : null, sPath);

  // STEP 2 — one identityHash across binding / session / FSM control plane.
  const rs = readSessionRecord(sPath);
  tru('session record readable', rs.ok);
  eq('session.identityHash is the canonical identityHash', rs.ok ? rs.session.identityHash : null, h);
  eq('session.taskId is repo#issue', rs.ok ? rs.session.taskId : null, `${CANON.toLowerCase()}#777`);
  eq('session.worktreePath is the provisioned worktree', rs.ok ? rs.session.worktreePath : null, p.path);
  eq('session.controlPlane.sessionPath matches', rs.ok && rs.session.controlPlane ? rs.session.controlPlane.sessionPath : null, sPath);
  tru('terminalizeToken persisted at intake', rs.ok && typeof (rs.session.controlLoop && rs.session.controlLoop.terminalizeToken) === 'string' && rs.session.controlLoop.terminalizeToken.length > 0);
  eq('binding file is identity-addressed', intake.ok ? intake.sessionAtIntake.bindingPath : null, path.join(TMP_ROOT, 'bindings', `${h}.json`));

  // STEP 3 — executor leg (canonical head refresh): the executor commits in
  // its worktree; the session head is refreshed THROUGH the canonical session.
  writeFileSync(path.join(p.path, 'feature.txt'), 'f\n');
  gitIn(p.path, ['add', 'feature.txt']);
  gitIn(p.path, ['commit', '-m', 'feat: canonical task delivery (#777)']);
  const head = gitIn(p.path, ['rev-parse', 'HEAD']);
  const rf = refreshCanonicalHead({ sessionPath: sPath, stateDir: TMP_STATE });
  tru('canonical head refresh ok', rf.ok);
  eq('session.headSha now the executor head', rf.ok ? rf.value.headSha : null, head);

  // STEP 4 — delivery happened EXTERNALLY (executor PR + human merge/close):
  // terminalize must verify it remotely with the SESSION-BOUND intake token.
  const fg = fakeGh({ issue: 777, headSha: head, baseSha, prNumber: 777 });
  fg.state.merged = true;
  fg.state.closed = true;
  fg.state.mergeCommitOid = 'd'.repeat(40);

  // STEP 4b — execution identity chain: without the executor leg's canonical
  // ExecutionRecord, terminalize fails closed BEFORE any remote call.
  const tNoExec = await terminalizeDeliveredTask({ sessionPath: sPath, identityHash: h, stateDir: TMP_STATE, deps: { gh: fg.gh } });
  falsy('no-execution-record task fails closed', tNoExec.ok);
  eq('no-execution-record reason EXECUTION_IDENTITY_MISSING', tNoExec.ok ? null : tNoExec.code, 'EXECUTION_IDENTITY_MISSING');
  eq('execution gate made NO remote call', fg.order.length, 0);
  // STEP 4c — the canonical ExecutionRecord (launcher echo, one chain) makes
  // the task terminalizable; the delivery-verification gate fires later.
  const persistedSession = JSON.parse(fs.readFileSync(sPath, 'utf8'));
  const execPath = path.join(TMP_STATE, 'executions', `${h}.json`);
  mkdirSync(path.dirname(execPath), { recursive: true });
  writeFileSync(execPath, JSON.stringify({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: h,
    taskId: persistedSession.taskId, repo: persistedSession.repo, issueNumber: persistedSession.issueNumber,
    baseSha: persistedSession.baseSha, branch: persistedSession.branch, worktreePath: persistedSession.worktreePath,
    executor: 'opencode', terminalStatus: 'ok', exitCode: 0,
  }, null, 2), 'utf8');

  // STEP 5 — a session WITHOUT the intake-bound token can never terminalize
  // (exactly the legacy shape): fail closed, no gh traffic, no backfill.
  const saved = JSON.parse(fs.readFileSync(sPath, 'utf8'));
  const savedLoop = JSON.parse(JSON.stringify(saved.controlLoop || {})); // deep copy: restore must survive the delete
  delete saved.controlLoop.terminalizeToken;
  fs.writeFileSync(sPath, `${JSON.stringify(saved, null, 2)}\n`);
  const tNoTok = await terminalizeDeliveredTask({ sessionPath: sPath, identityHash: h, stateDir: TMP_STATE, deps: { gh: fg.gh } });
  falsy('token-less session fails closed', tNoTok.ok);
  eq('token-less reason NOT_CONTROL_LOOP_BOUND', tNoTok.ok ? null : tNoTok.code, 'NOT_CONTROL_LOOP_BOUND');
  eq('token-less attempt made NO remote call', fg.order.length, 0);
  saved.controlLoop = savedLoop;
  fs.writeFileSync(sPath, `${JSON.stringify(saved, null, 2)}\n`);

  // STEP 6 — undelivered task (nothing merged on the remote): fail closed.
  const fgEarly = fakeGh({ issue: 777, headSha: head, baseSha, prNumber: 777 });
  const tEarly = await terminalizeDeliveredTask({ sessionPath: sPath, identityHash: h, stateDir: TMP_STATE, deps: { gh: fgEarly.gh } });
  falsy('undelivered task fails closed', tEarly.ok);
  eq('undelivered reason DELIVERY_PR_NOT_FOUND', tEarly.ok ? null : tEarly.code, 'DELIVERY_PR_NOT_FOUND');
  tru('session NOT terminal after failed terminalize', JSON.parse(fs.readFileSync(sPath, 'utf8')).state !== 'COMPLETED');

  // STEP 6b — the ONE canonical reader serves downstream legs over the full
  // fail-closed chain (session + identity + binding), BEFORE cleanup.
  const rcPre = readCanonicalTask({ repo: CANON, issueNumber: 777, stateDir: TMP_STATE, worktreesRoot: TMP_ROOT });
  tru('STEP 6b readCanonicalTask ok (full chain)', rcPre.ok);
  eq('STEP 6b reader identityHash matches', rcPre.ok ? rcPre.identityHash : null, h);
  tru('STEP 6b reader binding matches identity', rcPre.ok && rcPre.binding && rcPre.binding.identityHash === h);
  tru('STEP 6b reader session state readable', rcPre.ok && typeof rcPre.session.state === 'string');

  // STEP 7 — canonical terminalize on the VERIFIED delivered state (the
  // canonical ExecutionRecord from STEP 4c is already on the chain).
  const t = await terminalizeDeliveredTask({ sessionPath: sPath, identityHash: h, stateDir: TMP_STATE, dispatchOptions, deps: { gh: fg.gh } });
  tru('terminalizeDeliveredTask ok', t.ok);
  if (!t.ok) console.error('terminalize failure:', JSON.stringify(t, null, 2));
  eq('session COMPLETED after terminalize (read-back)', JSON.parse(fs.readFileSync(sPath, 'utf8')).state, 'COMPLETED');
  tru('FSM ledger carries DELIVERING->COMPLETED', readTransitions({ stateDir: TMP_STATE, identityHash: h }).some((r) => r.from === 'DELIVERING' && r.to === 'COMPLETED'));
  eq('TASK_COMPLETED dispatched exactly once (worker spawns)', workerAttempts, 2); // TASK_STARTED + TASK_COMPLETED
  const tcRecords = readDispatchRecords(dispatchPathFor({ stateDir: TMP_STATE, identityHash: h })).filter((r) => r && r.event === 'TASK_COMPLETED');
  eq('exactly one TASK_COMPLETED API_ACCEPTED record', tcRecords.filter((r) => r.status === 'API_ACCEPTED').length, 1);

  // STEP 8 — replay: further terminalize attempts NEVER send again.
  const before = workerAttempts;
  const t2 = await terminalizeDeliveredTask({ sessionPath: sPath, identityHash: h, stateDir: TMP_STATE, deps: { gh: fg.gh } });
  tru('replay returns ok/deduped', t2.ok && t2.value.deduped === true);
  const t3 = await terminalizeDeliveredTask({ sessionPath: sPath, identityHash: h, stateDir: TMP_STATE, deps: { gh: fg.gh } });
  eq('replays send ZERO transport attempts', workerAttempts - before, 0);

  // STEP 9 — post-cleanup: the canonical reader FAILS CLOSED. The canonical
  // cleanup removed the workspace binding (by design); a reader demanding the
  // full chain refuses — the terminal state lives in the session record +
  // delivery ledger, never in a re-derivable workspace.
  const rc = readCanonicalTask({ repo: CANON, issueNumber: 777, stateDir: TMP_STATE, worktreesRoot: TMP_ROOT });
  falsy('STEP 9 post-cleanup reader fails closed (binding removed)', rc.ok);
  eq('STEP 9 reader reason WORKSPACE_BINDING_UNREADABLE', rc.ok ? null : rc.reason, 'WORKSPACE_BINDING_UNREADABLE');

  // STEP 10 — contract drift at re-intake must fail closed. After the
  // canonical terminalize + cleanup (STEP 7-9) the workspace binding is
  // REMOVED by design, so re-intake hits the no-binding guard first and must
  // NEVER backfill a session for a terminalized identity.
  const drift = sessionAtIntake({ repo: CANON, issueNumber: 777, baseSha: 'a'.repeat(40), worktreesRoot: TMP_ROOT, stateDir: TMP_STATE, controlCwd: repo.dir });
  falsy('contract drift at re-intake fails closed', drift.ok);
  eq('drift reason SESSION_INTAKE_NO_BINDING (binding removed by canonical cleanup)', drift.ok ? null : drift.reason, 'SESSION_INTAKE_NO_BINDING');
  repo.dispose();
}

// ---- summary --------------------------------------------------------------------
const pass = checks.filter((c) => c.ok).length;
for (const c of checks) if (!c.ok) console.log('FAIL', c.name, '=>', JSON.stringify(c.got), 'want', JSON.stringify(c.want));
console.log('\nTotal: ' + pass + '/' + checks.length + ' PASS');
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(pass === checks.length ? 0 : 1);