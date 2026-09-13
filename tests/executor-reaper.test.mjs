// tests/executor-reaper.test.mjs — Issue #157: canonical dead+unfinalized
// ExecutionRecord reaper / interrupted-finalization primitive. node:test, no
// framework. Liveness + start-time probes are ALWAYS injected (never a real
// process probe); the shared death-proof identity logic itself is the #160
// reconcileExecutorLiveness primitive (tested in executor-reconcile.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { identityHash } from '../packages/workspace/workspace.mjs';
import {
  EXECUTION_SCHEMA_VERSION, effectiveStatus, readExecutionRecord, startExecution,
  writeRecordAtomic, casReplaceIfCurrent,
} from '../packages/executor-launcher/executor-launcher.mjs';
import { reapInterruptedExecution, REAP_REASON } from '../packages/executor-launcher/executor-reaper.mjs';
import { deterministicVerifierAdapter } from '../packages/control-loop/adapters.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-reaper-'));
const IDH = identityHash({ repo: 'o/r', issueNumber: 1 });
const WT = path.join(TMP, 'wt');
fs.mkdirSync(WT, { recursive: true });

const okVerify = () => ({ ok: true });
const denyVerify = () => ({ ok: false, reason: 'STALE_TASK_LEASE' });
const DEAD = { isAlive: () => false };
const LIVE_SAME = { isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: 1000 }) };
const LIVE_FOREIGN = { isAlive: () => true, readStartTime: () => ({ pid: 4242, processStartTime: 5555 }) };
const LIVE_NO_PROBE = { isAlive: () => true, readStartTime: () => null };

function fixture(over = {}) {
  const S = fs.mkdtempSync(path.join(TMP, 'st-'));
  const sessPath = path.join(S, 'sessions', `${IDH}.json`);
  fs.mkdirSync(path.dirname(sessPath), { recursive: true });
  const session = {
    schemaVersion: '1', state: 'SESSION_ACTIVE', lifecycle: [],
    taskId: 'o/r#1', repo: 'o/r', issueNumber: 1,
    baseSha: 'a'.repeat(40), branch: 'soc/task-h', worktreePath: WT,
    identityHash: IDH, lease: { token: 'tok-123' },
    controlPlane: { stateDir: S },
  };
  fs.writeFileSync(sessPath, JSON.stringify(session, null, 2), 'utf8');
  const recDir = path.join(S, 'executions');
  fs.mkdirSync(recDir, { recursive: true });
  const record = {
    schemaVersion: EXECUTION_SCHEMA_VERSION, kind: 'ExecutionRecord',
    identityHash: IDH, taskId: 'o/r#1', repo: 'o/r', issueNumber: 1,
    baseSha: 'a'.repeat(40), branch: 'soc/task-h', worktreePath: WT,
    executor: 'opencode', pid: 4242, processStartTime: 1000,
    startedAt: 1, finishedAt: null, exitCode: null, signal: null,
    terminalStatus: null, reason: null, sessionId: null,
    pendingExecutorBind: false,
    ...over,
  };
  fs.writeFileSync(path.join(recDir, `${IDH}.json`), JSON.stringify(record, null, 2), 'utf8');
  return { S, sessPath };
}
const reap = ({ S, sessPath }, deps = {}) => reapInterruptedExecution({
  sessionPath: sessPath, leaseToken: 'tok-123', verifyAuthority: okVerify, ...deps,
});
const onDisk = (S) => readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 1 });

test('A3: dead + unfinalized => INTERRUPTED/finalized, atomic with read-back', () => {
  const f = fixture();
  const r = reap(f, DEAD);
  assert.equal(r.ok, true); assert.equal(r.action, 'REAPED'); assert.equal(r.status, 'INTERRUPTED');
  assert.equal(r.proof, 'PID_GONE'); assert.equal(r.pid, 4242); assert.equal(r.processStartTime, 1000);
  const rec = onDisk(f.S).record;
  assert.equal(rec.terminalStatus, 'INTERRUPTED');
  assert.equal(rec.finalized, true);
  assert.equal(rec.reason, REAP_REASON);
  assert.ok(Number.isInteger(rec.reapedAt) && rec.reapedAt >= 0);
  assert.ok(rec.finishedAt !== null);
  assert.equal(rec.pid, 4242); assert.equal(rec.processStartTime, 1000); // identity evidence kept
  assert.equal(effectiveStatus(rec, () => false), 'INTERRUPTED');
});

test('A4: idempotent replay => NO-OP with truthful report, record untouched', () => {
  const f = fixture();
  reap(f, DEAD);
  const first = onDisk(f.S).record;
  const r2 = reap(f, DEAD);
  assert.equal(r2.ok, true); assert.equal(r2.action, 'NOOP_ALREADY_TERMINAL'); assert.equal(r2.status, 'INTERRUPTED');
  const again = onDisk(f.S).record;
  assert.deepEqual(again, first);
});

test('A4b: real terminal status is never overwritten by the reaper', () => {
  const f = fixture({ terminalStatus: 'EXITED', finalized: true, exitCode: 0 });
  const r = reap(f, DEAD);
  assert.equal(r.ok, true); assert.equal(r.action, 'NOOP_ALREADY_TERMINAL'); assert.equal(r.status, 'EXITED');
  assert.equal(onDisk(f.S).record.terminalStatus, 'EXITED');
});

test('A4c: dead + finalized (LOST projection) => NO-OP, already terminal', () => {
  const f = fixture({ finalized: true });
  const r = reap(f, DEAD);
  assert.equal(r.ok, true); assert.equal(r.action, 'NOOP_ALREADY_TERMINAL'); assert.equal(r.status, 'INTERRUPTED');
  assert.notEqual(onDisk(f.S).record.reason, REAP_REASON);
});

test('A5: LIVE identity-proven process can never be reaped (fail closed)', () => {
  const f = fixture();
  const r = reap(f, LIVE_SAME);
  assert.equal(r.ok, false); assert.equal(r.reason, 'EXECUTION_LIVE');
  const rec = onDisk(f.S).record;
  assert.equal(rec.terminalStatus, null); assert.equal(rec.finalized, undefined);
});

test('A6: PID reuse => recorded incarnation proven dead (start-time mismatch); foreign pid untouched', () => {
  const f = fixture();
  const r = reap(f, LIVE_FOREIGN);
  assert.equal(r.ok, true); assert.equal(r.action, 'REAPED'); assert.equal(r.proof, 'START_TIME_MISMATCH');
  const rec = onDisk(f.S).record;
  assert.equal(rec.terminalStatus, 'INTERRUPTED'); assert.equal(rec.finalized, true);
  assert.equal(rec.pid, 4242); assert.equal(rec.processStartTime, 1000);
});

test('A6b: live pid whose start time cannot be probed => unproven, refuse (no inference)', () => {
  const f = fixture();
  const r = reap(f, LIVE_NO_PROBE);
  assert.equal(r.ok, false); assert.equal(r.reason, 'EXECUTOR_IDENTITY_UNPROVEN'); assert.equal(r.detail, 'START_TIME_PROBE_UNAVAILABLE');
  assert.equal(onDisk(f.S).record.terminalStatus, null);
});

test('A6c: legacy record without processStartTime — live pid always refuses, dead pid reaps', () => {
  const live = fixture({ processStartTime: null });
  const r1 = reap(live, { isAlive: () => true });
  assert.equal(r1.ok, false); assert.equal(r1.reason, 'EXECUTOR_IDENTITY_UNPROVEN'); assert.equal(r1.detail, 'NO_RECORDED_START_TIME');
  assert.equal(onDisk(live.S).record.terminalStatus, null);
  const dead = fixture({ processStartTime: null });
  const r2 = reap(dead, { isAlive: () => false });
  assert.equal(r2.ok, true); assert.equal(r2.action, 'REAPED');
});

test('A2/A4d: no pid (STARTING) is not a proven-dead identity => refuse', () => {
  const f = fixture({ pid: null, processStartTime: null });
  const r = reap(f, DEAD);
  assert.equal(r.ok, false); assert.equal(r.reason, 'EXECUTOR_IDENTITY_UNPROVEN'); assert.equal(r.detail, 'NO_PID');
  assert.equal(onDisk(f.S).record.terminalStatus, null);
});

test('A1: owner/session binding — authority denial, missing lease, identity mismatch all reject', () => {
  const denied = reapInterruptedExecution({ sessionPath: fixture().sessPath, leaseToken: 'x', verifyAuthority: denyVerify });
  assert.equal(denied.ok, false); assert.equal(denied.reason, 'STALE_TASK_LEASE');
  const noLease = reapInterruptedExecution({ sessionPath: fixture().sessPath, leaseToken: '', verifyAuthority: okVerify });
  assert.equal(noLease.ok, false); assert.equal(noLease.reason, 'SESSION_AUTHORITY_REJECTED');
  const missing = reapInterruptedExecution({ sessionPath: path.join(TMP, 'nope.json'), leaseToken: 'x', verifyAuthority: okVerify });
  assert.equal(missing.ok, false); assert.equal(missing.reason, 'SESSION_NOT_FOUND');
  const foreign = fixture({ taskId: 'o/r#999' });
  const r = reap(foreign, DEAD);
  assert.equal(r.ok, false); assert.equal(r.reason, 'EXECUTION_RECORD_IDENTITY_MISMATCH');
  assert.deepEqual(r.fields, ['taskId']);
  assert.equal(onDisk(foreign.S).record.terminalStatus, null);
  const absentSess = fixture();
  const absent = reapInterruptedExecution({
    sessionPath: absentSess.sessPath, leaseToken: 'tok-123', stateDir: path.join(TMP, 'empty-' + Math.random()),
    verifyAuthority: okVerify, isAlive: () => false,
  });
  assert.equal(absent.ok, false); assert.equal(absent.reason, 'EXECUTION_NOT_FOUND');
});

test('#160 boundary: bind/cleanup latch stays owned by the relaunch prove path', () => {
  const f = fixture({ pendingExecutorBind: true });
  const r = reap(f, DEAD);
  assert.equal(r.ok, false); assert.equal(r.reason, 'EXECUTION_CLEANUP_REQUIRED');
  assert.equal(onDisk(f.S).record.terminalStatus, null);
});

test('A7: the reaper never touches the canonical session record (no FSM mutation)', () => {
  const f = fixture();
  const before = fs.readFileSync(f.sessPath, 'utf8');
  reap(f, DEAD);
  assert.equal(fs.readFileSync(f.sessPath, 'utf8'), before);
});

// ---- rework: stale-write TOCTOU guard (conditional source-generation publish) --
test('R1: writer persists N between reaper source-read and commit => reaper refuses, N intact', () => {
  const f = fixture();
  const r = reapInterruptedExecution({
    sessionPath: f.sessPath, leaseToken: 'tok-123', verifyAuthority: okVerify, isAlive: () => false,
    beforePublish: ({ recordPath, sourceRaw }) => {
      // The source snapshot the reaper inspected IS the stale S at this barrier.
      assert.equal(fs.readFileSync(recordPath, 'utf8'), sourceRaw);
      // A different canonical writer finalizes the record first (e.g. the
      // executor exit handler lands EXITED after the reaper read S).
      const s = JSON.parse(sourceRaw);
      writeRecordAtomic(recordPath, { ...s, terminalStatus: 'EXITED', finalized: true, exitCode: 0, finishedAt: 1234, reason: 'LATE_EXIT_HANDLER_FINALIZE' });
    },
  });
  assert.equal(r.ok, false); assert.equal(r.reason, 'REAP_SOURCE_STALE'); assert.equal(r.committed, false);
  const rec = onDisk(f.S).record;
  assert.equal(rec.terminalStatus, 'EXITED'); assert.equal(rec.finalized, true);
  assert.equal(rec.reason, 'LATE_EXIT_HANDLER_FINALIZE'); // N stands untouched
  assert.equal(rec.reapedAt, undefined); // reaper wrote ZERO bytes
});

test('R2: concurrent double-reap — A commits, B (stale source) must not overwrite A', () => {
  const f = fixture();
  let aRes = null;
  const bRes = reapInterruptedExecution({
    sessionPath: f.sessPath, leaseToken: 'tok-123', verifyAuthority: okVerify, isAlive: () => false, clock: () => 2222,
    beforePublish: ({ recordPath, sourceRaw }) => {
      // B observed S; A observes the SAME S and completes its full reap first.
      aRes = reapInterruptedExecution({
        sessionPath: f.sessPath, leaseToken: 'tok-123', verifyAuthority: okVerify, isAlive: () => false, clock: () => 1111,
      });
      assert.equal(aRes.ok, true); assert.equal(aRes.action, 'REAPED');
      assert.notEqual(fs.readFileSync(recordPath, 'utf8'), sourceRaw); // B's source is now stale
    },
  });
  assert.equal(bRes.ok, false); assert.equal(bRes.reason, 'REAP_SOURCE_STALE'); assert.equal(bRes.committed, false);
  const rec = onDisk(f.S).record;
  assert.equal(rec.terminalStatus, 'INTERRUPTED');
  assert.equal(rec.reapedAt, 1111); // A's committed metadata survives; B never wrote 2222
  assert.equal(rec.reason, REAP_REASON);
  // replay after the dust settles is the idempotent NO-OP
  const replay = reap(f, DEAD);
  assert.equal(replay.ok, true); assert.equal(replay.action, 'NOOP_ALREADY_TERMINAL');
  assert.equal(onDisk(f.S).record.reapedAt, 1111);
});

// ---- rework r3: generation-bound CAS closes the compare/rename window ---------
// R3a: independent writer publishes N AFTER the reaper's final source
// validation and BEFORE the replacement attempt: the CAS consume arbitration
// moves N into quarantine, the consumed bytes fail the snapshot test, and the
// commit-restores N create-only. N's bytes are never written or removed by
// the reaper (same file object, byte-for-byte canonical again).
test('R3a: N lands between validation and replacement attempt => consume-restore CAS, N byte-intact', () => {
  const f = fixture();
  const recPath = path.join(f.S, 'executions', `${IDH}.json`);
  let nBytes = null;
  const r = reapInterruptedExecution({
    sessionPath: f.sessPath, leaseToken: 'tok-123', verifyAuthority: okVerify, isAlive: () => false,
    beforePublish: ({ recordPath, sourceRaw }) => {
      const s = JSON.parse(sourceRaw);
      writeRecordAtomic(recordPath, { ...s, terminalStatus: 'EXITED', finalized: true, exitCode: 0, reason: 'INDEPENDENT_WRITER_PUBLISH' });
      nBytes = fs.readFileSync(recordPath, 'utf8');
    },
  });
  assert.equal(r.ok, false); assert.equal(r.reason, 'REAP_SOURCE_STALE');
  assert.equal(r.detail, 'SOURCE_CHANGED'); assert.equal(r.committed, false); assert.equal(r.restored, true);
  assert.equal(fs.readFileSync(recPath, 'utf8'), nBytes); // byte-for-byte the writer's N
  const residue = fs.readdirSync(path.dirname(recPath)).filter((x) => x.includes('.cas-'));
  assert.deepEqual(residue, []); // quarantine + staging fully closed
});

// R3b: the TRUE primitive window - replacement lands AFTER the atomic consume
// (canonical slot momentarily empty). The commit is a create-only hard link,
// so it loses to N without touching it, and the source generation survives
// byte-exact in quarantine (never destroyed).
test('R3b: N wins the slot immediately after the reaper consumed S => link-commit refuses, N byte-intact', () => {
  const f = fixture();
  const recPath = path.join(f.S, 'executions', `${IDH}.json`);
  const sRaw = fs.readFileSync(recPath, 'utf8');
  const sRec = JSON.parse(sRaw);
  let nBytes = null; let slotEmpty = false;
  const r = reapInterruptedExecution({
    sessionPath: f.sessPath, leaseToken: 'tok-123', verifyAuthority: okVerify, isAlive: () => false,
    afterConsume: ({ canonicalPath }) => {
      slotEmpty = !fs.existsSync(canonicalPath); // arbitration already consumed S
      writeRecordAtomic(canonicalPath, { ...sRec, terminalStatus: 'EXITED', finalized: true, exitCode: 0, reason: 'WRITER_WON_SLOT' });
      nBytes = fs.readFileSync(canonicalPath, 'utf8');
    },
  });
  assert.equal(slotEmpty, true);
  assert.equal(r.ok, false); assert.equal(r.reason, 'REAP_SOURCE_STALE');
  assert.equal(r.detail, 'COMMIT_RACE_LOST'); assert.equal(r.committed, false); assert.equal(r.restored, false);
  assert.equal(fs.readFileSync(recPath, 'utf8'), nBytes); // N untouched by the reaper
  const consumed = fs.readdirSync(path.dirname(recPath)).filter((x) => x.endsWith('.consumed.tmp'));
  assert.equal(consumed.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(recPath), consumed[0]), 'utf8'), sRaw); // S bytes preserved
  const staging = fs.readdirSync(path.dirname(recPath)).filter((x) => x.endsWith('.staging.tmp'));
  assert.deepEqual(staging, []);
});

// R4: inverse winner - the reaper commits the generation transition; a stale
// observer (independent writer holding the retired S bytes) then attempts its
// replacement and CANNOT corrupt the committed generation (consume-restore,
// byte-for-byte); the committed state reads back truthfully.
test('R4: reaper wins generation; stale observer cannot corrupt committed generation', () => {
  const f = fixture();
  const recPath = path.join(f.S, 'executions', `${IDH}.json`);
  const sRaw = fs.readFileSync(recPath, 'utf8'); // stale observer's snapshot
  const a = reapInterruptedExecution({
    sessionPath: f.sessPath, leaseToken: 'tok-123', verifyAuthority: okVerify, isAlive: () => false, clock: () => 1111,
  });
  assert.equal(a.ok, true); assert.equal(a.action, 'REAPED');
  const committedRaw = fs.readFileSync(recPath, 'utf8');
  const committed = onDisk(f.S).record;
  assert.equal(committed.terminalStatus, 'INTERRUPTED'); assert.equal(committed.reapedAt, 1111); // truthful read-back
  // Stale independent writer (holds S bytes) attempts its own replacement:
  const w = casReplaceIfCurrent(recPath, sRaw, { ...committed, terminalStatus: 'STOPPED', reason: 'STALE_FORGERY', reapedAt: 9999 });
  assert.equal(w.ok, false); assert.equal(w.reason, 'SOURCE_CHANGED'); assert.equal(w.committed, false); assert.equal(w.restored, true);
  assert.equal(fs.readFileSync(recPath, 'utf8'), committedRaw); // A's generation byte-intact
  // A stale full-API reaper sees the terminal generation and NO-OPs:
  const b = reapInterruptedExecution({
    sessionPath: f.sessPath, leaseToken: 'tok-123', verifyAuthority: okVerify, isAlive: () => false, clock: () => 2222,
  });
  assert.equal(b.ok, true); assert.equal(b.action, 'NOOP_ALREADY_TERMINAL');
  assert.equal(onDisk(f.S).record.reapedAt, 1111);
  const residue = fs.readdirSync(path.dirname(recPath)).filter((x) => x.includes('.cas-'));
  assert.deepEqual(residue, []);
});

// ---- A9: exact Issue #107 round-6 deadlock regression -------------------------
// Rework executor completed its commit, the lane process was killed at the
// poll deadline: record dead-pid + unfinalized. Deadlock: verifier cannot
// proceed AND re-dispatch is refused EXECUTION_ALREADY_RUNNING. Recovery:
// canonical reap -> dispatch -> verify PASS.
function fakeChild(pid) {
  const c = new EventEmitter();
  c.pid = pid; c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.kill = () => true;
  return c;
}
test('A9: #107 deadlock — dispatch refused on dead+unfinalized; reap -> dispatch -> verify PASS', async () => {
  const S = fs.mkdtempSync(path.join(TMP, 'l-'));
  const sessPath = path.join(S, 'sessions', `${IDH}.json`);
  fs.mkdirSync(path.dirname(sessPath), { recursive: true });
  fs.writeFileSync(sessPath, JSON.stringify({
    schemaVersion: '1', state: 'SESSION_ACTIVE', lifecycle: [],
    taskId: 'o/r#1', repo: 'o/r', issueNumber: 1,
    baseSha: 'a'.repeat(40), branch: 'soc/task-h', worktreePath: WT,
    identityHash: IDH, lease: { token: 'tok-123' },
    controlPlane: { stateDir: S },
  }, null, 2), 'utf8');
  const binding = { identityHash: IDH, taskId: 'o/r#1', repo: 'o/r', issueNumber: 1, baseSha: 'a'.repeat(40), branch: 'soc/task-h', path: WT };
  const launch = (over = {}) => startExecution({
    session: { leaseToken: 'tok-123' }, sessionPath: sessPath, binding, instruction: 'rework',
    stateDir: S, env: {}, spawn: over.spawn ?? (() => fakeChild(4343)),
    isAlive: over.isAlive ?? (() => true),
    resolveExecutable: ({ env }) => ({ ok: true, executable: 'opencode.exe', source: 'test', candidates: [] }),
    verifyAuthority: okVerify,
    preflight: () => ({ ok: true, version: '0.0.0-test', agent: 'build', toolCaps: {} }),
    ...over.extra,
  });
  const recPath = path.join(S, 'executions', `${IDH}.json`);
  const verifier = deterministicVerifierAdapter();

  const l1 = launch();
  assert.equal(l1.ok, true); // executor running; lane then killed externally at the deadline

  // Deadlock: verifier blocked, re-dispatch refused.
  const v0 = await verifier({ sessionPath: sessPath, executionRecordPath: recPath });
  assert.equal(v0.ok, false); assert.equal(v0.code, 'EXECUTION_NOT_TERMINAL');
  const refused = launch({ isAlive: () => false });
  assert.equal(refused.ok, false); assert.equal(refused.reason, 'EXECUTION_ALREADY_RUNNING');

  // Canonical reap: dead + unfinalized -> INTERRUPTED + finalized.
  const r = reapInterruptedExecution({ sessionPath: sessPath, leaseToken: 'tok-123', verifyAuthority: okVerify, isAlive: () => false });
  assert.equal(r.ok, true); assert.equal(r.action, 'REAPED');

  // Verifier can proceed on the reaped record (deterministic interrupted
  // verdict — no more EXECUTION_NOT_TERMINAL block) and re-dispatch is allowed.
  const v1 = await verifier({ sessionPath: sessPath, executionRecordPath: recPath });
  assert.equal(v1.ok, false); assert.equal(v1.code, 'EXECUTOR_INTERRUPTED');
  const l2 = launch({
    spawn: () => { const c = fakeChild(4344); queueMicrotask(() => c.emit('exit', 0, null)); return c; },
  });
  assert.equal(l2.ok, true);
  await new Promise((res) => setImmediate(res));

  const v2 = await verifier({ sessionPath: sessPath, executionRecordPath: recPath });
  assert.equal(v2.ok, true); assert.equal(v2.value.verdict, 'PASS');
});
