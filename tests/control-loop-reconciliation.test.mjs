import { reviewFixture, persistedDecision } from './fixtures/web2api-review.mjs';
// tests/control-loop.test.mjs — deterministic regression tests for Issue #69.
// No external framework; plain node:test.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { stageObservationLine, STAGE_OBSERVATION_PREFIX, STAGE_OBSERVATION_KIND } from '../packages/control-loop/boundary-observation.mjs';

import {
  CONTROL_LOOP_SCHEMA_VERSION,
  LOOP_STATES,
  TERMINAL_STATES,
  ROUTE_RETRY_SUPPORTED_CODES,
  EXECUTE_INSTRUCTION_RETRY_LIMIT,
  recordPreSubmitBoundaryReconciled,
  canonicalSubmitVeto,
  readTransitions,
  appendTransition,
  bindLoop,
  runControlLoop,
  assertTerminalizationAuthorized,
  bindTerminalizeTokenToSession,
  recoverDecisionContract,
} from '../packages/control-loop/control-loop.mjs';
import { resolveRunnerInstruction, readPersistedRouteGoal } from '../bin/soc-control-loop.mjs';
import { readSessionRecord, updateSessionUnderOwnershipLock } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
// REWORK F3 (REC-01): namespace access to the production runner so the new
// reconciliation entry fails per-assertion (not at module link) while it does
// not exist yet.
import * as socRunnerBin from '../bin/soc-control-loop.mjs';
import { createSessionAuthority } from '../packages/session-authority/authority-server.mjs';
import { admitSession, releaseAdmission, setSessionAdmissionMode, ownIncarnation, assertAdmissionFence, __resetAdmissionForTests } from '../packages/session-authority/guard.mjs';
// REC-01: namespace access so the new seam's tests fail per-assertion (not at
// module link) while sealPreSubmitBoundaryReconciled does not exist yet.
import * as ctrlApi from '../packages/control-loop/control-loop.mjs';
import { authorityBindLockPath } from '../packages/session-authority/protocol.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { decisionDigest, buildReworkRecord } from '../packages/control-loop/rework.mjs';
import { deterministicVerifierAdapter } from '../packages/control-loop/adapters.mjs';

// ---- BASE FIXTURES & HELPERS (SHARED FROM FSM SUITE) ----

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cl-test-')); }

// P0-F canonical-delivery fixture constants (canonical session shape).
const HEAD = 'a'.repeat(40);
const BASE = 'f'.repeat(40);
const WORKTREES_ROOT = path.join(os.tmpdir(), 'cl-wt-root');

// Build a fake canonical session record at stateDir/sessions/<id>.json,
// mirroring what runtime-sandbox taskStart writes. readSessionRecord enforces
// the canonical control-plane location, so the filename must be the real
// identityHash of (repo, issueNumber).
function mkSession(stateDir, overrides = {}) {
  const repo = overrides.repo || 'duongpdddic-droid/soc_brain';
  const issueNumber = overrides.issueNumber || 69;
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
    worktreePath: path.join(WORKTREES_ROOT, `issue-${issueNumber}`),
    worktreesRoot: WORKTREES_ROOT,
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session, id };
}



// ---- RECONCILIATION FIXTURES & ADAPTATION HELPERS ----

// preReview:FAIL retry (no resend, no duplicate submit).
// ---------------------------------------------------------------------------

function seedLedger(sessionPath, stateDir, ID, records) {
  const loop = bindLoop({ sessionPath, identityHash: ID, stateDir });
  for (const r of records) {
    const t = loop.transition({ from: r.from, to: r.to, reason: r.reason || 'seed', evidence: r.evidence ?? null });
    assert.ok(t.ok, `seed ${r.from}->${r.to}`);
  }
}

function preReviewTimeoutLedger(sessionPath, stateDir, ID, { reason = 'preReview:THREW', evidence = 'CDP_SEND_TIMEOUT' } = {}) {
  seedLedger(sessionPath, stateDir, ID, [
    { from: 'ACCEPTED', to: 'ROUTED' },
    { from: 'ROUTED', to: 'EXECUTING', evidence: { executorKind: 'opencode', model: 'opencode/nemotron-3-ultra-free' } },
    { from: 'EXECUTING', to: 'VERIFYING', evidence: { executionRecordPath: '/fake/exec.json' } },
    { from: 'VERIFYING', to: 'PRE_REVIEWING', evidence: { verdict: 'PASS', report: 'ok' } },
    { from: 'PRE_REVIEWING', to: 'BLOCKED', reason, evidence },
  ]);
}

// REC-01 r4: the PRODUCTION attempt-linkage fixtures. `preReviewAttemptLedger`
// seeds the canonical failure evidence the transport produces in production
// (typed preReview:FAIL tail whose evidence.detail carries the transport
// attempt id); `checkpointFromTail` builds the checkpoint exactly as the
// recovery gate / Operator entry must: code from the evidence, attempt id from
// the SAME canonical failure evidence - never from the marker.
function preReviewAttemptLedger(sessionPath, stateDir, ID, { code = 'CDP_SEND_TIMEOUT', attemptId = 'fixture-attempt-1', detail } = {}) {
  const d = detail === undefined
    ? {
      // r5 default = a canonical failure with ONLY the attempt linkage and NO
      // submit-state metadata: compatible with PRE_SUBMIT (never vetoed) but
      // still structurally unproven, so the recovery gate consults the
      // canonical record and keeps the attempt linkage end-to-end. A canonical
      // failure that CLAIMS the submit started (SUBMIT_IN_FLIGHT / submitted
      // UNKNOWN|true / POST_SUBMIT) is opted into explicitly by the veto tests.
      attemptId,
    }
    : (detail === null ? null : { ...detail, attemptId });
  preReviewTimeoutLedger(sessionPath, stateDir, ID, { reason: 'preReview:FAIL', evidence: { ok: false, code, detail: d } });
}
function checkpointFromTail(tail, { attemptId } = {}) {
  const ev = tail && tail.evidence;
  const code = typeof ev === 'string' ? ev : String((ev && ev.code) || '');
  const aid = attemptId !== undefined
    ? attemptId
    : (ev && typeof ev === 'object' && ev.detail && typeof ev.detail.attemptId === 'string' && ev.detail.attemptId.trim() ? ev.detail.attemptId : null);
  return { ts: String(tail.ts), reason: String(tail.reason), evidence: code, ...(aid ? { attemptId: aid } : {}) };
}

function preReviewRetryDeps(calls, overrides = {}) {
  return {
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: '/fake/exec.json' } }; },
    verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [], confidence: 0.5, metadata: {} } }; },
    finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'BLOCKED', findings: [] } }; },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
    ...overrides,
  };
}

function writeSubmitArtifact(stateDir, ID) {
  const dir = path.join(stateDir, 'web2api-review-requests', ID);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'x.submit.json');
  fs.writeFileSync(p, JSON.stringify({ state: 'WRITE_STARTED' }), 'utf8');
  return p;
}

function readReviewStoreCount(stateDir, ID) {
  try {
    return fs.readdirSync(path.join(stateDir, 'web2api-review-requests', ID)).length;
  } catch {
    return 0;
  }
}

test('P1. legacy THREW + EMPTY store but NO canonical boundary record -> typed BLOCK (artifact absence proves nothing)', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  preReviewTimeoutLedger(sessionPath, stateDir, ID);
  assert.equal(readReviewStoreCount(stateDir, ID), 0, 'store starts empty - and that alone must NOT authorize a retry');
  const before = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
  const calls = [];
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls) });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED');
  assert.equal(res.detail.reconcile.reason, 'RECORD_ABSENT', 'the missing canonical record is named');
  assert.deepEqual(calls, [], 'zero transition/submit: no adapter runs');
  assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), before, 'ledger untouched');
});

// ---- Boundary reconciliation authority fixtures ----------------------------
// CORRECTION: SOC_CONTROL_LANE == session.mutationOwner.laneId only proves
// lane CONFIGURATION (any script can set an env var) - it is NEVER caller
// authority. The writer requires the EXISTING Session Admission fence (live,
// pipe-verified, daemon-audited - the same seam runtime-sandbox uses); the
// reader re-checks the recorded grant against the DAEMON-WRITTEN durable
// owner snapshot plus canonical identity/checkpoint and the evidence sha256.
// Self-claimed source/basis strings (legacy offline record shape) never
// authorize a retry. Note: while armed, EVERY ledger append is fence-gated
// (appendTransition), so tests must admit BEFORE seedLedger.
function seedMutationOwner(stateDir, ID, laneId = 'opencode-control-lane') {
  const p = path.join(stateDir, 'sessions', `${ID}.json`);
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  s.mutationOwner = { laneId, since: '2026-10-03T00:00:00.000Z', acquiredVia: 'ADMISSION', history: [] };
  fs.writeFileSync(p, JSON.stringify(s, null, 2), 'utf8');
}

function boundaryKeyOf(tail) {
  return createHash('sha256').update(`${String(tail.ts)}|${String(tail.reason)}|${String(tail.evidence)}`).digest('hex').slice(0, 16);
}

function writeLegacySelfClaimedRecord(stateDir, ID, tail) {
  const dir = path.join(stateDir, 'control-loop', ID, 'pre-submit-boundary');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${boundaryKeyOf(tail)}.json`);
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: '1',
    kind: 'PRE_SUBMIT_BOUNDARY_RECONCILED',
    identityHash: ID,
    checkpoint: { ts: tail.ts, reason: tail.reason, evidence: tail.evidence },
    source: 'offline-diagnosis:transport-log+code-order',
    basis: 'self-claimed sha of a log the writer never re-read',
    reconciledAt: '2026-10-03T05:01:15.549Z',
  }, null, 2), 'utf8');
  return file;
}

// REWORK F2-src (round 2): the evidence file a reconciliation record binds
// carries the transport stage-tracker's provenance marker line by DEFAULT —
// exactly like a real captured transport log. Fixtures that need a marker-less
// legacy log pass their own content explicitly.
// REC-01 r3: the default marker is BOUND like production emits it - the
// canonical identity of the ONE session in this state dir plus a fixture
// attempt id (an unbound/foreign marker is a typed block, never a silent
// default). Explicit-content callers stay free to build legacy/unbound/foreign
// marker variants on purpose.
function fixtureMarkerBinding(stateDir) {
  const sessionsDir = path.join(stateDir, 'sessions');
  let names = [];
  try { names = fs.readdirSync(sessionsDir).filter((n) => n.endsWith('.json')); } catch { names = []; }
  return {
    identityHash: names.length === 1 ? path.basename(names[0], '.json') : null,
    attemptId: 'fixture-attempt-1',
  };
}
function writeEvidenceFile(stateDir, content = null) {
  const p = path.join(stateDir, 'boundary-source.log');
  const text = typeof content === 'string'
    ? content
    : `boundary fixture log v1\n${stageObservationLine(fixtureMarkerBinding(stateDir))}\n`;
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

// REWORK F2 (REC-01): the canonical boundary OBSERVATION a writer must record.
// Only a proven pre-submit observation may ever be reconciled; UNKNOWN,
// SUBMIT_IN_FLIGHT and POST_SUBMIT are typed refusals before seal/retry.
function validBoundaryObservation(over = {}) {
  return {
    phase: 'PRE_SUBMIT',
    submitState: 'NOT_SUBMITTED',
    observedAt: new Date().toISOString(),
    source: 'transport-stage-tracker',
    ...over,
  };
}




// Starts a REAL Session Authority daemon on a private pipe, arms the admission
// contract, and (by default) admits THIS test process for the requested
// identities. SOC_CONTROL_LANE is set to the "correct" value on purpose to
// prove env config alone never authorizes anything.
async function withSessionAuthority(fn, { admit = true } = {}) {
  const pipe = `\\\\.\\pipe\\sa-cc-${createHash('sha256').update(`${process.pid}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 12)}`;
  const authority = createSessionAuthority({ pipePath: pipe });
  let started = null;
  try {
    started = await authority.start();
  } catch (e) {
    started = { ok: false, err: String((e && e.message) || e) };
  }
  assert.equal(started && started.ok, true, `session authority start failed: ${JSON.stringify(started)}`);
  setSessionAdmissionMode('required');
  const prevLane = process.env.SOC_CONTROL_LANE;
  process.env.SOC_CONTROL_LANE = 'opencode-control-lane'; // correct CONFIG on purpose - never authority
  // REWORK F3-grant: publish the canonical env contract the PRODUCTION entry
  // (and its spawned CLI) resolve their authority pipe from. Without it a
  // caller that admits FIRST (before any shared client exists) would fall back
  // to the default endpoint instead of THIS daemon's pipe. Same pipe the
  // explicit `admit` callback passes, so existing callers are unchanged.
  const prevAuthPipe = process.env.SOC_SESSION_AUTHORITY_PIPE_PATH;
  process.env.SOC_SESSION_AUTHORITY_PIPE_PATH = pipe;
  try {
    await fn({
      admitEnabled: admit,
      pipePath: pipe, // F3: lets a test read the DAEMON-WRITTEN owner snapshot for this pipe
      admit: (stateDir, ID, laneId = 'opencode-control-lane') => admitSession({
        identityHash: ID,
        sessionPath: path.join(stateDir, 'sessions', `${ID}.json`),
        laneId,
        owner: ownIncarnation(),
        pipePath: pipe,
      }),
    });
  } finally {
    if (prevLane === undefined) delete process.env.SOC_CONTROL_LANE;
    else process.env.SOC_CONTROL_LANE = prevLane;
    if (prevAuthPipe === undefined) delete process.env.SOC_SESSION_AUTHORITY_PIPE_PATH;
    else process.env.SOC_SESSION_AUTHORITY_PIPE_PATH = prevAuthPipe;
    setSessionAdmissionMode('off');
    __resetAdmissionForTests();
    try { await authority.stop(); } catch { /* teardown best effort */ }
  }
}

test('P1R. legacy THREW: an admission-fence-gated record is written and idempotent, but NEVER self-authorizes a retry (needs an authority receipt)', async () => {
  await withSessionAuthority(async ({ admit }) => {
    // (a) writer gated by a LIVE admission fence + evidence: the record is
    // created once (fence markers persisted, fence token never persisted) and
    // a repeat write is idempotent; but the READER must still withhold
    // authorization — the Session Authority exposes no operation/receipt
    // confirmation, and identity/lane/generation/daemonEpoch are copyable
    // markers from the world-readable owner snapshot — so recovery reports
    // RECORD_OPERATION_UNCONFIRMED and requires an Operator-authorized
    // recovery decision: zero transition, zero submit.
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    seedMutationOwner(stateDir, ID);
    await admit(stateDir, ID); // fence BEFORE any armed ledger append
    // REC-01 r4: the CANONICAL production failure evidence (typed FAIL tail
    // carrying the transport attempt id) instead of the legacy bare-string
    // THREW shape - the checkpoint below derives its attempt linkage from it.
    preReviewAttemptLedger(sessionPath, stateDir, ID);
    const tail = readTransitions({ stateDir, identityHash: ID }).at(-1);
    const evPath = writeEvidenceFile(stateDir);

    const rec = recordPreSubmitBoundaryReconciled({
      stateDir,
      identityHash: ID,
      checkpoint: checkpointFromTail(tail),
      source: 'control-plane-admitted-reconciliation',
      basis: 'unit fixture: pre-submit boundary reconciled against the captured transport log',
      evidence: { path: evPath },
      observation: validBoundaryObservation(),
    });
    assert.equal(rec.ok, true, JSON.stringify(rec));
    assert.equal(rec.created, true);
    assert.ok(String(rec.path).endsWith('.json'));
    const parsed = JSON.parse(fs.readFileSync(rec.path, 'utf8'));
    assert.equal(parsed.authority.kind, 'ADMISSION_FENCE');
    assert.equal(parsed.authority.token, undefined, 'the fence token is NEVER persisted');
    assert.ok(typeof parsed.authority.daemonEpoch === 'string' && parsed.authority.daemonEpoch, 'daemon epoch recorded');
    assert.ok(Number.isInteger(parsed.authority.generation), 'grant generation recorded');
    assert.equal(parsed.checkpoint.attemptId, 'fixture-attempt-1', 'the record persists the canonical attempt linkage (r4)');

    const again = recordPreSubmitBoundaryReconciled({
      stateDir, identityHash: ID,
      checkpoint: checkpointFromTail(tail),
      source: 'other', basis: 'other', evidence: { path: evPath },
    });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.created, false, 'the canonical base record wins; never laundered into a sibling');
    assert.equal(JSON.parse(fs.readFileSync(rec.path, 'utf8')).basis, parsed.basis, 'the existing record is byte-untouched');

    const before = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
    const calls = [];
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls) });
    assert.equal(res && res.ok, false, JSON.stringify(res));
    assert.equal(res.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED');
    assert.equal(res.detail.reconcile.reason, 'RECORD_OPERATION_UNCONFIRMED',
      'markers + evidence hash all pass, yet no authority receipt confirms the write -> evidence only');
    assert.equal(res.detail.reconcile.detail && res.detail.reconcile.detail.reason, 'RECEIPT_STORE_MISSING',
      'the RECEIPT seam exists; this record was never confirmed by a live-fence holder (no receipt store for the pipe)');
    assert.match(res.detail.reason, /Operator-authorized recovery decision/, 'the block names the Operator as the only recovery authority');
    assert.deepEqual(calls, [], 'zero transition/submit: no adapter runs');
    assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), before, 'ledger untouched');

    // (b) record bound to a DIFFERENT checkpoint -> content-addressed key misses -> block
    const sd2 = mkStateDir();
    const s2 = mkSession(sd2);
    seedMutationOwner(sd2, s2.id);
    await admit(sd2, s2.id);
    preReviewAttemptLedger(s2.sessionPath, sd2, s2.id, { attemptId: 'att-first-attempt' });
    const tailOld = readTransitions({ stateDir: sd2, identityHash: s2.id }).at(-1);
    // a NEWER canonical failure of the same identity/code (r4): the gate reads
    // the newest tail, so a record written for the OLDER canonical checkpoint
    // (still fully linked) must never unlock it.
    appendTransition({
      stateDir: sd2, identityHash: s2.id, sessionPath: s2.sessionPath,
      record: {
        schemaVersion: CONTROL_LOOP_SCHEMA_VERSION, ts: new Date(Date.now() + 1500).toISOString(),
        from: 'PRE_REVIEWING', to: 'BLOCKED', reason: 'preReview:FAIL',
        evidence: {
          ok: false, code: 'CDP_SEND_TIMEOUT',
          detail: { attemptId: 'att-second-attempt' }, // r5: compatible canonical (newer failure asserts no submit state)
        },
        identityHash: s2.id, sessionPath: s2.sessionPath,
      },
    });
    const ev2 = writeEvidenceFile(sd2, `boundary fixture log v1\n${stageObservationLine({ identityHash: s2.id, attemptId: 'att-first-attempt' })}\n`);
    const rec2 = recordPreSubmitBoundaryReconciled({
      stateDir: sd2, identityHash: s2.id,
      checkpoint: checkpointFromTail(tailOld),
      source: 'test', basis: 'wrong checkpoint fixture', evidence: { path: ev2 },
      observation: validBoundaryObservation(),
    });
    assert.equal(rec2.ok, true, JSON.stringify(rec2));
    const calls2 = [];
    const res2 = await runControlLoop({ sessionPath: s2.sessionPath, identityHash: s2.id, stateDir: sd2, deps: preReviewRetryDeps(calls2) });
    assert.equal(res2 && res2.ok, false, JSON.stringify(res2));
    assert.equal(res2.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED');
    assert.equal(res2.detail.reconcile.reason, 'RECORD_ABSENT', 'a record for another checkpoint does not unlock this one');
    assert.deepEqual(calls2, []);

    // (c) tampered identity field inside the valid file -> structural mismatch -> block
    const sd3 = mkStateDir();
    const s3 = mkSession(sd3);
    seedMutationOwner(sd3, s3.id);
    await admit(sd3, s3.id);
    preReviewAttemptLedger(s3.sessionPath, sd3, s3.id);
    const tail3 = readTransitions({ stateDir: sd3, identityHash: s3.id }).at(-1);
    const ev3 = writeEvidenceFile(sd3);
    const rec3 = recordPreSubmitBoundaryReconciled({
      stateDir: sd3, identityHash: s3.id,
      checkpoint: checkpointFromTail(tail3),
      source: 'test', basis: 'fixture', evidence: { path: ev3 },
      observation: validBoundaryObservation(),
    });
    assert.equal(rec3.ok, true, JSON.stringify(rec3));
    const tampered = JSON.parse(fs.readFileSync(rec3.path, 'utf8'));
    tampered.identityHash = 'e'.repeat(32);
    fs.writeFileSync(rec3.path, JSON.stringify(tampered), 'utf8');
    const calls3 = [];
    const res3 = await runControlLoop({ sessionPath: s3.sessionPath, identityHash: s3.id, stateDir: sd3, deps: preReviewRetryDeps(calls3) });
    assert.equal(res3 && res3.ok, false, JSON.stringify(res3));
    assert.equal(res3.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED');
    assert.equal(res3.detail.reconcile.reason, 'RECORD_IDENTITY_MISMATCH', 'identity field binding is enforced');
    assert.deepEqual(calls3, []);
  });
});

test('P1R2. a CORRECT SOC_CONTROL_LANE env NEVER self-authorizes; a legacy self-claimed record still blocks', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  seedMutationOwner(stateDir, ID);
  preReviewTimeoutLedger(sessionPath, stateDir, ID); // disarmed here -> ledger appends ungated
  const tail = readTransitions({ stateDir, identityHash: ID }).at(-1);
  const evPath = writeEvidenceFile(stateDir);
  const args = {
    stateDir, identityHash: ID,
    checkpoint: { ts: String(tail.ts), reason: String(tail.reason), evidence: String(tail.evidence) },
    source: 'offline script', basis: 'self-claimed', evidence: { path: evPath },
  };

  // (a) correct env lane but the admission contract is DISARMED -> refused
  // (the contract demands authenticated authority; Operator/control-plane
  // must arm the Session Admission Authority - env config alone is nothing)
  const prevLane = process.env.SOC_CONTROL_LANE;
  process.env.SOC_CONTROL_LANE = 'opencode-control-lane';
  let refused;
  try {
    refused = recordPreSubmitBoundaryReconciled(args);
  } finally {
    if (prevLane === undefined) delete process.env.SOC_CONTROL_LANE;
    else process.env.SOC_CONTROL_LANE = prevLane;
  }
  assert.equal(refused && refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.reason, 'ADMISSION_NOT_ARMED', 'correct env + disarmed authority is still NOT authority');

  // (b) correct env + ARMED authority but NO fence held by this process -> refused
  await withSessionAuthority(async () => {
    const refused2 = recordPreSubmitBoundaryReconciled(args);
    assert.equal(refused2 && refused2.ok, false, JSON.stringify(refused2));
    assert.equal(refused2.reason, 'ADMISSION_FENCE_MISSING', 'armed authority without a live admitted fence refuses the writer');
  }, { admit: false });

  // (c) a legacy self-claimed record (source/basis only, no fence grant) -> gate stays blocked
  writeLegacySelfClaimedRecord(stateDir, ID, tail);
  const before = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
  const calls = [];
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls) });
  assert.equal(res && res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED');
  assert.equal(res.detail.reconcile.reason, 'RECORD_AUTHORITY_UNPROVEN', 'self-claimed source/basis cannot authorize a retry');
  assert.deepEqual(calls, [], 'zero transition/submit');
  assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), before, 'ledger untouched');
});

test('P1R3. missing or hash-drifted evidence never authorizes (RECORD_BASIS_UNVERIFIED)', async () => {
  await withSessionAuthority(async ({ admit }) => {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    seedMutationOwner(stateDir, ID);
    await admit(stateDir, ID);
    preReviewAttemptLedger(sessionPath, stateDir, ID); // r4: canonical attempt linkage
    const tail = readTransitions({ stateDir, identityHash: ID }).at(-1);
    const evPath = writeEvidenceFile(stateDir, `original boundary log content\n${stageObservationLine(fixtureMarkerBinding(stateDir))}\n`);
    const rec = recordPreSubmitBoundaryReconciled({
      stateDir, identityHash: ID,
      checkpoint: checkpointFromTail(tail),
      source: 'test', basis: 'fixture', evidence: { path: evPath },
      observation: validBoundaryObservation(),
    });
    assert.equal(rec.ok, true, JSON.stringify(rec));

    const before = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));

    // (a) evidence file missing
    fs.unlinkSync(evPath);
    let calls = [];
    let res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls) });
    assert.equal(res && res.ok, false, JSON.stringify(res));
    assert.equal(res.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED');
    assert.equal(res.detail.reconcile.reason, 'RECORD_BASIS_UNVERIFIED');
    assert.equal(res.detail.reconcile.detail.reason, 'EVIDENCE_FILE_MISSING');
    assert.deepEqual(calls, [], 'no retry while evidence is missing');
    assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), before, 'ledger untouched');

    // (b) evidence file present but content drifts -> sha mismatch
    fs.writeFileSync(evPath, 'TAMPERED content after reconciliation', 'utf8');
    calls = [];
    res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls) });
    assert.equal(res && res.ok, false, JSON.stringify(res));
    assert.equal(res.detail.reconcile.reason, 'RECORD_BASIS_UNVERIFIED');
    assert.equal(res.detail.reconcile.detail.reason, 'EVIDENCE_HASH_MISMATCH');
    assert.ok(/^[0-9a-f]{64}$/.test(res.detail.reconcile.detail.actual), 'actual sha reported');
    assert.deepEqual(calls, [], 'no retry on hash drift');
    assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), before, 'ledger untouched');
  });
});

test('P1R4. an admitted fence whose LANE differs from the canonical mutationOwner is refused (config consistency, not env)', async () => {
  await withSessionAuthority(async ({ admit }) => {
    const stateDir = mkStateDir();
    const { id: ID } = mkSession(stateDir);
    seedMutationOwner(stateDir, ID); // canonical lane: opencode-control-lane
    await admit(stateDir, ID, 'other-lane'); // daemon records lane other-lane
    const evPath = writeEvidenceFile(stateDir);
    const r = recordPreSubmitBoundaryReconciled({
      stateDir, identityHash: ID,
      checkpoint: { ts: '2026-10-03T04:04:52.028Z', reason: 'preReview:THREW', evidence: 'CDP_SEND_TIMEOUT' },
      source: 'test', basis: 'fixture', evidence: { path: evPath },
    });
    assert.equal(r && r.ok, false, JSON.stringify(r));
    assert.equal(r.reason, 'MUTATION_LANE_MISMATCH');
    assert.equal(r.detail.fenceLane, 'other-lane');
    assert.equal(r.detail.ownerLane, 'opencode-control-lane');
  });
});

test('P1R5. a grant that does not match the DAEMON owner snapshot never authorizes (fabricated generation)', async () => {
  await withSessionAuthority(async ({ admit }) => {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    seedMutationOwner(stateDir, ID);
    await admit(stateDir, ID);
    preReviewAttemptLedger(sessionPath, stateDir, ID); // r4: canonical attempt linkage
    const tail = readTransitions({ stateDir, identityHash: ID }).at(-1);
    const evPath = writeEvidenceFile(stateDir);
    const rec = recordPreSubmitBoundaryReconciled({
      stateDir, identityHash: ID,
      checkpoint: checkpointFromTail(tail),
      source: 'test', basis: 'fixture', evidence: { path: evPath },
      observation: validBoundaryObservation(),
    });
    assert.equal(rec.ok, true, JSON.stringify(rec));
    const parsed = JSON.parse(fs.readFileSync(rec.path, 'utf8'));
    parsed.authority.generation = Number(parsed.authority.generation) + 1; // fabricate
    fs.writeFileSync(rec.path, JSON.stringify(parsed), 'utf8');

    const before = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
    const calls = [];
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls) });
    assert.equal(res && res.ok, false, JSON.stringify(res));
    assert.equal(res.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED');
    assert.equal(res.detail.reconcile.reason, 'RECORD_AUTHORITY_UNPROVEN');
    assert.equal(res.detail.reconcile.detail.reason, 'OWNER_SNAPSHOT_MISMATCH', 'cross-checked against the daemon-written durable owner snapshot');
    assert.deepEqual(calls, [], 'zero mutation');
    assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), before, 'ledger untouched');
  });
});

test('P1b. typed preReview:FAIL CDP_SEND_TIMEOUT proven PRE_SUBMIT also recovers (structured boundary)', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  preReviewTimeoutLedger(sessionPath, stateDir, ID, {
    reason: 'preReview:FAIL',
    evidence: { ok: false, code: 'CDP_SEND_TIMEOUT', detail: { method: 'Runtime.evaluate', stage: 'PRE_SUBMIT_SNAPSHOT', phase: 'PRE_SUBMIT', cdpTimeoutMs: 30000, submitEvidence: { submitted: false, reason: 'pre-submit' } } },
  });
  const calls = [];
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls) });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(calls, ['preReview', 'finalReview']);
});

test('P2. submit side effect present, or boundary UNPROVEN -> typed block, no resend, zero mutation', async () => {
  // (a) typed FAIL whose boundary is NOT proven pre-submit -> block
  {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    preReviewTimeoutLedger(sessionPath, stateDir, ID, {
      reason: 'preReview:FAIL',
      evidence: { ok: false, code: 'CDP_SEND_TIMEOUT', detail: { phase: 'SUBMIT', submitEvidence: { submitted: 'UNKNOWN' } } },
    });
    const before = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
    const calls = [];
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls) });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED');
    assert.deepEqual(calls, [], 'no preReview resend when the submit outcome is unknown');
    assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), before, 'ledger untouched');
  }
  // (b) THREW checkpoint BUT durable submit artifacts exist -> reconcile first
  {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    preReviewTimeoutLedger(sessionPath, stateDir, ID);
    writeSubmitArtifact(stateDir, ID);
    const before = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
    const calls = [];
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls) });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED');
    assert.ok(res.detail && res.detail.detail && res.detail.detail.present === true, 'the artifacts are named in the typed block');
    assert.ok(Array.isArray(res.detail.detail.files) && res.detail.detail.files.includes('x.submit.json'), 'artifact file listed');
    assert.deepEqual(calls, [], 'no resend while a submit side effect exists');
    assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), before, 'ledger untouched');
  }
});

test('P3. classified THREW needs the reconcile record; non-classified THREW stays fail-closed at route (zero mutation, no spawn)', async () => {
  // Classified CDP/WS codes are gated by the submit boundary (no record ->
  // typed-block PRE_REVIEW_SUBMIT_UNRECONCILED, still zero mutation); any
  // other evidence is NOT classified and keeps the old fail-closed route stop.
  for (const [evidence, expectCode, expectReconcile] of [
    ['CDP_SEND_TIMEOUT', 'PRE_REVIEW_SUBMIT_UNRECONCILED', 'RECORD_ABSENT'],
    ['CDP_WS_ERROR', 'PRE_REVIEW_SUBMIT_UNRECONCILED', 'RECORD_ABSENT'],
    ['CDP_WS_OPEN_TIMEOUT', 'PRE_REVIEW_SUBMIT_UNRECONCILED', 'RECORD_ABSENT'],
    ['GEMINI_TRANSPORT_EXCEPTION', 'ROUTE_FAILED', null],
    ['something else', 'ROUTE_FAILED', null],
  ]) {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    preReviewTimeoutLedger(sessionPath, stateDir, ID, { evidence });
    const before = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
    const calls = [];
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls) });
    assert.equal(res.ok, false, `${evidence}: ${JSON.stringify(res)}`);
    assert.equal(res.code, expectCode, evidence);
    if (expectReconcile) {
      assert.equal(res.detail.reconcile.reason, expectReconcile, evidence);
      assert.match(res.detail.reason, /Operator-authorized recovery decision/, evidence);
    }
    assert.deepEqual(calls, [], `${evidence}: no adapter runs`);
    assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), before, `${evidence}: ledger untouched`);
  }
});

test('P4. relaunch after a successful recovery cannot create a second review attempt or executor', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  // recovery through the TYPED pre-submit boundary (the shape that needs no
  // reconcile record: the transport's own structured evidence)
  preReviewTimeoutLedger(sessionPath, stateDir, ID, {
    reason: 'preReview:FAIL',
    evidence: { ok: false, code: 'CDP_SEND_TIMEOUT', detail: { method: 'Runtime.evaluate', stage: 'PRE_SUBMIT_SNAPSHOT', phase: 'PRE_SUBMIT', cdpTimeoutMs: 30000, submitEvidence: { submitted: false, reason: 'pre-submit' } } },
  });
  const calls1 = [];
  const r1 = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls1) });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(calls1.filter((c) => c === 'preReview').length, 1);
  const ledgerAfterFirst = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
  const calls2 = [];
  const r2 = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls2) });
  assert.equal(r2.ok, false, JSON.stringify(r2));
  assert.deepEqual(calls2, [], 'the relaunch runs NO adapter: no second review attempt, no executor');
  assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), ledgerAfterFirst, 'ledger unchanged by the relaunch');
});

// ---------------------------------------------------------------------------
// F2 (REWORK PR #268 final review): a CLASSIFIED CDP/WS failure
// (CDP_SEND_TIMEOUT / CDP_WS_ERROR / CDP_WS_OPEN_TIMEOUT — the exact
// EXPECTED_CDP_ERROR_RE set the raw transport types) whose submit state is not
// proven pre-submit must be blocked BEFORE the generic Issue #148
// preReview:FAIL resume branch. The observed duplicate-submit path: a WS
// error at SUBMIT_IN_FLIGHT with submitted:'UNKNOWN' typed as preReview:FAIL
// fell through to the shared retry and re-sent the request. Contract: zero
// adapter calls, zero ledger writes, zero submit artifacts; the boundary (not
// the code's name) decides, so a proven-PRE_SUBMIT typed failure still
// recovers exactly once.
// ---------------------------------------------------------------------------
test('F2. classified transport failure with an UNPROVEN submit state never resends (zero submit, zero transition)', async () => {
  for (const [code, detail] of [
    // the observed #9000031 duplicate-submit shape: WS error mid-submit
    ['CDP_WS_ERROR', { method: 'Page.addScriptToEvaluateOnNewDocument', stage: 'SUBMIT_IN_FLIGHT', phase: 'SUBMIT', cdpTimeoutMs: 30000, submitEvidence: { submitted: 'UNKNOWN' } }],
    ['CDP_WS_OPEN_TIMEOUT', { method: 'Runtime.evaluate', stage: 'SUBMIT_IN_FLIGHT', phase: 'SUBMIT', cdpTimeoutMs: 30000, submitEvidence: { submitted: 'UNKNOWN' } }],
    ['CDP_SEND_TIMEOUT', { method: 'Runtime.evaluate', stage: 'SUBMIT_IN_FLIGHT', phase: 'SUBMIT', cdpTimeoutMs: 30000, submitEvidence: { submitted: 'UNKNOWN' } }],
    // structured detail missing entirely -> boundary unproven
    ['CDP_WS_ERROR', null],
    // post-submit evidence -> never pre-submit proof
    ['CDP_WS_ERROR', { method: 'Runtime.evaluate', stage: 'POST_SUBMIT', phase: 'POST_SUBMIT', submitEvidence: { submitted: true, reason: 'sent' } }],
  ]) {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    preReviewTimeoutLedger(sessionPath, stateDir, ID, {
      reason: 'preReview:FAIL',
      evidence: { ok: false, code, detail },
    });
    const before = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
    const calls = [];
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls) });
    assert.equal(res && res.ok, false, `${code}: ${JSON.stringify(res)}`);
    assert.equal(res.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED', `${code} detail=${JSON.stringify(detail)}`);
    assert.ok(/no automatic resend/.test(String(res.detail && res.detail.reason)), `${code}: block names no-resend`);
    assert.equal(res.detail.supportedCode, code, `${code}: the classified code is surfaced`);
    assert.deepEqual(calls, [], `${code}: no adapter runs - the resend is refused`);
    assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), before, `${code}: ledger untouched`);
    assert.equal(readReviewStoreCount(stateDir, ID), 0, `${code}: no submit artifact was created`);
  }

  // (artifacts dominate) even a PROVEN pre-submit typed detail cannot resend
  // while a durable submit side effect exists for the identity.
  {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    preReviewTimeoutLedger(sessionPath, stateDir, ID, {
      reason: 'preReview:FAIL',
      evidence: { ok: false, code: 'CDP_WS_ERROR', detail: { method: 'Runtime.evaluate', stage: 'PRE_SUBMIT_SNAPSHOT', phase: 'PRE_SUBMIT', submitEvidence: { submitted: false, reason: 'pre-submit' } } },
    });
    writeSubmitArtifact(stateDir, ID);
    const before = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
    const calls = [];
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls) });
    assert.equal(res && res.ok, false, JSON.stringify(res));
    assert.equal(res.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED');
    assert.ok(res.detail && res.detail.detail && res.detail.detail.present === true, 'artifacts named in the typed block');
    assert.deepEqual(calls, [], 'no resend while a submit side effect exists');
    assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), before, 'ledger untouched');
  }

  // positive control: the SAME classified code with a proven PRE_SUBMIT
  // boundary still recovers exactly once (the boundary decides, not the code).
  {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    preReviewTimeoutLedger(sessionPath, stateDir, ID, {
      reason: 'preReview:FAIL',
      evidence: { ok: false, code: 'CDP_WS_ERROR', detail: { method: 'Runtime.evaluate', stage: 'PRE_SUBMIT_SNAPSHOT', phase: 'PRE_SUBMIT', cdpTimeoutMs: 30000, submitEvidence: { submitted: false, reason: 'pre-submit' } } },
    });
    const calls = [];
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls) });
    assert.equal(res && res.ok, true, JSON.stringify(res));
    assert.deepEqual(calls, ['preReview', 'finalReview'], 'exactly one preReview re-entry on a proven boundary');
  }
});

// ---------------------------------------------------------------------------
// F3 (REWORK PR #268 final review): WRITER AUTHORITY — identity/lane/
// generation/daemonEpoch are copyable markers of the world-readable
// DAEMON-WRITTEN owner snapshot, so a marker-PERFECT self-created record stays
// EVIDENCE ONLY. REC-01 adds the operation/receipt seam (Session Authority
// RECEIPT op, minted only under a live fence); a record nobody sealed still
// has NO receipt, so the recovery blocks with RECORD_OPERATION_UNCONFIRMED /
// RECEIPT_ABSENT and names the Operator as the only recovery authority — no
// automatic resend, zero mutation.
// ---------------------------------------------------------------------------
test('F3. a marker-perfect self-created record never authorizes a retry (no authority receipt)', async () => {
  await withSessionAuthority(async ({ admit, pipePath }) => {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    seedMutationOwner(stateDir, ID);
    await admit(stateDir, ID); // fence live -> the DAEMON persists the owner snapshot
    preReviewAttemptLedger(sessionPath, stateDir, ID); // r4: canonical attempt linkage
    const tail = readTransitions({ stateDir, identityHash: ID }).at(-1);
    const cp = checkpointFromTail(tail);
    const evPath = writeEvidenceFile(stateDir);

    // Read the daemon-written durable owner snapshot for this pipe (it is a
    // plain file on disk — the weakness F3 names).
    const snapFile = path.join(path.dirname(authorityBindLockPath()), `owners-${createHash('sha256').update(pipePath).digest('hex')}.json`);
    const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
    const entry = (snap.entries || []).find((e) => e && e.identityHash === ID);
    assert.ok(entry, `daemon owner snapshot carries the admitted entry: ${snapFile}`);

    // SELF-CREATE the record with a plain fs write (NO fence, NO writer
    // authority at all), copying every authority marker from the snapshot.
    const dir = path.join(stateDir, 'control-loop', ID, 'pre-submit-boundary');
    fs.mkdirSync(dir, { recursive: true });
    const forgedPath = path.join(dir, `${boundaryKeyOf(cp)}.json`);
    fs.writeFileSync(forgedPath, JSON.stringify({
      schemaVersion: '1',
      kind: 'PRE_SUBMIT_BOUNDARY_RECONCILED',
      identityHash: ID,
      checkpoint: { ...cp },
      source: 'self-authored script',
      basis: 'lane/generation/epoch copied from the world-readable owner snapshot',
      authority: {
        kind: 'ADMISSION_FENCE',
        lane: entry.laneId,
        daemonEpoch: String(entry.daemonEpoch || 'copied-epoch'),
        generation: Number(entry.generation),
        connectionId: 999,
        pipePath,
        acquiredAt: new Date().toISOString(),
      },
      // REWORK F2: the marker-perfect fixture now also carries a perfectly
      // shaped PRE_SUBMIT observation/decision — so the check that stops it
      // remains the RECEIPT (issuance), never the boundary block shape.
      boundary: {
        observation: { phase: 'PRE_SUBMIT', submitState: 'NOT_SUBMITTED', observedAt: new Date().toISOString(), source: 'copied-marker-script' },
        decision: { action: 'PRE_SUBMIT_BOUNDARY_RECONCILED', decidedAt: new Date().toISOString() },
      },
      evidence: { path: evPath, sha256: createHash('sha256').update(fs.readFileSync(evPath)).digest('hex') },
      reconciledAt: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8');

    const before = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
    const calls = [];
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls) });
    assert.equal(res && res.ok, false, JSON.stringify(res));
    assert.equal(res.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED');
    // It is NOT authority-mismatched: every structural, identity, snapshot and
    // evidence-hash check passes — and it STILL cannot authorize, proving the
    // check that stops it is the operation confirmation, not a marker typo.
    assert.equal(res.detail.reconcile.reason, 'RECORD_OPERATION_UNCONFIRMED',
      'marker-perfect self-created record: evidence only, never authority');
    assert.equal(res.detail.reconcile.detail && res.detail.reconcile.detail.reason, 'RECEIPT_STORE_MISSING',
      'every marker check passes - what stops it is the missing authority receipt (no receipt store for the pipe)');
    assert.match(res.detail.reason, /Operator-authorized recovery decision/);
    assert.match(String(res.detail.reconcile.detail.detail && res.detail.reconcile.detail.detail.ops), /RECEIPT/, 'the RECEIPT seam exists; the record simply has no receipt');
    assert.deepEqual(calls, [], 'zero transition/submit');
    assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), before, 'ledger untouched');
  });
});

// ---------------------------------------------------------------------------
// REC-01 (native Windows proof: REAL Named Pipe daemon, real admission fence):
// authorized reconciliation -> writer RELEASE -> runner RE-ACQUIRE -> reader
// confirms via the daemon-written RECEIPT -> bounded retry exactly once.
// The receipt is the OPERATION's authority recorded in HISTORY (minted only
// under a live fence: token+epoch+connection verified daemon-side, bound to
// the record's exact bytes); the runner's CURRENT mutation grant is a separate
// thing (fresh fence after re-acquire). Env/lane never participate. The
// append-only ledger keeps the original BLOCKED evidence byte-for-byte and a
// relaunch of the same identity never mints a duplicate owner/worker/request.
// ---------------------------------------------------------------------------
test('REC1 (native). sealed record: writer release -> runner re-acquire -> reader confirms -> bounded retry once', async () => {
  assert.equal(typeof ctrlApi.sealPreSubmitBoundaryReconciled, 'function',
    'REC-01: the control-plane seal seam must exist (sealPreSubmitBoundaryReconciled export)');
  await withSessionAuthority(async ({ admit, pipePath }) => {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    seedMutationOwner(stateDir, ID);
    await admit(stateDir, ID); // fence BEFORE any armed ledger append
    preReviewAttemptLedger(sessionPath, stateDir, ID); // r4: canonical attempt linkage
    const tail = readTransitions({ stateDir, identityHash: ID }).at(-1);
    const checkpoint = checkpointFromTail(tail);
    const evPath = writeEvidenceFile(stateDir);

    const rec = recordPreSubmitBoundaryReconciled({
      stateDir, identityHash: ID, checkpoint,
      source: 'control-plane-admitted-reconciliation',
      basis: 'REC1 lifecycle fixture: transport log proves PRE_SUBMIT',
      evidence: { path: evPath },
      observation: validBoundaryObservation(),
    });
    assert.equal(rec.ok, true, JSON.stringify(rec));
    const recordBytes = fs.readFileSync(rec.path);

    // (1) authorized operation: seal through the LIVE fence -> the DAEMON
    // persists the receipt (the writer never writes authority itself).
    const seal1 = await ctrlApi.sealPreSubmitBoundaryReconciled({ stateDir, identityHash: ID, checkpoint });
    assert.equal(seal1 && seal1.ok, true, JSON.stringify(seal1));
    assert.equal(seal1.sealed, true, 'first seal mints the receipt');
    assert.equal(seal1.recordSha256, createHash('sha256').update(recordBytes).digest('hex'),
      'the receipt binds the record BYTES, not a claim inside the record');

    // idempotent: resealing the same bytes never mints a second history row
    const seal2 = await ctrlApi.sealPreSubmitBoundaryReconciled({ stateDir, identityHash: ID, checkpoint });
    assert.equal(seal2 && seal2.ok, true, JSON.stringify(seal2));
    assert.equal(seal2.sealed, false, 'receipt is idempotent per record bytes');
    assert.deepEqual(fs.readFileSync(rec.path), recordBytes, 'sealing never rewrites the record (byte-identical)');

    const storePath = path.join(path.dirname(authorityBindLockPath()), `receipts-${createHash('sha256').update(pipePath).digest('hex')}.json`);
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal(store.schemaVersion, 1, 'daemon-written receipt store schema');
    const rows = (store.entries || []).filter((e) => e.identityHash === ID && e.recordSha256 === seal1.recordSha256);
    assert.equal(rows.length, 1, 'exactly ONE daemon-written receipt row');
    assert.equal(rows[0].kind, 'PRE_SUBMIT_BOUNDARY_RECONCILED');
    assert.equal(rows[0].checkpointKey, createHash('sha256').update(`${checkpoint.ts}|${checkpoint.reason}|${checkpoint.evidence}`).digest('hex').slice(0, 16));
    assert.ok(Number.isInteger(rows[0].generation) && rows[0].generation >= 1, 'grant generation of the sealing grant recorded');
    assert.equal(typeof rows[0].daemonEpoch, 'string');
    assert.equal(rows[0].token, undefined, 'the fence token is NEVER written to the receipt store');

    // (2) writer RELEASE: the daemon drops the grant; the receipt (history) survives
    const rel = await releaseAdmission({ sessionPath: path.join(stateDir, 'sessions', `${ID}.json`), identityHash: ID });
    assert.equal(rel && rel.ok, true, JSON.stringify(rel));
    const storeAfterRelease = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal((storeAfterRelease.entries || []).length, 1, 'release never rewrites receipt history');

    // (3) runner RE-ACQUIRE: a NEW current mutation grant (independent of history)
    const again = await admit(stateDir, ID);
    assert.equal(again && again.ok, true, JSON.stringify(again));
    assert.ok(again.fence && Number.isInteger(again.fence.generation), 'the runner holds its own current fence');

    // (4) reader confirms: operation-confirmed record (all prior checks + receipt)
    const boundary = await ctrlApi.readPreSubmitBoundaryReconcile({ stateDir, identityHash: ID, checkpoint });
    assert.equal(boundary && boundary.ok, true, JSON.stringify(boundary));
    assert.equal(boundary.receipt && boundary.receipt.recordSha256, seal1.recordSha256, 'the accepted receipt is surfaced as evidence');

    // (5) bounded retry: exactly ONE preReview re-entry, then finalReview
    const ledgerBefore = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
    const calls = [];
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls) });
    assert.equal(res && res.ok, true, JSON.stringify(res));
    assert.deepEqual(calls, ['preReview', 'finalReview'],
      'bounded retry: ONE preReview re-entry; router/executor/verifier never re-run');

    // history append-only: the original BLOCKED evidence survives byte-for-byte
    const after = readTransitions({ stateDir, identityHash: ID });
    assert.ok(after.length > 0);
    assert.equal(JSON.stringify(after.slice(0, JSON.parse(ledgerBefore).length)), ledgerBefore,
      'the pre-retry ledger is byte-identical (append-only history)');
    assert.equal(after.filter((r) => r.from === 'PRE_REVIEWING' && r.to === 'BLOCKED').length, 1,
      'the original failure record stays exactly once');

    // (6) relaunch of the SAME identity: zero adapters (no duplicate
    // owner/worker/request), receipt history unchanged
    const calls2 = [];
    const res2 = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls2) });
    assert.equal(res2 && res2.ok, false, JSON.stringify(res2));
    assert.deepEqual(calls2, [], 'the relaunch runs NO adapter: no second review submit, no new grant');
    const store2 = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal((store2.entries || []).filter((e) => e.identityHash === ID && e.recordSha256 === seal1.recordSha256).length, 1,
      'receipt history is append-only and deduplicated across the whole lifecycle');
  });
});

// ---------------------------------------------------------------------------
// REC-01 refusals: every condition under which the operation is NOT confirmed
// must be a TYPED refusal BEFORE any transition/retry. Sub-cases (a) and the
// generation-rule checks are explicitly OFFLINE/MOCKED (no daemon round trip
// for the refusal itself); (b)-(d) run against the REAL daemon fixture.
// ---------------------------------------------------------------------------
test('REC2. unconfirmed/revoked/disarmed/tampered operations are typed refusals before any transition', async () => {
  assert.equal(typeof ctrlApi.sealPreSubmitBoundaryReconciled, 'function',
    'REC-01: the control-plane seal seam must exist (sealPreSubmitBoundaryReconciled export)');
  // (a) OFFLINE/mocked: a DISARMED authority can never seal - env/lane is
  // configuration, so no configuration string can become authority here.
  {
    setSessionAdmissionMode('off'); // deterministic disarmed baseline
    const r = await ctrlApi.sealPreSubmitBoundaryReconciled({
      stateDir: mkStateDir(), identityHash: 'a'.repeat(32),
      checkpoint: { ts: '2026-10-03T00:00:00.000Z', reason: 'preReview:THREW', evidence: 'CDP_SEND_TIMEOUT' },
    });
    assert.equal(r && r.ok, false, JSON.stringify(r));
    assert.equal(r.code, 'ADMISSION_NOT_ARMED', 'disarmed admission refuses the seal');
  }

  await withSessionAuthority(async ({ admit, pipePath }) => {
    // (b) NATIVE: writer REVOKED (released) -> seal refused; reader then
    // refuses the still-unconfirmed record with zero mutation.
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    seedMutationOwner(stateDir, ID);
    await admit(stateDir, ID);
    preReviewAttemptLedger(sessionPath, stateDir, ID); // r4
    const tail = readTransitions({ stateDir, identityHash: ID }).at(-1);
    const checkpoint = checkpointFromTail(tail);
    const evPath = writeEvidenceFile(stateDir);
    const rec = recordPreSubmitBoundaryReconciled({
      stateDir, identityHash: ID, checkpoint, source: 'test', basis: 'REC2 fixture', evidence: { path: evPath },
      observation: validBoundaryObservation(),
    });
    assert.equal(rec.ok, true, JSON.stringify(rec));
    const rel = await releaseAdmission({ sessionPath: path.join(stateDir, 'sessions', `${ID}.json`), identityHash: ID });
    assert.equal(rel && rel.ok, true, JSON.stringify(rel));
    const sealed = await ctrlApi.sealPreSubmitBoundaryReconciled({ stateDir, identityHash: ID, checkpoint });
    assert.equal(sealed && sealed.ok, false, JSON.stringify(sealed));
    assert.equal(sealed.code, 'ADMISSION_FENCE_MISSING', 'a released/revoked writer can no longer confirm an operation');
    // Re-acquire restores a CURRENT grant (so every copyable marker check above
    // the receipt seam passes again) - and the record STILL gets no receipt:
    // what refused the operation at seal time is permanent history.
    const again = await admit(stateDir, ID);
    assert.equal(again && again.ok, true, JSON.stringify(again));
    const beforeB = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
    const callsB = [];
    const resB = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(callsB) });
    assert.equal(resB && resB.ok, false, JSON.stringify(resB));
    assert.equal(resB.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED');
    assert.equal(resB.detail.reconcile.reason, 'RECORD_OPERATION_UNCONFIRMED');
    assert.equal(resB.detail.reconcile.detail && resB.detail.reconcile.detail.reason, 'RECEIPT_STORE_MISSING',
      'markers restored after re-acquire, but the refused operation left no receipt');
    assert.match(resB.detail.reason, /Operator-authorized recovery decision/);
    assert.deepEqual(callsB, [], 'typed refusal before transition/retry');
    assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), beforeB, 'ledger untouched');

    // (c) NATIVE: sealed record whose BYTES drift -> no receipt matches those
    // bytes (the receipt is bound to exact bytes, not to a filename).
    // Distinct issueNumber per fixture: one identity per daemon entry, so the
    // grants never cross-renew between cases.
    const sd2 = mkStateDir();
    const s2 = mkSession(sd2, { issueNumber: 6202 });
    seedMutationOwner(sd2, s2.id);
    await admit(sd2, s2.id);
    preReviewAttemptLedger(s2.sessionPath, sd2, s2.id); // r4
    const t2 = readTransitions({ stateDir: sd2, identityHash: s2.id }).at(-1);
    const cp2 = checkpointFromTail(t2);
    const ev2 = writeEvidenceFile(sd2);
    const rec2 = recordPreSubmitBoundaryReconciled({ stateDir: sd2, identityHash: s2.id, checkpoint: cp2, source: 'test', basis: 'REC2', evidence: { path: ev2 }, observation: validBoundaryObservation() });
    assert.equal(rec2.ok, true, JSON.stringify(rec2));
    const seal2 = await ctrlApi.sealPreSubmitBoundaryReconciled({ stateDir: sd2, identityHash: s2.id, checkpoint: cp2 });
    assert.equal(seal2 && seal2.ok, true, JSON.stringify(seal2));
    fs.appendFileSync(rec2.path, '\n'); // byte drift AFTER confirmation
    const rd2 = await ctrlApi.readPreSubmitBoundaryReconcile({ stateDir: sd2, identityHash: s2.id, checkpoint: cp2 });
    assert.equal(rd2 && rd2.ok, false, JSON.stringify(rd2));
    assert.equal(rd2.reason, 'RECORD_OPERATION_UNCONFIRMED');
    assert.equal(rd2.detail && rd2.detail.reason, 'RECEIPT_ABSENT', 'changed bytes have no receipt');

    // (d) NATIVE: the authority is DISARMED at READ time -> even a
    // previously-sealed record is refused (confirmation requires the armed
    // contract on both ends of the lifecycle).
    const sd3 = mkStateDir();
    const s3 = mkSession(sd3, { issueNumber: 6203 });
    seedMutationOwner(sd3, s3.id);
    await admit(sd3, s3.id);
    preReviewAttemptLedger(s3.sessionPath, sd3, s3.id); // r4
    const t3 = readTransitions({ stateDir: sd3, identityHash: s3.id }).at(-1);
    const cp3 = checkpointFromTail(t3);
    const ev3 = writeEvidenceFile(sd3);
    const rec3 = recordPreSubmitBoundaryReconciled({ stateDir: sd3, identityHash: s3.id, checkpoint: cp3, source: 'test', basis: 'REC2', evidence: { path: ev3 }, observation: validBoundaryObservation() });
    assert.equal(rec3.ok, true, JSON.stringify(rec3));
    const seal3 = await ctrlApi.sealPreSubmitBoundaryReconciled({ stateDir: sd3, identityHash: s3.id, checkpoint: cp3 });
    assert.equal(seal3 && seal3.ok, true, JSON.stringify(seal3));
    setSessionAdmissionMode('off'); // Operator disarms after the fact
    const rdDisarmed = await ctrlApi.readPreSubmitBoundaryReconcile({ stateDir: sd3, identityHash: s3.id, checkpoint: cp3 });
    assert.equal(rdDisarmed && rdDisarmed.ok, false, JSON.stringify(rdDisarmed));
    assert.equal(rdDisarmed.reason, 'RECORD_OPERATION_UNCONFIRMED');
    assert.equal(rdDisarmed.detail && rdDisarmed.detail.reason, 'AUTHORITY_DISARMED',
      'disarmed authority: typed refusal, no confirmation, no retry');
    setSessionAdmissionMode('required');

    // (e) MOCKED receipt rows (validation rules, not the trust model): a
    // forged row claiming an IMPOSSIBLE generation (> the daemon snapshot),
    // a wrong identity, or a wrong checkpoint key are all refused typed.
    const sd4 = mkStateDir();
    const s4 = mkSession(sd4, { issueNumber: 6204 });
    seedMutationOwner(sd4, s4.id);
    await admit(sd4, s4.id);
    preReviewAttemptLedger(s4.sessionPath, sd4, s4.id); // r4
    const t4 = readTransitions({ stateDir: sd4, identityHash: s4.id }).at(-1);
    const cp4 = checkpointFromTail(t4);
    const ev4 = writeEvidenceFile(sd4);
    const rec4 = recordPreSubmitBoundaryReconciled({ stateDir: sd4, identityHash: s4.id, checkpoint: cp4, source: 'test', basis: 'REC2', evidence: { path: ev4 }, observation: validBoundaryObservation() });
    assert.equal(rec4.ok, true, JSON.stringify(rec4));
    const sha4 = createHash('sha256').update(fs.readFileSync(rec4.path)).digest('hex');
    const key4 = createHash('sha256').update(`${cp4.ts}|${cp4.reason}|${cp4.evidence}`).digest('hex').slice(0, 16);
    const store4 = path.join(path.dirname(authorityBindLockPath()), `receipts-${createHash('sha256').update(pipePath).digest('hex')}.json`);
    const writeFakeRows = (mutate) => {
      const row = {
        seq: 1, at: new Date().toISOString(), daemonEpoch: 'forged-epoch',
        identityHash: s4.id, sessionPath: path.join(sd4, 'sessions', `${s4.id}.json`),
        generation: 1, connectionId: 1, kind: 'PRE_SUBMIT_BOUNDARY_RECONCILED',
        recordSha256: sha4, checkpointKey: key4, pipePath,
      };
      mutate(row);
      fs.mkdirSync(path.dirname(store4), { recursive: true });
      fs.writeFileSync(store4, `${JSON.stringify({ schemaVersion: 1, pipePath, entries: [row] }, null, 2)}\n`, 'utf8');
    };
    const expectRefusal = async (label, reason) => {
      const rd = await ctrlApi.readPreSubmitBoundaryReconcile({ stateDir: sd4, identityHash: s4.id, checkpoint: cp4 });
      assert.equal(rd && rd.ok, false, `${label}: ${JSON.stringify(rd)}`);
      assert.equal(rd.reason, 'RECORD_OPERATION_UNCONFIRMED', label);
      assert.equal(rd.detail && rd.detail.reason, reason, label);
    };
    writeFakeRows((r) => { r.generation = 99; });
    await expectRefusal('forged future generation', 'RECEIPT_GENERATION_INVALID');
    writeFakeRows((r) => { r.identityHash = 'e'.repeat(32); });
    await expectRefusal('forged identity', 'RECEIPT_IDENTITY_MISMATCH');
    writeFakeRows((r) => { r.checkpointKey = '0'.repeat(16); });
    await expectRefusal('forged checkpoint binding', 'RECEIPT_CHECKPOINT_MISMATCH');
    fs.rmSync(store4, { force: true });
    await expectRefusal('store missing', 'RECEIPT_STORE_MISSING');

    // (f) MOCKED takeover bump: the HISTORICAL record generation need not
    // equal the runner's CURRENT snapshot generation (release->reacquire or a
    // takeover bump); equality is never forced, and only a record claiming a
    // NEWER generation than the snapshot is impossible (P1R5).
    const sd5 = mkStateDir();
    const s5 = mkSession(sd5, { issueNumber: 6205 });
    seedMutationOwner(sd5, s5.id);
    await admit(sd5, s5.id);
    preReviewAttemptLedger(s5.sessionPath, sd5, s5.id); // r4
    const t5 = readTransitions({ stateDir: sd5, identityHash: s5.id }).at(-1);
    const cp5 = checkpointFromTail(t5);
    const ev5 = writeEvidenceFile(sd5);
    const rec5 = recordPreSubmitBoundaryReconciled({ stateDir: sd5, identityHash: s5.id, checkpoint: cp5, source: 'test', basis: 'REC2', evidence: { path: ev5 }, observation: validBoundaryObservation() });
    assert.equal(rec5.ok, true, JSON.stringify(rec5));
    const seal5 = await ctrlApi.sealPreSubmitBoundaryReconciled({ stateDir: sd5, identityHash: s5.id, checkpoint: cp5 });
    assert.equal(seal5 && seal5.ok, true, JSON.stringify(seal5));
    // simulate the runner having taken over at a NEWER generation afterwards
    const snapFile5 = path.join(path.dirname(authorityBindLockPath()), `owners-${createHash('sha256').update(pipePath).digest('hex')}.json`);
    const snap5 = JSON.parse(fs.readFileSync(snapFile5, 'utf8'));
    const entry5 = (snap5.entries || []).find((e) => e && e.identityHash === s5.id);
    assert.ok(entry5, 'daemon owner snapshot entry present');
    assert.equal(Number(entry5.generation), 1, 'receipt was minted at generation 1');
    entry5.generation = 2; // MOCKED takeover bump (reader-rule check only)
    fs.writeFileSync(snapFile5, `${JSON.stringify(snap5, null, 2)}\n`, 'utf8');
    const rd5 = await ctrlApi.readPreSubmitBoundaryReconcile({ stateDir: sd5, identityHash: s5.id, checkpoint: cp5 });
    assert.equal(rd5 && rd5.ok, true,
      `historical receipt generation 1 <= current snapshot generation 2 must be accepted: ${JSON.stringify(rd5)}`);
    assert.equal(rd5.receipt && rd5.receipt.generation, 1, 'the historical (sealing) generation is what the receipt keeps');
    // restore the snapshot entry so later asserts in this fixture stay honest
    entry5.generation = 1;
    fs.writeFileSync(snapFile5, `${JSON.stringify(snap5, null, 2)}\n`, 'utf8');
  });
});

// ---------------------------------------------------------------------------
// REWORK F1 (REC-01 rework): receipt SOURCE authentication. The receipt file is
// plain user-writable disk — a same-user script that copies EVERY field
// correctly (bytes hash, checkpoint key, owner-snapshot generation/epoch/pipe)
// must still be refused, because issuance is proven ONLY by the live Session
// Authority's in-memory issuance ledger (what the daemon itself minted this
// connection), never by the store file's shape. Reading the file back (or the
// daemon re-reading it) is not issuance evidence. Fail-closed: a daemon restart
// that loses the ledger refuses (RECEIPT_NOT_ISSUED) rather than trusts disk.
// ---------------------------------------------------------------------------
test('F1. a perfectly-shaped self-written receipt store row never confirms an operation (issuance must be authority-attested)', async () => {
  await withSessionAuthority(async ({ admit, pipePath }) => {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    seedMutationOwner(stateDir, ID);
    await admit(stateDir, ID); // fence live -> the DAEMON persists the owner snapshot
    preReviewAttemptLedger(sessionPath, stateDir, ID); // r4: canonical attempt linkage
    const tail = readTransitions({ stateDir, identityHash: ID }).at(-1);
    const checkpoint = checkpointFromTail(tail);
    const evPath = writeEvidenceFile(stateDir);
    const rec = recordPreSubmitBoundaryReconciled({
      stateDir, identityHash: ID, checkpoint,
      source: 'control-plane-admitted-reconciliation',
      basis: 'F1 fixture: record written under a live fence, never sealed',
      evidence: { path: evPath },
      observation: validBoundaryObservation(),
    });
    assert.equal(rec.ok, true, JSON.stringify(rec));

    // NO seal call anywhere — a same-user script writes the receipts store
    // itself, deriving every field correctly from the on-disk world.
    const recordSha256 = createHash('sha256').update(fs.readFileSync(rec.path)).digest('hex');
    const checkpointKey = boundaryKeyOf({ ts: checkpoint.ts, reason: checkpoint.reason, evidence: checkpoint.evidence });
    const snapFile = path.join(path.dirname(authorityBindLockPath()), `owners-${createHash('sha256').update(pipePath).digest('hex')}.json`);
    const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
    const entry = (snap.entries || []).find((e) => e && e.identityHash === ID);
    assert.ok(entry, 'daemon owner snapshot entry present');
    const storeFile = path.join(path.dirname(authorityBindLockPath()), `receipts-${createHash('sha256').update(pipePath).digest('hex')}.json`);
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(storeFile, `${JSON.stringify({
      schemaVersion: 1,
      pipePath,
      entries: [{
        seq: 1,
        at: new Date().toISOString(),
        daemonEpoch: String(entry.daemonEpoch || 'copied-epoch'),
        identityHash: ID,
        sessionPath: path.join(stateDir, 'sessions', `${ID}.json`),
        generation: Number(entry.generation),
        connectionId: 999,
        kind: 'PRE_SUBMIT_BOUNDARY_RECONCILED',
        recordSha256,
        checkpointKey,
        pipePath,
      }],
    }, null, 2)}\n`, 'utf8');

    // (1) the reader must NOT accept the planted row: issuance is attested by
    // the LIVE authority's issuance ledger, never by the file's shape.
    const rd = await ctrlApi.readPreSubmitBoundaryReconcile({ stateDir, identityHash: ID, checkpoint });
    assert.equal(rd && rd.ok, false, JSON.stringify(rd));
    assert.equal(rd.reason, 'RECORD_OPERATION_UNCONFIRMED');
    assert.equal(rd.detail && rd.detail.reason, 'RECEIPT_NOT_ISSUED',
      'a correctly-shaped row the authority never issued is refused (authority-attested issuance only)');

    // (2) seal must not "re-confirm" the planted row either: a dup the live
    // authority cannot attest is a typed refusal, never { sealed:false } ok.
    const seal = await ctrlApi.sealPreSubmitBoundaryReconciled({ stateDir, identityHash: ID, checkpoint });
    assert.equal(seal && seal.ok, false, JSON.stringify(seal));
    assert.equal(seal.code, 'RECEIPT_NOT_ISSUED', 'resealing an unattested store row fails closed');

    // (3) the recovery gate stays fail-closed: typed block, zero retry.
    const before = JSON.stringify(readTransitions({ stateDir, identityHash: ID }));
    const calls = [];
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls) });
    assert.equal(res && res.ok, false, JSON.stringify(res));
    assert.equal(res.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED');
    assert.equal(res.detail.reconcile.reason, 'RECORD_OPERATION_UNCONFIRMED');
    assert.equal(res.detail.reconcile.detail && res.detail.reconcile.detail.reason, 'RECEIPT_NOT_ISSUED');
    assert.match(res.detail.reason, /Operator-authorized recovery decision/);
    assert.deepEqual(calls, [], 'zero transition/submit');
    assert.equal(JSON.stringify(readTransitions({ stateDir, identityHash: ID })), before, 'ledger untouched');
  });
});

// ---------------------------------------------------------------------------
// REWORK F2 (REC-01 rework): the boundary OBSERVATION/DECISION (transport stage
// tracker: phase + submitState observed PRE_SUBMIT before submit) is bound into
// the record. Missing observation, UNKNOWN, SUBMIT_IN_FLIGHT, POST_SUBMIT or a
// wrong phase are TYPED refusals at write, at seal and at read — before any
// seal or retry. A valid fence holder (REC-01's old precondition) with an
// UNKNOWN boundary must NOT get a recovery: the fence proves who writes, the
// observation proves WHAT phase the submit pipeline is in, and both are
// required. Submit artifacts on disk independently veto the claim.
// ---------------------------------------------------------------------------
test('F2. a missing/UNKNOWN/IN_FLIGHT/POST_SUBMIT boundary observation is a typed refusal before write, seal and retry (a valid fence holder alone never recovers)', async () => {
  await withSessionAuthority(async ({ admit, pipePath }) => {
    const evCp = { ts: '2026-10-03T00:00:00.000Z', reason: 'preReview:THREW', evidence: 'CDP_SEND_TIMEOUT' };

    // (a) writer with NO observation -> typed refusal, nothing written
    {
      const sd = mkStateDir();
      const { id: ID } = mkSession(sd, { issueNumber: 6301 });
      seedMutationOwner(sd, ID);
      await admit(sd, ID);
      const ev = writeEvidenceFile(sd);
      const r = recordPreSubmitBoundaryReconciled({
        stateDir: sd, identityHash: ID, checkpoint: evCp,
        source: 'test', basis: 'F2 no-observation fixture', evidence: { path: ev },
      });
      assert.equal(r && r.ok, false, JSON.stringify(r));
      assert.equal(r.reason, 'BOUNDARY_OBSERVATION_REQUIRED');
      const dir = path.join(sd, 'control-loop', ID, 'pre-submit-boundary');
      assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, 'no record file was written');
    }

    // (b) UNKNOWN / SUBMIT_IN_FLIGHT / POST_SUBMIT / wrong phase -> typed refusal
    {
      const sd = mkStateDir();
      const { id: ID } = mkSession(sd, { issueNumber: 6302 });
      seedMutationOwner(sd, ID);
      await admit(sd, ID);
      const ev = writeEvidenceFile(sd);
      for (const obs of [
        validBoundaryObservation({ submitState: 'UNKNOWN' }),
        validBoundaryObservation({ submitState: 'SUBMIT_IN_FLIGHT' }),
        validBoundaryObservation({ submitState: 'POST_SUBMIT' }),
        validBoundaryObservation({ phase: 'POST_SUBMIT' }),
      ]) {
        const r = recordPreSubmitBoundaryReconciled({
          stateDir: sd, identityHash: ID, checkpoint: evCp,
          source: 'test', basis: 'F2 unproven-boundary fixture', evidence: { path: ev },
          observation: obs,
        });
        assert.equal(r && r.ok, false, JSON.stringify(r));
        assert.equal(r.reason, 'BOUNDARY_NOT_PRE_SUBMIT',
          `unproven observation must be refused: ${JSON.stringify(obs)}`);
      }
      const dir = path.join(sd, 'control-loop', ID, 'pre-submit-boundary');
      assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, 'no record file was written');
    }

    // (c) valid observation BUT submit artifacts on disk -> typed refusal
    {
      const sd = mkStateDir();
      const { id: ID } = mkSession(sd, { issueNumber: 6303 });
      seedMutationOwner(sd, ID);
      await admit(sd, ID);
      const ev = writeEvidenceFile(sd);
      writeSubmitArtifact(sd, ID);
      const r = recordPreSubmitBoundaryReconciled({
        stateDir: sd, identityHash: ID, checkpoint: evCp,
        source: 'test', basis: 'F2 artifact-present fixture', evidence: { path: ev },
        observation: validBoundaryObservation(),
      });
      assert.equal(r && r.ok, false, JSON.stringify(r));
      assert.equal(r.reason, 'BOUNDARY_SUBMIT_ARTIFACTS_PRESENT',
        'the artifact directory is an independent veto: a submit side effect exists');
    }

    // (d) seal refuses an UNKNOWN-boundary record (typed, before any receipt)
    {
      const sd = mkStateDir();
      const { id: ID } = mkSession(sd, { issueNumber: 6304 });
      seedMutationOwner(sd, ID);
      await admit(sd, ID);
      const dir = path.join(sd, 'control-loop', ID, 'pre-submit-boundary');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${boundaryKeyOf(evCp)}.json`), `${JSON.stringify({
        schemaVersion: '1',
        kind: 'PRE_SUBMIT_BOUNDARY_RECONCILED',
        identityHash: ID,
        checkpoint: { ...evCp },
        source: 'test',
        basis: 'F2 planted UNKNOWN-boundary record',
        authority: { kind: 'ADMISSION_FENCE', lane: 'opencode-control-lane', daemonEpoch: 'copied-epoch', generation: 1, connectionId: 999, pipePath, acquiredAt: new Date().toISOString() },
        boundary: { observation: { phase: 'PRE_SUBMIT', submitState: 'UNKNOWN', observedAt: new Date().toISOString(), source: 'transport-stage-tracker' }, decision: { action: 'PRE_SUBMIT_BOUNDARY_RECONCILED', decidedAt: new Date().toISOString() } },
        evidence: { path: writeEvidenceFile(sd), sha256: null },
        reconciledAt: new Date().toISOString(),
      }, null, 2)}\n`, 'utf8');
      const seal = await ctrlApi.sealPreSubmitBoundaryReconciled({ stateDir: sd, identityHash: ID, checkpoint: evCp });
      assert.equal(seal && seal.ok, false, JSON.stringify(seal));
      assert.equal(seal.code, 'BOUNDARY_NOT_PROVEN');
      assert.equal(seal.detail && seal.detail.reason, 'BOUNDARY_NOT_PRE_SUBMIT');
    }

    // (e) reader refuses an UNKNOWN-boundary record (before confirm/receipt)
    // and (f) a record with NO boundary block at all.
    const sd = mkStateDir();
    const { sessionPath, id: ID } = mkSession(sd, { issueNumber: 6305 });
    seedMutationOwner(sd, ID);
    await admit(sd, ID);
    preReviewTimeoutLedger(sessionPath, sd, ID);
    const tail = readTransitions({ stateDir: sd, identityHash: ID }).at(-1);
    const cp5 = { ts: String(tail.ts), reason: String(tail.reason), evidence: String(tail.evidence) };
    const ev = writeEvidenceFile(sd);
    const dir = path.join(sd, 'control-loop', ID, 'pre-submit-boundary');
    fs.mkdirSync(dir, { recursive: true });
    const snap = JSON.parse(fs.readFileSync(path.join(path.dirname(authorityBindLockPath()), `owners-${createHash('sha256').update(pipePath).digest('hex')}.json`), 'utf8'));
    const entry = (snap.entries || []).find((e) => e && e.identityHash === ID);
    assert.ok(entry, 'daemon owner snapshot entry present');
    const plantAuth = {
      kind: 'ADMISSION_FENCE',
      lane: entry.laneId,
      daemonEpoch: String(entry.daemonEpoch || 'copied-epoch'),
      generation: Number(entry.generation),
      connectionId: 999,
      pipePath,
      acquiredAt: new Date().toISOString(),
    };
    const plantEvidence = { path: ev, sha256: createHash('sha256').update(fs.readFileSync(ev)).digest('hex') };

    // (e) UNKNOWN boundary
    fs.writeFileSync(path.join(dir, `${boundaryKeyOf(cp5)}.json`), `${JSON.stringify({
      schemaVersion: '1', kind: 'PRE_SUBMIT_BOUNDARY_RECONCILED', identityHash: ID,
      checkpoint: { ...cp5 }, source: 'test', basis: 'F2 planted UNKNOWN-boundary record',
      authority: plantAuth,
      boundary: { observation: { phase: 'PRE_SUBMIT', submitState: 'UNKNOWN', observedAt: new Date().toISOString(), source: 'transport-stage-tracker' }, decision: { action: 'PRE_SUBMIT_BOUNDARY_RECONCILED', decidedAt: new Date().toISOString() } },
      evidence: plantEvidence, reconciledAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    const rdE = await ctrlApi.readPreSubmitBoundaryReconcile({ stateDir: sd, identityHash: ID, checkpoint: cp5 });
    assert.equal(rdE && rdE.ok, false, JSON.stringify(rdE));
    assert.equal(rdE.reason, 'RECORD_BOUNDARY_UNPROVEN');
    assert.equal(rdE.detail && rdE.detail.reason, 'BOUNDARY_NOT_PRE_SUBMIT');

    // (f) no boundary block at all
    const cpF = { ts: String(tail.ts), reason: 'preReview:THREW-f2-no-boundary', evidence: String(tail.evidence) };
    fs.writeFileSync(path.join(dir, `${boundaryKeyOf(cpF)}.json`), `${JSON.stringify({
      schemaVersion: '1', kind: 'PRE_SUBMIT_BOUNDARY_RECONCILED', identityHash: ID,
      checkpoint: { ...cpF }, source: 'test', basis: 'F2 record without a boundary block',
      authority: plantAuth,
      evidence: plantEvidence, reconciledAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    const rdF = await ctrlApi.readPreSubmitBoundaryReconcile({ stateDir: sd, identityHash: ID, checkpoint: cpF });
    assert.equal(rdF && rdF.ok, false, JSON.stringify(rdF));
    assert.equal(rdF.reason, 'RECORD_BOUNDARY_UNPROVEN');
    assert.equal(rdF.detail && rdF.detail.reason, 'OBSERVATION_MISSING');

    // (g) THE regression: a valid fence holder (REC-01's old precondition) but
    // the planted boundary is UNKNOWN -> NO recovery, zero mutation.
    const before = JSON.stringify(readTransitions({ stateDir: sd, identityHash: ID }));
    const calls = [];
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir: sd, deps: preReviewRetryDeps(calls) });
    assert.equal(res && res.ok, false, JSON.stringify(res));
    assert.equal(res.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED');
    assert.equal(res.detail.reconcile.reason, 'RECORD_BOUNDARY_UNPROVEN');
    assert.equal(res.detail.reconcile.detail && res.detail.reconcile.detail.reason, 'BOUNDARY_NOT_PRE_SUBMIT');
    assert.match(res.detail.reason, /Operator-authorized recovery decision/);
    assert.deepEqual(calls, [], 'zero transition/submit: fence holder with UNKNOWN boundary never recovers');
    assert.equal(JSON.stringify(readTransitions({ stateDir: sd, identityHash: ID })), before, 'ledger untouched');
  });
});

// ---------------------------------------------------------------------------
// REWORK F3 (REC-01 rework): the PRODUCTION entry the runner executes. It owns
// the whole arc — validate -> record (with observation) -> seal -> release ->
// RE-ACQUIRE -> verify through the authority — and only then does the bounded
// retry run. The test exercises the REAL entry (namespace import so a missing
// export fails per-assertion); only periphery (deps/transport) stays mocked.
// ---------------------------------------------------------------------------
test('F3-entry (native). the production runner entry owns validation -> record -> seal -> release, then re-acquires and verifies before the bounded retry', async () => {
  assert.equal(typeof socRunnerBin.reconcilePreSubmitBoundary, 'function',
    'the production runner entry exposes reconcilePreSubmitBoundary');
  await withSessionAuthority(async ({ admit, pipePath }) => {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    seedMutationOwner(stateDir, ID);
    await admit(stateDir, ID); // ledger seeding needs a live fence first (REC1)
    preReviewAttemptLedger(sessionPath, stateDir, ID); // r4: canonical attempt linkage
    const tail = readTransitions({ stateDir, identityHash: ID }).at(-1);
    const checkpoint = checkpointFromTail(tail);
    const evPath = writeEvidenceFile(stateDir);

    const out = await socRunnerBin.reconcilePreSubmitBoundary({
      stateDir, identityHash: ID, checkpoint,
      source: 'production-runner-entry',
      basis: 'F3-entry: transport stage tracker observed PRE_SUBMIT before submit',
      evidence: { path: evPath },
      observation: validBoundaryObservation(),
    });
    assert.equal(out && out.ok, true, JSON.stringify(out));
    // REWORK F3-grant (round 2): THIS test pre-admitted the identity, so the
    // grant is CALLER-owned — the entry must neither release nor rotate it,
    // and verification runs under the same live grant. (Entry-owned rotation
    // + cleanup is pinned by the F3-grant test below.)
    assert.equal(out.grantOwnership, 'caller', 'the entry never claims a grant the caller already held');
    assert.equal(out.grantReleased, false, 'a caller-owned grant is never released by the entry');
    assert.equal(out.verified, true, 'the entry verified through the authority RECEIPT seam under the caller grant');
    assert.equal(out.receipt && out.receipt.recordSha256, out.recordSha256, 'the receipt binds the sealed record bytes');
    const entryFence = assertAdmissionFence({ sessionPath, identityHash: ID });
    assert.equal(entryFence && entryFence.ok, true, 'the caller fence is still live after the entry ran');

    // exactly one store row: the entry sealed once, verification mints nothing
    const storePath = path.join(path.dirname(authorityBindLockPath()), `receipts-${createHash('sha256').update(pipePath).digest('hex')}.json`);
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const rows = (store.entries || []).filter((x) => x && x.kind === 'PRE_SUBMIT_BOUNDARY_RECONCILED' && x.recordSha256 === out.recordSha256);
    assert.equal(rows.length, 1, 'exactly one authority-issued receipt row');

    // the identity is still fence-held (this test pre-admitted it and the
    // entry never releases a caller-owned grant), so the REAL gate's bounded
    // retry now runs through the real reader/confirm path.
    const calls = [];
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: preReviewRetryDeps(calls) });
    assert.equal(res && res.ok, true, JSON.stringify(res));
    assert.deepEqual(calls, ['preReview', 'finalReview'], 'bounded retry exactly once through the production entry');

    // (b) an UNKNOWN observation never even writes a record
    const sd2 = mkStateDir();
    const s2 = mkSession(sd2, { issueNumber: 6312 });
    seedMutationOwner(sd2, s2.id);
    await admit(sd2, s2.id);
    preReviewAttemptLedger(s2.sessionPath, sd2, s2.id); // r4: canonical attempt linkage
    const tail2b = readTransitions({ stateDir: sd2, identityHash: s2.id }).at(-1);
    const out2 = await socRunnerBin.reconcilePreSubmitBoundary({
      stateDir: sd2, identityHash: s2.id,
      checkpoint: checkpointFromTail(tail2b),
      source: 'production-runner-entry', basis: 'F3-entry refusal fixture',
      evidence: { path: writeEvidenceFile(sd2) },
      observation: validBoundaryObservation({ submitState: 'UNKNOWN' }),
    });
    assert.equal(out2 && out2.ok, false, JSON.stringify(out2));
    assert.equal(out2.reason, 'BOUNDARY_NOT_PRE_SUBMIT', 'the entry refuses an unproven boundary before writing anything');
    assert.equal(out2.grantReleased, false, 'the refusal never releases the caller-owned grant');
    const sdir = path.join(sd2, 'control-loop', s2.id, 'pre-submit-boundary');
    assert.equal(fs.existsSync(sdir) ? fs.readdirSync(sdir).length : 0, 0, 'no record was written for the refused boundary');
    await releaseAdmission({ sessionPath: s2.sessionPath, identityHash: s2.id });
  });
});

// ---------------------------------------------------------------------------
// REWORK F2-src (REC-01 rework round 2): PROVENANCE of the boundary OBSERVATION.
// A caller-supplied {phase, submitState} object is a CLAIM, never proof. The
// proof is the transport stage tracker's marker line inside the EVIDENCE file
// (bound by the record's sha256): kind/source/stage/phase/submitState/
// observedAt/code, where code must equal THIS checkpoint's evidence. Missing
// marker, a contradicting marker, a wrong code or a future observedAt are
// typed refusals BEFORE any write/seal/retry — and a marker-perfect PLANTED
// record whose evidence carries no marker blocks at seal, at read and at the
// gate (RECORD_BOUNDARY_UNPROVEN / OBSERVATION_UNPROVEN): the reader refuses
// honestly instead of fabricating an observation for a legacy checkpoint.
// ---------------------------------------------------------------------------
test('F2-src. an observation claim without a proven stage marker in the evidence is refused before write, seal and retry', async () => {
  await withSessionAuthority(async ({ admit, pipePath }) => {
    // ---- writer refusals (a)-(d): one admitted identity, marker variants ----
    const sd = mkStateDir();
    const { id: ID } = mkSession(sd, { issueNumber: 6601 });
    seedMutationOwner(sd, ID);
    await admit(sd, ID);
    const cp = { ts: new Date(Date.now() - 2000).toISOString(), reason: 'preReview:THREW', evidence: 'CDP_SEND_TIMEOUT' };
    const write = (content, observation = validBoundaryObservation()) => recordPreSubmitBoundaryReconciled({
      stateDir: sd, identityHash: ID, checkpoint: cp,
      source: 'test', basis: 'F2-src fixture', evidence: { path: writeEvidenceFile(sd, content) },
      observation,
    });
    const dir = path.join(sd, 'control-loop', ID, 'pre-submit-boundary');
    const assertNothingWritten = (label) => {
      assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, `${label}: no record file was written`);
    };

    // (a) NO marker line at all -> the claim is unproven, nothing is written
    {
      const r = write('legacy transport log with no stage-observation marker');
      assert.equal(r && r.ok, false, JSON.stringify(r));
      assert.equal(r.reason, 'BOUNDARY_OBSERVATION_UNPROVEN');
      assert.equal(r.detail && r.detail.reason, 'OBSERVATION_UNPROVEN');
      assertNothingWritten('(a)');
    }
    // (b) the marker CONTRADICTS the claim -> typed mismatch, nothing written
    {
      const r = write(stageObservationLine({ identityHash: ID, attemptId: 'fixture-attempt-1', stage: 'POST_SUBMIT_TURN_WAIT', phase: 'POST_SUBMIT', submitState: 'POST_SUBMIT' }));
      assert.equal(r && r.ok, false, JSON.stringify(r));
      assert.equal(r.reason, 'BOUNDARY_OBSERVATION_MISMATCH', 'a marker proving POST_SUBMIT never confirms a PRE_SUBMIT claim');
      assertNothingWritten('(b)');
    }
    // (c) marker code != THIS checkpoint's evidence -> checkpoint mismatch
    {
      const r = write(stageObservationLine({ identityHash: ID, attemptId: 'fixture-attempt-1', code: 'CDP_WS_ERROR' }));
      assert.equal(r && r.ok, false, JSON.stringify(r));
      assert.equal(r.reason, 'BOUNDARY_OBSERVATION_UNPROVEN');
      assert.equal(r.detail && r.detail.reason, 'OBSERVATION_CHECKPOINT_MISMATCH');
      assertNothingWritten('(c)');
    }
    // (d) observedAt in the future -> timestamp refused as unprovable
    {
      const r = write(stageObservationLine({ identityHash: ID, attemptId: 'fixture-attempt-1', observedAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() }));
      assert.equal(r && r.ok, false, JSON.stringify(r));
      assert.equal(r.reason, 'BOUNDARY_OBSERVATION_UNPROVEN');
      assert.equal(r.detail && r.detail.reason, 'OBSERVATION_TIMESTAMP_INVALID');
      assertNothingWritten('(d)');
    }

    // ---- (e) THE regression: marker-perfect planted record, NO marker ----
    // Correct shape, correct authority markers, correct evidence hash — the
    // only thing missing is the provenance line, so seal, read and the gate
    // must all stay fail-closed.
    const sd2 = mkStateDir();
    const s2 = mkSession(sd2, { issueNumber: 6605 });
    seedMutationOwner(sd2, s2.id);
    await admit(sd2, s2.id);
    preReviewTimeoutLedger(s2.sessionPath, sd2, s2.id);
    const tail2 = readTransitions({ stateDir: sd2, identityHash: s2.id }).at(-1);
    const cp2 = { ts: String(tail2.ts), reason: String(tail2.reason), evidence: String(tail2.evidence) };
    const ev2 = writeEvidenceFile(sd2, 'legacy transport log with no stage-observation marker');
    const dir2 = path.join(sd2, 'control-loop', s2.id, 'pre-submit-boundary');
    fs.mkdirSync(dir2, { recursive: true });
    const snap2 = JSON.parse(fs.readFileSync(path.join(path.dirname(authorityBindLockPath()), `owners-${createHash('sha256').update(pipePath).digest('hex')}.json`), 'utf8'));
    const entry2 = (snap2.entries || []).find((e) => e && e.identityHash === s2.id);
    assert.ok(entry2, 'daemon owner snapshot entry present');
    fs.writeFileSync(path.join(dir2, `${boundaryKeyOf(cp2)}.json`), `${JSON.stringify({
      schemaVersion: '1',
      kind: 'PRE_SUBMIT_BOUNDARY_RECONCILED',
      identityHash: s2.id,
      checkpoint: { ...cp2 },
      source: 'test',
      basis: 'F2-src planted marker-perfect record without marker provenance',
      authority: {
        kind: 'ADMISSION_FENCE',
        lane: entry2.laneId,
        daemonEpoch: String(entry2.daemonEpoch || 'copied-epoch'),
        generation: Number(entry2.generation),
        connectionId: 999,
        pipePath,
        acquiredAt: new Date().toISOString(),
      },
      boundary: { observation: validBoundaryObservation(), decision: { action: 'PRE_SUBMIT_BOUNDARY_RECONCILED', decidedAt: new Date().toISOString() } },
      evidence: { path: ev2, sha256: createHash('sha256').update(fs.readFileSync(ev2)).digest('hex') },
      reconciledAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');

    const seal = await ctrlApi.sealPreSubmitBoundaryReconciled({ stateDir: sd2, identityHash: s2.id, checkpoint: cp2 });
    assert.equal(seal && seal.ok, false, JSON.stringify(seal));
    assert.equal(seal.code, 'BOUNDARY_NOT_PROVEN');
    assert.equal(seal.detail && seal.detail.reason, 'OBSERVATION_UNPROVEN', 'seal never mints a receipt for an unproven observation');

    const rd = await ctrlApi.readPreSubmitBoundaryReconcile({ stateDir: sd2, identityHash: s2.id, checkpoint: cp2 });
    assert.equal(rd && rd.ok, false, JSON.stringify(rd));
    assert.equal(rd.reason, 'RECORD_BOUNDARY_UNPROVEN');
    assert.equal(rd.detail && rd.detail.reason, 'OBSERVATION_UNPROVEN', 'the reader refuses honestly instead of fabricating an observation');

    const before = JSON.stringify(readTransitions({ stateDir: sd2, identityHash: s2.id }));
    const calls = [];
    const res = await runControlLoop({ sessionPath: s2.sessionPath, identityHash: s2.id, stateDir: sd2, deps: preReviewRetryDeps(calls) });
    assert.equal(res && res.ok, false, JSON.stringify(res));
    assert.equal(res.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED');
    assert.equal(res.detail.reconcile.reason, 'RECORD_BOUNDARY_UNPROVEN');
    assert.equal(res.detail.reconcile.detail && res.detail.reconcile.detail.reason, 'OBSERVATION_UNPROVEN');
    assert.match(res.detail.reason, /Operator-authorized recovery decision/);
    assert.deepEqual(calls, [], 'zero transition/submit: no retry for an unproven observation');
    assert.equal(JSON.stringify(readTransitions({ stateDir: sd2, identityHash: s2.id })), before, 'ledger untouched');
  });
});

// ---------------------------------------------------------------------------
// REWORK F3-grant (REC-01 rework round 2): the GRANT CONTRACT of the real
// production entry. The entry must NEVER release a grant it does not own:
//   * entry-owned (no fence held on entry): a post-admission FAILURE cleans up
//     the grant it minted; a SUCCESS rotates (release -> reacquire -> verify)
//     and then releases UNLESS the caller explicitly hands the grant off to the
//     canonical runner (handoffToRunner: true keeps it live).
//   * caller-owned (fence already held on entry): NO release, NO reacquire on
//     either outcome — success verifies under the SAME grant, failure reports
//     grantPreserved and the caller's fence stays live.
// ---------------------------------------------------------------------------
test('F3-grant. the production entry only releases the grant it owns (entry-owned cleanup/rotation, caller-owned preservation)', async () => {
  await withSessionAuthority(async ({ admit }) => {
    // REC-01 r4: mkCp seeds the CANONICAL failure evidence for this case (so
    // the checkpoint carries the transport attempt linkage) and leaves NO
    // fence held - each case then admits for itself when it needs a
    // caller-owned grant.
    const mkCp = async (sd, ID, sessionPath) => {
      await admit(sd, ID);
      preReviewAttemptLedger(sessionPath, sd, ID);
      const tail = readTransitions({ stateDir: sd, identityHash: ID }).at(-1);
      await releaseAdmission({ sessionPath: path.join(sd, 'sessions', `${ID}.json`), identityHash: ID });
      return checkpointFromTail(tail);
    };
    const fenceOf = (sd, ID) => assertAdmissionFence({ sessionPath: path.join(sd, 'sessions', `${ID}.json`), identityHash: ID });
    const releaseOf = (sd, ID) => releaseAdmission({ sessionPath: path.join(sd, 'sessions', `${ID}.json`), identityHash: ID });

    // (A) entry-owned SUCCESS: the entry rotates and ends WITHOUT the grant.
    {
      const sd = mkStateDir();
      const { id: ID, sessionPath } = mkSession(sd, { issueNumber: 6401 });
      seedMutationOwner(sd, ID);
      const cp = await mkCp(sd, ID, sessionPath);
      const out = await socRunnerBin.reconcilePreSubmitBoundary({
        stateDir: sd, identityHash: ID, checkpoint: cp,
        source: 'production-runner-entry', basis: 'F3-grant entry-owned success (observation derived from the evidence marker)',
        evidence: { path: writeEvidenceFile(sd) },
      });
      assert.equal(out && out.ok, true, JSON.stringify(out));
      assert.equal(out.grantOwnership, 'entry', 'the entry minted this grant itself');
      assert.equal(out.grantReleased, true, 'an entry-owned grant is released after the verification leg');
      assert.equal(out.verified, true, JSON.stringify(out));
      const f = fenceOf(sd, ID);
      assert.equal(f && f.ok, false, 'no fence is left held by the entry');
      assert.equal(f && f.code, 'ADMISSION_FENCE_MISSING');
    }

    // (B) entry-owned FAILURE: the grant the entry minted is cleaned up.
    {
      const sd = mkStateDir();
      const { id: ID, sessionPath } = mkSession(sd, { issueNumber: 6402 });
      seedMutationOwner(sd, ID);
      const cp = await mkCp(sd, ID, sessionPath);
      const out = await socRunnerBin.reconcilePreSubmitBoundary({
        stateDir: sd, identityHash: ID, checkpoint: cp,
        source: 'production-runner-entry', basis: 'F3-grant entry-owned failure',
        evidence: { path: writeEvidenceFile(sd) },
        observation: validBoundaryObservation({ submitState: 'UNKNOWN' }),
      });
      assert.equal(out && out.ok, false, JSON.stringify(out));
      assert.equal(out.reason, 'BOUNDARY_NOT_PRE_SUBMIT');
      assert.equal(out.grantOwnership, 'entry');
      assert.equal(out.grantReleased, true, 'a post-admission failure releases the grant the entry owns');
      const f = fenceOf(sd, ID);
      assert.equal(f && f.ok, false, 'the failed entry leaves no fence behind');
      const dir = path.join(sd, 'control-loop', ID, 'pre-submit-boundary');
      assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, 'no record for the refused boundary');
    }

    // (C) caller-owned FAILURE: the caller's grant is NEVER touched.
    {
      const sd = mkStateDir();
      const { id: ID, sessionPath } = mkSession(sd, { issueNumber: 6403 });
      seedMutationOwner(sd, ID);
      const cp = await mkCp(sd, ID, sessionPath);
      await admit(sd, ID);
      const out = await socRunnerBin.reconcilePreSubmitBoundary({
        stateDir: sd, identityHash: ID, checkpoint: cp,
        source: 'production-runner-entry', basis: 'F3-grant caller-owned failure',
        evidence: { path: writeEvidenceFile(sd) },
        observation: validBoundaryObservation({ submitState: 'UNKNOWN' }),
      });
      assert.equal(out && out.ok, false, JSON.stringify(out));
      assert.equal(out.reason, 'BOUNDARY_NOT_PRE_SUBMIT');
      assert.equal(out.grantOwnership, 'caller');
      assert.equal(out.grantReleased, false, 'the entry must never release a caller-owned grant');
      assert.equal(out.grantPreserved, true, 'the refusal reports the preserved caller grant');
      const f = fenceOf(sd, ID);
      assert.equal(f && f.ok, true, 'the caller fence is still live after the refusal');
      await releaseOf(sd, ID);
    }

    // (D) caller-owned SUCCESS: verified under the SAME grant; no rotation.
    {
      const sd = mkStateDir();
      const { id: ID, sessionPath } = mkSession(sd, { issueNumber: 6404 });
      seedMutationOwner(sd, ID);
      const cp = await mkCp(sd, ID, sessionPath);
      await admit(sd, ID);
      const out = await socRunnerBin.reconcilePreSubmitBoundary({
        stateDir: sd, identityHash: ID, checkpoint: cp,
        source: 'production-runner-entry', basis: 'F3-grant caller-owned success',
        evidence: { path: writeEvidenceFile(sd) },
        observation: validBoundaryObservation(),
      });
      assert.equal(out && out.ok, true, JSON.stringify(out));
      assert.equal(out.grantOwnership, 'caller');
      assert.equal(out.grantReleased, false, 'a caller-owned grant is never released or rotated');
      assert.equal(out.verified, true, JSON.stringify(out));
      const f = fenceOf(sd, ID);
      assert.equal(f && f.ok, true, 'the caller still holds its own fence');
      await releaseOf(sd, ID);
    }

    // (E) entry-owned SUCCESS with an EXPLICIT handoff to the canonical
    // runner: the grant is kept (the runner's bounded retry runs under it).
    {
      const sd = mkStateDir();
      const { id: ID, sessionPath } = mkSession(sd, { issueNumber: 6405 });
      seedMutationOwner(sd, ID);
      const cp = await mkCp(sd, ID, sessionPath);
      const out = await socRunnerBin.reconcilePreSubmitBoundary({
        stateDir: sd, identityHash: ID, checkpoint: cp,
        source: 'production-runner-entry', basis: 'F3-grant explicit handoff to the canonical runner',
        evidence: { path: writeEvidenceFile(sd) },
        observation: validBoundaryObservation(),
        handoffToRunner: true,
      });
      assert.equal(out && out.ok, true, JSON.stringify(out));
      assert.equal(out.grantOwnership, 'entry');
      assert.equal(out.grantReleased, false, 'an explicit handoff keeps the entry-owned grant');
      assert.equal(out.verified, true, JSON.stringify(out));
      const f = fenceOf(sd, ID);
      assert.equal(f && f.ok, true, 'the handed-off fence is live for the canonical runner');
      await releaseOf(sd, ID);
    }
  });
});

// ---------------------------------------------------------------------------
// REWORK F3-cli (REC-01 rework round 2): a genuinely invokable Operator /
// control-plane entry. The reconciliation is reachable through the REAL runner
// binary (--reconcile-pre-submit) and is exercised THROUGH a spawned
// subprocess that connects to the in-test Session Authority daemon via the
// canonical env contract (SOC_SESSION_ADMISSION + SOC_SESSION_AUTHORITY_PIPE_PATH)
// — not through a test-only export. Success proves the whole admitted arc
// (admit -> record -> seal -> release -> reacquire -> verify -> release) on
// the soc_control lane with an authority-issued receipt; a legacy checkpoint
// whose evidence carries no stage marker fails closed BEFORE admission, with
// no grant ever minted for the identity. soc_control permission and the
// Gateway recover contract are untouched (this path never calls either).
// ---------------------------------------------------------------------------
test('F3-cli. the --reconcile-pre-submit runner CLI reconciles and refuses through a real subprocess', async () => {
  assert.equal(typeof socRunnerBin.reconcilePreSubmitBoundary, 'function',
    'the production runner entry exposes reconcilePreSubmitBoundary');
  const BIN = fileURLToPath(new URL('../bin/soc-control-loop.mjs', import.meta.url));
  const execFileP = promisify(execFileCb);
  const runCli = async (argv, env) => {
    try {
      const { stdout, stderr } = await execFileP(process.execPath, [BIN, ...argv], {
        env, timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
      });
      return { code: 0, stdout: String(stdout), stderr: String(stderr) };
    } catch (e) {
      return { code: typeof e.code === 'number' ? e.code : 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
    }
  };
  const parseOut = (stdout) => JSON.parse(stdout.slice(stdout.indexOf('{')));

  await withSessionAuthority(async ({ admit, pipePath }) => {
    const env = { ...process.env, SOC_SESSION_ADMISSION: 'required', SOC_SESSION_AUTHORITY_PIPE_PATH: pipePath };
    const repo = 'duongpdddic-droid/soc_brain';
    const flagsFor = (issue, sd, cp, ev) => [
      '--reconcile-pre-submit',
      '--repo', repo, '--issue', String(issue), '--state-dir', sd,
      '--checkpoint-ts', cp.ts, '--checkpoint-reason', cp.reason, '--checkpoint-evidence', cp.evidence,
      // REC-01 r4: the attempt linkage rides along and is verified against the
      // canonical failure evidence before any grant (omitted when the fixture
      // checkpoint carries none - the CLI then blocks typed, never bypasses).
      ...(cp.attemptId ? ['--checkpoint-attempt', cp.attemptId] : []),
      '--evidence', ev,
    ];

    // (a) SUCCESS: the child performs the whole admitted arc against the
    // in-test daemon and exits 0 with a verified, receipt-bound record.
    {
      const sd = mkStateDir();
      const issue = 6501;
      // canonical session + soc_control mutationOwner: the entry reads BOTH
      // before it may mint any grant (mkSession builds the identity path).
      const { id: ID, sessionPath } = mkSession(sd, { issueNumber: issue });
      seedMutationOwner(sd, ID, 'soc_control');
      // REC-01 r4: seed the CANONICAL failure evidence (attempt linkage) with a
      // parent fence, then release it - the child CLI owns its own grant and
      // asserts the parent never holds one.
      await admit(sd, ID);
      preReviewAttemptLedger(sessionPath, sd, ID);
      const tail = readTransitions({ stateDir: sd, identityHash: ID }).at(-1);
      await releaseAdmission({ sessionPath, identityHash: ID });
      const ev = writeEvidenceFile(sd);
      const cp = checkpointFromTail(tail);
      const r = await runCli(flagsFor(issue, sd, cp, ev), env);
      assert.equal(r.code, 0, `exit 0 expected: stdout=${r.stdout} stderr=${r.stderr}`);
      const out = parseOut(r.stdout);
      assert.equal(out.ok, true, JSON.stringify(out));
      assert.equal(out.verified, true, JSON.stringify(out));
      assert.equal(out.grantOwnership, 'entry');
      assert.equal(out.grantReleased, true, 'the child releases the grant it owns before exiting');
      const recFile = path.join(sd, 'control-loop', ID, 'pre-submit-boundary', `${boundaryKeyOf(cp)}.json`);
      assert.ok(fs.existsSync(recFile), `record written by the CLI entry: ${recFile}`);
      const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
      assert.equal(rec.authority.lane, 'soc_control', 'the entry admits with the canonical soc_control lane');
      assert.equal(rec.boundary.observation.phase, 'PRE_SUBMIT', 'the derived stage observation is bound into the record');
      assert.equal(rec.boundary.observation.submitState, 'NOT_SUBMITTED', 'the derived stage observation is bound into the record');
      const storePath = path.join(path.dirname(authorityBindLockPath()), `receipts-${createHash('sha256').update(pipePath).digest('hex')}.json`);
      const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      const rows = (store.entries || []).filter((x) => x && x.identityHash === ID && x.kind === 'PRE_SUBMIT_BOUNDARY_RECONCILED');
      assert.equal(rows.length, 1, 'exactly one authority-issued receipt for the CLI reconciliation');
      // the PARENT never admits this identity itself (the child owned the arc)
      const f = assertAdmissionFence({ sessionPath: path.join(sd, 'sessions', `${ID}.json`), identityHash: ID });
      assert.equal(f && f.ok, false, 'the parent never holds a fence for the CLI identity');
      assert.equal(f && f.code, 'ADMISSION_FENCE_MISSING');
    }

    // (b) REFUSAL: a legacy checkpoint whose evidence carries no stage marker
    // fails closed BEFORE admission: no grant, no record, exit 1.
    {
      const sd = mkStateDir();
      const issue = 6502;
      const { id: ID } = mkSession(sd, { issueNumber: issue });
      seedMutationOwner(sd, ID, 'soc_control');
      const ev = writeEvidenceFile(sd, 'legacy transport log with no stage-observation marker');
      const cp = { ts: new Date(Date.now() - 1000).toISOString(), reason: 'preReview:THREW', evidence: 'CDP_SEND_TIMEOUT' };
      const r = await runCli(flagsFor(issue, sd, cp, ev), env);
      assert.equal(r.code, 1, `exit 1 expected: stdout=${r.stdout} stderr=${r.stderr}`);
      const out = parseOut(r.stdout);
      assert.equal(out.ok, false, JSON.stringify(out));
      assert.equal(out.code, 'BOUNDARY_OBSERVATION_UNPROVEN', JSON.stringify(out));
      assert.equal(out.detail && out.detail.reason, 'OBSERVATION_UNPROVEN', JSON.stringify(out));
      const dir = path.join(sd, 'control-loop', ID, 'pre-submit-boundary');
      assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, 'no record was written');
      const snapFile = path.join(path.dirname(authorityBindLockPath()), `owners-${createHash('sha256').update(pipePath).digest('hex')}.json`);
      const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
      assert.equal((snap.entries || []).some((e) => e && e.identityHash === ID), false,
        'no grant was ever minted for the refused identity');
      const f = assertAdmissionFence({ sessionPath: path.join(sd, 'sessions', `${ID}.json`), identityHash: ID });
      assert.equal(f && f.ok, false, 'the parent never holds a fence for the CLI identity');
    }
  });
});

// ---------------------------------------------------------------------------
// REWORK legacy/idempotence (REC-01 rework round 2): a STRUCTURE-VALID base
// record that LACKS the boundary block must never be returned as a new
// successful reconciliation (the old exists-check did exactly that). Contract:
//   * without new proof  -> typed refusal; the legacy base stays byte-identical
//     and the reader names it honestly (RECORD_BOUNDARY_UNPROVEN /
//     OBSERVATION_MISSING), never RECORD_ABSENT-as-success;
//   * with proven proof  -> the writer seals a SIBLING (the exact path the
//     seal/reader/gate then use), the base stays byte-identical, a repeat write
//     returns the SAME sibling (created:false) — never a third file;
//   * the gate's bounded retry runs through that proven sibling exactly once.
// ---------------------------------------------------------------------------
test('L. a boundary-less legacy base record is never returned as a reconciliation; proven proof lands in a sealed sibling', async () => {
  await withSessionAuthority(async ({ admit, pipePath }) => {
    const sd = mkStateDir();
    const { sessionPath, id: ID } = mkSession(sd, { issueNumber: 6701 });
    seedMutationOwner(sd, ID);
    await admit(sd, ID);
    preReviewAttemptLedger(sessionPath, sd, ID); // r4: canonical attempt linkage
    const tail = readTransitions({ stateDir: sd, identityHash: ID }).at(-1);
    const cp = checkpointFromTail(tail);
    const key = boundaryKeyOf(cp);
    const dir = path.join(sd, 'control-loop', ID, 'pre-submit-boundary');
    fs.mkdirSync(dir, { recursive: true });
    const ev = writeEvidenceFile(sd);

    // Plant a STRUCTURE-VALID record with NO boundary block (the legacy shape).
    const snap = JSON.parse(fs.readFileSync(path.join(path.dirname(authorityBindLockPath()), `owners-${createHash('sha256').update(pipePath).digest('hex')}.json`), 'utf8'));
    const entry = (snap.entries || []).find((e) => e && e.identityHash === ID);
    assert.ok(entry, 'daemon owner snapshot entry present');
    const baseFile = path.join(dir, `${key}.json`);
    fs.writeFileSync(baseFile, `${JSON.stringify({
      schemaVersion: '1',
      kind: 'PRE_SUBMIT_BOUNDARY_RECONCILED',
      identityHash: ID,
      checkpoint: { ...cp },
      source: 'legacy',
      basis: 'boundary-less legacy record (structure-valid, no observation)',
      authority: {
        kind: 'ADMISSION_FENCE',
        lane: entry.laneId,
        daemonEpoch: String(entry.daemonEpoch || 'copied-epoch'),
        generation: Number(entry.generation),
        connectionId: 999,
        pipePath,
        acquiredAt: new Date().toISOString(),
      },
      evidence: { path: ev, sha256: createHash('sha256').update(fs.readFileSync(ev)).digest('hex') },
      reconciledAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    const baseBytes = fs.readFileSync(baseFile);

    // (1) NO new proof: typed refusal (never a success on the legacy base),
    // and the reader names the boundary-less record honestly.
    const noProof = recordPreSubmitBoundaryReconciled({
      stateDir: sd, identityHash: ID, checkpoint: cp,
      source: 'test', basis: 'L without proof', evidence: { path: ev },
    });
    assert.equal(noProof && noProof.ok, false, JSON.stringify(noProof));
    assert.equal(noProof.reason, 'BOUNDARY_OBSERVATION_REQUIRED',
      'boundary-less legacy base + no proof is a typed refusal, never a successful reconciliation');
    const rd1 = await ctrlApi.readPreSubmitBoundaryReconcile({ stateDir: sd, identityHash: ID, checkpoint: cp });
    assert.equal(rd1 && rd1.ok, false, JSON.stringify(rd1));
    assert.equal(rd1.reason, 'RECORD_BOUNDARY_UNPROVEN');
    assert.equal(rd1.detail && rd1.detail.reason, 'OBSERVATION_MISSING');
    assert.deepEqual((rd1.inspected || []).map((x) => x.reason), ['RECORD_BOUNDARY_UNPROVEN'],
      'the structure-valid legacy base is inspected and refused on its missing boundary');
    assert.deepEqual(fs.readFileSync(baseFile), baseBytes, 'the legacy record is byte-identical after the refusal');
    assert.equal(fs.readdirSync(dir).length, 1, 'no second record file yet');

    // (2) WITH proven proof: a SIBLING is created; the base stays untouched.
    const rec = recordPreSubmitBoundaryReconciled({
      stateDir: sd, identityHash: ID, checkpoint: cp,
      source: 'control-plane-admitted-reconciliation', basis: 'L with proven proof', evidence: { path: ev },
      observation: validBoundaryObservation(),
    });
    assert.equal(rec && rec.ok, true, JSON.stringify(rec));
    assert.equal(rec.created, true, 'the proven write is a NEW sibling, not a laundered base');
    assert.notEqual(rec.path, baseFile, 'the legacy base file is never rewritten');
    assert.ok(path.basename(rec.path).startsWith(`${key}.`), 'content-addressed sibling name');
    assert.deepEqual(fs.readFileSync(baseFile), baseBytes, 'the legacy record stays byte-identical');
    assert.equal(fs.readdirSync(dir).length, 2, 'base + sibling');

    // (3) seal the SIBLING (the exact path chosen by the writer), not the base
    const seal = await ctrlApi.sealPreSubmitBoundaryReconciled({ stateDir: sd, identityHash: ID, checkpoint: cp, recordPath: rec.path });
    assert.equal(seal && seal.ok, true, JSON.stringify(seal));
    assert.equal(seal.sealed, true, 'the proven sibling gets the authority receipt');
    assert.equal(seal.path, rec.path, 'the seal binds the writer-chosen path');
    assert.equal(seal.recordSha256, createHash('sha256').update(fs.readFileSync(rec.path)).digest('hex'), 'the receipt binds the sibling bytes');
    assert.deepEqual(fs.readFileSync(baseFile), baseBytes, 'sealing never rewrites the legacy base');

    // (4) the reader accepts the SIBLING through the receipt seam
    const rd = await ctrlApi.readPreSubmitBoundaryReconcile({ stateDir: sd, identityHash: ID, checkpoint: cp });
    assert.equal(rd && rd.ok, true, JSON.stringify(rd));
    assert.equal(rd.path, rec.path, 'the reader returns the proven sibling');

    // (5) idempotence: a repeat write returns the SAME sibling, created:false
    const again = recordPreSubmitBoundaryReconciled({
      stateDir: sd, identityHash: ID, checkpoint: cp,
      source: 'other', basis: 'other', evidence: { path: ev },
    });
    assert.equal(again && again.ok, true, JSON.stringify(again));
    assert.equal(again.created, false, 'the fully-proven sibling wins; never a third file');
    assert.equal(again.path, rec.path, 'pointing at the same proven sibling');
    assert.equal(fs.readdirSync(dir).length, 2, 'still base + sibling');

    // (6) the gate's bounded retry runs through the proven sibling exactly once
    const calls = [];
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir: sd, deps: preReviewRetryDeps(calls) });
    assert.equal(res && res.ok, true, JSON.stringify(res));
    assert.deepEqual(calls, ['preReview', 'finalReview'], 'the sibling record unlocks exactly one bounded retry');
  });
});

// ---------------------------------------------------------------------------
// REC-01 rework round 3 — PROVENANCE observation: canonical identity + transport
// attempt BINDING and the LATEST-marker discipline. The stage marker is no
// longer accepted on its error code alone:
//   (1) the marker must carry the canonical identityHash AND the transport
//       attempt id it was emitted for; a same-code marker of a FOREIGN
//       identity or a FOREIGN attempt is an honest typed block;
//   (2) an OLD attempt's marker (observed well before the checkpoint being
//       reconciled) never proves THIS checkpoint - typed block;
//   (3) source must be the trusted transport stage tracker, and the
//       stage -> {phase, submitState} mapping must be internally consistent
//       (stage SUBMIT_IN_FLIGHT can never claim PRE_SUBMIT/NOT_SUBMITTED);
//   (4) the LAST marker line decides: a malformed / field-less / UNKNOWN /
//       POST_SUBMIT final marker blocks even when an earlier line already
//       proved PRE_SUBMIT - the reader never skips back to the old marker;
//   (5) a correctly bound marker + a proven boundary flows through
//       writer -> seal (authority receipt) -> reader, and the record stores
//       the bound identity/attempt.
// Legacy evidence with no (or unbound) marker stays an honest typed block -
// no marker is ever backfilled retroactively.
// ---------------------------------------------------------------------------
test('REC-01-r3. markers bind canonical identity + transport attempt, the latest marker decides, and a correctly bound marker passes writer/seal/reader', async () => {
  await withSessionAuthority(async ({ admit }) => {
    const sd = mkStateDir();
    const { id: ID, sessionPath } = mkSession(sd, { issueNumber: 6801 });
    seedMutationOwner(sd, ID);
    await admit(sd, ID);
    const cp = { ts: new Date(Date.now() - 1000).toISOString(), reason: 'preReview:THREW', evidence: 'CDP_SEND_TIMEOUT' };
    const dir = path.join(sd, 'control-loop', ID, 'pre-submit-boundary');
    const write = (content, checkpoint = cp, observation = validBoundaryObservation()) => recordPreSubmitBoundaryReconciled({
      stateDir: sd, identityHash: ID, checkpoint,
      source: 'test', basis: 'REC-01 r3 provenance binding fixture',
      evidence: { path: writeEvidenceFile(sd, content) },
      observation,
    });
    const assertNothingWritten = (label) => {
      assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, `${label}: a refused observation never writes a record`);
    };
    const bound = { identityHash: ID, attemptId: 'att-r3-1' };
    const expectUnproven = (r, reason, label) => {
      assert.equal(r && r.ok, false, `${label}: ${JSON.stringify(r)}`);
      assert.equal(r.reason, 'BOUNDARY_OBSERVATION_UNPROVEN', `${label}: ${JSON.stringify(r)}`);
      assert.equal(r.detail && r.detail.reason, reason, `${label}: ${JSON.stringify(r.detail)}`);
      assertNothingWritten(label);
    };

    // (1a) SAME error code but a FOREIGN canonical identity -> typed block
    expectUnproven(
      write(stageObservationLine({ ...bound, identityHash: 'foreign-identity-hash-not-this-session' })),
      'OBSERVATION_IDENTITY_MISMATCH',
      '(1a) same code, different identity',
    );
    // (1b) SAME error code but a DIFFERENT transport attempt than the
    // checkpoint being reconciled -> typed block
    expectUnproven(
      write(stageObservationLine({ ...bound, attemptId: 'att-of-another-attempt' }), { ...cp, attemptId: 'att-r3-1' }),
      'OBSERVATION_ATTEMPT_MISMATCH',
      '(1b) same code, different attempt',
    );
    // (1c) a legacy marker WITHOUT the identity/attempt linkage is a typed
    // block - the linkage is never backfilled retroactively
    expectUnproven(
      write(STAGE_OBSERVATION_PREFIX + JSON.stringify({
        kind: STAGE_OBSERVATION_KIND, source: 'transport-stage-tracker',
        stage: 'PRE_SUBMIT_SNAPSHOT', phase: 'PRE_SUBMIT', submitState: 'NOT_SUBMITTED',
        observedAt: new Date().toISOString(), code: 'CDP_SEND_TIMEOUT',
      })),
      'OBSERVATION_BINDING_MISSING',
      '(1c) legacy marker without attempt/identity linkage',
    );

    // (2) an OLD attempt's marker observed long before this checkpoint ->
    // typed block (an old PRE_SUBMIT marker never proves a new checkpoint)
    expectUnproven(
      write(stageObservationLine({ ...bound, observedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() })),
      'OBSERVATION_TIMESTAMP_INVALID',
      '(2) old marker for a new checkpoint',
    );

    // (3a) stage SUBMIT_IN_FLIGHT claiming PRE_SUBMIT/NOT_SUBMITTED -> block
    expectUnproven(
      write(stageObservationLine({ ...bound, stage: 'SUBMIT_IN_FLIGHT', phase: 'PRE_SUBMIT', submitState: 'NOT_SUBMITTED' })),
      'OBSERVATION_STAGE_MISMATCH',
      '(3a) SUBMIT_IN_FLIGHT stage claiming PRE_SUBMIT',
    );
    // (3b) an untrusted observation source -> block
    expectUnproven(
      write(stageObservationLine({ ...bound, source: 'pasted-log-line' })),
      'OBSERVATION_SOURCE_INVALID',
      '(3b) untrusted marker source',
    );

    // (4) a proven PRE_SUBMIT line followed by a BROKEN final marker: the last
    // marker decides, so every shape blocks - never a fallback to the old line
    const good = stageObservationLine({ ...bound });
    for (const [label, broken, expReason] of [
      ['(4a) final marker malformed', `${STAGE_OBSERVATION_PREFIX}{"kind":"${STAGE_OBSERVATION_KIND}","stage":`, 'OBSERVATION_MALFORMED'],
      ['(4b) final marker missing a field', STAGE_OBSERVATION_PREFIX + JSON.stringify({
        kind: STAGE_OBSERVATION_KIND, source: 'transport-stage-tracker',
        stage: 'PRE_SUBMIT_SNAPSHOT', phase: 'PRE_SUBMIT',
        observedAt: new Date().toISOString(), code: 'CDP_SEND_TIMEOUT', ...bound,
      }), 'OBSERVATION_SOURCE_INVALID'],
      ['(4c) final marker UNKNOWN', stageObservationLine({ ...bound, stage: 'PRE_SUBMIT_SNAPSHOT', phase: 'UNKNOWN', submitState: 'UNKNOWN' }), 'OBSERVATION_STAGE_MISMATCH'],
      ['(4d) final marker POST_SUBMIT', stageObservationLine({ ...bound, stage: 'POST_SUBMIT_TURN_WAIT', phase: 'POST_SUBMIT', submitState: 'POST_SUBMIT' }), null],
    ]) {
      const r = write(`boundary fixture log v1\n${good}\n${broken}\n`);
      assert.equal(r && r.ok, false, `${label}: ${JSON.stringify(r)}`);
      if (expReason) {
        assert.equal(r.reason, 'BOUNDARY_OBSERVATION_UNPROVEN', `${label}: ${JSON.stringify(r)}`);
        assert.equal(r.detail && r.detail.reason, expReason, `${label}: ${JSON.stringify(r.detail)}`);
      } else {
        // a well-formed POST_SUBMIT marker derives, but it can never confirm
        // the claimed PRE_SUBMIT boundary -> mismatch, nothing written
        assert.equal(r.reason, 'BOUNDARY_OBSERVATION_MISMATCH', `${label}: ${JSON.stringify(r)}`);
      }
      assertNothingWritten(label);
    }

    // (5) CORRECT binding + boundary -> writer -> seal (authority receipt) ->
    // reader, with the bound identity/attempt stored in the record. r4: the
    // happy path runs on a CANONICAL checkpoint whose failure evidence carries
    // the attempt id, exactly like the production chain.
    preReviewAttemptLedger(sessionPath, sd, ID, { attemptId: 'att-r3-ok' });
    const tailOk = readTransitions({ stateDir: sd, identityHash: ID }).at(-1);
    const cpOk = checkpointFromTail(tailOk);
    assert.equal(cpOk.attemptId, 'att-r3-ok', 'the checkpoint linkage comes from the canonical failure evidence');
    const ev = writeEvidenceFile(sd, `boundary fixture log v1\n${stageObservationLine({ ...bound, attemptId: 'att-r3-ok' })}\n`);
    const rec = recordPreSubmitBoundaryReconciled({
      stateDir: sd, identityHash: ID, checkpoint: cpOk,
      source: 'test', basis: 'REC-01 r3 correctly bound marker',
      evidence: { path: ev },
      observation: validBoundaryObservation(),
    });
    assert.equal(rec && rec.ok, true, JSON.stringify(rec));
    assert.equal(rec.created, true, JSON.stringify(rec));
    const stored = JSON.parse(fs.readFileSync(rec.path, 'utf8'));
    assert.equal(stored.boundary.observation.identityHash, ID, 'the record stores the bound canonical identity');
    assert.equal(stored.boundary.observation.attemptId, 'att-r3-ok', 'the record stores the bound transport attempt');

    const seal = await ctrlApi.sealPreSubmitBoundaryReconciled({ stateDir: sd, identityHash: ID, checkpoint: cpOk, recordPath: rec.path });
    assert.equal(seal && seal.ok, true, JSON.stringify(seal));
    assert.equal(seal.sealed, true, 'the correctly bound record gets the authority receipt');

    const rd = await ctrlApi.readPreSubmitBoundaryReconcile({ stateDir: sd, identityHash: ID, checkpoint: cpOk });
    assert.equal(rd && rd.ok, true, JSON.stringify(rd));
    assert.equal(rd.path, rec.path, 'the reader accepts the correctly bound record through the receipt seam');
  });
});

// ---------------------------------------------------------------------------
// REC-01 r4 — ATTEMPT LINKAGE END-TO-END. A marker's self-minted UUID plus the
// same identity/error code/time window is NOT a canonical basis: the attempt id
// must travel the PRODUCTION chain transport invocation -> typed failure
// evidence (ledger) -> checkpoint -> writer/seal/reader -> recovery gate, and
// every leg checks THAT linkage (never the marker as its own expected value):
//   (R1) two attempts of the same identity with the same error code seconds
//        apart (<5 min): attempt A's marker never proves checkpoint B, and a
//        checkpoint without its canonical linkage is typed-blocked before any
//        write; with the canonical attempt id the chain passes and the record
//        PERSISTS checkpoint.attemptId;
//   (R2) a legacy checkpoint (bare-string evidence, no canonical attempt id)
//        is typed-blocked at the writer (no record), at the seal (no receipt)
//        and at the reader/gate (no retry) - never backfilled;
//   (R3) the Operator CLI cannot bypass the check by omitting
//        --checkpoint-attempt, and a caller-supplied value that disagrees with
//        the canonical failure evidence is refused even when the marker agrees
//        with the caller;
//   (R5) a relaunch rebuilds the checkpoint from the SAME canonical failure
//        evidence and keeps the linkage (record of attempt X never authorizes
//        a checkpoint of attempt Y).
// ---------------------------------------------------------------------------
test('REC-01-r4. canonical attempt linkage end-to-end: <5min twin attempts, missing link blocks write/seal/retry, caller link is checked against canonical evidence, relaunch keeps the linkage', async () => {
  await withSessionAuthority(async ({ admit, pipePath }) => {
    // ===== R1: same identity + same code, two attempts < 5 minutes apart =====
    {
      const sd = mkStateDir();
      const { sessionPath, id: ID } = mkSession(sd, { issueNumber: 6911 });
      seedMutationOwner(sd, ID);
      await admit(sd, ID);
      preReviewAttemptLedger(sessionPath, sd, ID, { attemptId: 'att-A' });
      const tailA = readTransitions({ stateDir: sd, identityHash: ID }).at(-1);
      // attempt B: SAME identity, SAME error code, 60 seconds after A
      const tsB = new Date(Date.parse(tailA.ts) + 60 * 1000).toISOString();
      appendTransition({
        stateDir: sd, identityHash: ID, sessionPath,
        record: {
          schemaVersion: CONTROL_LOOP_SCHEMA_VERSION, ts: tsB,
          from: 'PRE_REVIEWING', to: 'BLOCKED', reason: 'preReview:FAIL',
          evidence: {
            ok: false, code: 'CDP_SEND_TIMEOUT',
            detail: { attemptId: 'att-B' }, // r5: compatible canonical (R1 proves the attempt link, not a submit veto)
          },
          identityHash: ID, sessionPath,
        },
      });
      const dir = path.join(sd, 'control-loop', ID, 'pre-submit-boundary');
      const cpB = { ts: tsB, reason: 'preReview:FAIL', evidence: 'CDP_SEND_TIMEOUT' };
      const markerA = `boundary fixture log v1\n${stageObservationLine({ identityHash: ID, attemptId: 'att-A', observedAt: new Date(Date.parse(tailA.ts) + 90 * 1000).toISOString() })}\n`;
      const markerB = `boundary fixture log v1\n${stageObservationLine({ identityHash: ID, attemptId: 'att-B', observedAt: new Date(Date.parse(tsB) + 1000).toISOString() })}\n`;

      // (R1a) checkpoint B WITHOUT canonical linkage + attempt A's marker
      // (same identity, same code, inside the 5-minute window) -> typed block,
      // nothing written: the marker's own UUID is never the basis.
      {
        const r = recordPreSubmitBoundaryReconciled({
          stateDir: sd, identityHash: ID, checkpoint: cpB,
          source: 'test', basis: 'R1a checkpoint without canonical attempt linkage',
          evidence: { path: writeEvidenceFile(sd, markerA) },
          observation: validBoundaryObservation(),
        });
        assert.equal(r && r.ok, false, JSON.stringify(r));
        assert.equal(r.reason, 'CHECKPOINT_ATTEMPT_LINK_MISSING', JSON.stringify(r));
        assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, 'R1a: no record for an unlinked checkpoint');
      }
      // (R1b) checkpoint B WITH its canonical attempt id: marker A still never
      // proves it; marker B walks the whole chain writer -> seal -> reader and
      // the record PERSISTS the linkage.
      {
        const rA = recordPreSubmitBoundaryReconciled({
          stateDir: sd, identityHash: ID, checkpoint: { ...cpB, attemptId: 'att-B' },
          source: 'test', basis: 'R1b marker of attempt A',
          evidence: { path: writeEvidenceFile(sd, markerA) },
          observation: validBoundaryObservation(),
        });
        assert.equal(rA && rA.ok, false, JSON.stringify(rA));
        assert.equal(rA.reason, 'BOUNDARY_OBSERVATION_UNPROVEN', JSON.stringify(rA));
        assert.equal(rA.detail && rA.detail.reason, 'OBSERVATION_ATTEMPT_MISMATCH', 'same code + same identity + <5min never crosses attempts');
        assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, 'R1b: marker A writes nothing for checkpoint B');

        const rB = recordPreSubmitBoundaryReconciled({
          stateDir: sd, identityHash: ID, checkpoint: { ...cpB, attemptId: 'att-B' },
          source: 'test', basis: 'R1b marker of attempt B (canonical chain)',
          evidence: { path: writeEvidenceFile(sd, markerB) },
          observation: validBoundaryObservation(),
        });
        assert.equal(rB && rB.ok, true, JSON.stringify(rB));
        const storedB = JSON.parse(fs.readFileSync(rB.path, 'utf8'));
        assert.equal(storedB.checkpoint.attemptId, 'att-B', 'the record persists the CANONICAL checkpoint linkage');
        const sealB = await ctrlApi.sealPreSubmitBoundaryReconciled({ stateDir: sd, identityHash: ID, checkpoint: { ...cpB, attemptId: 'att-B' }, recordPath: rB.path });
        assert.equal(sealB && sealB.ok, true, JSON.stringify(sealB));
        const rdB = await ctrlApi.readPreSubmitBoundaryReconcile({ stateDir: sd, identityHash: ID, checkpoint: { ...cpB, attemptId: 'att-B' } });
        assert.equal(rdB && rdB.ok, true, JSON.stringify(rdB));
      }
    }

    // ===== R2: legacy checkpoint (no canonical attempt id) blocks every leg =====
    {
      const sd = mkStateDir();
      const { sessionPath, id: ID } = mkSession(sd, { issueNumber: 6912 });
      seedMutationOwner(sd, ID);
      await admit(sd, ID);
      preReviewTimeoutLedger(sessionPath, sd, ID); // legacy preReview:THREW, bare string evidence
      const tail = readTransitions({ stateDir: sd, identityHash: ID }).at(-1);
      const legacyCp = { ts: String(tail.ts), reason: String(tail.reason), evidence: String(tail.evidence) }; // NO attemptId
      const ev = writeEvidenceFile(sd);
      const dir = path.join(sd, 'control-loop', ID, 'pre-submit-boundary');

      // (a) WRITER: no record file at all
      const w = recordPreSubmitBoundaryReconciled({
        stateDir: sd, identityHash: ID, checkpoint: legacyCp,
        source: 'test', basis: 'R2 legacy checkpoint without attempt linkage',
        evidence: { path: ev }, observation: validBoundaryObservation(),
      });
      assert.equal(w && w.ok, false, JSON.stringify(w));
      assert.equal(w.reason, 'CHECKPOINT_ATTEMPT_LINK_MISSING', JSON.stringify(w));
      assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, 'R2a: no record for the legacy checkpoint');

      // (b) SEAL: a marker-perfect planted record still gets NO receipt
      const snap = JSON.parse(fs.readFileSync(path.join(path.dirname(authorityBindLockPath()), `owners-${createHash('sha256').update(pipePath).digest('hex')}.json`), 'utf8'));
      const entry = (snap.entries || []).find((x) => x && x.identityHash === ID);
      assert.ok(entry, 'daemon owner snapshot entry present');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${boundaryKeyOf(legacyCp)}.json`), `${JSON.stringify({
        schemaVersion: '1', kind: 'PRE_SUBMIT_BOUNDARY_RECONCILED', identityHash: ID,
        checkpoint: { ...legacyCp }, source: 'test', basis: 'R2 marker-perfect legacy plant',
        authority: {
          kind: 'ADMISSION_FENCE', lane: entry.laneId, daemonEpoch: String(entry.daemonEpoch || 'copied-epoch'),
          generation: Number(entry.generation), connectionId: 999, pipePath, acquiredAt: new Date().toISOString(),
        },
        boundary: { observation: validBoundaryObservation(), decision: { action: 'PRE_SUBMIT_BOUNDARY_RECONCILED', decidedAt: new Date().toISOString() } },
        evidence: { path: ev, sha256: createHash('sha256').update(fs.readFileSync(ev)).digest('hex') },
        reconciledAt: new Date().toISOString(),
      }, null, 2)}\n`, 'utf8');
      const seal = await ctrlApi.sealPreSubmitBoundaryReconciled({ stateDir: sd, identityHash: ID, checkpoint: legacyCp });
      assert.equal(seal && seal.ok, false, JSON.stringify(seal));
      assert.equal(seal.code, 'RECORD_ATTEMPT_LINK_UNPROVEN', JSON.stringify(seal));
      assert.equal(seal.detail && seal.detail.reason, 'CHECKPOINT_ATTEMPT_LINK_MISSING', JSON.stringify(seal.detail));

      // (c) READER + GATE: no retry for the unlinked checkpoint
      const rd = await ctrlApi.readPreSubmitBoundaryReconcile({ stateDir: sd, identityHash: ID, checkpoint: legacyCp });
      assert.equal(rd && rd.ok, false, JSON.stringify(rd));
      assert.equal(rd.reason, 'RECORD_ATTEMPT_LINK_UNPROVEN', JSON.stringify(rd));
      assert.equal(rd.detail && rd.detail.reason, 'CHECKPOINT_ATTEMPT_LINK_MISSING', JSON.stringify(rd.detail));
      const before = JSON.stringify(readTransitions({ stateDir: sd, identityHash: ID }));
      const calls = [];
      const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir: sd, deps: preReviewRetryDeps(calls) });
      assert.equal(res && res.ok, false, JSON.stringify(res));
      assert.equal(res.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED');
      assert.equal(res.detail.reconcile.reason, 'RECORD_ATTEMPT_LINK_UNPROVEN', 'the gate names the missing canonical linkage');
      assert.deepEqual(calls, [], 'zero transition/submit for a legacy checkpoint');
      assert.equal(JSON.stringify(readTransitions({ stateDir: sd, identityHash: ID })), before, 'ledger untouched');
    }

    // ===== R3: the CLI cannot bypass the linkage check =====
    {
      const repo = 'duongpdddic-droid/soc_brain';
      const issue = 6913;
      const sd = mkStateDir();
      const { sessionPath, id: ID } = mkSession(sd, { issueNumber: issue });
      seedMutationOwner(sd, ID, 'soc_control');
      await admit(sd, ID); // seed the canonical failure evidence, then release (the CLI owns its own grant)
      preReviewAttemptLedger(sessionPath, sd, ID, { attemptId: 'att-cli' });
      const tail = readTransitions({ stateDir: sd, identityHash: ID }).at(-1);
      const release = await releaseAdmission({ sessionPath });
      assert.equal(release && release.ok, true, JSON.stringify(release));
      const cp = checkpointFromTail(tail); // { ts, reason, evidence, attemptId:'att-cli' }
      const env = { ...process.env, SOC_SESSION_ADMISSION: 'required', SOC_SESSION_AUTHORITY_PIPE_PATH: pipePath };
      const execFileP = promisify(execFileCb);
      const BIN = fileURLToPath(new URL('../bin/soc-control-loop.mjs', import.meta.url));
      const runCli = async (argv) => {
        try {
          const { stdout, stderr } = await execFileP(process.execPath, [BIN, ...argv], { env, timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
          return { code: 0, stdout: String(stdout), stderr: String(stderr) };
        } catch (e) {
          return { code: typeof e.code === 'number' ? e.code : 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
        }
      };
      const baseArgs = [
        '--reconcile-pre-submit', '--repo', repo, '--issue', String(issue), '--state-dir', sd,
        '--checkpoint-ts', cp.ts, '--checkpoint-reason', cp.reason, '--checkpoint-evidence', cp.evidence,
      ];
      const dir = path.join(sd, 'control-loop', ID, 'pre-submit-boundary');
      const nothingWritten = () => !(fs.existsSync(dir) && fs.readdirSync(dir).length > 0);
      const noGrant = () => {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(path.dirname(authorityBindLockPath()), `owners-${createHash('sha256').update(pipePath).digest('hex')}.json`), 'utf8'));
          return !(s.entries || []).some((x) => x && x.identityHash === ID);
        } catch { return true; }
      };

      // (a) OMITTING --checkpoint-attempt must not bypass the check (the
      // marker carries the CANONICAL attempt, so provenance alone passes and
      // only the missing checkpoint linkage can stop it)
      const ra = await runCli([...baseArgs, '--evidence', writeEvidenceFile(sd, `boundary fixture log v1\n${stageObservationLine({ identityHash: ID, attemptId: 'att-cli' })}\n`)]);
      assert.equal(ra.code, 1, `exit 1 expected: ${ra.stdout}${ra.stderr}`);
      const outA = JSON.parse(ra.stdout.slice(ra.stdout.indexOf('{')));
      assert.equal(outA.ok, false, JSON.stringify(outA));
      assert.equal(outA.code, 'CHECKPOINT_ATTEMPT_LINK_MISSING', JSON.stringify(outA));
      assert.equal(outA.grantTouched, false, 'no grant is minted before the linkage check');
      assert.ok(nothingWritten(), 'R3a: no record written');
      assert.ok(noGrant(), 'R3a: no owner-snapshot entry minted');

      // (b) a caller value that disagrees with the CANONICAL failure evidence
      // is refused EVEN THOUGH the marker agrees with the caller (the marker
      // is never its own expected value)
      const rb = await runCli([
        ...baseArgs,
        '--checkpoint-attempt', 'wrong-att-caller-claim',
        '--evidence', writeEvidenceFile(sd, `boundary fixture log v1\n${stageObservationLine({ identityHash: ID, attemptId: 'wrong-att-caller-claim' })}\n`),
      ]);
      assert.equal(rb.code, 1, `exit 1 expected: ${rb.stdout}${rb.stderr}`);
      const outB = JSON.parse(rb.stdout.slice(rb.stdout.indexOf('{')));
      assert.equal(outB.ok, false, JSON.stringify(outB));
      assert.equal(outB.code, 'CHECKPOINT_ATTEMPT_MISMATCH', JSON.stringify(outB));
      assert.equal(outB.detail && outB.detail.canonicalAttemptId, 'att-cli', 'the canonical failure evidence names the real attempt');
      assert.equal(outB.detail && outB.detail.checkpointAttemptId, 'wrong-att-caller-claim', 'the caller value is surfaced');
      assert.ok(nothingWritten(), 'R3b: no record written');
      assert.ok(noGrant(), 'R3b: no owner-snapshot entry minted');
    }

    // ===== R5: a relaunch rebuilds the checkpoint from the SAME canonical
    // failure evidence and keeps the linkage; a record of attempt X never
    // authorizes a checkpoint of attempt Y =====
    {
      // positive: unproven structured detail + canonical attempt id -> the gate
      // consults the canonical record (with its linkage) and authorizes ONE retry
      const sd = mkStateDir();
      const { sessionPath, id: ID } = mkSession(sd, { issueNumber: 6915 });
      seedMutationOwner(sd, ID);
      await admit(sd, ID);
      preReviewAttemptLedger(sessionPath, sd, ID, {
        attemptId: 'att-rl',
        // REC-01 r5: the positive case must be a canonical failure that is
        // REALLY compatible with PRE_SUBMIT (phase PRE_SUBMIT; no submit-state
        // metadata claiming the submit started) - a SUBMIT_IN_FLIGHT/UNKNOWN
        // canonical failure now VETOES reconciliation and can never be the
        // retried shape. Still unproven structurally (no submitEvidence), so
        // the gate consults the canonical record exactly as before.
        detail: { stage: 'PRE_SUBMIT_SNAPSHOT', phase: 'PRE_SUBMIT' },
      });
      const tail = readTransitions({ stateDir: sd, identityHash: ID }).at(-1);
      const cp = checkpointFromTail(tail);
      assert.equal(cp.attemptId, 'att-rl', 'the checkpoint linkage comes from the canonical failure evidence');
      const rec = recordPreSubmitBoundaryReconciled({
        stateDir: sd, identityHash: ID, checkpoint: cp,
        source: 'control-plane-admitted-reconciliation', basis: 'R5 canonical relaunch chain',
        evidence: { path: writeEvidenceFile(sd, `boundary fixture log v1\n${stageObservationLine({ identityHash: ID, attemptId: 'att-rl' })}\n`) },
        observation: validBoundaryObservation(),
      });
      assert.equal(rec && rec.ok, true, JSON.stringify(rec));
      const seal = await ctrlApi.sealPreSubmitBoundaryReconciled({ stateDir: sd, identityHash: ID, checkpoint: cp, recordPath: rec.path });
      assert.equal(seal && seal.ok, true, JSON.stringify(seal));
      const calls = [];
      const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir: sd, deps: preReviewRetryDeps(calls) });
      assert.equal(res && res.ok, true, JSON.stringify(res));
      assert.deepEqual(calls, ['preReview', 'finalReview'], 'the relaunch keeps the attempt linkage end-to-end');

      // negative: a NEWER canonical tail of attempt Y never reuses attempt X's
      // record - the relaunch blocks with zero adapter calls
      const sd2 = mkStateDir();
      const s2 = mkSession(sd2, { issueNumber: 6916 });
      seedMutationOwner(sd2, s2.id);
      await admit(sd2, s2.id);
      preReviewAttemptLedger(s2.sessionPath, sd2, s2.id, {
        attemptId: 'att-X',
        detail: { attemptId: 'att-X' }, // r5: compatible canonical (this case is the ATTEMPT link, not a submit veto) - see REC-01-r5 for the veto cases
      });
      const tailX = readTransitions({ stateDir: sd2, identityHash: s2.id }).at(-1);
      const cpX = checkpointFromTail(tailX);
      const recX = recordPreSubmitBoundaryReconciled({
        stateDir: sd2, identityHash: s2.id, checkpoint: cpX,
        source: 'control-plane-admitted-reconciliation', basis: 'R5 attempt X record',
        evidence: { path: writeEvidenceFile(sd2, `boundary fixture log v1\n${stageObservationLine({ identityHash: s2.id, attemptId: 'att-X' })}\n`) },
        observation: validBoundaryObservation(),
      });
      assert.equal(recX && recX.ok, true, JSON.stringify(recX));
      const sealX = await ctrlApi.sealPreSubmitBoundaryReconciled({ stateDir: sd2, identityHash: s2.id, checkpoint: cpX, recordPath: recX.path });
      assert.equal(sealX && sealX.ok, true, JSON.stringify(sealX));
      // adversarial: the SAME checkpoint key (ts/reason/code) re-attributed to
      // a NEWER attempt Y of the same identity/code - attempt X's record must
      // never authorize it (the record's persisted linkage is compared).
      const tsY = String(tailX.ts);
      appendTransition({
        stateDir: sd2, identityHash: s2.id, sessionPath: s2.sessionPath,
        record: {
          schemaVersion: CONTROL_LOOP_SCHEMA_VERSION, ts: tsY,
          from: 'PRE_REVIEWING', to: 'BLOCKED', reason: 'preReview:FAIL',
          evidence: {
            ok: false, code: 'CDP_SEND_TIMEOUT',
            detail: { attemptId: 'att-Y' }, // r5: compatible canonical (the Y-negative is the ATTEMPT link, not a submit veto)
          },
          identityHash: s2.id, sessionPath: s2.sessionPath,
        },
      });
      const beforeY = JSON.stringify(readTransitions({ stateDir: sd2, identityHash: s2.id }));
      const callsY = [];
      const resY = await runControlLoop({ sessionPath: s2.sessionPath, identityHash: s2.id, stateDir: sd2, deps: preReviewRetryDeps(callsY) });
      assert.equal(resY && resY.ok, false, JSON.stringify(resY));
      assert.equal(resY.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED', JSON.stringify(resY));
      assert.equal(resY.detail && resY.detail.reconcile && resY.detail.reconcile.reason, 'RECORD_CHECKPOINT_MISMATCH',
        'the gate surfaces the attempt-linkage mismatch of the checkpoint it rebuilt');
      assert.deepEqual(callsY, [], 'attempt X\'s record never authorizes attempt Y\'s checkpoint');
      assert.equal(JSON.stringify(readTransitions({ stateDir: sd2, identityHash: s2.id })), beforeY, 'ledger untouched');
    }
  });
});

// ---------------------------------------------------------------------------
// REC-01 r5 — the CANONICAL submit boundary VETOES PRE_SUBMIT reconciliation.
// The ledger failure evidence (not the marker, not a receipt) decides whether
// the submit pipeline had already started. A canonical failure that records
// stage SUBMIT_IN_FLIGHT, submitEvidence.submitted 'UNKNOWN'/true, phase
// SUBMIT/POST_SUBMIT or stage POST_SUBMIT_* is typed-blocked at the writer
// (no record), at the seal (no receipt), at the reader (no acceptance) and at
// the recovery gate (zero retry/submit) - a marker line claiming
// PRE_SUBMIT/NOT_SUBMITTED can NEVER launder that state. The gate keeps the
// original-round contract ('no automatic resend'). A canonical failure that
// merely LACKS submit-state metadata (legacy/thin detail) is distinguished
// from one that ASSERTS the submit started: lack of metadata is never a veto
// by itself (the attempt-linkage + record chain still decides), and legacy
// checkpoints without linkage keep failing closed for their linkage.
// ---------------------------------------------------------------------------
test('REC-01-r5. the canonical submit boundary vetoes PRE_SUBMIT reconciliation (a marker/receipt can never launder SUBMIT_IN_FLIGHT/UNKNOWN/POST_SUBMIT into NOT_SUBMITTED)', async () => {
  await withSessionAuthority(async ({ admit, pipePath }) => {
    const markerFor = (ID, attemptId) => `boundary fixture log v1\n${stageObservationLine({ identityHash: ID, attemptId })}\n`;
    const plantMarkerPerfectRecord = ({ sd, ID, cp, ev }) => {
      const dir = path.join(sd, 'control-loop', ID, 'pre-submit-boundary');
      fs.mkdirSync(dir, { recursive: true });
      const snap = JSON.parse(fs.readFileSync(path.join(path.dirname(authorityBindLockPath()), `owners-${createHash('sha256').update(pipePath).digest('hex')}.json`), 'utf8'));
      const entry = (snap.entries || []).find((x) => x && x.identityHash === ID);
      assert.ok(entry, 'daemon owner snapshot entry present');
      fs.writeFileSync(path.join(dir, `${boundaryKeyOf(cp)}.json`), `${JSON.stringify({
        schemaVersion: '1', kind: 'PRE_SUBMIT_BOUNDARY_RECONCILED', identityHash: ID,
        checkpoint: { ...cp }, source: 'test', basis: 'r5 canonical-submit-veto plant',
        authority: {
          kind: 'ADMISSION_FENCE', lane: entry.laneId, daemonEpoch: String(entry.daemonEpoch || 'copied-epoch'),
          generation: Number(entry.generation), connectionId: 999, pipePath, acquiredAt: new Date().toISOString(),
        },
        boundary: { observation: validBoundaryObservation(), decision: { action: 'PRE_SUBMIT_BOUNDARY_RECONCILED', decidedAt: new Date().toISOString() } },
        evidence: { path: ev, sha256: createHash('sha256').update(fs.readFileSync(ev)).digest('hex') },
        reconciledAt: new Date().toISOString(),
      }, null, 2)}\n`, 'utf8');
    };
    const gateBlocksZeroMutation = async ({ sd, sessionPath, ID, label }) => {
      const before = JSON.stringify(readTransitions({ stateDir: sd, identityHash: ID }));
      const calls = [];
      const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir: sd, deps: preReviewRetryDeps(calls) });
      assert.equal(res && res.ok, false, `${label}: ${JSON.stringify(res)}`);
      assert.equal(res.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED', label);
      assert.ok(/no automatic resend/.test(String(res.detail && res.detail.reason)), `${label}: the original-round no-resend contract holds`);
      assert.deepEqual(calls, [], `${label}: zero retry/submit adapters`);
      assert.equal(readReviewStoreCount(sd, ID), 0, `${label}: zero submit artifacts created`);
      assert.equal(JSON.stringify(readTransitions({ stateDir: sd, identityHash: ID })), before, `${label}: ledger untouched`);
      return res;
    };

    // ===== (N1) canonical stage SUBMIT_IN_FLIGHT + submitted UNKNOWN =====
    {
      const sd = mkStateDir();
      const { sessionPath, id: ID } = mkSession(sd, { issueNumber: 6921 });
      seedMutationOwner(sd, ID);
      await admit(sd, ID);
      preReviewAttemptLedger(sessionPath, sd, ID, {
        attemptId: 'att-n1',
        detail: { stage: 'SUBMIT_IN_FLIGHT', phase: 'SUBMIT', submitEvidence: { submitted: 'UNKNOWN' } },
      });
      const tail = readTransitions({ stateDir: sd, identityHash: ID }).at(-1);
      const cp = checkpointFromTail(tail);
      // the marker line and the caller claim BOTH say PRE_SUBMIT/NOT_SUBMITTED:
      // exactly the laundering attempt the veto must stop
      const ev = writeEvidenceFile(sd, markerFor(ID, 'att-n1'));
      const dir = path.join(sd, 'control-loop', ID, 'pre-submit-boundary');

      const w = recordPreSubmitBoundaryReconciled({
        stateDir: sd, identityHash: ID, checkpoint: cp,
        source: 'test', basis: 'r5 N1 writer veto', evidence: { path: ev },
        observation: validBoundaryObservation(),
      });
      assert.equal(w && w.ok, false, JSON.stringify(w));
      assert.equal(w.reason, 'BOUNDARY_CANONICAL_SUBMIT_VETO', JSON.stringify(w));
      assert.equal(w.detail && w.detail.reason, 'CANONICAL_SUBMIT_STARTED', JSON.stringify(w.detail));
      assert.equal(w.detail && w.detail.submitted, 'UNKNOWN', 'the canonical submitted state is surfaced, not erased');
      assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, 'N1: no record written');

      // seal + reader against a marker-perfect PLANTED record: still no
      // receipt, still not accepted (the marker cannot launder the state)
      plantMarkerPerfectRecord({ sd, ID, cp, ev });
      const seal = await ctrlApi.sealPreSubmitBoundaryReconciled({ stateDir: sd, identityHash: ID, checkpoint: cp });
      assert.equal(seal && seal.ok, false, JSON.stringify(seal));
      assert.equal(seal.code, 'BOUNDARY_CANONICAL_SUBMIT_VETO', JSON.stringify(seal));
      assert.equal(seal.detail && seal.detail.reason, 'CANONICAL_SUBMIT_STARTED', JSON.stringify(seal.detail));
      const rd = await ctrlApi.readPreSubmitBoundaryReconcile({ stateDir: sd, identityHash: ID, checkpoint: cp });
      assert.equal(rd && rd.ok, false, JSON.stringify(rd));
      assert.equal(rd.reason, 'RECORD_CANONICAL_SUBMIT_VETO', JSON.stringify(rd));
      assert.equal(rd.detail && rd.detail.reason, 'CANONICAL_SUBMIT_STARTED', JSON.stringify(rd.detail));

      // GATE: typed block, reconcile the original round - zero retry/submit
      const res = await gateBlocksZeroMutation({ sd, sessionPath, ID, label: 'N1 gate' });
      assert.equal(res.detail.reconcile && res.detail.reconcile.reason, 'CANONICAL_SUBMIT_VETO', JSON.stringify(res.detail.reconcile));
      assert.equal(res.detail.reconcile && res.detail.reconcile.detail && res.detail.reconcile.detail.reason, 'CANONICAL_SUBMIT_STARTED');
    }

    // ===== (N2) canonical POST_SUBMIT + submitted=true =====
    {
      const sd = mkStateDir();
      const { sessionPath, id: ID } = mkSession(sd, { issueNumber: 6922 });
      seedMutationOwner(sd, ID);
      await admit(sd, ID);
      preReviewAttemptLedger(sessionPath, sd, ID, {
        attemptId: 'att-n2',
        detail: { stage: 'POST_SUBMIT_TURN_WAIT', phase: 'POST_SUBMIT', submitEvidence: { submitted: true, reason: 'sent' } },
      });
      const tail = readTransitions({ stateDir: sd, identityHash: ID }).at(-1);
      const cp = checkpointFromTail(tail);
      const ev = writeEvidenceFile(sd, markerFor(ID, 'att-n2'));
      const dir = path.join(sd, 'control-loop', ID, 'pre-submit-boundary');

      const w = recordPreSubmitBoundaryReconciled({
        stateDir: sd, identityHash: ID, checkpoint: cp,
        source: 'test', basis: 'r5 N2 writer veto', evidence: { path: ev },
        observation: validBoundaryObservation(),
      });
      assert.equal(w && w.ok, false, JSON.stringify(w));
      assert.equal(w.reason, 'BOUNDARY_CANONICAL_SUBMIT_VETO', JSON.stringify(w));
      assert.equal(w.detail && w.detail.reason, 'CANONICAL_SUBMIT_STARTED');
      assert.equal(w.detail && w.detail.submitted, true, 'submitted=true is surfaced');
      assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, 'N2: no record written');

      const res = await gateBlocksZeroMutation({ sd, sessionPath, ID, label: 'N2 gate' });
      assert.equal(res.detail.reconcile && res.detail.reconcile.reason, 'CANONICAL_SUBMIT_VETO', JSON.stringify(res.detail.reconcile));
    }

    // ===== (N3) marker PRE_SUBMIT agrees with the claim, but the canonical
    // failure asserts submitted=true -> the marker NEVER wins =====
    {
      const sd = mkStateDir();
      const { sessionPath, id: ID } = mkSession(sd, { issueNumber: 6923 });
      seedMutationOwner(sd, ID);
      await admit(sd, ID);
      preReviewAttemptLedger(sessionPath, sd, ID, {
        attemptId: 'att-n3',
        // phase label still says PRE_SUBMIT, but the submit-state metadata
        // ASSERTS the submit already happened - that assertion decides
        detail: { stage: 'PRE_SUBMIT_SNAPSHOT', phase: 'PRE_SUBMIT', submitEvidence: { submitted: true, reason: 'sent' } },
      });
      const tail = readTransitions({ stateDir: sd, identityHash: ID }).at(-1);
      const cp = checkpointFromTail(tail);
      const ev = writeEvidenceFile(sd, markerFor(ID, 'att-n3'));
      const dir = path.join(sd, 'control-loop', ID, 'pre-submit-boundary');
      const w = recordPreSubmitBoundaryReconciled({
        stateDir: sd, identityHash: ID, checkpoint: cp,
        source: 'test', basis: 'r5 N3 marker-vs-canonical contradiction', evidence: { path: ev },
        observation: validBoundaryObservation(),
      });
      assert.equal(w && w.ok, false, JSON.stringify(w));
      assert.equal(w.reason, 'BOUNDARY_CANONICAL_SUBMIT_VETO', 'the canonical assertion beats the PRE_SUBMIT marker');
      assert.equal(w.detail && w.detail.reason, 'CANONICAL_SUBMIT_STARTED');
      assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, 'N3: no record written');

      // (N3b) DISTINCTION: metadata that explicitly says submitted=false is
      // compatible with PRE_SUBMIT - the same marker/claim then writes fine
      const sd2 = mkStateDir();
      const s2 = mkSession(sd2, { issueNumber: 6924 });
      seedMutationOwner(sd2, s2.id);
      await admit(sd2, s2.id);
      preReviewAttemptLedger(s2.sessionPath, sd2, s2.id, {
        attemptId: 'att-n3b',
        detail: { stage: 'PRE_SUBMIT_SNAPSHOT', phase: 'PRE_SUBMIT', submitEvidence: { submitted: false, reason: 'pre-submit' } },
      });
      const tailB = readTransitions({ stateDir: sd2, identityHash: s2.id }).at(-1);
      const okWrite = recordPreSubmitBoundaryReconciled({
        stateDir: sd2, identityHash: s2.id, checkpoint: checkpointFromTail(tailB),
        source: 'test', basis: 'r5 N3b compatible canonical', evidence: { path: writeEvidenceFile(sd2, markerFor(s2.id, 'att-n3b')) },
        observation: validBoundaryObservation(),
      });
      assert.equal(okWrite && okWrite.ok, true, `metadata explicitly submitted=false is NOT vetoed: ${JSON.stringify(okWrite)}`);
    }

    // ===== (P) POSITIVE: canonical really PRE_SUBMIT-compatible =====
    // (phase PRE_SUBMIT, no submit-started assertion) + proven marker -> the
    // canonical record chain authorizes exactly one bounded retry
    {
      const sd = mkStateDir();
      const { sessionPath, id: ID } = mkSession(sd, { issueNumber: 6925 });
      seedMutationOwner(sd, ID);
      await admit(sd, ID);
      preReviewAttemptLedger(sessionPath, sd, ID, {
        attemptId: 'att-p',
        detail: { stage: 'PRE_SUBMIT_SNAPSHOT', phase: 'PRE_SUBMIT' }, // compatible, structurally unproven
      });
      const tail = readTransitions({ stateDir: sd, identityHash: ID }).at(-1);
      const cp = checkpointFromTail(tail);
      const rec = recordPreSubmitBoundaryReconciled({
        stateDir: sd, identityHash: ID, checkpoint: cp,
        source: 'control-plane-admitted-reconciliation', basis: 'r5 positive canonical PRE_SUBMIT-compatible',
        evidence: { path: writeEvidenceFile(sd, markerFor(ID, 'att-p')) },
        observation: validBoundaryObservation(),
      });
      assert.equal(rec && rec.ok, true, JSON.stringify(rec));
      const seal = await ctrlApi.sealPreSubmitBoundaryReconciled({ stateDir: sd, identityHash: ID, checkpoint: cp, recordPath: rec.path });
      assert.equal(seal && seal.ok, true, JSON.stringify(seal));
      const before = JSON.stringify(readTransitions({ stateDir: sd, identityHash: ID }));
      const calls = [];
      const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir: sd, deps: preReviewRetryDeps(calls) });
      assert.equal(res && res.ok, true, JSON.stringify(res));
      assert.deepEqual(calls, ['preReview', 'finalReview'], 'a PRE_SUBMIT-compatible canonical failure reconciles and retries exactly once');
      const after = readTransitions({ stateDir: sd, identityHash: ID });
      assert.ok(after.length >= JSON.parse(before).length, 'the ledger stays append-only');
    }
  });
});

// ---------------------------------------------------------------------------
// REC-01 r6 — the CANONICAL submit veto also guards the DIRECT retry branch.
// preReviewPreSubmitProven (phase PRE_SUBMIT + submitted=false) used to skip
// the veto entirely: a canonical tail whose STAGE already asserts the submit
// started (SUBMIT_IN_FLIGHT / POST_SUBMIT_*) but whose phase/submit labels say
// PRE_SUBMIT/false would sail into the direct retry. The veto must run BEFORE
// every retry-permitting branch for a classified preReview failure.
// ---------------------------------------------------------------------------
test('REC-01-r6. the canonical submit veto guards the direct PRE_SUBMIT-proven retry branch (stage contradiction typed-blocks)', async () => {
  await withSessionAuthority(async ({ admit }) => {
    const runGateExpectBlock = async ({ sd, sessionPath, ID, label, detail }) => {
      seedMutationOwner(sd, ID);
      await admit(sd, ID);
      preReviewAttemptLedger(sessionPath, sd, ID, { attemptId: `att-${label}`, detail });
      const before = JSON.stringify(readTransitions({ stateDir: sd, identityHash: ID }));
      const calls = [];
      const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir: sd, deps: preReviewRetryDeps(calls) });
      assert.equal(res && res.ok, false, `${label}: ${JSON.stringify(res)}`);
      assert.equal(res.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED', `${label}: typed-block PRE_REVIEW_SUBMIT_UNRECONCILED`);
      assert.equal(res.detail && res.detail.reconcile && res.detail.reconcile.reason, 'CANONICAL_SUBMIT_VETO', `${label}: the veto reason is named`);
      assert.ok(/no automatic resend/.test(String(res.detail && res.detail.reason)), `${label}: original-round contract holds`);
      assert.deepEqual(calls, [], `${label}: zero retry/submit adapters`);
      assert.equal(readReviewStoreCount(sd, ID), 0, `${label}: no submit artifact`);
      assert.equal(JSON.stringify(readTransitions({ stateDir: sd, identityHash: ID })), before, `${label}: ledger untouched`);
      return res;
    };

    // (a) stage SUBMIT_IN_FLIGHT, yet phase PRE_SUBMIT + submitted=false
    {
      const sd = mkStateDir();
      const { sessionPath, id: ID } = mkSession(sd, { issueNumber: 6931 });
      await runGateExpectBlock({ sd, sessionPath, ID, label: 'r6a', detail: { stage: 'SUBMIT_IN_FLIGHT', phase: 'PRE_SUBMIT', submitEvidence: { submitted: false } } });
    }
    // (b) stage POST_SUBMIT_TURN_WAIT / POLL, yet phase PRE_SUBMIT + submitted=false
    for (const [i, stage] of ['POST_SUBMIT_TURN_WAIT', 'POLL'].entries()) {
      const sd = mkStateDir();
      const { sessionPath, id: ID } = mkSession(sd, { issueNumber: 6932 + i });
      await runGateExpectBlock({ sd, sessionPath, ID, label: `r6b${i}`, detail: { stage, phase: 'PRE_SUBMIT', submitEvidence: { submitted: false } } });
    }
    // (c) POSITIVE: a canonical failure that is REALLY pre-submit-shaped still
    // authorizes exactly one bounded retry through the record chain
    {
      const sd = mkStateDir();
      const { sessionPath, id: ID } = mkSession(sd, { issueNumber: 6934 });
      seedMutationOwner(sd, ID);
      await admit(sd, ID);
      preReviewAttemptLedger(sessionPath, sd, ID, {
        attemptId: 'att-r6c',
        detail: { stage: 'PRE_SUBMIT_SNAPSHOT', phase: 'PRE_SUBMIT', submitEvidence: { submitted: false, reason: 'pre-submit' } },
      });
      const tail = readTransitions({ stateDir: sd, identityHash: ID }).at(-1);
      const cp = checkpointFromTail(tail);
      const rec = recordPreSubmitBoundaryReconciled({
        stateDir: sd, identityHash: ID, checkpoint: cp,
        source: 'control-plane-admitted-reconciliation', basis: 'r6 positive PRE_SUBMIT-compatible with explicit submitted=false',
        evidence: { path: writeEvidenceFile(sd, `boundary fixture log v1\n${stageObservationLine({ identityHash: ID, attemptId: 'att-r6c' })}\n`) },
        observation: validBoundaryObservation(),
      });
      assert.equal(rec && rec.ok, true, JSON.stringify(rec));
      const seal = await ctrlApi.sealPreSubmitBoundaryReconciled({ stateDir: sd, identityHash: ID, checkpoint: cp, recordPath: rec.path });
      assert.equal(seal && seal.ok, true, JSON.stringify(seal));
      const calls = [];
      const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir: sd, deps: preReviewRetryDeps(calls) });
      assert.equal(res && res.ok, true, JSON.stringify(res));
      assert.deepEqual(calls, ['preReview', 'finalReview'], 'a compatible pre-submit canonical failure still retries exactly once');
    }
  });
});

// ---------------------------------------------------------------------------
// REC-01 r6 acceptance — stage × phase × submitted TRUTH TABLE.
// Expected values are written INDEPENDENTLY from the contract (not computed
// by the production helper): the table below IS the contract surface. The
// helper `canonicalSubmitVeto` and the REAL runControlLoop decision must
// agree with it row by row. Negative rows carry ZERO mutation: calls=[],
// ledger byte-identical, zero submit artifacts.
// ---------------------------------------------------------------------------
test('REC-01-r7. stage x phase x submitted truth table - helper and runControlLoop agree; veto/artifact/reconcile/direct-retry policy pinned', async () => {
  await withSessionAuthority(async ({ admit }) => {
    const VETO = 'VETO';           // canonicalSubmitVeto asserts started-submit
    const DIRECT = 'DIRECT';       // well-formed PRE_SUBMIT proof -> retry once
    const RECONCILE = 'RECONCILE'; // not proven, not vetoed -> fail-closed record/attempt chain

    // [stage, phase, submitted, expectedPolicy]
    const TABLE = [
      // positive: well-formed PRE_SUBMIT canonical failure
      ['PRE_SUBMIT_SNAPSHOT', 'PRE_SUBMIT', false, DIRECT],
      ['PRE_SUBMIT', 'PRE_SUBMIT', false, DIRECT],
      // missing metadata: NOT a NOT_SUBMITTED proof -> fail-closed reconcile chain
      ['PRE_SUBMIT_SNAPSHOT', 'PRE_SUBMIT', undefined, RECONCILE],
      ['PRE_SUBMIT_SNAPSHOT', undefined, false, RECONCILE],
      [undefined, 'PRE_SUBMIT', false, RECONCILE],
      // submitted asserts started
      ['PRE_SUBMIT_SNAPSHOT', 'PRE_SUBMIT', true, VETO],
      ['PRE_SUBMIT_SNAPSHOT', 'PRE_SUBMIT', 'UNKNOWN', VETO],
      ['PRE_SUBMIT_SNAPSHOT', 'PRE_SUBMIT', 'false', VETO],
      ['PRE_SUBMIT_SNAPSHOT', 'PRE_SUBMIT', 0, VETO],
      // phase asserts started
      ['PRE_SUBMIT_SNAPSHOT', 'SUBMIT', false, VETO],
      ['PRE_SUBMIT_SNAPSHOT', 'POST_SUBMIT', false, VETO],
      ['PRE_SUBMIT_SNAPSHOT', 'POST_SUBMIT_TURN_WAIT', false, VETO],
      // stage asserts started
      ['SUBMIT_IN_FLIGHT', 'PRE_SUBMIT', false, VETO],
      ['POST_SUBMIT_TURN_WAIT', 'PRE_SUBMIT', false, VETO],
      ['POST_SUBMIT_POLL', 'PRE_SUBMIT', false, VETO],
      ['POLL', 'PRE_SUBMIT', false, VETO],
      // foreign / mistyped stage: never a direct PRE_SUBMIT proof
      ['ACK', 'PRE_SUBMIT', false, RECONCILE],
      [123, 'PRE_SUBMIT', false, RECONCILE],
      ['PRE_SUBMITISH', 'PRE_SUBMIT', false, RECONCILE],
      ['pre_submit_snapshot', 'PRE_SUBMIT', false, RECONCILE],
      // mistyped phase: never a direct proof
      ['PRE_SUBMIT_SNAPSHOT', 236, false, RECONCILE],
    ];

    let n = 0;
    for (const [stage, phase, submitted, expected] of TABLE) {
      n += 1;
      const detail = { stage, phase, submitEvidence: { submitted } };
      // 1) helper agrees with the contract row
      const helper = canonicalSubmitVeto({ canonicalEvidence: { detail } });
      assert.equal(helper.veto, expected === VETO, `row ${n} helper: stage=${String(stage)} phase=${String(phase)} submitted=${String(submitted)} -> ${JSON.stringify(helper)}`);
      // 2) real runControlLoop decision agrees
      const sd = mkStateDir();
      const { sessionPath, id: ID } = mkSession(sd, { issueNumber: 7000 + n });
      seedMutationOwner(sd, ID);
      await admit(sd, ID);
      preReviewAttemptLedger(sessionPath, sd, ID, { attemptId: `att-tt-${n}`, detail });
      const before = JSON.stringify(readTransitions({ stateDir: sd, identityHash: ID }));
      const calls = [];
      const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir: sd, deps: preReviewRetryDeps(calls) });
      if (expected === VETO) {
        assert.equal(res && res.ok, false, `row ${n} VETO: ${JSON.stringify(res)}`);
        assert.equal(res.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED', `row ${n} code`);
        assert.equal(res.detail && res.detail.reconcile && res.detail.reconcile.reason, 'CANONICAL_SUBMIT_VETO', `row ${n} reconcile`);
        assert.deepEqual(calls, [], `row ${n} calls`);
      } else if (expected === RECONCILE) {
        assert.equal(res && res.ok, false, `row ${n} RECONCILE: ${JSON.stringify(res)}`);
        assert.equal(res.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED', `row ${n} code`);
        assert.notEqual(res.detail && res.detail.reconcile && res.detail.reconcile.reason, 'CANONICAL_SUBMIT_VETO', `row ${n} not the veto path`);
        assert.deepEqual(calls, [], `row ${n} calls`);
      } else {
        assert.equal(res && res.ok, true, `row ${n} DIRECT: ${JSON.stringify(res)}`);
        assert.deepEqual(calls, ['preReview', 'finalReview'], `row ${n} retries exactly once`);
      }
      assert.equal(readReviewStoreCount(sd, ID), 0, `row ${n}: zero NEW submit artifact from the stub adapter`);
      assert.equal(
        expected === DIRECT
          ? JSON.stringify(readTransitions({ stateDir: sd, identityHash: ID })).length >= before.length
          : JSON.stringify(readTransitions({ stateDir: sd, identityHash: ID })) === before,
        true,
        `row ${n} ledger ${expected === DIRECT ? 'append-only' : 'untouched'}`,
      );
    }

    // artifact veto dominates even a well-formed PRE_SUBMIT row: zero calls,
    // zero transition, PRE_REVIEW_SUBMIT_UNRECONCILED
    {
      const sd = mkStateDir();
      const { sessionPath, id: ID } = mkSession(sd, { issueNumber: 7021 });
      seedMutationOwner(sd, ID);
      await admit(sd, ID);
      preReviewAttemptLedger(sessionPath, sd, ID, { attemptId: 'att-tt-art', detail: { stage: 'PRE_SUBMIT_SNAPSHOT', phase: 'PRE_SUBMIT', submitEvidence: { submitted: false } } });
      const dir = path.join(sd, 'web2api-review-requests', ID);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'fixture-req.json'), '{}', 'utf8');
      const before = JSON.stringify(readTransitions({ stateDir: sd, identityHash: ID }));
      const calls = [];
      const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir: sd, deps: preReviewRetryDeps(calls) });
      assert.equal(res && res.ok, false, JSON.stringify(res));
      assert.equal(res.code, 'PRE_REVIEW_SUBMIT_UNRECONCILED');
      assert.deepEqual(calls, [], 'artifact veto: zero adapter calls');
      assert.equal(JSON.stringify(readTransitions({ stateDir: sd, identityHash: ID })), before, 'artifact veto: ledger untouched');
    }
  });
});

