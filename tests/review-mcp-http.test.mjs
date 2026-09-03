#!/usr/bin/env node
// review-mcp-http.test.mjs — Soc_brain PoC Review MCP HTTP (Issue #39).
// Proves: exactly one read-only tool `review.ping`; no write/exec/GitHub surface;
// deterministic review.ping payload; loopback-only HTTP binding (fail-closed on
// non-loopback); Streamable HTTP round-trip (initialize -> tools/list ->
// tools/call), SSE + notification 202 handling; and a real stdio negotiation.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';
import {
  createReviewMcp,
  startHttpServer,
  isLoopbackHost,
  isAllowedOrigin,
  corsHeaders,
  TOOL_NAME,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_VERSION,
} from '../packages/review-mcp-http/review-mcp-http.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.resolve(HERE, '..', 'packages', 'review-mcp-http', 'review-mcp-http.mjs');

// ---- Unit tests (in-process) -----------------------------------------------
test('unit: exposes exactly four tools — three read-only + review.submit_decision (Phase 3, Issue #43)', () => {
  const { tools } = createReviewMcp();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['review.get_evidence', 'review.get_request', 'review.ping', 'review.submit_decision']);
  // review.ping: no args.
  const ping = tools.find((t) => t.name === TOOL_NAME);
  assert.equal(ping.name, 'review.ping');
  assert.deepEqual(ping.inputSchema, { type: 'object', properties: {}, required: [] });
  // get_request + get_evidence: identity-only, additionalProperties:false.
  for (const tn of ['review.get_request', 'review.get_evidence']) {
    const t = tools.find((x) => x.name === tn);
    assert.equal(t.inputSchema.additionalProperties, false);
    assert.deepEqual(t.inputSchema.required, ['repository', 'issue', 'headSha']);
  }
});

test('unit: no write/exec/GitHub surface in the exposed capability (Phase 1/2 read-only invariant + submit_decision boundary)', () => {
  const { tools } = createReviewMcp();
  const names = tools.map((t) => t.name);
  assert.ok(names.every((n) => /^[a-z0-9_.-]+$/.test(n)), 'names are simple identifiers');
  // Read-only tools (review.ping, review.get_request, review.get_evidence) must not surface privileged
  // capability (write/exec/git/etc). review.submit_decision is the Phase 3 BOUNDARY (canonical
  // write within the pre-gated review-ready dir); its name/description legitimately mention the
  // controlled write semantics, so it is exempt from this regex and covered by its own test
  // (review-mcp-http.phase3.test.mjs: write path + symlink guard + idempotency + fail-closed codes).
  const READ_ONLY = new Set(['review.ping', 'review.get_request', 'review.get_evidence']);
  for (const t of tools) {
    if (READ_ONLY.has(t.name)) {
      assert.equal(
        /(exec|write|git|github|broker|runtime|command|delete|push|run|spawn|fs|shell)|\.exec\b|\.write\b/i.test(
          t.name + ' ' + (t.description || ''),
        ),
        false,
        `tool surfaces no privileged capability: ${t.name}`,
      );
    }
    // Identity-only: get_request + get_evidence accept đúng 3 field, additionalProperties:false.
    // review.ping (và mọi tool tương lai) chỉ được no-arg → inputSchema.properties:{}.
    if (t.name === 'review.ping') {
      assert.deepEqual(Object.keys(t.inputSchema.properties || {}), []);
    } else if (READ_ONLY.has(t.name)) {
      assert.equal(t.inputSchema.additionalProperties, false);
      assert.deepEqual(t.inputSchema.required.sort(), ['headSha', 'issue', 'repository']);
    }
  }
});

test('unit: initialize advertises tools capability', () => {
  const { handleRequest } = createReviewMcp();
  const res = handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(res.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(res.result.serverInfo.name, 'soc-brain-review');
  assert.equal(res.result.serverInfo.version, MCP_SERVER_VERSION);
  assert.deepEqual(res.result.capabilities, { tools: {} });
});

test('unit: tools/call review.ping returns the read-only payload', () => {
  const { handleRequest } = createReviewMcp();
  const res = handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: TOOL_NAME, arguments: {} },
  });
  assert.equal(res.result.isError, false);
  assert.equal(res.result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(res.result.content[0].text), {
    ok: true,
    service: 'soc_brain',
    mode: 'review-readonly',
  });
});

test('unit: unknown tool -> -32602; unknown method -> -32601', () => {
  const { handleRequest } = createReviewMcp();
  const badTool = handleRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'review.exec', arguments: {} },
  });
  assert.equal(badTool.error.code, -32602);
  const badMethod = handleRequest({ jsonrpc: '2.0', id: 4, method: 'tools/nonexistent' });
  assert.equal(badMethod.error.code, -32601);
});

// ---- loopback-only host policy ---------------------------------------------
test('http: loopback host detection', () => {
  // Valid 127.0.0.0/8 (each octet 0..255).
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.0.0.2'), true);
  assert.equal(isLoopbackHost('127.1.2.3'), true);
  assert.equal(isLoopbackHost('127.255.255.255'), true);
  // Exact boundaries.
  assert.equal(isLoopbackHost('127.0.0.0'), true);
  assert.equal(isLoopbackHost('127.255.255.255'), true);
  // Special-cased loopback names.
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  // Non-loopback.
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('192.168.1.1'), false);
  // Malformed octets: any value > 255 (including those that the previous regex
  // \d{1,3} would have accepted) MUST be rejected.
  assert.equal(isLoopbackHost('127.256.1.1'), false);
  assert.equal(isLoopbackHost('127.999.999.999'), false);
  assert.equal(isLoopbackHost('127.0.0.256'), false);
  // Negative / signed / leading-zero edge cases.
  assert.equal(isLoopbackHost('127.0.0.-1'), false);
  // Trailing / extra components.
  assert.equal(isLoopbackHost('127.0.0.1.5'), false);
  assert.equal(isLoopbackHost('127.0.0'), false);
  assert.equal(isLoopbackHost('127.0.0.1 '), false);
  assert.equal(isLoopbackHost(' 127.0.0.1'), false);
  // Garbage / non-string.
  assert.equal(isLoopbackHost(''), false);
  assert.equal(isLoopbackHost('not-an-ip'), false);
  assert.equal(isLoopbackHost(undefined), false);
  assert.equal(isLoopbackHost(null), false);
  assert.equal(isLoopbackHost(127), false);
});

test('http: refuses non-loopback host (fail-closed)', () => {
  assert.throws(() => startHttpServer({ host: '0.0.0.0' }), /loopback/);
  assert.throws(() => startHttpServer({ host: '192.168.1.10' }), /loopback/);
  assert.throws(() => startHttpServer({ host: '' }), /loopback/);
});

// ---- origin policy (DNS-rebinding guard per Streamable HTTP) ---------------
test('unit: isAllowedOrigin permits loopback/no-origin, rejects arbitrary web origins', () => {
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin(''), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:8100'), true);
  assert.equal(isAllowedOrigin('http://localhost:8100'), true);
  assert.equal(isAllowedOrigin('http://[::1]:8100'), true);
  assert.equal(isAllowedOrigin('chrome-extension://abcdef1234'), true);
  assert.equal(isAllowedOrigin('https://chatgpt.com'), true);
  assert.equal(isAllowedOrigin('https://aistudio.google.com'), true);
  assert.equal(isAllowedOrigin('https://evil.example.test'), false);
  assert.equal(isAllowedOrigin('https://chatgpt.com.evil.test'), false);
});

test('unit: corsHeaders reflects allowed origin + requested headers; no-origin -> wildcard', () => {
  const h = corsHeaders({ headers: { origin: 'https://chatgpt.com', 'access-control-request-headers': 'content-type, mcp-session-id' } });
  assert.equal(h['Access-Control-Allow-Origin'], 'https://chatgpt.com');
  assert.equal(h['Access-Control-Allow-Headers'], 'content-type, mcp-session-id');
  assert.equal(h.Vary, 'Origin');
  assert.equal(h['Access-Control-Allow-Credentials'], 'true');
  const noOrigin = corsHeaders({ headers: {} });
  assert.equal(noOrigin['Access-Control-Allow-Origin'], '*');
  assert.equal(noOrigin['Access-Control-Allow-Credentials'], undefined);
});

// ---- HTTP e2e (real loopback server) ---------------------------------------
function postJson(url, body, headers) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(headers || {}) },
    body: JSON.stringify(body),
  });
}

// raw http.request helper — node's global fetch treats `Origin` and
// `Access-Control-Request-*` as forbidden headers and will not send them, so we
// use node:http to exercise the browser preflight and Origin-validation paths.
function rawRequest(url, method, headersObj, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: headersObj },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('http: initialize + tools/list + tools/call round-trip over loopback', async () => {
  const s = await startHttpServer({ host: '127.0.0.1', port: 0 });
  try {
    assert.ok(s.host === '127.0.0.1' || s.host === '::1' || /^127\./.test(s.host), 'bound host is loopback');

    const init = await postJson(s.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(init.status, 200);
    assert.match(init.headers.get('content-type'), /application\/json/);
    const sessionId = init.headers.get('mcp-session-id');
    assert.ok(sessionId, 'initialize returns Mcp-Session-Id');
    const initBody = await init.json();
    assert.equal(initBody.result.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.equal(initBody.result.serverInfo.name, 'soc-brain-review');
    assert.deepEqual(initBody.result.capabilities, { tools: {} });

    const list = await postJson(s.url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'mcp-session-id': sessionId });
    assert.equal((await list.json()).result.tools.length, 4);

    const call = await postJson(s.url, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: TOOL_NAME, arguments: {} },
    }, { 'mcp-session-id': sessionId });
    const callBody = await call.json();
    assert.equal(callBody.result.isError, false);
    assert.deepEqual(JSON.parse(callBody.result.content[0].text), {
      ok: true,
      service: 'soc_brain',
      mode: 'review-readonly',
    });

    const bad = await postJson(s.url, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'review.exec', arguments: {} },
    }, { 'mcp-session-id': sessionId });
    assert.equal((await bad.json()).error.code, -32602);
  } finally {
    await s.close();
  }
});

test('http: notification returns 202 with no body', async () => {
  const s = await startHttpServer({ host: '127.0.0.1', port: 0 });
  try {
    const res = await postJson(s.url, { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(res.status, 202);
    assert.equal(await res.text(), '');
  } finally {
    await s.close();
  }
});

test('http: honors text/event-stream accept', async () => {
  const s = await startHttpServer({ host: '127.0.0.1', port: 0 });
  try {
    const res = await fetch(s.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: TOOL_NAME, arguments: {} } }),
    });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const text = await res.text();
    assert.ok(text.startsWith('data: '), 'SSE single event');
    assert.ok(text.includes('review-readonly'));
  } finally {
    await s.close();
  }
});

test('http: GET /mcp opens the server->client SSE stream (Streamable HTTP)', async () => {
  const s = await startHttpServer({ host: '127.0.0.1', port: 0 });
  try {
    const res = await fetch(s.url, { method: 'GET', headers: { accept: 'text/event-stream' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    await res.body.cancel(); // tear down the open SSE stream
  } finally {
    if (s.server && s.server.closeAllConnections) s.server.closeAllConnections();
    await s.close();
  }
});

test('http: non-MCP path is rejected (405)', async () => {
  const s = await startHttpServer({ host: '127.0.0.1', port: 0 });
  try {
    const res = await fetch(s.url.replace('/mcp', '/other'), { method: 'GET' });
    assert.equal(res.status, 405);
    const res2 = await fetch(s.url.replace('/mcp', '/other'), { method: 'POST' });
    assert.equal(res2.status, 405);
  } finally {
    await s.close();
  }
});

test('http: preflight OPTIONS reflects origin, method and requested headers (204)', async () => {
  const s = await startHttpServer({ host: '127.0.0.1', port: 0 });
  try {
    const res = await rawRequest(s.url, 'OPTIONS', {
      origin: 'https://chatgpt.com',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type, mcp-session-id, accept',
      accept: '*/*',
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], 'https://chatgpt.com');
    assert.match(res.headers['access-control-allow-methods'], /POST/);
    assert.equal(res.headers['access-control-allow-headers'], 'content-type, mcp-session-id, accept');
    assert.equal(res.headers['access-control-allow-credentials'], 'true');
    assert.equal(res.headers.vary, 'Origin');
    assert.equal(res.text, '');
  } finally {
    await s.close();
  }
});

test('http: disallowed origin is refused (403, DNS-rebinding guard)', async () => {
  const s = await startHttpServer({ host: '127.0.0.1', port: 0 });
  try {
    const res = await rawRequest(s.url, 'POST', {
      origin: 'https://evil.example.test',
      'content-type': 'application/json',
      accept: 'application/json',
    }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    assert.equal(res.status, 403);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  } finally {
    await s.close();
  }
});

test('http: allowed browser origin reflected; no-origin client gets wildcard', async () => {
  const s = await startHttpServer({ host: '127.0.0.1', port: 0 });
  try {
    const withOrigin = await rawRequest(s.url, 'POST', {
      origin: 'https://gemini.google.com',
      'content-type': 'application/json',
      accept: 'application/json',
    }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    assert.equal(withOrigin.status, 200);
    assert.equal(withOrigin.headers['access-control-allow-origin'], 'https://gemini.google.com');

    const noOrigin = await rawRequest(s.url, 'POST', {
      'content-type': 'application/json',
      accept: 'application/json',
    }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    assert.equal(noOrigin.status, 200);
    assert.equal(noOrigin.headers['access-control-allow-origin'], '*');
  } finally {
    await s.close();
  }
});


// ---- stdio e2e (Issue #34 shape, real child) -------------------------------
function startServer() {
  const child = spawn(process.execPath, [SERVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let seq = 0;
  const pending = new Map();
  const stderr = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => stderr.push(c));
  function call(method, params) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method} (id ${id})`)), 5000);
      pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  function notify(method) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  }
  return {
    child, call, notify,
    end: () => child.stdin.end(),
    kill: () => child.kill(),
    stderr: () => stderr.join(''),
  };
}

test('e2e: stdio negotiation round-trips review.ping and exits 0 on EOF', async () => {
  const s = startServer();
  try {
    const init = await s.call('initialize', {});
    assert.equal(init.result.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.deepEqual(init.result.capabilities, { tools: {} });
    s.notify('notifications/initialized');

    const list = await s.call('tools/list', {});
    assert.equal(list.result.tools.length, 4);
    const listNames = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(listNames, ['review.get_evidence', 'review.get_request', 'review.ping', 'review.submit_decision']);

    const call = await s.call('tools/call', { name: TOOL_NAME, arguments: {} });
    assert.equal(call.result.isError, false);
    assert.deepEqual(JSON.parse(call.result.content[0].text), {
      ok: true, service: 'soc_brain', mode: 'review-readonly',
    });

    const exitCode = new Promise((resolve) => s.child.on('exit', (code) => resolve(code)));
    s.end();
    assert.equal(await exitCode, 0);
  } finally {
    s.kill();
  }
});

