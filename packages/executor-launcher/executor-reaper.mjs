#!/usr/bin/env node
// executor-reaper.mjs — Issue #157: canonical dead+unfinalized ExecutionRecord
// reaper / interrupted-finalization primitive.
//
// Closes the #107 round-6 deadlock: a lane process killed at the poll deadline
// leaves the record dead-pid + `finalized:false`, which `effectiveStatus`
// projects as RUNNING (never terminal), so the verifier is blocked
// (EXECUTION_NOT_TERMINAL) and re-dispatch is refused
// (EXECUTION_ALREADY_RUNNING) with no control-plane way out. This primitive
// performs the ONE transition that unblocks it:
//
//   RUNNING/unfinalized + EXACT process proven dead (pid + processStartTime,
//   via the #160 reconcileExecutorLiveness identity) -> INTERRUPTED/finalized,
//   persisted atomically with strict read-back.
//
// Issue #157 REWORK r3 (stale-write TOCTOU): every inspected fact (identity
// binding, pendingExecutorLatch, terminalStatus/finalized, pid/
// processStartTime liveness proof) is bound to ONE canonical raw-bytes source
// snapshot; the publish is the generation-bound CAS-equivalent
// (casReplaceIfCurrent): the canonical pathname is atomically CONSUMED into a
// private quarantine, the consumed bytes must equal the inspected snapshot,
// and the new generation is committed with a create-only hard link
// (EEXIST on Windows - physically incapable of overwriting a replacement).
// A stale observer therefore has ZERO overwrite-capable operations against
// the canonical name: any concurrent canonical mutation (writer finalization,
// relaunch overwrite, double reaper, independent process) makes the source
// stale -> commit NOTHING / restore the consumed newer generation byte-exact,
// and the newer record stands untouched.
//
// Ownership boundaries (Issue #157 non-goals):
//   - Control-plane owned: caller must present the canonical session
//     (verifySessionAuthority: lease + guards) whose identity fields match the
//     record — no anonymous reaping, no executor-side path.
//   - NEVER kills a process (liveness is proven, not caused) — death proof and
//     PID-reuse discrimination are REUSED from #160
//     (executor-reconcile.mjs / readWin32ProcessStartTime), never re-implemented.
//   - NEVER touches the session FSM, never terminalizes the task, carries no
//     verdict authority. It only finalizes the execution-lifecycle fact the
//     killed process could no longer write itself.
//   - Fail closed: a LIVE process can never be reaped; PID reuse and unknown/
//     unproven identity never reap under a wrong identity (legacy records
//     without processStartTime: dead-pid + owner gate only, live pid always
//     refuses); bind/cleanup latches stay owned by the #160 relaunch prove path.
//   - Idempotent replay: an already-terminal/finalized record is a NO-OP with a
//     truthful report (never overwrites a real terminal status like EXITED).
//
// No framework. Node >= 22.

import fs from 'node:fs';
import path from 'node:path';
import { verifySessionAuthority, readSessionRecord } from '../runtime-sandbox/runtime-sandbox.mjs';
import { readExecutionRecord, casReplaceIfCurrent, EXECUTION_SCHEMA_VERSION } from './executor-launcher.mjs';
import { reconcileExecutorLiveness, pendingExecutorLatch } from './executor-reconcile.mjs';

export const REAP_REASON = 'EXECUTION_REAPED_DEAD_UNFINALIZED';

// Liveness outcomes that POSITIVELY prove the recorded incarnation is gone:
//  - EXITED + PID_GONE: the pid itself is absent.
//  - PID_REUSED: the pid is live but provably a FOREIGN process
//    (Win32 processStartTime mismatch), so the recorded executor died and the
//    pid was recycled. The reaper never kills anything, so the foreign process
//    is untouched; the record keeps its captured identity as evidence.
// Everything else (RUNNING, OWNERSHIP_UNKNOWN, STARTING, STALE_CHILD) refuses.
const PROVEN_DEAD = new Set(['EXITED', 'PID_REUSED']);

export function reapInterruptedExecution({
  sessionPath, leaseToken, stateDir = null, controlCwd = process.cwd(),
  verifyAuthority = verifySessionAuthority,
  isAlive, readStartTime, clock = Date.now,
  beforePublish = null, afterConsume = null,
} = {}) {
  if (typeof sessionPath !== 'string' || !sessionPath) {
    return { ok: false, reason: 'SESSION_AUTHORITY_REJECTED', detail: 'sessionPath is required (canonical session record).' };
  }
  if (typeof leaseToken !== 'string' || !leaseToken) {
    return { ok: false, reason: 'SESSION_AUTHORITY_REJECTED', detail: 'leaseToken is required (owner/session binding).' };
  }
  const av = verifyAuthority({ sessionPath, leaseToken, controlCwd });
  if (!av || !av.ok) return { ok: false, reason: (av && av.reason) || 'SESSION_AUTHORITY_REJECTED' };

  // Identity always comes from the AUTHORITATIVE session on disk (never the
  // caller's copy, never the verifyAuthority stub's return) — same discipline
  // as startExecution's assertExecutionIdentity.
  const rs = readSessionRecord(sessionPath);
  if (!rs.ok) return { ok: false, reason: rs.reason, detail: rs.detail ?? null };
  const s = rs.session;

  const sd = stateDir || (s.controlPlane && s.controlPlane.stateDir) || path.dirname(path.dirname(sessionPath));
  const rr = readExecutionRecord({ stateDir: sd, repo: s.repo, issueNumber: s.issueNumber });
  if (!rr.ok) return { ok: false, reason: rr.reason, detail: rr.detail ?? null, path: rr.path ?? null };

  // SOURCE GENERATION BINDING: every later inspection is bound to this exact
  // raw-bytes snapshot of the canonical record, and the publish commits only
  // while it is still canonical. readExecutionRecord already validated
  // schema + canonical location; re-validate on the snapshot itself.
  let sourceRaw;
  try { sourceRaw = fs.readFileSync(rr.path, 'utf8'); } catch { return { ok: false, reason: 'REAP_SOURCE_STALE', detail: 'SOURCE_READ_FAILED', recordPath: rr.path }; }
  let record;
  try { record = JSON.parse(sourceRaw); } catch { return { ok: false, reason: 'REAP_RECORD_INVALID', detail: 'SOURCE_PARSE_FAILED', recordPath: rr.path }; }
  if (!record || typeof record !== 'object' || record.schemaVersion !== EXECUTION_SCHEMA_VERSION || record.identityHash !== rr.record.identityHash) {
    return { ok: false, reason: 'REAP_RECORD_INVALID', detail: 'source snapshot is schema/location mismatched', recordPath: rr.path };
  }

  const mism = [];
  if (String(record.taskId || '') !== String(s.taskId || '')) mism.push('taskId');
  if (String(record.repo || '').toLowerCase() !== String(s.repo || '').toLowerCase()) mism.push('repo');
  if (Number(record.issueNumber) !== Number(s.issueNumber)) mism.push('issueNumber');
  if (String(record.worktreePath || '') !== String(s.worktreePath || '')) mism.push('worktreePath');
  if (record.identityHash && s.identityHash && record.identityHash !== s.identityHash) mism.push('identityHash');
  if (mism.length) {
    return { ok: false, reason: 'EXECUTION_RECORD_IDENTITY_MISMATCH', fields: mism, detail: 'presented session is not the execution owner; reaping another identity fails closed' };
  }

  const deps = {};
  if (typeof isAlive === 'function') deps.isAlive = isAlive;
  if (typeof readStartTime === 'function') deps.readStartTime = readStartTime;
  const lv = reconcileExecutorLiveness(record, deps);

  // Idempotent replay: already terminal (authoritative status or the dead +
  // finalized LOST projection) -> NO-OP, truthful report, never overwritten.
  if (record.terminalStatus || record.finalized === true) {
    return {
      ok: true, action: 'NOOP_ALREADY_TERMINAL',
      status: record.terminalStatus || lv.liveness,
      identityHash: record.identityHash, pid: record.pid ?? null,
      recordPath: rr.path,
    };
  }
  // #160 owns bind/cleanup latches (relaunch prove path, priorIncarnationProvenGone).
  if (pendingExecutorLatch(record)) {
    return { ok: false, reason: 'EXECUTION_CLEANUP_REQUIRED', detail: 'PENDING_BIND_OR_CLEANUP_LATCH_RELAUNCH_OWNED', recordPath: rr.path };
  }

  if (lv.liveness === 'RUNNING') {
    return { ok: false, reason: 'EXECUTION_LIVE', detail: 'a live, identity-proven executor can never be reaped', pid: record.pid, recordPath: rr.path };
  }
  if (!PROVEN_DEAD.has(lv.liveness) || (lv.liveness === 'EXITED' && lv.reason !== 'PID_GONE')) {
    return { ok: false, reason: 'EXECUTOR_IDENTITY_UNPROVEN', detail: lv.reason, liveness: lv.liveness, recordPath: rr.path };
  }

  const reapedAt = clock();
  const next = {
    ...record,
    terminalStatus: 'INTERRUPTED',
    finalized: true,
    finishedAt: record.finishedAt ?? reapedAt,
    reason: REAP_REASON,
    reapedAt,
  };

  // Controllable pre-publish barrier (deterministic interleaving seam used by
  // the stale-writer / double-reap regressions; null in production).
  if (typeof beforePublish === 'function') beforePublish({ recordPath: rr.path, sourceRaw, snapshot: record });

  // GENERATION-BOUND CAS COMMIT (casReplaceIfCurrent): atomically consumes the
  // canonical pathname and commits ONLY if the consumed bytes are the exact
  // inspected snapshot; the new generation lands via a create-only hard link
  // that can never overwrite a replacement published by another writer. A
  // stale source -> zero bytes written, the newer record stands, and no
  // success is claimed. afterConsume is the mid-flight race-test seam.
  const pub = casReplaceIfCurrent(rr.path, sourceRaw, next, { afterConsume });
  if (!pub.ok) {
    return { ok: false, reason: 'REAP_SOURCE_STALE', detail: pub.reason, committed: false, restored: pub.restored ?? false, recordPath: rr.path };
  }

  // Strict commit gate (same discipline as #160 latch-clear): success is
  // claimed ONLY when the canonical read-back shows the reap persisted with
  // the exact reaped identity — anything else is reported as unknown, never
  // as success.
  const rb = readExecutionRecord({ stateDir: sd, repo: s.repo, issueNumber: s.issueNumber });
  if (!rb.ok) return { ok: false, reason: 'REAP_READBACK_FAILED', detail: rb.reason, recordPath: rr.path };
  const bad = [];
  if (rb.record.terminalStatus !== 'INTERRUPTED') bad.push('terminalStatus');
  if (rb.record.finalized !== true) bad.push('finalized');
  if (rb.record.pid !== record.pid) bad.push('pid');
  if (rb.record.processStartTime !== record.processStartTime) bad.push('processStartTime');
  if (rb.record.reapedAt !== reapedAt) bad.push('reapedAt');
  if (bad.length) return { ok: false, reason: 'REAP_READBACK_MISMATCH', fields: bad, recordPath: rr.path };

  return {
    ok: true, action: 'REAPED',
    identityHash: record.identityHash, taskId: record.taskId,
    pid: record.pid, processStartTime: record.processStartTime ?? null,
    proof: lv.reason, status: 'INTERRUPTED', recordPath: rb.path,
  };
}
