#!/usr/bin/env node
// workspace.mjs - Soc_brain: isolated workspace provisioning primitives (Issue #13).
//
// Source: duongpdddic-droid/AI_PR_REVIEWER
// Immutable source SHA: 9c104c88dddb3e9aad0388447e9be6ff74f78a06
// Source functions (behavior evidence only):
//   - scripts/github-task-intake.mjs: `worktreeStatusLines`, `isAllowedWorktreeChange`,
//     `worktreeBlockers` (dirty/untracked gate used by cleanup), `branchSafetyCheck`
//     (branch pinning shape).
//   - scripts/temp-hygiene.mjs: containment (isInside/isSymlink), ownership-marker,
//     and idempotent-cleanup patterns.
//
// Material adaptations from the source:
//   - The source never provisions isolated workspaces; it runs agent work
//     directly in the main checkout. This module is a new Soc_brain primitive
//     (Issue #13) that creates a disposable `git worktree` per task at a
//     machine-local `worktreesRoot` OUTSIDE the main checkout, pins the task's
//     base SHA, and records a task binding JSON atomically outside the repo.
//   - `cleanup` NEVER stashes changes or uses the global stash as evidence of a
//     worktree's state. Dirty/untracked detection is read directly from `git
//     status --porcelain` in the worktree itself.
//   - `cleanup` keeps the task branch by default. Deleting a branch is a
//     control-plane operation outside this module's authority.
//   - Everything is read-back verified against the real Git state; the module
//     never trusts caller assertions.
//
// Reuse (no reimplementation):
//   - packages/safe-git:     gitRoot, readBranchInfo, readLocalHead, readRemoteUrl,
//                            readWorktreeStatus, normalizeRemoteUrl, remoteIsCanonical.
//   - packages/temp-hygiene: isInside, isSymlink.
//   - packages/task-intake:  buildStableTaskId (stable task identity).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  gitRoot,
  readBranchInfo,
  readLocalHead,
  readRemoteUrl,
  readWorktreeStatus,
  normalizeRemoteUrl,
  remoteIsCanonical,
} from '../safe-git/safe-git.mjs';

// ---- small helpers --------------------------------------------------------

const run = (cmd, args, { cwd, exec = execFileSync } = {}) => {
  const out = exec(cmd, args, { cwd, encoding: 'utf8' });
  return String(out).replace(/\r\n/g, '\n').trim();
};

// `git merge-base --is-ancestor A B` exits 0 when A is an ancestor of B.
// Read-back evidence is captured on stderr for the error detail.
function isAncestor({ sha, cwd, exec }) {
  try {
    exec('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      detail: String(((e && e.stderr) || (e && e.message) || e)).trim(),
    };
  }
}

// Realpath of a path, or null when the path does not exist / cannot be resolved.
function realPathOrNull(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

// Windows-safe containment via temp-hygiene isInside (case-insensitive).
function isCanonicalInside(root, p) {
  return isInside(root, p);
}

// ---- identity -------------------------------------------------------------

// Deterministic identity hash for the worktree path / branch / binding file.
// Derived ONLY from normalized repo + positive issue number (mirrors
// task-intake buildStableTaskId) so repeated provisioning is idempotent and a
// renamed issue title can never change the namespace.
export function identityHash({ repo, issueNumber }) {
  const r = normalizeRemoteUrl(repo);
  const n = Number(issueNumber);
  if (!r || !Number.isInteger(n) || n <= 0) return null;
  return crypto
    .createHash('sha256')
    .update(`workspace|v1|${r}|${n}`)
    .digest('hex')
    .slice(0, IDENTITY_HASH_LENGTH);
}

// Paths derived from the identity hash. `branch` is the worktree branch name
// (same stem as the directory); both live under `worktreesRoot`/`agent/`.
export function worktreePathFor({ worktreesRoot, identityHash: h }) {
  return path.join(worktreesRoot, 'agent', h);
}

export function bindingPathFor({ worktreesRoot, identityHash: h }) {
  return path.join(worktreesRoot, 'bindings', `${h}.json`);
}

export function worktreeBranchFor({ identityHash: h }) {
  return `agent/${h}`;
}

// ---- binding read/write ---------------------------------------------------

function readBinding(bindingPath) {
  let raw;
  try {
    raw = fs.readFileSync(bindingPath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, reason: 'BINDING_ABSENT' };
    return { ok: false, reason: 'BINDING_UNREADABLE', detail: String((e && e.message) || e) };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'BINDING_MALFORMED', detail: String((e && e.message) || e) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'BINDING_MALFORMED' };
  return { ok: true, binding: parsed };
}

function bindingMatches({ binding, expected }) {
  const fields = ['taskId', 'repo', 'issueNumber', 'baseSha', 'branch', 'remote', 'path'];
  const bad = [];
  for (const f of fields) {
    if (String(binding[f] ?? '') !== String(expected[f] ?? '')) bad.push(f);
  }
  return bad.length === 0 ? { ok: true } : { ok: false, mismatched: bad };
}

// Create-exclusive reservation: a lock file that prevents concurrent callers
// from overwriting each other's binding. Uses O_CREAT|O_EXCL (wx) so the
// filesystem guarantees only one creator wins. Returns the fd on success,
// null when the lock already exists.
function createExclusiveLock(lockPath) {
  const dir = path.dirname(lockPath);
  fs.mkdirSync(dir, { recursive: true });
  try {
    // 'wx' — open for writing, fail if file exists
    const fd = fs.openSync(lockPath, 'wx');
    fs.closeSync(fd);
    return lockPath;
  } catch (e) {
    if (e.code === 'EEXIST' || e.code === 'ENOENT') return null;
    throw e;
  }
}

function removeExclusiveLock(lockPath) {
  try { fs.rmSync(lockPath, { force: true }); } catch { /* best-effort */ }
}

// Atomic no-clobber write: write to a temp file in the same directory then
// hard-link it into place. The link fails with EEXIST if a destination
// already exists, so a binding that appears after any pre-check is NEVER
// overwritten (GPT-REV-114). Same-filesystem link is atomic on POSIX and
// Windows NTFS; readers either see no file or the complete file. The temp
// file is always cleaned up in the finally block.
function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    // No-clobber: hard-link fails with EEXIST if destination already exists.
    // This is the atomic publication step — after this point, the binding is
    // visible under filePath.
    fs.linkSync(tmp, filePath);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
  }
}

// Reservation path for a binding. The lock file sits beside the binding file
// so the same directory's mkdirSync already ensures the parent exists.
function reservationPathFor(bindingPath) {
  return path.join(path.dirname(bindingPath), `${path.basename(bindingPath)}.reserved`);
}

// Ownership-scoped rollback: removes ONLY artifacts that this call created.
// Returns a list of rollback error strings (empty = clean rollback).
// `branch` + `branchExistedBefore`: when the task branch was created by this
// call (`git worktree add -b`), it is also rolled back - but only if it did
// NOT already exist before the call (never delete pre-existing branches).
function rollbackCreated({ wtPath, bPath, created, cwd, exec, branch, branchExistedBefore }) {
  const errors = [];
  if (!created.includes('worktree') && !created.includes('binding')) return errors;
  try { run('git', ['worktree', 'remove', '--force', wtPath], { cwd, exec }); } catch (e) { errors.push(`rollback worktree remove failed: ${String((e && e.message) || e)}`); }
  try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch (e) { errors.push(`rollback fs remove failed: ${String((e && e.message) || e)}`); }
  if (created.includes('binding')) {
    try { fs.rmSync(bPath, { recursive: true, force: true }); } catch (e) { errors.push(`rollback binding remove failed: ${String((e && e.message) || e)}`); }
  }
  if (created.includes('worktree') && branch && !branchExistedBefore) {
    try { run('git', ['branch', '-D', branch], { cwd, exec }); } catch (e) { errors.push(`rollback branch delete failed: ${String((e && e.message) || e)}`); }
  }
  return errors;
}

// True when a local branch already exists (so a caller knows whether a branch
// it is about to create is new or pre-existing).
function branchExists({ branch, cwd, exec }) {
  try {
    run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd, exec });
    return true;
  } catch {
    return false;
  }
}

import { isInside, isSymlink } from '../temp-hygiene/temp-hygiene.mjs';
import { buildStableTaskId } from '../task-intake/task-intake.mjs';

export const BINDING_SCHEMA_VERSION = '1.0';
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const SHA40_RE = /^[0-9a-f]{40}$/;
export const IDENTITY_HASH_LENGTH = 32; // 128-bit hex prefix of sha256(task identity)

// Machine-local worktrees root. Never inside any Git checkout.
export function defaultWorktreesRoot() {
  return path.join(os.homedir(), '.soc-brain', 'worktrees');
}

// ---- input validation (fail-closed) ---------------------------------------

function validateProvisionInputs({ worktreesRoot, repo, issueNumber, baseSha }) {
  if (typeof worktreesRoot !== 'string' || !worktreesRoot) return { ok: false, reason: 'MISSING_WORKTREES_ROOT' };
  const r = normalizeRemoteUrl(repo);
  if (!r) return { ok: false, reason: 'MISSING_REPO' };
  const n = Number(issueNumber);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, reason: 'MISSING_ISSUE_NUMBER' };
  if (typeof baseSha !== 'string' || !SHA40_RE.test(baseSha)) return { ok: false, reason: 'INVALID_BASE_SHA' };
  const h = identityHash({ repo: r, issueNumber: n });
  if (!h) return { ok: false, reason: 'IDENTITY_UNSTABLE' };
  const taskId = buildStableTaskId({ repo: r, issueNumber: n });
  if (!taskId) return { ok: false, reason: 'IDENTITY_UNSTABLE' };
  return {
    ok: true,
    repo: r,
    issueNumber: n,
    baseSha,
    taskId,
    identityHash: h,
    worktreesRoot: path.resolve(worktreesRoot),
  };
}

// ---- verifyBinding ---------------------------------------------------------
// Fail-closed. Checks every identity field recorded in the binding against the
// real Git state of the worktree, plus path containment and base ancestry.
// HEAD is allowed to have NEW commits on top of the pinned base (ancestor
// check), but a base that is missing/stale/non-ancestor fails.

export function verifyBinding({
  worktreesRoot,
  repo,
  issueNumber,
  baseSha,
  cwd = process.cwd(),
  exec = execFileSync,
} = {}) {
  const v = validateProvisionInputs({ worktreesRoot, repo, issueNumber, baseSha });
  if (!v.ok) return { ok: false, reason: v.reason, detail: `verifyBinding: ${v.reason}` };

  const root = path.resolve(worktreesRoot);
  const wtPath = worktreePathFor({ worktreesRoot: root, identityHash: v.identityHash });
  const bPath = bindingPathFor({ worktreesRoot: root, identityHash: v.identityHash });

  // 1. Binding must exist and be readable.
  const rb = readBinding(bPath);
  if (!rb.ok) return { ok: false, reason: rb.reason, path: bPath, detail: `Binding file ${bPath} missing or unreadable.` };

  const b = rb.binding;
  if (b.schemaVersion !== BINDING_SCHEMA_VERSION) {
    return { ok: false, reason: 'BINDING_SCHEMA_MISMATCH', schemaVersion: b.schemaVersion };
  }

  // 2. Every identity field must match the caller's expected identity.
  const expected = {
    taskId: v.taskId,
    repo: v.repo,
    issueNumber: v.issueNumber,
    baseSha: v.baseSha,
    branch: worktreeBranchFor({ identityHash: v.identityHash }),
    remote: normalizeRemoteUrl(v.repo),
    path: wtPath,
  };
  const match = bindingMatches({ binding: b, expected });
  if (!match.ok) {
    return { ok: false, reason: 'BINDING_IDENTITY_MISMATCH', mismatched: match.mismatched, detail: `Binding fields ${match.mismatched.join(', ')} do not match the requested identity.` };
  }

  // 3. Worktree directory must exist and be a real directory (not a symlink).
  let st;
  try { st = fs.lstatSync(wtPath); } catch {
    return { ok: false, reason: 'WORKTREE_MISSING', path: wtPath, detail: 'Worktree path does not exist.' };
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return { ok: false, reason: 'WORKTREE_NOT_REAL_DIR', path: wtPath, detail: 'Worktree path is a symlink or not a directory.' };
  }

  // 4. realpath containment: the resolved worktree must not escape the root.
  const realRoot = realPathOrNull(root);
  const realWt = realPathOrNull(wtPath);
  if (!realRoot || !realWt) {
    return { ok: false, reason: 'REALPATH_UNRESOLVABLE', path: wtPath, detail: 'Could not resolve realpath of worktreesRoot or worktree.' };
  }
  if (!isCanonicalInside(realRoot, realWt)) {
    return { ok: false, reason: 'PATH_ESCAPES_ROOT', path: wtPath, root: realRoot, detail: 'Worktree realpath escapes worktreesRoot.' };
  }
  // The root itself must be outside the main checkout's Git tree.
  let mainRoot;
  try { mainRoot = gitRoot({ cwd, exec }); } catch {
    return { ok: false, reason: 'NO_GIT_ROOT', detail: 'Could not determine the main checkout Git root.' };
  }
  if (isCanonicalInside(mainRoot, realRoot)) {
    return { ok: false, reason: 'WORKTREES_ROOT_INSIDE_REPO', root: realRoot, detail: 'worktreesRoot resolves inside the main checkout.' };
  }

  // 5. Real Git state of the worktree must match the binding.
  let branch;
  let head;
  let remoteUrl;
  try {
    const info = readBranchInfo({ cwd: wtPath, exec });
    if (info.isDetached) return { ok: false, reason: 'WORKTREE_DETACHED', branch: null, detail: 'Worktree HEAD is detached; expected task branch.' };
    branch = info.branchName;
    head = readLocalHead({ cwd: wtPath, exec });
    remoteUrl = readRemoteUrl({ remote: 'origin', cwd: wtPath, exec });
  } catch (e) {
    return { ok: false, reason: 'WORKTREE_GIT_UNREADABLE', detail: String((e && e.message) || e) };
  }
  if (branch !== expected.branch) {
    return { ok: false, reason: 'WORKTREE_WRONG_BRANCH', branch, expected: expected.branch };
  }
  if (!remoteIsCanonical(remoteUrl, v.repo)) {
    return { ok: false, reason: 'WORKTREE_WRONG_REMOTE', remote: remoteUrl, expected: v.repo };
  }

  // 6. baseSha must be an ancestor of the worktree HEAD. HEAD may have new
  //    commits on top, but a base that is not an ancestor (stale/rebase/force)
  //    fails closed.
  const anc = isAncestor({ sha: v.baseSha, cwd: wtPath, exec });
  if (!anc.ok) {
    return {
      ok: false,
      reason: 'BASE_NOT_ANCESTOR',
      baseSha: v.baseSha,
      head,
      detail: `Pinned base ${v.baseSha.slice(0, 12)} is not an ancestor of worktree HEAD ${head.slice(0, 12)}.`,
      gitDetail: anc.detail,
    };
  }

  return { ok: true, binding: b, path: wtPath, branch, head, baseSha: v.baseSha, repo: v.repo };
}


// ---- bindTask --------------------------------------------------------------
// Creates the worktree (if not already bound) and writes the binding JSON.
// Collision / pre-existing invalid state is refused; nothing is overwritten or
// deleted. Failure rollback removes ONLY artifacts created by this call.
// Uses a filesystem reservation (O_CREAT|O_EXCL) to prevent concurrent callers
// from overwriting each other's binding.

export function bindTask({
  worktreesRoot,
  repo,
  issueNumber,
  baseSha,
  cwd = process.cwd(),
  exec = execFileSync,
} = {}) {
  const v = validateProvisionInputs({ worktreesRoot, repo, issueNumber, baseSha });
  if (!v.ok) return { ok: false, reason: v.reason, detail: `bindTask: ${v.reason}` };

  const root = path.resolve(worktreesRoot);
  const wtPath = worktreePathFor({ worktreesRoot: root, identityHash: v.identityHash });
  const bPath = bindingPathFor({ worktreesRoot: root, identityHash: v.identityHash });
  const branch = worktreeBranchFor({ identityHash: v.identityHash });
  const lockPath = reservationPathFor(bPath);

  // Idempotency: existing valid binding + worktree -> verified ok (no re-create).
  const existing = readBinding(bPath);
  if (existing.ok) {
    const expected = {
      taskId: v.taskId,
      repo: v.repo,
      issueNumber: v.issueNumber,
      baseSha: v.baseSha,
      branch,
      remote: normalizeRemoteUrl(v.repo),
      path: wtPath,
    };
    const m = bindingMatches({ binding: existing.binding, expected });
    if (!m.ok) {
      return { ok: false, reason: 'COLLISION_BINDING_MISMATCH', mismatched: m.mismatched, detail: 'An existing binding exists for this identity with different fields; refusing to overwrite.' };
    }
    // Binding matches; the worktree may or may not exist yet. If it exists and
    // verifies, this is an idempotent success. If it is missing, that is a
    // pre-existing inconsistent state - refuse (never partially re-provision).
    if (fs.existsSync(wtPath)) {
      const check = verifyBinding({ worktreesRoot: root, repo: v.repo, issueNumber: v.issueNumber, baseSha: v.baseSha, cwd, exec });
      if (check.ok) {
        return { ok: true, ...check, idempotent: true, created: [] };
      }
      return { ok: false, reason: 'PREEXISTING_INVALID_WORKTREE', detail: 'Binding exists but the worktree fails verification; refusing to modify pre-existing state.', check };
    }
    return { ok: false, reason: 'COLLISION_BINDING_WITHOUT_WORKTREE', detail: 'Binding exists but no worktree directory; inconsistent pre-existing state, refusing to write.' };
  }

  // No valid binding. If the binding file EXISTS but could not be read or
  // validated (malformed / unreadable / non-regular), this is pre-existing
  // invalid state - refuse BEFORE the reservation or any mutation. Never
  // overwrite or delete a binding we cannot validate.
  if (fs.existsSync(bPath)) {
    return {
      ok: false,
      reason: 'COLLISION_BINDING_UNREADABLE',
      path: bPath,
      read: { reason: existing.reason, detail: existing.detail },
      detail: `Binding file exists but cannot be validated (${existing.reason}); refusing to create a worktree or overwrite pre-existing state.`,
    };
  }

  // No binding. A worktree directory already present without a binding is a
  // collision - never adopt or delete it.
  if (fs.existsSync(wtPath)) {
    return { ok: false, reason: 'COLLISION_WORKTREE_WITHOUT_BINDING', path: wtPath, detail: 'A directory exists at the target worktree path with no binding; refusing to overwrite or delete it.' };
  }

  // Nothing exists. Verify the root is outside the main checkout before creating.
  let mainRoot;
  try { mainRoot = gitRoot({ cwd, exec }); } catch {
    return { ok: false, reason: 'NO_GIT_ROOT', detail: 'Could not determine the main checkout Git root.' };
  }
  const realRoot = realPathOrNull(root) || root;
  if (isCanonicalInside(mainRoot, realRoot)) {
    return { ok: false, reason: 'WORKTREES_ROOT_INSIDE_REPO', detail: 'worktreesRoot resolves inside the main checkout.' };
  }

  // Create-exclusive reservation: prevents concurrent callers from both
  // creating a binding for the same identity. Held through the mutation and
  // released on success or cleaned up on rollback.
  if (!createExclusiveLock(lockPath)) {
    return { ok: false, reason: 'COLLISION_CONCURRENT_BINDING', detail: 'Another caller is currently provisioning this identity (reservation lock exists).' };
  }


  const created = [];
  const branchExistedBefore = branchExists({ branch, cwd, exec });
  try {
    // 1. Create the worktree with its task branch at the pinned base SHA.
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    // Issue #83 (P0-G): the task branch is CONTINUOUS across loop legs. When a
    // previous leg already published the branch (it exists on the canonical
    // remote and descends from the pinned base), resume from the REMOTE TIP so
    // this leg's executor commit fast-forwards on push instead of colliding
    // non-fast-forward with the adopted PR head. A branch that exists only
    // locally was left behind by cleanup after a failed leg and carries no
    // published state; it is deleted so a fresh branch at base can be created.
    let startSha = v.baseSha;
    let ls = null;
    try { ls = String(exec('git', ['ls-remote', 'origin', `refs/heads/${branch}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '').trim(); } catch { /* offline: fall through to base */ }
    const remoteTip = ls ? ls.split(/\s+/)[0] : '';
    if (remoteTip.length === 40) {
      // Bring the published tip's objects into this repository before the
      // ancestry check and worktree creation can reference it.
      try { exec('git', ['fetch', '--force', 'origin', `refs/heads/${branch}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch { /* fall through to base */ }
      const ancestor = (() => { try { exec('git', ['merge-base', '--is-ancestor', v.baseSha, remoteTip], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return true; } catch { return false; } })();
      if (ancestor) {
        startSha = remoteTip;
      } else if (branchExists({ branch, cwd, exec })) {
        run('git', ['branch', '-D', branch], { cwd, exec });
      }
    } else if (branchExists({ branch, cwd, exec })) {
      run('git', ['branch', '-D', branch], { cwd, exec });
    }
    run('git', ['worktree', 'add', '-b', branch, wtPath, startSha], { cwd, exec });
    created.push('worktree');
    // 2. Write the binding JSON atomically outside the repo.
    const binding = {
      schemaVersion: BINDING_SCHEMA_VERSION,
      taskId: v.taskId,
      // Issue #83 (P0-G): consumers (executor-launcher's canonical binding
      // re-read in launchExecutorAdapter, control-ui fixtures) require the
      // identity hash on the binding record; omitting it made every real
      // executor launch fail closed with BINDING_UNAVAILABLE.
      identityHash: v.identityHash,
      repo: v.repo,
      issueNumber: v.issueNumber,
      baseSha: v.baseSha,
      branch,
      remote: normalizeRemoteUrl(v.repo),
      path: wtPath,
      createdAt: new Date().toISOString(),
    };
    atomicWriteJson(bPath, binding);
    created.push('binding');
  } catch (e) {
    // Failure rollback: remove ONLY artifacts this call created.
    const errors = [String((e && e.message) || e), ...rollbackCreated({ wtPath, bPath, created, cwd, exec, branch, branchExistedBefore })];
    removeExclusiveLock(lockPath);
    if (e && e.code === 'EEXIST') {
      // A binding appeared at the destination after the pre-check gate but
      // before/at publish. No-clobber publish refused to overwrite it. This
      // call's own artifacts (worktree + branch it created) are rolled back;
      // the pre-existing binding is preserved byte-for-byte (it is NOT in
      // `created`, so rollbackCreated never removes it).
      return {
        ok: false,
        reason: 'COLLISION_BINDING_EEXIST',
        path: bPath,
        created: created.slice(),
        rolledBack: created.slice(),
        errors,
        detail: `A binding already exists at the publish destination; refusing to overwrite. Rolled back this call's artifacts: ${errors.join(' | ')}`,
      };
    }
    return { ok: false, reason: 'BIND_FAILED', created: created.slice(), rolledBack: created.slice(), errors, detail: errors.join(' | ') };
  }

  // Read-back: verify the created state before reporting success.
  let check;
  try {
    check = verifyBinding({ worktreesRoot: root, repo: v.repo, issueNumber: v.issueNumber, baseSha: v.baseSha, cwd, exec });
  } catch (e) {
    // verifyBinding threw — rollback artifacts created by this call.
    const errors = [String((e && e.message) || e), ...rollbackCreated({ wtPath, bPath, created, cwd, exec, branch, branchExistedBefore })];
    removeExclusiveLock(lockPath);
    const rollbackOk = errors.length === 1; // only the original error, no rollback errors
    return {
      ok: false,
      reason: rollbackOk ? 'BIND_VERIFY_FAILED' : 'RECOVERY_REQUIRED',
      created: created.slice(),
      rolledBack: created.slice(),
      errors,
      detail: rollbackOk ? `Created worktree failed verification (throw): ${errors[0]}` : `Rollback incomplete after verify failure: ${errors.join(' | ')}`,
    };
  }

  if (!check.ok) {
    // verifyBinding reported a failure — rollback artifacts created by this call.
    const errors = rollbackCreated({ wtPath, bPath, created, cwd, exec, branch, branchExistedBefore });
    removeExclusiveLock(lockPath);
    const rollbackOk = errors.length === 0;
    return {
      ok: false,
      ...check,
      reason: rollbackOk ? 'BIND_VERIFY_FAILED' : 'RECOVERY_REQUIRED',
      created: created.slice(),
      rolledBack: created.slice(),
      rollbackErrors: errors.length > 0 ? errors : undefined,
      detail: rollbackOk
        ? `Created worktree failed verification: ${check.reason}. All artifacts rolled back.`
        : `Created worktree failed verification: ${check.reason}. Rollback incomplete: ${errors.join(' | ')}`,
    };
  }

  // Success — release the reservation.
  removeExclusiveLock(lockPath);
  return { ok: true, ...check, idempotent: false, created };
}

// ---- provision --------------------------------------------------------------
// Top-level idempotent provision. If a valid binding + verified worktree
// already exists, returns the existing state. Otherwise creates it.

export function provision({
  worktreesRoot,
  repo,
  issueNumber,
  baseSha,
  cwd = process.cwd(),
  exec = execFileSync,
} = {}) {
  const v = validateProvisionInputs({ worktreesRoot, repo, issueNumber, baseSha });
  if (!v.ok) return { ok: false, reason: v.reason, detail: `provision: ${v.reason}` };
  return bindTask({ worktreesRoot: v.worktreesRoot, repo: v.repo, issueNumber: v.issueNumber, baseSha: v.baseSha, cwd, exec });
}

// ---- cleanup ---------------------------------------------------------------
// Removes the worktree and its binding. By default the task BRANCH is always
// kept (deleting a branch is a separate control-plane operation). Cleanup
// refuses a dirty / untracked / locked worktree - read directly from the
// worktree's own Git state, never from the global stash.
// Fail-closed (WS-002): the binding must exist, be readable, and verify
// against the real Git state (identity fields, realpath containment, branch,
// canonical remote, Git root) BEFORE any mutation. Missing / malformed /
// mismatched binding -> refusal, no `git worktree remove` / `fs.rm`.

export function cleanup({
  worktreesRoot,
  repo,
  issueNumber,
  baseSha,
  cwd = process.cwd(),
  exec = execFileSync,
  keepBranch = true,
} = {}) {
  const v = validateProvisionInputs({ worktreesRoot, repo, issueNumber, baseSha });
  if (!v.ok) return { ok: false, reason: v.reason, detail: `cleanup: ${v.reason}` };

  const root = path.resolve(worktreesRoot);
  const wtPath = worktreePathFor({ worktreesRoot: root, identityHash: v.identityHash });
  const bPath = bindingPathFor({ worktreesRoot: root, identityHash: v.identityHash });
  const lockPath = reservationPathFor(bPath);

  // Absent workspace is a clean no-op (idempotent cleanup).
  const hasWt = fs.existsSync(wtPath);
  const hasBinding = fs.existsSync(bPath);
  if (!hasWt && !hasBinding) {
    return { ok: true, idempotent: true, removed: [], keptBranch: keepBranch ? worktreeBranchFor({ identityHash: v.identityHash }) : null, reason: 'ALREADY_ABSENT' };
  }

  const res = { ok: false, removed: [], keptBranch: null, errors: [] };
  if (keepBranch) res.keptBranch = worktreeBranchFor({ identityHash: v.identityHash });

  // WS-003: a provisioning reservation lock means another caller may be
  // mid-mutation. Refuse cleanup rather than racing it.
  if (fs.existsSync(lockPath)) {
    return { ok: false, ...res, reason: 'CLEANUP_RESERVATION_EXISTS', detail: 'A provisioning reservation lock exists; refusing cleanup while another caller may be mutating state.' };
  }

  // A worktree without a binding is unowned state - never adopt or delete it.
  if (hasWt && !hasBinding) {
    return { ok: false, ...res, reason: 'COLLISION_WORKTREE_WITHOUT_BINDING', detail: 'Worktree exists without a binding; refusing to delete unowned state.' };
  }

  // WS-002: pre-mutation verification. The binding must exist, be readable,
  // schema-valid, match the requested identity (taskId / repo / issueNumber /
  // baseSha / branch / remote / path), be realpath-contained under the root,
  // and the worktree's real Git state must match (branch, canonical remote,
  // Git root, base ancestry). Any failure -> fail-closed, no mutation.
  const check = verifyBinding({ worktreesRoot: root, repo: v.repo, issueNumber: v.issueNumber, baseSha: v.baseSha, cwd, exec });
  if (!check.ok) {
    return {
      ok: false,
      ...res,
      reason: 'CLEANUP_VERIFY_FAILED',
      verify: check,
      detail: `Cleanup refuses to mutate unverified state: ${check.reason}`,
    };
  }

  // Verified. Lock check FIRST: a stale index.lock would make `git status`
  // itself fail, so lock detection must run before the dirty read.
  let lockFiles = [];
  try {
    const absGitDir = run('git', ['rev-parse', '--absolute-git-dir'], { cwd: wtPath, exec });
    lockFiles = fs.readdirSync(absGitDir).filter((f) => f.endsWith('.lock'));
  } catch { /* no git dir info -> fail closed on lock detection */ }
  if (lockFiles.length > 0) {
    return { ok: false, ...res, reason: 'WORKTREE_LOCKED', lockFiles, detail: `Git lock file(s) present: ${lockFiles.join(', ')}.` };
  }

  // Worktree's own state is the evidence: dirty / untracked.
  let statusLines = [];
  try { statusLines = readWorktreeStatus({ cwd: wtPath, exec }); } catch (e) {
    return { ok: false, ...res, reason: 'WORKTREE_GIT_UNREADABLE', detail: String((e && e.message) || e) };
  }
  if (statusLines.length > 0) {
    return { ok: false, ...res, reason: 'DIRTY_WORKTREE', blockers: statusLines, detail: `Worktree has ${statusLines.length} change(s); cleanup refused.` };
  }

  try {
    run('git', ['worktree', 'remove', '--force', wtPath], { cwd, exec });
  } catch (e) {
    return { ok: false, ...res, reason: 'WORKTREE_REMOVE_FAILED', detail: String((e && e.message) || e) };
  }
  try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch { /* best-effort */ }
  res.removed.push('worktree');

  if (hasBinding) {
    try { fs.rmSync(bPath, { recursive: true, force: true }); res.removed.push('binding'); }
    catch (e) { res.errors.push(`binding remove failed: ${String((e && e.message) || e)}`); }
  }

  res.ok = res.errors.length === 0;
  res.reason = res.ok ? 'CLEANED' : 'CLEANUP_PARTIAL';
  return res;
}

