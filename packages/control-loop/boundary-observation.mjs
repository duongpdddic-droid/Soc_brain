// boundary-observation.mjs — the transport stage-observation SENTINEL and its
// provenance derive (REC-01 rework round 2, F2-src).
//
// WHY THIS EXISTS: a caller-supplied {phase, submitState} object is a CLAIM,
// never proof. The proof of a pre-submit boundary is what the transport stage
// tracker OBSERVED at failure time, recorded as a machine-readable marker line
// inside the EVIDENCE file the reconciliation record binds by sha256:
//
//   soc-transport-stage-observation {"kind":"soc-transport-stage-observation",...}
//
// The line carries {kind, source, stage, phase, submitState, observedAt, code}
// where `code` is the transport error code of the checkpoint it proves (e.g.
// CDP_SEND_TIMEOUT). The writer derives the observation FROM this line and
// stores the derived observation into the record; the seal and the reader
// re-derive it, so a planted, correctly-shaped record whose evidence carries
// no marker (or a contradicting one) is an honest typed block — never a
// fabricated observation, never a silent retry.
//
// LEAF MODULE (no imports of the control loop): the raw transport emits the
// line and the writer/reader/seal/tests consume it, so the format lives in one
// cycle-free place.
import fs from 'node:fs';

export const STAGE_OBSERVATION_PREFIX = 'soc-transport-stage-observation ';
export const STAGE_OBSERVATION_KIND = 'soc-transport-stage-observation';

// Upper bound on how far an observation may sit in the future of its evidence
// or its checkpoint before the timestamp is refused as unprovable.
export const OBSERVATION_MAX_FUTURE_MS = 5 * 60 * 1000;

// Build ONE marker line (no trailing newline). Defaults describe the canonical
// proven pre-submit shape observed at the PRE_SUBMIT_SNAPSHOT stage; callers
// override fields for their exact fixture/transport stage.
export function stageObservationLine(over = {}) {
  const line = {
    kind: STAGE_OBSERVATION_KIND,
    source: 'transport-stage-tracker',
    stage: 'PRE_SUBMIT_SNAPSHOT',
    phase: 'PRE_SUBMIT',
    submitState: 'NOT_SUBMITTED',
    observedAt: new Date().toISOString(),
    code: 'CDP_SEND_TIMEOUT',
    ...over,
  };
  return STAGE_OBSERVATION_PREFIX + JSON.stringify(line);
}

// Derive the boundary observation a record may claim, FROM the evidence bytes.
// Returns { ok:true, observation } or { ok:false, reason, detail? } with a
// typed reason (every caller surfaces it verbatim in its own refusal):
//   EVIDENCE_FILE_MISSING        - no bytes to derive from
//   OBSERVATION_UNPROVEN         - no parseable marker line at all
//   OBSERVATION_SOURCE_INVALID   - marker present but incomplete/unparseable
//   OBSERVATION_CHECKPOINT_MISMATCH - marker code is not THIS checkpoint's
//   OBSERVATION_TIMESTAMP_INVALID   - observedAt is not a believable instant
export function derivePreSubmitObservationFromEvidence({ evidenceBuf = null, evidencePath = null, checkpoint = null } = {}) {
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

  // The LAST parseable marker line wins (a log may carry several stages). The
  // marker may be embedded after a logger prefix (e.g. '[gemini-web2api-raw] '),
  // so locate it inside the line instead of demanding the line start with it.
  let found = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const idx = rawLine.indexOf(STAGE_OBSERVATION_PREFIX);
    if (idx < 0) continue;
    try {
      const obj = JSON.parse(rawLine.slice(idx + STAGE_OBSERVATION_PREFIX.length));
      if (obj && typeof obj === 'object' && !Array.isArray(obj) && obj.kind === STAGE_OBSERVATION_KIND) found = obj;
    } catch {
      // unparsable candidate: keep scanning for a later valid marker line
    }
  }
  if (!found) {
    return {
      ok: false,
      reason: 'OBSERVATION_UNPROVEN',
      detail: {
        note: 'the evidence carries no transport stage-observation marker line: a legacy checkpoint without a proven observation is an honest typed block, never a fabricated observation',
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
  const observedAtMs = Date.parse(observedAt);
  if (Number.isNaN(observedAtMs)) {
    return { ok: false, reason: 'OBSERVATION_SOURCE_INVALID', detail: { note: 'observedAt is not a parseable timestamp', observedAt } };
  }
  // The marker must prove THIS checkpoint: its transport code equals the
  // checkpoint evidence (evidence -> checkpoint binding, checked before time).
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
  return {
    ok: true,
    observation: { stage, phase, submitState, observedAt, source, code },
  };
}
