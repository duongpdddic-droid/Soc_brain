#!/usr/bin/env node
// run.mjs — Idle Sleep Supervisor companion service (Windows-first).
//
// Runs ALONGSIDE the Soc_brain runtime (spawned by the control-ui launcher
// when SOC_IDLE_SLEEP=1). Read-only over the canonical control plane; its ONLY
// privileged capability is the Windows power action, which stays INERT unless
// the explicit production flag SOC_IDLE_SLEEP_ALLOW_REAL_SLEEP=1 is set:
//   - flag absent (tests, smoke, dry-run): the sleep request is logged, never
//     executed — an automated test can never sleep the real machine;
//   - flag present: Sleep via rundll32 powrprof SetSuspendState 0,1,0
//     (Hibernate flag = 0 — Sleep, NEVER Hibernate).
//
// Wake/recovery: after the machine resumes, the tick gap is detected, the
// boot id is re-read, canonical state + health are re-scanned fresh, and all
// idle windows restart — no stale network/MCP/browser assumption survives a
// wake because the supervisor holds no connections at all (stateless ticks).

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IDLE_SUPERVISOR_SCHEMA_VERSION, readIdleSleepConfig, createIdleSupervisor,
  scanCanonicalActivity, idleSupervisorDirFor, readSleepEvidence,
} from './idle-supervisor.mjs';
import { readWin32ProcessStartTime, isAlive as winIsAlive } from '../temp-hygiene/temp-hygiene.mjs';

const RESUME_GAP_MS = 120 * 1000;   // no tick for this long => resume/reinit
const POWERSHELL_TIMEOUT_MS = 10_000;

const USER_IDLE_PS = [
  "$s=@'",
  'using System;using System.Runtime.InteropServices;',
  'public static class IdleT{[StructLayout(LayoutKind.Sequential)]public struct LASTINPUTINFO{public uint cbSize;public uint dwTime;}',
  '[DllImport("user32.dll")]public static extern bool GetLastInputInfo(ref LASTINPUTINFO p);',
  '[DllImport("kernel32.dll")]public static extern uint GetTickCount();}',
  "'@;Add-Type -TypeDefinition $s;",
  '$i=New-Object IdleT+LASTINPUTINFO;',
  '$i.cbSize=[System.Runtime.InteropServices.Marshal]::SizeOf($i);',
  '[void][IdleT]::GetLastInputInfo([ref]$i);',
  'Write-Output (([IdleT]::GetTickCount()-$i.dwTime)-band 0xFFFFFFFF)',
].join('\n');

const BOOT_ID_PS = "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString('o')";

// ---- Windows dependency surface (all injectable; tests never hit the OS) -----

export function createWindowsDeps({
  env = process.env,
  spawnSyncImpl = spawnSync,
  powershell = 'powershell.exe',
} = {}) {
  function ps(script) {
    const r = spawnSyncImpl(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true,
    });
    if (r.error || r.status !== 0) return null;
    const out = String(r.stdout || '').trim();
    return out || null;
  }
  return {
    // OS user idle in ms; null when unreadable (DAY policy then stays WAIT —
    // unmeasurable user idle never enables a DAY sleep).
    readUserIdleMs() {
      const out = ps(USER_IDLE_PS);
      if (out == null) return null;
      const n = Number(out);
      return Number.isFinite(n) && n >= 0 ? n : null;
    },
    // Machine boot identity: changes across reboot, stable across Sleep/wake.
    readBootId() { return ps(BOOT_ID_PS); },
    // PID-reuse-safe liveness primitives for the singleton owner record.
    isAlive(pid) { return winIsAlive(pid); },
    readProcessStartTime(pid) { return readWin32ProcessStartTime(pid, spawnSyncImpl); },
    // THE power capability. Sleep (Hibernate=0), never Hibernate. Without the
    // explicit production flag this is a dry-run: nothing reaches the OS.
    requestSleep() {
      if (env.SOC_IDLE_SLEEP_ALLOW_REAL_SLEEP !== '1') {
        return { ok: true, dryRun: true, action: 'SLEEP' };
      }
      const r = spawnSyncImpl('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], {
        encoding: 'utf8', timeout: 60_000, windowsHide: true,
      });
      if (r.error) return { ok: false, action: 'SLEEP', detail: String(r.error.message || r.error) };
      return { ok: r.status === 0 || r.status == null, action: 'SLEEP', exitCode: r.status };
    },
  };
}

// ---- companion-service spawn (used by the Soc_brain runtime launcher) --------

export function spawnIdleSupervisor({ repoRoot, env = process.env, spawnImpl = spawn, deps = null } = {}) {
  if (env.SOC_IDLE_SLEEP !== '1') return null; // explicit enable only
  const entry = path.join(repoRoot, 'packages', 'idle-supervisor', 'run.mjs');
  if (!fs.existsSync(entry)) return null;
  // Pre-spawn machine-global gate: a live owner already exists => this launch
  // (main OR worktree) attaches to the single daemon instead of forking a
  // second one. Fail-open: any probe problem still spawns and lets the
  // daemon-side singleton arbitrate.
  try {
    if (liveSupervisorOwner({ machineDir: machineSupervisorDir({ env }), deps })) return null;
  } catch { /* fail-open: the singleton in the daemon is the real arbiter */ }
  const child = spawnImpl(process.execPath, [entry, '--daemon'], {
    cwd: repoRoot, detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...env, SOC_IDLE_SUPERVISOR_SPAWNED: '1' },
  });
  child.unref();
  return child;
}

// ---- machine-GLOBAL singleton (one canonical sleep owner per machine) --------
//
// Exactly ONE supervisor may decide a real OS sleep per machine (the power
// action is machine-global). Ownership is therefore NOT keyed on the per-repo/
// per-worktree stateDir (SOC_STATE_DIR differs between main and worktrees —
// that forking is the observed 5-daemon bug): the lock lives in a single
// machine namespace. Stale-owner detection is PID/startTime/bootId safe; a
// foreign LIVE owner is never killed and its lock is never unlinked.
//
// NOTE: this uses pid/startTime ONLY for OWNERSHIP reconciliation. It is not an
// activity authority (the canonical scan remains the sole sleep authority).

export function machineSupervisorDir({ env = process.env } = {}) {
  // SOC_IDLE_SUPERVISOR_MACHINE_DIR = test/namespace override; production uses
  // the fixed per-user machine path so every root/worktree contends on ONE lock.
  if (env.SOC_IDLE_SUPERVISOR_MACHINE_DIR) return path.resolve(env.SOC_IDLE_SUPERVISOR_MACHINE_DIR);
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, '.soc-brain', 'machine', 'idle-supervisor');
}

export function supervisorLockPathFor({ machineDir = machineSupervisorDir() } = {}) {
  return path.join(machineDir, 'supervisor.lock');
}

// Reclaim authority directory: serializes the stale-reclaim critical section
// with GENERATION-IMMUTABLE lease records (`lease-<acquiredAt>-<pid>-<nonce>.lock`).
// Current authority = newest LIVE record by name order. Two reclaimers that
// both observed the same stale holder can never both hold authority, and a
// stale decision can never delete a replacement authority: replacements always
// carry a different, never-before-seen name, and deletes target exact recorded
// paths of corrupt/dead records only.
export function reclaimLeasePathFor({ machineDir = machineSupervisorDir() } = {}) {
  return path.join(machineDir, 'supervisor.reclaim');
}

const OWNERSHIP_RECLAIM_ATTEMPTS = 3;

// Positive staleness evidence ONLY. Absent evidence -> treated LIVE (a foreign
// live owner is never stolen from). Stale iff: corrupt/blank owner, OR the
// boot generation changed (reboot), OR the pid is gone, OR the pid is alive
// but its Win32 start time differs (PID reuse).
function ownerIsStaleWith(owner, { currentBootId, isAliveImpl, readStartTimeImpl }) {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) return true;
  if (currentBootId && owner.bootId && owner.bootId !== currentBootId) return true;
  if (!isAliveImpl(owner.pid)) return true;
  if (owner.processStartTime != null) {
    const cur = readStartTimeImpl(owner.pid);
    if (cur && cur.processStartTime !== owner.processStartTime) return true; // PID reuse
  }
  return false;
}

// Read-only live-owner probe (used by the launcher pre-spawn gate). No bootId
// read: a lock from a previous boot always carries a dead pid, so pid/startTime
// liveness is sufficient here and saves one PowerShell spawn per launch.
export function liveSupervisorOwner({ machineDir = machineSupervisorDir(), deps = null, fsImpl = fs, bootId = null } = {}) {
  let owner = null;
  try { owner = JSON.parse(fsImpl.readFileSync(supervisorLockPathFor({ machineDir }), 'utf8')); } catch { return null; }
  const stale = ownerIsStaleWith(owner, {
    currentBootId: bootId,
    isAliveImpl: (deps && deps.isAlive) || winIsAlive,
    readStartTimeImpl: (deps && deps.readProcessStartTime) || ((p) => readWin32ProcessStartTime(p)),
  });
  return stale ? null : owner;
}

export function createSupervisorOwnership({
  machineDir = machineSupervisorDir(),
  stateDir = null,
  deps,
  bootId = null,
  cwd = process.cwd(),
  pid = process.pid,
  fsImpl = fs,
  clock = () => new Date().toISOString(),
} = {}) {
  const lockPath = supervisorLockPathFor({ machineDir });
  const leaseDir = reclaimLeasePathFor({ machineDir });
  const isAliveImpl = (deps && deps.isAlive) || winIsAlive;
  const readStartTimeImpl = (deps && deps.readProcessStartTime) || ((p) => readWin32ProcessStartTime(p));
  const currentBootId = bootId != null ? bootId : (deps && deps.readBootId ? deps.readBootId() : null);
  let owned = null; // the owner record THIS process successfully claimed

  function ownerIsStale(owner) {
    return ownerIsStaleWith(owner, { currentBootId, isAliveImpl, readStartTimeImpl });
  }

  function readRaw(p) {
    try { return fsImpl.readFileSync(p, 'utf8'); } catch { return null; }
  }
  function parseOwner(raw) {
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  function sameOwner(a, b) {
    return Boolean(a && b) && a.pid === b.pid
      && (a.processStartTime ?? null) === (b.processStartTime ?? null)
      && (a.bootId ?? null) === (b.bootId ?? null);
  }

  function sameLease(a, b) {
    return Boolean(a && b) && a.nonce != null && a.nonce === b.nonce;
  }

  // --- reclaim lease: GENERATION-IMMUTABLE claims (serialized stale-reclaim) ---
  // Authority is NOT a mutable fixed-path file: each claim is its own
  // immutable record `lease-<acquiredAt>-<pid>-<nonce>.lock`; the current
  // reclaim authority is the NEWEST LIVE record (name order == time order,
  // nonce breaks same-ms ties deterministically for every observer). Because
  // deletes only ever target an EXACT path whose content was read as
  // corrupt/dead and immutable names are never reused, a stale observer can
  // never delete a replacement authority that appears after its read: the
  // replacement has a DIFFERENT name. No fixed-path unlink exists on the
  // reclaim path at all.
  function leaseIsStale(lease) {
    if (!lease || !Number.isInteger(lease.pid) || lease.pid <= 0) return true;
    if (!isAliveImpl(lease.pid)) return true;
    if (lease.processStartTime != null) {
      const cur = readStartTimeImpl(lease.pid);
      if (cur && cur.processStartTime !== lease.processStartTime) return true;
    }
    return false;
  }

  function leaseFileFor(name) { return path.join(leaseDir, name); }
  function leaseNameFor(rec) {
    return `lease-${String(rec.acquiredAt).replace(/[:.]/g, '-')}-${pid}-${String(rec.nonce).slice(0, 8)}.lock`;
  }
  function listLeaseNames() {
    let names;
    try { names = fsImpl.readdirSync(leaseDir); } catch { return []; }
    return names.filter((n) => typeof n === 'string' && n.startsWith('lease-') && n.endsWith('.lock')).sort();
  }
  // The newest record that can PARSE and is not proven dead. Corrupt garbage
  // (unparseable) carries no live authority and never blocks a claim.
  function currentReclaimAuthority() {
    const names = listLeaseNames();
    for (let i = names.length - 1; i >= 0; i--) {
      const raw = readRaw(leaseFileFor(names[i]));
      if (raw == null) continue; // vanished: no authority
      const rec = parseOwner(raw);
      if (rec && !leaseIsStale(rec)) return { name: names[i], rec }; // LIVE newest -> authority
      if (rec == null) continue; // corrupt -> skipped (pruned opportunistically)
      // dead-proven -> not authority; keep scanning older entries
    }
    return null;
  }
  // Opportunistic GC after establishing authority: delete only records OLDER
  // than mine that are proven dead or corrupt — exact immutable paths, so the
  // verdict is forever and no live claim can hide behind those names.
  function pruneOlderDeadLeases(myName) {
    for (const name of listLeaseNames()) {
      if (name >= myName) continue;
      const raw = readRaw(leaseFileFor(name));
      if (raw == null) continue;
      const rec = parseOwner(raw);
      if (rec && !leaseIsStale(rec)) continue; // live: NEVER touch
      try { fsImpl.unlinkSync(leaseFileFor(name)); } catch { /* best effort */ }
    }
  }

  // Try to become the ONE reclaimer. Returns {ok:true, mine, name} when THIS
  // instance holds the (newest live) authority, {ok:false, status:
  // 'LEASE_BUSY'} when a live foreign authority exists (never steal, never
  // delete), or 'LEASE_UNAVAILABLE' on primitive failure (fail-closed).
  function claimReclaimLease(self) {
    for (let i = 0; i < OWNERSHIP_RECLAIM_ATTEMPTS; i++) {
      if (currentReclaimAuthority()) return { ok: false, status: 'LEASE_BUSY' };
      const mine = {
        schemaVersion: IDLE_SUPERVISOR_SCHEMA_VERSION,
        pid, processStartTime: self ? self.processStartTime : null,
        nonce: randomUUID(), acquiredAt: clock(),
      };
      const name = leaseNameFor(mine);
      try { fsImpl.mkdirSync(leaseDir, { recursive: true }); } catch { /* may exist */ }
      try {
        fsImpl.writeFileSync(leaseFileFor(name), `${JSON.stringify(mine, null, 2)}\n`, { flag: 'wx' });
      } catch (e) {
        if (e && e.code === 'EEXIST') continue; // name collision (clock+nonce): retry
        return { ok: false, status: 'LEASE_UNAVAILABLE', detail: String((e && e.message) || e) };
      }
      // VERIFY against racers that created NEWER records while I was writing:
      // authority is the newest LIVE record; a newer live claimer wins and I
      // yield, deleting ONLY MY OWN immutable name.
      const after = currentReclaimAuthority();
      if (!after || after.name === name) {
        pruneOlderDeadLeases(name);
        return { ok: true, mine, name };
      }
      try { fsImpl.unlinkSync(leaseFileFor(name)); } catch { /* my own file, best effort */ }
    }
    return { ok: false, status: 'LEASE_BUSY', detail: 'lease-contention' };
  }

  // Release ONLY my own immutable record, and only while its content still
  // carries my nonce. Another instance's authority is a different name and is
  // structurally unreachable from this function.
  function releaseReclaimLease(lease) {
    if (!lease || !lease.name) return;
    const rec = parseOwner(readRaw(leaseFileFor(lease.name)));
    if (!sameLease(rec, lease.mine)) return; // replaced under my name is impossible; vanished/corrupt: nothing to do
    try { fsImpl.unlinkSync(leaseFileFor(lease.name)); } catch { /* best effort: dead-owner GC covers it */ }
  }

  function acquire() {
    const self = readStartTimeImpl(pid);
    const mine = {
      schemaVersion: IDLE_SUPERVISOR_SCHEMA_VERSION,
      pid, processStartTime: self ? self.processStartTime : null,
      bootId: currentBootId ?? null, cwd, acquiredAt: clock(),
      // canonical owner metadata (observability only — NEVER the lock key)
      stateDir: stateDir ? path.resolve(stateDir) : null,
    };
    try { fsImpl.mkdirSync(machineDir, { recursive: true }); } catch { /* dir may exist */ }
    for (let attempt = 0; attempt < OWNERSHIP_RECLAIM_ATTEMPTS; attempt++) {
      try {
        fsImpl.writeFileSync(lockPath, `${JSON.stringify(mine, null, 2)}\n`, { flag: 'wx' });
        owned = mine;
        return { ok: true, status: 'ACQUIRED', owner: mine };
      } catch (e) {
        if (!e || e.code !== 'EEXIST') {
          return { ok: false, status: 'OWNERSHIP_LOCK_UNAVAILABLE', detail: String((e && e.message) || e) };
        }
        const holder = parseOwner(readRaw(lockPath));
        if (sameOwner(holder, mine)) { owned = holder; return { ok: true, status: 'ALREADY_OWNER', owner: holder }; }
        if (!ownerIsStale(holder)) {
          return { ok: false, status: 'SUPERVISOR_ALREADY_RUNNING', owner: holder ? { pid: holder.pid, bootId: holder.bootId } : null };
        }
        // Stale holder: the unlink+claim critical section is SERIALIZED by
        // generation-immutable reclaim authority (see claimReclaimLease). A
        // concurrent reclaimer that observed the SAME stale holder yields to
        // the newest live authority instead of ever unlinking the winner's
        // live lock — no fixed-path lease is deleted on this path at all.
        const lease = claimReclaimLease(self);
        if (!lease.ok) {
          if (lease.status === 'LEASE_UNAVAILABLE') {
            return { ok: false, status: 'OWNERSHIP_LOCK_UNAVAILABLE', detail: `reclaim-lease: ${lease.detail}` };
          }
          continue; // live reclaimer in progress: bounded retry, fail-closed below
        }
        try {
          const rawNow = readRaw(lockPath);
          const holderNow = parseOwner(rawNow);
          if (rawNow == null) { /* already gone: fall through to retry claim */ }
          else if (sameOwner(holderNow, mine)) { owned = holderNow; return { ok: true, status: 'ALREADY_OWNER', owner: holderNow }; }
          else if (!ownerIsStale(holderNow)) {
            // A replacement LIVE owner appeared during reclaim: NEVER unlink.
            return { ok: false, status: 'SUPERVISOR_ALREADY_RUNNING', owner: holderNow ? { pid: holderNow.pid, bootId: holderNow.bootId } : null };
          } else {
            // ponytail: the raw-equality guard on the (fixed-name) main-lock
            // unlink is safe only because THIS path runs under the unique
            // newest-live reclaim authority; a stale observer can never reach
            // it while a live authority exists. A true CAS-unlink does not
            // exist on Windows; if the main lock ever needs the same property
            // as the lease, migrate it to generation-immutable records too.
            try { fsImpl.unlinkSync(lockPath); }
            catch (ue) { if (!ue || ue.code !== 'ENOENT') return { ok: false, status: 'OWNERSHIP_LOCK_UNAVAILABLE', detail: String((ue && ue.message) || ue) }; }
          }
        } finally {
          releaseReclaimLease(lease);
        }
      }
    }
    return { ok: false, status: 'SUPERVISOR_ALREADY_RUNNING', detail: 'reclaim-contention' };
  }

  // Release ONLY the lock we still own. If a replacement owner already wrote a
  // different {pid,processStartTime,bootId}, the read-back mismatches and the
  // foreign lock is left intact (never delete a replacement owner's lock).
  function release() {
    if (!owned) return { ok: true, released: false, reason: 'NOT_OWNER' };
    let cur = null;
    try { cur = JSON.parse(fsImpl.readFileSync(lockPath, 'utf8')); }
    catch (e) { return { ok: true, released: false, reason: e && e.code === 'ENOENT' ? 'LOCK_ABSENT' : 'LOCK_UNREADABLE' }; }
    if (!sameOwner(cur, owned)) return { ok: true, released: false, reason: 'NOT_CURRENT_OWNER' };
    try { fsImpl.unlinkSync(lockPath); return { ok: true, released: true }; }
    catch { return { ok: true, released: false, reason: 'UNLINK_FAILED' }; }
  }

  return { acquire, release, lockPath, reclaimDir: leaseDir, machineDir, get owner() { return owned; } };
}

// ---- logging (bounded jsonl, inside the supervisor's own state dir only) ------

function appendLog(stateDir, rec) {
  try {
    const dir = idleSupervisorDirFor({ stateDir });
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'supervisor.log');
    const line = JSON.stringify({ schemaVersion: IDLE_SUPERVISOR_SCHEMA_VERSION, at: new Date().toISOString(), ...rec }) + '\n';
    let size = 0;
    try { size = fs.statSync(p).size; } catch { /* first write */ }
    if (size > 512 * 1024) { // hard cap: keep the newest half
      const old = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(p, old.slice(Math.floor(old.length / 2)).join('\n') + '\n');
    }
    fs.appendFileSync(p, line, 'utf8');
  } catch { /* logging never breaks supervision */ }
}

// ---- supervision loop ----------------------------------------------------------

function defaultStateDir() {
  if (process.env.SOC_STATE_DIR) return path.resolve(process.env.SOC_STATE_DIR);
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, '.soc-brain', 'state');
}

export function createSupervisorRuntime({
  config, stateDir = defaultStateDir(), deps = createWindowsDeps(), log = () => {},
  clock = Date.now, bootId: bootIdInjected = null,
} = {}) {
  const supervisor = createIdleSupervisor({ config, stateDir, clock });
  let lastTickAt = null;
  let bootId = bootIdInjected != null ? bootIdInjected : (deps.readBootId ? deps.readBootId() : null);
  let prevState = null;

  function oneTick({ resumed = false } = {}) {
    const now = clock();
    if (lastTickAt != null && now - lastTickAt > RESUME_GAP_MS) resumed = true;
    if (resumed) {
      const newBootId = deps.readBootId ? deps.readBootId() : null;
      if (newBootId && bootId && newBootId !== bootId) {
        log({ event: 'BOOT_ID_CHANGED', from: bootId, to: newBootId });
      }
      bootId = newBootId || bootId;
      supervisor.markResumed({ now });
      log({ event: 'RESUME_REINITIALIZED', bootId });
    }
    lastTickAt = now;
    const userIdleMs = deps.readUserIdleMs ? deps.readUserIdleMs() : 0;
    const activity = scanCanonicalActivity({ stateDir, clock });
    const r = supervisor.tick({ activity, userIdleMs: userIdleMs ?? 0, now, resumed: false });
    if (r.state !== prevState) { log({ event: 'STATE', from: prevState, to: r.state, reason: r.reason ?? null }); prevState = r.state; }

    let outState = r.state;
    if (r.state === 'SLEEP_ELIGIBLE' && typeof r.finalize === 'function') {
      // Final canonical read-back on a FRESH scan: one UNKNOWN or any active
      // work aborts the sleep right here — never a stale-scan sleep.
      const fresh = scanCanonicalActivity({ stateDir, clock });
      if (!fresh.known || fresh.activeCanonicalTasks !== 0 || fresh.pendingControlWork !== 0) {
        log({ event: 'SLEEP_ABORTED_FINAL_READBACK', activity: fresh });
        outState = 'BUSY'; // stay awake, keep monitoring
      } else {
        const fin = r.finalize(fresh); // persists evidence BEFORE any OS call
        if (!fin.ok) {
          log({ event: 'SLEEP_FINALIZE_REJECTED', code: fin.code, detail: fin.detail ?? null });
          outState = 'BUSY';
        } else {
          log({ event: 'SLEEP_EVIDENCE_PERSISTED', policy: fin.evidence.policy, checkedAt: fin.evidence.checkedAt });
          let res;
          try { res = deps.requestSleep(); } catch (e) {
            res = { ok: false, action: 'SLEEP', detail: String((e && e.message) || e) };
          }
          log({ event: 'SLEEP_REQUEST_DISPATCHED', dryRun: res.dryRun === true, ok: res.ok, detail: res.detail ?? null });
          supervisor.markRequestOutcome({ result: res.ok ? 'SLEEP_REQUEST_DISPATCHED' : 'SLEEP_REQUEST_FAILED' });
          outState = fin.state;
        }
      }
    }
    return { state: outState, activity, userIdleMs };
  }

  function startDaemon({ pollMs = config.pollSec * 1000 } = {}) {
    log({ event: 'SUPERVISOR_STARTED', enabled: config.enabled, allowRealSleep: config.allowRealSleep, bootId, pollMs });
    let stopped = false;
    let timer = null;
    const loop = () => {
      if (stopped) return;
      try { oneTick(); } catch (e) { log({ event: 'TICK_ERROR', detail: String((e && e.message) || e) }); }
      if (!config.enabled) { log({ event: 'SUPERVISOR_EXIT_DISABLED' }); return; }
      timer = setTimeout(loop, pollMs);
    };
    timer = setTimeout(loop, 0);
    return { stop() { stopped = true; clearTimeout(timer); } };
  }

  return { supervisor, oneTick, startDaemon };
}

// ---- CLI -----------------------------------------------------------------------

function printStatus({ stateDir, config }) {
  const ev = readSleepEvidence({ stateDir });
  const out = {
    schemaVersion: IDLE_SUPERVISOR_SCHEMA_VERSION,
    enabled: config.enabled,
    allowRealSleep: config.allowRealSleep,
    config: {
      dayGraceMs: config.dayGraceMs, nightGraceMs: config.nightGraceMs,
      nightStart: `${String(config.nightStart.h).padStart(2, '0')}:${String(config.nightStart.m).padStart(2, '0')}`,
      nightEnd: `${String(config.nightEnd.h).padStart(2, '0')}:${String(config.nightEnd.m).padStart(2, '0')}`,
      pollSec: config.pollSec,
    },
    stateDir,
    sleepEvidence: ev.ok ? ev.evidence : { error: ev.reason },
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  return out;
}

const IS_CLI = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('run.mjs');
if (IS_CLI) {
  const args = process.argv.slice(2);
  const cfg = readIdleSleepConfig(process.env);
  if (!cfg.ok) { console.error(`IDLE_SLEEP_SUPERVISOR_CONFIG_INVALID: ${cfg.reason}`); process.exit(2); }
  const config = cfg.config;
  const stateDir = config.stateDir || defaultStateDir();
  const deps = createWindowsDeps({ env: process.env });
  if (args.includes('--status')) {
    const out = printStatus({ stateDir, config });
    process.exit(out.enabled ? 0 : 3);
  }
  if (args.includes('--once')) {
    const rt = createSupervisorRuntime({ config, stateDir, deps, log: (r) => process.stdout.write(JSON.stringify(r) + '\n') });
    const t = rt.oneTick();
    process.stdout.write(JSON.stringify({ tick: { state: t.state, activity: t.activity, userIdleMs: t.userIdleMs } }, null, 2) + '\n');
    process.exit(0);
  }
  if (!args.includes('--daemon')) {
    console.error('usage: node run.mjs --daemon | --once | --status');
    process.exit(2);
  }
  // A DISABLED daemon decides nothing (startDaemon self-exits on the first
  // tick) — it must not claim or leave the sleep-authority singleton lock.
  if (!config.enabled) {
    createSupervisorRuntime({ config, stateDir, deps, log: (r) => appendLog(stateDir, r) }).startDaemon();
  } else {
    // Machine-GLOBAL singleton: exactly ONE supervisor holds the sleep
    // authority on this machine (lock lives in the machine namespace, not the
    // per-worktree stateDir). Foreign live owner => exit harmlessly (never
    // kill/unlink). Stale owner => controlled reclaim, then claim.
    // bootId is read ONCE here and reused for ownership + runtime (the runtime
    // only re-reads it on a detected resume) — no duplicate PowerShell probe.
    const bootId = deps.readBootId ? deps.readBootId() : null;
    const ownership = createSupervisorOwnership({ stateDir, deps, bootId, cwd: process.cwd() });
    const own = ownership.acquire();
    if (!own.ok) {
      appendLog(stateDir, {
        event: own.status === 'SUPERVISOR_ALREADY_RUNNING' ? 'SUPERVISOR_ALREADY_RUNNING' : 'SUPERVISOR_OWNERSHIP_UNAVAILABLE',
        status: own.status, owner: own.owner ?? null, detail: own.detail ?? null,
      });
      process.exit(0); // second live instance exits 0: it decides nothing, kills nothing
    }
    appendLog(stateDir, { event: 'SUPERVISOR_OWNER_CLAIMED', pid: own.owner.pid, bootId: own.owner.bootId, machineDir: ownership.machineDir });
    const rt = createSupervisorRuntime({ config, stateDir, deps, bootId, log: (r) => appendLog(stateDir, r) });
    const daemon = rt.startDaemon();
    let releasing = false;
    const releaseAndExit = (signal) => {
      if (releasing) return; releasing = true;
      appendLog(stateDir, { event: 'SUPERVISOR_EXIT', signal });
      try { daemon.stop(); } catch { /* best effort */ }
      try { ownership.release(); } catch { /* best effort: stale reclaim covers it */ }
      process.exit(0);
    };
    process.on('SIGTERM', () => releaseAndExit('SIGTERM'));
    process.on('SIGINT', () => releaseAndExit('SIGINT'));
  }
}
