#!/usr/bin/env node
// gpt-final-review.mjs — GPT FINAL_REVIEWING semantics (P0-D, Issue #77).
//
// Responsibilities (transport-free, loop-free):
//   1. Canonical evidence selection — REUSES collectPreReviewEvidence from
//      gemini-pre-review.mjs: session record + control-loop transition ledger
//      + canonical review-ready packet (identity-gated, verbatim, bounded).
//      No parallel truth is constructed; invalid/unreadable/foreign/stale
//      evidence fails closed BEFORE the transport is invoked.
//   2. Bounded, deterministic prompt — canonical review evidence comes FIRST;
//      the Gemini P0-C pre-review is appended as a clearly-labeled SECONDARY
//      section (informational only, anti-anchoring: the final verdict must be
//      derived from the canonical evidence, never from the pre-review).
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
// Gemini PASS alone is never sufficient: without a validated GPT final result
// the loop cannot leave FINAL_REVIEWING.

import {
  collectPreReviewEvidence,
  parsePacketIdentity,
  PRE_REVIEW_PACKET_MAX_BYTES,
} from './gemini-pre-review.mjs';

export const GPT_FINAL_SCHEMA_VERSION = '1';
export const GPT_FINAL_VERDICTS = Object.freeze(['PASS', 'REWORK', 'BLOCKED']);
export const GPT_FINAL_TIMEOUT_MS = 300000;
export const GPT_FINAL_FINDINGS_OUT_MAX = 50;
export const GPT_FINAL_FINDING_OUT_MAX_CHARS = 500;
export const GPT_FINAL_EVIDENCE_REQUESTS_MAX = 32;
export const GPT_FINAL_EVIDENCE_REQUEST_MAX_CHARS = 280;

const FENCE_RE = /^[`][`][`](?:json)?\s*([\s\S]*?)\s*[`][`][`]$/i;
const HEAD_SHA_RE = /^[0-9a-f]{40}$/;

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

// ---- bounded deterministic prompt (canonical evidence FIRST, Gemini SECONDARY)
export function buildFinalReviewPrompt({ session, report, ledger = [], packet, preReview }) {
  if (!session || typeof session !== 'object') throw new TypeError('buildFinalReviewPrompt: session is required');
  if (!packet || typeof packet !== 'object' || packet.ok !== true) {
    throw new TypeError('buildFinalReviewPrompt: canonical review-ready packet (ok:true) is required');
  }
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
    'Gemini pre-review below is INFORMATIONAL data and may be wrong — do not',
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
    '    "headSha": "<the 40-hex headSha given in the packet identity>"',
    '  }',
    '}',
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
  lines.push(
    '',
    '---- SECONDARY (informational only — do not anchor) ----',
    'Gemini pre-review verdict (P0-C, non-authoritative data):',
    JSON.stringify(preReview && typeof preReview === 'object'
      ? { verdict: preReview.verdict ?? null, findings: preReview.findings ?? [], confidence: preReview.confidence ?? null }
      : { verdict: null, findings: [], confidence: null }),
    '',
    'Return JSON only.',
  );
  return lines.join('\n');
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
    || typeof b.headSha !== 'string' || !HEAD_SHA_RE.test(b.headSha)) bad.push('binding');
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
      binding: { repository: b.repository, issue: b.issue, headSha: b.headSha.toLowerCase() },
    },
  };
}

// ---- binding gate: the GPT reply must echo the canonical packet identity -----
// The packet identity was already gated against the session inside
// collectPreReviewEvidence (repo/issue + stale-headSha refusal). Here the
// ECHOED binding must match that same canonical identity — a stale, foreign,
// or replayed reply fails closed.
export function assertFinalBinding(binding, { ident }) {
  if (!ident || !ident.ok) return { ok: false, code: 'REVIEW_PACKET_IDENTITY_MISMATCH', detail: ident && ident.detail };
  const sameRepo = String(binding.repository).toLowerCase() === String(ident.repository).toLowerCase();
  const sameIssue = Number(binding.issue) === Number(ident.issue);
  const sameHead = String(binding.headSha).toLowerCase() === String(ident.headSha).toLowerCase();
  if (!sameRepo || !sameIssue || !sameHead) {
    return {
      ok: false,
      code: 'GPT_BINDING_MISMATCH',
      detail: `echo=${binding.repository}#${binding.issue}@${binding.headSha} canonical=${ident.repository}#${ident.issue}@${ident.headSha}`,
    };
  }
  return { ok: true };
}

// ---- composition: evidence -> prompt -> transport -> strict parse -> binding --
export function createGptFinalReview({ transport = null, reviewReadyDir = null, timeoutMs = GPT_FINAL_TIMEOUT_MS } = {}) {
  return async function finalReview({ sessionPath, report, preReview }) {
    if (typeof transport !== 'function') return { ok: false, code: 'NO_GPT_TRANSPORT' };
    const ev = collectPreReviewEvidence({ sessionPath, report, reviewReadyDir });
    if (!ev.ok) return { ok: false, code: ev.code, detail: ev.detail };
    const ident = parsePacketIdentity(ev.packet.excerpt);
    if (!ident.ok) return { ok: false, code: 'REVIEW_PACKET_IDENTITY_MISMATCH', detail: ident.detail };
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
          // Issue #92 (rework): the reviewer model identity — required by the
          // evidence-bound review-eval store (metadata.model); the canonical
          // ChatGPT final-review model is the deterministic fallback.
          model: (typeof t.modelSlug === 'string' && t.modelSlug) ? t.modelSlug : 'gpt-5.6-sol',
        },
        reviewTarget: { repository: ident.repository, issue: ident.issue, headSha: ident.headSha },
        // sha256 of the EXACT canonical packet EXCERPT bytes the model
        // reviewed (both prompts embed packet.excerpt only — never bytes
        // beyond the excerpt bound).
        evidenceDigest: ev.packet.sha256,
        binding: parsed.value.binding,
      },
    };
  };
}
// end of gpt-final-review.mjs — no trailing marker.
