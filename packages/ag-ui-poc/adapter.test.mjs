import test from 'node:test';
import assert from 'node:assert/strict';
import { EventSchemas } from '@ag-ui/core';
import { createFixture } from './adapter.mjs';

const command = (taskId, action, extra = {}) => ({ taskId, action, requestId: crypto.randomUUID(), ...extra });

test('two active tasks; every required event uses real AG-UI schema', () => {
  const f = createFixture();
  assert.equal(f.snapshot().tasks.length, 2);
  assert.ok(f.snapshot().tasks.every(t => t.canonicalState === 'SESSION_ACTIVE'));
  f.tick();
  f.command(command('fixture-alpha', 'gate'));
  const gate = f.snapshot().tasks[0].gate;
  f.command(command('fixture-alpha', 'approve', { checkpoint: gate.checkpoint }));
  f.command(command('fixture-beta', 'stall'));
  f.command(command('fixture-alpha', 'ping'));
  const events = f.replay({ epoch: f.epoch, cursor: 0 });
  for (const e of events) EventSchemas.parse(e);
  for (const name of ['task.snapshot', 'task.status_changed', 'task.progress', 'task.log', 'human_gate.requested', 'human_gate.resolved', 'executor.stalled']) {
    assert.ok(events.some(e => e.name === name), name);
  }
});

test('task/checkpoint binding, duplicate commands and stale decisions are rejected without mutation', () => {
  const f = createFixture();
  const b = f.snapshot().tasks[1];
  f.command(command('fixture-alpha', 'gate'));
  const checkpoint = f.snapshot().tasks[0].gate.checkpoint;
  assert.throws(() => f.command(command('fixture-beta', 'approve', { checkpoint })), /STALE_GATE/);
  assert.deepEqual(f.snapshot().tasks[1], b);
  const approve = command('fixture-alpha', 'approve', { checkpoint });
  f.command(approve);
  const after = f.snapshot();
  assert.throws(() => f.command(approve), /REPLAYED_COMMAND/);
  assert.throws(() => f.command(command('fixture-alpha', 'reject', { checkpoint })), /STALE_GATE/);
  assert.deepEqual(f.snapshot(), after);
  assert.equal(after.tasks[0].canonicalState, 'SESSION_ACTIVE');
  f.command(command('fixture-alpha', 'gate'));
  assert.throws(() => f.command(command('fixture-alpha', 'approve', { checkpoint })), /STALE_GATE/);
});

test('allowlist rejects terminalization, unknown identity and injected fields', () => {
  const f = createFixture();
  const before = f.snapshot();
  for (const action of ['complete', 'TASK_COMPLETED', 'merge', 'deploy', 'terminalize', 'finish']) {
    assert.throws(() => f.command(command('fixture-alpha', action)), /COMMAND_INVALID/);
  }
  assert.throws(() => f.command(command('../canonical', 'ping')), /TASK_UNKNOWN/);
  assert.throws(() => f.command(command('fixture-alpha', 'ping', { canonicalState: 'COMPLETED' })), /COMMAND_INVALID/);
  assert.deepEqual(f.snapshot(), before);
});

test('replay is ordered/exclusive; expired, future and restarted cursors recover snapshot', () => {
  const f = createFixture({ retention: 12 });
  const initial = f.snapshot();
  f.tick();
  const events = f.replay({ epoch: f.epoch, cursor: initial.cursor });
  assert.ok(events.length > 0);
  assert.ok(events.every(e => e.value.cursor > initial.cursor));
  const cursor = f.snapshot().cursor;
  assert.deepEqual(f.replay({ epoch: f.epoch, cursor }), []);
  for (let i = 0; i < 10; i++) f.tick();
  for (const input of [{ epoch: f.epoch, cursor: 0 }, { epoch: 'old', cursor }, { epoch: f.epoch, cursor: 999999 }]) {
    const recovery = f.replay(input);
    assert.equal(recovery[0].type, 'STATE_SNAPSHOT');
    assert.deepEqual(recovery[0].snapshot, f.snapshot());
  }
});
