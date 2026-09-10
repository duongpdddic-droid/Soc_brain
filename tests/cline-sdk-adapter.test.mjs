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
function canonicalSession(stateDir, { issueNumber = 7, leaseToken = 'tok-7' } = {}) {
  const h = identityHash({ repo: 'o/r', issueNumber });
  const p = path.join(stateDir, 'sessions', `${h}.json`);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({
    schemaVersion: '1', state: 'SESSION_ACTIVE', lifecycle: [],
    taskId: `o/r#${issueNumber}`, repo: 'o/r', issueNumber,
    baseSha: 'b'.repeat(40), branch: 'soc/task-7', worktreePath: path.join(stateDir, 'wt'),
    identityHash: h, lease: { token: leaseToken },
  }, null, 2), 'utf8');
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
const BASE_SPEC = (stateDir) => ({
  sessionPath: canonicalSession(stateDir),
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

function makeAdapter(stateDir, { scenario, env = ENV_OK, verifyAuthority = okVerify, enabled = true } = {}) {
  const runtime = fakeClineCore({ scenario });
  const created = createClineSdkExecutor({
    stateDir, enabled, env, verifyAuthority,
    runtimeFactory: async () => ({ instance: runtime, version: runtime.version }),
    provider: PROVIDER,
  });
  return { adapter: created.value, runtime };
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

// ---- double-launch guard ------------------------------------------------------------
{
  const S = path.join(TMP, 'dbl'); mkdirSync(S, { recursive: true });
  const { adapter } = makeAdapter(S, { scenario: 'deferred' });
  const r1 = await adapter.start(BASE_SPEC(S));
  tru('dbl: first start ok', r1.ok);
  const r2 = await adapter.start(BASE_SPEC(S));
  eq('dbl: second start while running rejected', r2.code, 'EXECUTION_ALREADY_RUNNING');
  await adapter.dispose();
  const r3 = await adapter.start(BASE_SPEC(S));
  tru('dbl: relaunch after dispose ok', r3.ok);
  await adapter.dispose();
}

// ---- report -------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'ok' : 'FAIL'}  ${c.name}${c.ok ? '' : `  got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
console.log(`cline-sdk-adapter.test: ${checks.length - failed.length}/${checks.length} checks passed`);
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* windows handle lag */ }
if (failed.length) process.exit(1);
