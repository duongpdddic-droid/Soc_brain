// tests/pre-gate-review.test.mjs — PRE-GATE-REVIEW-01 regression set.
// Proves: review runs BEFORE the inner verifier; CLEAN APPROVED calls the
// inner verifier exactly once; findings/timeout/error/missing-or-stale
// binding NEVER call the inner verifier and are never CLEAN; a candidate
// change invalidates a prior review (HEAD re-lock + correlation key).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  deriveReviewCandidate,
  preGateReviewVerifierAdapter,
  PRE_GATE_REVIEW_SCHEMA_VERSION,
} from '../packages/control-loop/pre-gate-review.mjs';
import { buildCorrelationKey } from '../packages/ai-pr-reviewer-adapter/ai-pr-reviewer-adapter.mjs';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const DIGEST_A = 'c'.repeat(64);
const DIGEST_B = 'd'.repeat(64);
const REPO = 'owner/repo';
const PROJECT_ID = 'soc_brain';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pregate-review-'));
}

function makeRegistry(dir, repository = REPO) {
  const registryPath = path.join(dir, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({
    schemaVersion: '1',
    projects: [{ projectId: PROJECT_ID, repository }],
  }));
  return registryPath;
}

function fakeSession(overrides = {}) {
  return {
    ok: true,
    session: {
      repo: REPO,
      issueNumber: 1,
      taskId: 'task-1',
      prNumber: 7,
      worktreePath: 'C:/wt',
      headSha: HEAD_A,
      baseSha: 'e'.repeat(40),
      controlPlane: { stateDir: 'C:/state' },
      ...overrides,
    },
  };
}

function fakeRecord(overrides = {}) {
  return {
    ok: true,
    record: {
      repo: REPO,
      issueNumber: 1,
      taskId: 'task-1',
      worktreePath: 'C:/wt',
      baseSha: 'e'.repeat(40),
      headSha: HEAD_A,
      codeContentDigest: DIGEST_A,
      codeContentFiles: 12,
      ...overrides,
    },
  };
}

function makeIo({ session, record, live, registryPath } = {}) {
  return {
    readSession: () => session ?? fakeSession(),
    readExecutionRecord: () => record ?? fakeRecord(),
    computeBinding: () => live ?? { ok: true, value: { headSha: HEAD_A, contentDigest: DIGEST_A, fileCount: 12 } },
    findProjectId: () => PROJECT_ID,
    registryPath,
  };
}

function approvedTransport(headSha = HEAD_A) {
  return async () => ({
    ok: true,
    verdict: 'APPROVED',
    finalReview: true,
    reviewedHeadSha: headSha,
    decisionGate: { status: 'PASS' },
    findings: [],
    openBlocking: [],
  });
}

test('CLEAN APPROVED review -> inner verifier called exactly once, verbatim pass-through', async () => {
  const dir = tmp();
  const registryPath = makeRegistry(dir);
  const events = [];
  const inner = async () => { events.push('verify'); return { ok: true, value: { verdict: 'PASS', evidence: { exitCode: 0 } } }; };
  const transport = async (req) => { events.push('review'); return approvedTransport()(req); };
  const verifier = preGateReviewVerifierAdapter({ innerVerifier: inner, transport, registryPath, io: makeIo({ registryPath }) });
  const res = await verifier({ sessionPath: 'C:/state/session.json', executionRecordPath: 'C:/state/exec.json' });
  assert.deepEqual(events, ['review', 'verify'], 'review must run before the verifier');
  assert.equal(res.ok, true);
  assert.equal(res.value.verdict, 'PASS');
  assert.equal(res.value.evidence.exitCode, 0);
});

test('findings (critical/open) block the gate: inner verifier never called', async () => {
  const dir = tmp();
  const registryPath = makeRegistry(dir);
  let innerCalls = 0;
  const inner = async () => { innerCalls += 1; return { ok: true, value: { verdict: 'PASS' } }; };
  const transport = async () => ({
    ok: true,
    verdict: 'CHANGES_REQUESTED',
    finalReview: true,
    reviewedHeadSha: HEAD_A,
    decisionGate: { status: 'PASS' },
    findings: [{ severity: 'critical', status: 'open', title: 'broken' }],
    openBlocking: [],
  });
  const verifier = preGateReviewVerifierAdapter({ innerVerifier: inner, transport, registryPath, io: makeIo({ registryPath }) });
  const res = await verifier({ sessionPath: 'C:/s', executionRecordPath: 'C:/e' });
  assert.equal(innerCalls, 0);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'INTERNAL_REVIEW_FINDINGS');
  assert.notEqual(res.code, undefined);
});

test('timeout is not CLEAN: inner verifier never called, typed INTERNAL_REVIEW_TRANSPORT', async () => {
  const dir = tmp();
  const registryPath = makeRegistry(dir);
  let innerCalls = 0;
  const inner = async () => { innerCalls += 1; return { ok: true, value: { verdict: 'PASS' } }; };
  const transport = () => new Promise(() => {}); // never resolves
  const verifier = preGateReviewVerifierAdapter({ innerVerifier: inner, transport, timeoutMs: 50, registryPath, io: makeIo({ registryPath }) });
  const res = await verifier({ sessionPath: 'C:/s', executionRecordPath: 'C:/e' });
  assert.equal(innerCalls, 0);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'INTERNAL_REVIEW_TRANSPORT');
  assert.equal(res.detail.transportReason, 'TIMEOUT');
});

test('default (unsupported) transport is not CLEAN and blocks the gate', async () => {
  const dir = tmp();
  const registryPath = makeRegistry(dir);
  let innerCalls = 0;
  const inner = async () => { innerCalls += 1; return { ok: true, value: { verdict: 'PASS' } }; };
  const verifier = preGateReviewVerifierAdapter({ innerVerifier: inner, registryPath, io: makeIo({ registryPath }) });
  const res = await verifier({ sessionPath: 'C:/s', executionRecordPath: 'C:/e' });
  assert.equal(innerCalls, 0);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'INTERNAL_REVIEW_TRANSPORT');
  assert.equal(res.detail.transportReason, 'UNSUPPORTED_TRANSPORT');
});

test('missing content binding in the record blocks the gate', async () => {
  const dir = tmp();
  const registryPath = makeRegistry(dir);
  let innerCalls = 0;
  const inner = async () => { innerCalls += 1; return { ok: true, value: { verdict: 'PASS' } }; };
  const io = makeIo({ record: fakeRecord({ codeContentDigest: null }), registryPath });
  const verifier = preGateReviewVerifierAdapter({ innerVerifier: inner, transport: approvedTransport(), registryPath, io });
  const res = await verifier({ sessionPath: 'C:/s', executionRecordPath: 'C:/e' });
  assert.equal(innerCalls, 0);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'INTERNAL_REVIEW_CONTENT_BINDING_MISSING');
});

test('live candidate drifted (digest mismatch) blocks the gate', async () => {
  const dir = tmp();
  const registryPath = makeRegistry(dir);
  let innerCalls = 0;
  const inner = async () => { innerCalls += 1; return { ok: true, value: { verdict: 'PASS' } }; };
  const io = makeIo({ live: { ok: true, value: { headSha: HEAD_A, contentDigest: DIGEST_B, fileCount: 12 } }, registryPath });
  const verifier = preGateReviewVerifierAdapter({ innerVerifier: inner, transport: approvedTransport(), registryPath, io });
  const res = await verifier({ sessionPath: 'C:/s', executionRecordPath: 'C:/e' });
  assert.equal(innerCalls, 0);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'INTERNAL_REVIEW_CANDIDATE_STALE');
});

test('stale record (session mismatch) blocks the gate', async () => {
  const dir = tmp();
  const registryPath = makeRegistry(dir);
  let innerCalls = 0;
  const inner = async () => { innerCalls += 1; return { ok: true, value: { verdict: 'PASS' } }; };
  const io = makeIo({ record: fakeRecord({ repo: 'other/repo' }), registryPath });
  const verifier = preGateReviewVerifierAdapter({ innerVerifier: inner, transport: approvedTransport(), registryPath, io });
  const res = await verifier({ sessionPath: 'C:/s', executionRecordPath: 'C:/e' });
  assert.equal(innerCalls, 0);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'INTERNAL_REVIEW_RECORD_STALE');
});

test('unbound PR blocks the gate', async () => {
  const dir = tmp();
  const registryPath = makeRegistry(dir);
  let innerCalls = 0;
  const inner = async () => { innerCalls += 1; return { ok: true, value: { verdict: 'PASS' } }; };
  const io = makeIo({ session: fakeSession({ prNumber: undefined }), registryPath });
  const verifier = preGateReviewVerifierAdapter({ innerVerifier: inner, transport: approvedTransport(), registryPath, io });
  const res = await verifier({ sessionPath: 'C:/s', executionRecordPath: 'C:/e' });
  assert.equal(innerCalls, 0);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'INTERNAL_REVIEW_PR_UNBOUND');
});

test('candidate change invalidates a prior review: new HEAD fails the head lock; correlation key changes', async () => {
  const dir = tmp();
  const registryPath = makeRegistry(dir);
  let innerCalls = 0;
  const inner = async () => { innerCalls += 1; return { ok: true, value: { verdict: 'PASS' } }; };
  // Candidate moved to HEAD_B (record flipped). A transport that "still"
  // approves HEAD_A (the stale review) must not unlock the gate.
  const io = makeIo({
    session: fakeSession({ headSha: HEAD_B }),
    record: fakeRecord({ headSha: HEAD_B, codeContentDigest: DIGEST_B }),
    live: { ok: true, value: { headSha: HEAD_B, contentDigest: DIGEST_B, fileCount: 12 } },
    registryPath,
  });
  const staleApprover = async () => ({
    ok: true,
    verdict: 'APPROVED',
    finalReview: true,
    reviewedHeadSha: HEAD_A, // stale approval for the old candidate
    decisionGate: { status: 'PASS' },
    findings: [],
    openBlocking: [],
  });
  const verifier = preGateReviewVerifierAdapter({ innerVerifier: inner, transport: staleApprover, registryPath, io });
  const res = await verifier({ sessionPath: 'C:/s', executionRecordPath: 'C:/e' });
  assert.equal(innerCalls, 0);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'INTERNAL_REVIEW_NOT_APPROVED'); // adapter: HEAD_MISMATCH -> BLOCKED
  const k1 = buildCorrelationKey({ repo: REPO, pr: 7, headSha: HEAD_A, projectId: PROJECT_ID });
  const k2 = buildCorrelationKey({ repo: REPO, pr: 7, headSha: HEAD_B, projectId: PROJECT_ID });
  assert.notEqual(k1, k2, 'correlation key must change with the candidate HEAD');
});

test('registry project unbound blocks the gate', async () => {
  const dir = tmp();
  const registryPath = makeRegistry(dir, 'someone/else');
  let innerCalls = 0;
  const inner = async () => { innerCalls += 1; return { ok: true, value: { verdict: 'PASS' } }; };
  const io = makeIo({ registryPath });
  delete io.findProjectId; // fall back to the real registry lookup
  const verifier = preGateReviewVerifierAdapter({ innerVerifier: inner, transport: approvedTransport(), registryPath, io });
  const res = await verifier({ sessionPath: 'C:/s', executionRecordPath: 'C:/e' });
  assert.equal(innerCalls, 0);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'INTERNAL_REVIEW_PROJECT_UNBOUND');
});

test('deriveReviewCandidate returns the bound candidate for a healthy session', async () => {
  const dir = tmp();
  const registryPath = makeRegistry(dir);
  const res = deriveReviewCandidate({ sessionPath: 'C:/s', executionRecordPath: 'C:/e', io: makeIo({ registryPath }) });
  assert.equal(res.ok, true);
  assert.equal(res.value.headSha, HEAD_A);
  assert.equal(res.value.contentDigest, DIGEST_A);
  assert.equal(res.value.prNumber, 7);
  assert.equal(res.value.projectId, PROJECT_ID);
});

test('schema version constant is exposed', () => {
  assert.equal(PRE_GATE_REVIEW_SCHEMA_VERSION, '1');
});
