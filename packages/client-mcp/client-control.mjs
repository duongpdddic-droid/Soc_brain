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
import { execFileSync } from 'node:child_process';
import { normalizeRemoteUrl, remoteIsCanonical, readRemoteUrl, readUpstreamHead } from '../safe-git/safe-git.mjs';
import { defaultWorktreesRoot, identityHash } from '../workspace/workspace.mjs';
import {
  defaultStateDir, taskStart, readSessionRecord, sessionPathFor,
  answerHumanGate as canonicalAnswerHumanGate, HUMAN_GATE_STATES,
} from '../runtime-sandbox/runtime-sandbox.mjs';
import { allocateLocalTaskNumber } from '../task-intake/local-task-allocator.mjs';
import { readTransitions } from '../control-loop/control-loop.mjs';
import { readExecutionRecord } from '../executor-launcher/executor-launcher.mjs';
import { reconcileExecutorLiveness } from '../executor-launcher/executor-reconcile.mjs';
import { readProgressRecord } from '../task-progress/task-progress.mjs';

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
  'soc.cancel_task',
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
    lifecycleTail: Array.isArray(session.lifecycle) ? session.lifecycle.slice(-8).map((e) => ({ event: e.event, at: e.at, detail: e.detail ?? null })) : [],
  };
}

// ---- the client control surface ----------------------------------------------
export function createClientControl(config = {}) {
  const cfg = { ...readClientControlConfig(process.env, config), ...config };
  const exec = cfg.exec || execFileSync;
  const now = cfg.now || (() => new Date().toISOString());

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
        out.execution = { status: rec.record.terminalStatus || live.liveness, liveness: live.liveness, identityProven: live.identityProven, pid: rec.record.pid ?? null };
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
    const headReady = typeof s.headSha === 'string' && SHA40_RE.test(s.headSha);
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

    const record = {
      schemaVersion: CLIENT_MCP_SCHEMA_VERSION,
      kind: 'MERGE_AUTHORIZATION',
      bound: { repository: s.repo, issue: s.issueNumber, pullRequest: Number(pullRequest), reviewedHeadSha: reviewedHeadSha.toLowerCase() },
      authorizedBy,
      clientRequestId,
      at: now(),
      performsMerge: false,
    };
    const digest = sha256hex(JSON.stringify(record.bound));
    const finalPath = path.join(clientMcpDir({ stateDir: cfg.stateDir }), 'merge-authz', `${r.identityHash}.json`);
    const w = createOnlyJson(finalPath, { ...record, digest });
    if (!w.created) {
      const existing = readJsonSafe(finalPath);
      if (existing && existing.digest === digest) {
        return { ok: true, recorded: true, replayed: true, identityHash: r.identityHash, bound: record.bound, note: 'An identical authorization already exists (exactly-once).' };
      }
      return { ok: false, reason: 'DUPLICATE_CONFLICT', detail: 'a different merge authorization already exists for this canonical attempt.', existingBound: existing && existing.bound || null };
    }
    return { ok: true, recorded: true, replayed: false, identityHash: r.identityHash, bound: record.bound, note: 'Canonical delivery remains the only merge executor and requires a validated PASS at this exact head.' };
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

  return { submitGoal, getTask, getProgress, answerHumanGate, requestReview, authorizeMerge, cancelTask, config: { stateDir: cfg.stateDir, worktreesRoot: cfg.worktreesRoot, controlLane: cfg.controlLane } };
}
