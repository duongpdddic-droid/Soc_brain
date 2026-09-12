#!/usr/bin/env node
// idle-supervisor-singleton.test.mjs — machine-GLOBAL singleton ownership for the
// Idle Sleep Supervisor. Deterministic: real temp machineDir + injected
// liveness/boot deps for S1..S16; in-memory fs with one-shot adversarial
// interleaving hooks for the reclaim-election races S17..S25. NO real OS call,
// NEVER the production machine namespace. Ownership is keyed on the machine
// namespace — NOT on stateDir/cwd/worktree. Reclaim election is ATOMIC-SLOT
// (link-CAS), never wall-clock/pid/nonce ordering.
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
function seedLock(machineDir, owner) { mkdirSync(path.dirname(lockPath(machineDir)), { recursive: true }); writeFileSync(lockPath(machineDir), JSON.stringify(owner, null, 2) + '\n'); }

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
  const M = freshMachine(); const w = world('boot-1', { 7001: 10, 7002: 20 });
  own(M, { deps: w.deps, bootId: 'boot-1', pid: 7001, cwd: 'wt' }).acquire(); // owner (launcher parent exited)
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
  const M = freshMachine(); mkdirSync(reclaimLeasePathFor({ machineDir: M }), { recursive: true });
  writeFileSync(lockPath(M), '', 'utf8'); // torn/blank
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
function memFs(files, MAIN, LEASEDIR, hooks = {}) {
  const SLOT = path.join(LEASEDIR, 'authority.slot');
  const isClaim = (p) => p.startsWith(LEASEDIR + path.sep) && /(^|[/\\])(cand-|quar-)/.test(p.slice(LEASEDIR.length + 1));
  const counters = { mainUnlinks: 0, slotUnlinks: 0, claimWrites: 0, linkAttempts: 0, slotLinks: 0 };
  const unlinked = [];
  const fire = (k) => { const h = hooks[k]; if (h) { hooks[k] = null; h(); } }; // one-shot: deterministic
  return {
    counters, unlinked, SLOT,
    readFileSync(p) {
      if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return files.get(p);
    },
    readdirSync(p) {
      const pre = p + path.sep;
      return [...files.keys()].filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length));
    },
    writeFileSync(p, data, opts = {}) {
      if (isClaim(p)) fire('beforeClaimWrite');
      if (opts && opts.flag === 'wx' && files.has(p)) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e; }
      files.set(p, data);
      if (isClaim(p)) counters.claimWrites++;
    },
    linkSync(from, to) {
      counters.linkAttempts++;
      if (!files.has(from)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      if (files.has(to)) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e; }
      files.set(to, files.get(from)); // hard link: shared content semantics
      if (to === SLOT) { counters.slotLinks++; fire('afterLinkSlot'); }
      else if (path.basename(to).startsWith('quar-')) fire('afterQuarantineLink');
    },
    unlinkSync(p) {
      if (p === MAIN) { counters.mainUnlinks++; fire('beforeUnlinkMain'); }
      if (p === SLOT) counters.slotUnlinks++;
      unlinked.push(p);
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
  const LEASEDIR = reclaimLeasePathFor({ machineDir: M });
  const SLOT = path.join(LEASEDIR, 'authority.slot');
  return { M, files, MAIN, LEASEDIR, SLOT };
}
const J = (o) => JSON.stringify(o, null, 2) + '\n';
const claimFiles = (files, LEASEDIR) => {
  const pre = LEASEDIR + path.sep;
  return [...files.keys()].filter((k) => k.startsWith(pre) && /(^|[/\\])(cand-|quar-)/.test(k.slice(pre.length))).map((k) => k.slice(pre.length)).sort();
};
const slotRec = (files, SLOT) => { try { return JSON.parse(files.get(SLOT)); } catch { return null; } };
// A claimant whose FIRST directory listing is a stale empty view; every later
// observation is real. (The slot read + the LINK itself can never be faked.)
function staleViewFs(fsMock, LEASEDIR) {
  let poisoned = true;
  return Object.create(fsMock, {
    readdirSync: { value: (p) => {
      if (poisoned && p === LEASEDIR) { poisoned = false; return []; }
      return fsMock.readdirSync(p);
    } },
  });
}

// ---- regression S17: two reclaimers, ONE slot (link-CAS, ordering-free) --------
// 17a: A establishes (link success); B runs LATER and must fail closed without
// ever linking, writing or unlinking anything of A's.
{
  const { M, files, MAIN, LEASEDIR, SLOT } = memMachine();
  files.set(MAIN, J(staleRecord(17001)));
  const w = world('boot-1', { 17002: 10, 17003: 20 });
  let rb = null;
  const fsB = memFs(files, MAIN, LEASEDIR);
  const fsA = memFs(files, MAIN, LEASEDIR, {
    afterLinkSlot: () => { rb = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: 17003, cwd: 'B', fsImpl: fsB }).acquire(); },
  });
  const ra = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: 17002, cwd: 'A', fsImpl: fsA }).acquire();
  eq('S17a link winner acquires', ra.status, 'ACQUIRED');
  eq('S17a late claimant fails closed', rb && rb.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S17a late claimant never wrote a candidate', fsB.counters.claimWrites, 0);
  eq('S17a late claimant never unlinked anything', fsB.unlinked.length, 0);
  eq('S17a main lock belongs to A', JSON.parse(files.get(MAIN)).pid, 17002);
  eq('S17a reclaim dir fully released', claimFiles(files, LEASEDIR).length + (files.has(SLOT) ? 1 : 0), 0);
}
// 17b: B links first (inside A's pre-claim hook); A must lose the slot race and
// abort on B's LIVE main claim — never unlinking it.
{
  const { M, files, MAIN, LEASEDIR, SLOT } = memMachine();
  files.set(MAIN, J(staleRecord(17101)));
  const w = world('boot-1', { 17102: 10, 17103: 20 });
  let rb = null;
  const fsB = memFs(files, MAIN, LEASEDIR);
  const fsA = memFs(files, MAIN, LEASEDIR, {
    beforeClaimWrite: () => { rb = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: 17103, cwd: 'B', fsImpl: fsB }).acquire(); },
  });
  const ra = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: 17102, cwd: 'A', fsImpl: fsA }).acquire();
  eq('S17b link-first claimant acquired', rb && rb.status, 'ACQUIRED');
  eq('S17b loser sees replacement live owner', ra.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S17b loser never unlinked the main lock', fsA.counters.mainUnlinks, 0);
  eq('S17b main lock belongs to B', JSON.parse(files.get(MAIN)).pid, 17103);
  eq('S17b no slot/candidate residue', claimFiles(files, LEASEDIR).length + (files.has(SLOT) ? 1 : 0), 0);
}

// ---- regression S18: replacement main owner appears mid-reclaim ----------------
{
  const { M, files, MAIN, LEASEDIR, SLOT } = memMachine();
  files.set(MAIN, J(staleRecord(18001)));
  const w = world('boot-1', { 18002: 10, 18003: 30 });
  const repl = { ...staleRecord(18003), processStartTime: 30, acquiredAt: new Date().toISOString(), cwd: 'repl' };
  const fsA = memFs(files, MAIN, LEASEDIR, { beforeClaimWrite: () => files.set(MAIN, J(repl)) });
  const ra = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: 18002, cwd: 'A', fsImpl: fsA }).acquire();
  eq('S18 aborts on replacement live owner', ra.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S18 reports replacement pid', ra.owner && ra.owner.pid, 18003);
  eq('S18 replacement lock untouched', files.get(MAIN), J(repl));
  eq('S18 zero main unlinks by aborted reclaimer', fsA.counters.mainUnlinks, 0);
  eq('S18 no authority residue (slot + candidates released)', claimFiles(files, LEASEDIR).length + (files.has(SLOT) ? 1 : 0), 0);
}

// ---- regression S19: LEASE_OLD — stale observer must not delete established B --
// A read + reread the DEAD slot bytes and is about to reclaim; B (via a hook at
// A's quarantine step) fully establishes authority. A's byte-equality guards
// then MUST refuse the slot removal; A fails closed; B stays authority/owner.
{
  const { M, files, MAIN, LEASEDIR, SLOT } = memMachine();
  files.set(MAIN, J(staleRecord(19099)));
  files.set(SLOT, J({ schemaVersion: '1', pid: 19001, processStartTime: 5, nonce: 'old-dead', bootId: 'boot-1', acquiredAt: '2026-01-01T00:00:00.000Z' }));
  const w = world('boot-1', { 19002: 10, 19003: 30 }); // 19001 dead
  let rb = null;
  const fsB = memFs(files, MAIN, LEASEDIR);
  const fsA = memFs(files, MAIN, LEASEDIR, {
    afterQuarantineLink: () => {
      // A has preserved the dead bytes and is between its guards and the
      // removal; B now fully establishes authority through the same protocol.
      rb = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: 19003, cwd: 'B', fsImpl: fsB }).acquire();
    },
  });
  const ra = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: 19002, cwd: 'A', fsImpl: fsA }).acquire();
  eq('S19 replacement establishes authority and acquires', rb && rb.status, 'ACQUIRED');
  eq('S19 stale observer fails closed on resumed decision', ra.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S19 stale observer never unlinked the LIVE main claim', fsA.counters.mainUnlinks, 0);
  tru('S19 stale observer never deleted a B-owned path', !fsA.unlinked.some((p) => p.includes('-19003-')));
  eq('S19 main lock belongs to B', JSON.parse(files.get(MAIN)).pid, 19003);
  eq('S19 reclaim dir fully clean', claimFiles(files, LEASEDIR).length + (files.has(SLOT) ? 1 : 0), 0);
}
// 19b: occupied LIVE slot is never removable by any claimant: zero writes/links.
{
  const { M, files, MAIN, LEASEDIR, SLOT } = memMachine();
  files.set(MAIN, J(staleRecord(19199)));
  const liveRec = { schemaVersion: '1', pid: 19103, processStartTime: 7, nonce: 'live0000', bootId: 'boot-1', acquiredAt: '2026-02-02T00:00:00.000Z' };
  files.set(SLOT, J(liveRec));
  const w = world('boot-1', { 19102: 10, 19103: 7 });
  const fsA = memFs(files, MAIN, LEASEDIR);
  const ra = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: 19102, cwd: 'A', fsImpl: fsA }).acquire();
  eq('S19b live slot -> fail closed', ra.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S19b wrote zero candidates', fsA.counters.claimWrites, 0);
  eq('S19b zero link successes', fsA.counters.slotLinks, 0);
  eq('S19b zero unlinks', fsA.unlinked.length, 0);
  eq('S19b live slot intact', files.get(SLOT), J(liveRec));
}

// ---- regression S20: 5-deep nested reclaim storm -> exactly one ---------------
{
  const { M, files, MAIN, LEASEDIR, SLOT } = memMachine();
  files.set(MAIN, J(staleRecord(20000)));
  const pids = [20001, 20002, 20003, 20004, 20005];
  const w = world('boot-1', Object.fromEntries(pids.map((p, i) => [p, 10 + i])));
  const statuses = [];
  const runInstance = (i) => {
    const fsI = memFs(files, MAIN, LEASEDIR, i < pids.length - 1 ? {
      beforeClaimWrite: () => runInstance(i + 1),
    } : {});
    const r = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: pids[i], cwd: `wt${i}`, fsImpl: fsI }).acquire();
    statuses.push(r.status);
    return r;
  };
  runInstance(0);
  eq('S20 exactly one ACQUIRED in 5-deep reclaim storm', statuses.filter((s) => s === 'ACQUIRED').length, 1);
  eq('S20 four fail closed already-running', statuses.filter((s) => s === 'SUPERVISOR_ALREADY_RUNNING').length, 4);
  tru('S20 exactly one active owner after storm', pids.includes(JSON.parse(files.get(MAIN)).pid));
  eq('S20 no authority residue', claimFiles(files, LEASEDIR).length + (files.has(SLOT) ? 1 : 0), 0);
}

// ---- regression S21: live authority contention is side-effect-free ------------
{
  const { M, files, MAIN, LEASEDIR, SLOT } = memMachine();
  const before = J(staleRecord(21001));
  files.set(MAIN, before);
  const liveRec = { schemaVersion: '1', pid: 21009, processStartTime: 3, nonce: 'busybusi', bootId: 'boot-1', acquiredAt: '2026-03-03T00:00:00.000Z' };
  files.set(SLOT, J(liveRec));
  const w = world('boot-1', { 21009: 3, 21002: 10 });
  const fsB = memFs(files, MAIN, LEASEDIR);
  const rb = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: 21002, cwd: 'B', fsImpl: fsB }).acquire();
  eq('S21 live authority -> fail-closed already-running', rb.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S21 main lock byte-intact', files.get(MAIN), before);
  eq('S21 authority slot byte-intact', files.get(SLOT), J(liveRec));
  eq('S21 zero writes', fsB.counters.claimWrites, 0);
  eq('S21 zero unlinks', fsB.unlinked.length, 0);
}

// ---- regression S22: crash recovery — dead/corrupt slot still reclaimable ------
{
  // (a) proven-dead authority is removed via quarantine and the link re-elects.
  const a = memMachine();
  a.files.set(a.MAIN, J(staleRecord(22001)));
  a.files.set(a.SLOT, J({ schemaVersion: '1', pid: 22009, processStartTime: 3, nonce: 'deaddead', bootId: 'boot-1', acquiredAt: '2026-04-04T00:00:00.000Z' }));
  const wa = world('boot-1', { 22002: 10 }); // 22009 absent -> dead authority
  const fsC = memFs(a.files, a.MAIN, a.LEASEDIR);
  const ra = createSupervisorOwnership({ machineDir: a.M, deps: wa.deps, bootId: 'boot-1', pid: 22002, cwd: 'C', fsImpl: fsC }).acquire();
  eq('S22a dead authority reclaimed -> acquired', ra.status, 'ACQUIRED');
  eq('S22a new owner recorded', JSON.parse(a.files.get(a.MAIN)).pid, 22002);
  eq('S22a quarantine GC-pruned + slot released', claimFiles(a.files, a.LEASEDIR).length + (a.files.has(a.SLOT) ? 1 : 0), 0);
  // (b) corrupt slot bytes carry no authority (positive-evidence rule)
  const b = memMachine();
  b.files.set(b.MAIN, J(staleRecord(22101)));
  b.files.set(b.SLOT, 'not-json');
  const wb = world('boot-1', { 22102: 10 });
  const rb = createSupervisorOwnership({ machineDir: b.M, deps: wb.deps, bootId: 'boot-1', pid: 22102, cwd: 'C', fsImpl: memFs(b.files, b.MAIN, b.LEASEDIR) }).acquire();
  eq('S22b corrupt authority reclaimed -> acquired', rb.status, 'ACQUIRED');
  eq('S22b new owner recorded', JSON.parse(b.files.get(b.MAIN)).pid, 22102);
  eq('S22b no residue', claimFiles(b.files, b.LEASEDIR).length + (b.files.has(b.SLOT) ? 1 : 0), 0);
  // (c) boot-generation mismatch proves staleness even for a LIVE pid
  const c = memMachine();
  c.files.set(c.MAIN, J(staleRecord(22201)));
  c.files.set(c.SLOT, J({ schemaVersion: '1', pid: 22209, processStartTime: 4, nonce: 'oldboot!', bootId: 'boot-OLD', acquiredAt: '2026-04-04T00:00:00.000Z' }));
  const wc = world('boot-NEW', { 22209: 4, 22202: 10 }); // same pid, same startTime, NEW boot
  const rc = createSupervisorOwnership({ machineDir: c.M, deps: wc.deps, bootId: 'boot-NEW', pid: 22202, cwd: 'C', fsImpl: memFs(c.files, c.MAIN, c.LEASEDIR) }).acquire();
  eq('S22c reboot-stale authority reclaimed -> acquired', rc.status, 'ACQUIRED');
}

// ---- regression S23: SAME-TIMESTAMP LATE WRITER with sort-earlier name ---------
// A establishes authority. B is created AFTER, with an identical acquiredAt
// stamp AND a pid that makes B's candidate name sort BEFORE A's under any
// name-ordering election. Link CAS: B cannot overwrite the occupied slot.
{
  const { M, files, MAIN, LEASEDIR, SLOT } = memMachine();
  files.set(MAIN, J(staleRecord(23099)));
  const w = world('boot-1', { 23002: 10, 23001: 5 }); // B has the SMALLER pid
  let rb = null; let slotWhileA = null;
  const fsB = memFs(files, MAIN, LEASEDIR);
  const fsA = memFs(files, MAIN, LEASEDIR, {
    afterLinkSlot: () => {
      slotWhileA = JSON.parse(files.get(SLOT)); // A's link currently owns the slot
      rb = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: 23001, cwd: 'B-late',
        clock: () => '2026-06-06T00:00:00.000Z', fsImpl: fsB }).acquire(); // same ts as A
    },
  });
  const ra = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: 23002, cwd: 'A-first',
    clock: () => '2026-06-06T00:00:00.000Z', fsImpl: fsA }).acquire();
  eq('S23 authority observed live while B ran (slot bytes = A)', slotWhileA && slotWhileA.pid, 23002);
  eq('S23 same-ts late writer with earlier name still loses', rb && rb.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S23 first authority acquires', ra.status, 'ACQUIRED');
  eq('S23 late writer never wrote (link arbiter, not names)', fsB.counters.claimWrites, 0);
  eq('S23 late writer never unlinked', fsB.unlinked.length, 0);
  eq('S23 main lock belongs to A', JSON.parse(files.get(MAIN)).pid, 23002);
}

// ---- regression S24: CLOCK-ROLLBACK LATE WRITER + blind (stale) listing --------
// A established at T=100 (2026-06-06). B runs AFTER with clock rolled back to
// T=90 (2020) AND a poisoned first directory listing. Rollback + blindness can
// neither fake precedence nor hide the occupied slot: B must not preempt A.
{
  const { M, files, MAIN, LEASEDIR, SLOT } = memMachine();
  files.set(MAIN, J(staleRecord(24099)));
  const w = world('boot-1', { 24002: 10, 24003: 20 });
  let rb = null;
  const fsB = memFs(files, MAIN, LEASEDIR);
  const fsBv = staleViewFs(fsB, LEASEDIR);
  const fsA = memFs(files, MAIN, LEASEDIR, {
    afterLinkSlot: () => {
      rb = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: 24003, cwd: 'B-late',
        clock: () => '2020-01-01T00:00:00.000Z', fsImpl: fsBv }).acquire();
    },
  });
  const ra = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: 24002, cwd: 'A-first',
    clock: () => '2026-06-06T00:00:00.000Z', fsImpl: fsA }).acquire();
  eq('S24 clock-rollback late writer cannot preempt', rb && rb.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S24 A remains authority and acquires', ra.status, 'ACQUIRED');
  eq('S24 late writer zero writes', fsB.counters.claimWrites, 0);
  eq('S24 late writer zero unlinks', fsB.unlinked.length, 0);
  eq('S24 main lock belongs to A', JSON.parse(files.get(MAIN)).pid, 24002);
}

// ---- regression S25: MIRROR — after release, the next claimant legitimately wins
{
  const { M, files, MAIN, LEASEDIR, SLOT } = memMachine();
  files.set(MAIN, J(staleRecord(25099)));
  const w = world('boot-1', { 25002: 10, 25003: 20 });
  const A = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: 25002, cwd: 'A', fsImpl: memFs(files, MAIN, LEASEDIR) });
  const ra = A.acquire();
  eq('S25 A acquires', ra.status, 'ACQUIRED');
  const rb1 = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: 25003, cwd: 'B-during', fsImpl: memFs(files, MAIN, LEASEDIR) }).acquire();
  eq('S25 B cannot win while A holds everything', rb1.status, 'SUPERVISOR_ALREADY_RUNNING');
  const rel = A.release();
  eq('S25 A releases cleanly', rel.released, true);
  const rb2 = createSupervisorOwnership({ machineDir: M, deps: w.deps, bootId: 'boot-1', pid: 25003, cwd: 'B-after', fsImpl: memFs(files, MAIN, LEASEDIR) }).acquire();
  eq('S25 after release the next claimant wins', rb2.status, 'ACQUIRED');
  eq('S25 main lock now belongs to B', JSON.parse(files.get(MAIN)).pid, 25003);
  eq('S25 no residue across the handoff', claimFiles(files, LEASEDIR).length + (files.has(SLOT) ? 1 : 0), 0);
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
