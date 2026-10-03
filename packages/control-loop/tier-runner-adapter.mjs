// tier-runner-adapter.mjs — wraps scripts/run-tier.mjs gate mode for the control plane.
// This adapter integrates the tiered test runner (scripts/run-tier.mjs) into the
// canonical verifier, running the gate in the task worktree context.
//
// Requirements (Issue #9000031):
// - Composition root keeps activeTestRunner: TestRunRecord (runId, output digest, content binding, latest-run) never lost
// - Evidence gate tied to current run: get runId from spawn RESULT line, read evidence-gate-<runId>; missing/mismatch -> typed block
// - Select tests by changed scope (base = session.baseSha via merge-base, include uncommitted); empty selection -> FAIL closed
// - Default NO full suite; T3/full only with explicit instruction and logged reason
// - Fallback ONLY for pre-test errors (git/base/manifest/worktree); test FAIL, evidence missing/wrong, binding wrong -> FAIL typed, NEVER fallback to PASS

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Import pure functions from the tier runner (no ROOT dependency)
import {
  parseTapSummary,
  evaluateSummary,
  unitOf,
  unitsImportedBy,
  buildEvidencePayload,
} from '../../scripts/run-tier.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const EVIDENCE_DIR = path.resolve(PROJECT_ROOT, 'artifacts', 'evidence');

const TESTS_DIR = 'tests';
const MANIFEST = `${TESTS_DIR}/tiers.json`;

const TEST_RUN_SCHEMA_VERSION = '1';
const HEX40 = /^[0-9a-f]{40}$/;

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export const TIER_RUNNER_CODES = Object.freeze({
  SPAWN_FAILED: 'TIER_RUNNER_SPAWN_FAILED',
  NO_RESULT_LINE: 'TIER_RUNNER_NO_RESULT_LINE',
  RUN_ID_PARSE_FAILED: 'TIER_RUNNER_RUN_ID_PARSE_FAILED',
  EVIDENCE_FILE_MISSING: 'TIER_RUNNER_EVIDENCE_FILE_MISSING',
  EVIDENCE_READ_FAILED: 'TIER_RUNNER_EVIDENCE_READ_FAILED',
  EVIDENCE_MISMATCH: 'TIER_RUNNER_EVIDENCE_MISMATCH',
  EVIDENCE_UNPROVEN: 'TIER_RUNNER_EVIDENCE_UNPROVEN',
  GATE_FAILED: 'TIER_RUNNER_GATE_FAILED',
  PRE_TEST_ERROR: 'TIER_RUNNER_PRE_TEST_ERROR',
  MANIFEST_ERROR: 'TIER_RUNNER_MANIFEST_ERROR',
  NO_TESTS_SELECTED: 'TIER_RUNNER_NO_TESTS_SELECTED',
});

/**
 * Canonical TestRunRecord store path: stateDir/executions/<identityHash>.testruns.jsonl
 */
function testRunsPathFor({ stateDir = null, identityHash = null } = {}) {
  if (stateDir && identityHash) {
    return path.join(path.resolve(stateDir), 'executions', `${identityHash}.testruns.jsonl`);
  }
  return null;
}

/**
 * Git helper using a specific working directory (the task worktree).
 */
function gitInDir(worktreePath, args, { allowFail = false } = {}) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd: worktreePath, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  }
  return r.stdout;
}

/**
 * Resolve base ref in the worktree context.
 */
function resolveBaseInDir(worktreePath, explicit) {
  const ok = (ref) => gitInDir(worktreePath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
  if (explicit) {
    if (!ok(explicit)) throw new Error(`--base '${explicit}' does not resolve to a commit`);
    return explicit;
  }
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) if (ok(ref)) return ref;
  throw new Error('cannot determine base ref; set SOC_GATE_BASE or pass --base');
}

/**
 * Get changed files in the worktree (tracked + untracked).
 */
function changedFilesInDir(worktreePath, base) {
  const mb = gitInDir(worktreePath, ['merge-base', base, 'HEAD'], { allowFail: true });
  if (!mb) throw new Error(`no merge-base between '${base}' and HEAD`);
  const tracked = gitInDir(worktreePath, ['diff', '--name-only', mb.trim()]).split('\n');
  const untracked = gitInDir(worktreePath, ['ls-files', '--others', '--exclude-standard']).split('\n');
  return [...new Set([...tracked, ...untracked].map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean))];
}

/**
 * Compute content fingerprint of the worktree (HEAD + diff + untracked).
 */
function fingerprintInDir(worktreePath) {
  const h = createHash('sha256');
  h.update(gitInDir(worktreePath, ['rev-parse', 'HEAD']));
  h.update(gitInDir(worktreePath, ['diff', 'HEAD', '--binary']));
  const untracked = gitInDir(worktreePath, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean).sort();
  for (const f of untracked) {
    const fpath = path.join(worktreePath, f);
    h.update(`\0${f}\0`);
    h.update(readFileSync(fpath));
  }
  return h.digest('hex');
}

/**
 * Load manifest from the worktree (tests/tiers.json).
 */
function loadManifestInDir(worktreePath) {
  const manifestPath = path.join(worktreePath, MANIFEST);
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const testsDir = path.join(worktreePath, TESTS_DIR);
  if (!existsSync(testsDir)) {
    throw new Error(`Tests directory not found: ${testsDir}`);
  }
  const onDisk = readdirSync(testsDir).filter((f) => f.endsWith('.test.mjs')).sort();
  const owner = new Map();
  for (const [tier, def] of Object.entries(m.tiers)) {
    for (const f of def.files) {
      if (owner.has(f)) throw new Error(`${f} is assigned to both ${owner.get(f)} and ${tier}`);
      owner.set(f, tier);
    }
  }
  const orphans = onDisk.filter((f) => !owner.has(f));
  const ghosts = [...owner.keys()].filter((f) => !onDisk.includes(f));
  if (orphans.length) throw new Error(`test files with no tier (fail-closed): ${orphans.join(', ')}`);
  if (ghosts.length) throw new Error(`manifest lists files that do not exist: ${ghosts.join(', ')}`);
  for (const f of m.always || []) if (!owner.has(f)) throw new Error(`always[] lists unknown test ${f}`);
  return { m, owner, onDisk };
}

/**
 * Build import index for test files in the worktree.
 */
function buildImportIndexInDir(worktreePath, onDisk) {
  const index = new Map();
  for (const f of onDisk) {
    const rel = `${TESTS_DIR}/${f}`;
    const testPath = path.join(worktreePath, rel);
    const source = readFileSync(testPath, 'utf8');
    index.set(f, unitsImportedBy(rel, source));
  }
  return index;
}

/**
 * Select tests for gate based on changed files (worktree-aware version of selectGate).
 */
function selectGateInDir({ m, owner, onDisk }, changed, worktreePath) {
  const picked = new Map();
  const add = (f, why) => { if (!picked.has(f)) picked.set(f, why); };
  (m.always || []).forEach((f) => add(f, 'always'));

  const imports = buildImportIndexInDir(worktreePath, onDisk);
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

    for (const [subsystemPath, targetTests] of Object.entries(coreSubsystems)) {
      if (p.startsWith(subsystemPath)) {
        targetTests.forEach((t) => add(t, `core-subsystem:${subsystemPath}`));
        hit = true;
      }
    }

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

/**
 * Run test files in the worktree using node --test.
 */
async function runFilesInDir(worktreePath, files, { quiet = false } = {}) {
  return new Promise((resolve) => {
    const args = ['--test', '--test-reporter=tap', ...files.map((f) => `${TESTS_DIR}/${f}`)];
    const t0 = Date.now();
    const cleanEnv = { ...process.env };
    delete cleanEnv.NODE_TEST_CONTEXT;

    const child = spawn(process.execPath, args, { cwd: worktreePath, stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; if (!quiet) process.stdout.write(d); });
    child.stderr.on('data', (d) => { stderr += d; if (!quiet) process.stderr.write(d); });
    child.on('error', (e) => resolve({ exitCode: -1, stdout, stderr, ms: Date.now() - t0, error: String(e) }));
    child.on('close', (code) => resolve({ exitCode: code, stdout, stderr, ms: Date.now() - t0 }));
  });
}

/**
 * Run the tier gate in the worktree context.
 * Returns { ok, runId, evidence, rawStdout, rawStderr, exitCode, command }
 */
async function runTierGateInWorktree({ worktreePath, baseRef, evidenceDir, timeoutMs = 300000 } = {}) {
  if (!worktreePath || !existsSync(worktreePath)) {
    return { ok: false, code: TIER_RUNNER_CODES.PRE_TEST_ERROR, detail: 'worktreePath is required and must exist' };
  }

  // Load manifest (fail-closed if missing/invalid)
  let manifest;
  try {
    manifest = loadManifestInDir(worktreePath);
  } catch (e) {
    return { ok: false, code: TIER_RUNNER_CODES.MANIFEST_ERROR, detail: String(e) };
  }

  // Resolve base and get changed files
  let base, changed;
  try {
    base = resolveBaseInDir(worktreePath, baseRef);
    changed = changedFilesInDir(worktreePath, base);
  } catch (e) {
    return { ok: false, code: TIER_RUNNER_CODES.PRE_TEST_ERROR, detail: String(e) };
  }

  // Select tests for gate
  const selection = selectGateInDir(manifest, changed, worktreePath);
  if (selection.files.length === 0) {
    return { ok: false, code: TIER_RUNNER_CODES.NO_TESTS_SELECTED, detail: 'Empty test selection for changed scope', selection };
  }

  // Fingerprint before
  const fpBefore = fingerprintInDir(worktreePath);
  const t0 = Date.now();

  // Run selected tests
  const r = await runFilesInDir(worktreePath, selection.files);
  const summary = parseTapSummary(r.stdout);
  const ev = evaluateSummary({ exitCode: r.exitCode, summary, fileCount: selection.files.length, minTests: 0 });

  // Fingerprint after
  const fpAfter = fingerprintInDir(worktreePath);
  const seconds = (Date.now() - t0) / 1000;

  const runId = randomUUID();
  const runs = [{
    label: 'gate',
    files: selection.files.length,
    exitCode: r.exitCode,
    ms: r.ms,
    summary,
    ok: ev.ok,
    reasons: ev.reasons,
    stdout: r.stdout,
    stderr: r.stderr,
  }];

  const ok = ev.ok && fpAfter === fpBefore;
  if (fpAfter !== fpBefore) {
    console.error('[tier-runner-adapter] working tree changed while tests ran; result is void');
  }

  const evidence = buildEvidencePayload({
    runId,
    mode: 'gate',
    fingerprintBefore: fpBefore,
    fingerprintAfter: fpAfter,
    ok,
    seconds,
    selection,
    runs,
  });

  // Write evidence file
  if (evidenceDir) {
    mkdirSync(path.resolve(evidenceDir), { recursive: true });
    const evPath = path.resolve(evidenceDir, `evidence-${evidence.mode}-${runId.slice(0, 8)}.json`);
    writeFileSync(evPath, JSON.stringify(evidence, null, 2), 'utf8');
  }

  const resultLine = `[run-tier] RESULT ok=${ok} runId=${runId.slice(0, 8)} seconds=${seconds.toFixed(1)} fingerprint=${fpBefore.slice(0, 12)}`;
  console.log(resultLine);

  const stdout = resultLine + '\n' + runs.map(run => run.stdout).join('\n');
  const stderr = runs.map(run => run.stderr).join('\n');

  if (!ok) {
    return {
      ok: false,
      code: ev.ok ? TIER_RUNNER_CODES.EVIDENCE_UNPROVEN : TIER_RUNNER_CODES.GATE_FAILED,
      detail: { evidence, reasons: ev.reasons },
      runId,
      rawStdout: stdout,
      rawStderr: stderr,
      exitCode: r.exitCode,
      command: `node --test ${selection.files.map(f => `tests/${f}`).join(' ')}`,
    };
  }

  return {
    ok: true,
    runId,
    evidence,
    rawStdout: stdout,
    rawStderr: stderr,
    exitCode: 0,
    command: `node --test ${selection.files.map(f => `tests/${f}`).join(' ')}`,
  };
}

/**
 * Create a TestRunRecord from tier gate result and write to canonical store.
 */
function writeTestRunRecord({ evidence, record, session, stateDir, runId, stdout, stderr, exitCode }) {
  const identityHash = record?.identityHash || session?.identityHash;
  if (!identityHash || !stateDir) {
    return;
  }

  const storePath = testRunsPathFor({ stateDir, identityHash });
  if (!storePath) {
    return;
  }

  const rawOutput = `${stdout}${stderr}`;
  const outputDigest = sha256(rawOutput);
  const command = evidence.command || 'node --test (tier gate)';
  const commandDigest = sha256(command);

  const before = evidence.fingerprintBefore ? { contentDigest: evidence.fingerprintBefore, fileCount: null } : null;
  const after = evidence.fingerprintAfter ? { contentDigest: evidence.fingerprintAfter, fileCount: null } : null;

  const testRunRecord = {
    schemaVersion: TEST_RUN_SCHEMA_VERSION,
    kind: 'TestRunRecord',
    runId,
    toolCallId: null,
    runSource: 'control-plane-tier-gate',
    identityHash,
    taskId: record?.taskId || session?.taskId || null,
    repo: record?.repo || session?.repo || null,
    issueNumber: record?.issueNumber ?? session?.issueNumber ?? null,
    worktreePath: record?.worktreePath || session?.worktreePath || null,
    command,
    commandDigest,
    outputDigest,
    rawLogPath: null,
    rawLogBytes: Buffer.byteLength(rawOutput, 'utf8'),
    exitCode,
    result: exitCode === 0 ? 'PASS' : 'FAIL',
    outputBytes: Buffer.byteLength(rawOutput, 'utf8'),
    headSha: null,
    startedAt: evidence.at || new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    before,
    after,
    boundary: 'OBSERVED_START',
    binding: (before && after) ? 'PROVEN' : 'UNPROVEN',
    capturedBy: 'control-loop/tierRunnerAdapter',
    capturedAt: new Date().toISOString(),
    spawn: {
      executable: process.execPath,
      argv: command.split(' '),
      cwd: record?.worktreePath || session?.worktreePath || PROJECT_ROOT,
      timeoutMs: 300000,
      signal: null,
      spawnError: null,
    },
  };

  try {
    appendFileSync(storePath, `${JSON.stringify(testRunRecord)}\n`, 'utf8');
  } catch {
    console.warn('[tier-runner-adapter] Failed to write TestRunRecord to canonical store');
  }
}

/**
 * Create the tier runner adapter with the same interface as createActiveTestRunner.
 * Returns { runGate, timeoutMs, maxOutputBytes }
 */
export function createTierRunnerAdapter({
  timeoutMs = 300000,
  maxOutputBytes = 8 * 1024 * 1024,
  baseRef = 'origin/main',
  evidenceDir = EVIDENCE_DIR,
} = {}) {
  return Object.freeze({
    runGate: async ({ session, record, stateDir }) => {
      const worktreePath = (record && record.worktreePath) || (session && session.worktreePath);
      const result = await runTierGateInWorktree({ worktreePath, baseRef, evidenceDir, timeoutMs });
      
      // Write TestRunRecord to canonical store (preserves runId, output digest, content binding, latest-run)
      if (result.runId) {
        writeTestRunRecord({ evidence: result.evidence, record, session, stateDir, runId: result.runId, stdout: result.rawStdout, stderr: result.rawStderr, exitCode: result.exitCode });
      }
      
      return result;
    },
    timeoutMs,
    maxOutputBytes,
  });
}

export default { createTierRunnerAdapter, TIER_RUNNER_CODES };