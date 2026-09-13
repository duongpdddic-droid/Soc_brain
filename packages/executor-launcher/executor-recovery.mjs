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
import { readSessionRecord, sessionPathFor } from '../runtime-sandbox/runtime-sandbox.mjs';
import { IDENTITY_HASH_LENGTH } from '../workspace/workspace.mjs';
import {
  appendTerminalEvidence, executionRecordPath, readExecutionRecord,
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

function result({ record, classification, action, reason, detail = null, proof = null, status = null }) {
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
      appendTerminalEvidence({
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
      return { record: rb.record, outcome: 'REAPED', classification: 'EXITED', status: 'INTERRUPTED', proof: live.reason };
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
  const dir = path.join(path.resolve(stateDir), 'executions');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { names = []; }
  const results = [];
  for (const name of names) {
    const identityHash = identityFromFilename(name);
    if (!identityHash) continue;
    const r = inspectOne({ stateDir, identityHash, repo, controlCwd, reap, isAlive, readStartTime, clock });
    if (r.record) results.push(result({
      record: r.record,
      classification: r.classification,
      action: r.outcome,
      reason: r.reason ?? r.outcome,
      detail: r.detail ?? null,
      proof: r.proof ?? null,
      status: r.status ?? null,
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
  try {
    const p = persistRecoveryEvidence({ stateDir, evidence });
    return { ok: true, evidencePath: p, evidence };
  } catch (e) {
    return { ok: false, reason: 'RECOVERY_EVIDENCE_PERSIST_FAILED', detail: String(e.message || e), evidence };
  }
}
