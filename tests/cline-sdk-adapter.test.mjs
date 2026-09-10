#!/usr/bin/env node
// cline-sdk-adapter.test.mjs — deterministic regression for the MVP
// ClineSdkExecutorAdapter (Issue #147). No framework. Exit 0 = PASS.
// The Cline runtime is ALWAYS injected (fakeClineCore) — no network, no model,
// no @cline/sdk import, no hub. Live smoke lives in
// tests/cline-sdk-adapter.livesmoke.test.mjs (env-gated).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { readExecutionRecord, readExecutionStatus } from '../packages/executor-launcher/executor-launcher.mjs';
import {
  CLINE_EXECUTOR_ID, ADAPTER_VERSION, SDK_TO_CANONICAL,
  mapCoreSessionEvent, mapTerminalOutcome, buildToolPolicies,
  clineDataDir, measureExecutionStorage, cleanupExecutionArtifacts,
  probeOrphanArtifacts, markExecutionInterrupted, createClineSdkExecutor,
} from '../packages/cline-sdk-adapter/cline-sdk-adapter.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-cline-adapter-'));
const IDH = identityHash({ repo: 'o/r', issueNumber: 7 });

// ---- canonical session fixture (same shape the identity assert re-reads) ------
// ownerLaneId simulates a canonical admission/adoption that already recorded
// the mutation owner (Issue #145 session.mutationOwner shape).
function canonicalSession(stateDir, { issueNumber = 7, leaseToken = 'tok-7', ownerLaneId = null } = {}) {
  const h = identityHash({ repo: 'o/r', issueNumber });
  const p = path.join(stateDir, 'sessions', `${h}.json`);
  mkdirSync(path.dirname(p), { recursive: true });
  const record = {
    schemaVersion: '1', state: 'SESSION_ACTIVE', lifecycle: [],
    taskId: `o/r#${issueNumber}`, repo: 'o/r', issueNumber,
    baseSha: 'b'.repeat(40), branch: 'soc/task-7', worktreePath: path.join(stateDir, 'wt'),
    identityHash: h, lease: { token: leaseToken },
  };
  if (ownerLaneId) record.mutationOwner = { laneId: ownerLaneId, since: 1, acquiredVia: 'canonical-admission' };
  writeFileSync(p, JSON.stringify(record, null, 2), 'utf8');
  return p;
}
const binding = (stateDir, { issueNumber = 7 } = {}) => ({
  identityHash: identityHash({ repo: 'o/r', issueNumber }),
  taskId: `o/r#${issueNumber}`, repo: 'o/r', issueNumber,
  baseSha: 'b'.repeat(40), branch: 'soc/task-7', path: path.join(stateDir, 'wt'),
});
const okVerify = () => ({ ok: true, session: { state: 'SESSION_ACTIVE' } });
const denyVerify = () => ({ ok: false, reason: 'LEASE_EXPIRED' });
const PROVIDER = { providerId: 'gemini', apiKeyEnv: 'FAKE_CLINE_KEY' };
const ENV_OK = { SOC_CLINE_SDK_ADAPTER: '1', FAKE_CLINE_KEY: 'k-test' };
// sessionPath is a param (not a spread-override) because canonicalSession()
// WRITES the fixture file: a plain spread would re-write it ownerless.
const BASE_SPEC = (stateDir, sessionPath = canonicalSession(stateDir)) => ({
  sessionPath,
  session: { leaseToken: 'tok-7' },
  binding: binding(stateDir),
  instruction: 'read-only analysis task',
  model: 'gemini-3.5-flash-lite',
  ...PROVIDER,
});

// ---- fakeClineCore: deterministic ClineCore surface used by the adapter --------
function fakeClineCore({ scenario } = {}) {
  const log = [];
  let listeners = new Set();
  let sessionId = null;
  let startResolve = null;
  let aborted = false;
  const emit = (ev) => { for (const l of [...listeners]) l(ev); };
  return {
    log,
    version: 'fake-core-1.2.3',
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit,
    async start({ prompt, config, interactive }) {
      log.push({ op: 'start', prompt, interactive, config });
      sessionId = `fake-sess-${scenario ?? 'default'}`;
      emit({ type: 'status', payload: { sessionId, status: 'running' } });
      emit({ type: 'agent_event', payload: { sessionId, event: { type: 'iteration_start', iteration: 1 } } });
      emit({ type: 'agent_event', payload: { sessionId, event: { type: 'content_start', contentType: 'text', text: 'analyzing ' } } });
      emit({ type: 'agent_event', payload: { sessionId, event: { type: 'content_start', contentType: 'tool', toolName: 'read_files' } } });
      emit({ type: 'agent_event', payload: { sessionId, event: { type: 'content_end', contentType: 'tool', toolName: 'read_files' } } });
      emit({ type: 'agent_event', payload: { sessionId, event: { type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } } } });
      emit({ type: 'agent_event', payload: { sessionId, event: { type: 'iteration_end', iteration: 1 } } });
      if (scenario === 'deferred') {
        await new Promise((res) => { startResolve = res; });
      }
      const finishReason = aborted ? 'aborted'
        : scenario === 'error' ? 'error'
        : scenario === 'maxiter' ? 'max_iterations'
        : scenario === 'unknown' ? 'weird_reason'
        : scenario === 'interactive' ? null
        : 'completed';
      if (interactive) return { sessionId, manifestPath: path.join(TMP, 'm.json'), messagesPath: path.join(TMP, 'ms.json'), result: null };
      return { sessionId, manifestPath: null, messagesPath: null, result: { finishReason, text: `RESULT: ${finishReason ?? 'idle'}`, usage: { inputTokens: 100, outputTokens: 10 }, toolCalls: [{ toolName: 'read_files' }], iterations: 1, durationMs: 5 } };
    },
    async send({ sessionId: sid, prompt }) {
      log.push({ op: 'send', sessionId: sid, prompt });
      if (scenario === 'send-throws') {
        const e = new Error('session not found: fake-sess-interactive');
        e.name = 'SessionNotFoundError'; e.code = 'session_not_found';
        throw e;
      }
      emit({ type: 'agent_event', payload: { sessionId: sid, event: { type: 'content_start', contentType: 'text', text: 'slugify' } } });
      return { finishReason: 'completed', text: 'RESULT: slugify', toolCalls: [], iterations: 1, durationMs: 3, usage: { inputTokens: 5, outputTokens: 1 } };
    },
    async abort(sid, reason) {
      log.push({ op: 'abort', sessionId: sid, reason });
      aborted = true;
      emit({ type: 'ended', payload: { sessionId: sid, reason: 'aborted' } });
      if (startResolve) { startResolve(); startResolve = null; }
      return { ok: true };
    },
    async dispose(reason) { log.push({ op: 'dispose', reason }); return { ok: true }; },
  };
}

function makeAdapter(stateDir, { scenario, env = ENV_OK, verifyAuthority = okVerify, enabled = true, provider = PROVIDER, factoryGate = null } = {}) {
  const runtime = fakeClineCore({ scenario });
  let factoryCalls = 0;
  const created = createClineSdkExecutor({
    stateDir, enabled, env, verifyAuthority,
    runtimeFactory: async () => {
      factoryCalls += 1;
      if (factoryGate) await factoryGate();
      return { instance: runtime, version: runtime.version };
    },
    provider,
  });
  return { adapter: created.value, runtime, factoryCalls: () => factoryCalls };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- pure mapping tables --------------------------------------------------------
{
  eq('map: status event', mapCoreSessionEvent({ type: 'status', payload: { status: 'running', sessionId: 's1' } }).event.type, 'cline_status');
  eq('map: text delta kind', mapCoreSessionEvent({ type: 'agent_event', payload: { event: { type: 'content_start', contentType: 'text', text: 'hi' } } }).kind, 'text');
  eq('map: tool start kind', JSON.stringify(mapCoreSessionEvent({ type: 'agent_event', payload: { event: { type: 'content_start', contentType: 'tool', toolName: 'editor' } } })), JSON.stringify({ kind: 'tool', tool: 'editor', phase: 'start', event: { type: 'content_start', contentType: 'tool', toolName: 'editor' } }));
  eq('map: iteration start', mapCoreSessionEvent({ type: 'agent_event', payload: { event: { type: 'iteration_start' } } }).kind, 'step_start');
  eq('map: ended kind', mapCoreSessionEvent({ type: 'ended', payload: { reason: 'aborted' } }).event.reason, 'aborted');
  eq('map: unknown top-level => null (lifecycle never inferred)', mapCoreSessionEvent({ type: 'mystery' }), null);
  eq('map: chunk => output passthrough', mapCoreSessionEvent({ type: 'chunk', payload: { chunk: 'raw' } }).kind, 'output');
  eq('lifecycle: completed => EXITED/0', JSON.stringify(mapTerminalOutcome({ finishReason: 'completed' })), JSON.stringify({ terminalStatus: 'EXITED', exitCode: 0, reason: null }));
  eq('lifecycle: error => FAILED', mapTerminalOutcome({ finishReason: 'error' }).terminalStatus, 'FAILED');
  eq('lifecycle: aborted+cancel => STOPPED/CONTROL_PLANE_STOP', mapTerminalOutcome({ finishReason: 'aborted', cancelRequested: true }).reason, 'CONTROL_PLANE_STOP');
  eq('lifecycle: aborted w/o cancel => STOPPED/CLINE_ABORTED_BY_RUNTIME', mapTerminalOutcome({ finishReason: 'aborted' }).reason, 'CLINE_ABORTED_BY_RUNTIME');
  eq('lifecycle: unknown reason fail-closed', mapTerminalOutcome({ finishReason: 'zzz' }).reason, 'CLINE_UNKNOWN_FINISH_REASON: zzz');
  eq('lifecycle: thrown error fail-closed', mapTerminalOutcome({ error: new Error('boom') }).terminalStatus, 'FAILED');
  eq('lifecycle: SDK_TO_CANONICAL frozen', Object.isFrozen(SDK_TO_CANONICAL), true);
  eq('policies: readonly default', buildToolPolicies({}).editor.enabled, false);
  eq('policies: allow unlocks mutation tools', buildToolPolicies({ mutation: 'allow' }).run_commands.enabled, true);
  eq('policies: ask always disabled', buildToolPolicies({ mutation: 'allow' }).ask_question.enabled, false);
  eq('policies: fetch always disabled', buildToolPolicies({ mutation: 'allow' }).fetch_web_content.enabled, false);
}

// ---- factory gates (default-off) -------------------------------------------------
{
  const S = path.join(TMP, 'g1'); mkdirSync(S, { recursive: true });
  const off = createClineSdkExecutor({ stateDir: S });
  eq('gate: default disabled', off.ok === false && off.code, 'CLINE_SDK_ADAPTER_DISABLED');
  const un = createClineSdkExecutor({ stateDir: S, enabled: true, env: {}, runtimeFactory: async () => ({}), provider: PROVIDER });
  eq('gate: not armed without env', un.ok === false && un.code, 'CLINE_SDK_ADAPTER_NOT_ARMED');
  const nostate = createClineSdkExecutor({});
  eq('gate: stateDir required', nostate.ok === false && nostate.code, 'STATE_DIR_REQUIRED');
  const armed = createClineSdkExecutor({ stateDir: S, enabled: true, env: ENV_OK, runtimeFactory: async () => ({}), provider: PROVIDER });
  tru('gate: armed ok', armed.ok === true);
}

// ---- start: authority + validation failures (canonical chain re-derivation) ------
{
  const S = path.join(TMP, 'a1'); mkdirSync(S, { recursive: true });
  const { adapter } = makeAdapter(S);
  const spec = BASE_SPEC(S);
  const r0 = await adapter.start({ ...spec, session: null });
  eq('start: no session => rejected', r0.code, 'SESSION_AUTHORITY_REJECTED');
  const deny = makeAdapter(S, { verifyAuthority: denyVerify }).adapter;
  const r2 = await deny.start(spec);
  eq('start: authority denied => rejected', r2.code, 'SESSION_AUTHORITY_REJECTED');
  const r3 = await adapter.start({ ...spec, sessionPath: undefined });
  eq('start: missing sessionPath => rejected', r3.code, 'SESSION_AUTHORITY_REJECTED');
  // canonical session vs binding mismatch (identity assert reads the file)
  const otherS = path.join(TMP, 'a1-other'); mkdirSync(otherS, { recursive: true });
  const sp = canonicalSession(otherS, { issueNumber: 99 });
  const r4 = await adapter.start({ ...spec, sessionPath: sp });
  eq('start: identity mismatch => fail-closed', r4.code, 'EXECUTION_IDENTITY_MISMATCH');
  const r5 = await adapter.start({ ...spec, instruction: '   ' });
  eq('start: empty instruction rejected', r5.code, 'INSTRUCTION_INVALID');
  const r6 = await adapter.start({ ...spec, instruction: 'x'.repeat(8193) });
  eq('start: oversized instruction rejected', r6.code, 'INSTRUCTION_INVALID');
  const r7 = await adapter.start({ ...spec, model: 'bad model;rm' });
  eq('start: bad model rejected', r7.code, 'MODEL_INVALID');
  const r8 = await adapter.start({ ...spec, apiKeyEnv: 'MISSING_KEY_ENV' });
  eq('start: provider key missing => fail-closed', r8.code, 'CLINE_PROVIDER_NOT_CONFIGURED');
  const r8b = await adapter.start({ ...spec, model: undefined });
  eq('start: missing modelId => fail-closed (SDK requires string)', r8b.code, 'CLINE_MODEL_REQUIRED');
  eq('start: failures wrote no record', readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 7 }).reason, 'EXECUTION_NOT_FOUND');
  const r9 = await createClineSdkExecutor({
    stateDir: S, enabled: true, env: ENV_OK, verifyAuthority: okVerify, provider: PROVIDER,
    runtimeFactory: async () => { throw new Error('no sdk here'); },
  }).value.start(BASE_SPEC(S));
  eq('start: sdk unavailable => fail-closed', r9.code, 'CLINE_SDK_UNAVAILABLE');
  eq('start: sdk-unavailable wrote no record', readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 7 }).reason, 'EXECUTION_NOT_FOUND');
}

// ---- CONTROL: start -> running -> completed (typed events + record read-back) ---
{
  const S = path.join(TMP, 'c1'); mkdirSync(path.join(S, 'wt'), { recursive: true });
  const { adapter, runtime } = makeAdapter(S);
  const r = await adapter.start(BASE_SPEC(S));
  tru('control: start ok', r.ok);
  const exId = r.value.executionId;
  eq('control: executionId == canonical identityHash', exId, IDH);
  eq('control: status STARTING', r.value.status, 'STARTING');
  await sleep(10);
  const st = readExecutionStatus({ stateDir: S, repo: 'o/r', issueNumber: 7 });
  eq('control: terminal EXITED', st.execution.terminalStatus, 'EXITED');
  eq('control: exitCode 0', st.execution.exitCode, 0);
  eq('control: executor id', st.execution.executor, CLINE_EXECUTOR_ID);
  eq('control: sdk version bound', st.execution.executorVersion, 'fake-core-1.2.3');
  eq('control: sessionId bound into record', st.execution.sessionId, 'fake-sess-default');
  // typed events via the canonical activity reader (no scraping: written from
  // typed CoreSessionEvent subscriptions)
  tru('control: activity readable', st.activity.ok);
  const kinds = st.activity.items.map((i) => i.kind);
  tru('control: text event present', kinds.includes('text'));
  tru('control: tool event present', kinds.includes('tool'));
  tru('control: step events present', kinds.includes('step_start') && kinds.includes('step_finish'));
  tru('control: status event present', st.activity.items.some((i) => i.event?.type === 'cline_status' && i.event.status === 'running'));
  tru('control: usage event present', st.activity.items.some((i) => i.event?.type === 'cline_usage'));
  // identity + result
  const idn = adapter.getExecutionIdentity(exId);
  eq('identity: canonical worktree bound', idn.value.canonical.worktreePath, path.join(S, 'wt'));
  eq('identity: cline sessionId', idn.value.cline.sessionId, 'fake-sess-default');
  eq('identity: adapter version', idn.value.versions.adapter, ADAPTER_VERSION);
  eq('identity: dataDir per execution', idn.value.cline.clineDataDir, clineDataDir({ stateDir: S, identityHash: IDH }));
  const res = adapter.getResult(exId);
  eq('result: sdkFinishReason', res.value.sdkFinishReason, 'completed');
  eq('result: toolCalls collected', JSON.stringify(res.value.toolCalls), JSON.stringify(['read_files']));
  eq('result: usage captured', JSON.stringify(res.value.usage), JSON.stringify({ inputTokens: 100, outputTokens: 10 }));
  tru('control: runtime disposed on finalize (no file-handle leak)', runtime.log.some((l) => l.op === 'dispose'));
  // observe(): typed stream drains then signals done for a terminal execution
  const obs = adapter.observe(exId);
  let drained = 0; let sawDone = false;
  for (;;) {
    const n = await obs.next();
    if (n.done) { sawDone = true; break; }
    drained += 1;
  }
  eq('observe: drained all mapped items', drained, obs.items().length);
  tru('observe: done after terminal', sawDone);
  // no child-agent/team spawn, no hub, explicit cwd
  const startCall = runtime.log.find((l) => l.op === 'start');
  eq('control: enableSpawnAgent false', startCall.config.enableSpawnAgent, false);
  eq('control: enableAgentTeams false', startCall.config.enableAgentTeams, false);
  eq('control: cwd pinned to worktree', startCall.config.cwd, path.resolve(path.join(S, 'wt')));
  eq('control: workspaceRoot pinned', startCall.config.workspaceRoot, path.resolve(path.join(S, 'wt')));
  eq('control: interactive flag off', startCall.interactive, false);
  tru('control: apiKey not persisted in record', !JSON.stringify(readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 7 }).record).includes('k-test'));
}

// ---- CONTROL: failure mapping ----------------------------------------------------
{
  for (const [scenario, reason, status] of [
    ['error', 'CLINE_FINISH_ERROR', 'FAILED'],
    ['maxiter', 'CLINE_MAX_ITERATIONS', 'FAILED'],
    ['unknown', 'CLINE_UNKNOWN_FINISH_REASON: weird_reason', 'FAILED'],
  ]) {
    const S = path.join(TMP, `f-${scenario}`); mkdirSync(S, { recursive: true });
    const { adapter } = makeAdapter(S, { scenario });
    const r = await adapter.start(BASE_SPEC(S));
    tru(`fail(${scenario}): start ok`, r.ok);
    await sleep(10);
    const rec = readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 7 });
    eq(`fail(${scenario}): terminal`, rec.record.terminalStatus, status);
    eq(`fail(${scenario}): reason`, rec.record.reason, reason);
  }
  const S = path.join(TMP, 'f-throw'); mkdirSync(S, { recursive: true });
  // runtime.start throwing synchronously inside start() => CLINE_START_FAILED
  const thrown = await createClineSdkExecutor({
    stateDir: S, enabled: true, env: ENV_OK, verifyAuthority: okVerify, provider: PROVIDER,
    runtimeFactory: async () => ({ instance: { subscribe: () => () => {}, start: () => { throw new Error('kaboom'); } }, version: 'x' }),
  }).value.start(BASE_SPEC(S));
  eq('fail(throw): start rejected typed', thrown.code, 'CLINE_START_FAILED');
  // runtime.start rejecting async => record FAILED CLINE_RUNTIME_ERROR
  const rej = await createClineSdkExecutor({
    stateDir: S, enabled: true, env: ENV_OK, verifyAuthority: okVerify, provider: PROVIDER,
    runtimeFactory: async () => ({ instance: { subscribe: () => () => {}, start: () => Promise.reject(new Error('async boom')) }, version: 'x' }),
  }).value.start(BASE_SPEC(S));
  tru('fail(async): start ok', rej.ok);
  await sleep(10);
  eq('fail(async): record FAILED', readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 7 }).record.terminalStatus, 'FAILED');
  tru('fail(async): reason carries error', (readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 7 }).record.reason || '').includes('CLINE_RUNTIME_ERROR'));
}

// ---- CONTROL: abort -> cancelled (deferred start; no pid/timeout ownership) ------
{
  const S = path.join(TMP, 'cancel'); mkdirSync(S, { recursive: true });
  const { adapter, runtime } = makeAdapter(S, { scenario: 'deferred' });
  const r = await adapter.start(BASE_SPEC(S));
  tru('cancel: start ok', r.ok);
  const exId = r.value.executionId;
  eq('cancel: record RUNNING while deferred', readExecutionStatus({ stateDir: S, repo: 'o/r', issueNumber: 7 }).execution.status, 'RUNNING');
  const c = await adapter.cancel(exId);
  tru('cancel: ok', c.ok);
  eq('cancel: STOPPED', c.value.status, 'STOPPED');
  eq('cancel: reason CONTROL_PLANE_STOP', c.value.reason, 'CONTROL_PLANE_STOP');
  eq('cancel: runtime.abort called with bound sessionId', runtime.log.find((l) => l.op === 'abort').sessionId, 'fake-sess-deferred');
  const rec = readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 7 }).record;
  eq('cancel: record STOPPED', rec.terminalStatus, 'STOPPED');
  const c2 = await adapter.cancel(exId);
  eq('cancel: already terminal rejected', c2.code, 'EXECUTION_ALREADY_TERMINAL');
}

// ---- CONTROL: resume authorized / fail-closed -------------------------------------
{
  const S = path.join(TMP, 'resume'); mkdirSync(S, { recursive: true });
  const { adapter, runtime } = makeAdapter(S, { scenario: 'interactive' });
  const spec = { ...BASE_SPEC(S), interactive: true, instruction: 'interactive first turn' };
  const r = await adapter.start(spec);
  tru('resume: interactive start ok', r.ok);
  const exId = r.value.executionId;
  await sleep(10);
  const recAfterStart = readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 7 }).record;
  eq('resume: interactive start stays non-terminal', recAfterStart.terminalStatus, null);
  const res = await adapter.resume({ executionId: exId, prompt: 'what did you read?' });
  tru('resume: authorized continuation ok', res.ok);
  eq('resume: terminal EXITED after turn', res.value.status, 'EXITED');
  tru('resume: model remembered context', /slugify/.test(res.value.text));
  eq('resume: send called with bound sessionId', runtime.log.find((l) => l.op === 'send').sessionId, 'fake-sess-interactive');
  // fail-closed paths
  const S2 = path.join(TMP, 'resume2'); mkdirSync(S2, { recursive: true });
  const nonInteractive = makeAdapter(S2).adapter;
  const r2 = await nonInteractive.start(BASE_SPEC(S2));
  await sleep(10);
  const res2 = await nonInteractive.resume({ executionId: r2.value.executionId, prompt: 'x' });
  eq('resume: non-interactive rejected', res2.code, 'CLINE_RESUME_REJECTED');
  const res3 = await nonInteractive.resume({ executionId: 'nonexistent', prompt: 'x' });
  eq('resume: foreign executionId rejected', res3.code, 'CLINE_RESUME_REJECTED');
  const res4 = await nonInteractive.resume({ executionId: r2.value.executionId, prompt: 'x' });
  eq('resume: terminal execution rejected', res4.code, 'CLINE_RESUME_REJECTED');
  const res5 = await nonInteractive.resume({ executionId: r2.value.executionId, prompt: '  ' });
  eq('resume: empty prompt rejected', res5.code, 'INSTRUCTION_INVALID');
  // SDK-typed resume failure surfaces typed + fails the record closed
  const S3 = path.join(TMP, 'resume3'); mkdirSync(S3, { recursive: true });
  const throws = makeAdapter(S3, { scenario: 'send-throws' });
  const r3 = await throws.adapter.start({ ...BASE_SPEC(S3), interactive: true });
  await sleep(10);
  const res6 = await throws.adapter.resume({ executionId: r3.value.executionId, prompt: 'x' });
  eq('resume: SDK typed error => rejected', res6.code, 'CLINE_RESUME_REJECTED');
  eq('resume: typed error code surfaced', res6.detail.errorCode, 'session_not_found');
  eq('resume: record failed closed', readExecutionRecord({ stateDir: S3, repo: 'o/r', issueNumber: 7 }).record.terminalStatus, 'FAILED');
}

// ---- OWNERSHIP: invariant 15 — adapter never touches canonical session/FSM --------
{
  const S = path.join(TMP, 'own'); mkdirSync(path.join(S, 'wt'), { recursive: true });
  const sessionPath = canonicalSession(S);
  const before = readFileSync(sessionPath);
  const { adapter, runtime } = makeAdapter(S);
  const r = await adapter.start(BASE_SPEC(S));
  await sleep(10);
  const rec = readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 7 }).record;
  eq('own: executionId <-> sessionId stable', rec.sessionId, 'fake-sess-default');
  eq('own: lifecycle cancel/restart leaves session FSM untouched', readFileSync(sessionPath).equals(before), true);
  // relaunch after terminal (launcher parity) — still no owner minting
  const r2 = await adapter.start(BASE_SPEC(S));
  tru('own: relaunch after terminal ok', r2.ok);
  await sleep(10);
  eq('own: session file STILL byte-identical after relaunch', readFileSync(sessionPath).equals(before), true);
  // record shape: adapter adds no ownership fields beyond the canonical set
  const allowedKeys = new Set(['schemaVersion', 'kind', 'identityHash', 'taskId', 'repo', 'issueNumber', 'baseSha', 'branch', 'worktreePath', 'executor', 'executorVersion', 'adapterVersion', 'agent', 'toolCaps', 'model', 'providerId', 'laneId', 'pid', 'startedAt', 'finishedAt', 'exitCode', 'signal', 'terminalStatus', 'reason', 'instructionDigest', 'instructionBytes', 'sessionId', 'eventsPath', 'eventsOverflow', 'clineDataDir', 'interactive', 'finalized', 'clineManifestPath', 'clineMessagesPath']);
  const extra = Object.keys(readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 7 }).record).filter((k) => !allowedKeys.has(k));
  eq('own: no minted ownership fields', JSON.stringify(extra), '[]');
  // second unrelated execution: isolated records + data dirs
  const otherSpec = { ...BASE_SPEC(S), sessionPath: canonicalSession(S, { issueNumber: 8 }), binding: binding(S, { issueNumber: 8 }) };
  const r3 = await adapter.start(otherSpec);
  tru('own: second unrelated execution ok', r3.ok);
  tru('own: distinct identityHash', r3.value.executionId !== r.value.executionId);
  tru('own: distinct data dirs', clineDataDir({ stateDir: S, identityHash: r.value.executionId }) !== clineDataDir({ stateDir: S, identityHash: r3.value.executionId }));
  eq('own: unrelated execution has its own sessionId', readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 8 }).record.sessionId, 'fake-sess-default');
  void runtime;
}

// ---- STORAGE HYGIENE (measured) ---------------------------------------------------
{
  const S = path.join(TMP, 'store'); mkdirSync(path.join(S, 'wt'), { recursive: true });
  const { adapter, runtime } = makeAdapter(S);
  const m0 = measureExecutionStorage({ stateDir: S, identityHash: IDH });
  eq('storage: before start generatedBytes', m0.generatedBytes, 0);
  await adapter.start(BASE_SPEC(S));
  await sleep(10);
  // fake runtime "SDK store" bytes inside the per-execution data dir
  const dd = clineDataDir({ stateDir: S, identityHash: IDH });
  mkdirSync(path.join(dd, 'logs'), { recursive: true });
  writeFileSync(path.join(dd, 'sessions.db'), 'x'.repeat(1024));
  writeFileSync(path.join(dd, 'logs', 'cline.log'), 'y'.repeat(512));
  const m1 = measureExecutionStorage({ stateDir: S, identityHash: IDH });
  tru('storage: generatedBytes > 0', m1.generatedBytes > 0);
  tru('storage: generatedFileCount > 0', m1.generatedFileCount > 0);
  eq('storage: artifact location canonical', m1.locations.clineDataDir, dd);
  tru('storage: record bytes counted', m1.executionRecordBytes > 0);
  tru('storage: events bytes counted', m1.executionEventsBytes > 0);
  const generatedBefore = m1.generatedBytes;
  const gc = await cleanupExecutionArtifacts({ stateDir: S, identityHash: IDH });
  tru('storage: gc ok after EXITED', gc.ok);
  eq('storage: reclaimed == clineData bytes', gc.reclaimedBytes, m1.clineDataBytes);
  eq('storage: remaining data bytes after cleanup', gc.remainingBytesAfterCleanup, 0);
  const m2 = measureExecutionStorage({ stateDir: S, identityHash: IDH });
  tru('storage: canonical evidence KEPT (record+events)', m2.executionRecordBytes > 0 && m2.executionEventsBytes > 0);
  eq('storage: generatedBytes shrank to evidence-only', m2.generatedBytes, m2.executionRecordBytes + m2.executionEventsBytes);
  tru('storage: bytes bounded (evidence < pre-gc total)', m2.generatedBytes < generatedBefore);
  // refuse GC while RUNNING with live host pid
  const S2 = path.join(TMP, 'store2'); mkdirSync(S2, { recursive: true });
  const recP = path.join(S2, 'executions', `${IDH}.json`);
  mkdirSync(path.dirname(recP), { recursive: true });
  writeFileSync(recP, JSON.stringify({ schemaVersion: '1', identityHash: IDH, pid: process.pid, terminalStatus: null, finalized: false }, null, 2));
  const busy = await cleanupExecutionArtifacts({ stateDir: S2, identityHash: IDH });
  eq('storage: gc refuses live execution', busy.code, 'EXECUTION_STILL_ACTIVE');
  // simulated abnormal termination: non-terminal record, dead host pid.
  // Safe window first (dead pid + unfinalized still projects RUNNING, launcher
  // parity), then the explicit control-plane repair marks INTERRUPTED, then
  // the orphan footprint is measured and reclaimable.
  writeFileSync(recP, JSON.stringify({ schemaVersion: '1', identityHash: IDH, pid: 999999999, terminalStatus: null, finalized: false }, null, 2));
  mkdirSync(path.join(S2, 'cline-data', IDH), { recursive: true });
  writeFileSync(path.join(S2, 'cline-data', IDH, 'sessions.db'), 'z'.repeat(256));
  const beforeMark = probeOrphanArtifacts({ stateDir: S2, identityHash: IDH });
  eq('storage: unfinalized dead-host stays RUNNING (safe)', beforeMark.status, 'RUNNING');
  eq('storage: nothing reclaimable while unmarked', beforeMark.reclaimable, false);
  // repair refuses while the host pid is provably alive
  writeFileSync(recP, JSON.stringify({ schemaVersion: '1', identityHash: IDH, pid: process.pid, terminalStatus: null, finalized: false }, null, 2));
  const liveRefuse = markExecutionInterrupted({ stateDir: S2, identityHash: IDH });
  eq('storage: repair refuses live host', liveRefuse.code, 'HOST_STILL_ALIVE');
  // host provably dead => repair marks INTERRUPTED
  writeFileSync(recP, JSON.stringify({ schemaVersion: '1', identityHash: IDH, pid: 999999999, terminalStatus: null, finalized: false }, null, 2));
  const mark = markExecutionInterrupted({ stateDir: S2, identityHash: IDH });
  tru('storage: repair marks INTERRUPTED (host provably dead)', mark.ok);
  const orphan2 = probeOrphanArtifacts({ stateDir: S2, identityHash: IDH });
  eq('storage: orphan detected after crash', orphan2.orphan, true);
  tru('storage: orphanBytes measured', orphan2.orphanBytes > 0);
  const reclaim = await cleanupExecutionArtifacts({ stateDir: S2, identityHash: IDH });
  tru('storage: orphan reclaimable', reclaim.ok && reclaim.reclaimedBytes > 0);
  const remark = markExecutionInterrupted({ stateDir: S2, identityHash: IDH });
  eq('storage: repair idempotent-guard (already terminal)', remark.code, 'EXECUTION_ALREADY_TERMINAL');
  // non-terminal record with LIVE pid is NOT an orphan
  writeFileSync(recP, JSON.stringify({ schemaVersion: '1', identityHash: IDH, pid: process.pid, terminalStatus: null, finalized: false }, null, 2));
  const live = probeOrphanArtifacts({ stateDir: S2, identityHash: IDH });
  eq('storage: live non-terminal not orphan', live.orphan, false);
  eq('storage: live host alive', live.hostAlive, true);
  void runtime;
}

// ---- dispose cleanup ----------------------------------------------------------------
{
  const S = path.join(TMP, 'disp'); mkdirSync(S, { recursive: true });
  const { adapter, runtime } = makeAdapter(S, { scenario: 'deferred' });
  const r = await adapter.start(BASE_SPEC(S));
  tru('dispose: start ok', r.ok);
  const d = await adapter.dispose();
  tru('dispose: ok', d.ok);
  eq('dispose: aborted execution STOPPED', d.value.executions[0].status, 'STOPPED');
  tru('dispose: runtime.dispose called', runtime.log.some((l) => l.op === 'dispose'));
  const rec = readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 7 }).record;
  eq('dispose: record failed closed to STOPPED', rec.terminalStatus, 'STOPPED');
  const d2 = await adapter.dispose();
  tru('dispose: idempotent', d2.ok);
  const after = await adapter.cancel('whatever');
  eq('dispose: post-dispose cancel fail-closed', after.code, 'EXECUTION_NOT_ACTIVE');
}

// ---- double-launch guard (F3 host occupancy: one active execution per host) --
{
  const S = path.join(TMP, 'dbl'); mkdirSync(S, { recursive: true });
  const { adapter, factoryCalls } = makeAdapter(S, { scenario: 'deferred' });
  const r1 = await adapter.start(BASE_SPEC(S));
  tru('dbl: first start ok', r1.ok);
  const r2 = await adapter.start(BASE_SPEC(S));
  // same-identity relaunch while running: the per-execution guard is the most
  // specific rejection (host occupancy is asserted with distinct identities in f3)
  eq('dbl: second start while running rejected', r2.code, 'EXECUTION_ALREADY_RUNNING');
  eq('dbl: no extra runtime factory call for rejected start', factoryCalls(), 1);
  await adapter.dispose();
  const r3 = await adapter.start(BASE_SPEC(S));
  tru('dbl: relaunch after dispose ok', r3.ok);
  await adapter.dispose();
}

// ---- F1: mutation authorization binds the canonical mutation owner ------------
{
  // 1) owner lane + mutation allow => PASS
  const S1 = path.join(TMP, 'f1-ok'); mkdirSync(path.join(S1, 'wt'), { recursive: true });
  const { adapter: a1, factoryCalls: fc1 } = makeAdapter(S1);
  const okStart = await a1.start({ ...BASE_SPEC(S1, canonicalSession(S1, { ownerLaneId: 'lane-a' })), mutation: 'allow', laneId: 'lane-a' });
  tru('f1(1): owner lane + allow => start ok', okStart.ok);
  eq('f1(1): runtime factory called once', fc1(), 1);
  await sleep(10);
  eq('f1(1): execution EXITED', readExecutionRecord({ stateDir: S1, repo: 'o/r', issueNumber: 7 }).record.terminalStatus, 'EXITED');

  // 2) foreign lane => MUTATION_OWNER_CONFLICT, runtime factory NOT called
  const S2 = path.join(TMP, 'f1-conflict'); mkdirSync(path.join(S2, 'wt'), { recursive: true });
  const wt2Before = fs.readdirSync(path.join(S2, 'wt')).sort().join('|');
  const { adapter: a2, factoryCalls: fc2 } = makeAdapter(S2);
  const conflict = await a2.start({ ...BASE_SPEC(S2, canonicalSession(S2, { ownerLaneId: 'lane-a' })), mutation: 'allow', laneId: 'lane-b' });
  eq('f1(2): foreign lane => MUTATION_OWNER_CONFLICT', conflict.code, 'MUTATION_OWNER_CONFLICT');
  eq('f1(2): evidence ownerLaneId', conflict.detail?.ownerLaneId, 'lane-a');
  eq('f1(2): evidence presentedLaneId', conflict.detail?.presentedLaneId, 'lane-b');
  eq('f1(2): evidence repo', conflict.detail?.repo, 'o/r');
  eq('f1(2): evidence issueNumber', conflict.detail?.issueNumber, 7);
  eq('f1(2): evidence branch', conflict.detail?.branch, 'soc/task-7');
  eq('f1(2): evidence worktreePath', conflict.detail?.worktreePath, path.join(S2, 'wt'));
  eq('f1(2): runtime factory calls = 0', fc2(), 0);
  eq('f1(2): no ExecutionRecord on rejection', readExecutionRecord({ stateDir: S2, repo: 'o/r', issueNumber: 7 }).reason, 'EXECUTION_NOT_FOUND');
  falsy('f1(2): no cline data dir on rejection', fs.existsSync(clineDataDir({ stateDir: S2, identityHash: IDH })));
  falsy('f1(2): evidence NEVER carries lease token', JSON.stringify(conflict).includes('tok-7'));

  // 3) missing lane => MUTATION_OWNER_UNIDENTIFIED
  const S3 = path.join(TMP, 'f1-unidentified'); mkdirSync(path.join(S3, 'wt'), { recursive: true });
  const { adapter: a3, factoryCalls: fc3 } = makeAdapter(S3);
  const noLane = await a3.start({ ...BASE_SPEC(S3, canonicalSession(S3, { ownerLaneId: 'lane-a' })), mutation: 'allow' });
  eq('f1(3): missing lane => MUTATION_OWNER_UNIDENTIFIED', noLane.code, 'MUTATION_OWNER_UNIDENTIFIED');
  eq('f1(3): runtime factory calls = 0', fc3(), 0);

  // 4) unbound attempt (no canonical owner recorded) => MUTATION_OWNER_UNBOUND
  const S4 = path.join(TMP, 'f1-unbound'); mkdirSync(path.join(S4, 'wt'), { recursive: true });
  const { adapter: a4, factoryCalls: fc4 } = makeAdapter(S4);
  const unbound = await a4.start({ ...BASE_SPEC(S4, canonicalSession(S4)), mutation: 'allow', laneId: 'lane-a' });
  eq('f1(4): no recorded owner => MUTATION_OWNER_UNBOUND', unbound.code, 'MUTATION_OWNER_UNBOUND');
  eq('f1(4): runtime factory calls = 0', fc4(), 0);

  // 5) readonly foreign observer still admitted (no mutation-owner grant needed)
  const S5 = path.join(TMP, 'f1-observer'); mkdirSync(path.join(S5, 'wt'), { recursive: true });
  const { adapter: a5, factoryCalls: fc5 } = makeAdapter(S5);
  const obs = await a5.start({ ...BASE_SPEC(S5, canonicalSession(S5, { ownerLaneId: 'lane-a' })), mutation: 'readonly', laneId: 'lane-observer' });
  tru('f1(5): readonly foreign observer admitted', obs.ok);
  eq('f1(5): observer ran the runtime', fc5(), 1);
  await sleep(10);
  eq('f1(5): observer execution EXITED', readExecutionRecord({ stateDir: S5, repo: 'o/r', issueNumber: 7 }).record.terminalStatus, 'EXITED');

  // 6) HEAD/workspace/ExecutionRecord unchanged on every rejection above
  eq('f1(6): workspace untouched by rejection', fs.readdirSync(path.join(S2, 'wt')).sort().join('|'), wt2Before);
  eq('f1(6): conflict stateDir wrote no record either', readExecutionRecord({ stateDir: S2, repo: 'o/r', issueNumber: 7 }).reason, 'EXECUTION_NOT_FOUND');
}

// ---- F2: authority revalidated on resume (never held across turns) ------------
{
  // deterministic race: canonical transfer lane-a -> lane-b between start and resume
  const S = path.join(TMP, 'f2-race'); mkdirSync(path.join(S, 'wt'), { recursive: true });
  const sp = canonicalSession(S, { ownerLaneId: 'lane-a' });
  const wtFile = path.join(S, 'wt', 'marker.txt');
  writeFileSync(wtFile, 'pre-resume');
  const { adapter, runtime, factoryCalls } = makeAdapter(S);
  const r = await adapter.start({ ...BASE_SPEC(S, sp), mutation: 'allow', laneId: 'lane-a', interactive: true });
  tru('f2(race): interactive mutation start ok as lane-a', r.ok);
  eq('f2(race): factory called for start', factoryCalls(), 1);
  canonicalSession(S, { ownerLaneId: 'lane-b' }); // explicit canonical transfer (control-plane write)
  const sendsBefore = runtime.log.filter((l) => l.op === 'send').length;
  const res = await adapter.resume({ executionId: r.value.executionId, prompt: 'mutate now' });
  eq('f2(race): resume after transfer => MUTATION_OWNER_CONFLICT', res.code, 'MUTATION_OWNER_CONFLICT');
  eq('f2(race): conflict evidence ownerLaneId', res.detail?.ownerLaneId, 'lane-b');
  eq('f2(race): conflict evidence presentedLaneId', res.detail?.presentedLaneId, 'lane-a');
  eq('f2(race): SDK send count = 0 (fail closed BEFORE send)', runtime.log.filter((l) => l.op === 'send').length - sendsBefore, 0);
  tru('f2(race): workspace unchanged', readFileSync(wtFile).equals(Buffer.from('pre-resume')));
  falsy('f2(race): evidence never carries lease token', JSON.stringify(res).includes('tok-7'));

  // stale lease => fail closed before send
  const S3 = path.join(TMP, 'f2-stale'); mkdirSync(path.join(S3, 'wt'), { recursive: true });
  const { adapter: a3, runtime: rt3 } = makeAdapter(S3);
  const r3 = await a3.start({ ...BASE_SPEC(S3, canonicalSession(S3, { ownerLaneId: 'lane-a' })), mutation: 'allow', laneId: 'lane-a', interactive: true });
  tru('f2(stale): start ok', r3.ok);
  canonicalSession(S3, { ownerLaneId: 'lane-a', leaseToken: 'rotated-token' });
  const res3 = await a3.resume({ executionId: r3.value.executionId, prompt: 'x' });
  eq('f2(stale): stale lease => SESSION_AUTHORITY_REJECTED', res3.code, 'SESSION_AUTHORITY_REJECTED');
  eq('f2(stale): SDK send count = 0', rt3.log.filter((l) => l.op === 'send').length, 0);

  // terminal canonical session => fail closed before send
  const S4 = path.join(TMP, 'f2-terminal'); mkdirSync(path.join(S4, 'wt'), { recursive: true });
  const { adapter: a4, runtime: rt4 } = makeAdapter(S4);
  const r4 = await a4.start({ ...BASE_SPEC(S4, canonicalSession(S4, { ownerLaneId: 'lane-a' })), mutation: 'allow', laneId: 'lane-a', interactive: true });
  tru('f2(terminal): start ok', r4.ok);
  canonicalSession(S4, { ownerLaneId: 'lane-a', leaseToken: 'tok-7' });
  const sessPath = canonicalSession(S4, { ownerLaneId: 'lane-a' });
  const sessObj = JSON.parse(readFileSync(sessPath, 'utf8'));
  sessObj.state = 'COMPLETED';
  writeFileSync(sessPath, JSON.stringify(sessObj, null, 2), 'utf8');
  const res4 = await a4.resume({ executionId: r4.value.executionId, prompt: 'x' });
  eq('f2(terminal): terminal session => SESSION_NOT_ACTIVE', res4.code, 'SESSION_NOT_ACTIVE');
  eq('f2(terminal): SDK send count = 0', rt4.log.filter((l) => l.op === 'send').length, 0);

  // same-owner resume still passes (authorized continuation unchanged)
  const S5 = path.join(TMP, 'f2-ok'); mkdirSync(path.join(S5, 'wt'), { recursive: true });
  const { adapter: a5, runtime: rt5 } = makeAdapter(S5, { scenario: 'interactive' });
  const r5 = await a5.start({ ...BASE_SPEC(S5, canonicalSession(S5, { ownerLaneId: 'lane-a' })), mutation: 'allow', laneId: 'lane-a', interactive: true });
  tru('f2(ok): start ok', r5.ok);
  const res5 = await a5.resume({ executionId: r5.value.executionId, prompt: 'continue' });
  tru('f2(ok): same-owner resume PASS', res5.ok && res5.value?.status === 'EXITED');
  eq('f2(ok): SDK send called exactly once', rt5.log.filter((l) => l.op === 'send').length, 1);
  void adapter; void runtime;
}

// ---- F3: one active Cline execution per adapter host/process -------------------
{
  const S = path.join(TMP, 'f3'); mkdirSync(path.join(S, 'wt'), { recursive: true });
  const { adapter, factoryCalls } = makeAdapter(S, { scenario: 'deferred' });
  const a = await adapter.start(BASE_SPEC(S)); // execution A active (deferred)
  tru('f3: A active', a.ok);
  const bSpec = {
    ...BASE_SPEC(S),
    sessionPath: canonicalSession(S, { issueNumber: 8 }),
    binding: binding(S, { issueNumber: 8 }),
  };
  const b = await adapter.start(bSpec); // distinct execution B while host occupied
  eq('f3: distinct second start => CLINE_HOST_ALREADY_OCCUPIED', b.code, 'CLINE_HOST_ALREADY_OCCUPIED');
  eq('f3: runtime factory calls still 1 (B never reached factory)', factoryCalls(), 1);
  eq('f3: B identity recorded nothing', readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 8 }).reason, 'EXECUTION_NOT_FOUND');
  falsy('f3: B data dir never created', fs.existsSync(clineDataDir({ stateDir: S, identityHash: identityHash({ repo: 'o/r', issueNumber: 8 }) })));
  const d = await adapter.dispose(); // finalize/dispose A
  tru('f3: dispose ok', d.ok);
  const b2 = await adapter.start(bSpec); // B allowed after A terminal
  tru('f3: B startable after dispose', b2.ok);
  eq('f3: runtime factory called for B now', factoryCalls(), 2);
  await adapter.dispose();
}

// ---- F1 round 2: TOCTOU lock — revalidation RIGHT BEFORE cline.start ---------
{
  const S = path.join(TMP, 'f1b'); mkdirSync(path.join(S, 'wt'), { recursive: true });
  const wtBefore = fs.readdirSync(path.join(S, 'wt')).sort().join('|');
  let releaseBarrier;
  const barrier = new Promise((res) => { releaseBarrier = res; });
  const { adapter, runtime, factoryCalls } = makeAdapter(S, { factoryGate: () => barrier });
  const sp = canonicalSession(S, { ownerLaneId: 'lane-a' });
  const startP = adapter.start({ ...BASE_SPEC(S, sp), mutation: 'allow', laneId: 'lane-a' });
  // initial gates PASS synchronously; factory is now parked on the barrier
  const transferred = await Promise.resolve().then(() => {
    canonicalSession(S, { ownerLaneId: 'lane-b' }); // explicit canonical transfer mid-initialization
    releaseBarrier();
    return true;
  });
  tru('f1b: canonical transfer executed while factory parked', transferred);
  const r = await startP;
  eq('f1b(6): revalidation => MUTATION_OWNER_CONFLICT', r.code, 'MUTATION_OWNER_CONFLICT');
  eq('f1b(6): evidence ownerLaneId', r.detail?.ownerLaneId, 'lane-b');
  eq('f1b(6): evidence presentedLaneId', r.detail?.presentedLaneId, 'lane-a');
  eq('f1b(7): SDK start call count = 0', runtime.log.filter((l) => l.op === 'start').length, 0);
  eq('f1b(8): workspace unchanged', fs.readdirSync(path.join(S, 'wt')).sort().join('|'), wtBefore);
  tru('f1b(9): runtime disposed/released', runtime.log.some((l) => l.op === 'dispose'));
  falsy('f1b(10): evidence never carries lease token', JSON.stringify(r).includes('tok-7'));
  eq('f1b: record failed closed (no silent lane)', readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 7 }).record.terminalStatus, 'FAILED');
  tru('f1b: record reason carries the typed code', (readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 7 }).record.reason || '').includes('MUTATION_OWNER_CONFLICT'));
  eq('f1b: runtime factory called exactly once', factoryCalls(), 1);
  // host slot freed by the rejection: a fresh start (readonly) is admitted
  const again = await adapter.start({ ...BASE_SPEC(S, sp), mutation: 'readonly' });
  tru('f1b: host slot released after revalidation failure', again.ok);
  await sleep(10);
  eq('f1b: readonly rerun EXITED', readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 7 }).record.terminalStatus, 'EXITED');
  void factoryCalls;
}

// ---- F2 round 2: atomic host reservation (concurrent A/B) ----------------------
{
  const S = path.join(TMP, 'f2b'); mkdirSync(path.join(S, 'wt'), { recursive: true });
  let releaseA;
  const barrierA = new Promise((res) => { releaseA = res; });
  const { adapter, factoryCalls } = makeAdapter(S, { factoryGate: () => barrierA });
  const startA = adapter.start(BASE_SPEC(S)); // reserves slot, parks in factory
  await new Promise((r) => setTimeout(r, 20)); // let A reach the barrier
  const specB = {
    ...BASE_SPEC(S, canonicalSession(S, { issueNumber: 8 })),
    binding: binding(S, { issueNumber: 8 }),
  };
  const b = await adapter.start(specB); // B starts CONCURRENTLY while A reserved
  eq('f2b: B concurrent => CLINE_HOST_ALREADY_OCCUPIED', b.code, 'CLINE_HOST_ALREADY_OCCUPIED');
  eq('f2b: B sees START_RESERVED phase', b.detail?.phase, 'START_RESERVED');
  eq('f2b: runtime factory calls = 1 (B never reached factory)', factoryCalls(), 1);
  eq('f2b: B recorded nothing', readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 8 }).reason, 'EXECUTION_NOT_FOUND');
  releaseA(); // release A
  const ra = await startA;
  tru('f2b: A completes deterministically', ra.ok === true);
  await sleep(10);
  eq('f2b: A EXITED', readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 7 }).record.terminalStatus, 'EXITED');
  const b2 = await adapter.start(specB); // host slot released after A terminal
  tru('f2b: B startable after A terminal', b2.ok);
  await sleep(10);
  eq('f2b: B EXITED after run', readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 8 }).record.terminalStatus, 'EXITED');
}

// ---- F2 round 2: reservation released on EVERY failure path ---------------------
{
  // runtimeFactory throws ONCE after reservation, then succeeds
  const S1 = path.join(TMP, 'f2c-throw'); mkdirSync(S1, { recursive: true });
  let throwsLeft = 1;
  const oneShot = createClineSdkExecutor({
    stateDir: S1, enabled: true, env: ENV_OK, verifyAuthority: okVerify, provider: PROVIDER,
    runtimeFactory: async () => {
      if (throwsLeft > 0) { throwsLeft -= 1; throw new Error('sdk gone (once)'); }
      return { instance: { subscribe: () => () => {}, start: async () => ({ sessionId: 's1', result: { finishReason: 'completed', text: 'r', usage: {}, toolCalls: [], iterations: 1, durationMs: 1 } }), send: async () => ({}), abort: async () => ({}), dispose: async () => ({}) }, version: 'x' };
    },
  }).value;
  const r1 = await oneShot.start(BASE_SPEC(S1));
  eq('f2c: factory throw => CLINE_SDK_UNAVAILABLE', r1.code, 'CLINE_SDK_UNAVAILABLE');
  const r1b = await oneShot.start(BASE_SPEC(S1));
  tru('f2c: reservation released after factory throw (retry start PASS)', r1b.ok);
  await sleep(10);
  eq('f2c: retry EXITED', readExecutionRecord({ stateDir: S1, repo: 'o/r', issueNumber: 7 }).record.terminalStatus, 'EXITED');
  // cline.start synchronous throw AFTER reservation, then succeeds on relaunch
  const S2 = path.join(TMP, 'f2c-sync'); mkdirSync(S2, { recursive: true });
  let syncThrowsLeft = 1;
  const syncThrow = createClineSdkExecutor({
    stateDir: S2, enabled: true, env: ENV_OK, verifyAuthority: okVerify, provider: PROVIDER,
    runtimeFactory: async () => ({ instance: { subscribe: () => () => {}, start: () => { if (syncThrowsLeft > 0) { syncThrowsLeft -= 1; throw new Error('sync kaboom'); } return Promise.resolve({ sessionId: 's2', result: { finishReason: 'completed', text: 'r', usage: {}, toolCalls: [], iterations: 1, durationMs: 1 } }); } }, version: 'x' }),
  }).value;
  const r2 = await syncThrow.start(BASE_SPEC(S2));
  eq('f2c: sync start throw => CLINE_START_FAILED', r2.code, 'CLINE_START_FAILED');
  const r2b = await syncThrow.start(BASE_SPEC(S2));
  tru('f2c: reservation released after sync throw (relaunch PASS)', r2b.ok);
  await sleep(10);
  eq('f2c: relaunch EXITED', readExecutionRecord({ stateDir: S2, repo: 'o/r', issueNumber: 7 }).record.terminalStatus, 'EXITED');
  // dispose/terminal frees the host (covered by dbl + f3; slot explicitly asserted here)
  const S3 = path.join(TMP, 'f2c-dispose'); mkdirSync(S3, { recursive: true });
  const { adapter: a3 } = makeAdapter(S3, { scenario: 'deferred' });
  tru('f2c: A start ok', (await a3.start(BASE_SPEC(S3))).ok);
  await a3.dispose();
  tru('f2c: B start PASS after dispose', (await a3.start(BASE_SPEC(S3))).ok);
  await a3.dispose();
}

// ---- report -------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'ok' : 'FAIL'}  ${c.name}${c.ok ? '' : `  got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
console.log(`cline-sdk-adapter.test: ${checks.length - failed.length}/${checks.length} checks passed`);
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* windows handle lag */ }
if (failed.length) process.exit(1);
