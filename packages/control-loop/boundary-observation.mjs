// boundary-observation.mjs — the transport stage-observation SENTINEL and its
// provenance derive (REC-01 rework round 2, F2-src; round 3 binding + latest
// marker discipline).
//
// WHY THIS EXISTS: a caller-supplied {phase, submitState} object is a CLAIM,
// never proof. The proof of a pre-submit boundary is what the transport stage
// tracker OBSERVED at failure time, recorded as a machine-readable marker line
// inside the EVIDENCE file the reconciliation record binds by sha256:
//
//   soc-transport-stage-observation {"kind":"soc-transport-stage-observation",...}
//
// The line carries {kind, source, identityHash, attemptId, stage, phase,
// submitState, observedAt, code} where:
//   * identityHash - the CANONICAL identity of the session the transport was
//     observing: the writer/seal/reader re-derive only for that identity, so
//     a same-code marker of another session is an honest typed block;
//   * attemptId    - the TRANSPORT ATTEMPT the marker was emitted for (minted
//     per raw-transport invocation). When the checkpoint being reconciled
//     carries an attempt linkage (checkpoint.attemptId) it must match - an
//     old attempt's marker never proves another attempt's checkpoint;
//   * code         - the transport error code of the checkpoint it proves
//     (e.g. CDP_SEND_TIMEOUT). The code is checked, but NEVER sufficient on
//     its own: identity + attempt + trusted source + stage mapping + time
//     window together bind the marker to the checkpoint being reconciled;
//   * stage/phase/submitState - validated against the canonical stage map, so
//     stage SUBMIT_IN_FLIGHT can never be presented as PRE_SUBMIT/NOT_SUBMITTED.
//
// LATEST MARKER DISCIPLINE (round 3): the LAST marker line in the evidence
// decides. A malformed, field-less, foreign or boundary-breaking final marker
// is a typed block - the derive never skips backwards to an earlier PRE_SUBMIT
// line. Legacy evidence with no marker (or a marker without the
// identity/attempt linkage) stays an honest typed block: linkage fields are
// never backfilled retroactively.
//
// LEAF MODULE (no imports of the control loop): the raw transport emits the
// line and the writer/reader/seal/tests consume it, so the format lives in one
// cycle-free place.
import fs from 'node:fs';

export const STAGE_OBSERVATION_PREFIX = 'soc-transport-stage-observation ';
export const STAGE_OBSERVATION_KIND = 'soc-transport-stage-observation';

// Only the transport stage tracker may author a marker line (round 3: the
// source is VALIDATED, not merely required to be non-empty).
export const STAGE_OBSERVATION_SOURCES = Object.freeze(['transport-stage-tracker']);

// Canonical stage -> {phase, submitState} map of the transport stage tracker.
// The marker's triple must be internally consistent with it; anything else
// (e.g. stage SUBMIT_IN_FLIGHT claiming PRE_SUBMIT/NOT_SUBMITTED) is typed.
export const STAGE_OBSERVATION_STAGE_MAP = Object.freeze({
  TARGET_SETUP: Object.freeze({ phase: 'PRE_SUBMIT', submitState: 'NOT_SUBMITTED' }),
  PRE_SUBMIT_SNAPSHOT: Object.freeze({ phase: 'PRE_SUBMIT', submitState: 'NOT_SUBMITTED' }),
  SUBMIT_IN_FLIGHT: Object.freeze({ phase: 'SUBMIT', submitState: 'UNKNOWN' }),
  POST_SUBMIT_TURN_WAIT: Object.freeze({ phase: 'POST_SUBMIT', submitState: 'POST_SUBMIT' }),
  POLL: Object.freeze({ phase: 'POST_SUBMIT', submitState: 'POST_SUBMIT' }),
});

// Upper bound on how far an observation may sit in the future of its evidence
// or its checkpoint before the timestamp is refused as unprovable.
export const OBSERVATION_MAX_FUTURE_MS = 5 * 60 * 1000;
// Round 3: the mirror bound. A marker observed longer before the checkpoint
// being reconciled belongs to an OLDER transport attempt and can never prove
// this checkpoint (marker of an old attempt -> typed block).
export const OBSERVATION_MAX_PAST_MS = 5 * 60 * 1000;

// Build ONE marker line (no trailing newline). Defaults describe the canonical
// proven pre-submit shape observed at the PRE_SUBMIT_SNAPSHOT stage; callers
// override fields for their exact fixture/transport stage. The BINDING fields
// (identityHash, attemptId) have NO default: a caller that does not bind the
// marker to a canonical identity and a transport attempt emits an UNBOUND
// line, and the derive types it (never a silent fallback).
export function stageObservationLine(over = {}) {
  const { identityHash, attemptId, ...rest } = over || {};
  const line = {
    kind: STAGE_OBSERVATION_KIND,
    source: 'transport-stage-tracker',
    stage: 'PRE_SUBMIT_SNAPSHOT',
    phase: 'PRE_SUBMIT',
    submitState: 'NOT_SUBMITTED',
    observedAt: new Date().toISOString(),
    code: 'CDP_SEND_TIMEOUT',
    ...rest,
  };
  if (typeof identityHash === 'string' && identityHash.trim()) line.identityHash = identityHash;
  if (typeof attemptId === 'string' && attemptId.trim()) line.attemptId = attemptId;
  return STAGE_OBSERVATION_PREFIX + JSON.stringify(line);
}

// Derive the boundary observation a record may claim, FROM the evidence bytes.
// Returns { ok:true, observation } or { ok:false, reason, detail? } with a
// typed reason (every caller surfaces it verbatim in its own refusal):
//   EVIDENCE_FILE_MISSING          - no bytes to derive from
//   OBSERVATION_UNPROVEN           - no parseable marker line at all
//   OBSERVATION_MALFORMED          - the LAST marker line is broken (bad JSON /
//                                    wrong kind): the final marker decides, an
//                                    older PRE_SUBMIT line is never a fallback
//   OBSERVATION_SOURCE_INVALID     - marker present but incomplete/unparseable,
//                                    or authored by an untrusted source
//   OBSERVATION_BINDING_MISSING    - legacy marker without the canonical
//                                    identity/attempt linkage (never backfilled)
//   OBSERVATION_IDENTITY_MISMATCH  - marker bound to another canonical identity
//   OBSERVATION_STAGE_MISMATCH     - stage/phase/submitState not a consistent
//                                    triple of the canonical stage map
//   OBSERVATION_ATTEMPT_MISMATCH   - marker attempt != the checkpoint's attempt
//   OBSERVATION_CHECKPOINT_MISMATCH- marker code is not THIS checkpoint's
//   OBSERVATION_TIMESTAMP_INVALID  - observedAt outside the checkpoint window
export function derivePreSubmitObservationFromEvidence({ evidenceBuf = null, evidencePath = null, checkpoint = null, identityHash = null } = {}) {
  let buf = evidenceBuf;
  if (buf === null || buf === undefined) {
    if (typeof evidencePath !== 'string' || !evidencePath.trim()) {
      return { ok: false, reason: 'EVIDENCE_FILE_MISSING' };
    }
    try {
      buf = fs.readFileSync(evidencePath);
    } catch {
      return { ok: false, reason: 'EVIDENCE_FILE_MISSING', detail: { path: evidencePath } };
    }
  }
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  const cpEvidence = checkpoint && typeof checkpoint.evidence === 'string' && checkpoint.evidence ? checkpoint.evidence : null;
  const cpTsMs = checkpoint && typeof checkpoint.ts === 'string' ? Date.parse(checkpoint.ts) : NaN;
  const cpAttemptId = checkpoint && typeof checkpoint.attemptId === 'string' && checkpoint.attemptId.trim() ? checkpoint.attemptId : null;

  // LATEST MARKER DISCIPLINE (round 3): the LAST marker-prefixed line in the
  // evidence decides - it is parsed STRICTLY and a broken final line blocks
  // (a log may carry several stages/attempts, but the reconciler may never
  // skip backwards to an older PRE_SUBMIT marker). The marker may be embedded
  // after a logger prefix (e.g. '[gemini-web2api-raw] '), so locate it inside
  // the line instead of demanding the line start with it.
  let lastRaw = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const idx = rawLine.indexOf(STAGE_OBSERVATION_PREFIX);
    if (idx < 0) continue;
    lastRaw = rawLine.slice(idx + STAGE_OBSERVATION_PREFIX.length);
  }
  if (lastRaw === null) {
    return {
      ok: false,
      reason: 'OBSERVATION_UNPROVEN',
      detail: {
        note: 'the evidence carries no transport stage-observation marker line: a legacy checkpoint without a proven observation is an honest typed block, never a fabricated observation',
      },
    };
  }
  let found = null;
  try {
    const parsed = JSON.parse(lastRaw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.kind === STAGE_OBSERVATION_KIND) {
      found = parsed;
    }
  } catch {
    found = null;
  }
  if (!found) {
    return {
      ok: false,
      reason: 'OBSERVATION_MALFORMED',
      detail: {
        note: 'the LAST stage-observation marker line is malformed (unparsable JSON or wrong kind): the final marker decides, so an earlier PRE_SUBMIT marker is never used as a fallback',
        line: String(lastRaw).slice(0, 300),
      },
    };
  }
  const stage = typeof found.stage === 'string' && found.stage ? found.stage : null;
  const phase = typeof found.phase === 'string' && found.phase ? found.phase : null;
  const submitState = typeof found.submitState === 'string' && found.submitState ? found.submitState : null;
  const observedAt = typeof found.observedAt === 'string' && found.observedAt ? found.observedAt : null;
  const source = typeof found.source === 'string' && found.source.trim() ? found.source : null;
  const code = typeof found.code === 'string' && found.code ? found.code : null;
  if (!stage || !phase || !submitState || !observedAt || !source || !code) {
    return {
      ok: false,
      reason: 'OBSERVATION_SOURCE_INVALID',
      detail: {
        note: 'the stage-observation marker line is incomplete (stage/phase/submitState/observedAt/source/code are all required)',
        line: { stage, phase, submitState, observedAt, source, code },
      },
    };
  }
  // BINDING (round 3): the marker must name the canonical identity and the
  // transport attempt it was emitted for. A legacy marker without the linkage
  // is an honest typed block - the fields are never backfilled retroactively.
  const markerIdentity = typeof found.identityHash === 'string' && found.identityHash.trim() ? found.identityHash : null;
  const markerAttemptId = typeof found.attemptId === 'string' && found.attemptId.trim() ? found.attemptId : null;
  if (!markerIdentity || !markerAttemptId) {
    return {
      ok: false,
      reason: 'OBSERVATION_BINDING_MISSING',
      detail: {
        note: 'the stage-observation marker carries no canonical identityHash/attemptId linkage: it cannot be bound to THIS checkpoint and is never backfilled retroactively',
        identityHash: markerIdentity,
        attemptId: markerAttemptId,
      },
    };
  }
  // The source must be the trusted transport stage tracker (validated, not
  // merely non-empty): a pasted/foreign line never proves a boundary.
  if (!STAGE_OBSERVATION_SOURCES.includes(source)) {
    return {
      ok: false,
      reason: 'OBSERVATION_SOURCE_INVALID',
      detail: { source, allowed: [...STAGE_OBSERVATION_SOURCES], note: 'the marker was not authored by the trusted transport stage tracker' },
    };
  }
  const observedAtMs = Date.parse(observedAt);
  if (Number.isNaN(observedAtMs)) {
    return { ok: false, reason: 'OBSERVATION_SOURCE_INVALID', detail: { note: 'observedAt is not a parseable timestamp', observedAt } };
  }
  // IDENTITY BINDING: the marker must have been emitted while observing THIS
  // canonical identity - the code alone never binds a checkpoint.
  const expectedIdentity = typeof identityHash === 'string' && identityHash.trim() ? identityHash : null;
  if (!expectedIdentity) {
    return {
      ok: false,
      reason: 'OBSERVATION_IDENTITY_MISMATCH',
      detail: { markerIdentityHash: markerIdentity, note: 'no canonical identity was supplied to bind the marker against' },
    };
  }
  if (markerIdentity !== expectedIdentity) {
    return {
      ok: false,
      reason: 'OBSERVATION_IDENTITY_MISMATCH',
      detail: { expectedIdentityHash: expectedIdentity, markerIdentityHash: markerIdentity, note: 'the marker is bound to another canonical identity (same error code is never sufficient)' },
    };
  }
  // STAGE MAPPING: stage/phase/submitState must be a consistent triple of the
  // canonical map - a SUBMIT_IN_FLIGHT stage can never claim PRE_SUBMIT.
  const mapped = Object.prototype.hasOwnProperty.call(STAGE_OBSERVATION_STAGE_MAP, stage) ? STAGE_OBSERVATION_STAGE_MAP[stage] : null;
  if (!mapped || mapped.phase !== phase || mapped.submitState !== submitState) {
    return {
      ok: false,
      reason: 'OBSERVATION_STAGE_MISMATCH',
      detail: {
        stage,
        phase,
        submitState,
        expected: mapped ? { phase: mapped.phase, submitState: mapped.submitState } : null,
        note: 'the marker triple is not consistent with the canonical transport stage map',
      },
    };
  }
  // ATTEMPT LINKAGE: when the checkpoint being reconciled carries an attempt
  // linkage, the marker must be the one this attempt emitted.
  if (cpAttemptId && markerAttemptId !== cpAttemptId) {
    return {
      ok: false,
      reason: 'OBSERVATION_ATTEMPT_MISMATCH',
      detail: { checkpointAttemptId: cpAttemptId, markerAttemptId, note: 'the marker belongs to another transport attempt than the checkpoint being reconciled (same error code is never sufficient)' },
    };
  }
  // The marker must prove THIS checkpoint: its transport code equals the
  // checkpoint evidence (evidence -> checkpoint binding, checked after the
  // identity/attempt/source/stage binding above; never alone).
  if (cpEvidence && code !== cpEvidence) {
    return {
      ok: false,
      reason: 'OBSERVATION_CHECKPOINT_MISMATCH',
      detail: { checkpointEvidence: cpEvidence, markerCode: code, note: 'the marker line must carry the transport code of the checkpoint it claims to prove' },
    };
  }
  const nowMs = Date.now();
  if (observedAtMs > nowMs + OBSERVATION_MAX_FUTURE_MS) {
    return { ok: false, reason: 'OBSERVATION_TIMESTAMP_INVALID', detail: { observedAt, note: 'the observation timestamp lies in the future' } };
  }
  if (!Number.isNaN(cpTsMs) && observedAtMs > cpTsMs + OBSERVATION_MAX_FUTURE_MS) {
    return {
      ok: false,
      reason: 'OBSERVATION_TIMESTAMP_INVALID',
      detail: { observedAt, checkpointTs: checkpoint.ts, note: 'the observation was not made within 5 minutes of the checkpoint it claims to prove' },
    };
  }
  // Round 3 (old marker -> new checkpoint): the marker must also sit within
  // the attempt window BEFORE the checkpoint - an observation from an older
  // transport attempt never proves this checkpoint.
  if (!Number.isNaN(cpTsMs) && observedAtMs < cpTsMs - OBSERVATION_MAX_PAST_MS) {
    return {
      ok: false,
      reason: 'OBSERVATION_TIMESTAMP_INVALID',
      detail: { observedAt, checkpointTs: checkpoint.ts, note: 'the observation predates the checkpoint by more than the attempt window: it belongs to an older transport attempt' },
    };
  }
  return {
    ok: true,
    observation: { stage, phase, submitState, observedAt, source, code, identityHash: markerIdentity, attemptId: markerAttemptId },
  };
}
