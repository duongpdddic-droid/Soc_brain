#!/usr/bin/env node
// executor-finalization-harness.mjs — Issue #167 6-phase executor observability
// harness. It captures process/transport evidence for a supervised benchmark
// run and classifies the finalization boundary. It does not create a task
// session, FSM transition, or issue mutation. OpenCode is the default because
// that is the only canonical headless path present on main; Cline is rejected
// until a canonical headless Cline launch path exists.
import fs from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { classifyEvent, EXECUTOR_ID, readWin32ProcessStartTime } from './executor-launcher.mjs';

export const HARNESS_SCHEMA_VERSION = '1';
export const DEFAULT_EXECUTOR = EXECUTOR_ID;
export const HARNESS_CLASSIFICATIONS = Object.freeze([
  'PASS', 'RESPONSE_LOST', 'TOOL_COMPLETION_NOT_PROPAGATED',
  'CHILD_EXIT_FINALIZATION_LOST', 'EXECUTOR_PROCESS_TERMINATION',
  'EVENT_LOG_OVERFLOW', 'CHILD_HANDLE_LEAK',
]);

function isText(item) {
  const t = item?.text ?? item?.event?.part?.text;
  return typeof t === 'string' && t.trim().length > 0;
}
function isToolCompletion(item) {
  if (item?.kind === 'step_finish') return true;
  const part = item?.event?.part;
  return item?.kind === 'tool' || (part?.type === 'tool' && part?.status === 'completed');
}
function stamp(item, fallback) {
  return item?.t ?? item?.timestamp ?? item?.at ?? fallback ?? null;
}

export function extractSixPhaseTimestamps({
  record = {}, events = [], commandStartedAt = null, processExitAt = null,
  childClosedAt = null, identityCapturedAt = null, resumeAt = null,
} = {}) {
  const stdout = events.filter((e) => e && (e.stream ?? 'stdout') === 'stdout' && e.kind !== 'TERMINAL_EVIDENCE');
  const completion = [...stdout].reverse().find(isToolCompletion) ?? null;
  const completionAt = stamp(completion, null);
  const final = [...stdout].reverse().find(isText) ?? null;
  const resumeEvent = completionAt == null ? null : stdout.find((e) => isText(e) && stamp(e, 0) > completionAt);
  return {
    commandStartedAt: record.startedAt ?? commandStartedAt,
    identityCapturedAt: identityCapturedAt ?? record.startedAt ?? commandStartedAt,
    finalSummaryAt: stamp(final, null),
    processExitedAt: record.finishedAt ?? processExitAt,
    toolCompletionAt: completionAt,
    resumeAt: stamp(resumeEvent, resumeAt),
  };
}

export function classifyExecutorHarness({
  record = {},
  timestamps = {},
  childClosedAt = null,
  processDead = false,
  terminalEvidenceAvailable = false,
} = {}) {
  const finalized = record.finalized === true || record.terminalStatus != null;
  if (processDead && !finalized) return 'CHILD_EXIT_FINALIZATION_LOST';
  if (finalized && childClosedAt == null) return 'CHILD_HANDLE_LEAK';
  if (record.eventsOverflow === true && !terminalEvidenceAvailable) return 'EVENT_LOG_OVERFLOW';
  if (record.terminalStatus === 'FAILED' || record.terminalStatus === 'STOPPED') return 'EXECUTOR_PROCESS_TERMINATION';
  if (timestamps.toolCompletionAt != null && timestamps.finalSummaryAt == null) return 'TOOL_COMPLETION_NOT_PROPAGATED';
  if (timestamps.finalSummaryAt != null && timestamps.resumeAt == null) return 'RESPONSE_LOST';
  const required = ['commandStartedAt', 'identityCapturedAt', 'finalSummaryAt', 'processExitedAt', 'toolCompletionAt', 'resumeAt'];
  return record.terminalStatus === 'EXITED' && required.every((k) => timestamps[k] != null) ? 'PASS' : 'RESPONSE_LOST';
}

export function analyzeExecutorRun({
  executor = DEFAULT_EXECUTOR, record = {}, events = [], ...input
} = {}) {
  if (executor !== DEFAULT_EXECUTOR) {
    return { ok: false, reason: 'EXECUTOR_BENCHMARK_PATH_NOT_CANONICAL', executor, defaultExecutor: DEFAULT_EXECUTOR };
  }
  const timestamps = extractSixPhaseTimestamps({ record, events, ...input });
  const terminalEvidenceAvailable = events.some((e) => e?.kind === 'TERMINAL_EVIDENCE')
    || input.terminalEvidenceAvailable === true;
  const classification = classifyExecutorHarness({
    record, timestamps, childClosedAt: input.childClosedAt ?? null,
    processDead: input.processDead === true, terminalEvidenceAvailable,
  });
  return {
    ok: true,
    schemaVersion: HARNESS_SCHEMA_VERSION,
    kind: 'ExecutorFinalizationHarnessResult',
    executor,
    classification,
    timestamps,
    childClosedAt: input.childClosedAt ?? null,
    processIdentity: { pid: record.pid ?? null, processStartTime: record.processStartTime ?? null },
    lifecycle: {
      terminalStatus: record.terminalStatus ?? null,
      finalized: record.finalized === true,
      eventsOverflow: record.eventsOverflow === true,
      reason: record.reason ?? null,
    },
    evidence: { terminalEvidenceAvailable, eventCount: events.length },
  };
}

export function runExecutorHarness({
  command = null, args = [], executor = DEFAULT_EXECUTOR, spawn = nodeSpawn,
  readStartTime = readWin32ProcessStartTime, clock = Date.now, timeoutMs = 0,
} = {}) {
  if (executor !== DEFAULT_EXECUTOR) {
    return Promise.resolve(analyzeExecutorRun({ executor, record: {}, events: [] }));
  }
  if (typeof command !== 'string' || !command) return Promise.resolve({ ok: false, reason: 'HARNESS_COMMAND_REQUIRED' });
  return new Promise((resolve) => {
    const startedAt = clock();
    let child;
    try { child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); }
    catch (e) { resolve({ ok: false, reason: 'EXECUTOR_SPAWN_FAILED', detail: String(e.message || e) }); return; }
    const pid = child.pid ?? null;
    let processStartTime = null;
    try { processStartTime = readStartTime(pid)?.processStartTime ?? null; } catch { processStartTime = null; }
    const record = { pid, processStartTime, startedAt, finishedAt: null, exitCode: null, signal: null, terminalStatus: null, finalized: false, eventsOverflow: false, reason: null };
    const events = [];
    let buffer = '';
    let seq = 0;
    let childClosedAt = null;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(analyzeExecutorRun({ record, events, childClosedAt, processDead: childClosedAt != null || record.finalized === true, terminalEvidenceAvailable: true }));
    };
    const append = (line) => {
      const c = classifyEvent(line);
      if (c) events.push({ seq: ++seq, t: clock(), stream: 'stdout', ...c });
    };
    if (child.stdout) child.stdout.on('data', (d) => {
      buffer += String(d);
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop();
      parts.forEach(append);
    });
    child.on('error', (e) => {
      record.finishedAt = clock();
      record.terminalStatus = 'FAILED';
      record.finalized = true;
      record.reason = `EXECUTOR_SPAWN_FAILED: ${String(e.message || e)}`;
      settle();
    });
    child.on('exit', (code, signal) => {
      record.finishedAt = clock();
      record.exitCode = code;
      record.signal = signal ?? null;
      record.terminalStatus = code === 0 ? 'EXITED' : 'FAILED';
      record.finalized = true;
      record.reason = code === 0 ? null : `EXECUTOR_EXIT_CODE_${code ?? 'null'}_SIGNAL_${signal ?? 'null'}`;
      if (childClosedAt != null) settle();
      else setTimeout(settle, 0);
    });
    child.on('close', () => { childClosedAt = clock(); if (record.finalized) settle(); });
    const timer = timeoutMs > 0 ? setTimeout(() => { try { child.kill(); } catch { /* close/exit below */ } }, timeoutMs) : null;
    if (typeof timer?.unref === 'function') timer.unref();
  });
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('executor-finalization-harness.mjs')) {
  const inputPath = process.argv[2];
  if (!inputPath) { console.error('usage: node executor-finalization-harness.mjs <evidence.json>'); process.exit(2); }
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const result = analyzeExecutorRun(input);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
