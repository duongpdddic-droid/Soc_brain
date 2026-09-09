#!/usr/bin/env node
// control-ui launcher — one user action to start the Soc_brain Control UI.
// Windows-first, deliberately minimal: no installer, service, autostart or tray.
//
// Contract:
//   - A live UI v2 Control instance answers BOTH GET /api/state?issueNumber=1
//     (200 + { ok:true, schemaVersion:'1' }) AND GET /api/tasks (200) — that
//     pair IS the singleton check. A stale UI v1 server answers /api/state but
//     NOT /api/tasks: it is never reused (stale ports must not be surfaced).
//   - If a live v2 instance is found: do NOT spawn a second server; just
//     surface the URL (and open the browser unless --no-open).
//   - Else: spawn the control-ui.mjs that SHIPS NEXT TO THIS LAUNCHER
//     (`node <repo-root>\packages\control-ui\control-ui.mjs --repo <r> --port
//     <p>`) with cwd PINNED to this repo's checkout root, so the control-plane
//     git ops (origin/main base resolution, worktree provisioning) always run
//     against the canonical checkout — a double-click launch inherits the
//     shell's cwd (Explorer folder / Start-menu System32), which caused the
//     BASE_UNAVAILABLE pilot bug (#900006).
//   - Hard runtime guard before spawn (UI v2 canonical source only): the
//     target file must exist, contain the /api/tasks route, carry the
//     `UI v2` marker and NOT contain the removed `DEMO DATA` fallback.
//     Any mismatch => UI_V2_RUNTIME_NOT_VALID, nothing spawns, no v1 fallback.
//   - Fail-closed: if the checkout root has no .git, refuse to spawn.
//   - Every failure is RETURNED and printed by the CLI tail — never silent.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROBE_PATH = '/api/state?issueNumber=1';
const V2_PROBE_PATH = '/api/tasks';

// UI v2 canonical runtime guard: the file that is about to be spawned must be
// the UI v2 control-ui (canonical /api/tasks route, v2 marker, no demo data).
export function validateV2Runtime({ cliPath, exists = fs.existsSync, read = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  if (!exists(cliPath)) return { ok: false, reason: 'UI_V2_RUNTIME_NOT_VALID', detail: `missing: ${cliPath}` };
  let src = '';
  try { src = read(cliPath); } catch (e) {
    return { ok: false, reason: 'UI_V2_RUNTIME_NOT_VALID', detail: `unreadable: ${String((e && e.message) || e)}` };
  }
  if (!src.includes("'/api/tasks'") && !src.includes('"/api/tasks"')) {
    return { ok: false, reason: 'UI_V2_RUNTIME_NOT_VALID', detail: 'no /api/tasks route (stale UI v1 runtime?)' };
  }
  if (!src.includes('UI v2')) return { ok: false, reason: 'UI_V2_RUNTIME_NOT_VALID', detail: 'missing UI v2 marker' };
  if (src.includes('DEMO DATA')) return { ok: false, reason: 'UI_V2_RUNTIME_NOT_VALID', detail: 'fabricated demo data present' };
  return { ok: true };
}

// Canonical control checkout = the repo this launcher ships inside.
// Throws CONTROL_CWD_INVALID (observable via SPAWN_FAILED) when the root is
// not a git checkout — the control plane must never run from an invalid copy.
export function resolveControlCwd({
  launcherDir = path.dirname(fileURLToPath(import.meta.url)),
  exists = fs.existsSync,
} = {}) {
  const root = path.dirname(path.dirname(launcherDir)); // packages/control-ui -> repo root
  if (!exists(path.join(root, '.git'))) {
    throw new Error(`CONTROL_CWD_INVALID: canonical repo root not found at ${root} (no .git); refusing to start the control plane from an invalid checkout.`);
  }
  return root;
}

export async function probeControlUi({ host = '127.0.0.1', port = 3117, fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl(`http://${host}:${port}${PROBE_PATH}`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const j = await r.json();
    if (!(Boolean(j) && j.ok === true && j.schemaVersion === '1')) return false;
    // v2-only singleton: a stale UI v1 server answers /api/state but has no
    // /api/tasks route — never treat it as a reusable instance.
    const t = await fetchImpl(`http://${host}:${port}${V2_PROBE_PATH}`, { signal: AbortSignal.timeout(1500) });
    return t.ok === true;
  } catch {
    return false;
  }
}

// Detached: the launcher console may close while the server keeps running.
export function defaultCliPath() {
  return fileURLToPath(new URL('./control-ui.mjs', import.meta.url));
}
export function defaultRuntimeGuard({ cliPath = defaultCliPath(), exists = fs.existsSync, read = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  return validateV2Runtime({ cliPath, exists, read });
}
export function defaultSpawnServer({ repo, port, spawnImpl = spawn, exists = fs.existsSync, readFileSync = fs.readFileSync } = {}) {
  const cliPath = defaultCliPath();
  const cwd = resolveControlCwd({ exists }); // checkout validity first (CONTROL_CWD_INVALID)
  const g = validateV2Runtime({ cliPath, exists, read: readFileSync }); // then UI v2 source guard
  if (!g.ok) throw Object.assign(new Error(`${g.reason}: ${g.detail}`), { reason: g.reason });
  const child = spawnImpl(process.execPath, [cliPath, '--repo', repo, '--port', String(port)], {
    cwd, detached: true, stdio: 'ignore', windowsHide: true,
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
  waitMs = 8000,
  pollMs = 300,
  ports = null, // optional fallback list: first FREE port wins when the primary is foreign-occupied
  probe = probeControlUi,
  spawnServer = defaultSpawnServer,
  runtimeGuard = defaultRuntimeGuard, // UI v2 canonical-source guard (injectable for tests)
  openBrowser = null, // null = skip opening (used by --no-open and tests)
} = {}) {
  // Singleton scan: a live Control UI on ANY candidate wins over a new spawn.
  // (The first probe covers the primary port; keep total probes minimal so a
  // spawn failure path stays cheap and observable.)
  const candidates = [port, ...(Array.isArray(ports) ? ports : [])];
  for (const p of candidates) {
    if (await probe({ host, port: p })) {
      const url = `http://${host}:${p}/`;
      if (openBrowser) openBrowser(url);
      return { ok: true, alreadyRunning: true, url };
    }
  }
  // Claim scan: spawn on candidates in order; a port that is busy makes the
  // freshly spawned server crash on bind (exitCode set) -> try the next one.
  // ONE overall deadline bounds the whole startup (never a per-port chain that
  // can exceed the budget).
  const g = await runtimeGuard();
  if (!g.ok) return { ok: false, reason: g.reason || 'UI_V2_RUNTIME_NOT_VALID', detail: g.detail || 'UI v2 runtime guard failed' };
  const deadline = Date.now() + waitMs;
  let lastDetail = `no Control UI answered within ${waitMs}ms`;
  for (const p of candidates) {
    if (Date.now() >= deadline) break;
    let child = null;
    try {
      child = spawnServer({ repo, port: p });
    } catch (e) {
      return { ok: false, reason: 'SPAWN_FAILED', detail: String((e && e.message) || e) };
    }
    const url = `http://${host}:${p}/`;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      if (await probe({ host, port: p })) {
        if (openBrowser) openBrowser(url);
        return { ok: true, alreadyRunning: false, url, spawnedPid: child && child.pid };
      }
      if (child.exitCode != null) break; // server died (e.g. port busy) -> next candidate
    }
    lastDetail = `no Control UI answered on ${host}:${p} within ${waitMs}ms`;
    if (child && child.exitCode == null) break; // out of time while still starting: stop cleanly
  }
  return { ok: false, reason: 'SERVER_NOT_READY', detail: lastDetail };
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
  const r = await runLauncher({
    repo, port, openBrowser: noOpen ? null : defaultOpenBrowser,
    ports: [3118, 3119, 3120], // Issue #132: port-busy fallback chain
  });
  if (r.ok) {
    console.log(`[launcher] ${r.alreadyRunning ? 'already running — opening UI' : `started (pid ${r.spawnedPid})`}: ${r.url}`);
    process.exit(0);
  }
  console.error(`[launcher] FAILED: ${r.reason} — ${r.detail}`);
  if (String(r.reason) === 'UI_V2_RUNTIME_NOT_VALID') process.exit(5);
  process.exit(1);
}
