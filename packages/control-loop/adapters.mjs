// adapters.mjs — thin, library-only adapters for ControlLoop v0 (Issue #69).
//
// Ownership rule (hard invariant): adapters RETURN results/events only. None of
// them may trigger the canonical terminal transitions or write the canonical
// session record. Terminalization happens exclusively inside control-loop.mjs.
//
// Each adapter wraps ONE existing primitive:
//   router       -> execution-broker (queue admission)
//   executor     -> executor-launcher (startExecution/readExecutionStatus)
//   verifier     -> review-ready (deterministic handoff evidence)
//   preReview    -> Gemini native API (transport injected, optional)
//   finalReview  -> ChatGPT Web CDP (transport injected, optional)
//   delivery     -> telegram-dispatch (NOTIFIABLE_EVENTS)
//
// Transports for Gemini/ChatGPT are INJECTED via deps so every path stays
// deterministic in tests. Without a transport the adapter returns
// { ok:false, code:'NO_<X>_TRANSPORT' } — fail-closed, never fake a verdict.

import fs from 'node:fs';
import path from 'node:path';
import { readExecutionStatus, startExecution, readExecutionRecord } from '../executor-launcher/executor-launcher.mjs';
import { readSessionRecord } from '../runtime-sandbox/runtime-sandbox.mjs';
import {
  dispatchLifecycleEvent,
  NOTIFIABLE_EVENTS,
} from '../telegram-dispatch/telegram-dispatch.mjs';
import { DEFAULT_REVIEW_READY_DIR } from '../review-ready/review-ready.mjs';

// ---- ExecutionRouter -------------------------------------------------------
// Maps a bound canonical session to the executor route: { model, executorKind }
// (control-loop.mjs passes routeValue.model into the executor step).
// The execution-broker is deliberately NOT an admission gate here: its
// operations (status/diff/run_registered_test/commit) are executor-side tools,
// and launch admission is owned by startExecution's EXECUTION_ALREADY_RUNNING
// guard — no second admission authority is invented.
export function executorRouter({ model = null, executorKind = 'opencode' } = {}) {
  return function route({ sessionPath }) {
    const rs = readSessionRecord(sessionPath);
    if (!rs.ok) return { ok: false, code: rs.reason };
    if (rs.session.state !== 'SESSION_ACTIVE') {
      return { ok: false, code: 'SESSION_NOT_ACTIVE', detail: rs.session.state };
    }
    return { ok: true, value: { model: model ?? null, executorKind } };
  };
}

// ---- Executor adapter -------------------------------------------------------
// Wraps executor-launcher with the REAL transport: startExecution (control-plane
// launch authority) + readExecutionStatus (record-based status projection).
// Ownership: the adapter derives authority from the canonical session record —
// lease token is re-read from the session file (never trusted from the caller),
// binding from session.controlPlane.bindingPath, stateDir from
// session.controlPlane.stateDir. Returns the canonical execution record path;
// the ControlLoop passes it downstream to verifier/reviewers. Polls until the
// child process reaches a terminal execution status or the deadline elapses.
// Deps are injectable for deterministic tests; defaults are the real primitives.
export function launchExecutorAdapter({
  startExecution: start = startExecution,
  readStatus = readExecutionStatus,
  instruction = null,
  controlCwd = process.cwd(),
  pollDeadlineMs = 30 * 60 * 1000,
  pollIntervalMs = 2000,
  delay = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  return async function executor({ sessionPath, model = null }) {
    const rs = readSessionRecord(sessionPath);
    if (!rs.ok) return { ok: false, code: rs.reason };
    const session = rs.session;
    if (typeof start !== 'function') return { ok: false, code: 'NO_EXECUTOR_TRANSPORT' };
    if (typeof instruction !== 'string' || !instruction.trim()) {
      return { ok: false, code: 'INSTRUCTION_REQUIRED' };
    }
    const cp = session.controlPlane || {};
    const sd = cp.stateDir || null;
    if (!sd) return { ok: false, code: 'STATE_DIR_UNAVAILABLE' };
    // Binding authority: re-read the canonical binding file (taskStart's
    // transactional binding record), never a caller-supplied shape.
    if (!cp.bindingPath) return { ok: false, code: 'BINDING_UNAVAILABLE' };
    let binding = null;
    try {
      const j = JSON.parse(fs.readFileSync(cp.bindingPath, 'utf8'));
      if (j && j.path && j.identityHash && j.taskId && j.repo) binding = j;
    } catch { /* fall through to fail-closed */ }
    if (!binding) return { ok: false, code: 'BINDING_UNAVAILABLE' };
    // taskStart-return session shape: startExecution's verifySessionAuthority
    // compares session.lease.token against the persisted record's token, so the
    // wrapper carries the canonical lease value under leaseToken.
    const launchSession = { ...session, leaseToken: session.lease && session.lease.token };
    const launch = start({
      sessionPath,
      session: launchSession,
      binding,
      instruction,
      model,
      stateDir: sd,
      controlCwd,
    });
    if (!launch || launch.ok !== true) return { ok: false, code: 'LAUNCH_FAILED', detail: launch };
    const recPath = launch.recordPath ?? null;
    if (!recPath) return { ok: false, code: 'LAUNCH_HANDLE_INVALID', detail: 'handle missing recordPath' };
    const deadline = Date.now() + pollDeadlineMs;
    const TERMINAL_EXEC = new Set(['EXITED', 'FAILED', 'STOPPED', 'INTERRUPTED']);
    for (;;) {
      const st = readStatus({ stateDir: sd, repo: session.repo, issueNumber: session.issueNumber, includeActivity: false });
      if (st.ok && TERMINAL_EXEC.has(st.execution.status)) {
        if (st.execution.status !== 'EXITED') {
          return {
            ok: false,
            code: `EXECUTOR_${st.execution.status}`,
            detail: { terminalStatus: st.execution.terminalStatus ?? null, reason: st.execution.reason ?? null },
          };
        }
        return {
          ok: true,
          value: {
            executionStatus: st.execution.status,
            terminalStatus: st.execution.terminalStatus ?? null,
            reason: st.execution.reason ?? null,
            executionRecordPath: recPath,
          },
        };
      }
      if (!st.ok && fs.existsSync(recPath)) return { ok: false, code: 'EXECUTION_RECORD_UNREADABLE', detail: st.reason ?? null };
      if (Date.now() > deadline) return { ok: false, code: 'EXECUTOR_TIMEOUT', detail: st.ok ? st.execution.status : (st.reason ?? null) };
      await delay(pollIntervalMs);
    }
  };
}

// ---- Deterministic verifier adapter (P0-B, Issue #73) -----------------------
// Machine-checkable verification ONLY — no model, no network, no second
// evidence truth. Reuses the executor-launcher's canonical readExecutionRecord
// primitive on the executionRecordPath produced by the P0-A executor step: the
// record must exist, parse, match EXECUTION_SCHEMA_VERSION and sit at its
// canonical location (stateDir/executions/<identityHash>.json), and must carry
// THIS session's binding (repo/taskId/issueNumber/worktree/baseSha) — any
// missing/malformed/stale/mismatched evidence fails closed. Verdict mapping is
// fixed here so the record cannot invent states: terminalStatus EXITED with
// exitCode 0 and no signal -> PASS (deterministic evidence value); any other
// terminal status or a non-zero/signalled exit -> ok:false (the VERIFYING step
// never crosses to PRE_REVIEWING without an objectively verified execution).
// Ownership: the verifier READS evidence only — it never terminalizes the task
// and never approves review (ControlLoop stays the sole terminalization owner;
// VERIFICATION_PASS != REVIEW_PASS).
export function deterministicVerifierAdapter() {
  return async function verifier({ sessionPath, executionRecordPath }) {
    const rs = readSessionRecord(sessionPath);
    if (!rs.ok) return { ok: false, code: rs.reason };
    const session = rs.session;
    if (!executionRecordPath || typeof executionRecordPath !== 'string') {
      return { ok: false, code: 'EXECUTION_RECORD_MISSING' };
    }
    const cp = session.controlPlane || {};
    if (!cp.stateDir) return { ok: false, code: 'STATE_DIR_UNAVAILABLE' };
    // Load through the canonical primitive (fail-closed on missing file,
    // malformed JSON, wrong schema, or a record not at its canonical location).
    const r = readExecutionRecord({ stateDir: cp.stateDir, repo: session.repo, issueNumber: session.issueNumber });
    if (!r.ok) {
      return { ok: false, code: r.reason === 'EXECUTION_NOT_FOUND' ? 'EXECUTION_RECORD_MISSING' : r.reason, detail: r.detail ?? r.path ?? null };
    }
    // The executor step must hand over the canonical record itself, not a copy.
    if (path.resolve(r.path) !== path.resolve(executionRecordPath)) {
      return { ok: false, code: 'EXECUTION_RECORD_MISMATCH', detail: { canonical: r.path, provided: executionRecordPath } };
    }
    const record = r.record;
    // Stale-evidence gate: the record must be THIS bound session's execution.
    if (record.repo !== session.repo
      || Number(record.issueNumber) !== Number(session.issueNumber)
      || record.taskId !== session.taskId) {
      return { ok: false, code: 'EXECUTION_RECORD_STALE', detail: { taskId: record.taskId ?? null, repo: record.repo ?? null } };
    }
    if (session.worktreePath && record.worktreePath !== session.worktreePath) {
      return { ok: false, code: 'EXECUTION_RECORD_STALE', detail: 'worktree mismatch' };
    }
    if (session.baseSha && record.baseSha !== session.baseSha) {
      return { ok: false, code: 'EXECUTION_RECORD_STALE', detail: 'baseSha mismatch' };
    }
    // HEAD binding where available (records gain headSha only when the
    // executor persists it; absence is not a mismatch).
    if (session.headSha && record.headSha && record.headSha !== session.headSha) {
      return { ok: false, code: 'EXECUTION_RECORD_STALE', detail: 'headSha mismatch' };
    }
    if (!record.terminalStatus) {
      return { ok: false, code: 'EXECUTION_NOT_TERMINAL', detail: { pid: record.pid ?? null } };
    }
    if (record.terminalStatus === 'EXITED' && record.exitCode === 0 && !record.signal) {
      return { ok: true, value: {
        verdict: 'PASS',
        evidence: {
          kind: 'ExecutionRecord',
          source: 'executor-launcher/readExecutionRecord',
          executionRecordPath: r.path,
          identityHash: record.identityHash,
          taskId: record.taskId,
          repo: record.repo,
          issueNumber: record.issueNumber,
          branch: record.branch ?? null,
          baseSha: record.baseSha ?? null,
          headSha: record.headSha ?? null,
          worktreePath: record.worktreePath ?? null,
          executor: record.executor ?? null,
          model: record.model ?? null,
          startedAt: record.startedAt ?? null,
          finishedAt: record.finishedAt ?? null,
          exitCode: record.exitCode,
        },
      } };
    }
    if (record.terminalStatus !== 'EXITED') {
      return { ok: false, code: `EXECUTOR_${record.terminalStatus}`, detail: { terminalStatus: record.terminalStatus, reason: record.reason ?? null, exitCode: record.exitCode ?? null } };
    }
    return { ok: false, code: 'EXECUTION_VERIFICATION_FAILED', detail: { terminalStatus: record.terminalStatus, exitCode: record.exitCode ?? null, signal: record.signal ?? null } };
  };
}

// ---- Gemini pre-review adapter (thin) ---------------------------------------
// Rework round 2: canonical evidence selection, bounded prompt construction,
// and STRICT response validation live in gemini-pre-review.mjs. This stays a
// thin seam: bind the injected transport to the canonical-evidence pre-review.
// (createGeminiPreReview is imported at the bottom to keep the adapters ->
// gemini-pre-review -> adapters cycle load-safe: packetPathFor below is a
// hoisted function declaration, so the partial module already exposes it.)
export function geminiPreReviewAdapter({ transport = null, reviewReadyDir = null } = {}) {
  return createGeminiPreReview({ transport, reviewReadyDir });
}

// ESM circular-import tail: gemini-pre-review.mjs imports packetPathFor from
// this module; function declarations are hoisted, so the binding is live.
import { createGeminiPreReview } from './gemini-pre-review.mjs';
import { createGptFinalReview } from './gpt-final-review.mjs';

// ---- GPT-5.6 Sol final review adapter (thin, ChatGPT Web CDP) ---------------
// Thin seam (P0-D, Issue #77): canonical evidence selection, bounded prompt
// (Gemini pre-review as a clearly-labeled SECONDARY section), strict response
// validation, echoed-binding gate, and the hard timeout all live in
// gpt-final-review.mjs. This stays a thin seam: bind the injected transport to
// the canonical final review. Ownership unchanged: the returned value is DATA
// only; the ControlLoop consumes decision.verdict and stays the sole
// terminalization owner.
export function gptFinalReviewAdapter({ transport = null, reviewReadyDir = null, timeoutMs } = {}) {
  return createGptFinalReview({ transport, reviewReadyDir, timeoutMs });
}

// ---- Review packet (canonical review-ready projection) -----------------------
// Resolve the EXISTING canonical review-ready artifact for a bound session.
// Reuses the review-ready primitive's filename scheme — no second review truth
// is constructed; if the canonical artifact has not been projected yet, the
// adapter returns NO_REVIEW_PACKET (fail-closed, no fabrication).
export function packetPathFor({ reviewReadyDir = null, sessionPath = null } = {}) {
  let session = null;
  if (sessionPath) {
    const rs = readSessionRecord(sessionPath);
    if (rs.ok) session = rs.session;
  }
  if (!session) return { ok: false, code: 'NO_REVIEW_PACKET' };
  const repo = typeof session.repo === 'string' ? session.repo : '';
  const issue = Number(session.issueNumber);
  if (!repo || !Number.isInteger(issue) || issue <= 0) return { ok: false, code: 'NO_REVIEW_PACKET' };
  // The review-ready projection dir is the review-ready primitive's own
  // default (~/.soc-brain/review-ready) unless explicitly overridden — the
  // artifact is a global (repo, issue) projection, not state-root local.
  const dir = reviewReadyDir || DEFAULT_REVIEW_READY_DIR();
  // Prefix mirror of review-ready's buildReviewReadyFilename (pr/headSha are
  // per-HEAD components, unknown at resolve time). Match is CASE-INSENSITIVE:
  // the session stores the canonical lowercase repo ('.../soc_brain') while the
  // artifact slug preserves the handoff identity casing ('.../Soc_brain').
  //   <repo-with-/-replaced-by-_>_Issue-<n>_PR-<p>_<7-hex>_review-ready.md
  const prefix = `${repo.replace(/\//g, '_').replace(/[^A-Za-z0-9._-]+/g, '_')}_Issue-${issue}_PR-`.toLowerCase();
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { ok: false, code: 'NO_REVIEW_PACKET' }; // no review-ready dir yet
  }
  const matches = entries
    .filter((e) => e.isFile()
      && e.name.toLowerCase().startsWith(prefix)
      && e.name.toLowerCase().endsWith('_review-ready.md'))
    .map((e) => path.join(dir, e.name))
    .sort()
    .reverse(); // newest first (filenames embed headSha short; lexical = chronological)
  if (!matches.length) return { ok: false, code: 'NO_REVIEW_PACKET' };
  return { ok: true, packetPath: matches[0], filename: path.basename(matches[0]) };
}

// ---- Delivery adapter --------------------------------------------------------
// Wraps telegram-dispatch for the DELIVERING step: the pre-terminal READY_FOR_REVIEW
// summary (status text) plus ONE attached UTF-8 Markdown review packet resolved
// from the canonical review-ready projection. Only NOTIFIABLE_EVENTS may be
// delivered; the canonical TASK_COMPLETED event itself is still emitted by the
// runtime-sandbox terminal transition — this step never sends lifecycle events
// itself and never terminalizes.
export function telegramDeliveryAdapter({ stateDir = null, configPath = null, packetPath = null, reviewReadyDir = null, spawn } = {}) {
  return async function delivery({ sessionPath, decision }) {
    const rs = readSessionRecord(sessionPath);
    if (!rs.ok) return { ok: false, code: rs.reason };
    const event = 'READY_FOR_REVIEW';
    if (!NOTIFIABLE_EVENTS.includes(event)) return { ok: false, code: 'EVENT_NOT_NOTIFIABLE', detail: event };
    const sd = stateDir || path.dirname(path.dirname(sessionPath));
    const packet = packetPath
      ? { ok: true, packetPath, filename: path.basename(packetPath) }
      : packetPathFor({ reviewReadyDir, sessionPath });
    if (!packet.ok) return { ok: false, code: packet.code || 'NO_REVIEW_PACKET' };
    const d = dispatchLifecycleEvent({
      session: rs.session, event, stateDir: sd, configPath, spawn,
      note: decision && decision.verdict, documentPath: packet.packetPath,
    });
    if (!d || (d.status !== 'API_ACCEPTED' && d.status !== 'DELIVERY_FAILED' && d.status !== 'NOT_ATTEMPTED')) {
      return { ok: false, code: 'DISPATCH_UNEXPECTED', detail: d };
    }
    return { ok: true, value: { shipped: d.status === 'API_ACCEPTED', dispatchStatus: d.status, packet: packet.filename, messageId: d.messageId ?? null } };
  };
}
