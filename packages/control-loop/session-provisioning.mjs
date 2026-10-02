// session-provisioning.mjs — canonical session admission for the soc_control
// runner (Harness Hardening §A.1 / §A.2).
//
// WHY THIS EXISTS
//   bin/soc-control-loop.mjs used to hand-write a MINIMAL `SESSION_ACTIVE`
//   record (identity/repo/issue/createdAt only) so that `ingestGoalViaBootstrapper`
//   had somewhere to stash prNumber/branch/worktreePath. Every downstream
//   consumer (startExecution, the MCP server, the broker) needs a CANONICAL
//   session: taskId, identityHash, repo, issueNumber, baseSha, branch,
//   worktreePath, lease.token, controlPlane{stateDir, sessionPath, bindingPath,
//   worktreesRoot} plus a binding file that agrees with all of it. The minimal
//   record could never satisfy that, so the CLI now admits through the ONE
//   canonical primitive (`taskStart`) and read-backs everything it is given.
//
// TWO MODES, NEVER BOTH
//   * session ABSENT  -> taskStart() provisions worktree + binding + session
//     transactionally. Nothing is hand-synthesised: every field is what the
//     primitive published, then re-read and re-validated.
//   * session PRESENT -> pure read-back + validation (no second provisioning
//     path, no second worktree, no metadata cross-assignment). A legacy/minimal
//     record fails SESSION_MINIMAL instead of being silently patched up.
//
// All checks are deterministic and offline. Git identity is proven two ways:
//   * presence of the identity hash binding (identityHash(repo, issue) ==
//     session.identityHash == binding.identityHash == the path/branch namespace)
//   * when the worktree exists on disk, verifyBinding() re-reads the real Git
//     state (branch, remote, base ancestry) — fail-closed on any mismatch.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  identityHash, worktreePathFor, bindingPathFor, worktreeBranchFor,
  verifyBinding, defaultWorktreesRoot, SHA40_RE,
} from '../workspace/workspace.mjs';
import { sessionPathFor, taskStart, readSessionRecord } from '../runtime-sandbox/runtime-sandbox.mjs';

export const CANONICAL_SESSION_SCHEMA_VERSION = '1';
export const CONTROL_PLANE_KEYS = Object.freeze(['stateDir', 'sessionPath', 'bindingPath', 'worktreesRoot']);
export const REQUIRED_SESSION_FIELDS = Object.freeze([
  'taskId', 'identityHash', 'repo', 'issueNumber', 'baseSha', 'branch', 'worktreePath', 'worktreesRoot',
]);
export const REQUIRED_BINDING_FIELDS = Object.freeze([
  'taskId', 'repo', 'issueNumber', 'baseSha', 'branch', 'path', 'identityHash',
]);

function fail(code, detail) { return { ok: false, code, detail: detail ?? null }; }
function ok(value) { return { ok: true, value }; }

// ---- binding read-back ------------------------------------------------------
export function readBindingRecord(bindingPath) {
  if (typeof bindingPath !== 'string' || !bindingPath) return fail('SESSION_BINDING_MISSING', 'bindingPath is absent from controlPlane');
  let raw;
  try { raw = fs.readFileSync(bindingPath, 'utf8'); } catch (e) {
    return fail('SESSION_BINDING_MISSING', `binding unreadable (${bindingPath}): ${String((e && e.message) || e)}`);
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    return fail('SESSION_BINDING_MALFORMED', `${bindingPath}: ${String((e && e.message) || e)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('SESSION_BINDING_MALFORMED', bindingPath);
  return ok(parsed);
}

// ---- canonical session validation ------------------------------------------
// Structural + cross-file read-back. `verifyGit` additionally re-reads the real
// Git state of the worktree (only possible when the worktree exists).
export function validateCanonicalSession({
  session, sessionPath = null, stateDir = null, bindingPath = null,
  repo = null, issueNumber = null, verifyGit = 'auto', controlCwd = process.cwd(), exec = execFileSync,
} = {}) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return fail('SESSION_MINIMAL', 'session record is not an object');

  const missing = REQUIRED_SESSION_FIELDS.filter((f) => {
    const v = session[f];
    return v === undefined || v === null || (typeof v === 'string' && !v.trim());
  });
  if (missing.length) return fail('SESSION_MINIMAL', `canonical session fields missing: ${missing.join(', ')}`);

  if (session.state !== 'SESSION_ACTIVE') return fail('SESSION_NOT_ACTIVE', `state=${session.state}`);
  if (!SHA40_RE.test(String(session.baseSha))) return fail('SESSION_MINIMAL', `baseSha is not a 40-hex SHA: ${session.baseSha}`);

  const lease = session.lease;
  if (!lease || typeof lease !== 'object' || typeof lease.token !== 'string' || !lease.token.trim()) {
    return fail('SESSION_LEASE_MISSING', 'session.lease.token is required (lease is the launch authority)');
  }

  const cp = session.controlPlane;
  if (!cp || typeof cp !== 'object') return fail('SESSION_CONTROLPLANE_INCOMPLETE', 'controlPlane is absent');
  const cpMissing = CONTROL_PLANE_KEYS.filter((k) => typeof cp[k] !== 'string' || !cp[k].trim());
  if (cpMissing.length) return fail('SESSION_CONTROLPLANE_INCOMPLETE', `controlPlane keys missing: ${cpMissing.join(', ')}`);
  if (sessionPath && path.resolve(cp.sessionPath) !== path.resolve(sessionPath)) {
    return fail('SESSION_CONTROLPLANE_INCOMPLETE', `controlPlane.sessionPath=${cp.sessionPath} != ${sessionPath}`);
  }
  if (stateDir && path.resolve(cp.stateDir) !== path.resolve(stateDir)) {
    return fail('SESSION_CONTROLPLANE_INCOMPLETE', `controlPlane.stateDir=${cp.stateDir} != ${stateDir}`);
  }
  if (typeof session.worktreesRoot !== 'string' || path.resolve(cp.worktreesRoot) !== path.resolve(session.worktreesRoot)) {
    return fail('SESSION_CONTROLPLANE_INCOMPLETE', `controlPlane.worktreesRoot=${cp.worktreesRoot} != session.worktreesRoot=${session.worktreesRoot}`);
  }

  // Identity binding: the namespace that worktreePath / branch / bindingPath
  // are derived from MUST round-trip to session.identityHash.
  const derived = identityHash({ repo: session.repo, issueNumber: session.issueNumber });
  if (!derived || derived !== session.identityHash) {
    return fail('SESSION_IDENTITY_MISMATCH', `identityHash=${session.identityHash} but identityHash(repo,issue)=${derived}`);
  }
  if (repo != null) {
    const wantRepo = identityHash({ repo, issueNumber: session.issueNumber });
    if (!wantRepo || wantRepo !== session.identityHash) {
      return fail('SESSION_IDENTITY_MISMATCH', `session is for another repo: session.repo=${session.repo} requested repo=${repo}`);
    }
  }
  if (issueNumber != null && Number(session.issueNumber) !== Number(issueNumber)) {
    return fail('SESSION_IDENTITY_MISMATCH', `session.issueNumber=${session.issueNumber} requested issueNumber=${issueNumber}`);
  }
  const wantWt = worktreePathFor({ worktreesRoot: session.worktreesRoot, identityHash: session.identityHash });
  if (path.resolve(session.worktreePath) !== path.resolve(wantWt)) {
    return fail('SESSION_WORKTREE_NONCANONICAL', `worktreePath=${session.worktreePath} expected ${wantWt}`);
  }
  const wantBranch = worktreeBranchFor({ identityHash: session.identityHash });
  if (session.branch !== wantBranch) {
    return fail('SESSION_WORKTREE_NONCANONICAL', `branch=${session.branch} expected ${wantBranch}`);
  }

  // Binding read-back: same identity fields, same canonical path/branch.
  const bp = bindingPath || cp.bindingPath;
  const wantBinding = bindingPathFor({ worktreesRoot: session.worktreesRoot, identityHash: session.identityHash });
  if (path.resolve(bp) !== path.resolve(wantBinding)) {
    return fail('SESSION_BINDING_MISSING', `bindingPath=${bp} expected ${wantBinding}`);
  }
  const br = readBindingRecord(bp);
  if (!br.ok) return br;
  const binding = br.value;
  // The binding record names the worktree field `path`; the Session names it
  // `worktreePath`. Every other canonical field is spelled identically on both
  // sides, so the comparison is an explicit field map — never a blind `session[f]`
  // lookup that would compare binding.path against a non-existent session.path.
  const BINDING_TO_SESSION_FIELD = {
    taskId: 'taskId', repo: 'repo', issueNumber: 'issueNumber', baseSha: 'baseSha',
    branch: 'branch', path: 'worktreePath', identityHash: 'identityHash',
  };
  const bad = REQUIRED_BINDING_FIELDS.filter((f) => {
    const sk = BINDING_TO_SESSION_FIELD[f] || f;
    return String(binding[f] ?? '') !== String(session[sk] ?? '');
  });
  if (bad.length) {
    return fail('SESSION_BINDING_MISMATCH', `binding/session disagree on: ${bad.join(', ')}`);
  }

  // Git identity read-back (only meaningful once the worktree exists).
  const wtExists = (() => { try { return fs.statSync(session.worktreePath).isDirectory(); } catch { return false; } })();
  const wantGit = verifyGit === true || (verifyGit !== false && wtExists);
  if (wantGit) {
    if (!wtExists) return fail('SESSION_WORKTREE_MISSING', `worktree absent at ${session.worktreePath}`);
    const vb = verifyBinding({
      worktreesRoot: session.worktreesRoot,
      repo: session.repo,
      issueNumber: Number(session.issueNumber),
      baseSha: session.baseSha,
      cwd: controlCwd,
      exec,
    });
    if (!vb.ok) return fail('SESSION_BINDING_GIT_MISMATCH', `${vb.reason}: ${vb.detail ?? ''}`);
  }

  return ok({ session, binding, bindingPath: bp });
}

// ---- read-back helper (session + binding + validation) ----------------------
export function readCanonicalSession({
  sessionPath, stateDir = null, repo = null, issueNumber = null,
  verifyGit = 'auto', controlCwd = process.cwd(), exec = execFileSync,
} = {}) {
  const rs = readSessionRecord(sessionPath);
  if (!rs.ok) return fail(rs.reason === 'SESSION_NOT_FOUND' ? 'SESSION_NOT_FOUND' : 'SESSION_READ_FAILED', rs.detail ?? sessionPath);
  return validateCanonicalSession({
    session: rs.session, sessionPath,
    stateDir: stateDir ?? ((rs.session.controlPlane && rs.session.controlPlane.stateDir) || null),
    repo, issueNumber, verifyGit, controlCwd, exec,
  });
}

// ---- base SHA resolution (local, no network) --------------------------------
export function resolveBaseSha({ baseRef = 'origin/main', controlCwd = process.cwd(), exec = execFileSync } = {}) {
  try {
    const out = exec('git', ['-C', controlCwd, 'rev-parse', `${baseRef}^{commit}`], { encoding: 'utf8' });
    const sha = String(out || '').trim();
    if (!SHA40_RE.test(sha)) return fail('BASE_SHA_UNRESOLVED', `git rev-parse ${baseRef} -> ${JSON.stringify(sha.slice(0, 80))}`);
    return ok(sha);
  } catch (e) {
    return fail('BASE_SHA_UNRESOLVED', `${baseRef}: ${String((e && e.message) || e).slice(0, 300)}`);
  }
}

/**
 * ensureCanonicalSession — the ONLY session admission the runner performs.
 *
 * session absent  -> taskStart() (canonical primitive) + read-back + validate.
 * session present -> read-back + validate (never synthesise, never patch up).
 */
export async function ensureCanonicalSession({
  repo, issueNumber,
  sessionPath = null,
  stateDir,
  worktreesRoot = null,
  controlCwd = process.cwd(),
  goal = null,
  taskContract = null,
  baseSha = null,
  baseRef = process.env.SOC_TASK_BASE || 'origin/main',
  laneId = null,
  taskStartImpl = null,
  exec = execFileSync,
  requireSessionWhenAbsent = true,
} = {}) {
  if (typeof repo !== 'string' || !repo) return fail('ARGS_INVALID', 'repo is required');
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return fail('ARGS_INVALID', 'issueNumber must be a positive integer');
  const h = identityHash({ repo, issueNumber });
  if (!h) return fail('IDENTITY_UNSTABLE', 'identityHash could not be derived');
  const wtRoot = worktreesRoot || defaultWorktreesRoot();
  const expectedPath = sessionPathFor({ stateDir, identityHash: h });
  const sp = sessionPath || expectedPath;
  if (path.resolve(sp) !== path.resolve(expectedPath)) {
    return fail('SESSION_PATH_NONCANONICAL', `sessionPath=${sp} expected ${expectedPath}`);
  }

  const exists = (() => { try { return fs.statSync(sp).isFile(); } catch { return false; } })();

  if (exists) {
    const v = readCanonicalSession({ sessionPath: sp, stateDir, repo, issueNumber, controlCwd, exec });
    if (!v.ok) return v;
    return ok({ ...v.value, sessionPath: sp, worktreesRoot: v.value.session.worktreesRoot, created: false });
  }

  if (!requireSessionWhenAbsent) return fail('SESSION_NOT_FOUND', sp);
  const start = taskStartImpl || taskStart;
  if (typeof start !== 'function') return fail('SESSION_NOT_FOUND', sp);

  let effectiveBaseSha = baseSha;
  if (!effectiveBaseSha) {
    const r = resolveBaseSha({ baseRef, controlCwd, exec });
    if (!r.ok) return r;
    effectiveBaseSha = r.value;
  }

  let ts;
  try {
    ts = start({
      repo, issueNumber, baseSha: effectiveBaseSha,
      worktreesRoot: wtRoot, stateDir, controlCwd, exec,
      taskContract: taskContract || (goal
        ? { title: `Task #${issueNumber}`, body: String(goal) }
        : null),
      mutationLaneId: laneId,
    });
  } catch (e) {
    return fail('TASK_START_FAILED', String((e && e.message) || e));
  }
  if (!ts || ts.ok !== true) {
    return fail((ts && ts.reason) || 'TASK_START_FAILED', ts && (ts.detail ?? ts.verify ?? ts.errors ?? null));
  }

  const v = readCanonicalSession({ sessionPath: sp, stateDir, repo, issueNumber, controlCwd, exec });
  if (!v.ok) return v;
  return ok({ ...v.value, sessionPath: sp, worktreesRoot: v.value.session.worktreesRoot, created: true, taskStart: ts });
}

// end of session-provisioning.mjs
