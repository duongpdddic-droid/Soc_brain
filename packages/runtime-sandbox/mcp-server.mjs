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
// Tools (exactly 4):
//   soc_broker_status   - git status of the bound worktree (read-only)
//   soc_broker_diff     - git diff of the bound worktree (read-only)
//   soc_broker_run_registered_test - execute a registered test in a snapshot
//   soc_broker_commit   - bounded canonical commit on the bound worktree
//                         (Issue #49: canonical message + task-scoped paths
//                         only; no shell, no argv, no arbitrary git verbs)
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
import { verifySessionAuthority, createPermissionGuard } from './runtime-sandbox.mjs';
import { gitRoot, readRemoteUrl, remoteIsCanonical } from '../safe-git/safe-git.mjs';
import { isInside } from '../temp-hygiene/temp-hygiene.mjs';

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
  return { ok: true, sessionPath, leaseToken, controlCwd: cwdRule.controlCwd };
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
  const { sessionPath, leaseToken, controlCwd } = config;

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
      // authoritative session (Issue #49) — re-verified per request.
      const v = verifyRequest('commit');
      if (!v.ok) return v;
      return broker.executeBrokerRequest({
        schemaVersion: '1', operation: 'commit', repo, issueNumber, baseSha,
        args: { message: args.message, paths: args.paths },
      });
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

  return { ok: true, tools, handleRequest, dispatch, worktreesRoot, repo, issueNumber, baseSha, controlCwd: cc.root, permissionGuard };
}

// ---- Entry point (run directly) ----------------------------------------------
// Reads JSON-RPC messages from stdin, responds on stdout. Exits 0 on EOF.
function main() {
  const server = createMcpServer();
  if (!server.ok) {
    process.stderr.write(`MCP startup failed: ${JSON.stringify(server.errors)}\n`);
    process.exit(1);
  }

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
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: null,
          error: { code: -32700, message: 'Parse error', detail: String((e && e.message) || e) },
        }) + '\n');
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

// Run directly: node mcp-server.mjs (GPT-REV-138). process.argv[1] is a
// filesystem path, import.meta.url is a file:// URL — compare via
// fileURLToPath so a directly-launched server actually runs main().
const isDirect = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) main();

