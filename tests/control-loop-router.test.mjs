// tests/control-loop-router.test.mjs — Issue #244 (LH-01 + LH-02).
// Deterministic, 100% offline regression suite for the central Control-Loop
// Router: FSM transition atomicity, fail-closed payload/state validation,
// dynamic engine routing, timeout/retry/fallback dispatch policy, concurrent
// event conflict handling, and dangling-reference cleanup (reconcile).
// No external framework; plain node:test.

import { test, before, after } from 'node:test';
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
import { createSessionAuthority } from '../packages/session-authority/authority-server.mjs';
import { admitSession, assertAdmissionFence, closeSessionAdmission, ownIncarnation, releaseAdmission, setSessionAdmissionMode } from '../packages/session-authority/guard.mjs';

// ---- fixtures -----------------------------------------------------------------
const HEAD = 'a'.repeat(40);
const BASE = 'f'.repeat(40);
const REPO = 'duongpdddic-droid/soc_brain';
const ISSUE = 244;
const AUTH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'router-authority-'));
const PIPE_PATH = process.platform === 'win32'
  ? `\\\\.\\pipe\\router-test-${process.pid}-${Date.now()}`
  : path.join(AUTH_ROOT, 'authority.sock');
let authority;
let admittedPath = null;
let admittedId = null;

before(async () => {
  setSessionAdmissionMode('required');
  authority = createSessionAuthority({ pipePath: PIPE_PATH, bindLockPath: path.join(AUTH_ROOT, 'legacy-bind.lock') });
  const started = await authority.start();
  assert.equal(started.ok, true, JSON.stringify(started));
});

after(async () => {
  if (admittedPath) await releaseAdmission({ sessionPath: admittedPath, identityHash: admittedId });
  await closeSessionAdmission();
  if (authority) await authority.stop();
  setSessionAdmissionMode('off');
  fs.rmSync(AUTH_ROOT, { recursive: true, force: true });
});

async function ensureAdmitted(sessionPath, id) {
  if (admittedPath === sessionPath && assertAdmissionFence({ sessionPath, identityHash: id }).ok) return;
  if (admittedPath) await releaseAdmission({ sessionPath: admittedPath, identityHash: admittedId });
  admittedPath = null;
  admittedId = null;
  const r = await admitSession({ sessionPath, identityHash: id, owner: ownIncarnation(), pipePath: PIPE_PATH });
  assert.equal(r.ok, true, JSON.stringify(r));
  admittedPath = sessionPath;
  admittedId = id;
}

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
  const raw = createControlLoopRouter({ sessionPath, identityHash: id, stateDir, ...routerOpts });
  assert.notEqual(raw.ok, false, `router construction must succeed: ${JSON.stringify(raw)}`);
  // Existing FSM/reconcile cases exercise a REAL admission, never inject a
  // fake fence into production code. Direct-API denial is tested separately.
  // createControlLoopRouter freezes its public object. A Proxy cannot replace
  // read-only, non-configurable methods (ES Proxy invariant), so make a plain
  // test fixture wrapper while retaining the actual production methods.
  const router = {
    ...raw,
    transition: async (...args) => { await ensureAdmitted(sessionPath, id); return raw.transition(...args); },
    route: async (...args) => { await ensureAdmitted(sessionPath, id); return raw.route(...args); },
    reconcile: async (...args) => { await ensureAdmitted(sessionPath, id); return raw.reconcile(...args); },
  };
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
test('I. router rejects mutation without admission and never creates a disk lock', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir);
  if (admittedPath) await releaseAdmission({ sessionPath: admittedPath, identityHash: admittedId });
  admittedPath = null;
  admittedId = null;
  const bytesBefore = fs.readFileSync(sessionPath, 'utf8');
  const direct = createControlLoopRouter({ sessionPath, identityHash: id, stateDir });
  const r = await direct.transition({ from: 'ACCEPTED', to: 'ROUTED' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ROUTER_ADMISSION_LOST');
  assert.equal(fs.existsSync(router.lockPath), false);
  assert.equal(ledger(stateDir, id).length, 0);
  assert.equal(fs.readFileSync(sessionPath, 'utf8'), bytesBefore);
});

test('J. router ignores historical lock artifacts and delegates cross-process ownership to authority', async () => {
  const stateDir = mkStateDir();
  const { router, id } = mkRouter(stateDir);
  fs.mkdirSync(path.dirname(router.lockPath), { recursive: true });
  fs.writeFileSync(router.lockPath, 'legacy-lock-must-not-be-touched');
  const r = await router.transition({ from: 'ACCEPTED', to: 'ROUTED' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(ledger(stateDir, id).length, 1);
  assert.equal(fs.readFileSync(router.lockPath, 'utf8'), 'legacy-lock-must-not-be-touched');
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
  await ensureAdmitted(sessionPath, id);
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
  const { router, sessionPath, id } = mkRouter(stateDir);
  await ensureAdmitted(sessionPath, id);
  setRouteMeta(sessionPath, { retries: 0, timeoutMs: 5_000 });

  let releaseDispatch;
  const gate = new Promise((resolve) => { releaseDispatch = resolve; });
  const pending = router.route({
    phase: 'EXECUTE',
    dispatch: async () => { await gate; return { ok: true, value: { executorKind: 'opencode' } }; },
  });
  await sleep(30); // route() holds the lock across the dispatch await
  assert.equal(router.state().value.lock.heldInProcess, true, 'dispatch holds the in-process lock');

  // staleLockMs:0 would allow an age-based reclaim, but the holder is OURS.
  const blocked = await router.reconcile({ reason: 'during-dispatch', staleLockMs: 0 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'ROUTER_LOCK_BUSY');
  assert.equal(blocked.detail.heldInProcess, true);
  assert.equal(router.state().value.lock.heldInProcess, true, 'in-process lock must survive');

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
  await ensureAdmitted(sessionPath, id);
  const routerB = createControlLoopRouter({ sessionPath, identityHash: id, stateDir, ...opts });
  assert.notEqual(routerB.ok, false, `second domain must be constructible: ${JSON.stringify(routerB)}`);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = routerA.route({
    phase: 'EXECUTE',
    dispatch: async () => { await gate; return { ok: true, value: { ran: 1 } }; },
  });
  await sleep(60); // A is mid-dispatch, well past the (zero) stale threshold
  assert.equal(routerA.state().value.lock.heldInProcess, true, 'A holds the lock across the await');
  assert.ok(routesOnDisk(routerA).length === 1, 'A journaled the in-flight dispatch');
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
  assert.equal(fs.existsSync(routerA.lockPath), false, 'router never creates a disk lock');
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

test('F1b. release during a dispatch revokes the fence before settlement', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir);
  await ensureAdmitted(sessionPath, id);
  let finish;
  let entered;
  const inside = new Promise((resolve) => { entered = resolve; });
  const waiting = new Promise((resolve) => { finish = resolve; });
  const pending = router.route({ phase: 'EXECUTE', dispatch: async () => {
    entered();
    await waiting;
    return { ok: true, value: { ran: true } };
  } });
  await inside;
  const journal = routesOnDisk(router);
  const sessionBytes = fs.readFileSync(sessionPath, 'utf8');
  const journalBytes = fs.readFileSync(path.join(router.routesDir, journal[0]), 'utf8');
  const ledgerBefore = ledger(stateDir, id);
  assert.equal((await releaseAdmission({ sessionPath, identityHash: id })).ok, true);
  admittedPath = null;
  admittedId = null;
  finish();
  const result = await pending;
  assert.equal(result.code, 'ROUTER_ADMISSION_LOST');
  assert.equal(fs.readFileSync(sessionPath, 'utf8'), sessionBytes);
  assert.equal(fs.readFileSync(path.join(router.routesDir, journal[0]), 'utf8'), journalBytes);
  assert.deepEqual(ledger(stateDir, id), ledgerBefore);
  assert.equal(fs.existsSync(router.lockPath), false);
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
async function seedInFlight({ stateDir, router, sessionPath, id, routeId, owner, startedAt }) {
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
  await ensureAdmitted(sessionPath, id);
  appendTransition({ stateDir, identityHash: id, record: { ts: new Date().toISOString(), from: 'ACCEPTED', to: 'ROUTED', reason: 'seed' } });
  appendTransition({ stateDir, identityHash: id, record: { ts: new Date().toISOString(), from: 'ROUTED', to: 'EXECUTING', reason: 'seed' } });
}

test('F3-1. F3: an IN_FLIGHT record far past staleRouteMs whose owner is provably LIVE is RETAINED (age never authorizes a delete)', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir);
  const routeId = 'execute-inflight-live-1';
  await seedInFlight({
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
  await seedInFlight({ stateDir, router, sessionPath, id, routeId, owner: { pid: dead.pid, processStartTime: dead.processStartTime } });

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
  await seedInFlight({
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

// Seed for terminal-loop scenarios: the ledger tail is already terminal and the
// session projection agrees with it (so no STATE_RESYNCED rewrite can mask a
// byte-stability assertion), while a transient ref still points at an
// IN_FLIGHT journal whose age far exceeds any stale threshold.
async function seedTerminalInFlight({ stateDir, router, sessionPath, id, routeId, owner, tailTo = 'COMPLETED' }) {
  fs.mkdirSync(router.routesDir, { recursive: true });
  const startedAt = new Date(Date.now() - 600_000).toISOString(); // 10 min in flight
  const record = {
    schemaVersion: '1',
    kind: 'RouterRouteRecord',
    routeId,
    identityHash: id,
    phase: 'EXECUTE',
    engine: 'opencode-cli',
    fallback: null,
    state: 'IN_FLIGHT',
    startedAt,
    ...(owner ? { owner } : {}),
  };
  fs.writeFileSync(path.join(router.routesDir, `${routeId}.json`), JSON.stringify(record, null, 2), 'utf8');
  writeSession(sessionPath, (s) => {
    s.controlLoop = {
      state: tailTo,
      router: { schemaVersion: '1', routeId, phase: 'EXECUTE', engine: 'opencode-cli', state: 'IN_FLIGHT', at: startedAt },
    };
  });
  await ensureAdmitted(sessionPath, id);
  appendTransition({ stateDir, identityHash: id, record: { ts: new Date().toISOString(), from: 'DECIDING', to: tailTo, reason: 'seed-terminal' } });
}

test('F3-5. F3 finding-2: a terminal ledger tail NEVER authorizes deleting an IN_FLIGHT journal whose owner is LIVE (even past staleRouteMs)', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir);
  const routeId = 'execute-inflight-terminal-live-1';
  await seedTerminalInFlight({ stateDir, router, sessionPath, id, routeId, owner: selfIdentity() });
  const sessionBytes = fs.readFileSync(sessionPath, 'utf8');
  const recordPath = path.join(router.routesDir, `${routeId}.json`);
  const recordBytes = fs.readFileSync(recordPath, 'utf8');
  const ledgerBefore = ledger(stateDir, id);

  const r = await router.reconcile({ reason: 'terminal-but-live', staleRouteMs: 60_000 });
  assert.equal(r.ok, true, JSON.stringify(r));

  const destroyed = r.value.actions.filter((a) => a.kind === 'ROUTE_REF_CLEARED' || a.kind === 'ROUTE_RECORD_REMOVED' || a.kind === 'ORPHAN_ROUTE_RECORD_REMOVED');
  assert.deepEqual(destroyed, [], `terminal must not authorize a delete: ${JSON.stringify(r.value.actions)}`);
  const refA = r.value.actions.find((a) => a.kind === 'ROUTE_REF_RETAINED');
  assert.ok(refA, JSON.stringify(r.value.actions));
  assert.equal(refA.liveness, 'LIVE', JSON.stringify(refA));
  const recA = r.value.actions.find((a) => a.kind === 'ROUTE_RECORD_RETAINED');
  assert.ok(recA && recA.liveness === 'LIVE', JSON.stringify(r.value.actions));

  assert.equal(fs.readFileSync(sessionPath, 'utf8'), sessionBytes, 'the ref bytes must be untouched');
  assert.equal(fs.readFileSync(recordPath, 'utf8'), recordBytes, 'the journal bytes must be untouched');
  const kinds = (r.value.warnings || []).map((w) => w.kind);
  assert.ok(kinds.includes('ROUTE_RECORD_AGE_UNCONFIRMED'), `age past threshold must be reported: ${JSON.stringify(r.value.warnings)}`);
  assert.ok(kinds.includes('ROUTE_REF_RETAINED_TERMINAL'), `terminal + alive dispatch must be reported: ${JSON.stringify(r.value.warnings)}`);
  const termWarn = r.value.warnings.find((w) => w.kind === 'ROUTE_REF_RETAINED_TERMINAL');
  assert.equal(termWarn.liveness, 'LIVE');
  assert.equal(r.value.state.inSync, true, 'projection still equals the terminal tail');
  assert.equal(readSession(sessionPath).controlLoop.state, 'COMPLETED', 'projection never rewritten');
  assert.deepEqual(ledger(stateDir, id), ledgerBefore, 'ledger untouched');
});

test('F3-6. F3 finding-2: terminal + UNPROVEN owner keeps both artifacts — death is never inferred from age or terminal state', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir);
  const routeId = 'execute-inflight-terminal-unproven-1';
  // pid alive, no recorded start time -> UNPROVEN (fail closed, never "dead").
  await seedTerminalInFlight({ stateDir, router, sessionPath, id, routeId, owner: { pid: process.pid } });
  const sessionBytes = fs.readFileSync(sessionPath, 'utf8');
  const recordPath = path.join(router.routesDir, `${routeId}.json`);
  const recordBytes = fs.readFileSync(recordPath, 'utf8');
  const ledgerBefore = ledger(stateDir, id);

  const r = await router.reconcile({ reason: 'terminal-unproven', staleRouteMs: 60_000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  const destroyed = r.value.actions.filter((a) => a.kind === 'ROUTE_REF_CLEARED' || a.kind === 'ROUTE_RECORD_REMOVED' || a.kind === 'ORPHAN_ROUTE_RECORD_REMOVED');
  assert.deepEqual(destroyed, [], `UNPROVEN must never be treated as dead: ${JSON.stringify(r.value.actions)}`);
  const refA = r.value.actions.find((a) => a.kind === 'ROUTE_REF_RETAINED');
  assert.ok(refA && refA.liveness === 'UNPROVEN', JSON.stringify(r.value.actions));
  const recA = r.value.actions.find((a) => a.kind === 'ROUTE_RECORD_RETAINED');
  assert.ok(recA && recA.liveness === 'UNPROVEN', JSON.stringify(r.value.actions));
  assert.equal(fs.readFileSync(sessionPath, 'utf8'), sessionBytes, 'the ref bytes must be untouched');
  assert.equal(fs.readFileSync(recordPath, 'utf8'), recordBytes, 'the journal bytes must be untouched');
  assert.ok((r.value.warnings || []).some((w) => w.kind === 'ROUTE_REF_RETAINED_TERMINAL' && w.liveness === 'UNPROVEN'), JSON.stringify(r.value.warnings));
  assert.equal(r.value.state.inSync, true);
  assert.deepEqual(ledger(stateDir, id), ledgerBefore, 'ledger untouched');
});

test('F3-7. F3 finding-2: terminal + IN_FLIGHT owner proven GONE/REUSED is deleted with the positive proof audited', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir);
  const routeId = 'execute-inflight-terminal-crash-1';
  const dead = await deadPeerIdentity();
  await seedTerminalInFlight({ stateDir, router, sessionPath, id, routeId, owner: { pid: dead.pid, processStartTime: dead.processStartTime } });
  const ledgerBefore = ledger(stateDir, id);

  const r = await router.reconcile({ reason: 'terminal-proven-gone' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const cleared = r.value.actions.find((a) => a.kind === 'ROUTE_REF_CLEARED');
  assert.ok(cleared, JSON.stringify(r.value.actions));
  assert.equal(cleared.reason, 'OWNER_PROVEN_GONE', `positive dead proof, not terminality: ${JSON.stringify(cleared)}`);
  assert.ok(['GONE', 'REUSED'].includes(cleared.liveness), JSON.stringify(cleared));
  assert.ok(typeof cleared.proof === 'string' && cleared.proof.length > 0, `the proof must be audited: ${JSON.stringify(cleared)}`);
  const removed = r.value.actions.find((a) => a.kind === 'ROUTE_RECORD_REMOVED');
  assert.ok(removed && removed.reason === 'OWNER_PROVEN_GONE' && removed.liveness === cleared.liveness, JSON.stringify(r.value.actions));
  assert.equal(readSession(sessionPath).controlLoop.router, undefined, 'ref cleared');
  assert.deepEqual(routesOnDisk(router), [], 'journal cleared');
  assert.equal(r.value.state.inSync, true);
  assert.equal(readSession(sessionPath).controlLoop.state, 'COMPLETED', 'projection agrees with the terminal tail');
  assert.deepEqual(ledger(stateDir, id), ledgerBefore, 'cleanup never rewrites the audit trail');
});

test('F3-8. F3 finding-2: SETTLED and missing journals keep their cleanup semantics on a terminal loop; ledger/projection never rewritten', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir);
  const settledId = 'execute-settled-terminal-1';
  fs.mkdirSync(router.routesDir, { recursive: true });
  fs.writeFileSync(path.join(router.routesDir, `${settledId}.json`), JSON.stringify({
    schemaVersion: '1', kind: 'RouterRouteRecord', routeId: settledId, identityHash: id,
    phase: 'EXECUTE', engine: 'opencode-cli', fallback: null, state: 'SETTLED', ok: true, code: null,
    startedAt: new Date(Date.now() - 600_000).toISOString(), finishedAt: new Date().toISOString(),
    owner: selfIdentity(), // a LIVE owner cannot save a finished journal
  }, null, 2), 'utf8');
  writeSession(sessionPath, (s) => {
    s.controlLoop = {
      state: 'COMPLETED',
      router: { schemaVersion: '1', routeId: settledId, phase: 'EXECUTE', engine: 'opencode-cli', state: 'SETTLED', at: new Date().toISOString() },
    };
  });
  await ensureAdmitted(sessionPath, id);
  appendTransition({ stateDir, identityHash: id, record: { ts: new Date().toISOString(), from: 'DECIDING', to: 'COMPLETED', reason: 'seed-terminal' } });
  const ledgerBefore = ledger(stateDir, id);

  const r1 = await router.reconcile({ reason: 'terminal-settled' });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const cleared = r1.value.actions.find((a) => a.kind === 'ROUTE_REF_CLEARED');
  assert.ok(cleared, JSON.stringify(r1.value.actions));
  assert.ok(['LOOP_TERMINATED', 'SETTLED'].includes(cleared.reason), JSON.stringify(cleared));
  assert.ok(r1.value.actions.some((a) => a.kind === 'ROUTE_RECORD_REMOVED'), JSON.stringify(r1.value.actions));
  assert.deepEqual(routesOnDisk(router), [], 'settled residue cleaned');
  assert.equal(readSession(sessionPath).controlLoop.router, undefined);
  assert.equal(readSession(sessionPath).controlLoop.state, 'COMPLETED', 'projection not rewritten');
  assert.equal(r1.value.state.inSync, true);
  assert.deepEqual(ledger(stateDir, id), ledgerBefore, 'ledger not rewritten');

  // A ref whose journal vanished: same semantics on a terminal loop.
  writeSession(sessionPath, (s) => {
    s.controlLoop.router = { schemaVersion: '1', routeId: 'ghost-terminal-9', phase: 'EXECUTE', engine: 'opencode-cli', state: 'IN_FLIGHT', at: new Date().toISOString() };
  });
  const r2 = await router.reconcile({ reason: 'terminal-missing' });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  const c2 = r2.value.actions.find((a) => a.kind === 'ROUTE_REF_CLEARED');
  assert.ok(c2 && c2.reason === 'RECORD_MISSING', JSON.stringify(r2.value.actions));
  assert.equal(r2.value.actions.some((a) => a.kind === 'ROUTE_RECORD_REMOVED'), false, 'there is no journal to remove');
  assert.equal(readSession(sessionPath).controlLoop.router, undefined);
  assert.equal(readSession(sessionPath).controlLoop.state, 'COMPLETED');
  assert.equal(r2.value.state.inSync, true);
  assert.deepEqual(ledger(stateDir, id), ledgerBefore, 'ledger still immutable');
});

// ============================================================================
// W. suite-level hygiene
// ============================================================================
test('W. the router suite produced zero unhandled rejections', async () => {
  await sleep(50);
  assert.deepEqual(unhandledRejections.map((e) => String((e && e.message) || e)), []);
});
