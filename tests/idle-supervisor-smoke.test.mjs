#!/usr/bin/env node
// idle-supervisor-smoke.test.mjs — production-like smoke, ZERO real power IO.
// Fake canonical states + injected fake power executor; proves DAY/NIGHT
// transitions, the night 10-minute policy, wake reinit and the inert-by-default
// production entry point. The real machine can never hibernate here: every
// hibernate goes through the injected fake, and the real run.mjs power action is
// a dry-run unless SOC_IDLE_HIBERNATE_ALLOW_REAL=1 (asserted, never set).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  IDLE_SUPERVISOR_SCHEMA_VERSION, readIdleHibernateConfig, createIdleSupervisor,
  scanCanonicalActivity, readHibernateEvidence,
} from '../packages/idle-supervisor/idle-supervisor.mjs';
import { createSupervisorRuntime, createWindowsDeps } from '../packages/idle-supervisor/run.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

const results = [];
const eq = (n, g, w) => results.push({ name: n, pass: g === w });
const tru = (n, g) => results.push({ name: n, pass: Boolean(g) });

const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-idle-smoke-'));
const CANON = 'duongpdddic-droid/Soc_brain';
const MIN = 60 * 1000;
const CONFIG = {
  schemaVersion: IDLE_SUPERVISOR_SCHEMA_VERSION,
  enabled: true, dayGraceMs: 20 * MIN, nightGraceMs: 10 * MIN,
  nightStart: { h: 0, m: 0 }, nightEnd: { h: 6, m: 0 },
  pollSec: 30, allowRealHibernate: false, stateDir: null,
};
const DAY0 = new Date(2026, 8, 11);
const at = (h, m, s = 0) => { const d = new Date(DAY0); d.setHours(h, m, s, 0); return d; };

let stCounter = 0;
function mkStateDir() {
  const d = path.join(TMP, `smoke-${++stCounter}`);
  mkdirSync(path.join(d, 'sessions'), { recursive: true });
  return d;
}
function mkSession(S, issue, state, { leaseAgeMin = 24 * 60 } = {}) {
  const id = identityHash({ repo: CANON, issueNumber: issue });
  writeFileSync(path.join(S, 'sessions', `${id}.json`), JSON.stringify({
    schemaVersion: '1', repo: CANON, issueNumber: issue, state,
    lease: { token: 't', issuedAt: new Date(Date.now() - leaseAgeMin * MIN).toISOString() },
    createdAt: new Date(Date.now() - leaseAgeMin * MIN).toISOString(), lifecycle: [],
  }, null, 2), 'utf8');
  return id;
}
function mkLedger(S, issue, records) {
  const id = identityHash({ repo: CANON, issueNumber: issue });
  const dir = path.join(S, 'control-loop', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'transitions.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// Production-like fake surface: OS user idle + boot id + power executor, all
// injected. `sleeps` records every power action — the REAL OS is never called.
// At call time the fake verifies the durable evidence is ALREADY on disk,
// proving the persist-before-power ordering.
function fakeProductionDeps(S) {
  const state = { userIdleMs: 0, bootId: 'boot-A' };
  const hibernates = [];
  return {
    state, hibernates,
    readUserIdleMs: () => state.userIdleMs,
    readBootId: () => state.bootId,
    checkHibernateAvailable: () => ({ ok: true }),
    requestHibernate: () => {
      const ev = readHibernateEvidence({ stateDir: S }).evidence;
      hibernates.push({
        action: 'HIBERNATE', at: new Date().toISOString(),
        evidenceSeenAtCall: Boolean(ev && ev.event === 'HIBERNATE_IDLE_CONFIRMED' && ev.hibernateRequested === true),
      });
      return { ok: true, action: 'HIBERNATE' };
    },
  };
}

// ---- scenario A: full DAY cycle (busy -> idle -> sleep -> wake) ---------------------------
{
  const S = mkStateDir();
  mkSession(S, 2001, 'EXECUTING'); // canonical workload is live
  const deps = fakeProductionDeps(S);
  let now = at(9, 0).getTime();
  const rt = createSupervisorRuntime({ config: CONFIG, stateDir: S, deps, clock: () => now });
  const logs = [];
  let busyState = null;
  // busy phase: executor running for 3 hours while the user is away
  for (let i = 0; i < 360; i++) { now += 30 * 1000; busyState = rt.oneTick().state; }
  eq('A busy stays BUSY, zero sleeps', busyState, 'BUSY');
  // task terminalizes; user has been away all along
  fs.rmSync(path.join(S, 'sessions', `${identityHash({ repo: CANON, issueNumber: 2001 })}.json`));
  deps.state.userIdleMs = 4 * 60 * MIN;
  now += 30 * 1000;
  const t = rt.oneTick();
  eq('A day policy sleeps when idle', t.state, 'HIBERNATE_REQUESTED');
  eq('A exactly one sleep', deps.hibernates.length, 1);
  const ev = readHibernateEvidence({ stateDir: S }).evidence;
  eq('A evidence event', ev.event, 'HIBERNATE_IDLE_CONFIRMED');
  eq('A evidence policy DAY', ev.policy, 'DAY');
  eq('A evidence zero active tasks', ev.activeCanonicalTasks, 0);
  eq('A evidence zero pending control work', ev.pendingControlWork, 0);
  tru('A evidence before OS call', deps.hibernates[0].evidenceSeenAtCall === true);
  logs.push('A: day cycle complete');
  // machine sleeps -> 8h pass with no ticks -> wake (user active again)
  now += 8 * 60 * MIN;
  deps.state.userIdleMs = 0; // fresh wake: user idle window restarts at zero
  const wake = rt.oneTick(); // resume gap -> reinit
  eq('A wake reinit (fresh idle window, no instant re-sleep)', wake.state, 'WAIT_USER_IDLE');
  eq('A no double sleep on wake', deps.hibernates.length, 1);
}

// ---- scenario B: NIGHT policy with the 10-minute grace -------------------------------------
{
  const S = mkStateDir();
  const deps = fakeProductionDeps(S);
  let now = at(0, 1).getTime();
  const rt = createSupervisorRuntime({ config: CONFIG, stateDir: S, deps, clock: () => now });
  deps.state.userIdleMs = 0; // user just touched the machine — NIGHT ignores it
  now += 30 * 1000;
  eq('B night countdown (user idle irrelevant)', rt.oneTick().state, 'IDLE_COUNTDOWN');
  let s = null;
  for (let i = 0; i < 19; i++) { now += 30 * 1000; s = rt.oneTick().state; } // ~9.5m more
  eq('B still counting at ~9.5m', s, 'IDLE_COUNTDOWN');
  now += 60 * 1000;
  const t = rt.oneTick(); // 10m+ of continuously clean window
  eq('B night sleep after 10m clean', t.state, 'HIBERNATE_REQUESTED');
  eq('B one sleep', deps.hibernates.length, 1);
  eq('B evidence policy NIGHT', readHibernateEvidence({ stateDir: S }).evidence.policy, 'NIGHT');
}

// ---- scenario C: new work during night countdown resets it ---------------------------------
{
  const S = mkStateDir();
  const deps = fakeProductionDeps(S);
  let now = at(0, 30).getTime();
  const rt = createSupervisorRuntime({ config: CONFIG, stateDir: S, deps, clock: () => now });
  now += 30 * 1000;
  rt.oneTick(); // countdown starts
  for (let i = 0; i < 10; i++) { now += 30 * 1000; rt.oneTick(); } // 5m of clean countdown
  mkSession(S, 2002, 'SESSION_ACTIVE'); // reverse-dispatch admits a new task
  mkLedger(S, 2002, [{ from: 'ROUTED', to: 'EXECUTING' }]);
  now += 30 * 1000;
  eq('C new work -> BUSY', rt.oneTick().state, 'BUSY');
  fs.rmSync(path.join(S, 'sessions', `${identityHash({ repo: CANON, issueNumber: 2002 })}.json`));
  for (let i = 0; i < 9; i++) { now += 30 * 1000; rt.oneTick(); } // only ~4.5m clean since reset
  const s = rt.oneTick();
  eq('C no sleep before fresh 10m (reset held)', s.state, 'IDLE_COUNTDOWN');
  eq('C still zero sleeps', deps.hibernates.length, 0);
}

// ---- scenario D: 05:59/06:00 boundary flips night -> day -----------------------------------
{
  const S = mkStateDir();
  const deps = fakeProductionDeps(S);
  let now = at(5, 50).getTime();
  const rt = createSupervisorRuntime({ config: CONFIG, stateDir: S, deps, clock: () => now });
  now += 30 * 1000;
  eq('D 05:50 night countdown', rt.oneTick().state, 'IDLE_COUNTDOWN');
  let s = null;
  for (let i = 0; i < 17; i++) { now += 30 * 1000; s = rt.oneTick().state; } // step to ~05:59
  eq('D 05:59 still night', s, 'IDLE_COUNTDOWN');
  now += 60 * 1000; // 06:00 — DAY begins
  deps.state.userIdleMs = 9 * MIN; // day policy needs 20m user idle
  eq('D 06:00 day -> WAIT_USER_IDLE', rt.oneTick().state, 'WAIT_USER_IDLE');
  deps.state.userIdleMs = 45 * MIN;
  eq('D 06:00 day idle user -> eligible', rt.oneTick().state, 'HIBERNATE_REQUESTED');
  eq('D one sleep', deps.hibernates.length, 1);
}

// ---- scenario E: final read-back abort (work appears in the window) -------------------------
{
  const S = mkStateDir();
  const deps = fakeProductionDeps(S);
  let now = at(0, 0).getTime();
  const rt = createSupervisorRuntime({ config: CONFIG, stateDir: S, deps, clock: () => now });
  now += 30 * 1000;
  rt.oneTick(); // countdown starts
  now += 10 * MIN + 30 * 1000;
  // work appears in the window: the tick scan sees it -> BUSY, never sleeps
  mkSession(S, 2003, 'SESSION_ACTIVE');
  mkLedger(S, 2003, [{ from: 'EXECUTING', to: 'VERIFYING' }]);
  const t = rt.oneTick();
  eq('E active work aborts the sleep', t.state, 'BUSY');
  eq('E zero sleeps', deps.hibernates.length, 0);
}

// ---- scenario F: real production entry stays inert without the flag -------------------------
{
  const deps = createWindowsDeps({ env: {} }); // no SOC_IDLE_HIBERNATE_ALLOW_REAL
  eq('F no Sleep dispatch method exists', typeof deps.requestSleep, 'undefined');
  const r = deps.requestHibernate();
  eq('F dry-run without production flag', r.dryRun, true);
  eq('F action recorded but not executed', r.action, 'HIBERNATE');
  tru('F no OS process spawned', r.exitCode === undefined && r.detail === undefined);
  const cfg = readIdleHibernateConfig({});
  eq('F supervisor disabled by default', cfg.config.enabled, false);
}

// ---- footprint --------------------------------------------------------------------------------
{
  const start = process.memoryUsage().rss;
  const S = mkStateDir();
  const deps = fakeProductionDeps(S);
  let now = at(12, 0).getTime();
  const rt = createSupervisorRuntime({ config: CONFIG, stateDir: S, deps, clock: () => now });
  for (let i = 0; i < 300; i++) { now += 30 * 1000; rt.oneTick(); }
  const growth = process.memoryUsage().rss - start;
  tru('footprint: 300 ticks, growth < 8MB', growth < 8 * 1024 * 1024);
  results.push({ name: 'footprint report', pass: true, info: `rss=${(start / 1048576).toFixed(1)}MB growth=${(growth / 1048576).toFixed(2)}MB sleeps=${deps.hibernates.length}` });
}

const failed = results.filter((r) => !r.pass);
for (const r of results) {
  process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}${r.info ? ` (${r.info})` : ''}\n`);
}
process.stdout.write(`\n${results.length - failed.length}/${results.length} smoke checks passed\n`);
process.exit(failed.length ? 1 : 0);
