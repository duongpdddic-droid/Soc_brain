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
import { buildReviewPromptForSession } from '../packages/control-loop/review-payload.mjs';
import { createGeminiWeb2ApiReviewTransport } from '../packages/control-loop/gemini-plus-web2api-copy.mjs';
import { createCdpSupervisor } from '../packages/control-loop/cdp-supervisor.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { ingestGoalViaBootstrapper } from '../packages/control-loop/task-ingestion.mjs';

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
    telegramConfigPath: null, telegramSpawn: null,
    instructionFile: null, bootstrap: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--no-human-gate') { out.humanGate = false; continue; }
    if (a === '--human-gate') { out.humanGate = true; continue; }
    if (a === '--bootstrap') { out.bootstrap = true; continue; }
    if (a === '--no-bootstrap') { out.bootstrap = false; continue; }
    if (a === '--repo') { out.repo = argv[++i] ?? null; continue; }
    if (a === '--issue') {
      const n = Number.parseInt(argv[++i], 10);
      out.issue = Number.isInteger(n) && n > 0 ? n : null;
      continue;
    }
    if (a === '--goal') { out.goal = argv[++i] ?? null; continue; }
    if (a === '--instruction-file' || a === '-f') { out.instructionFile = argv[++i] ?? null; continue; }
    if (a === '--state-dir') { out.stateDir = argv[++i] ?? null; continue; }
    if (a === '--telegram-config') { out.telegramConfigPath = argv[++i] ?? null; continue; }
    if (a === '--telegram-spawn') { out.telegramSpawn = argv[++i] ?? null; continue; }
  }
  return out;
}

// ---- Instruction file loading (--instruction-file / -f) ----------------------
// Windows/PowerShell-safe ingestion of long multi-line surgical task prompts:
// the full UTF-8 file content becomes `instruction`; a short `goal` is derived
// from the first heading (or first non-empty line) when --goal is omitted.
// Fail-closed: a missing/unreadable path returns INSTRUCTION_FILE_NOT_FOUND.
export function loadInstructionFile(filePath) {
  if (typeof filePath !== 'string' || !filePath) {
    return fail('INSTRUCTION_FILE_INVALID', 'instruction file path is required');
  }
  if (!fs.existsSync(filePath)) {
    return fail('INSTRUCTION_FILE_NOT_FOUND', filePath);
  }
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return fail('INSTRUCTION_FILE_UNREADABLE', String((e && e.message) || e));
  }
  let derivedGoal = null;
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(t);
    derivedGoal = (heading && heading[1].trim()) ? heading[1].trim() : t;
    break;
  }
  return ok({ instruction: content, goal: derivedGoal });
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
  repo, issueNumber, goal = null, instruction = null,
  stateDir = defaultStateDir(),
  humanGate = true,
  bootstrap = false,
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

  // ---- Task ingestion (PR #229): auto-invoke the Task Bootstrapper ---------
  // When a NEW Goal arrives with --bootstrap, the control loop itself spawns
  // scripts/Invoke-SocTask.ps1 (safe PowerShell flags), parses PR/branch/
  // worktree from BOOTSTRAP_OK, and assigns them onto the Session lease —
  // no manual operator bootstrap. Fail-closed: any bootstrapper error stops
  // the intake HERE with a structured BOOTSTRAP_*/SESSION_* code; the FSM
  // never starts on a failed ingestion.
  if (bootstrap) {
    if (typeof goal !== 'string' || !goal.trim()) {
      return fail('BOOTSTRAP_GOAL_REQUIRED', '--bootstrap requires a non-empty --goal');
    }
    const ing = await ingestGoalViaBootstrapper({
      goal,
      issueNumber,
      sessionPath,
      stateDir,
      repo,
      projectRoot: PROJECT_ROOT,
      spawnImpl: typeof deps.spawnBootstrapper === 'function' ? deps.spawnBootstrapper : null,
      scriptPath: deps.bootstrapperScriptPath || null,
      host: deps.bootstrapperHost || null,
      cwd: deps.bootstrapperCwd || null,
      env: deps.bootstrapperEnv || null,
      base: deps.bootstrapperBase,
      repoRoot: deps.bootstrapperRepoRoot || null,
      worktreesRoot: deps.bootstrapperWorktreesRoot || null,
      timestamp: deps.bootstrapperTimestamp || null,
      pullRequestNumber: deps.bootstrapperPullRequestNumber ?? null,
      dryRun: deps.bootstrapperDryRun === true,
    });
    if (!ing.ok) return fail(ing.code, ing.detail);
    // Re-read the authoritative session after the ownership-safe assignment.
    try { session = JSON.parse(fs.readFileSync(sessionPath, 'utf8')); } catch (e) {
      return fail('SESSION_READ_FAILED', String(e));
    }
  }

  // Build artifact bundle info for review payload
  const bundleInfo = buildBundleInfo({ prNumber: session.prNumber, stateDir });

  // Assemble deps: caller-injected mocks win; production default is lazy —
  // only constructed on first real review call (no CDP/browser work when a
  // mock deps.finalReview is injected or no review step ever runs).
  // Default final reviewer: ensure Chrome+Gemini target via CDP supervisor
  // (port 9222, fail-closed BLOCKED if supervisor/target unavailable), then
  // Gemini Web2API with CDP polling.
  let defaultFinalReview = null;
  let cdpSupervisor = null;
  const finalReviewInner = deps.finalReview || (async (innerCtx) => {
    if (!defaultFinalReview) {
      cdpSupervisor = createCdpSupervisor({
        port: 9222,
        log: (msg) => console.log(`[cdp-supervisor] ${msg}`),
      });
      const chrome = await cdpSupervisor.ensureChromeRunning();
      if (!chrome.ok) {
        return {
          ok: false,
          code: chrome.code || 'CDP_SUPERVISOR_UNAVAILABLE',
          verdict: 'BLOCKED',
          detail: chrome.error || null,
        };
      }
      const target = await cdpSupervisor.ensureTargetPage({
        urlPattern: /gemini\.google\.com/,
        defaultUrl: 'https://gemini.google.com',
      });
      if (!target.ok) {
        return {
          ok: false,
          code: target.code || 'CDP_TARGET_UNAVAILABLE',
          verdict: 'BLOCKED',
          detail: target.error || null,
        };
      }
      defaultFinalReview = await createGeminiWeb2ApiReviewTransport({
        cdpPort: 9222,
        host: '127.0.0.1',
        log: (msg) => console.log(`[gemini-review] ${msg}`),
      });
    }
    return defaultFinalReview(innerCtx);
  });
  const finalReview = async (ctx) => {
    // Best-effort standardized prompt packaging (test evidence + bundle info).
    // Degrades to null offline (missing diff) — the transport then fail-closes.
    let reviewPrompt = null;
    try {
      const built = buildReviewPromptForSession({
        session: { ...session, repo, issueNumber, goal },
        testLog: ctx.testLog || '',
        bundleInfo,
        diff: ctx.diff || '',
      });
      if (built && built.ok === true) reviewPrompt = built.prompt;
    } catch { reviewPrompt = null; }

    const r = await finalReviewInner({
      ...ctx,
      reviewPrompt,
      prompt: reviewPrompt,
      session: { ...session, repo, issueNumber, goal },
      testLog: ctx.testLog || '',
      bundleInfo,
      diff: ctx.diff || '',
    });
    // Normalize any raw text/structured verdict through verdict-parser so the
    // runner surface always sees a canonical FSM decision shape.
    // Handles both the standardized transport shape { ok, verdict, rawText, ... }
    // (no `value`) and the legacy wrapper shape { ok, value: { text | verdict } }.
    if (r && r.ok === true) {
      const decisionPayload = r.value !== undefined ? r.value : r;
      const nd = normalizeReviewDecision({ decision: decisionPayload, session });
      if (nd.ok) return { ok: true, value: nd.value };
      return { ok: false, code: nd.code, detail: nd.detail };
    }
    return r;
  };

  const runDeps = {
    reviewReadyDir: path.join(stateDir, 'review-ready'),
    // Full --instruction-file content carried on the run payload (session/task
    // init context) so downstream adapters/telemetry can observe it. Explicit
    // caller-injected deps.instruction still wins on collision.
    ...(instruction != null ? { instruction } : {}),
    ...deps,
    finalReview,
    // Production default: wire the 6 granular FSM milestone Telegram events
    // (ROUTED→DELIVERING). Callers may still override via deps.telegramMilestones.
    telegramMilestones: deps.telegramMilestones !== false,
    ...(humanGate ? { delivery: humanGateDeliveryAdapter() } : {}),
  };

  const result = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: runDeps });
  return interpretResult({ result, stateDir, id, humanGate });
}

/**
 * Build artifact bundle info for review payload verification
 */
function buildBundleInfo({ prNumber, stateDir }) {
  const PROJECT_ROOT = path.resolve(__dirname, '..');
  const diffsDir = path.join(PROJECT_ROOT, 'artifacts', 'diffs');
  const diffPath = path.join(diffsDir, `pr-${prNumber}-changes.diff`);
  const zipPath = path.join(diffsDir, `pr-${prNumber}-diff.zip`);

  const info = {};
  if (fs.existsSync(diffPath)) {
    info.diffPath = diffPath;
    info.diffSize = fs.statSync(diffPath).size;
  }
  if (fs.existsSync(zipPath)) {
    info.zipPath = zipPath;
    info.zipSize = fs.statSync(zipPath).size;
  }
  return info;
}

// ---- CLI entry ----------------------------------------------------------------
const USAGE = `soc-control-loop.mjs — soc_control orchestrator runner

Usage:
  node bin/soc-control-loop.mjs --repo <owner/name> --issue <N> [--goal "..."] [--instruction-file <path>] [--state-dir <dir>] [--no-human-gate] [--bootstrap]

Options:
  --repo <owner/name>        target repository (required)
  --issue <N>                issue number (required)
  --goal "<text>"            task goal (metadata only; auto-derived from --instruction-file heading when omitted)
  --instruction-file <path>  read full multi-line task instruction from a UTF-8 file (alias: -f)
  -f <path>                  alias for --instruction-file
  --state-dir <dir>          control-plane state dir (default: ~/.soc-brain/state)
  --human-gate               stop at DELIVERING on APPROVED (default)
  --no-human-gate            allow full delivery through COMPLETED
  --bootstrap                auto-invoke scripts/Invoke-SocTask.ps1 for a new Goal and assign PR/branch/worktree to the session (fail-closed)
  --no-bootstrap             disable bootstrapper intake (default)
  --help                     show this help
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  // Instruction-file ingestion (fail-closed): missing/unreadable path exits 1
  // with INSTRUCTION_FILE_NOT_FOUND before any session/loop work starts.
  let instruction = null;
  let goal = args.goal;
  if (args.instructionFile) {
    const loaded = loadInstructionFile(args.instructionFile);
    if (!loaded.ok) {
      process.stdout.write(`${JSON.stringify(loaded, null, 2)}\n`);
      process.exit(1);
    }
    instruction = loaded.value.instruction;
    if (goal == null) goal = loaded.value.goal;
  }

  if (!args.repo || !args.issue) {
    process.stdout.write(USAGE);
    process.exit(2);
  }

  const result = await runSocControlLoop({
    repo: args.repo,
    issueNumber: args.issue,
    goal,
    instruction,
    stateDir: args.stateDir || defaultStateDir(),
    humanGate: args.humanGate,
    bootstrap: args.bootstrap,
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
