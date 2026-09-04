#!/usr/bin/env node
// soc-score.test.mjs — tests for packages/soc-score (Issue #45, Soc_Score v0).
// No framework. Exit 0 = PASS, 1 = FAIL. Uses disposable temp directories
// (same convention as execution-broker.test.mjs / runtime-sandbox.test.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  createRecorder, computeSummary,
  telemetryDirFor, eventsPathFor, summaryPathFor,
  MINIMUM_EVENTS, SOC_SCORE_SCHEMA_VERSION,
} from '../packages/soc-score/soc-score.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });
const deepEq = (n, g, w) => checks.push({ name: n, ok: JSON.stringify(g) === JSON.stringify(w), got: g, want: w });

const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-score-'));
const TEMPS = [TMP];
function makeStateDir() {
  const d = mkdtempSync(path.join(TMP, 'state-'));
  TEMPS.push(d);
  return d;
}

// Deterministic clock: returns the next value from `steps` on each call.
function makeClock(steps) {
  let i = 0;
  return () => {
    const v = steps[Math.min(i, steps.length - 1)];
    i++;
    return v;
  };
}

const baseIdentity = () => ({
  identityHash: 'abc123',
  taskId: 'task-1',
  repo: 'duongpdddic-droid/Soc_brain',
  issueNumber: 45,
});

// ---- 1. constants ------------------------------------------------------------
eq('SOC_SCORE_SCHEMA_VERSION is "1"', SOC_SCORE_SCHEMA_VERSION, '1');
tru('MINIMUM_EVENTS has 13 entries', MINIMUM_EVENTS.length === 13);
tru('MINIMUM_EVENTS includes TASK_STARTED', MINIMUM_EVENTS.includes('TASK_STARTED'));
tru('MINIMUM_EVENTS includes TASK_FINISHED', MINIMUM_EVENTS.includes('TASK_FINISHED'));
tru('MINIMUM_EVENTS includes WORKTREE_READY', MINIMUM_EVENTS.includes('WORKTREE_READY'));
tru('MINIMUM_EVENTS includes HUMAN_GATE_RESOLVED', MINIMUM_EVENTS.includes('HUMAN_GATE_RESOLVED'));
// ---- 2. path helpers are pure & deterministic -------------------------------
{
  const sd = makeStateDir();
  eq('telemetryDirFor is sibling of sessions/',
     telemetryDirFor({ stateDir: sd }).endsWith(`${path.sep}telemetry`),
     true);
  const id = baseIdentity();
  eq('eventsPathFor deterministic',
     eventsPathFor({ stateDir: sd, identityHash: id.identityHash }),
     eventsPathFor({ stateDir: sd, identityHash: id.identityHash }));
  const sp = summaryPathFor({ stateDir: sd, identityHash: id.identityHash });
  tru('summaryPathFor ends with .summary.json', sp.endsWith('.summary.json'));
}

// ---- 3. identity validation rejects bad inputs ------------------------------
{
  const sd = makeStateDir();
  falsy('missing identityHash -> ok=false',
    createRecorder({ stateDir: sd, identity: { ...baseIdentity(), identityHash: '' } }).ok);
  falsy('missing taskId -> ok=false',
    createRecorder({ stateDir: sd, identity: { ...baseIdentity(), taskId: '' } }).ok);
  falsy('missing repo -> ok=false',
    createRecorder({ stateDir: sd, identity: { ...baseIdentity(), repo: '' } }).ok);
  falsy('non-int issueNumber -> ok=false',
    createRecorder({ stateDir: sd, identity: { ...baseIdentity(), issueNumber: 1.5 } }).ok);
  falsy('missing executor -> ok=false',
    createRecorder({ stateDir: sd, identity: { ...baseIdentity(), executor: '' } }).ok);
}
// ---- 4. JSONL append + schema (deterministic clock) -------------------------
{
  const sd = makeStateDir();
  // Monotonic clock: 1000, 1050, ... (50ms per call) — predictable durations.
  const clock = makeClock(Array.from({ length: 64 }, (_, i) => 1000 + i * 50));
  const rec = createRecorder({
    stateDir: sd, identity: baseIdentity(), executor: 'cline', clock,
  });
  tru('recorder ok', rec.ok);
  const e1 = rec.record('TASK_STARTED', { baseSha: 'deadbeef'.repeat(5) });
  eq('first record ok', e1.ok, true);
  tru('first line has schemaVersion',
    e1.line.schemaVersion === SOC_SCORE_SCHEMA_VERSION);
  eq('first line identityHash', e1.line.identityHash, 'abc123');
  eq('first line taskId', e1.line.taskId, 'task-1');
  eq('first line repo', e1.line.repo, 'duongpdddic-droid/Soc_brain');
  eq('first line issueNumber', e1.line.issueNumber, 45);
  eq('first line executor', e1.line.executor, 'cline');
  eq('first line event', e1.line.event, 'TASK_STARTED');
  eq('first line t (clock=1000)', e1.line.t, 1000);
  eq('first line detail', e1.line.detail.baseSha, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');

  rec.record('WORKTREE_READY');
  rec.record('EXECUTOR_STARTED');
  rec.record('EXECUTOR_FINISHED');
  rec.record('VERIFY_STARTED');
  rec.record('VERIFY_FINISHED');
  rec.record('REVIEW_STARTED');
  rec.record('REVIEW_FINISHED');
  rec.record('GITHUB_STARTED');
  rec.record('GITHUB_FINISHED');
  rec.record('HUMAN_GATE_STARTED');
  rec.record('HUMAN_GATE_RESOLVED');
  rec.record('TASK_FINISHED');

  // JSONL file exists, is append-only line-delimited.
  const jsonl = fs.readFileSync(rec.eventsPath, 'utf8');
  const lines = jsonl.split('\n').filter(Boolean);
  eq('JSONL has one line per event', lines.length, 13);
  const parsed = lines.map((l) => JSON.parse(l));
  eq('JSONL line 1 event', parsed[0].event, 'TASK_STARTED');
  eq('JSONL last event', parsed[parsed.length - 1].event, 'TASK_FINISHED');
  // Sorted by t (monotonic clock): the timestamps should be strictly increasing.
  let mono = true;
  for (let i = 1; i < parsed.length; i++) if (parsed[i].t <= parsed[i - 1].t) mono = false;
  tru('JSONL t is strictly increasing', mono);
}
// ---- 5. derived durations match the deterministic clock ---------------------
{
  const sd = makeStateDir();
  // Carefully placed timestamps so each known phase = 100ms.
  const steps = [
    0,       // TASK_STARTED
    100,     // WORKTREE_READY
    200,     // EXECUTOR_STARTED
    300,     // EXECUTOR_FINISHED  -> executorTime = 100
    400,     // VERIFY_STARTED
    500,     // VERIFY_FINISHED    -> verificationTime = 100
    600,     // REVIEW_STARTED
    700,     // REVIEW_FINISHED    -> reviewTime = 100
    800,     // GITHUB_STARTED
    900,     // GITHUB_FINISHED    -> githubTime = 100
    1000,    // HUMAN_GATE_STARTED
    1100,    // HUMAN_GATE_RESOLVED -> humanWaitTime = 100
    1200,    // TASK_FINISHED
  ];
  // Pad extras so makeClock never runs out.
  while (steps.length < 64) steps.push(steps[steps.length - 1]);
  const clock = makeClock(steps);
  const rec = createRecorder({ stateDir: sd, identity: baseIdentity(), executor: 'opencode', clock });
  rec.record('TASK_STARTED');
  rec.record('WORKTREE_READY');
  rec.record('EXECUTOR_STARTED');
  rec.record('EXECUTOR_FINISHED');
  rec.record('VERIFY_STARTED');
  rec.record('VERIFY_FINISHED');
  rec.record('REVIEW_STARTED');
  rec.record('REVIEW_FINISHED');
  rec.record('GITHUB_STARTED');
  rec.record('GITHUB_FINISHED');
  rec.record('HUMAN_GATE_STARTED');
  rec.record('HUMAN_GATE_RESOLVED');
  rec.record('TASK_FINISHED');

  const fin = rec.finalize();
  eq('finalize ok', fin.ok, true);
  const s = fin.summary;
  eq('schemaVersion', s.schemaVersion, '1');
  eq('identity.identityHash', s.identity.identityHash, 'abc123');
  eq('eventCount', s.eventCount, 13);
  eq('totalWallTime = 1200', s.durations.totalWallTime, 1200);
  eq('worktreeTime = 100', s.durations.worktreeTime, 100);
  eq('executorTime = 100', s.durations.executorTime, 100);
  eq('verificationTime = 100', s.durations.verificationTime, 100);
  eq('reviewTime = 100', s.durations.reviewTime, 100);
  eq('githubTime = 100', s.durations.githubTime, 100);
  eq('humanWaitTime = 100', s.durations.humanWaitTime, 100);
  eq('unattributedTime = 600 (1200 wall - 600 known)', s.durations.unattributedTime, 600);
  // UnattributedTime MUST remain visible (key always present, even when 0).
  tru('summary has unattributedTime key',
    Object.prototype.hasOwnProperty.call(s.durations, 'unattributedTime'));

  // Summary file written + parseable.
  const onDisk = JSON.parse(fs.readFileSync(fin.summaryPath, 'utf8'));
  eq('summary on disk matches', onDisk.durations.totalWallTime, 1200);
}

// ---- 6. unattributedTime is visible & non-negative when phases don't cover --
{
  const sd = makeStateDir();
  // Wall time = 1000; only worktreeTime=100 and executorTime=100 accounted for.
  // Expected unattributedTime = 800.
  const steps = [0, 100, 200, 300, 1000];
  while (steps.length < 64) steps.push(steps[steps.length - 1]);
  const clock = makeClock(steps);
  const rec = createRecorder({ stateDir: sd, identity: baseIdentity(), executor: 'cline', clock });
  rec.record('TASK_STARTED');
  rec.record('WORKTREE_READY');
  rec.record('EXECUTOR_STARTED');
  rec.record('EXECUTOR_FINISHED');
  rec.record('TASK_FINISHED');
  const fin = rec.finalize();
  eq('partial: totalWallTime=1000', fin.summary.durations.totalWallTime, 1000);
  eq('partial: worktreeTime=100', fin.summary.durations.worktreeTime, 100);
  eq('partial: executorTime=100', fin.summary.durations.executorTime, 100);
  eq('partial: verificationTime=0', fin.summary.durations.verificationTime, 0);
  eq('partial: reviewTime=0', fin.summary.durations.reviewTime, 0);
  eq('partial: githubTime=0', fin.summary.durations.githubTime, 0);
  eq('partial: humanWaitTime=0', fin.summary.durations.humanWaitTime, 0);
  eq('partial: unattributedTime=800 (visible, non-negative)',
    fin.summary.durations.unattributedTime, 800);
}
// ---- 7. finalize() is idempotent & cannot append after finalize -------------
{
  const sd = makeStateDir();
  const clock = makeClock(Array.from({ length: 64 }, (_, i) => 1000 + i * 10));
  const rec = createRecorder({ stateDir: sd, identity: baseIdentity(), executor: 'cline', clock });
  rec.record('TASK_STARTED');
  rec.record('TASK_FINISHED');
  const fin1 = rec.finalize();
  eq('first finalize ok', fin1.ok, true);
  const fin2 = rec.finalize();
  eq('second finalize refused', fin2.ok, false);
  eq('second finalize reason', fin2.reason, 'RECORDER_FINALIZED');
  const after = rec.record('EXECUTOR_STARTED');
  eq('record after finalize refused', after.ok, false);
  eq('record after finalize reason', after.reason, 'RECORDER_FINALIZED');
}

// ---- 8. unknown event names are accepted (forward-extensible) ---------------
{
  const sd = makeStateDir();
  const clock = makeClock([0, 1000]);
  const rec = createRecorder({ stateDir: sd, identity: baseIdentity(), executor: 'cline', clock });
  const r = rec.record('FUTURE_PHASE_STARTED');
  eq('unknown event accepted', r.ok, true);
  eq('unknown event round-trips', r.line.event, 'FUTURE_PHASE_STARTED');
}

// ---- 9. withPhase: emits STARTED + FINISHED and re-throws on failure --------
{
  const sd = makeStateDir();
  const clock = makeClock([0, 100, 200, 300, 400, 500, 600]);
  const rec = createRecorder({ stateDir: sd, identity: baseIdentity(), executor: 'cline', clock });
  // happy path
  const ok = await rec.withPhase('EXECUTOR', async () => 'done');
  eq('withPhase happy result', ok, 'done');
  // failure path
  let threw = false;
  try {
    await rec.withPhase('VERIFY', async () => { throw new Error('boom'); });
  } catch (e) {
    threw = true;
    eq('withPhase rethrows original message', e.message, 'boom');
  }
  tru('withPhase rethrown', threw);
  const evs = rec.events().map((e) => e.event);
  deepEq('withPhase emitted both pairs', evs,
    ['EXECUTOR_STARTED', 'EXECUTOR_FINISHED', 'VERIFY_STARTED', 'VERIFY_FINISHED']);
}

// ---- 10. finalize() with no TASK_FINISHED synthesizes one -------------------
{
  const sd = makeStateDir();
  const clock = makeClock([0, 100, 200]);
  const rec = createRecorder({ stateDir: sd, identity: baseIdentity(), executor: 'cline', clock });
  rec.record('TASK_STARTED');
  rec.record('WORKTREE_READY');
  const fin = rec.finalize();
  eq('finalize without TASK_FINISHED still ok', fin.ok, true);
  const evs = rec.events().map((e) => e.event);
  tru('synthetic TASK_FINISHED appended', evs.includes('TASK_FINISHED'));
  eq('synthetic TASK_FINISHED has detail.synthetic=true',
    rec.events().find((e) => e.event === 'TASK_FINISHED').detail.synthetic, true);
}

// ---- 11. computeSummary pure function: out-of-order timestamps ---------------
{
  const events = [
    { event: 'TASK_FINISHED', t: 1000 },
    { event: 'EXECUTOR_FINISHED', t: 300 },
    { event: 'EXECUTOR_STARTED', t: 200 },
    { event: 'WORKTREE_READY', t: 100 },
    { event: 'TASK_STARTED', t: 0 },
  ];
  const s = computeSummary({ events, identity: { identityHash: 'h', taskId: 't', repo: 'o/r', issueNumber: 1 } });
  eq('computeSummary unsorted totalWallTime', s.durations.totalWallTime, 1000);
  eq('computeSummary unsorted executorTime', s.durations.executorTime, 100);
  eq('computeSummary unsorted worktreeTime', s.durations.worktreeTime, 100);
  eq('computeSummary unsorted unattributedTime', s.durations.unattributedTime, 800);
}
// ---- 12. telemetry failure does NOT corrupt the FSM (write fails) -----------
{
  const sd = makeStateDir();
  // Recreate the recorder pointed at an UNWRITABLE file (parent is a file, not a
  // directory). The recorder must catch the throw inside record() and return
  // { ok: false } without propagating to the caller.
  const blocker = path.join(sd, 'blocker');
  fs.writeFileSync(blocker, 'i am a file, not a directory');
  const id = baseIdentity();
  const rec = createRecorder({
    stateDir: blocker,                  // invalid: telemetry dir cannot be created
    identity: id, executor: 'cline',
    clock: makeClock([0, 10, 20, 30, 40, 50]),
  });
  tru('recorder constructed despite broken stateDir', rec.ok === true);
  const r = rec.record('TASK_STARTED');
  eq('record fails closed (no throw)', r.ok, false);
  eq('record reason', r.reason, 'TELEMETRY_WRITE_FAILED');
  // Caller continues — second record still returns ok=false (no throw).
  let threw = false;
  try { rec.record('WORKTREE_READY'); } catch { threw = true; }
  falsy('record never throws into caller', threw);
  tru('lastError captured', rec.lastError && rec.lastError.reason === 'TELEMETRY_WRITE_FAILED');
  // finalize() still returns a usable summary (computed in-memory; only the
  // summary file write fails). The caller must still see a result, not throw.
  rec.record('EXECUTOR_STARTED');
  rec.record('EXECUTOR_FINISHED');
  rec.record('TASK_FINISHED');
  let finThrew = false;
  let finResult;
  try { finResult = rec.finalize(); } catch { finThrew = true; }
  falsy('finalize never throws into caller', finThrew);
  tru('finalize returns a result object', finResult && typeof finResult === 'object');
  // FSM-isolation invariant: when every write fails, the in-memory mirror is
  // empty so durations are zero — but the API still returns a usable result
  // and never throws. unattributedTime MUST stay non-negative.
  if (finResult && finResult.summary) {
    eq('FSM-isolated: totalWallTime non-negative', finResult.summary.durations.totalWallTime >= 0, true);
    eq('FSM-isolated: unattributedTime non-negative', finResult.summary.durations.unattributedTime >= 0, true);
  }
}

// ---- cleanup -----------------------------------------------------------------
for (const p of TEMPS) { try { rmSync(p, { recursive: true, force: true }); } catch {} }

// ---- summary -----------------------------------------------------------------
let failed = 0;
for (const c of checks) {
  if (!c.ok) { failed++; console.error(`FAIL ${c.name} got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`); }
}
console.log(`soc-score: ${checks.length - failed}/${checks.length} passed`);
process.exit(failed === 0 ? 0 : 1);