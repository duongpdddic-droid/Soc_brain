// reconcile-engine.mjs - Production legacy reconciliation for registry-storage.mjs.
//
// SHIPPED. Exports ONLY `reconcileLegacyRegistry`, hard-bound to the real canonical
// writer, the real tombstone writer and the real legacy reader. It does NOT export any
// dependency-injection entry: a caller of the shipped artifact cannot inject `write`,
// `writeTombstone` or `readLegacyBytes` (REV-147). The injectable variant used by tests
// lives in the test-only module `test/reconcile-inject.mjs`, outside `packages/`.
import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  validateCanonicalRegistry, readCanonicalRegistry, acquireRegistryLock, releaseRegistryLock,
  writeCanonicalRegistry,
  MIGRATION_CONTRACT_VERSION, LEGACY_REGISTRY_PATH,
  DEFAULT_CANONICAL_REGISTRY_PATH, DEFAULT_CANONICAL_LOCK_DIR,
  sha256, legacyNormalizedProjects, verifyReconciliation,
  buildReconciledNext, tombstoneFor, assertNoReparseSegments,
  writeTombstoneAtomic, readLegacyBytesDefault,
} from './registry-core.mjs';

const REAL_IO = {
  write: writeCanonicalRegistry,
  writeTombstone: writeTombstoneAtomic,
  readLegacyBytes: readLegacyBytesDefault,
};

function reconcileLegacyRegistryImpl(opts = {}, io = REAL_IO) {
  const {
    legacyPath = LEGACY_REGISTRY_PATH,
    registryPath = DEFAULT_CANONICAL_REGISTRY_PATH,
    lockDir = DEFAULT_CANONICAL_LOCK_DIR,
    roots = {},
    now = new Date(),
  } = opts;
  const { write, writeTombstone, readLegacyBytes } = io;
  if (!write || !writeTombstone || !readLegacyBytes) {
    return { ok: false, code: 'REGISTRY_RECONCILIATION_DEPS', errors: ['missing io deps'] };
  }

  const acq = acquireRegistryLock({ lockDir });
  if (!acq.ok) return { ok: false, code: acq.code, errors: acq.errors };
  try {
    if (!existsSync(registryPath)) {
      return { ok: false, code: 'REGISTRY_MISSING', errors: ['canonical chua ton tai; khong the reconcile voi legacy active'] };
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
    catch (e) { return { ok: false, code: 'LEGACY_MALFORMED', errors: [`legacy JSON parse fail (cung snapshot bytes): ${e.message}`] }; }

    const norm = legacyNormalizedProjects(legacyData);
    if (!norm.ok) return { ok: false, code: 'REGISTRY_RECONCILIATION_CONFLICT', errors: norm.errors };
    const legacyNorms = norm.norms;
    if (legacyNorms.size === 0) {
      return { ok: false, code: 'REGISTRY_RECONCILIATION_CONFLICT', errors: ['legacy khong co project hop le; khong co gi de them'] };
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
    if (existsSync(tombPath)) {
      let st;
      try { st = lstatSync(tombPath); } catch { st = null; }
      if (!st || !st.isFile()) {
        const kind = !st ? 'unreadable' : st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symlink/junction' : 'special';
        return { ok: false, code: 'RECONCILIATION_TOMBSTONE_CONFLICT', published: false, errors: [`tombstone path '${tombPath}' ton tai nhung la ${kind}; fail-closed, khong overwrite`] };
      }
      let existing;
      try { existing = JSON.parse(readFileSync(tombPath, 'utf8')); }
      catch { return { ok: false, code: 'RECONCILIATION_TOMBSTONE_CONFLICT', published: false, errors: ['tombstone pre-exists nhung malformed; fail-closed, khong overwrite'] }; }
      const match = existing.canonicalPath === registryPath
        && existing.contentDigest === canon.data.contentDigest
        && existing.legacyDigest === legacyDigest
        && existing.migrationVersion === MIGRATION_CONTRACT_VERSION
        && existing.legacyPath === legacyPath
        && existing.reconcile === true;
      if (!needsPublish && match) {
        return { ok: true, data: canon.data, tombstone: existing, published: false };
      }
      return { ok: false, code: 'RECONCILIATION_TOMBSTONE_CONFLICT', published: false, errors: [`tombstone pre-exists khi needsPublish=${needsPublish} hoac khong khop current canonical digest/content; fail-closed, khong overwrite`] };
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
        return { ok: false, code: 'REGISTRY_INVALID', published: true, data: candidate.next, errors: ['read-back canonical khong hop le: ' + vrb.errors.join('; ')] };
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
        return { ok: false, code: 'RECONCILIATION_LEGACY_DRIFT', published: true, data: canonicalData, errors: ['legacy drifted sau canonical publish; recovery state, khong ghi tombstone'] };
      }
      return { ok: false, code: 'RECONCILIATION_LEGACY_DRIFT', published: false, errors: ['legacy drifted truoc canonical publish; zero mutation'] };
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

export function reconcileLegacyRegistry(options = {}) {
  return reconcileLegacyRegistryImpl(options, REAL_IO);
}