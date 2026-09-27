// tests/control-loop-router.test.mjs — Issue #244 (LH-01 + LH-02).
// Deterministic, 100% offline regression suite for the central Control-Loop
// Router: FSM transition atomicity, fail-closed payload/state validation,
// dynamic engine routing, timeout/retry/fallback dispatch policy, concurrent
// event conflict handling, and dangling-reference cleanup (reconcile).
// No external framework; plain node:test.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import {
  ROUTER_SCHEMA_VERSION,
  ROUTER_PHASES,
  ROUTER_ENGINES,
  ROUTER_ERROR_CODES,
  DEFAULT_ENGINE_FOR_PHASE,
  DEFAULT_FALLBACK_FOR_PHASE,
  MAX_ROUTE_RETRIES,
  DEFAULT_ROUTE_RETRIES_FOR_PHASE,
  validateTransitionEvent,
  resolveRouteForSession,
  canTransition,
  createControlLoopRouter,
  reconcileSessionRecord,
} from '../packages/control-loop/router.mjs';
import {
  ALLOWED_TRANSITIONS,
  LOOP_STATES,
  TERMINAL_STATES,
  appendTransition,
  readTransitions,
} from '../packages/control-loop/control-loop.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { readWin32ProcessStartTime } from '../packages/temp-hygiene/temp-hygiene.mjs';

// ---- fixtures -----------------------------------------------------------------
const HEAD = 'a'.repeat(40);
const BASE = 'f'.repeat(40);
const REPO = 'duongpdddic-droid/soc_brain';
const ISSUE = 244;

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'router-test-')); }
function sleep(ms) { return new Promise((r) => { setTimeout(r, ms); }); }

function mkSession(stateDir, overrides = {}) {
  const repo = overrides.repo || REPO;
  const issueNumber = overrides.issueNumber ?? ISSUE;
  const id = identityHash({ repo, issueNumber });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1',
    state: 'SESSION_ACTIVE',
    lifecycle: [],
    taskId: `${repo}#${issueNumber}`,
    repo,
    issueNumber,
    headSha: HEAD,
    baseSha: BASE,
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session, id };
}

function mkRouter(stateDir, { router: routerOpts = {}, sessionOverrides = {} } = {}) {
  const { sessionPath, id } = mkSession(stateDir, sessionOverrides);
  const router = createControlLoopRouter({ sessionPath, identityHash: id, stateDir, ...routerOpts });
  assert.notEqual(router.ok, false, `router construction must succeed: ${JSON.stringify(router)}`);
  return { router, sessionPath, id };
}

function readSession(sessionPath) { return JSON.parse(fs.readFileSync(sessionPath, 'utf8')); }

// Session file reads from a CONCURRENT writer race its truncate-then-write
// window, so a poller must treat an unparseable read as "not written yet".
function readSessionOrNull(sessionPath) {
  try { return JSON.parse(fs.readFileSync(sessionPath, 'utf8')); } catch { return null; }
}

function writeSession(sessionPath, mutate) {
  const s = readSession(sessionPath);
  mutate(s);
  fs.writeFileSync(sessionPath, `${JSON.stringify(s, null, 2)}\n`, 'utf8');
}

function setRouteMeta(sessionPath, route) { writeSession(sessionPath, (s) => { s.controlLoop = { ...(s.controlLoop || {}), route }; }); }

function ledger(stateDir, id) { return readTransitions({ stateDir, identityHash: id }); }

function routesOnDisk(router) {
  try { return fs.readdirSync(router.routesDir).filter((n) => n.endsWith('.json')); } catch { return []; }
}

// ---- real process identities (F1 / F3 rework) -------------------------------
// Ownership claims are judged against REAL pids and REAL immutable start times
// read from this machine (PowerShell snapshot), never fabricated values: a LIVE
// owner must actually survive, a dead one must actually be provable.
function selfIdentity() {
  const self = readWin32ProcessStartTime(process.pid);
  assert.ok(self && self.processStartTime !== null, 'this platform must expose an immutable process start time');
  return { pid: process.pid, processStartTime: self.processStartTime };
}

// A peer OS process that stays alive for the duration of `fn` (LIVE owner).
async function withLivePeer(fn) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore', windowsHide: true });
  try {
    const peer = readWin32ProcessStartTime(child.pid);
    assert.ok(peer && peer.processStartTime !== null, `start time must be observable for peer pid ${child.pid}`);
    await fn({ pid: child.pid, processStartTime: peer.processStartTime, child });
  } finally {
    try { child.kill(); } catch { /* already gone */ }
  }
}

// A pid whose incarnation is over (crash leftover). The recorded start time is
// from that dead incarnation, so a recycled pid can only read as REUSED — which
// is ALSO proven dead; reclaim may never depend on luck.
async function deadPeerIdentity() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
  await once(child, 'exit');
  return { pid: child.pid, processStartTime: 1 };
}

// Absolute file URL of the router module, for the cross-process holder script.
const ROUTER_URL = new URL('../packages/control-loop/router.mjs', import.meta.url).href;

// Every unhandled rejection during the suite is a hard failure (Issue #244).
const unhandledRejections = [];
process.on('unhandledRejection', (e) => { unhandledRejections.push(e); });

// ============================================================================
// A. module surface + single-source-of-truth checks
// ============================================================================
test('A. router surface: schema, phases, engine registry, FSM table parity with control-loop', () => {
  assert.equal(ROUTER_SCHEMA_VERSION, '1');
  assert.deepEqual([...ROUTER_PHASES], ['EXECUTE', 'PRE_REVIEW', 'FINAL_REVIEW', 'DELIVER']);
  assert.ok(Object.isFrozen(ROUTER_PHASES));
  assert.ok(Object.isFrozen(ROUTER_ENGINES));
  assert.ok(Object.isFrozen(ROUTER_ERROR_CODES));
  assert.equal(MAX_ROUTE_RETRIES, 3);

  for (const [name, engine] of Object.entries(ROUTER_ENGINES)) {
    assert.equal(typeof engine.role, 'string', name);
    if (engine.available === true) {
      assert.equal(typeof engine.transport, 'string', `${name} must declare its transport`);
    } else {
      assert.ok(engine.unavailableCode, `${name} must declare why it is unavailable`);
    }
  }
  for (const phase of ROUTER_PHASES) {
    assert.ok(ROUTER_ENGINES[DEFAULT_ENGINE_FOR_PHASE[phase]], `default engine for ${phase} must exist`);
    const fb = DEFAULT_FALLBACK_FOR_PHASE[phase];
    if (fb) assert.ok(ROUTER_ENGINES[fb], `fallback engine for ${phase} must exist`);
  }
  // EXECUTE must never carry an automatic second dispatch (post-execution rule).
  assert.equal(DEFAULT_FALLBACK_FOR_PHASE.EXECUTE, null);

  // The router validates against the CANONICAL table — no second drifting copy.
  for (const from of LOOP_STATES) {
    for (const to of LOOP_STATES) {
      assert.equal(canTransition(from, to), ALLOWED_TRANSITIONS[from].has(to), `${from}->${to}`);
    }
  }
  assert.ok(TERMINAL_STATES.has('COMPLETED') && TERMINAL_STATES.has('BLOCKED'));
  assert.ok(ROUTER_ERROR_CODES.includes('ROUTER_ILLEGAL_TRANSITION'));
  assert.ok(ROUTER_ERROR_CODES.includes('ROUTER_TRANSITION_CONFLICT'));

  // Pure validators are usable without any I/O.
  const good = validateTransitionEvent({ from: 'ACCEPTED', to: 'ROUTED', reason: 'ok' });
  assert.equal(good.ok, true);
  assert.equal(good.value.reason, 'ok');
});

// ============================================================================
// B. atomic transition: ledger + session projection stay in lockstep
// ============================================================================
test('B. atomic transition chain ACCEPTED->ROUTED->EXECUTING writes ledger AND session projection, releases lock', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir);

  const r1 = await router.transition({ from: 'ACCEPTED', to: 'ROUTED', reason: 'issue #244', route: { phase: 'EXECUTE', engine: 'opencode-cli' } });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const r2 = await router.transition({ from: 'ROUTED', to: 'EXECUTING' });
  assert.equal(r2.ok, true, JSON.stringify(r2));

  const records = ledger(stateDir, id);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].route, { phase: 'EXECUTE', engine: 'opencode-cli' }, 'route evidence rides on the edge it was issued for');
  assert.equal(records[1].from, 'ROUTED');
  assert.equal(records[1].to, 'EXECUTING');
  assert.equal(records[1].identityHash, id);
  assert.equal(records[1].router.schemaVersion, ROUTER_SCHEMA_VERSION);
  assert.equal(records[1].route, null);

  const session = readSession(sessionPath);
  assert.equal(session.controlLoop.state, 'EXECUTING');
  assert.equal(session.state, 'SESSION_ACTIVE');

  // No lock garbage left behind (LH-01 requirement).
  assert.equal(fs.existsSync(router.lockPath), false, 'router lock must be released');

  const st = router.state();
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.equal(st.value.sessionState, 'EXECUTING');
  assert.equal(st.value.ledger.tail.to, 'EXECUTING');
  assert.equal(st.value.terminal, false);
  assert.equal(st.value.lock.heldInProcess, false);
});

// ============================================================================
// C. illegal transitions: typed rejection, zero side effects
// ============================================================================
test('C. illegal transitions are rejected fail-closed with zero side effects', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir);
  const bytesBefore = fs.readFileSync(sessionPath, 'utf8');

  const illegal = await router.transition({ from: 'ACCEPTED', to: 'COMPLETED' });
  assert.equal(illegal.ok, false);
  assert.equal(illegal.code, 'ROUTER_ILLEGAL_TRANSITION');
  assert.deepEqual(illegal.detail.allowed, ['ROUTED', 'BLOCKED']);
  assert.equal(ledger(stateDir, id).length, 0, 'no ledger edge may be appended');
  assert.equal(fs.readFileSync(sessionPath, 'utf8'), bytesBefore, 'session must be byte-identical');

  assert.equal((await router.transition({ from: 'ACCEPTED', to: 'ROUTED' })).ok, true);
  const backEdge = await router.transition({ from: 'ROUTED', to: 'ACCEPTED' });
  assert.equal(backEdge.code, 'ROUTER_ILLEGAL_TRANSITION');
  assert.deepEqual(backEdge.detail.allowed, ['EXECUTING', 'BLOCKED']);
  assert.equal(ledger(stateDir, id).length, 1, 'only the legal edge exists');

  // Terminal states are truly terminal (BLOCKED may only be operator-unblocked).
  assert.deepEqual([...ALLOWED_TRANSITIONS.COMPLETED], []);
  assert.deepEqual([...ALLOWED_TRANSITIONS.BLOCKED], ['REWORK']);
});

// ============================================================================
// D + E. payload schema (malformed / missing / unknown)
// ============================================================================
test('D. empty, malformed and incomplete payloads fail closed with structured field errors', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir);
  const bytesBefore = fs.readFileSync(sessionPath, 'utf8');

  const cases = [
    null,
    undefined,
    [],
    'ACCEPTED->ROUTED',
    {},
    { to: 'ROUTED' },
    { from: 'ACCEPTED' },
    { from: 'ACCEPTED', to: 42 },
    { from: 'ACCEPTED', to: 'ROUTED', unexpected: 'field' },
    { from: 'ACCEPTED', to: 'ROUTED', reason: '   ' },
    { from: 'ACCEPTED', to: 'ROUTED', reason: 'x'.repeat(300) },
    { from: 'ACCEPTED', to: 'ROUTED', reason: 7 },
    { from: 'ACCEPTED', to: 'ROUTED', evidence: () => 'not-json' },
    { from: 'ACCEPTED', to: 'ROUTED', route: 'not-an-object' },
    { from: 'ACCEPTED', to: 'ROUTED', route: { phase: 'REVIEW' } },
  ];
  for (const payload of cases) {
    const r = await router.transition(payload);
    assert.equal(r.ok, false, `must reject: ${JSON.stringify(payload)}`);
    assert.equal(r.code, 'ROUTER_PAYLOAD_INVALID', `code for ${JSON.stringify(payload)}`);
    assert.ok(r.detail && Array.isArray(r.detail.errors) && r.detail.errors.length > 0, 'structured errors[] required');
    for (const e of r.detail.errors) {
      assert.equal(typeof e.field, 'string');
      assert.equal(typeof e.code, 'string');
      assert.equal(typeof e.message, 'string');
      assert.ok(ROUTER_ERROR_CODES.includes('ROUTER_PAYLOAD_INVALID'));
    }
  }
  assert.equal(ledger(stateDir, id).length, 0, 'no side effect from malformed payloads');
  assert.equal(fs.readFileSync(sessionPath, 'utf8'), bytesBefore, 'session must be byte-identical');
});

test('E. an undeclared FSM state is rejected as STATE_UNKNOWN before any write', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir);

  const r = await router.transition({ from: 'NIRVANA', to: 'ROUTED' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ROUTER_PAYLOAD_INVALID');
  const err = r.detail.errors.find((e) => e.field === 'from');
  assert.ok(err, 'field-level error expected');
  assert.equal(err.code, 'STATE_UNKNOWN');
  assert.equal(err.value, 'NIRVANA');

  const r2 = await router.transition({ from: 'ACCEPTED', to: 'DONE' });
  assert.equal(r2.code, 'ROUTER_PAYLOAD_INVALID');
  assert.ok(r2.detail.errors.some((e) => e.field === 'to' && e.code === 'STATE_UNKNOWN'));
  assert.equal(ledger(stateDir, id).length, 0);
  assert.equal(readSession(sessionPath).controlLoop, undefined, 'projection untouched');
});

// ============================================================================
// F + G. state validation before the switch (desync detection)
// ============================================================================
test('F. a stale session projection is detected fail-closed instead of silently overwritten', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir);
  assert.equal((await router.transition({ from: 'ACCEPTED', to: 'ROUTED' })).ok, true);
  assert.equal((await router.transition({ from: 'ROUTED', to: 'EXECUTING' })).ok, true);

  // Simulate a half-finished writer: projection moved ahead of the ledger.
  writeSession(sessionPath, (s) => { s.controlLoop.state = 'DECIDING'; });

  const r = await router.transition({ from: 'EXECUTING', to: 'VERIFYING' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ROUTER_SESSION_STATE_DESYNC');
  assert.equal(r.detail.expectedFrom, 'EXECUTING');
  assert.equal(r.detail.sessionState, 'DECIDING');
  assert.equal(r.detail.source, 'session.controlLoop.state');
  assert.equal(ledger(stateDir, id).length, 2, 'ledger untouched');
  assert.equal(readSession(sessionPath).controlLoop.state, 'DECIDING', 'no blind overwrite');
});

test('G. ledger tail mismatch and non-entry heads are rejected ROUTER_STATE_DESYNC', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir);
  assert.equal((await router.transition({ from: 'ACCEPTED', to: 'ROUTED' })).ok, true);

  // Projection claims EXECUTING while the ledger tail is still ROUTED.
  writeSession(sessionPath, (s) => { s.controlLoop.state = 'EXECUTING'; });
  const r = await router.transition({ from: 'EXECUTING', to: 'VERIFYING' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ROUTER_STATE_DESYNC');
  assert.equal(r.detail.ledgerTail, 'ACCEPTED->ROUTED');
  assert.equal(r.detail.source, 'ledger');

  // A non-entry move with NO ledger at all is also a desync.
  const fresh = mkRouter(mkStateDir());
  const r2 = await fresh.router.transition({ from: 'ROUTED', to: 'EXECUTING' });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'ROUTER_STATE_DESYNC');
  assert.equal(r2.detail.ledgerTail, null);
});

// ============================================================================
// H. concurrency: simultaneous router events must not double-apply
// ============================================================================
test('H. concurrent router events serialize: exactly one applies, the loser gets ROUTER_TRANSITION_CONFLICT', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir);
  assert.equal((await router.transition({ from: 'ACCEPTED', to: 'ROUTED' })).ok, true);

  const [a, b] = await Promise.all([
    router.transition({ from: 'ROUTED', to: 'EXECUTING', reason: 'event-A' }),
    router.transition({ from: 'ROUTED', to: 'BLOCKED', reason: 'event-B' }),
  ]);
  const wins = [a, b].filter((r) => r.ok === true);
  const losses = [a, b].filter((r) => r.ok === false);
  assert.equal(wins.length, 1, JSON.stringify([a, b]));
  assert.equal(losses.length, 1, 'exactly one event must lose');
  assert.equal(losses[0].code, 'ROUTER_TRANSITION_CONFLICT');
  assert.equal(losses[0].detail.expectedFrom, 'ROUTED');

  const records = ledger(stateDir, id);
  assert.equal(records.length, 2, 'exactly one new edge');
  assert.equal(records[1].to, wins[0].value.state, 'ledger matches the winner');
  assert.equal(readSession(sessionPath).controlLoop.state, wins[0].value.state);
  assert.equal(fs.existsSync(router.lockPath), false, 'lock released after contention');
});

// ============================================================================
// I + J. lock policy: bounded timeout (never broken) + age-based reclaim
// ============================================================================
test('I. F1: a LIVE foreign owner keeps its lock even when the lock far exceeds staleLockMs (age alone never reclaims)', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir, { router: { lockTimeoutMs: 80, lockRetryMs: 10, staleLockMs: 1_000 } });
  fs.mkdirSync(path.dirname(router.lockPath), { recursive: true });
  // A DIFFERENT ownership domain that is provably alive: our own identity
  // written directly, so the in-process holder table does not know it — this is
  // exactly what a peer router instance sees while ANOTHER instance dispatches.
  const foreign = { schemaVersion: '1', ...selfIdentity(), ownerToken: 'foreign-domain', at: new Date().toISOString() };
  fs.writeFileSync(router.lockPath, JSON.stringify(foreign), 'utf8');
  // Age FAR beyond the threshold: age must never buy a reclaim on its own (F1).
  const old = new Date(Date.now() - 300_000);
  fs.utimesSync(router.lockPath, old, old);
  const bytesBefore = fs.readFileSync(sessionPath, 'utf8');
  const lockBefore = fs.readFileSync(router.lockPath, 'utf8');

  const r = await router.transition({ from: 'ACCEPTED', to: 'ROUTED' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ROUTER_LOCK_TIMEOUT');
  assert.equal(r.detail.lockPath, router.lockPath);
  assert.equal(r.detail.liveness, 'LIVE', `a live owner must be reported, not destroyed: ${JSON.stringify(r.detail)}`);
  assert.equal(fs.readFileSync(router.lockPath, 'utf8'), lockBefore, 'the live lock must be byte-identical after the attempt');
  assert.equal(fs.existsSync(router.lockPath), true, 'a lock we do not own is never deleted');
  assert.equal(ledger(stateDir, id).length, 0, 'no ledger edge may be written while a live owner holds the lock');
  assert.equal(fs.readFileSync(sessionPath, 'utf8'), bytesBefore, 'no canonical mutation under a live lock');

  fs.rmSync(router.lockPath, { force: true });
});

test('J. F1: only a PROVEN-dead owner is reclaimed; an alive-but-unproven owner survives even with the age gate wide open', async () => {
  const stateDir = mkStateDir();
  // staleLockMs: 0 -> the age gate is fully open, so ONLY identity decides.
  const { router, id } = mkRouter(stateDir, { router: { staleLockMs: 0, lockTimeoutMs: 200, lockRetryMs: 10 } });
  fs.mkdirSync(path.dirname(router.lockPath), { recursive: true });

  // (a) crash leftover: the recorded identity can no longer exist -> reclaim,
  // and the reclaim is audited (not a silent age-based deletion).
  const dead = await deadPeerIdentity();
  fs.writeFileSync(router.lockPath, JSON.stringify({
    schemaVersion: '1', pid: dead.pid, processStartTime: dead.processStartTime, ownerToken: 'crash-leftover', at: new Date().toISOString(),
  }), 'utf8');
  const r = await router.transition({ from: 'ACCEPTED', to: 'ROUTED' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.lock.staleLockRemoved, true, 'reclaim must be audited');
  assert.ok(['PID_GONE', 'START_TIME_MISMATCH'].includes(r.value.lock.reclaimReason), JSON.stringify(r.value.lock));
  assert.equal(ledger(stateDir, id).length, 1);
  assert.equal(fs.existsSync(router.lockPath), false, 'lock released after the critical section');

  // (b) alive but unbindable identity (no recorded start time): age 300s > 0
  // still proves nothing about death -> the lock is kept, byte-identical.
  const unproven = JSON.stringify({ schemaVersion: '1', pid: process.pid, at: new Date().toISOString() });
  fs.writeFileSync(router.lockPath, unproven, 'utf8');
  const old = new Date(Date.now() - 300_000);
  fs.utimesSync(router.lockPath, old, old);

  const r2 = await router.transition({ from: 'ROUTED', to: 'EXECUTING' });
  assert.equal(r2.ok, false, 'an unproven-but-alive owner must never be reclaimed');
  assert.equal(r2.code, 'ROUTER_LOCK_TIMEOUT');
  assert.equal(r2.detail.liveness, 'UNPROVEN', JSON.stringify(r2.detail));
  assert.equal(fs.readFileSync(router.lockPath, 'utf8'), unproven, 'the unproven lock must survive byte-identical');
  assert.equal(ledger(stateDir, id).length, 1, 'no ledger edge from the blocked attempt');

  fs.rmSync(router.lockPath, { force: true });
});

// ============================================================================
// K + L. dynamic engine routing (metadata driven, fail-closed)
// ============================================================================
test('K. dynamic routing: declarative defaults and session-metadata overrides resolve per phase', () => {
  const stateDir = mkStateDir();
  const { router, sessionPath } = mkRouter(stateDir);

  const exec = router.resolveRoute({ phase: 'EXECUTE' });
  assert.equal(exec.ok, true, JSON.stringify(exec));
  assert.equal(exec.value.engine, 'opencode-cli');
  assert.equal(exec.value.executorKind, 'opencode');
  assert.equal(exec.value.transport, 'executor-launcher');
  assert.equal(exec.value.fallback, null, 'executor is never re-dispatched');
  assert.equal(exec.value.model, null);

  assert.equal(router.resolveRoute({ phase: 'PRE_REVIEW' }).value.engine, 'gemini-web2api');
  const final = router.resolveRoute({ phase: 'FINAL_REVIEW' });
  assert.equal(final.value.engine, 'gpt-web2api-copy');
  assert.equal(final.value.fallback, 'gpt-cwa');
  assert.equal(router.resolveRoute({ phase: 'DELIVER' }).value.engine, 'telegram-cli');

  // Session metadata re-routes the very same session (multi-agent selection).
  setRouteMeta(sessionPath, {
    schemaVersion: '1',
    finalReview: 'gpt-cwa',
    fallback: 'gpt-web2api-copy',
    model: 'gpt-5.6-sol',
    retries: 2,
    timeoutMs: 1234,
  });
  const rerouted = router.resolveRoute({ phase: 'FINAL_REVIEW' });
  assert.equal(rerouted.ok, true, JSON.stringify(rerouted));
  assert.equal(rerouted.value.engine, 'gpt-cwa');
  assert.equal(rerouted.value.fallback, 'gpt-web2api-copy');
  assert.equal(rerouted.value.model, 'gpt-5.6-sol');
  assert.equal(rerouted.value.retries, 2);
  assert.equal(rerouted.value.timeoutMs, 1234);

  // F2: the SAME metadata block that re-routes FINAL_REVIEW must NOT be able to
  // grant EXECUTE a second attempt — `retries` is a shared field and stays
  // pinned to 0 (the executor must never run twice).
  const exec2 = router.resolveRoute({ phase: 'EXECUTE' });
  assert.equal(exec2.ok, false, 'retries>0 must fail closed for EXECUTE, not be silently coerced');
  assert.equal(exec2.code, 'ROUTER_ROUTE_METADATA_INVALID');
  assert.equal(exec2.detail.errors.length, 1, JSON.stringify(exec2.detail.errors));
  assert.equal(exec2.detail.errors[0].field, 'controlLoop.route.retries');
  assert.equal(exec2.detail.errors[0].code, 'EXECUTE_RETRIES_NOT_ALLOWED');

  // Dropping the pin restores EXECUTE — still at zero retries, no fallback.
  setRouteMeta(sessionPath, { schemaVersion: '1', retries: 0 });
  const exec3 = router.resolveRoute({ phase: 'EXECUTE' });
  assert.equal(exec3.ok, true, JSON.stringify(exec3));
  assert.equal(exec3.value.engine, 'opencode-cli', 'unrelated phases keep their default');
  assert.equal(exec3.value.retries, 0);
  assert.equal(exec3.value.fallback, null);

  // The pure resolver is exported too (no disk needed).
  const pure = resolveRouteForSession({ session: { state: 'SESSION_ACTIVE' }, phase: 'EXECUTE' });
  assert.equal(pure.ok, true);
  assert.equal(pure.value.engine, 'opencode-cli');
  assert.equal(pure.value.retries, 0, 'EXECUTE defaults to exactly one attempt');
  assert.equal(pure.value.fallback, null, 'EXECUTE defaults to no fallback');
  assert.equal(pure.value.retries, DEFAULT_ROUTE_RETRIES_FOR_PHASE.EXECUTE);
});

test('L. route selection fails closed on unknown / role-mismatched / unavailable engines and bad metadata', () => {
  const stateDir = mkStateDir();
  const { router, sessionPath } = mkRouter(stateDir);

  const cases = [
    { phase: 'EXECUTE', route: { executor: 'does-not-exist' }, code: 'ROUTER_ENGINE_UNKNOWN' },
    { phase: 'EXECUTE', route: { executor: 'gemini-web2api' }, code: 'ROUTER_ENGINE_ROLE_MISMATCH' },
    { phase: 'EXECUTE', route: { executor: 'claude-cli' }, code: 'ROUTER_ENGINE_UNAVAILABLE' },
    { phase: 'FINAL_REVIEW', route: { finalReview: 'gpt-cdp-legacy' }, code: 'ROUTER_ENGINE_UNAVAILABLE' },
    { phase: 'FINAL_REVIEW', route: { finalReview: 'gemini-web2api' }, code: 'ROUTER_ENGINE_ROLE_MISMATCH' },
    { phase: 'EXECUTE', route: { retries: 99 }, code: 'ROUTER_ROUTE_METADATA_INVALID' },
    { phase: 'EXECUTE', route: { retries: -1 }, code: 'ROUTER_ROUTE_METADATA_INVALID' },
    { phase: 'EXECUTE', route: { timeoutMs: 0 }, code: 'ROUTER_ROUTE_METADATA_INVALID' },
    { phase: 'EXECUTE', route: { schemaVersion: '9' }, code: 'ROUTER_ROUTE_METADATA_INVALID' },
    { phase: 'EXECUTE', route: { unknownKey: 1 }, code: 'ROUTER_ROUTE_METADATA_INVALID' },
    { phase: 'EXECUTE', route: { fallback: 'opencode-cli' }, code: 'ROUTER_ROUTE_METADATA_INVALID' },
    { phase: 'FINAL_REVIEW', route: { fallback: 'does-not-exist' }, code: 'ROUTER_ENGINE_UNKNOWN' },
    { phase: 'EXECUTE', route: 'not-an-object', code: 'ROUTER_ROUTE_METADATA_INVALID' },
    { phase: 'EXECUTE', route: { model: 42 }, code: 'ROUTER_ROUTE_METADATA_INVALID' },
  ];
  for (const c of cases) {
    setRouteMeta(sessionPath, c.route);
    const r = router.resolveRoute({ phase: c.phase });
    assert.equal(r.ok, false, `must fail: ${JSON.stringify(c)}`);
    assert.equal(r.code, c.code, `code for ${JSON.stringify(c)}`);
    assert.ok(Array.isArray(r.detail.errors) && r.detail.errors.length > 0, JSON.stringify(c));
    assert.ok(r.detail.errors.every((e) => typeof e.field === 'string' && typeof e.code === 'string'));
  }

  // Unknown phase and non-active session are also fail-closed.
  setRouteMeta(sessionPath, undefined);
  const badPhase = router.resolveRoute({ phase: 'REVIEW' });
  assert.equal(badPhase.ok, false);
  assert.equal(badPhase.code, 'ROUTER_PHASE_INVALID');
  assert.deepEqual(badPhase.detail.phases, [...ROUTER_PHASES]);

  writeSession(sessionPath, (s) => { s.state = 'COMPLETED'; delete s.controlLoop; });
  const terminal = router.resolveRoute({ phase: 'EXECUTE' });
  assert.equal(terminal.code, 'ROUTER_SESSION_NOT_ACTIVE');
  assert.equal(terminal.detail.state, 'COMPLETED');

  const missing = router.resolveRoute({ phase: 'EXECUTE', sessionPath: path.join(stateDir, 'sessions', 'nope.json') });
  assert.equal(missing.code, 'ROUTER_SESSION_READ_FAILED');
});

// ============================================================================
// M + N. dispatch policy: timeout / retry / fallback
// ============================================================================
test('M. retry policy: primary exhausts its bounded budget, the declared fallback engine succeeds', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath } = mkRouter(stateDir);
  setRouteMeta(sessionPath, { retries: 1, timeoutMs: 2_000 });

  const calls = [];
  const dispatch = async ({ engine, attempt, isFallback, phase }) => {
    calls.push(`${phase}:${engine}#${attempt}:${isFallback ? 'fallback' : 'primary'}`);
    if (engine === 'gpt-web2api-copy') return { ok: false, code: 'REVIEW_TRANSPORT_BUSY' };
    return { ok: true, value: { verdict: 'PASS' } };
  };

  const r = await router.route({ phase: 'FINAL_REVIEW', dispatch });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.engine, 'gpt-cwa');
  assert.equal(r.value.isFallback, true);
  assert.equal(r.value.fallback, 'gpt-cwa');
  assert.deepEqual(calls, [
    'FINAL_REVIEW:gpt-web2api-copy#1:primary',
    'FINAL_REVIEW:gpt-web2api-copy#2:primary',
    'FINAL_REVIEW:gpt-cwa#1:fallback',
  ]);
  assert.equal(r.value.attempts.length, 3);
  assert.equal(r.value.attempts.filter((a) => a.ok).length, 1);
  assert.equal(r.value.result.verdict, 'PASS');

  // Durable dispatch evidence + transient session reference, lock released.
  const record = JSON.parse(fs.readFileSync(path.join(router.routesDir, `${r.value.routeId}.json`), 'utf8'));
  assert.equal(record.state, 'SETTLED');
  assert.equal(record.ok, true);
  assert.equal(record.usedEngine, 'gpt-cwa');
  assert.equal(record.attempts.length, 3);
  const session = readSession(sessionPath);
  assert.equal(session.controlLoop.router.routeId, r.value.routeId);
  assert.equal(session.controlLoop.router.state, 'SETTLED');
  assert.equal(session.controlLoop.router.ok, true);
  assert.equal(fs.existsSync(router.lockPath), false, 'lock released after dispatch');
});

test('N. fallback exhaustion and single-engine failure both fail closed with structured attempts', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath } = mkRouter(stateDir);
  setRouteMeta(sessionPath, { retries: 0, timeoutMs: 2_000 });
  const failing = () => ({ ok: false, code: 'REVIEW_TRANSPORT_DOWN' });

  const exhausted = await router.route({ phase: 'FINAL_REVIEW', dispatch: failing });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.code, 'ROUTER_FALLBACK_EXHAUSTED');
  assert.equal(exhausted.detail.attempts.length, 2, 'primary + fallback, no retries requested');
  assert.equal(exhausted.detail.lastCode, 'REVIEW_TRANSPORT_DOWN');
  assert.deepEqual(exhausted.detail.attempts.map((a) => a.engine), ['gpt-web2api-copy', 'gpt-cwa']);
  const record = JSON.parse(fs.readFileSync(path.join(router.routesDir, `${exhausted.detail.routeId}.json`), 'utf8'));
  assert.equal(record.state, 'SETTLED');
  assert.equal(record.ok, false);
  assert.equal(record.code, 'ROUTER_FALLBACK_EXHAUSTED');
  assert.equal(readSession(sessionPath).controlLoop.router.ok, false);

  // A phase with NO fallback reports the single-engine failure directly.
  const solo = await router.route({ phase: 'EXECUTE', dispatch: failing });
  assert.equal(solo.ok, false);
  assert.equal(solo.code, 'ROUTER_DISPATCH_FAILED');
  assert.equal(solo.detail.fallback, null);
  assert.equal(solo.detail.attempts.length, 1);
  assert.equal(solo.detail.lastCode, 'REVIEW_TRANSPORT_DOWN');
  assert.equal(fs.existsSync(router.lockPath), false, 'lock released on failure');
});

// ============================================================================
// O. per-attempt timeout + late rejection hygiene
// ============================================================================
test('O. dispatch timeout fail-closes per attempt, releases the lock and never leaks a rejection', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir);
  setRouteMeta(sessionPath, { retries: 0, timeoutMs: 40 });

  // Rejects LONG after the attempt budget: must be observed, never unhandled.
  const dispatch = () => new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error('late-transport-boom')), 120);
  });

  const r = await router.route({ phase: 'EXECUTE', dispatch });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ROUTER_DISPATCH_FAILED');
  assert.equal(r.detail.attempts.length, 1);
  assert.equal(r.detail.attempts[0].code, 'ROUTER_DISPATCH_TIMEOUT');
  assert.ok(r.detail.attempts[0].ms >= 35, `attempt must be bounded (got ${r.detail.attempts[0].ms}ms)`);

  await sleep(160); // let the late rejection land
  assert.deepEqual(unhandledRejections, [], 'no unhandled rejection from a late-throwing dispatch');
  assert.equal(fs.existsSync(router.lockPath), false, 'timeout must not strand the lock');

  // The router stays usable: no stuck lock, ledger still authoritative.
  const t = await router.transition({ from: 'ACCEPTED', to: 'ROUTED' });
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.equal(ledger(stateDir, id).length, 1);
});

// ============================================================================
// P + Q. fail-closed dispatch surface
// ============================================================================
test('P. a route without an injected dispatch is ENGINE_NOT_WIRED — never a fabricated success', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath } = mkRouter(stateDir);

  const r = await router.route({ phase: 'EXECUTE' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ROUTER_ENGINE_NOT_WIRED');
  assert.equal(r.detail.attempts[0].code, 'ROUTER_ENGINE_NOT_WIRED');
  assert.equal(r.detail.attempts[0].engine, 'opencode-cli');

  const record = JSON.parse(fs.readFileSync(path.join(router.routesDir, `${r.detail.routeId}.json`), 'utf8'));
  assert.equal(record.state, 'SETTLED');
  assert.equal(record.ok, false);
  assert.equal(record.code, 'ROUTER_ENGINE_NOT_WIRED');
  assert.equal(readSession(sessionPath).controlLoop.router.state, 'SETTLED');
  assert.equal(fs.existsSync(router.lockPath), false);
});

test('Q. an unknown phase never acquires the lock or writes a route record', async () => {
  const stateDir = mkStateDir();
  const { router } = mkRouter(stateDir);

  const r = await router.route({ phase: 'REVIEW' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ROUTER_PHASE_INVALID');
  assert.equal(fs.existsSync(router.lockPath), false, 'no lock may be taken');
  assert.deepEqual(routesOnDisk(router), [], 'no route record may be written');
});

// ============================================================================
// R + S + S2. LH-01 dangling-reference cleanup
// ============================================================================
test('R. LH-01: reconcile after the loop terminates clears every dangling reference and resyncs state', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir);

  // A real dispatch leaves a SETTLED route record + transient session ref.
  const routed = await router.route({ phase: 'EXECUTE', dispatch: () => ({ ok: true, value: { executorKind: 'opencode' } }) });
  assert.equal(routed.ok, true, JSON.stringify(routed));
  assert.ok(readSession(sessionPath).controlLoop.router, 'transient ref present during the run');
  assert.deepEqual(routesOnDisk(router), [`${routed.value.routeId}.json`]);

  // Full loop: ACCEPTED ... -> COMPLETED.
  const chain = [
    ['ACCEPTED', 'ROUTED'], ['ROUTED', 'EXECUTING'], ['EXECUTING', 'VERIFYING'],
    ['VERIFYING', 'PRE_REVIEWING'], ['PRE_REVIEWING', 'FINAL_REVIEWING'],
    ['FINAL_REVIEWING', 'DECIDING'], ['DECIDING', 'DELIVERING'], ['DELIVERING', 'COMPLETED'],
  ];
  for (const [from, to] of chain) {
    const r = await router.transition({ from, to, reason: `chain ${to}` });
    assert.equal(r.ok, true, `${from}->${to}: ${JSON.stringify(r)}`);
  }
  // Crash-shaped drift: the projection lags the authoritative ledger tail.
  writeSession(sessionPath, (s) => { s.controlLoop.state = 'DELIVERING'; });

  const rec = await router.reconcile({ reason: 'loop-terminated' });
  assert.equal(rec.ok, true, JSON.stringify(rec));
  const kinds = rec.value.actions.map((a) => a.kind);
  assert.ok(kinds.includes('STATE_RESYNCED'), JSON.stringify(rec.value.actions));
  assert.ok(kinds.includes('ROUTE_REF_CLEARED'));
  assert.ok(kinds.includes('ROUTE_RECORD_REMOVED'));
  assert.deepEqual(rec.value.dangling, [], 'nothing dangling may remain');
  assert.equal(rec.value.state.inSync, true);

  const session = readSession(sessionPath);
  assert.equal(session.controlLoop.state, 'COMPLETED');
  assert.equal(session.controlLoop.router, undefined, 'no transient route reference left on the session');
  assert.deepEqual(routesOnDisk(router), [], 'no route journal left behind');
  assert.equal(fs.existsSync(router.lockPath), false, 'no lock garbage');
  assert.equal(ledger(stateDir, id).length, chain.length, 'audit trail preserved');
});

test('S. LH-01: a session reference whose route record vanished is cleared as dangling', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir);
  assert.equal((await router.transition({ from: 'ACCEPTED', to: 'ROUTED' })).ok, true);

  writeSession(sessionPath, (s) => {
    s.controlLoop.router = {
      schemaVersion: '1', routeId: 'ghost-route-0001', phase: 'EXECUTE', engine: 'opencode-cli', state: 'IN_FLIGHT', at: new Date().toISOString(),
    };
  });

  const rec = await router.reconcile({ reason: 'dangling-ref' });
  assert.equal(rec.ok, true, JSON.stringify(rec));
  const cleared = rec.value.actions.find((a) => a.kind === 'ROUTE_REF_CLEARED');
  assert.ok(cleared, JSON.stringify(rec.value.actions));
  assert.equal(cleared.reason, 'RECORD_MISSING');
  assert.deepEqual(rec.value.dangling, []);
  assert.equal(readSession(sessionPath).controlLoop.router, undefined);
  assert.equal(readSession(sessionPath).controlLoop.state, 'ROUTED');
  assert.equal(rec.value.state.inSync, true);
  assert.equal(ledger(stateDir, id).length, 1, 'ledger untouched by cleanup');
});

test('S2. reconcile retains genuinely in-flight route records (no over-cleanup)', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir);
  fs.mkdirSync(router.routesDir, { recursive: true });
  const routeId = 'execute-inflight-1';
  const orphanId = 'final-review-inflight-2';
  const inFlight = (rid) => JSON.stringify({
    schemaVersion: '1', kind: 'RouterRouteRecord', routeId: rid, phase: 'EXECUTE', engine: 'opencode-cli', state: 'IN_FLIGHT', startedAt: new Date().toISOString(),
  }, null, 2);
  fs.writeFileSync(path.join(router.routesDir, `${routeId}.json`), inFlight(routeId), 'utf8');
  fs.writeFileSync(path.join(router.routesDir, `${orphanId}.json`), inFlight(orphanId), 'utf8');
  writeSession(sessionPath, (s) => {
    s.controlLoop = {
      state: 'EXECUTING',
      router: { schemaVersion: '1', routeId, phase: 'EXECUTE', engine: 'opencode-cli', state: 'IN_FLIGHT', at: new Date().toISOString() },
    };
  });
  // Ledger must agree so only the references are under review.
  appendTransition({ stateDir, identityHash: id, record: { ts: new Date().toISOString(), from: 'ACCEPTED', to: 'ROUTED', reason: 'seed' } });
  appendTransition({ stateDir, identityHash: id, record: { ts: new Date().toISOString(), from: 'ROUTED', to: 'EXECUTING', reason: 'seed' } });

  const rec = await router.reconcile({ reason: 'in-flight', staleRouteMs: 60_000 });
  assert.equal(rec.ok, true, JSON.stringify(rec));
  const kinds = rec.value.actions.map((a) => a.kind);
  assert.ok(kinds.includes('ROUTE_REF_RETAINED'), JSON.stringify(rec.value.actions));
  assert.ok(kinds.includes('ROUTE_RECORD_RETAINED'), JSON.stringify(rec.value.actions));
  assert.ok(readSession(sessionPath).controlLoop.router, 'in-flight ref must survive');
  assert.deepEqual(routesOnDisk(router).sort(), [`${routeId}.json`, `${orphanId}.json`].sort());
  assert.equal(rec.value.state.inSync, true);
});

// ============================================================================
// T. in-process lock ownership
// ============================================================================
test('T. reconcile never breaks an in-process lock holder: ROUTER_LOCK_BUSY, then full cleanup after release', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath } = mkRouter(stateDir);
  setRouteMeta(sessionPath, { retries: 0, timeoutMs: 5_000 });

  let releaseDispatch;
  const gate = new Promise((resolve) => { releaseDispatch = resolve; });
  const pending = router.route({
    phase: 'EXECUTE',
    dispatch: async () => { await gate; return { ok: true, value: { executorKind: 'opencode' } }; },
  });
  await sleep(30); // route() holds the lock across the dispatch await
  assert.ok(fs.existsSync(router.lockPath), 'dispatch must hold the router lock');

  // staleLockMs:0 would allow an age-based reclaim, but the holder is OURS.
  const blocked = await router.reconcile({ reason: 'during-dispatch', staleLockMs: 0 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'ROUTER_LOCK_BUSY');
  assert.equal(blocked.detail.heldInProcess, true);
  assert.ok(fs.existsSync(router.lockPath), 'in-process lock must survive');

  releaseDispatch();
  const routed = await pending;
  assert.equal(routed.ok, true, JSON.stringify(routed));
  assert.equal(fs.existsSync(router.lockPath), false, 'lock released when the dispatch settled');

  const cleaned = await router.reconcile({ reason: 'post-dispatch' });
  assert.equal(cleaned.ok, true, JSON.stringify(cleaned));
  assert.equal(readSession(sessionPath).controlLoop.router, undefined, 'SETTLED ref cleared');
  assert.deepEqual(routesOnDisk(router), [], 'route journal cleaned');
});

// ============================================================================
// U + V. conservative reconcile + standalone wrapper
// ============================================================================
test('U. reconcile without a ledger never invents history: orphan reported, session untouched', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath } = mkRouter(stateDir);
  writeSession(sessionPath, (s) => { s.controlLoop = { state: 'EXECUTING' }; });
  const bytesBefore = fs.readFileSync(sessionPath, 'utf8');

  const r = await router.reconcile({ reason: 'no-ledger' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.dangling.length, 1);
  assert.equal(r.value.dangling[0].kind, 'ORPHAN_SESSION_STATE_NO_LEDGER');
  assert.equal(r.value.dangling[0].state, 'EXECUTING');
  assert.equal(r.value.actions.filter((a) => a.kind === 'STATE_RESYNCED').length, 0);
  assert.equal(fs.readFileSync(sessionPath, 'utf8'), bytesBefore, 'no mutation without an authoritative ledger');
  assert.equal(r.value.state.inSync, false, 'reported truthfully, not papered over');
});

test('V. reconcileSessionRecord repairs a half-written (session-ahead) transition', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir);
  assert.equal((await router.transition({ from: 'ACCEPTED', to: 'ROUTED' })).ok, true);
  // Crash between the two writes: session already says EXECUTING, ledger does not.
  writeSession(sessionPath, (s) => { s.controlLoop.state = 'EXECUTING'; });

  const r = await reconcileSessionRecord({ sessionPath, identityHash: id, stateDir, reason: 'crash-recovery' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const resync = r.value.actions.find((a) => a.kind === 'STATE_RESYNCED');
  assert.ok(resync, JSON.stringify(r.value.actions));
  assert.equal(resync.from, 'EXECUTING');
  assert.equal(resync.to, 'ROUTED');
  assert.equal(r.value.state.inSync, true);
  assert.equal(readSession(sessionPath).controlLoop.state, 'ROUTED');
  assert.equal(ledger(stateDir, id).length, 1, 'audit trail is authoritative, never rewritten');
  assert.equal(fs.existsSync(router.lockPath), false);
});

// ============================================================================
// F1. lock ownership is proven by IDENTITY, never by age (rework findings)
// ============================================================================
test('F1a. two router domains over one canonical session: a long dispatch keeps its lock, the peer breaks nothing, and works after release', async () => {
  const stateDir = mkStateDir();
  // staleLockMs: 0 -> the age gate is wide open for BOTH domains, so anything
  // that still holds the lock must hold it on IDENTITY, not on freshness.
  const opts = { lockTimeoutMs: 60, lockRetryMs: 10, staleLockMs: 0 };
  const { router: routerA, sessionPath, id } = mkRouter(stateDir, { router: opts });
  const routerB = createControlLoopRouter({ sessionPath, identityHash: id, stateDir, ...opts });
  assert.notEqual(routerB.ok, false, `second domain must be constructible: ${JSON.stringify(routerB)}`);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = routerA.route({
    phase: 'EXECUTE',
    dispatch: async () => { await gate; return { ok: true, value: { ran: 1 } }; },
  });
  await sleep(60); // A is mid-dispatch, well past the (zero) stale threshold
  assert.equal(fs.existsSync(routerA.lockPath), true, 'A holds the lock across the await');
  assert.ok(routesOnDisk(routerA).length === 1, 'A journaled the in-flight dispatch');
  const lockBefore = fs.readFileSync(routerA.lockPath, 'utf8');
  const bytesBefore = fs.readFileSync(sessionPath, 'utf8');

  // (1)+(2)+(3) the second domain must not apply, must not break the lock and
  // must not mutate canonical state while A is still dispatching.
  const t = await routerB.transition({ from: 'ACCEPTED', to: 'ROUTED' });
  assert.equal(t.ok, false, `the loser must not apply: ${JSON.stringify(t)}`);
  assert.equal(t.code, 'ROUTER_LOCK_TIMEOUT');
  assert.equal(t.detail.heldInProcess, true, JSON.stringify(t.detail));
  const rc = await routerB.reconcile({ reason: 'peer-mid-dispatch' });
  assert.equal(rc.ok, false, JSON.stringify(rc));
  assert.equal(rc.code, 'ROUTER_LOCK_BUSY');
  assert.equal(rc.detail.heldInProcess, true, JSON.stringify(rc.detail));
  assert.equal(fs.readFileSync(routerA.lockPath, 'utf8'), lockBefore, 'the dispatch lock must be byte-identical');
  assert.equal(fs.readFileSync(sessionPath, 'utf8'), bytesBefore, 'canonical state must be untouched by the loser');
  assert.equal(ledger(stateDir, id).length, 0, 'the loser wrote no ledger edge');

  // (4) once A settles and releases, everything is normal again.
  release();
  const routed = await pending;
  assert.equal(routed.ok, true, JSON.stringify(routed));
  assert.equal(fs.existsSync(routerA.lockPath), false, 'A released the lock after settling');

  const after = await routerB.transition({ from: 'ACCEPTED', to: 'ROUTED' });
  assert.equal(after.ok, true, `the peer must work normally after release: ${JSON.stringify(after)}`);
  assert.equal(ledger(stateDir, id).length, 1);
  assert.equal(fs.existsSync(routerA.lockPath), false, 'lock released again');
});

test('F1b. F1 cross-process: a REAL peer process dispatching holds its lock (identity LIVE, never broken); once it dies the leftover is reclaimed on positive proof', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir, { router: { lockTimeoutMs: 120, lockRetryMs: 10, staleLockMs: 0 } });

  // A genuine other OS process runs the real router and dispatches with a
  // promise that never settles, so it owns the lock for the whole test.
  const holder = path.join(stateDir, 'peer-holder.mjs');
  fs.writeFileSync(holder, [
    `import { createControlLoopRouter } from ${JSON.stringify(ROUTER_URL)};`,
    'const [sessionPath, identityHash, stateDir] = process.argv.slice(2);',
    'const router = createControlLoopRouter({ sessionPath, identityHash, stateDir, lockTimeoutMs: 60_000, lockRetryMs: 10, staleLockMs: 0 });',
    "if (!router || router.ok === false) { console.error('holder-construct-failed', JSON.stringify(router)); process.exit(2); }",
    "const held = await router.route({ phase: 'EXECUTE', dispatch: () => new Promise(() => {}) });",
    "console.error('holder-unexpected-return', JSON.stringify(held)); process.exit(3);",
  ].join('\n'), 'utf8');
  const child = spawn(process.execPath, [holder, sessionPath, id, stateDir], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderrBuf = '';
  child.stderr.on('data', (d) => { stderrBuf += String(d); });

  try {
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(router.lockPath) && Date.now() < deadline) await sleep(20);
    assert.ok(fs.existsSync(router.lockPath), `the peer process must acquire the lock: ${stderrBuf}`);

    // The peer journals its dispatch (route record + transient session ref)
    // right AFTER taking the lock, so wait for that write to land before the
    // byte snapshot below — otherwise the snapshot races a legitimate write by
    // the lock's owner (this test's own read, not a mutation by our router).
    const refDeadline = Date.now() + 10_000;
    for (;;) {
      const cur = readSessionOrNull(sessionPath);
      if (cur && cur.controlLoop && cur.controlLoop.router) break;
      assert.ok(Date.now() < refDeadline, `the peer must journal its in-flight dispatch: ${stderrBuf}`);
      await sleep(20);
    }
    assert.equal(child.exitCode, null, `the peer must still be alive and dispatching: ${stderrBuf}`);

    const peerLock = fs.readFileSync(router.lockPath, 'utf8');
    const peerOwner = JSON.parse(peerLock);
    assert.equal(peerOwner.pid, child.pid, 'the lock is attributed to the peer process');
    const bytesBefore = fs.readFileSync(sessionPath, 'utf8');
    assert.ok(JSON.parse(bytesBefore).controlLoop?.router, 'the snapshot must be a complete session document');
    const ledgerBefore = ledger(stateDir, id);

    // Identity path (the peer is another process, not our holder table):
    const blocked = await router.transition({ from: 'ACCEPTED', to: 'ROUTED' });
    assert.equal(blocked.ok, false, JSON.stringify(blocked));
    assert.equal(blocked.code, 'ROUTER_LOCK_TIMEOUT');
    assert.equal(blocked.detail.liveness, 'LIVE', `a live peer must be classified LIVE: ${JSON.stringify(blocked.detail)}`);
    assert.equal(fs.readFileSync(router.lockPath, 'utf8'), peerLock, 'a LIVE peer lock is never destroyed or rewritten');

    const busy = await router.reconcile({ reason: 'peer-owns-lock' });
    assert.equal(busy.ok, false, JSON.stringify(busy));
    assert.equal(busy.code, 'ROUTER_LOCK_BUSY');
    assert.equal(busy.detail.liveness, 'LIVE', JSON.stringify(busy.detail));
    assert.equal(busy.detail.heldInProcess, false, 'the peer is a different process, not our table');

    assert.equal(fs.readFileSync(sessionPath, 'utf8'), bytesBefore, 'no canonical mutation while the peer owns the lock');
    assert.deepEqual(ledger(stateDir, id), ledgerBefore, 'no ledger edge while the peer owns the lock');

    // The peer dies: bounded crash recovery — reclaim on POSITIVE dead proof.
    child.kill();
    await once(child, 'exit');
    const reclaimed = await router.transition({ from: 'ACCEPTED', to: 'ROUTED' });
    assert.equal(reclaimed.ok, true, `crash leftover must be recoverable: ${JSON.stringify(reclaimed)}`);
    assert.equal(reclaimed.value.lock.staleLockRemoved, true, 'the reclaim must be audited');
    assert.ok(['PID_GONE', 'START_TIME_MISMATCH'].includes(reclaimed.value.lock.reclaimReason), JSON.stringify(reclaimed.value.lock));
    assert.equal(ledger(stateDir, id).length, ledgerBefore.length + 1);
    assert.equal(fs.existsSync(router.lockPath), false, 'released after the critical section');
  } finally {
    try { child.kill(); } catch { /* already gone */ }
  }
});

// ============================================================================
// F2. the executor may never run a second time (rework findings)
// ============================================================================
test('F2-1. F2: with DEFAULT session metadata a failing EXECUTE dispatch is attempted exactly once', async () => {
  const stateDir = mkStateDir();
  const { router } = mkRouter(stateDir); // deliberately no controlLoop.route metadata
  const calls = [];
  const r = await router.route({
    phase: 'EXECUTE',
    dispatch: async ({ attempt, engine }) => { calls.push({ attempt, engine }); return { ok: false, code: 'EXECUTOR_CRASHED' }; },
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'ROUTER_DISPATCH_FAILED');
  assert.deepEqual(calls, [{ attempt: 1, engine: 'opencode-cli' }], `the executor must be dispatched exactly once: ${JSON.stringify(calls)}`);
  assert.equal(r.detail.attempts.length, 1, JSON.stringify(r.detail.attempts));
  assert.equal(r.detail.fallback, null, 'EXECUTE has no fallback engine');
  assert.equal(fs.existsSync(router.lockPath), false, 'lock released on failure');
});

test('F2-2. F2: an EXECUTE timeout with only timeoutMs overridden still dispatches exactly once', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath } = mkRouter(stateDir);
  setRouteMeta(sessionPath, { timeoutMs: 40 }); // `retries` omitted -> EXECUTE default 0
  const calls = [];
  const r = await router.route({
    phase: 'EXECUTE',
    dispatch: ({ attempt }) => { calls.push(attempt); return new Promise(() => {}); }, // only the budget can stop it
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'ROUTER_DISPATCH_FAILED');
  assert.equal(r.detail.attempts.length, 1, `a timeout may never buy a second attempt: ${JSON.stringify(r.detail.attempts)}`);
  assert.equal(r.detail.attempts[0].code, 'ROUTER_DISPATCH_TIMEOUT');
  assert.deepEqual(calls, [1], JSON.stringify(calls));
  assert.equal(fs.existsSync(router.lockPath), false, 'timeout must not strand the lock');
});

test('F2-3. F2: session metadata requesting retries for EXECUTE fails closed BEFORE any dispatch', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath } = mkRouter(stateDir);
  setRouteMeta(sessionPath, { retries: 1, timeoutMs: 500 });

  const resolveFail = router.resolveRoute({ phase: 'EXECUTE' });
  assert.equal(resolveFail.ok, false, JSON.stringify(resolveFail));
  assert.equal(resolveFail.code, 'ROUTER_ROUTE_METADATA_INVALID');
  assert.equal(resolveFail.detail.errors[0].field, 'controlLoop.route.retries');
  assert.equal(resolveFail.detail.errors[0].code, 'EXECUTE_RETRIES_NOT_ALLOWED');

  let calls = 0;
  const routed = await router.route({ phase: 'EXECUTE', dispatch: async () => { calls += 1; return { ok: true, value: {} }; } });
  assert.equal(routed.ok, false, JSON.stringify(routed));
  assert.equal(routed.code, 'ROUTER_ROUTE_METADATA_INVALID');
  assert.equal(calls, 0, 'an invalid route must never reach the executor');
  assert.equal(fs.existsSync(router.lockPath), false, 'no lock is stranded by a rejected route');
  assert.deepEqual(routesOnDisk(router), [], 'no journal is written for a rejected route');
});

test('F2-4. F2: EXECUTE resolves to a single engine with NO fallback; other phases keep their retry budget', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath } = mkRouter(stateDir);

  const exec = router.resolveRoute({ phase: 'EXECUTE' });
  assert.equal(exec.ok, true, JSON.stringify(exec));
  assert.equal(exec.value.retries, 0, 'one attempt, always');
  assert.equal(exec.value.fallback, null, 'no second engine exists for the executor role');
  assert.equal(exec.value.fallbackTransport, null);

  // A session cannot attach any executor-role fallback: a registered-but-
  // unavailable engine fails closed, a cross-role engine keeps the EXECUTE
  // default (null) instead of smuggling in a second dispatch.
  setRouteMeta(sessionPath, { fallback: 'claude-cli' });
  const unavailable = router.resolveRoute({ phase: 'EXECUTE' });
  assert.equal(unavailable.ok, false, JSON.stringify(unavailable));
  assert.equal(unavailable.code, 'ROUTER_ENGINE_UNAVAILABLE');

  setRouteMeta(sessionPath, { fallback: 'gemini-web2api' });
  const crossRole = router.resolveRoute({ phase: 'EXECUTE' });
  assert.equal(crossRole.ok, true, JSON.stringify(crossRole));
  assert.equal(crossRole.value.fallback, null, 'EXECUTE can never acquire a fallback');

  setRouteMeta(sessionPath, { retries: 1, timeoutMs: 500 });
  const pre = router.resolveRoute({ phase: 'PRE_REVIEW' });
  assert.equal(pre.ok, true, JSON.stringify(pre));
  assert.equal(pre.value.retries, 1, 'review phases still honor their declared budget');
});

test('F2-5. F2: a late rejection after the EXECUTE timeout is observed — no unhandled rejection and no second dispatch', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath } = mkRouter(stateDir);
  setRouteMeta(sessionPath, { timeoutMs: 40 }); // `retries` omitted -> 0
  let calls = 0;
  const dispatch = () => {
    calls += 1;
    return new Promise((_, reject) => { setTimeout(() => reject(new Error('late-executor-boom')), 120); });
  };
  const r = await router.route({ phase: 'EXECUTE', dispatch });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.detail.attempts.length, 1, JSON.stringify(r.detail.attempts));
  assert.equal(r.detail.attempts[0].code, 'ROUTER_DISPATCH_TIMEOUT');

  await sleep(220); // let the late rejection land after route() already returned
  assert.equal(calls, 1, `the executor must never be dispatched a second time: ${calls}`);
  assert.deepEqual(unhandledRejections.map((e) => String((e && e.message) || e)), [], 'no unhandled rejection from a late-throwing dispatch');
  assert.equal(fs.existsSync(router.lockPath), false, 'lock released');
});

test('F2-6. F2: the very same metadata that is illegal for EXECUTE still drives a full retry budget for a review phase', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath } = mkRouter(stateDir);
  setRouteMeta(sessionPath, { retries: 2, timeoutMs: 500 });

  const calls = [];
  const fr = await router.route({
    phase: 'FINAL_REVIEW',
    dispatch: async ({ attempt, isFallback }) => {
      calls.push(`${isFallback ? 'fb' : 'p'}#${attempt}`);
      return isFallback ? { ok: true, value: { verdict: 'PASS' } } : { ok: false, code: 'REVIEW_TRANSPORT_BUSY' };
    },
  });
  assert.equal(fr.ok, true, JSON.stringify(fr));
  assert.deepEqual(calls, ['p#1', 'p#2', 'p#3', 'fb#1'], 'non-EXECUTE phases keep their bounded retry + fallback budget');

  const exec = router.resolveRoute({ phase: 'EXECUTE' });
  assert.equal(exec.ok, false, 'the identical metadata is still rejected for EXECUTE');
  assert.equal(exec.detail.errors[0].code, 'EXECUTE_RETRIES_NOT_ALLOWED');
});

// ============================================================================
// F3. IN_FLIGHT route journals are only destroyed on positive dead proof
// ============================================================================
function seedInFlight({ stateDir, router, sessionPath, id, routeId, owner, startedAt }) {
  fs.mkdirSync(router.routesDir, { recursive: true });
  const started = startedAt || new Date().toISOString();
  const record = {
    schemaVersion: '1',
    kind: 'RouterRouteRecord',
    routeId,
    identityHash: id,
    phase: 'EXECUTE',
    engine: 'opencode-cli',
    fallback: null,
    state: 'IN_FLIGHT',
    startedAt: started,
    ...(owner ? { owner } : {}),
  };
  fs.writeFileSync(path.join(router.routesDir, `${routeId}.json`), JSON.stringify(record, null, 2), 'utf8');
  writeSession(sessionPath, (s) => {
    s.controlLoop = {
      state: 'EXECUTING',
      router: { schemaVersion: '1', routeId, phase: 'EXECUTE', engine: 'opencode-cli', state: 'IN_FLIGHT', at: started },
    };
  });
  appendTransition({ stateDir, identityHash: id, record: { ts: new Date().toISOString(), from: 'ACCEPTED', to: 'ROUTED', reason: 'seed' } });
  appendTransition({ stateDir, identityHash: id, record: { ts: new Date().toISOString(), from: 'ROUTED', to: 'EXECUTING', reason: 'seed' } });
}

test('F3-1. F3: an IN_FLIGHT record far past staleRouteMs whose owner is provably LIVE is RETAINED (age never authorizes a delete)', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir);
  const routeId = 'execute-inflight-live-1';
  seedInFlight({
    stateDir, router, sessionPath, id, routeId,
    owner: selfIdentity(),
    startedAt: new Date(Date.now() - 600_000).toISOString(), // 10 minutes in flight
  });
  const bytesBefore = fs.readFileSync(sessionPath, 'utf8');

  const r = await router.reconcile({ reason: 'stale-but-live', staleRouteMs: 60_000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  const refAction = r.value.actions.find((a) => a.kind === 'ROUTE_REF_RETAINED');
  assert.ok(refAction, JSON.stringify(r.value.actions));
  assert.equal(refAction.liveness, 'LIVE', JSON.stringify(refAction));
  const recAction = r.value.actions.find((a) => a.kind === 'ROUTE_RECORD_RETAINED');
  assert.ok(recAction && recAction.liveness === 'LIVE', JSON.stringify(r.value.actions));
  assert.equal(
    r.value.actions.some((a) => a.kind === 'ROUTE_REF_CLEARED' || a.kind === 'ROUTE_RECORD_REMOVED' || a.kind === 'ORPHAN_ROUTE_RECORD_REMOVED'),
    false,
    `nothing may be destroyed: ${JSON.stringify(r.value.actions)}`,
  );
  assert.deepEqual(routesOnDisk(router), [`${routeId}.json`], 'the journal must survive');
  assert.ok(readSession(sessionPath).controlLoop.router, 'the session ref must survive');
  assert.equal(fs.readFileSync(sessionPath, 'utf8'), bytesBefore, 'a retain-only pass never rewrites the session');
  const warn = (r.value.warnings || []).find((w) => w.kind === 'ROUTE_RECORD_AGE_UNCONFIRMED');
  assert.ok(warn, `age beyond the threshold must be reported, not acted on: ${JSON.stringify(r.value.warnings)}`);
  assert.equal(warn.liveness, 'LIVE');
  assert.equal(warn.staleRouteMs, 60_000);
  assert.equal(r.value.state.inSync, true, 'projection still matches the ledger tail');
  assert.equal(ledger(stateDir, id).length, 2, 'the audit trail is untouched');
});

test('F3-2. F3: an IN_FLIGHT record whose recorded owner is provably gone is cleaned up (ref + journal) with an audited reason', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir);
  const routeId = 'execute-inflight-crash-1';
  const dead = await deadPeerIdentity();
  seedInFlight({ stateDir, router, sessionPath, id, routeId, owner: { pid: dead.pid, processStartTime: dead.processStartTime } });

  const r = await router.reconcile({ reason: 'owner-proven-gone' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const cleared = r.value.actions.find((a) => a.kind === 'ROUTE_REF_CLEARED');
  assert.ok(cleared, JSON.stringify(r.value.actions));
  assert.equal(cleared.reason, 'OWNER_PROVEN_GONE', JSON.stringify(cleared));
  const removed = r.value.actions.find((a) => a.kind === 'ROUTE_RECORD_REMOVED');
  assert.ok(removed, JSON.stringify(r.value.actions));
  assert.equal(removed.reason, 'OWNER_PROVEN_GONE', JSON.stringify(removed));
  assert.equal(readSession(sessionPath).controlLoop.router, undefined, 'the transient ref is gone');
  assert.deepEqual(routesOnDisk(router), [], 'the crash-leftover journal is gone');
  assert.equal(r.value.state.inSync, true, 'projection still equals the ledger tail');
  assert.equal(readSession(sessionPath).controlLoop.state, 'EXECUTING', 'state projection untouched by cleanup');
  assert.equal(ledger(stateDir, id).length, 2, 'cleanup never rewrites the audit trail');
  assert.deepEqual(r.value.dangling, []);
});

test('F3-3. F3: SETTLED journals keep their cleanup semantics — settled + unreferenced is still removed', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir);
  fs.mkdirSync(router.routesDir, { recursive: true });
  const routeId = 'execute-settled-orphan-1';
  // Even a LIVE owner cannot save a finished journal: settled + unreferenced
  // means the reference was already cleared, so the record is pure residue.
  fs.writeFileSync(path.join(router.routesDir, `${routeId}.json`), JSON.stringify({
    schemaVersion: '1', kind: 'RouterRouteRecord', routeId, identityHash: id,
    phase: 'EXECUTE', engine: 'opencode-cli', fallback: null, state: 'SETTLED',
    ok: true, code: null, startedAt: new Date(Date.now() - 300_000).toISOString(),
    finishedAt: new Date().toISOString(),
    owner: selfIdentity(),
  }, null, 2), 'utf8');

  const r = await router.reconcile({ reason: 'settled-orphan' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const removed = r.value.actions.find((a) => a.kind === 'ORPHAN_ROUTE_RECORD_REMOVED');
  assert.ok(removed, JSON.stringify(r.value.actions));
  assert.equal(removed.reason, 'SETTLED_UNREFERENCED');
  assert.deepEqual(routesOnDisk(router), [], 'settled residue is cleaned');
  assert.equal(readSession(sessionPath).controlLoop, undefined, 'no ref was present');
  assert.equal(r.value.state.inSync, true, 'no ledger + no projection drift');
  assert.equal(ledger(stateDir, id).length, 0, 'cleanup never invents history');
});

test('F3-4. F3: projection + ledger stay canonical across a retain pass (byte-stable) and a cleanup pass (still in sync)', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir);
  const routeId = 'execute-inflight-consistency-1';
  seedInFlight({
    stateDir, router, sessionPath, id, routeId,
    owner: selfIdentity(),
    startedAt: new Date(Date.now() - 600_000).toISOString(),
  });
  const sessionBytes = fs.readFileSync(sessionPath, 'utf8');
  const ledgerBefore = ledger(stateDir, id);

  // (a) retain pass: age is irrelevant (staleRouteMs: 0), owner is LIVE.
  const retained = await router.reconcile({ reason: 'consistency-retain', staleRouteMs: 0 });
  assert.equal(retained.ok, true, JSON.stringify(retained));
  assert.equal(retained.value.state.inSync, true);
  assert.equal(fs.readFileSync(sessionPath, 'utf8'), sessionBytes, 'a retain pass rewrites nothing');
  assert.deepEqual(ledger(stateDir, id), ledgerBefore, 'the audit trail is immutable');
  assert.deepEqual(routesOnDisk(router), [`${routeId}.json`]);

  // (b) the dispatcher then crashes: swap in a proven-dead identity and the
  // same session must clean up without drifting from the ledger.
  const dead = await deadPeerIdentity();
  const recordPath = path.join(router.routesDir, `${routeId}.json`);
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  record.owner = { pid: dead.pid, processStartTime: dead.processStartTime };
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2), 'utf8');

  const cleaned = await router.reconcile({ reason: 'consistency-cleanup' });
  assert.equal(cleaned.ok, true, JSON.stringify(cleaned));
  assert.equal(cleaned.value.state.inSync, true, 'projection still equals the ledger tail');
  assert.equal(readSession(sessionPath).controlLoop.state, 'EXECUTING', 'state projection unchanged');
  assert.equal(readSession(sessionPath).controlLoop.router, undefined, 'transient ref cleared');
  assert.deepEqual(routesOnDisk(router), [], 'journal cleaned');
  assert.deepEqual(ledger(stateDir, id), ledgerBefore, 'the audit trail is still immutable');
  assert.deepEqual(cleaned.value.dangling, [], 'nothing left dangling');
  assert.equal((cleaned.value.warnings || []).some((w) => w.kind === 'ROUTE_RECORD_REMOVE_FAILED'), false, 'no cleanup failure');
});

// ============================================================================
// W. suite-level hygiene
// ============================================================================
test('W. the router suite produced zero unhandled rejections', async () => {
  await sleep(50);
  assert.deepEqual(unhandledRejections.map((e) => String((e && e.message) || e)), []);
});
