// reconcile-engine.mjs — Legacy reconciliation engine for registry-storage.mjs.
//
// SHIPPED as an internal dependency of registry-storage.mjs (the artifact must resolve the
// import), but the injectable entry `reconcileLegacyInternal` is NOT re-exported by any
// public entry point and NOT listed in the package `exports` map, so consumers of
// @soc/project-registry cannot reach the dependency-injection seam (REV-146). The injectable
// deps (write / writeTombstone / readLegacyBytes) let tests drive canonical publish, tombstone
// atomicity and legacy-drift windows without exposing a test hook on the public surface.
import {
  readFileSync, existsSync, lstatSync, openSync, closeSync, fsyncSync, unlinkSync, renameSync, writeFileSync,
} from 'node:fs';
import { dirname, join, parse, isAbsolute } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  validateCanonicalRegistry, readCanonicalRegistry, acquireRegistryLock, releaseRegistryLock,
  computeRegistryDigest, verifyCanonicalRoot, writeCanonicalRegistry,
  MIGRATION_CONTRACT_VERSION, LEGACY_REGISTRY_PATH,
  DEFAULT_CANONICAL_REGISTRY_PATH, DEFAULT_CANONICAL_LOCK_DIR, REPO_RE, PROJECT_ID_RE,
} from './registry-storage.mjs';

// ---- Atomic-write helpers (duplicated; the canonical write path in registry-storage.mjs
//      ships its own copies, so neither module leaks internals to the other) ----

function tryFsync(fd) {
  try { fsyncSync(fd); return { ok: true }; }
  catch (e) {
    if (e.code === 'EPERM' || e.code === 'EINVAL' || e.code === 'ENOTSUP') return { ok: false, skipped: e.code };
    return { ok: false, error: e.message, code: e.code };
  }
}

function fsyncDirOrSkip(dirPath) {
  let fd;
  try { fd = openSync(dirPath, 'r'); }
  catch (e) {
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

// REV-145: read the exact legacy bytes once; hash/parse/validate from that snapshot.
function readLegacyBytesDefault({ legacyPath = LEGACY_REGISTRY_PATH } = {}) {
  try { return { ok: true, bytes: readFileSync(legacyPath) }; }
  catch (e) { return { ok: false, code: e.code === 'ENOENT' ? 'LEGACY_MISSING' : 'LEGACY_UNREADABLE', errors: [e.message] }; }
}

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }
// ---- Lossless legacy normalization (GPT-REV-142) ------------------------------
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

// REV-144: walk every path segment; any symlink/junction/reparse is an escape, so the
// tombstone cannot be created/renamed into a redirected location.
function assertNoReparseSegments(p) {
  if (!isAbsolute(p)) return { ok: false, code: 'RECONCILIATION_TOMBSTONE_PATH_ESCAPE', errors: ['tombstone directory phải là absolute'] };
  const { root } = parse(p);
  const segs = (p.slice(root.length)).split(/[\\/]+/).filter(Boolean);
  let cur = root;
  for (const seg of segs) {
    cur = join(cur, seg);
    let st;
    try { st = lstatSync(cur); } catch { continue; } // segment not yet created -> not a reparse
    if (st.isSymbolicLink()) {
      return { ok: false, code: 'RECONCILIATION_TOMBSTONE_PATH_ESCAPE', errors: [`path segment '${cur}' là symlink/junction; refuse to write tombstone`] };
    }
  }
  return { ok: true };
}
function reconcileLegacyRegistryImpl(opts = {}, deps = {}) {
  const {
    legacyPath = LEGACY_REGISTRY_PATH,
    registryPath = DEFAULT_CANONICAL_REGISTRY_PATH,
    lockDir = DEFAULT_CANONICAL_LOCK_DIR,
    roots = {},
    now = new Date(),
  } = opts;
  const { write, writeTombstone, readLegacyBytes } = deps;
  if (!write || !writeTombstone || !readLegacyBytes) {
    return { ok: false, code: 'REGISTRY_RECONCILIATION_DEPS', errors: ['missing injectable deps'] };
  }

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

    // GPT-REV-145: read the exact legacy bytes ONCE; hash, parse and validate from that
    // same snapshot so the digest always binds the bytes we validated.
    const lb0 = readLegacyBytes({ legacyPath });
    if (!lb0.ok) return { ok: false, code: lb0.code, errors: lb0.errors };
    const legacyBytes = lb0.bytes;
    const legacyDigest = sha256(legacyBytes);
    let legacyData;
    try { legacyData = JSON.parse(legacyBytes.toString('utf8')); }
    catch (e) { return { ok: false, code: 'LEGACY_MALFORMED', errors: [`legacy JSON parse fail (cùng snapshot bytes): ${e.message}`] }; }

    const norm = legacyNormalizedProjects(legacyData);
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

    // GPT-REV-144: per-segment escape on the tombstone target directory BEFORE any write.
    const seg = assertNoReparseSegments(dirname(tombPath));
    if (!seg.ok) return { ok: false, code: seg.code, published: false, errors: seg.errors };

    // GPT-REV-143/144: preflight tombstone before canonical publication.
    //  - non-regular-file (dir/symlink/junction/reparse/special) -> fail-closed, published:false.
    //  - malformed -> fail-closed.
    //  - idempotent ONLY when canonical is ALREADY a superset (needsPublish=false) AND the
    //    tombstone matches the CURRENT canonical digest/content + legacy bytes digest.
    //    When needsPublish=true a pre-existing tombstone is an inconsistent half-migrated
    //    state -> fail-closed (never use a candidate future digest to confirm publication).
    if (existsSync(tombPath)) {
      let st;
      try { st = lstatSync(tombPath); } catch { st = null; }
      if (!st || !st.isFile()) {
        const kind = !st ? 'unreadable' : st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symlink/junction' : 'special';
        return { ok: false, code: 'RECONCILIATION_TOMBSTONE_CONFLICT', published: false, errors: [`tombstone path '${tombPath}' tồn tại nhưng là ${kind}; fail-closed, không overwrite`] };
      }
      let existing;
      try { existing = JSON.parse(readFileSync(tombPath, 'utf8')); }
      catch { return { ok: false, code: 'RECONCILIATION_TOMBSTONE_CONFLICT', published: false, errors: ['tombstone tồn tại nhưng malformed; fail-closed, không overwrite'] }; }
      const match = existing.canonicalPath === registryPath
        && existing.legacyPath === legacyPath
        && existing.migrationVersion === MIGRATION_CONTRACT_VERSION
        && existing.reconcile === true
        && existing.contentDigest === canon.data.contentDigest
        && existing.legacyDigest === legacyDigest;
      if (!needsPublish && match) {
        return { ok: true, data: canon.data, tombstone: existing, published: false };
      }
      return { ok: false, code: 'RECONCILIATION_TOMBSTONE_CONFLICT', published: false, errors: [`tombstone pre-exists khi needsPublish=${needsPublish} hoặc không khớp current canonical digest/content; fail-closed, không overwrite`] };
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

    // GPT-REV-145: re-read legacy right before tombstone publication and compare digest.
    //  - drift before canonical publish (published=false) -> zero mutation.
    //  - drift after canonical publish (published=true) -> published:true recovery state, no tombstone.
    const lb1 = readLegacyBytes({ legacyPath });
    if (!lb1.ok) {
      return { ok: false, code: 'RECONCILIATION_LEGACY_DRIFT', published, data: published ? canonicalData : undefined, errors: ['legacy re-read failed: ' + lb1.errors.join('; ')] };
    }
    if (sha256(lb1.bytes) !== legacyDigest) {
      if (published) {
        return { ok: false, code: 'RECONCILIATION_LEGACY_DRIFT', published: true, data: canonicalData, errors: ['legacy drifted sau canonical publish; recovery state, không ghi tombstone'] };
      }
      return { ok: false, code: 'RECONCILIATION_LEGACY_DRIFT', published: false, errors: ['legacy drifted trước canonical publish; zero mutation'] };
    }

    // Write verified legacy tombstone (atomic, idempotent, no-clobber).
    const tomb = tombstoneFor(canonicalData, registryPath, legacyPath, now, acq.owner, legacyDigest);
    const tw = writeTombstone(tomb, tombPath);
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

// Test-only injectable engine (not exported by the shipped registry-storage.mjs).
// Public callers are served by registry-storage.mjs which wires the real deps.
export function reconcileLegacyInternal(opts = {}, deps = {}) {
  return reconcileLegacyRegistryImpl(opts, {
    write: deps.write ?? writeCanonicalRegistry,
    writeTombstone: deps.writeTombstone ?? writeTombstoneAtomic,
    readLegacyBytes: deps.readLegacyBytes ?? readLegacyBytesDefault,
  });
}
