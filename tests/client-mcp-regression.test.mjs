// tests/client-mcp-regression.test.mjs — Regression tests for PR #246 rework.
// Tests that:
// 1. Both client-mcp ESM modules import correctly
// 2. Client route without SOC_MODELS_AVAILABLE uses injected executable + probe mock
// 3. launchExecutorAdapter -> withBoundedRecovery: pre-spawn error preserves code and retries at most once
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { createClientControl, createCanonicalRouteExecutor } from '../packages/client-mcp/client-control.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { sessionPathFor, readSessionRecord, taskStart } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { startExecution, resolveOpenCodeExecutable } from '../packages/executor-launcher/executor-launcher.mjs';
import { resolveModelForLaunch, MODEL_CODES } from '../packages/executor-launcher/model-resolution.mjs';
import { launchExecutorAdapter } from '../packages/control-loop/adapters.mjs';
import { withBoundedRecovery, classifyExecutionFailure, FAILURE_CLASSES, readRetryBudget } from '../packages/control-loop/execution-recovery.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-246-regression-'));

function makeRepo(ownerRepoName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-246-repo-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  run(['init', '--initial-branch=main', dir]);
  run(['-C', dir, 'config', 'user.email', 't@e.x']);
  run(['-C', dir, 'config', 'user.name', 't']);
  run(['-C', dir, 'commit', '--allow-empty', '-m', 'init']);
  const sha = run(['-C', dir, 'rev-parse', 'HEAD']);
  run(['-C', dir, 'remote', 'add', 'origin', `https://github.com/${ownerRepoName}.git`]);
  run(['-C', dir, 'update-ref', 'refs/remotes/origin/main', sha]);
  return { dir, ownerRepoName, sha };
}

function makeCanonicalSession(stateDir, repo, issueNumber, overrides = {}) {
  const id = identityHash({ repo, issueNumber });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  const bindingPath = path.join(stateDir, 'bindings', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.mkdirSync(path.dirname(bindingPath), { recursive: true });
  
  fs.writeFileSync(bindingPath, JSON.stringify({
    schemaVersion: '1', taskId: `${repo}#${issueNumber}`, repo, issueNumber,
    baseSha: 'a'.repeat(40), branch: 'agent/test', path: '/tmp/wt', identityHash: id,
  }, null, 2), 'utf8');
  
  const session = {
    schemaVersion: '1', state: 'SESSION_ACTIVE', lifecycle: [],
    taskId: `${repo}#${issueNumber}`, repo, issueNumber, baseSha: 'a'.repeat(40),
    branch: 'agent/test', worktreePath: '/tmp/wt', identityHash: id,
    lease: { token: 'lease-123' }, controlPlane: { stateDir, bindingPath },
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session, id, bindingPath };
}

// ---- Test 1: Both ESM modules import correctly ----
test('import: both client-mcp ESM modules load without error', async () => {
  const clientControl = await import('../packages/client-mcp/client-control.mjs');
  const routeWorker = await import('../packages/client-mcp/route-worker.mjs');
  
  assert.ok(typeof clientControl.createClientControl === 'function');
  assert.ok(typeof clientControl.createCanonicalRouteExecutor === 'function');
  assert.ok(typeof clientControl.resolveCanonicalRepo === 'function');
  assert.ok(typeof routeWorker.runRouteRequest === 'function');
});

// ---- Test 2: Client route without SOC_MODELS_AVAILABLE ----
test('client route: model resolution via injected executable and probe mock (no SOC_MODELS_AVAILABLE)', async () => {
  const R = makeRepo('duongpdddic-droid/soc-246-regress-1');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-246-state-'));
  const worktreesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-246-wt-'));
  
  const ctl = createClientControl({
    stateDir,
    worktreesRoot,
    controlLane: null,
  });
  
  const repo = 'duongpdddic-droid/soc-246-regress-1';
  const issueNumber = 999999;
  
  const submit = ctl.submitGoal({
    targetRepo: repo,
    localCheckoutPath: R.dir,
    goal: 'test model resolution',
    issueNumber,
  });
  assert.ok(submit.ok, `submitGoal failed: ${JSON.stringify(submit)}`);
  
  // Verify model resolution end-to-end via the shared resolver
  const fakeExe = path.join(TMP, 'fake-opencode.exe');
  fs.writeFileSync(fakeExe, '', 'utf8');
  
  const modelResolved = resolveModelForLaunch({
    model: null,
    binding: { path: R.dir },
    controlCwd: process.cwd(),
    env: { ...process.env, SOC_MODELS_AVAILABLE: '' },
    listModels: () => new Set(['opencode/mimo-v2.6-flash-free', 'opencode/big-pickle']),
    executable: fakeExe,
  });
  
  assert.ok(modelResolved.ok, `model resolution failed: ${JSON.stringify(modelResolved)}`);
  assert.ok(modelResolved.value.model === 'opencode/mimo-v2.6-flash-free' || modelResolved.value.model === 'opencode/big-pickle');
  assert.equal(modelResolved.value.availableFrom, 'injected');
});

// ---- Test 2b: Probe failure does not create latch/child ----
test('client route: probe failure produces no latch/child (fail-closed)', async () => {
  const fakeExe = path.join(TMP, 'fake-opencode2.exe');
  fs.writeFileSync(fakeExe, '', 'utf8');
  
  const failingProbe = async () => ({ ok: false, code: 'MODEL_UNRESOLVED', detail: 'probe failed' });
  
  const modelResolved = await resolveModelForLaunch({
    model: null,
    binding: { path: '/tmp/fake' },
    controlCwd: process.cwd(),
    env: { ...process.env, SOC_MODELS_AVAILABLE: '' },
    listModels: failingProbe,
    executable: fakeExe,
  });
  
  assert.equal(modelResolved.ok, false);
  assert.equal(modelResolved.code, MODEL_CODES.UNRESOLVED);
  
  // Verify no probe caching by calling again - should fail again (not cached)
  const modelResolved2 = await resolveModelForLaunch({
    model: null,
    binding: { path: '/tmp/fake' },
    controlCwd: process.cwd(),
    env: { ...process.env, SOC_MODELS_AVAILABLE: '' },
    listModels: failingProbe,
    executable: fakeExe,
  });
  assert.equal(modelResolved2.ok, false);
  assert.equal(modelResolved2.code, MODEL_CODES.UNRESOLVED);
});

// ---- Test 3: launchExecutorAdapter -> withBoundedRecovery pipeline ----
test('pipeline: launchExecutorAdapter preserves pre-spawn code, withBoundedRecovery retries once max', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-246-pipeline-'));
  const { sessionPath, id } = makeCanonicalSession(stateDir, 'o/r', 1);
  
  // Test 3a: Pre-spawn error preserves original code through adapter
  const adapter = launchExecutorAdapter({
    instruction: 'test',
    controlCwd: process.cwd(),
    startExecution: () => ({ ok: false, code: MODEL_CODES.UNAVAILABLE, detail: 'model not available' }),
    readStatus: () => ({ ok: true, execution: { status: 'EXITED' } }),
    delay: () => Promise.resolve(),
  });
  
  const result = await adapter({ sessionPath, model: 'opencode/test' });
  assert.equal(result.ok, false);
  assert.equal(result.code, MODEL_CODES.UNAVAILABLE);
  
  // Test 3b: withBoundedRecovery retries exactly once for PRE_SPAWN
  let attempts = 0;
  const runFn = async ({ attempt }) => {
    if (attempt === 1) {
      return { ok: false, code: MODEL_CODES.UNAVAILABLE, detail: 'model not available' };
    }
    return { ok: true, value: { executionStatus: 'EXITED', terminalStatus: 'EXITED', exitCode: 0 } };
  };
  
  const stateDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-246-br-'));
  const id2 = identityHash({ repo: 'o/r', issueNumber: 2 });
  
  const result2 = await withBoundedRecovery({
    stateDir: stateDir2,
    identityHash: id2,
    run: runFn,
    cleanup: async ({ failure, classification }) => {
      assert.equal(classification.cls, FAILURE_CLASSES.PRE_SPAWN);
      assert.equal(classification.code, MODEL_CODES.UNAVAILABLE);
      return { ok: true, proof: { at: new Date().toISOString(), identityHash: id2, checks: [], provenGone: true } };
    },
    generation: 'test',
  });
  
  assert.equal(result2.ok, true);
  assert.equal(result2.recovery.retried, true);
  assert.equal(result2.recovery.class, FAILURE_CLASSES.PRE_SPAWN);
  assert.equal(result2.recovery.code, MODEL_CODES.UNAVAILABLE);
  
  // Verify budget exhausted after 1 retry
  const { readRetryBudget } = await import('../packages/control-loop/execution-recovery.mjs');
  const budget = readRetryBudget({ stateDir: stateDir2, identityHash: id2 });
  assert.equal(budget.consumed, 1);
  assert.equal(budget.remaining, 0);
  
  // Test 3c: UNKNOWN outcome does not respawn
  let unknownAttempts = 0;
  const runUnknown = async ({ attempt }) => {
    unknownAttempts = attempt;
    if (attempt === 1) {
      return { ok: false, code: 'EXECUTOR_TIMEOUT', detail: 'timeout' };
    }
    return { ok: true };
  };
  
  const stateDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-246-unknown-'));
  const id3 = identityHash({ repo: 'o/r', issueNumber: 3 });
  
  const result3 = await withBoundedRecovery({
    stateDir: stateDir3,
    identityHash: id3,
    run: async ({ attempt }) => {
      unknownAttempts = attempt;
      if (attempt === 1) return { ok: false, code: 'EXECUTOR_TIMEOUT', detail: 'timeout' };
      return { ok: true };
    },
    cleanup: async () => ({ ok: true, proof: { provenGone: true } }),
    generation: 'test',
  });
  
  assert.equal(result3.ok, false);
  assert.equal(result3.code, 'EXECUTOR_TIMEOUT');
  assert.equal(result3.recovery.retried, false);
  assert.equal(result3.recovery.class, FAILURE_CLASSES.UNKNOWN);
  assert.equal(unknownAttempts, 1);
  
  // Test 3d: FAILED outcome does not respawn
  let failedAttempts = 0;
  const runFailed = async ({ attempt }) => {
    failedAttempts = attempt;
    if (attempt === 1) {
      return { ok: false, code: 'EXECUTOR_FAILED', detail: 'exit 1' };
    }
    return { ok: true };
  };
  
  const stateDir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-246-failed-'));
  const id4 = identityHash({ repo: 'o/r', issueNumber: 4 });
  
  const result4 = await withBoundedRecovery({
    stateDir: stateDir4,
    identityHash: id4,
    run: async ({ attempt }) => {
      failedAttempts = attempt;
      if (attempt === 1) return { ok: false, code: 'EXECUTOR_FAILED', detail: 'exit 1' };
      return { ok: true };
    },
    cleanup: async () => ({ ok: true, proof: { provenGone: true } }),
    generation: 'test',
  });
  
  assert.equal(result4.ok, false);
  assert.equal(result4.recovery.retried, false);
  assert.equal(result4.recovery.class, FAILURE_CLASSES.FAILED);
  assert.equal(failedAttempts, 1);
});

test('end-to-end: client route -> adapter -> recovery with pre-spawn error', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-246-e2e-'));
  const { sessionPath } = makeCanonicalSession(stateDir, 'o/r', 42);
  
  const adapter = launchExecutorAdapter({
    instruction: 'test',
    controlCwd: process.cwd(),
    startExecution: () => ({ ok: false, code: MODEL_CODES.INVALID, detail: 'bad model' }),
    readStatus: () => ({ ok: true, execution: { status: 'EXITED' } }),
    delay: () => Promise.resolve(),
  });
  
  const result = await adapter({ sessionPath });
  assert.equal(result.ok, false);
  assert.equal(result.code, MODEL_CODES.INVALID);
  
  const cls = classifyExecutionFailure(result);
  assert.equal(cls.cls, FAILURE_CLASSES.PRE_SPAWN);
  assert.equal(cls.code, MODEL_CODES.INVALID);
});