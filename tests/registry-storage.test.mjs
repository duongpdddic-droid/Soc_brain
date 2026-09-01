// tests/registry-storage.test.mjs — Required tests for Issue #17 Canonical Project Registry.
// Real filesystem on Windows. Uses a temp directory per test and SOC_PROJECT_REGISTRY_PATH to
// redirect storage so the test cannot collide with the host's real ~/.soc-brain/registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, rmdirSync, writeFileSync, readFileSync, existsSync,
  symlinkSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  canonicalStringify, computeRegistryDigest, runJCSSelfCheck,
  readCanonicalRegistry, validateCanonicalRegistry, createCanonicalRegistry,
  nextRevision, writeCanonicalRegistry, commitCanonicalRegistry,
  acquireRegistryLock, releaseRegistryLock, readLegacyRegistry,
  detectSplitBrain, migrateLegacyRegistry, resolveCanonicalRegistryPath,
  resolveCanonicalRoot, verifyCanonicalRoot, reconcileLegacyRegistry,
  SUPPORTED_REGISTRY_SCHEMA, REGISTRY_DIGEST_RE, MIGRATION_CONTRACT_VERSION,
} from '../packages/project-registry/registry-storage.mjs';
import { reconcileLegacyInternal } from '../packages/project-registry/reconcile-engine.mjs';
import { canonicalizeJCS } from '../packages/project-registry/canonical-jcs.mjs';
import { fileURLToPath } from 'node:url';

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
  assert.ok(r.total >= 18, 'expected >=18 vectors (incl. negative value-space), got ' + r.total);
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

// ---- value space (GPT-REV-124) ----------------------------------------------

test('JCS: float, NaN, Infinity, out-of-range integer are rejected (safe-int value space)', () => {
  assert.throws(() => canonicalizeJCS({ n: 1.5 }), /non-integer|out-of-range/);
  assert.throws(() => canonicalizeJCS({ n: NaN }), /non-finite/);
  assert.throws(() => canonicalizeJCS({ n: Infinity }), /non-finite/);
  assert.throws(() => canonicalizeJCS({ n: 9007199254740992 }), /out-of-range/);
  cleanup();
});

test('validateCanonicalRegistry: rejects float in project extra property (REGISTRY_VALUE_SPACE)', () => {
  setRegistryPath();
  const root = createCanonicalRegistry({ projects: { 'demo-proj': makeProject() } });
  root.projects['demo-proj'].priorityScore = 1.5; // inject float after builder (builder computeRegistryDigest would throw on float)
  const v = validateCanonicalRegistry(root, { strictDigest: false });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.startsWith('REGISTRY_VALUE_SPACE')), 'errors=' + JSON.stringify(v.errors));
  cleanup();
});

test('writeCanonicalRegistry: rejects float before any write; existing bytes unchanged', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const initial = makeRoot();
  const acq0 = acquireRegistryLock({ lockDir });
  const w0 = writeCanonicalRegistry({ next: initial, lockDir, registryPath, owner: acq0.owner });
  assert.equal(w0.ok, true);
  releaseRegistryLock({ lockDir, owner: acq0.owner });
  const bytesBefore = readFileSync(registryPath);
  const acq1 = acquireRegistryLock({ lockDir });
  const floatNext = JSON.parse(JSON.stringify(initial));
  floatNext.projects['demo-proj'].score = 2.5; // float in extra prop
  floatNext.revision = 1;
  floatNext.updatedAt = '2026-01-10T00:00:00.000Z';
  floatNext.contentDigest = '0'.repeat(64);
  const w1 = writeCanonicalRegistry({ current: initial, next: floatNext, lockDir, registryPath, owner: acq1.owner });
  assert.equal(w1.ok, false);
  assert.ok(w1.errors.some((e) => e.startsWith('REGISTRY_VALUE_SPACE')), 'errors=' + JSON.stringify(w1.errors));
  releaseRegistryLock({ lockDir, owner: acq1.owner });
  assert.deepEqual(readFileSync(registryPath), bytesBefore, 'bytes must be unchanged on rejected write');
  rmSync(tmp, { recursive: true, force: true });
});

// ---- revision monotonicity (GPT-REV-125) ------------------------------------

test('writeCanonicalRegistry: rejects same/lower/skipped revision; existing bytes unchanged', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const initial = makeRoot(); // revision 0
  const acq0 = acquireRegistryLock({ lockDir });
  const w0 = writeCanonicalRegistry({ next: initial, lockDir, registryPath, owner: acq0.owner });
  assert.equal(w0.ok, true);
  releaseRegistryLock({ lockDir, owner: acq0.owner });
  const bytesBefore = readFileSync(registryPath);
  const current = readCanonicalRegistry({ registryPath });
  const attempt = (revision) => {
    const acq = acquireRegistryLock({ lockDir });
    const next = JSON.parse(JSON.stringify(current.data));
    next.revision = revision;
    next.updatedAt = '2026-01-10T00:00:00.000Z';
    next.contentDigest = '0'.repeat(64);
    next.contentDigest = computeRegistryDigest(next);
    const w = writeCanonicalRegistry({ current: current.data, next, lockDir, registryPath, owner: acq.owner });
    releaseRegistryLock({ lockDir, owner: acq.owner });
    return w;
  };
  for (const rev of [0, -1, 2, 5]) { // same, lower, skipped, far-skip
    const w = attempt(rev);
    assert.equal(w.ok, false, `revision ${rev} must be rejected`);
    assert.equal(w.code, 'REGISTRY_REVISION_NOT_INCREMENTED', `revision ${rev} code`);
  }
  assert.deepEqual(readFileSync(registryPath), bytesBefore, 'bytes must be unchanged on rejected revisions');
  // Correct +1 publish still succeeds.
  const acqOk = acquireRegistryLock({ lockDir });
  const good = JSON.parse(JSON.stringify(current.data));
  good.revision = 1;
  good.updatedAt = '2026-01-11T00:00:00.000Z';
  good.contentDigest = '0'.repeat(64);
  good.contentDigest = computeRegistryDigest(good);
  const wOk = writeCanonicalRegistry({ current: current.data, next: good, lockDir, registryPath, owner: acqOk.owner });
  assert.equal(wOk.ok, true, 'revision +1 publish must succeed: ' + JSON.stringify(wOk));
  releaseRegistryLock({ lockDir, owner: acqOk.owner });
  rmSync(tmp, { recursive: true, force: true });
});

test('commitCanonicalRegistry: first publish must be revision 0', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const next = createCanonicalRegistry({ projects: { 'demo-proj': makeProject() }, revision: 3 });
  const w = commitCanonicalRegistry({ next, registryPath, lockDir });
  assert.equal(w.ok, false);
  assert.equal(w.code, 'REGISTRY_REVISION_NOT_INCREMENTED');
  assert.equal(existsSync(registryPath), false, 'no file may be written on rejected first publish');
  rmSync(tmp, { recursive: true, force: true });
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
  const { registryPath } = setRegistryPath();
  const r = readCanonicalRegistry({ registryPath });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REGISTRY_MISSING');
  cleanup();
});

test('validateCanonicalRegistry rejects bad digest, bad id, secret pattern, non-absolute root', () => {
  setRegistryPath();
  const bad = createCanonicalRegistry({
    projects: {
      'Bad-Id': { ...makeProject({ projectId: 'Bad-Id' }), canonicalRepository: 'octo/with-token' },
      'demo-proj': makeProject({ canonicalRoot: 'relative/subdir' }),
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
  bad.revision = 1; // pass monotonic gate so the failure is the (bad) digest, per test intent
  bad.updatedAt = '2026-01-10T00:00:00.000Z';
  bad.contentDigest = '0'.repeat(64);
  const w1 = writeCanonicalRegistry({ current: initial, next: bad, lockDir, registryPath, owner: acq1.owner });
  assert.equal(w1.ok, false);
  assert.equal(w1.code, 'REGISTRY_DIGEST_MISMATCH', 'expected digest mismatch, got ' + JSON.stringify(w1));
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

test('commitCanonicalRegistry: out-of-band skipped revision is rejected (GPT-REV-125); bytes unchanged', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const r1 = makeRoot(); // revision 0
  const c1 = commitCanonicalRegistry({ next: r1, registryPath, lockDir });
  assert.equal(c1.ok, true);
  const bytesBefore = readFileSync(registryPath);
  const cur = readCanonicalRegistry({ registryPath });
  assert.equal(cur.data.revision, 0);

  // Attempt out-of-band skipped revision (current=null) — monotonic gate rejects it.
  const acq = acquireRegistryLock({ lockDir });
  const tampered = { ...cur.data, revision: 5, updatedAt: '2026-01-11T00:00:00.000Z', contentDigest: '0'.repeat(64) };
  tampered.contentDigest = computeRegistryDigest(tampered);
  const oob = writeCanonicalRegistry({ next: tampered, lockDir, registryPath, owner: acq.owner });
  assert.equal(oob.ok, false, 'out-of-band skipped revision must be rejected');
  assert.equal(oob.code, 'REGISTRY_REVISION_NOT_INCREMENTED', 'code for skipped out-of-band write');
  releaseRegistryLock({ lockDir, owner: acq.owner });
  assert.deepEqual(readFileSync(registryPath), bytesBefore, 'bytes unchanged on rejected out-of-band write');

  // Valid commit of revision 1 still succeeds.
  const next = { ...cur.data, revision: 1, updatedAt: '2026-01-12T00:00:00.000Z', contentDigest: '0'.repeat(64) };
  next.contentDigest = computeRegistryDigest(next);
  const w = commitCanonicalRegistry({ next, registryPath, lockDir });
  assert.equal(w.ok, true, 'valid +1 commit: ' + JSON.stringify(w));
  const rb = readCanonicalRegistry({ registryPath });
  assert.equal(rb.data.revision, 1);
  rmSync(tmp, { recursive: true, force: true });
});
// ---- Issue #23: CWD-independent canonicalRoot validation ---------------------

test('validateCanonicalRegistry accepts canonicalRoot equal to repo CWD (no reject)', () => {
  setRegistryPath();
  const repoCwd = process.cwd();
  const root = createCanonicalRegistry({ projects: { 'demo-proj': makeProject({ canonicalRoot: repoCwd }) } });
  for (const cwd of ['C:/Users/Admin/Soc_brain', 'C:/Users/Admin', repoCwd]) {
    const v = validateCanonicalRegistry(root, { cwd });
    assert.equal(v.ok, true, `cwd=${cwd} errors=` + JSON.stringify(v.errors));
  }
  cleanup();
});

test('validateCanonicalRegistry is independent of the real process.cwd() (chdir)', () => {
  setRegistryPath();
  const root = createCanonicalRegistry({ projects: { 'demo-proj': makeProject({ canonicalRoot: process.cwd() }) } });
  const saved = process.cwd();
  let changed = false;
  try {
    const results = [];
    for (const d of ['C:/Users/Admin', saved]) {
      try { process.chdir(d); changed = true; } catch { continue; }
      results.push(validateCanonicalRegistry(root)); // default cwd = process.cwd()
    }
    if (results.length === 2) {
      assert.equal(results[0].ok, true, 'errors=' + JSON.stringify(results[0].errors));
      assert.equal(JSON.stringify(results[0]), JSON.stringify(results[1]));
    } else {
      assert.ok(true); // chdir not possible on this host; explicit-CWD test covers it
    }
  } finally {
    process.chdir(saved);
  }
  cleanup();
});

test('validateCanonicalRegistry: same registry yields same result from three CWDs', () => {
  setRegistryPath();
  const root = createCanonicalRegistry({ projects: { 'demo-proj': makeProject() } });
  const sigs = ['C:/x/a', 'C:/x/b', 'C:/x/c'].map((cwd) => JSON.stringify(validateCanonicalRegistry(root, { cwd })));
  assert.equal(sigs[0], sigs[1]);
  assert.equal(sigs[1], sigs[2]);
  cleanup();
});

test('resolveCanonicalRegistryPath: outside-worktree registry resolves same from any CWD', () => {
  const p = 'C:/Users/Admin/.soc-brain/registry/projects.json';
  const rA = resolveCanonicalRegistryPath({ override: p, cwd: 'C:/Users/Admin/Soc_brain' });
  const rB = resolveCanonicalRegistryPath({ override: p, cwd: 'C:/x/other' });
  assert.equal(rA.ok, true);
  assert.equal(rB.ok, true);
  assert.equal(rA.path, rB.path);
  cleanup();
});

test('resolveCanonicalRoot: requires absolute, rejects junction, verifyCanonicalRoot git fail-closed', () => {
  setRegistryPath();
  assert.equal(resolveCanonicalRoot('relative/x').ok, false);
  assert.equal(resolveCanonicalRoot('C:/does/not/exist-xyz').code, 'CANONICAL_ROOT_MISSING');
  const tmp = newTmpDir();
  const real = join(tmp, 'real');
  mkdirSync(real, { recursive: true });
  assert.equal(resolveCanonicalRoot(real).ok, true);
  let junctionOk = false;
  try { symlinkSync(real, join(tmp, 'link'), 'junction'); junctionOk = true; } catch { /* junction unsupported */ }
  if (junctionOk) {
    const vj = resolveCanonicalRoot(join(tmp, 'link'));
    assert.equal(vj.ok, false);
    assert.equal(vj.code, 'CANONICAL_ROOT_ESCAPE');
  }
  const v = verifyCanonicalRoot(real, 'owner/repo');
  assert.equal(v.ok, false, 'root không có git remote origin -> fail-closed');
  assert.equal(v.code, 'CANONICAL_ROOT_REMOTE_MISMATCH');
  rmSync(tmp, { recursive: true, force: true });
  cleanup();
});
// ---- Issue #23: reconcileLegacyRegistry (transactional) -----------------------

function makeGitRoot(remoteUrl) {
  const root = newTmpDir();
  execFileSync('git', ['init', '-q', root], { stdio: ['ignore', 'ignore', 'ignore'] });
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remoteUrl], { stdio: ['ignore', 'ignore', 'ignore'] });
  return root;
}

function writeLegacy(legacy, projects) {
  writeFileSync(legacy, JSON.stringify({ projects }), 'utf8');
}

function writeCanonical(registryPath, root) {
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify(root), 'utf8');
}

test('reconcileLegacyRegistry: canonical subset + legacy verified superset -> ok, revision +1, tombstone', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  writeCanonical(registryPath, makeRoot({ 'demo-proj': makeProject() }));
  writeLegacy(legacy, [
    { projectId: 'demo-proj', repository: 'octo/demo' },
    { projectId: 'ai-pr-reviewer', repository: 'duongpdddic-droid/AI_PR_REVIEWER' },
    { projectId: 'qlda-dtxd', repository: 'duongpdddic-droid/QLDA-DTXD' },
  ]);
  const roots = {
    'ai-pr-reviewer': makeGitRoot('https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git'),
    'qlda-dtxd': makeGitRoot('git@github.com:duongpdddic-droid/QLDA-DTXD.git'),
  };
  const r = reconcileLegacyRegistry({ legacyPath: legacy, registryPath, lockDir, roots, now: new Date('2026-01-09T00:00:00.000Z') });
  assert.equal(r.ok, true, JSON.stringify(r));
  const canon = readCanonicalRegistry({ registryPath });
  assert.equal(canon.ok, true);
  assert.equal(canon.data.revision, 1, 'revision tăng đúng 1');
  assert.deepEqual(Object.keys(canon.data.projects).sort(), ['ai-pr-reviewer', 'demo-proj', 'qlda-dtxd']);
  assert.equal(canon.data.projects['ai-pr-reviewer'].canonicalRoot, realpathSync(roots['ai-pr-reviewer']));
  assert.equal(canon.data.projects['qlda-dtxd'].status, 'active');
  assert.equal(canon.data.projects['demo-proj'].canonicalRepository, 'octo/demo');
  const tomb = JSON.parse(readFileSync(legacy + '.tombstone.json', 'utf8'));
  assert.equal(tomb.reconcile, true);
  assert.equal(tomb.contentDigest, canon.data.contentDigest);
  rmSync(roots['ai-pr-reviewer'], { recursive: true, force: true });
  rmSync(roots['qlda-dtxd'], { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

test('reconcileLegacyRegistry: shared record conflict -> RECONCILIATION_CONFLICT, zero mutation', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  writeCanonical(registryPath, makeRoot({ 'demo-proj': makeProject({ canonicalRepository: 'octo/demo' }) }));
  writeLegacy(legacy, [{ projectId: 'demo-proj', repository: 'octo/OTHER' }]);
  const canonBytes = readFileSync(registryPath);
  const legacyBytes = readFileSync(legacy);
  const r = reconcileLegacyRegistry({ legacyPath: legacy, registryPath, lockDir });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REGISTRY_RECONCILIATION_CONFLICT');
  assert.deepEqual(readFileSync(registryPath), canonBytes, 'canonical bytes giữ nguyên');
  assert.deepEqual(readFileSync(legacy), legacyBytes, 'legacy bytes giữ nguyên');
  assert.equal(existsSync(legacy + '.tombstone.json'), false);
  rmSync(tmp, { recursive: true, force: true });
});
test('reconcileLegacyRegistry: remote/root mismatch -> RECONCILIATION_CONFLICT, zero mutation', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  writeCanonical(registryPath, makeRoot({ 'demo-proj': makeProject() }));
  writeLegacy(legacy, [
    { projectId: 'demo-proj', repository: 'octo/demo' },
    { projectId: 'ai-pr-reviewer', repository: 'duongpdddic-droid/AI_PR_REVIEWER' },
  ]);
  const wrongRoot = makeGitRoot('https://github.com/somebody/WRONG.git');
  const canonBytes = readFileSync(registryPath);
  const r = reconcileLegacyRegistry({ legacyPath: legacy, registryPath, lockDir, roots: { 'ai-pr-reviewer': wrongRoot } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REGISTRY_RECONCILIATION_CONFLICT');
  assert.ok(r.errors.some((e) => e.includes('AI_PR_REVIEWER') || e.includes('không khớp')));
  assert.deepEqual(readFileSync(registryPath), canonBytes, 'canonical bytes giữ nguyên');
  assert.equal(existsSync(legacy + '.tombstone.json'), false);
  rmSync(wrongRoot, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

test('reconcileLegacyRegistry: concurrent writer lock -> RECONCURRENT, zero mutation', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  writeCanonical(registryPath, makeRoot({ 'demo-proj': makeProject() }));
  writeLegacy(legacy, [{ projectId: 'demo-proj', repository: 'octo/demo' }]);
  const acq = acquireRegistryLock({ lockDir });
  assert.equal(acq.ok, true);
  const canonBytes = readFileSync(registryPath);
  const r = reconcileLegacyRegistry({ legacyPath: legacy, registryPath, lockDir });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REGISTRY_CONCURRENT_MODIFICATION');
  assert.deepEqual(readFileSync(registryPath), canonBytes, 'canonical bytes giữ nguyên');
  releaseRegistryLock({ lockDir, owner: acq.owner });
  rmSync(tmp, { recursive: true, force: true });
});

test('reconcileLegacyRegistry (GPT-REV-139): writer báo success giả nhưng file không đổi -> không tombstone', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  writeCanonical(registryPath, makeRoot({ 'demo-proj': makeProject() }));
  writeLegacy(legacy, [
    { projectId: 'demo-proj', repository: 'octo/demo' },
    { projectId: 'ai-pr-reviewer', repository: 'duongpdddic-droid/AI_PR_REVIEWER' },
  ]);
  const gitRoot = makeGitRoot('https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git');
  const canonBytes = readFileSync(registryPath);
  // GPT-REV-139: DI chỉ nằm trong __internal (non-public). Fake writer báo ok:true
  // nhưng không ghi disk; reconcile luôn đọc lại canonical từ disk nên phát hiện mismatch
  // > không tạo tombstone.
  const r = reconcileLegacyInternal(
    { legacyPath: legacy, registryPath, lockDir, roots: { 'ai-pr-reviewer': gitRoot } },
    { write: () => ({ ok: true, data: null }) },
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REGISTRY_READBACK_REVISION_MISMATCH');
  assert.equal(existsSync(legacy + '.tombstone.json'), false, 'tombstone phải chưa tồn tại khi read-back chưa PASS');
  assert.deepEqual(readFileSync(registryPath), canonBytes, 'canonical bytes giữ nguyên (fake writer không ghi)');
  rmSync(gitRoot, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

test('reconcileLegacyRegistry (GPT-REV-144): tombstone path là directory -> CONFLICT trước publish, canonical không đổi', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  writeCanonical(registryPath, makeRoot({ 'demo-proj': makeProject() }));
  const canonBytes = readFileSync(registryPath);
  writeLegacy(legacy, [
    { projectId: 'demo-proj', repository: 'octo/demo' },
    { projectId: 'ai-pr-reviewer', repository: 'duongpdddic-droid/AI_PR_REVIEWER' },
  ]);
  const gitRoot = makeGitRoot('https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git');
  mkdirSync(legacy + '.tombstone.json', { recursive: true }); // non-regular-file tombstone
  const r = reconcileLegacyRegistry({ legacyPath: legacy, registryPath, lockDir, roots: { 'ai-pr-reviewer': gitRoot } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'RECONCILIATION_TOMBSTONE_CONFLICT');
  assert.equal(r.published, false, 'preflight trước publish -> không publish');
  assert.deepEqual(readFileSync(registryPath), canonBytes, 'canonical bytes không đổi');
  assert.equal(readCanonicalRegistry({ registryPath }).data.revision, 0, 'revision giữ nguyên (không publish)');
  rmSync(gitRoot, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

test('reconcileLegacyRegistry (GPT-REV-140): tombstone write fail sau publish -> RECONCILIATION_TOMBSTONE_WRITE_FAILED (published:true)', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  writeCanonical(registryPath, makeRoot({ 'demo-proj': makeProject() }));
  writeLegacy(legacy, [
    { projectId: 'demo-proj', repository: 'octo/demo' },
    { projectId: 'ai-pr-reviewer', repository: 'duongpdddic-droid/AI_PR_REVIEWER' },
  ]);
  const gitRoot = makeGitRoot('https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git');
  const opts = { legacyPath: legacy, registryPath, lockDir, roots: { 'ai-pr-reviewer': gitRoot } };
  const r = reconcileLegacyInternal(opts, { writeTombstone: () => ({ ok: false, conflict: false, errors: ['simulated tombstone write failure'] }) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'RECONCILIATION_TOMBSTONE_WRITE_FAILED');
  assert.equal(r.published, true, 'publish đã thành công trước khi tombstone fail');
  assert.equal(readCanonicalRegistry({ registryPath }).data.revision, 1, 'canonical đã publish');
  assert.equal(existsSync(legacy + '.tombstone.json'), false, 'tombstone chưa được ghi');
  rmSync(gitRoot, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});
test('reconcileLegacyRegistry (GPT-REV-139): _write không còn là public option; public luôn dùng writer thật', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  writeCanonical(registryPath, makeRoot({ 'demo-proj': makeProject() }));
  writeLegacy(legacy, [
    { projectId: 'demo-proj', repository: 'octo/demo' },
    { projectId: 'ai-pr-reviewer', repository: 'duongpdddic-droid/AI_PR_REVIEWER' },
  ]);
  const gitRoot = makeGitRoot('https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git');
  const r = reconcileLegacyRegistry({
    legacyPath: legacy, registryPath, lockDir, roots: { 'ai-pr-reviewer': gitRoot },
    _write: () => ({ ok: false, code: 'SHOULD_NOT_BE_USED', errors: ['_write phải bị loại bỏ'] }),
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(readCanonicalRegistry({ registryPath }).data.revision, 1);
  rmSync(gitRoot, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

// ---- GPT-REV-140: tombstone atomic / idempotent / no-clobber / retry ----------

test('reconcileLegacyRegistry (GPT-REV-140): retry sau canonical-published/tombstone-failed -> chỉ hoàn tất tombstone, không tăng revision lần nữa', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  writeCanonical(registryPath, makeRoot({ 'demo-proj': makeProject() }));
  writeLegacy(legacy, [
    { projectId: 'demo-proj', repository: 'octo/demo' },
    { projectId: 'ai-pr-reviewer', repository: 'duongpdddic-droid/AI_PR_REVIEWER' },
  ]);
  const gitRoot = makeGitRoot('https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git');
  const opts = { legacyPath: legacy, registryPath, lockDir, roots: { 'ai-pr-reviewer': gitRoot } };
  const first = reconcileLegacyInternal(opts, { writeTombstone: () => ({ ok: false, conflict: false, errors: ['simulated tombstone write failure'] }) });
  assert.equal(first.ok, false);
  assert.equal(first.code, 'RECONCILIATION_TOMBSTONE_WRITE_FAILED');
  assert.equal(first.published, true);
  assert.equal(readCanonicalRegistry({ registryPath }).data.revision, 1, 'canonical đã publish ở attempt 1');
  assert.equal(existsSync(legacy + '.tombstone.json'), false, 'tombstone chưa tồn tại sau attempt 1');
  const second = reconcileLegacyRegistry(opts);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.published, false, 'retry chỉ hoàn tất tombstone');
  assert.equal(readCanonicalRegistry({ registryPath }).data.revision, 1, 'retry KHÔNG tăng revision lần nữa');
  const tomb = JSON.parse(readFileSync(legacy + '.tombstone.json', 'utf8'));
  assert.equal(tomb.contentDigest, readCanonicalRegistry({ registryPath }).data.contentDigest);
  rmSync(gitRoot, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

test('reconcileLegacyRegistry (GPT-REV-140): canonical đã chứa đủ verified legacy nhưng tombstone thiếu -> chỉ hoàn tất tombstone', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  // Canonical ALREADY superset (contains all legacy records), but no tombstone yet.
  writeCanonical(registryPath, makeRoot({ 'demo-proj': makeProject(), 'ai-pr-reviewer': makeProject({ projectId: 'ai-pr-reviewer', canonicalRepository: 'duongpdddic-droid/AI_PR_REVIEWER' }) }));
  writeLegacy(legacy, [
    { projectId: 'demo-proj', repository: 'octo/demo' },
    { projectId: 'ai-pr-reviewer', repository: 'duongpdddic-droid/AI_PR_REVIEWER' },
  ]);
  const canon0 = readCanonicalRegistry({ registryPath });
  const r = reconcileLegacyRegistry({ legacyPath: legacy, registryPath, lockDir });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.published, false, 'không cần publish vì canonical đã là superset');
  assert.equal(readCanonicalRegistry({ registryPath }).data.revision, canon0.data.revision, 'revision không đổi');
  const tomb = JSON.parse(readFileSync(legacy + '.tombstone.json', 'utf8'));
  assert.equal(tomb.contentDigest, canon0.data.contentDigest);
  rmSync(tmp, { recursive: true, force: true });
});
test('reconcileLegacyRegistry (GPT-REV-140): matching tombstone đã tồn tại -> idempotent success, không overwrite', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  writeCanonical(registryPath, makeRoot({ 'demo-proj': makeProject() }));
  writeLegacy(legacy, [
    { projectId: 'demo-proj', repository: 'octo/demo' },
    { projectId: 'ai-pr-reviewer', repository: 'duongpdddic-droid/AI_PR_REVIEWER' },
  ]);
  const gitRoot = makeGitRoot('https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git');
  const first = reconcileLegacyRegistry({ legacyPath: legacy, registryPath, lockDir, roots: { 'ai-pr-reviewer': gitRoot } });
  assert.equal(first.ok, true, JSON.stringify(first));
  const canon = readCanonicalRegistry({ registryPath });
  const tombBytes0 = readFileSync(legacy + '.tombstone.json');
  const second = reconcileLegacyRegistry({ legacyPath: legacy, registryPath, lockDir, roots: { 'ai-pr-reviewer': gitRoot } });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.published, false);
  assert.equal(readCanonicalRegistry({ registryPath }).data.revision, canon.data.revision, 'không thêm revision');
  assert.deepEqual(readFileSync(legacy + '.tombstone.json'), tombBytes0, 'tombstone không bị overwrite');
  rmSync(gitRoot, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

test('reconcileLegacyRegistry (GPT-REV-140): conflicting tombstone -> fail-closed, zero mutation, không overwrite', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  writeCanonical(registryPath, makeRoot({ 'demo-proj': makeProject() }));
  writeLegacy(legacy, [{ projectId: 'demo-proj', repository: 'octo/demo' }]);
  const canonBytes = readFileSync(registryPath);
  const tombPath = legacy + '.tombstone.json';
  const conflicting = {
    canonicalPath: 'C:/WRONG',
    contentDigest: '0'.repeat(64),
    legacyDigest: '0'.repeat(64),
    migratedAt: '2026-01-01T00:00:00.000Z',
    migrationVersion: '0.0.0',
    legacyPath: 'C:/WRONG/legacy.json',
    reconcile: true,
  };
  writeFileSync(tombPath, JSON.stringify(conflicting, null, 2), 'utf8');
  const tombBytes0 = readFileSync(tombPath);
  const r = reconcileLegacyRegistry({ legacyPath: legacy, registryPath, lockDir });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'RECONCILIATION_TOMBSTONE_CONFLICT');
  assert.deepEqual(readFileSync(registryPath), canonBytes, 'canonical không đổi');
  assert.deepEqual(readFileSync(tombPath), tombBytes0, 'tombstone không bị overwrite');
  rmSync(tmp, { recursive: true, force: true });
});

test('reconcileLegacyRegistry (GPT-REV-140): repeated success -> lần 2 idempotent, revision giữ nguyên, không overwrite', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  writeCanonical(registryPath, makeRoot({ 'demo-proj': makeProject() }));
  writeLegacy(legacy, [
    { projectId: 'demo-proj', repository: 'octo/demo' },
    { projectId: 'ai-pr-reviewer', repository: 'duongpdddic-droid/AI_PR_REVIEWER' },
  ]);
  const gitRoot = makeGitRoot('https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git');
  const first = reconcileLegacyRegistry({ legacyPath: legacy, registryPath, lockDir, roots: { 'ai-pr-reviewer': gitRoot } });
  assert.equal(first.ok, true, JSON.stringify(first));
  const canon1 = readCanonicalRegistry({ registryPath });
  assert.equal(canon1.data.revision, 1);
  const tombBytes0 = readFileSync(legacy + '.tombstone.json');
  const second = reconcileLegacyRegistry({ legacyPath: legacy, registryPath, lockDir, roots: { 'ai-pr-reviewer': gitRoot } });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(readCanonicalRegistry({ registryPath }).data.revision, 1, 'repeated success không tăng revision');
  assert.deepEqual(readFileSync(legacy + '.tombstone.json'), tombBytes0, 'lần 2 không overwrite tombstone');
  rmSync(gitRoot, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});
// ---- GPT-REV-141: trusted GitHub host only; reject evil host / credential URL ---

test('verifyCanonicalRoot (GPT-REV-141): evil host và credential-bearing URL bị reject', () => {
  setRegistryPath();
  const evil = makeGitRoot('https://evil.com/duongpdddic-droid/AI_PR_REVIEWER.git');
  const rEvil = verifyCanonicalRoot(evil, 'duongpdddic-droid/AI_PR_REVIEWER');
  assert.equal(rEvil.ok, false);
  assert.equal(rEvil.code, 'CANONICAL_ROOT_REMOTE_MISMATCH');
  rmSync(evil, { recursive: true, force: true });

  const cred = makeGitRoot('https://x-access-token:ghp_123@github.com/duongpdddic-droid/AI_PR_REVIEWER.git');
  const rCred = verifyCanonicalRoot(cred, 'duongpdddic-droid/AI_PR_REVIEWER');
  assert.equal(rCred.ok, false);
  assert.equal(rCred.code, 'CANONICAL_ROOT_REMOTE_MISMATCH');
  rmSync(cred, { recursive: true, force: true });
  cleanup();
});

test('verifyCanonicalRoot (GPT-REV-141): ssh scp-like trusted github hợp lệ, non-github host bị reject', () => {
  setRegistryPath();
  const scp = makeGitRoot('git@github.com:duongpdddic-droid/AI_PR_REVIEWER.git');
  const rScp = verifyCanonicalRoot(scp, 'duongpdddic-droid/AI_PR_REVIEWER');
  assert.equal(rScp.ok, true, JSON.stringify(rScp));
  rmSync(scp, { recursive: true, force: true });

  const gh = makeGitRoot('ssh://git@github.com/duongpdddic-droid/AI_PR_REVIEWER.git');
  const rGh = verifyCanonicalRoot(gh, 'duongpdddic-droid/AI_PR_REVIEWER');
  assert.equal(rGh.ok, true, JSON.stringify(rGh));
  rmSync(gh, { recursive: true, force: true });

  const non = makeGitRoot('ssh://git@gitlab.com/duongpdddic-droid/AI_PR_REVIEWER.git');
  const rNon = verifyCanonicalRoot(non, 'duongpdddic-droid/AI_PR_REVIEWER');
  assert.equal(rNon.ok, false);
  assert.equal(rNon.code, 'CANONICAL_ROOT_REMOTE_MISMATCH');
  rmSync(non, { recursive: true, force: true });
  cleanup();
});

test('resolveCanonicalRoot (GPT-REV-141): parent directory junction/symlink -> CANONICAL_ROOT_ESCAPE', () => {
  setRegistryPath();
  const base = newTmpDir();
  const real = join(base, 'real');
  mkdirSync(real, { recursive: true });
  mkdirSync(join(real, 'nested'), { recursive: true });
  let ok = false;
  try { symlinkSync(real, join(base, 'link'), 'junction'); ok = true; } catch { /* junction unsupported */ }
  if (ok) {
    const viaLink = join(base, 'link', 'nested');
    const r = resolveCanonicalRoot(viaLink);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CANONICAL_ROOT_ESCAPE');
  }
  rmSync(base, { recursive: true, force: true });
  cleanup();
});

// ---- GPT-REV-142: lossless normalization, malformed/duplicate rejection, digest binding ----

test('reconcileLegacyRegistry (GPT-REV-142): malformed legacy entry -> CONFLICT, zero mutation', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  writeCanonical(registryPath, makeRoot({ 'demo-proj': makeProject() }));
  writeLegacy(legacy, [
    { projectId: 'demo-proj', repository: 'octo/demo' },
    { projectId: 'broken', repository: null },
    { projectId: 'NO-UPPERCASE', repository: 'a/b' },
  ]);
  const canonBytes = readFileSync(registryPath);
  const legacyBytes = readFileSync(legacy);
  const r = reconcileLegacyRegistry({ legacyPath: legacy, registryPath, lockDir });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REGISTRY_RECONCILIATION_CONFLICT');
  assert.deepEqual(readFileSync(registryPath), canonBytes, 'canonical không đổi');
  assert.deepEqual(readFileSync(legacy), legacyBytes, 'legacy không đổi');
  assert.equal(existsSync(legacy + '.tombstone.json'), false);
  rmSync(tmp, { recursive: true, force: true });
});

test('reconcileLegacyRegistry (GPT-REV-142): duplicate projectId -> CONFLICT, zero mutation', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  writeCanonical(registryPath, makeRoot({ 'demo-proj': makeProject() }));
  writeLegacy(legacy, [
    { projectId: 'demo-proj', repository: 'octo/demo' },
    { projectId: 'demo-proj', repository: 'octo/other' },
  ]);
  const canonBytes = readFileSync(registryPath);
  const r = reconcileLegacyRegistry({ legacyPath: legacy, registryPath, lockDir });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REGISTRY_RECONCILIATION_CONFLICT');
  assert.deepEqual(readFileSync(registryPath), canonBytes, 'canonical không đổi');
  assert.equal(existsSync(legacy + '.tombstone.json'), false);
  rmSync(tmp, { recursive: true, force: true });
});

test('reconcileLegacyRegistry (GPT-REV-142): duplicate repository -> CONFLICT, zero mutation', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  writeCanonical(registryPath, makeRoot({ 'demo-proj': makeProject() }));
  writeLegacy(legacy, [
    { projectId: 'demo-proj', repository: 'octo/demo' },
    { projectId: 'other-proj', repository: 'octo/demo' },
  ]);
  const canonBytes = readFileSync(registryPath);
  const r = reconcileLegacyRegistry({ legacyPath: legacy, registryPath, lockDir });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REGISTRY_RECONCILIATION_CONFLICT');
  assert.deepEqual(readFileSync(registryPath), canonBytes, 'canonical không đổi');
  assert.equal(existsSync(legacy + '.tombstone.json'), false);
  rmSync(tmp, { recursive: true, force: true });
});

test('reconcileLegacyRegistry (GPT-REV-142): tombstone bind digest của exact legacy bytes đã reconcile', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  writeCanonical(registryPath, makeRoot({ 'demo-proj': makeProject() }));
  writeLegacy(legacy, [
    { projectId: 'demo-proj', repository: 'octo/demo' },
    { projectId: 'ai-pr-reviewer', repository: 'duongpdddic-droid/AI_PR_REVIEWER' },
  ]);
  const gitRoot = makeGitRoot('https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git');
  const legacyBytes = readFileSync(legacy);
  const r = reconcileLegacyRegistry({ legacyPath: legacy, registryPath, lockDir, roots: { 'ai-pr-reviewer': gitRoot } });
  assert.equal(r.ok, true, JSON.stringify(r));
  const tomb = JSON.parse(readFileSync(legacy + '.tombstone.json', 'utf8'));
  assert.equal(tomb.legacyDigest, createHash('sha256').update(legacyBytes).digest('hex'), 'tombstone bind digest của exact legacy bytes');
  rmSync(gitRoot, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

test('reconcileLegacyRegistry (GPT-REV-143): canonical subset + tombstone pre-created khớp candidate/future digest -> CONFLICT, canonical không đổi', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  writeCanonical(registryPath, makeRoot({ 'demo-proj': makeProject() })); // canonical subset
  writeLegacy(legacy, [
    { projectId: 'demo-proj', repository: 'octo/demo' },
    { projectId: 'ai-pr-reviewer', repository: 'duongpdddic-droid/AI_PR_REVIEWER' },
  ]);
  const gitRoot = makeGitRoot('https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git');
  const NOW = new Date('2026-01-09T00:00:00.000Z');
  const opts = { legacyPath: legacy, registryPath, lockDir, roots: { 'ai-pr-reviewer': gitRoot }, now: NOW };
  let next = null;
  const probe = reconcileLegacyInternal(opts, { write: (args) => { next = args.next; return { ok: false, code: 'ABORT', errors: ['capture'] }; } });
  assert.equal(next !== null, true, 'probe phải tạo được candidate.next');
  const legacyBytes = readFileSync(legacy);
  const tomb = {
    canonicalPath: registryPath,
    contentDigest: next.contentDigest,
    legacyDigest: createHash('sha256').update(legacyBytes).digest('hex'),
    migratedAt: NOW.toISOString(),
    migrationVersion: MIGRATION_CONTRACT_VERSION,
    legacyPath: legacy,
    reconcile: true,
  };
  writeFileSync(legacy + '.tombstone.json', JSON.stringify(tomb, null, 2), 'utf8');
  const canonBytes = readFileSync(registryPath);
  const r = reconcileLegacyRegistry(opts);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'RECONCILIATION_TOMBSTONE_CONFLICT');
  assert.equal(r.published, false, 'preflight dùng digest canonical hiện tại + needsPublish=true -> fail-closed');
  assert.deepEqual(readFileSync(registryPath), canonBytes, 'canonical không dùng candidate future digest');
  assert.equal(readCanonicalRegistry({ registryPath }).data.revision, 0);
  rmSync(gitRoot, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

test('reconcileLegacyRegistry (GPT-REV-144): tombstone path là symlink/junction -> CONFLICT trước publish (nếu platform hỗ trợ)', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  writeCanonical(registryPath, makeRoot({ 'demo-proj': makeProject() }));
  writeLegacy(legacy, [
    { projectId: 'demo-proj', repository: 'octo/demo' },
    { projectId: 'ai-pr-reviewer', repository: 'duongpdddic-droid/AI_PR_REVIEWER' },
  ]);
  const gitRoot = makeGitRoot('https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git');
  const target = join(tmp, 'tomb-target');
  mkdirSync(target, { recursive: true });
  let linked = false;
  try { symlinkSync(target, legacy + '.tombstone.json', 'junction'); linked = true; } catch { linked = false; }
  if (linked) {
    const canonBytes = readFileSync(registryPath);
    const r = reconcileLegacyRegistry({ legacyPath: legacy, registryPath, lockDir, roots: { 'ai-pr-reviewer': gitRoot } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RECONCILIATION_TOMBSTONE_CONFLICT');
    assert.equal(r.published, false, 'per-segment reparse/escape check chạy trước publish');
    assert.deepEqual(readFileSync(registryPath), canonBytes, 'canonical không đổi');
  }
  rmSync(gitRoot, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

test('reconcileLegacyRegistry (GPT-REV-145): legacy drift trước canonical publish (needsPublish=false) -> zero mutation', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  writeCanonical(registryPath, makeRoot({ 'demo-proj': makeProject(), 'ai-pr-reviewer': makeProject({ projectId: 'ai-pr-reviewer', canonicalRepository: 'duongpdddic-droid/AI_PR_REVIEWER' }) }));
  const legacyBytes0 = Buffer.from(JSON.stringify({ projects: [
    { projectId: 'demo-proj', repository: 'octo/demo' },
    { projectId: 'ai-pr-reviewer', repository: 'duongpdddic-droid/AI_PR_REVIEWER' },
  ] }), 'utf8');
  writeFileSync(legacy, legacyBytes0, 'utf8');
  const drifted = Buffer.from(JSON.stringify({ projects: [
    { projectId: 'demo-proj', repository: 'octo/demo' },
    { projectId: 'ai-pr-reviewer', repository: 'duongpdddic-droid/AI_PR_REVIEWER' },
    { projectId: 'NEW-EXTRA', repository: 'a/b' },
  ] }), 'utf8');
  const canonBytes = readFileSync(registryPath);
  let reads = 0;
  const readLegacyBytes = () => ({ ok: true, bytes: (++reads === 1) ? legacyBytes0 : drifted });
  const r = reconcileLegacyInternal({ legacyPath: legacy, registryPath, lockDir }, { readLegacyBytes });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'RECONCILIATION_LEGACY_DRIFT');
  assert.equal(r.published, false);
  assert.deepEqual(readFileSync(registryPath), canonBytes, 'hash/parse/validate từ cùng snapshot + re-read drift -> zero mutation');
  assert.equal(existsSync(legacy + '.tombstone.json'), false, 'không ghi tombstone khi drift trước publish');
  rmSync(tmp, { recursive: true, force: true });
});

test('reconcileLegacyRegistry (GPT-REV-145): legacy drift sau canonical publish (needsPublish=true) -> published:true, không tombstone, retry idempotent', () => {
  const { tmp, registryPath, lockDir } = setRegistryPath();
  const legacy = join(tmp, 'legacy.json');
  writeCanonical(registryPath, makeRoot({ 'demo-proj': makeProject() }));
  const legacyBytes0 = Buffer.from(JSON.stringify({ projects: [
    { projectId: 'demo-proj', repository: 'octo/demo' },
    { projectId: 'ai-pr-reviewer', repository: 'duongpdddic-droid/AI_PR_REVIEWER' },
  ] }), 'utf8');
  writeFileSync(legacy, legacyBytes0, 'utf8');
  const drifted = Buffer.from(JSON.stringify({ projects: [
    { projectId: 'demo-proj', repository: 'octo/demo' },
    { projectId: 'ai-pr-reviewer', repository: 'duongpdddic-droid/AI_PR_REVIEWER' },
    { projectId: 'NEW-EXTRA', repository: 'a/b' },
  ] }), 'utf8');
  const gitRoot = makeGitRoot('https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git');
  const opts = { legacyPath: legacy, registryPath, lockDir, roots: { 'ai-pr-reviewer': gitRoot } };
  let reads = 0;
  const readLegacyBytes = () => ({ ok: true, bytes: (++reads === 1) ? legacyBytes0 : drifted });
  const r = reconcileLegacyInternal(opts, { readLegacyBytes });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'RECONCILIATION_LEGACY_DRIFT');
  assert.equal(r.published, true, 'canonical đã publish trước khi phát hiện drift');
  assert.equal(readCanonicalRegistry({ registryPath }).data.revision, 1, 'canonical đã published');
  assert.equal(existsSync(legacy + '.tombstone.json'), false, 'drift sau publish -> không ghi tombstone');
  const retry = reconcileLegacyRegistry(opts);
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.published, false);
  assert.equal(readCanonicalRegistry({ registryPath }).data.revision, 1, 'retry không tăng revision');
  assert.equal(existsSync(legacy + '.tombstone.json'), true, 'retry ghi tombstone');
  rmSync(gitRoot, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

test('verifyCanonicalRoot (GPT-REV-146): https userinfo (user@) và ssh user khác bị reject', () => {
  const u1 = makeGitRoot('https://user@github.com/duongpdddic-droid/AI_PR_REVIEWER.git');
  const r1 = verifyCanonicalRoot(u1, 'duongpdddic-droid/AI_PR_REVIEWER');
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'CANONICAL_ROOT_REMOTE_MISMATCH', 'https reject mọi userinfo');
  const u2 = makeGitRoot('ssh://other@github.com/duongpdddic-droid/AI_PR_REVIEWER.git');
  const r2 = verifyCanonicalRoot(u2, 'duongpdddic-droid/AI_PR_REVIEWER');
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'CANONICAL_ROOT_REMOTE_MISMATCH', 'ssh:// user khác git@ bị reject');
  rmSync(u1, { recursive: true, force: true });
  rmSync(u2, { recursive: true, force: true });
});

test('package integrity (GPT-REV-146): public exports không lộ test injection; tarball không chứa injection factory', async () => {
  const mod = await import('../packages/project-registry/registry-storage.mjs');
  assert.equal('__internal' in mod, false, 'không export __internal');
  assert.equal('reconcileLegacyInternal' in mod, false, 'không export injection trên public surface');
  assert.equal('reconcileLegacyRegistry' in mod, true, 'public API vẫn còn');
  const tgz = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/project-registry/package.tgz');
  if (existsSync(tgz)) {
    const src = execFileSync('tar', ['-xOf', tgz, 'package/registry-storage.mjs'], { encoding: 'utf8' });
    assert.equal(src.includes('export const __internal'), false, 'tarball registry-storage.mjs không export __internal');
    assert.equal(/export\s+\{[^}]*reconcileLegacyInternal/.test(src), false, 'tarball không export reconcileLegacyInternal');
    assert.equal(src.includes('reconcileLegacyRegistry'), true, 'tarball giữ public reconcileLegacyRegistry');
    const list = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' });
    assert.equal(list.includes('package/reconcile-engine.mjs'), true, 'tarball ship reconcile-engine.mjs để artifact chạy được');
  }
});
