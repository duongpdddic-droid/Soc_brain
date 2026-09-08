// tests/control-loop.adapters.test.mjs — deterministic adapter-contract tests.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
import {
  collectPreReviewEvidence,
  PRE_REVIEW_PACKET_MAX_BYTES,
} from '../packages/control-loop/gemini-pre-review.mjs';
import { readSessionRecord } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { ACTIVITY_TAIL_MAX_LINES } from '../packages/executor-launcher/executor-launcher.mjs';

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

// Issue #96 regression: replay of the Issue #92 evidence — a RUNNING executor
// with fresh activity must NOT be killed by the base poll deadline; silence
// (stall window) and the absolute cap must still fail closed deterministically.
test('executor poll (#96): activity extends the deadline; silence + absolute cap fail closed', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const full = mkFullSession(stateDir);
  const recPath = path.join(stateDir, 'executions', `${full.id}.json`);

  let now = 1_000_000;
  const clock = () => now;
  // Activity items carrying the native event time field `t` (Issue #96 rework).
  const runningWithT = (tOrTs, totalLines) => {
    const ts = Array.isArray(tOrTs) ? tOrTs : [tOrTs];
    return {
      ok: true,
      execution: { status: 'RUNNING', terminalStatus: null, reason: null },
      activity: { ok: true, items: ts.map((t) => ({ t, seq: t, stream: 'stdout' })), totalLines: totalLines ?? ts.length, truncated: false },
    };
  };
  const mk = (readStatus) => launchExecutorAdapter({
    startExecution: () => ({ ok: true, recordPath: recPath }),
    readStatus,
    instruction: 'do work',
    pollDeadlineMs: 30 * 60 * 1000,
    pollDeadlineMaxMs: 4 * 60 * 60 * 1000,
    stallWindowMs: 10 * 60 * 1000,
    pollIntervalMs: 60 * 1000,
    clock,
    delay: (ms) => { now += ms; return Promise.resolve(); },
  });

  // Replay #92 with native event times: the latest event time keeps advancing
  // while totalLines SATURATES (tail capped at 512 lines). Liveness must come
  // from event `t`, not line-count growth.
  let calls = 0;
  const rProg = await mk((args) => {
    calls++;
    assert.equal(args.includeActivity, true);
    return runningWithT(now, ACTIVITY_TAIL_MAX_LINES); // `t` advances with `now`
  })({ sessionPath: full.sessionPath });
  assert.equal(rProg.ok, false);
  assert.equal(rProg.code, 'EXECUTOR_TIMEOUT');
  assert.equal(rProg.detail.reason, 'POLL_DEADLINE_MAX_EXCEEDED');
  assert.equal(rProg.detail.status, 'RUNNING');
  assert.ok(calls > 30, `expected polls past the 30m base window, got ${calls}`);

  // Same saturation but with FROZEN event time -> event-time stall fires (the
  // stall reason must not be masked by the still-growing fallback path).
  now = 1_000_000;
  const tStall = now;
  const rStallT = await mk(() => runningWithT(tStall))({ sessionPath: full.sessionPath });
  assert.equal(rStallT.ok, false);
  assert.equal(rStallT.code, 'EXECUTOR_TIMEOUT');
  assert.equal(rStallT.detail.reason, 'NO_EXECUTOR_ACTIVITY_WITHIN_STALL_WINDOW');
  assert.equal(rStallT.detail.lastActivityEventT, tStall);
  assert.ok(now - tStall < 30 * 60 * 1000, 'event-time stall must fire before the base window');

  // No activity evidence at all (activity tail unavailable) -> base window
  // still fails closed (fail-closed preserved).
  const rNoAct = await mk(() => ({ ok: true, execution: { status: 'RUNNING' }, activity: { ok: false, reason: 'ACTIVITY_UNAVAILABLE' } }))({ sessionPath: full.sessionPath });
  assert.equal(rNoAct.ok, false);
  assert.equal(rNoAct.code, 'EXECUTOR_TIMEOUT');
  assert.equal(rNoAct.detail.reason, 'NO_EXECUTOR_ACTIVITY_SINCE_LAUNCH');
});

// Issue #96 rework (findings 2+3): the absolute pollDeadlineMaxMs cap is an
// UNCONDITIONAL first-order bound. Event times are FROZEN from launch and
// stallWindowMs == pollDeadlineMaxMs, so the stall/base window and the
// absolute cap first expire on the SAME poll — that poll must return the
// absolute-cap failure (POLL_DEADLINE_MAX_EXCEEDED), never a stall reason
// (the pre-fix ordering returned NO_EXECUTOR_ACTIVITY_WITHIN_STALL_WINDOW).
test('executor poll (#96): absolute cap takes precedence over simultaneous stall expiry', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const full = mkFullSession(stateDir);
  const recPath = path.join(stateDir, 'executions', `${full.id}.json`);

  let now = 1_000_000;
  const clock = () => now;
  const eventT0 = now; // frozen: no event-time progress after launch
  const adapter = launchExecutorAdapter({
    startExecution: () => ({ ok: true, recordPath: recPath }),
    readStatus: () => ({
      ok: true,
      execution: { status: 'RUNNING', terminalStatus: null, reason: null },
      activity: { ok: true, items: [{ t: eventT0, seq: 1, stream: 'stdout' }], totalLines: 1, truncated: false },
    }),
    instruction: 'do work',
    pollDeadlineMs: 30 * 60 * 1000,
    pollDeadlineMaxMs: 10 * 60 * 1000, // == stallWindowMs: simultaneous expiry
    stallWindowMs: 10 * 60 * 1000,
    pollIntervalMs: 60 * 1000,
    clock,
    delay: (ms) => { now += ms; return Promise.resolve(); },
  });
  const r = await adapter({ sessionPath: full.sessionPath });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EXECUTOR_TIMEOUT');
  // First poll past both bounds (now = 1_660_000 > t0 + 10m): absolute cap wins.
  assert.equal(r.detail.reason, 'POLL_DEADLINE_MAX_EXCEEDED');
  assert.equal(r.detail.status, 'RUNNING');
});

// Issue #96 rework (finding 4): the LOST projection (dead pid + finalized =>
// INTERRUPTED) must flow through the adapter poll with includeActivity:true —
// the adapter reports EXECUTOR_INTERRUPTED and never waits on deadline logic.
test('executor poll (#96): LOST projection with includeActivity:true terminates the poll', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const full = mkFullSession(stateDir);
  const recPath = path.join(stateDir, 'executions', `${full.id}.json`);

  let now = 1_000_000;
  const adapter = launchExecutorAdapter({
    startExecution: () => ({ ok: true, recordPath: recPath }),
    readStatus: (args) => {
      assert.equal(args.includeActivity, true);
      return {
        ok: true,
        execution: { status: 'INTERRUPTED', terminalStatus: null, reason: null },
        activity: { ok: true, items: [{ t: now, seq: 1, stream: 'stdout' }], totalLines: 1, truncated: false },
      };
    },
    instruction: 'do work',
    pollDeadlineMs: 30 * 60 * 1000,
    pollDeadlineMaxMs: 4 * 60 * 60 * 1000,
    stallWindowMs: 10 * 60 * 1000,
    pollIntervalMs: 60 * 1000,
    clock: () => now,
    delay: (ms) => { now += ms; return Promise.resolve(); },
  });
  const r = await adapter({ sessionPath: full.sessionPath });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EXECUTOR_INTERRUPTED');
  assert.equal(r.detail.terminalStatus, null);
});

// Canonical execution-record fixture: exactly the shape startExecution writes
// at stateDir/executions/<identityHash>.json on a clean EXITED run.
function mkExecRecord(stateDir, overrides = {}) {
  const id = identityHash({ repo: 'duongpdddic-droid/soc_brain', issueNumber: 69 });
  const recPath = path.join(stateDir, 'executions', `${id}.json`);
  fs.mkdirSync(path.dirname(recPath), { recursive: true });
  fs.writeFileSync(recPath, JSON.stringify({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: id,
    taskId: 'duongpdddic-droid/soc_brain#69',
    repo: 'duongpdddic-droid/soc_brain', issueNumber: 69, baseSha: 'a'.repeat(40),
    branch: 'agent/test', worktreePath: stateDir, executor: 'opencode', executable: 'opencode',
    model: null, pid: 4242, startedAt: '2026-01-01T00:01:00.000Z', finishedAt: '2026-01-01T00:05:00.000Z',
    exitCode: 0, signal: null, terminalStatus: 'EXITED', reason: null,
    instructionDigest: 'd'.repeat(64), instructionBytes: 10, sessionId: null,
    eventsPath: recPath.replace(/\.json$/, '.events.jsonl'), eventsOverflow: false,
    ...overrides,
  }, null, 2), 'utf8');
  return recPath;
}

// Verifier-scoped session: minimal mkSessionFile + the control-plane/binding
// fields the real taskStart-published session carries.
function mkVerSession(stateDir, overrides = {}) {
  return mkSessionFile(stateDir, {
    controlPlane: { stateDir },
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    worktreePath: stateDir,
    ...overrides,
  });
}

test('verifier (P0-B): PASS only on the canonical EXITED/0 record; structured deterministic evidence', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const { sessionPath } = mkVerSession(stateDir);
  const recPath = mkExecRecord(stateDir);
  const v = deterministicVerifierAdapter();
  const r = await v({ sessionPath, executionRecordPath: recPath });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.verdict, 'PASS');
  assert.equal(r.value.evidence.kind, 'ExecutionRecord');
  assert.equal(r.value.evidence.source, 'executor-launcher/readExecutionRecord');
  assert.equal(r.value.evidence.executionRecordPath, recPath);
  assert.equal(r.value.evidence.exitCode, 0);
  assert.equal(r.value.evidence.taskId, 'duongpdddic-droid/soc_brain#69');
  assert.equal(r.value.evidence.worktreePath, stateDir);
  assert.equal(r.value.evidence.baseSha, 'a'.repeat(40));
  // Ownership: the verifier reads evidence only — session record untouched.
  assert.equal(readSessionRecord(sessionPath).session.state, 'SESSION_ACTIVE');
});

test('verifier (P0-B): executor handle must be the canonical record path (no second truth)', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const { sessionPath } = mkVerSession(stateDir);
  const recPath = mkExecRecord(stateDir);
  const v = deterministicVerifierAdapter();
  // A forged/stale copy elsewhere — even byte-identical — is refused.
  const copy = path.join(stateDir, 'executions-copy', 'record.json');
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.writeFileSync(copy, fs.readFileSync(recPath, 'utf8'), 'utf8');
  const rCopy = await v({ sessionPath, executionRecordPath: copy });
  assert.equal(rCopy.ok, false);
  assert.equal(rCopy.code, 'EXECUTION_RECORD_MISMATCH');

  const rNone = await v({ sessionPath, executionRecordPath: null });
  assert.equal(rNone.ok, false);
  assert.equal(rNone.code, 'EXECUTION_RECORD_MISSING');
});

test('verifier (P0-B): missing/malformed/schema-invalid evidence fails closed', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const { sessionPath } = mkVerSession(stateDir);
  const recPath = mkExecRecord(stateDir);
  const v = deterministicVerifierAdapter();

  fs.rmSync(recPath);
  const rMiss = await v({ sessionPath, executionRecordPath: recPath });
  assert.equal(rMiss.ok, false);
  assert.equal(rMiss.code, 'EXECUTION_RECORD_MISSING');

  mkExecRecord(stateDir);
  fs.writeFileSync(recPath, '{corrupt', 'utf8');
  const rBad = await v({ sessionPath, executionRecordPath: recPath });
  assert.equal(rBad.ok, false);
  assert.equal(rBad.code, 'EXECUTION_RECORD_INVALID');

  mkExecRecord(stateDir, { schemaVersion: '999' });
  const rSchema = await v({ sessionPath, executionRecordPath: recPath });
  assert.equal(rSchema.ok, false);
  assert.equal(rSchema.code, 'EXECUTION_RECORD_INVALID');
});

test('verifier (P0-B): stale/mismatched binding evidence fails closed', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const { sessionPath } = mkVerSession(stateDir);
  const recPath = mkExecRecord(stateDir);
  const v = deterministicVerifierAdapter();

  // Record of a DIFFERENT task left at this identity's canonical location.
  mkExecRecord(stateDir, { taskId: 'duongpdddic-droid/soc_brain#999' });
  const rTask = await v({ sessionPath, executionRecordPath: recPath });
  assert.equal(rTask.ok, false);
  assert.equal(rTask.code, 'EXECUTION_RECORD_STALE');

  // Re-provisioned worktree: record.baseSha differs from the session binding.
  mkExecRecord(stateDir, { baseSha: 'f'.repeat(40) });
  const rBase = await v({ sessionPath, executionRecordPath: recPath });
  assert.equal(rBase.ok, false);
  assert.equal(rBase.code, 'EXECUTION_RECORD_STALE');

  // headSha binding checked where available: a record carrying a different
  // headSha than the session is refused.
  mkExecRecord(stateDir, { headSha: 'e'.repeat(40) });
  const rHead = await v({ sessionPath, executionRecordPath: recPath });
  assert.equal(rHead.ok, false);
  assert.equal(rHead.code, 'EXECUTION_RECORD_STALE');
});

test('verifier (P0-B): non-terminal, failing and dirty-exit records never verify PASS', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const { sessionPath } = mkVerSession(stateDir);
  const recPath = mkExecRecord(stateDir);
  const v = deterministicVerifierAdapter();

  // Still running: no terminal observation, fail closed.
  mkExecRecord(stateDir, { terminalStatus: null, exitCode: null, finishedAt: null });
  const rRun = await v({ sessionPath, executionRecordPath: recPath });
  assert.equal(rRun.ok, false);
  assert.equal(rRun.code, 'EXECUTION_NOT_TERMINAL');

  // Executor process failed: deterministic negative verdict.
  mkExecRecord(stateDir, { terminalStatus: 'FAILED', exitCode: 2, reason: 'EXECUTOR_EXIT_CODE_2_SIGNAL_null' });
  const rFail = await v({ sessionPath, executionRecordPath: recPath });
  assert.equal(rFail.ok, false);
  assert.equal(rFail.code, 'EXECUTOR_FAILED');

  // EXITED but non-zero exit code: not a verified execution.
  mkExecRecord(stateDir, { terminalStatus: 'EXITED', exitCode: 1 });
  const rDirty = await v({ sessionPath, executionRecordPath: recPath });
  assert.equal(rDirty.ok, false);
  assert.equal(rDirty.code, 'EXECUTION_VERIFICATION_FAILED');
});

test('verifier (P0-B): authority gates fail closed (no stateDir); evidence not trusted from caller', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const recPath = mkExecRecord(stateDir);
  const v = deterministicVerifierAdapter();

  // Session without a control-plane stateDir: authority underivable.
  const bare = mkSessionFile(fs.mkdtempSync(path.join(os.tmpdir(), 'cla-')));
  const rNoSd = await v({ sessionPath: bare.sessionPath, executionRecordPath: recPath });
  assert.equal(rNoSd.ok, false);
  assert.equal(rNoSd.code, 'STATE_DIR_UNAVAILABLE');

  // Pointing the handle at an arbitrary existing JSON cannot smuggle evidence:
  // the primitive reads the canonical location, whose record is missing here.
  const decoy = path.join(bare.sessionPath);
  const rDecoy = await v({ sessionPath: bare.sessionPath, executionRecordPath: decoy });
  assert.equal(rDecoy.ok, false);
  assert.ok(['EXECUTION_RECORD_MISSING', 'STATE_DIR_UNAVAILABLE'].includes(rDecoy.code), rDecoy.code);
});

test('gemini preReview: no transport fail-closed; strict verdict mapping', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const { sessionPath } = mkSessionFile(stateDir);
  const r1 = await geminiPreReviewAdapter({})({ sessionPath, report: {} });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'NO_GEMINI_TRANSPORT');

  const text = (verdict) => JSON.stringify({ verdict, findings: ['f'], confidence: 0.5, metadata: {} });
  const r2 = await geminiPreReviewAdapter({ transport: async () => ({ ok: true, text: text('REWORK') }) })({ sessionPath, report: {} });
  assert.equal(r2.ok, true);
  assert.equal(r2.value.verdict, 'REWORK');
  assert.deepEqual(r2.value.findings, ['f']);

  // Strict: verdict outside {PASS, REWORK} fails closed — never lenient-mapped.
  const r3 = await geminiPreReviewAdapter({ transport: async () => ({ ok: true, text: text('ISSUES') }) })({ sessionPath, report: {} });
  assert.equal(r3.ok, false);
  assert.equal(r3.code, 'GEMINI_VERDICT_INVALID');
});

test('gpt finalReview: no transport fail-closed; strict verdict + echoed binding (P0-D)', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const { sessionPath } = mkSessionFile(stateDir);
  // Canonical self-identifying packet fixture (P0-D evidence gate).
  const HEAD = 'a'.repeat(40);
  const rr = path.join(stateDir, 'review-ready');
  fs.mkdirSync(rr, { recursive: true });
  fs.writeFileSync(path.join(rr, 'duongpdddic-droid_soc_brain_Issue-69_PR-1_abcdef0_review-ready.md'), [
    '# Review Ready — duongpdddic-droid/soc_brain Issue #69 · PR #1',
    '',
    '## Identity',
    '- repository: duongpdddic-droid/soc_brain',
    '- issue: 69',
    '- pullRequest: 1',
    '- branch: agent/test',
    `- headSha: ${HEAD} (short ${HEAD.slice(0, 7)})`,
    `- baseSha: ${'b'.repeat(40)}`,
    '- prState: OPEN',
    '',
    'packet body',
  ].join('\n'), 'utf8');
  const args = { sessionPath, report: {}, preReview: {} };
  const r1 = await gptFinalReviewAdapter({})(args);
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'NO_GPT_TRANSPORT');

  const mkText = (verdict) => JSON.stringify({
    verdict, findings: [], evidenceRequests: [], confidence: 0.5, metadata: {},
    binding: { repository: 'duongpdddic-droid/soc_brain', issue: 69, headSha: HEAD },
  });
  // Malformed reply fails closed.
  const rBad = await gptFinalReviewAdapter({ transport: async () => ({ ok: true, text: 'nope' }), reviewReadyDir: rr })(args);
  assert.equal(rBad.ok, false);
  assert.equal(rBad.code, 'GPT_RESPONSE_MALFORMED');

  // Strict: verdict outside {PASS, REWORK, BLOCKED} fails closed — never lenient-mapped.
  const rInv = await gptFinalReviewAdapter({ transport: async () => ({ ok: true, text: mkText('MAYBE') }), reviewReadyDir: rr })(args);
  assert.equal(rInv.ok, false);
  assert.equal(rInv.code, 'GPT_VERDICT_INVALID');

  // Echoed binding is gated against the canonical packet identity.
  const rStale = await gptFinalReviewAdapter({ transport: async () => ({ ok: true, text: JSON.stringify({ verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.5, metadata: {}, binding: { repository: 'duongpdddic-droid/soc_brain', issue: 69, headSha: 'f'.repeat(40) } }) }), reviewReadyDir: rr })(args);
  assert.equal(rStale.ok, false);
  assert.equal(rStale.code, 'GPT_BINDING_MISMATCH');

  for (const verdict of ['PASS', 'REWORK', 'BLOCKED']) {
    const r = await gptFinalReviewAdapter({ transport: async () => ({ ok: true, text: mkText(verdict) }), reviewReadyDir: rr })(args);
    assert.equal(r.ok, true);
    assert.equal(r.value.verdict, verdict);
    assert.ok(Array.isArray(r.value.evidenceRequests));
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

// Issue #100: the packet is bound into the evidence chain — packetInfo.sha256
// is the sha256 of the EXACT excerpt bytes embedded in both model prompts
// (the excerpt, not the full raw buffer), plus filename and identityHash.
test('packetInfo (#100): sha256 of excerpt bytes, filename and identityHash bound', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const HEAD = 'a'.repeat(40);
  const { sessionPath, id } = mkSessionFile(stateDir, { headSha: HEAD });
  const rr = path.join(stateDir, 'review-ready');
  fs.mkdirSync(rr, { recursive: true });
  const filename = 'duongpdddic-droid_soc_brain_Issue-69_PR-1_abcdef0_review-ready.md';
  const body = [
    '# Review Ready — duongpdddic-droid/soc_brain Issue #69 · PR #1',
    '',
    '## Identity',
    '- repository: duongpdddic-droid/soc_brain',
    '- issue: 69',
    '- pullRequest: 1',
    `- headSha: ${HEAD} (short ${HEAD.slice(0, 7)})`,
    `- baseSha: ${'b'.repeat(40)}`,
    '- prState: OPEN',
    '',
    'packet body',
  ].join('\n');
  fs.writeFileSync(path.join(rr, filename), body, 'utf8');

  const ev = collectPreReviewEvidence({ sessionPath, report: {}, reviewReadyDir: rr });
  assert.equal(ev.ok, true, JSON.stringify({ ok: ev.ok, code: ev.code }));
  const raw = fs.readFileSync(path.join(rr, filename));
  const excerpt = raw.subarray(0, PRE_REVIEW_PACKET_MAX_BYTES);
  assert.equal(ev.packet.sha256, createHash('sha256').update(excerpt).digest('hex'));
  assert.match(ev.packet.sha256, /^[0-9a-f]{64}$/);
  assert.equal(ev.packet.filename, filename);
  assert.equal(ev.packet.name, filename); // `name` field unchanged
  assert.equal(ev.packet.identityHash, id);
  assert.equal(ev.packet.truncated, false);
  assert.equal(ev.packet.excerpt, excerpt.toString('utf8')); // excerpt semantics unchanged

  // Truncated case: digest covers ONLY the embedded excerpt bytes, never the
  // full raw buffer beyond the bound.
  const big = body + '\n' + 'x'.repeat(PRE_REVIEW_PACKET_MAX_BYTES);
  fs.writeFileSync(path.join(rr, filename), big, 'utf8');
  const evBig = collectPreReviewEvidence({ sessionPath, report: {}, reviewReadyDir: rr });
  assert.equal(evBig.ok, true, JSON.stringify({ ok: evBig.ok, code: evBig.code }));
  const rawBig = fs.readFileSync(path.join(rr, filename));
  const excerptBig = rawBig.subarray(0, PRE_REVIEW_PACKET_MAX_BYTES);
  assert.equal(evBig.packet.truncated, true);
  assert.notEqual(rawBig.length, excerptBig.length);
  assert.equal(evBig.packet.sha256, createHash('sha256').update(excerptBig).digest('hex'));
  assert.notEqual(evBig.packet.sha256, createHash('sha256').update(rawBig).digest('hex'));
  assert.equal(evBig.packet.filename, filename);
  assert.equal(evBig.packet.identityHash, id);
});


