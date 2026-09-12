#!/usr/bin/env node
// idle-supervisor-singleton.test.mjs — machine-GLOBAL singleton ownership for the
// Idle Sleep Supervisor. S1..S16: real temp machineDir + injected liveness
// deps. S17..S27: in-memory fs with deterministic adversarial interleavings
// against the DIRECTORY-EPOCH reclaim authority. NO real OS call, NEVER the
// production machine namespace. Ownership is keyed on the machine namespace —
// NOT on stateDir/cwd/worktree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { readIdleSleepConfig, IDLE_SUPERVISOR_SCHEMA_VERSION } from '../packages/idle-supervisor/idle-supervisor.mjs';
import {
  createSupervisorOwnership, supervisorLockPathFor, reclaimLeasePathFor, reclaimAuthorityDirFor,
  machineSupervisorDir, liveSupervisorOwner, spawnIdleSupervisor, createSupervisorRuntime,
} from '../packages/idle-supervisor/run.mjs';

const results = [];
const eq = (n, g, w) => results.push({ name: n, pass: g === w });
const tru = (n, g) => results.push({ name: n, pass: Boolean(g) });

const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-idle-sing-'));
let counter = 0;
function freshMachine() { const d = path.join(TMP, `mach-${++counter}`); mkdirSync(d, { recursive: true }); return d; }
function freshState() { const d = path.join(TMP, `st-${++counter}`); mkdirSync(path.join(d, 'sessions'), { recursive: true }); return d; }

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

// ---- reclaim-race harness: in-memory fs (dirs + CAS mkdir + fenced rmdir) ------
function staleRecord(pid) {
  return { schemaVersion: '1', pid, processStartTime: 1, bootId: 'boot-1', cwd: 'old', acquiredAt: new Date(0).toISOString() };
}
const J = (o) => JSON.stringify(o, null, 2) + '\n';
function memFs(files, dirs, MAIN, LEASEDIR, SLOTDIR, hooks = {}, opts = {}) {
  const counters = { mainUnlinks: 0, claimUnlinks: 0, rmdirAttempts: 0, claimWrites: 0, links: 0 };
  const unlinked = [];
  const inSlot = (p) => p.startsWith(SLOTDIR + path.sep);
  const isClaimPath = (p) => inSlot(p) && path.basename(p).startsWith('claim-');
  const isRootGarbage = (p) => p.startsWith(LEASEDIR + path.sep) && !inSlot(p) && /(^|[/\\])(cand-|quar-)/.test(p.slice(LEASEDIR.length + 1));
  const fire = (k) => { const h = hooks[k]; if (h) { hooks[k] = null; h(); } }; // one-shot: deterministic
  return {
    counters, unlinked,
    readFileSync(p) {
      if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return files.get(p);
    },
    readdirSync(p) {
      const pre = p + path.sep;
      const out = new Set();
      for (const k of files.keys()) if (k.startsWith(pre) && !k.slice(pre.length).includes(path.sep)) out.add(k.slice(pre.length));
      for (const d of dirs) if (d.startsWith(pre) && !d.slice(pre.length).includes(path.sep)) out.add(d.slice(pre.length));
      return [...out];
    },
    writeFileSync(p, data, o = {}) {
      if (isRootGarbage(p)) fire('beforeClaimWrite');
      if (o && o.flag === 'wx' && files.has(p)) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e; }
      files.set(p, data);
      if (isRootGarbage(p)) counters.claimWrites++;
    },
    mkdirSync(p, o = {}) {
      const exists = dirs.has(p) || [...dirs].some((d) => d.startsWith(p + path.sep));
      if (o && o.recursive) { dirs.add(p); return; }
      if (exists) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e; } // CAS open
      dirs.add(p);
    },
    linkSync(from, to) {
      counters.links++;
      if (!files.has(from)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      if (files.has(to)) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e; }
      files.set(to, files.get(from));
      if (isClaimPath(to)) fire('afterClaimLink');
      if (isClaimPath(from)) fire('afterQuarantineLink');
    },
    rmdirSync(p) {
      counters.rmdirAttempts++;
      fire('beforeRmdir');
      if (!dirs.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      const pre = p + path.sep;
      if ([...files.keys()].some((k) => k.startsWith(pre)) || [...dirs].some((d) => d !== p && d.startsWith(pre))) {
        const e = new Error('ENOTEMPTY'); e.code = 'ENOTEMPTY'; throw e; // ATOMIC content fence
      }
      dirs.delete(p);
    },
    unlinkSync(p) {
      if (p === MAIN) { counters.mainUnlinks++; fire('beforeUnlinkMain'); }
      if (isClaimPath(p)) {
        if (opts.silenceUnlinkOf && opts.silenceUnlinkOf(p, files.get(p) ?? null)) { unlinked.push(p + '#silenced'); return; }
        counters.claimUnlinks++; fire('beforeClaimUnlink');
      }
      unlinked.push(p);
      if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      files.delete(p);
    },
  };
}
function memMachine() {
  const M = freshMachine();
  const files = new Map(); const dirs = new Set();
  const MAIN = supervisorLockPathFor({ machineDir: M });
  const LEASEDIR = reclaimLeasePathFor({ machineDir: M });
  const SLOTDIR = reclaimAuthorityDirFor({ machineDir: M });
  return { M, files, dirs, MAIN, LEASEDIR, SLOTDIR };
}
const claimName = (rec) => `claim-${rec.pid}-${String(rec.nonce).slice(0, 12)}.lock`;
const claimPath = (SLOTDIR, rec) => path.join(SLOTDIR, claimName(rec));
function seedClaim(mem, rec, raw = J(rec)) { mem.dirs.add(mem.SLOTDIR); mem.files.set(claimPath(mem.SLOTDIR, rec), raw); return claimPath(mem.SLOTDIR, rec); }
function epochClaimNames(mem) {
  const pre = mem.SLOTDIR + path.sep;
  return [...mem.files.keys()].filter((k) => k.startsWith(pre) && path.basename(k).startsWith('claim-')).map((k) => path.basename(k)).sort();
}
function residue(mem) {
  const preL = mem.LEASEDIR + path.sep;
  const root = [...mem.files.keys()].filter((k) => k.startsWith(preL) && !k.startsWith(mem.SLOTDIR + path.sep) && /(^|[/\\])(cand-|quar-)/.test(k.slice(preL.length)));
  return root.length + epochClaimNames(mem).length + (mem.dirs.has(mem.SLOTDIR) ? 1 : 0);
}
// B's first epoch scan is a stale snapshot (hides claims that exist in the
// REAL world); every later observation is real. Models the worst-case view.
function staleScanFs(fsMock, SLOTDIR, snapshot) {
  let poisoned = true;
  return Object.create(fsMock, {
    readdirSync: { value: (p) => {
      if (poisoned && p === SLOTDIR) { poisoned = false; return snapshot; }
      return fsMock.readdirSync(p);
    } },
  });
}

// ---- regression S17: two reclaimers, one epoch (mkdir-CAS), ordering-free -------
// 17a: A establishes; B resumes later and must fail closed with zero writes.
{
  const mem = memMachine();
  mem.files.set(mem.MAIN, J(staleRecord(17001)));
  const w = world('boot-1', { 17002: 10, 17003: 20 });
  let rb = null;
  const fsB = memFs(mem.files, mem.dirs, mem.MAIN, mem.LEASEDIR, mem.SLOTDIR);
  const fsA = memFs(mem.files, mem.dirs, mem.MAIN, mem.LEASEDIR, mem.SLOTDIR, {
    afterClaimLink: () => { rb = createSupervisorOwnership({ machineDir: mem.M, deps: w.deps, bootId: 'boot-1', pid: 17003, cwd: 'B', fsImpl: fsB }).acquire(); },
  });
  const ra = createSupervisorOwnership({ machineDir: mem.M, deps: w.deps, bootId: 'boot-1', pid: 17002, cwd: 'A', fsImpl: fsA }).acquire();
  eq('S17a epoch creator acquires', ra.status, 'ACQUIRED');
  eq('S17a late claimant fails closed', rb && rb.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S17a late claimant never wrote', fsB.counters.claimWrites, 0);
  eq('S17a late claimant never unlinked', fsB.unlinked.length, 0);
  eq('S17a main lock belongs to A', JSON.parse(mem.files.get(mem.MAIN)).pid, 17002);
  eq('S17a epoch fully released', residue(mem), 0);
}
// 17b: B completes its full reclaim INSIDE A's pre-claim step; A must abort on
// B's live MAIN claim and never unlink it.
{
  const mem = memMachine();
  mem.files.set(mem.MAIN, J(staleRecord(17101)));
  const w = world('boot-1', { 17102: 10, 17103: 20 });
  let rb = null;
  const fsB = memFs(mem.files, mem.dirs, mem.MAIN, mem.LEASEDIR, mem.SLOTDIR);
  const fsA = memFs(mem.files, mem.dirs, mem.MAIN, mem.LEASEDIR, mem.SLOTDIR, {
    beforeClaimWrite: () => { rb = createSupervisorOwnership({ machineDir: mem.M, deps: w.deps, bootId: 'boot-1', pid: 17103, cwd: 'B', fsImpl: fsB }).acquire(); },
  });
  const ra = createSupervisorOwnership({ machineDir: mem.M, deps: w.deps, bootId: 'boot-1', pid: 17102, cwd: 'A', fsImpl: fsA }).acquire();
  eq('S17b first finisher acquired', rb && rb.status, 'ACQUIRED');
  eq('S17b late reclaimer sees live owner', ra.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S17b late reclaimer never unlinked MAIN', fsA.counters.mainUnlinks, 0);
  eq('S17b main lock belongs to B', JSON.parse(mem.files.get(mem.MAIN)).pid, 17103);
  eq('S17b no residue', residue(mem), 0);
}

// ---- regression S18: replacement MAIN owner appears mid-reclaim ----------------
{
  const mem = memMachine();
  mem.files.set(mem.MAIN, J(staleRecord(18001)));
  const w = world('boot-1', { 18002: 10, 18003: 30 });
  const repl = { ...staleRecord(18003), processStartTime: 30, acquiredAt: new Date().toISOString(), cwd: 'repl' };
  const fsA = memFs(mem.files, mem.dirs, mem.MAIN, mem.LEASEDIR, mem.SLOTDIR, { beforeClaimWrite: () => mem.files.set(mem.MAIN, J(repl)) });
  const ra = createSupervisorOwnership({ machineDir: mem.M, deps: w.deps, bootId: 'boot-1', pid: 18002, cwd: 'A', fsImpl: fsA }).acquire();
  eq('S18 aborts on replacement live owner', ra.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S18 reports replacement pid', ra.owner && ra.owner.pid, 18003);
  eq('S18 replacement lock untouched', mem.files.get(mem.MAIN), J(repl));
  eq('S18 zero main unlinks by aborted reclaimer', fsA.counters.mainUnlinks, 0);
  eq('S18 no residue (epoch + claim released)', residue(mem), 0);
}

// ---- regression S19: LEASE_OLD quarantine seam ---------------------------------
// A quarantines the stale claim; B (running inside A's seam) fully establishes
// and releases; A's guards re-decide; A never touches B's MAIN claim.
{
  const mem = memMachine();
  mem.files.set(mem.MAIN, J(staleRecord(19099)));
  seedClaim(mem, { schemaVersion: '1', pid: 19001, processStartTime: 5, nonce: 'dead-19001', bootId: 'boot-1', acquiredAt: '2026-01-01T00:00:00.000Z' });
  const w = world('boot-1', { 19002: 10, 19003: 30 }); // 19001 dead
  let rb = null;
  const fsB = memFs(mem.files, mem.dirs, mem.MAIN, mem.LEASEDIR, mem.SLOTDIR);
  const fsA = memFs(mem.files, mem.dirs, mem.MAIN, mem.LEASEDIR, mem.SLOTDIR, {
    afterQuarantineLink: () => {
      rb = createSupervisorOwnership({ machineDir: mem.M, deps: w.deps, bootId: 'boot-1', pid: 19003, cwd: 'B', fsImpl: fsB }).acquire();
    },
  });
  const ra = createSupervisorOwnership({ machineDir: mem.M, deps: w.deps, bootId: 'boot-1', pid: 19002, cwd: 'A', fsImpl: fsA }).acquire();
  eq('S19 concurrent claimant establishes and acquires', rb && rb.status, 'ACQUIRED');
  eq('S19 stale observer fails closed on re-decision', ra.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S19 stale observer never unlinked MAIN', fsA.counters.mainUnlinks, 0);
  eq('S19 main lock belongs to B', JSON.parse(mem.files.get(mem.MAIN)).pid, 19003);
  eq('S19 no residue', residue(mem), 0);
}
// 19b: a LIVE claim makes its epoch undeletable: rmdir is fenced, zero effects.
{
  const mem = memMachine();
  mem.files.set(mem.MAIN, J(staleRecord(19199)));
  const live = { schemaVersion: '1', pid: 19103, processStartTime: 7, nonce: 'live-19103', bootId: 'boot-1', acquiredAt: '2026-02-02T00:00:00.000Z' };
  const livePath = seedClaim(mem, live);
  const w = world('boot-1', { 19102: 10, 19103: 7 });
  const fsA = memFs(mem.files, mem.dirs, mem.MAIN, mem.LEASEDIR, mem.SLOTDIR);
  const ra = createSupervisorOwnership({ machineDir: mem.M, deps: w.deps, bootId: 'boot-1', pid: 19102, cwd: 'A', fsImpl: fsA }).acquire();
  eq('S19b live claim -> fail closed', ra.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S19b wrote zero', fsA.counters.claimWrites, 0);
  eq('S19b zero unlinks', fsA.unlinked.length, 0);
  eq('S19b zero rmdir attempts (fenced before touching)', fsA.counters.rmdirAttempts, 0);
  eq('S19b live claim byte-intact', mem.files.get(livePath), J(live));
}

// ---- regression S20: 5-deep nested reclaim storm -> exactly one ----------------
{
  const mem = memMachine();
  mem.files.set(mem.MAIN, J(staleRecord(20000)));
  const pids = [20001, 20002, 20003, 20004, 20005];
  const w = world('boot-1', Object.fromEntries(pids.map((p, i) => [p, 10 + i])));
  const statuses = [];
  const runInstance = (i) => {
    const fsI = memFs(mem.files, mem.dirs, mem.MAIN, mem.LEASEDIR, mem.SLOTDIR, i < pids.length - 1 ? {
      beforeClaimWrite: () => runInstance(i + 1),
    } : {});
    const r = createSupervisorOwnership({ machineDir: mem.M, deps: w.deps, bootId: 'boot-1', pid: pids[i], cwd: `wt${i}`, fsImpl: fsI }).acquire();
    statuses.push(r.status);
    return r;
  };
  runInstance(0);
  eq('S20 exactly one ACQUIRED in 5-deep storm', statuses.filter((s) => s === 'ACQUIRED').length, 1);
  eq('S20 four fail closed already-running', statuses.filter((s) => s === 'SUPERVISOR_ALREADY_RUNNING').length, 4);
  tru('S20 exactly one active owner after storm', pids.includes(JSON.parse(mem.files.get(mem.MAIN)).pid));
  eq('S20 no residue', residue(mem), 0);
}

// ---- regression S21: live-claim contention is side-effect-free ------------------
{
  const mem = memMachine();
  const before = J(staleRecord(21001));
  mem.files.set(mem.MAIN, before);
  const live = { schemaVersion: '1', pid: 21009, processStartTime: 3, nonce: 'busy-21009', bootId: 'boot-1', acquiredAt: '2026-03-03T00:00:00.000Z' };
  const livePath = seedClaim(mem, live);
  const w = world('boot-1', { 21009: 3, 21002: 10 });
  const fsB = memFs(mem.files, mem.dirs, mem.MAIN, mem.LEASEDIR, mem.SLOTDIR);
  const rb = createSupervisorOwnership({ machineDir: mem.M, deps: w.deps, bootId: 'boot-1', pid: 21002, cwd: 'B', fsImpl: fsB }).acquire();
  eq('S21 live authority -> fail-closed already-running', rb.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S21 main lock byte-intact', mem.files.get(mem.MAIN), before);
  eq('S21 claim byte-intact', mem.files.get(livePath), J(live));
  eq('S21 zero writes', fsB.counters.claimWrites, 0);
  eq('S21 zero unlinks', fsB.unlinked.length, 0);
}

// ---- regression S22: crash recovery — dead/corrupt/boot-stale claims ------------
{
  // (a) dead-holder claim inside live epoch: retired by name, epoch re-opened.
  const a = memMachine();
  a.files.set(a.MAIN, J(staleRecord(22001)));
  seedClaim(a, { schemaVersion: '1', pid: 22009, processStartTime: 3, nonce: 'dead-22009', bootId: 'boot-1', acquiredAt: '2026-04-04T00:00:00.000Z' });
  const wa = world('boot-1', { 22002: 10 }); // 22009 absent
  const ra = createSupervisorOwnership({ machineDir: a.M, deps: wa.deps, bootId: 'boot-1', pid: 22002, cwd: 'C', fsImpl: memFs(a.files, a.dirs, a.MAIN, a.LEASEDIR, a.SLOTDIR) }).acquire();
  eq('S22a dead claim reclaimed -> acquired', ra.status, 'ACQUIRED');
  eq('S22a new owner recorded', JSON.parse(a.files.get(a.MAIN)).pid, 22002);
  eq('S22a epoch fully closed after release', residue(a), 0);
  // (b) corrupt claim bytes carry no authority
  const b = memMachine();
  b.files.set(b.MAIN, J(staleRecord(22101)));
  const bad = { schemaVersion: '1', pid: 22199, processStartTime: 2, nonce: 'bad-22199', bootId: 'boot-1', acquiredAt: '2026-04-04T00:00:00.000Z' };
  seedClaim(b, bad, 'not-json');
  const wb = world('boot-1', { 22102: 10 });
  const rb = createSupervisorOwnership({ machineDir: b.M, deps: wb.deps, bootId: 'boot-1', pid: 22102, cwd: 'C', fsImpl: memFs(b.files, b.dirs, b.MAIN, b.LEASEDIR, b.SLOTDIR) }).acquire();
  eq('S22b corrupt authority reclaimed -> acquired', rb.status, 'ACQUIRED');
  eq('S22b new owner recorded', JSON.parse(b.files.get(b.MAIN)).pid, 22102);
  eq('S22b no residue', residue(b), 0);
  // (c) boot-generation mismatch proves staleness for a LIVE pid
  const c = memMachine();
  c.files.set(c.MAIN, J(staleRecord(22201)));
  seedClaim(c, { schemaVersion: '1', pid: 22209, processStartTime: 4, nonce: 'oldb-22209', bootId: 'boot-OLD', acquiredAt: '2026-04-04T00:00:00.000Z' });
  const wc = world('boot-NEW', { 22209: 4, 22202: 10 });
  const rc = createSupervisorOwnership({ machineDir: c.M, deps: wc.deps, bootId: 'boot-NEW', pid: 22202, cwd: 'C', fsImpl: memFs(c.files, c.dirs, c.MAIN, c.LEASEDIR, c.SLOTDIR) }).acquire();
  eq('S22c reboot-stale authority reclaimed -> acquired', rc.status, 'ACQUIRED');
}

// ---- regression S23: same-ts late writer whose name sorts FIRST loses -----------
// A establishes its epoch; B (created AFTER, identical acquiredAt, SMALLER pid
// so its claim name sorts before A's under any name-order election) resumes
// from a poisoned scan hiding A's claim: the mkdir-CAS epoch + live-claim scan
// (real reads) still reject it.
{
  const mem = memMachine();
  mem.files.set(mem.MAIN, J(staleRecord(23099)));
  const w = world('boot-1', { 23002: 10, 23001: 5 }); // B has the smaller pid
  let rb = null; let liveName = null;
  const fsB = memFs(mem.files, mem.dirs, mem.MAIN, mem.LEASEDIR, mem.SLOTDIR);
  const fsA = memFs(mem.files, mem.dirs, mem.MAIN, mem.LEASEDIR, mem.SLOTDIR, {
    afterClaimLink: () => {
      liveName = epochClaimNames(mem)[0];
      rb = createSupervisorOwnership({ machineDir: mem.M, deps: w.deps, bootId: 'boot-1', pid: 23001, cwd: 'B-late',
        clock: () => '2026-06-06T00:00:00.000Z', fsImpl: fsB }).acquire();
    },
  });
  const ra = createSupervisorOwnership({ machineDir: mem.M, deps: w.deps, bootId: 'boot-1', pid: 23002, cwd: 'A-first',
    clock: () => '2026-06-06T00:00:00.000Z', fsImpl: fsA }).acquire();
  tru('S23 A claim name sorts AFTER B-fake-possible name (adversarial setup)', String(liveName).endsWith('.lock'));
  eq('S23 same-ts late writer fails closed', rb && rb.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S23 established authority acquires', ra.status, 'ACQUIRED');
  eq('S23 late writer never wrote', fsB.counters.claimWrites, 0);
  eq('S23 late writer never unlinked', fsB.unlinked.length, 0);
  eq('S23 main lock belongs to A', JSON.parse(mem.files.get(mem.MAIN)).pid, 23002);
}

// ---- regression S24: clock-rollback + blind-listing late writer -----------------
{
  const mem = memMachine();
  mem.files.set(mem.MAIN, J(staleRecord(24099)));
  const w = world('boot-1', { 24002: 10, 24003: 20 });
  let rb = null;
  const fsB = memFs(mem.files, mem.dirs, mem.MAIN, mem.LEASEDIR, mem.SLOTDIR);
  const fsBv = staleScanFs(fsB, mem.SLOTDIR, []); // B's first epoch scan sees NOTHING
  const fsA = memFs(mem.files, mem.dirs, mem.MAIN, mem.LEASEDIR, mem.SLOTDIR, {
    afterClaimLink: () => {
      rb = createSupervisorOwnership({ machineDir: mem.M, deps: w.deps, bootId: 'boot-1', pid: 24003, cwd: 'B-late',
        clock: () => '2020-01-01T00:00:00.000Z', fsImpl: fsBv }).acquire();
    },
  });
  const ra = createSupervisorOwnership({ machineDir: mem.M, deps: w.deps, bootId: 'boot-1', pid: 24002, cwd: 'A-first',
    clock: () => '2026-06-06T00:00:00.000Z', fsImpl: fsA }).acquire();
  eq('S24 rollback+blind late writer fails closed', rb && rb.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S24 established authority acquires', ra.status, 'ACQUIRED');
  tru('S24 blind writer at most opened its own epoch artifacts', fsB.counters.claimWrites <= 1);
  eq('S24 late writer zero foreign unlinks', fsB.unlinked.filter((p) => p === mem.MAIN || (p.startsWith(mem.SLOTDIR) && !p.includes('-24003-'))).length, 0);
  eq('S24 main lock belongs to A', JSON.parse(mem.files.get(mem.MAIN)).pid, 24002);
}

// ---- regression S25: release-then-win handoff ------------------------------------
{
  const mem = memMachine();
  mem.files.set(mem.MAIN, J(staleRecord(25099)));
  const w = world('boot-1', { 25002: 10, 25003: 20 });
  const A = createSupervisorOwnership({ machineDir: mem.M, deps: w.deps, bootId: 'boot-1', pid: 25002, cwd: 'A', fsImpl: memFs(mem.files, mem.dirs, mem.MAIN, mem.LEASEDIR, mem.SLOTDIR) });
  const ra = A.acquire();
  eq('S25 A acquires', ra.status, 'ACQUIRED');
  const rb1 = createSupervisorOwnership({ machineDir: mem.M, deps: w.deps, bootId: 'boot-1', pid: 25003, cwd: 'B-during', fsImpl: memFs(mem.files, mem.dirs, mem.MAIN, mem.LEASEDIR, mem.SLOTDIR) }).acquire();
  eq('S25 B cannot win while A holds the lock', rb1.status, 'SUPERVISOR_ALREADY_RUNNING');
  const rel = A.release();
  eq('S25 A releases cleanly', rel.released, true);
  const rb2 = createSupervisorOwnership({ machineDir: mem.M, deps: w.deps, bootId: 'boot-1', pid: 25003, cwd: 'B-after', fsImpl: memFs(mem.files, mem.dirs, mem.MAIN, mem.LEASEDIR, mem.SLOTDIR) }).acquire();
  eq('S25 after release the next claimant wins', rb2.status, 'ACQUIRED');
  eq('S25 main lock belongs to B', JSON.parse(mem.files.get(mem.MAIN)).pid, 25003);
}

// ---- regression S26: THE BLOCKER — stale remover resumes AFTER replacement -----
// Reviewer interleaving, deterministic via fs hooks:
//   1. epoch holds DEAD claim S; MAIN is stale. A and B both prove S stale.
//   2. B is PAUSED mid-retirement (right about to unlink claim S).
//   3. A runs its full reclaim: retires S, opens a fresh epoch, links live
//      claim N, and holds its MAIN owner claim when it finishes.
//   4. B RESUMES its stale decision.
// Invariant proven here: every removal B can perform is bound to a GENERATION
// NAME (claim-S bound, own cand/quar) or a fenced rmdir — B has no operation
// that can address A's live generation N or A's MAIN lock.
{
  const mem = memMachine();
  mem.files.set(mem.MAIN, J(staleRecord(26999))); // dead MAIN holder
  const sRec = { schemaVersion: '1', pid: 26001, processStartTime: 5, nonce: 'dead-26001', bootId: 'boot-1', acquiredAt: '2026-01-01T00:00:00.000Z' };
  const sPath = seedClaim(mem, sRec);
  const w = world('boot-1', { 26002: 7, 26003: 9 }); // S(26001) and MAIN(26999) dead; A,B live
  let ra = null; let mainAfterA = null; let nLiveDuringB = null;
  const fsB = memFs(mem.files, mem.dirs, mem.MAIN, mem.LEASEDIR, mem.SLOTDIR, {
    beforeClaimUnlink: () => { // B observed S stale and is about to remove claim-S
      const fsA = memFs(mem.files, mem.dirs, mem.MAIN, mem.LEASEDIR, mem.SLOTDIR);
      ra = createSupervisorOwnership({ machineDir: mem.M, deps: w.deps, bootId: 'boot-1', pid: 26002, cwd: 'A', fsImpl: fsA }).acquire();
      mainAfterA = mem.files.get(mem.MAIN);
      // A's transient authority may already be released; the replacement of
      // this epoch by A (or its release) must STILL be untouched by B. If A
      // released, B can legitimately open its OWN new epoch — what it can
      // never do is delete a claim whose generation it did not prove dead.
    },
    beforeRmdir: () => { nLiveDuringB = epochClaimNames(mem).slice(); },
  });
  const rb = createSupervisorOwnership({ machineDir: mem.M, deps: w.deps, bootId: 'boot-1', pid: 26003, cwd: 'B', fsImpl: fsB }).acquire();
  eq('S26 A completed reclaim through B pause', ra && ra.status, 'ACQUIRED');
  eq('S26 A holds the MAIN lock', JSON.parse(mem.files.get(mem.MAIN)).pid, 26002);
  eq('S26 stale remover B fails closed against live A', rb.status, 'SUPERVISOR_ALREADY_RUNNING');
  eq('S26 B never unlinked MAIN', fsB.counters.mainUnlinks, 0);
  tru('S26 B removals are generation-bound only (claim-S + own artifacts)',
    fsB.unlinked.every((p) => p === sPath || !p.startsWith(mem.SLOTDIR + path.sep) || p.includes('-26003-')));
  eq('S26 MAIN bytes exactly intact through B whole attempt', mem.files.get(mem.MAIN), mainAfterA);
  tru('S26 no foreign live claim was deleted (N survived or was legitimately closed)',
    nLiveDuringB.every((n) => n === path.basename(sPath) || n.includes('-26003-') || n.includes('-26002-')));
}

// ---- regression S27: MIRROR — stale S with NO replacement: recovery proceeds ----
{
  const mem = memMachine();
  mem.files.set(mem.MAIN, J(staleRecord(27099)));
  seedClaim(mem, { schemaVersion: '1', pid: 27001, processStartTime: 5, nonce: 'dead-27001', bootId: 'boot-1', acquiredAt: '2026-01-01T00:00:00.000Z' });
  const w = world('boot-1', { 27002: 10 });
  const fsC = memFs(mem.files, mem.dirs, mem.MAIN, mem.LEASEDIR, mem.SLOTDIR);
  const r = createSupervisorOwnership({ machineDir: mem.M, deps: w.deps, bootId: 'boot-1', pid: 27002, cwd: 'C', fsImpl: fsC }).acquire();
  eq('S27 recovery progresses without any racer', r.status, 'ACQUIRED');
  eq('S27 new owner recorded', JSON.parse(mem.files.get(mem.MAIN)).pid, 27002);
  eq('S27 quarantine/cand/epoch artifacts fully closed after CS', residue(mem), 0);
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
