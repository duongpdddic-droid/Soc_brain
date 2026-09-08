// tests/control-loop.review-eval.test.mjs — control-loop wiring tests for the
// review-eval sink, step durationMs and the phase-latency summary (Issue #100).
// node:test, zero new deps.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runControlLoop,
  readTransitions,
  summarizePhaseLatency,
} from '../packages/control-loop/control-loop.mjs';
import {
  appendReviewEvaluation,
  readReviewEvaluations,
} from '../packages/review-eval/review-eval.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'f'.repeat(40);

function mkSession(stateDir, overrides = {}) {
  const repo = 'duongpdddic-droid/soc_brain';
  const issueNumber = 100;
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
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session, id };
}

// Canonical PASS-path deps (mirrors tests/control-loop.test.mjs fixture C);
// review values stamp metadata.model per the PR #99 contract so the real
// review-eval sink accepts them.
function baseDeps(calls, { sink = null, reviewValue = null } = {}) {
  const PKT = 'c'.repeat(64);
  const mkReview = () => ({
    ok: true,
    value: reviewValue || {
      verdict: 'PASS',
      findings: [],
      confidence: 1,
      metadata: {
        model: 'stub-model',
        packet: { name: 'pkt_review-ready.md', sha256: PKT, truncated: false },
      },
    },
  });
  const deps = {
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: '/fake/execution.json' } }; },
    verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: () => { calls.push('preReview'); return mkReview(); },
    finalReview: () => { calls.push('finalReview'); return mkReview(); },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
    telegramSpawn: () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 900 })}\n` }),
  };
  if (sink) deps.reviewEvalSink = sink;
  return deps;
}

test('review-eval wiring (#100): sink success => evalPersisted=true, records persisted via the real sink', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-re-'));
  const { sessionPath, id: ID } = mkSession(stateDir);
  const calls = [];
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: baseDeps(calls, { sink: appendReviewEvaluation }) });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');

  // Both review steps persisted an evaluation record for THIS identity.
  const recs = readReviewEvaluations({ stateDir, identityHash: ID });
  assert.equal(recs.length, 2);
  assert.deepEqual(recs.map((r) => r.kind).sort(), ['FINAL_REVIEW', 'PRE_REVIEW']);
  assert.ok(recs.every((r) => r.identityHash === ID && /^[0-9a-f]{64}$/.test(r.digest)));
  assert.ok(recs.every((r) => r.verdict === 'PASS' && Number.isFinite(r.durationMs)));
  // Issue #100 rework: every record is bound to the packet evidence it evaluated.
  assert.ok(recs.every((r) => r.packetSha256 === 'c'.repeat(64) && r.packetName === 'pkt_review-ready.md'));

  // Transition evidence carries evalPersisted=true on both review steps.
  const ts = readTransitions({ stateDir, identityHash: ID });
  const pre = ts.find((t) => t.from === 'PRE_REVIEWING' && t.to === 'FINAL_REVIEWING');
  const fin = ts.find((t) => t.from === 'FINAL_REVIEWING' && t.to === 'DECIDING');
  assert.equal(pre.evidence.evalPersisted, true);
  assert.equal(fin.evidence.evalPersisted, true);
});

test('review-eval wiring (#100): sink throw is isolated — FSM still COMPLETED, unchanged reason, evalPersisted=false', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-re-'));
  const { sessionPath, id: ID } = mkSession(stateDir);
  const calls = [];
  const res = await runControlLoop({
    sessionPath, identityHash: ID, stateDir,
    deps: baseDeps(calls, { sink: () => { throw new Error('EVAL_STORE_DOWN'); } }),
  });
  // The sink rejection must NOT change the FSM outcome or reason.
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  assert.deepEqual(calls, ['router', 'executor', 'verifier', 'preReview', 'finalReview', 'delivery']);
  const rec = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(rec.state, 'COMPLETED');

  const ts = readTransitions({ stateDir, identityHash: ID });
  const pre = ts.find((t) => t.from === 'PRE_REVIEWING' && t.to === 'FINAL_REVIEWING');
  const fin = ts.find((t) => t.from === 'FINAL_REVIEWING' && t.to === 'DECIDING');
  assert.equal(pre.evidence.evalPersisted, false);
  assert.equal(fin.evidence.evalPersisted, false);
  // No transition was derailed into BLOCKED by the sink failure.
  assert.ok(!ts.some((t) => t.to === 'BLOCKED'), JSON.stringify(ts));
  assert.deepEqual(readReviewEvaluations({ stateDir, identityHash: ID }), []);
});

test('review-eval wiring (#100): durationMs present on every step transition (and only those)', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-re-'));
  const { sessionPath, id: ID } = mkSession(stateDir);
  const calls = [];
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: baseDeps(calls) });
  assert.equal(res.ok, true, JSON.stringify(res));

  const ts = readTransitions({ stateDir, identityHash: ID });
  const stepPairs = new Set([
    'ROUTED->EXECUTING', 'EXECUTING->VERIFYING', 'VERIFYING->PRE_REVIEWING',
    'PRE_REVIEWING->FINAL_REVIEWING', 'FINAL_REVIEWING->DECIDING',
  ]);
  for (const t of ts) {
    const pair = `${t.from}->${t.to}`;
    if (stepPairs.has(pair)) {
      assert.ok(Number.isFinite(t.durationMs) && t.durationMs >= 0, `${pair} durationMs=${t.durationMs}`);
      stepPairs.delete(pair);
    } else {
      // Boundary transitions made via loop.transition carry no durationMs.
      assert.equal(t.durationMs, undefined, `${pair} must not carry durationMs`);
    }
  }
  assert.equal(stepPairs.size, 0, `missing step transitions: ${[...stepPairs].join(', ')}`);
});

test('review-eval wiring (#100): summarizePhaseLatency shape on a synthetic transition list', () => {
  const synthetic = [
    { from: 'ACCEPTED', to: 'ROUTED', reason: 'loop-bind' }, // no durationMs -> excluded
    { from: 'ROUTED', to: 'EXECUTING', durationMs: 5 },
    { from: 'EXECUTING', to: 'VERIFYING', durationMs: 7 },
    { from: 'VERIFYING', to: 'PRE_REVIEWING', durationMs: 1 },
  ];
  const s = summarizePhaseLatency(synthetic);
  assert.deepEqual(s, {
    phases: [
      { from: 'ROUTED', to: 'EXECUTING', durationMs: 5 },
      { from: 'EXECUTING', to: 'VERIFYING', durationMs: 7 },
      { from: 'VERIFYING', to: 'PRE_REVIEWING', durationMs: 1 },
    ],
    totalMs: 13,
  });
  // Degenerate inputs are safe.
  assert.deepEqual(summarizePhaseLatency([]), { phases: [], totalMs: 0 });
  assert.deepEqual(summarizePhaseLatency(undefined), { phases: [], totalMs: 0 });
});
