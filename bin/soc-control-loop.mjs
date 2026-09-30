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
import { execFileSync } from 'node:child_process';
import { dispatchLifecycleEvent } from '../packages/telegram-dispatch/telegram-dispatch.mjs';

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
import {
  executorRouter, launchExecutorAdapter, deterministicVerifierAdapter,
  geminiPreReviewAdapter, packetPathFor,
} from '../packages/control-loop/adapters.mjs';
import { identityHash, defaultWorktreesRoot } from '../packages/workspace/workspace.mjs';
import { ingestGoalViaBootstrapper, writeIngestionLog } from '../packages/control-loop/task-ingestion.mjs';
// Harness hardening §A: the runner admits sessions ONLY through the canonical
// primitive (taskStart) — never by hand-writing a minimal SESSION_ACTIVE.
import { ensureCanonicalSession } from '../packages/control-loop/session-provisioning.mjs';
// Harness hardening §B: ONE model resolver for router / route-worker / launcher.
import { resolveModelForLaunch, MODEL_CODES } from '../packages/executor-launcher/model-resolution.mjs';
import { resolveOpenCodeExecutable, readExecutionRecord, executionRecordPath } from '../packages/executor-launcher/executor-launcher.mjs';
import { priorIncarnationProvenGone } from '../packages/executor-launcher/executor-reconcile.mjs';
// Harness hardening §C: bounded, evidence-preserving recovery around EXECUTE.
import { withBoundedRecovery } from '../packages/control-loop/execution-recovery.mjs';
import { readSessionRecord, taskStart } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
// Session Admission Authority (SOC_TASK_CONTRACT §5): this CLI is the
// `soc_control` entry point. When armed (SOC_SESSION_ADMISSION=required) it must
// hold the canonical session grant BEFORE it creates/reads/mutates the session
// record or the control-loop ledger, and it releases the grant on the way out.
// No file-lease fallback: an unreachable authority fails the run closed.
import { admitSession, releaseAdmission, ownIncarnation } from '../packages/session-authority/guard.mjs';

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

// ---- §C.1 instruction sourcing ---------------------------------------------
// Instruction is DATA and must come from the caller's input or from the
// canonical task contract in the bound worktree — never invented here. Absent
// both, the executor adapter returns INSTRUCTION_REQUIRED (typed preflight,
// no spawn).
export function resolveRunnerInstruction({ instruction = null, goal = null, session = null } = {}) {
  const base = (typeof instruction === 'string' && instruction.trim())
    ? instruction.trim()
    : ((typeof goal === 'string' && goal.trim()) ? goal.trim() : null);
  if (!base) return null;
  const bl = session && session.controlLoop && session.controlLoop.bootstrapper;
  const contractPath = (bl && bl.contractPath)
    || (session && session.worktreePath ? path.join(session.worktreePath, 'SOC_TASK_CONTRACT.md') : null);
  if (!contractPath || !fs.existsSync(contractPath)) return base;
  const withPointer = `${base}\n\nCanonical task contract (read it before editing): ${path.basename(contractPath)}`;
  return Buffer.byteLength(withPointer, 'utf8') <= 8192 ? withPointer : base;
}

// ---- §D.2 pre-review read-back guard ---------------------------------------
// Evidence required BEFORE a review prompt may be dispatched:
//   1. canonical execution record: terminal, EXITED/0, same worktree
//   2. PR binding on the session (prNumber)
//   3. worktree HEAD readable (the PR head we are asking about)
//   4. canonical review-ready packet resolvable (strict identity/head gate
//      lives in collectPreReviewEvidence downstream — never duplicated here)
export function reviewReadBackGuard({ sessionPath, stateDir }) {
  const rs = readSessionRecord(sessionPath);
  if (!rs.ok) return { ok: false, code: rs.reason || 'SESSION_READ_FAILED', detail: rs.detail ?? null };
  const session = rs.session;
  const cp = session.controlPlane || {};
  const sd = cp.stateDir || stateDir;
  if (!sd) return { ok: false, code: 'STATE_DIR_UNAVAILABLE', detail: 'controlPlane.stateDir absent' };

  const er = readExecutionRecord({ stateDir: sd, repo: session.repo, issueNumber: session.issueNumber });
  if (!er.ok) {
    return { ok: false, code: er.reason === 'EXECUTION_NOT_FOUND' ? 'REVIEW_EXECUTION_EVIDENCE_MISSING' : 'REVIEW_EXECUTION_EVIDENCE_UNREADABLE', detail: er.detail ?? er.reason ?? null };
  }
  const rec = er.record || {};
  if (rec.terminalStatus !== 'EXITED' || Number(rec.exitCode) !== 0 || rec.signal) {
    return { ok: false, code: 'REVIEW_EXECUTION_EVIDENCE_INVALID', detail: { terminalStatus: rec.terminalStatus ?? null, exitCode: rec.exitCode ?? null, signal: rec.signal ?? null } };
  }
  if (session.worktreePath && rec.worktreePath && path.resolve(rec.worktreePath) !== path.resolve(session.worktreePath)) {
    return { ok: false, code: 'REVIEW_EXECUTION_EVIDENCE_STALE', detail: { record: rec.worktreePath, session: session.worktreePath } };
  }
  if (rec.taskId && session.taskId && rec.taskId !== session.taskId) {
    return { ok: false, code: 'REVIEW_EXECUTION_EVIDENCE_STALE', detail: { record: rec.taskId, session: session.taskId } };
  }

  const prNumber = Number(session.prNumber);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { ok: false, code: 'REVIEW_PR_BINDING_MISSING', detail: 'session.prNumber is absent/not a positive integer' };
  }

  let headSha = null;
  try {
    headSha = execFileSync('git', ['-C', session.worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return { ok: false, code: 'REVIEW_HEAD_UNREADABLE', detail: String((e && e.message) || e).slice(0, 240) };
  }
  if (!/^[0-9a-f]{40}$/i.test(headSha)) {
    return { ok: false, code: 'REVIEW_HEAD_UNREADABLE', detail: String(headSha).slice(0, 80) };
  }

  const packet = packetPathFor({ reviewReadyDir: path.join(sd, 'review-ready'), sessionPath });
  if (!packet.ok) return { ok: false, code: packet.code || 'NO_REVIEW_PACKET', detail: packet.detail ?? null };

  return { ok: true, value: { executionRecordPath: er.path, prNumber, headSha, packetPath: packet.packetPath, taskId: session.taskId } };
}

// ---- §C.3 bounded recovery around ONE executor invocation -------------------
// Only a PRE_SPAWN_EFFECT_PROVEN failure may spend the single durable retry,
// and only after a cleanup whose proof shows no executor effect remains.
// UNKNOWN_OUTCOME and FAILED_EXECUTION are handed back untouched so the loop
// reconciles / fails closed instead of relaunching.
function buildBoundedExecutor({ stateDir, identityHash: id, deps, inner, readStatus = null }) {
  const cleanup = async ({ failure }) => {
    const rp = executionRecordPath({ stateDir, identityHash: id });
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(rp, 'utf8')); } catch { rec = null; }
    if (!rec) {
      return { ok: true, proof: { at: new Date().toISOString(), identityHash: id, record: 'ABSENT', checks: [{ check: 'recordExists', exists: false }] } };
    }
    if (rec.pid == null) {
      // Durable PRE-SPAWN latch written but no child ever spawned: the latch
      // itself is the whole effect. Read-back = the record still says pid:null.
      return { ok: true, proof: { at: new Date().toISOString(), identityHash: id, record: rp, checks: [{ check: 'preSpawnLatch', pid: null, pendingExecutorBind: rec.pendingExecutorBind === true }] } };
    }
    const gone = priorIncarnationProvenGone({ pid: rec.pid, processStartTime: rec.processStartTime, isAlive: deps.pidAlive });
    const st = typeof readStatus === 'function'
      ? (() => { try { return readStatus({ stateDir, repo: rec.repo, issueNumber: rec.issueNumber }); } catch { return null; } })()
      : null;
    const aliveStatus = st && st.ok && st.execution ? st.execution.status : null;
    const checks = [{ check: 'priorIncarnation', ...gone }, { check: 'status', status: aliveStatus }];
    if (!gone.provenGone || aliveStatus === 'RUNNING' || aliveStatus === 'STARTING') {
      return { ok: false, code: 'CLEANUP_NOT_PROVEN', detail: gone.reason, proof: { identityHash: id, checks } };
    }
    return { ok: true, proof: { at: new Date().toISOString(), identityHash: id, record: rp, checks } };
  };

  return async function boundedExecutor(ctx) {
    return withBoundedRecovery({
      stateDir,
      identityHash: id,
      generation: ctx && ctx.reworkInstruction ? 'rework' : 'initial',
      cleanup,
      run: async ({ attempt }) => {
        const out = await inner(ctx);
        // Attempt 2 is only reachable after a proven no-effect cleanup: the
        // router's single-attempt invariant is preserved (we never relaunch an
        // attempt whose side effect is unknown).
        if (attempt === 1 && out && out.ok !== true) return out;
        if (attempt === 2 && out && out.ok !== true) {
          return { ...out, recovery: { ...(out.recovery || {}), attempt } };
        }
        return out;
      },
    });
  };
}

// Poll/deadline knobs are opt-in through deps so offline tests never wait.
function adapterPollKnobs(deps = {}) {
  const out = {};
  for (const k of ['pollDeadlineMs', 'pollDeadlineMaxMs', 'stallWindowMs', 'pollIntervalMs', 'clock', 'delay', 'startExecution', 'readStatus']) {
    if (deps[k] !== undefined) out[k] = deps[k];
  }
  return out;
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

// ---- §A.2b bootstrap state gate -----------------------------------------------
// Invoke-SocTask.ps1 can only bind a PR number through
// `gh pr create --base <main> --head <branch>`, and GitHub REFUSES that call
// while the branch carries no commit that differs from the base
// ("GraphQL: No commits between main and <branch>"). A workspace freshly
// admitted by taskStart() sits exactly on the pinned session.baseSha, so every
// goal-only submit used to be forced into exactly that doomed call and failed
// closed at intake (BOOTSTRAP_STEP_FAILED -> 0 FSM transitions, no
// ExecutionRecord, no executor spawn).
//
// Read-only and proof-gated: the count is only trusted when git really answers
// for the canonical worktree. `null` (missing worktree, unreadable git,
// malformed SHA) is UNPROVEN and keeps the previous behaviour - the bootstrapper
// runs. Only a PROVEN 0 defers ingestion, and the deferral is written to the
// same structured ingestion log every other intake decision uses.
export function countCommitsAheadOfBase({ session, exec = execFileSync } = {}) {
  const wt = session && session.worktreePath;
  const base = session && session.baseSha;
  if (typeof wt !== 'string' || !wt) return null;
  if (typeof base !== 'string' || !/^[0-9a-f]{40}$/i.test(base)) return null;
  let out;
  try {
    out = exec('git', ['-C', wt, 'rev-list', '--count', `${base}..HEAD`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch {
    return null;
  }
  const n = Number.parseInt(String(out ?? '').trim(), 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
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

  // ---- Session Admission Authority (armed only) ------------------------------
  // ACQUIRE the ONE mutation grant for this canonical session before this
  // process creates, reads-for-mutation or writes session/ledger state.
  // A live authority only ever grants to a PROVABLE owner incarnation, so the
  // canonical {pid, processStartTime} helper is passed through explicitly; an
  // unreadable start time yields null and admission fails closed
  // (OWNER_IDENTITY_UNPROVEN) instead of minting an anonymous grant.
  const admission = await admitSession({
    identityHash: id,
    sessionPath,
    laneId: 'soc_control',
    owner: ownIncarnation(),
  });
  if (!admission.ok) {
    return fail(admission.code || 'SESSION_ADMISSION_FAILED', admission.detail ?? null);
  }
  try {
    return await runAdmittedSocControlLoop({ repo, issueNumber, goal, instruction, stateDir, humanGate, bootstrap, deps, id, sessionPath });
  } finally {
    // Clean shutdown releases the grant (crash leaves it DISCONNECTED, which
    // is exactly what makes a later takeover require death evidence).
    const rel = await releaseAdmission({ sessionPath });
    if (rel && rel.ok === false && rel.code) {
      process.stderr.write(`[soc-control-loop] admission release failed closed: ${rel.code} ${rel.detail || ''}\n`);
    }
  }
}

async function runAdmittedSocControlLoop({
  repo, issueNumber, goal = null, instruction = null,
  stateDir, humanGate, bootstrap, deps = {}, id, sessionPath,
}) {
  let session = null;

  if (bootstrap && (typeof goal !== 'string' || !goal.trim())) {
    return fail('BOOTSTRAP_GOAL_REQUIRED', '--bootstrap requires a non-empty --goal');
  }

  // ---- §A.1 canonical session admission -------------------------------------
  // The runner NEVER hand-writes a session record. A missing session is
  // admitted through taskStart() (bootstrap only — otherwise SESSION_NOT_FOUND);
  // an existing one is read back and validated (binding + lease + identity)
  // before the FSM is allowed to touch it.
  const worktreesRoot = deps.worktreesRoot || defaultWorktreesRoot();
  const admitArgs = {
    repo,
    issueNumber,
    sessionPath,
    stateDir,
    worktreesRoot,
    controlCwd: PROJECT_ROOT,
    goal,
    baseSha: deps.baseSha || null,
    baseRef: deps.bootstrapperBase || process.env.SOC_TASK_BASE || 'origin/main',
    laneId: 'soc_control',
    taskStartImpl: deps.taskStart || taskStart,
    exec: deps.execGit || execFileSync,
  };
  const admitted = await ensureCanonicalSession({ ...admitArgs, requireSessionWhenAbsent: bootstrap });
  if (!admitted.ok) return fail(admitted.code, admitted.detail);
  session = admitted.value.session;

  if (bootstrap) {
    // ---- §A.2 ONE canonical worktree/branch ---------------------------------
    // taskStart() already provisioned `worktreesRoot/agent/<identityHash>` on
    // branch `agent/<identityHash>`; the bootstrapper is told to use THAT
    // workspace instead of minting `worktrees/fix/issue-...` beside it.
    const canonicalWorktree = session.worktreePath;
    const canonicalBranch = session.branch;
    // §A.2b: decide from the TASK's state, not from the caller's wish. A
    // canonical branch with zero commits ahead of the pinned base cannot open
    // a PR, so bootstrapping it only produces a refused `gh pr create`.
    const commitsAhead = countCommitsAheadOfBase({ session, exec: deps.execGit || execFileSync });
    if (commitsAhead === 0) {
      writeIngestionLog({
        stateDir,
        entry: {
          event: 'TASK_INGESTION_SKIPPED',
          code: 'BOOTSTRAP_NO_COMMITS_AHEAD',
          phase: 'gate',
          branch: canonicalBranch,
          worktreePath: canonicalWorktree,
          baseSha: session.baseSha ?? null,
          detail: 'canonical branch carries no commit ahead of the pinned base: gh pr create would be refused (no commits between base and head); ingestion is deferred until the task publishes a commit.',
        },
      });
    } else {
      const ing = await ingestGoalViaBootstrapper({
        goal,
        issueNumber,
        sessionPath,
        stateDir,
        repo,
        projectRoot: PROJECT_ROOT,
        worktreesRoot: session.worktreesRoot,
        branchName: canonicalBranch,
        worktreePath: canonicalWorktree,
        spawnImpl: typeof deps.spawnBootstrapper === 'function' ? deps.spawnBootstrapper : null,
        scriptPath: deps.bootstrapperScriptPath || null,
        host: deps.bootstrapperHost || null,
        cwd: deps.bootstrapperCwd || null,
        env: deps.bootstrapperEnv || null,
        base: deps.bootstrapperBase,
        repoRoot: deps.bootstrapperRepoRoot || null,
        timestamp: deps.bootstrapperTimestamp || null,
        pullRequestNumber: deps.bootstrapperPullRequestNumber ?? null,
        dryRun: deps.bootstrapperDryRun === true,
      });
      if (!ing.ok) return fail(ing.code, ing.detail);
      const bt = ing.value.bootstrap;
      // A bootstrapper answer pointing at a DIFFERENT worktree/branch is a
      // contract violation, not a metadata update to merge in (§A.2: never two
      // worktrees with cross-assigned metadata).
      if (String(bt.branch) !== String(canonicalBranch)
        || path.resolve(String(bt.worktreePath)) !== path.resolve(canonicalWorktree)) {
        return fail('BOOTSTRAP_WORKTREE_DRIFT',
          `bootstrapper reported branch=${bt.branch} worktree=${bt.worktreePath}; canonical branch=${canonicalBranch} worktree=${canonicalWorktree}`);
      }
    }
    // Read back + re-validate AFTER the Git/PR side effects (§A.1).
    const re = await ensureCanonicalSession({ ...admitArgs, requireSessionWhenAbsent: false });
    if (!re.ok) return fail(re.code, re.detail);
    session = re.value.session;
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

  const reviewReadyDir = path.join(stateDir, 'review-ready');

  // ---- §B.3 the CLI router no longer falls back to `{model:null}` ------------
  // The model is resolved through the ONE shared resolver; an unresolvable
  // model is a typed, fail-closed ROUTE failure (never a silent null launch).
  const resolveRouterModel = () => {
    const ex = resolveOpenCodeExecutable({ env: process.env });
    return resolveModelForLaunch({
      model: null,
      binding: session.worktreePath ? { path: session.worktreePath } : null,
      controlCwd: PROJECT_ROOT,
      listModels: typeof deps.listModels === 'function' ? deps.listModels : null,
      env: process.env,
      executable: ex.ok ? ex.executable : null,
      exec: deps.modelProbe || undefined,
    });
  };

  // ---- §C.1 instruction comes from input or the canonical task contract ------
  const effInstruction = resolveRunnerInstruction({ instruction, goal, session });

  // ---- §D.1 pre-review uses the configured reviewer transport, not a stub ----
  const preReviewTransport = deps.preReviewTransport
    || (deps.preReview ? null : await createLazyWeb2ApiTransport());

  const runDeps = {
    router: deps.router || ((ctx) => {
      const sp = (ctx && ctx.sessionPath) || sessionPath;
      const r = executorRouter({ executorKind: 'opencode' })({ sessionPath: sp });
      if (!r || r.ok !== true) {
        return { ok: false, code: (r && r.code) || 'ROUTE_FAILED', detail: (r && r.detail) ?? null };
      }
      const m = resolveRouterModel();
      if (!m.ok) return { ok: false, code: m.code, detail: m.detail };
      return { ok: true, value: { executorKind: 'opencode', model: m.value.model } };
    }),
    reviewReadyDir,
    ...(instruction != null ? { instruction } : {}),
    ...deps,
    // ---- §C.1 real executor/verifier adapters, wrapped in bounded recovery ----
    executor: deps.executor || buildBoundedExecutor({
      stateDir, identityHash: id, deps,
      inner: launchExecutorAdapter({ instruction: effInstruction, controlCwd: PROJECT_ROOT, ...adapterPollKnobs(deps) }),
      readStatus: deps.readExecutionStatus,
    }),
    verifier: deps.verifier || deterministicVerifierAdapter(),
    preReview: deps.preReview || (async (ctx) => {
      // ---- §D.2 read back canonical execution evidence, PR binding, worktree
      // HEAD and the review-ready packet BEFORE a prompt byte is sent. Missing
      // evidence stops at a typed, resumable tail — no half-sent prompt.
      const rb = reviewReadBackGuard({ sessionPath, stateDir });
      if (!rb.ok) return rb;
      const inner = geminiPreReviewAdapter({ transport: preReviewTransport, reviewReadyDir });
      const r = await inner({ ...ctx, sessionPath });
      if (r && r.ok === true) return { ...r, value: { ...r.value, readBack: rb.value } };
      return r;
    }),
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


function dispatchEmergencyTelegramAlert({ error, repo, issueNumber, stateDir, note } = {}) {
  try {
    const headSha = (() => {
      try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch {
        return 'unknown';
      }
    })();
    const branch = (() => {
      try {
        return execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch {
        return 'main';
      }
    })();
    const session = {
      repo: repo || 'duongpdddic-droid/Soc_brain',
      issueNumber: Number(issueNumber) || 9000022,
      branch,
      headSha,
      worktreePath: process.cwd(),
    };
    const errMsg = String((error && error.message) || error || 'Unknown runner error');
    const alertNote = [
      '🚨 ALERT: TASK_HALTED (Runner Exception)',
      note ? `Ghi chú: ${note}` : null,
      `Chi tiết: ${errMsg.slice(0, 300)}`,
    ].filter(Boolean).join('\n');

    dispatchLifecycleEvent({
      session,
      event: 'TASK_FAILED',
      note: alertNote,
      stateDir: stateDir || defaultStateDir(),
      allowNonCanonicalStateRoot: true,
    });
  } catch {
    // Fail-soft: emergency alert must never crash or mask the original failure
  }
}

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
    dispatchEmergencyTelegramAlert({
      error: e,
      note: 'Fatal unhandled exception in soc-control-loop runner',
    });
    process.stderr.write(`soc-control-loop: ${String((e && e.message) || e)}\n`);
    process.exit(1);
  });
}
