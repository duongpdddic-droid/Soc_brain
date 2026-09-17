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
  CONTROL_LOOP_CANONICAL_REPO,
} from './control-loop.mjs';
import { packetPathFor } from './adapters.mjs';
import {
  executorRouter,
  launchExecutorAdapter,
  deterministicVerifierAdapter,
  gptFinalReviewAdapter,
  buildDeliveryAdapter,
} from './adapters.mjs';
// Issue #4F: the PRE_REVIEWING critical path is the REVIEW-ONLY OCR/OpenCode
// leg. The Gemini pre-review seam (gemini-pre-review.mjs +
// geminiPreReviewAdapter) is DEAD compatibility code: never imported, never
// invoked, never shadow-run here. Advisor MCP Gemini functionality outside the
// control loop is untouched.
import { reviewLegPreReviewAdapter } from './review-leg-adapter.mjs';

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
    // Issue #125: optional deterministic fast-path task descriptor (JSON).
    // Present -> classifyRoute runs at ControlLoop admission; FAST_PATH only
    // when every gate is explicitly satisfied, otherwise STANDARD_PATH.
    'fast-path-descriptor': { type: 'string' },
    // Issue #145: stable mutation-owner lane identity for this run. Two lanes
    // must use DISTINCT --lane values against the same issue: the second
    // admission fails closed (MUTATION_OWNER_CONFLICT). Omitting it keeps the
    // legacy unattributed admission (no owner recorded).
    lane: { type: 'string' },
  },
});

const dryRun = args.values['no-dry-run'] === true ? false : args.values['dry-run'];

// Issue #125: parse the optional fast-path descriptor ONCE, fail-closed on
// malformed JSON (never silently route with a half-parsed descriptor).
let fastPathDescriptor = null;
if (args.values['fast-path-descriptor']) {
  try { fastPathDescriptor = JSON.parse(args.values['fast-path-descriptor']); } catch {
    console.error(JSON.stringify({ ok: false, code: 'INVALID_FAST_PATH_DESCRIPTOR' }));
    process.exit(2);
  }
}

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
// Issue #145 rework F1: production dispatch GRANTS mutation authority, so it
// must identify the single mutation owner. A real run without --lane fails
// closed before admission (no anonymous mutation authority). Dry-run performs
// no executor dispatch and needs no lane.
if (!dryRun && !args.values.lane) {
  console.error(JSON.stringify({ ok: false, code: 'MISSING_MUTATION_LANE', detail: '--lane is required with --no-dry-run: the run becomes the single mutation owner of the canonical attempt (Issue #145).' }));
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
  ...(args.values.lane ? { mutationLaneId: args.values.lane } : {}),
});
if (!started.ok) {
  console.error(JSON.stringify({ ok: false, code: started.reason === 'MUTATION_OWNER_CONFLICT' || started.reason === 'SESSION_ALREADY_TERMINAL' ? started.reason : 'TASK_START_FAILED', detail: started.reason, owner: started.owner ?? null }));
  process.exit(2);
}

const id = identityHash({ repo, issueNumber });
const sessionPath = sessionPathFor({ stateDir, identityHash: id });

// Step 2: adapters — REAL executor transport (P0-A, Issue #71): startExecution +
// readExecutionStatus are the canonical primitives; authority (lease/binding/
// stateDir) is re-derived from the canonical session record inside the adapter.
// Pre-review is the REVIEW-ONLY OCR/OpenCode leg (Issue #4C): trusted launcher
// + detached headSha snapshot + OCR delegate preview/rule + semantic child,
// gated by the strict ReviewEvidence v1 validator. GPT final review (P0-D) is
// the real ChatGPT Web transport when configured, fail-closed seam otherwise.
// There is NO Gemini transport on this path by design (Issue #4F).
// Issue #148: the production final-review transport is the CWA browser-owned
// plane (chatgpt-web-cwa.mjs) — durable request binding, exact response
// binding, canonical reconciliation, zero blind retry, deterministic pre-write
// runtime readiness. CDP is DEMOTED to legacy: it requires BOTH
// SOC_GPT_TRANSPORT_LEGACY_CDP=1 AND SOC_GPT_CDP_PORT, is never selected by
// default, and there is no automatic fallback in either direction. Absent
// configuration -> fail-closed NO_GPT_TRANSPORT seam.
const { createChatGptWebCdpTransport } = await import('./chatgpt-web-cdp.mjs');
const { createChatGptWebCwaTransport, selectGptTransport } = await import('./chatgpt-web-cwa.mjs');
const gptCdpPort = Number(process.env.SOC_GPT_CDP_PORT);
const selection = selectGptTransport({
  env: process.env,
  cdpTransportFactory: (port) => createChatGptWebCdpTransport({ cdpPort: port }),
  cwaTransportFactory: () => createChatGptWebCwaTransport({
    sessionPath,
    storeDir: process.env.SOC_CWA_STORE_DIR || null,
  }),
});
const gptTransport = selection.transport;
if (!dryRun) {
  console.error(JSON.stringify({ ok: true, gptTransport: selection.name }));
}
const deps = {
  // P0-G (Issue #83): top-level pushExec activates the pre-review publish chain
  // in runControlLoop (gate: deps.pushExec !== undefined); null = real git via
  // spawnSync. buildDeliveryAdapter({ pushExec: null }) below reuses the same
  // transport for delivery's alreadyPresent push re-entry.
  pushExec: null,
  ...(fastPathDescriptor ? { fastPathDescriptor } : {}),
  router: executorRouter({}),
  executor: launchExecutorAdapter({
    instruction: args.values.instruction,
    controlCwd: process.cwd(),
  }),
  reworkCwd: process.cwd(), // P0-E (Issue #79): rework rounds run from the same canonical control cwd
  reworkModel: null,        // P0-E: keep the routed model; set explicitly to override per rework round
  verifier: deterministicVerifierAdapter(), // P0-B (Issue #73): real deterministic verification via readExecutionRecord
  preReview: reviewLegPreReviewAdapter({ controlRepo: process.cwd(), reviewReadyDir: stateDir ? path.join(stateDir, 'review-ready') : null }), // Issue #4C: REVIEW-ONLY OCR/OpenCode leg (strict ReviewEvidence v1); Gemini critical wiring removed (#4F)
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
console.log(JSON.stringify(res, null, 2));

function execCapture(cmd) {
  try {
    return execFileSync(cmd[0], cmd.slice(1), { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
