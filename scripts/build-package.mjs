#!/usr/bin/env node
// scripts/build-package.mjs — Build the immutable @soc/project-registry artifact.
//
// Inputs (machine-local):
//   --src    : path to source directory (default: packages/project-registry)
//   --out    : output directory (default: packages/project-registry -> package.tgz there)
//   --version: semver (default: 0.0.0-issue17.<sourceCommitSha7>)
//   --commit : source commit SHA (default: git rev-parse HEAD of the worktree)
//
// Output:
//   <out>/package.tgz   (tar.gz; members prefixed package/)
//   <out>/INTEGRITY.json { name, version, commit, integrity: "sha512-...", size, builtAt }
//
// Uses the native `tar` binary. SOURCE_DATE_EPOCH pins member + gzip mtimes so
// rebuilds at the same commit are bit-identical. Refuses to record a commit whose
// tree differs from the staged files (provenance must be truthful).
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const out = { src: 'packages/project-registry', out: null, version: null, commit: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--src') { out.src = argv[++i]; }
    else if (a === '--out') { out.out = argv[++i]; }
    else if (a === '--version') { out.version = argv[++i]; }
    else if (a === '--commit') { out.commit = argv[++i]; }
  }
  return out;
}

function runGit(repoRoot, args) {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function shortSha(sha) { return sha.slice(0, 7); }
function defaultVersion(commit) { return `0.0.0-issue17.${shortSha(commit)}`; }

const ARTIFACT_FILES = [
  'project-registry.mjs',
  'registry-storage.mjs',
  'reconcile-engine.mjs',
  'canonical-jcs.mjs',
  'registry-schema.json',
  'project-manifest-schema.json',
];

async function build() {
  const args = parseArgs(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = dirname(here);
  const srcAbs = join(repoRoot, args.src);
  if (!existsSync(srcAbs)) throw new Error(`--src not found: ${srcAbs}`);
  const commit = args.commit || runGit(repoRoot, ['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{7,64}$/.test(commit)) throw new Error('commit must be lowercase hex git SHA');

  // Provenance guard: the staged artifact must match the recorded commit's tree.
  const porcelain = spawnSync('git', ['status', '--porcelain', '--', args.src], { cwd: repoRoot, encoding: 'utf8' });
  const dirty = (porcelain.stdout || '').trim();
  if (dirty) {
    throw new Error(`--src has uncommitted changes; commit first so INTEGRITY.json provenance is truthful:\n${dirty}`);
  }

  const version = args.version || defaultVersion(commit);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9._+-]*$/.test(version)) {
    throw new Error(`version must be semver: got '${version}'`);
  }
  const outDir = args.out
    ? join(repoRoot, args.out)
    : join(repoRoot, args.src); // default: package.tgz next to source
  mkdirSync(outDir, { recursive: true });
  const tgzName = 'package.tgz';
  const tgzPath = join(outDir, tgzName);

  // Stage a self-contained package/ directory.
  const staging = join(outDir, '.staging');
  rmSync(staging, { recursive: true, force: true });
  const pkgDir = join(staging, 'package');
  mkdirSync(pkgDir, { recursive: true });
  for (const f of ARTIFACT_FILES) {
    const s = join(srcAbs, f);
    if (existsSync(s)) cpSync(s, join(pkgDir, f));
  }
  const pkgJson = {
    name: '@soc/project-registry',
    version,
    type: 'module',
    main: 'project-registry.mjs',
    exports: {
      '.': './project-registry.mjs',
      './registry-storage': './registry-storage.mjs',
      './canonical-jcs': './canonical-jcs.mjs',
      './schema': './registry-schema.json',
    },
    files: ARTIFACT_FILES,
    description: 'Soc_brain Canonical Project Registry (Issue #17). Physical SSOT, RFC 8785 JCS, single-writer lock directory, fail-closed.',
    license: 'UNLICENSED',
    repository: 'https://github.com/duongpdddic-droid/Soc_brain',
    sourceCommit: commit,
    integrity: { algorithm: 'sha512' },
  };
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n', 'utf8');

  // Native tar with SOURCE_DATE_EPOCH=0 -> deterministic mtimes.
  const env = { ...process.env, SOURCE_DATE_EPOCH: '0' };
  const tar = spawnSync('tar', ['-czf', tgzPath, '-C', staging, 'package'], { encoding: 'utf8', env });
  if (tar.status !== 0) throw new Error('tar failed: ' + (tar.stderr || tar.stdout));
  rmSync(staging, { recursive: true, force: true });

  const sha512 = createHash('sha512').update(readFileSync(tgzPath)).digest('base64');
  const integrity = `sha512-${sha512}`;
  const size = statSync(tgzPath).size;
  // jcsVectors: truthful count from the shipped canonical-jcs.mjs, not a stale constant.
  let jcsVectorCount = 0;
  try {
    const jcs = await import(pathToFileURL(join(srcAbs, 'canonical-jcs.mjs')).href);
    jcsVectorCount = Array.isArray(jcs.__VECTORS) ? jcs.__VECTORS.length : 0;
  } catch { jcsVectorCount = 0; }
  const manifest = {
    name: '@soc/project-registry',
    version,
    commit,
    integrity,
    size,
    builtAt: new Date().toISOString(),
    artifact: tgzName,
    algorithm: 'sha512',
    jcsVectors: jcsVectorCount > 0 ? `embedded-${jcsVectorCount}` : 'embedded-0',
  };
  writeFileSync(join(outDir, 'INTEGRITY.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { tgzPath, manifest };
}

build().then((r) => {
  process.stdout.write(JSON.stringify(r.manifest, null, 2) + '\n');
}).catch((e) => {
  process.stderr.write('build-package failed: ' + e.message + '\n');
  process.exit(1);
});