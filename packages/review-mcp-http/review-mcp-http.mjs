#!/usr/bin/env node
// review-mcp-http.mjs — Soc_brain: read-only localhost Review MCP for the
// ChatGPT Web reviewer transport via MCP-SuperAssistant (PoC, Issue #39).
//
// Transport: network mode exposes the MCP Streamable HTTP transport on a
// loopback-only server (POST /mcp). The stdio mode is the JSON-RPC 2.0 server
// reused verbatim from the Issue #34 PoC shape (so a stdio-bridging local
// proxy can spawn it). BOTH expose EXACTLY ONE tool:
//   `review.ping` -> {ok:true, service:"soc_brain", mode:"review-readonly"}.
//
// Scope (deliberate, PoC):
//   - READ-ONLY. No GitHub, no write, no command/broker/execution capability,
//     no filesystem, no task/issue mutation. One tool only.
//   - Loopback ONLY. The HTTP path refuses any host that is not a loopback
//     address (fail-closed); it never binds 0.0.0.0 / a LAN interface.
//   - stdio mode never listens on TCP; reads stdin, writes stdout, exits 0.
//   - Does NOT reuse the runtime-sandbox execution boundary; imports nothing
//     beyond node:http / node:crypto / node:path / node:url.
//
// Modes (run directly):
//   node review-mcp-http.mjs           -> stdio JSON-RPC server (Issue #34 shape)
//   node review-mcp-http.mjs --http    -> loopback HTTP server (Streamable HTTP)
//     host: env REVIEW_MCP_HOST, default 127.0.0.1 (must be loopback; else fail)
//     port: env REVIEW_MCP_PORT, default 8100
//
// CORS: the loopback server answers the extension's browser fetch (OPTIONS
// preflight + permissive Access-Control-Allow-*). This is transport plumbing,
// not an authority expansion: the only exposed capability is review.ping.
//
// Tool name note (inherited from #34): `review.ping` contains a dot. MCP prose
// (2025-03-26) does not forbid it, but the stricter TS-SDK regex
// ^[a-zA-Z0-9_-]{1,64}$ does. If MCP-SuperAssistant rejects the dot name,
// rename TOOL_NAME to `review-ping` (single place) — no other changes.
// ponytail: the transport is intentionally dependency-free hand-rolled MCP;
// upgrade to @modelcontextprotocol/sdk only if a client requires a strict SDK
// negotiation feature (e.g. resource subscription), which is out of scope.

import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MCP_SERVER_VERSION = '0.1.0';
export const MCP_PROTOCOL_VERSION = '2025-03-26';
export const TOOL_NAME = 'review.ping';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8100;

// ---- loopback-only host check (fail-closed) --------------------------------
export function isLoopbackHost(host) {
  if (typeof host !== 'string') return false;
  if (host === 'localhost') return true;
  if (host === '::1') return true;
  // 127.0.0.0/8 — but each octet must be a valid 0..255 value.
  // The previous regex `/^127(?:\.\d{1,3}){3}$/` accepted malformed inputs like
  // "127.999.999.999" (octet > 255) as trusted loopback; reject them.
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  for (let i = 1; i <= 3; i++) {
    const n = Number(m[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
  }
  return true;
}

// ---- shared MCP handler (Issue #34 shape, reused verbatim) -----------------
export function createReviewMcp() {
  // Exactly one tool. No execution/write/GitHub capability is exposed.
  const tools = [
    {
      name: TOOL_NAME,
      description:
        'Read-only liveness probe for the Soc_brain ChatGPT review MCP. Returns service identity.',
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

// ---- loopback HTTP server (MCP Streamable HTTP transport) ------------------
// Streamable HTTP (2025-03-26): one MCP endpoint that supports BOTH POST
// (client->server JSON-RPC) and GET (server->client SSE stream). Servers MUST
// validate the Origin header on every connection (DNS-rebinding guard) and must
// expose browser-compatible CORS so a Chrome extension / web page can reach it.

// Origins we are willing to serve. No-Origin is a non-browser client (curl/node).
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const ALLOWED_WEB_HOSTS = [
  'chatgpt.com',
  'chat.openai.com',
  'gemini.google.com',
  'aistudio.google.com',
  'perplexity.ai',
  'grok.com',
  'openrouter.ai',
  'deepseek.com',
];

export function isAllowedOrigin(origin) {
  if (typeof origin !== 'string' || origin === '') return true; // non-browser client
  if (LOOPBACK_ORIGIN_RE.test(origin)) return true; // the server's own origin
  if (origin.startsWith('chrome-extension://')) return true; // MCP-SuperAssistant
  let host;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ALLOWED_WEB_HOSTS.some((w) => host === w || host.endsWith('.' + w));
}

// Browser-compatible CORS. Reflects the request Origin (validated above) instead
// of hard-coding `*`, so credentialed requests work; reflects the exact headers
// the preflight asks for so any extension header list is accepted.
export function corsHeaders(req) {
  const origin = req.headers.origin;
  const allowOrigin = origin && isAllowedOrigin(origin) ? origin : '*';
  const requested = req.headers['access-control-request-headers'];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    ...(origin ? { Vary: 'Origin' } : {}),
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      requested || 'content-type, mcp-session-id, accept, authorization, last-event-id, x-request-id',
    'Access-Control-Max-Age': '3600',
    ...(origin ? { 'Access-Control-Allow-Credentials': 'true' } : {}),
  };
}

function httpJson(req, res, status, obj, extra) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders(req), ...(extra || {}) });
  res.end(JSON.stringify(obj));
}

function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      chunks.push(c);
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleMcpRequest(req, res, server) {
  const accept = String(req.headers.accept || '');
  const clientSession = req.headers['mcp-session-id'];

  const body = await readBody(req).catch(() => null);
  let parsed;
  try {
    parsed = body && body.trim() ? JSON.parse(body) : null;
  } catch (e) {
    return httpJson(req, res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error', detail: String((e && e.message) || e) },
    });
  }
  if (parsed == null || typeof parsed !== 'object') {
    return httpJson(req, res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const responses = [];
  let seenInitialize = false;
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.method === 'initialize') seenInitialize = true;
    const r = server.handleRequest(msg);
    if (r) responses.push(r);
  }

  // Only notifications (no id) -> 202 Accepted, no body.
  if (responses.length === 0) {
    res.writeHead(202, { 'Content-Type': 'text/plain', ...corsHeaders(req) });
    res.end('');
    return;
  }

  const bodyText = JSON.stringify(responses.length === 1 ? responses[0] : responses);
  const session = clientSession || crypto.randomUUID();
  const wantsJson = accept.includes('application/json') || !accept.includes('text/event-stream');

  if (wantsJson) {
    const extra = seenInitialize ? { 'Mcp-Session-Id': session } : {};
    httpJson(req, res, 200, JSON.parse(bodyText), extra);
    return;
  }

  // SSE — single event then close.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'close',
    ...corsHeaders(req),
    ...(seenInitialize ? { 'Mcp-Session-Id': session } : {}),
  });
  res.write(`data: ${bodyText}\n\n`);
  res.end();
}

export function startHttpServer({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  if (!isLoopbackHost(host)) {
    throw new Error(
      `REVIEW_MCP_HOST ${JSON.stringify(host)} is not a loopback address; refusing to bind (loopback-only PoC, Issue #39).`,
    );
  }
  const server = createReviewMcp();
  const isMcpPath = (u) => u.pathname === '/mcp';

  const httpServer = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${host}`);

    // Streamable HTTP MUST validate the Origin header on every incoming
    // connection to prevent DNS-rebinding. Disallowed -> 403 with no
    // Access-Control-Allow-Origin so a browser treats the request as CORS-failed
    // (fail-closed, no data leaks to a foreign page).
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Origin not allowed', detail: origin } }));
      return;
    }

    if (req.method === 'OPTIONS' && isMcpPath(u)) {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }

    if (req.method === 'POST' && isMcpPath(u)) {
      handleMcpRequest(req, res, server).catch((e) => {
        if (!res.headersSent) {
          httpJson(req, res, 500, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: 'Internal error', detail: String((e && e.message) || e) },
          });
        } else {
          res.end();
        }
      });
      return;
    }

    // Streamable HTTP GET: server->client SSE stream, kept open for the session.
    if (req.method === 'GET' && isMcpPath(u)) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...corsHeaders(req),
      });
      res.write(': connected\n\n');
      let alive = true;
      const keepAlive = setInterval(() => {
        if (!alive) return clearInterval(keepAlive);
        try {
          res.write(': keep-alive\n\n');
        } catch {
          alive = false;
          clearInterval(keepAlive);
        }
      }, 15_000);
      const stop = () => {
        alive = false;
        clearInterval(keepAlive);
      };
      req.on('close', stop);
      res.on('close', stop);
      return;
    }

    httpJson(req, res, 405, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32601, message: `Not allowed: ${req.method} ${u.pathname}` },
    }, { Allow: 'POST /mcp, GET /mcp, OPTIONS /mcp' });
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      const addr = httpServer.address();
      resolve({
        host: addr.address,
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}/mcp`,
        server: httpServer,
        close: () => new Promise((r) => httpServer.close(() => r())),
      });
    });
  });
}


// ---- stdio entry point (Issue #34 shape) -----------------------------------
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

async function httpMain() {
  try {
    const host = process.env.REVIEW_MCP_HOST || DEFAULT_HOST;
    const port = Number(process.env.REVIEW_MCP_PORT || DEFAULT_PORT);
    const s = await startHttpServer({ host, port });
    process.stderr.write(`soc-brain review MCP (HTTP) listening on ${s.url}\n`);
  } catch (e) {
    process.stderr.write(`soc-brain review MCP HTTP startup failed: ${(e && e.message) || e}\n`);
    process.exit(1);
  }
}

// Run directly: node review-mcp-http.mjs [--http] (GPT-REV-138-style check).
const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) {
  if (process.argv.includes('--http')) httpMain();
  else main();
}

