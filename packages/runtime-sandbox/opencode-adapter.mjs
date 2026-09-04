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
export function buildOpenCodeConfig({ mcpCommand, mcpArgs, mcpEnv, instructions }) {
  const config = {
    $schema: OPENCODE_CONFIG_SCHEMA,
    permission: {
      bash: 'deny',
      edit: 'allow',       // coding executor: file writes permitted (Issue #31 pilot)
      read: 'allow',       // Issue #53 / GPT-REV-137: EXPLICIT projection of the
                           // canonical read verdict (permission-orchestration
                           // OPERATION_RULES.read = ALLOW, path-gated inside
                           // the bound worktree). Required: operator global
                           // ~/.config/opencode/opencode.json sets
                           // permission["*"]="ask", and OpenCode 1.18.x
                           // resolves an unspecified `read` through that
                           // wildcard -> ask -> headless auto-reject (E2E
                           // evidence: "evaluated permission=read
                           // action.permission=* action.action=ask"). Explicit
                           // keys beat the wildcard, is version-stable
                           // (1.18.18 / 1.18.25 reproduced) and operator-
                           // global-independent. NO authority expansion: only
                           // read-only keys are added to the canonical allow
                           // set; bash/webfetch/external_directory stay deny.
                           // Phase B E2E evidence (issue 9000003, 2026-09-04):
                           // a headless run silently auto-rejected `glob`
                           // ("evaluated permission=glob action.permission=*
                           // action.action=ask") and exited 0 WITHOUT doing the
                           // task — same wildcard-ask failure class as `read`.
                           // glob/grep/list are the read-only discovery trio;
                           // explicit allow keeps headless runs deterministic.
                           // Regression: runtime-sandbox GPT-REV-137 preflight.
                           // Phase B (Local Task Identity v0): discovery tools
                           // also need explicit allow (same wildcard-ask
                           // failure class): glob/grep/list.
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      webfetch: 'deny',
      external_directory: 'deny',
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