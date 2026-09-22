// packages/supervisor/reactive-engine.mjs — Zero-latency reactive FSM hook.
//
// Replaces polling (sleep / setInterval 5-10 min) with an internal EventEmitter:
// the moment a step successfully appends its Transition Ledger record, the next
// step is dispatched synchronously in the same tick (ROUTED -> EXECUTING ->
// VERIFYING -> FINAL_REVIEWING). Chain latency budget is ZERO_LATENCY_BUDGET_MS
// (200ms) measured end-to-end across the whole chain — no timer, no poll loop.
//
// Fail-closed: an illegal transition, a failed ledger write, or a failed
// 3-way integrity audit aborts the chain immediately and emits `onBlocked`.
// The engine never claims a step completed without its ledger record on disk.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

export const REACTIVE_ENGINE_SCHEMA_VERSION = '1';

// Canonical zero-latency chain mandated by the Supervisor contract.
export const REACTIVE_CHAIN = Object.freeze(['ROUTED', 'EXECUTING', 'VERIFYING', 'FINAL_REVIEWING']);

// End-to-end budget for the FULL chain (all hops). A chain that exceeds this
// is reported as LATENCY_BUDGET_EXCEEDED (soft observability signal; the
// transition itself remains valid if every ledger write succeeded).
export const ZERO_LATENCY_BUDGET_MS = 200;

export const REACTIVE_EVENTS = Object.freeze({
  TRANSITION: 'transition',
  EXECUTION_FINALIZED: 'executionFinalized',
  BLOCKED: 'blocked',
});

const ALLOWED = Object.freeze({
  ACCEPTED: new Set(['ROUTED', 'BLOCKED']),
  ROUTED: new Set(['EXECUTING', 'BLOCKED']),
  EXECUTING: new Set(['VERIFYING', 'BLOCKED']),
  VERIFYING: new Set(['PRE_REVIEWING', 'FINAL_REVIEWING', 'BLOCKED']),
  PRE_REVIEWING: new Set(['FINAL_REVIEWING', 'BLOCKED']),
  FINAL_REVIEWING: new Set(['DECIDING', 'BLOCKED']),
  DECIDING: new Set(['REWORK', 'DELIVERING', 'BLOCKED']),
  REWORK: new Set(['EXECUTING', 'BLOCKED']),
  DELIVERING: new Set(['COMPLETED', 'BLOCKED']),
  COMPLETED: new Set(),
  BLOCKED: new Set(),
});

function transitionsPathFor({ stateDir, identityHash }) {
  return path.join(stateDir, 'control-loop', identityHash, 'transitions.jsonl');
}

function appendLedgerRecord({ stateDir, identityHash, record }) {
  const fp = transitionsPathFor({ stateDir, identityHash });
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.appendFileSync(fp, JSON.stringify({ schemaVersion: REACTIVE_ENGINE_SCHEMA_VERSION, ...record }) + '\n', 'utf8');
}

function readLedger({ stateDir, identityHash }) {
  const fp = transitionsPathFor({ stateDir, identityHash });
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/**
 * Create a zero-latency reactive engine bound to one session identity.
 *
 * @param {object} opts
 * @param {string} opts.stateDir       control-plane state root
 * @param {string} opts.identityHash   session identity hash (ledger namespace)
 * @param {string} [opts.sessionPath]  absolute path to the session record file
 * @param {Function} [opts.now]        ISO timestamp provider (test seam)
 * @param {Function} [opts.monotonic]  ms monotonic clock (test seam)
 * @param {Function} [opts.audit3Way]  optional 3-way integrity audit;
 *                                     returns { ok:true } or { ok:false, code, detail }
 */
export function createReactiveEngine({
  stateDir,
  identityHash,
  sessionPath = null,
  now = () => new Date().toISOString(),
  monotonic = () => Date.now(),
  audit3Way = null,
} = {}) {
  if (typeof stateDir !== 'string' || !stateDir) throw new Error('stateDir required');
  if (typeof identityHash !== 'string' || !identityHash) throw new Error('identityHash required');

  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  const history = [];
  let blocked = false;
  let executionFinalized = false;

  function onTransition(fn) { emitter.on(REACTIVE_EVENTS.TRANSITION, fn); return () => emitter.off(REACTIVE_EVENTS.TRANSITION, fn); }
  function onExecutionFinalized(fn) { emitter.on(REACTIVE_EVENTS.EXECUTION_FINALIZED, fn); return () => emitter.off(REACTIVE_EVENTS.EXECUTION_FINALIZED, fn); }
  function onBlocked(fn) { emitter.on(REACTIVE_EVENTS.BLOCKED, fn); return () => emitter.off(REACTIVE_EVENTS.BLOCKED, fn); }

  function block(code, detail) {
    blocked = true;
    const payload = { ok: false, code, detail: detail ?? null, at: now() };
    emitter.emit(REACTIVE_EVENTS.BLOCKED, payload);
    return payload;
  }

  /**
   * Synchronously perform ONE transition: audit -> ledger write -> emit.
   * Returns { ok:true, record } only after the ledger record is on disk.
   */
  function transition({ from, to, reason = null, evidence = null }) {
    if (blocked) return { ok: false, code: 'ENGINE_BLOCKED', detail: 'engine already blocked; no further transitions' };
    if (!ALLOWED[from] || !ALLOWED[from].has(to)) {
      return block('ILLEGAL_TRANSITION', `from=${from} to=${to}`);
    }
    // 3-way integrity gate BEFORE confirming the transition (fail-closed).
    if (typeof audit3Way === 'function') {
      let a;
      try { a = audit3Way({ from, to }); } catch (e) {
        return block('AUDIT_THREW', String((e && e.message) || e));
      }
      if (!a || a.ok !== true) {
        return block((a && a.code) || 'AUDIT_FAILED', (a && a.detail) ?? null);
      }
    }
    const record = { ts: now(), from, to, reason, evidence, identityHash, sessionPath };
    try {
      appendLedgerRecord({ stateDir, identityHash, record });
    } catch (e) {
      return block('LEDGER_WRITE_FAILED', String((e && e.message) || e));
    }
    // Read-back: the record MUST exist on disk before we claim success.
    const ledger = readLedger({ stateDir, identityHash });
    const last = ledger[ledger.length - 1];
    if (!last || last.ts !== record.ts || last.to !== record.to || last.from !== record.from) {
      return block('LEDGER_READBACK_MISMATCH', { expected: record, got: last ?? null });
    }
    history.push(record);
    emitter.emit(REACTIVE_EVENTS.TRANSITION, record);
    if (from === 'EXECUTING' && to === 'VERIFYING' && !executionFinalized) {
      executionFinalized = true;
      emitter.emit(REACTIVE_EVENTS.EXECUTION_FINALIZED, record);
    }
    return { ok: true, record };
  }

  /**
   * Run the full REACTIVE_CHAIN starting from `startState` (default ACCEPTED).
   * Every hop is dispatched in the SAME synchronous tick — no sleep, no
   * setInterval, no nextTick delay. Returns timing + per-hop results.
   *
   * Chain shape (default): ACCEPTED -> ROUTED -> EXECUTING -> VERIFYING -> FINAL_REVIEWING.
   */
  function runChain({ startState = 'ACCEPTED', reason = 'reactive-chain', evidence = null } = {}) {
    const t0 = monotonic();
    const hops = [];
    let state = startState;
    const pathStates = [startState, ...REACTIVE_CHAIN];
    // When startState is already the first chain node, only walk the remainder.
    const walk = startState === REACTIVE_CHAIN[0] ? REACTIVE_CHAIN.slice(1) : pathStates.slice(1);

    for (const next of walk) {
      const r = transition({ from: state, to: next, reason, evidence });
      hops.push({ from: state, to: next, ok: r.ok === true, code: r.ok === true ? null : r.code });
      if (r.ok !== true) {
        const elapsedMs = monotonic() - t0;
        return {
          ok: false, code: r.code, detail: r.detail ?? null,
          hops, state: next, elapsedMs,
          latencyWithinBudget: elapsedMs <= ZERO_LATENCY_BUDGET_MS,
          blocked: true,
        };
      }
      state = next;
    }
    const elapsedMs = monotonic() - t0;
    return {
      ok: true, state, hops, elapsedMs,
      latencyWithinBudget: elapsedMs <= ZERO_LATENCY_BUDGET_MS,
      blocked: false,
      executionFinalized,
    };
  }

  return Object.freeze({
    schemaVersion: REACTIVE_ENGINE_SCHEMA_VERSION,
    identityHash,
    stateDir,
    chain: REACTIVE_CHAIN,
    budgetMs: ZERO_LATENCY_BUDGET_MS,
    history: () => history.slice(),
    isBlocked: () => blocked,
    wasExecutionFinalized: () => executionFinalized,
    readLedger: () => readLedger({ stateDir, identityHash }),
    onTransition,
    onExecutionFinalized,
    onBlocked,
    transition,
    runChain,
  });
}
