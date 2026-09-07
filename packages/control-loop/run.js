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
import fs from 'node:fs';
import path from 'node:path';
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
  summarizePhaseLatency,
  CONTROL_LOOP_CANONICAL_REPO,
} from './control-loop.mjs';
import { packetPathFor } from './adapters.mjs';
// Issue #92 (P1-1): default review-eval sink — persistent review evaluation
// store under the loop's own stateDir/identityHash.
import {
  appendReviewEvaluation,
  readReviewEvaluations,
  compareReviewEvaluations,
} from '../review-eval/review-eval.mjs';
import {
  executorRouter,
  launchExecutorAdapter,
  deterministicVerifierAdapter,
  geminiPreReviewAdapter,
  gptFinalReviewAdapter,
  buildDeliveryAdapter,
} from './adapters.mjs';

const args = parseArgs({
  args: process.argv.slice(2),
  options: {
    issue: { type: 'string' },
    instruction: { type: 'string' },
    repo: { type: 'string', default: 'duongpdddic-droid/Soc_brain' },
    'dry-run': { type: 'boolean', default: true },
    // Issue #83 (P0-G): the documented launch command uses --no-dry-run, but
    // node:util parseArgs (strict) rejects unknown `--no-X` for `--X` on Node
    // 22 (ERR_PARSE_ARGS_UNKNOWN_OPTION) and `--dry-run=false` is invalid for
    // boolean options (ERR_PARSE_ARGS_INVALID_OPTION_VALUE). Declare the
    // explicit negation so the canonical launch command parses for real runs.
    // Issue #83 (P0-G): --resume binds the EXISTING canonical session for this
    // identity instead of pinning baseSha to the current origin/main (which
    // drifts once the task's own PR lands). The delivery ledger is exactly-once,
    // so a resume from a DELIVERING/BLOCKED tail can never double-merge or
    // double-terminalize; this flag only lets taskStart's drift guard compare
    // against the session's own recorded base.
    resume: { type: 'boolean', default: false },
    'no-dry-run': { type: 'boolean', default: false },
  },
});

const dryRun = args.values['no-dry-run'] === true ? false : args.values['dry-run'];

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
if (!dryRun && typeof args.values.instruction !== 'string') {
  console.error(JSON.stringify({ ok: false, code: 'MISSING_INSTRUCTION', detail: '--instruction is required with --no-dry-run' }));
  process.exit(2);
}

const stateDir = defaultStateDir();
const worktreesRoot = defaultWorktreesRoot();

// Step 1: canonical session (taskStart owns worktree provisioning + evidence).
// --resume: the authoritative base is the PERSISTED session's baseSha, not the
// current origin/main — once this task's PR has landed, origin/main moves and
// the drift guard would refuse the exactly-once delivery resume.
const identityId = identityHash({ repo, issueNumber });
const identitySessionPath = sessionPathFor({ stateDir, identityHash: identityId });
let baseSha = null;
if (args.values.resume && fs.existsSync(identitySessionPath)) {
  try { baseSha = JSON.parse(fs.readFileSync(identitySessionPath, 'utf8')).baseSha || null; } catch { baseSha = null; }
}
if (!baseSha) {
  baseSha = execCapture(['git', '-C', process.cwd(), 'rev-parse', 'origin/main']);
}
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
// Gemini pre-review (P0-C) and GPT final review (P0-D) are real transports when
// their env trigger is present, fail-closed seams otherwise.
const { createGeminiTransport } = await import('./gemini-transport.mjs');
const geminiTransport = process.env.GEMINI_API_KEY
  ? createGeminiTransport({}) // native REST wire protocol only (x-goog-api-key); semantics live in gemini-pre-review.mjs
  : null; // fail-closed NO_GEMINI_TRANSPORT seam when env key absent
// P0-D (Issue #77): the proven ChatGPT Web CDP transport (chatgpt-web-plus/
// cdp-inpage-backend-api, #63/#67). Soc_brain is the orchestrator and initiates
// every GPT request; enabling requires an explicit SOC_GPT_CDP_PORT (the live
// user-profile Chrome CDP endpoint). Absent env -> NO_GPT_TRANSPORT seam.
const { createChatGptWebCdpTransport } = await import('./chatgpt-web-cdp.mjs');
const gptCdpPort = Number(process.env.SOC_GPT_CDP_PORT);
const gptTransport = Number.isInteger(gptCdpPort) && gptCdpPort > 0
  ? createChatGptWebCdpTransport({ cdpPort: gptCdpPort })
  : null; // fail-closed NO_GPT_TRANSPORT seam when no CDP endpoint configured
const deps = {
  // P0-G (Issue #83): top-level pushExec activates the pre-review publish chain
  // in runControlLoop (gate: deps.pushExec !== undefined); null = real git via
  // spawnSync. buildDeliveryAdapter({ pushExec: null }) below reuses the same
  // transport for delivery's alreadyPresent push re-entry.
  pushExec: null,
  router: executorRouter({}),
  executor: launchExecutorAdapter({
    instruction: args.values.instruction,
    controlCwd: process.cwd(),
  }),
  reworkCwd: process.cwd(), // P0-E (Issue #79): rework rounds run from the same canonical control cwd
  reworkModel: null,        // P0-E: keep the routed model; set explicitly to override per rework round
  verifier: deterministicVerifierAdapter(), // P0-B (Issue #73): real deterministic verification via readExecutionRecord
  preReview: geminiPreReviewAdapter({ transport: geminiTransport, reviewReadyDir: stateDir ? path.join(stateDir, 'review-ready') : null }), // P0-C: native Gemini when key set, fail-closed seam otherwise
  finalReview: gptFinalReviewAdapter({ transport: gptTransport, reviewReadyDir: stateDir ? path.join(stateDir, 'review-ready') : null }), // P0-D: real ChatGPT Web CDP when SOC_GPT_CDP_PORT set, fail-closed seam otherwise
  // P0-F (Issue #81): canonical delivery lifecycle — Soc_brain-owned
  // PR create/read-back -> squash merge/read-back -> Issue close/read-back
  // -> main projection -> worktree cleanup, then the guarded TASK_COMPLETED
  // terminal transition. Real `gh` transport; identity/heads re-derived from
  // the canonical session record inside the adapter.
  // P0-G (Issue #83): the canonical publish chain (HEAD refresh -> push -> PR
  // adopt/create -> packet projection) is ACTIVE in real runs: pushExec: null =
  // real git via spawnSync, gh: null = real gh CLI. The PR is bound BEFORE the
  // reviewers run; delivery's ensurePr re-adopts the same session-bound PR (no
  // duplicate PR) and its push re-entry is an alreadyPresent short-circuit.
  delivery: buildDeliveryAdapter({ pushExec: null }),
  // Issue #92 (P1-1): default review-eval sink — every successful
  // preReview/finalReview step appends one evaluation record to
  // <stateDir>/review-eval/<identityHash>/evaluations.jsonl. Append errors
  // propagate; the loop failure-isolates them (evidence.evalPersisted=false,
  // FSM state/reason unchanged).
  reviewEvalSink: async ({ kind, review, reviewDurationMs }) =>
    appendReviewEvaluation({ stateDir, identityHash: id, kind, review, reviewDurationMs }),
};

// Dry-run: prove the loop binds, transitions, and refuses to terminalize
// without completing the chain — without executing anything.
if (dryRun) {
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
// Issue #92 (P1-1): non-breaking additive summary extension — phase latency
// from the ledger plus the persistent review-eval counts for this identity.
if (res && res.ok) {
  res.value.latency = summarizePhaseLatency(readTransitions({ stateDir, identityHash: id }));
  res.value.reviewEval = compareReviewEvaluations(readReviewEvaluations({ stateDir, identityHash: id }));
}
console.log(JSON.stringify(res, null, 2));

function execCapture(cmd) {
  try {
    return execFileSync(cmd[0], cmd.slice(1), { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
