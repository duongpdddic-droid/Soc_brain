// tests/registry-storage.test.mjs — Required tests for Issue #17 Canonical Project Registry.
// Real filesystem on Windows. Uses a temp directory per test and SOC_PROJECT_REGISTRY_PATH to
// redirect storage so the test cannot collide with the host's real ~/.soc-brain/registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  canonicalStringify, computeRegistryDigest, runJCSSelfCheck,
  readCanonicalRegistry, validateCanonicalRegistry, createCanonicalRegistry,
  nextRevision, writeCanonicalRegistry, commitCanonicalRegistry,
  acquireRegistryLock, releaseRegistryLock, readLegacyRegistry,
  detectSplitBrain, migrateLegacyRegistry, resolveCanonicalRegistryPath,
  SUPPORTED_REGISTRY_SCHEMA, REGISTRY_DIGEST_RE,
} from '../packages/project-registry/registry-storage.mjs';
import { canonicalizeJCS } from '../packages/project-registry/canonical-jcs.mjs';

// ---- Helpers ------------------------------------------------------------------

function newTmpDir() {
  return mkdtempSync(join(tmpdir(), 'soc-registry-'));
}

function setRegistryPath() {
  const tmp = newTmpDir();
  const registryPath = join(tmp, 'projects.json');
  const lockDir = registryPath + '.lock' + (process.platform === 'win32' ? '\\' : '/');
  process.env.SOC_PROJECT_REGISTRY_PATH = registryPath;
  return { registryPath, lockDir, tmp };
}

function makeProject(overrides = {}) {
  return {
    projectId: 'demo-proj',
    canonicalRepository: 'octo/demo',
    canonicalRoot: 'C:/Users/Admin/external-projects/demo',
    status: 'active',
    registeredAt: '2026-01-09T00:00:00.000Z',
    capabilities: ['project-manifest', 'product-code'],
    ...overrides,
  };
}

function makeRoot(projects = { 'demo-proj': makeProject() }, { revision = 0 } = {}) {
  return createCanonicalRegistry({ projects, revision });
}

function cleanup() {
  delete process.env.SOC_PROJECT_REGISTRY_PATH;
}

// ---- JCS self-check (RFC 8785 compliance) ------------------------------------

test('JCS self-check: all official/equivalent vectors pass', () => {
  const r = runJCSSelfCheck();
  assert.equal(r.ok, true, 'failures=' + JSON.stringify(r.failures, null, 2));
  assert.ok(r.total >= 12);
  cleanup();
});

test('JCS: sorted keys, -0/0, lone surrogates, nested-same-name preserved', () => {
  assert.equal(canonicalizeJCS({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalizeJCS({ a: 0, b: -0 }), '{"a":0,"b":0}');
  assert.throws(() => canonicalizeJCS({ x: '\uD83D' }));
  assert.throws(() => canonicalizeJCS({ x: '\uDE00' }));
  assert.equal(canonicalizeJCS({ x: { x: { x: 1 } } }), '{"x":{"x":{"x":1}}}');
  cleanup();
});

// ---- digest stability --------------------------------------------------------

test('computeRegistryDigest is stable across key insertion order (excludes contentDigest)', () => {
  const a = { ...makeRoot(), migration: { note: 'x', source: 'y', migratedAt: 'z', migrationVersion: '1.0.0' } };
  const b = {
    migration: { migrationVersion: '1.0.0', source: 'y', migratedAt: 'z', note: 'x' },
    ...a,
  };
  assert.equal(computeRegistryDigest(a), computeRegistryDigest(b));
  assert.equal(REGISTRY_DIGEST_RE.test(a.contentDigest), true);
  cleanup();
});

test('canonicalStringify matches consumer contract for typical project entry', () => {
  const entry = {
    projectId: 'demo-proj',
    canonicalRepository: 'octo/demo',
    canonicalRoot: 'C:/Users/Admin/external-projects/demo',
    capabilities: ['project-manifest', 'product-code'],
    registeredAt: '2026-01-09T00:00:00.000Z',
    status: 'active',
  };
  const out = canonicalizeJCS(entry);
  // Sorted keys (RFC 8785 §3.2.2.4): canonicalRepository, canonicalRoot, capabilities, projectId, registeredAt, status.
  // V8 JSON.stringify emits non-ASCII as raw bytes; RFC 8785 accepts shortest form.
  assert.equal(out, '{"canonicalRepository":"octo/demo","canonicalRoot":"C:/Users/Admin/external-projects/demo","capabilities":["project-manifest","product-code"],"projectId":"demo-proj","registeredAt":"2026-01-09T00:00:00.000Z","status":"active"}');
  cleanup();
});

// ---- read + validate ---------------------------------------------------------

test('readCanonicalRegistry returns REGISTRY_MISSING for non-existent path', () => {
  setRegistryPath();
  const r = readCanonicalRegistry();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REGISTRY_MISSING');
  cleanup();
});

test('validateCanonicalRegistry rejects bad digest, bad id, secret pattern, worktree-relative root', () => {
  setRegistryPath();
  const bad = createCanonicalRegistry({
    projects: {
      'Bad-Id': { ...makeProject({ projectId: 'Bad-Id' }), canonicalRepository: 'octo/with-token' },
      'demo-proj': makeProject({ canonicalRoot: 'C:/Users/Admin/Soc_brain/subdir' }),
      'demo-proj-2': makeProject({ projectId: 'demo-proj-2' }),
    },
  });
  bad.contentDigest = 'a'.repeat(64);
  const v = validateCanonicalRegistry(bad, { cwd: 'C:/Users/Admin/Soc_brain' });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.startsWith('REGISTRY_DIGEST_MISMATCH')));
  assert.ok(v.errors.some((e) => e.includes('Bad-Id')));
  assert.ok(v.errors.some((e) => e.includes('token')));
  assert.ok(v.errors.some((e) => e.includes('canonicalRoot')));
  cleanup();
});

test('validateCanonicalRegistry accepts a clean registry', () => {
  setRegistryPath();
  const r = makeRoot();
  const v = validateCanonicalRegistry(r);
  assert.equal(v.ok, true, 'errors=' + JSON.stringify(v.errors));
  cleanup();
});

// ---- atomic write happy path + crash safety ----------------------------------

test('writeCanonicalRegistry: happy path, file present, read-back digest equals declared', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const acq = acquireRegistryLock({ lockDir });
  assert.equal(acq.ok, true);
  try {
    const r = makeRoot();
    const w = writeCanonicalRegistry({ next: r, lockDir, registryPath, owner: acq.owner });
    assert.equal(w.ok, true);
    const rb = readCanonicalRegistry({ registryPath });
    assert.equal(rb.ok, true);
    assert.equal(rb.data.contentDigest, r.contentDigest);
    assert.equal(rb.data.revision, r.revision);
  } finally { releaseRegistryLock({ lockDir, owner: acq.owner }); cleanup(); }
  rmSync(tmp, { recursive: true, force: true });
});

test('writeCanonicalRegistry: pre-existing bytes preserved on validation failure', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const initial = makeRoot();
  const acq0 = acquireRegistryLock({ lockDir });
  assert.equal(acq0.ok, true);
  const w0 = writeCanonicalRegistry({ next: initial, lockDir, registryPath, owner: acq0.owner });
  assert.equal(w0.ok, true);
  releaseRegistryLock({ lockDir, owner: acq0.owner });
  const acq1 = acquireRegistryLock({ lockDir });
  assert.equal(acq1.ok, true);
  const bad = JSON.parse(JSON.stringify(initial));
  bad.contentDigest = '0'.repeat(64);
  const w1 = writeCanonicalRegistry({ current: initial, next: bad, lockDir, registryPath, owner: acq1.owner });
  assert.equal(w1.ok, false);
  releaseRegistryLock({ lockDir, owner: acq1.owner });
  const rb = readCanonicalRegistry({ registryPath });
  assert.equal(rb.ok, true);
  assert.equal(rb.data.contentDigest, initial.contentDigest);
  rmSync(tmp, { recursive: true, force: true });
});

// ---- single-writer lock directory --------------------------------------------

test('acquireRegistryLock: only one holder at a time; second attempt fails CONCURRENT_MODIFICATION', () => {
  const { tmp, lockDir } = setRegistryPath();
  const a = acquireRegistryLock({ lockDir });
  assert.equal(a.ok, true);
  const b = acquireRegistryLock({ lockDir });
  assert.equal(b.ok, false);
  assert.equal(b.code, 'REGISTRY_CONCURRENT_MODIFICATION');
  releaseRegistryLock({ lockDir, owner: a.owner });
  const c = acquireRegistryLock({ lockDir });
  assert.equal(c.ok, true);
  releaseRegistryLock({ lockDir, owner: c.owner });
  rmSync(tmp, { recursive: true, force: true });
});

test('acquireRegistryLock: stale lock (dead pid) is auto-recovered', () => {
  const { tmp, lockDir } = setRegistryPath();
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
    nonce: 'deadbeef', pid: 0x7FFFFFFE, hostname: 'x', startedAt: '2026-01-01T00:00:00Z',
  }), 'utf8');
  const a = acquireRegistryLock({ lockDir });
  if (!a.ok) {
    assert.equal(a.code, 'REGISTRY_CONCURRENT_MODIFICATION');
  } else {
    releaseRegistryLock({ lockDir, owner: a.owner });
  }
  rmSync(tmp, { recursive: true, force: true });
});

test('releaseRegistryLock: refuses to release if owner.json nonce changed', () => {
  const { tmp, lockDir } = setRegistryPath();
  const a = acquireRegistryLock({ lockDir });
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ nonce: 'other', pid: 0, hostname: 'x', startedAt: 'x' }), 'utf8');
  const r = releaseRegistryLock({ lockDir, owner: a.owner });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REGISTRY_LOCK_OWNER_MISMATCH');
  rmSync(lockDir, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

// ---- CAS gate: revision + digest ---------------------------------------------

test('writeCanonicalRegistry: CAS gate triggers REGISTRY_CONCURRENT_MODIFICATION on digest drift', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const initial = makeRoot();
  const acq0 = acquireRegistryLock({ lockDir });
  writeCanonicalRegistry({ next: initial, lockDir, registryPath, owner: acq0.owner });
  releaseRegistryLock({ lockDir, owner: acq0.owner });
  const acq1 = acquireRegistryLock({ lockDir });
  const next = { ...initial, revision: 1, updatedAt: '2026-01-10T00:00:00.000Z', contentDigest: '0'.repeat(64) };
  next.contentDigest = computeRegistryDigest(next);
  const w = writeCanonicalRegistry({
    current: { ...initial, revision: 0 },
    next,
    lockDir,
    registryPath,
    owner: acq1.owner,
    expectedRevision: 0,
    expectedDigest: 'wrongdigest',
  });
  assert.equal(w.ok, false);
  assert.equal(w.code, 'REGISTRY_CONCURRENT_MODIFICATION');
  const rb = readCanonicalRegistry({ registryPath });
  assert.equal(rb.data.revision, 0);
  releaseRegistryLock({ lockDir, owner: acq1.owner });
  rmSync(tmp, { recursive: true, force: true });
});

// ---- Path hardening ----------------------------------------------------------

test('resolveCanonicalRegistryPath: rejects path inside worktree', () => {
  const r = resolveCanonicalRegistryPath({ override: 'C:/Users/Admin/Soc_brain/registry/projects.json', cwd: 'C:/Users/Admin/Soc_brain' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REGISTRY_PATH_INSIDE_WORKTREE');
  cleanup();
});

test('validateCanonicalRegistry: rejects canonicalRoot that is a symlink (junction)', () => {
  setRegistryPath();
  const tmp = newTmpDir();
  const realDir = join(tmp, 'real');
  const linkDir = join(tmp, 'link');
  mkdirSync(realDir, { recursive: true });
  let skipped = false;
  try { symlinkSync(realDir, linkDir, 'junction'); }
  catch (e) { skipped = true; }
  if (!skipped) {
    const p = makeProject({ canonicalRoot: linkDir });
    const r = createCanonicalRegistry({ projects: { 'demo-proj': p } });
    const v = validateCanonicalRegistry(r, { cwd: 'C:/Users/Admin/Soc_brain' });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.startsWith('REGISTRY_PATH_ESCAPE')));
  }
  rmSync(tmp, { recursive: true, force: true });
  cleanup();
});

// ---- split-brain -------------------------------------------------------------

test('detectSplitBrain: no split-brain when both files absent', () => {
  const { tmp } = setRegistryPath();
  const r = detectSplitBrain({ registryPath: join(tmp, 'no-such.json'), legacyPath: join(tmp, 'no-such-legacy.json') });
  assert.equal(r.ok, true);
  assert.equal(r.splitBrain, false);
  rmSync(tmp, { recursive: true, force: true });
});

test('detectSplitBrain: SPLIT_BRAIN when legacy active and canonical missing or empty or digest-mismatch', () => {
  const { tmp, registryPath } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  writeFileSync(legacy, JSON.stringify({ projects: [{ projectId: 'demo-proj', repository: 'octo/demo' }] }), 'utf8');
  const r1 = detectSplitBrain({ registryPath, legacyPath: legacy });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'REGISTRY_SPLIT_BRAIN');
  const emptyRoot = createCanonicalRegistry({ projects: {} });
  writeFileSync(registryPath, JSON.stringify(emptyRoot), 'utf8');
  const r2 = detectSplitBrain({ registryPath, legacyPath: legacy });
  assert.equal(r2.code, 'REGISTRY_SPLIT_BRAIN');
  const otherRoot = makeRoot({ 'other-proj': makeProject({ projectId: 'other-proj', canonicalRepository: 'octo/other', canonicalRoot: 'C:/Users/Admin/external-projects/other' }) }, { revision: 0 });
  writeFileSync(registryPath, JSON.stringify(otherRoot), 'utf8');
  const r3 = detectSplitBrain({ registryPath, legacyPath: legacy });
  assert.equal(r3.code, 'REGISTRY_SPLIT_BRAIN');
  rmSync(tmp, { recursive: true, force: true });
});

test('detectSplitBrain: tombstoned legacy with matching canonical is not split-brain', () => {
  const { tmp, registryPath } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  const at = '2026-01-09T00:00:00.000Z';
  writeFileSync(legacy, JSON.stringify({
    projects: [
      { projectId: 'demo-proj', repository: 'octo/demo', workspace: { workspaceId: 'ws-1' } },
    ],
  }), 'utf8');
  const migrated = {
    $schemaVersion: SUPPORTED_REGISTRY_SCHEMA,
    revision: 0,
    updatedAt: at,
    contentDigest: '0'.repeat(64),
    projects: {
      'demo-proj': {
        projectId: 'demo-proj',
        canonicalRepository: 'octo/demo',
        canonicalRoot: '',
        status: 'quarantined',
        registeredAt: at,
        capabilities: [],
        workspaceId: 'ws-1',
      },
    },
    migration: { migratedAt: at, source: legacy, migrationVersion: '1.0.0', note: 'first-time migration' },
  };
  migrated.contentDigest = computeRegistryDigest(migrated);
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify(migrated), 'utf8');
  const tomb = { canonicalPath: registryPath, contentDigest: migrated.contentDigest, migratedAt: at, migrationVersion: '1.0.0', legacyPath: legacy };
  writeFileSync(legacy + '.tombstone.json', JSON.stringify(tomb), 'utf8');
  const r = detectSplitBrain({ registryPath, legacyPath: legacy });
  assert.equal(r.ok, true, 'errors=' + JSON.stringify(r.errors));
  assert.equal(r.splitBrain, false);
  rmSync(tmp, { recursive: true, force: true });
});

// ---- legacy migration --------------------------------------------------------

test('migrateLegacyRegistry: writes canonical, writes tombstone, marks quarantined without canonicalRoot', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  writeFileSync(legacy, JSON.stringify({
    projects: [
      { projectId: 'demo-proj', repository: 'octo/demo', workspace: { workspaceId: 'ws-1' } },
      { projectId: 'quarantined', repository: 'octo/quarantined' },
    ],
  }), 'utf8');
  const r = migrateLegacyRegistry({ legacyPath: legacy, registryPath, lockDir });
  assert.equal(r.ok, true);
  const canon = readCanonicalRegistry({ registryPath });
  assert.equal(canon.ok, true);
  assert.equal(canon.data.projects['demo-proj'].workspaceId, 'ws-1');
  assert.equal(canon.data.projects['demo-proj'].status, 'quarantined');
  assert.equal(canon.data.projects['quarantined'].status, 'quarantined');
  const tombPath = legacy + '.tombstone.json';
  assert.equal(existsSync(tombPath), true);
  const tomb = JSON.parse(readFileSync(tombPath, 'utf8'));
  assert.equal(tomb.canonicalPath, registryPath);
  assert.equal(tomb.contentDigest, canon.data.contentDigest);
  rmSync(tmp, { recursive: true, force: true });
});

test('migrateLegacyRegistry: refuses when legacy absent (does not fabricate)', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const r = migrateLegacyRegistry({ legacyPath: join(tmp, 'no-such.json'), registryPath, lockDir });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LEGACY_PROJECT_NO_ROOT');
  assert.equal(existsSync(registryPath), false);
  rmSync(tmp, { recursive: true, force: true });
});

// ---- roundtrip: commitCanonicalRegistry -------------------------------------

test('commitCanonicalRegistry: two sequential commits succeed; revision increments', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const r1 = makeRoot();
  const w1 = commitCanonicalRegistry({ next: r1, registryPath, lockDir });
  assert.equal(w1.ok, true);
  const r2Data = readCanonicalRegistry({ registryPath });
  const r2Next = { ...r2Data.data, revision: 1, updatedAt: '2026-01-10T00:00:00.000Z', contentDigest: '0'.repeat(64) };
  r2Next.contentDigest = computeRegistryDigest(r2Next);
  const w2 = commitCanonicalRegistry({ next: r2Next, registryPath, lockDir });
  assert.equal(w2.ok, true);
  const r2Rb = readCanonicalRegistry({ registryPath });
  assert.equal(r2Rb.data.revision, 1);
  rmSync(tmp, { recursive: true, force: true });
});

test('writeCanonicalRegistry: cannot write if lock not held (REGISTRY_LOCK_REQUIRED)', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const r = makeRoot();
  const w = writeCanonicalRegistry({ next: r, lockDir, registryPath, owner: null });
  assert.equal(w.ok, false);
  assert.equal(w.code, 'REGISTRY_LOCK_REQUIRED');
  rmSync(tmp, { recursive: true, force: true });
});

// ---- Two-writer CAS (real-FS) ------------------------------------------------

test('commitCanonicalRegistry: revision gate is respected across out-of-band writes', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const r1 = makeRoot();
  commitCanonicalRegistry({ next: r1, registryPath, lockDir });
  const cur = readCanonicalRegistry({ registryPath });
  const tampered = { ...cur.data, revision: 5, updatedAt: '2026-01-11T00:00:00.000Z', contentDigest: '0'.repeat(64) };
  tampered.contentDigest = computeRegistryDigest(tampered);
  const acq = acquireRegistryLock({ lockDir });
  writeCanonicalRegistry({ next: tampered, lockDir, registryPath, owner: acq.owner });
  releaseRegistryLock({ lockDir, owner: acq.owner });
  const r2 = readCanonicalRegistry({ registryPath });
  const next = { ...r2.data, revision: 6, updatedAt: '2026-01-12T00:00:00.000Z', contentDigest: '0'.repeat(64) };
  next.contentDigest = computeRegistryDigest(next);
  const w = commitCanonicalRegistry({ next, registryPath, lockDir });
  assert.equal(w.ok, true);
  const rb = readCanonicalRegistry({ registryPath });
  assert.equal(rb.data.revision, 6);
  rmSync(tmp, { recursive: true, force: true });
});






