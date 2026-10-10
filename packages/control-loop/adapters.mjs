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
import { identityHash as workspaceIdentityHash } from '../workspace/workspace.mjs';
import { runDeliveryLifecycle } from './delivery.mjs';
import { EventDelivery, DELIVERY_STATE } from '../executor-launcher/event-delivery.mjs';

const HEAD_RE = /^[0-9a-f]{40}$/;

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

// ---- ControlLoop Router Adapter (Issue #244) ---------------------------------
// Wraps the central router (packages/control-loop/router.mjs) to provide the
// executor route resolution for the EXECUTE phase. The router owns the FSM
// transition atomicity, engine routing, and LH-01 reconcile; this adapter only
// exposes the resolveRoute surface expected by control-loop.mjs.
export function createControlLoopRouterAdapter() {
  // Late import to avoid circular deps (router imports control-loop, which
  // imports adapters). The router is only needed when this adapter is used.
  let routerModule = null;
  return async function route({ sessionPath }) {
    if (!routerModule) {
      routerModule = await import('./router.mjs');
    }
    const { createControlLoopRouter } = routerModule;
    const rs = readSessionRecord(sessionPath);
    if (!rs.ok) return { ok: false, code: rs.reason };
    const session = rs.session;
    if (session.state !== 'SESSION_ACTIVE') {
      return { ok: false, code: 'SESSION_NOT_ACTIVE', detail: session.state };
    }
    // Derive identityHash and stateDir from the canonical session.
    const { identityHash } = await import('../workspace/workspace.mjs');
    const id = identityHash({ repo: session.repo, issueNumber: session.issueNumber });
    const stateDir = path.dirname(path.dirname(sessionPath)); // stateDir/sessions/id.json -> stateDir
    const router = createControlLoopRouter({ sessionPath, identityHash: id, stateDir });
    if (!router || router.ok === false) {
      return { ok: false, code: 'ROUTER_CONSTRUCTION_FAILED', detail: router?.detail ?? router };
    }
    const resolved = router.resolveRoute({ phase: 'EXECUTE', sessionPath });
    if (!resolved.ok) return resolved;
    return { ok: true, value: { model: resolved.value.model, executorKind: resolved.value.executorKind } };
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
// Issue #96: the deadline is progress-based, not a blind wall clock. Liveness
// is the native activity event time field `t` (event timestamps): a RUNNING
// executor whose latest activity event time keeps advancing extends the fail
// time by stallWindowMs; totalLines growth is only the fallback for events
// without `t` (an unchanged/replaced line count cannot distinguish new
// activity, and a saturated tail stops growing). An executor that never
// produced activity still fails at the base pollDeadlineMs window. The
// absolute pollDeadlineMaxMs wall-clock cap is an UNCONDITIONAL first-order
// bound checked with precedence over the stall/base-deadline failures: when
// both expire on the same poll, the absolute-cap failure is returned. All
// paths fail closed with EXECUTOR_TIMEOUT — the loop can never wait forever.
// Deps are injectable for deterministic tests; defaults are the real primitives.
export function launchExecutorAdapter({
  startExecution: start = startExecution,
  readStatus = readExecutionStatus,
  instruction = null,
  controlCwd = process.cwd(),
  pollDeadlineMs = 30 * 60 * 1000,
  pollDeadlineMaxMs = 4 * 60 * 60 * 1000,
  stallWindowMs = 10 * 60 * 1000,
  pollIntervalMs = 2000,
  clock = Date.now,
  delay = (ms) => new Promise((r) => setTimeout(r, ms)),
  createDelivery = (opts) => new EventDelivery(opts), // P3 DI seam: EventDelivery factory (tests inject recorders/fakes)
} = {}) {
  return async function executor({
    sessionPath, model = null,
    reworkInstruction: ctxReworkInstruction = null,
    reworkCwd: ctxReworkCwd = null,
    reworkModel: ctxReworkModel = null,
  }) {
    const rs = readSessionRecord(sessionPath);
    if (!rs.ok) return { ok: false, code: rs.reason };
    const session = rs.session;
    if (typeof start !== 'function') return { ok: false, code: 'NO_EXECUTOR_TRANSPORT' };
    // P0-E (Issue #79): the ControlLoop passes the rework instruction built
    // from the validated GPT findings for re-dispatch rounds; it overrides
    // the adapter-level default so every re-dispatch carries the rework
    // context. Authority derivation (session/binding/stateDir re-read) and
    // the launch+poll flow are unchanged.
    const effInstruction = (typeof ctxReworkInstruction === 'string' && ctxReworkInstruction.trim())
      ? ctxReworkInstruction
      : instruction;
    if (typeof effInstruction !== 'string' || !effInstruction.trim()) {
      return { ok: false, code: 'INSTRUCTION_REQUIRED' };
    }
    // P0-E re-dispatch overrides (optional): a rework round may run from a
    // different control cwd / model without inventing a second executor
    // authority — startExecution still derives ALL authority from the
    // canonical session record and its taskStart binding.
    const effControlCwd = (typeof ctxReworkCwd === 'string' && ctxReworkCwd.trim()) ? ctxReworkCwd : controlCwd;
    const effModel = (ctxReworkModel === null || ctxReworkModel === undefined || ctxReworkModel === '') ? model : ctxReworkModel;
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
      instruction: effInstruction,
      model: effModel,
      stateDir: sd,
      controlCwd: effControlCwd,
    });
    if (!launch || launch.ok !== true) {
      // Preserve pre-spawn error codes so execution-recovery can classify them
      // as PRE_SPAWN_EFFECT_PROVEN and apply the single durable retry budget.
      // MODEL_UNRESOLVED, MODEL_INVALID, MODEL_UNAVAILABLE, EXECUTOR_UNAVAILABLE,
      // INSTRUCTION_INVALID, etc. must NOT be swallowed into LAUNCH_FAILED.
      return launch;
    }
    const recPath = launch.recordPath ?? null;
    // startExecution already returned success; a missing handle cannot prove
    // that no child was spawned. Keep the outcome unknown and never respawn.
    if (!recPath) return { ok: false, code: 'LAUNCH_INTERNAL_ERROR', detail: 'handle missing recordPath' };
    const t0 = clock();
    const baseDeadline = t0 + pollDeadlineMs; // window when no activity evidence exists
    const absCap = t0 + pollDeadlineMaxMs; // absolute wall-clock bound, never extended
    let lastProgressAt = null; // null = no executor activity observed yet
    let lastActivityCount = null;
    let lastActivityEventT = null; // native activity event time (field `t`) of the latest progress
    const TERMINAL_EXEC = new Set(['EXITED', 'FAILED', 'STOPPED', 'INTERRUPTED']);
    const ACTIVE_EXEC = new Set(['RUNNING', 'STARTING']);
    // P3 wiring (Omnigent selective integration): this poll loop is the
    // PRODUCTION consumer of the executor's events.jsonl, so sequenced activity
    // events flow through the ACK-retained EventDelivery core: submit() is the
    // durable producer side (bounded queue); `consume` is the receiver — it
    // applies the batch to the liveness/progress state (the only real consumer
    // here) and acknowledges the exact in-order application. At most ONE chunk
    // per poll is submitted and the producer cursor advances SYNCHRONOUSLY on
    // handoff (a batch the module does not refuse is retained + replayed until
    // ACK-covered) with a rollback if the module refuses it, so ordering holds,
    // a refused batch is resubmitted next poll (idempotent re-apply — the
    // consumer is a monotone max), and no seq range can ever be skipped by a
    // later chunk's advance. Drain is deliberately bounded by the poll rate
    // (backpressure); liveness is NEVER gated on the drain — the event-time
    // block below stays the liveness authority (Issue #96 semantics unchanged).
    let lastSubmittedSeq = 0; // producer cursor: the highest seq handed off to the module and NOT refused
    const delivery = createDelivery({ clock });
    const consume = async (batch) => {
      for (const it of batch.events) {
        if (it && typeof it.t === 'number' && it.t > 0 && (lastActivityEventT === null || it.t > lastActivityEventT)) {
          lastActivityEventT = it.t;
          lastProgressAt = it.t; // progress time is the EVENT time, not the poll time
        }
      }
      const ack = delivery.acknowledge({ id: batch.id, applied: batch.events.length, generation: batch.generation });
      if (!ack.ok) throw new Error(`activity-batch ACK rejected: ${ack.reason}`);
    };
    for (;;) {
      // ponytail: includeActivity re-reads the whole events file each poll;
      // fine for current log sizes, switch to a stat(mtime/size) probe if
      // executor event logs grow past ~100MB. Liveness additionally relies on
      // the stored event field `t` (Issue #96 rework) — readActivityTail
      // already carries it per item; no schema change needed.
      const st = readStatus({ stateDir: sd, repo: session.repo, issueNumber: session.issueNumber, includeActivity: true });
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
      // Issue #96 (rework): the absolute pollDeadlineMaxMs wall-clock cap is an
      // UNCONDITIONAL first-order bound — checked with precedence over the
      // stall/base-deadline failures, so a poll where both bounds expired
      // reports the absolute-cap failure, never a stall/base reason.
      if (clock() > absCap) {
        return {
          ok: false,
          code: 'EXECUTOR_TIMEOUT',
          detail: { status: st.ok ? st.execution.status : null, reason: 'POLL_DEADLINE_MAX_EXCEEDED' },
        };
      }
      // Issue #96: classify the non-terminal executor state instead of timing
      // out blindly. PROGRESSING (RUNNING/STARTING whose latest activity event
      // time `t` advanced) extends the fail time to eventT + stallWindowMs;
      // totalLines growth is only the fallback while no event timestamp has
      // been observed. STALLED/NO_PROGRESS (RUNNING with no newer event time)
      // fails at lastProgressAt + stallWindowMs, or at baseDeadline when no
      // activity was ever observed. Legacy non-ok/lifecycle-status timeouts
      // unchanged.
      if (st.ok && ACTIVE_EXEC.has(st.execution.status)) {
        const activityItems = (st.activity && st.activity.ok && Array.isArray(st.activity.items)) ? st.activity.items : null;
        let eventT = null;
        if (activityItems) {
          for (const it of activityItems) {
            if (it && typeof it.t === 'number' && it.t > 0 && (eventT === null || it.t > eventT)) eventT = it.t;
          }
        }
        if (activityItems) {
          // (Re)connect after an unreadable-stream poll: retained durable
          // batches replay from the retained queue + source cursor.
          if (delivery.state !== DELIVERY_STATE.READY) { delivery.connect(consume); delivery.ready(); }
          // Submit the OLDEST fresh sequenced events (append order == seq
          // order), at most one bounded chunk per poll. The cursor logic is:
          // advance synchronously on handoff, roll back if the module refuses
          // the batch — the observable invariant is that only batches the
          // module took responsibility for (retained + replayed until
          // ACK-covered) persist an advance, so a refused batch is always
          // resubmitted whole on the next poll and no seq range is skipped.
          const fresh = activityItems.filter((it) => it && typeof it.seq === 'number' && it.seq > 0 && it.seq > lastSubmittedSeq);
          const chunk = fresh.slice(0, delivery.maxEvents);
          if (chunk.length > 0) {
            const maxSeq = chunk.reduce((m, it) => (it.seq > m ? it.seq : m), lastSubmittedSeq);
            // Advance SYNCHRONOUSLY on handoff: a submit the module does not
            // refuse is owned by the module from here (retained + replayed
            // across reconnects until ACK-covered), so the next poll must not
            // resubmit the same range. If the module REFUSES the batch, roll
            // the cursor back so the identical chunk is resubmitted next poll
            // (refusals are constructed synchronously — the rollback always
            // lands before the next poll's filter).
            const prevCursor = lastSubmittedSeq;
            if (maxSeq > lastSubmittedSeq) lastSubmittedSeq = maxSeq;
            delivery.submit({ sourceId: recPath, events: chunk }).then(null, () => {
              if (lastSubmittedSeq === maxSeq) lastSubmittedSeq = prevCursor;
            });
          }
        } else if (delivery.state === DELIVERY_STATE.READY) {
          // Activity stream unreadable: the channel is DOWN. Disconnect; the
          // durable queue + source cursor are retained for replay on the next
          // readable poll.
          delivery.disconnected();
        }
        if (eventT !== null) {
          if (lastActivityEventT === null || eventT > lastActivityEventT) {
            lastActivityEventT = eventT;
            lastProgressAt = eventT; // progress time is the EVENT time, not the poll time
          }
        } else if (lastActivityEventT === null && st.activity && st.activity.ok
          && (lastActivityCount === null || st.activity.totalLines > lastActivityCount)) {
          lastProgressAt = clock(); // legacy fallback: no event timestamps observed yet
          lastActivityCount = st.activity.totalLines;
        }
        const failAt = lastProgressAt !== null ? lastProgressAt + stallWindowMs : baseDeadline;
        if (clock() > failAt) {
          return {
            ok: false,
            code: 'EXECUTOR_TIMEOUT',
            detail: {
              status: st.execution.status,
              reason: lastProgressAt !== null ? 'NO_EXECUTOR_ACTIVITY_WITHIN_STALL_WINDOW' : 'NO_EXECUTOR_ACTIVITY_SINCE_LAUNCH',
              activityTotalLines: st.activity && st.activity.ok ? st.activity.totalLines : null,
              lastActivityEventT,
            },
          };
        }
      } else if (clock() > baseDeadline) {
        return { ok: false, code: 'EXECUTOR_TIMEOUT', detail: st.ok ? st.execution.status : (st.reason ?? null) };
      }
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
//
// Issue #263 F4(1) — optional ACTIVE test gate at VERIFY. When the caller
// injects `activeTestRunner` (production does, via
// executor-launcher/test-run-evidence.createActiveTestRunner), the verifier
// runs the repository's own `test:gate` HERE, in the bound task worktree, and
// requires that run to be fully proven (before/after snapshots + raw log +
// digest + exit code 0) before it may return PASS. The runner is absent by
// default, so every existing fixture and every failing execution keeps its
// exact previous behavior; a gate that fails returns a typed ACTIVE_TEST_GATE_*
// failure instead of PASS — the record can never become PASS on a non-zero
// exit.
export function deterministicVerifierAdapter({ activeTestRunner = null } = {}) {
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
      // ---- Issue #263 F4(1): the ACTIVE control-plane test gate -----------
      // Only reached once the execution record itself is provably clean, so a
      // failed execution never pays for a test run. The gate runs in the BOUND
      // task worktree and must come back fully proven; anything else is a
      // typed, fail-closed failure that stops VERIFY from reaching PRE_REVIEW.
      //
      // TYPE SHAPE (Issue #263 review round): production wires the OBJECT
      // returned by executor-launcher/test-run-evidence.createActiveTestRunner()
      // ({ runGate, timeoutMs, maxOutputBytes }), while a caller may also hand
      // over a bare async function. Normalizing BOTH shapes here is what makes
      // the gate actually execute — checking `typeof === 'function'` alone let
      // the production object fall through as "no gate", silently swallowing a
      // FAIL. An injected runner that exposes neither shape FAILS CLOSED instead
      // of degrading into an absent gate.
      const runGate = typeof activeTestRunner === 'function'
        ? activeTestRunner
        : (activeTestRunner && typeof activeTestRunner.runGate === 'function'
          ? activeTestRunner.runGate.bind(activeTestRunner)
          : null);
      if (activeTestRunner != null && !runGate) {
        return {
          ok: false,
          code: 'ACTIVE_TEST_GATE_INVALID',
          detail: 'activeTestRunner was injected but exposes neither a callable nor a runGate() method',
        };
      }
      if (runGate) {
        let g;
        try {
          g = await runGate({ session, record, stateDir: cp.stateDir });
        } catch (e) {
          return { ok: false, code: 'ACTIVE_TEST_GATE_THREW', detail: String((e && e.message) || e) };
        }
        if (!g || g.ok !== true) {
          return {
            ok: false,
            code: (g && g.code) || 'ACTIVE_TEST_GATE_FAILED',
            detail: (g && g.detail) ?? null,
          };
        }
      }
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

// ---- web2api-copy final review adapter (F2) --------------------------------
// Wraps the chatgpt-plus-web2api-copy clipboard transport for the final review
// step. transportFactory is a function that creates a fresh transport per
// transaction — it receives the five canonical binding values and returns a
// transport({ prompt }). The adapter passes the factory directly to
// createGptFinalReview; no duplicate evidence collection or digest computation.
export function web2ApiCopyFinalReviewAdapter({
  transportFactory = null,
  reviewReadyDir = null,
  timeoutMs,
} = {}) {
  return createGptFinalReview({
    transportFactory,
    reviewReadyDir,
    timeoutMs,
  });
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
    .reverse(); // newest first (fallback; exact-head match preferred below)
  if (!matches.length) return { ok: false, code: 'NO_REVIEW_PACKET' };
  // Issue #83: the packet MUST match the session's current head. Pure lexical
  // "newest first" breaks on short-sha ordering (a rework round's new 7-hex
  // may sort BELOW round 1's), silently handing reviewers a STALE packet. An
  // exact current-head match wins; newest-first is only the fallback.
  const currentHead = typeof session.headSha === 'string' ? session.headSha.toLowerCase() : null;
  const exact = currentHead
    ? matches.filter((p) => path.basename(p).toLowerCase().includes(`_${currentHead.slice(0, 7)}_`))
    : [];
  const chosen = exact.length ? exact[0] : matches[0];
  return { ok: true, packetPath: chosen, filename: path.basename(chosen) };
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

// ---- P0-F canonical delivery lifecycle adapter (Issue #81) -----------------
// Wire the validated-PASS branch of the ControlLoop to the Soc_brain-owned
// delivery lifecycle. Identity is re-derived from the canonical session
// record (never trusted from mutable call context), the approved headSha is
// the loop-pinned session head, and the review packet informs the PR title.
// Every side effect, ordering and read-back rule lives in delivery.mjs.
export function buildDeliveryAdapter({ gh = null, env = null, cleanup = undefined, pushExec } = {}) {
  return async function delivery({ sessionPath, decision: d }) {
    const rs = readSessionRecord(sessionPath);
    if (!rs.ok) return { ok: false, code: rs.reason || 'SESSION_READ_FAILED' };
    const session = rs.session;
    const id = workspaceIdentityHash({ repo: session.repo, issueNumber: session.issueNumber });
    const headSha = d && d.binding && typeof d.binding.headSha === 'string' && HEAD_RE.test(d.binding.headSha)
      ? d.binding.headSha.toLowerCase() // approved head carried by the validated decision binding
      : (typeof session.headSha === 'string' ? session.headSha : null);
    if (!headSha) return { ok: false, code: 'DELIVERY_BIND_STALE', detail: 'no approved headSha (decision.binding.headSha / session.headSha)' };
    const rrDir = session.controlPlane && session.controlPlane.stateDir
      ? path.join(session.controlPlane.stateDir, 'review-ready')
      : DEFAULT_REVIEW_READY_DIR;
    const rr = packetPathFor({ reviewReadyDir: rrDir, sessionPath });
    const prTitle = rr.ok && rr.filename
      ? `feat: canonical task delivery (${rr.filename.replace(/\.md$/, '')})`
      : `feat: canonical task delivery (#${session.issueNumber})`;
    const r = await runDeliveryLifecycle({
      sessionPath,
      identityHash: id,
      stateDir: (session.controlPlane && session.controlPlane.stateDir)
        || path.dirname(path.dirname(sessionPath)),
      issue: session.issueNumber,
      headSha,
      branch: typeof session.branch === 'string' ? session.branch : undefined,
      title: prTitle,
      deps: { gh, env, cleanup, pushExec },
    });
    if (!r.ok) return { ok: false, code: r.code, detail: r.detail };
    return { ok: true, value: r.value };
  };
}
