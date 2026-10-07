// packages/control-loop/execution-record-self-healing.mjs — FSM Self-Healing.
//
// Defect class covered: a task hydrates with a session/ledger whose canonical
// ExecutionRecord ($stateDir/executions/<identityHash>.json) is missing (for
// example a lost/killed state directory), so the VERIFY leg used to die on
// INTERNAL_REVIEW_EXECUTION_RECORD_MISSING / INTERNAL_REVIEW_RECORD_STALE and
// the task could never reach INTERNAL_REVIEW or terminalization (delivery
// re-reads the SAME record for its identity chain).
//
// The heal is a ONE-SHOT, evidence-first verification synthesis:
//   1. classify the canonical record — only a truly ABSENT record is healable;
//   2. exactly ONE synthesis attempt per candidate head, persisted BEFORE the
//      gate runs (a crash mid-synthesis still spends the budget — no retry
//      loop is ever possible);
//   3. the synthesis runs the repository's own offline test gate through the
//      INJECTED runGate seam (production: the canonical active test runner,
//      spawnSync-bounded with full log/provenance), then stamps the REAL
//      content binding of the bound worktree — never a fabricated record;
//   4. the canonical record is written atomically (executor-launcher's
//      writeRecordAtomic) and read back through readExecutionRecord before
//      the verifier is re-entered once;
//   5. any failure — gate fail, gate throw, unprovable binding, write or
//      read-back failure, spent budget — is typed HEALING_ATTEMPT_EXHAUSTED
//      (or INTEGRITY_MISMATCH for a present-but-wrong record) and travels as
//      the loop's own typed failure, never as a silent success.
//
// Invariants (fail-closed):
//   * present-but-mismatched or unreadable record -> INTEGRITY_MISMATCH; the
//     file is NEVER overwritten and the gate NEVER runs;
//   * the one-shot budget is keyed by a PROVEN 40-hex session.headSha: an
//     unprovable head (missing/null/empty/non-hex) refuses INTEGRITY_MISMATCH
//     / UNPROVABLE_HEAD_SHA_FOR_HEALING BEFORE the ledger is read, so one
//     commit's attempts can never be spent against another commit's head;
//   * healingAttempts[headSha] <= 1 across relaunches (durable ledger at
//     control-loop/<identityHash>/execution-record-healing.json), matched by
//     EXACT commit string (lowercased) per entry — never a null/blanket match;
//   * the ledger write is only trusted when its read-back still holds exactly
//     the attempt array just persisted; a drifted count is typed
//     HEALING_LEDGER_CONCURRENT_MUTATION (a second writer landed in between),
//     never a silent success;
//   * a synthesized record always carries STRING model/agent fields
//     ('unknown' / 'build' session defaults) so downstream reporters and
//     recovery scanners never read a null non-string property;
//   * this module spawns NOTHING itself (the gate arrives via DI) and never
//     console.logs raw diagnostics — failures surface as typed results only;
//   * without an injected healing seam the wrapper is the ORIGINAL verifier
//     reference, so every pre-existing path keeps its exact behavior.

import fs from 'node:fs';
import path from 'node:path';

import {
  EXECUTION_SCHEMA_VERSION,
  EXECUTOR_ID,
  contentBindingStamp,
  executionEventsPath,
  executionRecordPath,
  readExecutionRecord,
  writeRecordAtomic,
} from '../executor-launcher/executor-launcher.mjs';
import { testRunsPathFor } from '../executor-launcher/test-run-evidence.mjs';
import { readSessionRecord } from '../runtime-sandbox/runtime-sandbox.mjs';

// The pre-gate codes that mean "the canonical execution evidence is not
// readable right now" — the ONLY codes this wrapper ever reacts to. Everything
// else (findings, transport, candidate drift, handoff refusals) passes through
// untouched so existing reroute/resume semantics stay byte-for-byte.
export const SELF_HEALING_TRIGGER_CODES = Object.freeze([
  'INTERNAL_REVIEW_EXECUTION_RECORD_MISSING',
  'INTERNAL_REVIEW_RECORD_STALE',
]);

// The typed refusals this wrapper may ORIGINATE. They travel through the
// loop.step failure envelope exactly like INTERNAL_REVIEW_HANDOFF_CODES do
// (control-loop `selfHealingCodeOf`) instead of collapsing into the generic
// VERIFY_FAILED / REWORK_VERIFY_FAILED wrapper.
export const SELF_HEALING_FAIL_CODES = Object.freeze([
  'INTEGRITY_MISMATCH',
  'HEALING_ATTEMPT_EXHAUSTED',
]);

// ONE synthesis attempt per candidate head, across relaunches.
export const HEALING_ATTEMPT_LIMIT = 1;

// A commit HEAD is only provable as a full 40-hex SHA — the same contract the
// rest of the loop holds a binding head to (handoff/review evidence).
const HEAD_SHA_40 = /^[0-9a-f]{40}$/i;

const HEALING_LEDGER_KIND = 'ExecutionRecordHealingLedger';

export function healingAttemptsPath({ stateDir, identityHash: id }) {
  return path.join(path.resolve(String(stateDir)), 'control-loop', String(id), 'execution-record-healing.json');
}

// Durable attempt ledger. An ABSENT ledger reads as zero attempts; anything
// unreadable/malformed is an ERROR the caller must treat as fail-closed (a
// budget that cannot be proven is a budget that may not be spent).
export function readHealingAttempts({ stateDir, identityHash: id }) {
  const p = healingAttemptsPath({ stateDir, identityHash: id });
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { ok: true, ledger: { schemaVersion: '1', kind: HEALING_LEDGER_KIND, identityHash: String(id), attempts: [] } };
    }
    return { ok: false, reason: 'HEALING_LEDGER_UNREADABLE', detail: String((e && e.message) || e) };
  }
  let ledger;
  try { ledger = JSON.parse(raw); } catch { return { ok: false, reason: 'HEALING_LEDGER_CORRUPT' }; }
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger) || !Array.isArray(ledger.attempts)) {
    return { ok: false, reason: 'HEALING_LEDGER_CORRUPT' };
  }
  return { ok: true, ledger };
}

// Append exactly one attempt and read it back. Persist-before-synthesis is the
// crash-safety point: a process that dies mid-gate has still spent the budget.
// The read-back is a CONCURRENCY proof, not a formality: the atomic write can
// still lose to a second ledger writer between write and read, so the file is
// only trusted when it holds EXACTLY the attempt array just persisted.
export function recordHealingAttempt({ stateDir, identityHash: id, attempt, now = () => new Date().toISOString() }) {
  const rd = readHealingAttempts({ stateDir, identityHash: id });
  if (!rd.ok) return rd;
  const entry = attempt && typeof attempt === 'object' && !Array.isArray(attempt)
    ? { at: typeof attempt.at === 'string' ? attempt.at : now(), headSha: attempt.headSha ?? null, trigger: attempt.trigger ?? null }
    : { at: now(), headSha: null, trigger: null };
  const next = {
    schemaVersion: '1',
    kind: HEALING_LEDGER_KIND,
    identityHash: String(id),
    attempts: [...rd.ledger.attempts, entry],
  };
  const p = healingAttemptsPath({ stateDir, identityHash: id });
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeRecordAtomic(p, next);
  } catch (e) {
    return { ok: false, reason: 'HEALING_LEDGER_WRITE_FAILED', detail: String((e && e.message) || e) };
  }
  const back = readHealingAttempts({ stateDir, identityHash: id });
  if (!back.ok) {
    return { ok: false, reason: 'HEALING_LEDGER_READBACK_FAILED', detail: back.reason ?? null };
  }
  if (back.ledger.attempts.length !== next.attempts.length) {
    // Another process replaced our ledger after the atomic rename: the budget
    // we think we persisted is NOT durable. Never let the caller spend it.
    return { ok: false, reason: 'HEALING_LEDGER_CONCURRENT_MUTATION', detail: 'attempt count drift' };
  }
  return { ok: true, attempts: next.attempts };
}

// Read-only classification of the canonical record against the LIVE session.
//   ABSENT   — the only healable state (canonical path, ENOENT);
//   PRESENT  — record exists and agrees with the session binding (a trigger
//              code here means a transient/raced refusal; pass it through);
//   MISMATCH — the file exists but disagrees (identity/binding) or is
//              unreadable/malformed: integrity, never repairable by healing.
export function classifyExecutionRecord({ stateDir, identityHash: id, session }) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    return { kind: 'MISMATCH', reason: 'SESSION_UNREADABLE' };
  }
  const r = readExecutionRecord({ stateDir, repo: session.repo, issueNumber: session.issueNumber });
  if (!r.ok) {
    if (r.reason === 'EXECUTION_NOT_FOUND') return { kind: 'ABSENT', path: r.path ?? null };
    return { kind: 'MISMATCH', reason: r.reason ?? 'RECORD_UNREADABLE', detail: r.detail ?? null };
  }
  const record = r.record;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { kind: 'MISMATCH', reason: 'RECORD_MALFORMED' };
  }
  // The same binding set the pre-gate candidate derivation compares — a field
  // the pre-gate never compares can never be the reason it refused.
  const mismatches = [];
  if (record.repo !== session.repo) mismatches.push('repo');
  if (Number(record.issueNumber) !== Number(session.issueNumber)) mismatches.push('issueNumber');
  if (record.taskId !== session.taskId) mismatches.push('taskId');
  if (session.worktreePath && record.worktreePath !== session.worktreePath) mismatches.push('worktreePath');
  if (session.baseSha && record.baseSha && record.baseSha !== session.baseSha) mismatches.push('baseSha');
  if (session.headSha && record.headSha && record.headSha !== session.headSha) mismatches.push('headSha');
  if (mismatches.length > 0) {
    return { kind: 'MISMATCH', reason: 'RECORD_SESSION_BINDING_MISMATCH', mismatches, path: r.path ?? null };
  }
  return { kind: 'PRESENT', path: r.path ?? null };
}

// The verification synthesis: run the REAL offline test gate against the
// bound session, stamp the REAL content binding, then atomically persist the
// canonical record and prove the read-back. The candidate record mirrors the
// executor-launcher pre-spawn/exit shape so every downstream consumer
// (deterministic verifier, terminalize identity chain, recovery scanners)
// sees one ordinary terminal ExecutionRecord — plus explicit provenance.
export async function synthesizeExecutionRecord({
  stateDir, identityHash: id, session, runGate, now = () => new Date().toISOString(),
} = {}) {
  const exhausted = (detail) => ({ ok: false, code: 'HEALING_ATTEMPT_EXHAUSTED', detail });
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    return exhausted({ phase: 'gate', reason: 'SELF_HEALING_SESSION_UNREADABLE' });
  }
  if (typeof runGate !== 'function') {
    return exhausted({ phase: 'gate', reason: 'SELF_HEALING_GATE_UNAVAILABLE' });
  }
  const candidate = {
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    kind: 'ExecutionRecord',
    identityHash: String(id),
    taskId: session.taskId ?? null,
    repo: session.repo ?? null,
    issueNumber: session.issueNumber ?? null,
    baseSha: session.baseSha ?? null,
    branch: session.branch ?? null,
    worktreePath: session.worktreePath ?? null,
    executor: EXECUTOR_ID,
    executable: null,
    executorVersion: null,
    // Downstream hygiene: reporters and recovery scanners read these as
    // strings (executor-launcher stamps agent 'build' too); a bare null makes
    // them trip on null.toString()/string ops. Session values pass through.
    agent: session.agent ?? 'build',
    toolCaps: null,
    model: session.model ?? 'unknown',
    pid: null,
    processStartTime: null,
    pendingExecutorBind: false,
    cleanupRequired: false,
    startedAt: now(),
    finishedAt: null,
    exitCode: null,
    signal: null,
    terminalStatus: null,
    reason: null,
    instructionDigest: null,
    instructionBytes: null,
    sessionId: null,
    eventsPath: executionEventsPath({ stateDir, identityHash: id }),
    testRunsPath: testRunsPathFor({ stateDir, identityHash: id }),
    eventsOverflow: false,
  };
  // (1) the real offline test gate. It runs BEFORE anything is written: a
  // failed run must leave NO record behind, only the truthful attempt ledger.
  let g;
  try {
    g = await runGate({ session, record: candidate, stateDir });
  } catch (e) {
    return exhausted({ phase: 'gate', reason: 'SELF_HEALING_GATE_THREW', detail: String((e && e.message) || e) });
  }
  if (!g || g.ok !== true) {
    return exhausted({
      phase: 'gate',
      reason: 'SELF_HEALING_GATE_FAILED',
      gateCode: (g && g.code) || null,
      gateDetail: (g && g.detail) ?? null,
    });
  }
  // (2) the content binding of the LIVE worktree — the same production stamp
  // the executor exit handler writes. An unprovable binding (no git worktree,
  // missing HEAD, unreadable tracked files) refuses instead of laundering an
  // unbound record into the review chain.
  const stamp = contentBindingStamp(session.worktreePath);
  if (!stamp.headSha || !stamp.codeContentDigest) {
    return exhausted({
      phase: 'binding',
      reason: 'SELF_HEALING_BINDING_UNAVAILABLE',
      detail: stamp.codeBindingReason ?? null,
    });
  }
  // (3) finalize + atomic publish + read-back proof.
  const finishedAt = now();
  const exitCode = Number.isInteger(g.exitCode) ? g.exitCode : 0;
  const record = {
    ...candidate,
    ...stamp,
    finishedAt,
    exitCode,
    signal: null,
    terminalStatus: 'EXITED',
    finalized: true,
    provenance: 'control-loop/execution-record-self-healing',
    synthesizedAt: finishedAt,
    synthesisEvidence: {
      runId: g.runId ?? null,
      command: g.command ?? null,
      exitCode,
      rawLogPath: g.rawLogPath ?? null,
    },
  };
  const recPath = executionRecordPath({ stateDir, identityHash: id });
  try {
    fs.mkdirSync(path.dirname(recPath), { recursive: true });
    writeRecordAtomic(recPath, record);
  } catch (e) {
    return exhausted({ phase: 'write', reason: 'SELF_HEALING_WRITE_FAILED', detail: String((e && e.message) || e) });
  }
  const back = readExecutionRecord({ stateDir, repo: session.repo, issueNumber: session.issueNumber });
  if (!back.ok || !back.record || back.record.identityHash !== String(id)) {
    return exhausted({
      phase: 'read-back',
      reason: 'SELF_HEALING_READBACK_FAILED',
      detail: back.ok ? 'identity mismatch after write' : (back.reason ?? null),
    });
  }
  return {
    ok: true,
    record: back.record,
    path: back.path ?? recPath,
    evidence: {
      runId: g.runId ?? null,
      command: g.command ?? null,
      exitCode,
      rawLogPath: g.rawLogPath ?? null,
      contentDigest: record.codeContentDigest,
      headSha: record.headSha,
    },
  };
}

// The verify-verifier wrapper. Activation rule: ONLY when the caller injects
// a healing seam with a callable runGate (production wires the canonical
// active test runner through bin/soc-control-loop.mjs). Without the seam this
// function returns the ORIGINAL verifier reference — zero behavior change for
// every pre-existing caller and fixture.
export function withExecutionRecordSelfHealing(
  underlying,
  { stateDir, identityHash: id, sessionPath = null, healing = null, now = () => new Date().toISOString() } = {},
) {
  if (typeof underlying !== 'function') {
    throw new TypeError('withExecutionRecordSelfHealing: the underlying verifier must be a function');
  }
  if (!healing || typeof healing.runGate !== 'function') return underlying;

  return async function executionRecordSelfHealingVerifier(ctx = {}) {
    const first = await underlying(ctx);
    if (!first || typeof first !== 'object' || first.ok === true || !SELF_HEALING_TRIGGER_CODES.includes(first.code)) {
      return first;
    }
    const sp = (ctx && typeof ctx.sessionPath === 'string' && ctx.sessionPath) || sessionPath;
    const rs = sp ? readSessionRecord(sp) : null;
    if (!rs || rs.ok !== true || !rs.session) {
      return first; // classification impossible -> the original typed refusal stands
    }
    const session = rs.session;
    const cpDir = session.controlPlane && typeof session.controlPlane.stateDir === 'string' && session.controlPlane.stateDir
      ? session.controlPlane.stateDir
      : stateDir;

    const cls = classifyExecutionRecord({ stateDir: cpDir, identityHash: id, session });
    if (cls.kind === 'PRESENT') {
      return first; // the record exists now: a raced/arg refusal is not healable
    }
    if (cls.kind === 'MISMATCH') {
      return {
        ok: false,
        code: 'INTEGRITY_MISMATCH',
        detail: {
          trigger: first.code ?? null,
          reason: cls.reason ?? 'record disagrees with the session binding',
          mismatches: cls.mismatches ?? null,
          readerDetail: cls.detail ?? null,
        },
      };
    }

    // ABSENT -> the bounded one-shot synthesis. The head-key boundary comes
    // FIRST: without a provable 40-hex commit HEAD there is nothing to key the
    // one-shot budget by, so the ledger is never even read — an unprovable
    // head would otherwise match EVERY prior attempt (blanket null match) and
    // burn or miscount another commit's history. Integrity, not budget.
    const rawHead = session.headSha;
    const headKey = typeof rawHead === 'string' && HEAD_SHA_40.test(rawHead) ? rawHead.toLowerCase() : null;
    if (headKey === null) {
      return { ok: false, code: 'INTEGRITY_MISMATCH', detail: { reason: 'UNPROVABLE_HEAD_SHA_FOR_HEALING' } };
    }
    const rd = readHealingAttempts({ stateDir: cpDir, identityHash: id });
    if (!rd.ok) {
      return {
        ok: false,
        code: 'HEALING_ATTEMPT_EXHAUSTED',
        detail: { trigger: first.code ?? null, reason: rd.reason ?? 'HEALING_LEDGER_UNREADABLE', detail: rd.detail ?? null },
      };
    }
    // EXACT per-commit match: only an attempt recorded for THIS commit string
    // counts. A null/foreign/older head entry never swallows this head's
    // budget and this head never inherits another commit's spent attempt.
    const spent = rd.ledger.attempts.filter((a) => a && typeof a === 'object'
      && String(a.headSha ?? '').toLowerCase() === headKey).length;
    if (spent >= HEALING_ATTEMPT_LIMIT) {
      return {
        ok: false,
        code: 'HEALING_ATTEMPT_EXHAUSTED',
        detail: { trigger: first.code ?? null, headSha: headKey, attempts: spent, limit: HEALING_ATTEMPT_LIMIT, reason: 'HEALING_ATTEMPT_LIMIT_REACHED' },
      };
    }
    const bump = recordHealingAttempt({
      stateDir: cpDir,
      identityHash: id,
      attempt: { at: now(), headSha: headKey, trigger: first.code ?? null },
      now,
    });
    if (!bump.ok) {
      return {
        ok: false,
        code: 'HEALING_ATTEMPT_EXHAUSTED',
        detail: { trigger: first.code ?? null, reason: bump.reason ?? 'HEALING_ATTEMPT_PERSIST_FAILED', detail: bump.detail ?? null },
      };
    }
    const syn = await synthesizeExecutionRecord({ stateDir: cpDir, identityHash: id, session, runGate: healing.runGate, now });
    if (!syn.ok) {
      const detail = syn.detail && typeof syn.detail === 'object' && !Array.isArray(syn.detail)
        ? syn.detail
        : { detail: syn.detail ?? null };
      return { ok: false, code: syn.code, detail: { ...detail, trigger: first.code ?? null } };
    }
    // The record is proven on disk: re-enter the SAME underlying verifier
    // exactly once (production: candidate derivation + OCR leg + the real
    // deterministic gate against the healed record).
    const retry = await underlying(ctx);
    if (!retry || typeof retry !== 'object') {
      return { ok: false, code: 'HEALING_ATTEMPT_EXHAUSTED', detail: { trigger: first.code ?? null, reason: 'SELF_HEALING_RETRY_EMPTY' } };
    }
    if (retry.ok === true) return retry;
    if (SELF_HEALING_TRIGGER_CODES.includes(retry.code)) {
      // The verifier STILL refuses right after a proven synthesis: its view of
      // the evidence disagrees with the canonical file — integrity, not heal.
      return {
        ok: false,
        code: 'INTEGRITY_MISMATCH',
        detail: { trigger: retry.code ?? null, reason: 'the verifier still refuses after a proven synthesis', detail: retry.detail ?? null },
      };
    }
    return retry; // findings reroute / transport / handoff codes pass through untouched
  };
}
