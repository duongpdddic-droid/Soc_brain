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
const ID_PATTERN = /^[0-9a-f]{1,64}$/;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const hex = (n) => randomBytes(n).toString('hex');

// Production default: <homedir>/.soc-brain. Tests inject disposable temp roots.
export const DEFAULT_TEMP_ROOT = () => path.join(os.homedir(), '.soc-brain');

// ID validators. projectId, taskId, sessionId are all lowercase hex up to 64.
export const isSafeProjectId = (id) => typeof id === 'string' && ID_PATTERN.test(id);
export const isSafeTaskId = (id) => typeof id === 'string' && ID_PATTERN.test(id);
export const isSafeSessionId = (id) => typeof id === 'string' && ID_PATTERN.test(id);

// Path containment helpers. Windows paths are case-insensitive: normalize
// case before comparing. realpathSync would be ideal but fails for
// non-existing paths, so we fall back to a lexical compare.
const ci = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
export const isInside = (root, p) => {
  if (typeof root !== 'string' || typeof p !== 'string') return false;
  const r = ci(path.resolve(root));
  const x = ci(path.resolve(p));
  if (r === x) return false;
  return x === r || x.startsWith(r + path.sep);
};

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
    if (rp && rp !== path.resolve(p)) return true;
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
  const twReal = realPathOrNull(worktree) || path.resolve(worktree);
  const inputLex = path.resolve(tempRoot);
  const inputReal = realPathOrNull(tempRoot) || inputLex;
  if (inputLex === twReal || inputLex.startsWith(twReal + path.sep)) {
    throw new Error('temp-hygiene: tempRoot is inside the Git worktree');
  }
  if (inputReal === twReal || inputReal.startsWith(twReal + path.sep)) {
    throw new Error('temp-hygiene: tempRoot resolves inside the Git worktree');
  }
}

// redactHome: replace the user home and username with placeholders, and
// also replace the production default with a literal token so reports do
// not leak absolute paths. Order matters: replace the most specific token
// (production default) first so subsequent home/user redactions do not
// destroy it.
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

// Ownership marker writer and reader.
export function hasOwnershipMarker(homeDir, expectedId) {
  try {
    const buf = fs.readFileSync(path.join(homeDir, MARKER_FILE), 'utf8');
    return buf.trim() === `${MARKER_BODY}:${expectedId}`;
  } catch { return false; }
}

function ensureOwnershipMarker(homeDir, expectedId) {
  const marker = path.join(homeDir, MARKER_FILE);
  if (isSymlink(marker) || isReparsePoint(marker)) {
    throw new Error('temp-hygiene: ownership marker path is a reparse point');
  }
  fs.writeFileSync(marker, `${MARKER_BODY}:${expectedId}\n`);
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
  if (r.status !== 0) return null;
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
  const r = ci(path.resolve(homeDir));
  const x = ci(path.resolve(p));
  return x === r || x.startsWith(r + path.sep);
}

// Canonical pre-write safety: walk every existing segment under homeDir.
function safeCreatePath(homeDir, absTarget) {
  if (!isSameOrInside(homeDir, absTarget)) {
    throw new Error(`temp-hygiene: write target escapes session dir: ${redactHome(absTarget)}`);
  }
  if (ci(path.resolve(absTarget)) === ci(path.resolve(homeDir))) {
    // Writing the session dir itself: nothing to walk.
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

export function createSessionManager(opts) {
  opts = opts || {};
  const tempRoot = opts.tempRoot;
  const projectRoot = opts.projectRoot;
  const projectId = opts.projectId;
  const taskId = opts.taskId;
  const purpose = opts.purpose || 'unspecified';
  if (typeof tempRoot !== 'string' || !tempRoot) throw new Error('temp-hygiene: tempRoot required');
  if (!isSafeProjectId(projectId)) throw new Error('temp-hygiene: projectId must be 1-64 lowercase hex chars');
  if (!isSafeTaskId(taskId)) throw new Error('temp-hygiene: taskId must be 1-64 lowercase hex chars');
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
  const manifest = {
    version: 2,
    projectId, taskId, sessionId, purpose,
    createdAt: new Date().toISOString(),
    homeDir, projectDir, tempRoot: root,
    dirs: [homeDir], files: [], processes: [],
  };
  ensureOwnershipMarker(homeDir, taskId);
  const save = () => fs.writeFileSync(path.join(homeDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  save();

  const assertInside = (p) => {
    if (!isInside(homeDir, p)) throw new Error(`temp-hygiene: path escapes session: ${redactHome(p)}`);
  };

  const mgr = {
    sessionId, projectId, taskId, tempRoot: root, homeDir, projectDir, manifest,
    createDir(rel) {
      const d = path.join(homeDir, rel);
      assertInside(d);
      safeCreatePath(homeDir, d);
      fs.mkdirSync(d, { recursive: true });
      ensureOwnershipMarker(d, taskId);
      if (!manifest.dirs.includes(d)) manifest.dirs.push(d);
      save();
      return d;
    },
    createFile(rel, content) {
      const p = path.join(homeDir, rel);
      assertInside(p);
      safeCreatePath(homeDir, path.dirname(p));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      ensureOwnershipMarker(path.dirname(p), taskId);
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

function recheckOwnership(homeDir, projectId, taskId) {
  if (!fs.existsSync(homeDir)) return { ok: false, reason: 'home gone' };
  if (isReparsePoint(homeDir)) return { ok: false, reason: 'home is reparse point' };
  if (!isCanonicalInside(path.dirname(homeDir), homeDir)) {
    return { ok: false, reason: 'home escapes project dir' };
  }
  if (!hasOwnershipMarker(homeDir, taskId)) {
    return { ok: false, reason: 'ownership marker missing or mismatched' };
  }
  return { ok: true };
}

function readManifestOrFail(homeDir) {
  const fp = path.join(homeDir, MANIFEST_NAME);
  if (!fs.existsSync(fp)) return { ok: false, reason: 'manifest missing' };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch (e) { return { ok: false, reason: `manifest JSON unparseable: ${e.message}` }; }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'manifest not an object' };
  if (parsed.version !== 2) return { ok: false, reason: 'manifest version unsupported' };
  if (!Array.isArray(parsed.processes) || parsed.processes.some((r) => !r || !Number.isInteger(r.pid))) {
    return { ok: false, reason: 'manifest processes invalid' };
  }
  return { ok: true, manifest: parsed };
}

export function cleanupSession(opts) {
  const mgr = opts.mgr;
  const projectRoot = opts.projectRoot || null;
  const workspaceBefore = opts.workspaceBefore;
  const timeoutMs = opts.timeoutMs || 800;
  const res = { verdict: 'POC_CLEANUP_FAILED', removed: [], leftover: [], errors: [], readBack: null };
  if (!mgr || !mgr.homeDir || !mgr.manifest) {
    res.errors.push('cleanupSession: missing manager');
    return res;
  }
  const { manifest, homeDir } = mgr;
  const projectDir = path.resolve(path.dirname(homeDir));
  const mc = readManifestOrFail(homeDir);
  if (!mc.ok) { res.leftover.push(redactHome(homeDir)); res.errors.push(mc.reason); return finalizeCleanup(res, projectRoot, workspaceBefore); }
  const oc = recheckOwnership(homeDir, mgr.projectId, mgr.taskId);
  if (!oc.ok) { res.leftover.push(redactHome(homeDir)); res.errors.push(`ownership check failed: ${oc.reason}`); return finalizeCleanup(res, projectRoot, workspaceBefore); }
  const targets = [...(manifest.files || []), ...(manifest.dirs || []), homeDir];
  const safeTargets = [];
  for (const t of targets) {
    if (!t || typeof t !== 'string') continue;
    if (!isInside(projectDir, t)) { res.errors.push(`refuse target outside project: ${redactHome(t)}`); res.leftover.push(redactHome(t)); continue; }
    if (isReparsePoint(t)) { res.errors.push(`refuse reparse target: ${redactHome(t)}`); res.leftover.push(redactHome(t)); continue; }
    if (fs.existsSync(t) && !isCanonicalInside(projectDir, t)) { res.errors.push(`refuse target escapes project: ${redactHome(t)}`); res.leftover.push(redactHome(t)); continue; }
    safeTargets.push(t);
  }
  const oc2 = recheckOwnership(homeDir, mgr.projectId, mgr.taskId);
  if (!oc2.ok) { res.leftover.push(redactHome(homeDir)); res.errors.push(`ownership recheck failed: ${oc2.reason}`); return finalizeCleanup(res, projectRoot, workspaceBefore); }
  const stp = stopTrackedProcesses(manifest.processes, { timeoutMs, sessionId: manifest.sessionId });
  for (const pid of stp.alive) res.errors.push(`tracked process still alive: ${pid}`);
  for (const pid of stp.unverified) res.errors.push(`tracked process unverified (pid reuse risk): ${pid}`);
  if (stp.alive.length > 0 || stp.unverified.length > 0) return finalizeCleanup(res, projectRoot, workspaceBefore);
  for (const t of safeTargets) {
    try {
      const stillSafe = !isReparsePoint(t) && (realPathOrNull(t) === null || isCanonicalInside(projectDir, t));
      if (!stillSafe) { res.errors.push(`refuse removal: target mutated before delete: ${redactHome(t)}`); res.leftover.push(redactHome(t)); continue; }
      fs.rmSync(t, { recursive: fs.existsSync(t) && fs.statSync(t).isDirectory(), force: true });
      res.removed.push(redactHome(t));
    } catch (e) { res.errors.push(String((e && e.message) || e)); res.leftover.push(redactHome(t)); }
  }
  if (fs.existsSync(homeDir)) {
    const oc3 = recheckOwnership(homeDir, mgr.projectId, mgr.taskId);
    if (!oc3.ok) { res.errors.push(`post-clean ownership recheck failed: ${oc3.reason}`); res.leftover.push(redactHome(homeDir)); }
  }
  return finalizeCleanup(res, projectRoot, workspaceBefore);
}

function finalizeCleanup(res, projectRoot, workspaceBefore) {
  const hasBaseline = Array.isArray(workspaceBefore);
  const ws = projectRoot ? workspaceChange(projectRoot, workspaceBefore) : null;
  const workspaceUnchanged = !projectRoot ? hasBaseline : (hasBaseline && ws && ws.length === 0);
  res.readBack = { homeGone: res.leftover.length === 0, processesGone: true, workspaceUnchanged, workspaceBaselinePresent: hasBaseline };
  res.removed = res.removed.map(redactHome);
  res.leftover = res.leftover.map(redactHome);
  const ok = res.leftover.length === 0 && res.errors.length === 0 && res.readBack.workspaceUnchanged;
  res.verdict = ok ? 'CLEAN' : 'POC_CLEANUP_FAILED';
  return res;
}

export function recoverSession(opts) {
  opts = opts || {};
  const projectId = opts.projectId;
  const taskId = opts.taskId;
  const tempRoot = opts.tempRoot || DEFAULT_TEMP_ROOT();
  if (!isSafeProjectId(projectId)) throw new Error('temp-hygiene: projectId must be 1-64 lowercase hex chars');
  if (!isSafeTaskId(taskId)) throw new Error('temp-hygiene: taskId must be 1-64 lowercase hex chars');
  assertOutsideWorktree(tempRoot);
  const root = path.resolve(tempRoot);
  const projectDir = path.join(root, projectId);
  const home = path.join(projectDir, taskId);
  const res = { verdict: 'POC_CLEANUP_FAILED', removed: [], leftover: [], errors: [], readBack: null };
  if (!fs.existsSync(home)) { res.verdict = 'CLEAN'; return res; }
  if (isReparsePoint(home) || !isCanonicalInside(root, home)) {
    res.leftover.push(redactHome(home)); res.errors.push('home is reparse point or escapes root'); return res;
  }
  const oc = recheckOwnership(home, projectId, taskId);
  if (!oc.ok) { res.leftover.push(redactHome(home)); res.errors.push(`ownership check failed: ${oc.reason}`); return res; }
  const mc = readManifestOrFail(home);
  if (!mc.ok) { res.leftover.push(redactHome(home)); res.errors.push(mc.reason); return res; }
  const procRecs = mc.manifest.processes;
  const live = [], unverified = [];
  for (const rec of procRecs) {
    if (!Number.isInteger(rec.pid)) continue;
    if (isAlive(rec.pid)) {
      if (!verifyProcessIdentity(rec.pid, mc.manifest.sessionId)) unverified.push(rec.pid);
      else live.push(rec.pid);
    }
  }
  if (live.length > 0 || unverified.length > 0) {
    res.leftover.push(redactHome(home));
    if (live.length > 0) res.errors.push(`live owner blocks recovery: pids=${live.join(',')}`);
    if (unverified.length > 0) res.errors.push(`unverified owner blocks recovery: pids=${unverified.join(',')}`);
    return res;
  }
  const oc2 = recheckOwnership(home, projectId, taskId);
  if (!oc2.ok) { res.leftover.push(redactHome(home)); res.errors.push(`ownership recheck failed: ${oc2.reason}`); return res; }
  try {
    const stillSafe = !isReparsePoint(home) && isCanonicalInside(root, home);
    if (!stillSafe) { res.leftover.push(redactHome(home)); res.errors.push('home mutated before delete'); return res; }
    fs.rmSync(home, { recursive: true, force: true });
    const gone = !fs.existsSync(home);
    if (gone) { res.verdict = 'CLEAN'; res.removed.push(redactHome(home)); }
    else { res.leftover.push(redactHome(home)); res.errors.push('fs.rmSync did not remove home'); }
  } catch (e) {
    res.leftover.push(redactHome(home));
    res.errors.push(String((e && e.message) || e));
  }
  return res;
}

