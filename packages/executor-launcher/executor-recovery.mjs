#!/usr/bin/env node
// executor-recovery.mjs — Issue #167: launcher/control-plane startup and recovery sweep.
//
// Ownership is deliberately narrow:
//   - #160 owns process identity/liveness classification (executor-reconcile);
//   - #157 owns canonical dead+unfinalized finalization (executor-reaper);
//   - this module only discovers nonterminal ExecutionRecords, applies the
//     canonical precedence, and invokes #157 for an exact-dead record. It never
//     becomes a second canonical-record mutation owner and never revives a
//     session/FSM.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeRemoteUrl } from '../safe-git/safe-git.mjs';
import { readSessionRecord, sessionPathFor, parkStaleSession } from '../runtime-sandbox/runtime-sandbox.mjs';
import { IDENTITY_HASH_LENGTH, identityHash } from '../workspace/workspace.mjs';
import {
  appendTerminalEvidence, executionRecordPath, readExecutionRecord,
} from './executor-launcher.mjs';
import { reconcileExecutorLiveness, canonicalTaskActivityVerdict } from './executor-reconcile.mjs';
import { reapInterruptedExecution } from './executor-reaper.mjs';

export const RECOVERY_EVIDENCE_SCHEMA_VERSION = '1';
export const RECOVERY_EVIDENCE_MAX_LINES = 64;
const ID_RE = new RegExp(`^[0-9a-f]{${IDENTITY_HASH_LENGTH}}\\.json$`);

function identityFromFilename(name) {
  return ID_RE.test(name) ? name.slice(0, -'.json'.length) : null;
}

function evidencePath({ stateDir }) {
  return path.join(path.resolve(stateDir), 'recovery', 'execution-sweeps.jsonl');
}

function persistRecoveryEvidence({ stateDir, evidence }) {
  const p = evidencePath({ stateDir });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let lines = [];
  try { lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean); } catch { /* first sweep */ }
  lines.push(JSON.stringify(evidence));
  if (lines.length > RECOVERY_EVIDENCE_MAX_LINES) lines = lines.slice(-RECOVERY_EVIDENCE_MAX_LINES);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${lines.join('\n')}\n`, 'utf8');
  fs.renameSync(tmp, p);
  return p;
}

function result({ record, classification, action, reason, detail = null, proof = null, status = null, terminalEvidence = null }) {
  return {
    identityHash: record.identityHash,
    taskId: record.taskId ?? null,
    repo: record.repo ?? null,
    issueNumber: record.issueNumber ?? null,
    pid: record.pid ?? null,
    processStartTime: record.processStartTime ?? null,
    classification,
    action,
    reason,
    detail,
    proof,
    status,
    mutationOwner: action === 'REAPED' ? 'executor-reaper' : 'none',
    terminalEvidenceOk: terminalEvidence?.ok === true,
    terminalEvidence,
  };
}

function inspectOne({ stateDir, identityHash, repo, controlCwd, reap, isAlive, readStartTime, clock }) {
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(executionRecordPath({ stateDir, identityHash }), 'utf8')); } catch { /* invalid */ }
  if (!parsed || typeof parsed !== 'object' || parsed.identityHash !== identityHash) {
    return { record: { identityHash, repo: null, issueNumber: null }, outcome: 'EXECUTION_RECORD_INVALID', classification: 'OWNERSHIP_UNKNOWN' };
  }
  const rr = readExecutionRecord({ stateDir, repo: parsed.repo, issueNumber: parsed.issueNumber });
  if (!rr.ok || String(rr.record.identityHash) !== identityHash) {
    return { record: parsed, outcome: rr.reason || 'EXECUTION_RECORD_INVALID', classification: 'OWNERSHIP_UNKNOWN' };
  }
  const record = rr.record;
  const id = normalizeRemoteUrl(record.repo || '');
  if (!id || id.toLowerCase() !== normalizeRemoteUrl(repo || '').toLowerCase()) return { record, outcome: 'REPO_FILTERED', classification: 'REPO_FILTERED' };
  if (record.terminalStatus || record.finalized === true) return { record, outcome: 'TERMINAL', classification: record.terminalStatus || 'INTERRUPTED' };

  const live = reconcileExecutorLiveness(record, { isAlive, readStartTime });
  const classification = live.liveness || 'OWNERSHIP_UNKNOWN';
  if (live.reason === 'PID_GONE' && classification === 'EXITED') {
    const sp = sessionPathFor({ stateDir, identityHash });
    const rs = readSessionRecord(sp);
    if (!rs.ok) return { record, outcome: 'SESSION_AUTHORITY_UNAVAILABLE', classification, detail: rs.reason };
    if (rs.session.identityHash !== identityHash || String(rs.session.taskId || '') !== String(record.taskId || '')) {
      return { record, outcome: 'EXECUTION_RECORD_IDENTITY_MISMATCH', classification, detail: 'SESSION_IDENTITY_MISMATCH' };
    }
    const leaseToken = rs.session.lease?.token;
    if (typeof leaseToken !== 'string' || !leaseToken) return { record, outcome: 'SESSION_AUTHORITY_UNAVAILABLE', classification, detail: 'LEASE_TOKEN_MISSING' };
    const reaped = reap({
      sessionPath: sp,
      leaseToken,
      stateDir,
      controlCwd,
      isAlive,
      readStartTime,
      clock,
    });
    if (reaped.ok && reaped.action === 'REAPED') {
      const rb = readExecutionRecord({ stateDir, repo: record.repo, issueNumber: record.issueNumber });
      if (!rb.ok || rb.record.terminalStatus !== 'INTERRUPTED' || rb.record.finalized !== true || rb.record.pid !== record.pid || rb.record.processStartTime !== record.processStartTime) {
        return { record, outcome: 'REAP_READBACK_INVALID', classification, reason: rb.reason || 'REAP_READBACK_INVALID', detail: rb.detail ?? null, proof: live.reason };
      }
      const terminalEvidence = appendTerminalEvidence({
        stateDir,
        identityHash,
        event: {
          kind: 'EXECUTION_RECOVERY_FINALIZED',
          status: 'INTERRUPTED',
          proof: live.reason,
          reapedAt: rb.record.reapedAt ?? null,
          deadIsNotCompletion: true,
        },
        clock,
      });
      return { record: rb.record, outcome: 'REAPED', classification: 'EXITED', status: 'INTERRUPTED', proof: live.reason, terminalEvidence };
    }
    if (reaped.ok && reaped.action === 'NOOP_ALREADY_TERMINAL') {
      return { record, outcome: 'NOOP_ALREADY_TERMINAL', classification: 'EXITED', status: reaped.status, proof: live.reason };
    }
    return { record, outcome: 'REAP_FAILED', classification: reaped.classification || classification, reason: reaped.reason, detail: reaped.detail, proof: live.reason };
  }
  if (classification === 'PID_REUSED' || classification === 'OWNERSHIP_UNKNOWN' || classification === 'STALE_CHILD') {
    return { record, outcome: 'FAIL_CLOSED', classification, detail: live.reason };
  }
  return { record, outcome: 'SKIP_NONTERMINAL', classification, detail: live.reason };
}

export function recoverNonterminalExecutions({
  stateDir, repo = null, controlCwd = process.cwd(),
  reap = reapInterruptedExecution, isAlive, readStartTime, clock = Date.now,
} = {}) {
  if (typeof stateDir !== 'string' || !stateDir) return { ok: false, reason: 'STATE_DIR_REQUIRED' };
  try {
    const dir = path.join(path.resolve(stateDir), 'executions');
    let names = [];
    try { names = fs.readdirSync(dir).sort(); } catch { names = []; }
    const results = [];
    for (const name of names) {
      const identityHash = identityFromFilename(name);
      if (!identityHash) continue;
      let r;
      try {
        r = inspectOne({ stateDir, identityHash, repo, controlCwd, reap, isAlive, readStartTime, clock });
      } catch (e) {
        r = {
          record: { identityHash, repo: typeof repo === 'string' ? repo : null, issueNumber: null },
          outcome: 'RECOVERY_EXCEPTION',
          classification: 'OWNERSHIP_UNKNOWN',
          detail: String((e && e.message) || e),
        };
      }
      if (r.record) results.push(result({
        record: r.record,
        classification: r.classification,
        action: r.outcome,
        reason: r.reason ?? r.outcome,
        detail: r.detail ?? null,
        proof: r.proof ?? null,
        status: r.status ?? null,
        terminalEvidence: r.terminalEvidence ?? null,
      }));
    }
    const counts = results.reduce((acc, x) => ({ ...acc, [x.classification]: (acc[x.classification] || 0) + 1 }), {});
    const evidence = {
      schemaVersion: RECOVERY_EVIDENCE_SCHEMA_VERSION,
      kind: 'ExecutionRecoverySweep',
      at: new Date(clock()).toISOString(),
      repo: repo ? normalizeRemoteUrl(repo) : null,
      scanned: results.length,
      counts,
      results,
      sessionOrFsmMutation: false,
      secondMutationOwner: false,
    };
    const p = persistRecoveryEvidence({ stateDir, evidence });
    return { ok: true, evidencePath: p, evidence };
  } catch (e) {
    return { ok: false, reason: 'STARTUP_RECOVERY_FAILED', detail: String((e && e.message) || e), evidence: null };
  }
}

// ---- Issue #9000005: canonical stale-session reconciliation (maintenance) -----
// ONE deterministic, read-only-by-default maintenance pass over the SESSION
// lifecycle dimension that COMPLEMENTS (never duplicates) the execution-record
// sweep above. The execution sweep finalizes ExecutionRecords; this pass brings
// a lagging session FSM record into line with a terminal lifecycle decision that
// INDEPENDENT canonical authority has already recorded, so recovery discovery
// stops treating genuinely-finished work as an active reattach target.
//
// Ownership discipline (hard boundary, mirrors this module's #167 stance):
//   - classification reuses the SAME canonical invariant as recovery discovery
//     (canonicalTaskActivityVerdict, #160 liveness) — one source, no drift;
//   - a session is mutated ONLY on POSITIVE proof: the control-loop ledger tail
//     is a canonical BLOCKED decision AND the executor is proven inactive (no
//     record, or a terminal/pid-gone/pid-reused liveness). Anything UNKNOWN /
//     unprovable / merely-EXITED-without-a-loop-decision is NEVER terminalized
//     (auto-terminalizing UNKNOWN or a resumable admission is forbidden);
//   - the write goes through parkStaleSession (the runtime-sandbox ownership-
//     safe terminal-state seam): the authoritative mutationOwner is structurally
//     preserved (a stale owner is left as historical evidence on the now-terminal
//     attempt, never released), a live Human Gate is refused, and the operation is
//     idempotent (a replay finds the session already terminal -> NO-OP);
//   - it never kills a process, never revives anything, never fabricates an
//     ExecutionRecord, never touches a live executor, and never becomes a second
//     lifecycle authority.
//
// Dry-run by default (apply=false): produces the before/after classification and
// `wouldMutate` per session with ZERO writes. Mutations happen ONLY when the
// caller passes apply=true.
const PROVEN_INACTIVE_LIVENESS = new Set(['EXITED', 'FAILED', 'STOPPED', 'INTERRUPTED', 'PID_REUSED']);

function readLoopTail({ stateDir, identityHash: id }) {
  const p = path.join(path.resolve(stateDir), 'control-loop', id, 'transitions.jsonl');
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return null; } // absent ledger -> no loop decision
  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const rec = JSON.parse(lines[i]);
      if (rec && typeof rec.to === 'string') return rec.to;
    } catch { /* torn trailing line: keep scanning backwards */ }
  }
  return null;
}

function classifyStaleSession({ stateDir, session, isAlive, readStartTime }) {
  const id = (typeof session.identityHash === 'string' && session.identityHash)
    ? session.identityHash
    : identityHash({ repo: session.repo, issueNumber: session.issueNumber });
  let execution = null;
  try {
    const r = readExecutionRecord({ stateDir, repo: session.repo, issueNumber: session.issueNumber });
    if (r.ok) execution = r.record;
  } catch { execution = null; }
  const deps = {};
  if (typeof isAlive === 'function') deps.isAlive = isAlive;
  if (typeof readStartTime === 'function') deps.readStartTime = readStartTime;
  const liveness = execution ? (reconcileExecutorLiveness(execution, deps).liveness || 'UNKNOWN') : 'NONE';
  const verdict = canonicalTaskActivityVerdict({ session, execution, isAlive, readStartTime });
  const loopTail = id ? readLoopTail({ stateDir, identityHash: id }) : null;
  const provenInactive = !execution || PROVEN_INACTIVE_LIVENESS.has(liveness);

  let classification; let proposedAction = 'NONE'; let reason;
  if (verdict.verdict === 'TERMINAL') {
    classification = 'TERMINAL'; reason = 'session already terminal';
  } else if (verdict.active) {
    classification = 'ACTIVE'; reason = verdict.reason.toLowerCase();
  } else if (loopTail === 'BLOCKED' && provenInactive) {
    classification = 'STALE_RECONCILABLE'; proposedAction = 'PARK_BLOCKED'; reason = 'control-loop BLOCKED tail + executor proven inactive';
  } else if (verdict.verdict === 'PARKED') {
    classification = 'PARKED'; reason = verdict.reason.toLowerCase(); // e.g. executor gone, no loop terminal decision -> not recovery-active, never mutated
  } else {
    classification = 'UNKNOWN'; reason = verdict.reason.toLowerCase(); // fail-closed: never mutated
  }
  return { identityHash: id, classification, proposedAction, reason, loopTail, liveness, executionPresent: !!execution, verdict };
}

export function reconcileStaleSessions({
  stateDir, apply = false, repo = null, isAlive, readStartTime, clock = Date.now,
  park = parkStaleSession,
} = {}) {
  if (typeof stateDir !== 'string' || !stateDir) return { ok: false, reason: 'STATE_DIR_REQUIRED' };
  const dir = path.join(path.resolve(stateDir), 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { names = []; }
  const rows = [];
  let mutated = 0;
  for (const name of names) {
    const sessionPath = path.join(dir, name);
    const rs = readSessionRecord(sessionPath);
    if (!rs.ok || !rs.session || typeof rs.session !== 'object') {
      rows.push({ file: name, issueNumber: null, classification: 'UNKNOWN', proposedAction: 'NONE', wouldMutate: false, reason: `session_unreadable:${rs.reason || 'unknown'}`, state: null });
      continue;
    }
    const s = rs.session;
    if (repo && normalizeRemoteUrl(s.repo || '').toLowerCase() !== normalizeRemoteUrl(repo).toLowerCase()) continue; // foreign repo untouched
    const c = classifyStaleSession({ stateDir, session: s, isAlive, readStartTime });
    const row = {
      file: name,
      repo: s.repo ?? null,
      issueNumber: s.issueNumber ?? null,
      identityHash: c.identityHash,
      sessionState: s.state ?? null,
      loopTail: c.loopTail,
      executionLiveness: c.liveness,
      executionPresent: c.executionPresent,
      promotedExecutor: s.executionMode === 'executor',
      mutationOwner: (s.mutationOwner && s.mutationOwner.laneId) || null,
      classification: c.classification,
      proposedAction: c.proposedAction,
      reason: c.reason,
      wouldMutate: apply === true && c.proposedAction === 'PARK_BLOCKED',
      before: s.state ?? null,
    };
    if (apply === true && c.proposedAction === 'PARK_BLOCKED') {
      const parked = park({ sessionPath, state: 'BLOCKED', reason: `reconcile:${c.reason}` });
      row.parkResult = parked.ok ? (parked.parked ? 'PARKED' : 'ALREADY_TERMINAL') : (parked.reason || 'PARK_FAILED');
      row.after = parked.ok ? parked.state : s.state;
      if (parked.ok && parked.parked) mutated += 1;
    } else {
      row.after = s.state ?? null;
    }
    rows.push(row);
  }
  const counts = rows.reduce((acc, x) => ({ ...acc, [x.classification]: (acc[x.classification] || 0) + 1 }), {});
  const evidence = {
    schemaVersion: RECOVERY_EVIDENCE_SCHEMA_VERSION,
    kind: 'StaleSessionReconcile',
    at: new Date(clock()).toISOString(),
    apply: apply === true,
    repo: repo ? normalizeRemoteUrl(repo) : null,
    scanned: rows.length,
    mutated,
    counts,
    results: rows,
    secondLifecycleOwner: false,
    executorMutation: false,
  };
  return { ok: true, evidence, dryRun: apply !== true, mutated };
}
