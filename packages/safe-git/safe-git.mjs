#!/usr/bin/env node
// safe-git.mjs — Soc_brain: generic Safe Git & HEAD read-back primitives (Issue #5).
//
// Source: duongpdddic-droid/AI_PR_REVIEWER
// Immutable source SHA: 9c104c88dddb3e9aad0388447e9be6ff74f78a06
// Source file: scripts/github-task-intake.mjs
//
// Material adaptations from the source:
//   - `runPreflight` is the source of behavior evidence only; the task-intake
//     workflow (Issue selection, label mutation, claim marker, lock file) is
//     NOT ported — only the generic Git/HEAD checks are exposed here.
//   - `branchSafetyCheck` is split into two policy-neutral primitives:
//     `detachedHeadCheck` and `protectedBranchCheck`. The source's hard-coded
//     "any non-main branch is bad" rule is replaced by a caller-supplied
//     `protectedBranches` list, so Bố decides which branches are mutable.
//   - All read-back functions return full SHA values and never trust caller
//     assertions; the module re-reads Git state itself.
//   - `preflight` is read-only (no `git fetch`, no commits, no pushes, no
//     branch creation). The source's optional fetch in `runPreflight` is
//     dropped — staleness is reported against the local `origin/<branch>`
//     ref, and Bố decides how to refresh.
//   - `exec` is injectable so tests can run against disposable temp Git
//     repos without touching the host working tree.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function run(cmd, args, { cwd, exec = execFileSync } = {}) {
  const out = exec(cmd, args, { cwd, encoding: 'utf8' });
  return String(out).replace(/\r\n/g, '\n').trim();
}

// Variant of run() that does NOT trim the output — required for `git status
// --porcelain`, whose first line starts with a leading space (" M file") that
// would be lost under .trim() and break the slice(3) filename extraction.
// Source adaptation: scripts/github-task-intake.mjs `worktreeStatusLines`
// explicitly bypasses run() for this reason (comment at lines 332-334).
function runLines(cmd, args, { cwd, exec = execFileSync } = {}) {
  const out = exec(cmd, args, { cwd, encoding: 'utf8' });
  return String(out).replace(/\r\n/g, '\n');
}

export function normalizeRemoteUrl(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  u = u.replace(/^(?:git@|ssh:\/\/git@)github\.com[:/]/i, 'https://github.com/');
  u = u.replace(/^git:\/\/github\.com\//i, 'https://github.com/');
  u = u.replace(/^https:\/\/github\.com\//i, '');
  u = u.replace(/\/+$/, '');
  if (u.toLowerCase().endsWith('.git')) u = u.slice(0, -4);
  return u.toLowerCase();
}

export function parseRepoFromRemoteUrl(url) {
  const m = String(url || '').trim().match(/(?:github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function remoteIsCanonical(url, expectedRepo) {
  if (typeof expectedRepo !== 'string' || !expectedRepo.trim()) return false;
  const parsed = parseRepoFromRemoteUrl(url);
  if (!parsed) return false;
  return parsed.toLowerCase() === expectedRepo.trim().toLowerCase();
}

export function detachedHeadCheck({ isDetached }) {
  if (isDetached) {
    return {
      ok: false,
      reason: 'DETACHED_HEAD',
      detail: 'HEAD is detached — no current branch is set; cannot proceed safely.',
    };
  }
  return { ok: true };
}

export function protectedBranchCheck({ branchName, protectedBranches = ['main', 'master'] }) {
  if (!branchName) {
    return { ok: false, reason: 'NO_BRANCH', detail: 'Could not determine the current branch name.' };
  }
  if (protectedBranches.includes(branchName)) {
    return {
      ok: false,
      reason: 'PROTECTED_BRANCH',
      branchName,
      detail: `Branch '${branchName}' is in the protected set ${JSON.stringify(protectedBranches)}; mutation refused.`,
    };
  }
  return { ok: true, branchName };
}

export function baseSyncCheck({ localSha, remoteSha, expectedBaseSha = null }) {
  if (!remoteSha) {
    return {
      ok: false,
      reason: 'BLOCKED_STALE_BASE',
      localSha: localSha || null,
      baseSha: null,
      detail: 'Upstream ref (origin/<branch>) could not be read — the canonical branch is not present locally.',
    };
  }
  if (localSha !== remoteSha) {
    return {
      ok: false,
      reason: 'BLOCKED_STALE_BASE',
      localSha,
      baseSha: remoteSha,
      detail: `Local HEAD (${String(localSha).slice(0, 7)}) does not match upstream ${String(remoteSha).slice(0, 7)}.`,
      hint: 'Refresh the local ref (e.g. `git fetch origin`) then re-run preflight. This module never fetches automatically.',
    };
  }
  if (expectedBaseSha && expectedBaseSha !== remoteSha) {
    return {
      ok: false,
      reason: 'BLOCKED_STALE_BASE',
      localSha,
      baseSha: remoteSha,
      expectedBaseSha,
      detail: `Upstream ${String(remoteSha).slice(0, 7)} does not match expected base ${String(expectedBaseSha).slice(0, 7)}.`,
      hint: 'Verify the task base SHA pinned in the issue matches the actual upstream HEAD.',
    };
  }
  return { ok: true, localSha, baseSha: remoteSha };
}

export function isAllowedWorktreeChange(file, allowedPrefixes) {
  const list = Array.isArray(allowedPrefixes) ? allowedPrefixes : [];
  return list.some((p) => file === p || file.startsWith(p));
}

export function worktreeBlockers(statusLines, allowedPrefixes) {
  const lines = Array.isArray(statusLines) ? statusLines : [];
  return lines.filter((f) => !isAllowedWorktreeChange(f, allowedPrefixes));
}

export function gitRoot({ cwd = process.cwd(), exec = execFileSync } = {}) {
  return run('git', ['rev-parse', '--show-toplevel'], { cwd, exec });
}

export function readBranchInfo({ cwd = process.cwd(), exec = execFileSync } = {}) {
  let branchName = '';
  let isDetached = false;
  try {
    const ref = run('git', ['symbolic-ref', '--quiet', 'HEAD'], { cwd, exec });
    branchName = ref.replace(/^refs\/heads\//, '');
  } catch {
    isDetached = true;
  }
  return { branchName, isDetached };
}

export function readLocalHead({ cwd = process.cwd(), exec = execFileSync } = {}) {
  return run('git', ['rev-parse', 'HEAD'], { cwd, exec });
}

export function readUpstreamHead({ branch, remote = 'origin', cwd = process.cwd(), exec = execFileSync } = {}) {
  if (!branch) return null;
  try {
    return run('git', ['rev-parse', `${remote}/${branch}`], { cwd, exec });
  } catch {
    return null;
  }
}

export function readRemoteUrl({ remote = 'origin', cwd = process.cwd(), exec = execFileSync } = {}) {
  return run('git', ['remote', 'get-url', remote], { cwd, exec });
}

export function readWorktreeStatus({ cwd = process.cwd(), exec = execFileSync } = {}) {
  const out = runLines('git', ['status', '--porcelain'], { cwd, exec });
  return String(out)
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter(Boolean)
    .map((l) => l.slice(3));
}

export function readWorktreeConditions({ cwd = process.cwd(), exec = execFileSync } = {}) {
  const porcelain = runLines('git', ['status', '--porcelain'], { cwd, exec });
  const lines = String(porcelain)
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter(Boolean);
  const dirty = [];
  const untracked = [];
  for (const l of lines) {
    const code = l.slice(0, 2);
    const file = l.slice(3);
    if (code === '??') untracked.push(file);
    else dirty.push({ code, file });
  }
  let stashed = [];
  try {
    const out = run('git', ['stash', 'list', '--format=%gd %s'], { cwd, exec });
    stashed = String(out).split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean);
  } catch {
    stashed = [];
  }
  let locked = false;
  let lockFiles = [];
  try {
    const gitDir = run('git', ['rev-parse', '--absolute-git-dir'], { cwd, exec });
    const entries = fs.readdirSync(gitDir);
    lockFiles = entries.filter((e) => e.endsWith('.lock'));
    locked = lockFiles.length > 0;
  } catch {
    locked = false;
  }
  return { dirty, untracked, stashed, locked, lockFiles };
}

function assertCwdInRoot({ cwd, root }) {
  const cwdResolved = path.resolve(cwd);
  const rootResolved = path.resolve(root);
  if (process.platform === 'win32') {
    const c = cwdResolved.toLowerCase();
    const r = rootResolved.toLowerCase();
    if (c !== r && !c.startsWith(r + path.sep.toLowerCase())) {
      return { ok: false, reason: 'CWD_OUTSIDE_ROOT', cwd: cwdResolved, root: rootResolved };
    }
  } else if (cwdResolved !== rootResolved
             && !cwdResolved.startsWith(rootResolved + path.sep)) {
    return { ok: false, reason: 'CWD_OUTSIDE_ROOT', cwd: cwdResolved, root: rootResolved };
  }
  return { ok: true, cwd: cwdResolved, root: rootResolved };
}

export function preflight({
  canonicalRepo,
  expectedBaseSha = null,
  expectedHeadSha = null,
  allowedPrefixes = [],
  protectedBranches = ['main', 'master'],
  cwd = process.cwd(),
  exec = execFileSync,
} = {}) {
  if (typeof canonicalRepo !== 'string' || !canonicalRepo.trim()) {
    return { status: 'ERROR_CONFIG', detail: 'canonicalRepo is required.' };
  }

  let root;
  try {
    root = gitRoot({ cwd, exec });
  } catch (e) {
    return {
      status: 'ERROR_GIT',
      detail: 'Could not resolve Git root (cwd is not inside a Git repository).',
      error: String((e && e.message) || e),
    };
  }

  const cwdCheck = assertCwdInRoot({ cwd, root });
  if (!cwdCheck.ok) {
    return {
      status: 'BLOCKED_CWD_OUTSIDE_ROOT',
      ...cwdCheck,
      detail: `cwd '${cwdCheck.cwd}' is outside or below the wrong Git root '${cwdCheck.root}'.`,
    };
  }

  let remoteUrl = '';
  try {
    remoteUrl = readRemoteUrl({ cwd: root, exec });
  } catch (e) {
    return {
      status: 'BLOCKED_WRONG_REMOTE',
      remote: null,
      expected: canonicalRepo,
      detail: 'Remote origin could not be read — repository canonicality cannot be verified.',
      error: String((e && e.message) || e),
    };
  }
  if (!remoteIsCanonical(remoteUrl, canonicalRepo)) {
    return {
      status: 'BLOCKED_WRONG_REMOTE',
      remote: remoteUrl,
      expected: canonicalRepo,
      detail: `Remote origin is not the canonical repository '${canonicalRepo}'.`,
    };
  }

  const branch = readBranchInfo({ cwd: root, exec });
  const det = detachedHeadCheck({ isDetached: branch.isDetached });
  if (!det.ok) return { status: det.reason, branch, detail: det.detail };
  const prot = protectedBranchCheck({ branchName: branch.branchName, protectedBranches });
  if (!prot.ok) {
    return {
      status: prot.reason,
      branch,
      protectedBranches,
      detail: prot.detail,
    };
  }

  const conditions = readWorktreeConditions({ cwd: root, exec });
  const statusLines = [
    ...conditions.dirty.map((d) => d.file),
    ...conditions.untracked,
  ];
  const blockers = worktreeBlockers(statusLines, allowedPrefixes);

  let localHead;
  try {
    localHead = readLocalHead({ cwd: root, exec });
  } catch (e) {
    return {
      status: 'ERROR_GIT',
      detail: 'Could not read local HEAD SHA.',
      error: String((e && e.message) || e),
    };
  }
  const upstreamHead = readUpstreamHead({ branch: branch.branchName, cwd: root, exec });
  if (!upstreamHead) {
    return {
      status: 'BLOCKED_MISSING_UPSTREAM',
      branch,
      localHead,
      detail: `Upstream 'origin/${branch.branchName}' ref is missing; cannot verify base SHA.`,
    };
  }
  const sync = baseSyncCheck({ localSha: localHead, remoteSha: upstreamHead, expectedBaseSha });
  if (!sync.ok) {
    const { ok, ...rest } = sync;
    return { status: rest.reason, branch, localHead, upstreamHead, ...rest };
  }

  let expectedHead = null;
  if (expectedHeadSha) {
    expectedHead = { sha: expectedHeadSha, matches: localHead === expectedHeadSha };
    if (!expectedHead.matches) {
      return {
        status: 'BLOCKED_HEAD_MISMATCH',
        branch,
        localHead,
        upstreamHead,
        expectedHead,
        detail: `Local HEAD ${String(localHead).slice(0, 7)} does not match expected HEAD ${String(expectedHeadSha).slice(0, 7)}.`,
      };
    }
  } else {
    expectedHead = { sha: null, matches: null };
  }

  const verdict = {
    ok: blockers.length === 0 && !conditions.locked,
    blockers: blockers,
    worktreeClean: blockers.length === 0,
    noGitLock: !conditions.locked,
    baseInSync: true,
    expectedHeadMatches: expectedHead.matches,
  };

  if (!verdict.noGitLock) {
    return {
      status: 'BLOCKED_GIT_LOCK',
      branch,
      localHead,
      upstreamHead,
      expectedHead,
      worktree: conditions,
      verdict,
      detail: `Git lock file(s) present: ${conditions.lockFiles.join(', ')}; another git operation may be in progress.`,
    };
  }
  if (blockers.length) {
    return {
      status: 'BLOCKED_DIRTY_WORKTREE',
      branch,
      localHead,
      upstreamHead,
      expectedHead,
      worktree: conditions,
      blockers,
      verdict,
      detail: `Working tree has ${blockers.length} change(s) outside the allowed prefix set.`,
    };
  }

  return {
    status: 'PREFLIGHT_OK',
    canonicalRepo,
    gitRoot: root,
    remote: { name: 'origin', url: remoteUrl, repo: parseRepoFromRemoteUrl(remoteUrl) },
    branch: { name: branch.branchName, isDetached: false },
    upstream: { ref: `origin/${branch.branchName}`, sha: upstreamHead },
    localHead: { sha: localHead },
    expectedBase: { sha: expectedBaseSha, matches: expectedBaseSha ? upstreamHead === expectedBaseSha : null },
    expectedHead,
    worktree: conditions,
    verdict,
  };
}