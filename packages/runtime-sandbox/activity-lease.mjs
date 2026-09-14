#!/usr/bin/env node
// activity-lease.mjs — Issue #172 F1: authoritative EXECUTOR LIVENESS registry.
//
// The Idle Hibernate Supervisor is a READ-ONLY observer whose activity authority
// was (before #172) limited to canonical lifecycle records (session / control-loop
// ledger / execution record). A live interactive/agent executor that never
// materializes such a lifecycle record was therefore INVISIBLE, and the machine
// could be powered off over it (the #172 S3-over-running-task incident).
//
// This module is the WRITE side of a minimal, canonical liveness authority:
// the shared MCP broker boundary (OpenCode + Cline both speak to
// runtime-sandbox/mcp-server.mjs, whose boot is the authoritative session bind)
// publishes ONE lease per bound executor process and refreshes/retires it. The
// supervisor only READS these files; nothing here mutates the task FSM or creates
// a second mutation owner — the lease is ACTIVITY AUTHORITY ONLY.
//
// Identity safety (reuses #160/#157 primitives, mirrors reconcileExecutorLiveness
// semantics WITHOUT importing executor-launcher, which would cycle through
// idle-supervisor -> runtime-sandbox): a lease is only ever trusted as LIVE when
// the pid's immutable Win32 PROCESS_START_TIME still matches and the process is
// alive; a recycled pid is never the original executor. A lease with alive pid but
// unprovable identity is fail-closed UNKNOWN. The writer never clobbers or deletes
// a DIFFERENT live incarnation's lease (no blind delete of a newer owner).
//
// Path contract: <stateDir>/activity/live/<identityHash>.json — the SAME location
// and identity fields the supervisor's idle-supervisor ACTIVITY_LEASE_SUBDIR reads.

import fs from 'node:fs';
import path from 'node:path';
import { readWin32ProcessStartTime, isAlive as winIsAlive } from '../temp-hygiene/temp-hygiene.mjs';

export const ACTIVITY_LEASE_SUBDIR = 'activity/live';
export const ACTIVITY_LEASE_SCHEMA_VERSION = '1';

export function activityLeasePathFor({ stateDir, identityHash } = {}) {
  return path.join(path.resolve(stateDir), ACTIVITY_LEASE_SUBDIR, `${identityHash}.json`);
}

function readLease(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? { absent: true } : { corrupt: true }; }
  try { const o = JSON.parse(raw); return o && typeof o === 'object' ? o : { corrupt: true }; } catch { return { corrupt: true }; }
}

function writeLeaseAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, p);
}

// Writer-side identity liveness (kept local + tiny to avoid an import cycle).
function leaseLiveness(rec, { isAlive, readStartTime }) {
  if (!rec || !Number.isInteger(rec.pid) || rec.pid <= 0) return 'STARTING';
  if (!isAlive(rec.pid)) return 'GONE';
  if (rec.processStartTime == null) return 'UNPROVEN';
  const cur = readStartTime(rec.pid);
  if (!cur || cur.processStartTime == null) return 'UNPROVEN';
  return cur.processStartTime === rec.processStartTime ? 'LIVE' : 'REUSED';
}

function sameIncarnation(rec, pid, processStartTime) {
  return Boolean(rec) && rec.pid === pid && (rec.processStartTime ?? null) === (processStartTime ?? null);
}

// Create OR refresh THIS incarnation's own lease (authoritative bind). Never
// overwrites a DIFFERENT, still-live incarnation's lease (fail-closed with a
// reason instead of a second-owner clobber).
export function publishExecutorLease({ stateDir, identity, now = () => Date.now(), deps = {} } = {}) {
  const { identityHash, pid, processStartTime, bootId = null, repo = null, issueNumber = null } = identity || {};
  if (!stateDir || !identityHash || !Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: 'LEASE_IDENTITY_INCOMPLETE' };
  }
  const isAlive = deps.isAlive || winIsAlive;
  const readStartTime = deps.readStartTime !== undefined ? deps.readStartTime : ((p) => readWin32ProcessStartTime(p, deps.exec));
  const p = activityLeasePathFor({ stateDir, identityHash });
  const cur = readLease(p);
  if (cur && !cur.absent && !cur.corrupt && !sameIncarnation(cur, pid, processStartTime) && leaseLiveness(cur, { isAlive, readStartTime }) === 'LIVE') {
    return { ok: false, reason: 'LEASE_HELD_BY_LIVE_INCARNATION', holder: { pid: cur.pid, processStartTime: cur.processStartTime ?? null } };
  }
  const stamp = new Date(now()).toISOString();
  const lease = {
    schemaVersion: ACTIVITY_LEASE_SCHEMA_VERSION, identityHash, repo, issueNumber,
    pid, processStartTime: processStartTime ?? null, bootId,
    heartbeatAt: stamp, updatedAt: stamp,
  };
  try { writeLeaseAtomic(p, lease); return { ok: true, path: p, lease }; }
  catch (e) { return { ok: false, reason: 'LEASE_WRITE_FAILED', detail: String((e && e.message) || e) }; }
}

// Event-driven heartbeat: advance THIS incarnation's own timestamps ONLY when the
// lease still holds my exact {pid,processStartTime}. Never creates, never touches
// a foreign/newer incarnation's lease.
export function refreshExecutorLease({ stateDir, identityHash, pid, processStartTime, now = () => Date.now(), deps = {} } = {}) {
  if (!stateDir || !identityHash) return { ok: false, reason: 'LEASE_IDENTITY_INCOMPLETE' };
  const p = activityLeasePathFor({ stateDir, identityHash });
  const cur = readLease(p);
  if (!cur || cur.absent) return { ok: false, reason: 'LEASE_ABSENT' };
  if (cur.corrupt || !sameIncarnation(cur, pid, processStartTime)) return { ok: false, reason: 'LEASE_NOT_OWNER' };
  const lease = { ...cur, heartbeatAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString() };
  try { writeLeaseAtomic(p, lease); return { ok: true, lease }; }
  catch (e) { return { ok: false, reason: 'LEASE_WRITE_FAILED', detail: String((e && e.message) || e) }; }
}

// Retire ONLY my own incarnation's lease (proven terminal / clean shutdown). A
// stale shutdown never deletes a newer incarnation's lease (identity guard).
export function retireExecutorLease({ stateDir, identityHash, pid, processStartTime, deps = {} } = {}) {
  if (!stateDir || !identityHash) return { ok: false, reason: 'LEASE_IDENTITY_INCOMPLETE' };
  const p = activityLeasePathFor({ stateDir, identityHash });
  const cur = readLease(p);
  if (!cur || cur.absent) return { ok: true, released: false, reason: 'LEASE_ABSENT' };
  if (cur.corrupt || !sameIncarnation(cur, pid, processStartTime)) {
    return { ok: true, released: false, reason: 'LEASE_NOT_OWNER' }; // never blind-delete a foreign lease
  }
  try { fs.unlinkSync(p); return { ok: true, released: true }; }
  catch (e) { return { ok: false, reason: 'LEASE_UNLINK_FAILED', detail: String((e && e.message) || e) }; }
}

// High-level lifecycle used by the production broker entry (mcp-server main) and
// by the deterministic regressions (same code path, injected OS probes). It owns
// NO mutation authority and touches NO FSM state.
export function createExecutorLiveness({ stateDir, identityHash, repo = null, issueNumber = null, pid, processStartTime, bootId = null, deps = {}, now = () => Date.now() } = {}) {
  const myPid = pid != null ? pid : process.pid;
  const readStartTime = deps.readStartTime !== undefined ? deps.readStartTime : ((p) => readWin32ProcessStartTime(p, deps.exec));
  const myStart = processStartTime != null ? processStartTime : (() => { try { const r = readStartTime(myPid); return r ? r.processStartTime : null; } catch { return null; } })();
  const identity = { identityHash, pid: myPid, processStartTime: myStart, bootId, repo, issueNumber };
  return {
    identity,
    start() { try { return publishExecutorLease({ stateDir, identity, now, deps }); } catch (e) { return { ok: false, reason: 'LEASE_PUBLISH_THREW', detail: String((e && e.message) || e) }; } },
    heartbeat() { try { return refreshExecutorLease({ stateDir, identityHash, pid: myPid, processStartTime: myStart, now, deps }); } catch (e) { return { ok: false, reason: 'LEASE_REFRESH_THREW', detail: String((e && e.message) || e) }; } },
    retire() { try { return retireExecutorLease({ stateDir, identityHash, pid: myPid, processStartTime: myStart, deps }); } catch (e) { return { ok: false, reason: 'LEASE_RETIRE_THREW', detail: String((e && e.message) || e) }; } },
  };
}
