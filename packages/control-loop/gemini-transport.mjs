#!/usr/bin/env node
// gemini-transport.mjs — Soc_brain Gemini native HTTP transport ONLY (Issue #75 P0-C).
//
// Responsibility split (rework round 2):
//   gemini-transport.mjs = native REST wire protocol: one bounded POST to
//     generativelanguage.googleapis.com + native response envelope extraction.
//   gemini-pre-review.mjs = canonical evidence selection, bounded prompt
//     construction, STRICT semantic response validation/normalization.
//
// Seam: transport({ prompt }) -> { ok: true, status, text }  (text = model JSON string)
//                              | { ok: false, code, detail }
// The transport never sees session records, review packets, or loop state —
// it has no path to canonical task state (authority lives in control-loop.mjs).
//
// Fail-closed codes:
//   NO_GEMINI_API_KEY  GEMINI_PROMPT_INVALID  GEMINI_HTTP_<n>
//   GEMINI_TRANSPORT_THROW  GEMINI_RESPONSE_MALFORMED  GEMINI_BODY_TOO_LARGE
//   GEMINI_TIMEOUT
//
// Native stdlib only (https, no SDK). Bounded timeout, bounded response body,
// no retry: single attempt per call (retry policy belongs to callers).

import https from 'node:https';
import { URL } from 'node:url';

export const GEMINI_TRANSPORT_SCHEMA_VERSION = '1';
export const GEMINI_DEFAULT_MODEL = 'gemini-1.5-flash';
export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
export const GEMINI_TIMEOUT_MS = 30000;
export const GEMINI_BODY_MAX_BYTES = 1024 * 1024; // 1 MiB

// One bounded HTTPS POST. No retries. No auth beyond the API key header.
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

// Native response envelope extraction (protocol shape):
//   { candidates: [{ content: { parts: [{ text }] } }] }
// This is transport-level protocol parsing. Semantic validation of the review
// JSON ({verdict, findings, confidence, metadata}) lives in gemini-pre-review.mjs.
export function extractCandidateText(apiJson) {
  const c = apiJson && Array.isArray(apiJson.candidates) ? apiJson.candidates[0] : null;
  const parts = c && c.content && Array.isArray(c.content.parts) ? c.content.parts : null;
  const first = parts && parts[0];
  return first && typeof first.text === 'string' ? first.text : null;
}

// Factory: native REST transport bound to a model. Injected fetchImpl keeps
// every test deterministic (no network). Exported under the transport-only
// name; the pre-review semantics live in gemini-pre-review.mjs.
export function createGeminiTransport({
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
  async function geminiTransport({ prompt }) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return { ok: false, code: 'GEMINI_PROMPT_INVALID', detail: 'prompt must be a non-empty string' };
    }
    const url = `${endpoint.replace(/\/$/, '')}/${encodeURIComponent(model)}:generateContent`;
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    });
    let res;
    try { res = await fetchImpl({ url, headers: { 'x-goog-api-key': apiKey }, body, timeoutMs }); }
    catch (e) { return { ok: false, code: 'GEMINI_TRANSPORT_THROW', error: String((e && e.message) || e) }; }
    if (!res || res.ok !== true) {
      return { ok: false, code: (res && res.code) || 'GEMINI_TRANSPORT_THROW', detail: res };
    }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, code: `GEMINI_HTTP_${res.status}`, detail: (res.body || '').slice(0, 1000) };
    }
    let apiJson;
    try { apiJson = JSON.parse(res.body); }
    catch (e) { return { ok: false, code: 'GEMINI_RESPONSE_MALFORMED', detail: 'api json parse failed', error: String((e && e.message) || e) }; }
    const text = extractCandidateText(apiJson);
    if (!text) return { ok: false, code: 'GEMINI_RESPONSE_MALFORMED', detail: 'no candidate text' };
    return { ok: true, status: res.status, text };
  }
  geminiTransport.modelName = model; // carried into result metadata by the pre-review layer
  return geminiTransport;
}
