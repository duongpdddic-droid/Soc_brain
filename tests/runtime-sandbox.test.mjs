#!/usr/bin/env node
// runtime-sandbox.test.mjs — tests for packages/runtime-sandbox (Issue #18).
// Real-FS tests: guard rejections, taskStart happy path with provisioned worktree.
// Follows same pattern as workspace.test.mjs (makeRepo, checks, summary).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import {
  mainCheckoutGuard, symlinkEscapeGuard,
  taskStart, SANDBOX_SCHEMA_VERSION, ALLOWED_OPERATIONS,
} from '../packages/runtime-sandbox/runtime-sandbox.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

const CANON = 'duongpdddic-droid/Soc_brain';
const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-rs-'));
const TMP_ROOT = path.join(TMP, 'worktrees');
mkdirSync(TMP_ROOT, { recursive: true });

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
// ---- SANDBOX_SCHEMA_VERSION / ALLOWED_OPERATIONS --------------------------------
eq('SANDBOX_SCHEMA_VERSION', SANDBOX_SCHEMA_VERSION, '1');
eq('ALLOWED_OPERATIONS length', ALLOWED_OPERATIONS.length, 3);
tru('ALLOWED_OPERATIONS includes status', ALLOWED_OPERATIONS.includes('status'));
tru('ALLOWED_OPERATIONS includes diff', ALLOWED_OPERATIONS.includes('diff'));
tru('ALLOWED_OPERATIONS includes run_registered_test', ALLOWED_OPERATIONS.includes('run_registered_test'));

// ---- mainCheckoutGuard: rejects worktree inside the main checkout ---------------
{
  let repo;
  try {
    repo = makeRepo();
    const baseSha = repo.commit('GUARD.md', 'g');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    // The main checkout itself should be rejected.
    const mg = mainCheckoutGuard({ worktree: repo.dir, controlCwd: repo.dir });
    falsy('mainCheckoutGuard rejects main checkout itself', mg.ok);
    if (!mg.ok) {
      const reasons = mg.errors.map((e) => e.reason);
      eq('mainCheckoutGuard reason is WORKTREE_IS_MAIN_CHECKOUT', reasons[0], 'WORKTREE_IS_MAIN_CHECKOUT');
    }
  } finally { if (repo) repo.dispose(); }
}

// ---- mainCheckoutGuard: non-git controlCwd -> NO_GIT_ROOT -----------------------
{
  const unrelated = mkdtempSync(path.join(TMP, 'unrelated-'));
  try {
    const mg = mainCheckoutGuard({ worktree: unrelated, controlCwd: unrelated });
    falsy('mainCheckoutGuard on non-git dir returns NO_GIT_ROOT', mg.ok);
    if (!mg.ok) eq('mainCheckoutGuard non-git reason', mg.errors[0].reason, 'NO_GIT_ROOT');
  } finally { try { rmSync(unrelated, { recursive: true, force: true }); } catch {} }
}

// ---- symlinkEscapeGuard: rejects symlink worktree path --------------------------
{
  let repo;
  let symlinkMade = false;
  try {
    repo = makeRepo();
    repo.commit('SYMLINK_GUARD.md', 's');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const fakeWt = mkdtempSync(path.join(TMP, 'fakewt-'));
    const symlinkWt = path.join(TMP, 'symlink-wt');
    try {
      symlinkSync(fakeWt, symlinkWt, process.platform === 'win32' ? 'junction' : 'dir');
      symlinkMade = true;
    } catch (e) {
      console.log('  symlink unsupported, skipping: ' + String((e && e.message) || e));
    }
    if (symlinkMade) {
      const sg = symlinkEscapeGuard({ worktree: symlinkWt, worktreesRoot: TMP_ROOT });
      falsy('symlinkEscapeGuard rejects symlink path', sg.ok);
      if (!sg.ok) {
        const reasons = sg.errors.map((e) => e.reason);
        tru('symlinkEscapeGuard rejects (SYMLINK or ESCAPES_ROOT)', reasons.includes('WORKTREE_SYMLINK') || reasons.includes('WORKTREE_ESCAPES_ROOT'));
      }
      try { rmSync(symlinkWt, { recursive: true, force: true }); } catch {}
    }
    try { rmSync(fakeWt, { recursive: true, force: true }); } catch {}
  } finally { if (repo) repo.dispose(); }
}

// ---- symlinkEscapeGuard: rejects worktree outside worktreesRoot -----------------
{
  const outside = mkdtempSync(path.join(TMP, 'outside-'));
  const sg = symlinkEscapeGuard({ worktree: outside, worktreesRoot: TMP_ROOT });
  falsy('symlinkEscapeGuard rejects path outside root', sg.ok);
  if (!sg.ok) {
    const reasons = sg.errors.map((e) => e.reason);
    tru('symlinkEscapeGuard includes WORKTREE_ESCAPES_ROOT', reasons.includes('WORKTREE_ESCAPES_ROOT'));
  }
  try { rmSync(outside, { recursive: true, force: true }); } catch {}
}
// ---- taskStart happy path -------------------------------------------------------
{
  let repo;
  try {
    repo = makeRepo();
    const baseSha = repo.commit('START.md', 's');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issueNumber = 118;
    const result = taskStart({
      repo: CANON, issueNumber, baseSha,
      worktreesRoot: TMP_ROOT,
      controlCwd: repo.dir,
      testRegistry: {},
    });
    tru('taskStart ok', result.ok);
    if (result.ok) {
      tru('taskStart has evidence', result.evidence);
      eq('taskStart evidence schemaVersion', result.evidence.schemaVersion, '1');
      tru('taskStart evidence has binding', result.evidence.binding);
      eq('taskStart evidence binding.repo', result.evidence.binding.repo, 'duongpdddic-droid/soc_brain');
      eq('taskStart evidence binding.issueNumber', result.evidence.binding.issueNumber, issueNumber);
      eq('taskStart evidence binding.baseSha', result.evidence.binding.baseSha, baseSha);
      tru('taskStart evidence binding.identityHash', result.evidence.binding.identityHash);
      eq('taskStart evidence binding.identityHash length', result.evidence.binding.identityHash.length, 32);
      tru('taskStart has broker', result.broker);
      eq('taskStart broker type', typeof result.broker, 'object');
      tru('taskStart has mcpCommand', result.mcpCommand);
      eq('taskStart mcpCommand is process.execPath', result.mcpCommand, process.execPath);
      tru('taskStart has mcpArgs', result.mcpArgs);
      tru('taskStart has mcpEnv', result.mcpEnv);
      eq('taskStart mcpEnv has SOC_WORKTREES_ROOT', result.mcpEnv.SOC_WORKTREES_ROOT, path.resolve(TMP_ROOT));
      eq('taskStart mcpEnv has SOC_REPO', result.mcpEnv.SOC_REPO, 'duongpdddic-droid/soc_brain');
      eq('taskStart mcpEnv has SOC_ISSUE', result.mcpEnv.SOC_ISSUE, String(issueNumber));
      eq('taskStart mcpEnv has SOC_BASE_SHA', result.mcpEnv.SOC_BASE_SHA, baseSha);
      tru('taskStart mcpEnv has SOC_TEST_REGISTRY', result.mcpEnv.SOC_TEST_REGISTRY);
      tru('taskStart has openCodeConfig', result.openCodeConfig);
      eq('openCodeConfig bash', result.openCodeConfig.bash, 'deny');
      eq('openCodeConfig edit', result.openCodeConfig.edit, 'deny');
      tru('openCodeConfig has mcpServers.soc-brain', result.openCodeConfig.mcpServers['soc-brain']);
      eq('mcpServer command', result.openCodeConfig.mcpServers['soc-brain'].command, process.execPath);
      tru('openCodeConfigPath ends with opencode.json', result.openCodeConfigPath.endsWith('opencode.json'));
      // Verify the file was actually written and its content matches.
      tru('opencode.json exists on disk', fs.existsSync(result.openCodeConfigPath));
      const stored = JSON.parse(fs.readFileSync(result.openCodeConfigPath, 'utf8'));
      eq('stored config bash', stored.bash, 'deny');
      tru('stored config has mcpServers', stored.mcpServers);
      tru('evidence has opencode', result.evidence.opencode);
      tru('evidence opencode has digest', result.evidence.opencode.digest);
      eq('evidence opencode digest length', result.evidence.opencode.digest.length, 64);
      tru('evidence opencode bytes > 0', result.evidence.opencode.bytes > 0);
    }
  } finally { if (repo) repo.dispose(); }
}

// ---- taskStart validation: missing params ---------------------------------------
falsy('taskStart missing repo', taskStart({ issueNumber: 1, baseSha: 'a'.repeat(40) }).ok);
falsy('taskStart missing issueNumber', taskStart({ repo: CANON, baseSha: 'a'.repeat(40) }).ok);
falsy('taskStart missing baseSha', taskStart({ repo: CANON, issueNumber: 1 }).ok);
falsy('taskStart invalid baseSha', taskStart({ repo: CANON, issueNumber: 1, baseSha: 'short' }).ok);
falsy('taskStart missing worktreesRoot', taskStart({ repo: CANON, issueNumber: 1, baseSha: 'a'.repeat(40) }).ok);

// ---- summary --------------------------------------------------------------------
const pass = checks.filter((c) => c.ok).length;
for (const c of checks) if (!c.ok) console.log('FAIL', c.name, '=>', JSON.stringify(c.got), 'want', JSON.stringify(c.want));
console.log('\nTotal: ' + pass + '/' + checks.length + ' PASS');
// Best-effort cleanup
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(pass === checks.length ? 0 : 1);