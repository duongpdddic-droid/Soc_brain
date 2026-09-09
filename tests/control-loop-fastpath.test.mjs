// tests/control-loop-fastpath.test.mjs — Issue #125: deterministic Fast Path
// wired into the ControlLoop admission (runControlLoop). Coverage:
// eligible descriptor -> admission telemetry persisted + loop completes
// unchanged; ineligible/ambiguous descriptor -> fail-closed
// FAST_PATH_NOT_ELIGIBLE with ZERO FSM mutation; no descriptor -> legacy
// behavior with no fast-path artifacts; eligibility is per-run (a refused
// task may proceed on a later eligible run).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runControlLoop } from '../packages/control-loop/control-loop.mjs';
import { buildDeliveryAdapter } from '../packages/control-loop/adapters.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { telemetryPathFor } from '../packages/fast-path/fast-path.mjs';
import { fakeGh } from './fake-gh.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'f'.repeat(40);
const ISSUE = 125;
const REPO = 'duongpdddic-droid/soc_brain';

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
  const fx = fakeGh({ issue: ISSUE, headSha: HEAD, baseSha: BASE, order: calls });
  const execId = identityHash({ repo: REPO, issueNumber: ISSUE });
  const execPath = path.join(stateDir, 'executions', `${execId}.json`);
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.writeFileSync(execPath, JSON.stringify({ schemaVersion: '1', kind: 'ExecutionRecord', identityHash: execId, terminalStatus: 'ok', exitCode: 0 }), 'utf8');
  return {
    fx,
    deps: {
      router: () => ({ ok: true, value: { executorKind: 'opencode', model: 'x' } }),
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

test('FP1. eligible descriptor -> admission telemetry persisted -> loop completes unchanged', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const calls = [];
  const { deps } = happyDeps(stateDir, calls, { fastPathDescriptor: ELIGIBLE });
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  const t = JSON.parse(fs.readFileSync(telemetryPathFor({ stateDir, repo: REPO, issueNumber: ISSUE }), 'utf8'));
  assert.ok(!Number.isNaN(Date.parse(t.acceptedAt)), 'admission telemetry acceptedAt is a real ISO timestamp');
});

test('FP2. ineligible/ambiguous descriptor -> fail-closed FAST_PATH_NOT_ELIGIBLE, no FSM mutation', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const calls = [];
  const { deps } = happyDeps(stateDir, calls, { fastPathDescriptor: { ...ELIGIBLE, securitySensitive: true } });
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'FAST_PATH_NOT_ELIGIBLE');
  assert.ok(res.detail.reasons.includes('SECURITY_SENSITIVE'), JSON.stringify(res.detail));
  assert.deepEqual(calls, [], 'no stage ran');
  const persisted = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(persisted.state, 'SESSION_ACTIVE', 'session untouched');
  assert.ok(fs.existsSync(telemetryPathFor({ stateDir, repo: REPO, issueNumber: ISSUE })), 'admission telemetry persisted even on refusal');
  // A missing/ambiguous field is equally fail-closed (never guessed).
  const res2 = await runControlLoop({
    sessionPath, identityHash: id, stateDir,
    deps: { ...happyDeps(stateDir, []).deps, fastPathDescriptor: { scopeNote: 'x', acceptanceTests: ['t'] } },
  });
  assert.equal(res2.ok, false);
  assert.ok(res2.detail.reasons.includes('UNCERTAINTY_NOT_LOW'), JSON.stringify(res2.detail));
});

test('FP3. no descriptor -> legacy behavior with no fast-path artifacts', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const calls = [];
  const { deps } = happyDeps(stateDir, calls);
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  assert.equal(fs.existsSync(path.join(stateDir, 'fast-path')), false, 'no fast-path telemetry without a descriptor');
});

test('FP4. eligibility is per-run: a refused task may proceed on a later eligible run', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const { deps: badDeps } = happyDeps(stateDir, [], { fastPathDescriptor: { ...ELIGIBLE, uncertainty: 'high' } });
  const refused = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: badDeps });
  assert.equal(refused.ok, false);
  const calls = [];
  const { deps } = happyDeps(stateDir, calls, { fastPathDescriptor: ELIGIBLE });
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
});
