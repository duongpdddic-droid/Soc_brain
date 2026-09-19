#!/usr/bin/env node
// gpt-final-review.mjs — GPT FINAL_REVIEWING semantics (P0-D, Issue #77).
//
// Responsibilities (transport-free, loop-free):
//   1. Canonical evidence selection — REUSES collectPreReviewEvidence from
//      review-evidence.mjs: session record + control-loop transition ledger
//      + canonical review-ready packet (identity-gated, verbatim, bounded).
//      No parallel truth is constructed; invalid/unreadable/foreign/stale
//      evidence fails closed BEFORE the transport is invoked.
//   2. Bounded, deterministic prompt — canonical review evidence comes FIRST;
//      the ACTIVE secondary is OCR/OpenCode ReviewEvidence v1 (informational
//      only, NO verdict exists; anti-anchoring: the final verdict must be
//      derived from the canonical evidence, never from the pre-review). The
//      legacy Gemini section renders only for dead-compat inputs — Gemini is
//      unwired from the critical path (Issue #4F).
//   3. STRICT semantic response validation: required shape
//      { verdict, findings, evidenceRequests, confidence, metadata, binding };
//      verdict enum {PASS, REWORK, BLOCKED}; the echoed binding (repository/
//      issue/headSha) must match the canonical packet identity exactly — any
//      mismatch is GPT_BINDING_MISMATCH (fail closed). Structural validation
//      first, no defaults, no lenient coercion; deterministic bounds applied
//      only AFTER structural validation.
//   4. Transport is injected and wrapped with a hard timeout — a transport
//      that never resolves becomes GPT_TRANSPORT_TIMEOUT, never a hang.
//
// Authority (hard invariant): the result is DATA only — { verdict, findings,
// evidenceRequests, confidence, metadata }. This module never receives the
// loop token, never terminalizes, never merges, never dispatches executors,
// and never writes the canonical session record. Only ControlLoop consumes
// decision.verdict (control-loop.mjs: FINAL_REVIEWING -> DECIDING).
// A pre-review PASS alone is never sufficient: without a validated GPT final
// result the loop cannot leave FINAL_REVIEWING. (Historical note: this clause
// used to name the Gemini pre-review; Gemini is now dead/unwired — Issue #4F.)

import {
  collectPreReviewEvidence,
  parsePacketIdentity,
  PRE_REVIEW_PACKET_MAX_BYTES,
} from './review-evidence.mjs';
import { isLegacyGeminiPreReview } from './review-delegate-evidence.mjs';

export const GPT_FINAL_SCHEMA_VERSION = '1';
export const GPT_FINAL_VERDICTS = Object.freeze(['PASS', 'REWORK', 'BLOCKED']);
export const GPT_FINAL_TIMEOUT_MS = 300000;

// Issue #116 item 2: the hard final-review timeout becomes overridable via env
// SOC_GPT_FINAL_TIMEOUT_MS (same hotfix class as the kept executor-poll /
// CDP-send timeout overrides). ONLY an integer > 0 is honored: invalid,
// fractional, zero, Infinity or unset -> the 300000 default (never 0, never
// Infinity). Resolved per createGptFinalReview() call so env changes take
// effect without a module reload.
export function resolveGptFinalTimeoutMs(env = process.env) {
  const n = Number(env.SOC_GPT_FINAL_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 ? n : GPT_FINAL_TIMEOUT_MS;
}

export const GPT_FINAL_FINDINGS_OUT_MAX = 50;
export const GPT_FINAL_FINDING_OUT_MAX_CHARS = 500;
export const GPT_FINAL_EVIDENCE_REQUESTS_MAX = 32;
export const GPT_FINAL_EVIDENCE_REQUEST_MAX_CHARS = 280;

const FENCE_RE = /^[`][`][`](?:json)?\s*([\s\S]*?)\s*[`][`][`]$/i;
const HEAD_SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

// First balanced JSON object inside free text (string-aware brace scan) — the
// reply may wrap the JSON in prose; anything unparseable still fails closed.
function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

// ---- bounded deterministic prompt (canonical evidence FIRST, pre-review SECONDARY)
// Active secondary evidence is OCR/OpenCode ReviewEvidence v1
// (informational only, NO verdict exists). The legacy Gemini section below is
// dead compatibility: it renders ONLY when a legacy-shaped preReview is
// explicitly passed (rollback/tests); production never produces it (the
// review-leg adapter reruns instead of converting — 4E.4).
export function buildFinalReviewPrompt({ session, report, ledger = [], packet, preReview }) {
  if (!session || typeof session !== 'object') throw new TypeError('buildFinalReviewPrompt: session is required');
  if (!packet || typeof packet !== 'object' || packet.ok !== true) {
    throw new TypeError('buildFinalReviewPrompt: canonical review-ready packet (ok:true) is required');
  }
  // P0 canonical echo targets, parsed from the packet excerpt itself (the
  // composition guarantees a stamped packet before the prompt is built;
  // unit fixtures without one get explicit UNAVAILABLE markers — never guess).
  let echoPr = 'UNAVAILABLE';
  let echoDigest = 'UNAVAILABLE';
  try {
    const echoIdent = parsePacketIdentity(packet.excerpt);
    if (echoIdent.ok) {
      if (Number.isInteger(echoIdent.pullRequest) && echoIdent.pullRequest > 0) echoPr = String(echoIdent.pullRequest);
      else if (Number.isInteger(Number(session.prNumber)) && Number(session.prNumber) > 0) echoPr = String(Number(session.prNumber));
      if (typeof echoIdent.reportDigest === 'string' && DIGEST_RE.test(echoIdent.reportDigest)) echoDigest = echoIdent.reportDigest;
    } else if (Number.isInteger(Number(session.prNumber)) && Number(session.prNumber) > 0) {
      echoPr = String(Number(session.prNumber));
    }
  } catch { /* markers stay UNAVAILABLE */ }
  const repo = String(session.repo || 'unknown');
  const issue = Number(session.issueNumber) || 0;
  const base = String(session.baseSha || '').slice(0, 12);
  const head = String(session.headSha || '').slice(0, 12);
  const verifyVerdict = String((report && report.verdict) || 'UNKNOWN');
  const findings = Array.isArray(report && report.findings)
    ? report.findings.filter((f) => typeof f === 'string').slice(0, 20)
    : [];
  const lines = [
    'You are the FINAL REVIEWER (GPT-5.6 Sol) for a Soc_brain control loop.',
    'Your verdict is the only review authority for advancing this task; the',
    'pre-review section below is INFORMATIONAL data and may be wrong — do not',
    'anchor on it. Review the CANONICAL EVIDENCE below and derive your verdict',
    'from it. Do not invent facts not present in the evidence.',
    'You MUST return STRICT JSON matching the schema. No prose, no markdown',
    'fences, no commentary — JSON object only.',
    '',
    'Schema (return EXACTLY this shape):',
    '{',
    '  "verdict": "PASS" | "REWORK" | "BLOCKED",',
    '  "findings": string[],            // 0..50 short items',
    '  "evidenceRequests": string[],    // 0..32 short items',
    '  "confidence": number,            // 0..1',
    '  "metadata": object,              // free-form',
    '  "binding": {                     // echo EXACTLY as given below',
    `    "repository": "${repo}",`,
    `    "issue": ${issue},`,
    `    "pullRequest": ${echoPr},`,
    '    "headSha": "<the 40-hex headSha given in the packet identity>",',
    `    "requestDigest": "${echoDigest}"`,
    '  }',
    '}',
    '',
    'Binding authority: repository, issue, pullRequest, headSha AND requestDigest',
    'must ALL echo the canonical packet identity exactly. A wrong, missing or',
    'malformed value in ANY of the five fails the review — do not invent them.',
    '',
    `Context: repo=${repo} issue=#${issue} base=${base} head=${head} sessionState=${session.state || 'unknown'}`,
    `Verification verdict: ${verifyVerdict}`,
    `Verification findings (${findings.length}):`,
    ...findings.map((f, i) => `  ${i + 1}. ${f.slice(0, 280)}`),
    '',
    `Control-loop transition ledger (last ${ledger.length}):`,
    ...ledger.map((t, i) => {
      const line = `${t && t.from}->${t && t.to} ${(t && t.reason) || ''}`.slice(0, 200);
      return `  ${i + 1}. ${line}`;
    }),
    '',
    `Canonical review-ready packet (${packet.name}${packet.truncated ? `, first ${PRE_REVIEW_PACKET_MAX_BYTES} bytes` : ''}):`,
  ];
  lines.push(packet.excerpt);
  lines.push(...renderSecondaryPreReview(preReview));
  lines.push(
    '',
    'Return JSON only.',
  );
  return lines.join('\n');
}

// Active secondary: OCR/OpenCode ReviewEvidence v1 — informational facts, no
// verdict (none exists). Legacy Gemini shape renders the old dead-compat
// section; anything else renders an explicit unavailable note (never authority).
export function renderSecondaryPreReview(preReview) {
  const head = [
    '',
    '---- SECONDARY (informational only — do not anchor) ----',
  ];
  const ev = unwrapReviewEvidence(preReview);
  if (ev) {
    const c = ev.canonical;
    const reviewable = Array.isArray(c.reviewableFiles) ? c.reviewableFiles : [];
    const excluded = Array.isArray(c.excludedFiles) ? c.excludedFiles : [];
    const findings = Array.isArray(c.findings) ? c.findings : [];
    const out = [
      ...head,
      'OCR/OpenCode ReviewEvidence v1 (non-authoritative data — NO verdict exists):',
      '- This pre-review is NOT authority. Its findings may be wrong. Derive PASS/REWORK/BLOCKED independently from the canonical evidence above. Do not anchor.',
      `- binding: ${c.binding.repo}#${c.binding.issueNumber} base=${String(c.binding.baseSha).slice(0, 12)} head=${String(c.binding.headSha).slice(0, 12)}`,
      `- target: ${c.target.mode}${c.target.mode === 'range' ? ` ${String(c.target.from).slice(0, 12)}..${String(c.target.to).slice(0, 12)}` : ` ${String(c.target.commit).slice(0, 12)}`}`,
      `- scope: ${reviewable.length} reviewable, ${excluded.length} excluded, reviewed ${Array.isArray(c.reviewedFiles) ? c.reviewedFiles.length : 0}, skipped [], coverageRate 1`,
      `- reviewable (${Math.min(reviewable.length, 100)} shown):`,
      ...reviewable.slice(0, 100).map((f, i) => `  ${i + 1}. ${String(f).slice(0, 200)}`),
      `- excluded (${Math.min(excluded.length, 50)} shown):`,
      ...excluded.slice(0, 50).map((f, i) => `  ${i + 1}. ${String(f.path).slice(0, 200)} (${String(f.reason).slice(0, 120)})`),
      `- reflectionCompleted: ${c.reflectionCompleted === true}, ruleGroups: ${c.ocr.ruleGroups}, ocr: ${c.ocr.version}, digest: ${ev.digest}`,
      `- findings (${findings.length}, first ${Math.min(findings.length, 20)}):`,
      ...findings.slice(0, 20).map((f, i) => `  ${i + 1}. [${f.severity}/${f.category}] ${String(f.path).slice(0, 160)}${f.startLine !== undefined ? `:${f.startLine}${f.endLine !== undefined ? `-${f.endLine}` : ''}` : ''} ${String(f.content).slice(0, 280)}`),
    ];
    return out;
  }
  if (isLegacyGeminiPreReview(preReview)) {
    return [
      ...head,
      'Gemini pre-review verdict (P0-C, non-authoritative data):',
      JSON.stringify({ verdict: preReview.verdict ?? null, findings: preReview.findings ?? [], confidence: preReview.confidence ?? null }),
    ];
  }
  return [...head, 'Pre-review evidence unavailable (no informational findings).'];
}

// Accept the leg value {canonical, digest, ...} or a bare canonical evidence.
export function unwrapReviewEvidence(preReview) {
  if (!preReview || typeof preReview !== 'object') return null;
  const c = preReview.canonical && typeof preReview.canonical === 'object' ? preReview.canonical : null;
  if (c && typeof preReview.digest === 'string' && c.schemaVersion === '1'
    && c.source === 'ocr-delegate+opencode-host' && c.binding && c.target && c.ocr) {
    return { canonical: c, digest: preReview.digest };
  }
  return null;
}

// ---- strict semantic response validation -------------------------------------
export function parseGptFinalReview(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { ok: false, code: 'GPT_RESPONSE_MALFORMED', detail: 'empty body' };
  }
  let text = rawText.trim().slice(0, 1024 * 1024);
  const fence = FENCE_RE.exec(text);
  if (fence) text = fence[1].trim();
  const jsonText = extractJsonObject(text) ?? text;
  let obj;
  try { obj = JSON.parse(jsonText); }
  catch (e) { return { ok: false, code: 'GPT_RESPONSE_MALFORMED', detail: 'json parse failed', error: String((e && e.message) || e) }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, code: 'GPT_RESPONSE_MALFORMED', detail: 'not an object' };
  }
  // Required fields with exact types (structural — no defaults, no coercion).
  // P0 trust anchor: the binding MUST carry the full five-coordinate echo
  // (repository/issue/pullRequest/headSha/requestDigest). A missing or
  // malformed coordinate is GPT_RESPONSE_MALFORMED; a well-formed but wrong
  // value is GPT_BINDING_MISMATCH at the binding gate below.
  const bad = [];
  if (typeof obj.verdict !== 'string') bad.push('verdict');
  if (!Array.isArray(obj.findings) || !obj.findings.every((f) => typeof f === 'string')) bad.push('findings');
  if (!Array.isArray(obj.evidenceRequests) || !obj.evidenceRequests.every((f) => typeof f === 'string')) bad.push('evidenceRequests');
  if (typeof obj.confidence !== 'number' || !Number.isFinite(obj.confidence)) bad.push('confidence');
  if (!obj.metadata || typeof obj.metadata !== 'object' || Array.isArray(obj.metadata)) bad.push('metadata');
  const b = obj.binding;
  if (!b || typeof b !== 'object' || Array.isArray(b)
    || typeof b.repository !== 'string' || !b.repository.trim()
    || !Number.isInteger(b.issue) || b.issue <= 0
    || !Number.isInteger(b.pullRequest) || b.pullRequest <= 0
    || typeof b.headSha !== 'string' || !HEAD_SHA_RE.test(b.headSha)
    || typeof b.requestDigest !== 'string' || !DIGEST_RE.test(b.requestDigest.toLowerCase())) bad.push('binding');
  if (bad.length) {
    return { ok: false, code: 'GPT_RESPONSE_MALFORMED', detail: `missing/wrong-type required fields: ${bad.join(',')}` };
  }
  // Verdict enum — value-level, distinct fail-closed code.
  const verdict = obj.verdict.trim().toUpperCase();
  if (!GPT_FINAL_VERDICTS.includes(verdict)) {
    return { ok: false, code: 'GPT_VERDICT_INVALID', detail: `verdict=${JSON.stringify(obj.verdict)}` };
  }
  // Deterministic bounds AFTER structural validation.
  const findings = obj.findings.slice(0, GPT_FINAL_FINDINGS_OUT_MAX).map((f) => f.slice(0, GPT_FINAL_FINDING_OUT_MAX_CHARS));
  const evidenceRequests = obj.evidenceRequests.slice(0, GPT_FINAL_EVIDENCE_REQUESTS_MAX).map((f) => f.slice(0, GPT_FINAL_EVIDENCE_REQUEST_MAX_CHARS));
  const confidence = Math.max(0, Math.min(1, obj.confidence));
  return {
    ok: true,
    value: {
      verdict,
      findings,
      evidenceRequests,
      confidence,
      metadata: obj.metadata,
      binding: {
        repository: b.repository,
        issue: b.issue,
        pullRequest: b.pullRequest,
        headSha: b.headSha.toLowerCase(),
        requestDigest: b.requestDigest.toLowerCase(),
      },
    },
  };
}

// ---- binding gate: the GPT reply must echo the canonical packet identity -----
// The packet identity was already gated against the session inside
// collectPreReviewEvidence (repo/issue + stale-headSha refusal). Here the
// ECHOED binding must match that same canonical identity on ALL FIVE
// coordinates — repository, issue, pullRequest, headSha, requestDigest.
// A stale, foreign, digest-wrong or replayed reply fails closed.
// NOTE: `ident` is the RESOLVED canonical identity built by
// createGptFinalReview below (packet PR reconciled with the session PR,
// digest required). Direct unit callers must supply the same resolved shape.
export function assertFinalBinding(binding, { ident }) {
  if (!ident || !ident.ok) return { ok: false, code: 'REVIEW_PACKET_IDENTITY_MISMATCH', detail: ident && ident.detail };
  if (typeof ident.reportDigest !== 'string' || !DIGEST_RE.test(ident.reportDigest)) {
    return { ok: false, code: 'REVIEW_PACKET_DIGEST_MISSING', detail: 'canonical packet lacks a reportDigest stamp' };
  }
  if (!Number.isInteger(ident.pullRequest) || ident.pullRequest <= 0) {
    return { ok: false, code: 'REVIEW_PACKET_PR_MISMATCH', detail: 'canonical packet lacks a pullRequest' };
  }
  if (!binding || typeof binding !== 'object') {
    return { ok: false, code: 'GPT_BINDING_MISMATCH', detail: 'missing binding echo' };
  }
  const sameRepo = String(binding.repository).toLowerCase() === String(ident.repository).toLowerCase();
  const sameIssue = Number(binding.issue) === Number(ident.issue);
  const samePr = Number(binding.pullRequest) === Number(ident.pullRequest);
  const sameHead = String(binding.headSha).toLowerCase() === String(ident.headSha).toLowerCase();
  const sameDigest = typeof binding.requestDigest === 'string'
    && binding.requestDigest.toLowerCase() === String(ident.reportDigest).toLowerCase();
  if (!sameRepo || !sameIssue || !samePr || !sameHead || !sameDigest) {
    return {
      ok: false,
      code: 'GPT_BINDING_MISMATCH',
      detail: `echo=${binding.repository}#${binding.issue}!PR${binding.pullRequest}@${binding.headSha}%${String(binding.requestDigest).slice(0, 12)} canonical=${ident.repository}#${ident.issue}!PR${ident.pullRequest}@${ident.headSha}%${String(ident.reportDigest).slice(0, 12)}`,
    };
  }
  return { ok: true };
}

// ---- composition: evidence -> prompt -> transport -> strict parse -> binding --
export function createGptFinalReview({ transport = null, reviewReadyDir = null, timeoutMs = resolveGptFinalTimeoutMs() } = {}) {
  return async function finalReview({ sessionPath, report, preReview }) {
    if (typeof transport !== 'function') return { ok: false, code: 'NO_GPT_TRANSPORT' };
    const ev = collectPreReviewEvidence({ sessionPath, report, reviewReadyDir });
    if (!ev.ok) return { ok: false, code: ev.code, detail: ev.detail };
    const pktIdent = parsePacketIdentity(ev.packet.excerpt);
    if (!pktIdent.ok) return { ok: false, code: 'REVIEW_PACKET_IDENTITY_MISMATCH', detail: pktIdent.detail };
    // P0 canonical resolution: the packet PR reconciled with the session PR
    // (skew = stale/foreign packet, fail closed); the reportDigest stamp is
    // mandatory — a packet without one cannot anchor a final review.
    if (pktIdent.pullRequest === null) {
      return { ok: false, code: 'REVIEW_PACKET_PR_MISMATCH', detail: 'packet lacks pullRequest' };
    }
    const sessionPr = Number(ev.session.prNumber);
    if (Number.isInteger(sessionPr) && sessionPr > 0 && sessionPr !== pktIdent.pullRequest) {
      return { ok: false, code: 'REVIEW_PACKET_PR_MISMATCH', detail: `packet PR=${pktIdent.pullRequest} session PR=${sessionPr}` };
    }
    if (typeof pktIdent.reportDigest !== 'string' || !DIGEST_RE.test(pktIdent.reportDigest)) {
      return { ok: false, code: 'REVIEW_PACKET_DIGEST_MISSING', detail: 'packet lacks reportDigest stamp' };
    }
    const ident = {
      ok: true,
      repository: pktIdent.repository,
      issue: pktIdent.issue,
      pullRequest: pktIdent.pullRequest,
      headSha: pktIdent.headSha,
      reportDigest: pktIdent.reportDigest,
    };
    let prompt;
    try { prompt = buildFinalReviewPrompt({ session: ev.session, report: ev.report, ledger: ev.ledger, packet: ev.packet, preReview }); }
    catch (e) { return { ok: false, code: 'GPT_PROMPT_THROW', error: String((e && e.message) || e) }; }
    // Hard timeout: a transport that never resolves must not hang the loop.
    let timer;
    const timeoutP = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, code: 'GPT_TRANSPORT_TIMEOUT' }), timeoutMs);
    });
    const callP = Promise.resolve().then(() => transport({ prompt }))
      .catch((e) => ({ ok: false, code: 'GPT_TRANSPORT_THROW', error: String((e && e.message) || e) }));
    let t;
    try { t = await Promise.race([callP, timeoutP]); }
    finally { clearTimeout(timer); }
    if (!t || t.ok !== true) return { ok: false, code: (t && t.code) || 'GPT_TRANSPORT_FAILED', detail: t ?? null };
    const parsed = parseGptFinalReview(t.text);
    if (!parsed.ok) return parsed;
    const bound = assertFinalBinding(parsed.value.binding, { ident });
    if (!bound.ok) return bound;
    // DATA only — deliberately drops any extra authority-shaped fields the
    // reply may carry (token/terminalize/transition/merge/dispatch): the
    // adapter result can never authorize a canonical mutation. P0-E (Issue
    // #79): the VALIDATED binding echo (assertFinalBinding) travels with the
    // decision — the rework dispatch gate re-checks it against the canonical
    // session identity before any executor re-dispatch.
    const { verdict, findings, evidenceRequests, confidence, metadata } = parsed.value;
    // Issue #98: canonical model identity — reply-provided non-empty metadata.model
    // wins; else the observed transport identity (modelSlug); else literal
    // 'unknown'. A successful final-review value never carries an absent/empty
    // metadata.model (same precedence as the Gemini pre-review fix, PR #95).
    const resolvedModel = (typeof metadata.model === 'string' && metadata.model)
      ? metadata.model
      : ((typeof t.modelSlug === 'string' && t.modelSlug) ? t.modelSlug : 'unknown');
    return {
      ok: true,
      value: {
        verdict,
        findings,
        evidenceRequests,
        confidence,
        metadata: {
          ...metadata,
          source: 'gpt-final-review',
          schemaVersion: GPT_FINAL_SCHEMA_VERSION,
          conversationId: t.conversationId ?? null,
          modelSlug: t.modelSlug ?? null,
          model: resolvedModel,
        },
        binding: parsed.value.binding,
      },
    };
  };
}
// end of gpt-final-review.mjs — no trailing marker.
