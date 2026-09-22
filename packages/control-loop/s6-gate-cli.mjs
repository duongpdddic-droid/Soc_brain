#!/usr/bin/env node
// s6-gate-cli.mjs — CLI interface for the Stage S6 Human Merge Gate.
//
// Usage:
//   node packages/control-loop/s6-gate-cli.mjs --session <path> --action <approve|reject> [--dry-run]
//
// Flags:
//   --session <path>   Path to the session JSON file (required)
//   --action <action>  Human decision: "approve" or "reject" (required)
//   --dry-run          Validate prerequisites but do not execute the merge/block action
//   --help             Show this help message
//
// Exit codes:
//   0  — Success
//   1  — Fail-Closed error (any validation or execution failure)
//
// This CLI is the entrypoint for Stage S6. It delegates to the core
// s6-human-gate.mjs module for prerequisite validation and decision execution.

import fs from 'node:fs';
import path from 'node:path';
import { validateMergePrerequisites, executeHumanDecision } from './s6-human-gate.mjs';
import { identityHash } from '../workspace/workspace.mjs';

// ---- Argument parsing -------------------------------------------------------
function parseArgs(argv) {
  const args = { flags: {} };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.flags.help = true;
    } else if (arg === '--dry-run') {
      args.flags.dryRun = true;
    } else if (arg === '--session') {
      i++;
      args.flags.session = argv[i] || null;
    } else if (arg === '--action') {
      i++;
      args.flags.action = argv[i] || null;
    } else if (arg.startsWith('-')) {
      process.stderr.write(`Unknown flag: ${arg}\n`);
      process.exit(1);
    }
  }

  return args;
}

function showHelp() {
  const help = `Stage S6 Human Merge Gate CLI

Usage:
  node packages/control-loop/s6-gate-cli.mjs --session <path> --action <approve|reject> [--dry-run]

Flags:
  --session <path>   Path to the session JSON file (required)
  --action <action>  Human decision: "approve" or "reject" (required)
  --dry-run          Validate prerequisites but do not execute the merge/block action
  --help             Show this help message

Exit codes:
  0  — Success
  1  — Fail-Closed error (any validation or execution failure)
`;
  process.stdout.write(help);
}

// ---- Normalize action -------------------------------------------------------
function normalizeAction(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const lower = raw.toLowerCase().trim();
  if (lower === 'approve' || lower === 'approve_and_merge') return 'APPROVE_AND_MERGE';
  if (lower === 'reject' || lower === 'reject_and_block') return 'REJECT_AND_BLOCK';
  return null;
}

// ---- Main -------------------------------------------------------------------
function main() {
  const parsed = parseArgs(process.argv);
  const { flags } = parsed;

  if (flags.help) {
    showHelp();
    process.exit(0);
  }

  // Validate required flags
  if (!flags.session) {
    process.stderr.write('Error: --session <path> is required\n');
    process.exit(1);
  }

  const action = normalizeAction(flags.action);
  if (!action) {
    process.stderr.write(`Error: --action must be "approve" or "reject" (got: ${flags.action ?? 'undefined'})\n`);
    process.exit(1);
  }

  // Resolve session path to absolute
  const sessionPath = path.resolve(flags.session);
  if (!fs.existsSync(sessionPath)) {
    process.stderr.write(`Error: session file not found: ${sessionPath}\n`);
    process.exit(1);
  }

  // Derive stateDir from session path: <stateDir>/sessions/<hash>.json -> <stateDir>
  const stateDir = path.dirname(path.dirname(sessionPath));

  // Compute identityHash from the session file
  let sessionData;
  try {
    sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`Error: failed to parse session file: ${String((e && e.message) || e)}\n`);
    process.exit(1);
  }

  const id = identityHash({ repo: sessionData.repo, issueNumber: sessionData.issueNumber });
  if (!id) {
    process.stderr.write('Error: failed to compute identityHash from session\n');
    process.exit(1);
  }

  // Dry-run: only validate prerequisites
  if (flags.dryRun) {
    const result = validateMergePrerequisites({ sessionPath, stateDir, identityHash: id });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.ok ? 0 : 1);
  }

  // Execute the decision
  const result = executeHumanDecision({ action, sessionPath, stateDir, identityHash: id });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.ok ? 0 : 1);
}

// Handle top-level errors
try {
  main();
} catch (e) {
  process.stderr.write(`Fatal error: ${String((e && e.message) || e)}\n`);
  process.exit(1);
}

// end of s6-gate-cli.mjs
