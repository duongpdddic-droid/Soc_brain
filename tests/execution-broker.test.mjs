#!/usr/bin/env node
// execution-broker.test.mjs — tests for packages/execution-broker (Issue #15).
// Real-FS tests: disposable Git repos + provisioned bound worktrees via
// packages/workspace. NO framework. Exit 0 = PASS, 1 = FAIL.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { provision, identityHash, worktreePathFor, bindingPathFor } from '../packages/workspace/workspace.mjs';
import { executeBrokerRequest, BROKER_SCHEMA_VERSION } from '../packages/execution-broker/execution-broker.mjs';

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

// Provision a real bound worktree for `issueNumber`; returns { repo, baseSha, req, wt }.
function makeBound(issueNumber) {
  const repo = makeRepo();
  const baseSha = repo.commit('BASE.md', 'base\n');
  repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
  const p = provision({ worktreesRoot: TMP_ROOT, repo: CANON, issueNumber, baseSha, cwd: repo.dir });
  if (!p.ok) throw new Error('provision failed: ' + p.reason + ' ' + (p.detail || ''));
  const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: identityHash({ repo: CANON, issueNumber }) });
  const req = (operation, args, overrides) => ({
    request: { schemaVersion: BROKER_SCHEMA_VERSION, operation, repo: CANON, issueNumber, baseSha, args: args || {} },
    worktreesRoot: TMP_ROOT,
    controlCwd: repo.dir,
    ...(overrides || {}),
  });
  return { repo, baseSha, req, wt };
}
// ---- Group A: request validation (fails before binding/execution) -----------

{
  const r = executeBrokerRequest({ request: null });
  eq('A1 null request -> INVALID_REQUEST', r.reason, 'INVALID_REQUEST');

  const r2 = executeBrokerRequest({ request: { operation: 'status' } });
  eq('A2 missing fields -> REQUEST_MISSING_FIELD', r2.reason, 'REQUEST_MISSING_FIELD');

  const r3 = executeBrokerRequest({
    request: { schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: 1, baseSha: 'a'.repeat(40), args: {}, command: 'rm -rf /' },
  });
  eq('A3 unknown top-level command rejected', r3.reason, 'INVALID_REQUEST_FIELD');

  const r4 = executeBrokerRequest({
    request: { schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: 1, baseSha: 'a'.repeat(40), args: {}, cwd: '/tmp' },
  });
  eq('A4 caller-supplied cwd rejected', r4.reason, 'INVALID_REQUEST_FIELD');

  const r5 = executeBrokerRequest({
    request: { schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: 1, baseSha: 'a'.repeat(40), args: {}, env: { FOO: 'bar' } },
  });
  eq('A5 caller-supplied env rejected', r5.reason, 'INVALID_REQUEST_FIELD');

  const r6 = executeBrokerRequest({
    request: { schemaVersion: '2', operation: 'status', repo: CANON, issueNumber: 1, baseSha: 'a'.repeat(40), args: {} },
  });
  eq('A6 unsupported schema version', r6.reason, 'SCHEMA_VERSION_UNSUPPORTED');

  const r7 = executeBrokerRequest({
    request: { schemaVersion: BROKER_SCHEMA_VERSION, operation: 'delete', repo: CANON, issueNumber: 1, baseSha: 'a'.repeat(40), args: {} },
  });
  eq('A7 unknown operation refused', r7.reason, 'UNKNOWN_OPERATION');

  const r8 = executeBrokerRequest({
    request: { schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: 'not a repo', issueNumber: 1, baseSha: 'a'.repeat(40), args: {} },
  });
  eq('A8 invalid repo refused', r8.reason, 'INVALID_REPO');

  const r9 = executeBrokerRequest({
    request: { schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: 0, baseSha: 'a'.repeat(40), args: {} },
  });
  eq('A9 zero issue refused', r9.reason, 'INVALID_ISSUE_NUMBER');

  const r10 = executeBrokerRequest({
    request: { schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: 1, baseSha: 'short', args: {} },
  });
  eq('A10 short baseSha refused', r10.reason, 'INVALID_BASE_SHA');

  const r11 = executeBrokerRequest({
    request: { schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: 1, baseSha: 'a'.repeat(40), args: { path: '/etc' } },
  });
  eq('A11 status caller path rejected', r11.reason, 'INVALID_ARGS');

  const r12 = executeBrokerRequest({
    request: { schemaVersion: BROKER_SCHEMA_VERSION, operation: 'diff', repo: CANON, issueNumber: 1, baseSha: 'a'.repeat(40), args: { mode: 'HEAD~1' } },
  });
  eq('A12 raw rev-expression diff mode rejected', r12.reason, 'INVALID_DIFF_MODE');

  const r13 = executeBrokerRequest({
    request: { schemaVersion: BROKER_SCHEMA_VERSION, operation: 'diff', repo: CANON, issueNumber: 1, baseSha: 'a'.repeat(40), args: { mode: 'working_tree', pathspec: 'x' } },
  });
  eq('A13 diff extra arg rejected', r13.reason, 'INVALID_ARGS');
}

// ---- Group B: happy path for all three operations ---------------------------

{
  const { repo, req, wt } = makeBound(201);
  try {
    const s = executeBrokerRequest(req('status'));
    tru('B1 status ok', s.ok);
    eq('B1a clean worktree status empty', s.data.entries.length, 0);

    const t = executeBrokerRequest(req('run_registered_test', { testId: 'hello' }), { testRegistry: { hello: { executable: 'node', argv: ['-e', 'process.stdout.write("hi")'] } } });
    tru('B2 registered test ok', t.ok);
    eq('B2a exit code 0', t.data.exitCode, 0);
    eq('B2b stdout hi', t.data.stdout, 'hi');
    eq('B2c timedOut false', t.data.timedOut, false);

    // Modify a TRACKED file -> working-tree diff shows the change.
    writeFileSync(path.join(wt, 'BASE.md'), 'base\nmodified\n');
    const d = executeBrokerRequest(req('diff', { mode: 'working_tree' }));
    tru('B3 working-tree diff ok', d.ok);
    eq('B3a diff mode echoed', d.mode, 'working_tree');
    tru('B3b diff mentions BASE.md', d.data.output.includes('BASE.md'));
    eq('B3c diff not truncated', d.data.truncated, false);

    // Untracked file -> status lists it, diff (working_tree) does not.
    writeFileSync(path.join(wt, 'NEW.txt'), 'added\n');
    const s2 = executeBrokerRequest(req('status'));
    tru('B4 status ok after change', s2.ok);
    tru('B4a status lists NEW.txt as untracked', s2.data.entries.some((e) => e.code === '??' && e.path === 'NEW.txt'));
    eq('B4b status not truncated', s2.data.truncated, false);

    execFileSync('git', ['add', 'BASE.md', 'NEW.txt'], { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const d2 = executeBrokerRequest(req('diff', { mode: 'staged' }));
    tru('B5 staged diff ok', d2.ok);
    eq('B5a staged diff mode echoed', d2.mode, 'staged');
    tru('B5b staged diff mentions NEW.txt', d2.data.output.includes('NEW.txt'));
  } finally { repo.dispose(); }
}
// ---- Group C: second request deterministic and non-mutating -----------------

{
  const { repo, req, wt } = makeBound(202);
  try {
    const registry = { hello: { executable: 'node', argv: ['-e', 'process.stdout.write("hi")'] } };
    const t1 = executeBrokerRequest(req('run_registered_test', { testId: 'hello' }), { testRegistry: registry });
    const t2 = executeBrokerRequest(req('run_registered_test', { testId: 'hello' }), { testRegistry: registry });
    tru('C1 registered test deterministic ok', t1.ok && t2.ok);
    eq('C1a same stdout', t1.data.stdout, t2.data.stdout);
    eq('C1b same exit code', t1.data.exitCode, t2.data.exitCode);
    eq('C1c worktree unchanged (evidence)', t1.evidence.worktreeUnchanged, true);

    writeFileSync(path.join(wt, 'X.txt'), 'x\n');
    const before = execFileSync('git', ['status', '--porcelain=v1'], { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const s1 = executeBrokerRequest(req('status'));
    const s2 = executeBrokerRequest(req('status'));
    const d = executeBrokerRequest(req('diff', { mode: 'working_tree' }));
    const t3 = executeBrokerRequest(req('run_registered_test', { testId: 'hello' }), { testRegistry: registry });
    const after = execFileSync('git', ['status', '--porcelain=v1'], { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    eq('C2 status deterministic', JSON.stringify(s1.data.entries), JSON.stringify(s2.data.entries));
    tru('C3 status+diff+test leave worktree unchanged', before === after);
    eq('C4 operations leave HEAD unchanged', headBefore, headAfter);
    tru('C5 all three ops ok', s1.ok && s2.ok && d.ok && t3.ok);
  } finally { repo.dispose(); }
}

// ---- Group D: main checkout refused + binding failure modes -----------------

{
  // Main checkout: worktreesRoot resolving inside the main checkout is refused.
  const { repo, req } = makeBound(203);
  try {
    const badRoot = path.join(repo.dir, 'inside');
    mkdirSync(badRoot, { recursive: true });
    const r = executeBrokerRequest({ ...req('status'), worktreesRoot: badRoot });
    falsy('D1 worktreesRoot inside main checkout refused', r.ok);
    eq('D1a reason BINDING_VERIFY_FAILED', r.reason, 'BINDING_VERIFY_FAILED');
  } finally { repo.dispose(); }

  // Missing binding: an identity with no worktree/binding fails before op runs.
  const repo2 = makeRepo();
  try {
    const baseSha = repo2.commit('BASE.md', 'b');
    repo2.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const r = executeBrokerRequest({
      request: { schemaVersion: BROKER_SCHEMA_VERSION, operation: 'run_registered_test', repo: CANON, issueNumber: 99991, baseSha, args: { testId: 'marker' } },
      worktreesRoot: TMP_ROOT, controlCwd: repo2.dir,
      testRegistry: { marker: { executable: 'node', argv: ['-e', 'require("fs").writeFileSync("MARKER.txt","ran")'] } },
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
    const r = executeBrokerRequest({
      request: { schemaVersion: BROKER_SCHEMA_VERSION, operation: 'run_registered_test', repo: CANON, issueNumber: issue, baseSha, args: { testId: 'marker' } },
      worktreesRoot: TMP_ROOT, controlCwd: repo3.dir,
      testRegistry: { marker: { executable: 'node', argv: ['-e', 'require("fs").writeFileSync("MARKER.txt","ran")'] } },
    });
    falsy('D4 malformed binding refused', r.ok);
    eq('D4a reason BINDING_VERIFY_FAILED', r.reason, 'BINDING_VERIFY_FAILED');
    eq('D4b bindingReason BINDING_MALFORMED', r.bindingReason, 'BINDING_MALFORMED');
    const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    tru('D4c marker not created', !fs.existsSync(path.join(wt, 'MARKER.txt')));
  } finally { repo3.dispose(); }

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
    const r = executeBrokerRequest({
      request: { schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: issue, baseSha, args: {} },
      worktreesRoot: TMP_ROOT, controlCwd: repo4.dir,
    });
    falsy('D5 mismatched binding refused', r.ok);
    eq('D5a bindingReason BINDING_IDENTITY_MISMATCH', r.bindingReason, 'BINDING_IDENTITY_MISMATCH');
  } finally { repo4.dispose(); }
}
// ---- Group E: wrong repo / issue / base / branch / remote, symlink escape ----

{
  // Wrong repo in the request identity.
  const { repo, req } = makeBound(206);
  try {
    const r = executeBrokerRequest({ ...req('status'), request: { ...req('status').request, repo: 'evil/other' } });
    falsy('E1 wrong repo refused', r.ok);
    tru('E1a bindingReason fail-closed', ['BINDING_ABSENT', 'BINDING_IDENTITY_MISMATCH'].includes(r.bindingReason));
  } finally { repo.dispose(); }

  // Wrong issue number in the request identity.
  const { repo: r2, baseSha: bs2 } = makeBound(207);
  try {
    const r = executeBrokerRequest({
      request: { schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: 2071, baseSha: bs2, args: {} },
      worktreesRoot: TMP_ROOT, controlCwd: r2.dir,
    });
    falsy('E2 wrong issue refused', r.ok);
    tru('E2a bindingReason fail-closed', ['BINDING_ABSENT', 'BINDING_IDENTITY_MISMATCH'].includes(r.bindingReason));
  } finally { r2.dispose(); }

  // Wrong base SHA in the request identity.
  const { repo: r3, baseSha: bs3 } = makeBound(208);
  try {
    const r = executeBrokerRequest({
      request: { schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: 208, baseSha: 'f'.repeat(40), args: {} },
      worktreesRoot: TMP_ROOT, controlCwd: r3.dir,
    });
    falsy('E3 wrong base refused', r.ok);
    eq('E3a bindingReason BINDING_IDENTITY_MISMATCH', r.bindingReason, 'BINDING_IDENTITY_MISMATCH');
  } finally { r3.dispose(); }

  // Wrong branch: worktree moved to a different branch -> refused.
  const { repo: r4, req: req4 } = makeBound(209);
  try {
    const h = identityHash({ repo: CANON, issueNumber: 209 });
    const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    const out = execFileSync('git', ['checkout', '-b', 'agent/evil-branch'], { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    tru('E4 setup checkout ok', typeof out === 'string');
    const r = executeBrokerRequest(req4('status'));
    falsy('E4 wrong branch refused', r.ok);
    eq('E4a bindingReason WORKTREE_WRONG_BRANCH', r.bindingReason, 'WORKTREE_WRONG_BRANCH');
  } finally { r4.dispose(); }

  // Wrong remote: worktree origin repointed -> refused.
  const { repo: r5, req: req5 } = makeBound(210);
  try {
    const h = identityHash({ repo: CANON, issueNumber: 210 });
    const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/evil/other.git'], { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const r = executeBrokerRequest(req5('status'));
    falsy('E5 wrong remote refused', r.ok);
    eq('E5a bindingReason WORKTREE_WRONG_REMOTE', r.bindingReason, 'WORKTREE_WRONG_REMOTE');
  } finally { r5.dispose(); }

  // Stale base: binding baseSha rewritten to a non-ancestor -> refused.
  const { repo: r6, baseSha: bs6 } = makeBound(211);
  try {
    const h = identityHash({ repo: CANON, issueNumber: 211 });
    const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    const b = JSON.parse(fs.readFileSync(bp, 'utf8'));
    b.baseSha = 'e'.repeat(40);
    fs.writeFileSync(bp, JSON.stringify(b));
    const r = executeBrokerRequest({
      request: { schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: 211, baseSha: 'e'.repeat(40), args: {} },
      worktreesRoot: TMP_ROOT, controlCwd: r6.dir,
    });
    falsy('E6 stale base refused', r.ok);
    eq('E6a bindingReason BASE_NOT_ANCESTOR', r.bindingReason, 'BASE_NOT_ANCESTOR');
  } finally { r6.dispose(); }

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
      const r = executeBrokerRequest({
        request: { schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: 212, baseSha: bs7, args: {} },
        worktreesRoot: TMP_ROOT, controlCwd: r7.dir,
      });
      falsy('E7 symlink escape refused', r.ok);
      const acceptable = ['WORKTREE_NOT_REAL_DIR', 'PATH_ESCAPES_ROOT', 'BINDING_VERIFY_FAILED'];
      tru('E7a bindingReason fail-closed', acceptable.includes(r.bindingReason));
    }
  } finally { r7.dispose(); }
}
// ---- Group F: registry validation + shell-metachar inertness + fixed exec ----

{
  const { repo, req } = makeBound(213);
  try {
    const registry = {
      hello: { executable: 'node', argv: ['-e', 'process.stdout.write("hi")'] },
      disabled: { executable: 'node', argv: ['-e', 'process.stdout.write("x")'], disabled: true },
      badSpace: { executable: 'node with space', argv: ['-e', 'process.stdout.write("x")'] },
      badShell: { executable: 'sh', argv: ['-c', 'echo x'] },
      badArgv: { executable: 'node', argv: 'not-an-array' },
      badEnv: { executable: 'node', argv: ['-e', 'process.stdout.write("x")'], env: { SECRET_TOKEN: 'abc' } },
      badTimeout: { executable: 'node', argv: ['-e', 'process.stdout.write("x")'], timeoutMs: 0 },
      badEnvVal: { executable: 'node', argv: ['-e', 'process.stdout.write("x")'], env: { FOO: 42 } },
      extraField: { executable: 'node', argv: ['-e', 'process.stdout.write("x")'], shell: true },
    };

    // Unknown test ID.
    const u = executeBrokerRequest(req('run_registered_test', { testId: 'nope' }), { testRegistry: registry });
    falsy('F1 unknown testId refused', u.ok);
    eq('F1a reason UNKNOWN_TEST_ID', u.reason, 'UNKNOWN_TEST_ID');

    // Missing registry.
    const m = executeBrokerRequest(req('run_registered_test', { testId: 'hello' }));
    falsy('F2 missing testRegistry refused', m.ok);
    eq('F2a reason TEST_REGISTRY_MISSING', m.reason, 'TEST_REGISTRY_MISSING');

    // Disabled entry.
    const dis = executeBrokerRequest(req('run_registered_test', { testId: 'disabled' }), { testRegistry: registry });
    falsy('F3 disabled entry refused', dis.ok);
    eq('F3a reason REGISTRY_ENTRY_DISABLED', dis.reason, 'REGISTRY_ENTRY_DISABLED');

    // Malformed executable (whitespace).
    const bs = executeBrokerRequest(req('run_registered_test', { testId: 'badSpace' }), { testRegistry: registry });
    falsy('F4 whitespace executable refused', bs.ok);
    eq('F4a reason MALFORMED_REGISTRY_ENTRY', bs.reason, 'MALFORMED_REGISTRY_ENTRY');

    // Shell interpreter executable.
    const sh = executeBrokerRequest(req('run_registered_test', { testId: 'badShell' }), { testRegistry: registry });
    falsy('F5 shell interpreter refused', sh.ok);
    eq('F5a reason FORBIDDEN_EXECUTABLE', sh.reason, 'FORBIDDEN_EXECUTABLE');

    // Non-array argv.
    const av = executeBrokerRequest(req('run_registered_test', { testId: 'badArgv' }), { testRegistry: registry });
    falsy('F6 non-array argv refused', av.ok);
    eq('F6a reason MALFORMED_REGISTRY_ENTRY', av.reason, 'MALFORMED_REGISTRY_ENTRY');

    // Secret-looking env key.
    const en = executeBrokerRequest(req('run_registered_test', { testId: 'badEnv' }), { testRegistry: registry });
    falsy('F7 secret env key refused', en.ok);
    eq('F7a reason FORBIDDEN_ENV_KEY', en.reason, 'FORBIDDEN_ENV_KEY');

    // Invalid timeout.
    const tm = executeBrokerRequest(req('run_registered_test', { testId: 'badTimeout' }), { testRegistry: registry });
    falsy('F8 invalid timeout refused', tm.ok);
    eq('F8a reason MALFORMED_REGISTRY_ENTRY', tm.reason, 'MALFORMED_REGISTRY_ENTRY');

    // Non-string env value.
    const ev = executeBrokerRequest(req('run_registered_test', { testId: 'badEnvVal' }), { testRegistry: registry });
    falsy('F9 non-string env value refused', ev.ok);
    eq('F9a reason MALFORMED_REGISTRY_ENTRY', ev.reason, 'MALFORMED_REGISTRY_ENTRY');

    // Unknown registry field.
    const xf = executeBrokerRequest(req('run_registered_test', { testId: 'extraField' }), { testRegistry: registry });
    falsy('F10 unknown registry field refused', xf.ok);
    eq('F10a reason MALFORMED_REGISTRY_ENTRY', xf.reason, 'MALFORMED_REGISTRY_ENTRY');
  } finally { repo.dispose(); }
}

{
  const { repo, req } = makeBound(214);
  try {
    // Shell metacharacters in argv stay inert: node -e prints "safe", the
    // following argv entries are literal arguments, NOT a second command.
    const inert = { executable: 'node', argv: ['-e', 'console.log("safe")', ';', 'echo', 'pwned', '&&', 'touch', 'PWNED.txt'] };
    const r = executeBrokerRequest(req('run_registered_test', { testId: 'inert' }), { testRegistry: { inert } });
    tru('F11 shell-metachar argv runs without shell', r.ok);
    eq('F11a stdout is only "safe"', r.data.stdout.trim(), 'safe');
    tru('F11b no second command executed (no PWNED.txt)', !fs.existsSync(path.join(repo.dir, 'PWNED.txt')));

    // Shell metacharacters in the executable token are rejected at validation.
    const badExe = { executable: 'node;evil', argv: ['-e', 'process.stdout.write("x")'] };
    const rb = executeBrokerRequest(req('run_registered_test', { testId: 'badExe' }), { testRegistry: { badExe } });
    falsy('F12 shell-metachar executable refused', rb.ok);

    // Fixed cwd: registered test prints process.cwd() -> must equal the bound worktree.
    // (The worktree lives under os.tmpdir(), which is under os.homedir() on this
    // host, so both child output and evidence.cwd are HOME-redacted identically.)
    const cwdTest = { executable: 'node', argv: ['-e', 'process.stdout.write(process.cwd())'] };
    const rc = executeBrokerRequest(req('run_registered_test', { testId: 'cwdTest' }), { testRegistry: { cwdTest } });
    tru('F13 fixed-cwd test ok', rc.ok);
    const h = identityHash({ repo: CANON, issueNumber: 214 });
    const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    const redHome = (p) => {
      const home = os.homedir();
      return home ? p.toLowerCase().split(home.toLowerCase()).join('<home>') : p.toLowerCase();
    };
    eq('F13a child cwd equals verified worktree', redHome(rc.data.stdout), redHome(wt));
    eq('F13b evidence argvSource registry', rc.evidence.argvSource, 'registry');
    eq('F13c evidence argv equals registry argv', JSON.stringify(rc.evidence.argv), JSON.stringify(cwdTest.argv));
    eq('F13d evidence cwd equals worktree', redHome(rc.evidence.cwd), redHome(wt));
    tru('F13e evidence redactionApplied', rc.evidence.redactionApplied === true);
  } finally { repo.dispose(); }
}
// ---- Group G: timeout terminates the child, structured timeout evidence ------

{
  const { repo, req } = makeBound(215);
  try {
    const hang = { executable: 'node', argv: ['-e', 'setTimeout(()=>{}, 60000)'], timeoutMs: 300 };
    const r = executeBrokerRequest(req('run_registered_test', { testId: 'hang' }), { testRegistry: { hang } });
    falsy('G1 timeout refused (not ok)', r.ok);
    eq('G1a reason TEST_TIMEOUT', r.reason, 'TEST_TIMEOUT');
    eq('G1b timedOut true', r.data.timedOut, true);
    eq('G1c exitCode null', r.data.exitCode, null);
    tru('G1d structured evidence present', r.data && typeof r.data === 'object');
  } finally { repo.dispose(); }
}

// ---- Group H: independent stdout/stderr caps + truncation flags --------------

{
  const { repo, req } = makeBound(216);
  try {
    // Both streams overflow.
    const both = { executable: 'node', argv: ['-e', 'process.stdout.write("A".repeat(5000)); process.stderr.write("B".repeat(5000))'], maxOutputBytes: 2048 };
    const rb = executeBrokerRequest(req('run_registered_test', { testId: 'both' }), { testRegistry: { both } });
    falsy('H1 output overflow refused', rb.ok);
    eq('H1a reason TEST_OUTPUT_OVERFLOW', rb.reason, 'TEST_OUTPUT_OVERFLOW');
    eq('H1b stdout truncated true', rb.data.truncated.stdout, true);
    eq('H1c stderr truncated true', rb.data.truncated.stderr, true);
    tru('H1d stdout capped', rb.data.stdout.length <= 2048);
    tru('H1e stderr capped', rb.data.stderr.length <= 2048);

    // Only stdout overflows; stderr stays under the cap.
    const so = { executable: 'node', argv: ['-e', 'process.stdout.write("A".repeat(5000)); process.stderr.write("tiny")'], maxOutputBytes: 2048 };
    const rs = executeBrokerRequest(req('run_registered_test', { testId: 'so' }), { testRegistry: { so } });
    falsy('H2 stdout-overflow refused', rs.ok);
    eq('H2a stdout truncated true', rs.data.truncated.stdout, true);
    eq('H2b stderr NOT truncated', rs.data.truncated.stderr, false);
    eq('H2c stderr intact', rs.data.stderr, 'tiny');

    // Only stderr overflows; stdout stays under the cap.
    const eo = { executable: 'node', argv: ['-e', 'process.stdout.write("tiny"); process.stderr.write("B".repeat(5000))'], maxOutputBytes: 2048 };
    const re = executeBrokerRequest(req('run_registered_test', { testId: 'eo' }), { testRegistry: { eo } });
    falsy('H3 stderr-overflow refused', re.ok);
    eq('H3a stdout NOT truncated', re.data.truncated.stdout, false);
    eq('H3b stderr truncated true', re.data.truncated.stderr, true);
    eq('H3c stdout intact', re.data.stdout, 'tiny');
  } finally { repo.dispose(); }
}
// ---- Group I: secret + HOME-path redaction (success and error surfaces) ------

{
  const { repo, req } = makeBound(217);
  try {
    const home = os.homedir();
    const TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    // Success surface: stdout carries HOME path + a secret token.
    const leak = { executable: 'node', argv: ['-e', 'process.stdout.write(require("os").homedir() + "|" + "' + TOKEN + '")'] };
    const rl = executeBrokerRequest(req('run_registered_test', { testId: 'leak' }), { testRegistry: { leak } });
    tru('I1 leak test ran (ok)', rl.ok);
    tru('I1a HOME path redacted on success surface', rl.data.stdout.includes('<HOME>'));
    falsy('I1b raw HOME path absent', home ? rl.data.stdout.includes(home) : true);
    tru('I1c secret token redacted on success surface', rl.data.stdout.includes('<SECRET>'));
    falsy('I1d raw token absent', rl.data.stdout.includes(TOKEN));

    // Error surface: failing test writes a secret to stderr.
    const fail = { executable: 'node', argv: ['-e', 'console.error("boom " + "' + TOKEN + '"); process.exit(1)'] };
    const rf = executeBrokerRequest(req('run_registered_test', { testId: 'fail' }), { testRegistry: { fail } });
    falsy('I2 failing test refused', rf.ok);
    eq('I2a reason TEST_NONZERO_EXIT', rf.reason, 'TEST_NONZERO_EXIT');
    tru('I2b secret token redacted on error surface', rf.data.stderr.includes('<SECRET>'));
    falsy('I2c raw token absent from stderr', rf.data.stderr.includes(TOKEN));
    falsy('I2d raw token absent from detail', rf.detail ? rf.detail.includes(TOKEN) : true);

    // Request-level detail redaction: a secret in a rejected request never leaks.
    const bad = executeBrokerRequest({
      request: { schemaVersion: BROKER_SCHEMA_VERSION, operation: 'status', repo: CANON, issueNumber: 1, baseSha: 'a'.repeat(40), args: {}, secret: TOKEN },
    });
    falsy('I3 request with secret field refused', bad.ok);
    falsy('I3a secret absent from response', JSON.stringify(bad).includes(TOKEN));
  } finally { repo.dispose(); }
}

// ---- Group J: non-zero exit reported, never converted to PASS ----------------

{
  const { repo, req } = makeBound(218);
  try {
    const fail3 = { executable: 'node', argv: ['-e', 'process.exit(3)'] };
    const r = executeBrokerRequest(req('run_registered_test', { testId: 'fail3' }), { testRegistry: { fail3 } });
    falsy('J1 non-zero exit not PASS', r.ok);
    eq('J1a reason TEST_NONZERO_EXIT', r.reason, 'TEST_NONZERO_EXIT');
    eq('J1b exitCode 3 reported', r.data.exitCode, 3);
    eq('J1c timedOut false', r.data.timedOut, false);
  } finally { repo.dispose(); }
}

// ---- Group K: broker never mutates; mutation by a test is detected -----------

{
  const { repo, req } = makeBound(219);
  try {
    // A non-mutating registered test leaves HEAD + status unchanged and reports
    // worktreeUnchanged: true (external no-mutation checks live in Group C).
    const ok = { executable: 'node', argv: ['-e', 'process.stdout.write("ok")'] };
    const r1 = executeBrokerRequest(req('run_registered_test', { testId: 'ok' }), { testRegistry: { ok } });
    tru('K1 non-mutating test ok', r1.ok);
    eq('K1a worktreeUnchanged true', r1.evidence.worktreeUnchanged, true);

    // A mutating registered test is detected and refused (read-only broker).
    const mut = { executable: 'node', argv: ['-e', 'require("fs").writeFileSync("EVIL.txt", "x")'] };
    const r2 = executeBrokerRequest(req('run_registered_test', { testId: 'mut' }), { testRegistry: { mut } });
    falsy('K2 mutating test refused', r2.ok);
    eq('K2a reason TEST_MUTATED_WORKTREE', r2.reason, 'TEST_MUTATED_WORKTREE');
    eq('K2b worktreeUnchanged false', r2.evidence.worktreeUnchanged, false);

    // Results are always plain structured objects, never raw Error instances.
    const any = executeBrokerRequest(req('status'));
    tru('K3 result is plain structured object (no raw Error)', any && typeof any === 'object' && !(any instanceof Error));
  } finally { repo.dispose(); }
}

// ---- summary ----------------------------------------------------------------

const pass = checks.filter((c) => c.ok).length;
for (const c of checks) if (!c.ok) console.log('FAIL', c.name, '=>', JSON.stringify(c.got), 'want', JSON.stringify(c.want));
console.log('\nTổng: ' + pass + '/' + checks.length + ' PASS');
process.exit(pass === checks.length ? 0 : 1);
