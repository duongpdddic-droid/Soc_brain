#!/usr/bin/env node
// idle-supervisor.test.mjs — Idle Hibernate Supervisor regression coverage.
// Deterministic: real canonical fixtures at canonical control-plane locations
// (sessions/, control-loop/ ledger, executions/), injected clocks, and an
// INJECTED fake power executor — an automated test can never hibernate the host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  IDLE_SUPERVISOR_SCHEMA_VERSION, SUPERVISOR_STATES, ACTIVE_LOOP_STATES, INACTIVE_STATES,
  readIdleHibernateConfig, localPolicyMode, scanCanonicalActivity,
  createIdleSupervisor, readHibernateEvidence, persistHibernateEvidence,
} from '../packages/idle-supervisor/idle-supervisor.mjs';
import { createSupervisorRuntime, spawnIdleSupervisor, parseHibernateAvailable } from '../packages/idle-supervisor/run.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

const results = [];
const eq = (n, g, w) => results.push({ name: n, pass: g === w });
const tru = (n, g) => results.push({ name: n, pass: Boolean(g) });
const isEq = (n, g, w) => results.push({ name: n, pass: JSON.stringify(g) === JSON.stringify(w) });

const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-idle-'));
const CANON = 'duongpdddic-droid/Soc_brain';
const MIN = 60 * 1000;

const CONFIG = {
  schemaVersion: IDLE_SUPERVISOR_SCHEMA_VERSION,
  enabled: true, dayGraceMs: 20 * MIN, nightGraceMs: 10 * MIN,
  nightStart: { h: 0, m: 0 }, nightEnd: { h: 6, m: 0 },
  pollSec: 30, allowRealHibernate: false, stateDir: null,
};

// Deterministic LOCAL wall-clock times (Windows local timezone, never UTC).
const DAY0 = new Date(2026, 8, 10); // 2026-09-10, local midnight
const at = (h, m, s = 0) => { const d = new Date(DAY0); d.setHours(h, m, s, 0); return d; };

let stCounter = 0;
function mkStateDir() {
  const d = path.join(TMP, `st-${++stCounter}`);
  mkdirSync(path.join(d, 'sessions'), { recursive: true });
  return d;
}
function mkSession(STATE, issue, state, { leaseAgeMin = 24 * 60 } = {}) {
  const id = identityHash({ repo: CANON, issueNumber: issue });
  writeFileSync(path.join(STATE, 'sessions', `${id}.json`), JSON.stringify({
    schemaVersion: '1', repo: CANON, issueNumber: issue, state,
    lease: { token: 't', issuedAt: new Date(DAY0.getTime() - leaseAgeMin * MIN).toISOString() },
    createdAt: new Date(DAY0.getTime() - leaseAgeMin * MIN).toISOString(),
    lifecycle: [],
  }, null, 2), 'utf8');
  return id;
}
function mkLedger(STATE, issue, records) {
  const id = identityHash({ repo: CANON, issueNumber: issue });
  const dir = path.join(STATE, 'control-loop', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'transitions.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}
function mkExec(STATE, issue, record) {
  const id = identityHash({ repo: CANON, issueNumber: issue });
  const dir = path.join(STATE, 'executions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ identityHash: id, ...record }, null, 2), 'utf8');
}
function rmSession(STATE, issue) {
  fs.rmSync(path.join(STATE, 'sessions', `${identityHash({ repo: CANON, issueNumber: issue })}.json`));
}
const scanAt = (STATE, now, isAlive) => scanCanonicalActivity({ stateDir: STATE, clock: () => now.getTime(), isAlive });

// Fake power executor: counts requests; NEVER touches the OS. `hibernate`
// reports the capability preflight result (default: AVAILABLE).
function fakeDeps({ userIdleMs = 0, bootId = 'boot-1', hibernate = true } = {}) {
  const calls = [];
  return {
    calls,
    readUserIdleMs: () => userIdleMs,
    readBootId: () => bootId,
    checkHibernateAvailable: () => (hibernate ? { ok: true } : { ok: false, reason: 'HIBERNATE_UNAVAILABLE', detail: 'powercfg /a: hibernate not available' }),
    requestHibernate: () => { calls.push({ action: 'HIBERNATE', at: new Date().toISOString() }); return { ok: true, action: 'HIBERNATE' }; },
  };
}

// ---- module surface --------------------------------------------------------------
eq('schema version', IDLE_SUPERVISOR_SCHEMA_VERSION, '1');
isEq('supervisor states', SUPERVISOR_STATES,
  ['DISABLED', 'BUSY', 'WAIT_USER_IDLE', 'IDLE_COUNTDOWN',
    'HIBERNATE_ELIGIBLE', 'HIBERNATE_REQUESTED', 'HIBERNATE_DENIED_UNKNOWN_ACTIVITY', 'HUMAN_GATE_REQUIRED']);
tru('no SLEEP token in canonical states', SUPERVISOR_STATES.every((s) => !/SLEEP/i.test(s)));
tru('active states frozen', Object.isFrozen(ACTIVE_LOOP_STATES) && Object.isFrozen(INACTIVE_STATES));

// ---- powercfg /a capability parser -------------------------------------------------
tru('parse: hibernate in available block', parseHibernateAvailable(
  'The following sleep states are available on this system:\n    Standby (S3)\n    Hibernate\n\nThe following sleep states are not available on this system:\n    Hibernate\n\tThe Hibernate feature has been disabled.'));
eq('parse: hibernate only under NOT-available -> false', parseHibernateAvailable(
  'The following sleep states are available on this system:\n    Standby (S3)\n\nThe following sleep states are not available on this system:\n    Hibernate\n\tThe Hibernate feature has been disabled.'), false);
eq('parse: null output -> false (fail-closed)', parseHibernateAvailable(null), false);

// ---- config ------------------------------------------------------------------------
eq('explicit enable (canonical)', readIdleHibernateConfig({ SOC_IDLE_HIBERNATE: '1' }).config.enabled, true);
eq('explicit enable (legacy alias)', readIdleHibernateConfig({ SOC_IDLE_SLEEP: '1' }).config.enabled, true);
eq('not enabled by default', readIdleHibernateConfig({}).config.enabled, false);
eq('bad night clock rejected', readIdleHibernateConfig({ SOC_IDLE_HIBERNATE: '1', SOC_IDLE_HIBERNATE_NIGHT_START: '25:00' }).ok, false);
eq('bad grace rejected', readIdleHibernateConfig({ SOC_IDLE_HIBERNATE: '1', SOC_IDLE_HIBERNATE_DAY_GRACE_MIN: '0' }).ok, false);

// ---- timezone policy (local, not UTC) ------------------------------------------------
eq('06:00 local is DAY', localPolicyMode(at(6, 0), CONFIG), 'DAY');
eq('00:00 local is NIGHT', localPolicyMode(at(0, 0), CONFIG), 'NIGHT');
eq('05:59 local is NIGHT', localPolicyMode(at(5, 59), CONFIG), 'NIGHT');
eq('23:59 local is DAY', localPolicyMode(at(23, 59), CONFIG), 'DAY');

// ---- regression 1: EXECUTING -> no hibernate ----------------------------------------------
{
  const S = mkStateDir();
  mkSession(S, 1001, 'EXECUTING');
  const t = at(10, 0);
  const a = scanAt(S, t);
  eq('r1 active count', a.activeCanonicalTasks, 1);
  eq('r1 known', a.known, true);
  const sup = createIdleSupervisor({ config: CONFIG, stateDir: S });
  const r = sup.tick({ activity: a, userIdleMs: 60 * MIN, now: t.getTime() });
  eq('r1 state', r.state, 'BUSY');
  eq('r1 no actions', r.actions.length, 0);
}

// ---- regression 2: VERIFYING / PRE_REVIEWING / FINAL_REVIEWING ledger tails -----------
{
  const S = mkStateDir();
  const tails = ['VERIFYING', 'PRE_REVIEWING', 'FINAL_REVIEWING'];
  tails.forEach((tail, i) => {
    mkSession(S, 1002 + i, 'SESSION_ACTIVE');
    mkLedger(S, 1002 + i, [{ from: 'ROUTED', to: 'EXECUTING' }, { from: 'EXECUTING', to: tail }]);
  });
  const t = at(10, 5);
  const a = scanAt(S, t);
  eq('r2 active count', a.activeCanonicalTasks, 3);
  const sup = createIdleSupervisor({ config: CONFIG, stateDir: S });
  eq('r2 state', sup.tick({ activity: a, userIdleMs: 60 * MIN, now: t.getTime() }).state, 'BUSY');
}

// ---- regression 3: CWA write/finality pending (DECIDING window) ------------------------
{
  const S = mkStateDir();
  mkSession(S, 1005, 'SESSION_ACTIVE');
  mkLedger(S, 1005, [{ from: 'FINAL_REVIEWING', to: 'DECIDING' }]);
  const t = at(10, 10);
  const a = scanAt(S, t);
  eq('r3 active count', a.activeCanonicalTasks, 1);
  const sup = createIdleSupervisor({ config: CONFIG, stateDir: S });
  eq('r3 state', sup.tick({ activity: a, userIdleMs: 60 * MIN, now: t.getTime() }).state, 'BUSY');
}

// ---- regression 4: DELIVERING -> no hibernate -----------------------------------------------
{
  const S = mkStateDir();
  mkSession(S, 1006, 'SESSION_ACTIVE');
  mkLedger(S, 1006, [{ from: 'DECIDING', to: 'DELIVERING' }]);
  const t = at(10, 15);
  eq('r4 active count', scanAt(S, t).activeCanonicalTasks, 1);
}

// ---- regression 5: rework + recovery states -> no hibernate ----------------------------------
{
  const S = mkStateDir();
  mkSession(S, 1007, 'REWORK');
  mkSession(S, 1008, 'RECOVERING');
  mkSession(S, 1009, 'MCP_RECOVERING');
  const t = at(10, 20);
  eq('r5 active count', scanAt(S, t).activeCanonicalTasks, 3);
}

// ---- regression 6: only terminal/gate states -> eligible ---------------------------------
{
  const S = mkStateDir();
  mkSession(S, 1010, 'COMPLETED');
  mkSession(S, 1011, 'BLOCKED');
  mkSession(S, 1012, 'FAILED');
  mkSession(S, 1013, 'HUMAN_GATE_REQUIRED');
  mkSession(S, 1014, 'WAITING_FOR_INPUT');
  mkSession(S, 1015, 'SESSION_ACTIVE'); // stale: 24h old, no ledger, no execution record
  const t = at(22, 0);
  const a = scanAt(S, t);
  eq('r6 active count', a.activeCanonicalTasks, 0);
  eq('r6 pending', a.pendingControlWork, 0);
  eq('r6 known', a.known, true);
  const sup = createIdleSupervisor({ config: CONFIG, stateDir: S });
  const r = sup.tick({ activity: a, userIdleMs: 25 * MIN, now: t.getTime() });
  eq('r6 eligible', r.state, 'HIBERNATE_ELIGIBLE');
  const fin = r.finalize(a);
  eq('r6 finalize ok', fin.ok, true);
  eq('r6 evidence event', fin.evidence.event, 'HIBERNATE_IDLE_CONFIRMED');
  eq('r6 evidence policy', fin.evidence.policy, 'DAY');
  eq('r6 evidence zero active', fin.evidence.activeCanonicalTasks, 0);
  eq('r6 evidence zero pending', fin.evidence.pendingControlWork, 0);
  eq('r6 evidence hibernateRequested', fin.evidence.hibernateRequested, true);
  eq('r6 evidence powerAction', fin.evidence.powerAction, 'HIBERNATE');
  eq('r6 action type', fin.actions[0].type, 'REQUEST_HIBERNATE');
  eq('r6 evidence graceMs', fin.evidence.graceMs, CONFIG.dayGraceMs);
  tru('r6 evidence checkedAt', Number.isFinite(Date.parse(fin.evidence.checkedAt)));
  eq('r6 state requested', fin.state, 'HIBERNATE_REQUESTED');
}

// ---- regression 6b: hibernate UNAVAILABLE -> fail closed, NO Sleep, zero dispatch -------
{
  const S = mkStateDir();
  mkSession(S, 1030, 'COMPLETED');
  const deps = fakeDeps({ userIdleMs: 30 * MIN, hibernate: false });
  const rt = createSupervisorRuntime({ config: CONFIG, stateDir: S, deps, clock: () => at(12, 30).getTime() });
  const t = rt.oneTick();
  eq('r6b human gate', t.state, 'HUMAN_GATE_REQUIRED');
  eq('r6b zero OS calls (no Sleep fallback)', deps.calls.length, 0);
  eq('r6b no evidence persisted', readHibernateEvidence({ stateDir: S }).evidence, null);
}

// ---- regression 7: DAY + userIdle < 20m -> WAIT_USER_IDLE, no hibernate ----------------------
{
  const S = mkStateDir();
  const sup = createIdleSupervisor({ config: CONFIG, stateDir: S });
  const t = at(12, 0);
  const r = sup.tick({ activity: scanAt(S, t), userIdleMs: 19 * MIN, now: t.getTime() });
  eq('r7 state', r.state, 'WAIT_USER_IDLE');
  eq('r7 no actions', r.actions.length, 0);
}

// ---- regression 8: DAY + userIdle >= 20m + no active work -> hibernate once -------------------
{
  const S = mkStateDir();
  const deps = fakeDeps({ userIdleMs: 20 * MIN });
  const rt = createSupervisorRuntime({ config: CONFIG, stateDir: S, deps, clock: () => at(12, 30).getTime() });
  const t = rt.oneTick();
  eq('r8 state', t.state, 'HIBERNATE_REQUESTED');
  eq('r8 hibernate exactly once', deps.calls.length, 1);
  eq('r8 fake executor only', deps.calls[0].action, 'HIBERNATE');
  eq('r8 evidence persisted before OS call', readHibernateEvidence({ stateDir: S }).evidence.event, 'HIBERNATE_IDLE_CONFIRMED');
}

// ---- regression 9: NIGHT 00:01 clean -> countdown 10m ------------------------------------
{
  const S = mkStateDir();
  const sup = createIdleSupervisor({ config: CONFIG, stateDir: S });
  const t0 = at(0, 1);
  eq('r9 starts countdown', sup.tick({ activity: scanAt(S, t0), userIdleMs: 0, now: t0.getTime() }).state, 'IDLE_COUNTDOWN');
  const t9 = at(0, 10, 59); // 9m59s later
  eq('r9 still countdown at 9m59', sup.tick({ activity: scanAt(S, t9), userIdleMs: 0, now: t9.getTime() }).state, 'IDLE_COUNTDOWN');
  const t10 = at(0, 11); // 10m
  eq('r9 eligible at 10m', sup.tick({ activity: scanAt(S, t10), userIdleMs: 0, now: t10.getTime() }).state, 'HIBERNATE_ELIGIBLE');
}

// ---- regression 10: NIGHT ignores fresh user activity ------------------------------------
{
  const S = mkStateDir();
  const sup = createIdleSupervisor({ config: CONFIG, stateDir: S });
  const t0 = at(1, 0);
  sup.tick({ activity: scanAt(S, t0), userIdleMs: 0, now: t0.getTime() });
  const t1 = at(1, 5);
  sup.tick({ activity: scanAt(S, t1), userIdleMs: 30 * 1000, now: t1.getTime() }); // user active 30s ago
  const t2 = at(1, 10);
  eq('r10 night grace holds with user activity', sup.tick({ activity: scanAt(S, t2), userIdleMs: 5 * MIN, now: t2.getTime() }).state, 'HIBERNATE_ELIGIBLE');
}

// ---- regression 11: task appears during night countdown -> reset --------------------------
{
  const S = mkStateDir();
  mkSession(S, 1016, 'EXECUTING');
  const sup = createIdleSupervisor({ config: CONFIG, stateDir: S });
  const t0 = at(2, 0);
  sup.tick({ activity: scanAt(S, t0), userIdleMs: 0, now: t0.getTime() });
  const t5 = at(2, 5); // 5m clean... but a NEW task just appeared
  eq('r11 new task active', scanAt(S, t5).activeCanonicalTasks, 1);
  eq('r11 busy', sup.tick({ activity: scanAt(S, t5), userIdleMs: 0, now: t5.getTime() }).state, 'BUSY');
  rmSession(S, 1016);
  const t6 = at(2, 10); // 0m of clean window since the reset
  eq('r11 countdown restarted', sup.tick({ activity: scanAt(S, t6), userIdleMs: 0, now: t6.getTime() }).state, 'IDLE_COUNTDOWN');
  const t15 = at(2, 25); // 15m after reset (> 10m grace)
  eq('r11 eligible after fresh 10m', sup.tick({ activity: scanAt(S, t15), userIdleMs: 0, now: t15.getTime() }).state, 'HIBERNATE_ELIGIBLE');
}

// ---- regression 12: 05:59 still NIGHT policy ----------------------------------------------
{
  const S = mkStateDir();
  const sup = createIdleSupervisor({ config: CONFIG, stateDir: S });
  const t0 = at(5, 50);
  eq('r12 countdown at 05:50', sup.tick({ activity: scanAt(S, t0), userIdleMs: 0, now: t0.getTime() }).state, 'IDLE_COUNTDOWN');
  const t1 = at(5, 59); // 9m into night grace; DAY would need 20m user idle
  eq('r12 05:59 still night countdown', sup.tick({ activity: scanAt(S, t1), userIdleMs: 9 * MIN, now: t1.getTime() }).state, 'IDLE_COUNTDOWN');
}

// ---- regression 13: 06:00 flips to DAY policy ----------------------------------------------
{
  const S = mkStateDir();
  const sup = createIdleSupervisor({ config: CONFIG, stateDir: S });
  const t0 = at(5, 50);
  sup.tick({ activity: scanAt(S, t0), userIdleMs: 0, now: t0.getTime() });
  const t1 = at(6, 0); // DAY now: night countdown irrelevant; user idle 8h >= 20m
  eq('r13 day flip eligible', sup.tick({ activity: scanAt(S, t1), userIdleMs: 8 * 60 * MIN, now: t1.getTime() }).state, 'HIBERNATE_ELIGIBLE');
  const sup2 = createIdleSupervisor({ config: CONFIG, stateDir: mkStateDir() });
  sup2.tick({ activity: scanAt(S, t0), userIdleMs: 0, now: t0.getTime() });
  eq('r13 day flip needs user idle', sup2.tick({ activity: scanAt(S, t1), userIdleMs: 5 * MIN, now: t1.getTime() }).state, 'WAIT_USER_IDLE');
}

// ---- regression 14: final read-back sees active work -> abort -------------------------------
{
  const S = mkStateDir();
  mkSession(S, 1017, 'EXECUTING');
  const sup = createIdleSupervisor({ config: CONFIG, stateDir: S });
  const t0 = at(13, 0);
  eq('r14 busy first', sup.tick({ activity: scanAt(S, t0), userIdleMs: 30 * MIN, now: t0.getTime() }).state, 'BUSY');
  rmSession(S, 1017);
  const t1 = at(13, 30);
  const r = sup.tick({ activity: scanAt(S, t1), userIdleMs: 30 * MIN, now: t1.getTime() });
  eq('r14 eligible', r.state, 'HIBERNATE_ELIGIBLE');
  mkSession(S, 1018, 'VERIFYING'); // appears between eligibility and final read-back
  const fin = r.finalize(scanAt(S, t1));
  eq('r14 aborted', fin.ok, false);
  eq('r14 abort code', fin.code, 'HIBERNATE_ABORTED_ACTIVE_WORK');
  eq('r14 no evidence written', readHibernateEvidence({ stateDir: S }).evidence, null);
  rmSession(S, 1018);
}

// ---- regression 15: UNKNOWN canonical state -> HIBERNATE_DENIED_UNKNOWN_ACTIVITY ------------
{
  const S = mkStateDir();
  writeFileSync(path.join(S, 'sessions', 'corrupt.json'), '{not json', 'utf8'); // unreadable
  const t = at(14, 0);
  const a = scanAt(S, t);
  eq('r15 unknown flagged', a.known, false);
  const sup = createIdleSupervisor({ config: CONFIG, stateDir: S });
  const r = sup.tick({ activity: a, userIdleMs: 60 * MIN, now: t.getTime() });
  eq('r15 denied', r.state, 'HIBERNATE_DENIED_UNKNOWN_ACTIVITY');
  eq('r15 no actions', r.actions.length, 0);
  // unknown canonical state VALUE on a well-formed record
  mkSession(S, 1019, 'SOMETHING_ELSE');
  eq('r15b unknown flagged', scanAt(S, at(14, 5)).known, false);
}

// ---- regression 16: supervisor restart -> no duplicate Hibernate ----------------------------
{
  const S = mkStateDir();
  const t0 = at(15, 0);
  const sup1 = createIdleSupervisor({ config: CONFIG, stateDir: S });
  const r = sup1.tick({ activity: scanAt(S, t0), userIdleMs: 30 * MIN, now: t0.getTime() });
  const fin = r.finalize(scanAt(S, t0)); // evidence persisted; "crash" before dispatch
  eq('r16 first request ok', fin.ok, true);
  const deps = fakeDeps({ userIdleMs: 60 * MIN });
  const rt = createSupervisorRuntime({ config: CONFIG, stateDir: S, deps, clock: () => at(15, 30).getTime() });
  const t = rt.oneTick(); // restarted supervisor must NOT re-fire the pending request
  eq('r16 suppressed state', t.state, 'HIBERNATE_REQUESTED');
  eq('r16 no second OS call', deps.calls.length, 0);
}

// ---- regression 17: wake/resume -> reinit health/read-back before monitoring ---------------
{
  const S = mkStateDir();
  persistHibernateEvidence({ stateDir: S, evidence: {
    schemaVersion: IDLE_SUPERVISOR_SCHEMA_VERSION, event: 'HIBERNATE_IDLE_CONFIRMED',
    policy: 'NIGHT', activeCanonicalTasks: 0, pendingControlWork: 0, userIdleMs: null,
    graceMs: CONFIG.nightGraceMs, checkedAt: at(0, 20).toISOString(),
    hibernateRequested: true, requestedAt: at(0, 20).toISOString(), result: null,
  } });
  let now = at(0, 30).getTime();
  const deps = fakeDeps({ userIdleMs: 0 });
  const rt = createSupervisorRuntime({ config: CONFIG, stateDir: S, deps, clock: () => now });
  const t1 = rt.oneTick(); // pending evidence from before "hibernate" -> no new request
  eq('r17 pending held', t1.state, 'HIBERNATE_REQUESTED');
  now += 10 * MIN; // 10m with no tick = machine was hibernating and just resumed
  const t2 = rt.oneTick(); // resume gap -> reinit: evidence result + fresh windows
  eq('r17 reinit -> fresh countdown', t2.state, 'IDLE_COUNTDOWN');
  eq('r17 resume result recorded', readHibernateEvidence({ stateDir: S }).evidence.result, 'HIBERNATE_RESUMED');
  eq('r17 no OS call after wake until re-eligible', deps.calls.length, 0);
}

// ---- regression 17b: legacy sleepRequested evidence still honors exactly-once --------------
{
  const S = mkStateDir();
  persistHibernateEvidence({ stateDir: S, evidence: {
    schemaVersion: IDLE_SUPERVISOR_SCHEMA_VERSION, event: 'SLEEP_IDLE_CONFIRMED',
    powerAction: 'SLEEP', policy: 'NIGHT', activeCanonicalTasks: 0, pendingControlWork: 0,
    userIdleMs: null, graceMs: CONFIG.nightGraceMs, checkedAt: at(0, 20).toISOString(),
    sleepRequested: true, requestedAt: at(0, 20).toISOString(), result: null,
  } });
  const deps = fakeDeps({ userIdleMs: 0 });
  const rt = createSupervisorRuntime({ config: CONFIG, stateDir: S, deps, clock: () => at(0, 30).getTime() });
  eq('r17b pending suppressed after upgrade', rt.oneTick().state, 'HIBERNATE_REQUESTED');
  eq('r17b no dispatch of a legacy pending request', deps.calls.length, 0);
}

// ---- regression 18: processes exist but no canonical active work -> NOT active -------------
{
  // A Soc_brain/OpenCode process may be alive, but its canonical execution
  // record was never terminalized and is hours old -> STALE projection, not
  // work. The supervisor has NO process-list API: authority stays canonical.
  const S = mkStateDir();
  mkSession(S, 1020, 'SESSION_ACTIVE');
  const t = at(17, 0);
  mkExec(S, 1020, { pid: 424242, startedAt: new Date(t.getTime() - 6 * 60 * 60 * 1000).toISOString(), finalized: false });
  const a = scanAt(S, t, () => false); // canonical-record liveness projection only
  eq('r18 stale exec not active', a.activeCanonicalTasks, 0);
  eq('r18 known', a.known, true);
  const sup = createIdleSupervisor({ config: CONFIG, stateDir: S });
  eq('r18 eligible', sup.tick({ activity: a, userIdleMs: 30 * MIN, now: t.getTime() }).state, 'HIBERNATE_ELIGIBLE');
}

// ---- regression 19: supervisor never mutates canonical/GitHub state ------------------------
{
  const S = mkStateDir();
  mkSession(S, 1021, 'COMPLETED');
  const before = snapshot(S, ['idle-supervisor']);
  const deps = fakeDeps({ userIdleMs: 60 * MIN });
  const rt = createSupervisorRuntime({ config: CONFIG, stateDir: S, deps, clock: () => at(18, 0).getTime() });
  rt.oneTick();
  rt.oneTick();
  isEq('r19 canonical tree untouched', snapshot(S, ['idle-supervisor']), before);
  tru('r19 evidence confined to idle-supervisor dir',
    fs.existsSync(path.join(S, 'idle-supervisor', 'hibernate-evidence.json')));
}

// ---- regression 20: low resource footprint -------------------------------------------------
{
  const S = mkStateDir();
  const deps = fakeDeps({ userIdleMs: 60 * MIN });
  const rt = createSupervisorRuntime({ config: CONFIG, stateDir: S, deps, clock: () => at(19, 0).getTime() });
  const start = process.memoryUsage().rss;
  for (let i = 0; i < 200; i++) rt.oneTick(); // 200 ticks ~= 100 min of 30s polls
  const growth = process.memoryUsage().rss - start;
  tru('r20 stable memory across 200 ticks (growth < 8MB)', growth < 8 * 1024 * 1024);
  eq('r20 cooldown: one hibernate decision per window, no spam', deps.calls.length, 1);
  results.push({ name: 'r20 rss report', pass: true, info: `rss=${(start / 1048576).toFixed(1)}MB growth=${(growth / 1048576).toFixed(2)}MB` });
}

// ---- helpers --------------------------------------------------------------------------------
function snapshot(root, skip) {
  const out = {};
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { try { out[p] = fs.readFileSync(p, 'utf8'); } catch { out[p] = '<unreadable>'; } }
    }
  };
  walk(root);
  return out;
}

// ---- companion spawn guard (inert without explicit enable / valid entry) -------------
eq('companion spawn: no env -> null', spawnIdleSupervisor({ repoRoot: TMP, env: {} }), null);
eq('companion spawn: enabled but no entry -> null',
  spawnIdleSupervisor({ repoRoot: path.join(TMP, 'no-such-root'), env: { SOC_IDLE_HIBERNATE: '1' } }), null);

// ---- summary --------------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
for (const r of results) {
  process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}${r.info ? ` (${r.info})` : ''}\n`);
}
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
