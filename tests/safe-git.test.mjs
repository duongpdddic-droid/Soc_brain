#!/usr/bin/env node
// safe-git.test.mjs â€” parity tests for Safe Git & HEAD read-back primitives (Issue #5).
// Source: duongpdddic-droid/AI_PR_REVIEWER
// Immutable source SHA: 9c104c88dddb3e9aad0388447e9be6ff74f78a06
// NO framework. Exit 0 = PASS, 1 = FAIL. Uses disposable temp Git repos.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  normalizeRemoteUrl, parseRepoFromRemoteUrl, remoteIsCanonical,
  detachedHeadCheck, protectedBranchCheck, baseSyncCheck,
  isAllowedWorktreeChange, worktreeBlockers,
  gitRoot, readBranchInfo, readLocalHead, readUpstreamHead,
  readRemoteUrl, readWorktreeStatus, readWorktreeConditions,
  preflight,
} from '../packages/safe-git/safe-git.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });
const deepEq = (n, g, w) => checks.push({ name: n, ok: JSON.stringify(g) === JSON.stringify(w), got: g, want: w });

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(DIR, '..', 'packages', 'safe-git', 'fixtures');
const load = (f) => JSON.parse(readFileSync(path.join(FX, f), 'utf8'));

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'safe-git-test-'));
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
    dir,
    commit: (file, content, msg = 'c') => {
      const fp = path.join(dir, file);
      const parent = path.dirname(fp);
      if (parent !== dir) mkdirSync(parent, { recursive: true });
      writeFileSync(fp, content);
      run(['add', file]);
      run(['commit', '-m', msg]);
      return run(['rev-parse', 'HEAD']).trim();
    },
    branch: (name, start = 'HEAD') => { run(['checkout', '-b', name, start]); },
    checkout: (ref) => { run(['checkout', ref]); },
    detach: (ref = 'HEAD') => { run(['checkout', '--detach', ref]); },
    setRemote: (name, url) => {
      try { run(['remote', 'remove', name]); } catch {}
      run(['remote', 'add', name, url]);
    },
    setRef: (ref, sha) => { run(['update-ref', ref, sha]); },
    dropRef: (ref) => { run(['update-ref', '-d', ref]); },
    sha: () => run(['rev-parse', 'HEAD']).trim(),
    writeUntracked: (file, content) => {
      const fp = path.join(dir, file);
      const parent = path.dirname(fp);
      if (parent !== dir) mkdirSync(parent, { recursive: true });
      writeFileSync(fp, content);
    },
    modify: (file, content) => { writeFileSync(path.join(dir, file), content); },
    stash: (content) => {
      const fp = path.join(dir, 'wip.txt');
      writeFileSync(fp, content);
      run(['add', 'wip.txt']);
      run(['stash']);
    },
    placeLock: (name) => {
      const gitDir = run(['rev-parse', '--absolute-git-dir']).trim();
      writeFileSync(path.join(gitDir, name), 'held');
    },
    dispose: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

// ---- AC1: HTTPS / SSH / git protocol / https-no-git all normalize ----------
{
  const fx = load('remote-urls.json');
  // normalizeRemoteUrl lowercases the WHOLE string (owner + repo), so 'Soc_brain' -> 'soc_brain'.
  const normalizedExpected = 'duongpdddic-droid/soc_brain';
  // parseRepoFromRemoteUrl preserves the original repo case.
  const parsedExpected = 'duongpdddic-droid/Soc_brain';
  for (const [label, url] of Object.entries(fx.forms)) {
    eq('AC1 normalize ' + label, normalizeRemoteUrl(url), normalizedExpected);
  }
  for (const [label, url] of Object.entries(fx.forms)) {
    eq('AC1 parse ' + label, parseRepoFromRemoteUrl(url), parsedExpected);
  }
  for (const [label, url] of Object.entries(fx.forms)) {
    tru('AC1 canonical ' + label, remoteIsCanonical(url, fx.canonicalRepo));
  }
  for (const u of fx.nonCanonical) {
    falsy('AC1 non-canonical rejected: ' + u.slice(0, 40), remoteIsCanonical(u, fx.canonicalRepo));
  }
  falsy('AC1 remoteIsCanonical empty expectedRepo -> false', remoteIsCanonical('https://github.com/a/b', ''));
  falsy('AC1 remoteIsCanonical undefined expectedRepo -> false', remoteIsCanonical('https://github.com/a/b', undefined));
  falsy('AC1 normalize empty -> empty', normalizeRemoteUrl(''));
  eq('AC1 parse non-github -> null', parseRepoFromRemoteUrl('https://gitlab.com/a/b.git'), null);
}

// ---- AC2: wrong remote fails preflight --------------------------------------
{
  const repo = makeRepo();
  try {
    repo.commit('README.md', 'x');
    repo.setRemote('origin', 'https://github.com/evil/Soc_brain.git');
    const r = preflight({ canonicalRepo: 'duongpdddic-droid/Soc_brain', cwd: repo.dir });
    eq('AC2 wrong remote -> BLOCKED_WRONG_REMOTE', r.status, 'BLOCKED_WRONG_REMOTE');
    eq('AC2 wrong remote echoes expected', r.expected, 'duongpdddic-droid/Soc_brain');
  } finally { repo.dispose(); }
}

// ---- AC3: cwd outside / below wrong Git root fails --------------------------
{
  const repo = makeRepo();
  try {
    repo.commit('README.md', 'x');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const r1 = preflight({ canonicalRepo: 'duongpdddic-droid/Soc_brain', cwd: repo.dir });
    eq('AC3 cwd=root -> not OUTSIDE_ROOT', r1.status !== 'BLOCKED_CWD_OUTSIDE_ROOT', true);
    const outside = mkdtempSync(path.join(os.tmpdir(), 'safe-git-no-repo-'));
    try {
      const r2 = preflight({ canonicalRepo: 'duongpdddic-droid/Soc_brain', cwd: outside });
      eq('AC3 cwd outside any Git repo -> ERROR_GIT', r2.status, 'ERROR_GIT');
    } finally { try { rmSync(outside, { recursive: true, force: true }); } catch {} }
  } finally { repo.dispose(); }
}

// ---- AC4: safe task branch with correct upstream passes ---------------------
{
  const repo = makeRepo();
  try {
    const baseSha = repo.commit('README.md', 'x');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    repo.setRef('refs/remotes/origin/main', baseSha);
    repo.branch('agent/issue-5-test', baseSha);
    repo.setRef('refs/remotes/origin/agent/issue-5-test', baseSha);
    const r = preflight({
      canonicalRepo: 'duongpdddic-droid/Soc_brain',
      cwd: repo.dir,
      expectedBaseSha: baseSha,
    });
    eq('AC4 safe task branch -> PREFLIGHT_OK', r.status, 'PREFLIGHT_OK');
    tru('AC4 verdict.ok true', r.verdict.ok);
    eq('AC4 expectedBase matches', r.expectedBase.matches, true);
  } finally { repo.dispose(); }
}

// ---- AC5: main mutation is blocked (protected branch) -----------------------
{
  const repo = makeRepo();
  try {
    const baseSha = repo.commit('README.md', 'x');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    repo.setRef('refs/remotes/origin/main', baseSha);
    const r = preflight({ canonicalRepo: 'duongpdddic-droid/Soc_brain', cwd: repo.dir });
    eq('AC5 on main -> PROTECTED_BRANCH', r.status, 'PROTECTED_BRANCH');
    eq('AC5 protectedBranches list contains main', r.protectedBranches.includes('main'), true);
  } finally { repo.dispose(); }
}

// ---- AC6: detached HEAD is blocked ------------------------------------------
{
  const repo = makeRepo();
  try {
    const sha = repo.commit('README.md', 'x');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    repo.setRef('refs/remotes/origin/main', sha);
    repo.detach(sha);
    const r = preflight({ canonicalRepo: 'duongpdddic-droid/Soc_brain', cwd: repo.dir });
    eq('AC6 detached -> DETACHED_HEAD', r.status, 'DETACHED_HEAD');
    falsy('AC6 detachedHeadCheck blocks', detachedHeadCheck({ isDetached: true }).ok);
    tru('AC6 detachedHeadCheck passes when attached', detachedHeadCheck({ isDetached: false }).ok);
  } finally { repo.dispose(); }
}

// ---- AC7: missing / wrong upstream is blocked -------------------------------
{
  const repo = makeRepo();
  try {
    const sha = repo.commit('README.md', 'x');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    repo.branch('agent/no-up', sha);
    const r = preflight({ canonicalRepo: 'duongpdddic-droid/Soc_brain', cwd: repo.dir });
    eq('AC7 missing upstream ref -> BLOCKED_MISSING_UPSTREAM', r.status, 'BLOCKED_MISSING_UPSTREAM');
    // For wrong-upstream test: stay on agent/no-up, advance local HEAD,
    // but leave origin/agent/no-up pointing at the OLD sha.
    repo.commit('chore.md', 'x', 'c2');
    repo.setRef('refs/remotes/origin/agent/no-up', sha);
    const r2 = preflight({ canonicalRepo: 'duongpdddic-droid/Soc_brain', cwd: repo.dir });
    eq('AC7 wrong upstream -> BLOCKED_STALE_BASE', r2.status, 'BLOCKED_STALE_BASE');
  } finally { repo.dispose(); }
}

// ---- AC8: dirty / untracked / stash / lock conditions are reported ----------
{
  const repo = makeRepo();
  try {
    const sha = repo.commit('README.md', 'x');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    repo.setRef('refs/remotes/origin/main', sha);
    repo.branch('agent/conditions', sha);
    repo.setRef('refs/remotes/origin/agent/conditions', sha);
    const c0 = readWorktreeConditions({ cwd: repo.dir });
    eq('AC8 clean: no dirty', c0.dirty.length, 0);
    eq('AC8 clean: no untracked', c0.untracked.length, 0);
    eq('AC8 clean: no stash', c0.stashed.length, 0);
    falsy('AC8 clean: no lock', c0.locked);
    // Create a.txt, then advance local HEAD + origin ref in lockstep so preflight
    // only sees dirty/untracked conditions, not stale base.
    const sha2 = repo.commit('a.txt', 'x');
    repo.setRef('refs/remotes/origin/agent/conditions', sha2);
    repo.modify('a.txt', 'y');
    repo.writeUntracked('u.txt', 'z');
    const c1 = readWorktreeConditions({ cwd: repo.dir });
    tru('AC8 dirty contains a.txt', c1.dirty.some((d) => d.file === 'a.txt'));
    tru('AC8 untracked contains u.txt', c1.untracked.includes('u.txt'));
    repo.stash('wip');
    const c2 = readWorktreeConditions({ cwd: repo.dir });
    tru('AC8 stash reported', c2.stashed.length >= 1);
    repo.placeLock('index.lock');
    const c3 = readWorktreeConditions({ cwd: repo.dir });
    tru('AC8 lock detected', c3.locked);
    tru('AC8 lock files include index.lock', c3.lockFiles.includes('index.lock'));
    // Preflight on the locked repo: need to keep upstream in sync for the lock
    // check to surface (otherwise BLOCKED_STALE_BASE wins first).
    const cur = repo.sha();
    repo.setRef('refs/remotes/origin/agent/conditions', cur);
    const r = preflight({ canonicalRepo: 'duongpdddic-droid/Soc_brain', cwd: repo.dir });
    eq('AC8 preflight locked -> BLOCKED_GIT_LOCK', r.status, 'BLOCKED_GIT_LOCK');
  } finally { repo.dispose(); }
}

// ---- AC9: dirty worktree outside allowed prefix is blocked in preflight ----
{
  const repo = makeRepo();
  try {
    const sha = repo.commit('README.md', 'x');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    repo.setRef('refs/remotes/origin/main', sha);
    repo.branch('agent/dirty', sha);
    repo.setRef('refs/remotes/origin/agent/dirty', sha);
    repo.modify('README.md', 'changed');
    const r = preflight({
      canonicalRepo: 'duongpdddic-droid/Soc_brain',
      cwd: repo.dir,
      allowedPrefixes: ['memory-bank/'],
    });
    eq('AC9 dirty outside allowlist -> BLOCKED_DIRTY_WORKTREE', r.status, 'BLOCKED_DIRTY_WORKTREE');
    const repo2 = makeRepo();
    try {
      const sha2 = repo2.commit('memory-bank/a.md', 'x');
      repo2.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
      repo2.setRef('refs/remotes/origin/main', sha2);
      repo2.branch('agent/memory', sha2);
      repo2.setRef('refs/remotes/origin/agent/memory', sha2);
      // Modify memory-bank file; keep origin ref in sync so preflight only
      // checks the worktree-clean condition, not stale-base.
      repo2.setRef('refs/remotes/origin/agent/memory', sha2);
      repo2.modify('memory-bank/a.md', 'changed');
      const r2 = preflight({
        canonicalRepo: 'duongpdddic-droid/Soc_brain',
        cwd: repo2.dir,
        allowedPrefixes: ['memory-bank/'],
      });
      eq('AC9 allowlist match -> PREFLIGHT_OK', r2.status, 'PREFLIGHT_OK');
    } finally { repo2.dispose(); }
    eq('AC9 worktreeBlockers filters allowed', worktreeBlockers(['memory-bank/a.md', 'b.txt'], ['memory-bank/']).join(','), 'b.txt');
    tru('AC9 isAllowedWorktreeChange exact', isAllowedWorktreeChange('memory-bank/', ['memory-bank/']));
    tru('AC9 isAllowedWorktreeChange nested', isAllowedWorktreeChange('memory-bank/x.md', ['memory-bank/']));
  } finally { repo.dispose(); }
}

// ---- AC10: stale base SHA is blocked ----------------------------------------
{
  const repo = makeRepo();
  try {
    repo.commit('README.md', 'x');
    const realBase = repo.sha();
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    repo.setRef('refs/remotes/origin/main', realBase);
    repo.branch('agent/stale', realBase);
    repo.setRef('refs/remotes/origin/agent/stale', realBase);
    const r = preflight({
      canonicalRepo: 'duongpdddic-droid/Soc_brain',
      cwd: repo.dir,
      expectedBaseSha: 'a'.repeat(40),
    });
    eq('AC10 stale base -> BLOCKED_STALE_BASE', r.status, 'BLOCKED_STALE_BASE');
    falsy('AC10 baseSyncCheck rejects expected mismatch',
      baseSyncCheck({ localSha: 'x'.repeat(40), remoteSha: 'y'.repeat(40), expectedBaseSha: 'z'.repeat(40) }).ok);
  } finally { repo.dispose(); }
}

// ---- AC11: local/upstream/expected HEAD mismatch is blocked ----------------
{
  const repo = makeRepo();
  try {
    const sha1 = repo.commit('README.md', 'x');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    repo.setRef('refs/remotes/origin/main', sha1);
    repo.branch('agent/mismatch', sha1);
    repo.setRef('refs/remotes/origin/agent/mismatch', sha1);
    repo.commit('b.md', 'y');
    const r1 = preflight({
      canonicalRepo: 'duongpdddic-droid/Soc_brain',
      cwd: repo.dir,
    });
    eq('AC11 local != upstream -> BLOCKED_STALE_BASE', r1.status, 'BLOCKED_STALE_BASE');
    const cur = repo.sha();
    repo.setRef('refs/remotes/origin/agent/mismatch', cur);
    const r2 = preflight({
      canonicalRepo: 'duongpdddic-droid/Soc_brain',
      cwd: repo.dir,
      expectedHeadSha: 'a'.repeat(40),
    });
    eq('AC11 expectedHead mismatch -> BLOCKED_HEAD_MISMATCH', r2.status, 'BLOCKED_HEAD_MISMATCH');
  } finally { repo.dispose(); }
}

// ---- AC12: matching full SHAs pass -----------------------------------------
{
  const repo = makeRepo();
  try {
    const sha = repo.commit('README.md', 'x');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    repo.setRef('refs/remotes/origin/main', sha);
    repo.branch('agent/match', sha);
    repo.setRef('refs/remotes/origin/agent/match', sha);
    const r = preflight({
      canonicalRepo: 'duongpdddic-droid/Soc_brain',
      cwd: repo.dir,
      expectedBaseSha: sha,
      expectedHeadSha: sha,
    });
    eq('AC12 matching SHAs -> PREFLIGHT_OK', r.status, 'PREFLIGHT_OK');
    eq('AC12 upstream sha == localHead sha', r.upstream.sha, r.localHead.sha);
    tru('AC12 expectedBase matches', r.expectedBase.matches);
    tru('AC12 expectedHead matches', r.expectedHead.matches);
    tru('AC12 baseSyncCheck ok', baseSyncCheck({ localSha: sha, remoteSha: sha }).ok);
  } finally { repo.dispose(); }
}

// ---- AC13: structured output deterministic + no secret / machine path ------
{
  const repo = makeRepo();
  try {
    const sha = repo.commit('README.md', 'x');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    repo.setRef('refs/remotes/origin/main', sha);
    repo.branch('agent/det', sha);
    repo.setRef('refs/remotes/origin/agent/det', sha);
    const r = preflight({ canonicalRepo: 'duongpdddic-droid/Soc_brain', cwd: repo.dir });
    const s = JSON.stringify(r);
    // No secret-looking values (apiKey/password/botToken/secret) in the payload.
    falsy('AC13 result no apiKey', /apiKey/i.test(s));
    falsy('AC13 result no botToken', /botToken/i.test(s));
    falsy('AC13 result no secret=', /secret=/.test(s));
    // gitRoot IS expected to echo the cwd; the test contract is that the
    // *committed fixtures* (remote-urls.json) have no machine-specific paths.
    const fx = JSON.stringify(load('remote-urls.json'));
    falsy('AC13 fixture no C:\\Users path', /C:\\Users\\/.test(fx));
    falsy('AC13 fixture no /home/user path', /\/home\/[a-z]+\//.test(fx));
    // Determinism: rerun and check JSON is byte-identical.
    const r2 = preflight({ canonicalRepo: 'duongpdddic-droid/Soc_brain', cwd: repo.dir });
    eq('AC13 deterministic output', JSON.stringify(r2), s);
    for (const k of ['canonicalRepo','gitRoot','remote','branch','upstream','localHead','expectedHead','worktree','verdict','status']) {
      tru('AC13 result has key ' + k, k in r);
    }
  } finally { repo.dispose(); }
}

// ---- AC14: protectedBranchCheck unit + NO_BRANCH ----------------------------
{
  tru('AC14 protectedBranchCheck main -> blocked', !protectedBranchCheck({ branchName: 'main' }).ok);
  tru('AC14 protectedBranchCheck feature -> ok', protectedBranchCheck({ branchName: 'feature/x' }).ok);
  tru('AC14 protectedBranchCheck custom set blocks', !protectedBranchCheck({ branchName: 'release/1', protectedBranches: ['release/1'] }).ok);
  falsy('AC14 NO_BRANCH', protectedBranchCheck({ branchName: '' }).ok);
}

// ---- AC15: read-back primitives (readLocalHead, readUpstreamHead) ------------
{
  const repo = makeRepo();
  try {
    const sha = repo.commit('README.md', 'x');
    repo.setRef('refs/remotes/origin/main', sha);
    eq('AC15 readLocalHead full SHA', readLocalHead({ cwd: repo.dir }), sha);
    eq('AC15 readUpstreamHead full SHA', readUpstreamHead({ branch: 'main', cwd: repo.dir }), sha);
    let remoteErr = null;
    try { readRemoteUrl({ cwd: repo.dir }); } catch (e) { remoteErr = e; }
    tru('AC15 readRemoteUrl throws when no remote', remoteErr !== null);
    repo.dropRef('refs/remotes/origin/main');
    eq('AC15 readUpstreamHead missing -> null', readUpstreamHead({ branch: 'main', cwd: repo.dir }), null);
    tru('AC15 gitRoot absolute', path.isAbsolute(gitRoot({ cwd: repo.dir })));
    const bi = readBranchInfo({ cwd: repo.dir });
    eq('AC15 readBranchInfo on main', bi.branchName, 'main');
    falsy('AC15 readBranchInfo not detached', bi.isDetached);
    repo.modify('README.md', 'changed');
    deepEq('AC15 readWorktreeStatus', readWorktreeStatus({ cwd: repo.dir }), ['README.md']);
  } finally { repo.dispose(); }
}

// ---- AC16: preflight config error ------------------------------------------
{
  const r = preflight({});
  eq('AC16 missing canonicalRepo -> ERROR_CONFIG', r.status, 'ERROR_CONFIG');
}

// ---- AC17: preflight fails closed if no remote ------------------------------
{
  const repo = makeRepo();
  try {
    repo.commit('README.md', 'x');
    try { repo.run(['remote', 'remove', 'origin']); } catch {}
    // Need to bypass the CWD check: stay in repo dir
    const r = preflight({ canonicalRepo: 'duongpdddic-droid/Soc_brain', cwd: repo.dir });
    eq('AC17 no remote -> BLOCKED_WRONG_REMOTE', r.status, 'BLOCKED_WRONG_REMOTE');
  } finally { repo.dispose(); }
}

// Catch stray errors so the runner always reports.
process.on('uncaughtException', (e) => {
  console.log('UNCAUGHT', e.message);
  const pass = checks.filter((c) => c.ok).length;
  console.log('\nTá»•ng: ' + pass + '/' + checks.length + ' PASS (uncaught)');
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.log('UNHANDLED', (e && e.message) || e);
  const pass = checks.filter((c) => c.ok).length;
  console.log('\nTá»•ng: ' + pass + '/' + checks.length + ' PASS (unhandled)');
  process.exit(1);
});

const pass = checks.filter((c) => c.ok).length;
for (const c of checks) if (!c.ok) console.log('FAIL', c.name, '=>', JSON.stringify(c.got), 'want', JSON.stringify(c.want));
console.log('\nTá»•ng: ' + pass + '/' + checks.length + ' PASS');
process.exit(pass === checks.length ? 0 : 1);
