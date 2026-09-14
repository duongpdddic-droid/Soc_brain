#!/usr/bin/env node
// executor-liveness-lease.test.mjs — Issue #172 F1 production liveness-regression.
// Deterministic, ZERO real OS power: drives the REAL production registration path
// (the same createExecutorLiveness the MCP broker entry point uses in main()) and
// the REAL supervisor reader/runtime with injected PID-reuse-safe liveness probes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import {
  createExecutorLiveness, publishExecutorLease, retireExecutorLease, activityLeasePathFor,
  ACTIVITY_LEASE_SUBDIR,
} from '../packages/runtime-sandbox/activity-lease.mjs';
import { scanCanonicalActivity, createIdleSupervisor, IDLE_SUPERVISOR_SCHEMA_VERSION } from '../packages/idle-supervisor/idle-supervisor.mjs';
import { createSupervisorRuntime } from '../packages/idle-supervisor/run.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

const results = [];
const eq = (n, g, w) => results.push({ name: n, pass: g === w });
const tru = (n, g) => results.push({ name: n, pass: Boolean(g) });

const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-liveness-'));
const CANON = 'duongpdddic-droid/Soc_brain';
const MIN = 60 * 1000;
const DAY0 = new Date(2026, 8, 10);
const at = (h, m, s = 0) => { const d = new Date(DAY0); d.setHours(h, m, s, 0); return d; };
const CONFIG = {
  schemaVersion: IDLE_SUPERVISOR_SCHEMA_VERSION, enabled: true,
  dayGraceMs: 20 * MIN, nightGraceMs: 10 * MIN, nightStart: { h: 0, m: 0 }, nightEnd: { h: 6, m: 0 },
  pollSec: 30, allowRealHibernate: false, stateDir: null,
};
const PST = 134337708316584740;

let c = 0;
function mkState() { const d = path.join(TMP, `s-${++c}`); mkdirSync(path.join(d, 'sessions'), { recursive: true }); return d; }
function mkId(issue) { return identityHash({ repo: CANON, issueNumber: issue }); }
const aliveOf = (set) => (p) => set.includes(p);
const startOf = (map) => (p) => (Object.prototype.hasOwnProperty.call(map, p) ? { pid: p, processStartTime: map[p] } : null);
const scanOf = (S, now, deps, bootId = 'boot-1') => scanCanonicalActivity({
  stateDir: S, clock: () => now.getTime(), isAlive: deps.isAlive, readStartTime: deps.readStartTime, bootId,
});
const leaseFileCount = (S) => { try { return readdirSync(path.join(S, ACTIVITY_LEASE_SUBDIR)).filter((n) => n.endsWith('.json')).length; } catch { return 0; } };

// ---- R-F1A: real registration path creates the lease -> supervisor BUSY (no ledger) --------
{
  const S = mkState();
  const id = mkId(17290);
  const deps = { isAlive: aliveOf([70001]), readStartTime: startOf({ 70001: PST }) };
  const lv = createExecutorLiveness({ stateDir: S, identityHash: id, pid: 70001, processStartTime: PST, bootId: 'boot-1', deps });
  const started = lv.start();
  eq('R-F1A publish ok', started.ok, true);
  tru('R-F1A lease on disk', fs.existsSync(activityLeasePathFor({ stateDir: S, identityHash: id })));
  const a = scanOf(S, at(12, 0), deps);
  tru('R-F1A liveExecutors>=1', a.liveExecutors >= 1);
  tru('R-F1A pending>=1', a.pendingControlWork >= 1);
  eq('R-F1A known', a.known, true);
  eq('R-F1A canonical sessions active 0', a.activeCanonicalTasks, 0); // lease-only, no lifecycle record
  const sup = createIdleSupervisor({ config: CONFIG, stateDir: S });
  eq('R-F1A supervisor BUSY', sup.tick({ activity: a, userIdleMs: 60 * MIN, now: at(12, 0).getTime() }).state, 'BUSY');
}

// ---- R-F1B: unattended NIGHT, operator idle high, ONLY a live lease -> zero hibernate -------
{
  const S = mkState();
  const id = mkId(17291);
  const deps = { isAlive: aliveOf([70002]), readStartTime: startOf({ 70002: PST }) };
  createExecutorLiveness({ stateDir: S, identityHash: id, pid: 70002, processStartTime: PST, bootId: 'boot-1', deps }).start();
  const rdeps = {
    readUserIdleMs: () => 30 * MIN, readBootId: () => 'boot-1', // operator genuinely away (F2 satisfied)
    isAlive: deps.isAlive, readProcessStartTime: deps.readStartTime,
    checkHibernateAvailable: () => ({ ok: true }),
    calls: [], requestHibernate() { this.calls.push(1); return { ok: true, action: 'HIBERNATE' }; },
  };
  let now = at(0, 1).getTime();
  const rt = createSupervisorRuntime({ config: CONFIG, stateDir: S, deps: rdeps, clock: () => now, bootId: 'boot-1' });
  let st = null;
  for (let i = 0; i < 30; i++) { now += 30 * 1000; st = rt.oneTick().state; } // >15m of clean
  eq('R-F1B BUSY purely from liveness', st, 'BUSY');
  eq('R-F1B zero hibernate (only because executor liveness is visible)', rdeps.calls.length, 0);
}

// ---- R-F1C: heartbeat preserves identity; no duplicate owner; live owner not clobbered -----
{
  const S = mkState();
  const id = mkId(17292);
  const deps = { isAlive: aliveOf([70003]), readStartTime: startOf({ 70003: PST }) };
  let t = at(3, 0).getTime();
  const lv = createExecutorLiveness({ stateDir: S, identityHash: id, pid: 70003, processStartTime: PST, bootId: 'boot-1', deps, now: () => t });
  const s1 = lv.start(); t += 60 * 1000;
  const hb = lv.heartbeat();
  eq('R-F1C publish + heartbeat ok', s1.ok && hb.ok, true);
  const rec = JSON.parse(fs.readFileSync(activityLeasePathFor({ stateDir: S, identityHash: id }), 'utf8'));
  eq('R-F1C identity pid preserved', rec.pid, 70003);
  eq('R-F1C identity startTime preserved', rec.processStartTime, PST);
  eq('R-F1C single lease owner', leaseFileCount(S), 1);
  // a different live pid cannot clobber the current owner's lease (no second owner)
  const foreign = publishExecutorLease({ stateDir: S, identity: { identityHash: id, pid: 70999, processStartTime: 999, bootId: 'boot-1' }, now: () => t, deps });
  eq('R-F1C foreign publish refused', foreign.ok, false);
  eq('R-F1C reason', foreign.reason, 'LEASE_HELD_BY_LIVE_INCARNATION');
  eq('R-F1C still single lease', leaseFileCount(S), 1);
  tru('R-F1C owner untouched by foreign', JSON.parse(fs.readFileSync(activityLeasePathFor({ stateDir: S, identityHash: id }), 'utf8')).pid === 70003);
}

// ---- R-F1D: proven terminal cleanup retires the lease; scan may go idle --------------------
{
  const S = mkState();
  const id = mkId(17293);
  const deps = { isAlive: aliveOf([70004]), readStartTime: startOf({ 70004: PST }) };
  const lv = createExecutorLiveness({ stateDir: S, identityHash: id, pid: 70004, processStartTime: PST, bootId: 'boot-1', deps });
  lv.start();
  tru('R-F1D busy while live', scanOf(S, at(12, 0), deps).liveExecutors >= 1);
  const ret = lv.retire();
  eq('R-F1D retire released', ret.released, true);
  eq('R-F1D lease gone', fs.existsSync(activityLeasePathFor({ stateDir: S, identityHash: id })), false);
  const a = scanOf(S, at(12, 0), deps);
  eq('R-F1D idle after retire (liveExecutors 0)', a.liveExecutors, 0);
  eq('R-F1D known true', a.known, true);
  const sup = createIdleSupervisor({ config: CONFIG, stateDir: S });
  eq('R-F1D eligible after terminal', sup.tick({ activity: a, userIdleMs: 60 * MIN, now: at(12, 0).getTime() }).state, 'HIBERNATE_ELIGIBLE');
}

// ---- R-F1E: pid reuse cannot keep BUSY; stale retire cannot delete a newer lease ------------
{
  const S = mkState();
  const id = mkId(17294);
  // a foreign process now owns the recorded pid (different start time): REUSED -> not trusted
  const deps = { isAlive: aliveOf([70005]), readStartTime: startOf({ 70005: 999999 }) }; // mismatch
  publishExecutorLease({ stateDir: S, identity: { identityHash: id, pid: 70005, processStartTime: PST, bootId: 'boot-1' }, deps, now: () => at(12, 0).getTime() });
  const a = scanOf(S, at(12, 0), deps);
  eq('R-F1E reused pid not counted', a.liveExecutors, 0);
  eq('R-F1E reused pid known true', a.known, true); // proven ended, not ambiguous
  // retire from a stale incarnation must NOT delete a newer live lease
  const S2 = mkState(); const id2 = mkId(17295);
  const deps2 = { isAlive: aliveOf([70010]), readStartTime: startOf({ 70010: PST }) };
  publishExecutorLease({ stateDir: S2, identity: { identityHash: id2, pid: 70010, processStartTime: PST, bootId: 'boot-1' }, deps: deps2, now: () => at(12, 0).getTime() });
  const stale = retireExecutorLease({ stateDir: S2, identityHash: id2, pid: 70011, processStartTime: 8, deps: deps2 });
  eq('R-F1E stale retire is a no-op', stale.released, false);
  eq('R-F1E stale reason', stale.reason, 'LEASE_NOT_OWNER');
  tru('R-F1E newer lease survives', fs.existsSync(activityLeasePathFor({ stateDir: S2, identityHash: id2 })));
}

// ---- R-F1F: unresolved ownership -> deny until identity-safe proof (GONE / LIVE / terminal) --
{
  const S = mkState();
  const id = mkId(17296);
  const leaseIdentity = { identityHash: id, pid: 70020, processStartTime: PST, bootId: 'boot-1' };
  // (1) alive pid but probe cannot confirm identity -> UNPROVEN -> UNKNOWN/deny
  publishExecutorLease({ stateDir: S, identity: leaseIdentity, now: () => at(12, 0).getTime(), deps: { isAlive: aliveOf([70020]), readStartTime: () => null } });
  const a1 = scanOf(S, at(12, 0), { isAlive: aliveOf([70020]), readStartTime: () => null });
  eq('R-F1F unproven -> deny (known false)', a1.known, false);
  eq('R-F1F denied state', createIdleSupervisor({ config: CONFIG, stateDir: S }).tick({ activity: a1, userIdleMs: 60 * MIN, now: at(12, 0).getTime() }).state, 'HIBERNATE_DENIED_UNKNOWN_ACTIVITY');
  // (2) identity-safe reconciliation proves LIVE -> BUSY
  const a2 = scanOf(S, at(12, 0), { isAlive: aliveOf([70020]), readStartTime: startOf({ 70020: PST }) });
  eq('R-F1F proven-live -> BUSY', createIdleSupervisor({ config: CONFIG, stateDir: S }).tick({ activity: a2, userIdleMs: 60 * MIN, now: at(12, 0).getTime() }).state, 'BUSY');
  // (3) identity-safe reconciliation proves GONE (pid dead) -> idle allowed
  const a3 = scanOf(S, at(12, 0), { isAlive: () => false, readStartTime: () => null });
  eq('R-F1F proven-gone -> not counted', a3.liveExecutors, 0);
  eq('R-F1F proven-gone -> known true', a3.known, true);
  eq('R-F1F proven-gone -> eligible', createIdleSupervisor({ config: CONFIG, stateDir: S }).tick({ activity: a3, userIdleMs: 60 * MIN, now: at(12, 0).getTime() }).state, 'HIBERNATE_ELIGIBLE');
}

// ---- R-F1G: unreadable/corrupt lease -> deny ------------------------------------------------
{
  const S = mkState();
  const dir = path.join(S, 'activity', 'live'); mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${mkId(17297)}.json`), '{not json', 'utf8');
  const a = scanOf(S, at(12, 0), { isAlive: () => true, readStartTime: () => null });
  eq('R-F1G corrupt lease -> deny', a.known, false);
  tru('R-F1G corrupt reason recorded', a.unknown.some((u) => /LEASE/.test(u.reason)));
}

// ---- static: the production broker entry wires the SAME createExecutorLiveness path ---------
{
  const src = fs.readFileSync(path.join(process.cwd(), 'packages', 'runtime-sandbox', 'mcp-server.mjs'), 'utf8');
  tru('mcp-server imports createExecutorLiveness', /createExecutorLiveness/.test(src));
  tru('mcp-server registers at authoritative bind (main)', /liveness\.start\(\)/.test(src));
  tru('mcp-server heartbeats on request', /liveness\.heartbeat\(\)/.test(src));
  tru('mcp-server retires on exit/stdend', /retireLiveness/.test(src) && /liveness\.retire\(\)/.test(src));
  tru('mcp-server exposes identityHash/stateDir for lease', /identityHash: s\.identityHash|identityHash: identityHash\(/.test(src) && /stateDir:/.test(src));
  tru('activity-lease has no idle-supervisor import (no cycle)', !/from\s+['"][^'"]*idle-supervisor/.test(fs.readFileSync(path.join(process.cwd(), 'packages', 'runtime-sandbox', 'activity-lease.mjs'), 'utf8')));
}

const failed = results.filter((r) => !r.pass);
for (const r of results) process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}${r.info ? ` (${r.info})` : ''}\n`);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
