// tests/control-loop.review-eval.test.mjs — Issue #92 (P1-1) control-loop
// wiring: failure-isolated reviewEvalSink, evalPersisted evidence on the
// step transitions, in-process step durationMs, summarizePhaseLatency shape,
// and the pre-review packet sha256/identity binding.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  runControlLoop,
  readTransitions,
  summarizePhaseLatency,
} from '../packages/control-loop/control-loop.mjs';
import { collectPreReviewEvidence } from '../packages/control-loop/gemini-pre-review.mjs';
import { appendReviewEvaluation, readReviewEvaluations, compareReviewEvaluations } from '../packages/review-eval/review-eval.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cl-re-')); }
function mkReviewReadyDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cl-re-rr-')); }

const HEAD = 'a'.repeat(40);
const BASE = 'f'.repeat(40);

// Canonical session record mirroring runtime-sandbox taskStart output (the
// filename must be the real identityHash of (repo, issueNumber) — enforced by
// readSessionRecord's canonical control-plane location check).
function mkSession(stateDir, overrides = {}) {
  const repo = 'duongpdddic-droid/soc_brain';
  const issueNumber = 92;
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
    worktreePath: path.join(stateDir, 'wt-issue-92'),
    worktreesRoot: stateDir,
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session, id };
}

function spawnOk() {
  return () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 901 })}\n` });
}

function happyDeps(overrides = {}) {
  return {
    router: () => ({ ok: true, value: { executorKind: 'opencode', model: 'x' } }),
    executor: () => ({ ok: true, value: { executionRecordPath: '/fake/execution.json' } }),
    verifier: () => ({ ok: true, value: { verdict: 'PASS', findings: [] } }),
    preReview: () => ({ ok: true, value: { verdict: 'PASS', score: 0.7, findings: [], confidence: 0.9, metadata: {} } }),
    finalReview: () => ({ ok: true, value: { verdict: 'PASS', score: 0.9, findings: [], evidenceRequests: [], confidence: 0.95, metadata: {} } }),
    delivery: () => ({ ok: true, value: { shipped: true } }),
    telegramSpawn: spawnOk(),
    reviewReadyDir: mkReviewReadyDir(), // empty: packet resolution degrades deterministically
    ...overrides,
  };
}

// The two review step transitions whose evidence must carry evalPersisted.
function reviewStepRecords(recs) {
  return [
    recs.find((r) => r.from === 'PRE_REVIEWING' && r.to === 'FINAL_REVIEWING'),
    recs.find((r) => r.from === 'FINAL_REVIEWING' && r.to === 'DECIDING'),
  ];
}

test('R1. reviewEvalSink success: evalPersisted=true and records land in the store', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const sinkCalls = [];
  const res = await runControlLoop({
    sessionPath, identityHash: ID, stateDir,
    deps: happyDeps({
      reviewEvalSink: async (input) => { sinkCalls.push(input); return appendReviewEvaluation({ stateDir, identityHash: ID, ...input }); },
    }),
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');

  // sink receives the loop contract shape: kind + review + reviewDurationMs
  assert.deepEqual(sinkCalls.map((c) => c.kind), ['PRE_REVIEW', 'FINAL_REVIEW']);
  assert.ok(sinkCalls.every((c) => c.review && c.review.verdict === 'PASS'), JSON.stringify(sinkCalls));
  assert.ok(sinkCalls.every((c) => Number.isFinite(c.reviewDurationMs) && c.reviewDurationMs >= 0), JSON.stringify(sinkCalls));

  const recs = readTransitions({ stateDir, identityHash: ID });
  const [pre, fin] = reviewStepRecords(recs);
  assert.equal(pre.evidence.evalPersisted, true);
  assert.equal(fin.evidence.evalPersisted, true);

  // the store holds exactly the loop's two evaluations
  const stored = readReviewEvaluations({ stateDir, identityHash: ID });
  assert.deepEqual(stored.map((r) => r.kind), ['PRE_REVIEW', 'FINAL_REVIEW']);
  assert.ok(stored.every((r) => r.verdict === 'PASS' && /^[0-9a-f]{64}$/.test(r.digest) && Number.isFinite(r.durationMs)));
  const agg = compareReviewEvaluations(stored);
  assert.equal(agg.total, 2);
  assert.equal(agg.approvals, 2);
  assert.equal(agg.preReview, 1);
  assert.equal(agg.finalReview, 1);
});

test('R2. reviewEvalSink that throws is failure-isolated: FSM reaches terminal state, evalPersisted=false', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const sinkCalls = [];
  const res = await runControlLoop({
    sessionPath, identityHash: ID, stateDir,
    deps: happyDeps({
      reviewEvalSink: async (input) => { sinkCalls.push(input); throw new Error('STORE_DOWN'); },
    }),
  });
  // FSM state/reason MUST NOT change: the loop still terminalizes COMPLETED.
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  assert.equal(sinkCalls.length, 2, 'sink attempted after each successful review step');
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(session.state, 'COMPLETED');

  const recs = readTransitions({ stateDir, identityHash: ID });
  const [pre, fin] = reviewStepRecords(recs);
  assert.equal(pre.from, 'PRE_REVIEWING');
  assert.equal(pre.to, 'FINAL_REVIEWING');
  assert.equal(fin.from, 'FINAL_REVIEWING');
  assert.equal(fin.to, 'DECIDING');
  assert.equal(pre.evidence.evalPersisted, false);
  assert.equal(fin.evidence.evalPersisted, false);
  // evidence stays the real review payload (state/reason untouched, no eval error leaked)
  assert.equal(pre.evidence.verdict, 'PASS');
  assert.equal(fin.evidence.verdict, 'PASS');
  assert.ok(!('raw' in pre.evidence) || pre.evidence.raw === undefined);
  // the canonical boundary + terminal transitions still happened
  assert.ok(recs.some((r) => r.from === 'DECIDING' && r.to === 'DELIVERING'));
  assert.ok(recs.some((r) => r.to === 'COMPLETED'));
});

test('R3. rejected-promise sink is equally failure-isolated (async rejection, not sync throw)', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const res = await runControlLoop({
    sessionPath, identityHash: ID, stateDir,
    deps: happyDeps({
      reviewEvalSink: () => Promise.reject(new Error('ASYNC_STORE_DOWN')),
    }),
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  const recs = readTransitions({ stateDir, identityHash: ID });
  const [pre, fin] = reviewStepRecords(recs);
  assert.equal(pre.evidence.evalPersisted, false);
  assert.equal(fin.evidence.evalPersisted, false);
});

test('R4. every step transition records in-process durationMs; non-step transitions are unaffected', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: happyDeps({}) });
  assert.equal(res.ok, true, JSON.stringify(res));
  const recs = readTransitions({ stateDir, identityHash: ID });
  const stepPairs = [
    ['ROUTED', 'EXECUTING'],
    ['EXECUTING', 'VERIFYING'],
    ['VERIFYING', 'PRE_REVIEWING'],
    ['PRE_REVIEWING', 'FINAL_REVIEWING'],
    ['FINAL_REVIEWING', 'DECIDING'],
  ];
  for (const [from, to] of stepPairs) {
    const rec = recs.find((r) => r.from === from && r.to === to);
    assert.ok(rec, `missing step transition ${from}->${to}`);
    assert.ok(Number.isFinite(rec.durationMs) && rec.durationMs >= 0, `${from}->${to} durationMs=${rec.durationMs}`);
  }
  // ledger-level transitions (boundary/terminal) are loop.transition records —
  // they carry no measured step duration, and the existing shape is unchanged.
  const boundary = recs.find((r) => r.from === 'DECIDING' && r.to === 'DELIVERING');
  assert.ok(boundary, 'DELIVERING boundary recorded');
  assert.ok(!('durationMs' in boundary) || boundary.durationMs === undefined);
});

test('R5. summarizePhaseLatency: phases from measured transitions, totalMs = last.ts - first.ts', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: happyDeps({}) });
  assert.equal(res.ok, true, JSON.stringify(res));
  const recs = readTransitions({ stateDir, identityHash: ID });
  const s = summarizePhaseLatency(recs);
  assert.ok(Array.isArray(s.phases), 'phases is an array');
  assert.ok(s.phases.length >= 5, `one phase per measured step transition (got ${s.phases.length})`);
  assert.ok(s.phases.every((p) => typeof p.from === 'string' && typeof p.to === 'string' && Number.isFinite(p.durationMs)));
  const first = Date.parse(recs[0].ts);
  const last = Date.parse(recs[recs.length - 1].ts);
  assert.equal(s.totalMs, Math.max(0, last - first));

  // degenerate inputs stay deterministic
  assert.deepEqual(summarizePhaseLatency([]), { phases: [], totalMs: 0 });
  assert.deepEqual(summarizePhaseLatency(undefined), { phases: [], totalMs: 0 });
  const single = summarizePhaseLatency([{ ts: '2026-01-01T00:00:00.000Z', from: 'A', to: 'B', durationMs: 5 }]);
  assert.deepEqual(single.phases, [{ from: 'A', to: 'B', durationMs: 5 }]);
  assert.equal(single.totalMs, 0, 'single record spans zero wall time');
});

test('R6. pre-review packet evidence carries sha256 of the exact bytes + filename + identityHash', () => {
  const stateDir = mkStateDir();
  const { sessionPath, session, id: ID } = mkSession(stateDir);
  const dir = path.join(stateDir, 'review-ready');
  fs.mkdirSync(dir, { recursive: true });
  const name = `duongpdddic-droid_Soc_brain_Issue-92_PR-93_${HEAD.slice(0, 7)}_review-ready.md`;
  const content = [
    `# Review Ready — ${session.repo} Issue #${session.issueNumber} · PR #93`,
    '',
    '## Identity',
    `- repository: ${session.repo}`,
    `- issue: ${session.issueNumber}`,
    '- pullRequest: 93',
    `- headSha: ${HEAD} (short ${HEAD.slice(0, 7)})`,
    `- baseSha: ${BASE}`,
    '- prState: OPEN',
    '',
    'Canonical packet body.',
  ].join('\n');
  fs.writeFileSync(path.join(dir, name), content, 'utf8');

  const ev = collectPreReviewEvidence({ sessionPath, report: {}, reviewReadyDir: dir });
  assert.equal(ev.ok, true, JSON.stringify(ev.code || ev));
  const expectedSha = createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex');
  assert.equal(ev.packet.sha256, expectedSha, 'sha256 is of the exact on-disk packet bytes');
  assert.equal(ev.packet.filename, name);
  assert.equal(ev.packet.identityHash, ID);
  // pre-existing fields intact (reviewer-agent flow unchanged)
  assert.equal(ev.packet.name, name);
  assert.equal(ev.packet.excerpt, content);
  assert.equal(ev.packet.truncated, false);
});

test('R7. no sink configured: evidence carries no evalPersisted key (regression guard)', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: happyDeps({}) });
  assert.equal(res.ok, true, JSON.stringify(res));
  const recs = readTransitions({ stateDir, identityHash: ID });
  const [pre, fin] = reviewStepRecords(recs);
  assert.ok(!('evalPersisted' in pre.evidence));
  assert.ok(!('evalPersisted' in fin.evidence));
  assert.equal(res.value.state, 'COMPLETED');
});
