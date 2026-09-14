#!/usr/bin/env node
// runtime-sandbox.mjs - Soc_brain: provider-neutral harness boundary (Issue #18).
// Minimal vertical slice: task_start admission, fail-closed guards, evidence.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  provision, defaultWorktreesRoot,
  identityHash, worktreeBranchFor,
  verifyBinding, worktreePathFor, bindingPathFor,
  SHA40_RE,
} from '../workspace/workspace.mjs';
import {
  gitRoot, readBranchInfo, readLocalHead,
  normalizeRemoteUrl, readRemoteUrl, remoteIsCanonical,
} from '../safe-git/safe-git.mjs';
import { buildStableTaskId } from '../task-intake/task-intake.mjs';
import { isInside, isReparsePoint } from '../temp-hygiene/temp-hygiene.mjs';
import { createExecutionBroker } from '../execution-broker/execution-broker.mjs';
import { guardOperation } from '../permission-orchestration/permission-orchestration.mjs';
import { buildOpenCodeConfig, writeOpenCodeConfig, readOpenCodeConfigDigest, PINNED_OPENCODE_VERSION } from './opencode-adapter.mjs';
import { dispatchLifecycleEvent, recoverLifecycleEvent } from '../telegram-dispatch/telegram-dispatch.mjs';
import { createRecorder } from '../soc-score/soc-score.mjs';

export const SANDBOX_SCHEMA_VERSION = '1';
// Issue #49: 'commit' is the single bounded mutator capability granted to the
// executor surface (canonical message + task-scoped paths only; no shell, no
// argv, no arbitrary git verbs). status/diff/run_registered_test stay read-only.
export const ALLOWED_OPERATIONS = ['status', 'diff', 'run_registered_test', 'commit'];

// ---- Issue #145: single mutation owner per canonical attempt -----------------
// North Star v2.1.0 invariant 15: at most ONE active mutation owner per
// canonical attempt; conflicts fail closed; ownership moves only through the
// explicit Soc_brain transfer API. The owner is a STABLE lane identity string
// supplied by the control plane at admission (never a process name or pid —
// process mechanics must not mint or prove ownership). The record lives on the
// authoritative session (control-plane state), re-read on every authority-
// sensitive request. Absent record = legacy session: unchanged behavior.
export const MUTATION_LANE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,199}$/;
// Bounded evidence: at most the last 8 transfers are retained in history.
export const MUTATION_OWNER_HISTORY_MAX = 8;

export function validateMutationLaneId(laneId) {
  if (laneId === undefined || laneId === null) return { ok: true, laneId: null };
  if (typeof laneId !== 'string' || !MUTATION_LANE_ID_RE.test(laneId)) {
    return { ok: false, reason: 'MUTATION_LANE_ID_INVALID', laneId: String(laneId).slice(0, 64) };
  }
  return { ok: true, laneId };
}

// ---- control-plane session state (GPT-REV-136/137/140) ----------------------
// Authoritative task state lives OUTSIDE every worktree, under a machine-local
// control-plane state dir (~/.soc-brain/state). The worktree-local
// opencode.json is a NON-authoritative projection: it carries only pointers
// (session path + lease token), never repo/issue/baseSha/registry authority.
export const SESSION_SCHEMA_VERSION = '1';
// Deterministic lifecycle projection (Issue #18 Orca amendment / GPT-REV-140).
// taskStart emits the four admission events; BLOCKED|COMPLETED|FAILED are
// terminal states recorded by later task operations (taskFinish/taskBlock/
// taskRequestHumanGate — Issue #65).
export const LIFECYCLE_EVENTS = Object.freeze([
  'TASK_START_REQUESTED', 'CONTRACT_PINNED', 'WORKSPACE_ADMITTED',
  'SESSION_ACTIVE', 'BLOCKED', 'COMPLETED', 'FAILED',
]);
export const TASK_PACKET_MAX_BYTES = 8192;

export function defaultStateDir() {
  return path.join(os.homedir(), '.soc-brain', 'state');
}

export function sessionPathFor({ stateDir, identityHash: h }) {
  return path.join(path.resolve(stateDir), 'sessions', `${h}.json`);
}

const run = (cmd, args, { cwd, exec = execFileSync } = {}) => {
  const out = exec(cmd, args, { cwd, encoding: 'utf8', windowsHide: true }); // no console flash on detached control plane
  return String(out).replace(/\r\n/g, '\n').trim();
};

function realPathOrNull(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

// ---- mainCheckoutGuard --------------------------------------------------------
// Fail-closed: rejects if the bound worktree resolves to (or inside) the main
// checkout, or shares the main checkout's Git directory (canonical checkout
// execution). GPT-REV-143: the deciding comparison is Git-dir EQUALITY, resolved
// by Git itself via `--absolute-git-dir` — never `path.resolve` against
// process.cwd(). A legitimate linked worktree (`git worktree add`) has a distinct
// per-worktree Git dir and is admitted; the main checkout (and any path inside
// it) resolves to the same Git dir as controlCwd and is rejected.
export function mainCheckoutGuard({ worktree, controlCwd, exec = execFileSync }) {
  let mainRoot;
  try { mainRoot = gitRoot({ cwd: controlCwd, exec }); } catch {
    return { ok: false, errors: [{ reason: 'NO_GIT_ROOT', detail: 'Cannot determine main checkout Git root.' }] };
  }
  const mainAbs = path.resolve(mainRoot);
  const wtReal = realPathOrNull(worktree);
  if (wtReal) {
    if (isInside(mainAbs, wtReal)) {
      return { ok: false, errors: [{ reason: 'WORKTREE_INSIDE_MAIN_CHECKOUT', detail: 'Bound worktree resolves inside the main checkout.' }] };
    }
    if (path.resolve(wtReal) === mainAbs) {
      return { ok: false, errors: [{ reason: 'WORKTREE_IS_MAIN_CHECKOUT', detail: 'Bound worktree IS the main checkout.' }] };
    }
  }
  try {
    const wtGitDir = run('git', ['rev-parse', '--absolute-git-dir'], { cwd: worktree, exec });
    const mainGitDir = run('git', ['rev-parse', '--absolute-git-dir'], { cwd: controlCwd, exec });
    if (wtGitDir === mainGitDir) {
      return { ok: false, errors: [{ reason: 'SHARED_MAIN_GIT_DIR', detail: 'Worktree shares the main checkout Git directory (canonical checkout execution).' }] };
    }
  } catch {
    return { ok: false, errors: [{ reason: 'WORKTREE_NOT_GIT', detail: 'Worktree path is not a Git repository.' }] };
  }
  return { ok: true };
}

// ---- symlinkEscapeGuard -------------------------------------------------------
// Fail-closed: rejects if the worktree path is a symlink/reparse point or its
// realpath escapes worktreesRoot.
export function symlinkEscapeGuard({ worktree, worktreesRoot, exec = execFileSync }) {
  const rootReal = realPathOrNull(worktreesRoot);
  const wtReal = realPathOrNull(worktree);
  if (!rootReal) return { ok: false, errors: [{ reason: 'ROOT_UNRESOLVABLE' }] };
  if (!wtReal) return { ok: false, errors: [{ reason: 'WORKTREE_UNRESOLVABLE' }] };
  if (isReparsePoint(worktree)) {
    return { ok: false, errors: [{ reason: 'WORKTREE_SYMLINK', detail: 'Worktree path is a symlink or reparse point.' }] };
  }
  if (!isInside(rootReal, wtReal)) {
    return { ok: false, errors: [{ reason: 'WORKTREE_ESCAPES_ROOT', detail: 'Worktree realpath escapes worktreesRoot.' }] };
  }
  return { ok: true };
}

// ---- buildEvidence ------------------------------------------------------------
export function buildEvidence({ binding, worktree, session, exec = execFileSync }) {
  const h = identityHash({ repo: binding.repo, issueNumber: binding.issueNumber });
  let headSha = null;
  let branchName = null;
  try { headSha = readLocalHead({ cwd: worktree, exec }); } catch {}
  try { const info = readBranchInfo({ cwd: worktree, exec }); branchName = info.branchName; } catch {}
  const configDigest = crypto.createHash('sha256').update(JSON.stringify({
    adapter: 'runtime-sandbox', adapterVersion: SANDBOX_SCHEMA_VERSION, capabilities: ALLOWED_OPERATIONS,
  })).digest('hex');
  const evidence = {
    schemaVersion: SANDBOX_SCHEMA_VERSION,
    adapter: 'runtime-sandbox', adapterVersion: SANDBOX_SCHEMA_VERSION,
    runtime: { node: process.version, platform: process.platform },
    configDigest,
    binding: {
      repo: binding.repo, issueNumber: binding.issueNumber,
      baseSha: binding.baseSha, identityHash: h,
      branch: worktreeBranchFor({ identityHash: h }),
    },
    worktree: { headSha, branchName },
    allowedCapabilities: ALLOWED_OPERATIONS,
  };
  if (session) evidence.session = session;
  return evidence;
}

// Deduplicating lifecycle append (GPT-REV-140): a repeated identical event
// never produces a second entry — deterministic projection, bounded size.
function pushEvent(events, event, detail) {
  const prev = events[events.length - 1];
  if (prev && prev.event === event && String(prev.detail ?? '') === String(detail ?? '')) return events;
  events.push({ event, at: new Date().toISOString(), detail: detail ?? null });
  return events;
}

// Provider-neutral TaskPacket (GPT-REV-140): bounded context projection built
// ONLY from authoritative state; fails closed over TASK_PACKET_MAX_BYTES.
export function buildTaskPacket({ session, maxBytes = TASK_PACKET_MAX_BYTES }) {
  if (!session || session.schemaVersion !== SESSION_SCHEMA_VERSION) {
    return { ok: false, reason: 'SESSION_STATE_REQUIRED', detail: 'buildTaskPacket requires an authoritative session record.' };
  }
  const contextRefs = [];
  const seen = new Set();
  for (const ref of [
    { kind: 'binding', path: session.controlPlane.bindingPath },
    { kind: 'session', path: session.controlPlane.sessionPath },
    { kind: 'opencodeConfig', path: session.projection.path, digest: session.projection.digest },
    { kind: 'worktree', path: session.binding.path },
  ]) {
    const key = `${ref.kind}|${ref.path}`;
    if (!seen.has(key)) { seen.add(key); contextRefs.push(ref); }
  }
  const packet = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    kind: 'TaskPacket',
    taskId: session.taskId,
    repo: session.repo,
    issueNumber: session.issueNumber,
    baseSha: session.baseSha,
    admittedHeadSha: session.headSha,
    branch: session.branch,
    verifiedWorktreeRoot: session.worktreePath,
    grantedCapabilities: session.capabilities,
    adapter: session.adapter,
    digests: session.digests,
    contextRefs,
    sizeBudget: { maxBytes, bytes: 0 },
  };
  const bytes = Buffer.byteLength(JSON.stringify(packet), 'utf8');
  if (bytes > maxBytes) {
    return { ok: false, reason: 'TASK_PACKET_BUDGET_EXCEEDED', bytes, maxBytes };
  }
  packet.sizeBudget.bytes = bytes;
  return { ok: true, packet, bytes, digest: crypto.createHash('sha256').update(JSON.stringify(packet)).digest('hex') };
}

// ---- task-contract projection (Issue #31 pilot) ------------------------------
// Write the canonical task contract (title + body) into the worktree root as
// SOC_TASK_CONTRACT.md and reference it via OpenCode `instructions` so the
// executor self-serves scope/acceptance without the user copy-pasting the Issue
// body. Bounded + fail-closed over TASK_CONTRACT_MAX_BYTES.
const TASK_CONTRACT_MAX_BYTES = 16384;

function writeTaskContract({ worktreePath, taskContract }) {
  if (!taskContract || typeof taskContract !== 'object') {
    return { ok: false, reason: 'MISSING_TASK_CONTRACT', detail: 'taskContract must be an object with { title, body }.' };
  }
  const title = typeof taskContract.title === 'string' ? taskContract.title.trim() : '';
  const body = typeof taskContract.body === 'string' ? taskContract.body.trim() : '';
  if (!title) return { ok: false, reason: 'MISSING_TASK_CONTRACT_TITLE', detail: 'taskContract.title is required.' };
  const md = `# Task Contract — ${title}\n\n${body}\n`;
  const bytes = Buffer.byteLength(md, 'utf8');
  if (bytes > TASK_CONTRACT_MAX_BYTES) {
    return { ok: false, reason: 'TASK_CONTRACT_BUDGET_EXCEEDED', bytes, maxBytes: TASK_CONTRACT_MAX_BYTES };
  }
  const p = path.join(path.resolve(worktreePath), 'SOC_TASK_CONTRACT.md');
  fs.writeFileSync(p, md, 'utf8');
  return { ok: true, path: p, bytes };
}

// Publish authoritative session state. No-clobber when the identity already
// has a live session (idempotent restart reuses the existing lease token);
// contract drift (different baseSha/repo/issue for the same identity) fails
// closed as TASK_CONTRACT_DRIFT.
function publishSessionRecord(sessionPath, record) {
  const dir = path.dirname(sessionPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(sessionPath)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.linkSync(tmp, sessionPath); // no-clobber: EEXIST when a session exists
    return { ok: true, created: true };
  } catch (e) {
    if (e && e.code === 'EEXIST') return { ok: true, created: false };
    return { ok: false, reason: 'SESSION_PUBLISH_FAILED', detail: String((e && e.message) || e) };
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
  }
}

// Read + validate an authoritative session record (fail-closed). The session
// must live at <stateDir>/sessions/<identityHash>.json derived from ITS OWN
// identity, so a tampered SOC_SESSION_PATH pointer cannot smuggle in foreign
// state (GPT-REV-136: authority never comes from the worktree).
export function readSessionRecord(sessionPath) {
  let raw;
  try { raw = fs.readFileSync(sessionPath, 'utf8'); }
  catch { return { ok: false, reason: 'SESSION_NOT_FOUND', path: sessionPath }; }
  let session;
  try { session = JSON.parse(raw); }
  catch (e) { return { ok: false, reason: 'SESSION_STATE_INVALID', detail: String((e && e.message) || e) }; }
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    return { ok: false, reason: 'SESSION_STATE_INVALID' };
  }
  if (session.schemaVersion !== SESSION_SCHEMA_VERSION) {
    return { ok: false, reason: 'SESSION_SCHEMA_MISMATCH', schemaVersion: session.schemaVersion };
  }
  const h = identityHash({ repo: session.repo, issueNumber: session.issueNumber });
  if (!h || path.resolve(sessionPath) !== sessionPathFor({ stateDir: path.dirname(path.dirname(sessionPath)), identityHash: h })) {
    return { ok: false, reason: 'SESSION_STATE_INVALID', detail: 'Session file is not at its canonical control-plane location.' };
  }
  return { ok: true, session };
}

// ---- createPermissionGuard -----------------------------------------------------
// Executor-independent orchestration bound to live session authority. On every
// `evaluate` it re-derives authority from the authoritative session (reuses
// verifySessionAuthority: lease token + projection digest + fail-closed guards +
// execution-root bind) and feeds the facts to the pure verdict engine. A
// binding/authority mismatch maps to DENY_AND_RECOVER (rerouteRoot = the
// canonical executionRoot); gate-classes and unknown ops map to
// BLOCKED_HUMAN_GATE; statically-authorized safe ops map to ALLOW.
export function createPermissionGuard({
  sessionPath, leaseToken,
  exec = execFileSync, controlCwd = process.cwd(),
  canonicalExecutionRoot = null,
} = {}) {
  function evaluate({ operation, targetPath, kind, executable, argv } = {}) {
    const v = verifySessionAuthority({ sessionPath, leaseToken, exec, controlCwd });
    if (!v.ok) {
      return guardOperation({
        operation, kind, targetPath, executable, argv,
        executionRoot: canonicalExecutionRoot, primaryCheckout: controlCwd,
        worktreesRoot: undefined, bindingOk: false, bindingReason: v.reason,
      });
    }
    const s = v.session;
    return guardOperation({
      operation, kind, targetPath, executable, argv,
      executionRoot: s.worktreePath, primaryCheckout: controlCwd,
      worktreesRoot: s.worktreesRoot, bindingOk: true,
    });
  }
  return { evaluate };
}

// ---- verifyExecutionRootBinding -----------------------------------------------
// Issue #18 acceptance (execution-root bind): the runtime session MUST be bound
// to its AUTHORIZED execution root — the isolated task worktree derived from the
// session identity (repo + issueNumber) under the session worktreesRoot, with a
// verifiable binding record. If the binding cannot be established (session lacks
// identity / execution-root fields, or the executing path is not the authorized
// worktree) or verified (verifyBinding: absent / malformed / identity-drifted /
// wrong Git state), the runtime fails closed WORKSPACE_SESSION_BIND_REQUIRED and
// edit/test MUST be denied. Reuses the existing binding contract (workspace.mjs);
// introduces no new authority or framework.
export function verifyExecutionRootBinding({ session, exec = execFileSync, controlCwd = process.cwd() }) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    return { ok: false, reason: 'WORKSPACE_SESSION_BIND_REQUIRED', detail: 'No authoritative session; execution-root binding not established.' };
  }
  const h = identityHash({ repo: session.repo, issueNumber: session.issueNumber });
  if (!h || typeof session.worktreesRoot !== 'string' || !session.worktreesRoot || typeof session.worktreePath !== 'string' || !session.worktreePath) {
    return { ok: false, reason: 'WORKSPACE_SESSION_BIND_REQUIRED', detail: 'Session lacks identity/worktree fields; execution-root binding not established.' };
  }
  const authorizedPath = path.resolve(worktreePathFor({ worktreesRoot: path.resolve(session.worktreesRoot), identityHash: h }));
  const execRoot = path.resolve(session.worktreePath);
  if (execRoot !== authorizedPath) {
    return { ok: false, reason: 'WORKSPACE_SESSION_BIND_REQUIRED', detail: `Session execution root ${execRoot} is not the authorized worktree ${authorizedPath}.`, authorizedPath, worktreePath: execRoot };
  }
  const vb = verifyBinding({
    worktreesRoot: session.worktreesRoot,
    repo: session.repo,
    issueNumber: session.issueNumber,
    baseSha: session.baseSha,
    cwd: controlCwd,
    exec,
  });
  if (!vb.ok) {
    return { ok: false, reason: 'WORKSPACE_SESSION_BIND_REQUIRED', detail: `Execution-root binding not verifiable: ${vb.reason}.`, verify: vb };
  }
  if (path.resolve(vb.path) !== execRoot) {
    return { ok: false, reason: 'WORKSPACE_SESSION_BIND_REQUIRED', detail: 'Binding worktree path disagrees with the session execution root.' };
  }
  return { ok: true, binding: vb, path: execRoot };
}

// Live fencing (GPT-REV-136/137): re-reads the authoritative session on EVERY
// authority-sensitive request, compares the lease token, verifies the worktree
// opencode.json digest against the control-plane projection digest, then runs
// the fail-closed guards. Authority is always re-derived from session state,
// never from caller-supplied/env values.
export function verifySessionAuthority({ sessionPath, leaseToken, exec = execFileSync, controlCwd = process.cwd(), requiredCapability = null }) {
  const rs = readSessionRecord(sessionPath);
  if (!rs.ok) return rs;
  const s = rs.session;
  if (typeof leaseToken !== 'string' || !leaseToken || s.lease?.token !== leaseToken) {
    return { ok: false, reason: 'STALE_TASK_LEASE' };
  }
  const proj = readOpenCodeConfigDigest({ worktreePath: s.worktreePath });
  if (!proj.ok || proj.digest !== s.digests?.opencodeConfig) {
    return { ok: false, reason: 'RUNTIME_CONFIGURATION_MISMATCH' };
  }
  const mg = mainCheckoutGuard({ worktree: s.worktreePath, controlCwd, exec });
  if (!mg.ok) return { ok: false, reason: 'FORBIDDEN_CANONICAL_CHECKOUT', guard: mg.errors };
  const sg = symlinkEscapeGuard({ worktree: s.worktreePath, worktreesRoot: s.worktreesRoot, exec });
  if (!sg.ok) return { ok: false, reason: 'WORKSPACE_ADMISSION_REJECTED', guard: sg.errors };
  // Issue #18 acceptance (execution-root bind): the session MUST be bound to its
  // authorized execution root. Missing/invalid/forged binding -> fail closed
  // WORKSPACE_SESSION_BIND_REQUIRED so edit/test is denied.
  const eb = verifyExecutionRootBinding({ session: s, exec, controlCwd });
  if (!eb.ok) return eb;
  // Issue #49 (Gap B): optional per-request capability gate. The bounded commit
  // capability is only admissible for sessions that were admitted WITH it in
  // their authoritative capabilities set — pre-#49 sessions, degraded grants,
  // and tampered session records fail closed (CAPABILITY_NOT_GRANTED).
  if (requiredCapability !== null) {
    if (!Array.isArray(s.capabilities) || !s.capabilities.includes(requiredCapability)) {
      return { ok: false, reason: 'CAPABILITY_NOT_GRANTED', capability: requiredCapability };
    }
  }
  return { ok: true, session: s };
}

// Issue #145 F2: conflict evidence MUST bind BOTH lanes and the canonical
// artifact (repo/issue/branch/worktree) — never a lease token or secret.
function ownershipConflictArtifact(session) {
  return {
    repo: session.repo ?? null,
    issueNumber: session.issueNumber ?? null,
    branch: session.branch ?? null,
    worktreePath: session.worktreePath ?? null,
  };
}

// ---- Issue #145: admission ownership gate -------------------------------------
// Deterministic single-owner decision for taskStart's idempotent-reuse path.
//   terminal state          -> SESSION_ALREADY_TERMINAL (a terminal attempt is
//                              never revived through re-admission, by anyone)
//   recorded owner + presented lane differs/absent -> MUTATION_OWNER_CONFLICT
//                              (fail closed; the caller never learns the lease
//                              and no canonical state is written)
//   recorded owner + same lane -> resume (the authorized owner continues)
//   no recorded owner + lane   -> adopt: the serialized transition primitive
//                              binds the named lane (explicit control-plane
//                              migration for a legacy/unbound attempt)
//   no recorded owner + no lane-> the attempt stays UNBOUND: admission is legal
//                              but it grants NO mutation authority (every
//                              mutation surface fails closed until a named
//                              admission/adoption binds an owner — rework F1:
//                              no anonymous mutation authority in production).
export function admissionOwnershipGate(session, presentedLaneId) {
  if (session.state === 'COMPLETED' || session.state === 'FAILED' || session.state === 'BLOCKED') {
    return { ok: false, reason: 'SESSION_ALREADY_TERMINAL', state: session.state };
  }
  const owner = session.mutationOwner || null;
  if (!owner || !owner.laneId) {
    if (presentedLaneId) return { ok: true, adopt: presentedLaneId };
    return { ok: true };
  }
  if (presentedLaneId === owner.laneId) return { ok: true };
  return {
    ok: false,
    reason: 'MUTATION_OWNER_CONFLICT',
    owner: { laneId: owner.laneId, since: owner.since ?? null, acquiredVia: owner.acquiredVia ?? null },
    ownerLaneId: owner.laneId,
    presented: presentedLaneId ?? null,
    presentedLaneId: presentedLaneId ?? null,
    artifact: ownershipConflictArtifact(session),
    detail: 'Another mutation owner is recorded for this canonical attempt; ownership moves only through the explicit transfer API.',
  };
}

function buildMutationOwner(laneId, acquiredVia, now, extra = {}) {
  return {
    laneId,
    since: now(),
    acquiredVia,
    history: [],
    ...extra,
  };
}

// ---- Issue #145 rework F2: serialized ownership transition primitive ----------
// ONE canonical atomic/serialized path for every ownership mutation (adoption
// at admission, explicit transfer). Critical section (create-exclusive lock
// file beside the session record): read the authoritative session INSIDE the
// section -> validate the EXPECTED current owner (or absence for adoption) ->
// persist -> read-back verify -> release. Contention fails closed after a
// bounded retry (MUTATION_OWNER_LOCK_BUSY, retryable); the lock is never
// broken by pid/timeout heuristics (ownership is persisted state, not process
// mechanics). No last-writer-wins: a concurrent transition whose expected
// owner no longer matches fails as MUTATION_OWNER_CONFLICT.
export const OWNERSHIP_LOCK_RETRIES = 20;
export const OWNERSHIP_LOCK_RETRY_MS = 25;

export function ownershipLockPath(sessionPath) {
  return `${sessionPath}.ownership.lock`;
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* non-blocking env */ }
}

function withOwnershipLock(sessionPath, fn) {
  const lockPath = ownershipLockPath(sessionPath);
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { /* publish-side mkdir covers it */ }
  let held = false;
  for (let i = 0; i < OWNERSHIP_LOCK_RETRIES && !held; i++) {
    try { fs.closeSync(fs.openSync(lockPath, 'wx')); held = true; }
    catch (e) {
      if (e && e.code === 'EEXIST') { if (i < OWNERSHIP_LOCK_RETRIES - 1) sleepSync(OWNERSHIP_LOCK_RETRY_MS); continue; }
      return { ok: false, reason: 'OWNERSHIP_LOCK_UNAVAILABLE', detail: String((e && e.message) || e) };
    }
  }
  if (!held) return { ok: false, reason: 'MUTATION_OWNER_LOCK_BUSY', detail: 'Another ownership transition holds the critical section; retry this admission/transfer.' };
  try { return fn(); }
  finally { try { fs.rmSync(lockPath, { force: true }); } catch { /* best-effort release */ } }
}

// expectOwnerLaneId: the current owner the caller believes is active (null =
// unbound). The transition applies ONLY while that expectation holds inside
// the critical section; otherwise fail closed.
function applyOwnershipTransition({
  sessionPath, expectOwnerLaneId, toLaneId, acquiredVia, via = null,
  now = () => new Date().toISOString(),
} = {}) {
  return withOwnershipLock(sessionPath, () => {
    const rs = readSessionRecord(sessionPath);
    if (!rs.ok) return { ok: false, reason: rs.reason, path: sessionPath };
    const session = rs.session;
    if (session.state === 'COMPLETED' || session.state === 'FAILED' || session.state === 'BLOCKED') {
      return { ok: false, reason: 'SESSION_ALREADY_TERMINAL', state: session.state };
    }
    const current = (session.mutationOwner && session.mutationOwner.laneId) || null;
    if (current === expectOwnerLaneId) {
      // expected state holds: apply the transition.
    } else if (expectOwnerLaneId !== null && !current) {
      return { ok: false, reason: 'MUTATION_OWNER_UNBOUND', expected: expectOwnerLaneId, presented: toLaneId, artifact: ownershipConflictArtifact(session), detail: 'No active mutation owner is recorded on this attempt; bind one through a named admission/adoption first.' };
    } else {
      return {
        ok: false,
        reason: 'MUTATION_OWNER_CONFLICT',
        owner: current ? { laneId: current, since: session.mutationOwner.since ?? null, acquiredVia: session.mutationOwner.acquiredVia ?? null } : null,
        ownerLaneId: current,
        expected: expectOwnerLaneId,
        presented: toLaneId,
        presentedLaneId: toLaneId,
        artifact: ownershipConflictArtifact(session),
        detail: 'The authoritative current owner differs from the expected owner at transition time; fail closed (no last-writer-wins).',
      };
    }
    const history = current && Array.isArray(session.mutationOwner.history)
      ? session.mutationOwner.history.slice(-1 * (MUTATION_OWNER_HISTORY_MAX - 1)) : [];
    if (current) {
      history.push({
        laneId: current,
        since: session.mutationOwner.since ?? null,
        until: now(),
        via: typeof via === 'string' && via ? via.slice(0, 200) : null,
      });
    }
    session.mutationOwner = { laneId: toLaneId, since: now(), acquiredVia, history };
    try {
      fs.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
    } catch (e) {
      return { ok: false, reason: 'SESSION_WRITE_FAILED', detail: String((e && e.message) || e) };
    }
    const back = readSessionRecord(sessionPath);
    if (!back.ok || !(back.session.mutationOwner && back.session.mutationOwner.laneId === toLaneId)) {
      return { ok: false, reason: 'OWNERSHIP_TRANSITION_READBACK_FAILED', detail: back.ok ? 'owner not persisted' : back.reason };
    }
    return {
      ok: true,
      fromLaneId: current,
      toLaneId,
      mutationOwner: back.session.mutationOwner,
      evidence: { from: current, to: toLaneId, at: back.session.mutationOwner.since, via: typeof via === 'string' && via ? via.slice(0, 200) : null },
    };
  });
}

// ---- Issue #145: explicit ownership transfer (control-plane API) --------------
// The ONLY way mutation ownership moves between lanes: an explicit, persisted,
// read-back-verified canonical transition through the serialized primitive.
// Never inferred from a dead pid, process restart, or timeout. Not exposed on
// the executor MCP surface.
export function transferMutationOwnership({
  sessionPath, fromLaneId, toLaneId, via = null,
  now = () => new Date().toISOString(),
} = {}) {
  const f = validateMutationLaneId(fromLaneId);
  if (!f.ok) return f;
  if (!f.laneId) return { ok: false, reason: 'MUTATION_LANE_ID_INVALID', detail: 'fromLaneId is required.' };
  const t = validateMutationLaneId(toLaneId);
  if (!t.ok) return t;
  if (!t.laneId) return { ok: false, reason: 'MUTATION_LANE_ID_INVALID', detail: 'toLaneId is required.' };
  if (toLaneId === fromLaneId) {
    return { ok: false, reason: 'OWNERSHIP_TRANSFER_INVALID', detail: 'toLaneId equals the current owner.' };
  }
  const r = applyOwnershipTransition({
    sessionPath, expectOwnerLaneId: fromLaneId, toLaneId,
    acquiredVia: 'TRANSFER', via, now,
  });
  if (r.ok) return { ok: true, fromLaneId, toLaneId, mutationOwner: r.mutationOwner, evidence: r.evidence };
  return r;
}

// ---- Issue #145 rework F1: THE serialized whole-session update primitive ------
// Every session write that can carry mutationOwner MUST go through here (or
// through applyOwnershipTransition, the owner writer). The transform runs
// against the AUTHORITATIVE record read INSIDE the ownership critical section
// — a caller-held snapshot can never be persisted — and the guard makes it
// structurally impossible for a transform to mutate the authoritative
// mutationOwner (ownership moves ONLY via applyOwnershipTransition). Write +
// read-back complete before the lock is released, so a concurrent ownership
// transition can never be interleaved with (or clobbered by) this write.
export function updateSessionUnderOwnershipLock(sessionPath, transform) {
  if (typeof transform !== 'function') return { ok: false, reason: 'SESSION_UPDATE_INVALID', detail: 'transform function required' };
  return withOwnershipLock(sessionPath, () => {
    const rs = readSessionRecord(sessionPath);
    if (!rs.ok) return { ok: false, reason: rs.reason, path: sessionPath };
    const ownerBefore = JSON.stringify(rs.session.mutationOwner ?? null);
    let out;
    try { out = transform(rs.session); }
    catch (e) { return { ok: false, reason: 'SESSION_UPDATE_THROWN', detail: String((e && e.message) || e) }; }
    if (!out || typeof out !== 'object' || Array.isArray(out)) return { ok: false, reason: 'SESSION_UPDATE_INVALID' };
    if (out.ok === false) return out; // transform-reported deterministic failure; nothing written
    const session = out.session;
    if (!session || typeof session !== 'object') return { ok: false, reason: 'SESSION_UPDATE_INVALID' };
    if (JSON.stringify(session.mutationOwner ?? null) !== ownerBefore) {
      return { ok: false, reason: 'OWNERSHIP_CLOBBER_BLOCKED', detail: 'A non-ownership update attempted to change the authoritative mutationOwner; ownership moves only via the explicit transfer/admission primitive.' };
    }
    try { fs.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, 'utf8'); }
    catch (e) { return { ok: false, reason: 'SESSION_WRITE_FAILED', detail: String((e && e.message) || e) }; }
    const back = readSessionRecord(sessionPath);
    if (!back.ok) return { ok: false, reason: 'SESSION_WRITE_FAILED', detail: back.reason || 'read-back failed' };
    return { ok: true, session: back.session };
  });
}

// Appends one lifecycle event to the authoritative record. THE canonical
// taskStart resume/fresh tail writer: it re-reads the record inside the
// ownership section at write time, so a transfer that completed between the
// caller's admission snapshot and this write survives (owner/history are
// never propagated from the caller's stale snapshot).
export function appendSessionLifecycleEvent({ sessionPath, event, detail = null } = {}) {
  return updateSessionUnderOwnershipLock(sessionPath, (session) => {
    if (!Array.isArray(session.lifecycle)) session.lifecycle = [];
    pushEvent(session.lifecycle, event, detail);
    return { session };
  });
}

// Ownership-scoped compensation (GPT-REV-137): removes ONLY artifacts this
// transaction created; pre-existing state is never adopted or deleted.
function compensate({ created, wtPath, bPath, sessionPath, cwd, exec }) {
  const errors = [];
  if (created.includes('worktree')) {
    try { run('git', ['worktree', 'remove', '--force', wtPath], { cwd, exec }); } catch (e) { errors.push(`worktree remove failed: ${String((e && e.message) || e)}`); }
    try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch (e) { errors.push(`fs remove failed: ${String((e && e.message) || e)}`); }
  }
  if (created.includes('binding')) {
    try { fs.rmSync(bPath, { force: true }); } catch (e) { errors.push(`binding remove failed: ${String((e && e.message) || e)}`); }
  }
  if (created.includes('session')) {
    try { fs.rmSync(sessionPath, { force: true }); } catch (e) { errors.push(`session remove failed: ${String((e && e.message) || e)}`); }
  }
  return errors;
}

// ---- taskStart ----------------------------------------------------------------
// Transactional task admission (GPT-REV-137). Order: identity + full contract
// validation (no artifacts yet) -> provision (atomic, self-rolling-back) ->
// read-back verify -> CONTRACT_PINNED -> fail-closed guards -> WORKSPACE_ADMITTED
// -> publish authoritative session OUTSIDE the worktree -> read-back ->
// SESSION_ACTIVE. Every failing step compensates ONLY artifacts this transaction
// created (never pre-existing state).
export function taskStart({
  repo, issueNumber, baseSha,
  worktreesRoot = defaultWorktreesRoot(),
  stateDir = defaultStateDir(),
  controlCwd = process.cwd(),
  exec = execFileSync, spawn = undefined,
  testRegistry = {}, taskContract = null,
  dispatchOptions = {},
  mutationLaneId = null,
} = {}) {
  if (typeof repo !== 'string' || !repo) return { ok: false, reason: 'MISSING_REPO' };
  if (typeof issueNumber !== 'number' || !Number.isInteger(issueNumber) || issueNumber <= 0) return { ok: false, reason: 'MISSING_ISSUE_NUMBER' };
  if (typeof baseSha !== 'string' || !SHA40_RE.test(baseSha)) return { ok: false, reason: 'INVALID_BASE_SHA' };
  if (typeof worktreesRoot !== 'string' || !worktreesRoot) return { ok: false, reason: 'MISSING_WORKTREES_ROOT' };
  if (typeof stateDir !== 'string' || !stateDir) return { ok: false, reason: 'MISSING_STATE_DIR' };
  // Issue #145: stable lane identity for mutation ownership (optional; absent
  // = legacy unattributed admission). Validated BEFORE any artifact is created.
  const laneV = validateMutationLaneId(mutationLaneId);
  if (!laneV.ok) return { ok: false, reason: laneV.reason, detail: `mutationLaneId: ${laneV.reason}` };
  const lane = laneV.laneId;

  const events = [];
  const h = identityHash({ repo, issueNumber });
  pushEvent(events, 'TASK_START_REQUESTED', `identity ${h || 'unstable'}`);
  if (!h) return { ok: false, reason: 'IDENTITY_UNSTABLE', lifecycle: events };

  const root = path.resolve(worktreesRoot);
  const stateRoot = path.resolve(stateDir);
  const wtPath = worktreePathFor({ worktreesRoot: root, identityHash: h });
  const bPath = bindingPathFor({ worktreesRoot: root, identityHash: h });
  const sPath = sessionPathFor({ stateDir: stateRoot, identityHash: h });
  const created = [];
  const compensateOwned = () => compensate({ created, wtPath, bPath, sessionPath: sPath, cwd: controlCwd, exec });

  // Soc_Score v0 telemetry (Issue #45): emit TASK_STARTED + WORKTREE_READY into
  // the append-only JSONL stream. Best-effort — telemetry failure MUST NOT
  // corrupt the FSM or change lifecycle authority, so every call is swallowed
  // (the recorder never throws; we additionally guard construction).
  let telemetry = null;
  try {
    telemetry = createRecorder({
      stateDir: stateRoot,
      identity: {
        identityHash: h,
        taskId: buildStableTaskId({ repo: normalizeRemoteUrl(repo), issueNumber }),
        repo: normalizeRemoteUrl(repo),
        issueNumber,
      },
      executor: 'runtime-sandbox',
    });
    if (telemetry && telemetry.ok) telemetry.record('TASK_STARTED', { baseSha });
  } catch { /* telemetry must never break admission */ }

  // Provision is self-rolling-back (bindTask); on success worktree+binding are
  // transaction-owned.
  const p = provision({ worktreesRoot: root, repo, issueNumber, baseSha, cwd: controlCwd, exec });
  if (!p.ok) return { ok: false, ...p, lifecycle: events, detail: p.detail || 'provision failed' };
  // GPT-REV-142: ownership is derived strictly from provision().created. On
  // idempotent reuse (binding + worktree already existed) this is EMPTY, so
  // compensation can never delete pre-existing workspace state.
  if (p.created && p.created.length) created.push(...p.created);

  // Read-back #1 (GPT-REV-137): re-verify the just-served binding against real
  // Git state before admitting. Failure -> compensate the provisioned artifacts.
  const adm = verifyBinding({ worktreesRoot: root, repo: normalizeRemoteUrl(repo), issueNumber, baseSha, cwd: controlCwd, exec });
  if (!adm.ok) {
    const errors = compensateOwned();
    return { ok: false, reason: 'WORKSPACE_ADMISSION_REJECTED', lifecycle: events, verify: adm, errors, detail: `Read-back after provision failed: ${adm.reason}.` };
  }
  pushEvent(events, 'CONTRACT_PINNED', `baseSha ${baseSha}`);

  // Fail-closed guards: canonical-checkout + symlink/escape admission.
  const mg = mainCheckoutGuard({ worktree: wtPath, controlCwd, exec });
  if (!mg.ok) {
    const errors = compensateOwned();
    return { ok: false, reason: 'FORBIDDEN_CANONICAL_CHECKOUT', lifecycle: events, guard: mg.errors, errors };
  }
  const sg = symlinkEscapeGuard({ worktree: wtPath, worktreesRoot: root, exec });
  if (!sg.ok) {
    const errors = compensateOwned();
    return { ok: false, reason: 'WORKSPACE_ADMISSION_REJECTED', lifecycle: events, guard: sg.errors, errors };
  }
  pushEvent(events, 'WORKSPACE_ADMITTED', `worktree ${wtPath}`);
  // Soc_Score v0 (Issue #45): worktree is admitted + verified by read-back;
  // mark it ready. Wrapped in try — telemetry is never allowed to influence
  // FSM authority.
  try { if (telemetry && telemetry.ok) telemetry.record('WORKTREE_READY', { worktree: wtPath }); } catch {}

  // Authoritative session publish OUTSIDE the worktree (GPT-REV-136). Probe
  // for an existing live session (idempotent restart): reuse its lease token
  // and existing projection, refuse on contract drift. Otherwise create fresh.
  let session;
  let idempotent = false;
  let leaseToken;
  let ownerLaneId = null;    // Issue #145: active mutation owner for this attempt
  let instructions = null;   // task-contract projection (Issue #31 pilot)
  if (fs.existsSync(sPath)) {
    const existing = readSessionRecord(sPath);
    if (!existing.ok) {
      const errors = compensateOwned();
      return { ok: false, reason: 'SESSION_STATE_INVALID', lifecycle: events, detail: existing.detail, errors };
    }
    session = existing.session;
    const drift = session.repo !== normalizeRemoteUrl(repo)
      || Number(session.issueNumber) !== issueNumber
      || session.baseSha !== baseSha
      || session.worktreePath !== wtPath;
    if (drift) {
      const errors = compensateOwned();
      return { ok: false, reason: 'TASK_CONTRACT_DRIFT', lifecycle: events, errors, detail: 'An authoritative session with a different contract already exists for this identity.' };
    }
    // Issue #145: single mutation owner gate BEFORE any authority is re-issued.
    // Terminal attempts are never revived; a foreign lane fails closed with
    // deterministic evidence and no canonical state is touched.
    const gate = admissionOwnershipGate(session, lane);
    if (!gate.ok) {
      const errors = compensateOwned();
      return { ok: false, reason: gate.reason, lifecycle: events, owner: gate.owner ?? null, ownerLaneId: gate.ownerLaneId ?? (gate.owner && gate.owner.laneId) ?? null, presented: gate.presented ?? gate.state ?? null, presentedLaneId: gate.presented ?? null, artifact: gate.artifact ?? null, state: gate.state ?? null, detail: gate.detail ?? null, errors };
    }
    idempotent = true;       // reuse existing lease token (no rotation)
    leaseToken = session.lease.token;
    if (gate.adopt) {
      // Adoption is a canonical ownership transition: serialized primitive,
      // expected current owner = null (unbound attempt), read-back verified
      // BEFORE read-back #2 re-reads the authoritative record.
      const tr = applyOwnershipTransition({
        sessionPath: sPath, expectOwnerLaneId: null, toLaneId: gate.adopt,
        acquiredVia: 'ADOPTION', via: 'taskStart-adoption',
      });
      if (!tr.ok) {
        const errors = compensateOwned();
        return { ok: false, reason: tr.reason, lifecycle: events, owner: tr.owner ?? null, ownerLaneId: tr.ownerLaneId ?? null, expected: tr.expected ?? null, presented: tr.presented ?? gate.adopt, presentedLaneId: tr.presentedLaneId ?? null, artifact: tr.artifact ?? null, state: tr.state ?? null, detail: tr.detail ?? null, errors };
      }
      session = readSessionRecord(sPath).session;
      ownerLaneId = gate.adopt;
    } else if (session.mutationOwner && session.mutationOwner.laneId) {
      ownerLaneId = session.mutationOwner.laneId;
    }
  } else {
    // Issue #145 rework F2: the fresh publication is SERIALIZED under the
    // ownership critical section: re-probe INSIDE the lock, and only when
    // still unpublished write the projection and publish no-clobber. A racing
    // loser re-probes after the winner released, never touches the winner's
    // projection, and re-enters the same single-owner gate as the
    // idempotent-reuse path (deterministic exactly-one-PASS on concurrent
    // claims; no last-writer-wins on the session record or projection).
    const fresh = withOwnershipLock(sPath, () => {
      const re = readSessionRecord(sPath);
      if (re.ok) return { raced: re.session };
      const freshLease = crypto.randomBytes(24).toString('hex');
      const mcpEntrypoint = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-server.mjs');
      const mcpProjEnv = buildMinimalEnv();
      mcpProjEnv.SOC_SESSION_PATH = sPath;
      mcpProjEnv.SOC_SESSION_TOKEN = freshLease;
      mcpProjEnv.SOC_CONTROL_CWD = path.resolve(controlCwd);
      if (lane) mcpProjEnv.SOC_LANE_ID = lane;
      let instr = null;
      if (taskContract) {
        const twc = writeTaskContract({ worktreePath: wtPath, taskContract });
        if (!twc.ok) return { failed: { ok: false, reason: 'TASK_CONTRACT_WRITE_FAILED', lifecycle: events, detail: twc, errors: compensateOwned() } };
        instr = ['SOC_TASK_CONTRACT.md'];
      }
      const projConfig = buildOpenCodeConfig({ mcpCommand: process.execPath, mcpArgs: [mcpEntrypoint], mcpEnv: mcpProjEnv, instructions: instr });
      const ocw = writeOpenCodeConfig({ worktreePath: wtPath, config: projConfig });
      if (!ocw.ok) return { failed: { ok: false, reason: 'OPENCODE_CONFIG_WRITE_FAILED', lifecycle: events, detail: ocw, errors: compensateOwned() } };
      const ocDigest = readOpenCodeConfigDigest({ worktreePath: wtPath });
      if (!ocDigest.ok) return { failed: { ok: false, reason: 'OPENCODE_CONFIG_READ_FAILED', lifecycle: events, detail: ocDigest, errors: compensateOwned() } };
      const record = {
        schemaVersion: SESSION_SCHEMA_VERSION,
        state: 'SESSION_ACTIVE',
        taskId: p.binding.taskId,
        identityHash: h,
        repo: normalizeRemoteUrl(repo),
        issueNumber,
        baseSha,
        branch: worktreeBranchFor({ identityHash: h }),
        headSha: adm.head,
        worktreePath: wtPath,
        worktreesRoot: root,
        lease: { token: freshLease, issuedAt: new Date().toISOString() },
        capabilities: ALLOWED_OPERATIONS.slice(),
        testRegistry,
        adapter: { id: 'runtime-sandbox', version: SANDBOX_SCHEMA_VERSION, mcpEntrypoint, opencodeConfigPath: ocw.path },
        digests: {
          sandboxConfig: crypto.createHash('sha256').update(JSON.stringify({ adapter: 'runtime-sandbox', adapterVersion: SANDBOX_SCHEMA_VERSION, capabilities: ALLOWED_OPERATIONS })).digest('hex'),
          opencodeConfig: ocDigest.digest,
        },
        projection: { path: ocw.path, digest: ocDigest.digest },
        binding: { path: wtPath },
        // Issue #145: a named admission binds its lane as the single mutation
        // owner; an unnamed admission stays UNBOUND and grants NO mutation
        // authority at any mutation surface (rework F1).
        mutationOwner: lane ? buildMutationOwner(lane, 'ADMISSION', () => new Date().toISOString()) : null,
        controlPlane: { stateDir: stateRoot, sessionPath: sPath, bindingPath: bPath, worktreesRoot: root },
        lifecycle: events.slice(),
      };
      const pub = publishSessionRecord(sPath, record);
      if (!pub.ok) {
        return { failed: { ok: false, reason: 'SESSION_PUBLISH_FAILED', lifecycle: events, detail: pub.detail, errors: compensateOwned() } };
      }
      if (!pub.created) {
        // EEXIST race (belt-and-braces: the re-probe above should have caught
        // it): hand off to the racing-loser gate below.
        const ex = readSessionRecord(sPath);
        return { raced: ex.ok ? ex.session : null };
      }
      return { published: true, record, lease: freshLease, instructions: instr };
    });
    if (fresh.failed) return fresh.failed;
    if (fresh.raced) {
      const existingSession = fresh.raced;
      if (!existingSession) {
        const errors = compensateOwned();
        return { ok: false, reason: 'SESSION_STATE_INVALID', lifecycle: events, detail: 'A racing winner published an unreadable record.', errors };
      }
      // Issue #145: the racing loser is a second admission claim — the same
      // single-owner gate applies (terminal/foreign owner -> fail closed).
      // NOTE: no compensation here. Provision is reservation-serialized, so
      // any workspace artifact this call created is ALREADY the winner
      // session's canonical workspace (same identity, same contract);
      // removing it would dangle the winner.
      const drift = existingSession.repo !== normalizeRemoteUrl(repo)
        || Number(existingSession.issueNumber) !== issueNumber
        || existingSession.baseSha !== baseSha
        || existingSession.worktreePath !== wtPath;
      if (drift) {
        return { ok: false, reason: 'TASK_CONTRACT_DRIFT', lifecycle: events, detail: 'A racing winner published a session with a different contract.' };
      }
      const gate = admissionOwnershipGate(existingSession, lane);
      if (!gate.ok) {
        return { ok: false, reason: gate.reason, lifecycle: events, owner: gate.owner ?? null, ownerLaneId: gate.ownerLaneId ?? (gate.owner && gate.owner.laneId) ?? null, presented: gate.presented ?? gate.state ?? null, presentedLaneId: gate.presented ?? null, artifact: gate.artifact ?? null, state: gate.state ?? null, detail: gate.detail ?? null };
      }
      session = existingSession;
      leaseToken = session.lease.token;
      idempotent = true;
      if (gate.adopt) {
        const tr = applyOwnershipTransition({
          sessionPath: sPath, expectOwnerLaneId: null, toLaneId: gate.adopt,
          acquiredVia: 'ADOPTION', via: 'taskStart-adoption',
        });
        if (!tr.ok) {
          return { ok: false, reason: tr.reason, lifecycle: events, owner: tr.owner ?? null, ownerLaneId: tr.ownerLaneId ?? null, expected: tr.expected ?? null, presented: tr.presented ?? gate.adopt, presentedLaneId: tr.presentedLaneId ?? null, artifact: tr.artifact ?? null, state: tr.state ?? null, detail: tr.detail ?? null };
        }
        session = readSessionRecord(sPath).session;
        ownerLaneId = gate.adopt;
      } else if (session.mutationOwner && session.mutationOwner.laneId) {
        ownerLaneId = session.mutationOwner.laneId;
      }
    } else {
      leaseToken = fresh.lease;
      instructions = fresh.instructions;
      session = fresh.record;
      ownerLaneId = lane;
      // GPT-REV-142: the session is transaction-owned ONLY on a fresh no-clobber
      // publish. On idempotent reuse (early session branch) or the race handoff
      // the session pre-existed and must never be compensated.
      created.push('session');
    }
  }

  // Read-back #2 (GPT-REV-137): confirm the published session is valid before
  // reporting SESSION_ACTIVE. verifySessionAuthority re-reads the session,
  // checks the lease token, the projection digest and the fail-closed guards.
  const rb = verifySessionAuthority({ sessionPath: sPath, leaseToken, controlCwd, exec });
  if (!rb.ok) {
    const errors = compensateOwned();
    return { ok: false, reason: 'SESSION_READBACK_FAILED', lifecycle: events, detail: rb.reason, errors };
  }
  session = rb.session;
  // Issue #145 rework F1: the lifecycle tail goes through the SERIALIZED
  // ownership-safe writer. It re-reads the authoritative record INSIDE the
  // ownership critical section at write time, so an adoption/transfer that
  // completed after the admission snapshot above can never be clobbered back
  // by this write (no stale-snapshot last-writer-wins on mutationOwner).
  const appended = appendSessionLifecycleEvent({
    sessionPath: sPath,
    event: 'SESSION_ACTIVE',
    detail: idempotent ? 'lease reused (idempotent restart)' : `lease ${leaseToken.slice(0, 8)}…`,
  });
  if (!appended.ok) {
    const errors = compensateOwned();
    return { ok: false, reason: appended.reason === 'MUTATION_OWNER_LOCK_BUSY' ? 'MUTATION_OWNER_LOCK_BUSY' : 'SESSION_WRITE_FAILED', lifecycle: events, detail: appended.detail ?? appended.reason ?? null, errors };
  }
  session = appended.session;

  // Issue #65: canonical lifecycle → Telegram dispatch. TASK_STARTED fires on
  // successful admission; best-effort, never breaks admission (req 3).
  const telegramDispatch = dispatchLifecycleEvent({ session, event: 'TASK_STARTED', ...dispatchOptions });

  // MCP launch env: pointers only (session path + lease token). Authority
  // (repo/issue/baseSha/registry/capabilities) is read from session state per
  // request (verifySessionAuthority), never from the worktree projection.
  const mcpEnv = buildMinimalEnv();
  mcpEnv.SOC_SESSION_PATH = sPath;
  mcpEnv.SOC_SESSION_TOKEN = leaseToken;
  mcpEnv.SOC_CONTROL_CWD = path.resolve(controlCwd);
  if (ownerLaneId) mcpEnv.SOC_LANE_ID = ownerLaneId;

  const evidence = buildEvidence({
    binding: { repo: session.repo, issueNumber, baseSha },
    worktree: wtPath,
    session: { path: sPath, digest: crypto.createHash('sha256').update(JSON.stringify(session)).digest('hex'), state: session.state },
    exec,
  });
  const ocFinal = readOpenCodeConfigDigest({ worktreePath: wtPath });
  evidence.opencode = ocFinal.ok ? { digest: ocFinal.digest, bytes: ocFinal.bytes, file: session.projection.path, version: PINNED_OPENCODE_VERSION } : { error: ocFinal };

  const broker = createExecutionBroker({ worktreesRoot: root, controlCwd, testRegistry, exec, spawn });
  const mcpEntrypointFinal = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-server.mjs');
  const openCodeConfig = buildOpenCodeConfig({ mcpCommand: process.execPath, mcpArgs: [mcpEntrypointFinal], mcpEnv, instructions });

  return {
    ok: true,
    evidence,
    // Issue #49 — self-describing worktree contract (Gap A): the canonical
    // worktree path is surfaced directly by taskStart so callers NEVER parse
    // internal binding/session fields to locate the execution root. Values are
    // derived from the same authority that was just verified (verifyBinding
    // read-back) — no second source of truth; missing/invalid state can never
    // reach this success shape because every earlier failure path returns.
    worktree: {
      path: wtPath,
      branch: session.branch,
      baseSha: session.baseSha,
      head: adm.head,
      opencodeConfigPath: session.projection.path,
      sessionPath: sPath,
      leaseToken,
      identityHash: h,
      bindingPath: bPath,
    },
    session: { path: sPath, state: session.state, leaseToken, lifecycle: session.lifecycle, schemaVersion: session.schemaVersion, mutationOwner: (session.mutationOwner && session.mutationOwner.laneId) || null },
    taskPacket: buildTaskPacket({ session }),
    telegramDispatch,
    broker, mcpCommand: process.execPath, mcpArgs: [mcpEntrypointFinal], mcpEnv,
    openCodeConfig, openCodeConfigPath: session.projection.path,
    idempotent,
    binding: { repo: session.repo, issueNumber, baseSha, identityHash: h, path: wtPath, branch: p.branch, head: adm.head, taskId: p.binding.taskId },
    telemetry: telemetry && telemetry.ok ? {
      recorder: telemetry,
      // Stable handle the caller uses to record remaining phases (EXECUTOR_*,
      // VERIFY_*, REVIEW_*, GITHUB_*, HUMAN_GATE_*, TASK_FINISHED). Never
      // throws into the FSM — see packages/soc-score/soc-score.mjs.
    } : null,
  };
}

function buildMinimalEnv() {
  const allowlist = new Set([
    'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'TEMP', 'TMP',
    'USERPROFILE', 'HOME', 'OS', 'ComSpec', 'PROCESSOR_ARCHITECTURE',
  ]);
  const env = {};
  for (const k of allowlist) { if (process.env[k] !== undefined) env[k] = process.env[k]; }
  return env;
}

// ---- Issue #126: shared control-projection target guard -----------------------
// Canonical checkout + entrypoint validation shared by the root projection
// primitives (refreshRootOpenCodeProjection / rotateSessionLease): the target
// must be a git checkout of the session's canonical repo, must not overlap the
// execution worktree or the worktrees root, and must contain the MCP
// entrypoint so the generated projection can never dangle on worktree cleanup.
function controlProjectionTargetGuard({ session, ccAbs, exec }) {
  try { gitRoot({ cwd: ccAbs, exec }); } catch { return { ok: false, reason: 'CONTROL_CWD_NO_GIT_ROOT', detail: ccAbs }; }
  let remoteUrl = '';
  try { remoteUrl = readRemoteUrl({ remote: 'origin', cwd: ccAbs, exec }); } catch { remoteUrl = ''; }
  if (!remoteIsCanonical(remoteUrl, session.repo)) {
    return { ok: false, reason: 'CONTROL_CWD_WRONG_REPO', remote: remoteUrl, expected: session.repo };
  }
  const ctrlReal = realPathOrNull(ccAbs);
  if (!ctrlReal) return { ok: false, reason: 'CONTROL_CWD_UNRESOLVABLE', detail: ccAbs };
  const wtReal = realPathOrNull(session.worktreePath);
  if (wtReal) {
    const wtRes = path.resolve(wtReal);
    const ctrlRes = path.resolve(ctrlReal);
    if (wtRes === ctrlRes || isInside(wtRes, ctrlRes) || isInside(ctrlRes, wtRes)) {
      return { ok: false, reason: 'ROOT_PROJECTION_TARGET_DENIED', detail: 'Control checkout overlaps the execution worktree.' };
    }
  }
  const rootReal = realPathOrNull(session.worktreesRoot);
  if (rootReal && isInside(path.resolve(rootReal), path.resolve(ctrlReal))) {
    return { ok: false, reason: 'ROOT_PROJECTION_TARGET_DENIED', detail: 'Control checkout lives inside the worktrees root.' };
  }
  // The MCP entrypoint MUST resolve inside the canonical checkout (never the
  // importing tree), so the generated projection cannot dangle when a task
  // worktree is cleaned up. Derived from this module's repo-relative location.
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  let repoRel;
  try { repoRel = path.relative(gitRoot({ cwd: selfDir, exec }), selfDir); } catch { return { ok: false, reason: 'ROOT_PROJECTION_ENTRYPOINT_UNRESOLVABLE' }; }
  const entrypoint = path.join(ccAbs, repoRel, 'mcp-server.mjs');
  if (!fs.existsSync(entrypoint)) return { ok: false, reason: 'ROOT_PROJECTION_ENTRYPOINT_MISSING', entrypoint };
  return { ok: true, entrypoint };
}

// Fail-closed previous-bytes snapshot: null = absent, undefined = exists but
// is not a readable file (odd target state -> caller denies deterministically
// instead of throwing out of the transaction) (Issue #126 review).
function safeReadBytesOrNull(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return fs.statSync(p).isFile() ? fs.readFileSync(p) : undefined;
  } catch { return undefined; }
}

// ---- Issue #126: canonical lease rotation -------------------------------------
// ONE ownership-locked transaction that retires the currently-recorded lease
// token and re-binds a freshly minted one across the authoritative record AND
// every generated projection (worktree + control-plane root). There is no
// lease/lane PARAMETER: the caller's lane identity comes from the environment
// and must equal the recorded mutationOwner (untrusted input can never mint or
// present authority). The old token is dead the instant the record write
// lands; any file/record failure rolls back to the fully-consistent OLD state
// (files restored byte-identically, record never half-written). Token values
// never appear in the result, logs, or evidence.
export function rotateSessionLease({ sessionPath, controlCwd = process.cwd(), exec = execFileSync } = {}) {
  if (typeof sessionPath !== 'string' || !sessionPath) return { ok: false, reason: 'MISSING_SESSION_PATH' };
  if (typeof controlCwd !== 'string' || !controlCwd.trim()) return { ok: false, reason: 'MISSING_CONTROL_CWD' };
  const ccAbs = path.resolve(controlCwd);
  const laneId = process.env.SOC_LANE_ID || null;

  // Phase 1 (read-only): record, ownership, current authority, target guard.
  const rs0 = readSessionRecord(sessionPath);
  if (!rs0.ok) return { ok: false, reason: 'SESSION_AUTHORITY_DENIED', detail: rs0.reason };
  const owner = (rs0.session.mutationOwner && rs0.session.mutationOwner.laneId) || null;
  if (!owner) return { ok: false, reason: 'MUTATION_OWNER_UNBOUND', detail: 'Lease rotation requires a named mutation owner; an unbound attempt grants no authority.' };
  if (!laneId) return { ok: false, reason: 'MUTATION_OWNER_UNIDENTIFIED', ownerLaneId: owner };
  if (laneId !== owner) return { ok: false, reason: 'MUTATION_OWNER_CONFLICT', ownerLaneId: owner, presentedLaneId: laneId };
  const currentToken = rs0.session.lease && rs0.session.lease.token;
  if (!currentToken) return { ok: false, reason: 'LEASE_MISSING' };
  const boot = verifySessionAuthority({ sessionPath, leaseToken: currentToken, controlCwd: ccAbs, exec });
  if (!boot.ok) return { ok: false, reason: 'SESSION_AUTHORITY_DENIED', detail: boot.reason };
  const s = boot.session;
  if (!s.adapter || s.adapter.id !== 'runtime-sandbox') {
    return { ok: false, reason: 'LEASE_ROTATION_ADAPTER_UNSUPPORTED', adapter: (s.adapter && s.adapter.id) || null };
  }
  const tgt = controlProjectionTargetGuard({ session: s, ccAbs, exec });
  if (!tgt.ok) return tgt;
  const entrypoint = tgt.entrypoint;

  const newToken = crypto.randomBytes(24).toString('hex');
  const mcpEnv = buildMinimalEnv();
  mcpEnv.SOC_SESSION_PATH = path.resolve(sessionPath);
  mcpEnv.SOC_SESSION_TOKEN = newToken;
  mcpEnv.SOC_CONTROL_CWD = ccAbs;
  if (owner) mcpEnv.SOC_LANE_ID = owner;
  const config = buildOpenCodeConfig({ mcpCommand: process.execPath, mcpArgs: [entrypoint], mcpEnv, instructions: null });

  const wtTarget = path.join(s.worktreePath, 'opencode.json');
  const rootTarget = path.join(ccAbs, 'opencode.json');
  const prevWt = safeReadBytesOrNull(wtTarget);
  const prevRoot = safeReadBytesOrNull(rootTarget);
  if (prevWt === undefined || prevRoot === undefined) {
    return { ok: false, reason: 'LEASE_ROTATION_TARGET_INVALID', detail: 'An existing projection target is not a readable file; refusing to rotate over ambiguous state.' };
  }
  const restoreFile = (target, prev) => {
    try {
      if (prev === null) fs.rmSync(target, { force: true });
      else {
        const tmp = target + '.restore.' + process.pid;
        fs.writeFileSync(tmp, prev);
        fs.renameSync(tmp, target);
      }
    } catch { /* best-effort compensation */ }
  };

  // Phase 2 (ownership-locked): projections first (rollback-safe), record LAST,
  // then read-back. Old token stays fully valid until the record write lands;
  // any failure restores the byte-identical OLD projections and never writes a
  // half state.
  return withOwnershipLock(sessionPath, () => {
    const recheck = verifySessionAuthority({ sessionPath, leaseToken: currentToken, controlCwd: ccAbs, exec });
    if (!recheck.ok) return { ok: false, reason: 'SESSION_AUTHORITY_DENIED', detail: recheck.reason };
    const wWt = writeOpenCodeConfig({ worktreePath: s.worktreePath, config });
    if (!wWt.ok) return { ok: false, reason: 'LEASE_ROTATION_WRITE_FAILED', detail: 'worktree projection: ' + wWt.reason };
    const wRoot = writeOpenCodeConfig({ worktreePath: ccAbs, config });
    if (!wRoot.ok) {
      restoreFile(wtTarget, prevWt);
      return { ok: false, reason: 'LEASE_ROTATION_WRITE_FAILED', detail: 'control projection: ' + wRoot.reason };
    }
    const dWt = readOpenCodeConfigDigest({ worktreePath: s.worktreePath });
    const dRoot = readOpenCodeConfigDigest({ worktreePath: ccAbs });
    if (!dWt.ok || !dRoot.ok || dWt.digest !== dRoot.digest) {
      restoreFile(wtTarget, prevWt);
      restoreFile(rootTarget, prevRoot);
      return { ok: false, reason: 'LEASE_ROTATION_READBACK_FAILED', detail: 'projection digests disagree' };
    }
    const rs = readSessionRecord(sessionPath);
    if (!rs.ok) {
      restoreFile(wtTarget, prevWt);
      restoreFile(rootTarget, prevRoot);
      return { ok: false, reason: rs.reason };
    }
    const session = rs.session;
    const ownerBefore = JSON.stringify(session.mutationOwner ?? null);
    const at = new Date().toISOString();
    session.lease = { token: newToken, issuedAt: at, rotated: true };
    session.digests = { ...session.digests, opencodeConfig: dWt.digest };
    session.projection = { path: wWt.path, digest: dWt.digest };
    session.controlPlaneProjection = { path: wRoot.path, digest: dRoot.digest, bytes: dRoot.bytes, at, byLaneId: owner, reason: 'LEASE_ROTATION' };
    if (!Array.isArray(session.lifecycle)) session.lifecycle = [];
    pushEvent(session.lifecycle, 'LEASE_ROTATED', 'token rotated; value not logged');
    if (JSON.stringify(session.mutationOwner ?? null) !== ownerBefore) {
      restoreFile(wtTarget, prevWt);
      restoreFile(rootTarget, prevRoot);
      return { ok: false, reason: 'OWNERSHIP_CLOBBER_BLOCKED' };
    }
    try { fs.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, 'utf8'); } catch (e) {
      restoreFile(wtTarget, prevWt);
      restoreFile(rootTarget, prevRoot);
      return { ok: false, reason: 'SESSION_WRITE_FAILED', detail: String((e && e.message) || e) };
    }
    const back = readSessionRecord(sessionPath);
    if (!back.ok || !(back.session.lease && back.session.lease.token === newToken)
      || !(back.session.digests && back.session.digests.opencodeConfig === dWt.digest)
      || !(back.session.controlPlaneProjection && back.session.controlPlaneProjection.digest === dRoot.digest)) {
      restoreFile(wtTarget, prevWt);
      restoreFile(rootTarget, prevRoot);
      return { ok: false, reason: 'LEASE_ROTATION_READBACK_FAILED', detail: 'record read-back mismatch' };
    }
    const fingerprint = crypto.createHash('sha256').update(newToken).digest('hex').slice(0, 8);
    return {
      ok: true, at, identityHash: session.identityHash, taskId: session.taskId, laneId: owner,
      worktreeProjection: { path: wWt.path, digest: dWt.digest },
      controlProjection: { path: wRoot.path, digest: dRoot.digest },
      newLeaseFingerprint: fingerprint,
    };
  });
}
// ---- terminal lifecycle transitions + HUMAN_GATE (Issue #65) -----------------
// Canonical FSM operations that deterministically trigger Telegram lifecycle
// dispatch. FSM correctness is independent of Telegram (req 3): the canonical
// session state is persisted BEFORE dispatch is attempted, and a dispatch
// failure NEVER rolls back or corrupts the transition. The dispatch result is
// attached to the session record as deliveryEvidence (req 4: truthful evidence
// levels; USER_RECEIVED is never claimed).
// Issue #145 rework F1: every one of these writes is owner-carrying — they all
// run through updateSessionUnderOwnershipLock (authoritative read inside the
// ownership critical section; mutationOwner is structurally protected).

function transitionTerminal({ sessionPath, terminalState, event, note = null, dispatchOptions = {} }) {
  // Issue #145 rework F1: terminal transitions are owner-carrying whole-session
  // writes — serialized under the ownership critical section, authoritative
  // read inside, ownership guard enforced.
  const persisted = updateSessionUnderOwnershipLock(sessionPath, (session) => {
    if (terminalState !== 'BLOCKED' && (session.state === 'COMPLETED' || session.state === 'FAILED' || session.state === 'BLOCKED')) {
      return { ok: false, reason: 'SESSION_ALREADY_TERMINAL', state: session.state };
    }
    pushEvent(session.lifecycle, event, note);
    session.state = terminalState;
    return { session };
  });
  if (!persisted.ok) {
    return { ok: false, reason: persisted.reason === 'SESSION_ALREADY_TERMINAL' ? 'SESSION_ALREADY_TERMINAL' : 'SESSION_WRITE_FAILED', state: persisted.state, detail: persisted.detail ?? persisted.reason };
  }
  const persistedSession = persisted.session;
  // Canonical state is already persisted; dispatch is best-effort from here.
  const telegramDispatch = dispatchLifecycleEvent({ session: persistedSession, event, ...dispatchOptions, note });
  // Delivery evidence is best-effort and still ownership-safe (same boundary).
  const withEvidence = updateSessionUnderOwnershipLock(sessionPath, (session) => {
    session.deliveryEvidence = { event, status: telegramDispatch.status, messageId: telegramDispatch.messageId ?? null, at: new Date().toISOString() };
    return { session };
  });
  return { ok: true, session: withEvidence.ok ? withEvidence.session : persistedSession, telegramDispatch };
}

// Canonical COMPLETED/FAILED transition (Issue #65): persists the terminal
// state first, then dispatches TASK_COMPLETED / TASK_FAILED. Exactly-once
// notification is guaranteed by the dispatcher's dedupe ledger — a replayed
// call re-persists the same terminal state but cannot send twice.
export function taskFinish({ sessionPath, outcome = 'COMPLETED', dispatchOptions = {} } = {}) {
  if (outcome !== 'COMPLETED' && outcome !== 'FAILED') {
    return { ok: false, reason: 'INVALID_OUTCOME', detail: 'outcome must be COMPLETED or FAILED.' };
  }
  return transitionTerminal({
    sessionPath, terminalState: outcome,
    event: outcome === 'COMPLETED' ? 'TASK_COMPLETED' : 'TASK_FAILED',
    dispatchOptions,
  });
}

// Canonical BLOCKED transition (Issue #65).
export function taskBlock({ sessionPath, dispatchOptions = {} } = {}) {
  return transitionTerminal({ sessionPath, terminalState: 'BLOCKED', event: 'TASK_BLOCKED', dispatchOptions });
}

// Canonical HUMAN_GATE_REQUIRED transition (Issue #65 req 6): canonical safety
// ordering is checkpoint/state persisted → notification dispatch attempted →
// WAITING_FOR_INPUT only after both. Step 1 persists the canonical gate state
// (HUMAN_GATE_REQUIRED + humanGate.state=REQUESTED). Step 2 attempts the
// Telegram dispatch. Step 3 persists the WAITING_FOR_INPUT marker with the
// truthful dispatch outcome — a notification failure stays visible in the
// record instead of silently creating an invisible wait.
export function taskRequestHumanGate({ sessionPath, note = null, dispatchOptions = {} } = {}) {
  // Issue #145 rework F1: the gate checkpoint is an owner-carrying whole-session
  // write — serialized under the ownership boundary (authoritative read inside).
  const persisted = updateSessionUnderOwnershipLock(sessionPath, (session) => {
    if (session.state === 'COMPLETED' || session.state === 'FAILED' || session.state === 'BLOCKED') {
      return { ok: false, reason: 'SESSION_ALREADY_TERMINAL', state: session.state };
    }
    // Step 1: checkpoint/state persisted FIRST (never dispatch-first).
    pushEvent(session.lifecycle, 'HUMAN_GATE_REQUIRED', note);
    session.state = 'HUMAN_GATE_REQUIRED';
    session.humanGate = { state: 'REQUESTED', note: note ?? null, at: new Date().toISOString() };
    return { session };
  });
  if (!persisted.ok) {
    return { ok: false, reason: persisted.reason === 'SESSION_ALREADY_TERMINAL' ? 'SESSION_ALREADY_TERMINAL' : 'SESSION_WRITE_FAILED', state: persisted.state, detail: persisted.detail ?? persisted.reason };
  }
  const session = persisted.session;
  // Step 2: notification dispatch attempted (best-effort, evidence recorded).
  const telegramDispatch = dispatchLifecycleEvent({ session, event: 'HUMAN_GATE_REQUIRED', ...dispatchOptions, note });
  // Step 3: WAITING_FOR_INPUT only after an ACCEPTED dispatch attempt. A
  // failed/unattempted dispatch HOLDS the gate at HUMAN_GATE_REQUIRED with
  // truthful delivery evidence — never an invisible wait (rev-2 req D);
  // recovery completes the transition later (recoverHumanGate).
  const step3 = updateSessionUnderOwnershipLock(sessionPath, (s) => {
    s.deliveryEvidence = { event: 'HUMAN_GATE_REQUIRED', status: telegramDispatch.status, messageId: telegramDispatch.messageId ?? null, at: new Date().toISOString() };
    if (telegramDispatch.status === 'API_ACCEPTED') {
      s.state = 'WAITING_FOR_INPUT';
      s.humanGate = { state: 'WAITING_FOR_INPUT', deliveryStatus: 'API_ACCEPTED', at: new Date().toISOString() };
      pushEvent(s.lifecycle, 'WAITING_FOR_INPUT', `dispatch ${telegramDispatch.status}`);
    } else {
      s.humanGate = { state: 'HUMAN_GATE_REQUIRED', deliveryStatus: telegramDispatch.status, at: new Date().toISOString() };
      pushEvent(s.lifecycle, 'DELIVERY_HELD', `dispatch ${telegramDispatch.status}`);
    }
    return { session: s };
  });
  if (!step3.ok) return { ok: true, session, telegramDispatch }; // evidence/state completion is best-effort (matches prior semantics)
  return { ok: true, session: step3.session, telegramDispatch };
}

// Canonical bounded recovery for an undelivered HUMAN_GATE_REQUIRED
// notification (rev-2 req D). Explicit call only (soc_broker_recover_human_gate
// / control plane). One bounded dispatch attempt; every dispatch knob stays
// FSM-derived. On API_ACCEPTED the canonical WAITING_FOR_INPUT transition
// completes; on failure the gate stays held with truthful delivery evidence —
// there is never a state where the system silently waits while the Human Gate
// notification was not accepted.
export function recoverHumanGate({ sessionPath, note = null, dispatchOptions = {} } = {}) {
  const rs = readSessionRecord(sessionPath);
  if (!rs.ok) return { ok: false, reason: rs.reason };
  const session = rs.session;
  if (session.state === 'COMPLETED' || session.state === 'FAILED' || session.state === 'BLOCKED') {
    return { ok: false, reason: 'SESSION_ALREADY_TERMINAL', state: session.state };
  }
  const undelivered = session.state === 'HUMAN_GATE_REQUIRED'
    || (session.state === 'WAITING_FOR_INPUT' && session.humanGate
      && session.humanGate.deliveryStatus && session.humanGate.deliveryStatus !== 'API_ACCEPTED');
  if (!undelivered) {
    return { ok: false, reason: 'NO_UNDELIVERED_GATE', state: session.state };
  }
  const telegramDispatch = recoverLifecycleEvent({
    session, event: 'HUMAN_GATE_REQUIRED',
    note: note ?? (session.humanGate && session.humanGate.note) ?? null,
    ...dispatchOptions,
  });
  // Issue #145 rework F1: the recovery write is owner-carrying — serialized
  // under the ownership boundary (authoritative read inside).
  const persisted = updateSessionUnderOwnershipLock(sessionPath, (s) => {
    s.deliveryEvidence = { event: 'HUMAN_GATE_REQUIRED', status: telegramDispatch.status, messageId: telegramDispatch.messageId ?? null, at: new Date().toISOString() };
    if (telegramDispatch.status === 'API_ACCEPTED') {
      s.state = 'WAITING_FOR_INPUT';
      s.humanGate = { state: 'WAITING_FOR_INPUT', deliveryStatus: 'API_ACCEPTED', at: new Date().toISOString() };
      pushEvent(s.lifecycle, 'WAITING_FOR_INPUT', 'gate recovery dispatch API_ACCEPTED');
    } else {
      s.state = 'HUMAN_GATE_REQUIRED';
      s.humanGate = { state: 'HUMAN_GATE_REQUIRED', deliveryStatus: telegramDispatch.status, at: new Date().toISOString() };
      pushEvent(s.lifecycle, 'DELIVERY_HELD', `gate recovery dispatch ${telegramDispatch.status}`);
    }
    return { session: s };
  });
  if (!persisted.ok) return { ok: false, reason: 'SESSION_WRITE_FAILED', detail: persisted.detail ?? persisted.reason };
  return { ok: true, session: persisted.session, telegramDispatch };
}

// ---- Issue #175: canonical Human Gate ANSWER / resume edge ---------------------
// The ONE canonical seam that lets a recorded HUMAN_GATE be answered and the
// session resume. It is the counterpart to taskRequestHumanGate and lives in the
// session-FSM owner module (NOT in a client surface): a client may only RELAY a
// human answer through here — it cannot synthesize approval. This primitive:
//   * does NOT mint or move mutation ownership (updateSessionUnderOwnershipLock
//     structurally blocks any mutationOwner change and re-reads authoritatively);
//   * does NOT terminalize and carries NO review/merge/verification verdict — the
//     answer is persisted as DATA; downstream deterministic verification, pre-
//     review and GPT final review remain the sole authorities;
//   * sets state back to SESSION_ACTIVE, the canonical precondition the ControlLoop
//     executorRouter requires to continue on the same session/worktree.
// Exact, identity-addressed binding + accepted-exactly-once:
//   * session must be in a gate state (HUMAN_GATE_REQUIRED | WAITING_FOR_INPUT);
//     any other live state -> GATE_NOT_ACTIVE, terminal -> SESSION_ALREADY_TERMINAL;
//   * the caller must echo the CURRENT checkpoint (session.humanGate.at) exactly;
//     a stale/superseded checkpoint fails closed (GATE_CHECKPOINT_STALE);
//   * once answered the state leaves the gate, so a replayed/duplicate answer is
//     deterministically rejected as GATE_NOT_ACTIVE => accepted exactly once.
export const HUMAN_GATE_STATES = Object.freeze(['HUMAN_GATE_REQUIRED', 'WAITING_FOR_INPUT']);
export const HUMAN_GATE_ANSWER_MAX_BYTES = 8192;

export function answerHumanGate({ sessionPath, checkpointAt, response = null } = {}) {
  if (typeof checkpointAt !== 'string' || !checkpointAt) {
    return { ok: false, reason: 'GATE_CHECKPOINT_MISSING', detail: 'checkpointAt (the recorded humanGate.at) is required.' };
  }
  const persisted = updateSessionUnderOwnershipLock(sessionPath, (session) => {
    if (session.state === 'COMPLETED' || session.state === 'FAILED' || session.state === 'BLOCKED') {
      return { ok: false, reason: 'SESSION_ALREADY_TERMINAL', state: session.state };
    }
    if (!HUMAN_GATE_STATES.includes(session.state)) {
      return { ok: false, reason: 'GATE_NOT_ACTIVE', state: session.state };
    }
    const gate = session.humanGate || null;
    const currentAt = gate && typeof gate.at === 'string' ? gate.at : null;
    if (!currentAt || currentAt !== checkpointAt) {
      return { ok: false, reason: 'GATE_CHECKPOINT_STALE', state: session.state, currentCheckpointAt: currentAt, presentedCheckpointAt: checkpointAt };
    }
    const answeredAt = new Date().toISOString();
    const answerText = typeof response === 'string'
      ? (Buffer.byteLength(response, 'utf8') > HUMAN_GATE_ANSWER_MAX_BYTES ? response.slice(0, HUMAN_GATE_ANSWER_MAX_BYTES) : response)
      : null;
    // Response is DATA (the human's verbatim reply), never a lifecycle verdict.
    session.humanGate = { ...gate, state: 'ANSWERED', answeredAt, response: answerText };
    session.state = 'SESSION_ACTIVE';
    pushEvent(session.lifecycle, 'HUMAN_GATE_RESOLVED', `checkpoint ${checkpointAt}`);
    pushEvent(session.lifecycle, 'SESSION_ACTIVE', 'human gate answered (canonical resume)');
    return { session };
  });
  if (!persisted.ok) {
    return {
      ok: false,
      reason: persisted.reason ?? 'SESSION_WRITE_FAILED',
      state: persisted.state ?? null,
      currentCheckpointAt: persisted.currentCheckpointAt ?? null,
      presentedCheckpointAt: persisted.presentedCheckpointAt ?? null,
      detail: persisted.detail ?? null,
    };
  }
  return { ok: true, session: persisted.session, resumed: true };
}

// ---- Issue #126: canonical control-plane (root) OpenCode projection ----------
// The ROOT OpenCode config (<controlCwd>/opencode.json) is a GENERATED runtime
// projection, never a hand-maintained tracked file: the tracked copy bound a
// dead task session and carried a live lease token (Issue #126). taskStart
// keeps provisioning ONLY task/worktree projections; THIS primitive is the ONE
// canonical way to (re)generate the root projection from an ALREADY-ADMITTED
// maintenance session. It mints no authority: the caller must present the
// lease token of an admitted runtime-sandbox session whose recorded
// mutationOwner lane matches the caller's SOC_LANE_ID environment (the same
// identity model as the MCP server; there is no lane PARAMETER to forge, and
// an unbound session grants root authority to nobody).
export function refreshRootOpenCodeProjection({
  sessionPath, leaseToken, controlCwd = process.cwd(),
  exec = execFileSync,
} = {}) {
  if (typeof sessionPath !== 'string' || !sessionPath) return { ok: false, reason: 'MISSING_SESSION_PATH' };
  if (typeof leaseToken !== 'string' || !leaseToken) return { ok: false, reason: 'MISSING_LEASE_TOKEN' };
  if (typeof controlCwd !== 'string' || !controlCwd.trim()) return { ok: false, reason: 'MISSING_CONTROL_CWD' };
  const ccAbs = path.resolve(controlCwd);
  // Caller lane identity comes from the environment, never from an argument
  // (Issue #126 req 2): an arbitrary lane cannot mint or refresh root authority.
  const laneId = process.env.SOC_LANE_ID || null;

  // Phase 1 (read-only): admission proof + target guards, outside the lock.
  const boot = verifySessionAuthority({ sessionPath, leaseToken, controlCwd: ccAbs, exec });
  if (!boot.ok) return { ok: false, reason: 'SESSION_AUTHORITY_DENIED', detail: boot.reason };
  const s = boot.session;
  if (!s.adapter || s.adapter.id !== 'runtime-sandbox') {
    return { ok: false, reason: 'ROOT_PROJECTION_ADAPTER_UNSUPPORTED', adapter: (s.adapter && s.adapter.id) || null };
  }
  const owner = (s.mutationOwner && s.mutationOwner.laneId) || null;
  if (!owner) return { ok: false, reason: 'MUTATION_OWNER_UNBOUND', detail: 'A root projection requires a named maintenance lane; an unbound attempt grants no authority.' };
  if (!laneId) return { ok: false, reason: 'MUTATION_OWNER_UNIDENTIFIED', ownerLaneId: owner };
  if (laneId !== owner) return { ok: false, reason: 'MUTATION_OWNER_CONFLICT', ownerLaneId: owner, presentedLaneId: laneId };

  // Shared control-projection target guard (canonical checkout + entrypoint).
  const tgt = controlProjectionTargetGuard({ session: s, ccAbs, exec });
  if (!tgt.ok) return tgt;
  const entrypoint = tgt.entrypoint;

  const mcpEnv = buildMinimalEnv();
  mcpEnv.SOC_SESSION_PATH = path.resolve(sessionPath);
  mcpEnv.SOC_SESSION_TOKEN = leaseToken;
  mcpEnv.SOC_CONTROL_CWD = ccAbs;
  if (owner) mcpEnv.SOC_LANE_ID = owner;
  const config = buildOpenCodeConfig({ mcpCommand: process.execPath, mcpArgs: [entrypoint], mcpEnv, instructions: null });

  // Phase 2 (ownership-locked): re-verify, write atomically, persist the root
  // digest on the authoritative session, read back BOTH. The task worktree
  // projection digest (digests.opencodeConfig) and mutationOwner are untouched.
  const target = path.join(ccAbs, 'opencode.json');
  const prevBytes = safeReadBytesOrNull(target);
  if (prevBytes === undefined) {
    return { ok: false, reason: 'ROOT_PROJECTION_TARGET_INVALID', detail: 'Existing control projection target is not a readable file; refusing to write over ambiguous state.' };
  }
  return withOwnershipLock(sessionPath, () => {
    const recheck = verifySessionAuthority({ sessionPath, leaseToken, controlCwd: ccAbs, exec });
    if (!recheck.ok) return { ok: false, reason: 'SESSION_AUTHORITY_DENIED', detail: recheck.reason };
    const w = writeOpenCodeConfig({ worktreePath: ccAbs, config });
    if (!w.ok) return { ok: false, reason: 'ROOT_PROJECTION_WRITE_FAILED', detail: w.reason };
    const restorePrev = () => {
      try {
        if (prevBytes === null) fs.rmSync(target, { force: true });
        else {
          const tmp = target + '.restore.' + process.pid;
          fs.writeFileSync(tmp, prevBytes);
          fs.renameSync(tmp, target);
        }
      } catch { /* best-effort compensation */ }
    };
    const rb = readOpenCodeConfigDigest({ worktreePath: ccAbs });
    if (!rb.ok) { restorePrev(); return { ok: false, reason: 'ROOT_PROJECTION_READBACK_FAILED', detail: rb.reason }; }
    // Persist + read-back (idempotent: same digest -> record untouched).
    const rs = readSessionRecord(sessionPath);
    if (!rs.ok) { restorePrev(); return { ok: false, reason: rs.reason }; }
    const session = rs.session;
    const next = { path: w.path, digest: rb.digest, bytes: rb.bytes, at: new Date().toISOString(), byLaneId: owner };
    const prevProjection = session.controlPlaneProjection ?? null;
    if (prevProjection && prevProjection.digest === rb.digest) {
      return { ok: true, path: w.path, bytes: w.bytes, digest: rb.digest, identityHash: session.identityHash, taskId: session.taskId, laneId: owner, entrypoint, persistedAt: prevProjection.at, idempotent: true };
    }
    const ownerBefore = JSON.stringify(session.mutationOwner ?? null);
    session.controlPlaneProjection = next;
    if (JSON.stringify(session.mutationOwner ?? null) !== ownerBefore) {
      restorePrev();
      return { ok: false, reason: 'OWNERSHIP_CLOBBER_BLOCKED' };
    }
    try { fs.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, 'utf8'); } catch (e) {
      restorePrev();
      return { ok: false, reason: 'SESSION_WRITE_FAILED', detail: String((e && e.message) || e) };
    }
    const back = readSessionRecord(sessionPath);
    if (!back.ok || !(back.session.controlPlaneProjection && back.session.controlPlaneProjection.digest === rb.digest)) {
      restorePrev();
      return { ok: false, reason: 'ROOT_PROJECTION_READBACK_FAILED', detail: 'persisted digest mismatch' };
    }
    return { ok: true, path: w.path, bytes: w.bytes, digest: rb.digest, identityHash: session.identityHash, taskId: session.taskId, laneId: owner, entrypoint, persistedAt: next.at, idempotent: false };
  });
}
