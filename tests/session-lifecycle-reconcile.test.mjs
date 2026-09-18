#!/usr/bin/env node
// tests/session-lifecycle-reconcile.test.mjs — Issue #9000005.
//
// The stale SESSION_ACTIVE lifecycle-residue matrix. It proves the canonical
// ACTIVE-TASK INVARIANT (recovery discovery only attaches to genuinely active
// tasks) and the single reconcile maintenance path (classify ACTIVE/STALE_
// RECONCILABLE/PARKED/TERMINAL/UNKNOWN; dry-run by default; mutate only the
// positively-proven stale sessions through the ownership-safe park seam;
// idempotent; never terminalize UNKNOWN; never touch a live executor, a Human
// Gate, a foreign repo, or release a mutationOwner).
//
// Every scenario drives the SAME production primitives recovery.mjs /
// executor-recovery.mjs / parkStaleSession use; liveness is injected
// deterministically (never a real OS pid), and canonical state is seeded through
// the fail-closed reader's expected locations (readSessionRecord re-derives
// identity, so a mis-located record would be rejected — proving the fixture is
// canonical, not hand-waved).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { identityHash } from '../packages/workspace/workspace.mjs';
import { readSessionRecord, sessionPathFor, parkStaleSession } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { EXECUTION_SCHEMA_VERSION, readExecutionRecord } from '../packages/executor-launcher/executor-launcher.mjs';
import { canonicalTaskActivityVerdict, reconcileExecutorLiveness } from '../packages/executor-launcher/executor-reconcile.mjs';
import { reconcileStaleSessions } from '../packages/executor-launcher/executor-recovery.mjs';
import { enumerateActiveTasks, resolveRecoveryTarget } from '../packages/client-mcp/recovery.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-reconcile-'));
const REPO = 'duongpdddic-droid/soc_brain';
const LIVE_PID = 987654;
const LIVE_PST = 134000000000000000;

// Deterministic liveness: only LIVE_PID is alive, and it reports LIVE_PST.
const DEPS = { isAlive: (pid) => pid === LIVE_PID, readStartTime: () => ({ processStartTime: LIVE_PST }) };
const DEAD = { isAlive: () => false, readStartTime: () => ({ processStartTime: LIVE_PST }) };
const UNPROVEN = { isAlive: (pid) => pid === LIVE_PID, readStartTime: () => null }; // live pid, probe fails

function sessionsDir(S) { return path.join(S, 'sessions'); }

// Seed a canonical session at its identity-derived location.
function mkSession(S, { repo = REPO, issue, state = 'SESSION_ACTIVE', executionMode, owner = null, humanGate = null }) {
  const h = identityHash({ repo, issueNumber: issue });
  const p = sessionPathFor({ stateDir: S, identityHash: h });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const session = {
    schemaVersion: '1', state, taskId: `${repo}#${issue}`, identityHash: h, repo, issueNumber: issue,
    baseSha: 'a'.repeat(40), branch: `agent/${h}`, headSha: 'b'.repeat(40),
    worktreePath: path.join(S, 'wt', h), worktreesRoot: path.join(S, 'wt'),
    lease: { token: 'tok-' + issue, issuedAt: '2026-09-01T00:00:00.000Z' },
    capabilities: [], adapter: { id: 'runtime-sandbox', version: '1' },
    controlPlane: { stateDir: S, sessionPath: p }, lifecycle: [{ event: 'SESSION_ACTIVE', at: '2026-09-01T00:00:00.000Z', detail: null }],
  };
  if (executionMode !== undefined) session.executionMode = executionMode;
  if (owner) session.mutationOwner = { laneId: owner, since: '2026-09-01T00:00:00.000Z', acquiredVia: 'ADMISSION', history: [] };
  if (humanGate) session.humanGate = humanGate;
  fs.writeFileSync(p, JSON.stringify(session, null, 2) + '\n', 'utf8');
  return { h, p };
}

// Seed a canonical ExecutionRecord (or none when exec is omitted).
function mkExecution(S, { repo = REPO, issue, h }, exec) {
  if (!exec) return;
  const dir = path.join(S, 'executions');
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    schemaVersion: EXECUTION_SCHEMA_VERSION, kind: 'ExecutionRecord', identityHash: h,
    taskId: `${repo}#${issue}`, repo, issueNumber: issue, worktreePath: path.join(S, 'wt', h),
    executor: 'opencode', pid: null, processStartTime: null, startedAt: 1, finishedAt: null,
    terminalStatus: null, finalized: false, reason: null, ...exec,
  };
  fs.writeFileSync(path.join(dir, `${h}.json`), JSON.stringify(record, null, 2) + '\n', 'utf8');
}

// Seed a control-loop ledger from a chain of states (last `.to` is the tail).
function mkLoop(S, h, toStates) {
  const dir = path.join(S, 'control-loop', h);
  fs.mkdirSync(dir, { recursive: true });
  const lines = toStates.map((to) => JSON.stringify({ schemaVersion: '1', from: 'X', to, reason: 'seed', ts: '2026-09-01T00:00:00.000Z', identityHash: h }));
  fs.writeFileSync(path.join(dir, 'transitions.jsonl'), lines.join('\n') + '\n', 'utf8');
}

function row(evidence, issue) { return evidence.results.find((r) => r.issueNumber === issue); }

// ------------------------------------------------------------------- H1 ------
test('H1 proven live promoted executor stays discovery-active; a control-plane session with a live proven RUNNING record is also active', () => {
  const S = fs.mkdtempSync(path.join(TMP, 'h1-'));
  const promoted = mkSession(S, { issue: 1001, executionMode: 'executor' });
  mkExecution(S, { issue: 1001, h: promoted.h }, { pid: LIVE_PID, processStartTime: LIVE_PST });
  const cpLive = mkSession(S, { issue: 1002 }); // never promoted, but a live proven executor
  mkExecution(S, { issue: 1002, h: cpLive.h }, { pid: LIVE_PID, processStartTime: LIVE_PST });
  const d = enumerateActiveTasks({ stateDir: S, ...DEPS });
  const ids = d.tasks.map((t) => t.issueNumber).sort((a, b) => a - b);
  assert.deepEqual(ids, [1001, 1002], 'both genuinely-live executors stay discoverable');
  // F1: the promoted session is active because its executor is LIVE-PROVEN, NOT
  // because executionMode==='executor'; a control-plane session with the same live
  // proven executor is active on the identical liveness reason.
  assert.deepEqual(d.tasks.find((t) => t.issueNumber === 1001).activityReason, 'LIVE_PROVEN_EXECUTOR');
  assert.deepEqual(d.tasks.find((t) => t.issueNumber === 1002).activityReason, 'LIVE_PROVEN_EXECUTOR');
});

// ------------------------------------------------------------------- H2 ------
test('H2 active Human Gate stays discovery-active (never auto-terminated by reconcile)', () => {
  const S = fs.mkdtempSync(path.join(TMP, 'h2-'));
  const g = mkSession(S, { issue: 2001, state: 'WAITING_FOR_INPUT', humanGate: { state: 'WAITING_FOR_INPUT', at: '2026-09-01T00:00:00.000Z' } });
  const d = enumerateActiveTasks({ stateDir: S, ...DEPS });
  assert.deepEqual(d.tasks.map((t) => t.issueNumber), [2001], 'gate is active');
  assert.equal(d.tasks[0].humanGateState, 'WAITING');
  const r = reconcileStaleSessions({ stateDir: S, apply: true, ...DEPS });
  assert.equal(row(r.evidence, 2001).classification, 'ACTIVE');
  assert.equal(readSessionRecord(g.p).session.state, 'WAITING_FOR_INPUT', 'reconcile never touches a gate');
});

// ------------------------------------------------------------------- H3 ------
test('H3 executor GONE + loop BLOCKED: not recovery-active, and no longer SESSION_ACTIVE after canonical reconcile', () => {
  const S = fs.mkdtempSync(path.join(TMP, 'h3-'));
  const s = mkSession(S, { issue: 3001 }); // never promoted
  mkExecution(S, { issue: 3001, h: s.h }, { pid: 4242, processStartTime: LIVE_PST, terminalStatus: 'EXITED', finalized: true });
  mkLoop(S, s.h, ['ACCEPTED', 'EXECUTING', 'BLOCKED']);
  assert.equal(enumerateActiveTasks({ stateDir: S, ...DEAD }).tasks.length, 0, 'stale residue is not discovery-active even before reconcile');
  const r1 = reconcileStaleSessions({ stateDir: S, ...DEAD });
  assert.equal(row(r1.evidence, 3001).classification, 'STALE_RECONCILABLE');
  assert.equal(row(r1.evidence, 3001).proposedAction, 'PARK_BLOCKED');
  assert.equal(row(r1.evidence, 3001).wouldMutate, false, 'dry-run mutates nothing');
  assert.equal(readSessionRecord(s.p).session.state, 'SESSION_ACTIVE', 'dry-run left the record unchanged');
  const r2 = reconcileStaleSessions({ stateDir: S, apply: true, ...DEAD });
  assert.equal(r2.mutated, 1);
  assert.equal(readSessionRecord(s.p).session.state, 'BLOCKED', 'parked through the canonical seam');
});

// ------------------------------------------------------------------- H4 ------
test('H4 ACCEPTED pos0, no execution, historical stale: classified safely (never recovery-active, never terminalized)', () => {
  const S = fs.mkdtempSync(path.join(TMP, 'h4-'));
  const s = mkSession(S, { issue: 4001 });
  const d = enumerateActiveTasks({ stateDir: S, ...DEAD });
  assert.equal(d.tasks.length, 0, 'no canonical proof of activity -> not discovered');
  assert.equal(d.unknown, 1, 'counted as UNKNOWN fail-closed');
  const r = reconcileStaleSessions({ stateDir: S, apply: true, ...DEAD });
  const rw = row(r.evidence, 4001);
  assert.equal(rw.classification, 'UNKNOWN');
  assert.equal(rw.proposedAction, 'NONE');
  assert.equal(rw.wouldMutate, false, 'never terminalized');
  assert.equal(readSessionRecord(s.p).session.state, 'SESSION_ACTIVE', 'UNKNOWN is never mutated');
});

// ------------------------------------------------------------------- H5 ------
test('H5 current legitimate admission (no execution yet) is NOT incorrectly terminalized', () => {
  const S = fs.mkdtempSync(path.join(TMP, 'h5-'));
  const s = mkSession(S, { issue: 5001, executionMode: undefined });
  const r = reconcileStaleSessions({ stateDir: S, apply: true, ...DEAD });
  assert.equal(row(r.evidence, 5001).classification, 'UNKNOWN');
  assert.equal(readSessionRecord(s.p).session.state, 'SESSION_ACTIVE');
  assert.equal(fs.existsSync(path.join(S, 'executions', `${s.h}.json`)), false, 'no ExecutionRecord is fabricated');
});

// ------------------------------------------------------------------- H6 ------
test('H6 UNKNOWN process identity (live pid, unprovable) fails closed: not active, never parked even with a BLOCKED loop tail', () => {
  const S = fs.mkdtempSync(path.join(TMP, 'h6-'));
  const s = mkSession(S, { issue: 6001 });
  mkExecution(S, { issue: 6001, h: s.h }, { pid: LIVE_PID, processStartTime: LIVE_PST, terminalStatus: null, finalized: false });
  mkLoop(S, s.h, ['EXECUTING', 'BLOCKED']);
  const v = canonicalTaskActivityVerdict({ session: readSessionRecord(s.p).session, execution: readExecutionRecord({ stateDir: S, repo: REPO, issueNumber: 6001 }).record, ...UNPROVEN });
  assert.equal(v.verdict, 'UNKNOWN'); assert.equal(v.active, false, 'unprovable identity is never claimed active');
  const r = reconcileStaleSessions({ stateDir: S, apply: true, ...UNPROVEN });
  const rw = row(r.evidence, 6001);
  assert.equal(rw.classification, 'UNKNOWN', 'BLOCKED tail + still-live-unproven executor -> NOT parked');
  assert.equal(rw.wouldMutate, false);
  assert.equal(readSessionRecord(s.p).session.state, 'SESSION_ACTIVE');
});

// ------------------------------------------------------------------- H7 ------
test('H7 missing ExecutionRecord (#104): fails closed, but a canonical BLOCKED loop tail safely parks it WITHOUT fabricating a record', () => {
  const S = fs.mkdtempSync(path.join(TMP, 'h7-'));
  const s = mkSession(S, { issue: 7001 }); // no execution record
  mkLoop(S, s.h, ['ROUTED', 'EXECUTING', 'BLOCKED']);
  // No loop tail evidence -> would remain UNKNOWN/not-active:
  assert.equal(enumerateActiveTasks({ stateDir: S, ...DEAD }).tasks.length, 0);
  const r = reconcileStaleSessions({ stateDir: S, apply: true, ...DEAD });
  assert.equal(row(r.evidence, 7001).classification, 'STALE_RECONCILABLE');
  assert.equal(row(r.evidence, 7001).reason, 'control-loop BLOCKED tail + executor proven inactive');
  assert.equal(readSessionRecord(s.p).session.state, 'BLOCKED');
  assert.equal(fs.existsSync(path.join(S, 'executions', `${s.h}.json`)), false, 'H7: no ExecutionRecord is invented');
});

// ------------------------------------------------------------------- H8 ------
test('H8 legacy-adopted review (#155): parked to BLOCKED, provenance preserved, no executor lifecycle fabricated', () => {
  const S = fs.mkdtempSync(path.join(TMP, 'h8-'));
  const s = mkSession(S, { issue: 8001 });
  // enrich as a legacy-adopted review record (provenance + prNumber, no native executor)
  const rec = readSessionRecord(s.p).session; rec.provenance = { kind: 'LEGACY_ADOPTED_FOR_REVIEW', via: 'adoptExistingPullRequestForReview' }; rec.prNumber = 8002;
  fs.writeFileSync(s.p, JSON.stringify(rec, null, 2) + '\n', 'utf8');
  mkLoop(S, s.h, ['PRE_REVIEWING', 'FINAL_REVIEWING', 'BLOCKED']);
  const r = reconcileStaleSessions({ stateDir: S, apply: true, ...DEAD });
  assert.equal(row(r.evidence, 8001).classification, 'STALE_RECONCILABLE');
  const after = readSessionRecord(s.p).session;
  assert.equal(after.state, 'BLOCKED');
  assert.equal(after.provenance.kind, 'LEGACY_ADOPTED_FOR_REVIEW', 'provenance preserved');
  assert.equal(after.prNumber, 8002, 'review binding preserved');
  assert.equal(after.executionMode, undefined, 'no fake executor lifecycle manufactured');
  assert.equal(fs.existsSync(path.join(S, 'executions', `${s.h}.json`)), false, 'no ExecutionRecord fabricated');
});

// ------------------------------------------------------------------- H9 ------
test('H9 stale mutationOwner + GONE executor (#107): parked with the canonical owner preserved (never released/clobbered)', () => {
  const S = fs.mkdtempSync(path.join(TMP, 'h9-'));
  const s = mkSession(S, { issue: 9001, owner: 'lane-9001-round7' });
  mkExecution(S, { issue: 9001, h: s.h }, { pid: 4242, processStartTime: LIVE_PST, terminalStatus: null, finalized: false }); // dead-unfinalized
  mkLoop(S, s.h, ['REWORK', 'BLOCKED']);
  const before = readExecutionRecord({ stateDir: S, repo: REPO, issueNumber: 9001 }).record;
  const r = reconcileStaleSessions({ stateDir: S, apply: true, ...DEAD });
  assert.equal(row(r.evidence, 9001).classification, 'STALE_RECONCILABLE');
  const after = readSessionRecord(s.p).session;
  assert.equal(after.state, 'BLOCKED', 'session parked');
  assert.equal(after.mutationOwner.laneId, 'lane-9001-round7', 'stale owner preserved as historical evidence, NOT released');
  assert.deepEqual(readExecutionRecord({ stateDir: S, repo: REPO, issueNumber: 9001 }).record, before, 'reconcile does not mutate the execution record (that is #157/#167 ownership)');
});

// ------------------------------------------------------------------ H10 ------
test('H10 repeated reconcile is idempotent (second pass mutates nothing, states stable)', () => {
  const S = fs.mkdtempSync(path.join(TMP, 'h10-'));
  const s = mkSession(S, { issue: 10001 });
  mkExecution(S, { issue: 10001, h: s.h }, { pid: 4242, processStartTime: LIVE_PST, terminalStatus: 'EXITED', finalized: true });
  mkLoop(S, s.h, ['EXECUTING', 'BLOCKED']);
  const r1 = reconcileStaleSessions({ stateDir: S, apply: true, ...DEAD });
  const bytes1 = fs.readFileSync(s.p);
  const r2 = reconcileStaleSessions({ stateDir: S, apply: true, ...DEAD });
  assert.equal(r1.mutated, 1); assert.equal(r2.mutated, 0);
  assert.deepEqual(fs.readFileSync(s.p), bytes1, 'replay writes zero bytes');
  assert.equal(readSessionRecord(s.p).session.state, 'BLOCKED');
});

// ------------------------------------------------------------------ H11 ------
test('H11 foreign repo/task state untouched (reconcile repo filter + discovery separate identity)', () => {
  const S = fs.mkdtempSync(path.join(TMP, 'h11-'));
  const mine = mkSession(S, { repo: REPO, issue: 11001 });
  mkLoop(S, mine.h, ['EXECUTING', 'BLOCKED']);
  const foreign = mkSession(S, { repo: 'someone/else', issue: 11002 });
  mkLoop(S, foreign.h, ['EXECUTING', 'BLOCKED']);
  const r = reconcileStaleSessions({ stateDir: S, repo: REPO, apply: true, ...DEAD });
  assert.equal(r.evidence.results.length, 1, 'only the target repo is scanned');
  assert.equal(readSessionRecord(mine.p).session.state, 'BLOCKED');
  assert.equal(readSessionRecord(foreign.p).session.state, 'SESSION_ACTIVE', 'foreign repo task untouched');
});

// ------------------------------------------------------------------ H12/H13/H14 ----
test('H12/H13/H14 recovery discovery returns only genuinely active tasks; proven-gone residue does NOT block; UNKNOWN DOES block', () => {
  const S = fs.mkdtempSync(path.join(TMP, 'h12-'));
  // residue mix: one stale-reconcilable, one executor-gone parked, one never-executed
  const stale = mkSession(S, { issue: 12001 });
  mkExecution(S, { issue: 12001, h: stale.h }, { pid: 4242, processStartTime: LIVE_PST, terminalStatus: 'EXITED', finalized: true });
  mkLoop(S, stale.h, ['EXECUTING', 'BLOCKED']);
  const gone = mkSession(S, { issue: 12002 });
  mkExecution(S, { issue: 12002, h: gone.h }, { pid: 4243, processStartTime: LIVE_PST, terminalStatus: 'EXITED', finalized: true });
  assert.equal(enumerateActiveTasks({ stateDir: S, ...DEAD }).tasks.length, 0);
  const empty = resolveRecoveryTarget({ stateDir: S, ...DEAD });
  assert.equal(empty.ok, false); assert.equal(empty.reason, 'NO_ACTIVE_TASK', 'H13: proven-gone residue does not block; zero active -> NO_ACTIVE_TASK');
  // (b) add ONE real live task alongside residue -> no-arg recovery selects ONLY it
  const live = mkSession(S, { issue: 12004, executionMode: 'executor' });
  mkExecution(S, { issue: 12004, h: live.h }, { pid: LIVE_PID, processStartTime: LIVE_PST });
  const picked = resolveRecoveryTarget({ stateDir: S, ...DEPS });
  assert.equal(picked.ok, true); assert.equal(picked.exact, false, 'H14: discovered by liveness, not guessed');
  assert.equal(picked.issueNumber, 12004, 'H12: only the genuinely-active task is discoverable');
  // (c) after apply, the stale residue is parked; discovery still selects the live task
  reconcileStaleSessions({ stateDir: S, apply: true, ...DEPS });
  assert.equal(readSessionRecord(stale.p).session.state, 'BLOCKED');
  assert.equal(readSessionRecord(gone.p).session.state, 'SESSION_ACTIVE', 'executor-gone (no loop decision) stays, excluded by liveness only');
  const after = resolveRecoveryTarget({ stateDir: S, ...DEPS });
  assert.equal(after.ok, true); assert.equal(after.issueNumber, 12004);
  // (d) UNKNOWN session alongside live task -> RECOVERY_ACTIVITY_UNKNOWN (UNKNOWN blocks)
  const unk = mkSession(S, { issue: 12005 });
  const blocked = resolveRecoveryTarget({ stateDir: S, ...DEPS });
  assert.equal(blocked.ok, false); assert.equal(blocked.reason, 'RECOVERY_ACTIVITY_UNKNOWN', 'UNKNOWN blocks no-arg discovery even with live task present');
});

test('REGRESSION active + unreadable: no-arg discovery refuses when a session fails fail-closed validation', () => {
  const S = fs.mkdtempSync(path.join(TMP, 'reg-unread-'));
  const live = mkSession(S, { issue: 17001, executionMode: 'executor' });
  mkExecution(S, { issue: 17001, h: live.h }, { pid: LIVE_PID, processStartTime: LIVE_PST });
  const h = identityHash({ repo: REPO, issueNumber: 17002 });
  const p = sessionPathFor({ stateDir: S, identityHash: h });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{not valid json}');
  const blocked = resolveRecoveryTarget({ stateDir: S, ...DEPS });
  assert.equal(blocked.ok, false); assert.equal(blocked.reason, 'RECOVERY_STATE_UNREADABLE', 'unreadable session blocks no-arg discovery even with live task');
});

test('H-AMBIG one live + one gate -> two genuinely-active tasks require the exact bind (fail-closed, never guessed)', () => {
  const S = fs.mkdtempSync(path.join(TMP, 'hambig-'));
  const live = mkSession(S, { issue: 13001, executionMode: 'executor' });
  mkExecution(S, { issue: 13001, h: live.h }, { pid: LIVE_PID, processStartTime: LIVE_PST });
  mkSession(S, { issue: 13002, state: 'HUMAN_GATE_REQUIRED', humanGate: { state: 'REQUESTED', at: '2026-09-01T00:00:00.000Z' } });
  const r = resolveRecoveryTarget({ stateDir: S, ...DEPS });
  assert.equal(r.ok, false); assert.equal(r.reason, 'AMBIGUOUS_ACTIVE_TASKS', 'both are legitimately active -> never auto-picks');
});

// ------------------------------------------ F2 REWORK regression 1 ------
// The ROOT DEFECT: a promoted executor used to stay recovery-active on
// executionMode==='executor' alone, even when its execution was PROVEN GONE, so a
// stale SESSION_ACTIVE residue was discoverable forever (and could re-trigger
// AMBIGUOUS_ACTIVE_TASKS). This drives the exact RUNNING -> GONE transition while the
// session record never leaves SESSION_ACTIVE.
test('F2-1 promoted executor RUNNING then PROVEN GONE: NOT recovery-active while the record is still SESSION_ACTIVE', () => {
  const S = fs.mkdtempSync(path.join(TMP, 'f2-1-'));
  const s = mkSession(S, { issue: 15001, executionMode: 'executor' });
  // (a) promoted + identity-proven RUNNING -> active because the process is proven LIVE
  mkExecution(S, { issue: 15001, h: s.h }, { pid: LIVE_PID, processStartTime: LIVE_PST });
  const liveVerdict = canonicalTaskActivityVerdict({ session: readSessionRecord(s.p).session, execution: readExecutionRecord({ stateDir: S, repo: REPO, issueNumber: 15001 }).record, ...DEPS });
  assert.deepEqual(liveVerdict, { active: true, verdict: 'ACTIVE', reason: 'LIVE_PROVEN_EXECUTOR' }, 'active on liveness, not on mode');
  assert.deepEqual(enumerateActiveTasks({ stateDir: S, ...DEPS }).tasks.map((t) => t.issueNumber), [15001]);
  // (b) the SAME execution becomes PROVEN EXITED/GONE (terminal record), yet the
  //     session record is STILL SESSION_ACTIVE and STILL promoted.
  mkExecution(S, { issue: 15001, h: s.h }, { pid: LIVE_PID, processStartTime: LIVE_PST, terminalStatus: 'EXITED', finalized: true });
  const sess = readSessionRecord(s.p).session;
  assert.equal(sess.state, 'SESSION_ACTIVE', 'residue is still SESSION_ACTIVE');
  assert.equal(sess.executionMode, 'executor', 'and still promoted');
  const goneVerdict = canonicalTaskActivityVerdict({ session: sess, execution: readExecutionRecord({ stateDir: S, repo: REPO, issueNumber: 15001 }).record, ...DEPS });
  assert.deepEqual(goneVerdict, { active: false, verdict: 'PARKED', reason: 'EXECUTOR_GONE' }, 'proven-gone promoted executor is PARKED');
  const d = enumerateActiveTasks({ stateDir: S, ...DEPS });
  assert.equal(d.tasks.length, 0, 'NOT recovery-active merely because executionMode===executor');
});

// ------------------------------------------ F2 REWORK regression 2 ------
// Multi-residue class (the #9000005 / #183 rollout failure): SEVERAL promoted+proven-
// dead residue sessions all still SESSION_ACTIVE must not reproduce
// AMBIGUOUS_ACTIVE_TASKS — discovery returns 0 active -> NO_ACTIVE_TASK; and a single
// genuinely-live task alongside the residues is the only thing no-arg recovery selects.
test('F2-2 several promoted+proven-dead residue sessions -> 0 active -> NO_ACTIVE_TASK; one live task alongside -> only it is selected', () => {
  const S = fs.mkdtempSync(path.join(TMP, 'f2-2-'));
  for (const issue of [16001, 16002, 16003, 16004]) {
    const r = mkSession(S, { issue, executionMode: 'executor' });
    mkExecution(S, { issue, h: r.h }, { pid: 4000 + issue, processStartTime: LIVE_PST, terminalStatus: 'EXITED', finalized: true });
  }
  // all residue is still SESSION_ACTIVE on disk yet none is recovery-active
  for (const issue of [16001, 16002, 16003, 16004]) {
    const h = identityHash({ repo: REPO, issueNumber: issue });
    assert.equal(readSessionRecord(sessionPathFor({ stateDir: S, identityHash: h })).session.state, 'SESSION_ACTIVE', `residue #${issue} stays SESSION_ACTIVE`);
  }
  assert.equal(enumerateActiveTasks({ stateDir: S, ...DEPS }).tasks.length, 0, 'proven-dead promoted residue is excluded');
  const empty = resolveRecoveryTarget({ stateDir: S, ...DEPS });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'NO_ACTIVE_TASK', 'multi-residue -> NO_ACTIVE_TASK, never AMBIGUOUS_ACTIVE_TASKS');
  // add exactly ONE genuinely-live promoted task
  const live = mkSession(S, { issue: 16005, executionMode: 'executor' });
  mkExecution(S, { issue: 16005, h: live.h }, { pid: LIVE_PID, processStartTime: LIVE_PST });
  const picked = resolveRecoveryTarget({ stateDir: S, ...DEPS });
  assert.equal(picked.ok, true);
  assert.equal(picked.exact, false, 'discovered by liveness, not guessed');
  assert.equal(picked.issueNumber, 16005, 'no-arg recovery selects ONLY the genuinely-live task');
});

// ------------------------------------------------------------------ unit ------
test('canonicalTaskActivityVerdict maps every canonical evidence branch deterministically', () => {
  const base = { state: 'SESSION_ACTIVE' };
  assert.equal(canonicalTaskActivityVerdict({ session: { ...base, state: 'COMPLETED' } }).verdict, 'TERMINAL');
  assert.equal(canonicalTaskActivityVerdict({ session: { ...base, state: 'BLOCKED' } }).verdict, 'TERMINAL');
  assert.deepEqual(canonicalTaskActivityVerdict({ session: { ...base, state: 'HUMAN_GATE_REQUIRED' } }), { active: true, verdict: 'ACTIVE', reason: 'HUMAN_GATE_WAITING' });
  // F1: executionMode==='executor' ALONE is no longer a proof of activity.
  // promoted + no execution evidence -> UNKNOWN (not active, never terminalized).
  const promotedNoRec = canonicalTaskActivityVerdict({ session: { ...base, executionMode: 'executor' } });
  assert.equal(promotedNoRec.active, false, 'F1: promoted with no execution is NOT active');
  assert.deepEqual(promotedNoRec, { active: false, verdict: 'UNKNOWN', reason: 'NO_EXECUTOR_EVIDENCE' });
  // promoted + live identity-proven RUNNING executor -> ACTIVE on liveness (not mode).
  assert.deepEqual(
    canonicalTaskActivityVerdict({ session: { ...base, executionMode: 'executor' }, execution: { pid: LIVE_PID, processStartTime: LIVE_PST, terminalStatus: null, finalized: false }, ...DEPS }),
    { active: true, verdict: 'ACTIVE', reason: 'LIVE_PROVEN_EXECUTOR' },
  );
  // promoted + execution PROVEN EXITED/GONE -> PARKED EXECUTOR_GONE (residue excluded).
  assert.deepEqual(
    canonicalTaskActivityVerdict({ session: { ...base, executionMode: 'executor' }, execution: { pid: 4242, processStartTime: LIVE_PST, terminalStatus: 'EXITED', finalized: true } }),
    { active: false, verdict: 'PARKED', reason: 'EXECUTOR_GONE' },
  );
  // promoted + unprovable identity -> UNKNOWN fail-closed (never active, never mutated).
  assert.equal(canonicalTaskActivityVerdict({ session: { ...base, executionMode: 'executor' }, execution: { pid: LIVE_PID, processStartTime: LIVE_PST, terminalStatus: null, finalized: false }, ...UNPROVEN }).verdict, 'UNKNOWN');
  assert.equal(canonicalTaskActivityVerdict({ session: base, execution: null }).reason, 'NO_EXECUTOR_EVIDENCE');
  assert.equal(canonicalTaskActivityVerdict({ session: base, execution: { terminalStatus: 'EXITED', finalized: true } }).verdict, 'PARKED');
  const live = canonicalTaskActivityVerdict({ session: base, execution: { pid: LIVE_PID, processStartTime: LIVE_PST, terminalStatus: null, finalized: false }, ...DEPS });
  assert.deepEqual(live, { active: true, verdict: 'ACTIVE', reason: 'LIVE_PROVEN_EXECUTOR' });
  assert.equal(canonicalTaskActivityVerdict({ session: base, execution: { pid: LIVE_PID, processStartTime: LIVE_PST, terminalStatus: null, finalized: false }, ...UNPROVEN }).verdict, 'UNKNOWN');
});

test('parkStaleSession is ownership-safe, gate-refusing, idempotent and preserves mutationOwner', () => {
  const S = fs.mkdtempSync(path.join(TMP, 'park-'));
  const s = mkSession(S, { issue: 14001, owner: 'lane-park' });
  assert.deepEqual(parkStaleSession({ sessionPath: s.p, state: 'BLOCKED', reason: 'test' }).parked, true);
  assert.equal(readSessionRecord(s.p).session.mutationOwner.laneId, 'lane-park', 'owner preserved');
  const again = parkStaleSession({ sessionPath: s.p, state: 'BLOCKED', reason: 'test' });
  assert.equal(again.parked, false); assert.equal(again.alreadyTerminal, true, 'idempotent replay');
  const gate = mkSession(S, { issue: 14002, state: 'HUMAN_GATE_REQUIRED', humanGate: { state: 'REQUESTED', at: 'x' } });
  const refused = parkStaleSession({ sessionPath: gate.p, state: 'BLOCKED' });
  assert.equal(refused.ok, false); assert.equal(refused.reason, 'HUMAN_GATE_ACTIVE');
  assert.equal(parkStaleSession({ sessionPath: s.p, state: 'SIDEWAYS' }).reason, 'INVALID_PARK_STATE');
  void reconcileExecutorLiveness;
});
