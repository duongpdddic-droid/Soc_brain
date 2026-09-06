#!/usr/bin/env node
// gemini-transport.mjs — Soc_brain Gemini pre-review transport (Issue #75 P0-C).
//
// WHY: PRE_REVIEWING is the canonical pre-GPT checkpoint. The verdict here
// is INFORMATIONAL — it is passed as `preReview` data to the finalReview
// step (GPT). A Gemini PASS does NOT bypass GPT final review; the loop
// authority stays with the canonical GPT final review (control-loop.mjs
// DECIDING transition only consumes `decision.verdict` from finalReview).
//
// Wire contract (matches geminiPreReviewAdapter in adapters.mjs):
//   transport({ session, report }) -> { ok: true, value: { verdict, findings, confidence, metadata } }
//                                       or { ok: false, code, detail }
//
// Fail-closed codes:
//   NO_GEMINI_API_KEY   GEMINI_HTTP_<n>   GEMINI_TRANSPORT_THROW
//   GEMINI_RESPONSE_MALFORMED   GEMINI_VERDICT_INVALID
//   GEMINI_BODY_TOO_LARGE   GEMINI_TIMEOUT
//
// Native stdlib only (https, no axios/fetch-pkg). Bounded timeout, bounded
// response body, structured parse, no autonomous retry. Single attempt per
// call — the recovery primitive (`recoverLifecycleEvent` in
// telegram-dispatch) governs retry policy for the notification seam; the
// review transport itself never retries inside the process.

import https from 'node:https';
import { URL } from 'node:url';

export const GEMINI_TRANSPORT_SCHEMA_VERSION = '1';
export const GEMINI_DEFAULT_MODEL = 'gemini-1.5-flash';
export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
export const GEMINI_TIMEOUT_MS = 30000;
export const GEMINI_BODY_MAX_BYTES = 1024 * 1024; // 1 MiB

// Build the deterministic prompt. We pin the schema so the model can only
// return a constrained JSON, then we parse with strict validation. Any
// deviation is GEMINI_RESPONSE_MALFORMED, not "we'll trust whatever it said".
export function buildGeminiPrompt({ session, report }) {
  if (!session || typeof session !== 'object') {
    throw new TypeError('buildGeminiPrompt: session is required');
  }
  if (!report || typeof report !== 'object') {
    throw new TypeError('buildGeminiPrompt: report is required');
  }
  const repo = String(session.repo || 'unknown');
  const issue = Number(session.issueNumber) || 0;
  const base = String(session.baseSha || '').slice(0, 12);
  const head = String(session.headSha || '').slice(0, 12);
  const verifyVerdict = report.verdict || 'UNKNOWN';
  const findings = Array.isArray(report.findings) ? report.findings.slice(0, 20) : [];
  return [
    'You are a pre-reviewer for a Soc_brain control loop. Your verdict is',
    'INFORMATIONAL ONLY — it is passed as data to the canonical GPT final',
    'review. You MUST return STRICT JSON matching the schema below. No',
    'prose, no markdown fences, no commentary — JSON object only.',
    '',
    'Schema (return EXACTLY this shape):',
    '{',
    '  "verdict": "PASS" | "REWORK",',
    '  "findings": string[],            // 0..50 short items',
    '  "confidence": number,            // 0..1',
    '  "metadata": object               // free-form, bounded keys',
    '}',
    '',
    `Context: repo=${repo} issue=#${issue} base=${base} head=${head}`,
    `Verification verdict: ${verifyVerdict}`,
    `Verification findings (${findings.length}):`,
    ...findings.map((f, i) => `  ${i + 1}. ${String(f).slice(0, 280)}`),
    '',
    'Return JSON only.',
  ].join('\n');
}

// Strict, deterministic response parser. Accepts ONLY an exact-shape object
// with the verdict ∈ {PASS, REWORK}, findings array of strings, confidence
// in [0,1], metadata as a bounded object. Anything else -> MALFORMED.
export function parseGeminiReview(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { ok: false, code: 'GEMINI_RESPONSE_MALFORMED', detail: 'empty body' };
  }
  let text = rawText.trim().slice(0, GEMINI_BODY_MAX_BYTES);
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fence) text = fence[1].trim();
  let obj;
  try { obj = JSON.parse(text); }
  catch (e) { return { ok: false, code: 'GEMINI_RESPONSE_MALFORMED', detail: 'json parse failed', error: String((e && e.message) || e) }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, code: 'GEMINI_RESPONSE_MALFORMED', detail: 'not an object' };
  }
  const verdict = String(obj.verdict || '').trim().toUpperCase();
  if (verdict !== 'PASS' && verdict !== 'REWORK') {
    return { ok: false, code: 'GEMINI_VERDICT_INVALID', detail: `verdict=${JSON.stringify(obj.verdict)}` };
  }
  const findings = Array.isArray(obj.findings)
    ? obj.findings.filter((f) => typeof f === 'string').map((f) => f.slice(0, 500)).slice(0, 50)
    : [];
  let confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));
  const meta = obj.metadata && typeof obj.metadata === 'object' && !Array.isArray(obj.metadata)
    ? obj.metadata : {};
  return { ok: true, value: { verdict, findings, confidence, metadata: meta } };
}

// One bounded HTTPS POST. No retries. No auth header beyond the API key.
function httpsPostJson({ url, headers, body, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; resolve(v); };
    const u = new URL(url);
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      path: `${u.pathname}${u.search || ''}`,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body, 'utf8'), ...headers },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > GEMINI_BODY_MAX_BYTES) {
          finish({ ok: false, code: 'GEMINI_BODY_TOO_LARGE', detail: `> ${GEMINI_BODY_MAX_BYTES} bytes` });
          req.destroy(new Error('body_too_large'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        finish({ ok: true, status: res.statusCode, headers: res.headers, body: text });
      });
    });
    req.on('timeout', () => { finish({ ok: false, code: 'GEMINI_TIMEOUT', detail: `> ${timeoutMs}ms` }); req.destroy(new Error('timeout')); });
    req.on('error', (e) => { finish({ ok: false, code: 'GEMINI_TRANSPORT_THROW', error: String((e && e.message) || e) }); });
    try { req.write(body); req.end(); }
    catch (e) { finish({ ok: false, code: 'GEMINI_TRANSPORT_THROW', error: String((e && e.message) || e) }); }
  });
}

// Factory for the transport bound to a model. Returns an async function with
// the wire contract geminiPreReviewAdapter expects:
//   transport({ session, report }) -> { ok, value } | { ok: false, code }
export function createGeminiPreReviewTransport({
  apiKey = process.env.GEMINI_API_KEY || '',
  model = process.env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL,
  endpoint = GEMINI_ENDPOINT,
  timeoutMs = GEMINI_TIMEOUT_MS,
  fetchImpl = httpsPostJson,
} = {}) {
  if (!apiKey || typeof apiKey !== 'string') {
    return async function geminiTransportDisabled() {
      return { ok: false, code: 'NO_GEMINI_API_KEY' };
    };
  }
  return async function geminiPreReviewTransport({ session, report }) {
    let prompt;
    try { prompt = buildGeminiPrompt({ session, report }); }
    catch (e) { return { ok: false, code: 'GEMINI_TRANSPORT_THROW', error: String((e && e.message) || e) }; }
    const url = `${endpoint.replace(/\/$/, '')}/${encodeURIComponent(model)}:generateContent`;
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    });
    const res = await fetchImpl({ url, headers: { 'x-goog-api-key': apiKey }, body, timeoutMs });
    if (!res || res.ok !== true) {
      return { ok: false, code: (res && res.code) || 'GEMINI_TRANSPORT_THROW', detail: res };
    }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, code: `GEMINI_HTTP_${res.status}`, detail: (res.body || '').slice(0, 1000) };
    }
    let parsedApi;
    try { parsedApi = JSON.parse(res.body); }
    catch (e) { return { ok: false, code: 'GEMINI_RESPONSE_MALFORMED', detail: 'api json parse failed', error: String((e && e.message) || e) }; }
    // Native response shape: { candidates: [{ content: { parts: [{ text: "..." }] } }] }
    const text = (parsedApi && Array.isArray(parsedApi.candidates) && parsedApi.candidates[0]
      && parsedApi.candidates[0].content && Array.isArray(parsedApi.candidates[0].content.parts)
      && parsedApi.candidates[0].content.parts[0] && typeof parsedApi.candidates[0].content.parts[0].text === 'string')
      ? parsedApi.candidates[0].content.parts[0].text : '';
    if (!text) return { ok: false, code: 'GEMINI_RESPONSE_MALFORMED', detail: 'no candidate text' };
    const parsed = parseGeminiReview(text);
    if (!parsed.ok) return parsed;
    return { ok: true, value: { ...parsed.value, metadata: { ...(parsed.value.metadata || {}), model, source: 'gemini-pre-review' } } };
  };
}
