#!/usr/bin/env node
// opencode-adapter.mjs — Soc_brain: OpenCode config writer (Issue #18).
// Writes opencode.json into the worktree root with a CODING-EXECUTOR permission
// profile (max executor autonomy INSIDE the isolated worktree: bash/edit/
// webfetch/websearch/task/skill allow; hard boundaries stay at config level:
// external_directory deny + read deny patterns for secrets) and the `mcp` local
// launch config for the Soc_brain broker (type:local + command array + environment).
// Optional `instructions` (file paths) are projected so the executor self-serves
// the canonical task contract without the user copy-pasting the Issue body
// (Issue #31 pilot). Atomic write via temp+rename. Exported: buildOpenCodeConfig,
// writeOpenCodeConfig, readOpenCodeConfigDigest, readOpenCodeConfig,
// evaluateCodingCapabilities (preflight). PINNED_OPENCODE_VERSION: the
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
//     `deny`/`allow`/`ask`, keyed by tool name; object value = glob
//     pattern-map, LAST matching rule wins — docs `Permissions → Granular
//     Rules`);
//   - MCP servers live under top-level `mcp`; a local server requires
//     `type: "local"`, a `command` ARRAY, and `environment` (plus `enabled`).
// Verified against the pinned OpenCode runtime via `opencode debug config`.
//
// Executor autonomy profile: the coding executor gets native shell/edit/
// discovery/web/subagent capabilities INSIDE its isolated worktree. Every
// tool key is EXPLICIT here because the operator global
// ~/.config/opencode/opencode.json sets permission["*"]="ask" and OpenCode
// 1.18.x resolves any unspecified key through that wildcard -> ask ->
// headless auto-reject (GPT-REV-137 / Phase-B E2E evidence for read/glob:
// "evaluated permission=read action.permission=* action.action=ask", exit 0
// with nothing done). Explicit keys beat the wildcard; version-stable
// (1.18.18 / 1.18.25 reproduced). Hard boundaries stay at config level:
// external_directory: deny (covers every tool touching paths outside the
// worktree, including bash) + read deny patterns for secrets. Lifecycle
// authority (commit/push/merge) is NOT hard-coded here — it stays governed
// by Soc_brain lifecycle policy (broker MCP + session capabilities).
export function buildOpenCodeConfig({ mcpCommand, mcpArgs, mcpEnv, instructions }) {
  const config = {
    $schema: OPENCODE_CONFIG_SCHEMA,
    permission: {
      bash: 'allow',       // shell/test/build/diagnostic inside the bound worktree
      edit: 'allow',       // coding executor: file writes permitted (Issue #31 pilot)
      read: {              // pattern-map (docs default shape); last-match-wins:
                           // .env.example re-allow is placed AFTER the .env* denies
        '*': 'allow',      // Issue #53 / GPT-REV-137: explicit key beats the
                           // operator global "*":"ask" wildcard (headless auto-
                           // reject otherwise). Version-stable 1.18.18/1.18.25.
        '*.env': 'deny',   // secret boundary: never read .env/.env.* from the
        '*.env.*': 'deny', // worktree (matches the OpenCode native default and
                           // keeps it explicit under this profile)
        '*.env.example': 'allow',
        '*.pem': 'deny',
        '*.key': 'deny',
      },
      glob: 'allow',       // read-only discovery trio (Phase B E2E: silent
      grep: 'allow',       // auto-reject via wildcard ask otherwise)
      list: 'allow',
      task: 'allow',       // subagents (pinned 1.18.x permission key)
      skill: 'allow',
      webfetch: 'allow',   // docs/API lookup from inside the worktree
      websearch: 'allow',
      external_directory: 'deny', // HARD BOUNDARY: never touch paths outside
                                  // the bound worktree (read/edit/bash)
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

// Capability preflight (pure, fail-closed): the worktree opencode.json
// projection must grant the minimum tool surface a CODING task needs —
// shell (bash), file mutation (edit), test (bash-adjacent), discovery
// (read/glob/grep/list). Anything absent or "ask" fails headless (auto-reject,
// GPT-REV-137), so an insufficient projection must fail BEFORE spawn.
// Allowance: a projection MAY grant more (task/skill/webfetch/websearch) and
// read may be a pattern-map — only the minimum is asserted here.
export const CODING_CAPABILITY_REQUIREMENTS = {
  bash: 'allow',
  edit: 'allow',
  read: 'allow',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
};

export function evaluateCodingCapabilities(config) {
  const perm = config && typeof config === 'object' ? config.permission : null;
  if (!perm || typeof perm !== 'object') {
    return { ok: false, reason: 'PERMISSION_BLOCK_MISSING', missing: Object.keys(CODING_CAPABILITY_REQUIREMENTS) };
  }
  // A capability is granted by a literal 'allow' OR by a pattern-map whose
  // wildcard grants allow (the canonical read shape is a pattern-map).
  const allows = (v) => v === 'allow' || (v !== null && typeof v === 'object' && !Array.isArray(v) && v['*'] === 'allow');
  const missing = [];
  for (const [key, required] of Object.entries(CODING_CAPABILITY_REQUIREMENTS)) {
    if (!allows(perm[key])) missing.push(key);
  }
  if (missing.length > 0) return { ok: false, reason: 'EXECUTOR_CAPABILITY_INSUFFICIENT', missing };
  return { ok: true, toolCaps: { ...CODING_CAPABILITY_REQUIREMENTS } };
}

// Read the projection back from disk (fail-closed): a missing/unparseable
// config is a hard preflight failure, never a silent default.
export function readOpenCodeConfig({ worktreePath }) {
  const p = path.join(path.resolve(worktreePath), OPENCODE_CONFIG_FILENAME);
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (e) { return { ok: false, reason: 'CONFIG_READ_FAILED', path: p, detail: String((e && e.message) || e) }; }
  let config;
  try { config = JSON.parse(raw); }
  catch (e) { return { ok: false, reason: 'CONFIG_PARSE_FAILED', path: p, detail: String((e && e.message) || e) }; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { ok: false, reason: 'CONFIG_PARSE_FAILED', path: p, detail: 'config is not a JSON object.' };
  }
  return { ok: true, config, path: p };
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