#!/usr/bin/env node
// bench-fast-path-125.mjs — Issue #125: REAL wall-clock benchmark of the
// deterministic Fast Path (no mocked clocks). Three tiers:
//   A  classifyRoute() pure gate evaluation
//   B  runFastPath() end-to-end with REAL telemetry persistence
//      (provision/execute/verify are injected no-ops — the measured cost is
//      the deterministic admission overhead, not git provisioning)
//   C  one full Node subprocess per classification (CLI-shaped latency,
//      includes Node boot — what a real CLI caller sees)
// Determinism is asserted: the route MUST be stable across every iteration.
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAST_PATH_ENTRY = path.join(HERE, '..', 'packages', 'fast-path', 'fast-path.mjs');

const ELIGIBLE = {
  scopeNote: 'benchmark: deterministic wall-clock measurement harness (Issue #125)',
  acceptanceTests: ['node scripts/bench-fast-path-125.mjs exits 0 with a stable FAST_PATH route'],
  securitySensitive: false,
  schemaOrDataMigration: false,
  multiRepo: false,
  destructiveMutation: false,
  uncertainty: 'low',
};

const ITER_A = 1000;
const ITER_B = 200;
const ITER_C = 10;

const { classifyRoute, FAST_ROUTE, runFastPath } = await import(pathToFileURL(FAST_PATH_ENTRY).href);

function stats(samples) {
  const s = [...samples].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], p50: q(0.5), p95: q(0.95), max: s[s.length - 1] };
}
const r2 = (x) => Math.round(x * 100) / 100;

// warmup
for (let i = 0; i < 50; i += 1) classifyRoute(ELIGIBLE);

// Tier A — pure classification
const a = [];
for (let i = 0; i < ITER_A; i += 1) {
  const t0 = performance.now();
  const r = classifyRoute(ELIGIBLE);
  const t1 = performance.now();
  if (r.route !== FAST_ROUTE) throw new Error(`tier A iteration ${i}: route drifted to ${r.route}`);
  a.push(t1 - t0);
}

// Tier B — runFastPath e2e, real fs telemetry, injected deterministic seams
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-bench-'));
const b = [];
for (let i = 0; i < ITER_B; i += 1) {
  const stateDir = fs.mkdtempSync(path.join(tmpRoot, 'it-'));
  const t0 = performance.now();
  const r = await runFastPath({
    descriptor: ELIGIBLE,
    worktreesRoot: stateDir,
    repo: 'duongpdddic-droid/soc_brain',
    issueNumber: 125,
    baseSha: 'a'.repeat(40),
    stateDir,
    provisionWorktree: async () => ({ ok: true, path: path.join(stateDir, 'wt'), branch: 'bench' }),
    execute: async () => ({ ok: true }),
    verify: async () => ({ ok: true, verdict: 'PASS' }),
  });
  const t1 = performance.now();
  if (r.terminal !== 'HANDOFF_READY') throw new Error(`tier B iteration ${i}: terminal=${r.terminal}`);
  if (!fs.existsSync(path.join(stateDir, 'fast-path'))) throw new Error(`tier B iteration ${i}: telemetry dir missing`);
  b.push(t1 - t0);
}

// Tier C — full subprocess per classification (Node boot included)
const c = [];
for (let i = 0; i < ITER_C; i += 1) {
  const t0 = performance.now();
  const p = spawnSync(process.execPath, ['--input-type=module', '--eval', (
    `const { classifyRoute } = await import(${JSON.stringify(pathToFileURL(FAST_PATH_ENTRY).href)});\n`
    + `if (classifyRoute(${JSON.stringify(ELIGIBLE)}).route !== 'FAST_PATH') process.exit(3);\n`
  )], { encoding: 'utf8', timeout: 30000 });
  const t1 = performance.now();
  if (p.status !== 0) throw new Error(`tier C iteration ${i}: exit=${p.status} stderr=${p.stderr}`);
  c.push(t1 - t0);
}

const fmt = (name, s) => `${name}  n=${s.n}  min=${r2(s.min)}ms  p50=${r2(s.p50)}ms  p95=${r2(s.p95)}ms  max=${r2(s.max)}ms`;
console.log('Issue #125 fast-path wall-clock benchmark (real clocks, no mocks)');
console.log(fmt('A classifyRoute (pure)           ', stats(a)));
console.log(fmt('B runFastPath e2e + fs telemetry ', stats(b)));
console.log(fmt('C classify subprocess (Node boot)', stats(c)));
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log('DETERMINISM OK: route stable across all iterations');
