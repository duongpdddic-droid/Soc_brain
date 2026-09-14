#!/usr/bin/env node
// idle-supervisor-warning.test.mjs — Issue #177 pre-hibernate warning + final
// revalidation gate. Deterministic, ZERO real OS power and ZERO real GUI: the
// warning helper and the power action are injected fakes.
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
const CONFIG = {
  schemaVersion: IDLE_SUPERVISOR_SCHEMA_VERSION, enabled: true,
  dayGraceMs: 20 * MIN, nightGraceMs: 10 * MIN, nightStart: { h: 0, m: 0 }, nightEnd: { h: 6, m: 0 },
  pollSec: 30, warningSeconds: 3, allowRealHibernate: false, stateDir: null,
};

let c = 0;
function mkState() { const d = path.join(TMP, `w-${++c}`); mkdirSync(path.join(d, 'sessions'), { recursive: true }); return d; }
function mkSession(S, issue, state, { leaseAgeMin = 24 * 60 } = {}) {
  const id = identityHash({ repo: CANON, issueNumber: issue });
  writeFileSync(path.join(S, 'sessions', `${id}.json`), JSON.stringify({
    schemaVersion: '1', repo: CANON, issueNumber: issue, state,
    lease: { token: 't', issuedAt: new Date(at(0, 0).getTime() - leaseAgeMin * MIN).toISOString() },
    createdAt: new Date(at(0, 0).getTime() - leaseAgeMin * MIN).toISOString(), lifecycle: [],
  }, null, 2), 'utf8');
  return id;
}
function mkLease(S, issue, { pid = 61000, processStartTime = 134000000000000000 } = {}) {
  const id = identityHash({ repo: CANON, issueNumber: issue });
  const dir = path.join(S, 'activity', 'live'); mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ identityHash: id, repo: CANON, issueNumber: issue, pid, processStartTime, bootId: 'boot-1' }, null, 2), 'utf8');
  return id;
}
function evidenceOf(S) { return readHibernateEvidence({ stateDir: S }).evidence; }

// Build a fake power/warning surface. `warning` may be a string result or a fn
// (lets a test mutate canonical state mid-countdown then return TIMEOUT).
function mkDeps({ userIdleMs = 60 * MIN, warning = 'TIMEOUT', alive = [], startTimes = {} } = {}) {
  const calls = []; const warnings = [];
  return {
    calls, warnings,
    readUserIdleMs: () => userIdleMs, readBootId: () => 'boot-1',
    isAlive: (p) => alive.includes(p),
    readProcessStartTime: (p) => (Object.prototype.hasOwnProperty.call(startTimes, p) ? { pid: p, processStartTime: startTimes[p] } : null),
    checkHibernateAvailable: () => ({ ok: true }),
    runWarning: (o) => { warnings.push(o); return typeof warning === 'function' ? warning(o) : warning; },
    requestHibernate: () => {
      const ev = evidenceOf(TMP_LIVE.S);
      calls.push({ evidenceSeenAtCall: Boolean(ev && ev.hibernateRequested === true) });
      return { ok: true, action: 'HIBERNATE' };
    },
  };
}
let TMP_LIVE = { S: null };
function runOne(S, opts, clockMs) {
  TMP_LIVE = { S };
  const deps = mkDeps(opts);
  let now = clockMs;
  const rt = createSupervisorRuntime({ config: CONFIG, stateDir: S, deps, clock: () => now, bootId: 'boot-1' });
  const t = rt.oneTick();
  return { state: t.state, deps };
}

// ---- R1 user Cancel -> zero power ------------------------------------------------------------
{
  const S = mkState();
  const { state, deps } = runOne(S, { warning: 'CANCELLED' }, at(12, 0).getTime());
  eq('R1 cancelled -> not requested', state, 'WAIT_USER_IDLE');
  eq('R1 zero power', deps.calls.length, 0);
  eq('R1 warning shown once', deps.warnings.length, 1);
  eq('R1 no evidence persisted', evidenceOf(S), null);
}
// ---- R2 close window (X) -> CANCELLED -> zero power -----------------------------------------
{
  const S = mkState();
  const { state, deps } = runOne(S, { warning: 'CANCELLED' }, at(12, 0).getTime());
  eq('R2 close X -> zero power', deps.calls.length, 0);
  eq('R2 stays awake', state, 'WAIT_USER_IDLE');
}
// ---- R3 keyboard/mouse during countdown -> helper returns CANCELLED -> zero power -----------
{
  const S = mkState();
  const { deps } = runOne(S, { warning: 'CANCELLED' }, at(12, 0).getTime());
  eq('R3 recent input cancels -> zero power', deps.calls.length, 0);
}
// ---- R4 new canonical task appears during countdown -> TIMEOUT then final scan aborts --------
{
  const S = mkState();
  const { state, deps } = runOne(S, { warning: () => { mkSession(S, 1201, 'EXECUTING'); return 'TIMEOUT'; } }, at(12, 0).getTime());
  eq('R4 new task -> final revalidation aborts', deps.calls.length, 0);
  eq('R4 state BUSY', state, 'BUSY');
  eq('R4 no evidence', evidenceOf(S), null);
  fs.rmSync(path.join(S, 'sessions', `${identityHash({ repo: CANON, issueNumber: 1201 })}.json`));
}
// ---- R5 new live executor (lease) appears during countdown ----------------------------------
{
  const S = mkState();
  const { deps } = runOne(S, { warning: () => { mkLease(S, 1202, { pid: 61050 }); return 'TIMEOUT'; }, alive: [61050], startTimes: { 61050: 134000000000000000 } }, at(12, 0).getTime());
  eq('R5 new live executor -> zero power', deps.calls.length, 0);
  eq('R5 no evidence', evidenceOf(S), null);
}
// ---- R6 UNKNOWN appears during countdown ----------------------------------------------------
{
  const S = mkState();
  const { deps } = runOne(S, { warning: () => { writeFileSync(path.join(S, 'sessions', 'corrupt.json'), '{bad', 'utf8'); return 'TIMEOUT'; } }, at(12, 0).getTime());
  eq('R6 UNKNOWN -> zero power', deps.calls.length, 0);
}
// ---- R7 generation changed (pure guard) -----------------------------------------------------
{
  const S = mkState();
  const t = at(13, 0);
  const sup = createIdleSupervisor({ config: CONFIG, stateDir: S });
  const clean = scanCanonicalActivity({ stateDir: S, clock: () => t.getTime() });
  const r = sup.tick({ activity: clean, userIdleMs: 60 * MIN, now: t.getTime() });
  const eligibleGen = r.generation;
  mkSession(S, 1207, 'EXECUTING');
  sup.tick({ activity: scanCanonicalActivity({ stateDir: S, clock: () => t.getTime() }), userIdleMs: 60 * MIN, now: t.getTime() });
  fs.rmSync(path.join(S, 'sessions', `${identityHash({ repo: CANON, issueNumber: 1207 })}.json`));
  const stale = sup.finalizeHibernate({ activity: scanCanonicalActivity({ stateDir: S, clock: () => t.getTime() }), userIdleMs: 60 * MIN, now: t.getTime(), generation: eligibleGen });
  eq('R7 generation drift -> ABORTED_GENERATION', stale.code, 'HIBERNATE_ABORTED_GENERATION');
  eq('R7 no persist', stale.ok, false);
  eq('R7 no evidence', evidenceOf(S), null);
}
// ---- R8 helper FAILED / crash -> zero power -------------------------------------------------
{
  const S = mkState();
  const r8 = runOne(S, { warning: 'FAILED' }, at(12, 0).getTime());
  eq('R8 FAILED helper -> zero power', r8.deps.calls.length, 0);
  const S2 = mkState();
  const { deps } = runOne(S2, { warning: () => { throw new Error('helper crashed'); } }, at(12, 0).getTime());
  eq('R8 helper throw -> zero power (normalized FAILED)', deps.calls.length, 0);
  eq('R8 throw -> no evidence', evidenceOf(S2), null);
}
// ---- R9 timeout + final scan PASS -> persist then exactly one power, AFTER warning ----------
{
  const S = mkState();
  const { state, deps } = runOne(S, { warning: 'TIMEOUT' }, at(12, 0).getTime());
  eq('R9 state requested', state, 'HIBERNATE_REQUESTED');
  eq('R9 exactly one power call', deps.calls.length, 1);
  eq('R9 evidence persisted BEFORE the power call', deps.calls[0].evidenceSeenAtCall, true);
  eq('R9 warning received seconds config', deps.warnings[0].seconds, CONFIG.warningSeconds);
  eq('R9 warning precedes power', deps.warnings.length >= 1 && deps.calls.length === 1, true);
  const ev = evidenceOf(S);
  eq('R9 evidence warningSeconds', ev.warningSeconds, 3);
}
// ---- R10 timeout + activity at final scan -> zero power -------------------------------------
{
  const S = mkState();
  const { deps } = runOne(S, { warning: () => { mkSession(S, 1210, 'VERIFYING'); return 'TIMEOUT'; } }, at(12, 0).getTime());
  eq('R10 activity at final scan -> zero power', deps.calls.length, 0);
  fs.rmSync(path.join(S, 'sessions', `${identityHash({ repo: CANON, issueNumber: 1210 })}.json`));
}
// ---- R11 duplicate ticks same generation -> at most ONE warning ------------------------------
{
  const S = mkState();
  TMP_LIVE = { S };
  let now = at(12, 0).getTime();
  const deps = mkDeps({ warning: 'CANCELLED' });
  const rt = createSupervisorRuntime({ config: CONFIG, stateDir: S, deps, clock: () => now, bootId: 'boot-1' });
  const a = rt.oneTick().state; now += 30 * 1000; const b = rt.oneTick().state; now += 30 * 1000; const d2 = rt.oneTick().state;
  eq('R11 oneTick a', a, 'WAIT_USER_IDLE');
  eq('R11 no second warning for same generation', deps.warnings.length, 1);
  eq('R11 stays non-power across ticks', [b, d2].every((s) => s !== 'HIBERNATE_REQUESTED'), true);
  eq('R11 zero power', deps.calls.length, 0);
}
// ---- R12 restart during countdown: stale warning cannot authorize power ----------------------
{
  const S = mkState();
  // A prior runtime reached eligible + warned + cancelled (no evidence persisted).
  runOne(S, { warning: 'CANCELLED' }, at(12, 0).getTime());
  eq('R12 no evidence after cancel', evidenceOf(S), null);
  // A FRESH supervisor over the same state, without a working warning helper, must NOT power.
  const deps = mkDeps({}); delete deps.runWarning; // no helper available -> fail closed
  const rt = createSupervisorRuntime({ config: CONFIG, stateDir: S, deps, clock: () => at(12, 0).getTime(), bootId: 'boot-1' });
  const state = rt.oneTick().state;
  eq('R12 fresh restart cannot power without its own warning', deps.calls.length, 0);
  eq('R12 state not requested', state, 'WAIT_USER_IDLE');
}
// ---- R13 config default 60 + override + invalid ----------------------------------------------
{
  eq('R13 default 60s', readIdleHibernateConfig({}).config.warningSeconds, 60);
  eq('R13 override 5s', readIdleHibernateConfig({ SOC_IDLE_HIBERNATE_WARNING_SECONDS: '5' }).config.warningSeconds, 5);
  eq('R13 disabled 0s allowed', readIdleHibernateConfig({ SOC_IDLE_HIBERNATE_WARNING_SECONDS: '0' }).config.warningSeconds, 0);
  eq('R13 out-of-range invalid', readIdleHibernateConfig({ SOC_IDLE_HIBERNATE_WARNING_SECONDS: '9999' }).ok, false);
  eq('R13 non-integer invalid', readIdleHibernateConfig({ SOC_IDLE_HIBERNATE_WARNING_SECONDS: '1.5' }).ok, false);
}
// ---- R14 deterministic result contract -------------------------------------------------------
{
  eq('R14 WARNING_RESULTS', JSON.stringify(WARNING_RESULTS), JSON.stringify(['CANCELLED', 'TIMEOUT', 'FAILED']));
  eq('R14 normalize TIMEOUT', normalizeWarningResult('TIMEOUT'), 'TIMEOUT');
  eq('R14 normalize unknown -> FAILED', normalizeWarningResult('POWEROFF'), 'FAILED');
  eq('R14 normalize undefined -> FAILED', normalizeWarningResult(undefined), 'FAILED');
  const fake = (r) => runWindowsHibernateWarning({ seconds: 60, spawnSyncImpl: () => r });
  eq('R14 runner TIMEOUT', fake({ status: 0, stdout: 'TIMEOUT' }), 'TIMEOUT');
  eq('R14 runner CANCELLED', fake({ status: 0, stdout: 'CANCELLED' }), 'CANCELLED');
  eq('R14 runner nonzero -> FAILED', fake({ status: 1, stdout: 'TIMEOUT' }), 'FAILED');
  eq('R14 runner error -> FAILED', fake({ error: new Error('boom'), status: null }), 'FAILED');
  eq('R14 runner ambiguous -> FAILED', fake({ status: 0, stdout: 'ok whatever' }), 'FAILED');
  eq('R14 runner empty -> FAILED', fake({ status: 0, stdout: '' }), 'FAILED');
  eq('R14 runner throw -> FAILED', (() => { try { return runWindowsHibernateWarning({ spawnSyncImpl: () => { throw new Error('x'); } }); } catch { return 'THREW'; } })(), 'FAILED');
}
// ---- static: helper carries NO power capability ---------------------------------------------
{
  const src = fs.readFileSync(path.join(process.cwd(), 'packages', 'idle-supervisor', 'windows-warning.mjs'), 'utf8');
  tru('warning helper has no real power invocation', !/\bpowrprof\.dll\b|\brundll32\b|SetSuspendState\s*\(|\/hibernate\s+on/i.test(src));
}

const failed = results.filter((r) => !r.pass);
for (const r of results) process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}\n`);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
