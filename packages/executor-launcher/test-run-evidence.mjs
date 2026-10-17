// test-run-evidence.mjs — the CANONICAL before/after snapshots that bind a
// test log to the content it actually ran against (Issue #263 reviewer
// finding 4, definitive round).
//
// Why the exit-time stamp is NOT the test binding:
//   an executor can run the suite on version A, edit B afterwards, and still
//   stamp B at process exit. Comparing that stamp with the live worktree then
//   says "MATCH" while the log it is vouching for was produced against A. The
//   stamp binds the RECORD; it cannot bind the TEST.
//
// So the binding is taken by CONTROL-PLANE code at the moment the command runs,
// never declared by the model:
//   * producer  = executor-launcher's attachPassthrough — the single canonical
//                 path every executor event flows through before it becomes
//                 evidence. It brackets each test command PER TOOL CALL: a
//                 `before` snapshot is captured when that call's START boundary
//                 is observed and an `after` snapshot when its output arrives,
//                 both keyed by the unique runId (= the tool's callID). There
//                 is deliberately NO shared rolling snapshot: a rolling value
//                 would be silently reused across unrelated tool calls and
//                 could describe content from before (or after) the run it is
//                 presented as bracketing.
//                 If the runtime never shows a start boundary for a call, the
//                 record is written with boundary=UNOBSERVED_START and
//                 before=null — the control plane NEVER invents a `before`.
//   * consumer  = review-evidence.readExecutionTestLog, which pairs each raw
//                 output block with its run by runId/toolCallId + outputDigest
//                 + identity + content binding (never by command string), and
//                 then evaluates EVERY required test command on its own.
//
// The tracked-content digest is byte-identical to
// execution-content-binding.computeWorktreeContentBinding, so the `after`
// snapshot and the reviewer's live recomputation are directly comparable.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createContentTracker } from './execution-content-binding.mjs';
import {
  classifyExecutorLivenessFailure,
  classifyExecutorClassificationFailure,
  classifyExecutorTerminalFailure,
  classifyBreakerFailure,
} from './executor-reconcile.mjs';

export const TEST_RUN_SCHEMA_VERSION = '1';

export const TEST_RUN_CODES = Object.freeze({
  UNVERIFIED: 'EVIDENCE_TEST_RUN_UNVERIFIED',
  STALE: 'EVIDENCE_TEST_RUN_STALE',
  CHANGED_DURING_TEST: 'EVIDENCE_TEST_RUN_CHANGED_DURING_TEST',
});

// The ONE definition of "a command whose output counts as test evidence".
// Producer and consumer import this so a command can never be recorded by one
// side and expected by the other.
export const TEST_CMD = /\b(node\s+--test|npm\s+(?:run\s+)?test|git\s+diff\s+--check)\b/;
const EXIT_CODE_RE = /Exit code:\s*(-?\d+)/i;

// A tool state that announces a call BEFORE its output exists is the only
// acceptable start boundary. Anything else (completed/error arriving on their
// own) gives no `before` at all — the record is then UNOBSERVED_START and the
// consumer reports UNVERIFIED rather than accepting a synthesized snapshot.
export const RUN_START_STATUSES = Object.freeze(new Set(['running', 'pending', 'started', 'in_progress', 'queued']));
export const RUN_END_STATUSES = Object.freeze(new Set(['completed', 'error', 'failed']));

// Any command that can change WHICH paths are tracked must invalidate the
// cached `git ls-files` list.
const GIT_INDEX_RE = /\bgit\s+(?:-C\s+\S+\s+)?(?:add|rm|mv|reset|restore|checkout|commit|stash|clean)\b/;

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function isTestCommand(cmd) {
  return typeof cmd === 'string' && TEST_CMD.test(cmd);
}

export function parseExitCode(output) {
  if (typeof output !== 'string') return null;
  const m = EXIT_CODE_RE.exec(output);
  return m ? Number(m[1]) : null;
}

// The output side of the run<->log pairing. Producer and consumer hash the SAME
// extraction rules, so a block can only ever be paired with the run that
// actually produced it — never with "some run of the same command string".
export function testRunOutputDigest(output) {
  return sha256(typeof output === 'string' ? output : '');
}

export function extractToolOutput(state) {
  if (!state || typeof state !== 'object') return null;
  if (typeof state.output === 'string') return state.output;
  if (state.metadata && typeof state.metadata.output === 'string') return state.metadata.output;
  return null;
}

export function testRunsPathFor({ eventsPath = null, stateDir = null, identityHash = null } = {}) {
  if (typeof eventsPath === 'string' && /\.events\.jsonl$/.test(eventsPath)) {
    return eventsPath.replace(/\.events\.jsonl$/, '.testruns.jsonl');
  }
  if (stateDir && identityHash) {
    return path.join(path.resolve(stateDir), 'executions', `${identityHash}.testruns.jsonl`);
  }
  return null;
}

// Append-only: one JSON line per test command. A torn/partial line is skipped
// (never parsed into authority), and an absent file reads as ZERO records —
// which the consumer reports as UNVERIFIED, never as PASS.
export function readTestRunRecords(fp) {
  if (typeof fp !== 'string' || !fp) return [];
  let raw;
  try { raw = fs.readFileSync(fp, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object' && !Array.isArray(o) && o.kind === 'TestRunRecord') out.push(o);
    } catch { /* a torn line never authorizes anything */ }
  }
  return out;
}

function appendRecord(fp, record) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.appendFileSync(fp, `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * The producer. Lives in the control plane (executor-launcher), is driven by
 * the event passthrough, and is the ONLY writer of TestRunRecord.
 *
 * observe(c)  called for every classified executor event. It does two things:
 *   - a START boundary for a test command (tool state status in
 *     RUN_START_STATUSES with a non-empty callID) captures THIS call's
 *     `before` snapshot into a per-call pending slot;
 *   - an END boundary (RUN_END_STATUSES + string output) consumes that slot
 *     and appends the run, pairing `before`/`after` with one unique runId.
 *
 * There is no rolling/shared snapshot anywhere: an `after` for call X can only
 * ever be bracketed by the `before` captured for call X itself. When no start
 * boundary was observed for a call the record carries
 * `boundary: 'UNOBSERVED_START'` and `before: null` — the control plane marks
 * it UNPROVEN instead of inventing a starting content state.
 */
export function createTestRunRecorder({
  worktreePath = null,
  identityHash = null,
  taskId = null,
  repo = null,
  issueNumber = null,
  path: runsPath = null,
  clock = () => Date.now(),
  tracker = null,
} = {}) {
  if (typeof runsPath !== 'string' || !runsPath) throw new Error('path (testRunsPath) is required');
  if (typeof worktreePath !== 'string' || !worktreePath) throw new Error('worktreePath is required');

  const tr = tracker || createContentTracker({ worktreePath });
  // callID -> { startedAt, before } — ONE entry per tool call, never shared.
  const pending = new Map();
  const writtenRunIds = new Set();
  let seq = 0;

  function snapshot(withHead = false) {
    try {
      const s = tr.snapshot({ withHead });
      return s.ok ? s.value : null;
    } catch { return null; } // an unprovable snapshot is refused downstream
  }

  function observe(c) {
    if (!c || typeof c !== 'object') return;
    const part = c.event && c.event.part;
    const st = part && part.state;
    if (!st || typeof st !== 'object') return;
    const cmd = st.input && st.input.command;

    // Keep the cached `git ls-files` list honest whatever happens next: a
    // staged add/rm changes which paths count as tracked content.
    if (typeof cmd === 'string' && GIT_INDEX_RE.test(cmd)) {
      try { tr.markIndexStale(); } catch { /* snapshot stays fail-closed */ }
    }

    const status = typeof st.status === 'string' ? st.status : '';
    const callID = (part && typeof part.callID === 'string' && part.callID.trim()) ? part.callID.trim() : null;

    // ---- START boundary: capture THIS call's `before`, keyed by callID -----
    if (isTestCommand(cmd) && RUN_START_STATUSES.has(status) && callID && !pending.has(callID)) {
      pending.set(callID, {
        callID,
        startedAt: new Date(clock()).toISOString(),
        before: snapshot(true),
      });
      return;
    }

    // ---- END boundary: pair the output with THIS call's own `before` -------
    if (isTestCommand(cmd) && RUN_END_STATUSES.has(status)) {
      const output = extractToolOutput(st);
      if (typeof output !== 'string') return;
      finishRun({ callID, cmd, output, start: callID ? (pending.get(callID) || null) : null });
    }
  }

  function finishRun({ callID, cmd, output, start }) {
    seq += 1;
    // The runId IS the tool call id when the runtime supplies one, so a start
    // and its end can only ever describe the same call. Without a callID there
    // is no correlation key, hence no boundary (recorded as UNOBSERVED_START).
    const runId = callID || `run-${seq}-${sha256(cmd).slice(0, 16)}`;
    if (writtenRunIds.has(runId)) return null; // exactly one record per tool call
    writtenRunIds.add(runId);
    if (callID) pending.delete(callID);

    const after = snapshot(true);
    const before = start ? start.before : null;
    const exitCode = parseExitCode(output);
    const finishedAt = new Date(clock()).toISOString();
    const rec = {
      schemaVersion: TEST_RUN_SCHEMA_VERSION,
      kind: 'TestRunRecord',
      runId,
      toolCallId: callID,
      identityHash,
      taskId,
      repo,
      issueNumber,
      worktreePath,
      command: cmd,
      commandDigest: sha256(cmd),
      outputDigest: testRunOutputDigest(output),
      exitCode,
      result: exitCode === null ? 'UNKNOWN' : (exitCode === 0 ? 'PASS' : 'FAIL'),
      outputBytes: Buffer.byteLength(output, 'utf8'),
      headSha: after && HEX40.test(after.headSha || '') ? after.headSha : null,
      startedAt: start ? start.startedAt : null,
      finishedAt,
      before: before ? { contentDigest: before.contentDigest, fileCount: before.fileCount } : null,
      after: after ? { contentDigest: after.contentDigest, fileCount: after.fileCount } : null,
      boundary: start ? 'OBSERVED_START' : 'UNOBSERVED_START',
      binding: (before && after) ? 'PROVEN' : 'UNPROVEN',
      capturedBy: 'executor-launcher/attachPassthrough',
      capturedAt: finishedAt,
    };
    try { appendRecord(runsPath, rec); } catch { /* evidence stays absent -> UNVERIFIED */ }
    return rec;
  }

  return Object.freeze({ observe, snapshot });
}

// ---------------------------------------------------------------------------
// F4(1) — the ACTIVE control-plane test-runner at VERIFY (Issue #263, round 4).
//
// The recorder above can only bracket what the RUNTIME announces, and the
// measured executor stream never announces a start boundary (0 of 4269 tool
// events): every executor-claimed run stays UNOBSERVED_START, so evidence
// produced by the executor alone can never make the gate go green. The control
// plane therefore runs the test gate ITSELF at the VERIFY step and brackets
// that run with its OWN before/after snapshots.
//
// Operator-answered contract (never re-invented here):
//   * snapshot immediately before spawn and immediately after process exit;
//   * persist the REAL runId / command / commandDigest / outputDigest /
//     exitCode together with the identity + worktree binding;
//   * `toolCallId` is NEVER fabricated — it is null, and `runSource`
//     (`control-plane-active`) distinguishes this leg from an executor call;
//   * `outputDigest` covers the FULL raw log bytes, which are written to a
//     sibling raw-log file; the reader re-reads that file and re-hashes it;
//   * every unprovable outcome is a typed, fail-closed code — never PASS.
// ---------------------------------------------------------------------------
export const ACTIVE_TEST_GATE_CODES = Object.freeze({
  UNBOUND: 'ACTIVE_TEST_GATE_UNBOUND',
  UNRESOLVED: 'ACTIVE_TEST_GATE_UNRESOLVED',
  SPAWN_FAILED: 'ACTIVE_TEST_GATE_SPAWN_FAILED',
  NONZERO_EXIT: 'ACTIVE_TEST_GATE_NONZERO_EXIT',
  NO_OUTPUT: 'ACTIVE_TEST_GATE_NO_OUTPUT',
  UNPROVEN_BINDING: 'ACTIVE_TEST_GATE_UNPROVEN_BINDING',
  CONTENT_DRIFT: 'ACTIVE_TEST_GATE_CONTENT_DRIFT',
  LOG_WRITE_FAILED: 'ACTIVE_TEST_GATE_LOG_WRITE_FAILED',
  THREW: 'ACTIVE_TEST_GATE_THREW',
});

// Execution Truth Failure Modes (S1) — canonical classification that
// separates test-runner outcome, executor liveness, and environment
// into distinct, non-overlapping categories. Every execution outcome
// maps to exactly one failure mode (or PASS/SUCCESS which is not a failure).
export const EXECUTION_TRUTH_FAILURE_MODES = Object.freeze([
  'ASSERTION_FAILED',      // Test assertions failed (non-zero exit from test command)
  'PROCESS_DIED',          // Executor process terminated unexpectedly (crash, OOM, signal)
  'PROCESS_HUNG',          // Executor alive but no progress (circuit breaker NO_MUTATION)
  'PROCESS_CANCELLED',     // Explicit stop request from control plane (STOPPED)
  'ENVIRONMENT_FAILURE',   // Spawn/setup failures, missing deps, permission denied
  'RESOURCE_CONTENTION',   // Content drift, file locks, concurrent modification
  'TRANSPORT_FAILURE',     // MCP transport loss, stdio pipe broken, connection reset
  'UNKNOWN',               // Unclassifiable / insufficient evidence (fail-closed)
]);

/**
 * Classify an active test gate result into an execution truth failure mode.
 * Returns the failure mode string, or null if the gate passed (ok=true).
 */
export function classifyActiveTestGateFailure(result) {
  if (!result || typeof result !== 'object') return 'UNKNOWN';
  if (result.ok === true) return null; // PASS — not a failure

  const code = result.code;
  switch (code) {
    case ACTIVE_TEST_GATE_CODES.NONZERO_EXIT:
      return 'ASSERTION_FAILED';
    case ACTIVE_TEST_GATE_CODES.SPAWN_FAILED:
      // Spawn failure with signal/error detail may indicate process death vs env failure
      const detail = result.detail;
      if (detail && typeof detail === 'object') {
        if (detail.signal) return 'PROCESS_DIED';
        if (detail.spawnError) return 'ENVIRONMENT_FAILURE';
      }
      return 'ENVIRONMENT_FAILURE';
    case ACTIVE_TEST_GATE_CODES.UNBOUND:
    case ACTIVE_TEST_GATE_CODES.UNRESOLVED:
    case ACTIVE_TEST_GATE_CODES.LOG_WRITE_FAILED:
      return 'ENVIRONMENT_FAILURE';
    case ACTIVE_TEST_GATE_CODES.NO_OUTPUT:
      // Could be env failure (nested harness) or process died immediately
      return 'ENVIRONMENT_FAILURE';
    case ACTIVE_TEST_GATE_CODES.UNPROVEN_BINDING:
      return 'ENVIRONMENT_FAILURE';
    case ACTIVE_TEST_GATE_CODES.CONTENT_DRIFT:
      return 'RESOURCE_CONTENTION';
    case ACTIVE_TEST_GATE_CODES.THREW:
      return 'PROCESS_DIED';
    default:
      return 'UNKNOWN';
  }
}

/**
 * Classify a test run record (from executor passthrough) into a failure mode.
 * This covers test commands observed via the executor's tool passthrough.
 */
export function classifyTestRunRecordFailure(record) {
  if (!record || typeof record !== 'object') return 'UNKNOWN';
  // Only classify actual test command records
  if (record.kind !== 'TestRunRecord') return null;

  // Binding/boundary failures take precedence — a PASS with unproven binding
  // is still an environment failure (the test may not have run against the
  // claimed code version).
  if (record.binding === 'UNPROVEN' || record.boundary === 'UNOBSERVED_START') {
    return 'ENVIRONMENT_FAILURE';
  }

  const exitCode = record.exitCode;
  const result = record.result;

  if (exitCode === 0 && result === 'PASS') return null;
  if (exitCode !== null && exitCode !== 0 && result === 'FAIL') return 'ASSERTION_FAILED';
  if (exitCode === null && result === 'UNKNOWN') return 'UNKNOWN';
  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Unified Execution Truth Classification (S1)
// Combines test-runner outcome, executor liveness, and circuit breaker state
// into a single authoritative failure mode. Used by control-plane review and
// telemetry to classify the TRUTH of what happened during execution.
// ---------------------------------------------------------------------------

/**
 * Unified classification combining all evidence sources.
 *
 * Priority order (most specific wins):
 * 1. Active test gate result (control-plane's own test run) — highest authority
 * 2. Executor terminal status (completed run with exit code/signal)
 * 3. Circuit breaker outcome (PROCESS_HUNG from budget exhaustion)
 * 4. Executor classification (liveness + session/binding context)
 * 5. Observed test run records (executor's passthrough test commands)
 *
 * @param {Object} evidence - Combined evidence object
 * @param {Object} evidence.activeTestGate - Result from runActiveTestGate
 * @param {Object} evidence.executorRecord - ExecutionRecord from executor-launcher
 * @param {Object} evidence.breakerResult - Result from evaluateExecutionBudget
 * @param {Object[]} evidence.testRunRecords - Array of TestRunRecord from readTestRunRecords
 * @returns {string|null} Failure mode or null for SUCCESS
 */
export function classifyExecutionTruth({ activeTestGate = null, executorRecord = null, breakerResult = null, testRunRecords = [] } = {}) {
  // 1. Active test gate (control-plane's own test run) — highest authority
  if (activeTestGate && typeof activeTestGate === 'object') {
    const mode = classifyActiveTestGateFailure(activeTestGate);
    if (mode) return mode;
    if (activeTestGate.ok === true) return null; // Explicit PASS
  }

  // 2. Executor terminal status (completed executor run)
  if (executorRecord && typeof executorRecord === 'object') {
    const termMode = classifyExecutorTerminalFailure(executorRecord);
    if (termMode) return termMode;
    // If executor exited 0, check if test runs have failures
    if (executorRecord.terminalStatus === 'EXITED' && executorRecord.exitCode === 0) {
      // Fall through to check test run records
    }
  }

  // 3. Circuit breaker (hung process detection)
  if (breakerResult && typeof breakerResult === 'object' && breakerResult.executionOutcome) {
    const breakerMode = classifyBreakerFailure(breakerResult.executionOutcome);
    if (breakerMode) return breakerMode;
  }

  // 4. Executor classification (liveness + binding context)
  if (executorRecord && typeof executorRecord === 'object') {
    // We need the classification, not just liveness. Import would be circular,
    // so we derive from available fields.
    const classification = deriveExecutorClassification(executorRecord);
    if (classification) {
      const classMode = classifyExecutorClassificationFailure(classification);
      if (classMode) return classMode;
    }
  }

  // 5. Observed test run records (executor's passthrough)
  if (Array.isArray(testRunRecords) && testRunRecords.length > 0) {
    for (const rec of testRunRecords) {
      const mode = classifyTestRunRecordFailure(rec);
      if (mode) return mode;
    }
  }

  // If executor record shows clean exit but no test evidence, it's UNKNOWN
  if (executorRecord && executorRecord.terminalStatus === 'EXITED' && executorRecord.exitCode === 0) {
    return 'UNKNOWN'; // No test evidence to confirm success
  }

  return 'UNKNOWN';
}

/**
 * Derive executor classification from record fields (avoids circular import).
 * Mirrors classifyExecutor logic from executor-reconcile.mjs.
 */
function deriveExecutorClassification(record) {
  if (!record) return 'OWNERSHIP_UNKNOWN';
  if (record.terminalStatus) {
    // Clean exit (EXITED with code 0) is not a failure classification
    if (record.terminalStatus === 'EXITED' && record.exitCode === 0) return null;
    if (record.terminalStatus === 'STOPPED') return 'STOPPED';
    if (record.terminalStatus === 'FAILED') return 'FAILED';
    if (record.terminalStatus === 'INTERRUPTED') return 'INTERRUPTED';
    return 'EXITED';
  }
  if (record.pid == null) return 'STARTING';
  // Note: without isAlive/readStartTime we can't determine RUNNING vs EXITED vs PID_REUSED
  // This is a best-effort derivation; caller should pass classification directly if available
  return 'OWNERSHIP_UNKNOWN';
}

// Only a bare `node --test <files>` script is executable without a shell. The
// token class deliberately excludes every shell metacharacter and whitespace:
// a pipeline, a redirect, a glob or an `&&` chain can never be executed here
// while being reported as `test:gate` — it fails closed as UNSUPPORTED.
const GATE_SCRIPT_RE = /^\s*node\s+--test((?:\s+[A-Za-z0-9_./:@%+=,-]+)*)\s*$/;

/**
 * Resolve `package.json` -> scripts["test:gate"] into the exact argv the
 * control plane will spawn, plus the canonical `command` string whose digest
 * keys the run's test target. Anything not provably equivalent to a bare
 * `node --test <files>` invocation is refused.
 */
export function resolveTestGateCommand({ cwd = null } = {}) {
  const bad = (code, detail) => ({ ok: false, code, detail });
  if (typeof cwd !== 'string' || !cwd) {
    return bad('GATE_CWD_REQUIRED', 'cwd is required to resolve scripts["test:gate"]');
  }
  const pkgPath = path.join(cwd, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    return bad('GATE_PACKAGE_JSON_UNREADABLE', `${pkgPath}: ${String((e && e.message) || e)}`);
  }
  const script = pkg && pkg.scripts ? pkg.scripts['test:gate'] : undefined;
  if (typeof script !== 'string' || !script.trim()) {
    return bad('GATE_SCRIPT_ABSENT', `${pkgPath} has no scripts["test:gate"]`);
  }
  const m = GATE_SCRIPT_RE.exec(script);
  if (!m) {
    return bad('GATE_SCRIPT_UNSUPPORTED',
      `scripts["test:gate"] must be a bare "node --test <files>" invocation, got: ${script}`);
  }
  const tokens = m[1].trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return bad('GATE_SCRIPT_EMPTY', 'scripts["test:gate"] lists no test files');
  return {
    ok: true,
    command: `node --test ${tokens.join(' ')}`,
    executable: process.execPath,
    argv: ['--test', ...tokens],
    script,
    tokens,
  };
}

// The raw log lives NEXT TO the run store so an identity's evidence stays in
// one place and can never be confused with another identity's logs.
const RUNS_SUFFIX = '.testruns.jsonl';
export function activeTestRunLogDir({ runsPath = null, stateDir = null, identityHash = null } = {}) {
  if (typeof runsPath === 'string' && runsPath.endsWith(RUNS_SUFFIX)) {
    return `${runsPath.slice(0, -RUNS_SUFFIX.length)}.testrun-logs`;
  }
  if (stateDir && identityHash) {
    return path.join(path.resolve(stateDir), 'executions', `${identityHash}.testrun-logs`);
  }
  return null;
}

/**
 * The active runner. Returns `runActiveTestGate({ session, record, stateDir,
 * runsPath, gate })`, which spawns the gate EXACTLY ONCE and appends one
 * TestRunRecord (`runSource: 'control-plane-active'`) to the canonical store.
 *
 * Returns { ok:true, record, rawLogPath, exitCode } on a fully proven pass, or
 * { ok:false, code: ACTIVE_TEST_GATE_*, detail, record? } otherwise. A record
 * is still written whenever the process actually ran, so a failed gate leaves
 * truthful evidence behind instead of a silent absence.
 */
export function createActiveTestRunner({
  spawnImpl = null,
  clock = () => Date.now(),
  tracker = null,
  timeoutMs = 600000,
  maxOutputBytes = 8 * 1024 * 1024,
} = {}) {
  const spawn = typeof spawnImpl === 'function'
    ? spawnImpl
    : (file, args, opts) => spawnSync(file, args, opts);
  let seq = 0;

  function runActiveTestGate({ session = null, record = null, stateDir = null, runsPath = null, gate = null } = {}) {
    const worktreePath = (record && record.worktreePath) || (session && session.worktreePath) || null;
    const identityHash = (record && record.identityHash) || (session && session.identityHash) || null;
    if (!worktreePath || !identityHash) {
      return { ok: false, code: ACTIVE_TEST_GATE_CODES.UNBOUND,
        detail: 'the active gate needs an identity + bound worktree (record/session)' };
    }

    const resolved = gate || resolveTestGateCommand({ cwd: worktreePath });
    if (!resolved || resolved.ok !== true) {
      return { ok: false, code: ACTIVE_TEST_GATE_CODES.UNRESOLVED,
        detail: (resolved && (resolved.detail || resolved.code)) || 'scripts["test:gate"] unresolvable' };
    }

    const store = runsPath
      || (record && record.testRunsPath)
      || testRunsPathFor({ eventsPath: record && record.eventsPath, stateDir, identityHash });
    if (!store) {
      return { ok: false, code: ACTIVE_TEST_GATE_CODES.UNBOUND,
        detail: 'the canonical TestRunRecord store path is unresolvable' };
    }
    const logDir = activeTestRunLogDir({ runsPath: store });
    if (!logDir) {
      return { ok: false, code: ACTIVE_TEST_GATE_CODES.UNBOUND,
        detail: `no raw-log directory can be derived from ${store}` };
    }

    const tr = tracker || createContentTracker({ worktreePath });
    const snap = () => {
      try { const s = tr.snapshot({ withHead: true }); return s.ok ? s.value : null; } catch { return null; }
    };

    // (1) content snapshot immediately BEFORE the spawn ...
    const before = snap();
    seq += 1;
    const startedAtMs = clock();
    const runId = `active-${new Date(startedAtMs).toISOString().replace(/[:.]/g, '-')}-${seq}`;

    // The gate must run as its OWN test process. Inheriting NODE_TEST_CONTEXT
    // makes `node --test` detect a nested harness, SKIP every file and still
    // exit 0 — a silent false PASS with empty output, measured during this
    // round's integration regression. Never inherit it.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;

    let res = null;
    try {
      res = spawn(resolved.executable, resolved.argv, {
        cwd: worktreePath,
        encoding: 'utf8',
        shell: false,
        timeout: timeoutMs,
        maxBuffer: maxOutputBytes,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
    } catch (e) {
      return { ok: false, code: ACTIVE_TEST_GATE_CODES.SPAWN_FAILED,
        detail: String((e && e.message) || e) };
    }

    // (2) ... and immediately AFTER the process exits.
    const after = snap();
    const finishedAtMs = clock();
    const finishedAt = new Date(finishedAtMs).toISOString();

    const stdout = String(res && res.stdout != null ? res.stdout : '');
    const stderr = String(res && res.stderr != null ? res.stderr : '');
    const status = res && Number.isInteger(res.status) ? res.status : null;
    const signal = res && res.signal ? String(res.signal) : null;
    const spawnError = res && res.error
      ? String(res.error.code || res.error.message || res.error)
      : null;
    // The full raw log: both streams plus the SAME exit stamp the consumer
    // parses. It is written verbatim, never truncated, and the digest below is
    // taken over THESE bytes (never over an excerpt).
    const stamp = `Exit code: ${status === null ? 'none' : status}`
      + `${signal ? ` (signal: ${signal})` : ''}${spawnError ? ` (spawnError: ${spawnError})` : ''}\n`;
    const raw = `${stdout}${stderr}${stamp}`;

    // A gate that exits 0 while producing NO output at all ran nothing — the
    // exact signature of the skipped-file case noted above. There is nothing
    // to digest, so no log and no run are invented and the gate fails closed.
    if (status === 0 && !stdout.trim() && !stderr.trim()) {
      return {
        ok: false,
        code: ACTIVE_TEST_GATE_CODES.NO_OUTPUT,
        detail: {
          reason: 'the gate exited 0 without producing any output — nothing was executed',
          command: resolved.command,
          cwd: worktreePath,
        },
      };
    }

    const rawLogPath = path.join(logDir, `${runId}.log`);
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(rawLogPath, raw, 'utf8');
    } catch (e) {
      return { ok: false, code: ACTIVE_TEST_GATE_CODES.LOG_WRITE_FAILED,
        detail: `${rawLogPath}: ${String((e && e.message) || e)}` };
    }

    const outputDigest = sha256(raw);
    const rec = {
      schemaVersion: TEST_RUN_SCHEMA_VERSION,
      kind: 'TestRunRecord',
      runId,
      // NEVER fabricated: the control plane is not an executor tool call.
      toolCallId: null,
      runSource: 'control-plane-active',
      identityHash,
      taskId: (record && record.taskId) || (session && session.taskId) || null,
      repo: (record && record.repo) || (session && session.repo) || null,
      issueNumber: (record && record.issueNumber) ?? (session && session.issueNumber) ?? null,
      worktreePath,
      command: resolved.command,
      commandDigest: sha256(resolved.command),
      outputDigest,
      rawLogPath,
      rawLogBytes: Buffer.byteLength(raw, 'utf8'),
      exitCode: status,
      result: status === 0 ? 'PASS' : (Number.isInteger(status) ? 'FAIL' : 'UNKNOWN'),
      outputBytes: Buffer.byteLength(raw, 'utf8'),
      headSha: after && HEX40.test(after.headSha || '') ? after.headSha : null,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt,
      before: before ? { contentDigest: before.contentDigest, fileCount: before.fileCount } : null,
      after: after ? { contentDigest: after.contentDigest, fileCount: after.fileCount } : null,
      boundary: 'OBSERVED_START',
      binding: (before && after) ? 'PROVEN' : 'UNPROVEN',
      capturedBy: 'control-loop/activeTestRunner',
      capturedAt: finishedAt,
      spawn: {
        executable: resolved.executable,
        argv: resolved.argv.slice(),
        cwd: worktreePath,
        timeoutMs,
        signal,
        spawnError,
      },
    };
    try { appendRecord(store, rec); } catch { /* absence -> UNVERIFIED downstream */ }

    const evidence = { record: rec, rawLogPath, runId, command: resolved.command, exitCode: status };
    if (spawnError || !Number.isInteger(status)) {
      return { ok: false, code: ACTIVE_TEST_GATE_CODES.SPAWN_FAILED,
        detail: { ...evidence, signal, spawnError } };
    }
    if (status !== 0) {
      return { ok: false, code: ACTIVE_TEST_GATE_CODES.NONZERO_EXIT, detail: evidence };
    }
    if (!before || !after) {
      return { ok: false, code: ACTIVE_TEST_GATE_CODES.UNPROVEN_BINDING, detail: evidence };
    }
    if (before.contentDigest !== after.contentDigest) {
      return { ok: false, code: ACTIVE_TEST_GATE_CODES.CONTENT_DRIFT,
        detail: { ...evidence, before: before.contentDigest, after: after.contentDigest } };
    }
    return { ok: true, ...evidence };
  }

  return Object.freeze({ runGate: runActiveTestGate, timeoutMs, maxOutputBytes });
}
