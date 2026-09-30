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

function writeResult(p, result) {
  const target = `${p}.result.json`;
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...result, at: new Date().toISOString() }) + '\n');
  fs.renameSync(tmp, target);
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
  let result;
  try {
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
  runControlLoopRoute({ requestPath: process.argv[2] })
    .then((r) => { process.exitCode = r.ok ? 0 : 1; })
    .catch((e) => { process.stderr.write(`control-loop route worker: ${String(e)}\n`); process.exitCode = 1; });
}
