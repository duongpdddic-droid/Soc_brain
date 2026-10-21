#!/usr/bin/env node
// scripts/run-tier.mjs — tiered, fail-closed test runner for Soc_brain.
// The `--gate` path delegates to the ONE canonical planner
// (packages/executor-launcher/test-plan.mjs): same manifest, same selector,
// same TAP evaluation as the control-plane active test gate. This file keeps
// the CLI, tier timing and evidence persistence around that shared core.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeTempEnv } from '../packages/temp-hygiene/temp-hygiene.mjs';
import {
  parseTapSummary, evaluateSummary, unitOf, unitsImportedBy,
  loadManifestForRoot, buildTestPlan, selectorDigest,
  buildImportGraph, selectAffectedTests,
} from '../packages/executor-launcher/test-plan.mjs';
import {
  parseFullAuthorization, coversAllTiers, fullRunBanner,
} from '../packages/executor-launcher/full-run-authority.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS_DIR = 'tests';
const MANIFEST = `${TESTS_DIR}/tiers.json`;

export { parseTapSummary, evaluateSummary, unitOf, unitsImportedBy };

function die(code, msg) {
  console.error(`[run-tier] FAIL: ${msg}`);
  process.exit(code);
}

function git(args, { allowFail = false } = {}) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    if (allowFail) return null;
    die(2, `git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  }
  return r.stdout;
}

export function resolveBase(explicit) {
  const ok = (ref) => git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
  if (explicit) {
    if (!ok(explicit)) die(2, `--base / SOC_GATE_BASE '${explicit}' does not resolve to a commit`);
    return explicit;
  }
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) if (ok(ref)) return ref;
  return die(2, 'cannot determine base ref; set SOC_GATE_BASE or pass --base');
}

export function changedFiles(base) {
  const mb = git(['merge-base', base, 'HEAD'], { allowFail: true });
  if (!mb) die(2, `no merge-base between '${base}' and HEAD`);
  const tracked = git(['diff', '--name-only', mb.trim()]).split('\n');
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n');
  return [...new Set([...tracked, ...untracked].map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean))];
}

export function fingerprint() {
  const h = createHash('sha256');
  h.update(git(['rev-parse', 'HEAD']));
  h.update(git(['diff', 'HEAD', '--binary']));
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean).sort();
  for (const f of untracked) {
    h.update(`\0${f}\0`);
    h.update(readFileSync(path.join(ROOT, f)));
  }
  return h.digest('hex');
}

export function loadManifest() {
  const lm = loadManifestForRoot(ROOT);
  if (!lm.ok) die(2, lm.reason);
  return {
    m: {
      tiers: lm.tiers, always: lm.always, coreSubsystems: lm.coreSubsystems,
      ignorePrefixes: lm.ignorePrefixes, ignoreSuffixes: lm.ignoreSuffixes,
    },
    owner: lm.owner,
    onDisk: lm.onDisk,
    lm,
  };
}

// Back-compat selection wrapper: the SAME selector the plan gate and the
// control-plane active runner use (one implementation, one manifest).
let CACHED_GRAPH = null;
export function selectGate({ owner, onDisk, lm }, changed) {
  const manifest = lm || loadManifestForRoot(ROOT);
  if (!manifest.ok) die(2, manifest.reason);
  if (!CACHED_GRAPH) CACHED_GRAPH = buildImportGraph(ROOT);
  const sel = selectAffectedTests({ manifest, graph: CACHED_GRAPH, changed });
  if (sel.fallback) {
    // Unprovable change -> the FULL inventory, never a silent T1+T2 subset.
    const files = onDisk.slice().sort();
    return {
      files,
      reasons: Object.fromEntries(files.map((f) => [f, 'fallback:unmapped-change'])),
      fallback: true,
      unmapped: sel.fullReasons,
      fullReasons: sel.fullReasons,
    };
  }
  return {
    files: sel.selected,
    reasons: sel.reasons,
    fallback: false,
    unmapped: sel.fullReasons,
    fullReasons: sel.fullReasons,
  };
}

export function runFiles(files, { quiet = false, spawnImpl = null } = {}) {
  return new Promise((resolve) => {
    // Accept BOTH the manifest basename form (tier arrays) and the plan's
    // repo-relative `tests/<name>` form — one normalization, never doubled.
    const args = ['--test', '--test-reporter=tap', ...files.map((f) => (f.startsWith(`${TESTS_DIR}/`) ? f : `${TESTS_DIR}/${f}`))];
    const t0 = Date.now();
    const cleanEnv = sanitizeTempEnv({ ...process.env });
    delete cleanEnv.NODE_TEST_CONTEXT;

    const doSpawn = typeof spawnImpl === 'function' ? spawnImpl : spawn;
    const child = doSpawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; if (!quiet) process.stdout.write(d); });
    child.stderr.on('data', (d) => { stderr += d; if (!quiet) process.stderr.write(d); });
    child.on('error', (e) => resolve({ exitCode: -1, stdout, stderr, ms: Date.now() - t0, error: String(e) }));
    child.on('close', (code) => resolve({ exitCode: code, stdout, stderr, ms: Date.now() - t0 }));
  });
}

async function timing(files) {
  const results = [];
  let failures = 0;
  let i = 0;
  console.log(`[run-tier] Dang do thoi gian cho ${files.length} file test...`);
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < files.length) {
      const f = files[i++];
      const r = await runFiles([f], { quiet: true });
      if (r.exitCode !== 0) failures++;
      results.push({ f, s: Number((r.ms / 1000).toFixed(1)), exitCode: r.exitCode });
    }
  }));
  results.sort((a, b) => b.s - a.s);
  for (const r of results) {
    const status = r.exitCode === 0 ? 'OK' : `FAIL(${r.exitCode})`;
    console.log(`${String(r.s).padStart(8)}s  [${status}]  ${r.f}`);
  }
  if (failures > 0) {
    console.error(`[run-tier] TIMING FAIL: Co ${failures} file test bi FAIL trong khi do timing!`);
    process.exit(1);
  }
  process.exit(0);
}

function parseArgs(argv) {
  const a = { tier: null, gate: false, base: process.env.SOC_GATE_BASE || null, list: false, timing: false, mode: process.env.SOC_TEST_PLAN_MODE || 'auto', evidenceDir: process.env.SOC_GATE_EVIDENCE_DIR || 'artifacts/evidence' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--tier') a.tier = argv[++i];
    else if (k === '--gate') a.gate = true;
    else if (k === '--base') a.base = argv[++i];
    else if (k === '--mode') a.mode = argv[++i];
    else if (k === '--authorize-full') a.authorizeFull = true;
    else if (k === '--reason') a.reason = argv[++i];
    else if (k.startsWith('--reason=')) a.reason = k.slice('--reason='.length);
    else if (k === '--list') a.list = true;
    else if (k === '--timing') a.timing = true;
    else if (k === '--evidence-dir') a.evidenceDir = argv[++i];
    else die(2, `unknown argument: ${k}`);
  }
  if (!a.gate && !a.tier) die(2, 'usage: --gate | --tier t1|t2|t3|all [--list] [--timing] [--base ref] [--mode auto|affected|full] [--authorize-full --reason "..."] [--evidence-dir dir]');
  if (!['auto', 'affected', 'full'].includes(a.mode)) die(2, `--mode must be auto|affected|full, got '${a.mode}'`);
  return a;
}

export function buildEvidencePayload({ runId, mode, fingerprintBefore, fingerprintAfter, ok, seconds, selection, runs }) {
  return {
    runId,
    at: new Date().toISOString(),
    mode,
    fingerprintBefore,
    fingerprintAfter,
    workingTreeClean: fingerprintBefore === fingerprintAfter,
    ok,
    seconds: Number(seconds.toFixed(1)),
    selection,
    runs: runs.map((r) => ({
      label: r.label,
      files: r.files,
      exitCode: r.exitCode,
      ms: r.ms,
      summary: r.summary,
      ok: r.ok,
      reasons: r.reasons,
      rawStdout: r.stdout,
      rawStderr: r.stderr
    }))
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = loadManifest();
  const { m } = manifest;
  const plan = [];
  let selection = null;
  let fullRun = null;

  if (args.gate) {
    // The CLI goes through the SAME planner the control-plane active gate
    // uses: one manifest, one selector, one evidence binding.
    const baseRef = args.base || resolveBase(null);
    const built = buildTestPlan({ root: ROOT, base: baseRef, mode: args.mode });
    if (!built.ok) die(2, `${built.code}: ${built.detail}`);
    const p = built.plan;
    selection = {
      base: p.base,
      baseSha: p.baseSha,
      candidateSha: p.candidateSha,
      mode: p.mode,
      status: p.status,
      fullReason: p.fullReason,
      planDigest: p.planDigest,
      manifestDigest: p.manifestDigest,
      selectorVersion: p.selectorVersion,
      changedCount: p.changedCount,
      changedPaths: p.changedPaths,
      fallback: p.mode === 'full',
      files: p.files,
      reasons: p.reasons,
    };
    if (p.status === 'NO_TESTS') {
      // Explicit no-tests state (docs-only / empty changeset): NOT a pass.
      console.error(`[run-tier] RESULT ok=false status=NO_TESTS reason=${p.fullReason} planDigest=${p.planDigest.slice(0, 12)}`);
      process.exit(1);
    }
    plan.push({ label: `gate:${p.mode}`, files: p.files, minTests: 0 });
    // A DERIVED full plan (fullTriggerPaths) is the planner's own decision and
    // carries planDigest evidence; only an EXPLICIT `--mode full` is a
    // self-declared full run and must state its reason.
    if (p.mode === 'full' && args.mode === 'full') fullRun = { fileCount: p.files.length };
  } else {
    const tiers = args.tier === 'all' ? Object.keys(m.tiers) : args.tier.split(',');
    for (const t of tiers) if (!m.tiers[t]) die(2, `unknown tier '${t}'`);
    for (const t of tiers) plan.push({ label: t, files: m.tiers[t].files, minTests: m.tiers[t].minTests || 0 });
    if (args.tier === 'all' || coversAllTiers(tiers, Object.keys(m.tiers))) {
      fullRun = { fileCount: plan.reduce((n, p) => n + p.files.length, 0) };
    }
  }

  if (args.list) {
    for (const p of plan) console.log(`[${p.label}] ${p.files.length} files`);
    if (selection) {
      console.log(`base=${selection.base} baseSha=${selection.baseSha} candidate=${selection.candidateSha} mode=${selection.mode} status=${selection.status} changed=${selection.changedCount} fallback=${selection.fallback} planDigest=${String(selection.planDigest).slice(0, 12)}`);
      if (selection.fullReason) console.log(`fullReason=${selection.fullReason}`);
      for (const [f, why] of Object.entries(selection.reasons)) console.log(`  ${f}  <- ${why}`);
    } else {
      plan.forEach((p) => p.files.forEach((f) => console.log(`  ${f}`)));
    }
    return;
  }

  if (fullRun) {
    const auth = parseFullAuthorization(process.argv.slice(2));
    if (!auth.ok) die(2, `${auth.code}: ${auth.detail}`);
    console.log(fullRunBanner({ reason: auth.reason, fileCount: fullRun.fileCount }));
  }

  if (args.timing) {
    return timing(plan.flatMap((p) => p.files));
  }

  const fpBefore = fingerprint();
  const t0 = Date.now();
  const runs = [];
  let ok = true;
  for (const p of plan) {
    if (p.files.length === 0) { runs.push({ label: p.label, files: 0, exitCode: -1, ms: 0, ok: false, reasons: ['empty selection'], stdout: '', stderr: '' }); ok = false; break; }
    console.log(`[run-tier] ${p.label}: ${p.files.length} files`);
    const r = await runFiles(p.files);
    const summary = parseTapSummary(r.stdout);
    const ev = evaluateSummary({ exitCode: r.exitCode, summary, fileCount: p.files.length, minTests: p.minTests });
    runs.push({ label: p.label, files: p.files.length, exitCode: r.exitCode, ms: r.ms, summary, ok: ev.ok, reasons: ev.reasons, stdout: r.stdout, stderr: r.stderr });
    if (!ev.ok) { ok = false; console.error(`[run-tier] ${p.label} NOT PROVEN: ${ev.reasons.join('; ')}`); break; }
  }

  const fpAfter = fingerprint();
  if (fpAfter !== fpBefore) {
    ok = false;
    console.error('[run-tier] working tree changed while tests ran; result is void');
  }
  const seconds = (Date.now() - t0) / 1000;
  
  const runId = randomUUID();
  const evidence = buildEvidencePayload({
    runId,
    mode: args.gate ? 'gate' : args.tier,
    fingerprintBefore: fpBefore,
    fingerprintAfter: fpAfter,
    ok,
    seconds,
    selection,
    runs
  });

  if (args.evidenceDir) {
    mkdirSync(path.resolve(ROOT, args.evidenceDir), { recursive: true });
    const evPath = path.resolve(ROOT, args.evidenceDir, `evidence-${evidence.mode}-${runId.slice(0, 8)}.json`);
    writeFileSync(evPath, JSON.stringify(evidence, null, 2), 'utf8');
  }

  console.log(`[run-tier] RESULT ok=${ok} runId=${runId.slice(0, 8)} seconds=${seconds.toFixed(1)} fingerprint=${fpBefore.slice(0, 12)}`);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => die(2, String((e && e.stack) || e)));
}
