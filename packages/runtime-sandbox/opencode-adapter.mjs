#!/usr/bin/env node
// opencode-adapter.mjs — Soc_brain: OpenCode config writer (Issue #18).
// Writes opencode.json into the worktree root with `permission` denying
// bash/edit/webfetch/external_directory and the `mcp` local launch config for
// the Soc_brain broker (type:local + command array + environment). Atomic write
// via temp+rename. Exported: buildOpenCodeConfig, writeOpenCodeConfig,
// readOpenCodeConfigDigest. PINNED_OPENCODE_VERSION: the pinned OpenCode release.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PINNED_OPENCODE_VERSION = '1.18.25';

export const OPENCODE_CONFIG_FILENAME = 'opencode.json';
// The JSON schema URL OpenCode uses for its config file (GPT-REV-141).
export const OPENCODE_CONFIG_SCHEMA = 'https://opencode.ai/config.json';

// Build the real OpenCode 1.18.x config shape (GPT-REV-141). The previous
// `bash`/`edit`/`mcpServers` shape is NOT the OpenCode schema:
//   - tool restrictions live under top-level `permission` (string values
//     `deny`/`allow`/`ask`, keyed by tool name);
//   - MCP servers live under top-level `mcp`; a local server requires
//     `type: "local"`, a `command` ARRAY, and `environment` (plus `enabled`).
// Verified against the pinned OpenCode runtime via `opencode debug config`.
export function buildOpenCodeConfig({ mcpCommand, mcpArgs, mcpEnv }) {
  return {
    $schema: OPENCODE_CONFIG_SCHEMA,
    permission: {
      bash: 'deny',
      edit: 'deny',
      webfetch: 'deny',
      external_directory: 'deny',
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