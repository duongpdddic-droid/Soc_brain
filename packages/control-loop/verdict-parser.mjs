// verdict-parser.mjs — Review verdict parser + decision normalizer (S4 completion).
//
// Single responsibility: turn the S4 final-review RESPONSE contract
// (review-payload.mjs requires the final line to be exactly
// `VERDICT: APPROVED | CHANGES_REQUESTED | BLOCKED`) into the canonical FSM
// decision shape control-loop.mjs decide() consumes
// ({ verdict: PASS | REWORK | BLOCKED, findings, evidenceRequests, binding }).
//
// Mapping (fixed, never inferred):
//   APPROVED          -> PASS     (DECIDING -> DELIVERING)
//   CHANGES_REQUESTED -> REWORK   (DECIDING -> REWORK rework leg)
//   BLOCKED           -> BLOCKED  (DECIDING -> BLOCKED terminal)
//
// Authority (hard invariant): this module is DATA-ONLY. It performs NO FSM
// transition, NO terminalization, NO dispatch and NO session write — the
// ControlLoop owns all of that. Structured FSM decisions (PASS/REWORK/BLOCKED)
// pass through BYTE-IDENTICAL (existing gates, e.g. the GPT echoed-binding
// gate, stay untouched); only raw textual/token verdicts are normalized here.
//
// Fail-closed: missing/ambiguous/malformed/non-final verdict lines, unknown
// verdict tokens, and unbound REWORK derivations all return a deterministic
// VERDICT_* failure — never a guessed verdict, never a silent PASS.
//
// Binding provenance: a TEXT-derived (or raw-token) verdict carries no
// reviewer identity echo — the S4 prompt does not ask for one. The binding is
// therefore stamped from the CANONICAL session record (loop-owned provenance,
// recorded as metadata.source = 'verdict-parser'), which the existing
// assertReworkBinding gate then re-verifies against the same session before
// any rework dispatch. Structured decisions are NEVER re-stamped.

export const VERDICT_PARSER_SCHEMA_VERSION = '1';

export const REVIEW_VERDICTS = Object.freeze(['APPROVED', 'CHANGES_REQUESTED', 'BLOCKED']);
export const FSM_VERDICTS = Object.freeze(['PASS', 'REWORK', 'BLOCKED']);
export const REVIEW_VERDICT_TO_FSM = Object.freeze({
  APPROVED: 'PASS',
  CHANGES_REQUESTED: 'REWORK',
  BLOCKED: 'BLOCKED',
});

export const VERDICT_PARSER_CODES = Object.freeze({
  VERDICT_INPUT_INVALID: 'VERDICT_INPUT_INVALID',
  VERDICT_NOT_FOUND: 'VERDICT_NOT_FOUND',
  VERDICT_NOT_FINAL: 'VERDICT_NOT_FINAL',
  VERDICT_AMBIGUOUS: 'VERDICT_AMBIGUOUS',
  VERDICT_TOKEN_INVALID: 'VERDICT_TOKEN_INVALID',
  VERDICT_DECISION_MISSING: 'VERDICT_DECISION_MISSING',
  VERDICT_TEXT_MISSING: 'VERDICT_TEXT_MISSING',
  VERDICT_UNKNOWN: 'VERDICT_UNKNOWN',
  VERDICT_SESSION_IDENTITY_MISSING: 'VERDICT_SESSION_IDENTITY_MISSING',
  VERDICT_BINDING_UNAVAILABLE: 'VERDICT_BINDING_UNAVAILABLE',
});

// Bounds mirror gpt-final-review.mjs's validator (50 findings x 500 chars) so
// a prose response cannot flood the rework record/instruction unbounded.
const MAX_FINDINGS = 50;
const MAX_FINDING_CHARS = 500;
const HEAD_SHA_40 = /^[0-9a-f]{40}$/i;
const STRICT_VERDICT_LINE = /^VERDICT: (APPROVED|CHANGES_REQUESTED|BLOCKED)$/;
const LOOSE_VERDICT_PREFIX = /^VERDICT:/;

function ok(value) { return { ok: true, value }; }
function fail(code, detail) { return { ok: false, code, detail: detail ?? null }; }

// Parse a raw final-review response: the FINAL non-empty line must be exactly
// one `VERDICT: <TOKEN>` line; exactly one such line may exist in the whole
// response (quoting the format elsewhere is ambiguous and fails closed).
export function parseReviewVerdict(text, { allowNonFinal = false } = {}) {
  if (typeof text !== 'string') {
    return fail(VERDICT_PARSER_CODES.VERDICT_INPUT_INVALID, `expected string, got ${text === null ? 'null' : typeof text}`);
  }
  if (!text.trim()) {
    return fail(VERDICT_PARSER_CODES.VERDICT_INPUT_INVALID, 'response text is empty');
  }
  let clean = text.trim();
  if (clean.startsWith('"') && clean.endsWith('"')) {
    try { clean = JSON.parse(clean); } catch {}
  }
  const lines = clean.split(/\r?\n/);
  const strict = [];
  const loose = [];
  let lastIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t) lastIdx = i;
    if (LOOSE_VERDICT_PREFIX.test(t)) loose.push(i);
    if (STRICT_VERDICT_LINE.test(t)) strict.push(i);
  }
  if (strict.length === 0) {
    if (loose.length === 0) {
      return fail(VERDICT_PARSER_CODES.VERDICT_NOT_FOUND, 'no VERDICT: line in the response');
    }
    const lastLoose = loose[loose.length - 1];
    if (!allowNonFinal && lastLoose !== lastIdx) {
      return fail(VERDICT_PARSER_CODES.VERDICT_NOT_FINAL, `verdict line is at ${lastLoose + 1}, final non-empty line is ${lastIdx + 1}`);
    }
    return fail(VERDICT_PARSER_CODES.VERDICT_TOKEN_INVALID, `invalid verdict line: ${lines[lastLoose].trim().slice(0, 120)}`);
  }
  if (strict.length > 1) {
    return fail(VERDICT_PARSER_CODES.VERDICT_AMBIGUOUS, `${strict.length} VERDICT lines found at ${strict.map((i) => i + 1).join(', ')}`);
  }
  const si = strict[0];
  if (!allowNonFinal && si !== lastIdx) {
    return fail(VERDICT_PARSER_CODES.VERDICT_NOT_FINAL, `verdict line is at ${si + 1}, final non-empty line is ${lastIdx + 1}`);
  }
  const rawVerdict = lines[si].trim().slice('VERDICT: '.length);
  const verdict = REVIEW_VERDICT_TO_FSM[rawVerdict];
  if (!verdict) {
    return fail(VERDICT_PARSER_CODES.VERDICT_TOKEN_INVALID, `unknown verdict token: ${rawVerdict}`);
  }
  const findings = [];
  for (let i = 0; i < si && findings.length < MAX_FINDINGS; i += 1) {
    const t = lines[i].trim();
    if (!t) continue;
    findings.push(t.length > MAX_FINDING_CHARS ? `${t.slice(0, MAX_FINDING_CHARS)}…` : t);
  }
  return ok({
    rawVerdict,
    verdict,
    findings,
    verdictLineIndex: si,
    responseLength: text.length,
  });
}

function pickRawText(decision) {
  for (const key of ['text', 'response', 'rawResponse', 'raw']) {
    const v = decision[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

// Stamp loop-owned session binding when the decision has none. Structured
// decisions that already carry a binding are never re-stamped (their echo is
// the reviewer's, gated upstream); a REWORK without any usable headSha fails
// closed (assertReworkBinding would reject it anyway — fail before transition).
function withSessionBinding(decision, session, verdict) {
  if (decision.binding && typeof decision.binding === 'object' && !Array.isArray(decision.binding)) {
    return ok(decision);
  }
  const repo = session && typeof session.repo === 'string' && session.repo ? session.repo : null;
  const issue = session && Number.isInteger(Number(session.issueNumber)) && Number(session.issueNumber) > 0
    ? Number(session.issueNumber)
    : null;
  if (!repo || !issue) {
    return fail(VERDICT_PARSER_CODES.VERDICT_SESSION_IDENTITY_MISSING, 'session.repo + session.issueNumber are required to bind a parsed verdict');
  }
  const headSha = session && typeof session.headSha === 'string' && HEAD_SHA_40.test(session.headSha)
    ? session.headSha.toLowerCase()
    : null;
  if (!headSha && verdict === 'REWORK') {
    return fail(VERDICT_PARSER_CODES.VERDICT_BINDING_UNAVAILABLE, 'session.headSha (40-hex) is required to bind a REWORK verdict');
  }
  const out = { ...decision };
  if (headSha) {
    out.binding = { repository: repo.toLowerCase(), issue, headSha };
  }
  return ok(out);
}

function buildParsedDecision(parsed, session, sourceTextLength) {
  const base = {
    verdict: parsed.verdict,
    findings: parsed.findings,
    evidenceRequests: [],
    confidence: null,
    metadata: {
      schemaVersion: VERDICT_PARSER_SCHEMA_VERSION,
      source: 'verdict-parser',
      rawVerdict: parsed.rawVerdict,
      responseLength: sourceTextLength ?? parsed.responseLength ?? null,
      parsedAt: new Date().toISOString(),
    },
  };
  return withSessionBinding(base, session, base.verdict);
}

// The control-loop integration seam: normalize whatever the finalReview step
// (fresh walk, rework leg, or any resume path) handed to decide() into a
// canonical FSM decision. accept:
//   - structured { verdict: PASS|REWORK|BLOCKED, ... }  -> byte-identical
//   - { verdict: APPROVED|CHANGES_REQUESTED|BLOCKED }   -> mapped + bound
//   - raw response text (string, or { text | response | rawResponse | raw })
//     -> parsed + mapped + bound
// Everything else fails closed with a deterministic VERDICT_* code.
export function normalizeReviewDecision({ decision, session } = {}) {
  if (typeof decision === 'string') {
    const parsed = parseReviewVerdict(decision);
    if (!parsed.ok) return parsed;
    return buildParsedDecision(parsed.value, session, decision.length);
  }
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    return fail(VERDICT_PARSER_CODES.VERDICT_DECISION_MISSING, `decision must be an object or response text, got ${decision === null ? 'null' : Array.isArray(decision) ? 'array' : typeof decision}`);
  }
  const upper = typeof decision.verdict === 'string' ? decision.verdict.trim().toUpperCase() : null;
  if (upper) {
    let mapped = null;
    if (FSM_VERDICTS.includes(upper)) mapped = upper;
    else if (Object.prototype.hasOwnProperty.call(REVIEW_VERDICT_TO_FSM, upper)) mapped = REVIEW_VERDICT_TO_FSM[upper];
    if (!mapped) {
      return fail(VERDICT_PARSER_CODES.VERDICT_UNKNOWN, `verdict=${JSON.stringify(decision.verdict)}`);
    }
    if (decision.verdict === mapped) return ok(decision); // canonical structured decision, untouched
    return withSessionBinding({ ...decision, verdict: mapped }, session, mapped);
  }
  const text = pickRawText(decision);
  if (text === null) {
    return fail(VERDICT_PARSER_CODES.VERDICT_TEXT_MISSING, 'decision carries neither a verdict nor raw response text');
  }
  const parsed = parseReviewVerdict(text);
  if (!parsed.ok) return parsed;
  return buildParsedDecision(parsed.value, session, text.length);
}
