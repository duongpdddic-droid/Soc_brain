#!/usr/bin/env node
// telegram-dispatch.mjs — Soc_brain canonical Telegram lifecycle dispatcher (Issue #65).
//
// WHY: Issue #63 forensic proved the TASK_COMPLETED sender WAS invoked and the
// Telegram API accepted it (message_id=708). The defect is architectural:
// notification depended on the executor/prompt REMEMBERING to run a script.
// This module makes Telegram lifecycle delivery a deterministic consequence of
// canonical Task FSM transitions (packages/runtime-sandbox), never an executor
// memory task.
//
// Design (Issue #65 constraints):
//   - Narrowest shared seam: the FSM operations in runtime-sandbox call
//     dispatchLifecycleEvent() with the AUTHORITATIVE session record. There is
//     exactly one dispatcher; Cline/OpenCode/executors never re-implement it.
//   - FSM correctness is independent of Telegram (req 3): dispatch is
//     best-effort, NEVER throws into the FSM path, and NEVER mutates canonical
//     task state. A transport failure only persists truthful evidence.
//   - Truthful evidence levels ONLY (req 4): NOT_ATTEMPTED / API_ACCEPTED /
//     DELIVERY_FAILED. USER_RECEIVED is NEVER inferred from API_ACCEPTED.
//   - Exactly-once (req 9): append-only JSONL under <stateDir>/telegram-dispatch/.
//     Any prior attempt (API_ACCEPTED or DELIVERY_FAILED) for the same event
//     dedupes — a duplicate/replayed transition cannot send twice.
//   - No event bus, notification framework, retry scheduler, bot UI, polling
//     system, or AI router (req 10). One bounded send per transition.
//
// Sync note: taskStart/taskFinish are synchronous, so the actual Telegram call
// runs in a detached worker subprocess (telegram-worker.mjs) with a bounded
// timeout. A hanging network call can never stall FSM admission.
//
// Formatting authority (req 7): buildTelegramText() is the ONLY renderer. The
// worker sends exactly the text it receives; lifecycle code never formats.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { identityHash } from '../workspace/workspace.mjs';

export const TELEGRAM_DISPATCH_SCHEMA_VERSION = '1';

// The minimum lifecycle transitions that MUST notify (Issue #65).
export const NOTIFIABLE_EVENTS = Object.freeze([
  'TASK_STARTED', 'TASK_COMPLETED', 'TASK_BLOCKED', 'TASK_FAILED', 'HUMAN_GATE_REQUIRED',
]);

// Evidence levels (req 4). USER_RECEIVED deliberately absent.
export const DELIVERY_STATUSES = Object.freeze(['NOT_ATTEMPTED', 'API_ACCEPTED', 'DELIVERY_FAILED']);

const WORKER_PATH = fileURLToPath(new URL('./telegram-worker.mjs', import.meta.url));
const WORKER_TIMEOUT_MS = 20000;
const TEXT_MAX_CHARS = 900;

export function defaultStateDir() {
  return path.join(os.homedir(), '.soc-brain', 'state');
}

// Append-only dispatch evidence ledger. Sibling of sessions/ and telemetry/ —
// control-plane state OUTSIDE every worktree (same authority model).
export function dispatchPathFor({ stateDir, identityHash: h }) {
  if (typeof stateDir !== 'string' || !stateDir) {
    throw new TypeError('dispatchPathFor: stateDir must be a non-empty string.');
  }
  if (typeof h !== 'string' || !h) {
    throw new TypeError('dispatchPathFor: identityHash must be a non-empty string.');
  }
  return path.join(path.resolve(stateDir), 'telegram-dispatch', `${h}.jsonl`);
}

export function readDispatchRecords(dispatchPath) {
  try {
    const raw = fs.readFileSync(dispatchPath, 'utf8');
    return raw.split(/\r?\n/).filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch { return { malformed: l.slice(0, 200) }; }
    });
  } catch {
    return [];
  }
}

function appendRecord(dispatchPath, record) {
  try {
    fs.mkdirSync(path.dirname(dispatchPath), { recursive: true });
    fs.appendFileSync(dispatchPath, `${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The single Telegram renderer (req 7). Plain, escaped, bounded HTML.
export function buildTelegramText({ event, session }) {
  const taskId = session.taskId ? String(session.taskId) : `${session.repo}#${session.issueNumber}`;
  const branch = session.branch ? ` branch ${session.branch}` : '';
  const head = session.headSha ? ` head ${String(session.headSha).slice(0, 12)}` : '';
  return [
    `[Soc_brain] ${esc(event)}`,
    esc(taskId) + branch + head,
  ].join('\n').slice(0, TEXT_MAX_CHARS);
}

// Run one bounded worker attempt. The worker resolves the EXISTING
// AI_PR_REVIEWER Telegram config itself (no credentials are copied into
// Soc_brain — see docs/migration/AI_PR_SHARED_INFRA_INVENTORY.md).
function runWorker({ text, spawn, configPath }) {
  let res;
  try {
    res = spawn(process.execPath, [WORKER_PATH], {
      input: `${JSON.stringify({ text, configPath: configPath || null })}\n`,
      encoding: 'utf8',
      windowsHide: true,
      timeout: WORKER_TIMEOUT_MS,
      cwd: path.dirname(WORKER_PATH),
    });
  } catch (e) {
    return { status: 'NOT_ATTEMPTED', reason: 'WORKER_SPAWN_FAILED', error: String((e && e.message) || e) };
  }
  if (!res || res.error || typeof res.stdout !== 'string' || !res.stdout.trim()) {
    const code = res && res.error && res.error.code ? res.error.code : 'WORKER_NO_OUTPUT';
    return { status: 'NOT_ATTEMPTED', reason: code, error: res && res.stderr ? String(res.stderr).slice(0, 200) : null };
  }
  try {
    const j = JSON.parse(res.stdout.trim().split(/\r?\n/).pop());
    if (j && typeof j.status === 'string') return j;
  } catch { /* fall through */ }
  return { status: 'NOT_ATTEMPTED', reason: 'WORKER_OUTPUT_INVALID', error: String(res.stdout).slice(0, 200) };
}

// Canonical entry point. Called by runtime-sandbox FSM operations ONLY.
//
// Dispatch activates on the machine control-plane state root (~/.soc-brain/state).
// Isolated/test state roots are dispatch-silent unless allowNonCanonicalStateRoot
// is explicitly true — deterministic, NOT executor-controlled (req 9: an
// executor can never suppress a notification; the gate is not an executor knob).
export function dispatchLifecycleEvent({
  session, event, stateDir, spawn = spawnSync, configPath = null,
  allowNonCanonicalStateRoot = false, now = null,
} = {}) {
  try {
    if (!session || typeof session !== 'object' || Array.isArray(session)) {
      return { ok: false, status: 'NOT_ATTEMPTED', reason: 'SESSION_REQUIRED' };
    }
    if (!NOTIFIABLE_EVENTS.includes(event)) {
      return { ok: false, status: 'NOT_ATTEMPTED', reason: 'EVENT_NOT_NOTIFIABLE', event };
    }
    if (process.env.SOC_TELEGRAM_DISPATCH === 'off') {
      return { ok: false, status: 'NOT_ATTEMPTED', reason: 'TELEGRAM_DISPATCH_DISABLED', event };
    }
    const repo = typeof session.repo === 'string' ? session.repo : '';
    const issueNumber = Number(session.issueNumber);
    if (!repo || !Number.isInteger(issueNumber) || issueNumber <= 0) {
      return { ok: false, status: 'NOT_ATTEMPTED', reason: 'SESSION_IDENTITY_INVALID' };
    }
    const h = identityHash({ repo, issueNumber });
    if (!h) return { ok: false, status: 'NOT_ATTEMPTED', reason: 'IDENTITY_UNSTABLE' };
    const sd = stateDir || (session.controlPlane && session.controlPlane.stateDir) || defaultStateDir();
    // Deterministic state-root gate. A non-canonical root never reaches the
    // network, but the skipped attempt is still PERSISTED as truthful
    // NOT_ATTEMPTED evidence (req 4) instead of vanishing silently.
    let gateReason = null;
    if (!allowNonCanonicalStateRoot && path.resolve(sd) !== path.resolve(defaultStateDir())) {
      gateReason = 'DISPATCH_STATE_ROOT_NOT_CANONICAL';
    }
    const recPath = dispatchPathFor({ stateDir: sd, identityHash: h });
    const prior = readDispatchRecords(recPath).filter((r) => r && r.event === event);
    const attempted = prior.filter((r) => r.status === 'API_ACCEPTED' || r.status === 'DELIVERY_FAILED');
    // Exactly-once: ANY prior attempt for this event dedupes (req 9).
    if (attempted.length) {
      const last = attempted[attempted.length - 1];
      return { ok: last.status === 'API_ACCEPTED', status: last.status, messageId: last.messageId ?? null, deduped: true, recordsPath: recPath };
    }
    const text = buildTelegramText({ event, session });
    const res = gateReason ? { status: 'NOT_ATTEMPTED', reason: gateReason } : runWorker({ text, spawn, configPath });
    const status = res && res.status === 'API_ACCEPTED' ? 'API_ACCEPTED'
      : res && res.status === 'DELIVERY_FAILED' ? 'DELIVERY_FAILED' : 'NOT_ATTEMPTED';
    const record = {
      schemaVersion: TELEGRAM_DISPATCH_SCHEMA_VERSION,
      at: (now ? new Date(now) : new Date()).toISOString(),
      event, identityHash: h,
      taskId: session.taskId ?? null,
      repo, issueNumber,
      status,
      messageId: res && res.messageId != null ? res.messageId : null,
      chatId: res && res.chatId != null ? res.chatId : null,
      error: (res && (res.error ?? res.reason)) ?? null,
    };
    // NOT_ATTEMPTED is appended at most once per event (no unbounded growth).
    if (status === 'NOT_ATTEMPTED' && prior.length) {
      return { ok: false, status, messageId: null, recorded: false, reason: res.reason, recordsPath: recPath };
    }
    const recorded = appendRecord(recPath, record);
    return { ok: status === 'API_ACCEPTED', status, messageId: record.messageId, recorded, recordsPath: recPath, error: record.error };
  } catch (e) {
    return { ok: false, status: 'NOT_ATTEMPTED', reason: 'DISPATCH_INTERNAL_ERROR', error: String((e && e.message) || e) };
  }
}
