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
import { spawnSync } from 'node:child_process';
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
import { dispatchLifecycleEvent } from '../packages/telegram-dispatch/telegram-dispatch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

export const HUMAN_GATE_DELIVERY_CODE = 'HUMAN_GATE_AWAITING_MERGE';
export const SOC_CONTROL_RUNNER_SCHEMA_VERSION = '1';
// Issue #9000021: canonical human-gate lifecycle event (string enum member of
// NOTIFIABLE_EVENTS — not a named export of telegram-dispatch).
const HUMAN_GATE_EVENT = 'HUMAN_GATE_REQUIRED';

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
    if (a === '--telegram-config') { out.telegramConfigPath = argv[++i] ?? null; continue; }
    if (a === '--telegram-spawn') { out.telegramSpawn = argv[++i] ?? null; continue; }
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

// ---- Auto-export PR diff for the review payload (R5 / S4) -------------------
// Best-effort, offline-safe: run `git diff origin/main...HEAD` in the bound
// worktree and write artifacts/diffs/pr-<PR>-changes.diff under PROJECT_ROOT
// so createReviewPayload can package it. Fail-closed only when the session
// already carries a positive prNumber but the export throws — a missing
// prNumber (fixtures / pre-publish sessions) is a silent no-op.
function exportReviewDiff({ session, projectRoot = PROJECT_ROOT } = {}) {
  if (!session || !Number.isInteger(session.prNumber) || session.prNumber <= 0) return null;
  const worktree = typeof session.worktreePath === 'string' ? session.worktreePath : null;
  if (!worktree || !fs.existsSync(worktree)) return null;
  try {
    const r = spawnSync('git', ['diff', 'origin/main...HEAD'], {
      cwd: worktree, encoding: 'utf8', windowsHide: true,
    });
    if (r.error || !Number.isInteger(r.status) || r.status !== 0) return null;
    const diff = String(r.stdout || '');
    if (!diff.trim()) return null;
    const dir = path.join(projectRoot, 'artifacts', 'diffs');
    fs.mkdirSync(dir, { recursive: true });
    const diffPath = path.join(dir, `pr-${session.prNumber}-changes.diff`);
    fs.writeFileSync(diffPath, diff, 'utf8');
    return { ok: true, diffPath, bytes: Buffer.byteLength(diff, 'utf8') };
  } catch {
    return null;
  }
}

// ---- Default Web2API final-review transport (production seam) ---------------
// Used ONLY when deps.finalReview is not injected (tests keep their mocks).
// createGeminiFinalReviewWithDiffTransport() returns async transport({prompt})
// -> {ok, text}; the runner wraps the raw VERDICT line through
// normalizeReviewDecision so the FSM always sees a canonical decision shape.
async function defaultWeb2ApiFinalReview({ reviewPrompt, session }) {
  try {
    const mod = await import('../packages/control-loop/gemini-plus-web2api-copy.mjs');
    const make = mod.createGeminiFinalReviewWithDiffTransport
      || mod.createGeminiFinalReviewFallbackTransport;
    if (typeof make !== 'function') return { ok: false, code: 'NO_FINAL_REVIEW' };
    const transport = await make({ timeoutMs: 300000 });
    if (typeof transport !== 'function') return { ok: false, code: 'NO_FINAL_REVIEW' };
    // Prefer the freshly built review prompt; fall back to a minimal identity
    // prompt when the diff export is unavailable (offline / no prNumber).
    const prompt = typeof reviewPrompt === 'string' && reviewPrompt.trim()
      ? reviewPrompt
      : [
          'FINAL REVIEW — Soc_brain Control Loop',
          `repository: ${session && session.repo}`,
          `issue: ${session && session.issueNumber}`,
          `pullRequest: #${session && session.prNumber}`,
          `headSha: ${session && session.headSha}`,
          '',
          'Return the FINAL LINE exactly one of:',
          'VERDICT: APPROVED',
          'VERDICT: CHANGES_REQUESTED',
          'VERDICT: BLOCKED',
        ].join('\n');
    const t = await transport({ prompt });
    if (!t || t.ok !== true) return { ok: false, code: (t && t.code) || 'FINAL_REVIEW_TRANSPORT_FAILED', detail: t ?? null };
    return { ok: true, value: { text: String(t.text || '') } };
  } catch (e) {
    return { ok: false, code: 'FINAL_REVIEW_TRANSPORT_THROW', detail: String((e && e.message) || e) };
  }
}

// ---- Result interpretation ---------------------------------------------------
// Convert the control-loop's DELIVER_STEP_FAILED + HUMAN_GATE marker into a
// clean success stop at DELIVERING when humanGate mode is on. Also fires the
// canonical HUMAN_GATE_REQUIRED Telegram notice carrying the PowerShell gate
// command (fail-safe: never throws, never changes the FSM result).
function interpretResult({ result, stateDir, id, humanGate, session = null, sessionPath = null, deps = {} }) {
  if (result && result.ok === true) return result;
  if (!humanGate || !result || result.code !== 'DELIVER_STEP_FAILED') return result;
  const detail = result.detail;
  const marker = detail && typeof detail === 'object' && detail.code === HUMAN_GATE_DELIVERY_CODE;
  if (!marker) return result;
  const ledger = readTransitions({ stateDir, identityHash: id });
  const last = ledger[ledger.length - 1];
  if (!last || last.to !== 'DELIVERING') return result;
  // Best-effort human-gate Telegram notice with the exact PowerShell command.
  // Idempotent via the dispatch ledger (API_ACCEPTED dedupe); a transport
  // failure only records NOT_ATTEMPTED/DELIVERY_FAILED and the result stands.
  if (session && sessionPath) {
    try {
      const gateCmd = `node packages/control-loop/s6-gate-cli.mjs --session "${sessionPath}" --action approve`;
      const note = [
        `Human Gate AWAITING_MERGE for ${session.repo}#${session.issueNumber}.`,
        `PowerShell: ${gateCmd}`,
        'MCP: soc.authorize_merge { repo, issueNumber, pullRequest, reviewedHeadSha, authorizedBy, clientRequestId }',
        'Merge requires BOTH a validated GPT PASS and this explicit human authorization.',
      ].join('\n');
      dispatchLifecycleEvent({
        session,
        event: HUMAN_GATE_EVENT,
        stateDir,
        allowNonCanonicalStateRoot: true,
        note,
        ...(deps.telegramSpawn ? { spawn: deps.telegramSpawn } : {}),
        ...(deps.telegramConfigPath ? { configPath: deps.telegramConfigPath } : {}),
      });
    } catch { /* fail-safe: gate result is already computed */ }
  }
  return ok({
    state: 'DELIVERING',
    awaitingHumanGate: true,
    humanGate: 'AWAITING_MERGE',
    decision: last.evidence ?? null,
    boundary: { from: last.from, to: last.to, reason: last.reason ?? null },
    ...(sessionPath ? {
      gateCommand: `node packages/control-loop/s6-gate-cli.mjs --session "${sessionPath}" --action approve`,
    } : {}),
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
  // Diff is re-exported here so the payload always reflects the CURRENT head
  // (the publish chain may have advanced prNumber/headSha since session load).
  exportReviewDiff({ session });
  let reviewPrompt = await buildReviewPromptForSession({ session });

  // Assemble deps: caller-injected mocks win; production defaults fill gaps.
  const finalReviewInner = deps.finalReview
    || ((ctx) => defaultWeb2ApiFinalReview({ ...ctx, session }));
  const finalReview = async (ctx) => {
    // Re-read the session before every final review: prNumber/headSha are
    // only bound after the publish chain (refresh/push/PR-bind), which runs
    // INSIDE runControlLoop — the startup snapshot is stale by review time.
    let live = session;
    try {
      const raw = fs.readFileSync(sessionPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') live = parsed;
    } catch { /* keep startup snapshot */ }
    exportReviewDiff({ session: live });
    reviewPrompt = await buildReviewPromptForSession({ session: live }) ?? reviewPrompt;
    const r = await finalReviewInner({ ...ctx, reviewPrompt, session: live });
    // Normalize any raw text/structured verdict through verdict-parser so the
    // runner surface always sees a canonical FSM decision shape.
    if (r && r.ok === true && r.value !== undefined) {
      const nd = normalizeReviewDecision({ decision: r.value, session: live });
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
  return interpretResult({ result, stateDir, id, humanGate, session, sessionPath, deps });
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
  --telegram-config <p>   Telegram config JSON path (optional)
  --telegram-spawn <cmd>  Telegram spawn command override (optional)
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
    deps: {
      ...(args.telegramConfigPath ? { telegramConfigPath: args.telegramConfigPath } : {}),
      ...(args.telegramSpawn ? { telegramSpawn: args.telegramSpawn } : {}),
      // Issue #9000021: production always enables granular milestone telemetry
      // on its own seam (null -> dispatchLifecycleEvent spawnSync default).
      // Explicitly set (even to null) so the onMilestone opt-in gate passes;
      // tests that never set milestoneSpawn stay silent on this channel.
      milestoneSpawn: args.telegramSpawn ?? null,
    },
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
