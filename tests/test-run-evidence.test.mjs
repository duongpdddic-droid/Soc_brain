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
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  createTestRunRecorder, readTestRunRecords, testRunsPathFor, isTestCommand, parseExitCode,
  createActiveTestRunner, resolveTestGateCommand, activeTestRunLogDir, ACTIVE_TEST_GATE_CODES,
} from '../packages/executor-launcher/test-run-evidence.mjs';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tre-'));
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
  const runsPath = path.join(os.tmpdir(), `tre-${Date.now()}.testruns.jsonl`);
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
  const runsPath = path.join(os.tmpdir(), `tre-mid-${Date.now()}.testruns.jsonl`);
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
  const runsPath = path.join(os.tmpdir(), `tre-unproven-${Date.now()}.testruns.jsonl`);
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
  const runsPath = path.join(os.tmpdir(), `tre-nostart-${Date.now()}.testruns.jsonl`);
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
  const runsPath = path.join(os.tmpdir(), `tre-index-${Date.now()}.testruns.jsonl`);
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
  const events = path.join(path.resolve(os.tmpdir(), 'test-state'), 'executions', `${IDENTITY}.events.jsonl`);
  assert.equal(testRunsPathFor({ eventsPath: events }), path.join(path.resolve(os.tmpdir(), 'test-state'), 'executions', `${IDENTITY}.testruns.jsonl`));
  assert.equal(testRunsPathFor({ stateDir: path.resolve(os.tmpdir(), 'test-state'), identityHash: IDENTITY }), path.join(path.resolve(os.tmpdir(), 'test-state'), 'executions', `${IDENTITY}.testruns.jsonl`));
  assert.equal(testRunsPathFor({ eventsPath: 'no-suffix.json', stateDir: null, identityHash: null }), null, 'an unrecognised path never yields a guess');
  assert.deepEqual(readTestRunRecords(null), [], 'an absent store reads as ZERO runs, never as PASS');
  assert.deepEqual(readTestRunRecords(path.join(os.tmpdir(), 'does-not-exist.testruns.jsonl')), []);
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
  const runsPath = path.join(os.tmpdir(), `active-${Date.now()}-${Math.random().toString(16).slice(2)}.testruns.jsonl`);
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
  const runsPath = path.join(path.resolve(os.tmpdir(), 'test-state'), 'executions', `${IDENTITY}.testruns.jsonl`);
  assert.equal(activeTestRunLogDir({ runsPath }), path.join(path.resolve(os.tmpdir(), 'test-state'), 'executions', `${IDENTITY}.testrun-logs`));
  assert.equal(
    activeTestRunLogDir({ stateDir: path.resolve(os.tmpdir(), 'test-state'), identityHash: IDENTITY }),
    path.join(path.resolve(os.tmpdir(), 'test-state'), 'executions', `${IDENTITY}.testrun-logs`),
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

console.log('test-run-evidence: all offline tests passed');
