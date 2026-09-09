#!/usr/bin/env node
// ui-view-model.test.mjs — Soc_brain UI v1 canonical view-model adapter tests.
// No framework. Exit 0 = PASS, 1 = FAIL. Fully injected deps: no real git,
// no real session files, no real executor.
import {
  buildTaskViewModel, emptyViewModel, deriveHealth, VM_SCHEMA_VERSION,
} from '../packages/control-ui/ui-view-model.mjs';
import { createControlPlane, createControlUiServer } from '../packages/control-ui/control-ui.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });

const REPO = 'o/r';
const CONTRACT_KEYS = [
  'taskId', 'issueNumber', 'prNumber', 'title', 'repo', 'branch', 'headSha',
  'canonicalState', 'phase', 'progressPercent', 'currentStep', 'totalSteps',
  'executor', 'executorVersion', 'executionId', 'pid', 'startedAt', 'elapsed',
  'lastMeaningfulActivityAt', 'health', 'blocker', 'humanActionRequired',
  'todo', 'recentEvents', 'telemetry', 'runtime', 'logs',
];

// ---- empty view-model: full contract, nothing derived ----------------------------
{
  const vm = emptyViewModel({ repo: REPO, issueNumber: 7 });
  eq('empty: schema version', vm.schemaVersion, VM_SCHEMA_VERSION);
  const missing = CONTRACT_KEYS.filter((k) => !(k in vm));
  eq('empty: all contract fields present', missing.length, 0);
  eq('empty: canonicalState', vm.canonicalState, 'NO_SESSION');
  eq('empty: phase', vm.phase, 'idle');
  eq('empty: health', vm.health, 'offline');
  eq('empty: todo empty array', Array.isArray(vm.todo) && vm.todo.length, 0);
  eq('empty: logs empty array', Array.isArray(vm.logs) && vm.logs.length, 0);
}

// ---- deriveHealth: canonical-only mapping table -----------------------------------
{
  eq('health: COMPLETED', deriveHealth({ canonicalState: 'COMPLETED', execution: { status: 'EXITED', exitCode: 0 } }), 'healthy');
  eq('health: BLOCKED', deriveHealth({ canonicalState: 'BLOCKED' }), 'attention');
  eq('health: FAILED', deriveHealth({ canonicalState: 'FAILED' }), 'attention');
  eq('health: human gate', deriveHealth({ canonicalState: 'WAITING_FOR_INPUT' }), 'attention');
  eq('health: active + RUNNING', deriveHealth({ canonicalState: 'SESSION_ACTIVE', execution: { status: 'RUNNING' } }), 'healthy');
  eq('health: active + STARTING', deriveHealth({ canonicalState: 'SESSION_ACTIVE', execution: { status: 'STARTING' } }), 'healthy');
  // canonical still active but process gone -> recovery needed, never "healthy"
  eq('health: active + EXITED', deriveHealth({ canonicalState: 'SESSION_ACTIVE', execution: { status: 'EXITED', exitCode: 0 } }), 'attention');
  eq('health: NO_SESSION', deriveHealth({ canonicalState: 'NO_SESSION' }), 'offline');
}

// ---- full mapping: live task with all canonical sources ----------------------------
{
  const SESSION = {
    schemaVersion: '1', state: 'SESSION_ACTIVE', taskId: 'o/r#7', repo: 'o/r', issueNumber: 7,
    branch: 'soc/task-x', headSha: 'b'.repeat(40), startedAt: '2026-01-01T00:00:00.000Z',
    lifecycle: [
      { event: 'CONTRACT_PINNED', at: '2026-01-01T00:00:00.000Z', detail: 'baseSha pinned' },
      { event: 'SESSION_ACTIVE', at: '2026-01-01T00:00:01.000Z', detail: 'lease issued' },
    ],
  };
  const EXEC = {
    ok: true,
    execution: {
      status: 'RUNNING', terminalStatus: null, reason: null, pid: 4242, executor: 'opencode',
      model: 'opencode/big-pickle', sessionId: 'ses_1', startedAt: 1700000000000, finishedAt: null,
      exitCode: null, signal: null, instructionDigest: 'd'.repeat(64), instructionBytes: 10,
      eventsOverflow: false, elapsedMs: 65000,
    },
  };
  const PROGRESS = {
    ok: true,
    progress: {
      currentStep: 2, totalSteps: 3,
      steps: [
        { index: 1, name: 'Inspect', status: 'COMPLETED' },
        { index: 2, name: 'Implement', status: 'IN_PROGRESS' },
        { index: 3, name: 'Verify', status: 'PENDING' },
      ],
      executorId: 'opencode', executionEpoch: 1, updatedAt: '2026-01-01T00:01:10.000Z', message: null,
    },
  };
  const TELEMETRY = [
    { event: 'TASK_STARTED', t: 1700000000000, detail: { baseSha: 'a'.repeat(40) } },
    { event: 'EXECUTOR_STARTED', t: 1700000005000, detail: { pid: 4242 } },
  ];
  const ACTIVITY = { ok: true, items: [{ seq: 1, kind: 'output', line: 'COMPLETED 100% (raw text passthrough)' }] };

  const r = buildTaskViewModel({
    repo: REPO, issueNumber: 7, stateDir: 'C:/state',
    deps: {
      readSession: () => ({ ok: true, session: SESSION }),
      readExecution: () => EXEC,
      readProgress: () => PROGRESS,
      readTelemetry: () => TELEMETRY,
      readActivity: () => ACTIVITY,
      identityHash: () => 'a'.repeat(32),
    },
  });
  tru('vm: ok', r.ok);
  const vm = r.vm;
  const missing = CONTRACT_KEYS.filter((k) => !(k in vm));
  eq('vm: contract complete', missing.length, 0);
  eq('vm: canonicalState verbatim', vm.canonicalState, 'SESSION_ACTIVE');
  eq('vm: phase', vm.phase, 'executing');
  eq('vm: health', vm.health, 'healthy');
  eq('vm: taskId', vm.taskId, 'o/r#7');
  eq('vm: branch', vm.branch, 'soc/task-x');
  eq('vm: headSha', vm.headSha, 'b'.repeat(40));
  eq('vm: executionId = identity handle', vm.executionId, 'a'.repeat(32));
  eq('vm: pid', vm.pid, 4242);
  eq('vm: executor', vm.executor, 'opencode');
  eq('vm: startedAt ISO (from exec.startedAt ms)', vm.startedAt, '2023-11-14T22:13:20.000Z');
  eq('vm: elapsed', vm.elapsed, 65000);
  eq('vm: progressPercent (1/3)', vm.progressPercent, 33);
  eq('vm: currentStep', vm.currentStep, 2);
  eq('vm: totalSteps', vm.totalSteps, 3);
  eq('vm: todo sorted by index', vm.todo.map((s) => s.index).join(','), '1,2,3');
  eq('vm: todo status passthrough', vm.todo[1].status, 'IN_PROGRESS');
  eq('vm: recentEvents merged (desc by time)', vm.recentEvents.length, 4);
  tru('vm: newest event first', vm.recentEvents[0].atMs >= vm.recentEvents[vm.recentEvents.length - 1].atMs);
  eq('vm: lifecycle events included', vm.recentEvents.some((e) => e.label === 'SESSION_ACTIVE'), true);  eq('vm: telemetry available', vm.telemetry && vm.telemetry.available, true);
  eq('vm: telemetry durations', vm.telemetry.durations.totalWallTime, 5000);
  eq('vm: lastMeaningfulActivityAt = progress update', vm.lastMeaningfulActivityAt, '2026-01-01T00:01:10.000Z');
  eq('vm: runtime passthrough', vm.runtime.status, 'RUNNING');
  eq('vm: runtime model', vm.runtime.model, 'opencode/big-pickle');

  // CANONICAL DATA PRINCIPLE: the raw log line screams "COMPLETED 100%" but the
  // view-model state comes ONLY from the session record — never from logs.
  eq('vm: raw log text can NEVER drive canonicalState', vm.canonicalState, 'SESSION_ACTIVE');
  eq('vm: raw log text can NEVER drive health', vm.health, 'healthy');
  eq('vm: logs passthrough verbatim', vm.logs[0].line, 'COMPLETED 100% (raw text passthrough)');
  eq('vm: humanActionRequired null when not gated', vm.humanActionRequired, null);
  eq('vm: blocker null when healthy', vm.blocker, null);
}

// ---- BLOCKED session: blocker from canonical lifecycle note -------------------------
{
  const SESSION = {
    state: 'BLOCKED', taskId: 'o/r#8', issueNumber: 8,
    lifecycle: [{ event: 'BLOCKED', at: '2026-01-01T00:05:00.000Z', detail: 'verification failed: 3/10' }],
  };
  const r = buildTaskViewModel({
    repo: REPO, issueNumber: 8, stateDir: 'C:/state',
    deps: {
      readSession: () => ({ ok: true, session: SESSION }),
      readExecution: () => ({ ok: false, reason: 'EXECUTION_NOT_FOUND' }),
      readProgress: () => ({ ok: true, progress: null }),
      readTelemetry: () => [],
      readActivity: () => ({ ok: false, reason: 'ACTIVITY_UNAVAILABLE' }),
      identityHash: () => 'b'.repeat(32),
    },
  });
  tru('blocked: ok', r.ok);
  eq('blocked: canonicalState', r.vm.canonicalState, 'BLOCKED');
  eq('blocked: phase', r.vm.phase, 'blocked');
  eq('blocked: health', r.vm.health, 'attention');
  eq('blocked: blocker from lifecycle note', r.vm.blocker, 'verification failed: 3/10');
  eq('blocked: progress nulls', `${r.vm.progressPercent}:${r.vm.currentStep}:${r.vm.totalSteps}`, 'null:null:null');
  eq('blocked: todo empty', r.vm.todo.length, 0);
  eq('blocked: logs empty when unavailable', r.vm.logs.length, 0);
}

// ---- HUMAN_GATE_REQUIRED: human action surfaced from canonical state ---------------
{
  const SESSION = {
    state: 'WAITING_FOR_INPUT', issueNumber: 9,
    humanGate: { state: 'WAITING_FOR_INPUT', note: 'approve rollout', deliveryStatus: 'API_ACCEPTED' },
    lifecycle: [],
  };
  const r = buildTaskViewModel({
    repo: REPO, issueNumber: 9, stateDir: 'C:/state',
    deps: {
      readSession: () => ({ ok: true, session: SESSION }),
      readExecution: () => ({ ok: true, execution: { status: 'RUNNING', elapsedMs: 1 } }),
      readProgress: () => ({ ok: true, progress: null }),
      readTelemetry: () => [],
      readActivity: () => ({ ok: false, reason: 'ACTIVITY_UNAVAILABLE' }),
      identityHash: () => 'c'.repeat(32),
    },
  });
  tru('gate: ok', r.ok);
  eq('gate: humanActionRequired surfaced', r.vm.humanActionRequired && r.vm.humanActionRequired.state, 'WAITING_FOR_INPUT');
  eq('gate: note surfaced', r.vm.humanActionRequired.note, 'approve rollout');
  eq('gate: phase awaiting_human', r.vm.phase, 'awaiting_human');
  eq('gate: health attention', r.vm.health, 'attention');
}

// ---- SESSION_ACTIVE + dead process => recovering, blocker from exec reason ----------
{
  const SESSION = { state: 'SESSION_ACTIVE', issueNumber: 10, lifecycle: [] };
  const r = buildTaskViewModel({
    repo: REPO, issueNumber: 10, stateDir: 'C:/state',
    deps: {
      readSession: () => ({ ok: true, session: SESSION }),
      readExecution: () => ({ ok: true, execution: { status: 'EXITED', exitCode: 1, reason: 'SIGSEGV' } }),
      readProgress: () => ({ ok: true, progress: null }),
      readTelemetry: () => [],
      readActivity: () => ({ ok: false, reason: 'ACTIVITY_UNAVAILABLE' }),
      identityHash: () => 'd'.repeat(32),
    },
  });
  eq('recover: phase', r.vm.phase, 'recovering');
  eq('recover: health', r.vm.health, 'attention');
  eq('recover: blocker from exec reason', r.vm.blocker, 'SIGSEGV');
}

// ---- EXITED with code 0 while canonical active: recovering but NO blocker -----------
{
  const SESSION = { state: 'SESSION_ACTIVE', issueNumber: 12, lifecycle: [] };
  const r = buildTaskViewModel({
    repo: REPO, issueNumber: 12, stateDir: 'C:/state',
    deps: {
      readSession: () => ({ ok: true, session: SESSION }),
      readExecution: () => ({ ok: true, execution: { status: 'EXITED', exitCode: 0 } }),
      readProgress: () => ({ ok: true, progress: null }),
      readTelemetry: () => [],
      readActivity: () => ({ ok: false, reason: 'ACTIVITY_UNAVAILABLE' }),
      identityHash: () => '1'.repeat(32),
    },
  });
  eq('cleanExit: phase', r.vm.phase, 'recovering');
  eq('cleanExit: blocker null', r.vm.blocker, null);
}

// ---- fail-isolated: deps throwing never crash the adapter ----------------------------
{
  const boom = () => { throw new Error('boom'); };
  const r = buildTaskViewModel({
    repo: REPO, issueNumber: 11, stateDir: 'C:/state',
    deps: { readSession: boom, readExecution: boom, readProgress: boom, readTelemetry: boom, readActivity: boom, identityHash: () => 'e'.repeat(32) },
  });
  tru('isolated: ok even when all deps throw', r.ok);
  eq('isolated: canonicalState NO_SESSION', r.vm.canonicalState, 'NO_SESSION');
  eq('isolated: offline', r.vm.health, 'offline');
}

// ---- invalid target -------------------------------------------------------------------
{
  const r = buildTaskViewModel({ repo: REPO, issueNumber: -1, stateDir: 'C:/state' });
  eq('invalid: fails closed', r.ok, false);
  eq('invalid: reason', r.reason, 'VM_TARGET_INVALID');
}

// ---- HTTP route: GET /api/vm ------------------------------------------------------------
{
  const VM = { schemaVersion: VM_SCHEMA_VERSION, canonicalState: 'SESSION_ACTIVE', health: 'healthy' };
  const fakePlane = {
    viewModel: (t) => (t.issueNumber === 7 ? { ok: true, vm: VM } : { ok: false, reason: 'SESSION_ABSENT' }),
  };
  const srv = createControlUiServer({ controlPlane: fakePlane, port: 0 });
  const { port } = await srv.listen();
  try {
    const good = await fetch(`http://127.0.0.1:${port}/api/vm?issueNumber=7`);    const gb = await good.json();
    eq('http: /api/vm 200', good.status, 200);
    tru('http: /api/vm body', gb.ok && gb.vm.canonicalState === 'SESSION_ACTIVE' && gb.vm.health === 'healthy');
    const bad = await fetch(`http://127.0.0.1:${port}/api/vm?issueNumber=zz`);
    eq('http: /api/vm bad target 400', bad.status, 400);
    const abs = await fetch(`http://127.0.0.1:${port}/api/vm?issueNumber=99`);
    const ab = await abs.json();
    eq('http: /api/vm absent session 400', abs.status, 400);
    eq('http: /api/vm absent reason', ab.reason, 'SESSION_ABSENT');
    tru('http: server version still surfaced on /', (await (await fetch(`http://127.0.0.1:${port}/`)).text()).includes('Soc_brain'));
  } finally {
    await new Promise((res) => srv.server.close(res));
  }
}

// ---- Issue #130: real executor version is NEVER conflated with the model -----------
{
  const SESSION = { state: 'SESSION_ACTIVE', issueNumber: 13, lifecycle: [] };
  const r = buildTaskViewModel({
    repo: REPO, issueNumber: 13, stateDir: 'C:/state',
    deps: {
      readSession: () => ({ ok: true, session: SESSION }),
      readExecution: () => ({ ok: true, execution: { status: 'RUNNING', executor: 'opencode', executorVersion: '1.18.25', model: 'opencode/big-pickle', pid: 7, elapsedMs: 5 } }),
      readProgress: () => ({ ok: true, progress: null }),
      readTelemetry: () => [],
      readActivity: () => ({ ok: false, reason: 'ACTIVITY_UNAVAILABLE' }),
      identityHash: () => 'f'.repeat(32),
    },
  });
  eq('version: executorVersion from real probe', r.vm.executorVersion, '1.18.25');
  eq('version: model separate field', r.vm.model, 'opencode/big-pickle');
  // version probe absent => null, never backfilled from model (no fabrication)
  const r2 = buildTaskViewModel({
    repo: REPO, issueNumber: 13, stateDir: 'C:/state',
    deps: {
      readSession: () => ({ ok: true, session: SESSION }),
      readExecution: () => ({ ok: true, execution: { status: 'RUNNING', executor: 'opencode', executorVersion: null, model: 'opencode/big-pickle', pid: 7, elapsedMs: 5 } }),
      readProgress: () => ({ ok: true, progress: null }),
      readTelemetry: () => [],
      readActivity: () => ({ ok: false, reason: 'ACTIVITY_UNAVAILABLE' }),
      identityHash: () => 'f'.repeat(32),
    },
  });
  eq('version: missing version stays null (no model backfill)', r2.vm.executorVersion, null);
  eq('version: model still surfaced when version absent', r2.vm.model, 'opencode/big-pickle');
  eq('version: runtime.version passthrough', r2.vm.runtime.executorVersion, null);
}

// ---- Issue #130: runtime binding — execution facts bound to the session identity ----
{
  let seenIssue = null;
  const r = buildTaskViewModel({
    repo: REPO, issueNumber: 21, stateDir: 'C:/state',
    deps: {
      readSession: () => ({ ok: true, session: { state: 'SESSION_ACTIVE', issueNumber: 21, lifecycle: [] } }),
      readExecution: (p) => { seenIssue = p.issueNumber; return { ok: true, execution: { status: 'RUNNING', pid: 9 } }; },
      readProgress: () => ({ ok: true, progress: null }),
      readTelemetry: () => [],
      readActivity: () => ({ ok: false, reason: 'ACTIVITY_UNAVAILABLE' }),
      identityHash: (p) => (p.repo === REPO && p.issueNumber === 21 ? '9'.repeat(32) : null),
    },
  });
  tru('binding: readExecution keyed by same task identity', seenIssue === 21 && r.vm.executionId === '9'.repeat(32) && r.vm.pid === 9);
}

// ---- HTTP route: GET /api/tasks (canonical session scan, public-safe) ----------------
{
  const plane = createControlPlane({ repo: 'o/r', stateDir: 'C:/state-no-such-dir', deps: { readUpstreamHead: () => null } });
  tru('tasks: plane ok', plane.ok);
  const empty = plane.listTasks();
  eq('tasks: absent sessions dir => empty list', empty.tasks.length, 0);
  eq('tasks: repo bound', empty.repo, 'o/r');
}

{
  const VM = { schemaVersion: VM_SCHEMA_VERSION, canonicalState: 'SESSION_ACTIVE', health: 'healthy' };
  const fakePlane = {
    viewModel: (t) => (t.issueNumber === 7 ? { ok: true, vm: VM } : { ok: false, reason: 'SESSION_ABSENT' }),
    listTasks: () => ({ schemaVersion: '1', repo: 'o/r', tasks: [{ taskId: 'o/r#7', issueNumber: 7, state: 'SESSION_ACTIVE' }] }),
  };
  const srv = createControlUiServer({ controlPlane: fakePlane, port: 0 });
  const { port } = await srv.listen();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/tasks`);
    const b = await r.json();
    eq('http: /api/tasks 200', r.status, 200);
    tru('http: /api/tasks body', b.ok && b.tasks.length === 1 && b.tasks[0].issueNumber === 7 && b.tasks[0].state === 'SESSION_ACTIVE');
  } finally {
    await new Promise((res) => srv.server.close(res));
  }
}

// ---- report ------------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'ok' : 'FAIL'}  ${c.name}${c.ok ? '' : `  got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
console.log(`ui-view-model.test: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);
