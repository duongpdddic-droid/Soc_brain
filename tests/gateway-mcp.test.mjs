#!/usr/bin/env node
// gateway-mcp.test.mjs — P0 TUI Gateway MCP server contract.
// Deterministic/offline: injected client-control, disposable git fixtures, no
// network, no live OpenCode. Covers the single-tool surface, delegation, and
// the PRIMARY_DIRTY_REF_HEAD_REQUIRED fail-closed branch as it is seen by a
// caller on the MCP wire (i.e. through the gateway, not just at client-control).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createGatewayMcpServer, GATEWAY_TOOL_NAME } from '../packages/client-mcp/gateway-mcp.mjs';
import { createClientControl } from '../packages/client-mcp/client-control.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-gw-'));

function makeRepo(ownerRepoName) {
  const dir = fs.mkdtempSync(path.join(TMP, 'repo-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  run(['init', '--initial-branch=main', dir]);
  run(['-C', dir, 'config', 'user.email', 't@e.x']);
  run(['-C', dir, 'config', 'user.name', 't']);
  run(['-C', dir, 'commit', '--allow-empty', '-m', 'init']);
  const sha = run(['-C', dir, 'rev-parse', 'HEAD']);
  run(['-C', dir, 'remote', 'add', 'origin', `https://github.com/${ownerRepoName}.git`]);
  run(['-C', dir, 'update-ref', 'refs/remotes/origin/main', sha]);
  return { dir, ownerRepoName, sha };
}

function newServer() {
  const control = createClientControl({
    stateDir: path.join(TMP, 'state-' + Math.random().toString(36).slice(2, 8)),
    worktreesRoot: path.join(TMP, 'wt'),
    controlLane: null,
  });
  return { server: createGatewayMcpServer({ control }), control };
}
const call = (server, params) => server.handleRequest({ jsonrpc: '2.0', id: 7, method: 'tools/call', params });
function payload(res) {
  assert.ok(res && res.result && res.result.content && res.result.content[0], `malformed result: ${JSON.stringify(res)}`);
  return JSON.parse(res.result.content[0].text);
}

test('G1. initialize + tools/list expose exactly ONE tool: gateway', () => {
  const { server } = newServer();
  const init = server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.serverInfo.name, 'soc-brain-gateway');
  const list = server.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), [GATEWAY_TOOL_NAME]);
  assert.deepEqual(list.result.tools[0].inputSchema.properties.operation.enum, ['submit', 'status', 'recover']);
});

test('G2. any tool other than gateway is rejected by the server', () => {
  const { server } = newServer();
  for (const name of ['bash', 'edit', 'task', 'read', 'soc.submit_goal']) {
    const res = call(server, { name, arguments: {} });
    assert.equal(res.error.code, -32601, `${name}: ${JSON.stringify(res)}`);
    assert.match(res.error.message, /Unknown tool/);
  }
});

test('G3. submit on a DIRTY primary checkout without targetRef/expectedHead fails closed ON THE WIRE', () => {
  const { server } = newServer();
  const R = makeRepo('duongpdddic-droid/gw-dirty');
  fs.writeFileSync(path.join(R.dir, 'README.md'), 'uncommitted\n');

  const res = call(server, {
    name: GATEWAY_TOOL_NAME,
    arguments: { operation: 'submit', goal: 'gw goal', targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, clientRequestId: 'gw-dirty-0001' },
  });

  assert.equal(res.result.isError, true, JSON.stringify(res));
  const p = payload(res);
  assert.equal(p.ok, false);
  assert.equal(p.reason, 'PRIMARY_DIRTY_REF_HEAD_REQUIRED');
  assert.ok(p.dirtyPaths.includes('README.md'), JSON.stringify(p));
  // Fail-closed before taskStart: no session, no burned task number.
  assert.ok(!fs.existsSync(path.join(server.control.config.stateDir, 'sessions')), 'no session');
  assert.ok(!fs.existsSync(path.join(server.control.config.stateDir, 'local-tasks', 'sequence.json')), 'no task number');
});

test('G4. the SAME submit on a clean checkout is admitted through the gateway', () => {
  const { server } = newServer();
  const R = makeRepo('duongpdddic-droid/gw-clean');

  const res = call(server, {
    name: GATEWAY_TOOL_NAME,
    arguments: { operation: 'submit', goal: 'gw clean goal', targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, clientRequestId: 'gw-clean-0001' },
  });

  const p = payload(res);
  assert.ok(p.ok, JSON.stringify(p));
  assert.equal(p.admitted, true);
  assert.equal(res.result.isError, false);
});

test('G5. unknown operation and read-only status stay fail-closed / non-mutating', () => {
  const { server } = newServer();
  const bad = payload(call(server, { name: GATEWAY_TOOL_NAME, arguments: { operation: 'rm-rf' } }));
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'GATEWAY_OPERATION_UNKNOWN');

  const status = payload(call(server, { name: GATEWAY_TOOL_NAME, arguments: { operation: 'status', repo: 'duongpdddic-droid/none', issueNumber: 1 } }));
  assert.equal(status.ok, false);
  assert.equal(status.reason, 'TASK_NOT_FOUND');
  assert.ok(!fs.existsSync(path.join(server.control.config.stateDir, 'sessions')), 'status must not create state');
});
