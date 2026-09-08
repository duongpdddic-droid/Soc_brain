#!/usr/bin/env node
// reverse-dispatch.mjs — Soc_brain reverse control leg (Issue #67).
//
// WHY: #63 proved Cline → GPT (advisor-mcp). #67 proves the REVERSE leg:
// GPT structured decision → validated dispatch seam → the active Cline
// execution path continues WITHOUT user copy/paste. This module is the
// executor-independent canonical contract + bounded telemetry; the transport
// (loopback HTTP, see reverse-dispatch-server.mjs) is a temporary seam that
// the Decision Router / Execution Router will replace later.
//
// Contract — accepted decision envelope (executor-independent):
//   {
//     requestId, repo, taskRef, stateDigest, decision, issuedAt,
//     instruction, executorHint?
//   }
// - `instruction` is DATA for the executor (never shell) and lands verbatim
//   in the task's SOC_TASK_CONTRACT.md as a DATA append.
// - `decision` must be a #63 enum value (DECISIONS).
// - `stateDigest` must equal the executor's CURRENT canonical state digest —
//   GPT cannot act on stale state (fail-closed STALE_STATE_DIGEST).
//
// Fail-closed codes (validateGptDecision):
//   ENVELOPE_MALFORMED | MISSING_FIELD | FIELD_INVALID | BINDING_MISMATCH |
//   STALE_STATE_DIGEST | REPLAYED_REQUEST_ID | EXPIRED_DECISION |
//   INSTRUCTION_TOO_LARGE | REPLAY_LEDGER_UNAVAILABLE
//
// ponytail: dependency-free, hand-rolled, mirrors advisor-mcp/review-mcp-http
// house style. Add schema library only if the envelope grows beyond 9 fields.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REVERSE_DISPATCH_VERSION = '1';

// Inbound payload bounds (mirror advisor-mcp PACKET_MAX_BYTES order of size).
export const INSTRUCTION_MAX_BYTES = 8 * 1024;
export const DECISION_MAX_BYTES = 64 * 1024;

// Same enum as advisor-mcp (#63) — a #67 decision IS a #63 decision arriving
// on the reverse leg. Re-export keeps ONE enum source; import creates the
// local binding used by validateGptDecision.
import { DECISIONS } from '../advisor-mcp/advisor-mcp.mjs';
export { DECISIONS };

const REQUEST_ID_RE = /^[A-Za-z0-9._:@-]{8,128}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TASK_REF_RE = /^[A-Za-z0-9._#:\-\s]{1,128}$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const HINT_MAX_CHARS = 2000;

// ---- replay ledger (file-backed, once-only per requestId) ---------------------

export function ledgerPath({ stateDir } = {}) {
  const root = stateDir || path.join(os.homedir(), '.soc-brain', 'state');
  return path.join(root, 'reverse-dispatch', 'replay-ledger.json');
}

// null = no ledger yet (first run). { corrupt:true } = exists but unreadable/
// unparsable — callers must fail CLOSED, never silently reset the ledger.
function readLedger(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    return { corrupt: true };
  }
}

function writeLedgerAtomic(p, ledger) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, p);
}

// Once-only per requestId. Returns { ok:true } and RECORDS the requestId, or
// { ok:false, code:'REPLAYED_REQUEST_ID' | 'REPLAY_LEDGER_UNAVAILABLE' }.
// Unavailable (unwritable/corrupt) fails CLOSED — never degrade to allow-replay.
export function checkAndRecordRequestId(requestId, { stateDir } = {}) {
  const p = ledgerPath({ stateDir });
  let ledger = readLedger(p);
  if (
    ledger !== null &&
    (typeof ledger !== 'object' || Array.isArray(ledger) ||
      typeof ledger.requests !== 'object' || ledger.requests === null || Array.isArray(ledger.requests))
  ) {
    return { ok: false, code: 'REPLAY_LEDGER_UNAVAILABLE', detail: `corrupt ledger: ${p}` };
  }
  if (ledger === null) ledger = { schemaVersion: '1', requests: {} };
  if (Object.prototype.hasOwnProperty.call(ledger.requests, requestId)) {
    return { ok: false, code: 'REPLAYED_REQUEST_ID', requestId };
  }
  ledger.requests[requestId] = { at: new Date().toISOString() };
  try {
    writeLedgerAtomic(p, ledger);
  } catch (e) {
    return { ok: false, code: 'REPLAY_LEDGER_UNAVAILABLE', detail: String((e && e.message) || e) };
  }
  return { ok: true };
}

// ---- telemetry (bounded JSONL, NOT a progress monitor) ------------------------

export function telemetryPath({ stateDir } = {}) {
  const root = stateDir || path.join(os.homedir(), '.soc-brain', 'state');
  return path.join(root, 'reverse-dispatch', 'telemetry.jsonl');
}

// One line per validate call; malformed decisions need an audit trail. Best
// effort: telemetry failure never breaks validation.
export function recordTelemetry(event, { stateDir } = {}) {
  try {
    const p = telemetryPath({ stateDir });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, 'utf8');
  } catch { /* best effort */ }
}

// ---- validation (fail-closed) -------------------------------------------------

const CLOCK_SKEW_MS = 60_000; // small allowance for issuedAt slightly in the future

// expect: { repo, taskRef, stateDigest } — the executor's CURRENT canonical
// binding. Envelope fields mirror #63 advisor.ask + instruction/issuedAt.
export function validateGptDecision(envelope, expect, { stateDir, now = new Date(), ttlMs = 15 * 60_000 } = {}) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    recordTelemetry({ kind: 'REJECTED', code: 'ENVELOPE_MALFORMED' }, { stateDir });
    return { ok: false, code: 'ENVELOPE_MALFORMED', message: 'decision envelope must be a JSON object' };
  }
  const required = ['requestId', 'repo', 'taskRef', 'stateDigest', 'decision', 'issuedAt', 'instruction'];
  for (const k of required) {
    if (!(k in envelope) || envelope[k] === null || envelope[k] === undefined) {
      recordTelemetry({ kind: 'REJECTED', code: 'MISSING_FIELD', field: k }, { stateDir });
      return { ok: false, code: 'MISSING_FIELD', field: k };
    }
  }
  for (const k of required) {
    if (typeof envelope[k] !== 'string' || envelope[k].length === 0) {
      recordTelemetry({ kind: 'REJECTED', code: 'FIELD_INVALID', field: k }, { stateDir });
      return { ok: false, code: 'FIELD_INVALID', field: k, message: 'must be a non-empty string' };
    }
  }
  if (envelope.executorHint !== undefined && envelope.executorHint !== null && (typeof envelope.executorHint !== 'string' || envelope.executorHint.length > HINT_MAX_CHARS)) {
    recordTelemetry({ kind: 'REJECTED', code: 'FIELD_INVALID', field: 'executorHint' }, { stateDir });
    return { ok: false, code: 'FIELD_INVALID', field: 'executorHint', message: `optional string <= ${HINT_MAX_CHARS} chars` };
  }
  const instrBytes = Buffer.byteLength(envelope.instruction, 'utf8');
  if (instrBytes > INSTRUCTION_MAX_BYTES) {
    recordTelemetry({ kind: 'REJECTED', code: 'INSTRUCTION_TOO_LARGE', bytes: instrBytes }, { stateDir });
    return { ok: false, code: 'INSTRUCTION_TOO_LARGE', bytes: instrBytes, maxBytes: INSTRUCTION_MAX_BYTES };
  }
  if (!REQUEST_ID_RE.test(envelope.requestId)) {
    recordTelemetry({ kind: 'REJECTED', code: 'FIELD_INVALID', field: 'requestId' }, { stateDir });
    return { ok: false, code: 'FIELD_INVALID', field: 'requestId', message: '8..128 chars [A-Za-z0-9._:@-]' };
  }
  if (!REPO_RE.test(envelope.repo)) {
    recordTelemetry({ kind: 'REJECTED', code: 'FIELD_INVALID', field: 'repo' }, { stateDir });
    return { ok: false, code: 'FIELD_INVALID', field: 'repo' };
  }
  if (!TASK_REF_RE.test(envelope.taskRef)) {
    recordTelemetry({ kind: 'REJECTED', code: 'FIELD_INVALID', field: 'taskRef' }, { stateDir });
    return { ok: false, code: 'FIELD_INVALID', field: 'taskRef' };
  }
  if (!SHA256_RE.test(envelope.stateDigest.toLowerCase())) {
    recordTelemetry({ kind: 'REJECTED', code: 'FIELD_INVALID', field: 'stateDigest' }, { stateDir });
    return { ok: false, code: 'FIELD_INVALID', field: 'stateDigest', message: 'sha256 hex 64' };
  }
  if (!DECISIONS.includes(envelope.decision)) {
    recordTelemetry({ kind: 'REJECTED', code: 'FIELD_INVALID', field: 'decision', value: envelope.decision.slice(0, 64) }, { stateDir });
    return { ok: false, code: 'FIELD_INVALID', field: 'decision', message: `must be one of ${DECISIONS.join('|')}` };
  }
  if (!ISO_TS_RE.test(envelope.issuedAt) || Number.isNaN(Date.parse(envelope.issuedAt))) {
    recordTelemetry({ kind: 'REJECTED', code: 'FIELD_INVALID', field: 'issuedAt' }, { stateDir });
    return { ok: false, code: 'FIELD_INVALID', field: 'issuedAt', message: 'ISO-8601 timestamp' };
  }

  // Echo binding: GPT must echo the executor's binding EXACTLY.
  for (const k of ['repo', 'taskRef', 'stateDigest']) {
    if (envelope[k] !== expect[k]) {
      recordTelemetry({ kind: 'REJECTED', code: 'BINDING_MISMATCH', field: k }, { stateDir });
      return { ok: false, code: 'BINDING_MISMATCH', field: k, expected: String(expect[k]).slice(0, 80), got: String(envelope[k]).slice(0, 80) };
    }
  }

  // Stale-state + TTL guard: the decision must be fresh AND bound to the
  // executor's current state. STALE_STATE_DIGEST comes from expect mismatch at
  // the CALLER level (waiter passes its live digest as expect.stateDigest, so
  // a mismatch surfaces as BINDING_MISMATCH on stateDigest — same failure,
  // one code path). EXPIRED_DECISION covers wall-clock staleness.
  const ageMs = now.getTime() - Date.parse(envelope.issuedAt);
  if (!Number.isFinite(ageMs) || ageMs < -CLOCK_SKEW_MS || ageMs > ttlMs) {
    recordTelemetry({ kind: 'REJECTED', code: 'EXPIRED_DECISION', ageMs }, { stateDir });
    return { ok: false, code: 'EXPIRED_DECISION', ageMs, ttlMs };
  }

  // Replay guard LAST among cheap checks; recording is a side effect.
  const replay = checkAndRecordRequestId(envelope.requestId, { stateDir });
  if (!replay.ok) {
    recordTelemetry({ kind: 'REJECTED', code: replay.code, requestId: envelope.requestId }, { stateDir });
    return { ok: false, code: replay.code, detail: replay.detail ?? null };
  }

  recordTelemetry({ kind: 'ACCEPTED', requestId: envelope.requestId, decision: envelope.decision }, { stateDir });
  return { ok: true, envelope };
}

// ---- canonical state digest ----------------------------------------------------

// The state text the executor binds to: branch/head/dirty/step. GPT decisions
// are only valid against the exact state the executor is in (anti-stale).
export function canonicalStateText({ repo, taskRef, branch, head, dirty, step }) {
  return JSON.stringify({ repo, taskRef, branch, head, dirty, step }, null, 0);
}