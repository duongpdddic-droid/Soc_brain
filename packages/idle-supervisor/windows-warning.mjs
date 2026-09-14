#!/usr/bin/env node
// windows-warning.mjs — Issue #177 bounded pre-hibernate warning helper.
//
// Shows a countdown window and returns exactly one decision to the supervisor:
//   'CANCELLED'  the user pressed the button / closed the window (X), or made
//                keyboard/mouse input during the countdown,
//   'TIMEOUT'    the countdown completed with no interruption,
//   'FAILED'     ANY error / helper crash / spawn timeout / ambiguous output.
//
// This helper has ZERO power capability: it never touches powrprof,
// SetSuspendState or powercfg. Showing a dialog cannot authorize a hibernate —
// only the supervisor, after a FRESH post-timeout revalidation, may persist and
// request Hibernate. Every non-clean outcome is normalized to FAILED (fail
// closed) by the caller. It is spawned SYNCHRONOUSLY with a hard wall-clock
// timeout so it can never become an orphan that authorizes power later.

import { spawnSync, spawn } from 'node:child_process';

function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

// Countdown dialog. Uses WinForms (available in Windows PowerShell / PS7+).
// Unicode-safe: executed via -EncodedCommand (UTF-16LE base64) so the Vietnamese
// labels survive argument encoding. Fail-closed: any error path prints FAILED.
function buildWarningScript({ seconds, title, text, cancelLabel }) {
  const sec = Math.max(0, Math.trunc(Number(seconds) || 0));
  return [
    '$ErrorActionPreference="Stop";',
    'try {',
    'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;',
    'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public static class LI{[StructLayout(LayoutKind.Sequential)]public struct L{public uint cb;public uint t;}[DllImport("user32.dll")]public static extern bool GetLastInputInfo(ref L p);[DllImport("kernel32.dll")]public static extern uint GetTickCount();public static uint Idle(){L x=new L();x.cb=(uint)Marshal.SizeOf(typeof(L));GetLastInputInfo(ref x);return (uint)((GetTickCount()-x.t)&0xFFFFFFFF);}}\';',
    `$title=${JSON.stringify(String(title))};`,
    `$text=${JSON.stringify(String(text))};`,
    `$cancel=${JSON.stringify(String(cancelLabel))};`,
    `$secs=${sec};`,
    '$f=New-Object System.Windows.Forms.Form;',
    '$f.Text=$title;$f.FormBorderStyle=[System.Windows.Forms.FormBorderStyle]::FixedDialog;$f.TopMost=$true;',
    '$f.ShowInTaskbar=$true;$f.StartPosition=[System.Windows.Forms.FormStartPosition]::CenterScreen;',
    '$f.Width=440;$f.Height=190;$f.ControlBox=$true;',
    '$lbl=New-Object System.Windows.Forms.Label;$lbl.AutoSize=$false;$lbl.Location="20,18";$lbl.Size="400,60";$lbl.Text=$text;',
    '$cd=New-Object System.Windows.Forms.Label;$cd.Location="20,80";$cd.Size="400,24";',
    '$btn=New-Object System.Windows.Forms.Button;$btn.Text=$cancel;$btn.Location="150,110";$btn.Size="140,34";',
    '$script:cancel=$false;',
    '$btn.Add_Click([System.EventHandler]{ $script:cancel=$true; $f.Close() });',
    '$f.Add_FormClosing([System.Windows.Forms.FormClosingEventHandler]{ $script:cancel=$true });',
    '$f.Controls.Add($lbl);$f.Controls.Add($cd);$f.Controls.Add($btn);',
    '$f.Show();[System.Windows.Forms.Application]::DoEvents();',
    '$idle0=[LI]::Idle();',
    `$deadline=(Get-Date).AddSeconds($secs + 2);`,
    'for($i=$secs;$i -ge 1;$i--){',
    '$f.BringToFront();$cd.Text=[string]$i;[System.Windows.Forms.Application]::DoEvents();',
    'if($script:cancel){ Write-Output "CANCELLED"; exit 0 }',
    'if(-not $f.Visible){ Write-Output "CANCELLED"; exit 0 }',
    'if([LI]::Idle() -lt $idle0){ Write-Output "CANCELLED"; exit 0 }', // keyboard/mouse since open
    'Start-Sleep -Milliseconds 1000;',
    'if((Get-Date) -gt $deadline){ Write-Output "CANCELLED"; exit 0 }', // runaway guard
    '}',
    'if($script:cancel){ Write-Output "CANCELLED"; exit 0 }',
    '$f.Close();',
    'Write-Output "TIMEOUT"; exit 0',
    '} catch { Write-Output "FAILED"; exit 1 }',
  ].join('\n');
}

export function runWindowsHibernateWarning({
  seconds = 60,
  title = 'Soc_brain sắp ngủ đông máy',
  text = 'Máy sẽ ngủ đông sau 60 giây',
  cancelLabel = 'Hủy ngủ đông',
  spawnSyncImpl = spawnSync,
  powershell = 'powershell.exe',
  timeoutMs = null,
} = {}) {
  const script = buildWarningScript({ seconds, title, text, cancelLabel });
  const encoded = encodeCommand(script);
  const guardMs = Number.isInteger(timeoutMs) && timeoutMs > 0
    ? timeoutMs : (Math.max(0, Number(seconds) || 0) * 1000) + 20_000; // bounded: seconds + margin
  let r;
  try {
    r = spawnSyncImpl(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      encoding: 'utf8', timeout: guardMs, windowsHide: false,
    });
  } catch { return 'FAILED'; }
  if (!r || r.error || r.signal || r.status !== 0) return 'FAILED';
  const out = String(r.stdout || '').trim().split('\n').pop().trim();
  if (out === 'TIMEOUT') return 'TIMEOUT';
  if (out === 'CANCELLED') return 'CANCELLED';
  return 'FAILED'; // ambiguous stdout / empty / anything unexpected -> fail closed
}

// Issue #177 rework: NON-BLOCKING warning controller. Production spawns the same
// countdown helper ASYNCHRONOUSLY (so the supervisor keeps polling canonical
// activity during the window) and returns a bounded controller:
//   step({ elapsedMs }) -> 'PENDING' | 'CANCELLED' | 'FAILED' | 'TIMEOUT'
//   terminate(reason)   -> true   (kills the exact spawned child; idempotent)
// TIMEOUT is driven by the supervisor's OWN monotonic clock (never by trusting the
// helper), so a hung helper can only ever yield PENDING-then-JS-timeout, and an
// early helper exit carrying CANCELLED/FAILED (button / X / user input / crash)
// surfaces as that. The helper has NO power capability; terminate leaves no orphan.
export function spawnWindowsHibernateWarning({
  seconds = 60,
  title = 'Soc_brain sắp ngủ đông máy',
  text = 'Máy sẽ ngủ đông sau 60 giây',
  cancelLabel = 'Hủy ngủ đông',
  spawnImpl = spawn,
  powershell = 'powershell.exe',
} = {}) {
  let child;
  try {
    child = spawnImpl(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(buildWarningScript({ seconds, title, text, cancelLabel }))], {
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: false, detached: false,
    });
  } catch { return { step: () => 'FAILED', terminate: () => true, killed: false }; }
  if (!child || typeof child.on !== 'function' || child.pid == null) {
    return { step: () => 'FAILED', terminate: () => true, killed: false };
  }
  const st = { result: null, terminated: false, stdout: '' };
  if (child.stdout && typeof child.stdout.setEncoding === 'function') {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { st.stdout += d; });
  }
  child.on('error', () => { if (st.result == null) st.result = 'FAILED'; });
  child.on('close', () => {
    if (st.result != null) return;
    const out = String(st.stdout || '').trim().split(/\r?\n/).pop().trim();
    if (out === 'CANCELLED' || out === 'FAILED') st.result = out; // an early user/crash signal
    // A helper that simply completed its own countdown is NOT trusted for TIMEOUT:
    // the supervisor clock decides that. An unclean/ambiguous close => FAILED.
    else if (!st.terminated) st.result = out === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
  });
  const terminate = () => {
    if (st.terminated) return true;
    st.terminated = true;
    try { if (typeof child.kill === 'function') child.kill(); } catch { /* best effort; bounded deadline still applies */ }
    return true;
  };
  return {
    pid: child.pid,
    step({ elapsedMs = 0 } = {}) {
      if (st.result === 'CANCELLED' || st.result === 'FAILED') return st.result; // user cancel / crash
      const secs = Math.max(0, Number(seconds) || 0);
      if (elapsedMs >= secs * 1000) { terminate(); return 'TIMEOUT'; } // supervisor-clock authoritative
      return 'PENDING';
    },
    terminate,
    get terminated() { return st.terminated; },
  };
}
