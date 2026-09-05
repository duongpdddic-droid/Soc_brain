#!/usr/bin/env node
// install-advisor-mcp.mjs — idempotent registration of `soc-brain-advisor`
// into Cline's user-level `cline_mcp_settings.json` (Issue #63, B2).
//
// Why a script and not a commit:
//   - `cline_mcp_settings.json` is a user-level file outside the repo. Per
//     AGENTS.md the executor MUST NOT modify another agent/user-owned file
//     without explicit authorization. This script is the explicit
//     authorization surface: the user runs it (or CI runs it on first
//     developer-machine bootstrap) and the script merges a bounded,
//     idempotent entry only.
//
// Idempotency:
//   - Reads the existing file (creates an empty one if missing).
//   - If the `soc-brain-advisor` key is already present and equal to the
//     expected entry -> no-op, exit 0.
//   - If the key is present but differs -> replaces only that key; preserves
//     every other mcpServers entry verbatim.
//   - Never writes secrets. The entry's `env` is left empty; the user
//     populates `SOC_ADVISOR_API_KEY` and friends via their own shell
//     `setx` or Windows credential store. The script prints a short
//     post-install checklist of env keys to set.
//
// Flags:
//   --dry-run   Print the resulting JSON to stdout, do not write.
//   --restore   Revert to <file>.soc-brain-advisor.bak created by a prior
//               install run; exit 0 if no backup exists.
//   --target <path>   Override target file (otherwise auto-detect).
//   --repo <abs-path> Override repo root (otherwise auto-detect from
//                     scripts/install-advisor-mcp.mjs).
//
// Exit codes:
//   0  success (or no-op / dry-run / restore).
//   1  user-target file unreadable / unwritable, or JSON malformed.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SERVER = path.join(REPO, 'packages', 'advisor-mcp', 'advisor-mcp.mjs');

const ENTRY_KEY = 'soc-brain-advisor';

function defaultTarget() {
  if (process.env.CLINE_MCP_SETTINGS) return process.env.CLINE_MCP_SETTINGS;
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
}

function parseArgs(argv) {
  const out = { dryRun: false, restore: false, target: null, repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--restore') out.restore = true;
    else if (a === '--target' && argv[i + 1]) { out.target = argv[++i]; }
    else if (a === '--repo' && argv[i + 1]) { out.repo = argv[++i]; }
    else { console.error('Unknown arg:', a); process.exit(2); }
  }
  return out;
}

function expectedEntry(repoRoot) {
  return {
    command: 'node',
    args: [path.join(repoRoot, 'packages', 'advisor-mcp', 'advisor-mcp.mjs').replace(/\//g, path.sep)],
    env: {},
    disabled: false,
  };
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function writeSettings(target, value) {
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8' });
  fs.renameSync(tmp, target);
}

function ensureNoOtherArgsChanged(orig, next) {
  if (!orig.mcpServers) return;
  for (const k of Object.keys(orig.mcpServers)) {
    if (k === ENTRY_KEY) continue;
    if (!deepEqual(orig.mcpServers[k], next.mcpServers[k])) {
      throw new Error(`Refusing to modify other mcpServers entry: ${k}`);
    }
  }
}

function restore(target) {
  const bak = target + '.soc-brain-advisor.bak';
  if (!fs.existsSync(bak)) { console.log('No backup to restore:', bak); return; }
  fs.copyFileSync(bak, target);
  console.log('Restored', target, 'from', bak);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = args.repo || REPO;
  const target = args.target || defaultTarget();
  if (args.restore) { restore(target); return; }

  if (!fs.existsSync(SERVER)) {
    throw new Error(`advisor-mcp.mjs not found at ${SERVER}; pass --repo <abs-path> if running outside the repo.`);
  }
  if (!fs.existsSync(path.dirname(target))) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }

  const orig = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : { mcpServers: {} };
  const next = JSON.parse(JSON.stringify(orig));
  if (!next.mcpServers || typeof next.mcpServers !== 'object') next.mcpServers = {};

  const expected = expectedEntry(repoRoot);
  const current = next.mcpServers[ENTRY_KEY];
  if (current && deepEqual(current, expected)) {
    console.log('NOOP soc-brain-advisor already registered with identical entry:', target);
    return;
  }
  next.mcpServers[ENTRY_KEY] = expected;
  ensureNoOtherArgsChanged(orig, next);

  if (args.dryRun) {
    console.log(JSON.stringify(next, null, 2));
    return;
  }

  if (fs.existsSync(target)) {
    fs.copyFileSync(target, target + '.soc-brain-advisor.bak');
  }
  writeSettings(target, next);
  console.log('INSTALLED soc-brain-advisor at', target);
  console.log('Backup (if any):', target + '.soc-brain-advisor.bak');
  console.log('Next steps:');
  console.log('  1. Set the provider env in your shell, e.g.:');
  console.log('       setx SOC_ADVISOR_API_KEY "<your-9router-or-openrouter-key>"');
  console.log('       setx SOC_ADVISOR_BASE_URL "http://127.0.0.1:20128/v1"');
  console.log('     (Open PowerShell as the same user that runs Cline; restart VS Code.)');
  console.log('  2. Verify discovery from a fresh Cline session:');
  console.log('       > /mcp');
  console.log('     soc-brain-advisor should appear in the list with 3 tools.');
  console.log('  3. To uninstall / revert: `node scripts/install-advisor-mcp.mjs --restore`.');
}

try { main(); }
catch (e) { console.error('INSTALL_FAILED:', e.message); process.exit(1); }

