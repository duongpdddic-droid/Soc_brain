// tests/control-loop-self-healing.test.mjs — FSM Self-Healing (Issue:
// auto-fallback to synthesize a missing hydrated execution record).
//
// Production defect covered: when a task hydrates with a session/ledger whose
// canonical ExecutionRecord ($stateDir/executions/<identityHash>.json) is
// missing (ENOENT), the VERIFY leg used to die with a generic
// VERIFY_FAILED / INTERNAL_REVIEW_EXECUTION_RECORD_MISSING and the task could
// never reach INTERNAL_REVIEW or terminalization (the delivery leg re-reads
// the SAME record for its identity chain).
//
// The self-healing contract proved here:
//   SH-1  record ABSENT -> ONE bounded verification synthesis (a REAL offline
//         test gate through the injected runGate seam, then a real content
//         binding stamp) writes a candidate-bound ExecutionRecord; the verify
//         leg re-enters the SAME composite, crosses VERIFYING->PRE_REVIEWING
//         and the walk reaches COMPLETED (packet + terminal identity chain).
//   SH-2  record PRESENT but integrity-mismatched (foreign head / corrupt
//         bytes) -> typed INTEGRITY_MISMATCH, the gate never runs, the record
//         is NEVER overwritten, no synthesis attempt is burned.
//   SH-3  synthesis gate fails / throws / cannot prove a content binding ->
//         typed HEALING_ATTEMPT_EXHAUSTED, NO record is fabricated, the head
//         keeps exactly ONE recorded attempt across relaunches (no retry
//         loop, no second gate run).
//   SH-4  head-key boundary: an UNPROVABLE session.headSha (missing, null,
//         empty, non-hex) refuses with typed INTEGRITY_MISMATCH /
//         UNPROVABLE_HEAD_SHA_FOR_HEALING BEFORE the ledger is even read —
//         the healing budget is never spent without a proven commit HEAD, and
//         a recorded attempt for commit A is never counted against commit B.
//   SH-5  durable concurrency: an atomic ledger write whose read-back attempt
//         count drifts (a concurrent writer landed in between) is typed
//         HEALING_LEDGER_CONCURRENT_MUTATION, never a silent success.
//   SH-6  downstream hygiene: a synthesized record always carries STRING
//         model/agent fields ('unknown' / 'build' defaults, session values
//         pass through) so downstream reporters/scanners never read null.
//
// Fail-closed invariants (from the task manifest):
//   * only a truly ABSENT record is healable; present-but-wrong is integrity;
//   * healingAttempts[headSha] <= 1 — persisted BEFORE synthesis;
//   * synthesis must run the real offline test gate (never a dummy record);
//   * the module spawns nothing itself (the gate arrives via DI) and never
//     console.logs raw diagnostics.
//
// The verify leg in SH-1..SH-3 is the REAL production composite
// (preGateReviewVerifierAdapter + deterministicVerifierAdapter): only the OCR
// transport and the gate runners are injected, so the synthesized record must
// satisfy the actual pre-gate candidate derivation, the actual deterministic
// record checks, the handoff content-binding gate and the terminalize
// identity chain — exactly like production.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  runControlLoop,
  readTransitions,
} from '../packages/control-loop/control-loop.mjs';
import { preGateReviewVerifierAdapter } from '../packages/control-loop/pre-gate-review.mjs';
import { deterministicVerifierAdapter } from '../packages/control-loop/adapters.mjs';
import {
  recordHealingAttempt,
  synthesizeExecutionRecord,
  withExecutionRecordSelfHealing,
} from '../packages/control-loop/execution-record-self-healing.mjs';
import { computeWorktreeContentBinding } from '../packages/executor-launcher/execution-content-binding.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { readSessionRecord } from '../packages/runtime-sandbox/runtime-sandbox.mjs';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_FOREIGN = 'c'.repeat(40);
const BASE = 'f'.repeat(40);
const ISSUE = 9010;
const BRANCH = 'soc/issue-9010-self-healing';
const REPO = 'duongpdddic-droid/soc_brain';
const PROJECT_ID = 'soc_brain';
const TASK_ID = `${REPO}#${ISSUE}`;
const ID = identityHash({ repo: REPO, issueNumber: ISSUE });

const recordPath = (stateDir) => path.join(stateDir, 'executions', `${ID}.json`);
const healingLedgerPath = (stateDir) =>
  path.join(stateDir, 'control-loop', ID, 'execution-record-healing.json');

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'self-healing-')); }

function mkSession(stateDir, overrides = {}) {
  const sessionPath = path.join(stateDir, 'sessions', `${ID}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1', state: 'SESSION_ACTIVE', lifecycle: [],
    taskId: TASK_ID, repo: REPO, issueNumber: ISSUE, identityHash: ID,
    prNumber: 4242, headSha: HEAD_A, baseSha: BASE, branch: BRANCH,
    worktreePath: path.join(stateDir, 'wt'), worktreesRoot: stateDir,
    controlPlane: { stateDir },
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session };
}

// Deterministic in-memory git covering exactly what the publish chain, the
// commit-recovery dirty scan and the refresh use (same shape as the handoff
// suite). `state.head` is shared so a fixture can move HEAD between phases.
function fakeGit(state = { head: HEAD_A, remoteRef: null, pushes: 0, dirty: '' }) {
  const exec = (a0, opts) => {
    const a = (Array.isArray(a0) ? a0 : (opts && opts.args) || []).map(String);
    if (a[0] === 'rev-parse' && a[1] === 'HEAD') return { status: 0, stdout: `${state.head}\n`, stderr: '' };
    if (a[0] === 'status') return { status: 0, stdout: state.dirty ? `${state.dirty}\n` : '', stderr: '' };
    if (a[0] === 'diff') return { status: state.head === BASE ? 0 : 1, stdout: '', stderr: '' };
    if (a[0] === 'merge-base') return { status: 0, stdout: '', stderr: '' };
    if (a[0] === 'ls-remote') return { status: 0, stdout: state.remoteRef ? `${state.remoteRef}\t${a[2]}\n` : '', stderr: '' };
    if (a[0] === 'push') { state.remoteRef = a[2].split(':')[0]; state.pushes += 1; return { status: 0, stdout: '', stderr: '' }; }
    if (a[0] === 'show') return { status: 1, stdout: '', stderr: '' };
    if (a[0] === 'log') return { status: 0, stdout: '', stderr: '' };
    if (a[0] === 'ls-files') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: `unmocked git: ${a.join(' ')}` };
  };
  return { state, exec };
}

function fakeGh(state, { issue = ISSUE, branch = BRANCH, number = 4242 } = {}) {
  const calls = [];
  const j = (code, obj, stderr = '') => ({ code, stdout: obj === undefined ? '' : JSON.stringify(obj), stderr });
  const gh = (args) => {
    const a = args.map(String);
    calls.push(a.join(' '));
    if (a[0] === 'issue' && a[1] === 'view') return j(0, { title: 'self-healing task', body: 'acceptance' });
    if (a[0] === 'pr' && a[1] === 'list') return j(0, []);
    if (a[0] === 'pr' && a[1] === 'create') { state.remoteRef = state.remoteRef ?? state.head; return { code: 0, stdout: `https://github.com/${REPO}/pull/${number}\n`, stderr: '' }; }
    if (a[0] === 'pr' && a[1] === 'view') {
      return j(0, {
        number, state: 'OPEN', headRefOid: state.remoteRef ?? state.head, headRefName: branch,
        baseRefName: 'main', headRepository: { nameWithOwner: REPO },
        url: `https://github.com/${REPO}/pull/${number}`,
        body: `Closes #${issue}\n\n<!-- soc-brain:identity=${ID} -->`,
      });
    }
    return j(1, undefined, 'unmocked gh');
  };
  gh.calls = calls;
  return gh;
}

function loopDeps({ git, gh, verifier, executor }) {
  return {
    pushExec: git.exec,
    gh,
    router: () => ({ ok: true, value: { executorKind: 'opencode', model: 'x' } }),
    executor: executor ?? (() => ({ ok: true, value: { executionRecordPath: 'x' } })),
    verifier,
    preReview: () => ({ ok: true, value: { verdict: 'PASS', findings: [] } }),
    // Production's raw-text verdict path stamps this session binding onto the
    // decision; the fixture models that bound decision (read live).
    finalReview: (ctx) => {
      const rs = ctx && ctx.sessionPath ? readSessionRecord(ctx.sessionPath) : null;
      const head = rs && rs.ok && rs.session && typeof rs.session.headSha === 'string' ? rs.session.headSha : null;
      return {
        ok: true,
        value: {
          verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.99, metadata: {},
          ...(head ? { binding: { repository: REPO, issue: ISSUE, headSha: head } } : {}),
        },
      };
    },
    delivery: () => ({ ok: true, value: { shipped: true } }),
    telegramSpawn: () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 1 })}\n` }),
  };
}

const packetsIn = (stateDir) => {
  try { return fs.readdirSync(path.join(stateDir, 'review-ready')); } catch { return []; }
};
const packetTexts = (stateDir) => packetsIn(stateDir).map((f) => fs.readFileSync(path.join(stateDir, 'review-ready', f), 'utf8'));

function makeRegistry(stateDir, repository = REPO) {
  const registryPath = path.join(stateDir, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({
    schemaVersion: '1',
    projects: [{ projectId: PROJECT_ID, repository }],
  }), 'utf8');
  return registryPath;
}

function approvedTransport() {
  return async (req) => ({
    ok: true,
    verdict: 'APPROVED',
    finalReview: true,
    reviewedHeadSha: req && typeof req.headSha === 'string' ? req.headSha : null,
    decisionGate: { status: 'PASS' },
    findings: [],
    openBlocking: [],
  });
}

// The REAL production verify leg: pre-gate composite (candidate derivation +
// OCR leg + re-check) over the REAL deterministic record verifier. Only the
// OCR transport and the two gate runners are injected spies.
function realVerifier({ registryPath, verifyGateSpy, transportSpy }) {
  return preGateReviewVerifierAdapter({
    innerVerifier: deterministicVerifierAdapter({ activeTestRunner: verifyGateSpy }),
    transport: async (req) => {
      transportSpy.calls.push(req);
      return approvedTransport()(req);
    },
    registryPath,
  });
}

// A REAL git worktree (T7 pattern): the synthesis stamps the content binding
// with the production primitive, so the worktree must be an actual repository.
function mkRealWorktree(stateDir) {
  const wt = path.join(stateDir, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  const run = (args) => {
    const r = spawnSync('git', args, { cwd: wt, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} -> ${r.status}: ${r.stderr || r.stdout}`);
    return r.stdout ?? '';
  };
  run(['init', '-q']);
  run(['config', 'user.email', 'self-healing@example.test']);
  run(['config', 'user.name', 'self-healing']);
  run(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(wt, 'app.js'), 'export const v = 1;\n', 'utf8');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'self-healing candidate']);
  const head = run(['rev-parse', 'HEAD']).trim().toLowerCase();
  return { path: wt, head };
}

// ---- SH-1 ---------------------------------------------------------------------
test('SH-1. missing execution record -> one-shot verification synthesis -> COMPLETED with a real candidate-bound record', async () => {
  const stateDir = mkStateDir();
  const wt = mkRealWorktree(stateDir);
  const registryPath = makeRegistry(stateDir);
  const { sessionPath } = mkSession(stateDir, { worktreePath: wt.path, headSha: wt.head, baseSha: BASE });
  const git = fakeGit({ head: wt.head });
  const gh = fakeGh(git.state);
  const execPath = recordPath(stateDir);
  assert.equal(fs.existsSync(execPath), false, 'precondition: the execution record is absent');

  let healingGateCalls = 0;
  let verifyGateCalls = 0;
  const transportSpy = { calls: [] };
  const deps = loopDeps({
    git, gh,
    executor: () => ({ ok: true, value: { executionRecordPath: execPath } }),
    verifier: realVerifier({
      registryPath,
      verifyGateSpy: async ({ session, record }) => {
        verifyGateCalls += 1;
        assert.equal(session.worktreePath, wt.path);
        assert.equal(path.resolve(record.worktreePath), path.resolve(wt.path));
        return { ok: true, exitCode: 0, runId: `verify-${verifyGateCalls}`, command: 'node --test', rawLogPath: null };
      },
      transportSpy,
    }),
  });
  deps.executionRecordHealing = {
    runGate: async ({ session, record }) => {
      healingGateCalls += 1;
      // The synthesis runs against the SAME bound session/record it is about
      // to persist — the offline test gate is the healing evidence.
      assert.equal(session.worktreePath, wt.path);
      assert.equal(record.identityHash, ID);
      assert.equal(record.taskId, TASK_ID);
      return { ok: true, exitCode: 0, runId: 'heal-1', command: 'node --test', rawLogPath: null };
    },
  };

  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');

  // Exactly one synthesis attempt; the verify leg then re-ran its own gate
  // once against the healed record (production semantics: the composite is
  // re-entered after the record exists).
  assert.equal(healingGateCalls, 1, 'the offline test gate ran exactly once inside the synthesis');
  assert.equal(verifyGateCalls, 1, 'the deterministic verify gate ran once against the healed record');
  assert.equal(transportSpy.calls.length, 1, 'the OCR leg never ran while the record was missing');

  // The synthesized record is real, terminal and bound to THIS candidate.
  const rec = JSON.parse(fs.readFileSync(execPath, 'utf8'));
  assert.equal(rec.schemaVersion, '1');
  assert.equal(rec.kind, 'ExecutionRecord');
  assert.equal(rec.identityHash, ID);
  assert.equal(rec.repo, REPO);
  assert.equal(rec.issueNumber, ISSUE);
  assert.equal(rec.taskId, TASK_ID);
  assert.equal(path.resolve(rec.worktreePath), path.resolve(wt.path));
  assert.equal(rec.terminalStatus, 'EXITED');
  assert.equal(rec.exitCode, 0);
  assert.equal(rec.signal, null);
  assert.equal(rec.headSha, wt.head);
  assert.match(String(rec.codeContentDigest), /^[0-9a-f]{64}$/);
  const live = computeWorktreeContentBinding({ worktreePath: wt.path, headSha: null });
  assert.equal(live.ok, true, JSON.stringify(live));
  assert.equal(rec.codeContentDigest, live.value.contentDigest, 'the stamped binding IS the live tracked content');
  assert.equal(rec.headSha, live.value.headSha);

  // Bounded attempt ledger: exactly one recorded attempt for this head.
  const ledger = JSON.parse(fs.readFileSync(healingLedgerPath(stateDir), 'utf8'));
  assert.equal(ledger.identityHash, ID);
  assert.equal(ledger.attempts.length, 1, JSON.stringify(ledger));
  assert.equal(String(ledger.attempts[0].headSha).toLowerCase(), wt.head);

  // The walk never saw a BLOCKED boundary: the healed verify crossed
  // VERIFYING->PRE_REVIEWING and the handoff projected the packet.
  const transitions = readTransitions({ stateDir, identityHash: ID });
  assert.ok(!transitions.some((t) => t.to === 'BLOCKED'),
    JSON.stringify(transitions.map((t) => `${t.from}->${t.to}:${t.reason ?? ''}`)));
  assert.ok(transitions.some((t) => t.from === 'VERIFYING' && t.to === 'PRE_REVIEWING'),
    'the healed verify boundary must cross');
  assert.equal(packetsIn(stateDir).length, 1, 'the READY_FOR_REVIEW packet was projected');
  assert.match(packetTexts(stateDir)[0], /READY_FOR_REVIEW/);
});

// ---- SH-2 ---------------------------------------------------------------------
test('SH-2. a present-but-integrity-mismatched record is never healed, never gated and never overwritten', async () => {
  // (a) a record bound to a FOREIGN head -> INTEGRITY_MISMATCH.
  {
    const stateDir = mkStateDir();
    const registryPath = makeRegistry(stateDir);
    const wtPath = path.join(stateDir, 'wt'); // no real repo: never reaches binding
    const { sessionPath } = mkSession(stateDir, { worktreePath: wtPath, headSha: HEAD_A });
    const git = fakeGit({ head: HEAD_A });
    const gh = fakeGh(git.state);
    const execPath = recordPath(stateDir);
    fs.mkdirSync(path.dirname(execPath), { recursive: true });
    const foreign = {
      schemaVersion: '1', kind: 'ExecutionRecord', identityHash: ID,
      repo: REPO, issueNumber: ISSUE, taskId: TASK_ID, worktreePath: wtPath,
      baseSha: BASE, headSha: HEAD_FOREIGN,
      terminalStatus: 'EXITED', exitCode: 0, signal: null,
      codeContentDigest: 'd'.repeat(64),
    };
    fs.writeFileSync(execPath, JSON.stringify(foreign, null, 2), 'utf8');
    const before = fs.readFileSync(execPath, 'utf8');

    let healingGateCalls = 0;
    let verifyGateCalls = 0;
    const transportSpy = { calls: [] };
    const deps = loopDeps({
      git, gh,
      executor: () => ({ ok: true, value: { executionRecordPath: execPath } }),
      verifier: realVerifier({
        registryPath,
        verifyGateSpy: async () => { verifyGateCalls += 1; return { ok: true, exitCode: 0 }; },
        transportSpy,
      }),
    });
    deps.executionRecordHealing = {
      runGate: async () => { healingGateCalls += 1; return { ok: true, exitCode: 0 }; },
    };

    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.code, 'INTEGRITY_MISMATCH');
    assert.equal(healingGateCalls, 0, 'a mismatched record never triggers a synthesis gate');
    assert.equal(verifyGateCalls, 0, 'the deterministic gate never ran on foreign evidence');
    assert.equal(transportSpy.calls.length, 0, 'the OCR leg never ran on foreign evidence');
    assert.equal(fs.readFileSync(execPath, 'utf8'), before, 'the foreign record stays byte-for-byte untouched');
    assert.ok(!fs.existsSync(healingLedgerPath(stateDir)),
      'an integrity refusal burns NO synthesis attempt');

    const transitions = readTransitions({ stateDir, identityHash: ID });
    const tail = transitions[transitions.length - 1];
    assert.equal(tail.from, 'VERIFYING');
    assert.equal(tail.to, 'BLOCKED');
    assert.equal(tail.reason, 'verify:FAIL');
    assert.equal(tail.evidence && tail.evidence.code, 'INTEGRITY_MISMATCH', JSON.stringify(tail.evidence));
    assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE',
      'an integrity refusal never terminalizes');
  }

  // (b) corrupt record bytes -> the same integrity refusal, still untouched.
  {
    const stateDir = mkStateDir();
    const registryPath = makeRegistry(stateDir);
    const { sessionPath } = mkSession(stateDir, { headSha: HEAD_A });
    const git = fakeGit({ head: HEAD_A });
    const gh = fakeGh(git.state);
    const execPath = recordPath(stateDir);
    fs.mkdirSync(path.dirname(execPath), { recursive: true });
    const corrupt = '{"schemaVersion": "1", "kind": "ExecutionRecord", "trunc';
    fs.writeFileSync(execPath, corrupt, 'utf8');

    let healingGateCalls = 0;
    const deps = loopDeps({
      git, gh,
      executor: () => ({ ok: true, value: { executionRecordPath: execPath } }),
      verifier: realVerifier({
        registryPath,
        verifyGateSpy: async () => { throw new Error('the gate must never run on corrupt evidence'); },
        transportSpy: { calls: [] },
      }),
    });
    deps.executionRecordHealing = {
      runGate: async () => { healingGateCalls += 1; return { ok: true, exitCode: 0 }; },
    };

    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.code, 'INTEGRITY_MISMATCH');
    assert.equal(healingGateCalls, 0);
    assert.equal(fs.readFileSync(execPath, 'utf8'), corrupt, 'corrupt bytes are evidence, never repaired in place');
    assert.ok(!fs.existsSync(healingLedgerPath(stateDir)));
    assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE');
  }
});

// ---- SH-3 ---------------------------------------------------------------------
test('SH-3. a failing synthesis keeps the single-attempt budget typed and never fabricates a record', async () => {
  // (a) gate FAILS on run 1 -> HEALING_ATTEMPT_EXHAUSTED; the relaunch re-enters
  //     the verify step, finds the attempt spent and does NOT run the gate again.
  {
    const stateDir = mkStateDir();
    const registryPath = makeRegistry(stateDir);
    const { sessionPath } = mkSession(stateDir, { headSha: HEAD_A });
    const git = fakeGit({ head: HEAD_A });
    const gh = fakeGh(git.state);
    const execPath = recordPath(stateDir);

    let healingGateCalls = 0;
    const makeDeps = () => {
      const deps = loopDeps({
        git, gh,
        executor: () => ({ ok: true, value: { executionRecordPath: execPath } }),
        verifier: realVerifier({
          registryPath,
          verifyGateSpy: async () => { throw new Error('the verify gate must never run without a record'); },
          transportSpy: { calls: [] },
        }),
      });
      deps.executionRecordHealing = {
        runGate: async () => {
          healingGateCalls += 1;
          return { ok: false, code: 'ACTIVE_TEST_GATE_NONZERO_EXIT', detail: { exitCode: 1 } };
        },
      };
      return deps;
    };

    const first = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: makeDeps() });
    assert.equal(first.ok, false, JSON.stringify(first));
    assert.equal(first.code, 'HEALING_ATTEMPT_EXHAUSTED');
    assert.equal(first.detail && first.detail.phase, 'gate', JSON.stringify(first.detail));
    assert.equal(healingGateCalls, 1, 'the synthesis gate ran exactly once');
    assert.equal(fs.existsSync(execPath), false, 'a failed gate never fabricates a record');
    const ledger1 = JSON.parse(fs.readFileSync(healingLedgerPath(stateDir), 'utf8'));
    assert.equal(ledger1.attempts.length, 1, JSON.stringify(ledger1));
    assert.equal(String(ledger1.attempts[0].headSha).toLowerCase(), HEAD_A);
    let tail = readTransitions({ stateDir, identityHash: ID }).slice(-1)[0];
    assert.equal(tail.to, 'BLOCKED');
    assert.equal(tail.evidence && tail.evidence.code, 'HEALING_ATTEMPT_EXHAUSTED', JSON.stringify(tail.evidence));
    assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE');

    const second = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: makeDeps() });
    assert.equal(second.ok, false, JSON.stringify(second));
    assert.equal(second.code, 'HEALING_ATTEMPT_EXHAUSTED');
    assert.equal(healingGateCalls, 1, 'the spent attempt never re-runs the gate (no retry loop)');
    assert.equal(second.detail && second.detail.attempts, 1, JSON.stringify(second.detail));
    assert.equal(fs.existsSync(execPath), false, 'still no fabricated record after the relaunch');
    assert.equal(JSON.parse(fs.readFileSync(healingLedgerPath(stateDir), 'utf8')).attempts.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE');
  }

  // (b) gate PASSes but the content binding cannot be proven -> no record may
  //     be written (an unbound record would launder a fake candidate).
  {
    const stateDir = mkStateDir();
    const registryPath = makeRegistry(stateDir);
    const { sessionPath } = mkSession(stateDir, { headSha: HEAD_A }); // wt is not a git repo
    const git = fakeGit({ head: HEAD_A });
    const gh = fakeGh(git.state);
    const execPath = recordPath(stateDir);

    let healingGateCalls = 0;
    const deps = loopDeps({
      git, gh,
      executor: () => ({ ok: true, value: { executionRecordPath: execPath } }),
      verifier: realVerifier({
        registryPath,
        verifyGateSpy: async () => { throw new Error('the verify gate must never run without a record'); },
        transportSpy: { calls: [] },
      }),
    });
    deps.executionRecordHealing = {
      runGate: async () => { healingGateCalls += 1; return { ok: true, exitCode: 0, runId: 'heal-b', command: 'node --test' }; },
    };

    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.code, 'HEALING_ATTEMPT_EXHAUSTED');
    assert.equal(res.detail && res.detail.phase, 'binding', JSON.stringify(res.detail));
    assert.equal(healingGateCalls, 1);
    assert.equal(fs.existsSync(execPath), false, 'an unprovable binding never writes a record');
    assert.equal(JSON.parse(fs.readFileSync(healingLedgerPath(stateDir), 'utf8')).attempts.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE');
  }

  // (c) the gate THROWS -> typed exhaustion, no record, attempt recorded once.
  {
    const stateDir = mkStateDir();
    const registryPath = makeRegistry(stateDir);
    const { sessionPath } = mkSession(stateDir, { headSha: HEAD_A });
    const git = fakeGit({ head: HEAD_A });
    const gh = fakeGh(git.state);
    const execPath = recordPath(stateDir);

    let healingGateCalls = 0;
    const deps = loopDeps({
      git, gh,
      executor: () => ({ ok: true, value: { executionRecordPath: execPath } }),
      verifier: realVerifier({
        registryPath,
        verifyGateSpy: async () => { throw new Error('the verify gate must never run without a record'); },
        transportSpy: { calls: [] },
      }),
    });
    deps.executionRecordHealing = {
      runGate: async () => { healingGateCalls += 1; throw new Error('gate crashed'); },
    };

    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.code, 'HEALING_ATTEMPT_EXHAUSTED');
    assert.equal(res.detail && res.detail.phase, 'gate', JSON.stringify(res.detail));
    assert.equal(healingGateCalls, 1);
    assert.equal(fs.existsSync(execPath), false);
    assert.equal(JSON.parse(fs.readFileSync(healingLedgerPath(stateDir), 'utf8')).attempts.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE');
  }
});

// ---- shared helpers for SH-4..SH-6 ------------------------------------------
function seedHealingAttempts(stateDir, attempts) {
  const p = healingLedgerPath(stateDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({
    schemaVersion: '1',
    kind: 'ExecutionRecordHealingLedger',
    identityHash: ID,
    attempts,
  }, null, 2), 'utf8');
  return p;
}

// The verify-verifier wrapper under test, bound to a stub underlying verifier
// that emits the canonical pre-gate trigger refusal (record ABSENT).
function healingWrapper(stateDir, sessionPath, runGate) {
  return withExecutionRecordSelfHealing(
    async () => ({ ok: false, code: 'INTERNAL_REVIEW_EXECUTION_RECORD_MISSING' }),
    { stateDir, identityHash: ID, sessionPath, healing: { runGate } },
  );
}

// Simulates a second writer landing on the ledger AFTER our atomic write and
// BEFORE our read-back: every read of `p` from the 2nd one on returns the
// foreign (drifted) bytes. Restored even on throw.
async function withDriftedLedgerReadBack(p, foreignRaw, fn) {
  const orig = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (file, ...rest) {
    if (path.resolve(String(file)) === path.resolve(p)) {
      reads += 1;
      if (reads >= 2) return foreignRaw;
    }
    return orig.call(fs, file, ...rest);
  };
  try { return await fn(); } finally { fs.readFileSync = orig; }
}

// ---- SH-4 ---------------------------------------------------------------------
test('SH-4. an unprovable session.headSha refuses healing before any budget is spent, and commit A\'s history never counts against commit B', async () => {
  const UNPROVABLE_HEADS = [
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['non-hex', 'not-a-commit-sha'],
  ];

  // (a) boundary: no proven commit HEAD -> typed INTEGRITY_MISMATCH, the gate
  //     never runs, NO attempt is recorded and NO record is synthesized.
  for (const [label, headSha] of UNPROVABLE_HEADS) {
    const stateDir = mkStateDir();
    const { sessionPath } = mkSession(stateDir, { headSha });
    let gateCalls = 0;
    const wrapped = healingWrapper(stateDir, sessionPath, async () => {
      gateCalls += 1;
      return { ok: true, exitCode: 0 };
    });

    const res = await wrapped({});
    assert.equal(res && res.ok, false, `${label}: must refuse, got ${JSON.stringify(res)}`);
    assert.equal(res.code, 'INTEGRITY_MISMATCH', `${label}: ${JSON.stringify(res)}`);
    assert.equal(res.detail && res.detail.reason, 'UNPROVABLE_HEAD_SHA_FOR_HEALING', `${label}: ${JSON.stringify(res.detail)}`);
    assert.equal(gateCalls, 0, `${label}: no healing budget may be spent before HEAD is proven`);
    assert.equal(fs.existsSync(healingLedgerPath(stateDir)), false, `${label}: no attempt may be recorded`);
    assert.equal(fs.existsSync(recordPath(stateDir)), false, `${label}: no record may be synthesized`);
  }

  // (b) isolation: commit A's recorded attempt must never be miscounted
  //     against an unprovable head — the refusal is INTEGRITY, not
  //     "budget exhausted because A burned it".
  {
    const stateDir = mkStateDir();
    seedHealingAttempts(stateDir, [{
      at: '2026-01-01T00:00:00.000Z', headSha: HEAD_A, trigger: 'INTERNAL_REVIEW_EXECUTION_RECORD_MISSING',
    }]);
    const { sessionPath } = mkSession(stateDir, { headSha: '' });
    let gateCalls = 0;
    const wrapped = healingWrapper(stateDir, sessionPath, async () => {
      gateCalls += 1;
      return { ok: true, exitCode: 0 };
    });

    const res = await wrapped({});
    assert.equal(res && res.ok, false, JSON.stringify(res));
    assert.equal(res.code, 'INTEGRITY_MISMATCH', `A's history must not be miscounted: ${JSON.stringify(res)}`);
    assert.equal(res.detail && res.detail.reason, 'UNPROVABLE_HEAD_SHA_FOR_HEALING', JSON.stringify(res.detail));
    assert.equal(gateCalls, 0);
    const ledger = JSON.parse(fs.readFileSync(healingLedgerPath(stateDir), 'utf8'));
    assert.equal(ledger.attempts.length, 1, `commit A's entry is untouched: ${JSON.stringify(ledger)}`);
    assert.equal(String(ledger.attempts[0].headSha).toLowerCase(), HEAD_A);
  }

  // (c) isolation: a recorded attempt for commit A does NOT consume commit
  //     B's one-shot budget — B runs its own gate exactly once, then spends.
  {
    const stateDir = mkStateDir();
    seedHealingAttempts(stateDir, [{
      at: '2026-01-01T00:00:00.000Z', headSha: HEAD_A, trigger: 'INTERNAL_REVIEW_EXECUTION_RECORD_MISSING',
    }]);
    const { sessionPath } = mkSession(stateDir, { headSha: HEAD_B });
    let gateCalls = 0;
    const makeWrapped = () => healingWrapper(stateDir, sessionPath, async () => {
      gateCalls += 1;
      return { ok: false, code: 'ACTIVE_TEST_GATE_NONZERO_EXIT', detail: { exitCode: 1 } };
    });

    const first = await makeWrapped()({});
    assert.equal(first && first.ok, false, JSON.stringify(first));
    assert.equal(first.code, 'HEALING_ATTEMPT_EXHAUSTED', JSON.stringify(first));
    assert.equal(gateCalls, 1, 'commit A\'s attempt never spends commit B\'s budget');

    const ledger1 = JSON.parse(fs.readFileSync(healingLedgerPath(stateDir), 'utf8'));
    assert.equal(ledger1.attempts.length, 2, JSON.stringify(ledger1));
    assert.equal(String(ledger1.attempts[0].headSha).toLowerCase(), HEAD_A, 'commit A\'s entry is preserved');
    assert.equal(String(ledger1.attempts[1].headSha).toLowerCase(), HEAD_B, 'commit B records its own attempt');

    const second = await makeWrapped()({});
    assert.equal(second && second.ok, false, JSON.stringify(second));
    assert.equal(second.code, 'HEALING_ATTEMPT_EXHAUSTED', JSON.stringify(second));
    assert.equal(second.detail && second.detail.attempts, 1, JSON.stringify(second.detail));
    assert.equal(gateCalls, 1, 'commit B is now spent — its gate never re-runs');
    assert.equal(JSON.parse(fs.readFileSync(healingLedgerPath(stateDir), 'utf8')).attempts.length, 2,
      'neither commit\'s history is duplicated or lost');
  }
});

// ---- SH-5 ---------------------------------------------------------------------
test('SH-5. a ledger read-back whose attempt count drifts is typed HEALING_LEDGER_CONCURRENT_MUTATION', async () => {
  const foreignRaw = JSON.stringify({
    schemaVersion: '1',
    kind: 'ExecutionRecordHealingLedger',
    identityHash: ID,
    attempts: [],
  }, null, 2);
  const attempt = {
    at: '2026-01-01T00:00:00.000Z', headSha: HEAD_A, trigger: 'INTERNAL_REVIEW_EXECUTION_RECORD_MISSING',
  };

  // (a) direct: recordHealingAttempt refuses when the file it reads back no
  //     longer holds the array it just persisted.
  {
    const stateDir = mkStateDir();
    const p = healingLedgerPath(stateDir);
    const r = await withDriftedLedgerReadBack(p, foreignRaw, async () => recordHealingAttempt({
      stateDir, identityHash: ID, attempt,
    }));
    assert.equal(r && r.ok, false, JSON.stringify(r));
    assert.equal(r.reason, 'HEALING_LEDGER_CONCURRENT_MUTATION', JSON.stringify(r));
    // The atomic write itself landed — only the PROOF failed: fail-closed, the
    // persisted attempt stays on disk for audit, never silently re-applied.
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).attempts.length, 1);
  }

  // (b) through the wrapper: the typed failure keeps the reason reachable and
  //     a ledger that cannot be proven never reaches the synthesis gate.
  {
    const stateDir = mkStateDir();
    const { sessionPath } = mkSession(stateDir, { headSha: HEAD_A });
    const p = healingLedgerPath(stateDir);
    let gateCalls = 0;
    const res = await withDriftedLedgerReadBack(p, foreignRaw, async () => {
      const wrapped = healingWrapper(stateDir, sessionPath, async () => {
        gateCalls += 1;
        return { ok: true, exitCode: 0 };
      });
      return wrapped({});
    });
    assert.equal(res && res.ok, false, JSON.stringify(res));
    assert.equal(res.code, 'HEALING_ATTEMPT_EXHAUSTED', JSON.stringify(res));
    assert.equal(res.detail && res.detail.reason, 'HEALING_LEDGER_CONCURRENT_MUTATION', JSON.stringify(res.detail));
    assert.equal(gateCalls, 0, 'a ledger that cannot be proven never reaches the synthesis gate');
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).attempts.length, 1);
  }
});

// ---- SH-6 ---------------------------------------------------------------------
test('SH-6. a synthesized record always carries downstream-safe string model/agent fields', async () => {
  // (a) absent session.model / session.agent -> 'unknown' / 'build', never null.
  {
    const stateDir = mkStateDir();
    const wt = mkRealWorktree(stateDir);
    const { session } = mkSession(stateDir, { worktreePath: wt.path, headSha: wt.head });
    assert.equal(session.model, undefined, 'precondition: the session carries no model');
    assert.equal(session.agent, undefined, 'precondition: the session carries no agent');

    const syn = await synthesizeExecutionRecord({
      stateDir,
      identityHash: ID,
      session,
      runGate: async () => ({ ok: true, exitCode: 0, runId: 'heal-hygiene', command: 'node --test', rawLogPath: null }),
    });
    assert.equal(syn && syn.ok, true, JSON.stringify(syn));

    const rec = JSON.parse(fs.readFileSync(recordPath(stateDir), 'utf8'));
    assert.equal(typeof rec.model, 'string', `model must be a string, got ${typeof rec.model}`);
    assert.equal(rec.model, 'unknown');
    assert.equal(typeof rec.agent, 'string', `agent must be a string, got ${typeof rec.agent}`);
    assert.equal(rec.agent, 'build');
  }

  // (b) session-provided values pass through untouched.
  {
    const stateDir = mkStateDir();
    const wt = mkRealWorktree(stateDir);
    const { session } = mkSession(stateDir, {
      worktreePath: wt.path, headSha: wt.head, model: 'gpt-5-codex', agent: 'cline',
    });

    const syn = await synthesizeExecutionRecord({
      stateDir,
      identityHash: ID,
      session,
      runGate: async () => ({ ok: true, exitCode: 0, runId: 'heal-hygiene-2', command: 'node --test', rawLogPath: null }),
    });
    assert.equal(syn && syn.ok, true, JSON.stringify(syn));

    const rec = JSON.parse(fs.readFileSync(recordPath(stateDir), 'utf8'));
    assert.equal(rec.model, 'gpt-5-codex');
    assert.equal(rec.agent, 'cline');
  }
});
