#!/usr/bin/env node
// telegram-dispatch.mjs — Soc_brain canonical Telegram lifecycle dispatcher
// (Issue #65, rev-2 after GPT CHANGES_REQUESTED review).
//
// WHY: Issue #63 forensic proved the TASK_COMPLETED sender WAS invoked and the
// Telegram API accepted it (message_id=708). The defect is architectural:
// notification depended on the executor/prompt REMEMBERING to run a script.
// This module makes Telegram lifecycle delivery a deterministic consequence of
// canonical Task FSM transitions (packages/runtime-sandbox), never an executor
// memory task.
//
// Delivery semantics (rev-2, review blocker A):
//   NOT_ATTEMPTED --attempt--> API_ACCEPTED(messageId)
//       = terminal delivery evidence; the ONLY state that permanently
//       suppresses duplicate delivery for the same canonical event identity.
//   NOT_ATTEMPTED --attempt--> DELIVERY_FAILED
//       = NOT delivered; stays recoverable through an explicit bounded
//       recovery call (recoverLifecycleEvent). It is never labeled
//       "exactly-once completed".
//   Recovery budget: MAX_DELIVERY_ATTEMPTS counted from the ledger. Repeated
//   failed recovery is bounded; there is NO autonomous retry, scheduler,
//   background worker, or polling loop anywhere.
//
// Crash/restart semantics (rev-2 reqs B/C):
//   The notification INTENT is appended to the ledger BEFORE the send attempt.
//   A process death between the intent append and the worker result leaves a
//   NOT_ATTEMPTED intent record that recoverLifecycleEvent() can still
//   deliver; an API_ACCEPTED record is never re-sent after a restart.
//
// Design constraints (unchanged from rev-1):
//   - Narrowest shared seam: the FSM operations in runtime-sandbox call
//     dispatchLifecycleEvent() with the AUTHORITATIVE session record. There is
//     exactly one dispatcher; Cline/OpenCode/executors never re-implement it.
//   - FSM correctness is independent of Telegram (req 3): dispatch is
//     best-effort, NEVER throws into the FSM path, and NEVER mutates canonical
//     task state. A transport failure only persists truthful evidence.
//   - Truthful evidence levels ONLY (req 4): NOT_ATTEMPTED / API_ACCEPTED /
//     DELIVERY_FAILED. USER_RECEIVED is NEVER inferred from API_ACCEPTED.
//   - No event bus, notification framework, retry scheduler, bot UI, polling
//     system, or AI router (req 10).
//
// Sync note: taskStart/taskFinish are synchronous, so the actual Telegram call
// runs in a detached worker subprocess (telegram-worker.mjs) with a bounded
// timeout. A hanging network call can never stall FSM admission.
//
// Formatting authority (req 7 + rev-2 req E): buildTelegramText() is the ONLY
// renderer; it is HUMAN-FIRST (what happened / which task / what to do) with
// machine identity (branch/head) as secondary metadata. The worker sends
// exactly the text it receives; lifecycle code never formats.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { identityHash } from '../workspace/workspace.mjs';

export const TELEGRAM_DISPATCH_SCHEMA_VERSION = '2';

// Mandatory lifecycle milestones (rev-2 req B). READY_FOR_REVIEW and
// ROADMAP_COMPLETED are DISPATCHABLE here but their canonical OWNER state
// machines (review-handoff FSM, roadmap FSM) live outside runtime-sandbox —
// wiring them is explicitly deferred (rev-2 reqs F/G), not silently omitted.
export const NOTIFIABLE_EVENTS = Object.freeze([
  'TASK_STARTED', 'HUMAN_GATE_REQUIRED', 'READY_FOR_REVIEW',
  'TASK_COMPLETED', 'TASK_BLOCKED', 'TASK_FAILED', 'ROADMAP_COMPLETED',
]);

// Evidence levels (req 4). USER_RECEIVED deliberately absent.
export const DELIVERY_STATUSES = Object.freeze(['NOT_ATTEMPTED', 'API_ACCEPTED', 'DELIVERY_FAILED']);

// Bounded recovery budget per canonical event identity (rev-2 reqs A/C/H5):
// counted from persisted ledger evidence, so restarts cannot reset it.
export const MAX_DELIVERY_ATTEMPTS = 3;

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

// Human-first templates (rev-2 req E): the user must instantly know what
// happened, which task it is, and whether action is required. Machine
// identity (branch/head) is secondary, rendered last.
const HUMAN_TEMPLATES = Object.freeze({
  TASK_STARTED: {
    emoji: '🚀',
    what: 'Executor đã bắt đầu phiên làm việc cho task này.',
    action: 'Bạn không cần làm gì — sẽ có báo cáo ở bước kế tiếp.',
  },
  HUMAN_GATE_REQUIRED: {
    emoji: '⏸️',
    what: 'Phiên làm việc đang dừng chờ quyết định của bạn.',
    action: '→ Trả lời câu hỏi phía trên trong phiên làm việc để tiếp tục.',
  },
  READY_FOR_REVIEW: {
    emoji: '📋',
    what: 'Bàn giao đã chốt: commit/push/verification/review packet hoàn tất.',
    action: 'Chờ review độc lập — bạn không cần hành động.',
  },
  TASK_COMPLETED: {
    emoji: '✅',
    what: 'Task đã hoàn tất, trạng thái canonical là COMPLETED.',
    action: 'Không cần hành động.',
  },
  TASK_BLOCKED: {
    emoji: '⛔',
    what: 'Task bị chặn — cần quyết định của bạn để tiếp tục.',
    action: '→ Xem phần mô tả phía trên và quyết định trong phiên làm việc.',
  },
  TASK_FAILED: {
    emoji: '❌',
    what: 'Task kết thúc với trạng thái FAILED.',
    action: '→ Cần bạn xem lại kết quả để định hướng bước tiếp theo.',
  },
  ROADMAP_COMPLETED: {
    emoji: '🏁',
    what: 'Toàn bộ lộ trình đã hoàn thành.',
    action: 'Không cần hành động.',
  },
});

// The single Telegram renderer (req 7). Plain, escaped, bounded HTML.
// HUMAN-FIRST (rev-2 req E): event + task identity → the full human context
// (gate note/question, verbatim) → what it means → what the user must do →
// technical Ref metadata last.
export function buildTelegramText({ event, session, note = null } = {}) {
  const t = HUMAN_TEMPLATES[event]
    || { emoji: '🔔', what: 'Có thay đổi trạng thái task.', action: '' };
  const repo = session && session.repo ? String(session.repo) : '?';
  const issue = session && Number(session.issueNumber) ? Number(session.issueNumber) : '?';
  const lines = [`${t.emoji} ${esc(event)} — Soc_brain ${esc(repo)}#${issue}`];
  const body = note ?? (session && session.humanGate && session.humanGate.note) ?? null;
  if (body) lines.push('', esc(String(body).slice(0, 600)));
  lines.push('', t.what);
  if (t.action) lines.push(t.action);
  const branch = session && session.branch ? String(session.branch) : '';
  const head = session && session.headSha ? String(session.headSha).slice(0, 12) : '';
  if (branch || head) lines.push('', `Ref: ${esc(branch)}${head ? ` @ ${esc(head)}` : ''}`);
  return lines.join('\n').slice(0, TEXT_MAX_CHARS);
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

// Canonical event identity from the AUTHORITATIVE session record. Never from
// caller-supplied fields other than the session itself (rev-2 req H10).
function sessionIdentity(session) {
  const repo = typeof session.repo === 'string' ? session.repo : '';
  const issueNumber = Number(session.issueNumber);
  if (!repo || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    return { ok: false, reason: 'SESSION_IDENTITY_INVALID' };
  }
  const h = identityHash({ repo, issueNumber });
  if (!h) return { ok: false, reason: 'IDENTITY_UNSTABLE' };
  return { ok: true, repo, issueNumber, h };
}

function mkRecord({ event, h, repo, issueNumber, session, status, now, extra = {} }) {
  return {
    schemaVersion: TELEGRAM_DISPATCH_SCHEMA_VERSION,
    at: (now ? new Date(now) : new Date()).toISOString(),
    event, identityHash: h,
    taskId: session.taskId ?? null,
    repo, issueNumber,
    status,
    messageId: null, chatId: null, error: null,
    ...extra,
  };
}

// A delivery ATTEMPT = a send that actually started or failed at transport:
// a DELIVERY_FAILED result, or an intent record whose group has NO result
// (crash orphan — counted conservatively). A NOT_ATTEMPTED result (config
// missing, spawn failed before any send) is truthfully NOT a delivery
// attempt and must not consume the recovery budget. Records are grouped by
// attemptN; legacy (schemaVersion 1) records stand alone.
function countAttempts(records) {
  const groups = new Map();
  records.forEach((r, i) => {
    const key = Number.isInteger(r.attemptN) ? r.attemptN : `legacy-${i}`;
    const g = groups.get(key) || { intent: false, failed: false, sent: false, void: false };
    if (r.phase === 'intent') g.intent = true;
    else if (r.status === 'API_ACCEPTED') g.sent = true;
    else if (r.status === 'DELIVERY_FAILED') g.failed = true;
    else g.void = true; // NOT_ATTEMPTED result — nothing reached the network.
    groups.set(key, g);
  });
  let attempts = 0;
  for (const g of groups.values()) {
    if (g.failed) attempts += 1;
    else if (g.intent && !g.sent && !g.void) attempts += 1; // orphaned intent (crash)
  }
  return attempts;
}

// Canonical entry point. Called by runtime-sandbox FSM operations ONLY.
//
// Dispatch activates on the machine control-plane state root (~/.soc-brain/state).
// Isolated/test state roots are dispatch-silent unless allowNonCanonicalStateRoot
// is explicitly true — deterministic, NOT executor-controlled (req 9: an
// executor can never suppress a notification; the gate is not an executor knob).
export function dispatchLifecycleEvent({
  session, event, stateDir, spawn = spawnSync, configPath = null,
  allowNonCanonicalStateRoot = false, now = null, note = null, _retryVoided = false,
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
    const identity = sessionIdentity(session);
    if (!identity.ok) return { ok: false, status: 'NOT_ATTEMPTED', reason: identity.reason };
    const { repo, issueNumber, h } = identity;
    const sd = stateDir || (session.controlPlane && session.controlPlane.stateDir) || defaultStateDir();
    // Deterministic state-root gate. A non-canonical root never reaches the
    // network, but the skipped attempt is still PERSISTED as truthful
    // NOT_ATTEMPTED evidence (req 4) instead of vanishing silently.
    let gateReason = null;
    if (!allowNonCanonicalStateRoot && path.resolve(sd) !== path.resolve(defaultStateDir())) {
      gateReason = 'DISPATCH_STATE_ROOT_NOT_CANONICAL';
    }
    const recPath = dispatchPathFor({ stateDir: sd, identityHash: h });
    const prior = readDispatchRecords(recPath).filter((r) => r && !r.malformed && r.event === event);
    // Terminal delivery evidence: ONLY API_ACCEPTED permanently suppresses
    // duplicate delivery (rev-2 blocker A). DELIVERY_FAILED and NOT_ATTEMPTED
    // never suppress — they remain recoverable through explicit bounded
    // recovery calls.
    const accepted = prior.filter((r) => r.status === 'API_ACCEPTED');
    if (accepted.length) {
      const last = accepted[accepted.length - 1];
      return { ok: true, status: 'API_ACCEPTED', messageId: last.messageId ?? null, deduped: true, recordsPath: recPath };
    }
    if (gateReason) {
      if (!prior.length) {
        appendRecord(recPath, mkRecord({ event, h, repo, issueNumber, session, status: 'NOT_ATTEMPTED', now, extra: { reason: gateReason } }));
      }
      return { ok: false, status: 'NOT_ATTEMPTED', reason: gateReason, recordsPath: recPath };
    }
    // Plain (transition-driven) dispatch NEVER re-attempts when prior
    // evidence exists: ONLY API_ACCEPTED is terminal delivery; everything
    // else short-circuits truthfully and stays recoverable exclusively
    // through the explicit bounded recoverLifecycleEvent() call
    // (rev-2 blocker A: no autonomous retry).
    if (prior.length && !_retryVoided) {
      const last = prior[prior.length - 1];
      const attempts0 = countAttempts(prior);
      if (last.status === 'DELIVERY_FAILED') {
        return { ok: false, status: 'DELIVERY_FAILED', messageId: null, deduped: true, attempts: attempts0, recovery: attempts0 < MAX_DELIVERY_ATTEMPTS ? 'RECOVERABLE' : 'EXHAUSTED', recordsPath: recPath };
      }
      if (last.phase === 'intent') {
        // Crash orphan: intent persisted, no result record. Conservative:
        // counted as a delivery attempt; only recovery may deliver it.
        return { ok: false, status: 'NOT_ATTEMPTED', reason: 'CRASH_ORPHAN_INTENT', attempts: attempts0, recovery: attempts0 < MAX_DELIVERY_ATTEMPTS ? 'RECOVERABLE' : 'EXHAUSTED', recordsPath: recPath };
      }
      // NOT_ATTEMPTED result: nothing ever reached the transport.
      return { ok: false, status: 'NOT_ATTEMPTED', reason: last.reason ?? 'PRIOR_NOT_ATTEMPTED_PERSISTED', deduped: true, recordsPath: recPath };
    }
    const attempts = countAttempts(prior);
    if (attempts >= MAX_DELIVERY_ATTEMPTS) {
      // Bounded by PERSISTED evidence: restarts cannot reset the budget, and
      // there is no autonomous retry loop anywhere (rev-2 reqs A/H5).
      return { ok: false, status: 'NOT_ATTEMPTED', reason: 'ATTEMPT_BUDGET_EXHAUSTED', attempts, recordsPath: recPath };
    }
    // 1. Persist the notification INTENT before any send (rev-2 reqs B/C):
    //    a crash between this append and the worker result leaves recoverable
    //    evidence that the canonical event still needs notification.
    appendRecord(recPath, mkRecord({ event, h, repo, issueNumber, session, status: 'NOT_ATTEMPTED', now, extra: { phase: 'intent', attemptN: attempts + 1 } }));
    // 2. One bounded send attempt.
    const text = buildTelegramText({ event, session, note });
    const res = runWorker({ text, spawn, configPath });
    const status = res && res.status === 'API_ACCEPTED' ? 'API_ACCEPTED'
      : res && res.status === 'DELIVERY_FAILED' ? 'DELIVERY_FAILED' : 'NOT_ATTEMPTED';
    const record = mkRecord({ event, h, repo, issueNumber, session, status, now, extra: {
      phase: 'result',
      messageId: res && res.messageId != null ? res.messageId : null,
      chatId: res && res.chatId != null ? res.chatId : null,
      error: (res && (res.error ?? res.reason)) ?? null,
      attemptN: attempts + 1,
    } });
    const recorded = appendRecord(recPath, record);
    return { ok: status === 'API_ACCEPTED', status, messageId: record.messageId, recorded, attempts: attempts + 1, recordsPath: recPath, error: record.error };
  } catch (e) {
    return { ok: false, status: 'NOT_ATTEMPTED', reason: 'DISPATCH_INTERNAL_ERROR', error: String((e && e.message) || e) };
  }
}

// Explicit bounded recovery (rev-2 reqs A/C/D). ONE recovery attempt for a
// canonical event that already has delivery evidence but NO API_ACCEPTED.
// Events that were never canonically dispatched (no ledger records) are NEVER
// fabricated here; events with terminal API_ACCEPTED evidence dedupe. No
// internal loop, no scheduling: repeated recovery only happens through
// repeated explicit canonical calls, and every attempt drains the persisted
// bounded budget.
export function recoverLifecycleEvent({
  session, event, stateDir, spawn = spawnSync, configPath = null,
  allowNonCanonicalStateRoot = false, now = null, note = null,
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
    const identity = sessionIdentity(session);
    if (!identity.ok) return { ok: false, status: 'NOT_ATTEMPTED', reason: identity.reason };
    const sd = stateDir || (session.controlPlane && session.controlPlane.stateDir) || defaultStateDir();
    if (!allowNonCanonicalStateRoot && path.resolve(sd) !== path.resolve(defaultStateDir())) {
      // Non-canonical roots never reach the network and never gain records
      // through recovery.
      return { ok: false, status: 'NOT_ATTEMPTED', reason: 'DISPATCH_STATE_ROOT_NOT_CANONICAL' };
    }
    const recPath = dispatchPathFor({ stateDir: sd, identityHash: identity.h });
    const prior = readDispatchRecords(recPath).filter((r) => r && !r.malformed && r.event === event);
    if (!prior.length) {
      // Recovery never fabricates: only an event that was already dispatched
      // (intent/evidence exists) can be recovered.
      return { ok: false, status: 'NOT_ATTEMPTED', reason: 'NOTHING_TO_RECOVER', recordsPath: recPath };
    }
    return dispatchLifecycleEvent({ session, event, stateDir: sd, spawn, configPath, allowNonCanonicalStateRoot: true, now, note, _retryVoided: true });
  } catch (e) {
    return { ok: false, status: 'NOT_ATTEMPTED', reason: 'RECOVERY_INTERNAL_ERROR', error: String((e && e.message) || e) };
  }
}
