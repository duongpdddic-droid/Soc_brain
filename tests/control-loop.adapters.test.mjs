// tests/control-loop.adapters.test.mjs — deterministic adapter-contract tests.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { identityHash } from '../packages/workspace/workspace.mjs';
import {
  executorRouter,
  hasLiveDescendant,
  launchExecutorAdapter,
  deterministicVerifierAdapter,
  geminiPreReviewAdapter,
  gptFinalReviewAdapter,
  telegramDeliveryAdapter,
  packetPathFor,
  FILETIME_UNIX_EPOCH_MS,
} from '../packages/control-loop/adapters.mjs';
import { createActiveTestRunner } from '../packages/executor-launcher/test-run-evidence.mjs';
import { EventDelivery, DELIVERY_STATE } from '../packages/executor-launcher/event-delivery.mjs';
import { readSessionRecord } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { readWin32ProcessStartTime } from '../packages/temp-hygiene/temp-hygiene.mjs';
import { ACTIVITY_TAIL_MAX_LINES } from '../packages/executor-launcher/executor-launcher.mjs';
import { withBoundedRecovery, FAILURE_CLASSES } from '../packages/control-loop/execution-recovery.mjs';

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
  // The adapter now preserves pre-spawn error codes so execution-recovery can
  // classify them as PRE_SPAWN_EFFECT_PROVEN and apply the single retry budget.
  assert.equal(r3.code, 'X');

  const r4 = await launchExecutorAdapter({ startExecution: () => ({ ok: true }), instruction: 'do work' })({ sessionPath: full.sessionPath });
  assert.equal(r4.ok, false);
  assert.equal(r4.code, 'LAUNCH_INTERNAL_ERROR');

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

test('#246 post-spawn invalid handle never consumes retry or launches twice', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const { sessionPath } = mkFullSession(stateDir);
  let launches = 0;
  let cleanups = 0;
  const run = launchExecutorAdapter({ startExecution: () => { launches++; return { ok: true }; }, instruction: 'do work' });
  const result = await withBoundedRecovery({ stateDir, identityHash: 'a'.repeat(32),
    run: () => run({ sessionPath }), cleanup: () => { cleanups++; return { ok: true }; } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LAUNCH_INTERNAL_ERROR');
  assert.equal(result.recovery.class, FAILURE_CLASSES.UNKNOWN);
  assert.equal(result.recovery.retried, false);
  assert.equal(launches, 1);
  assert.equal(cleanups, 0);
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

// Issue #9000046 (observed 2026-10-20, tasks #9000044/#9000045): ONE blocking
// tool call (a 2140.8s full-suite shell call) emitted ZERO activity events for
// 35.7 minutes, so the 10-minute window terminalized an identity-proven-RUNNING
// executor as TASK_BLOCKED while the tool-completion event arrived only at
// ~16:05:30. In-flight work — a live DESCENDANT of the runner pid that provably
// started AFTER the last observed activity — is activity evidence: the stall
// window slides and the run reaches natural completion.
// soc_review #9000046 F1/F2: a persistent LAUNCH-TIME child (the always-on
// local stdio MCP broker: opencode-adapter.mjs mcp['soc-brain'], whose parent
// IS the executor pid per mcp-server.mjs) must NOT count as in-flight work, or
// the probe would be true in every production run and stall detection would be
// disabled; the root pid row must also identity-match record.processStartTime
// (FILETIME ticks) or a recycled pid's foreign children would fake liveness.
// With no events AND no qualifying live child, the stall path must still fail
// closed at the window (requirement 2).
const toTicks = (ms) => (ms + FILETIME_UNIX_EPOCH_MS) * 10000;
test('executor poll (#9000046): a post-activity descendant = in-flight tool call survives the window; a launch-time child does not; no qualifying child fails closed', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const full = mkFullSession(stateDir);
  const recPath = path.join(stateDir, 'executions', `${full.id}.json`);

  let now = 1_000_000;
  const clock = () => now;
  const tLastEvent = now;                 // seq 372 @15:29:30 — last event before the blocking call
  const toolDoneAt = now + 40 * 60 * 1000; // tool-completion event @ ~16:05:30 (2140.8s call)
  const pid = 4242;
  // Production-shaped process table: root (identity-proven) + a persistent
  // launch-time child (the MCP broker) + an optional work child.
  const rootStartTicks = toTicks(tLastEvent - 30 * 60 * 1000);
  const brokerStartTicks = toTicks(tLastEvent - 25 * 60 * 1000);
  const psRows = (workChildCreatedMs) => [
    `1 0 ${toTicks(tLastEvent - 60 * 60 * 1000)}`,
    `${pid} 1 ${rootStartTicks}`,
    `5555 ${pid} ${brokerStartTicks}`,
    ...(workChildCreatedMs != null ? [`6666 ${pid} ${toTicks(workChildCreatedMs)}`] : []),
  ].join('\n') + '\n';
  // Rows carry Win32 FILETIME ticks (pid ppid creation-filetime), the production
  // win32 shape of the real probe; synthetic ticks are true-basis, so the UTC
  // offset adjustment used for the real record basis is pinned to 0 here.
  const probe = (rowsOut) => (args) => hasLiveDescendant(args, { platform: 'win32', utcOffsetMinEast: 0, execFileAsync: async () => ({ stdout: rowsOut, stderr: '' }) });
  const mk = (descendantAlive) => launchExecutorAdapter({
    startExecution: () => ({ ok: true, recordPath: recPath }),
    readStatus: () => ({
      ok: true,
      execution: {
        status: now < toolDoneAt ? 'RUNNING' : 'EXITED',
        terminalStatus: now < toolDoneAt ? null : 'EXITED',
        reason: null,
        pid,
        processStartTime: rootStartTicks,
      },
      activity: { ok: true, items: [{ t: tLastEvent, seq: 1, stream: 'stdout' }], totalLines: 1, truncated: false },
    }),
    instruction: 'do work',
    pollDeadlineMs: 30 * 60 * 1000,
    pollDeadlineMaxMs: 4 * 60 * 60 * 1000,
    stallWindowMs: 10 * 60 * 1000,
    pollIntervalMs: 60 * 1000,
    clock,
    delay: (ms) => { now += ms; return Promise.resolve(); },
    descendantAlive,
  });

  // (1) Silent stream + work child born AFTER the last event -> NOT terminalized;
  // the run reaches natural EXITED completion (replay of #9000044).
  const probes = [];
  const rOk = await mk((args) => { probes.push(args); return probe(psRows(tLastEvent + 18 * 1000))(args); })({ sessionPath: full.sessionPath });
  assert.equal(rOk.ok, true, JSON.stringify(rOk));
  assert.equal(rOk.value.executionStatus, 'EXITED');
  assert.ok(probes.length >= 1, `descendant probe must run at the stall window edge, got ${probes.length}`);
  assert.ok(probes.every((p) => p.pid === pid && p.processStartTime === rootStartTicks),
    `probe must receive pid + processStartTime identity: ${JSON.stringify(probes)}`);
  assert.ok(probes.every((p) => p.since === tLastEvent), `probe must receive the last-activity baseline: ${JSON.stringify(probes)}`);

  // (2) F1 regression: only the persistent LAUNCH-TIME broker child is alive
  // (created 25 min BEFORE the last event) -> it is NOT in-flight work, so the
  // stall window fires at the edge instead of sliding forever.
  now = 1_000_000;
  const rHang = await mk(probe(psRows(null)))({ sessionPath: full.sessionPath });
  assert.equal(rHang.ok, false);
  assert.equal(rHang.code, 'EXECUTOR_TIMEOUT');
  assert.equal(rHang.detail.reason, 'NO_EXECUTOR_ACTIVITY_WITHIN_STALL_WINDOW');
  assert.ok(now - tLastEvent >= 10 * 60 * 1000 && now - tLastEvent < 30 * 60 * 1000,
    `stall must fire at the window despite the launch-time child, fired after ${now - tLastEvent}ms`);

  // (3) No events AND no child at all -> EXECUTOR_TIMEOUT still fires (requirement 2).
  now = 1_000_000;
  const rStall = await mk(probe(`1 0 ${toTicks(tLastEvent - 60 * 60 * 1000)}\n${pid} 1 ${rootStartTicks}\n`))({ sessionPath: full.sessionPath });
  assert.equal(rStall.ok, false);
  assert.equal(rStall.code, 'EXECUTOR_TIMEOUT');
  assert.equal(rStall.detail.reason, 'NO_EXECUTOR_ACTIVITY_WITHIN_STALL_WINDOW');
});

// Requirement 2 backstop: in-flight evidence can never wait forever — a child
// tree that never exits is still bounded by the unconditional absolute cap
// (checked with precedence over the stall/base failures). The last activity
// event time is FROZEN at t0 and an eternal qualifying child keeps sliding the
// stall window, so this exercises the real slide path (probe per window edge)
// until the cap collects it — not just a progressing-activity loop.
test('executor poll (#9000046): an eternally-live child tree is still bounded by the absolute cap', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const full = mkFullSession(stateDir);
  const recPath = path.join(stateDir, 'executions', `${full.id}.json`);

  let now = 1_000_000;
  const t0 = now; // frozen last-activity baseline: no events ever arrive after it
  const clock = () => now;
  const capMs = 4 * 60 * 60 * 1000; // polling window under test == pollDeadlineMaxMs
  const windowMs = 10 * 60 * 1000; // stall window slides once per probe
  let probes = 0;
  const r = await launchExecutorAdapter({
    startExecution: () => ({ ok: true, recordPath: recPath }),
    readStatus: () => ({
      ok: true,
      execution: { status: 'RUNNING', terminalStatus: null, reason: null, pid: 4242 },
      activity: { ok: true, items: [{ t: t0, seq: 1, stream: 'stdout' }], totalLines: 1, truncated: false },
    }),
    instruction: 'do work',
    pollDeadlineMs: 5 * 60 * 60 * 1000, // base deadline beyond the cap: the cap must win
    pollDeadlineMaxMs: capMs, // absolute cap bounds eternal descendants
    stallWindowMs: windowMs,
    pollIntervalMs: 60 * 1000,
    clock,
    delay: (ms) => { now += ms; return Promise.resolve(); },
    descendantAlive: () => { probes++; return true; },
  })({ sessionPath: full.sessionPath });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EXECUTOR_TIMEOUT');
  assert.equal(r.detail.reason, 'POLL_DEADLINE_MAX_EXCEEDED');
  assert.ok(now - t0 >= capMs, `cap must be reached: elapsed=${now - t0}ms`);
  // The window must actually slide ~4h/10m times: fewer slides would mean the
  // loop exited via the stall path, not the cap.
  assert.ok(probes >= 20, `window must slide repeatedly: probes=${probes}`);
  // <= 1 probe per window: capMs/windowMs = 24 window edges; an every-poll probe
  // (240 polls) would blow this bound.
  assert.ok(probes <= capMs / windowMs, `probe rate must be <= 1 per window: ${probes}`);
});

// Criteria pin (#9000046): the DEFAULT stall window is 20 minutes — an executor
// with a frozen last-activity baseline and no qualifying child must fail at
// ~20m, not before 20m (a reverted 10m default would fail early), and not at
// the absolute cap.
test('executor poll (#9000046): default stallWindowMs is 20 minutes', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const full = mkFullSession(stateDir);
  const recPath = path.join(stateDir, 'executions', `${full.id}.json`);

  let now = 1_000_000;
  const t0 = now;
  const clock = () => now;
  const r = await launchExecutorAdapter({
    startExecution: () => ({ ok: true, recordPath: recPath }),
    readStatus: () => ({
      ok: true,
      execution: { status: 'RUNNING', terminalStatus: null, reason: null, pid: 4242 },
      activity: { ok: true, items: [{ t: t0, seq: 1, stream: 'stdout' }], totalLines: 1, truncated: false },
    }),
    instruction: 'do work',
    pollDeadlineMs: 60 * 60 * 1000, // no base-deadline interference below 45m
    pollDeadlineMaxMs: 45 * 60 * 1000,
    pollIntervalMs: 60 * 1000,
    clock,
    delay: (ms) => { now += ms; return Promise.resolve(); },
    descendantAlive: () => false,
  })({ sessionPath: full.sessionPath });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EXECUTOR_TIMEOUT');
  assert.equal(r.detail.reason, 'NO_EXECUTOR_ACTIVITY_WITHIN_STALL_WINDOW');
  assert.ok(now - t0 >= 20 * 60 * 1000, `default window must be >= 20m: fired after ${now - t0}ms`);
  assert.ok(now - t0 < 25 * 60 * 1000, `default window must be ~20m: fired after ${now - t0}ms`);
});

// The production probe itself: identity-bind the root pid (F2), count ONLY
// descendants that started AFTER the last observed activity (F1 — a launch-time
// infrastructure child such as the stdio MCP broker must not count), and fail
// closed on every unprovable input.
test('#9000046 hasLiveDescendant: identity-bound root + post-activity descendants only; unprovable inputs fail closed', async () => {
  const okExec = (out) => async () => ({ stdout: out, stderr: '' });
  const S = toTicks(1_000_000);        // last-activity baseline (ms epoch 1_000_000) in FILETIME ticks
  const root = 100;
  const rootStart = toTicks(900_000);  // launched 100s before the last activity

  // Fail-closed inputs never spawn a probe.
  assert.equal(await hasLiveDescendant({ pid: 0, processStartTime: rootStart, since: 1_000_000 }), false, 'invalid pid');
  assert.equal(await hasLiveDescendant({ pid: undefined, processStartTime: rootStart, since: 1_000_000 }), false, 'missing pid');
  assert.equal(await hasLiveDescendant({ pid: root, processStartTime: null, since: 1_000_000 }), false, 'unproven root identity fails closed (F2)');
  assert.equal(await hasLiveDescendant({ pid: root, processStartTime: rootStart, since: null }), false, 'no activity baseline fails closed (F1)');

  // F2 identity binding (win32 rows carry pid ppid CreationDate-filetime).
  assert.equal(await hasLiveDescendant({ pid: root, processStartTime: rootStart, since: 1_000_000 },
    { platform: 'win32', utcOffsetMinEast: 0, execFileAsync: okExec('200 100 9999999\n') }), false, 'root row missing -> false');
  assert.equal(await hasLiveDescendant({ pid: root, processStartTime: rootStart + 60_000_000, since: 1_000_000 },
    { platform: 'win32', utcOffsetMinEast: 0, execFileAsync: okExec(`100 1 ${rootStart}\n200 100 ${S + 5_000_000}\n`) }), false, 'root start-time mismatch = recycled pid -> false (F2)');

  // F1 discrimination: a launch-time child (started BEFORE the last event,
  // e.g. the always-on MCP broker) is NOT in-flight work.
  assert.equal(await hasLiveDescendant({ pid: root, processStartTime: rootStart, since: 1_000_000 },
    { platform: 'win32', utcOffsetMinEast: 0, execFileAsync: okExec(`100 1 ${rootStart}\n200 100 ${S - 10_000_000}\n`) }), false, 'launch-time child must not count (F1)');

  // A descendant started AFTER the last event is in-flight work (win32 branch).
  assert.equal(await hasLiveDescendant({ pid: root, processStartTime: rootStart, since: 1_000_000 },
    { platform: 'win32', utcOffsetMinEast: 0, execFileAsync: okExec(`100 1 ${rootStart}\n200 100 ${S + 5_000_000}\n`) }), true, 'win32 post-activity child');

  // POSIX branch (pid ppid etimes): root identity and depth-2 work trees
  // (opencode -> pwsh -> node test runner) both resolve; launch-time tree does not.
  const nowMs = 1_030_000;
  const psProbe = (out) => hasLiveDescendant({ pid: root, processStartTime: rootStart, since: 1_000_000 },
    { platform: 'linux', execFileAsync: okExec(out), nowMs });
  assert.equal(await psProbe(`  100     1   130\n  200   100   120\n`), false, 'ps launch-time tree must not count (F1)');
  assert.equal(await psProbe(`  100     1   130\n  200   100   130\n  300   200     5\n`), true, 'ps post-activity grandchild counts (deep work tree)');

  // Probe error fails closed (stall path stays reachable).
  assert.equal(await hasLiveDescendant({ pid: root, processStartTime: rootStart, since: 1_000_000 }, {
    platform: 'win32',
    utcOffsetMinEast: 0,
    execFileAsync: async () => { throw new Error('probe failed'); },
  }), false, 'probe error fails closed');

  // Real Windows end-to-end: CIM listing + Get-Process identity against a live
  // spawned child of THIS process (the production wiring, no injection).
  // Hosts that cannot provide Win32 process identity (powershell blocked/CIM
  // unavailable) are INELIGIBLE for the real probe, not regressions: the gated
  // assertions below are skipped there instead of hard-failing on an ambient
  // capability (OCR finding: CI flakiness guard).
  if (process.platform === 'win32') {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const exited = new Promise((resolve) => child.once('exit', () => resolve()));
    let pst = null;
    try {
      pst = readWin32ProcessStartTime(process.pid);
      if (pst && Number.isFinite(pst.processStartTime)) {
        const since = Date.now() - 60_000; // the spawned child is younger than the baseline
        assert.equal(await hasLiveDescendant({ pid: process.pid, processStartTime: pst.processStartTime, since }), true,
          'real live child of this process must be proven in-flight');
      }
    } finally {
      child.kill();
      await exited;
    }
    const pst2 = readWin32ProcessStartTime(process.pid);
    if (pst && Number.isFinite(pst.processStartTime) && pst2 && Number.isFinite(pst2.processStartTime)) {
      assert.equal(await hasLiveDescendant({ pid: process.pid, processStartTime: pst2.processStartTime, since: Date.now() - 60_000 }), false,
        'real exited child must not count as in-flight');
    }
  }
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

// ---- P3 (Omnigent selective integration): EventDelivery in the poll loop -----
// The poll loop is the PRODUCTION consumer of events.jsonl: sequenced activity
// events flow through the ACK-retained EventDelivery core. A refused submit
// rolls the producer cursor back so the identical chunk is resubmitted;
// unreadable-source intervals disconnect and then replay from the cursor
// (idempotent re-apply — the consumer is a monotone max over the event time
// `t`), so no seq range is ever skipped. RV2: the DELIVERY side reads the real
// append-only events file from the cursor (readActivityEventsAfter) — these
// tests therefore write a REAL events.jsonl per scenario; the injected
// readStatus keeps owning lifecycle + the #96 liveness tail.
function runningExec(items) {
  return {
    ok: true,
    execution: { status: 'RUNNING', terminalStatus: null, reason: null },
    activity: { ok: true, items, totalLines: items.length, truncated: false },
  };
}
const EXITED_NOW = { ok: true, execution: { status: 'EXITED', terminalStatus: 'EXITED', reason: null } };

function writeEventLines(eventsPath, events, { append = false } = {}) {
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  const data = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  if (append) fs.appendFileSync(eventsPath, data, 'utf8');
  else fs.writeFileSync(eventsPath, data, 'utf8');
}

test('executor poll (P3): activity events flow through the ACK delivery channel (cursor counts each event once)', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const full = mkFullSession(stateDir);
  const recPath = path.join(stateDir, 'executions', `${full.id}.json`);
  const eventsPath = path.join(stateDir, 'executions', `${full.id}.events.jsonl`);
  writeEventLines(eventsPath, [{ seq: 1, t: 1_000_001, stream: 'stdout' }]);
  let now = 1_000_000;
  let delivery = null;
  let polls = 0;
  const r = await launchExecutorAdapter({
    startExecution: () => ({ ok: true, recordPath: recPath }),
    readStatus: () => {
      polls += 1;
      if (polls === 1) return runningExec([{ t: now, seq: 1, stream: 'stdout' }]);
      if (polls === 2) {
        // a second event lands in the append-only source before this poll
        writeEventLines(eventsPath, [{ seq: 2, t: now, stream: 'stdout' }], { append: true });
        // The tail still carries seq 1: it was ACK-covered on poll 1 and must
        // NOT be counted again.
        return runningExec([{ t: now - 1, seq: 1, stream: 'stdout' }, { t: now, seq: 2, stream: 'stdout' }]);
      }
      return EXITED_NOW;
    },
    instruction: 'do work',
    pollDeadlineMs: 30 * 60 * 1000,
    pollDeadlineMaxMs: 4 * 60 * 60 * 1000,
    stallWindowMs: 10 * 60 * 1000,
    pollIntervalMs: 60 * 1000,
    clock: () => now,
    delay: (ms) => new Promise((res) => { now += ms; setImmediate(res); }),
    createDelivery: (opts) => { delivery = new EventDelivery(opts); return delivery; },
  })({ sessionPath: full.sessionPath });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(delivery, 'the adapter constructs the delivery channel');
  assert.equal(delivery.cursor(recPath), 2); // seq1 + seq2, each exactly once
  assert.equal(typeof delivery.lastDispatchAt, 'number'); // an ACK-covered dispatch happened
});

test('executor poll (P3): >maxEvents tail drains one chunk per poll in order (no seq-range skip on the next advance)', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const full = mkFullSession(stateDir);
  const recPath = path.join(stateDir, 'executions', `${full.id}.json`);
  const eventsPath = path.join(stateDir, 'executions', `${full.id}.events.jsonl`);
  let now = 1_000_000;
  let delivery = null;
  const big = [];
  const source = [];
  for (let i = 1; i <= 40; i += 1) {
    big.push({ t: 1_000_000 + i, seq: i, stream: 'stdout' });
    source.push({ t: 1_000_000 + i, seq: i, stream: 'stdout' });
  }
  writeEventLines(eventsPath, source);
  let polls = 0;
  const r = await launchExecutorAdapter({
    startExecution: () => ({ ok: true, recordPath: recPath }),
    readStatus: () => {
      polls += 1;
      if (polls <= 2) return runningExec(big); // saturated tail re-read verbatim (liveness only)
      return EXITED_NOW;
    },
    instruction: 'do work',
    pollDeadlineMs: 30 * 60 * 1000,
    pollDeadlineMaxMs: 4 * 60 * 60 * 1000,
    stallWindowMs: 10 * 60 * 1000,
    pollIntervalMs: 60 * 1000,
    clock: () => now,
    delay: (ms) => new Promise((res) => { now += ms; setImmediate(res); }),
    createDelivery: (opts) => { delivery = new EventDelivery(opts); return delivery; },
  })({ sessionPath: full.sessionPath });
  assert.equal(r.ok, true, JSON.stringify(r));
  // Poll 1 delivers the first bounded chunk [1..32]; poll 2 delivers [33..40]
  // from the unchanged cursor — 40 events, each exactly once, in order.
  assert.equal(delivery.cursor(recPath), 40);
});

test('executor poll (P3): unreadable activity disconnects the channel; recovery reconnects and continues from the cursor', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const full = mkFullSession(stateDir);
  const recPath = path.join(stateDir, 'executions', `${full.id}.json`);
  const eventsPath = path.join(stateDir, 'executions', `${full.id}.events.jsonl`);
  writeEventLines(eventsPath, [{ seq: 1, t: 1_000_001, stream: 'stdout' }]);
  let now = 1_000_000;
  let delivery = null;
  const statesAtPollEntry = [];
  let polls = 0;
  const r = await launchExecutorAdapter({
    startExecution: () => ({ ok: true, recordPath: recPath }),
    readStatus: () => {
      statesAtPollEntry.push(delivery ? delivery.state : null);
      polls += 1;
      if (polls === 1) return runningExec([{ t: now, seq: 1, stream: 'stdout' }]);
      if (polls === 2) {
        // the append-only source itself becomes unreadable (deleted)
        fs.rmSync(eventsPath, { force: true });
        return { ok: true, execution: { status: 'RUNNING', terminalStatus: null, reason: null }, activity: { ok: false, reason: 'ACTIVITY_UNAVAILABLE' } };
      }
      if (polls === 3) {
        // source restored with seq 1 + 2 — seq1 was already ACK-covered, only seq2 is fresh
        writeEventLines(eventsPath, [{ seq: 1, t: 1_000_001, stream: 'stdout' }, { seq: 2, t: 1_000_002, stream: 'stdout' }]);
        return runningExec([{ t: now, seq: 1, stream: 'stdout' }, { t: now, seq: 2, stream: 'stdout' }]);
      }
      return EXITED_NOW;
    },
    instruction: 'do work',
    pollDeadlineMs: 30 * 60 * 1000,
    pollDeadlineMaxMs: 4 * 60 * 60 * 1000,
    stallWindowMs: 10 * 60 * 1000,
    pollIntervalMs: 60 * 1000,
    clock: () => now,
    delay: (ms) => new Promise((res) => { now += ms; setImmediate(res); }),
    createDelivery: (opts) => { delivery = new EventDelivery(opts); return delivery; },
  })({ sessionPath: full.sessionPath });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(statesAtPollEntry[1], DELIVERY_STATE.READY); // connected on the first readable poll
  assert.equal(statesAtPollEntry[2], DELIVERY_STATE.DISCONNECTED); // poll 2 (unreadable source) disconnected the channel
  assert.equal(delivery.state, DELIVERY_STATE.READY); // poll 3 reconnected
  assert.equal(delivery.cursor(recPath), 2); // seq2 delivered after the recovery; seq1 never double-counted
});

test('executor poll (P3): a rejected submit never advances the cursor — the same chunk is resubmitted next poll', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const full = mkFullSession(stateDir);
  const recPath = path.join(stateDir, 'executions', `${full.id}.json`);
  const eventsPath = path.join(stateDir, 'executions', `${full.id}.events.jsonl`);
  writeEventLines(eventsPath, [{ seq: 1, t: 1_000_001, stream: 'stdout' }]);
  let now = 1_000_000;
  const submits = [];
  const fakeDelivery = {
    maxEvents: 32,
    state: DELIVERY_STATE.READY,
    connect() {}, ready() {},
    disconnected() { this.state = DELIVERY_STATE.DISCONNECTED; },
    acknowledge: () => ({ ok: true }),
    submit({ events }) {
      submits.push(events.map((e) => e.seq));
      if (submits.length === 1) return Promise.reject(new Error('QUEUE_FULL'));
      return Promise.resolve({ ok: true, applied: events.length });
    },
  };
  let polls = 0;
  const r = await launchExecutorAdapter({
    startExecution: () => ({ ok: true, recordPath: recPath }),
    readStatus: () => {
      polls += 1;
      if (polls <= 2) return runningExec([{ t: now, seq: 1, stream: 'stdout' }]);
      return EXITED_NOW;
    },
    instruction: 'do work',
    pollDeadlineMs: 30 * 60 * 1000,
    pollDeadlineMaxMs: 4 * 60 * 60 * 1000,
    stallWindowMs: 10 * 60 * 1000,
    pollIntervalMs: 60 * 1000,
    clock: () => now,
    delay: (ms) => new Promise((res) => { now += ms; setImmediate(res); }),
    createDelivery: () => fakeDelivery,
  })({ sessionPath: full.sessionPath });
  assert.equal(r.ok, true, JSON.stringify(r));
  // Poll 1's submit was rejected: the identical chunk is resubmitted on poll 2
  // (no cursor advance, no skipped range, liveness unaffected).
  assert.deepEqual(submits, [[1], [1]]);
});

// ---- RV2 (rework): delivery reads the append-only source FROM THE CURSOR ----
// The observability tail keeps only the last ACTIVITY_TAIL_MAX_LINES lines. A
// burst that slides the window past not-yet-submitted seqs must NEVER skip
// that range: delivery walks the real events.jsonl from its own cursor.
test('executor poll (RV2): a slipped tail never skips unsubmitted seqs (cursor-based source read)', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const full = mkFullSession(stateDir);
  const recPath = path.join(stateDir, 'executions', `${full.id}.json`);
  const eventsPath = path.join(stateDir, 'executions', `${full.id}.events.jsonl`);
  const N = 612; // 512-line tail window => a tail-derived fresh filter would start at seq 101
  const source = [];
  for (let i = 1; i <= N; i += 1) source.push({ seq: i, t: 1_000_000 + i, stream: 'stdout' });
  writeEventLines(eventsPath, source);
  // what the observability tail can still show: only seq 101..612
  const tailWindow = source.slice(-512);
  let now = 1_000_000;
  let delivery = null;
  let polls = 0;
  const submitted = [];
  const r = await launchExecutorAdapter({
    startExecution: () => ({ ok: true, recordPath: recPath }),
    readStatus: () => {
      polls += 1;
      if (polls <= 22) return runningExec(tailWindow);
      return EXITED_NOW;
    },
    instruction: 'do work',
    pollDeadlineMs: 30 * 60 * 1000,
    pollDeadlineMaxMs: 4 * 60 * 60 * 1000,
    stallWindowMs: 10 * 60 * 1000,
    pollIntervalMs: 1000, // fake clock: 23 polls must not outrun the stall window
    clock: () => now,
    delay: (ms) => new Promise((res) => { now += ms; setImmediate(res); }),
    createDelivery: (opts) => {
      const d = new EventDelivery(opts);
      const submit = d.submit.bind(d);
      d.submit = (args) => { submitted.push(args.events.map((e) => e.seq)); return submit(args); };
      delivery = d;
      return d;
    },
  })({ sessionPath: full.sessionPath });
  assert.equal(r.ok, true, JSON.stringify(r));
  const flat = submitted.flat();
  assert.equal(flat.length, N, `handed off ${flat.length} events`);
  for (let i = 0; i < N; i += 1) assert.equal(flat[i], i + 1, `seq gap/dup at index ${i} (got ${flat[i]})`);
  assert.equal(delivery.cursor(recPath), N); // every event ACK-covered exactly once
});

test('executor poll (RV2): terminal returns only AFTER the unsubmitted backlog is handed to the delivery core', async () => {
  // Scenario A: connected on an earlier poll; a burst lands after the last
  // RUNNING poll — the terminal branch must submit it before returning.
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const full = mkFullSession(stateDir);
  const recPath = path.join(stateDir, 'executions', `${full.id}.json`);
  const eventsPath = path.join(stateDir, 'executions', `${full.id}.events.jsonl`);
  writeEventLines(eventsPath, [{ seq: 1, t: 1_000_001, stream: 'stdout' }]);
  let now = 1_000_000;
  let delivery = null;
  let polls = 0;
  const r = await launchExecutorAdapter({
    startExecution: () => ({ ok: true, recordPath: recPath }),
    readStatus: () => {
      polls += 1;
      if (polls === 1) return runningExec([{ t: now, seq: 1, stream: 'stdout' }]);
      if (polls === 2) {
        writeEventLines(eventsPath, [
          { seq: 2, t: now, stream: 'stdout' },
          { seq: 3, t: now, stream: 'stdout' },
        ], { append: true });
        return EXITED_NOW;
      }
      return EXITED_NOW;
    },
    instruction: 'do work',
    pollDeadlineMs: 30 * 60 * 1000,
    pollDeadlineMaxMs: 4 * 60 * 60 * 1000,
    stallWindowMs: 10 * 60 * 1000,
    pollIntervalMs: 60 * 1000,
    clock: () => now,
    delay: (ms) => new Promise((res) => { now += ms; setImmediate(res); }),
    createDelivery: (opts) => { delivery = new EventDelivery(opts); return delivery; },
  })({ sessionPath: full.sessionPath });
  assert.equal(r.ok, true, JSON.stringify(r));
  await new Promise((res) => setImmediate(res));
  assert.equal(delivery.cursor(recPath), 3, 'seq2 + seq3 submitted by the terminal drain');

  // Scenario B: terminal on the FIRST poll — the drain connects the channel
  // and hands over the whole backlog (still bounded by the channel capacity).
  const stateDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const full2 = mkFullSession(stateDir2);
  const recPath2 = path.join(stateDir2, 'executions', `${full2.id}.json`);
  const eventsPath2 = path.join(stateDir2, 'executions', `${full2.id}.events.jsonl`);
  const backlog = [];
  for (let i = 1; i <= 5; i += 1) backlog.push({ seq: i, t: 1_000_000 + i, stream: 'stdout' });
  writeEventLines(eventsPath2, backlog);
  let now2 = 1_000_000;
  let delivery2 = null;
  const r2 = await launchExecutorAdapter({
    startExecution: () => ({ ok: true, recordPath: recPath2 }),
    readStatus: () => EXITED_NOW,
    instruction: 'do work',
    pollDeadlineMs: 30 * 60 * 1000,
    pollDeadlineMaxMs: 4 * 60 * 60 * 1000,
    stallWindowMs: 10 * 60 * 1000,
    pollIntervalMs: 60 * 1000,
    clock: () => now2,
    delay: (ms) => new Promise((res) => { now2 += ms; setImmediate(res); }),
    createDelivery: (opts) => { delivery2 = new EventDelivery(opts); return delivery2; },
  })({ sessionPath: full2.sessionPath });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  await new Promise((res) => setImmediate(res));
  assert.equal(delivery2.cursor(recPath2), 5, 'the never-connected terminal drain delivers the whole backlog');
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

// ---- Issue #263 F4(1): the PRODUCTION runner chain --------------------------
// A real git worktree (the content tracker only counts `git ls-files` content)
// plus a real `package.json` gate, so createActiveTestRunner() can spawn the
// repository's own `test:gate` exactly as bin/soc-control-loop.mjs wires it.
function mkGateWorktree({ pass = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-gate-wt-'));
  const git = (args) => execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }).trim();
  git(['init']);
  git(['-c', 'user.email=gate@test', '-c', 'user.name=gate', 'commit', '--allow-empty', '-m', 'base']);
  fs.writeFileSync(path.join(dir, 'tracked.md'), 'v1\n', 'utf8');
  git(['add', 'tracked.md']);
  git(['-c', 'user.email=gate@test', '-c', 'user.name=gate', 'commit', '-m', 'head']);
  writeGate(dir, { pass });
  return dir;
}

function writeGate(dir, { pass }) {
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'gate-fixture', private: true, scripts: { 'test:gate': 'node --test tests/gate.test.mjs' } }, null, 2)}\n`,
    'utf8');
  fs.writeFileSync(path.join(dir, 'tests', 'gate.test.mjs'), pass
    ? "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
      + "test('gate passes', () => { assert.equal(1, 1); });\n"
    : "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
      + "test('gate fails', () => { assert.equal(1, 2); });\n",
    'utf8');
}

test('F4(1) wiring: the PRODUCTION runner object reaches the verifier and a FAILing gate can never become PASS', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const wt = mkGateWorktree({ pass: false });
  const { sessionPath } = mkVerSession(stateDir, { worktreePath: wt });
  const recPath = mkExecRecord(stateDir, { worktreePath: wt });
  const id = identityHash({ repo: 'duongpdddic-droid/soc_brain', issueNumber: 69 });
  const runsPath = path.join(stateDir, 'executions', `${id}.testruns.jsonl`);
  const readRuns = () => (fs.existsSync(runsPath)
    ? fs.readFileSync(runsPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []);

  // EXACTLY what bin/soc-control-loop.mjs hands the adapter: an OBJECT.
  const runner = createActiveTestRunner();
  assert.equal(typeof runner, 'object', 'the production shape is { runGate, timeoutMs, maxOutputBytes }');
  assert.equal(typeof runner.runGate, 'function');

  const v = deterministicVerifierAdapter({ activeTestRunner: runner });

  // (1) RED on the buggy adapter: the gate FAILS (exit 1) and must surface as a
  //     typed ACTIVE_TEST_GATE_* failure — never be swallowed into PASS.
  const rFail = await v({ sessionPath, executionRecordPath: recPath });
  assert.equal(rFail.ok, false,
    `a FAILing gate must fail VERIFY (this is the swallowed-FAIL bug): ${JSON.stringify(rFail)}`);
  assert.match(String(rFail.code), /^ACTIVE_TEST_GATE_/, String(rFail.code));

  // The gate REALLY ran: a canonical control-plane TestRunRecord exists with a
  // non-zero exit, proving the runner was invoked and not silently skipped.
  const runs = readRuns();
  assert.equal(runs.length, 1, 'the gate spawned exactly once and left one record');
  assert.equal(runs[0].runSource, 'control-plane-active');
  assert.equal(runs[0].result, 'FAIL');
  assert.equal(runs[0].exitCode, 1);
  assert.equal(runs[0].boundary, 'OBSERVED_START');
  assert.equal(runs[0].binding, 'PROVEN');
  assert.ok(fs.existsSync(runs[0].rawLogPath), 'the raw log the record points at exists');

  // (2) GREEN on the same chain: the identical wiring returns PASS when the
  //     gate is green, so the positive path is wired too (not just the negative).
  writeGate(wt, { pass: true });
  const rPass = await v({ sessionPath, executionRecordPath: recPath });
  assert.equal(rPass.ok, true, JSON.stringify(rPass));
  assert.equal(rPass.value.verdict, 'PASS');
  assert.equal(rPass.value.evidence.exitCode, 0);
  assert.equal(readRuns().length, 2, 'one more gate run, one more record');
});

test('F4(1) wiring: an injected runner with no callable shape FAILS CLOSED, never "no gate"', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const { sessionPath } = mkVerSession(stateDir);
  const recPath = mkExecRecord(stateDir);
  const v = deterministicVerifierAdapter({ activeTestRunner: { runGate: 'not-a-function' } });
  const r = await v({ sessionPath, executionRecordPath: recPath });
  assert.equal(r.ok, false, 'a configured-but-unusable gate must not degrade into an absent gate');
  assert.equal(r.code, 'ACTIVE_TEST_GATE_INVALID');
});

test('gemini preReview: no transport fail-closed; strict verdict mapping', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const { sessionPath } = mkSessionFile(stateDir);
  const r1 = await geminiPreReviewAdapter({})({ sessionPath, report: {} });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'NO_GEMINI_TRANSPORT');

  const reviewReadyDir = path.join(stateDir, 'review-ready');
  fs.mkdirSync(reviewReadyDir, { recursive: true });
  fs.writeFileSync(path.join(reviewReadyDir, 'duongpdddic-droid_soc_brain_Issue-69_PR-1_aaaaaaa_review-ready.md'), [
    '## Identity', '- repository: duongpdddic-droid/soc_brain', '- issue: 69',
    `- headSha: ${'a'.repeat(40)}`, '', 'canonical fixture',
  ].join('\n'));

  const text = (verdict) => JSON.stringify({ verdict, findings: ['f'], confidence: 0.5, metadata: {} });
  const r2 = await geminiPreReviewAdapter({ reviewReadyDir, transport: async () => ({ ok: true, text: text('REWORK') }) })({ sessionPath, report: {} });
  assert.equal(r2.ok, true);
  assert.equal(r2.value.verdict, 'REWORK');
  assert.deepEqual(r2.value.findings, ['f']);

  // Strict: verdict outside {PASS, REWORK} fails closed — never lenient-mapped.
  const r3 = await geminiPreReviewAdapter({ reviewReadyDir, transport: async () => ({ ok: true, text: text('ISSUES') }) })({ sessionPath, report: {} });
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
    '# Review Ready - duongpdddic-droid/soc_brain Issue #69 \u00b7 PR #1',
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
    // Full canonical section set (renderReviewReady contract) — required by
    // the structured packet projection (Issue #155 round-6).
    '',
    '## Scope',
    '- 1. note=scope under review',
    '',
    '## Code evidence',
    '- 1. commits=abcdef0 · files=3 · diffStat=+120/-22',
    '',
    '## Finding resolution',
    '- 1. note=first canonical pass — no prior review findings yet',
    '',
    '## Tests',
    '- 1. testExecution=787/787 passed · exitCode=0 · headSha=aaaaaaaa',
    '',
    '## Verification',
    '- 1. legacyEvidenceVerify=PASS · failClosedVerifierCodes=none',
    '',
    '## Safety and mutation analysis',
    '- 1. controlLoopTrace=PRE_REVIEWING->FINAL_REVIEWING (ok)',
    '',
    '## Unverified risks',
    '- 1. semantic review pending',
    '',
    '## Delivery',
    '- 1. pr=1 · prState=OPEN · baseBranch=main',
    '',
    '## Terminal status',
    '- status: **READY_FOR_REVIEW**',
    '',
  ].join('\n'), 'utf8');
  const args = { sessionPath, report: {}, preReview: {} };
  const r1 = await gptFinalReviewAdapter({ reviewReadyDir: rr })(args);
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'NO_GPT_TRANSPORT');

  // Stale-mock repair (baseline debt, directive-approved): the adapter's S4
  // requestDigest gate runs BEFORE the binding gate, so replies must echo the
  // digest from the prompt (same helper pattern as control-loop-gpt-final.test.mjs)
  // or GPT_REQUEST_DIGEST_MISMATCH masks the assertion under test.
  const mkTransport = (verdict, headSha = HEAD) => async ({ prompt } = {}) => {
    const m = /Request digest \(include in metadata\.requestDigest\):\s*([0-9a-f]{64})/i.exec(String(prompt || ''));
    return {
      ok: true,
      text: JSON.stringify({
        verdict, findings: [], evidenceRequests: [], confidence: 0.5,
        metadata: { requestDigest: m ? m[1] : '0'.repeat(64) },
        binding: { repository: 'duongpdddic-droid/soc_brain', issue: 69, headSha },
      }),
    };
  };
  // Malformed reply fails closed.
  const rBad = await gptFinalReviewAdapter({ reviewReadyDir: rr, transport: async () => ({ ok: true, text: 'nope' }), reviewReadyDir: rr })(args);
  assert.equal(rBad.ok, false);
  assert.equal(rBad.code, 'GPT_RESPONSE_MALFORMED');

  // Strict: verdict outside {PASS, REWORK, BLOCKED} fails closed — never lenient-mapped.
  const rInv = await gptFinalReviewAdapter({ reviewReadyDir: rr, transport: mkTransport('MAYBE'), reviewReadyDir: rr })(args);
  assert.equal(rInv.ok, false);
  assert.equal(rInv.code, 'GPT_VERDICT_INVALID');

  // Echoed binding is gated against the canonical packet identity.
  const rStale = await gptFinalReviewAdapter({ reviewReadyDir: rr, transport: mkTransport('PASS', 'f'.repeat(40)), reviewReadyDir: rr })(args);
  assert.equal(rStale.ok, false);
  assert.equal(rStale.code, 'GPT_BINDING_MISMATCH');

  for (const verdict of ['PASS', 'REWORK', 'BLOCKED']) {
    const r = await gptFinalReviewAdapter({ reviewReadyDir: rr, transport: mkTransport(verdict), reviewReadyDir: rr })(args);
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

// ---------- RV2 REWORK: regression tests for the new terminal drain v2 ----------

// R1. terminal poll 1 with 1025 events -> all must be delivered (no silent drop at 32*32 bound)
test('RV2_R1: terminal on first poll with 1025 events -> cursor advanced through all events, delivery evidence complete', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const full = mkFullSession(stateDir);
  const recPath = path.join(stateDir, 'executions', `${full.id}.json`);
  const eventsPath = path.join(stateDir, 'executions', `${full.id}.events.jsonl`);

  const eventCount = 1025;
  const backlog = [];
  for (let i = 1; i <= eventCount; i += 1) backlog.push({ seq: i, t: 1_000_001 + i, stream: 'stdout' });
  writeEventLines(eventsPath, backlog);

  let now = 1_000_000;
  let delivery = null;
  const r = await launchExecutorAdapter({
    startExecution: () => ({ ok: true, recordPath: recPath }),
    readStatus: () => ({ ok: true, execution: { status: 'EXITED', terminalStatus: 'EXITED', reason: null } }),
    instruction: 'do work',
    pollDeadlineMs: 30 * 60 * 1000,
    pollDeadlineMaxMs: 4 * 60 * 60 * 1000,
    stallWindowMs: 10 * 60 * 1000,
    pollIntervalMs: 60 * 1000,
    clock: () => now,
    delay: (ms) => new Promise((res) => { now += ms; setImmediate(res); }),
    createDelivery: (opts) => { delivery = new EventDelivery(opts); return delivery; },
  })({ sessionPath: full.sessionPath });

  assert.equal(r.ok, true, JSON.stringify(r));
  await new Promise((res) => setImmediate(res));

  // cursor reflects all events submitted by the terminal drain
  assert.equal(delivery.cursor(recPath), eventCount, 'cursor matches delivered seq count');
  // adapter value includes delivery evidence
  assert.ok(r.value && typeof r.value.delivery === 'object', 'delivery evidence present in adapter result');
  assert.strictEqual(r.value.delivery.complete, true, 'terminal drain completed within budget');
  if (r.value.delivery) {
    assert.strictEqual(r.value.delivery.submittedThroughSeq, eventCount);
    assert.strictEqual(r.value.delivery.batchesSubmitted, Math.ceil(eventCount / 32));
  }
});

// R2. terminal burst after RUNNING exceeds total drain limit (32 chunks) -> all still delivered
test('RV2_R2: terminal after a large burst (>1024 events) -> full delivery, no silent loss', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const full = mkFullSession(stateDir);
  const recPath = path.join(stateDir, 'executions', `${full.id}.json`);
  const eventsPath = path.join(stateDir, 'executions', `${full.id}.events.jsonl`);

  // Write the initial 10 events (seq 1-10) for runningEvents = 10
  const runningEvents = 10;
  const running = [];
  for (let i = 1; i <= runningEvents; i += 1) running.push({ seq: i, t: 1_000_001 + i, stream: 'stdout' });
  writeEventLines(eventsPath, running);

  let now = 1_000_000;
  let delivery = null;
  let pollCount = 0;
  const r = await launchExecutorAdapter({
    startExecution: () => ({ ok: true, recordPath: recPath }),
    readStatus: () => {
      pollCount += 1;
      if (pollCount === 1) {
        // First poll: shows RUNNING with seq 1-10 events
        return { ok: true, execution: { status: 'RUNNING', terminalStatus: null, reason: null }, activity: { ok: true, items: running, totalLines: runningEvents, truncated: false } };
      }
      if (pollCount === 2) {
        // Second poll: terminal writes burst starting at seq 11 (to total 1035 events)
        const burstStartSeq = 11;
        const burstEndSeq = 1035; // 10 from running + 1025 from burst = 1035 total (>1024)
        const burst = [];
        for (let i = burstStartSeq; i <= burstEndSeq; i += 1) burst.push({ seq: i, t: 1_000_001 + i, stream: 'stdout' });
        writeEventLines(eventsPath, burst, { append: true });
        // Return EXITED after writing the burst
        return { ok: true, execution: { status: 'EXITED', terminalStatus: 'EXITED', reason: null } };
      }
      // Should not reach here
      return { ok: true, execution: { status: 'EXITED', terminalStatus: 'EXITED', reason: null } };
    },
    instruction: 'do work',
    pollDeadlineMs: 30 * 60 * 1000,
    pollDeadlineMaxMs: 4 * 60 * 60 * 1000,
    stallWindowMs: 10 * 60 * 1000,
    pollIntervalMs: 60 * 1000,
    clock: () => now,
    delay: (ms) => new Promise((res) => { now += ms; setImmediate(res); }),
    createDelivery: (opts) => { delivery = new EventDelivery(opts); return delivery; },
  })({ sessionPath: full.sessionPath });

  assert.equal(r.ok, true, JSON.stringify(r));
  await new Promise((res) => setImmediate(res));

  // cursor should be 1035 (10 from running + 1025 from burst)
  assert.equal(delivery.cursor(recPath), 1035, `cursor reflects full delivery of 1035 events (>1024)`);
  assert.ok(r.value && typeof r.value.delivery === 'object', 'delivery evidence present');
  assert.strictEqual(r.value.delivery.complete, true, 'terminal drain completed within budget');
});

// R3. refusal/backpressure at terminal never silently drops remainder (retry until deadline, evidence on incomplete)
test('RV2_R3: terminal at first poll with a permanently refusing delivery channel -> drain stops, evidence reports incomplete (no silent loss)', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const full = mkFullSession(stateDir);
  const recPath = path.join(stateDir, 'executions', `${full.id}.json`);
  const eventsPath = path.join(stateDir, 'executions', `${full.id}.events.jsonl`);

  const backlog = [];
  for (let i = 1; i <= 100; i += 1) backlog.push({ seq: i, t: 1_000_001 + i, stream: 'stdout' });
  writeEventLines(eventsPath, backlog);

  // Fake delivery that rejects every submit (simulate permanent backpressure)
  const fakeDelivery = {
    maxEvents: 32,
    state: DELIVERY_STATE.READY,
    connect() {}, ready() {},
    disconnected() { this.state = DELIVERY_STATE.DISCONNECTED; },
    acknowledge: () => ({ ok: true }),
    submit({ events }) {
      // Reject every submit – simulate permanent backpressure
      return Promise.reject(new Error('QUEUE_FULL'));
    },
    wasRefused: () => true,
  };

  let now = 1_000_000;
  const r = await launchExecutorAdapter({
    startExecution: () => ({ ok: true, recordPath: recPath }),
    readStatus: () => ({ ok: true, execution: { status: 'EXITED', terminalStatus: 'EXITED', reason: null } }),
    instruction: 'do work',
    pollDeadlineMs: 30 * 60 * 1000,
    pollDeadlineMaxMs: 4 * 60 * 60 * 1000,
    stallWindowMs: 10 * 60 * 1000,
    pollIntervalMs: 60 * 1000,
    clock: () => now,
    delay: (ms) => new Promise((res) => { now += ms; setImmediate(res); }),
    createDelivery: () => fakeDelivery,
  })({ sessionPath: full.sessionPath });

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.value && typeof r.value.delivery === 'object', 'delivery evidence present even on incomplete drain');
  assert.strictEqual(r.value.delivery.complete, false, 'drain did not complete because channel refused');
  assert.strictEqual(r.value.delivery.submittedThroughSeq, 0, 'no events submitted due to permanent refusal');
});
