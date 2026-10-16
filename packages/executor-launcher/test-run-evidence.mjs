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
  testPlanGateCommand, parseTapSummary, evaluateSummary, validateTestPlan, TEST_PLAN_CODES,
  computePlanContentBinding,
} from './test-plan.mjs';

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
  RECORD_WRITE_FAILED: 'ACTIVE_TEST_GATE_RECORD_WRITE_FAILED',
  THREW: 'ACTIVE_TEST_GATE_THREW',
  // Plan-mode codes (affected-test gate): every unprovable planning/execution
  // outcome is typed — none of them can degrade into a silent PASS.
  PLAN_FAILED: 'ACTIVE_TEST_GATE_PLAN_FAILED',
  PLAN_STALE: 'ACTIVE_TEST_GATE_PLAN_STALE',
  PLAN_INVALID: 'ACTIVE_TEST_GATE_PLAN_INVALID',
  BASE_MISMATCH: 'ACTIVE_TEST_GATE_BASE_MISMATCH',
  NO_TESTS: 'ACTIVE_TEST_GATE_NO_TESTS',
  TAP_SUMMARY_INVALID: 'ACTIVE_TEST_GATE_TAP_SUMMARY_INVALID',
  OUTPUT_TRUNCATED: 'ACTIVE_TEST_GATE_OUTPUT_TRUNCATED',
});

// Map a TEST_PLAN_* validator code to the ONE active-gate code the consumer
// understands. Content drift and head/manifest drift are both STALE; a BASE
// that does not match the task binding is its own typed refusal; everything
// else (shape/tamper/escape) is INVALID. No validator code may fall through
// untyped — the caller must never guess.
function planGateCodeFor(code) {
  if (code === TEST_PLAN_CODES.PLAN_STALE
    || code === TEST_PLAN_CODES.MANIFEST_INVALID) return ACTIVE_TEST_GATE_CODES.PLAN_STALE;
  if (code === TEST_PLAN_CODES.BASE_MISMATCH) return ACTIVE_TEST_GATE_CODES.BASE_MISMATCH;
  return ACTIVE_TEST_GATE_CODES.PLAN_INVALID;
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
/**
 * The active runner. Returns `runActiveTestGate({ session, record, stateDir,
 * runsPath, gate, plan, mode })`, which spawns the gate EXACTLY ONCE and
 * appends one TestRunRecord (`runSource: 'control-plane-active'`) to the
 * canonical store.
 *
 * Command resolution has exactly two modes:
 *   * PLAN mode (default in production, via `planBuilder`): the control plane
 *     builds/validates the deterministic affected-test plan from the task's
 *     BASE binding, derives argv ONLY from the validated plan files (the
 *     caller can never hand over raw argv), refuses stale/tampered/escaping
 *     plans, requires a valid TAP summary (exit 0 alone is never proof), and
 *     embeds plan + TAP + runtime facts into the record for consumer
 *     read-back. `plan.status === 'NO_TESTS'` never spawns and is recorded as
 *     an explicit no-tests state, never as PASS.
 *   * LEGACY mode (`gate` passed explicitly, or no `planBuilder`): the exact
 *     pre-plan behavior, preserved for compatibility callers.
 *
 * Returns { ok:true, record, rawLogPath, exitCode } on a fully proven pass, or
 * { ok:false, code: ACTIVE_TEST_GATE_*, detail, record? } otherwise. A record
 * is still written whenever the process actually ran, so a failed gate leaves
 * truthful evidence behind instead of a silent absence; a persistence failure
 * is itself a typed failure (RECORD_WRITE_FAILED), never swallowed.
 */
export function createActiveTestRunner({
  spawnImpl = null,
  clock = () => Date.now(),
  tracker = null,
  timeoutMs = 600000,
  maxOutputBytes = 8 * 1024 * 1024,
  planBuilder = null,
  planMode = 'auto',
} = {}) {
  const spawn = typeof spawnImpl === 'function'
    ? spawnImpl
    : (file, args, opts) => spawnSync(file, args, opts);
  let seq = 0;

  function runActiveTestGate({ session = null, record = null, stateDir = null, runsPath = null, gate = null, plan: planInput = null, mode = null } = {}) {
    const worktreePath = (record && record.worktreePath) || (session && session.worktreePath) || null;
    const identityHash = (record && record.identityHash) || (session && session.identityHash) || null;
    if (!worktreePath || !identityHash) {
      return { ok: false, code: ACTIVE_TEST_GATE_CODES.UNBOUND,
        detail: 'the active gate needs an identity + bound worktree (record/session)' };
    }

    // ---- command resolution: PLAN mode (production) vs LEGACY -------------
    let resolved = null;
    let plan = null;
    let planBase = null;   // the TASK's canonical BASE (plan mode only)
    let planContent = null; // the content binding observed immediately pre-spawn
    if (gate != null || typeof planBuilder !== 'function') {
      resolved = gate || resolveTestGateCommand({ cwd: worktreePath });
      if (!resolved || resolved.ok !== true) {
        return { ok: false, code: ACTIVE_TEST_GATE_CODES.UNRESOLVED,
          detail: (resolved && (resolved.detail || resolved.code)) || 'scripts["test:gate"] unresolvable' };
      }
    } else {
      // The BASE ALWAYS comes from the task binding — never from a caller
      // string that could be pointed at an unrelated repository.
      const base = (record && record.baseSha) || (session && session.baseSha) || null;
      if (!HEX40.test(String(base || ''))) {
        return { ok: false, code: ACTIVE_TEST_GATE_CODES.UNBOUND,
          detail: `plan mode needs the task BASE binding (40-hex baseSha on record/session), got: ${base}` };
      }
      planBase = base;
      let built = planInput;
      if (!built || typeof built !== 'object' || built.ok !== true) {
        try {
          built = planBuilder({ root: worktreePath, base, mode: mode || planMode });
        } catch (e) {
          return { ok: false, code: ACTIVE_TEST_GATE_CODES.PLAN_FAILED,
            detail: { reason: String((e && e.message) || e), base } };
        }
      }
      if (!built || built.ok !== true) {
        return { ok: false, code: ACTIVE_TEST_GATE_CODES.PLAN_FAILED,
          detail: { reason: (built && (built.detail || built.reason)) || 'test plan is unprovable', base } };
      }
      plan = built.plan;
    }

    const store = runsPath
      || (record && record.testRunsPath)
      || testRunsPathFor({ eventsPath: record && record.eventsPath, stateDir, identityHash });
    if (!store) {
      return { ok: false, code: ACTIVE_TEST_GATE_CODES.UNBOUND,
        detail: 'the canonical TestRunRecord store path is unresolvable' };
    }

    const tr = tracker || createContentTracker({ worktreePath });
    const snap = () => {
      try { const s = tr.snapshot({ withHead: true }); return s.ok ? s.value : null; } catch { return null; }
    };

    if (plan) {
      // (F1) Fresh content observation immediately before any spawn decision.
      // The plan's claim about the bytes on disk is only good while those
      // bytes are STILL there: dirty tracked edits or new untracked sources
      // between planning and execution make the selection unknowable.
      const liveBind = computePlanContentBinding({ root: worktreePath });
      if (!liveBind.ok) {
        return { ok: false, code: ACTIVE_TEST_GATE_CODES.PLAN_FAILED,
          detail: { reason: `content binding unavailable: ${liveBind.reason}`, planDigest: plan.planDigest } };
      }
      // (F4) expectedBaseSha = the TASK binding captured above: a self-
      // consistent plan built from a different base is refused here, before
      // it can become argv — even when the plan itself validates cleanly.
      const v = validateTestPlan({
        root: worktreePath, plan, expectHeadSha: plan.candidateSha,
        expectedBaseSha: planBase, liveContent: liveBind.value,
      });
      if (!v.ok) {
        return { ok: false, code: planGateCodeFor(v.code),
          detail: { reason: v.reason, planCode: v.code, planDigest: plan.planDigest } };
      }
      planContent = liveBind.value;
      if (plan.status === 'NO_TESTS') {
        // Docs-only / empty changeset: an EXPLICIT state handled BEFORE any
        // command derivation (a NO_TESTS plan is deliberately not executable).
        // Nothing is spawned, a truthful NO_TESTS record is persisted for
        // read-back, and the gate never reports PASS for "no tests selected".
        // (F2/round-2) The snapshot THIS record persists must be its own fresh
        // boundary observation: the early pre-check above was taken before
        // this decision point and cannot vouch for the record written here.
        const nBind = computePlanContentBinding({ root: worktreePath });
        if (!nBind.ok) {
          return { ok: false, code: ACTIVE_TEST_GATE_CODES.PLAN_FAILED,
            detail: { reason: `content binding unavailable at the no-tests boundary: ${nBind.reason}`, planDigest: plan.planDigest } };
        }
        if (nBind.value.digest !== plan.contentBinding.digest) {
          return { ok: false, code: ACTIVE_TEST_GATE_CODES.PLAN_STALE,
            detail: { reason: `worktree content drifted before the no-tests record was written (planned ${plan.contentBinding.digest.slice(0, 12)}… -> observed ${nBind.value.digest.slice(0, 12)}…): replan`, planCode: TEST_PLAN_CODES.PLAN_STALE, planDigest: plan.planDigest } };
        }
        planContent = nBind.value;
        const nBefore = snap();
        const nAfter = snap();
        const finishedAt = new Date(clock()).toISOString();
        const nRec = {
          schemaVersion: TEST_RUN_SCHEMA_VERSION,
          kind: 'TestRunRecord',
          runId: `active-${finishedAt.replace(/[:.]/g, '-')}-${seq += 1}-no-tests`,
          toolCallId: null,
          runSource: 'control-plane-active',
          identityHash,
          taskId: (record && record.taskId) || (session && session.taskId) || null,
          repo: (record && record.repo) || (session && session.repo) || null,
          issueNumber: (record && record.issueNumber) ?? (session && session.issueNumber) ?? null,
          worktreePath,
          command: `test-plan:${plan.planDigest}`,
          commandDigest: sha256(`test-plan:${plan.planDigest}`),
          outputDigest: null,
          rawLogPath: null,
          rawLogBytes: 0,
          exitCode: null,
          result: 'NO_TESTS',
          outputBytes: 0,
          headSha: plan.candidateSha,
          startedAt: finishedAt,
          finishedAt,
          before: nBefore ? { contentDigest: nBefore.contentDigest, fileCount: nBefore.fileCount } : null,
          after: nAfter ? { contentDigest: nAfter.contentDigest, fileCount: nAfter.fileCount } : null,
          boundary: 'OBSERVED_START',
          binding: (nBefore && nAfter) ? 'PROVEN' : 'UNPROVEN',
          capturedBy: 'control-loop/activeTestRunner',
          capturedAt: finishedAt,
          plan,
          planContentSnapshot: planContent,
          spawn: { executable: null, argv: [], cwd: worktreePath, timeoutMs, signal: null, spawnError: null },
          runtime: { node: process.version, platform: process.platform, arch: process.arch },
        };
        try { appendRecord(store, nRec); } catch (e) {
          return { ok: false, code: ACTIVE_TEST_GATE_CODES.RECORD_WRITE_FAILED,
            detail: `${store}: ${String((e && e.message) || e)}` };
        }
        return { ok: false, code: ACTIVE_TEST_GATE_CODES.NO_TESTS,
          detail: { reason: plan.fullReason, plan, record: nRec } };
      }
      // argv is DERIVED at the execution boundary below, from a FRESH full
      // binding observed immediately before the spawn — never from this early
      // pre-check value reused across the setup window.
    }

    const logDir = activeTestRunLogDir({ runsPath: store });
    if (!logDir) {
      return { ok: false, code: ACTIVE_TEST_GATE_CODES.UNBOUND,
        detail: `no raw-log directory can be derived from ${store}` };
    }

    // (1) content snapshot immediately BEFORE the spawn ...
    const before = snap();
    // Last observation before argv executes: the tracked bytes must still be
    // exactly what the plan selected against. Drift between the live binding
    // computed above and THIS snapshot (a race window of milliseconds) is a
    // typed stale refusal — never a spawn of a selection nobody proved.
    if (plan && planContent && before
      && before.contentDigest !== plan.contentBinding.contentDigest) {
      return {
        ok: false,
        code: ACTIVE_TEST_GATE_CODES.PLAN_STALE,
        detail: {
          reason: `tracked content drifted between planning and the pre-spawn snapshot (planned ${plan.contentBinding.contentDigest.slice(0, 12)}… -> observed ${String(before.contentDigest).slice(0, 12)}…): replan`,
          planCode: TEST_PLAN_CODES.PLAN_STALE,
          planDigest: plan.planDigest,
        },
      };
    }
    // (F2/round-2) THE boundary observation: a FRESH full binding (tracked +
    // untracked) captured HERE, immediately before spawn — not the early
    // pre-check value reused across the setup window. argv is derived from
    // THIS observation and THIS exact snapshot is what the record persists,
    // so planned == observed == persisted at the spawn boundary. Any drift in
    // the window is a typed refusal, never a spawn of an unproved selection.
    if (plan) {
      const boundaryBind = computePlanContentBinding({ root: worktreePath });
      if (!boundaryBind.ok) {
        return { ok: false, code: ACTIVE_TEST_GATE_CODES.PLAN_FAILED,
          detail: { reason: `content binding unavailable at the execution boundary: ${boundaryBind.reason}`, planDigest: plan.planDigest } };
      }
      if (boundaryBind.value.digest !== plan.contentBinding.digest) {
        return { ok: false, code: ACTIVE_TEST_GATE_CODES.PLAN_STALE,
          detail: { reason: `worktree content drifted at the execution boundary (planned ${plan.contentBinding.digest.slice(0, 12)}… -> observed ${boundaryBind.value.digest.slice(0, 12)}…): replan`, planCode: TEST_PLAN_CODES.PLAN_STALE, planDigest: plan.planDigest } };
      }
      // argv is DERIVED from the validated plan — never caller-supplied. The
      // validation re-checks manifest/selector digest, planDigest (tamper),
      // file safety (traversal/symlink escape/inventory ownership), the TASK
      // BASE binding and the content binding (THIS boundary observation), and
      // binds the plan to its exact candidate HEAD (stale -> refuse).
      const cmd = testPlanGateCommand({
        root: worktreePath, plan, expectedBaseSha: planBase, liveContent: boundaryBind.value,
      });
      if (!cmd.ok) {
        return { ok: false, code: planGateCodeFor(cmd.code),
          detail: { reason: cmd.reason || cmd.detail || cmd.code, planCode: cmd.code, planDigest: plan.planDigest } };
      }
      planContent = boundaryBind.value;
      resolved = { ok: true, command: cmd.command, executable: cmd.executable, argv: cmd.argv };
    }
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
    // (F2/round-2) A FRESH full binding right after execution: the tracked
    // snapshot above cannot see a source file the run itself created or
    // rewrote (untracked), and the persisted planContentSnapshot must still
    // describe the content state this run was planned against.
    const afterBind = plan ? computePlanContentBinding({ root: worktreePath }) : null;
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

    // Plan mode: exit 0 alone is NEVER proof. The TAP summary must exist and
    // pass the aggregate checks (non-zero tests >= file count, fail/cancel/
    // skip/todo all zero, pass == tests) — a nested-harness or truncated run
    // can exit 0 while having executed nothing.
    let tap = null;
    if (plan) {
      const summary = parseTapSummary(stdout);
      const ev = evaluateSummary({
        exitCode: Number.isInteger(status) ? status : -1,
        summary,
        fileCount: plan.files.length,
      });
      tap = { summary, fileCount: plan.files.length, ok: ev.ok, reasons: ev.reasons };
    }
    // Output that reached the cap is incomplete: no summary built from it can
    // ever be trusted, so truncation is its own typed, fail-closed code.
    const truncated = Boolean(spawnError && /maxBuffer|ERR_CHILD_PROCESS_STDIO_MAXBUFFER|ENOBUFS/i.test(spawnError))
      || Buffer.byteLength(stdout, 'utf8') >= maxOutputBytes
      || Buffer.byteLength(stderr, 'utf8') >= maxOutputBytes;

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
    // PASS requires a PROVEN run: exit 0 AND (plan mode) a valid TAP summary.
    const provenPass = Number.isInteger(status) && status === 0
      && (plan ? Boolean(tap && tap.ok) : true);
    // (PR285-R3-01) The authoritative OUTCOME is decided BEFORE the record is
    // built, using exactly the predicates (and order) the returns below use.
    // The record can therefore never claim PASS for a run this function
    // refuses: a run that drifted DURING execution is persisted as FAIL + a
    // typed refusal, not as a PASS record the runner merely happens to reject.
    const refusal = (() => {
      if (spawnError || !Number.isInteger(status)) {
        return {
          code: truncated ? ACTIVE_TEST_GATE_CODES.OUTPUT_TRUNCATED : ACTIVE_TEST_GATE_CODES.SPAWN_FAILED,
          reason: spawnError
            ? `the gate process could not be observed: ${spawnError}`
            : 'the gate process did not report an exit code',
        };
      }
      if (truncated) {
        return { code: ACTIVE_TEST_GATE_CODES.OUTPUT_TRUNCATED,
          reason: `the gate output reached the ${maxOutputBytes}-byte cap: no summary built from it is trusted` };
      }
      if (status !== 0) {
        return { code: ACTIVE_TEST_GATE_CODES.NONZERO_EXIT, reason: `the gate exited with code ${status}` };
      }
      if (tap && !tap.ok) {
        return { code: ACTIVE_TEST_GATE_CODES.TAP_SUMMARY_INVALID,
          reason: `exit code 0 is not proof: ${tap.reasons.join('; ')}` };
      }
      if (!before || !after) {
        return { code: ACTIVE_TEST_GATE_CODES.UNPROVEN_BINDING,
          reason: 'the control plane could not bracket this run with before/after snapshots' };
      }
      if (plan) {
        if (!afterBind || !afterBind.ok) {
          return { code: ACTIVE_TEST_GATE_CODES.UNPROVEN_BINDING,
            reason: `full content binding unavailable after execution: ${(afterBind && afterBind.reason) || 'no observation'}` };
        }
        if (planContent && afterBind.value.digest !== planContent.digest) {
          return { code: ACTIVE_TEST_GATE_CODES.CONTENT_DRIFT, phase: 'full-binding',
            reason: `worktree content changed during the run (boundary ${planContent.digest.slice(0, 12)}… -> after ${afterBind.value.digest.slice(0, 12)}…): untracked drift the tracked snapshot cannot see` };
        }
      }
      if (before.contentDigest !== after.contentDigest) {
        return { code: ACTIVE_TEST_GATE_CODES.CONTENT_DRIFT,
          reason: `tracked content changed during the run (${String(before.contentDigest).slice(0, 12)}… -> ${String(after.contentDigest).slice(0, 12)}…)` };
      }
      return null;
    })();
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
      result: !Number.isInteger(status) ? 'UNKNOWN' : ((refusal || !provenPass) ? 'FAIL' : 'PASS'),
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
      elapsedMs: finishedAtMs - startedAtMs,
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      // Plan-mode evidence (absent on legacy runs): the exact selection, its
      // digests and the TAP verdict the consumer re-derives on read-back.
      ...(plan ? {
        plan, tap, planContentSnapshot: planContent,
        // (PR285-R3-01) The FULL post-execution observation (tracked +
        // untracked), persisted even when it DISAGREES with the plan: it is
        // the evidence that the run drifted, and the consumer re-checks it on
        // read-back so cleaning the drift file can never rehabilitate the run.
        planContentSnapshotAfter: (afterBind && afterBind.ok) ? afterBind.value : null,
      } : {}),
      // (PR285-R3-01) The producer's authoritative persisted outcome: `null`
      // is a proven PASS, any object is a typed refusal the consumer must
      // keep honouring (producer return <=> persisted record <=> read-back).
      refusal: refusal
        ? { code: refusal.code, reason: refusal.reason, ...(refusal.phase ? { phase: refusal.phase } : {}) }
        : null,
      spawn: {
        executable: resolved.executable,
        argv: resolved.argv.slice(),
        cwd: worktreePath,
        timeoutMs,
        signal,
        spawnError,
      },
    };
    try { appendRecord(store, rec); } catch (e) {
      // A gate whose evidence cannot be persisted is itself a typed failure:
      // downstream must see an explicit refusal, never a silent absence.
      return { ok: false, code: ACTIVE_TEST_GATE_CODES.RECORD_WRITE_FAILED,
        detail: `${store}: ${String((e && e.message) || e)}`, record: rec };
    }

    const evidence = { record: rec, rawLogPath, runId, command: resolved.command, exitCode: status };
    // Every refusal below returns the SAME typed code the record persisted
    // (`refusal` was computed from exactly these predicates, in this order),
    // so producer return, persisted record and consumer read-back agree.
    if (spawnError || !Number.isInteger(status)) {
      return { ok: false, code: refusal.code,
        detail: { ...evidence, signal, spawnError, truncated } };
    }
    if (truncated) {
      return { ok: false, code: refusal.code,
        detail: { ...evidence, maxOutputBytes, truncated } };
    }
    if (status !== 0) {
      return { ok: false, code: refusal.code, detail: evidence };
    }
    if (tap && !tap.ok) {
      // status === 0 but the summary is missing/failed: an UNPROVEN run.
      return { ok: false, code: refusal.code,
        detail: { ...evidence, reasons: tap.reasons, summary: tap.summary } };
    }
    if (!before || !after) {
      return { ok: false, code: refusal.code, detail: evidence };
    }
    // (F2/round-2) Post-execution FULL binding: untracked drift during the run
    // is CONTENT_DRIFT even when the tracked before/after pair is identical.
    // (PR285-R3-01) That AFTER observation is PERSISTED on the record and the
    // refusal is persisted with it, so the run stays refused after the drift
    // file is cleaned up and the live worktree matches the plan again.
    if (plan) {
      if (!afterBind || !afterBind.ok) {
        return { ok: false, code: refusal.code,
          detail: { ...evidence, reason: `full content binding unavailable after execution: ${(afterBind && afterBind.reason) || 'no observation'}` } };
      }
      if (planContent && afterBind.value.digest !== planContent.digest) {
        return { ok: false, code: refusal.code,
          detail: { ...evidence, phase: 'full-binding',
            planned: planContent.digest, observed: afterBind.value.digest,
            reason: `worktree content changed during the run (boundary ${planContent.digest.slice(0, 12)}… -> after ${afterBind.value.digest.slice(0, 12)}…): untracked drift the tracked snapshot cannot see` } };
      }
    }
    if (before.contentDigest !== after.contentDigest) {
      return { ok: false, code: refusal.code,
        detail: { ...evidence, before: before.contentDigest, after: after.contentDigest } };
    }
    return { ok: true, ...evidence };
  }

  return Object.freeze({ runGate: runActiveTestGate, timeoutMs, maxOutputBytes, planMode, hasPlanBuilder: typeof planBuilder === 'function' });
}

// ---------------------------------------------------------------------------
// Consumer-side read-back of a plan-mode run. The verifier re-derives EVERY
// claim the producer made about the plan from data it can recompute here:
//   * validateTestPlan re-checks manifest/selector digest, planDigest (the
//     exact digest recorded with the run — a tampered plan no longer hashes
//     to it) and file safety against the live worktree;
//   * the recorded spawn argv must be EXACTLY the plan-derived command;
//   * the raw log bytes are re-parsed for TAP and re-evaluated — an exit code
//     of 0 with a missing/failed summary is refused here too.
// A run WITHOUT a plan is legacy-script evidence: `{ ok:true, legacy:true }`.
// ---------------------------------------------------------------------------
export function verifyActiveRunPlanBinding({ record: r, rawText = '', root = null, expectedBaseSha = undefined } = {}) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_INVALID, reason: 'record is not an object' };
  }
  if (!r.plan) return { ok: true, legacy: true };
  const wt = root || r.worktreePath;
  if (typeof wt !== 'string' || !wt) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_INVALID, reason: 'no worktree to validate the plan against' };
  }
  // Full validation runs for EVERY plan status — a NO_TESTS plan is refused
  // for a wrong task BASE or a missing content binding exactly like an
  // executable one, before its status can be reported as the reason.
  // (F2/round-2) The consumer's OWN live observation: a FULL binding (tracked
  // + untracked) of the worktree at read-back time, passed into validation so
  // a source created or edited AFTER the run — invisible to the tracked-only
  // before/after chain — is a refusal here, never admissible evidence.
  const liveContent = computePlanContentBinding({ root: wt });
  if (!liveContent.ok) {
    return { ok: false, code: TEST_PLAN_CODES.CONTENT_BINDING_UNAVAILABLE,
      reason: `live content binding unavailable: ${liveContent.reason}` };
  }
  const v = validateTestPlan({ root: wt, plan: r.plan, expectedBaseSha, liveContent: liveContent.value });
  if (!v.ok) return { ok: false, code: v.code, reason: v.reason };
  // Content chain: the producer's pre-spawn observation persisted in the
  // record must equal the plan's content claim, and the plan's tracked
  // portion must equal the observed pre-run boundary. Together with the
  // live-worktree digest check in the verifier this closes
  // planned == observed == live.
  if (!r.planContentSnapshot || typeof r.planContentSnapshot !== 'object'
    || r.planContentSnapshot.digest !== r.plan.contentBinding.digest) {
    return { ok: false, code: 'TEST_PLAN_CONTENT_MISMATCH',
      reason: 'no pre-spawn content observation is recorded, or it differs from the planned content binding (the plan was not the content actually executed against)' };
  }
  if (!r.before || r.before.contentDigest !== r.plan.contentBinding.contentDigest) {
    return { ok: false, code: 'TEST_PLAN_CONTENT_MISMATCH',
      reason: `planned tracked content (${String(r.plan.contentBinding.contentDigest).slice(0, 12)}…) does not match the observed pre-run boundary (${String(r.before && r.before.contentDigest).slice(0, 12)}…)` };
  }
  if (r.plan.status === 'NO_TESTS') {
    return { ok: false, code: 'TEST_PLAN_NO_TESTS',
      reason: `the run never executed tests (explicit no-tests plan): ${r.plan.fullReason || 'no reason recorded'}` };
  }
  const expectedArgv = ['--test', '--test-reporter=tap', ...r.plan.files];
  const expectedCommand = `node --test --test-reporter=tap ${r.plan.files.join(' ')}`;
  const argvActual = r.spawn && Array.isArray(r.spawn.argv) ? r.spawn.argv : null;
  if (!argvActual || JSON.stringify(argvActual) !== JSON.stringify(expectedArgv)) {
    return { ok: false, code: 'TEST_PLAN_ARGV_MISMATCH',
      reason: `executed argv does not match the validated plan (recorded: ${JSON.stringify(argvActual)}, plan: ${JSON.stringify(expectedArgv)})` };
  }
  if (r.command !== expectedCommand) {
    return { ok: false, code: 'TEST_PLAN_ARGV_MISMATCH',
      reason: `recorded command string does not match the validated plan (${r.command})` };
  }
  const summary = parseTapSummary(rawText);
  const ev = evaluateSummary({
    exitCode: Number.isInteger(r.exitCode) ? r.exitCode : -1,
    summary,
    fileCount: r.plan.files.length,
  });
  if (!ev.ok) {
    return { ok: false, code: 'TEST_PLAN_TAP_INVALID', reason: ev.reasons.join('; ') };
  }
  // (PR285-R3-01) The PERSISTED producer outcome and the persisted FULL
  // post-execution observation. A run the producer refused is refused here for
  // ever — the refusal travels ON the record, so a drift file that was cleaned
  // up (or an untracked source that was restored) can never rehabilitate it.
  // The AFTER binding is re-checked against the plan's own content binding, so
  // a run whose worktree changed while it executed is refused even when the
  // LIVE worktree now matches the plan again.
  if (r.refusal && typeof r.refusal === 'object'
    && typeof r.refusal.code === 'string' && r.refusal.code) {
    return { ok: false, code: r.refusal.code,
      reason: r.refusal.reason || `the producer refused this run (${r.refusal.code})` };
  }
  if (!r.planContentSnapshotAfter || typeof r.planContentSnapshotAfter !== 'object'
    || !HEX64.test(String(r.planContentSnapshotAfter.digest || ''))) {
    return { ok: false, code: 'TEST_PLAN_CONTENT_MISMATCH',
      reason: 'no post-execution content observation is recorded: the run cannot prove the worktree was unchanged while it executed' };
  }
  if (r.planContentSnapshotAfter.digest !== r.plan.contentBinding.digest) {
    return { ok: false, code: ACTIVE_TEST_GATE_CODES.CONTENT_DRIFT,
      reason: `worktree content changed during the run (planned ${String(r.plan.contentBinding.digest).slice(0, 12)}… -> after ${String(r.planContentSnapshotAfter.digest).slice(0, 12)}…): the run stays refused even though the worktree now matches the plan` };
  }
  return { ok: true, plan: r.plan, tap: summary };
}
