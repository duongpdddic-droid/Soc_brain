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
// Transport: Bot API sendMessage, plain bounded HTML text, 2 attempts max
// (no retry scheduler — a single bounded retry is transport hygiene, Issue #65
// req 10). Config: the EXISTING AI_PR_REVIEWER gateway file
// (~/.ai-pr-reviewer/tg.json or AI_PR_REVIEWER_TG_CONFIG), with TG_BOT_TOKEN /
// TG_CHAT_ID env overrides. Credentials are never copied into Soc_brain
// (docs/migration/AI_PR_SHARED_INFRA_INVENTORY.md) and never logged.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_ATTEMPTS = 2;
const DEFAULT_TIMEOUT_MS = 8000;
const RETRY_PAUSE_MS = 1200;

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

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
  let lastErr = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j && j.ok && j.result) {
          emit({ ok: true, status: 'API_ACCEPTED', messageId: j.result.message_id ?? null, chatId: (j.result.chat && j.result.chat.id) ?? null });
          return;
        }
        lastErr = 'TELEGRAM_API_OK_FALSE';
      } else {
        lastErr = `HTTP_${r.status}`;
      }
    } catch (e) {
      lastErr = String((e && e.message) || e).slice(0, 200);
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((res) => setTimeout(res, RETRY_PAUSE_MS));
  }
  emit({ ok: false, status: 'DELIVERY_FAILED', error: lastErr });
}

main().catch((e) => {
  emit({ ok: false, status: 'DELIVERY_FAILED', error: String((e && e.message) || e) });
});
