#!/usr/bin/env node
// smoke-gpt-final-review.mjs — SIDE-EFFECT-FREE Final Review smoke harness.
//
// Purpose: exercise the PRODUCTION final-review path (selectGptTransport ->
// createGptFinalReview -> strict parser -> assertFinalBinding) against a
// canonical session + review-ready packet WITHOUT touching the control loop.
//
// Side-effect-free by construction:
// - READ-ONLY input: canonical session record + canonical review-ready packet.
// - No session/worktree provisioning, no executor dispatch, no push/PR/issue
//   mutation, no delivery, no terminalization, no Telegram, no cleanup, and
//   ZERO writes (no write-capable fs API is imported).
// - Provider must be the explicit web2api-copy selection (read-only proven);
//   transportOverride exists ONLY for deterministic tests.
// - Guard: any future lifecycle import in this file must fail the static
//   mutation-token check (tests/smoke-gpt-final-review.test.mjs).
//
// Canonical inputs (explicit, no guessing, no HEAD fallback):
//   --session   <path>  canonical session JSON at its identity-derived path
//                       (<stateDir>/sessions/<identityHash>.json; position is
//                       re-validated by readSessionRecord)
//   --evidence  <dir|file>
//                       review-ready projection dir (canonical resolver picks
//                       the packet by session identity+head) OR an exact
//                       packet file — file mode still routes through the
//                       canonical resolver and fails closed unless the resolver
//                       independently selects exactly that file.
//
//   --smoke <smokeId|instanceDir> [--smoke-root <dir>]
//                       canonical smoke transaction minted by
//                       scripts/create-final-review-smoke.mjs. Smoke mode
//                       resolves to the smoke sessionPath + reviewReadyDir
//                       via the smoke reader (read-only) and then follows
//                       the EXACT same production evidence/parser/binding
//                       path below. --smoke must never be combined with
//                       --session/--evidence (SMOKE_PRODUCTION_MIX_REFUSED).
//
// Expected binding authority = canonical session/packet (repo/issue/headSha);
// requestDigest = the packet's canonical reportDigest stamp (the review-mcp
// contract: requestDigest == artifact reportDigest). Caller overrides of the
// binding are impossible: both values are parsed from canonical sources and
// re-gated by collectPreReviewEvidence + assertFinalBinding downstream.
//
// Provider env (production parity, process-local):
//   SOC_FINAL_REVIEW_PROVIDER=chatgpt-plus-web2api-copy
//
// Output: one JSON line:
//   { ok, code?, provider, requestDigest, binding, submitStatus,
//     conversationId, assistantTurnId, clipboardAttempts, parserOk,
//     bindingOk, verdict, latencyMs }

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readFinalReviewSmoke } from '../packages/control-loop/final-review-smoke.mjs';
import { readSessionRecord } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { parsePacketIdentity } from '../packages/control-loop/review-evidence.mjs';
import { packetPathFor } from '../packages/control-loop/review-packet.mjs';
import { createGptFinalReview } from '../packages/control-loop/gpt-final-review.mjs';
import { selectGptTransport } from '../packages/control-loop/chatgpt-web-cwa.mjs';
import { createChatGptPlusWeb2ApiCopyTransport } from '../packages/control-loop/chatgpt-plus-web2api-copy.mjs';

const DIGEST_STAMP_RE = /- reportDigest:\s*([0-9a-f]{64})/i;

export async function runSmokeHarness({
  sessionPath,
  evidence,
  smoke = null,
  smokeRoot = null,
  env = process.env,
  transportOverride = null,
  nowImpl = Date.now,
} = {}) {
  const startedAt = nowImpl();
  const out = {
    ok: false,
    provider: null,
    requestDigest: null,
    binding: null,
    submitStatus: 'NOT_SUBMITTED',
    conversationId: null,
    assistantTurnId: null,
    clipboardAttempts: null,
    parserOk: null,
    bindingOk: null,
    verdict: null,
  };
  const fail = (code, extra = {}) => ({ ok: false, code, ...out, ...extra, latencyMs: nowImpl() - startedAt });

  // Smoke mode (read-only): resolve the canonical smoke transaction into the
  // same sessionPath/evidence inputs consumed below. Never mixes with
  // production inputs; the downstream production path is untouched.
  if (typeof smoke === 'string' && smoke.trim()) {
    if ((typeof sessionPath === 'string' && sessionPath.trim())
      || (typeof evidence === 'string' && evidence.trim())) {
      return fail('SMOKE_PRODUCTION_MIX_REFUSED');
    }
    let smokeId = smoke.trim();
    let root = smokeRoot;
    if (smokeId.includes('/') || smokeId.includes(path.sep)) {
      const abs = path.resolve(smokeId);
      root = root || path.dirname(abs);
      smokeId = path.basename(abs);
    }
    const tx = readFinalReviewSmoke({ ...(root ? { smokeRoot: root } : {}), smokeId });
    if (!tx.ok) return fail(tx.code || 'SMOKE_NOT_FOUND', { detail: tx.detail ?? null });
    sessionPath = tx.value.sessionPath;
    evidence = tx.value.reviewReadyDir;
  }

  if (typeof sessionPath !== 'string' || !sessionPath.trim()) return fail('SMOKE_SESSION_REQUIRED');
  if (typeof evidence !== 'string' || !evidence.trim()) return fail('SMOKE_EVIDENCE_REQUIRED');

  // Canonical session (read-only; position authority re-validated inside).
  const rs = readSessionRecord(sessionPath);
  if (!rs.ok) return fail('SMOKE_SESSION_INVALID', { detail: rs.reason ?? null });

  // Canonical packet resolution — the resolver owns selection (no override).
  let st = null;
  try { st = statSync(evidence); } catch { return fail('SMOKE_EVIDENCE_UNREADABLE'); }
  const evidenceDir = st.isDirectory() ? evidence : path.dirname(path.resolve(evidence));
  const pkt = packetPathFor({ reviewReadyDir: evidenceDir, sessionPath });
  if (!pkt.ok) return fail('SMOKE_NO_REVIEW_PACKET', { detail: pkt.code ?? null });
  if (!st.isDirectory() && path.resolve(pkt.packetPath) !== path.resolve(evidence)) {
    return fail('SMOKE_EVIDENCE_NOT_CANONICAL', { detail: `resolver selected ${pkt.filename}, not the explicit file` });
  }

  let raw;
  try { raw = readFileSync(pkt.packetPath, 'utf8'); } catch { return fail('SMOKE_EVIDENCE_UNREADABLE'); }

  // Packet identity gate (same invariant as review-evidence, pre-submit).
  const ident = parsePacketIdentity(raw);
  if (!ident.ok) return fail('SMOKE_PACKET_IDENTITY_INVALID', { detail: ident.detail ?? null });
  const s = rs.session;
  const sessionHead = typeof s.headSha === 'string' && /^[0-9a-f]{40}$/i.test(s.headSha)
    ? s.headSha.toLowerCase() : null;
  if (String(ident.repository).toLowerCase() !== String(s.repo).toLowerCase()
    || Number(ident.issue) !== Number(s.issueNumber)) {
    return fail('SMOKE_IDENTITY_MISMATCH', { detail: `packet=${ident.repository}#${ident.issue} session=${s.repo}#${s.issueNumber}` });
  }
  if (sessionHead && ident.headSha !== sessionHead) {
    return fail('SMOKE_PACKET_STALE', { detail: `packet headSha=${ident.headSha} session headSha=${sessionHead}` });
  }

  // requestDigest: canonical source ONLY (artifact reportDigest stamp).
  const digest = DIGEST_STAMP_RE.exec(raw);
  if (!digest) return fail('SMOKE_DIGEST_MISSING', { detail: 'canonical packet lacks - reportDigest: <64hex>' });

  // Provider selection — production parity, read-only proven surface only.
  const selection = selectGptTransport({
    env,
    web2apiCopyTransportFactory: () => transportOverride || createChatGptPlusWeb2ApiCopyTransport({}),
  });
  if (selection.name !== 'web2api-copy') {
    return fail('SMOKE_PROVIDER_UNSUPPORTED', { detail: `provider=${selection.name}; harness guarantees side-effect-freedom only for web2api-copy` });
  }
  out.provider = selection.name;
  out.requestDigest = digest[1];
  out.binding = { repository: ident.repository, issue: ident.issue, headSha: ident.headSha };

  // Bind the canonical digest into the prompt so the provider's anti-stale
  // clipboard classifier has the exact token to validate against. Sourced
  // from the canonical packet, never caller-supplied. The canonical prompt
  // builder itself is NOT modified.
  const inner = selection.transport;
  let lastRaw = null;
  const transport = async ({ prompt }) => {
    lastRaw = await inner({ prompt: `${prompt}\n\nAnti-stale echo token (echo EXACTLY in metadata): "requestDigest": "${digest[1]}"` });
    return lastRaw;
  };

  const finalReview = createGptFinalReview({ transport, reviewReadyDir: evidenceDir });
  const r = await finalReview({ sessionPath, report: {}, preReview: null });

  out.submitStatus = r.ok === true ? 'SUBMITTED' : (lastRaw && typeof lastRaw === 'object' && lastRaw.code ? lastRaw.code : (r.code || 'FAILED'));
  out.conversationId = (lastRaw && lastRaw.conversationId) ?? (r.ok && r.value ? r.value.metadata.conversationId : null);
  const meta = lastRaw && lastRaw.transportMeta ? lastRaw.transportMeta : null;
  out.assistantTurnId = meta ? meta.turnId : null;
  out.clipboardAttempts = meta ? meta.shortcutAttempts : null;
  if (r.ok === true) {
    out.ok = true;
    out.parserOk = true;
    out.bindingOk = true;
    out.verdict = r.value.verdict;
  } else if (r.code === 'GPT_BINDING_MISMATCH' || r.code === 'REVIEW_PACKET_IDENTITY_MISMATCH') {
    out.parserOk = true;
    out.bindingOk = false;
  } else if (r.code === 'GPT_RESPONSE_MALFORMED' || r.code === 'GPT_VERDICT_INVALID') {
    out.parserOk = false;
    out.bindingOk = null;
  } else {
    out.parserOk = null;
    out.bindingOk = null;
  }
  out.latencyMs = nowImpl() - startedAt;
  if (r.ok !== true) out.code = r.code;
  if (r.detail !== undefined && r.detail !== null) out.detail = r.detail;
  return out;
}

// CLI: env (provider flag) is process-local by nature; inputs explicit only.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.url.replace(/^file:\/\/\//, '').replace(/\//g, path.sep))) {
  const args = parseArgs({
    args: process.argv.slice(2),
    options: {
      session: { type: 'string' },
      evidence: { type: 'string' },
      smoke: { type: 'string' },
      'smoke-root': { type: 'string' },
    },
    strict: true,
  });
  const res = await runSmokeHarness({
    sessionPath: args.values.session,
    evidence: args.values.evidence,
    smoke: args.values.smoke ?? null,
    smokeRoot: args.values['smoke-root'] ?? null,
  });
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok === true ? 0 : 1);
}
// end of smoke-gpt-final-review.mjs — no trailing marker.
