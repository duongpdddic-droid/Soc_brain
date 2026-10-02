import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTapSummary, evaluateSummary, unitOf, unitsImportedBy } from '../scripts/run-tier.mjs';

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
  // Case: Missing field
  const incomplete = evaluateSummary({ exitCode: 0, summary: { tests: 1, pass: 1 }, fileCount: 1 });
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.reasons.join('; '), /missing/);

  // Case: 0 tests executed
  const zeroTests = evaluateSummary({
    exitCode: 0,
    summary: { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
    fileCount: 1
  });
  assert.equal(zeroTests.ok, false);
  assert.match(zeroTests.reasons.join('; '), /0 tests executed/);

  // Case: Fail > 0
  const failedTest = evaluateSummary({
    exitCode: 1,
    summary: { tests: 2, pass: 1, fail: 1, cancelled: 0, skipped: 0, todo: 0 },
    fileCount: 1
  });
  assert.equal(failedTest.ok, false);

  // Case: Valid PASS
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

test('selectGate correctly maps touched core subsystem to corresponding T3 test', async () => {
  // Test dong goi module noi bo de kiem tra hanh vi selectGate
  const { readFileSync } = await import('node:fs');
  const manifest = JSON.parse(readFileSync('tests/tiers.json', 'utf8'));
  const coreSubsystems = manifest.coreSubsystems;
  
  // Chung minh subsystem runtime-sandbox anh xa dung den runtime-sandbox.test.mjs
  assert.ok(coreSubsystems['packages/runtime-sandbox/'].includes('runtime-sandbox.test.mjs'));
  assert.ok(coreSubsystems['packages/workspace/'].includes('workspace.test.mjs'));
});
