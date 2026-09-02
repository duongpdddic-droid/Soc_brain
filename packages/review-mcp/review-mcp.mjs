#!/usr/bin/env node
// review-mcp.mjs — Soc_brain: dedicated read-only stdio MCP server for the
// ChatGPT reviewer (PoC, Issue #34). Connects to ChatGPT via OpenAI Secure MCP
// Tunnel (tunnel-client v0.0.14, tunnel "Soc_brain Review Tunnel").
//
// Scope (PoC, deliberate):
//   - Exposes EXACTLY ONE tool: `review.ping` -> {ok:true,service:"soc_brain",
//     mode:"review-readonly"}.
//   - READ-ONLY. No GitHub, no write, no command/broker/execution capability,
//     no filesystem access.
//   - Does NOT reuse the runtime-sandbox execution boundary: it imports nothing
//     from packages/runtime-sandbox, packages/execution-broker, packages/safe-git
//     or packages/temp-hygiene. It is a self-contained stdio JSON-RPC server.
//
// Transport: JSON-RPC 2.0 over stdio, newline-delimited (one JSON object per
// line). Reads from stdin, writes to stdout. NEVER listens on TCP. The protocol
// method set matches the repo's existing MCP stdio server (initialize,
// notifications/initialized, tools/list, tools/call) so it is downstream-compatible.
//
// Tool name note: `review.ping` contains a dot. The MCP protocol prose (2025-03-26
// "name: Unique identifier for the tool") does not forbid a dot. The stricter
// `^[a-zA-Z0-9_-]{1,64}$` regex is a TypeScript-SDK registration constraint, not a
// protocol requirement; because this server is a raw stdio JSON-RPC server (no SDK)
// and the tunnel client is a transport proxy, the dot name round-trips. The e2e test
// proves real stdio round-trip. ponytail: if a strict SDK client rejects the dot name,
// rename to `review-ping` (single place: TOOL_NAME) — no other code changes.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MCP_SERVER_VERSION = '0.1.0';
export const MCP_PROTOCOL_VERSION = '2025-03-26';
export const TOOL_NAME = 'review.ping';

export function createReviewMcp() {
  // Exactly one tool. No execution/write/GitHub capability is exposed.
  const tools = [
    {
      name: TOOL_NAME,
      description:
        'Read-only liveness probe for the Soc_brain ChatGPT review tunnel. Returns service identity.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
  ];

  function handleRequest(request) {
    if (!request || typeof request !== 'object') return null;
    const { id, method } = request;

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: { name: 'soc-brain-review', version: MCP_SERVER_VERSION },
          capabilities: { tools: {} },
        },
      };
    }
    if (method === 'notifications/initialized') return null;
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools } };
    }
    if (method === 'tools/call') {
      const name = (request.params && request.params.name) || '';
      if (name !== TOOL_NAME) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `Unknown tool: ${name}` },
        };
      }
      const result = { ok: true, service: 'soc_brain', mode: 'review-readonly' };
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          isError: false,
        },
      };
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }

  return { tools, handleRequest };
}

// ---- stdio entry point ------------------------------------------------------
// Reads JSON-RPC messages from stdin, responds on stdout. Exits 0 on EOF.
function main() {
  const server = createReviewMcp();
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let req;
      try {
        req = JSON.parse(t);
      } catch (e) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error', detail: String((e && e.message) || e) },
          }) + '\n',
        );
        continue;
      }
      const res = server.handleRequest(req);
      if (res) process.stdout.write(JSON.stringify(res) + '\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

// Run directly when launched as `node review-mcp.mjs` (GPT-REV-138-style check).
// process.argv[1] is a filesystem path; import.meta.url is a file:// URL.
const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) main();
