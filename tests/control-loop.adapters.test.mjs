// tests/control-loop.adapters.test.mjs — deterministic adapter-contract tests.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { identityHash } from '../packages/workspace/workspace.mjs';
import {
  brokerRouter,
  launchExecutorAdapter,
  deterministicVerifierAdapter,
  geminiPreReviewAdapter,
  gptFinalReviewAdapter,
  telegramDeliveryAdapter,
} from '../packages/control-loop/adapters.mjs';
import { readSessionRecord } from '../packages/runtime-sandbox/runtime-sandbox.mjs';

function mkSessionFile(stateDir, overrides = {}) {
  const repo = overrides.repo || 'duongpdddic-droid/soc_brain';
  const issueNumber = overrides.issueNumber || 69;
  const id = identityHash({ repo, issueNumber });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1', state: 'SESSION_ACTIVE', lifecycle: [],
    taskId: `${repo}#${issueNumber}`, repo, issueNumber,
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session, id };
}

test('router: fail-closed without broker; broker.submit receives canonical identity', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const { sessionPath, session } = mkSessionFile(stateDir);
  const r1 = await brokerRouter({})( { sessionPath } );
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'NO_BROKER');

  let seen = null;
  const broker = { submit: (req) => { seen = req; return { ok: true, value: { queued: true } }; } };
  const r2 = await brokerRouter({ broker })({ sessionPath });
  assert.equal(r2.ok, true);
  assert.equal(seen.taskId, session.taskId);
  assert.equal(seen.repo, session.repo);
  assert.equal(seen.issueNumber, session.issueNumber);
});

test('executor: fail-closed without transport; launch failure surfaces', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const { sessionPath } = mkSessionFile(stateDir);

  const r1 = await launchExecutorAdapter({})({ sessionPath });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'NO_EXECUTOR_TRANSPORT');

  const r2 = await launchExecutorAdapter({ startExecution: () => ({ ok: false, code: 'X' }) })({ sessionPath });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'LAUNCH_FAILED');
});

test('verifier: missing record and missing primitive fail closed', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const { sessionPath } = mkSessionFile(stateDir);
  const v = deterministicVerifierAdapter({});
  const r1 = await v({ sessionPath, executionRecordPath: 'Z:/nope/missing.json' });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'EXECUTION_RECORD_MISSING');

  const existing = path.join(os.tmpdir(), 'cla-exec-record.json');
  fs.writeFileSync(existing, '{}', 'utf8');
  const r2 = await v({ sessionPath, executionRecordPath: existing });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'NO_VERIFIER_PRIMITIVE');

  const okPrim = deterministicVerifierAdapter({ verify: async () => ({ ok: true, value: { verdict: 'PASS', n: 1 } }) });
  const r3 = await okPrim({ sessionPath, executionRecordPath: existing });
  assert.equal(r3.ok, true);
  assert.equal(r3.value.verdict, 'PASS');
});

test('gemini preReview: no transport fail-closed; non-PASS maps to REWORK only', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const { sessionPath } = mkSessionFile(stateDir);
  const r1 = await geminiPreReviewAdapter({})({ sessionPath, report: {} });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'NO_GEMINI_TRANSPORT');

  const r2 = await geminiPreReviewAdapter({ transport: async () => ({ ok: true, value: { verdict: 'ISSUES', findings: ['f'] } }) })({ sessionPath, report: {} });
  assert.equal(r2.ok, true);
  assert.equal(r2.value.verdict, 'REWORK');
  assert.deepEqual(r2.value.findings, ['f']);
});

test('gpt finalReview: invalid verdict rejected, verdicts preserved verbatim', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const { sessionPath } = mkSessionFile(stateDir);
  const r1 = await gptFinalReviewAdapter({})({ sessionPath, report: {}, preReview: {} });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'NO_GPT_TRANSPORT');

  const r2 = await gptFinalReviewAdapter({ transport: async () => ({ ok: true, value: { verdict: 'MAYBE' } }) })({ sessionPath, report: {}, preReview: {} });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'INVALID_REVIEWER_VERDICT');

  for (const verdict of ['PASS', 'REWORK', 'BLOCKED']) {
    const r = await gptFinalReviewAdapter({ transport: async () => ({ ok: true, value: { verdict, findings: [] } }) })({ sessionPath, report: {}, preReview: {} });
    assert.equal(r.ok, true);
    assert.equal(r.value.verdict, verdict);
  }
});

test('delivery: dispatch status mapped, session NOT terminalized by delivery', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const { sessionPath } = mkSessionFile(stateDir);
  const spawnAdapter = telegramDeliveryAdapter({ stateDir, configPath: 'Z:/no-telegram-config.json', spawn: () => ({ ok: true }) });
  const r = await spawnAdapter({ sessionPath, decision: { verdict: 'PASS' } });
  assert.ok(['NOT_ATTEMPTED', 'DELIVERY_FAILED', 'API_ACCEPTED'].includes(r.value.dispatchStatus), JSON.stringify(r));
  assert.equal(r.value.shipped, false); // no real Telegram config on this machine
  // Session record must NOT be terminal — delivery never terminalizes.
  const after = readSessionRecord(sessionPath);
  assert.equal(after.session.state, 'SESSION_ACTIVE');
});

test('G-hard: adapters never import or call taskFinish/taskBlock (Issue #67 regression)', async () => {
  const src = fs.readFileSync(
    new URL('../packages/control-loop/adapters.mjs', import.meta.url),
    'utf8',
  );
  assert.ok(!src.includes('taskFinish'), 'adapters.mjs must not reference taskFinish');
  assert.ok(!src.includes('taskBlock'), 'adapters.mjs must not reference taskBlock');
  // And they only ever consume readSessionRecord — never write the session.
  assert.ok(!src.includes('writeFileSync(sessionPath'), 'adapters must not write the session record');
});


