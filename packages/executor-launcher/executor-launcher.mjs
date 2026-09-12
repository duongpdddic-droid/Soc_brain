#!/usr/bin/env node
// executor-launcher — THIN ADAPTER between the Soc_brain control plane and an
// OpenCode headless run (Issue #53).
//
// ARCHITECTURE BOUNDARY (Issue #53 correction — binding):
//   Soc_brain owns control-plane concerns only: task/project authority,
//   canonical worktree/session, policy, executor selection, executor
//   launch/stop, verification/review lifecycle. OpenCode owns its internal
//   coding loop (reason -> read/search -> edit -> tools -> test -> iterate).
//   This module therefore tracks ONLY process-level lifecycle facts
//   (STARTING/RUNNING/EXITED/FAILED/STOPPED + pid/startedAt/finishedAt/
//   exitCode/sessionId) for process ownership and diagnostics.
//   Everything the executor emits through its SUPPORTED interface
//   (`opencode run --format json` NDJSON events on stdout + stderr logs) is
//   passed through verbatim as OBSERVABILITY: no interpretation, no text
//   mining, no TUI scraping, no hidden chain-of-thought capture, no agent FSM.
//
// Security invariants:
//   - instruction is DATA: passed as a single argv element to a shell-less
//     spawn; never interpolated into a shell.
//   - spawn cwd is ALWAYS the taskStart-verified worktree (binding.path).
//   - launch is gated by a capability preflight: the worktree opencode.json
//     projection must grant the minimum coding tool surface (bash/edit/read/
//     glob/grep/list = allow) or the launch fails closed BEFORE spawn
//     (EXECUTOR_PREFLIGHT_FAILED) — headless OpenCode would otherwise silently
//     auto-reject every denied tool (GPT-REV-137).
//   - executable is resolved from canonical, control-plane-owned locations
//     (env override or npm global install) — never from request input.
//   - child env is a bounded allowlist.
//
// No framework. Node >= 22.

import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifySessionAuthority, readSessionRecord, updateSessionUnderOwnershipLock } from '../runtime-sandbox/runtime-sandbox.mjs';
import { terminateAndProveCleanup } from './executor-reconcile.mjs';
import {
  readOpenCodeConfig, evaluateCodingCapabilities,
} from '../runtime-sandbox/opencode-adapter.mjs';
import { identityHash } from '../workspace/workspace.mjs';

export const EXECUTION_SCHEMA_VERSION = '1';
export const EXECUTOR_ID = 'opencode';
// Process-level statuses only (see boundary comment). INTERRUPTED is a
// PROJECTION for a non-terminal record whose pid is gone (stale evidence),
// never an authoritative terminal status.
export const EXECUTION_STATUSES = Object.freeze([
  'STARTING', 'RUNNING', 'EXITED', 'FAILED', 'STOPPED', 'INTERRUPTED',
]);
export const INSTRUCTION_MAX_BYTES = 8192;
export const ACTIVITY_TAIL_MAX_LINES = 512;
export const ACTIVITY_LINE_MAX_BYTES = 16 * 1024;
export const ACTIVITY_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const MODEL_RE = /^[A-Za-z0-9._/-]{1,120}$/;

// ---- executable resolution (control-plane owned, fail-closed) --------------
// Candidates, in order (first real .exe file wins):
//   1. SOC_OPENCODE_BIN env override (operator escape hatch; must exist)
//   2. PATH-order scan, mirroring user-facing `opencode` resolution WITHOUT a
//      shell: a PATH dir participates only if it actually serves an `opencode`
//      entry — a real opencode.exe, or an npm shim (opencode/opencode.cmd/
//      opencode.ps1) whose package exe exists at
//      <dir>/node_modules/opencode-ai/bin/opencode.exe. A stale node_modules
//      copy with no shim (invisible to the shell) is never picked — that is the
//      1.18.18-shadowing class of bug this scan exists to prevent.
//   3. <APPDATA>/npm/node_modules/opencode-ai/bin/opencode.exe (npm -g layout)
//   4. <node dir>/node_modules/opencode-ai/bin/opencode.exe (nvm4w layout)
// Only real .exe files are considered: Node refuses to spawn .cmd/.bat without
// a shell, and shims must never be spawned (shell boundary).
// Invariant: the resolved path is the SINGLE source — the version probe, the
// spawned process, and the persisted record all use exactly this path.
export function resolveOpenCodeExecutable({ env = process.env, exists = fs.existsSync } = {}) {
  const candidates = [];
  if (env.SOC_OPENCODE_BIN) candidates.push({ path: env.SOC_OPENCODE_BIN, source: 'env:SOC_OPENCODE_BIN' });
  for (const rawDir of String(env.PATH || '').split(path.delimiter)) {
    const dir = String(rawDir || '').replace(/^"+|"+$/g, '');
    if (!dir) continue;
    candidates.push({ path: path.join(dir, 'opencode.exe'), source: 'path' });
    const servesShim = exists(path.join(dir, 'opencode.cmd')) || exists(path.join(dir, 'opencode.ps1')) || exists(path.join(dir, 'opencode'));
    if (servesShim) candidates.push({ path: path.join(dir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'), source: 'path' });
  }
  if (env.APPDATA) candidates.push({ path: path.join(env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'), source: 'npm-global' });
  candidates.push({ path: path.join(path.dirname(process.execPath), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'), source: 'npm-global' });
  for (const c of candidates) {
    try {
      if (exists(c.path) && fs.statSync(c.path).isFile()) {
        return { ok: true, executable: c.path, source: c.source, candidates };
      }
    } catch { /* next candidate */ }
  }
  return { ok: false, reason: 'EXECUTOR_UNAVAILABLE', candidates };
}

// ---- launch argv (pure; data-only) -----------------------------------------
export function buildLaunchArgv({ instruction, model = null } = {}) {
  if (typeof instruction !== 'string' || !instruction.trim()) {
    return { ok: false, reason: 'INSTRUCTION_INVALID', detail: 'instruction must be a non-empty string.' };
  }
  const bytes = Buffer.byteLength(instruction, 'utf8');
  if (bytes > INSTRUCTION_MAX_BYTES) {
    return { ok: false, reason: 'INSTRUCTION_INVALID', detail: `instruction exceeds ${INSTRUCTION_MAX_BYTES} bytes (${bytes}).` };
  }
  if (model !== null && !(typeof model === 'string' && MODEL_RE.test(model))) {
    return { ok: false, reason: 'MODEL_INVALID', model };
  }
  // Fixed, supported interface only (verified against `opencode run --help`).
  // --agent build: pin the CODING agent (the CLI default is the read-only
  // `plan` agent — useless for a coding executor). No --auto: the permission
  // policy lives in the canonical opencode.json (executor-autonomy profile,
  // no ask keys => 0 prompts by construction) and is enforced by the launch
  // preflight. No --thinking (no hidden CoT capture).
  const argv = ['run', '--format', 'json', '--agent', 'build', '--print-logs', '--log-level', 'INFO'];
  if (model) argv.push('--model', model);
  argv.push(instruction); // DATA: single argv element, shell-less spawn
  return { ok: true, argv };
}

// ---- event classification (OBSERVABILITY PASSTHROUGH) ----------------------
// The ONLY derived field is `kind`, used for presentation (which pane/style).
// The parsed event is carried verbatim. Never infers agent-loop state.
export function classifyEvent(line) {
  const s = String(line);
  if (!s.trim()) return null;
  try {
    const ev = JSON.parse(s);
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) throw new Error('not an object');
    const part = ev.part && typeof ev.part === 'object' ? ev.part : null;
    if (ev.type === 'text' && part && typeof part.text === 'string') {
      return { kind: 'text', event: ev, text: part.text };
    }
    if (ev.type === 'tool' || (part && part.type === 'tool')) {
      return { kind: 'tool', event: ev, tool: (part && part.tool) || ev.tool || null };
    }
    if (ev.type === 'step_start' || ev.type === 'step_finish') {
      return { kind: ev.type, event: ev };
    }
    return { kind: 'event', event: ev };
  } catch {
    return {
      kind: 'output',
      line: s.length > ACTIVITY_LINE_MAX_BYTES ? s.slice(0, ACTIVITY_LINE_MAX_BYTES) + '…[truncated]' : s,
    };
  }
}

// ---- record paths + fail-closed reads ---------------------------------------
export function executionRecordPath({ stateDir, identityHash: h }) {
  return path.join(path.resolve(stateDir), 'executions', `${h}.json`);
}
export function executionEventsPath({ stateDir, identityHash: h }) {
  return path.join(path.resolve(stateDir), 'executions', `${h}.events.jsonl`);
}

export function effectiveStatus(record, isAlive, readStartTime) {
  if (!record || typeof record !== 'object') return null;
  if (record.terminalStatus) return record.terminalStatus;
  if (record.pid == null) return 'STARTING';
  const alive = typeof isAlive === 'function' ? isAlive(record.pid) : pidAlive(record.pid);
  // Issue #93: in the window between child-exit and the exit-handler's atomic
  // finalize write, a poll must not project INTERRUPTED for a successful run.
  // Dead pid + not finalized = finalization in flight => RUNNING (the 30m poll
  // deadline bounds pathological cases). Legacy dead records without finalized
  // also stay RUNNING (safe direction).
  if (!alive) return record.finalized === true ? 'INTERRUPTED' : 'RUNNING';
  // Issue #160: a live pid is NOT proof of the SAME executor incarnation
  // (Windows recycles pids). When the record pinned a processStartTime AND a
  // probe is supplied, a mismatch means the pid was reused => EXITED. With no
  // recorded startTime or no probe, the prior RUNNING projection is preserved
  // (backward compatibility); the STRICT identity decision lives in
  // reconcileExecutorLiveness (executor-reconcile.mjs) used by the reconnect
  // gate, which never auto-claims RUNNING without proven identity.
  if (record.processStartTime != null && typeof readStartTime === 'function') {
    const probe = readStartTime(record.pid);
    if (probe && probe.processStartTime != null && probe.processStartTime !== record.processStartTime) {
      return 'EXITED';
    }
  }
  return 'RUNNING';
}

function resolveIdentity({ repo, issueNumber }) {
  const h = identityHash({ repo, issueNumber });
  if (!h) return null;
  return { identityHash: h };
}

export function readExecutionRecord({ stateDir, repo, issueNumber }) {
  const id = resolveIdentity({ repo, issueNumber });
  if (!id) return { ok: false, reason: 'EXECUTION_IDENTITY_INVALID' };
  const p = executionRecordPath({ stateDir, identityHash: id.identityHash });
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return { ok: false, reason: 'EXECUTION_NOT_FOUND', path: p }; }
  let record;
  try { record = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'EXECUTION_RECORD_INVALID', detail: String((e && e.message) || e) }; }
  if (!record || record.schemaVersion !== EXECUTION_SCHEMA_VERSION || record.identityHash !== id.identityHash) {
    return { ok: false, reason: 'EXECUTION_RECORD_INVALID', detail: 'Record is schema-mismatched or not at its canonical location.' };
  }
  return { ok: true, record, path: p };
}

// Isolated activity read: a missing/corrupt stream MUST NOT corrupt lifecycle
// facts (Issue #53 correction, item C).
export function readActivityTail({
  stateDir, repo, issueNumber,
  maxLines = ACTIVITY_TAIL_MAX_LINES, clock = Date.now,
} = {}) {
  const id = resolveIdentity({ repo, issueNumber });
  if (!id) return { ok: false, reason: 'EXECUTION_IDENTITY_INVALID' };
  const p = executionEventsPath({ stateDir, identityHash: id.identityHash });
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch {
    return { ok: false, reason: 'ACTIVITY_UNAVAILABLE', path: p };
  }
  const lines = raw.split('\n').filter((l) => l.length > 0);
  const total = lines.length;
  const kept = lines.slice(Math.max(0, total - maxLines));
  const items = [];
  for (const l of kept) {
    // Stored lines are already wrapped items (written by attachPassthrough).
    // No re-classification: the passthrough payload stays verbatim.
    let obj;
    try { obj = JSON.parse(l); } catch { obj = null; }
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      items.push({ seq: 0, t: 0, stream: 'stdout', ...obj });
    } else {
      items.push({ kind: 'output', line: l.length > ACTIVITY_LINE_MAX_BYTES ? l.slice(0, ACTIVITY_LINE_MAX_BYTES) + '…[truncated]' : l });
    }
  }
  return { ok: true, items, totalLines: total, truncated: total > kept.length };
}

// ---- child env (bounded allowlist) ------------------------------------------
export function buildChildEnv(env = process.env) {
  // ponytail: fixed allowlist; extend with provider env vars only when a
  // second executor/provider needs them (upgrade path: named prefix rule).
  const allowlist = [
    'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'TEMP', 'TMP',
    'USERPROFILE', 'HOME', 'OS', 'ComSpec', 'PROCESSOR_ARCHITECTURE',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMDATA',
    // Issue #83 (P0-G): the operator's opencode provider config resolves
    // {env:NINE_ROUTER_API_KEY}; without it the headless executor 401s
    // ("Missing API key") on every real run. Documented upgrade path.
    'NINE_ROUTER_API_KEY',
  ];
  const out = {};
  for (const k of allowlist) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

// ---- capability preflight (fail fast BEFORE spawn) -----------------------------
// A coding task needs shell + edit + test + discovery. The permission lives in
// the worktree opencode.json projection (canonical, written by taskStart) —
// preflight reads it back from disk and fails closed on any missing/ask key:
// headless OpenCode silently auto-rejects those (GPT-REV-137), which would look
// like a successful launch that does nothing.
export function preflightCodingCapabilities({ executable, worktreePath, spawnSync = nodeSpawnSync } = {}) {
  let version = null;
  try {
    const r = spawnSync(executable, ['--version'], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
    const m = String(r.stdout || '').match(/(\d+\.\d+\.\d+)/);
    if (m) version = m[1];
  } catch { /* diagnostics only: launch continues with version null */ }
  const cfg = readOpenCodeConfig({ worktreePath });
  if (!cfg.ok) return { ok: false, reason: cfg.reason, detail: cfg.detail, path: cfg.path, version };
  const caps = evaluateCodingCapabilities(cfg.config);
  if (!caps.ok) return { ok: false, ...caps, version };
  return { ok: true, version, agent: 'build', toolCaps: caps.toolCaps };
}

// ---- launch -------------------------------------------------------------------
// Synchronous through record write (single-threaded handler => no double-launch
// interleaving). `session`/`binding`/`sessionPath` come from taskStart's
// verified return; authority is re-derived via verifySessionAuthority (never
// trusted from the caller alone).
// ---- Issue #132 (rework step 2): mandatory execution-identity assert ---------
// The ExecutionRecord must be bound into the SAME repo/issue/identityHash/
// session/worktree chain as the taskStart session it is launched from. The
// session is re-read FROM ITS CANONICAL LOCATION (never the caller's copy) and
// every identity field must match the launch binding; any mismatch fails
// closed BEFORE spawn — no executor process is ever started outside the chain.
export function assertExecutionIdentity({ sessionPath, binding }) {
  const rs = readSessionRecord(sessionPath);
  if (!rs.ok) return { ok: false, reason: 'EXECUTION_IDENTITY_MISMATCH', detail: `session read failed: ${rs.reason || 'unknown'}` };
  const s = rs.session;
  const b = binding || {};
  const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : v);
  const checks = [
    ['identityHash', s.identityHash, b.identityHash],
    ['worktreePath', s.worktreePath, b.path],
    ['baseSha', s.baseSha, b.baseSha],
    ['branch', s.branch, b.branch],
    ['repo', lower(s.repo), lower(b.repo)],
    ['issueNumber', Number(s.issueNumber), Number(b.issueNumber)],
    ['taskId', s.taskId, b.taskId],
  ];
  for (const [field, sessionValue, bindingValue] of checks) {
    if (sessionValue !== bindingValue) {
      return { ok: false, reason: 'EXECUTION_IDENTITY_MISMATCH', detail: `session.${field}=${JSON.stringify(sessionValue)} binding.${field}=${JSON.stringify(bindingValue)}` };
    }
  }
  return { ok: true, session: s };
}

export function startExecution({
  sessionPath, session, binding, instruction, model = null,
  stateDir, controlCwd = process.cwd(), env = process.env,
  spawn = nodeSpawn, clock = Date.now, isAlive = pidAlive,
  resolveExecutable = resolveOpenCodeExecutable,
  verifyAuthority = verifySessionAuthority,
  preflight = preflightCodingCapabilities,
  telemetry = null,
} = {}) {
  if (!session || !session.leaseToken) return { ok: false, reason: 'SESSION_AUTHORITY_REJECTED', detail: 'session with leaseToken is required.' };
  if (!binding || !binding.path || !binding.identityHash) return { ok: false, reason: 'SESSION_AUTHORITY_REJECTED', detail: 'taskStart binding is required.' };
  if (typeof sessionPath !== 'string' || !sessionPath) return { ok: false, reason: 'SESSION_AUTHORITY_REJECTED', detail: 'sessionPath is required for the mandatory execution-identity assert.' };
  const av = verifyAuthority({ sessionPath, leaseToken: session.leaseToken, controlCwd });
  if (!av || !av.ok) {
    return { ok: false, reason: 'SESSION_AUTHORITY_REJECTED', detail: (av && av.reason) || 'verify failed' };
  }
  // Issue #132 rework step 2: mandatory execution-identity assert BEFORE spawn.
  const idc = assertExecutionIdentity({ sessionPath, binding });
  if (!idc.ok) return idc;
  const iv = buildLaunchArgv({ instruction, model });
  if (!iv.ok) return { ok: false, ...iv };
  const ex = resolveExecutable({ env });
  if (!ex.ok) return { ok: false, ...ex };
  // Capability preflight: fail fast BEFORE spawn if the worktree projection
  // lacks the minimum coding tool surface (missing/ask keys auto-reject
  // headless — GPT-REV-137 — and would look like a no-op launch).
  const pref = preflight({ executable: ex.executable, worktreePath: binding.path });
  if (!pref.ok) return { ok: false, ...pref }; // specific preflight reason passes through

  const recPath = executionRecordPath({ stateDir, identityHash: binding.identityHash });
  const prev = readExecutionRecord({ stateDir, repo: binding.repo, issueNumber: binding.issueNumber });
  if (prev.ok) {
    const st = effectiveStatus(prev.record, isAlive);
    if (st === 'RUNNING' || st === 'STARTING') {
      return { ok: false, reason: 'EXECUTION_ALREADY_RUNNING', status: st, pid: prev.record.pid };
    }
    // EXITED/FAILED/STOPPED/INTERRUPTED: relaunch overwrites (single active
    // execution per identity; history is Soc_Score telemetry's job).
  }

  fs.mkdirSync(path.dirname(recPath), { recursive: true });
  const eventsPath = executionEventsPath({ stateDir, identityHash: binding.identityHash });
  try { fs.writeFileSync(eventsPath, '', 'utf8'); } catch { /* append-only below */ }

  const child = spawn(ex.executable, iv.argv, {
    cwd: binding.path, // taskStart-verified worktree ONLY
    env: buildChildEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const startedAt = clock();
  let stopRequested = false; // closure-scoped per execution
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
    executor: EXECUTOR_ID,
    executable: ex.executable,
    executorVersion: pref.version ?? null,
    agent: pref.agent ?? 'build',
    toolCaps: pref.toolCaps ?? null,
    model: model || null,
    pid: child.pid ?? null,
    startedAt,
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
  };
  writeRecordAtomic(recPath, record);
  let overflow = false;
  attachPassthrough({ child, eventsPath, record, clock, setOverflow: (v) => { overflow = v; } });

  // Win32 process start time (pid-reuse-proof diagnostics). Merged deferred so
  // the powershell probe never delays launch; skipped if the execution already
  // reached a terminal state; best-effort (absent field = unavailable).
  const pst = setTimeout(() => {
    try {
      const p0 = readWin32ProcessStartTime(child.pid);
      if (!p0) return;
      const cur = readRecord(recPath);
      if (cur && !cur.terminalStatus) writeRecordAtomic(recPath, { ...cur, processStartTime: p0.processStartTime });
    } catch { /* diagnostics only */ }
  }, 0);
  if (typeof pst.unref === 'function') pst.unref();

  child.on('error', (e) => {
    const cur = readRecord(recPath);
    const merged = {
      ...(cur || record),
      finishedAt: clock(),
      exitCode: null,
      signal: null,
      terminalStatus: 'FAILED',
      reason: `EXECUTOR_SPAWN_FAILED: ${String((e && e.message) || e)}`,
      finalized: true,
      sessionId: record.sessionId,
      eventsOverflow: overflow,
    };
    writeRecordAtomic(recPath, merged);
    record.terminalStatus = 'FAILED';
    if (telemetry) safeRecord(telemetry, 'EXECUTOR_FINISHED', { ok: false, reason: merged.reason });
  });
  child.on('exit', (code, signal) => {
    const terminal = stopRequested ? 'STOPPED' : (code === 0 ? 'EXITED' : 'FAILED');
    const cur = readRecord(recPath);
    const merged = {
      ...(cur || record),
      finishedAt: clock(),
      exitCode: code,
      signal: signal || null,
      terminalStatus: terminal,
      reason: terminal === 'FAILED'
        ? `EXECUTOR_EXIT_CODE_${code ?? 'null'}_SIGNAL_${signal ?? 'null'}`
        : (terminal === 'STOPPED' ? 'CONTROL_PLANE_STOP' : null),
      finalized: true,
      sessionId: record.sessionId,
      eventsOverflow: overflow,
    };
    writeRecordAtomic(recPath, merged);
    record.terminalStatus = terminal;
    if (telemetry) safeRecord(telemetry, 'EXECUTOR_FINISHED', { ok: terminal === 'EXITED', exitCode: code, signal, terminalStatus: terminal });
  });

  if (telemetry) safeRecord(telemetry, 'EXECUTOR_STARTED', { pid: record.pid, model: record.model, executable: ex.executable });

  {
    // Issue #160 REWORK F2: promote the authoritative session to executor context
    // (control-plane-owned). The MCP mutation gate requires a reconciled same-
    // attempt ExecutionRecord + proven process identity only in this mode; a
    // session never launched here stays control-plane. Fail-closed if the marker
    // cannot be persisted + read back.
    const em = updateSessionUnderOwnershipLock(sessionPath, (auth) => { auth.executionMode = 'executor'; return { session: auth }; });
    if (!em.ok || (em.session && em.session.executionMode !== 'executor')) {
      // F2: cannot prove the session is executor-mode -> the child we just
      // spawned must be reconciled, not orphaned. Terminate ONLY the exact
      // captured identity (PID + Win32 processStartTime) and PROVE it is gone;
      // if we cannot prove it gone, leave a terminal ExecutionRecord so the
      // session can never fall back to a usable control-plane path, and report
      // cleanupRequired. Never blind-retry, never touch a recycled/foreign pid.
      const capStart = readWin32ProcessStartTime(child.pid);
      const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* non-blocking env */ } };
      const cl = terminateAndProveCleanup({
        pid: child.pid,
        startTime: capStart ? capStart.processStartTime : null,
        isAlive: (p) => { try { process.kill(p, 0); return true; } catch { return false; } },
        readStartTime: (p) => readWin32ProcessStartTime(p),
        kill: (p) => { try { process.kill(p); } catch { /* handled by prove loop */ } },
        sleep: sleepSync,
      });
      // Fail-closed terminal record: an ambiguous/executor session with a dead
      // (STOPPED/INTERRUPTED) execution record denies mutation; a control-plane
      // mutation path is only reached with NO record at all.
      try { writeRecordAtomic(recPath, { ...record, terminalStatus: cl.provenGone ? 'STOPPED' : 'INTERRUPTED', cleanupRequired: cl.provenGone ? false : true, finalized: true, reason: 'EXECUTION_CONTEXT_BIND_FAILED' }); } catch { /* best-effort */ }
      return { ok: false, reason: 'EXECUTION_CONTEXT_BIND_FAILED', cleanupRequired: !cl.provenGone, provenGone: cl.provenGone, detail: { bind: (em && (em.reason || em.detail)) || 'read-back mismatch', cleanup: cl.action } };
    }
  }

  return {
    ok: true,
    identityHash: binding.identityHash,
    taskId: binding.taskId,
    pid: record.pid,
    child,
    markStopRequested: () => { stopRequested = true; },
    status: 'RUNNING',
    startedAt,
    recordPath: recPath,
    eventsPath,
  };
}

// OBSERVABILITY PASSTHROUGH plumbing: pipes child stdout (NDJSON events) and
// stderr (opencode logs) verbatim into the append-only activity file. The only
// derived fields are seq/t/stream and the presentation kind. sessionID is
// captured once as a supported diagnostics fact.
function attachPassthrough({ child, eventsPath, record, clock, setOverflow }) {
  let seq = 0;
  let fileOverflow = false;
  const markOverflow = () => { if (!fileOverflow) { fileOverflow = true; setOverflow(true); } };
  const append = (stream, chunk) => {
    if (fileOverflow) return;
    try {
      if (fs.statSync(eventsPath).size > ACTIVITY_FILE_MAX_BYTES) { markOverflow(); return; }
    } catch { markOverflow(); return; } // stat failure => stop appending (fail-closed)
    for (const line of String(chunk).split(/\r?\n/)) {
      const c = classifyEvent(line);
      if (!c) continue;
      seq += 1;
      if (c.event && typeof c.event.sessionID === 'string' && !record.sessionId) {
        record.sessionId = c.event.sessionID; // supported fact for diagnostics (any event kind)
      }
      const out = { seq, t: clock(), stream, ...c };
      try { fs.appendFileSync(eventsPath, `${JSON.stringify(out)}\n`, 'utf8'); } catch { markOverflow(); return; }
    }
  };
  let stdoutBuf = '';
  if (child.stdout) {
    child.stdout.on('data', (d) => {
      stdoutBuf += String(d);
      const parts = stdoutBuf.split(/\r?\n/);
      stdoutBuf = parts.pop();
      if (parts.length) append('stdout', parts.join('\n'));
    });
    child.stdout.on('end', () => { if (stdoutBuf) { append('stdout', stdoutBuf); stdoutBuf = ''; } });
  }
  if (child.stderr) child.stderr.on('data', (d) => append('stderr', d));
}

// ---- stop (control-plane launch/stop authority) --------------------------------
// Kills the task-owned child launched by THIS process. Cross-process stop is
// not supported in v0 (a restarted server observes INTERRUPTED and may relaunch).
export function stopExecution({ handle, kill = (c, sig) => c.kill(sig) } = {}) {
  if (!handle || !handle.child) return { ok: false, reason: 'NO_ACTIVE_EXECUTION' };
  if (typeof handle.markStopRequested === 'function') handle.markStopRequested();
  try { kill(handle.child, 'SIGTERM'); } catch (e) {
    return { ok: false, reason: 'STOP_FAILED', detail: String((e && e.message) || e) };
  }
  return { ok: true, pid: handle.pid ?? null, signal: 'SIGTERM' };
}

// Pid alone cannot identify a process on Windows: pids are recycled and a
// stale/laundered pid could make a dead execution look RUNNING. Win32
// PROCESS_START_TIME (100ns ticks, 1601 epoch) is immutable for the pid's
// current incarnation. Returns { pid, processStartTime } or null on failure.
export function readWin32ProcessStartTime(pid, exec = nodeSpawnSync) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const r = exec('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '(Get-Process -Id @(' + String(pid) + ") -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().Subtract([datetime]'1601-01-01Z').Ticks",
  ], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
  const n = Number.parseInt(String(r.stdout || '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? { pid, processStartTime: n } : null;
}

// ---- status projection -----------------------------------------------------------
export function readExecutionStatus({
  stateDir, repo, issueNumber,
  isAlive = pidAlive, clock = Date.now, tailMaxLines = ACTIVITY_TAIL_MAX_LINES,
  includeActivity = true,
} = {}) {
  const r = readExecutionRecord({ stateDir, repo, issueNumber });
  if (!r.ok) return r;
  const record = r.record;
  const status = effectiveStatus(record, isAlive);
  const finishedAt = record.finishedAt ?? ((status === 'RUNNING' || status === 'STARTING') ? clock() : null);
  const activity = includeActivity
    ? readActivityTail({ stateDir, repo, issueNumber, maxLines: tailMaxLines, clock })
    : null;
  // Public projection: process facts + diagnostics. instruction CONTENT is
  // never persisted here (digest only); paths stay internal to the control plane.
  return {
    ok: true,
    execution: {
      status,
      terminalStatus: record.terminalStatus ?? null,
      reason: record.reason ?? null,
      pid: record.pid,
      executor: record.executor,
      executable: record.executable ?? null,
      executorVersion: record.executorVersion ?? null,
      agent: record.agent ?? null,
      toolCaps: record.toolCaps ?? null,
      processStartTime: record.processStartTime ?? null,
      model: record.model,
      sessionId: record.sessionId,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      exitCode: record.exitCode,
      signal: record.signal,
      instructionDigest: record.instructionDigest,
      instructionBytes: record.instructionBytes,
      eventsOverflow: record.eventsOverflow === true,
      elapsedMs: record.startedAt != null && finishedAt != null ? Math.max(0, finishedAt - record.startedAt) : null,
    },
    activity,
  };
}

// ---- internals --------------------------------------------------------------------
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function readRecord(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function writeRecordAtomic(p, obj) {
  const tmp = `${p}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, p);
}
function safeRecord(recorder, event, detail) {
  try { recorder.record(event, detail); } catch { /* telemetry never breaks lifecycle */ }
}

