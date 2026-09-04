#!/usr/bin/env node
// runtime-sandbox.mjs - Soc_brain: provider-neutral harness boundary (Issue #18).
// Minimal vertical slice: task_start admission, fail-closed guards, evidence.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  provision, defaultWorktreesRoot,
  identityHash, worktreeBranchFor,
  verifyBinding, worktreePathFor, bindingPathFor,
  SHA40_RE,
} from '../workspace/workspace.mjs';
import {
  gitRoot, readBranchInfo, readLocalHead,
  normalizeRemoteUrl,
} from '../safe-git/safe-git.mjs';
import { buildStableTaskId } from '../task-intake/task-intake.mjs';
import { isInside, isReparsePoint } from '../temp-hygiene/temp-hygiene.mjs';
import { createExecutionBroker } from '../execution-broker/execution-broker.mjs';
import { guardOperation } from '../permission-orchestration/permission-orchestration.mjs';
import { buildOpenCodeConfig, writeOpenCodeConfig, readOpenCodeConfigDigest, PINNED_OPENCODE_VERSION } from './opencode-adapter.mjs';
import { createRecorder } from '../soc-score/soc-score.mjs';

export const SANDBOX_SCHEMA_VERSION = '1';
export const ALLOWED_OPERATIONS = ['status', 'diff', 'run_registered_test'];

// ---- control-plane session state (GPT-REV-136/137/140) ----------------------
// Authoritative task state lives OUTSIDE every worktree, under a machine-local
// control-plane state dir (~/.soc-brain/state). The worktree-local
// opencode.json is a NON-authoritative projection: it carries only pointers
// (session path + lease token), never repo/issue/baseSha/registry authority.
export const SESSION_SCHEMA_VERSION = '1';
// Deterministic lifecycle projection (Issue #18 Orca amendment / GPT-REV-140).
// taskStart emits the four admission events; BLOCKED|COMPLETED are terminal
// states recorded by later task operations (taskFinish/taskBlock).
export const LIFECYCLE_EVENTS = Object.freeze([
  'TASK_START_REQUESTED', 'CONTRACT_PINNED', 'WORKSPACE_ADMITTED',
  'SESSION_ACTIVE', 'BLOCKED', 'COMPLETED',
]);
export const TASK_PACKET_MAX_BYTES = 8192;

export function defaultStateDir() {
  return path.join(os.homedir(), '.soc-brain', 'state');
}

export function sessionPathFor({ stateDir, identityHash: h }) {
  return path.join(path.resolve(stateDir), 'sessions', `${h}.json`);
}

const run = (cmd, args, { cwd, exec = execFileSync } = {}) => {
  const out = exec(cmd, args, { cwd, encoding: 'utf8' });
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
export function verifySessionAuthority({ sessionPath, leaseToken, exec = execFileSync, controlCwd = process.cwd() }) {
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
  return { ok: true, session: s };
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
} = {}) {
  if (typeof repo !== 'string' || !repo) return { ok: false, reason: 'MISSING_REPO' };
  if (typeof issueNumber !== 'number' || !Number.isInteger(issueNumber) || issueNumber <= 0) return { ok: false, reason: 'MISSING_ISSUE_NUMBER' };
  if (typeof baseSha !== 'string' || !SHA40_RE.test(baseSha)) return { ok: false, reason: 'INVALID_BASE_SHA' };
  if (typeof worktreesRoot !== 'string' || !worktreesRoot) return { ok: false, reason: 'MISSING_WORKTREES_ROOT' };
  if (typeof stateDir !== 'string' || !stateDir) return { ok: false, reason: 'MISSING_STATE_DIR' };

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
    idempotent = true;       // reuse existing lease token (no rotation)
    leaseToken = session.lease.token;
  } else {
    leaseToken = crypto.randomBytes(24).toString('hex');
    const mcpEntrypoint = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-server.mjs');
    const mcpProjEnv = buildMinimalEnv();
    mcpProjEnv.SOC_SESSION_PATH = sPath;
    mcpProjEnv.SOC_SESSION_TOKEN = leaseToken;
    mcpProjEnv.SOC_CONTROL_CWD = path.resolve(controlCwd);
    if (taskContract) {
      const twc = writeTaskContract({ worktreePath: wtPath, taskContract });
      if (!twc.ok) return { ok: false, reason: 'TASK_CONTRACT_WRITE_FAILED', lifecycle: events, detail: twc, errors: compensateOwned() };
      instructions = ['SOC_TASK_CONTRACT.md'];
    }
    const projConfig = buildOpenCodeConfig({ mcpCommand: process.execPath, mcpArgs: [mcpEntrypoint], mcpEnv: mcpProjEnv, instructions });
    const ocw = writeOpenCodeConfig({ worktreePath: wtPath, config: projConfig });
    if (!ocw.ok) {
      const errors = compensateOwned();
      return { ok: false, reason: 'OPENCODE_CONFIG_WRITE_FAILED', lifecycle: events, detail: ocw, errors };
    }
    const ocDigest = readOpenCodeConfigDigest({ worktreePath: wtPath });
    if (!ocDigest.ok) {
      const errors = compensateOwned();
      return { ok: false, reason: 'OPENCODE_CONFIG_READ_FAILED', lifecycle: events, detail: ocDigest, errors };
    }
    const record = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      state: 'SESSION_ACTIVE',
      taskId: p.binding.taskId,
      repo: normalizeRemoteUrl(repo),
      issueNumber,
      baseSha,
      branch: worktreeBranchFor({ identityHash: h }),
      headSha: adm.head,
      worktreePath: wtPath,
      worktreesRoot: root,
      lease: { token: leaseToken, issuedAt: new Date().toISOString() },
      capabilities: ALLOWED_OPERATIONS.slice(),
      testRegistry,
      adapter: { id: 'runtime-sandbox', version: SANDBOX_SCHEMA_VERSION, mcpEntrypoint, opencodeConfigPath: ocw.path },
      digests: {
        sandboxConfig: crypto.createHash('sha256').update(JSON.stringify({ adapter: 'runtime-sandbox', adapterVersion: SANDBOX_SCHEMA_VERSION, capabilities: ALLOWED_OPERATIONS })).digest('hex'),
        opencodeConfig: ocDigest.digest,
      },
      projection: { path: ocw.path, digest: ocDigest.digest },
      binding: { path: wtPath },
      controlPlane: { stateDir: stateRoot, sessionPath: sPath, bindingPath: bPath, worktreesRoot: root },
      lifecycle: events.slice(),
    };
    const pub = publishSessionRecord(sPath, record);
    if (!pub.ok) {
      const errors = compensateOwned();
      return { ok: false, reason: 'SESSION_PUBLISH_FAILED', lifecycle: events, detail: pub.detail, errors };
    }
    if (!pub.created) {
      // EEXIST race: another caller published a session between probe and publish.
      const existing = readSessionRecord(sPath);
      if (!existing.ok) {
        const errors = compensateOwned();
        return { ok: false, reason: 'SESSION_STATE_INVALID', lifecycle: events, detail: existing.detail, errors };
      }
      session = existing.session;
      leaseToken = session.lease.token;
      idempotent = true;
    } else {
      session = record;
      // GPT-REV-142: the session is transaction-owned ONLY on a fresh no-clobber
      // publish. On idempotent reuse (early session branch) or the EEXIST race
      // (!pub.created) the session pre-existed and must never be compensated.
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
  pushEvent(session.lifecycle, 'SESSION_ACTIVE', idempotent ? 'lease reused (idempotent restart)' : `lease ${leaseToken.slice(0, 8)}…`);
  // Persist the lifecycle completion WITHOUT rotating the lease (rewrite the
  // published file in place: same identity, same contract, same token).
  try { fs.writeFileSync(sPath, `${JSON.stringify(session, null, 2)}\n`, 'utf8'); } catch (e) {
    const errors = compensateOwned();
    return { ok: false, reason: 'SESSION_WRITE_FAILED', lifecycle: events, detail: String((e && e.message) || e), errors };
  }

  // MCP launch env: pointers only (session path + lease token). Authority
  // (repo/issue/baseSha/registry/capabilities) is read from session state per
  // request (verifySessionAuthority), never from the worktree projection.
  const mcpEnv = buildMinimalEnv();
  mcpEnv.SOC_SESSION_PATH = sPath;
  mcpEnv.SOC_SESSION_TOKEN = leaseToken;
  mcpEnv.SOC_CONTROL_CWD = path.resolve(controlCwd);

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
    session: { path: sPath, state: session.state, leaseToken, lifecycle: session.lifecycle, schemaVersion: session.schemaVersion },
    taskPacket: buildTaskPacket({ session }),
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