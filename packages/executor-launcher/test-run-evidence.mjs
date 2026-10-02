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
//                 evidence. It brackets each test command with a content
//                 snapshot taken immediately before the command started and
//                 immediately after it finished, and appends a TestRunRecord
//                 (identity, worktree, command, exit code, result, both
//                 snapshots) to <stateDir>/executions/<identity>.testruns.jsonl.
//   * consumer  = review-evidence.readExecutionTestLog, which refuses any log
//                 whose recorded `after` snapshot is not the live worktree
//                 content, and reports UNVERIFIED when no record exists.
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

// Tools that provably cannot change tracked content; everything else (write,
// edit, bash, git, unknown/future tools) forces a rolling refresh — unknown
// tool names are deliberately treated as content-capable so the safe direction
// is always "recompute", never "assume unchanged".
const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep', 'list', 'search', 'ls', 'lsdir']);

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
 *   refresh(cmd?)   rolling content snapshot after a content-capable tool event
 *   observe(c)      called for every classified executor event; records a run
 *                   when a completed test command is seen
 *
 * `before` is the rolling snapshot captured while the command was starting,
 * `after` is a fresh full snapshot taken the moment its output arrived. When
 * either cannot be proven the record is written with `binding: 'UNPROVEN'` and
 * the reader refuses it — a snapshot the control plane could not take is never
 * replaced by a digest the model claimed.
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
  let rolling = null;
  // Baseline: the content state at executor launch, i.e. exactly the state the
  // first observed command starts from.
  const base = tr.snapshot({ withHead: true });
  if (base.ok) rolling = base.value;

  function refresh(cmd = null) {
    try {
      if (typeof cmd === 'string' && GIT_INDEX_RE.test(cmd)) tr.markIndexStale();
      const s = tr.snapshot();
      if (s.ok) rolling = s.value;
    } catch { /* keep the previous snapshot; an unprovable `before` is refused downstream */ }
  }

  function recordRun(cmd, output) {
    const before = rolling;
    let after = null;
    try {
      const s = tr.snapshot({ withHead: true });
      if (s.ok) after = s.value;
    } catch { /* refused downstream */ }
    if (after) rolling = after;
    const exitCode = parseExitCode(output);
    const rec = {
      schemaVersion: TEST_RUN_SCHEMA_VERSION,
      kind: 'TestRunRecord',
      identityHash,
      taskId,
      repo,
      issueNumber,
      worktreePath,
      command: cmd,
      commandDigest: sha256(cmd),
      exitCode,
      result: exitCode === null ? 'UNKNOWN' : (exitCode === 0 ? 'PASS' : 'FAIL'),
      outputBytes: Buffer.byteLength(String(output ?? ''), 'utf8'),
      headSha: after && HEX40.test(after.headSha || '') ? after.headSha : null,
      before: before ? { contentDigest: before.contentDigest, fileCount: before.fileCount } : null,
      after: after ? { contentDigest: after.contentDigest, fileCount: after.fileCount } : null,
      binding: (before && after) ? 'PROVEN' : 'UNPROVEN',
      capturedBy: 'executor-launcher/attachPassthrough',
      capturedAt: new Date(clock()).toISOString(),
    };
    try { appendRecord(runsPath, rec); } catch { /* evidence stays absent -> UNVERIFIED */ }
    return rec;
  }

  function observe(c) {
    if (!c || typeof c !== 'object') return;
    const st = c.event && c.event.part && c.event.part.state;
    if (!st || typeof st !== 'object') return;
    const cmd = st.input && st.input.command;
    // Completed test command -> bracket it and persist the canonical run.
    if (isTestCommand(cmd) && typeof st.output === 'string') {
      recordRun(cmd, st.output);
      return;
    }
    // Every other content-capable tool event advances the rolling snapshot so
    // the NEXT command's `before` is the real pre-command state. This is why
    // the executor-exit stamp is unnecessary: content edits between two test
    // runs are already reflected here.
    if (c.kind === 'tool' && !READ_ONLY_TOOLS.has(String(c.tool || ''))) refresh(cmd);
  }

  return Object.freeze({ refresh, observe, get rolling() { return rolling; } });
}
