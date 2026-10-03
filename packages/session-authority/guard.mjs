// guard.mjs — session mutation fence (the client half of the admission contract).
//
// WHAT THIS IS: a per-session FENCE carried by the process that intends to
// mutate the canonical session record / control-loop ledger. The fence is only
// minted by the Session Admission Authority and only stays valid while
//   (a) this process still holds the owning pipe connection,
//   (b) the authority still reports the same token + daemonEpoch on that same
//       connection (checked on a renewal cadence AND on demand), and
//   (c) the fence has not gone stale.
// Any failure is fail-closed: the sync check simply refuses the mutation.
//
// WHAT THIS IS NOT: it is NOT the activity-lease (packages/runtime-sandbox/
// activity-lease.mjs), which stays a pure liveness signal for the idle
// supervisor, and it is NOT a file lease. Nothing here writes a grant to disk,
// and nothing here falls back to one.
//
// ARMING: enforcement is opt-in via SOC_SESSION_ADMISSION=required (or
// setSessionAdmissionMode('required')). While disarmed the sync check is a
// no-op, which keeps legacy/offline flows working — that is reported honestly
// as "not yet wired", never as "enforced".
//
// SYNC CONTRACT: mutation seams in this repo are synchronous (fs write inside a
// critical section). assertAdmissionFence() is therefore purely synchronous and
// never touches the network: it reads this process's fence state, which is kept
// truthful by the socket close/error handlers (synchronous invalidation) plus
// the renewal loop.

import {
  CODES, canonicalIdentityHash, canonicalSessionPath,
} from './protocol.mjs';
import { createAuthorityClient } from './authority-client.mjs';
import { readWin32ProcessStartTime } from '../temp-hygiene/temp-hygiene.mjs';

export const ADMISSION_MODE_ENV = 'SOC_SESSION_ADMISSION';
export const FENCE_RENEW_MS = 5000;
export const FENCE_MAX_STALE_MS = 15000;

let mode = (process.env[ADMISSION_MODE_ENV] === 'required' || process.env[ADMISSION_MODE_ENV] === '1') ? 'required' : 'off';
let sharedClient = null;
let sharedPipePath = null;
let renewTimer = null;
let unsubClose = null;

const fencesByPath = new Map();   // canonical sessionPath -> fence
const fencesById = new Map();     // canonical identityHash -> fence

export function sessionAdmissionMode() { return mode; }

export function setSessionAdmissionMode(next) {
  mode = next === 'required' ? 'required' : 'off';
  if (mode === 'off') clearAllFences('MODE_OFF');
  return mode;
}

export function isSessionAdmissionArmed() { return mode === 'required'; }

function invalidateFence(fence, reason) {
  if (!fence) return;
  fence.connectionAlive = false;
  fence.revoked = true;
  fence.invalidReason = reason || 'INVALIDATED';
}

function clearAllFences(reason) {
  for (const f of fencesByPath.values()) invalidateFence(f, reason);
  fencesByPath.clear();
  fencesById.clear();
}

function indexFence(fence) {
  fencesByPath.set(fence.sessionPath, fence);
  fencesById.set(fence.identityHash, fence);
}

function lookupFence({ sessionPath = null, identityHash = null } = {}) {
  if (sessionPath) {
    const c = canonicalSessionPath(sessionPath);
    if (c.ok && fencesByPath.has(c.sessionPath)) return fencesByPath.get(c.sessionPath);
  }
  if (identityHash) {
    const c = canonicalIdentityHash(identityHash);
    if (c.ok && fencesById.has(c.identityHash)) return fencesById.get(c.identityHash);
  }
  return null;
}

async function ensureClient(pipePath) {
  const target = pipePath || process.env.SOC_SESSION_AUTHORITY_PIPE_PATH || null;
  if (sharedClient && (!target || sharedPipePath === target)) return { ok: true, client: sharedClient };
  if (sharedClient) await closeSessionAdmission();
  const client = createAuthorityClient(target ? { pipePath: target } : {});
  const r = await client.connect();
  if (!r.ok) return { ok: false, code: r.code, detail: r.detail };
  sharedClient = client;
  sharedPipePath = client.pipePath;
  unsubClose = client.onClose(({ code, detail }) => {
    // Synchronous invalidation on pipe loss: no mutation can pass the sync
    // check after this tick, even if the authority never sends another byte.
    for (const f of fencesByPath.values()) invalidateFence(f, `${code}: ${detail}`);
  });
  startRenewal();
  return { ok: true, client };
}

function startRenewal() {
  if (renewTimer) return;
  renewTimer = setInterval(() => { void renewAllFences(); }, FENCE_RENEW_MS);
  if (typeof renewTimer.unref === 'function') renewTimer.unref();
}

function stopRenewal() {
  if (!renewTimer) return;
  clearInterval(renewTimer);
  renewTimer = null;
}

async function renewAllFences() {
  const client = sharedClient;
  if (!client) return;
  for (const fence of [...fencesByPath.values()]) {
    if (fence.revoked) continue;
    const r = await client.verify({ identityHash: fence.identityHash, sessionPath: fence.sessionPath, token: fence.token, daemonEpoch: fence.daemonEpoch });
    if (!r.ok) {
      // EPOCH_STALE / NOT_OWNER / any transport failure => the fence is dead.
      invalidateFence(fence, `${r.code}: ${r.detail}`);
      continue;
    }
    fence.renewedAt = Date.now();
    fence.renewCount = (fence.renewCount || 0) + 1;
  }
}

// ---- public API -------------------------------------------------------------

// Canonical owner-incarnation helper for THIS process. admitSession() calls
// over a live authority require a provable owner {pid, processStartTime};
// every entry point that arms the gate must pass this helper's result through
// instead of hand-rolling (or omitting) the owner. Returns null when the Win32
// start time cannot be read - callers then fail closed (an unprovable owner is
// never admitted), never with a fabricated incarnation.
export function ownIncarnation() {
  try {
    const r = readWin32ProcessStartTime(process.pid);
    if (r && Number.isInteger(r.processStartTime) && r.processStartTime > 0) {
      return { pid: process.pid, processStartTime: r.processStartTime };
    }
    return null;
  } catch {
    return null;
  }
}

// The authority pipe THIS process is currently connected through. Recorded on
// reconciliation grants so readers can locate the daemon's durable owner
// snapshot. This is endpoint metadata only - never a grant: the fence token
// stays in-process and is never handed to disk writers here.
export function currentAuthorityPipePath() { return sharedPipePath; }

// ACQUIRE this canonical session for THIS process. Fail-closed: a missing or
// unreachable authority, a conflict, or an unprovable owner incarnation all
// return { ok:false } and the caller must not mutate.
export async function admitSession({ identityHash, sessionPath, laneId = null, owner = null, pipePath = null } = {}) {
  if (mode !== 'required') return { ok: true, armed: false, fence: null, reason: 'ADMISSION_DISARMED' };
  const idc = canonicalIdentityHash(identityHash);
  if (!idc.ok) return { ok: false, code: idc.reason, detail: idc.detail ?? null };
  const spc = canonicalSessionPath(sessionPath);
  if (!spc.ok) return { ok: false, code: spc.reason, detail: 'sessionPath is not canonicalizable' };

  const c = await ensureClient(pipePath);
  if (!c.ok) return { ok: false, code: c.code, detail: c.detail };

  const r = await c.client.acquire({ identityHash: idc.identityHash, sessionPath: spc.sessionPath, laneId, owner });
  if (!r.ok) return r;

  const fence = {
    identityHash: idc.identityHash,
    sessionPath: spc.sessionPath,
    laneId: r.value.laneId ?? laneId,
    token: r.value.token,
    daemonEpoch: r.value.daemonEpoch,
    connectionId: r.value.connectionId,
    generation: r.value.generation,
    renewedAt: Date.now(),
    acquiredAt: Date.now(),
    renewCount: 0,
    connectionAlive: true,
    revoked: false,
    invalidReason: null,
  };
  indexFence(fence);
  return { ok: true, armed: true, fence, grant: r.value };
}

// Explicit fresh round-trip immediately before a high-value mutation boundary.
// Not a substitute for the sync check — it PRECEDES it.
export async function refreshAdmissionFence({ sessionPath = null, identityHash = null } = {}) {
  if (mode !== 'required') return { ok: true, armed: false, reason: 'ADMISSION_DISARMED' };
  const fence = lookupFence({ sessionPath, identityHash });
  if (!fence) return { ok: false, code: CODES.ADMISSION_FENCE_MISSING, detail: 'no admission fence for this session' };
  if (!sharedClient) return { ok: false, code: CODES.ADMISSION_CONNECTION_LOST, detail: 'authority client is not connected' };
  const r = await sharedClient.verify({ identityHash: fence.identityHash, sessionPath: fence.sessionPath, token: fence.token, daemonEpoch: fence.daemonEpoch });
  if (!r.ok) { invalidateFence(fence, `${r.code}: ${r.detail}`); return { ok: false, code: r.code, detail: r.detail }; }
  fence.renewedAt = Date.now();
  fence.renewCount = (fence.renewCount || 0) + 1;
  return { ok: true, armed: true, fence };
}

// THE synchronous mutation-boundary check. Called from inside the ownership
// critical section so no session/ledger write can be selected without it.
export function assertAdmissionFence({ sessionPath = null, identityHash = null } = {}) {
  if (mode !== 'required') return { ok: true, armed: false };
  const fence = lookupFence({ sessionPath, identityHash });
  if (!fence) return { ok: false, code: CODES.ADMISSION_FENCE_MISSING, detail: 'this process never acquired an admission fence for this session' };
  if (fence.revoked) return { ok: false, code: CODES.ADMISSION_FENCE_REVOKED, detail: fence.invalidReason || 'fence revoked' };
  if (!fence.connectionAlive) return { ok: false, code: CODES.ADMISSION_CONNECTION_LOST, detail: fence.invalidReason || 'authority connection lost' };
  const age = Date.now() - fence.renewedAt;
  if (age > FENCE_MAX_STALE_MS) {
    invalidateFence(fence, `fence not renewed for ${age}ms`);
    return { ok: false, code: CODES.ADMISSION_FENCE_STALE, detail: `last authority confirmation was ${age}ms ago (> ${FENCE_MAX_STALE_MS}ms)` };
  }
  if (!sharedClient || !sharedClient.connected) {
    invalidateFence(fence, 'authority client disconnected');
    return { ok: false, code: CODES.ADMISSION_CONNECTION_LOST, detail: 'authority client is not connected' };
  }
  // Additive observability for callers that record an authorized write: the
  // grant's daemon-side fields (lane/epoch/generation/connection/acquiredAt).
  // The fence TOKEN stays in-process memory semantics - callers must never
  // persist it (grants are never written to disk by this package).
  return { ok: true, armed: true, fence: { identityHash: fence.identityHash, sessionPath: fence.sessionPath, token: fence.token, daemonEpoch: fence.daemonEpoch, generation: fence.generation, laneId: fence.laneId ?? null, connectionId: fence.connectionId ?? null, acquiredAt: fence.acquiredAt ?? null, renewedAt: fence.renewedAt ?? null, ageMs: age } };
}

// Register a detached child/worker under the current grant so it participates
// in the fencing contract (takeover needs positive death evidence for it too).
export async function attachAdmissionWorker({ sessionPath = null, identityHash = null, worker = null } = {}) {
  if (mode !== 'required') return { ok: true, armed: false, reason: 'ADMISSION_DISARMED' };
  const fence = lookupFence({ sessionPath, identityHash });
  if (!fence) return { ok: false, code: CODES.ADMISSION_FENCE_MISSING, detail: 'no admission fence for this session' };
  if (!sharedClient) return { ok: false, code: CODES.ADMISSION_CONNECTION_LOST, detail: 'authority client is not connected' };
  return sharedClient.attach({ identityHash: fence.identityHash, sessionPath: fence.sessionPath, token: fence.token, daemonEpoch: fence.daemonEpoch, worker });
}

export async function detachAdmissionWorker({ sessionPath = null, identityHash = null, workerPid = null } = {}) {
  if (mode !== 'required') return { ok: true, armed: false, reason: 'ADMISSION_DISARMED' };
  const fence = lookupFence({ sessionPath, identityHash });
  if (!fence) return { ok: false, code: CODES.ADMISSION_FENCE_MISSING, detail: 'no admission fence for this session' };
  if (!sharedClient) return { ok: false, code: CODES.ADMISSION_CONNECTION_LOST, detail: 'authority client is not connected' };
  return sharedClient.detach({ identityHash: fence.identityHash, sessionPath: fence.sessionPath, token: fence.token, daemonEpoch: fence.daemonEpoch, workerPid });
}

// Explicit RELEASE. Only valid with the exact token/epoch/connection the
// authority currently holds (the server enforces that; a late release of an
// old token can never revoke a newer lease).
export async function releaseAdmission({ sessionPath = null, identityHash = null } = {}) {
  if (mode !== 'required') return { ok: true, armed: false, reason: 'ADMISSION_DISARMED' };
  const fence = lookupFence({ sessionPath, identityHash });
  if (!fence) return { ok: true, released: false, reason: 'NO_FENCE' };
  // Revoke locally BEFORE asking the daemon to release. A new grant may be
  // minted as soon as RELEASE is processed, before its reply reaches us.
  invalidateFence(fence, 'OWNER_RELEASED');
  if (!sharedClient) { clearOne(fence); return { ok: false, code: CODES.ADMISSION_CONNECTION_LOST, detail: 'authority client is not connected' }; }
  const r = await sharedClient.release({ identityHash: fence.identityHash, sessionPath: fence.sessionPath, token: fence.token, daemonEpoch: fence.daemonEpoch });
  clearOne(fence);
  return r;
}

function clearOne(fence) {
  fencesByPath.delete(fence.sessionPath);
  fencesById.delete(fence.identityHash);
}

export async function closeSessionAdmission({ release = false } = {}) {
  if (release && sharedClient && fencesByPath.size) {
    for (const fence of [...fencesByPath.values()]) {
      invalidateFence(fence, 'OWNER_RELEASED');
      try { await sharedClient.release({ identityHash: fence.identityHash, sessionPath: fence.sessionPath, token: fence.token, daemonEpoch: fence.daemonEpoch }); } catch { /* fail-closed */ }
    }
  }
  stopRenewal();
  if (unsubClose) { try { unsubClose(); } catch { /* already gone */ } unsubClose = null; }
  if (sharedClient) { try { sharedClient.close(); } catch { /* already gone */ } }
  sharedClient = null;
  sharedPipePath = null;
  clearAllFences('CLIENT_CLOSED');
}

// Read-only diagnostics (never grants, never mutates).
export function describeAdmission() {
  return {
    mode,
    connected: Boolean(sharedClient && sharedClient.connected),
    pipePath: sharedPipePath,
    fenceCount: fencesByPath.size,
    fences: [...fencesByPath.values()].map((f) => ({
      identityHash: f.identityHash,
      sessionPath: f.sessionPath,
      generation: f.generation,
      connectionAlive: f.connectionAlive,
      revoked: f.revoked,
      ageMs: Date.now() - f.renewedAt,
      invalidReason: f.invalidReason,
    })),
  };
}

// Test seam: drop every fence without touching the transport.
export function __resetAdmissionForTests() {
  stopRenewal();
  if (unsubClose) { try { unsubClose(); } catch { /* gone */ } unsubClose = null; }
  if (sharedClient) { try { sharedClient.close(); } catch { /* gone */ } }
  sharedClient = null;
  sharedPipePath = null;
  clearAllFences('RESET');
}
