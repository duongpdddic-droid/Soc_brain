#!/usr/bin/env node
// review-mcp.test.mjs — Soc_brain PoC MCP (Issue #34).
// Proves MCP protocol/stdio compatibility of packages/review-mcp/review-mcp.mjs:
// real child process over stdio, JSON-RPC 2.0 newline-delimited, the exact
// initialize -> notifications/initialized -> tools/list -> tools/call flow, and the
// read-only fail-closed boundaries (single tool, no write/exec/GitHub capability).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  createReviewMcp,
  TOOL_NAME,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_VERSION,
} from '../packages/review-mcp/review-mcp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.resolve(HERE, '..', 'packages', 'review-mcp', 'review-mcp.mjs');

// ---- stdio child driver ----------------------------------------------------
function startServer() {
  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
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
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${method} (id ${id})`)),
        5000,
      );
      pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  function notify(method) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  }
  return {
    child,
    call,
    notify,
    end: () => child.stdin.end(),
    kill: () => child.kill(),
    stderr: () => stderr.join(''),
  };
}

// ---- Unit tests (in-process) -----------------------------------------------
test('unit: exposes exactly one tool named review.ping', () => {
  const { tools } = createReviewMcp();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, TOOL_NAME);
  assert.deepEqual(tools[0].inputSchema, { type: 'object', properties: {}, required: [] });
});

test('unit: no write/exec/GitHub surface in the exposed capability', () => {
  const { tools } = createReviewMcp();
  const names = tools.map((t) => t.name);
  assert.ok(names.every((n) => /^[a-z0-9_.-]+$/.test(n)), 'names are simple identifiers');
  for (const t of tools) {
    assert.equal(
      /(exec|write|git|github|broker|runtime|command|delete|push|run|spawn|fs|shell)|\.exec\b|\.write\b/i.test(
        t.name + ' ' + (t.description || ''),
      ),
      false,
      `tool surfaces no privileged capability: ${t.name}`,
    );
    assert.deepEqual(Object.keys(t.inputSchema.properties || {}), []);
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
  const res = handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: TOOL_NAME, arguments: {} } });
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
  const badTool = handleRequest({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'review.exec', arguments: {} } });
  assert.equal(badTool.error.code, -32602);
  const badMethod = handleRequest({ jsonrpc: '2.0', id: 4, method: 'tools/nonexistent' });
  assert.equal(badMethod.error.code, -32601);
});


// ---- E2E stdio protocol test (real child) ----------------------------------
test('e2e: full stdio negotiation round-trips review.ping and exits 0 on EOF', async () => {
  const s = startServer();
  try {
    // initialize
    const init = await s.call('initialize', {});
    assert.equal(init.result.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.equal(init.result.serverInfo.name, 'soc-brain-review');
    assert.deepEqual(init.result.capabilities, { tools: {} });
    s.notify('notifications/initialized');

    // tools/list -> exactly one tool, review.ping
    const list = await s.call('tools/list', {});
    assert.equal(list.result.tools.length, 1);
    assert.equal(list.result.tools[0].name, TOOL_NAME);

    // tools/call review.ping
    const call = await s.call('tools/call', { name: TOOL_NAME, arguments: {} });
    assert.equal(call.result.isError, false);
    const payload = JSON.parse(call.result.content[0].text);
    assert.deepEqual(payload, { ok: true, service: 'soc_brain', mode: 'review-readonly' });

    // fail-closed: unknown tool over the wire
    const bad = await s.call('tools/call', { name: 'review.exec', arguments: {} });
    assert.equal(bad.error.code, -32602);

    // exit 0 on EOF
    const exitCode = new Promise((resolve) => s.child.on('exit', (code) => resolve(code)));
    s.end();
    assert.equal(await exitCode, 0);
  } finally {
    s.kill();
  }
});
