#!/usr/bin/env node
// run.js — ControlLoop v0 canonical entrypoint (Issue #69).
//
// Usage:
//   node packages/control-loop/run.js --issue 69 --instruction "..." [--repo duongpdddic-droid/Soc_brain]
//
// What it does:
//   1. runtime-sandbox taskStart (canonical session + worktree binding).
//   2. bindLoop + runControlLoop with library adapters from adapters.mjs.
//   3. Terminalization ONLY via loop.terminalize inside runControlLoop.
//
// What it does NOT do (v0 seams — intentionally left to the caller):
//   - No Gemini/ChatGPT transports wired (fail-closed NO_*_TRANSPORT).
//   - No Telegram config (delivery records NOT_ATTEMPTED, never blocks).

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { identityHash, defaultWorktreesRoot } from '../workspace/workspace.mjs';
import {
  taskStart,
  defaultStateDir,
  sessionPathFor,
} from '../runtime-sandbox/runtime-sandbox.mjs';
import {
  runControlLoop,
  bindLoop,
  readTransitions,
  CONTROL_LOOP_CANONICAL_REPO,
} from './control-loop.mjs';
import { packetPathFor } from './adapters.mjs';
import {
  executorRouter,
  launchExecutorAdapter,
  deterministicVerifierAdapter,
  geminiPreReviewAdapter,
  gptFinalReviewAdapter,
  telegramDeliveryAdapter,
} from './adapters.mjs';

const args = parseArgs({
  args: process.argv.slice(2),
  options: {
    issue: { type: 'string' },
    instruction: { type: 'string' },
    repo: { type: 'string', default: 'duongpdddic-droid/Soc_brain' },
    'dry-run': { type: 'boolean', default: true },
  },
});

const repo = args.values.repo;
const issueNumber = Number(args.values.issue);
if (!args.values.issue || !Number.isInteger(issueNumber) || issueNumber <= 0) {
  console.error(JSON.stringify({ ok: false, code: 'MISSING_ISSUE' }));
  process.exit(2);
}
if (repo.toLowerCase() !== CONTROL_LOOP_CANONICAL_REPO) {
  console.error(JSON.stringify({ ok: false, code: 'FOREIGN_REPO', detail: repo }));
  process.exit(2);
}
if (!args.values['dry-run'] && typeof args.values.instruction !== 'string') {
  console.error(JSON.stringify({ ok: false, code: 'MISSING_INSTRUCTION', detail: '--instruction is required with --no-dry-run' }));
  process.exit(2);
}

const stateDir = defaultStateDir();
const worktreesRoot = defaultWorktreesRoot();

// Step 1: canonical session (taskStart owns worktree provisioning + evidence).
const baseSha = execCapture(['git', '-C', process.cwd(), 'rev-parse', 'origin/main']);
if (!baseSha) {
  console.error(JSON.stringify({ ok: false, code: 'BASE_SHA_UNRESOLVED' }));
  process.exit(2);
}
const started = taskStart({
  repo,
  issueNumber,
  baseSha,
  worktreesRoot,
  stateDir,
  controlCwd: process.cwd(),
});
if (!started.ok) {
  console.error(JSON.stringify({ ok: false, code: 'TASK_START_FAILED', detail: started.reason }));
  process.exit(2);
}

const id = identityHash({ repo, issueNumber });
const sessionPath = sessionPathFor({ stateDir, identityHash: id });

// Step 2: adapters — REAL executor transport (P0-A, Issue #71): startExecution +
// readExecutionStatus are the canonical primitives; authority (lease/binding/
// stateDir) is re-derived from the canonical session record inside the adapter.
// Gemini/ChatGPT remain fail-closed seams (P0-C/P0-D).
const deps = {
  router: executorRouter({}),
  executor: launchExecutorAdapter({
    instruction: args.values.instruction,
    controlCwd: process.cwd(),
  }),
  verifier: deterministicVerifierAdapter({ verify: null }), // v0 seam: wire review-ready projection
  preReview: geminiPreReviewAdapter({ transport: null }), // v0 seam: wire Gemini native API
  finalReview: null, // v0 seam: wire ChatGPT Web CDP transport
  delivery: telegramDeliveryAdapter({ stateDir }),
};

// Dry-run: prove the loop binds, transitions, and refuses to terminalize
// without completing the chain — without executing anything.
if (args.values['dry-run']) {
  const loop = bindLoop({ sessionPath, identityHash: id, stateDir });
  const t = readTransitions({ stateDir, identityHash: id });
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    identityHash: id,
    sessionPath,
    states: loop.states,
    transitions: t.length,
    terminalizeGuard: 'session-bound token required; adapters have none',
  }));
  process.exit(0);
}

const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
console.log(JSON.stringify(res, null, 2));

function execCapture(cmd) {
  try {
    return execFileSync(cmd[0], cmd.slice(1), { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
