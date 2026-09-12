#!/usr/bin/env node
// idle-supervisor-singleton.test.mjs — machine-GLOBAL singleton ownership for the
// Idle Sleep Supervisor. Deterministic: a real temp machineDir + injected
// liveness/boot deps; NO real OS call, NEVER the production machine namespace
// (every case passes an explicit temp machineDir or SOC_IDLE_SUPERVISOR_MACHINE_DIR).
// Ownership is keyed on the machine namespace — NOT on stateDir/cwd/worktree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { readIdleSleepConfig, IDLE_SUPERVISOR_SCHEMA_VERSION } from '../packages/idle-supervisor/idle-supervisor.mjs';
import {
  createSupervisorOwnership, supervisorLockPathFor, reclaimLeasePathFor, machineSupervisorDir,
  liveSupervisorOwner, spawnIdleSupervisor, createSupervisorRuntime,
} from '../packages/idle-supervisor/run.mjs';

const results = [];
const eq = (n, g, w) => results.push({ name: n, pass: g === w });
const tru = (n, g) => results.push({ name: n, pass: Boolean(g) });

const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-idle-sing-'));
let counter = 0;
// Machine namespace (the singleton key) and per-repo stateDir are INDEPENDENT:
// freshMachine() = one machine; freshState() = one repo/worktree's state dir.
function freshMachine() { const d = path.join(TMP, `mach-${++counter}`); mkdirSync(d, { recursive: true }); return d; }
function freshState() { const d = path.join(TMP, `st-${++counter}`); mkdirSync(path.join(d, 'sessions'), { recursive: true }); return d; }

// Mutable liveness world: pid -> current Win32 processStartTime. Absence => dead.
function world(bootId = 'boot-1', initial = {}) {
  const alive = { ...initial };
  const has = (p) => Object.prototype.hasOwnProperty.call(alive, p);
  const deps = {
    readBootId: () => bootId,
    isAlive: (p) => has(p),
    readProcessStartTime: (p) => (has(p) ? { pid: p, processStartTime: alive[p] } : null),
  };
  return { deps, alive, bootId };
}
function own(machineDir, opts) { return createSupervisorOwnership({ machineDir, ...opts }); }
function lockPath(machineDir) { return supervisorLockPathFor({ machineDir }); }
function readLock(machineDir) { try { return JSON.parse(fs.readFileSync(lockPath(machineDir), 'utf8')); } catch { return null; } }
function seedLock(machineDir, owner) { writeFileSync(lockPath(machineDir), JSON.stringify(owner, null, 2) + '\n'); }

// ---- regression S1: first acquirer claims; record carries all fields ----------
{
  const M = freshMachine(); const S = freshState(); const w = world('boot-1', { 1001: 5000 });
  const o = own(M, { stateDir: S, deps: w.deps, bootId: 'boot-1', pid: 1001, cwd: 'C:\\wt\\main' });
  const r = o.acquire();
  eq('S1 acquired', r.status, 'ACQUIRED');
  eq('S1 ok', r.ok, true);
  const L = readLock(M);
  tru('S1 lock pid', L && L.pid === 1001);
  eq('S1 lock processStartTime', L.processStartTime, 5000);
  eq('S1 lock bootId', L.bootId, 'boot-1');
  eq('S1 lock cwd', L.cwd, 'C:\\wt\\main');
  eq('S1 lock stateDir metadata', L.stateDir, path.resolve(S));
  tru('S1 lock acquiredAt iso', Number.isFinite(Date.parse(L.acquiredAt)));
  eq('S1 lock schemaVersion', L.schemaVersion, IDLE_SUPERVISOR_SCHEMA_VERSION);
}

// ---- regression S2: concurrent start x2 -> exactly one owner; 2nd harmless ----
{
  const M = freshMachine(); const w = world('boot-1', { 2001: 10, 2002: 20 });
  const A = own(M, { deps: w.deps, bootId: 'boot-1', pid: 2001, cwd: 'wt-A' });
  const B = own(M, { deps: w.deps, bootId: 'boot-1', pid: 2002, cwd: 'wt-B' });
  const ra = A.acquire(); const rb = B.acquire();
  eq('S2 first owns', ra.status, 'ACQUIRED');
  eq('S2 second already-running', rb.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S2 second not ok', rb.ok, false);
  eq('S2 second reports live owner pid', rb.owner && rb.owner.pid, 2001);
  eq('S2 single owner in lock', readLock(M).pid, 2001);
  tru('S2 foreign live lock NOT unlinked by second', fs.existsSync(lockPath(M)));
}

// ---- regression S3: main + worktree (DIFFERENT stateDirs, same machine) --------
{
  const M = freshMachine(); const Smain = freshState(); const Swt = freshState();
  const w = world('boot-1', { 3001: 100, 3002: 200 });
  own(M, { stateDir: Smain, deps: w.deps, bootId: 'boot-1', pid: 3001, cwd: 'C:\\wt\\main\\packages' }).acquire();
  const r2 = own(M, { stateDir: Swt, deps: w.deps, bootId: 'boot-1', pid: 3002, cwd: 'C:\\wt\\agent\\4efa\\packages' }).acquire();
  eq('S3 worktree with its own stateDir does NOT fork a supervisor', r2.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S3 owner is the main-checkout daemon', readLock(M).pid, 3001);
  tru('S3 lock NOT under either stateDir', !fs.existsSync(supervisorLockPathFor({ machineDir: Smain })) && !fs.existsSync(supervisorLockPathFor({ machineDir: Swt })));
  eq('S3 lock path is machine-global', lockPath(M), path.join(M, 'supervisor.lock'));
}

// ---- regression S4: stale DEAD pid -> controlled reclaim ----------------------
{
  const M = freshMachine(); seedLock(M, { schemaVersion: '1', pid: 4001, processStartTime: 999, bootId: 'boot-1', cwd: 'x', acquiredAt: new Date(0).toISOString() });
  const w = world('boot-1', { 4002: 10 }); // 4001 absent => dead
  const r = own(M, { deps: w.deps, bootId: 'boot-1', pid: 4002, cwd: 'y' }).acquire();
  eq('S4 dead-owner reclaimed', r.status, 'ACQUIRED');
  eq('S4 new owner recorded', readLock(M).pid, 4002);
}

// ---- regression S5: PID REUSE (alive pid, different startTime) -> reclaim -----
{
  const M = freshMachine(); seedLock(M, { schemaVersion: '1', pid: 5001, processStartTime: 111, bootId: 'boot-1', cwd: 'x', acquiredAt: new Date(0).toISOString() });
  const w = world('boot-1', { 5001: 999, 5002: 10 }); // 5001 alive but recycled to 999 (reuse)
  const r = own(M, { deps: w.deps, bootId: 'boot-1', pid: 5002, cwd: 'y' }).acquire();
  eq('S5 pid-reuse is stale -> reclaim', r.status, 'ACQUIRED');
  eq('S5 reclaimed by new pid', readLock(M).pid, 5002);
}

// ---- regression S6: REBOOT / bootId mismatch -> reclaim (even live pid) -------
{
  const M = freshMachine(); seedLock(M, { schemaVersion: '1', pid: 6001, processStartTime: 111, bootId: 'boot-OLD', cwd: 'x', acquiredAt: new Date(0).toISOString() });
  const w = world('boot-NEW', { 6001: 111, 6002: 10 }); // same pid AND same startTime, but new boot
  const r = own(M, { deps: w.deps, bootId: 'boot-NEW', pid: 6002, cwd: 'y' }).acquire();
  eq('S6 bootId mismatch is stale -> reclaim', r.status, 'ACQUIRED');
  eq('S6 reclaimed by post-reboot daemon', readLock(M).pid, 6002);
}

// ---- regression S7: parent launcher exit / detached owner stays valid ---------
{
  // Ownership liveness is pid/startTime/bootId based, NOT parent-based. A
  // detached owner whose pid is alive is never reclaimed by a second daemon.
  const M = freshMachine(); const w = world('boot-1', { 7001: 10, 7002: 20 });
  own(M, { deps: w.deps, bootId: 'boot-1', pid: 7001, cwd: 'wt' }).acquire(); // owner (its launcher parent has exited)
  const r = own(M, { deps: w.deps, bootId: 'boot-1', pid: 7002, cwd: 'wt2' }).acquire();
  eq('S7 detached live owner not stolen', r.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S7 owner unchanged', readLock(M).pid, 7001);
  eq('S7 probe sees the detached live owner', liveSupervisorOwner({ machineDir: M, deps: w.deps }) && liveSupervisorOwner({ machineDir: M, deps: w.deps }).pid, 7001);
}

// ---- regression S8: clean release removes the lock the process owns -----------
{
  const M = freshMachine(); const w = world('boot-1', { 8001: 10 });
  const o = own(M, { deps: w.deps, bootId: 'boot-1', pid: 8001, cwd: 'wt' });
  o.acquire(); const r = o.release();
  eq('S8 release reports removed', r.released, true);
  eq('S8 lock gone', readLock(M), null);
}

// ---- regression S9: old owner cleanup must NOT delete a replacement owner -----
{
  const M = freshMachine(); const w = world('boot-1', { 9001: 10 });
  const old = own(M, { deps: w.deps, bootId: 'boot-1', pid: 9001, cwd: 'wt' });
  old.acquire();
  seedLock(M, { schemaVersion: '1', pid: 9002, processStartTime: 20, bootId: 'boot-1', cwd: 'repl', acquiredAt: new Date().toISOString() }); // replacement took over
  const r = old.release();
  eq('S9 old release refuses', r.released, false);
  eq('S9 reason NOT_CURRENT_OWNER', r.reason, 'NOT_CURRENT_OWNER');
  eq('S9 replacement lock intact', readLock(M).pid, 9002);
}

// ---- regression S10: concurrent stale reclaim -> final exactly one owner ------
{
  const M = freshMachine(); seedLock(M, { schemaVersion: '1', pid: 10001, processStartTime: 1, bootId: 'boot-1', cwd: 'x', acquiredAt: new Date(0).toISOString() });
  const w = world('boot-1', { 10002: 10, 10003: 20 }); // 10001 dead
  const b = own(M, { deps: w.deps, bootId: 'boot-1', pid: 10002, cwd: 'y' }).acquire();
  const c = own(M, { deps: w.deps, bootId: 'boot-1', pid: 10003, cwd: 'z' }).acquire();
  eq('S10 first reclaimer wins', b.status, 'ACQUIRED');
  eq('S10 second sees live owner', c.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S10 exactly one owner', readLock(M).pid, 10002);
}

// ---- regression S11: unreadable/blank lock is stale (no live owner to steal) ---
{
  const M = freshMachine(); writeFileSync(lockPath(M), '', 'utf8'); // torn/blank
  const w = world('boot-1', { 11002: 10 });
  const r = own(M, { deps: w.deps, bootId: 'boot-1', pid: 11002, cwd: 'y' }).acquire();
  eq('S11 blank lock reclaimed', r.status, 'ACQUIRED');
  eq('S11 owner recorded', readLock(M).pid, 11002);
}

// ---- regression S12: self re-acquire is idempotent (not a second owner) --------
{
  const M = freshMachine(); const w = world('boot-1', { 12001: 10 });
  const a = own(M, { deps: w.deps, bootId: 'boot-1', pid: 12001, cwd: 'wt' });
  const r1 = a.acquire(); const r2 = a.acquire();
  eq('S12 first acquire', r1.status, 'ACQUIRED');
  eq('S12 re-acquire by same pid is ALREADY_OWNER', r2.status, 'ALREADY_OWNER');
  eq('S12 owner unchanged', readLock(M).pid, 12001);
}

// ---- regression S13: reconciliation of 5 concurrent daemons (observed bug) -----
{
  const M = freshMachine();
  const w = world('boot-1', { 13001: 1, 13002: 2, 13003: 3, 13004: 4, 13005: 5 });
  const states = [freshState(), freshState(), freshState(), freshState(), freshState()]; // main + 4 worktrees
  const rs = states.map((S, i) => own(M, { stateDir: S, deps: w.deps, bootId: 'boot-1', pid: 13001 + i, cwd: `wt-${i}` }).acquire());
  eq('S13 exactly one ACQUIRED among 5', rs.filter((r) => r.status === 'ACQUIRED').length, 1);
  eq('S13 four exit already-running', rs.filter((r) => r.status === 'SUPERVISOR_ALREADY_RUNNING').length, 4);
  eq('S13 exactly one active daemon after reconciliation', Object.keys(readLock(M)).length > 0 && rs.filter((r) => r.ok).length, 1);
}

// ---- regression S14: launcher pre-spawn gate (worktree launch spawns nothing) ---
{
  const M = freshMachine(); const w = world('boot-1', { 14001: 7 });
  own(M, { deps: w.deps, bootId: 'boot-1', pid: 14001, cwd: 'main' }).acquire();
  const REPO = path.resolve(import.meta.dirname, '..'); // entry exists for real
  const spawned = [];
  const spawnImpl = (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { unref() {} }; };
  const env = { SOC_IDLE_SLEEP: '1', SOC_IDLE_SUPERVISOR_MACHINE_DIR: M };
  const r1 = spawnIdleSupervisor({ repoRoot: REPO, env, spawnImpl, deps: w.deps });
  eq('S14 live owner -> no second daemon spawned', r1, null);
  eq('S14 spawnImpl untouched', spawned.length, 0);
  delete w.alive[14001]; // owner dies
  spawnIdleSupervisor({ repoRoot: REPO, env, spawnImpl, deps: w.deps });
  eq('S14 stale owner -> daemon spawned', spawned.length, 1);
  tru('S14 spawned detached --daemon', spawned[0].args.includes('--daemon') && spawned[0].opts.detached === true);
  eq('S14 machineDir honored via env', machineSupervisorDir({ env: { SOC_IDLE_SUPERVISOR_MACHINE_DIR: M } }), path.resolve(M));
  eq('S14 production default is machine-global', machineSupervisorDir({ env: {} }), path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.soc-brain', 'machine', 'idle-supervisor'));
}

// ---- regression S15: liveSupervisorOwner probe is read-only --------------------
{
  const M = freshMachine();
  eq('S15 no lock -> null owner', liveSupervisorOwner({ machineDir: M, deps: world('boot-1', {}).deps }), null);
  const w = world('boot-1', { 15001: 10 });
  own(M, { deps: w.deps, bootId: 'boot-1', pid: 15001, cwd: 'wt' }).acquire();
  eq('S15 live owner seen', liveSupervisorOwner({ machineDir: M, deps: w.deps }).pid, 15001);
  delete w.alive[15001];
  eq('S15 dead owner seen as none', liveSupervisorOwner({ machineDir: M, deps: w.deps }), null);
  eq('S15 probe did not unlink the stale lock', readLock(M) && readLock(M).pid, 15001);
}

// ---- reclaim-race harness: in-memory fs with one-shot interleaving hooks -------
function staleRecord(pid) {
  return { schemaVersion: '1', pid, processStartTime: 1, bootId: 'boot-1', cwd: 'old', acquiredAt: new Date(0).toISOString() };
}
function memFs(files, MAIN, LEASE, hooks = {}) {
  const counters = { mainUnlinks: 0, leaseUnlinks: 0 };
  const fire = (k) => { const h = hooks[k]; if (h) { hooks[k] = null; h(); } }; // one-shot: deterministic
  return {
    counters,
    readFileSync(p) {
      if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return files.get(p);
    },
    writeFileSync(p, data, opts = {}) {
      if (p === LEASE) fire('beforeLeaseWrite');
      if (opts && opts.flag === 'wx' && files.has(p)) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e; }
      files.set(p, data);
      if (p === LEASE) fire('afterLeaseWrite');
    },
    unlinkSync(p) {
      if (p === MAIN) { counters.mainUnlinks++; fire('beforeUnlinkMain'); }
      if (p === LEASE) { counters.leaseUnlinks++; }
      if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      files.delete(p);
    },
    mkdirSync() {},
  };
}
function memMachine() {
  const M = freshMachine();
  const files = new Map();
  const MAIN = supervisorLockPathFor({ machineDir: M });
  const LEASE = reclaimLeasePathFor({ machineDir: M });
  return { M, files, MAIN, LEASE };
}
const J = (o) => JSON.stringify(o, null, 2) + '\n';

// ---- regression S17: THE BLOCKER — both reclaimers observe OLD stale ------------
// 17a: A holds the lease; B must not unlink A's live lock (fail-closed loser).
{
  const { M, files, MAIN, LEASE } = memMachine();
  files.set(MAIN, J(staleRecord(17001)));
  const w = world('boot-1', { 17002: 10, 17003: 20 });
  let rb = null;
  const fsB = memFs(files, MAIN, LEASE);
  const fsA = memFs(files, MAIN, LEASE, {
    afterLeaseWrite: () => { rb = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: 17003, cwd: 'B', fsImpl: fsB }).acquire(); },
  });
  const A = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: 17002, cwd: 'A', fsImpl: fsA });
  const ra = A.acquire();
  eq('S17a winner claims after lease', ra.status, 'ACQUIRED');
  eq('S17a loser observes live lease -> already-running', rb && rb.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S17a loser NOT ok', rb && rb.ok, false);
  eq('S17a loser never unlinked the main lock', fsB.counters.mainUnlinks, 0);
  eq('S17a loser never touched the lease', fsB.counters.leaseUnlinks, 0);
  eq('S17a exactly one live owner (A intact)', JSON.parse(files.get(MAIN)).pid, 17002);
  tru('S17a lease released by winner', !files.has(LEASE));
}
// 17b: B completes its reclaim INSIDE A's pre-lease window; A must abort on the
// replacement LIVE owner under its own lease and never unlink B.
{
  const { M, files, MAIN, LEASE } = memMachine();
  files.set(MAIN, J(staleRecord(17101)));
  const w = world('boot-1', { 17102: 10, 17103: 20 });
  let rb = null;
  const fsB = memFs(files, MAIN, LEASE);
  const fsA = memFs(files, MAIN, LEASE, {
    beforeLeaseWrite: () => { rb = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: 17103, cwd: 'B', fsImpl: fsB }).acquire(); },
  });
  const ra = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: 17102, cwd: 'A', fsImpl: fsA }).acquire();
  eq('S17b first finisher (B) acquired', rb && rb.status, 'ACQUIRED');
  eq('S17b late reclaimer A sees replacement live owner', ra.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S17b A never unlinked B live lock', fsA.counters.mainUnlinks, 0);
  eq('S17b replacement lock intact', JSON.parse(files.get(MAIN)).pid, 17103);
  tru('S17b lease clean at end', !files.has(LEASE));
}

// ---- regression S18: replacement owner appears mid-reclaim (never unlinked) -----
{
  const { M, files, MAIN, LEASE } = memMachine();
  files.set(MAIN, J(staleRecord(18001)));
  const w = world('boot-1', { 18002: 10, 18003: 30 });
  const repl = { ...staleRecord(18003), processStartTime: 30, acquiredAt: new Date().toISOString(), cwd: 'repl' };
  const fsA = memFs(files, MAIN, LEASE, { beforeLeaseWrite: () => files.set(MAIN, J(repl)) });
  const ra = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: 18002, cwd: 'A', fsImpl: fsA }).acquire();
  eq('S18 aborts on replacement live owner', ra.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S18 reports replacement pid', ra.owner && ra.owner.pid, 18003);
  eq('S18 replacement lock untouched', files.get(MAIN), J(repl));
  eq('S18 zero unlinks by aborted reclaimer', fsA.counters.mainUnlinks, 0);
  tru('S18 lease not left behind', !files.has(LEASE));
}

// ---- regression S19: stolen lease must never be released by the victim ----------
{
  const { M, files, MAIN, LEASE } = memMachine();
  files.set(MAIN, J(staleRecord(19001)));
  const w = world('boot-1', { 19002: 10, 19003: 30 });
  const thief = { schemaVersion: '1', pid: 19003, processStartTime: 30, nonce: 'thief', acquiredAt: new Date().toISOString() };
  const fsA = memFs(files, MAIN, LEASE, { afterLeaseWrite: () => files.set(LEASE, J(thief)) });
  const ra = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: 19002, cwd: 'A', fsImpl: fsA }).acquire();
  eq('S19 victim yields to live lease thief', ra.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S19 victim released the STOLEN lease', fsA.counters.leaseUnlinks, 0);
  eq('S19 thief lease intact', JSON.parse(files.get(LEASE)).nonce, 'thief');
  eq('S19 main lock untouched', JSON.parse(files.get(MAIN)).pid, 19001);
}

// ---- regression S20: concurrent stale reclaim x5 (all observe OLD first) --------
{
  const { M, files, MAIN, LEASE } = memMachine();
  files.set(MAIN, J(staleRecord(20000)));
  const pids = [20001, 20002, 20003, 20004, 20005];
  const w = world('boot-1', Object.fromEntries(pids.map((p, i) => [p, 10 + i])));
  const statuses = [];
  // Each instance's first lease-write attempt nests the NEXT instance's full
  // acquire: all five observe the OLD stale holder before anyone claims.
  const runInstance = (i) => {
    const fsI = memFs(files, MAIN, LEASE, i < pids.length - 1 ? {
      beforeLeaseWrite: () => runInstance(i + 1),
    } : {});
    const r = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: pids[i], cwd: `wt${i}`, fsImpl: fsI }).acquire();
    statuses.push(r.status);
    return r;
  };
  runInstance(0);
  eq('S20 exactly one ACQUIRED in 5-deep reclaim storm', statuses.filter((s) => s === 'ACQUIRED').length, 1);
  eq('S20 four fail closed already-running', statuses.filter((s) => s === 'SUPERVISOR_ALREADY_RUNNING').length, 4);
  tru('S20 exactly one active owner after storm', pids.includes(JSON.parse(files.get(MAIN)).pid));
  tru('S20 lease clean after storm', !files.has(LEASE));
}

// ---- regression S21: live reclaim-lease contention is side-effect-free ----------
{
  const { M, files, MAIN, LEASE } = memMachine();
  const before = J(staleRecord(21001));
  files.set(MAIN, before);
  files.set(LEASE, J({ schemaVersion: '1', pid: 21009, processStartTime: 3, nonce: 'busy', acquiredAt: new Date().toISOString() }));
  const w = world('boot-1', { 21009: 3, 21002: 10 });
  const fsB = memFs(files, MAIN, LEASE);
  const rb = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: 21002, cwd: 'B', fsImpl: fsB }).acquire();
  eq('S21 live lease -> fail-closed already-running', rb.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S21 main lock byte-intact', files.get(MAIN), before);
  eq('S21 lease byte-intact', JSON.parse(files.get(LEASE)).nonce, 'busy');
  eq('S21 zero unlinks', fsB.counters.mainUnlinks + fsB.counters.leaseUnlinks, 0);
}

// ---- regression S22: abandoned/corrupt reclaim lease is itself reclaimable ------
{
  // (a) dead holder lease
  const a = memMachine();
  a.files.set(a.MAIN, J(staleRecord(22001)));
  a.files.set(a.LEASE, J({ schemaVersion: '1', pid: 22009, processStartTime: 3, nonce: 'z', acquiredAt: new Date(0).toISOString() }));
  const wa = world('boot-1', { 22002: 10 }); // 22009 absent -> dead lease
  const ra = createSupervisorOwnership({ machineDir: a.M, deps: wa.deps, bootId: 'boot-1', pid: 22002, cwd: 'C', fsImpl: memFs(a.files, a.MAIN, a.LEASE) }).acquire();
  eq('S22a dead lease reclaimed -> acquired', ra.status, 'ACQUIRED');
  eq('S22a new owner is us', JSON.parse(a.files.get(a.MAIN)).pid, 22002);
  tru('S22a lease released after success', !a.files.has(a.LEASE));
  // (b) blank/corrupt lease
  const b = memMachine();
  b.files.set(b.MAIN, J(staleRecord(22101)));
  b.files.set(b.LEASE, '');
  const wb = world('boot-1', { 22102: 10 });
  const rb = createSupervisorOwnership({ machineDir: b.M, deps: wb.deps, bootId: 'boot-1', pid: 22102, cwd: 'C', fsImpl: memFs(b.files, b.MAIN, b.LEASE) }).acquire();
  eq('S22b corrupt lease reclaimed -> acquired', rb.status, 'ACQUIRED');
}

// ---- regression S16: runtime reuses injected bootId (no duplicate PowerShell) --
{
  const S = freshState();
  let bootReads = 0;
  const cfg = readIdleSleepConfig({ SOC_IDLE_SLEEP: '1' }).config;
  const deps = { readBootId: () => { bootReads++; return 'boot-injected'; }, readUserIdleMs: () => 0, isAlive: () => false };
  createSupervisorRuntime({ config: cfg, stateDir: S, deps, bootId: 'boot-injected', log: () => {} });
  eq('S16 injected bootId -> zero extra readBootId calls', bootReads, 0);
  const rt2 = createSupervisorRuntime({ config: cfg, stateDir: S, deps, log: () => {} });
  eq('S16 no injection -> exactly one startup read', bootReads, 1);
  tru('S16 runtime constructed', typeof rt2.oneTick === 'function');
}

// ---- cleanup -------------------------------------------------------------------
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }

const failed = results.filter((r) => !r.pass);
for (const r of results) process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}\n`);
process.stdout.write(`\n${results.length - failed.length}/${results.length} singleton checks passed\n`);
process.exit(failed.length ? 1 : 0);
