#!/usr/bin/env node
// temp-hygiene.mjs - Soc_brain runtime and temp-directory hygiene primitives.
// Issue #7. All messages and identifiers are ASCII to keep the file
// deterministic across locales and editor encodings.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MANIFEST_NAME = '.session-manifest.json';
const MARKER_FILE = '.soc-brain-session-marker';
const MARKER_BODY = 'soc-brain session owner marker';
// sessionId remains lowercase hex (internal random id).
// projectId / taskId accept a slug: starts with [a-z0-9], then [a-z0-9_-],
// 1-64 chars, no path separators, no traversal, no uppercase, no dot.
const SESSION_ID_PATTERN = /^[0-9a-f]{1,64}$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const hex = (n) => randomBytes(n).toString('hex');

// Production default: <homedir>/.soc-brain. Tests inject disposable temp roots.
export const DEFAULT_TEMP_ROOT = () => path.join(os.homedir(), '.soc-brain');

// ID validators. projectId, taskId use the slug rule (soc-brain, task_1, ...).
// sessionId is internal random hex; not user-supplied.
export const isSafeProjectId = (id) => typeof id === 'string' && SLUG_PATTERN.test(id);
export const isSafeTaskId = (id) => typeof id === 'string' && SLUG_PATTERN.test(id);
export const isSafeSessionId = (id) => typeof id === 'string' && SESSION_ID_PATTERN.test(id);

// Path containment helpers. Windows paths are case-insensitive: normalize
// case before comparing. realpathSync would be ideal but fails for
// non-existing paths, so we fall back to a lexical compare.
const ci = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
// Normalize both sides to forward slashes on Windows so case-insensitive
// containment does not depend on which separator character path.resolve
// produced. path.resolve returns backslashes on Windows; the test must
// use a single canonical separator to be safe.
const normSep = (s) => (process.platform === 'win32' ? s.split(path.sep).join('/') : s);
const ciStartsWith = (parent, child) => {
  const p = normSep(ci(parent));
  const c = normSep(ci(child));
  if (p === c) return true;
  return c.startsWith(p + '/');
};
export const isInside = (root, p) => {
  if (typeof root !== 'string' || typeof p !== 'string') return false;
  const r = ci(path.resolve(root));
  const x = ci(path.resolve(p));
  if (r === x) return false;
  return ciStartsWith(r, x);
};
const ciEqual = (a, b) => ci(path.resolve(a)) === ci(path.resolve(b));

function realPathOrNull(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

export function isSymlink(p) {
  try {
    const lst = fs.lstatSync(p);
    return lst.isSymbolicLink();
  } catch { return false; }
}

function isReparsePoint(p) {
  if (isSymlink(p)) return true;
  const lst = (() => { try { return fs.lstatSync(p); } catch { return null; } })();
  if (lst && typeof lst.isDirectory === 'function' && lst.isDirectory()) {
    const rp = realPathOrNull(p);
    if (rp && !ciEqual(rp, p)) return true;
  }
  return false;
}

function isCanonicalInside(root, p) {
  const real = realPathOrNull(p);
  if (!real) return false;
  return isInside(root, real);
}

// Resolve the Git worktree that contains this package file.
function currentWorktreeRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let cur = here;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: here, encoding: 'utf8' });
  if (r.status === 0 && r.stdout) return r.stdout.trim();
  return null;
}

export function assertOutsideWorktree(tempRoot) {
  if (typeof tempRoot !== 'string' || !tempRoot) {
    throw new Error('temp-hygiene: tempRoot must be a non-empty path');
  }
  const worktree = currentWorktreeRoot();
  if (!worktree) throw new Error('temp-hygiene: cannot determine worktree (fail-closed)');
  const twLex = path.resolve(worktree);
  const twReal = realPathOrNull(worktree) || twLex;
  const inputLex = path.resolve(tempRoot);
  const inputReal = realPathOrNull(tempRoot) || inputLex;
  if (ciEqual(inputLex, twLex) || ciStartsWith(twLex, inputLex)) {
    throw new Error('temp-hygiene: tempRoot is inside the Git worktree');
  }
  if (ciEqual(inputReal, twReal) || ciStartsWith(twReal, inputReal)) {
    throw new Error('temp-hygiene: tempRoot resolves inside the Git worktree');
  }
}

// redactHome: replace the user home and username with placeholders, and
// also replace the production default with a literal token so reports do
// not leak absolute paths.
export function redactHome(p) {
  if (typeof p !== 'string') return '';
  let out = p;
  const def = DEFAULT_TEMP_ROOT();
  if (def && out.includes(def)) out = out.split(def).join('<SOC_BRAIN_RUNTIME>');
  const home = os.homedir();
  if (home && out.includes(home)) out = out.split(home).join('<HOME>');
  const user = os.userInfo().username;
  if (user && out.includes(user)) out = out.split(user).join('<USER>');
  return out;
}

// Ownership marker writer and reader. The marker is keyed by
// (projectId, taskId) so a different task or different project cannot
// impersonate an existing session.
export function hasOwnershipMarker(homeDir, expected) {
  try {
    const buf = fs.readFileSync(path.join(homeDir, MARKER_FILE), 'utf8');
    const want = `${MARKER_BODY}:${expected.projectId}:${expected.taskId}`;
    return buf.trim() === want;
  } catch { return false; }
}

function ensureOwnershipMarker(homeDir, projectId, taskId) {
  const marker = path.join(homeDir, MARKER_FILE);
  if (isSymlink(marker) || isReparsePoint(marker)) {
    throw new Error('temp-hygiene: ownership marker path is a reparse point');
  }
  fs.writeFileSync(marker, `${MARKER_BODY}:${projectId}:${taskId}\n`);
}

// process helpers
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function psCommandFor(pid) {
  if (process.platform === 'win32') {
    return ['powershell.exe', '-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -First 1 -ExpandProperty CommandLine) -replace [char]0,' '`];
  }
  return ['ps', '-p', String(pid), '-o', 'pid=,comm=,args='];
}

function readCmdline(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); }
  catch { /* not linux */ }
  const [cmd, ...args] = psCommandFor(pid);
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) return '';
  return (r.stdout || '').replace(/\s+/g, ' ').trim();
}

function verifyProcessIdentity(pid, sessionId) {
  const cmd = readCmdline(pid);
  if (!cmd) return false;
  return cmd.includes(sessionId);
}

function stopTrackedProcesses(procRecs, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 800;
  const sessionId = opts && opts.sessionId;
  const stopped = [], unverified = [], alive = [];
  const targets = procRecs.map((r) => r.pid).filter(Number.isInteger);
  for (const pid of targets) {
    if (!isAlive(pid)) continue;
    if (!verifyProcessIdentity(pid, sessionId)) {
      unverified.push(pid);
      continue;
    }
    try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  }
  if (targets.length > 0) sleep(timeoutMs);
  for (const pid of targets) {
    if (!isAlive(pid)) {
      if (stopped.indexOf(pid) === -1) stopped.push(pid);
      continue;
    }
    if (!verifyProcessIdentity(pid, sessionId)) {
      unverified.push(pid);
      continue;
    }
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    if (isAlive(pid)) alive.push(pid); else stopped.push(pid);
  }
  return { stopped, unverified, alive };
}

// workspace baseline snapshot
export function snapshotWorkspace(projectDir) {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: projectDir, encoding: 'utf8' });
  if (r.status !== 0) return [];
  return (r.stdout || '').split(/\r?\n/).filter(Boolean);
}

function workspaceChange(projectDir, before) {
  const now = snapshotWorkspace(projectDir);
  if (!Array.isArray(before) || !Array.isArray(now)) return null;
  const a = new Set(before), b = new Set(now);
  const added = [...b].filter((x) => !a.has(x));
  const removed = [...a].filter((x) => !b.has(x));
  return [...added, ...removed];
}

// Build the on-disk namespace path for a (projectId, taskId) pair.
function namespacePath(root, projectId, taskId) {
  return path.join(path.resolve(root), projectId, taskId);
}

// isSameOrInside: true when p equals homeDir or is a descendant.
function isSameOrInside(homeDir, p) {
  const r = normSep(ci(path.resolve(homeDir)));
  const x = normSep(ci(path.resolve(p)));
  return x === r || x.startsWith(r + '/');
}

// Canonical pre-write safety: walk every existing segment under homeDir.
function safeCreatePath(homeDir, absTarget) {
  if (!isSameOrInside(homeDir, absTarget)) {
    throw new Error(`temp-hygiene: write target escapes session dir: ${redactHome(absTarget)}`);
  }
  if (ciEqual(absTarget, homeDir)) {
    return absTarget;
  }
  const rel = path.relative(homeDir, absTarget);
  const segs = rel.split(path.sep);
  let cur = homeDir;
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]);
    if (i === segs.length - 1 && !fs.existsSync(cur)) break;
    if (!fs.existsSync(cur)) {
      throw new Error(`temp-hygiene: ancestor missing under session: ${redactHome(cur)}`);
    }
    if (isReparsePoint(cur)) {
      throw new Error(`temp-hygiene: reparse point in path: ${redactHome(cur)}`);
    }
    const real = realPathOrNull(cur);
    if (!real || !isSameOrInside(homeDir, real)) {
      throw new Error(`temp-hygiene: ancestor escapes session: ${redactHome(cur)}`);
    }
  }
  return absTarget;
}

// Expected identity bundle used by readManifestOrFail and recheckOwnership.
function buildExpectedIdentity({ tempRoot, projectDir, homeDir, projectId, taskId }) {
  return {
    tempRoot: path.resolve(tempRoot),
    projectDir: path.resolve(projectDir),
    homeDir: path.resolve(homeDir),
    projectId: String(projectId),
    taskId: String(taskId),
  };
}

// assertManifestIdentity: every identity/path field in the on-disk
// manifest must match the expected canonical bundle. Mutated/swapped
// manifests cannot pass.
function assertManifestIdentity(disk, expected) {
  if (!disk || typeof disk !== 'object') return { ok: false, reason: 'manifest not an object' };
  const fields = ['projectId', 'taskId', 'sessionId', 'homeDir', 'projectDir', 'tempRoot'];
  for (const f of fields) {
    if (typeof disk[f] !== 'string') return { ok: false, reason: `manifest field missing or not string: ${f}` };
  }
  if (disk.version !== 2) return { ok: false, reason: `manifest version unsupported: ${disk.version}` };
  if (disk.projectId !== expected.projectId) return { ok: false, reason: `manifest projectId mismatch: ${disk.projectId}` };
  if (disk.taskId !== expected.taskId) return { ok: false, reason: `manifest taskId mismatch: ${disk.taskId}` };
  if (!ciEqual(disk.homeDir, expected.homeDir)) return { ok: false, reason: `manifest homeDir mismatch: ${disk.homeDir}` };
  if (!ciEqual(disk.projectDir, expected.projectDir)) return { ok: false, reason: `manifest projectDir mismatch: ${disk.projectDir}` };
  if (!ciEqual(disk.tempRoot, expected.tempRoot)) return { ok: false, reason: `manifest tempRoot mismatch: ${disk.tempRoot}` };
  if (!isSafeSessionId(disk.sessionId)) return { ok: false, reason: 'manifest sessionId invalid' };
  if (!Array.isArray(disk.processes) || disk.processes.some((r) => !r || !Number.isInteger(r.pid))) {
    return { ok: false, reason: 'manifest processes invalid' };
  }
  if (!Array.isArray(disk.files)) return { ok: false, reason: 'manifest files not an array' };
  if (!Array.isArray(disk.dirs)) return { ok: false, reason: 'manifest dirs not an array' };
  return { ok: true, manifest: disk };
}

// readManifestOrFail: read the manifest on disk and verify it against
// the expected canonical identity. The returned manifest is a *snapshot*;
// callers must re-read before any destructive step.
function readManifestOrFail(homeDir, expected) {
  const fp = path.join(homeDir, MANIFEST_NAME);
  if (!fs.existsSync(fp)) return { ok: false, reason: 'manifest missing' };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch (e) { return { ok: false, reason: `manifest JSON unparseable: ${e.message}` }; }
  return assertManifestIdentity(parsed, expected);
}

export function createSessionManager(opts) {
  opts = opts || {};
  const tempRoot = opts.tempRoot;
  const projectRoot = opts.projectRoot;
  const projectId = opts.projectId;
  const taskId = opts.taskId;
  const purpose = opts.purpose || 'unspecified';
  if (typeof tempRoot !== 'string' || !tempRoot) throw new Error('temp-hygiene: tempRoot required');
  if (!isSafeProjectId(projectId)) throw new Error('temp-hygiene: projectId must match safe slug (1-64 chars: [a-z0-9_-], no separators)');
  if (!isSafeTaskId(taskId)) throw new Error('temp-hygiene: taskId must match safe slug (1-64 chars: [a-z0-9_-], no separators)');
  assertOutsideWorktree(tempRoot);
  const root = path.resolve(tempRoot);
  const projectDir = path.join(root, projectId);
  if (fs.existsSync(projectDir) && (isReparsePoint(projectDir) || !isCanonicalInside(root, projectDir))) {
    throw new Error('temp-hygiene: project namespace collides with reparse point');
  }
  fs.mkdirSync(projectDir, { recursive: true });
  const homeDir = namespacePath(root, projectId, taskId);
  if (fs.existsSync(homeDir)) throw new Error(`temp-hygiene: task dir already exists: ${redactHome(homeDir)}`);
  if (isReparsePoint(path.dirname(homeDir))) {
    throw new Error('temp-hygiene: project dir is a reparse point');
  }
  fs.mkdirSync(homeDir, { recursive: false });
  const sessionId = hex(16);
  const expected = buildExpectedIdentity({ tempRoot: root, projectDir, homeDir, projectId, taskId });
  const manifest = {
    version: 2,
    projectId, taskId, sessionId, purpose,
    createdAt: new Date().toISOString(),
    homeDir, projectDir, tempRoot: root,
    dirs: [homeDir], files: [], processes: [],
  };
  ensureOwnershipMarker(homeDir, projectId, taskId);
  const save = () => fs.writeFileSync(path.join(homeDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  save();

  const assertInside = (p) => {
    if (!isInside(homeDir, p)) throw new Error(`temp-hygiene: path escapes session: ${redactHome(p)}`);
  };

  const mgr = {
    sessionId, projectId, taskId, tempRoot: root, homeDir, projectDir, manifest, expected,
    createDir(rel) {
      const d = path.join(homeDir, rel);
      assertInside(d);
      safeCreatePath(homeDir, d);
      fs.mkdirSync(d, { recursive: true });
      ensureOwnershipMarker(d, projectId, taskId);
      if (!manifest.dirs.includes(d)) manifest.dirs.push(d);
      save();
      return d;
    },
    createFile(rel, content) {
      const p = path.join(homeDir, rel);
      assertInside(p);
      safeCreatePath(homeDir, path.dirname(p));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      ensureOwnershipMarker(path.dirname(p), projectId, taskId);
      fs.writeFileSync(p, content);
      if (!manifest.files.includes(p)) manifest.files.push(p);
      save();
      return p;
    },
    addProcess(pid) {
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('temp-hygiene: pid must be positive integer');
      if (!verifyProcessIdentity(pid, sessionId)) {
        throw new Error('temp-hygiene: pid does not match session identity');
      }
      if (!manifest.processes.find((r) => r.pid === pid)) {
        manifest.processes.push({ pid, addedAt: new Date().toISOString() });
        save();
      }
      return manifest.processes.length;
    },
    spawnProcess(cmd, args) {
      const child = spawn(cmd, args || [], { stdio: 'ignore', env: { ...process.env, TH: sessionId } });
      manifest.processes.push({ pid: child.pid, addedAt: new Date().toISOString() });
      save();
      return child;
    },
    cleanup(opts2) {
      return cleanupSession({ mgr: this, projectRoot, ...(opts2 || {}) });
    },
  };
  return mgr;
}

// recheckOwnership: re-verify the on-disk marker AND canonical containment
// against the expected identity bundle. The marker is keyed by
// (projectId, taskId) and the realpath of homeDir must canonicalise into
// the expected project namespace.
function recheckOwnership(homeDir, expected) {
  if (!fs.existsSync(homeDir)) return { ok: false, reason: 'home gone' };
  if (isReparsePoint(homeDir)) return { ok: false, reason: 'home is reparse point' };
  const real = realPathOrNull(homeDir);
  if (!real) return { ok: false, reason: 'home realpath unavailable' };
  if (!ciEqual(real, expected.homeDir)) return { ok: false, reason: 'home realpath does not match expected' };
  if (!isInside(expected.projectDir, real)) return { ok: false, reason: 'home escapes project dir' };
  if (!hasOwnershipMarker(homeDir, { projectId: expected.projectId, taskId: expected.taskId })) {
    return { ok: false, reason: 'ownership marker missing or mismatched' };
  }
  return { ok: true };
}

// Read the on-disk state of a session under (projectId, taskId, tempRoot)
// and return a snapshot. This is the only way cleanup and recovery obtain
// the manifest: never trust the in-memory manager.
function readSessionSnapshot({ projectId, taskId, tempRoot }) {
  const root = path.resolve(tempRoot);
  const projectDir = path.join(root, projectId);
  const homeDir = path.join(projectDir, taskId);
  const expected = buildExpectedIdentity({ tempRoot: root, projectDir, homeDir, projectId, taskId });
  if (!fs.existsSync(homeDir)) return { ok: true, state: 'absent', expected, snapshot: null };
  const oc = recheckOwnership(homeDir, expected);
  if (!oc.ok) return { ok: false, reason: `ownership check failed: ${oc.reason}`, expected };
  const mc = readManifestOrFail(homeDir, expected);
  if (!mc.ok) return { ok: false, reason: mc.reason, expected };
  return { ok: true, state: 'present', expected, snapshot: mc.manifest };
}

// Sort targets deepest-first so children are removed before their parents.
function sortDeepestFirst(arr) {
  return arr.slice().sort((a, b) => b.length - a.length);
}

// classifyProcessByIdentity: re-classify a tracked pid against the
// expected session identity. Returns 'gone', 'live', or 'unverified'.
function classifyProcessByIdentity(rec, sessionId) {
  if (!Number.isInteger(rec.pid)) return 'gone';
  if (!isAlive(rec.pid)) return 'gone';
  if (!verifyProcessIdentity(rec.pid, sessionId)) return 'unverified';
  return 'live';
}

// Real read-back of post-operation state.
function readBackState(homeDir, projectDir, snapshot) {
  const homeGone = !fs.existsSync(homeDir);
  const processesGone = (snapshot.processes || []).every(
    (r) => classifyProcessByIdentity(r, snapshot.sessionId) === 'gone',
  );
  const survivors = (snapshot.processes || []).filter(
    (r) => classifyProcessByIdentity(r, snapshot.sessionId) !== 'gone',
  ).map((r) => r.pid);
  const remaining = [];
  if (fs.existsSync(projectDir)) {
    const stack = [projectDir];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const child = path.join(cur, e.name);
        if (ciEqual(child, homeDir)) continue;
        remaining.push(redactHome(child));
        if (e.isDirectory()) stack.push(child);
      }
    }
  }
  return { homeGone, processesGone, survivors, remaining };
}

function finalizeCleanup(res, homeDir, projectDir, projectRoot, workspaceBefore, snapshot) {
  const hasBaseline = Array.isArray(workspaceBefore);
  const ws = projectRoot ? workspaceChange(projectRoot, workspaceBefore) : null;
  // No projectRoot: workspace check is vacuous. Without a baseline we cannot
  // claim the workspace is unchanged. With a baseline, treat absence of a
  // status response (non-git dir) as no detectable diffs.
  let workspaceUnchanged;
  if (!projectRoot) workspaceUnchanged = true; // no workspace check requested
  else if (!hasBaseline) workspaceUnchanged = false; // cannot verify
  else if (ws === null) workspaceUnchanged = true; // non-git dir: no diffs
  else workspaceUnchanged = ws.length === 0;
  const readBack = readBackState(homeDir, projectDir, snapshot);
  readBack.workspaceUnchanged = workspaceUnchanged;
  readBack.workspaceBaselinePresent = hasBaseline;
  res.readBack = readBack;
  res.removed = res.removed.map(redactHome);
  res.leftover = res.leftover.map(redactHome);
  const ok = res.leftover.length === 0 && res.errors.length === 0 && workspaceUnchanged;
  res.verdict = ok ? 'CLEAN' : 'POC_CLEANUP_FAILED';
  return res;
}

export function cleanupSession(opts) {
  const mgr = opts.mgr;
  const projectRoot = opts.projectRoot || null;
  const workspaceBefore = opts.workspaceBefore;
  const timeoutMs = opts.timeoutMs || 800;
  const res = { verdict: "POC_CLEANUP_FAILED", removed: [], leftover: [], errors: [], readBack: null };
  if (!mgr || !mgr.homeDir || !mgr.expected) {
    res.errors.push("cleanupSession: missing manager");
    return res;
  }
  const { homeDir, expected } = mgr;
  const projectDir = path.resolve(path.dirname(homeDir));
  // Re-read disk state. Snapshot is the only source of truth.
  const snap = readSessionSnapshot(expected);
  if (!snap.ok) {
    res.leftover.push(redactHome(homeDir));
    res.errors.push(snap.reason);
    return finalizeCleanup(res, homeDir, projectDir, projectRoot, workspaceBefore, { processes: [], sessionId: mgr.sessionId });
  }
  if (snap.state === "absent") {
    res.verdict = "CLEAN";
    res.readBack = readBackState(homeDir, projectDir, { processes: [], sessionId: mgr.sessionId });
    const hasB = Array.isArray(workspaceBefore);
    res.readBack.workspaceUnchanged = hasB ? workspaceChange(projectRoot, workspaceBefore)?.length === 0 : hasB;
    res.readBack.workspaceBaselinePresent = hasB;
    return res;
  }
  const snapshot = snap.snapshot;
  // Recheck ownership immediately before process stop.
  const oc1 = recheckOwnership(homeDir, expected);
  if (!oc1.ok) {
    res.leftover.push(redactHome(homeDir));
    res.errors.push(`ownership check failed: ${oc1.reason}`);
    return finalizeCleanup(res, homeDir, projectDir, projectRoot, workspaceBefore, snapshot);
  }
  // Re-classify every tracked process from the snapshot.
  const live = [];
  const unverified = [];
  for (const rec of snapshot.processes) {
    const c = classifyProcessByIdentity(rec, snapshot.sessionId);
    if (c === "live") live.push(rec.pid);
    else if (c === "unverified") unverified.push(rec.pid);
  }
  for (const pid of live) res.errors.push(`live owner blocks cleanup: pid=${pid}`);
  for (const pid of unverified) res.errors.push(`unverified owner blocks cleanup: pid=${pid} (pid reuse risk)`);
  if (live.length > 0 || unverified.length > 0) {
    res.leftover.push(redactHome(homeDir));
    return finalizeCleanup(res, homeDir, projectDir, projectRoot, workspaceBefore, snapshot);
  }
  // Build target list from the snapshot. homeDir is excluded here and
  // removed exactly once, last, after all children.
  const rawTargets = [...(snapshot.files || []), ...(snapshot.dirs || [])]
    .filter((t) => !ciEqual(t, homeDir));
  const safeTargets = [];
  for (const t of rawTargets) {
    if (!t || typeof t !== "string") continue;
    if (!isInside(projectDir, t)) { res.errors.push(`refuse target outside project: ${redactHome(t)}`); res.leftover.push(redactHome(t)); continue; }
    if (isReparsePoint(t)) { res.errors.push(`refuse reparse target: ${redactHome(t)}`); res.leftover.push(redactHome(t)); continue; }
    if (fs.existsSync(t) && !isCanonicalInside(projectDir, t)) { res.errors.push(`refuse target escapes project: ${redactHome(t)}`); res.leftover.push(redactHome(t)); continue; }
    safeTargets.push(t);
  }
  // Stop tracked processes. Live/unverified are already filtered; only pids that pass identity get signals.
  const stp = stopTrackedProcesses(snapshot.processes, { timeoutMs, sessionId: snapshot.sessionId });
  for (const pid of stp.unverified) res.errors.push(`tracked process unverified (pid reuse risk): ${pid}`);
  for (const pid of stp.alive) res.errors.push(`tracked process still alive: ${pid}`);
  if (stp.alive.length > 0 || stp.unverified.length > 0) {
    return finalizeCleanup(res, homeDir, projectDir, projectRoot, workspaceBefore, snapshot);
  }
  // Re-read snapshot and recheck ownership immediately before any destructive step.
  const snap2 = readSessionSnapshot(expected);
  if (!snap2.ok || snap2.state !== "present") {
    res.errors.push(snap2.ok ? "home disappeared before removal" : snap2.reason);
    res.leftover.push(redactHome(homeDir));
    return finalizeCleanup(res, homeDir, projectDir, projectRoot, workspaceBefore, snapshot);
  }
  const oc2 = recheckOwnership(homeDir, expected);
  if (!oc2.ok) {
    res.leftover.push(redactHome(homeDir));
    res.errors.push(`ownership recheck failed before removal: ${oc2.reason}`);
    return finalizeCleanup(res, homeDir, projectDir, projectRoot, workspaceBefore, snap2.snapshot);
  }
  // Remove children deepest-first.
  const ordered = sortDeepestFirst(safeTargets);
  for (const t of ordered) {
    try {
      const ocT = recheckOwnership(homeDir, expected);
      if (!ocT.ok) {
        res.errors.push(`refuse removal: ownership recheck failed mid-removal: ${ocT.reason}`);
        res.leftover.push(redactHome(t));
        return finalizeCleanup(res, homeDir, projectDir, projectRoot, workspaceBefore, snap2.snapshot);
      }
      const stillSafe = !isReparsePoint(t) && (realPathOrNull(t) === null || isCanonicalInside(projectDir, t));
      if (!stillSafe) {
        res.errors.push(`refuse removal: target mutated before delete: ${redactHome(t)}`);
        res.leftover.push(redactHome(t));
        continue;
      }
      const recursive = fs.existsSync(t) && fs.statSync(t).isDirectory();
      fs.rmSync(t, { recursive, force: true });
      res.removed.push(redactHome(t));
    } catch (e) {
      res.errors.push(String((e && e.message) || e));
      res.leftover.push(redactHome(t));
    }
  }
  // homeDir is removed exactly once and last.
  if (fs.existsSync(homeDir)) {
    const oc3 = recheckOwnership(homeDir, expected);
    if (!oc3.ok) {
      res.errors.push(`ownership recheck before homeDir removal failed: ${oc3.reason}`);
      res.leftover.push(redactHome(homeDir));
      return finalizeCleanup(res, homeDir, projectDir, projectRoot, workspaceBefore, snap2.snapshot);
    }
    try {
      fs.rmSync(homeDir, { recursive: true, force: true });
      if (fs.existsSync(homeDir)) {
        res.errors.push("homeDir still present after rmSync");
        res.leftover.push(redactHome(homeDir));
      } else {
        res.removed.push(redactHome(homeDir));
      }
    } catch (e) {
      res.errors.push(String((e && e.message) || e));
      res.leftover.push(redactHome(homeDir));
    }
  } else {
    res.removed.push(redactHome(homeDir));
  }
  return finalizeCleanup(res, homeDir, projectDir, projectRoot, workspaceBefore, snap2.snapshot);
}

export function recoverSession(opts) {
  opts = opts || {};
  const projectId = opts.projectId;
  const taskId = opts.taskId;
  const tempRoot = opts.tempRoot || DEFAULT_TEMP_ROOT();
  if (!isSafeProjectId(projectId)) throw new Error("temp-hygiene: projectId must match safe slug");
  if (!isSafeTaskId(taskId)) throw new Error("temp-hygiene: taskId must match safe slug");
  assertOutsideWorktree(tempRoot);
  const root = path.resolve(tempRoot);
  const projectDir = path.join(root, projectId);
  const home = path.join(projectDir, taskId);
  const res = { verdict: "POC_CLEANUP_FAILED", removed: [], leftover: [], errors: [], readBack: null };
  const snap = readSessionSnapshot({ projectId, taskId, tempRoot: root });
  if (!snap.ok) { res.leftover.push(redactHome(home)); res.errors.push(snap.reason); return res; }
  if (snap.state === "absent") { res.verdict = "CLEAN"; res.readBack = readBackState(home, projectDir, { processes: [], sessionId: "" }); return res; }
  if (isReparsePoint(home) || !isCanonicalInside(root, home)) {
    res.leftover.push(redactHome(home)); res.errors.push("home is reparse point or escapes root"); return res;
  }
  const oc = recheckOwnership(home, snap.expected);
  if (!oc.ok) { res.leftover.push(redactHome(home)); res.errors.push(`ownership check failed: ${oc.reason}`); return res; }
  const snapshot = snap.snapshot;
  // Re-classify every tracked process from the snapshot. Never invoke stopTrackedProcesses against a live/unverified owner.
  const live = [], unverified = [];
  for (const rec of snapshot.processes) {
    const c = classifyProcessByIdentity(rec, snapshot.sessionId);
    if (c === "live") live.push(rec.pid);
    else if (c === "unverified") unverified.push(rec.pid);
  }
  if (live.length > 0 || unverified.length > 0) {
    res.leftover.push(redactHome(home));
    if (live.length > 0) res.errors.push(`live owner blocks recovery: pids=${live.join(",")}`);
    if (unverified.length > 0) res.errors.push(`unverified owner blocks recovery: pids=${unverified.join(",")}`);
    res.readBack = readBackState(home, projectDir, snapshot);
    return res;
  }
  // Re-read snapshot and recheck ownership immediately before rmSync.
  const snap2 = readSessionSnapshot({ projectId, taskId, tempRoot: root });
  if (!snap2.ok || snap2.state !== "present") {
    res.errors.push(snap2.ok ? "home disappeared before recovery" : snap2.reason);
    res.leftover.push(redactHome(home));
    res.readBack = readBackState(home, projectDir, snapshot);
    return res;
  }
  const oc2 = recheckOwnership(home, snap2.expected);
  if (!oc2.ok) {
    res.leftover.push(redactHome(home));
    res.errors.push(`ownership recheck failed: ${oc2.reason}`);
    res.readBack = readBackState(home, projectDir, snap2.snapshot);
    return res;
  }
  try {
    const stillSafe = !isReparsePoint(home) && isCanonicalInside(root, home);
    if (!stillSafe) {
      res.leftover.push(redactHome(home));
      res.errors.push("home mutated before delete");
      res.readBack = readBackState(home, projectDir, snap2.snapshot);
      return res;
    }
    fs.rmSync(home, { recursive: true, force: true });
    if (fs.existsSync(home)) {
      res.leftover.push(redactHome(home));
      res.errors.push("fs.rmSync did not remove home");
    } else {
      res.verdict = "CLEAN";
      res.removed.push(redactHome(home));
    }
  } catch (e) {
    res.leftover.push(redactHome(home));
    res.errors.push(String((e && e.message) || e));
  }
  res.readBack = readBackState(home, projectDir, snap2.snapshot);
  return res;
}
