// control-loop.mjs — Soc_brain ControlLoop v0 (Issue #69).
// See Issue #69 body for full contract. Composes existing primitives.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  taskFinish,
  taskBlock,
  readSessionRecord,
} from '../runtime-sandbox/runtime-sandbox.mjs';
import {
  dispatchLifecycleEvent,
  recoverLifecycleEvent,
} from '../telegram-dispatch/telegram-dispatch.mjs';
import { packetPathFor } from './adapters.mjs';

// Session record persistence for the controlLoop metadata block. The canonical
// FSM transitions (taskFinish/taskBlock) still own their own persistence inside
// runtime-sandbox; this helper only persists the token binding additively.
function persistSessionRecord(sessionPath, session) {
  const tmp = `${sessionPath}.tmp-${randomUUID()}`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');
  fs.renameSync(tmp, sessionPath);
  return { ok: true };
}

export const CONTROL_LOOP_SCHEMA_VERSION = '1';

// ControlLoop is Soc_brain's own orchestrator: it only terminalizes canonical
// tasks of THIS repository. Foreign sessions are refused before any transition.
export const CONTROL_LOOP_CANONICAL_REPO = 'duongpdddic-droid/soc_brain';

export const LOOP_STATES = Object.freeze([
  'ACCEPTED', 'ROUTED', 'EXECUTING', 'VERIFYING', 'PRE_REVIEWING',
  'FINAL_REVIEWING', 'DECIDING', 'REWORK', 'DELIVERING', 'COMPLETED', 'BLOCKED',
]);
export const TERMINAL_STATES = Object.freeze(new Set(['COMPLETED', 'BLOCKED']));

const ALLOWED_TRANSITIONS = Object.freeze({
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

function ok(v, extra = {}) { return { ok: true, value: v, ...extra }; }
function fail(code, detail) { return { ok: false, code, detail: detail ?? null }; }

function defaultStateDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.USERPROFILE || 'C:\\Users\\Admin', '.soc-brain', 'state');
  }
  return path.join(process.env.HOME || '/root', '.soc-brain', 'state');
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

function loopDirFor({ stateDir = defaultStateDir(), identityHash: id }) {
  return ensureDir(path.join(stateDir, 'control-loop', id));
}

function transitionsPathFor({ stateDir = defaultStateDir(), identityHash: id }) {
  return path.join(loopDirFor({ stateDir, identityHash: id }), 'transitions.jsonl');
}

// ---- READY_FOR_REVIEW notification obligation (review round-2 blocker) ------
// Lifecycle contract: the canonical boundary transition to DELIVERING (the
// READY_FOR_REVIEW boundary) carries a REQUIRED notification side-effect that
// must be satisfied BEFORE the loop may continue to COMPLETED. Ordering:
//   boundary transition -> notification side-effect -> delivery evidence
//   -> only then dependent lifecycle continuation.
// Ownership: ControlLoop itself owns the dispatch (via the telegram-dispatch
// primitive) — never the executor/model's memory. Idempotency is owned by the
// dispatch ledger: ONLY API_ACCEPTED is terminal delivery evidence and
// permanently dedupes; DELIVERY_FAILED/NOT_ATTEMPTED stay recoverable through
// the bounded recoverLifecycleEvent() budget (MAX_DELIVERY_ATTEMPTS).
// Fail-closed: no persistent delivery evidence -> DELIVER_FAILED; the loop
// never claims notification delivered when it was not.
const READY_FOR_REVIEW_EVENT = 'READY_FOR_REVIEW';

function readinessNotificationEvidence({ session, stateDir, spawn = null, configPath = null, now = null, note = null, packetPath = null }) {
  const args = { session, event: READY_FOR_REVIEW_EVENT, stateDir, allowNonCanonicalStateRoot: true, now, note };
  let r;
  try {
    r = spawn
      ? dispatchLifecycleEvent({ ...args, spawn, configPath, documentPath: packetPath || null })
      : dispatchLifecycleEvent({ ...args, configPath, documentPath: packetPath || null });
  } catch (e) {
    return { status: 'NOT_ATTEMPTED', reason: 'DISPATCH_INTERNAL_ERROR', error: String((e && e.message) || e) };
  }
  const status = r && typeof r.status === 'string' ? r.status : 'NOT_ATTEMPTED';
  if (status === 'API_ACCEPTED') {
    return { status, messageId: r.messageId ?? null, recordsPath: r.recordsPath ?? null };
  }
  return {
    status,
    reason: r ? ((r.reason ?? r.error) ?? null) : null,
    attempts: r && Number.isInteger(r.attempts) ? r.attempts : null,
    recovery: r && typeof r.recovery === 'string' ? r.recovery : null,
    recordsPath: r && r.recordsPath ? r.recordsPath : null,
  };
}

function appendTransition({ stateDir, identityHash: id, record }) {
  const fp = transitionsPathFor({ stateDir, identityHash: id });
  ensureDir(path.dirname(fp));
  fs.appendFileSync(fp, JSON.stringify({ schemaVersion: CONTROL_LOOP_SCHEMA_VERSION, ...record }) + '\n', 'utf8');
  return { ok: true, path: fp };
}

export function readTransitions({ stateDir = defaultStateDir(), identityHash: id } = {}) {
  const fp = transitionsPathFor({ stateDir, identityHash: id });
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function readSessionByHash({ stateDir = defaultStateDir(), identityHash: id }) {
  const sp = path.join(stateDir, 'sessions', `${id}.json`);
  return readSessionRecord(sp);
}

function newLoopToken({ identityHash: id, sessionPath }) {
  return createHash('sha256')
    .update(`${CONTROL_LOOP_SCHEMA_VERSION}|${id}|${sessionPath}|${randomUUID()}`)
    .digest('hex');
}

export function bindLoop({ sessionPath, identityHash: id, stateDir = defaultStateDir(), now = () => new Date().toISOString() } = {}) {
  if (typeof sessionPath !== 'string' || !sessionPath) return fail('MISSING_SESSION_PATH');
  if (typeof id !== 'string' || !id) return fail('MISSING_IDENTITY_HASH');
  const token = newLoopToken({ identityHash: id, sessionPath });

  function transition({ from, to, reason = null, evidence = null, extras = {} }) {
    if (!ALLOWED_TRANSITIONS[from] || !ALLOWED_TRANSITIONS[from].has(to)) {
      return fail('ILLEGAL_TRANSITION', `from=${from} to=${to}`);
    }
    const record = {
      ts: now(), from, to, reason, evidence,
      identityHash: id, sessionPath, ...extras,
    };
    appendTransition({ stateDir, identityHash: id, record });
    return ok({ state: to, record });
  }

  function terminalize({ outcome, decision, dispatchOptions = {} }) {
    // Defense-in-depth: refuse unless THIS loop bound the session token first.
    const auth = assertTerminalizationAuthorized({ sessionPath, identityHash: id, presentedToken: token, stateDir });
    if (!auth.ok) return auth;
    if (typeof outcome !== 'string') return fail('MISSING_OUTCOME');
    if (outcome === 'COMPLETED' || outcome === 'FAILED') {
      return taskFinish({ sessionPath, outcome, dispatchOptions });
    }
    if (outcome === 'BLOCKED') {
      return taskBlock({ sessionPath, dispatchOptions });
    }
    return fail('INVALID_OUTCOME', `outcome=${outcome}`);
  }

  async function step({ name, from, to, run, reason = null, capture = 'ok' }) {
    const prior = readTransitions({ stateDir, identityHash: id });
    const last = prior[prior.length - 1];
    if (last && last.from === from && last.to === to) {
      return { ok: true, state: to, result: { resumed: true, record: last } };
    }
    if (!last || last.to !== from) {
      return fail('LOOP_NOT_AT_STATE', `expected last.to=${from}, got ${last && last.to}`);
    }
    let result;
    try {
      result = await run({ sessionPath });
    } catch (e) {
      transition({ from, to: 'BLOCKED', reason: `${name}:THREW`, evidence: String((e && e.message) || e) });
      return fail('STEP_THREW', `${name}: ${(e && e.message) || e}`);
    }
    if (!result || result.ok !== true) {
      transition({ from, to: 'BLOCKED', reason: `${name}:FAIL`, evidence: result || null });
      return fail(`${name}_FAILED`, result);
    }
    transition({ from, to, reason, evidence: capture === 'full' ? result : (result[capture] ?? null) });
    return { ok: true, state: to, result };
  }

  return Object.freeze({
    schemaVersion: CONTROL_LOOP_SCHEMA_VERSION,
    identityHash: id,
    sessionPath,
    stateDir,
    token,
    states: LOOP_STATES,
    transition,
    terminalize,
    step,
    readTransitions: () => readTransitions({ stateDir, identityHash: id }),
  });
}

export async function runControlLoop({ sessionPath, identityHash: id, stateDir = defaultStateDir(), deps = {} } = {}) {
  const rs = readSessionByHash({ stateDir, identityHash: id });
  if (!rs.ok) return fail('SESSION_READ_FAILED', rs.reason || null);
  if (rs.session.repo !== CONTROL_LOOP_CANONICAL_REPO
      || rs.session.taskId !== `${CONTROL_LOOP_CANONICAL_REPO}#${rs.session.issueNumber}`) {
    return fail('IDENTITY_MISMATCH', `taskId=${rs.session.taskId} identityHash=${id}`);
  }
  if (rs.session.state === 'COMPLETED' || rs.session.state === 'FAILED' || rs.session.state === 'BLOCKED') {
    return fail('ALREADY_TERMINAL', rs.session.state);
  }
  const loop = bindLoop({ sessionPath, identityHash: id, stateDir });
  // Bind THIS loop's terminalize token into the canonical session record. The
  // guard inside loop.terminalize then refuses any terminal transition unless
  // this exact loop instance is bound — adapters and external scripts have no
  // access to the token.
  const bnd = bindTerminalizeTokenToSession({ sessionPath, identityHash: id, token: loop.token, stateDir });
  if (!bnd.ok) return fail('TERMINALIZE_BIND_FAILED', bnd.code);

  const prior = readTransitions({ stateDir, identityHash: id });
  if (prior.length === 0) {
    loop.transition({ from: 'ACCEPTED', to: 'ROUTED', reason: 'loop-bind', evidence: { boundAt: new Date().toISOString() } });
  }

  // ROUTED
  const router = deps.router || (() => ({ ok: false, code: 'NO_ROUTER' }));
  const routeR = await loop.step({
    name: 'route', from: 'ROUTED', to: 'EXECUTING', run: router, capture: 'value',
  }).catch((e) => ({ ok: false, code: 'ROUTE_THREW', detail: String((e && e.message) || e) }));
  if (!routeR.ok) return fail('ROUTE_FAILED', routeR.code || null);
  const routeValue = routeR.result.value;

  // EXECUTING
  const executor = deps.executor || (() => ({ ok: false, code: 'NO_EXECUTOR' }));
  const execR = await loop.step({
    name: 'execute', from: 'EXECUTING', to: 'VERIFYING',
    run: (ctx) => executor({ ...ctx, model: routeValue.model, executorKind: routeValue.executorKind }),
    capture: 'value',
  });
  if (!execR.ok) return fail('EXECUTE_FAILED', execR.code || null);
  const executionRecordPath = execR.result.value.executionRecordPath;

  // VERIFYING
  const verifier = deps.verifier || (() => ({ ok: false, code: 'NO_VERIFIER' }));
  const verifyR = await loop.step({
    name: 'verify', from: 'VERIFYING', to: 'PRE_REVIEWING',
    run: (ctx) => verifier({ ...ctx, executionRecordPath }),
    capture: 'value',
  });
  if (!verifyR.ok) return fail('VERIFY_FAILED', verifyR.code || null);
  const verifyReport = verifyR.result.value;

  // PRE_REVIEWING
  // reviewReadyDir is plumbed into the pre-review step the same way DELIVERING
  // (line ~298) uses it: the canonical review-ready projection must be
  // resolvable for Gemini pre-review; absent / stale / foreign packets fail
  // closed inside the pre-review adapter itself.
  const preReview = deps.preReview || (() => ({ ok: false, code: 'NO_PRE_REVIEW' }));
  const preR = await loop.step({
    name: 'preReview', from: 'PRE_REVIEWING', to: 'FINAL_REVIEWING',
    run: (ctx) => preReview({ ...ctx, report: verifyReport, reviewReadyDir: deps.reviewReadyDir ?? null }),
    capture: 'value',
  });
  if (!preR.ok) return fail('PRE_REVIEW_FAILED', preR.code || null);
  const preReviewValue = preR.result.value;

  // FINAL_REVIEWING
  const finalReview = deps.finalReview || (() => ({ ok: false, code: 'NO_FINAL_REVIEW' }));
  const finR = await loop.step({
    name: 'finalReview', from: 'FINAL_REVIEWING', to: 'DECIDING',
    run: (ctx) => finalReview({ ...ctx, report: verifyReport, preReview: preReviewValue }),
    capture: 'value',
  });
  if (!finR.ok) return fail('FINAL_REVIEW_FAILED', finR.code || null);
  const decision = finR.result.value;

  // DECIDING
  if (decision.verdict === 'REWORK') {
    const tw = loop.transition({ from: 'DECIDING', to: 'REWORK', reason: 'final-review-rework', evidence: decision });
    if (!tw.ok) return fail('TRANSITION_FAILED', tw.code);
    return ok({ state: 'REWORK', decision, loopToken: loop.token });
  }
  if (decision.verdict === 'BLOCKED') {
    loop.transition({ from: 'DECIDING', to: 'BLOCKED', reason: 'final-review-blocked', evidence: decision });
    const term = loop.terminalize({ outcome: 'BLOCKED', decision });
    return ok({ state: 'BLOCKED', terminalize: term, loopToken: loop.token });
  }

  // DELIVERING — REQUIRED READY_FOR_REVIEW notification obligation.
  // (1) canonical boundary transition DECIDING->DELIVERING;
  const tw = loop.transition({ from: 'DECIDING', to: 'DELIVERING', reason: 'ready-for-review-boundary', evidence: decision });
  if (!tw.ok) return fail('TRANSITION_FAILED', tw.code);
  // (2) required notification side-effect — owned by ControlLoop itself, never
  // by executor/model memory; idempotent via the dispatch evidence ledger
  // (only API_ACCEPTED dedupes; failed/not-attempted stay recoverable).
  // The message carries the canonical review-ready packet when resolvable;
  // an unresolvable packet degrades to status-only (documented deviation).
  const packet = packetPathFor({ sessionPath, reviewReadyDir: deps.reviewReadyDir ?? null });
  const ev = readinessNotificationEvidence({
    session: rs.session, stateDir, spawn: deps.telegramSpawn ?? null,
    configPath: deps.telegramConfigPath ?? null, note: decision && decision.verdict,
    packetPath: packet.ok ? packet.packetPath : null,
  });
  let evidence = ev.status === 'API_ACCEPTED'
    ? { notification: { status: ev.status, messageId: ev.messageId ?? null, recordsPath: ev.recordsPath ?? null, packet: packet.ok ? packet.filename : null } }
    : null;
  // (2b) transport dead -> deterministic bounded recovery from the persisted
  // ledger (only if a prior attempt left evidence; recovery never fabricates).
  if (!evidence && deps.telegramRecovery !== false) {
    const rec = recoverLifecycleEvent({
      session: rs.session, event: READY_FOR_REVIEW_EVENT, stateDir,
      ...(deps.telegramSpawn ? { spawn: deps.telegramSpawn } : {}),
      ...(deps.telegramConfigPath ? { configPath: deps.telegramConfigPath } : {}),
      note: decision && decision.verdict,
      documentPath: packet.ok ? packet.packetPath : null,
    });
    if (rec && rec.status === 'API_ACCEPTED') {
      evidence = { notification: { status: 'API_ACCEPTED', messageId: rec.messageId ?? null, recordsPath: rec.recordsPath ?? null, recovered: true, packet: packet.ok ? packet.filename : null } };
    } else if (rec) {
      evidence = { notification: { status: rec.status, reason: rec.reason ?? rec.error ?? null, recovery: rec.status === 'DELIVERY_FAILED' ? 'DELIVERY_FAILED' : 'NOT_RECOVERABLE', recordsPath: rec.recordsPath ?? ev.recordsPath ?? null } };
    }
  }
  // (3) delivery evidence gate — fail closed: without terminal evidence the
  // obligation is NOT satisfied and the loop must not continue to COMPLETED.
  if (!evidence || evidence.notification.status !== 'API_ACCEPTED') {
    return fail('DELIVER_FAILED', evidence || ev);
  }
  // (4) only then the optional delivery step and dependent continuation.
  if (deps.delivery) {
    const delR = await loop.step({
      name: 'deliver', from: 'DELIVERING', to: 'COMPLETED',
      run: (ctx) => deps.delivery({ ...ctx, decision, notification: evidence.notification }),
      capture: 'value',
    });
    if (!delR.ok) return fail('DELIVER_STEP_FAILED', delR.code || null);
  } else {
    loop.transition({ from: 'DELIVERING', to: 'COMPLETED', reason: 'notification-evidence-ok', evidence });
  }
  const term = loop.terminalize({ outcome: 'COMPLETED', decision });
  return ok({ state: 'COMPLETED', notification: evidence.notification, terminalize: term, loopToken: loop.token });
}

export function assertTerminalizationAuthorized({ sessionPath, identityHash: id, presentedToken, stateDir = defaultStateDir() }) {
  const rs = readSessionByHash({ stateDir, identityHash: id });
  if (!rs.ok) return fail('SESSION_READ_FAILED', rs.reason);
  const expected = rs.session.controlLoop && rs.session.controlLoop.terminalizeToken;
  if (!expected) return fail('NOT_CONTROL_LOOP_BOUND', 'session.controlLoop.terminalizeToken missing');
  if (typeof presentedToken !== 'string' || presentedToken !== expected) {
    return fail('TERMINALIZATION_TOKEN_MISMATCH', 'presented token does not match session-bound token');
  }
  return ok({ authorized: true, expected });
}

export function bindTerminalizeTokenToSession({ sessionPath, identityHash: id, token, stateDir = defaultStateDir(), now = () => new Date().toISOString() }) {
  const rs = readSessionByHash({ stateDir, identityHash: id });
  if (!rs.ok) return fail('SESSION_READ_FAILED', rs.reason);
  rs.session.controlLoop = rs.session.controlLoop || {};
  rs.session.controlLoop.terminalizeToken = token;
  rs.session.controlLoop.boundAt = now();
  rs.session.controlLoop.identityHash = id;
  const p = persistSessionRecord(sessionPath, rs.session);
  if (!p.ok) return fail('PERSIST_FAILED', p.detail);
  return ok({ bound: true });
}
