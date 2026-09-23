#!/usr/bin/env node
// supervisor-engine.mjs — Issue/PR #216: Supervisor reactive event-driven
// engine + Behavior/Drift Guards for Soc_brain.
//
// Mission: replace long-cycle passive polling (5-10 minute wake-ups) with an
// in-process EventEmitter whose dispatch is SYNCHRONOUS — every registered
// listener runs inside the same tick as transition()/sweep()/safeEmit(), so
// reaction latency is bounded by the call itself (sub-second by construction,
// measured by the offline suite).
//
// Contents:
//   - SupervisorEngine        : FSM-compatible transition registry + dispatch.
//   - Scope Guard             : authorizePath()/guardWrite() fail-closed file
//                               scope control; every denial is a GUARD_VIOLATION.
//   - Anti-Deadlock Reaper    : arm()/heartbeat()/sweep() lease watchdog; an
//                               overdue lease emits DEADLOCK and performs the
//                               fail-closed transition <state> -> BLOCKED.
//   - Test Integrity Guard    : createTestIntegrityGuard() HMAC-sealed test
//                               records; tampered or self-contradicting
//                               "PASS" claims never verify.
//
// FSM parity: SUPERVISOR_FSM_STATES / SUPERVISOR_ALLOWED_TRANSITIONS mirror
// packages/control-loop/control-loop.mjs (LOOP_STATES / ALLOWED_TRANSITIONS)
// so the engine can ingest the canonical transitions.jsonl ledger without
// drift; the offline suite probes edge-parity against bindLoop() directly.
//
// Discipline (AGENTS.md): illegal edges, out-of-scope paths, overdue leases
// and forged test seals never "succeed"; denials are audited as events, never
// silent. Listener exceptions are contained (fail-SAFE emit) so a broken
// observer can never break the observed FSM path.
//
// Offline: no network, no gh, no child processes. No framework. Node >= 22.

import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SUPERVISOR_SCHEMA_VERSION = '1';

// Canonical event names. TRANSITION / GUARD_VIOLATION / DEADLOCK are the
// reactive surface; RUNNER_DONE is the bin/soc-control-loop.mjs handoff;
// LISTENER_ERROR records contained observer faults.
export const SUPERVISOR_EVENTS = Object.freeze({
  TRANSITION: 'transition',
  GUARD_VIOLATION: 'guard:violation',
  DEADLOCK: 'deadlock',
  RUNNER_DONE: 'runner:done',
  LISTENER_ERROR: 'listener:error',
});

// Mirror of control-loop LOOP_STATES (order preserved for readability).
export const SUPERVISOR_FSM_STATES = Object.freeze([
  'ACCEPTED', 'ROUTED', 'EXECUTING', 'VERIFYING', 'PRE_REVIEWING',
  'FINAL_REVIEWING', 'DECIDING', 'REWORK', 'DELIVERING', 'COMPLETED', 'BLOCKED',
]);

export const SUPERVISOR_TERMINAL_STATES = Object.freeze(new Set(['COMPLETED', 'BLOCKED']));

// Mirror of control-loop ALLOWED_TRANSITIONS (same edges, same fail-closed
// terminal sets). Parity is proven by tests/supervisor-reactive-guard.test.mjs
// against bindLoop(), not by trust.
export const SUPERVISOR_ALLOWED_TRANSITIONS = Object.freeze({
  ACCEPTED: new Set(['ROUTED', 'BLOCKED']),
  ROUTED: new Set(['EXECUTING', 'BLOCKED']),
  EXECUTING: new Set(['VERIFYING', 'BLOCKED']),
  VERIFYING: new Set(['PRE_REVIEWING', 'BLOCKED']),
  PRE_REVIEWING: new Set(['FINAL_REVIEWING', 'BLOCKED']),
  FINAL_REVIEWING: new Set(['DECIDING', 'BLOCKED']),
  DECIDING: new Set(['REWORK', 'DELIVERING', 'BLOCKED']),
  REWORK: new Set(['EXECUTING', 'BLOCKED']),
  DELIVERING: new Set(['COMPLETED', 'BLOCKED']),
  COMPLETED: new Set(),
  BLOCKED: new Set(),
});

export function isAllowedTransition(from, to) {
  const set = SUPERVISOR_ALLOWED_TRANSITIONS[from];
  return Boolean(set) && set.has(to);
}

function ok(value, extra = {}) { return { ok: true, value, ...extra }; }
function fail(code, detail) { return { ok: false, code, detail: detail ?? null }; }

export class SupervisorEngine extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.initialState='ACCEPTED'] FSM state this engine starts in.
   * @param {() => number} [opts.now=Date.now] injectable monotone-ish clock (ms).
   * @param {number} [opts.defaultTimeoutMs=300000] default reaper lease timeout.
   * @param {number} [opts.maxEventLog=1000] bounded in-memory event log size.
   */
  constructor({
    initialState = 'ACCEPTED',
    now = () => Date.now(),
    defaultTimeoutMs = 300_000,
    maxEventLog = 1000,
  } = {}) {
    super();
    if (!SUPERVISOR_FSM_STATES.includes(initialState)) {
      throw new Error(`SUPERVISOR_INITIAL_STATE_INVALID: ${initialState}`);
    }
    if (typeof now !== 'function') throw new Error('SUPERVISOR_NOW_INVALID: now must be a function');
    if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
      throw new Error(`SUPERVISOR_TIMEOUT_INVALID: ${defaultTimeoutMs}`);
    }
    if (!Number.isInteger(maxEventLog) || maxEventLog <= 0) {
      throw new Error(`SUPERVISOR_EVENT_LOG_INVALID: ${maxEventLog}`);
    }
    this.schemaVersion = SUPERVISOR_SCHEMA_VERSION;
    this.state = initialState;
    this.now = now;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.maxEventLog = maxEventLog;
    this.seq = 0;
    this.violations = [];   // scope / fsm-drift / test-integrity audit trail
    this.events = [];       // bounded log of every supervisor event emitted
    this.leases = new Map(); // id -> { id, timeoutMs, lastSeen, tieToFsm }
    this.ledgerCursor = 0;  // records already ingested from the FSM ledger
    this.scopeRoots = null; // null = unconfigured (fail-closed deny)
    this.lastListenerError = null;
    this.reaperTimer = null;
  }

  // ---- fail-SAFE emit --------------------------------------------------------
  // Records the event in the bounded log first, then dispatches synchronously.
  // A throwing listener can never propagate into the caller's FSM path: the
  // fault is contained and re-emitted as LISTENER_ERROR (best effort).
  safeEmit(event, payload = null) {
    this.seq += 1;
    const entry = { seq: this.seq, event, at: this.now(), payload };
    this.events.push(entry);
    if (this.events.length > this.maxEventLog) this.events.shift();
    try {
      this.emit(event, payload);
      return true;
    } catch (e) {
      this.lastListenerError = String((e && e.message) || e);
      try {
        // Log-only (no recursion into safeEmit): the fault must be visible in
        // the bounded event log as well as on the wire.
        this.seq += 1;
        this.events.push({
          seq: this.seq, event: SUPERVISOR_EVENTS.LISTENER_ERROR, at: this.now(),
          payload: { event, error: this.lastListenerError, seq: entry.seq },
        });
        if (this.events.length > this.maxEventLog) this.events.shift();
        this.emit(SUPERVISOR_EVENTS.LISTENER_ERROR, { event, error: this.lastListenerError, seq: entry.seq });
      } catch { /* contained: never recurse into another failure */ }
      return false;
    }
  }

  eventsNamed(name) {
    return this.events.filter((e) => e.event === name);
  }

  // ---- reactive FSM transition registry --------------------------------------
  // Synchronous: listeners observe the event before this method returns.
  transition({ from, to, reason = null, evidence = null, source = 'direct' } = {}) {
    if (typeof from !== 'string' || typeof to !== 'string' || !from || !to) {
      return fail('TRANSITION_ARGS_INVALID', 'from/to are required non-empty strings');
    }
    if (from !== this.state) {
      const v = { kind: 'fsm-drift', reason: 'STATE_DESYNC', from, to, expected: this.state, source };
      this.violations.push(v);
      this.safeEmit(SUPERVISOR_EVENTS.GUARD_VIOLATION, { at: this.now(), ...v });
      return fail('TRANSITION_STATE_DESYNC', `engine at ${this.state}, claimed from=${from}`);
    }
    if (!isAllowedTransition(from, to)) {
      const v = { kind: 'fsm-drift', reason: 'ILLEGAL_EDGE', from, to, source };
      this.violations.push(v);
      this.safeEmit(SUPERVISOR_EVENTS.GUARD_VIOLATION, { at: this.now(), ...v });
      return fail('ILLEGAL_TRANSITION', `from=${from} to=${to}`);
    }
    this.state = to;
    const record = { at: this.now(), from, to, reason, evidence, source };
    this.safeEmit(SUPERVISOR_EVENTS.TRANSITION, record);
    return ok({ state: to, record });
  }

  // ---- ledger ingestion (FSM runner integration seam) -------------------------
  // Replays canonical transitions.jsonl records from the cursor forward. Each
  // edge is validated against the mirrored table AND against engine state
  // continuity; the first drift stops ingestion fail-closed WITHOUT advancing
  // the cursor past the bad record (replay re-detects it, never skips it).
  ingestLedger(records) {
    if (!Array.isArray(records)) return fail('LEDGER_INVALID', 'expected an array of transition records');
    const applied = [];
    for (let i = this.ledgerCursor; i < records.length; i += 1) {
      const rec = records[i];
      if (!rec || typeof rec !== 'object') {
        return fail('LEDGER_RECORD_INVALID', `index=${i}`);
      }
      const from = String(rec.from ?? '');
      const to = String(rec.to ?? '');
      if (from !== this.state) {
        const v = { kind: 'fsm-drift', reason: 'LEDGER_STATE_DESYNC', from, to, expected: this.state, index: i };
        this.violations.push(v);
        this.safeEmit(SUPERVISOR_EVENTS.GUARD_VIOLATION, { at: this.now(), ...v });
        return fail('FSM_DRIFT_DETECTED', v);
      }
      if (!isAllowedTransition(from, to)) {
        const v = { kind: 'fsm-drift', reason: 'LEDGER_ILLEGAL_EDGE', from, to, index: i };
        this.violations.push(v);
        this.safeEmit(SUPERVISOR_EVENTS.GUARD_VIOLATION, { at: this.now(), ...v });
        return fail('FSM_DRIFT_DETECTED', v);
      }
      this.state = to;
      const record = {
        at: this.now(), from, to,
        reason: rec.reason ?? null, evidence: rec.evidence ?? null,
        source: 'ledger', index: i,
      };
      this.safeEmit(SUPERVISOR_EVENTS.TRANSITION, record);
      applied.push(record);
      this.ledgerCursor = i + 1;
    }
    return ok({ ingested: applied.length, state: this.state, cursor: this.ledgerCursor });
  }

  // ---- Scope Guard (drift guard) ---------------------------------------------
  // Fail-closed: unconfigured scope denies everything; only paths resolving
  // inside a configured root (separator-boundary safe) are authorized.
  setScope({ roots }) {
    if (!Array.isArray(roots) || roots.length === 0) {
      return fail('SCOPE_ROOTS_INVALID', 'at least one root path is required');
    }
    const norm = [];
    for (const r of roots) {
      if (typeof r !== 'string' || !r) return fail('SCOPE_ROOTS_INVALID', 'roots must be non-empty strings');
      norm.push(this._normPath(r));
    }
    this.scopeRoots = norm;
    return ok({ roots: norm });
  }

  _normPath(p) {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  _violation(v) {
    this.violations.push(v);
    this.safeEmit(SUPERVISOR_EVENTS.GUARD_VIOLATION, { at: this.now(), ...v });
  }

  // Authorize a file mutation target. Returns ok only for in-scope paths;
  // every denial is audited as a GUARD_VIOLATION event (reactive drift signal).
  authorizePath(target) {
    if (typeof target !== 'string' || !target) {
      this._violation({ kind: 'scope', reason: 'PATH_INVALID', target: target ?? null });
      return fail('SCOPE_PATH_INVALID', 'target path must be a non-empty string');
    }
    if (!Array.isArray(this.scopeRoots) || this.scopeRoots.length === 0) {
      this._violation({ kind: 'scope', reason: 'SCOPE_UNSET', target });
      return fail('SCOPE_UNSET', 'no scope roots configured (fail-closed deny)');
    }
    const abs = this._normPath(target);
    const inside = this.scopeRoots.some((root) => abs === root || abs.startsWith(`${root}${path.sep}`));
    if (!inside) {
      this._violation({ kind: 'scope', reason: 'OUT_OF_SCOPE', target, resolved: abs, roots: this.scopeRoots });
      return fail('SCOPE_VIOLATION', abs);
    }
    return ok({ path: abs });
  }

  // Readable alias for the write-blocking seam.
  guardWrite(target) { return this.authorizePath(target); }

  // ---- Anti-Deadlock Reaper ---------------------------------------------------
  // Leases are armed per watched task/FSM binding; heartbeat() proves progress;
  // sweep() detects overdue leases (injected clock in tests, interval timer in
  // production) and performs the fail-closed transition to BLOCKED.
  arm({ id, timeoutMs = this.defaultTimeoutMs, tieToFsm = true } = {}) {
    if (typeof id !== 'string' || !id) return fail('REAPER_ARM_INVALID', 'id must be a non-empty string');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return fail('REAPER_ARM_INVALID', `timeoutMs must be > 0, got ${timeoutMs}`);
    }
    const renewed = this.leases.has(id);
    this.leases.set(id, { id, timeoutMs, lastSeen: this.now(), tieToFsm: tieToFsm === true });
    return ok({ id, renewed, timeoutMs });
  }

  heartbeat({ id } = {}) {
    const lease = typeof id === 'string' ? this.leases.get(id) : undefined;
    if (!lease) return fail('HEARTBEAT_UNKNOWN', id ?? null);
    lease.lastSeen = this.now();
    return ok({ id, lastSeen: lease.lastSeen });
  }

  disarm({ id } = {}) {
    if (typeof id !== 'string' || !this.leases.has(id)) {
      return fail('DISARM_UNKNOWN', id ?? null);
    }
    this.leases.delete(id);
    return ok({ id });
  }

  armedLeases() {
    return [...this.leases.values()].map((l) => ({ id: l.id, timeoutMs: l.timeoutMs, lastSeen: l.lastSeen }));
  }

  // One sweep pass. Overdue leases are consumed exactly once (deleted before
  // emit), emit DEADLOCK, and — when tied to the FSM and the state is
  // non-terminal — drive the fail-closed transition <state> -> BLOCKED.
  sweep({ now = this.now() } = {}) {
    if (!Number.isFinite(now)) return fail('SWEEP_TIME_INVALID', now);
    const reaped = [];
    for (const lease of [...this.leases.values()]) {
      const stalledMs = now - lease.lastSeen;
      if (stalledMs < lease.timeoutMs) continue;
      this.leases.delete(lease.id); // exactly-once: consumed before emit
      const evidence = { id: lease.id, stalledMs, timeoutMs: lease.timeoutMs, at: now };
      this.safeEmit(SUPERVISOR_EVENTS.DEADLOCK, evidence);
      let transition = null;
      if (lease.tieToFsm === true && !SUPERVISOR_TERMINAL_STATES.has(this.state)) {
        const r = this.transition({
          from: this.state, to: 'BLOCKED',
          reason: 'ANTI_DEADLOCK_REAPER', evidence, source: 'reaper',
        });
        transition = r.ok ? r.value : r;
      }
      reaped.push({ ...evidence, transition });
    }
    return ok({ reaped, state: this.state, leases: this.leases.size });
  }

  // Production cadence: a sub-second interval replaces minute-scale polling.
  // The timer is unref'd so it can never hold the process (or a test) open.
  startReaper({ intervalMs = 250 } = {}) {
    // Validate input BEFORE the already-running short-circuit: invalid config
    // must fail closed even when a timer is live (never silently "ok").
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return fail('REAPER_INTERVAL_INVALID', intervalMs);
    }
    if (this.reaperTimer) return ok({ started: false, alreadyRunning: true });
    this.reaperTimer = setInterval(() => {
      try { this.sweep(); } catch { /* sweep is total; a fault never kills the timer */ }
    }, intervalMs);
    if (typeof this.reaperTimer.unref === 'function') this.reaperTimer.unref();
    return ok({ started: true, intervalMs });
  }

  stopReaper() {
    if (!this.reaperTimer) return ok({ stopped: false, alreadyStopped: true });
    clearInterval(this.reaperTimer);
    this.reaperTimer = null;
    return ok({ stopped: true });
  }
}

// ---- Test Integrity Guard -----------------------------------------------------
// Seals a test-run record with an HMAC-SHA256 digest over a canonical field
// order; verify() recomputes and rejects ANY field tampering, and both seal()
// and verify() refuse self-contradicting "healthy" claims (failures reported
// with exit 0, or cancellations reported with exit 0). Optional engine
// attachment re-emits failures as GUARD_VIOLATION events.
export function createTestIntegrityGuard({
  now = () => new Date().toISOString(),
  secret = null,
  engine = null,
} = {}) {
  const key = typeof secret === 'string' && secret
    ? secret
    : randomBytes(32).toString('hex'); // per-instance, offline, never logged
  if (typeof now !== 'function') throw new Error('TEST_GUARD_NOW_INVALID: now must be a function');

  const counters = ['pass', 'fail', 'skip'];

  function report(code, detail) {
    if (engine && typeof engine.safeEmit === 'function') {
      engine.safeEmit(SUPERVISOR_EVENTS.GUARD_VIOLATION, {
        at: now(), kind: 'test-integrity', code, detail,
      });
    }
    return fail(code, detail);
  }

  function shape(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return 'record must be an object';
    if (typeof r.suite !== 'string' || !r.suite) return 'suite must be a non-empty string';
    if (!Number.isInteger(r.exitCode) || r.exitCode < 0 || r.exitCode > 255) return 'exitCode must be an integer in 0..255';
    for (const k of counters) {
      if (!Number.isInteger(r[k]) || r[k] < 0) return `${k} must be a non-negative integer`;
    }
    if (r.cancelled !== undefined && r.cancelled !== null
      && (!Number.isInteger(r.cancelled) || r.cancelled < 0)) return 'cancelled must be a non-negative integer';
    if (r.durationMs !== undefined && r.durationMs !== null
      && (typeof r.durationMs !== 'number' || !Number.isFinite(r.durationMs) || r.durationMs < 0)) {
      return 'durationMs must be a non-negative finite number';
    }
    return null;
  }

  function consistency(r) {
    const cancelled = Number.isInteger(r.cancelled) ? r.cancelled : 0;
    if (r.fail > 0 && r.exitCode === 0) {
      return `fail=${r.fail} cannot be sealed with exitCode=0 (forged green exit)`;
    }
    if (cancelled > 0 && r.exitCode === 0) {
      return `cancelled=${cancelled} cannot be sealed with exitCode=0 (forged green exit)`;
    }
    if (r.fail === 0 && cancelled === 0 && r.exitCode !== 0) {
      return `healthy counts (fail=0, cancelled=0) contradict exitCode=${r.exitCode}`;
    }
    return null;
  }

  function canonical(r) {
    return JSON.stringify({
      suite: r.suite,
      exitCode: r.exitCode,
      pass: r.pass,
      fail: r.fail,
      skip: r.skip,
      cancelled: Number.isInteger(r.cancelled) ? r.cancelled : 0,
      durationMs: r.durationMs ?? null,
      sealedAt: r.sealedAt,
    });
  }

  function digestOf(r) {
    return createHmac('sha256', key).update(canonical(r)).digest('hex');
  }

  return {
    // Seal a test record. Returns { ok, value: { record, digest } }.
    seal(record) {
      const shapeErr = shape(record);
      if (shapeErr) return report('TEST_SEAL_SHAPE', shapeErr);
      const consErr = consistency(record);
      if (consErr) return report('TEST_SEAL_INCONSISTENT', consErr);
      const sealedAt = now();
      const normalized = {
        suite: record.suite,
        exitCode: record.exitCode,
        pass: record.pass,
        fail: record.fail,
        skip: record.skip,
        cancelled: Number.isInteger(record.cancelled) ? record.cancelled : 0,
        durationMs: record.durationMs ?? null,
        sealedAt,
      };
      return ok({ record: normalized, digest: digestOf(normalized) });
    },

    // Verify a sealed record: digest must match byte-for-byte (constant time)
    // AND the record must still be internally consistent. Fail-closed.
    verify(sealed) {
      if (!sealed || typeof sealed !== 'object' || Array.isArray(sealed)
        || typeof sealed.digest !== 'string' || !sealed.digest || !sealed.record
        || typeof sealed.record !== 'object') {
        return report('TEST_SEAL_INVALID', 'sealed record with digest is required');
      }
      const shapeErr = shape(sealed.record);
      if (shapeErr) return report('TEST_SEAL_SHAPE', shapeErr);
      const expected = Buffer.from(digestOf(sealed.record), 'hex');
      const presented = Buffer.from(sealed.digest, 'hex');
      const digestOk = expected.length === presented.length
        && expected.length === 32
        && timingSafeEqual(expected, presented);
      if (!digestOk) return report('TEST_SEAL_INVALID', 'digest mismatch (record was tampered or forged)');
      const consErr = consistency(sealed.record);
      if (consErr) return report('TEST_SEAL_INCONSISTENT', consErr);
      return ok({ suite: sealed.record.suite, record: sealed.record });
    },
  };
}
