#!/usr/bin/env node
// gemini-pre-review.mjs — Gemini PRE_REVIEWING semantics (Issue #75 P0-C,
// rework round 2: responsibilities split out of the transport).
//
// Responsibilities (transport-free, loop-free):
//   1. Canonical evidence selection — ONLY the canonical sources allowed by
//      Issue #75: the session record, the control-loop transition ledger, and
//      the canonical review-ready packet. No parallel truth is constructed:
//      every source is read through its existing primitive
//      (readSessionRecord, readTransitions, packetPathFor) and the packet is
//      included verbatim (deterministically bounded), never re-generated.
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
import { readSessionRecord } from '../runtime-sandbox/runtime-sandbox.mjs';
import { readTransitions } from './control-loop.mjs';
import { packetPathFor } from './adapters.mjs';

export const PRE_REVIEW_SCHEMA_VERSION = '1';
export const PRE_REVIEW_PACKET_MAX_BYTES = 8 * 1024; // canonical packet excerpt bound (8 KiB)
export const PRE_REVIEW_LEDGER_MAX = 50;             // last N transitions included
export const PRE_REVIEW_LEDGER_LINE_MAX_CHARS = 200;
export const PRE_REVIEW_FINDINGS_MAX = 20;           // verifier findings into the prompt
export const PRE_REVIEW_FINDING_MAX_CHARS = 280;
export const PRE_REVIEW_FINDINGS_OUT_MAX = 50;       // model findings kept (post-validation bound)
export const PRE_REVIEW_FINDING_OUT_MAX_CHARS = 500;

const FENCE_RE = /^[`][`][`](?:json)?\s*([\s\S]*?)\s*[`][`][`]$/i;

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
  // Canonical review-ready packet = the review evidence for the semantic
  // review. Fail-soft: if not projected yet, say so explicitly in the prompt —
  // never fabricate a substitute.
  const packet = packetPathFor({ reviewReadyDir, sessionPath });
  let packetInfo = { ok: false, code: 'NO_REVIEW_PACKET', name: null, excerpt: null, truncated: false };
  if (packet.ok) {
    let raw = null;
    try { raw = fs.readFileSync(packet.packetPath); } catch { raw = null; }
    if (raw) {
      const truncated = raw.length > PRE_REVIEW_PACKET_MAX_BYTES;
      packetInfo = {
        ok: true,
        code: null,
        name: packet.filename,
        excerpt: raw.subarray(0, PRE_REVIEW_PACKET_MAX_BYTES).toString('utf8'),
        truncated,
      };
    } else {
      packetInfo = { ok: false, code: 'REVIEW_PACKET_UNREADABLE', name: packet.filename, excerpt: null, truncated: false };
    }
  }
  return { ok: true, session, ledger, packet: packetInfo, report: report && typeof report === 'object' ? report : {} };
}

// ---- 2. bounded deterministic prompt ----------------------------------------
export function buildPreReviewPrompt({ session, report, ledger = [], packet }) {
  if (!session || typeof session !== 'object') throw new TypeError('buildPreReviewPrompt: session is required');
  if (!packet || typeof packet !== 'object') throw new TypeError('buildPreReviewPrompt: packet is required');
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
    packet.ok
      ? `Canonical review-ready packet (${packet.name}${packet.truncated ? `, first ${PRE_REVIEW_PACKET_MAX_BYTES} bytes` : ''}):`
      : 'Canonical review-ready packet: NOT YET PROJECTED (NO_REVIEW_PACKET — review the verification findings and transition ledger only).',
  ];
  if (packet.ok) lines.push(packet.excerpt);
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

// ---- composition: evidence -> prompt -> transport -> strict parse -----------
export function createGeminiPreReview({ transport = null, reviewReadyDir = null } = {}) {
  return async function preReview({ sessionPath, report }) {
    if (typeof transport !== 'function') return { ok: false, code: 'NO_GEMINI_TRANSPORT' };
    const ev = collectPreReviewEvidence({ sessionPath, report, reviewReadyDir });
    if (!ev.ok) return { ok: false, code: ev.code };
    let prompt;
    try { prompt = buildPreReviewPrompt(ev); }
    catch (e) { return { ok: false, code: 'GEMINI_PRE_REVIEW_THROW', error: String((e && e.message) || e) }; }
    const t = await transport({ prompt });
    if (!t || t.ok !== true) return { ok: false, code: (t && t.code) || 'GEMINI_TRANSPORT_FAILED', detail: t };
    const parsed = parseGeminiReview(t.text);
    if (!parsed.ok) return parsed;
    const metadata = { ...parsed.value.metadata, source: 'gemini-pre-review' };
    if (typeof transport.modelName === 'string' && transport.modelName) metadata.model = transport.modelName;
    return { ok: true, value: { verdict: parsed.value.verdict, findings: parsed.value.findings, confidence: parsed.value.confidence, metadata } };
  };
}


