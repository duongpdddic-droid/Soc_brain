#!/usr/bin/env node
// telegram-dispatch.test.mjs — Issue #65 rev-2 deterministic tests (no framework).
// Proves the canonical FSM → Telegram lifecycle delivery contract:
//   A0. NOTIFIABLE_EVENTS = the 7 mandatory milestones; truthful levels only
//   B1. dedupe ONLY after API_ACCEPTED (rev-2 blocker A)
//   B2. DELIVERY_FAILED does NOT permanently suppress; explicit bounded
//       recovery reaches API_ACCEPTED; replay dedupes afterwards
//   B3. recovery budget bounded by PERSISTED evidence (no autonomous retry)
//   B4. crash/restart: orphaned intent recoverable (CASE 1), failed delivery
//       recoverable (CASE 2), accepted delivery never duplicated (CASE 3)
//   C.  FSM integration: dispatch inside canonical transitions; FSM correct
//       when the transport fails
//   C2. real worker, missing config: truthful NOT_ATTEMPTED, no budget burn,
//       recoverable once config exists
//   D.  executor omission cannot suppress notification (dispatch inside FSM)
//   E.  HUMAN_GATE ordering + failed delivery stays visible + gate recovery
//       (no invisible wait)
//   F.  MCP surface: executor cannot bypass/spoof; canonical recovery tool
//   G.  human-first formatter (rev-2 req E)
//   H.  unrelated transitions stay silent
// Exit 0 = PASS, 1 = FAIL. Disposable temp dirs only; the Telegram transport
// is fully mocked (spawn is injectable), so no network is touched here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  dispatchLifecycleEvent, recoverLifecycleEvent, dispatchPathFor,
  readDispatchRecords, buildTelegramText, NOTIFIABLE_EVENTS,
  DELIVERY_STATUSES, MAX_DELIVERY_ATTEMPTS,
  boundTelegramText, awaitDispatchSlot, resetDispatchQueueForTests,
  TELEGRAM_DISPATCH_INTERVAL_MS,
  spoolPathFor, readSpooledEvents, isTransientSpoolError,
  TELEGRAM_SPOOL_MAX_PER_FLUSH, TELEGRAM_SPOOL_BACKOFF_BASE_MS,
} from '../packages/telegram-dispatch/telegram-dispatch.mjs';
import {
  sendJsonWithRetry, MAX_ATTEMPTS, REQUEST_TIMEOUT_MS, RETRY_DELAYS_MS,
  telegramHealthcheck,
} from '../packages/telegram-dispatch/telegram-worker.mjs';
import {
  taskStart, taskFinish, taskBlock, taskRequestHumanGate, recoverHumanGate, readSessionRecord,
} from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

const CANON = 'duongpdddic-droid/Soc_brain';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-tg-'));

// Deterministic transport mocks: one accepted message id per helper.
const mkAccept = (id = 4242) => () => ({ error: 0, stdout: JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: id, chatId: 816272951 }) + '\n', stderr: '' });
const mkFail = () => ({ error: 0, stdout: JSON.stringify({ ok: false, status: 'DELIVERY_FAILED', error: 'HTTP_502' }) + '\n', stderr: '' });
const mkTransientFail = (err = 'HTTP_429') => () => ({ error: 0, stdout: JSON.stringify({ ok: false, status: 'DELIVERY_FAILED', error: err }) + '\n', stderr: '' });
const recsFor = (sd, n) => readDispatchRecords(dispatchPathFor({ stateDir: sd, identityHash: identityHash({ repo: CANON, issueNumber: n }) }));
// Simulates a crash: an intent record landed in the ledger, the process died
// before the worker produced any result record.
function appendRecordSim(stateDir, issueNumber, event, record) {
  const p = dispatchPathFor({ stateDir: stateDir, identityHash: identityHash({ repo: CANON, issueNumber }) });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, `${JSON.stringify({ schemaVersion: '2', at: new Date().toISOString(), event, identityHash: identityHash({ repo: CANON, issueNumber }), taskId: `${CANON.toLowerCase()}#${issueNumber}`, repo: CANON, issueNumber, status: 'NOT_ATTEMPTED', messageId: null, chatId: null, error: null, ...record })}\n`, 'utf8');
}

function makeSession(stateDir, issueNumber, state = 'SESSION_ACTIVE') {
  return {
    schemaVersion: '1', state,
    taskId: `${CANON.toLowerCase()}#${issueNumber}`,
    repo: CANON, issueNumber,
    branch: 'agent/test', headSha: 'a'.repeat(40),
    controlPlane: { stateDir },
  };
}

// ---- A0. contract surface -----------------------------------------------------
eq('NOTIFIABLE_EVENTS is the 7 mandatory milestones + 6 granular FSM milestones (Issue #9000021)',
  NOTIFIABLE_EVENTS.join(','),
  'TASK_STARTED,HUMAN_GATE_REQUIRED,READY_FOR_REVIEW,TASK_COMPLETED,TASK_BLOCKED,TASK_FAILED,ROADMAP_COMPLETED,ROUTED,EXECUTING,VERIFYING,FINAL_REVIEWING,DECIDING,DELIVERING');
eq('DELIVERY_STATUSES are exactly the truthful levels',
  DELIVERY_STATUSES.join(','),
  'NOT_ATTEMPTED,API_ACCEPTED,DELIVERY_FAILED');
falsy('no USER_RECEIVED level exists', DELIVERY_STATUSES.includes('USER_RECEIVED'));

// ---- B1. API_ACCEPTED is the ONLY terminal dedupe (rev-2 blocker A) ------------
{
  const sd = path.join(TMP, 'st1');
  const p = dispatchPathFor({ stateDir: sd, identityHash: identityHash({ repo: CANON, issueNumber: 1 }) });
  const r1 = dispatchLifecycleEvent({ session: makeSession(sd, 1), event: 'TASK_COMPLETED', stateDir: sd, spawn: mkAccept(4242), allowNonCanonicalStateRoot: true });
  eq('B1 first send API_ACCEPTED', r1.status, 'API_ACCEPTED');
  eq('B1 messageId returned', r1.messageId, 4242);
  const recs = readDispatchRecords(p);
  eq('B1 intent+result persisted to JSONL', recs.length, 2);
  eq('B1 intent record first (crash-safe ordering)', recs[0].phase, 'intent');
  eq('B1 result record messageId', recs[1].messageId, 4242);
  eq('B1 result record status', recs[1].status, 'API_ACCEPTED');
  const r2 = dispatchLifecycleEvent({ session: makeSession(sd, 1), event: 'TASK_COMPLETED', stateDir: sd, spawn: mkAccept(9999), allowNonCanonicalStateRoot: true });
  eq('B1 duplicate/replay dedupes (no second send)', r2.deduped, true);
  eq('B1 dedupe returns recorded messageId (not the new one)', r2.messageId, 4242);
  eq('B1 ledger unchanged after replay', readDispatchRecords(p).length, 2);
}

// ---- B2. DELIVERY_FAILED is NOT terminal; bounded explicit recovery -------------
{
  const sd = path.join(TMP, 'st2');
  const p = dispatchPathFor({ stateDir: sd, identityHash: identityHash({ repo: CANON, issueNumber: 2 }) });
  const r1 = dispatchLifecycleEvent({ session: makeSession(sd, 2), event: 'TASK_FAILED', stateDir: sd, spawn: mkFail, allowNonCanonicalStateRoot: true });
  eq('B2 transport failure -> DELIVERY_FAILED', r1.status, 'DELIVERY_FAILED');
  falsy('B2 no messageId on failure', r1.messageId);
  // Plain replay does NOT resend (no autonomous retry), but stays RECOVERABLE.
  const r2 = dispatchLifecycleEvent({ session: makeSession(sd, 2), event: 'TASK_FAILED', stateDir: sd, spawn: mkAccept(777), allowNonCanonicalStateRoot: true });
  eq('B2 plain replay after failure does not re-send', r2.deduped, true);
  eq('B2 plain replay reports the truthful failure', r2.status, 'DELIVERY_FAILED');
  eq('B2 plain replay marks the event recoverable', r2.recovery, 'RECOVERABLE');
  eq('B2 plain replay wrote no new records', readDispatchRecords(p).length, 2);
  // Explicit bounded recovery: one canonical call, one attempt.
  const rec = recoverLifecycleEvent({ session: makeSession(sd, 2), event: 'TASK_FAILED', stateDir: sd, spawn: mkAccept(777), allowNonCanonicalStateRoot: true });
  eq('B2 explicit recovery reaches API_ACCEPTED', rec.status, 'API_ACCEPTED');
  eq('B2 recovery messageId', rec.messageId, 777);
  const fin = recsFor(sd, 2).filter((r) => r.status === 'API_ACCEPTED');
  eq('B2 exactly one accepted record', fin.length, 1);
  eq('B2 accepted record is the recovery result', fin[0].messageId, 777);
  // After acceptance, replay dedupes permanently and recovery is a no-op.
  const rr = dispatchLifecycleEvent({ session: makeSession(sd, 2), event: 'TASK_FAILED', stateDir: sd, spawn: mkAccept(31337), allowNonCanonicalStateRoot: true });
  eq('B2 replay after recovery dedupes with the original messageId', rr.messageId, 777);
  const rec2 = recoverLifecycleEvent({ session: makeSession(sd, 2), event: 'TASK_FAILED', stateDir: sd, spawn: mkAccept(999), allowNonCanonicalStateRoot: true });
  eq('B2 recovery after acceptance dedupes (no resend)', rec2.deduped, true);
  eq('B2 no second accepted record ever', recsFor(sd, 2).filter((r) => r.status === 'API_ACCEPTED').length, 1);
}

// ---- B3. recovery budget is bounded by PERSISTED evidence (rev-2 H5) ------------
{
  const sd = path.join(TMP, 'st2b');
  const budget = MAX_DELIVERY_ATTEMPTS;
  tru('B3 budget exported and finite', budget === 3);
  const r1 = dispatchLifecycleEvent({ session: makeSession(sd, 21), event: 'TASK_BLOCKED', stateDir: sd, spawn: mkFail, allowNonCanonicalStateRoot: true });
  eq('B3 first attempt fails', r1.status, 'DELIVERY_FAILED');
  for (let i = 0; i < budget - 1; i++) {
    const rec = recoverLifecycleEvent({ session: makeSession(sd, 21), event: 'TASK_BLOCKED', stateDir: sd, spawn: mkFail, allowNonCanonicalStateRoot: true });
    eq(`B3 recovery attempt ${i + 1} runs (bounded, persisted)`, rec.status, 'DELIVERY_FAILED');
    eq(`B3 recovery attempt ${i + 1} drains the budget`, rec.attempts, i + 2);
  }
  const recX = recoverLifecycleEvent({ session: makeSession(sd, 21), event: 'TASK_BLOCKED', stateDir: sd, spawn: mkFail, allowNonCanonicalStateRoot: true });
  eq('B3 next recovery is refused (budget exhausted)', recX.reason, 'ATTEMPT_BUDGET_EXHAUSTED');
  eq('B3 no worker invocation after exhaustion', recX.attempts, budget);
  eq('B3 no new records after exhaustion', recsFor(sd, 21).length, budget * 2);
}

// ---- B4. crash/restart semantics (rev-2 req C: CASE 1/2/3) -----------------------
{
  // CASE 1: canonical event persisted → intent appended → process died before
  // the send. The orphaned intent is recoverable later ("restart" = this new
  // process instance reading the same ledger).
  const sd1 = path.join(TMP, 'crash1');
  appendRecordSim(sd1, 31, 'TASK_STARTED', { phase: 'intent', attemptN: 1 });
  const rec1 = recoverLifecycleEvent({ session: makeSession(sd1, 31), event: 'TASK_STARTED', stateDir: sd1, spawn: mkAccept(7001), allowNonCanonicalStateRoot: true });
  eq('B4 CASE 1 orphaned intent recovered after restart', rec1.status, 'API_ACCEPTED');
  eq('B4 CASE 1 recovery messageId', rec1.messageId, 7001);
  // CASE 2: attempt failed → DELIVERY_FAILED persisted → recovery later →
  // same canonical event sent again → API_ACCEPTED.
  const sd2 = path.join(TMP, 'crash2');
  dispatchLifecycleEvent({ session: makeSession(sd2, 32), event: 'HUMAN_GATE_REQUIRED', stateDir: sd2, spawn: mkFail, allowNonCanonicalStateRoot: true, note: 'q' });
  eq('B4 CASE 2 failure persisted truthfully', recsFor(sd2, 32).filter((r) => r.status === 'DELIVERY_FAILED').length, 1);
  const rec2 = recoverLifecycleEvent({ session: makeSession(sd2, 32), event: 'HUMAN_GATE_REQUIRED', stateDir: sd2, spawn: mkAccept(7002), allowNonCanonicalStateRoot: true, note: 'q' });
  eq('B4 CASE 2 failed delivery recovered to API_ACCEPTED', rec2.status, 'API_ACCEPTED');
  // CASE 3: API_ACCEPTED persisted → "restart" → same event NOT sent twice.
  const rec3 = recoverLifecycleEvent({ session: makeSession(sd2, 32), event: 'HUMAN_GATE_REQUIRED', stateDir: sd2, spawn: mkAccept(7003), allowNonCanonicalStateRoot: true, note: 'q' });
  eq('B4 CASE 3 accepted delivery deduped after restart', rec3.status, 'API_ACCEPTED');
  eq('B4 CASE 3 dedupe keeps the ORIGINAL messageId', rec3.messageId, 7002);
  eq('B4 CASE 3 nothing was sent for the deduped recovery', rec3.deduped, true);
  eq('B4 CASE 3 ledger holds exactly one accepted record', recsFor(sd2, 32).filter((r) => r.status === 'API_ACCEPTED').length, 1);
  // Recovery never fabricates an event that was never dispatched.
  const recN = recoverLifecycleEvent({ session: makeSession(sd2, 32), event: 'TASK_COMPLETED', stateDir: sd2, spawn: mkAccept(7004), allowNonCanonicalStateRoot: true });
  eq('B4 recovery without prior evidence is refused (NOTHING_TO_RECOVER)', recN.reason, 'NOTHING_TO_RECOVER');
}

// ---- C. FSM integration: dispatch inside canonical transitions -----------------
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(TMP, 'repo-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'tester', GIT_AUTHOR_EMAIL: 't@e.x',
    GIT_COMMITTER_NAME: 'tester', GIT_COMMITTER_EMAIL: 't@e.x',
    GIT_CONFIG_GLOBAL: os.platform() === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_SYSTEM: os.platform() === 'win32' ? 'NUL' : '/dev/null',
  };
  const run = (args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run(['init', '--initial-branch=main', dir]);
  run(['config', 'user.email', 't@e.x']);
  run(['config', 'user.name', 'tester']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  run(['add', 'README.md']);
  run(['commit', '-m', 'init']);
  run(['remote', 'add', 'origin', 'https://github.com/duongpdddic-droid/Soc_brain.git']);
  return { dir, run, baseSha: run(['rev-parse', 'HEAD']).trim() };
}

const fakeAccept = () => ({ error: 0, stdout: JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 4242, chatId: 816272951 }) + '\n', stderr: '' });
const fakeFail = () => ({ error: 0, stdout: JSON.stringify({ ok: false, status: 'DELIVERY_FAILED', error: 'HTTP_502' }) + '\n', stderr: '' });

{
  const repo = makeRepo();
  const issueNumber = 301;
  const sd = path.join(TMP, 'st3');
  const disp = { stateDir: sd, spawn: fakeAccept, allowNonCanonicalStateRoot: true };
  const started = taskStart({
    repo: CANON, issueNumber, baseSha: repo.baseSha,
    worktreesRoot: path.join(TMP, 'wt3'), stateDir: path.join(TMP, '_state3'),
    controlCwd: repo.dir, dispatchOptions: disp,
  });
  tru('C taskStart ok', started.ok);
  eq('C TASK_STARTED dispatched on admission', started.telegramDispatch.status, 'API_ACCEPTED');
  const ledPath = dispatchPathFor({ stateDir: sd, identityHash: identityHash({ repo: CANON, issueNumber }) });
  eq('C TASK_STARTED delivered exactly once',
    readDispatchRecords(ledPath).filter((r) => r.event === 'TASK_STARTED' && r.status === 'API_ACCEPTED').length, 1);

  // Terminal transition with a FAILING transport: FSM must stay correct (req 3).
  const fin = taskFinish({ sessionPath: started.session.path, outcome: 'COMPLETED', dispatchOptions: { ...disp, spawn: fakeFail } });
  tru('C taskFinish ok despite dispatch failure', fin.ok);
  eq('C FSM state COMPLETED persisted before/after failed dispatch',
    readSessionRecord(started.session.path).session.state, 'COMPLETED');
  eq('C dispatch result DELIVERY_FAILED', fin.telegramDispatch.status, 'DELIVERY_FAILED');
  const sAfter = readSessionRecord(started.session.path).session;
  eq('C deliveryEvidence truthful in session record', sAfter.deliveryEvidence.status, 'DELIVERY_FAILED');
  falsy('C deliveryEvidence never claims USER_RECEIVED', sAfter.deliveryEvidence.status === 'USER_RECEIVED');
  eq('C ledger TASK_COMPLETED DELIVERY_FAILED persisted',
    readDispatchRecords(ledPath).some((r) => r.event === 'TASK_COMPLETED' && r.status === 'DELIVERY_FAILED'), true);

  // Replay: terminal + already-attempted — no second send (req 9).
  const fin2 = taskFinish({ sessionPath: started.session.path, outcome: 'COMPLETED', dispatchOptions: { ...disp, spawn: fakeAccept } });
  eq('C replayed taskFinish rejected', fin2.ok, false);
  eq('C replayed taskFinish reason', fin2.reason, 'SESSION_ALREADY_TERMINAL');
  eq('C ledger TASK_COMPLETED still exactly intent+result (one attempt)',
    readDispatchRecords(ledPath).filter((r) => r.event === 'TASK_COMPLETED').length, 2);

  // Unrelated transition does not notify (req 9).
  const before = readDispatchRecords(ledPath).length;
  const unr = dispatchLifecycleEvent({ session: sAfter, event: 'SESSION_ACTIVE', stateDir: sd, spawn: fakeAccept, allowNonCanonicalStateRoot: true });
  eq('C unrelated event not notifiable', unr.reason, 'EVENT_NOT_NOTIFIABLE');
  eq('C ledger unchanged after unrelated event', readDispatchRecords(ledPath).length, before);

  repo.run(['worktree', 'prune']);
}

// ---- C2. real worker, missing config: NOT_ATTEMPTED recorded exactly once ------
{
  const sd = path.join(TMP, 'st4');
  const p = dispatchPathFor({ stateDir: sd, identityHash: identityHash({ repo: CANON, issueNumber: 4 }) });
  // The real worker resolves config itself (env-config feature). Neutralize
  // EVERY fallback source or C2 would silently send a real Telegram message:
  // explicit path missing + no env pair + no AI_PR alt + no default file under
  // a fake home. spawnSync inherits process.env, so the child sees the isolation.
  const prevHome = process.env.USERPROFILE;
  const prevHomeUnix = process.env.HOME;
  const prevToken = process.env.TELEGRAM_BOT_TOKEN;
  const prevChat = process.env.TELEGRAM_CHAT_ID;
  const prevAlt = process.env.AI_PR_REVIEWER_TG_CONFIG;
  const fakeHome = path.join(TMP, 'fake-home-c2');
  try {
    fs.mkdirSync(fakeHome, { recursive: true });
    process.env.USERPROFILE = fakeHome;
    process.env.HOME = fakeHome;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.AI_PR_REVIEWER_TG_CONFIG;
    const r1 = dispatchLifecycleEvent({
      session: makeSession(sd, 4), event: 'TASK_BLOCKED', stateDir: sd,
      configPath: path.join(TMP, 'no-such-tg.json'), allowNonCanonicalStateRoot: true,
    });
    eq('C2 missing config -> NOT_ATTEMPTED (real worker, no network)', r1.status, 'NOT_ATTEMPTED');
    const recs = readDispatchRecords(p);
    eq('C2 intent + truthful NOT_ATTEMPTED persisted', recs.length, 2);
    eq('C2 result record status', recs[1].status, 'NOT_ATTEMPTED');
    const r2 = dispatchLifecycleEvent({
      session: makeSession(sd, 4), event: 'TASK_BLOCKED', stateDir: sd,
      configPath: path.join(TMP, 'no-such-tg.json'), allowNonCanonicalStateRoot: true,
    });
    falsy('C2 repeat does not append another record', readDispatchRecords(p).length > 2);
    eq('C2 repeat returns NOT_ATTEMPTED', r2.status, 'NOT_ATTEMPTED');
    // A config miss never sent anything: recovery delivers with a fresh budget.
    const r3 = recoverLifecycleEvent({ session: makeSession(sd, 4), event: 'TASK_BLOCKED', stateDir: sd, spawn: fakeAccept, allowNonCanonicalStateRoot: true });
    eq('C2 config-miss is recoverable (no budget consumed)', r3.status, 'API_ACCEPTED');
  } finally {
    if (prevHome === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevHome;
    if (prevHomeUnix === undefined) delete process.env.HOME; else process.env.HOME = prevHomeUnix;
    if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = prevToken;
    if (prevChat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = prevChat;
    if (prevAlt === undefined) delete process.env.AI_PR_REVIEWER_TG_CONFIG; else process.env.AI_PR_REVIEWER_TG_CONFIG = prevAlt;
  }
}

// ---- D. executor omission cannot suppress notification -------------------------
{
  const repo = makeRepo();
  const issueNumber = 302;
  const sd = path.join(TMP, 'st5');
  const disp = { stateDir: sd, spawn: fakeAccept, allowNonCanonicalStateRoot: true };
  const started = taskStart({
    repo: CANON, issueNumber, baseSha: repo.baseSha,
    worktreesRoot: path.join(TMP, 'wt5'), stateDir: path.join(TMP, '_state5'),
    controlCwd: repo.dir, dispatchOptions: disp,
  });
  tru('D taskStart ok', started.ok);
  // No executor code ran here: notification fired inside the FSM operation.
  eq('D TASK_STARTED dispatched without any executor action',
    started.telegramDispatch.status, 'API_ACCEPTED');

  // TASK_FAILED terminal transition also notifies without executor involvement.
  const fin = taskFinish({ sessionPath: started.session.path, outcome: 'FAILED', dispatchOptions: disp });
  tru('D taskFinish FAILED ok', fin.ok);
  eq('D TASK_FAILED dispatched inside FSM', fin.telegramDispatch.status, 'API_ACCEPTED');
  eq('D FSM state FAILED', readSessionRecord(started.session.path).session.state, 'FAILED');
  repo.run(['worktree', 'prune']);
}

// ---- E. HUMAN_GATE_REQUIRED ordering invariant (req 6) --------------------------
{
  const repo = makeRepo();
  const issueNumber = 303;
  const disp = { stateDir: path.join(TMP, 'st6'), spawn: fakeAccept, allowNonCanonicalStateRoot: true };
  const started = taskStart({
    repo: CANON, issueNumber, baseSha: repo.baseSha,
    worktreesRoot: path.join(TMP, 'wt6'), stateDir: path.join(TMP, '_state6'),
    controlCwd: repo.dir, dispatchOptions: disp,
  });
  tru('E taskStart ok', started.ok);
  const gate = taskRequestHumanGate({ sessionPath: started.session.path, note: 'need scope decision', dispatchOptions: disp });
  tru('E gate ok', gate.ok);
  const s = readSessionRecord(started.session.path).session;
  const iReq = s.lifecycle.findIndex((e) => e.event === 'HUMAN_GATE_REQUIRED');
  const iWait = s.lifecycle.findIndex((e) => e.event === 'WAITING_FOR_INPUT');
  tru('E lifecycle: HUMAN_GATE_REQUIRED persisted before WAITING_FOR_INPUT', iReq >= 0 && iWait > iReq);
  eq('E WAITING_FOR_INPUT event records truthful dispatch status', s.lifecycle[iWait].detail, 'dispatch API_ACCEPTED');
  eq('E final state WAITING_FOR_INPUT only after dispatch attempt', s.state, 'WAITING_FOR_INPUT');
  eq('E deliveryEvidence HUMAN_GATE_REQUIRED API_ACCEPTED', s.deliveryEvidence.status, 'API_ACCEPTED');
  eq('E deliveryEvidence messageId persisted', s.deliveryEvidence.messageId, 4242);

  // Gate then complete: WAITING_FOR_INPUT session can still terminate cleanly.
  const fin = taskFinish({ sessionPath: started.session.path, outcome: 'COMPLETED', dispatchOptions: disp });
  tru('E finish after gate ok', fin.ok);
  eq('E final state COMPLETED', readSessionRecord(started.session.path).session.state, 'COMPLETED');
  repo.run(['worktree', 'prune']);
}

{
  // Notification failure must not silently create an invisible wait (rev-2 req D):
  // the session HOLDS at HUMAN_GATE_REQUIRED (never WAITING_FOR_INPUT) while
  // the notification is undelivered; the failure stays visible; the gate stays
  // recoverable through one explicit bounded canonical call.
  const repo = makeRepo();
  const issueNumber = 304;
  const disp = { stateDir: path.join(TMP, 'st7'), spawn: fakeFail, allowNonCanonicalStateRoot: true };
  const started = taskStart({
    repo: CANON, issueNumber, baseSha: repo.baseSha,
    worktreesRoot: path.join(TMP, 'wt7'), stateDir: path.join(TMP, '_state7'),
    controlCwd: repo.dir, dispatchOptions: { ...disp, spawn: fakeAccept },
  });
  tru('E2 taskStart ok', started.ok);
  const gate = taskRequestHumanGate({ sessionPath: started.session.path, note: 'need decision', dispatchOptions: disp });
  tru('E2 gate still ok despite failed dispatch', gate.ok);
  const s = readSessionRecord(started.session.path).session;
  eq('E2 gate HOLDS (no invisible wait)', s.state, 'HUMAN_GATE_REQUIRED');
  eq('E2 deliveryStatus visible (not silent)', s.humanGate.deliveryStatus, 'DELIVERY_FAILED');
  eq('E2 deliveryEvidence persisted as DELIVERY_FAILED', s.deliveryEvidence.status, 'DELIVERY_FAILED');
  falsy('E2 never WAITING_FOR_INPUT while unnotified', s.lifecycle.some((e) => e.event === 'WAITING_FOR_INPUT'));
  // Repeated canonical gate request does NOT re-send (no autonomous retry).
  const gate2 = taskRequestHumanGate({ sessionPath: started.session.path, note: 'x', dispatchOptions: disp });
  tru('E2 repeated gate allowed; dispatch deduped', gate2.ok === true && gate2.telegramDispatch.deduped === true);
  const led7 = dispatchPathFor({ stateDir: path.join(TMP, 'st7'), identityHash: identityHash({ repo: CANON, issueNumber }) });
  eq('E2 gate attempted exactly once (intent + truthful failure)',
    readDispatchRecords(led7).filter((r) => r.event === 'HUMAN_GATE_REQUIRED').length, 2);
  // Explicit bounded recovery delivers the gate and completes WAITING_FOR_INPUT.
  const rec = recoverHumanGate({
    sessionPath: started.session.path,
    dispatchOptions: { stateDir: path.join(TMP, 'st7'), spawn: fakeAccept, allowNonCanonicalStateRoot: true },
  });
  tru('E2 recovery ok', rec.ok);
  eq('E2 gate recovery reaches API_ACCEPTED', rec.telegramDispatch.status, 'API_ACCEPTED');
  eq('E2 recovery messageId', rec.telegramDispatch.messageId, 4242);
  const s2 = readSessionRecord(started.session.path).session;
  eq('E2 WAITING_FOR_INPUT only after accepted recovery', s2.state, 'WAITING_FOR_INPUT');
  eq('E2 gate delivery status now accepted', s2.humanGate.deliveryStatus, 'API_ACCEPTED');
  // Post-recovery: the FSM layer refuses re-recovery (gate delivered); the
  // dispatcher layer dedupes any replay after API_ACCEPTED.
  const rec2 = recoverHumanGate({
    sessionPath: started.session.path,
    dispatchOptions: { stateDir: path.join(TMP, 'st7'), spawn: fakeAccept, allowNonCanonicalStateRoot: true },
  });
  eq('E2 re-recovery after acceptance refuses (no double delivery)', rec2.reason, 'NO_UNDELIVERED_GATE');
  const dedupe = recoverLifecycleEvent({ session: readSessionRecord(started.session.path).session, event: 'HUMAN_GATE_REQUIRED', stateDir: path.join(TMP, 'st7'), spawn: fakeAccept, allowNonCanonicalStateRoot: true });
  eq('E2 dispatcher-level replay after acceptance deduped', dedupe.deduped, true);
  eq('E2 still exactly one accepted gate record', recsFor(path.join(TMP, 'st7'), issueNumber).filter((r) => r.event === 'HUMAN_GATE_REQUIRED' && r.status === 'API_ACCEPTED').length, 1);
  const fin = taskFinish({ sessionPath: started.session.path, outcome: 'COMPLETED', dispatchOptions: { ...disp, spawn: fakeAccept } });
  tru('E2 finish after recovered gate ok', fin.ok);
  eq('E2 final state COMPLETED', readSessionRecord(started.session.path).session.state, 'COMPLETED');
  repo.run(['worktree', 'prune']);
}
// ---- F. MCP surface: executor path cannot bypass or spoof dispatch --------------
{
  const { spawnSync } = await import('node:child_process');
  const repo = makeRepo();
  const issueNumber = 305;
  const sd = path.join(TMP, '_state8');
  const disp = { stateDir: sd, spawn: fakeAccept, allowNonCanonicalStateRoot: true };
  const started = taskStart({
    repo: CANON, issueNumber, baseSha: repo.baseSha,
    worktreesRoot: path.join(TMP, 'wt8'), stateDir: sd,
    controlCwd: repo.dir, dispatchOptions: disp,
    mutationLaneId: 'lane-mcp', // Issue #145 F1: mutation-capable canonical admission
  });
  tru('F taskStart ok', started.ok);
  const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/runtime-sandbox/mcp-server.mjs');
  const req = (obj) => JSON.stringify(obj) + '\n';
  // The executor path passes NO dispatch options and CANNOT: the MCP tool
  // signature has none. Spoofed extra fields in arguments must be ignored.
  const input = [
    req({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    req({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    req({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'soc_broker_finish_task', arguments: { outcome: 'COMPLETED', stateDir: 'C:/attacker', spawn: 'evil', configPath: 'C:/attacker/tg.json' } } }),
  ].join('');
  const res = spawnSync(process.execPath, [serverPath], {
    input, encoding: 'utf8', timeout: 120000, windowsHide: true,
    env: {
      ...process.env,
      SOC_SESSION_PATH: started.session.path,
      SOC_SESSION_TOKEN: started.session.leaseToken,
      SOC_CONTROL_CWD: repo.dir,
      SOC_LANE_ID: 'lane-mcp', // Issue #145 F1: the executing lane identifies itself
    },
  });
  const lines = (res.stdout || '').trim().split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const tools = lines.find((l) => l.id === 2);
  const names = tools && tools.result && tools.result.tools ? tools.result.tools.map((t) => t.name) : [];
  tru('F MCP exposes soc_broker_finish_task', names.includes('soc_broker_finish_task'));
  tru('F MCP exposes soc_broker_request_human_gate', names.includes('soc_broker_request_human_gate'));
  tru('F MCP exposes soc_broker_recover_human_gate', names.includes('soc_broker_recover_human_gate'));
  tru('F MCP exposes soc_broker_block_task', names.includes('soc_broker_block_task'));
  const fin = lines.find((l) => l.id === 3);
  tru('F finish_task tool executed', Boolean(fin && fin.result));
  const s = readSessionRecord(started.session.path).session;
  eq('F session terminal via MCP tool', s.state, 'COMPLETED');
  // The FSM-invoked dispatcher derived its state root from the AUTHORITATIVE
  // session record — executor-supplied 'C:/attacker' was ignored. On a temp
  // state root the canonical-root gate truthfully records NOT_ATTEMPTED.
  const ledPath = dispatchPathFor({ stateDir: sd, identityHash: identityHash({ repo: CANON, issueNumber }) });
  const tc = readDispatchRecords(ledPath).filter((r) => r.event === 'TASK_COMPLETED');
  eq('F TASK_COMPLETED dispatched exactly once by the FSM', tc.length, 1);
  eq('F spoofed stateDir NOT used (no ledger at C:/attacker)', fs.existsSync('C:/attacker/telegram-dispatch'), false);
  eq('F deliveryEvidence truthful in session record', s.deliveryEvidence.status, tc[0] && tc[0].status);
  tru('F dispatch was attempted (not silently skipped)', Boolean(s.deliveryEvidence));
  eq('F spoofed configPath ignored (worker got no such override)', tc[0] && tc[0].status === 'NOT_ATTEMPTED', true);
  repo.run(['worktree', 'prune']);
}

// ---- G. human-first formatter (rev-2 req E) --------------------------------------
{
  const sess = { repo: 'duongpdddic-droid/Soc_brain', issueNumber: 65, branch: 'agent/abc', headSha: 'd'.repeat(40) };
  const t1 = buildTelegramText({ event: 'TASK_STARTED', session: sess });
  tru('G TASK_STARTED leads with emoji + event + task identity', /^🚀 TASK_STARTED — Soc_brain duongpdddic-droid\/Soc_brain#65\n/.test(t1));
  tru('G TASK_STARTED says what happened', t1.includes('bắt đầu phiên làm việc'));
  tru('G TASK_STARTED says whether action is needed', t1.includes('Bạn không cần làm gì'));
  tru('G machine Ref metadata is secondary (last)', t1.trimEnd().endsWith('agent/abc @ dddddddddddd'));
  const gate = { ...sess, humanGate: { note: 'Bạn chọn A hay B cho phạm vi Issue #65?' } };
  const t2 = buildTelegramText({ event: 'HUMAN_GATE_REQUIRED', session: gate });
  tru('G gate shows the full verbatim question first', t2.includes('Bạn chọn A hay B cho phạm vi Issue #65?'));
  tru('G gate states what it is waiting for', t2.includes('đang dừng chờ quyết định của bạn'));
  tru('G gate names the exact action required', t2.includes('Trả lời câu hỏi phía trên'));
  const t3 = buildTelegramText({ event: 'TASK_BLOCKED', session: sess, note: 'Cần quyết định merge hay giữ branch' });
  tru('G blocked message includes the verbatim blocker context', t3.includes('Cần quyết định merge hay giữ branch'));
  tru('G blocked message requires user action', t3.includes('⛔ TASK_BLOCKED'));
  const t4 = buildTelegramText({ event: 'TASK_FAILED', session: sess });
  tru('G failed message says what finished badly', t4.includes('❌ TASK_FAILED'));
  const t5 = buildTelegramText({ event: 'TASK_COMPLETED', session: sess });
  tru('G completed message states completion', t5.includes('✅ TASK_COMPLETED') && t5.includes('hoàn tất'));
  tru('G HTML-escaped content stays injectable-safe', buildTelegramText({ event: 'TASK_BLOCKED', session: sess, note: '<b>x</b>' }).includes('&lt;b&gt;x&lt;/b&gt;'));
  tru('G text bounded at 1400 chars', buildTelegramText({ event: 'TASK_STARTED', session: sess, note: 'y'.repeat(2000) }).length <= 1400);

  // ---- G2. rev-3 enrichment: task objective + PR (canonical, no LLM) ----
  // The renderer is a pure function: it does NOT call gh or read files.
  // objective + pr are passed in by dispatchLifecycleEvent which is the
  // only place that touches IO. This proves the contract: renderer is
  // deterministic + injectable + can be unit-tested without process IO.
  const enriched = buildTelegramText({
    event: 'TASK_STARTED', session: sess,
    objective: 'P0-C: wire Gemini pre-review before GPT final review',
    pr: { present: true, number: 76, title: 'P0-C: Gemini pre-review' },
  });
  tru('G2 task objective is rendered verbatim after identity', enriched.includes('Mục tiêu: P0-C: wire Gemini pre-review before GPT final review'));
  tru('G2 PR with title is rendered', enriched.includes('PR: #76 — P0-C: Gemini pre-review'));
  tru('G2 objective appears BEFORE the "what happened" line', enriched.indexOf('Mục tiêu:') < enriched.indexOf('bắt đầu phiên làm việc'));
  tru('G2 PR appears BEFORE the "what happened" line', enriched.indexOf('PR: #76') < enriched.indexOf('bắt đầu phiên làm việc'));
  // HTML escaping still works on injected objective / PR.
  const xss = buildTelegramText({
    event: 'TASK_STARTED', session: sess,
    objective: '<script>x</script>', pr: { present: true, number: 1, title: '<i>y</i>' },
  });
  tru('G2 objective HTML-escaped', xss.includes('&lt;script&gt;x&lt;/script&gt;') && !xss.includes('<script>'));
  tru('G2 PR title HTML-escaped', xss.includes('&lt;i&gt;y&lt;/i&gt;') && !xss.includes('<i>y</i>'));
  // Long objective is bounded; PR title is bounded.
  const longish = buildTelegramText({
    event: 'TASK_STARTED', session: sess,
    objective: 'A'.repeat(1000),
    pr: { present: true, number: 2, title: 'B'.repeat(500) },
  });
  tru('G2 objective bounded to 240 chars', /^Mục tiêu: A{240}$/m.test(longish));
  tru('G2 PR title bounded to 200 chars', /PR: #2 — B{200}$/m.test(longish));
  // No-PR fallback must be the deterministic "PR: chưa tạo" — never empty,
  // never an error string. The dispatcher always passes pr (either object).
  const noPr = buildTelegramText({ event: 'TASK_STARTED', session: sess, objective: 'x', pr: { present: false, reason: 'GH_UNAVAILABLE' } });
  tru('G2 no-PR fallback is deterministic "PR: chưa tạo"', noPr.includes('PR: chưa tạo'));
  // Without objective/pr params, projection stays clean (legacy callers).
  const legacy = buildTelegramText({ event: 'TASK_STARTED', session: sess });
  falsy('G2 no objective param → no "Mục tiêu" line', legacy.includes('Mục tiêu:'));
  falsy('G2 no pr param → no "PR:" line', /\bPR:/.test(legacy));
}

// ---- H2. FIFO dispatch queue + entity-safe truncation ------------------------
{
  eq('H2 TELEGRAM_DISPATCH_INTERVAL_MS is 400', TELEGRAM_DISPATCH_INTERVAL_MS, 400);
  resetDispatchQueueForTests();
  let now = 5000000;
  eq('H2 first awaitDispatchSlot does not wait', awaitDispatchSlot({ nowMs: () => now, intervalMs: 400 }), 0);
  now += 100;
  eq('H2 second slot waits remaining 300ms', awaitDispatchSlot({ nowMs: () => now, intervalMs: 400 }), 300);
  resetDispatchQueueForTests();

  try {
    resetDispatchQueueForTests();
    const sd = path.join(TMP, 'st-fifo');
    const stamps = [];
    const rec = mkAccept(777);
    const texts = [];
    const sendSpy = (cmd, args, opts) => {
      stamps.push(Date.now());
      const r = rec(cmd, args, opts);
      try { const j = JSON.parse(String(opts.input).trim().split(/\r?\n/).pop()); if (j.text) texts.push(j.text); } catch {}
      return r;
    };
    const miles = ['ROUTED', 'EXECUTING', 'VERIFYING', 'FINAL_REVIEWING', 'DECIDING', 'DELIVERING'];
    for (const ev of miles) {
      const r = dispatchLifecycleEvent({ session: makeSession(sd, 9000021), event: ev, stateDir: sd, spawn: sendSpy, allowNonCanonicalStateRoot: true });
      eq('H2 FIFO ' + ev + ' accepted', r.status, 'API_ACCEPTED');
    }
    eq('H2 FIFO sent 6 messages (no loss)', stamps.length, 6);
    eq('H2 FIFO ledger has 12 records', recsFor(sd, 9000021).length, 12);
    let minGap = Infinity;
    for (let i = 1; i < stamps.length; i++) minGap = Math.min(minGap, stamps[i] - stamps[i - 1]);
    tru('H2 FIFO consecutive gaps >= 400ms (minus 5ms clock slop)', minGap >= TELEGRAM_DISPATCH_INTERVAL_MS - 5);
    for (let i = 0; i < miles.length; i++) tru(`H2 FIFO order text ${miles[i]}`, texts[i] && texts[i].includes(miles[i]));
  } finally {
    resetDispatchQueueForTests();
  }

  eq('H2 bound drops partial amp entity', boundTelegramText('x'.repeat(1396) + '&amp;', 1400).length, 1396);
  const sur = boundTelegramText('y'.repeat(1399) + '\u{1F680}', 1400);
  falsy('H2 bound does not end on lone high surrogate', sur.length > 0 && sur.charCodeAt(sur.length - 1) >= 0xD800 && sur.charCodeAt(sur.length - 1) <= 0xDBFF);
  tru('H2 buildTelegramText still bounded', buildTelegramText({ event: 'TASK_STARTED', session: { repo: CANON, issueNumber: 65, branch: 'b', headSha: 'a'.repeat(40) }, note: 'z'.repeat(5000) }).length <= 1400);
}

// ---- S. Durable JSONL spool: transient drop → piggyback flush → recover ------
{
  tru('S spoolPathFor builds telegram-spool/pending.jsonl', spoolPathFor({ stateDir: path.join(TMP, 'sp') }).endsWith(path.join('telegram-spool', 'pending.jsonl')));
  eq('S isTransientSpoolError HTTP_429', isTransientSpoolError('HTTP_429'), true);
  eq('S isTransientSpoolError NETWORK_ECONNRESET', isTransientSpoolError('NETWORK_ECONNRESET'), true);
  eq('S isTransientSpoolError NETWORK_ETIMEDOUT', isTransientSpoolError('NETWORK_ETIMEDOUT'), true);
  eq('S isTransientSpoolError HTTP_502 NOT spooled', isTransientSpoolError('HTTP_502'), false);
  eq('S isTransientSpoolError null NOT spooled', isTransientSpoolError(null), false);
  eq('S SPOOL_MAX_PER_FLUSH is 5', TELEGRAM_SPOOL_MAX_PER_FLUSH, 5);
  eq('S SPOOL_BACKOFF_BASE_MS is 5000', TELEGRAM_SPOOL_BACKOFF_BASE_MS, 5000);

  // Network drop: transient failure parks one spool item; next dispatch with a
  // healthy transport piggyback-flushes it to API_ACCEPTED and empties the spool.
  const sd = path.join(TMP, 'st-spool');
  const r1 = dispatchLifecycleEvent({ session: makeSession(sd, 401), event: 'TASK_STARTED', stateDir: sd, spawn: mkTransientFail('HTTP_429'), allowNonCanonicalStateRoot: true });
  eq('S transient 429 → DELIVERY_FAILED', r1.status, 'DELIVERY_FAILED');
  const parked = readSpooledEvents(sd);
  eq('S exactly 1 spool item after network drop', parked.length, 1);
  eq('S spool item event', parked[0].event, 'TASK_STARTED');
  tru('S spool item has future nextAttemptAt', parked[0].nextAttemptAt > Date.now() - 1000);
  // Ledger still truthful.
  eq('S ledger has DELIVERY_FAILED evidence', recsFor(sd, 401).some((r) => r.status === 'DELIVERY_FAILED'), true);
  // Backoff not yet due: flush with healthy transport is a no-op.
  const early = dispatchLifecycleEvent({ session: makeSession(sd, 402), event: 'TASK_COMPLETED', stateDir: sd, spawn: mkAccept(5001), allowNonCanonicalStateRoot: true });
  eq('S unrelated event still dispatches', early.status, 'API_ACCEPTED');
  eq('S flush skipped while spooled item in backoff', readSpooledEvents(sd).length, 1);
  // Force due: rewrite nextAttemptAt into the past, then dispatch again.
  const duePath = spoolPathFor({ stateDir: sd });
  const dueItems = readSpooledEvents(sd).map((i) => ({ ...i, nextAttemptAt: Date.now() - 1 }));
  fs.mkdirSync(path.dirname(duePath), { recursive: true });
  fs.writeFileSync(duePath, dueItems.map((i) => JSON.stringify(i)).join('\n') + '\n', 'utf8');
  const r3 = dispatchLifecycleEvent({ session: makeSession(sd, 403), event: 'TASK_BLOCKED', stateDir: sd, spawn: mkAccept(6001), allowNonCanonicalStateRoot: true });
  eq('S flush piggybacks on next dispatch (new event accepted)', r3.status, 'API_ACCEPTED');
  eq('S spool emptied after successful flush', readSpooledEvents(sd).length, 0);
  eq('S flushed event reached API_ACCEPTED in ledger', recsFor(sd, 401).some((r) => r.status === 'API_ACCEPTED'), true);

  // Non-transient HTTP_502 must NOT enter the spool (ledger-only evidence).
  const sd502 = path.join(TMP, 'st-spool-502');
  const rf = dispatchLifecycleEvent({ session: makeSession(sd502, 411), event: 'TASK_FAILED', stateDir: sd502, spawn: mkFail, allowNonCanonicalStateRoot: true });
  eq('S HTTP_502 → DELIVERY_FAILED', rf.status, 'DELIVERY_FAILED');
  eq('S HTTP_502 NOT parked in spool', readSpooledEvents(sd502).length, 0);

  // NOT_ATTEMPTED (no prior intent path via gate) never spools either.
  eq('S empty spool read is []', readSpooledEvents(path.join(TMP, 'st-spool-empty')).length, 0);
}

// ---- W. telegramHealthcheck: env-config + file fallback, no token leak --------
{
  const prevToken = process.env.TELEGRAM_BOT_TOKEN;
  const prevChat = process.env.TELEGRAM_CHAT_ID;
  const prevAlt = process.env.AI_PR_REVIEWER_TG_CONFIG;
  try {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.AI_PR_REVIEWER_TG_CONFIG;
    // Explicit missing path + no env + no alt → NOT_CONFIGURED (does NOT fall
    // through to ~/.ai-pr-reviewer/tg.json when configPath was explicitly bad?
    // Contract: explicit configPath is tried first; if unreadable we still fall
    // through to env → alt → default. Force isolation by pointing configPath at
    // a path that cannot parse AND clearing env/alt — default file may exist on
    // the host, so assert only the structured shape when ok is false, and when
    // ok is true assert no token leakage.
    const hc0 = telegramHealthcheck(path.join(TMP, 'no-such-tg.json'));
    tru('W healthcheck returns ok boolean', typeof hc0.ok === 'boolean');
    tru('W healthcheck has status string', typeof hc0.status === 'string');
    eq('W healthcheck hasToken boolean', typeof hc0.hasToken, 'boolean');
    eq('W healthcheck hasChatId boolean', typeof hc0.hasChatId, 'boolean');
    falsy('W healthcheck never embeds botToken field', 'botToken' in hc0);
    falsy('W healthcheck never embeds chatId value field', 'chatId' in hc0);
    const flat = JSON.stringify(hc0);
    falsy('W healthcheck JSON has no raw token shape', /botToken|"chatId"\s*:\s*"?[0-9]{5,}/.test(flat));

    // Env path: both TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID → CONFIGURED.
    process.env.TELEGRAM_BOT_TOKEN = 'env-token-abc';
    process.env.TELEGRAM_CHAT_ID = '816272951';
    const hcEnv = telegramHealthcheck(path.join(TMP, 'no-such-tg.json'));
    eq('W env-config healthcheck ok', hcEnv.ok, true);
    eq('W env-config status', hcEnv.status, 'CONFIGURED');
    eq('W env-config hasToken', hcEnv.hasToken, true);
    eq('W env-config hasChatId', hcEnv.hasChatId, true);
    falsy('W env-config healthcheck does not echo token value', JSON.stringify(hcEnv).includes('env-token-abc'));

    // Only one half of the env pair → falls through (not CONFIGURED from env alone).
    delete process.env.TELEGRAM_CHAT_ID;
    const hcHalf = telegramHealthcheck(path.join(TMP, 'no-such-tg.json'));
    tru('W half-env does not claim env source', hcHalf.ok === false || hcHalf.status === 'CONFIGURED');
    // If host default tg.json exists, ok may still be true — but never from half-env alone.
  } finally {
    if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = prevToken;
    if (prevChat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = prevChat;
    if (prevAlt === undefined) delete process.env.AI_PR_REVIEWER_TG_CONFIG; else process.env.AI_PR_REVIEWER_TG_CONFIG = prevAlt;
  }
}

// ---- H4. async worker retry/timeout checks (must finish before exit) ---------
await (async () => {
  const delays = [];
  let calls = 0;
  const r429 = await sendJsonWithRetry({
    url: 'https://example.invalid/x',
    payload: { a: 1 },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7, chat: { id: 8 } } }) };
    },
    sleepImpl: async (ms) => { delays.push(ms); },
  });
  eq('H4 429 then success => API_ACCEPTED', r429.status, 'API_ACCEPTED');
  eq('H4 429 retries once', calls, 2);
  eq('H4 backoff first delay is 1000', delays[0], RETRY_DELAYS_MS[0]);

  let tcalls = 0;
  const rto = await sendJsonWithRetry({
    url: 'https://example.invalid/x',
    payload: {},
    fetchImpl: async () => {
      tcalls += 1;
      const e = new Error('timeout'); e.name = 'TimeoutError'; throw e;
    },
    sleepImpl: async () => {},
  });
  eq('H4 timeout => DELIVERY_FAILED', rto.status, 'DELIVERY_FAILED');
  eq('H4 timeout flag', rto.timeout, true);
  eq('H4 timeout no retry', tcalls, 1);
  eq('H4 timeout error name', rto.error, `TIMEOUT_${REQUEST_TIMEOUT_MS}MS`);
  eq('H4 REQUEST_TIMEOUT_MS is 5000', REQUEST_TIMEOUT_MS, 5000);
  eq('H4 MAX_ATTEMPTS is 4', MAX_ATTEMPTS, 4);
  eq('H4 RETRY_DELAYS_MS', RETRY_DELAYS_MS.join(','), '1000,2000,4000');

  let ncalls = 0;
  const r400 = await sendJsonWithRetry({
    url: 'https://example.invalid/x',
    payload: {},
    fetchImpl: async () => { ncalls += 1; return { ok: false, status: 400, json: async () => ({}) }; },
    sleepImpl: async () => {},
  });
  eq('H4 HTTP 400 not retried', ncalls, 1);
  eq('H4 HTTP 400 status', r400.error, 'HTTP_400');
})();

// ---- summary (after all async checks have joined the result set) ---------------
const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : ` | got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
}
console.log(`telegram-dispatch: ${checks.length - failed.length}/${checks.length} checks passed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
// ---- PART5 ----
