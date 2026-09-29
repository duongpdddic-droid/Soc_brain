#!/usr/bin/env node
// gateway-mcp.mjs — Soc_brain: TUI Gateway MCP Server (P0).
// Exposes a SINGLE tool "gateway" with operations: submit, status, recover.
// This is the ONLY tool the soc_control agent (TUI) is allowed to use.
// All operations delegate to the canonical client-control.mjs primitives.
// No lifecycle authority, no session ownership, no mutation capability.
//
// P0 REWORK — two hard rules added on top of the delegation above:
//   1. PRODUCTION ROUTE PARITY: the EXISTING detached route seam
//      (`createDetachedRouteExecutor`, the same one client-mcp.mjs wires) is
//      attached ONLY when a trusted control lane is configured by the control
//      plane that launches this server (`SOC_CONTROL_LANE` from trusted config,
//      never from tool input). No lane => admitted-only, nothing is spawned.
//   2. EXECUTION HONESTY: a submit answer may claim execution ONLY when the
//      canonical ExecutionRecord for the admitted identity exists (and binds a
//      pid). Without that record the answer is downgraded to ADMITTED_ONLY /
//      NO_EXECUTION_RECORD — admission is never reported as execution.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClientControl, readClientControlConfig, createDetachedRouteExecutor } from './client-control.mjs';
import { readExecutionRecord } from '../executor-launcher/executor-launcher.mjs';
import { reconcileExecutorLiveness } from '../executor-launcher/executor-reconcile.mjs';

export const GATEWAY_MCP_SERVER_VERSION = '1';
export const GATEWAY_MCP_PROTOCOL_VERSION = '2025-03-26';
export const GATEWAY_TOOL_NAME = 'gateway';

// Truthful vocabulary for `submit.executionStatus` (the ONLY execution claim the
// gateway will ever make):
//   ADMITTED_ONLY      — canonical admission succeeded, NO ExecutionRecord exists
//                        (no executor, or the route produced none). Not running.
//   EXECUTING          — an ExecutionRecord exists, binds a live pid and is not
//                        finalized: a real executor process was launched.
//   EXECUTION_RECORDED — an ExecutionRecord exists but is finalized/terminal: the
//                        execution happened and has already ended.
export const GATEWAY_EXECUTION_STATUS = Object.freeze(['ADMITTED_ONLY', 'EXECUTING', 'EXECUTION_RECORDED']);

const GATEWAY_TOOL = {
  name: GATEWAY_TOOL_NAME,
  description: 'Soc_brain TUI Gateway — single entry point for the soc_control agent. Operations: submit (canonical admission; the answer carries executionStatus = ADMITTED_ONLY | EXECUTING | EXECUTION_RECORDED and execution is claimed ONLY when a canonical ExecutionRecord exists), status (task/progress/liveness, including the executor pid), recover (transport reattach). No mutation, no lifecycle terminalization, no merge, no review and no advisor calls.',
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

// P0 execution-honesty gate: project a truthful `executionStatus` (+ the
// canonical ExecutionRecord facts) onto an accepted submit answer, and
// DOWNGRADE any route claim that has no ExecutionRecord behind it. Read-only:
// it inspects the canonical record, it never writes lifecycle state.
function withExecutionTruth(result, control) {
  if (!result || result.ok !== true) return result;
  const stateDir = control && control.config ? control.config.stateDir : null;
  let record = null;
  try {
    const rec = stateDir ? readExecutionRecord({ stateDir, repo: result.repo, issueNumber: result.issueNumber }) : null;
    if (rec && rec.ok && rec.record && rec.record.identityHash === result.identityHash) record = rec.record;
  } catch { record = null; }
  const bound = record && record.pid != null;

  if (!bound) {
    const claimed = !!(result.execution && result.execution.ok === true);
    return {
      ...result,
      executionStatus: 'ADMITTED_ONLY',
      execution: claimed
        ? {
            ok: false,
            status: 'ADMITTED_ONLY',
            reason: 'NO_EXECUTION_RECORD',
            detail: 'the configured route produced no canonical ExecutionRecord for this identity: admission stands, execution is NOT claimed.',
          }
        : (result.execution ?? null),
    };
  }

  const live = reconcileExecutorLiveness(record);
  const terminal = record.terminalStatus != null || record.finalized === true;
  return {
    ...result,
    executionStatus: terminal ? 'EXECUTION_RECORDED' : 'EXECUTING',
    executionRecord: {
      pid: record.pid ?? null,
      processStartTime: record.processStartTime ?? null,
      liveness: live.liveness ?? null,
      identityProven: live.identityProven ?? false,
      terminalStatus: record.terminalStatus ?? null,
    },
    // The route's own answer is kept verbatim only because the record above
    // corroborates it; when the route said nothing, the record is the evidence.
    execution: result.execution ?? null,
  };
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
            // Admission answer is projected through the execution-honesty gate:
            // execution is only claimed when the canonical ExecutionRecord exists.
            result = withExecutionTruth(cfg.submitGoal(opArgs), cfg);
            break;
          case 'status':
            // status combines getTask + getProgress for a unified view
            const taskRes = cfg.getTask({ repo: opArgs.repo, issueNumber: opArgs.issueNumber });
            if (!taskRes.ok) { result = taskRes; break; }
            const progRes = cfg.getProgress({ repo: opArgs.repo, issueNumber: opArgs.issueNumber });
            result = { ok: true, task: taskRes.task, progress: progRes.ok ? progRes : null };
            break;
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