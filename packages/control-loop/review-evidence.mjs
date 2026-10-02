// review-evidence.mjs — the three evidence data paths that feed the review payload.
//
// Why this exists: the payload builder had no producer for `testLog`, resolved
// the artifact bundle against the RUNNER's PROJECT_ROOT instead of the bound
// task worktree, and shipped `session.baseSha..session.headSha` as "the PR
// diff" (a 1 KB changeset instead of the reviewed PR). All three produced a
// structurally unsatisfiable review: the reviewer was asked to verify evidence
// the payload could never contain.
//
// Ownership: READ-ONLY over canonical state (session record, ExecutionRecord,
// executor events log, task worktree git). It never writes state, never
// terminalizes, never approves. Every non-OK path returns a TRUTHFUL string or
// a typed code — evidence that is missing or stale is reported as missing or
// stale, never fabricated, never padded with a section heading alone.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { computeWorktreeContentBinding, contentBindingFromRecord } from '../executor-launcher/execution-content-binding.mjs';
import { TEST_CMD, readTestRunRecords, testRunsPathFor, TEST_RUN_CODES } from '../executor-launcher/test-run-evidence.mjs';

export const REVIEW_EVIDENCE_CODES = Object.freeze({
  // (a) test log
  VERIFY_REPORT_ABSENT: 'EVIDENCE_VERIFY_REPORT_ABSENT',
  EXECUTION_RECORD_MISSING: 'EVIDENCE_EXECUTION_RECORD_MISSING',
  EXECUTION_RECORD_UNREADABLE: 'EVIDENCE_EXECUTION_RECORD_UNREADABLE',
  EXECUTION_RECORD_STALE: 'EVIDENCE_EXECUTION_RECORD_STALE',
  EXECUTION_RECORD_UNBOUND: 'EVIDENCE_EXECUTION_RECORD_UNBOUND',
  TEST_LOG_EMPTY: 'EVIDENCE_TEST_LOG_EMPTY',
  // (a) test log — bound to the content the command ACTUALLY ran against
  TEST_RUN_UNVERIFIED: TEST_RUN_CODES.UNVERIFIED,
  TEST_RUN_STALE: TEST_RUN_CODES.STALE,
  TEST_RUN_CHANGED_DURING_TEST: TEST_RUN_CODES.CHANGED_DURING_TEST,
  // (b) bundle
  BUNDLE_MISSING: 'EVIDENCE_BUNDLE_MISSING',
  BUNDLE_EMPTY: 'EVIDENCE_BUNDLE_EMPTY',
  BUNDLE_STALE: 'EVIDENCE_BUNDLE_STALE',
  // (c) changeset
  WORKTREE_UNAVAILABLE: 'EVIDENCE_WORKTREE_UNAVAILABLE',
  PR_HEAD_MISMATCH: 'EVIDENCE_PR_HEAD_MISMATCH',
  PR_DIFF_UNAVAILABLE: 'EVIDENCE_PR_DIFF_UNAVAILABLE',
  PR_DIFF_EMPTY: 'EVIDENCE_PR_DIFF_EMPTY',
});

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function ok(v, extra = {}) { return { ok: true, value: v, ...extra }; }
function fail(code, detail, extra = {}) { return { ok: false, code, detail, ...extra }; }

// ---------------------------------------------------------------------------
// (a) Test log — bound to THIS identity/HEAD through the verifier's OWN
//     executionRecordPath, never "the newest log by timestamp".
// ---------------------------------------------------------------------------
export function readExecutionTestLog({ session, verifyReport, readRecord = null } = {}) {
  const missing = (why) =>
    `MISSING EVIDENCE (test execution log): ${why}\n`
    + 'No test log is available for THIS identity/HEAD. Do NOT treat a section '
    + 'heading as proof. VERDICT: CHANGES_REQUESTED unless the executor re-runs '
    + 'the offline suite and the verifier records its ExecutionRecord.';

  if (!verifyReport || typeof verifyReport !== 'object') {
    return fail(REVIEW_EVIDENCE_CODES.VERIFY_REPORT_ABSENT,
      'finalReview received no verifier report on ctx.report', { value: missing('ctx.report/verifyReport absent') });
  }
  // Two canonical shapes arrive here: the verifier VALUE ({verdict, evidence})
  // on the fresh walk, and the bare EVIDENCE object on a resume leg (the
  // resume passes `vRec.evidence`). Accept both — a shape mismatch must never
  // be misreported as "the executor never ran tests".
  const ev = (verifyReport.evidence && typeof verifyReport.evidence === 'object')
    ? verifyReport.evidence
    : verifyReport;
  const verdict = verifyReport.verdict ?? ev.verdict ?? null;
  if (verdict !== null && verdict !== 'PASS') {
    return fail(REVIEW_EVIDENCE_CODES.VERIFY_REPORT_ABSENT,
      `verifier verdict=${verdict}`, { value: missing(`verifier verdict is ${verdict}`) });
  }
  if (!ev.executionRecordPath) {
    return fail(REVIEW_EVIDENCE_CODES.EXECUTION_RECORD_MISSING,
      'no executionRecordPath on the verify evidence', { value: missing('no executionRecordPath on the verify evidence') });
  }

  let record = null;
  let recordPath = null;
  if (typeof readRecord === 'function') {
    const r = readRecord(ev.executionRecordPath);
    if (!r || !r.ok) {
      return fail(REVIEW_EVIDENCE_CODES.EXECUTION_RECORD_UNREADABLE,
        (r && r.reason) || 'unreadable', { value: missing((r && r.reason) || 'ExecutionRecord unreadable') });
    }
    record = r.record; recordPath = r.path || ev.executionRecordPath;
  } else {
    try {
      record = JSON.parse(fs.readFileSync(ev.executionRecordPath, 'utf8'));
      recordPath = ev.executionRecordPath;
    } catch (e) {
      return fail(REVIEW_EVIDENCE_CODES.EXECUTION_RECORD_UNREADABLE, String(e.message || e),
        { value: missing(`ExecutionRecord unreadable: ${String(e.message || e)}`) });
    }
  }

  // Identity/HEAD binding — the log must belong to the session under review.
  const stale = [];
  if (record.identityHash && session.identityHash && record.identityHash !== session.identityHash) stale.push('identityHash');
  if (record.repo && session.repo && record.repo !== session.repo) stale.push('repo');
  if (record.issueNumber != null && session.issueNumber != null
    && Number(record.issueNumber) !== Number(session.issueNumber)) stale.push('issueNumber');
  if (record.taskId && session.taskId && record.taskId !== session.taskId) stale.push('taskId');
  if (session.worktreePath && record.worktreePath && path.resolve(record.worktreePath) !== path.resolve(session.worktreePath)) stale.push('worktreePath');
  if (session.baseSha && record.baseSha && record.baseSha !== session.baseSha) stale.push('baseSha');
  // The verifier's evidence must point at the record we just read.
  if (recordPath && ev.executionRecordPath && path.resolve(recordPath) !== path.resolve(ev.executionRecordPath)) stale.push('verifyRecordPath');
  if (stale.length) {
    const detail = `stale ExecutionRecord fields: ${stale.join(', ')}`;
    return fail(REVIEW_EVIDENCE_CODES.EXECUTION_RECORD_STALE, detail,
      { value: missing(`${detail} (record is not THIS session's execution)`) });
  }

  // ---- CODE-VERSION binding (Issue #263 reviewer finding 4) ----------------
  // `record.headSha` alone used to be the binding, and production records never
  // write it — `undefined !== undefined` is false, so an OLD version's test log
  // sailed through. Two things are now mandatory before any log is admissible:
  //   1. the record carries a real stamp (40-hex headSha + sha256 content
  //      digest over every tracked file), and
  //   2. that digest RECOMPUTES from the bound task worktree right now.
  // Content is the authority: equal digests mean byte-identical code, which is
  // what "the tests ran against what is being reviewed" actually means. The
  // headSha LABEL may legitimately differ after a content-neutral commit (a
  // commit-recovery that only staged already-tested bytes), so it is reported
  // as evidence, not used as the pass/fail gate.
  const bound = contentBindingFromRecord(record);
  if (!bound.ok) {
    return fail(REVIEW_EVIDENCE_CODES.EXECUTION_RECORD_UNBOUND, bound.reason,
      { value: missing(`ExecutionRecord carries no code-version binding: ${bound.reason}`) });
  }
  const live = computeWorktreeContentBinding({ worktreePath: session.worktreePath });
  if (!live.ok) {
    return fail(REVIEW_EVIDENCE_CODES.EXECUTION_RECORD_UNBOUND, `worktree content binding unavailable: ${live.reason}`,
      { value: missing(`cannot recompute the code-version binding: ${live.reason}`) });
  }
  if (live.value.contentDigest !== bound.value.contentDigest) {
    const detail = 'stale ExecutionRecord content: codeContentDigest differs from the bound task worktree';
    return fail(REVIEW_EVIDENCE_CODES.EXECUTION_RECORD_STALE, detail,
      { value: missing(`${detail} (the log was produced against a DIFFERENT code version)`) });
  }
  const headShaBinding = (typeof session.headSha === 'string' && session.headSha
    && session.headSha.toLowerCase() === bound.value.headSha) ? 'MATCH' : 'MISMATCH';

  // ---- TEST-RUN binding (Issue #263 reviewer finding 4, definitive) --------
  // The stamp above binds the RECORD to a code version; it says nothing about
  // what was TESTED. An executor that passes on A, edits B and then exits
  // stamps B, so `live == stamped` still held while the log vouched for A.
  // The test binding is therefore the canonical TestRunRecord the control plane
  // wrote while the command ran: content immediately before, content
  // immediately after, the command, its exit code, this identity and worktree.
  //   * no record at all                -> UNVERIFIED (never default PASS)
  //   * content moved DURING the run    -> CHANGED_DURING_TEST (stale)
  //   * `after` is not the live content -> STALE (someone edited after the run)
  // `headSha` stays provenance only: a content-neutral commit never forces a
  // rerun, because the gate compares content, not labels.
  const runsPath = record.testRunsPath
    || testRunsPathFor({ eventsPath: record.eventsPath, identityHash: record.identityHash });
  const runs = readTestRunRecords(runsPath);
  if (!runs.length) {
    return fail(REVIEW_EVIDENCE_CODES.TEST_RUN_UNVERIFIED,
      `no canonical TestRunRecord at ${runsPath || '(unresolvable)'}`,
      { value: missing('no control-plane before/after content snapshot brackets the test command (TestRunRecord absent)') });
  }
  for (const r of runs) {
    const why = [];
    if (r.identityHash && record.identityHash && r.identityHash !== record.identityHash) why.push('identityHash');
    if (r.worktreePath && record.worktreePath && path.resolve(r.worktreePath) !== path.resolve(record.worktreePath)) why.push('worktreePath');
    if (r.repo && record.repo && r.repo !== record.repo) why.push('repo');
    if (r.issueNumber != null && record.issueNumber != null
      && Number(r.issueNumber) !== Number(record.issueNumber)) why.push('issueNumber');
    if (why.length) {
      const detail = `stale TestRunRecord fields: ${why.join(', ')}`;
      return fail(REVIEW_EVIDENCE_CODES.TEST_RUN_STALE, detail,
        { value: missing(`${detail} (the recorded run belongs to another identity/worktree)`) });
    }
    const beforeD = r.before && typeof r.before.contentDigest === 'string' ? r.before.contentDigest : '';
    const afterD = r.after && typeof r.after.contentDigest === 'string' ? r.after.contentDigest : '';
    if (!HEX64.test(beforeD) || !HEX64.test(afterD) || r.binding !== 'PROVEN') {
      return fail(REVIEW_EVIDENCE_CODES.TEST_RUN_UNVERIFIED,
        `TestRunRecord has no proven before/after snapshot (binding=${r.binding ?? 'absent'})`,
        { value: missing('the before/after content snapshot for this test command was not captured by the control plane') });
    }
    if (beforeD !== afterD) {
      const detail = `content changed DURING the test command: ${r.command}`;
      return fail(REVIEW_EVIDENCE_CODES.TEST_RUN_CHANGED_DURING_TEST, detail,
        { value: missing(`${detail} (before ${beforeD.slice(0, 12)}… -> after ${afterD.slice(0, 12)}…)`) });
    }
  }
  const matchingRuns = runs.filter((r) => r.after && r.after.contentDigest === live.value.contentDigest);
  if (!matchingRuns.length) {
    const detail = 'no recorded test run executed against the content now under review';
    return fail(REVIEW_EVIDENCE_CODES.TEST_RUN_STALE, detail,
      { value: missing(`${detail} (runs are bound to ${runs.map((r) => String(r.after.contentDigest).slice(0, 12)).join(', ')}; live is ${live.value.contentDigest.slice(0, 12)})`) });
  }

  if (!record.eventsPath || !fs.existsSync(record.eventsPath)) {
    return fail(REVIEW_EVIDENCE_CODES.TEST_LOG_EMPTY, 'eventsPath missing',
      { value: missing('the ExecutionRecord carries no readable events log') });
  }

  // Parse the executor's own tool outputs (events.jsonl stores them as JSON
  // strings, so line-parse rather than regex the raw file).
  let blocks = [];
  try {
    const lines = fs.readFileSync(record.eventsPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const st = o?.event?.part?.state;
      const cmd = st?.input?.command;
      const out = st?.output ?? st?.metadata?.output;
      if (typeof cmd !== 'string' || typeof out !== 'string') continue;
      if (!TEST_CMD.test(cmd)) continue;
      if (!out.includes('Exit code:')) continue;
      blocks.push({ cmd, out });
    }
  } catch (e) {
    return fail(REVIEW_EVIDENCE_CODES.TEST_LOG_EMPTY, String(e.message || e),
      { value: missing(`events log unreadable: ${String(e.message || e)}`) });
  }
  if (!blocks.length) {
    return fail(REVIEW_EVIDENCE_CODES.TEST_LOG_EMPTY, 'no `node --test` / `git diff --check` output with an exit code',
      { value: missing('the executor events log holds no offline test output with an exit code') });
  }

  // Only commands the control plane actually bracketed against the LIVE content
  // may be reported as evidence. A run bound to an older version is dropped,
  // never blended into a log that reads as if it covered the reviewed HEAD.
  const provenCmds = new Set(matchingRuns.map((r) => r.command));
  const provenBlocks = blocks.filter((b) => provenCmds.has(b.cmd));
  if (!provenBlocks.length) {
    const detail = 'no captured test output is backed by a matching TestRunRecord';
    return fail(REVIEW_EVIDENCE_CODES.TEST_RUN_STALE, detail,
      { value: missing(`${detail} (the log's commands were not re-run against the content under review)`) });
  }
  blocks = provenBlocks;

  const head = [
    '[EXECUTION EVIDENCE — bound to this review]',
    `identityHash: ${record.identityHash ?? 'unknown'}`,
    `taskId: ${record.taskId ?? 'unknown'}`,
    `worktreePath: ${record.worktreePath ?? 'unknown'}`,
    `baseSha: ${record.baseSha ?? 'unknown'}`,
    `headSha: ${record.headSha ?? '(not recorded by this executor run)'}  | reviewed headSha: ${session.headSha ?? 'unknown'}  | headShaBinding: ${headShaBinding}`,
    `codeContentDigest: ${record.codeContentDigest}  | fileCount: ${record.codeContentFiles ?? 'unknown'}  | liveDigest: ${live.value.contentDigest} (content: MATCH — verified byte-for-byte against this worktree)`,
    `testRunBinding: ${matchingRuns.length}/${runs.length} canonical TestRunRecord(s) bind this log to the live content `
      + `| testedDigest: ${matchingRuns[0].after.contentDigest} | store: ${runsPath}`,
    `headShaBinding is provenance ONLY — the test binding above is content, so a content-neutral commit needs no re-run.`,
    `executorProcessExitCode: ${record.exitCode}  terminalStatus: ${record.terminalStatus}  signal: ${record.signal ?? 'none'}`,
    `startedAt: ${record.startedAt ?? 'unknown'}  finishedAt: ${record.finishedAt ?? 'unknown'}`,
    `executionRecordPath: ${ev.executionRecordPath}`,
    `rawSource: ${record.eventsPath}`,
    '',
  ].join('\n');

  const body = blocks.map((b, i) =>
    `--- raw output ${i + 1}/${blocks.length}: ${b.cmd.trim()}\n${b.out.trimEnd()}\n`).join('\n');
  const failsSeen = blocks.filter((b) => /# fail [1-9]/.test(b.out) || /Exit code: [1-9]/.test(b.out));
  const recordFailed = Number(record.exitCode) !== 0;
  const attention = [];
  if (recordFailed) attention.push(`the executor process itself exited with code ${record.exitCode} (terminalStatus ${record.terminalStatus})`);
  if (failsSeen.length) attention.push(`${failsSeen.length} of ${blocks.length} captured commands report a NON-ZERO result`);

  const value = `${head}${body}\n`
    + (attention.length
      ? `ATTENTION: ${attention.join('; ')}.`
      : `All ${blocks.length} captured commands report fail=0 / Exit code: 0.`);

  return ok(value, { blocks: blocks.length, hasFailures: attention.length > 0, record });
}

// ---------------------------------------------------------------------------
// (c) The reviewed changeset — PR base/head reconciled offline, plus a clearly
//     separated task-scope (working tree vs headSha) diff so an uncommitted
//     remediation can never masquerade as part of the PR.
// ---------------------------------------------------------------------------
export function buildPrChangeset({ session, exec } = {}) {
  if (!session || typeof session !== 'object') {
    return fail(REVIEW_EVIDENCE_CODES.WORKTREE_UNAVAILABLE, 'session is required');
  }
  const wt = session.worktreePath;
  if (typeof wt !== 'string' || !wt) {
    return fail(REVIEW_EVIDENCE_CODES.WORKTREE_UNAVAILABLE, 'session.worktreePath is absent');
  }
  const head = session.headSha;
  if (typeof head !== 'string' || !HEX40.test(head)) {
    return fail(REVIEW_EVIDENCE_CODES.PR_HEAD_MISMATCH, `session.headSha is not a 40-hex sha: ${head}`);
  }

  const run = (argv) => {
    const out = exec('git', ['-C', wt, ...argv]);
    return typeof out === 'string' ? out.trim() : '';
  };

  // The reviewed HEAD must actually exist in the task worktree. Only a
  // well-formed 40-hex answer is authoritative — a stub/wrapper that echoes
  // anything must not be mistaken for proof of a mismatch.
  let headResolves = '';
  try { headResolves = run(['rev-parse', '--verify', `${head}^{commit}`]); } catch { headResolves = ''; }
  if (HEX40.test(headResolves) && headResolves !== head) {
    return fail(REVIEW_EVIDENCE_CODES.PR_HEAD_MISMATCH,
      `git rev-parse(${head}) = ${headResolves}`);
  }

  // Offline reconciliation with the GitHub PR binding (no network): the PR's
  // base branch is recorded on the session's controlLoop.prBinding.
  const prBinding = (session.controlLoop && session.controlLoop.prBinding) || null;
  if (prBinding && prBinding.headSha && prBinding.headSha !== head) {
    return fail(REVIEW_EVIDENCE_CODES.PR_HEAD_MISMATCH,
      `prBinding.headSha ${prBinding.headSha} != session.headSha ${head}`);
  }
  const baseBranch = (prBinding && prBinding.baseBranch)
    || session.targetBranch || 'main';
  const baseRef = `origin/${baseBranch}`;

  let baseSha = '';
  let baseSource = 'unresolved';
  try { baseSha = run(['rev-parse', '--verify', `${baseRef}^{commit}`]); } catch { baseSha = ''; }
  if (HEX40.test(baseSha)) {
    baseSource = baseRef;
  } else if (HEX40.test(session.baseSha || '')) {
    baseSha = session.baseSha;
    baseSource = 'session.baseSha (remote tracking ref not resolvable offline)';
  } else {
    return fail(REVIEW_EVIDENCE_CODES.PR_DIFF_UNAVAILABLE,
      `neither ${baseRef} nor session.baseSha resolves to a commit`);
  }

  let diff = '';
  try {
    diff = exec('git', ['-C', wt, 'diff', `${baseSha}...${head}`]);
  } catch (e) {
    if (!fs.existsSync(wt)) {
      return fail(REVIEW_EVIDENCE_CODES.WORKTREE_UNAVAILABLE,
        `bound task worktree is absent: ${wt}`);
    }
    return fail(REVIEW_EVIDENCE_CODES.PR_DIFF_UNAVAILABLE, String(e.message || e));
  }
  if (typeof diff !== 'string' || !diff.trim()) {
    return fail(REVIEW_EVIDENCE_CODES.PR_DIFF_EMPTY,
      `empty changeset for ${baseSha}...${head}`);
  }

  // Task-scope diff: what the working tree still owes on TOP of the reviewed
  // HEAD. Kept strictly separate from the PR changeset above.
  let scopeDiff = '';
  try { scopeDiff = exec('git', ['-C', wt, 'diff', head]) || ''; } catch { scopeDiff = ''; }
  if (typeof scopeDiff !== 'string') scopeDiff = '';

  const files = (diff.match(/^diff --git /gm) || []).length;
  const scopeFiles = (scopeDiff.match(/^diff --git /gm) || []).length;

  return ok({
    diff,
    scopeDiff: scopeDiff.trim(),
    meta: {
      baseRef,
      baseSha,
      baseSource,
      baseBranch,
      headSha: head,
      prNumber: prBinding ? (prBinding.prNumber ?? null) : (session.prNumber ?? null),
      bytes: Buffer.byteLength(diff, 'utf8'),
      files,
      sha256: sha256(diff),
      scopeBytes: Buffer.byteLength(scopeDiff, 'utf8'),
      scopeFiles,
      scopeSha256: scopeDiff.trim() ? sha256(scopeDiff) : null,
    },
  });
}

// ---------------------------------------------------------------------------
// (b) Bundle — resolved from the BOUND TASK WORKTREE and verified against the
//     changeset actually being reviewed. A stale or absent bundle is reported
//     as stale/absent, never silently passed as evidence.
// ---------------------------------------------------------------------------
export function buildBundleInfoForSession({ session, prNumber, prDiff = null } = {}) {
  const claim = (note, extra = {}) => ({ note, ...extra });
  const n = Number(prNumber);
  if (!session || typeof session !== 'object' || !session.worktreePath || !Number.isInteger(n) || n <= 0) {
    const note = 'bundle: cannot resolve (no bound task worktree or PR number) — NOT evidence of delivery';
    return fail(REVIEW_EVIDENCE_CODES.BUNDLE_MISSING, 'session.worktreePath / prNumber required',
      { value: { note }, note });
  }
  const dir = path.join(session.worktreePath, 'artifacts', 'diffs');
  const diffPath = path.join(dir, `pr-${n}-changes.diff`);
  const zipPath = path.join(dir, `pr-${n}-diff.zip`);

  if (!fs.existsSync(diffPath)) {
    const note = `bundle: MISSING at ${diffPath} (bound task worktree) — NOT evidence of delivery`;
    return fail(REVIEW_EVIDENCE_CODES.BUNDLE_MISSING, diffPath, { value: { note }, note });
  }
  let size = 0;
  let content = '';
  try {
    size = fs.statSync(diffPath).size;
    content = fs.readFileSync(diffPath, 'utf8');
  } catch (e) {
    const note = `bundle: UNREADABLE at ${diffPath} (${String(e.message || e)}) — NOT evidence of delivery`;
    return fail(REVIEW_EVIDENCE_CODES.BUNDLE_EMPTY, String(e.message || e), { value: { diffPath, note }, note });
  }
  if (!size || !content.trim()) {
    const note = `bundle: EMPTY at ${diffPath} (0 usable bytes) — NOT evidence of delivery`;
    return fail(REVIEW_EVIDENCE_CODES.BUNDLE_EMPTY, diffPath, { value: { diffPath, diffSize: size, note }, note });
  }

  const info = { diffPath, diffSize: size };
  if (fs.existsSync(zipPath)) {
    info.zipPath = zipPath;
    info.zipSize = fs.statSync(zipPath).size;
  }

  if (typeof prDiff !== 'string' || !prDiff.trim()) {
    info.note = `bundle: present at ${diffPath} (${size} bytes) but the reviewed changeset was not computed — UNVERIFIED`;
    return fail(REVIEW_EVIDENCE_CODES.BUNDLE_STALE, 'no changeset to verify against',
      { value: info, note: info.note });
  }

  const changesetBytes = Buffer.byteLength(prDiff, 'utf8');
  const bundleSha = sha256(content);
  const changesetSha = sha256(prDiff);
  if (bundleSha !== changesetSha) {
    info.note = `STALE BUNDLE: ${diffPath} is ${size} bytes (sha256 ${bundleSha.slice(0, 16)}…) `
      + `but the changeset under review is ${changesetBytes} bytes (sha256 ${changesetSha.slice(0, 16)}…). `
      + 'The bundle does NOT correspond to the reviewed base/head and must be re-exported from that HEAD.';
    info.stale = true;
    info.bundleSha256 = bundleSha;
    info.changesetBytes = changesetBytes;
    info.changesetSha256 = changesetSha;
    return fail(REVIEW_EVIDENCE_CODES.BUNDLE_STALE, info.note, { value: info, note: info.note });
  }

  info.note = `bundle VERIFIED against the reviewed changeset: ${size} bytes, sha256 ${bundleSha}`;
  info.stale = false;
  info.bundleSha256 = bundleSha;
  return ok(info, { note: info.note });
}

export { sha256 as reviewEvidenceSha256 };
