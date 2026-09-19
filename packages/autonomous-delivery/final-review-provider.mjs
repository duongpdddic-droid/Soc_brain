// final-review-provider.mjs — the ONLY Final Review transport selector.
//
// Fixed provider invariant (AUTONOMOUS_DELIVERY_CONTRACT.md §2):
// chatgpt-plus-web2api-copy is the single controller-owned provider.
// Executors cannot choose CWA, combine transports, or silently fallback.
// Pure selector (no spawn, no network): the Web2API factory is injected.

import { WEB2API_COPY_FLAG_VALUE } from '../control-loop/chatgpt-plus-web2api-copy.mjs';

export const FIXED_FINAL_REVIEW_PROVIDER = WEB2API_COPY_FLAG_VALUE;
export const FINAL_REVIEW_PROVIDER_ENV = 'SOC_FINAL_REVIEW_PROVIDER';

function fail(code, detail) {
  return { ok: false, code, detail: detail ?? null };
}

// Legacy opt-ins that MUST NOT influence selection anymore. Their presence
// alongside (or instead of) the fixed flag is a combine/mismatch attempt and
// fails closed — never a silent choice of CWA/CDP.
const LEGACY_TRANSPORT_ENV_KEYS = Object.freeze([
  'SOC_CWA_FINAL_REVIEW',
  'SOC_GPT_TRANSPORT_LEGACY_CDP',
  'SOC_GPT_CDP_PORT',
]);

export function selectFixedFinalReviewTransport({ env = process.env, web2apiFactory = null } = {}) {
  const flag = env && env[FINAL_REVIEW_PROVIDER_ENV];
  if (flag !== FIXED_FINAL_REVIEW_PROVIDER) {
    return fail('FINAL_REVIEW_PROVIDER_MISMATCH', `expected ${FINAL_REVIEW_PROVIDER_ENV}=${FIXED_FINAL_REVIEW_PROVIDER}, got ${flag ?? null}`);
  }
  const legacy = LEGACY_TRANSPORT_ENV_KEYS.filter((k) => {
    const v = env && env[k];
    return typeof v === 'string' ? v.trim() !== '' : v !== undefined && v !== null && v !== false;
  });
  if (legacy.length) {
    return fail('FINAL_REVIEW_TRANSPORT_COMBINED_REFUSED', { legacyKeys: legacy });
  }
  if (typeof web2apiFactory !== 'function') {
    return fail('NO_FINAL_REVIEW_TRANSPORT', 'web2apiFactory required');
  }
  let transport = null;
  try {
    transport = web2apiFactory();
  } catch (e) {
    return fail('NO_FINAL_REVIEW_TRANSPORT', String((e && e.message) || e));
  }
  if (!transport) return fail('NO_FINAL_REVIEW_TRANSPORT', 'factory returned empty');
  return { ok: true, value: { name: 'web2api-copy', transport, provider: FIXED_FINAL_REVIEW_PROVIDER } };
}

// Explicit refusal helper for callers that attempt a fallback direction.
export function refuseFinalReviewFallback({ from, to } = {}) {
  return fail('FINAL_REVIEW_FALLBACK_REFUSED', { from: from ?? null, to: to ?? null });
}
