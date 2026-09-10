#!/usr/bin/env node
// mutation-ownership.test.mjs — Issue #145: single mutation owner per canonical
// task attempt (North Star v2.1.0 invariant 15).
//
// Deterministic regression matrix:
//   1. first owner acquire                          -> PASS
//   2. same authorized owner resume                 -> PASS
//   3. second concurrent mutation owner             -> FAIL_CLOSED
//   4. conflict creates NO canonical mutation       -> session/ledger/HEAD unchanged
//   5. observer/read-only access (foreign lane)     -> PASS
//   6. explicit authorized transfer                 -> PASS (read-back + old lane demoted)
//   7. unauthorized takeover                        -> FAIL_CLOSED
//   8. terminal attempt cannot be revived/taken over-> FAIL_CLOSED
//   9. stale/dead PID alone grants NO ownership     -> FAIL_CLOSED
//  10. Issue #107 failure mode: two lanes, one attempt, one authority
//  11. unbound (legacy) session grants NO mutation authority; explicit adoption only
//  12. invalid lane ids fail closed
//  13. deterministic concurrent races: fresh publish / adoption / transfer
//      (two child processes, barrier-released) — exactly one PASS, persisted
//      owner IS the winner, loser MUTATION_OWNER_CONFLICT (rework F2)
//
// Follows the same real-FS pattern as runtime-sandbox.test.mjs (makeRepo,
// checks, summary). Run: node tests/mutation-ownership.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  taskStart, sessionPathFor, transferMutationOwnership,
  readSessionRecord, taskFinish, MUTATION_LANE_ID_RE,
} from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { createMcpServer } from '../packages/runtime-sandbox/mcp-server.mjs';
import { identityHash, worktreePathFor, bindingPathFor, provision } from '../packages/workspace/workspace.mjs';
import { sessionAtIntake } from '../packages/task-intake/session-at-intake.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

const CANON = 'duongpdddic-droid/Soc_brain';
const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-mown-'));
const TMP_ROOT = path.join(TMP, 'worktrees');
mkdirSync(TMP_ROOT, { recursive: true });
const MCP_ENTRYPOINT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../packages/runtime-sandbox/mcp-server.mjs');

function makeRepo() {
  const dir = mkdtempSync(path.join(TMP, 'repo-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'tester',
    GIT_AUTHOR_EMAIL: 't@e.x',
    GIT_COMMITTER_NAME: 'tester',
    GIT_COMMITTER_EMAIL: 't@e.x',
    GIT_CONFIG_GLOBAL: os.platform() === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_SYSTEM: os.platform() === 'win32' ? 'NUL' : '/dev/null',
  };
  const run = (args, cwd = dir) => {
    try {
      return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      throw new Error('git ' + args.join(' ') + ' failed: ' + ((e.stderr || '') + (e.stdout || '') + e.message));
    }
  };
  run(['init', '--initial-branch=main', dir]);
  run(['config', 'user.email', 't@e.x']);
  run(['config', 'user.name', 'tester']);
  return {
    dir, run, env,
    commit: (file, content, msg = 'c') => {
      const fp = path.join(dir, file);
      const parent = path.dirname(fp);
      if (parent !== dir) mkdirSync(parent, { recursive: true });
      writeFileSync(fp, content);
      run(['add', file]);
      run(['commit', '-m', msg]);
      return run(['rev-parse', 'HEAD']).trim();
    },
    setRemote: (name, url) => {
      try { run(['remote', 'remove', name]); } catch {}
      run(['remote', 'add', name, url]);
    },
    dispose: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

function sessionDigest(sessionPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(sessionPath)).digest('hex');
}

function makeServer(repo, result, laneId) {
  return createMcpServer({
    config: {
      ok: true,
      sessionPath: result.session.path,
      leaseToken: result.session.leaseToken,
      controlCwd: path.resolve(repo.dir),
      ...(laneId ? { laneId } : {}),
    },
  });
}

// ---- 1+2. first owner acquire PASS; same authorized owner resume PASS --------
{
  let repo;
  try {
    repo = makeRepo();
    const baseSha = repo.commit('OWN.md', 'o');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issueNumber = 1450;
    const stateDir = path.join(TMP, '_state_acquire');
    const first = taskStart({
      repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir,
      controlCwd: repo.dir, testRegistry: {}, mutationLaneId: 'lane-a',
    });
    eq('acquire taskStart ok', first.ok, true);
    if (first.ok) {
      eq('acquire owner laneId', first.session.mutationOwner, 'lane-a');
      const rec = readSessionRecord(first.session.path);
      eq('acquire owner persisted laneId', rec.session.mutationOwner && rec.session.mutationOwner.laneId, 'lane-a');
      eq('acquire owner acquiredVia', rec.session.mutationOwner && rec.session.mutationOwner.acquiredVia, 'ADMISSION');
      eq('acquire owner history empty', Array.isArray(rec.session.mutationOwner.history) && rec.session.mutationOwner.history.length, 0);
      tru('acquire mcpEnv carries SOC_LANE_ID', first.mcpEnv.SOC_LANE_ID === 'lane-a');
    }
    const resume = taskStart({
      repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir,
      controlCwd: repo.dir, testRegistry: {}, mutationLaneId: 'lane-a',
    });
    eq('resume taskStart ok', resume.ok, true);
    eq('resume idempotent', resume.ok && resume.idempotent, true);
    eq('resume owner unchanged', resume.ok && resume.session.mutationOwner, 'lane-a');
    // The lease token is NOT rotated on an authorized resume (same owner).
    eq('resume lease token unchanged', resume.ok && resume.session.leaseToken, first.ok && first.session.leaseToken);
  } finally { if (repo) repo.dispose(); }
}

// ---- 3+4. second concurrent owner FAIL_CLOSED; conflict mutates nothing ------
{
  let repo;
  try {
    repo = makeRepo();
    const baseSha = repo.commit('CONF.md', 'c');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issueNumber = 1451;
    const stateDir = path.join(TMP, '_state_conflict');
    const first = taskStart({
      repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir,
      controlCwd: repo.dir, testRegistry: {}, mutationLaneId: 'lane-a',
    });
    eq('conflict first ok', first.ok, true);
    const sp = first.ok && first.session.path;
    const h = identityHash({ repo: CANON, issueNumber });
    const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    const headBefore = repo.run(['rev-parse', 'HEAD'], wt).trim();
    const digestBefore = sessionDigest(sp);
    const lifecycleBefore = readSessionRecord(sp).session.lifecycle.length;

    const second = taskStart({
      repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir,
      controlCwd: repo.dir, testRegistry: {}, mutationLaneId: 'lane-b',
    });
    falsy('conflict second owner fails closed', second.ok);
    eq('conflict reason', second.reason, 'MUTATION_OWNER_CONFLICT');
    eq('conflict evidence names recorded owner', second.owner && second.owner.laneId, 'lane-a');
    eq('conflict evidence names presented lane', second.presented, 'lane-b');
    // No lease/token leak to the losing lane.
    tru('conflict leaks no lease token', !second.session && !second.worktree);

    // 4. Conflict created NO canonical mutation: session byte-identical, no new
    // lifecycle record, worktree HEAD unchanged, pre-existing binding intact.
    eq('conflict session unchanged (digest)', sessionDigest(sp), digestBefore);
    eq('conflict lifecycle unchanged', readSessionRecord(sp).session.lifecycle.length, lifecycleBefore);
    eq('conflict worktree HEAD unchanged', repo.run(['rev-parse', 'HEAD'], wt).trim(), headBefore);
    tru('conflict binding intact', fs.existsSync(bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h })));

    // Absent lane id against a recorded owner is ALSO a second-owner claim.
    const unnamed = taskStart({
      repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir,
      controlCwd: repo.dir, testRegistry: {},
    });
    falsy('conflict unnamed claim fails closed', unnamed.ok);
    eq('conflict unnamed reason', unnamed.reason, 'MUTATION_OWNER_CONFLICT');
    eq('conflict unnamed session unchanged', sessionDigest(sp), digestBefore);
  } finally { if (repo) repo.dispose(); }
}

// ---- 5+10. observer/read-only PASS for a foreign lane; Issue #107 regression --
// Two lanes, one canonical attempt: lane-a owns mutation authority, lane-b is
// an observer — status/diff/progress work, commit and admission fail closed.
{
  let repo;
  try {
    repo = makeRepo();
    repo.commit('rt-hello.cjs', "process.stdout.write('hi')");
    const baseSha = repo.commit('BASE.md', 'base');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issueNumber = 1452;
    const stateDir = path.join(TMP, '_state_107');
    const result = taskStart({
      repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir,
      controlCwd: repo.dir, testRegistry: { hello: { executable: 'node', argv: ['rt-hello.cjs'] } },
      mutationLaneId: 'lane-a',
    });
    eq('107 taskStart ok', result.ok, true);
    if (!result.ok) throw new Error('setup failed');
    const wt = path.dirname(result.openCodeConfigPath);
    writeFileSync(path.join(wt, 'MUTOWN.txt'), 'owned change\n');

    // Owner lane commit -> PASS (the only mutation authority).
    const ownerServer = makeServer(repo, result, 'lane-a');
    eq('107 owner server boots', ownerServer.ok, true);
    const ownerCommit = ownerServer.dispatch({ params: { name: 'soc_broker_commit', arguments: { message: 'test: owner mutation', paths: ['MUTOWN.txt'] } } });
    eq('107 owner commit ok', ownerCommit.ok, true);
    const headAfterOwner = repo.run(['rev-parse', 'HEAD'], wt).trim();
    eq('107 owner commit advanced HEAD', ownerCommit.ok && ownerCommit.data.head, headAfterOwner);

    // Foreign lane server (stale env copied from the projection): read-only PASS.
    const foreignServer = makeServer(repo, result, 'lane-b');
    eq('107 foreign server boots', foreignServer.ok, true);
    const statusCall = foreignServer.dispatch({ params: { name: 'soc_broker_status', arguments: {} } });
    eq('107 observer status ok', statusCall.ok, true);
    const diffCall = foreignServer.dispatch({ params: { name: 'soc_broker_diff', arguments: { diffMode: 'working_tree' } } });
    eq('107 observer diff ok', diffCall.ok, true);
    const testCall = foreignServer.dispatch({ params: { name: 'soc_broker_run_registered_test', arguments: { testId: 'hello' } } });
    eq('107 observer registered test ok', testCall.ok, true);
    const progCall = foreignServer.dispatch({ params: { name: 'soc_task_progress', arguments: { repo: CANON, issueNumber, executorId: 'opencode@lane-b', executionEpoch: 1, currentStep: 1, totalSteps: 1, steps: [{ index: 1, name: 'Observe', status: 'IN_PROGRESS' }] } } });
    eq('107 observer progress ok', progCall.ok, true);

    // Foreign lane mutation -> FAIL_CLOSED with typed evidence, no mutation.
    const foreignCommit = foreignServer.dispatch({ params: { name: 'soc_broker_commit', arguments: { message: 'test: foreign mutation', paths: ['BASE.md'] } } });
    falsy('107 foreign commit fails closed', foreignCommit.ok);
    eq('107 foreign commit reason', foreignCommit.reason, 'MUTATION_OWNER_CONFLICT');
    eq('107 foreign commit names owner', foreignCommit.owner, 'lane-a');
    eq('107 foreign commit names presented', foreignCommit.presented, 'lane-b');
    eq('107 foreign commit leaves HEAD', repo.run(['rev-parse', 'HEAD'], wt).trim(), headAfterOwner);

    // A lane that does not identify itself cannot mutate an owned attempt.
    const unnamedServer = makeServer(repo, result, null);
    const unnamedCommit = unnamedServer.dispatch({ params: { name: 'soc_broker_commit', arguments: { message: 'test: unnamed mutation', paths: ['BASE.md'] } } });
    falsy('107 unidentified commit fails closed', unnamedCommit.ok);
    eq('107 unidentified commit reason', unnamedCommit.reason, 'MUTATION_OWNER_UNIDENTIFIED');
    eq('107 unidentified commit leaves HEAD', repo.run(['rev-parse', 'HEAD'], wt).trim(), headAfterOwner);

    // Foreign lane FSM mutations fail closed too (canonical state is a mutation surface).
    const foreignFinish = foreignServer.dispatch({ params: { name: 'soc_broker_finish_task', arguments: { outcome: 'COMPLETED' } } });
    falsy('107 foreign finish fails closed', foreignFinish.ok);
    eq('107 foreign finish reason', foreignFinish.reason, 'MUTATION_OWNER_CONFLICT');
    const sess = readSessionRecord(result.session.path);
    eq('107 foreign finish leaves FSM', sess.session.state, 'SESSION_ACTIVE');
  } finally { if (repo) repo.dispose(); }
}

// ---- 6+7. explicit authorized transfer PASS; unauthorized takeover FAIL -------
{
  let repo;
  try {
    repo = makeRepo();
    repo.commit('rt-hello.cjs', "process.stdout.write('hi')");
    const baseSha = repo.commit('XFER.md', 'x');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issueNumber = 1453;
    const stateDir = path.join(TMP, '_state_transfer');
    const result = taskStart({
      repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir,
      controlCwd: repo.dir, testRegistry: {}, mutationLaneId: 'lane-a',
    });
    eq('transfer taskStart ok', result.ok, true);
    if (!result.ok) throw new Error('setup failed');
    const wt = path.dirname(result.openCodeConfigPath);
    writeFileSync(path.join(wt, 'POSTXFER.txt'), 'after transfer\n');

    // Unauthorized takeover: a lane that is not the recorded owner cannot move it.
    const rogue = transferMutationOwnership({ sessionPath: result.session.path, fromLaneId: 'lane-x', toLaneId: 'lane-z' });
    falsy('transfer rogue fromLane fails closed', rogue.ok);
    eq('transfer rogue reason', rogue.reason, 'MUTATION_OWNER_CONFLICT');
    eq('transfer rogue names owner', rogue.owner && rogue.owner.laneId, 'lane-a');
    // No dead-pid/timeout inference: there is no pid-based takeover argument.
    tru('transfer record carries no pid fields', rogue.owner && !('pid' in rogue.owner) && !('pid' in (readSessionRecord(result.session.path).session.mutationOwner || {})));

    // Explicit authorized transfer lane-a -> lane-b: persisted + read back.
    const t = transferMutationOwnership({ sessionPath: result.session.path, fromLaneId: 'lane-a', toLaneId: 'lane-b', via: 'operator-dispatch' });
    eq('transfer ok', t.ok, true);
    eq('transfer toLane persisted', readSessionRecord(result.session.path).session.mutationOwner.laneId, 'lane-b');
    eq('transfer acquiredVia', readSessionRecord(result.session.path).session.mutationOwner.acquiredVia, 'TRANSFER');
    const hist = readSessionRecord(result.session.path).session.mutationOwner.history;
    eq('transfer history names the old lane', hist.length, 1);
    eq('transfer history entry lane', hist[0] && hist[0].laneId, 'lane-a');
    eq('transfer history via', hist[0] && hist[0].via, 'operator-dispatch');

    // New owner continues (resume PASS) and mutates; old lane is demoted.
    const resumed = taskStart({
      repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir,
      controlCwd: repo.dir, testRegistry: {}, mutationLaneId: 'lane-b',
    });
    eq('transfer resume as new owner ok', resumed.ok, true);
    const newOwnerServer = makeServer(repo, result, 'lane-b');
    const bCommit = newOwnerServer.dispatch({ params: { name: 'soc_broker_commit', arguments: { message: 'test: successor mutation', paths: ['POSTXFER.txt'] } } });
    eq('transfer successor commit ok', bCommit.ok, true);
    const oldOwnerServer = makeServer(repo, result, 'lane-a');
    const aCommit = oldOwnerServer.dispatch({ params: { name: 'soc_broker_commit', arguments: { message: 'test: demoted owner mutation', paths: ['XFER.md'] } } });
    falsy('transfer old owner demoted (fail closed)', aCommit.ok);
    eq('transfer old owner reason', aCommit.reason, 'MUTATION_OWNER_CONFLICT');
    // The demoted lane cannot re-acquire through admission either.
    const reacquire = taskStart({
      repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir,
      controlCwd: repo.dir, testRegistry: {}, mutationLaneId: 'lane-a',
    });
    falsy('transfer old owner re-admission fails closed', reacquire.ok);
    eq('transfer re-admission reason', reacquire.reason, 'MUTATION_OWNER_CONFLICT');
    // Transfer is not repeatable by the demoted lane.
    const back = transferMutationOwnership({ sessionPath: result.session.path, fromLaneId: 'lane-a', toLaneId: 'lane-a2' });
    falsy('transfer by demoted lane fails closed', back.ok);
  } finally { if (repo) repo.dispose(); }
}

// ---- 8. terminal attempt cannot be revived or taken over ----------------------
{
  let repo;
  try {
    repo = makeRepo();
    const baseSha = repo.commit('TERM.md', 't');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issueNumber = 1454;
    const stateDir = path.join(TMP, '_state_terminal');
    const result = taskStart({
      repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir,
      controlCwd: repo.dir, testRegistry: {}, mutationLaneId: 'lane-a',
    });
    eq('terminal taskStart ok', result.ok, true);
    if (!result.ok) throw new Error('setup failed');
    const fin = taskFinish({ sessionPath: result.session.path, outcome: 'COMPLETED' });
    eq('terminal taskFinish ok', fin.ok, true);
    const digest = sessionDigest(result.session.path);
    const revive = taskStart({
      repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir,
      controlCwd: repo.dir, testRegistry: {}, mutationLaneId: 'lane-a',
    });
    falsy('terminal revive by SAME owner fails closed', revive.ok);
    eq('terminal revive reason', revive.reason, 'SESSION_ALREADY_TERMINAL');
    const takeover = taskStart({
      repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir,
      controlCwd: repo.dir, testRegistry: {}, mutationLaneId: 'lane-b',
    });
    falsy('terminal takeover by foreign lane fails closed', takeover.ok);
    eq('terminal takeover reason', takeover.reason, 'SESSION_ALREADY_TERMINAL');
    const xfer = transferMutationOwnership({ sessionPath: result.session.path, fromLaneId: 'lane-a', toLaneId: 'lane-b' });
    falsy('terminal transfer fails closed', xfer.ok);
    eq('terminal transfer reason', xfer.reason, 'SESSION_ALREADY_TERMINAL');
    eq('terminal session untouched', sessionDigest(result.session.path), digest);
  } finally { if (repo) repo.dispose(); }
}

// ---- 9. stale/dead PID alone grants NO ownership ------------------------------
// A dead executor process (INTERRUPTED ExecutionRecord projection) is process
// mechanics, never ownership evidence: the recorded owner keeps the authority
// and every foreign/stale claim still fails closed.
{
  let repo;
  try {
    repo = makeRepo();
    repo.commit('rt-hello.cjs', "process.stdout.write('hi')");
    const baseSha = repo.commit('PID.md', 'p');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issueNumber = 1455;
    const stateDir = path.join(TMP, '_state_pid');
    const result = taskStart({
      repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir,
      controlCwd: repo.dir, testRegistry: {}, mutationLaneId: 'lane-a',
    });
    eq('pid taskStart ok', result.ok, true);
    if (!result.ok) throw new Error('setup failed');
    // Simulate a dead executor: an ExecutionRecord whose pid is gone.
    const execDir = path.join(stateDir, 'executions');
    mkdirSync(execDir, { recursive: true });
    const h = identityHash({ repo: CANON, issueNumber });
    writeFileSync(path.join(execDir, `${h}.json`), JSON.stringify({
      schemaVersion: '1', kind: 'ExecutionRecord', identityHash: h,
      repo: CANON, issueNumber, pid: 999999, terminalStatus: null, finalized: false,
    }, null, 2) + '\n');
    // Dead pid evidence does not free the attempt: foreign lane still refused.
    const foreign = taskStart({
      repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir,
      controlCwd: repo.dir, testRegistry: {}, mutationLaneId: 'lane-b',
    });
    falsy('pid foreign claim fails closed despite dead executor', foreign.ok);
    eq('pid foreign reason', foreign.reason, 'MUTATION_OWNER_CONFLICT');
    // And the stale FIRST lane id (owner already transferred) is equally dead.
    const t = transferMutationOwnership({ sessionPath: result.session.path, fromLaneId: 'lane-a', toLaneId: 'lane-b' });
    eq('pid transfer to successor ok', t.ok, true);
    const stale = transferMutationOwnership({ sessionPath: result.session.path, fromLaneId: 'lane-a', toLaneId: 'lane-c' });
    falsy('pid stale owner claim fails closed', stale.ok);
    eq('pid stale reason', stale.reason, 'MUTATION_OWNER_CONFLICT');
  } finally { if (repo) repo.dispose(); }
}

// ---- 11+12+13. legacy behavior, adoption, invalid lane ids --------------------
{
  let repo;
  try {
    repo = makeRepo();
    repo.commit('rt-hello.cjs', "process.stdout.write('hi')");
    const baseSha = repo.commit('LEG.md', 'l');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issueNumber = 1456;
    const stateDir = path.join(TMP, '_state_legacy');
    const first = taskStart({
      repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir,
      controlCwd: repo.dir, testRegistry: {},
    });
    eq('legacy taskStart ok', first.ok, true);
    eq('legacy session has no owner', first.ok && first.session.mutationOwner, null);
    const again = taskStart({
      repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir,
      controlCwd: repo.dir, testRegistry: {},
    });
    eq('legacy resume ok (unchanged pre-#145 behavior)', again.ok && again.idempotent, true);
    // Rework F1: an UNBOUND attempt grants NO mutation authority to anyone.
    const legacyServer = makeServer(repo, first, null);
    const wt = path.dirname(first.openCodeConfigPath);
    writeFileSync(path.join(wt, 'LEGCOMMIT.txt'), 'legacy\n');
    const legacyCommit = legacyServer.dispatch({ params: { name: 'soc_broker_commit', arguments: { message: 'test: unbound mutation', paths: ['LEGCOMMIT.txt'] } } });
    falsy('unbound MCP commit denied (F1: no anonymous authority)', legacyCommit.ok);
    eq('unbound MCP commit reason', legacyCommit.reason, 'MUTATION_OWNER_UNBOUND');
    eq('unbound commit leaves HEAD', repo.run(['rev-parse', 'HEAD'], wt).trim(), baseSha);
    const legacyFinish = legacyServer.dispatch({ params: { name: 'soc_broker_finish_task', arguments: { outcome: 'COMPLETED' } } });
    falsy('unbound MCP finish denied', legacyFinish.ok);
    eq('unbound MCP finish reason', legacyFinish.reason, 'MUTATION_OWNER_UNBOUND');
    eq('unbound finish leaves FSM', readSessionRecord(first.session.path).session.state, 'SESSION_ACTIVE');
    // Observers stay observer-class on an unbound attempt (read-only, no gate).
    const legacyStatus = legacyServer.dispatch({ params: { name: 'soc_broker_status', arguments: {} } });
    eq('unbound observer status ok (F1: read-only ungated)', legacyStatus.ok, true);

    // Adoption: a named lane upgrades a legacy session explicitly.
    const adopt = taskStart({
      repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir,
      controlCwd: repo.dir, testRegistry: {}, mutationLaneId: 'lane-a',
    });
    eq('adoption taskStart ok', adopt.ok, true);
    eq('adoption binds the named lane', adopt.ok && adopt.session.mutationOwner, 'lane-a');
    eq('adoption persisted acquiredVia', readSessionRecord(adopt.session.path).session.mutationOwner.acquiredVia, 'ADOPTION');
    // After adoption the pre-adoption unnamed claim becomes a conflict.
    const postUnnamed = taskStart({
      repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir,
      controlCwd: repo.dir, testRegistry: {},
    });
    falsy('adoption unnamed claim fails closed', postUnnamed.ok);
    eq('adoption unnamed reason', postUnnamed.reason, 'MUTATION_OWNER_CONFLICT');

    // Invalid lane ids fail closed before any artifact is created.
    for (const bad of ['', '  x', 'a b', 'x'.repeat(201), '../evil']) {
      const badStart = taskStart({
        repo: CANON, issueNumber: 1457, baseSha, worktreesRoot: TMP_ROOT, stateDir,
        controlCwd: repo.dir, testRegistry: {}, mutationLaneId: bad,
      });
      falsy(`invalid lane rejected: ${JSON.stringify(bad.slice(0, 12))}`, badStart.ok);
      eq(`invalid lane reason: ${JSON.stringify(bad.slice(0, 12))}`, badStart.reason, 'MUTATION_LANE_ID_INVALID');
    }
    tru('MUTATION_LANE_ID_RE accepts canonical executor id shape', MUTATION_LANE_ID_RE.test('opencode@session-1') && MUTATION_LANE_ID_RE.test('task-server-intake:145'));
    tru('MUTATION_LANE_ID_RE rejects path/control shapes', !MUTATION_LANE_ID_RE.test('a/b') && !MUTATION_LANE_ID_RE.test('a b') && !MUTATION_LANE_ID_RE.test('-x'));
    const badXfer = transferMutationOwnership({ sessionPath: path.join(stateDir, 'sessions', 'nope.json'), fromLaneId: 'a', toLaneId: 'b' });
    falsy('transfer on missing session fails closed', badXfer.ok);
    eq('transfer missing session reason', badXfer.reason, 'SESSION_NOT_FOUND');
  } finally { if (repo) repo.dispose(); }
}

// ---- session-at-intake seam carries the same gate ------------------------------
{
  let repo;
  try {
    repo = makeRepo();
    const baseSha = repo.commit('INTAKE.md', 'i');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issueNumber = 1458;
    const stateDir = path.join(TMP, '_state_intake');
    const p = provision({ worktreesRoot: TMP_ROOT, repo: CANON, issueNumber, baseSha, cwd: repo.dir });
    eq('intake provision ok', p.ok, true);
    const a = sessionAtIntake({ repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir, controlCwd: repo.dir, mutationLaneId: 'lane-a' });
    eq('intake lane-a ok', a.ok, true);
    eq('intake owner bound', a.ok && a.session.mutationOwner, 'lane-a');
    const b = sessionAtIntake({ repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir, controlCwd: repo.dir, mutationLaneId: 'lane-b' });
    falsy('intake second lane fails closed', b.ok);
    eq('intake second lane reason', b.reason, 'MUTATION_OWNER_CONFLICT');
  } finally { if (repo) repo.dispose(); }
}

// ---- end-to-end MCP transport: foreign lane over real stdio JSON-RPC ----------
{
  let repo;
  try {
    repo = makeRepo();
    const baseSha = repo.commit('E2E.md', 'e');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issueNumber = 1459;
    const stateDir = path.join(TMP, '_state_e2e');
    const result = taskStart({
      repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir,
      controlCwd: repo.dir, testRegistry: {}, mutationLaneId: 'lane-a',
    });
    eq('e2e taskStart ok', result.ok, true);
    if (!result.ok) throw new Error('setup failed');
    const wt = path.dirname(result.openCodeConfigPath);
    writeFileSync(path.join(wt, 'E2EOWN.txt'), 'owned\n');
    // Foreign lane process: full env of the owner projection but ITS lane id.
    const env = {
      ...process.env,
      SOC_SESSION_PATH: result.session.path,
      SOC_SESSION_TOKEN: result.session.leaseToken,
      SOC_CONTROL_CWD: path.resolve(repo.dir),
      SOC_LANE_ID: 'lane-b',
    };
    const reqs = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'soc_broker_status', arguments: {} } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'soc_broker_commit', arguments: { message: 'test: e2e foreign', paths: ['E2EOWN.txt'] } } },
    ].map((o) => JSON.stringify(o)).join('\n') + '\n';
    const r = spawnSync(process.execPath, [MCP_ENTRYPOINT], { input: reqs, cwd: wt, encoding: 'utf8', env, timeout: 60000 });
    eq('e2e exit 0', r.status, 0);
    const lines = String(r.stdout || '').trim().split('\n').map((l) => JSON.parse(l));
    eq('e2e response count', lines.length, 3);
    const byId = new Map(lines.map((l) => [l.id, l]));
    eq('e2e foreign status ok', JSON.parse(byId.get(2).result.content[0].text).ok, true);
    const commit = JSON.parse(byId.get(3).result.content[0].text);
    falsy('e2e foreign commit fails closed', commit.ok);
    eq('e2e foreign commit reason', commit.reason, 'MUTATION_OWNER_CONFLICT');
    eq('e2e foreign commit isError', byId.get(3).result.isError, true);
  } finally { if (repo) repo.dispose(); }
}

// ---- rework F2: deterministic concurrent races --------------------------------
// True cross-process races (two child processes, barrier-released together)
// over ONE canonical attempt: fresh publish, adoption, transfer. The invariant
// under every race: EXACTLY ONE lane wins, the persisted owner IS the winner,
// and the loser fails closed MUTATION_OWNER_CONFLICT — never last-writer-wins.
const RS_MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/runtime-sandbox/runtime-sandbox.mjs');
const RACER_SRC = `
import fs from 'node:fs';
const { taskStart, transferMutationOwnership } = await import('file:///${RS_MODULE.replace(/\\/g, '/')}');
const [mode, repoDir, worktreesRoot, stateDir, issueStr, baseSha, laneSelf, barrier, resultFile, sessionPath] = process.argv.slice(2);
while (!fs.existsSync(barrier)) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }
let r;
try {
  if (mode === 'fresh' || mode === 'adopt') {
    r = taskStart({ repo: 'duongpdddic-droid/Soc_brain', issueNumber: Number(issueStr), baseSha, worktreesRoot, stateDir, controlCwd: repoDir, testRegistry: {}, mutationLaneId: laneSelf });
  } else if (mode === 'transfer') {
    r = transferMutationOwnership({ sessionPath, fromLaneId: 'lane-a', toLaneId: laneSelf });
  } else {
    r = { ok: false, reason: 'UNKNOWN_MODE' };
  }
} catch (e) {
  r = { ok: false, reason: 'RACER_THREW', detail: String((e && e.message) || e) };
}
fs.writeFileSync(resultFile, JSON.stringify(r));
process.exit(0);
`;
const RACER_FILE = path.join(TMP, 'racer.mjs');
writeFileSync(RACER_FILE, RACER_SRC);

function runRace({ repo, mode, issueNumber, baseSha, stateDir, lanes, sessionPath = null }) {
  const barrier = path.join(TMP, `barrier-${mode}-${issueNumber}-${lanes.join('-')}`);
  try { rmSync(barrier, { force: true }); } catch {}
  const results = lanes.map((laneSelf) => path.join(TMP, `result-${mode}-${issueNumber}-${laneSelf}.json`));
  for (const f of results) { try { rmSync(f, { force: true }); } catch {} }
  const children = lanes.map((laneSelf, i) => spawn(process.execPath, [
    RACER_FILE, mode, repo.dir, TMP_ROOT, stateDir, String(issueNumber), baseSha, laneSelf,
    barrier, results[i], sessionPath || '',
  ], { env: { ...process.env, ...repo.env }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }));
  // Both children are polling; release them together.
  writeFileSync(barrier, 'go');
  return Promise.all(children.map((c, i) => new Promise((resolve) => {
    let stderr = '';
    if (c.stderr) c.stderr.on('data', (d) => { stderr += String(d); });
    c.on('exit', () => {
      let parsed = null;
      for (let t = 0; t < 50 && !parsed; t++) {
        try { parsed = JSON.parse(fs.readFileSync(results[i], 'utf8')); } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
      }
      resolve({ lane: lanes[i], result: parsed, stderr });
    });
  })));
}

function assertRaceOutcome(name, outcomes, winnerHint, stateDir, issueNumber) {
  const oks = outcomes.filter((o) => o.result && o.result.ok === true);
  const losers = outcomes.filter((o) => !o.result || o.result.ok !== true);
  eq(`${name}: exactly one winner`, oks.length, 1);
  eq(`${name}: loser count`, losers.length, outcomes.length - 1);
  for (const l of losers) {
    eq(`${name}: loser ${l.lane} fails closed as MUTATION_OWNER_CONFLICT`,
      l.result ? l.result.reason : `NO_RESULT(${String(l.stderr).slice(0, 120)})`, 'MUTATION_OWNER_CONFLICT');
  }
  const winner = oks[0];
  const persisted = readSessionRecord(path.join(stateDir, 'sessions', `${identityHash({ repo: CANON, issueNumber })}.json`));
  eq(`${name}: persisted owner is the winner`,
    persisted.ok && persisted.session.mutationOwner && persisted.session.mutationOwner.laneId,
    winner ? winner.lane : null);
  if (winnerHint) eq(`${name}: winner lane`, winner ? winner.lane : null, winnerHint);
  return winner;
}

// Race 1: concurrent FRESH claims (A vs B) on one canonical attempt.
{
  let repo;
  try {
    repo = makeRepo();
    const baseSha = repo.commit('RACEFRESH.md', 'r');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issueNumber = 1461;
    const stateDir = path.join(TMP, '_state_racefresh');
    // Pre-provision the workspace so both children race ONLY the session publish.
    const p = provision({ worktreesRoot: TMP_ROOT, repo: CANON, issueNumber, baseSha, cwd: repo.dir });
    eq('race-fresh provision ok', p.ok, true);
    const outcomes = await runRace({ repo, mode: 'fresh', issueNumber, baseSha, stateDir, lanes: ['lane-a', 'lane-b'] });
    const winner = assertRaceOutcome('race-fresh', outcomes, null, stateDir, issueNumber);
    // The loser holds NO usable mutation authority: a server with ITS lane env
    // is denied at every mutation surface against the winner-owned attempt.
    if (winner) {
      const loserLane = outcomes.find((o) => o.lane !== winner.lane).lane;
      const rec = readSessionRecord(path.join(stateDir, 'sessions', `${identityHash({ repo: CANON, issueNumber })}.json`));
      const loserServer = createMcpServer({
        config: { ok: true, sessionPath: rec.session.controlPlane.sessionPath, leaseToken: rec.session.lease.token, controlCwd: path.resolve(repo.dir), laneId: loserLane },
      });
      const wt = path.dirname(rec.session.projection.path);
      writeFileSync(path.join(wt, 'RACELOSER.txt'), 'loser\n');
      const lc = loserServer.dispatch({ params: { name: 'soc_broker_commit', arguments: { message: 'test: race loser mutation', paths: ['RACELOSER.txt'] } } });
      falsy('race-fresh loser commit denied', lc.ok);
      eq('race-fresh loser commit reason', lc.reason, 'MUTATION_OWNER_CONFLICT');
      eq('race-fresh loser leaves HEAD', repo.run(['rev-parse', 'HEAD'], wt).trim(), baseSha);
      // Same-owner resume of the winner stays legal.
      const resume = taskStart({ repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir, controlCwd: repo.dir, testRegistry: {}, mutationLaneId: winner.lane });
      eq('race-fresh winner resume ok', resume.ok, true);
    }
  } finally { if (repo) repo.dispose(); }
}

// Race 2: concurrent ADOPTION claims (A vs B) on an unbound legacy attempt.
{
  let repo;
  try {
    repo = makeRepo();
    const baseSha = repo.commit('RACEADOPT.md', 'r');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issueNumber = 1462;
    const stateDir = path.join(TMP, '_state_raceadopt');
    const unbound = taskStart({ repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir, controlCwd: repo.dir, testRegistry: {} });
    eq('race-adopt unbound admission ok', unbound.ok, true);
    eq('race-adopt unbound has no owner', unbound.ok && unbound.session.mutationOwner, null);
    const outcomes = await runRace({ repo, mode: 'adopt', issueNumber, baseSha, stateDir, lanes: ['lane-a', 'lane-b'] });
    assertRaceOutcome('race-adopt', outcomes, null, stateDir, issueNumber);
  } finally { if (repo) repo.dispose(); }
}

// Race 3: concurrent TRANSFER (owner lane-a -> lane-b and -> lane-c at once).
// No last-writer-wins: exactly one transfer applies, the other sees the
// authoritative owner already changed and fails closed.
{
  let repo;
  try {
    repo = makeRepo();
    const baseSha = repo.commit('RACEXFER.md', 'r');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issueNumber = 1463;
    const stateDir = path.join(TMP, '_state_racexfer');
    const owned = taskStart({ repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir, controlCwd: repo.dir, testRegistry: {}, mutationLaneId: 'lane-a' });
    eq('race-xfer owned admission ok', owned.ok, true);
    const sp = owned.ok && owned.session.path;
    const outcomes = await runRace({ repo, mode: 'transfer', issueNumber, baseSha, stateDir, lanes: ['lane-b', 'lane-c'], sessionPath: sp });
    assertRaceOutcome('race-xfer', outcomes, null, stateDir, issueNumber);
    const hist = readSessionRecord(sp).session.mutationOwner.history;
    eq('race-xfer history carries exactly one prior owner', Array.isArray(hist) && hist.length, 1);
    eq('race-xfer history prior owner is lane-a', hist[0] && hist[0].laneId, 'lane-a');
  } finally { if (repo) repo.dispose(); }
}

// ---- summary -------------------------------------------------------------------
let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}` + (c.ok ? '' : `  got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`));
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed (Issue #145 mutation ownership)`);
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
if (failed > 0) process.exit(1);
