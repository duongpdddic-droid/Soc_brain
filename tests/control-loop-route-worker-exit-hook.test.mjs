import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { primeRouteFailureSurfaces } from '../packages/client-mcp/control-loop-route-worker.mjs';

// Fixture: canonical session + route request + an unfinalized ExecutionRecord.
function makeFixture({ repo = 'duongpdddic-droid/soc_brain', issueNumber = 9999999 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-exit-hook-'));
  const stateDir = path.join(dir, 'state');
  const id = identityHash({ repo, issueNumber });
  const taskId = `${repo}#${issueNumber}`;
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, JSON.stringify({
    schemaVersion: '1', repo, issueNumber, identityHash: id, state: 'SESSION_ACTIVE',
    taskId, controlPlane: { stateDir }, lease: { token: 't' },
    worktreePath: stateDir, worktreesRoot: path.dirname(stateDir),
  }, null, 2));
  const routesDir = path.join(stateDir, 'client-mcp', 'routes');
  fs.mkdirSync(routesDir, { recursive: true });
  const requestPath = path.join(routesDir, `${id}.control-loop.json`);
  fs.writeFileSync(requestPath, JSON.stringify({
    kind: 'soc-control-loop-route', repo, issueNumber, identityHash: id,
    sessionPath, stateDir, goal: 'probe', requestedAt: new Date().toISOString(),
  }, null, 2));
  const recPath = path.join(stateDir, 'executions', `${id}.json`);
  fs.mkdirSync(path.dirname(recPath), { recursive: true });
  fs.writeFileSync(recPath, JSON.stringify({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: id,
    taskId, repo, issueNumber, baseSha: 'a'.repeat(40), branch: 'b',
    worktreePath: stateDir, executor: 'fake', pid: null, processStartTime: null,
    startedAt: Date.now(), finishedAt: null, exitCode: null, signal: null,
    terminalStatus: null, finalized: false,
  }, null, 2));
  return { dir, stateDir, id, taskId, sessionPath, requestPath, recPath, req: { sessionPath, stateDir } };
}

test('primeRouteFailureSurfaces writes a typed UNKNOWN result and a proven-dead executor is reaped exactly once', async () => {
  const fx = makeFixture();
  try {
    const stubVerify = () => ({ ok: true });
    // Case 1: no concrete pid/startTime yet => reaper refuses (fail-closed); typed result still persisted.
    let r = primeRouteFailureSurfaces({ requestPath: fx.requestPath, req: fx.req, verifyAuthority: stubVerify });
    assert.equal(r.ok, true);
    assert.equal(r.resultPersisted, true);
    assert.equal(r.reap.ok, false);
    const result1 = JSON.parse(fs.readFileSync(`${fx.requestPath}.result.json`, 'utf8'));
    assert.equal(result1.code, 'LOOP_WORKER_EXITED');

    // Case 2: executor pid recorded, then proven dead => INTERRUPTED/finalized; result persists.
    const victim = spawn(process.execPath, ['-e', 'setTimeout(()=>{},600000)'], { stdio: 'ignore', detached: true });
    victim.unref();
    const { readWin32ProcessStartTime } = await import('../packages/temp-hygiene/temp-hygiene.mjs');
    const pst = readWin32ProcessStartTime(victim.pid);
    const rec = JSON.parse(fs.readFileSync(fx.recPath, 'utf8'));
    rec.pid = victim.pid;
    rec.processStartTime = pst?.processStartTime ?? null;
    fs.writeFileSync(fx.recPath, JSON.stringify(rec, null, 2));
    // First: victim alive => EXECUTOR_LIVE refusal (never reap a live executor).
    let rLive = primeRouteFailureSurfaces({ requestPath: fx.requestPath, req: fx.req, verifyAuthority: stubVerify });
    assert.equal(rLive.reap.ok, false);
    assert.equal(rLive.reap.reason, 'EXECUTION_LIVE');
    // Then kill victim and re-prime => reaper marks the record INTERRUPTED.
    victim.kill();
    await new Promise((res) => setTimeout(res, 500));
    r = primeRouteFailureSurfaces({ requestPath: fx.requestPath, req: fx.req, verifyAuthority: stubVerify });
    assert.equal(r.reap.ok, true);
    assert.equal(r.reap.action, 'REAPED');
    const rec2 = JSON.parse(fs.readFileSync(fx.recPath, 'utf8'));
    assert.equal(rec2.terminalStatus, 'INTERRUPTED');
    assert.equal(rec2.finalized, true);
    assert.equal(rec2.reason, 'EXECUTION_REAPED_DEAD_UNFINALIZED');
    // Idempotent replay: second prime does not flip anything (NOOP_ALREADY_TERMINAL).
    const r2 = primeRouteFailureSurfaces({ requestPath: fx.requestPath, req: fx.req, verifyAuthority: stubVerify });
    assert.equal(r2.reap.ok, true);
    assert.equal(r2.reap.action, 'NOOP_ALREADY_TERMINAL');
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('primeRouteFailureSurfaces never overwrites an already-classified result', () => {
  const fx = makeFixture();
  try {
    fs.writeFileSync(`${fx.requestPath}.result.json`, JSON.stringify({ ok: false, code: 'LOOP_RUNNER_THROWN' }) + '\n');
    const r = primeRouteFailureSurfaces({ requestPath: fx.requestPath, req: fx.req, verifyAuthority: () => ({ ok: true }) });
    assert.equal(r.resultPersisted, false);
    assert.equal(JSON.parse(fs.readFileSync(`${fx.requestPath}.result.json`, 'utf8')).code, 'LOOP_RUNNER_THROWN');
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});
