// client-control.mjs — Soc_brain client control surface (Issue #175).
//
// WHY: Cline/OpenCode (or any thin client) act as the human-facing UI for
// Soc_brain WITHOUT owning lifecycle. This module is a thin, authority-
// PRESERVING dispatcher: every capability maps to an EXISTING canonical
// primitive. It introduces NO parallel task/session store and NO new
// lifecycle. The canonical session FSM (runtime-sandbox), workspace, project
// identity (safe-git #30), control-loop ledger, executor reconcile (#160) and
// review/delivery binding remain the sole authorities.
//
// Hard rules enforced here (the MCP transport is the dumb pipe; the policy
// lives in this single reusable core so Cline and OpenCode share ONE contract):
//   * the client cannot terminalize (no taskFinish/taskBlock reachable);
//   * the client cannot merge (no delivery/mergePr/`gh pr merge` reachable);
//   * the client cannot mark review PASS (no verdict param, ever);
//   * the client never becomes the mutation owner (admission binds the CONTROL
//     lane from trusted config, never caller input; observation is read-only);
//   * repo identity is EXPLICIT + verified against the target checkout's real
//     git remote — there is NO process.cwd() fallback once identity is known;
//   * stale task/session/checkpoint/head binds fail closed;
//   * mutating calls are idempotent / reconcile-safe (no blind retry).
//
// `config` (stateDir/worktreesRoot/controlLane/transport deps) is supplied by
// the control plane that LAUNCHES this surface (see client-mcp.mjs env), NEVER
// by a tool caller. Tool callers supply only business intent (goal, repo,
// checkout path, issue, checkpoint, response, authorization binding).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeRemoteUrl, remoteIsCanonical, readRemoteUrl, readUpstreamHead } from '../safe-git/safe-git.mjs';
import { defaultWorktreesRoot, identityHash } from '../workspace/workspace.mjs';
import {
  defaultStateDir, taskStart, readSessionRecord, sessionPathFor,
  answerHumanGate as canonicalAnswerHumanGate, HUMAN_GATE_STATES,
} from '../runtime-sandbox/runtime-sandbox.mjs';
import { allocateLocalTaskNumber } from '../task-intake/local-task-allocator.mjs';
import { readTransitions } from '../control-loop/control-loop.mjs';
import { writeMergeAuthorization } from '../control-loop/merge-authorization.mjs';
import { readExecutionRecord, startExecution } from '../executor-launcher/executor-launcher.mjs';
import { reconcileExecutorLiveness } from '../executor-launcher/executor-reconcile.mjs';
import { readProgressRecord } from '../task-progress/task-progress.mjs';
import { recordAdapterBoot, recordTransportDisconnect, recordReattach, resolveRecoveryTarget, reportExecutionLiveness } from './recovery.mjs';

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA40_RE = /^[0-9a-f]{40}$/;
const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9._:@-]{8,128}$/;
const GOAL_MAX_BYTES = 8192;
const RESPONSE_MAX_BYTES = 8192;

// Canonical delivery/merge is bound to the Soc_brain repository (control-loop/
// delivery.mjs DELIVERY_CANONICAL_REPO). External repos are admitted + executed
// but never auto-delivered; a client merge authorization for a foreign repo is
// therefore out of the canonical merge path and fails closed.
export const CLIENT_MCP_SCHEMA_VERSION = '1';
export const DEFAULT_DELIVERY_CANONICAL_REPO = 'duongpdddic-droid/soc_brain';
export const CLIENT_CAPABILITIES = Object.freeze([
  'soc.submit_goal', 'soc.get_task', 'soc.get_progress',
  'soc.answer_human_gate', 'soc.request_review', 'soc.authorize_merge',
  'soc.cancel_task', 'soc.recover',
]);

function sha256hex(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }
function clientMcpDir({ stateDir }) { return path.join(path.resolve(stateDir), 'client-mcp'); }

// create-only durable write (Windows-safe, "no overwrite ever"), mirroring
// submit-decision atomicWriteJson: temp + linkSync (link fails EEXIST if the
// final path exists), never a rename over existing bytes.
function createOnlyJson(finalPath, value) {
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const tmp = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    try { fs.linkSync(tmp, finalPath); return { ok: true, created: true }; }
    catch (e) { if (e && e.code === 'EEXIST') return { ok: true, created: false }; throw e; }
  } finally { try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ } }
}
function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

// ---- trusted config ----------------------------------------------------------
export function readClientControlConfig(env = process.env, overrides = {}) {
  const stateDir = overrides.stateDir || env.SOC_CONTROL_STATE_DIR || defaultStateDir();
  const worktreesRoot = overrides.worktreesRoot || env.SOC_CONTROL_WORKTREES_ROOT || defaultWorktreesRoot();
  // The mutation-owner lane a control-plane admission binds (never caller input).
  // Absent => admission stays lane-UNBOUND (no anonymous mutation authority),
  // exactly like control-ui admitAndLaunch. The CLIENT is never the owner.
  const controlLane = overrides.controlLane !== undefined ? overrides.controlLane : (env.SOC_CONTROL_LANE || null);
  const deliveryCanonicalRepo = overrides.deliveryCanonicalRepo
    || env.SOC_DELIVERY_CANONICAL_REPO || DEFAULT_DELIVERY_CANONICAL_REPO;
  return { stateDir, worktreesRoot, controlLane, deliveryCanonicalRepo };
}

// ---- repo identity resolution (explicit, verified, no CWD fallback) ----------
export function resolveCanonicalRepo({ targetRepo, localCheckoutPath, exec = execFileSync } = {}) {
  if (typeof targetRepo !== 'string' || !targetRepo.trim()) {
    return { ok: false, reason: 'REPO_IDENTITY_MISSING', detail: 'submit requires an explicit targetRepo (owner/name or github URL).' };
  }
  const norm = normalizeRemoteUrl(targetRepo);
  if (!norm || !REPO_RE.test(norm)) {
    return { ok: false, reason: 'REPO_IDENTITY_UNRESOLVABLE', detail: String(targetRepo).slice(0, 120) };
  }
  if (typeof localCheckoutPath !== 'string' || !localCheckoutPath.trim()) {
    // This is the anti-CWD-fallback rule: with a canonical repo known we must
    // NOT resolve the working copy from the caller's process directory.
    return { ok: false, reason: 'REPO_CHECKOUT_PATH_REQUIRED', detail: 'explicit localCheckoutPath is required (no CWD fallback for a known canonical repo).' };
  }
  const checkoutPath = path.resolve(localCheckoutPath);
  if (!fs.existsSync(checkoutPath) || !fs.statSync(checkoutPath).isDirectory()) {
    return { ok: false, reason: 'REPO_CHECKOUT_UNREADABLE', detail: checkoutPath };
  }
  let url = '';
  try { url = readRemoteUrl({ remote: 'origin', cwd: checkoutPath, exec }); } catch { url = ''; }
  if (!remoteIsCanonical(url, norm)) {
    return { ok: false, reason: 'REPO_CHECKOUT_MISMATCH', expected: norm, remote: url, detail: checkoutPath };
  }
  return { ok: true, repo: norm, checkoutPath };
}

// ---- canonical target resolution for read/mutation by identity ---------------
function resolveSession({ repo, issueNumber, config }) {
  const norm = normalizeRemoteUrl(repo);
  if (!norm || !REPO_RE.test(norm)) return { ok: false, reason: 'REPO_IDENTITY_UNRESOLVABLE' };
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return { ok: false, reason: 'MISSING_ISSUE_NUMBER' };
  const h = identityHash({ repo: norm, issueNumber });
  if (!h) return { ok: false, reason: 'IDENTITY_UNSTABLE' };
  const sessionPath = sessionPathFor({ stateDir: config.stateDir, identityHash: h });
  const rs = readSessionRecord(sessionPath);
  if (!rs.ok) return { ok: false, reason: rs.reason === 'SESSION_NOT_FOUND' ? 'TASK_NOT_FOUND' : rs.reason, identityHash: h };
  // Belt-and-braces: the persisted session must belong to the presented repo +
  // issue. readSessionRecord already re-derives identity from the record; a
  // cross-repo handle cannot exist because the path is identity-addressed.
  if (String(rs.session.repo).toLowerCase() !== norm.toLowerCase() || Number(rs.session.issueNumber) !== issueNumber) {
    return { ok: false, reason: 'TASK_IDENTITY_MISMATCH', identityHash: h };
  }
  return { ok: true, identityHash: h, sessionPath, session: rs.session };
}

// Redact to a client-safe projection: NO lease token, NO absolute paths, NO
// secrets — canonical lifecycle facts + identity handles only.
// Lifecycle DETAILS are passthrough text from the canonical FSM events; some
// carry absolute worktree paths or lease-token prefixes ("lease <hex>…"), so
// they are redacted here (client surface = no secrets, no host paths).
function redactLifecycleDetail(detail) {
  if (typeof detail !== 'string') return detail;
  return detail
    .replace(/(worktree\s+)[^\s"']+/, '$1<redacted-path>')
    .replace(/(lease\s+)[0-9a-fA-F]{4,}[^\s"']*/, '$1<redacted>');
}
function projectSession(session, identityHashId) {
  const gate = session.humanGate || null;
  return {
    schemaVersion: CLIENT_MCP_SCHEMA_VERSION,
    taskId: session.taskId ?? null,
    identityHash: identityHashId,
    repo: session.repo ?? null,
    issueNumber: session.issueNumber ?? null,
    state: session.state ?? null,
    baseSha: session.baseSha ?? null,
    headSha: session.headSha ?? null,
    branch: session.branch ?? null,
    prNumber: session.prNumber ?? null,
    executionMode: session.executionMode ?? null,
    mutationOwner: (session.mutationOwner && session.mutationOwner.laneId) || null,
    humanGate: gate ? { state: gate.state ?? null, at: gate.at ?? null, note: gate.note ?? null, deliveryStatus: gate.deliveryStatus ?? null } : null,
    deliveryEvidence: session.deliveryEvidence ? { event: session.deliveryEvidence.event, status: session.deliveryEvidence.status, at: session.deliveryEvidence.at } : null,
    lifecycleTail: Array.isArray(session.lifecycle) ? session.lifecycle.slice(-8).map((e) => ({ event: e.event, at: e.at, detail: redactLifecycleDetail(e.detail ?? null) })) : [],
  };
}

// Client-safe view of the transport observability record: NO boot id, NO pids of
// adapter processes beyond the OS pid fact, NO absolute paths, NO secrets.
function observability(state) {
  if (!state || typeof state !== 'object') return null;
  return {
    transportState: state.transportState ?? null,
    lastDisconnectAt: state.lastDisconnectAt ?? null,
    lastDisconnectKind: state.lastDisconnectKind ?? null,
    lastRestartAt: state.lastRestartAt ?? null,
    lastReattachAt: state.lastReattachAt ?? null,
    restartCount: Number.isInteger(state.restartCount) ? state.restartCount : null,
    currentTaskIdentity: state.currentTaskIdentity ?? null,
    executionLiveness: state.executionLiveness ?? null,
    humanGateState: state.humanGateState ?? null,
    lastRecoveryReason: state.lastRecoveryReason ?? null,
  };
}

// ---- the client control surface ----------------------------------------------
export function createClientControl(config = {}) {
  const cfg = { ...readClientControlConfig(process.env, config), ...config };
  const exec = cfg.exec || execFileSync;
  const now = cfg.now || (() => new Date().toISOString());
  // One transport boot identity per adapter PROCESS (per control instance in
  // tests). Used ONLY for the client-namespace transport observability record;
  // it is not a lifecycle identity and never touches canonical state.
  if (!cfg.bootId) cfg.bootId = `mcp-${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

  // submitGoal — canonical admission (taskStart). Returns the stable identity.
  function submitGoal(args = {}) {
    const { goal, targetRepo, localCheckoutPath, clientRequestId } = args;
    let issueNumber = args.issueNumber;
    let executorPreference = args.executorPreference;
    if (typeof goal !== 'string' || !goal.trim()) return { ok: false, reason: 'GOAL_MISSING' };
    if (Buffer.byteLength(goal, 'utf8') > GOAL_MAX_BYTES) return { ok: false, reason: 'GOAL_TOO_LARGE', maxBytes: GOAL_MAX_BYTES };
    if (issueNumber !== undefined && issueNumber !== null && (!Number.isInteger(issueNumber) || issueNumber <= 0)) {
      return { ok: false, reason: 'MISSING_ISSUE_NUMBER' };
    }
    if (executorPreference != null && !['cline', 'opencode', 'auto'].includes(executorPreference)) {
      return { ok: false, reason: 'EXECUTOR_PREFERENCE_INVALID', allowed: ['cline', 'opencode', 'auto'] };
    }
    // Idempotency: a goal-only submit (no explicit issue) needs a stable
    // clientRequestId, else a retry would burn a NEW local number -> duplicate
    // task. With an explicit issueNumber, taskStart is already identity-idempotent.
    if (issueNumber == null) {
      if (typeof clientRequestId !== 'string' || !CLIENT_REQUEST_ID_RE.test(clientRequestId)) {
        return { ok: false, reason: 'SUBMIT_CLIENT_REQUEST_ID_REQUIRED', detail: 'a goal submit without an explicit issueNumber must carry a stable clientRequestId (>=8 chars) so retries reconcile to one canonical task.' };
      }
      const idemPath = path.join(clientMcpDir({ stateDir: cfg.stateDir }), 'submissions', `${sha256hex(clientRequestId)}.json`);
      const prior = readJsonSafe(idemPath);
      if (prior && prior.result) return { ...prior.result, replayed: true };
    }

    const repoRes = resolveCanonicalRepo({ targetRepo, localCheckoutPath, exec });
    if (!repoRes.ok) return repoRes;
    const { repo, checkoutPath } = repoRes;

    // base from the EXPLICIT canonical checkout, never process.cwd().
    const baseSha = readUpstreamHead({ branch: 'main', remote: 'origin', cwd: checkoutPath, exec });
    if (typeof baseSha !== 'string' || !SHA40_RE.test(baseSha)) {
      return { ok: false, reason: 'BASE_UNAVAILABLE', detail: `origin/main unreadable in canonical checkout for ${repo}` };
    }

    let localTask = false;
    if (issueNumber == null) {
      const alloc = allocateLocalTaskNumber({ stateDir: cfg.stateDir, clock: now });
      if (!alloc.ok) return { ok: false, reason: alloc.reason || 'LOCAL_TASK_ALLOCATION_FAILED', detail: alloc.detail || null };
      issueNumber = alloc.number;
      localTask = true;
    }

    // Canonical admission through taskStart. mutationLaneId = CONTROL-plane lane
    // (trusted config) or null -> unbound. NEVER the caller/client identity.
    const started = taskStart({
      repo, issueNumber, baseSha,
      worktreesRoot: cfg.worktreesRoot, stateDir: cfg.stateDir,
      controlCwd: checkoutPath, exec,
      taskContract: { title: `Soc_brain client goal #${issueNumber}`, body: goal },
      mutationLaneId: cfg.controlLane,
    });
    if (!started.ok) return { ok: false, reason: started.reason || 'TASK_START_FAILED', detail: started.detail || null, state: started.state ?? null, owner: started.owner ?? null };

    const rs = resolveSession({ repo, issueNumber, config: cfg });
    if (!rs.ok) return { ok: false, reason: rs.reason, detail: 'admitted but canonical session read-back failed' };

    const result = {
      ok: true,
      admitted: true,
      replayed: started.idempotent === true,
      taskId: rs.session.taskId ?? null,
      identityHash: rs.identityHash,
      repo,
      issueNumber,
      localTask,
      state: rs.session.state,
      baseSha,
      executorPreference: executorPreference || 'auto',
      humanActionRequired: HUMAN_GATE_STATES.includes(rs.session.state),
    };
    if (issueNumber != null && localTask && typeof clientRequestId === 'string') {
      const idemPath = path.join(clientMcpDir({ stateDir: cfg.stateDir }), 'submissions', `${sha256hex(clientRequestId)}.json`);
      createOnlyJson(idemPath, { schemaVersion: CLIENT_MCP_SCHEMA_VERSION, clientRequestId, result, at: now() });
    }

    // Executor routing is delegated to the persistent control plane via an
    // injected hook (production: a detached canonical executor launch that is
    // NOT a child of this client process -> client death cannot cancel it).
    // Absent a configured router the surface reports admitted-only, never
    // fakes execution. No duplicate: routeExecutor must be idempotent/reconcile-
    // safe (canonical startExecution already returns EXECUTION_ALREADY_RUNNING).
    if (typeof cfg.routeExecutor === 'function') {
      try {
        const routed = cfg.routeExecutor({ sessionPath: rs.sessionPath, session: rs.session, goal, executorPreference, config: cfg });
        result.execution = routed && routed.ok === false ? { status: routed.reason || 'ROUTE_FAILED' } : (routed || null);
      } catch (e) {
        result.execution = { status: 'ROUTE_ERROR', detail: String((e && e.message) || e) };
      }
    }
    return result;
  }

  // getTask — read-only canonical session (never a parallel store).
  function getTask(args = {}) {
    const repo = args.repo || args.targetRepo;
    const r = resolveSession({ repo, issueNumber: args.issueNumber, config: cfg });
    if (!r.ok) return r;
    return { ok: true, task: projectSession(r.session, r.identityHash) };
  }

  // getProgress — read-only loop/executor/step view (no lifecycle effect).
  function getProgress(args = {}) {
    const repo = args.repo || args.targetRepo;
    const r = resolveSession({ repo, issueNumber: args.issueNumber, config: cfg });
    if (!r.ok) return r;
    const out = { ok: true, identityHash: r.identityHash, taskId: r.session.taskId ?? null, state: r.session.state ?? null };
    out.humanActionRequired = HUMAN_GATE_STATES.includes(r.session.state);
    try {
      const transitions = readTransitions({ stateDir: cfg.stateDir, identityHash: r.identityHash });
      const tail = transitions.length ? transitions[transitions.length - 1] : null;
      out.loop = { position: transitions.length, currentStep: tail ? tail.to : 'ACCEPTED', history: transitions.map((t) => ({ from: t.from, to: t.to, reason: t.reason ?? null, at: t.ts ?? null })).slice(-20) };
    } catch { out.loop = null; }
    try {
      const pr = readProgressRecord({ stateDir: cfg.stateDir, identityHash: r.identityHash });
      if (pr.ok && pr.progress) out.progress = { currentStep: pr.progress.currentStep ?? null, totalSteps: pr.progress.totalSteps ?? null, executorId: pr.progress.executorId ?? null, executionEpoch: pr.progress.executionEpoch ?? null, steps: Array.isArray(pr.progress.steps) ? pr.progress.steps : [], message: pr.progress.message ?? null };
      else out.progress = null;
    } catch { out.progress = null; }
    try {
      const rec = readExecutionRecord({ stateDir: cfg.stateDir, repo: r.session.repo, issueNumber: r.session.issueNumber });
      if (rec.ok) {
        const live = reconcileExecutorLiveness(rec.record, { ...(cfg.isAlive ? { isAlive: cfg.isAlive } : {}), ...(cfg.readStartTime ? { readStartTime: cfg.readStartTime } : {}) });
        out.execution = { status: rec.record.terminalStatus || live.liveness, liveness: live.liveness, identityProven: live.identityProven, pid: rec.record.pid ?? null, processStartTime: rec.record.processStartTime ?? null, identityHash: rec.record.identityHash ?? null };
      } else { out.execution = null; }
    } catch { out.execution = null; }
    return out;
  }

  // answerHumanGate — relay a HUMAN answer through the canonical resume seam.
  // Exact task + session + checkpoint binding; accepted exactly once; stale/
  // wrong fail closed. The client NEVER synthesizes approval (response is data).
  function answerHumanGate(args = {}) {
    const repo = args.repo || args.targetRepo;
    const { checkpointAt, response } = args;
    if (typeof checkpointAt !== 'string' || !checkpointAt) return { ok: false, reason: 'GATE_CHECKPOINT_MISSING' };
    if (response != null && (typeof response !== 'string' || Buffer.byteLength(response, 'utf8') > RESPONSE_MAX_BYTES)) {
      return { ok: false, reason: 'GATE_RESPONSE_INVALID', maxBytes: RESPONSE_MAX_BYTES };
    }
    const r = resolveSession({ repo, issueNumber: args.issueNumber, config: cfg });
    if (!r.ok) return r;
    const res = canonicalAnswerHumanGate({ sessionPath: r.sessionPath, checkpointAt, response: typeof response === 'string' ? response : null });
    if (!res.ok) return { ok: false, reason: res.reason, state: res.state ?? null, currentCheckpointAt: res.currentCheckpointAt ?? null, presentedCheckpointAt: res.presentedCheckpointAt ?? null, identityHash: r.identityHash };
    return { ok: true, resumed: true, identityHash: r.identityHash, state: res.session.state };
  }

  // requestReview — NON-authoritative. Validates readiness prerequisites and
  // returns the canonical review handoff; optionally dispatches a canonical
  // review-continuation request through an injected control-plane hook. It has
  // no PASS/verdict parameter and cannot set one; reviewers/control-loop stay
  // authoritative. It performs no merge.
  function requestReview(args = {}) {
    const repo = args.repo || args.targetRepo;
    const r = resolveSession({ repo, issueNumber: args.issueNumber, config: cfg });
    if (!r.ok) return r;
    const s = r.session;
    const terminal = s.state === 'COMPLETED' || s.state === 'FAILED' || s.state === 'BLOCKED';
    // READY_FOR_REVIEW must reflect a REAL committed change, not just a 40-hex
    // head value: a detached executor that finished without committing leaves
    // headSha == baseSha (e.g. incident #9000006), which must NOT project as
    // ready. Readiness here stays non-authoritative (no verdict); the executor-
    // exit lifecycle projection is what legitimately advances headSha.
    const headPinned = typeof s.headSha === 'string' && SHA40_RE.test(s.headSha);
    const headDiffersFromBase = headPinned
      && !(typeof s.baseSha === 'string' && s.headSha.toLowerCase() === s.baseSha.toLowerCase());
    const headReady = headPinned && headDiffersFromBase;
    const review = {
      requested: true,
      canContinue: !terminal && headReady,
      policyAllowsClientInitiated: typeof cfg.routeReview === 'function',
      terminalStatus: headReady && !terminal ? 'READY_FOR_REVIEW' : s.state,
      bound: { repository: s.repo, issue: s.issueNumber, pullRequest: s.prNumber ?? null, headSha: s.headSha ?? null, baseSha: s.baseSha ?? null },
      note: 'Review decisions (PASS/REWORK/BLOCKED) are produced by the reviewer/final-review surfaces only. This request carries no verdict.',
    };
    if (typeof cfg.routeReview === 'function' && review.canContinue) {
      try { review.dispatch = cfg.routeReview({ sessionPath: r.sessionPath, session: s, config: cfg }) || null; }
      catch (e) { review.dispatch = { ok: false, reason: 'REVIEW_ROUTE_ERROR', detail: String((e && e.message) || e) }; }
    }
    return { ok: true, identityHash: r.identityHash, review };
  }

  // authorizeMerge — record an EXPLICIT human merge authorization bound to the
  // exact repository/issue/PR/reviewedHeadSha, validated against the authoritative
  // session. It performs NO merge and invokes no delivery transport. The canonical
  // delivery leg remains the only thing that can merge, and only on a validated
  // PASS at the same exact head. Stale/wrong head / wrong PR / foreign repo
  // fail closed. Idempotent (replayed identical authorization is a no-op; a
  // conflicting one is rejected).
  function authorizeMerge(args = {}) {
    const repo = args.repo || args.targetRepo;
    const { pullRequest, reviewedHeadSha, authorizedBy, clientRequestId } = args;
    if (typeof reviewedHeadSha !== 'string' || !SHA40_RE.test(reviewedHeadSha)) {
      return { ok: false, reason: 'REVIEWED_HEAD_SHA_INVALID', detail: 'reviewedHeadSha must be a 40-hex git SHA.' };
    }
    if (!Number.isInteger(pullRequest) || pullRequest <= 0) return { ok: false, reason: 'MISSING_PULL_REQUEST' };
    if (typeof authorizedBy !== 'string' || !authorizedBy.trim()) return { ok: false, reason: 'MISSING_AUTHORIZED_BY', detail: 'merge authorization must name the authorizing human.' };
    if (typeof clientRequestId !== 'string' || !CLIENT_REQUEST_ID_RE.test(clientRequestId)) {
      return { ok: false, reason: 'AUTHORIZE_CLIENT_REQUEST_ID_REQUIRED', detail: 'authorize_merge requires a stable clientRequestId (>=8 chars) for exactly-once replay safety.' };
    }
    const r = resolveSession({ repo, issueNumber: args.issueNumber, config: cfg });
    if (!r.ok) return r;
    const s = r.session;
    if (String(s.repo).toLowerCase() !== cfg.deliveryCanonicalRepo.toLowerCase()) {
      return { ok: false, reason: 'MERGE_AUTH_CANONICAL_REPO_ONLY', detail: `canonical merge authorization applies to ${cfg.deliveryCanonicalRepo}; foreign-repo delivery is not a canonical path.` };
    }
    if (s.state === 'COMPLETED' || s.state === 'FAILED' || s.state === 'BLOCKED') {
      return { ok: false, reason: 'SESSION_ALREADY_TERMINAL', state: s.state, detail: 'a terminalized attempt cannot receive a new merge authorization.' };
    }
    if (!(typeof s.headSha === 'string' && SHA40_RE.test(s.headSha))) {
      return { ok: false, reason: 'HEAD_UNBOUND', detail: 'the canonical session has no pinned reviewed HEAD yet.' };
    }
    if (s.headSha.toLowerCase() !== reviewedHeadSha.toLowerCase()) {
      return { ok: false, reason: 'HEAD_STALE', expected: s.headSha, presented: reviewedHeadSha };
    }
    if (Number(s.prNumber) !== Number(pullRequest)) {
      return { ok: false, reason: 'PR_MISMATCH', expected: s.prNumber ?? null, presented: pullRequest };
    }

    // Durable record is written by the CANONICAL producer so the delivery
    // consumer (control-loop/delivery.mjs#mergePr) reads exactly this schema.
    const w = writeMergeAuthorization({
      stateDir: cfg.stateDir, identityHash: r.identityHash, repo: s.repo, issue: s.issueNumber,
      pullRequest: Number(pullRequest), reviewedHeadSha, authorizedBy, clientRequestId, now,
    });
    if (!w.ok) return { ok: false, reason: w.code, detail: w.detail ?? null, existingBound: w.existingBound ?? null };
    return {
      ok: true, recorded: true, replayed: w.replayed === true, identityHash: r.identityHash, bound: w.bound,
      note: 'Canonical delivery remains the only merge executor; mergePr verifies this exact authorization and still requires a validated GPT PASS at the same head.',
    };
  }

  // cancelTask — FAIL CLOSED. There is no canonical, safe cross-process
  // cancellation path (only taskFinish(FAILED)/taskBlock(BLOCKED) terminal
  // transitions, which are lifecycle authority the client does not hold).
  function cancelTask() {
    return {
      ok: false,
      reason: 'CANCEL_NOT_SUPPORTED',
      detail: 'No canonical cancellation path exists in Soc_brain (nearest terminals are taskFinish(FAILED)/taskBlock(BLOCKED), which the client surface must not call). Refusing to invent a second lifecycle.',
    };
  }

  // ---- recover — MANUAL MCP restart / reattach (transport-level only) ----------
  // A fresh adapter process (after OpenCode restarts ONLY the soc-brain MCP
  // transport) reattaches to the SAME canonical task by re-reading canonical
  // state; the operator does NOT resubmit the goal and does NOT retype identity
  // when exactly one active task exists. This is READ/RECONCILE ONLY: it mints no
  // task/session/execution/owner, starts no executor, answers no gate, authorizes
  // no merge. It reuses the SAME primitives as get_task/get_progress so the
  // identity contract is never forked; every stale/foreign/ambiguous bind fails
  // closed. The only write is the client-namespace transport observability file
  // (<stateDir>/client-mcp/transport.json) — never canonical lifecycle state.
  function recover(args = {}) {
    recordAdapterBoot({ stateDir: cfg.stateDir, bootId: cfg.bootId });
    const target = resolveRecoveryTarget({
      stateDir: cfg.stateDir,
      repo: args.repo != null ? args.repo : args.targetRepo,
      issueNumber: args.issueNumber,
    });
    if (!target.ok) {
      const failed = { ok: false, transportState: 'RECOVERY_FAILED', reason: target.reason, detail: target.detail ?? null, candidates: target.candidates ?? null };
      const rec = recordReattach({ stateDir: cfg.stateDir, bootId: cfg.bootId, result: failed });
      return { ...failed, transport: observability(rec.state) };
    }
    const gt = getTask({ repo: target.repo, issueNumber: target.issueNumber });
    if (!gt.ok) {
      const failed = { ok: false, transportState: 'RECOVERY_FAILED', reason: gt.reason, detail: 'exact identity bind failed (fail closed)' };
      const rec = recordReattach({ stateDir: cfg.stateDir, bootId: cfg.bootId, result: failed });
      return { ...failed, transport: observability(rec.state) };
    }
    const gp = getProgress({ repo: target.repo, issueNumber: target.issueNumber });
    const identityHash = gt.task.identityHash;
    const executionLiveness = reportExecutionLiveness(gp.ok ? gp.execution : null);
    const humanGateState = gt.task.humanGate && HUMAN_GATE_STATES.includes(gt.task.state) ? 'WAITING' : 'NONE';
    const currentTaskIdentity = {
      repo: gt.task.repo, issueNumber: gt.task.issueNumber, identityHash, taskId: gt.task.taskId,
    };
    // Canonical identity binding proof (phase 5): the discovered/asked session's
    // identityHash must match the get_task projection AND (when an execution
    // record exists for the SAME attempt) the ExecutionRecord identityHash. A
    // cross-attempt/foreign record is never trusted (reconcile already denies it;
    // here we additionally refuse to label it as THIS task's recovered identity).
    const execution = gp.ok && gp.execution ? gp.execution : null;
    const identityBound = Boolean(identityHash)
      && (target.discovered ? target.discovered.identityHash === identityHash : true)
      && (!execution || execution.identityHash == null || execution.identityHash === identityHash);
    if (!identityBound) {
      const failed = { ok: false, transportState: 'RECOVERY_FAILED', reason: 'RECOVERY_IDENTITY_NOT_BOUND', detail: 'execution/session identityHash disagree; recovery refuses to bind a foreign attempt.' };
      const rec = recordReattach({ stateDir: cfg.stateDir, bootId: cfg.bootId, result: failed });
      return { ...failed, transport: observability(rec.state) };
    }
    const ok = {
      ok: true,
      transportState: 'RECOVERED',
      discovered: !target.exact,
      currentTaskIdentity,
      state: gt.task.state,
      executionLiveness,
      humanGateState,
      mutationOwner: gt.task.mutationOwner,
      execution: execution ? { pid: execution.pid ?? null, processStartTime: execution.processStartTime ?? null, liveness: executionLiveness, identityProven: execution.identityProven === true } : null,
      task: gt.task,
      progress: gp.ok ? gp.progress : null,
      loop: gp.ok ? gp.loop : null,
    };
    const rec = recordReattach({ stateDir: cfg.stateDir, bootId: cfg.bootId, result: { ...ok, currentTaskIdentity, executionLiveness, humanGateState } });
    return { ...ok, transport: observability(rec.state) };
  }

  function noteTransportDisconnect() {
    return recordTransportDisconnect({ stateDir: cfg.stateDir, bootId: cfg.bootId });
  }

  return { submitGoal, getTask, getProgress, answerHumanGate, requestReview, authorizeMerge, cancelTask, recover, noteTransportDisconnect, config: { stateDir: cfg.stateDir, worktreesRoot: cfg.worktreesRoot, controlLane: cfg.controlLane, bootId: cfg.bootId } };
}

// ---- canonical executor route seam (F1) ---------------------------------------
// The MINIMUM production seam that lets a lane-bound, admitted client task be
// consumed by the EXISTING control-plane/executor path. It reuses
// `executor-launcher.startExecution` verbatim — it does NOT invent a second
// lifecycle, launcher, or store. Authority is derived from the authoritative
// session record exactly as `control-loop/adapters.mjs#launchExecutorAdapter`
// does (lease token + binding re-read from session.controlPlane; never caller
// input). startExecution is the sole writer that creates the canonical
// ExecutionRecord (PID + immutable Win32 PROCESS_START_TIME), promotes the
// session to executionMode='executor', and enforces the single-execution dedup
// (EXECUTION_ALREADY_RUNNING) + the durable pre-spawn latch. A lane-UNBOUND
// interactive client is admitted-only (never launches); when the executor binary
// is not resolvable it fails closed (admitted, no executor, no fabricated state).
// Low-level deps (spawn/resolveExecutable/preflight/verifyAuthority/isAlive/
// clock) are injectable — the SAME sanctioned startExecution DI points used by
// tests/executor-launcher.test.mjs — so a deterministic REAL executor process can
// stand in for the (absent) opencode binary without faking the record or bind.
export function createCanonicalRouteExecutor(deps = {}) {
  const start = typeof deps.startExecution === 'function' ? deps.startExecution : startExecution;
  const fail = (reason, extra = {}) => ({ ok: false, reason, status: reason, ...extra });
  return function routeExecutor({ sessionPath, session, goal } = {}) {
    if (!sessionPath || !session || typeof session !== 'object') return fail('ROUTE_NO_SESSION');
    if (typeof goal !== 'string' || !goal.trim()) return fail('INSTRUCTION_REQUIRED');
    const cp = session.controlPlane || {};
    const stateDir = cp.stateDir || null;
    const bindingPath = cp.bindingPath || null;
    if (!stateDir || !bindingPath) return fail('BINDING_UNAVAILABLE');
    let binding = null;
    try { const j = JSON.parse(fs.readFileSync(bindingPath, 'utf8')); if (j && j.path && j.identityHash && j.taskId && j.repo) binding = j; } catch { /* fail closed below */ }
    if (!binding) return fail('BINDING_UNAVAILABLE');
    // leaseToken is re-read from the authoritative record (adapters parity), never
    // from a caller/tool input.
    const launchSession = { ...session, leaseToken: (session.lease && session.lease.token) || null };
    const inject = {};
    for (const k of ['spawn', 'resolveExecutable', 'preflight', 'isAlive', 'clock']) if (typeof deps[k] === 'function') inject[k] = deps[k];
    if (typeof deps.verifyAuthority === 'function') inject.verifyAuthority = deps.verifyAuthority;
    const r = start({
      sessionPath, session: launchSession, binding, instruction: goal,
      model: null, stateDir, // controlCwd defaults to the control-plane root (startExecution default), never the worktree
      ...inject,
    });
    if (!r) return fail('ROUTE_NO_HANDLE');
    if (r.ok !== true) return fail(r.reason || 'LAUNCH_FAILED', { detail: r.detail ?? null, cleanupRequired: r.cleanupRequired ?? false });
    return { ok: true, status: r.status || 'RUNNING', pid: r.pid ?? null, recordPath: r.recordPath ?? null };
  };
}

// ---- detached production route (manual-MCP-restart independence, #181) ---------
// The PRODUCTION client route must survive a restart of the transport that made
// it: launching the executor IN the adapter process would couple executor
// lifetime to the MCP stdio pipe (adapter kill -> broken-pipe child + lost
// exit-finalization monitor). This seam keeps ALL canonical authority in
// executor-launcher.startExecution but runs it in a DETACHED route worker
// (packages/client-mcp/route-worker.mjs) — a transport sibling, never an adapter
// child. Duplicate protection is unchanged (durable pre-spawn latch +
// EXECUTION_ALREADY_RUNNING inside startExecution); this adds no second guard,
// no second lifecycle and no new authority. The bounded result wait is a
// READ-only observation: on timeout the caller sees STARTING/NO_RESULT and the
// canonical record remains the truth.
export function createDetachedRouteExecutor(deps = {}) {
  const fail = (reason, extra = {}) => ({ ok: false, reason, status: reason, ...extra });
  const spawnImpl = typeof deps.spawnWorker === 'function' ? deps.spawnWorker
    : (opts) => nodeSpawn(opts.command, opts.args, opts.options);
  const workerPath = typeof deps.workerPath === 'string' ? deps.workerPath
    : path.join(path.dirname(fileURLToPath(import.meta.url)), 'route-worker.mjs');
  const waitMs = Number.isInteger(deps.waitMs) && deps.waitMs > 0 ? deps.waitMs : 15000;
  // Synchronous bounded poll (the submitGoal contract is sync on the stdio wire;
  // same Atomics.wait pattern executor-launcher uses for its prove-loops).
  const sleepSync = typeof deps.sleep === 'function' ? deps.sleep
    : (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* non-blocking env */ } };
  let seq = 0;
  return function routeExecutor({ sessionPath, session, goal } = {}) {
    if (!sessionPath || !session || typeof session !== 'object') return fail('ROUTE_NO_SESSION');
    if (typeof goal !== 'string' || !goal.trim()) return fail('INSTRUCTION_REQUIRED');
    const cp = session.controlPlane || {};
    const stateDir = cp.stateDir || null;
    if (!stateDir || !session.identityHash) return fail('BINDING_UNAVAILABLE');
    const reqDir = path.join(path.resolve(stateDir), 'client-mcp', 'routes');
    const requestPath = path.join(reqDir, `${session.identityHash}.${process.pid}.${++seq}.json`);
    const resultPath = `${requestPath}.result.json`;
    try {
      fs.mkdirSync(reqDir, { recursive: true });
      fs.writeFileSync(requestPath, `${JSON.stringify({
        kind: 'soc-executor-route-request', schemaVersion: '1',
        sessionPath, stateDir, goal, requestedAt: new Date().toISOString(),
      }, null, 2)}\n`, 'utf8');
    } catch (e) {
      return fail('ROUTE_REQUEST_WRITE_FAILED', { detail: String((e && e.message) || e) });
    }
    let worker = null;
    try {
      worker = spawnImpl({
        command: process.execPath, args: [workerPath, requestPath],
        options: { cwd: process.cwd(), detached: true, stdio: 'ignore', windowsHide: true, env: process.env },
      });
    } catch { worker = null; }
    if (!worker || !Number.isInteger(worker.pid)) return fail('ROUTE_WORKER_SPAWN_FAILED');
    try { if (typeof worker.unref === 'function') worker.unref(); } catch { /* already detached */ }
    const deadline = Date.now() + waitMs;
    for (;;) {
      const res = readJsonSafe(resultPath);
      if (res) {
        if (res.ok === true) return { ok: true, status: res.status || 'RUNNING', pid: res.pid ?? null, recordPath: res.recordPath ?? null, detached: true };
        return fail(res.reason || 'LAUNCH_FAILED', { status: res.status || res.reason || 'LAUNCH_FAILED', pid: res.pid ?? null, detail: res.detail ?? null, detached: true });
      }
      if (Date.now() >= deadline) break;
      sleepSync(100);
    }
    // No result within the bounded wait: fall back to the canonical record —
    // READ-ONLY truth. A bound, live record means the detached worker is mid
    // launch (STARTING is the honest transport-side observation); a LATCHED or
    // absent record fails closed exactly like the direct seam would.
    try {
      const rec = readExecutionRecord({ stateDir, repo: session.repo, issueNumber: session.issueNumber });
      if (rec.ok && rec.record && rec.record.pid != null && rec.record.pendingExecutorBind !== true && !rec.record.terminalStatus) {
        return { ok: true, status: 'STARTING', pid: rec.record.pid, detached: true, detail: 'route worker still finalizing the canonical bind; observe via soc.get_progress' };
      }
    } catch { /* fail closed below */ }
    return fail('ROUTE_WORKER_NO_RESULT', { detail: 'detached route worker produced no result and no bound ExecutionRecord; the durable latch (if any) keeps mutation denied until canonical reconcile.' });
  };
}
