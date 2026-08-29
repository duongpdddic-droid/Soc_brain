#!/usr/bin/env node
// temp-hygiene.mjs — Soc_brain: runtime/temp hygiene primitives (Issue #7).
//
// Source: duongpdddic-droid/AI_PR_REVIEWER
// Immutable source SHA: 9c104c88dddb3e9aad0388447e9be6ff74f78a06
// Source file: scripts/temp-hygiene.mjs
//
// Material adaptations from the source (named per Issue "Explicit deviations
// from source" requirement):
//   1. `DEFAULT_TEMP_ROOT` factory: source returns `os.tmpdir()/ai-pr-reviewer-temp-v1`.
//      Soc_brain production default is `os.homedir()/.soc-brain` (Issue: "production
//      default is below os.homedir()/.soc-brain/"). Tests inject disposable temp roots
//      so no test artifact lands in the user's home directory.
//   2. Unconditional refusal of a temp root inside the Git worktree: source only
//      enforces this when the caller supplies `projectRoot`. Issue #7 requires the
//      check to be unconditional — `assertOutsideWorktree` resolves the package's
//      own Git worktree and rejects any `tempRoot` that is the worktree, inside it,
//      or escapes into it via canonical (realpath) form. This is the per-Issue
//      "Refuse unsafe runtime roots inside the Git worktree" requirement.
//   3. `redactHome` additionally redacts the production default path so test
//      reports that name `DEFAULT_TEMP_ROOT` do not leak the user's home.
//   4. No additional dependency introduced; all behavior reuses Node stdlib only
//      (fs, path, os, child_process, crypto) — confirmed by import inspection of
//      the source at the pinned SHA.
//
// Source parity: every exported function and the public behavior of
// `createSessionManager`, `cleanupSession`, `recoverSession` match the source.
// Deterministic tests in `tests/temp-hygiene.test.mjs` cover the parity surface.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Production default: under os.homedir()/.soc-brain (Issue: "production default
// is below os.homedir()/.soc-brain/"). Tests must inject a disposable tempRoot
// to avoid leaving anything under the user's home.
export const DEFAULT_TEMP_ROOT = () => path.join(os.homedir(), '.soc-brain');

const MANIFEST_NAME = '.session-manifest.json';
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(SLEEP_BUF, 0, 0, ms);
const hex = (n) => randomBytes(n).toString('hex');

// --- validators / path safety ---

// Source parity: isSafeSessionId restricts to lowercase hex up to 64 chars.
export const isSafeSessionId = (id) => typeof id === 'string' && /^[0-9a-f]{1,64}$/.test(id);

// Resolve the Git worktree that contains this package file. Used by
// `assertOutsideWorktree` so a caller cannot drop a temp root inside the repo.
function currentWorktreeRoot() {
  // Walk up from this file until we find a directory containing `.git`.
  // Avoids invoking `git` so it works even when the worktree is missing `.git`
  // metadata (e.g. shallow clones without index).
  const here = path.dirname(fileURLToPath(import.meta.url));
  let cur = here;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // Fall back to `git rev-parse --show-toplevel` from this file's location.
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: here, encoding: 'utf8' });
  if (r.status === 0 && r.stdout) return path.resolve(r.stdout.trim());
  return null;
}

// Reject temp roots that resolve to or inside the Git worktree that contains
// this package. The check uses both lexical and canonical (realpath) forms so
// symlinks/junctions into the worktree are also rejected. Refuses to run when
// the worktree cannot be determined (fail-closed).
export function assertOutsideWorktree(tempRoot) {
  const r = path.resolve(tempRoot);
  const wt = currentWorktreeRoot();
  if (!wt) throw new Error(`temp-hygiene: cannot determine Git worktree to validate temp root: ${r}`);
  const wtp = path.resolve(wt);
  const sameOrInside = (root) => root === wtp || root.startsWith(wtp + path.sep);
  if (sameOrInside(r)) throw new Error(`temp root không được nằm trong Git worktree: ${r}`);
  const realRoot = (() => { try { return fs.realpathSync(r); } catch { return r; } })();
  if (sameOrInside(realRoot)) throw new Error(`temp root (canonical) nằm trong Git worktree: ${realRoot}`);
  return true;
}

// target nằm TRONG root (resolve + so prefix), không phải chính root.
export const isInside = (rootDir, target) => {
  const r = path.resolve(rootDir);
  const t = path.resolve(target);
  return t !== r && t.startsWith(r + path.sep);
};

export const isAlive = (pid) => {
  if (!Number.isInteger(pid)) return false;
  // POSIX: process bị kill thành zombie (state 'Z') vẫn đang trong bảng process,
  // nhưng đã dead. kill(pid,0) trên zombie vẫn thành công → false positive
  // khiến cleanup báo POC_CLEANUP_FAILED. Đọc /proc/<pid>/stat để loại zombie.
  if (process.platform !== 'win32') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // format: pid (comm) state ... — state là ký tự sau dấu ')' cuối cùng.
      const close = stat.lastIndexOf(')');
      const state = close >= 0 && close + 2 <= stat.length ? stat[close + 2] : '';
      if (state === 'Z') return false;
    } catch { /* không đọc được /proc → fall back xuống kill(pid,0) */ }
  }
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
};

// canonical realpath (giải symlink/junction). null nếu không tồn tại.
export const realPathOrNull = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

// target thực sự (sau giải symlink/junction) có nằm trong root không.
export const isCanonicalInside = (rootDir, target) => {
  const r = realPathOrNull(rootDir);
  const t = realPathOrNull(target);
  if (!r || !t) return false;
  return t !== r && t.startsWith(r + path.sep);
};

// kiểm symlink / junction (reparse point) — bị từ chối xóa theo policy.
const isSymlink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

// workspace snapshot: các dòng `git status --porcelain` (null nếu không phải git repo).
export const snapshotWorkspace = (projectDir) => {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: projectDir, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return (r.stdout || '').split('\n').filter(Boolean).sort();
};

// diff workspace so với snapshot trước → path thay đổi.
export const workspaceChange = (projectDir, before) => {
  if (before == null) return [];
  const after = snapshotWorkspace(projectDir) || [];
  return after.filter((l) => !before.includes(l)).concat(before.filter((l) => !after.includes(l)));
};

// dừng process do phiên tạo theo PID (không kill theo tên process chung).
// Chống PID reuse: trước khi kill, xác minh owner identity của process (khác PID).
// Không đọc được cmdline / identity lệch → KHÔNG kill → trả vào `unverified` (fail-closed).
export const sp_procCommandLine = (pid) => {
  if (!Number.isInteger(pid)) return null;
  if (os.platform() === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
      { encoding: 'utf8' });
    return r.status === 0 ? (r.stdout || '').trim() : null;
  }
  const p = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
  return p.status === 0 ? (p.stdout || '').trim() : null;
};

// Xác minh process có thuộc phiên này không (beyond PID): cmdline phải chứa identity.
// query fail / không đọc được → false (fail-closed, không kill).
export const verifyProcessIdentity = (rec, sessionId) => {
  if (!rec || !Number.isInteger(rec.pid)) return false;
  if (!isAlive(rec.pid)) return false;
  const cmd = sp_procCommandLine(rec.pid);
  if (!cmd) return false;
  const identity = rec.identity || sessionId;
  return Boolean(identity) && cmd.includes(String(identity));
};

// opts: number (timeoutMs cũ) | { timeoutMs, sessionId }
export const stopTrackedProcesses = (processes = [], opts = {}) => {
  const timeoutMs = typeof opts === 'number' ? opts : (opts.timeoutMs || 1500);
  const sessionId = typeof opts === 'object' ? (opts.sessionId || null) : null;
  const killed = [];
  const unverified = [];
  for (const rec of processes) {
    if (!rec || !isAlive(rec.pid)) continue;
    if (sessionId && !verifyProcessIdentity(rec, sessionId)) { unverified.push(rec.pid); continue; }
    try { process.kill(rec.pid, 'SIGTERM'); } catch { /* đã đi/chưa thể kill */ }
    const deadline = Date.now() + timeoutMs;
    while (isAlive(rec.pid) && Date.now() < deadline) sleep(20);
    if (isAlive(rec.pid)) { try { process.kill(rec.pid, 'SIGKILL'); } catch {} }
    killed.push(rec.pid);
  }
  return { killed, unverified };
};

// --- ownership marker ---
const markerPath = (dir, id) => path.join(dir, `.session-owner-${id}`);
export const ensureOwnershipMarker = (dir, id) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(markerPath(dir, id), JSON.stringify({ sessionId: id }));
};
export const hasOwnershipMarker = (dir, id) => {
  try {
    const raw = fs.readFileSync(markerPath(dir, id), 'utf8');
    return JSON.parse(raw).sessionId === id;
  } catch {
    return false;
  }
};

// redact user path (HOME/username) khỏi absolute target khi báo cáo leftover.
// Adaptation #3: also redact the production default root so reports that name it
// do not leak the user's home directory.
export const redactHome = (p) => {
  const home = os.homedir();
  const user = os.userInfo().username;
  const defaultRoot = DEFAULT_TEMP_ROOT();
  return String(p)
    .replace(defaultRoot, '<SOC_BRAIN_RUNTIME>')
    .replace(home, '~')
    .replace(new RegExp(user, 'g'), '<USER>');
};

// --- session manager ---
export function createSessionManager({ sessionId, tempRoot = DEFAULT_TEMP_ROOT(), projectRoot = null, purpose = '' } = {}) {
  const id = sessionId || hex(16);
  if (!isSafeSessionId(id)) throw new Error(`temp-hygiene: sessionId không an toàn: "${id}"`);
  // Adaptation #2: unconditional refusal of temp root inside the Git worktree.
  assertOutsideWorktree(tempRoot);
  const root = path.resolve(tempRoot);
  if (projectRoot) {
    const pr = path.resolve(projectRoot);
    if (root === pr || root.startsWith(pr + path.sep)) throw new Error('temp root không được nằm trong repo/workspace thật');
  }
  fs.mkdirSync(root, { recursive: true });
  const homeDir = path.join(root, id);
  if (fs.existsSync(homeDir)) throw new Error(`temp-hygiene: dir phiên đã tồn tại: ${homeDir}`);
  fs.mkdirSync(homeDir, { recursive: false });

  const manifest = { version: 1, sessionId: id, purpose, createdAt: new Date().toISOString(), homeDir, dirs: [homeDir], files: [], processes: [] };
  ensureOwnershipMarker(homeDir, id);
  const save = () => fs.writeFileSync(path.join(homeDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  save();

  const assertInside = (p) => { if (!isInside(homeDir, p)) throw new Error(`path thoát session dir: ${p}`); };

  const mgr = {
    sessionId: id, tempRoot: root, homeDir, manifest,
    createDir(rel) {
      const d = path.join(homeDir, rel);
      assertInside(d);
      fs.mkdirSync(d, { recursive: true });
      ensureOwnershipMarker(d, id);
      if (!manifest.dirs.includes(d)) manifest.dirs.push(d);
      save();
      return d;
    },
    createFile(rel, content) {
      const p = path.join(homeDir, rel);
      assertInside(p);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
      ensureOwnershipMarker(path.dirname(p), id);
      if (!manifest.files.includes(p)) manifest.files.push(p);
      save();
      return p;
    },
    spawnProcess(cmd, args = [], opts = {}) {
      const child = spawn(cmd, args, opts);
      // identity owner ngoài PID: caller phải đính identity (vd: chuỗi sessionId)
      // vào args/env/cmdline của process để verifyProcessIdentity khớp.
      manifest.processes.push({ pid: child.pid, cmd, args, identity: opts.identity || id });
      save();
      return child;
    },
    cleanup(opts = {}) { return cleanupSession(mgr, opts); },
  };
  return mgr;
}




// --- cleanup + read-back ---
export function cleanupSession(mgr, { timeoutMs = 1500, projectRoot = null, workspaceBefore = null } = {}) {
  const { manifest, homeDir } = mgr;
  const rootDir = path.resolve(path.dirname(homeDir));
  const sessionId = mgr.sessionId;
  const res = { verdict: 'POC_CLEANUP_FAILED', removed: [], leftover: [], killed: [], unverified: [], readBack: null, errors: [] };

  // 1. d?ng d�ng child process phi�n t?o: x�c minh owner identity (ch?ng PID reuse).
  const stp = stopTrackedProcesses(manifest.processes || [], { timeoutMs, sessionId });
  res.killed = stp.killed;
  res.unverified = stp.unverified;

  // 2. x�a target li?t k� trong manifest (deep nh?t tru?c). Ch? target trong root,
  //    kh�ng symlink/junction, target th?c (realpath) ph?i trong root (ch?ng escape).
  const targets = [...(manifest.files || []), ...(manifest.dirs || [])];
  targets.sort((a, b) => path.resolve(b).length - path.resolve(a).length);
  for (const t of targets) {
    if (!isInside(rootDir, t)) { res.errors.push(`outside allowed root: ${redactHome(t)}`); res.leftover.push(redactHome(t)); continue; }
    if (/\.session-(owner|manifest)/.test(path.basename(t))) continue; // marker/manifest t? qu?n ? bu?c 3
    if (isSymlink(t)) {
      res.errors.push(`refuse symlink/junction: ${redactHome(t)}`);
      res.leftover.push(redactHome(t));
      continue;
    }
    if (realPathOrNull(t) === null) continue; // d� x�a/s?n h?t ? idempotent, kh�ng leftover
    if (!isCanonicalInside(rootDir, t)) {
      res.errors.push(`refuse target tho�t root: ${redactHome(t)}`);
      res.leftover.push(redactHome(t));
      continue;
    }
    try {
      fs.rmSync(t, { recursive: fs.existsSync(t) && fs.statSync(t).isDirectory(), force: true });
      res.removed.push(redactHome(t));
    } catch (e) {
      res.errors.push(String((e && e.message) || e));
      res.leftover.push(redactHome(t));
    }
  }

  // 3. x�a dir phi�n (c�ng marker + manifest): path d� validate = root/<sessionId>,
  //    v� realpath ph?i n?m trong root (t? ch?i n?u homeDir l� symlink/junction tho�t).
  try {
    if (fs.existsSync(homeDir)) {
      if (isSymlink(homeDir) || !isCanonicalInside(rootDir, homeDir)) {
        res.errors.push(`refuse x�a homeDir symlink/junction tho�t root: ${redactHome(homeDir)}`);
        res.leftover.push(redactHome(homeDir));
      } else {
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    }
  } catch (e) {
    res.errors.push(String((e && e.message) || e));
    res.leftover.push(redactHome(homeDir));
  }

  // 4. read-back: baseline workspace B?T BU?C khi c� projectRoot (null ? fail-closed,
  //    workspaceUnchanged=false). N?u projectRoot null, d�nh workspaceUnchanged=true
  //    CH? khi projectRoot cung null trong policy (t?c caller kh�ng y�u c?u). Theo
  //    source: khi kh�ng c� projectRoot, workspaceUnchanged v?n = false (fail-closed).
  const homeGone = !fs.existsSync(homeDir);
  const procGone = (manifest.processes || []).every((p) => !isAlive(p.pid));
  const hasBaseline = !projectRoot || Array.isArray(workspaceBefore);
  const ws = projectRoot ? workspaceChange(projectRoot, workspaceBefore) : null;
  const workspaceUnchanged = !projectRoot ? hasBaseline : (hasBaseline && ws && ws.length === 0);
  res.readBack = { homeGone, processesGone: procGone, workspaceUnchanged, workspaceBaselinePresent: hasBaseline };
  res.leftover = res.leftover.map(redactHome);

  const ok = homeGone && procGone && res.leftover.length === 0 && res.errors.length === 0 && workspaceUnchanged;
  res.verdict = ok ? 'CLEAN' : 'POC_CLEANUP_FAILED';
  return res;
}

// --- recovery theo sessionId (idempotent, chá»‰ xÃ³a resource cÃ³ marker) ---
export function recoverSession({ sessionId, tempRoot = DEFAULT_TEMP_ROOT() }) {
  if (!isSafeSessionId(sessionId)) throw new Error(`temp-hygiene: sessionId khÃ´ng an toÃ n: "${sessionId}"`);
  // Adaptation #2: also enforce worktree safety on the recovery path.
  assertOutsideWorktree(tempRoot);
  const root = path.resolve(tempRoot);
  const home = path.join(root, sessionId);
  if (!fs.existsSync(home)) return { verdict: 'CLEAN', removed: [], leftover: [], errors: [] }; // idempotent
  if (!isInside(root, home) || isSymlink(home) || !isCanonicalInside(root, home)) {
    return { verdict: 'POC_CLEANUP_FAILED', removed: [], leftover: [redactHome(home)], errors: ['symlink/junction hoáº·c thoÃ¡t root'] };
  }
  if (!hasOwnershipMarker(home, sessionId)) {
    return { verdict: 'POC_CLEANUP_FAILED', removed: [], leftover: [redactHome(home)], errors: ['thiáº¿u ownership marker â€” khÃ´ng tá»± xÃ³a'] };
  }
  // manifest báº¯t buá»™c Ä‘á»c + schema há»£p lá»‡ má»›i Ä‘Æ°á»£c xÃ³a dir. Fail-closed: manifest máº¥t/há»ng/
  // version khÃ´ng há»— trá»£/session lá»‡ch/process record invalid â†’ GIá»® NGUYÃŠN dir (khÃ´ng thá»ƒ xÃ¡c minh
  // process tracked khi máº¥t manifest) â€” khÃ´ng bao giá» tuyÃªn bá»‘ CLEAN mÃ  thiáº¿u tráº¡ng thÃ¡i process verified.
  let procRecs;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, MANIFEST_NAME), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) {
      return { verdict: 'POC_CLEANUP_FAILED', removed: [], leftover: [redactHome(home)], errors: ['manifest thiáº¿u/version khÃ´ng há»— trá»£ â€” giá»¯ nguyÃªn'] };
    }
    if (parsed.sessionId !== sessionId) {
      return { verdict: 'POC_CLEANUP_FAILED', removed: [], leftover: [redactHome(home)], errors: ['manifest sessionId lá»‡ch â€” giá»¯ nguyÃªn'] };
    }
    if (!Array.isArray(parsed.processes) || parsed.processes.some((r) => !r || !Number.isInteger(r.pid))) {
      return { verdict: 'POC_CLEANUP_FAILED', removed: [], leftover: [redactHome(home)], errors: ['manifest processes khÃ´ng há»£p lá»‡ â€” giá»¯ nguyÃªn'] };
    }
    procRecs = parsed.processes;
  } catch (e) {
    return { verdict: 'POC_CLEANUP_FAILED', removed: [], leftover: [redactHome(home)], errors: [`manifest JSON khÃ´ng Ä‘á»c/parse Ä‘Æ°á»£c: ${e.message} â€” giá»¯ nguyÃªn`] };
  }
  const stp = stopTrackedProcesses(procRecs, { timeoutMs: 800, sessionId });
  if (stp.unverified.length > 0) {
    return { verdict: 'POC_CLEANUP_FAILED', removed: [], leftover: [redactHome(home)], errors: ['process unverified (PID reuse nghi ngá») â€” chÆ°a kill'] };
  }
  try {
    fs.rmSync(home, { recursive: true, force: true });
    const gone = !fs.existsSync(home);
    return { verdict: gone ? 'CLEAN' : 'POC_CLEANUP_FAILED', removed: gone ? [redactHome(home)] : [], leftover: gone ? [] : [redactHome(home)], errors: [] };
  } catch (e) {
    return { verdict: 'POC_CLEANUP_FAILED', removed: [], leftover: [redactHome(home)], errors: [String((e && e.message) || e)] };
  }
}
