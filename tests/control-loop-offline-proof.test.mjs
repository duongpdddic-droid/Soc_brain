#!/usr/bin/env node
// tests/control-loop-offline-proof.test.mjs — LOOP-01 §6.
//
// OFFLINE PROOF of one complete ControlLoop round on disposable fixtures, driven
// through the REAL `runControlLoop` with injected adapters (no network, no
// GitHub, no CDP, no paid model). Everything below is labelled offline: the
// adapters are fakes, so what is proven is the LOOP wiring (transition ledger,
// rework leg, resume seams, delivery stop) — not a live transport.
//
// Disclosure of unavoidable doubles in these fixtures:
//   * the internal-review re-run and the post-interruption review re-run are
//     both counted explicitly in the call ledger and asserted, never hidden;
//   * publish (push + PR bind) runs once per round in production and is NOT
//     exercised offline (no git transport adapter is injected here).
//
// Proof A — full chain: internal pre-gate findings -> bounded rework leg
//   (VERIFYING->REWORK, findings record) -> repaired candidate reviewed clean ->
//   independent PASS -> delivery stops at the Human Gate (typed, non-terminal).
// Proof B — interruption mid-loop: resume on the SAME identity, route/executor
//   dispatched exactly once, the interrupted review is re-obtained (disclosed
//   double), no second task/session/transition duplicates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { identityHash } from '../packages/workspace/workspace.mjs';
import { readTransitions, runControlLoop } from '../packages/control-loop/control-loop.mjs';
import { deriveTaskStatus, renderTaskStatus } from '../packages/control-loop/task-status.mjs';
import { HUMAN_GATE_DELIVERY_CODE } from '../bin/soc-control-loop.mjs';

const REPO = 'duongpdddic-droid/soc_brain';
const ISSUE = 69;
const HEAD = 'a'.repeat(40);
const BASE = 'f'.repeat(40);
const BRANCH = 'task/loop-01-proof';
const PR_NUMBER = 4242;
const WORKTREES_ROOT = path.join(os.tmpdir(), 'loop01-proof-wt');

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'loop01-proof-')); }

function mkSession(stateDir, overrides = {}) {
  const repo = overrides.repo || REPO;
  const issueNumber = overrides.issueNumber || ISSUE;
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
    headSha: HEAD,
    baseSha: BASE,
    branch: BRANCH,
    prNumber: PR_NUMBER,
    worktreePath: path.join(WORKTREES_ROOT, `issue-${issueNumber}`),
    worktreesRoot: WORKTREES_ROOT,
    // the rework leg reads the fresh ExecutionRecord back through the session's
    // own control-plane state dir (production shape).
    controlPlane: { stateDir },
    ...overrides,
  };
  fs.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  return { sessionPath, session, id };
}

const board = (stateDir, id) => {
  const r = deriveTaskStatus({ stateDir, identityHash: id });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.status;
};

const humanGateDelivery = () => ({ ok: false, code: HUMAN_GATE_DELIVERY_CODE, detail: 'merge awaits authorized human' });
const okDelivery = () => ({ ok: true, value: { shipped: true } });
const telegramOk = () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 901 })}\n` });
const readSessionState = (p) => JSON.parse(fs.readFileSync(p, 'utf8')).state;

// The rework leg reads the ExecutionRecord back before it re-dispatches, so the
// fixture must persist a canonical record at <stateDir>/executions/<id>.json —
// exactly the file the executor adapter writes in production.
function writeExecRecord(stateDir, id) {
  const dir = path.join(stateDir, 'executions');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${id}.json`);
  fs.writeFileSync(p, `${JSON.stringify({
    schemaVersion: '1',
    kind: 'ExecutionRecord',
    identityHash: id,
    taskId: `${REPO}#${ISSUE}`,
    repo: REPO,
    issueNumber: ISSUE,
    terminalStatus: 'ok',
    exitCode: 0,
    instructionDigest: 'd'.repeat(64),
    headSha: HEAD,
    baseSha: BASE,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
  }, null, 2)}\n`, 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// Proof A — full loop: internal findings -> rework -> clean -> PASS -> Human Gate
// ---------------------------------------------------------------------------
test('proof A. offline full chain: internal-review findings -> bounded rework -> PASS -> Human Gate stop', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const execPath = writeExecRecord(stateDir, id);
  const calls = [];
  let verifyRounds = 0;
  const deps = {
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'free' } }; },
    executor: (ctx) => { calls.push(ctx && ctx.reworkInstruction ? 'executor:rework' : 'executor'); return { ok: true, value: { executionRecordPath: execPath } }; },
    verifier: () => {
      calls.push('verifier');
      verifyRounds += 1;
      // round 1: the pre-gate internal review reports findings on the SAME
      // candidate -> typed reroute (never a BLOCKED step failure).
      if (verifyRounds === 1) {
        return { ok: false, code: 'INTERNAL_REVIEW_FINDINGS', detail: { findings: ['internal: missing regression for LOOP-01'], status: 'REVIEWED', responseHeadSha: HEAD } };
      }
      return { ok: true, value: { verdict: 'PASS', report: 'clean' } };
    },
    preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.9, metadata: {} } }; },
    telegramSpawn: telegramOk,
    delivery: () => { calls.push('delivery'); return humanGateDelivery(); },
  };

  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });

  // (1) the Human Gate is a typed delivery stop, NOT a completion.
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'DELIVER_STEP_FAILED');
  assert.equal(res.detail && res.detail.code, HUMAN_GATE_DELIVERY_CODE);

  // (2) one loop, one executor for round 1 + one for the rework round, reviews
  //     re-obtained on the repaired candidate (the disclosed re-review).
  assert.deepEqual(calls, [
    'router', 'executor',
    'verifier',                          // round 1 -> internal findings
    'executor:rework', 'verifier',       // round 2 (repaired candidate)
    'preReview', 'finalReview', 'delivery',
  ]);

  // (3) the ledger proves the bounded rework leg, not a second FSM edge.
  const tx = readTransitions({ stateDir, identityHash: id });
  const reworkEdge = tx.find((t) => t.from === 'VERIFYING' && t.to === 'REWORK');
  assert.ok(reworkEdge, 'VERIFYING->REWORK edge missing');
  assert.equal(reworkEdge.reason, 'internal-review-findings-rework');
  assert.equal(tx.filter((t) => t.to === 'REWORK').length, 1);
  assert.equal(tx.filter((t) => t.from === 'ACCEPTED' && t.to === 'ROUTED').length, 1, 'loop bound twice');
  assert.equal(tx[tx.length - 1].from, 'DECIDING');
  assert.equal(tx[tx.length - 1].to, 'DELIVERING');
  for (const t of tx) assert.equal(t.identityHash, id, 'foreign identity in ledger');

  // (4) the findings travelled back through the persisted rework record.
  const rwDir = path.join(stateDir, 'control-loop', id, 'rework');
  const rwFiles = fs.readdirSync(rwDir).filter((f) => f.endsWith('.json'));
  assert.equal(rwFiles.length, 1);
  const rwRec = JSON.parse(fs.readFileSync(path.join(rwDir, rwFiles[0]), 'utf8'));
  assert.equal(rwRec.verdict ?? rwRec.decision?.verdict ?? 'REWORK', 'REWORK');
  assert.ok(Array.isArray(rwRec.findings) && rwRec.findings.length === 1);

  // (5) session stays recoverable — nothing terminalized by a Human Gate stop.
  assert.equal(readSessionState(sessionPath), 'SESSION_ACTIVE');
  assert.ok(!JSON.stringify(res).includes('COMPLETED'));

  // (6) the status board reads this exact checkpoint back.
  const st = board(stateDir, id);
  assert.equal(st.checkpoint.state, 'DELIVERING');
  assert.equal(st.checkpoint.step, 'DELIVER');
  assert.equal(st.rework.rounds, 1);
  assert.equal(st.nextAction.action, 'AWAIT_HUMAN_GATE');
  assert.deepEqual(st.missingRequired, [], 'a stopped-at-gate task must not report checklist gaps');
  for (const s of st.steps.slice(0, 8)) assert.equal(s.status, 'DONE', `${s.step} -> ${s.status}`);
  const txt = renderTaskStatus(st);
  assert.ok(txt.includes('AWAIT_HUMAN_GATE'));
  assert.equal(txt.includes('RECONCILE'), false);
});

// ---------------------------------------------------------------------------
// Proof B — interruption mid-loop, then resume on the same identity
// ---------------------------------------------------------------------------
test('proof B. offline interruption + resume: one identity, one dispatch, re-obtained review (disclosed double)', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const execPath = writeExecRecord(stateDir, id);

  // ---- run 1: dies at the independent review transport -------------------
  const calls1 = [];
  const deps1 = {
    router: () => { calls1.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'free' } }; },
    executor: () => { calls1.push('executor'); return { ok: true, value: { executionRecordPath: execPath } }; },
    verifier: () => { calls1.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: () => { calls1.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    finalReview: () => { calls1.push('finalReview'); return { ok: false, code: 'REVIEW_TRANSPORT_DOWN', detail: 'offline interruption' }; },
    telegramSpawn: telegramOk,
    delivery: () => { calls1.push('delivery'); return humanGateDelivery(); },
  };
  const r1 = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: deps1 });

  assert.equal(r1.ok, false, JSON.stringify(r1));
  assert.equal(r1.code, 'FINAL_REVIEW_FAILED');
  assert.equal(calls1.includes('delivery'), false, 'delivery must not run after an interrupted review');
  assert.equal(readSessionState(sessionPath), 'SESSION_ACTIVE', 'interruption never terminalizes');
  const tx1 = readTransitions({ stateDir, identityHash: id });
  assert.equal(tx1[tx1.length - 1].reason, 'finalReview:FAIL');
  assert.equal(tx1.filter((t) => t.from === 'ACCEPTED' && t.to === 'ROUTED').length, 1);

  // The board must read the interruption back as a recoverable blocked tail.
  const st1 = board(stateDir, id);
  assert.equal(st1.checkpoint.blocked, true);
  assert.equal(st1.checkpoint.step, 'FINAL_REVIEW');
  assert.equal(st1.nextAction.action, 'READ_BACK_BLOCKED_TAIL');
  assert.equal(st1.nextAction.reason, 'finalReview:FAIL');

  // ---- run 2: resume on the SAME canonical identity ----------------------
  const calls2 = [];
  const deps2 = {
    router: () => { calls2.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'free' } }; },
    executor: () => { calls2.push('executor'); return { ok: true, value: { executionRecordPath: execPath } }; },
    verifier: () => { calls2.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: () => { calls2.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    finalReview: () => { calls2.push('finalReview'); return { ok: true, value: { verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.9, metadata: {} } }; },
    telegramSpawn: telegramOk,
    delivery: () => { calls2.push('delivery'); return humanGateDelivery(); },
  };
  const r2 = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: deps2 });

  assert.equal(r2.ok, false, JSON.stringify(r2));
  assert.equal(r2.code, 'DELIVER_STEP_FAILED');
  assert.equal(r2.detail && r2.detail.code, HUMAN_GATE_DELIVERY_CODE);

  // ONE identity: same id, one admission, no duplicated first edge.
  const tx2 = readTransitions({ stateDir, identityHash: id });
  assert.equal(tx2.filter((t) => t.from === 'ACCEPTED' && t.to === 'ROUTED').length, 1);
  for (const t of tx2) assert.equal(t.identityHash, id);
  assert.ok(tx2.length > tx1.length, 'resume must append, never rewrite');
  // No re-dispatch of route/executor: the attempt checkpoint is respected.
  assert.equal(calls2.includes('router'), false, 'route re-run on resume');
  assert.equal(calls2.includes('executor'), false, 'executor re-dispatched on resume');
  assert.equal(calls1.filter((c) => c === 'router').length, 1);
  assert.equal(calls1.filter((c) => c === 'executor').length, 1);
  // DISCLOSED DOUBLE: the interrupted review of the SAME candidate is
  // re-obtained on resume (finalReview ran twice in total for one candidate).
  assert.equal(calls1.filter((c) => c === 'finalReview').length, 1);
  assert.equal(calls2.filter((c) => c === 'finalReview').length, 1);

  // One canonical task record, still active, now stopped at the Human Gate.
  const sessions = fs.readdirSync(path.join(stateDir, 'sessions'));
  assert.equal(sessions.length, 1, 'resume minted a second session');
  assert.equal(readSessionState(sessionPath), 'SESSION_ACTIVE');
  const st2 = board(stateDir, id);
  assert.equal(st2.checkpoint.state, 'DELIVERING');
  assert.equal(st2.nextAction.action, 'AWAIT_HUMAN_GATE');
  assert.equal(st2.identity.identityHash, id);
  assert.deepEqual(st2.missingRequired, []);
  // The board and the loop agree on the round budget (no phantom rework).
  assert.equal(st2.rework.rounds, 0);
  renderTaskStatus(st2);
});
