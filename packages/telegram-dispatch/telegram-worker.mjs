#!/usr/bin/env node
// telegram-worker.mjs — Issue #65 detached Telegram send worker (standalone).
//
// stdin : one JSON object { text, configPath?, timeoutMs? }
// stdout: one JSON object { ok, status, messageId?, chatId?, error? }
//
// Statuses (Issue #65 req 4):
//   API_ACCEPTED   — Bot API returned ok:true; messageId is concrete evidence.
//   DELIVERY_FAILED — bounded attempts exhausted (HTTP/network error).
//   NOT_ATTEMPTED  — missing/invalid Telegram config; nothing was sent.
// USER_RECEIVED is NEVER claimed: API acceptance proves transport only.
//
// Transport: Bot API sendMessage, plain bounded HTML text. Bounded in-process
// retry (1 + 3 backoff) on 429/5xx/network — NOT a scheduler (Issue #65 req 10
// still holds: no background loop). Per-request timeout: REQUEST_TIMEOUT_MS=5000
// via AbortSignal.timeout — timeout aborts WITHOUT retry (fail-safe). Config: the EXISTING AI_PR_REVIEWER gateway file
// (~/.ai-pr-reviewer/tg.json or AI_PR_REVIEWER_TG_CONFIG), with TG_BOT_TOKEN /
// TG_CHAT_ID env overrides. Credentials are never copied into Soc_brain
// (docs/migration/AI_PR_SHARED_INFRA_INVENTORY.md) and never logged.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Bounded retry: 1 initial + 3 retries on HTTP 429 / 5xx / transient network
// errors, with exponential backoff. A per-request AbortSignal timeout aborts
// safely WITHOUT retry (fail-safe: never hangs past REQUEST_TIMEOUT_MS).
export const MAX_ATTEMPTS = 4;
export const REQUEST_TIMEOUT_MS = 5000;
export const DEFAULT_TIMEOUT_MS = REQUEST_TIMEOUT_MS;
export const RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000]);

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

function isRetryableHttpStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function isTimeoutError(e) {
  if (!e) return false;
  const name = e.name || '';
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  const code = e.code || '';
  return code === 'ETIMEDOUT' || code === 'ABORT_ERR' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT';
}

// One POST with bounded retry. Timeout => safe abort, NO retry (attempts stop).
// HTTP 429/5xx/network => retry with RETRY_DELAYS_MS backoff (max MAX_ATTEMPTS).
// Other non-2xx (e.g. 400/403) => fail immediately (non-retryable).
export async function sendJsonWithRetry({
  url,
  payload,
  timeoutMs = REQUEST_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  sleepImpl = null,
  maxAttempts = MAX_ATTEMPTS,
  retryDelays = RETRY_DELAYS_MS,
  headers = { 'Content-Type': 'application/json' },
  method = 'POST',
  bodyOverride = undefined,
}) {
  const doSleep = typeof sleepImpl === 'function'
    ? sleepImpl
    : (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  let lastErr = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let r;
    try {
      r = await fetchImpl(url, {
        method,
        headers,
        body: bodyOverride !== undefined ? bodyOverride : JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (isTimeoutError(e)) {
        // Fail-safe: timed out — abort the chain without burning retries.
        return {
          ok: false,
          status: 'DELIVERY_FAILED',
          error: `TIMEOUT_${timeoutMs}MS`,
          timeout: true,
          attempts: attempt,
          retryable: false,
        };
      }
      lastErr = String((e && e.message) || e).slice(0, 200);
      if (attempt < maxAttempts) {
        const delay = retryDelays[Math.min(attempt - 1, retryDelays.length - 1)];
        await doSleep(delay);
        continue;
      }
      break;
    }
    if (r && r.ok) {
      const j = await r.json().catch(() => null);
      if (j && j.ok && j.result) {
        return {
          ok: true,
          status: 'API_ACCEPTED',
          messageId: j.result.message_id ?? null,
          chatId: (j.result.chat && j.result.chat.id) ?? null,
          attempts: attempt,
        };
      }
      lastErr = 'TELEGRAM_API_OK_FALSE';
      return { ok: false, status: 'DELIVERY_FAILED', error: lastErr, attempts: attempt, retryable: false };
    }
    const status = r && typeof r.status === 'number' ? r.status : 0;
    lastErr = `HTTP_${status}`;
    if (!isRetryableHttpStatus(status)) {
      return { ok: false, status: 'DELIVERY_FAILED', error: lastErr, attempts: attempt, retryable: false };
    }
    if (attempt < maxAttempts) {
      const delay = retryDelays[Math.min(attempt - 1, retryDelays.length - 1)];
      await doSleep(delay);
    }
  }
  return { ok: false, status: 'DELIVERY_FAILED', error: lastErr, attempts: maxAttempts, retryable: true };
}
function readConfig(configPath) {
  const p = configPath || process.env.AI_PR_REVIEWER_TG_CONFIG || path.join(os.homedir(), '.ai-pr-reviewer', 'tg.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (cfg && cfg.botToken && cfg.chatId) {
      return { botToken: String(cfg.botToken), chatId: String(cfg.chatId) };
    }
  } catch { /* fall through */ }
  return null;
}

async function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (e) {
    emit({ ok: false, status: 'NOT_ATTEMPTED', reason: 'STDIN_READ_FAIL', error: String((e && e.message) || e) });
    return;
  }
  let req;
  try {
    req = JSON.parse(raw);
  } catch (e) {
    emit({ ok: false, status: 'NOT_ATTEMPTED', reason: 'STDIN_JSON_INVALID', error: String((e && e.message) || e) });
    return;
  }
  const text = req && typeof req.text === 'string' ? req.text : '';
  if (!text) {
    emit({ ok: false, status: 'NOT_ATTEMPTED', reason: 'TEXT_REQUIRED' });
    return;
  }
  const cfg = readConfig(req && req.configPath);
  if (!cfg) {
    emit({ ok: false, status: 'NOT_ATTEMPTED', reason: 'TELEGRAM_CONFIG_UNAVAILABLE' });
    return;
  }
  const timeoutMs = Number(req && req.timeoutMs) > 0 ? Number(req.timeoutMs) : DEFAULT_TIMEOUT_MS;
  // Document branch (ControlLoop READY_FOR_REVIEW review packet): ONE UTF-8
  // document via sendDocument. Same status semantics as the text branch.
  const documentPath = req && typeof req.documentPath === 'string' ? req.documentPath : '';
  if (documentPath) {
    await sendDocument(cfg, documentPath, typeof req.caption === 'string' ? req.caption.slice(0, 900) : '', timeoutMs);
    return;
  }
  const sendResult = await sendJsonWithRetry({
    url: `https://api.telegram.org/bot${cfg.botToken}/sendMessage`,
    payload: { chat_id: cfg.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true },
    timeoutMs,
  });
  if (sendResult.ok) {
    emit({ ok: true, status: 'API_ACCEPTED', messageId: sendResult.messageId, chatId: sendResult.chatId });
    return;
  }
  emit({ ok: false, status: sendResult.status, error: sendResult.error });
}

// Send ONE document via Bot API sendDocument (multipart/form-data, built by
// hand — no new dependency). Status semantics identical to sendMessage:
// API_ACCEPTED only when the Bot API returns ok:true with a concrete
// message_id; bounded attempts; never claims USER_RECEIVED.
async function sendDocument(cfg, documentPath, caption, timeoutMs) {
  let payload;
  try {
    payload = fs.readFileSync(documentPath);
  } catch (e) {
    emit({ ok: false, status: 'NOT_ATTEMPTED', reason: 'DOCUMENT_UNREADABLE', error: String((e && e.message) || e) });
    return;
  }
  const boundary = `sbdoc-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  const field = (name, value) => Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8');
  const fileHead = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${path.basename(documentPath)}"\r\nContent-Type: application/octet-stream\r\n\r\n`, 'utf8');
  const body = Buffer.concat([
    field('chat_id', cfg.chatId),
    ...(caption ? [field('caption', caption)] : []),
    field('parse_mode', 'HTML'),
    fileHead,
    payload,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);
  const docResult = await sendJsonWithRetry({
    url: `https://api.telegram.org/bot${cfg.botToken}/sendDocument`,
    payload: null,
    bodyOverride: body,
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    timeoutMs,
  });
  if (docResult.ok) {
    emit({ ok: true, status: 'API_ACCEPTED', messageId: docResult.messageId, chatId: docResult.chatId });
    return;
  }
  emit({ ok: false, status: docResult.status, error: docResult.error });
}

// Main-guard: importing this module (offline unit tests) must NOT consume
// stdin or emit worker output — only a direct CLI/child-process run starts main().
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((e) => {
    emit({ ok: false, status: 'DELIVERY_FAILED', error: String((e && e.message) || e) });
  });
}
