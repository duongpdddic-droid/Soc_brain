import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTapSummary, evaluateSummary, unitOf, unitsImportedBy, selectGate, loadManifest, buildEvidencePayload } from '../scripts/run-tier.mjs';

test('parseTapSummary extracts all count fields from top-level comments', () => {
  const tap = `
TAP version 13
# Subtest: example
    ok 1 - subtest passed
    1..1
ok 1 - example # time=12ms
1..1
# tests 10
# suites 1
# pass 10
# fail 0
# cancelled 0
# skipped 0
# todo 0
`;
  const summary = parseTapSummary(tap);
  assert.equal(summary.tests, 10);
  assert.equal(summary.pass, 10);
  assert.equal(summary.fail, 0);
  assert.equal(summary.cancelled, 0);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.todo, 0);
});

test('evaluateSummary enforces fail-closed invariant on missing summary or non-zero fail', () => {
  const incomplete = evaluateSummary({ exitCode: 0, summary: { tests: 1, pass: 1 }, fileCount: 1 });
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.reasons.join('; '), /missing/);

  const zeroTests = evaluateSummary({
    exitCode: 0,
    summary: { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
    fileCount: 1
  });
  assert.equal(zeroTests.ok, false);
  assert.match(zeroTests.reasons.join('; '), /0 tests executed/);

  const failedTest = evaluateSummary({
    exitCode: 1,
    summary: { tests: 2, pass: 1, fail: 1, cancelled: 0, skipped: 0, todo: 0 },
    fileCount: 1
  });
  assert.equal(failedTest.ok, false);

  const validPass = evaluateSummary({
    exitCode: 0,
    summary: { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
    fileCount: 1,
    minTests: 2
  });
  assert.equal(validPass.ok, true);
  assert.equal(validPass.reasons.length, 0);
});

test('unitOf resolves package boundaries and standalone paths', () => {
  assert.equal(unitOf('packages/control-loop/adapters.mjs'), 'packages/control-loop/');
  assert.equal(unitOf('bin/soc-control-loop.mjs'), 'bin/soc-control-loop.mjs');
  assert.equal(unitOf('scripts/run-tier.mjs'), 'scripts/run-tier.mjs');
});

test('unitsImportedBy parses static dependencies from test source', () => {
  const source = `
    import { foo } from '../packages/control-loop/foo.mjs';
    import bar from './fixtures/bar.mjs';
  `;
  const units = unitsImportedBy('tests/example.test.mjs', source);
  assert.ok(units.has('packages/control-loop/'));
});

test('selectGate correctly calls selector and triggers T3 suite for touched subsystem', () => {
  const manifestData = loadManifest();
  
  // Case 1: Chạm subsystem execution-broker -> Phải kích hoạt execution-broker.test.mjs
  const brokerResult = selectGate(manifestData, ['packages/execution-broker/broker.mjs']);
  assert.ok(brokerResult.files.includes('execution-broker.test.mjs'), 'Must include execution-broker.test.mjs');
  assert.ok(brokerResult.files.includes('advisor-integration-smoke.test.mjs'), 'Must include always test');

  // Case 2: Chạm workspace -> Phải kích hoạt cả workspace.test.mjs và mutation-ownership.test.mjs
  const wsResult = selectGate(manifestData, ['packages/workspace/workspace.mjs']);
  assert.ok(wsResult.files.includes('workspace.test.mjs'), 'Must include workspace.test.mjs');
  assert.ok(wsResult.files.includes('mutation-ownership.test.mjs'), 'Must include mutation-ownership.test.mjs');

  // Case 3: Chạm file unmapped -> fallback kích hoạt T1 và T2
  const fallbackResult = selectGate(manifestData, ['unknown-folder/foo.js']);
  assert.equal(fallbackResult.fallback, true);
  assert.ok(fallbackResult.files.length >= manifestData.m.tiers.t1.files.length);
});

test('buildEvidencePayload preserves raw stdout, stderr, exitCode, and both fingerprints', () => {
  const payload = buildEvidencePayload({
    runId: 'test-uuid-1234',
    mode: 'gate',
    fingerprintBefore: 'fp-before-111',
    fingerprintAfter: 'fp-after-222',
    ok: false,
    seconds: 1.25,
    selection: { changedCount: 1 },
    runs: [{
      label: 'gate',
      files: 1,
      exitCode: 1,
      ms: 120,
      summary: { tests: 1, fail: 1 },
      ok: false,
      reasons: ['1 failed'],
      stdout: '# TAP raw output\nnot ok 1 - fail',
      stderr: 'Stack trace details'
    }]
  });

  assert.equal(payload.runId, 'test-uuid-1234');
  assert.equal(payload.fingerprintBefore, 'fp-before-111');
  assert.equal(payload.fingerprintAfter, 'fp-after-222');
  assert.equal(payload.workingTreeClean, false);
  assert.equal(payload.runs[0].exitCode, 1);
  assert.equal(payload.runs[0].rawStdout, '# TAP raw output\nnot ok 1 - fail');
  assert.equal(payload.runs[0].rawStderr, 'Stack trace details');
});

// ---- Unified-manifest compatibility contract --------------------------------
// The npm scripts keep their names and keep pointing at run-tier-tests.mjs;
// the wrapper is a THIN tier view over the ONE canonical manifest
// (tests/tiers.json), and `run-tier.mjs --gate` surfaces the deterministic
// plan (mode/baseSha/planDigest) in the same process the legacy tier runs use.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (script, args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
  cwd: ROOT, encoding: 'utf8', windowsHide: true,
});

test('compat: run-tier-tests aliases resolve against the one manifest — t0/all/unknown are fail-closed', () => {
  const inv = loadManifest().onDisk;

  const t0 = run('run-tier-tests.mjs', ['t0', '--list']);
  assert.equal(t0.status, 0, t0.stderr);
  const listOf = (out) => out.split('\n')
    .map((s) => s.trim().replace(/^tests\//, ''))
    .filter((s) => s.endsWith('.test.mjs'));
  const t0Files = listOf(t0.stdout);
  assert.ok(t0Files.length >= 1, 'the smoke tier lists real files');
  for (const f of t0Files) assert.ok(inv.includes(f), `${f} is in the shared inventory`);

  const all = run('run-tier-tests.mjs', ['all', '--list']);
  assert.equal(all.status, 0, all.stderr);
  const allFiles = listOf(all.stdout);
  assert.deepEqual([...allFiles].sort(), inv.slice().sort(), '`all` is DERIVED from the same inventory');

  const bad = run('run-tier-tests.mjs', ['t9', '--list']);
  assert.notEqual(bad.status, 0, 'an unknown alias fails closed');
  assert.match(`${bad.stderr}${bad.stdout}`, /t9/);

  const noManifest = loadManifest();
  assert.ok(noManifest.onDisk.includes('test-plan.test.mjs'), 'the new planner test is tier-owned too');
});

test('compat: `run-tier.mjs --tier` (legacy wrapper) still lists the tier from the same manifest', () => {
  const m = loadManifest().m;
  const r = run('run-tier.mjs', ['--tier', 't1', '--list']);
  assert.equal(r.status, 0, r.stderr);
  const files = r.stdout.split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.test.mjs'));
  assert.equal(files.length, m.tiers.t1.files.length, 'every t1 file, no more no less');
  assert.equal(r.stdout.includes('tests/tests/'), false, 'paths are never doubled');
});

test('gate CLI: `run-tier.mjs --gate --list` prints the deterministic plan binding, not just a file list', () => {
  const r = run('run-tier.mjs', ['--gate', '--list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /baseSha=[0-9a-f]{40}/, 'the plan is bound to an exact BASE SHA');
  assert.match(r.stdout, /candidate=[0-9a-f]{40}/, 'the plan is bound to an exact candidate HEAD');
  assert.match(r.stdout, /mode=(affected|full)/);
  assert.match(r.stdout, /status=(READY|NO_TESTS)/);
  assert.match(r.stdout, /planDigest=[0-9a-f]{12}/, 'the selection carries its digest');
  assert.match(r.stdout, /fallback=(true|false)/);
});

