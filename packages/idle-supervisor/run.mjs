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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IDLE_SUPERVISOR_SCHEMA_VERSION, readIdleSleepConfig, createIdleSupervisor,
  scanCanonicalActivity, idleSupervisorDirFor, readSleepEvidence,
} from './idle-supervisor.mjs';

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

export function spawnIdleSupervisor({ repoRoot, env = process.env, spawnImpl = spawn } = {}) {
  if (env.SOC_IDLE_SLEEP !== '1') return null; // explicit enable only
  const entry = path.join(repoRoot, 'packages', 'idle-supervisor', 'run.mjs');
  if (!fs.existsSync(entry)) return null;
  const child = spawnImpl(process.execPath, [entry, '--daemon'], {
    cwd: repoRoot, detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...env, SOC_IDLE_SUPERVISOR_SPAWNED: '1' },
  });
  child.unref();
  return child;
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
  clock = Date.now,
} = {}) {
  const supervisor = createIdleSupervisor({ config, stateDir, clock });
  let lastTickAt = null;
  let bootId = deps.readBootId ? deps.readBootId() : null;
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
  const rt = createSupervisorRuntime({
    config, stateDir, deps,
    log: (r) => appendLog(stateDir, r),
  });
  rt.startDaemon();
}
