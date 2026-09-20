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
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readSessionRecord } from '../runtime-sandbox/runtime-sandbox.mjs';
import {
  readExecutionRecord,
  startExecution,
} from '../executor-launcher/executor-launcher.mjs';
import { resumeFinalizedExecution } from '../executor-launcher/executor-recovery.mjs';
import { evaluateExecutionBudget, terminateAndProveCleanup } from '../executor-launcher/executor-reconcile.mjs';
import { readWin32ProcessStartTime } from '../temp-hygiene/temp-hygiene.mjs';

export const ROUTE_REQUEST_KIND = 'soc-executor-route-request';
export const ROUTE_REQUEST_SCHEMA_VERSION = '1';
export const STALE_REQUEST_MS = 60000;
export const EXECUTION_BREAKER_LIMITS = Object.freeze({ hardTimeMs: 600000, maxSteps: 10, noMutationMs: 600000 });
export const EXECUTION_BREAKER_POLL_MS = 500;
const DEP_KEYS = Object.freeze(['spawn', 'resolveExecutable', 'preflight', 'verifyAuthority', 'isAlive', 'clock']);

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function defaultSleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* non-blocking env */ }
}

// Bounded step count from existing executor activity NDJSON: counts only the
// canonical step boundary (`step_start`). Reads at most the file tail (never
// rereads an unbounded file). Returns null when unknown (fail-closed CONTINUE).
const BREAKER_ACTIVITY_TAIL_BYTES = 262144;
export function defaultCountSteps(eventsPath) {
  if (typeof eventsPath !== 'string' || !eventsPath) return null;
  let size = 0;
  try { size = fs.statSync(eventsPath).size; } catch { return 0; }
  const len = Math.min(size, BREAKER_ACTIVITY_TAIL_BYTES);
  if (len <= 0) return 0;
  let raw = '';
  try {
    const fd = fs.openSync(eventsPath, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, Math.max(0, size - len));
      raw = buf.toString('utf8');
    } finally { try { fs.closeSync(fd); } catch { /* ignore */ } }
  } catch { return null; }
  let n = 0;
  for (const line of raw.split('\n')) {
    if (!line.includes('step_start')) continue;
    try {
      const o = JSON.parse(line);
      const ev = (o && typeof o.event === 'object' && o.event) || o;
      if (o && (o.kind === 'step_start' || o.type === 'step_start' || ev.type === 'step_start')) n += 1;
    } catch { /* non-JSON tail fragment: ignore */ }
  }
  return n;
}

// Worktree mutation fingerprint scoped to binding.path (task worktree ONLY, so
// control-plane/execution telemetry outside it is ignored by construction).
// Detects tracked modifications AND untracked files. Null when unknown.
export function defaultReadFingerprint(worktreePath) {
  if (typeof worktreePath !== 'string' || !worktreePath) return null;
  try {
    const r = nodeSpawnSync('git', ['status', '--porcelain=v1', '--untracked-files=normal'],
      { cwd: worktreePath, timeout: 15000, windowsHide: true, encoding: 'utf8' });
    if (r.error || r.status !== 0) return null;
    return String(r.stdout || '');
  } catch { return null; }
}

function proveExecutorIdentity({ pid, startTime, isAlive, readStartTime }) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { if (!isAlive(pid)) return false; } catch { return false; }
  if (startTime == null) return false;
  let probe = null;
  try { probe = readStartTime(pid); } catch { return false; }
  if (!probe || probe.processStartTime == null) return false;
  return probe.processStartTime === startTime;
}

// Bounded runtime watchdog: supervises the exact child until it exits/errors
// or evaluateExecutionBudget() returns TRIP. On TRIP terminates ONLY the exact
// incarnation via terminateAndProveCleanup (never from PID alone); with an
// unproven identity it reports the breaker condition WITHOUT killing.
export async function superviseExecution(
  { child = null, pid = null, recordPath = null, eventsPath = null, worktreePath = null, startedAt = null } = {},
  { now = () => Date.now(), sleep = (ms) => new Promise((res) => setTimeout(res, ms)), pollMs = EXECUTION_BREAKER_POLL_MS,
    limits = EXECUTION_BREAKER_LIMITS, countSteps = null, readFingerprint = null,
    isAlive = defaultIsAlive, readStartTime = readWin32ProcessStartTime,
    kill = (p) => { process.kill(p); }, sleepSync = defaultSleepSync,
    terminate = terminateAndProveCleanup, getStartTime = null, maxPolls = Infinity } = {},
) {
  if (!child || typeof child.on !== 'function') return { tripped: false, reason: 'NO_CHILD' };
  let exited = false;
  const done = () => { exited = true; };
  child.on('exit', done);
  child.on('error', done);
  if (child.exitCode != null || child.signalCode != null) exited = true;
  let startTime = null;
  if (typeof getStartTime === 'function') { try { const v = getStartTime(); if (v != null) startTime = v; } catch { /* unproven */ } }
  if (startTime == null && recordPath) {
    try {
      const rec = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      if (rec && rec.processStartTime != null) startTime = rec.processStartTime;
    } catch { /* unproven: fail closed, never kill */ }
  }
  const countFn = typeof countSteps === 'function' ? countSteps : () => defaultCountSteps(eventsPath);
  const fpFn = typeof readFingerprint === 'function' ? readFingerprint : () => defaultReadFingerprint(worktreePath);
  const t0 = Number.isFinite(startedAt) ? startedAt : now();
  let baseline = null;
  try { baseline = fpFn(); } catch { baseline = null; }
  let lastMutationAt = t0;
  let polls = 0;
  for (;;) {
    if (exited) return { tripped: false, reason: 'CHILD_EXITED', pid };
    const t = now();
    const elapsedMs = t - t0;
    let stepCount = null;
    try { stepCount = countFn(); } catch { stepCount = null; }
    let fp = null;
    try { fp = fpFn(); } catch { fp = null; }
    const fingerprintChanged = fp !== baseline;
    if (fingerprintChanged) {
      lastMutationAt = t;
      baseline = fp;
    }
    const msSinceLastMutation = t - (lastMutationAt ?? startedAt);
    const hasMutation = fingerprintChanged;
    const identityProven = proveExecutorIdentity({ pid, startTime, isAlive, readStartTime });
    const d = evaluateExecutionBudget(
      { elapsedMs, stepCount, msSinceLastMutation, hasMutation, identityProven }, limits);
    if (d.action === 'TRIP') {
      let cleanup = { provenGone: false, action: 'IDENTITY_UNPROVEN_SKIP', cleanupRequired: true, foreign: false };
      if (identityProven === true) {
        try {
          cleanup = terminate({ pid, startTime, isAlive, readStartTime, kill, sleep: sleepSync });
        } catch (e) {
          cleanup = { provenGone: false, action: 'TERMINATE_THREW', cleanupRequired: true, detail: String((e && e.message) || e) };
        }
      }
      return {
        tripped: true, breakerReason: d.breakerReason, executionOutcome: d.executionOutcome,
        reason: d.reason, identityProven, pid, cleanup,
      };
    }
    if (fp !== null && baseline !== null && fp !== baseline) { lastMutationAt = t; baseline = fp; }
    else if (fp !== null && baseline === null) { baseline = fp; }
    polls += 1;
    if (polls >= maxPolls) return { tripped: false, reason: 'POLL_BUDGET', pid };
    await sleep(pollMs);
  }
}

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

const prior = readExecutionRecord({
  stateDir,
  repo: binding.repo,
  issueNumber: binding.issueNumber,
});

const shouldResume = (
  prior?.ok === true &&
  prior.record?.identityHash === session.identityHash &&
  prior.record.finalized === true &&
  !!prior.record.terminalStatus
);

let r = null;
try {
  if (shouldResume) {
    r = resumeFinalizedExecution({
      stateDir,
      identityHash: binding.identityHash,
      repo: binding.repo,
      instruction: goal,
      model: null,
      isAlive: typeof inject.isAlive === 'function'
        ? inject.isAlive
        : defaultIsAlive,
      readStartTime: readWin32ProcessStartTime,
      start: (args) => start({
        ...args,
        ...inject,
      }),
    });
  } else {
    r = start({
      sessionPath,
      session: launchSession,
      binding,
      instruction: goal,
      model: null,
      stateDir,
      ...inject,
    });
  }
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
  // exit-finalization handlers run in-process (the #167 reliability contract),
  // bounded by the Mechanical Circuit Breaker & Overthinking Breaker policy.
  const sup = await superviseExecution(
    { child: r.child ?? null, pid: r.pid ?? null, recordPath: r.recordPath ?? null,
      eventsPath: r.eventsPath ?? null, worktreePath: binding.path, startedAt: r.startedAt ?? now() },
    {
      now: typeof inject.clock === 'function' ? inject.clock : now,
      isAlive: typeof inject.isAlive === 'function' ? inject.isAlive : defaultIsAlive,
      readStartTime: readWin32ProcessStartTime,
      getStartTime: (() => { try {
        const rec = r.recordPath ? readJson(r.recordPath) : null;
        return rec && rec.processStartTime != null ? rec.processStartTime : null;
      } catch { return null; } }),
    },
  );
  if (sup && sup.tripped === true) {
    // Persist/report breakerReason + executionOutcome through the existing
    // result channel (minimum extension; Issue #192 vocabulary unchanged).
    writeResult(resultPath, {
      ok: false, reason: 'EXECUTOR_BREAKER_TRIPPED', status: 'BREAKER_TRIPPED',
      pid: r.pid ?? null, breakerReason: sup.breakerReason ?? null,
      executionOutcome: sup.executionOutcome ?? null,
      cleanup: sup.cleanup ?? null, identityProven: sup.identityProven ?? false,
    });
    return { ok: false, reason: 'EXECUTOR_BREAKER_TRIPPED', breakerReason: sup.breakerReason ?? null, executionOutcome: sup.executionOutcome ?? null, pid: r.pid ?? null, cleanup: sup.cleanup ?? null };
  }
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
