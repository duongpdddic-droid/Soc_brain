#!/usr/bin/env node
// local-task-allocator.mjs — persistent LOCAL task-number allocator (Phase A,
// Local Task Identity v0). The Control UI no longer requires a GitHub Issue
// number: instruction-only runs draw a number from this machine-local,
// persisted sequence and feed it into the UNCHANGED canonical identity
// pipeline (identityHash({ repo, issueNumber }) in packages/workspace).
//
// Invariants (binding):
//   - numbers start at LOCAL_TASK_NUMBER_BASE (9_000_000) — far above any
//     realistic GitHub Issue number so local vs GitHub provenance is obvious;
//   - strictly increasing (monotonic), restart-safe (persisted on disk);
//   - a number is BURNED (persisted) before it is handed out: a crash between
//     burn and use can skip a number but can never replay one — burned IDs
//     are never intentionally reused;
//   - corrupt/invalid persisted state fails closed (no silent self-heal);
//   - concurrent allocation cannot produce duplicates: the sequence file is
//     mutated only under an exclusive-create lock file; a stale lock (owner
//     pid no longer alive) is broken, a live foreign owner fails closed
//     (ALLOCATOR_LOCKED) — never two live allocators inside the critical
//     section;
//   - allocation itself has NO admission authority: callers allocate only
//     AFTER their own base-admission gates succeed.

import fs from 'node:fs';
import path from 'node:path';

export const LOCAL_TASK_NUMBER_BASE = 9_000_000;
export const LOCAL_TASK_SEQUENCE_SCHEMA_VERSION = '1';

export function localTasksDir({ stateDir }) {
  return path.join(path.resolve(stateDir), 'local-tasks');
}
export function sequencePathFor({ stateDir }) {
  return path.join(localTasksDir({ stateDir }), 'sequence.json');
}
export function lockPathFor({ stateDir }) {
  return path.join(localTasksDir({ stateDir }), 'allocator.lock');
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ponytail: reason set is intentionally minimal (v0). Contention retry/backoff
// (Atomics.wait-based sleepSync) is deferred until measured contention occurs.
function isValidState(s) {
  return Boolean(s)
    && typeof s === 'object' && !Array.isArray(s)
    && s.schemaVersion === LOCAL_TASK_SEQUENCE_SCHEMA_VERSION
    && Number.isInteger(s.lastAllocated)
    && s.lastAllocated >= LOCAL_TASK_NUMBER_BASE - 1;
}

// SEQUENCE_NOT_FOUND = fresh install (empty dir is legal);
// anything unreadable/corrupt/schema-invalid = LOCAL_TASK_STATE_CORRUPT.
function readState(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, reason: 'SEQUENCE_NOT_FOUND' };
    return { ok: false, reason: 'LOCAL_TASK_STATE_CORRUPT', detail: `sequence unreadable: ${String((e && e.message) || e)}` };
  }
  let s;
  try { s = JSON.parse(raw); }
  catch (e) { return { ok: false, reason: 'LOCAL_TASK_STATE_CORRUPT', detail: `sequence not valid JSON: ${String((e && e.message) || e)}` }; }
  if (!isValidState(s)) return { ok: false, reason: 'LOCAL_TASK_STATE_CORRUPT', detail: 'sequence.json violates the persisted schema (schemaVersion/lastAllocated).' };
  return { ok: true, state: s };
}

function writeStateAtomic(p, state) {
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, p);
}

export function allocateLocalTaskNumber({ stateDir, clock = () => new Date().toISOString() } = {}) {
  if (typeof stateDir !== 'string' || !stateDir) return { ok: false, reason: 'MISSING_STATE_DIR' };
  const dir = localTasksDir({ stateDir });
  const seqPath = sequencePathFor({ stateDir });
  const lockPath = lockPathFor({ stateDir });
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    return { ok: false, reason: 'LOCAL_TASK_STATE_UNAVAILABLE', detail: String((e && e.message) || e) };
  }

  // ---- exclusive-create lock (stale-lock breaking is pid-evidence based) ----
  // ponytail: live-holder contention fails closed immediately (ALLOCATOR_LOCKED);
  // a bounded poll-wait (Atomics.wait-based sleepSync) can be re-added when
  // measured contention actually occurs.
  let acquired = false;
  for (let attempt = 0; attempt < 2 && !acquired; attempt++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: clock() }), { flag: 'wx' });
      acquired = true;
    } catch (e) {
      if ((e && e.code) !== 'EEXIST') return { ok: false, reason: 'ALLOCATOR_LOCK_UNAVAILABLE', detail: String((e && e.message) || e) };
      // EEXIST: is the current holder alive?
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { holder = null; }
      const stale = !holder || !Number.isInteger(holder.pid) || !pidAlive(holder.pid) || holder.pid === process.pid;
      if (!stale) return { ok: false, reason: 'ALLOCATOR_LOCKED', detail: `lock held by live pid ${holder.pid}` };
      try { fs.unlinkSync(lockPath); } catch { /* another waiter broke it first */ }
    }
  }
  if (!acquired) return { ok: false, reason: 'ALLOCATOR_LOCKED' };

  try {
    let state;
    const r = readState(seqPath);
    if (r.reason === 'SEQUENCE_NOT_FOUND') {
      state = { schemaVersion: LOCAL_TASK_SEQUENCE_SCHEMA_VERSION, lastAllocated: LOCAL_TASK_NUMBER_BASE - 1, createdAt: clock() };
    } else if (!r.ok) {
      return r; // fail closed: corrupt/invalid persisted state is never healed here
    } else {
      state = r.state;
    }
    const number = state.lastAllocated + 1;
    if (!Number.isSafeInteger(number) || number < LOCAL_TASK_NUMBER_BASE) {
      return { ok: false, reason: 'LOCAL_TASK_STATE_CORRUPT', detail: `next number ${number} out of range.` };
    }
    // Burn BEFORE use: persist first, hand out second. Crash => gap, never replay.
    try {
      writeStateAtomic(seqPath, { ...state, lastAllocated: number, updatedAt: clock() });
    } catch (e) {
      return { ok: false, reason: 'SEQUENCE_WRITE_FAILED', detail: String((e && e.message) || e) };
    }
    return { ok: true, number };
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* best-effort release */ }
  }
}
