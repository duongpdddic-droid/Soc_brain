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

import {
  ROUTER_SCHEMA_VERSION,
  ROUTER_PHASES,
  ROUTER_ENGINES,
  ROUTER_ERROR_CODES,
  DEFAULT_ENGINE_FOR_PHASE,
  DEFAULT_FALLBACK_FOR_PHASE,
  MAX_ROUTE_RETRIES,
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
test('I. a foreign live router lock times out with a typed code and is never broken', async () => {
  const stateDir = mkStateDir();
  const { router, sessionPath, id } = mkRouter(stateDir, { router: { lockTimeoutMs: 60, lockRetryMs: 10, staleLockMs: 60_000 } });
  fs.mkdirSync(path.dirname(router.lockPath), { recursive: true });
  fs.writeFileSync(router.lockPath, JSON.stringify({ pid: 999_999, at: new Date().toISOString() }));
  const bytesBefore = fs.readFileSync(sessionPath, 'utf8');

  const r = await router.transition({ from: 'ACCEPTED', to: 'ROUTED' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ROUTER_LOCK_TIMEOUT');
  assert.equal(r.detail.lockPath, router.lockPath);
  assert.ok(fs.existsSync(router.lockPath), 'a lock we do not own is never deleted');
  assert.equal(ledger(stateDir, id).length, 0);
  assert.equal(fs.readFileSync(sessionPath, 'utf8'), bytesBefore);

  fs.rmSync(router.lockPath, { force: true });
});

test('J. a stale crash-leftover lock is reclaimed BY AGE and reported in the result', async () => {
  const stateDir = mkStateDir();
  const { router, id } = mkRouter(stateDir, { router: { staleLockMs: 1_000 } });
  fs.mkdirSync(path.dirname(router.lockPath), { recursive: true });
  fs.writeFileSync(router.lockPath, JSON.stringify({ pid: 424242 }));
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(router.lockPath, old, old);

  const r = await router.transition({ from: 'ACCEPTED', to: 'ROUTED' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.lock.staleLockRemoved, true, 'reclaim must be audited');
  assert.equal(ledger(stateDir, id).length, 1);
  assert.equal(fs.existsSync(router.lockPath), false, 'lock released after the critical section');
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

  const exec2 = router.resolveRoute({ phase: 'EXECUTE' });
  assert.equal(exec2.value.engine, 'opencode-cli', 'unrelated phases keep their default');

  // The pure resolver is exported too (no disk needed).
  const pure = resolveRouteForSession({ session: { state: 'SESSION_ACTIVE' }, phase: 'EXECUTE' });
  assert.equal(pure.ok, true);
  assert.equal(pure.value.engine, 'opencode-cli');
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
// W. suite-level hygiene
// ============================================================================
test('W. the router suite produced zero unhandled rejections', async () => {
  await sleep(50);
  assert.deepEqual(unhandledRejections.map((e) => String((e && e.message) || e)), []);
});
