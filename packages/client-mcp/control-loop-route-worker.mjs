#!/usr/bin/env node
// Detached Gateway entry point. The existing runner (not this worker) owns
// session admission, FSM transitions, executor, review and Telegram milestones.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSocControlLoop } from '../../bin/soc-control-loop.mjs';
import { readSessionRecord } from '../runtime-sandbox/runtime-sandbox.mjs';
import { dispatchLifecycleEvent } from '../telegram-dispatch/telegram-dispatch.mjs';
import { readTransitions } from '../control-loop/control-loop.mjs';
import { recoverNonterminalExecutions } from '../executor-launcher/executor-recovery.mjs';
import { reapInterruptedExecution } from '../executor-launcher/executor-reaper.mjs';

function writeResult(p, result) {
  const target = `${p}.result.json`;
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...result, at: new Date().toISOString() }) + '\n');
  fs.renameSync(tmp, target);
}

// Worker death (killed by transport teardown / parent termination / hard crash)
// must never leave a SILENT gap: persist a typed, UNKNOWN result and prime the
// canonical #157 reaper so a proven-dead execution is reconciled as INTERRUPTED
// instead of hanging forever. This block never fabricates exit codes, never
// terminalizes the task FSM, and never re-dispatches.
export function primeRouteFailureSurfaces({ requestPath, req, controlCwd = process.cwd(), verifyAuthority = null } = {}) {
  if (typeof requestPath !== 'string' || !requestPath) return { ok: false, reason: 'NO_REQUEST_PATH' };
  const out = { ok: true, resultPersisted: false, reap: null };
  try {
    const target = `${requestPath}.result.json`;
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, JSON.stringify({
        ok: false, code: 'LOOP_WORKER_EXITED',
        detail: 'control-loop route worker exited before the runner produced a result; execution outcome is UNKNOWN',
        at: new Date().toISOString(),
      }) + '\n');
      out.resultPersisted = true;
    }
  } catch { /* best effort */ }
  try {
    if (req && req.sessionPath && req.stateDir) {
      const rs = readSessionRecord(req.sessionPath);
      if (rs.ok && rs.session && typeof rs.session.lease?.token === 'string') {
        out.reap = reapInterruptedExecution({
          sessionPath: req.sessionPath,
          leaseToken: rs.session.lease.token,
          stateDir: req.stateDir,
          controlCwd,
          ...(typeof verifyAuthority === 'function' ? { verifyAuthority } : {}),
        });
      }
    }
  } catch { /* best effort */ }
  return out;
}

// Canonical startup sweep: at the top of every detached-route attempt, reap
// records left dead-and-unfinalized by a previous lost worker. Proven-dead only
// (PID_GONE), idempotent, never kills, never dispatches.
export function armRouteCrashSurfaces({ requestPath, req = null, controlCwd = process.cwd(), verifyAuthority = null } = {}) {
  if (typeof requestPath !== 'string' || !requestPath) return { ok: false, reason: 'NO_REQUEST_PATH' };
  const prime = () => { try { primeRouteFailureSurfaces({ requestPath, req, controlCwd, verifyAuthority }); } catch { /* best effort */ } };
  process.on('exit', prime);
  process.on('uncaughtException', () => { prime(); process.exit(1); });
  process.on('unhandledRejection', () => { prime(); process.exit(1); });
  return { ok: true };
}

export function runStartupRecoverySweep({ stateDir, repo, controlCwd = process.cwd() } = {}) {
  try {
    return recoverNonterminalExecutions({ stateDir, repo, controlCwd });
  } catch (e) {
    return { ok: false, reason: 'STARTUP_RECOVERY_FAILED', detail: String((e && e.message) || e) };
  }
}

export async function runControlLoopRoute({ requestPath, run = runSocControlLoop, dispatch = dispatchLifecycleEvent } = {}) {
  let req;
  try { req = JSON.parse(fs.readFileSync(requestPath, 'utf8')); }
  catch { return { ok: false, code: 'LOOP_REQUEST_UNREADABLE' }; }
  if (req?.kind !== 'soc-control-loop-route' || !req.sessionPath || !req.stateDir || !req.identityHash
      || !req.repo || !Number.isInteger(Number(req.issueNumber)) || typeof req.goal !== 'string' || !req.goal.trim()
      || !Number.isFinite(Date.parse(req.requestedAt)) || Math.abs(Date.now() - Date.parse(req.requestedAt)) > 60000) {
    return { ok: false, code: 'LOOP_REQUEST_INVALID' };
  }
  if (String(req.repo).toLowerCase() !== 'duongpdddic-droid/soc_brain') return { ok: false, code: 'LOOP_REPO_UNSUPPORTED' };
  const expected = path.join(path.resolve(req.stateDir), 'client-mcp', 'routes', `${req.identityHash}.control-loop.json`);
  if (path.resolve(requestPath) !== expected) return { ok: false, code: 'LOOP_REQUEST_PATH_MISMATCH' };
  // One gateway claim == one runner attempt: the claim's requestedAt is unique
  // per identity, so a runner failure can never be deduped against an accepted
  // notification that belongs to a DIFFERENT attempt.
  const attemptKey = createHash('sha256').update(`${req.identityHash}|${req.requestedAt}`).digest('hex');
  const rs = readSessionRecord(req.sessionPath);
  if (!rs.ok || rs.session.identityHash !== req.identityHash
      || rs.session.repo !== req.repo || Number(rs.session.issueNumber) !== Number(req.issueNumber)
      || path.resolve(rs.session.controlPlane?.stateDir || '') !== path.resolve(req.stateDir)) {
    // The claim path is proven canonical above, so a durable typed result is
    // truthful; the session itself is NOT bound to this request, so no
    // notification is ever sent from an unproven session.
    writeResult(requestPath, { ok: false, code: 'LOOP_SESSION_IDENTITY_MISMATCH',
      detail: 'the route claim and the session record disagree on identity/binding; the runner refused to start.' });
    return { ok: false, code: 'LOOP_SESSION_IDENTITY_MISMATCH' };
  }
  const session = rs.session;
  runStartupRecoverySweep({ stateDir: req.stateDir, repo: req.repo, controlCwd: process.cwd() });
  let result;
  try {
    // `bootstrap: true` is a REQUEST, not an order: the runner owns the task
    // state and applies the §A.2b gate (bin/soc-control-loop.mjs), so a freshly
    // taskStart()-provisioned branch with zero commits ahead of its base is
    // never forced into a doomed `gh pr create` ("No commits between main and
    // <branch>"). Fail-closed behaviour of the bootstrapper itself is unchanged.
    result = await run({ repo: req.repo, issueNumber: Number(req.issueNumber), goal: req.goal, stateDir: req.stateDir, bootstrap: true });
  } catch (e) {
    result = { ok: false, code: 'LOOP_RUNNER_THROWN', detail: String((e && e.message) || e).slice(0, 500) };
  }
  const projected = result?.ok === true
    ? { ok: true, state: result.value?.state ?? null }
    : { ok: false, code: result?.code || 'LOOP_RUNNER_FAILED', detail: result?.detail ?? null };
  writeResult(requestPath, projected);
  if (!projected.ok) {
    let alreadyNotifiedByFsm = false;
    try { alreadyNotifiedByFsm = readTransitions({ stateDir: req.stateDir, identityHash: req.identityHash }).at(-1)?.to === 'BLOCKED'; }
    catch { /* unknown ledger: send the runner failure alert */ }
    if (!alreadyNotifiedByFsm) {
      dispatch({ session: rs.session, stateDir: req.stateDir, event: 'GATEWAY_RUNNER_FAILED',
        eventKey: attemptKey,
        note: `Runner: ${projected.code}; ${String(projected.detail ?? '').slice(0, 400)}` });
    }
  }
  return projected;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) {
  const requestPath = process.argv[2];
  if (!requestPath) { process.stderr.write('usage: node control-loop-route-worker.mjs <requestPath>\n'); process.exit(2); }
  let reqClaim = null;
  try { reqClaim = JSON.parse(fs.readFileSync(requestPath, 'utf8')); } catch { reqClaim = null; }
  armRouteCrashSurfaces({ requestPath, req: reqClaim, controlCwd: process.cwd() });
  runControlLoopRoute({ requestPath })
    .then((r) => { process.exitCode = r.ok ? 0 : 1; })
    .catch((e) => { process.stderr.write(`control-loop route worker: ${String(e)}\n`); process.exitCode = 1; });
}
