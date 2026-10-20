// tests/test-run-evidence.test.mjs — Issue #263 reviewer finding 4 (definitive).
//
// The PRODUCER side of the test binding: the control plane must bracket every
// test command with a content snapshot taken immediately before and
// immediately after it, persist it outside the worktree, and never accept a
// snapshot it could not prove. These are the regressions that stop the
// executor-exit stamp from being used as the test binding.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { safeTempBase } from '../packages/temp-hygiene/temp-hygiene.mjs';

import {
  createTestRunRecorder, readTestRunRecords, testRunsPathFor, isTestCommand, parseExitCode,
  createActiveTestRunner, resolveTestGateCommand, activeTestRunLogDir, ACTIVE_TEST_GATE_CODES,
  verifyActiveRunPlanBinding,
} from '../packages/executor-launcher/test-run-evidence.mjs';
import {
  buildTestPlan, recomputePlanDigest, computePlanContentBinding, TEST_PLAN_CODES,
} from '../packages/executor-launcher/test-plan.mjs';
import {
  computeWorktreeContentBinding, createContentTracker,
} from '../packages/executor-launcher/execution-content-binding.mjs';
import crypto from 'node:crypto';

const IDENTITY = 'e'.repeat(40);
const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }).trim();
}

function mkWorktree() {
  const dir = fs.mkdtempSync(path.join(safeTempBase(), 'tre-'));
  git(dir, ['init']);
  fs.writeFileSync(path.join(dir, 'tracked.md'), 'v1\n', 'utf8');
  git(dir, ['add', 'tracked.md']);
  git(dir, ['-c', 'user.email=tre@test', '-c', 'user.name=tre', 'commit', '-m', 'head']);
  return dir;
}

// A tool event as the runtime really emits it: `part.callID` plus
// `part.state.status`. `status`/`callID` are settable so a test can drive the
// START boundary (`running`) and the END boundary (`completed`) separately.
const toolEvent = (tool, command = null, output = null, { status = 'completed', callID = null } = {}) => ({
  kind: 'tool',
  tool,
  event: {
    part: {
      ...(callID ? { callID } : {}),
      state: {
        ...(command ? { input: { command } } : {}),
        ...(output !== null ? { output } : {}),
        status,
      },
    },
  },
});
const textEvent = { kind: 'text', event: { type: 'text', part: { text: 'hi' } } };

function digestOf(dir) {
  const r = computeWorktreeContentBinding({ worktreePath: dir });
  assert.equal(r.ok, true, String(r.reason));
  return r.value.contentDigest;
}

test('the recorder brackets ONE run with ITS OWN before/after snapshot — no shared rolling state', () => {
  const wt = mkWorktree();
  const runsPath = path.join(safeTempBase(), `tre-${Date.now()}.testruns.jsonl`);
  const rec = createTestRunRecorder({
    worktreePath: wt, identityHash: IDENTITY, taskId: 't#1', repo: 'o/r', issueNumber: 1, path: runsPath,
  });

  const d0 = digestOf(wt);
  // Non-content events must not move the tracked-content state.
  rec.observe(textEvent);
  rec.observe(toolEvent('read', null, null, { callID: 'c-read' }));
  rec.observe(toolEvent('glob', null, null, { callID: 'c-glob' }));
  assert.equal(rec.snapshot().contentDigest, d0, 'read-only tools leave the content state where it was');

  // A content-capable tool event is seen, so the next snapshot reflects it.
  fs.writeFileSync(path.join(wt, 'tracked.md'), 'v2\n', 'utf8');
  rec.observe(toolEvent('edit', null, null, { callID: 'c-edit' }));
  const d1 = digestOf(wt);
  assert.equal(rec.snapshot().contentDigest, d1, 'the edit is visible before any test runs');

  // START boundary of THIS call captures ITS `before` — d1, not d0 and not a
  // value shared with any other call.
  const CMD = 'node --test tests/x.test.mjs';
  const OUT = 'TAP version 13\n# pass 1\nExit code: 0\n';
  rec.observe(toolEvent('bash', CMD, null, { status: 'running', callID: 'call-1' }));
  // ... then the content moves AGAIN before the run reports its output: only
  // the per-call `before` can freeze the starting state for call-1.
  fs.writeFileSync(path.join(wt, 'tracked.md'), 'v3 - while the suite ran\n', 'utf8');
  const d2 = digestOf(wt);
  rec.observe(toolEvent('bash', CMD, OUT, { callID: 'call-1' }));

  const runs = readTestRunRecords(runsPath);
  assert.equal(runs.length, 1, 'exactly one TestRunRecord per tool call');
  const r = runs[0];
  assert.equal(r.kind, 'TestRunRecord');
  assert.equal(r.runId, 'call-1', 'the runId IS the tool call id, so start and end cannot cross over');
  assert.equal(r.toolCallId, 'call-1');
  assert.equal(r.boundary, 'OBSERVED_START');
  assert.equal(r.identityHash, IDENTITY);
  assert.equal(r.worktreePath, wt);
  assert.equal(r.command, CMD);
  assert.equal(r.commandDigest, sha256(CMD));
  assert.equal(r.outputDigest, sha256(OUT), 'the output digest is what pairs this run to its log block');
  assert.equal(r.exitCode, 0);
  assert.equal(r.result, 'PASS');
  assert.equal(r.before.contentDigest, d1, 'before == the content at THIS call\'s start boundary');
  assert.equal(r.after.contentDigest, d2, 'after == the content at THIS call\'s end boundary');
  assert.notEqual(r.before.contentDigest, r.after.contentDigest, 'the in-run mutation stays visible');
  assert.equal(r.binding, 'PROVEN');
  assert.equal(r.capturedBy, 'executor-launcher/attachPassthrough');
  assert.ok(typeof r.startedAt === 'string' && typeof r.finishedAt === 'string');

  // Byte-identical to the reviewer's one-shot recomputation — otherwise no
  // `after` snapshot could ever match the live worktree.
  assert.equal(r.after.contentDigest, computeWorktreeContentBinding({ worktreePath: wt }).value.contentDigest);
});

test('content mutated while the command runs is visible as before != after', () => {
  const wt = mkWorktree();
  const runsPath = path.join(safeTempBase(), `tre-mid-${Date.now()}.testruns.jsonl`);
  const rec = createTestRunRecorder({ worktreePath: wt, identityHash: IDENTITY, path: runsPath });
  const before = digestOf(wt);
  rec.observe(toolEvent('bash', 'npm test', null, { status: 'pending', callID: 'call-mid' }));
  fs.writeFileSync(path.join(wt, 'tracked.md'), 'mutated while the suite ran\n', 'utf8');
  rec.observe(toolEvent('bash', 'npm test', 'Exit code: 0\n', { callID: 'call-mid' }));
  const [r] = readTestRunRecords(runsPath);
  assert.equal(r.boundary, 'OBSERVED_START');
  assert.equal(r.before.contentDigest, before);
  assert.notEqual(r.after.contentDigest, before, 'the in-run mutation must be visible to the reader');
  assert.equal(r.binding, 'PROVEN', 'both snapshots were taken by the control plane');
});

test('a snapshot the control plane could not prove is recorded UNPROVEN, never as a digest', () => {
  const wt = mkWorktree();
  const runsPath = path.join(safeTempBase(), `tre-unproven-${Date.now()}.testruns.jsonl`);
  const brokenTracker = {
    markIndexStale() {},
    headSha: null,
    snapshot: () => ({ ok: false, reason: 'worktree unavailable' }),
  };
  const rec = createTestRunRecorder({ worktreePath: wt, identityHash: IDENTITY, path: runsPath, tracker: brokenTracker });
  rec.observe(toolEvent('bash', 'git diff --check', null, { status: 'running', callID: 'call-broken' }));
  rec.observe(toolEvent('bash', 'git diff --check', 'Exit code: 0\n', { callID: 'call-broken' }));
  const [r] = readTestRunRecords(runsPath);
  assert.equal(r.boundary, 'OBSERVED_START');
  assert.equal(r.binding, 'UNPROVEN');
  assert.equal(r.before, null);
  assert.equal(r.after, null);
  // ... and the reader refuses exactly this shape (see review-evidence F4(e)).
});

test('F4(e). a run with NO observed start boundary is UNOBSERVED_START with before=null — never synthesized', () => {
  const wt = mkWorktree();
  const runsPath = path.join(safeTempBase(), `tre-nostart-${Date.now()}.testruns.jsonl`);
  const rec = createTestRunRecorder({ worktreePath: wt, identityHash: IDENTITY, path: runsPath });

  // The runtime only ever reports `completed` — no start event was seen.
  rec.observe(toolEvent('bash', 'node --test tests/x.test.mjs', 'TAP version 13\n# pass 1\nExit code: 0\n', { callID: 'call-nostart' }));
  // ... and a second call that never even carried a callID.
  rec.observe(toolEvent('bash', 'git diff --check', 'Exit code: 0\n'));

  const runs = readTestRunRecords(runsPath);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].boundary, 'UNOBSERVED_START');
  assert.equal(runs[0].binding, 'UNPROVEN');
  assert.equal(runs[0].before, null, 'the control plane must NOT invent a starting snapshot');
  assert.equal(runs[0].toolCallId, 'call-nostart');
  assert.equal(runs[1].boundary, 'UNOBSERVED_START');
  assert.equal(runs[1].before, null);
  assert.ok(runs[1].runId, 'a runId still exists so the record stays addressable');
  // A START for one call must never satisfy a DIFFERENT call's boundary.
  rec.observe(toolEvent('bash', 'node --test tests/x.test.mjs', null, { status: 'running', callID: 'call-a' }));
  rec.observe(toolEvent('bash', 'node --test tests/x.test.mjs', 'Exit code: 0\n', { callID: 'call-b' }));
  const after = readTestRunRecords(runsPath);
  assert.equal(after.length, 3);
  assert.equal(after[2].boundary, 'UNOBSERVED_START', 'call-b had no start of its own');
});

test('a `git add` invalidates the tracked-path cache so the next snapshot sees the new file', () => {
  const wt = mkWorktree();
  const runsPath = path.join(safeTempBase(), `tre-index-${Date.now()}.testruns.jsonl`);
  const rec = createTestRunRecorder({ worktreePath: wt, identityHash: IDENTITY, path: runsPath });
  const before = digestOf(wt);
  fs.writeFileSync(path.join(wt, 'new.md'), 'x\n', 'utf8');
  assert.equal(rec.snapshot().contentDigest, before, 'still untracked, so the digest is unchanged');
  git(wt, ['add', 'new.md']);
  rec.observe(toolEvent('bash', 'git add new.md', null, { callID: 'c-gitadd', status: 'running' }));
  assert.notEqual(rec.snapshot().contentDigest, before, 'the index change must be noticed immediately');
});

test('only real test commands are recorded, and exit codes are parsed truthfully', () => {
  assert.equal(isTestCommand('node --test tests/a.test.mjs'), true);
  assert.equal(isTestCommand('npm run test:gate'), true);
  assert.equal(isTestCommand('git diff --check'), true);
  assert.equal(isTestCommand('ls -la'), false);
  assert.equal(isTestCommand(undefined), false);
  assert.equal(parseExitCode('Exit code: 0\n'), 0);
  assert.equal(parseExitCode('Exit code: 3\n'), 3);
  assert.equal(parseExitCode('no exit marker'), null);
});

test('testRunsPathFor derives the canonical sibling of the events log', () => {
  const events = path.join(path.resolve(safeTempBase(), 'test-state'), 'executions', `${IDENTITY}.events.jsonl`);
  assert.equal(testRunsPathFor({ eventsPath: events }), path.join(path.resolve(safeTempBase(), 'test-state'), 'executions', `${IDENTITY}.testruns.jsonl`));
  assert.equal(testRunsPathFor({ stateDir: path.resolve(safeTempBase(), 'test-state'), identityHash: IDENTITY }), path.join(path.resolve(safeTempBase(), 'test-state'), 'executions', `${IDENTITY}.testruns.jsonl`));
  assert.equal(testRunsPathFor({ eventsPath: 'no-suffix.json', stateDir: null, identityHash: null }), null, 'an unrecognised path never yields a guess');
  assert.deepEqual(readTestRunRecords(null), [], 'an absent store reads as ZERO runs, never as PASS');
  assert.deepEqual(readTestRunRecords(path.join(safeTempBase(), 'does-not-exist.testruns.jsonl')), []);
});

test('the incremental tracker digests byte-identically to the one-shot binding', () => {
  const wt = mkWorktree();
  const oneShot = computeWorktreeContentBinding({ worktreePath: wt });
  const tr = createContentTracker({ worktreePath: wt });
  const first = tr.snapshot({ withHead: true });
  assert.equal(first.ok, true, String(first.reason));
  assert.equal(first.value.contentDigest, oneShot.value.contentDigest);
  assert.equal(first.value.fileCount, oneShot.value.fileCount);
  assert.equal(first.value.headSha, oneShot.value.headSha);
  // A no-op refresh must not move the digest.
  assert.equal(tr.snapshot().value.contentDigest, oneShot.value.contentDigest);
  // ... and a real change must.
  fs.writeFileSync(path.join(wt, 'tracked.md'), 'v9\n', 'utf8');
  assert.notEqual(tr.snapshot().value.contentDigest, oneShot.value.contentDigest);
});

// ---------------------------------------------------------------------------
// F4(1) — the ACTIVE control-plane test-runner at VERIFY.
// The control plane runs `test:gate` itself, so evidence no longer depends on
// a runtime start boundary the executor never emits. Every leg below is a real
// condition of that runner: snapshot before/after, full raw log, digest over
// the FULL bytes, real exit code, identity/worktree binding, fail-closed.
// ---------------------------------------------------------------------------
const PASSING_GATE = "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('gate passes', () => { assert.equal(1, 1); });\n";
const FAILING_GATE = "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('gate fails', () => { assert.equal(1, 2); });\n";

function addGate(dir, body = PASSING_GATE, script = 'node --test tests/gate.test.mjs') {
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'gate.test.mjs'), body, 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'gate-fixture', private: true, scripts: { 'test:gate': script } }, null, 2)}\n`, 'utf8');
}

function mkRunner(over = {}) {
  const wt = mkWorktree();
  const runsPath = path.join(safeTempBase(), `active-${Date.now()}-${Math.random().toString(16).slice(2)}.testruns.jsonl`);
  return { wt, runsPath, ...over };
}

test('resolveTestGateCommand: a bare `node --test <files>` script resolves to the exact argv and canonical command', () => {
  const wt = mkWorktree();
  addGate(wt, PASSING_GATE, 'node --test tests/a.test.mjs tests/b.test.mjs');
  const r = resolveTestGateCommand({ cwd: wt });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.command, 'node --test tests/a.test.mjs tests/b.test.mjs');
  assert.deepEqual(r.argv, ['--test', 'tests/a.test.mjs', 'tests/b.test.mjs']);
  assert.equal(r.executable, process.execPath, 'node itself is spawned, never a shell');
  // The same command string keys the run's target, so an executor claiming the
  // identical command line shares one test target with the control plane.
  assert.equal(isTestCommand(r.command), true);
});

test('resolveTestGateCommand: anything that would need a shell fails closed, never "approximated"', () => {
  const wt = mkWorktree();
  const cases = [
    ['node --test tests/x.test.mjs | tee log', 'GATE_SCRIPT_UNSUPPORTED'],
    ['node --test tests/x.test.mjs && npm run lint', 'GATE_SCRIPT_UNSUPPORTED'],
    ['node --test tests/*.test.mjs', 'GATE_SCRIPT_UNSUPPORTED'],
    ['npm test', 'GATE_SCRIPT_UNSUPPORTED'],
    ['node --test', 'GATE_SCRIPT_EMPTY'],
  ];
  for (const [script, code] of cases) {
    addGate(wt, PASSING_GATE, script);
    const r = resolveTestGateCommand({ cwd: wt });
    assert.equal(r.ok, false, script);
    assert.equal(r.code, code, `${script} -> ${JSON.stringify(r)}`);
  }
  addGate(wt);
  fs.rmSync(path.join(wt, 'package.json'));
  assert.equal(resolveTestGateCommand({ cwd: wt }).code, 'GATE_PACKAGE_JSON_UNREADABLE');
  assert.equal(resolveTestGateCommand({ cwd: null }).code, 'GATE_CWD_REQUIRED');
  assert.equal(resolveTestGateCommand({ cwd: path.join(wt, 'nope') }).code, 'GATE_PACKAGE_JSON_UNREADABLE');
});

test('the raw-log directory is the sibling of the run store — one identity, one evidence place', () => {
  const runsPath = path.join(path.resolve(safeTempBase(), 'test-state'), 'executions', `${IDENTITY}.testruns.jsonl`);
  assert.equal(activeTestRunLogDir({ runsPath }), path.join(path.resolve(safeTempBase(), 'test-state'), 'executions', `${IDENTITY}.testrun-logs`));
  assert.equal(
    activeTestRunLogDir({ stateDir: path.resolve(safeTempBase(), 'test-state'), identityHash: IDENTITY }),
    path.join(path.resolve(safeTempBase(), 'test-state'), 'executions', `${IDENTITY}.testrun-logs`),
  );
  assert.equal(activeTestRunLogDir({}), null, 'no store, no guessed log directory');
});

test('F4(1). the active runner brackets ONE gate run with real before/after snapshots + a full raw log', () => {
  const { wt, runsPath } = mkRunner();
  addGate(wt);
  const calls = [];
  const OUT = 'TAP version 13\n# tests 3\n# pass 3\n# fail 0\n';
  const runner = createActiveTestRunner({
    spawnImpl: (file, args, opts) => {
      calls.push({ file, args, opts });
      return { status: 0, stdout: OUT, stderr: '', signal: null, error: null };
    },
    clock: () => Date.UTC(2026, 9, 2, 0, 0, 0),
  });
  const before = digestOf(wt);
  const r = runner.runGate({
    record: {
      identityHash: IDENTITY, worktreePath: wt, taskId: 't#1', repo: 'o/r',
      issueNumber: 7, testRunsPath: runsPath,
    },
  });

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.exitCode, 0);
  assert.equal(calls.length, 1, 'the gate is spawned EXACTLY once');
  assert.equal(calls[0].opts.shell, false, 'never through a shell');
  assert.equal(calls[0].opts.cwd, wt, 'the BOUND task worktree');
  assert.equal(calls[0].opts.env.NODE_TEST_CONTEXT, undefined,
    'the nested node test-runner context is stripped — inheriting it makes node --test skip every file and still exit 0');
  assert.deepEqual(calls[0].args, ['--test', 'tests/gate.test.mjs']);

  const runs = readTestRunRecords(runsPath);
  assert.equal(runs.length, 1);
  const rec = runs[0];
  assert.equal(rec.runSource, 'control-plane-active', 'distinguished from an executor tool call');
  assert.equal(rec.toolCallId, null, 'a toolCallId is NEVER fabricated for a control-plane run');
  assert.equal(rec.boundary, 'OBSERVED_START');
  assert.equal(rec.binding, 'PROVEN');
  assert.equal(rec.command, 'node --test tests/gate.test.mjs');
  assert.equal(rec.commandDigest, sha256(rec.command));
  assert.equal(rec.identityHash, IDENTITY);
  assert.equal(rec.worktreePath, wt);
  assert.equal(rec.exitCode, 0);
  assert.equal(rec.result, 'PASS');
  assert.equal(rec.capturedBy, 'control-loop/activeTestRunner');
  assert.equal(rec.rawLogPath, r.rawLogPath);
  assert.ok(fs.existsSync(rec.rawLogPath), 'the raw log is persisted outside the run store');

  // The digest covers the FULL raw log, re-hashable from disk by the reader.
  const raw = fs.readFileSync(rec.rawLogPath, 'utf8');
  assert.match(raw, /TAP version 13/, 'the raw log keeps the full output');
  assert.match(raw, /Exit code: 0/);
  assert.equal(rec.outputDigest, sha256(raw), 'outputDigest is the digest of the raw log bytes, not an excerpt');
  assert.equal(rec.outputBytes, Buffer.byteLength(raw, 'utf8'));

  // Snapshot immediately before spawn and immediately after process exit.
  assert.equal(rec.before.contentDigest, before, 'the `before` is the content state the gate started from');
  assert.equal(rec.after.contentDigest, digestOf(wt), 'the `after` is the content state it ended on');
  assert.ok(typeof rec.startedAt === 'string' && typeof rec.finishedAt === 'string');
  assert.equal(rec.spawn.executable, process.execPath);
});

test('F4(1). a NON-ZERO gate exit is a typed failure and still leaves a truthful FAIL record', () => {
  const { wt, runsPath } = mkRunner();
  addGate(wt);
  const runner = createActiveTestRunner({
    spawnImpl: () => ({ status: 1, stdout: 'TAP version 13\n# tests 1\n# fail 1\n', stderr: 'boom\n', signal: null, error: null }),
    clock: () => Date.UTC(2026, 9, 2, 0, 0, 1),
  });
  const r = runner.runGate({ record: { identityHash: IDENTITY, worktreePath: wt, testRunsPath: runsPath } });
  assert.equal(r.ok, false, 'a valid record must never become PASS on a non-zero exit');
  assert.equal(r.code, ACTIVE_TEST_GATE_CODES.NONZERO_EXIT);
  assert.equal(r.detail.exitCode, 1);

  const [rec] = readTestRunRecords(runsPath);
  assert.equal(rec.exitCode, 1);
  assert.equal(rec.result, 'FAIL');
  assert.match(fs.readFileSync(rec.rawLogPath, 'utf8'), /Exit code: 1/);
  assert.equal(rec.outputDigest, sha256(fs.readFileSync(rec.rawLogPath, 'utf8')));
});

test('F4(1). an unresolvable gate never spawns and never returns PASS', () => {
  const { wt, runsPath } = mkRunner(); // no package.json -> no scripts["test:gate"]
  let spawned = 0;
  const runner = createActiveTestRunner({ spawnImpl: () => { spawned += 1; return { status: 0, stdout: '', stderr: '', signal: null, error: null }; } });
  const r = runner.runGate({ record: { identityHash: IDENTITY, worktreePath: wt, testRunsPath: runsPath } });
  assert.equal(r.ok, false);
  assert.equal(r.code, ACTIVE_TEST_GATE_CODES.UNRESOLVED);
  assert.equal(spawned, 0, 'nothing is executed against an unproven command');
  assert.equal(readTestRunRecords(runsPath).length, 0, 'no run is invented for a command that never ran');
});

test('F4(1). content the gate itself mutates is CONTENT_DRIFT, never a proven pass', () => {
  const { wt, runsPath } = mkRunner();
  addGate(wt);
  const runner = createActiveTestRunner({
    spawnImpl: () => {
      fs.writeFileSync(path.join(wt, 'tracked.md'), 'mutated by the gate itself\n', 'utf8');
      return { status: 0, stdout: 'TAP version 13\n# pass 1\n', stderr: '', signal: null, error: null };
    },
    clock: () => Date.UTC(2026, 9, 2, 0, 0, 2),
  });
  const r = runner.runGate({ record: { identityHash: IDENTITY, worktreePath: wt, testRunsPath: runsPath } });
  assert.equal(r.ok, false);
  assert.equal(r.code, ACTIVE_TEST_GATE_CODES.CONTENT_DRIFT);
  assert.notEqual(r.detail.before, r.detail.after, 'the in-run mutation stays visible in the evidence');
  const [rec] = readTestRunRecords(runsPath);
  assert.notEqual(rec.before.contentDigest, rec.after.contentDigest);
  assert.equal(rec.binding, 'PROVEN', 'both snapshots exist — they just disagree, which is the finding');
});

test('F4(1). a snapshot the control plane cannot take is UNPROVEN_BINDING, never a digest', () => {
  const { wt, runsPath } = mkRunner();
  addGate(wt);
  const runner = createActiveTestRunner({
    spawnImpl: () => ({ status: 0, stdout: 'TAP version 13\n', stderr: '', signal: null, error: null }),
    tracker: { markIndexStale() {}, snapshot: () => ({ ok: false, reason: 'worktree unavailable' }) },
  });
  const r = runner.runGate({ record: { identityHash: IDENTITY, worktreePath: wt, testRunsPath: runsPath } });
  assert.equal(r.ok, false);
  assert.equal(r.code, ACTIVE_TEST_GATE_CODES.UNPROVEN_BINDING);
  const [rec] = readTestRunRecords(runsPath);
  assert.equal(rec.binding, 'UNPROVEN');
  assert.equal(rec.before, null, 'the control plane NEVER synthesizes a starting snapshot');
  // ... and review-evidence refuses exactly this shape (F4(e)).
});

test('F4(1). an exit-0 gate that produced NO output ran nothing and fails closed', () => {
  // Reproduces the nested-harness signature: `node --test` under an inherited
  // NODE_TEST_CONTEXT skips every file, prints nothing and still exits 0.
  const { wt, runsPath } = mkRunner();
  addGate(wt);
  const runner = createActiveTestRunner({
    spawnImpl: () => ({ status: 0, stdout: '', stderr: '', signal: null, error: null }),
  });
  const r = runner.runGate({ record: { identityHash: IDENTITY, worktreePath: wt, testRunsPath: runsPath } });
  assert.equal(r.ok, false, 'exit 0 with no output must never become PASS');
  assert.equal(r.code, ACTIVE_TEST_GATE_CODES.NO_OUTPUT);
  assert.equal(readTestRunRecords(runsPath).length, 0, 'nothing ran, so nothing is recorded as a run');
});

test('F4(1). the DEFAULT spawn runs the real gate process and the digest re-hashes from disk', () => {
  const { wt, runsPath } = mkRunner();
  addGate(wt, PASSING_GATE);
  const runner = createActiveTestRunner({ clock: () => Date.now() });
  const r = runner.runGate({ record: { identityHash: IDENTITY, worktreePath: wt, testRunsPath: runsPath } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.exitCode, 0);
  const [rec] = readTestRunRecords(runsPath);
  const raw = fs.readFileSync(rec.rawLogPath, 'utf8');
  assert.match(raw, /TAP version 13/, 'the real runner\'s TAP output is in the raw log');
  assert.equal(parseExitCode(raw), 0);
  assert.equal(rec.outputDigest, sha256(raw));
  assert.equal(rec.before.contentDigest, rec.after.contentDigest, 'a passing gate does not touch tracked content');

  // A real FAILING gate proves the exit code is captured truthfully end to end.
  addGate(wt, FAILING_GATE);
  const r2 = runner.runGate({ record: { identityHash: IDENTITY, worktreePath: wt, testRunsPath: runsPath } });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, ACTIVE_TEST_GATE_CODES.NONZERO_EXIT);
  assert.equal(r2.detail.exitCode, 1);
  const runs = readTestRunRecords(runsPath);
  assert.equal(runs.length, 2, 'the failed run leaves evidence too');
  assert.equal(runs[1].result, 'FAIL');
  assert.equal(parseExitCode(fs.readFileSync(runs[1].rawLogPath, 'utf8')), 1);
});

// ---------------------------------------------------------------------------
// Affected-test PLAN-mode gate — the production path of this task: argv is
// derived ONLY from the deterministic plan built against the task BASE
// binding, PASS needs a valid TAP summary, and every unprovable outcome is a
// typed ACTIVE_TEST_GATE_* code with a truthful record for consumer read-back.
// ---------------------------------------------------------------------------
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function realPlan() {
  const mb = git(REPO_ROOT, ['merge-base', 'origin/main', 'HEAD']);
  const r = buildTestPlan({ root: REPO_ROOT, base: mb, mode: 'auto' });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.plan;
}

// A TAP stream whose counts the caller can bend; the plan-mode spawn helper
// derives the file count from the ACTUAL argv it received.
const tapFor = (n, over = {}) => [
  'TAP version 13',
  '# suites 0',
  `# tests ${over.tests ?? n}`,
  `# pass ${over.pass ?? n}`,
  `# fail ${over.fail ?? 0}`,
  `# cancelled ${over.cancelled ?? 0}`,
  `# skipped ${over.skipped ?? 0}`,
  `# todo ${over.todo ?? 0}`,
  '',
].join('\n');

// The pre-spawn boundary must be REAL content, not a fixed stub: the plan now
// binds the worktree content, and both the producer's pre-spawn check and the
// consumer's read-back compare the observed digest against the plan's
// contentBinding. Memoized per runner (the worktree is not expected to change
// within one run).
const planTracker = (root = REPO_ROOT) => {
  let memo = null;
  const live = () => {
    if (!memo) {
      const b = computePlanContentBinding({ root });
      assert.ok(b.ok, `real content binding unavailable: ${JSON.stringify(b)}`);
      memo = b.value;
    }
    return memo;
  };
  return {
    markIndexStale() {},
    snapshot: () => ({ ok: true, value: { contentDigest: live().contentDigest, fileCount: 42, headSha: 'a'.repeat(40) } }),
  };
};

const planRecord = (runsPath, over = {}) => ({
  identityHash: IDENTITY,
  worktreePath: REPO_ROOT,
  taskId: 't#1',
  repo: 'o/r',
  issueNumber: 7,
  testRunsPath: runsPath,
  baseSha: git(REPO_ROOT, ['merge-base', 'origin/main', 'HEAD']),
  ...over,
});

const planRunner = (spawnImpl, over = {}) => createActiveTestRunner({
  spawnImpl,
  clock: () => Date.UTC(2026, 9, 3, 0, 0, 0),
  tracker: planTracker(),
  planBuilder: ({ root, base, mode }) => buildTestPlan({ root, base, mode }),
  ...over,
});

const spawnTap = (over = {}) => (file, args) => ({
  status: over.status ?? 0,
  stdout: typeof over.stdout === 'function' ? over.stdout(args) : (over.stdout ?? tapFor(args.length - 2)),
  stderr: over.stderr ?? '',
  signal: null,
  error: over.error ?? null,
});

// A fixture whose CANONICAL planner really emits NO_TESTS — a proven
// docs-only change (only `docs/` is touched, and `ignorePrefixes` vouches for
// it). Since (F3) a plan's selection must BE the planner's output, a NO_TESTS
// plan forged over a READY worktree is refused as SELECTION_MISMATCH before
// the NO_TESTS branch can ever be reached: the NO_TESTS producer/consumer
// paths are therefore exercised against a genuine selection, not a forged one.
function mkNoTestsFixture() {
  const dir = fs.mkdtempSync(path.join(safeTempBase(), 'plnt-'));
  git(dir, ['init']);
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'gate.test.mjs'),
    "import test from 'node:test';\ntest('gate fixture', () => {});\n", 'utf8');
  fs.writeFileSync(path.join(dir, 'tests', 'tiers.json'), `${JSON.stringify({
    version: '1',
    always: [],
    smoke: ['gate.test.mjs'],
    pathMappings: {},
    fullTriggerPaths: [],
    fullTriggerPrefixes: [],
    ignorePrefixes: ['docs/'],
    ignoreSuffixes: [],
    coreSubsystems: {},
    tiers: { t1: { minTests: 1, files: ['gate.test.mjs'] } },
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'docs', 'readme.md'), 'v1\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=plf@t', '-c', 'user.name=plf', 'commit', '-m', 'head']);
  const base = git(dir, ['rev-parse', 'HEAD']);
  // The ONE change: a docs path every proven non-runtime rule covers.
  fs.writeFileSync(path.join(dir, 'docs', 'readme.md'), 'v2 - docs-only change\n', 'utf8');
  const built = buildTestPlan({ root: dir, base, mode: 'auto' });
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.equal(built.plan.status, 'NO_TESTS', `fixture must be genuinely NO_TESTS: ${JSON.stringify(built.plan)}`);
  assert.match(String(built.plan.fullReason), /docs-only/);
  return { dir, base, plan: built.plan };
}

test('PLAN mode: argv derives ONLY from the validated plan; record carries plan+TAP+runtime and re-proves on read-back', () => {
  const { runsPath } = mkRunner();
  const calls = [];
  const runner = planRunner((file, args) => {
    calls.push(args.slice());
    return spawnTap()(file, args);
  });
  const r = runner.runGate({ record: planRecord(runsPath) });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 800));

  const rec = r.record;
  const p = rec.plan;
  assert.ok(['affected', 'full'].includes(p.mode), `unexpected mode ${p.mode}`);
  assert.ok(p.files.length >= 1, 'this worktree has real changes');
  assert.equal(calls.length, 1, 'the gate spawns EXACTLY once');
  assert.deepEqual(calls[0], ['--test', '--test-reporter=tap', ...p.files],
    'argv is the plan-derived command, nothing else');
  assert.equal(rec.command, `node --test --test-reporter=tap ${p.files.join(' ')}`);
  assert.equal(rec.result, 'PASS');
  assert.equal(rec.tap.ok, true, JSON.stringify(rec.tap));
  assert.equal(rec.tap.fileCount, p.files.length);
  assert.match(p.manifestDigest, /^[0-9a-f]{64}$/);
  assert.match(p.planDigest, /^[0-9a-f]{64}$/);
  assert.equal(p.selectorVersion, '1');
  assert.ok(rec.runtime && typeof rec.runtime.node === 'string', 'runtime facts are recorded');
  assert.ok(Number.isInteger(rec.elapsedMs), 'elapsed time is recorded');

  // Consumer read-back re-derives argv + manifest/plan digest + TAP from bytes.
  const raw = fs.readFileSync(rec.rawLogPath, 'utf8');
  const pv = verifyActiveRunPlanBinding({ record: rec, rawText: raw });
  assert.equal(pv.ok, true, JSON.stringify(pv));

  const [stored] = readTestRunRecords(runsPath);
  assert.equal(stored.plan.planDigest, p.planDigest, 'the store keeps the exact plan');
});

test('PLAN mode: exit 0 WITHOUT a valid TAP summary is typed TAP_SUMMARY_INVALID — the exit code alone never passes', () => {
  const { runsPath } = mkRunner();
  const runner = planRunner(spawnTap({ stdout: 'TAP version 13\n# tests 1\n' }));
  const r = runner.runGate({ record: planRecord(runsPath) });
  assert.equal(r.ok, false);
  assert.equal(r.code, ACTIVE_TEST_GATE_CODES.TAP_SUMMARY_INVALID);
  const [rec] = readTestRunRecords(runsPath);
  assert.equal(rec.result, 'FAIL');
  assert.equal(rec.exitCode, 0, 'truthful: the process DID exit 0 — the summary is what failed');
  assert.equal(rec.tap.ok, false);
  assert.ok(rec.tap.reasons.length >= 1);
  const pv = verifyActiveRunPlanBinding({ record: rec, rawText: fs.readFileSync(rec.rawLogPath, 'utf8') });
  assert.equal(pv.ok, false, 'the consumer refuses the same run');
  assert.equal(pv.code, 'TEST_PLAN_TAP_INVALID');
});

test('PLAN mode: ZERO executed tests is a typed failure even with exit 0', () => {
  const { runsPath } = mkRunner();
  const runner = planRunner(spawnTap({ stdout: tapFor(0) }));
  const r = runner.runGate({ record: planRecord(runsPath) });
  assert.equal(r.ok, false);
  assert.equal(r.code, ACTIVE_TEST_GATE_CODES.TAP_SUMMARY_INVALID);
  const [rec] = readTestRunRecords(runsPath);
  assert.ok(rec.tap.reasons.some((x) => /0 tests executed/.test(x)), JSON.stringify(rec.tap));
});

test('PLAN mode: skipped/cancelled counts are never acceptable evidence', () => {
  const { runsPath } = mkRunner();
  const runner = planRunner(spawnTap({
    stdout: (args) => tapFor(args.length - 2, { skipped: 1, cancelled: 1 }),
  }));
  const r = runner.runGate({ record: planRecord(runsPath) });
  assert.equal(r.ok, false);
  assert.equal(r.code, ACTIVE_TEST_GATE_CODES.TAP_SUMMARY_INVALID);
  const [rec] = readTestRunRecords(runsPath);
  assert.ok(rec.tap.reasons.some((x) => /skipped/.test(x)), JSON.stringify(rec.tap));
  assert.ok(rec.tap.reasons.some((x) => /cancelled/.test(x)), JSON.stringify(rec.tap));
});

test('PLAN mode: a plan bound to a DIFFERENT candidate HEAD is STALE — refused before any spawn', () => {
  const { runsPath } = mkRunner();
  const stale = { ...realPlan(), candidateSha: '0'.repeat(40) };
  stale.planDigest = recomputePlanDigest(stale);
  let spawned = 0;
  const runner = planRunner(() => { spawned += 1; return spawnTap()(); });
  const r = runner.runGate({ record: planRecord(runsPath), plan: { ok: true, plan: stale } });
  assert.equal(r.ok, false);
  assert.equal(r.code, ACTIVE_TEST_GATE_CODES.PLAN_STALE);
  assert.equal(spawned, 0, 'a stale plan never executes');
  assert.equal(readTestRunRecords(runsPath).length, 0, 'no run is invented');
});

test('PLAN mode: a tampered selection or an escaping path is PLAN_INVALID — never spawned', () => {
  const { runsPath } = mkRunner();
  let spawned = 0;
  const runner = planRunner(() => { spawned += 1; return spawnTap()(); });

  // (a) files shrunk after the digest was taken
  const p = realPlan();
  const tampered = { ...p, files: p.files.slice(0, 2) }; // digest NOT recomputed
  const r1 = runner.runGate({ record: planRecord(runsPath), plan: { ok: true, plan: tampered } });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, ACTIVE_TEST_GATE_CODES.PLAN_INVALID);

  // (b) a traversal path that is given a VALID digest by the attacker
  const evil = { ...p, files: ['tests/../../evil.test.mjs'] };
  evil.planDigest = recomputePlanDigest(evil);
  const r2 = runner.runGate({ record: planRecord(runsPath), plan: { ok: true, plan: evil } });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, ACTIVE_TEST_GATE_CODES.PLAN_INVALID);
  assert.equal(spawned, 0, 'neither invalid plan ever executed');
  assert.equal(readTestRunRecords(runsPath).length, 0);
});

test('PLAN mode: an explicit NO_TESTS plan never spawns and is persisted as an explicit state, never PASS', () => {
  // Genuine NO_TESTS selection (docs-only change) — not a forged one: the
  // selection authority (F3) refuses a status the planner never produced.
  const { dir, base } = mkNoTestsFixture();
  const { runsPath } = mkRunner();
  let spawned = 0;
  const runner = planRunner((file, args) => { spawned += 1; return spawnTap()(file, args); }, { tracker: planTracker(dir) });
  const r = runner.runGate({ record: planRecord(runsPath, { worktreePath: dir, baseSha: base }) });
  assert.equal(r.ok, false, JSON.stringify(r).slice(0, 600));
  assert.equal(r.code, ACTIVE_TEST_GATE_CODES.NO_TESTS);
  assert.match(String(r.detail.reason), /docs-only/);
  assert.equal(spawned, 0);

  const [rec] = readTestRunRecords(runsPath);
  assert.equal(rec.result, 'NO_TESTS', 'the record says NO_TESTS — not PASS, not FAIL, not absent');
  assert.equal(rec.rawLogPath, null, 'no log is invented when nothing ran');
  assert.equal(rec.plan.status, 'NO_TESTS');
  const pv = verifyActiveRunPlanBinding({ record: rec, rawText: '' });
  assert.equal(pv.ok, false);
  assert.equal(pv.code, 'TEST_PLAN_NO_TESTS');
});

test('PLAN mode: an unprovable plan (builder throws / refuses / no BASE binding) is typed and spawns nothing', () => {
  const { runsPath } = mkRunner();
  let spawned = 0;
  const never = () => { spawned += 1; return spawnTap()(); };

  // (a) the planner itself cannot produce a plan
  const thrower = createActiveTestRunner({
    spawnImpl: never, tracker: planTracker(), clock: () => Date.UTC(2026, 9, 3, 0, 0, 1),
    planBuilder: () => { throw new Error('boom: git unavailable'); },
  });
  const r1 = thrower.runGate({ record: planRecord(runsPath) });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, ACTIVE_TEST_GATE_CODES.PLAN_FAILED);
  assert.match(String(r1.detail.reason), /boom/);

  // (b) the planner fails closed explicitly
  const refuser = createActiveTestRunner({
    spawnImpl: never, tracker: planTracker(), clock: () => Date.UTC(2026, 9, 3, 0, 0, 2),
    planBuilder: () => ({ ok: false, code: 'TEST_PLAN_BASE_UNRESOLVED', detail: 'base not in this repo' }),
  });
  const r2 = refuser.runGate({ record: planRecord(runsPath) });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, ACTIVE_TEST_GATE_CODES.PLAN_FAILED);
  assert.match(String(r2.detail.reason), /base not in this repo/);

  // (c) NO task BASE binding at all -> the plan can never be grounded
  let built = 0;
  const unb = createActiveTestRunner({
    spawnImpl: never, tracker: planTracker(), clock: () => Date.UTC(2026, 9, 3, 0, 0, 3),
    planBuilder: () => { built += 1; return { ok: true, plan: realPlan() }; },
  });
  const r3 = unb.runGate({ record: planRecord(runsPath, { baseSha: null }) });
  assert.equal(r3.ok, false);
  assert.equal(r3.code, ACTIVE_TEST_GATE_CODES.UNBOUND);
  assert.equal(built, 0, 'without a BASE binding the planner is never even called');

  assert.equal(spawned, 0, 'no unprovable plan ever spawned');
  assert.equal(readTestRunRecords(runsPath).length, 0);
});

test('PLAN mode: evidence that cannot be PERSISTED is a typed failure, never a silent pass', () => {
  // (a) the raw-log directory cannot even be created (a file blocks the path)
  const blocker = path.join(safeTempBase(), `blk-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.writeFileSync(blocker, 'not a directory\n', 'utf8'); // makes mkdir below throw
  const runsPath = path.join(blocker, 'nested', 'runs.testruns.jsonl');
  const runner = planRunner(spawnTap());
  const r = runner.runGate({ record: planRecord(null, { testRunsPath: runsPath }) });
  assert.equal(r.ok, false, 'a gate whose evidence vanished must not report success');
  assert.equal(r.code, ACTIVE_TEST_GATE_CODES.LOG_WRITE_FAILED);
  assert.equal(typeof r.detail, 'string', 'the typed failure names the unwritable log path');

  // (b) the raw log IS written, but the canonical TestRunRecord store refuses
  //     the append (the store path exists as a DIRECTORY) -> typed failure.
  const runsDir = path.join(safeTempBase(), `storer-${Date.now()}-${Math.random().toString(16).slice(2)}.testruns.jsonl`);
  fs.mkdirSync(runsDir, { recursive: true }); // open(store, 'a') on a dir -> EISDIR
  const runner2 = planRunner(spawnTap());
  const r2 = runner2.runGate({ record: planRecord(null, { testRunsPath: runsDir }) });
  assert.equal(r2.ok, false, 'the run passed but its evidence was not persisted — never success');
  assert.equal(r2.code, ACTIVE_TEST_GATE_CODES.RECORD_WRITE_FAILED);
  assert.ok(r2.record, 'the in-memory record is still handed back for diagnosis');
  assert.equal(r2.record.exitCode, 0, 'the run itself did pass — persistence is what failed');
});

test('PLAN mode: output that reached the cap is OUTPUT_TRUNCATED — no summary from it is trusted', () => {
  const { runsPath } = mkRunner();
  const runner = planRunner(spawnTap({ stdout: `${tapFor(3)}${'# filler x'.repeat(40)}\n` }), { maxOutputBytes: 64 });
  const r = runner.runGate({ record: planRecord(runsPath) });
  assert.equal(r.ok, false);
  assert.equal(r.code, ACTIVE_TEST_GATE_CODES.OUTPUT_TRUNCATED);
  const [rec] = readTestRunRecords(runsPath);
  assert.ok(rec, 'the truthful record survives');
});

test('consumer read-back: argv/command mismatch, a tampered plan and a swapped raw log are each refused', () => {
  const { runsPath } = mkRunner();
  const runner = planRunner(spawnTap());
  const r = runner.runGate({ record: planRecord(runsPath) });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 500));
  const rec = r.record;
  const raw = fs.readFileSync(rec.rawLogPath, 'utf8');

  // correct baseline
  assert.equal(verifyActiveRunPlanBinding({ record: rec, rawText: raw }).ok, true);

  // (a) spawned argv does not match the plan
  const badArgv = { ...rec, spawn: { ...rec.spawn, argv: ['--test', 'tests/other.test.mjs'] } };
  const v1 = verifyActiveRunPlanBinding({ record: badArgv, rawText: raw });
  assert.equal(v1.ok, false);
  assert.equal(v1.code, 'TEST_PLAN_ARGV_MISMATCH');

  // (b) command string swapped
  const badCmd = { ...rec, command: 'node --test tests/swapped.test.mjs' };
  const v2 = verifyActiveRunPlanBinding({ record: badCmd, rawText: raw });
  assert.equal(v2.ok, false);
  assert.equal(v2.code, 'TEST_PLAN_ARGV_MISMATCH');

  // (c) plan edited after the run (digest no longer matches content)
  const badPlan = { ...rec, plan: { ...rec.plan, files: rec.plan.files.slice(0, 3) } };
  const v3 = verifyActiveRunPlanBinding({ record: badPlan, rawText: raw });
  assert.equal(v3.ok, false);
  assert.equal(v3.code, 'TEST_PLAN_INVALID', 'digest mismatch is caught first — never re-hashed');

  // (d) raw log bytes no longer yield a proven TAP summary
  const v4 = verifyActiveRunPlanBinding({ record: rec, rawText: 'swapped log without summary\n' });
  assert.equal(v4.ok, false);
  assert.equal(v4.code, 'TEST_PLAN_TAP_INVALID');

  // (e) legacy records (no plan) keep their old contract untouched
  const legacy = { ...rec };
  delete legacy.plan;
  delete legacy.tap;
  const v5 = verifyActiveRunPlanBinding({ record: legacy, rawText: raw });
  assert.equal(v5.ok, true);
  assert.equal(v5.legacy, true, 'a legacy gate-script run is NOT rejected by plan checks');
});

// ---------------------------------------------------------------------------
// Rework regressions — the four review findings, each proven by a test that
// FAILS on the pre-rework code (stale content, wrong BASE, broken chain).
// ---------------------------------------------------------------------------
test('PLAN mode: content drift between planning and spawn is refused BEFORE the spawn (no child process)', () => {
  const { runsPath } = mkRunner();
  let spawned = 0;
  const runner = planRunner(() => { spawned += 1; return spawnTap()(); }, {
    planBuilder: ({ root, base, mode }) => {
      const r = buildTestPlan({ root, base, mode });
      assert.equal(r.ok, true, JSON.stringify(r));
      // Simulate drift: the plan claims a content binding the worktree no
      // longer has. Every other claim stays intact so ONLY the live content
      // check can refuse it.
      r.plan.contentBinding = { ...r.plan.contentBinding, digest: 'f'.repeat(64) };
      r.plan.planDigest = recomputePlanDigest(r.plan);
      return r;
    },
  });
  const g = runner.runGate({ record: planRecord(runsPath) });
  assert.equal(g.ok, false, JSON.stringify(g).slice(0, 600));
  assert.equal(g.code, ACTIVE_TEST_GATE_CODES.PLAN_STALE);
  assert.match(String(g.detail.reason), /drift/, 'the typed reason names the drift');
  assert.equal(spawned, 0, 'stale content never reaches a spawn');
  assert.equal(readTestRunRecords(runsPath).length, 0, 'no evidence is persisted for a refused plan');
});

test('PLAN mode: a plan built from a different task BASE is refused as BASE_MISMATCH — no spawn', () => {
  const { runsPath } = mkRunner();
  let spawned = 0;
  const head = git(REPO_ROOT, ['rev-parse', 'HEAD']);
  const runner = planRunner(() => { spawned += 1; return spawnTap()(); }, {
    // The builder IGNORES the canonical base and plans from HEAD instead —
    // a self-consistent plan that covers a different changeset.
    planBuilder: ({ root, mode }) => buildTestPlan({ root, base: head, mode }),
  });
  const g = runner.runGate({ record: planRecord(runsPath) }); // record.baseSha = merge-base
  assert.equal(g.ok, false, JSON.stringify(g).slice(0, 600));
  assert.equal(g.code, ACTIVE_TEST_GATE_CODES.BASE_MISMATCH);
  assert.equal(g.detail.planCode, TEST_PLAN_CODES.BASE_MISMATCH, 'the validator code survives mapping');
  assert.equal(spawned, 0, 'a foreign-base plan never executes');
  assert.equal(readTestRunRecords(runsPath).length, 0);
});

test('PLAN mode: a NO_TESTS plan is validated against the task BASE BEFORE it is persisted', () => {
  const { runsPath } = mkRunner();
  const head = git(REPO_ROOT, ['rev-parse', 'HEAD']);
  const runner = planRunner(() => { assert.fail('NO_TESTS never spawns — and a BASE mismatch never reaches it'); }, {
    planBuilder: ({ root, mode }) => {
      const r = buildTestPlan({ root, base: head, mode });
      assert.equal(r.ok, true, JSON.stringify(r));
      // Force the no-tests state while keeping every other claim intact.
      // (F3) the selection authority would ALSO refuse this forged status —
      // the point of this test is ORDER: the task BASE check runs first, so
      // the plan is a BASE refusal, never a quiet "no tests to run".
      r.plan = {
        ...r.plan, status: 'NO_TESTS', fullReason: 'docs-only: every changed path is a proven non-runtime doc',
      };
      r.plan.planDigest = recomputePlanDigest(r.plan);
      return r;
    },
  });
  const g = runner.runGate({ record: planRecord(runsPath) }); // canonical merge-base BASE
  assert.equal(g.ok, false);
  assert.equal(g.code, ACTIVE_TEST_GATE_CODES.BASE_MISMATCH,
    'the BASE check runs BEFORE the NO_TESTS shortcut — never a quiet "no tests to run"');
  assert.equal(readTestRunRecords(runsPath).length, 0, 'nothing is persisted for a refused plan');
});

test('consumer read-back: a broken content chain or a foreign task BASE is refused; NO_TESTS validates first', () => {
  const { runsPath } = mkRunner();
  const runner = planRunner(spawnTap());
  const r = runner.runGate({ record: planRecord(runsPath) });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 500));
  const rec = r.record;
  const raw = fs.readFileSync(rec.rawLogPath, 'utf8');
  const canonicalBase = rec.plan.baseSha;

  // (a) the pre-spawn observation is missing entirely
  const noSnap = { ...rec };
  delete noSnap.planContentSnapshot;
  let v = verifyActiveRunPlanBinding({ record: noSnap, rawText: raw });
  assert.equal(v.ok, false, JSON.stringify(v));
  assert.equal(v.code, 'TEST_PLAN_CONTENT_MISMATCH');

  // (b) the observation exists but does not match the plan's claim
  const wrongSnap = { ...rec, planContentSnapshot: { ...rec.planContentSnapshot, digest: 'f'.repeat(64) } };
  v = verifyActiveRunPlanBinding({ record: wrongSnap, rawText: raw });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'TEST_PLAN_CONTENT_MISMATCH');

  // (c) the plan's tracked portion does not match the observed pre-run boundary
  const wrongBefore = { ...rec, before: { ...rec.before, contentDigest: 'e'.repeat(64) } };
  v = verifyActiveRunPlanBinding({ record: wrongBefore, rawText: raw });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'TEST_PLAN_CONTENT_MISMATCH');

  // (d) a plan bound to a DIFFERENT task BASE than the one under review
  v = verifyActiveRunPlanBinding({ record: rec, rawText: raw, expectedBaseSha: '0'.repeat(40) });
  assert.equal(v.ok, false, 'a self-consistent plan from another base never vouches for THIS task');
  assert.equal(v.code, TEST_PLAN_CODES.BASE_MISMATCH);

  // (e) the whole chain with the CANONICAL base is green
  v = verifyActiveRunPlanBinding({ record: rec, rawText: raw, expectedBaseSha: canonicalBase });
  assert.equal(v.ok, true, JSON.stringify(v));

  // (f) a NO_TESTS plan is validated FIRST: a wrong task BASE is a BASE
  //     refusal, never a quiet "no tests to run" — and the NO_TESTS state
  //     itself must be the planner's real output (F3), so this record comes
  //     from a genuinely docs-only fixture instead of a forged status field.
  const ntFix = mkNoTestsFixture();
  const ntStore = path.join(safeTempBase(), `tre-nt-${Date.now()}.testruns.jsonl`);
  const gNt = planRunner(spawnTap(), { tracker: planTracker(ntFix.dir) })
    .runGate({ record: planRecord(ntStore, { worktreePath: ntFix.dir, baseSha: ntFix.base }) });
  assert.equal(gNt.ok, false, JSON.stringify(gNt).slice(0, 600));
  assert.equal(gNt.code, ACTIVE_TEST_GATE_CODES.NO_TESTS, 'the fixture really produces NO_TESTS');
  const nt = readTestRunRecords(ntStore)[0];
  assert.ok(nt, 'the NO_TESTS refusal still persists its record');
  assert.equal(nt.plan.status, 'NO_TESTS');
  v = verifyActiveRunPlanBinding({ record: nt, rawText: '', expectedBaseSha: '0'.repeat(40) });
  assert.equal(v.ok, false);
  assert.equal(v.code, TEST_PLAN_CODES.BASE_MISMATCH, 'BASE before NO_TESTS');
  v = verifyActiveRunPlanBinding({ record: nt, rawText: '', expectedBaseSha: ntFix.base });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'TEST_PLAN_NO_TESTS', 'with the right BASE the explicit state reports itself');
});

// ---------------------------------------------------------------------------
// Round-2 rework regression (review F2): the boundary is a FRESH observation,
// the consumer checks the LIVE full binding, and the during-run window is
// closed with a post-execution full binding. Every drift below is REAL
// filesystem drift in an isolated fixture worktree — never a mutated claim —
// so a pre-fix implementation (tracked-only checks, reused early liveBind)
// believes these runs and the tests FAIL on it.
// ---------------------------------------------------------------------------
function mkGatePlanFixture() {
  const dir = fs.mkdtempSync(path.join(safeTempBase(), 'plf-'));
  git(dir, ['init']);
  git(dir, ['-c', 'user.email=plf@t', '-c', 'user.name=plf', 'commit', '--allow-empty', '-m', 'base']);
  const base = git(dir, ['rev-parse', 'HEAD']);
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'gate.test.mjs'),
    "import test from 'node:test';\ntest('gate fixture', () => {});\n", 'utf8');
  fs.writeFileSync(path.join(dir, 'tracked.md'), 'v1\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=plf@t', '-c', 'user.name=plf', 'commit', '-m', 'head']);
  // The canonical manifest — UNTRACKED, i.e. a real change the planner must
  // classify (unknown tracked.md -> full fallback over the one owned test).
  fs.writeFileSync(path.join(dir, 'tests', 'tiers.json'), `${JSON.stringify({
    version: '1',
    always: [],
    smoke: ['gate.test.mjs'],
    pathMappings: {},
    fullTriggerPaths: [],
    fullTriggerPrefixes: [],
    ignorePrefixes: [],
    ignoreSuffixes: [],
    coreSubsystems: {},
    tiers: { t1: { minTests: 1, files: ['gate.test.mjs'] } },
  }, null, 2)}\n`, 'utf8');
  return { dir, base };
}

const fixtureRecord = (dir, base, runsPath) => ({
  identityHash: IDENTITY, worktreePath: dir, taskId: 't#1', repo: 'o/r',
  issueNumber: 9, testRunsPath: runsPath, baseSha: base,
});

test('rework2(F2): REAL untracked drift after planning (not a claim mutation) is refused BEFORE spawn — no child process, no record', () => {
  const { dir, base } = mkGatePlanFixture();
  const { runsPath } = mkRunner();
  const probe = path.join(dir, 'after-plan-drift.mjs');
  let spawned = 0;
  const runner = createActiveTestRunner({
    clock: () => Date.UTC(2026, 9, 4, 0, 0, 0),
    planBuilder: ({ root, base: b, mode }) => {
      const r = buildTestPlan({ root, base: b, mode });
      assert.equal(r.ok, true, JSON.stringify(r));
      // REAL drift on disk the moment the plan is produced: a new untracked
      // source appears — exactly what a mutated digest claim could never be.
      fs.writeFileSync(probe, 'export const afterPlanDrift = 1;\n', 'utf8');
      return r;
    },
    spawnImpl: () => { spawned += 1; return { status: 0, stdout: tapFor(1), stderr: '', signal: null, error: null }; },
  });
  try {
    const g = runner.runGate({ record: fixtureRecord(dir, base, runsPath) });
    assert.equal(g.ok, false, JSON.stringify(g).slice(0, 600));
    assert.equal(g.code, ACTIVE_TEST_GATE_CODES.PLAN_STALE);
    assert.match(String(g.detail.reason), /drift/, 'the typed reason names the drift');
    assert.equal(spawned, 0, 'real drift never reaches a spawn');
    assert.equal(readTestRunRecords(runsPath).length, 0, 'no evidence for a refused gate');
  } finally {
    if (fs.existsSync(probe)) fs.unlinkSync(probe);
  }
});

test('rework2(F2): drift in the window between the pre-check and spawn hits the FRESH boundary observation — the pre-fix reused-liveBind path spawned here', () => {
  const { dir, base } = mkGatePlanFixture();
  const { runsPath } = mkRunner();
  const probe = path.join(dir, 'mid-window-drift.mjs');
  const realRead = fs.readFileSync;
  let armed = false;
  let pureReads = 0;
  // Count only the MANIFEST reads (utf8); the tracked-hash reads of the same
  // file are Buffer reads and never counted.
  //
  // The probe is armed on the SECOND PURE binding read of the gate, where
  // "pure" = a manifest read whose call chain contains NO planning/validation
  // frame (buildTestPlan / canonicalSelectionFor / validateTestPlan /
  // testPlanGateCommand) — i.e. only the content binding taken by
  // runActiveTestGate itself:
  //   1st pure read: the early liveBind taken before validation
  //   2nd pure read: the FRESH BOUNDARY observation just before spawn
  // This classifies the read by WHAT it is instead of a hard-coded offset,
  // because (F3) the pre-check validate now re-proves the SELECTION by
  // re-running the canonical planner: that adds manifest reads of its own (and
  // their count is an internal detail that may legitimately change), so a
  // fixed "armedAt + 3" would drift inside the re-prove instead of landing on
  // the boundary this test is about.
  // PRE-fix, argv derivation REUSED the early liveBind, so the probe escaped
  // every check and the gate spawned on a stale selection.
  fs.readFileSync = function patchedRead(p, ...rest) {
    const out = realRead.call(this, p, ...rest);
    const norm = String(p).split(path.sep).join('/');
    if (norm.endsWith('tests/tiers.json') && rest[0] === 'utf8') {
      const st = new Error().stack || '';
      const pure = !/buildTestPlan|canonicalSelectionFor|validateTestPlan|testPlanGateCommand/.test(st);
      if (armed && pure) {
        pureReads += 1;
        if (pureReads === 2) {
          fs.writeFileSync(probe, 'export const midWindow = 1;\n', 'utf8');
        }
      }
    }
    return out;
  };
  let spawned = 0;
  const runner = createActiveTestRunner({
    clock: () => Date.UTC(2026, 9, 4, 0, 0, 3),
    planBuilder: ({ root, base: b, mode }) => {
      const r = buildTestPlan({ root, base: b, mode });
      assert.equal(r.ok, true, JSON.stringify(r));
      armed = true; // every binding read AFTER the builder returned is post-plan
      return r;
    },
    spawnImpl: () => { spawned += 1; return { status: 0, stdout: tapFor(1), stderr: '', signal: null, error: null }; },
  });
  try {
    const g = runner.runGate({ record: fixtureRecord(dir, base, runsPath) });
    assert.equal(fs.existsSync(probe), true, 'the mid-window drift really happened on disk');
    assert.equal(g.ok, false, JSON.stringify(g).slice(0, 600));
    assert.equal(g.code, ACTIVE_TEST_GATE_CODES.PLAN_STALE);
    assert.match(String(g.detail.reason), /execution boundary/, 'the refusal comes from the FRESH boundary observation');
    assert.equal(spawned, 0, 'the pre-fix reused-liveBind path would have spawned here');
    assert.equal(readTestRunRecords(runsPath).length, 0);
  } finally {
    fs.readFileSync = realRead;
    if (fs.existsSync(probe)) fs.unlinkSync(probe);
  }
});

test('rework2(F2): untracked content created DURING the run is CONTENT_DRIFT — the tracked before/after pair cannot see it', () => {
  const { dir, base } = mkGatePlanFixture();
  const { runsPath } = mkRunner();
  const probe = path.join(dir, 'during-run-drift.mjs');
  const runner = createActiveTestRunner({
    clock: () => Date.UTC(2026, 9, 4, 0, 0, 1),
    planBuilder: ({ root, base: b, mode }) => buildTestPlan({ root, base: b, mode }),
    spawnImpl: (exe, args) => {
      // The run itself writes an untracked source into the worktree.
      fs.writeFileSync(probe, 'export const duringRun = 1;\n', 'utf8');
      return { status: 0, stdout: tapFor(args.length - 2), stderr: '', signal: null, error: null };
    },
  });
  try {
    const g = runner.runGate({ record: fixtureRecord(dir, base, runsPath) });
    assert.equal(g.ok, false, JSON.stringify(g).slice(0, 600));
    assert.equal(g.code, ACTIVE_TEST_GATE_CODES.CONTENT_DRIFT);
    assert.equal(g.detail.phase, 'full-binding', 'the refusal names the FULL binding phase');
    const [rec] = readTestRunRecords(runsPath);
    assert.ok(rec, 'the truthful record survives');
    assert.equal(rec.planContentSnapshot.digest, rec.plan.contentBinding.digest,
      'the persisted snapshot is the boundary observation == the planned binding');
  } finally {
    if (fs.existsSync(probe)) fs.unlinkSync(probe);
  }
});

test('rework2(F2): consumer read-back refuses a run whose worktree drifted (untracked) after execution — the tracked chain alone is never enough', () => {
  const { dir, base } = mkGatePlanFixture();
  const { runsPath } = mkRunner();
  const probe = path.join(dir, 'after-run-consumer-drift.mjs');
  const runner = createActiveTestRunner({
    clock: () => Date.UTC(2026, 9, 4, 0, 0, 2),
    planBuilder: ({ root, base: b, mode }) => buildTestPlan({ root, base: b, mode }),
    spawnImpl: (exe, args) => ({ status: 0, stdout: tapFor(args.length - 2), stderr: '', signal: null, error: null }),
  });
  const g = runner.runGate({ record: fixtureRecord(dir, base, runsPath) });
  assert.equal(g.ok, true, JSON.stringify(g).slice(0, 600));
  const rec = g.record;
  const raw = fs.readFileSync(rec.rawLogPath, 'utf8');
  // Honest baseline: the read-back re-derives everything and agrees.
  assert.equal(verifyActiveRunPlanBinding({ record: rec, rawText: raw }).ok, true);
  try {
    // REAL drift after the run: an untracked source appears. The tracked
    // before/after chain is byte-identical — only the LIVE full binding
    // (tracked + untracked) the consumer now computes can see this.
    fs.writeFileSync(probe, 'export const consumerDrift = 1;\n', 'utf8');
    const v = verifyActiveRunPlanBinding({ record: rec, rawText: raw });
    assert.equal(v.ok, false, 'the consumer refuses a drifted worktree');
    assert.equal(v.code, TEST_PLAN_CODES.PLAN_STALE);
  } finally {
    if (fs.existsSync(probe)) fs.unlinkSync(probe);
  }
});

// ---------------------------------------------------------------------------
// Round-3 rework regression (review R3-01): the producer's post-run refusal
// must be PERSISTED (full AFTER binding + typed outcome), so the consumer
// keeps refusing the run after the drift is cleaned up. The pre-fix code
// appended result=PASS before evaluating the refusal and stored no AFTER
// binding, so read-back saw a clean live worktree and returned ok:true.
// ---------------------------------------------------------------------------
test('rework3(R3-01): a run that drifted DURING execution stays refused after the drift file is cleaned before read-back', () => {
  const { dir, base } = mkGatePlanFixture();
  const { runsPath } = mkRunner();
  const probe = path.join(dir, 'during-run-drift-r3-01.mjs');
  const runner = createActiveTestRunner({
    clock: () => Date.UTC(2026, 9, 5, 0, 0, 0),
    planBuilder: ({ root, base: b, mode }) => buildTestPlan({ root, base: b, mode }),
    spawnImpl: (exe, args) => {
      // The run itself creates the untracked drift the post-run binding sees.
      fs.writeFileSync(probe, 'export const duringRunR301 = 1;\n', 'utf8');
      return { status: 0, stdout: tapFor(args.length - 2), stderr: '', signal: null, error: null };
    },
  });
  const g = runner.runGate({ record: fixtureRecord(dir, base, runsPath) });
  // …the producer refuses…
  assert.equal(g.ok, false, JSON.stringify(g).slice(0, 600));
  assert.equal(g.code, ACTIVE_TEST_GATE_CODES.CONTENT_DRIFT);
  assert.equal(g.detail.phase, 'full-binding');

  // …and the RECORD — not just the return value — is authoritative.
  const [rec] = readTestRunRecords(runsPath);
  assert.ok(rec, 'the truthful record survives');
  assert.equal(rec.result, 'FAIL', 'a refused run is NEVER persisted as PASS');
  assert.ok(rec.refusal && rec.refusal.code === ACTIVE_TEST_GATE_CODES.CONTENT_DRIFT,
    `the typed refusal travels on the record: ${JSON.stringify(rec.refusal)}`);
  assert.match(String(rec.refusal.reason), /changed during the run/);
  assert.equal(rec.planContentSnapshot.digest, rec.plan.contentBinding.digest,
    'the pre-spawn boundary still matches the plan (only the AFTER binding drifted)');
  assert.ok(rec.planContentSnapshotAfter && /^[0-9a-f]{64}$/.test(rec.planContentSnapshotAfter.digest),
    'the FULL post-execution observation is persisted');
  assert.notEqual(rec.planContentSnapshotAfter.digest, rec.plan.contentBinding.digest,
    'the persisted AFTER binding records the drift');

  // CLEAN the drift: the live worktree matches the plan again, so the pre-fix
  // consumer returned ok:true for this very run.
  fs.unlinkSync(probe);
  const live = computePlanContentBinding({ root: dir });
  assert.equal(live.ok, true, JSON.stringify(live));
  assert.equal(live.value.digest, rec.plan.contentBinding.digest,
    'the live worktree now matches the plan again — the trap the fix must survive');

  const raw = fs.readFileSync(rec.rawLogPath, 'utf8');
  const c = verifyActiveRunPlanBinding({ record: rec, rawText: raw, expectedBaseSha: base });
  assert.equal(c.ok, false, 'a rejected run must NOT be rehabilitated by cleaning the drift file');
  assert.equal(c.code, ACTIVE_TEST_GATE_CODES.CONTENT_DRIFT);
  assert.match(String(c.reason), /changed during the run/);

  // The persisted AFTER binding is INDEPENDENT evidence: even if an attacker
  // strips the refusal field, the drifted post-run observation still refuses.
  const noRefusal = { ...rec, refusal: null };
  const c2 = verifyActiveRunPlanBinding({ record: noRefusal, rawText: raw, expectedBaseSha: base });
  assert.equal(c2.ok, false, 'the AFTER binding alone is enough to refuse');
  assert.equal(c2.code, ACTIVE_TEST_GATE_CODES.CONTENT_DRIFT);
});

test('rework3(R3-01): a clean run persists refusal=null + a matching AFTER binding and is still accepted', () => {
  const { dir, base } = mkGatePlanFixture();
  const { runsPath } = mkRunner();
  const runner = createActiveTestRunner({
    clock: () => Date.UTC(2026, 9, 5, 0, 0, 1),
    planBuilder: ({ root, base: b, mode }) => buildTestPlan({ root, base: b, mode }),
    spawnImpl: (exe, args) => ({ status: 0, stdout: tapFor(args.length - 2), stderr: '', signal: null, error: null }),
  });
  const g = runner.runGate({ record: fixtureRecord(dir, base, runsPath) });
  assert.equal(g.ok, true, JSON.stringify(g).slice(0, 600));

  const [rec] = readTestRunRecords(runsPath);
  assert.equal(rec.result, 'PASS', 'a proven run is still persisted as PASS');
  assert.equal(rec.refusal, null, 'no refusal is invented for a clean run');
  assert.equal(rec.planContentSnapshotAfter.digest, rec.plan.contentBinding.digest,
    'the AFTER binding equals the planned content for a clean run');
  const raw = fs.readFileSync(rec.rawLogPath, 'utf8');
  const c = verifyActiveRunPlanBinding({ record: rec, rawText: raw, expectedBaseSha: base });
  assert.equal(c.ok, true, JSON.stringify(c));
});

// ==== PR-285 ROUND-12 — final-review finding F3: SELECTION AUTHORITY ====
// `planDigest` only proves the JSON was re-hashed after it was edited; the
// only authority for `files`/`status`/`mode` is the canonical planner. These
// fixtures have a GENUINE selection, so the forged one below is refused for
// being the wrong selection — not for failing some other check first.

function mkTwoGateFixture() {
  const dir = fs.mkdtempSync(path.join(safeTempBase(), 'plf2-'));
  git(dir, ['init']);
  git(dir, ['-c', 'user.email=plf@t', '-c', 'user.name=plf', 'commit', '--allow-empty', '-m', 'base']);
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'gate.test.mjs'),
    "import test from 'node:test';\ntest('gate fixture', () => {});\n", 'utf8');
  fs.writeFileSync(path.join(dir, 'tests', 'gate2.test.mjs'),
    "import test from 'node:test';\ntest('gate2 fixture', () => {});\n", 'utf8');
  fs.writeFileSync(path.join(dir, 'tracked.md'), 'v1\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'tests', 'tiers.json'), `${JSON.stringify({
    version: '1',
    always: [],
    smoke: ['gate.test.mjs', 'gate2.test.mjs'],
    pathMappings: {},
    fullTriggerPaths: [],
    fullTriggerPrefixes: [],
    ignorePrefixes: [],
    ignoreSuffixes: [],
    coreSubsystems: {},
    tiers: { t1: { minTests: 1, files: ['gate.test.mjs', 'gate2.test.mjs'] } },
  }, null, 2)}\n`, 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=plf@t', '-c', 'user.name=plf', 'commit', '-m', 'head']);
  // The BASE is the COMMIT THAT CONTAINS THE FIXTURE, so the only later delta
  // is the one each test makes. (Taking it from the empty first commit would
  // make every fixture file an unclassified change and force FULL forever.)
  const base = git(dir, ['rev-parse', 'HEAD']);
  // An UNCLASSIFIED change -> the planner's own FULL selection over BOTH owned
  // tests. That plan is the authority a forged one has to imitate exactly.
  fs.writeFileSync(path.join(dir, 'tracked.md'), 'v2 - unclassified\n', 'utf8');
  const built = buildTestPlan({ root: dir, base, mode: 'auto' });
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.equal(built.plan.status, 'READY', JSON.stringify(built.plan));
  assert.ok(built.plan.files.length >= 2,
    `the fixture must have at least two selected tests to narrow: ${JSON.stringify(built.plan.files)}`);
  return { dir, base, plan: built.plan };
}

test('rework12(F3): a narrowed or mode-flipped selection + re-hash is refused on BOTH sides — no spawn, no record, no read-back', () => {
  const { dir, base, plan: canonical } = mkTwoGateFixture();
  const { runsPath } = mkRunner();
  let spawned = 0;
  const runner = planRunner((file, args) => { spawned += 1; return spawnTap()(file, args); }, { tracker: planTracker(dir) });
  const record = planRecord(runsPath, { worktreePath: dir, baseSha: base });

  // (1) the SPLIT selection, re-hashed so every self-consistency check passes.
  const narrowed = { ...canonical, files: canonical.files.slice(0, 1) };
  narrowed.planDigest = recomputePlanDigest(narrowed);
  const g = runner.runGate({ record, plan: { ok: true, plan: narrowed } });
  assert.equal(g.ok, false, JSON.stringify(g).slice(0, 600));
  assert.equal(g.code, ACTIVE_TEST_GATE_CODES.PLAN_INVALID);
  assert.equal(g.detail.planCode, TEST_PLAN_CODES.SELECTION_MISMATCH,
    'the validator names the SELECTION, not a hash/structure problem');
  assert.match(String(g.detail.reason), /canonical planner output/);
  assert.equal(spawned, 0, 'a narrowed selection never executes');
  assert.equal(readTestRunRecords(runsPath).length, 0, 'nothing is persisted for a refused selection');

  // (2) a mode FLIP + re-hash is the same refusal (mode is part of the
  //     selection the authority vouches for).
  const flipped = { ...canonical, mode: canonical.mode === 'full' ? 'affected' : 'full' };
  flipped.planDigest = recomputePlanDigest(flipped);
  const g2 = runner.runGate({ record, plan: { ok: true, plan: flipped } });
  assert.equal(g2.ok, false, JSON.stringify(g2).slice(0, 600));
  assert.equal(g2.detail.planCode, TEST_PLAN_CODES.SELECTION_MISMATCH);
  assert.equal(spawned, 0);

  // (3) a legitimate run whose STORED record is narrowed afterwards — with the
  //     argv and command realigned to the fake selection, so nothing but the
  //     selection is wrong — is refused by the CONSUMER read-back.
  const okRun = runner.runGate({ record, plan: { ok: true, plan: canonical } });
  assert.equal(okRun.ok, true, JSON.stringify(okRun).slice(0, 600));
  const rec = readTestRunRecords(runsPath)[0];
  assert.ok(rec, 'the legitimate run is persisted');
  const forged = { ...rec, plan: { ...rec.plan, files: narrowed.files, planDigest: recomputePlanDigest(narrowed) } };
  forged.spawn = { ...(rec.spawn || {}), argv: ['--test', '--test-reporter=tap', ...forged.plan.files] };
  forged.command = ['node --test', ...forged.spawn.argv].join(' ');
  const v = verifyActiveRunPlanBinding({
    record: forged, rawText: fs.readFileSync(rec.rawLogPath, 'utf8'), expectedBaseSha: base,
  });
  assert.equal(v.ok, false, JSON.stringify(v).slice(0, 600));
  assert.equal(v.code, TEST_PLAN_CODES.SELECTION_MISMATCH,
    'a stored selection the planner never produced is refused at read-back');
});

test('rework12(F3): a GENUINELY narrower selection — the planner\'s own — is still accepted end to end', () => {
  // The authority is the PLANNER, not "bigger is better": a single-test
  // selection produced by the planner must spawn and read back green, or the
  // fix would have traded one false green for a blanket refusal.
  const { dir, base } = mkTwoGateFixture();
  // Clear the helper's unclassified change, so ONLY this test file differs:
  // the selection must then be the planner's affected set, not the FULL one.
  fs.writeFileSync(path.join(dir, 'tracked.md'), 'v1\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'tests', 'gate2.test.mjs'),
    "import test from 'node:test';\ntest('gate2 fixture', () => { if (1 !== 1) throw new Error('never'); });\n", 'utf8');
  const narrow = buildTestPlan({ root: dir, base, mode: 'auto' });
  assert.equal(narrow.ok, true, JSON.stringify(narrow));
  assert.equal(narrow.plan.status, 'READY');
  assert.ok(narrow.plan.files.includes('tests/gate2.test.mjs'), JSON.stringify(narrow.plan.files));
  assert.equal(narrow.plan.files.includes('tests/gate.test.mjs'), false,
    `the affected selection really is narrower than FULL: ${JSON.stringify(narrow.plan.files)}`);

  const { runsPath } = mkRunner();
  const runner = planRunner(spawnTap(), { tracker: planTracker(dir) });
  const g = runner.runGate({ record: planRecord(runsPath, { worktreePath: dir, baseSha: base }) });
  assert.equal(g.ok, true, JSON.stringify(g).slice(0, 600));
  assert.equal(readTestRunRecords(runsPath).length, 1, 'the legitimate selection runs and persists');

  const [rec] = readTestRunRecords(runsPath);
  const raw = fs.readFileSync(rec.rawLogPath, 'utf8');
  const v = verifyActiveRunPlanBinding({ record: rec, rawText: raw, expectedBaseSha: base });
  assert.equal(v.ok, true, JSON.stringify(v));
});
// ==== END PR-285 ROUND-12 (F3) ====

// ---- PR-285 rework16 F3: the REQUIRED mode is trusted policy, not plan.mode --
// The reviewer's trigger: the fixture's AFFECTED selection is genuinely smaller
// than FULL, and a caller hands the runner a REAL (canonical) affected plan for
// the same base/HEAD/content while the runner was asked for `full`. PRE-fix the
// supplied plan short-circuited the plan builder and was then validated against
// its OWN `mode`, so the mandatory FULL never happened: a smaller selection
// spawned and was certified.
test('rework16(F3): a REQUIRED full run refuses a supplied AFFECTED plan — the mode never comes from the plan', () => {
  const { dir, base } = mkTwoGateFixture();
  // Clear the helper's unclassified change: the canonical selection is then the
  // planner's AFFECTED set, genuinely smaller than FULL.
  fs.writeFileSync(path.join(dir, 'tracked.md'), 'v1\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'tests', 'gate2.test.mjs'),
    "import test from 'node:test';\ntest('gate2 fixture', () => { if (1 !== 1) throw new Error('never'); });\n", 'utf8');
  const affected = buildTestPlan({ root: dir, base, mode: 'affected' });
  assert.equal(affected.ok, true, JSON.stringify(affected));
  assert.equal(affected.plan.mode, 'affected', JSON.stringify(affected.plan));
  const full = buildTestPlan({ root: dir, base, mode: 'full' });
  assert.equal(full.ok, true, JSON.stringify(full));
  assert.equal(full.plan.mode, 'full');
  assert.ok(full.plan.files.length > affected.plan.files.length,
    `the mandatory FULL set must really be bigger: ${JSON.stringify({ affected: affected.plan.files, full: full.plan.files })}`);

  const { runsPath } = mkRunner();
  let spawned = 0;
  const spawn = (file, args) => { spawned += 1; return spawnTap()(file, args); };
  const record = planRecord(runsPath, { worktreePath: dir, baseSha: base });

  // (1) the requirement comes from the CALL.
  const runner = planRunner(spawn, { tracker: planTracker(dir) });
  const g1 = runner.runGate({ record, plan: { ok: true, plan: affected.plan }, mode: 'full' });
  assert.equal(g1.ok, false, JSON.stringify(g1).slice(0, 700));
  assert.equal(g1.code, ACTIVE_TEST_GATE_CODES.PLAN_INVALID);
  assert.equal(g1.detail.planCode, TEST_PLAN_CODES.SELECTION_MISMATCH,
    'the refusal names the SELECTION, not a hash/structure problem');
  assert.equal(spawned, 0, 'the mandatory FULL selection never becomes a smaller spawn');
  assert.equal(readTestRunRecords(runsPath).length, 0, 'nothing is persisted for a refused selection');

  // (2) the requirement comes from the runner's OWN configured policy.
  const runner2 = planRunner(spawn, { tracker: planTracker(dir), planMode: 'full' });
  const g2 = runner2.runGate({ record, plan: { ok: true, plan: affected.plan } });
  assert.equal(g2.ok, false, JSON.stringify(g2).slice(0, 700));
  assert.equal(g2.detail.planCode, TEST_PLAN_CODES.SELECTION_MISMATCH,
    'planMode is the trusted policy too — a supplied plan cannot substitute its own');
  assert.equal(spawned, 0, 'no spawn under the configured policy either');

  // (3) POSITIVE CONTROL — the SAME plan under the policy it really satisfies is
  //     the planner's own output and still runs end to end: the fix must not
  //     trade a false green for a blanket refusal of affected plans.
  const g3 = runner.runGate({ record, plan: { ok: true, plan: affected.plan }, mode: 'auto' });
  assert.equal(g3.ok, true, JSON.stringify(g3).slice(0, 700));
  assert.equal(spawned, 1, "the planner's own affected selection is not refused");
  assert.equal(readTestRunRecords(runsPath).length, 1);
  // (4) and the FULL requirement is satisfied by the canonical FULL plan.
  const g4 = runner.runGate({ record, plan: { ok: true, plan: full.plan }, mode: 'full' });
  assert.equal(g4.ok, true, JSON.stringify(g4).slice(0, 700));
  assert.equal(spawned, 2);
});

// ---- PR-285 rework17 F3: an UNKNOWN mode is refused, never silently relaxed --
// The rework16 comment claimed an invalid mode was refused with PLAN_INVALID,
// while the code actually COERCED it to 'auto': a typo (or a bad
// SOC_TEST_PLAN_MODE) silently downgraded the runner's trusted policy. Fail
// closed instead — no spawn, no record, and the refusal names the mode.
test('rework17(F3): an unknown mode is refused with PLAN_INVALID — never coerced into a weaker requirement', () => {
  const { dir, base, plan: canonical } = mkTwoGateFixture();
  const { runsPath } = mkRunner();
  let spawned = 0;
  const spawn = (file, args) => { spawned += 1; return spawnTap()(file, args); };
  const runner = planRunner(spawn, { tracker: planTracker(dir) });
  const record = planRecord(runsPath, { worktreePath: dir, baseSha: base });

  // (1) a typo on the CALL. PRE-fix it was read as 'auto' and spawned anyway.
  const g1 = runner.runGate({ record, plan: { ok: true, plan: canonical }, mode: 'afected' });
  assert.equal(g1.ok, false, JSON.stringify(g1).slice(0, 700));
  assert.equal(g1.code, ACTIVE_TEST_GATE_CODES.PLAN_INVALID);
  assert.match(String(g1.detail.reason), /afected/);
  assert.equal(spawned, 0, 'a misspelled mode never relaxes the policy into a spawn');
  assert.equal(readTestRunRecords(runsPath).length, 0, 'nothing is persisted for an unknown mode');

  // (2) the runner's OWN configured policy is held to the same standard.
  const runner2 = planRunner(spawn, { tracker: planTracker(dir), planMode: 'FULL' });
  const g2 = runner2.runGate({ record, plan: { ok: true, plan: canonical } });
  assert.equal(g2.ok, false, JSON.stringify(g2).slice(0, 700));
  assert.equal(g2.code, ACTIVE_TEST_GATE_CODES.PLAN_INVALID);
  assert.equal(spawned, 0, 'a bad configured mode fails closed too — never a silent downgrade');

  // (3) POSITIVE CONTROL — a recognized mode still runs end to end (the fix must
  //     not trade a silent downgrade for a blanket refusal).
  const g3 = runner.runGate({ record, plan: { ok: true, plan: canonical }, mode: 'auto' });
  assert.equal(g3.ok, true, JSON.stringify(g3).slice(0, 700));
  assert.equal(spawned, 1);
});


console.log('test-run-evidence: all offline tests passed');
