#!/usr/bin/env node
// control-ui — minimal control-plane HTTP server + terminal-style UI (Issue #53).
//
// Soc_brain is a CONTROL PLANE, not a coding harness: it admits the task
// (taskStart -> canonical worktree/session/lease), launches the executor via
// the thin adapter (executor-launcher), and PROJECTS read-only observations.
// OpenCode owns its internal coding loop; its supported output is streamed to
// the UI verbatim (observability passthrough — see executor-launcher).
//
// Authority rules (binding, Issue #53 + Phase A Local Task Identity v0):
//   - The browser supplies ONLY {instruction} (+ optional model). issueNumber
//     is OPTIONAL (backward compatibility); an instruction-only run draws a
//     LOCAL task number from the persistent allocator and feeds the UNCHANGED
//     canonical identity pipeline. repo identity, baseSha, executable, argv,
//     cwd, worktree path and config are resolved by the control plane. Request
//     fields for those are ignored.
//   - Loopback-only HTTP (127.0.0.1), no CORS, 64KB body cap.
//   - Public state projection contains NO lease token, NO absolute paths.
//   - Activity/changed-files/diff reads are fail-isolated: losing the optional
//     observability stream can never corrupt canonical lifecycle facts.
//
// No framework. Node >= 22.

import http from 'node:http';
import fs from 'node:fs';
import { normalizeRemoteUrl, readUpstreamHead } from '../safe-git/safe-git.mjs';
import { createExecutionBroker } from '../execution-broker/execution-broker.mjs';
import {
  taskStart as defaultTaskStart,
  readSessionRecord,
  sessionPathFor,
  defaultStateDir,
} from '../runtime-sandbox/runtime-sandbox.mjs';
import { identityHash, defaultWorktreesRoot, IDENTITY_HASH_LENGTH } from '../workspace/workspace.mjs';
import { allocateLocalTaskNumber } from '../task-intake/local-task-allocator.mjs';
import * as launcher from '../executor-launcher/executor-launcher.mjs';

export const CONTROL_UI_VERSION = '0';
export const DEFAULT_EXECUTOR = 'opencode';
// Verified working free model for headless runs (no auth needed). Override via
// SOC_UI_MODEL or per-request bounded `model` field.
export const DEFAULT_MODEL = process.env.SOC_UI_MODEL || 'opencode/big-pickle';
const BODY_MAX_BYTES = 64 * 1024;
const DIFF_MODES = ['working_tree', 'staged'];

// ---- request validation (the ONLY fields accepted from the browser) --------
export function validateRunRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'BODY_INVALID' };
  const { issueNumber, instruction, model } = body;
  // Phase A1 (Local Task Identity v0): issueNumber is OPTIONAL. Absent/null
  // starts the LOCAL allocation path; a SUPPLIED value keeps the strict
  // positive-integer contract (no coercion — malformed values fail closed).
  if (issueNumber !== undefined && issueNumber !== null && (!Number.isInteger(issueNumber) || issueNumber <= 0)) {
    return { ok: false, reason: 'ISSUE_NUMBER_INVALID' };
  }
  if (typeof instruction !== 'string' || !instruction.trim()) return { ok: false, reason: 'INSTRUCTION_INVALID' };
  const bytes = Buffer.byteLength(instruction, 'utf8');
  if (bytes > 8192) return { ok: false, reason: 'INSTRUCTION_INVALID', detail: `instruction exceeds 8192 bytes (${bytes}).` };
  // control-plane: task input is DATA; reject unprintable control characters
  // (the UI + task contract are plain text; this is input hygiene, not parsing).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(instruction)) return { ok: false, reason: 'INSTRUCTION_INVALID', detail: 'control characters are not allowed.' };
  if (model !== undefined && model !== null && !(typeof model === 'string' && launcher.MODEL_RE.test(model))) {
    return { ok: false, reason: 'MODEL_INVALID' };
  }
  return { ok: true, issueNumber, instruction, model: typeof model === 'string' ? model : null };
}

// ---- Phase A4 (Local Task Identity v0): opaque identity handles -------------
// API session endpoints accept EITHER a legacy numeric issueNumber (resolved
// through the existing repo-derived sessionPathFor() layout) OR a 32-hex
// identityHash handle (resolved through the hash-derived layout). Anything
// else — wrong length, non-hex — fails closed. An identityHash that does not
// correspond to an existing session surfaces as SESSION_ABSENT from
// readSessionRecord (fail-closed, no path disclosure).
const IDENTITY_HASH_RE = new RegExp(`^[0-9a-f]{${IDENTITY_HASH_LENGTH}}$`);

export function resolveHandleToken(rawToken) {
  if (typeof rawToken !== 'string') return null;
  const token = rawToken.trim();
  if (!token) return null;
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    return { kind: 'issueNumber', issueNumber: n };
  }
  if (IDENTITY_HASH_RE.test(token)) {
    return { kind: 'identityHash', identityHash: token };
  }
  return null;
}

// ---- state projection (control-plane facts + fail-isolated observations) ----
export function buildStateResponse({
  repo, issueNumber,
  stateDir,
  readSession = readSessionRecord,
  now = () => new Date().toISOString(),
} = {}) {
  const out = { schemaVersion: '1', server: { version: CONTROL_UI_VERSION, now: now() }, task: null, execution: null };
  const s = readSession(sessionPathFor({ stateDir, identityHash: identityHash({ repo, issueNumber }) }));
  if (s.ok) {
    out.task = {
      taskId: s.session.taskId,
      repo: s.session.repo,
      issueNumber: s.session.issueNumber,
      baseSha: s.session.baseSha,
      branch: s.session.branch,
      headSha: s.session.headSha,
      state: s.session.state,
      startedAt: (s.session.lease && s.session.lease.issuedAt) || null,
    };
    // Public projection: lease token and internal paths are NEVER exposed.
    const ex = launcher.readExecutionStatus({ stateDir, repo, issueNumber, includeActivity: false });
    if (ex.ok) {
      out.execution = { ...ex.execution };
      // elapsedMs falls back to server clock while running (finishedAt null).
      if (out.execution.elapsedMs == null && out.execution.startedAt != null) {
        out.execution.elapsedMs = Math.max(0, Date.now() - out.execution.startedAt);
      }
    }
  }
  return out;
}

// ---- activity projection (OBSERVABILITY PASSTHROUGH) ------------------------
export function buildActivityResponse({ stateDir, repo, issueNumber, maxLines = 200 } = {}) {
  const r = launcher.readActivityTail({ stateDir, repo, issueNumber, maxLines });
  if (!r.ok) return { schemaVersion: '1', available: false, reason: r.reason };
  return {
    schemaVersion: '1',
    available: true,
    totalLines: r.totalLines,
    truncated: r.truncated,
    items: r.items.map((it) => ({
      seq: it.seq, t: it.t, stream: it.stream, kind: it.kind,
      // passthrough payload, verbatim from the executor's supported output
      event: it.event ?? null,
      text: it.text ?? null,
      tool: it.tool ?? null,
      line: it.line ?? null,
    })),
  };
}

// ---- changed files + diff (read-only observation of the canonical worktree) --
export function buildChangesResponse({ brokerRequest, diffMode = 'working_tree' } = {}) {
  const st = brokerRequest({ schemaVersion: '1', operation: 'status', args: {} });
  if (!st.ok) return { schemaVersion: '1', available: false, reason: st.reason || 'STATUS_UNAVAILABLE' };
  // Broker status shape: { data: { entries: [{ code, path }], truncated } }
  // where code is the 2-char porcelain XY (X=index, Y=workTree; ?? = untracked).
  const entries = (st.data && Array.isArray(st.data.entries) ? st.data.entries : [])
    .filter((e) => e && typeof e.code === 'string' && e.code !== '  ');
  const d = brokerRequest({ schemaVersion: '1', operation: 'diff', args: { mode: DIFF_MODES.includes(diffMode) ? diffMode : 'working_tree' } });
  return {
    schemaVersion: '1',
    available: true,
    files: entries.map((e) => ({
      path: e.path,
      index: e.code[0] === '?' ? ' ' : e.code[0],
      workTree: e.code[1] === '?' ? '?' : e.code[1],
      untracked: e.code === '??',
    })),
    diff: d.ok
      ? { mode: d.mode, truncated: (d.data && d.data.truncated) === true, text: (d.data && d.data.output) || '' }
      : { available: false, reason: d.reason || 'DIFF_UNAVAILABLE' },
  };
}

// ---- control plane + HTTP wiring ---------------------------------------------
// deps are injectable for deterministic tests: { taskStart, readSession,
// readUpstreamHead, launcher } where launcher = { startExecution,
// readExecutionStatus, readActivityTail, stopExecution }.
export function createControlPlane({
  repo,
  stateDir,
  controlCwd = process.cwd(),
  now = () => new Date().toISOString(),
  deps = {},
} = {}) {
  const canonicalRepo = normalizeRemoteUrl(repo);
  // Repo identity is control-plane authority: require owner/name shape so a
  // garbage --repo can never reach taskStart (normalizeRemoteUrl only normalizes).
  if (!canonicalRepo || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(canonicalRepo)) {
    return { ok: false, reason: 'REPO_UNRESOLVABLE' };
  }
  const D = {
    taskStart: deps.taskStart || defaultTaskStart,
    readSession: deps.readSession || readSessionRecord,
    readUpstreamHead: deps.readUpstreamHead || readUpstreamHead,
    allocLocalTaskNumber: deps.allocLocalTaskNumber || ((args) => allocateLocalTaskNumber(args)),
    launcher: { ...launcher, ...(deps.launcher || {}) },
  };
  const activeRuns = new Map(); // identityHash -> launcher handle {child, markStopRequested, pid}

  function admitAndLaunch({ issueNumber, instruction, model }) {
    // Base authority resolved by the control plane from the canonical repo —
    // never from the browser.
    const baseSha = D.readUpstreamHead({ branch: 'main', remote: 'origin', cwd: controlCwd });
    if (!baseSha) return { ok: false, httpStatus: 503, error: 'BASE_UNAVAILABLE', detail: 'origin/main head is not resolvable; fetch the canonical repo first.' };
    // Phase A2 (Local Task Identity v0): an instruction-only run draws its task
    // number from the persistent LOCAL allocator (>= 9_000_000, monotonic,
    // restart-safe, burn-before-use). Allocation runs AFTER base admission so a
    // run that cannot be admitted never burns a number. Dep injectable for tests.
    let localTask = false;
    if (issueNumber == null) {
      const a = D.allocLocalTaskNumber({ stateDir });
      if (!a || !a.ok) return { ok: false, httpStatus: 503, error: (a && a.reason) || 'LOCAL_TASK_ALLOCATION_FAILED', detail: (a && a.detail) || null };
      issueNumber = a.number;
      localTask = true;
    }
    const ts = D.taskStart({
      repo: canonicalRepo,
      issueNumber,
      baseSha,
      stateDir,
      controlCwd,
      // Task input is DATA: the instruction becomes the task contract body.
      taskContract: { title: `Task #${issueNumber} — UI launch`, body: instruction },
    });
    if (!ts || !ts.ok) return { ok: false, httpStatus: 409, error: 'TASK_START_FAILED', detail: (ts && ts.reason) || 'taskStart failed' };
    const handle = D.launcher.startExecution({
      sessionPath: ts.worktree.sessionPath,
      session: ts.session,
      binding: ts.binding,
      instruction,
      model: model || DEFAULT_MODEL,
      stateDir,
      controlCwd,
      telemetry: ts.telemetry && ts.telemetry.recorder ? ts.telemetry.recorder : null,
    });
    if (!handle || !handle.ok) return { ok: false, httpStatus: 409, error: handle && handle.reason ? handle.reason : 'LAUNCH_FAILED', detail: handle && handle.detail ? handle.detail : null };
    activeRuns.set(handle.identityHash, handle);
    return { ok: true, taskId: handle.taskId, identityHash: handle.identityHash, pid: handle.pid, status: handle.status, issueNumber, localTask, idempotent: ts.idempotent === true };
  }

  // ---- Phase A4: session target resolution (server-side, fail-closed) --------
  // Endpoints accept a legacy numeric issueNumber OR a 32-hex identityHash
  // handle returned by /api/run. The handle is resolved through the hash-
  // derived sessionPathFor() layout; the session record then yields the task
  // number that feeds the EXISTING numeric pipeline below (no new resolution
  // logic). Failures: malformed handle, absent session, cross-repo session.
  function resolveTarget(t = {}) {
    if (t.identityHash != null) {
      if (typeof t.identityHash !== 'string' || !IDENTITY_HASH_RE.test(t.identityHash)) return { ok: false, reason: 'SESSION_TOKEN_MALFORMED' };
      const s = D.readSession(sessionPathFor({ stateDir, identityHash: t.identityHash }));
      if (!s || !s.ok || !s.session) return { ok: false, reason: (s && s.reason) || 'SESSION_ABSENT' };
      if (normalizeRemoteUrl(s.session.repo) !== canonicalRepo) return { ok: false, reason: 'SESSION_REPO_MISMATCH' };
      if (!Number.isInteger(s.session.issueNumber) || s.session.issueNumber <= 0) return { ok: false, reason: 'SESSION_TOKEN_MALFORMED' };
      return { ok: true, issueNumber: s.session.issueNumber };
    }
    if (!Number.isInteger(t.issueNumber) || t.issueNumber <= 0) return { ok: false, reason: 'ISSUE_NUMBER_REQUIRED' };
    return { ok: true, issueNumber: t.issueNumber };
  }

  function stop(t) {
    const target = resolveTarget(t);
    if (!target.ok) return target;
    const issueNumber = target.issueNumber;
    const h = identityHash({ repo: canonicalRepo, issueNumber });
    const handle = h && activeRuns.get(h);
    const r = D.launcher.stopExecution({ handle });
    if (r.ok) activeRuns.delete(h);
    return r;
  }

  function state(t) {
    const target = resolveTarget(t);
    if (!target.ok) return { ok: false, reason: target.reason };
    return buildStateResponse({ repo: canonicalRepo, issueNumber: target.issueNumber, stateDir, readSession: D.readSession, now });
  }
  function activity(t = {}) {
    const target = resolveTarget(t);
    if (!target.ok) return { ok: false, schemaVersion: '1', available: false, reason: target.reason };
    return buildActivityResponse({ stateDir, repo: canonicalRepo, issueNumber: target.issueNumber, maxLines: t.maxLines });
  }
  function changes(t = {}) {
    const target = resolveTarget(t);
    if (!target.ok) return { ok: false, schemaVersion: '1', available: false, reason: target.reason };
    const issueNumber = target.issueNumber;
    const base = buildStateResponse({ repo: canonicalRepo, issueNumber, stateDir, readSession: D.readSession, now });
    if (!base.task || !base.task.baseSha) return { schemaVersion: '1', available: false, reason: 'NO_ACTIVE_TASK' };
    // Canonical observation ONLY via the broker bound to this task's session —
    // identity comes from the control plane, never from the browser.
    const brokerFor = deps.brokerFor || (({ controlCwd: cwd }) => {
      const broker = createExecutionBroker({ worktreesRoot: defaultWorktreesRoot(), controlCwd: cwd });
      return broker.executeBrokerRequest;
    });
    const broker = brokerFor({ stateDir, controlCwd, repo: canonicalRepo, issueNumber, baseSha: base.task.baseSha });
    return buildChangesResponse({
      brokerRequest: (req) => broker({ ...req, repo: canonicalRepo, issueNumber, baseSha: base.task.baseSha }),
      diffMode: t.diffMode,
    });
  }
  return { ok: true, repo: canonicalRepo, admitAndLaunch, stop, state, activity, changes, activeRuns };
}

// ---- HTTP server (loopback-only, no CORS) -------------------------------------
export function createControlUiServer({ controlPlane, host = '127.0.0.1', port = 0 } = {}) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const q = u.searchParams;
    const json = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    };
    const issueNumberOf = () => {
      const n = Number(q.get('issueNumber'));
      return Number.isInteger(n) && n > 0 ? n : null;
    };
    // Phase A4: session target = legacy numeric issueNumber OR 32-hex
    // identityHash handle. Malformed HTTP-level params fail closed here;
    // session existence / repo-binding checks stay in the control plane.
    const targetOf = () => {
      const rawIssue = q.get('issueNumber');
      const h = q.get('identityHash');
      if (rawIssue != null) {
        const n = issueNumberOf();
        return n ? { ok: true, t: { issueNumber: n } } : { ok: false, reason: 'ISSUE_NUMBER_INVALID' };
      }
      if (h != null && h !== '') {
        return IDENTITY_HASH_RE.test(h) ? { ok: true, t: { identityHash: h } } : { ok: false, reason: 'SESSION_TOKEN_MALFORMED' };
      }
      return { ok: false, reason: 'ISSUE_NUMBER_REQUIRED' };
    };
    try {
      if (req.method === 'GET' && u.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(renderUiPage());
        return;
      }
      if (req.method === 'GET' && u.pathname === '/api/state') {
        const t = targetOf();
        if (!t.ok) return json(400, { ok: false, reason: t.reason });
        const r = controlPlane.state(t.t);
        return json(r.ok === false ? 400 : 200, r.ok === false ? r : { ok: true, ...r });
      }
      if (req.method === 'GET' && u.pathname === '/api/activity') {
        const t = targetOf();
        if (!t.ok) return json(400, { ok: false, reason: t.reason });
        const maxLines = Math.min(Math.max(Number(q.get('maxLines')) || 200, 1), 512);
        const r = controlPlane.activity({ ...t.t, maxLines });
        return json(r.ok === false ? 400 : 200, r.ok === false ? r : { ok: true, ...r });
      }
      if (req.method === 'GET' && u.pathname === '/api/changes') {
        const t = targetOf();
        if (!t.ok) return json(400, { ok: false, reason: t.reason });
        const r = controlPlane.changes({ ...t.t, diffMode: q.get('diffMode') || 'working_tree' });
        return json(r.ok === false ? 400 : 200, r.ok === false ? r : { ok: true, ...r });
      }
      if (req.method === 'POST' && u.pathname === '/api/run') {
        readBody(req).then((body) => {
          const v = validateRunRequest(body);
          if (!v.ok) return json(400, { ok: false, ...v });
          const r = controlPlane.admitAndLaunch(v);
          return json(r.ok ? 200 : (r.httpStatus || 500), r.ok ? { ok: true, ...r } : { ok: false, error: r.error, detail: r.detail });
        }).catch((e) => json(500, { ok: false, error: 'INTERNAL', detail: String((e && e.message) || e) }));
        return;
      }
      if (req.method === 'POST' && u.pathname === '/api/stop') {
        readBody(req).then((body) => {
          const h = body && typeof body.identityHash === 'string' && body.identityHash ? body.identityHash : null;
          const n = body && Number.isInteger(body.issueNumber) && body.issueNumber > 0 ? body.issueNumber : null;
          if (!h && !n) return json(400, { ok: false, reason: 'ISSUE_NUMBER_REQUIRED' });
          if (h && !IDENTITY_HASH_RE.test(h)) return json(400, { ok: false, reason: 'SESSION_TOKEN_MALFORMED' });
          const r = controlPlane.stop(h ? { identityHash: h } : { issueNumber: n });
          return json(r.ok ? 200 : 409, r.ok ? { ok: true, ...r } : { ok: false, reason: r.reason });
        }).catch((e) => json(500, { ok: false, error: 'INTERNAL', detail: String((e && e.message) || e) }));
        return;
      }
      json(404, { ok: false, reason: 'NOT_FOUND' });
    } catch (e) {
      json(500, { ok: false, error: 'INTERNAL', detail: String((e && e.message) || e) });
    }
  });
  return { server, listen: () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ host, port: server.address().port }));
  }) };
}

function readBody(req, maxBytes = BODY_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
    });
    req.on('error', reject);
  });
}

// ---- UI page (terminal-style; no build step, no framework) --------------------
// Renders supported executor output verbatim. Soc_brain never reconstructs the
// agent loop: text events become lines, tool events are labeled as tools,
// non-JSON output is printed as-is.
export function renderUiPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Soc_brain Control</title>
<style>
  :root {
    /* semantic status tokens (text label always accompanies color) */
    --status-info: #58a6ff;
    --status-active: #d29922;
    --status-success: #3fb950;
    --status-warning: #d29922;
    --status-danger: #f85149;
    --status-neutral: #8b949e;
    --status-tool: #a371f7;
    --status-output: #f0883e;
    --status-diff: #7ee787;
  }
  body { background:#0b0e14; color:#c9d1d9; font-family:Consolas,'Cascadia Mono',monospace; margin:0; padding:16px; }
  h1 { font-size:14px; margin:0 0 12px; color:var(--status-info); letter-spacing:1px; }
  .row { display:flex; gap:8px; align-items:center; margin-bottom:10px; flex-wrap:wrap; }
  input, button { font-family:inherit; font-size:12px; background:#161b22; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:6px 8px; }
  input { width:420px; }
  button { cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  #status { font-size:12px; color:var(--status-neutral); }
  .run { color:var(--status-success); font-weight:bold; }
  .bad { color:var(--status-danger); }
  pre { white-space:pre-wrap; word-break:break-word; font-size:12px; line-height:1.45; margin:0; }
  .pane { border:1px solid #30363d; border-radius:6px; padding:10px; margin-bottom:12px; }
  .pane h2 { font-size:12px; margin:0 0 8px; color:var(--status-neutral); text-transform:uppercase; letter-spacing:1px; }
  #activity { max-height:46vh; overflow:auto; }
  .ev { margin:1px 0; }
  .kind-text { color:#c9d1d9; }
  .kind-tool { color:var(--status-tool); }
  .kind-step_start, .kind-step_finish { color:var(--status-neutral); }
  .kind-output { color:var(--status-output); }
  .diff { color:var(--status-diff); }
</style>
</head>
<body>
<h1>Soc_brain · control plane</h1>
<div class="row">
  <label>Instruction <input id="instr" placeholder="what should the executor do?" style="width:470px"></label>
  <button id="run">RUN</button>
  <button id="stop">STOP</button>
  <button id="diffBtn">View Diff</button>
</div>
<div class="row"><span id="status">idle</span></div>
<div class="pane"><h2>OpenCode (supported output, passthrough)</h2><div id="activity"><pre>(no activity)</pre></div></div>
<div class="pane"><h2>Changes</h2><pre id="changes">(none observed)</pre></div>
<script>
'use strict';
var state = { handle: null };
function el(id) { return document.getElementById(id); }
function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
function setStatus(html) { el('status').innerHTML = html; }
async function api(path, opts) {
  var r = await fetch(path, opts);
  var body = await r.json().catch(function () { return { ok: false, reason: 'BAD_JSON' }; });
  return { code: r.status, body: body };
}
function fmtExec(e) {
  if (!e) return 'no execution';
  var bits = ['OpenCode', e.status];
  if (e.pid != null) bits.push('pid ' + e.pid);
  if (e.elapsedMs != null) bits.push((e.elapsedMs / 1000).toFixed(1) + 's');
  if (e.model) bits.push(e.model);
  if (e.exitCode != null) bits.push('exit ' + e.exitCode);
  if (e.reason) bits.push(e.reason);
  var cls = (e.status === 'RUNNING' || e.status === 'STARTING') ? 'run' : (e.status === 'EXITED' ? '' : 'bad');
  return '<span class="' + cls + '">' + esc(bits.join(' · ')) + '</span>';
}
function fmtEvent(it) {
  var cls = 'kind-' + it.kind;
  if (it.kind === 'text') return '<div class="ev ' + cls + '">' + esc(it.text) + '</div>';
  if (it.kind === 'tool') return '<div class="ev ' + cls + '">[tool] ' + esc(it.tool || (it.event && JSON.stringify(it.event)) || '') + '</div>';
  if (it.kind === 'output') return '<div class="ev ' + cls + '">' + esc(it.line) + '</div>';
  if (it.kind === 'event') return '<div class="ev ' + cls + '">' + esc(JSON.stringify(it.event)) + '</div>';
  return '<div class="ev ' + cls + '">[' + esc(it.kind) + ']</div>';
}
async function refresh() {
  if (!state.handle) return;
  try {
    var s = await api('/api/state?identityHash=' + state.handle);
    if (s.body.ok) {
      var t = s.body.task;
      setStatus(fmtExec(s.body.execution) + (t ? ' · task ' + esc(t.taskId) + ' (' + esc(t.state) + ')' : ' · no session'));
    } else setStatus('<span class="bad">' + esc(s.body.reason || 'state unavailable') + '</span>');
    var a = await api('/api/activity?identityHash=' + state.handle + '&maxLines=200');
    if (a.body.ok && a.body.available) {
      var html = a.body.items.map(fmtEvent).join('');
      el('activity').innerHTML = html || '<pre>(no events yet)</pre>';
      var box = el('activity');
      if (box.scrollHeight - box.scrollTop - box.clientHeight < 80) box.scrollTop = box.scrollHeight;
    }
  } catch (e) { setStatus('<span class="bad">refresh failed: ' + esc(e.message) + '</span>'); }
}
el('run').onclick = async function () {
  var instruction = el('instr').value.trim();
  if (!instruction) { setStatus('<span class="bad">instruction required</span>'); return; }
  el('run').disabled = true;
  setStatus('launching…');
  // Phase A5: instruction-only launch. The server allocates a local task
  // number and returns an OPAQUE identity handle (identityHash); the browser
  // never learns or supplies a task number.
  var r = await api('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction: instruction }) });
  el('run').disabled = false;
  if (!r.body.ok) { setStatus('<span class="bad">' + esc(r.body.error || r.body.reason) + (r.body.detail ? ' — ' + esc(r.body.detail) : '') + '</span>'); return; }
  state.handle = r.body.identityHash;
  el('instr').value = '';
  setStatus('launched pid ' + r.body.pid + ' · ' + (r.body.localTask ? 'local task' : 'issue ' + r.body.issueNumber));
  refresh();
};
el('stop').onclick = async function () {
  if (!state.handle) return;
  var r = await api('/api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identityHash: state.handle }) });
  setStatus(r.body.ok ? 'stop signalled' : '<span class="bad">' + esc(r.body.reason || 'stop failed') + '</span>');
};
el('diffBtn').onclick = async function () {
  if (!state.handle) return;
  var r = await api('/api/changes?identityHash=' + state.handle);
  var b = r.body;
  if (!b.ok || !b.available) { el('changes').textContent = b.reason || 'changes unavailable'; return; }
  var out = b.files.map(function (f) { return f.workTree + f.index + '  ' + f.path + (f.binary ? '  (binary)' : '  +' + (f.inserted == null ? 0 : f.inserted) + '/-' + (f.deleted == null ? 0 : f.deleted)); }).join('\\n');
  el('changes').innerHTML = '<span class="diff">' + esc(out || '(clean worktree)') + '</span>\\n' + esc(b.diff && b.diff.text ? b.diff.text : '');
};
setInterval(refresh, 2000);
</script>
</body>
</html>`;
}

// ---- CLI entry: node control-ui.mjs --repo owner/name [--port 3117] -----------
const CLI_ENTRY = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('control-ui.mjs');
if (CLI_ENTRY) {
  const args = process.argv.slice(2);
  const argOf = (name, dflt) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
  };
  const repo = argOf('--repo', null);
  const port = Number(argOf('--port', '3117'));
  if (!repo) { console.error('usage: node control-ui.mjs --repo owner/name [--port 3117]'); process.exit(2); }
  // stateDir must be a concrete string: executor-launcher and the state/
  // activity/changes projections require it (taskStart alone has an internal
  // fallback — E2E #3 crashed in startExecution when SOC_STATE_DIR was unset).
  const cp = createControlPlane({ repo, stateDir: process.env.SOC_STATE_DIR || defaultStateDir() });
  if (!cp.ok) { console.error(`control plane init failed: ${cp.reason}`); process.exit(1); }
  createControlUiServer({ controlPlane: cp, port }).listen().then(({ host, port: p }) => {
    console.log(`[control-ui] http://${host}:${p}/  repo=${cp.repo}`);
  }).catch((e) => { console.error(`listen failed: ${e.message}`); process.exit(1); });
}
