#!/usr/bin/env node
// bench-fast-path-125.mjs — Issue #125: REAL wall-clock benchmark of the
// deterministic Fast Path (no mocked clocks). Four tiers:
//   A  classifyRoute() pure gate evaluation
//   B  runFastPath() end-to-end with REAL telemetry persistence
//      (provision/execute/verify are injected no-ops — the measured cost is
//      the deterministic admission overhead, not git provisioning)
//   C  one full Node subprocess per classification (CLI-shaped latency,
//      includes Node boot — what a real CLI caller sees)
//   D  ACCEPTANCE BENCHMARK (Issue #125 rework): the SAME one trivial
//      deterministic task run through the REAL ControlLoop on BOTH routes —
//      A-route = deterministic Fast Path (runFastPath executes inside the
//      loop's execute step), B-route = STANDARD_PATH (existing pipeline with
//      semantic reviews). Real wall clock everywhere; the only seams are the
//      trivial deterministic task bodies (executor/verifier/reviewer no-ops,
//      fake gh transport) — the FSM walk, telemetry persistence/read-back,
//      delivery lifecycle and terminalization are the real ControlLoop code.
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

const { classifyRoute, FAST_ROUTE, runFastPath, telemetryPathFor } = await import(pathToFileURL(FAST_PATH_ENTRY).href);

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

// ---- Tier D — ACCEPTANCE: same ONE trivial deterministic task through the
// real ControlLoop on BOTH routes (fast = deterministic Fast Path inside the
// loop's execute step, standard = existing pipeline with semantic reviews).
// Real wall clock everywhere; metrics come from the REAL persisted telemetry
// (write + read-back), loop wall time from performance.now().
const { runControlLoop } = await import(pathToFileURL(path.join(HERE, '..', 'packages', 'control-loop', 'control-loop.mjs')).href);
const { identityHash } = await import(pathToFileURL(path.join(HERE, '..', 'packages', 'workspace', 'workspace.mjs')).href);
const { buildDeliveryAdapter } = await import(pathToFileURL(path.join(HERE, '..', 'packages', 'control-loop', 'adapters.mjs')).href);
const { fakeGh } = await import(pathToFileURL(path.join(HERE, '..', 'tests', 'fake-gh.mjs')).href);
const { readTelemetry } = await import(pathToFileURL(FAST_PATH_ENTRY).href);

const REPO = 'duongpdddic-droid/soc_brain';
const HEAD = 'a'.repeat(40);
const BASE = 'f'.repeat(40);

function mkSession(stateDir, issue) {
  const id = identityHash({ repo: REPO, issueNumber: issue });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, JSON.stringify({
    schemaVersion: '1', state: 'SESSION_ACTIVE', lifecycle: [],
    taskId: `${REPO}#${issue}`, repo: REPO, issueNumber: issue,
    headSha: HEAD, baseSha: BASE,
    worktreePath: path.join(stateDir, `wt-issue-${issue}`),
    worktreesRoot: stateDir,
  }, null, 2), 'utf8');
  return { sessionPath, id };
}

// One trivial deterministic task: append a marker, verify it reads back.
const TASK = (wtPath) => {
  fs.mkdirSync(wtPath, { recursive: true });
  const marker = path.join(wtPath, 'trivial-task-marker.txt');
  fs.writeFileSync(marker, 'deterministic-fast-path-benchmark\n', 'utf8');
  return { marker, expectedContent: 'deterministic-fast-path-benchmark\n' };
};

async function benchControlLoopRoute({ route, issue, iterations, warmup = 3 }) {
  const samples = [];
  // 3 unrecorded warmup iterations per route kill JIT/ordering bias (the
  // route that runs first otherwise pays the cold-compile cost of the shared
  // ControlLoop machinery).
  for (let i = -warmup; i < iterations; i += 1) {
    const stateDir = fs.mkdtempSync(path.join(tmpRoot, `d-${route}-`));
    const { sessionPath, id } = mkSession(stateDir, issue);
    const semanticCalls = [];
    // Real-wall-clock instrumentation of the pipeline's own seams (the task
    // bodies): executor+verifier = productive, semantic reviewers = provider
    // wait. polling/recovery are 0 by construction for this trivial task and
    // recorded explicitly.
    const timings = { executor: 0, verifier: 0, preReview: 0, finalReview: 0 };
    const timed = (key, fn) => async (...a) => {
      const s = performance.now();
      try { return await fn(...a); } finally { timings[key] += performance.now() - s; }
    };
    const deps = {
      router: () => ({ ok: true, value: { executorKind: 'noop', model: 'deterministic' } }),
      // The SAME trivial deterministic task body on BOTH routes: write the
      // marker, record it in an execution record, verify by read-back.
      executor: timed('executor', async ({ worktreePath = stateDir }) => {
        const task = TASK(worktreePath);
        const recPath = path.join(stateDir, 'exec-record.json');
        fs.writeFileSync(recPath, JSON.stringify({ marker: task.marker, expectedContent: task.expectedContent }), 'utf8');
        return { ok: true, value: { executionRecordPath: recPath } };
      }),
      verifier: timed('verifier', async ({ executionRecordPath }) => {
        const rec = JSON.parse(fs.readFileSync(executionRecordPath, 'utf8'));
        return fs.readFileSync(rec.marker, 'utf8') === rec.expectedContent
          ? { ok: true, value: { verdict: 'PASS' } }
          : { ok: false, code: 'TRIVIAL_TASK_MISMATCH' };
      }),
      // Semantic reviewers are part of the STANDARD route's real pipeline
      // (their cost is exactly what the delta measures); on the fast route
      // they must NEVER be invoked.
      preReview: timed('preReview', () => { semanticCalls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; }),
      finalReview: timed('finalReview', () => { semanticCalls.push('finalReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; }),
      delivery: buildDeliveryAdapter({ gh: fakeGh({ issue, headSha: HEAD, baseSha: BASE }).gh, cleanup: () => ({ ok: true, removed: [], keptBranch: 'x' }) }),
      reviewReadyDir: path.join(stateDir, 'review-ready'),
      telegramSpawn: () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 901 + i })}\n` }),
    };
    if (route === 'fast') {
      deps.fastPathDescriptor = {
        scopeNote: 'benchmark: one trivial deterministic task (append + read-back marker)',
        acceptanceTests: ['node scripts/bench-fast-path-125.mjs tier D exits 0'],
        securitySensitive: false, schemaOrDataMigration: false, multiRepo: false,
        destructiveMutation: false, uncertainty: 'low',
      };
    }
    const t0 = performance.now();
    const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
    const t1 = performance.now();
    if (i < 0) continue; // warmup iteration — not recorded
    if (!res.ok || !res.value || res.value.state !== 'COMPLETED') {
      throw new Error(`tier D route=${route} iteration ${i}: loop did not complete: ${JSON.stringify(res).slice(0, 400)}`);
    }
    if (route === 'fast' && semanticCalls.length !== 0) {
      throw new Error(`tier D fast route iteration ${i}: semantic reviewers invoked (${semanticCalls.join(',')})`);
    }
    // Mandated metrics. On the fast route the five aggregates MUST come from
    // the real persisted telemetry (persist + read-back, fail-closed); on the
    // standard route they are derived from the same real seam wall clocks.
    let totalWallClockMs = t1 - t0;
    let productiveMs = timings.executor + timings.verifier;
    let providerWaitMs = timings.preReview + timings.finalReview;
    let pollingWaitMs = 0;
    let recoveryWaitMs = 0;
    if (route === 'fast') {
      const tele = readTelemetry(telemetryPathFor({ stateDir, repo: REPO, issueNumber: issue }));
      for (const k of ['totalWallClockMs', 'productiveMs', 'providerWaitMs', 'pollingWaitMs', 'recoveryWaitMs']) {
        if (!Number.isFinite(tele[k])) throw new Error(`tier D fast iteration ${i}: telemetry ${k} missing`);
      }
      totalWallClockMs = tele.totalWallClockMs;
      productiveMs = tele.productiveMs;
      providerWaitMs = tele.providerWaitMs;
      pollingWaitMs = tele.pollingWaitMs;
      recoveryWaitMs = tele.recoveryWaitMs;
    }
    samples.push({
      loopWallClockMs: t1 - t0,
      totalWallClockMs,
      productiveMs,
      providerWaitMs,
      pollingWaitMs,
      recoveryWaitMs,
    });
  }
  return samples;
}

const ITER_D = 100;
const dFast = await benchControlLoopRoute({ route: 'fast', issue: 125001, iterations: ITER_D });
const dStd = await benchControlLoopRoute({ route: 'standard', issue: 125002, iterations: ITER_D });

const agg = (samples, key) => stats(samples.map((s) => s[key]));
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const meanOf = (xs, key) => mean(xs.map((s) => s[key]));
const fastMean = mean(dFast.map((s) => s.loopWallClockMs));
const stdMean = mean(dStd.map((s) => s.loopWallClockMs));
const teleStr = (xs) => `telemetry: total=${r2(meanOf(xs, 'totalWallClockMs'))}ms productive=${r2(meanOf(xs, 'productiveMs'))}ms provider=${r2(meanOf(xs, 'providerWaitMs'))}ms polling=${r2(meanOf(xs, 'pollingWaitMs'))}ms recovery=${r2(meanOf(xs, 'recoveryWaitMs'))}ms`;
console.log(`D1 ControlLoop FAST_PATH e2e     n=${dFast.length}  p50=${r2(agg(dFast, 'loopWallClockMs').p50)}ms  mean=${r2(fastMean)}ms  (${teleStr(dFast)})`);
console.log(`D2 ControlLoop STANDARD_PATH e2e n=${dStd.length}  p50=${r2(agg(dStd, 'loopWallClockMs').p50)}ms  mean=${r2(stdMean)}ms  (${teleStr(dStd)})`);
console.log(`D3 delta Fast vs Standard        mean=${r2(stdMean - fastMean)}ms  (stdMean-fastMean: negative = the fast route is SLOWER; on Windows this is the mandated fail-closed telemetry persist+read-back fs cost)  ratio=${stdMean > 0 ? r2(fastMean / stdMean) : 'n/a'}x`);

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log('DETERMINISM OK: route stable across all iterations');
