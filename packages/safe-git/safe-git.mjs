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
  // windowsHide: the control plane runs detached/hidden — a console child
  // (git.exe) without CREATE_NO_WINDOW flashes a visible CMD window per call.
  const out = exec(cmd, args, { cwd, encoding: 'utf8', windowsHide: true });
  return String(out).replace(/\r\n/g, '\n').trim();
}

// Variant of run() that does NOT trim the output — required for `git status
// --porcelain`, whose first line starts with a leading space (" M file") that
// would be lost under .trim() and break the slice(3) filename extraction.
// Source adaptation: scripts/github-task-intake.mjs `worktreeStatusLines`
// explicitly bypasses run() for this reason (comment at lines 332-334).
function runLines(cmd, args, { cwd, exec = execFileSync } = {}) {
  const out = exec(cmd, args, { cwd, encoding: 'utf8', windowsHide: true });
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

// Verify a task branch is consistent with its pinned base.
//
// Inputs (all four may be supplied; the function never reads Git itself):
//   - `localSha`           : current local task-branch tip (or any HEAD the caller wants to verify).
//   - `taskUpstreamSha`    : SHA of `origin/<task-branch>` (the remote tracking ref of the task branch).
//   - `baseUpstreamSha`    : SHA of `origin/<baseBranch>` (the remote tracking ref of the base branch).
//   - `expectedBaseSha`    : (optional) SHA the caller pinned as the base for this task.
//
// Checks performed, in order, with fail-closed semantics:
//   1. If `taskUpstreamSha` is missing, the task branch has no remote tracking
//      ref — `BLOCKED_MISSING_TASK_UPSTREAM`.
//   2. If `localSha !== taskUpstreamSha`, the local task branch has diverged
//      from its remote tip — `BLOCKED_STALE_TASK_UPSTREAM`.
//   3. If `baseUpstreamSha` is missing, the base branch's remote ref is not
//      available locally — `BLOCKED_MISSING_BASE_UPSTREAM`.
//   4. If `expectedBaseSha` is provided and !== `baseUpstreamSha`, the pinned
//      base SHA does not match the actual base branch upstream —
//      `BLOCKED_STALE_BASE`.
//
// `localSha` and `taskUpstreamSha` are intentionally kept separate from
// `baseUpstreamSha` so a task branch that has commits on top of `base` is
// never compared against the base SHA (the original bug it inherited from
// the source).
export function baseSyncCheck({
  localSha,
  taskUpstreamSha,
  baseUpstreamSha,
  expectedBaseSha = null,
}) {
  if (!taskUpstreamSha) {
    return {
      ok: false,
      reason: 'BLOCKED_MISSING_TASK_UPSTREAM',
      localSha: localSha || null,
      taskUpstreamSha: null,
      detail: "Upstream ref for the task branch ('origin/<task-branch>') could not be read.",
    };
  }
  if (localSha !== taskUpstreamSha) {
    return {
      ok: false,
      reason: 'BLOCKED_STALE_TASK_UPSTREAM',
      localSha,
      taskUpstreamSha,
      detail: `Local task-branch HEAD (${String(localSha).slice(0, 7)}) does not match its upstream tip (${String(taskUpstreamSha).slice(0, 7)}).`,
      hint: 'Push the local commits, or reset the local branch to match the remote tip. This module never pushes or fetches automatically.',
    };
  }
  if (!baseUpstreamSha) {
    return {
      ok: false,
      reason: 'BLOCKED_MISSING_BASE_UPSTREAM',
      localSha,
      taskUpstreamSha,
      baseUpstreamSha: null,
      detail: "Base branch upstream ref ('origin/<baseBranch>') could not be read; cannot verify the pinned base SHA.",
    };
  }
  if (expectedBaseSha && expectedBaseSha !== baseUpstreamSha) {
    return {
      ok: false,
      reason: 'BLOCKED_STALE_BASE',
      localSha,
      taskUpstreamSha,
      baseUpstreamSha,
      expectedBaseSha,
      detail: `Base branch upstream ${String(baseUpstreamSha).slice(0, 7)} does not match pinned base SHA ${String(expectedBaseSha).slice(0, 7)}.`,
      hint: 'Verify the task base SHA pinned in the issue matches the actual base-branch upstream HEAD. This module never fetches automatically.',
    };
  }
  return { ok: true, localSha, taskUpstreamSha, baseUpstreamSha, expectedBaseSha: expectedBaseSha || null };
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

// Read the real tracking upstream for a local branch via `@{upstream}`.
// Returns `{ remote, remoteBranch, sha }` on success, or `null` if the branch
// has no upstream tracking configured (detached or untracked branch).
//
// This is the truthful upstream read: it does NOT assume the local branch
// tracks `origin/<branch>`. Callers that require the upstream to be the
// `origin` remote should compare `remote` themselves.
export function readBranchUpstream({ branch, cwd = process.cwd(), exec = execFileSync } = {}) {
  if (!branch) return null;
  let upstreamRef;
  try {
    upstreamRef = run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`], { cwd, exec });
  } catch {
    return null;
  }
  if (!upstreamRef) return null;
  const m = String(upstreamRef).trim().match(/^([^/]+)\/(.+)$/);
  if (!m) return null;
  const remote = m[1];
  const remoteBranch = m[2];
  let sha;
  try {
    sha = run('git', ['rev-parse', upstreamRef], { cwd, exec });
  } catch {
    return null;
  }
  return { remote, remoteBranch, ref: upstreamRef, sha };
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
  // Parse `git stash list --format=%gd %s` into structured entries so callers
  // (and preflight) can fail-closed on stashes without re-parsing strings.
  // Each entry: { ref: 'stash@{N}', subject: '<msg>' }.
  let stashed = [];
  try {
    const out = run('git', ['stash', 'list', '--format=%gd %s'], { cwd, exec });
    stashed = String(out)
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter(Boolean)
      .map((l) => {
        const sp = l.indexOf(' ');
        if (sp < 0) return { ref: l.trim(), subject: '' };
        return { ref: l.slice(0, sp).trim(), subject: l.slice(sp + 1).trim() };
      });
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
  // New knobs (issue PR #6 review — policy-neutral; default behaviour is
  // strictly stricter than the source's `runPreflight` so unconfigured callers
  // benefit from the additional checks automatically).
  expectedGitRoot = null,         // canonical absolute path the caller pinned as THIS workspace
  baseBranch = 'main',            // which remote tracking ref to read as the task's base
  expectedRemote = 'origin',      // which remote the local task branch must track
  requireClean = false,           // when true, stash entries also fail preflight
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

  // Caller-pinned canonical Git root: same remote URL, wrong workspace is a
  // real-world attack vector (e.g. an attacker who can clone the repo to a
  // sibling worktree with the same `origin` but a different toplevel).
  if (typeof expectedGitRoot === 'string' && expectedGitRoot.trim()) {
    if (path.resolve(root).toLowerCase() !== path.resolve(expectedGitRoot).toLowerCase()) {
      return {
        status: 'BLOCKED_WRONG_GIT_ROOT',
        actualGitRoot: path.resolve(root),
        expectedGitRoot: path.resolve(expectedGitRoot),
        detail: `Workspace Git root '${path.resolve(root)}' does not match the canonical/expected Git root '${path.resolve(expectedGitRoot)}'.`,
      };
    }
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

  // Real tracking upstream via `@{upstream}`. This catches the case where the
  // local branch is configured to track a remote OTHER than `origin` (or
  // doesn't track anything at all). Source only ever read `origin/<branch>`
  // blindly, which is a TOCTOU-shaped gap.
  const tracking = readBranchUpstream({ branch: branch.branchName, cwd: root, exec });
  if (!tracking) {
    return {
      status: 'BLOCKED_NOT_TRACKING',
      branch,
      detail: `Branch '${branch.branchName}' has no upstream tracking configured (no '@{upstream}').`,
      hint: `Set upstream with 'git branch --set-upstream-to=${expectedRemote}/${branch.branchName} ${branch.branchName}' or push with '--set-upstream'.`,
    };
  }
  if (tracking.remote !== expectedRemote) {
    return {
      status: 'BLOCKED_WRONG_UPSTREAM',
      branch,
      tracking,
      expectedRemote,
      detail: `Branch '${branch.branchName}' tracks '${tracking.ref}', expected remote '${expectedRemote}'.`,
    };
  }
  if (tracking.remoteBranch !== branch.branchName) {
    return {
      status: 'BLOCKED_WRONG_UPSTREAM',
      branch,
      tracking,
      detail: `Branch '${branch.branchName}' tracks '${tracking.ref}', which points at a different branch.`,
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

  // Base branch upstream SHA is read separately from the task branch's tip.
  // This is the structural fix for the source bug: on a task branch with
  // commits, `origin/<task-branch>` is the task tip (not the base), and the
  // pinned `expectedBaseSha` must be compared against `origin/<baseBranch>`.
  const baseUpstreamSha = readUpstreamHead({ branch: baseBranch, cwd: root, exec });
  if (expectedBaseSha && !baseUpstreamSha) {
    return {
      status: 'BLOCKED_MISSING_BASE_UPSTREAM',
      branch,
      localHead,
      taskUpstreamSha: tracking.sha,
      baseBranch,
      detail: `Base branch '${baseBranch}' has no remote tracking ref locally; cannot verify the pinned base SHA.`,
    };
  }
  const sync = baseSyncCheck({
    localSha: localHead,
    taskUpstreamSha: tracking.sha,
    baseUpstreamSha,
    expectedBaseSha,
  });
  if (!sync.ok) {
    const { ok, ...rest } = sync;
    return {
      status: rest.reason,
      branch,
      localHead,
      upstream: tracking,
      baseBranch,
      ...rest,
    };
  }

  let expectedHead = null;
  if (expectedHeadSha) {
    expectedHead = { sha: expectedHeadSha, matches: localHead === expectedHeadSha };
    if (!expectedHead.matches) {
      return {
        status: 'BLOCKED_HEAD_MISMATCH',
        branch,
        localHead,
        upstream: tracking,
        baseBranch,
        expectedHead,
        detail: `Local HEAD ${String(localHead).slice(0, 7)} does not match expected HEAD ${String(expectedHeadSha).slice(0, 7)}.`,
      };
    }
  } else {
    expectedHead = { sha: null, matches: null };
  }

  // Stash fail-closed: when the caller demands a clean state, the presence of
  // ANY stash entry blocks preflight. The module never pops or drops stashes
  // (read-only) — the caller decides what to do with them.
  if (requireClean && conditions.stashed.length > 0) {
    return {
      status: 'BLOCKED_STASHED_WORKTREE',
      branch,
      localHead,
      upstream: tracking,
      baseBranch,
      expectedHead,
      worktree: conditions,
      requireClean: true,
      detail: `Working tree has ${conditions.stashed.length} stash entr(y/ies); requireClean=true forbids running with stashed work.`,
    };
  }

  const verdict = {
    ok: blockers.length === 0 && !conditions.locked && (!requireClean || conditions.stashed.length === 0),
    blockers: blockers,
    worktreeClean: blockers.length === 0,
    noGitLock: !conditions.locked,
    noStash: conditions.stashed.length === 0,
    baseInSync: true,
    trackingUpstream: tracking.ref,
    expectedHeadMatches: expectedHead.matches,
  };

  if (!verdict.noGitLock) {
    return {
      status: 'BLOCKED_GIT_LOCK',
      branch,
      localHead,
      upstream: tracking,
      baseBranch,
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
      upstream: tracking,
      baseBranch,
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
    remote: { name: expectedRemote, url: remoteUrl, repo: parseRepoFromRemoteUrl(remoteUrl) },
    branch: { name: branch.branchName, isDetached: false },
    upstream: { ref: tracking.ref, sha: tracking.sha },
    baseBranch,
    baseUpstream: { ref: `${expectedRemote}/${baseBranch}`, sha: baseUpstreamSha || null },
    localHead: { sha: localHead },
    expectedBase: {
      sha: expectedBaseSha,
      matches: expectedBaseSha ? baseUpstreamSha === expectedBaseSha : null,
    },
    expectedHead,
    requireClean,
    worktree: conditions,
    verdict,
  };
}

// ---- Issue #126: tracked-secret preflight guard -------------------------------
// Rejects tracked/commit content that carries a NON-EMPTY SOC_SESSION_TOKEN
// value. Placeholder/env-reference shapes never false-positive:
//   "SOC_SESSION_TOKEN": ""                -> pass (empty value)
//   "SOC_SESSION_TOKEN": "${SOC_SESSION_TOKEN}" -> pass (interpolation)
//   const t = process.env.SOC_SESSION_TOKEN;    -> pass (code reference: no
//                                                  separator+value after the key)
//   "SOC_SESSION_TOKEN": "<live 48-hex>"   -> REJECTED (value never logged)
export const SECRET_KEY_NAME = 'SOC_SESSION_TOKEN';
const SECRET_LINE_RE = new RegExp('SOC_SESSION_TOKEN["\']?\\s*[:=]\\s*["\']?([^"\'\\s,]*)', 'g');
const SECRET_PLACEHOLDER_RE = /^(?:\$\{[^}]*\}|\{\{[^}]*\}\}|%[^%]*%|<[^>]*>?|~|\$[^"'\s]*|null|undefined|None|nil|true|false)$/;

export function scanSessionTokenSecrets({ content }) {
  const hits = [];
  if (typeof content !== 'string' || !content) return { ok: true, hits };
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    SECRET_LINE_RE.lastIndex = 0;
    let m;
    while ((m = SECRET_LINE_RE.exec(lines[i])) !== null) {
      const value = m[1] || '';
      if (!value || SECRET_PLACEHOLDER_RE.test(value)) continue;
      hits.push({
        line: i + 1,
        key: SECRET_KEY_NAME,
        valueLength: value.length,
        // No value material leaves this function: the snippet has every
        // long token-like run redacted before returning (Issue #126).
        snippet: lines[i].replace(/[A-Za-z0-9._-]{8,}/g, '<REDACTED>').slice(0, 160),
        reason: 'NON_EMPTY_SESSION_TOKEN_VALUE',
      });
    }
  }
  return { ok: hits.length === 0, hits };
}

// paths given -> scan exactly those worktree files (commit preflight on the
// exact bytes that would enter the commit). paths omitted -> scan ALL tracked
// files (repo-level preflight). Never logs secret values.
export function trackedSecretGuard({ paths = null, cwd = process.cwd(), exec = execFileSync } = {}) {
  let files = paths;
  if (!files) {
    let out;
    try {
      out = exec('git', ['ls-files'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return { ok: false, reason: 'SECRET_SCAN_GIT_FAILED', detail: String((e && e.message) || e) };
    }
    files = String(out == null ? '' : out).split(/\r?\n/).filter(Boolean);
  }
  const hits = [];
  for (const f of files) {
    let content;
    try { content = fs.readFileSync(path.resolve(cwd, f), 'utf8'); } catch { continue; }
    const r = scanSessionTokenSecrets({ content });
    if (!r.ok) for (const h of r.hits) hits.push({ file: f, ...h });
  }
  return { ok: hits.length === 0, scanned: files.length, hits };
}