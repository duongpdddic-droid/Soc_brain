// packages/executor-launcher/full-run-authority.mjs — the declaration gate for a
// FULL-inventory test run.
//
// A full run is not forbidden, but it must never be a silent, reflexive choice:
// the PR #307 post-mortem (RC4) showed that `run-tier-tests.mjs all` — and the
// two other full-capable CLIs — could start the entire suite outside the
// planner's affected plan with nothing recorded in the log. A client-side flag
// cannot enforce human authority (the shell owner can always run tests
// directly); what it CAN do is force the run to be declared, carry a reason and
// leave that reason in the evidence log.
//
// This module is a dependency-free leaf so both runners share ONE rule.

export const FULL_RUN_UNAUTHORIZED = 'FULL_RUN_UNAUTHORIZED';
export const MIN_REASON_LENGTH = 10;
export const AUTHORIZE_FLAG = '--authorize-full';
export const REASON_FLAG = '--reason';

function refuse(detail) {
  return { ok: false, code: FULL_RUN_UNAUTHORIZED, detail: String(detail) };
}

// Parse the declaration out of the argv tail. Only the BARE flag counts: a
// valued form such as `--authorize-full=yes` is deliberately not recognized, so
// a mistyped declaration fails closed instead of silently authorizing.
export function parseFullAuthorization(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let declared = false;
  let reason = null;
  let missingReasonValue = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === AUTHORIZE_FLAG) { declared = true; continue; }
    if (a === REASON_FLAG) {
      const next = args[i + 1];
      if (typeof next === 'string' && !next.startsWith('--')) { reason = next; i++; } else { missingReasonValue = true; }
      continue;
    }
    if (typeof a === 'string' && a.startsWith(`${REASON_FLAG}=`)) { reason = a.slice(REASON_FLAG.length + 1); }
  }

  if (!declared) {
    return refuse(`a FULL-inventory run requires the bare ${AUTHORIZE_FLAG} flag plus ${REASON_FLAG} "<why FULL is required>"`);
  }
  if (missingReasonValue) return refuse(`${AUTHORIZE_FLAG} requires a ${REASON_FLAG} value, not another flag`);
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (trimmed.length < MIN_REASON_LENGTH) {
    return refuse(`a FULL-inventory run requires ${REASON_FLAG} "<at least ${MIN_REASON_LENGTH} characters explaining why FULL is required>"`);
  }
  return { ok: true, reason: trimmed };
}

// A tier selection is a full run when it covers every tier in the manifest.
// `all` is handled by the callers (it is a stored alias, not a tier name).
export function coversAllTiers(requested, allTiers) {
  const asked = new Set(Array.isArray(requested) ? requested : []);
  const every = Array.isArray(allTiers) ? allTiers : [];
  if (!every.length) return false;
  return every.every((t) => asked.has(t));
}

// The declaration is not a quiet side note: it goes into stdout, so the raw log
// handed to review carries who/what justified the full suite.
export function fullRunBanner({ reason, fileCount } = {}) {
  return `[FULL-RUN] authorized reason="${String(reason)}" files=${Number(fileCount)}`;
}
