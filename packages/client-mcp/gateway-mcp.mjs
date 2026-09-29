#!/usr/bin/env node
// gateway-mcp.mjs — Soc_brain: TUI Gateway MCP Server (P0).
// Exposes a SINGLE tool "gateway" with operations: submit, status, recover.
// This is the ONLY tool the soc_control agent (TUI) is allowed to use.
// All operations delegate to the canonical client-control.mjs primitives.
// No lifecycle authority, no session ownership, no mutation capability.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClientControl, readClientControlConfig } from './client-control.mjs';

export const GATEWAY_MCP_SERVER_VERSION = '1';
export const GATEWAY_MCP_PROTOCOL_VERSION = '2025-03-26';
export const GATEWAY_TOOL_NAME = 'gateway';

const GATEWAY_TOOL = {
  name: GATEWAY_TOOL_NAME,
  description: 'Soc_brain TUI Gateway — single entry point for the soc_control agent. Operations: submit (canonical admission), status (task/progress/liveness), recover (transport reattach). No mutation, no lifecycle terminalization, no merge.',
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
      issueNumber: { type: 'integer', minimum: 1, description: 'Optional explicit task number. Omit to allocate local task number (requires clientRequestId)' },
      clientRequestId: { type: 'string', description: 'Stable id for replay-safe goal-only submits (>=8 chars)' },
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

function toolResult(id, payload) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: !payload || payload.ok === false } };
}

export function createGatewayMcpServer({ control = null } = {}) {
  const cfg = control || createClientControl(readClientControlConfig(process.env));
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
            result = cfg.submitGoal(opArgs);
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