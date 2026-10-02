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
import { createContentTracker } from './execution-content-binding.mjs';

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
