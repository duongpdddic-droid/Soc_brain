#!/usr/bin/env node
// mcp-server.mjs - Soc_brain: local stdio MCP server (Issue #18).
// Exposes Execution Broker tools through a minimal JSON-RPC 2.0 MCP transport.
// ONLY listens on stdin/stdout; NEVER on TCP. Launch via fixed command:
// node <pinned-entrypoint> with shell:false.
//
// Trusted config comes from env vars set by taskStart (control plane):
//   SOC_SESSION_PATH, SOC_SESSION_TOKEN, SOC_CONTROL_CWD
// SOC_CONTROL_CWD is the canonical/control checkout — NOT process.cwd(), which
// OpenCode sets to the execution worktree. It is validated fail-closed and used
// as controlCwd for verifySessionAuthority/createExecutionBroker.
// Authority (repo/issueNumber/baseSha/registry/capabilities) is read per
// request from the authoritative session record — NEVER from caller-input or
// from the worktree opencode.json projection (GPT-REV-136).
//
// Tools (Issue #49 core + Issue #65 lifecycle):
//   soc_broker_status   - git status of the bound worktree (read-only)
//   soc_broker_diff     - git diff of the bound worktree (read-only)
//   soc_broker_run_registered_test - execute a registered test in a snapshot
//   soc_broker_commit   - bounded canonical commit on the bound worktree
//                         (Issue #49: canonical message + task-scoped paths
//                         only; no shell, no argv, no arbitrary git verbs)
//   soc_broker_finish_task / soc_broker_block_task /
//   soc_broker_request_human_gate    - canonical FSM transitions whose Telegram
//                         lifecycle dispatch happens INSIDE the FSM operation
//   soc_broker_recover_human_gate - ONE explicit bounded recovery attempt for
//                         an undelivered HUMAN_GATE_REQUIRED notification
//                         (rev-2: DELIVERY_FAILED stays recoverable; only
//                         API_ACCEPTED permanently dedupes)
//
// (Issue #35 rework: soc_broker_run_command / run_safe_command was REMOVED —
// bounded arbitrary-command execution is not an #35 capability; deterministic
// permission verdicts remain available via createPermissionGuard.)
//
// Protocol: JSON-RPC 2.0 over stdio, newline-delimited:
//   initialize, tools/list, tools/call, notifications/initialized.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createExecutionBroker } from '../execution-broker/execution-broker.mjs';
import { verifySessionAuthority, createPermissionGuard, taskFinish, taskBlock, taskRequestHumanGate, recoverHumanGate } from './runtime-sandbox.mjs';
import { gitRoot, readRemoteUrl, remoteIsCanonical } from '../safe-git/safe-git.mjs';
import { isInside } from '../temp-hygiene/temp-hygiene.mjs';
import { applyTaskProgressUpdate } from '../task-progress/task-progress.mjs';
import { createExecutorLiveness } from './activity-lease.mjs';
import { identityHash } from '../workspace/workspace.mjs';
import { readWin32ProcessStartTime } from '../temp-hygiene/temp-hygiene.mjs';
import { readExecutionRecord } from '../executor-launcher/executor-launcher.mjs';
import { reconcileMutationGate } from '../executor-launcher/executor-reconcile.mjs';

export const MCP_SERVER_VERSION = '1';
export const MCP_PROTOCOL_VERSION = '2025-03-26';

// SOC_CONTROL_CWD must be a non-empty absolute path (fail-closed). The deeper
// validation (git root, canonical repo, not the execution worktree) runs after
// the authoritative session is read in createMcpServer.
function assertAbsoluteControlCwd(controlCwd) {
  if (typeof controlCwd !== 'string' || !controlCwd.trim()) {
    return { ok: false, reason: 'CONTROL_CWD_MISSING', detail: 'SOC_CONTROL_CWD is empty.' };
  }
  if (!path.isAbsolute(controlCwd)) {
    return { ok: false, reason: 'CONTROL_CWD_NOT_ABSOLUTE', detail: controlCwd };
  }
  return { ok: true, controlCwd };
}

function readTrustedConfig() {
  const sessionPath = process.env.SOC_SESSION_PATH;
  const leaseToken = process.env.SOC_SESSION_TOKEN;
  const controlCwd = process.env.SOC_CONTROL_CWD;
  // Issue #145: optional stable mutation-owner lane identity. Required for
  // mutation tools ONLY when the authoritative session records an owner.
  const laneId = process.env.SOC_LANE_ID || null;

  const missing = [];
  if (!sessionPath) missing.push('SOC_SESSION_PATH');
  if (!leaseToken) missing.push('SOC_SESSION_TOKEN');
  if (!controlCwd) missing.push('SOC_CONTROL_CWD');
  if (missing.length > 0) {
    return { ok: false, errors: missing.map((k) => ({ reason: 'MISSING_CONFIG', env: k })) };
  }
  const cwdRule = assertAbsoluteControlCwd(controlCwd);
  if (!cwdRule.ok) {
    return { ok: false, errors: [{ reason: cwdRule.reason, env: 'SOC_CONTROL_CWD', detail: cwdRule.detail }] };
  }
  return { ok: true, sessionPath, leaseToken, controlCwd: cwdRule.controlCwd, laneId };
}

function realPathOrNull(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

// Fail-closed validation of SOC_CONTROL_CWD against the authoritative session.
// Requires: an absolute real directory Git checkout whose origin remote matches
// the session repo, and that must NOT be (or live inside) the execution worktree.
export function validateControlCwd({ controlCwd, repo, worktreePath, exec = execFileSync }) {
  const abs = assertAbsoluteControlCwd(controlCwd);
  if (!abs.ok) return abs;
  let st;
  try { st = fs.statSync(controlCwd); } catch { return { ok: false, reason: 'CONTROL_CWD_NOT_DIRECTORY', detail: controlCwd }; }
  if (!st.isDirectory()) return { ok: false, reason: 'CONTROL_CWD_NOT_DIRECTORY', detail: controlCwd };
  let root;
  try { root = gitRoot({ cwd: controlCwd, exec }); } catch { return { ok: false, reason: 'CONTROL_CWD_NO_GIT_ROOT', detail: controlCwd }; }
  let remoteUrl = '';
  try { remoteUrl = readRemoteUrl({ remote: 'origin', cwd: controlCwd, exec }); } catch { /* leave empty -> WRONG_REPO */ }
  if (!remoteIsCanonical(remoteUrl, repo)) {
    return { ok: false, reason: 'CONTROL_CWD_WRONG_REPO', remote: remoteUrl, expected: repo, detail: controlCwd };
  }
  const ctrlReal = realPathOrNull(controlCwd);
  const wtReal = realPathOrNull(worktreePath);
  if (ctrlReal && wtReal) {
    const ctrlRes = path.resolve(ctrlReal);
    const wtRes = path.resolve(wtReal);
    if (ctrlRes === wtRes || isInside(wtRes, ctrlRes)) {
      return { ok: false, reason: 'CONTROL_CWD_IS_EXECUTION_WORKTREE', worktree: wtRes, detail: controlCwd };
    }
  }
  return { ok: true, controlCwd, root };
}

// ---- MCP server ---------------------------------------------------------------
export function createMcpServer({ config, exec = execFileSync, spawn = spawnSync } = {}) {
  if (!config) config = readTrustedConfig();
  if (!config.ok) return { ok: false, errors: config.errors };
  const { sessionPath, leaseToken, controlCwd, laneId } = config;

  // Startup authority: verify the session + lease ONCE before serving. If the
  // session is missing / tampered / contract-drifted, we never bind.
  const boot = verifySessionAuthority({ sessionPath, leaseToken, exec, controlCwd });
  if (!boot.ok) return { ok: false, errors: [{ reason: 'SESSION_AUTHORITY_DENIED', detail: boot.reason }] };
  const s = boot.session;
  // SOC_CONTROL_CWD is the trusted control-plane checkout. Validate it against
  // the authoritative session (canonical repo + execution worktree) so a
  // forged/malformed/relative/drifted value fails closed BEFORE any broker binds.
  const cc = validateControlCwd({ controlCwd, repo: s.repo, worktreePath: s.worktreePath, exec });
  if (!cc.ok) return { ok: false, errors: [{ reason: 'CONTROL_CWD_DENIED', detail: cc.reason, env: 'SOC_CONTROL_CWD', controlCwd: cc.detail }] };
  const { worktreesRoot, repo, issueNumber, baseSha, testRegistry } = s;
  // Issue #160: reconnect reconciliation gate. A mutation may proceed only when
  // the executor process identity is proven RUNNING against the canonical
  // ExecutionRecord. No ExecutionRecord => control-plane/adopt context (not an
  // executor mutation) => not gated here (per-request session authority +
  // mutation-owner check still apply). A dropped transport never maps to
  // executor death; a recycled/unknown pid is never treated as the live owner.
  const MUTATION_TOOLS = new Set(['soc_broker_commit', 'soc_broker_finish_task', 'soc_broker_block_task', 'soc_broker_request_human_gate', 'soc_broker_recover_human_gate']);
  function reconcileExecutorForMutation(vs, opts = {}) {
    // Issue #160 REWORK F2: context-aware. Called AFTER verifyRequest (session +
    // capability + binding) and verifyMutationOwnership (single owner). The
    // canonical execution context comes from the authoritative session only
    // (`executionMode`, set by startExecution); never from request/env, never
    // inferred from record presence. control-plane/adopt keeps the pre-#160
    // authority path (no ExecutionRecord required); executor mode additionally
    // reconciles the same-attempt ExecutionRecord + proven process identity.
    const ownerMatches = !!(vs.mutationOwner && vs.mutationOwner.laneId) && laneId === vs.mutationOwner.laneId;
    const sd = (vs.controlPlane && vs.controlPlane.stateDir) || (s.controlPlane && s.controlPlane.stateDir);
    // Read canonical execution-lifecycle evidence whenever a mode is not an
    // explicit control-plane; the gate uses record presence to disambiguate
    // legacy 'ambiguous' sessions (F1). Context itself is resolved by the gate
    // from the authoritative session only (F3), never from a caller flag.
    // Always read canonical execution-lifecycle evidence: a durable bind/cleanup
    // LATCH must be able to deny mutation even for an explicit control-plane
    // session whose child was spawned but not yet bound (Issue #160 BLOCKER-3).
    let rec = null;
    if (sd) {
      try { const r = readExecutionRecord({ stateDir: sd, repo: vs.repo, issueNumber: vs.issueNumber }); if (r && r.ok) rec = r.record; } catch { rec = null; }
    }
    return reconcileMutationGate({ session: vs, record: rec, ownerMatches, capabilityGranted: opts.capabilityGranted !== false, requiredCapability: opts.requiredCapability ?? null, isAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } } });
  }

  const broker = createExecutionBroker({ worktreesRoot, controlCwd: cc.controlCwd, testRegistry, exec, spawn });

  // Executor-independent permission verdict surface: re-derives authority from
  // the session on every call and returns ALLOW / DENY_AND_RECOVER /
  // BLOCKED_HUMAN_GATE (exposed to the control plane; dispatch below remains the
  // broker's read/isolated op boundary).
  const permissionGuard = createPermissionGuard({
    sessionPath, leaseToken, exec, controlCwd, canonicalExecutionRoot: s.worktreePath,
  });

  // Per-request authority: re-verify session + lease + guards (and confirm the
  // worktree still matches) BEFORE dispatch. Authority is always re-derived from
  // the authoritative session record — never from caller supplied/env values.
  function verifyRequest(requiredCapability = null) {
    const v = verifySessionAuthority({ sessionPath, leaseToken, exec, controlCwd, requiredCapability });
    if (!v.ok) return { ok: false, reason: v.reason, guard: v.guard };
    if (v.session.worktreePath !== s.worktreePath) return { ok: false, reason: 'SESSION_BINDING_MISMATCH' };
    return { ok: true, session: v.session };
  }

  // Issue #145: mutation-ownership gate. The executor surface may mutate the
  // canonical attempt ONLY when this lane IS the single recorded mutation
  // owner. An UNBOUND attempt (no recorded owner — e.g. an unnamed legacy
  // admission) grants NO mutation authority to anyone: mutation requires an
  // identified lane bound by a named admission or explicit control-plane
  // adoption (rework F1: no anonymous mutation authority). Read-only/observer
  // tools never reach this check. Ownership moves only through the
  // control-plane transfer API — never here. Conflict evidence binds BOTH
  // lanes and the canonical artifact (repo/issue/branch/worktree) and never
  // carries a lease token (rework F2).
  function ownershipArtifact(session) {
    return {
      repo: session.repo ?? null,
      issueNumber: session.issueNumber ?? null,
      branch: session.branch ?? null,
      worktreePath: session.worktreePath ?? null,
    };
  }
  function verifyMutationOwnership(session) {
    const owner = session && session.mutationOwner;
    if (!owner || !owner.laneId) {
      return { ok: false, reason: 'MUTATION_OWNER_UNBOUND', artifact: ownershipArtifact(session), ownerLaneId: null, presentedLaneId: laneId ?? null, detail: 'No mutation owner is bound to this attempt; mutation authority requires a named admission or explicit control-plane adoption.' };
    }
    if (!laneId) return { ok: false, reason: 'MUTATION_OWNER_UNIDENTIFIED', owner: owner.laneId, ownerLaneId: owner.laneId, presentedLaneId: null, artifact: ownershipArtifact(session), detail: 'Mutation requires this lane to identify itself (SOC_LANE_ID).' };
    if (laneId !== owner.laneId) {
      return { ok: false, reason: 'MUTATION_OWNER_CONFLICT', owner: owner.laneId, ownerLaneId: owner.laneId, presented: laneId, presentedLaneId: laneId, artifact: ownershipArtifact(session), detail: 'Another mutation owner is recorded for this canonical attempt; ownership conflicts fail closed.' };
    }
    return { ok: true };
  }

  function dispatch(request) {
    const name = (request && request.params && request.params.name) || '';
    const args = (request && request.params && request.params.arguments) || {};
    if (!name) return { ok: false, reason: 'MISSING_TOOL_NAME' };

    if (name === 'soc_broker_status') {
      const v = verifyRequest();
      if (!v.ok) return v;
      return broker.executeBrokerRequest({
        schemaVersion: '1', operation: 'status', repo, issueNumber, baseSha, args: {},
      });
    }
    if (name === 'soc_broker_diff') {
      const v = verifyRequest();
      if (!v.ok) return v;
      return broker.executeBrokerRequest({
        schemaVersion: '1', operation: 'diff', repo, issueNumber, baseSha,
        args: { mode: args.diffMode },
      });
    }
    if (name === 'soc_broker_run_registered_test') {
      const v = verifyRequest();
      if (!v.ok) return v;
      return broker.executeBrokerRequest({
        schemaVersion: '1', operation: 'run_registered_test', repo, issueNumber, baseSha,
        args: { testId: args.testId },
      });
    }
    if (name === 'soc_broker_commit') {
      // Bounded commit requires the explicit 'commit' capability on the live
      // authoritative session (Issue #49) — re-verified per request — and the
      // single mutation-owner identity (Issue #145).
      const v = verifyRequest('commit');
      if (!v.ok) return v;
      const mo = verifyMutationOwnership(v.session);
      if (!mo.ok) return mo;
      const rg = reconcileExecutorForMutation(v.session, { requiredCapability: 'commit' });
      if (!rg.ok) return rg;
      return broker.executeBrokerRequest({
        schemaVersion: '1', operation: 'commit', repo, issueNumber, baseSha,
        args: { message: args.message, paths: args.paths },
      });
    }
    if (name === 'soc_task_progress') {
      // P1-0 (Issue #90): progress telemetry is bound to the canonical session
      // (identity re-derived) and to the reporting executor; fail-closed on
      // malformed/unbound/out-of-order updates; NEVER touches the FSM state.
      const v = verifyRequest();
      if (!v.ok) return v;
      return applyTaskProgressUpdate({ stateDir: s.controlPlane.stateDir, update: args });
    }
    if (name === 'soc_broker_finish_task') {
      // Issue #65 canonical terminal transition. The Telegram lifecycle
      // dispatch happens INSIDE the FSM operation — an executor cannot
      // suppress it and cannot send it out-of-band. Mutation-owner gate
      // applies (Issue #145): canonical FSM state is a mutation surface.
      const v = verifyRequest();
      if (!v.ok) return v;
      const mo = verifyMutationOwnership(v.session);
      if (!mo.ok) return mo;
      const rg = reconcileExecutorForMutation(v.session, { requiredCapability: null });
      if (!rg.ok) return rg;
      const fn = args.outcome === 'FAILED' ? () => taskFinish({ sessionPath, outcome: 'FAILED' })
        : () => taskFinish({ sessionPath, outcome: 'COMPLETED' });
      return fn();
    }
    if (name === 'soc_broker_block_task') {
      // Issue #65 canonical TASK_BLOCKED transition (notification inside).
      const v = verifyRequest();
      if (!v.ok) return v;
      const mo = verifyMutationOwnership(v.session);
      if (!mo.ok) return mo;
      const rg = reconcileExecutorForMutation(v.session, { requiredCapability: null });
      if (!rg.ok) return rg;
      return taskBlock({ sessionPath });
    }
    if (name === 'soc_broker_request_human_gate') {
      // Issue #65 canonical HUMAN_GATE_REQUIRED transition (ordering +
      // notification inside the FSM operation; req 6). The note is the FULL
      // human question/context — it is rendered verbatim into the
      // human-first Telegram message (rev-2 req E).
      const v = verifyRequest();
      if (!v.ok) return v;
      const mo = verifyMutationOwnership(v.session);
      if (!mo.ok) return mo;
      const rg = reconcileExecutorForMutation(v.session, { requiredCapability: null });
      if (!rg.ok) return rg;
      return taskRequestHumanGate({ sessionPath, note: typeof args.note === 'string' ? args.note : null });
    }
    if (name === 'soc_broker_recover_human_gate') {
      // Issue #65 rev-2: explicit bounded recovery for an undelivered
      // HUMAN_GATE_REQUIRED notification (rev-2 req D). Authority and every
      // dispatch knob are FSM-derived; the caller only triggers recovery.
      const v = verifyRequest();
      if (!v.ok) return v;
      const mo = verifyMutationOwnership(v.session);
      if (!mo.ok) return mo;
      const rg = reconcileExecutorForMutation(v.session, { requiredCapability: null });
      if (!rg.ok) return rg;
      return recoverHumanGate({ sessionPath });
    }
    return { ok: false, reason: 'UNAUTHORIZED_TOOL_EXPOSED', tool: name, detail: `Tool ${name} is not exposed by the sandbox.` };
  }

  const tools = [
    {
      name: 'soc_broker_status',
      description: 'Git status of the bound worktree (read-only).',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'soc_broker_diff',
      description: 'Git diff of the bound worktree (read-only; working_tree or staged).',
      inputSchema: {
        type: 'object',
        properties: { diffMode: { type: 'string', enum: ['working_tree', 'staged'] } },
        required: [],
      },
    },
    {
      name: 'soc_broker_run_registered_test',
      description: 'Execute a registered test in a disposable snapshot worktree.',
      inputSchema: {
        type: 'object',
        properties: { testId: { type: 'string' } },
        required: ['testId'],
      },
    },
    {
      name: 'soc_broker_commit',
      description: 'Bounded canonical commit on the bound task worktree (Issue #49): canonical one-line message + task-scoped relative paths only. No shell, no argv, no push/merge/amend.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'One line: [type]((scope)): subject with a canonical type.' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Task-scoped relative paths to commit.' },
        },
        required: ['message', 'paths'],
      },
    },
    {
      name: 'soc_broker_finish_task',
      description: 'Issue #65: canonical terminal transition (COMPLETED or FAILED). Persists FSM state, then deterministically dispatches the Telegram lifecycle notification inside the FSM operation.',
      inputSchema: {
        type: 'object',
        properties: { outcome: { type: 'string', enum: ['COMPLETED', 'FAILED'] } },
        required: [],
      },
    },
    {
      name: 'soc_broker_block_task',
      description: 'Issue #65: canonical TASK_BLOCKED transition. Persists FSM state, then deterministically dispatches the Telegram lifecycle notification inside the FSM operation.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'soc_broker_request_human_gate',
      description: 'Issue #65: canonical HUMAN_GATE_REQUIRED transition. Persists the gate checkpoint, attempts the Telegram dispatch, then records WAITING_FOR_INPUT only on an accepted delivery — a failed dispatch HOLDS the gate with truthful evidence (recoverable via soc_broker_recover_human_gate).',
      inputSchema: {
        type: 'object',
        properties: { note: { type: 'string', description: 'The FULL human question/context shown verbatim in the Telegram notification.' } },
        required: [],
      },
    },
    {
      name: 'soc_broker_recover_human_gate',
      description: 'Issue #65 rev-2: ONE explicit bounded recovery attempt for an undelivered HUMAN_GATE_REQUIRED notification. On API_ACCEPTED the canonical WAITING_FOR_INPUT transition completes; on failure the gate stays held with truthful evidence.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'soc_task_progress',
      // P1-0 (Issue #90): executor progress/Todo telemetry, subordinate to the
      // canonical FSM. It can never terminalize the task; lifecycle reporting
      // stays exclusively on soc_broker_finish_task. Executor-agnostic: bind
      // via executorId + executionEpoch (bump on restart/replacement).
      description: 'Report executor progress/Todo telemetry (subordinate to the canonical FSM; never terminalizes). Envelope: { repo, issueNumber, executorId, executionEpoch, currentStep, totalSteps, steps: [{ index, name, status: PENDING|IN_PROGRESS|BLOCKED|COMPLETED }], executorKind?, message? }. Deterministic rules: lower executionEpoch rejected; same epoch must be monotonic (currentStep non-decreasing, no step moves backward); higher epoch replaces the plan (crash/restart/executor replacement).',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/repo binding of the canonical task' },
          issueNumber: { type: 'integer', minimum: 1 },
          executorId: { type: 'string', description: 'stable id of THIS executor run, e.g. opencode@<session> or cline:<id>' },
          executorKind: { type: 'string', description: 'optional executor kind (opencode/cline/...); telemetry only' },
          executionEpoch: { type: 'integer', minimum: 1, description: 'bump on executor restart/replacement' },
          currentStep: { type: 'integer', minimum: 1 },
          totalSteps: { type: 'integer', minimum: 1, maximum: 100 },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer', minimum: 1 },
                name: { type: 'string' },
                status: { type: 'string', enum: ['PENDING', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED'] },
              },
              required: ['index', 'name', 'status'],
            },
          },
          message: { type: 'string', description: 'optional <=500 char progress message' },
        },
        required: ['repo', 'issueNumber', 'executorId', 'executionEpoch', 'currentStep', 'totalSteps', 'steps'],
      },
    },
  ];

  function handleRequest(request) {
    if (!request || typeof request !== 'object') return null;
    const { id, method } = request;

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: { name: 'soc-brain-broker', version: MCP_SERVER_VERSION },
          capabilities: { tools: {} },
        },
      };
    }
    if (method === 'notifications/initialized') return null;
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools } };
    if (method === 'tools/call') {
      const result = dispatch(request);
      const text = JSON.stringify(result, null, 2);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: !result.ok } };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }

  return {
    ok: true, tools, handleRequest, dispatch, worktreesRoot, repo, issueNumber, baseSha,
    controlCwd: cc.root, permissionGuard,
    // F1: identity the broker process registers as a live-executor liveness lease.
    identityHash: s.identityHash || identityHash({ repo, issueNumber }),
    stateDir: (s.controlPlane && s.controlPlane.stateDir) || null,
  };
}

// ---- Entry point (run directly) ----------------------------------------------
// Reads JSON-RPC messages from stdin, responds on stdout. Exits 0 on EOF.
//
// Issue #180: the executor-facing broker (this process) is the interactive
// executor's MCP stdio child (runtime-sandbox buildOpenCodeConfig wires OpenCode
// to `node mcp-server.mjs`). Its OS parent process IS the interactive executor.
// Bind the liveness lease to THAT PARENT identity and NEVER to this broker's own
// pid: the broker lifetime is not executor liveness, so binding self re-opens the
// #180 gap (broker transport exit -> broker pid GONE -> a still-live parent
// under-counted). Identity model (all three keep the PARENT as the candidate, or
// bind nothing — never broker-self):
//   parent pid known + immutable Win32 PROCESS_START_TIME readable ->
//     {pid:ppid, processStartTime, boundTo:'parent'}  (PROVEN; reader may count LIVE)
//   parent pid known + PROCESS_START_TIME not readable right now (transient probe
//     failure) -> {pid:ppid, processStartTime:null, boundTo:'parent_unproven'}:
//     the PARENT pid is still the candidate identity and processStartTime is left
//     NULL so the EXISTING lease/reader semantics classify it UNPROVEN ->
//     UNKNOWN/deny (BLOCKS idle/reap/hibernate). isProvenGone on broker death sees
//     a live parent + null start -> RETAIN; a transport/broker loss can never turn
//     that uncertainty into executor GONE. A later reconnect with a readable probe
//     UPGRADES the SAME identityHash slot to proven (no duplicate owner).
//   parent pid not recoverable at all (ppid<=0; does not occur for an MCP stdio
//     child) -> {pid:null, boundTo:'none'}: there is no executor process to assert
//     liveness on, so main() publishes NOTHING rather than falsely binding the
//     broker itself.
export function resolveExecutorHostIdentity({ ppid = process.ppid, readStartTime = readWin32ProcessStartTime } = {}) {
  if (!Number.isInteger(ppid) || ppid <= 0) return { pid: null, processStartTime: null, boundTo: 'none' };
  let r = null; try { r = readStartTime(ppid); } catch { r = null; }
  if (r && Number.isFinite(r.processStartTime)) return { pid: ppid, processStartTime: r.processStartTime, boundTo: 'parent' };
  return { pid: ppid, processStartTime: null, boundTo: 'parent_unproven' };
}

function main() {
  const server = createMcpServer();
  if (!server.ok) {
    process.stderr.write(`MCP startup failed: ${JSON.stringify(server.errors)}\n`);
    process.exit(1);
  }

  // F1 (Issue #172) + #180: register the BOUND EXECUTOR host process as a live-
  // executor liveness lease at the authoritative bind, so the Idle Supervisor
  // sees an interactive/agent executor even when no control-loop lifecycle
  // record exists. #180 closes the #172 residual gap: the lease binds the
  // executor OS process identity (parent PID; PROVEN only when the immutable
  // Win32 PROCESS_START_TIME is readable), NOT this broker's own pid and NOT the
  // stdio transport lifetime. The broker is the executor's MCP stdio child
  // (runtime-sandbox buildOpenCodeConfig), so its parent IS the interactive
  // executor process. When the parent PID is known but its PROCESS_START_TIME
  // cannot be read, we bind the parent with a NULL start (-> UNPROVEN/deny via the
  // existing reader) and NEVER fall back to broker-self: a transport EOF / SIGTERM
  // / SIGINT / broker exit must NOT retire a still-live/uncertain executor's
  // signal — retirement happens only when the bound executor identity is positively
  // proven gone (dead pid or foreign-recycled pid). If NO parent pid is
  // recoverable we publish NOTHING (there is no executor process to assert on)
  // rather than falsely binding this broker. Strictly activity authority: never
  // touches the task FSM, never a mutation owner, fully best-effort (a lease
  // failure must never break the broker).
  let liveness = null;
  if (server.stateDir && server.identityHash) {
    try {
      const host = resolveExecutorHostIdentity();
      if (host.pid == null) {
        process.stderr.write(`MCP liveness skipped: ${host.boundTo}\n`);
      } else {
        liveness = createExecutorLiveness({
          stateDir: server.stateDir, identityHash: server.identityHash,
          repo: server.repo, issueNumber: server.issueNumber,
          pid: host.pid, processStartTime: host.processStartTime,
        });
        const r = liveness.start();
        if (!r.ok) process.stderr.write(`MCP liveness publish: ${r.reason}\n`);
      }
    } catch (e) {
      process.stderr.write(`MCP liveness init skipped: ${String((e && e.message) || e)}\n`);
      liveness = null;
    }
  }
  let retired = false;
  // Issue #180: retire the lease ONLY after the bound executor identity is
  // positively proven gone. transport/broker disconnect is NOT executor death.
  // When not proven gone the lease is retained: the supervisor reader then
  // classifies it LIVE (host still alive) or UNKNOWN/deny (identity unprovable)
  // — never a false idle. `fast` (used from the synchronous 'exit' handler)
  // skips the Win32 probe so a live-but-unprobeable identity keeps the lease.
  //
  // This path is SILENT by design. A clean broker run must produce no stderr
  // (#172 invariant, asserted by the mcp-int lifecycle test). Transport-vs-death
  // is still available as STRUCTURED, non-authoritative data via the exported
  // provenExecutorIdentityGone()/isProvenGone() classification
  // (EXECUTOR_ALIVE | PID_GONE | PID_REUSED_FOREIGN | *_UNPROVEN) for any
  // consumer that needs it; it is intentionally NOT logged here (see #180 Phase
  // 4 limitation: MCP_DISCONNECTED stays declared-but-not-emitted to avoid
  // changing the stderr-silent lifecycle surface).
  const retireLiveness = (opts) => {
    if (!liveness || retired) return;
    const fast = opts && opts.fast === true;
    let p;
    try {
      p = liveness.isProvenGone(fast ? { deps: { readStartTime: () => null } } : {});
    } catch { p = { provenGone: false, reason: 'PROVEN_GONE_CHECK_THREW' }; }
    if (!p.provenGone) return; // transport loss only: retain the live/UNKNOWN lease
    retired = true;
    try { liveness.retire(); } catch { /* best effort; dead pid proves GONE for the reader */ }
  };

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const req = JSON.parse(t);
        const res = server.handleRequest(req);
        if (res) process.stdout.write(JSON.stringify(res) + '\n');
        if (liveness && req && req.method === 'tools/call') liveness.heartbeat(); // event-driven heartbeat
      } catch (e) {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: null,
          error: { code: -32700, message: 'Parse error', detail: String((e && e.message) || e) },
        }) + '\n');
      }
    }
  });
  process.stdin.on('end', () => { retireLiveness(); process.exit(0); });
  process.on('SIGTERM', () => { retireLiveness(); process.exit(0); });
  process.on('SIGINT', () => { retireLiveness(); process.exit(0); });
  process.on('exit', () => { retireLiveness({ fast: true }); });
}

// Run directly: node mcp-server.mjs (GPT-REV-138). process.argv[1] is a
// filesystem path, import.meta.url is a file:// URL — compare via
// fileURLToPath so a directly-launched server actually runs main().
const isDirect = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) main();

