#!/usr/bin/env node
// bin/soc-control-loop.mjs — soc_control orchestrator runner CLI (Thin Harness).
//
// Integrates:
//   - packages/control-loop/control-loop.mjs   (FSM engine)
//   - packages/control-loop/verdict-parser.mjs (text/structured verdict -> FSM)
//   - packages/control-loop/review-payload.mjs (standardized prompt/diff packaging)
//   - packages/control-loop/advisor-payload.mjs (standardized failure/advisor consultation)
//   - packages/control-loop/gemini-plus-web2api-copy.mjs (Web2API transport)
//
// Invariants:
//   - APPROVED  -> stop at DELIVERING (await explicit human merge authorization)
//   - CHANGES_REQUESTED / BOTTLENECK -> consult Advisor/Reviewer via Web2API -> auto re-dispatch REWORK
//   - BLOCKED / unparseable -> fail closed, no terminal transition without human gate

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runControlLoop,
  readTransitions,
} from '../packages/control-loop/control-loop.mjs';
import {
  normalizeReviewDecision,
} from '../packages/control-loop/verdict-parser.mjs';
import { buildReviewPromptForSession } from '../packages/control-loop/review-payload.mjs';
import {
  buildAdvisorConsultationPrompt,
  parseAdvisorResponse,
} from '../packages/control-loop/advisor-payload.mjs';
import {
  createGeminiWeb2ApiReviewTransport,
  createGeminiWeb2ApiAdvisorTransport,
} from '../packages/control-loop/gemini-plus-web2api-copy.mjs';
import { createCdpSupervisor } from '../packages/control-loop/cdp-supervisor.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { ingestGoalViaBootstrapper } from '../packages/control-loop/task-ingestion.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

export const HUMAN_GATE_DELIVERY_CODE = 'HUMAN_GATE_AWAITING_MERGE';
export const SOC_CONTROL_RUNNER_SCHEMA_VERSION = '2';

function ok(value, extra = {}) { return { ok: true, value, ...extra }; }
function fail(code, detail) { return { ok: false, code, detail: detail ?? null }; }

function defaultStateDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.USERPROFILE || 'C:\\Users\\Admin', '.soc-brain', 'state');
  }
  return path.join(process.env.HOME || '/root', '.soc-brain', 'state');
}

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

function humanGateDeliveryAdapter() {
  return async function delivery() {
    return {
      ok: false,
      code: HUMAN_GATE_DELIVERY_CODE,
      detail: 'awaiting explicit human merge authorization (S5/S6 Human Gate)',
    };
  };
}

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

function buildBundleInfo({ prNumber }) {
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

async function createLazyWeb2ApiTransport({ port = 9222, host = '127.0.0.1' } = {}) {
  let transport = null;
  return async function dispatchReview(ctx) {
    if (!transport) {
      const cdp = createCdpSupervisor({
        port,
        log: (msg) => console.log(`[cdp-supervisor] ${msg}`),
      });
      const chrome = await cdp.ensureChromeRunning();
      if (!chrome.ok) {
        return {
          ok: false,
          code: chrome.code || 'CDP_SUPERVISOR_UNAVAILABLE',
          verdict: 'BLOCKED',
          detail: chrome.error || null,
        };
      }
      const target = await cdp.ensureTargetPage({
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
      transport = await createGeminiWeb2ApiReviewTransport({
        cdpPort: port,
        host,
        log: (msg) => console.log(`[gemini-review] ${msg}`),
      });
    }
    return transport(ctx);
  };
}

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
  let session = null;

  if (bootstrap) {
    if (typeof goal !== 'string' || !goal.trim()) {
      return fail('BOOTSTRAP_GOAL_REQUIRED', '--bootstrap requires a non-empty --goal');
    }
    // Neu file session chua ton tai truoc khi bootstrap, tao session khoi tao toi thieu
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      fs.writeFileSync(sessionPath, JSON.stringify({
        schemaVersion: '1',
        state: 'SESSION_ACTIVE',
        identityHash: id,
        repo,
        issueNumber,
        createdAt: new Date().toISOString()
      }, null, 2), 'utf8');
    }
  }

  if (!fs.existsSync(sessionPath)) return fail('SESSION_NOT_FOUND', sessionPath);

  try { session = JSON.parse(fs.readFileSync(sessionPath, 'utf8')); } catch (e) {
    return fail('SESSION_READ_FAILED', String(e));
  }

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
    try { session = JSON.parse(fs.readFileSync(sessionPath, 'utf8')); } catch (e) {
      return fail('SESSION_READ_FAILED', String(e));
    }
  }

  const bundleInfo = buildBundleInfo({ prNumber: session.prNumber, worktreePath: session.worktreePath || session.worktree });
  const defaultReviewTransport = deps.finalReview || (await createLazyWeb2ApiTransport());

  // Reviewer Transport ho tro tu dong dong goi Prompt review
  const finalReview = async (ctx) => {
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

    const r = await defaultReviewTransport({
      ...ctx,
      reviewPrompt,
      prompt: reviewPrompt,
      session: { ...session, repo, issueNumber, goal },
      testLog: ctx.testLog || '',
      bundleInfo,
      diff: ctx.diff || '',
    });

    if (r && r.ok === true) {
      const decisionPayload = r.value !== undefined ? r.value : r;
      const nd = normalizeReviewDecision({ decision: decisionPayload, session });
      if (nd.ok) {
        if (nd.value.verdict === 'REWORK' && !nd.value.advisorGuidance) {
          try {
            console.log('[SOC_RUNNER] Phat hien VERDICT: REWORK -> Tu dong kich hoat Advisor qua Chrome CDP 9222...');
            const advisorTransport = await createGeminiWeb2ApiAdvisorTransport({
              cdpPort: Number(process.env.GEMINI_CDP_PORT || 9222),
              host: process.env.GEMINI_CDP_HOST || '127.0.0.1',
              log: (msg) => console.log(`[advisor-dispatch] ${msg}`),
            });

            const advisorPack = buildAdvisorConsultationPrompt({
              session: { ...session, repo, issueNumber, goal },
              errorSummary: 'Reviewer requested changes (REWORK)',
              testLog: ctx.testLog || '',
              diff: ctx.diff || '',
              invariants: [
                '1. Khong sua doi file ngoai pham vi quy dinh.',
                '2. Khong sua test de che dau loi logic.',
                '3. Bao toan test suite hien co (0 regression).'
              ],
              question: 'Phan tich nguyen nhan va huong dan sua loi toi uu cho Executor trong luot Rework tiep theo.'
            });

            const advRes = await advisorTransport({
              prompt: advisorPack.value.prompt,
              reviewPrompt: advisorPack.value.prompt,
              session
            });

            if (advRes && advRes.ok) {
              const parsedAdv = parseAdvisorResponse(advRes.guidance || advRes.text);
              if (parsedAdv.ok) {
                nd.value.advisorGuidance = parsedAdv.value.guidance;
                console.log('[SOC_RUNNER] Da nap chi dan Advisor vao Rework Payload thanh cong!');
              }
            }
          } catch (advErr) {
            console.warn('[SOC_RUNNER] Advisor consultation warning (fail-safe bypass):', advErr.message || advErr);
            nd.value.advisorGuidance = null;
          }
        }
        return { ok: true, value: nd.value };
      }
      return { ok: false, code: nd.code, detail: nd.detail };
    }
    return r;
  };

  const runDeps = {
    reviewReadyDir: path.join(stateDir, 'review-ready'),
    ...(instruction != null ? { instruction } : {}),
    ...deps,
    finalReview,
    telegramMilestones: deps.telegramMilestones !== false,
    ...(humanGate ? { delivery: humanGateDeliveryAdapter() } : {}),
  };

  const result = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: runDeps });
  return interpretResult({ result, stateDir, id, humanGate });
}

const USAGE = `soc-control-loop.mjs — soc_control orchestrator runner (Modular Harness)

Usage:
  node bin/soc-control-loop.mjs --repo <owner/name> --issue <N> [--goal "..."] [--instruction-file <path>] [--state-dir <dir>] [--no-human-gate] [--bootstrap]
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

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
