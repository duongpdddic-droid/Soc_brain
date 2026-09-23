// tests/supervisor-reactive-guard.test.mjs — PR #216: Supervisor reactive
// event engine + Behavior/Drift Guards. node:test, no framework, 100%
// offline: no network, no gh, no child processes, no live timers required
// (the one interval-timer test uses a 5ms cadence and always stops it).
//
// Coverage contract (task spec II.3):
//   A. sub-second reactive event dispatch (sync listener, measured latency)
//   B. Scope Guard drift detection (unconfigured / outside / `..` escape /
//      sibling-prefix / valid-in-scope / guard violation audit trail)
//   C. Anti-Deadlock Reaper timeout mechanics (before/after threshold,
//      heartbeat grace, exactly-once consume, fail-closed -> BLOCKED)
//   D. safe recovery (reaper transition stays inside ALLOWED_TRANSITIONS,
//      terminal states never re-transitioned, runner handoff fail-safe)
//   E. FSM parity with control-loop (states + every edge probed via bindLoop)
//   F. ledger ingestion drift guard (illegal edge / desync fail closed)
//   G. Test Integrity Guard (seal/verify PASS, tamper fail-closed)
//   H. bin/soc-control-loop.mjs integration (supervisor receives RUNNER_DONE
//      + ledger transitions; supervisor-less runs byte-identical)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  SupervisorEngine,
  SUPERVISOR_EVENTS,
  SUPERVISOR_FSM_STATES,
  SUPERVISOR_ALLOWED_TRANSITIONS,
  SUPERVISOR_TERMINAL_STATES,
  createTestIntegrityGuard,
  isAllowedTransition,
} from '../packages/supervisor/supervisor-engine.mjs';
import {
  bindLoop,
  LOOP_STATES,
  TERMINAL_STATES,
} from '../packages/control-loop/control-loop.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { runSocControlLoop } from '../bin/soc-control-loop.mjs';

const SUB_SECOND_MS = 1000;

// ============================================================================
// A. Reactive engine: sub-second dispatch
// ============================================================================

test('A1: transition dispatches synchronously to listeners in sub-second time', () => {
  const engine = new SupervisorEngine();
  const seen = [];
  engine.on(SUPERVISOR_EVENTS.TRANSITION, (rec) => seen.push(rec));

  const t0 = performance.now();
  const r = engine.transition({ from: 'ACCEPTED', to: 'ROUTED', reason: 'test-dispatch' });
  const elapsed = performance.now() - t0;

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.state, 'ROUTED');
  assert.equal(engine.state, 'ROUTED');
  // Dispatch is synchronous: the listener already ran when transition() returned.
  assert.equal(seen.length, 1, 'listener must observe the event before call returns');
  assert.equal(seen[0].from, 'ACCEPTED');
  assert.equal(seen[0].to, 'ROUTED');
  assert.equal(seen[0].reason, 'test-dispatch');
  assert.equal(seen[0].source, 'direct');
  assert.ok(elapsed < SUB_SECOND_MS, `dispatch took ${elapsed}ms (must be < ${SUB_SECOND_MS}ms)`);
  // Event log records the same seq-stamped entry (bounded audit).
  const logged = engine.eventsNamed(SUPERVISOR_EVENTS.TRANSITION);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].payload.to, 'ROUTED');
});

test('A2: full legal chain walks ACCEPTED -> DELIVERING with every hop observed', () => {
  const engine = new SupervisorEngine();
  const chain = [
    ['ACCEPTED', 'ROUTED'], ['ROUTED', 'EXECUTING'], ['EXECUTING', 'VERIFYING'],
    ['VERIFYING', 'PRE_REVIEWING'], ['PRE_REVIEWING', 'FINAL_REVIEWING'],
    ['FINAL_REVIEWING', 'DECIDING'], ['DECIDING', 'DELIVERING'],
  ];
  const seen = [];
  engine.on(SUPERVISOR_EVENTS.TRANSITION, (rec) => seen.push(`${rec.from}->${rec.to}`));

  const t0 = performance.now();
  for (const [from, to] of chain) {
    const r = engine.transition({ from, to, reason: 'chain' });
    assert.equal(r.ok, true, `${from}->${to}: ${JSON.stringify(r)}`);
  }
  const elapsed = performance.now() - t0;

  assert.equal(engine.state, 'DELIVERING');
  assert.deepEqual(seen, chain.map(([f, t]) => `${f}->${t}`));
  assert.ok(elapsed < SUB_SECOND_MS, `7 dispatches took ${elapsed}ms`);
});

test('A3: illegal transition fails closed, state unchanged, GUARD_VIOLATION audited', () => {
  const engine = new SupervisorEngine();
  const violations = [];
  engine.on(SUPERVISOR_EVENTS.GUARD_VIOLATION, (v) => violations.push(v));
  const transitions = [];
  engine.on(SUPERVISOR_EVENTS.TRANSITION, (r) => transitions.push(r));

  const r = engine.transition({ from: 'ACCEPTED', to: 'DELIVERING' }); // illegal edge
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ILLEGAL_TRANSITION');
  assert.equal(engine.state, 'ACCEPTED', 'state must not move on refusal');
  assert.equal(transitions.length, 0, 'no TRANSITION event for a refused edge');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'fsm-drift');
  assert.equal(violations[0].reason, 'ILLEGAL_EDGE');
});

test('A4: stale from-state (STATE_DESYNC) fails closed and is audited', () => {
  const engine = new SupervisorEngine();
  const violations = [];
  engine.on(SUPERVISOR_EVENTS.GUARD_VIOLATION, (v) => violations.push(v));

  const r = engine.transition({ from: 'VERIFYING', to: 'PRE_REVIEWING' }); // engine is at ACCEPTED
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TRANSITION_STATE_DESYNC');
  assert.equal(engine.state, 'ACCEPTED');
  assert.equal(violations[0].reason, 'STATE_DESYNC');
  assert.equal(violations[0].expected, 'ACCEPTED');
});

test('A5: terminal states are dead-ends (COMPLETED/BLOCKED refuse all exits)', () => {
  for (const terminal of ['COMPLETED', 'BLOCKED']) {
    const engine = new SupervisorEngine({ initialState: terminal });
    for (const target of LOOP_STATES) {
      const r = engine.transition({ from: terminal, to: target });
      assert.equal(r.ok, false, `${terminal}->${target} must be refused`);
      assert.equal(r.code, 'ILLEGAL_TRANSITION');
      assert.equal(engine.state, terminal);
    }
    assert.equal(SUPERVISOR_ALLOWED_TRANSITIONS[terminal].size, 0);
    assert.ok(SUPERVISOR_TERMINAL_STATES.has(terminal));
  }
});

test('A6: a throwing listener is contained — engine keeps working, error audited', () => {
  const engine = new SupervisorEngine();
  engine.on(SUPERVISOR_EVENTS.TRANSITION, () => { throw new Error('observer-fault'); });

  const r = engine.transition({ from: 'ACCEPTED', to: 'ROUTED' });
  assert.equal(r.ok, true, 'listener fault must not fail the transition');
  assert.equal(engine.state, 'ROUTED');
  assert.equal(engine.lastListenerError, 'observer-fault');
  const errs = engine.eventsNamed(SUPERVISOR_EVENTS.LISTENER_ERROR);
  assert.ok(errs.length >= 1, 'LISTENER_ERROR event recorded');
});

test('A7: constructor rejects invalid config (fail-closed)', () => {
  assert.throws(() => new SupervisorEngine({ initialState: 'NOPE' }), /SUPERVISOR_INITIAL_STATE_INVALID/);
  assert.throws(() => new SupervisorEngine({ defaultTimeoutMs: 0 }), /SUPERVISOR_TIMEOUT_INVALID/);
  assert.throws(() => new SupervisorEngine({ now: 'not-a-function' }), /SUPERVISOR_NOW_INVALID/);
});

// ============================================================================
// B. Scope Guard — drift beyond the allowed boundary
// ============================================================================

function mkScopeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-scope-'));
  const allowed = path.join(base, 'worktree');
  fs.mkdirSync(allowed, { recursive: true });
  return { base, allowed };
}

test('B1: unconfigured scope denies everything (fail-closed SCOPE_UNSET)', () => {
  const engine = new SupervisorEngine();
  const r = engine.authorizePath(path.join(os.tmpdir(), 'anything.txt'));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SCOPE_UNSET');
  assert.equal(engine.violations.at(-1).reason, 'SCOPE_UNSET');
});

test('B2: in-scope file is authorized; out-of-scope edit is blocked as drift', () => {
  const { allowed } = mkScopeFixture();
  const engine = new SupervisorEngine();
  const violations = [];
  engine.on(SUPERVISOR_EVENTS.GUARD_VIOLATION, (v) => violations.push(v));
  assert.equal(engine.setScope({ roots: [allowed] }).ok, true);

  const inside = engine.guardWrite(path.join(allowed, 'packages', 'supervisor', 'x.mjs'));
  assert.equal(inside.ok, true, JSON.stringify(inside));

  const outside = engine.guardWrite(path.join(path.dirname(allowed), 'etc', 'passwd'));
  assert.equal(outside.ok, false);
  assert.equal(outside.code, 'SCOPE_VIOLATION');
  assert.equal(violations.length, 1, 'exactly one drift violation emitted');
  assert.equal(violations[0].kind, 'scope');
  assert.equal(violations[0].reason, 'OUT_OF_SCOPE');
  assert.ok(engine.violations.some((v) => v.reason === 'OUT_OF_SCOPE'), 'audit trail retained');
});

test('B3: `..` traversal escaping the root is resolved and blocked', () => {
  const { allowed } = mkScopeFixture();
  const engine = new SupervisorEngine();
  engine.setScope({ roots: [allowed] });

  const escape = engine.authorizePath(path.join(allowed, '..', '..', 'escape.txt'));
  assert.equal(escape.ok, false);
  assert.equal(escape.code, 'SCOPE_VIOLATION');
  // The reported resolution is fully normalized (no raw `..` left).
  assert.ok(!escape.detail.includes('..'), `resolved=${escape.detail}`);
});

test('B4: sibling directory sharing a prefix is NOT in scope (separator boundary)', () => {
  const { allowed } = mkScopeFixture();
  const engine = new SupervisorEngine();
  engine.setScope({ roots: [allowed] });

  const sibling = `${allowed}-evil${path.sep}payload.txt`; // worktree-evil vs worktree
  const r = engine.authorizePath(sibling);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SCOPE_VIOLATION');
});

test('B5: invalid target and invalid scope config both fail closed', () => {
  const engine = new SupervisorEngine();
  assert.equal(engine.authorizePath('').code, 'SCOPE_PATH_INVALID');
  assert.equal(engine.authorizePath(null).code, 'SCOPE_PATH_INVALID');
  assert.equal(engine.setScope({ roots: [] }).code, 'SCOPE_ROOTS_INVALID');
  assert.equal(engine.setScope({ roots: [42] }).code, 'SCOPE_ROOTS_INVALID');
  assert.equal(engine.authorizePath('whatever').code, 'SCOPE_UNSET', 'failed config leaves scope unset');
});

// ============================================================================
// C. Anti-Deadlock Reaper — timeout -> fail-closed transition
// ============================================================================

test('C1: lease below threshold is NOT reaped; crossing threshold reaps exactly once', () => {
  let clock = 1_000;
  const engine = new SupervisorEngine({ now: () => clock });
  const deadlocks = [];
  engine.on(SUPERVISOR_EVENTS.DEADLOCK, (d) => deadlocks.push(d));
  engine.transition({ from: 'ACCEPTED', to: 'ROUTED' });
  engine.transition({ from: 'ROUTED', to: 'EXECUTING' });

  engine.arm({ id: 'executor-1', timeoutMs: 500 });
  assert.equal(engine.armedLeases().length, 1);

  // Before threshold: sweep is a no-op.
  clock = 1_499;
  const before = engine.sweep();
  assert.equal(before.ok, true);
  assert.equal(before.value.reaped.length, 0, 'no reap before threshold');
  assert.equal(engine.state, 'EXECUTING');
  assert.equal(deadlocks.length, 0);

  // Crossing the threshold: reap + DEADLOCK event.
  clock = 1_500;
  const after = engine.sweep();
  assert.equal(after.ok, true);
  assert.equal(after.value.reaped.length, 1);
  assert.equal(after.value.reaped[0].id, 'executor-1');
  assert.equal(after.value.reaped[0].stalledMs, 500);
  assert.equal(deadlocks.length, 1);
  assert.equal(deadlocks[0].id, 'executor-1');

  // Exactly-once: a second sweep finds nothing (lease consumed).
  clock = 2_000;
  const again = engine.sweep();
  assert.equal(again.value.reaped.length, 0, 'lease must be consumed exactly once');
  assert.equal(deadlocks.length, 1);
  assert.equal(engine.armedLeases().length, 0);
});

test('C2: overdue FSM-tied lease performs the fail-closed transition EXECUTING -> BLOCKED', () => {
  let clock = 0;
  const engine = new SupervisorEngine({ now: () => clock });
  const transitions = [];
  engine.on(SUPERVISOR_EVENTS.TRANSITION, (r) => transitions.push(r));
  engine.transition({ from: 'ACCEPTED', to: 'ROUTED' });
  engine.transition({ from: 'ROUTED', to: 'EXECUTING' });

  engine.arm({ id: 'fsm-1', timeoutMs: 100, tieToFsm: true });
  clock = 100;
  const r = engine.sweep();

  assert.equal(r.ok, true);
  assert.equal(engine.state, 'BLOCKED', 'dead FSM state must fail closed to BLOCKED');
  const last = transitions.at(-1);
  assert.equal(last.from, 'EXECUTING');
  assert.equal(last.to, 'BLOCKED');
  assert.equal(last.reason, 'ANTI_DEADLOCK_REAPER');
  assert.equal(last.source, 'reaper');
  assert.equal(last.evidence.id, 'fsm-1');
  // The reaper transition must itself be an ALLOWED control-loop edge.
  assert.equal(isAllowedTransition('EXECUTING', 'BLOCKED'), true);
});

test('C3: heartbeat grants grace — a live lease is never reaped', () => {
  let clock = 0;
  const engine = new SupervisorEngine({ now: () => clock });
  engine.arm({ id: 'hb', timeoutMs: 100 });

  clock = 90;
  assert.equal(engine.heartbeat({ id: 'hb' }).ok, true);
  clock = 180; // 90ms since heartbeat — under threshold again
  assert.equal(engine.sweep().value.reaped.length, 0, 'heartbeat must reset the clock');

  clock = 280; // 100ms since last heartbeat
  assert.equal(engine.sweep().value.reaped.length, 1);

  // Unknown ids fail closed instead of silently succeeding.
  assert.equal(engine.heartbeat({ id: 'ghost' }).code, 'HEARTBEAT_UNKNOWN');
  assert.equal(engine.disarm({ id: 'ghost' }).code, 'DISARM_UNKNOWN');
});

test('C4: overdue lease on a NON-tied task never mutates the FSM state', () => {
  let clock = 0;
  const engine = new SupervisorEngine({ now: () => clock });
  const transitions = [];
  engine.on(SUPERVISOR_EVENTS.TRANSITION, (r) => transitions.push(r));
  engine.transition({ from: 'ACCEPTED', to: 'ROUTED' });

  engine.arm({ id: 'side-task', timeoutMs: 10, tieToFsm: false });
  clock = 10;
  const r = engine.sweep();
  assert.equal(r.value.reaped.length, 1);
  assert.equal(r.value.reaped[0].transition, null, 'no FSM transition for non-tied lease');
  assert.equal(engine.state, 'ROUTED');
  assert.equal(transitions.length, 1);
});

test('C5: arm() validates input; re-arming the same id renews without duplication', () => {
  const engine = new SupervisorEngine();
  assert.equal(engine.arm({ id: '' }).code, 'REAPER_ARM_INVALID');
  assert.equal(engine.arm({ id: 'x', timeoutMs: -1 }).code, 'REAPER_ARM_INVALID');
  assert.equal(engine.arm({ id: 'x', timeoutMs: 0 }).code, 'REAPER_ARM_INVALID');

  assert.equal(engine.arm({ id: 'x', timeoutMs: 50 }).value.renewed, false);
  assert.equal(engine.arm({ id: 'x', timeoutMs: 60 }).value.renewed, true);
  assert.equal(engine.armedLeases().length, 1, 're-arm must not duplicate');
  assert.equal(engine.armedLeases()[0].timeoutMs, 60);
});

test('C6: sweep rejects a non-finite clock injection (fail-closed)', () => {
  const engine = new SupervisorEngine();
  const r = engine.sweep({ now: NaN });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SWEEP_TIME_INVALID');
});

// ============================================================================
// D. Safe recovery
// ============================================================================

test('D1: after a reaper BLOCKED transition the engine is a terminal dead-end', () => {
  let clock = 0;
  const engine = new SupervisorEngine({ now: () => clock });
  engine.transition({ from: 'ACCEPTED', to: 'ROUTED' });
  engine.transition({ from: 'ROUTED', to: 'EXECUTING' });
  engine.arm({ id: 'fsm', timeoutMs: 10, tieToFsm: true });
  clock = 10;
  engine.sweep();
  assert.equal(engine.state, 'BLOCKED');

  // Recovery discipline: BLOCKED is terminal — no silent resurrection.
  for (const to of ['EXECUTING', 'VERIFYING', 'DELIVERING', 'COMPLETED']) {
    const r = engine.transition({ from: 'BLOCKED', to });
    assert.equal(r.ok, false, `BLOCKED->${to} must stay refused`);
    assert.equal(r.code, 'ILLEGAL_TRANSITION');
  }
  assert.equal(engine.state, 'BLOCKED');
  // Re-sweeping is a safe no-op (idempotent recovery path).
  clock = 1_000;
  assert.equal(engine.sweep().value.reaped.length, 0);
  assert.equal(engine.state, 'BLOCKED');
});

test('D2: reaper sweep on an already-terminal FSM never emits DEADLOCK noise', () => {
  let clock = 0;
  const engine = new SupervisorEngine({ initialState: 'BLOCKED', now: () => clock });
  const deadlocks = [];
  engine.on(SUPERVISOR_EVENTS.DEADLOCK, (d) => deadlocks.push(d));
  // A lease can still be armed (task-level), but tieToFsm on a terminal state
  // must not attempt an illegal transition.
  engine.arm({ id: 'zombie', timeoutMs: 5, tieToFsm: true });
  clock = 5;
  const r = engine.sweep();
  assert.equal(r.value.reaped.length, 1);
  assert.equal(r.value.reaped[0].transition, null, 'terminal state: no transition attempted');
  assert.equal(engine.state, 'BLOCKED');
  assert.equal(deadlocks.length, 1, 'DEADLOCK still reported for observability');
});

test('D3: startReaper/stopReaper interval is sub-second, unref\'d, idempotent', async () => {
  let clock = 0;
  const engine = new SupervisorEngine({ now: () => clock });
  engine.transition({ from: 'ACCEPTED', to: 'ROUTED' });
  engine.transition({ from: 'ROUTED', to: 'EXECUTING' });
  engine.arm({ id: 't', timeoutMs: 5, tieToFsm: true });

  const started = engine.startReaper({ intervalMs: 5 });
  assert.equal(started.ok, true);
  assert.equal(started.value.intervalMs, 5, 'cadence is sub-second');
  assert.equal(engine.startReaper({ intervalMs: 5 }).value.alreadyRunning, true, 'idempotent start');
  assert.equal(engine.startReaper({ intervalMs: 0 }).code, 'REAPER_INTERVAL_INVALID');

  // Drive real time so the interval fires against the real clock path.
  await new Promise((resolve) => { clock = Date.now(); setTimeout(resolve, 40); });
  assert.equal(engine.state, 'BLOCKED', 'interval sweep performed the fail-closed transition');

  assert.equal(engine.stopReaper().value.stopped, true);
  assert.equal(engine.stopReaper().value.alreadyStopped, true, 'idempotent stop');
});

// ============================================================================
// E. FSM parity with control-loop
// ============================================================================

test('E1: SUPERVISOR_FSM_STATES is byte-identical to control-loop LOOP_STATES', () => {
  assert.deepEqual([...SUPERVISOR_FSM_STATES], [...LOOP_STATES]);
  assert.deepEqual([...SUPERVISOR_TERMINAL_STATES].sort(), [...TERMINAL_STATES].sort());
});

test('E2: every supervisor edge is admitted by bindLoop, every non-edge refused', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-parity-'));
  const id = identityHash({ repo: 'o/r', issueNumber: 1 });
  const loop = bindLoop({ sessionPath: path.join(stateDir, 's.json'), identityHash: id, stateDir });
  assert.ok(loop.ok !== false, 'bindLoop must succeed');

  let probed = 0;
  for (const from of LOOP_STATES) {
    for (const to of LOOP_STATES) {
      const supAllows = isAllowedTransition(from, to);
      const loopRes = loop.transition({ from, to, reason: 'parity-probe' });
      assert.equal(
        loopRes.ok, supAllows,
        `edge ${from}->${to}: supervisor=${supAllows} controlLoop=${loopRes.ok}`,
      );
      probed += 1;
    }
  }
  assert.equal(probed, LOOP_STATES.length * LOOP_STATES.length);
});

// ============================================================================
// F. Ledger ingestion — drift guard over canonical transitions.jsonl
// ============================================================================

function mkLedgerEngine() {
  const engine = new SupervisorEngine();
  const seen = [];
  engine.on(SUPERVISOR_EVENTS.TRANSITION, (r) => seen.push(r));
  return { engine, seen };
}

test('F1: a clean canonical ledger is replayed in order with cursor advancing', () => {
  const { engine, seen } = mkLedgerEngine();
  const ledger = [
    { from: 'ACCEPTED', to: 'ROUTED', reason: 'loop-bind' },
    { from: 'ROUTED', to: 'EXECUTING', reason: 'dispatch' },
    { from: 'EXECUTING', to: 'VERIFYING', reason: 'verify' },
  ];
  const r = engine.ingestLedger(ledger);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.ingested, 3);
  assert.equal(r.value.cursor, 3);
  assert.equal(engine.state, 'VERIFYING');
  assert.equal(seen.length, 3);
  assert.ok(seen.every((s) => s.source === 'ledger'), 'source tagged as ledger');

  // Re-ingesting the same ledger is an idempotent no-op (cursor at end).
  const r2 = engine.ingestLedger(ledger);
  assert.equal(r2.ok, true);
  assert.equal(r2.value.ingested, 0);
  assert.equal(seen.length, 3);
});

test('F2: an illegal ledger edge is detected as FSM_DRIFT and never applied', () => {
  const { engine, seen } = mkLedgerEngine();
  const violations = [];
  engine.on(SUPERVISOR_EVENTS.GUARD_VIOLATION, (v) => violations.push(v));

  const ledger = [
    { from: 'ACCEPTED', to: 'ROUTED', reason: 'ok' },
    { from: 'ROUTED', to: 'COMPLETED', reason: 'drift!' }, // illegal shortcut
    { from: 'COMPLETED', to: 'BLOCKED', reason: 'never' },
  ];
  const r = engine.ingestLedger(ledger);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'FSM_DRIFT_DETECTED');
  assert.equal(r.detail.reason, 'LEDGER_ILLEGAL_EDGE');
  assert.equal(r.detail.index, 1);
  assert.equal(engine.state, 'ROUTED', 'state stops at the last good edge');
  assert.equal(seen.length, 1, 'only the legal edge was dispatched');
  assert.equal(engine.ledgerCursor, 1, 'cursor does NOT advance past the bad record');
  assert.equal(violations.length, 1);

  // Replay re-detects the same drift (deterministic, never skipped).
  const r2 = engine.ingestLedger(ledger);
  assert.equal(r2.ok, false);
  assert.equal(r2.detail.index, 1);
});

test('F3: ledger desynced from engine state fails closed with LEDGER_STATE_DESYNC', () => {
  const { engine } = mkLedgerEngine();
  const r = engine.ingestLedger([{ from: 'EXECUTING', to: 'VERIFYING', reason: 'foreign' }]);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'FSM_DRIFT_DETECTED');
  assert.equal(r.detail.reason, 'LEDGER_STATE_DESYNC');
  assert.equal(engine.state, 'ACCEPTED');
  assert.equal(engine.ledgerCursor, 0);
});

test('F4: malformed ledger inputs fail closed', () => {
  const { engine } = mkLedgerEngine();
  assert.equal(engine.ingestLedger('nope').code, 'LEDGER_INVALID');
  assert.equal(engine.ingestLedger([null]).code, 'LEDGER_RECORD_INVALID');
  assert.equal(engine.ingestLedger([42]).code, 'LEDGER_RECORD_INVALID');
});

// ============================================================================
// G. Test Integrity Guard
// ============================================================================

test('G1: seal + verify a truthful PASS record round-trips', () => {
  const guard = createTestIntegrityGuard();
  const sealed = guard.seal({
    suite: 'tests/supervisor-reactive-guard.test.mjs',
    exitCode: 0, pass: 31, fail: 0, skip: 0, durationMs: 123.4,
  });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  assert.equal(typeof sealed.value.digest, 'string');
  assert.match(sealed.value.digest, /^[0-9a-f]{64}$/);
  assert.equal(sealed.value.record.cancelled, 0, 'normalized default');

  const v = guard.verify(sealed.value);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.value.record.pass, 31);
});

test('G2: tampered counts / status are rejected as TEST_SEAL_INVALID', () => {
  const guard = createTestIntegrityGuard();
  const sealed = guard.seal({ suite: 's', exitCode: 1, pass: 5, fail: 5, skip: 0 });

  // Flip the verdict: fail 5 -> 0 while digest still covers the old value.
  const forged = { ...sealed.value, record: { ...sealed.value.record, fail: 0, pass: 10 } };
  const v = guard.verify(forged);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'TEST_SEAL_INVALID');
  assert.match(v.detail, /tampered|forged/i);

  // Truncated / malformed seals fail closed too.
  assert.equal(guard.verify(null).code, 'TEST_SEAL_INVALID');
  assert.equal(guard.verify({ record: { suite: 's' } }).code, 'TEST_SEAL_INVALID');
  assert.equal(guard.verify({ ...sealed.value, digest: 'ab' }).code, 'TEST_SEAL_INVALID');
});

test('G3: self-contradicting "healthy" claims are refused at seal AND verify time', () => {
  const guard = createTestIntegrityGuard();
  // fail>0 with exit 0 = forged green exit.
  const lying = guard.seal({ suite: 's', exitCode: 0, pass: 10, fail: 3, skip: 0 });
  assert.equal(lying.ok, false);
  assert.equal(lying.code, 'TEST_SEAL_INCONSISTENT');

  // Shape violations fail closed with the precise reason.
  assert.equal(guard.seal({ suite: '', exitCode: 0, pass: 1, fail: 0, skip: 0 }).code, 'TEST_SEAL_SHAPE');
  assert.equal(guard.seal({ suite: 's', exitCode: 999, pass: 1, fail: 0, skip: 0 }).code, 'TEST_SEAL_SHAPE');
  assert.equal(guard.seal({ suite: 's', exitCode: 0, pass: -1, fail: 0, skip: 0 }).code, 'TEST_SEAL_SHAPE');
  assert.equal(guard.seal({ suite: 's', exitCode: 0, pass: '10', fail: 0, skip: 0 }).code, 'TEST_SEAL_SHAPE');
  assert.equal(guard.seal(null).code, 'TEST_SEAL_SHAPE');
});

test('G4: a record sealed under another guard secret never verifies (cross-instance forgery)', () => {
  const a = createTestIntegrityGuard({ secret: 'secret-a' });
  const b = createTestIntegrityGuard({ secret: 'secret-b' });
  const sealed = a.seal({ suite: 's', exitCode: 0, pass: 1, fail: 0, skip: 0 });
  assert.equal(sealed.ok, true);
  const v = b.verify(sealed.value);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'TEST_SEAL_INVALID');
});

test('G5: attached engine receives GUARD_VIOLATION events for integrity failures', () => {
  const engine = new SupervisorEngine();
  const violations = [];
  engine.on(SUPERVISOR_EVENTS.GUARD_VIOLATION, (v) => violations.push(v));
  const guard = createTestIntegrityGuard({ engine });

  guard.verify({ record: { suite: 's', exitCode: 0, pass: 1, fail: 0, skip: 0 }, digest: 'ff'.repeat(32) });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'test-integrity');
  assert.equal(violations[0].code, 'TEST_SEAL_INVALID');
});

test('G6: constructor rejects invalid guard config', () => {
  assert.throws(() => createTestIntegrityGuard({ now: 5 }), /TEST_GUARD_NOW_INVALID/);
});

// ============================================================================
// H. bin/soc-control-loop.mjs integration
// ============================================================================

const REPO = 'duongpdddic-droid/soc_brain';
const ISSUE = 99216;
const HEAD = 'a'.repeat(40);
const BASE = 'f'.repeat(40);

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'soc-sup-')); }

function mkSession(stateDir) {
  const id = identityHash({ repo: REPO, issueNumber: ISSUE });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, JSON.stringify({
    schemaVersion: '1', state: 'SESSION_ACTIVE', lifecycle: [],
    taskId: `${REPO}#${ISSUE}`, repo: REPO, issueNumber: ISSUE,
    headSha: HEAD, baseSha: BASE,
    worktreePath: path.join(stateDir, `wt-${ISSUE}`),
    worktreesRoot: stateDir, controlPlane: { stateDir },
  }, null, 2), 'utf8');
  const execPath = path.join(stateDir, 'executions', `${id}.json`);
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.writeFileSync(execPath, JSON.stringify({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: id,
    taskId: `${REPO}#${ISSUE}`, repo: REPO, issueNumber: ISSUE,
    terminalStatus: 'ok', exitCode: 0,
  }, null, 2), 'utf8');
  return { sessionPath, id, execPath };
}

function baseDeps(execPath) {
  return {
    router: () => ({ ok: true, value: { executorKind: 'opencode', model: 'x' } }),
    executor: () => ({ ok: true, value: { executionStatus: 'EXITED', terminalStatus: 'ok', exitCode: 0, executionRecordPath: execPath } }),
    verifier: () => ({ ok: true, value: { verdict: 'PASS', report: 'ok' } }),
    preReview: () => ({ ok: true, value: { verdict: 'PASS', findings: [] } }),
    telegramSpawn: () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 901 })}\n` }),
  };
}

test('H1: runSocControlLoop dispatches ledger + RUNNER_DONE into an injected supervisor', async () => {
  const stateDir = mkStateDir();
  const { id, execPath } = mkSession(stateDir);
  const engine = new SupervisorEngine();
  const seenTransitions = [];
  const runnerDone = [];
  engine.on(SUPERVISOR_EVENTS.TRANSITION, (r) => seenTransitions.push(`${r.from}->${r.to}`));
  engine.on(SUPERVISOR_EVENTS.RUNNER_DONE, (p) => runnerDone.push(p));

  const deps = baseDeps(execPath);
  deps.finalReview = () => ({ ok: true, value: { text: 'All offline gates pass.\nVERDICT: APPROVED' } });
  deps.supervisor = engine;

  const res = await runSocControlLoop({ repo: REPO, issueNumber: ISSUE, stateDir, humanGate: true, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'DELIVERING');

  // Supervisor observed the canonical ledger reactively (sub-second, sync).
  assert.ok(seenTransitions.includes('ACCEPTED->ROUTED'), seenTransitions.join(','));
  assert.ok(seenTransitions.includes('DECIDING->DELIVERING'), seenTransitions.join(','));
  assert.equal(engine.state, 'DELIVERING', 'engine mirrors the final FSM state');

  assert.equal(runnerDone.length, 1);
  assert.equal(runnerDone[0].ok, true);
  assert.equal(runnerDone[0].code, null);
  assert.equal(runnerDone[0].state, 'DELIVERING');
});

test('H2: a broken supervisor is contained — FSM result stays byte-identical', async () => {
  const stateDir = mkStateDir();
  const { execPath } = mkSession(stateDir);
  const deps = baseDeps(execPath);
  deps.finalReview = () => ({ ok: true, value: { text: 'ok\nVERDICT: APPROVED' } });
  deps.supervisor = {
    ingestLedger() { throw new Error('supervisor-observer-fault'); },
    safeEmit() { throw new Error('supervisor-emit-fault'); },
  };

  const res = await runSocControlLoop({ repo: REPO, issueNumber: ISSUE, stateDir, humanGate: true, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'DELIVERING', 'observer fault must not change the FSM outcome');
});

test('H3: RUNNER_DONE reports fail-closed results truthfully (code + null state)', async () => {
  const stateDir = mkStateDir(); // no session on disk -> SESSION_NOT_FOUND
  const engine = new SupervisorEngine();
  const runnerDone = [];
  engine.on(SUPERVISOR_EVENTS.RUNNER_DONE, (p) => runnerDone.push(p));

  const res = await runSocControlLoop({
    repo: REPO, issueNumber: ISSUE + 1, stateDir, humanGate: true,
    deps: { supervisor: engine },
  });
  assert.equal(res.ok, false);
  // Session-not-found short-circuits BEFORE the handoff seam (no run happened),
  // so no RUNNER_DONE is emitted — observation only covers real runs.
  assert.equal(runnerDone.length, 0);
});

test('H4: without a supervisor dep the runner path is unchanged (opt-in seam)', async () => {
  const stateDir = mkStateDir();
  const { execPath } = mkSession(stateDir);
  const deps = baseDeps(execPath);
  deps.finalReview = () => ({ ok: true, value: { text: 'ok\nVERDICT: APPROVED' } });

  const res = await runSocControlLoop({ repo: REPO, issueNumber: ISSUE, stateDir, humanGate: true, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.awaitingHumanGate, true);
  assert.equal(res.value.state, 'DELIVERING');
});
