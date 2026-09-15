// supervisor.mjs — AUTO MCP recovery supervisor core (transport-only authority).
//
// NORTH STAR: the client-mcp adapter is a REPLACEABLE TRANSPORT PROCESS. When
// it dies, a surviving supervisor must re-establish ONLY the transport and
// reattach READ-ONLY to the SAME canonical task/session/execution. A transport
// restart is never a task restart, executor restart, new execution, mutation-
// owner transfer, Human-Gate answer, merge authorization, or terminalization.
//
// WHY THE SUPERVISOR DOES NOT SPAWN THE ADAPTER ITSELF (proven, #183 audit):
// the stdio pipes are owned by the MCP CLIENT (OpenCode). Source
// (sst/opencode v1.18.27 packages/opencode/src/mcp/index.ts): `client.onclose`
// only marks `{status:"failed", error:"Connection closed"}` — there is NO
// automatic respawn — but `POST /mcp/:name/connect` re-runs `connectLocal()`,
// which spawns a FRESH StdioClientTransport child under the SAME running
// OpenCode process (runtime-proven: killed adapter pid 7996 -> connect -> new
// adapter pid 11104 without restarting OpenCode). The connect call performs the
// initialize + tools/list handshake before reporting `connected`, so the
// supervisor's HEALTHCHECK consumes the client's own native handshake. Reusing
// it means the adapter never gains a second, competing spawner — the pipe
// owner stays the sole process parent, and no stable-proxy layer is required.
//
// AUTHORITY BOUNDARY (hard):
//   owns    : transport observation (GET /mcp), native rebind trigger (POST
//             /mcp/:name/connect), bounded backoff, read-only reattach
//             VERIFICATION (transport.json reads), transport observability
//             (<stateDir>/client-mcp/supervisor.json + supervisor.lock).
//   never   : task FSM, session lifecycle, ExecutionRecord, executor
//             lifecycle, mutation ownership, Human-Gate decisions, review
//             verdicts, merge authorization, delivery, goal submission.
//   guards  : single supervisor via a fenced lock (R11/R12); bounded retry
//             with exponential backoff + attempt cap (no crash loop, R4/R10);
//             recovery success requires the SAME pinned identity (R13);
//             UNKNOWN execution liveness fails closed (no synthetic RUNNING);
//             GONE is reported truthfully and canonical reconcile owns the
//             lifecycle decision (R7/A12).
//
// ponytail: recoveryAttemptCount resets when a new supervisor PROCESS boots —
// per-outage budgeting lives in this process; a durable cross-boot budget would
// need a store this module must not own (observability is non-authoritative).
// Upgrade path if operator launches must survive repeated supervisor restarts:
// persist the attempt counter inside the lock record.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { transportStatePathFor } from './recovery.mjs';
import { isAlive, readWin32ProcessStartTime } from '../temp-hygiene/temp-hygiene.mjs';

export const SUPERVISOR_SCHEMA_VERSION = '1';
export const DEFAULT_SERVER_NAME = 'soc-brain-client';
export const DEFAULT_POLICY = Object.freeze({
  pollMs: 5000,
  backoffBaseMs: 1000,
  backoffCapMs: 30000,
  maxAttempts: 5,
  healthTimeoutMs: 15000,
  reattachTimeoutMs: 20000,
  httpTimeoutMs: 10000,
});

export function supervisorStatePathFor({ stateDir }) {
  return path.join(path.resolve(stateDir), 'client-mcp', 'supervisor.json');
}
export function supervisorLockPathFor({ stateDir }) {
  return path.join(path.resolve(stateDir), 'client-mcp', 'supervisor.lock');
}

function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  try { fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8'); fs.renameSync(tmp, p); return true; }
  catch { try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ } return false; }
}

// ---- single-owner lock (fenced) -----------------------------------------------
// One supervisor at a time per stateDir. A holder is authoritative only while
// its OS process identity (pid + immutable start time on win32) proves alive —
// a dead or pid-reused holder may be replaced, and a STALE instance that lost
// the fence can never seize the transport or write observability (R11/R12).
function holderAlive(holder, { alive = isAlive, readStartTime = readWin32ProcessStartTime, platform = process.platform } = {}) {
  if (!holder || !Number.isInteger(holder.pid) || holder.pid <= 0) return false;
  if (!alive(holder.pid)) return false;
  if (platform === 'win32') {
    const probe = readStartTime(holder.pid);
    if (!probe || !Number.isFinite(holder.startTime) || probe.processStartTime !== holder.startTime) return false;
  }
  return true;
}

export function acquireSupervisorLock({ stateDir, bootId, pid = process.pid, selfStartTime = null, now = () => Date.now(), holderOpts = {} } = {}) {
  const p = supervisorLockPathFor({ stateDir });
  const cur = readJsonSafe(p);
  if (cur && cur.bootId === bootId) return { ok: true, acquired: false, holder: cur };
  if (cur && holderAlive(cur, holderOpts)) return { ok: false, reason: 'SUPERVISOR_ALREADY_RUNNING', holder: { pid: cur.pid, bootId: cur.bootId } };
  const startTime = selfStartTime != null ? selfStartTime : (process.platform === 'win32' ? (readWin32ProcessStartTime(pid) || {}).processStartTime ?? null : null);
  const rec = { schemaVersion: SUPERVISOR_SCHEMA_VERSION, bootId, pid, startTime, acquiredAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString() };
  return { ok: writeAtomic(p, rec), acquired: true, holder: rec };
}

export function verifySupervisorLock({ stateDir, bootId, now = () => Date.now() } = {}) {
  const cur = readJsonSafe(supervisorLockPathFor({ stateDir }));
  if (!cur || cur.bootId !== bootId) return { ok: false, reason: 'SUPERVISOR_LOCK_LOST', holder: cur ? { pid: cur.pid, bootId: cur.bootId } : null };
  cur.updatedAt = new Date(now()).toISOString();
  writeAtomic(supervisorLockPathFor({ stateDir }), cur);
  return { ok: true };
}

export function releaseSupervisorLock({ stateDir, bootId } = {}) {
  const p = supervisorLockPathFor({ stateDir });
  const cur = readJsonSafe(p);
  if (cur && cur.bootId === bootId) { try { fs.rmSync(p, { force: true }); } catch { /* best effort */ } return { ok: true, released: true }; }
  return { ok: true, released: false };
}

// ---- identity pinning + comparison (read-only over transport.json) ------------
function identityFromTransport(t) {
  if (!t || !t.currentTaskIdentity || !t.currentTaskIdentity.identityHash) return null;
  const c = t.currentTaskIdentity;
  return {
    repo: c.repo ?? null, issueNumber: c.issueNumber ?? null, identityHash: c.identityHash ?? null, taskId: c.taskId ?? null,
    mutationOwner: t.mutationOwner ?? null,
    executionPid: t.executionPid ?? null,
    executionProcessStartTime: t.executionProcessStartTime ?? null,
    humanGateAt: t.humanGateAt ?? null,
  };
}

// Returns null when SAME, else the first violated field. ANY expected half must
// match exactly; an expected execution that vanished (pid null) is a mismatch —
// recovery must never present a different canonical attempt as the same one.
function identityMismatch(expected, current) {
  if (!current) return 'MISSING';
  if (expected.repo !== current.repo) return 'repo';
  if (expected.issueNumber !== current.issueNumber) return 'issueNumber';
  if (expected.identityHash !== current.identityHash) return 'identityHash';
  if (expected.taskId !== current.taskId) return 'taskId';
  if (expected.mutationOwner !== current.mutationOwner) return 'mutationOwner';
  if (expected.humanGateAt != null && current.humanGateAt != null && expected.humanGateAt !== current.humanGateAt) return 'humanGateAt';
  if (expected.executionPid != null) {
    if (current.executionPid !== expected.executionPid) return 'executionPid';
    if (expected.executionProcessStartTime != null && current.executionProcessStartTime !== expected.executionProcessStartTime) return 'executionProcessStartTime';
  }
  return null;
}

// ---- the supervisor ----------------------------------------------------------------
export function createMcpSupervisor({
  serverName = DEFAULT_SERVER_NAME, controlUrl, stateDir, fetchImpl = null,
  policy = {}, password = null, username = 'opencode', bootId = null,
  now = () => Date.now(), log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  holderOpts = {},
} = {}) {
  if (!stateDir) throw new Error('supervisor: stateDir is required');
  if (!controlUrl || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(controlUrl))) {
    throw new Error('supervisor: controlUrl must be an http(s) LOOPBACK URL (local transport only)');
  }
  const pol = { ...DEFAULT_POLICY, ...policy };
  const id = bootId || `sup-${process.pid}-${now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const startedAt = new Date(now()).toISOString();
  const headers = { accept: 'application/json' };
  if (password) headers.authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
  const doFetch = fetchImpl || ((url, opts) => globalThis.fetch(url, opts));

  // FSM state (transport-only vocabulary; see recovery.mjs TRANSPORT_STATES).
  const st = {
    phase: 'CONNECTED', attempt: 0, nextAttemptAt: 0, deadline: 0,
    expected: null, lastBootId: null, outageAt: null,
    lastRecoveryAttemptAt: null, lastResult: null,
  };

  async function http(method, route) {
    const url = `${String(controlUrl).replace(/\/+$/, '')}${route}`;
    try {
      const signal = globalThis.AbortSignal && AbortSignal.timeout ? AbortSignal.timeout(pol.httpTimeoutMs) : undefined;
      const res = await doFetch(url, { method, headers, signal });
      const text = await res.text();
      let body = null; try { body = JSON.parse(text); } catch { /* non-JSON */ }
      if (!res.ok) return { ok: false, status: res.status, body, text };
      return { ok: true, status: res.status, body };
    } catch (e) { return { ok: false, status: 0, reason: 'CONTROL_UNREACHABLE', text: String((e && e.message) || e) }; }
  }

  const transport = () => readJsonSafe(transportStatePathFor({ stateDir }));

  function captureExpectedOnOutage() {
    if (st.outageAt) return;
    st.outageAt = new Date(now()).toISOString();
    const t = transport();
    st.expected = identityFromTransport(t);
    st.lastBootId = (t && t.lastBootId) || null;
    st.attempt = 0;
  }

  function backoffMs() { return Math.min(pol.backoffCapMs, pol.backoffBaseMs * (2 ** Math.max(0, st.attempt - 1))); }

  function scheduleNext(reason, detail = null) {
    st.lastResult = { ok: false, reason, detail, at: new Date(now()).toISOString() };
    if (st.attempt >= pol.maxAttempts) { st.phase = 'RECOVERY_FAILED'; return persist(); }
    st.phase = 'RECOVERY_SCHEDULED';
    st.nextAttemptAt = now() + backoffMs();
    return persist();
  }

  // The ONE automatic recovery action: ask the pipe owner (OpenCode-native) to
  // spawn + handshake a fresh adapter. Idempotent-safe: createAndStore closes
  // any previous client; the supervisor never touches any other process.
  async function attemptRebind() {
    st.attempt += 1;
    st.lastRecoveryAttemptAt = new Date(now()).toISOString();
    st.phase = 'RESTARTING';
    persist();
    const res = await http('POST', `/mcp/${encodeURIComponent(serverName)}/connect`);
    if (!res.ok) return scheduleNext('REBIND_FAILED', `http ${res.status}`);
    st.phase = 'HEALTHCHECK';
    st.deadline = now() + pol.healthTimeoutMs;
    persist();
    for (;;) {
      const p = await http('GET', '/mcp');
      const s = p.ok && p.body ? p.body[serverName] : null;
      if (s && s.status === 'connected') break;
      if (now() >= st.deadline) return scheduleNext('HEALTHCHECK_TIMEOUT', s ? (s.error || s.status) : 'control unreachable');
      await sleep(Math.min(250, pol.pollMs));
    }
    st.phase = 'REATTACHING';
    st.deadline = now() + pol.reattachTimeoutMs;
    persist();
    return runCycle();
  }

  function verifyReattach() {
    const t = transport();
    const boot = t && t.lastBootId || null;
    if (!t || !boot || (st.outageAt && boot === st.lastBootId)) return { pending: true };
    if (t.transportState === 'RESTARTING' || t.transportState === 'DISCONNECTED') return { pending: true };
    if (t.transportState === 'RECOVERED') {
      const cur = identityFromTransport(t);
      if (st.expected) {
        const bad = identityMismatch(st.expected, cur);
        if (bad) return { ok: false, reason: 'RECOVERY_IDENTITY_MISMATCH', detail: bad };
      }
      // Phase-6 is absolute: an unprovable execution identity is NEVER accepted
      // as recovered (no synthetic RUNNING), pinned baseline or not.
      if (t.executionLiveness === 'UNKNOWN') return { ok: false, reason: 'EXECUTION_IDENTITY_UNKNOWN', detail: 'fail closed: execution identity not provable' };
      return { ok: true, current: cur, bootId: boot };
    }
    if (t.transportState === 'RECOVERY_FAILED') {
      const reason = t.lastRecoveryReason || 'UNKNOWN';
      if (!st.expected && reason === 'NO_ACTIVE_TASK') return { ok: true, current: null, bootId: boot, idle: true };
      return { ok: false, reason: 'ADAPTER_RECOVERY_FAILED', detail: reason };
    }
    return { pending: true };
  }

  function settleVerified(v) {
    st.lastBootId = v.bootId;
    st.outageAt = null;
    st.attempt = 0;
    st.expected = v.current || null;
    st.phase = v.current ? 'RECOVERED' : 'CONNECTED';
    st.lastResult = { ok: true, reason: v.idle ? 'CONNECTED_NO_TASK' : 'RECOVERED_SAME_ATTEMPT', detail: null, at: new Date(now()).toISOString() };
    persist();
  }

  async function onConnected() {
    const t = transport();
    const boot = t && t.lastBootId || null;
    if (!st.outageAt && (st.phase === 'CONNECTED' || st.phase === 'RECOVERED') && boot && boot === st.lastBootId) { persist(); return { action: 'steady' }; }
    if (!st.outageAt) { // first sight of a live transport (or external restart)
      st.expected = identityFromTransport(t);
      st.lastBootId = boot;
    }
    const v = verifyReattach();
    if (v.pending) {
      if (!st.outageAt) { st.phase = 'REATTACHING'; st.deadline = now() + pol.reattachTimeoutMs; persist(); return { action: 'await-boot' }; }
      if (now() >= st.deadline) return scheduleNext('NO_ADAPTER_BOOT', 'fresh adapter produced no reattach record');
      st.phase = 'REATTACHING'; persist(); return { action: 'await-boot' };
    }
    if (!v.ok) {
      if (st.attempt < pol.maxAttempts) { st.attempt += 1; return scheduleNext(v.reason, v.detail); }
      st.lastResult = { ok: false, reason: v.reason, detail: v.detail, at: new Date(now()).toISOString() };
      st.phase = 'RECOVERY_FAILED'; persist(); return { action: 'failed' };
    }
    settleVerified(v);
    return { action: 'recovered' };
  }

  async function onFailed(error) {
    captureExpectedOnOutage();
    if (st.attempt >= pol.maxAttempts) { st.phase = 'RECOVERY_FAILED'; st.lastResult = { ok: false, reason: 'ATTEMPTS_EXHAUSTED', detail: error || null, at: new Date(now()).toISOString() }; persist(); return { action: 'exhausted' }; }
    if (st.phase === 'RECOVERY_SCHEDULED' && now() < st.nextAttemptAt) { persist(); return { action: 'backoff' }; }
    return attemptRebind();
  }

  async function runCycle() {
    const lock = verifySupervisorLock({ stateDir, bootId: id, now });
    if (!lock.ok) return { action: 'stopped', reason: lock.reason };
    const p = await http('GET', '/mcp');
    if (!p.ok) {
      captureExpectedOnOutage();
      st.phase = 'DISCONNECTED';
      st.lastResult = { ok: false, reason: 'CONTROL_UNREACHABLE', detail: p.text || null, at: new Date(now()).toISOString() };
      persist();
      return { action: 'unreachable' };
    }
    const s = p.body ? p.body[serverName] : null;
    if (!s) return onFailed(`server "${serverName}" not present in /mcp status`);
    if (s.status === 'connected') return onConnected();
    if (s.status === 'disabled') {
      st.lastResult = { ok: false, reason: 'MCP_DISABLED_BY_POLICY', detail: 'operator disabled the server; the supervisor never re-enables', at: new Date(now()).toISOString() };
      st.phase = st.outageAt ? 'RECOVERY_FAILED' : 'CONNECTED';
      persist();
      return { action: 'disabled' };
    }
    return onFailed(s.error || 'failed');
  }

  // ---- observability (client namespace ONLY; never authoritative) --------------
  function persist() {
    const t = transport();
    const rec = {
      schemaVersion: SUPERVISOR_SCHEMA_VERSION,
      supervisorBootId: id,
      supervisorPid: process.pid,
      supervisorStartedAt: startedAt,
      serverName,
      transportState: st.phase,
      adapterPid: t && t.lastPid != null ? t.lastPid : null,
      adapterBootId: st.lastBootId,
      lastDisconnectAt: st.outageAt || (t && t.lastDisconnectAt) || null,
      lastRecoveryAttemptAt: st.lastRecoveryAttemptAt,
      recoveryAttemptCount: st.attempt,
      maxAttempts: pol.maxAttempts,
      lastRecoveryResult: st.lastResult,
      expectedTaskIdentity: st.expected,
      currentTaskIdentity: (st.phase === 'CONNECTED' || st.phase === 'RECOVERED') ? (st.expected || (t && t.currentTaskIdentity) || null) : null,
      executionLiveness: (st.phase === 'CONNECTED' || st.phase === 'RECOVERED') ? (t && t.executionLiveness) || null : null,
      humanGateState: (st.phase === 'CONNECTED' || st.phase === 'RECOVERED') ? (t && t.humanGateState) || null : null,
      updatedAt: new Date(now()).toISOString(),
    };
    log(`${JSON.stringify({ at: rec.updatedAt, transportState: rec.transportState, recoveryAttemptCount: rec.recoveryAttemptCount, lastRecoveryResult: rec.lastRecoveryResult })}\n`);
    writeAtomic(supervisorStatePathFor({ stateDir }), rec);
    return rec;
  }

  function snapshot() { return readJsonSafe(supervisorStatePathFor({ stateDir })); }

  // Entry used by mcp-supervisor.mjs (and R11/R12 process tests).
  async function start() {
    const acq = acquireSupervisorLock({ stateDir, bootId: id, now, holderOpts });
    if (!acq.ok) { log(`${JSON.stringify({ at: new Date(now()).toISOString(), event: 'SUPERVISOR_ALREADY_RUNNING', holder: acq.holder })}\n`); return { ok: false, reason: 'SUPERVISOR_ALREADY_RUNNING' }; }
    persist();
    for (;;) {
      const r = await runCycle().catch((e) => { st.lastResult = { ok: false, reason: 'SUPERVISOR_CYCLE_THREW', detail: String((e && e.message) || e), at: new Date(now()).toISOString() }; persist(); return { action: 'threw' }; });
      if (r.action === 'stopped') { releaseSupervisorLock({ stateDir, bootId: id }); log(`${JSON.stringify({ at: new Date(now()).toISOString(), event: 'SUPERVISOR_STALE_STOPPED', reason: r.reason })}\n`); return { ok: false, reason: r.reason }; }
      await sleep(Math.max(50, pol.pollMs));
    }
  }

  return { id, runCycle, start, snapshot, persist, policy: pol, transportPath: transportStatePathFor({ stateDir }), statePath: supervisorStatePathFor({ stateDir }), lockPath: supervisorLockPathFor({ stateDir }) };
}
