// tests/pre-gate-review-rework.test.mjs — PRE-GATE-REVIEW-01 rework seam.
// Proves: an INTERNAL_REVIEW_FINDINGS failure at the verify step enters the
// SAME bounded rework leg the GPT REWORK verdict uses (VERIFYING->REWORK,
// exactly-once dispatch, findings verbatim into the executor instruction),
// never BLOCKED-on-fail and never a second verifier call in the same walk;
// empty-finding/transport failures stay fail-closed; a VERIFYING-tail resume
// reroutes too; a drifted-head echo and a review-only session are hard stops
// (never dispatch); the OCR transport persists a raw-evidence sidecar
// (model / executable / prompt digest / stdout tail) instead of dropping it.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runControlLoop,
  readTransitions,
  appendTransition,
  CONTROL_LOOP_SCHEMA_VERSION,
} from '../packages/control-loop/control-loop.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { createOcrReviewTransport } from '../packages/control-loop/ocr-review-transport.mjs';

const HEAD_A = 'a'.repeat(40);
const REPO = 'duongpdddic-droid/soc_brain';

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pgrr-')); }

function mkSession(stateDir, overrides = {}) {
  const repo = overrides.repo || REPO;
  const issueNumber = overrides.issueNumber || 79;
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
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session, id };
}

function mkExecRecord(stateDir, id, repo = REPO, issueNumber = 79) {
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
    telegramSpawn: () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 900 })}\n` }),
  };
}

// The composite's fail shape for CHANGES_REQUESTED (pre-gate-review.mjs detail).
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
      detail: 'ocr leg findings',
      ...overrides,
    },
  };
}

const FINDING = { severity: 'critical', path: 'src/x.mjs', content: 'bounds check missing', category: 'bug' };

test('internal review FINDINGS at verify reroutes into the bounded rework leg (fresh walk)', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir } });
  const execPath = mkExecRecord(stateDir, ID);
  const calls = [];
  const deps = baseDeps(stateDir, calls, execPath);
  let instruction = null;
  const originalExecutor = deps.executor;
  deps.executor = (ctx) => { if (ctx.reworkInstruction) instruction = ctx.reworkInstruction; return originalExecutor(ctx); };
  let verifyCalls = 0;
  deps.verifier = () => {
    calls.push('verifier');
    verifyCalls += 1;
    return verifyCalls === 1
      ? findingsFailure([FINDING])
      : { ok: true, value: { verdict: 'PASS', report: 'ok' } };
  };
  deps.finalReview = () => {
    calls.push('finalReview');
    return { ok: true, value: { verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.99, metadata: {} } };
  };

  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  assert.deepEqual(calls, ['router', 'executor:initial', 'verifier', 'executor:rework', 'verifier', 'preReview', 'finalReview', 'delivery']);
  assert.ok(instruction, 'rework instruction must reach the executor');
  assert.ok(instruction.includes('src/x.mjs') && instruction.includes('bounds check missing'), 'finding carried verbatim');

  const ledger = readTransitions({ stateDir, identityHash: ID });
  const entries = ledger.filter((r) => r.from === 'VERIFYING' && r.to === 'REWORK');
  assert.equal(entries.length, 1, 'exactly one findings dispatch');
  assert.equal(entries[0].reason, 'internal-review-findings-rework');
  assert.equal(entries[0].evidence.findings.length, 1);
  assert.ok(String(entries[0].evidence.findings[0]).includes('bounds check missing'));
  assert.ok(!ledger.some((r) => r.to === 'BLOCKED' && String(r.reason || '').startsWith('verify:FAIL')),
    'a findings reroute must never land on verify:FAIL BLOCKED');
});

test('INTERNAL_REVIEW_FINDINGS with an EMPTY findings array stays fail-closed (BLOCKED, no dispatch)', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir } });
  const calls = [];
  const deps = baseDeps(stateDir, calls, mkExecRecord(stateDir, ID));
  deps.verifier = () => { calls.push('verifier'); return findingsFailure([]); };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'VERIFY_FAILED');
  assert.deepEqual(calls, ['router', 'executor:initial', 'verifier']);
  const ledger = readTransitions({ stateDir, identityHash: ID });
  assert.ok(ledger.some((r) => r.to === 'BLOCKED' && String(r.reason || '').startsWith('verify:FAIL')));
  assert.ok(!ledger.some((r) => r.from === 'VERIFYING' && r.to === 'REWORK'));
});

test('INTERNAL_REVIEW_TRANSPORT is NOT a verdict: stays verify:FAIL BLOCKED, no rework dispatch', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir } });
  const calls = [];
  const deps = baseDeps(stateDir, calls, mkExecRecord(stateDir, ID));
  deps.verifier = () => {
    calls.push('verifier');
    return { ok: false, code: 'INTERNAL_REVIEW_TRANSPORT', detail: { status: 'ERROR', transportReason: 'TIMEOUT', detail: null } };
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'VERIFY_FAILED');
  assert.deepEqual(calls, ['router', 'executor:initial', 'verifier']);
  const ledger = readTransitions({ stateDir, identityHash: ID });
  assert.ok(ledger.some((r) => r.to === 'BLOCKED' && String(r.reason || '').startsWith('verify:FAIL')));
  assert.ok(!ledger.some((r) => r.from === 'VERIFYING' && r.to === 'REWORK'));
});

test('VERIFYING-tail resume reroutes findings through the SAME leg (no re-execute, no re-route)', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir } });
  const execPath = mkExecRecord(stateDir, ID);
  const ts = new Date().toISOString();
  appendTransition({
    stateDir, identityHash: ID, sessionPath,
    record: {
      schemaVersion: CONTROL_LOOP_SCHEMA_VERSION, ts,
      from: 'ROUTED', to: 'EXECUTING', reason: 'execute',
      evidence: { executorKind: 'opencode', model: 'x' },
      identityHash: ID, sessionPath,
    },
  });
  appendTransition({
    stateDir, identityHash: ID, sessionPath,
    record: {
      schemaVersion: CONTROL_LOOP_SCHEMA_VERSION, ts,
      from: 'EXECUTING', to: 'VERIFYING', reason: 'verify',
      evidence: { executionRecordPath: execPath },
      identityHash: ID, sessionPath,
    },
  });
  const calls = [];
  const deps = baseDeps(stateDir, calls, execPath);
  let instruction = null;
  const originalExecutor = deps.executor;
  deps.executor = (ctx) => { if (ctx.reworkInstruction) instruction = ctx.reworkInstruction; return originalExecutor(ctx); };
  let verifyCalls = 0;
  deps.verifier = () => {
    calls.push('verifier');
    verifyCalls += 1;
    return verifyCalls === 1
      ? findingsFailure([FINDING])
      : { ok: true, value: { verdict: 'PASS', report: 'ok' } };
  };
  deps.finalReview = () => {
    calls.push('finalReview');
    return { ok: true, value: { verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.99, metadata: {} } };
  };

  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  assert.deepEqual(calls, ['verifier', 'executor:rework', 'verifier', 'preReview', 'finalReview', 'delivery']);
  assert.ok(instruction && instruction.includes('bounds check missing'), 'finding carried verbatim on resume');
  const ledger = readTransitions({ stateDir, identityHash: ID });
  assert.equal(ledger.filter((r) => r.from === 'VERIFYING' && r.to === 'REWORK').length, 1);
});

test('ocr transport persists an evidence sidecar (model / executable / prompt digest / stdout tail)', async () => {
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgrr-sidecar-'));
  const obs = {
    steps: [{
      phase: 'review', model: 'nine/Soc_act', executable: 'C:/opencode.exe',
      promptSha256: 'a'.repeat(64), stdoutSha256: 'b'.repeat(64),
      stdoutBytes: 12, stdoutTail: 'tail-data',
    }],
  };
  const transport = createOcrReviewTransport({
    controlRepo: 'C:/ctrl',
    evidenceDir,
    runLeg: () => ({
      ok: true,
      value: { canonical: { findings: [] }, digest: 'e'.repeat(64), findingsCount: 0 },
      batch: { batched: false, batches: 1, totalDiffBytes: 5 },
      rulesDigest: 'd'.repeat(64),
      observability: obs,
    }),
  });
  const cand = {
    repo: REPO, issueNumber: 79, identityHash: 'f'.repeat(32),
    baseSha: 'e'.repeat(40), headSha: HEAD_A, worktreePath: 'C:/wt',
  };
  const res = await transport({ repo: REPO, pr: 272, headSha: HEAD_A, projectId: 'soc_brain' }, { candidate: cand });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.verdict, 'APPROVED');
  assert.equal(res.sidecar && res.sidecar.written, true);
  const files = fs.readdirSync(evidenceDir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1, 'exactly one sidecar written');
  const payload = JSON.parse(fs.readFileSync(path.join(evidenceDir, files[0]), 'utf8'));
  assert.equal(payload.candidate.headSha, HEAD_A);
  assert.equal(payload.verdict, 'APPROVED');
  assert.equal(payload.observability.steps[0].promptSha256, 'a'.repeat(64));
  assert.equal(payload.observability.steps[0].executable, 'C:/opencode.exe');
  assert.equal(payload.observability.steps[0].stdoutTail, 'tail-data');
  assert.equal(payload.leg.rulesDigest, 'd'.repeat(64));
  fs.rmSync(evidenceDir, { recursive: true, force: true });
});

test('sidecar persists even when the leg carries NO observability (gap recorded, not silent)', async () => {
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgrr-sidecar-'));
  const transport = createOcrReviewTransport({
    controlRepo: 'C:/ctrl',
    evidenceDir,
    runLeg: () => ({
      ok: true,
      value: { canonical: { findings: [{ severity: 'high', content: 'finding-one' }] }, digest: 'e'.repeat(64), findingsCount: 1 },
      batch: { batched: false, batches: 1, totalDiffBytes: 5 },
      rulesDigest: 'd'.repeat(64),
      // no observability: the raw-response gap must be VISIBLE on disk
    }),
  });
  const cand = {
    repo: REPO, issueNumber: 79, identityHash: 'f'.repeat(32),
    baseSha: 'e'.repeat(40), headSha: HEAD_A, worktreePath: 'C:/wt',
  };
  const res = await transport({ repo: REPO, pr: 272, headSha: HEAD_A, projectId: 'soc_brain' }, { candidate: cand });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.verdict, 'CHANGES_REQUESTED');
  assert.equal(res.findings.length, 1);
  assert.equal(res.sidecar && res.sidecar.written, true);
  const files = fs.readdirSync(evidenceDir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1);
  const payload = JSON.parse(fs.readFileSync(path.join(evidenceDir, files[0]), 'utf8'));
  assert.equal(payload.observability, null, 'missing observability must be recorded as null');
  assert.equal(payload.findingsCount, 1);
  fs.rmSync(evidenceDir, { recursive: true, force: true });
});

test('a findings echo of a DRIFTED head never dispatches (REWORK_BINDING_STALE, fail-closed)', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir } });
  const calls = [];
  const deps = baseDeps(stateDir, calls, mkExecRecord(stateDir, ID));
  // Pinned session head is HEAD_A; the reviewer echoes a DIFFERENT head —
  // a review of a drifted candidate, never re-based onto the pin.
  deps.verifier = () => {
    calls.push('verifier');
    return findingsFailure([FINDING], { responseHeadSha: 'b'.repeat(40) });
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'REWORK_BINDING_STALE');
  assert.ok(!calls.includes('executor:rework'), 'stale binding must never dispatch a rework executor');
  const ledger = readTransitions({ stateDir, identityHash: ID });
  assert.ok(!ledger.some((r) => r.from === 'VERIFYING' && r.to === 'REWORK'),
    'stale binding must never record the findings dispatch transition');
});

test('a review-only session never dispatches rework from internal findings (hard stop)', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, {
    controlPlane: { stateDir },
    controlLoop: { reviewOnly: true },
  });
  const calls = [];
  const deps = baseDeps(stateDir, calls, mkExecRecord(stateDir, ID));
  deps.verifier = () => { calls.push('verifier'); return findingsFailure([FINDING]); };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'REVIEW_ONLY_NO_REWORK_DISPATCH');
  assert.ok(Array.isArray(res.detail.findings) && res.detail.findings.length === 1,
    'the findings are surfaced even when dispatch is refused');
  assert.ok(!calls.includes('executor:rework'), 'review-only has no fresh-execution authority');
  const ledger = readTransitions({ stateDir, identityHash: ID });
  assert.ok(!ledger.some((r) => r.from === 'VERIFYING' && r.to === 'REWORK'));
});
