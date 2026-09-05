// tests/control-loop.adapters.test.mjs — deterministic adapter-contract tests.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { identityHash } from '../packages/workspace/workspace.mjs';
import {
  executorRouter,
  launchExecutorAdapter,
  deterministicVerifierAdapter,
  geminiPreReviewAdapter,
  gptFinalReviewAdapter,
  telegramDeliveryAdapter,
  packetPathFor,
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

test('router: active session maps to {model, executorKind}; fail-closed otherwise', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const { sessionPath, session } = mkSessionFile(stateDir);
  const r = await executorRouter({})({ sessionPath });
  assert.equal(r.ok, true);
  assert.equal(r.value.executorKind, 'opencode');
  assert.equal(r.value.model, null);
  const rModel = await executorRouter({ model: 'google/gemini-3.8-flash' })({ sessionPath });
  assert.equal(rModel.value.model, 'google/gemini-3.8-flash');

  // Non-active session fails closed (no launch from a terminal state).
  fs.writeFileSync(sessionPath, JSON.stringify({ ...session, state: 'COMPLETED' }), 'utf8');
  const rBlocked = await executorRouter({})({ sessionPath });
  assert.equal(rBlocked.ok, false);
  assert.equal(rBlocked.code, 'SESSION_NOT_ACTIVE');

  // Absent session record fails closed.
  const rMissing = await executorRouter({})({ sessionPath: path.join(stateDir, 'sessions', 'zz.json') });
  assert.equal(rMissing.ok, false);
});

// Canonical full session + binding file, mirroring what taskStart publishes.
function mkFullSession(stateDir) {
  const issueNumber = 71;
  const id = identityHash({ repo: 'duongpdddic-droid/soc_brain', issueNumber });
  const bindingPath = path.join(stateDir, 'bindings', `${id}.json`);
  fs.mkdirSync(path.dirname(bindingPath), { recursive: true });
  fs.writeFileSync(bindingPath, JSON.stringify({
    schemaVersion: '1.0',
    taskId: `duongpdddic-droid/soc_brain#${issueNumber}`,
    repo: 'duongpdddic-droid/soc_brain',
    issueNumber,
    baseSha: 'a'.repeat(40),
    branch: 'agent/test',
    path: stateDir,
    identityHash: id,
  }), 'utf8');
  const { sessionPath } = mkSessionFile(stateDir, {
    issueNumber,
    controlPlane: { stateDir, bindingPath, worktreesRoot: stateDir },
    lease: { token: 'lease-71' },
  });
  return { sessionPath, bindingPath, id };
}

test('executor: fail-closed seams (no transport, no instruction, no binding, bad handle, no stateDir)', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const { sessionPath } = mkSessionFile(stateDir);
  const r1 = await launchExecutorAdapter({ startExecution: null })({ sessionPath });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'NO_EXECUTOR_TRANSPORT');

  const full = mkFullSession(stateDir);
  const r2 = await launchExecutorAdapter({ startExecution: () => ({ ok: true, recordPath: 'x' }) })({ sessionPath: full.sessionPath });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'INSTRUCTION_REQUIRED');

  const r3 = await launchExecutorAdapter({ startExecution: () => ({ ok: false, code: 'X' }), instruction: 'do work' })({ sessionPath: full.sessionPath });
  assert.equal(r3.ok, false);
  assert.equal(r3.code, 'LAUNCH_FAILED');

  const r4 = await launchExecutorAdapter({ startExecution: () => ({ ok: true }), instruction: 'do work' })({ sessionPath: full.sessionPath });
  assert.equal(r4.ok, false);
  assert.equal(r4.code, 'LAUNCH_HANDLE_INVALID');

  // Binding file absent -> BINDING_UNAVAILABLE; startExecution is never called.
  const noBindDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const miss = mkSessionFile(noBindDir, {
    issueNumber: 71,
    controlPlane: { stateDir: noBindDir, bindingPath: path.join(noBindDir, 'bindings', 'absent.json') },
    lease: { token: 'lease-71' },
  });
  let called = false;
  const r5 = await launchExecutorAdapter({ startExecution: () => { called = true; return { ok: true, recordPath: 'x' }; }, instruction: 'do work' })({ sessionPath: miss.sessionPath });
  assert.equal(r5.ok, false);
  assert.equal(r5.code, 'BINDING_UNAVAILABLE');
  assert.equal(called, false);

  // Malformed binding JSON -> BINDING_UNAVAILABLE.
  fs.mkdirSync(path.dirname(miss.session.controlPlane.bindingPath), { recursive: true });
  fs.writeFileSync(miss.session.controlPlane.bindingPath, '{corrupt', 'utf8');
  const r6 = await launchExecutorAdapter({ startExecution: () => ({ ok: true, recordPath: 'x' }), instruction: 'do work' })({ sessionPath: miss.sessionPath });
  assert.equal(r6.ok, false);
  assert.equal(r6.code, 'BINDING_UNAVAILABLE');

  // No control-plane stateDir -> STATE_DIR_UNAVAILABLE.
  const noSdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const noSd = mkSessionFile(noSdDir, { issueNumber: 71, controlPlane: { bindingPath: full.bindingPath }, lease: { token: 'lease-71' } });
  const r7 = await launchExecutorAdapter({ instruction: 'do work' })({ sessionPath: noSd.sessionPath });
  assert.equal(r7.ok, false);
  assert.equal(r7.code, 'STATE_DIR_UNAVAILABLE');
});

test('executor: real-wiring mapping — launch args re-derived from canonical session; EXITED passes record path', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const full = mkFullSession(stateDir);
  let seen = null;
  const recPath = path.join(stateDir, 'executions', `${full.id}.json`);
  const adapter = launchExecutorAdapter({
    startExecution: (args) => { seen = args; return { ok: true, recordPath: recPath, pid: 4242 }; },
    readStatus: () => ({ ok: true, execution: { status: 'EXITED', terminalStatus: 'EXITED', reason: null } }),
    instruction: 'print hello; do not modify files',
    controlCwd: 'C:/control',
    delay: () => Promise.resolve(),
  });
  const r = await adapter({ sessionPath: full.sessionPath, model: null });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.executionStatus, 'EXITED');
  assert.equal(r.value.terminalStatus, 'EXITED');
  assert.equal(r.value.executionRecordPath, recPath);
  // Authority mapping: binding re-read from the canonical binding file; lease
  // token from the persisted session record; stateDir from controlPlane.
  assert.equal(seen.binding.identityHash, full.id);
  assert.equal(seen.binding.path, stateDir);
  assert.equal(seen.session.leaseToken, 'lease-71');
  assert.equal(seen.sessionPath, full.sessionPath);
  assert.equal(seen.stateDir, stateDir);
  assert.equal(seen.controlCwd, 'C:/control');
  assert.equal(seen.instruction, 'print hello; do not modify files');
  assert.equal(seen.model, null);
});

test('executor: FAILED terminal fails closed; corrupt record fails closed; deadline timeouts', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const full = mkFullSession(stateDir);
  const recPath = path.join(stateDir, 'executions', `${full.id}.json`);

  const rf = await launchExecutorAdapter({
    startExecution: () => ({ ok: true, recordPath: recPath }),
    readStatus: () => ({ ok: true, execution: { status: 'FAILED', terminalStatus: 'FAILED', reason: 'EXECUTOR_EXIT_CODE_1_SIGNAL_null' } }),
    instruction: 'do work',
    delay: () => Promise.resolve(),
  })({ sessionPath: full.sessionPath });
  assert.equal(rf.ok, false);
  assert.equal(rf.code, 'EXECUTOR_FAILED');

  // Unreadable status + no record file on disk -> loops to deadline timeout.
  const ru = await launchExecutorAdapter({
    startExecution: () => ({ ok: true, recordPath: recPath }),
    readStatus: () => ({ ok: false, reason: 'EXECUTION_RECORD_CORRUPT' }),
    instruction: 'do work',
    pollDeadlineMs: 40,
    pollIntervalMs: 1,
    delay: () => Promise.resolve(),
  })({ sessionPath: full.sessionPath });
  assert.equal(ru.ok, false);
  assert.equal(ru.code, 'EXECUTOR_TIMEOUT');

  // Unreadable status + record file present on disk -> immediate fail-closed.
  fs.mkdirSync(path.dirname(recPath), { recursive: true });
  fs.writeFileSync(recPath, '{corrupt', 'utf8');
  const rc = await launchExecutorAdapter({
    startExecution: () => ({ ok: true, recordPath: recPath }),
    readStatus: () => ({ ok: false, reason: 'EXECUTION_RECORD_CORRUPT' }),
    instruction: 'do work',
    delay: () => Promise.resolve(),
  })({ sessionPath: full.sessionPath });
  assert.equal(rc.ok, false);
  assert.equal(rc.code, 'EXECUTION_RECORD_UNREADABLE');
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

test('delivery: packet required, dispatch status mapped, session NOT terminalized by delivery', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const { sessionPath } = mkSessionFile(stateDir);
  const packet = path.join(stateDir, 'packet.md');
  fs.writeFileSync(packet, '# Review Ready — packet', 'utf8');
  const spawnAdapter = telegramDeliveryAdapter({ stateDir, configPath: 'Z:/no-telegram-config.json', packetPath: packet, spawn: () => ({ ok: true }) });
  const r = await spawnAdapter({ sessionPath, decision: { verdict: 'PASS' } });
  assert.ok(['NOT_ATTEMPTED', 'DELIVERY_FAILED', 'API_ACCEPTED'].includes(r.value.dispatchStatus), JSON.stringify(r));
  assert.equal(r.value.shipped, false); // no real Telegram config on this machine
  assert.equal(r.value.packet, path.basename(packet));
  // Session record must NOT be terminal — delivery never terminalizes.
  const after = readSessionRecord(sessionPath);
  assert.equal(after.session.state, 'SESSION_ACTIVE');
});

test('delivery: fail-closed without a resolvable review packet (no second truth fabricated)', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const { sessionPath } = mkSessionFile(stateDir);
  const emptyRr = path.join(stateDir, 'review-ready-empty'); // deterministic: no packet anywhere
  const noPacket = telegramDeliveryAdapter({ stateDir, configPath: 'Z:/no-telegram-config.json', reviewReadyDir: emptyRr, spawn: () => ({ ok: true }) });
  const r = await noPacket({ sessionPath, decision: { verdict: 'PASS' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_REVIEW_PACKET');
});

test('packetPathFor: resolves newest canonical review-ready artifact; NO_REVIEW_PACKET when absent', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const { sessionPath, session } = mkSessionFile(stateDir);
  const dir = path.join(stateDir, 'review-ready');
  fs.mkdirSync(dir, { recursive: true });
  const missing = packetPathFor({ reviewReadyDir: dir, sessionPath });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'NO_REVIEW_PACKET');

  // Two canonical artifacts (different PR/HEAD) — newest (highest PR/HEAD suffix) wins.
  const prefix = `${session.repo.replace('/', '_')}_Issue-${session.issueNumber}_PR-`;
  const f1 = `${prefix}68_5055ab5_review-ready.md`;
  const f2 = `${prefix}70_9b480da_review-ready.md`;
  fs.writeFileSync(path.join(dir, f1), 'old packet', 'utf8');
  fs.writeFileSync(path.join(dir, f2), 'new packet', 'utf8');
  const found = packetPathFor({ reviewReadyDir: dir, sessionPath });
  assert.equal(found.ok, true);
  assert.equal(found.filename, f2);
  // Only *_review-ready.md files match; unrelated files are ignored.
  fs.writeFileSync(path.join(dir, `${prefix}71_deadbeef_other.md`), 'x', 'utf8');
  const found2 = packetPathFor({ reviewReadyDir: dir, sessionPath });
  assert.equal(found2.filename, f2);
  // Session record untouched by resolution.
  assert.equal(readSessionRecord(sessionPath).session.state, 'SESSION_ACTIVE');
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


