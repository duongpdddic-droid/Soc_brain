// tests/control-loop.test.mjs — deterministic regression tests for Issue #69.
// No external framework; plain node:test.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CONTROL_LOOP_SCHEMA_VERSION,
  LOOP_STATES,
  TERMINAL_STATES,
  readTransitions,
  bindLoop,
  runControlLoop,
  assertTerminalizationAuthorized,
  bindTerminalizeTokenToSession,
} from '../packages/control-loop/control-loop.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cl-test-')); }

// Build a fake canonical session record at stateDir/sessions/<id>.json,
// mirroring what runtime-sandbox taskStart writes. readSessionRecord enforces
// the canonical control-plane location, so the filename must be the real
// identityHash of (repo, issueNumber).
function mkSession(stateDir, overrides = {}) {
  const repo = overrides.repo || 'duongpdddic-droid/soc_brain';
  const issueNumber = overrides.issueNumber || 69;
  const id = identityHash({ repo, issueNumber });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1',
    state: 'SESSION_ACTIVE',
    lifecycle: [],
    taskId: `${repo}#${issueNumber}`,
    repo,
    issueNumber,
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session, id };
}

test('A. module surface: schema, states, terminal set', () => {
  assert.equal(CONTROL_LOOP_SCHEMA_VERSION, '1');
  assert.ok(LOOP_STATES.includes('ACCEPTED') && LOOP_STATES.includes('COMPLETED') && LOOP_STATES.includes('BLOCKED'));
  assert.ok(TERMINAL_STATES.has('COMPLETED') && TERMINAL_STATES.has('BLOCKED'));
  assert.ok(Object.isFrozen(LOOP_STATES));
});

test('B. bindLoop: legal + illegal transitions and transition ledger', () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const loop = bindLoop({ sessionPath, identityHash: ID, stateDir });
  assert.ok(loop.token && loop.token.length === 64);

  const t1 = loop.transition({ from: 'ACCEPTED', to: 'ROUTED', reason: 'test' });
  assert.ok(t1.ok);
  const t2 = loop.transition({ from: 'ACCEPTED', to: 'COMPLETED' }); // illegal
  assert.equal(t2.ok, false);
  assert.equal(t2.code, 'ILLEGAL_TRANSITION');
  const t3 = loop.transition({ from: 'ROUTED', to: 'ACCEPTED' }); // illegal (no backedge)
  assert.equal(t3.ok, false);

  const records = loop.readTransitions();
  assert.equal(records.length, 1);
  assert.equal(records[0].from, 'ACCEPTED');
  assert.equal(records[0].to, 'ROUTED');
  assert.equal(records[0].identityHash, ID);
});

test('C. runControlLoop happy path: PASS verdict -> COMPLETED via ControlLoop terminalize', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, session, id: ID } = mkSession(stateDir);
  const calls = [];
  const deps = {
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: '/fake/execution.json' } }; },
    verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  assert.ok(res.value.terminalize.ok, JSON.stringify(res.value.terminalize));
  assert.deepEqual(calls, ['router', 'executor', 'verifier', 'preReview', 'finalReview', 'delivery']);

  // Session record must now be terminal, and terminalization came from the loop.
  const rec = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(rec.state, 'COMPLETED');
});

test('D. runControlLoop REWORK verdict: does NOT terminalize', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const deps = {
    router: () => ({ ok: true, value: { executorKind: 'opencode', model: 'x' } }),
    executor: () => ({ ok: true, value: { executionRecordPath: '/fake/execution.json' } }),
    verifier: () => ({ ok: true, value: { verdict: 'PASS', report: 'ok' } }),
    preReview: () => ({ ok: true, value: { verdict: 'PASS', findings: [] } }),
    finalReview: () => ({ ok: true, value: { verdict: 'REWORK', findings: ['f1'] } }),
    delivery: () => { assert.fail('delivery must NOT be called on REWORK'); },
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true);
  assert.equal(res.value.state, 'REWORK');
  assert.equal(res.value.terminalize, undefined);
  const rec = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(rec.state, 'SESSION_ACTIVE'); // not terminalized
  const records = readTransitions({ stateDir, identityHash: ID });
  const last = records[records.length - 1];
  assert.equal(last.to, 'REWORK');
});

test('E. runControlLoop BLOCKED verdict -> BLOCKED terminal', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const deps = {
    router: () => ({ ok: true, value: { executorKind: 'opencode', model: 'x' } }),
    executor: () => ({ ok: true, value: { executionRecordPath: '/fake/execution.json' } }),
    verifier: () => ({ ok: true, value: { verdict: 'PASS', report: 'ok' } }),
    preReview: () => ({ ok: true, value: { verdict: 'PASS', findings: [] } }),
    finalReview: () => ({ ok: true, value: { verdict: 'BLOCKED', findings: ['security'] } }),
    delivery: () => { assert.fail('delivery must NOT be called on BLOCKED'); },
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true);
  assert.equal(res.value.state, 'BLOCKED');
  const rec = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(rec.state, 'BLOCKED');
});

test('F. adapter failure -> BLOCKED side-transition, no terminalize, fail-closed', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const deps = {
    router: () => ({ ok: true, value: { executorKind: 'opencode', model: 'x' } }),
    executor: () => ({ ok: false, code: 'EXECUTOR_DOWN' }),
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'EXECUTE_FAILED');
  const rec = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  // Adapter failure side-transition is BLOCKED but NOT terminalized — no
  // canonical taskFinish/taskBlock happened; the task is still recoverable.
  const records = readTransitions({ stateDir, identityHash: ID });
  const last = records[records.length - 1];
  assert.equal(last.to, 'BLOCKED');
  assert.equal(last.reason, 'execute:FAIL');
  assert.equal(rec.state, 'SESSION_ACTIVE');
});

test('G. terminalization guard: non-ControlLoop caller is rejected', () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  // No controlLoop binding yet.
  const r1 = assertTerminalizationAuthorized({ sessionPath, identityHash: ID, presentedToken: 'whatever', stateDir });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'NOT_CONTROL_LOOP_BOUND');

  // Bind a token, then present wrong token.
  bindTerminalizeTokenToSession({ sessionPath, identityHash: ID, token: 'a'.repeat(64), stateDir });
  const r2 = assertTerminalizationAuthorized({ sessionPath, identityHash: ID, presentedToken: 'b'.repeat(64), stateDir });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'TERMINALIZATION_TOKEN_MISMATCH');

  // Correct token authorizes.
  const r3 = assertTerminalizationAuthorized({ sessionPath, identityHash: ID, presentedToken: 'a'.repeat(64), stateDir });
  assert.equal(r3.ok, true);
});

test('H. idempotent resume: step re-run with same from->to does not re-execute', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const loop = bindLoop({ sessionPath, identityHash: ID, stateDir });
  loop.transition({ from: 'ACCEPTED', to: 'ROUTED', reason: 'seed' });
  let n = 0;
  const r1 = await loop.step({ name: 'route', from: 'ROUTED', to: 'EXECUTING', run: () => { n += 1; return { ok: true, value: { executorKind: 'x' } }; } });
  assert.ok(r1.ok);
  const r2 = await loop.step({ name: 'route', from: 'ROUTED', to: 'EXECUTING', run: () => { n += 1; return { ok: true, value: { executorKind: 'x' } }; } });
  assert.ok(r2.ok);
  assert.equal(r2.result.resumed, true);
  assert.equal(n, 1);
});

test('I. identity mismatch: runControlLoop refuses to run on foreign taskId', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { taskId: 'someone-else/repo#1', repo: 'someone-else/repo', issueNumber: 1 });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: {} });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'IDENTITY_MISMATCH');
});

test('J. already-terminal session: runControlLoop refuses', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { state: 'COMPLETED' });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: {} });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'ALREADY_TERMINAL');
});

test('K. adapter throwing -> STEP_THREW + BLOCKED side-transition, no terminalize', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const deps = {
    router: () => { throw new Error('boom'); },
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'ROUTE_FAILED');
  const records = readTransitions({ stateDir, identityHash: ID });
  const last = records[records.length - 1];
  assert.equal(last.to, 'BLOCKED');
  assert.equal(last.reason, 'route:THREW');
});



