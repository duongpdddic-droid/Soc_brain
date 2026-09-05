#!/usr/bin/env node
// telegram-dispatch.test.mjs — Issue #65 deterministic tests (no framework).
// Proves the canonical FSM → Telegram dispatch invariant:
//   A. exactly-once per transition; duplicate/replay cannot re-send
//   B. unrelated transition does not notify
//   C. API_ACCEPTED persists messageId; transport failure persists
//      DELIVERY_FAILED without corrupting the FSM
//   D. executor omission cannot suppress notification (dispatch inside FSM)
//   E. HUMAN_GATE ordering: persisted checkpoint → dispatch → WAITING_FOR_INPUT
// Exit 0 = PASS, 1 = FAIL. Disposable temp dirs only; the Telegram transport
// is fully mocked (spawn is injectable), so no network is touched here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  dispatchLifecycleEvent, dispatchPathFor, readDispatchRecords,
  buildTelegramText, NOTIFIABLE_EVENTS, DELIVERY_STATUSES,
} from '../packages/telegram-dispatch/telegram-dispatch.mjs';
import {
  taskStart, taskFinish, taskBlock, taskRequestHumanGate, readSessionRecord,
} from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

const CANON = 'duongpdddic-droid/Soc_brain';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-tg-'));

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
eq('NOTIFIABLE_EVENTS is the required minimum set',
  NOTIFIABLE_EVENTS.join(','),
  'TASK_STARTED,TASK_COMPLETED,TASK_BLOCKED,TASK_FAILED,HUMAN_GATE_REQUIRED');
eq('DELIVERY_STATUSES are exactly the truthful levels',
  DELIVERY_STATUSES.join(','),
  'NOT_ATTEMPTED,API_ACCEPTED,DELIVERY_FAILED');
falsy('no USER_RECEIVED level exists', DELIVERY_STATUSES.includes('USER_RECEIVED'));

// ---- A1. API_ACCEPTED persists messageId, exactly-once -------------------------
{
  const sd = path.join(TMP, 'st1');
  const p = dispatchPathFor({ stateDir: sd, identityHash: identityHash({ repo: CANON, issueNumber: 1 }) });
  const fakeAccept = () => ({ error: 0, stdout: JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 4242, chatId: 816272951 }) + '\n', stderr: '' });
  const r1 = dispatchLifecycleEvent({ session: makeSession(sd, 1), event: 'TASK_COMPLETED', stateDir: sd, spawn: fakeAccept, allowNonCanonicalStateRoot: true });
  eq('A1 first send API_ACCEPTED', r1.status, 'API_ACCEPTED');
  eq('A1 messageId returned', r1.messageId, 4242);
  const recs = readDispatchRecords(p);
  eq('A1 record persisted to JSONL', recs.length, 1);
  eq('A1 record messageId', recs[0].messageId, 4242);
  eq('A1 record status', recs[0].status, 'API_ACCEPTED');
  const r2 = dispatchLifecycleEvent({ session: makeSession(sd, 1), event: 'TASK_COMPLETED', stateDir: sd, spawn: fakeAccept, allowNonCanonicalStateRoot: true });
  eq('A1 duplicate/replay dedupes (no second send)', r2.deduped, true);
  eq('A1 dedupe returns recorded messageId', r2.messageId, 4242);
  eq('A1 ledger still has exactly one record', readDispatchRecords(p).length, 1);
}

// ---- A2. transport failure persists DELIVERY_FAILED, exactly-once --------------
{
  const sd = path.join(TMP, 'st2');
  const p = dispatchPathFor({ stateDir: sd, identityHash: identityHash({ repo: CANON, issueNumber: 2 }) });
  const fakeFail = () => ({ error: 0, stdout: JSON.stringify({ ok: false, status: 'DELIVERY_FAILED', error: 'HTTP_502' }) + '\n', stderr: '' });
  const r1 = dispatchLifecycleEvent({ session: makeSession(sd, 2), event: 'TASK_FAILED', stateDir: sd, spawn: fakeFail, allowNonCanonicalStateRoot: true });
  eq('A2 transport failure -> DELIVERY_FAILED', r1.status, 'DELIVERY_FAILED');
  falsy('A2 no messageId on failure', r1.messageId);
  const recs = readDispatchRecords(p);
  eq('A2 failure persisted once', recs.length, 1);
  eq('A2 record status', recs[0].status, 'DELIVERY_FAILED');
  const r2 = dispatchLifecycleEvent({ session: makeSession(sd, 2), event: 'TASK_FAILED', stateDir: sd, spawn: fakeFail, allowNonCanonicalStateRoot: true });
  eq('A2 replay after failure does not re-send', r2.deduped, true);
  eq('A2 ledger still exactly one record', readDispatchRecords(p).length, 1);
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
  eq('C ledger has exactly one TASK_STARTED record',
    readDispatchRecords(ledPath).filter((r) => r.event === 'TASK_STARTED').length, 1);

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
  eq('C ledger TASK_COMPLETED still exactly one record',
    readDispatchRecords(ledPath).filter((r) => r.event === 'TASK_COMPLETED').length, 1);

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
  const r1 = dispatchLifecycleEvent({
    session: makeSession(sd, 4), event: 'TASK_BLOCKED', stateDir: sd,
    configPath: path.join(TMP, 'no-such-tg.json'), allowNonCanonicalStateRoot: true,
  });
  eq('C2 missing config -> NOT_ATTEMPTED (real worker, no network)', r1.status, 'NOT_ATTEMPTED');
  const recs = readDispatchRecords(p);
  eq('C2 exactly one NOT_ATTEMPTED record', recs.length, 1);
  eq('C2 record status', recs[0].status, 'NOT_ATTEMPTED');
  const r2 = dispatchLifecycleEvent({
    session: makeSession(sd, 4), event: 'TASK_BLOCKED', stateDir: sd,
    configPath: path.join(TMP, 'no-such-tg.json'), allowNonCanonicalStateRoot: true,
  });
  falsy('C2 repeat does not append another record', readDispatchRecords(p).length > 1);
  eq('C2 repeat returns NOT_ATTEMPTED', r2.status, 'NOT_ATTEMPTED');
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
  // Notification failure must not silently create an invisible wait (req 6):
  // the gate stays canonical, the failure stays visible, state stays truthful.
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
  eq('E2 state WAITING_FOR_INPUT with failed delivery', s.state, 'WAITING_FOR_INPUT');
  eq('E2 deliveryStatus visible (not silent)', s.humanGate.deliveryStatus, 'DELIVERY_FAILED');
  eq('E2 deliveryEvidence persisted as DELIVERY_FAILED', s.deliveryEvidence.status, 'DELIVERY_FAILED');
  const gate2 = taskRequestHumanGate({ sessionPath: started.session.path, note: 'x', dispatchOptions: disp });
  tru('E2 repeated gate allowed; dispatch deduped', gate2.ok === true && gate2.telegramDispatch.deduped === true);
  const led7 = dispatchPathFor({ stateDir: path.join(TMP, 'st7'), identityHash: identityHash({ repo: CANON, issueNumber }) });
  eq('E2 HUMAN_GATE_REQUIRED dispatched exactly once',
    readDispatchRecords(led7).filter((r) => r.event === 'HUMAN_GATE_REQUIRED').length, 1);
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
    },
  });
  const lines = (res.stdout || '').trim().split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const tools = lines.find((l) => l.id === 2);
  const names = tools && tools.result && tools.result.tools ? tools.result.tools.map((t) => t.name) : [];
  tru('F MCP exposes soc_broker_finish_task', names.includes('soc_broker_finish_task'));
  tru('F MCP exposes soc_broker_request_human_gate', names.includes('soc_broker_request_human_gate'));
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

// ---- summary --------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : ` | got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
}
console.log(`telegram-dispatch: ${checks.length - failed.length}/${checks.length} checks passed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
// ---- PART5 ----
