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
import path from 'node:path';
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
import { buildTaskViewModel } from './ui-view-model.mjs';
import { createRefsCache, resolveIssueRef, isLocalTaskNumber, defaultListers } from './gh-refs.mjs';

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
    // GitHub-backed title projection (Issue #136): injectable listers for tests;
    // production uses the bounded `gh` transport (same CLI as canonical delivery).
    refs: deps.refs || createRefsCache(),
    listers: deps.listers || defaultListers(),
  };
  async function ensureRefs() {
    try { return await D.refs.ensure({ repo: canonicalRepo, listIssues: () => D.listers.listIssues(canonicalRepo), listPrs: () => D.listers.listPrs(canonicalRepo) }); }
    catch { return null; }
  }
  function refsFor(issueNumber, prNumber) {
    const idx = D.refs.peek(canonicalRepo);
    if (!idx) return { issueTitle: null, prTitle: null };
    return resolveIssueRef({ index: idx, issueNumber, prNumber });
  }
  async function viewModel(t) {
    const target = resolveTarget(t);
    if (!target.ok) return { ok: false, reason: target.reason };
    void ensureRefs(); // warm/refresh the title index in the background; VM uses the cached index
    const prNumber0 = (() => {
      try {
        const s = D.readSession(sessionPathFor({ stateDir, identityHash: identityHash({ repo: canonicalRepo, issueNumber: target.issueNumber }) }));
        if (s && s.ok && s.session && Number.isInteger(s.session.prNumber)) return s.session.prNumber;
      } catch { /* fail-isolated */ }
      return null;
    })();
    return buildTaskViewModel({
      repo: canonicalRepo, issueNumber: target.issueNumber, stateDir,
      prNumber: prNumber0,
      deps: {
        readSession: D.readSession,
        resolveRefs: isLocalTaskNumber(target.issueNumber)
          ? null
          : async ({ issueNumber, prNumber }) => {
              const idx = await ensureRefs();
              return idx ? resolveIssueRef({ index: idx, issueNumber, prNumber }) : null;
            },
      },
    });
  }
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
  // ---- Issue #136 step 2: truthful 3-layer state projection for the sidebar.
  // Primary = canonical lifecycle (verbatim). Runtime layers are computed from
  // the execution record (process facts) — a stale SESSION_ACTIVE record with a
  // dead process is NEVER projected as a live session. No FSM mutation.
  function projectTaskState({ state, issueNumber }) {
    const SESSION_TERMINAL = ['COMPLETED', 'FAILED', 'BLOCKED'];
    const ex = (() => {
      try {
        const r = D.launcher.readExecutionStatus({ stateDir, repo: canonicalRepo, issueNumber, includeActivity: false });
        return r && r.ok && r.execution ? r.execution : null;
      } catch { return null; }
    })();
    const processStatus = (ex && ex.status) || 'UNKNOWN';
    const processLive = processStatus === 'RUNNING' || processStatus === 'STARTING';
    const sessionActive = state === 'SESSION_ACTIVE' && processLive;
    let displayState;
    if (state === 'SESSION_ACTIVE') {
      displayState = processLive ? 'EXECUTING' : (processStatus === 'UNKNOWN' ? 'UNKNOWN' : 'STALLED');
    } else if (SESSION_TERMINAL.includes(state) || state === 'HUMAN_GATE_REQUIRED' || state === 'WAITING_FOR_INPUT') {
      displayState = state; // terminal + gate lifecycles are shown verbatim
    } else {
      displayState = state ?? 'UNKNOWN';
    }
    return { displayState, sessionActive, processStatus, runtimeStatus: processStatus };
  }
  // Task list projection: scan canonical session records (stateDir/sessions),
  // keep THIS repo's sessions, surface ONLY public-safe fields (no lease token,
  // no absolute paths — same invariant as buildStateResponse). Fail-isolated:
  // unreadable/corrupt records are skipped, never crash the projection.
  // Issue #136: + prNumber (canonical binding), + GitHub issue title (display
  // only, from the bounded title index; null when unavailable — never guessed).
  async function listTasks() {
    const out = { schemaVersion: '1', repo: canonicalRepo, tasks: [] };
    void ensureRefs(); // background warm/refresh of the title index
    let entries = [];
    try { entries = fs.readdirSync(path.join(path.resolve(stateDir), 'sessions')); } catch { return out; }
    const seen = new Set();
    for (const name of entries) {
      if (!name.endsWith('.json') || seen.has(name)) continue;
      seen.add(name);
      try {
        const s = readSessionRecord(path.join(path.resolve(stateDir), 'sessions', name));
        if (!s || !s.ok || !s.session) continue;
        if (normalizeRemoteUrl(s.session.repo) !== canonicalRepo) continue;
        const issueNumber = s.session.issueNumber;
        const prNumber = Number.isInteger(s.session.prNumber) ? s.session.prNumber : null;
        const refs = isLocalTaskNumber(issueNumber)
          ? { issueTitle: null, prTitle: null }
          : refsFor(issueNumber, prNumber);
        out.tasks.push({
          taskId: s.session.taskId ?? `${canonicalRepo}#${issueNumber}`,
          issueNumber,
          state: s.session.state,
          ...projectTaskState({ state: s.session.state, issueNumber }),
          prNumber,
          issueTitle: refs.issueTitle,
          prTitle: refs.prTitle,
          branch: s.session.branch ?? null,
          headSha: s.session.headSha ?? null,
          startedAt: (s.session.lease && s.session.lease.issuedAt) || s.session.startedAt || null,
        });
      } catch { /* fail-isolated */ }
    }
    out.tasks.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
    return out;
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
  return { ok: true, repo: canonicalRepo, admitAndLaunch, stop, state, viewModel, listTasks, activity, changes, activeRuns };
}

// ---- HTTP server (loopback-only, no CORS) -------------------------------------
export function createControlUiServer({ controlPlane, host = '127.0.0.1', port = 0 } = {}) {
  const server = http.createServer(async (req, res) => {
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
      if (req.method === 'GET' && u.pathname === '/api/vm') {
        const t = targetOf();
        if (!t.ok) return json(400, { ok: false, reason: t.reason });
        const r = await controlPlane.viewModel(t.t);
        return json(r.ok === false ? 400 : 200, r.ok === false ? r : { ok: true, ...r });
      }
      if (req.method === 'GET' && u.pathname === '/api/tasks') {
        return json(200, { ok: true, ...await controlPlane.listTasks() });
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

// ---- Soc_brain UI v2 (Issue #130) — terminal/dev-tool dashboard --------------------
// Dark theme, brain logo + orange wordmark, purple accent for state/progress,
// green healthy / orange current-step / red danger. Desktop-first. Terminal &
// details open in a modal — the main layout never reflows for detail views.
// All state comes from the canonical view-model adapter (/api/vm); raw
// executor output is rendered verbatim as observability only.
export function renderUiPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1280">
<title>Soc_brain Control</title>
<style>
  :root {
    --bg:#0a0d13; --panel:#10151f; --panel2:#171d2a; --border:#272d3e; --border2:#343c52;
    --text:#d5dbe4; --dim:#8b93a3; --faint:#5c6474;
    --accent:#a371f7; --accent-dim:#7e52d6; --orange:#f0883e; --green:#3fb950; --red:#f85149; --yellow:#d29922;
    --status-success:#3fb950; --status-danger:#f85149;
    --sans:'Segoe UI',system-ui,-apple-system,'Inter',sans-serif;
    --mono:'Cascadia Mono',Consolas,'Courier New',monospace;
  }
  * { box-sizing:border-box; }
  html,body { height:100%; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:var(--sans); font-size:13px; line-height:1.5; }
  .mono { font-family:var(--mono); }
  button { font-family:inherit; font-size:12px; background:var(--panel2); color:var(--text); border:1px solid var(--border); border-radius:4px; padding:4px 10px; cursor:pointer; }
  button:hover { border-color:var(--accent); color:#fff; }
  button:disabled { opacity:.45; cursor:default; }
  input { font-family:var(--mono); font-size:12px; background:#0d1118; color:var(--text); border:1px solid var(--border); border-radius:4px; padding:5px 8px; }
  input:focus { outline:none; border-color:var(--accent); }
  ::-webkit-scrollbar { width:8px; height:8px; }
  ::-webkit-scrollbar-thumb { background:#2a3140; border-radius:4px; }
  ::-webkit-scrollbar-track { background:transparent; }

  .shell { display:grid; grid-template-columns:232px 1fr; height:100vh; }
  .side { background:var(--panel); border-right:1px solid var(--border); display:flex; flex-direction:column; }
  .brand { display:flex; align-items:center; gap:9px; padding:14px 14px 12px; border-bottom:1px solid var(--border); }
  .brand svg { flex:none; }
  .brand-name { font-family:var(--mono); font-size:15px; font-weight:700; color:var(--orange); letter-spacing:.4px; }
  .brand-sub { display:flex; align-items:center; gap:5px; font-size:9px; color:var(--faint); letter-spacing:1.5px; text-transform:uppercase; margin-top:2px; }
  .brand-dot { width:6px; height:6px; border-radius:50%; background:var(--green); display:inline-block; }
  .brand-dot.off { background:var(--red); }
  nav { padding:10px 8px; display:flex; flex-direction:column; gap:2px; }
  .nav { display:flex; align-items:center; gap:9px; width:100%; text-align:left; background:none; border:none; border-radius:5px; padding:7px 10px; color:var(--dim); font-size:12px; }
  .nav .glyph { width:16px; text-align:center; color:var(--faint); }
  .nav:hover { color:var(--text); background:var(--panel2); border:none; }
  .nav.active { color:#fff; background:rgba(163,113,247,.14); box-shadow:inset 2px 0 0 var(--accent); }
  .nav.active .glyph { color:var(--accent); }
  .side-foot { margin-top:auto; padding:10px 12px; border-top:1px solid var(--border); }
  .side-foot h3 { margin:0 0 6px; font-size:9px; text-transform:uppercase; letter-spacing:1.4px; color:var(--faint); }
  .side-task { display:flex; align-items:flex-start; gap:7px; padding:5px 6px; border-radius:4px; cursor:pointer; }
  .side-task:hover { background:var(--panel2); }
  .side-task.active { background:rgba(163,113,247,.10); }
  .side-task .dot { margin-top:5px; flex:none; }
  .side-task .st { font-size:11.5px; color:var(--text); line-height:1.35; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .side-task .st b { color:var(--accent); font-weight:600; }
  .side-task .ex { display:block; font-size:9.5px; color:var(--faint); }
  .switch { display:flex; flex-direction:column; gap:1px; }
  .switch button { text-align:left; background:none; border:none; padding:4px 6px; border-radius:4px; color:var(--dim); font-size:11px; }
  .switch button:hover { color:var(--text); background:var(--panel2); border:none; }
  .switch button.active { color:var(--accent); background:var(--panel2); border:none; }
  .ver { margin-top:8px; font-size:10px; color:var(--faint); }

  main { overflow:auto; }
  .top { display:flex; align-items:center; gap:10px; padding:9px 16px; border-bottom:1px solid var(--border); background:var(--panel); position:sticky; top:0; z-index:5; }
  .crumb { font-size:11px; letter-spacing:1.2px; color:var(--dim); text-transform:uppercase; }
  .crumb b { color:var(--text); }
  .top-right { margin-left:auto; display:flex; gap:8px; align-items:center; }
  .chip { font-size:10px; padding:2px 8px; border-radius:10px; border:1px solid var(--border2); color:var(--dim); white-space:nowrap; }
  .chip.demo { color:var(--orange); border-color:var(--orange); }
  .chip.live { color:var(--green); border-color:var(--green); }

  .view { padding:14px 16px 20px; }
  .hidden { display:none !important; }

  .card { background:var(--panel); border:1px solid var(--border); border-radius:6px; padding:12px 14px; }
  .card h2 { margin:0 0 10px; font-size:10px; text-transform:uppercase; letter-spacing:1.4px; color:var(--faint); font-weight:600; }
  .card h2 .hint { color:var(--faint); font-weight:400; text-transform:none; letter-spacing:0; }

  .banner { margin:10px 16px 0; border-radius:6px; padding:9px 14px; font-size:12.5px; border:1px solid; }
  .banner.warn { background:rgba(210,153,34,.08); border-color:var(--yellow); color:var(--yellow); }
  .banner.danger { background:rgba(248,81,73,.08); border-color:var(--red); color:var(--red); }

  .task-head { display:flex; flex-direction:column; gap:8px; }
  .th-r1 { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
  .task-id { font-family:var(--mono); color:var(--accent); font-size:15px; font-weight:700; white-space:nowrap; }
  .task-title { font-size:17px; font-weight:650; color:#f2f6fc; letter-spacing:.1px; }
  .th-pr { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; font-size:12.5px; }
  .th-pr .pr-id { font-family:var(--mono); color:var(--green); font-weight:600; }
  .th-pr .pr-arrow { color:var(--faint); }
  .th-pr .pr-title { color:var(--dim); }
  .th-pr .pr-none { color:var(--yellow); font-size:11.5px; }
  .th-ops { display:flex; align-items:center; gap:9px; flex-wrap:wrap; color:var(--dim); font-size:12px; }
  .th-ops .sep { color:var(--faint); }
  .th-r2 { display:flex; gap:14px; flex-wrap:wrap; color:var(--dim); font-size:12px; }
  .th-r2 b { font-family:var(--mono); color:var(--text); font-weight:600; font-size:11.5px; }
  .th-r2 .k { color:var(--faint); }
  details.th-details { border-top:1px solid var(--border); margin-top:8px; padding-top:6px; }
  details.th-details > summary { cursor:pointer; color:var(--dim); font-size:11px; user-select:none; list-style:none; }
  details.th-details > summary::-webkit-details-marker { display:none; }
  details.th-details > summary::before { content:'\\25B8 '; color:var(--faint); }
  details.th-details[open] > summary::before { content:'\\25BE '; }
  details.th-details .th-r2 { margin-top:7px; }
  .strip { display:flex; align-items:center; gap:10px; border-top:1px solid var(--border); margin-top:10px; padding-top:9px; font-size:12px; }
  .strip .right { margin-left:auto; display:flex; gap:10px; align-items:center; color:var(--dim); font-size:11.5px; }
  .strip .right b { font-family:var(--mono); color:var(--text); font-weight:600; }

  .badge { display:inline-flex; align-items:center; gap:5px; font-size:10px; padding:2px 9px; border-radius:10px; border:1px solid var(--border2); color:var(--dim); white-space:nowrap; }
  .badge::before { content:''; width:6px; height:6px; border-radius:50%; background:var(--dim); }
  .badge.purple { color:var(--accent); border-color:var(--accent); } .badge.purple::before { background:var(--accent); }
  .badge.green { color:var(--status-success); border-color:var(--status-success); } .badge.green::before { background:var(--status-success); }
  .badge.orange { color:var(--orange); border-color:var(--orange); } .badge.orange::before { background:var(--orange); }
  .badge.yellow { color:var(--yellow); border-color:var(--yellow); } .badge.yellow::before { background:var(--yellow); }
  .badge.red { color:var(--status-danger); border-color:var(--status-danger); } .badge.red::before { background:var(--status-danger); }
  .badge.dim::before { background:var(--faint); }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--faint); display:inline-block; flex:none; }
  .dot.purple { background:var(--accent); } .dot.green { background:var(--status-success); }
  .dot.red { background:var(--status-danger); } .dot.orange { background:var(--orange); }

  .cols { display:grid; grid-template-columns:1fr 320px; gap:14px; margin-top:14px; align-items:start; }
  .col-right { display:flex; flex-direction:column; gap:14px; }
  .cards-row { display:grid; grid-template-columns:1fr 1fr 1fr; gap:14px; margin-top:14px; }

  .tabs { display:flex; gap:2px; margin-bottom:-1px; }
  .tab { background:none; border:1px solid transparent; border-bottom:2px solid transparent; border-radius:4px 4px 0 0; color:var(--dim); padding:6px 14px; font-size:12px; }
  .tab:hover { color:var(--text); }
  .tab.active { color:#fff; background:none; border-color:transparent; border-bottom:2px solid var(--accent); box-shadow:none; }
  .tabbody { border-radius:0 8px 8px 8px; min-height:220px; }

  .logbox { height:32vh; min-height:220px; overflow-y:auto; white-space:pre-wrap; word-break:break-word; font-family:var(--mono); font-size:11.5px; }
  .logbox .k-text { color:var(--text); }
  .logbox .k-tool { color:var(--accent); }
  .logbox .k-output { color:var(--orange); }
  .logbox .k-event { color:var(--dim); }
  .logbox .k-other { color:var(--faint); }
  .logbox .k-error { color:var(--status-danger); }
  .logbox .k-pass { color:var(--status-success); }
  .logbox .k-transition { color:var(--accent); font-weight:600; }
  .logrow { cursor:pointer; display:flex; gap:10px; padding:1px 2px; }
  .logrow:hover { background:rgba(163,113,247,.07); }
  .logrow .txt { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .logrow .ts { color:var(--faint); flex:none; }
  .log-empty { color:var(--faint); padding:8px 2px; }

  .pbar-wrap { display:flex; align-items:center; gap:12px; margin-bottom:12px; }
  .pbar { flex:1; height:8px; border-radius:4px; background:var(--panel2); border:1px solid var(--border); overflow:hidden; }
  .pbar-fill { height:100%; background:linear-gradient(90deg,var(--accent-dim),var(--accent)); }
  .pbar-label { font-size:12px; color:var(--text); white-space:nowrap; }
  .pbar-label b { color:var(--accent); }
  .cur-step { color:var(--orange); font-size:11px; margin-bottom:10px; }
  .steps { display:flex; flex-direction:column; gap:4px; }
  .step { display:flex; gap:9px; align-items:baseline; padding:3px 6px; border-radius:4px; }
  .step .mk { width:14px; text-align:center; flex:none; }
  .step .ix { color:var(--faint); width:24px; flex:none; }
  .step .nm { color:var(--text); }
  .step.done .mk { color:var(--green); } .step.done .nm { color:var(--dim); }
  .step.run { background:rgba(240,136,62,.07); } .step.run .mk { color:var(--orange); }
  .step.blk { background:rgba(248,81,73,.07); } .step.blk .mk { color:var(--red); }
  .step.pend .mk { color:var(--faint); }

  .kv { display:grid; grid-template-columns:auto 1fr; gap:3px 14px; font-size:11.5px; }
  .kv .k { color:var(--faint); }
  .kv .v { color:var(--text); word-break:break-all; }
  .kv .v.mono-hi { color:var(--accent); }
  .kv .v.dimv { color:var(--faint); }

  .filelist { margin:0 0 10px; padding:0; list-style:none; font-size:11.5px; }
  .filelist li { padding:2px 0; color:var(--dim); }
  .filelist li b { color:var(--text); font-weight:600; margin-right:8px; }
  .filelist .st { color:var(--accent); }
  .diffbox { max-height:340px; overflow:auto; white-space:pre; font-size:11px; background:#0d1118; border:1px solid var(--border); border-radius:6px; padding:8px 10px; }
  .diff-add { color:var(--status-success); }
  .diff-del { color:var(--status-danger); }
  .diff-hunk { color:var(--accent); }

  .events { display:flex; flex-direction:column; gap:2px; max-height:170px; overflow:auto; }
  .ev { display:flex; gap:10px; align-items:baseline; padding:2px 4px; border-radius:4px; cursor:pointer; }
  .ev:hover { background:var(--panel2); }
  .ev .at { color:var(--faint); flex:none; font-size:10.5px; }
  .ev .lb { color:var(--accent); flex:none; }
  .ev .lb.life { color:var(--orange); }
  .ev .dt { color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  .placeholder { color:var(--faint); padding:40px 0; text-align:center; font-size:12px; }
  .placeholder b { color:var(--dim); }

  .modal-wrap { position:fixed; inset:0; background:rgba(4,6,10,.78); display:flex; align-items:center; justify-content:center; z-index:50; }
  .modal { width:min(1180px,84vw); height:min(820px,84vh); background:var(--panel); border:1px solid var(--border2); border-radius:6px; display:flex; flex-direction:column; box-shadow:0 18px 60px rgba(0,0,0,.55); }
  .modal-head { display:flex; align-items:center; gap:10px; padding:9px 14px; border-bottom:1px solid var(--border); }
  .modal-head .t { color:#fff; font-size:12.5px; font-weight:600; letter-spacing:.3px; }
  .modal-head .sub { font-family:var(--mono); color:var(--faint); font-size:10.5px; margin-left:auto; }
  .modal-body { padding:12px 14px; overflow:auto; }
  .modal .logbox { height:calc(84vh - 96px); max-height:none; }
  .follow { display:flex; align-items:center; gap:5px; font-size:10.5px; color:var(--dim); }
  @media (max-width:1080px) { .cols { grid-template-columns:1fr; } .cards-row { grid-template-columns:1fr; } }
</style>
</head>
<body>
<div class="shell">
  <aside class="side">
    <div class="brand">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#f0883e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 4.8a3.1 3.1 0 0 0-5.6 1.1 3.4 3.4 0 0 0-2.1 4.9 3.4 3.4 0 0 0 .5 5.6 3.2 3.2 0 0 0 3.6 3.2A3.1 3.1 0 0 0 12 19.2Z"/>
        <path d="M12 4.8a3.1 3.1 0 0 1 5.6 1.1 3.4 3.4 0 0 1 2.1 4.9 3.4 3.4 0 0 1-.5 5.6 3.2 3.2 0 0 1-3.6 3.2A3.1 3.1 0 0 1 12 19.2Z"/>
        <path d="M12 4.8v14.4"/>
        <path d="M9 9.3c1 .6 2 .6 3 0m-2.6 5c.8.5 1.8.5 2.6 0"/>
      </svg>
      <div><div class="brand-name">Soc_brain</div><div class="brand-sub"><span class="brand-dot" id="cpDot"></span> control plane</div></div>
    </div>
    <nav>
      <button class="nav active" data-view="tasks"><span class="glyph">&#9656;</span>Tasks</button>
      <button class="nav" data-view="executors"><span class="glyph">&#9881;</span>Executors</button>
      <button class="nav" data-view="executions"><span class="glyph">&#9636;</span>Executions</button>
      <button class="nav" data-view="reviews"><span class="glyph">&#9745;</span>Reviews</button>
      <button class="nav" data-view="telegram"><span class="glyph">&#9992;</span>Telegram</button>
      <button class="nav" data-view="settings"><span class="glyph">&#9874;</span>Settings</button>
    </nav>
    <div class="side-foot">
      <h3>Active / Recent</h3>
      <div class="switch" id="taskSwitch"></div>
      <div class="ver" id="verLine">UI v2 &middot; loopback only</div>
    </div>
  </aside>

  <main>
    <header class="top">
      <div class="crumb">SOC_BRAIN / <b id="viewTitle">TASKS</b></div>
      <div class="top-right">
        <span class="chip demo" id="liveChip">STALE</span>
        <button id="pauseBtn" title="pause auto-refresh">&#10073;&#10073; pause</button>
        <button id="refreshBtn" title="refresh now">&#8635; refresh</button>
        <button id="detailsBtn" title="canonical view-model + evidence">details</button>
        <button id="termBtn" title="open terminal popup">&gt;_ terminal</button>
      </div>
    </header>
    <div id="banner" class="banner hidden"></div>

    <section class="view" id="view-tasks">
      <div class="card task-head">
        <div class="th-r1">
          <span class="task-id" id="tIssue">#&mdash;</span>
          <span class="task-title" id="tTitle">&mdash;</span>
        </div>
        <div class="th-pr" id="tPrLine"></div>
        <div class="th-ops" id="tOpsLine"></div>
        <details class="th-details" id="tDetails">
          <summary>GitHub / Runtime details &#9656;</summary>
          <div class="th-r2" id="tMeta"></div>
        </details>
        <div class="strip">
          <span class="mono" style="color:var(--faint);font-size:11px" id="pStepLabel">STEP —/—</span>
          <div class="pbar" style="width:180px"><div class="pbar-fill" id="pFill2" style="width:0%"></div></div>
          <span class="pbar-label" style="font-size:11.5px" id="pLabel2">&mdash;</span>
          <span class="cur-step" style="margin:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" id="pCur2"></span>
          <span class="right">
            <span><b class="mono" id="mElapsed">&mdash;</b></span>
            <span class="badge dim" id="mHealth">offline</span>
            <span class="badge purple" id="mState">NO_SESSION</span>
          </span>
        </div>
      </div>

      <div class="cols">
        <div class="col-main">
          <div class="tabs" role="tablist">
            <button class="tab active" data-tab="log" role="tab">Log</button>
            <button class="tab" data-tab="progress" role="tab">Progress</button>
            <button class="tab" data-tab="todo" role="tab">Todo</button>
            <button class="tab" data-tab="files" role="tab">Files</button>
            <button class="tab" data-tab="env" role="tab">Environment</button>
          </div>
          <div class="card tabbody" id="pane-log" style="border-radius:0 6px 6px 6px">
            <div class="pbar-wrap" style="margin-bottom:8px">
              <span class="chip" id="logCount">no log</span>
              <span style="flex:1"></span>
              <button id="logScrollBtn" title="pause/resume autoscroll">&#10073;&#10073; autoscroll</button>
              <button id="openTermBtn">&gt;_ open terminal</button>
            </div>
            <div class="logbox" id="logBox"><div class="log-empty">(no activity)</div></div>
          </div>
          <div class="card tabbody hidden" id="pane-progress">
            <div class="pbar-wrap">
              <div class="pbar"><div class="pbar-fill" id="pFill" style="width:0%"></div></div>
              <span class="pbar-label" id="pLabel">&mdash;</span>
            </div>
            <div class="cur-step" id="pCur"></div>
            <div class="steps" id="pSteps"></div>
          </div>
          <div class="card tabbody hidden" id="pane-todo">
            <div class="steps" id="todoList"></div>
          </div>
          <div class="card tabbody hidden" id="pane-files">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
              <span class="chip" id="fileCount">no files observed</span>
              <span style="flex:1"></span>
              <button id="diffBtn">View Diff</button>
            </div>
            <ul class="filelist" id="fileList"></ul>
            <div class="diffbox hidden" id="diffBox"></div>
          </div>
          <div class="card tabbody hidden" id="pane-env">
            <div class="kv" id="envKv"></div>
          </div>
        </div>

        <aside class="col-right">
          <div class="card"><h2>Task Overview</h2><div class="kv" id="ovKv"></div></div>
          <div class="card"><h2>Executor Todo <span class="hint">executor telemetry &mdash; not canonical truth</span></h2><div class="steps" id="ovTodo"></div></div>
        </aside>
      </div>

      <div class="cards-row">
        <div class="card"><h2>Agent &amp; Runtime</h2><div class="kv" id="cRuntime"></div></div>
        <div class="card"><h2>Telemetry</h2><div class="kv" id="cTelemetry"></div></div>
        <div class="card"><h2>Recent Events <span class="hint">(click for details)</span></h2><div class="events" id="cEvents"><span class="log-empty">(none)</span></div></div>
      </div>
    </section>

    <section class="view hidden placeholder" id="view-executors"><b>Executors</b><br>v1 placeholder &mdash; executor registry projection not wired yet.</section>
    <section class="view hidden placeholder" id="view-executions"><b>Executions</b><br>v1 placeholder &mdash; execution history projection not wired yet.</section>
    <section class="view hidden placeholder" id="view-reviews"><b>Reviews</b><br>v1 placeholder &mdash; REVIEW HANDOFF / review-ready projection not wired yet.</section>
    <section class="view hidden placeholder" id="view-telegram"><b>Telegram</b><br>v1 placeholder &mdash; Telegram dispatch evidence projection not wired yet (UI never parses Telegram).</section>
    <section class="view hidden placeholder" id="view-settings"><b>Settings</b><br>v1 placeholder &mdash; control plane config (repo, port, model) is resolved server-side.</section>
  </main>
</div>

<div class="modal-wrap hidden" id="modalWrap">
  <div class="modal" role="dialog" aria-modal="true" aria-label="detail popup">
    <div class="modal-head">
      <span class="t" id="modalTitle">&gt;_ terminal</span>
      <span class="sub" id="modalSub"></span>
      <button id="modalClose" aria-label="close">&#10005;</button>
    </div>
    <div class="modal-body" id="modalBody"></div>
  </div>
</div>

<script>
'use strict';
var POLL_MS = 2000;
var STALE_MS = POLL_MS * 3 + 1000;
var S = { tab:'log', view:'tasks', tasks:[], sel:null, vm:null, live:false, paused:false, busy:false, lastGood:0, lastErr:null, logFollow:true, tasksAt:0 };

var MARK = { COMPLETED:'\\u2713', IN_PROGRESS:'\\u25B6', PENDING:'\\u25CB', BLOCKED:'\\u2297' };
var STATE_CLS = { SESSION_ACTIVE:'purple', COMPLETED:'green', BLOCKED:'orange', FAILED:'red', HUMAN_GATE_REQUIRED:'yellow', WAITING_FOR_INPUT:'yellow', NO_SESSION:'dim' };
var HEALTH_CLS = { healthy:'green', attention:'orange', offline:'dim' };
var HEALTH_TXT = { healthy:'healthy', attention:'attention', offline:'offline', starting:'starting' };

// ---- data discipline (Issue #130): NO fabricated demo tasks. The sidebar is
// driven by /api/tasks (canonical session records); when no canonical session
// exists the UI shows an explicit empty state. Missing canonical fields render
// as "—"; raw logs are display-only.

function el(id) { return document.getElementById(id); }
function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
function fmtMs(ms) {
  if (ms == null || !isFinite(ms)) return '—';
  var s = Math.max(0, Math.round(ms / 1000));
  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + ss + 's';
}
// ---- Issue #136 step 5: ALL timestamps render in the VIEWER's local timezone
// ('dd/MM/yyyy HH:mm:ss'). Canonical values stay UTC ISO (never mutated);
// conversion happens only at render time via local Date getters — no timezone
// is hardcoded, so the same page shows correct local time in any TZ. The raw
// UTC ISO string stays available in tooltips and the raw-details modal.
function fmtTime(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear()
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function fmtTimeUtc(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return String(iso);
}
function fmtAgo(iso) {
  if (!iso) return '—';
  var t = Date.parse(iso);
  if (!isFinite(t)) return '—';
  var s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function fmtClock(ms) {
  if (ms == null || !isFinite(ms)) return '—';
  var s = Math.max(0, Math.round(ms / 1000));
  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return (h ? h + ':' : '') + p(m) + ':' + p(ss);
}
function kv(rows) {
  return rows.map(function (r) {
    var cls = 'v' + (r.cls ? ' ' + r.cls : '') + (r.mono ? ' mono' : '');
    return '<span class="k">' + esc(r.k) + '</span><span class="' + cls + '">' + (r.v == null || r.v === '' ? '<span class="dimv">—</span>' : esc(r.v)) + '</span>';
  }).join('');
}
async function api(path, opts) {
  var r = await fetch(path, opts);
  return { code: r.status, body: await r.json().catch(function () { return { ok:false, reason:'BAD_JSON' }; }) };
}

// ---- rendering ------------------------------------------------------------------
// ---- Issue #136 step 2: truthful badge projection. canonicalState stays
// verbatim (FSM authority); "session active" is only claimed when the runtime
// session projection says so (live process evidence).
function badgeState(vm) {
  var rs = vm.runtimeSession || {};
  var st = STATE_CLS[vm.canonicalState] || 'dim';
  var m = el('mState');
  m.className = 'badge ' + st;
  m.textContent = vm.canonicalState;
  var mh = el('mHealth');
  mh.className = 'badge ' + (HEALTH_CLS[vm.health] || 'dim');
  mh.textContent = HEALTH_TXT[vm.health] || vm.health;
}
function renderBanner(vm) {
  var b = el('banner');
  var har = vm.humanActionRequired, blk = vm.blocker;
  if (har) {
    b.className = 'banner warn';
    var act = 'Hành động: xử lý gate qua kênh control-plane (Telegram hoặc resume API của Soc_brain) — UI không tự resolve gate.';
    b.innerHTML = '\u26A0 <b>CẦN BỐ XỬ LÝ</b> — ' + esc(har.note || 'human gate open') +
      ' [' + esc(har.state) + (har.deliveryStatus ? ' · delivery: ' + har.deliveryStatus : '') + '] ' +
      '<span style="display:block">' + esc(act) + '</span><button id="bannerDetail" style="margin-left:0;margin-top:4px">Chi tiết</button>';
    b.classList.remove('hidden');
    var bd = document.getElementById('bannerDetail');
    if (bd) bd.onclick = function () { openEventDetails(har); };
  } else if (blk) {
    b.className = 'banner danger';
    b.innerHTML = '\u26D4 <b>BLOCKED</b> — ' + esc(blk);
    b.classList.remove('hidden');
  } else { b.classList.add('hidden'); }
}
// ---- Issue #136 step 1: information hierarchy for the task header. Primary =
// what + which issue; second = PR binding; third = operating state. Technical
// identifiers (repo/branch/SHA/execution/PID/model/version) collapse into the
// "GitHub / Runtime details" block (closed by default).
function renderHeader(vm) {
  var gh = vm.github || {};
  var n = vm.issueNumber != null ? vm.issueNumber : null;
  el('tIssue').textContent = n != null ? 'Issue #' + n : '#—';
  // No fabrication: title only from the GitHub-backed projection; else the raw
  // issue number alone. (taskContract titles are admission metadata, never an
  // issue title.)
  el('tTitle').textContent = gh.issueTitle != null ? gh.issueTitle : (n != null ? '' : '—');
  el('tTitle').style.display = gh.issueTitle != null ? '' : 'none';
  // PR line: canonical prNumber binding only; "Chưa tạo" when the task is
  // still executing without a PR, "—" only when nothing is known (no session).
  var pr = el('tPrLine');
  if (n == null) { pr.innerHTML = ''; }
  else if (vm.prNumber != null) {
    var prT = gh.prTitle != null ? esc(gh.prTitle) : '';
    pr.innerHTML = '<span class="pr-id">PR #' + vm.prNumber + '</span>'
      + ' <span class="pr-arrow">&#8594;</span> <span class="pr-id">Issue #' + n + '</span>'
      + (prT ? ' <span class="pr-title">· ' + prT + '</span>' : '');
  } else {
    pr.innerHTML = '<span class="pr-none">PR — Chưa tạo</span> <span class="pr-arrow">&#8594;</span>'
      + ' <span class="pr-id">Đang triển khai Issue #' + n + '</span>';
  }
  // Operating line: canonical state + step + progress + elapsed + health.
  var stepTxt = (vm.currentStep != null && vm.totalSteps != null)
    ? 'Bước ' + vm.currentStep + '/' + vm.totalSteps + (currentStepName(vm) ? ' — ' + esc(currentStepName(vm)) : '')
    : (vm.totalSteps != null ? 'Bước —/' + vm.totalSteps : null);
  var ops = [];
  ops.push('<span class="badge ' + (STATE_CLS[vm.canonicalState] || 'dim') + '">' + esc(vm.canonicalState) + '</span>');
  if (stepTxt) ops.push('<span>' + stepTxt + '</span>');
  if (vm.progressPercent != null) ops.push('<span class="sep">&middot;</span><span>' + vm.progressPercent + '%</span>');
  if (vm.elapsed != null) ops.push('<span class="sep">&middot;</span><span>' + esc(fmtMs(vm.elapsed)) + '</span>');
  ops.push('<span class="sep">&middot;</span><span class="badge ' + (HEALTH_CLS[vm.health] || 'dim') + '">' + esc(HEALTH_TXT[vm.health] || vm.health) + '</span>');
  if (vm.runtimeSession && vm.runtimeSession.sessionActive) {
    ops.push('<span class="sep">&middot;</span><span class="badge purple">session active</span>');
  }
  el('tOpsLine').innerHTML = ops.join(' ');
  // Collapsed technical identifiers (traceability only).
  el('tMeta').innerHTML = [
    { k:'repo', v:vm.repo }, { k:'branch', v:vm.branch },
    { k:'headSha', v:vm.headSha }, { k:'executor', v:vm.executor },
    { k:'version', v:vm.executorVersion }, { k:'model', v:vm.model },
    { k:'executionId', v:vm.executionId },
    { k:'pid', v:vm.pid != null ? String(vm.pid) : null }
  ].map(function (r) { return '<span><span class="k">' + esc(r.k) + '</span> <b>' + esc(r.v || '—') + '</b></span>'; }).join('');
  badgeState(vm);
}
function currentStepName(vm) {
  var cur = (vm.todo || []).filter(function (s) { return s.index === vm.currentStep; })[0];
  return cur ? cur.name : null;
}
function renderOverview(vm) {
  el('ovKv').innerHTML = kv([
    { k:'State', v:vm.canonicalState },
    { k:'Session', v:vm.runtimeSession ? (vm.runtimeSession.sessionActive ? 'active' : vm.runtimeSession.sessionState) : null },
    { k:'Process', v:vm.runtimeSession ? vm.runtimeSession.processStatus : null },
    { k:'Executor', v:vm.executor },
    { k:'Version', v:vm.executorVersion, mono:true },
    { k:'Model', v:vm.model, mono:true },
    { k:'Execution', v:vm.executionId, mono:true },
    { k:'PID', v:vm.pid != null ? String(vm.pid) : null, mono:true },
    { k:'Started', v:vm.startedAt ? fmtTime(vm.startedAt) : null, mono:true },
    { k:'Elapsed', v:fmtMs(vm.elapsed), mono:true },
    { k:'Last activity', v:vm.lastMeaningfulActivityAt ? fmtAgo(vm.lastMeaningfulActivityAt) : null, mono:true },
    { k:'Health', v:vm.health },
    { k:'Task', v:vm.taskId, mono:true },
    { k:'PR', v:vm.prNumber != null ? '#' + vm.prNumber : null },
    { k:'Blocker', v:vm.blocker, cls:vm.blocker ? 'dimv' : '' }
  ]);
}
function renderSteps(listEl, vm) {
  var steps = vm.todo || [];
  listEl.innerHTML = steps.length ? steps.map(function (s) {
    var cls = s.status === 'COMPLETED' ? 'done' : s.status === 'IN_PROGRESS' ? 'run' : s.status === 'BLOCKED' ? 'blk' : 'pend';
    var cur = s.index === vm.currentStep ? ' \u2190 current' : '';
    return '<div class="step ' + cls + '"><span class="mk">' + (MARK[s.status] || '\\u00B7') + '</span><span class="ix">' + s.index + '</span><span class="nm">' + esc(s.name) + (cur ? '<span style="color:var(--orange)">' + esc(cur) + '</span>' : '') + '</span></div>';
  }).join('') : '<div class="log-empty">NO_PROGRESS_TELEMETRY — canonical progress record absent</div>';
}
function renderProgress(vm) {
  var pct = vm.progressPercent != null ? vm.progressPercent : 0;
  el('pFill').style.width = pct + '%';
  el('pLabel').innerHTML = 'step <b>' + (vm.currentStep != null ? vm.currentStep : '—') + '</b>/' + (vm.totalSteps || '?') + ' &middot; ' + pct + '%';
  el('pFill2').style.width = pct + '%';
  el('pStepLabel').textContent = 'STEP ' + (vm.currentStep != null ? vm.currentStep : '—') + '/' + (vm.totalSteps || '—');
  el('pLabel2').textContent = pct + '%';
  var cur = (vm.todo || []).filter(function (s) { return s.index === vm.currentStep; })[0];
  var curTxt = cur ? '\u25B6 current step: ' + cur.name + (cur.status === 'BLOCKED' ? ' (BLOCKED)' : '') : '';
  el('pCur').textContent = curTxt;
  el('pCur2').textContent = cur ? 'Đang làm: ' + cur.name : '';
  el('mElapsed').textContent = fmtClock(vm.elapsed);
  renderSteps(el('pSteps'), vm);
}

// ---- Issue #136 steps 3+4: bounded log panel with human-readable lines.
// The panel scrolls independently (32vh, overflow-y) and never grows the page.
// Autoscroll follows new events ONLY while the user is at/near the bottom;
// any deliberate scroll up pauses it (resumable via the autoscroll button or
// by scrolling back down). Raw evidence (full JSON etc.) stays accessible via
// the per-row details modal — nothing is deleted from evidence.
function logMainText(it) {
  if (it.kind === 'text') return clipLine(it.text || '');
  if (it.kind === 'tool') return '[tool] ' + (it.tool || '');
  if (it.kind === 'output') return clipLine(it.line || '');
  if (it.kind === 'event') return clipLine(eventHumanSummary(it.event));
  return '[' + (it.kind || '?') + ']';
}
function clipLine(s) {
  s = String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  return s.length > 200 ? s.slice(0, 199) + '…' : s;
}
// Short human summary of a structured executor event; identifiers (sessionID,
// providerID, modelID...) are NOT rendered on the main line (raw modal has them).
function eventHumanSummary(ev) {
  if (!ev || typeof ev !== 'object') return '';
  if (ev.type === 'step_start') return '▶ step started';
  if (ev.type === 'step_finish') return '■ step finished' + (ev.part && ev.part.reason ? ' (' + ev.part.reason + ')' : '');
  return ev.type || '';
}
function logRawText(it) {
  if (it.kind === 'event' || it.kind === 'text' || it.kind === 'tool') {
    return JSON.stringify(it.event || it, null, 2);
  }
  return it.kind === 'output' ? (it.line || '') : JSON.stringify(it, null, 2);
}
function logLineClass(it, txt) {
  if (it.stream === 'stderr' || /^error\\b/i.test(txt)) return 'k-error';
  if (/\\bPASS\\b/.test(txt)) return 'k-pass';
  if (/^[A-Z][A-Z_]*\\s*(\u2192|->)\\s*[A-Z][A-Z_]*\\s*$/.test(txt.trim())) return 'k-transition';
  return 'k-' + (['text','tool','output','event'].indexOf(it.kind) >= 0 ? it.kind : 'other');
}
function renderLog(box, logs) {
  if (!logs || !logs.length) { box.innerHTML = '<div class="log-empty">(no activity)</div>'; el('logCount').textContent = 'no log'; return; }
  var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = logs.map(function (it, i) {
    var txt = logMainText(it);
    var cls = logLineClass(it, txt);
    var ts = it.t ? '<span class="ts">' + esc(fmtTime(new Date(it.t).toISOString())) + '</span>' : '';
    return '<div class="logrow ' + cls + '" data-log="' + i + '" title="click for raw event">'
      + ts + '<span class="txt">' + esc(txt) + '</span></div>';
  }).join('');
  el('logCount').textContent = logs.length + ' lines' + (S.live ? '' : ' (demo)');
  Array.prototype.forEach.call(box.querySelectorAll('.logrow'), function (n) {
    n.onclick = function () { openEventDetails(logs[Number(n.getAttribute('data-log'))] || null); };
  });
  if (nearBottom && S.logFollow) box.scrollTop = box.scrollHeight;
}
// Autoscroll pause/resume (Issue #136 step 3): user scrolling up pauses;
// returning to the bottom or clicking the button resumes.
function wireLogAutoscroll(box) {
  box.addEventListener('scroll', function () {
    var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    if (!atBottom && box.scrollTop + box.clientHeight < box.scrollHeight - 40) {
      if (S.logFollow) setLogFollow(false);
    } else if (atBottom && !S.logFollow) {
      setLogFollow(true);
    }
  });
}
function setLogFollow(on) {
  S.logFollow = on;
  var b = el('logScrollBtn');
  if (b) b.innerHTML = on ? '&#10073;&#10073; autoscroll' : '&#9654; autoscroll';
}
function renderFilesTab(vm) {
  var box = el('fileList');
  if (S.sel == null) { el('fileCount').textContent = 'no canonical task selected'; box.innerHTML = '<div class="log-empty">Chọn task canonical ở sidebar để quan sát changed files (đọc qua execution broker, read-only).</div>'; return; }
  el('fileCount').textContent = 'loading…';
  api('/api/changes?issueNumber=' + S.sel).then(function (r) {
    var b = r.body || {};
    if (!b.ok || !b.available) { el('fileCount').textContent = 'unavailable'; box.innerHTML = '<div class="log-empty">' + esc(b.reason || 'CHANGES_UNAVAILABLE') + ' — broker bind yêu cầu task đang hoạt động</div>'; return; }
    el('fileCount').textContent = b.files.length + ' changed files' + (b.files.length ? '' : ' (clean worktree)');
    box.innerHTML = b.files.map(function (f) {
      return '<li><b>' + esc((f.index == null ? ' ' : f.index) + (f.workTree == null ? '?' : f.workTree)) + '</b>' + (f.untracked ? '<span class="st">??</span>' : '') + esc(f.path) + '</li>';
    }).join('') || '<div class="log-empty">(clean worktree)</div>';
  }).catch(function () { el('fileCount').textContent = 'error'; });
}
function renderEnv(vm) {
  var r = vm.runtime || {};
  el('envKv').innerHTML = kv([
    { k:'execution status', v:r.status }, { k:'terminal', v:r.terminalStatus },
    { k:'exit', v:(r.exitCode != null ? String(r.exitCode) : null), mono:true }, { k:'signal', v:r.signal, mono:true },
    { k:'reason', v:r.reason }, { k:'sessionId', v:r.sessionId, mono:true },
    { k:'model', v:r.model, mono:true }, { k:'executor version', v:r.executorVersion, mono:true },
    { k:'agent', v:r.agent, mono:true },
    { k:'started', v:r.startedAt ? fmtTime(r.startedAt) : null, mono:true },
    { k:'finished', v:r.finishedAt ? fmtTime(r.finishedAt) : null, mono:true },
    { k:'started UTC', v:r.startedAt ? fmtTimeUtc(r.startedAt) : null, mono:true },
    { k:'finished UTC', v:r.finishedAt ? fmtTimeUtc(r.finishedAt) : null, mono:true },
    { k:'instructionDigest', v:r.instructionDigest, mono:true }, { k:'eventsOverflow', v:r.eventsOverflow ? 'true' : 'false' },
    { k:'repo', v:vm.repo, mono:true }, { k:'branch', v:vm.branch, mono:true }, { k:'headSha', v:vm.headSha, mono:true }
  ]);
}
function renderCards(vm) {
  var r = vm.runtime || {};
  el('cRuntime').innerHTML = kv([
    { k:'agent', v:vm.executor }, { k:'version', v:vm.executorVersion, mono:true },
    { k:'model', v:vm.model, mono:true },
    { k:'status', v:r.status }, { k:'pid', v:r.pid != null ? String(r.pid) : null, mono:true },
    { k:'elapsed', v:fmtMs(vm.elapsed), mono:true }, { k:'exit', v:(r.exitCode != null ? String(r.exitCode) : null), mono:true },
    { k:'health', v:vm.health }
  ]);
  var t = vm.telemetry;
  var d = t && t.durations;
  el('cTelemetry').innerHTML = d ? kv([
    { k:'wall clock', v:fmtMs(d.totalWallTime), mono:true }, { k:'executor', v:fmtMs(d.executorTime), mono:true },
    { k:'worktree', v:fmtMs(d.worktreeTime), mono:true }, { k:'verification', v:fmtMs(d.verificationTime), mono:true },
    { k:'review', v:fmtMs(d.reviewTime), mono:true }, { k:'human wait', v:fmtMs(d.humanWaitTime), mono:true },
    { k:'unattributed', v:fmtMs(d.unattributedTime), mono:true }
  ]) : '<span class="log-empty">NO_TELEMETRY — Soc_Score stream absent</span>';
  var evs = (vm.recentEvents || []).slice(0, 8);
  el('cEvents').innerHTML = evs.length ? evs.map(function (e, i) {
    return '<div class="ev" data-ev="' + i + '" title="raw UTC: ' + esc(e.at || '') + '"><span class="at">' + esc(fmtTime(e.at)) + '</span><span class="lb ' + (e.kind === 'lifecycle' ? 'life' : '') + '">' + esc(e.label) + '</span><span class="dt">' + esc(e.detail || '') + '</span></div>';
  }).join('') : '<span class="log-empty">(none)</span>';
  Array.prototype.forEach.call(el('cEvents').querySelectorAll('.ev'), function (n) {
    n.onclick = function () { openEventDetails(evs[Number(n.getAttribute('data-ev'))]); };
  });
}
// ---- Issue #136 step 2: sidebar primary = canonical lifecycle (displayState),
// secondary = live-session evidence only. Issue title outranks repo/taskId.
function renderTasks() {
  if (!S.tasks.length) {
    el('taskSwitch').innerHTML = '<div class="log-empty">NO_SESSION — chưa có task canonical nào trong state dir</div>';
    return;
  }
  el('taskSwitch').innerHTML = S.tasks.map(function (t, i) {
    var n = t.issueNumber != null ? t.issueNumber : '?';
    var title = t.issueTitle != null ? t.issueTitle : ('#' + n);
    var ds = t.displayState || t.state || 'UNKNOWN';
    var cls = ds === 'COMPLETED' ? 'dot green' : ds === 'BLOCKED' || ds === 'FAILED' ? 'dot red' : ds === 'NO_SESSION' ? 'dot' : 'dot purple';
    var sub = ds + (t.sessionActive ? ' · session active' : '');
    return '<div class="side-task' + (S.sel === t.issueNumber ? ' active' : '') + '" data-t="' + i + '" title="' + esc(t.repo || '') + '">'
      + '<span class="' + cls + '"></span><div style="min-width:0"><div class="st"><b>#' + n + '</b> ' + esc(title) + '</div>'
      + '<span class="ex">' + esc(sub) + '</span></div></div>';
  }).join('');
  Array.prototype.forEach.call(el('taskSwitch').querySelectorAll('.side-task'), function (n) {
    n.onclick = function () {
      S.sel = S.tasks[Number(n.getAttribute('data-t'))].issueNumber;
      S.lastGood = 0;
      pollTick();
    };
  });
}
function renderAll(vm) {
  var fresh = S.lastGood && (Date.now() - S.lastGood) < STALE_MS;
  el('liveChip').className = 'chip ' + (fresh ? 'live' : 'demo');
  el('liveChip').textContent = fresh ? 'LIVE · fresh' : 'STALE';
  el('liveChip').title = S.lastGood ? ('last canonical read: ' + fmtTime(new Date(S.lastGood).toISOString())) : 'no canonical read yet';
  renderHeader(vm); renderBanner(vm); renderOverview(vm);
  renderProgress(vm); renderSteps(el('todoList'), vm); renderSteps(el('ovTodo'), vm);
  renderLog(el('logBox'), vm.logs); renderFilesTab(vm); renderEnv(vm); renderCards(vm);
  renderTasks();
  el('verLine').textContent = 'UI v2 · vm ' + (vm.schemaVersion || '1') + (S.lastErr ? ' · last error: ' + S.lastErr : '');
}

// ---- modal ----------------------------------------------------------------------
function openModal(title, sub, node) {
  el('modalTitle').textContent = title;
  el('modalSub').textContent = sub || '';
  var body = el('modalBody');
  body.innerHTML = '';
  body.appendChild(node);
  el('modalWrap').classList.remove('hidden');
}
function closeModal() { el('modalWrap').classList.add('hidden'); }
function openTerminal() {
  var vm = S.vm || EMPTY_VM;
  var box = document.createElement('div');
  box.className = 'logbox';
  var bar = document.createElement('div');
  bar.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:8px';
  var lbl = document.createElement('label');
  lbl.className = 'follow';
  var cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = true;
  lbl.appendChild(cb);
  lbl.appendChild(document.createTextNode('follow'));
  bar.appendChild(lbl);
  var wrap = document.createElement('div');
  wrap.appendChild(bar); wrap.appendChild(box);
  function paint() {
    var prevRender = S.logFollow;
    renderLog(box, vm.logs);
    S.logFollow = prevRender; // modal follow is independent of the main panel
    if (S.follow) box.scrollTop = box.scrollHeight;
  }
  cb.onchange = function () { S.follow = cb.checked; };
  S.follow = true;
  paint();
  var iv = setInterval(function () {
    if (el('modalWrap').classList.contains('hidden')) { clearInterval(iv); return; }
    paint();
  }, POLL_MS);
  openModal('>_ terminal', 'exec ' + (vm.executionId ? String(vm.executionId).slice(0, 8) : '—') + ' · pid ' + (vm.pid != null ? vm.pid : '—') + ' · #' + (vm.issueNumber != null ? vm.issueNumber : '—'), wrap);
  box.scrollTop = box.scrollHeight;
}
function openEventDetails(e) {
  var wrap = document.createElement('div');
  var pre = document.createElement('pre');
  pre.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-word;color:var(--text);font-size:11.5px';
  pre.textContent = JSON.stringify(e, null, 2);
  wrap.appendChild(pre);
  if (e && e.at) {
    var meta = document.createElement('div');
    meta.className = 'log-empty';
    meta.style.padding = '6px 0 0';
    meta.textContent = 'local: ' + fmtTime(e.at) + ' · raw UTC: ' + fmtTimeUtc(e.at);
    wrap.appendChild(meta);
  }
  openModal('event details — raw evidence', e ? (e.label || '') : '', wrap);
}
function openTaskDetails(vm) {
  var wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:12px';
  function sect(title, obj) {
    var h = document.createElement('h3');
    h.textContent = title;
    h.style.cssText = 'margin:0;font-size:10px;text-transform:uppercase;letter-spacing:1.4px;color:var(--faint)';
    var pre = document.createElement('pre');
    pre.style.cssText = 'margin:4px 0 0;white-space:pre-wrap;word-break:break-word;color:var(--text);font-size:11.5px;background:#0d1118;border:1px solid var(--border);border-radius:6px;padding:8px 10px';
    pre.textContent = JSON.stringify(obj, null, 2);
    wrap.appendChild(h); wrap.appendChild(pre);
  }
  sect('canonical view-model (public projection, missing = null)', vm);
  var note = document.createElement('div');
  note.className = 'log-empty';
  note.style.padding = '0';
  note.textContent = 'Canonical sources: session record (FSM authority) · task-progress projection · Soc_Score telemetry · execution status. Raw logs là display-only. Timestamps: local render (dd/MM/yyyy HH:mm:ss) + raw UTC ISO kept verbatim. Worktree path + lease token không bao giờ lộ qua public projection.';
  wrap.appendChild(note);
  openModal('Task details — evidence & canonical paths', vm.taskId || '', wrap);
}
function openDiff(files, diffText) {
  var wrap = document.createElement('div');
  var ul = document.createElement('ul');
  ul.className = 'filelist';
  ul.innerHTML = files.map(function (f) {
    return '<li><b>' + esc((f.index == null ? ' ' : f.index) + (f.workTree == null ? '?' : f.workTree)) + '</b><span class="st">' + (f.untracked ? '??' : '') + '</span>' + esc(f.path) + '</li>';
  }).join('') || '<li>(clean worktree)</li>';
  var pre = document.createElement('div');
  pre.className = 'diffbox';
  pre.innerHTML = esc(diffText || '(empty diff)').replace(/^(\\+[^\\n]*)/gm, '<span class="diff-add">$1</span>').replace(/^(-[^\\n]*)/gm, '<span class="diff-del">$1</span>').replace(/^(@@[^\\n]*)/gm, '<span class="diff-hunk">$1</span>');
  wrap.appendChild(ul); wrap.appendChild(pre);
  openModal('View Diff — working tree', files.length + ' changed files', wrap);
}

// ---- polling (bounded: page-visible only; canonical sources only) -----------------
var EMPTY_VM = { schemaVersion:'1', canonicalState:'NO_SESSION', phase:'idle', health:'offline', github:{ issueTitle:null, prTitle:null }, runtimeSession:{ taskLifecycle:'NO_SESSION', sessionState:null, processStatus:null, sessionActive:false } };
async function pollTick() {
  if (S.paused || document.hidden || S.busy) return;
  S.busy = true;
  try {
    if (!S.tasks.length || !S.sel) {
      var lt = await api('/api/tasks');
      if (lt.code !== 200 || !lt.body || !lt.body.ok) throw new Error((lt.body && lt.body.reason) || ('HTTP ' + lt.code));
      S.tasks = lt.body.tasks || [];
      if (S.tasks.length) { S.sel = S.tasks[0].issueNumber; S.lastGood = Date.now(); }
      el('cpDot').className = 'brand-dot';
      renderAll(S.vm || EMPTY_VM);
      if (S.sel) { S.busy = false; return pollTick(); }
    } else {
      var r = await api('/api/vm?issueNumber=' + S.sel);
      if (r.code !== 200 || !r.body || !r.body.ok) throw new Error((r.body && r.body.reason) || ('HTTP ' + r.code));
      S.vm = r.body.vm;
      S.lastGood = Date.now(); S.lastErr = null;
      el('cpDot').className = 'brand-dot';
      if (S.view === 'tasks') renderAll(S.vm);
      var idx = S.tasks.findIndex(function (t) { return t.issueNumber === S.sel; });
      if (idx >= 0) {
        S.tasks[idx].state = S.vm.canonicalState;
        S.tasks[idx].sessionActive = !!(S.vm.runtimeSession && S.vm.runtimeSession.sessionActive);
        S.tasks[idx].issueTitle = S.vm.github ? S.vm.github.issueTitle : S.tasks[idx].issueTitle;
        renderTasks();
      }
      // Sidebar lifecycle refresh: canonical list stays cheap; re-pull it
      // periodically so titles/states of OTHER tasks stay truthful too.
      if (!S.busy && (Date.now() - (S.tasksAt || 0)) > 10000) {
        S.tasksAt = Date.now();
        var lt2 = await api('/api/tasks');
        if (lt2.code === 200 && lt2.body && lt2.body.ok && lt2.body.tasks) S.tasks = lt2.body.tasks;
      }
    }
  } catch (e) {
    S.lastErr = String((e && e.message) || e);
    el('cpDot').className = 'brand-dot off';
    if (S.vm && S.view === 'tasks') renderAll(S.vm); // fail-safe: keep last good render, mark stale
    else renderTasks();
  }
  S.busy = false;
}

// ---- wiring ----------------------------------------------------------------------
function switchTab(name) {
  S.tab = name;
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (n) { n.classList.toggle('active', n.getAttribute('data-tab') === name); });
  ['log','progress','todo','files','env'].forEach(function (p) { el('pane-' + p).classList.toggle('hidden', p !== name); });
}
function switchView(name) {
  S.view = name;
  Array.prototype.forEach.call(document.querySelectorAll('.nav'), function (n) { n.classList.toggle('active', n.getAttribute('data-view') === name); });
  Array.prototype.forEach.call(document.querySelectorAll('.view'), function (n) { n.classList.toggle('hidden', n.id !== 'view-' + name); });
  el('viewTitle').textContent = name.toUpperCase();
  el('banner').classList.toggle('hidden', name !== 'tasks' || !(S.vm && (S.vm.humanActionRequired || S.vm.blocker)));
}
Array.prototype.forEach.call(document.querySelectorAll('.nav'), function (n) { n.onclick = function () { switchView(n.getAttribute('data-view')); }; });
Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (n) { n.onclick = function () { switchTab(n.getAttribute('data-tab')); }; });
el('modalClose').onclick = closeModal;
el('modalWrap').onclick = function (e) { if (e.target === el('modalWrap')) closeModal(); };
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
el('termBtn').onclick = openTerminal;
el('openTermBtn').onclick = openTerminal;
el('logScrollBtn').onclick = function () { setLogFollow(!S.logFollow); };
wireLogAutoscroll(el('logBox'));
el('refreshBtn').onclick = function () { S.busy = false; pollTick(); };
el('pauseBtn').onclick = function () {
  S.paused = !S.paused;
  el('pauseBtn').innerHTML = S.paused ? '&#9654; resume' : '&#10073;&#10073; pause';
};
el('diffBtn').onclick = async function () {
  if (S.sel == null) { openModal('View Diff', 'unavailable', document.createTextNode('NO_ACTIVE_TASK — chưa chọn task canonical')); return; }
  var r = await api('/api/changes?issueNumber=' + S.sel);
  var b = r.body || {};
  if (!b.ok || !b.available) { openModal('View Diff', 'unavailable', document.createTextNode(b.reason || 'changes unavailable (requires a live task)')); return; }
  openDiff(b.files || [], b.diff && b.diff.text ? b.diff.text : '');
};
el('detailsBtn').onclick = function () { if (S.vm) openTaskDetails(S.vm); };

S.tasks = [];
renderAll(EMPTY_VM);
pollTick();
setInterval(pollTick, POLL_MS);
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
