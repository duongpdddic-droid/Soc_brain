#!/usr/bin/env node
// idle-supervisor-warning.test.mjs — Issue #177 pre-hibernate warning: bounded,
// user-cancellable countdown with CONTINUOUS monitoring + a FINAL fresh
// revalidation gate. Deterministic, ZERO real OS power and ZERO real GUI: the
// async warning controller, the power action and the clock are all injected
// fakes; multiple oneTick() calls drive the countdown and its per-poll monitor.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  IDLE_SUPERVISOR_SCHEMA_VERSION, WARNING_RESULTS, normalizeWarningResult,
  readIdleHibernateConfig, createIdleSupervisor, scanCanonicalActivity, readHibernateEvidence,
} from '../packages/idle-supervisor/idle-supervisor.mjs';
import { createSupervisorRuntime } from '../packages/idle-supervisor/run.mjs';
import { runWindowsHibernateWarning } from '../packages/idle-supervisor/windows-warning.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

const results = [];
const eq = (n, g, w) => results.push({ name: n, pass: g === w });
const tru = (n, g) => results.push({ name: n, pass: Boolean(g) });

const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-warn-'));
const CANON = 'duongpdddic-droid/Soc_brain';
const MIN = 60 * 1000;
const DAY0 = new Date(2026, 8, 10);
const at = (h, m, s = 0) => { const d = new Date(DAY0); d.setHours(h, m, s, 0); return d; };
const SECS = 5;
const CONFIG = {
  schemaVersion: IDLE_SUPERVISOR_SCHEMA_VERSION, enabled: true,
  dayGraceMs: 20 * MIN, nightGraceMs: 10 * MIN, nightStart: { h: 0, m: 0 }, nightEnd: { h: 6, m: 0 },
  pollSec: 30, warningSeconds: SECS, allowRealHibernate: false, stateDir: null,
};

let c = 0;
function mkState() { const d = path.join(TMP, `w-${++c}`); mkdirSync(path.join(d, 'sessions'), { recursive: true }); return d; }
function sid(issue) { return identityHash({ repo: CANON, issueNumber: issue }); }
function mkSession(S, issue, state) {
  writeFileSync(path.join(S, 'sessions', `${sid(issue)}.json`), JSON.stringify({
    schemaVersion: '1', repo: CANON, issueNumber: issue, state,
    lease: { token: 't', issuedAt: new Date(at(0, 0).getTime()).toISOString() },
    createdAt: new Date(at(0, 0).getTime()).toISOString(), lifecycle: [],
  }, null, 2), 'utf8');
}
function rmSession(S, issue) { fs.rmSync(path.join(S, 'sessions', `${sid(issue)}.json`)); }
function mkLease(S, issue, { pid = 61000, processStartTime = 134000000000000000 } = {}) {
  const dir = path.join(S, 'activity', 'live'); mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sid(issue)}.json`), JSON.stringify({ identityHash: sid(issue), repo: CANON, issueNumber: issue, pid, processStartTime, bootId: 'boot-1' }, null, 2), 'utf8');
}
function rmLease(S, issue) { fs.rmSync(path.join(S, 'activity', 'live', `${sid(issue)}.json`)); }
function evidenceOf(S) { return readHibernateEvidence({ stateDir: S }).evidence; }

// Build an async warning controller from a step spec (returns a result for a
// given elapsedMs). Records open() calls and terminate() reasons.
function warningController(stepSpec) {
  const openCount = { n: 0 };
  const terms = [];
  return {
    openCount, terms,
    openWarning: (o) => {
      openCount.n += 1;
      return { step: (a) => stepSpec(a, openCount.n), terminate: (r) => { terms.push(r); return true; } };
    },
  };
}
function mkDeps({ userIdleMs = 60 * MIN, step = () => 'TIMEOUT', alive = [], startTimes = {} } = {}) {
  const calls = [];
  const wc = warningController(step);
  return {
    calls, openCount: wc.openCount, terms: wc.terms,
    readUserIdleMs: () => userIdleMs, readBootId: () => 'boot-1',
    isAlive: (p) => alive.includes(p),
    readProcessStartTime: (p) => (Object.prototype.hasOwnProperty.call(startTimes, p) ? { pid: p, processStartTime: startTimes[p] } : null),
    checkHibernateAvailable: () => ({ ok: true }),
    openWarning: wc.openWarning,
    requestHibernate: () => {
      const ev = evidenceOf(TMP_LIVE.S);
      calls.push({ evidenceSeenAtCall: Boolean(ev && ev.hibernateRequested === true) });
      return { ok: true, action: 'HIBERNATE' };
    },
  };
}
let TMP_LIVE = { S: null };
function runtime(S, opts, startMs) {
  TMP_LIVE = { S };
  let t = startMs;
  const deps = mkDeps(opts);
  const rt = createSupervisorRuntime({ config: CONFIG, stateDir: S, deps, clock: () => t, bootId: 'boot-1' });
  return { rt, deps, setNow: (ms) => { t = ms; }, add: (ms) => { t += ms; } };
}
const immediateTimeout = () => () => 'TIMEOUT';
const alwaysPending = () => () => 'PENDING';

// ---- RF1 task appears then disappears DURING the window -> monitor catches it, 0 power ------
{
  const S = mkState();
  const r = runtime(S, { step: ({ elapsedMs }) => (elapsedMs >= SECS * 1000 ? 'TIMEOUT' : 'PENDING') }, at(12, 0).getTime());
  eq('RF1 opens warning', r.rt.oneTick().state, 'WAIT_USER_IDLE'); // opens + PENDING (elapsed 0)
  r.add(1000); mkSession(S, 1201, 'EXECUTING'); // task appears
  eq('RF1 monitor poll sees active -> BUSY/dismiss', r.rt.oneTick().state, 'WAIT_USER_IDLE');
  r.add(1000); rmSession(S, 1201); // task disappears BEFORE original timeout
  eq('RF1 reopen blocked (stale countdown gone)', r.rt.oneTick().state, 'WAIT_USER_IDLE');
  r.add(1000);
  eq('RF1 no power ever', r.deps.calls.length, 0);
  eq('RF1 no evidence', evidenceOf(S), null);
  tru('RF1 helper terminated', r.deps.terms.length >= 1);
}
// ---- RF2 live executor lease appears then retires during the window --------------------------
{
  const S = mkState();
  const r = runtime(S, { step: ({ elapsedMs }) => (elapsedMs >= SECS * 1000 ? 'TIMEOUT' : 'PENDING'), alive: [61050], startTimes: { 61050: 134000000000000000 } }, at(12, 0).getTime());
  r.rt.oneTick(); // open, pending
  r.add(1000); mkLease(S, 1202, { pid: 61050 }); r.rt.oneTick(); // monitor sees live lease -> dismiss
  r.add(1000); rmLease(S, 1202); r.rt.oneTick(); // lease retires
  eq('RF2 no power (executor liveness caught)', r.deps.calls.length, 0);
  eq('RF2 no evidence', evidenceOf(S), null);
}
// ---- RF3 UNKNOWN appears then clears during the window ---------------------------------------
{
  const S = mkState();
  const r = runtime(S, { step: ({ elapsedMs }) => (elapsedMs >= SECS * 1000 ? 'TIMEOUT' : 'PENDING') }, at(12, 0).getTime());
  r.rt.oneTick(); r.add(1000);
  writeFileSync(path.join(S, 'sessions', 'corrupt.json'), '{bad', 'utf8'); r.rt.oneTick(); // UNKNOWN -> dismiss
  fs.rmSync(path.join(S, 'sessions', 'corrupt.json')); r.add(1000); r.rt.oneTick();
  eq('RF3 no power (UNKNOWN caught)', r.deps.calls.length, 0);
}
// ---- RF4 generation changes during the window; old warning can never authorize power ---------
{
  const S = mkState();
  const r = runtime(S, { step: ({ elapsedMs }) => (elapsedMs >= SECS * 1000 ? 'TIMEOUT' : 'PENDING') }, at(12, 0).getTime());
  r.rt.oneTick(); r.add(1000);
  mkSession(S, 1204, 'EXECUTING'); r.rt.oneTick(); // activity -> dismiss; later a real busy tick bumps generation
  rmSession(S, 1204);
  // old gen already warned+cancelled; no evidence from it
  eq('RF4 old warning produced no evidence', evidenceOf(S), null);
  // generation advances only when supervisor.tick observes busy; force one clean tick then an active tick
  const sup = createIdleSupervisor({ config: CONFIG, stateDir: S });
  const g0 = sup.tick({ activity: scanCanonicalActivity({ stateDir: S, clock: () => at(12, 0).getTime() }), userIdleMs: 60 * MIN, now: at(12, 0).getTime() }).generation;
  mkSession(S, 1205, 'EXECUTING');
  sup.tick({ activity: scanCanonicalActivity({ stateDir: S, clock: () => at(12, 1).getTime() }), userIdleMs: 60 * MIN, now: at(12, 1).getTime() });
  rmSession(S, 1205);
  const clean = scanCanonicalActivity({ stateDir: S, clock: () => at(12, 2).getTime() });
  const stale = sup.finalizeHibernate({ activity: clean, userIdleMs: 60 * MIN, now: at(12, 2).getTime(), generation: g0 });
  eq('RF4 stale generation -> ABORTED_GENERATION', stale.code, 'HIBERNATE_ABORTED_GENERATION');
}
// ---- RF5 invalidation terminates/dismisses the helper with no orphan -------------------------
{
  const S = mkState();
  const r = runtime(S, { step: () => 'CANCELLED' }, at(12, 0).getTime());
  r.rt.oneTick(); // opens + step CANCELLED -> dismiss (terminate called)
  eq('RF5 helper terminated once', r.deps.terms.length, 1);
  eq('RF5 no power', r.deps.calls.length, 0);
}
// ---- RF6 clean countdown -> TIMEOUT -> fresh final scan PASS -> persist -> one power ---------
{
  const S = mkState();
  const r = runtime(S, { step: immediateTimeout() }, at(12, 0).getTime());
  eq('RF6 requested', r.rt.oneTick().state, 'HIBERNATE_REQUESTED');
  eq('RF6 exactly one power', r.deps.calls.length, 1);
  eq('RF6 evidence persisted BEFORE power', r.deps.calls[0].evidenceSeenAtCall, true);
  eq('RF6 helper closed after timeout', r.deps.terms.length, 1);
  eq('RF6 evidence warningSeconds', evidenceOf(S).warningSeconds, SECS);
}
// ---- RF7 boundary race: activity present at the TIMEOUT poll -> no power ----------------------
{
  const S = mkState();
  const r = runtime(S, { step: ({ elapsedMs }) => (elapsedMs >= SECS * 1000 ? 'TIMEOUT' : 'PENDING') }, at(12, 0).getTime());
  r.rt.oneTick(); // open
  r.add(SECS * 1000 + 50); mkSession(S, 1207, 'VERIFYING'); // activity at the boundary poll
  eq('RF7 boundary activity aborts even on TIMEOUT', r.rt.oneTick().state, 'WAIT_USER_IDLE');
  eq('RF7 no power', r.deps.calls.length, 0);
  eq('RF7 no evidence', evidenceOf(S), null);
}
// ---- R1..R3 user cancel / close X / recent input (helper CANCELLED) --------------------------
{
  for (const [name, step] of [['R1', () => 'CANCELLED'], ['R2', () => 'CANCELLED'], ['R3', () => 'CANCELLED']]) {
    const S = mkState();
    const r = runtime(S, { step }, at(12, 0).getTime());
    eq(`${name} -> WAIT`, r.rt.oneTick().state, 'WAIT_USER_IDLE');
    eq(`${name} zero power`, r.deps.calls.length, 0);
    eq(`${name} no evidence`, evidenceOf(S), null);
  }
}
// ---- R8 helper FAILED / throw -> zero power ---------------------------------------------------
{
  const S = mkState();
  eq('R8 FAILED -> 0 power', runtime(S, { step: () => 'FAILED' }, at(12, 0).getTime()).rt.oneTick().state, 'WAIT_USER_IDLE');
  const S2 = mkState();
  const r2 = runtime(S2, { step: () => { throw new Error('boom'); } }, at(12, 0).getTime());
  eq('R8 throw -> 0 power', r2.rt.oneTick().state, 'WAIT_USER_IDLE');
  eq('R8 no evidence', evidenceOf(S2), null);
}
// ---- R11 duplicate polls same generation -> open exactly one warning -------------------------
{
  const S = mkState();
  const r = runtime(S, { step: alwaysPending() }, at(12, 0).getTime());
  r.rt.oneTick(); r.add(1000); r.rt.oneTick(); r.add(1000); r.rt.oneTick();
  eq('R11 one warning open', r.deps.openCount.n, 1);
  eq('R11 no power while pending', r.deps.calls.length, 0);
  r.add(5000); mkSession(S, 1211, 'EXECUTING'); // activity -> dismiss; same gen never reopens
  r.rt.oneTick(); rmSession(S, 1211); r.add(1000); r.rt.oneTick();
  eq('R11 still one warning after clear', r.deps.openCount.n, 1);
  eq('R11 no power', r.deps.calls.length, 0);
}
// ---- R12 restart during countdown -> fresh runtime cannot power without its own warning ------
{
  const S = mkState();
  runtime(S, { step: () => 'CANCELLED' }, at(12, 0).getTime()).rt.oneTick(); // prior runtime warned+cancelled
  eq('R12 no evidence after cancel', evidenceOf(S), null);
  // a fresh runtime with NO openWarning helper -> fail closed, never powers
  let t = at(12, 0).getTime();
  const deps = mkDeps({ step: () => 'TIMEOUT' }); delete deps.openWarning;
  const rt = createSupervisorRuntime({ config: CONFIG, stateDir: S, deps, clock: () => t, bootId: 'boot-1' });
  rt.oneTick();
  eq('R12 restart without helper -> zero power', deps.calls.length, 0);
}
// ---- R13 config default 60 + override + 0 + invalid ------------------------------------------
{
  eq('R13 default 60', readIdleHibernateConfig({}).config.warningSeconds, 60);
  eq('R13 override 5', readIdleHibernateConfig({ SOC_IDLE_HIBERNATE_WARNING_SECONDS: '5' }).config.warningSeconds, 5);
  eq('R13 zero allowed', readIdleHibernateConfig({ SOC_IDLE_HIBERNATE_WARNING_SECONDS: '0' }).config.warningSeconds, 0);
  eq('R13 out-of-range invalid', readIdleHibernateConfig({ SOC_IDLE_HIBERNATE_WARNING_SECONDS: '9999' }).ok, false);
  eq('R13 non-integer invalid', readIdleHibernateConfig({ SOC_IDLE_HIBERNATE_WARNING_SECONDS: '1.5' }).ok, false);
}
// ---- R14 result contract + async helper bounded, no power capability --------------------------
{
  eq('R14 WARNING_RESULTS', JSON.stringify(WARNING_RESULTS), JSON.stringify(['CANCELLED', 'TIMEOUT', 'FAILED']));
  eq('R14 normalize unknown', normalizeWarningResult('POWEROFF'), 'FAILED');
  const fake = (r) => runWindowsHibernateWarning({ seconds: 60, spawnSyncImpl: () => r });
  eq('R14 runner TIMEOUT', fake({ status: 0, stdout: 'TIMEOUT' }), 'TIMEOUT');
  eq('R14 runner CANCELLED', fake({ status: 0, stdout: 'CANCELLED' }), 'CANCELLED');
  eq('R14 runner nonzero', fake({ status: 1, stdout: 'TIMEOUT' }), 'FAILED');
  eq('R14 runner error', fake({ error: new Error('x'), status: null }), 'FAILED');
  eq('R14 runner ambiguous', fake({ status: 0, stdout: 'weird' }), 'FAILED');
  const src = fs.readFileSync(path.join(process.cwd(), 'packages', 'idle-supervisor', 'windows-warning.mjs'), 'utf8');
  tru('helper has no real power invocation', !/\bpowrprof\.dll\b|\brundll32\b|SetSuspendState\s*\(|\/hibernate\s+on/i.test(src));
  const { spawnWindowsHibernateWarning } = await import('../packages/idle-supervisor/windows-warning.mjs');
  // spawn failure (no pid) -> step FAILED (fail-closed), terminate safe
  const dead = spawnWindowsHibernateWarning({ seconds: 3, spawnImpl: () => ({ on() {}, stdout: null }) });
  eq('async ctrl no-pid -> FAILED', dead.step({ elapsedMs: 99999 }), 'FAILED');
}

const failed = results.filter((r) => !r.pass);
for (const r of results) process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}\n`);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
