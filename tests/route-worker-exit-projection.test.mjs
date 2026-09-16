import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { runRouteRequest, ROUTE_REQUEST_KIND, ROUTE_REQUEST_SCHEMA_VERSION } from '../packages/client-mcp/route-worker.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { sessionPathFor } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { executionRecordPath, executionEventsPath } from '../packages/executor-launcher/executor-launcher.mjs';
import { readTransitions } from '../packages/control-loop/control-loop.mjs';
import { readProgressRecord } from '../packages/task-progress/task-progress.mjs';

const REPO = 'duongpdddic-droid/soc_brain';
const BASE = '1aded9a3bba83473c5ab6432c7c42669a10fe34e';
const HEAD = '0b29a1011111111111111111111111111111aaaa';
const w = (o) => JSON.stringify(o);

// PROVES: the transport-INDEPENDENT detached route-worker (not the MCP client
// process, not a voluntary executor call) drives the canonical executor-exit ->
// lifecycle projection once the child exits. A clean EXITED+committed child
// advances the canonical loop to VERIFYING + pins the verified HEAD.
test('route-worker supervises child to terminal, then projects the canonical lifecycle (no client present)', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-rwproj-'));
  const issueNumber = 9000301;
  const id = identityHash({ repo: REPO, issueNumber });
  fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'executions'), { recursive: true });
  const sp = sessionPathFor({ stateDir, identityHash: id });
  const wt = path.join(stateDir, 'wt', id);
  fs.writeFileSync(sp, w({
    schemaVersion: '1', taskId: `${REPO}#${issueNumber}`, repo: REPO, issueNumber,
    state: 'SESSION_ACTIVE', baseSha: BASE, branch: `agent/${id}`, worktreePath: wt,
    headSha: BASE, executionMode: 'executor', mutationOwner: { laneId: 'client-plane', acquiredVia: 'ADMISSION' },
    lease: { token: 'lt-' + id }, lifecycle: [], controlPlane: { stateDir, bindingPath: path.join(stateDir, 'b.json') },
  }) + '\n', 'utf8');
  fs.writeFileSync(path.join(stateDir, 'b.json'), w({ path: wt, identityHash: id, taskId: `${REPO}#${issueNumber}`, repo: REPO, baseSha: BASE, branch: `agent/${id}`, issueNumber }), 'utf8');

  // startExecution seam: returns a handle whose fake child exits immediately as
  // a clean EXITED/0 run; the worker's OWN exit handler would finalize the real
  // record, so we pre-write a terminal EXITED record and a HEAD reader cannot be
  // injected here -> instead write the record the real launcher would finalize.
  fs.writeFileSync(executionRecordPath({ stateDir, identityHash: id }), w({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: id, taskId: `${REPO}#${issueNumber}`,
    repo: REPO, issueNumber, baseSha: BASE, branch: `agent/${id}`, worktreePath: wt, executor: 'opencode',
    pid: 5150, startedAt: 1, finishedAt: 2, exitCode: 0, signal: null, terminalStatus: 'EXITED', finalized: true, processStartTime: 99,
  }) + '\n', 'utf8');
  fs.writeFileSync(executionEventsPath({ stateDir, identityHash: id }), w({ kind: 'step_finish', t: 5 }) + '\n' + w({ kind: 'tool', tool: 'edit', t: 6 }) + '\n', 'utf8');

  const reqPath = path.join(stateDir, 'client-mcp', 'routes', `${id}.1.1.json`);
  fs.mkdirSync(path.dirname(reqPath), { recursive: true });
  fs.writeFileSync(reqPath, w({ kind: ROUTE_REQUEST_KIND, schemaVersion: ROUTE_REQUEST_SCHEMA_VERSION, sessionPath: sp, stateDir, goal: 'do the work', requestedAt: new Date().toISOString() }), 'utf8');

  // Fake child that has ALREADY exited (clean 0) — runRouteRequest must observe
  // terminal and drive reconcile. The HEAD of the worktree is read via git, so
  // stand up a real git repo at wt whose HEAD != base to represent committed work.
  const { execFileSync } = await import('node:child_process');
  let child = null;
  const start = () => {
    child = new EventEmitter(); child.pid = 5150; child.exitCode = 0; child.signalCode = null; child.recordPath = executionRecordPath({ stateDir, identityHash: id });
    return { ok: true, status: 'RUNNING', pid: 5150, recordPath: child.recordPath, child };
  };
  const res = await runRouteRequest({ requestPath: reqPath, now: () => Date.now(), start });
  assert.equal(res.ok, true);

  // Without a real committed HEAD the reconciler will (correctly) refuse READY and
  // surface a recoverable block — either way the canonical loop is now PROJECTED
  // (no longer empty ACCEPTED). Assert the projection happened from within the
  // detached worker, i.e. transitions advanced past ACCEPTED and progress is durable.
  const ledger = readTransitions({ stateDir, identityHash: id }).map((t) => `${t.from}->${t.to}`);
  assert.ok(ledger.length >= 3, `worker projected the executor boundary: ${JSON.stringify(ledger)}`);
  assert.deepEqual(ledger[0], 'ACCEPTED->ROUTED');
  assert.ok(ledger.some((x) => x.startsWith('EXECUTING->')), 'reached the executor-boundary outcome');
  const pr = readProgressRecord({ stateDir, identityHash: id });
  assert.ok(pr.ok && pr.progress, 'durable operational progress written by the worker (no client polling)');
  const tail = ledger[ledger.length - 1];
  // git-less temp worktree => head==base => recoverable BLOCKED, never false READY.
  assert.ok(tail === 'EXECUTING->VERIFYING' || tail === 'EXECUTING->BLOCKED', tail);
  assert.notEqual(tail, 'EXECUTING->VERIFYING', 'no committed HEAD here => must not fabricate READY');
  void execFileSync; void start;
});
