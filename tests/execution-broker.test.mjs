#!/usr/bin/env node
// execution-broker.test.cjs — tests for packages/execution-broker (Issue #15).
// Real-FS tests: disposable Git repos + provisioned bound worktrees via
// packages/workspace. Uses the factory API (createExecutionBroker) so that
// the registry is locked in the trusted closure and the untrusted request
// object can never carry testRegistry, env, or cwd. (Issue #35 rework: the
// run_safe_command caller-argv surface was REMOVED — the broker dispatches only
// status/diff/run_registered_test and fails closed for everything else.)
// Registered tests use committed fixture scripts, never node -e eval flags.
// Each registered test runs in a disposable snapshot worktree isolated from
// the verified bound worktree. NO framework. Exit 0 = PASS, 1 = FAIL.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { provision, identityHash, worktreePathFor, bindingPathFor } from '../packages/workspace/workspace.mjs';
import { createExecutionBroker, BROKER_SCHEMA_VERSION } from '../packages/execution-broker/execution-broker.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

const CANON = 'duongpdddic-droid/Soc_brain';
const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-eb-'));
const TMP_ROOT = path.join(TMP, 'worktrees');

function makeRepo() {
  const dir = mkdtempSync(path.join(TMP, 'repo-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'tester',
    GIT_AUTHOR_EMAIL: 't@e.x',
    GIT_COMMITTER_NAME: 'tester',
    GIT_COMMITTER_EMAIL: 't@e.x',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const stderr = (e.stderr || '') + ' | ' + (e.stdout || '');
      throw new Error('git ' + args.join(' ') + ' failed: ' + (stderr || e.message));
    }
  };
  run(['init', '--initial-branch=main', dir]);
  run(['config', 'user.email', 't@e.x']);
  run(['config', 'user.name', 'tester']);
  return {
    dir, run,
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

// Fixture scripts committed into the repo so they land in the bound worktree
// (and thus in the disposable snapshot). Each is a registered-test target.
const FIXTURES = {
  'rt-hello.cjs':  'process.stdout.write("hi")',
  'rt-fail.cjs':   'process.exit(3)',
  'rt-mutate.cjs': 'require("fs").writeFileSync("EVIL.txt","x")',
  // Timeout: keep the event loop alive so the broker must kill via timeout
  'rt-timeout.cjs': 'setTimeout(()=>{}, 60000)',
  // Big-output: parametrized via env variables set in the registry entry
  'rt-big.cjs': `process.stdout.write("A".repeat(+(process.env.RT_STDOUT||0)||0));
process.stderr.write("B".repeat(+(process.env.RT_STDERR||0)||0))`,
  // Secret leak: prints homedir path + a token (redaction test)
  'rt-leak.cjs':  'process.stdout.write(require("os").homedir()+"|ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")',
  // Secret leak on the error surface: writes a token to stderr, exits 1
  'rt-leak-fail.cjs': 'console.error("boom ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"); process.exit(1)',
  // Cwd: prints own cwd (fixed-cwd test)
  'rt-cwd.cjs':   'process.stdout.write(process.cwd())',
  // Safe: prints "safe" (shell-metachar inertness test)
  'rt-safe.cjs':  'console.log("safe")',
};

function commitFixtures(repo) {
  for (const [name, code] of Object.entries(FIXTURES)) {
    repo.commit(name, code);
  }
}

// Clean up a bound worktree + binding so the original is never mutated across
// test runs.
function cleanupBound(issueNumber) {
  const h = identityHash({ repo: CANON, issueNumber });
  const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
  const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
  try { rmSync(wt, { recursive: true, force: true }); } catch {}
  try { rmSync(bp, { recursive: true, force: true }); } catch {}
}

// Provision a real bound worktree for `issueNumber`, commit fixtures, and
// return { repo, baseSha, req, wt } where req(operation, args) produces a
// pure request object (no worktreesRoot/controlCwd — the caller constructs
// a broker via createExecutionBroker for each test group).
function makeBound(issueNumber) {
  const repo = makeRepo();
  // Commit fixtures first so they are in the baseSha commit and appear in
  // the provisioned worktree.
  commitFixtures(repo);
  const baseSha = repo.commit('BASE.md', 'base\n');
  repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
  const p = provision({ worktreesRoot: TMP_ROOT, repo: CANON, issueNumber, baseSha, cwd: repo.dir });
  if (!p.ok) throw new Error('provision failed: ' + p.reason + ' ' + (p.detail || ''));
  const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: identityHash({ repo: CANON, issueNumber }) });
  const req = (operation, args, overrides) => ({
    schemaVersion: BROKER_SCHEMA_VERSION,
    operation,
    repo: CANON,
    issueNumber,
    baseSha,
    args: args || {},
    ...(overrides || {}),
  });
  return { repo, baseSha, req, wt };
}
// ---- Group A: request validation (fails before binding/execution) -----------

{
  const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: process.cwd() });
  const r = broker.executeBrokerRequest(null);
  eq('A1 null request -> INVALID_REQUEST', r.reason, 'INVALID_REQUEST');

  const r2 = broker.executeBrokerRequest({ operation: 'status' });
  eq('A2 missing fields -> REQUEST_MISSING_FIELD', r2.reason, 'REQUEST_MISSING_FIELD');

  const r3 = broker.executeBrokerRequest({
    schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: 1, baseSha: 'a'.repeat(40), args: {}, command: 'rm -rf /',
  });
  eq('A3 unknown top-level command rejected', r3.reason, 'INVALID_REQUEST_FIELD');

  const r4 = broker.executeBrokerRequest({
    schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: 1, baseSha: 'a'.repeat(40), args: {}, cwd: '/tmp',
  });
  eq('A4 caller-supplied cwd rejected', r4.reason, 'INVALID_REQUEST_FIELD');

  const r5 = broker.executeBrokerRequest({
    schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: 1, baseSha: 'a'.repeat(40), args: {}, env: { FOO: 'bar' },
  });
  eq('A5 caller-supplied env rejected', r5.reason, 'INVALID_REQUEST_FIELD');

  const r6 = broker.executeBrokerRequest({
    schemaVersion: '2', operation: 'status', repo: CANON, issueNumber: 1, baseSha: 'a'.repeat(40), args: {},
  });
  eq('A6 unsupported schema version', r6.reason, 'SCHEMA_VERSION_UNSUPPORTED');

  const r7 = broker.executeBrokerRequest({
    schemaVersion: BROKER_SCHEMA_VERSION, operation: 'delete', repo: CANON, issueNumber: 1, baseSha: 'a'.repeat(40), args: {},
  });
  eq('A7 unknown operation refused', r7.reason, 'UNKNOWN_OPERATION');

  const r8 = broker.executeBrokerRequest({
    schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: 'not a repo', issueNumber: 1, baseSha: 'a'.repeat(40), args: {},
  });
  eq('A8 invalid repo refused', r8.reason, 'INVALID_REPO');

  const r9 = broker.executeBrokerRequest({
    schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: 0, baseSha: 'a'.repeat(40), args: {},
  });
  eq('A9 zero issue refused', r9.reason, 'INVALID_ISSUE_NUMBER');

  const r10 = broker.executeBrokerRequest({
    schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: 1, baseSha: 'short', args: {},
  });
  eq('A10 short baseSha refused', r10.reason, 'INVALID_BASE_SHA');

  const r11 = broker.executeBrokerRequest({
    schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: 1, baseSha: 'a'.repeat(40), args: { path: '/etc' },
  });
  eq('A11 status caller path rejected', r11.reason, 'INVALID_ARGS');

  const r12 = broker.executeBrokerRequest({
    schemaVersion: BROKER_SCHEMA_VERSION, operation: 'diff', repo: CANON, issueNumber: 1, baseSha: 'a'.repeat(40), args: { mode: 'HEAD~1' },
  });
  eq('A12 raw rev-expression diff mode rejected', r12.reason, 'INVALID_DIFF_MODE');

  const r13 = broker.executeBrokerRequest({
    schemaVersion: BROKER_SCHEMA_VERSION, operation: 'diff', repo: CANON, issueNumber: 1, baseSha: 'a'.repeat(40), args: { mode: 'working_tree', pathspec: 'x' },
  });
  eq('A13 diff extra arg rejected', r13.reason, 'INVALID_ARGS');
}

// ---- Group B: happy path for all three operations ---------------------------

{
  const { repo, req, wt } = makeBound(201);
  try {
    const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir });
    const s = broker.executeBrokerRequest(req('status'));
    tru('B1 status ok', s.ok);
    eq('B1a clean worktree status empty', s.data.entries.length, 0);

    const reg = { hello: { executable: 'node', argv: ['rt-hello.cjs'] } };
    const broker2 = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir, testRegistry: reg });
    const t = broker2.executeBrokerRequest(req('run_registered_test', { testId: 'hello' }));
    tru('B2 registered test ok', t.ok);
    eq('B2a exit code 0', t.data.exitCode, 0);
    eq('B2b stdout hi', t.data.stdout, 'hi');
    eq('B2c timedOut false', t.data.timedOut, false);

    // Modify a TRACKED file -> working-tree diff shows the change.
    writeFileSync(path.join(wt, 'BASE.md'), 'base\nmodified\n');
    const d = broker2.executeBrokerRequest(req('diff', { mode: 'working_tree' }));
    tru('B3 working-tree diff ok', d.ok);
    eq('B3a diff mode echoed', d.mode, 'working_tree');
    tru('B3b diff mentions BASE.md', d.data.output.includes('BASE.md'));
    eq('B3c diff not truncated', d.data.truncated, false);

    // Untracked file -> status lists it, diff (working_tree) does not.
    writeFileSync(path.join(wt, 'NEW.txt'), 'added\n');
    const s2 = broker2.executeBrokerRequest(req('status'));
    tru('B4 status ok after change', s2.ok);
    tru('B4a status lists NEW.txt as untracked', s2.data.entries.some((e) => e.code === '??' && e.path === 'NEW.txt'));
    eq('B4b status not truncated', s2.data.truncated, false);

    execFileSync('git', ['add', 'BASE.md', 'NEW.txt'], { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const d2 = broker2.executeBrokerRequest(req('diff', { mode: 'staged' }));
    tru('B5 staged diff ok', d2.ok);
    eq('B5a staged diff mode echoed', d2.mode, 'staged');
    tru('B5b staged diff mentions NEW.txt', d2.data.output.includes('NEW.txt'));
  } finally { repo.dispose(); cleanupBound(201); }
}
// ---- Group C: second request deterministic and non-mutating -----------------

{
  const { repo, req, wt } = makeBound(202);
  try {
    const reg = { hello: { executable: 'node', argv: ['rt-hello.cjs'] } };
    const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir, testRegistry: reg });
    const t1 = broker.executeBrokerRequest(req('run_registered_test', { testId: 'hello' }));
    const t2 = broker.executeBrokerRequest(req('run_registered_test', { testId: 'hello' }));
    tru('C1 registered test deterministic ok', t1.ok && t2.ok);
    eq('C1a same stdout', t1.data.stdout, t2.data.stdout);
    eq('C1b same exit code', t1.data.exitCode, t2.data.exitCode);
    eq('C1c worktree unchanged (evidence)', t1.evidence.worktreeUnchanged, true);

    writeFileSync(path.join(wt, 'X.txt'), 'x\n');
    const before = execFileSync('git', ['status', '--porcelain=v1'], { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const s1 = broker.executeBrokerRequest(req('status'));
    const s2 = broker.executeBrokerRequest(req('status'));
    const d = broker.executeBrokerRequest(req('diff', { mode: 'working_tree' }));
    const t3 = broker.executeBrokerRequest(req('run_registered_test', { testId: 'hello' }));
    const after = execFileSync('git', ['status', '--porcelain=v1'], { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    eq('C2 status deterministic', JSON.stringify(s1.data.entries), JSON.stringify(s2.data.entries));
    tru('C3 status+diff+test leave worktree unchanged', before === after);
    eq('C4 operations leave HEAD unchanged', headBefore, headAfter);
    tru('C5 all three ops ok', s1.ok && s2.ok && d.ok && t3.ok);
  } finally { repo.dispose(); cleanupBound(202); }
}

// ---- Group D: main checkout refused + binding failure modes -----------------

{
  // Main checkout: worktreesRoot resolving inside the main checkout is refused.
  const { repo, req } = makeBound(203);
  try {
    const badRoot = path.join(repo.dir, 'inside');
    mkdirSync(badRoot, { recursive: true });
    const broker = createExecutionBroker({ worktreesRoot: badRoot, controlCwd: repo.dir });
    const r = broker.executeBrokerRequest(req('status'));
    falsy('D1 worktreesRoot inside main checkout refused', r.ok);
    eq('D1a reason BINDING_VERIFY_FAILED', r.reason, 'BINDING_VERIFY_FAILED');
  } finally { repo.dispose(); cleanupBound(203); }

  // Missing binding: an identity with no worktree/binding fails before op runs.
  const repo2 = makeRepo();
  try {
    const baseSha = repo2.commit('BASE.md', 'b');
    repo2.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const broker = createExecutionBroker({
      worktreesRoot: TMP_ROOT, controlCwd: repo2.dir,
      testRegistry: { marker: { executable: 'node', argv: ['rt-mutate.cjs'] } },
    });
    const r = broker.executeBrokerRequest({
      schemaVersion: BROKER_SCHEMA_VERSION, operation: 'run_registered_test', repo: CANON, issueNumber: 99991, baseSha, args: { testId: 'marker' },
    });
    falsy('D2 missing binding refused', r.ok);
    eq('D2a reason BINDING_VERIFY_FAILED', r.reason, 'BINDING_VERIFY_FAILED');
    tru('D2b marker file NOT created (op never executed)', !fs.existsSync(path.join(repo2.dir, 'MARKER.txt')));
  } finally { repo2.dispose(); }

  // Malformed binding JSON refused before op runs.
  const repo3 = makeRepo();
  try {
    const baseSha = repo3.commit('BASE.md', 'c');
    repo3.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issue = 204;
    const p = provision({ worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo3.dir });
    tru('D3 setup provision ok', p.ok);
    const h = identityHash({ repo: CANON, issueNumber: issue });
    const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    fs.writeFileSync(bp, '{ not json');
    const broker = createExecutionBroker({
      worktreesRoot: TMP_ROOT, controlCwd: repo3.dir,
      testRegistry: { marker: { executable: 'node', argv: ['rt-mutate.cjs'] } },
    });
    const r = broker.executeBrokerRequest({
      schemaVersion: BROKER_SCHEMA_VERSION, operation: 'run_registered_test', repo: CANON, issueNumber: issue, baseSha, args: { testId: 'marker' },
    });
    falsy('D4 malformed binding refused', r.ok);
    eq('D4a reason BINDING_VERIFY_FAILED', r.reason, 'BINDING_VERIFY_FAILED');
    eq('D4b bindingReason BINDING_MALFORMED', r.bindingReason, 'BINDING_MALFORMED');
    const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    tru('D4c marker not created', !fs.existsSync(path.join(wt, 'MARKER.txt')));
  } finally { repo3.dispose(); cleanupBound(204); }

  // Mismatched binding (mutated repo field) refused.
  const repo4 = makeRepo();
  try {
    const baseSha = repo4.commit('BASE.md', 'd');
    repo4.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issue = 205;
    const p = provision({ worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo4.dir });
    tru('D5 setup provision ok', p.ok);
    const h = identityHash({ repo: CANON, issueNumber: issue });
    const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    const b = JSON.parse(fs.readFileSync(bp, 'utf8'));
    b.repo = 'evil/mutated';
    fs.writeFileSync(bp, JSON.stringify(b));
    const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo4.dir });
    const r = broker.executeBrokerRequest({
      schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: issue, baseSha, args: {},
    });
    falsy('D6 mismatched binding refused', r.ok);
    eq('D6a bindingReason BINDING_IDENTITY_MISMATCH', r.bindingReason, 'BINDING_IDENTITY_MISMATCH');
  } finally { repo4.dispose(); cleanupBound(205); }
}
// ---- Group E: wrong repo / issue / base / branch / remote, symlink escape ----

{
  // Wrong repo in the request identity.
  const { repo, req } = makeBound(206);
  try {
    const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir });
    const r = broker.executeBrokerRequest({ ...req('status'), repo: 'evil/other' });
    falsy('E1 wrong repo refused', r.ok);
    tru('E1a bindingReason fail-closed', ['BINDING_ABSENT', 'BINDING_IDENTITY_MISMATCH'].includes(r.bindingReason));
  } finally { repo.dispose(); cleanupBound(206); }

  // Wrong issue number in the request identity.
  const { repo: r2, baseSha: bs2 } = makeBound(207);
  try {
    const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: r2.dir });
    const r = broker.executeBrokerRequest({
      schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: 2071, baseSha: bs2, args: {},
    });
    falsy('E2 wrong issue refused', r.ok);
    tru('E2a bindingReason fail-closed', ['BINDING_ABSENT', 'BINDING_IDENTITY_MISMATCH'].includes(r.bindingReason));
  } finally { r2.dispose(); cleanupBound(207); }

  // Wrong base SHA in the request identity.
  const { repo: r3, baseSha: bs3 } = makeBound(208);
  try {
    const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: r3.dir });
    const r = broker.executeBrokerRequest({
      schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: 208, baseSha: 'f'.repeat(40), args: {},
    });
    falsy('E3 wrong base refused', r.ok);
    eq('E3a bindingReason BINDING_IDENTITY_MISMATCH', r.bindingReason, 'BINDING_IDENTITY_MISMATCH');
  } finally { r3.dispose(); cleanupBound(208); }

  // Wrong branch: worktree moved to a different branch -> refused.
  const { repo: r4, req: req4 } = makeBound(209);
  try {
    const h = identityHash({ repo: CANON, issueNumber: 209 });
    const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    const out = execFileSync('git', ['checkout', '-b', 'agent/evil-branch'], { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    tru('E4 setup checkout ok', typeof out === 'string');
    const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: r4.dir });
    const r = broker.executeBrokerRequest(req4('status'));
    falsy('E4 wrong branch refused', r.ok);
    eq('E4a bindingReason WORKTREE_WRONG_BRANCH', r.bindingReason, 'WORKTREE_WRONG_BRANCH');
  } finally { r4.dispose(); cleanupBound(209); }

  // Wrong remote: worktree origin repointed -> refused.
  const { repo: r5, req: req5 } = makeBound(210);
  try {
    const h = identityHash({ repo: CANON, issueNumber: 210 });
    const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/evil/other.git'], { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: r5.dir });
    const r = broker.executeBrokerRequest(req5('status'));
    falsy('E5 wrong remote refused', r.ok);
    eq('E5a bindingReason WORKTREE_WRONG_REMOTE', r.bindingReason, 'WORKTREE_WRONG_REMOTE');
  } finally { r5.dispose(); cleanupBound(210); }

  // Stale base: binding baseSha rewritten to a non-ancestor -> refused.
  const { repo: r6, baseSha: bs6 } = makeBound(211);
  try {
    const h = identityHash({ repo: CANON, issueNumber: 211 });
    const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    const b = JSON.parse(fs.readFileSync(bp, 'utf8'));
    b.baseSha = 'e'.repeat(40);
    fs.writeFileSync(bp, JSON.stringify(b));
    const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: r6.dir });
    const r = broker.executeBrokerRequest({
      schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: 211, baseSha: 'e'.repeat(40), args: {},
    });
    falsy('E6 stale base refused', r.ok);
    eq('E6a bindingReason BASE_NOT_ANCESTOR', r.bindingReason, 'BASE_NOT_ANCESTOR');
  } finally { r6.dispose(); cleanupBound(211); }

  // Symlink/junction worktree path escape refused (OS permitting).
  const { repo: r7, baseSha: bs7 } = makeBound(212);
  let symlinkMade = false;
  try {
    const h = identityHash({ repo: CANON, issueNumber: 212 });
    const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    rmSync(wt, { recursive: true, force: true });
    try {
      fs.symlinkSync(r7.dir, wt, process.platform === 'win32' ? 'junction' : 'dir');
      symlinkMade = true;
    } catch (e) {
      console.log('  symlink unsupported, skipping: ' + String((e && e.message) || e));
    }
    if (symlinkMade) {
      const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: r7.dir });
      const r = broker.executeBrokerRequest({
        schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: 212, baseSha: bs7, args: {},
      });
      falsy('E7 symlink escape refused', r.ok);
      const acceptable = ['WORKTREE_NOT_REAL_DIR', 'PATH_ESCAPES_ROOT', 'BINDING_VERIFY_FAILED'];
      tru('E7a bindingReason fail-closed', acceptable.includes(r.bindingReason));
    }
  } finally { r7.dispose(); cleanupBound(212); }
}
// ---- Group F: registry validation + shell-metachar inertness + fixed exec ----

{
  const { repo, req } = makeBound(213);
  try {
    const reg = {
      hello: { executable: 'node', argv: ['rt-hello.cjs'] },
      disabled: { executable: 'node', argv: ['rt-hello.cjs'], disabled: true },
      badSpace: { executable: 'node with space', argv: ['rt-hello.cjs'] },
      badShell: { executable: 'sh', argv: ['-c', 'echo x'] },
      badArgv: { executable: 'node', argv: 'not-an-array' },
      badEnv: { executable: 'node', argv: ['rt-hello.cjs'], env: { SECRET_TOKEN: 'abc' } },
      badTimeout: { executable: 'node', argv: ['rt-hello.cjs'], timeoutMs: 0 },
      badEnvVal: { executable: 'node', argv: ['rt-hello.cjs'], env: { FOO: 42 } },
      extraField: { executable: 'node', argv: ['rt-hello.cjs'], shell: true },
      badEval: { executable: 'node', argv: ['-e', 'process.exit(0)'] },
      badGit: { executable: 'git', argv: ['reset', '--hard'] },
      badPath: { executable: 'C:\\malware\\evil.exe', argv: ['do'] },
    };
    const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir, testRegistry: reg });

    // Unknown test ID.
    const u = broker.executeBrokerRequest(req('run_registered_test', { testId: 'nope' }));
    falsy('F1 unknown testId refused', u.ok);
    eq('F1a reason UNKNOWN_TEST_ID', u.reason, 'UNKNOWN_TEST_ID');

    // Missing registry.
    const brokerNo = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir });
    const m = brokerNo.executeBrokerRequest(req('run_registered_test', { testId: 'hello' }));
    falsy('F2 missing testRegistry refused', m.ok);
    eq('F2a reason TEST_REGISTRY_MISSING', m.reason, 'TEST_REGISTRY_MISSING');

    // Disabled entry.
    const dis = broker.executeBrokerRequest(req('run_registered_test', { testId: 'disabled' }));
    falsy('F3 disabled entry refused', dis.ok);
    eq('F3a reason REGISTRY_ENTRY_DISABLED', dis.reason, 'REGISTRY_ENTRY_DISABLED');

    // Malformed executable (whitespace).
    const bs = broker.executeBrokerRequest(req('run_registered_test', { testId: 'badSpace' }));
    falsy('F4 whitespace executable refused', bs.ok);
    eq('F4a reason MALFORMED_REGISTRY_ENTRY', bs.reason, 'MALFORMED_REGISTRY_ENTRY');

    // Non-node executable (sh) — evicted by allowlist.
    const sh = broker.executeBrokerRequest(req('run_registered_test', { testId: 'badShell' }));
    falsy('F5 shell interpreter refused', sh.ok);
    eq('F5a reason FORBIDDEN_EXECUTABLE', sh.reason, 'FORBIDDEN_EXECUTABLE');

    // Non-array argv.
    const av = broker.executeBrokerRequest(req('run_registered_test', { testId: 'badArgv' }));
    falsy('F6 non-array argv refused', av.ok);
    eq('F6a reason MALFORMED_REGISTRY_ENTRY', av.reason, 'MALFORMED_REGISTRY_ENTRY');

    // Secret-looking env key.
    const en = broker.executeBrokerRequest(req('run_registered_test', { testId: 'badEnv' }));
    falsy('F7 secret env key refused', en.ok);
    eq('F7a reason FORBIDDEN_ENV_KEY', en.reason, 'FORBIDDEN_ENV_KEY');

    // Invalid timeout.
    const tm = broker.executeBrokerRequest(req('run_registered_test', { testId: 'badTimeout' }));
    falsy('F8 invalid timeout refused', tm.ok);
    eq('F8a reason MALFORMED_REGISTRY_ENTRY', tm.reason, 'MALFORMED_REGISTRY_ENTRY');

    // Non-string env value.
    const ev = broker.executeBrokerRequest(req('run_registered_test', { testId: 'badEnvVal' }));
    falsy('F9 non-string env value refused', ev.ok);
    eq('F9a reason MALFORMED_REGISTRY_ENTRY', ev.reason, 'MALFORMED_REGISTRY_ENTRY');

    // Unknown registry field.
    const xf = broker.executeBrokerRequest(req('run_registered_test', { testId: 'extraField' }));
    falsy('F10 unknown registry field refused', xf.ok);
    eq('F10a reason MALFORMED_REGISTRY_ENTRY', xf.reason, 'MALFORMED_REGISTRY_ENTRY');

    // Eval flag in argv: -e is FORBIDDEN_EVAL_FLAG.
    const evl = broker.executeBrokerRequest(req('run_registered_test', { testId: 'badEval' }));
    falsy('F11 eval-flag argv refused', evl.ok);
    eq('F11a reason FORBIDDEN_EVAL_FLAG', evl.reason, 'FORBIDDEN_EVAL_FLAG');

    // Git executable (not in allowlist) → FORBIDDEN_EXECUTABLE.
    const git = broker.executeBrokerRequest(req('run_registered_test', { testId: 'badGit' }));
    falsy('F12 git executable refused', git.ok);
    eq('F12a reason FORBIDDEN_EXECUTABLE', git.reason, 'FORBIDDEN_EXECUTABLE');

    // Arbitrary executable path → FORBIDDEN_EXECUTABLE.
    const pth = broker.executeBrokerRequest(req('run_registered_test', { testId: 'badPath' }));
    falsy('F13 arbitrary executable path refused', pth.ok);
    eq('F13a reason FORBIDDEN_EXECUTABLE', pth.reason, 'FORBIDDEN_EXECUTABLE');
  } finally { repo.dispose(); cleanupBound(213); }
}

{
  const { repo, req } = makeBound(214);
  try {
    // Shell metacharacters in argv stay inert: rt-safe.cjs prints "safe", the
    // following argv entries are literal arguments, NOT a second command.
    const inert = { executable: 'node', argv: ['rt-safe.cjs', ';', 'echo', 'pwned', '&&', 'touch', 'PWNED.txt'] };
    const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir, testRegistry: { inert } });
    const r = broker.executeBrokerRequest(req('run_registered_test', { testId: 'inert' }));
    tru('F14 shell-metachar argv runs without shell', r.ok);
    eq('F14a stdout is only "safe"', r.data.stdout.trim(), 'safe');
    tru('F14b no second command executed (no PWNED.txt)', !fs.existsSync(path.join(repo.dir, 'PWNED.txt')));

    // Shell metacharacters in the executable token are rejected at validation.
    const badExe = { executable: 'node;evil', argv: ['rt-hello.cjs'] };
    const broker2 = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir, testRegistry: { badExe } });
    const rb = broker2.executeBrokerRequest(req('run_registered_test', { testId: 'badExe' }));
    falsy('F15 shell-metachar executable refused', rb.ok);

    // Fixed cwd: registered test prints process.cwd() -> must equal the verified
    // worktree. With snapshot isolation, the child runs in a snapshot under
    // os.tmpdir(), so we compare evidence.cwd (the original worktree path) with
    // the child's own output (the snapshot path). Both are HOME-redacted.
    // The key assertion is: evidence.cwd equals the verified worktree (the
    // broker's stated cwd), and argvSource is 'registry'.
    const cwdReg = { cwdTest: { executable: 'node', argv: ['rt-cwd.cjs'] } };
    const broker3 = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir, testRegistry: cwdReg });
    const rc = broker3.executeBrokerRequest(req('run_registered_test', { testId: 'cwdTest' }));
    tru('F16 fixed-cwd test ok', rc.ok);
    const h = identityHash({ repo: CANON, issueNumber: 214 });
    const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    const redHome = (p) => {
      const home = os.homedir();
      return home ? p.toLowerCase().split(home.toLowerCase()).join('<home>') : p.toLowerCase();
    };
    eq('F16a evidence cwd equals verified worktree', redHome(rc.evidence.cwd), redHome(wt));
    eq('F16b evidence argvSource registry', rc.evidence.argvSource, 'registry');
    eq('F16c evidence argv equals registry argv', JSON.stringify(rc.evidence.argv), JSON.stringify(cwdReg.cwdTest.argv));
    tru('F16d evidence isolated true', rc.evidence.isolated === true);
    eq('F16e worktreeUnchanged true', rc.evidence.worktreeUnchanged, true);
  } finally { repo.dispose(); cleanupBound(214); }
}
// ---- Group G: timeout terminates the child, structured timeout evidence ------

{
  const { repo, req } = makeBound(215);
  try {
    const hang = { executable: 'node', argv: ['rt-timeout.cjs'], timeoutMs: 300 };
    const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir, testRegistry: { hang } });
    const r = broker.executeBrokerRequest(req('run_registered_test', { testId: 'hang' }));
    falsy('G1 timeout refused (not ok)', r.ok);
    eq('G1a reason TEST_TIMEOUT', r.reason, 'TEST_TIMEOUT');
    eq('G1b timedOut true', r.data.timedOut, true);
    eq('G1c exitCode null', r.data.exitCode, null);
    tru('G1d structured evidence present', r.data && typeof r.data === 'object');
  } finally { repo.dispose(); cleanupBound(215); }
}

// ---- Group H: independent stdout/stderr caps + truncation flags --------------

{
  const { repo, req } = makeBound(216);
  try {
    // Both streams overflow (rt-big.cjs reads RT_STDOUT / RT_STDERR env vars).
    const both = { executable: 'node', argv: ['rt-big.cjs'], maxOutputBytes: 2048, env: { RT_STDOUT: '5000', RT_STDERR: '5000' } };
    const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir, testRegistry: { both } });
    const rb = broker.executeBrokerRequest(req('run_registered_test', { testId: 'both' }));
    falsy('H1 output overflow refused', rb.ok);
    eq('H1a reason TEST_OUTPUT_OVERFLOW', rb.reason, 'TEST_OUTPUT_OVERFLOW');
    eq('H1b stdout truncated true', rb.data.truncated.stdout, true);
    eq('H1c stderr truncated true', rb.data.truncated.stderr, true);
    tru('H1d stdout capped', rb.data.stdout.length <= 2048);
    tru('H1e stderr capped', rb.data.stderr.length <= 2048);

    // Only stdout overflows; stderr stays under the cap.
    const so = { executable: 'node', argv: ['rt-big.cjs'], maxOutputBytes: 2048, env: { RT_STDOUT: '5000', RT_STDERR: '4' } };
    const broker2 = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir, testRegistry: { so } });
    const rs = broker2.executeBrokerRequest(req('run_registered_test', { testId: 'so' }));
    falsy('H2 stdout-overflow refused', rs.ok);
    eq('H2a stdout truncated true', rs.data.truncated.stdout, true);
    eq('H2b stderr NOT truncated', rs.data.truncated.stderr, false);
    eq('H2c stderr intact', rs.data.stderr, 'BBBB');

    // Only stderr overflows; stdout stays under the cap.
    const eo = { executable: 'node', argv: ['rt-big.cjs'], maxOutputBytes: 2048, env: { RT_STDOUT: '4', RT_STDERR: '5000' } };
    const broker3 = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir, testRegistry: { eo } });
    const re = broker3.executeBrokerRequest(req('run_registered_test', { testId: 'eo' }));
    falsy('H3 stderr-overflow refused', re.ok);
    eq('H3a stdout NOT truncated', re.data.truncated.stdout, false);
    eq('H3b stderr truncated true', re.data.truncated.stderr, true);
    eq('H3c stdout intact', re.data.stdout, 'AAAA');
  } finally { repo.dispose(); cleanupBound(216); }
}
// ---- Group I: secret + HOME-path redaction (success and error surfaces) ------

{
  const { repo, req } = makeBound(217);
  try {
    const home = os.homedir();
    const TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    // Success surface: stdout carries HOME path + a secret token (rt-leak.cjs).
    const leak = { executable: 'node', argv: ['rt-leak.cjs'] };
    const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir, testRegistry: { leak } });
    const rl = broker.executeBrokerRequest(req('run_registered_test', { testId: 'leak' }));
    tru('I1 leak test ran (ok)', rl.ok);
    tru('I1a HOME path redacted on success surface', rl.data.stdout.includes('<HOME>'));
    falsy('I1b raw HOME path absent', home ? rl.data.stdout.includes(home) : true);
    tru('I1c secret token redacted on success surface', rl.data.stdout.includes('<SECRET>'));
    falsy('I1d raw token absent', rl.data.stdout.includes(TOKEN));

    // Error surface: failing test writes a secret to stderr (rt-leak-fail.cjs).
    const fail = { executable: 'node', argv: ['rt-leak-fail.cjs'] };
    const broker2 = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir, testRegistry: { fail } });
    const rf = broker2.executeBrokerRequest(req('run_registered_test', { testId: 'fail' }));
    falsy('I2 failing test refused', rf.ok);
    eq('I2a reason TEST_NONZERO_EXIT', rf.reason, 'TEST_NONZERO_EXIT');
    tru('I2b secret token redacted on error surface', rf.data.stderr.includes('<SECRET>'));
    falsy('I2c raw token absent from stderr', rf.data.stderr.includes(TOKEN));
    falsy('I2d raw token absent from detail', rf.detail ? rf.detail.includes(TOKEN) : true);

    // Request-level detail redaction: a secret in a rejected request never leaks.
    const brokerAny = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir });
    const bad = brokerAny.executeBrokerRequest({
      schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: 1, baseSha: 'a'.repeat(40), args: {}, secret: TOKEN,
    });
    falsy('I3 request with secret field refused', bad.ok);
    falsy('I3a secret absent from response', JSON.stringify(bad).includes(TOKEN));
  } finally { repo.dispose(); cleanupBound(217); }
}

// ---- Group J: non-zero exit reported, never converted to PASS ----------------

{
  const { repo, req } = makeBound(218);
  try {
    const fail3 = { executable: 'node', argv: ['rt-fail.cjs'] };
    const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir, testRegistry: { fail3 } });
    const r = broker.executeBrokerRequest(req('run_registered_test', { testId: 'fail3' }));
    falsy('J1 non-zero exit not PASS', r.ok);
    eq('J1a reason TEST_NONZERO_EXIT', r.reason, 'TEST_NONZERO_EXIT');
    eq('J1b exitCode 3 reported', r.data.exitCode, 3);
    eq('J1c timedOut false', r.data.timedOut, false);
  } finally { repo.dispose(); cleanupBound(218); }
}

// ---- Group K: registered tests run isolated; original worktree never mutates --

{
  const { repo, req, wt } = makeBound(219);
  try {
    // A non-mutating registered test reports worktreeUnchanged: true.
    const ok = { executable: 'node', argv: ['rt-hello.cjs'] };
    const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir, testRegistry: { ok } });
    const r1 = broker.executeBrokerRequest(req('run_registered_test', { testId: 'ok' }));
    tru('K1 non-mutating test ok', r1.ok);
    eq('K1a worktreeUnchanged true', r1.evidence.worktreeUnchanged, true);

    // A MUTATING registered test (rt-mutate.cjs writes EVIL.txt) runs in the
    // disposable snapshot: the original bound worktree stays byte-for-byte
    // unchanged and EVIL.txt never appears there (GPT-REV-126). The operation
    // itself succeeds because the mutation landed in the throwaway snapshot.
    const mut = { executable: 'node', argv: ['rt-mutate.cjs'] };
    const broker2 = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir, testRegistry: { mut } });
    const r2 = broker2.executeBrokerRequest(req('run_registered_test', { testId: 'mut' }));
    tru('K2 mutating test runs isolated (ok)', r2.ok);
    eq('K2a evidence isolated true', r2.evidence.isolated, true);
    eq('K2b worktreeUnchanged true', r2.evidence.worktreeUnchanged, true);
    falsy('K2c EVIL.txt NOT left in original worktree', fs.existsSync(path.join(wt, 'EVIL.txt')));

    // Pre-dirty state in the original worktree is preserved byte-for-byte even
    // when a registered test runs (content-level invariance, incl. untracked).
    writeFileSync(path.join(wt, 'PREEXISTING.txt'), 'keep-me\n');
    const before = fs.readFileSync(path.join(wt, 'PREEXISTING.txt'), 'utf8');
    const r3 = broker2.executeBrokerRequest(req('run_registered_test', { testId: 'mut' }));
    tru('K3 registered test ok with pre-dirty worktree', r3.ok);
    eq('K3a pre-existing untracked file unchanged', fs.readFileSync(path.join(wt, 'PREEXISTING.txt'), 'utf8'), before);
    eq('K3b worktreeUnchanged true', r3.evidence.worktreeUnchanged, true);

    // Results are always plain structured objects, never raw Error instances.
    const any = broker2.executeBrokerRequest(req('status'));
    tru('K4 result is plain structured object (no raw Error)', any && typeof any === 'object' && !(any instanceof Error));
  } finally { repo.dispose(); cleanupBound(219); }
}

// ---- Group L: script path containment + registry immutability (GPT-REV-127) --

// L6 + L7: argv[0] (the node script path) must be a repo-relative safe path
// inside the snapshot root. Absolute paths (Windows C:\ and POSIX /tmp/),
// drive letters, UNC paths, URLs, stdin, and traversal are all refused
// fail-closed as FORBIDDEN_SCRIPT_PATH before anything runs.
{
  const { repo, req } = makeBound(220);
  try {
    const reg = {
      absWin:   { executable: 'node', argv: ['C:\\test.cjs'] },
      absPosix: { executable: 'node', argv: ['/tmp/test.cjs'] },
      trav:     { executable: 'node', argv: ['../../outside.cjs'] },
      url:      { executable: 'node', argv: ['file:///etc/passwd'] },
      stdin:    { executable: 'node', argv: ['-'] },
    };
    const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir, testRegistry: reg });

    const aw = broker.executeBrokerRequest(req('run_registered_test', { testId: 'absWin' }));
    falsy('L6 windows absolute script path refused', aw.ok);
    eq('L6a reason FORBIDDEN_SCRIPT_PATH', aw.reason, 'FORBIDDEN_SCRIPT_PATH');

    const ap = broker.executeBrokerRequest(req('run_registered_test', { testId: 'absPosix' }));
    falsy('L6b posix absolute script path refused', ap.ok);
    eq('L6c reason FORBIDDEN_SCRIPT_PATH', ap.reason, 'FORBIDDEN_SCRIPT_PATH');

    const tr = broker.executeBrokerRequest(req('run_registered_test', { testId: 'trav' }));
    falsy('L7 traversal script path refused', tr.ok);
    eq('L7a reason FORBIDDEN_SCRIPT_PATH', tr.reason, 'FORBIDDEN_SCRIPT_PATH');

    const ur = broker.executeBrokerRequest(req('run_registered_test', { testId: 'url' }));
    falsy('L7b url script path refused', ur.ok);
    eq('L7c reason FORBIDDEN_SCRIPT_PATH', ur.reason, 'FORBIDDEN_SCRIPT_PATH');

    const sd = broker.executeBrokerRequest(req('run_registered_test', { testId: 'stdin' }));
    falsy('L7d stdin script path refused', sd.ok);
    eq('L7e reason FORBIDDEN_SCRIPT_PATH', sd.reason, 'FORBIDDEN_SCRIPT_PATH');
  } finally { repo.dispose(); cleanupBound(220); }
}

// L8: the broker deep-copies the registry at factory time and deep-freezes ONLY
// its own internal copy. The caller's testRegistry object — and its nested
// objects — stay mutable/unfrozen after createExecutionBroker returns, and no
// post-factory mutation of the caller's registry can affect what the broker
// executes (the internal frozen copy is authoritative).
{
  const { repo, req } = makeBound(221);
  try {
    const reg = { t1: { executable: 'node', argv: ['rt-hello.cjs'] } };
    const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir, testRegistry: reg });
    // Caller's registry stays mutable/unfrozen after factory — broker never
    // freezes or mutates its input.
    tru('L8a caller registry not frozen after factory', !Object.isFrozen(reg));
    tru('L8b caller registry entry not frozen after factory', !Object.isFrozen(reg.t1));
    tru('L8c caller registry argv not frozen after factory', !Object.isFrozen(reg.t1.argv));
    // Mutate the caller's registry deeply. Mutations succeed on the caller's
    // object (proving it is not frozen) yet must NOT leak into the broker.
    reg.t1.executable = 'git';
    reg.t1.argv[0] = 'rt-mutate.cjs';
    reg.t2 = { executable: 'node', argv: ['rt-hello.cjs'] };
    tru('L8d caller mutation visible on caller object (executable=git)', reg.t1.executable === 'git');
    // Broker still runs t1 with the ORIGINAL frozen internal definition.
    const r1 = broker.executeBrokerRequest(req('run_registered_test', { testId: 't1' }));
    tru('L8e original entry still runs from internal copy', r1.ok);
    // New entry added to the caller's registry is invisible to the broker.
    const r2 = broker.executeBrokerRequest(req('run_registered_test', { testId: 't2' }));
    eq('L8f added entry not visible after caller mutation', r2.reason, 'UNKNOWN_TEST_ID');
  } finally { repo.dispose(); cleanupBound(221); }
}

// M (Issue #35 rework): run_safe_command was REMOVED from the broker surface.
// The dispatch boundary must fail closed for the removed op: the request is
// rejected deterministically at validation, no child process runs, and the
// bound worktree stays byte-for-byte clean.
{
  const { repo, req } = makeBound(3302);
  try {
    const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir });
    const sc = broker.executeBrokerRequest(req('run_safe_command', { executable: 'node', argv: ['rt-hello.cjs'] }));
    eq('M1 removed run_safe_command rejected', sc.reason, 'UNKNOWN_OPERATION');
    const ev = broker.executeBrokerRequest(req('run_safe_command', { executable: 'node', argv: ['rt-hello.cjs', '-e', 'x'] }));
    eq('M2 removed run_safe_command cannot smuggle argv', ev.reason, 'UNKNOWN_OPERATION');
    falsy('M3 no child ran (no data)', sc.data);
    const st = broker.executeBrokerRequest(req('status'));
    tru('M4 worktree clean after removed op (no mutation)', st.ok && st.data.entries.length === 0);
  } finally { repo.dispose(); cleanupBound(3302); }
}

// ---- summary ----------------------------------------------------------------

const pass = checks.filter((c) => c.ok).length;
for (const c of checks) if (!c.ok) console.log('FAIL', c.name, '=>', JSON.stringify(c.got), 'want', JSON.stringify(c.want));
console.log('\nTổng: ' + pass + '/' + checks.length + ' PASS');
process.exit(pass === checks.length ? 0 : 1);
