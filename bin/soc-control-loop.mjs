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
  // REWORK F3 (REC-01): the production reconciliation entry below owns
  // validation -> record -> seal -> release -> re-acquire -> verify itself.
  recordPreSubmitBoundaryReconciled,
  sealPreSubmitBoundaryReconciled,
  readPreSubmitBoundaryReconcile,
  // REWORK F2-src (round 2): the boundary observation the entry records is
  // DERIVED from the transport stage-observation marker in the bound evidence
  // (a caller-supplied object is only a claim).
  derivePreSubmitObservationFromEvidence,
  // REC-01 r4: the CANONICAL attempt linkage, verified BEFORE any grant.
  resolveCheckpointAttemptLink,
  // REC-01 r5: the CANONICAL submit boundary veto, also BEFORE any grant.
  canonicalSubmitVeto,
} from '../packages/control-loop/control-loop.mjs';
import {
  normalizeReviewDecision,
} from '../packages/control-loop/verdict-parser.mjs';
import { buildReviewPromptForSession } from '../packages/control-loop/review-payload.mjs';
import {
  readExecutionTestLog,
  buildPrChangeset,
  buildBundleInfoForSession,
  REVIEW_EVIDENCE_CODES,
} from '../packages/control-loop/review-evidence.mjs';
// [main] openReviewRound thay persistReviewRequest: round keyed bằng canonical
// identity + HEAD + evidence chưa consume, typed-block match mơ hồ trước khi
// ghi request record.
import { openReviewRound, validateReviewProvenance } from '../packages/control-loop/web2api-review-provenance.mjs';
// MCP final-review leg (Issue: mcp-gpt-final-review): SOC_FINAL_REVIEW_VIA=mcp
// chuyển kênh verdict sang <packetDir>/_decisions - Web2API chỉ dùng để gửi
// activation prompt (đúng một lần mỗi lượt review), không bao giờ là kênh verdict.
import { createMcpFinalReview, resolveReviewVia } from '../packages/control-loop/mcp-final-review.mjs';
import {
  buildAdvisorConsultationPrompt,
  parseAdvisorResponse,
} from '../packages/control-loop/advisor-payload.mjs';
import {
  createGeminiWeb2ApiReviewTransport,
  createGeminiWeb2ApiAdvisorTransport,
  createGeminiWeb2ApiRawLazyTransport,
} from '../packages/control-loop/gemini-plus-web2api-copy.mjs';
import { createCdpSupervisor, resolveCdpConfig } from '../packages/control-loop/cdp-supervisor.mjs';
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
// Issue #263 F4(1): the ACTIVE control-plane test gate runs at VERIFY and
// writes its own TestRunRecord + raw log (executor-launcher/test-run-evidence).
import { createActiveTestRunner } from '../packages/executor-launcher/test-run-evidence.mjs';
// PRE-GATE-REVIEW-01: internal read-only review runs BEFORE the deterministic
// verifier (required gate) on the production path. Review failure blocks the
// gate; only a CLEAN APPROVED review lets the inner verifier run exactly once.
import { preGateReviewVerifierAdapter } from '../packages/control-loop/pre-gate-review.mjs';
import { createOcrReviewTransport } from '../packages/control-loop/ocr-review-transport.mjs';
// Harness hardening §C: bounded, evidence-preserving recovery around EXECUTE.
import { withBoundedRecovery } from '../packages/control-loop/execution-recovery.mjs';
import { readSessionRecord, taskStart } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
// Session Admission Authority (SOC_TASK_CONTRACT §5): this CLI is the
// `soc_control` entry point. When armed (SOC_SESSION_ADMISSION=required) it must
// hold the canonical session grant BEFORE it creates/reads/mutates the session
// record or the control-loop ledger, and it releases the grant on the way out.
// No file-lease fallback: an unreachable authority fails the run closed.
import { admitSession, releaseAdmission, ownIncarnation, assertAdmissionFence } from '../packages/session-authority/guard.mjs';

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
    cdpPort: null, cdpHost: null, cdpUserDataDir: null, cdpProfileDirectory: null,
    // REWORK F3-cli (REC-01 round 2): the Operator/control-plane entry flag.
    reconcilePreSubmit: false,
    checkpointTs: null, checkpointReason: null, checkpointEvidence: null,
    // REC-01 r3: optional transport-attempt linkage of the checkpoint. When
    // supplied it must match the marker's attempt id (an old attempt's marker
    // then never proves this checkpoint); without it the checkpoint still
    // binds through identity + trusted source + stage map + time window.
    checkpointAttempt: null,
    evidence: null, source: null, basis: null,
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
    if (a === '--cdp-port') { const n = Number.parseInt(argv[++i], 10); out.cdpPort = Number.isInteger(n) && n > 0 ? n : null; continue; }
    if (a === '--cdp-host') { out.cdpHost = argv[++i] ?? null; continue; }
    if (a === '--cdp-user-data-dir') { out.cdpUserDataDir = argv[++i] ?? null; continue; }
    if (a === '--cdp-profile-directory') { out.cdpProfileDirectory = argv[++i] ?? null; continue; }
    // REWORK F3-cli: --reconcile-pre-submit takes over main() entirely (it
    // never enters the full control loop).
    if (a === '--reconcile-pre-submit') { out.reconcilePreSubmit = true; continue; }
    if (a === '--checkpoint-ts') { out.checkpointTs = argv[++i] ?? null; continue; }
    if (a === '--checkpoint-reason') { out.checkpointReason = argv[++i] ?? null; continue; }
    if (a === '--checkpoint-evidence') { out.checkpointEvidence = argv[++i] ?? null; continue; }
    if (a === '--checkpoint-attempt') { out.checkpointAttempt = argv[++i] ?? null; continue; }
    if (a === '--evidence') { out.evidence = argv[++i] ?? null; continue; }
    if (a === '--source') { out.source = argv[++i] ?? null; continue; }
    if (a === '--basis') { out.basis = argv[++i] ?? null; continue; }
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
// canonical PERSISTED goal of this same task (the durable route claim),
// never invented here and never scraped from arbitrary contract prose.
//
// readPersistedRouteGoal: the durable route claim is read as EVIDENCE ONLY -
// requestedAt is never rewritten, the route worker's 60s freshness guard is
// never relaxed, and the claim is never executed here (no spawn, no
// transition). Every linkage field is validated against the session (kind,
// identityHash, repo, issueNumber, stateDir, sessionPath) and against the
// checkpoint owner (controlLoop.identityHash); any missing/mismatch fails
// typed so the caller can block BEFORE any transition or dispatch.
export function readPersistedRouteGoal({ session = null, sessionPath = null } = {}) {
  const s = (session && typeof session === 'object') ? session : null;
  const stateDir = s && s.controlPlane && s.controlPlane.stateDir;
  const id = s && s.identityHash;
  if (!s || !stateDir || !id) {
    return { ok: false, code: 'INSTRUCTION_SOURCE_MISSING', detail: { reason: 'session has no canonical identity/controlPlane.stateDir for the route claim' } };
  }
  const claimPath = path.join(path.resolve(stateDir), 'client-mcp', 'routes', `${id}.control-loop.json`);
  let raw = null;
  try {
    raw = fs.readFileSync(claimPath, 'utf8');
  } catch (e) {
    return { ok: false, code: 'INSTRUCTION_SOURCE_MISSING', detail: { reason: 'route claim unreadable', path: claimPath, code: (e && e.code) || null } };
  }
  let claim = null;
  try {
    claim = JSON.parse(raw);
  } catch (e) {
    return { ok: false, code: 'INSTRUCTION_SOURCE_UNREADABLE', detail: { path: claimPath, reason: String((e && e.message) || e).slice(0, 200) } };
  }
  const failed = [];
  if (!claim || typeof claim !== 'object' || Array.isArray(claim) || claim.kind !== 'soc-control-loop-route') failed.push('kind');
  if (!claim || claim.identityHash !== id) failed.push('identityHash');
  if (!claim || typeof claim.repo !== 'string' || claim.repo.toLowerCase() !== String(s.repo || '').toLowerCase()) failed.push('repo');
  if (!claim || Number(claim.issueNumber) !== Number(s.issueNumber)) failed.push('issueNumber');
  if (!claim || typeof claim.stateDir !== 'string' || path.resolve(claim.stateDir) !== path.resolve(stateDir)) failed.push('stateDir');
  if (!sessionPath || !claim || typeof claim.sessionPath !== 'string' || path.resolve(claim.sessionPath) !== path.resolve(sessionPath)) failed.push('sessionPath');
  if (!s.controlLoop || s.controlLoop.identityHash !== id) failed.push('controlLoop');
  if (failed.length) {
    return { ok: false, code: 'INSTRUCTION_SOURCE_MISMATCH', detail: { path: claimPath, failed } };
  }
  const goal = typeof claim.goal === 'string' ? claim.goal.trim() : '';
  if (!goal) return { ok: false, code: 'INSTRUCTION_SOURCE_MISSING', detail: { reason: 'route claim carries no goal', path: claimPath } };
  return { ok: true, goal, path: claimPath };
}

// Returns the instruction STRING, or a typed { ok:false, code, detail } when
// no caller input exists AND the canonical persisted goal cannot be proven.
// Absent both, the executor adapter would return INSTRUCTION_REQUIRED (typed
// preflight, no spawn) - now blocked even earlier, before any transition.
export function resolveRunnerInstruction({ instruction = null, goal = null, session = null, sessionPath = null } = {}) {
  let base = (typeof instruction === 'string' && instruction.trim())
    ? instruction.trim()
    : ((typeof goal === 'string' && goal.trim()) ? goal.trim() : null);
  if (!base) {
    const claim = readPersistedRouteGoal({ session, sessionPath });
    if (claim.ok !== true) return claim;
    base = claim.goal; // exact admitted goal of THIS task (validated route claim)
  }
  const bl = session && session.controlLoop && session.controlLoop.bootstrapper;
  const runtimeContract = session?.worktreePath ? path.join(session.worktreePath, '.soc', 'task-contract.md') : null;
  const contractPath = (runtimeContract && fs.existsSync(runtimeContract) ? runtimeContract : null) || (bl && bl.contractPath)
    || (session && session.worktreePath ? path.join(session.worktreePath, 'SOC_TASK_CONTRACT.md') : null);
  if (!contractPath || !fs.existsSync(contractPath)) return base;
  const pointer = session?.worktreePath ? path.relative(session.worktreePath, contractPath).replaceAll('\\', '/') : path.basename(contractPath);
  const withPointer = `${base}\n\nCanonical task contract (read it before editing): ${pointer}`;
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
  if (result && result.code === 'FINAL_REVIEW_FAILED') {
    // The FSM wraps every finalReview step failure as FINAL_REVIEW_FAILED and
    // drops the inner {code, detail} into a string. The prompt/diff boundary
    // failure (e.g. EMPTY_DIFF_CONTENT) is preserved verbatim as the ledger
    // evidence of the FINAL_REVIEWING->BLOCKED 'finalReview:FAIL' transition —
    // surface THAT typed reason so callers see the real fail-closed code.
    const ledger = readTransitions({ stateDir, identityHash: id });
    const last = ledger[ledger.length - 1];
    const ev = last && last.from === 'FINAL_REVIEWING' && last.to === 'BLOCKED'
      && String(last.reason || '').startsWith('finalReview:FAIL') ? last.evidence : null;
    if (ev && typeof ev === 'object' && ev.ok === false
      && typeof ev.code === 'string' && ev.code
      && ev.detail !== undefined && ev.detail !== null) {
      return { ok: false, code: ev.code, detail: ev.detail };
    }
    return result;
  }
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

// The artifact bundle is resolved from the BOUND TASK WORKTREE and verified
// against the reviewed changeset by buildBundleInfoForSession() in
// packages/control-loop/review-evidence.mjs. It must never be resolved from
// this runner's PROJECT_ROOT: when the loop is launched from another
// checkout (e.g. the #263 worktree driving the #266 task) that lookup can
// only ever miss, and a miss rendered as "(no artifact bundle info provided)"
// makes the reviewer's delivery-artifact finding unsatisfiable by design.

async function createLazyWeb2ApiTransport({ port = 9222, host = '127.0.0.1', userDataDir = null, profileDirectory = null } = {}) {
  let transport = null;
  return async function dispatchReview(ctx) {
    if (!transport) {
      const cdp = createCdpSupervisor({
        port,
        userDataDir,
        profileDirectory,
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
  cdpConfig = null,
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
    return await runAdmittedSocControlLoop({ repo, issueNumber, goal, instruction, stateDir, humanGate, bootstrap, deps, id, sessionPath, cdpConfig });
  } finally {
    // Clean shutdown releases the grant (crash leaves it DISCONNECTED, which
    // is exactly what makes a later takeover require death evidence).
    const rel = await releaseAdmission({ sessionPath });
    if (rel && rel.ok === false && rel.code) {
      process.stderr.write(`[soc-control-loop] admission release failed closed: ${rel.code} ${rel.detail || ''}\n`);
    }
  }
}

// REWORK F3 (REC-01): the PRODUCTION reconciliation entry the runner executes.
// One owner, one arc, all under the runner's own admission:
//   derive the proven observation (F2-src, BEFORE any grant) -> admit ->
//   validate/write the record -> seal (authority issues the receipt) ->
//   GRANT CONTRACT (F3-grant, round 2) -> verify through the authority
//   receipt seam (reader + live attestation).
// GRANT CONTRACT — the entry NEVER releases a grant it does not own:
//   * caller-owned (a fence was already held on entry): NO release, NO
//     re-acquire on any outcome; success verifies under the SAME grant and a
//     post-admission failure reports grantPreserved with the caller's fence
//     still live.
//   * entry-owned (this call minted the grant): a post-admission FAILURE
//     releases exactly the grant it minted (cleanup, no residue); a SUCCESS
//     rotates (release writer grant -> reacquire fresh -> verify) and then
//     releases UNLESS the caller explicitly hands the grant to the canonical
//     runner (handoffToRunner: true keeps the fence live for its retry).
// Every result carries { grantOwnership, grantReleased } so callers can never
// mistake a foreign grant for their own.
export async function reconcilePreSubmitBoundary({
  stateDir, identityHash: id, sessionPath = null, checkpoint, source = null, basis = null, evidence = null, observation = null, handoffToRunner = false,
} = {}) {
  const sp = sessionPath || path.join(path.resolve(String(stateDir)), 'sessions', `${id}.json`);
  // The fence lane must equal the canonical session mutationOwner.laneId
  // (writer consistency check): admit with THAT lane, never a guessed one.
  const rs = readSessionRecord(sp);
  const ownerLane = rs && rs.ok && rs.session && rs.session.mutationOwner
    && typeof rs.session.mutationOwner.laneId === 'string' && rs.session.mutationOwner.laneId
    ? rs.session.mutationOwner.laneId : null;
  if (!ownerLane) {
    return { ok: false, code: 'SESSION_LANE_UNPROVEN', detail: 'the session mutationOwner.laneId is unreadable: no reconciliation grant is minted', grantTouched: false };
  }

  // REWORK F2-src (round 2): a caller-supplied observation is a CLAIM. When
  // the caller brings none, THIS entry derives the proven one from the
  // transport stage-observation marker in the bound evidence BEFORE admission:
  // a legacy checkpoint without a proven marker is an honest typed block and
  // no grant is ever minted for it.
  let effectiveObservation = observation;
  if (observation === null || observation === undefined) {
    const evidencePath = evidence && typeof evidence === 'object' && typeof evidence.path === 'string' && evidence.path ? evidence.path : null;
    const d = derivePreSubmitObservationFromEvidence({ evidencePath, checkpoint, identityHash: id });
    if (!d.ok) {
      return {
        ok: false,
        code: 'BOUNDARY_OBSERVATION_UNPROVEN',
        reason: d.reason,
        detail: { reason: d.reason, ...(d.detail || {}), note: 'the boundary observation is derived from the transport stage-observation marker inside the bound evidence; without it no grant is minted and no record is written (never a fabricated observation)' },
        grantTouched: false,
      };
    }
    effectiveObservation = d.observation;
  }

  // REC-01 r4: the CANONICAL attempt linkage is verified BEFORE any grant is
  // minted. Omitting --checkpoint-attempt can never bypass this check, and a
  // caller-supplied value is compared against the canonical failure evidence
  // of this checkpoint in the ledger (the marker is never consulted as its
  // own expected value). A legacy checkpoint without a linkage is a typed
  // block - grantTouched stays false, nothing is written.
  const link = resolveCheckpointAttemptLink({ stateDir, identityHash: id, checkpoint });
  if (!link.ok) {
    return { ok: false, code: link.reason, detail: link.detail ?? null, grantTouched: false };
  }
  // REC-01 r5: the CANONICAL submit boundary vetoes BEFORE any grant - a
  // canonical failure that asserts the submit started (SUBMIT_IN_FLIGHT /
  // submitted UNKNOWN|true / POST_SUBMIT) is never reconciled into a PRE_SUBMIT
  // boundary, whatever the marker in --evidence claims. grantTouched stays
  // false; reconcile the original round, never resend.
  const veto = canonicalSubmitVeto({ canonicalEvidence: link.canonicalEvidence });
  if (veto.veto) {
    return { ok: false, code: 'BOUNDARY_CANONICAL_SUBMIT_VETO', detail: veto.detail, grantTouched: false };
  }

  // GRANT OWNERSHIP decided BEFORE admission: a fence this call did not mint
  // belongs to the caller and must survive every outcome untouched.
  const preFence = assertAdmissionFence({ sessionPath: sp, identityHash: id });
  const preHeld = Boolean(preFence && preFence.ok === true && preFence.armed === true);

  const admission = await admitSession({ identityHash: id, sessionPath: sp, laneId: ownerLane, owner: ownIncarnation() });
  if (!admission.ok) {
    return {
      ok: false,
      code: admission.code || 'SESSION_ADMISSION_FAILED',
      detail: admission.detail ?? null,
      grantOwnership: preHeld ? 'caller' : 'entry',
      grantReleased: false,
      grantPreserved: preHeld,
    };
  }
  const ownsGrant = admission.armed === true && !preHeld;
  const grantOwnership = ownsGrant ? 'entry' : 'caller';
  const fenceGeneration = admission.fence && Number.isInteger(admission.fence.generation) ? admission.fence.generation : null;

  // Post-admission failure cleanup: ONLY the entry-owned grant is released.
  const failClosed = async (res) => {
    if (ownsGrant) {
      const rel = await releaseAdmission({ sessionPath: sp, identityHash: id });
      return { ...res, grantOwnership, grantReleased: Boolean(rel && rel.ok === true && rel.released !== false), grantPreserved: false };
    }
    return { ...res, grantOwnership, grantReleased: false, grantPreserved: true };
  };

  const rec = recordPreSubmitBoundaryReconciled({ stateDir, identityHash: id, checkpoint, source, basis, evidence, observation: effectiveObservation });
  if (!rec.ok) return failClosed(rec); // typed writer refusal, preserved verbatim

  const seal = await sealPreSubmitBoundaryReconciled({ stateDir, identityHash: id, checkpoint, recordPath: rec.path });
  if (!seal.ok) {
    return failClosed({ ok: false, code: seal.code || 'RECORD_SEAL_FAILED', detail: seal.detail ?? null, recordPath: rec.path ?? null });
  }

  if (ownsGrant) {
    // Rotate: the receipt this verifies is HISTORY from the writer-side grant
    // that is already gone; verification runs under a fresh, separately
    // proved current grant.
    const rel = await releaseAdmission({ sessionPath: sp, identityHash: id });
    if (!rel || rel.ok !== true) {
      return { ok: false, code: 'ADMISSION_RELEASE_FAILED', detail: (rel && (rel.detail ?? rel.code)) ?? null, sealed: true, recordPath: rec.path ?? null, grantOwnership, grantReleased: false };
    }
    const reacquire = await admitSession({ identityHash: id, sessionPath: sp, laneId: ownerLane, owner: ownIncarnation() });
    if (!reacquire.ok) {
      return { ok: false, code: reacquire.code || 'SESSION_ADMISSION_FAILED', detail: reacquire.detail ?? null, sealed: true, recordPath: rec.path ?? null, grantOwnership, grantReleased: true };
    }
    const verify = await readPreSubmitBoundaryReconcile({ stateDir, identityHash: id, checkpoint });
    if (!verify.ok) {
      // Post-admission failure: clean up the entry-owned (reacquired) grant —
      // a failed verification leaves no residue for the caller to trip on.
      const relV = await releaseAdmission({ sessionPath: sp, identityHash: id });
      return {
        ok: false,
        code: 'RECORD_VERIFICATION_FAILED',
        reason: verify.reason ?? null,
        detail: verify.detail ?? null,
        recordPath: rec.path ?? null,
        sealed: true,
        grantOwnership,
        grantReleased: Boolean(relV && relV.ok === true && relV.released !== false),
      };
    }
    let released = false;
    if (handoffToRunner !== true) {
      const rel2 = await releaseAdmission({ sessionPath: sp, identityHash: id });
      if (!rel2 || rel2.ok !== true) {
        return { ok: false, code: 'ADMISSION_RELEASE_FAILED', detail: (rel2 && (rel2.detail ?? rel2.code)) ?? null, sealed: true, verified: true, recordPath: rec.path ?? null, grantOwnership, grantReleased: false };
      }
      released = rel2.released !== false;
    }
    return {
      ok: true,
      recordPath: rec.path,
      recordSha256: seal.recordSha256 ?? null,
      checkpointKey: seal.checkpointKey ?? null,
      sealed: Boolean(seal.sealed),
      seq: Number.isInteger(seal.seq) ? seal.seq : null,
      receipt: seal.receipt || null,
      boundary: verify.receipt || null,
      grantOwnership,
      grantReleased: handoffToRunner !== true ? released : false,
      released: handoffToRunner !== true ? released : false,
      reacquired: true,
      verified: true,
      handoffToRunner: handoffToRunner === true,
      fenceGeneration: reacquire.fence && Number.isInteger(reacquire.fence.generation) ? reacquire.fence.generation : null,
    };
  }

  // Caller-owned grant: verify under the SAME live fence — never release,
  // never re-acquire, never rotate. The caller's fence outlives this entry.
  const verify = await readPreSubmitBoundaryReconcile({ stateDir, identityHash: id, checkpoint });
  if (!verify.ok) {
    return {
      ok: false,
      code: 'RECORD_VERIFICATION_FAILED',
      reason: verify.reason ?? null,
      detail: verify.detail ?? null,
      recordPath: rec.path ?? null,
      sealed: true,
      grantOwnership,
      grantReleased: false,
      grantPreserved: true,
    };
  }
  return {
    ok: true,
    recordPath: rec.path,
    recordSha256: seal.recordSha256 ?? null,
    checkpointKey: seal.checkpointKey ?? null,
    sealed: Boolean(seal.sealed),
    seq: Number.isInteger(seal.seq) ? seal.seq : null,
    receipt: seal.receipt || null,
    boundary: verify.receipt || null,
    grantOwnership,
    grantReleased: false,
    grantPreserved: true,
    released: false,
    reacquired: false,
    verified: true,
    handoffToRunner: false,
    fenceGeneration,
  };
}

async function runAdmittedSocControlLoop({
  repo, issueNumber, goal = null, instruction = null,
  stateDir, humanGate, bootstrap, deps = {}, id, sessionPath,
  cdpConfig = null,
}) {
  let session = null;
  const publishExec = Object.hasOwn(deps, 'pushExec') ? deps.pushExec : null;
  // Web2API/CDP reviewer browser contract: CLI override > env > default.
  // SOC_CWA_* is CWA-only configuration and is never read on this path.
  const cdpCfg = cdpConfig || deps.cdpConfig || resolveCdpConfig({ env: process.env });

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
    if (commitsAhead === 0 || publishExec !== undefined) {
      writeIngestionLog({
        stateDir,
        entry: {
          event: 'TASK_INGESTION_SKIPPED',
          code: commitsAhead === 0 ? 'BOOTSTRAP_NO_COMMITS_AHEAD' : 'BOOTSTRAP_PUBLISH_DEFERRED',
          phase: 'gate',
          branch: canonicalBranch,
          worktreePath: canonicalWorktree,
          baseSha: session.baseSha ?? null,
          detail: 'PR publication is deferred to the canonical post-executor chain, including VERIFYING resume; bootstrap never races that owner.',
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

  // ---- MCP final-review leg (Issue: mcp-gpt-final-review) ------------------
  // SOC_FINAL_REVIEW_VIA chọn kênh verdict: unset/''/'web2api' -> đường
  // clipboard hiện hành (mặc định, không đổi hành vi production); 'mcp' ->
  // verdict CHỈ đến từ <packetDir>/_decisions (Web2API chỉ gửi activation
  // prompt, đúng một lần mỗi lượt review); giá trị khác -> fail-closed TRƯỚC
  // khi FSM khởi động (không có transition nào được ghi).
  const reviewReadyDir = path.join(stateDir, 'review-ready');
  const mcpEnv = deps.mcpEnv || process.env;
  const via = resolveReviewVia(mcpEnv);
  if (!via.ok) return fail(via.code, via.detail);
  const mcpLeg = via.via === 'mcp' && !deps.finalReview
    ? createMcpFinalReview({
      reviewReadyDir,
      stateDir,
      env: mcpEnv,
      createActivationTransport: typeof deps.createMcpActivationTransport === 'function' ? deps.createMcpActivationTransport : null,
      timeoutMs: deps.mcpTimeoutMs ?? null,
      ...(deps.mcpPollMs != null ? { pollMs: deps.mcpPollMs } : {}),
      log: (msg) => console.log(`[mcp-final-review] ${msg}`),
    })
    : null;

  // deps.createReviewTransport is a test seam ONLY: it lets a test prove the
  // prompt-build failure below never reaches a transport. Production keeps the
  // lazy Web2API/CDP transport bound to the resolved profile contract.
  const defaultReviewTransport = deps.finalReview
    || mcpLeg
    || (await (typeof deps.createReviewTransport === 'function' ? deps.createReviewTransport() : createLazyWeb2ApiTransport(cdpCfg)));

  // Shared tail cho CẢ HAI kênh verdict (clipboard web2api + MCP): normalize
  // -> provenance (chỉ web2api) -> REWORK boundary guard -> advisor consult.
  // Nhánh MCP tái sử dụng NGUYÊN VẸN khối này để REWORK handling không bao
  // giờ lệch giữa hai kênh.
  const finishReviewDecision = async (r, session, ctx) => {
    if (!(r && r.ok === true)) return r;
    const decisionPayload = r.value !== undefined ? r.value : r;
    const nd = normalizeReviewDecision({ decision: decisionPayload, session });
    if (nd.ok) {
      // MCP leg: binding/HEAD/digest canonical đã validate trong
      // validateMcpDecision (REVIEW_SUBMIT_MCP_*) trước khi về tới đây;
      // provenance web2api là contract riêng của đường clipboard.
      if (!deps.finalReview && !mcpLeg) {
        const linked = validateReviewProvenance({ decision: nd.value, session });
        if (!linked.ok) return linked;
      }
      // Boundary guard for rework.mjs:49/52: buildReworkRecord spreads
      // decision.findings / decision.evidenceRequests VERBATIM
      // ([...decision.findings] -> "decision.findings is not iterable").
      // A REWORK decision missing either array becomes a TYPED, observable
      // boundary error here — never an uncaught TypeError deeper in the FSM,
      // and never a data substitute (this check does NOT default them to []
      // and does NOT mutate nd.value; it is a pure read).
      if (nd.value.verdict === 'REWORK') {
        if (!Array.isArray(nd.value.findings)) {
          return { ok: false, code: 'REVIEW_DECISION_FINDINGS_MISSING', detail: `findings is ${nd.value.findings === undefined ? 'absent (undefined)' : typeof nd.value.findings}, not an array` };
        }
        if (!Array.isArray(nd.value.evidenceRequests)) {
          return { ok: false, code: 'REVIEW_DECISION_EVIDENCE_MISSING', detail: `evidenceRequests is ${nd.value.evidenceRequests === undefined ? 'absent (undefined)' : typeof nd.value.evidenceRequests}, not an array` };
        }
      }
      if (nd.value.verdict === 'REWORK' && !nd.value.advisorGuidance) {
        try {
          console.log('[SOC_RUNNER] Phat hien VERDICT: REWORK -> Tu dong kich hoat Advisor qua Chrome CDP 9222...');
          const advisorTransport = await createGeminiWeb2ApiAdvisorTransport({
            cdpPort: cdpCfg.port,
            host: cdpCfg.host,
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
  };

  // Reviewer Transport ho tro tu dong dong goi Prompt review
  const finalReview = async (ctx) => {
    // Publication refreshes HEAD and binds the PR after execution. The
    // admission snapshot cannot identify the version sent to the reviewer.
    const current = readSessionRecord(sessionPath);
    if (!current.ok) return fail('REVIEW_SESSION_UNREADABLE', current.reason ?? null);
    const session = current.session;
    if (mcpLeg) {
      // MCP leg tự lo packet resolution (exact-head), journal, activation
      // (đúng một lần mỗi lượt review, chống trùng khi resume) và poll
      // _decisions/. Text reply của activation KHÔNG BAO GIỜ được parse làm
      // verdict - chỉ record _decisions/ qua validateMcpDecision mới về được
      // đây. Không build reviewPrompt, không openReviewRound (packet
      // review-ready là SSOT cho MCP server), không đụng evidence chain.
      const mr = await mcpLeg({ sessionPath, session });
      return finishReviewDecision(mr, session, ctx);
    }
    // [EVIDENCE] The payload must carry evidence this identity/HEAD can actually
    // be held against. All three paths are resolved from the BOUND TASK SESSION
    // (packages/control-loop/review-evidence.mjs), never from this runner's
    // PROJECT_ROOT and never from a placeholder:
    //   (a) test log  <- the verifier's own ExecutionRecord -> its events log
    //   (b) bundle    <- session.worktreePath/artifacts/diffs/pr-N-changes.diff,
    //                    verified byte/sha against the reviewed changeset
    //   (c) changeset <- git diff origin/<pr base branch>...<session.headSha>
    //                    reconciled offline with session.controlLoop.prBinding
    let testLog = readExecutionTestLog({ session, verifyReport: ctx.report }).value;
    let bundleInfo = null;
    let diff = ctx.diff || '';
    let changeset = null;
    let scopeDiff = '';
    if (publishExec !== undefined) {
      const execGit = typeof deps.execGit === 'function'
        ? deps.execGit
        : (cmd, argv) => execFileSync(cmd, argv,
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const cs = buildPrChangeset({ session, exec: execGit });
      if (cs.ok) {
        diff = cs.value.diff;
        changeset = cs.value.meta;
        scopeDiff = cs.value.scopeDiff;
      } else if (cs.code === REVIEW_EVIDENCE_CODES.PR_HEAD_MISMATCH) {
        // The session's HEAD and the bound PR HEAD disagree. Shipping either
        // one as "the PR" would hand the reviewer an unreviewable payload.
        return fail(cs.code, cs.detail);
      } else {
        // No changeset we can prove: leave it EMPTY so the prompt builder
        // fail-closes with EMPTY_DIFF_CONTENT rather than shipping an
        // unproven diff.
        diff = '';
      }
      bundleInfo = buildBundleInfoForSession({
        session, prNumber: session.prNumber, prDiff: diff,
      }).value ?? null;
    }
    let reviewPrompt = null;
    try {
      const built = buildReviewPromptForSession({
        session: { ...session, repo, issueNumber, goal },
        testLog,
        bundleInfo,
        diff,
        changeset,
        scopeDiff,
      });
      if (!deps.finalReview && built && !built.ok) return fail(built.code, built.detail);
      if (built && built.ok === true) reviewPrompt = built.prompt;
    } catch (e) {
      if (!deps.finalReview) return fail('REVIEW_PAYLOAD_INVALID', String(e.message || e).slice(0, 240));
      reviewPrompt = null;
    }

    let request = null;
    if (!deps.finalReview) {
      const storeDir = path.join(path.dirname(sessionPath), '..', 'web2api-review-requests', path.basename(sessionPath, '.json'));
      // A FINAL_REVIEWING resume re-consumes the round the FSM never consumed
      // instead of opening a second one: a round is keyed by canonical identity
      // + repo/issue/PR/HEAD + this checkpoint's unconsumed decision evidence,
      // and the chosen round keeps its OWN stored prompt and digests (never
      // recomputed from this turn's timestamped prompt). An ambiguous match
      // typed-blocks here — before any request record is written and before the
      // transport can claim a browser submit.
      const consumedRequestIds = readTransitions({ stateDir, identityHash: id })
        .map((record) => record?.evidence?.provenance?.requestId)
        .filter((requestId) => typeof requestId === 'string' && requestId);
      const opened = openReviewRound({ session, prompt: reviewPrompt, storeDir, consumedRequestIds });
      if (!opened.ok) return opened;
      request = opened.value;
      reviewPrompt = opened.prompt;
    }
    const r = await defaultReviewTransport({
      ...ctx,
      reviewPrompt,
      prompt: reviewPrompt,
      reviewRequest: request,
      session: { ...session, repo, issueNumber, goal },
      testLog,
      bundleInfo,
      diff,
    });

    // Shared tail (mới): normalize -> provenance (web2api) -> REWORK guard ->
    // advisor consult, dùng chung cho CẢ HAI kênh. Kênh web2api truyền kèm
    // evidence vừa resolve (testLog/diff theo ExecutionRecord + changeset của
    // main) để advisor prompt không mất active test evidence; MCP leg trả về
    // bằng ctx gốc (evidence của MCP nằm trong packet review-ready).
    return finishReviewDecision(r, session, { ...ctx, testLog, diff });
  };

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

  // ---- §C.1 instruction: caller input -> canonical persisted goal (claim) ----
  // Typed-block BEFORE any transition/dispatch: a resume with no provable
  // instruction must fail here, never reach the route/execute steps. The block
  // applies to the REAL dispatch path (the bounded executor below consumes the
  // instruction); an injected executor seam (tests/control) never reads it, so
  // it keeps the legacy null-instruction behavior.
  const instructionRes = resolveRunnerInstruction({ instruction, goal, session, sessionPath });
  const sourceTypedFailure = instructionRes && typeof instructionRes === 'object' && instructionRes.ok === false;
  if (sourceTypedFailure && typeof deps.executor !== 'function') {
    return fail(instructionRes.code, instructionRes.detail ?? null);
  }
  const effInstruction = sourceTypedFailure ? null : instructionRes;

  // ---- §D.1 pre-review uses the RAW reply transport (Issue #262), never the
  // final-review text-verdict parser. The pre-review prompt contract is strict
  // JSON { verdict: PASS|REWORK, findings, confidence, metadata } consumed by
  // gemini-pre-review's own parseGeminiReview(t.text): a VERDICT header is
  // neither required nor accepted at this stage (routing the reply through the
  // VERDICT: parser surfaced VERDICT_NOT_FOUND and BLOCKED PRE_REVIEWING on
  // otherwise-valid JSON replies). Final review keeps createLazyWeb2ApiTransport.
  const preReviewTransport = deps.preReviewTransport
    || (deps.preReview ? null : await createGeminiWeb2ApiRawLazyTransport({
      cdpPort: cdpCfg.port,
      host: cdpCfg.host,
      userDataDir: cdpCfg.userDataDir,
      profileDirectory: cdpCfg.profileDirectory,
      // REC-01 r3: bind every emitted stage-observation marker to THIS
      // canonical identity (the observer knows which session it watches).
      identityHash: id,
    }));

  const runDeps = {
    // The CLI owns the real git transport; presence activates the canonical
    // post-executor publish chain before the review boundary.
    pushExec: publishExec,
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
    // Issue #263 F4(1): the control plane runs the repository's own test:gate
    // at VERIFY and brackets it with its own before/after snapshots + raw log.
    // A test target that cannot be proven fails VERIFY (typed ACTIVE_TEST_GATE_*
    // code) instead of reaching the reviewer with no evidence at all.
    verifier: deps.verifier || preGateReviewVerifierAdapter({
      innerVerifier: deterministicVerifierAdapter({
        activeTestRunner: createActiveTestRunner(),
      }),
      transport: typeof deps.reviewTransport === 'function' ? deps.reviewTransport : createOcrReviewTransport({}),
      timeoutMs: deps.reviewTimeoutMs ?? 600000,
    }),
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
    [--cdp-port <n>] [--cdp-host <host>] [--cdp-user-data-dir <path>] [--cdp-profile-directory <name>]

Operator/control-plane pre-submit boundary reconciliation (REWORK F3-cli; takes over main(), never enters the full loop):
  node bin/soc-control-loop.mjs --reconcile-pre-submit --repo <owner/name> --issue <N> --state-dir <dir> \\
    --checkpoint-ts <ISO> --checkpoint-reason <reason> --checkpoint-evidence <code> --evidence <path> \\
    [--checkpoint-attempt <transport-attempt-id>] [--source <str>] [--basis <str>]
  The boundary observation is DERIVED from the transport stage-observation marker line inside --evidence
  (never caller-claimed); the marker must bind THIS canonical identity and --checkpoint-attempt when given.
  REC-01 r4: --checkpoint-attempt is verified against the CANONICAL failure evidence (ledger
  evidence.detail.attemptId) BEFORE any grant - omitting it, or passing a value that disagrees with the
  ledger, is a typed block (CHECKPOINT_ATTEMPT_LINK_MISSING / CHECKPOINT_ATTEMPT_MISMATCH) with no record.
  Admitted through the Session Authority under the canonical soc_control lane;
  the entry releases ONLY a grant it minted itself (a caller-held fence is never touched).

CDP profile contract is also readable from env GEMINI_CDP_PORT / GEMINI_CDP_HOST / SOC_CDP_USER_DATA_DIR / SOC_CDP_PROFILE_DIRECTORY (SOC_CWA_* is CWA-only).
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

  // REWORK F3-cli (REC-01 rework round 2): the Operator/control-plane
  // pre-submit boundary reconciliation entry. It takes over main() entirely —
  // it NEVER enters the full control loop, never spawns transports, never
  // touches soc_control permission or the Gateway recover contract. The
  // observation is always DERIVED from the transport stage-observation marker
  // inside --evidence (never caller-claimed), so a legacy checkpoint without a
  // proven marker fails closed BEFORE admission with no grant minted.
  if (args.reconcilePreSubmit) {
    if (!args.repo || !args.issue || !args.stateDir || !args.checkpointTs
      || !args.checkpointReason || !args.checkpointEvidence || !args.evidence) {
      process.stdout.write(USAGE);
      process.exit(2);
    }
    const outcome = await reconcilePreSubmitBoundary({
      stateDir: args.stateDir,
      identityHash: identityHash({ repo: args.repo, issueNumber: args.issue }),
      checkpoint: {
        ts: args.checkpointTs,
        reason: args.checkpointReason,
        evidence: args.checkpointEvidence,
        ...(typeof args.checkpointAttempt === 'string' && args.checkpointAttempt.trim() ? { attemptId: args.checkpointAttempt } : {}),
      },
      source: args.source || 'soc-control-loop-cli',
      basis: args.basis || 'operator-initiated pre-submit boundary reconciliation via soc-control-loop --reconcile-pre-submit',
      evidence: { path: args.evidence },
      observation: null, // F2-src: always derived from the evidence, never claimed
      handoffToRunner: false,
    });
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    process.exit(outcome.ok === true ? 0 : 1);
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
    cdpConfig: resolveCdpConfig({ overrides: { port: args.cdpPort, host: args.cdpHost, userDataDir: args.cdpUserDataDir, profileDirectory: args.cdpProfileDirectory } }),
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
