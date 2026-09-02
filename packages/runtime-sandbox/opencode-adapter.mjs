#!/usr/bin/env node
// opencode-adapter.mjs — Soc_brain: OpenCode config writer (Issue #18).
// Writes opencode.json into the worktree root with a CODING-EXECUTOR permission
// profile (edit allowed so OpenCode can write code; bash/webfetch/external_directory
// denied — git + tests go through the Soc_brain broker MCP) and the `mcp` local
// launch config for the Soc_brain broker (type:local + command array + environment).
// Optional `instructions` (file paths) are projected so the executor self-serves
// the canonical task contract without the user copy-pasting the Issue body
// (Issue #31 pilot). Atomic write via temp+rename. Exported: buildOpenCodeConfig,
// writeOpenCodeConfig, readOpenCodeConfigDigest. PINNED_OPENCODE_VERSION: the
// pinned OpenCode release.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PINNED_OPENCODE_VERSION = '1.18.25';

export const OPENCODE_CONFIG_FILENAME = 'opencode.json';
// The JSON schema URL OpenCode uses for its config file (GPT-REV-141).
export const OPENCODE_CONFIG_SCHEMA = 'https://opencode.ai/config.json';
// Client-side MCP request timeout (ms) projected into the opencode.json so the
// OpenCode executor does NOT cut long Soc_brain broker tool calls at the default
// 30s (opencode `DEFAULT_TIMEOUT`). 180000 > broker test timeoutMs=120000, with
// headroom for startup/transport. Does NOT change broker timeout semantics.
export const OPENCODE_MCP_TIMEOUT_MS = 180000;

// Build the real OpenCode 1.18.x config shape (GPT-REV-141). The previous
// `bash`/`edit`/`mcpServers` shape is NOT the OpenCode schema:
//   - tool restrictions live under top-level `permission` (string values
//     `deny`/`allow`/`ask`, keyed by tool name);
//   - MCP servers live under top-level `mcp`; a local server requires
//     `type: "local"`, a `command` ARRAY, and `environment` (plus `enabled`).
// Verified against the pinned OpenCode runtime via `opencode debug config`.
//
// default_agent + agent.build.permission override (Issue #33): the
// user-global `~/.config/opencode/opencode.json` defines `default_agent:
// "soc-plan"` (a read-only planning agent) and the merged built-in `build`
// agent carries an `edit: deny` rule from the global permission array. Just
// setting top-level `permission.edit: "allow"` does NOT change either — the
// default agent is read-only by name, and per-agent permission arrays are
// merged with last-match-wins. To make OpenCode Build the coding executor
// with write capability in the authorized worktree (and ONLY there — this
// is a worktree-scoped opencode.json, not the user-global config), the
// projection also pins `default_agent: "build"` and overrides
// `agent.build.permission.edit: "allow"`. Other agent permission rules in
// the merged config still apply (e.g. bash/webfetch/external_directory
// remain denied), so the broker-mediated contract is preserved.
export function buildOpenCodeConfig({ mcpCommand, mcpArgs, mcpEnv, instructions }) {
  const config = {
    $schema: OPENCODE_CONFIG_SCHEMA,
    default_agent: 'build',
    permission: {
      bash: 'deny',
      edit: 'allow',       // coding executor: file writes permitted (Issue #31 pilot)
      webfetch: 'deny',
      external_directory: 'deny',
    },
    agent: {
      build: {
        permission: {
          edit: 'allow',   // override global build-permission deny (Issue #33)
        },
      },
    },
    experimental: {
      mcp_timeout: OPENCODE_MCP_TIMEOUT_MS,
    },
    mcp: {
      'soc-brain': {
        type: 'local',
        command: [mcpCommand, ...(mcpArgs || [])],
        environment: mcpEnv || {},
        enabled: true,
      },
    },
  };
  // Task-contract projection: reference the bounded contract file so the
  // executor self-serves scope/acceptance (OpenCode loads `instructions` as
  // context; absent when no contract is supplied).
  if (Array.isArray(instructions) && instructions.length > 0) config.instructions = instructions;
  return config;
}

export function writeOpenCodeConfig({ worktreePath, config }) {
  const dir = path.resolve(worktreePath);
  if (!fs.statSync(dir).isDirectory()) {
    return { ok: false, reason: 'NOT_A_DIRECTORY', path: dir };
  }
  const target = path.join(dir, OPENCODE_CONFIG_FILENAME);
  const tmp = target + '.tmp.' + process.pid;
  const json = JSON.stringify(config, null, 2) + '\n';
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, target);
  return { ok: true, path: target, bytes: Buffer.byteLength(json, 'utf8') };
}

export function readOpenCodeConfigDigest({ worktreePath }) {
  const p = path.join(path.resolve(worktreePath), OPENCODE_CONFIG_FILENAME);
  try {
    const content = fs.readFileSync(p, 'utf8');
    const digest = crypto.createHash('sha256').update(content).digest('hex');
    return { ok: true, digest, bytes: Buffer.byteLength(content, 'utf8') };
  } catch (e) {
    return { ok: false, reason: 'READ_ERROR', detail: String((e && e.message) || e) };
  }
}