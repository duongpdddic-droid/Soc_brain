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

