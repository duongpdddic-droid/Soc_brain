#!/usr/bin/env node
// run.mjs — Session Admission Authority CLI.
//
//   node packages/session-authority/run.mjs daemon   [--pipe <name>] [--json]
//   node packages/session-authority/run.mjs status   [--pipe <name>]
//   node packages/session-authority/run.mjs acquire  --identity-hash <h> --session-path <p> [--lane <id>]
//
// The daemon has an INDEPENDENT lifecycle: it is not owned by the idle
// supervisor (whose hibernate config can stop/restart it), not by the executor
// launcher (whose lifetime is one execution) and not by any worktree. It lives
// for the (user, machine) scope and refuses to start if another daemon already
// owns the canonical endpoint.

import process from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { CODES, authorityPipePath } from './protocol.mjs';
import { createSessionAuthority } from './authority-server.mjs';
import { createAuthorityClient } from './authority-client.mjs';
import { readWin32ProcessStartTime } from '../temp-hygiene/temp-hygiene.mjs';

const USAGE = `session-authority — centralized session admission authority (Named Pipe)

Usage:
  node packages/session-authority/run.mjs daemon  [--pipe <name>] [--quiet]
  node packages/session-authority/run.mjs status  [--pipe <name>]
  node packages/session-authority/run.mjs acquire --identity-hash <32hex> --session-path <path> [--lane <id>]
`;

function parseArgs(argv) {
  const out = { cmd: argv[0] || 'help', pipe: null, quiet: false, json: false, identityHash: null, sessionPath: null, lane: null };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pipe') out.pipe = argv[++i] ?? null;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--json') out.json = true;
    else if (a === '--identity-hash') out.identityHash = argv[++i] ?? null;
    else if (a === '--session-path') out.sessionPath = argv[++i] ?? null;
    else if (a === '--lane') out.lane = argv[++i] ?? null;
    else if (a === '--help' || a === '-h') out.cmd = 'help';
  }
  return out;
}

function ownIncarnation() {
  let start = null;
  try { const r = readWin32ProcessStartTime(process.pid); start = r ? r.processStartTime : null; } catch { start = null; }
  return { pid: process.pid, processStartTime: start };
}

async function cmdDaemon(args) {
  const pipePath = authorityPipePath({ override: args.pipe });
  const authority = createSessionAuthority({
    pipePath,
    bindLockPath: undefined,
    log: args.quiet ? null : (m) => { process.stderr.write(`[session-authority] ${m}\n`); },
  });
  let started;
  try {
    started = await authority.start();
  } catch (e) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: e.code || CODES.BIND_FAILED, detail: String(e.message || e), pipePath })}\n`);
    process.exit(1);
  }
  if (!started.ok) {
    process.stderr.write(`${JSON.stringify(started)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, pipePath, daemonEpoch: authority.daemonEpoch, pid: process.pid })}\n`);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    if (!args.quiet) process.stderr.write(`[session-authority] ${signal} -> draining\n`);
    await authority.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  // Keep the event loop alive without a busy poll.
  const keepAlive = setInterval(() => {}, 1 << 30);
  process.on('exit', () => clearInterval(keepAlive));
}

async function cmdStatus(args) {
  const client = createAuthorityClient({ pipePath: authorityPipePath({ override: args.pipe }) });
  const c = await client.connect();
  if (!c.ok) { process.stdout.write(`${JSON.stringify({ ok: false, code: c.code, detail: c.detail, pipePath: client.pipePath })}\n`); client.close(); process.exit(1); }
  const r = await client.owners();
  client.close();
  if (!r.ok) { process.stdout.write(`${JSON.stringify({ ok: false, code: r.code, detail: r.detail })}\n`); process.exit(1); }
  process.stdout.write(`${JSON.stringify({ ok: true, pipePath: client.pipePath, ...r.value }, null, 2)}\n`);
}

async function cmdAcquire(args) {
  if (!args.identityHash || !args.sessionPath) { process.stderr.write(USAGE); process.exit(2); }
  const client = createAuthorityClient({ pipePath: authorityPipePath({ override: args.pipe }) });
  const c = await client.connect();
  if (!c.ok) { process.stdout.write(`${JSON.stringify({ ok: false, code: c.code, detail: c.detail })}\n`); client.close(); process.exit(1); }
  const owner = ownIncarnation();
  const r = await client.acquire({ identityHash: args.identityHash, sessionPath: args.sessionPath, laneId: args.lane, owner });
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  client.close();
  process.exit(r.ok ? 0 : 1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const run = args.cmd === 'daemon' ? cmdDaemon : args.cmd === 'status' ? cmdStatus : args.cmd === 'acquire' ? cmdAcquire : null;
  if (!run) { process.stdout.write(USAGE); process.exit(args.cmd === 'help' ? 0 : 2); }
  run(args).catch((e) => { process.stderr.write(`${String((e && e.stack) || e)}\n`); process.exit(1); });
}

export { cmdDaemon, cmdStatus, cmdAcquire };
