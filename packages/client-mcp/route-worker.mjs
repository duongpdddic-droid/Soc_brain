#!/usr/bin/env node
// route-worker.mjs — DETACHED executor route worker for the client plane (#181).
//
// WHY: production client wiring (client-mcp defaultControl -> lane-bound
// createCanonicalRouteExecutor) called startExecution IN the adapter process,
// which made the executor a stdio CHILD of the MCP transport: killing/restarting
// the adapter (the manual-restart flow this package exists for) could break the
// executor's stdout pipe and lost the launcher's in-process exit-finalization
// monitor. That violates the recovery contract: an MCP transport restart must
// never cancel the executor. This worker makes the canonical launch a transport
// SIBLING: the adapter spawns it DETACHED, the worker calls the SAME
// executor-launcher.startExecution (the sole ExecutionRecord writer — NO second
// lifecycle, NO second launcher), and supervises the child to completion, so
// adapter death touches neither the executor nor the finalization path.
//
// Protocol (all inside the trusted control-plane stateDir namespace):
//   adapter writes  <stateDir>/client-mcp/routes/<identityHash>.<nonce>.json
//   adapter spawns  node route-worker.mjs <requestPath>   (detached, stdio ignore)
//   worker writes   <requestPath>.result.json             ({ok,status,pid,reason})
//
// Fail-closed rules:
//   * a request older than STALE_REQUEST_MS is refused (an orphaned request can
//     never resurrect a launch the caller abandoned);
//   * the ONLY launch path is startExecution — its durable pre-spawn latch +
//     EXECUTION_ALREADY_RUNNING dedup remain the single-execution guards; this
//     worker adds none;
//   * test seam SOC_CLIENT_TEST_EXECUTOR_DEPS (trusted LAUNCH env, set by the
//     operator process that starts client-mcp.mjs; never by a tool caller, never
//     by request-file content) imports a module exporting startExecution's OWN
//     sanctioned DI points (spawn/resolveExecutable/preflight/verifyAuthority/
//     isAlive/clock) so process-backed tests can run the REAL detached-worker
//     flow without the opencode binary while production resolution stays the
//     default when the env is absent.
//
// On worker death before the child exits, the durable latch + #157/#167
// startup-recovery/reaper paths reconcile the record — the same classes any
// control-plane crash already produces. The worker never terminalizes a task.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readSessionRecord } from '../runtime-sandbox/runtime-sandbox.mjs';
import { startExecution } from '../executor-launcher/executor-launcher.mjs';

export const ROUTE_REQUEST_KIND = 'soc-executor-route-request';
export const ROUTE_REQUEST_SCHEMA_VERSION = '1';
export const STALE_REQUEST_MS = 60000;
const DEP_KEYS = Object.freeze(['spawn', 'resolveExecutable', 'preflight', 'verifyAuthority', 'isAlive', 'clock']);

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function writeResult(resultPath, value) {
  try {
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    const tmp = `${resultPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ ...value, at: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, resultPath);
  } catch { /* best effort: the adapter fail-closes on NO_RESULT + latch state */ }
}

export async function runRouteRequest({ requestPath, now = () => Date.now(), start = startExecution, loadDepsModule = null } = {}) {
  const resultPath = `${requestPath}.result.json`;
  const req = readJson(requestPath);
  if (!req || req.kind !== ROUTE_REQUEST_KIND || req.schemaVersion !== ROUTE_REQUEST_SCHEMA_VERSION) {
    writeResult(resultPath, { ok: false, reason: 'ROUTE_REQUEST_INVALID' });
    return { ok: false, reason: 'ROUTE_REQUEST_INVALID' };
  }
  const { sessionPath, stateDir, goal } = req;
  if (typeof sessionPath !== 'string' || !sessionPath || typeof stateDir !== 'string' || !stateDir
    || typeof goal !== 'string' || !goal.trim()) {
    writeResult(resultPath, { ok: false, reason: 'ROUTE_REQUEST_INCOMPLETE' });
    return { ok: false, reason: 'ROUTE_REQUEST_INCOMPLETE' };
  }
  const requestedAtMs = Date.parse(req.requestedAt || '');
  if (!Number.isFinite(requestedAtMs) || now() - requestedAtMs > STALE_REQUEST_MS) {
    writeResult(resultPath, { ok: false, reason: 'ROUTE_REQUEST_STALE' });
    return { ok: false, reason: 'ROUTE_REQUEST_STALE' };
  }
  const rs = readSessionRecord(sessionPath);
  if (!rs.ok || !rs.session) {
    writeResult(resultPath, { ok: false, reason: 'ROUTE_SESSION_UNREADABLE' });
    return { ok: false, reason: 'ROUTE_SESSION_UNREADABLE' };
  }
  const session = rs.session;
  const cp = session.controlPlane || {};
  if (!cp.bindingPath) {
    writeResult(resultPath, { ok: false, reason: 'ROUTE_BINDING_UNAVAILABLE' });
    return { ok: false, reason: 'ROUTE_BINDING_UNAVAILABLE' };
  }
  const binding = readJson(cp.bindingPath);
  if (!binding || !binding.path || !binding.identityHash || !binding.taskId || !binding.repo) {
    writeResult(resultPath, { ok: false, reason: 'ROUTE_BINDING_UNAVAILABLE' });
    return { ok: false, reason: 'ROUTE_BINDING_UNAVAILABLE' };
  }
  // Sanctioned DI passthrough (test seam only — see header). Function shapes
  // ONLY; the module path comes from the worker's trusted launch environment.
  const inject = {};
  const modulePath = typeof loadDepsModule === 'string' ? loadDepsModule : null;
  if (modulePath) {
    let mod = null;
    try { mod = await import(pathToFileURL(path.resolve(modulePath)).href); } catch { mod = null; }
    if (!mod) {
      writeResult(resultPath, { ok: false, reason: 'ROUTE_DEPS_MODULE_UNLOADABLE' });
      return { ok: false, reason: 'ROUTE_DEPS_MODULE_UNLOADABLE' };
    }
    for (const k of DEP_KEYS) if (typeof mod[k] === 'function') inject[k] = mod[k];
  }
  const launchSession = { ...session, leaseToken: (session.lease && session.lease.token) || null };
  let r = null;
  try {
    r = start({ sessionPath, session: launchSession, binding, instruction: goal, model: null, stateDir, ...inject });
  } catch (e) {
    writeResult(resultPath, { ok: false, reason: 'ROUTE_LAUNCH_THREW', detail: String((e && e.message) || e) });
    return { ok: false, reason: 'ROUTE_LAUNCH_THREW' };
  }
  if (!r) {
    writeResult(resultPath, { ok: false, reason: 'ROUTE_NO_HANDLE' });
    return { ok: false, reason: 'ROUTE_NO_HANDLE' };
  }
  if (r.ok !== true) {
    writeResult(resultPath, { ok: false, reason: r.reason || 'LAUNCH_FAILED', status: r.status || r.reason || 'LAUNCH_FAILED', pid: r.pid ?? null, detail: r.detail ?? null });
    return { ok: false, reason: r.reason || 'LAUNCH_FAILED' };
  }
  writeResult(resultPath, { ok: true, status: r.status || 'RUNNING', pid: r.pid ?? null, recordPath: r.recordPath ?? null, workerPid: process.pid });
  // SUPERVISE: stay alive until the canonical child exits so startExecution's
  // exit-finalization handlers run in-process (the #167 reliability contract).
  await new Promise((resolve) => {
    if (!r.child || typeof r.child.on !== 'function') return resolve();
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    r.child.on('exit', done);
    r.child.on('error', done);
    if (r.child.exitCode != null || r.child.signalCode != null) done();
  });
  return { ok: true, pid: r.pid ?? null };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) {
  const requestPath = process.argv[2];
  if (!requestPath) { process.stderr.write('usage: node route-worker.mjs <requestPath>\n'); process.exit(2); }
  runRouteRequest({ requestPath, loadDepsModule: process.env.SOC_CLIENT_TEST_EXECUTOR_DEPS || null })
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((e) => {
      // A detached stdio-ignore worker must never die silently: persist the
      // failure into the result channel so the adapter fail-closes with a REASON.
      try {
        fs.mkdirSync(path.dirname(requestPath), { recursive: true });
        fs.writeFileSync(`${requestPath}.result.json`, `${JSON.stringify({ ok: false, reason: 'ROUTE_WORKER_THREW', detail: String((e && e.message) || e), at: new Date().toISOString() }, null, 2)}\n`, 'utf8');
      } catch { /* nothing left to do */ }
      process.exit(1);
    });
}
