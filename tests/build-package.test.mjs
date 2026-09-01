// tests/build-package.test.mjs — Validate the built @soc/project-registry artifact.
// Ensures package.tgz + INTEGRITY.json exist, integrity matches re-computed SHA-512,
// provenance (commit) matches HEAD, and JCS vectors inside the tarball pass.
import { readFileSync, existsSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const artifactDir = join(repoRoot, 'packages', 'project-registry');
const tgzPath = join(artifactDir, 'package.tgz');
const integrityPath = join(artifactDir, 'INTEGRITY.json');

test('build artifact exists', () => {
  assert.ok(existsSync(tgzPath), `missing ${tgzPath}`);
  assert.ok(existsSync(integrityPath), `missing ${integrityPath}`);
  const tarballSize = statSync(tgzPath).size;
  assert.ok(tarballSize > 500, 'package.tgz too small');
});

test('INTEGRITY.json matches recomputed SHA-512 of tarball', () => {
  const manifest = JSON.parse(readFileSync(integrityPath, 'utf8'));
  assert.equal(manifest.name, '@soc/project-registry');
  assert.equal(manifest.algorithm, 'sha512');
  assert.equal(manifest.artifact, 'package.tgz');
  assert.ok(manifest.jcsVectors);

  const actualSha512 = createHash('sha512').update(readFileSync(tgzPath)).digest('base64');
  const expected = `sha512-${actualSha512}`;
  assert.equal(manifest.integrity, expected, 'integrity mismatch');
});

test('provenance: INTEGRITY.json commit is valid and source files match repo', () => {
  const manifest = JSON.parse(readFileSync(integrityPath, 'utf8'));
  // manifest.commit must be a real commit reachable from HEAD.
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', manifest.commit, 'HEAD'],
    { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(ancestor.status, 0, `INTEGRITY.json commit ${manifest.commit} not reachable from HEAD`);

  // Extract and byte-compare source files against the repo's current source.
  const tmp = mkdtempSync(join(tmpdir(), 'soc-prov-test-'));
  try {
    const tar = spawnSync('tar', ['-xzf', tgzPath, '-C', tmp], { encoding: 'utf8' });
    assert.equal(tar.status, 0, `tar extract failed: ${tar.stderr}`);
    for (const f of ['project-registry.mjs', 'registry-storage.mjs', 'canonical-jcs.mjs', 'registry-schema.json', 'project-manifest-schema.json']) {
      const inTar = readFileSync(join(tmp, 'package', f));
      const inRepo = readFileSync(join(artifactDir, f));
      assert.deepEqual(inTar, inRepo, `tarball ${f} differs from repo source`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('package.tgz extracts to expected structure and JCS vectors pass', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'soc-build-test-'));
  try {
    // Extract
    const tar = spawnSync('tar', ['-xzf', tgzPath, '-C', tmp], { encoding: 'utf8' });
    assert.equal(tar.status, 0, `tar extract failed: ${tar.stderr}`);
    const pkgDir = join(tmp, 'package');
    assert.ok(existsSync(join(pkgDir, 'package.json')), 'no package.json');
    assert.ok(existsSync(join(pkgDir, 'project-registry.mjs')), 'no project-registry.mjs');
    assert.ok(existsSync(join(pkgDir, 'registry-storage.mjs')), 'no registry-storage.mjs');
    assert.ok(existsSync(join(pkgDir, 'canonical-jcs.mjs')), 'no canonical-jcs.mjs');
    assert.ok(existsSync(join(pkgDir, 'registry-schema.json')), 'no registry-schema.json');
    assert.ok(existsSync(join(pkgDir, 'project-manifest-schema.json')), 'no project-manifest-schema.json');

    // Verify package.json fields
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, '@soc/project-registry');
    assert.equal(pkg.main, 'project-registry.mjs');
    assert.ok(pkg.sourceCommit);
    assert.equal(pkg.version, JSON.parse(readFileSync(integrityPath, 'utf8')).version);

    // Run JCS self-check from the extracted tarball's canonical-jcs.mjs
    // Write a temp mjs script that imports from the extracted dir and runs runJCSSelfCheck.
    const checkScript = join(tmp, 'check-jcs.mjs');
    writeFileSync(checkScript, `
      import { runJCSSelfCheck } from './package/canonical-jcs.mjs';
      const result = runJCSSelfCheck();
      if (!result.ok) process.exit(1);
      process.exit(0);
    `, 'utf8');
    const jcs = spawnSync('node', [checkScript], { cwd: tmp, encoding: 'utf8' });
    assert.equal(jcs.status, 0, `JCS vectors from tarball failed: ${jcs.stderr || jcs.stdout}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});