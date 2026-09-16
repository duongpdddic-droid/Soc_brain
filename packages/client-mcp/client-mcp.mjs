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
import { createClientControl, readClientControlConfig, CLIENT_CAPABILITIES, createDetachedRouteExecutor } from './client-control.mjs';
import { readTransportState, recordAdapterBoot, recordReattach } from './recovery.mjs';
import { createFollowWatcher, FOLLOW_DEFAULT_INTERVAL_MS } from './follow-watcher.mjs';

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
  {
    name: 'soc.recover',
    description: 'MANUAL MCP restart / reattach (transport-level recovery ONLY). After the soc-brain adapter was disconnected/killed and the operator restarted ONLY the MCP transport, call this on the FRESH adapter to reattach to the SAME canonical task WITHOUT resubmitting the goal. Omit both args to attach to the single active canonical task (discovered from persisted state); or pass exact {repo, issueNumber}. READ/RECONCILE ONLY: never submits, launches, answers gates, authorizes merges, terminalizes, or mints any second task/session/execution/owner; stale/foreign/ambiguous identity fails closed. Returns transportState=RECOVERED + the exact identity (repo/issue/identityHash/taskId/session state/mutationOwner/execution pid+processStartTime liveness/Human-Gate checkpoint) + transport observability (restartCount, lastDisconnectAt, lastRestartAt, lastReattachAt).',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'optional exact bind (must come with issueNumber).' },
        issueNumber: { type: 'integer', minimum: 1, description: 'optional exact bind (must come with repo).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'soc.follow',
    description: 'Read-only ONE-SHOT operational snapshot for {repo, issueNumber}: authoritative effective state (RUNNING/STARTING/HUMAN_GATE/READY_FOR_REVIEW/RECOVERABLE_BLOCKED/PENDING_RECONCILIATION/UNKNOWN/terminal) + bounded executor step/progress + execution liveness (#160). This is the SAME effective state get_task/get_progress/recover report; it carries NO verdict and mutates NOTHING. The attached control client also receives these automatically via notifications/message whenever the durable state of a submitted/recovered task changes, so normal UX requires NO manual get_task/get_progress polling.',
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

function defaultControl() {
  const cfg = readClientControlConfig(process.env);
  // F1 production wiring + #181 manual-restart independence: a lane-bound
  // control-plane admission routes its admitted task to the canonical executor
  // launch through the DETACHED route worker (route-worker.mjs -> the SAME
  // executor-launcher.startExecution). The executor is therefore a transport
  // SIBLING: killing/restarting ONLY this MCP adapter process can never break
  // the executor's stdio or lose its exit-finalization supervisor. An unbound
  // interactive client (no SOC_CONTROL_LANE) stays admitted-only and never
  // spawns an executor.
  return createClientControl(cfg.controlLane ? { ...cfg, routeExecutor: createDetachedRouteExecutor() } : cfg);
}

export function createClientMcpServer({
  control = defaultControl(),
  notify = () => {},
  scheduler = { setIntervalFn: (fn, ms) => setInterval(fn, ms), clearIntervalFn: (h) => clearInterval(h) },
  followIntervalMs = FOLLOW_DEFAULT_INTERVAL_MS,
} = {}) {
  // ---- automatic follower (F1): one identity-bound watcher per attached task ---
  // After ONE submit/attach the pinned task's OPERATIONAL state changes are pushed
  // as notifications/message without any manual get_task/get_progress polling.
  // The watcher is bound to a single identity (no cross-stream contamination) and
  // dedupes on the durable seq. It only observes durable canonical state written
  // by the detached worker; it never mutates lifecycle.
  const watchers = new Map();
  function followSnapshot({ repo, issueNumber }) {
    const v = control.follow({ repo, issueNumber });
    if (!v || v.ok !== true) return { ok: false };
    return { ok: true, seq: v.seq, payload: { ...v } };
  }
  function attachFollow({ repo, issueNumber, identityHash }) {
    if (!repo || !Number.isInteger(issueNumber) || issueNumber <= 0) return null;
    const key = identityHash || `${repo}#${issueNumber}`;
    if (watchers.has(key)) { watchers.get(key).resync(); return watchers.get(key); }
    const w = createFollowWatcher({
      identity: { repo, issueNumber, identityHash: key },
      snapshot: () => followSnapshot({ repo, issueNumber }),
      emit: (view) => notify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', logger: 'soc-brain-client', data: view } }),
      setIntervalFn: scheduler.setIntervalFn, clearIntervalFn: scheduler.clearIntervalFn, intervalMs: followIntervalMs,
    });
    w.start();
    watchers.set(key, w);
    return w;
  }
  function stopAllFollows() { for (const w of watchers.values()) { try { w.stop(); } catch { /* best effort */ } } watchers.clear(); }
  function tickFollows() { const out = []; for (const w of watchers.values()) { const r = w.tick(); if (r && r.emitted) out.push(r.view); } return out; }

  function dispatch(request) {
    const name = (request && request.params && request.params.name) || '';
    const args = (request && request.params && request.params.arguments) || {};
    let result;
    switch (name) {
      case 'soc.submit_goal': result = control.submitGoal(args); break;
      case 'soc.get_task': result = control.getTask(args); break;
      case 'soc.get_progress': result = control.getProgress(args); break;
      case 'soc.answer_human_gate': result = control.answerHumanGate(args); break;
      case 'soc.request_review': result = control.requestReview(args); break;
      case 'soc.authorize_merge': result = control.authorizeMerge(args); break;
      case 'soc.cancel_task': result = control.cancelTask(args); break;
      case 'soc.follow': result = control.follow(args); break;
      case 'soc.recover': result = control.recover(args); break;
      default: return { ok: false, reason: 'UNAUTHORIZED_TOOL_EXPOSED', tool: name };
    }
    // Attach the automatic follower after a successful submit or reattach, keyed
    // to the canonical identity — the SAME task is followed across reconnects.
    try {
      if (result && result.ok === true && name === 'soc.submit_goal' && result.identityHash) {
        attachFollow({ repo: result.repo, issueNumber: result.issueNumber, identityHash: result.identityHash });
      } else if (result && result.ok === true && name === 'soc.recover' && result.currentTaskIdentity) {
        const cti = result.currentTaskIdentity;
        attachFollow({ repo: cti.repo, issueNumber: cti.issueNumber, identityHash: cti.identityHash });
      }
    } catch { /* observability wiring must never affect the tool result */ }
    return result;
  }
  function handleRequest(request) {
    if (!request || typeof request !== 'object') return null;
    const { id, method } = request;
    if (method === 'initialize') {
      return { jsonrpc: '2.0', id, result: { protocolVersion: CLIENT_MCP_PROTOCOL_VERSION, serverInfo: { name: 'soc-brain-client', version: CLIENT_MCP_SERVER_VERSION }, capabilities: { tools: {}, logging: {} } } };
    }
    if (method === 'notifications/initialized') return null;
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    if (method === 'tools/call') return toolResult(id, dispatch(request));
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
  return { ok: true, tools: TOOLS, capabilities: CLIENT_CAPABILITIES, handleRequest, dispatch, control, attachFollow, stopAllFollows, tickFollows };
}

function main() {
  // One serialized whole-line writer so tool responses and follower
  // notifications/message never interleave into a corrupt frame.
  const writeLine = (obj) => { try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch { /* transport closed */ } };
  const server = createClientMcpServer({ notify: writeLine });
  // AUTO reattach on boot (supervised transport, SOC_MCP_AUTO_RECOVER trusted
  // launch env — set by the control plane that registers this server, never by
  // a tool caller). REWORK F3 — AUTO mode NEVER attaches by discovery:
  //   '1'|'true' (STRICT): the previously pinned exact identity is REQUIRED;
  //                missing/unreadable/incomplete pin => deterministic
  //                AUTO_RECOVERY_PIN_MISSING fail-closed (no task attach,
  //                no RECOVERED publication).
  //   'bootstrap' (EXPLICIT, separate mode): discovery attach is allowed only
  //                for FIRST-TIME bootstrap of a fresh supervised plane; after
  //                any task is pinned, boots bind exactly again.
  // Manual `soc.recover` tool behavior (incl. discovery when no args) is
  // completely unchanged — an operator/model call, not an automatic fallback.
  // Boot-time recovery is read/reconcile only: no submission, launch, gate,
  // merge or lifecycle write; errors never break the stdio transport. On a
  // successful reattach the automatic follower RESUMES the SAME pinned task
  // (no resubmit, no manual polling).
  const autoMode = String(process.env.SOC_MCP_AUTO_RECOVER || '').toLowerCase();
  if (['1', 'true', 'bootstrap'].includes(autoMode)) {
    try {
      const cfgS = server.control.config;
      const prev = readTransportState({ stateDir: cfgS.stateDir });
      const pinned = prev && prev.state && prev.state.currentTaskIdentity;
      const validPin = Boolean(pinned) && typeof pinned.repo === 'string' && pinned.repo !== ''
        && Number.isInteger(pinned.issueNumber) && pinned.issueNumber > 0;
      if (validPin) {
        const rec = server.control.recover({ repo: pinned.repo, issueNumber: pinned.issueNumber });
        if (rec && rec.ok && rec.currentTaskIdentity) server.attachFollow(rec.currentTaskIdentity);
      } else if (autoMode === 'bootstrap') {
        const rec = server.control.recover({});
        if (rec && rec.ok && rec.currentTaskIdentity) server.attachFollow(rec.currentTaskIdentity);
      } else {
        recordAdapterBoot({ stateDir: cfgS.stateDir, bootId: cfgS.bootId });
        recordReattach({ stateDir: cfgS.stateDir, bootId: cfgS.bootId, result: { ok: false, reason: 'AUTO_RECOVERY_PIN_MISSING', detail: 'STRICT auto recovery refuses discovery attach; the previously pinned {repo,issueNumber} is missing/unreadable/incomplete. Use SOC_MCP_AUTO_RECOVER=bootstrap for explicit first-time bootstrap, or call soc.recover manually.' } });
      }
    } catch { /* boot observability must never affect the transport */ }
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
        if (res) writeLine(res);
      } catch (e) {
        writeLine({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error', detail: String((e && e.message) || e) } });
      }
    }
  });
  process.stdin.on('end', () => {
    // Stop the automatic followers first (they write to the dying transport), then
    // record the clean close. Best-effort, silent, never affects the exit code or
    // any canonical state — the task/session/executor are untouched.
    try { server.stopAllFollows(); } catch { /* observability only */ }
    try { if (server.control.noteTransportDisconnect) server.control.noteTransportDisconnect(); } catch { /* observability only */ }
    process.exit(0);
  });
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) main();
