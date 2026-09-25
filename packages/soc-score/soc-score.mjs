#!/usr/bin/env node
// soc-score.mjs — Soc_brain: minimal task-phase telemetry (Soc_Score v0).
//
// Purpose: measure where task wall time is spent so the upcoming autonomous
// OpenCode E2E produces actionable phase timing. Reuses the existing Soc_brain
// state directory layout (`<stateDir>/sessions/...` lives there; we add a sibling
// `telemetry/<identityHash>.jsonl` stream) and the existing identity hash from
// packages/workspace. Does NOT participate in the Task FSM, never mutates the
// session record, and never throws into a caller (telemetry failure is logged
// and recorded as `lastError` for diagnostics; the caller continues).
//
// Storage layout (additive — never overwrites, never collides with sessions):
//   <stateDir>/telemetry/<identityHash>.jsonl         — append-only event stream
//   <stateDir>/telemetry/<identityHash>.summary.json  — derived per-task summary
//
// Schema is forward-extensible: every event carries the minimum required
// identity (taskId, repo, issueNumber, executor, t). New event names are
// accepted without schema bumps; the duration calculator only derives from
// the minimum event set. `unattributedTime` is always computed and is always
// visible — never forced into known phases.

import path from 'node:path';
import fs from 'node:fs';

// Minimum event set required by the Soc_Score v0 contract. Additive: unknown
// event names are accepted (and recorded) so future phases can be added
// without touching this file. The duration calculator derives ONLY from this
// fixed set.
export const MINIMUM_EVENTS = Object.freeze([
  'TASK_STARTED',
  'WORKTREE_READY',
  'EXECUTOR_STARTED',
  'EXECUTOR_FINISHED',
  'VERIFY_STARTED',
  'VERIFY_FINISHED',
  'REVIEW_STARTED',
  'REVIEW_FINISHED',
  'GITHUB_STARTED',
  'GITHUB_FINISHED',
  'HUMAN_GATE_STARTED',
  'HUMAN_GATE_RESOLVED',
  'TASK_FINISHED',
]);

// Known phase boundaries derived from MINIMUM_EVENTS. Each entry pairs a
// `*_STARTED` event with its matching `*_FINISHED` event. Phase duration is
// computed as `max(0, finished.t - started.t)` and is added to `totalWallTime`
// only on the started event (no double-counting on the finished event).
const KNOWN_PHASES = Object.freeze([
  { name: 'worktreeTime',     start: 'WORKTREE_READY',     end: 'EXECUTOR_STARTED' },
  { name: 'executorTime',     start: 'EXECUTOR_STARTED',   end: 'EXECUTOR_FINISHED' },
  { name: 'verificationTime', start: 'VERIFY_STARTED',     end: 'VERIFY_FINISHED' },
  { name: 'reviewTime',       start: 'REVIEW_STARTED',     end: 'REVIEW_FINISHED' },
  { name: 'githubTime',       start: 'GITHUB_STARTED',     end: 'GITHUB_FINISHED' },
  { name: 'humanWaitTime',    start: 'HUMAN_GATE_STARTED', end: 'HUMAN_GATE_RESOLVED' },
]);

export const SOC_SCORE_SCHEMA_VERSION = '1';

// Resolve the telemetry directory for a given state root. Sibling to
// `sessions/` so it lives outside every worktree (matches the runtime-sandbox
// authority model). Pure path helper; never touches the filesystem.
export function telemetryDirFor({ stateDir }) {
  if (typeof stateDir !== 'string' || !stateDir) {
    throw new TypeError('telemetryDirFor: stateDir must be a non-empty string.');
  }
  return path.join(path.resolve(stateDir), 'telemetry');
}

// JSONL path for a single identity. Deterministic — same identity always
// writes to the same file (append-only, never truncated by the recorder).
export function eventsPathFor({ stateDir, identityHash }) {
  if (typeof identityHash !== 'string' || !identityHash) {
    throw new TypeError('eventsPathFor: identityHash must be a non-empty string.');
  }
  return path.join(telemetryDirFor({ stateDir }), `${identityHash}.jsonl`);
}

// Summary path for a single identity. Written exactly once on `finalize()`.
export function summaryPathFor({ stateDir, identityHash }) {
  if (typeof identityHash !== 'string' || !identityHash) {
    throw new TypeError('summaryPathFor: identityHash must be a non-empty string.');
  }
  return path.join(telemetryDirFor({ stateDir }), `${identityHash}.summary.json`);
}
// Validate the recorder identity. Fail-closed at construction: an unusable
// identity (missing fields) produces a non-throwing error result so the
// recorder can return `{ ok: false, reason, errors }` to the caller instead
// of poisoning the FSM with an exception.
function validateIdentity(identity) {
  const errors = [];
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    return { ok: false, errors: [{ reason: 'IDENTITY_INVALID', detail: 'identity must be a plain object.' }] };
  }
  if (typeof identity.identityHash !== 'string' || !identity.identityHash) {
    errors.push({ reason: 'IDENTITY_HASH_MISSING', detail: 'identity.identityHash is required.' });
  }
  if (typeof identity.taskId !== 'string' || !identity.taskId) {
    errors.push({ reason: 'TASK_ID_MISSING', detail: 'identity.taskId is required.' });
  }
  if (typeof identity.repo !== 'string' || !identity.repo) {
    errors.push({ reason: 'REPO_MISSING', detail: 'identity.repo is required.' });
  }
  if (!Number.isInteger(identity.issueNumber) || identity.issueNumber <= 0) {
    errors.push({ reason: 'ISSUE_NUMBER_INVALID', detail: 'identity.issueNumber must be a positive integer.' });
  }
  if (typeof identity.executor !== 'string' || !identity.executor) {
    errors.push({ reason: 'EXECUTOR_MISSING', detail: 'identity.executor is required.' });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true };
}
// Create a recorder bound to a single identity. Append-only, fail-closed:
// every public method returns a result object and never throws into the
// caller. `clock` is injectable for deterministic tests; default is Date.now.
//
// Usage:
//   const rec = createRecorder({ stateDir, identity, executor: 'cline' });
//   if (!rec.ok) { /* FSM stays untouched */ return; }
//   rec.record('TASK_STARTED');
//   rec.record('WORKTREE_READY');
//   ... run phases ...
//   rec.record('TASK_FINISHED');
//   const summary = rec.finalize();   // writes summary.json, returns it
export function createRecorder({ stateDir, identity, executor, clock } = {}) {
  const v = validateIdentity({ ...(identity || {}), executor });
  if (!v.ok) return { ok: false, reason: 'IDENTITY_INVALID', errors: v.errors };

  const id = {
    identityHash: identity.identityHash,
    taskId: identity.taskId,
    repo: identity.repo,
    issueNumber: identity.issueNumber,
    executor: executor || identity.executor,
  };
  const now = (typeof clock === 'function') ? clock : (() => Date.now());
  const dir = telemetryDirFor({ stateDir });
  const eventsFile = eventsPathFor({ stateDir, identityHash: id.identityHash });
  const summaryFile = summaryPathFor({ stateDir, identityHash: id.identityHash });

  let lastError = null;
  let inMemory = [];          // mirror of appended events for in-process reads
  let finalized = false;
function record(event, detail) {
    if (finalized) {
      lastError = { at: now(), reason: 'RECORDER_FINALIZED', detail: 'Cannot append after finalize().' };
      return { ok: false, reason: 'RECORDER_FINALIZED' };
    }
    if (typeof event !== 'string' || !event) {
      lastError = { at: now(), reason: 'EVENT_NAME_INVALID', detail: 'event must be a non-empty string.' };
      return { ok: false, reason: 'EVENT_NAME_INVALID' };
    }
    const line = {
      schemaVersion: SOC_SCORE_SCHEMA_VERSION,
      identityHash: id.identityHash,
      taskId: id.taskId,
      repo: id.repo,
      issueNumber: id.issueNumber,
      executor: id.executor,
      event,
      t: now(),
      detail: detail ?? null,
    };
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(eventsFile, `${JSON.stringify(line)}\n`, 'utf8');
    } catch (e) {
      // Fail-closed: never throw into the FSM path. Record + swallow.
      lastError = { at: now(), reason: 'TELEMETRY_WRITE_FAILED', detail: String((e && e.message) || e) };
      return { ok: false, reason: 'TELEMETRY_WRITE_FAILED', detail: lastError.detail };
    }
    inMemory.push(line);
    return { ok: true, line };
  }

  // Wrap a phase callback. Emits `<phase>_STARTED` before, `<phase>_FINISHED`
  // after (success OR failure). The wrapped callback may be sync or async;
  // both are awaited. Re-throws the original error AFTER recording FINISHED
  // so the caller still sees it.
  //
  // Phase names use the MINIMUM_EVENTS suffix convention: e.g. phaseName
  // 'EXECUTOR' -> STARTED='EXECUTOR_STARTED', FINISHED='EXECUTOR_FINISHED'.
  async function withPhase(phaseName, fn) {
    if (typeof phaseName !== 'string' || !phaseName) throw new TypeError('withPhase: phaseName required.');
    const started = `${phaseName}_STARTED`;
    const finished = `${phaseName}_FINISHED`;
    record(started);
    try {
      const out = await fn();
      record(finished, { ok: true });
      return out;
    } catch (e) {
      record(finished, { ok: false, error: String((e && e.message) || e) });
      throw e;
    }
  }

  function events() {
    // Return a defensive copy so callers cannot mutate the in-memory mirror.
    return inMemory.slice();
  }

  function finalize() {
    if (finalized) return { ok: false, reason: 'RECORDER_FINALIZED' };
    // Ensure the canonical TASK_FINISHED exists in the stream so totalWallTime
    // is anchored to a deterministic boundary. If the caller forgot it we add
    // a synthetic one using the recorder clock — never throws. NB: we flip
    // `finalized` to true AFTER the synthetic record so the recorder can
    // accept that one last write.
    if (!inMemory.some((e) => e.event === 'TASK_FINISHED')) {
      record('TASK_FINISHED', { synthetic: true });
    }
    finalized = true;
    const summary = computeSummary({ events: inMemory, identity: id });
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    } catch (e) {
      lastError = { at: now(), reason: 'SUMMARY_WRITE_FAILED', detail: String((e && e.message) || e) };
      return { ok: false, reason: 'SUMMARY_WRITE_FAILED', summary, detail: lastError.detail };
    }
    return { ok: true, summary, summaryPath: summaryFile };
  }

  return {
    ok: true,
    identity: id,
    eventsPath: eventsFile,
    summaryPath: summaryFile,
    record,
    withPhase,
    events,
    finalize,
    get lastError() { return lastError; },
    get finalized() { return finalized; },
  };
}
// Derive per-task durations deterministically from an event stream. Pure
// function (no IO) so it can be unit-tested without a filesystem.
//
// Determinism rule:
//   - `t` values are taken at face value (the recorder uses an injectable
//     clock in tests; production uses Date.now). No double-counting: each
//     known phase contributes its boundary duration exactly once.
//   - `totalWallTime` = `TASK_FINISHED.t - TASK_STARTED.t`. If either is
//     missing, totalWallTime = `max(t) - min(t)` over all events.
//   - `unattributedTime` = `max(0, totalWallTime - sum(known phases))`.
//     Always non-negative; always visible.
export function computeSummary({ events: rawEvents, identity } = {}) {
  const events = Array.isArray(rawEvents) ? rawEvents.slice().sort((a, b) => a.t - b.t) : [];
  const durations = {
    totalWallTime: 0,
    worktreeTime: 0,
    executorTime: 0,
    verificationTime: 0,
    reviewTime: 0,
    githubTime: 0,
    humanWaitTime: 0,
    unattributedTime: 0,
  };
  if (!events.length) {
    return {
      schemaVersion: SOC_SCORE_SCHEMA_VERSION,
      timeUnit: 'ms',
      identity: identity || null,
      eventCount: 0,
      durations,
      generatedAt: 0,
    };
  }
  const tStart = events.find((e) => e.event === 'TASK_STARTED');
  const tFinish = events.find((e) => e.event === 'TASK_FINISHED');
  if (tStart && tFinish) durations.totalWallTime = Math.max(0, tFinish.t - tStart.t);
  else durations.totalWallTime = Math.max(0, events[events.length - 1].t - events[0].t);

  let knownSum = 0;
  for (const phase of KNOWN_PHASES) {
    const s = events.find((e) => e.event === phase.start);
    const f = events.find((e) => e.event === phase.end);
    const d = (s && f) ? Math.max(0, f.t - s.t) : 0;
    durations[phase.name] = d;
    knownSum += d;
  }
  durations.unattributedTime = Math.max(0, durations.totalWallTime - knownSum);

  return {
    schemaVersion: SOC_SCORE_SCHEMA_VERSION,
    timeUnit: 'ms',
    identity: identity || null,
    eventCount: events.length,
    firstEventAt: events[0].t,
    lastEventAt: events[events.length - 1].t,
    durations,
    generatedAt: typeof Date !== 'undefined' ? Date.now() : 0,
  };
}

// Re-export the minimum surface that other packages / tests need.
export const _internals = Object.freeze({
  KNOWN_PHASES,
  validateIdentity,
});