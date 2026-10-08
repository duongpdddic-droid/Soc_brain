// packages/control-loop/step-contract.mjs — in-flight step-transition contract:
// schema, preflight validator and the remediation loop behind `.soc/step-state.json`.
//
// PHILOSOPHY (Remediation over Blocking): a step preflight that finds MISSING
// or INVALID required fields never hard-stops and never writes BLOCKED. It
// returns a typed REMEDIATION_REQUIRED record naming the exact gap so the
// executor fills it in place and re-attempts; the very attempt whose fields
// all pass returns READY and the transition proceeds. Nothing here performs a
// lifecycle transition or grants authority — it is the coordination ledger the
// Executor and the Soc Control Loop read BEFORE crossing a step boundary.
//
// WHAT THIS IS NOT:
//   - not a second FSM: LOOP_STATES/ALLOWED_TRANSITIONS in control-loop.mjs
//     stay canonical (T11 keeps this catalog mirrored against them);
//   - not a writer of sessions/ledgers/evidence: it only owns
//     `.soc/step-state.json` (atomic tmp+rename, unique temp per writer);
//   - never BLOCKED: STEP_STATE_STATUSES has no BLOCKED member by construction.
//
// Record shape (schemaVersion '1'):
//   status         'READY' | 'REMEDIATION_REQUIRED'
//   sessionPhase   'IN_STEP' | 'AWAITING_FIELDS'
//   currentStep    holding step (the step we are at / did not leave)
//   targetStep     attempted step, null once READY
//   missingFields  required fields of targetStep not yet collected
//   invalidFields  field -> REASON (present but wrong format; raw value NEVER echoed)
//   remediationHint  short, deterministic fill-in instruction
//   collectedFields   validated values, merged additively across attempts
//   updatedAt      ISO timestamp (injectable now() for deterministic tests)

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const STEP_CONTRACT_SCHEMA_VERSION = '1';
export const STEP_STATE_RELATIVE_PATH = '.soc/step-state.json';
// No BLOCKED member by construction: a held transition is always remediable.
export const STEP_STATE_STATUSES = Object.freeze(['READY', 'REMEDIATION_REQUIRED']);
export const STEP_SESSION_PHASES = Object.freeze(['IN_STEP', 'AWAITING_FIELDS']);

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// Format registry — one label per format, reused by preflight reasons, the
// remediation hint and the generated guide (single source of truth).
export const FIELD_FORMATS = Object.freeze({
  sha40: { id: 'sha40', label: '40-hex SHA' },
  sha256: { id: 'sha256', label: 'SHA-256 hash (64-hex)' },
  pid: { id: 'pid', label: 'integer PID' },
  exitCode: { id: 'exitCode', label: 'non-negative integer exit code' },
  path: { id: 'path', label: 'path (non-empty string, no NUL)' },
  repo: { id: 'repo', label: 'owner/name repository string' },
  positiveInt: { id: 'positiveInt', label: 'positive integer' },
  string: { id: 'string', label: 'non-empty string' },
  enum: { id: 'enum', label: 'closed enum (case-sensitive)' },
});

// Field registry — a field's format is global; steps reference field names.
// Only registered, format-valid values are ever collected (invalid values are
// reported as reasons, never persisted).
export const FIELDS = Object.freeze({
  repo: { format: 'repo', description: 'target repository (owner/name)' },
  issueNumber: { format: 'positiveInt', description: 'GitHub issue number of the task' },
  branch: { format: 'string', description: 'task branch to push / review' },
  headSha: { format: 'sha40', description: '40-hex SHA of the candidate HEAD under evaluation' },
  worktreePath: { format: 'path', description: 'absolute path of the isolated task worktree' },
  executorPid: { format: 'pid', description: 'integer PID of the owning executor process' },
  exitCode: { format: 'exitCode', description: 'exit code of the required verification gate' },
  contentDigest: { format: 'sha256', description: 'SHA-256 digest of the reviewed content bundle' },
  reviewRunId: { format: 'string', description: 'run id of the internal/final review invocation' },
  verdict: { format: 'enum', values: ['PASS', 'REWORK', 'BLOCKED'], description: 'normalized reviewer verdict' },
  reworkReason: { format: 'string', description: 'short reason recorded for the rework leg' },
  pullRequest: { format: 'positiveInt', description: 'pull request number carrying the delivery' },
  reason: { format: 'string', description: 'escalation reason recorded with the state' },
});

// Format test per format id. Returns { valid, reason, value } where value is
// the normalized (collected) value and reason is a REASON without the raw
// input (it may hold a path or a secret — same F1 discipline as the checklist).
function testFormat(formatId, raw, values) {
  const fail = (reason) => ({ valid: false, reason, value: null });
  const typeOf = typeof raw;
  switch (formatId) {
    case 'sha40': {
      if (typeOf !== 'string') return fail(`not a 40-hex SHA (received ${typeOf})`);
      const s = raw.toLowerCase();
      return HEX40.test(s) ? { valid: true, reason: null, value: s } : fail('not a 40-hex SHA');
    }
    case 'sha256': {
      if (typeOf !== 'string') return fail(`not a SHA-256 hash (received ${typeOf})`);
      const s = raw.toLowerCase();
      return HEX64.test(s) ? { valid: true, reason: null, value: s } : fail('not a SHA-256 hash (64-hex)');
    }
    case 'pid': {
      if (typeOf !== 'number') return fail(`not an integer PID (received ${typeOf})`);
      return Number.isInteger(raw) && raw > 0 ? { valid: true, reason: null, value: raw } : fail('not an integer PID (> 0)');
    }
    case 'exitCode': {
      if (typeOf !== 'number') return fail(`not a non-negative integer exit code (received ${typeOf})`);
      return Number.isInteger(raw) && raw >= 0 ? { valid: true, reason: null, value: raw } : fail('not a non-negative integer exit code');
    }
    case 'path': {
      if (typeOf !== 'string') return fail(`not a path (received ${typeOf})`);
      if (raw.trim() === '') return fail('not a path (empty)');
      if (raw.includes('\u0000')) return fail('not a path (contains NUL)');
      return { valid: true, reason: null, value: raw };
    }
    case 'repo': {
      if (typeOf !== 'string') return fail(`not an owner/name repository (received ${typeOf})`);
      return REPO_RE.test(raw) ? { valid: true, reason: null, value: raw } : fail('not an owner/name repository string');
    }
    case 'positiveInt': {
      if (typeOf !== 'number') return fail(`not a positive integer (received ${typeOf})`);
      return Number.isInteger(raw) && raw > 0 ? { valid: true, reason: null, value: raw } : fail('not a positive integer');
    }
    case 'string': {
      if (typeOf !== 'string') return fail(`not a non-empty string (received ${typeOf})`);
      return raw.trim() !== '' ? { valid: true, reason: null, value: raw } : fail('not a non-empty string');
    }
    case 'enum': {
      if (typeOf !== 'string') return fail(`not one of ${(values || []).join('|')} (received ${typeOf})`);
      return (values || []).includes(raw) ? { valid: true, reason: null, value: raw }
        : fail(`not one of ${(values || []).join('|')}`);
    }
    default:
      return fail('unknown format');
  }
}

// Validate ONE value against the global field registry. Unregistered fields
// are never collectable (they cannot be checked, so they cannot be trusted).
export function validateField(name, raw) {
  const spec = FIELDS[name];
  if (!spec) return { valid: false, reason: `unknown field (not in the step contract registry)`, value: null };
  return testFormat(spec.format, raw, spec.values);
}

// Per-step catalog: canonical loop state, prerequisites (mirrored from
// ALLOWED_TRANSITIONS by test T11) and the full required-field list with
// format labels resolved through the registry.
export const STEP_CONTRACT = Object.freeze([
  Object.freeze({ name: 'ACCEPTED', prerequisites: Object.freeze([]), fields: Object.freeze(['repo', 'issueNumber']) }),
  Object.freeze({ name: 'ROUTED', prerequisites: Object.freeze(['ACCEPTED']), fields: Object.freeze(['branch', 'headSha']) }),
  Object.freeze({ name: 'EXECUTING', prerequisites: Object.freeze(['ROUTED', 'REWORK']), fields: Object.freeze(['worktreePath', 'executorPid']) }),
  Object.freeze({ name: 'VERIFYING', prerequisites: Object.freeze(['EXECUTING']), fields: Object.freeze(['headSha', 'exitCode', 'contentDigest']) }),
  Object.freeze({ name: 'PRE_REVIEWING', prerequisites: Object.freeze(['VERIFYING']), fields: Object.freeze(['headSha', 'contentDigest']) }),
  Object.freeze({ name: 'FINAL_REVIEWING', prerequisites: Object.freeze(['PRE_REVIEWING']), fields: Object.freeze(['headSha', 'contentDigest', 'reviewRunId']) }),
  Object.freeze({ name: 'DECIDING', prerequisites: Object.freeze(['FINAL_REVIEWING']), fields: Object.freeze(['headSha', 'verdict']) }),
  Object.freeze({ name: 'REWORK', prerequisites: Object.freeze(['VERIFYING', 'DECIDING', 'BLOCKED']), fields: Object.freeze(['headSha', 'reworkReason']) }),
  Object.freeze({ name: 'DELIVERING', prerequisites: Object.freeze(['DECIDING']), fields: Object.freeze(['headSha', 'pullRequest']) }),
  Object.freeze({ name: 'COMPLETED', prerequisites: Object.freeze(['DELIVERING']), fields: Object.freeze(['headSha', 'contentDigest']) }),
  Object.freeze({ name: 'BLOCKED', prerequisites: Object.freeze(['ACCEPTED', 'ROUTED', 'EXECUTING', 'VERIFYING', 'PRE_REVIEWING', 'FINAL_REVIEWING', 'DECIDING', 'REWORK', 'DELIVERING']), fields: Object.freeze(['reason']) }),
]);

export function stepByName(name) {
  return STEP_CONTRACT.find((s) => s.name === name) ?? null;
}

function formatLabel(fieldName) {
  const spec = FIELDS[fieldName];
  if (!spec) return 'unregistered field';
  const fmt = FIELD_FORMATS[spec.format];
  return fmt ? fmt.label : spec.format;
}

function buildHint(missing, invalid) {
  const parts = [];
  if (missing.length) {
    parts.push(`supply missing field(s): ${missing.map((f) => `${f} (${formatLabel(f)})`).join(', ')}`);
  }
  const inv = Object.entries(invalid);
  if (inv.length) {
    parts.push(`fix invalid field(s): ${inv.map(([f, reason]) => `${f} — ${reason}`).join(', ')}`);
  }
  return `${parts.join('; ')}. Re-run the SAME transition with the corrected fields — collected fields are kept, `
    + `the session stays AWAITING_FIELDS until the preflight passes; no restart needed.`;
}

// Core preflight (pure — reads/writes nothing). Typed outcomes:
//   { ok: true,  value: READY record }
//   { ok: false, code: 'REMEDIATION_REQUIRED', value: held record }
//   { ok: false, code: 'STEP_UNKNOWN' | 'STEP_TRANSITION_INVALID', detail }
// Missing/invalid fields are classified, never collapsed (F1): absent =>
// missingFields, present-but-wrong-format => invalidFields with a reason and
// the raw value is never echoed.
// Tolerates a non-object argument (null => {}) instead of throwing — this
// module's contract is typed results, never a destructuring TypeError.
export function preflightStepTransition(args) {
  const {
    from, to, fields = {}, now = () => new Date().toISOString(),
  } = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const target = stepByName(to);
  if (!stepByName(from) || !target) {
    return { ok: false, code: 'STEP_UNKNOWN', detail: { from: from ?? null, to: to ?? null } };
  }
  if (!target.prerequisites.includes(from)) {
    return {
      ok: false,
      code: 'STEP_TRANSITION_INVALID',
      detail: { currentStep: from, targetStep: to, allowedFrom: [...target.prerequisites] },
    };
  }
  const supplied = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {};

  // Collect only registered, format-valid values (normalization included).
  const collected = {};
  for (const [name, raw] of Object.entries(supplied)) {
    if (raw === undefined || raw === null) continue;
    const r = validateField(name, raw);
    if (r.valid) collected[name] = r.value;
  }

  const missing = [];
  const invalid = {};
  for (const name of target.fields) {
    const provided = Object.prototype.hasOwnProperty.call(supplied, name)
      && supplied[name] !== undefined && supplied[name] !== null;
    if (provided) {
      const r = validateField(name, supplied[name]);
      if (!r.valid) invalid[name] = r.reason;
      continue;
    }
    if (collected[name] === undefined) missing.push(name);
  }

  const base = {
    schemaVersion: STEP_CONTRACT_SCHEMA_VERSION,
    currentStep: from,
    collectedFields: collected,
    updatedAt: now(),
  };
  if (missing.length || Object.keys(invalid).length) {
    return {
      ok: false,
      code: 'REMEDIATION_REQUIRED',
      value: {
        ...base,
        status: 'REMEDIATION_REQUIRED',
        sessionPhase: 'AWAITING_FIELDS',
        targetStep: to,
        missingFields: missing,
        invalidFields: invalid,
        remediationHint: buildHint(missing, invalid),
      },
    };
  }
  return {
    ok: true,
    value: {
      ...base,
      // READY means the transition is cleared: the record now sits ON the
      // target step (currentStep advanced), with no pending target.
      currentStep: to,
      status: 'READY',
      sessionPhase: 'IN_STEP',
      targetStep: null,
      missingFields: [],
      invalidFields: {},
      remediationHint: null,
    },
  };
}

export function stepStatePath(rootDir) {
  return path.join(rootDir, STEP_STATE_RELATIVE_PATH);
}

// Read the ledger by explicit file path. Missing file => ok:true with value
// null (absence is the normal pre-first-attempt state). Corrupt/unreadable =>
// ok:false typed code — the caller treats it as an empty collection
// (self-healing re-collection), never a hard stop.
export function readStepStateFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, value: null };
    return { ok: false, code: 'STEP_STATE_UNREADABLE', detail: String((e && e.message) || e) };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, code: 'STEP_STATE_UNREADABLE', detail: `not valid JSON: ${String((e && e.message) || e)}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'STEP_STATE_UNREADABLE', detail: 'not a JSON object' };
  }
  return { ok: true, value: parsed };
}

// Read the ledger under a root directory (the `.soc/step-state.json`
// convention every executor/loop call site uses). A non-string root is a typed
// refusal, never a path.join TypeError.
export function readStepState(rootDir) {
  if (typeof rootDir !== 'string' || !rootDir) {
    return { ok: false, code: 'STEP_STATE_ROOT_INVALID', detail: { rootDir: typeof rootDir } };
  }
  return readStepStateFile(stepStatePath(rootDir));
}

// Atomic write (unique tmp per writer + rename) so two concurrent attempts can
// never interleave bytes on one path — same discipline as the checklist.
export function writeStepState(rootDir, record) {
  if (typeof rootDir !== 'string' || !rootDir) {
    return { ok: false, code: 'STEP_STATE_ROOT_INVALID', detail: { rootDir: typeof rootDir } };
  }
  const file = stepStatePath(rootDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = path.join(path.dirname(file), `${randomUUID()}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, code: 'STEP_STATE_WRITE_FAILED', detail: String((e && e.message) || e) };
  }
}

// The remediation loop: merge prior collected fields with this attempt, run
// the preflight, persist the outcome (READY or REMEDIATION_REQUIRED) and hand
// the record back. STEP_UNKNOWN / STEP_TRANSITION_INVALID / a held-pair
// mismatch (STEP_REMEDIATION_PENDING) are typed refusals that never touch the
// ledger — a held remediation record survives them (invariant: no phantom
// transitions, no clobbering of the safe boundary).
export function attemptStepTransition(args) {
  const {
    rootDir, from, to, fields = {}, now = () => new Date().toISOString(),
  } = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (typeof rootDir !== 'string' || !rootDir) {
    return { ok: false, code: 'STEP_STATE_ROOT_INVALID', detail: { rootDir: typeof rootDir } };
  }
  const prior = readStepState(rootDir);
  const prevFields = prior.ok && prior.value && prior.value.collectedFields && typeof prior.value.collectedFields === 'object'
    ? prior.value.collectedFields
    : {};
  const supplied = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {};
  const merged = { ...prevFields };
  for (const [k, v] of Object.entries(supplied)) {
    if (v !== undefined && v !== null) merged[k] = v;
  }

  const result = preflightStepTransition({ from, to, fields: merged, now });
  if (!result.ok && result.code !== 'REMEDIATION_REQUIRED') return result;

  // Invariant (No Phantom State Transitions): while a REMEDIATION_REQUIRED
  // record is held for pair (A -> B), an attempt for a DIFFERENT pair may not
  // overwrite that safe boundary — the held pair must be remediated first.
  // Resuming the SAME pair (after filling fields) and re-running a READY pair
  // stay allowed, so the loop can never deadlock: every held pair is
  // resolvable by supplying its own fields.
  if (prior.ok && prior.value && prior.value.status === 'REMEDIATION_REQUIRED'
    && (from !== prior.value.currentStep || to !== prior.value.targetStep)) {
    return {
      ok: false,
      code: 'STEP_REMEDIATION_PENDING',
      detail: {
        held: { currentStep: prior.value.currentStep ?? null, targetStep: prior.value.targetStep ?? null },
        attempted: { currentStep: from ?? null, targetStep: to ?? null },
        remediationHint: prior.value.remediationHint ?? null,
      },
    };
  }

  const written = writeStepState(rootDir, result.value);
  if (!written.ok) return written;
  return { ...result, path: written.path };
}
