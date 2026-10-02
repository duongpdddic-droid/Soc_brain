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
import { TEST_CMD, readTestRunRecords, testRunsPathFor, TEST_RUN_CODES, testRunOutputDigest } from '../executor-launcher/test-run-evidence.mjs';

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

// The control plane's OWN gate evidence (F4(1)): re-read the raw log the
// active runner persisted and re-hash it. The digest is the binding — a log
// that is absent, unreadable, or no longer hashing to the recorded
// outputDigest is reported as such, never trusted and never skipped.
function readActiveRawLog(r) {
  const p = r && typeof r.rawLogPath === 'string' && r.rawLogPath ? r.rawLogPath : null;
  if (!p) return { ok: false, code: 'LOG_UNREADABLE', reason: 'the run carries no rawLogPath' };
  let buf;
  try {
    buf = fs.readFileSync(p);
  } catch (e) {
    return { ok: false, code: 'LOG_UNREADABLE', reason: `${p}: ${String((e && e.message) || e)}` };
  }
  const digest = crypto.createHash('sha256').update(buf).digest('hex');
  if (typeof r.outputDigest !== 'string' || digest !== r.outputDigest) {
    return {
      ok: false,
      code: 'LOG_DIGEST_MISMATCH',
      reason: `${p} hashes to ${digest.slice(0, 12)}… but the run records ${String(r.outputDigest).slice(0, 12)}…`,
    };
  }
  return { ok: true, out: buf.toString('utf8'), bytes: buf.length };
}

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
  // wrote while the command ran: a `before` snapshot taken at that call's START
  // boundary, an `after` snapshot at its END, both keyed by one unique runId.
  //
  // The old shape kept ONE rolling snapshot shared by every command, so a run
  // could be bracketed by content captured before or after it. Now each run is
  // judged on its own:
  //   * boundary != OBSERVED_START          -> UNVERIFIED (never invent `before`)
  //   * binding  != PROVEN / no exit code   -> UNVERIFIED
  //   * before != after                     -> CHANGED_DURING_TEST (stale)
  //   * after  != live                      -> STALE (edited after the run)
  // A required test with no admissible run FAILS the whole gate, so a PASS of
  // another test can never mask it. `headSha` stays provenance only: the gate
  // compares content, not labels.
  const runsPath = record.testRunsPath
    || testRunsPathFor({ eventsPath: record.eventsPath, identityHash: record.identityHash });
  const runs = readTestRunRecords(runsPath);
  if (!runs.length) {
    return fail(REVIEW_EVIDENCE_CODES.TEST_RUN_UNVERIFIED,
      `no canonical TestRunRecord at ${runsPath || '(unresolvable)'}`,
      { value: missing('no control-plane before/after content snapshot brackets the test command (TestRunRecord absent)') });
  }
  // Store integrity: a record from another identity/worktree is never evidence
  // for THIS review — hard refusal before any per-run judgement.
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
  }

  if (!record.eventsPath || !fs.existsSync(record.eventsPath)) {
    return fail(REVIEW_EVIDENCE_CODES.TEST_LOG_EMPTY, 'eventsPath missing',
      { value: missing('the ExecutionRecord carries no readable events log') });
  }

  // Parse the executor's own tool outputs (events.jsonl stores them as JSON
  // strings, so line-parse rather than regex the raw file). The tool callID is
  // kept: it is the ONLY key that ties an output block to the run that
  // produced it.
  const blocks = [];
  try {
    const lines = fs.readFileSync(record.eventsPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const part = o?.event?.part;
      const st = part?.state;
      const cmd = st?.input?.command;
      const out = st?.output ?? st?.metadata?.output;
      if (typeof cmd !== 'string' || typeof out !== 'string') continue;
      if (!TEST_CMD.test(cmd)) continue;
      if (!out.includes('Exit code:')) continue;
      const callID = (part && typeof part.callID === 'string' && part.callID.trim())
        ? part.callID.trim() : null;
      blocks.push({ callID, cmd, cmdDigest: sha256(cmd), out, outputDigest: testRunOutputDigest(out) });
    }
  } catch (e) {
    return fail(REVIEW_EVIDENCE_CODES.TEST_LOG_EMPTY, String(e.message || e),
      { value: missing(`events log unreadable: ${String(e.message || e)}`) });
  }
  if (!blocks.length) {
    return fail(REVIEW_EVIDENCE_CODES.TEST_LOG_EMPTY, 'no `node --test` / `git diff --check` output with an exit code',
      { value: missing('the executor events log holds no offline test output with an exit code') });
  }

  // ---- control-plane ACTIVE gate runs (Issue #263 F4(1)) --------------------
  // The control plane now runs the test gate itself at VERIFY, so admissible
  // evidence no longer depends on a runtime start boundary the executor never
  // emits. Each such run carries a raw-log path; the bytes are re-read and
  // re-hashed HERE, so a swapped or truncated log is UNVERIFIED instead of
  // quietly believed.
  const activeLogs = new Map();
  for (const r of runs) {
    if (!r || r.runSource !== 'control-plane-active') continue;
    activeLogs.set(r, readActiveRawLog(r));
  }
  const hasActive = activeLogs.size > 0;

  // ---- per-run classification against the LIVE content --------------------
  // Judged PER RUN, never by the newest record in the file and never by fs
  // mtime: a run is admissible only if it observed its own start boundary,
  // kept an unchanged content state throughout, ended on the content under
  // review, and carried a parseable exit code. A control-plane run is judged
  // only after its raw log has been proven byte-for-byte.
  const classifyRun = (r) => {
    if (!r || typeof r !== 'object') return 'UNPROVEN';
    if (r.runSource === 'control-plane-active') {
      const a = activeLogs.get(r);
      if (!a || !a.ok) return (a && a.code) || 'LOG_UNREADABLE';
    }
    if (r.boundary !== 'OBSERVED_START') return 'NO_BOUNDARY';
    if (r.binding !== 'PROVEN') return 'UNPROVEN';
    const beforeD = r.before && typeof r.before.contentDigest === 'string' ? r.before.contentDigest : '';
    const afterD = r.after && typeof r.after.contentDigest === 'string' ? r.after.contentDigest : '';
    if (!HEX64.test(beforeD) || !HEX64.test(afterD)) return 'UNPROVEN';
    if (beforeD !== afterD) return 'CHANGED_DURING_TEST';         // (a)
    if (r.exitCode === null || !Number.isInteger(r.exitCode)) return 'NO_EXIT_CODE';
    if (afterD !== live.value.contentDigest) return 'STALE';      // (b)
    return 'VALID';
  };

  const runIndex = new Map(runs.map((r, i) => [r, i]));
  // Ordering by recorded timestamps and then by file order. fs mtime is never
  // consulted — the run store, not the filesystem, is the authority.
  const cmpRun = (a, b) => {
    const ta = Date.parse((a && (a.finishedAt || a.capturedAt)) || '') || 0;
    const tb = Date.parse((b && (b.finishedAt || b.capturedAt)) || '') || 0;
    if (ta !== tb) return ta - tb;
    return (runIndex.get(a) ?? 0) - (runIndex.get(b) ?? 0);
  };
  // NEWEST FIRST — the timeline rule (Issue #263 F4(2)): the newest run of a
  // test target decides its verdict BEFORE any validity filtering, so an older
  // PASS can never stand in for a newer FAIL/UNVERIFIED run of that target.
  const newestFirst = (group) => group.slice().sort((a, b) => cmpRun(b, a));

  // Usable runs, indexed ONLY by the pairing identity: toolCallId + output
  // digest. The command string is never the pairing key, so two runs of the
  // same command can never be interchanged — only the run whose produced
  // bytes match this block can vouch for it.
  const usable = new Map();
  for (const r of runs) {
    if (classifyRun(r) !== 'VALID') continue;
    if (typeof r.toolCallId !== 'string' || !r.toolCallId) continue;
    if (typeof r.outputDigest !== 'string' || !HEX64.test(r.outputDigest)) continue;
    const key = `${r.toolCallId}\0${r.outputDigest}`;
    const prev = usable.get(key);
    if (!prev || cmpRun(r, prev) > 0) usable.set(key, r);
  }

  const labelOf = (digest, run) => (run && typeof run.command === 'string' && run.command)
    || ((blocks.find((b) => b.cmdDigest === digest) || {}).cmd)
    || `${String(digest).slice(0, 12)}…`;

  // ---- required test targets ------------------------------------------------
  // With an active control-plane gate the HARD requirements are: every
  // control-plane run, every target the control plane ever recorded a run for,
  // and — when no active run exists — every claimed/recorded command (legacy).
  // An executor-claimed command the control plane has NO TestRunRecord for at
  // all is never dropped from the report: it is surfaced in ATTENTION as an
  // unverified claim, so nothing is hidden and no PASS is manufactured for it.
  //
  // FAIL-CLOSED (Issue #263 review round): a target whose recorded run is not
  // admissible (e.g. it never observed a start boundary => UNVERIFIED) is
  // REQUIRED, not a soft caveat. Adding it here routes it through failForNewest,
  // so ok:false stands on its own — a PASS on target A can never mask a
  // FAIL/UNVERIFIED on target B. Only claims with zero runs stay caveats.
  const required = [];
  const requiredSeen = new Set();
  const addReq = (d) => { if (d && !requiredSeen.has(d)) { requiredSeen.add(d); required.push(d); } };
  for (const r of runs) if (r.runSource === 'control-plane-active') addReq(r.commandDigest);
  for (const r of runs) if (classifyRun(r) === 'VALID') addReq(r.commandDigest);
  for (const r of runs) addReq(r.commandDigest); // any recorded run => its NEWEST class decides (FAIL/UNVERIFIED blocks)
  if (!hasActive) {
    for (const b of blocks) addReq(b.cmdDigest);
    for (const r of runs) addReq(r.commandDigest);
  }

  const claimCaveats = [];
  if (hasActive) {
    const seen = new Set();
    // Only reached for digests with NO run record at all (every digested run is
    // required above), so a caveated claim is genuinely "never bracketed".
    const consider = (digest, fallbackLabel) => {
      if (!digest || requiredSeen.has(digest) || seen.has(digest)) return;
      seen.add(digest);
      const group = newestFirst(runs.filter((r) => r && r.commandDigest === digest));
      const label = labelOf(digest, group[0]) || fallbackLabel;
      const why = group.length
        ? `newest run is ${classifyRun(group[0])}`
        : 'no canonical TestRunRecord';
      claimCaveats.push(`"${label}" (${why})`);
    };
    for (const b of blocks) consider(b.cmdDigest, b.cmd);
    for (const r of runs) consider(r.commandDigest, null);
  }

  // The newest run of a target decides — one verdict per target, never a scan
  // that lets an older run override a newer one.
  const failForNewest = (newest, cls, group, digest) => {
    const label = labelOf(digest, newest);
    if (cls === 'CHANGED_DURING_TEST') {
      const detail = `content changed DURING the test command: ${label}`;
      return fail(REVIEW_EVIDENCE_CODES.TEST_RUN_CHANGED_DURING_TEST, detail,
        { value: missing(`${detail} (before ${String(newest.before.contentDigest).slice(0, 12)}… -> after ${String(newest.after.contentDigest).slice(0, 12)}…)`) });
    }
    if (cls === 'STALE') {
      const detail = `no recorded run of "${label}" executed against the content now under review`;
      return fail(REVIEW_EVIDENCE_CODES.TEST_RUN_STALE, detail,
        { value: missing(`${detail} (the NEWEST run of this target is stale; recorded after-digests ${group.map((r) => String(r.after && r.after.contentDigest).slice(0, 12)).join(', ')}; live is ${live.value.contentDigest.slice(0, 12)})`) });
    }
    if (cls === 'NO_BOUNDARY' || cls === 'UNPROVEN' || cls === 'NO_EXIT_CODE') {
      const why = cls === 'NO_BOUNDARY'
        ? `the NEWEST run of "${label}" never observed a start boundary (boundary=UNOBSERVED_START) or lacks a proven before/after snapshot — UNVERIFIED, never PASS`
        : `the NEWEST run of "${label}" is ${cls} — UNVERIFIED, never PASS`;
      return fail(REVIEW_EVIDENCE_CODES.TEST_RUN_UNVERIFIED,
        `no admissible run of a required test: ${label}`, { value: missing(why) });
    }
    const reason = cls === 'LOG_DIGEST_MISMATCH'
      ? 'its raw log no longer hashes to the recorded outputDigest'
      : 'its raw log is absent or unreadable';
    return fail(REVIEW_EVIDENCE_CODES.TEST_RUN_UNVERIFIED,
      `no admissible run of a required test: ${label}`,
      { value: missing(`the NEWEST run of "${label}" is UNVERIFIED because ${reason} (${cls}) — never PASS`) });
  };

  const selected = [];
  for (const digest of required) {
    const group = newestFirst(runs.filter((r) => r && r.commandDigest === digest));
    if (!group.length) {
      const fromBlock = blocks.find((b) => b.cmdDigest === digest);
      const label = labelOf(digest, null);
      if (!fromBlock) {
        return fail(REVIEW_EVIDENCE_CODES.TEST_RUN_UNVERIFIED,
          `required test has no canonical TestRunRecord: ${label}`,
          { value: missing(`no runId/outputDigest pairing exists for required test "${label}"`) });
      }
      return fail(REVIEW_EVIDENCE_CODES.TEST_RUN_UNVERIFIED,
        `required test has log output but no canonical TestRunRecord: ${label}`,
        { value: missing(`no runId/outputDigest pairing brackets this output — required test "${label}" has no before/after snapshot`) });
    }
    const newest = group[0];
    const cls = classifyRun(newest);
    if (cls !== 'VALID') return failForNewest(newest, cls, group, digest);

    // The newest run is admissible: resolve the RAW OUTPUT it vouches for.
    // Control-plane runs read their own raw log; executor runs pair with the
    // events block through toolCallId + outputDigest only.
    let out = null;
    if (newest.runSource === 'control-plane-active') {
      const a = activeLogs.get(newest);
      out = a && a.ok ? a.out : null;
    } else {
      const b = blocks.find((bb) => bb.cmdDigest === digest
        && bb.callID && bb.callID === newest.toolCallId
        && bb.outputDigest === newest.outputDigest);
      out = b ? b.out : null;
    }
    if (typeof out !== 'string') {
      return fail(REVIEW_EVIDENCE_CODES.TEST_RUN_UNVERIFIED,
        `no admissible run of a required test: ${labelOf(digest, newest)}`,
        { value: missing(`the NEWEST admissible run of "${labelOf(digest, newest)}" has no readable raw output — UNVERIFIED, never PASS`) });
    }
    selected.push({
      block: {
        callID: newest.toolCallId,
        cmd: newest.command,
        cmdDigest: digest,
        out,
        outputDigest: newest.outputDigest,
      },
      run: newest,
    });
  }
  const selectedRuns = selected.map((p) => p.run);
  const usableCount = usable.size;

  const head = [
    '[EXECUTION EVIDENCE — bound to this review]',
    `identityHash: ${record.identityHash ?? 'unknown'}`,
    `taskId: ${record.taskId ?? 'unknown'}`,
    `worktreePath: ${record.worktreePath ?? 'unknown'}`,
    `baseSha: ${record.baseSha ?? 'unknown'}`,
    `headSha: ${record.headSha ?? '(not recorded by this executor run)'}  | reviewed headSha: ${session.headSha ?? 'unknown'}  | headShaBinding: ${headShaBinding}`,
    `codeContentDigest: ${record.codeContentDigest}  | fileCount: ${record.codeContentFiles ?? 'unknown'}  | liveDigest: ${live.value.contentDigest} (content: MATCH — verified byte-for-byte against this worktree)`,
    `testRunBinding: ${selected.length}/${required.length} required test command(s) each paired to ONE canonical TestRunRecord `
      + `| ${usableCount}/${runs.length} recorded run(s) admissible | testedDigest: ${live.value.contentDigest} | store: ${runsPath}`,
    `activeTestGate: ${activeLogs.size
      ? [...activeLogs.entries()].map(([r, a]) =>
        `${r.runId}=${r.result} exit=${r.exitCode} rawLog=${r.rawLogPath} logVerified=${a.ok ? 'SHA256_MATCH' : a.code}`).join('  |  ')
      : 'none (no control-plane active gate run recorded for this identity)'}`,
    `selectedRuns: ${selectedRuns.map((r) => `${r.runId}=${r.result}@${String(r.after && r.after.contentDigest).slice(0, 12)}`).join('  |  ')}`,
    ...(claimCaveats.length
      ? [`unverifiedClaims: ${claimCaveats.length} executor-claimed test command(s) the control plane could NOT bracket — reported below, never counted as gate evidence`]
      : []),
    `headShaBinding is provenance ONLY — the test binding above is content, so a content-neutral commit needs no re-run.`,
    `executorProcessExitCode: ${record.exitCode}  terminalStatus: ${record.terminalStatus}  signal: ${record.signal ?? 'none'}`,
    `startedAt: ${record.startedAt ?? 'unknown'}  finishedAt: ${record.finishedAt ?? 'unknown'}`,
    `executionRecordPath: ${ev.executionRecordPath}`,
    `rawSource: ${record.eventsPath}`,
    '',
  ].join('\n');

  const body = selected.map((p, i) =>
    `--- raw output ${i + 1}/${selected.length}: ${p.block.cmd.trim()}\n${p.block.out.trimEnd()}\n`).join('\n');
  const failsSeen = selected.filter((p) =>
    (p.run.exitCode !== null && Number(p.run.exitCode) !== 0)
    || /# fail [1-9]/.test(p.block.out) || /Exit code: [1-9]/.test(p.block.out));
  const recordFailed = Number(record.exitCode) !== 0;
  const failures = [];
  if (recordFailed) failures.push(`the executor process itself exited with code ${record.exitCode} (terminalStatus ${record.terminalStatus})`);
  if (failsSeen.length) failures.push(`${failsSeen.length} of ${selected.length} captured commands report a NON-ZERO result`);
  // Nothing is ever dropped silently: an executor-claimed command the control
  // plane could not bracket is named here instead of being counted as evidence.
  const caveats = claimCaveats.length
    ? [`${claimCaveats.length} executor-claimed test command(s) are UNVERIFIED and are NOT gate evidence: ${claimCaveats.join('; ')}`]
    : [];
  const attention = [...failures, ...caveats];

  const value = `${head}${body}\n`
    + (attention.length
      ? `ATTENTION: ${attention.join('; ')}.`
      : `All ${selected.length} captured commands report fail=0 / Exit code: 0.`);

  return ok(value, {
    blocks: selected.length,
    hasFailures: attention.length > 0,
    nonZeroResults: failures.length > 0,
    unverifiedClaims: caveats.length,
    activeRuns: activeLogs.size,
    record,
  });
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
