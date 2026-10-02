#!/usr/bin/env node
// scripts/run-tier.mjs — tiered, fail-closed test runner for Soc_brain.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS_DIR = 'tests';
const MANIFEST = `${TESTS_DIR}/tiers.json`;  function die(code, msg) {   console.error(`[run-tier] FAIL: ${msg}`);
  process.exit(code);
}

export function parseTapSummary(text) {
  const s = {};
  for (const m of text.matchAll(/^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm)) {
    s[m[1]] = Number(m[2]);
  }
  return s;
}

export function evaluateSummary({ exitCode, summary, fileCount, minTests = 0 }) {
  const reasons = [];
  for (const k of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    if (!Number.isInteger(summary[k])) reasons.push(`TAP summary is missing '${k}' (unproven run)`);
  }
  if (reasons.length) return { ok: false, reasons };
  if (exitCode !== 0) reasons.push(`exit code ${exitCode}`);   if (summary.tests === 0) reasons.push('0 tests executed');   if (summary.tests < fileCount) reasons.push(`${summary.tests} tests total for ${fileCount} files (aggregate check failed)`);   if (summary.tests < minTests) reasons.push(`${summary.tests} tests < minTests ${minTests}`);   if (summary.fail > 0) reasons.push(`${summary.fail} failed`);
  if (summary.cancelled > 0) reasons.push(`${summary.cancelled} cancelled`);   if (summary.skipped > 0) reasons.push(`${summary.skipped} skipped (skip is not allowed)`);
  if (summary.todo > 0) reasons.push(`${summary.todo} todo (todo is not allowed)`);   if (summary.pass !== summary.tests) reasons.push(`pass ${summary.pass} != tests ${summary.tests}`);   return { ok: reasons.length === 0, reasons }; }  export function unitOf(p) {   const parts = p.split('/');   return parts[0] === 'packages' && parts.length > 2 ? `packages/${parts[1]}/` : p;
}

export function unitsImportedBy(testRelPath, source) {
  const units = new Set();
  const base = path.posix.dirname(testRelPath);
  const add = (spec) => {
    const rel = path.posix.normalize(path.posix.join(base, spec));
    if (!rel.startsWith('..')) units.add(unitOf(rel));
  };
  for (const m of source.matchAll(/\b(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) add(m[1]);
  for (const m of source.matchAll(/['"`]((?:\.\.\/)+(?:packages|bin|scripts)\/[^'"`]+)['"`]/g)) add(m[1]);
  return units;
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
  const m = JSON.parse(readFileSync(path.join(ROOT, MANIFEST), 'utf8'));
  const onDisk = readdirSync(path.join(ROOT, TESTS_DIR)).filter((f) => f.endsWith('.test.mjs')).sort();
  const owner = new Map();
  for (const [tier, def] of Object.entries(m.tiers)) {
    for (const f of def.files) {
      if (owner.has(f)) die(2, `${f} is assigned to both ${owner.get(f)} and ${tier}`);
      owner.set(f, tier);
    }
  }
  const orphans = onDisk.filter((f) => !owner.has(f));
  const ghosts = [...owner.keys()].filter((f) => !onDisk.includes(f));
  if (orphans.length) die(2, `test files with no tier (fail-closed): ${orphans.join(', ')}`);
  if (ghosts.length) die(2, `manifest lists files that do not exist: ${ghosts.join(', ')}`);
  for (const f of m.always || []) if (!owner.has(f)) die(2, `always[] lists unknown test ${f}`);
  return { m, owner, onDisk };
}

export function buildImportIndex(onDisk) {
  const index = new Map();
  for (const f of onDisk) {
    const rel = `${TESTS_DIR}/${f}`;
    index.set(f, unitsImportedBy(rel, readFileSync(path.join(ROOT, rel), 'utf8')));
  }
  return index;
}

export function selectGate({ m, owner, onDisk }, changed) {
  const picked = new Map();
  const add = (f, why) => { if (!picked.has(f)) picked.set(f, why); };
  (m.always || []).forEach((f) => add(f, 'always'));

  const imports = buildImportIndex(onDisk);
  const coreSubsystems = m.coreSubsystems || {};
  const ignored = (p) => (m.ignorePrefixes || []).some((x) => p.startsWith(x)) || (m.ignoreSuffixes || []).some((x) => p.endsWith(x));
  const unmapped = [];

  for (const p of changed) {
    if (p.startsWith(`${TESTS_DIR}/`) && p.endsWith('.test.mjs') && !p.slice(TESTS_DIR.length + 1).includes('/')) {
      const f = p.slice(TESTS_DIR.length + 1);
      if (owner.has(f)) add(f, 'changed-test');
      continue;
    }
    if (ignored(p)) continue;
    const unit = unitOf(p);
    let hit = false;

    // Check coreSubsystems map truc tiep
    for (const [subsystemPath, targetTests] of Object.entries(coreSubsystems)) {
      if (p.startsWith(subsystemPath)) {
        targetTests.forEach((t) => add(t, `core-subsystem:${subsystemPath}`));
        hit = true;
      }
    }

    // Check import graph
    for (const [f, units] of imports) {
      if (!units.has(unit)) continue;
      if (owner.get(f) === 't3') {
        const matchesSubsystem = Object.entries(coreSubsystems).some(([subPath, tests]) => p.startsWith(subPath) && tests.includes(f));
        if (matchesSubsystem) {
          add(f, `imports-t3:${unit}`);
          hit = true;
        }
      } else {
        add(f, `imports:${unit}`);
        hit = true;
      }
    }
    if (!hit) unmapped.push(p);
  }

  const fallback = unmapped.length > 0;
  if (fallback) {
    for (const t of ['t1', 't2']) m.tiers[t].files.forEach((f) => add(f, 'fallback:unmapped-change'));
  }
  return { files: [...picked.keys()].sort(), reasons: Object.fromEntries(picked), fallback, unmapped };
}

export function runFiles(files, { quiet = false } = {}) {
  return new Promise((resolve) => {
    const args = ['--test', '--test-reporter=tap', ...files.map((f) => `${TESTS_DIR}/${f}`)];
    const t0 = Date.now();
    const cleanEnv = { ...process.env };
    delete cleanEnv.NODE_TEST_CONTEXT;

    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv, windowsHide: true });
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
  const a = { tier: null, gate: false, base: process.env.SOC_GATE_BASE || null, list: false, timing: false, evidenceDir: process.env.SOC_GATE_EVIDENCE_DIR || 'artifacts/evidence' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--tier') a.tier = argv[++i];
    else if (k === '--gate') a.gate = true;
    else if (k === '--base') a.base = argv[++i];
    else if (k === '--list') a.list = true;
    else if (k === '--timing') a.timing = true;
    else if (k === '--evidence-dir') a.evidenceDir = argv[++i];
    else die(2, `unknown argument: ${k}`);
  }
  if (!a.gate && !a.tier) die(2, 'usage: --gate | --tier t1|t2|t3|all [--list] [--timing] [--base ref] [--evidence-dir dir]');
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = loadManifest();
  const { m } = manifest;
  const plan = [];
  let selection = null;

  if (args.gate) {
    const base = resolveBase(args.base);
    const changed = changedFiles(base);
    selection = { base, changedCount: changed.length, ...selectGate(manifest, changed) };
    plan.push({ label: 'gate', files: selection.files, minTests: 0 });
  } else {
    const tiers = args.tier === 'all' ? Object.keys(m.tiers) : args.tier.split(',');
    for (const t of tiers) if (!m.tiers[t]) die(2, `unknown tier '${t}'`);
    for (const t of tiers) plan.push({ label: t, files: m.tiers[t].files, minTests: m.tiers[t].minTests || 0 });
  }

  if (args.list) {
    for (const p of plan) console.log(`[${p.label}] ${p.files.length} files`);
    if (selection) {
      console.log(`base=${selection.base} changed=${selection.changedCount} fallback=${selection.fallback}`);
      for (const [f, why] of Object.entries(selection.reasons)) console.log(`  ${f}  <- ${why}`);
    } else {
      plan.forEach((p) => p.files.forEach((f) => console.log(`  ${f}`)));
    }
    return;
  }

  if (args.timing) {
    return timing(plan.flatMap((p) => p.files));
  }

  const fpBefore = fingerprint();
  const t0 = Date.now();
  const runs = [];
  let ok = true;
  for (const p of plan) {
    if (p.files.length === 0) { runs.push({ label: p.label, ok: false, reasons: ['empty selection'] }); ok = false; break; }
    console.log(`[run-tier] ${p.label}: ${p.files.length} files`);
    const r = await runFiles(p.files);
    const summary = parseTapSummary(r.stdout);
    const ev = evaluateSummary({ exitCode: r.exitCode, summary, fileCount: p.files.length, minTests: p.minTests });
    runs.push({ label: p.label, files: p.files.length, ms: r.ms, summary, ok: ev.ok, reasons: ev.reasons, stdout: r.stdout, stderr: r.stderr });
    if (!ev.ok) { ok = false; console.error(`[run-tier] ${p.label} NOT PROVEN: ${ev.reasons.join('; ')}`); break; }
  }

  const fpAfter = fingerprint();
  if (fpAfter !== fpBefore) {
    ok = false;
    console.error('[run-tier] working tree changed while tests ran; result is void');
  }
  const seconds = (Date.now() - t0) / 1000;
  
  const runId = randomUUID();
  const evidence = {
    runId,
    at: new Date().toISOString(),
    mode: args.gate ? 'gate' : args.tier,
    fingerprint: fpBefore,
    ok,
    seconds: Number(seconds.toFixed(1)),
    selection,
    runs: runs.map((r) => ({ label: r.label, files: r.files, ms: r.ms, summary: r.summary, ok: r.ok, reasons: r.reasons }))
  };

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
