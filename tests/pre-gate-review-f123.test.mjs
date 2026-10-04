// tests/pre-gate-review-f123.test.mjs — PRE-GATE-REVIEW-01 rework rework (F1/F2/F3).
//
// F1 — findings after an executor repair continue down the SAME bounded
//      canonical rework leg (dispatch -> repair -> review) until the finite
//      budget; an IDENTICAL replayed decision never re-dispatches; transport
//      failures are never rework.
// F2 — after a (real) executor commit, the canonical HEAD and content binding
//      are refreshed/read back through the EXISTING primitive
//      (refreshCanonicalHead) BEFORE the composite reviews the new candidate.
// F3 — the candidate freshness check reads the LIVE git HEAD independently
//      (record.headSha never substitutes for it), and the candidate is
//      re-checked AFTER the review and BEFORE the inner gate; any HEAD/content
//      drift is a typed refusal and the inner gate never runs.
//
// Doubles are labeled: the reviewer transport is a scripted double and the
// executor is a mocked dispatch — except F2, where the repair commit is a
// REAL git commit in a disposable fixture and the composite/binding/refresh
// primitives run for real.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  runControlLoop,
  readTransitions,
  appendTransition,
  CONTROL_LOOP_SCHEMA_VERSION,
} from '../packages/control-loop/control-loop.mjs';
import {
  preGateReviewVerifierAdapter,
  deriveReviewCandidate,
} from '../packages/control-loop/pre-gate-review.mjs';
import { computeWorktreeContentBinding } from '../packages/executor-launcher/execution-content-binding.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

const REPO = 'duongpdddic-droid/soc_brain';
const HEAD_A = 'a'.repeat(40);

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pgf123-')); }

function mkSession(stateDir, overrides = {}) {
  const repo = overrides.repo || REPO;
  const issueNumber = overrides.issueNumber || 902;
  const id = identityHash({ repo, issueNumber });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1',
    state: 'SESSION_ACTIVE',
    lifecycle: [],
    taskId: `${repo}#${issueNumber}`,
    repo,
    issueNumber,
    headSha: HEAD_A,
    baseSha: 'f'.repeat(40),
    worktreePath: path.join(stateDir, `wt-issue-${issueNumber}`),
    worktreesRoot: stateDir,
    prNumber: 272,
    controlPlane: { stateDir },
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session, id, issueNumber };
}

function mkExecRecord(stateDir, id, repo = REPO, issueNumber = 902) {
  const p = path.join(stateDir, 'executions', `${id}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: id,
    taskId: `${repo}#${issueNumber}`, repo, issueNumber,
    terminalStatus: 'ok', exitCode: 0,
  }, null, 2), 'utf8');
  return p;
}

function baseDeps(stateDir, calls, execPath) {
  return {
    reviewReadyDir: path.join(stateDir, 'review-ready'),
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: (ctx) => {
      calls.push(`executor:${ctx.reworkInstruction ? 'rework' : 'initial'}`);
      return { ok: true, value: { executionStatus: 'EXITED', terminalStatus: 'ok', exitCode: 0, executionRecordPath: execPath } };
    },
    verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
    telegramSpawn: () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 901 })}\n` }),
  };
}

function findingsFailure(findings, overrides = {}) {
  return {
    ok: false,
    code: 'INTERNAL_REVIEW_FINDINGS',
    detail: {
      status: 'CHANGES_REQUESTED',
      transportReason: null,
      correlationKey: 'ck-test',
      requestedHeadSha: HEAD_A,
      responseHeadSha: HEAD_A,
      findingsCount: findings.length,
      openBlockingCount: findings.length,
      findings,
      detail: 'scripted findings',
      ...overrides,
    },
  };
}

const F_A = { severity: 'critical', path: 'src/x.mjs', content: 'finding A: missing bounds check', category: 'bug' };
const F_B = { severity: 'high', path: 'src/y.mjs', content: 'finding B: unchecked redirect', category: 'security' };
const F_C = { severity: 'high', path: 'src/z.mjs', content: 'finding C: stale cache key', category: 'bug' };
const F_D = { severity: 'medium', path: 'src/w.mjs', content: 'finding D: typo in docs', category: 'docs' };

function reworkDispatches(ledger) {
  return ledger.filter((r) => r.from === 'VERIFYING' && r.to === 'REWORK');
}

// ---- F1 ------------------------------------------------------------------

test('F1: findings after a repair keep dispatching through the bounded leg until CLEAN (gate only after CLEAN)', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const execPath = mkExecRecord(stateDir, ID);
  const calls = [];
  const deps = baseDeps(stateDir, calls, execPath);
  const seen = [F_A, F_B]; // round 1 finding A, round 2 still a finding (B)
  let verifyCalls = 0;
  deps.verifier = () => {
    calls.push('verifier');
    verifyCalls += 1;
    if (verifyCalls <= seen.length) return findingsFailure([seen[verifyCalls - 1]]);
    return { ok: true, value: { verdict: 'PASS', report: 'ok' } };
  };
  deps.finalReview = () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.99, metadata: {} } }; };

  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res.ok === false ? res : res.value));
  assert.equal(res.value.state, 'COMPLETED');

  // Two repairs, then CLEAN: the inner walk continues only after CLEAN.
  assert.deepEqual(calls, [
    'router', 'executor:initial', 'verifier',
    'executor:rework', 'verifier',
    'executor:rework', 'verifier',
    'preReview', 'finalReview', 'delivery',
  ]);
  const ledger = readTransitions({ stateDir, identityHash: ID });
  assert.equal(reworkDispatches(ledger).length, 2, 'exactly two bounded dispatches');
  assert.ok(reworkDispatches(ledger).every((r) => r.reason === 'internal-review-findings-rework'));
  const verifyArrivals = ledger.filter((r) => r.from === 'EXECUTING' && r.to === 'VERIFYING'
    && r.reason === 'rework-verify-findings');
  // Only a FINDINGS verdict at rework-verify writes this arrival (the PASS
  // round lands as the plain EXECUTING->VERIFYING step record); the fresh
  // walk's findings reroute leaves the loop at VERIFYING with no record.
  assert.equal(verifyArrivals.length, 1, 'the still-finding repair round lands back at VERIFYING for the next round');
  assert.ok(!ledger.some((r) => r.to === 'BLOCKED' && String(r.reason || '').startsWith('rework-verify:FAIL')),
    'a rework-round findings verdict must never become rework-verify:FAIL BLOCKED');
  // Two persisted rework decision records (crash-safe budget ledger).
  const dir = path.join(stateDir, 'control-loop', ID, 'rework');
  const records = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.equal(records.length, 2, `expected 2 rework records, got ${JSON.stringify(records)}`);
});

test('F1: an IDENTICAL replayed findings decision never re-dispatches (duplicate guard inside the leg)', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const execPath = mkExecRecord(stateDir, ID);
  const calls = [];
  const deps = baseDeps(stateDir, calls, execPath);
  deps.verifier = () => { calls.push('verifier'); return findingsFailure([F_A]); };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'REWORK_ALREADY_DISPATCHED', 'identical findings decision must hit the digest duplicate guard');
  assert.equal(calls.filter((c) => c === 'executor:rework').length, 1, 'dispatch happened exactly once');
  const ledger = readTransitions({ stateDir, identityHash: ID });
  assert.equal(reworkDispatches(ledger).length, 1, 'no second VERIFYING->REWORK for the same decision');
});

test('F1: budget exhaustion escalates canonically after MAX rounds (no dispatch beyond budget)', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const execPath = mkExecRecord(stateDir, ID);
  const calls = [];
  const deps = baseDeps(stateDir, calls, execPath);
  const roundFindings = [F_A, F_B, F_C, F_D]; // fresh + 3 rounds, each different
  let verifyCalls = 0;
  deps.verifier = () => {
    calls.push('verifier');
    verifyCalls += 1;
    return findingsFailure([roundFindings[Math.min(verifyCalls - 1, roundFindings.length - 1)]]);
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res.ok === false ? res : res.value));
  assert.equal(res.value.state, 'BLOCKED', 'budget exhaustion is a canonical BLOCKED escalation');
  assert.equal(res.value.reason, 'REWORK_BUDGET_EXHAUSTED');
  assert.equal(calls.filter((c) => c === 'executor:rework').length, 3, 'exactly MAX_REWORK_ROUNDS dispatches');
  const ledger = readTransitions({ stateDir, identityHash: ID });
  assert.equal(reworkDispatches(ledger).length, 3, 'no dispatch beyond the budget');
  const exhaustion = ledger.filter((r) => r.from === 'VERIFYING' && r.to === 'BLOCKED'
    && r.reason === 'rework-budget-exhausted');
  assert.equal(exhaustion.length, 1, 'exactly one budget-exhaustion escalation record');
  assert.ok(!calls.includes('preReview') && !calls.includes('finalReview') && !calls.includes('delivery'),
    'no review/gate/delivery beyond the policy');
});

// ---- F2 ------------------------------------------------------------------

function gitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgf123-git-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git('init');
  git('config', 'user.email', 'fixture@test');
  git('config', 'user.name', 'fixture');
  fs.writeFileSync(path.join(dir, 'src.mjs'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-m', 'base');
  const head0 = git('rev-parse', 'HEAD').toLowerCase();
  return { dir, git, head0 };
}

test('F2: a real executor commit in a disposable git fixture is refreshed and reviewed as the NEW candidate', async () => {
  const stateDir = mkStateDir();
  const fx = gitFixture();
  const { dir: worktree, git, head0 } = fx;
  const { sessionPath, id: ID } = mkSession(stateDir, { worktreePath: worktree, headSha: head0, baseSha: head0 });
  const execPath = path.join(stateDir, 'executions', `${ID}.json`);
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  const binding0 = computeWorktreeContentBinding({ worktreePath: worktree });
  assert.equal(binding0.ok, true, JSON.stringify(binding0));
  const writeRecord = (headSha, digest, fileCount) => {
    fs.writeFileSync(execPath, JSON.stringify({
      schemaVersion: '1', kind: 'ExecutionRecord', identityHash: ID,
      taskId: `${REPO}#${sessionIssue(902)}`, repo: REPO, issueNumber: 902,
      terminalStatus: 'ok', exitCode: 0,
      worktreePath: worktree, baseSha: head0, headSha,
      codeContentDigest: digest, codeContentFiles: fileCount,
    }, null, 2), 'utf8');
  };
  writeRecord(head0, binding0.value.contentDigest, binding0.value.fileCount);

  // REAL composite (only projectId lookup is injected); binding/session/
  // record reads and the git HEAD read are the production primitives.
  const registryPath = path.join(stateDir, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({ schemaVersion: '1', projects: [{ projectId: 'fixture', repository: REPO }] }));
  const transportHeads = [];
  const reviewerTransport = async (req) => {
    transportHeads.push(String(req.headSha).toLowerCase());
    if (String(req.headSha).toLowerCase() === head0) {
      return {
        ok: true, verdict: 'CHANGES_REQUESTED', finalReview: true, reviewedHeadSha: head0,
        decisionGate: { status: 'PASS' },
        findings: [{ severity: 'critical', status: 'open', path: 'src.mjs', content: 'finding A: missing bounds check', category: 'bug' }],
        openBlocking: [], detail: 'scripted findings on candidate 0',
      };
    }
    return {
      ok: true, verdict: 'APPROVED', finalReview: true, reviewedHeadSha: String(req.headSha),
      decisionGate: { status: 'PASS' }, findings: [], openBlocking: [], detail: 'scripted CLEAN',
    };
  };
  let innerCalls = 0;
  const innerVerifier = async () => { innerCalls += 1; return { ok: true, value: { verdict: 'PASS', evidence: { exitCode: 0 } } }; };
  const composite = preGateReviewVerifierAdapter({
    innerVerifier,
    transport: reviewerTransport,
    registryPath,
    io: { findProjectId: () => 'fixture' },
  });

  const calls = [];
  const deps = baseDeps(stateDir, calls, execPath);
  let head1 = null;
  deps.verifier = (ctx) => {
    calls.push('verifier(composite)');
    return composite({ sessionPath: ctx.sessionPath ?? sessionPath, executionRecordPath: ctx.executionRecordPath ?? execPath });
  };
  const originalExecutor = deps.executor;
  deps.executor = (ctx) => {
    if (!ctx.reworkInstruction) return originalExecutor(ctx);
    calls.push('executor:rework [REAL git commit in disposable fixture]');
    // REAL repair: commit a tracked change, then stamp the record with the
    // production content binding of the new worktree state.
    fs.writeFileSync(path.join(worktree, 'src.mjs'), 'export const a = 2;\n');
    git('add', '-A');
    git('commit', '-m', 'repair');
    head1 = git('rev-parse', 'HEAD').toLowerCase();
    const b1 = computeWorktreeContentBinding({ worktreePath: worktree });
    assert.equal(b1.ok, true, JSON.stringify(b1));
    writeRecord(head1, b1.value.contentDigest, b1.value.fileCount);
    return { ok: true, value: { executionStatus: 'EXITED', terminalStatus: 'ok', exitCode: 0, executionRecordPath: execPath } };
  };
  deps.finalReview = () => ({ ok: true, value: { verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.99, metadata: {} } });

  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res.ok === false ? res : res.value));
  assert.equal(res.value.state, 'COMPLETED');
  assert.ok(head1, 'the rework executor must have really committed');
  assert.notEqual(head1, head0);
  assert.deepEqual(transportHeads, [head0, head1], 'composite reviewed candidate 0, then the refreshed NEW candidate');
  assert.equal(innerCalls, 1, 'inner gate ran exactly once, on the refreshed candidate');
  const sessionAfter = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(String(sessionAfter.headSha).toLowerCase(), head1,
    'canonical HEAD was refreshed (read-back) BEFORE the composite reviewed the new candidate');
  const ledger = readTransitions({ stateDir, identityHash: ID });
  assert.equal(reworkDispatches(ledger).length, 1);
  fs.rmSync(worktree, { recursive: true, force: true });
});

function sessionIssue(n) { return n; } // readability helper for record taskId

// ---- F3 ------------------------------------------------------------------

test('F3: HEAD moves but tracked bytes stay identical -> stale-block (live HEAD read, not record.headSha)', async () => {
  const stateDir = mkStateDir();
  const fx = gitFixture();
  const { dir: worktree, git, head0 } = fx;
  const { sessionPath, id: ID } = mkSession(stateDir, { worktreePath: worktree, headSha: head0, baseSha: head0 });
  const execPath = path.join(stateDir, 'executions', `${ID}.json`);
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  const binding0 = computeWorktreeContentBinding({ worktreePath: worktree });
  assert.equal(binding0.ok, true, JSON.stringify(binding0));
  fs.writeFileSync(execPath, JSON.stringify({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: ID,
    taskId: `${REPO}#902`, repo: REPO, issueNumber: 902,
    terminalStatus: 'ok', exitCode: 0,
    worktreePath: worktree, baseSha: head0, headSha: head0,
    codeContentDigest: binding0.value.contentDigest, codeContentFiles: binding0.value.fileCount,
  }, null, 2), 'utf8');

  // Metadata-only commit: HEAD moves, every tracked byte stays identical.
  git('commit', '--allow-empty', '-m', 'metadata only');
  const head1 = git('rev-parse', 'HEAD').toLowerCase();
  assert.notEqual(head1, head0);
  const rebind = computeWorktreeContentBinding({ worktreePath: worktree });
  assert.equal(rebind.value.contentDigest, binding0.value.contentDigest, 'fixture precondition: tracked bytes identical');

  const cand = deriveReviewCandidate({
    sessionPath,
    executionRecordPath: execPath,
    io: { findProjectId: () => 'fixture' },
  });
  assert.equal(cand.ok, false, `HEAD drift with identical bytes must fail closed, got ${JSON.stringify(cand)}`);
  assert.equal(cand.code, 'INTERNAL_REVIEW_CANDIDATE_STALE');
  assert.equal(cand.detail.live.headSha, head1, 'the stale detail must carry the LIVE head, not the recorded one');
  assert.equal(cand.detail.record.headSha, head0);
  fs.rmSync(worktree, { recursive: true, force: true });
});

test('F3: HEAD/content drift DURING the review -> typed refusal before the gate (inner verifier never runs)', async () => {
  const stateDir = mkStateDir();
  const fx = gitFixture();
  const { dir: worktree, git, head0 } = fx;
  const { sessionPath, id: ID } = mkSession(stateDir, { worktreePath: worktree, headSha: head0, baseSha: head0 });
  const execPath = path.join(stateDir, 'executions', `${ID}.json`);
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  const binding0 = computeWorktreeContentBinding({ worktreePath: worktree });
  assert.equal(binding0.ok, true, JSON.stringify(binding0));
  fs.writeFileSync(execPath, JSON.stringify({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: ID,
    taskId: `${REPO}#902`, repo: REPO, issueNumber: 902,
    terminalStatus: 'ok', exitCode: 0,
    worktreePath: worktree, baseSha: head0, headSha: head0,
    codeContentDigest: binding0.value.contentDigest, codeContentFiles: binding0.value.fileCount,
  }, null, 2), 'utf8');

  let innerCalls = 0;
  const innerVerifier = async () => { innerCalls += 1; return { ok: true, value: { verdict: 'PASS', evidence: {} } }; };
  const registryPath = path.join(stateDir, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({ schemaVersion: '1', projects: [{ projectId: 'fixture', repository: REPO }] }));
  const reviewerTransport = async (req) => {
    // Mutate the tracked content WHILE the review is in flight.
    fs.writeFileSync(path.join(worktree, 'src.mjs'), 'export const a = 999;\n');
    return {
      ok: true, verdict: 'APPROVED', finalReview: true, reviewedHeadSha: String(req.headSha),
      decisionGate: { status: 'PASS' }, findings: [], openBlocking: [], detail: 'scripted CLEAN (drifted)',
    };
  };
  const composite = preGateReviewVerifierAdapter({
    innerVerifier,
    transport: reviewerTransport,
    registryPath,
    io: { findProjectId: () => 'fixture' },
  });

  const res = await composite({ sessionPath, executionRecordPath: execPath });
  assert.equal(res.ok, false, `post-review drift must refuse before the gate, got ${JSON.stringify(res)}`);
  assert.equal(res.code, 'INTERNAL_REVIEW_CANDIDATE_STALE');
  assert.equal(res.detail.phase, 'post-review', 'the refusal must be typed at the post-review re-check');
  assert.equal(innerCalls, 0, 'the inner gate must never run on a drifted candidate');
  fs.rmSync(worktree, { recursive: true, force: true });
});
