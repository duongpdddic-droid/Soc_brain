#!/usr/bin/env node
// tests/control-loop-task-status.test.mjs — LOOP-01.
//
// Independent POLICY matrix for the per-task status board
// (packages/control-loop/task-status.mjs) plus its production wiring on the
// soc.get_progress surface. Every case builds a disposable fixture from the
// records the canonical producers already write — the board is never fed a
// hand-made "answer", only sessions/ledgers/ExecutionRecords/rework records/
// delivery ledgers/boundaries/progress projections shaped exactly like the
// real ones.
//
// Matrix rows covered (task LOOP-01 §5):
//   M1  new task, happy path (per checkpoint)
//   M2  findings -> rework -> CLEAN
//   M3  final-review REWORK -> repaired candidate -> review again -> PASS
//   M4  missing REQUIRED vs missing OPTIONAL
//   M5  UNKNOWN before side effect / UNKNOWN after side effect
//   M6  owner alive / owner dead / liveness unproven / no runner
//   M7  candidate drift / stale evidence
//   M8  rework budget exhausted / duplicate attempt
//   M9  resume read-back from every supported checkpoint
//   M10 read-only projection (byte-identical state dir) + no secret leakage
//   M11 production wiring on createClientControl().getProgress
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { identityHash } from '../packages/workspace/workspace.mjs';
import {
  deriveTaskStatus,
  renderTaskStatus,
  TASK_STEPS,
  NEXT_ACTIONS,
  ITEM_STATUSES,
  CHECKLIST_KINDS,
  TASK_STATUS_SCHEMA_VERSION,
} from '../packages/control-loop/task-status.mjs';
import { createClientControl } from '../packages/client-mcp/client-control.mjs';
import { buildReviewReadyFilename } from '../packages/review-ready/review-ready.mjs';

const REPO = 'duongpdddic-droid/soc_brain';
const ISSUE = 9000101;
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const BASE = 'f'.repeat(40);

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'loop01-status-')); }

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
    identityHash: id,
    repo,
    issueNumber,
    headSha: HEAD,
    baseSha: BASE,
    branch: 'task/loop-01-fixture',
    worktreePath: path.join(os.tmpdir(), 'loop01-wt', `issue-${issueNumber}`),
    worktreesRoot: path.join(os.tmpdir(), 'loop01-wt'),
    ...overrides,
  };
  fs.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  return { id, sessionPath, session };
}

const tx = (from, to, reason = null, evidence = null) => ({ from, to, reason, evidence });

function writeLedger(stateDir, id, rows) {
  const dir = path.join(stateDir, 'control-loop', id);
  fs.mkdirSync(dir, { recursive: true });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  const lines = rows.map((r, i) => JSON.stringify({
    schemaVersion: '1',
    ts: r.ts || new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    from: r.from, to: r.to,
    reason: r.reason ?? null,
    evidence: r.evidence ?? null,
    identityHash: id,
    sessionPath,
  }));
  fs.writeFileSync(path.join(dir, 'transitions.jsonl'), `${lines.join('\n')}\n`, 'utf8');
}

function writeExec(stateDir, id, o = {}) {
  const dir = path.join(stateDir, 'executions');
  fs.mkdirSync(dir, { recursive: true });
  const rec = {
    schemaVersion: '1',
    identityHash: id,
    repo: REPO,
    issueNumber: ISSUE,
    taskId: `${REPO}#${ISSUE}`,
    terminalStatus: 'EXITED',
    exitCode: 0,
    pid: 4242,
    processStartTime: '111222333',
    executor: 'opencode',
    model: 'mimo-free',
    instructionDigest: 'd'.repeat(64),
    headSha: HEAD,
    baseSha: BASE,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:05:00.000Z',
    ...o,
  };
  for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k];
  fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
  return rec;
}

function writeRework(stateDir, id, o = {}) {
  const dir = path.join(stateDir, 'control-loop', id, 'rework');
  fs.mkdirSync(dir, { recursive: true });
  const digest = o.digest || createHash('sha256').update(`${id}:${o.round ?? 1}`).digest('hex');
  const rec = {
    schemaVersion: '1',
    kind: 'REWORK',
    identityHash: id,
    round: o.round ?? 1,
    digest,
    persistedAt: '2026-01-01T00:06:00.000Z',
    binding: o.binding || { repository: REPO, issue: ISSUE, headSha: HEAD },
    findings: o.findings || ['fix the failing gate'],
    evidenceRequests: o.evidenceRequests || [],
    provenance: o.provenance || { source: 'pre-gate-internal-review' },
  };
  fs.writeFileSync(path.join(dir, `${digest}.json`), `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
  return rec;
}

function writeBoundary(stateDir, id, o = {}) {
  const dir = path.join(stateDir, 'control-loop', id, 'pre-submit-boundary');
  fs.mkdirSync(dir, { recursive: true });
  const rec = {
    schemaVersion: '1',
    kind: 'PRE_SUBMIT_BOUNDARY_RECONCILED',
    identityHash: id,
    checkpoint: { ts: '2026-01-01T00:07:00.000Z', reason: o.reason || 'finalReview:THREW', evidence: 'CDP_SEND_TIMEOUT' },
    source: 'offline-diagnosis',
    basis: 'fixture basis',
    reconciledAt: '2026-01-01T00:08:00.000Z',
    // PRODUCTION shape: recordPreSubmitBoundaryReconciled binds the proven
    // observation under record.boundary.observation (never top-level) — the
    // fixture must exercise the same nesting production writes.
    ...(o.stage ? { boundary: { observation: { stage: o.stage } } } : {}),
  };
  fs.writeFileSync(path.join(dir, 'fixture.json'), `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
  return rec;
}

function writeDelivery(stateDir, id, o = {}) {
  const dir = path.join(stateDir, 'control-loop', id);
  fs.mkdirSync(dir, { recursive: true });
  const rec = {
    schemaVersion: '1',
    kind: 'delivery-ledger',
    identityHash: id,
    spec: { repository: REPO, issue: ISSUE, headSha: o.headSha || HEAD, baseBranch: 'main' },
    pushed: { at: '2026-01-01T00:09:00.000Z' },
    ...(o.merged ? { merged: { at: '2026-01-01T00:10:00.000Z' } } : {}),
  };
  fs.writeFileSync(path.join(dir, 'delivery.json'), `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
  return rec;
}

// Canonical happy-path ledger up to (and including) the DECIDING boundary.
function happyLedger(finalVerdict = 'PASS') {
  return [
    tx('ACCEPTED', 'ROUTED', 'loop-bind', { boundAt: '2026-01-01T00:00:00.000Z' }),
    tx('ROUTED', 'EXECUTING', null, { executorKind: 'opencode', model: 'mimo-free' }),
    tx('EXECUTING', 'VERIFYING', null, { executionStatus: 'EXITED', terminalStatus: 'EXITED', executionRecordPath: 'exec.json' }),
    tx('VERIFYING', 'PRE_REVIEWING', null, { verdict: 'PASS', report: 'gate clean' }),
    tx('PRE_REVIEWING', 'FINAL_REVIEWING', null, { verdict: 'PASS', findings: [] }),
    tx('FINAL_REVIEWING', 'DECIDING', null, {
      verdict: finalVerdict, findings: [], evidenceRequests: [], confidence: 0.9,
      binding: { repository: REPO, issue: ISSUE, headSha: HEAD },
    }),
  ];
}

function derive(stateDir, id, deps = {}) {
  const r = deriveTaskStatus({ stateDir, identityHash: id, deps });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.status;
}

const findItem = (st, step, item) => st.checklist.find((c) => c.step === step && c.item === item);
const stepStatus = (st, step) => st.steps.find((s) => s.step === step).status;
const missingHas = (st, step, item) => st.missingRequired.some((m) => m.step === step && m.item === item);

// ---------------------------------------------------------------------------
// M1 — new task, happy path
// ---------------------------------------------------------------------------
test('M1a. new task: loop not bound yet -> CONTINUE_LOOP_NOT_BOUND, nothing falsely missing', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd);
  const st = derive(sd, id);
  assert.equal(st.schemaVersion, TASK_STATUS_SCHEMA_VERSION);
  assert.equal(st.taskId, `${REPO}#${ISSUE}`);
  assert.equal(st.identity.identityHash, id);
  assert.equal(st.checkpoint.ledgerLength, 0);
  assert.equal(st.checkpoint.known, true);
  assert.equal(st.checkpoint.step, 'ADMISSION');
  assert.equal(st.nextAction.action, 'CONTINUE_LOOP_NOT_BOUND');
  assert.equal(st.nextAction.reason, 'NO_LEDGER');
  assert.deepEqual(st.missingRequired, []);
  assert.ok(st.unknown.includes('ledger'));
  // No runner exists yet -> the board says so instead of claiming liveness.
  assert.equal(st.owner.category, 'NO_RUNNER');
});

test('M1b. happy path per checkpoint: every step DONE only with fields + valid result', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd, { prNumber: 4242 });
  writeExec(sd, id);
  writeLedger(sd, id, happyLedger('PASS').concat([
    tx('DECIDING', 'DELIVERING', null, { verdict: 'PASS', findings: [], evidenceRequests: [] }),
  ]));
  const st = derive(sd, id);

  for (const s of st.steps.slice(0, 8)) assert.equal(s.status, 'DONE', `${s.step} -> ${s.status}`);
  assert.equal(stepStatus(st, 'DELIVER'), 'IN_FLIGHT'); // Human Gate stop is NOT completion
  assert.deepEqual(st.missingRequired, []);
  assert.equal(st.nextAction.action, 'AWAIT_HUMAN_GATE'); // PASS -> stops at the Human Gate
  assert.equal(st.rework.rounds, 0);
  assert.equal(st.rework.remaining, 3);
  assert.equal(st.owner.category, 'RUNNER_FINISHED');
  assert.equal(st.candidate.drift.detected, false);
  assert.equal(st.candidate.boundHeadSha, HEAD);
  assert.equal(st.evidence.rows.find((r) => r.step === 'FINAL_REVIEW').result, 'PASS');
  assert.equal(st.currentStep.executor, null);
});

test('M1c. checklist is split REQUIRED / CONDITIONAL / OPTIONAL and DONE means valid result', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd, { prNumber: 7 });
  writeExec(sd, id);
  writeLedger(sd, id, happyLedger('PASS'));
  const st = derive(sd, id);

  const kinds = new Set(st.checklist.map((c) => c.kind));
  assert.deepEqual([...kinds].sort(), [...CHECKLIST_KINDS].sort());
  for (const c of st.checklist) assert.ok(ITEM_STATUSES.includes(c.status), c.status);
  // A DONE required item always carries its result back.
  const v = findItem(st, 'VERIFY', 'verify.result');
  assert.equal(v.status, 'DONE');
  assert.equal(v.result, 'PASS');
  // step DONE implies no REQUIRED/CONDITIONAL item of that step is MISSING.
  for (const s of st.steps.filter((x) => x.status === 'DONE')) {
    const items = st.checklist.filter((c) => c.step === s.step && c.kind !== 'OPTIONAL');
    assert.ok(items.every((c) => c.status === 'DONE' || c.status === 'NOT_APPLICABLE'),
      `${s.step} marked DONE with ${JSON.stringify(items.filter((c) => c.status !== 'DONE' && c.status !== 'NOT_APPLICABLE'))}`);
  }
});

// ---------------------------------------------------------------------------
// M2 — findings -> rework -> CLEAN (internal pre-gate review)
// ---------------------------------------------------------------------------
test('M2. internal-review findings -> VERIFYING->REWORK round -> repaired candidate is re-reviewed', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd, { prNumber: 99 });
  writeExec(sd, id);
  writeRework(sd, id, { round: 1, findings: ['internal finding #1'] });
  writeLedger(sd, id, [
    tx('ACCEPTED', 'ROUTED', 'loop-bind', { boundAt: '2026-01-01T00:00:00.000Z' }),
    tx('ROUTED', 'EXECUTING', null, { executorKind: 'opencode', model: 'mimo-free' }),
    tx('EXECUTING', 'VERIFYING', null, { executionStatus: 'EXITED', terminalStatus: 'EXITED' }),
    // internal pre-gate findings reroute: NO PRE_REVIEWING transition, no verdict
    tx('VERIFYING', 'REWORK', null, { sourceFrom: 'VERIFYING' }),
  ]);
  const st = derive(sd, id);

  assert.equal(st.checkpoint.state, 'REWORK');
  assert.equal(st.checkpoint.step, 'EXECUTE');
  assert.equal(st.checkpoint.round, 1);
  assert.equal(st.rework.rounds, 1);
  assert.equal(st.rework.remaining, 2);
  assert.deepEqual(st.missingRequired, []);
  assert.equal(stepStatus(st, 'ADMISSION'), 'DONE');
  assert.equal(stepStatus(st, 'ROUTE'), 'DONE');
  assert.equal(stepStatus(st, 'EXECUTE'), 'DONE');
  assert.equal(stepStatus(st, 'VERIFY'), 'NOT_DUE'); // review of the NEW candidate not run yet
  assert.equal(st.nextAction.action, 'CONTINUE');
  // findings travelled back to the executor through the persisted rework record
  const rw = st.candidate.bindings.find((b) => b.step === 'DECIDE');
  assert.equal(rw.binding.findingsCount, 1);
  assert.equal(rw.binding.headSha, HEAD);
});

test('M2b. CLEAN after the round: re-reviewed candidate passes and the loop reaches the gate', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd, { prNumber: 99 });
  writeExec(sd, id);
  writeRework(sd, id, { round: 1, findings: ['internal finding #1'] });
  writeLedger(sd, id, [
    tx('ACCEPTED', 'ROUTED', 'loop-bind', {}),
    tx('ROUTED', 'EXECUTING', null, { executorKind: 'opencode' }),
    tx('EXECUTING', 'VERIFYING', null, { executionStatus: 'EXITED', terminalStatus: 'EXITED' }),
    tx('VERIFYING', 'REWORK', null, { sourceFrom: 'VERIFYING' }),
    tx('REWORK', 'EXECUTING', null, { executorKind: 'opencode' }),
    tx('EXECUTING', 'VERIFYING', null, { executionStatus: 'EXITED', terminalStatus: 'EXITED' }),
    tx('VERIFYING', 'PRE_REVIEWING', null, { verdict: 'PASS', report: 'clean' }),
    tx('PRE_REVIEWING', 'FINAL_REVIEWING', null, { verdict: 'PASS', findings: [] }),
    tx('FINAL_REVIEWING', 'DECIDING', null, { verdict: 'PASS', findings: [], evidenceRequests: [], binding: { repository: REPO, issue: ISSUE, headSha: HEAD } }),
    tx('DECIDING', 'DELIVERING', null, { verdict: 'PASS', findings: [], evidenceRequests: [] }),
  ]);
  const st = derive(sd, id);
  assert.deepEqual(st.missingRequired, []);
  for (const s of st.steps.slice(0, 8)) assert.equal(s.status, 'DONE', s.step);
  assert.equal(st.rework.rounds, 1);
  assert.equal(st.nextAction.action, 'AWAIT_HUMAN_GATE');
});

// ---------------------------------------------------------------------------
// M3 — final review REWORK -> code -> review again -> PASS
// ---------------------------------------------------------------------------
test('M3. independent reviewer REWORK -> round -> repaired candidate re-reviewed -> PASS', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd, { prNumber: 5150 });
  writeExec(sd, id);
  writeRework(sd, id, {
    round: 1,
    findings: ['reviewer: missing test'],
    provenance: { source: 'gpt-final-review' },
  });
  writeLedger(sd, id, [
    ...happyLedger('REWORK'),
    tx('DECIDING', 'REWORK', null, {
      verdict: 'REWORK', findings: ['reviewer: missing test'], evidenceRequests: [],
      binding: { repository: REPO, issue: ISSUE, headSha: HEAD },
    }),
    tx('REWORK', 'EXECUTING', null, { executorKind: 'opencode' }),
    tx('EXECUTING', 'VERIFYING', null, { executionStatus: 'EXITED', terminalStatus: 'EXITED' }),
    tx('VERIFYING', 'PRE_REVIEWING', null, { verdict: 'PASS', report: 'clean' }),
    tx('PRE_REVIEWING', 'FINAL_REVIEWING', null, { verdict: 'PASS', findings: [] }),
    tx('FINAL_REVIEWING', 'DECIDING', null, { verdict: 'PASS', findings: [], evidenceRequests: [], binding: { repository: REPO, issue: ISSUE, headSha: HEAD } }),
    tx('DECIDING', 'DELIVERING', null, { verdict: 'PASS', findings: [], evidenceRequests: [] }),
  ]);
  const st = derive(sd, id);

  assert.equal(st.rework.rounds, 1);
  assert.equal(st.rework.remaining, 2);
  assert.equal(st.checkpoint.state, 'DELIVERING');
  assert.equal(st.nextAction.action, 'AWAIT_HUMAN_GATE');
  // The board is a SNAPSHOT: its FINAL_REVIEW binding is the CURRENT decision
  // (PASS). The burned round stays visible through the rework-round counters
  // and the persisted round-1 rework record binding — the full decision history
  // itself lives in the transition ledger.
  const fin = st.candidate.bindings.find((b) => b.step === 'FINAL_REVIEW');
  assert.equal(fin.binding.verdict, 'PASS');
  assert.equal(st.candidate.bindings.filter((b) => b.step === 'FINAL_REVIEW').length, 1);
  assert.equal(st.rework.rounds, 1, 'the earlier REWORK round must not be forgotten');
  const rwBinding = st.candidate.bindings.find((b) => b.step === 'DECIDE');
  assert.equal(rwBinding.binding.round, 1);
  assert.equal(rwBinding.binding.findingsCount, 1);
  assert.equal(findItem(st, 'DECIDE', 'rework.record').status, 'DONE');
  assert.equal(findItem(st, 'DECIDE', 'rework.record').result, 1);
  assert.equal(st.evidence.rows.find((r) => r.step === 'DECIDE').result, 'DELIVERING');
  // no checklist gap after the repaired round
  assert.deepEqual(st.missingRequired, []);
  for (const s of st.steps.slice(0, 8)) assert.equal(s.status, 'DONE', `${s.step} -> ${s.status}`);
});

test('M3b. REWORK decision must echo the reviewed candidate (conditional REQUIRED binding)', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd, { prNumber: 5150 });
  writeExec(sd, id);
  writeLedger(sd, id, [
    ...happyLedger('REWORK'),
  ]);
  const st = derive(sd, id);
  const binding = findItem(st, 'FINAL_REVIEW', 'decision.binding');
  assert.equal(binding.status, 'DONE'); // binding present and 40-hex
  assert.equal(binding.result, HEAD);
  // The decide outcome has not been emitted yet: it is still DUE, not a gap.
  assert.equal(stepStatus(st, 'DECIDE'), 'IN_FLIGHT');
  assert.equal(findItem(st, 'DECIDE', 'ledger.deciding_outcome').status, 'PENDING');
  // ...and the rework record is only required once a round is actually entered.
  assert.equal(findItem(st, 'DECIDE', 'rework.record').status, 'NOT_APPLICABLE');
  assert.deepEqual(st.missingRequired, []);
  assert.equal(st.nextAction.action, 'CONTINUE');
});

// ---------------------------------------------------------------------------
// M4 — missing REQUIRED vs missing OPTIONAL
// ---------------------------------------------------------------------------
test('M4. missing REQUIRED is reported; missing OPTIONAL never blocks', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd, { prNumber: 12 });
  writeExec(sd, id);
  // VERIFY step reached but its verdict evidence is absent (required field gap)
  writeLedger(sd, id, [
    tx('ACCEPTED', 'ROUTED', 'loop-bind', {}),
    tx('ROUTED', 'EXECUTING', null, { executorKind: 'opencode' }),
    tx('EXECUTING', 'VERIFYING', null, { executionStatus: 'EXITED', terminalStatus: 'EXITED' }),
    tx('VERIFYING', 'PRE_REVIEWING', null, { verdict: 'PASS', report: 'ok' }),
    tx('PRE_REVIEWING', 'FINAL_REVIEWING', null, { verdict: 'PASS', findings: [] }),
    // NOTE: no VERIFYING->PRE_REVIEWING record at all -> verify.result missing
  ].filter((r) => !(r.from === 'VERIFYING' && r.to === 'PRE_REVIEWING')));
  const st = derive(sd, id);

  assert.equal(missingHas(st, 'VERIFY', 'verify.result'), true);
  assert.equal(stepStatus(st, 'VERIFY'), 'GAP');
  assert.equal(st.nextAction.action, 'FILL_MISSING_REQUIRED');
  assert.ok(st.nextAction.reason.includes('VERIFY.verify.result'));
  // OPTIONAL: no progress projection -> ABSENT, never in missingRequired.
  const opt = findItem(st, 'ADMISSION', 'progress.telemetry');
  assert.equal(opt.status, 'ABSENT');
  assert.equal(missingHas(st, 'ADMISSION', 'progress.telemetry'), false);
  // OPTIONAL never makes a step GAP on its own.
  const admissionItems = st.checklist.filter((c) => c.step === 'ADMISSION');
  assert.ok(admissionItems.filter((c) => c.kind === 'OPTIONAL').every((c) => c.status !== 'MISSING'));
});

test('M4b. NOT_DUE is never reported as missing', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd);
  writeLedger(sd, id, [tx('ACCEPTED', 'ROUTED', 'loop-bind', {})]);
  const st = derive(sd, id);
  assert.equal(st.checkpoint.step, 'ROUTE');
  for (const s of st.steps.slice(2)) assert.equal(s.status, 'NOT_DUE', s.step);
  assert.deepEqual(st.missingRequired, []);
  const verifyItem = findItem(st, 'VERIFY', 'verify.result');
  assert.equal(verifyItem.status, 'NOT_DUE');
});

test('M4c. a REWORK round without its rework record = lost findings handoff -> FILL_MISSING_REQUIRED', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd, { prNumber: 44 });
  writeExec(sd, id);
  // Ledger entered a round (DECIDING->REWORK) but the rework record is absent:
  // the findings never travelled back to the executor.
  writeLedger(sd, id, [
    ...happyLedger('REWORK'),
    tx('DECIDING', 'REWORK', null, { verdict: 'REWORK', findings: ['reviewer: missing test'] }),
  ]);
  const st = derive(sd, id);
  assert.equal(st.rework.rounds, 1);
  assert.equal(st.checkpoint.step, 'EXECUTE'); // checkpoint moved back for round 2
  assert.equal(findItem(st, 'DECIDE', 'rework.record').status, 'MISSING');
  assert.equal(findItem(st, 'DECIDE', 'rework.record').result, '0/1');
  assert.equal(missingHas(st, 'DECIDE', 'rework.record'), true);
  assert.equal(st.nextAction.action, 'FILL_MISSING_REQUIRED');
  assert.ok(st.nextAction.reason.includes('DECIDE.rework.record'));
  // the same round WITH its record is clean
  const sd2 = mkStateDir();
  const { id: id2 } = mkSession(sd2, { prNumber: 44 });
  writeExec(sd2, id2);
  writeRework(sd2, id2, { round: 1, findings: ['reviewer: missing test'] });
  writeLedger(sd2, id2, [
    ...happyLedger('REWORK'),
    tx('DECIDING', 'REWORK', null, { verdict: 'REWORK', findings: ['reviewer: missing test'] }),
  ]);
  const st2 = derive(sd2, id2);
  assert.deepEqual(st2.missingRequired, []);
  assert.notEqual(st2.nextAction.action, 'FILL_MISSING_REQUIRED');
});

// ---------------------------------------------------------------------------
// M5 — UNKNOWN before / after a submit side effect
// ---------------------------------------------------------------------------
test('M5a. UNKNOWN stage after a claimed submit side effect -> typed refusal, never a blind re-submit', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd, { prNumber: 31 });
  writeExec(sd, id);
  writeBoundary(sd, id, { stage: 'UNKNOWN', reason: 'preReview:THREW' });
  writeLedger(sd, id, [
    ...happyLedger('PASS').slice(0, 4),
    tx('PRE_REVIEWING', 'BLOCKED', 'preReview:THREW', { ok: false, code: 'CDP_SEND_TIMEOUT' }),
  ].filter((r) => r.to !== 'PRE_REVIEWING'));
  const st = derive(sd, id);
  assert.equal(st.checkpoint.blocked, true);
  assert.equal(st.nextAction.action, 'RECONCILE_BEFORE_RESUBMIT');
  assert.equal(st.nextAction.reason, 'SUBMIT_STAGE_UNKNOWN');
});

test('M5b. IN_FLIGHT after the side effect -> typed refusal with the observed stage', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd, { prNumber: 31 });
  writeExec(sd, id);
  writeBoundary(sd, id, { stage: 'SUBMIT_IN_FLIGHT', reason: 'finalReview:THREW' });
  writeLedger(sd, id, [
    tx('ACCEPTED', 'ROUTED', 'loop-bind', {}),
    tx('ROUTED', 'EXECUTING', null, { executorKind: 'opencode' }),
    tx('EXECUTING', 'VERIFYING', null, { executionStatus: 'EXITED', terminalStatus: 'EXITED' }),
    tx('VERIFYING', 'PRE_REVIEWING', null, { verdict: 'PASS' }),
    tx('PRE_REVIEWING', 'FINAL_REVIEWING', null, { verdict: 'PASS', findings: [] }),
    tx('FINAL_REVIEWING', 'BLOCKED', 'finalReview:THREW', { ok: false, code: 'CDP_SEND_TIMEOUT' }),
  ]);
  const st = derive(sd, id);
  assert.equal(st.nextAction.action, 'RECONCILE_BEFORE_RESUBMIT');
  assert.equal(st.nextAction.reason, 'SUBMIT_STAGE_SUBMIT_IN_FLIGHT');
  assert.ok(st.unknown.includes('submitBoundary.stage') === false);
});

test('M5c. proven NOT_SUBMITTED (side effect proven absent) -> falls back to the ordinary tail read-back', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd, { prNumber: 31 });
  writeExec(sd, id);
  writeBoundary(sd, id, { stage: 'NOT_SUBMITTED', reason: 'preReview:THREW' });
  writeLedger(sd, id, [
    tx('ACCEPTED', 'ROUTED', 'loop-bind', {}),
    tx('ROUTED', 'EXECUTING', null, { executorKind: 'opencode' }),
    tx('EXECUTING', 'VERIFYING', null, { executionStatus: 'EXITED', terminalStatus: 'EXITED' }),
    tx('VERIFYING', 'PRE_REVIEWING', null, { verdict: 'PASS' }),
    tx('PRE_REVIEWING', 'BLOCKED', 'preReview:THREW', { ok: false, code: 'CDP_SEND_TIMEOUT' }),
  ]);
  const st = derive(sd, id);
  assert.equal(st.nextAction.action, 'READ_BACK_BLOCKED_TAIL');
  assert.equal(st.nextAction.reason, 'preReview:THREW');
});

test('M5d. no boundary record at all and no blocked tail -> no submit refusal is invented', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd, { prNumber: 31 });
  writeExec(sd, id);
  writeLedger(sd, id, happyLedger('PASS'));
  const st = derive(sd, id);
  assert.equal(st.submitBoundary, null);
  assert.notEqual(st.nextAction.action, 'RECONCILE_BEFORE_RESUBMIT');
});

// ---------------------------------------------------------------------------
// M6 — owner alive / dead / unproven / no runner
// ---------------------------------------------------------------------------
const aliveDeps = { isAlive: () => true, readStartTime: () => ({ processStartTime: '111222333' }) };
const unknownDeps = { isAlive: () => true, readStartTime: () => null };
const goneDeps = { isAlive: () => false, readStartTime: () => null };

test('M6a. proven-alive runner at EXECUTE -> ATTACH_OBSERVE (never a second executor)', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd);
  writeExec(sd, id, { terminalStatus: undefined, exitCode: undefined, finishedAt: undefined });
  writeLedger(sd, id, [
    tx('ACCEPTED', 'ROUTED', 'loop-bind', {}),
    tx('ROUTED', 'EXECUTING', null, { executorKind: 'opencode' }),
  ]);
  const st = derive(sd, id, aliveDeps);
  assert.equal(st.owner.category, 'ALIVE');
  assert.equal(st.owner.identityProven, true);
  assert.equal(st.nextAction.action, 'ATTACH_OBSERVE');
});

test('M6b. liveness UNPROVEN -> RECONCILE_LIVENESS before any resume', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd);
  writeExec(sd, id, { terminalStatus: undefined, exitCode: undefined, finishedAt: undefined });
  writeLedger(sd, id, [
    tx('ACCEPTED', 'ROUTED', 'loop-bind', {}),
    tx('ROUTED', 'EXECUTING', null, { executorKind: 'opencode' }),
  ]);
  const st = derive(sd, id, unknownDeps);
  assert.equal(st.owner.category, 'UNPROVEN');
  assert.equal(st.nextAction.action, 'RECONCILE_LIVENESS');
  assert.ok(st.unknown.includes('owner.liveness'));
});

test('M6c. proven-dead runner mid-EXECUTE -> REAP_DEAD_RUNNER (canonical reaper seam)', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd);
  writeExec(sd, id, { terminalStatus: undefined, exitCode: undefined, finishedAt: undefined });
  writeLedger(sd, id, [
    tx('ACCEPTED', 'ROUTED', 'loop-bind', {}),
    tx('ROUTED', 'EXECUTING', null, { executorKind: 'opencode' }),
  ]);
  const st = derive(sd, id, goneDeps);
  assert.equal(st.owner.category, 'DEAD');
  assert.equal(st.nextAction.action, 'REAP_DEAD_RUNNER');
});

test('M6d. duplicate attempt: a live runner already exists before ROUTE -> reconcile, never dispatch twice', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd);
  writeExec(sd, id, { terminalStatus: undefined, exitCode: undefined, finishedAt: undefined });
  writeLedger(sd, id, [tx('ACCEPTED', 'ROUTED', 'loop-bind', {})]);
  const st = derive(sd, id, aliveDeps);
  assert.equal(st.checkpoint.step, 'ROUTE');
  assert.equal(st.owner.category, 'ALIVE');
  assert.equal(st.nextAction.action, 'RECONCILE_EXISTING_ATTEMPT');
});

test('M6e. no runner record yet at ROUTE -> CONTINUE (nothing to reconcile)', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd);
  writeLedger(sd, id, [tx('ACCEPTED', 'ROUTED', 'loop-bind', {})]);
  const st = derive(sd, id, aliveDeps);
  assert.equal(st.owner.category, 'NO_RUNNER');
  assert.equal(st.nextAction.action, 'CONTINUE');
  assert.ok(st.unknown.includes('execution'));
});

test('M6f. finished runner never claims a live owner', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd);
  writeExec(sd, id); // terminalStatus EXITED
  writeLedger(sd, id, [
    tx('ACCEPTED', 'ROUTED', 'loop-bind', {}),
    tx('ROUTED', 'EXECUTING', null, { executorKind: 'opencode' }),
  ]);
  const st = derive(sd, id, aliveDeps);
  assert.equal(st.owner.category, 'RUNNER_FINISHED');
  assert.equal(st.nextAction.action, 'CONTINUE');
});

// ---------------------------------------------------------------------------
// M7 — candidate drift / stale evidence
// ---------------------------------------------------------------------------
test('M7. review binding on a different candidate -> REVIEW_CANDIDATE_AGAIN before any gate', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd, { prNumber: 88, headSha: HEAD });
  writeExec(sd, id);
  writeLedger(sd, id, [
    tx('ACCEPTED', 'ROUTED', 'loop-bind', {}),
    tx('ROUTED', 'EXECUTING', null, { executorKind: 'opencode' }),
    tx('EXECUTING', 'VERIFYING', null, { executionStatus: 'EXITED', terminalStatus: 'EXITED' }),
    tx('VERIFYING', 'PRE_REVIEWING', null, { verdict: 'PASS' }),
    tx('PRE_REVIEWING', 'FINAL_REVIEWING', null, { verdict: 'PASS', findings: [] }),
    tx('FINAL_REVIEWING', 'DECIDING', null, {
      verdict: 'PASS', findings: [], evidenceRequests: [],
      binding: { repository: REPO, issue: ISSUE, headSha: OTHER_HEAD },
    }),
  ]);
  const st = derive(sd, id);
  assert.equal(st.candidate.drift.detected, true);
  assert.equal(st.candidate.drift.expected, HEAD);
  assert.equal(st.candidate.drift.actual, OTHER_HEAD);
  assert.equal(st.nextAction.action, 'REVIEW_CANDIDATE_AGAIN');
  assert.equal(st.nextAction.reason, 'CANDIDATE_DRIFT');
});

test('M7b. matching binding -> no drift, gate may proceed', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd, { prNumber: 88 });
  writeExec(sd, id);
  writeLedger(sd, id, happyLedger('PASS'));
  const st = derive(sd, id);
  assert.equal(st.candidate.drift.detected, false);
  assert.notEqual(st.nextAction.action, 'REVIEW_CANDIDATE_AGAIN');
});

// ---------------------------------------------------------------------------
// M8 — budget exhausted / duplicate attempt already covered in M6d
// ---------------------------------------------------------------------------
test('M8. rework budget exhausted -> BLOCKED_BUDGET_EXHAUSTED, never a blind re-dispatch', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd, { prNumber: 64 });
  writeExec(sd, id);
  writeLedger(sd, id, [
    tx('ACCEPTED', 'ROUTED', 'loop-bind', {}),
    tx('ROUTED', 'EXECUTING', null, { executorKind: 'opencode' }),
    tx('EXECUTING', 'VERIFYING', null, { executionStatus: 'EXITED', terminalStatus: 'EXITED' }),
    tx('VERIFYING', 'REWORK', null, { sourceFrom: 'VERIFYING' }),
    tx('REWORK', 'EXECUTING', null, { executorKind: 'opencode' }),
    tx('EXECUTING', 'VERIFYING', null, { executionStatus: 'EXITED', terminalStatus: 'EXITED' }),
    tx('VERIFYING', 'REWORK', null, { sourceFrom: 'VERIFYING' }),
    tx('REWORK', 'EXECUTING', null, { executorKind: 'opencode' }),
    tx('EXECUTING', 'VERIFYING', null, { executionStatus: 'EXITED', terminalStatus: 'EXITED' }),
    tx('VERIFYING', 'REWORK', null, { sourceFrom: 'VERIFYING' }),
  ]);
  const st = derive(sd, id);
  assert.equal(st.rework.rounds, 3);
  assert.equal(st.rework.remaining, 0);
  assert.equal(st.nextAction.action, 'BLOCKED_BUDGET_EXHAUSTED');
  assert.equal(st.nextAction.reason, 'ROUNDS_3_OF_3');
});

test('M8b. terminal BLOCKED session -> INSPECT_BLOCKED_EVIDENCE (read back, never re-block blindly)', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd, { state: 'BLOCKED' });
  writeExec(sd, id);
  writeLedger(sd, id, [
    tx('ACCEPTED', 'ROUTED', 'loop-bind', {}),
    tx('ROUTED', 'EXECUTING', null, { executorKind: 'opencode' }),
    tx('EXECUTING', 'BLOCKED', 'execute:FAIL', { ok: false, code: 'EXECUTION_FAILED' }),
  ]);
  const st = derive(sd, id);
  assert.equal(st.nextAction.action, 'INSPECT_BLOCKED_EVIDENCE');
  assert.equal(st.nextAction.reason, 'execute:FAIL');
});

test('M8c. Human Gate session states -> AWAIT_HUMAN_GATE', () => {
  for (const gate of ['HUMAN_GATE_REQUIRED', 'WAITING_FOR_INPUT']) {
    const sd = mkStateDir();
    const { id } = mkSession(sd, { state: gate });
    writeLedger(sd, id, happyLedger('PASS').concat([tx('DECIDING', 'DELIVERING', null, { verdict: 'PASS' })]));
    const st = derive(sd, id);
    assert.equal(st.nextAction.action, 'AWAIT_HUMAN_GATE', gate);
  }
});

test('M8d. terminal COMPLETED with an incomplete ledger still shows the gap (no green-washing)', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd, { state: 'COMPLETED', prNumber: 3 });
  writeExec(sd, id);
  writeLedger(sd, id, [
    tx('ACCEPTED', 'ROUTED', 'loop-bind', {}),
    tx('ROUTED', 'EXECUTING', null, { executorKind: 'opencode' }),
    tx('EXECUTING', 'VERIFYING', null, { executionStatus: 'EXITED', terminalStatus: 'EXITED' }),
  ]);
  const st = derive(sd, id);
  assert.equal(st.nextAction.action, 'NONE_TERMINAL');
  assert.equal(stepStatus(st, 'VERIFY'), 'GAP');
  assert.ok(st.missingRequired.some((m) => m.item === 'verify.result'));
});

// ---------------------------------------------------------------------------
// M9 — resume read-back from every supported checkpoint
// ---------------------------------------------------------------------------
test('M9. every supported checkpoint reads back a known step and a non-fabricated action', () => {
  const cases = [
    { rows: [tx('ACCEPTED', 'ROUTED', 'loop-bind', {})], step: 'ROUTE' },
    { rows: [tx('ACCEPTED', 'ROUTED', 'loop-bind', {}), tx('ROUTED', 'EXECUTING', null, { executorKind: 'opencode' })], step: 'EXECUTE' },
    { rows: [tx('ACCEPTED', 'ROUTED', 'loop-bind', {}), tx('ROUTED', 'EXECUTING', null, { executorKind: 'opencode' }), tx('EXECUTING', 'VERIFYING', null, { executionStatus: 'EXITED', terminalStatus: 'EXITED' })], step: 'PUBLISH' },
    { rows: happyLedger('PASS').slice(0, 4), step: 'PRE_REVIEW' },
    { rows: happyLedger('PASS').slice(0, 5), step: 'FINAL_REVIEW' },
    { rows: happyLedger('PASS'), step: 'DECIDE' },
    { rows: happyLedger('PASS').concat([tx('DECIDING', 'DELIVERING', null, { verdict: 'PASS' })]), step: 'DELIVER' },
    { rows: [tx('ACCEPTED', 'ROUTED', 'loop-bind', {}), tx('ROUTED', 'EXECUTING', null, {}), tx('EXECUTING', 'BLOCKED', 'execute:FAIL', { ok: false, code: 'X' })], step: 'EXECUTE' },
    { rows: [tx('ACCEPTED', 'ROUTED', 'loop-bind', {}), tx('ROUTED', 'EXECUTING', null, {}), tx('EXECUTING', 'VERIFYING', null, {}), tx('VERIFYING', 'BLOCKED', 'verify:FAIL', { ok: false, code: 'X' })], step: 'VERIFY' },
    { rows: [tx('ACCEPTED', 'ROUTED', 'loop-bind', {}), tx('ROUTED', 'EXECUTING', null, {}), tx('EXECUTING', 'VERIFYING', null, {}), tx('VERIFYING', 'PRE_REVIEWING', null, {}), tx('PRE_REVIEWING', 'BLOCKED', 'preReview:FAIL', { ok: false, code: 'X' })], step: 'PRE_REVIEW' },
    { rows: happyLedger('PASS').concat([tx('FINAL_REVIEWING', 'BLOCKED', 'finalReview:FAIL:X', { ok: false, code: 'X' })]), step: 'FINAL_REVIEW' },
  ];
  for (const c of cases) {
    const sd = mkStateDir();
    const { id } = mkSession(sd, { prNumber: 5 });
    writeExec(sd, id);
    writeLedger(sd, id, c.rows);
    const st = derive(sd, id, aliveDeps);
    assert.equal(st.checkpoint.known, true, JSON.stringify(c.step));
    assert.equal(st.checkpoint.step, c.step, JSON.stringify(c.rows.map((r) => `${r.from}->${r.to}`)));
    assert.ok(NEXT_ACTIONS.includes(st.nextAction.action), st.nextAction.action);
    assert.notEqual(st.nextAction.action, 'READ_BACK_SESSION');
    // A recoverable blocked tail is read back, never answered by a new block.
    if (st.checkpoint.blocked) {
      assert.ok(['READ_BACK_BLOCKED_TAIL', 'RECONCILE_BEFORE_RESUBMIT', 'REAP_DEAD_RUNNER', 'RECONCILE_LIVENESS'].includes(st.nextAction.action),
        st.nextAction.action);
    }
    assert.equal(typeof st.nextAction.reason, 'string');
  }
});

test('M9b. missing canonical session -> READ_BACK_SESSION, board still well-formed', () => {
  const sd = mkStateDir();
  const id = identityHash({ repo: REPO, issueNumber: ISSUE });
  const r = deriveTaskStatus({ stateDir: sd, identityHash: id });
  assert.equal(r.ok, true);
  assert.equal(r.status.nextAction.action, 'READ_BACK_SESSION');
  assert.deepEqual(r.status.missingRequired, []);
  assert.equal(r.status.taskId, null);
  assert.equal(renderTaskStatus(r.status).includes('READ_BACK_SESSION'), true);
});

test('M9c. malformed request fails closed', () => {
  const r = deriveTaskStatus({ stateDir: '' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'STATUS_MALFORMED_REQUEST');
});

// ---------------------------------------------------------------------------
// M10 — read-only projection + no secret leakage
// ---------------------------------------------------------------------------
function hashTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p)}=${createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`);
    }
  };
  walk(dir);
  return out.join('\n');
}

test('M10a. deriveTaskStatus NEVER writes a byte to the state dir', () => {
  const sd = mkStateDir();
  const { id, session } = mkSession(sd, { prNumber: 21 });
  writeExec(sd, id);
  writeRework(sd, id, { round: 1 });
  writeDelivery(sd, id);
  writeBoundary(sd, id, { stage: 'POST_SUBMIT' });
  writeLedger(sd, id, happyLedger('PASS').concat([tx('DECIDING', 'DELIVERING', null, { verdict: 'PASS' })]));
  // also a progress projection (written by its OWN producer, not by us)
  fs.mkdirSync(path.join(sd, 'task-progress'), { recursive: true });
  fs.writeFileSync(path.join(sd, 'task-progress', `${id}.json`), JSON.stringify({ schemaVersion: '1', identityHash: id, currentStep: 3, totalSteps: 5, steps: [] }), 'utf8');

  const before = hashTree(sd);
  for (let i = 0; i < 3; i++) {
    const st = derive(sd, id, aliveDeps);
    assert.ok(st.checkpoint.step);
    renderTaskStatus(st);
  }
  const after = hashTree(sd);
  assert.equal(after, before, 'the projection mutated the state dir');
  assert.ok(before.includes(path.join('sessions', `${id}.json`).replace(/\\/g, '/')) || before.includes(`sessions/${id}.json`) || before.includes(id));
  assert.ok(session.identityHash === id);
});

test('M10b. the board leaks no lease token, no absolute path and no secret', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd, { prNumber: 21, lease: { token: 'c0ffee'.repeat(20), issuedAt: 'now' } });
  writeExec(sd, id);
  writeLedger(sd, id, happyLedger('PASS'));
  const st = derive(sd, id);
  const json = JSON.stringify(st);
  assert.equal(json.includes('c0ffee'), false, 'lease token leaked');
  assert.equal(json.includes('lease'), false, 'lease field leaked');
  assert.equal(json.includes(sd.replace(/\\/g, '\\\\')), false, 'state dir path leaked');
  assert.equal(json.includes(id ? sd : 'x'), false);
  assert.equal(/"worktreePath"/.test(json), false, 'worktree path leaked');
  // No absolute Windows/POSIX path anywhere in the projection.
  assert.equal(/[A-Za-z]:\\\\/.test(json), false, 'absolute path leaked');
});

// ---------------------------------------------------------------------------
// M11 — production wiring on soc.get_progress
// ---------------------------------------------------------------------------
test('M11. createClientControl().getProgress carries the production status board', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd, { prNumber: 4242 });
  writeExec(sd, id);
  writeLedger(sd, id, happyLedger('PASS').concat([tx('DECIDING', 'DELIVERING', null, { verdict: 'PASS' })]));

  const ctl = createClientControl({ stateDir: sd, worktreesRoot: path.join(os.tmpdir(), 'loop01-wt'), controlLane: null });
  const out = ctl.getProgress({ repo: REPO, issueNumber: ISSUE });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.identityHash, id);
  // pre-existing canonical fields are untouched
  assert.equal(out.state, 'SESSION_ACTIVE');
  assert.equal(out.loop.currentStep, 'DELIVERING');
  assert.ok(Array.isArray(out.loop.history));
  // the new table rides along
  assert.ok(out.status, 'status board missing from the production surface');
  assert.equal(out.status.identity.identityHash, id);
  assert.equal(out.status.checkpoint.step, 'DELIVER');
  assert.equal(out.status.nextAction.action, 'AWAIT_HUMAN_GATE');
  assert.ok(out.status.checklist.length > 10);
  assert.deepEqual(out.status.missingRequired, []);
  assert.equal(out.status.currentStep.loop, 'DELIVER');
});

test('M11b. a projection failure never breaks the production getProgress surface', () => {
  const sd = mkStateDir();
  const { id } = mkSession(sd);
  writeLedger(sd, id, [tx('ACCEPTED', 'ROUTED', 'loop-bind', {})]);
  const ctl = createClientControl({ stateDir: sd, worktreesRoot: path.join(os.tmpdir(), 'loop01-wt'), controlLane: null });
  const out = ctl.getProgress({ repo: REPO, issueNumber: ISSUE });
  assert.equal(out.ok, true);
  assert.equal(out.loop.currentStep, 'ROUTED');
  assert.ok(out.status);
  assert.equal(out.status.checkpoint.step, 'ROUTE');
});

// ---------------------------------------------------------------------------
// M12 - review-ready packet projection (regression for the OCR round-1 F1:
// the packet filename never contains the identityHash, so identity-based
// matching reported ABSENT forever)
// ---------------------------------------------------------------------------
test('M12. publish.reviewPacket is DONE only for the exact review-ready packet of THIS candidate', () => {
  const packetItem = (st) => st.checklist.find((c) => c.item === 'publish.reviewPacket');
  const mkFulfilled = (prNumber) => {
    const sd = mkStateDir();
    const { id } = mkSession(sd, { prNumber });
    writeExec(sd, id);
    writeLedger(sd, id, happyLedger('PASS'));
    const dir = path.join(sd, 'review-ready');
    fs.mkdirSync(dir, { recursive: true });
    return { sd, id, dir };
  };

  // 1) no packet at all -> ABSENT (OPTIONAL never becomes MISSING)
  const a = mkFulfilled(7);
  assert.equal(packetItem(derive(a.sd, a.id)).status, 'ABSENT');

  // 2) the EXACT canonical filename of this candidate (repo+issue+pr+head) -> DONE
  const exact = buildReviewReadyFilename({ repo: REPO, issue: ISSUE, pr: 7, headSha: HEAD });
  assert.ok(exact, 'canonical review-ready filename must be buildable');
  fs.writeFileSync(path.join(a.dir, exact), '# packet\n', 'utf8');
  assert.equal(packetItem(derive(a.sd, a.id)).status, 'DONE');

  // 3) a packet of ANOTHER head or ANOTHER PR of the same task is NOT this
  //    candidate's packet -> stays ABSENT
  const b = mkFulfilled(7);
  fs.writeFileSync(path.join(b.dir, buildReviewReadyFilename({ repo: REPO, issue: ISSUE, pr: 7, headSha: OTHER_HEAD })), '# stale head\n', 'utf8');
  assert.equal(packetItem(derive(b.sd, b.id)).status, 'ABSENT');
  fs.writeFileSync(path.join(b.dir, buildReviewReadyFilename({ repo: REPO, issue: ISSUE, pr: 8, headSha: HEAD })), '# other pr\n', 'utf8');
  assert.equal(packetItem(derive(b.sd, b.id)).status, 'ABSENT');
});
