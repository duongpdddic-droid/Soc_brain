#!/usr/bin/env node
// telegram-worker.mjs — Issue #65 detached Telegram send worker (standalone).
//
// stdin : one JSON object { text, configPath?, documentPath?, caption? }
// stdout: one JSON object { ok, status, messageId?, chatId?, error? }
//
// Statuses (Issue #65 req 4):
//   API_ACCEPTED   — Bot API returned ok:true; messageId is concrete evidence.
//   DELIVERY_FAILED — bounded attempts exhausted (HTTP/network error).
//   NOT_ATTEMPTED  — missing/invalid Telegram config; nothing was sent.
// USER_RECEIVED is NEVER claimed: API acceptance proves transport only.
//
// Transport: Bot API sendMessage, plain bounded HTML text. Bounded in-process
// retry (1 + 3 backoff) only on HTTP 429 or classified transient network
// errors — NOT a scheduler (Issue #65 req 10 still holds: no background loop).
// Every request has a hard REQUEST_TIMEOUT_MS=5000 AbortSignal.timeout; timeout
// aborts WITHOUT retry (fail-safe). Config: the EXISTING AI_PR_REVIEWER gateway file
// (~/.ai-pr-reviewer/tg.json or AI_PR_REVIEWER_TG_CONFIG). Credentials are
// never copied into Soc_brain
// (docs/migration/AI_PR_SHARED_INFRA_INVENTORY.md) and never logged.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Bounded retry: 1 initial + 3 retries on HTTP 429 / classified transient
// network errors. A per-request AbortSignal timeout aborts safely WITHOUT retry.
export const MAX_ATTEMPTS = 4;
export const REQUEST_TIMEOUT_MS = 5000;
export const RETRY_DELAYS_MS = [1000, 2000, 4000];

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const TRANSIENT_NETWORK_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function isRetryableHttpStatus(status) {
  return status === 429;
}

function isTimeoutError(e) {
  if (!e) return false;
  const name = e.name || '';
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  return e.code === 'ABORT_ERR';
}

function transientNetworkCode(e) {
  let current = e;
  for (let depth = 0; current && depth < 5; depth += 1, current = current.cause) {
    const code = typeof current.code === 'string' ? current.code.toUpperCase() : '';
    if (TRANSIENT_NETWORK_CODES.has(code)) return code;
  }
  return null;
}

// One POST with bounded retry. Timeout => safe abort, NO retry (attempts stop).
// HTTP 429 / classified transient network errors => retry with fixed backoff.
// Every other HTTP or thrown error fails immediately (non-retryable).
export async function sendJsonWithRetry({
  url,
  payload,
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
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (isTimeoutError(e)) {
        // Fail-safe: timed out — abort the chain without burning retries.
        return {
          ok: false,
          status: 'DELIVERY_FAILED',
          error: `TIMEOUT_${REQUEST_TIMEOUT_MS}MS`,
          timeout: true,
          attempts: attempt,
          retryable: false,
        };
      }
      const networkCode = transientNetworkCode(e);
      if (!networkCode) {
        return {
          ok: false,
          status: 'DELIVERY_FAILED',
          error: 'NETWORK_ERROR',
          attempts: attempt,
          retryable: false,
        };
      }
      lastErr = `NETWORK_${networkCode}`;
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
function tryReadTelegramFile(p) {
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (cfg && cfg.botToken && cfg.chatId) {
      return { botToken: String(cfg.botToken), chatId: String(cfg.chatId) };
    }
  } catch { /* fall through */ }
  return null;
}

// Resolution order: explicit configPath > env TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID
// (both required) > AI_PR_REVIEWER_TG_CONFIG > ~/.ai-pr-reviewer/tg.json.
// Credentials are never logged and never copied into Soc_brain.
function readConfig(configPath) {
  if (configPath) {
    const c = tryReadTelegramFile(configPath);
    if (c) return c;
  }
  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  const envChat = process.env.TELEGRAM_CHAT_ID;
  if (envToken && envChat) {
    return { botToken: String(envToken), chatId: String(envChat) };
  }
  if (process.env.AI_PR_REVIEWER_TG_CONFIG) {
    const c = tryReadTelegramFile(process.env.AI_PR_REVIEWER_TG_CONFIG);
    if (c) return c;
  }
  return tryReadTelegramFile(path.join(os.homedir(), '.ai-pr-reviewer', 'tg.json'));
}

// Offline-safe healthcheck: resolves config presence only (no network, no token
// value in the result). Exported for callers that need a preflight probe.
export function telegramHealthcheck(configPath = null) {
  try {
    const cfg = readConfig(configPath);
    if (!cfg) {
      return { ok: false, status: 'NOT_CONFIGURED', hasToken: false, hasChatId: false };
    }
    return {
      ok: true,
      status: 'CONFIGURED',
      hasToken: Boolean(cfg.botToken),
      hasChatId: Boolean(cfg.chatId),
    };
  } catch (e) {
    return { ok: false, status: 'HEALTHCHECK_ERROR', hasToken: false, hasChatId: false };
  }
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
  // Document branch (ControlLoop READY_FOR_REVIEW review packet): ONE UTF-8
  // document via sendDocument. Same status semantics as the text branch.
  const documentPath = req && typeof req.documentPath === 'string' ? req.documentPath : '';
  if (documentPath) {
    await sendDocument(cfg, documentPath, typeof req.caption === 'string' ? req.caption.slice(0, 900) : '');
    return;
  }
  const sendResult = await sendJsonWithRetry({
    url: `https://api.telegram.org/bot${cfg.botToken}/sendMessage`,
    payload: { chat_id: cfg.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true },
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
async function sendDocument(cfg, documentPath, caption) {
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
  });
  if (docResult.ok) {
    emit({ ok: true, status: 'API_ACCEPTED', messageId: docResult.messageId, chatId: docResult.chatId });
    return;
  }
  emit({ ok: false, status: docResult.status, error: docResult.error });
}

// Main-guard: importing this module (offline unit tests) must NOT consume
// stdin or emit worker output — only a direct CLI/child-process run starts main().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    emit({ ok: false, status: 'DELIVERY_FAILED', error: String((e && e.message) || e) });
  });
}
