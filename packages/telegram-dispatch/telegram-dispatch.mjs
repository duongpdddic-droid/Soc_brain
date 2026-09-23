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
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { identityHash } from '../workspace/workspace.mjs';

export const TELEGRAM_DISPATCH_SCHEMA_VERSION = '2';

// Mandatory lifecycle milestones (rev-2 req B). READY_FOR_REVIEW and
// ROADMAP_COMPLETED are DISPATCHABLE here but their canonical OWNER state
// machines (review-handoff FSM, roadmap FSM) live outside runtime-sandbox —
// wiring them is explicitly deferred (rev-2 reqs F/G), not silently omitted.
//
// Granular FSM milestone events (Issue #9000021):
//   ROUTED        — task assigned to executor model/agent
//   EXECUTING     — start isolated worktree
//   VERIFYING     — start offline test suite with expected test count
//   FINAL_REVIEWING — payload packed, sent to reviewer
//   DECIDING      — verdict APPROVED or CHANGES_REQUESTED (Rework Round N)
//   DELIVERING    — PR link, diff summary, PowerShell command awaiting merge approval
export const NOTIFIABLE_EVENTS = Object.freeze([
  'TASK_STARTED', 'HUMAN_GATE_REQUIRED', 'READY_FOR_REVIEW',
  'TASK_COMPLETED', 'TASK_BLOCKED', 'TASK_FAILED', 'ROADMAP_COMPLETED',
  'ROUTED', 'EXECUTING', 'VERIFYING', 'FINAL_REVIEWING', 'DECIDING', 'DELIVERING',
]);

// Evidence levels (req 4). USER_RECEIVED deliberately absent.
export const DELIVERY_STATUSES = Object.freeze(['NOT_ATTEMPTED', 'API_ACCEPTED', 'DELIVERY_FAILED']);

// Bounded recovery budget per canonical event identity (rev-2 reqs A/C/H5):
// counted from persisted ledger evidence, so restarts cannot reset it.
export const MAX_DELIVERY_ATTEMPTS = 3;

const WORKER_PATH = fileURLToPath(new URL('./telegram-worker.mjs', import.meta.url));
const WORKER_TIMEOUT_MS = 20000;
const TEXT_MAX_CHARS = 1400;

// FIFO dispatch queue: minimum gap between Telegram worker spawns (FSM milestone
// burst rate-limit). Production default 400ms; tests may override via env
// TELEGRAM_DISPATCH_INTERVAL_MS=0 (or a smaller value) without touching source.
export const TELEGRAM_DISPATCH_INTERVAL_MS = 400;

let lastDispatchAtMs = 0;

function getDispatchIntervalMs() {
  const raw = process.env.TELEGRAM_DISPATCH_INTERVAL_MS;
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return TELEGRAM_DISPATCH_INTERVAL_MS;
}

function sleepSyncMs(ms) {
  if (!(ms > 0)) return;
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

// Synchronous FIFO slot: serialize spawns and enforce the minimum interval.
// Returns the number of ms actually waited (0 when the gap was already met).
export function awaitDispatchSlot({ nowMs = Date.now, intervalMs = null } = {}) {
  const interval = intervalMs != null && Number.isFinite(intervalMs) && intervalMs >= 0
    ? intervalMs
    : getDispatchIntervalMs();
  const now = nowMs();
  if (lastDispatchAtMs > 0 && interval > 0) {
    const wait = lastDispatchAtMs + interval - now;
    if (wait > 0) {
      sleepSyncMs(wait);
      lastDispatchAtMs = nowMs();
      return wait;
    }
  }
  lastDispatchAtMs = nowMs();
  return 0;
}

// Test-only: clear the FIFO watermark so suites start from a known state.
export function resetDispatchQueueForTests() {
  lastDispatchAtMs = 0;
}
// Bounded context resolution for human-first projection (rev-3 req): the
// "what is this task?" line is built from canonical state ONLY — never from
// an LLM call. Two sources, both fail-soft:
//   1. SOC_TASK_CONTRACT.md inside session.worktreePath (deterministic file
//      read; the contract is written by taskStart from Issue title+body, so
//      it is the same canonical truth, not a second one).
//   2. `gh pr list --head <branch> --json number,title` with a 3s bounded
//      timeout. When no PR exists yet, the projection falls back to
//      "PR: chưa tạo" so the user always sees a deterministic answer
//      instead of an empty line or a transport error.
const GH_BIN = process.env.SOC_GH_BIN || 'gh';
const GH_TIMEOUT_MS = 3000;
const OBJECTIVE_MAX_CHARS = 240;
const PR_TITLE_MAX_CHARS = 200;

function readTaskContractTitle(worktreePath) {
  if (!worktreePath || typeof worktreePath !== 'string') return null;
  try {
    const p = path.join(path.resolve(worktreePath), 'SOC_TASK_CONTRACT.md');
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    // First '# ' heading line after the front matter; bounded to 8 KiB read
    // so a runaway contract cannot stall the render path.
    const head = raw.slice(0, 8192);
    const m = /^#\s+Task Contract\s+[—-]\s+(.+)$/m.exec(head);
    if (!m) return null;
    const title = String(m[1]).trim();
    return title || null;
  } catch {
    return null;
  }
}

function resolvePrContext({ repo, branch, exec = execFileSync }) {
  if (!repo || !branch || typeof repo !== 'string' || typeof branch !== 'string') {
    return { present: false, reason: 'NO_BRANCH' };
  }
  try {
    const out = exec.execFileSync(GH_BIN, [
      'pr', 'list',
      '--repo', repo,
      '--head', branch,
      '--state', 'all',
      '--json', 'number,title,state,url',
      '--limit', '1',
    ], {
      encoding: 'utf8',
      timeout: GH_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const arr = JSON.parse(out);
    if (!Array.isArray(arr) || arr.length === 0) return { present: false, reason: 'NO_PR' };
    const pr = arr[0] || {};
    const num = Number(pr.number);
    if (!Number.isInteger(num)) return { present: false, reason: 'NO_PR' };
    const title = typeof pr.title === 'string' ? pr.title : '';
    return { present: true, number: num, title };
  } catch {
    return { present: false, reason: 'GH_UNAVAILABLE' };
  }
}

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

// Entity-safe final truncation: never cut a UTF-16 surrogate pair and never leave
// a partial HTML entity (&l / &am) at the boundary — Telegram rejects those with
// HTTP 400 can’t parse entities. Only invoked AFTER esc() has produced entities.
export function boundTelegramText(input, maxChars = TEXT_MAX_CHARS) {
  const s = String(input ?? '');
  if (s.length <= maxChars) return s;
  let cut = maxChars;
  const unit = s.charCodeAt(cut - 1);
  if (unit >= 0xD800 && unit <= 0xDBFF) cut -= 1; // do not split a surrogate pair
  let out = s.slice(0, cut);
  const lastAmp = out.lastIndexOf('&');
  if (lastAmp !== -1 && out.indexOf(';', lastAmp) === -1) {
    out = out.slice(0, lastAmp); // drop the partial entity
  }
  return out;
}
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
  // Granular FSM milestone events (Issue #9000021)
  ROUTED: {
    emoji: '🚀',
    what: 'Task đã được giao cho executor/model.',
    action: 'Bạn không cần làm gì — executor đang chuẩn bị.',
  },
  EXECUTING: {
    emoji: '⚙️',
    what: 'Executor đang chạy trong worktree độc lập.',
    action: 'Bạn không cần làm gì — đang thực thi task.',
  },
  VERIFYING: {
    emoji: '🧪',
    what: 'Bộ test offline đang chạy để xác minh kết quả.',
    action: 'Bạn không cần làm gì — chờ kết quả verification.',
  },
  FINAL_REVIEWING: {
    emoji: '🔍',
    what: 'Payload review đã đóng gói, gửi cho reviewer độc lập.',
    action: 'Bạn không cần làm gì — chờ verdict.',
  },
  DECIDING: {
    emoji: '⚖️',
    what: 'Verdict đã đến: APPROVED hoặc CHANGES_REQUESTED (Rework Round N).',
    action: 'Bạn không cần làm gì — ControlLoop xử lý quyết định.',
  },
  DELIVERING: {
    emoji: '🛑',
    what: 'Chờ duyệt merge từ con người. PR link + diff summary + lệnh PowerShell.',
    action: '→ Cần duyệt merge rõ ràng để hoàn tất task.',
  },
});

// The single Telegram renderer (req 7). Plain, escaped, bounded HTML.
// HUMAN-FIRST (rev-2 req E): event + task identity → the full human context
// (gate note/question, verbatim) → what it means → what the user must do →
// technical Ref metadata last.
//
// rev-3 (Issue #75 P0-C child enrichment): the projection also carries
// "Mục tiêu" (task objective) and "PR" so a user glancing at Telegram
// instantly knows what the task IS and whether the PR is up. Both come from
// canonical state only — the contract file or `gh pr list` — never from an
// LLM call. They are passed in by the dispatcher (see dispatchLifecycleEvent)
// so this renderer stays a pure function and is unit-testable without IO.
export function buildTelegramText({
  event, session, note = null,
  objective = null, pr = null,
} = {}) {
  const t = HUMAN_TEMPLATES[event]
    || { emoji: '🔔', what: 'Có thay đổi trạng thái task.', action: '' };
  const repo = session && session.repo ? String(session.repo) : '?';
  const issue = session && Number(session.issueNumber) ? Number(session.issueNumber) : '?';
  const lines = [`${t.emoji} ${esc(event)} — Soc_brain ${esc(repo)}#${issue}`];
  // Task objective: derived from SOC_TASK_CONTRACT.md (canonical contract
  // written by taskStart). When the contract is absent (e.g. legacy session
  // or dispatch before taskStart wrote it), the line is omitted entirely
  // instead of guessing — guessing would be a second truth.
  if (typeof objective === 'string' && objective.trim()) {
    lines.push(`Mục tiêu: ${esc(objective.trim().slice(0, OBJECTIVE_MAX_CHARS))}`);
  }
  // PR context: explicit "PR: <n> — <title>" when present, deterministic
  // "PR: chưa tạo" when gh resolution is bounded-failed or empty, omitted
  // when the caller did not ask for it (so the renderer stays pure when
  // called from a test).
  if (pr && typeof pr === 'object' && pr.present === true && Number.isInteger(pr.number)) {
    const t1 = typeof pr.title === 'string' && pr.title.trim()
      ? ` — ${esc(pr.title.trim().slice(0, PR_TITLE_MAX_CHARS))}` : '';
    lines.push(`PR: #${pr.number}${t1}`);
  } else if (pr && typeof pr === 'object' && pr.present === false) {
    lines.push('PR: chưa tạo');
  }
  const body = note ?? (session && session.humanGate && session.humanGate.note) ?? null;
  if (body) lines.push('', esc(String(body).slice(0, 600)));
  lines.push('', t.what);
  if (t.action) lines.push(t.action);
  const branch = session && session.branch ? String(session.branch) : '';
  const head = session && session.headSha ? String(session.headSha).slice(0, 12) : '';
  if (branch || head) lines.push('', `Ref: ${esc(branch)}${head ? ` @ ${esc(head)}` : ''}`);
  return boundTelegramText(lines.join('\n'), TEXT_MAX_CHARS);
}

// Run one bounded worker attempt. The worker resolves the EXISTING
// AI_PR_REVIEWER Telegram config itself (no credentials are copied into
// Soc_brain — see docs/migration/AI_PR_SHARED_INFRA_INVENTORY.md).
function runWorker({ text, spawn, configPath, documentPath = null }) {
  let res;
  try {
    res = spawn(process.execPath, [WORKER_PATH], {
      input: `${JSON.stringify({ text, configPath: configPath || null, documentPath: documentPath || null, caption: text })}\n`,
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
  allowNonCanonicalStateRoot = false, now = null, note = null, documentPath = null,
  _retryVoided = false,
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
    const packetExtra = documentPath ? { packet: path.basename(documentPath) } : {};
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
    appendRecord(recPath, mkRecord({ event, h, repo, issueNumber, session, status: 'NOT_ATTEMPTED', now, extra: { phase: 'intent', attemptN: attempts + 1, ...packetExtra } }));
    // 2. One bounded send attempt. The objective/PR context is resolved from
    //    canonical state ONLY (contract file + bounded `gh pr list`), both
    //    fail-soft: any resolution failure degrades the projection to a
    //    deterministic fallback (objective line omitted / "PR: chưa tạo"),
    //    never blocks or mutates the FSM.
    let objective = null;
    try { objective = readTaskContractTitle(session.worktreePath); } catch { objective = null; }
    let prCtx = { present: false, reason: 'NO_BRANCH' };
    try {
      prCtx = resolvePrContext({ repo, branch: session.branch || null, exec: execFileSync });
    } catch { prCtx = { present: false, reason: 'GH_UNAVAILABLE' }; }
    const text = buildTelegramText({ event, session, note, objective, pr: prCtx });
    // FIFO rate-limit: serialize actual sends so FSM milestone bursts keep a
    // minimum TELEGRAM_DISPATCH_INTERVAL_MS gap (ledger intent is already
    // persisted above and is never delayed by the queue).
    awaitDispatchSlot();
    const res = runWorker({ text, spawn, configPath, documentPath });
    const status = res && res.status === 'API_ACCEPTED' ? 'API_ACCEPTED'
      : res && res.status === 'DELIVERY_FAILED' ? 'DELIVERY_FAILED' : 'NOT_ATTEMPTED';
    const record = mkRecord({ event, h, repo, issueNumber, session, status, now, extra: {
      phase: 'result',
      messageId: res && res.messageId != null ? res.messageId : null,
      chatId: res && res.chatId != null ? res.chatId : null,
      error: (res && (res.error ?? res.reason)) ?? null,
      attemptN: attempts + 1,
      ...packetExtra,
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
  allowNonCanonicalStateRoot = false, now = null, note = null, documentPath = null,
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
    return dispatchLifecycleEvent({ session, event, stateDir: sd, spawn, configPath, allowNonCanonicalStateRoot: true, now, note, documentPath, _retryVoided: true });
  } catch (e) {
    return { ok: false, status: 'NOT_ATTEMPTED', reason: 'RECOVERY_INTERNAL_ERROR', error: String((e && e.message) || e) };
  }
}
