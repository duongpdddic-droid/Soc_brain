#!/usr/bin/env node
// client-mcp.mjs — Soc_brain client control surface, local stdio MCP (Issue #175).
//
// A Cline / OpenCode / thin-CLI client connects here INSTEAD of a dedicated
// Soc_brain launcher/UI. This surface has NO lifecycle authority: it maps the
// client capabilities onto the canonical control surface (client-control.mjs)
// and nothing else. It is the transport mirror of the executor-facing broker
// (runtime-sandbox/mcp-server.mjs) but for CLIENTS, so authority lives in one
// canonical core and is not forked per client.
//
// Transport: JSON-RPC 2.0 over stdio, newline-delimited:
//   initialize, notifications/initialized, tools/list, tools/call.
// ONLY stdin/stdout; NEVER a socket. Loopback/local only (no remote control).
//
// Trusted config is read from the control-plane environment that LAUNCHES this
// process (see readClientControlConfig): SOC_CONTROL_STATE_DIR,
// SOC_CONTROL_WORKTREES_ROOT, SOC_CONTROL_LANE. Tool CALLERS never supply these.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClientControl, readClientControlConfig, CLIENT_CAPABILITIES } from './client-control.mjs';

export const CLIENT_MCP_SERVER_VERSION = '1';
export const CLIENT_MCP_PROTOCOL_VERSION = '2025-03-26';

const TOOLS = [
  {
    name: 'soc.submit_goal',
    description: 'Submit a goal against an EXPLICIT target repository through canonical Soc_brain admission (taskStart). The client does NOT become the lifecycle/mutation owner. No CWD fallback: targetRepo + localCheckoutPath are required and the checkout origin must match targetRepo. Returns the stable canonical task/session identity + state. Idempotent: re-submitting the same clientRequestId (or the same explicit issueNumber) reconciles to one task (no duplicate).',
    inputSchema: {
      type: 'object',
      properties: {
        targetRepo: { type: 'string', description: 'owner/name or a github remote URL (canonicalized).' },
        localCheckoutPath: { type: 'string', description: 'absolute path to the local canonical checkout of targetRepo (explicit; no CWD fallback).' },
        goal: { type: 'string', description: 'the product goal/instruction (data, <=8192 bytes).' },
        issueNumber: { type: 'integer', minimum: 1, description: 'optional explicit task number. Omit to allocate a canonical local task number (then clientRequestId is required).' },
        clientRequestId: { type: 'string', description: 'stable id for replay-safe goal-only submits (>=8 chars).' },
        executorPreference: { type: 'string', enum: ['cline', 'opencode', 'auto'], description: 'executor routing preference (routing stays a Soc_brain control-plane decision).' },
      },
      required: ['targetRepo', 'localCheckoutPath', 'goal'],
      additionalProperties: false,
    },
  },
  {
    name: 'soc.get_task',
    description: 'Read-only: canonical task/session state for {repo, issueNumber}. Reads persisted canonical state (no parallel store). Redacts lease token / absolute paths.',
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string' }, issueNumber: { type: 'integer', minimum: 1 } },
      required: ['repo', 'issueNumber'], additionalProperties: false,
    },
  },
  {
    name: 'soc.get_progress',
    description: 'Read-only: current lifecycle position + executor step/progress telemetry + execution liveness (via the #160 reconcile identity liveness, never inferred RUNNING). No lifecycle effect, no duplicate execution.',
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string' }, issueNumber: { type: 'integer', minimum: 1 } },
      required: ['repo', 'issueNumber'], additionalProperties: false,
    },
  },
  {
    name: 'soc.answer_human_gate',
    description: 'Relay a HUMAN answer to an EXISTING HUMAN_GATE_REQUIRED/WAITING_FOR_INPUT checkpoint through the canonical resume seam. Exact {repo, issueNumber, checkpointAt} binding; stale/wrong-checkpoint fails closed; accepted exactly once (a replay is GATE_NOT_ACTIVE). The client CANNOT synthesize approval — `response` is data; deterministic verification / review / merge stay authoritative.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' }, issueNumber: { type: 'integer', minimum: 1 },
        checkpointAt: { type: 'string', description: 'the exact humanGate.at presented by get_task.' },
        response: { type: 'string', description: 'the human reply text (data, <=8192 bytes).' },
      },
      required: ['repo', 'issueNumber', 'checkpointAt'], additionalProperties: false,
    },
  },
  {
    name: 'soc.request_review',
    description: 'Request/continue the canonical review where policy allows. NON-authoritative: carries NO verdict and cannot set PASS. Returns the review handoff bound to {repository, issue, pullRequest, headSha}.',
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string' }, issueNumber: { type: 'integer', minimum: 1 } },
      required: ['repo', 'issueNumber'], additionalProperties: false,
    },
  },
  {
    name: 'soc.authorize_merge',
    description: 'Record an EXPLICIT human merge authorization bound to exact {repository, issue, pullRequest, reviewedHeadSha}, validated against the authoritative session. It performs NO merge and touches NO delivery transport. Stale/wrong HEAD, wrong PR, wrong issue, foreign repo, or terminal attempt fail closed. Idempotent by clientRequestId. The canonical delivery leg (control-loop/delivery#mergePr) CONSUMES this record and refuses to issue `gh pr merge` without it — a merge needs BOTH a validated GPT PASS and this exact authorization.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' }, issueNumber: { type: 'integer', minimum: 1 },
        pullRequest: { type: 'integer', minimum: 1 },
        reviewedHeadSha: { type: 'string', description: '40-hex SHA of the reviewed HEAD being authorized.' },
        authorizedBy: { type: 'string', description: 'the human authorizing the merge.' },
        clientRequestId: { type: 'string', description: 'stable id for exactly-once replay safety (>=8 chars).' },
      },
      required: ['repo', 'issueNumber', 'pullRequest', 'reviewedHeadSha', 'authorizedBy', 'clientRequestId'], additionalProperties: false,
    },
  },
  {
    name: 'soc.cancel_task',
    description: 'FAIL CLOSED. There is no canonical, safe cancellation path to reuse, so this capability is deliberately not implemented (no second lifecycle is invented).',
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string' }, issueNumber: { type: 'integer', minimum: 1 } },
      required: ['repo', 'issueNumber'], additionalProperties: false,
    },
  },
];

function toolResult(id, payload) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: !payload || payload.ok === false } };
}

export function createClientMcpServer({ control = createClientControl(readClientControlConfig(process.env)) } = {}) {
  function dispatch(request) {
    const name = (request && request.params && request.params.name) || '';
    const args = (request && request.params && request.params.arguments) || {};
    switch (name) {
      case 'soc.submit_goal': return control.submitGoal(args);
      case 'soc.get_task': return control.getTask(args);
      case 'soc.get_progress': return control.getProgress(args);
      case 'soc.answer_human_gate': return control.answerHumanGate(args);
      case 'soc.request_review': return control.requestReview(args);
      case 'soc.authorize_merge': return control.authorizeMerge(args);
      case 'soc.cancel_task': return control.cancelTask(args);
      default: return { ok: false, reason: 'UNAUTHORIZED_TOOL_EXPOSED', tool: name };
    }
  }
  function handleRequest(request) {
    if (!request || typeof request !== 'object') return null;
    const { id, method } = request;
    if (method === 'initialize') {
      return { jsonrpc: '2.0', id, result: { protocolVersion: CLIENT_MCP_PROTOCOL_VERSION, serverInfo: { name: 'soc-brain-client', version: CLIENT_MCP_SERVER_VERSION }, capabilities: { tools: {} } } };
    }
    if (method === 'notifications/initialized') return null;
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    if (method === 'tools/call') return toolResult(id, dispatch(request));
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
  return { ok: true, tools: TOOLS, capabilities: CLIENT_CAPABILITIES, handleRequest, dispatch, control };
}

function main() {
  const server = createClientMcpServer();
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
