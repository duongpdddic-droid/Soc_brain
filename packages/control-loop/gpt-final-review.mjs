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
//      derived from the canonical evidence, never from the pre-review). The
//      packet is projected via buildStructuredPacketDigest (Issue #155 round-6):
//      section-aware, budget-bounded, review-critical sections kept verbatim,
//      bulky Code evidence reduced WITH an explicit marker, and any overflow
//      FAILS CLOSED before the transport (GPT_PACKET_SECTION_MISSING /
//      GPT_PACKET_BUDGET_EXCEEDED) — never a silent blind slice.
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

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
  collectPreReviewEvidence,
  parsePacketIdentity,
  PRE_REVIEW_PACKET_MAX_BYTES,
} from './gemini-pre-review.mjs';
import { SECTION_ORDER, SECTION_TITLES } from '../review-ready/review-ready.mjs';

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

// ---- deterministic canonical request digest (F3) -----------------------------
// The canonical request object is constructed ONCE by normalizeFinalReviewRequest
// and used for both prompt generation and SHA-256 computation. This guarantees
// the digest binds the EXACT semantic content the model receives — no silent
// truncation, no hidden omission. The packet excerpt arrives here ALREADY
// projected to the prompt budget by buildStructuredPacketDigest (fail-closed
// at the review seam); normalization itself never truncates it (Issue #155
// round-6 — the old blind 8192 slice was the defect, not a bound).
const FINDINGS_MAX = 20;
const FINDING_MAX_CHARS = 280;
const LEDGER_MAX = 20;
const LEDGER_LINE_MAX = 200;
const PRE_REVIEW_FINDINGS_MAX = 10;

// ---- structured prompt-packet projection (Issue #155 round-6) ---------------
// The old blind PACKET_EXCERPT_MAX=8192 slice cut the review-ready packet
// mid-diffStat: the reviewer lost the tail sections (Finding resolution, Tests,
// Verification, Safety/control-loop trace, Terminal status — test execution,
// fail-closed verifier codes, PR/worktree read-back, provenance) and escalated
// to BLOCKED on "missing evidence". Instead: split on the canonical render
// headings, keep review-critical sections FULL, reduce only the bulky Code
// evidence body with an explicit marker, and FAIL CLOSED before any transport
// submit when the projection cannot fit — reporting which section(s) missed.
export const GPT_PACKET_DIGEST_BUDGET = 32 * 1024;      // prompt packet char budget
export const GPT_PACKET_CODE_EVIDENCE_MAX = 12 * 1024;  // bulky-section body cap
export const GPT_PACKET_READ_MAX_BYTES = 1024 * 1024;   // full-packet re-read bound
export const GPT_PACKET_SECTION_TITLES = Object.freeze([
  'Identity',
  ...SECTION_ORDER.map((id) => SECTION_TITLES[id]),
  'Terminal status',
]);

export function normalizeFinalReviewRequest({ repository, issue, pullRequest, headSha, packetExcerpt, report, ledger, preReview } = {}) {
  return {
    repository: String(repository || ''),
    issue: Number(issue) || 0,
    pullRequest: pullRequest === undefined || pullRequest === null ? null : Number(pullRequest),
    headSha: String(headSha || ''),
    packetExcerpt: String(packetExcerpt || ''),
    report: report && typeof report === 'object' ? {
      verdict: report.verdict || null,
      findings: Array.isArray(report.findings)
        ? report.findings.filter((f) => typeof f === 'string').slice(0, FINDINGS_MAX).map((f) => f.slice(0, FINDING_MAX_CHARS))
        : [],
    } : null,
    ledger: Array.isArray(ledger) ? ledger.slice(-LEDGER_MAX).map((t) => ({
      from: t && t.from || null,
      to: t && t.to || null,
      reason: t && t.reason || null,
    })) : [],
    preReview: preReview && typeof preReview === 'object' ? {
      verdict: preReview.verdict || null,
      findings: Array.isArray(preReview.findings)
        ? preReview.findings.filter((f) => typeof f === 'string').slice(0, PRE_REVIEW_FINDINGS_MAX).map((f) => f.slice(0, FINDING_MAX_CHARS))
        : [],
      confidence: typeof preReview.confidence === 'number' ? preReview.confidence : null,
    } : null,
  };
}

function stableStringify(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
  }
  return 'null';
}

// Pure digest computation on an already-normalized request object.
// The normalized object must NOT contain requestDigest (recursive stability).
function digestNormalizedRequest(normalized) {
  return createHash('sha256').update(stableStringify(normalized)).digest('hex');
}

// Backward-compatible wrapper: normalizes then hashes.
export function computeRequestDigest(inputs) {
  return digestNormalizedRequest(normalizeFinalReviewRequest(inputs));
}

// ---- section-aware packet projection for the prompt --------------------------
// Returns { ok: true, value } — projected text (VERBATIM when nothing needed
// trimming, so the digest over the projection equals the digest over the source
// packet for in-budget packets) — or { ok: false, code, detail } to fail closed
// BEFORE the prompt/transport is built:
//   GPT_PACKET_SECTION_MISSING — a canonical render heading is absent
//                                (detail.missing[] names every absent section);
//   GPT_PACKET_BUDGET_EXCEEDED — the projection cannot fit the budget
//                                (detail.budget/length/sections[] report the
//                                exact size of every section that did not fit).
// Section headings are located FORWARD from the previous heading (the canonical
// render emits them in GPT_PACKET_SECTION_TITLES order), so a same-title line
// embedded inside earlier bulky content cannot displace a later real section.
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function buildStructuredPacketDigest(packetText, {
  budget = GPT_PACKET_DIGEST_BUDGET,
  codeEvidenceMax = GPT_PACKET_CODE_EVIDENCE_MAX,
  packetName = null,
} = {}) {
  const text = String(packetText || '');
  const positions = [];
  const missing = [];
  let cursor = 0;
  for (const title of GPT_PACKET_SECTION_TITLES) {
    const re = new RegExp(`^## ${escapeRegExp(title)}[ \\t]*\\r?$`, 'gm');
    re.lastIndex = cursor;
    const m = re.exec(text);
    if (!m) { missing.push(title); continue; }
    positions.push({ title, start: m.index, contentStart: m.index + m[0].length });
    cursor = m.index + m[0].length;
  }
  if (missing.length) {
    return { ok: false, code: 'GPT_PACKET_SECTION_MISSING', detail: { missing, packet: packetName } };
  }
  const parts = [text.slice(0, positions[0].start)];
  const sections = [];
  for (let i = 0; i < positions.length; i++) {
    const { title, start, contentStart } = positions[i];
    const bodyEnd = i + 1 < positions.length ? positions[i + 1].start : text.length;
    let body = text.slice(contentStart, bodyEnd);
    // Only Code evidence is bulk (inline git-show file content). It is reduced
    // HEAD-FIRST — diffStat/changedFiles/commits sit at the top of that section
    // and always survive — with an explicit in-band marker naming the original
    // size and the canonical packet. Everything else is review-critical and
    // stays verbatim.
    if (title === 'Code evidence' && body.length > codeEvidenceMax) {
      body = body.slice(0, codeEvidenceMax)
        + `\n[packet projection: Code evidence intentionally reduced from ${body.length} to ${codeEvidenceMax} chars (budget=${budget}); diffStat/changedFiles/commits above are intact; full text remains in canonical packet ${packetName ?? 'review-ready'}]`;
    }
    parts.push(text.slice(start, contentStart), body);
    sections.push({ title, length: (contentStart - start) + body.length });
  }
  const out = parts.join('');
  if (out.length > budget) {
    return { ok: false, code: 'GPT_PACKET_BUDGET_EXCEEDED', detail: { budget, length: out.length, packet: packetName, sections } };
  }
  return { ok: true, value: out };
}

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
// Accepts a pre-normalized request (from normalizeFinalReviewRequest) for the
// semantic content, plus session metadata for the prompt framing. The digest
// is already computed from the same normalized object — no re-normalization.
export function buildFinalReviewPrompt({ session, normalizedRequest, requestDigest = null }) {
  if (!session || typeof session !== 'object') throw new TypeError('buildFinalReviewPrompt: session is required');
  if (!normalizedRequest || typeof normalizedRequest !== 'object') throw new TypeError('buildFinalReviewPrompt: normalizedRequest is required');
  const repo = String(session.repo || 'unknown');
  const issue = Number(session.issueNumber) || 0;
  const base = String(session.baseSha || '').slice(0, 12);
  const head = String(session.headSha || '').slice(0, 12);
  const { report, ledger, packetExcerpt } = normalizedRequest;
  // Legacy-adoption sessions never run the canonical deterministic verifier —
  // a null report is EXPECTED, not a verification gap (Issue #155 round-6:
  // rendering "UNKNOWN" here read as missing evidence and helped escalate to
  // BLOCKED). Name the leg truthfully and point at the real evidence carried
  // by the packet sections below; never claim a PASS this module does not hold.
  const legacyAdoption = session.evidenceMode === 'legacy'
    || Boolean(session.provenance && session.provenance.provenance === 'legacy-adoption');
  const verifyVerdict = (legacyAdoption && !(report && report.verdict))
    ? 'LEGACY_EXTERNAL_NOT_CANONICAL (expected for legacy-adoption: no canonical deterministic verifier report exists for an adopted PR — this is NOT a missing verification; the packet sections below carry the real external test execution, fail-closed evidence verification, live PR/worktree read-back, and the control-loop trace)'
    : String((report && report.verdict) || 'UNKNOWN');
  const findings = Array.isArray(report && report.findings) ? report.findings : [];
  const prLine = session.prNumber ? `pullRequest: ${session.prNumber}` : 'pullRequest: (none — omit from binding)';
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
    '  "metadata": {',
    '    "requestDigest": "<the 64-hex SHA-256 digest provided below>"',
    '  },',
    '  "binding": {                     // echo EXACTLY as given below',
    `    "repository": "${repo}",`,
    `    "issue": ${issue},`,
    '    "pullRequest": <the pullRequest number given below or omit if none>,',
    '    "headSha": "<the 40-hex headSha given in the packet identity>"',
    '  }',
    '}',
    '',
    `Context: repo=${repo} issue=#${issue} ${prLine} base=${base} head=${head} sessionState=${session.state || 'unknown'}`,
    requestDigest ? `Request digest (include in metadata.requestDigest): ${requestDigest}` : '',
    `Verification verdict: ${verifyVerdict}`,
    `Verification findings (${findings.length}):`,
    ...findings.map((f, i) => `  ${i + 1}. ${f}`),
    '',
    `Control-loop transition ledger (last ${ledger.length}):`,
    ...ledger.map((t, i) => {
      const line = `${t && t.from}->${t && t.to} ${(t && t.reason) || ''}`;
      return `  ${i + 1}. ${line}`;
    }),
    '',
    `Canonical review-ready packet:`,
  ];
  lines.push(packetExcerpt);
  lines.push(
    '',
    '---- SECONDARY (informational only — do not anchor) ----',
    'Gemini pre-review verdict (P0-C, non-authoritative data):',
    JSON.stringify(normalizedRequest.preReview && typeof normalizedRequest.preReview === 'object'
      ? { verdict: normalizedRequest.preReview.verdict ?? null, findings: normalizedRequest.preReview.findings ?? [], confidence: normalizedRequest.preReview.confidence ?? null }
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
  // pullRequest is optional in the binding but must be a positive integer when present.
  if (b && typeof b === 'object' && !Array.isArray(b) && b.pullRequest !== undefined && b.pullRequest !== null && (!Number.isInteger(b.pullRequest) || b.pullRequest <= 0)) bad.push('binding.pullRequest');
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
        pullRequest: (b.pullRequest !== undefined && b.pullRequest !== null) ? b.pullRequest : undefined,
        headSha: b.headSha.toLowerCase(),
      },
    },
  };
}

// ---- binding gate: the GPT reply must echo the canonical packet identity -----
// The packet identity was already gated against the session inside
// collectPreReviewEvidence (repo/issue + stale-headSha refusal). Here the
// ECHOED binding must match that same canonical identity — a stale, foreign,
// or replayed reply fails closed.
export function assertFinalBinding(binding, { ident, prNumber = null }) {
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
  // F4: unconditional pullRequest gate — derive expected from canonical session
  // evidence, fail-closed if GPT omits or mismatches.
  const expectedPr = prNumber !== null && prNumber !== undefined ? Number(prNumber) : null;
  if (expectedPr !== null) {
    const actualPr = binding.pullRequest !== undefined && binding.pullRequest !== null ? Number(binding.pullRequest) : null;
    if (actualPr === null || !Number.isInteger(actualPr) || actualPr !== expectedPr) {
      return {
        ok: false,
        code: 'GPT_BINDING_MISMATCH',
        detail: `pullRequest echo=${actualPr} canonical=${expectedPr}`,
      };
    }
  }
  return { ok: true };
}

// ---- composition: evidence -> prompt -> transport -> strict parse -> binding --
// transportFactory: a function({ repository, issue, pullRequest, headSha,
//   requestDigest }) that returns a fresh transport({ prompt }) for each
//   transaction. This is the canonical seam for per-transaction binding
//   (e.g. web2api-copy needs all five binding values to classify responses).
// transport: a static transport({ prompt }) for backward compatibility when
//   no per-transaction binding is needed (e.g. CDP/CWA/Gemini adapters).
// At least one of transportFactory or transport must be provided; otherwise
//   the adapter fails closed with NO_GPT_TRANSPORT.
export function createGptFinalReview({ transportFactory = null, transport = null, reviewReadyDir = null, timeoutMs = resolveGptFinalTimeoutMs() } = {}) {
  return async function finalReview({ sessionPath, report, preReview }) {
    const ev = collectPreReviewEvidence({ sessionPath, report, reviewReadyDir });
    if (!ev.ok) return { ok: false, code: ev.code, detail: ev.detail };
    const ident = parsePacketIdentity(ev.packet.excerpt);
    if (!ident.ok) return { ok: false, code: 'REVIEW_PACKET_IDENTITY_MISMATCH', detail: ident.detail };
    // collectPreReviewEvidence caps its excerpt at PRE_REVIEW_PACKET_MAX_BYTES
    // (64 KiB); a real packet's review-critical tail (Finding resolution, Tests,
    // Verification, Safety/trace, Terminal status) can live beyond that cap.
    // When truncated, re-read the SAME identity-gated packet file (bounded),
    // re-gate its identity, then project it to the prompt budget — every
    // failure here is BEFORE the prompt and BEFORE the transport (fail closed).
    let packetText = ev.packet.excerpt;
    if (ev.packet.truncated) {
      let rawFull = null;
      try { rawFull = ev.packet.packetPath ? fs.readFileSync(ev.packet.packetPath) : null; } catch { rawFull = null; }
      if (!rawFull || !rawFull.length) return { ok: false, code: 'REVIEW_PACKET_UNREADABLE', detail: ev.packet.name || null };
      if (rawFull.length > GPT_PACKET_READ_MAX_BYTES) return { ok: false, code: 'GPT_PACKET_TOO_LARGE', detail: `${rawFull.length} > ${GPT_PACKET_READ_MAX_BYTES}` };
      const fullText = rawFull.toString('utf8');
      const identFull = parsePacketIdentity(fullText);
      if (!identFull.ok || identFull.repository !== ident.repository
        || identFull.issue !== ident.issue || identFull.headSha !== ident.headSha) {
        return { ok: false, code: 'REVIEW_PACKET_IDENTITY_MISMATCH', detail: 'full packet identity gate failed after re-read' };
      }
      packetText = fullText;
    }
    const projection = buildStructuredPacketDigest(packetText, { packetName: ev.packet.name });
    if (!projection.ok) return { ok: false, code: projection.code, detail: projection.detail };
    // Normalize ONCE — the same object feeds both the prompt and the digest.
    const normalizedRequest = normalizeFinalReviewRequest({
      repository: ev.session.repo,
      issue: ev.session.issueNumber,
      pullRequest: ev.session.prNumber ?? null,
      headSha: ev.session.headSha,
      packetExcerpt: projection.value,
      report: ev.report,
      ledger: ev.ledger,
      preReview,
    });
    const digest = digestNormalizedRequest(normalizedRequest);
    let prompt;
    try { prompt = buildFinalReviewPrompt({ session: ev.session, normalizedRequest, requestDigest: digest }); }
    catch (e) { return { ok: false, code: 'GPT_PROMPT_THROW', error: String((e && e.message) || e) }; }
    // Resolve the per-transaction transport: transportFactory wins when
    // provided (receives all five binding values); static transport is the
    // backward-compatible fallback. Neither -> fail closed.
    let activeTransport = null;
    if (typeof transportFactory === 'function') {
      activeTransport = transportFactory({
        repository: ev.session.repo,
        issue: ev.session.issueNumber,
        pullRequest: ev.session.prNumber ?? null,
        headSha: ev.session.headSha,
        requestDigest: digest,
      });
    } else if (typeof transport === 'function') {
      activeTransport = transport;
    }
    if (typeof activeTransport !== 'function') return { ok: false, code: 'NO_GPT_TRANSPORT' };
    // Hard timeout: a transport that never resolves must not hang the loop.
    let timer;
    const timeoutP = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, code: 'GPT_TRANSPORT_TIMEOUT' }), timeoutMs);
    });
    const callP = Promise.resolve().then(() => activeTransport({ prompt }))
      .catch((e) => ({ ok: false, code: 'GPT_TRANSPORT_THROW', error: String((e && e.message) || e) }));
    let t;
    try { t = await Promise.race([callP, timeoutP]); }
    finally { clearTimeout(timer); }
    if (!t || t.ok !== true) return { ok: false, code: (t && t.code) || 'GPT_TRANSPORT_FAILED', detail: t ?? null };
    const parsed = parseGptFinalReview(t.text);
    if (!parsed.ok) return parsed;
    // Validate metadata.requestDigest matches the computed canonical digest.
    const echoedDigest = parsed.value.metadata && typeof parsed.value.metadata.requestDigest === 'string'
      ? parsed.value.metadata.requestDigest.toLowerCase()
      : null;
    if (!echoedDigest || echoedDigest !== digest.toLowerCase()) {
      return { ok: false, code: 'GPT_REQUEST_DIGEST_MISMATCH', detail: `echoed=${echoedDigest} expected=${digest}` };
    }
    const bound = assertFinalBinding(parsed.value.binding, { ident, prNumber: ev.session.prNumber ?? null });
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
          requestDigest: digest,
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
