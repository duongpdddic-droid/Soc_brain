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
  openSync, closeSync, fsyncSync, unlinkSync, rmSync, rmdirSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, join } from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { canonicalizeJCS, runJCSSelfCheck } from './canonical-jcs.mjs';

export const SUPPORTED_REGISTRY_SCHEMA = '1.0.0';
export const MIGRATION_CONTRACT_VERSION = '1.0.0';
export const REGISTRY_DIGEST_RE = /^[0-9a-f]{64}$/;
export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const PROJECT_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
    if (typeof p.canonicalRoot !== 'string' || p.canonicalRoot.length < 3) {
      if (p.status !== 'quarantined') {
        errors.push(`REGISTRY_PROJECT_INVALID: project '${pid}' thiếu canonicalRoot`);
      }
    } else {
      try {
        const rst = lstatSync(p.canonicalRoot);
        if (rst.isSymbolicLink()) {
          errors.push(`REGISTRY_PATH_ESCAPE: canonicalRoot '${p.canonicalRoot}' không được là symlink`);
        }
      } catch (e) {
        if (e.code !== 'ENOENT') errors.push(`REGISTRY_PATH_UNREADABLE: canonicalRoot '${p.canonicalRoot}' — ${e.message}`);
      }
      const r = relative(cwd, p.canonicalRoot);
      if (r === '' || (!r.startsWith('..') && !isAbsolute(r))) {
        errors.push(`REGISTRY_PATH_INSIDE_WORKTREE: canonicalRoot '${p.canonicalRoot}' nằm trong worktree`);
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





