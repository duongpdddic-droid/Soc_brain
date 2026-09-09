// session-at-intake.mjs — Issue #132: canonical session binding AT INTAKE for
// the task-server/worktree flow (mcp-task-server claim/start).
//
// Gap proven by Issue #125: the task-server flow provisions the workspace via
// the workspace primitives but never enters the canonical runtime — no session
// record, no FSM ledger, no controlLoop.terminalizeToken, no exactly-once
// TASK_COMPLETED, no rework budget ("lifecycle blind"). This module is the ONE
// canonical seam for that flow:
//
//   claim/start -> workspace provision (task-server, canonical workspace
//                  primitives) -> sessionAtIntake()  [exactly once per claim]
//
// Fail-closed rules:
//   - the canonical workspace binding MUST already exist and verify against
//     the real Git state (verifyBinding). A missing/mismatched workspace is
//     NEVER provisioned or healed here — legacy/pre-existing tasks can never
//     be backfilled with a synthetic session;
//   - the session/lease/projection are published ONLY by the runtime-sandbox
//     taskStart transaction (no parallel session or token mechanism);
//   - the ControlLoop terminalize token is bound into the session record at
//     intake via the ControlLoop-owned bindSessionLoop primitive (first
//     binding wins; a real runControlLoop run may rotate it later);
//   - identity chain: repo/issueNumber/worktreePath/sessionPath/taskId all
//     derive from ONE identityHash (packages/workspace) and are re-verified
//     by read-back before ok.
// No UI, no provider transports (Issue #132 non-goals).
import fs from 'node:fs';
import path from 'node:path';
import {
  bindingPathFor,
  defaultWorktreesRoot,
  identityHash,
  verifyBinding,
  worktreePathFor,
} from '../workspace/workspace.mjs';
import {
  defaultStateDir,
  readSessionRecord,
  sessionPathFor,
  taskStart,
} from '../runtime-sandbox/runtime-sandbox.mjs';
import { bindSessionLoop } from '../control-loop/control-loop.mjs';

export const SESSION_AT_INTAKE_SCHEMA_VERSION = '1';

function fail(reason, detail, extra = {}) {
  return { ok: false, reason, detail: detail ?? null, ...extra };
}

// ---- sessionAtIntake ----------------------------------------------------------
// Canonical claim/start entrypoint. Call ONCE per task-server claim, after the
// workspace primitives provisioned (or verified) the task worktree. Idempotent
// on restart: an existing matching session is REUSED (same lease, no rotation),
// a contract drift fails closed.
export function sessionAtIntake({
  repo, issueNumber, baseSha,
  worktreesRoot = defaultWorktreesRoot(),
  stateDir = defaultStateDir(),
  controlCwd = process.cwd(),
  exec,
  taskContract = null,
  dispatchOptions = {},
} = {}) {
  if (typeof repo !== 'string' || !repo) return fail('MISSING_REPO');
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return fail('MISSING_ISSUE_NUMBER');
  if (typeof baseSha !== 'string' || !/^[0-9a-f]{40}$/.test(baseSha)) return fail('INVALID_BASE_SHA');
  const root = path.resolve(worktreesRoot);
  const stateRoot = path.resolve(stateDir);
  const h = identityHash({ repo, issueNumber });
  if (!h) return fail('IDENTITY_UNSTABLE');

  // (1) Session-at-intake NEVER provisions. The workspace must already exist
  // and match the identity: a missing workspace is a legacy/foreign task —
  // fail closed, nothing created (no session backfill, ever).
  const bPath = bindingPathFor({ worktreesRoot: root, identityHash: h });
  if (!fs.existsSync(bPath)) {
    return fail('SESSION_INTAKE_NO_BINDING', 'No canonical workspace binding exists for this identity; session-at-intake refuses to provision or backfill a session.', { identityHash: h, bindingPath: bPath });
  }
  const v = verifyBinding({ worktreesRoot: root, repo, issueNumber, baseSha, cwd: controlCwd, exec });
  if (!v.ok) return fail('SESSION_INTAKE_BIND_INVALID', `Workspace binding verification failed: ${v.reason}`, { identityHash: h, verify: v });

  // (2) Canonical admission: the session is published by the SAME taskStart
  // transaction run.js uses (transactional, idempotent, drift fail-closed).
  const r = taskStart({ repo, issueNumber, baseSha, worktreesRoot: root, stateDir: stateRoot, controlCwd, exec, taskContract, dispatchOptions });
  if (!r.ok) return r;

  // (3) Identity-chain read-back BEFORE ok: one identityHash must be visible
  // in the session record, the worktree path and the control-plane pointers.
  const sPath = sessionPathFor({ stateDir: stateRoot, identityHash: h });
  const rs = readSessionRecord(sPath);
  if (!rs.ok) return fail('SESSION_INTAKE_READBACK_FAILED', rs.reason, { identityHash: h });
  const session = rs.session;
  const wtPath = worktreePathFor({ worktreesRoot: root, identityHash: h });
  const chain = {
    identityHash: h,
    taskId: session.taskId,
    repo: session.repo,
    issueNumber: session.issueNumber,
    worktreePath: session.worktreePath,
    sessionPath: sPath,
  };
  if (session.identityHash !== h
      || session.worktreePath !== wtPath
      || (session.controlPlane && session.controlPlane.sessionPath) !== sPath
      || Number(session.issueNumber) !== issueNumber) {
    return fail('SESSION_INTAKE_IDENTITY_CHAIN_BROKEN', 'Session record does not match the canonical identity chain.', { chain });
  }

  // (4) Bind the ControlLoop terminalize token INTO the session record at
  // intake (ControlLoop-owned primitive; first binding wins, never rotated by
  // re-intake). Read-back the persisted token before reporting success.
  const bnd = bindSessionLoop({ sessionPath: sPath, identityHash: h, stateDir: stateRoot });
  if (!bnd.ok) return fail(bnd.code || 'SESSION_INTAKE_BIND_FAILED', bnd.detail, { chain });
  const back = readSessionRecord(sPath);
  if (!back.ok || !(back.session.controlLoop && back.session.controlLoop.terminalizeToken)) {
    return fail('SESSION_INTAKE_TOKEN_READBACK_FAILED', 'controlLoop.terminalizeToken not persisted after bind.', { chain });
  }
  return {
    ok: true,
    ...r, // worktree / session / taskPacket / evidence shapes from taskStart
    sessionAtIntake: {
      schemaVersion: SESSION_AT_INTAKE_SCHEMA_VERSION,
      identityHash: h,
      taskId: session.taskId,
      worktreePath: wtPath,
      branch: session.branch,
      baseSha,
      sessionPath: sPath,
      bindingPath: bPath,
      tokenBound: true,
      tokenAlreadyBound: bnd.value ? bnd.value.alreadyBound === true : false,
    },
  };
}

// ---- readCanonicalTask ----------------------------------------------------------
// The ONE canonical reader for downstream task-server legs (handoff, review,
// rework, delivery): branch/headSha/worktreePath are read FROM the canonical
// session record — free-form identity arguments are never accepted when the
// canonical session exists. A task that never entered session-at-intake fails
// closed with SESSION_NOT_FOUND (no backfill, no synthetic record).
export function readCanonicalTask({ repo, issueNumber, stateDir = defaultStateDir(), worktreesRoot = defaultWorktreesRoot() } = {}) {
  if (typeof repo !== 'string' || !repo) return fail('MISSING_REPO');
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return fail('MISSING_ISSUE_NUMBER');
  const root = path.resolve(worktreesRoot);
  const stateRoot = path.resolve(stateDir);
  const h = identityHash({ repo, issueNumber });
  if (!h) return fail('IDENTITY_UNSTABLE');
  const sPath = sessionPathFor({ stateDir: stateRoot, identityHash: h });
  const rs = readSessionRecord(sPath);
  if (!rs.ok) {
    return fail('SESSION_NOT_FOUND', `No canonical session at ${sPath} — the task-server flow never entered session-at-intake.`, { identityHash: h, sessionPath: sPath });
  }
  const session = rs.session;
  if (session.identityHash !== h) {
    return fail('IDENTITY_CHAIN_BROKEN', `session.identityHash=${session.identityHash} expected=${h}`, { sessionPath: sPath });
  }
  const bPath = bindingPathFor({ worktreesRoot: root, identityHash: h });
  let binding = null;
  try {
    binding = JSON.parse(fs.readFileSync(bPath, 'utf8'));
    if (!binding || binding.identityHash !== h) {
      return fail('IDENTITY_CHAIN_BROKEN', 'workspace binding identityHash mismatch', { bindingPath: bPath });
    }
  } catch { binding = null; }
  return { ok: true, identityHash: h, session, binding, sessionPath: sPath, bindingPath: bPath, worktreePath: session.worktreePath };
}