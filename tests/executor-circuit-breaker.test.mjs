// tests/executor-circuit-breaker.test.mjs - Mechanical Circuit Breaker &
// Overthinking Breaker (bounded Execution Contract). node:test, no framework.
// Deterministic: injected clock/evidence only, no real 10-minute wait.
import { test } from 'node:test';
import assert from 'node:assert';
import { evaluateExecutionBudget, terminateAndProveCleanup } from '../packages/executor-launcher/executor-reconcile.mjs';
import { superviseExecution } from '../packages/client-mcp/route-worker.mjs';

const LIMITS = { hardTimeMs: 600000, maxSteps: 10, noMutationMs: 600000 };

function makeChild() {
  const handlers = {};
  return {
    handlers,
    exitCode: null,
    signalCode: null,
    on(e, f) { (handlers[e] = handlers[e] || []).push(f); return this; },
    fire(e) { for (const f of handlers[e] || []) f(); },
  };
}
const noSleep = async () => {};

test('1 healthy/progressing executor => CONTINUE / no kill', async () => {
  const d = evaluateExecutionBudget(
    { elapsedMs: 1000, stepCount: 2, msSinceLastMutation: 1000, hasMutation: true, identityProven: true }, LIMITS);
  assert.equal(d.action, 'CONTINUE');
  assert.equal(d.breakerReason, null);
  assert.equal(d.executionOutcome, null);
  let terminated = 0;
  const child = makeChild();
  const r = await superviseExecution(
    { child, pid: 4242, worktreePath: '/wt', startedAt: 0 },
    { now: () => 1000, sleep: noSleep, maxPolls: 3, limits: LIMITS,
      countSteps: () => 2, readFingerprint: (() => { let n = 0; return () => `fp${n++ === 0 ? 0 : 1}`; })(),
      isAlive: () => true, readStartTime: () => ({ processStartTime: 111 }),
      getStartTime: () => 111, terminate: () => { terminated += 1; return { provenGone: true }; } });
  assert.equal(r.tripped, false);
  assert.equal(terminated, 0, 'healthy executor must not be killed');
});

test('2 proven alive + no mutation beyond threshold => NO_MUTATION / PROCESS_HUNG / exact-identity termination', async () => {
  const d = evaluateExecutionBudget(
    { elapsedMs: 1000, stepCount: 1, msSinceLastMutation: 600000, hasMutation: false, identityProven: true }, LIMITS);
  assert.equal(d.action, 'TRIP');
  assert.equal(d.breakerReason, 'NO_MUTATION');
  assert.equal(d.executionOutcome, 'PROCESS_HUNG');
  let got = null;
  const child = makeChild();
  const r = await superviseExecution(
    { child, pid: 4242, worktreePath: '/wt', startedAt: 0 },
    { now: () => 600001, sleep: noSleep, limits: LIMITS,
      countSteps: () => 1, readFingerprint: () => 'stable',
      isAlive: () => true, readStartTime: () => ({ processStartTime: 111 }),
      getStartTime: () => 111,
      terminate: (a) => { got = a; return { provenGone: true, action: 'TERMINATED', cleanupRequired: false }; } });
  assert.equal(r.tripped, true);
  assert.equal(r.breakerReason, 'NO_MUTATION');
  assert.equal(r.executionOutcome, 'PROCESS_HUNG');
  assert.ok(got && got.pid === 4242 && got.startTime === 111, 'terminates ONLY the exact incarnation');
});

test('2a fingerprint changes once then stays stable beyond noMutationMs => NO_MUTATION / PROCESS_HUNG / exact-identity termination', async () => {
  const times = [0, 1000, 601001];
  let fingerprint = 'baseline';
  let poll = 0;
  let got = null;
  let terminated = 0;
  const child = makeChild();
  const r = await superviseExecution(
    { child, pid: 4242, worktreePath: '/wt', startedAt: 0 },
    { now: () => { const t = times.shift(); if (poll === 1) fingerprint = 'changed'; poll += 1; return t; }, sleep: noSleep, limits: LIMITS,
      countSteps: () => 1, readFingerprint: () => fingerprint,
      isAlive: () => true, readStartTime: () => ({ processStartTime: 111 }),
      getStartTime: () => 111,
      terminate: (a) => { terminated += 1; got = a; return { provenGone: true, action: 'TERMINATED', cleanupRequired: false }; } });
  assert.equal(r.tripped, true);
  assert.equal(r.breakerReason, 'NO_MUTATION');
  assert.equal(r.executionOutcome, 'PROCESS_HUNG');
  assert.equal(terminated, 1, 'exact-identity termination is invoked after the stall');
  assert.ok(got && got.pid === 4242 && got.startTime === 111, 'terminates ONLY the exact incarnation');
});

test('2b mutation at t1 then stops mutating => TRIP / NO_MUTATION / PROCESS_HUNG', () => {
  const d = evaluateExecutionBudget(
    { elapsedMs: 600000, stepCount: 1, msSinceLastMutation: 600000, hasMutation: true, identityProven: true }, LIMITS);
  assert.equal(d.action, 'TRIP');
  assert.equal(d.breakerReason, 'NO_MUTATION');
  assert.equal(d.executionOutcome, 'PROCESS_HUNG');
});

test('3 hardTimeMs exceeded with progress => EXECUTION_BUDGET_EXCEEDED / UNKNOWN', () => {
  const d = evaluateExecutionBudget(
    { elapsedMs: 600000, stepCount: 9, msSinceLastMutation: 0, hasMutation: true, identityProven: true }, LIMITS);
  assert.equal(d.action, 'TRIP');
  assert.equal(d.breakerReason, 'EXECUTION_BUDGET_EXCEEDED');
  assert.equal(d.executionOutcome, 'UNKNOWN');
});

test('4 maxSteps reached => EXECUTION_BUDGET_EXCEEDED / UNKNOWN', () => {
  const d = evaluateExecutionBudget(
    { elapsedMs: 1000, stepCount: 10, msSinceLastMutation: 0, hasMutation: true, identityProven: true }, LIMITS);
  assert.equal(d.action, 'TRIP');
  assert.equal(d.breakerReason, 'EXECUTION_BUDGET_EXCEEDED');
  assert.equal(d.executionOutcome, 'UNKNOWN');
});

test('5 unproven/reused process identity => NEVER kill foreign/unproven process', async () => {
  const d = evaluateExecutionBudget(
    { elapsedMs: 700000, stepCount: 1, msSinceLastMutation: 700000, hasMutation: false, identityProven: false }, LIMITS);
  assert.equal(d.action, 'TRIP', 'budget trip still reports even when identity unproven');
  let killed = false;
  const child = makeChild();
  const r = await superviseExecution(
    { child, pid: 4242, worktreePath: '/wt', startedAt: 0 },
    { now: () => 700000, sleep: noSleep, limits: LIMITS,
      countSteps: () => 1, readFingerprint: () => 'stable',
      isAlive: () => true, readStartTime: () => ({ processStartTime: 999 }),
      getStartTime: () => 111,
      kill: () => { killed = true; },
      terminate: () => { killed = true; return { provenGone: false }; } });
  assert.equal(r.tripped, true);
  assert.equal(killed, false, 'must never kill on unproven identity');
  assert.equal(r.cleanup.action, 'IDENTITY_UNPROVEN_SKIP');
  let foreignKilled = false;
  const cl = terminateAndProveCleanup({ pid: 4242, startTime: 111, isAlive: () => true,
    readStartTime: () => ({ pid: 4242, processStartTime: 999 }),
    kill: () => { foreignKilled = true; }, sleep: () => {} });
  assert.equal(foreignKilled, false, 'terminateAndProveCleanup must not kill a reused pid');
  assert.equal(cl.foreign, true);
});

test('6 normal child exit before breaker => watchdog stops without breaker termination', async () => {
  let terminated = 0;
  const child = makeChild();
  child.exitCode = 0;
  const r = await superviseExecution(
    { child, pid: 4242, worktreePath: '/wt', startedAt: 0 },
    { now: () => 1000, sleep: noSleep, limits: LIMITS,
      countSteps: () => 1, readFingerprint: () => 'stable',
      isAlive: () => false, readStartTime: () => null,
      getStartTime: () => 111, terminate: () => { terminated += 1; return {}; } });
  assert.equal(r.tripped, false);
  assert.equal(r.reason, 'CHILD_EXITED');
  assert.equal(terminated, 0, 'exited child must not be terminated');
});
