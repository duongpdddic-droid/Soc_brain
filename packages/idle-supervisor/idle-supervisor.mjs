#!/usr/bin/env node
// idle-supervisor.mjs — Soc_brain Idle Hibernate Supervisor (companion service).
//
// Ownership rule (hard invariant): this supervisor is a READ-ONLY observer of
// the canonical control plane. It:
//   - NEVER mutates the canonical session record, FSM ledger, GitHub, or any
//     workspace state (its only writes live under state/idle-supervisor/);
//   - is NOT a mutation owner and holds NO MCP mutation capability;
//   - NEVER uses process names/PIDs as activity authority — canonical session
//     records, the control-loop ledger and canonical execution records are the
//     only authority (process liveness is supplemental projection only);
//   - treats UNKNOWN/ambiguous canonical state as HIBERNATE_DENIED (fail-closed):
//     no canonical facts -> never hibernate;
//   - owns exactly ONE capability: the Windows HIBERNATE power action (never
//     Sleep/S3), gated behind an explicit production flag in run.mjs.
//
// Hibernate decision policy (config-driven, Windows local timezone):
//   DAY  (nightEnd..nightStart, default 06:00-00:00): clean canonical state
//        AND OS user idle >= dayGrace -> hibernate eligible.
//   NIGHT(nightStart..nightEnd, default 00:00-06:00): clean canonical state
//        AND continuously clean >= nightGrace -> hibernate eligible (OS user
//        idle NOT required); any new task/control work resets the countdown.
//   Before any hibernate: fresh final canonical read-back must re-confirm ALL
//   zero-conditions; a non-mutating Windows capability preflight (powercfg /a)
//   must confirm Hibernate is available; durable evidence is persisted BEFORE
//   the OS call, and a hibernate request is issued exactly once per decision
//   (crash-safe guard). If Hibernate is unavailable -> fail closed
//   (HUMAN_GATE_REQUIRED), never Sleep.
//
// ponytail: dependency-free hand-rolled scan mirroring control-ui listTasks
// house style; add a schema library only if the policy grows past ~10 fields.

import fs from 'node:fs';
import path from 'node:path';
import { identityHash } from '../workspace/workspace.mjs';
import { readSessionRecord } from '../runtime-sandbox/runtime-sandbox.mjs';

export const IDLE_SUPERVISOR_SCHEMA_VERSION = '1';

// Canonical activity policy (Bước 1). States that mean live canonical work.
export const ACTIVE_LOOP_STATES = Object.freeze([
  'EXECUTING', 'VERIFYING', 'PRE_REVIEWING', 'FINAL_REVIEWING', 'REWORK',
  'DECIDING', 'DELIVERING', 'RECOVERING', 'MCP_RECOVERING',
]);
// Canonical states that mean NO work (task parked/finished).
export const INACTIVE_STATES = Object.freeze([
  'COMPLETED', 'FAILED', 'BLOCKED', 'HUMAN_GATE_REQUIRED', 'WAITING_FOR_INPUT',
]);
const ACTIVE_SET = Object.freeze(new Set(ACTIVE_LOOP_STATES));
const INACTIVE_SET = Object.freeze(new Set(INACTIVE_STATES));

// Control-loop ledger tail states that close a loop without terminalizing the
// session record are the SAME terminal states the FSM defines.
const LEDGER_TERMINAL_STATES = Object.freeze(new Set(['COMPLETED', 'BLOCKED']));

// Canonical runtime states. The power action is HIBERNATE only — there is no
// Sleep/S3 state, action, or fallback anywhere in this surface.
// HUMAN_GATE_REQUIRED: Hibernate is not available on this machine and an
// operator must enable it (see `HIBERNATE_CONTRACT` in the issue).
export const SUPERVISOR_STATES = Object.freeze([
  'DISABLED', 'BUSY', 'WAIT_USER_IDLE', 'IDLE_COUNTDOWN',
  'HIBERNATE_ELIGIBLE', 'HIBERNATE_REQUESTED', 'HIBERNATE_DENIED_UNKNOWN_ACTIVITY',
  'HUMAN_GATE_REQUIRED',
]);

// A SESSION_ACTIVE record with no ledger and no execution record is a dispatch
// window only for this long; older than that it is an abandoned session.
const DISPATCH_WINDOW_MS = 15 * 60 * 1000;
// A non-terminal execution record whose pid is dead and whose startedAt is
// older than this is a STALE projection (mirrors control-ui STALLED), not work.
const EXECUTION_STALE_MS = 2 * 60 * 60 * 1000;
// Minimum interval between two OS hibernate requests. Prevents request spam
// when a hibernate silently fails while the machine stays awake; normal
// DAY/NIGHT cadence (hours apart) is unaffected.
const HIBERNATE_REQUEST_COOLDOWN_MS = 5 * 60 * 1000;

// ---- config -------------------------------------------------------------------

function parseClockHHMM(v, dflt) {
  const s = String(v ?? dflt);
  const m = /^([0-1][0-9]|2[0-3]):([0-5][0-9])$/.exec(s);
  if (!m) return null;
  return { h: Number(m[1]), m: Number(m[2]) };
}

function parseGraceMin(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 24 * 60) return null;
  return n;
}

// Canonical config names use SOC_IDLE_HIBERNATE*. The pre-existing
// SOC_IDLE_SLEEP* names are still READ as a compatibility alias so a running
// production daemon configured with the old names keeps enabling (and is now
// upgraded to Hibernate with no Sleep fallback). New deployments should set the
// SOC_IDLE_HIBERNATE* names; the legacy names are deprecated, not removed, to
// avoid silently disabling supervision on upgrade.
function pick(env, canonical, legacy) {
  if (env[canonical] !== undefined) return env[canonical];
  return env[legacy];
}

// Explicit enable only: SOC_IDLE_HIBERNATE=1 (or legacy SOC_IDLE_SLEEP=1).
// Anything else keeps the supervisor DISABLED (it must never hibernate unless
// turned on).
export function readIdleHibernateConfig(env = process.env) {
  const enabled = pick(env, 'SOC_IDLE_HIBERNATE', 'SOC_IDLE_SLEEP') === '1';
  const dayGraceMin = parseGraceMin(pick(env, 'SOC_IDLE_HIBERNATE_DAY_GRACE_MIN', 'SOC_IDLE_SLEEP_DAY_GRACE_MIN'), 20);
  const nightGraceMin = parseGraceMin(pick(env, 'SOC_IDLE_HIBERNATE_NIGHT_GRACE_MIN', 'SOC_IDLE_SLEEP_NIGHT_GRACE_MIN'), 10);
  const nightStart = parseClockHHMM(pick(env, 'SOC_IDLE_HIBERNATE_NIGHT_START', 'SOC_IDLE_SLEEP_NIGHT_START'), '00:00');
  const nightEnd = parseClockHHMM(pick(env, 'SOC_IDLE_HIBERNATE_NIGHT_END', 'SOC_IDLE_SLEEP_NIGHT_END'), '06:00');
  const pollRaw = pick(env, 'SOC_IDLE_HIBERNATE_POLL_SEC', 'SOC_IDLE_SLEEP_POLL_SEC');
  const pollSecRaw = pollRaw === undefined ? 30 : Number(pollRaw);
  const pollSec = Number.isInteger(pollSecRaw) && pollSecRaw >= 1 && pollSecRaw <= 3600 ? pollSecRaw : null;
  if (dayGraceMin == null || nightGraceMin == null || !nightStart || !nightEnd || pollSec == null) {
    return { ok: false, enabled: false, reason: 'SOC_IDLE_HIBERNATE_CONFIG_INVALID' };
  }
  return {
    ok: true,
    config: {
      schemaVersion: IDLE_SUPERVISOR_SCHEMA_VERSION,
      enabled,
      dayGraceMs: dayGraceMin * 60 * 1000,
      nightGraceMs: nightGraceMin * 60 * 1000,
      nightStart, nightEnd,
      pollSec,
      allowRealHibernate: pick(env, 'SOC_IDLE_HIBERNATE_ALLOW_REAL', 'SOC_IDLE_SLEEP_ALLOW_REAL_SLEEP') === '1',
      stateDir: env.SOC_STATE_DIR || null, // null = canonical default (~/.soc-brain/state)
    },
  };
}

// Deprecated alias (carried for compatibility with existing callers/config).
export const readIdleSleepConfig = readIdleHibernateConfig;

// Windows local timezone comes from the OS clock via Date local accessors —
// never hardcoded UTC. DAY = [nightEnd, nightStart); NIGHT = the complement.
export function localPolicyMode(now, config) {
  const d = now instanceof Date ? now : new Date(now);
  const mins = d.getHours() * 60 + d.getMinutes();
  const start = config.nightStart.h * 60 + config.nightStart.m;
  const end = config.nightEnd.h * 60 + config.nightEnd.m;
  if (start <= end) return mins >= start && mins < end ? 'NIGHT' : 'DAY';
  // window crosses midnight (e.g. 00:00-06:00)
  return mins >= start || mins < end ? 'NIGHT' : 'DAY';
}

// ---- canonical read-only scan ---------------------------------------------------

export function idleSupervisorDirFor({ stateDir } = {}) {
  return path.join(path.resolve(stateDir), 'idle-supervisor');
}

function sessionsDirFor({ stateDir }) {
  return path.join(path.resolve(stateDir), 'sessions');
}

// Ledger tail = last valid `.to` of the control-loop transition ledger.
// Missing ledger -> { tail: null }; corrupt -> { error } (UNKNOWN, deny).
function readLedgerTail(controlLoopDir, id) {
  const p = path.join(controlLoopDir, id, 'transitions.jsonl');
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { tail: null };
    return { error: 'LEDGER_UNREADABLE' };
  }
  const lines = raw.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const rec = JSON.parse(lines[i]);
      if (rec && typeof rec.to === 'string') return { tail: rec.to };
    } catch { /* skip torn trailing line; keep scanning backwards */ }
  }
  return { error: 'LEDGER_CORRUPT' };
}

// Canonical execution record projection. Mirrors executor-launcher
// effectiveStatus semantics (dead pid + unfinalized stays RUNNING: safe
// direction; finalization in flight). PID liveness is SUPPLEMENTAL: the record
// itself is canonical state; a stale dead record older than EXECUTION_STALE_MS
// projects STALE (not work) exactly like control-ui's STALLED.
function readExecutionProjection(executionsDir, id, { isAlive = pidAlive, clock = Date.now } = {}) {
  const p = path.join(executionsDir, `${id}.json`);
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { found: false };
    return { error: 'EXECUTION_RECORD_UNREADABLE' };
  }
  let record;
  try { record = JSON.parse(raw); } catch { return { error: 'EXECUTION_RECORD_CORRUPT' }; }
  if (!record || typeof record !== 'object' || record.identityHash !== id) {
    return { error: 'EXECUTION_RECORD_INVALID' };
  }
  let status;
  if (record.terminalStatus) status = record.terminalStatus;
  else if (record.pid == null) status = 'STARTING';
  else status = isAlive(record.pid) ? 'RUNNING' : (record.finalized === true ? 'INTERRUPTED' : 'RUNNING');
  if (status === 'RUNNING' || status === 'STARTING') {
    const startedAt = Date.parse(record.startedAt || '') || null;
    if (startedAt != null && !isAlive(record.pid ?? -1) && clock() - startedAt > EXECUTION_STALE_MS) {
      return { found: true, status: 'STALE' };
    }
  }
  return { found: true, status };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Classify ONE canonical session. Returns 'ACTIVE' | 'INACTIVE' | 'UNKNOWN'.
export function classifySession({ session, ledgerTail, execution, sessionAgeMs = null }) {
  const state = session && typeof session.state === 'string' ? session.state : null;
  if (!state) return 'UNKNOWN';
  if (ACTIVE_SET.has(state)) return 'ACTIVE';
  if (INACTIVE_SET.has(state)) return 'INACTIVE';
  if (state === 'SESSION_ACTIVE') {
    // Authority = control-loop ledger tail, then the canonical execution record.
    if (ledgerTail && ledgerTail.error) return 'UNKNOWN';
    if (ledgerTail && ledgerTail.tail != null) {
      if (ACTIVE_SET.has(ledgerTail.tail)) return 'ACTIVE';
      if (LEDGER_TERMINAL_STATES.has(ledgerTail.tail)) return 'INACTIVE';
      return 'UNKNOWN';
    }
    if (execution && execution.error) return 'UNKNOWN';
    if (execution && execution.found) {
      if (execution.status === 'RUNNING' || execution.status === 'STARTING') return 'ACTIVE';
      if (execution.status === 'STALE' || execution.status === 'EXITED'
        || execution.status === 'FAILED' || execution.status === 'STOPPED'
        || execution.status === 'INTERRUPTED') return 'INACTIVE';
      return 'UNKNOWN';
    }
    // No ledger, no execution record: inside the dispatch window this MIGHT be
    // a pending executor dispatch (deny); older -> abandoned session (idle).
    if (sessionAgeMs == null) return 'UNKNOWN';
    return sessionAgeMs < DISPATCH_WINDOW_MS ? 'UNKNOWN' : 'INACTIVE';
  }
  return 'UNKNOWN'; // any other/unrecognized canonical state -> fail-closed
}

function sessionAgeMsOf(session, clock) {
  const issuedAt = session && session.lease && Date.parse(session.lease.issuedAt || '');
  const createdAt = Date.parse((session && session.createdAt) || '');
  const t = Number.isFinite(issuedAt) ? issuedAt : (Number.isFinite(createdAt) ? createdAt : null);
  return t == null ? null : Math.max(0, clock() - t);
}

// One read-only pass over the canonical control plane. Fail-isolated per
// session, but every unreadable/ambiguous record counts into `unknown` and
// DENIES hibernate (HIBERNATE_DENIED_UNKNOWN_ACTIVITY) — never skipped silently.
export function scanCanonicalActivity({ stateDir, clock = Date.now, isAlive } = {}) {
  const root = path.resolve(stateDir);
  const out = {
    known: true, activeCanonicalTasks: 0, pendingControlWork: 0,
    unknown: [], sessions: 0, scannedAt: new Date(clock()).toISOString(),
  };
  let entries;
  try { entries = fs.readdirSync(sessionsDirFor({ stateDir: root })); } catch {
    out.unknown.push({ identityHash: null, reason: 'SESSIONS_DIR_UNREADABLE' });
    out.known = false;
    return out;
  }
  const controlLoopDir = path.join(root, 'control-loop');
  const executionsDir = path.join(root, 'executions');
  for (const name of entries) {
    if (!name.endsWith('.json')) continue; // also skips subdirectories
    const rs = readSessionRecord(path.join(sessionsDirFor({ stateDir: root }), name));
    if (!rs.ok) { out.unknown.push({ identityHash: name, reason: rs.reason || 'SESSION_UNREADABLE' }); continue; }
    const session = rs.session;
    const id = typeof session.identityHash === 'string' && session.identityHash
      ? session.identityHash
      : identityHash({ repo: session.repo, issueNumber: session.issueNumber });
    if (!id) { out.unknown.push({ identityHash: name, reason: 'SESSION_IDENTITY_INVALID' }); continue; }
    out.sessions += 1;
    const cls = classifySession({
      session,
      ledgerTail: readLedgerTail(controlLoopDir, id),
      execution: readExecutionProjection(executionsDir, id, { isAlive, clock }),
      sessionAgeMs: sessionAgeMsOf(session, clock),
    });
    if (cls === 'ACTIVE') { out.activeCanonicalTasks += 1; continue; }
    if (cls === 'UNKNOWN') { out.unknown.push({ identityHash: id, reason: 'STATE_AMBIGUOUS', state: session.state }); continue; }
  }
  if (out.unknown.length > 0) out.known = false;
  // pendingControlWork == active work surface (dispatch/review/delivery/
  // recovery/ownership windows are all ledger/state-covered above).
  out.pendingControlWork = out.activeCanonicalTasks;
  return out;
}

// ---- durable evidence + exactly-once guard ---------------------------------------

export function hibernateEvidencePathFor({ stateDir } = {}) {
  return path.join(idleSupervisorDirFor({ stateDir }), 'hibernate-evidence.json');
}

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, p);
}

export function readHibernateEvidence({ stateDir } = {}) {
  const p = hibernateEvidencePathFor({ stateDir });
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, evidence: null };
    return { ok: false, reason: 'EVIDENCE_UNREADABLE' };
  }
  try {
    const evidence = JSON.parse(raw);
    if (!evidence || typeof evidence !== 'object') return { ok: false, reason: 'EVIDENCE_CORRUPT' };
    return { ok: true, evidence, path: p };
  } catch { return { ok: false, reason: 'EVIDENCE_CORRUPT' }; }
}

// Deprecated alias (compatibility).
export const readSleepEvidence = readHibernateEvidence;

// Persist durable evidence BEFORE the OS power call, then mark the request as
// dispatched (two atomic writes: evidence -> result marker). A crash between
// them leaves hibernateRequested=true without a result: the guard suppresses
// any further request for that decision (never duplicate), until a real resume
// clears it (the machine demonstrably hibernated).
export function persistHibernateEvidence({ stateDir, evidence } = {}) {
  const p = hibernateEvidencePathFor({ stateDir });
  try { writeJsonAtomic(p, evidence); return { ok: true, path: p }; } catch (e) {
    return { ok: false, reason: 'EVIDENCE_WRITE_FAILED', detail: String((e && e.message) || e) };
  }
}

// Deprecated alias (compatibility).
export const persistSleepEvidence = persistHibernateEvidence;

export function markHibernateResult({ stateDir, result, now = () => new Date().toISOString() } = {}) {
  const r = readHibernateEvidence({ stateDir });
  if (!r.ok || !r.evidence) return { ok: false, reason: r.ok ? 'NO_EVIDENCE' : r.reason };
  const evidence = { ...r.evidence, result, resultAt: now() };
  try { writeJsonAtomic(hibernateEvidencePathFor({ stateDir }), evidence); return { ok: true, evidence }; } catch (e) {
    return { ok: false, reason: 'EVIDENCE_WRITE_FAILED', detail: String((e && e.message) || e) };
  }
}

// Deprecated alias (compatibility).
export const markSleepResult = markHibernateResult;

// A pending request suppresses new hibernate decisions until the machine proves
// it hibernated (resume) — crash-safe exactly-once per decision. Reads the new
// `hibernateRequested` field, with a backward read of the legacy
// `sleepRequested` field so a decision persisted by the pre-Hibernate build
// still honors its exactly-once guard after upgrade.
function requestPending(evidence) {
  const requested = Boolean(evidence && (evidence.hibernateRequested === true || evidence.sleepRequested === true));
  return requested && !evidence.result;
}

// ---- supervisor state machine -----------------------------------------------------

export function createIdleSupervisor({
  config, stateDir,
  clock = Date.now,
  scan = scanCanonicalActivity,
  readEvidence = readHibernateEvidence,
  persistEvidence = persistHibernateEvidence,
  markResult = markHibernateResult,
  // Non-mutating Windows capability preflight. Returns
  // { ok: boolean, reason?, detail? }. The pure module defaults to AVAILABLE
  // (it holds no OS handle); the DAEMON injects the real `powercfg /a` probe.
  preflight = () => ({ ok: true }),
} = {}) {
  let state = config.enabled ? 'BUSY' : 'DISABLED';
  let cleanSince = null;   // continuous clean window start (night grace source)
  let lastTickAt = null;
  let bootEvidence = null;
  let lastRequestAt = null;

  function loadPending() {
    const r = readEvidence({ stateDir });
    if (!r.ok) return true; // unreadable evidence -> fail-closed: suppress
    bootEvidence = r.evidence;
    const t = Date.parse((r.evidence && r.evidence.requestedAt) || '');
    lastRequestAt = Number.isFinite(t) ? t : null;
    return requestPending(r.evidence);
  }
  let pending = loadPending();

  function resetIdle(now) { cleanSince = now; }

  function denyUnknown(now) {
    state = 'HIBERNATE_DENIED_UNKNOWN_ACTIVITY';
    resetIdle(now);
    return { state, actions: [], reason: 'HIBERNATE_DENIED_UNKNOWN_ACTIVITY' };
  }

  // Final canonical read-back gate: re-validate ALL zero-conditions on FRESH
  // scan output before any evidence/OS call. One UNKNOWN aborts the hibernate.
  function finalizeHibernate({ activity, userIdleMs, now }) {
    if (pending) return { ok: false, code: 'HIBERNATE_REQUEST_PENDING' };
    if (!activity || activity.known !== true) return { ok: false, code: 'HIBERNATE_ABORTED_UNKNOWN_ACTIVITY' };
    if (activity.activeCanonicalTasks !== 0 || activity.pendingControlWork !== 0) {
      return { ok: false, code: 'HIBERNATE_ABORTED_ACTIVE_WORK' };
    }
    const mode = localPolicyMode(now, config);
    if (mode === 'DAY') {
      if (!(Number(userIdleMs) >= config.dayGraceMs)) return { ok: false, code: 'HIBERNATE_ABORTED_USER_NOT_IDLE' };
    }
    // NIGHT re-check: continuous clean window must still cover nightGrace.
    if (mode === 'NIGHT' && (cleanSince == null || (now - cleanSince) < config.nightGraceMs)) {
      return { ok: false, code: 'HIBERNATE_ABORTED_COUNTDOWN_RESET' };
    }
    // Capability preflight BEFORE persisting any pending-intent evidence:
    // Hibernate is the ONLY allowed action and must be available on the OS.
    // If it is disabled/unavailable -> fail closed with the exact admin action
    // (reported, never executed) and NO Sleep fallback.
    const cap = preflight() || { ok: false, reason: 'PREFLIGHT_MISSING' };
    if (cap.ok !== true) {
      state = 'HUMAN_GATE_REQUIRED';
      return { ok: false, code: 'HUMAN_GATE_REQUIRED', reason: cap.reason || 'HIBERNATE_UNAVAILABLE', detail: cap.detail ?? null };
    }
    const evidence = {
      schemaVersion: IDLE_SUPERVISOR_SCHEMA_VERSION,
      event: 'HIBERNATE_IDLE_CONFIRMED',
      powerAction: 'HIBERNATE', // Hibernate, NEVER Sleep/S3
      policy: mode,
      activeCanonicalTasks: 0,
      pendingControlWork: 0,
      userIdleMs: mode === 'DAY' ? Math.round(Number(userIdleMs)) : null,
      graceMs: mode === 'DAY' ? config.dayGraceMs : config.nightGraceMs,
      checkedAt: new Date(now).toISOString(),
      hibernateRequested: true,
      requestedAt: new Date(now).toISOString(),
      result: null,
    };
    const w = persistEvidence({ stateDir, evidence });
    if (!w.ok) return { ok: false, code: w.reason, detail: w.detail ?? null };
    pending = true;
    lastRequestAt = now;
    state = 'HIBERNATE_REQUESTED';
    // Evidence is ALREADY durably persisted here (BEFORE the OS call) — the
    // daemon must only execute REQUEST_HIBERNATE, never write the evidence again.
    return {
      ok: true, state, evidence,
      actions: [{ type: 'REQUEST_HIBERNATE', powerAction: 'HIBERNATE' }],
    };
  }

  return {
    get state() { return state; },
    get pendingHibernateRequest() { return pending; },

    // Daemon calls after wake/crash-restart detection. Re-reads canonical
    // state health implicitly on next tick; clears the pending request (the
    // machine demonstrably hibernated) and restarts all idle windows.
    markResumed({ now = clock() } = {}) {
      if (pending && bootEvidence && !bootEvidence.result) {
        markResult({ stateDir, result: 'HIBERNATE_RESUMED', now: () => new Date(now).toISOString() });
      }
      pending = loadPending();
      resetIdle(now);
      return { ok: true };
    },

    // Daemon reports the dispatch outcome: 'HIBERNATE_REQUEST_FAILED' or
    // 'HIBERNATE_REQUEST_UNCONFIRMED' clear the pending guard (a NEW decision
    // may legitimately follow); the machine proving it hibernated
    // ('HIBERNATE_RESUMED', via markResumed) also clears it. Until then no
    // duplicate request.
    markRequestOutcome({ result, now = clock() } = {}) {
      if (!pending) return { ok: false, reason: 'NO_PENDING_REQUEST' };
      lastRequestAt = now;
      const r = markResult({ stateDir, result, now: () => new Date(now).toISOString() });
      pending = loadPending();
      if (pending) lastRequestAt = now; // still pending -> keep cooldown anchored
      return r.ok ? { ok: true } : r;
    },

    // One monitoring tick. Pure w.r.t. injected deps; OS effects happen only
    // through returned actions (REQUEST_HIBERNATE), executed by the daemon.
    tick({ activity = null, userIdleMs = 0, now = clock(), resumed = false } = {}) {
      if (resumed) this.markResumed({ now });
      if (lastTickAt != null && now < lastTickAt) this.markResumed({ now }); // clock jump
      lastTickAt = now;

      if (!config.enabled) { state = 'DISABLED'; return { state, actions: [] }; }
      if (pending) { state = 'HIBERNATE_REQUESTED'; return { state, actions: [], reason: 'HIBERNATE_REQUEST_PENDING' }; }
      if (!activity) { return denyUnknown(now); }
      if (activity.known !== true) { return denyUnknown(now); }

      const busy = activity.activeCanonicalTasks > 0 || activity.pendingControlWork > 0;
      if (busy) { state = 'BUSY'; resetIdle(now); return { state, actions: [] }; }

      if (cleanSince == null) resetIdle(now);
      const mode = localPolicyMode(now, config);
      if (mode === 'NIGHT') {
        if (now - cleanSince < config.nightGraceMs) {
          state = 'IDLE_COUNTDOWN';
          return { state, actions: [], countdownRemainingMs: config.nightGraceMs - (now - cleanSince) };
        }
      } else {
        if (!(Number(userIdleMs) >= config.dayGraceMs)) {
          state = 'WAIT_USER_IDLE';
          return { state, actions: [] };
        }
      }
      // Cooldown: a just-dispatched request (or one whose machine is about to
      // hibernate) must never be re-fired by the next poll.
      if (lastRequestAt != null && now - lastRequestAt < HIBERNATE_REQUEST_COOLDOWN_MS) {
        state = 'WAIT_USER_IDLE';
        return { state, actions: [], reason: 'HIBERNATE_REQUEST_COOLDOWN' };
      }
      state = 'HIBERNATE_ELIGIBLE';
      return {
        state, actions: [{ type: 'FINAL_READ_BACK' }],
        // Finalize re-validates against the SAME decision instant (never a
        // wall-clock drift between eligibility and evidence).
        finalize: (fresh) => finalizeHibernate({ activity: fresh, userIdleMs, now }),
      };
    },
  };
}
