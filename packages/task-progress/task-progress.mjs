#!/usr/bin/env node
// task-progress.mjs — Soc_brain executor progress telemetry (P1-0, Issue #90).
//
// Ownership rule (hard invariant): executor progress is SUBORDINATE telemetry.
// The canonical task FSM (runtime-sandbox session record) stays the single
// source of truth. This module:
//   - NEVER mutates the canonical session record or any FSM state;
//   - NEVER emits TASK_COMPLETED or any NOTIFIABLE_EVENTS lifecycle event;
//   - NEVER derives authority from the worktree — the projection re-reads the
//     authoritative session record at its canonical control-plane location.
//
// Updates are keyed by (identityHash, executorId, executionEpoch), so a crashed
// /restarted executor or a replaced executor (Cline -> OpenCode -> ...) re-binds
// cleanly; the model is never locked into one executor kind.
//
// Deterministic update semantics (ordering uses Soc_brain's OWN receipt clock —
// never the executor's wall clock):
//   - HIGHER executionEpoch (restart/replacement): the new executor's declared
//     plan REPLACES the projection; the prior record is preserved in the
//     append-only <id>.jsonl history (evidence, not loss).
//   - LOWER epoch: rejected OUT_OF_ORDER_EXECUTION_EPOCH.
//   - SAME epoch: monotonic patch — currentStep may not decrease; a step may
//     not move backward (IN_PROGRESS->PENDING, BLOCKED->PENDING, COMPLETED->*).
//   - malformed payload, wrong identity binding or terminal canonical state:
//     fail-closed, never applied.
//
// ponytail: dependency-free hand-rolled validation mirroring reverse-dispatch
// house style; add a schema library only if the envelope grows past ~10 fields.

import fs from 'node:fs';
import path from 'node:path';
import { readSessionRecord, sessionPathFor } from '../runtime-sandbox/runtime-sandbox.mjs';
import { identityHash } from '../workspace/workspace.mjs';

export const PROGRESS_SCHEMA_VERSION = '1';

// Subordinate step telemetry states (distinct from canonical FSM states).
export const STEP_STATUSES = Object.freeze(['PENDING', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED']);

// Projection markers (Issue #90 UX shape).
export const PROGRESS_MARKER = Object.freeze({
  COMPLETED: '✓',
  IN_PROGRESS: '▶',
  PENDING: '○',
  BLOCKED: '⊗',
});

const TOTAL_STEPS_MAX = 100;
const NAME_MAX_CHARS = 200;
const MESSAGE_MAX_CHARS = 500;
const EXECUTOR_ID_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

export function progressDirFor({ stateDir } = {}) {
  return path.join(path.resolve(stateDir), 'task-progress');
}

function recordPathFor({ stateDir, identityHash: id }) {
  return path.join(progressDirFor({ stateDir }), `${id}.json`);
}

function historyPathFor({ stateDir, identityHash: id }) {
  return path.join(progressDirFor({ stateDir }), `${id}.jsonl`);
}

// ---- validation ---------------------------------------------------------------

function stepTransitionAllowed(prev, next) {
  if (prev === next) return true;
  if (prev === 'PENDING') return true; // PENDING is the bottom state
  if (prev === 'IN_PROGRESS') return next === 'BLOCKED' || next === 'COMPLETED';
  if (prev === 'BLOCKED') return next === 'IN_PROGRESS' || next === 'COMPLETED';
  return false; // COMPLETED is terminal
}

// Returns { ok:true } or { ok:false, code, field?, detail? } — fail-closed.
export function validateProgressUpdate(update) {
  if (!update || typeof update !== 'object' || Array.isArray(update)) {
    return { ok: false, code: 'PROGRESS_MALFORMED' };
  }
  for (const f of ['repo', 'issueNumber', 'executorId', 'executionEpoch', 'currentStep', 'totalSteps', 'steps']) {
    if (update[f] === undefined || update[f] === null) {
      return { ok: false, code: 'MISSING_FIELD', field: f };
    }
  }
  if (typeof update.repo !== 'string' || !update.repo.trim()) {
    return { ok: false, code: 'FIELD_INVALID', field: 'repo' };
  }
  const n = Number(update.issueNumber);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, code: 'FIELD_INVALID', field: 'issueNumber' };
  if (typeof update.executorId !== 'string' || !EXECUTOR_ID_RE.test(update.executorId)) {
    return { ok: false, code: 'FIELD_INVALID', field: 'executorId', message: '1..128 chars [A-Za-z0-9._:@-]' };
  }
  const epoch = Number(update.executionEpoch);
  if (!Number.isInteger(epoch) || epoch < 1) {
    return { ok: false, code: 'FIELD_INVALID', field: 'executionEpoch', message: 'integer >= 1' };
  }
  const total = Number(update.totalSteps);
  if (!Number.isInteger(total) || total < 1 || total > TOTAL_STEPS_MAX) {
    return { ok: false, code: 'FIELD_INVALID', field: 'totalSteps', message: `integer 1..${TOTAL_STEPS_MAX}` };
  }
  const current = Number(update.currentStep);
  if (!Number.isInteger(current) || current < 1 || current > total) {
    return { ok: false, code: 'CURRENT_STEP_OUT_OF_RANGE', field: 'currentStep', detail: { currentStep: current, totalSteps: total } };
  }
  if (!Array.isArray(update.steps) || update.steps.length !== total) {
    return { ok: false, code: 'FIELD_INVALID', field: 'steps', message: `steps must list exactly totalSteps (${total}) entries` };
  }
  const seen = new Set();
  const steps = [];
  for (const s of update.steps) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      return { ok: false, code: 'FIELD_INVALID', field: 'steps', message: 'each step must be an object' };
    }
    const idx = Number(s.index);
    if (!Number.isInteger(idx) || idx < 1 || idx > total || seen.has(idx)) {
      return { ok: false, code: 'FIELD_INVALID', field: 'steps', message: `step index must be unique 1..${total}` };
    }
    seen.add(idx);
    if (typeof s.name !== 'string' || !s.name.trim() || s.name.length > NAME_MAX_CHARS) {
      return { ok: false, code: 'FIELD_INVALID', field: 'steps', message: `step name 1..${NAME_MAX_CHARS} chars` };
    }
    if (!STEP_STATUSES.includes(s.status)) {
      return { ok: false, code: 'FIELD_INVALID', field: 'steps.status', detail: s.status };
    }
    steps.push({ index: idx, name: s.name, status: s.status });
  }
  if (update.message !== undefined && update.message !== null
    && (typeof update.message !== 'string' || update.message.length > MESSAGE_MAX_CHARS)) {
    return { ok: false, code: 'FIELD_INVALID', field: 'message', message: `<= ${MESSAGE_MAX_CHARS} chars` };
  }
  return { ok: true, value: { steps } };
}

// ---- persistence (progress telemetry ONLY — never the canonical session) ------

// Missing file -> { ok:true, progress:null }; unparsable -> fail-closed.
export function readProgressRecord({ stateDir, identityHash: id } = {}) {
  if (!stateDir || !id) return { ok: false, code: 'PROGRESS_RECORD_MALFORMED_REQUEST' };
  const p = recordPathFor({ stateDir, identityHash: id });
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, progress: null, path: p };
    return { ok: false, code: 'PROGRESS_RECORD_UNREADABLE', detail: String((e && e.message) || e) };
  }
  try {
    const progress = JSON.parse(raw);
    if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
      return { ok: false, code: 'PROGRESS_RECORD_CORRUPT', path: p };
    }
    return { ok: true, progress, path: p };
  } catch {
    return { ok: false, code: 'PROGRESS_RECORD_CORRUPT', path: p };
  }
}

function writeProgressRecordAtomic(p, progress) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(progress, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, p);
}

function appendHistory(p, entry) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch { return false; } // history is telemetry; the record itself is the projection authority
}

// ---- update ---------------------------------------------------------------------
// Applies ONE executor progress update. Returns the applied record; never
// touches the session record and never dispatches lifecycle events.
export function applyTaskProgressUpdate({ stateDir, update, now = () => new Date().toISOString() } = {}) {
  if (typeof stateDir !== 'string' || !stateDir.trim()) {
    return { ok: false, code: 'PROGRESS_MALFORMED_REQUEST', field: 'stateDir' };
  }
  stateDir = path.resolve(stateDir);
  const v = validateProgressUpdate(update);
  if (!v.ok) return v;
  const u = update;

  const id = identityHash({ repo: u.repo, issueNumber: Number(u.issueNumber) });
  if (!id) return { ok: false, code: 'IDENTITY_UNSTABLE' };

  // Binding: progress is only meaningful for a live canonical session at its
  // canonical control-plane location (readSessionRecord re-derives identity).
  const rs = readSessionRecord(sessionPathFor({ stateDir, identityHash: id }));
  if (!rs.ok) return { ok: false, code: 'SESSION_UNBOUND', detail: rs.reason ?? null };
  const session = rs.session;
  if (session.state === 'COMPLETED' || session.state === 'FAILED' || session.state === 'BLOCKED') {
    return { ok: false, code: 'SESSION_TERMINAL', state: session.state };
  }

  const prev = readProgressRecord({ stateDir, identityHash: id });
  if (!prev.ok) return prev;
  const prior = prev.progress;
  const epoch = Number(u.executionEpoch);

  if (prior) {
    const prevEpoch = Number(prior.executionEpoch);
    if (Number.isInteger(prevEpoch) && epoch < prevEpoch) {
      return { ok: false, code: 'OUT_OF_ORDER_EXECUTION_EPOCH', detail: { got: epoch, current: prevEpoch } };
    }
    if (epoch === prevEpoch) {
      const prevCurrent = Number(prior.currentStep);
      if (Number.isInteger(prevCurrent) && Number(u.currentStep) < prevCurrent) {
        return { ok: false, code: 'OUT_OF_ORDER_STEP', detail: { got: Number(u.currentStep), current: prevCurrent } };
      }
      const priorSteps = new Map((prior.steps || []).map((s) => [s.index, s.status]));
      for (const s of v.value.steps) {
        const before = priorSteps.get(s.index);
        if (before && !stepTransitionAllowed(before, s.status)) {
          return { ok: false, code: 'STEP_BACKWARD', detail: { index: s.index, from: before, to: s.status } };
        }
      }
    }
  }

  const record = {
    schemaVersion: PROGRESS_SCHEMA_VERSION,
    identityHash: id,
    taskId: session.taskId ?? `${session.repo}#${session.issueNumber}`,
    repo: session.repo,
    issueNumber: session.issueNumber,
    executorId: u.executorId,
    executorKind: typeof u.executorKind === 'string' && u.executorKind.trim() ? u.executorKind : null,
    executionEpoch: epoch,
    currentStep: Number(u.currentStep),
    totalSteps: Number(u.totalSteps),
    steps: v.value.steps.slice().sort((a, b) => a.index - b.index),
    message: typeof u.message === 'string' && u.message.trim() ? u.message : null,
    updatedAt: now(),
    updatedBy: u.executorId,
    updateCount: prior && Number.isInteger(prior.updateCount) ? prior.updateCount + 1 : 1,
  };

  const rp = recordPathFor({ stateDir, identityHash: id });
  try { writeProgressRecordAtomic(rp, record); } catch (e) {
    return { ok: false, code: 'PROGRESS_RECORD_UNWRITABLE', detail: String((e && e.message) || e) };
  }
  const historyAppendOk = appendHistory(historyPathFor({ stateDir, identityHash: id }), {
    at: record.updatedAt, kind: prior && epoch === Number(prior.executionEpoch) ? 'PATCH' : 'EPOCH_BUMP',
    executionEpoch: epoch, currentStep: record.currentStep, executorId: u.executorId,
  });
  return { ok: true, progress: record, path: rp, historyAppendOk, priorRecordReplaced: Boolean(prior) };
}

// ---- projection -----------------------------------------------------------------
// Read-only render. NEVER writes anything and NEVER derives a lifecycle state:
// the Canonical line is the authoritative session state verbatim; the Progress
// block is subordinate executor telemetry.
export function renderTaskProgress({ stateDir, sessionPath = null, identityHash: id = null } = {}) {
  if (!stateDir || (!sessionPath && !id)) {
    return { ok: false, code: 'PROJECTION_MALFORMED_REQUEST' };
  }
  let sid = id;
  let session = null;
  if (sessionPath) {
    const rs = readSessionRecord(sessionPath);
    if (!rs.ok) return { ok: false, code: 'SESSION_UNBOUND', detail: rs.reason ?? null };
    session = rs.session;
    sid = identityHash({ repo: session.repo, issueNumber: session.issueNumber });
  } else {
    const rs = readSessionRecord(sessionPathFor({ stateDir: path.resolve(stateDir), identityHash: sid }));
    if (rs.ok) session = rs.session;
  }
  if (!sid) return { ok: false, code: 'IDENTITY_UNSTABLE' };

  const lines = [];
  lines.push(`Task: Issue #${session ? session.issueNumber : '?'}`);
  // Canonical lifecycle state comes ONLY from the session record (or an explicit
  // NO_SESSION marker when unbound) — never from executor progress.
  lines.push(`Canonical: ${session ? session.state : 'NO_SESSION'}`);
  lines.push('');
  lines.push('Progress:');

  const pr = readProgressRecord({ stateDir: path.resolve(stateDir), identityHash: sid });
  if (!pr.ok) return { ok: false, code: pr.code, detail: pr.detail ?? null };
  if (!pr.progress) {
    lines.push('NO_PROGRESS_TELEMETRY');
    return { ok: true, text: lines.join('\n'), canonicalState: session ? session.state : 'NO_SESSION', progress: null };
  }
  const p = pr.progress;
  for (const s of p.steps) {
    lines.push(`${PROGRESS_MARKER[s.status] || '·'} Bước ${s.index}/${p.totalSteps} — ${s.name}`);
  }
  if (p.message) lines.push('');
  if (p.message) lines.push(p.message);
  lines.push('');
  lines.push(`Executor: ${p.executorId}${p.executorKind ? ` (${p.executorKind})` : ''} · epoch ${p.executionEpoch} · updatedAt ${p.updatedAt}`);
  return { ok: true, text: lines.join('\n'), canonicalState: session ? session.state : 'NO_SESSION', progress: p };
}

