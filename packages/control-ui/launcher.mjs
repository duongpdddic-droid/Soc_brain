#!/usr/bin/env node
// control-ui launcher v0 — one user action to start the Soc_brain Control UI.
// Windows-first, deliberately minimal: no installer, service, autostart or tray.
//
// Contract:
//   - A live Control UI answers GET /api/state?issueNumber=1 on loopback with
//     200 + { ok: true, schemaVersion: '1' } — that probe IS the singleton
//     check (any other app on the port does not answer with that shape).
//   - If alive: do NOT spawn a second server; just surface the URL (and open
//     the browser unless --no-open).
//   - Else: spawn the existing CLI detached (`node control-ui.mjs --repo <r>
//     --port <p>`) so the E2E path stays byte-for-byte unchanged, then poll
//     until ready or timeout.
//   - Every failure is RETURNED and printed by the CLI tail — never silent.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROBE_PATH = '/api/state?issueNumber=1';

export async function probeControlUi({ host = '127.0.0.1', port = 3117, fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl(`http://${host}:${port}${PROBE_PATH}`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const j = await r.json();
    return Boolean(j) && j.ok === true && j.schemaVersion === '1';
  } catch {
    return false;
  }
}

// Detached: the launcher console may close while the server keeps running.
export function defaultSpawnServer({ repo, port }) {
  const cliPath = fileURLToPath(new URL('./control-ui.mjs', import.meta.url));
  const child = spawn(process.execPath, [cliPath, '--repo', repo, '--port', String(port)], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  return child;
}

export function defaultOpenBrowser(url) {
  const child = spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child;
}

export async function runLauncher({
  repo,
  port = 3117,
  host = '127.0.0.1',
  waitMs = 15000,
  pollMs = 300,
  probe = probeControlUi,
  spawnServer = defaultSpawnServer,
  openBrowser = null, // null = skip opening (used by --no-open and tests)
} = {}) {
  const url = `http://${host}:${port}/`;
  // Singleton: a live instance wins over a new spawn, always.
  if (await probe({ host, port })) {
    if (openBrowser) openBrowser(url);
    return { ok: true, alreadyRunning: true, url };
  }
  let child = null;
  try {
    child = spawnServer({ repo, port });
  } catch (e) {
    return { ok: false, reason: 'SPAWN_FAILED', detail: String((e && e.message) || e) };
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (await probe({ host, port })) {
      if (openBrowser) openBrowser(url);
      return { ok: true, alreadyRunning: false, url, spawnedPid: child && child.pid };
    }
    if (child && child.exitCode != null) break; // server died before becoming ready
  }
  return { ok: false, reason: 'SERVER_NOT_READY', detail: `no Control UI answered on ${host}:${port} within ${waitMs}ms` };
}

// ---- CLI entry: node launcher.mjs --repo owner/name [--port 3117] [--no-open] --
const CLI_ENTRY = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('launcher.mjs');
if (CLI_ENTRY) {
  const args = process.argv.slice(2);
  const argOf = (name, dflt) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
  };
  const repo = argOf('--repo', null);
  const port = Number(argOf('--port', '3117'));
  const noOpen = args.includes('--no-open');
  if (!repo) { console.error('usage: node launcher.mjs --repo owner/name [--port 3117] [--no-open]'); process.exit(2); }
  const r = await runLauncher({ repo, port, openBrowser: noOpen ? null : defaultOpenBrowser });
  if (r.ok) {
    console.log(`[launcher] ${r.alreadyRunning ? 'already running — opening UI' : `started (pid ${r.spawnedPid})`}: ${r.url}`);
    process.exit(0);
  }
  console.error(`[launcher] FAILED: ${r.reason} — ${r.detail}`);
  process.exit(1);
}
