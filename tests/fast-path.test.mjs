#!/usr/bin/env node
// fast-path.test.mjs — Issue #123 acceptance A–H. Deterministic, no framework,
// no network. Run: node --test tests/fast-path.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyRoute, runFastPath, readTelemetry, LATENCY_FIELDS,
} from '../packages/fast-path/fast-path.mjs';

const GOOD = {
  scopeNote: 'fix typo in agent config comment',
  acceptanceTests: ['config file contains corrected string'],
  securitySensitive: false,
  schemaOrDataMigration: false,
  multiRepo: false,
  destructiveMutation: false,
  uncertainty: 'low',
};

// A. trivial deterministic config fix => FAST_PATH
test('A: trivial deterministic config fix routes FAST_PATH', () => {
  const r = classifyRoute(GOOD);
  assert.equal(r.route, 'FAST_PATH');
  assert.deepEqual(r.reasons, []);
});

// B. security-sensitive => STANDARD_PATH
test('B: security-sensitive routes STANDARD_PATH', () => {
  const r = classifyRoute({ ...GOOD, securitySensitive: true });
  assert.equal(r.route, 'STANDARD_PATH');
  assert.ok(r.reasons.includes('SECURITY_SENSITIVE'));
});

// C. ambiguous scope => STANDARD_PATH
test('C: ambiguous scope routes STANDARD_PATH', () => {
  const r = classifyRoute({ ...GOOD, scopeNote: '   ' });
  assert.equal(r.route, 'STANDARD_PATH');
  assert.ok(r.reasons.includes('SCOPE_UNCLEAR'));
});

// D. test fail => fast path fail-closed (terminal FAIL_CLOSED, telemetry persisted)
test('D: verification failure is fail-closed with telemetry persisted', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-d-'));
  let execCalls = 0;
  const outcome = await runFastPath({
    descriptor: GOOD, repo: 'o/r', issueNumber: 1, stateDir: tmp,
    provisionWorktree: async () => ({ path: path.join(tmp, 'wt'), branch: 'agent/x' }),
    execute: async () => { execCalls += 1; },
    verify: async () => ({ ok: false, error: 'TEST_FAILED: config equals expected' }),
  });
  assert.equal(outcome.terminal, 'FAIL_CLOSED');
  assert.equal(outcome.ok, false);
  assert.equal(execCalls, 1);
  const back = readTelemetry(outcome.telemetryPath);
  assert.ok(back.completedAt, 'completedAt persisted even on failure');
});

// E. deterministic read-back must not be skippable
test('E: read-back is fail-closed when telemetry file is missing', () => {
  assert.throws(() => readTelemetry(path.join(os.tmpdir(), `fp-missing-${process.pid}.json`)), (e) => e.code === 'TELEMETRY_NOT_PERSISTED');
});

// F. deterministic evidence sufficient => no semantic AI review invoked
test('F: sufficient deterministic evidence skips semantic AI review', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-f-'));
  let reviewCalls = 0;
  const onSemanticReview = async () => { reviewCalls += 1; return { ok: true }; };
  const outcome = await runFastPath({
    descriptor: GOOD, repo: 'o/r', issueNumber: 2, stateDir: tmp,
    provisionWorktree: async () => ({ path: path.join(tmp, 'wt'), branch: 'agent/y' }),
    verify: async () => ({ ok: true, evidence: { tests: 'all green' } }),
    onSemanticReview,
  });
  assert.equal(outcome.terminal, 'HANDOFF_READY');
  assert.equal(outcome.semanticReviewInvoked, false);
  assert.equal(reviewCalls, 0, 'semantic review must not be called on the fast path');
});

// G. latency fields persist and read back exactly
test('G: all mandated latency fields persist + read back correctly', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-g-'));
  const tick = { n: 0 };
  const clock = () => new Date(Date.parse('2026-09-09T00:00:00Z') + (tick.n += 100)).toISOString();
  const outcome = await runFastPath({
    descriptor: GOOD, repo: 'o/r', issueNumber: 3, stateDir: tmp, clock,
    provisionWorktree: async () => ({ path: path.join(tmp, 'wt'), branch: 'agent/z' }),
    execute: async ({ telemetry }) => { telemetry.addWait('providerWaitMs', 25); },
    verify: async () => ({ ok: true, evidence: { deterministic: true } }),
  });
  const back = readTelemetry(outcome.telemetryPath);
  for (const f of LATENCY_FIELDS) {
    if (f === 'reviewStartedAt') continue; // optional per Issue: "nếu có"
    assert.ok(f in back, `latency field ${f} must be persisted`);
    assert.ok(back[f], `latency field ${f} must be non-null`);
  }
  assert.equal(back.reviewStartedAt, undefined, 'fast path never opens a semantic review');
  assert.equal(typeof back.totalWallClockMs, 'number');
  assert.ok(back.totalWallClockMs >= 0 && back.productiveMs >= 0);
  assert.ok(back.totalWallClockMs >= back.productiveMs, 'wall clock covers productive time');
  assert.equal(back.providerWaitMs, 25);
  assert.equal(back.pollingWaitMs, 0, 'no coarse polling on the fast path');
  assert.equal(back.recoveryWaitMs, 0);
});

// H. no auto-chain: exactly one execution, no next-task handoff
test('H: fast path never auto-chains a next task', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-h-'));
  let execCalls = 0;
  const outcome = await runFastPath({
    descriptor: GOOD, repo: 'o/r', issueNumber: 4, stateDir: tmp,
    provisionWorktree: async () => ({ path: path.join(tmp, 'wt'), branch: 'agent/w' }),
    execute: async () => { execCalls += 1; },
    verify: async () => ({ ok: true, evidence: {} }),
  });
  assert.equal(execCalls, 1, 'exactly one task execution');
  assert.equal(outcome.nextTask, undefined);
  assert.equal(outcome.autoChained, undefined);
  assert.notEqual(outcome.terminal, 'CHAIN_NEXT');
});
