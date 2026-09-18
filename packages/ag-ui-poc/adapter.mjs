import { randomUUID } from 'node:crypto';
import { EventSchemas } from '@ag-ui/core';

export function createFixture({ retention = 200 } = {}) {
  const epoch = randomUUID();
  let cursor = 0;
  const journal = [];
  const seen = new Set();
  const listeners = new Set();
  const tasks = ['alpha', 'beta'].map((name, i) => ({
    taskId: `fixture-${name}`, title: i ? 'Replay verification' : 'Adapter implementation',
    source: 'FIXTURE', canonicalState: 'SESSION_ACTIVE', currentStep: 1, totalSteps: 6,
    lastActivity: new Date().toISOString(), gate: null, stalled: false, timeline: [],
  }));
  const snapshot = () => structuredClone({ source: 'FIXTURE', epoch, cursor, tasks });
  function emit(task, name, detail) {
    task.lastActivity = new Date().toISOString();
    const entry = { cursor: ++cursor, at: task.lastActivity, name, detail };
    task.timeline.push(entry);
    task.timeline = task.timeline.slice(-80);
    const event = EventSchemas.parse({ type: 'CUSTOM', name, value: {
      source: 'FIXTURE', epoch, cursor, taskId: task.taskId, task: structuredClone(task),
    } });
    journal.push(event);
    if (journal.length > retention) journal.shift();
    for (const fn of listeners) fn(event);
  }
  for (const task of tasks) {
    emit(task, 'task.snapshot', 'Fixture created; no canonical connection');
    emit(task, 'task.status_changed', 'Fixture observation: SESSION_ACTIVE');
  }
  function command(input) {
    const allowed = ['ping', 'gate', 'approve', 'reject', 'stall'];
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(k => !['taskId', 'action', 'requestId', 'checkpoint'].includes(k)) ||
      !allowed.includes(input.action) || typeof input.requestId !== 'string' ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(input.requestId) ||
      (input.checkpoint !== undefined && (typeof input.checkpoint !== 'string' || input.checkpoint.length > 80))) throw new Error('COMMAND_INVALID');
    const task = tasks.find(t => t.taskId === input.taskId);
    if (!task) throw new Error('TASK_UNKNOWN');
    if (seen.has(input.requestId)) throw new Error('REPLAYED_COMMAND');
    if (['approve', 'reject'].includes(input.action) && (!task.gate || task.gate.resolved || task.gate.checkpoint !== input.checkpoint)) throw new Error('STALE_GATE');
    if (input.action === 'gate' && task.gate && !task.gate.resolved) throw new Error('GATE_ALREADY_OPEN');
    if (seen.size >= 10000) throw new Error('FIXTURE_CAPACITY_RESTART_REQUIRED');
    seen.add(input.requestId);
    if (input.action === 'gate') {
      task.gate = { checkpoint: randomUUID(), resolved: false, decision: null };
      emit(task, 'human_gate.requested', 'HUMAN_GATE fixture only; decision records an experiment');
    } else if (['approve', 'reject'].includes(input.action)) {
      task.gate.resolved = true;
      task.gate.decision = input.action;
      emit(task, 'human_gate.resolved', `${input.action}: fixture only; canonical state unchanged`);
    } else if (input.action === 'stall') {
      task.stalled = true;
      emit(task, 'executor.stalled', 'Fixture executor stalled; lifecycle unchanged');
    } else emit(task, 'task.log', 'pong: fixture command received');
    return `${input.action} recorded for ${task.taskId}; fixture only`;
  }
  function replay({ epoch: requestedEpoch, cursor: requestedCursor } = {}) {
    if (requestedEpoch !== epoch || !Number.isSafeInteger(requestedCursor) || requestedCursor < 0 ||
      requestedCursor > cursor || requestedCursor < (journal[0]?.value.cursor ?? 1) - 1) {
      return [{ type: 'STATE_SNAPSHOT', snapshot: snapshot() }];
    }
    return structuredClone(journal.filter(e => e.value.cursor > requestedCursor));
  }
  function tick() {
    for (const task of tasks) {
      if (!task.stalled) task.currentStep = Math.min(task.currentStep + 1, task.totalSteps);
      emit(task, 'task.progress', `Fixture heartbeat, step ${task.currentStep}/${task.totalSteps}`);
    }
  }
  return { epoch, snapshot, command, replay, tick,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
