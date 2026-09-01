// registry-storage.mjs — Canonical Project Registry physical SSOT (Soc_brain Issue #17).
//
// One physical file: ~/.soc-brain/registry/projects.json  (override via SOC_PROJECT_REGISTRY_PATH)
// Single writer-lock:    ~/.soc-brain/registry/projects.json.lock/   (directory; owner.json inside)
// Legacy:                ~/.ai-pr-reviewer/registry.json   (split-brain + migration only)
//
// Fail-closed. No runtime fallback that reads both legacy and canonical.
// RFC 8785 JCS via canonical-jcs.mjs.
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, lstatSync,
  openSync, closeSync, fsyncSync, unlinkSync, rmSync, rmdirSync, realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, join, parse } from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { canonicalizeJCS, runJCSSelfCheck } from './canonical-jcs.mjs';

export const SUPPORTED_REGISTRY_SCHEMA = '1.0.0';
export const MIGRATION_CONTRACT_VERSION = '1.0.0';
export const REGISTRY_DIGEST_RE = /^[0-9a-f]{64}$/;
export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const PROJECT_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Hosts accepted for git remote verification (GPT-REV-141). Only trusted GitHub
// hosts; everything else (evil host, credential-bearing userinfo, non-github) is
// rejected fail-closed. Credential-bearing userinfo (user:token@) is always rejected.
export const TRUSTED_GIT_HOSTS = new Set(['github.com']);

export const DEFAULT_CANONICAL_REGISTRY_DIR = join(os.homedir(), '.soc-brain', 'registry');
export const DEFAULT_CANONICAL_REGISTRY_PATH = join(DEFAULT_CANONICAL_REGISTRY_DIR, 'projects.json');
export const DEFAULT_CANONICAL_LOCK_DIR = DEFAULT_CANONICAL_REGISTRY_DIR + (process.platform === 'win32' ? '\\' : '/') + 'projects.json.lock';
export const LEGACY_REGISTRY_PATH = join(os.homedir(), '.ai-pr-reviewer', 'registry.json');
export const LEGACY_TOMBSTONE_PATH = LEGACY_REGISTRY_PATH + '.tombstone.json';

// ---- Path resolution -----------------------------------------------------------

export function resolveCanonicalRegistryPath({ override = null, cwd = process.cwd() } = {}) {
  const raw = override ?? process.env.SOC_PROJECT_REGISTRY_PATH ?? '';
  if (!raw) return { ok: true, path: DEFAULT_CANONICAL_REGISTRY_PATH, lockDir: DEFAULT_CANONICAL_LOCK_DIR, fromOverride: false };
  if (typeof raw !== 'string' || !isAbsolute(raw)) {
    return { ok: false, code: 'REGISTRY_PATH_INVALID', errors: ['SOC_PROJECT_REGISTRY_PATH phải là absolute path'] };
  }
  const abs = resolve(raw);
  const rel = relative(cwd, abs);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return { ok: false, code: 'REGISTRY_PATH_INSIDE_WORKTREE', errors: ['SOC_PROJECT_REGISTRY_PATH không được nằm trong worktree'] };
  }
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      return { ok: false, code: 'REGISTRY_PATH_SYMLINK_ESCAPE', errors: ['SOC_PROJECT_REGISTRY_PATH không được là symlink/junction'] };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      return { ok: false, code: 'REGISTRY_PATH_UNREADABLE', errors: [`SOC_PROJECT_REGISTRY_PATH: ${err.message}`] };
    }
    const parent = dirname(abs);
    try {
      const pst = lstatSync(parent);
      if (pst.isSymbolicLink()) {
        return { ok: false, code: 'REGISTRY_PATH_SYMLINK_ESCAPE', errors: ['SOC_PROJECT_REGISTRY_PATH parent không được là symlink/junction'] };
      }
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') {
        return { ok: false, code: 'REGISTRY_PATH_UNREADABLE', errors: [`SOC_PROJECT_REGISTRY_PATH parent: ${e.message}`] };
      }
    }
  }
  return { ok: true, path: abs, lockDir: abs + '.lock' + (process.platform === 'win32' ? '\\' : '/'), fromOverride: true };
}

// ---- Canonical root (project checkout) verification ---------------------------
// CWD-independent. Security invariant "outside worktree" áp dụng cho registry
// path / lock path / temp publication / control-plane state (xem
// resolveCanonicalRegistryPath), KHÔNG áp dụng cho project.canonicalRoot.
// canonicalRoot chỉ cần absolute + không symlink/junction escape (không reject
// vì trùng hay nằm dưới process.cwd()).
export function resolveCanonicalRoot(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || !isAbsolute(raw)) {
    return { ok: false, code: 'CANONICAL_ROOT_NOT_ABSOLUTE', errors: [`canonicalRoot phải là absolute path: ${String(raw)}`] };
  }
  const abs = resolve(raw); // normalize (case/volume separators) BEFORE walking
  const { root } = parse(abs);
  const rel = abs.slice(root.length);
  const segs = rel.split(/[\\/]+/).filter(Boolean);
  // Walk EVERY path segment (GPT-REV-141): any symlink/junction/reparse anywhere
  // in the path is a CANONICAL_ROOT_ESCAPE, not just the final component.
  let cur = root;
  for (const seg of segs) {
    cur = join(cur, seg);
    let st;
    try { st = lstatSync(cur); }
    catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
        return { ok: false, code: 'CANONICAL_ROOT_MISSING', errors: [`canonicalRoot không tồn tại: ${raw}`] };
      }
      return { ok: false, code: 'CANONICAL_ROOT_UNREADABLE', errors: [`canonicalRoot not stat-able: ${e.message}`] };
    }
    if (st.isSymbolicLink()) {
      return { ok: false, code: 'CANONICAL_ROOT_ESCAPE', errors: [`path segment '${cur}' là symlink/junction; canonicalRoot không được chứa reparse: ${raw}`] };
    }
  }
  let stFinal;
  try { stFinal = lstatSync(abs); }
  catch (e) {
    if (e.code === 'ENOENT') return { ok: false, code: 'CANONICAL_ROOT_MISSING', errors: [`canonicalRoot không tồn tại: ${raw}`] };
    return { ok: false, code: 'CANONICAL_ROOT_UNREADABLE', errors: [`canonicalRoot not stat-able: ${e.message}`] };
  }
  if (!stFinal.isDirectory()) {
    return { ok: false, code: 'CANONICAL_ROOT_NOT_DIR', errors: [`canonicalRoot phải là directory: ${raw}`] };
  }
  let real;
  try { real = realpathSync(abs); }
  catch (e) { return { ok: false, code: 'CANONICAL_ROOT_UNREADABLE', errors: [`canonicalRoot realpath: ${e.message}`] }; }
  // final realpath must be the path we walked (no hidden reparse resolved to elsewhere
  // while lstat reported false). Realpath normalizes Windows volume/case/long-path.
  return { ok: true, resolved: real, path: abs };
}

// Parse owner/repo từ git remote URL. Chỉ chấp nhận trusted GitHub host
// (GPT-REV-141). Hỗ trợ https://, ssh://, scp-like (git@host:owner/repo).
// Reject credential-bearing userinfo và host khác github.com.
function normalizeGitHost(host) {
  return host.replace(/:/g, '').replace(/^www\./i, '').toLowerCase();
}

function parseRepoFromRemote(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  const s = url.trim().replace(/\.git$/i, '');
  if (!s) return null;
  // scp-like git@github.com:owner/repo (no scheme). Bare username OK, host must be trusted.
  if (!s.includes('://')) {
    const scp = s.match(/^(?:[^@/\s]+@)?([^/:]+):(.+)$/);
    if (scp) {
      const host = normalizeGitHost(scp[1]);
      if (!TRUSTED_GIT_HOSTS.has(host)) return null;
      const parts = scp[2].split('/').filter(Boolean);
      if (parts.length < 2) return null;
      return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`.toLowerCase();
    }
    return null;
  }
  // scheme://host/path — reject credential-bearing userinfo (`user:token@`), but
  // allow a bare ssh username (e.g. `git@`), and only accept trusted GitHub host.
  const m = s.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/\s]+)\/(.+)$/);
  if (m) {
    let hostPort = m[1];
    const at = hostPort.lastIndexOf('@');
    if (at !== -1) {
      const userinfo = hostPort.slice(0, at);
      if (userinfo.includes(':')) return null; // credential-bearing userinfo -> reject
      hostPort = hostPort.slice(at + 1);
    }
    const host = normalizeGitHost(hostPort);
    if (!TRUSTED_GIT_HOSTS.has(host)) return null;
    const parts = m[2].split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`.toLowerCase();
  }
  return null;
}

function gitRemoteMatchesRepository(root, repository) {
  if (typeof repository !== 'string' || !REPO_RE.test(repository)) {
    return { ok: false, errors: [`canonicalRepository không hợp lệ: ${String(repository)}`] };
  }
  let remote = null;
  try {
    remote = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    try {
      const v = execFileSync('git', ['-C', root, 'remote', '-v'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const line = v.split(/\r?\n/).find((l) => /\borigin\b/.test(l));
      if (line) remote = line.replace(/^\S+\s+/, '').split(/\s+/)[0];
    } catch {
      return { ok: false, errors: [`canonicalRoot '${root}' không có git remote origin`] };
    }
  }
  const parsed = parseRepoFromRemote(remote);
  if (!parsed) return { ok: false, errors: [`không parse được remote '${remote}' thành owner/repo`] };
  if (parsed !== repository.toLowerCase()) {
    return { ok: false, errors: [`canonicalRoot '${root}' remote '${parsed}' không khớp canonicalRepository '${repository}'`] };
  }
  return { ok: true };
}

// Onboarding-time check: canonicalRoot absolute, tồn tại, không symlink/junction,
// và (khi verifyRoot) git remote khớp canonicalRepository. Fail-closed.
export function verifyCanonicalRoot(raw, repository, { requireGitRemote = true } = {}) {
  const r = resolveCanonicalRoot(raw);
  if (!r.ok) return r;
  if (requireGitRemote) {
    const m = gitRemoteMatchesRepository(r.resolved, repository);
    if (!m.ok) return { ok: false, code: 'CANONICAL_ROOT_REMOTE_MISMATCH', errors: [m.errors[0]] };
  }
  return { ok: true, resolved: r.resolved, path: r.path };
}


// ---- Canonical serialization + digest -----------------------------------------

export function canonicalStringify(value) {
  return canonicalizeJCS(value);
}

export { runJCSSelfCheck };

export function computeRegistryDigest(data) {
  // Exclude ONLY root-level contentDigest (Issue #17 normative).
  const { contentDigest: _ignored, ...rest } = data;
  void _ignored;
  return crypto.createHash('sha256').update(canonicalizeJCS(rest)).digest('hex');
}

// ---- Read + schema validation -------------------------------------------------

export function readCanonicalRegistry({ registryPath = DEFAULT_CANONICAL_REGISTRY_PATH } = {}) {
  let raw;
  try {
    raw = readFileSync(registryPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, code: 'REGISTRY_MISSING', errors: ['canonical registry chưa được tạo'] };
    }
    return { ok: false, code: 'REGISTRY_UNREADABLE', errors: [err.message] };
  }
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, code: 'REGISTRY_MALFORMED', errors: [`JSON parse fail — ${err.message}`] };
  }
}

// Recursive value-space gate (GPT-REV-124): the registry canonicalizer is RFC 8785
// equivalent ONLY for string/boolean/safe-integer/null/array/object. Any number outside
// [-(2^53)+1, (2^53)-1] — float, NaN, Infinity, out-of-range integer — must be rejected
// before digest/write, anywhere in the document (including project extra properties).
function validateValueSpace(node, errors, path) {
  if (node === null) return;
  const t = typeof node;
  if (t === 'string' || t === 'boolean') return;
  if (t === 'number') {
    if (!Number.isSafeInteger(node)) {
      errors.push(`REGISTRY_VALUE_SPACE: ${path} là number ngoài JCS safe-integer range [-(2^53)+1, (2^53)-1]`);
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => validateValueSpace(v, errors, `${path}[${i}]`));
    return;
  }
  if (t === 'object') {
    for (const [k, v] of Object.entries(node)) validateValueSpace(v, errors, `${path}.${k}`);
    return;
  }
  errors.push(`REGISTRY_VALUE_SPACE: ${path} có type '${t}' không thuộc value space`);
}

export function validateCanonicalRegistry(data, { cwd = process.cwd(), strictDigest = true } = {}) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, code: 'REGISTRY_MALFORMED', errors: ['root phải là object'] };
  }
  validateValueSpace(data, errors, 'root');
  if (data.$schemaVersion !== SUPPORTED_REGISTRY_SCHEMA) {
    errors.push(`REGISTRY_UNSUPPORTED_SCHEMA: hỗ trợ ${SUPPORTED_REGISTRY_SCHEMA}, nhận '${data.$schemaVersion ?? '(missing)'}'`);
  }
  if (typeof data.revision !== 'number' || !Number.isInteger(data.revision) || data.revision < 0) {
    errors.push('REGISTRY_REVISION_INVALID: revision phải là non-negative integer');
  }
  if (typeof data.updatedAt !== 'string' || !data.updatedAt) {
    errors.push('REGISTRY_MISSING_UPDATED_AT');
  }
  if (typeof data.contentDigest !== 'string' || !REGISTRY_DIGEST_RE.test(data.contentDigest)) {
    errors.push('REGISTRY_DIGEST_MISSING_OR_INVALID: contentDigest phải là lowercase hex SHA-256 64 ký tự');
  }
  if (!data.projects || typeof data.projects !== 'object' || Array.isArray(data.projects)) {
    errors.push('REGISTRY_MALFORMED: projects phải là object keyed by projectId');
    return { ok: false, code: 'REGISTRY_MALFORMED', errors };
  }
  const seenProjectIds = new Set();
  const seenRepositories = new Set();
  const seenWorkspaceIds = new Set();
  for (const [pid, p] of Object.entries(data.projects)) {
    if (!PROJECT_ID_RE.test(pid)) {
      errors.push(`REGISTRY_PROJECT_INVALID: project key '${pid}' không phải kebab-case`);
    }
    if (typeof p !== 'object' || p === null) {
      errors.push(`REGISTRY_PROJECT_INVALID: project '${pid}' không phải object`);
      continue;
    }
    if (typeof p.projectId !== 'string' || !p.projectId) {
      errors.push(`REGISTRY_PROJECT_INVALID: project '${pid}' thiếu projectId`);
    } else if (!PROJECT_ID_RE.test(p.projectId)) {
      errors.push(`REGISTRY_PROJECT_INVALID: project '${pid}' projectId không kebab-case`);
    } else if (seenProjectIds.has(p.projectId)) {
      errors.push(`REGISTRY_DUPLICATE_IDENTITY: duplicate projectId '${p.projectId}'`);
    } else {
      seenProjectIds.add(p.projectId);
    }
    if (typeof p.canonicalRepository !== 'string' || !REPO_RE.test(p.canonicalRepository)) {
      errors.push(`REGISTRY_PROJECT_INVALID: project '${pid}' canonicalRepository phải là owner/repo`);
    } else if (seenRepositories.has(p.canonicalRepository)) {
      errors.push(`REGISTRY_DUPLICATE_IDENTITY: duplicate repository '${p.canonicalRepository}'`);
    } else if (/(token|secret|password|apikey|privatekey)/i.test(p.canonicalRepository)) {
      errors.push(`REGISTRY_SECRET: canonicalRepository '${p.canonicalRepository}' chứa secret pattern`);
    } else {
      seenRepositories.add(p.canonicalRepository);
    }
    if (typeof p.canonicalRoot !== 'string' || p.canonicalRoot.length < 3 || !isAbsolute(p.canonicalRoot)) {
      if (p.status !== 'quarantined') {
        errors.push(`REGISTRY_PROJECT_INVALID: project '${pid}' canonicalRoot phải là absolute path`);
      }
    } else {
      try {
        const rst = lstatSync(p.canonicalRoot);
        if (rst.isSymbolicLink()) {
          errors.push(`REGISTRY_PATH_ESCAPE: canonicalRoot '${p.canonicalRoot}' không được là symlink/junction`);
        }
      } catch (e) {
        if (e.code !== 'ENOENT') errors.push(`REGISTRY_PATH_UNREADABLE: canonicalRoot '${p.canonicalRoot}' — ${e.message}`);
      }
    }
    if (typeof p.status !== 'string' || !p.status) {
      errors.push(`REGISTRY_PROJECT_INVALID: project '${pid}' thiếu status`);
    }
    if (typeof p.registeredAt !== 'string' || !p.registeredAt) {
      errors.push(`REGISTRY_PROJECT_INVALID: project '${pid}' thiếu registeredAt`);
    }
    if (!Array.isArray(p.capabilities) || p.capabilities.some((c) => typeof c !== 'string' || !c)) {
      errors.push(`REGISTRY_PROJECT_INVALID: project '${pid}' capabilities phải là mảng string không rỗng`);
    }
    if (p.worktreeRoots !== undefined) {
      if (!Array.isArray(p.worktreeRoots) || p.worktreeRoots.some((w) => typeof w !== 'string' || !w)) {
        errors.push(`REGISTRY_PROJECT_INVALID: project '${pid}' worktreeRoots phải là mảng string`);
      }
    }
    if (p.workspaceId && typeof p.workspaceId === 'string') {
      if (seenWorkspaceIds.has(p.workspaceId)) {
        errors.push(`REGISTRY_DUPLICATE_IDENTITY: duplicate workspaceId '${p.workspaceId}'`);
      } else {
        seenWorkspaceIds.add(p.workspaceId);
      }
    }
  }
  if (strictDigest && data.contentDigest && REGISTRY_DIGEST_RE.test(data.contentDigest)) {
    const computed = computeRegistryDigest(data);
    if (computed !== data.contentDigest) {
      errors.push(`REGISTRY_DIGEST_MISMATCH: computed=${computed}, declared=${data.contentDigest}`);
    }
  }
  return { ok: errors.length === 0, code: errors.length ? 'REGISTRY_INVALID' : 'OK', errors };
}

// ---- Atomic write helpers ------------------------------------------------------

function tryFsync(fd) {
  try { fsyncSync(fd); return { ok: true }; }
  catch (e) {
    if (e.code === 'EPERM' || e.code === 'EINVAL' || e.code === 'ENOTSUP') return { ok: false, skipped: e.code };
    return { ok: false, error: e.message, code: e.code };
  }
}

function fsyncDirOrSkip(dirPath) {
  let fd;
  try {
    fd = openSync(dirPath, 'r');
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'ENOENT') return { ok: false, skipped: e.code };
    return { ok: false, error: e.message, code: e.code };
  }
  const r = tryFsync(fd);
  try { closeSync(fd); } catch { /* ignore */ }
  return r;
}

function tryRename(src, dst) {
  try { renameSync(src, dst); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message, code: e.code }; }
}

// ---- Writer lock (single canonical directory) ---------------------------------

function newOwner() {
  const nonce = randomBytes(16).toString('hex');
  return { nonce, pid: process.pid, ppid: process.ppid, hostname: os.hostname(), startedAt: new Date().toISOString() };
}

function ownerFilePath(lockDir) { return join(lockDir, 'owner.json'); }

export function acquireRegistryLock({ lockDir = DEFAULT_CANONICAL_LOCK_DIR } = {}) {
  const owner = newOwner();
  try {
    mkdirSync(lockDir, { recursive: false });
  } catch (err) {
    if (err.code !== 'EEXIST') return { ok: false, code: 'REGISTRY_LOCK_ERROR', errors: [err.message] };
    let existing = null;
    try { existing = JSON.parse(readFileSync(ownerFilePath(lockDir), 'utf8')); } catch { existing = null; }
    if (!existing || typeof existing.nonce !== 'string' || typeof existing.pid !== 'number') {
      return { ok: false, code: 'REGISTRY_CONCURRENT_MODIFICATION', errors: ['lock owner.json unreadable; cannot determine liveness'] };
    }
    let alive = false;
    try { process.kill(existing.pid, 0); alive = true; } catch { alive = false; }
    if (alive) {
      return { ok: false, code: 'REGISTRY_CONCURRENT_MODIFICATION', errors: [`lock held by live pid ${existing.pid}`] };
    }
    try { rmSync(lockDir, { recursive: true, force: true }); } catch (e) {
      return { ok: false, code: 'REGISTRY_LOCK_ERROR', errors: ['stale lock cannot be removed: ' + e.message] };
    }
    try { mkdirSync(lockDir, { recursive: false }); }
    catch (e) { return { ok: false, code: 'REGISTRY_CONCURRENT_MODIFICATION', errors: ['stale recovery lost a race: ' + e.message] }; }
  }
  const ownerPath = ownerFilePath(lockDir);
  let fd;
  try { fd = openSync(ownerPath, 'wx'); }
  catch (e) {
    try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* swallow */ }
    return { ok: false, code: 'REGISTRY_LOCK_ERROR', errors: ['owner.json create failed: ' + e.message] };
  }
  try {
    writeFileSync(fd, JSON.stringify(owner, null, 2), 'utf8');
    tryFsync(fd);
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
  return { ok: true, lockDir, owner };
}

export function releaseRegistryLock({ lockDir, owner }) {
  if (!lockDir || !owner) return { ok: false, code: 'REGISTRY_LOCK_ERROR', errors: ['missing lockDir/owner'] };
  let current = null;
  try { current = JSON.parse(readFileSync(ownerFilePath(lockDir), 'utf8')); } catch { current = null; }
  if (!current || current.nonce !== owner.nonce) {
    return { ok: false, code: 'REGISTRY_LOCK_OWNER_MISMATCH', errors: ['owner nonce mismatch; refusing to release'] };
  }
  try {
    const ownerPath = ownerFilePath(lockDir);
    try { unlinkSync(ownerPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    try { rmdirSync(lockDir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return { ok: true };
  } catch (e) {
    return { ok: false, code: 'REGISTRY_LOCK_ERROR', errors: ['release failed: ' + e.message] };
  }
}

// ---- Atomic publication: temp + fsync + rename + read-back ---------------------

export function createCanonicalRegistry({ projects = {}, updatedAt = new Date().toISOString(), migration = null, revision = 0 } = {}) {
  const projectsObj = {};
  for (const [pid, p] of Object.entries(projects || {})) {
    projectsObj[pid] = { ...p };
  }
  const root = {
    $schemaVersion: SUPPORTED_REGISTRY_SCHEMA,
    revision,
    updatedAt,
    contentDigest: '0'.repeat(64),
    projects: projectsObj,
  };
  if (migration) root.migration = { ...migration };
  root.contentDigest = computeRegistryDigest(root);
  return root;
}

export function nextRevision(current) {
  return (typeof current?.revision === 'number' ? current.revision : 0) + 1;
}

export function writeCanonicalRegistry({ current = null, next, lockDir = DEFAULT_CANONICAL_LOCK_DIR, registryPath = DEFAULT_CANONICAL_REGISTRY_PATH, owner, expectedRevision, expectedDigest, cwd = process.cwd() } = {}) {
  if (!owner || !owner.nonce) return { ok: false, code: 'REGISTRY_LOCK_REQUIRED', errors: ['must hold lock to write'] };
  let lockOwner = null;
  try { lockOwner = JSON.parse(readFileSync(ownerFilePath(lockDir), 'utf8')); } catch { lockOwner = null; }
  if (!lockOwner || lockOwner.nonce !== owner.nonce) {
    return { ok: false, code: 'REGISTRY_LOCK_OWNER_MISMATCH', errors: ['lock owner changed; aborting'] };
  }
  if (current) {
    if (typeof expectedRevision === 'number' && current.revision !== expectedRevision) {
      return { ok: false, code: 'REGISTRY_CONCURRENT_MODIFICATION', errors: [`expected revision ${expectedRevision}, got ${current.revision}`] };
    }
    if (typeof expectedDigest === 'string' && current.contentDigest !== expectedDigest) {
      return { ok: false, code: 'REGISTRY_CONCURRENT_MODIFICATION', errors: [`expected digest ${expectedDigest}, got ${current.contentDigest}`] };
    }
  }
  // Revision monotonicity (GPT-REV-125): each publish MUST increment by exactly one.
  // First publish (no current) MUST be revision 0. Same/lower/skipped revisions are
  // rejected fail-closed so the revision side of the CAS contract holds.
  if (current) {
    if (typeof next.revision !== 'number' || next.revision !== current.revision + 1) {
      return { ok: false, code: 'REGISTRY_REVISION_NOT_INCREMENTED', errors: [`next.revision ${next.revision} phải bằng current.revision ${current.revision} + 1`] };
    }
  } else if (typeof next.revision !== 'number' || next.revision !== 0) {
    return { ok: false, code: 'REGISTRY_REVISION_NOT_INCREMENTED', errors: ['first publish phải có revision 0'] };
  }
  // Validate next (skip digest check, since we'll set it after cloning).
  const probe = { ...next, contentDigest: '0'.repeat(64) };
  const val = validateCanonicalRegistry(probe, { cwd, strictDigest: false });
  if (!val.ok) return { ok: false, code: val.code, errors: val.errors };
  // Self-check: declared contentDigest must equal computed digest of next.
  if (typeof next.contentDigest !== 'string' || REGISTRY_DIGEST_RE.test(next.contentDigest) === false) {
    return { ok: false, code: 'REGISTRY_DIGEST_MISSING_OR_INVALID', errors: ['next.contentDigest must be lowercase hex SHA-256'] };
  }
  const expected = computeRegistryDigest(next);
  if (expected !== next.contentDigest) {
    return { ok: false, code: 'REGISTRY_DIGEST_MISMATCH', errors: [`declared contentDigest ${next.contentDigest} != computed ${expected}`] };
  }
  const dir = dirname(registryPath);
  try { mkdirSync(dir, { recursive: true }); } catch (e) {
    return { ok: false, code: 'REGISTRY_IO_ERROR', errors: ['mkdir dir: ' + e.message] };
  }
  const bytes = Buffer.from(canonicalizeJCS(next), 'utf8');
  const tempName = '.projects.json.tmp-' + randomBytes(8).toString('hex');
  const tempPath = join(dir, tempName);
  let fd;
  try { fd = openSync(tempPath, 'wx'); }
  catch (e) {
    return { ok: false, code: 'REGISTRY_IO_ERROR', errors: ['temp create (wx) failed: ' + e.message] };
  }
  let writeOk = true;
  try {
    writeFileSync(fd, bytes, 'utf8');
    const r = tryFsync(fd);
    if (!r.ok && r.error) { writeOk = false; }
  } catch { writeOk = false; }
  finally { try { closeSync(fd); } catch { /* ignore */ } }
  if (!writeOk) {
    try { unlinkSync(tempPath); } catch { /* ignore */ }
    return { ok: false, code: 'REGISTRY_IO_ERROR', errors: ['temp write/fsync failed'] };
  }
  const rn = tryRename(tempPath, registryPath);
  if (!rn.ok) {
    try { unlinkSync(tempPath); } catch { /* ignore */ }
    return { ok: false, code: 'REGISTRY_IO_ERROR', errors: ['atomic rename failed: ' + rn.error] };
  }
  fsyncDirOrSkip(dir);
  const rb = readCanonicalRegistry({ registryPath });
  if (!rb.ok) return { ok: false, code: rb.code, errors: ['read-back: ' + rb.errors.join('; ')] };
  if (rb.data.contentDigest !== next.contentDigest) {
    return { ok: false, code: 'REGISTRY_READBACK_DIGEST_MISMATCH', errors: ['read-back digest differs'] };
  }
  if (rb.data.revision !== next.revision) {
    return { ok: false, code: 'REGISTRY_READBACK_REVISION_MISMATCH', errors: ['read-back revision differs'] };
  }
  return { ok: true, data: rb.data };
}

export function commitCanonicalRegistry({ next, lockDir = DEFAULT_CANONICAL_LOCK_DIR, registryPath = DEFAULT_CANONICAL_REGISTRY_PATH } = {}) {
  const acq = acquireRegistryLock({ lockDir });
  if (!acq.ok) return { ok: false, code: acq.code, errors: acq.errors };
  try {
    const cur = existsSync(registryPath) ? readCanonicalRegistry({ registryPath }) : { ok: true, data: null };
    if (!cur.ok) return { ok: false, code: cur.code, errors: cur.errors };
    return writeCanonicalRegistry({
      current: cur.data,
      next,
      lockDir,
      registryPath,
      owner: acq.owner,
      expectedRevision: cur.data ? cur.data.revision : undefined,
      expectedDigest: cur.data ? cur.data.contentDigest : undefined,
    });
  } finally {
    releaseRegistryLock({ lockDir, owner: acq.owner });
  }
}

// ---- Split-brain + legacy migration -------------------------------------------

export function readLegacyRegistry({ legacyPath = LEGACY_REGISTRY_PATH } = {}) {
  if (!existsSync(legacyPath)) return { ok: false, code: 'LEGACY_MISSING', errors: ['legacy registry không tồn tại'] };
  try {
    const data = JSON.parse(readFileSync(legacyPath, 'utf8'));
    return { ok: true, data };
  } catch (e) {
    return { ok: false, code: 'LEGACY_MALFORMED', errors: [e.message] };
  }
}

function legacyToCanonicalShape(legacy) {
  const out = { $schemaVersion: SUPPORTED_REGISTRY_SCHEMA, revision: 0, updatedAt: new Date().toISOString(), contentDigest: '0'.repeat(64), projects: {} };
  if (!Array.isArray(legacy?.projects)) {
    out.contentDigest = computeRegistryDigest(out);
    return out;
  }
  for (const m of legacy.projects) {
    if (!m || typeof m !== 'object') continue;
    const pid = typeof m.projectId === 'string' ? m.projectId : null;
    if (!pid || !PROJECT_ID_RE.test(pid)) continue;
    const entry = {
      projectId: pid,
      canonicalRepository: typeof m.repository === 'string' ? m.repository : '',
      canonicalRoot: '',
      status: 'active',
      registeredAt: new Date().toISOString(),
      capabilities: [],
    };
    if (m.workspace?.workspaceId) entry.workspaceId = String(m.workspace.workspaceId);
    if (m.telegram?.route) entry.telegramRoute = String(m.telegram.route);
    if (m.policy?.version) entry.policyVersion = String(m.policy.version);
    if (m.verify?.adapter) entry.verifyAdapter = String(m.verify.adapter);
    if (m.memory?.namespace) entry.memoryNamespace = String(m.memory.namespace);
    out.projects[pid] = entry;
  }
  out.contentDigest = computeRegistryDigest(out);
  return out;
}

export function detectSplitBrain({ registryPath = DEFAULT_CANONICAL_REGISTRY_PATH, legacyPath = LEGACY_REGISTRY_PATH } = {}) {
  if (!existsSync(legacyPath)) return { ok: true, splitBrain: false };
  let legacyActive = false;
  try {
    const legacy = JSON.parse(readFileSync(legacyPath, 'utf8'));
    legacyActive = Array.isArray(legacy?.projects) && legacy.projects.length > 0;
  } catch { legacyActive = false; }
  if (!legacyActive) return { ok: true, splitBrain: false };
  if (!existsSync(registryPath)) {
    return { ok: false, code: 'REGISTRY_SPLIT_BRAIN', splitBrain: true, errors: ['legacy active nhưng canonical chưa tồn tại'] };
  }
  const canon = readCanonicalRegistry({ registryPath });
  if (!canon.ok) {
    return { ok: false, code: 'REGISTRY_SPLIT_BRAIN', splitBrain: true, errors: ['canonical unreadable nhưng legacy active'] };
  }
  const canonCount = typeof canon.data?.projects === 'object' && !Array.isArray(canon.data.projects)
    ? Object.keys(canon.data.projects).length : 0;
  if (canonCount === 0) {
    return { ok: false, code: 'REGISTRY_SPLIT_BRAIN', splitBrain: true, errors: ['canonical rỗng nhưng legacy active'] };
  }
  const tombPath = legacyPath + '.tombstone.json';
  if (existsSync(tombPath)) {
    try {
      const tomb = JSON.parse(readFileSync(tombPath, 'utf8'));
      if (tomb?.canonicalPath === registryPath
          && tomb?.contentDigest === canon.data.contentDigest
          && tomb?.migrationVersion) {
        return { ok: true, splitBrain: false };
      }
    } catch { /* fall through */ }
  }
  const legacyCanonical = legacyToCanonicalShape(JSON.parse(readFileSync(legacyPath, 'utf8')));
  const legacyDigest = computeRegistryDigest(legacyCanonical);
  if (legacyDigest !== canon.data.contentDigest) {
    return { ok: false, code: 'REGISTRY_SPLIT_BRAIN', splitBrain: true, errors: ['legacy digest differs from canonical; manual reconciliation required'] };
  }
  return { ok: true, splitBrain: false };
}

export function migrateLegacyRegistry({ legacyPath = LEGACY_REGISTRY_PATH, registryPath = DEFAULT_CANONICAL_REGISTRY_PATH, lockDir = DEFAULT_CANONICAL_LOCK_DIR, now = new Date() } = {}) {
  if (!existsSync(legacyPath)) {
    return { ok: false, code: 'LEGACY_PROJECT_NO_ROOT', errors: ['legacy root không tồn tại; không tự fabricate'] };
  }
  const legacy = readLegacyRegistry({ legacyPath });
  if (!legacy.ok) return { ok: false, code: legacy.code, errors: legacy.errors };
  if (existsSync(registryPath)) {
    const sb = detectSplitBrain({ legacyPath, registryPath });
    if (!sb.ok) return { ok: false, code: sb.code, errors: sb.errors };
  }
  const next = legacyToCanonicalShape(legacy.data);
  let needQuarantine = false;
  for (const pid of Object.keys(next.projects)) {
    if (!next.projects[pid].canonicalRoot) {
      next.projects[pid].status = 'quarantined';
      needQuarantine = true;
    }
  }
  next.migration = {
    migratedAt: now.toISOString(),
    source: legacyPath,
    migrationVersion: MIGRATION_CONTRACT_VERSION,
    note: needQuarantine ? 'projects missing canonicalRoot quarantined; supply canonicalRoot and re-register' : 'first-time migration from AI_PR_REVIEWER legacy',
  };
  next.contentDigest = '0'.repeat(64);
  next.contentDigest = computeRegistryDigest(next);
  const acq = acquireRegistryLock({ lockDir });
  if (!acq.ok) return { ok: false, code: acq.code, errors: acq.errors };
  try {
    const cur = existsSync(registryPath) ? readCanonicalRegistry({ registryPath }) : { ok: true, data: null };
    if (!cur.ok) return { ok: false, code: cur.code, errors: cur.errors };
    // GPT-REV-125: monotonic revision. Migration re-publish over existing canonical
    // must increment, not reset to 0 (legacyToCanonicalShape default).
    if (cur.data) next.revision = cur.data.revision + 1;
    const w = writeCanonicalRegistry({
      current: cur.data,
      next,
      lockDir,
      registryPath,
      owner: acq.owner,
    });
    if (!w.ok) return w;
    const tomb = {
      canonicalPath: registryPath,
      contentDigest: w.data.contentDigest,
      migratedAt: now.toISOString(),
      migrationVersion: MIGRATION_CONTRACT_VERSION,
      legacyPath,
    };
    try {
      writeFileSync(legacyPath + '.tombstone.json', JSON.stringify(tomb, null, 2), 'utf8');
    } catch (e) {
      return { ok: true, code: 'MIGRATION_TOMBSTONE_WRITE_FAILED', data: w.data, errors: [e.message] };
    }
    return { ok: true, data: w.data };
  } finally {
    releaseRegistryLock({ lockDir, owner: acq.owner });
  }
}
// ---- Legacy reconciliation (transactional, single sanctioned operation) -------
// Không expose addProject/createTombstone/writeTombstone như caller-facing ops.
// Chỉ sanction khi legacy là verified superset và record chung tương đương
// canonical identity. Mọi conflict/mismatch → REGISTRY_RECONCILIATION_CONFLICT,
// zero mutation.
// Lossless legacy normalization (GPT-REV-142): each array element must produce
// exactly ONE valid normalized record. Malformed entry, duplicate projectId and
// duplicate repository are all rejected fail-closed (never silently dropped).
function legacyNormalizedProjects(legacy) {
  const out = new Map();
  const errors = [];
  const seenPid = new Set();
  const seenRepo = new Set();
  const list = legacy && Array.isArray(legacy.projects) ? legacy.projects : null;
  if (!list) {
    return { ok: false, errors: ['legacy.projects phải là array'], norms: out };
  }
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      errors.push(`legacy.projects[${i}] malformed (not object)`);
      continue;
    }
    const pid = typeof m.projectId === 'string' ? m.projectId : null;
    if (!pid || !PROJECT_ID_RE.test(pid)) {
      errors.push(`legacy.projects[${i}] projectId không hợp lệ`);
      continue;
    }
    const repo = typeof m.repository === 'string' ? m.repository : '';
    if (!repo || !REPO_RE.test(repo)) {
      errors.push(`legacy.projects[${i}] repository không hợp lệ`);
      continue;
    }
    if (seenPid.has(pid)) {
      errors.push(`REGISTRY_DUPLICATE_IDENTITY: legacy duplicate projectId '${pid}'`);
      continue;
    }
    seenPid.add(pid);
    const repoKey = repo.toLowerCase();
    if (seenRepo.has(repoKey)) {
      errors.push(`REGISTRY_DUPLICATE_IDENTITY: legacy duplicate repository '${repo}'`);
      continue;
    }
    seenRepo.add(repoKey);
    out.set(pid, {
      projectId: pid,
      canonicalRepository: repo,
      workspaceId: typeof m.workspace?.workspaceId === 'string' ? String(m.workspace.workspaceId) : undefined,
      telegramRoute: typeof m.telegram?.route === 'string' ? String(m.telegram.route) : undefined,
      policyVersion: typeof m.policy?.version === 'string' ? String(m.policy.version) : undefined,
      verifyAdapter: typeof m.verify?.adapter === 'string' ? String(m.verify.adapter) : undefined,
      memoryNamespace: typeof m.memory?.namespace === 'string' ? String(m.memory.namespace) : undefined,
    });
  }
  return { ok: errors.length === 0, errors, norms: out };
}

function verifyReconciliation(legacyNorms, canonProjects) {
  const errors = [];
  const repoOwner = new Map();
  for (const [pid, p] of Object.entries(canonProjects)) {
    const repo = p.canonicalRepository;
    if (typeof repo !== 'string' || !REPO_RE.test(repo)) {
      errors.push(`project '${pid}' canonicalRepository không hợp lệ`);
      continue;
    }
    if (repoOwner.has(repo)) errors.push(`REGISTRY_DUPLICATE_IDENTITY: repository '${repo}' trùng giữa '${repoOwner.get(repo)}' và '${pid}'`);
    else repoOwner.set(repo, pid);
  }
  for (const [pid, p] of Object.entries(canonProjects)) {
    const l = legacyNorms.get(pid);
    if (!l) { errors.push(`project '${pid}' không có trong legacy; không phải verified superset`); continue; }
    if (l.canonicalRepository !== p.canonicalRepository) {
      errors.push(`project '${pid}' legacy repo '${l.canonicalRepository}' != canonical repo '${p.canonicalRepository}'`);
    }
  }
  for (const [pid, l] of legacyNorms) {
    if (canonProjects[pid]) continue;
    if (repoOwner.has(l.canonicalRepository)) {
      errors.push(`REGISTRY_DUPLICATE_IDENTITY: repository '${l.canonicalRepository}' trùng giữa '${repoOwner.get(l.canonicalRepository)}' và '${pid}'`);
    } else {
      repoOwner.set(l.canonicalRepository, pid);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

function buildReconciledEntry(l, canonicalRoot, now) {
  const entry = {
    projectId: l.projectId,
    canonicalRepository: l.canonicalRepository,
    canonicalRoot,
    status: 'active',
    registeredAt: now.toISOString(),
    capabilities: [],
  };
  if (l.workspaceId) entry.workspaceId = l.workspaceId;
  if (l.telegramRoute) entry.telegramRoute = l.telegramRoute;
  if (l.policyVersion) entry.policyVersion = l.policyVersion;
  if (l.verifyAdapter) entry.verifyAdapter = l.verifyAdapter;
  if (l.memoryNamespace) entry.memoryNamespace = l.memoryNamespace;
  return entry;
}

function buildReconciledNext(canonData, legacyNorms, roots, now) {
  const next = { ...canonData, projects: { ...canonData.projects } };
  const errors = [];
  for (const [pid, l] of legacyNorms) {
    if (next.projects[pid]) continue;
    const rootRaw = roots[pid];
    if (typeof rootRaw !== 'string' || !rootRaw) {
      errors.push(`project '${pid}' thiếu canonicalRoot để thêm vào canonical; cung cấp qua roots`);
      continue;
    }
    // GPT-REV-141: production reconciliation ALWAYS verifies root + git remote (no verifyRoot=false).
    const vr = verifyCanonicalRoot(rootRaw, l.canonicalRepository);
    if (!vr.ok) { errors.push(vr.errors[0]); continue; }
    next.projects[pid] = buildReconciledEntry(l, vr.resolved, now);
  }
  if (errors.length) return { ok: false, errors };
  next.revision = canonData.revision + 1;
  next.updatedAt = now.toISOString();
  next.contentDigest = computeRegistryDigest(next);
  return { ok: true, next };
}

function tombstoneFor(data, registryPath, legacyPath, now, owner, legacyDigest) {
  void owner;
  return {
    canonicalPath: registryPath,
    contentDigest: data.contentDigest,
    legacyDigest,
    migratedAt: now.toISOString(),
    migrationVersion: MIGRATION_CONTRACT_VERSION,
    legacyPath,
    reconcile: true,
  };
}

function tombstoneEqual(a, b) {
  return a.canonicalPath === b.canonicalPath
    && a.contentDigest === b.contentDigest
    && a.legacyDigest === b.legacyDigest
    && a.migrationVersion === b.migrationVersion
    && a.legacyPath === b.legacyPath
    && a.reconcile === b.reconcile;
}

// GPT-REV-140: tombstone publication atomic + no-clobber. Same-dir temp + fsync +
// atomic rename + read-back. Identical existing tombstone => idempotent success;
// malformed/conflicting tombstone => fail-closed (never overwrite).
function writeTombstoneAtomic(tombstone, tombPath) {
  if (existsSync(tombPath)) {
    let st;
    try { st = lstatSync(tombPath); } catch { /* fall to io */ }
    if (!st || st.isDirectory() || (!st.isFile() && !st.isSymbolicLink())) {
      return { ok: false, io: true, errors: [`tombstone path '${tombPath}' tồn tại nhưng không phải file; refuse to clobber`] };
    }
    let existing;
    try { existing = JSON.parse(readFileSync(tombPath, 'utf8')); }
    catch { return { ok: false, io: false, conflict: true, errors: ['tombstone tồn tại nhưng malformed; fail-closed, không overwrite'] }; }
    if (tombstoneEqual(existing, tombstone)) return { ok: true, exists: true, data: existing };
    return { ok: false, io: false, conflict: true, errors: ['tombstone tồn tại với nội dung khác; fail-closed, không overwrite'] };
  }
  const dir = dirname(tombPath);
  const tempName = '.tombstone.json.tmp-' + randomBytes(8).toString('hex');
  const tempPath = join(dir, tempName);
  const bytes = Buffer.from(JSON.stringify(tombstone, null, 2), 'utf8');
  let fd;
  try { fd = openSync(tempPath, 'wx'); }
  catch (e) { return { ok: false, io: true, errors: ['tombstone temp create (wx) failed: ' + e.message] }; }
  let writeOk = true;
  try {
    writeFileSync(fd, bytes, 'utf8');
    const r = tryFsync(fd);
    if (!r.ok && r.error) writeOk = false;
  } catch { writeOk = false; }
  finally { try { closeSync(fd); } catch { /* ignore */ } }
  if (!writeOk) {
    try { unlinkSync(tempPath); } catch { /* ignore */ }
    return { ok: false, io: true, errors: ['tombstone temp write/fsync failed'] };
  }
  const rn = tryRename(tempPath, tombPath);
  if (!rn.ok) {
    try { unlinkSync(tempPath); } catch { /* ignore */ }
    return { ok: false, io: true, errors: ['tombstone atomic rename failed: ' + rn.error] };
  }
  fsyncDirOrSkip(dir);
  let rb;
  try { rb = JSON.parse(readFileSync(tombPath, 'utf8')); }
  catch (e) { return { ok: false, io: true, errors: ['tombstone read-back parse failed: ' + e.message] }; }
  if (rb.contentDigest !== tombstone.contentDigest || rb.legacyDigest !== tombstone.legacyDigest) {
    return { ok: false, io: true, errors: ['tombstone read-back digest mismatch'] };
  }
  return { ok: true, data: rb };
}


function reconcileLegacyRegistryImpl(opts, { write }) {
  const {
    legacyPath = LEGACY_REGISTRY_PATH,
    registryPath = DEFAULT_CANONICAL_REGISTRY_PATH,
    lockDir = DEFAULT_CANONICAL_LOCK_DIR,
    roots = {},
    now = new Date(),
  } = opts || {};

  const acq = acquireRegistryLock({ lockDir });
  if (!acq.ok) return { ok: false, code: acq.code, errors: acq.errors };
  try {
    if (!existsSync(registryPath)) {
      return { ok: false, code: 'REGISTRY_MISSING', errors: ['canonical chưa tồn tại; không thể reconcile với legacy active'] };
    }
    const canon = readCanonicalRegistry({ registryPath });
    if (!canon.ok) return { ok: false, code: canon.code, errors: canon.errors };
    const vCanon = validateCanonicalRegistry(canon.data, { strictDigest: true });
    if (!vCanon.ok) return { ok: false, code: 'REGISTRY_INVALID', errors: vCanon.errors };

    const legacy = readLegacyRegistry({ legacyPath });
    if (!legacy.ok) return { ok: false, code: legacy.code, errors: legacy.errors };
    // Digest of the EXACT legacy bytes reconciled (GPT-REV-142-3).
    const legacyBytes = readFileSync(legacyPath);
    const legacyDigest = crypto.createHash('sha256').update(legacyBytes).digest('hex');

    const norm = legacyNormalizedProjects(legacy.data);
    if (!norm.ok) return { ok: false, code: 'REGISTRY_RECONCILIATION_CONFLICT', errors: norm.errors };
    const legacyNorms = norm.norms;
    if (legacyNorms.size === 0) {
      return { ok: false, code: 'REGISTRY_RECONCILIATION_CONFLICT', errors: ['legacy không có project hợp lệ; không có gì để thêm'] };
    }

    const ver = verifyReconciliation(legacyNorms, canon.data.projects);
    if (!ver.ok) return { ok: false, code: 'REGISTRY_RECONCILIATION_CONFLICT', errors: ver.errors };

    const tombPath = legacyPath + '.tombstone.json';
    const missing = [...legacyNorms].filter(([pid]) => !canon.data.projects[pid]);
    const needsPublish = missing.length > 0;

    const candidate = needsPublish ? buildReconciledNext(canon.data, legacyNorms, roots, now) : null;
    if (needsPublish && !candidate.ok) {
      return { ok: false, code: 'REGISTRY_RECONCILIATION_CONFLICT', errors: candidate.errors };
    }
    const candidateDigest = needsPublish ? candidate.next.contentDigest : canon.data.contentDigest;

    // GPT-REV-140: inspect tombstone BEFORE publishing to guarantee zero mutation on
    // conflict. A matching file tombstone is an idempotent success; a conflicting /
    // malformed file tombstone is fail-closed with no canonical/legacy/tombstone change.
    if (existsSync(tombPath)) {
      let st;
      try { st = lstatSync(tombPath); } catch { st = null; }
      if (st && st.isFile()) {
        let existing;
        try { existing = JSON.parse(readFileSync(tombPath, 'utf8')); }
        catch { return { ok: false, code: 'RECONCILIATION_TOMBSTONE_CONFLICT', published: false, errors: ['tombstone malformed; fail-closed'] }; }
        const match = existing.canonicalPath === registryPath
          && existing.legacyPath === legacyPath
          && existing.migrationVersion === MIGRATION_CONTRACT_VERSION
          && existing.reconcile === true
          && existing.contentDigest === candidateDigest
          && existing.legacyDigest === legacyDigest;
        if (match) {
          return { ok: true, data: canon.data, tombstone: existing, published: false };
        }
        return { ok: false, code: 'RECONCILIATION_TOMBSTONE_CONFLICT', published: false, errors: ['tombstone tồn tại với nội dung khác; fail-closed, không overwrite'] };
      }
    }

    // Publish canonical if legacy is a verified superset with new records.
    let canonicalData = canon.data;
    let published = false;
    if (needsPublish) {
      const w = write({
        current: canon.data,
        next: candidate.next,
        lockDir,
        registryPath,
        owner: acq.owner,
        expectedRevision: canon.data.revision,
        expectedDigest: canon.data.contentDigest,
      });
      if (!w.ok) return { ok: false, code: w.code, errors: w.errors };
      // GPT-REV-139: ALWAYS re-read canonical from disk (never trust w.data).
      const rb = readCanonicalRegistry({ registryPath });
      if (!rb.ok) {
        return { ok: false, code: rb.code, published: true, data: candidate.next, errors: ['read-back: ' + rb.errors.join('; ')] };
      }
      if (rb.data.revision !== candidate.next.revision) {
        return { ok: false, code: 'REGISTRY_READBACK_REVISION_MISMATCH', published: true, data: candidate.next, errors: [`read-back revision ${rb.data.revision} != expected ${candidate.next.revision}`] };
      }
      if (rb.data.contentDigest !== candidate.next.contentDigest) {
        return { ok: false, code: 'REGISTRY_READBACK_DIGEST_MISMATCH', published: true, data: candidate.next, errors: [`read-back digest ${rb.data.contentDigest} != expected ${candidate.next.contentDigest}`] };
      }
      const vrb = validateCanonicalRegistry(rb.data, { strictDigest: true });
      if (!vrb.ok) {
        return { ok: false, code: 'REGISTRY_INVALID', published: true, data: candidate.next, errors: ['read-back canonical không hợp lệ: ' + vrb.errors.join('; ')] };
      }
      canonicalData = rb.data;
      published = true;
    }

    // Write verified legacy tombstone (atomic, idempotent, no-clobber).
    const tomb = tombstoneFor(canonicalData, registryPath, legacyPath, now, acq.owner, legacyDigest);
    const tw = writeTombstoneAtomic(tomb, tombPath);
    if (!tw.ok) {
      if (tw.conflict) {
        return { ok: false, code: 'RECONCILIATION_TOMBSTONE_CONFLICT', published, data: published ? canonicalData : undefined, errors: tw.errors };
      }
      return { ok: false, code: 'RECONCILIATION_TOMBSTONE_WRITE_FAILED', published, data: published ? canonicalData : undefined, errors: tw.errors };
    }
    return { ok: true, data: canonicalData, tombstone: tw.data, published };
  } finally {
    releaseRegistryLock({ lockDir, owner: acq.owner });
  }
}

export function reconcileLegacyRegistry(options = {}) {
  return reconcileLegacyRegistryImpl(options, { write: writeCanonicalRegistry });
}

// Test-only internal boundary (non-public). NOT part of the reconcileLegacyRegistry
// public options; used to inject a writer to simulate publish/read-back behaviour.
export const __internal = Object.freeze({
  reconcileLegacyRegistry: (opts, deps = {}) => reconcileLegacyRegistryImpl(opts, { write: deps.write ?? writeCanonicalRegistry }),
});







