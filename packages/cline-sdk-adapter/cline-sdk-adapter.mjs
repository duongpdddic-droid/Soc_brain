#!/usr/bin/env node
// cline-sdk-adapter — NON-PRODUCTION MVP adapter embedding @cline/sdk (ClineCore,
// backendMode "local") behind the EXISTING canonical executor contract of
// packages/executor-launcher (Issue #147).
//
// Boundary (hard invariants, mirrors control-loop/adapters.mjs ownership rule):
//   - The adapter is an EXECUTION substrate only. It never writes the canonical
//     session record, never terminalizes a task, never merges, never closes an
//     issue, never sends TASK_COMPLETED. Cline/SDK is NOT lifecycle authority:
//     SDK finishReason is mapped INTO the canonical ExecutionRecord lifecycle,
//     and the ExecutionRecord stays observability evidence, not task truth.
//   - Single mutation owner (North Star v2.1.0 invariant 15): the adapter binds
//     to the canonical identity chain (verifySessionAuthority +
//     assertExecutionIdentity re-read from disk) and mints NO mutation
//     authority of its own. Per-execution state is isolated under
//     stateDir/cline-data/<identityHash> (CLINE_DATA_DIR), never the shared
//     ~/.cline. Cancellation/relaunch never touches the canonical session file.
//   - Default-off: createClineSdkExecutor() fails closed unless explicitly
//     enabled AND env SOC_CLINE_SDK_ADAPTER=1. No production executor switch.
//   - No process-name ownership, no stdout scraping, no coarse polling: the
//     Cline runtime is embedded in-process; lifecycle facts come from typed
//     CoreSessionEvent subscriptions and the resolved start()/send() results.
//     Dead-host liveness reuses the canonical pid projection (effectiveStatus)
//     exactly like the opencode launcher — projection only, never an ownership
//     decision.
//
// Reused canonical surfaces (no parallel abstraction):
//   ExecutionRecord schema/paths/statuses + readExecutionStatus + activity
//   tail + identity assert come from executor-launcher. The activity stream
//   keeps the {seq,t,stream,kind,...} item shape and the presentation-only
//   kind vocabulary so every existing reader keeps working.
//
// No framework. Node >= 22. @cline/sdk is a LAZY optional import; deterministic
// tests inject a fake runtime factory.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifySessionAuthority, readSessionRecord } from '../runtime-sandbox/runtime-sandbox.mjs';
import {
  EXECUTION_SCHEMA_VERSION,
  assertExecutionIdentity,
  executionRecordPath,
  executionEventsPath,
  readExecutionRecord,
  effectiveStatus,
  ACTIVITY_FILE_MAX_BYTES,
  ACTIVITY_LINE_MAX_BYTES,
  INSTRUCTION_MAX_BYTES,
  MODEL_RE,
} from '../executor-launcher/executor-launcher.mjs';

export const CLINE_EXECUTOR_ID = 'cline-sdk';
export const ADAPTER_VERSION = '0.1.0-mvp';
export const ADAPTER_CLIENT_NAME = 'soc-brain-cline-sdk-adapter';

// Canonical execution lifecycle (executor-launcher statuses) is never
// redefined here; the SDK mapping table:
//   finishReason 'completed'            -> EXITED  (exitCode 0)
//   finishReason 'error'                -> FAILED  (CLINE_FINISH_ERROR)
//   finishReason 'max_iterations'       -> FAILED  (CLINE_MAX_ITERATIONS)
//   finishReason 'mistake_limit'        -> FAILED  (CLINE_MISTAKE_LIMIT)
//   finishReason 'aborted' via cancel() -> STOPPED (CONTROL_PLANE_STOP)
//   finishReason 'aborted' otherwise    -> STOPPED (CLINE_ABORTED_BY_RUNTIME)
export const SDK_TO_CANONICAL = Object.freeze({
  completed: 'EXITED',
  error: 'FAILED',
  max_iterations: 'FAILED',
  mistake_limit: 'FAILED',
  aborted: 'STOPPED',
});

// CoreSessionEvent -> canonical ExecutorEvent item mapping. Presentation kinds
// only (same vocabulary as executor-launcher.classifyEvent): text/tool/
// step_start/step_finish/event/output. No agent-loop FSM is ever derived.
export function mapCoreSessionEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  switch (ev.type) {
    case 'status':
      return { kind: 'event', event: { type: 'cline_status', status: ev.payload?.status ?? null, sessionId: ev.payload?.sessionId ?? null } };
    case 'ended':
      return { kind: 'event', event: { type: 'cline_ended', reason: ev.payload?.reason ?? null, sessionId: ev.payload?.sessionId ?? null } };
    case 'agent_event': {
      const a = ev.payload?.event;
      if (!a || typeof a !== 'object') return null;
      switch (a.type) {
        case 'iteration_start': return { kind: 'step_start', event: a };
        case 'iteration_end': return { kind: 'step_finish', event: a };
        case 'content_start':
          if (a.contentType === 'text') return { kind: 'text', text: typeof a.text === 'string' ? a.text.slice(0, ACTIVITY_LINE_MAX_BYTES) : '', event: a };
          if (a.contentType === 'tool') return { kind: 'tool', tool: a.toolName ?? null, phase: 'start', event: a };
          return { kind: 'event', event: a };
        case 'content_update':
          if (a.contentType === 'tool') return { kind: 'tool', tool: a.toolName ?? null, phase: 'update', event: a };
          return { kind: 'event', event: a };
        case 'content_end':
          if (a.contentType === 'tool') return { kind: 'tool', tool: a.toolName ?? null, phase: 'end', event: a };
          if (a.contentType === 'text') return { kind: 'event', event: { type: 'cline_text_end' } };
          return { kind: 'event', event: a };
        case 'usage': return { kind: 'event', event: { type: 'cline_usage', usage: a.usage ?? a ?? null } };
        case 'done': return { kind: 'event', event: { type: 'cline_done', sessionId: ev.payload?.sessionId ?? null } };
        case 'error': return { kind: 'event', event: { type: 'cline_error', error: a.error ?? a.message ?? String(a) } };
        default: return { kind: 'event', event: a };
      }
    }
    case 'chunk':
      return { kind: 'output', line: String(ev.payload?.chunk ?? '').slice(0, ACTIVITY_LINE_MAX_BYTES) };
    default:
      return null; // unknown top-level types are observability-null; lifecycle never inferred from them
  }
}

export function mapTerminalOutcome({ finishReason = null, cancelRequested = false, error = null } = {}) {
  if (error) return { terminalStatus: 'FAILED', exitCode: null, reason: `CLINE_RUNTIME_ERROR: ${String(error?.message ?? error).slice(0, 400)}` };
  const canonical = finishReason ? SDK_TO_CANONICAL[finishReason] : null;
  if (!canonical) return { terminalStatus: 'FAILED', exitCode: null, reason: `CLINE_UNKNOWN_FINISH_REASON: ${String(finishReason)}` };
  if (canonical === 'EXITED') return { terminalStatus: 'EXITED', exitCode: 0, reason: null };
  if (canonical === 'STOPPED') {
    return { terminalStatus: 'STOPPED', exitCode: null, reason: cancelRequested ? 'CONTROL_PLANE_STOP' : 'CLINE_ABORTED_BY_RUNTIME' };
  }
  const detail = finishReason === 'max_iterations' ? 'CLINE_MAX_ITERATIONS'
    : finishReason === 'mistake_limit' ? 'CLINE_MISTAKE_LIMIT' : 'CLINE_FINISH_ERROR';
  return { terminalStatus: 'FAILED', exitCode: null, reason: detail };
}

// Tool policy construction (fail-closed defaults): read-only by default;
// mutation tools only when spec.mutation === 'allow'. Web/skills/ask are always
// disabled for MVP. spawn/team are always disabled (no second mutation owner,
// no team lanes).
export function buildToolPolicies({ mutation = 'readonly' } = {}) {
  const allow = mutation === 'allow';
  return {
    read_files: { enabled: true, autoApprove: true },
    search_codebase: { enabled: true, autoApprove: true },
    submit_and_exit: { enabled: true, autoApprove: true },
    editor: { enabled: allow, ...(allow ? { autoApprove: true } : {}) },
    apply_patch: { enabled: allow, ...(allow ? { autoApprove: true } : {}) },
    run_commands: { enabled: allow, ...(allow ? { autoApprove: true } : {}) },
    fetch_web_content: { enabled: false },
    skills: { enabled: false },
    ask_question: { enabled: false },
  };
}

export function clineDataDir({ stateDir, identityHash: h }) {
  return path.join(path.resolve(stateDir), 'cline-data', h);
}

// ---- canonical mutation authority (Issue #147 rework F1/F2) -------------------
// Shape-compatible with the canonical mutation-owner record defined by the
// single-mutation-owner work (Issue #145: session.mutationOwner =
// { laneId, since, acquiredVia, history }). The adapter VERIFIES against the
// authoritative session record read from disk — it never mints, adopts or
// transfers ownership (that is control-plane authority only). When the
// canonical gate primitive from Issue #145 is available on the base branch,
// callers may inject it via `mutationGate`; the built-in verifier below is
// the fail-closed default and reads the SAME canonical shape.
export const MUTATION_LANE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,199}$/;

// mutation 'allow' requires a recorded canonical owner whose laneId equals
// the presented lane; 'readonly' needs NO mutation-owner grant (observer).
// Conflict evidence carries repo/issueNumber/branch/worktreePath +
// ownerLaneId + presentedLaneId — NEVER a lease token.
export function verifyCanonicalMutationAuthority({ session, laneId, mutation, binding = {} } = {}) {
  if (mutation !== 'allow') return { ok: true, observer: true };
  if (typeof laneId !== 'string' || !MUTATION_LANE_ID_RE.test(laneId)) {
    return { ok: false, code: 'MUTATION_OWNER_UNIDENTIFIED' };
  }
  const owner = (session && session.mutationOwner) || null;
  if (!owner || !owner.laneId) {
    return { ok: false, code: 'MUTATION_OWNER_UNBOUND' };
  }
  if (owner.laneId !== laneId) {
    return {
      ok: false,
      code: 'MUTATION_OWNER_CONFLICT',
      evidence: {
        repo: binding.repo ?? session.repo ?? null,
        issueNumber: binding.issueNumber ?? session.issueNumber ?? null,
        branch: binding.branch ?? session.branch ?? null,
        worktreePath: binding.worktreePath ?? session.worktreePath ?? null,
        ownerLaneId: owner.laneId,
        presentedLaneId: laneId,
      },
    };
  }
  return { ok: true, ownerLaneId: owner.laneId };
}

const NOOP_TELEMETRY = {
  setDistinctId() {}, setMetadata() {}, updateMetadata() {},
  setCommonProperties() {}, updateCommonProperties() {},
  isEnabled() { return false; },
  capture() {}, captureRequired() {},
  recordCounter() {}, recordHistogram() {}, recordGauge() {},
  flush: async () => {},
};

// Default runtime factory: the ONLY place @cline/sdk is touched (lazy import).
// The per-execution CLINE_DATA_DIR is pinned before create so the SDK never
// lands state in the shared ~/.cline.
export async function defaultClineRuntimeFactory({ dataDir } = {}) {
  process.env.CLINE_DATA_DIR = dataDir;
  const mod = await import('@cline/sdk');
  const cline = await mod.ClineCore.create({
    clientName: ADAPTER_CLIENT_NAME,
    backendMode: 'local',
    telemetry: NOOP_TELEMETRY,
  });
  return { instance: cline, version: mod.CORE_BUILD_VERSION ?? null };
}

function readRecord(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeRecordAtomic(p, obj) {
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, p);
}
function dirTree(dir) {
  let bytes = 0; let files = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) stack.push(fp);
      else if (e.isFile()) { files += 1; try { bytes += fs.statSync(fp).size; } catch { /* transient */ } }
    }
  }
  return { bytes, files };
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ---- storage hygiene (measured, deterministic GC by executionId) -------------
// Task-owned artifacts: stateDir/executions/<id>.{json,events.jsonl} (canonical
// evidence) + stateDir/cline-data/<id>/ (SDK session store). Nothing shared or
// user-level is ever touched: cleanup is scoped to the per-execution
// cline-data dir and refuses while the execution is alive.
export function measureExecutionStorage({ stateDir, identityHash: h }) {
  const dataDir = clineDataDir({ stateDir, identityHash: h });
  const rec = executionRecordPath({ stateDir, identityHash: h });
  const ev = executionEventsPath({ stateDir, identityHash: h });
  const stat = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
  const tree = dirTree(dataDir);
  return {
    identityHash: h,
    locations: {
      executionRecord: rec,
      executionEvents: ev,
      clineDataDir: dataDir,
    },
    executionRecordBytes: stat(rec),
    executionEventsBytes: stat(ev),
    clineDataBytes: tree.bytes,
    clineDataFiles: tree.files,
    generatedBytes: stat(rec) + stat(ev) + tree.bytes,
    generatedFileCount: (stat(rec) > 0 ? 1 : 0) + (stat(ev) > 0 ? 1 : 0) + tree.files,
  };
}

// Deterministic GC for ONE executionId. Fail-closed: refuses while the
// execution record projects RUNNING/STARTING with a live host pid. Removes
// only the per-execution cline-data dir (the SDK session store); the canonical
// execution record/events files are KEPT (review evidence). Returns the
// measured reclaimable bytes it actually freed.
export async function cleanupExecutionArtifacts({ stateDir, identityHash: h, isAlive = pidAlive } = {}) {
  const rec = readRecord(executionRecordPath({ stateDir, identityHash: h }));
  if (!rec) return { ok: false, code: 'EXECUTION_RECORD_MISSING' };
  const st = effectiveStatus(rec, isAlive);
  if (st === 'RUNNING' || st === 'STARTING') {
    return { ok: false, code: 'EXECUTION_STILL_ACTIVE', status: st };
  }
  const dataDir = clineDataDir({ stateDir, identityHash: h });
  const before = dirTree(dataDir);
  if (before.files > 0) {
    // Windows handle reality (measured, Issue #147): the SDK holds its
    // per-execution SQLite handle for the HOST process lifetime and opens it
    // WITHOUT FILE_SHARE_DELETE, so while the host lives NO process can delete
    // the store — a host-alive cleanup ends here with the typed
    // CLINE_DATA_DIR_LOCKED. This is bounded and per-execution: the bytes are
    // reclaimed deterministically (by executionId) after the host exits —
    // proven by the live smoke's abnormal-termination phase.
    let removed = false; let lastErr = null;
    for (let i = 0; i < 10 && !removed; i += 1) {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); removed = true; } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 300)); }
    }
    if (!removed) return { ok: false, code: 'CLINE_DATA_DIR_LOCKED', detail: String(lastErr?.message ?? lastErr) };
  }
  const after = dirTree(dataDir);
  return {
    ok: true,
    reclaimedBytes: before.bytes - after.bytes,
    reclaimedFiles: before.files - after.files,
    remainingBytesAfterCleanup: before.bytes - (before.bytes - after.bytes),
  };
}

// Orphan artifacts after an abnormal host termination: the record stays
// non-terminal. While the host pid cannot be proven dead, the canonical
// projection stays RUNNING (launcher safety window: exit-vs-finalize race) and
// NOTHING is reclaimable. markExecutionInterrupted() is the explicit
// control-plane repair: it terminalizes a stale non-terminal record as
// INTERRUPTED (HOST_LOST) ONLY when the host pid is provably dead — pid
// liveness is used as a FACT about the host, never as a mutation-ownership
// decision; the canonical session record is untouched.
export function markExecutionInterrupted({ stateDir, identityHash: h, isAlive = pidAlive, clock = Date.now } = {}) {
  const p = executionRecordPath({ stateDir, identityHash: h });
  const rec = readRecord(p);
  if (!rec) return { ok: false, code: 'EXECUTION_RECORD_MISSING' };
  if (rec.terminalStatus) return { ok: false, code: 'EXECUTION_ALREADY_TERMINAL', status: rec.terminalStatus };
  if (rec.pid != null && isAlive(rec.pid)) return { ok: false, code: 'HOST_STILL_ALIVE' };
  writeRecordAtomic(p, { ...rec, terminalStatus: 'INTERRUPTED', reason: 'HOST_LOST', finishedAt: clock(), exitCode: null, signal: null, finalized: true });
  return { ok: true, value: { executionId: h, terminalStatus: 'INTERRUPTED' } };
}

export function probeOrphanArtifacts({ stateDir, identityHash: h, isAlive = pidAlive } = {}) {
  const rec = readRecord(executionRecordPath({ stateDir, identityHash: h }));
  if (!rec) return { ok: false, code: 'EXECUTION_RECORD_MISSING' };
  const st = effectiveStatus(rec, isAlive);
  const alive = rec.pid != null && isAlive(rec.pid);
  const tree = dirTree(clineDataDir({ stateDir, identityHash: h }));
  if (st === 'RUNNING' || st === 'STARTING') {
    // launcher safety window (exit-vs-finalize race): nothing is an orphan and
    // nothing is reclaimable while the host cannot be proven dead.
    return { ok: true, orphan: false, status: st, orphanBytes: 0, leftoverBytes: tree.bytes, hostAlive: alive, reclaimable: false };
  }
  const orphan = rec.reason === 'HOST_LOST' || rec.terminalStatus === 'INTERRUPTED';
  return {
    ok: true,
    orphan,
    status: st,
    orphanBytes: orphan ? tree.bytes : 0,
    leftoverBytes: tree.bytes,
    hostAlive: alive,
    reclaimable: tree.bytes > 0,
  };
}

// ---- adapter ------------------------------------------------------------------
// One adapter host manages executions for ONE control-plane stateDir.
export function createClineSdkExecutor({
  stateDir,
  enabled = false,
  env = process.env,
  runtimeFactory = defaultClineRuntimeFactory,
  verifyAuthority = verifySessionAuthority,
  clock = Date.now,
  provider = null, // { providerId, apiKeyEnv } — key read from env at start, never stored
} = {}) {
  if (!stateDir || typeof stateDir !== 'string') {
    return { ok: false, code: 'STATE_DIR_REQUIRED' };
  }
  // Default-off gate at FACTORY level: an un-enabled / un-armed adapter never
  // exists as a callable object. start()/resume() re-check arming (env may
  // change between construction and call) — defense in depth, not the only gate.
  if (enabled !== true) return { ok: false, code: 'CLINE_SDK_ADAPTER_DISABLED' };
  if (env.SOC_CLINE_SDK_ADAPTER !== '1') return { ok: false, code: 'CLINE_SDK_ADAPTER_NOT_ARMED', detail: 'SOC_CLINE_SDK_ADAPTER=1 required' };
  const fail = (code, detail = null) => ({ ok: false, code, ...(detail ? { detail } : {}) });
  const active = new Map(); // identityHash -> handle
  const archived = new Map(); // finalized handles: identity -> handle (observe/getResult keep working)

  function assertEnabled() {
    if (enabled !== true) return fail('CLINE_SDK_ADAPTER_DISABLED');
    if (env.SOC_CLINE_SDK_ADAPTER !== '1') return fail('CLINE_SDK_ADAPTER_NOT_ARMED', 'SOC_CLINE_SDK_ADAPTER=1 required');
    return { ok: true };
  }

  function pushEvent(handle, item) {
    handle._seq += 1;
    const out = { seq: handle._seq, t: clock(), stream: 'agent', ...item };
    handle.items.push(out);
    for (const w of handle._waiters.splice(0)) w({ done: false, item: out });
    if (!handle._overflow) {
      try {
        if (fs.statSync(handle.eventsPath).size <= ACTIVITY_FILE_MAX_BYTES) {
          fs.appendFileSync(handle.eventsPath, `${JSON.stringify(out)}\n`, 'utf8');
        } else handle._overflow = true;
      } catch { handle._overflow = true; }
    }
    if (out.kind === 'tool' && out.phase === 'end') handle.toolCalls.push(out.tool ?? null);
    if (out.event && out.event.type === 'cline_usage') handle.usage = out.event.usage ?? handle.usage;
  }

  function finalize(handle, outcome, extra = {}) {
    handle.terminal = true;
    handle.status = outcome.terminalStatus;
    handle.outcome = outcome;
    try { handle._unsub?.(); } catch { /* observability only */ }
    for (const w of handle._waiters.splice(0)) w({ done: true, item: null });
    const cur = readRecord(handle.recordPath) || {};
    writeRecordAtomic(handle.recordPath, {
      ...cur,
      finishedAt: clock(),
      exitCode: outcome.exitCode,
      signal: null,
      terminalStatus: outcome.terminalStatus,
      reason: outcome.reason,
      finalized: true,
      sessionId: extra.sessionId ?? handle.sessionId ?? cur.sessionId ?? null,
      clineManifestPath: extra.manifestPath ?? null,
      clineMessagesPath: extra.messagesPath ?? null,
      eventsOverflow: handle._overflow,
    });
    active.delete(handle.executionId);
    archived.set(handle.executionId, handle);
  }

  // Release the SDK runtime once an execution is terminal: on Windows the
  // SDK's SQLite session store keeps a file handle open until dispose(), and
  // per-task storage hygiene must not hit EBUSY. Awaited by every async
  // call-site right before finalize().
  async function releaseRuntime(handle) {
    try { await handle._cline.dispose?.('EXECUTION_TERMINAL'); } catch { /* best effort */ }
  }

  // start(spec): spec { sessionPath, session, binding, instruction, model?,
  //   mutation?='readonly', interactive?=false, maxIterations?, laneId?,
  //   providerId?, apiKeyEnv?, systemPrompt? }
  async function start(spec = {}) {
    const gate = assertEnabled();
    if (!gate.ok) return gate;
    const { sessionPath, session, binding, instruction } = spec;
    if (!session || !session.leaseToken) return fail('SESSION_AUTHORITY_REJECTED', 'session with leaseToken is required.');
    if (!binding || !binding.path || !binding.identityHash) return fail('SESSION_AUTHORITY_REJECTED', 'taskStart binding is required.');
    if (typeof sessionPath !== 'string' || !sessionPath) return fail('SESSION_AUTHORITY_REJECTED', 'sessionPath is required for the mandatory execution-identity assert.');
    const av = verifyAuthority({ sessionPath, leaseToken: session.leaseToken, controlCwd: spec.controlCwd ?? process.cwd() });
    if (!av || !av.ok) return fail('SESSION_AUTHORITY_REJECTED', (av && av.reason) || 'verify failed');
    const idc = assertExecutionIdentity({ sessionPath, binding });
    if (!idc.ok) return fail(idc.reason, idc.detail);

    if (typeof instruction !== 'string' || !instruction.trim()) return fail('INSTRUCTION_INVALID');
    if (Buffer.byteLength(instruction, 'utf8') > INSTRUCTION_MAX_BYTES) return fail('INSTRUCTION_INVALID', 'instruction exceeds INSTRUCTION_MAX_BYTES');
    if (spec.model != null && !(typeof spec.model === 'string' && MODEL_RE.test(spec.model))) return fail('MODEL_INVALID', spec.model);

    // F3 (Issue #147 rework): ONE active Cline execution per adapter
    // host/process. CLINE_DATA_DIR is a process-global pin, so a second
    // distinct execution must fail BEFORE the runtime factory runs and before
    // the env pin could flip. Terminal/dispose frees the host.
    const busyHost = [...active.values()].find((h) => !h.terminal) ?? null;
    if (busyHost) {
      return { ok: false, code: 'CLINE_HOST_ALREADY_OCCUPIED', detail: { activeExecutionId: busyHost.executionId } };
    }

    // F1 (Issue #147 rework): mutation authority binds the CANONICAL mutation
    // owner recorded on the authoritative session (re-read via the identity
    // assert above). mutation 'allow' without a matching recorded owner lane
    // fails closed BEFORE runtime creation and BEFORE any workspace mutation.
    const mutationMode = spec.mutation === 'allow' ? 'allow' : 'readonly';
    const mg = verifyCanonicalMutationAuthority({
      session: idc.session,
      laneId: spec.laneId ?? null,
      mutation: mutationMode,
      binding: { repo: binding.repo, issueNumber: binding.issueNumber, branch: binding.branch, worktreePath: binding.path },
    });
    if (!mg.ok) {
      return { ok: false, code: mg.code, ...(mg.evidence ? { detail: mg.evidence } : {}) };
    }

    const prev = readExecutionRecord({ stateDir, repo: binding.repo, issueNumber: binding.issueNumber });
    if (prev.ok) {
      const st = effectiveStatus(prev.record, pidAlive);
      if (st === 'RUNNING' || st === 'STARTING') return { ok: false, code: 'EXECUTION_ALREADY_RUNNING', status: st };
    }

    const providerId = spec.providerId ?? provider?.providerId ?? null;
    const modelId = spec.model ?? provider?.modelId ?? null;
    const apiKeyEnv = spec.apiKeyEnv ?? provider?.apiKeyEnv ?? null;
    const apiKey = apiKeyEnv ? (env[apiKeyEnv] ?? null) : null;
    if (!providerId || !apiKey) return fail('CLINE_PROVIDER_NOT_CONFIGURED', 'providerId + apiKeyEnv (key present in env) required');
    if (!modelId) return fail('CLINE_MODEL_REQUIRED', 'ClineCore requires a string modelId');

    const dataDir = clineDataDir({ stateDir, identityHash: binding.identityHash });
    fs.mkdirSync(dataDir, { recursive: true });
    const eventsPath = executionEventsPath({ stateDir, identityHash: binding.identityHash });
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });

    let runtime;
    try {
      runtime = await runtimeFactory({ dataDir, env });
    } catch (e) {
      return fail('CLINE_SDK_UNAVAILABLE', String(e?.message ?? e));
    }
    if (!runtime || !runtime.instance || typeof runtime.instance.start !== 'function') {
      return fail('CLINE_SDK_UNAVAILABLE', 'runtime factory returned no ClineCore-like instance');
    }
    const cline = runtime.instance;

    const record = {
      schemaVersion: EXECUTION_SCHEMA_VERSION,
      kind: 'ExecutionRecord',
      identityHash: binding.identityHash,
      taskId: binding.taskId,
      repo: binding.repo,
      issueNumber: binding.issueNumber,
      baseSha: binding.baseSha,
      branch: binding.branch,
      worktreePath: binding.path,
      executor: CLINE_EXECUTOR_ID,
      executorVersion: runtime.version ?? null,
      adapterVersion: ADAPTER_VERSION,
      agent: 'cline-core-local',
      toolCaps: null,
      model: spec.model ?? null,
      providerId,
      laneId: spec.laneId ?? null,
      pid: process.pid,
      startedAt: clock(),
      finishedAt: null,
      exitCode: null,
      signal: null,
      terminalStatus: null,
      reason: null,
      instructionDigest: createHash('sha256').update(instruction).digest('hex'),
      instructionBytes: Buffer.byteLength(instruction, 'utf8'),
      sessionId: null,
      eventsPath,
      eventsOverflow: false,
      clineDataDir: dataDir,
      interactive: spec.interactive === true,
    };
    writeRecordAtomic(executionRecordPath({ stateDir, identityHash: binding.identityHash }), record);
    try { fs.writeFileSync(eventsPath, '', 'utf8'); } catch { /* append-only below */ }

    const handle = {
      executionId: binding.identityHash,
      recordPath: executionRecordPath({ stateDir, identityHash: binding.identityHash }),
      eventsPath,
      clineDataDir: dataDir,
      sessionId: null,
      manifestPath: null,
      messagesPath: null,
      status: 'STARTING',
      outcome: null,
      cancelRequested: false,
      terminal: false,
      interactive: spec.interactive === true,
      // F2: authority facts kept on the handle for revalidation before every
      // SDK continuation (resume) — never trusted beyond one turn.
      sessionPath,
      laneId: spec.laneId ?? null,
      mutation: mutationMode,
      leaseToken: session.leaseToken ?? null,
      binding: {
        identityHash: binding.identityHash,
        taskId: binding.taskId,
        repo: binding.repo,
        issueNumber: binding.issueNumber,
        baseSha: binding.baseSha,
        branch: binding.branch,
        worktreePath: binding.path,
      },
      items: [],
      result: null,
      toolCalls: [],
      usage: null,
      _waiters: [],
      _seq: 0,
      _overflow: false,
      _cline: cline,
      _runtime: runtime,
    };
    archived.delete(handle.executionId); // relaunch supersedes any archived stream
    active.set(handle.executionId, handle);

    handle._unsub = cline.subscribe((event) => {
      if (!event || typeof event !== 'object') return;
      const sid = event.payload?.sessionId;
      if (sid && !handle.sessionId) {
        handle.sessionId = sid;
        try {
          const cur = readRecord(handle.recordPath);
          if (cur && !cur.terminalStatus) writeRecordAtomic(handle.recordPath, { ...cur, sessionId: sid });
        } catch { /* diagnostics only */ }
      }
      const mapped = mapCoreSessionEvent(event);
      if (mapped) pushEvent(handle, mapped);
      if (event.type === 'status' && event.payload?.status === 'running') handle.status = 'RUNNING';
    });

    const toolPolicies = buildToolPolicies({ mutation: mutationMode });
    let runPromise;
    try {
      runPromise = cline.start({
        prompt: instruction,
        config: {
          cwd: path.resolve(binding.path),
          workspaceRoot: path.resolve(binding.path),
          providerId,
          modelId,
          apiKey,
          systemPrompt: spec.systemPrompt
            ?? 'You are a focused coding agent. Work only inside the workspace. Make minimal changes. Do not touch files outside the workspace.',
          mode: mutationMode === 'allow' ? 'act' : 'plan',
          thinking: false,
          maxIterations: spec.maxIterations ?? 16,
          enableTools: true,
          enableSpawnAgent: false,
          enableAgentTeams: false,
          toolPolicies,
        },
        source: 'soc-brain-cline-sdk-adapter',
        interactive: spec.interactive === true,
        sessionMetadata: {
          executionId: handle.executionId,
          taskId: binding.taskId,
          repo: binding.repo,
          issueNumber: binding.issueNumber,
          laneId: spec.laneId ?? null,
        },
      });
    } catch (e) {
      await releaseRuntime(handle);
      finalize(handle, mapTerminalOutcome({ error: e }), {});
      return fail('CLINE_START_FAILED', String(e?.message ?? e));
    }

    handle._done = runPromise.then(async (session) => {
      const result = session?.result ?? null;
      handle.result = result;
      if (session?.sessionId && !handle.sessionId) handle.sessionId = session.sessionId;
      if (session?.manifestPath) handle.manifestPath = session.manifestPath;
      if (session?.messagesPath) handle.messagesPath = session.messagesPath;
      // Interactive sessions are long-lived: the first turn resolving leaves
      // the execution IDLE (non-terminal) so authorized resume() can continue
      // it. Only cancel/dispose/error terminalizes an interactive execution.
      if (handle.interactive && !handle.cancelRequested) {
        handle.status = 'IDLE';
        return { ok: true, value: { terminalStatus: null, idle: true } };
      }
      await releaseRuntime(handle);
      const outcome = mapTerminalOutcome({
        finishReason: result?.finishReason ?? null,
        cancelRequested: handle.cancelRequested,
      });
      finalize(handle, outcome, {
        sessionId: session?.sessionId ?? handle.sessionId,
        manifestPath: session?.manifestPath ?? null,
        messagesPath: session?.messagesPath ?? null,
      });
      return { ok: true, value: outcome };
    }).catch(async (err) => {
      await releaseRuntime(handle);
      const outcome = mapTerminalOutcome({ cancelRequested: handle.cancelRequested, error: err });
      finalize(handle, outcome, {});
      return { ok: false, code: 'CLINE_EXECUTION_FAILED', detail: outcome };
    });

    return {
      ok: true,
      value: {
        executionId: handle.executionId,
        recordPath: handle.recordPath,
        eventsPath,
        status: 'STARTING',
      },
    };
  }

  function getHandle(executionId) {
    const h = active.get(executionId);
    if (h) return { ok: true, handle: h, archived: false };
    const a = archived.get(executionId);
    if (a) return { ok: true, handle: a, archived: true };
    return { ok: false, code: 'EXECUTION_NOT_ACTIVE' };
  }

  // observe(executionId): typed event stream. items() = current snapshot;
  // next() = await the next mapped item; done when the execution finalizes.
  function observe(executionId) {
    const g = getHandle(executionId);
    if (!g.ok) return g;
    const h = g.handle;
    let cursor = 0;
    return {
      ok: true,
      executionId,
      items: () => h.items.slice(),
      async next() {
        if (cursor < h.items.length) return { done: false, item: h.items[cursor++] };
        if (h.terminal) return { done: true, item: null };
        const ev = await new Promise((resolve) => h._waiters.push(resolve));
        if (ev.done) return { done: true, item: null };
        cursor += 1;
        return { done: false, item: ev.item };
      },
    };
  }

  // cancel(executionId): control-plane stop authority for an execution THIS
  // adapter host started. Never infers ownership from pid/timeout: only the
  // in-memory handle of this host qualifies (fail-closed otherwise).
  async function cancel(executionId) {
    const g = getHandle(executionId);
    if (!g.ok) return g;
    const h = g.handle;
    if (h.terminal) return { ok: false, code: 'EXECUTION_ALREADY_TERMINAL', status: h.status };
    h.cancelRequested = true;
    if (!h.sessionId) return { ok: false, code: 'CLINE_NO_SESSION_ID_YET' };
    try {
      await h._cline.abort(h.sessionId, 'SOC_CONTROL_PLANE_CANCEL');
    } catch (e) {
      return { ok: false, code: 'CLINE_ABORT_FAILED', detail: String(e?.message ?? e) };
    }
    await h._done?.catch(() => {});
    if (!h.terminal) {
      await releaseRuntime(h);
      finalize(h, mapTerminalOutcome({ finishReason: 'aborted', cancelRequested: true }), {});
    }
    return { ok: true, value: { executionId, status: h.status, reason: h.outcome?.reason ?? null } };
  }

  // resume({executionId, prompt}): continuation of an AUTHORIZED interactive
  // session started by THIS adapter host (same executionId binding, session
  // still non-terminal). Everything else fails closed — a finished
  // non-interactive SDK session is NOT continuable (typed
  // CLINE_RESUME_REJECTED), and a foreign/unknown executionId never resumes.
  async function resume({ executionId, prompt } = {}) {
    const gate = assertEnabled();
    if (!gate.ok) return gate;
    const g = getHandle(executionId);
    if (!g.ok) return { ok: false, code: 'CLINE_RESUME_REJECTED', detail: g.code };
    const h = g.handle;
    if (typeof prompt !== 'string' || !prompt.trim()) return fail('INSTRUCTION_INVALID');
    if (h.terminal) return { ok: false, code: 'CLINE_RESUME_REJECTED', detail: 'execution terminal; start a new execution instead' };
    if (!h.interactive) return { ok: false, code: 'CLINE_RESUME_REJECTED', detail: 'session is non-interactive; SDK send() is not continuable' };
    if (!h.sessionId) return { ok: false, code: 'CLINE_RESUME_REJECTED', detail: 'no SDK sessionId bound yet' };
    // F2 (Issue #147 rework): an interactive handle never holds mutation
    // authority across turns. Re-read + revalidate the canonical session
    // RIGHT BEFORE the SDK send; fail closed on stale/terminal/transferred
    // authority. The adapter never transfers or adopts ownership itself.
    const rs = readSessionRecord(h.sessionPath);
    if (!rs.ok) return { ok: false, code: 'CLINE_RESUME_REJECTED', detail: { reason: rs.reason ?? 'session unreadable' } };
    const s = rs.session;
    if (s.state !== 'SESSION_ACTIVE') {
      return { ok: false, code: 'SESSION_NOT_ACTIVE', detail: { state: s.state ?? null } };
    }
    if (!s.lease || !h.leaseToken || s.lease.token !== h.leaseToken) {
      return { ok: false, code: 'SESSION_AUTHORITY_REJECTED', detail: 'stale or missing lease (canonical session rotated it)' };
    }
    if (s.worktreePath !== h.binding.worktreePath
      || s.baseSha !== h.binding.baseSha
      || s.branch !== h.binding.branch
      || s.identityHash !== h.binding.identityHash) {
      return { ok: false, code: 'SESSION_AUTHORITY_REJECTED', detail: 'canonical binding changed since start' };
    }
    const mg = verifyCanonicalMutationAuthority({
      session: s,
      laneId: h.laneId,
      mutation: h.mutation,
      binding: { repo: h.binding.repo, issueNumber: h.binding.issueNumber, branch: h.binding.branch, worktreePath: h.binding.worktreePath },
    });
    if (!mg.ok) {
      return { ok: false, code: mg.code, ...(mg.evidence ? { detail: mg.evidence } : {}) };
    }
    let result;
    try {
      result = await h._cline.send({ sessionId: h.sessionId, prompt });
    } catch (e) {
      const name = e?.name ?? null;
      const code = e?.code ?? null;
      await releaseRuntime(h);
      finalize(h, {
        terminalStatus: 'FAILED',
        exitCode: null,
        reason: `CLINE_RESUME_FAILED: ${name ?? ''}${code ? `/${code}` : ''} ${String(e?.message ?? e).slice(0, 300)}`,
      }, {});
      return { ok: false, code: 'CLINE_RESUME_REJECTED', detail: { errorName: name, errorCode: code } };
    }
    await releaseRuntime(h);
    const outcome = mapTerminalOutcome({ finishReason: result?.finishReason ?? null, cancelRequested: h.cancelRequested });
    finalize(h, outcome, { manifestPath: h.manifestPath, messagesPath: h.messagesPath });
    return { ok: true, value: { executionId, status: h.status, text: result?.text ?? null, finishReason: result?.finishReason ?? null } };
  }

  function getExecutionIdentity(executionId) {
    const rec = readRecord(executionRecordPath({ stateDir, identityHash: executionId }));
    if (!rec) return { ok: false, code: 'EXECUTION_RECORD_MISSING' };
    const g = getHandle(executionId);
    return {
      ok: true,
      value: {
        executionId,
        canonical: {
          identityHash: rec.identityHash,
          taskId: rec.taskId,
          repo: rec.repo,
          issueNumber: rec.issueNumber,
          worktreePath: rec.worktreePath,
          branch: rec.branch,
          baseSha: rec.baseSha,
        },
        cline: {
          sessionId: rec.sessionId ?? g.handle?.sessionId ?? null,
          manifestPath: rec.clineManifestPath ?? g.handle?.manifestPath ?? null,
          messagesPath: rec.clineMessagesPath ?? g.handle?.messagesPath ?? null,
          clineDataDir: rec.clineDataDir ?? null,
        },
        versions: {
          adapter: rec.adapterVersion ?? null,
          runtime: rec.executorVersion ?? null,
          schema: rec.schemaVersion ?? null,
        },
        executor: rec.executor,
        pid: rec.pid,
        interactive: rec.interactive === true,
      },
    };
  }

  function getResult(executionId) {
    const rec = readRecord(executionRecordPath({ stateDir, identityHash: executionId }));
    if (!rec) return { ok: false, code: 'EXECUTION_RECORD_MISSING' };
    const g = getHandle(executionId);
    const h = g.ok ? g.handle : null;
    return {
      ok: true,
      value: {
        executionId,
        terminalStatus: rec.terminalStatus,
        reason: rec.reason,
        exitCode: rec.exitCode,
        startedAt: rec.startedAt,
        finishedAt: rec.finishedAt,
        sdkFinishReason: h?.result?.finishReason ?? (rec.terminalStatus === 'EXITED' ? 'completed' : null),
        text: h?.result?.text ?? null,
        toolCalls: h ? h.toolCalls.slice() : null,
        iterations: h?.result?.iterations ?? null,
        usage: h?.usage ?? h?.result?.usage ?? null,
        durationMs: h?.result?.durationMs ?? null,
        eventsOverflow: rec.eventsOverflow === true,
      },
    };
  }

  // dispose(): abort every active execution of THIS host, then dispose the
  // runtime. Idempotent. Never deletes artifacts (cleanup is explicit GC).
  async function dispose() {
    const results = [];
    const runtimes = new Set();
    for (const [id, h] of [...active.entries(), ...archived.entries()]) {
      runtimes.add(h._cline);
      if (!h.terminal) {
        h.cancelRequested = true;
        if (h.sessionId) {
          try { await h._cline.abort(h.sessionId, 'SOC_ADAPTER_DISPOSE'); } catch { /* best effort */ }
        }
        await h._done?.catch(() => {});
        if (!h.terminal) {
          await releaseRuntime(h);
          finalize(h, mapTerminalOutcome({ finishReason: 'aborted', cancelRequested: true }), {});
        }
      }
      results.push({ executionId: id, status: h.status });
    }
    active.clear();
    archived.clear();
    for (const c of runtimes) {
      try { await c.dispose?.('SOC_ADAPTER_DISPOSE'); } catch { /* best effort */ }
    }
    return { ok: true, value: { executions: results } };
  }

  return {
    ok: true,
    value: {
      executorId: CLINE_EXECUTOR_ID,
      adapterVersion: ADAPTER_VERSION,
      start,
      observe,
      cancel,
      resume,
      getExecutionIdentity,
      getResult,
      dispose,
    },
  };
}
