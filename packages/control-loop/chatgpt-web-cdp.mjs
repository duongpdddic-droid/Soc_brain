#!/usr/bin/env node
// chatgpt-web-cdp.mjs — Soc_brain: the #63/#67-PROVEN ChatGPT Web Plus CDP
// transport primitives, moved verbatim out of scripts/e2e-reverse-control-leg.mjs
// (P0-D, Issue #77) so the final-review transport and the reverse-control e2e
// share ONE copy — no duplicated transport logic.
//
// Transport identity: chatgpt-web-plus/cdp-inpage-backend-api — attach to the
// LIVE user-profile Chrome (CDP port), find the chatgpt.com page target, drive
// the in-page composer (textarea + send button / Enter), and capture the
// conversation POST /backend-api/conversation response at the CDP Network
// layer. The page's own client performs the send (sentinel/proof native);
// window.fetch wrapping is bypassed by capturing at the transport layer.
//
// Fail-closed: every failure surfaces as a thrown Error carrying a stable code
// (CAPTURE_TIMEOUT / CAPTURE_WS_ERROR / CONVERSATION_REQUEST_FAILED /
// SEND_EVAL_FAILED / GET_RESPONSE_BODY_FAILED) or as { ok:false, code } from
// createChatGptWebCdpTransport — never a fabricated reply.

import { spawnSync } from 'node:child_process';

export const CHATGPT_WEB_CDP_SCHEMA_VERSION = '1';
export const CHATGPT_WEB_CDP_DEFAULT_PORT = 9223;

export function listCdpTargets({ cdpPort = CHATGPT_WEB_CDP_DEFAULT_PORT, spawnSyncImpl = spawnSync } = {}) {
  const r = spawnSyncImpl('curl.exe', ['-s', '--max-time', '10', `http://127.0.0.1:${cdpPort}/json/list`],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`curl /json/list exit ${r.status}`);
  return JSON.parse(r.stdout);
}

export function findChatGptPageTarget(targets) {
  if (!Array.isArray(targets)) return null;
  return targets.find((x) => x && x.type === 'page' && /chatgpt\.com/.test(x.url || '')) || null;
}

export function cdpEvaluate(wsUrl, expression, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* already closed */ }
      reject(new Error('CDP_EVALUATE_TIMEOUT'));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1, method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      if (msg.error) return reject(new Error('CDP_ERROR: ' + JSON.stringify(msg.error).slice(0, 300)));
      if (msg.result && msg.result.exceptionDetails) {
        return reject(new Error('PAGE_EXCEPTION: ' + JSON.stringify(msg.result.exceptionDetails).slice(0, 500)));
      }
      resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP_WS_ERROR')); });
  });
}

// ---- CDP-level capture of the conversation response ----------------------------
// Returns { status, text } of the POST /backend-api/conversation response once
// loadingFinished, or fails with the network error.
export function captureConversationResponse(wsUrl, sendExpression, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* closed */ }
      reject(new Error('CAPTURE_TIMEOUT'));
    }, timeoutMs);
    let convReqId = null;
    let convStatus = null;
    let seq = 0;
    const send = (method, params, onMsg) => {
      const id = ++seq;
      const on = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.id === id) { ws.removeEventListener('message', on); onMsg(m); }
      };
      ws.addEventListener('message', on);
      ws.send(JSON.stringify({ id, method, params }));
    };
    const onEvent = (ev) => {
      let m;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      const { method, params } = m;
      if (method === 'Network.requestWillBeSent' && params.request.method === 'POST'
        && /\/backend-api\/(f\/)?conversation\/?(\?|$)/.test(params.request.url) && convReqId === null) {
        convReqId = params.requestId;
      }
      if (method === 'Network.responseReceived' && params.requestId === convReqId) {
        convStatus = params.response.status;
      }
      if (method === 'Network.loadingFailed' && params.requestId === convReqId) {
        clearTimeout(timer);
        try { ws.close(); } catch { /* closed */ }
        reject(new Error('CONVERSATION_REQUEST_FAILED: ' + params.errorText + ' status=' + convStatus));
      }
      if (method === 'Network.loadingFinished' && params.requestId === convReqId) {
        send('Network.getResponseBody', { requestId: convReqId }, (r) => {
          clearTimeout(timer);
          try { ws.close(); } catch { /* closed */ }
          if (r.error) return reject(new Error('GET_RESPONSE_BODY_FAILED: ' + JSON.stringify(r.error).slice(0, 200)));
          const b = r.result;
          const text = b && b.isBase64 ? Buffer.from(b.body, 'base64').toString('utf8') : (b && b.body) || '';
          resolve({ status: convStatus, text });
        });
      }
    };
    ws.addEventListener('message', onEvent);
    ws.addEventListener('open', () => {
      send('Network.enable', {}, () => {
        send('Runtime.evaluate', { expression: sendExpression, awaitPromise: true, returnByValue: true }, (r) => {
          if (r.error || (r.result && r.result.exceptionDetails)) {
            clearTimeout(timer);
            try { ws.close(); } catch { /* closed */ }
            reject(new Error('SEND_EVAL_FAILED: ' + JSON.stringify(r.error || r.result.exceptionDetails).slice(0, 300)));
          }
        });
      });
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CAPTURE_WS_ERROR')); });
  });
}

export function buildUiSendExpression(prompt, { mustInclude = null } = {}) {
  return `
(async () => {
  const ta = document.querySelector('#prompt-textarea');
  if (!ta) return JSON.stringify({ ok: false, err: 'no textarea' });
  ta.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, ${JSON.stringify(prompt)});
  const after = ta.textContent || '';
  const required = ${JSON.stringify(mustInclude)};
  if (required !== null && !after.includes(required)) return JSON.stringify({ ok: false, err: 'insert failed' });
  let btn = null;
  for (let i = 0; i < 12 && !btn; i++) {
    await new Promise((r) => setTimeout(r, 250));
    btn = document.querySelector('[data-testid="send-button"]')
      || document.querySelector('button[aria-label*="Send"]');
  }
  if (btn && !btn.disabled) { btn.click(); return JSON.stringify({ ok: true, via: 'button' }); }
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  return JSON.stringify({ ok: true, via: 'enter', btnFound: !!btn });
})()
`;
}

// Parse a captured SSE body string (Node side): last assistant text + conversation id.
// Handles legacy full-message events and the v1 delta (JSON-patch) encoding,
// including chained deltas where p/o are inherited from the previous op and
// {"p":"","o":"patch","v":[ops]} envelopes.
export function parseSseCapture(sseText) {
  let text = '';
  let conversationId = null;
  let modelSlug = null;
  const applyMsg = (msg) => {
    if (!msg) return;
    if (msg.author && msg.author.role === 'assistant' && msg.content && Array.isArray(msg.content.parts)) {
      const parts = msg.content.parts.filter((p) => typeof p === 'string');
      if (parts.length) text = parts.join('');
    }
    if (msg.metadata && msg.metadata.model_slug) modelSlug = msg.metadata.model_slug;
  };
  const handleOp = (p, o, v) => {
    if (o === 'add' && (!p || p === '') && v && v.message) { applyMsg(v.message); return; }
    if (typeof p === 'string' && p.startsWith('/message/content/parts') && typeof v === 'string') {
      if (o === 'append') text += v;
      else if (o === 'replace' && p.endsWith('/0')) text = v; // ponytail: tracks parts/0 only; multi-part messages would need part indexing
    } else if (p === '/message/metadata' && v && typeof v === 'object' && v.model_slug) {
      modelSlug = v.model_slug;
    }
  };
  const applyOps = (ops, cur) => {
    for (const patch of ops) {
      if (!patch || typeof patch !== 'object') continue;
      // {"o":"patch","v":[ops]} envelope: recurse with fresh inheritance state,
      // leaving the outer stream state (p/o) untouched for chained deltas.
      if (patch.o === 'patch' && Array.isArray(patch.v)) {
        applyOps(patch.v, { p: undefined, o: undefined });
        continue;
      }
      if (typeof patch.p === 'string') cur.p = patch.p;
      if (typeof patch.o === 'string') cur.o = patch.o;
      if ('v' in patch) handleOp(cur.p, cur.o, patch.v);
    }
  };
  const cur = { p: undefined, o: undefined }; // stream-level inheritance state
  for (const line of String(sseText).split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let obj;
    try { obj = JSON.parse(payload); } catch { continue; }
    if (Array.isArray(obj)) { applyOps(obj, cur); continue; }
    if (obj && typeof obj === 'object' && ('p' in obj || 'o' in obj || 'v' in obj)) {
      applyOps([obj], cur);
      continue;
    }
    // Named event envelopes.
    if (obj && obj.conversation_id) conversationId = obj.conversation_id;
    if (obj && obj.message) applyMsg(obj.message);
    if (obj && obj.type === 'server_ste_metadata' && obj.metadata && obj.metadata.model_slug) {
      modelSlug = obj.metadata.model_slug;
    }
  }
  return { text, conversationId, modelSlug };
}

// First balanced JSON object inside free text (string-aware brace scan).
function extractJsonObjectLocal(text) {
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

export { extractJsonObjectLocal as extractJsonObject };

// ---- transport factory (P0-D) --------------------------------------------------
// createChatGptWebCdpTransport returns the injected finalReview transport:
//   transport({ prompt }) -> { ok:true, text, conversationId, modelSlug,
//                              captureStatus } | { ok:false, code, ... }
// Soc_brain (the orchestrator) initiates every request; the page's own client
// performs the send and the reply is captured at the CDP Network layer.
// Every failure is a stable fail-closed code — never a fabricated reply.
export function createChatGptWebCdpTransport({
  cdpPort = CHATGPT_WEB_CDP_DEFAULT_PORT,
  sendTimeoutMs = 300000,
  spawnSyncImpl = spawnSync,
} = {}) {
  return async function transport({ prompt }) {
    if (typeof prompt !== 'string' || !prompt.trim()) return { ok: false, code: 'GPT_PROMPT_INVALID' };
    let targets;
    try { targets = listCdpTargets({ cdpPort, spawnSyncImpl }); }
    catch (e) { return { ok: false, code: 'CDP_TARGETS_FAILED', error: String((e && e.message) || e) }; }
    const page = findChatGptPageTarget(targets);
    if (!page || !page.webSocketDebuggerUrl) return { ok: false, code: 'CDP_NO_CHATGPT_TARGET' };
    let cap;
    try { cap = await captureConversationResponse(page.webSocketDebuggerUrl, buildUiSendExpression(prompt), sendTimeoutMs); }
    catch (e) {
      const msg = String((e && e.message) || e);
      return { ok: false, code: msg.split(':')[0] || 'CDP_CAPTURE_FAILED', error: msg };
    }
    const reply = parseSseCapture(cap && cap.text);
    if (!reply.text || !reply.text.trim()) return { ok: false, code: 'GPT_EMPTY_REPLY' };
    return {
      ok: true,
      text: reply.text,
      conversationId: reply.conversationId ?? null,
      modelSlug: reply.modelSlug || null,
      captureStatus: cap.status,
    };
  };
}
// end of chatgpt-web-cdp.mjs — no trailing marker.
