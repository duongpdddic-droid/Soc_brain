// router.mjs — central Control-Loop Router (Issue #244).
//
// Two architecture holes are closed here:
//   LH-01 (dangling reference): every FSM phase move used to leave the session
//     projection (`session.controlLoop.state`) and its transient route
//     references behind a separate writer. This module owns ONE atomic
//     transition primitive (validate -> lock -> write -> read-back) plus a
//     `reconcile()` repair pass that removes stale references/locks and
//     re-projects the authoritative ledger tail.
//   LH-02 (missing central router): engine selection for every phase used to be
//     an ad-hoc per-runner decision. This module resolves EXECUTE /
//     PRE_REVIEW / FINAL_REVIEW / DELIVER engines from a single declarative
//     registry keyed by session metadata, with a bounded timeout + retry +
//     fallback dispatch policy.
//
// Hard invariants (fail-closed, offline-first):
//   1. NO verdict / terminalization authority: the router never calls
//      taskFinish/taskBlock and never writes a review verdict. It only
//      appends canonical ledger edges and projects session state.
//   2. NO raw session writes: every session mutation goes through the
//      runtime-sandbox serialized primitive (updateSessionUnderOwnershipLock),
//      so a concurrent ownership transfer can never be clobbered.
//   3. Schema first: a payload or state that does not match the declared
//      schema is rejected with a STRUCTURED code BEFORE any side effect.
//   4. No network, no spawn: dispatch functions are injected; the default is
//      `ENGINE_NOT_WIRED` (fail-closed, never a fabricated success).
//   5. The router lock guards a SYNCHRONOUS critical section, so a lock file
//      older than `staleLockMs` cannot belong to a live writer. Stale locks are
//      reclaimed by AGE (never by pid guessing) and an in-process holder is
//      never broken (ROUTER_LOCK_BUSY).

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { readSessionRecord, updateSessionUnderOwnershipLock } from '../runtime-sandbox/runtime-sandbox.mjs';
import {
  ALLOWED_TRANSITIONS,
  CONTROL_LOOP_SCHEMA_VERSION,
  LOOP_STATES,
  TERMINAL_STATES,
  appendTransition,
  readTransitions,
} from './control-loop.mjs';

export const ROUTER_SCHEMA_VERSION = '1';

// ---- Structured error surface -----------------------------------------------
// Every rejection carries { ok:false, code, detail }; `code` always comes from
// this set so callers can branch deterministically instead of string-matching.
export const ROUTER_ERROR_CODES = Object.freeze([
  'ROUTER_PAYLOAD_INVALID',
  'ROUTER_ILLEGAL_TRANSITION',
  'ROUTER_PHASE_INVALID',
  'ROUTER_ENGINE_UNKNOWN',
  'ROUTER_ENGINE_ROLE_MISMATCH',
  'ROUTER_ENGINE_UNAVAILABLE',
  'ROUTER_ROUTE_METADATA_INVALID',
  'ROUTER_SESSION_PATH_REQUIRED',
  'ROUTER_SESSION_READ_FAILED',
  'ROUTER_SESSION_NOT_ACTIVE',
  'ROUTER_SESSION_WRITE_FAILED',
  'ROUTER_STATE_READ_FAILED',
  'ROUTER_STATE_DESYNC',
  'ROUTER_SESSION_STATE_DESYNC',
  'ROUTER_TRANSITION_CONFLICT',
  'ROUTER_LEDGER_APPEND_FAILED',
  'ROUTER_LEDGER_READBACK_FAILED',
  'ROUTER_LOCK_UNAVAILABLE',
  'ROUTER_LOCK_BUSY',
  'ROUTER_LOCK_TIMEOUT',
  'ROUTER_ENGINE_NOT_WIRED',
  'ROUTER_DISPATCH_TIMEOUT',
  'ROUTER_DISPATCH_FAILED',
  'ROUTER_FALLBACK_EXHAUSTED',
  'ROUTER_SETTLE_FAILED',
  'ROUTER_ROUTE_RECORD_FAILED',
]);

// ---- Phases ------------------------------------------------------------------
// One entry per FSM leg the router may select an engine for.
export const ROUTER_PHASES = Object.freeze(['EXECUTE', 'PRE_REVIEW', 'FINAL_REVIEW', 'DELIVER']);

const PHASE_ROLE = Object.freeze({
  EXECUTE: 'executor',
  PRE_REVIEW: 'pre-review',
  FINAL_REVIEW: 'final-review',
  DELIVER: 'delivery',
});

// session.controlLoop.route key that carries the engine for each phase.
const PHASE_META_KEY = Object.freeze({
  EXECUTE: 'executor',
  PRE_REVIEW: 'preReview',
  FINAL_REVIEW: 'finalReview',
  DELIVER: 'deliver',
});

// ---- Engine registry ---------------------------------------------------------
// `available:false` entries are REGISTERED but fail-closed: the router will
// never auto-select or dispatch them (no fabricated transport, no fake verdict).
export const ROUTER_ENGINES = Object.freeze({
  'opencode-cli': Object.freeze({
    role: 'executor', transport: 'executor-launcher', executorKind: 'opencode', available: true,
  }),
  'claude-cli': Object.freeze({
    role: 'executor', transport: null, executorKind: 'claude', available: false,
    unavailableCode: 'NO_CLAUDE_TRANSPORT',
  }),
  'gemini-web2api': Object.freeze({
    role: 'pre-review', transport: 'gemini-plus-web2api-copy', available: true,
  }),
  'gemini-native': Object.freeze({
    role: 'pre-review', transport: 'gemini-transport', available: false,
    unavailableCode: 'NO_GEMINI_TRANSPORT',
  }),
  'gpt-web2api-copy': Object.freeze({
    role: 'final-review', transport: 'chatgpt-plus-web2api-copy', available: true,
  }),
  'gpt-cwa': Object.freeze({
    role: 'final-review', transport: 'chatgpt-web-cwa', available: true,
  }),
  'gpt-cdp-legacy': Object.freeze({
    role: 'final-review', transport: 'chatgpt-web-cdp', available: false,
    unavailableCode: 'LEGACY_CDP_OPT_IN_REQUIRED',
  }),
  'telegram-cli': Object.freeze({
    role: 'delivery', transport: 'telegram-dispatch', available: true,
  }),
});

export const DEFAULT_ENGINE_FOR_PHASE = Object.freeze({
  EXECUTE: 'opencode-cli',
  PRE_REVIEW: 'gemini-web2api',
  FINAL_REVIEW: 'gpt-web2api-copy',
  DELIVER: 'telegram-cli',
});

// Phase fallback chain (retried ONLY after the primary exhausted its budget).
// EXECUTE has NO fallback on purpose: control-loop's post-execution rule says
// the executor must never run a second time.
export const DEFAULT_FALLBACK_FOR_PHASE = Object.freeze({
  EXECUTE: null,
  PRE_REVIEW: null,
  FINAL_REVIEW: 'gpt-cwa',
  DELIVER: null,
});

export const MAX_ROUTE_RETRIES = 3;
export const DEFAULT_ROUTE_RETRIES = 1;
export const DEFAULT_ROUTE_TIMEOUT_MS = 30_000;
export const MAX_ROUTE_TIMEOUT_MS = 4 * 60 * 60 * 1000;
export const MAX_EVIDENCE_BYTES = 64 * 1024;
export const MAX_REASON_LENGTH = 200;
export const MAX_ROUTE_ID_LENGTH = 96;

// Codes a dispatch may return that make a SAME-engine retry pointless; the
// router then tries the fallback engine (if any) instead of burning retries.
const NON_RETRYABLE_DISPATCH_CODES = Object.freeze(new Set([
  'ROUTER_ENGINE_NOT_WIRED',
  'NO_TRANSPORT',
  'ENGINE_UNAVAILABLE',
]));

const ROUTE_META_KEYS = Object.freeze([
  'schemaVersion', 'executor', 'preReview', 'finalReview', 'deliver',
  'model', 'timeoutMs', 'retries', 'fallback',
]);

function ok(value, extra = {}) { return { ok: true, value, ...extra }; }
function fail(code, detail) { return { ok: false, code, detail: detail ?? null }; }

// NOTE: never unref these timers. An unref'd wait timer lets the event loop go
// empty while a transition/attempt is still pending, silently dropping work.
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function lockKey(p) {
  return process.platform === 'win32' ? String(p).toLowerCase() : String(p);
}

// Locks THIS process currently holds. A reconcile/transition must never break
// a lock it owns (ROUTER_LOCK_BUSY), even when it looks stale by age.
const heldRouterLocks = new Set();

// ---- Transition payload schema (fail-closed) --------------------------------
const TRANSITION_EVENT_FIELDS = Object.freeze(['from', 'to', 'reason', 'evidence', 'route']);

/**
 * Validate a transition event against the declared schema. Pure (no I/O) so
 * every caller rejects malformed input BEFORE touching disk.
 * @returns {{ok:true, value:{from:string,to:string,reason:string|null,evidence:* ,route:*}}|{ok:false,code:string,detail:{errors:Array}}}
 */
export function validateTransitionEvent(event) {
  const errors = [];
  const push = (field, code, message, value) => errors.push({ field, code, message, value: value === undefined ? null : value });

  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    push('event', 'FIELD_TYPE', 'transition event must be a plain object', event === null ? 'null' : Array.isArray(event) ? 'array' : typeof event);
    return fail('ROUTER_PAYLOAD_INVALID', { errors });
  }
  for (const key of Object.keys(event)) {
    if (!TRANSITION_EVENT_FIELDS.includes(key)) push(key, 'UNKNOWN_FIELD', `unknown field "${key}" (fail-closed schema)`);
  }
  for (const field of ['from', 'to']) {
    const v = event[field];
    if (v === undefined || v === null) push(field, 'FIELD_MISSING', `${field} is required`);
    else if (typeof v !== 'string') push(field, 'FIELD_TYPE', `${field} must be a string`, typeof v);
    else if (!LOOP_STATES.includes(v)) push(field, 'STATE_UNKNOWN', `${v} is not a declared loop state`, v);
  }
  if (event.reason !== undefined && event.reason !== null) {
    if (typeof event.reason !== 'string') push('reason', 'FIELD_TYPE', 'reason must be a string or null', typeof event.reason);
    else if (!event.reason.trim()) push('reason', 'FIELD_EMPTY', 'reason must be non-empty when provided');
    else if (event.reason.length > MAX_REASON_LENGTH) push('reason', 'REASON_TOO_LONG', `reason must be <= ${MAX_REASON_LENGTH} chars`, event.reason.length);
  }
  if (event.evidence !== undefined && event.evidence !== null) {
    let serialized = null;
    try { serialized = JSON.stringify(event.evidence); }
    catch { serialized = undefined; }
    if (serialized === undefined) push('evidence', 'EVIDENCE_NOT_SERIALIZABLE', 'evidence must be JSON-serializable');
    else if (serialized.length > MAX_EVIDENCE_BYTES) push('evidence', 'EVIDENCE_TOO_LARGE', `evidence must be <= ${MAX_EVIDENCE_BYTES} bytes`, serialized.length);
  }
  if (event.route !== undefined && event.route !== null) {
    if (typeof event.route !== 'object' || Array.isArray(event.route)) push('route', 'FIELD_TYPE', 'route must be a plain object');
    else {
      if (event.route.phase !== undefined && typeof event.route.phase === 'string' && !ROUTER_PHASES.includes(event.route.phase)) {
        push('route.phase', 'PHASE_UNKNOWN', 'route.phase is not a declared router phase', event.route.phase);
      } else if (event.route.phase !== undefined && typeof event.route.phase !== 'string') {
        push('route.phase', 'FIELD_TYPE', 'route.phase must be a string');
      }
      if (event.route.engine !== undefined && (typeof event.route.engine !== 'string' || !event.route.engine.trim() || event.route.engine.length > MAX_ROUTE_ID_LENGTH)) {
        push('route.engine', 'FIELD_TYPE', 'route.engine must be a non-empty short string');
      }
    }
  }
  if (errors.length) return fail('ROUTER_PAYLOAD_INVALID', { errors });
  return ok({
    from: event.from,
    to: event.to,
    reason: event.reason ?? null,
    evidence: event.evidence ?? null,
    route: event.route ?? null,
  });
}

/** Allowed destination states for `from` (canonical control-loop table). */
export function allowedTransitionsFrom(from) {
  const set = ALLOWED_TRANSITIONS[from];
  return set ? [...set] : [];
}

export function canTransition(from, to) {
  return ALLOWED_TRANSITIONS[from] !== undefined && ALLOWED_TRANSITIONS[from].has(to) === true;
}

// ---- Engine resolution (pure) -------------------------------------------------
function routeMetaFrom(session) {
  const cl = session && typeof session.controlLoop === 'object' && session.controlLoop !== null ? session.controlLoop : null;
  return cl && cl.route !== undefined ? cl.route : null;
}

function validateEngineName({ name, role, errors, field }) {
  if (typeof name !== 'string' || !name.trim()) {
    errors.push({ field, code: 'FIELD_TYPE', message: 'engine name must be a non-empty string', value: typeof name });
    return null;
  }
  const entry = ROUTER_ENGINES[name];
  if (!entry) {
    errors.push({ field, code: 'ENGINE_UNKNOWN', message: `unknown engine "${name}"`, value: name });
    return null;
  }
  if (entry.role !== role) {
    errors.push({ field, code: 'ENGINE_ROLE_MISMATCH', message: `engine "${name}" is a ${entry.role}, not a ${role}`, value: name });
    return null;
  }
  if (entry.available !== true) {
    errors.push({ field, code: 'ENGINE_UNAVAILABLE', message: `engine "${name}" is registered but unavailable`, value: name, unavailableCode: entry.unavailableCode ?? null });
    return null;
  }
  return entry;
}

function metaFailureCode(errors) {
  if (errors.some((e) => e.code === 'ENGINE_UNKNOWN')) return 'ROUTER_ENGINE_UNKNOWN';
  if (errors.some((e) => e.code === 'ENGINE_ROLE_MISMATCH')) return 'ROUTER_ENGINE_ROLE_MISMATCH';
  if (errors.some((e) => e.code === 'ENGINE_UNAVAILABLE')) return 'ROUTER_ENGINE_UNAVAILABLE';
  return 'ROUTER_ROUTE_METADATA_INVALID';
}

/**
 * Pure route selection: session metadata -> { engine, model, retries, ... }.
 * No disk, no network. Fail-closed on ANY schema/registry mismatch.
 */
export function resolveRouteForSession({ session, phase, routeMeta = undefined } = {}) {
  const errors = [];
  if (!ROUTER_PHASES.includes(phase)) {
    return fail('ROUTER_PHASE_INVALID', { phase: typeof phase === 'string' ? phase : typeof phase, phases: [...ROUTER_PHASES] });
  }
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    return fail('ROUTER_SESSION_READ_FAILED', { reason: 'SESSION_NOT_FOUND' });
  }
  if (session.state !== 'SESSION_ACTIVE') {
    return fail('ROUTER_SESSION_NOT_ACTIVE', { state: session.state ?? null });
  }
  const role = PHASE_ROLE[phase];
  const meta = routeMeta === undefined ? routeMetaFrom(session) : routeMeta;

  if (meta !== null && meta !== undefined) {
    if (typeof meta !== 'object' || Array.isArray(meta)) {
      return fail('ROUTER_ROUTE_METADATA_INVALID', { errors: [{ field: 'controlLoop.route', code: 'FIELD_TYPE', message: 'route metadata must be a plain object' }] });
    }
    for (const key of Object.keys(meta)) {
      if (!ROUTE_META_KEYS.includes(key)) errors.push({ field: `controlLoop.route.${key}`, code: 'UNKNOWN_FIELD', message: `unknown route metadata field "${key}"` });
    }
    if (meta.schemaVersion !== undefined && meta.schemaVersion !== ROUTER_SCHEMA_VERSION) {
      errors.push({ field: 'controlLoop.route.schemaVersion', code: 'SCHEMA_MISMATCH', message: `expected ${ROUTER_SCHEMA_VERSION}`, value: meta.schemaVersion });
    }
    if (meta.model !== undefined && meta.model !== null && typeof meta.model !== 'string') {
      errors.push({ field: 'controlLoop.route.model', code: 'FIELD_TYPE', message: 'model must be a string or null' });
    }
    if (meta.timeoutMs !== undefined) {
      const t = meta.timeoutMs;
      if (!Number.isInteger(t) || t <= 0 || t > MAX_ROUTE_TIMEOUT_MS) {
        errors.push({ field: 'controlLoop.route.timeoutMs', code: 'FIELD_RANGE', message: `timeoutMs must be an integer in 1..${MAX_ROUTE_TIMEOUT_MS}`, value: t });
      }
    }
    if (meta.retries !== undefined) {
      const r = meta.retries;
      if (!Number.isInteger(r) || r < 0 || r > MAX_ROUTE_RETRIES) {
        errors.push({ field: 'controlLoop.route.retries', code: 'FIELD_RANGE', message: `retries must be an integer in 0..${MAX_ROUTE_RETRIES}`, value: r });
      }
    }
  }

  const requested = meta && meta[PHASE_META_KEY[phase]] !== undefined ? meta[PHASE_META_KEY[phase]] : DEFAULT_ENGINE_FOR_PHASE[phase];
  const engineEntry = validateEngineName({ name: requested, role, errors, field: `controlLoop.route.${PHASE_META_KEY[phase]}` });

  // `controlLoop.route.fallback` is a SINGLE shared field across phases:
  //   - omitted        -> this phase's declared default fallback
  //   - null           -> fallback disabled for this phase
  //   - another role   -> it belongs to a different phase; this phase keeps its
  //                       own default (it is still hard-validated when THAT
  //                       phase resolves)
  //   - unknown / unavailable / == primary -> hard error (fail-closed: a typo
  //                       must never silently degrade the route)
  let fallbackName = null;
  let fallbackTransport = null;
  if (!meta || meta.fallback === undefined) {
    fallbackName = DEFAULT_FALLBACK_FOR_PHASE[phase];
  } else if (meta.fallback !== null) {
    const fb = typeof meta.fallback === 'string' && meta.fallback.trim() ? ROUTER_ENGINES[meta.fallback] : undefined;
    if (typeof meta.fallback !== 'string' || !meta.fallback.trim()) {
      errors.push({ field: 'controlLoop.route.fallback', code: 'FIELD_TYPE', message: 'fallback must be an engine name, null or omitted' });
    } else if (!fb) {
      errors.push({ field: 'controlLoop.route.fallback', code: 'ENGINE_UNKNOWN', message: `unknown engine "${meta.fallback}"`, value: meta.fallback });
    } else if (fb.role !== role) {
      fallbackName = DEFAULT_FALLBACK_FOR_PHASE[phase];
    } else if (fb.available !== true) {
      errors.push({ field: 'controlLoop.route.fallback', code: 'ENGINE_UNAVAILABLE', message: `engine "${meta.fallback}" is registered but unavailable`, value: meta.fallback, unavailableCode: fb.unavailableCode ?? null });
    } else if (meta.fallback === requested) {
      errors.push({ field: 'controlLoop.route.fallback', code: 'FALLBACK_SAME_AS_PRIMARY', message: 'fallback must differ from the primary engine' });
    } else {
      fallbackName = meta.fallback;
      fallbackTransport = fb.transport;
    }
  }
  if (fallbackName && fallbackTransport === null) {
    const fb = ROUTER_ENGINES[fallbackName];
    fallbackTransport = fb && fb.available === true ? fb.transport : null;
    if (!fb || fb.available !== true) fallbackName = null;
  }

  if (errors.length) return fail(metaFailureCode(errors), { errors });

  return ok({
    phase,
    role,
    engine: requested,
    transport: engineEntry.transport,
    executorKind: engineEntry.executorKind ?? null,
    model: (meta && meta.model !== undefined) ? meta.model : null,
    timeoutMs: (meta && meta.timeoutMs !== undefined) ? meta.timeoutMs : DEFAULT_ROUTE_TIMEOUT_MS,
    retries: (meta && meta.retries !== undefined) ? meta.retries : DEFAULT_ROUTE_RETRIES,
    fallback: fallbackName,
    fallbackTransport,
  });
}

// ---- Router instance ----------------------------------------------------------
/**
 * @param {object} opts
 * @param {string} opts.sessionPath  canonical <stateDir>/sessions/<identityHash>.json
 * @param {string} opts.identityHash canonical identity hash (ledger folder key)
 * @param {string} opts.stateDir     control-plane state root
 * @param {() => string} opts.now    ISO clock (injected in tests)
 * @param {() => number} opts.clock  monotonic-ish clock in ms (attempt timings)
 * @param {number} opts.lockTimeoutMs  bounded lock acquisition budget
 * @param {number} opts.lockRetryMs    sleep between lock attempts
 * @param {number} opts.staleLockMs    age after which an unowned lock is reclaimed
 */
export function createControlLoopRouter({
  sessionPath,
  identityHash,
  stateDir,
  now = () => new Date().toISOString(),
  clock = Date.now,
  lockTimeoutMs = 5_000,
  lockRetryMs = 10,
  staleLockMs = 60_000,
} = {}) {
  if (typeof sessionPath !== 'string' || !sessionPath) return fail('ROUTER_SESSION_PATH_REQUIRED', { sessionPath: sessionPath ?? null });
  if (typeof identityHash !== 'string' || !identityHash) return fail('ROUTER_SESSION_PATH_REQUIRED', { identityHash: identityHash ?? null });
  if (typeof stateDir !== 'string' || !stateDir) return fail('ROUTER_SESSION_PATH_REQUIRED', { stateDir: stateDir ?? null });

  const loopDir = path.join(stateDir, 'control-loop', identityHash);
  const routesDir = path.join(loopDir, 'routes');
  const lockPath = path.join(loopDir, 'router.lock');

  // ---- state reads ------------------------------------------------------------
  function readState() {
    let ledger;
    try {
      ledger = readTransitions({ stateDir, identityHash });
    } catch (e) {
      return fail('ROUTER_STATE_READ_FAILED', { error: String((e && e.message) || e) });
    }
    const tail = ledger.length ? ledger[ledger.length - 1] : null;
    const rs = readSessionRecord(sessionPath);
    if (!rs.ok) return fail('ROUTER_SESSION_READ_FAILED', { reason: rs.reason, path: sessionPath });
    const controlLoop = rs.session.controlLoop && typeof rs.session.controlLoop === 'object' ? rs.session.controlLoop : null;
    return ok({
      ledger,
      tail,
      session: rs.session,
      sessionState: controlLoop && controlLoop.state !== undefined && controlLoop.state !== null ? controlLoop.state : null,
    });
  }

  // Authoritative pre-condition check. `mode`:
  //   'pre'    -> validation before taking the lock (ROUTER_*_DESYNC)
  //   'locked' -> re-validation inside the critical section: the state moved
  //               while this event waited -> ROUTER_TRANSITION_CONFLICT
  function checkFrom(from, st, mode) {
    const code = mode === 'locked' ? 'ROUTER_TRANSITION_CONFLICT' : 'ROUTER_STATE_DESYNC';
    const ledgerOk = st.tail ? st.tail.to === from : from === 'ACCEPTED';
    if (!ledgerOk) {
      return fail(code, {
        source: 'ledger',
        expectedFrom: from,
        ledgerTail: st.tail ? `${st.tail.from}->${st.tail.to}` : null,
        ledgerLength: st.ledger.length,
      });
    }
    // A NULL projection is a seed (fresh adoption / legacy main path that never
    // wrote it): it is admitted and materialized by this transition's write.
    if (st.sessionState !== null && st.sessionState !== from) {
      return fail(mode === 'locked' ? 'ROUTER_TRANSITION_CONFLICT' : 'ROUTER_SESSION_STATE_DESYNC', {
        source: 'session.controlLoop.state',
        expectedFrom: from,
        sessionState: st.sessionState,
      });
    }
    return ok(true);
  }

  // ---- router lock ------------------------------------------------------------
  function readLockAgeMs() {
    try {
      const st = fs.statSync(lockPath);
      return clock() - st.mtimeMs;
    } catch {
      return null; // absent
    }
  }

  async function acquireLock({ stale = staleLockMs, wait = true } = {}) {
    const deadline = clock() + Math.max(0, lockTimeoutMs);
    let staleLockRemoved = false;
    for (;;) {
      try {
        fs.mkdirSync(loopDir, { recursive: true });
        fs.writeFileSync(lockPath, JSON.stringify({ schemaVersion: ROUTER_SCHEMA_VERSION, pid: process.pid, at: now() }), { flag: 'wx' });
        heldRouterLocks.add(lockKey(lockPath));
        return ok({ lockPath, staleLockRemoved });
      } catch (e) {
        if (!e || e.code !== 'EEXIST') {
          return fail('ROUTER_LOCK_UNAVAILABLE', { lockPath, error: String((e && e.message) || e) });
        }
      }
      // An in-process holder is NEVER broken — not even by age (a live
      // `route()` dispatch legitimately holds the lock across an await).
      if (heldRouterLocks.has(lockKey(lockPath))) {
        if (!wait) return fail('ROUTER_LOCK_BUSY', { lockPath, heldInProcess: true, staleLockMs: stale });
        if (clock() >= deadline) return fail('ROUTER_LOCK_TIMEOUT', { lockPath, timeoutMs: lockTimeoutMs, heldInProcess: true });
        await sleep(lockRetryMs);
        continue;
      }
      // The critical section guarded by this lock is SYNCHRONOUS, so an
      // unowned lock older than `stale` is a crash leftover, never a live
      // writer. Reclaim by AGE only (never pid guessing).
      const age = readLockAgeMs();
      if (age !== null && age >= stale) {
        try {
          fs.rmSync(lockPath, { force: true });
          staleLockRemoved = true;
          continue;
        } catch { /* next attempt */ }
      }
      // reconcile() is a repair pass: it must never queue behind a live
      // dispatch, so it reports BUSY immediately instead of waiting.
      if (!wait) return fail('ROUTER_LOCK_BUSY', { lockPath, ageMs: age, heldInProcess: false });
      if (clock() >= deadline) {
        return fail('ROUTER_LOCK_TIMEOUT', { lockPath, timeoutMs: lockTimeoutMs, ageMs: age });
      }
      await sleep(lockRetryMs);
    }
  }

  function releaseLock(l) {
    if (!l || !l.ok) return;
    heldRouterLocks.delete(lockKey(l.value.lockPath));
    try { fs.rmSync(l.value.lockPath, { force: true }); } catch { /* best-effort release */ }
  }

  // ---- session projection writes (ownership-serialized) -----------------------
  function writeSessionState(to) {
    const w = updateSessionUnderOwnershipLock(sessionPath, (session) => {
      const cl = session.controlLoop && typeof session.controlLoop === 'object' ? session.controlLoop : {};
      cl.state = to;
      session.controlLoop = cl;
      return { session };
    });
    if (!w.ok) return fail('ROUTER_SESSION_WRITE_FAILED', { reason: w.reason ?? null, detail: w.detail ?? null });
    const projected = w.session && w.session.controlLoop ? w.session.controlLoop.state : undefined;
    if (projected !== to) return fail('ROUTER_SESSION_WRITE_FAILED', { readback: projected ?? null, expected: to });
    return ok({ state: projected });
  }

  function restoreSessionState(previous) {
    try {
      const w = updateSessionUnderOwnershipLock(sessionPath, (session) => {
        const cl = session.controlLoop && typeof session.controlLoop === 'object' ? session.controlLoop : {};
        if (previous === null || previous === undefined) delete cl.state;
        else cl.state = previous;
        session.controlLoop = cl;
        return { session };
      });
      return w.ok ? { ok: true } : { ok: false, reason: w.reason ?? null };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  }

  function writeRouteRef(ref) {
    const w = updateSessionUnderOwnershipLock(sessionPath, (session) => {
      const cl = session.controlLoop && typeof session.controlLoop === 'object' ? session.controlLoop : {};
      cl.router = { schemaVersion: ROUTER_SCHEMA_VERSION, ...ref, at: now() };
      session.controlLoop = cl;
      return { session };
    });
    if (!w.ok) return fail('ROUTER_SESSION_WRITE_FAILED', { reason: w.reason ?? null, detail: w.detail ?? null });
    return ok({ ref: w.session.controlLoop.router });
  }

  function clearRouteRef() {
    const w = updateSessionUnderOwnershipLock(sessionPath, (session) => {
      const cl = session.controlLoop && typeof session.controlLoop === 'object' ? session.controlLoop : {};
      if (Object.prototype.hasOwnProperty.call(cl, 'router')) delete cl.router;
      session.controlLoop = cl;
      return { session };
    });
    if (!w.ok) return fail('ROUTER_SESSION_WRITE_FAILED', { reason: w.reason ?? null, detail: w.detail ?? null });
    return ok({ cleared: true });
  }

  // ---- route records (per-dispatch journal) ----------------------------------
  function routeRecordPath(routeId) {
    return path.join(routesDir, `${routeId}.json`);
  }

  function writeRouteRecord(record) {
    try {
      fs.mkdirSync(routesDir, { recursive: true });
      const target = routeRecordPath(record.routeId);
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, target);
      return { ok: true, path: target };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function readRouteRecord(routeId) {
    if (typeof routeId !== 'string' || !routeId) return null;
    try {
      const raw = fs.readFileSync(routeRecordPath(routeId), 'utf8');
      const rec = JSON.parse(raw);
      return rec && typeof rec === 'object' ? rec : null;
    } catch {
      return null; // missing/unreadable == dangling reference
    }
  }

  // ---- public: state snapshot -------------------------------------------------
  function state() {
    const st = readState();
    if (!st.ok) return st;
    return ok({
      schemaVersion: ROUTER_SCHEMA_VERSION,
      controlLoopSchemaVersion: CONTROL_LOOP_SCHEMA_VERSION,
      identityHash,
      sessionPath,
      stateDir,
      ledger: { length: st.value.ledger.length, tail: st.value.tail ? { from: st.value.tail.from, to: st.value.tail.to } : null },
      sessionState: st.value.sessionState,
      terminal: st.value.tail ? TERMINAL_STATES.has(st.value.tail.to) : false,
      lock: { path: lockPath, heldInProcess: heldRouterLocks.has(lockKey(lockPath)) },
    });
  }

  // ---- public: atomic transition ---------------------------------------------
  async function transition(event) {
    const v = validateTransitionEvent(event);
    if (!v.ok) return v;
    const { from, to, reason, evidence, route } = v.value;

    if (!canTransition(from, to)) {
      return fail('ROUTER_ILLEGAL_TRANSITION', { from, to, allowed: allowedTransitionsFrom(from) });
    }
    const pre = readState();
    if (!pre.ok) return pre;
    const preCheck = checkFrom(from, pre.value, 'pre');
    if (!preCheck.ok) return preCheck;

    const lock = await acquireLock();
    if (!lock.ok) return lock;
    try {
      const cur = readState();
      if (!cur.ok) return cur;
      const inLock = checkFrom(from, cur.value, 'locked');
      if (!inLock.ok) return inLock;

      const previousSessionState = cur.value.sessionState;
      const record = {
        ts: now(),
        from,
        to,
        reason,
        evidence,
        identityHash,
        sessionPath,
        route,
        router: { schemaVersion: ROUTER_SCHEMA_VERSION },
      };

      // Order: session projection FIRST, ledger append SECOND. A crash between
      // the two leaves session AHEAD of the ledger; the ledger is the
      // authoritative audit trail, so `reconcile()` re-projects it. If the
      // ledger append fails we roll the projection back inside the same
      // critical section -> no dangling half-transition ever escapes.
      const w = writeSessionState(to);
      if (!w.ok) return w;

      try {
        appendTransition({ stateDir, identityHash, record });
      } catch (e) {
        const rb = restoreSessionState(previousSessionState);
        return fail('ROUTER_LEDGER_APPEND_FAILED', {
          error: String((e && e.message) || e),
          rollback: rb.ok ? 'RESTORED' : 'FAILED',
          rollbackDetail: rb.ok ? null : rb.reason,
        });
      }

      const after = readState();
      if (!after.ok) return fail('ROUTER_LEDGER_READBACK_FAILED', after.detail);
      const tail = after.value.tail;
      if (!tail || tail.from !== from || tail.to !== to) {
        return fail('ROUTER_LEDGER_READBACK_FAILED', {
          expected: `${from}->${to}`,
          got: tail ? `${tail.from}->${tail.to}` : null,
        });
      }
      if (after.value.sessionState !== to) {
        return fail('ROUTER_LEDGER_READBACK_FAILED', { sessionState: after.value.sessionState, expected: to });
      }
      return ok({
        state: to,
        record: tail,
        sessionState: after.value.sessionState,
        ledgerLength: after.value.ledger.length,
        lock: { staleLockRemoved: lock.value.staleLockRemoved },
      });
    } finally {
      releaseLock(lock);
    }
  }

  // ---- public: route selection (synchronous, no dispatch) ---------------------
  function resolveRoute({ phase, sessionPath: sp = sessionPath } = {}) {
    if (typeof sp !== 'string' || !sp) return fail('ROUTER_SESSION_PATH_REQUIRED', { sessionPath: sp ?? null });
    const rs = readSessionRecord(sp);
    if (!rs.ok) return fail('ROUTER_SESSION_READ_FAILED', { reason: rs.reason, path: sp });
    return resolveRouteForSession({ session: rs.session, phase });
  }

  // ---- public: route + dispatch (timeout / retry / fallback) ------------------
  async function route({
    phase,
    ctx = {},
    dispatch = null,
    sessionPath: sp = sessionPath,
  } = {}) {
    const sel = resolveRoute({ phase, sessionPath: sp });
    if (!sel.ok) return sel;
    const cfg = sel.value;
    const d = typeof dispatch === 'function' ? dispatch : null;

    const lock = await acquireLock();
    if (!lock.ok) return lock;
    let routeId = null;
    try {
      routeId = `${String(phase).toLowerCase()}-${now().replace(/[^0-9]/g, '').slice(0, 14) || '0'}-${randomUUID().slice(0, 8)}`;
      const base = {
        schemaVersion: ROUTER_SCHEMA_VERSION,
        kind: 'RouterRouteRecord',
        routeId,
        identityHash,
        phase: cfg.phase,
        engine: cfg.engine,
        fallback: cfg.fallback,
        state: 'IN_FLIGHT',
        startedAt: now(),
      };
      const created = writeRouteRecord(base);
      if (!created.ok) return fail('ROUTER_ROUTE_RECORD_FAILED', { routeId, error: created.error });

      const ref = writeRouteRef({ routeId, phase: cfg.phase, engine: cfg.engine, state: 'IN_FLIGHT' });
      if (!ref.ok) {
        try { fs.rmSync(routeRecordPath(routeId), { force: true }); } catch { /* rollback best-effort */ }
        return ref;
      }

      const attempts = [];
      const chain = cfg.fallback ? [cfg.engine, cfg.fallback] : [cfg.engine];
      let success = null;
      let lastCode = null;
      let stoppedCode = null;

      for (const engine of chain) {
        const isFallback = engine !== cfg.engine;
        for (let attempt = 1; attempt <= cfg.retries + 1; attempt += 1) {
          if (!d) {
            attempts.push({ engine, attempt, ok: false, code: 'ROUTER_ENGINE_NOT_WIRED', ms: 0 });
            stoppedCode = 'ROUTER_ENGINE_NOT_WIRED';
            break;
          }
          const t0 = clock();
          let r;
          try {
            r = await withTimeout(
              Promise.resolve().then(() => d({ engine, phase: cfg.phase, ctx, attempt, routeId, isFallback, config: cfg })),
              cfg.timeoutMs,
            );
          } catch (e) {
            r = { ok: false, code: 'ROUTER_DISPATCH_FAILED', detail: String((e && e.message) || e) };
          }
          const ms = Math.max(0, clock() - t0);
          const code = r && r.ok === true ? null : ((r && r.code) || 'ROUTER_DISPATCH_FAILED');
          attempts.push({ engine, attempt, ok: r && r.ok === true, code, ms });
          if (r && r.ok === true) { success = { engine, isFallback, result: r.value ?? null }; break; }
          lastCode = code;
          if (code === 'ROUTER_DISPATCH_TIMEOUT') continue; // timeout is always retryable
          if (NON_RETRYABLE_DISPATCH_CODES.has(code)) { stoppedCode = stoppedCode ?? code; break; }
        }
        if (success) break;
        if (stoppedCode === 'ROUTER_ENGINE_NOT_WIRED') break; // nothing to fall back to
      }

      const settledAt = now();
      const settled = {
        ...base,
        state: 'SETTLED',
        settledAt,
        ok: Boolean(success),
        code: success ? null : (stoppedCode === 'ROUTER_ENGINE_NOT_WIRED' ? 'ROUTER_ENGINE_NOT_WIRED' : (cfg.fallback ? 'ROUTER_FALLBACK_EXHAUSTED' : 'ROUTER_DISPATCH_FAILED')),
        lastCode,
        attempts,
        usedEngine: success ? success.engine : null,
      };
      const wr = writeRouteRecord(settled);
      const sr = writeRouteRef({
        routeId,
        phase: cfg.phase,
        engine: settled.usedEngine ?? cfg.engine,
        state: 'SETTLED',
        ok: settled.ok,
        code: settled.code,
      });
      if (!wr.ok || !sr.ok) {
        return fail('ROUTER_SETTLE_FAILED', {
          routeId,
          record: wr.ok ? null : wr.error,
          session: sr.ok ? null : sr.detail,
          attempts,
        });
      }

      if (success) {
        return ok({
          routeId,
          phase: cfg.phase,
          engine: success.engine,
          isFallback: success.isFallback,
          fallback: cfg.fallback,
          model: cfg.model,
          executorKind: cfg.executorKind,
          attempts,
          result: success.result,
          lock: { staleLockRemoved: lock.value.staleLockRemoved },
        });
      }
      const code = settled.code;
      return fail(code, {
        routeId,
        phase: cfg.phase,
        engine: cfg.engine,
        fallback: cfg.fallback,
        lastCode,
        attempts,
      });
    } finally {
      releaseLock(lock);
    }
  }

  // ---- public: LH-01 reconcile ------------------------------------------------
  async function reconcile({ staleLockMs: staleOverride = staleLockMs, reason = null, staleRouteMs = 60_000 } = {}) {
    // wait:false — a repair pass reports ROUTER_LOCK_BUSY instead of queueing
    // behind a live dispatch, and NEVER breaks an in-process holder.
    const lock = await acquireLock({ stale: staleOverride, wait: false });
    if (!lock.ok) return lock;
    const actions = [];
    const warnings = [];
    const dangling = [];
    try {
      const st = readState();
      if (!st.ok) return st;

      // (1) ledger tail is authoritative: re-project it onto the session so a
      // half-finished transition can never leave state desynced.
      if (st.value.tail) {
        const tailTo = st.value.tail.to;
        if (st.value.sessionState !== tailTo) {
          const w = writeSessionState(tailTo);
          if (!w.ok) return w;
          actions.push({ kind: 'STATE_RESYNCED', from: st.value.sessionState, to: tailTo, ledgerTail: `${st.value.tail.from}->${tailTo}` });
        }
      } else if (st.value.sessionState !== null) {
        // No ledger at all: never invent history, just report the orphan.
        dangling.push({ kind: 'ORPHAN_SESSION_STATE_NO_LEDGER', state: st.value.sessionState });
      }

      // (2) transient route reference on the session record.
      const current = readState();
      if (!current.ok) return current;
      const controlLoop = current.value.session.controlLoop && typeof current.value.session.controlLoop === 'object'
        ? current.value.session.controlLoop
        : {};
      const ref = controlLoop.router && typeof controlLoop.router === 'object' ? controlLoop.router : null;
      const terminal = current.value.tail ? TERMINAL_STATES.has(current.value.tail.to) : false;

      if (ref) {
        const rec = ref.routeId ? readRouteRecord(ref.routeId) : null;
        const reasonCode = !rec ? 'RECORD_MISSING' : terminal ? 'LOOP_TERMINATED' : rec.state === 'SETTLED' ? 'SETTLED' : null;
        if (reasonCode) {
          const cleared = clearRouteRef();
          if (!cleared.ok) return cleared;
          actions.push({ kind: 'ROUTE_REF_CLEARED', routeId: ref.routeId ?? null, reason: reasonCode });
          if (rec) {
            try {
              fs.rmSync(routeRecordPath(ref.routeId), { force: true });
              actions.push({ kind: 'ROUTE_RECORD_REMOVED', routeId: ref.routeId });
            } catch (e) {
              warnings.push({ kind: 'ROUTE_RECORD_REMOVE_FAILED', routeId: ref.routeId, error: String((e && e.message) || e) });
            }
          }
        } else {
          actions.push({ kind: 'ROUTE_REF_RETAINED', routeId: ref.routeId, state: rec.state });
        }
      }

      // (3) orphan route records: settled-and-unreferenced journals, plus
      // dispatches whose in-flight record is older than staleRouteMs.
      let entries = [];
      try { entries = fs.readdirSync(routesDir); } catch { entries = []; }
      for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const full = path.join(routesDir, name);
        let rec = null;
        try { rec = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { rec = null; }
        const routeId = rec && rec.routeId ? rec.routeId : name.replace(/\.json$/, '');
        if (ref && ref.routeId === routeId) continue; // handled in (2)
        if (!rec) {
          try { fs.rmSync(full, { force: true }); actions.push({ kind: 'ROUTE_RECORD_REMOVED', routeId, reason: 'UNPARSEABLE' }); } catch { /* warning below */ }
          continue;
        }
        const ageMs = rec.startedAt ? (Date.parse(rec.startedAt) >= 0 ? clock() - Date.parse(rec.startedAt) : null) : null;
        const stale = rec.state !== 'IN_FLIGHT' || (ageMs !== null && ageMs >= staleRouteMs);
        if (stale) {
          try {
            fs.rmSync(full, { force: true });
            actions.push({ kind: 'ORPHAN_ROUTE_RECORD_REMOVED', routeId, reason: rec.state === 'IN_FLIGHT' ? 'IN_FLIGHT_STALE' : 'SETTLED_UNREFERENCED' });
          } catch (e) {
            warnings.push({ kind: 'ROUTE_RECORD_REMOVE_FAILED', routeId, error: String((e && e.message) || e) });
          }
        } else {
          actions.push({ kind: 'ROUTE_RECORD_RETAINED', routeId, state: rec.state });
        }
      }

      const after = readState();
      return ok({
        reason,
        actions,
        warnings,
        dangling,
        lock: { path: lockPath, staleLockRemoved: lock.value.staleLockRemoved },
        state: after.ok
          ? {
            ledgerTail: after.value.tail ? `${after.value.tail.from}->${after.value.tail.to}` : null,
            sessionState: after.value.sessionState,
            inSync: after.value.tail ? after.value.sessionState === after.value.tail.to : after.value.sessionState === null,
          }
          : null,
      });
    } finally {
      releaseLock(lock);
    }
  }

  return Object.freeze({
    schemaVersion: ROUTER_SCHEMA_VERSION,
    identityHash,
    sessionPath,
    stateDir,
    lockPath,
    routesDir,
    state,
    transition,
    resolveRoute,
    route,
    reconcile,
    readRouteRecord,
    validate: validateTransitionEvent,
  });
}

// Bounded attempt timeout. The losing branch is ALWAYS given a rejection
// handler before the race settles, so a late-throwing dispatch can never
// surface as an unhandled rejection.
function withTimeout(promise, ms) {
  let timer = null;
  const guarded = Promise.resolve(promise).then(
    (v) => v,
    (e) => ({ ok: false, code: 'ROUTER_DISPATCH_FAILED', detail: String((e && e.message) || e) }),
  );
  if (!Number.isFinite(ms) || ms <= 0) return guarded;
  const timeout = new Promise((resolve, reject) => {
    // Ref'd on purpose: the attempt budget MUST fire (an unref'd timer could
    // let the loop exit with the attempt still pending). Cleared in finally.
    timer = setTimeout(() => reject(new Error('ROUTER_DISPATCH_TIMEOUT')), ms);
  });
  const raced = Promise.race([guarded, timeout]).then(
    (v) => v,
    (e) => {
      const message = String((e && e.message) || e);
      if (message === 'ROUTER_DISPATCH_TIMEOUT') return { ok: false, code: 'ROUTER_DISPATCH_TIMEOUT', detail: { timeoutMs: ms } };
      return { ok: false, code: 'ROUTER_DISPATCH_FAILED', detail: message };
    },
  );
  return raced.finally(() => {
    if (timer) clearTimeout(timer);
    // `guarded` already settles the source promise through its rejection
    // handler above, so a late-throwing dispatch can never become an
    // unhandled rejection even when the timeout won the race.
  });
}

// ---- standalone reconcile (no router instance needed) ------------------------
// Convenience wrapper: LH-01 repair for a canonical session + its ledger.
// ASYNC — it serializes against the router lock like any other router event.
export async function reconcileSessionRecord({
  sessionPath, identityHash, stateDir,
  now = () => new Date().toISOString(),
  clock = Date.now,
  lockTimeoutMs = 5_000,
  lockRetryMs = 10,
  staleLockMs = 60_000,
  staleRouteMs = 60_000,
  reason = null,
} = {}) {
  const router = createControlLoopRouter({ sessionPath, identityHash, stateDir, now, clock, lockTimeoutMs, lockRetryMs, staleLockMs });
  if (!router || router.ok === false) return router;
  return router.reconcile({ staleLockMs, staleRouteMs, reason });
}
