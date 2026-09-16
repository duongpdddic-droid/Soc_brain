#!/usr/bin/env node
// follow-snapshot.mjs — the SINGLE durable operational reader shared by every
// consumer (client-control get_task/get_progress/follow/recover AND the OpenCode
// attached-observability plugin). It composes the canonical durable facts and the
// pure computeEffectiveState so the effective state can never diverge between the
// MCP surface and the actual OpenCode UI.
//
// Read-only: it mutates no lifecycle, mints no task/execution/owner, answers no
// gate, and carries no verdict. It reuses the authoritative primitives (#160
// reconcileExecutorLiveness, control-loop ledger, task-progress telemetry,
// execution record) — never a parallel store.

import fs from 'node:fs';
import path from 'node:path';
import { identityHash } from '../workspace/workspace.mjs';
import { readSessionRecord, sessionPathFor, HUMAN_GATE_STATES } from '../runtime-sandbox/runtime-sandbox.mjs';
import { readProgressRecord } from '../task-progress/task-progress.mjs';
import { readExecutionRecord } from '../executor-launcher/executor-launcher.mjs';
import { reconcileExecutorLiveness } from '../executor-launcher/executor-reconcile.mjs';
import { computeEffectiveState, buildOperationalView } from './effective-state.mjs';

function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Append-only control-loop ledger tail reader — MIRRORS control-loop#readTransitions
// (same path + tolerant line parse) but inlined so the OpenCode plugin does not
// import the whole control-loop graph (delivery/gemini/telegram) into the client
// process. Canonical ledger stays the sole source; this only reads it.
function readLedgerTail(stateDir, id) {
  const fp = path.join(path.resolve(stateDir), 'control-loop', id, 'transitions.jsonl');
  let raw = '';
  try { raw = fs.readFileSync(fp, 'utf8'); } catch { return { position: 0, currentStep: 'ACCEPTED', history: [] }; }
  const recs = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const tail = recs.length ? recs[recs.length - 1] : null;
  return { position: recs.length, currentStep: tail ? tail.to : 'ACCEPTED', history: recs.map((t) => ({ from: t.from, to: t.to, reason: t.reason ?? null, at: t.ts ?? null })).slice(-20) };
}

// Resolve the canonical session for {repo, issueNumber}; fail-closed (never a
// parallel record). Returns { ok, identityHash, session } or { ok:false, reason }.
export function resolveCanonical({ stateDir, repo, issueNumber }) {
  const id = identityHash({ repo, issueNumber });
  if (!id) return { ok: false, reason: 'IDENTITY_UNSTABLE' };
  const sp = sessionPathFor({ stateDir, identityHash: id });
  const rs = readSessionRecord(sp);
  if (!rs.ok) return { ok: false, reason: rs.reason === 'SESSION_NOT_FOUND' ? 'TASK_NOT_FOUND' : (rs.reason || 'SESSION_UNBOUND'), identityHash: id };
  return { ok: true, identityHash: id, sessionPath: sp, session: rs.session };
}

// The unified operational view. If `identityHash` is given it is the pinned
// identity (recover/follower resume path). All reads are tolerant (missing
// evidence -> null/pending), never a fabricated fact.
export function operationalView({ stateDir, repo, issueNumber, isAlive = defaultIsAlive, readStartTime = null, now = () => new Date().toISOString() } = {}) {
  const r = resolveCanonical({ stateDir, repo, issueNumber });
  if (!r.ok) return r;
  const { identityHash: id, session } = r;

  let loop = { position: 0, currentStep: 'ACCEPTED', history: [] };
  try {
    loop = readLedgerTail(stateDir, id);
  } catch { loop = { position: 0, currentStep: 'ACCEPTED', history: [] }; }

  let progress = null;
  try {
    const pr = readProgressRecord({ stateDir, identityHash: id });
    if (pr.ok && pr.progress) progress = { currentStep: pr.progress.currentStep ?? null, totalSteps: pr.progress.totalSteps ?? null, executorId: pr.progress.executorId ?? null, executionEpoch: pr.progress.executionEpoch ?? null, steps: Array.isArray(pr.progress.steps) ? pr.progress.steps : [], message: pr.progress.message ?? null, updatedAt: pr.progress.updatedAt ?? null };
  } catch { progress = null; }

  let execution = null;
  try {
    const rec = readExecutionRecord({ stateDir, repo: session.repo, issueNumber: session.issueNumber });
    if (rec.ok) {
      const deps = { isAlive };
      if (typeof readStartTime === 'function') deps.readStartTime = readStartTime;
      const live = reconcileExecutorLiveness(rec.record, deps);
      execution = { status: rec.record.terminalStatus || live.liveness, liveness: live.liveness, identityProven: live.identityProven, pid: rec.record.pid ?? null, processStartTime: rec.record.processStartTime ?? null, identityHash: rec.record.identityHash ?? null };
    }
  } catch { execution = null; }

  const effective = computeEffectiveState({ session, execution, loop, progress });
  const operational = buildOperationalView({ session, identityHash: id, execution, loop, progress, effective });
  return { ok: true, identityHash: id, sessionPath: r.sessionPath, session, loop, progress, execution, effective, operational, humanActionRequired: HUMAN_GATE_STATES.includes(session.state) || effective.humanActionRequired === true, at: now() };
}
