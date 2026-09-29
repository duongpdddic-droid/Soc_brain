#!/usr/bin/env node
// gateway-mcp.mjs — Soc_brain: TUI Gateway MCP Server (P0).
// Exposes a SINGLE tool "gateway" with operations: submit, status, recover.
// This is the ONLY tool the soc_control agent (TUI) is allowed to use.
// All operations delegate to the canonical client-control.mjs primitives.
// No lifecycle authority, no session ownership, no mutation capability.
//
// P0 REWORK — three hard rules on top of the delegation above:
//   1. PRODUCTION ROUTE PARITY: the EXISTING detached route seam
//      (`createDetachedRouteExecutor`, the same one client-mcp.mjs wires) is
//      attached ONLY when a trusted control lane is configured by the control
//      plane that launches this server (`SOC_CONTROL_LANE` from trusted config,
//      never from tool input). No lane => admitted-only, nothing is spawned.
//   2. EXECUTION HONESTY: execution is claimed ONLY from the canonical
//      ExecutionRecord of the admitted identity — never from the route's own
//      answer. See the vocabulary below for exactly what may be claimed.
//   3. NO UNPROVEN EXECUTING: EXECUTING additionally requires the record to be
//      past its bind/cleanup latch AND reconcileExecutorLiveness to prove
//      RUNNING with identityProven. Everything that cannot be proven (latched,
//      pid gone/reused, identity unproven, unreadable record, route invoked
//      without a record) is UNDETERMINED with its REAL reason and a
//      reconcileRequired flag — never EXECUTING, never ADMITTED_ONLY.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClientControl, readClientControlConfig, createDetachedRouteExecutor } from './client-control.mjs';
import { readExecutionRecord } from '../executor-launcher/executor-launcher.mjs';
import { reconcileExecutorLiveness } from '../executor-launcher/executor-reconcile.mjs';

export const GATEWAY_MCP_SERVER_VERSION = '1';
export const GATEWAY_MCP_PROTOCOL_VERSION = '2025-03-26';
export const GATEWAY_TOOL_NAME = 'gateway';

// Truthful vocabulary for `executionStatus` (on BOTH submit and status) — the
// ONLY execution claim the gateway will ever make:
//   ADMITTED_ONLY    — admission only: no route was configured/invoked and no
//                      canonical ExecutionRecord exists. Nothing was launched.
//   EXECUTING        — the ExecutionRecord is PAST its bind/cleanup latch and
//                      reconcileExecutorLiveness proves RUNNING + identityProven.
//   EXECUTION_ENDED  — the ExecutionRecord carries a terminalStatus: the
//                      execution finished; that status is reported verbatim.
//   UNDETERMINED     — "not determined / reconcile required": latched record,
//                      pid gone or reused, identity not provable, unreadable or
//                      invalid record, or the route was invoked with no record
//                      yet. Always carries `executionStatusReason` (the REAL
//                      reason) and `reconcileRequired: true`.
export const GATEWAY_EXECUTION_STATUS = Object.freeze([
  'ADMITTED_ONLY', 'EXECUTING', 'EXECUTION_ENDED', 'UNDETERMINED',
]);

const GATEWAY_TOOL = {
  name: GATEWAY_TOOL_NAME,
  description: 'Soc_brain TUI Gateway — single entry point for the soc_control agent. Operations: submit and status both return a top-level executionStatus = ADMITTED_ONLY | EXECUTING | EXECUTION_ENDED | UNDETERMINED (with executionStatusReason + reconcileRequired), claimed ONLY from the canonical ExecutionRecord — EXECUTING requires a latch-cleared record that reconcileExecutorLiveness proves RUNNING with identityProven, and anything unproven is UNDETERMINED, never EXECUTING or ADMITTED_ONLY; recover = transport reattach. No mutation, no lifecycle terminalization, no merge, no review and no advisor calls.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['submit', 'status', 'recover'], description: 'Gateway operation to perform' },
      // submit args
      goal: { type: 'string', description: 'Product goal/instruction (<=8192 bytes)' },
      targetRepo: { type: 'string', description: 'Owner/name or github remote URL (canonicalized)' },
      localCheckoutPath: { type: 'string', description: 'Absolute path to local canonical checkout (explicit; no CWD fallback)' },
      targetRef: { type: 'string', description: 'Existing or new remote branch to pin for this task' },
      expectedHead: { type: 'string', pattern: '^[0-9a-f]{40}$', description: 'Exact remote commit expected for targetRef (40-hex SHA)' },
      issueNumber: { type: 'integer', minimum: 1, description: 'REAL issue number of an existing task for THIS goal — never invent or stub one. Omit it for a goal-only submit (then clientRequestId is required); required together with repo for status/recover exact bind.' },
      clientRequestId: { type: 'string', description: 'Stable id (>=8 chars) for a goal-only submit: generate it ONCE per goal and REUSE the exact same value when retrying that goal, so retries reconcile to one canonical task instead of minting a second one.' },
      executorPreference: { type: 'string', enum: ['cline', 'opencode', 'auto'], description: 'Executor routing preference' },
      // status args
      repo: { type: 'string', description: 'Target repo (owner/name)' },
      // recover args
      // repo + issueNumber optional: if omitted, attaches to single active canonical task
    },
    required: ['operation'],
    additionalProperties: false,
  },
};

// ---- execution-honesty projection (read-only) --------------------------------
// Projects a truthful `executionStatus` from the canonical ExecutionRecord. It
// never writes lifecycle state, never trusts the route's own answer, and never
// guesses: if the record cannot PROVE a state, the answer is UNDETERMINED with
// the real reason plus reconcileRequired.

function routeRequestSeen(stateDir, identityHash) {
  // The detached route writes one request file per launch attempt under the
  // control-plane state dir. Its presence is the read-only evidence that a route
  // was invoked at some point (used when the submit answer was a replay, which
  // carries no `execution` key, and by the read-only status operation).
  if (!stateDir || !identityHash) return false;
  try {
    return fs.readdirSync(path.join(stateDir, 'client-mcp', 'routes'))
      .some((f) => f.startsWith(identityHash));
  } catch { return false; }
}

function recordFacts(record, live) {
  if (!record) return null;
  return {
    pid: record.pid ?? null,
    processStartTime: record.processStartTime ?? null,
    liveness: live && live.liveness != null ? live.liveness : null,
    identityProven: !!(live && live.identityProven === true),
    terminalStatus: record.terminalStatus ?? null,
    pendingExecutorBind: record.pendingExecutorBind === true,
    cleanupRequired: record.cleanupRequired === true,
  };
}

function undetermined(reason, detail, facts = null) {
  return {
    executionStatus: 'UNDETERMINED',
    executionStatusReason: reason,
    executionStatusDetail: detail ?? null,
    reconcileRequired: true,
    executionRecord: facts,
  };
}

function admittedOnly() {
  return {
    executionStatus: 'ADMITTED_ONLY',
    executionStatusReason: null,
    executionStatusDetail: 'admission only: no route was configured or invoked and no canonical ExecutionRecord exists.',
    reconcileRequired: false,
    executionRecord: null,
  };
}

function projectExecution({ stateDir, repo, issueNumber, identityHash = null, routeCalled = false }) {
  if (!stateDir) {
    return undetermined('EXECUTION_STATE_UNAVAILABLE', 'no control-plane state dir is configured, so execution truth cannot be read.');
  }

  let rec = null;
  try {
    rec = readExecutionRecord({ stateDir, repo, issueNumber });
  } catch (e) {
    rec = { ok: false, reason: 'RECORD_READ_FAILED', detail: String((e && e.message) || e) };
  }

  if (!rec || rec.ok !== true) {
    const reason = rec && rec.reason ? rec.reason : 'RECORD_READ_FAILED';
    const detail = rec && rec.detail != null ? rec.detail : null;
    if (reason === 'EXECUTION_NOT_FOUND') {
      // No record at all. Route never invoked => honest admitted-only. Route
      // invoked => we do NOT know the state: reconcile before claiming anything.
      if (!routeCalled) {
        return {
          ...admittedOnly(),
          executionStatusDetail: 'admission only: no route was configured or invoked and no canonical ExecutionRecord exists for this identity.',
        };
      }
      return undetermined(
        'NO_EXECUTION_RECORD',
        'the route was invoked but no canonical ExecutionRecord exists for this identity yet: reconcile before claiming any execution state.',
      );
    }
    return undetermined(reason, detail || 'the canonical ExecutionRecord could not be read.');
  }

  const record = rec.record;
  if (identityHash && record.identityHash && record.identityHash !== identityHash) {
    return undetermined('EXECUTION_RECORD_IDENTITY_MISMATCH', 'the canonical ExecutionRecord belongs to another identity; reconcile before trusting it.');
  }

  // Latch first: a pending bind / cleanup latch means the execution identity is
  // NOT yet proven, whatever the pid says.
  if (record.pendingExecutorBind === true || record.cleanupRequired === true) {
    const which = record.pendingExecutorBind === true && record.cleanupRequired === true
      ? 'PENDING_BIND_AND_CLEANUP'
      : (record.pendingExecutorBind === true ? 'PENDING_BIND' : 'CLEANUP_REQUIRED');
    return undetermined('EXECUTOR_RECONCILIATION_REQUIRED', `the ExecutionRecord is still latched (${which}); reconcile before claiming an execution state.`, recordFacts(record, null));
  }

  if (record.terminalStatus != null) {
    return {
      executionStatus: 'EXECUTION_ENDED',
      executionStatusReason: 'TERMINAL',
      executionStatusDetail: `the canonical ExecutionRecord is terminal with status ${record.terminalStatus}.`,
      reconcileRequired: false,
      executionRecord: recordFacts(record, { liveness: record.terminalStatus, identityProven: true }),
    };
  }

  const live = reconcileExecutorLiveness(record);
  if (live.liveness === 'RUNNING' && live.identityProven === true) {
    return {
      executionStatus: 'EXECUTING',
      executionStatusReason: live.reason || 'IDENTITY_MATCH',
      executionStatusDetail: 'the latch-cleared ExecutionRecord proves this pid RUNNING with a matching process start time.',
      reconcileRequired: false,
      executionRecord: recordFacts(record, live),
    };
  }

  return undetermined(
    live.reason || live.liveness || 'OWNERSHIP_UNKNOWN',
    `the ExecutionRecord does not prove a RUNNING executor (liveness=${live.liveness || 'unknown'}, identityProven=${live.identityProven === true}); reconcile before claiming an execution state.`,
    recordFacts(record, live),
  );
}

// Submit projection: admission answer + execution truth. An unverified route
// claim is never forwarded as a success — it is rewritten to the projected
// status so `execution.status` and `executionStatus` can never disagree.
function withExecutionTruth(result, control) {
  if (!result || result.ok !== true) return result;
  const stateDir = control && control.config ? control.config.stateDir : null;
  const routeCalled = Object.prototype.hasOwnProperty.call(result, 'execution')
    || routeRequestSeen(stateDir, result.identityHash);
  const truth = projectExecution({
    stateDir,
    repo: result.repo,
    issueNumber: result.issueNumber,
    identityHash: result.identityHash ?? null,
    routeCalled,
  });
  let execution = Object.prototype.hasOwnProperty.call(result, 'execution') ? (result.execution ?? null) : null;
  const proven = truth.executionStatus === 'EXECUTING' || truth.executionStatus === 'EXECUTION_ENDED';
  if (!proven && execution && execution.ok === true) {
    execution = {
      ok: false,
      status: truth.executionStatus,
      reason: truth.executionStatusReason,
      detail: truth.executionStatusDetail ?? null,
    };
  }
  return { ...result, ...truth, execution };
}

function toolResult(id, payload) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: !payload || payload.ok === false } };
}

// Production wiring, identical rule to packages/client-mcp/client-mcp.mjs
// #defaultControl: the EXISTING detached route executor is attached ONLY when a
// trusted control lane exists (SOC_CONTROL_LANE handed by the control plane at
// launch). Without a lane the gateway stays admitted-only: no spawn, no route
// request, no executor. The lane value itself never comes from tool input.
export function defaultGatewayControl(env = process.env) {
  const cfg = readClientControlConfig(env);
  return createClientControl(cfg.controlLane ? { ...cfg, routeExecutor: createDetachedRouteExecutor() } : cfg);
}

export function createGatewayMcpServer({ control = null, env = process.env } = {}) {
  const cfg = control || defaultGatewayControl(env);
  return {
    ok: true,
    tools: [GATEWAY_TOOL],
    capabilities: ['gateway'],
    handleRequest: (request) => {
      if (!request || typeof request !== 'object') return null;
      const { id, method } = request;
      if (method === 'initialize') {
        return { jsonrpc: '2.0', id, result: { protocolVersion: GATEWAY_MCP_PROTOCOL_VERSION, serverInfo: { name: 'soc-brain-gateway', version: GATEWAY_MCP_SERVER_VERSION }, capabilities: { tools: {} } } };
      }
      if (method === 'notifications/initialized') return null;
      if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: [GATEWAY_TOOL] } };
      if (method === 'tools/call') {
        const name = (request.params && request.params.name) || '';
        const args = (request.params && request.params.arguments) || {};
        if (name !== GATEWAY_TOOL_NAME) {
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } };
        }
        const { operation, ...opArgs } = args;
        let result;
        switch (operation) {
          case 'submit':
            // Admission answer goes through the execution-honesty projection:
            // EXECUTING only from a latch-cleared record proven RUNNING with
            // identityProven; terminal => EXECUTION_ENDED; anything unprovable
            // => UNDETERMINED with its real reason (never a fabricated claim).
            result = withExecutionTruth(cfg.submitGoal(opArgs), cfg);
            break;
          case 'status': {
            // status combines getTask + getProgress for a unified view, plus the
            // SAME execution-honesty projection as submit, so an agent reads one
            // consistent top-level executionStatus (+ reason/reconcile/record)
            // instead of having to infer it from progress.execution.
            const taskRes = cfg.getTask({ repo: opArgs.repo, issueNumber: opArgs.issueNumber });
            if (!taskRes.ok) { result = taskRes; break; }
            const progRes = cfg.getProgress({ repo: opArgs.repo, issueNumber: opArgs.issueNumber });
            const truth = projectExecution({
              stateDir: cfg.config.stateDir,
              repo: opArgs.repo,
              issueNumber: opArgs.issueNumber,
              identityHash: progRes.ok ? (progRes.identityHash ?? null) : null,
              routeCalled: routeRequestSeen(cfg.config.stateDir, progRes.ok ? progRes.identityHash : null),
            });
            result = { ok: true, task: taskRes.task, progress: progRes.ok ? progRes : null, ...truth };
            break;
          }
          case 'recover':
            result = cfg.recover({ repo: opArgs.repo, issueNumber: opArgs.issueNumber });
            break;
          default:
            result = { ok: false, reason: 'GATEWAY_OPERATION_UNKNOWN', operation };
        }
        return toolResult(id, result);
      }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    },
    control: cfg,
  };
}

function main() {
  const server = createGatewayMcpServer();
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
      } catch (e) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error', detail: String((e && e.message) || e) } }) + '\n');
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) main();