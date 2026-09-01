// registry-storage.mjs - Canonical Project Registry public surface (Soc_brain Issue #17).
//
// Facade: re-exports the shared canon/legacy primitives (owned by registry-core.mjs) and
// the production `reconcileLegacyRegistry` (owned by reconcile-engine.mjs). Kept as the
// historical import path so existing consumers/tests stay source-compatible. Neither
// registry-storage.mjs nor registry-core.mjs exports any dependency-injection entry.
export {
  SUPPORTED_REGISTRY_SCHEMA, MIGRATION_CONTRACT_VERSION, REGISTRY_DIGEST_RE, REPO_RE, PROJECT_ID_RE,
  TRUSTED_GIT_HOSTS, DEFAULT_CANONICAL_REGISTRY_DIR, DEFAULT_CANONICAL_REGISTRY_PATH, DEFAULT_CANONICAL_LOCK_DIR,
  LEGACY_REGISTRY_PATH, LEGACY_TOMBSTONE_PATH,
  resolveCanonicalRegistryPath, resolveCanonicalRoot, verifyCanonicalRoot, canonicalStringify,
  computeRegistryDigest, readCanonicalRegistry, validateCanonicalRegistry, acquireRegistryLock, releaseRegistryLock,
  createCanonicalRegistry, nextRevision, writeCanonicalRegistry, commitCanonicalRegistry,
  readLegacyRegistry, detectSplitBrain, migrateLegacyRegistry, runJCSSelfCheck,
} from './registry-core.mjs';
export { reconcileLegacyRegistry } from './reconcile-engine.mjs';
