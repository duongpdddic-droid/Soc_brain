#!/usr/bin/env node
// workspace.test.mjs — tests for packages/workspace (Issue #13).
// Real-FS tests: creates a disposable Git repo, provisions a worktree,
// verifies binding, cleanup. NO framework. Exit 0 = PASS, 1 = FAIL.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import {
  identityHash, worktreePathFor, bindingPathFor, worktreeBranchFor,
  verifyBinding, bindTask, provision, cleanup,
  defaultWorktreesRoot, IDENTITY_HASH_LENGTH, BINDING_SCHEMA_VERSION,
} from '../packages/workspace/workspace.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

const CANON = 'duongpdddic-droid/Soc_brain';
const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-ws-'));
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

// ---- identityHash -----------------------------------------------------------

{
  const h1 = identityHash({ repo: CANON, issueNumber: 13 });
  const h2 = identityHash({ repo: CANON, issueNumber: 13 });
  const h3 = identityHash({ repo: CANON, issueNumber: 42 });
  const h4 = identityHash({ repo: 'evil/other', issueNumber: 13 });
  tru('identityHash non-null for valid inputs', h1);
  eq('identityHash length', h1.length, IDENTITY_HASH_LENGTH);
  tru('identityHash idempotent', h1 === h2);
  tru('identityHash different issue -> different hash', h1 !== h3);
  tru('identityHash different repo -> different hash', h1 !== h4);
  eq('identityHash missing repo -> null', identityHash({ issueNumber: 13 }), null);
  eq('identityHash missing issueNumber -> null', identityHash({ repo: CANON }), null);
  eq('identityHash zero issue -> null', identityHash({ repo: CANON, issueNumber: 0 }), null);
  eq('identityHash negative issue -> null', identityHash({ repo: CANON, issueNumber: -1 }), null);
}

// ---- path derivation --------------------------------------------------------

{
  const h = identityHash({ repo: CANON, issueNumber: 13 });
  const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
  const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
  const br = worktreeBranchFor({ identityHash: h });
  tru('worktreePathFor ends with identityHash', wt.endsWith(h));
  tru('worktreePathFor contains agent', wt.includes('agent' + path.sep));
  tru('worktreePathFor starts with worktreesRoot', wt.startsWith(TMP_ROOT));
  tru('bindingPathFor ends with .json', bp.endsWith('.json'));
  tru('bindingPathFor contains bindings', bp.includes('bindings' + path.sep));
  eq('worktreeBranchFor', br, 'agent/' + h);
}

// ---- defaultWorktreesRoot ---------------------------------------------------

{
  const d = defaultWorktreesRoot();
  tru('defaultWorktreesRoot returns string', typeof d === 'string' && d.length > 0);
  tru('defaultWorktreesRoot contains .soc-brain', d.includes('.soc-brain'));
  tru('defaultWorktreesRoot contains worktrees', d.includes('worktrees'));
}
// ---- full provision + verify + cleanup (real FS) ----------------------------

{
  const repo = makeRepo();
  try {
    const baseSha = repo.commit('README.md', 'initial');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const NORM = 'duongpdddic-droid/soc_brain';

    // 1. Provision first time
    const p = provision({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: 13, baseSha, cwd: repo.dir,
    });
    tru('provision ok', p.ok);
    eq('provision idempotent false (first time)', p.idempotent, false);
    tru('provision path exists', p.path && fs.existsSync(p.path));
    tru('provision branch starts with agent/', typeof p.branch === 'string' && p.branch.startsWith('agent/'));
    eq('provision baseSha', p.baseSha, baseSha);
    eq('provision repo (normalized)', p.repo, NORM);
    tru('provision created includes worktree', p.created.includes('worktree'));
    tru('provision created includes binding', p.created.includes('binding'));

    // Worktree HEAD = baseSha
    const wtHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: p.path, encoding: 'utf8' }).trim();
    eq('worktree HEAD = baseSha', wtHead, baseSha);

    // Branch exists in main repo
    const branches = execFileSync('git', ['branch', '--list', p.branch], { cwd: repo.dir, encoding: 'utf8' }).trim();
    tru('branch exists in main repo', branches.includes(p.branch));

    // Binding file is valid
    const h = identityHash({ repo: CANON, issueNumber: 13 });
    const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    tru('binding file exists', fs.existsSync(bp));
    const binding = JSON.parse(fs.readFileSync(bp, 'utf8'));
    eq('binding schemaVersion', binding.schemaVersion, BINDING_SCHEMA_VERSION);
    eq('binding repo (normalized)', binding.repo, NORM);
    eq('binding issueNumber', binding.issueNumber, 13);
    eq('binding baseSha', binding.baseSha, baseSha);
    eq('binding branch', binding.branch, p.branch);
    tru('binding createdAt is ISO', typeof binding.createdAt === 'string' && binding.createdAt.length > 10);
  } finally { repo.dispose(); }
}

// ---- verifyBinding pass + idempotent provision + ancestor check -------------

{
  const repo = makeRepo();
  try {
    const baseSha = repo.commit('BASE.md', 'base');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');

    const p = provision({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: 14, baseSha, cwd: repo.dir,
    });
    tru('v-idem setup: provision ok', p.ok);

    // 2. Verify binding
    const v = verifyBinding({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: 14, baseSha, cwd: repo.dir,
    });
    tru('verifyBinding ok', v.ok);
    eq('verifyBinding head', v.head, baseSha);
    eq('verifyBinding baseSha', v.baseSha, baseSha);

    // 3. Provision again (idempotent)
    const p2 = provision({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: 14, baseSha, cwd: repo.dir,
    });
    tru('provision idempotent ok', p2.ok);
    eq('provision idempotent flag true', p2.idempotent, true);
    eq('provision idempotent created empty', p2.created.length, 0);

    // 4. Advance worktree HEAD with a new commit, then verifyBinding
    //    still passes (baseSha is ancestor of new HEAD).
    writeFileSync(path.join(p.path, 'advance.txt'), 'new commit');
    execFileSync('git', ['add', 'advance.txt'], { cwd: p.path, encoding: 'utf8' });
    execFileSync('git', ['commit', '-m', 'advance'], { cwd: p.path, encoding: 'utf8' });
    const newHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: p.path, encoding: 'utf8' }).trim();
    tru('worktree advanced past baseSha', newHead !== baseSha);

    const v2 = verifyBinding({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: 14, baseSha, cwd: repo.dir,
    });
    tru('verifyBinding after advance -> ok (ancestor check)', v2.ok);
    eq('verifyBinding head after advance', v2.head, newHead);

    // 5. Unrelated sha -> BASE_NOT_ANCESTOR.
    //    To reach the ancestor check, the binding must MATCH the requested
    //    identity. Pass an unrelated sha as baseSha AND rewrite the binding's
    //    baseSha to the same unrelated sha so the identity check passes, then
    //    the ancestor check is what must fail (the worktree HEAD does not have
    //    that unrelated sha as an ancestor).
    const otherRepo = makeRepo();
    try {
      const unrelatedSha = otherRepo.commit('UNRELATED.md', 'z');
      const h = identityHash({ repo: CANON, issueNumber: 14 });
      const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
      const binding = JSON.parse(fs.readFileSync(bp, 'utf8'));
      binding.baseSha = unrelatedSha;
      fs.writeFileSync(bp, JSON.stringify(binding));
      const v3 = verifyBinding({
        worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: 14, baseSha: unrelatedSha, cwd: repo.dir,
      });
      falsy('verifyBinding unrelated sha -> not ok', v3.ok);
      eq('verifyBinding unrelated sha reason', v3.reason, 'BASE_NOT_ANCESTOR');
    } finally { otherRepo.dispose(); }
  } finally { repo.dispose(); }
}
// ---- bindTask: pre-existing mutated binding -> COLLISION_BINDING_MISMATCH ---

{
  const repo = makeRepo();
  try {
    const baseSha = repo.commit('COLLISION.md', 'a');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');

    // Use a FRESH issue number so no prior state exists, then corrupt the
    // binding fields to simulate an externally-mutated binding.
    const issue = 61;
    const p1 = provision({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo.dir,
    });
    tru('collision setup: provision ok', p1.ok);

    const h = identityHash({ repo: CANON, issueNumber: issue });
    const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    const binding = JSON.parse(fs.readFileSync(bp, 'utf8'));
    binding.repo = 'evil/mutated';
    fs.writeFileSync(bp, JSON.stringify(binding));

    const b2 = bindTask({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo.dir,
    });
    falsy('bindTask mutated binding -> not ok', b2.ok);
    eq('bindTask mutated binding reason', b2.reason, 'COLLISION_BINDING_MISMATCH');
    tru('bindTask mutated binding reports mismatched field', Array.isArray(b2.mismatched) && b2.mismatched.includes('repo'));
  } finally { repo.dispose(); }
}

// ---- bindTask: worktree dir without binding -> refuse -----------------------

{
  const h = identityHash({ repo: CANON, issueNumber: 62 });
  const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
  mkdirSync(wt, { recursive: true });

  const repo = makeRepo();
  try {
    const baseSha = repo.commit('ORPHAN.md', 'o');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');

    const b = bindTask({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: 62, baseSha, cwd: repo.dir,
    });
    falsy('bindTask orphan dir -> not ok', b.ok);
    eq('bindTask orphan dir reason', b.reason, 'COLLISION_WORKTREE_WITHOUT_BINDING');
  } finally { repo.dispose(); }
}

// ---- cleanup: removes worktree + binding, idempotent ------------------------

{
  const repo = makeRepo();
  try {
    const baseSha = repo.commit('CLEANUP.md', 'c');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');

    const p = provision({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: 77, baseSha, cwd: repo.dir,
    });
    tru('cleanup setup: provision ok', p.ok);

    const c = cleanup({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: 77, baseSha, cwd: repo.dir,
    });
    tru('cleanup ok', c.ok);
    eq('cleanup reason', c.reason, 'CLEANED');
    tru('cleanup removed worktree', c.removed.includes('worktree'));
    tru('cleanup removed binding', c.removed.includes('binding'));
    falsy('cleanup worktree dir gone', fs.existsSync(p.path));
    const h = identityHash({ repo: CANON, issueNumber: 77 });
    const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    falsy('cleanup binding file gone', fs.existsSync(bp));

    // Worktree pruned from `git worktree list`
    const wtList = execFileSync('git', ['worktree', 'list'], { cwd: repo.dir, encoding: 'utf8' }).trim();
    falsy('cleanup pruned from worktree list', wtList.includes(p.path));

    // Cleanup again (idempotent)
    const c2 = cleanup({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: 77, baseSha, cwd: repo.dir,
    });
    tru('cleanup idempotent ok', c2.ok);
    eq('cleanup idempotent reason', c2.reason, 'ALREADY_ABSENT');
    tru('cleanup idempotent flag', c2.idempotent);
  } finally { repo.dispose(); }
}

// ---- cleanup: dirty worktree refused ----------------------------------------

{
  const repo = makeRepo();
  try {
    const baseSha = repo.commit('DIRTY.md', 'd');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');

    const p = provision({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: 88, baseSha, cwd: repo.dir,
    });
    tru('dirty-cleanup setup: provision ok', p.ok);

    writeFileSync(path.join(p.path, 'dirty.txt'), 'dirty content');
    const c = cleanup({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: 88, baseSha, cwd: repo.dir,
    });
    falsy('dirty-cleanup not ok', c.ok);
    eq('dirty-cleanup reason', c.reason, 'DIRTY_WORKTREE');
    tru('dirty-cleanup has blockers', Array.isArray(c.blockers) && c.blockers.length > 0);
  } finally { repo.dispose(); }
}
// ---- cleanup: locked worktree refused ---------------------------------------

{
  const repo = makeRepo();
  try {
    const baseSha = repo.commit('LOCKED.md', 'l');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');

    const p = provision({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: 99, baseSha, cwd: repo.dir,
    });
    tru('locked-cleanup setup: provision ok', p.ok);

    const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: p.path, encoding: 'utf8' }).trim();
    writeFileSync(path.join(gitDir, 'index.lock'), 'held');

    const c = cleanup({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: 99, baseSha, cwd: repo.dir,
    });
    falsy('locked-cleanup not ok', c.ok);
    eq('locked-cleanup reason', c.reason, 'WORKTREE_LOCKED');
    tru('locked-cleanup has lockFiles', Array.isArray(c.lockFiles) && c.lockFiles.length > 0);
  } finally { repo.dispose(); }
}

// ---- BIND_VERIFY_FAILED: post-create verification failure rolls back --------

{
  const repo = makeRepo();
  try {
    const baseSha = repo.commit('VERIFYFAIL.md', 'v');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issue = 110;

    // Custom exec: pass through everything EXCEPT `git merge-base
    // --is-ancestor` (the ancestor check inside verifyBinding), which throws.
    // Worktree + binding are created first; verification then fails, so
    // bindTask must roll back worktree + binding + branch + reservation.
    const realExec = execFileSync;
    const failingExec = (cmd, args, opts) => {
      if (cmd === 'git' && args && args[0] === 'merge-base' && args.includes('--is-ancestor')) {
        const e = new Error('simulated verify failure');
        e.stderr = 'fatal: simulated';
        throw e;
      }
      return realExec(cmd, args, opts);
    };

    const b = bindTask({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo.dir, exec: failingExec,
    });
    falsy('verify-fail rollback: not ok', b.ok);
    eq('verify-fail rollback reason', b.reason, 'BIND_VERIFY_FAILED');

    const h = identityHash({ repo: CANON, issueNumber: issue });
    const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    const lock = bp + '.reserved';

    falsy('verify-fail rollback: worktree dir removed', fs.existsSync(wt));
    falsy('verify-fail rollback: binding removed', fs.existsSync(bp));
    falsy('verify-fail rollback: reservation removed', fs.existsSync(lock));

    // Branch created by this call must also be gone.
    const branch = worktreeBranchFor({ identityHash: h });
    const branchList = execFileSync('git', ['branch', '--list', branch], { cwd: repo.dir, encoding: 'utf8' }).trim();
    falsy('verify-fail rollback: branch deleted', branchList.includes(branch));
  } finally { repo.dispose(); }
}

// ---- COLLISION_CONCURRENT_BINDING: reservation lock refuses concurrent ------

{
  const repo = makeRepo();
  try {
    const baseSha = repo.commit('RESERVE.md', 'r');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issue = 111;
    const h = identityHash({ repo: CANON, issueNumber: issue });
    const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    const lock = bp + '.reserved';

    // Pre-existing reservation (simulates a concurrent caller in flight).
    mkdirSync(path.dirname(bp), { recursive: true });
    writeFileSync(lock, 'reserved by concurrent caller');

    const b = bindTask({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo.dir,
    });
    falsy('concurrent: bindTask refused', b.ok);
    eq('concurrent: reason', b.reason, 'COLLISION_CONCURRENT_BINDING');

    // Nothing was created.
    const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    falsy('concurrent: no worktree created', fs.existsSync(wt));
    falsy('concurrent: no binding created', fs.existsSync(bp));

    // Release the reservation -> provision now succeeds and is idempotent.
    rmSync(lock, { force: true });
    const p = provision({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo.dir,
    });
    tru('concurrent: after release provision ok', p.ok);
    const p2 = provision({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo.dir,
    });
    tru('concurrent: second provision idempotent', p2.ok && p2.idempotent === true);
    falsy('concurrent: reservation released after success', fs.existsSync(lock));
  } finally { repo.dispose(); }
}


// ---- cleanup: reservation held -> CLEANUP_RESERVATION_EXISTS ----------------

{
  const repo = makeRepo();
  try {
    const baseSha = repo.commit('RESERVECLEAN.md', 'r');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issue = 112;
    const p = provision({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo.dir,
    });
    tru('reserve-cleanup setup: provision ok', p.ok);

    const h = identityHash({ repo: CANON, issueNumber: issue });
    const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    const lock = bp + '.reserved';

    // Concurrent caller's reservation is present -> cleanup refuses.
    writeFileSync(lock, 'held by concurrent caller');
    const c = cleanup({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo.dir,
    });
    falsy('reserve-cleanup not ok', c.ok);
    eq('reserve-cleanup reason', c.reason, 'CLEANUP_RESERVATION_EXISTS');
    tru('reserve-cleanup: worktree preserved', fs.existsSync(wt));

    // Release -> cleanup succeeds, worktree + binding removed.
    rmSync(lock, { force: true });
    const c2 = cleanup({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo.dir,
    });
    tru('reserve-cleanup after release ok', c2.ok);
    falsy('reserve-cleanup: worktree removed', fs.existsSync(wt));
    falsy('reserve-cleanup: binding removed', fs.existsSync(bp));
  } finally { repo.dispose(); }
}

// ---- cleanup: malformed binding -> fail-closed, nothing removed -------------

{
  const repo = makeRepo();
  try {
    const baseSha = repo.commit('MALFORMED.md', 'm');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issue = 114;
    const p = provision({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo.dir,
    });
    tru('malformed setup: provision ok', p.ok);
    const h = identityHash({ repo: CANON, issueNumber: issue });
    const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });

    // Valid JSON but not an object -> BINDING_MALFORMED in readBinding.
    writeFileSync(bp, '[]');
    const c = cleanup({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo.dir,
    });
    falsy('malformed cleanup not ok', c.ok);
    eq('malformed cleanup reason', c.reason, 'CLEANUP_VERIFY_FAILED');
    eq('malformed cleanup verify reason', c.verify && c.verify.reason, 'BINDING_MALFORMED');
    tru('malformed cleanup: worktree preserved', fs.existsSync(wt));
    tru('malformed cleanup: binding preserved', fs.existsSync(bp));
  } finally { repo.dispose(); }
}

// ---- cleanup: mismatched binding -> fail-closed, nothing removed ------------

{
  const repo = makeRepo();
  try {
    const baseSha = repo.commit('MISMATCH.md', 'm');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issue = 115;
    const p = provision({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo.dir,
    });
    tru('mismatch setup: provision ok', p.ok);
    const h = identityHash({ repo: CANON, issueNumber: issue });
    const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });

    const binding = JSON.parse(fs.readFileSync(bp, 'utf8'));
    binding.repo = 'evil/mutated';
    fs.writeFileSync(bp, JSON.stringify(binding));

    const c = cleanup({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo.dir,
    });
    falsy('mismatch cleanup not ok', c.ok);
    eq('mismatch cleanup reason', c.reason, 'CLEANUP_VERIFY_FAILED');
    eq('mismatch cleanup verify reason', c.verify && c.verify.reason, 'BINDING_IDENTITY_MISMATCH');
    tru('mismatch cleanup: worktree preserved', fs.existsSync(wt));
    tru('mismatch cleanup: binding preserved', fs.existsSync(bp));

    // Pre-existing state intact: worktree still on the task branch.
    const branch = worktreeBranchFor({ identityHash: h });
    const br = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: wt, encoding: 'utf8' }).trim();
    eq('mismatch cleanup: branch unchanged', br, branch);
  } finally { repo.dispose(); }
}


{
// ---- cleanup: binding without worktree -> fail-closed (WS-002) --------------

{
  const repo = makeRepo();
  try {
    const baseSha = repo.commit('BINDONLY.md', 'b');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issue = 116;
    const p = provision({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo.dir,
    });
    tru('bind-only setup: provision ok', p.ok);
    const h = identityHash({ repo: CANON, issueNumber: issue });
    const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });

    // Remove the worktree directory, leaving only the binding.
    rmSync(wt, { recursive: true, force: true });

    const c = cleanup({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo.dir,
    });
    falsy('bind-only cleanup not ok', c.ok);
    eq('bind-only cleanup reason', c.reason, 'CLEANUP_VERIFY_FAILED');
    eq('bind-only cleanup verify reason', c.verify && c.verify.reason, 'WORKTREE_MISSING');
    tru('bind-only cleanup: binding preserved', fs.existsSync(bp));
  } finally { repo.dispose(); }
}

// ---- cleanup: wrong remote -> fail-closed (WS-002) --------------------------

{
  const repo = makeRepo();
  try {
    const baseSha = repo.commit('WRONGREMOTE.md', 'w');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issue = 117;
    const p = provision({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo.dir,
    });
    tru('wrong-remote setup: provision ok', p.ok);
    const h = identityHash({ repo: CANON, issueNumber: issue });
    const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });

    // Point the worktree's origin at a different (non-canonical) repo.
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/evil/other.git'], { cwd: wt, encoding: 'utf8' });

    const c = cleanup({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo.dir,
    });
    falsy('wrong-remote cleanup not ok', c.ok);
    eq('wrong-remote cleanup reason', c.reason, 'CLEANUP_VERIFY_FAILED');
    eq('wrong-remote cleanup verify reason', c.verify && c.verify.reason, 'WORKTREE_WRONG_REMOTE');
    tru('wrong-remote cleanup: worktree preserved', fs.existsSync(wt));
  } finally { repo.dispose(); }
}


// ---- cleanup: wrong branch -> fail-closed (WS-002) --------------------------

{
  const repo = makeRepo();
  try {
    const baseSha = repo.commit('WRONGBRANCH.md', 'w');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issue = 118;
    const p = provision({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo.dir,
    });
    tru('wrong-branch setup: provision ok', p.ok);
    const h = identityHash({ repo: CANON, issueNumber: issue });
    const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });

    // Switch the worktree to a different branch.
    execFileSync('git', ['checkout', '-b', 'other-branch'], { cwd: wt, encoding: 'utf8' });

    const c = cleanup({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo.dir,
    });
    falsy('wrong-branch cleanup not ok', c.ok);
    eq('wrong-branch cleanup reason', c.reason, 'CLEANUP_VERIFY_FAILED');
    eq('wrong-branch cleanup verify reason', c.verify && c.verify.reason, 'WORKTREE_WRONG_BRANCH');
    tru('wrong-branch cleanup: worktree preserved', fs.existsSync(wt));
  } finally { repo.dispose(); }
}

// ---- wrong cwd: not a git root -> fail-closed -------------------------------

{
  const repo = makeRepo();
  try {
    const baseSha = repo.commit('WRONGCWD.md', 'w');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issue = 119;
    const p = provision({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo.dir,
    });
    tru('wrong-cwd setup: provision ok', p.ok);

    const badCwd = mkdtempSync(path.join(TMP, 'nocwd-'));
    const v = verifyBinding({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: badCwd,
    });
    falsy('wrong-cwd verify not ok', v.ok);
    eq('wrong-cwd verify reason', v.reason, 'NO_GIT_ROOT');

    const c = cleanup({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: badCwd,
    });
    falsy('wrong-cwd cleanup not ok', c.ok);
    eq('wrong-cwd cleanup reason', c.reason, 'CLEANUP_VERIFY_FAILED');
  } finally { repo.dispose(); }
}


// ---- symlink/junction worktree path: verify refuses (OS permitting) ---------

{
  let repo;
  let symlinkMade = false;
  try {
    repo = makeRepo();
    const baseSha = repo.commit('SYMLINK.md', 's');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issue = 120;
    const p = provision({
      worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo.dir,
    });
    tru('symlink setup: provision ok', p.ok);
    const h = identityHash({ repo: CANON, issueNumber: issue });
    const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });

    // Replace the (clean, verified) worktree with a symlink/junction pointing
    // at the main repo dir (outside worktreesRoot).
    rmSync(wt, { recursive: true, force: true });
    try {
      fs.symlinkSync(repo.dir, wt, process.platform === 'win32' ? 'junction' : 'dir');
      symlinkMade = true;
    } catch (e) {
      // OS denies symlink creation (e.g. no developer mode) -> skip.
      console.log('  symlink unsupported, skipping: ' + String((e && e.message) || e));
    }

    if (symlinkMade) {
      const v = verifyBinding({
        worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: issue, baseSha, cwd: repo.dir,
      });
      falsy('symlink verify not ok', v.ok);
      const acceptable = ['WORKTREE_NOT_REAL_DIR', 'PATH_ESCAPES_ROOT'];
      tru('symlink verify reason is fail-closed', acceptable.includes(v.reason));
    }
  } finally { if (repo) repo.dispose(); }
}


  falsy('provision missing repo', provision({ issueNumber: 13, baseSha: 'a'.repeat(40) }).ok);
  falsy('provision missing issueNumber', provision({ repo: CANON, baseSha: 'a'.repeat(40) }).ok);
  falsy('provision missing baseSha', provision({ repo: CANON, issueNumber: 13 }).ok);
  falsy('provision invalid baseSha', provision({ repo: CANON, issueNumber: 13, baseSha: 'short' }).ok);
  falsy('verifyBinding invalid baseSha', verifyBinding({ repo: CANON, issueNumber: 13, baseSha: 'short' }).ok);
  falsy('cleanup invalid baseSha', cleanup({ repo: CANON, issueNumber: 13, baseSha: 'short' }).ok);
  falsy('cleanup missing worktreesRoot', cleanup({ repo: CANON, issueNumber: 13, baseSha: 'a'.repeat(40) }).ok);
}

// ---- summary ----------------------------------------------------------------

const pass = checks.filter((c) => c.ok).length;
for (const c of checks) if (!c.ok) console.log('FAIL', c.name, '=>', JSON.stringify(c.got), 'want', JSON.stringify(c.want));
console.log('\nTổng: ' + pass + '/' + checks.length + ' PASS');
process.exit(pass === checks.length ? 0 : 1);
