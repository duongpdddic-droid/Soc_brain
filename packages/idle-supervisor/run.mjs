#!/usr/bin/env node
// run.mjs — Idle Hibernate Supervisor companion service (Windows-first).
//
// Runs ALONGSIDE the Soc_brain runtime (spawned by the control-ui launcher
// when SOC_IDLE_HIBERNATE=1). Read-only over the canonical control plane; its
// ONLY privileged capability is the Windows HIBERNATE power action, which stays
// INERT unless the explicit production flag SOC_IDLE_HIBERNATE_ALLOW_REAL=1 is
// set (legacy alias SOC_IDLE_SLEEP_ALLOW_REAL_SLEEP=1):
//   - flag absent (tests, smoke, dry-run): the hibernate request is logged,
//     never executed — an automated test can never hibernate the real machine;
//   - flag present: Hibernate via rundll32 powrprof SetSuspendState 1,1,0
//     (Hibernate flag = 1 — Hibernate, NEVER Sleep/S3). A non-mutating
//     `powercfg /a` preflight must confirm Hibernate is available first; if it
//     is not, the decision fails closed as HUMAN_GATE_REQUIRED (the exact admin
//     action `powercfg /hibernate on` is REPORTED, never executed) — no Sleep.
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
  IDLE_SUPERVISOR_SCHEMA_VERSION, readIdleHibernateConfig, createIdleSupervisor,
  scanCanonicalActivity, idleSupervisorDirFor, readHibernateEvidence, normalizeWarningResult,
} from './idle-supervisor.mjs';
import { runWindowsHibernateWarning } from './windows-warning.mjs';
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

// Non-mutating Windows power-capability probe. Lists the sleep states the OS
// reports as AVAILABLE. Never enables/disables anything (no write, no elevation).
const HIBERNATE_CAP_PS = 'powercfg /a';

// Parse `powercfg /a` output -> { available: boolean }. Hibernate counts as
// available ONLY when it is listed under the AVAILABLE block, i.e. before the
// "not available" header. ponytail: matches the English state label the OS
// prints (verified on this host); a localized Windows may print a translated
// label — upgrade path is to read the `HibernateEnabled` power scheme GUID via
// `powercfg /query` if localization is ever required. Unparseable output ->
// not available (fail-closed: never assume we may hibernate).
export function parseHibernateAvailable(raw) {
  if (typeof raw !== 'string') return false;
  const text = raw.replace(/\r/g, '');
  const notAvailAt = text.search(/not\s+available/i);
  const availBlock = notAvailAt === -1 ? text : text.slice(0, notAvailAt);
  return /^\s*Hibernate\b/m.test(availBlock);
}

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
    // unmeasurable user idle never enables a DAY hibernate).
    readUserIdleMs() {
      const out = ps(USER_IDLE_PS);
      if (out == null) return null;
      const n = Number(out);
      return Number.isFinite(n) && n >= 0 ? n : null;
    },
    // Machine boot identity: changes across reboot, stable across Hibernate/wake.
    readBootId() { return ps(BOOT_ID_PS); },
    // PID-reuse-safe liveness primitives for the singleton owner record.
    isAlive(pid) { return winIsAlive(pid); },
    readProcessStartTime(pid) { return readWin32ProcessStartTime(pid, spawnSyncImpl); },
    // Non-mutating capability preflight. Returns { ok, reason?, detail? }.
    // ok:false (incl. any probe error) fails closed to HUMAN_GATE_REQUIRED.
    checkHibernateAvailable() {
      const out = (() => {
        const r = spawnSyncImpl('powercfg.exe', ['/a'], { encoding: 'utf8', timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true });
        if (r.error || r.status !== 0) return null;
        return String(r.stdout || '');
      })();
      if (out == null) {
        return { ok: false, reason: 'HIBERNATE_CAPABILITY_UNREADABLE', detail: 'powercfg /a did not return a readable result' };
      }
      if (!parseHibernateAvailable(out)) {
        return {
          ok: false,
          reason: 'HIBERNATE_UNAVAILABLE',
          detail: 'Hibernate is not available. Admin action required: run `powercfg /hibernate on` (elevated). The supervisor will not run it and will not fall back to Sleep.',
        };
      }
      return { ok: true };
    },
    // Issue #177: bounded pre-hibernate warning window. Returns CANCELLED |
    // TIMEOUT | FAILED (normalized). NO power capability here — only the
    // supervisor, after a fresh revalidation, decides whether to hibernate.
    runWarning({ seconds = 60, title, text, cancelLabel } = {}) {
      return normalizeWarningResult(runWindowsHibernateWarning({
        seconds, title, text, cancelLabel, spawnSyncImpl, powershell,
      }));
    },
    // THE power capability. Hibernate (SetSuspendState Hibernate=1), never
    // Sleep/S3. Without the explicit production flag this is a dry-run: nothing
    // reaches the OS.
    requestHibernate() {
      if (env.SOC_IDLE_HIBERNATE_ALLOW_REAL !== '1' && env.SOC_IDLE_SLEEP_ALLOW_REAL_SLEEP !== '1') {
        return { ok: true, dryRun: true, action: 'HIBERNATE' };
      }
      const r = spawnSyncImpl('rundll32.exe', ['powrprof.dll,SetSuspendState', '1,1,0'], {
        encoding: 'utf8', timeout: 60_000, windowsHide: true,
      });
      if (r.error) return { ok: false, action: 'HIBERNATE', detail: String(r.error.message || r.error) };
      return { ok: r.status === 0 || r.status == null, action: 'HIBERNATE', exitCode: r.status };
    },
  };
}

// ---- companion-service spawn (used by the Soc_brain runtime launcher) --------

export function spawnIdleSupervisor({ repoRoot, env = process.env, spawnImpl = spawn, deps = null } = {}) {
  if (env.SOC_IDLE_HIBERNATE !== '1' && env.SOC_IDLE_SLEEP !== '1') return null; // explicit enable only
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

// ---- machine-GLOBAL singleton (one canonical hibernate owner per machine) ----
//
// Exactly ONE supervisor may decide a real OS hibernate per machine (the power
// action is machine-global). Ownership is therefore NOT keyed on the per-repo/
// per-worktree stateDir (SOC_STATE_DIR differs between main and worktrees —
// that forking is the observed 5-daemon bug): the lock lives in a single
// machine namespace. Stale-owner detection is PID/startTime/bootId safe; a
// foreign LIVE owner is never killed and its lock is never unlinked.
//
// NOTE: this uses pid/startTime ONLY for OWNERSHIP reconciliation. It is not an
// activity authority (the canonical scan remains the sole hibernate authority).

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

// Reclaim authority directory: stale-reclaim is serialized by a DIRECTORY-
// EPOCH CAS. The authority lives in `supervisor.reclaim/authority.slot.d/` as
// a claim file whose NAME is bound to its generation (`claim-<pid>-<nonce>`).
// Election: rmdir+mkdir(CAS, fails EEXIST) open a fresh epoch; link(cand ->
// own claim name) is the atomic establishment; a live claim file makes the
// epoch undeletable (rmdir fails ENOTEMPTY — an atomic content check no file
// unlink can offer). A stale observer's removals therefore target only
// GENERATION-BOUND names it proved dead — a replacement generation has a
// structurally different name and cannot be deleted by it even in principle.
// Never wall-clock/pid/nonce-ordered.
export function reclaimLeasePathFor({ machineDir = machineSupervisorDir() } = {}) {
  return path.join(machineDir, 'supervisor.reclaim');
}
export function reclaimAuthorityDirFor({ machineDir = machineSupervisorDir() } = {}) {
  return path.join(reclaimLeasePathFor({ machineDir }), 'authority.slot.d');
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

  // --- reclaim authority: DIRECTORY-EPOCH CAS (generation-bound names) ----
  // Election artifacts: an epoch directory `authority.slot.d` opened by
  // mkdir-CAS, holding claim files whose NAMES are generation-bound
  // (`claim-<pid>-<nonce>.lock`). Retirement of a proven-stale generation
  // deletes ONLY that generation's own name (bytes first preserved via a
  // quarantine link); closing an epoch is fenced by rmdir's atomic
  // ENOTEMPTY. A stale decision therefore has NO operation that can reach a
  // replacement generation: different name, and a live claim makes its epoch
  // undeletable. Winner = the mkdir-CAS epoch creator whose linked claim is
  // the epoch's unique live record, CONFIRMED at claim and again at the
  // main-lock decision point. Wall clock/pid/nonce ordering is never
  // consulted; live bytes are never deleted; no blind kill.
  const slotDir = reclaimAuthorityDirFor({ machineDir });
  function claimPathFor(name) { return path.join(slotDir, name); }
  function myClaimName(mine) { return `claim-${pid}-${String(mine.nonce).slice(0, 12)}.lock`; }

  // state: live | stale | empty | absent | unreadable (fail-closed)
  function authorityRecord() {
    let entries;
    try { entries = fsImpl.readdirSync(slotDir); }
    catch (e) {
      if (e && e.code === 'ENOENT') return { state: 'absent' };
      return { state: 'unreadable' };
    }
    const names = entries.filter((n) => typeof n === 'string' && n.startsWith('claim-') && n.endsWith('.lock')).sort();
    for (const n of names) {
      const raw = readRaw(claimPathFor(n));
      if (raw == null) continue;
      const rec = parseOwner(raw);
      if (rec && !authorityIsStale(rec)) return { state: 'live', name: n, rec, raw }; // LIVE claim: never touched
    }
    return names.length ? { state: 'stale', names } : { state: 'empty' };
  }

  // THIS process holds the authority only while ITS OWN generation-bound
  // claim name parses to its nonce+pid identity.
  function holdsReclaimAuthority(mine) {
    if (!mine) return false;
    const rec = parseOwner(readRaw(claimPathFor(myClaimName(mine))));
    return Boolean(rec && rec.nonce === mine.nonce && rec.pid === pid);
  }

  function listClaimNames() {
    let names;
    try { names = fsImpl.readdirSync(leaseDir); } catch { return []; }
    return names.filter((n) => typeof n === 'string' && (n.startsWith('cand-') || n.startsWith('quar-'))).sort();
  }

  // Positive staleness evidence ONLY (same rule as the owner lock): corrupt,
  // boot generation changed, pid gone, or pid alive with a different Win32
  // start time. Absent evidence => LIVE => never touched.
  function authorityIsStale(rec) {
    if (!rec || !Number.isInteger(rec.pid) || rec.pid <= 0) return true;
    if (currentBootId && rec.bootId && rec.bootId !== currentBootId) return true;
    if (!isAliveImpl(rec.pid)) return true;
    if (rec.processStartTime != null) {
      const cur = readStartTimeImpl(rec.pid);
      if (cur && cur.processStartTime !== rec.processStartTime) return true; // PID reuse
    }
    return false;
  }

  // After winning, remove root-level candidate/quarantine garbage. Rival
  // candidates are inert records: establishing authority requires the claim
  // LINK inside a CAS-opened epoch directory, never a root file.
  function pruneReclaimGarbage() {
    for (const name of listClaimNames()) {
      try { fsImpl.unlinkSync(path.join(leaseDir, name)); } catch { /* best effort */ }
    }
  }

  // Election is a DIRECTORY-EPOCH CAS chain, all generation-bound:
  //   * stale claims are retired ONLY through quarantine-link (byte evidence
  //     preserved) + unlink of THAT EXACT claim NAME. A replacement generation
  //     is a different, never-before-seen name — a stale decision cannot
  //     target it even in principle (this is the TOCTOU the fixed-slot
  //     check->unlink could not close).
  //   * the epoch itself closes/fences through rmdir: ENOTEMPTY is an ATOMIC
  //     content check — an epoch holding a live claim is undeletable.
  //   * mkdir(CAS, EEXIST-fails) opens the next epoch; only the creator links
  //     its claim; confirmation requires the epoch's unique live claim to be
  //     MY name. Late/duplicate-open epochs self-demote by removing ONLY
  //     their own generation-bound name.
  function claimReclaimAuthority(self) {
    for (let i = 0; i < OWNERSHIP_RECLAIM_ATTEMPTS; i++) {
      const a = authorityRecord();
      if (a.state === 'live' || a.state === 'unreadable') continue; // LIVE authority or unreadable epoch: never touch; fail closed at budget
      if (a.state === 'stale') {
        let aborted = false;
        for (const n of a.names) {
          const cp = claimPathFor(n);
          const seen = readRaw(cp);
          if (seen == null) continue; // already retired by a racer: nothing to touch
          try { fsImpl.mkdirSync(leaseDir, { recursive: true }); } catch { /* may exist */ }
          const q = path.join(leaseDir, `quar-${String(randomUUID()).slice(0, 8)}.lock`);
          try { fsImpl.linkSync(cp, q); }
          catch (e) { if (e && e.code === 'ENOENT') continue; aborted = true; break; }
          if (readRaw(q) !== seen) { try { fsImpl.unlinkSync(q); } catch { /* best effort */ } aborted = true; break; }
          try { fsImpl.unlinkSync(cp); }
          catch (e) { if (!e || e.code !== 'ENOENT') { aborted = true; break; } }
          try { fsImpl.unlinkSync(q); } catch { /* best effort */ }
        }
        if (aborted) continue;
        try { fsImpl.rmdirSync(slotDir); } // succeeds ONLY while the epoch is truly empty
        catch (e) {
          if (e && e.code === 'ENOTEMPTY') continue; // a live claim appeared: fenced, re-decide
          if (!e || e.code !== 'ENOENT') return { ok: false, status: 'LEASE_UNAVAILABLE', detail: String((e && e.message) || e) };
        }
      } else if (a.state === 'empty') {
        // Empty epoch (crashed claimant between mkdir and link): close it the
        // same fenced way, then re-open via CAS below.
        try { fsImpl.rmdirSync(slotDir); }
        catch (e) {
          if (e && e.code === 'ENOTEMPTY') continue;
          if (!e || e.code !== 'ENOENT') return { ok: false, status: 'LEASE_UNAVAILABLE', detail: String((e && e.message) || e) };
        }
      }
      try { fsImpl.mkdirSync(leaseDir, { recursive: true }); } catch { /* may exist */ }
      try { fsImpl.mkdirSync(slotDir); } // THE epoch-open CAS: exactly one creator wins
      catch (e) {
        if (e && e.code === 'EEXIST') continue; // racer opened the epoch first: re-decide
        return { ok: false, status: 'LEASE_UNAVAILABLE', detail: String((e && e.message) || e) };
      }
      const mine = {
        schemaVersion: IDLE_SUPERVISOR_SCHEMA_VERSION,
        pid, processStartTime: self ? self.processStartTime : null,
        nonce: randomUUID(), acquiredAt: clock(), // observability ONLY — never ordering
        bootId: currentBootId ?? null,
      };
      const name = myClaimName(mine);
      const candPath = path.join(leaseDir, `cand-${pid}-${String(mine.nonce).slice(0, 8)}.lock`);
      let failed = false;
      try { fsImpl.writeFileSync(candPath, `${JSON.stringify(mine, null, 2)}\n`, { flag: 'wx' }); }
      catch { failed = true; }
      if (!failed) {
        let linkErr = null;
        try { fsImpl.linkSync(candPath, claimPathFor(name)); } catch (e) { linkErr = e; } // establishment: name-bound, create-if-absent
        if (linkErr) {
          failed = true;
          if (!(linkErr.code === 'ENOENT' || linkErr.code === 'EEXIST')) {
            try { fsImpl.unlinkSync(candPath); } catch { /* best effort */ }
            return { ok: false, status: 'LEASE_UNAVAILABLE', detail: String((linkErr && linkErr.message) || linkErr) };
          }
        }
      }
      try { fsImpl.unlinkSync(candPath); } catch { /* root garbage either way */ }
      if (failed) continue; // epoch stolen/fenced under us: re-decide
      const b = authorityRecord(); // CONFIRM: the epoch's unique live claim must be MY name
      if (!(b.state === 'live' && b.name === name)) {
        if (b.state !== 'unreadable') { try { fsImpl.unlinkSync(claimPathFor(name)); } catch { /* own name only */ } }
        continue;
      }
      pruneReclaimGarbage();
      return { ok: true, mine, name };
    }
    return { ok: false, status: 'LEASE_BUSY', detail: 'authority-contention' };
  }

  // Release touches ONLY my own generation-bound claim name; closing the
  // epoch is fenced by rmdir's ENOTEMPTY (a live successor claim survives it).
  function releaseReclaimAuthority(claim) {
    if (!claim || !claim.mine || !claim.name) return;
    const cp = claimPathFor(claim.name);
    const rec = parseOwner(readRaw(cp));
    if (rec && rec.nonce === claim.mine.nonce && rec.pid === pid) {
      try { fsImpl.unlinkSync(cp); } catch { /* best effort: proven-dead reclaim covers it */ }
    }
    try { fsImpl.rmdirSync(slotDir); } catch { /* occupied or already gone: someone else's epoch now */ }
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
        // the directory-epoch reclaim authority (claimReclaimAuthority).
        // Winner = mkdir-CAS epoch creator with a generation-bound claim;
        // a concurrent reclaimer either sees the live claim (yield) or is
        // fenced out (EEXIST/ENOTEMPTY) — it can never unlink or overwrite
        // the winner's live lock.
        const claim = claimReclaimAuthority(self);
        if (!claim.ok) {
          if (claim.status === 'LEASE_UNAVAILABLE') {
            return { ok: false, status: 'OWNERSHIP_LOCK_UNAVAILABLE', detail: `reclaim-authority: ${claim.detail}` };
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
          } else if (!holdsReclaimAuthority(claim.mine)) {
            // My generation-bound claim vanished or was fenced out since the
            // confirm: I am NOT the authority. NEVER unlink; self-demote,
            // release in `finally`, fail closed.
            return { ok: false, status: 'SUPERVISOR_ALREADY_RUNNING', detail: 'authority-lost' };
          } else {
            // ponytail: this main-lock unlink executes ONLY while the epoch
            // directory still holds MY live, generation-bound claim
            // (decision point above). A true CAS-unlink does not exist on
            // Windows for shared names, which is why every reclaim-side
            // removal here is either a claim-name-bound delete (cannot
            // address a different generation) or a fenced rmdir (atomic
            // ENOTEMPTY while a live claim is inside). The main lock keeps
            // single established-owner + positive-proof reclaim semantics.
            try { fsImpl.unlinkSync(lockPath); }
            catch (ue) { if (!ue || ue.code !== 'ENOENT') return { ok: false, status: 'OWNERSHIP_LOCK_UNAVAILABLE', detail: String((ue && ue.message) || ue) }; }
          }
        } finally {
          releaseReclaimAuthority(claim);
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

// F5 (Issue #172) — machine/action authority. A machine-GLOBAL power action must
// be governed by a machine-GLOBAL activity view. The canonical activity root is
// the single machine-local control plane (see runtime-sandbox: authoritative task
// state lives OUTSIDE every worktree under ~/.soc-brain/state). A daemon pointed
// at a NON-canonical SOC_STATE_DIR (a worktree/override root) cannot see the
// whole machine's activity and therefore must NEVER hold real-power authority —
// it is forced to a dry-run (observes + logs, never touches the OS). Chosen over
// unioning every live root: the repo architecture declares a single canonical
// root, so enforcing it is the minimum correct solution and fails closed.
function canonicalMachineStateDir() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, '.soc-brain', 'state');
}

export function assertPowerAuthority({ config, stateDir, canonical = canonicalMachineStateDir() } = {}) {
  if (!config || config.allowRealHibernate !== true) return { ok: true, realPower: false }; // dry-run anyway
  if (path.resolve(stateDir) !== path.resolve(canonical)) {
    return { ok: false, reason: 'NON_CANONICAL_STATE_DIR_POWER_AUTHORITY_DENIED', detail: `real power requires the canonical machine state root (${canonical}); this daemon is bound to ${stateDir}` };
  }
  return { ok: true, realPower: true };
}

// Bind the deployed ACTION to the authorized MODE. This build's only power verb
// is Hibernate; if the injected surface exposes a Sleep verb (a stale #165 build)
// or is missing the Hibernate verb, it must not masquerade as Hibernate authority.
export const POWER_ACTION = 'HIBERNATE';
export function assertActionAuthority({ deps } = {}) {
  const hasHibernate = deps && typeof deps.requestHibernate === 'function';
  const hasSleep = deps && typeof deps.requestSleep === 'function';
  if (!hasHibernate) return { ok: false, reason: 'ACTION_AUTHORITY_MISSING_HIBERNATE' };
  if (hasSleep) return { ok: false, reason: 'ACTION_AUTHORITY_SLEEP_BUILD_FORBIDDEN' };
  return { ok: true, action: POWER_ACTION };
}

export function createSupervisorRuntime({
  config, stateDir = defaultStateDir(), deps = createWindowsDeps(), log = () => {},
  clock = Date.now, bootId: bootIdInjected = null,
} = {}) {
  const supervisor = createIdleSupervisor({ config, stateDir, clock });
  let lastTickAt = null;
  let bootId = bootIdInjected != null ? bootIdInjected : (deps.readBootId ? deps.readBootId() : null);
  let prevState = null;

  // F5: resolve REAL-power authority once per runtime. A non-canonical stateDir,
  // or an action/build mismatch, forces every dispatch to a safe dry-run (the OS
  // is never reached) and is logged. Tests pass allowRealHibernate=false so this
  // is inert unless a real-power deployment is misconfigured.
  const powerAuth = assertPowerAuthority({ config, stateDir });
  const actionAuth = assertActionAuthority({ deps });
  let realPowerAllowed = powerAuth.ok === true && actionAuth.ok === true;
  if (config.allowRealHibernate === true && !realPowerAllowed) {
    log({ event: 'POWER_AUTHORITY_DENIED', reason: !powerAuth.ok ? powerAuth.reason : actionAuth.reason, detail: (!powerAuth.ok ? powerAuth.detail : actionAuth.detail) ?? null });
  }

  // Issue #177: the bounded pre-hibernate warning window. Defaults to a FAILED
  // helper so an environment that cannot show/await a warning NEVER proceeds to
  // power (fail closed). Production createWindowsDeps provides the real helper.
  const warningRunner = typeof deps.runWarning === 'function'
    ? (o) => { try { return normalizeWarningResult(deps.runWarning(o)); } catch { return 'FAILED'; } }
    : () => 'FAILED';
  let warnedGeneration = null; // invariant 7/8: at most one active warning per generation

  // One canonical activity scan, thread the PID-reuse-safe liveness primitives so
  // registered executor leases and execution identity are observed (F1).
  function scanNow() {
    return scanCanonicalActivity({
      stateDir, clock,
      isAlive: deps.isAlive, readStartTime: deps.readProcessStartTime, bootId,
    });
  }

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
      warnedGeneration = null; // #177: a restart never resumes a stale warning
      log({ event: 'RESUME_REINITIALIZED', bootId });
    }
    lastTickAt = now;
    const userIdleMs = deps.readUserIdleMs ? deps.readUserIdleMs() : 0;
    const activity = scanNow();
    const r = supervisor.tick({ activity, userIdleMs: userIdleMs ?? 0, now, resumed: false });
    if (r.state !== prevState) { log({ event: 'STATE', from: prevState, to: r.state, reason: r.reason ?? null }); prevState = r.state; }

    let outState = r.state;
    if (r.state === 'HIBERNATE_ELIGIBLE' && typeof r.generation === 'number') {
      const gen = r.generation;
      // Invariant 7/8: this generation already produced a warning this session.
      // Never open a second popup and never power on a stale decision.
      if (warnedGeneration === gen) {
        outState = 'WAIT_USER_IDLE'; // stay awake; re-arm only on a new generation
      } else {
        // (1) capability preflight FIRST (never widens scan->OS).
        const cap = deps.checkHibernateAvailable ? deps.checkHibernateAvailable() : { ok: true };
        if (cap.ok !== true) {
          log({ event: 'HIBERNATE_HUMAN_GATE_REQUIRED', reason: cap.reason || 'HIBERNATE_UNAVAILABLE', detail: cap.detail ?? null });
          outState = 'HUMAN_GATE_REQUIRED';
        } else {
          // mark the generation warned BEFORE opening (single warning per gen, even
          // if this tick later aborts — the countdown must not be re-opened).
          warnedGeneration = gen;
          // (2) authority scan PASS — pre-warning, non-persisting.
          const preOk = supervisor.revalidate({ activity: scanNow(), userIdleMs: userIdleMs ?? 0, now: clock(), boundGen: gen });
          if (!preOk.ok) {
            log({ event: 'HIBERNATE_WARNING_PRECHECK_ABORT', code: preOk.code });
            outState = 'BUSY';
          } else {
            // (3) SHOW WARNING (bounded). TIMEOUT does NOT authorize power on its own.
            const wres = warningRunner({ seconds: config.warningSeconds ?? 0, generation: gen });
            if (wres !== 'TIMEOUT') {
              // CANCELLED (button/X/new input) or FAILED (crash/timeout/ambiguous) -> zero power.
              supervisor.markWarningCancelled({ now: clock() });
              log({ event: 'HIBERNATE_WARNING_CANCELLED', result: wres });
              outState = 'WAIT_USER_IDLE';
            } else {
              // (4) FINAL FRESH REVALIDATION — new scan + all conditions + generation
              // + operator presence + authority. Invariant 6: never reuse the
              // pre-countdown snapshot. finalizeHibernate persists ONLY if fully clear.
              const fin = supervisor.finalizeHibernate({ activity: scanNow(), userIdleMs: userIdleMs ?? 0, now: clock(), generation: gen });
              if (!fin.ok) {
                log({ event: 'HIBERNATE_FINAL_REVALIDATION_ABORT', code: fin.code, detail: fin.detail ?? null });
                outState = 'BUSY';
              } else {
                log({ event: 'HIBERNATE_EVIDENCE_PERSISTED', policy: fin.evidence.policy, checkedAt: fin.evidence.checkedAt, warningSeconds: fin.evidence.warningSeconds });
                let res;
                if (!realPowerAllowed) {
                  res = { ok: true, dryRun: true, action: 'HIBERNATE' };
                } else {
                  try { res = deps.requestHibernate(); } catch (e) {
                    res = { ok: false, action: 'HIBERNATE', detail: String((e && e.message) || e) };
                  }
                }
                log({ event: 'HIBERNATE_REQUEST_DISPATCHED', dryRun: res.dryRun === true, ok: res.ok, detail: res.detail ?? null });
                supervisor.markRequestOutcome({ result: res.ok ? 'HIBERNATE_REQUEST_DISPATCHED' : 'HIBERNATE_REQUEST_FAILED' });
                outState = fin.state;
              }
            }
          }
        }
      }
    }
    return { state: outState, activity, userIdleMs };
  }

  function startDaemon({ pollMs = config.pollSec * 1000 } = {}) {
    log({ event: 'SUPERVISOR_STARTED', enabled: config.enabled, allowRealHibernate: config.allowRealHibernate, bootId, pollMs });
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
  const ev = readHibernateEvidence({ stateDir });
  const out = {
    schemaVersion: IDLE_SUPERVISOR_SCHEMA_VERSION,
    enabled: config.enabled,
    allowRealHibernate: config.allowRealHibernate,
    config: {
      dayGraceMs: config.dayGraceMs, nightGraceMs: config.nightGraceMs,
      nightStart: `${String(config.nightStart.h).padStart(2, '0')}:${String(config.nightStart.m).padStart(2, '0')}`,
      nightEnd: `${String(config.nightEnd.h).padStart(2, '0')}:${String(config.nightEnd.m).padStart(2, '0')}`,
      pollSec: config.pollSec,
    },
    stateDir,
    hibernateEvidence: ev.ok ? ev.evidence : { error: ev.reason },
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  return out;
}

const IS_CLI = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('run.mjs');
if (IS_CLI) {
  const args = process.argv.slice(2);
  const cfg = readIdleHibernateConfig(process.env);
  if (!cfg.ok) { console.error(`IDLE_HIBERNATE_SUPERVISOR_CONFIG_INVALID: ${cfg.reason}`); process.exit(2); }
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
  // tick) — it must not claim or leave the hibernate-authority singleton lock.
  if (!config.enabled) {
    createSupervisorRuntime({ config, stateDir, deps, log: (r) => appendLog(stateDir, r) }).startDaemon();
  } else {
    // Machine-GLOBAL singleton: exactly ONE supervisor holds the hibernate
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
