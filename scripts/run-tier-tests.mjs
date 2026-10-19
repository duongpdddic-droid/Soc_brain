#!/usr/bin/env node
// scripts/run-tier-tests.mjs — thin tier wrapper over the ONE canonical
// manifest (tests/tiers.json, loaded through executor-launcher/test-plan).
// It deliberately contains NO second inventory: `all` is the filesystem
// inventory, smoke is a reference subset of tier-owned files, and every
// tier name maps to the same manifest the gate/plan selector uses.
//
// cwd-independent: the repo root is derived from THIS file's location, so
// `node <repo>/scripts/run-tier-tests.mjs t1` works from any directory.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadManifestForRoot, TEST_PLAN_CODES } from '../packages/executor-launcher/test-plan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const listOnly = argv.includes('--list');
const rawTier = (argv.find((a) => a !== '--list') || 't1').toLowerCase();

const ALIASES = {
  t0: 'smoke', tier0: 'smoke', smoke: 'smoke',
  t1: 't1', tier1: 't1', fast: 't1',
  t2: 't2', tier2: 't2', integration: 't2',
  t3: 't3', tier3: 't3', heavy: 't3',
  all: 'all',
};
const LABELS = {
  smoke: 'TIER 0 (SMOKE)',
  t1: 'TIER 1 (PRE-COMMIT)',
  t2: 'TIER 2 (PRE-PUSH / CONTRACT)',
  t3: 'TIER 3 (PRE-RELEASE / SURVIVAL)',
  all: 'ALL TIERS',
};

const key = ALIASES[rawTier];
if (!key) {
  console.error(`Tham so tier khong hop le: ${rawTier}. Dung: t0 | t1 | t2 | t3 | all`);
  process.exit(1);
}

const manifest = loadManifestForRoot(ROOT);
if (!manifest.ok) {
  // Fail-closed with the same manifest gate every other entrypoint uses.
  console.error(`FAIL-CLOSED (${TEST_PLAN_CODES.MANIFEST_INVALID}): ${manifest.reason}`);
  process.exit(1);
}

let targets;
if (key === 'smoke') {
  targets = manifest.smoke.slice();
} else if (key === 'all') {
  targets = manifest.onDisk.slice(); // derived from inventory, never a stored list
} else {
  targets = manifest.tiers[key].files.slice();
}

if (!targets.length) {
  console.error(`FAIL-CLOSED: Danh sach test cho ${LABELS[key]} rong!`);
  process.exit(1);
}

if (listOnly) {
  for (const f of targets) console.log(path.posix.join('tests', f));
  console.error(`[${LABELS[key]}] ${targets.length} files (manifestDigest=${manifest.manifestDigest.slice(0, 12)})`);
  process.exit(0);
}

const minTests = key === 'all' ? 0 : (manifest.tiers[key] && manifest.tiers[key].minTests) || 0;
const args = [
  '--test',
  '--test-reporter=spec',
  ...targets.map((f) => path.posix.join('tests', f)),
];

console.log(`=== RUNNER: ${LABELS[key]} (${targets.length} files | cwd: ${ROOT}) ===`);
const startTotal = Date.now();
const env = { ...process.env };
// Never inherit the nested node test-runner context: it makes a spawned
// `node --test` skip every file and still exit 0 (silent false PASS).
delete env.NODE_TEST_CONTEXT;
const res = spawnSync(process.execPath, args, {
  cwd: ROOT, // resolve targets against the REPO ROOT, not the caller's cwd
  stdio: 'inherit',
  env,
});
const totalElapsed = ((Date.now() - startTotal) / 1000).toFixed(2);
console.log('\n==================================================');
console.log(`KET QUA ${LABELS[key]}: exit code ${res.status ?? 1} (${totalElapsed}s)${minTests ? ` | minTests=${minTests}` : ''}`);

process.exit(res.status ?? 1);
