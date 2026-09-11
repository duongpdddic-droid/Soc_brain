#!/usr/bin/env node
// tests/control-loop-review-only.test.mjs — Issue #159: canonical review-only
// delivery of a pre-existing PR at an exact head, WITHOUT dispatching an
// executor. Deterministic, injected fakes (no real git/gh/opencode/network).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runControlLoop, adoptExistingPullRequestForReview, readTransitions } from '../packages/control-loop/control-loop.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

const REPO = 'duongpdddic-droid/soc_brain';
const HEAD = '1'.repeat(40);
const OTHER = '2'.repeat(40);
const BASE = 'f'.repeat(40);

function mkState() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ro-')); }
function mkSession(stateDir, issueNumber, overrides = {}) {
  const id = identityHash({ repo: REPO, issueNumber });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1', state: 'SESSION_ACTIVE', lifecycle: [],
    taskId: `${REPO}#${issueNumber}`, repo: REPO, issueNumber,
    headSha: HEAD, baseSha: BASE,
    worktreePath: path.join(stateDir, 'wt'), worktreesRoot: stateDir,
    branch: `agent/${id.slice(0, 12)}`, controlPlane: { stateDir },
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, id, session };
}
// fake git: rev-parse HEAD -> localHead; everything else succeeds with empty.
function mkExec(localHead) {
  return (args, /* {cwd} */) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { status: 0, stdout: localHead + '\n' };
    if (args[0] === 'merge-base') return { status: 0, stdout: '' };
    return { status: 0, stdout: '' };
  };
}
// fake gh: pr view returns the PR at remoteHead; issue view returns {}
function mkGh({ prState = 'OPEN', remoteHead = HEAD, number = 158, prExit = 0 }) {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') {
      if (prExit !== 0) return { code: prExit, stdout: '', stderr: 'gh: no pull requests found' };
      return { code: 0, stdout: JSON.stringify({ state: prState, number, headRefOid: remoteHead }) };
    }
    return { code: 0, stdout: '{}' };
  };
  fn.calls = calls;
  return fn;
}
function baseDeps({ calls, finalVerdict = 'PASS', verification }) {
  return {
    reviewOnly: { pullRequest: 158, headSha: HEAD, verification },
    pushExec: mkExec(HEAD),
    gh: mkGh({ remoteHead: HEAD }),
    router: () => ({ ok: true, value: { executorKind: 'opencode', model: null } }),
    executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: '/never' } }; },
    verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS' } }; },
    preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: finalVerdict, findings: [], binding: { repository: REPO, issue: 159, headSha: HEAD } } }; },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
    cleanup: () => ({ ok: true, removed: ['worktree'], keptBranch: 'agent/x', idempotent: false }),
    telegramSpawn: () => ({ stdout: JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 1 }) + '\n' }),
  };
}
const readS = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('R1. existing PR + exact head + bound verification -> NO executor, COMPLETED via delivery', async () => {
  const stateDir = mkState();
  const { sessionPath, id } = mkSession(stateDir, 159);
  const calls = [];
  const deps = baseDeps({ calls, verification: { verdict: 'PASS', headSha: HEAD, evidence: { suite: '309/309' } } });
  deps.finalReview = () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; };
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  assert.ok(!calls.includes('executor'), 'executor must NOT be dispatched in review-only mode');
  assert.ok(calls.includes('finalReview') && calls.includes('delivery'));
  const rec = readS(sessionPath);
  assert.equal(rec.state, 'COMPLETED');
  assert.equal(rec.prNumber, 158);
  assert.equal(rec.headSha, HEAD);
  assert.equal(rec.controlLoop.reviewOnly, true);
  const led = readTransitions({ stateDir, identityHash: id });
  const execLeg = led.find((r) => r.from === 'EXECUTING' && r.to === 'VERIFYING');
  assert.ok(execLeg && execLeg.evidence && execLeg.evidence.reviewOnly === true, 'EXECUTING leg records review-only adoption evidence');
});

test('R2. explicit verifier transport runs and must bind exact head', async () => {
  const stateDir = mkState();
  const { sessionPath, id } = mkSession(stateDir, 159);
  const calls = [];
  const deps = baseDeps({ calls, verification: null });
  deps.reviewOnlyVerifier = ({ headSha }) => { calls.push('reviewOnlyVerifier'); return { ok: true, value: { verdict: 'PASS', headSha, evidence: { ran: true } } }; };
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(calls.includes('reviewOnlyVerifier') && !calls.includes('verifier'));
});

test('R3. missing PR binding -> fail closed, never reaches reviewers/delivery', async () => {
  const stateDir = mkState();
  const { sessionPath, id } = mkSession(stateDir, 159);
  const calls = [];
  const deps = baseDeps({ calls, verification: { verdict: 'PASS', headSha: HEAD } });
  deps.gh = mkGh({ prExit: 1 });
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'EXECUTE_FAILED');
  assert.ok(!calls.includes('preReview') && !calls.includes('finalReview') && !calls.includes('delivery'));
  assert.notEqual(readS(sessionPath).state, 'COMPLETED');
});

test('R4. remote head drift -> fail closed REVIEW_ONLY_REMOTE_HEAD_DRIFT', async () => {
  const stateDir = mkState();
  const { sessionPath, id } = mkSession(stateDir, 159);
  const calls = [];
  const deps = baseDeps({ calls, verification: { verdict: 'PASS', headSha: HEAD } });
  deps.gh = mkGh({ remoteHead: OTHER }); // remote PR points at a different head
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'EXECUTE_FAILED');
  assert.match(JSON.stringify(res), /REVIEW_ONLY_REMOTE_HEAD_DRIFT/);
  assert.ok(!calls.includes('delivery'));
});

test('R4b. local worktree head drift -> fail closed before any gh traffic', async () => {
  const stateDir = mkState();
  const { sessionPath, id } = mkSession(stateDir, 159);
  const calls = [];
  const deps = baseDeps({ calls, verification: { verdict: 'PASS', headSha: HEAD } });
  deps.pushExec = mkExec(OTHER); // worktree HEAD != expected target
  const ghCallsBefore = deps.gh.calls.length;
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(res.ok, false);
  assert.match(JSON.stringify(res), /REVIEW_ONLY_HEAD_DRIFT/);
  assert.equal(deps.gh.calls.length, ghCallsBefore, 'no remote traffic after a local drift');
});

test('R5. missing/stale verification -> reviewer not reached', async () => {
  // (a) missing entirely
  const s1 = mkState();
  const m1 = mkSession(s1, 159);
  const c1 = [];
  const d1 = baseDeps({ calls: c1, verification: null });
  const r1 = await runControlLoop({ sessionPath: m1.sessionPath, identityHash: m1.id, stateDir: s1, deps: d1 });
  assert.equal(r1.ok, false);
  assert.match(JSON.stringify(r1), /REVIEW_ONLY_VERIFICATION_MISSING|VERIFY_FAILED/);
  assert.ok(!c1.includes('preReview') && !c1.includes('finalReview'));
  // (b) stale: bound to the wrong head
  const s2 = mkState();
  const m2 = mkSession(s2, 159);
  const c2 = [];
  const d2 = baseDeps({ calls: c2, verification: { verdict: 'PASS', headSha: OTHER } });
  const r2 = await runControlLoop({ sessionPath: m2.sessionPath, identityHash: m2.id, stateDir: s2, deps: d2 });
  assert.equal(r2.ok, false);
  assert.match(JSON.stringify(r2), /REVIEW_ONLY_VERIFICATION_STALE|VERIFY_FAILED/);
  assert.ok(!c2.includes('finalReview'));
});

test('R6. final-review BLOCKED -> BLOCKED, no delivery', async () => {
  const stateDir = mkState();
  const { sessionPath, id } = mkSession(stateDir, 159);
  const calls = [];
  const deps = baseDeps({ calls, finalVerdict: 'BLOCKED', verification: { verdict: 'PASS', headSha: HEAD } });
  const res = await runControlLoop({ sessionPath, id, identityHash: id, stateDir, deps });
  assert.equal(res.ok, true);
  assert.equal(res.value.state, 'BLOCKED');
  assert.ok(!calls.includes('delivery'));
});

test('R7. final-review REWORK -> no executor dispatch, no delivery, not terminalized', async () => {
  const stateDir = mkState();
  const { sessionPath, id } = mkSession(stateDir, 159);
  const calls = [];
  const deps = baseDeps({ calls, finalVerdict: 'REWORK', verification: { verdict: 'PASS', headSha: HEAD } });
  const res = await runControlLoop({ sessionPath, id, identityHash: id, stateDir, deps });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'REVIEW_ONLY_NO_REWORK_DISPATCH');
  assert.ok(!calls.includes('executor') && !calls.includes('delivery'));
  assert.notEqual(readS(sessionPath).state, 'COMPLETED');
});

test('R8. reviewOnly absent -> normal flow unchanged (executor still dispatched)', async () => {
  const stateDir = mkState();
  const { sessionPath, id } = mkSession(stateDir, 159);
  const calls = [];
  const deps = {
    router: () => ({ ok: true, value: { executorKind: 'opencode', model: null } }),
    executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: '/x' } }; },
    verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS' } }; },
    preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS' } }; },
    finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'PASS' } }; },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
    telegramSpawn: () => ({ stdout: JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 1 }) + '\n' }),
  };
  const res = await runControlLoop({ sessionPath, id: undefined, identityHash: id, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(calls.includes('executor'), 'normal walk must still dispatch the executor');
});

test('R9. adoptExistingPullRequestForReview arg validation (no state setter exposed)', async () => {
  assert.equal((await adoptExistingPullRequestForReview({ repo: REPO, issueNumber: 159, pullRequest: 0, headSha: HEAD })).code, 'REVIEW_ONLY_ARGS_INVALID');
  assert.equal((await adoptExistingPullRequestForReview({ repo: REPO, issueNumber: 159, pullRequest: 158, headSha: 'nope' })).code, 'REVIEW_ONLY_ARGS_INVALID');
  assert.equal((await adoptExistingPullRequestForReview({ repo: 'other/repo', issueNumber: 159, pullRequest: 158, headSha: HEAD })).code, 'FOREIGN_REPO');
});

test('R10. fast-path + reviewOnly conflict + transport-missing fail closed', async () => {
  const stateDir = mkState();
  const { sessionPath, id } = mkSession(stateDir, 159);
  // no pushExec transport
  const calls = [];
  const d1 = baseDeps({ calls, verification: { verdict: 'PASS', headSha: HEAD } });
  delete d1.pushExec;
  const r1 = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: d1 });
  assert.equal(r1.code, 'REVIEW_ONLY_TRANSPORT_MISSING');
  // fast-path conflict
  const d2 = baseDeps({ calls, verification: { verdict: 'PASS', headSha: HEAD } });
  d2.fastPathDescriptor = { eligible: true };
  const r2 = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: d2 });
  assert.equal(r2.code, 'REVIEW_ONLY_ROUTE_CONFLICT');
});
