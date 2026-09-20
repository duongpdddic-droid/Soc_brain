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
import {
  HUMAN_GATE_STATES,
  readSessionRecord,
  sessionPathFor,
} from '../runtime-sandbox/runtime-sandbox.mjs';
import { IDENTITY_HASH_LENGTH } from '../workspace/workspace.mjs';
import {
  appendTerminalEvidence, executionRecordPath, readExecutionRecord, startExecution,
} from './executor-launcher.mjs';
import { reconcileExecutorLiveness } from './executor-reconcile.mjs';
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


/**
 * Issue #194 — resume one exact SESSION_ACTIVE task after its previous
 * executor incarnation has finalized and is proven gone.
 */
export function resumeFinalizedExecution({
  stateDir,
  identityHash,
  repo,
  controlCwd = process.cwd(),
  instruction,
  model = null,
  isAlive,
  readStartTime,
  start = startExecution,
} = {}) {
  if (typeof stateDir !== 'string' || !stateDir) {
    return { ok: false, reason: 'STATE_DIR_REQUIRED' };
  }
  if (typeof identityHash !== 'string' || !identityHash) {
    return { ok: false, reason: 'IDENTITY_HASH_REQUIRED' };
  }
  if (typeof instruction !== 'string' || !instruction.trim()) {
    return { ok: false, reason: 'CONTINUATION_INSTRUCTION_REQUIRED' };
  }

  const sp = sessionPathFor({ stateDir, identityHash });
  const rs = readSessionRecord(sp);
  if (!rs.ok) {
    return {
      ok: false,
      reason: 'SESSION_AUTHORITY_UNAVAILABLE',
      detail: rs.reason,
    };
  }

  const s = rs.session;
  // Chặn Human Gate fail-closed trước khi kiểm tra SESSION_ACTIVE
  const gate = s.humanGate ?? null;
  if (
    HUMAN_GATE_STATES.includes(s.state) ||
    (gate && gate.state !== 'ANSWERED')
  ) {
    return {
      ok: false,
      reason: 'HUMAN_GATE_ACTIVE',
      detail: gate?.state ?? s.state,
    };
  }
  if (s.identityHash !== identityHash) {
    return {
      ok: false,
      reason: 'SESSION_NOT_RESUMABLE',
      detail: s.state ?? null,
    };
  }

  if (s.state !== 'SESSION_ACTIVE') {
    return {
      ok: false,
      reason: 'SESSION_NOT_RESUMABLE',
      detail: s.state ?? null,
    };
  }

  const normalizedRepo = normalizeRemoteUrl(repo || s.repo || '');
  if (
    !normalizedRepo ||
    normalizedRepo.toLowerCase() !==
      normalizeRemoteUrl(s.repo || '').toLowerCase()
  ) {
    return { ok: false, reason: 'SESSION_IDENTITY_MISMATCH' };
  }

  const rr = readExecutionRecord({
    stateDir,
    repo: s.repo,
    issueNumber: s.issueNumber,
  });
  if (!rr.ok || rr.record.identityHash !== identityHash) {
    return {
      ok: false,
      reason: 'EXECUTION_RECORD_IDENTITY_MISMATCH',
      detail: rr.reason ?? null,
    };
  }

  const prior = rr.record;

  if (prior.finalized !== true || !prior.terminalStatus) {
    return {
      ok: false,
      reason: 'PRIOR_EXECUTION_NOT_FINALIZED',
    };
  }

  const live = reconcileExecutorLiveness({ pid: prior.pid, processStartTime: prior.processStartTime }, {
    isAlive,
    readStartTime,
  });

  if (
    live.liveness === 'PID_REUSED' ||
    live.liveness === 'OWNERSHIP_UNKNOWN' ||
    live.liveness === 'STALE_CHILD'
  ) {
    return {
      ok: false,
      reason: 'RECOVERY_IDENTITY_UNPROVEN',
      detail: live.reason,
    };
  }

  if (live.liveness !== 'EXITED') {
    return {
      ok: false,
      reason: 'PRIOR_EXECUTOR_NOT_PROVEN_GONE',
      detail: live.reason,
      pid: prior.pid ?? null,
    };
  }

  if (
    typeof s.worktreePath !== 'string' ||
    !s.worktreePath ||
    path.resolve(s.worktreePath) !== path.resolve(prior.worktreePath || '')
  ) {
    return {
      ok: false,
      reason: 'WORKTREE_BINDING_MISMATCH',
    };
  }

  const leaseToken = s.lease?.token;
  if (typeof leaseToken !== 'string' || !leaseToken) {
    return {
      ok: false,
      reason: 'SESSION_AUTHORITY_UNAVAILABLE',
      detail: 'LEASE_TOKEN_MISSING',
    };
  }

  const binding = {
    identityHash: s.identityHash,
    taskId: s.taskId,
    repo: s.repo,
    issueNumber: s.issueNumber,
    baseSha: s.baseSha,
    branch: s.branch,
    path: s.worktreePath,
  };

  return start({
    sessionPath: sp,
    session: { leaseToken },
    binding,
    instruction,
    model,
    stateDir,
    controlCwd,
    isAlive,
  });
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
