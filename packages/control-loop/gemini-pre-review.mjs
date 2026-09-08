#!/usr/bin/env node
// gemini-pre-review.mjs — Gemini PRE_REVIEWING semantics (Issue #75 P0-C,
// rework round 2: responsibilities split out of the transport).
//
// Responsibilities (transport-free, loop-free):
//   1. Canonical evidence selection — ONLY the canonical sources allowed by
//      Issue #75: the session record, the control-loop transition ledger, and
//      the canonical review-ready packet (REQUIRED — identity-gated). No
//      parallel truth is constructed: every source is read through its
//      existing primitive (readSessionRecord, readTransitions, packetPathFor)
//      and the packet is included verbatim (deterministically bounded), never
//      re-generated. If the packet is absent, unreadable, stale, or
//      identity-mismatched, the evidence FAILS CLOSED and Gemini is never
//      invoked.
//   2. Bounded, deterministic prompt construction.
//   3. STRICT semantic response validation: required shape
//      { verdict, findings, confidence, metadata }; missing/wrong-type
//      required fields -> GEMINI_RESPONSE_MALFORMED; verdict in {PASS, REWORK}
//      only; deterministic bounds applied AFTER structural validation.
//
// Authority (unchanged): the verdict here is INFORMATIONAL data passed to the
// GPT finalReview step. PRE_REVIEWING always transitions to FINAL_REVIEWING;
// DECIDING consumes only decision.verdict from finalReview (control-loop.mjs).
// This module never receives the loop token, never terminalizes, and never
// writes the canonical session record.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readSessionRecord } from '../runtime-sandbox/runtime-sandbox.mjs';
import { readTransitions } from './control-loop.mjs';
import { packetPathFor } from './adapters.mjs';

export const PRE_REVIEW_SCHEMA_VERSION = '1';
export const PRE_REVIEW_PACKET_MAX_BYTES = 64 * 1024; // canonical packet excerpt bound (64 KiB — Issue #83 leg-9: the real GPT reviewer could not semantically review a truncated 8 KiB packet)
export const PRE_REVIEW_LEDGER_MAX = 50;             // last N transitions included
export const PRE_REVIEW_LEDGER_LINE_MAX_CHARS = 200;
export const PRE_REVIEW_FINDINGS_MAX = 20;           // verifier findings into the prompt
export const PRE_REVIEW_FINDING_MAX_CHARS = 280;
export const PRE_REVIEW_FINDINGS_OUT_MAX = 50;       // model findings kept (post-validation bound)
export const PRE_REVIEW_FINDING_OUT_MAX_CHARS = 500;

const FENCE_RE = /^[`][`][`](?:json)?\s*([\s\S]*?)\s*[`][`][`]$/i;

// Parse the canonical Identity block that review-ready's renderReviewReady
// writes into every packet. Returns ok:false when any required identity field
// is missing or garbled — such a file is not canonical evidence.
export function parsePacketIdentity(content) {
  const text = typeof content === 'string' ? content : '';
  const grab = (re) => { const m = re.exec(text); return m ? m[1] : null; };
  const repository = grab(/^- repository:\s*(\S[^\r\n]*?)\s*$/im);
  const issueRaw = grab(/^- issue:\s*(\d+)\s*$/im);
  const headSha = grab(/^- headSha:\s*([0-9a-f]{40})(?:\s*\(short\s+[0-9a-f]+\))?/im);
  if (!repository || issueRaw === null || !headSha) {
    return { ok: false, detail: 'packet missing canonical Identity block (repository/issue/headSha)' };
  }
  return { ok: true, repository, issue: Number(issueRaw), headSha: headSha.toLowerCase() };
}

// ---- 1. canonical evidence selection ----------------------------------------
export function collectPreReviewEvidence({ sessionPath, report, reviewReadyDir = null } = {}) {
  const rs = readSessionRecord(sessionPath);
  if (!rs.ok) return { ok: false, code: rs.reason || 'SESSION_STATE_INVALID' };
  const session = rs.session;
  // Canonical loop ledger: <stateDir>/control-loop/<identityHash>/transitions.jsonl,
  // derived from the session's own canonical control-plane location (enforced
  // by readSessionRecord above).
  const stateDir = path.dirname(path.dirname(sessionPath));
  const identityHash = path.basename(sessionPath, '.json');
  const ledger = readTransitions({ stateDir, identityHash }).slice(-PRE_REVIEW_LEDGER_MAX);
  // Canonical review-ready packet = REQUIRED canonical semantic review
  // evidence (D8, round-3 rework): without it Gemini has no canonical review
  // basis, so the pre-review FAILS CLOSED — no transport call, no substitute.
  const packet = packetPathFor({ reviewReadyDir, sessionPath });
  if (!packet.ok) return { ok: false, code: packet.code || 'NO_REVIEW_PACKET' };
  let raw = null;
  try { raw = fs.readFileSync(packet.packetPath); } catch { raw = null; }
  if (!raw) return { ok: false, code: 'REVIEW_PACKET_UNREADABLE', detail: packet.filename || null };
  if (!raw.toString('utf8').trim()) return { ok: false, code: 'REVIEW_PACKET_UNREADABLE', detail: 'empty packet' };
  // Identity gate: the packet must self-identify with the session's canonical
  // (repo, issue) and a full 40-hex headSha. Foreign identity or a stale
  // headSha (when the session pins one) is refused — fail closed.
  const ident = parsePacketIdentity(raw.toString('utf8'));
  if (!ident.ok) return { ok: false, code: 'REVIEW_PACKET_IDENTITY_MISMATCH', detail: ident.detail };
  if (String(ident.repository).toLowerCase() !== String(session.repo).toLowerCase()
    || Number(ident.issue) !== Number(session.issueNumber)) {
    return { ok: false, code: 'REVIEW_PACKET_IDENTITY_MISMATCH', detail: `packet=${ident.repository}#${ident.issue} session=${session.repo}#${session.issueNumber}` };
  }
  if (typeof session.headSha === 'string' && /^[0-9a-f]{40}$/i.test(session.headSha)
    && ident.headSha !== session.headSha.toLowerCase()) {
    return { ok: false, code: 'REVIEW_PACKET_STALE', detail: `packet headSha=${ident.headSha} session headSha=${session.headSha.toLowerCase()}` };
  }
  const truncated = raw.length > PRE_REVIEW_PACKET_MAX_BYTES;
  // Issue #100: bind the packet into the evidence chain. The digest covers the
  // EXACT excerpt bytes embedded in both model prompts (Gemini pre-review AND
  // GPT final review render this same excerpt), never the full raw buffer:
  // when the packet exceeds the excerpt bound, the excerpt is what the
  // reviewers actually saw — exact-evidence provenance for the eval ledger.
  const excerpt = raw.subarray(0, PRE_REVIEW_PACKET_MAX_BYTES);
  const packetInfo = {
    ok: true,
    code: null,
    name: packet.filename,
    excerpt: excerpt.toString('utf8'),
    truncated,
    sha256: createHash('sha256').update(excerpt).digest('hex'),
    filename: packet.filename,
    identityHash,
  };
  return { ok: true, session, ledger, packet: packetInfo, report: report && typeof report === 'object' ? report : {} };
}

// ---- 2. bounded deterministic prompt ----------------------------------------
export function buildPreReviewPrompt({ session, report, ledger = [], packet }) {
  if (!session || typeof session !== 'object') throw new TypeError('buildPreReviewPrompt: session is required');
  if (!packet || typeof packet !== 'object' || packet.ok !== true) {
    throw new TypeError('buildPreReviewPrompt: canonical review-ready packet (ok:true) is required');
  }
  const repo = String(session.repo || 'unknown');
  const issue = Number(session.issueNumber) || 0;
  const base = String(session.baseSha || '').slice(0, 12);
  const head = String(session.headSha || '').slice(0, 12);
  const verifyVerdict = String((report && report.verdict) || 'UNKNOWN');
  const findings = Array.isArray(report && report.findings)
    ? report.findings.filter((f) => typeof f === 'string').slice(0, PRE_REVIEW_FINDINGS_MAX)
    : [];
  const lines = [
    'You are a semantic pre-reviewer for a Soc_brain control loop. Your verdict is',
    'INFORMATIONAL ONLY — it is passed as data to the canonical GPT final review.',
    'Review the CANONICAL evidence below. Do not invent facts not present in it.',
    'You MUST return STRICT JSON matching the schema. No prose, no markdown',
    'fences, no commentary — JSON object only.',
    '',
    'Schema (return EXACTLY this shape):',
    '{',
    '  "verdict": "PASS" | "REWORK",',
    '  "findings": string[],            // 0..50 short items',
    '  "confidence": number,            // 0..1',
    '  "metadata": object               // free-form',
    '}',
    '',
    `Context: repo=${repo} issue=#${issue} base=${base} head=${head} sessionState=${session.state || 'unknown'}`,
    `Verification verdict: ${verifyVerdict}`,
    `Verification findings (${findings.length}):`,
    ...findings.map((f, i) => `  ${i + 1}. ${f.slice(0, PRE_REVIEW_FINDING_MAX_CHARS)}`),
    '',
    `Control-loop transition ledger (last ${ledger.length}):`,
    ...ledger.map((t, i) => {
      const line = `${t && t.from}->${t && t.to} ${(t && t.reason) || ''}`.slice(0, PRE_REVIEW_LEDGER_LINE_MAX_CHARS);
      return `  ${i + 1}. ${line}`;
    }),
    '',
    `Canonical review-ready packet (${packet.name}${packet.truncated ? `, first ${PRE_REVIEW_PACKET_MAX_BYTES} bytes` : ''}):`,
  ];
  lines.push(packet.excerpt);
  lines.push('', 'Return JSON only.');
  return lines.join('\n');
}

// ---- 3. strict semantic response validation ---------------------------------
// Structural validation FIRST: every required field must exist with the exact
// type, no defaults, no lenient coercion -> else GEMINI_RESPONSE_MALFORMED.
// Deterministic bounds are applied ONLY after structural validation.
export function parseGeminiReview(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { ok: false, code: 'GEMINI_RESPONSE_MALFORMED', detail: 'empty body' };
  }
  let text = rawText.trim().slice(0, 1024 * 1024);
  const fence = FENCE_RE.exec(text);
  if (fence) text = fence[1].trim();
  let obj;
  try { obj = JSON.parse(text); }
  catch (e) { return { ok: false, code: 'GEMINI_RESPONSE_MALFORMED', detail: 'json parse failed', error: String((e && e.message) || e) }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, code: 'GEMINI_RESPONSE_MALFORMED', detail: 'not an object' };
  }
  // Required fields with exact types (structural — no defaults, no coercion).
  const bad = [];
  if (typeof obj.verdict !== 'string') bad.push('verdict');
  if (!Array.isArray(obj.findings)) bad.push('findings');
  if (typeof obj.confidence !== 'number' || !Number.isFinite(obj.confidence)) bad.push('confidence');
  if (!obj.metadata || typeof obj.metadata !== 'object' || Array.isArray(obj.metadata)) bad.push('metadata');
  if (bad.length) {
    return { ok: false, code: 'GEMINI_RESPONSE_MALFORMED', detail: `missing/wrong-type required fields: ${bad.join(',')}` };
  }
  // findings must be an array of strings (structural — no silent filtering).
  if (!obj.findings.every((f) => typeof f === 'string')) {
    return { ok: false, code: 'GEMINI_RESPONSE_MALFORMED', detail: 'findings must be an array of strings' };
  }
  // Verdict enum — value-level, distinct fail-closed code.
  const verdict = obj.verdict.trim().toUpperCase();
  if (verdict !== 'PASS' && verdict !== 'REWORK') {
    return { ok: false, code: 'GEMINI_VERDICT_INVALID', detail: `verdict=${JSON.stringify(obj.verdict)}` };
  }
  // Deterministic bounds AFTER structural validation.
  const findings = obj.findings
    .slice(0, PRE_REVIEW_FINDINGS_OUT_MAX)
    .map((f) => f.slice(0, PRE_REVIEW_FINDING_OUT_MAX_CHARS));
  const confidence = Math.max(0, Math.min(1, obj.confidence));
  return { ok: true, value: { verdict, findings, confidence, metadata: obj.metadata } };
}

// Issue #100 (rework): the exact-evidence identity every successful review
// adapter MUST stamp into `metadata.packet` — the sha256 covers the EXACT
// packet excerpt bytes rendered into the reviewer prompt (packetInfo.sha256),
// so the eval ledger can cryptographically bind each evaluation to the
// canonical review evidence it evaluated.
export function packetEvidence(packetInfo) {
  return { name: packetInfo.name, sha256: packetInfo.sha256, truncated: packetInfo.truncated === true };
}

// ---- composition: evidence -> prompt -> transport -> strict parse -----------
export function createGeminiPreReview({ transport = null, reviewReadyDir = null } = {}) {
  return async function preReview({ sessionPath, report }) {
    if (typeof transport !== 'function') return { ok: false, code: 'NO_GEMINI_TRANSPORT' };
    const ev = collectPreReviewEvidence({ sessionPath, report, reviewReadyDir });
    if (!ev.ok) return { ok: false, code: ev.code, detail: ev.detail };
    let prompt;
    try { prompt = buildPreReviewPrompt(ev); }
    catch (e) { return { ok: false, code: 'GEMINI_PRE_REVIEW_THROW', error: String((e && e.message) || e) }; }
    const t = await transport({ prompt });
    if (!t || t.ok !== true) return { ok: false, code: (t && t.code) || 'GEMINI_TRANSPORT_FAILED', detail: t };
    const parsed = parseGeminiReview(t.text);
    if (!parsed.ok) return parsed;
    const metadata = { ...parsed.value.metadata, source: 'gemini-pre-review' };
    // Issue #98: canonical model identity — reply-provided non-empty metadata.model
    // wins; else the observed transport identity; else literal 'unknown'. A
    // successful pre-review value never carries an absent/empty metadata.model.
    metadata.model = (typeof metadata.model === 'string' && metadata.model)
      ? metadata.model
      : ((typeof transport.modelName === 'string' && transport.modelName) ? transport.modelName : 'unknown');
    metadata.packet = packetEvidence(ev.packet);
    return { ok: true, value: { verdict: parsed.value.verdict, findings: parsed.value.findings, confidence: parsed.value.confidence, metadata } };
  };
}


