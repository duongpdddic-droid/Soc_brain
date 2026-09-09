// tests/control-loop-fastpath.test.mjs — Issue #125 (rework): deterministic
// Fast Path REALLY executes through ControlLoop. Coverage:
//   FP1 eligible descriptor -> runFastPath executes inside the loop's execute
//      step, semantic preReview/finalReview NEVER invoked, review boundaries
//      recorded as skipped, loop completes, telemetry persist + read-back
//      with all five mandated aggregates
//   FP2 securitySensitive -> STANDARD_PATH: standard pipeline runs to
//      completion, gate reasons recorded (never FAST_PATH_NOT_ELIGIBLE)
//   FP3 missing field -> STANDARD_PATH with recorded reasons
//   FP4 uncertainty != low -> STANDARD_PATH with recorded reasons
//   FP5 no descriptor -> legacy behavior with no fast-path artifacts
//   FP6 telemetry read-back failure -> explicit failure (no silent success)
//   FP7 incomplete telemetry aggregates -> explicit failure
//   FP8 exactly one execution per run; terminalization only via ControlLoop
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runControlLoop } from '../packages/control-loop/control-loop.mjs';
import { buildDeliveryAdapter } from '../packages/control-loop/adapters.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { telemetryPathFor, readTelemetry } from '../packages/fast-path/fast-path.mjs';
import { fakeGh } from './fake-gh.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'f'.repeat(40);
const ISSUE = 125;
const REPO = 'duongpdddic-droid/soc_brain';
const AGGREGATES = ['totalWallClockMs', 'productiveMs', 'providerWaitMs', 'pollingWaitMs', 'recoveryWaitMs'];

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cl-fp-')); }

function mkSession(stateDir) {
  const id = identityHash({ repo: REPO, issueNumber: ISSUE });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1',
    state: 'SESSION_ACTIVE',
    lifecycle: [],
    taskId: `${REPO}#${ISSUE}`,
    repo: REPO,
    issueNumber: ISSUE,
    headSha: HEAD,
    baseSha: BASE,
    worktreePath: path.join(stateDir, `wt-issue-${ISSUE}`),
    worktreesRoot: stateDir,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, id };
}

const ELIGIBLE = {
  scopeNote: 'issue #125 regression: deterministic fast-path eligible descriptor',
  acceptanceTests: ['tests/control-loop-fastpath.test.mjs'],
  securitySensitive: false,
  schemaOrDataMigration: false,
  multiRepo: false,
  destructiveMutation: false,
  uncertainty: 'low',
};

function happyDeps(stateDir, calls, extraDeps = {}) {
  // gh transport ops get their own ledger; `calls` tracks ONLY the semantic
  // pipeline stages (router/executor/verifier/preReview/finalReview/cleanup).
  const fx = fakeGh({ issue: ISSUE, headSha: HEAD, baseSha: BASE, order: [] });
  const execId = identityHash({ repo: REPO, issueNumber: ISSUE });
  const execPath = path.join(stateDir, 'executions', `${execId}.json`);
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.writeFileSync(execPath, JSON.stringify({ schemaVersion: '1', kind: 'ExecutionRecord', identityHash: execId, terminalStatus: 'ok', exitCode: 0 }), 'utf8');
  return {
    fx,
    deps: {
      router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
      executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: execPath } }; },
      verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
      preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
      finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
      delivery: buildDeliveryAdapter({ gh: fx.gh, cleanup: () => { calls.push('cleanup'); return { ok: true, removed: [], keptBranch: 'x' }; } }),
      reviewReadyDir: path.join(stateDir, 'review-ready'),
      telegramSpawn: () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 901 })}\n` }),
      ...extraDeps,
    },
  };
}

function readLedger(stateDir, id) {
  const p = path.join(stateDir, 'control-loop', id, 'transitions.jsonl');
  return fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('FP1. eligible descriptor -> runFastPath really executes, semantic reviews never invoked', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const calls = [];
  const { deps } = happyDeps(stateDir, calls, { fastPathDescriptor: ELIGIBLE });
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');

  // Exactly one execution; deterministic verifier ran INSIDE the fast walk;
  // semantic preReview/finalReview NEVER invoked.
  assert.deepEqual(calls, ['router', 'executor', 'verifier', 'cleanup'], JSON.stringify(calls));

  // Telemetry persisted + read back with all five mandated aggregates.
  const t = readTelemetry(telemetryPathFor({ stateDir, repo: REPO, issueNumber: ISSUE }));
  for (const k of AGGREGATES) assert.ok(Number.isFinite(t[k]), `aggregate ${k} must be persisted`);
  assert.equal(t.route, 'FAST_PATH');
  assert.deepEqual(t.routeReasons, []);

  // ControlLoop-only terminalization: the canonical session record is
  // COMPLETED (written through loop.terminalize, not by any adapter).
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'COMPLETED');

  // Ledger proves the real fast walk: eligible route marker + semantic review
  // stages recorded as SKIPPED (boundary transitions, no reviewer call).
  const ledger = readLedger(stateDir, id);
  const routed = ledger.find((r) => r.from === 'ROUTED' && r.to === 'EXECUTING');
  assert.equal(routed.evidence.fastPath.route, 'FAST_PATH', JSON.stringify(routed));
  assert.ok(ledger.some((r) => r.from === 'PRE_REVIEWING' && r.to === 'FINAL_REVIEWING' && r.reason === 'fast-path-semantic-prereview-skipped'), JSON.stringify(ledger));
  assert.ok(ledger.some((r) => r.from === 'FINAL_REVIEWING' && r.to === 'DECIDING' && r.reason === 'fast-path-semantic-finalreview-skipped'));
});

test('FP2. securitySensitive -> STANDARD_PATH pipeline completes, reasons recorded', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const calls = [];
  const { deps } = happyDeps(stateDir, calls, { fastPathDescriptor: { ...ELIGIBLE, securitySensitive: true } });
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  // Full standard pipeline ran (semantic reviews included); the task did NOT
  // stop just because it was not fast-path eligible.
  assert.deepEqual(calls, ['router', 'executor', 'verifier', 'preReview', 'finalReview', 'cleanup'], JSON.stringify(calls));
  const t = readTelemetry(telemetryPathFor({ stateDir, repo: REPO, issueNumber: ISSUE }));
  assert.equal(t.route, 'STANDARD_PATH');
  assert.ok(t.routeReasons.includes('SECURITY_SENSITIVE'), JSON.stringify(t));
});

test('FP3. missing field -> STANDARD_PATH pipeline completes, reasons recorded', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const calls = [];
  const { deps } = happyDeps(stateDir, calls, { fastPathDescriptor: { scopeNote: 'x', acceptanceTests: ['t'] } });
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  assert.deepEqual(calls, ['router', 'executor', 'verifier', 'preReview', 'finalReview', 'cleanup'], JSON.stringify(calls));
  const t = readTelemetry(telemetryPathFor({ stateDir, repo: REPO, issueNumber: ISSUE }));
  assert.equal(t.route, 'STANDARD_PATH');
  assert.ok(t.routeReasons.includes('UNCERTAINTY_NOT_LOW'), JSON.stringify(t));
});

test('FP4. uncertainty != low -> STANDARD_PATH pipeline completes, reasons recorded', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const calls = [];
  const { deps } = happyDeps(stateDir, calls, { fastPathDescriptor: { ...ELIGIBLE, uncertainty: 'high' } });
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  assert.deepEqual(calls, ['router', 'executor', 'verifier', 'preReview', 'finalReview', 'cleanup'], JSON.stringify(calls));
  const t = readTelemetry(telemetryPathFor({ stateDir, repo: REPO, issueNumber: ISSUE }));
  assert.equal(t.route, 'STANDARD_PATH');
  assert.ok(t.routeReasons.includes('UNCERTAINTY_NOT_LOW'), JSON.stringify(t));
});

test('FP5. no descriptor -> legacy behavior with no fast-path artifacts', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const calls = [];
  const { deps } = happyDeps(stateDir, calls);
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  assert.equal(fs.existsSync(path.join(stateDir, 'fast-path')), false, 'no fast-path telemetry without a descriptor');
});

test('FP6. telemetry read-back failure -> explicit fail-closed error', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const { deps } = happyDeps(stateDir, [], { fastPathDescriptor: ELIGIBLE, fastPathReadBack: () => { throw new Error('disk gone'); } });
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'FAST_PATH_TELEMETRY_READBACK_FAILED');
  assert.match(String(res.detail.error), /disk gone/);
});

test('FP7. incomplete telemetry aggregates -> explicit fail-closed error', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const { deps } = happyDeps(stateDir, [], { fastPathDescriptor: ELIGIBLE, fastPathReadBack: () => ({ totalWallClockMs: 5 }) });
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'FAST_PATH_TELEMETRY_INCOMPLETE');
  assert.deepEqual(res.detail.missing, ['productiveMs', 'providerWaitMs', 'pollingWaitMs', 'recoveryWaitMs']);
});

test('FP8. eligibility is per-run: a non-eligible run completes on the standard pipeline', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const stdCalls = [];
  const { deps: stdDeps } = happyDeps(stateDir, stdCalls, { fastPathDescriptor: { ...ELIGIBLE, destructiveMutation: true } });
  const std = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: stdDeps });
  assert.equal(std.ok, true, JSON.stringify(std));
  assert.equal(std.value.state, 'COMPLETED');
  assert.deepEqual(stdCalls, ['router', 'executor', 'verifier', 'preReview', 'finalReview', 'cleanup'], JSON.stringify(stdCalls));
  const t = readTelemetry(telemetryPathFor({ stateDir, repo: REPO, issueNumber: ISSUE }));
  assert.equal(t.route, 'STANDARD_PATH');
  assert.ok(t.routeReasons.includes('DESTRUCTIVE_MUTATION'), JSON.stringify(t));
});
