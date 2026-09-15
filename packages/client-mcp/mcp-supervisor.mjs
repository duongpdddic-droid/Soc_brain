#!/usr/bin/env node
// mcp-supervisor.mjs — AUTO MCP recovery supervisor, standalone process entry.
//
// Launch (trusted control-plane environment — set by the operator/control plane
// that starts the supervised client, NEVER by a tool caller):
//   SOC_OPENCODE_CONTROL_URL     REQUIRED loopback URL of the OpenCode server
//                                (e.g. http://127.0.0.1:4177 — `opencode serve`
//                                must run with a pinned --port for supervision).
//   SOC_OPENCODE_MCP_SERVER      local MCP server name to supervise
//                                (default: soc-brain-client).
//   SOC_OPENCODE_SERVER_PASSWORD optional Basic-auth password (OpenCode
//                                OPENCODE_SERVER_PASSWORD; username defaults to
//                                "opencode", override SOC_OPENCODE_SERVER_USERNAME).
//   SOC_CONTROL_STATE_DIR        canonical state dir (same value the supervised
//                                adapter runs with — the client-mcp namespace).
//   SOC_SUPERVISOR_POLL_MS / _BACKOFF_BASE_MS / _BACKOFF_CAP_MS /
//   _MAX_ATTEMPTS / _HEALTH_TIMEOUT_MS / _REATTACH_TIMEOUT_MS   bounded policy
//                                overrides (defaults in supervisor.mjs).
//
// The supervised OpenCode config must additionally set SOC_MCP_AUTO_RECOVER=1
// on the local mcp server so a respawning adapter performs its read-only
// reattach at boot (see examples/opencode-config.supervised.example.json).
//
// Authority: transport ONLY (see supervisor.mjs). It never submits goals,
// launches executors, answers gates, authorizes merges, or terminalizes tasks.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpSupervisor, releaseSupervisorLock } from './supervisor.mjs';
import { defaultStateDir } from '../runtime-sandbox/runtime-sandbox.mjs';

function intFromEnv(env, key) {
  const n = Number.parseInt(env[key] || '', 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function main(env = process.env) {
  const controlUrl = env.SOC_OPENCODE_CONTROL_URL;
  if (!controlUrl) { process.stderr.write('SOC_OPENCODE_CONTROL_URL is required (loopback OpenCode server URL)\n'); process.exit(2); }
  const stateDir = env.SOC_CONTROL_STATE_DIR || defaultStateDir();
  const policy = Object.fromEntries(Object.entries({
    pollMs: intFromEnv(env, 'SOC_SUPERVISOR_POLL_MS'),
    backoffBaseMs: intFromEnv(env, 'SOC_SUPERVISOR_BACKOFF_BASE_MS'),
    backoffCapMs: intFromEnv(env, 'SOC_SUPERVISOR_BACKOFF_CAP_MS'),
    maxAttempts: intFromEnv(env, 'SOC_SUPERVISOR_MAX_ATTEMPTS'),
    healthTimeoutMs: intFromEnv(env, 'SOC_SUPERVISOR_HEALTH_TIMEOUT_MS'),
    reattachTimeoutMs: intFromEnv(env, 'SOC_SUPERVISOR_REATTACH_TIMEOUT_MS'),
  }).filter(([, v]) => v !== undefined));
  const supervisor = createMcpSupervisor({
    controlUrl,
    stateDir,
    serverName: env.SOC_OPENCODE_MCP_SERVER || 'soc-brain-client',
    password: env.SOC_OPENCODE_SERVER_PASSWORD || null,
    username: env.SOC_OPENCODE_SERVER_USERNAME || 'opencode',
    policy,
    log: (line) => { try { process.stdout.write(line); } catch { /* log sink died */ } },
  });
  let stopping = false;
  const bye = () => { if (stopping) return; stopping = true; try { releaseSupervisorLock({ stateDir, bootId: supervisor.id }); } catch { /* best effort */ } process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  supervisor.start().then((r) => { if (r && r.ok === false) process.exit(1); }).catch((e) => { process.stderr.write(`supervisor fatal: ${String((e && e.message) || e)}\n`); process.exit(1); });
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) main();
