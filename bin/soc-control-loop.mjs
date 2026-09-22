#!/usr/bin/env node
// bin/soc-control-loop.mjs — soc_control orchestrator runner CLI.
//
// Integrates the three core modules:
//   - packages/control-loop/control-loop.mjs   (FSM engine)
//   - packages/control-loop/verdict-parser.mjs (text/structured verdict -> FSM)
//   - packages/control-loop/review-payload.mjs (prompt/diff packaging)
//
// Human Gate contract:
//   - APPROVED  -> stop at DELIVERING (await explicit human merge authorization)
//   - CHANGES_REQUESTED -> auto re-dispatch REWORK (bounded by control-loop)
//   - BLOCKED / unparseable -> fail closed, no terminal transition
//
// Offline-safe: every dep (executor/reviewer/telegram) is injectable. The CLI
// main() wires production adapters; tests import runSocControlLoop() with mocks.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runControlLoop,
  readTransitions,
} from '../packages/control-loop/control-loop.mjs';
import {
  normalizeReviewDecision,
  REVIEW_VERDICT_TO_FSM,
} from '../packages/control-loop/verdict-parser.mjs';
import { createReviewPayload } from '../packages/control-loop/review-payload.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

export const HUMAN_GATE_DELIVERY_CODE = 'HUMAN_GATE_AWAITING_MERGE';
export const SOC_CONTROL_RUNNER_SCHEMA_VERSION = '1';

function ok(value, extra = {}) { return { ok: true, value, ...extra }; }
function fail(code, detail) { return { ok: false, code, detail: detail ?? null }; }

function defaultStateDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.USERPROFILE || 'C:\\Users\\Admin', '.soc-brain', 'state');
  }
  return path.join(process.env.HOME || '/root', '.soc-brain', 'state');
}

// ---- CLI argument parsing ---------------------------------------------------
export function parseArgs(argv = []) {
  const out = {
    repo: null, issue: null, goal: null, stateDir: null,
    humanGate: true, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--no-human-gate') { out.humanGate = false; continue; }
    if (a === '--human-gate') { out.humanGate = true; continue; }
    if (a === '--repo') { out.repo = argv[++i] ?? null; continue; }
    if (a === '--issue') {
      const n = Number.parseInt(argv[++i], 10);
      out.issue = Number.isInteger(n) && n > 0 ? n : null;
      continue;
    }
    if (a === '--goal') { out.goal = argv[++i] ?? null; continue; }
    if (a === '--state-dir') { out.stateDir = argv[++i] ?? null; continue; }
  }
  return out;
}

// ---- Human Gate delivery adapter --------------------------------------------
// Returns a fail-closed marker so runControlLoop stops at the DELIVERING
// boundary (READY_FOR_REVIEW notification already recorded) without merging.
function humanGateDeliveryAdapter() {
  return async function delivery() {
    return {
      ok: false,
      code: HUMAN_GATE_DELIVERY_CODE,
      detail: 'awaiting explicit human merge authorization (S5/S6 Human Gate)',
    };
  };
}

// ---- Review payload packaging (best-effort, offline-safe) -------------------
async function buildReviewPromptForSession({ session }) {
  if (!session || !Number.isInteger(session.prNumber) || session.prNumber <= 0) return null;
  if (typeof session.headSha !== 'string' || session.headSha.length !== 40) return null;
  try {
    const payload = await createReviewPayload({
      prNumber: session.prNumber,
      headSha: session.headSha,
      contextMetadata: {
        repository: session.repo,
        issueNumber: session.issueNumber,
      },
    });
    if (payload && payload.ok === true && typeof payload.prompt === 'string') return payload.prompt;
    return null;
  } catch {
    return null; // missing diff file or offline — degrade gracefully
  }
}

// ---- Result interpretation ---------------------------------------------------
// Convert the control-loop's DELIVER_STEP_FAILED + HUMAN_GATE marker into a
// clean success stop at DELIVERING when humanGate mode is on.
function interpretResult({ result, stateDir, id, humanGate }) {
  if (result && result.ok === true) return result;
  if (!humanGate || !result || result.code !== 'DELIVER_STEP_FAILED') return result;
  const detail = result.detail;
  const marker = detail && typeof detail === 'object' && detail.code === HUMAN_GATE_DELIVERY_CODE;
  if (!marker) return result;
  const ledger = readTransitions({ stateDir, identityHash: id });
  const last = ledger[ledger.length - 1];
  if (!last || last.to !== 'DELIVERING') return result;
  return ok({
    state: 'DELIVERING',
    awaitingHumanGate: true,
    humanGate: 'AWAITING_MERGE',
    decision: last.evidence ?? null,
    boundary: { from: last.from, to: last.to, reason: last.reason ?? null },
  });
}

// ---- Main orchestration -------------------------------------------------------
export async function runSocControlLoop({
  repo, issueNumber, goal = null,
  stateDir = defaultStateDir(),
  humanGate = true,
  deps = {},
} = {}) {
  if (typeof repo !== 'string' || !repo) return fail('ARGS_INVALID', 'repo is required');
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return fail('ARGS_INVALID', 'issueNumber must be a positive integer');
  }

  const id = identityHash({ repo, issueNumber });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  if (!fs.existsSync(sessionPath)) return fail('SESSION_NOT_FOUND', sessionPath);

  let session = null;
  try { session = JSON.parse(fs.readFileSync(sessionPath, 'utf8')); } catch (e) {
    return fail('SESSION_READ_FAILED', String(e));
  }

  // Best-effort review prompt packaging (review-payload integration).
  const reviewPrompt = await buildReviewPromptForSession({ session });

  // Assemble deps: caller-injected mocks win; production defaults fill gaps.
  const finalReviewInner = deps.finalReview || (() => ({ ok: false, code: 'NO_FINAL_REVIEW' }));
  const finalReview = async (ctx) => {
    const r = await finalReviewInner({ ...ctx, reviewPrompt });
    // Normalize any raw text/structured verdict through verdict-parser so the
    // runner surface always sees a canonical FSM decision shape.
    if (r && r.ok === true && r.value !== undefined) {
      const nd = normalizeReviewDecision({ decision: r.value, session });
      if (nd.ok) return { ok: true, value: nd.value };
      return { ok: false, code: nd.code, detail: nd.detail };
    }
    return r;
  };

  const runDeps = {
    reviewReadyDir: path.join(stateDir, 'review-ready'),
    ...deps,
    finalReview,
    ...(humanGate ? { delivery: humanGateDeliveryAdapter() } : {}),
  };

  const result = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: runDeps });
  return interpretResult({ result, stateDir, id, humanGate });
}

// ---- CLI entry ----------------------------------------------------------------
const USAGE = `soc-control-loop.mjs — soc_control orchestrator runner

Usage:
  node bin/soc-control-loop.mjs --repo <owner/name> --issue <N> [--goal "..."] [--state-dir <dir>] [--no-human-gate]

Options:
  --repo <owner/name>     target repository (required)
  --issue <N>             issue number (required)
  --goal "<text>"         task goal (metadata only)
  --state-dir <dir>       control-plane state dir (default: ~/.soc-brain/state)
  --human-gate            stop at DELIVERING on APPROVED (default)
  --no-human-gate         allow full delivery through COMPLETED
  --help                  show this help
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.repo || !args.issue) {
    process.stdout.write(USAGE);
    process.exit(args.help ? 0 : 2);
  }
  const result = await runSocControlLoop({
    repo: args.repo,
    issueNumber: args.issue,
    goal: args.goal,
    stateDir: args.stateDir || defaultStateDir(),
    humanGate: args.humanGate,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok === true ? 0 : 1);
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`soc-control-loop: ${String((e && e.message) || e)}\n`);
    process.exit(1);
  });
}
