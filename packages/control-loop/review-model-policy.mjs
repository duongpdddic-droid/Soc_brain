// packages/control-loop/review-model-policy.mjs — PRE-GATE-REVIEW-01.
//
// Ordered, pinned, FREE-ONLY reviewer model policy for the pre-gate review
// transport. The transport resolves its model from this pin list only:
//   PRIMARY   nine-router/Soc_OR_free_act   (via the local 9Router gateway)
//   FALLBACK1 opencode/mimo-v2.6-flash-free (OpenCode free tier)
//   FALLBACK2 opencode/deepseek-v4-flash-free (OpenCode free tier)
//
// Rules encoded here (see the operator directive, 2026-10-04):
//   - No model:null / default-config resolution: the transport always passes
//     an explicit pinned model id to the review leg.
//   - No direct OpenRouter calls and no Operator OpenRouter key: none of the
//     pinned ids use an openrouter provider; the primary rides the local
//     9Router gateway (opencode.json provider `nine-router`).
//   - Exact ids only, verified free before pinning. No name guessing, no
//     paid variants: a model outside the verified pin set or without
//     free=true is refused BEFORE any spawn.
//   - Fallback is allowed ONLY on classified availability/transport errors
//     (model unavailable, rate limit, provider error, timeout). Findings are
//     a valid review outcome (=> rework, never a model swap to hunt a CLEAN
//     verdict). Malformed/binding/candidate-drift are contract failures:
//     typed-fail, never papered over with a fallback attempt.
//   - Budget: at most ONE attempt per pinned model on the same candidate and
//     at most REVIEW_MODEL_MAX_ATTEMPTS total; exhausted => typed fail, no
//     circular retry. Each attempt keeps its own candidate binding, model/
//     provider and failure reason; responses of different attempts are never
//     merged.
//
// Verification provenance for the pin list (recorded 2026-10-04):
//   - nine-router/Soc_OR_free_act: live gateway catalog
//     GET http://localhost:20128/v1/models lists `Soc_OR_free_act`; a bounded
//     chat completion returned HTTP 200; the opencode.json provider block
//     `nine-router` points at that gateway (no OpenRouter key involved).
//   - opencode/mimo-v2.6-flash-free and opencode/deepseek-v4-flash-free:
//     ~/.cache/opencode/models.json (OpenCode catalog, refreshed 2026-10-04)
//     records cost.input=0, cost.output=0 for both ids (free tier).

function fail(reason, detail = null) {
  return { ok: false, reason, detail };
}

export const REVIEW_MODEL_MAX_ATTEMPTS = 3;

// Same charset the review leg accepts for --model (review-only.mjs MODEL_RE).
const REVIEW_MODEL_ID_RE = /^[A-Za-z0-9._/-]{1,120}$/;

const VERIFIED_AT = '2026-10-04';

export const REVIEW_MODEL_PIN_LIST = Object.freeze([
  Object.freeze({
    id: 'nine-router/Soc_OR_free_act',
    provider: 'nine-router',
    tier: 'primary',
    free: true,
    verifiedAt: VERIFIED_AT,
    verifiedVia: '9Router gateway /v1/models catalog + live bounded completion (HTTP 200) + opencode.json provider nine-router',
  }),
  Object.freeze({
    id: 'opencode/mimo-v2.6-flash-free',
    provider: 'opencode',
    tier: 'fallback',
    free: true,
    verifiedAt: VERIFIED_AT,
    verifiedVia: '~/.cache/opencode/models.json cost.input=0 cost.output=0 (OpenCode free tier)',
  }),
  Object.freeze({
    id: 'opencode/deepseek-v4-flash-free',
    provider: 'opencode',
    tier: 'fallback',
    free: true,
    verifiedAt: VERIFIED_AT,
    verifiedVia: '~/.cache/opencode/models.json cost.input=0 cost.output=0 (OpenCode free tier)',
  }),
]);

const CANONICAL_IDS = new Set(REVIEW_MODEL_PIN_LIST.map((m) => m.id));

export function isAllowlistedReviewModel(id) {
  return typeof id === 'string' && CANONICAL_IDS.has(id);
}

// Shape + allowlist + free gate for a pin list (default or test-injected).
// Runs BEFORE the first spawn so a paid/out-of-list model never reaches a
// reviewer process. Codes:
//   REVIEW_MODEL_POLICY_INVALID   — malformed list (not array, > 3, dup, bad id)
//   REVIEW_MODEL_NOT_ALLOWLISTED  — id outside the verified canonical set
//   REVIEW_MODEL_PAID_FORBIDDEN   — entry not marked free=true
export function validateModelPinList(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return fail('REVIEW_MODEL_POLICY_INVALID', 'pin list must be a non-empty array');
  }
  if (list.length > REVIEW_MODEL_MAX_ATTEMPTS) {
    return fail('REVIEW_MODEL_POLICY_INVALID', `pin list length ${list.length} exceeds budget ${REVIEW_MODEL_MAX_ATTEMPTS}`);
  }
  const seen = new Set();
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e || typeof e !== 'object') return fail('REVIEW_MODEL_POLICY_INVALID', `entry ${i} is not an object`);
    if (typeof e.id !== 'string' || !REVIEW_MODEL_ID_RE.test(e.id)) {
      return fail('REVIEW_MODEL_POLICY_INVALID', `entry ${i} id malformed`);
    }
    if (seen.has(e.id)) return fail('REVIEW_MODEL_POLICY_INVALID', `duplicate pin entry ${e.id}`);
    seen.add(e.id);
    if (!CANONICAL_IDS.has(e.id)) {
      return fail('REVIEW_MODEL_NOT_ALLOWLISTED', `model ${e.id} is outside the verified pin allowlist`);
    }
    if (e.free !== true) {
      return fail('REVIEW_MODEL_PAID_FORBIDDEN', `model ${e.id} is not verified free; paid/unverified models are refused before spawn`);
    }
  }
  return { ok: true };
}

// ---- Failure classification (the ONLY gateway to fallback) -------------------
// 'availability' => the attempt may fall back to the next pinned model.
// 'contract'     => typed-fail immediately; a fallback must never mask it.

const CONTRACT_CODES = new Set([
  // reviewer-output / evidence contract
  'REVIEW_RESULT_MALFORMED', 'REVIEW_RESULT_VERDICT_FORBIDDEN', 'REVIEW_OUTPUT_OVERFLOW',
  'REVIEW_EVIDENCE_INVALID', 'REVIEW_BATCH_COVERAGE', 'REVIEW_DIFF_TOO_LARGE',
  'REVIEW_INSTRUCTION_INVALID',
  // binding / candidate contract
  'REVIEW_BINDING_INVALID', 'REVIEW_WORKSPACE_FORBIDDEN', 'CANDIDATE_MISSING',
  'CANDIDATE_INCOMPLETE', 'HEAD_DRIFT',
  // environment contract that a model switch cannot repair
  'REVIEW_CONFIG_FAILED', 'REVIEW_PREFLIGHT_FAILED', 'REVIEW_OCR_UNAVAILABLE',
  'REVIEW_EXECUTOR_UNAVAILABLE', 'REVIEW_SPAWN_FAILED',
  // transport/leg wrapper + policy failures themselves
  'REVIEW_LEG_MALFORMED', 'REVIEW_LEG_EXCEPTION', 'REVIEW_LEG_FAILED',
  'REVIEW_MODEL_NOT_ALLOWLISTED', 'REVIEW_MODEL_PAID_FORBIDDEN',
  'REVIEW_MODEL_POLICY_INVALID', 'REVIEW_MODEL_BUDGET_EXHAUSTED',
]);

const RATE_RE = /rate.?limit|429|too many requests|quota exceeded|overloaded_error/i;
const MODEL_UNAVAILABLE_RE = /model.{0,60}(not[_ ]found|unavailable|does not exist|unknown|invalid|not enabled)|unknown model|no such model|model_not_found|is not available/i;
const PROVIDER_RE = /provider|service unavailable|upstream|gateway time-?out|internal server error|econnrefused|enotfound|etimedout|econnreset|socket hang up|fetch failed|50[023]|5\d{2}\b/i;

export function classifyReviewLegFailure(code, detail = null) {
  const c = typeof code === 'string' && code ? code : 'REVIEW_LEG_FAILED';
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail ?? '');
  if (CONTRACT_CODES.has(c)) return { ok: true, classification: 'contract', kind: 'contract', code: c };
  if (c === 'REVIEW_TIMEOUT') return { ok: true, classification: 'availability', kind: 'timeout', code: c };
  if (c === 'REVIEW_EXIT_NONZERO' || c === 'REVIEW_BATCH_FAILED') {
    // A wrapper detail carrying a contract code stays a contract failure —
    // a model switch must never launder a malformed reviewer result.
    for (const cc of CONTRACT_CODES) {
      if (d.includes(cc)) return { ok: true, classification: 'contract', kind: 'contract', code: c };
    }
    if (RATE_RE.test(d)) return { ok: true, classification: 'availability', kind: 'rate_limit', code: c };
    if (MODEL_UNAVAILABLE_RE.test(d)) return { ok: true, classification: 'availability', kind: 'model_unavailable', code: c };
    if (PROVIDER_RE.test(d)) return { ok: true, classification: 'availability', kind: 'provider_error', code: c };
    // Unclassified nonzero exit: NOT proven availability — fail closed.
    return { ok: true, classification: 'contract', kind: 'unclassified', code: c };
  }
  return { ok: true, classification: 'contract', kind: 'unclassified', code: c };
}
