#!/usr/bin/env node
// executor-launcher.test.mjs — tests for packages/executor-launcher (Issue #53).
// No framework. Exit 0 = PASS, 1 = FAIL. Disposable temp dirs only.
// Boundary tests included: the launcher MUST stay a thin process adapter —
// no agent-loop FSM kinds may ever be derived from executor output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { identityHash } from '../packages/workspace/workspace.mjs';
import {
  EXECUTION_SCHEMA_VERSION, EXECUTOR_ID,
  resolveOpenCodeExecutable, buildLaunchArgv, classifyEvent,
  effectiveStatus, readExecutionRecord, readActivityTail,
  startExecution, stopExecution, readExecutionStatus, buildChildEnv,
  preflightCodingCapabilities, readWin32ProcessStartTime,
  ACTIVITY_TAIL_MAX_LINES,
} from '../packages/executor-launcher/executor-launcher.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-launcher-'));

// ---- resolveOpenCodeExecutable ------------------------------------------------
{
  const exeDir = path.join(TMP, 'exe');
  mkdirSync(exeDir, { recursive: true });
  const exe = path.join(exeDir, 'opencode.exe');
  writeFileSync(exe, 'binary-ish');
  const r1 = resolveOpenCodeExecutable({ env: { SOC_OPENCODE_BIN: exe }, exists: (p) => p === exe });
  tru('resolve: env override found', r1.ok && r1.executable === exe);
  const r2 = resolveOpenCodeExecutable({ env: {}, exists: () => false });
  falsy('resolve: none => fail-closed', r2.ok);
  eq('resolve: reason', r2.reason, 'EXECUTOR_UNAVAILABLE');
  const appData = path.join(TMP, 'appdata');
  mkdirSync(path.join(appData, 'npm', 'node_modules', 'opencode-ai', 'bin'), { recursive: true });
  const exe2 = path.join(appData, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  writeFileSync(exe2, 'x');
  const r3 = resolveOpenCodeExecutable({ env: { APPDATA: appData }, exists: (p) => p === exe2 });
  tru('resolve: APPDATA npm-global candidate', r3.ok && r3.executable === exe2);
  eq('resolve: npm-global source', r3.source, 'npm-global');
  // PATH-order scan (user-facing parity, no shell): first real .exe in PATH order wins
  const p1 = path.join(TMP, 'p1');
  const p2 = path.join(TMP, 'p2');
  mkdirSync(p1, { recursive: true });
  mkdirSync(path.join(p2, 'node_modules', 'opencode-ai', 'bin'), { recursive: true });
  const pathExe = path.join(p1, 'opencode.exe');
  const nmExe = path.join(p2, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  const p2Shim = path.join(p2, 'opencode.cmd'); // npm shim: maps the dir to its package exe
  writeFileSync(pathExe, 'x');
  writeFileSync(nmExe, 'x');
  writeFileSync(p2Shim, 'shim');
  const seen = (p) => p === pathExe || p === nmExe || p === exe2 || p === p2Shim;
  const r4 = resolveOpenCodeExecutable({ env: { PATH: `${p1};${p2}`, APPDATA: appData }, exists: seen });
  tru('resolve: PATH dir exe wins in PATH order', r4.ok && r4.executable === pathExe);
  eq('resolve: PATH source', r4.source, 'path');
  const r5 = resolveOpenCodeExecutable({ env: { PATH: `${p2};${p1}`, APPDATA: appData }, exists: seen });
  tru('resolve: PATH shim -> node_modules layout found', r5.ok && r5.executable === nmExe);
  const r9 = resolveOpenCodeExecutable({ env: { PATH: `${p2};${p1}`, APPDATA: appData }, exists: (p) => p === pathExe || p === nmExe || p === exe2 });
  tru('resolve: stale node_modules without shim skipped (user-facing parity)', r9.ok && r9.executable === pathExe);
  const r6 = resolveOpenCodeExecutable({ env: { PATH: `"${p1}";` }, exists: (p) => p === pathExe });
  tru('resolve: quoted PATH entry tolerated', r6.ok && r6.executable === pathExe);
  const r7 = resolveOpenCodeExecutable({ env: { PATH: '', APPDATA: appData }, exists: (p) => p === exe2 });
  tru('resolve: empty PATH falls back to APPDATA', r7.ok && r7.executable === exe2);
  // directory named opencode.exe must be rejected (isFile gate, no real FS scan)
  const dirLikeExe = path.join(TMP, 'dirlike', 'opencode.exe');
  mkdirSync(dirLikeExe, { recursive: true });
  const r8 = resolveOpenCodeExecutable({ env: { PATH: path.join(TMP, 'dirlike') }, exists: (p) => p === dirLikeExe });
  falsy('resolve: dir named opencode.exe rejected', r8.ok);
}

// ---- buildLaunchArgv (fixed supported interface; instruction is DATA) ---------
{
  const a = buildLaunchArgv({ instruction: 'do a thing', model: 'opencode/big-pickle' });
  tru('argv: ok', a.ok);
  eq('argv: fixed head', JSON.stringify(a.argv.slice(0, 8)), JSON.stringify(['run', '--format', 'json', '--agent', 'build', '--print-logs', '--log-level', 'INFO']));
  eq('argv: model pair', JSON.stringify(a.argv.slice(8, 10)), JSON.stringify(['--model', 'opencode/big-pickle']));
  eq('argv: instruction is LAST single element', a.argv[10], 'do a thing');
  const b = buildLaunchArgv({ instruction: 'no model run' });
  eq('argv: no model => 9 elements', b.argv.length, 9);
  falsy('argv: empty instruction rejected', buildLaunchArgv({ instruction: '   ' }).ok);
  falsy('argv: oversized instruction rejected', buildLaunchArgv({ instruction: 'x'.repeat(8193) }).ok);
  falsy('argv: bad model charset rejected', buildLaunchArgv({ instruction: 'x', model: 'bad model;rm' }).ok);
}

// ---- classifyEvent (OBSERVABILITY PASSTHROUGH; no FSM kinds) ------------------
{
  const t = classifyEvent(JSON.stringify({ type: 'text', sessionID: 'ses1', part: { type: 'text', text: 'hello' } }));
  eq('classify: text kind', t.kind, 'text');
  eq('classify: text passthrough verbatim', t.text, 'hello');
  eq('classify: event carried verbatim', t.event.sessionID, 'ses1');
  const ss = classifyEvent(JSON.stringify({ type: 'step_start', sessionID: 'ses1', part: {} }));
  eq('classify: step_start', ss.kind, 'step_start');
  const sf = classifyEvent(JSON.stringify({ type: 'step_finish', sessionID: 'ses1', part: {} }));
  eq('classify: step_finish', sf.kind, 'step_finish');
  const tl = classifyEvent(JSON.stringify({ type: 'tool', sessionID: 'ses1', part: { type: 'tool', tool: 'read' } }));
  eq('classify: tool kind', tl.kind, 'tool');
  eq('classify: tool name', tl.tool, 'read');
  const other = classifyEvent(JSON.stringify({ type: 'something_else', x: 1 }));
  eq('classify: unknown JSON envelope => event passthrough', other.kind, 'event');
  const raw = classifyEvent('not json at all');
  eq('classify: non-JSON => output passthrough', raw.kind, 'output');
  eq('classify: output verbatim', raw.line, 'not json at all');
  eq('classify: empty line => null', classifyEvent('   '), null);
  // BOUNDARY: presentation kinds only — no agent-loop state ever derived.
  const kinds = new Set([t.kind, ss.kind, sf.kind, tl.kind, other.kind, raw.kind].map(String));
  const allowed = new Set(['text', 'tool', 'step_start', 'step_finish', 'event', 'output']);
  tru('classify: BOUNDARY — kinds within presentation set', [...kinds].every((k) => allowed.has(k)));
}

// ---- effectiveStatus + buildChildEnv --------------------------------------------
{
  eq('status: null record', effectiveStatus(null, () => true), null);
  eq('status: terminal passthrough EXITED', effectiveStatus({ terminalStatus: 'EXITED' }, () => false), 'EXITED');
  eq('status: terminal passthrough FAILED', effectiveStatus({ terminalStatus: 'FAILED' }, () => true), 'FAILED');
  eq('status: terminal passthrough STOPPED', effectiveStatus({ terminalStatus: 'STOPPED' }, () => true), 'STOPPED');
  eq('status: pid null => STARTING', effectiveStatus({ terminalStatus: null, pid: null }, () => false), 'STARTING');
  eq('status: alive => RUNNING', effectiveStatus({ terminalStatus: null, pid: 1 }, () => true), 'RUNNING');
  // Issue #93 poll race: dead pid + not finalized = finalization in flight => RUNNING
  eq('status: dead + not finalized => RUNNING (race fix)', effectiveStatus({ terminalStatus: null, pid: 1 }, () => false), 'RUNNING');
  eq('status: dead + legacy record (no finalized) => RUNNING', effectiveStatus({ terminalStatus: null, pid: 1 }, () => false), 'RUNNING');
  eq('status: dead + finalized => INTERRUPTED', effectiveStatus({ terminalStatus: null, pid: 1, finalized: true }, () => false), 'INTERRUPTED');
  const e = buildChildEnv({ PATH: 'p', SECRET_TOKEN: 'nope', APPDATA: 'a', NINE_ROUTER_API_KEY: 'k8s' });
  eq('env: PATH kept', e.PATH, 'p');
  eq('env: APPDATA kept', e.APPDATA, 'a');
  eq('env: provider key kept', e.NINE_ROUTER_API_KEY, 'k8s');
  falsy('env: SECRET_TOKEN dropped', 'SECRET_TOKEN' in e);
}

// ---- fake child harness -----------------------------------------------------------
function fakeChild(pid = 4242) {
  const c = new EventEmitter();
  c.pid = pid;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = () => { c.emit('exit', null, 'SIGTERM'); return true; };
  return c;
}
const okVerify = () => ({ ok: true, session: { state: 'SESSION_ACTIVE' } });
const denyVerify = () => ({ ok: false, reason: 'LEASE_EXPIRED' });
// Preflight stub: real preflight spawns the real binary + reads a real worktree
// projection — never acceptable in unit tests. Dedicated preflight tests below
// exercise the real logic with injected spawnSync + fixture configs.
const preflightOk = () => ({
  ok: true, version: '0.0.0-test', agent: 'build',
  toolCaps: { bash: 'allow', edit: 'allow', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow' },
});
const IDH = identityHash({ repo: 'o/r', issueNumber: 1 }); // canonical identity for all read-backs
const binding = (stateDir) => ({
  identityHash: IDH, taskId: 'o/r#1', repo: 'o/r', issueNumber: 1,
  baseSha: 'a'.repeat(40), branch: 'soc/task-h', path: stateDir,
});
// Canonical session record at its identity-addressed location — the mandatory
// execution-identity assert re-reads THIS file (never the caller's copy).
const sessionPath = (stateDir) => {
  const p = path.join(stateDir, 'sessions', `${IDH}.json`);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({
    schemaVersion: '1', state: 'SESSION_ACTIVE', lifecycle: [],
    taskId: 'o/r#1', repo: 'o/r', issueNumber: 1,
    baseSha: 'a'.repeat(40), branch: 'soc/task-h', worktreePath: stateDir,
    identityHash: IDH, lease: { token: 'tok-123' },
  }, null, 2), 'utf8');
  return p;
};
const session = { leaseToken: 'tok-123' };
const goodExeEnv = () => ({ SOC_OPENCODE_BIN: path.join(TMP, 'exe', 'opencode.exe') });
const foundExe = ({ env }) => ({ ok: true, executable: env.SOC_OPENCODE_BIN, source: 'env:SOC_OPENCODE_BIN' });
const noExe = () => ({ ok: false, reason: 'EXECUTOR_UNAVAILABLE', candidates: [] });

// ---- startExecution: authority + validation failures ------------------------------
{
  const S = path.join(TMP, 's1'); mkdirSync(S, { recursive: true });
  const r1 = startExecution({ session: null, binding: binding(S), instruction: 'x', stateDir: S, env: goodExeEnv(), resolveExecutable: foundExe, verifyAuthority: okVerify, preflight: preflightOk });
  eq('start: no session => rejected', r1.reason, 'SESSION_AUTHORITY_REJECTED');
  const r2 = startExecution({ session, sessionPath: sessionPath(S), binding: binding(S), instruction: 'x', stateDir: S, env: goodExeEnv(), resolveExecutable: foundExe, verifyAuthority: denyVerify });
  eq('start: authority denied => rejected', r2.reason, 'SESSION_AUTHORITY_REJECTED');
  const r3 = startExecution({ session, sessionPath: sessionPath(S), binding: binding(S), instruction: '', stateDir: S, env: goodExeEnv(), resolveExecutable: foundExe, verifyAuthority: okVerify, preflight: preflightOk });
  eq('start: empty instruction => rejected', r3.reason, 'INSTRUCTION_INVALID');
  // No real spawn ever: resolver injected fail-closed (guards against touching
  // the real global opencode install from unit tests).
  const r4 = startExecution({ session, sessionPath: sessionPath(S), binding: binding(S), instruction: 'x', stateDir: S, env: {}, resolveExecutable: noExe, verifyAuthority: okVerify, preflight: preflightOk });
  eq('start: no executable => fail-closed', r4.reason, 'EXECUTOR_UNAVAILABLE');
  // Issue #132 rework step 2: mandatory execution-identity assert.
  const r5 = startExecution({ session, binding: binding(S), instruction: 'x', stateDir: S, env: goodExeEnv(), resolveExecutable: foundExe, verifyAuthority: okVerify, preflight: preflightOk });
  eq('start: missing sessionPath => rejected', r5.reason, 'SESSION_AUTHORITY_REJECTED');
  const Sb = path.join(TMP, 's1b'); mkdirSync(Sb, { recursive: true });
  const r6 = startExecution({ session, sessionPath: sessionPath(Sb), binding: binding(S), instruction: 'x', stateDir: Sb, env: goodExeEnv(), resolveExecutable: foundExe, verifyAuthority: okVerify, preflight: preflightOk });
  eq('start: session/binding identity mismatch => fail-closed', r6.reason, 'EXECUTION_IDENTITY_MISMATCH');
  eq('start: mismatch spawned nothing', readExecutionRecord({ stateDir: Sb, repo: 'o/r', issueNumber: 1 }).reason, 'EXECUTION_NOT_FOUND');
  eq('start: failures wrote no record', readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 1 }).reason, 'EXECUTION_NOT_FOUND');
}

// ---- startExecution: happy path (fake spawn), passthrough, terminal EXITED -------
{
  const S = path.join(TMP, 's2'); mkdirSync(S, { recursive: true });
  let spawnedArgs = null;
  const spawn = (exe, argv, opts) => {
    spawnedArgs = { exe, argv, opts };
    const c = fakeChild(555);
    queueMicrotask(() => {
      c.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'step_start', sessionID: 'ses9' }) + '\n', 'utf8'));
      c.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'text', sessionID: 'ses9', part: { type: 'text', text: 'working on it' } }) + '\n', 'utf8'));
      c.stderr.emit('data', Buffer.from('INFO log line\n', 'utf8'));
      c.stdout.emit('data', Buffer.from('garbage line\n', 'utf8'));
      c.emit('exit', 0, null);
    });
    return c;
  };
  const telemetryEvents = [];
  const telemetry = { record: (ev, d) => { telemetryEvents.push({ ev, d }); } };
  let i = 1000;
  const clock = () => (i += 10);
  const r = startExecution({
    session, sessionPath: sessionPath(S), binding: binding(S), instruction: 'create marker file', model: 'opencode/big-pickle',
    stateDir: S, env: goodExeEnv(), spawn, clock, isAlive: () => true, resolveExecutable: foundExe, verifyAuthority: okVerify, preflight: preflightOk, telemetry,
  });
  tru('launch: ok', r.ok);
  eq('launch: pid from spawn', r.pid, 555);
  await new Promise((res) => setImmediate(res)); // let passthrough + exit handlers drain
  tru('launch: cwd is the verified binding path', spawnedArgs.opts.cwd === path.resolve(S));
  falsy('launch: NO shell', spawnedArgs.opts.shell === true);
  eq('launch: argv head is fixed supported interface', JSON.stringify(spawnedArgs.argv.slice(0, 8)), JSON.stringify(['run', '--format', 'json', '--agent', 'build', '--print-logs', '--log-level', 'INFO']));
  tru('launch: env has no secrets surface', !('SOC_SESSION_TOKEN' in spawnedArgs.opts.env));

  const rec = readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 1 });
  tru('record: written at canonical location', rec.ok);
  eq('record: schema', rec.record.schemaVersion, EXECUTION_SCHEMA_VERSION);
  eq('record: executor', rec.record.executor, EXECUTOR_ID);
  eq('record: pid', rec.record.pid, 555);
  eq('record: terminal EXITED after exit 0', rec.record.terminalStatus, 'EXITED');
  eq('record: finalized true on terminal write', rec.record.finalized, true);
  eq('record: exitCode', rec.record.exitCode, 0);
  eq('record: sessionId captured (supported fact)', rec.record.sessionId, 'ses9');
  eq('record: instruction content NOT stored', rec.record.instruction, undefined);
  eq('record: instruction digest present', typeof rec.record.instructionDigest, 'string');
  eq('record: executorVersion persisted from preflight', rec.record.executorVersion, '0.0.0-test');
  eq('record: agent persisted (build)', rec.record.agent, 'build');
  eq('record: toolCaps persisted', JSON.stringify(rec.record.toolCaps), JSON.stringify({ bash: 'allow', edit: 'allow', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow' }));
  eq('record: executable == spawned exe', rec.record.executable, spawnedArgs.exe);
  const stx = readExecutionStatus({ stateDir: S, repo: 'o/r', issueNumber: 1 });
  tru('status: ok', stx.ok);
  eq('projection: executable == spawned exe', stx.execution.executable, spawnedArgs.exe);
  eq('projection: executorVersion == record', stx.execution.executorVersion, '0.0.0-test');

  const tail = readActivityTail({ stateDir: S, repo: 'o/r', issueNumber: 1 });
  tru('tail: ok', tail.ok);
  eq('tail: 4 captured lines', tail.items.length, 4);
  eq('tail: seq continuity', tail.items[3].seq, 4);
  eq('tail: text passthrough verbatim', tail.items[1].text, 'working on it');
  eq('tail: stderr stream tagged', tail.items[2].stream, 'stderr');
  eq('tail: garbage preserved verbatim', tail.items[3].line, 'garbage line');

  eq('telemetry: EXECUTOR_STARTED first', telemetryEvents[0].ev, 'EXECUTOR_STARTED');
  tru('telemetry: EXECUTOR_FINISHED ok', telemetryEvents[1].ev === 'EXECUTOR_FINISHED' && telemetryEvents[1].d.ok === true);

  const st = readExecutionStatus({ stateDir: S, repo: 'o/r', issueNumber: 1, isAlive: () => true });
  eq('status: EXITED', st.execution.status, 'EXITED');
  // clock ticks: startedAt=1010, 4 event appends (1020..1050), exit=1060 => 50ms
  eq('status: elapsedMs computed', st.execution.elapsedMs, 50);
}

// ---- FAILED exit / double-launch / relaunch / spawn error -------------------------
{
  const S = path.join(TMP, 's3'); mkdirSync(S, { recursive: true });
  let c1;
  const spawn1 = () => { c1 = fakeChild(777); return c1; };
  startExecution({ session, sessionPath: sessionPath(S), binding: binding(S), instruction: 'x', stateDir: S, env: goodExeEnv(), spawn: spawn1, isAlive: () => true, resolveExecutable: foundExe, verifyAuthority: okVerify, preflight: preflightOk });
  const again = startExecution({ session, sessionPath: sessionPath(S), binding: binding(S), instruction: 'x', stateDir: S, env: goodExeEnv(), spawn: spawn1, isAlive: () => true, resolveExecutable: foundExe, verifyAuthority: okVerify, preflight: preflightOk });
  eq('launch: double-launch refused', again.reason, 'EXECUTION_ALREADY_RUNNING');
  c1.emit('exit', 7, null);
  eq('launch: nonzero exit => FAILED', readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 1 }).record.terminalStatus, 'FAILED');

  const relaunch = startExecution({
    session, sessionPath: sessionPath(S), binding: binding(S), instruction: 'x again', stateDir: S, env: goodExeEnv(),
    spawn: () => { const c = fakeChild(778); queueMicrotask(() => c.emit('exit', 0, null)); return c; },
    isAlive: () => true, resolveExecutable: foundExe, verifyAuthority: okVerify, preflight: preflightOk,
  });
  tru('launch: relaunch after terminal allowed', relaunch.ok);
  await new Promise((res) => setImmediate(res));
  eq('launch: relaunch record EXITED', readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 1 }).record.terminalStatus, 'EXITED');
}
{
  const S = path.join(TMP, 's4'); mkdirSync(S, { recursive: true });
  const c = fakeChild(null); c.pid = null;
  startExecution({ session, sessionPath: sessionPath(S), binding: binding(S), instruction: 'x', stateDir: S, env: goodExeEnv(), spawn: () => c, resolveExecutable: foundExe, verifyAuthority: okVerify, preflight: preflightOk });
  c.emit('error', new Error('ENOENT'));
  const rec = readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 1 });
  eq('launch: spawn error => FAILED', rec.record.terminalStatus, 'FAILED');
  eq('launch: spawn error finalized true', rec.record.finalized, true);
  tru('launch: spawn error reason captured', String(rec.record.reason).includes('EXECUTOR_SPAWN_FAILED'));
}

// ---- stopExecution ----------------------------------------------------------------
{
  const S = path.join(TMP, 's5'); mkdirSync(S, { recursive: true });
  let c1;
  const handle = startExecution({ session, sessionPath: sessionPath(S), binding: binding(S), instruction: 'x', stateDir: S, env: goodExeEnv(), spawn: () => { c1 = fakeChild(888); return c1; }, resolveExecutable: foundExe, verifyAuthority: okVerify, preflight: preflightOk });
  eq('stop: no handle => NO_ACTIVE_EXECUTION', stopExecution({ handle: null }).reason, 'NO_ACTIVE_EXECUTION');
  const r = stopExecution({ handle });
  tru('stop: signalled', r.ok && r.pid === 888);
  eq('stop: exit(null, SIGTERM) => STOPPED', readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 1 }).record.terminalStatus, 'STOPPED');
  eq('stop: STOPPED record finalized true', readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 1 }).record.finalized, true);
}

// ---- INTERRUPTED projection + activity isolation (correction C) -------------------
{
  const S = path.join(TMP, 's6'); mkdirSync(S, { recursive: true });
  startExecution({ session, sessionPath: sessionPath(S), binding: binding(S), instruction: 'x', stateDir: S, env: goodExeEnv(), spawn: () => fakeChild(999), resolveExecutable: foundExe, verifyAuthority: okVerify, preflight: preflightOk });
  // Issue #93: dead pid + not finalized = finalization in flight => RUNNING,
  // never a false INTERRUPTED for a successful run in the finalize window.
  const st = readExecutionStatus({ stateDir: S, repo: 'o/r', issueNumber: 1, isAlive: () => false });
  eq('projection: dead pid + not finalized => RUNNING', st.execution.status, 'RUNNING');
  eq('projection: lifecycle facts intact', st.execution.pid, 999);

  // Stream loss must NOT corrupt lifecycle: delete the events file.
  const ev = readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 1 }).record.eventsPath;
  rmSync(ev, { force: true });
  const st2 = readExecutionStatus({ stateDir: S, repo: 'o/r', issueNumber: 1, isAlive: () => false });
  eq('isolation: activity unavailable', st2.activity.reason, 'ACTIVITY_UNAVAILABLE');
  eq('isolation: lifecycle still projected', st2.execution.status, 'RUNNING');

  // Issue #96 rework (LOST projection): dead pid + finalized => INTERRUPTED is
  // the canonical LOST projection. It must hold through readExecutionStatus
  // with includeActivity:true (the adapter poll's exact path), and the Issue
  // #93 distinction must stay intact: the not-finalized record above stayed
  // RUNNING (never misprojected as LOST) while this finalized one is LOST.
  writeFileSync(ev, '', 'utf8'); // restore a readable (empty) activity stream
  const recLost = readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 1 });
  recLost.record.finalized = true;
  writeFileSync(recLost.path, JSON.stringify(recLost.record, null, 2), 'utf8');
  const stLost = readExecutionStatus({ stateDir: S, repo: 'o/r', issueNumber: 1, isAlive: () => false, includeActivity: true });
  eq('projection: LOST (dead pid + finalized) => INTERRUPTED with includeActivity:true', stLost.execution.status, 'INTERRUPTED');
  tru('projection: activity read intact alongside LOST projection', stLost.ok && stLost.activity && stLost.activity.ok === true);
  eq('projection: effectiveStatus unchanged (dead + not finalized stays RUNNING)', effectiveStatus({ terminalStatus: null, pid: 1, finalized: false }, () => false), 'RUNNING');
}

// ---- tail bounds + record tamper detection ----------------------------------------
{
  const S = path.join(TMP, 's7'); mkdirSync(S, { recursive: true });
  const h = IDH;
  const dir = path.join(S, 'executions');
  mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let i = 0; i < ACTIVITY_TAIL_MAX_LINES + 50; i += 1) {
    lines.push(JSON.stringify({ seq: i + 1, t: 0, stream: 'stdout', ...classifyEvent(JSON.stringify({ type: 'step_start', i })) }));
  }
  writeFileSync(path.join(dir, `${h}.events.jsonl`), lines.join('\n') + '\n', 'utf8');
  const tail = readActivityTail({ stateDir: S, repo: 'o/r', issueNumber: 1 });
  eq('tail: bounded to max', tail.items.length, ACTIVITY_TAIL_MAX_LINES);
  eq('tail: truncated flag', tail.truncated, true);
  eq('tail: seq continuity preserved', tail.items[0].seq, 51);

  writeFileSync(path.join(dir, `${h}.json`), JSON.stringify({ schemaVersion: EXECUTION_SCHEMA_VERSION, identityHash: 'b'.repeat(64), terminalStatus: 'EXITED' }), 'utf8');
  eq('read: tampered/mislocated record rejected', readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 1 }).reason, 'EXECUTION_RECORD_INVALID');
}

// ---- capability preflight: fail-closed BEFORE spawn ----------------------------
{
  const S = path.join(TMP, 's8'); mkdirSync(S, { recursive: true });
  const noSpawn = () => { throw new Error('spawn must never run after preflight failure'); };
  const mkCfg = (perm) => writeFileSync(path.join(S, 'opencode.json'), JSON.stringify({ permission: perm }), 'utf8');
  const call = (preflight) => startExecution({
    session, sessionPath: sessionPath(S), binding: binding(S), instruction: 'x', stateDir: S, env: goodExeEnv(),
    spawn: noSpawn, resolveExecutable: foundExe, verifyAuthority: okVerify, preflight,
  });
  // no config projection in the worktree => CONFIG_READ_FAILED (fail-closed)
  eq('preflight: missing config => fail-closed', call(preflightCodingCapabilities).reason, 'CONFIG_READ_FAILED');
  // bash flipped to ask => insufficient (would auto-reject headless)
  mkCfg({ bash: 'ask', edit: 'allow', read: { '*': 'allow' }, glob: 'allow', grep: 'allow', list: 'allow' });
  const ins = call(preflightCodingCapabilities);
  eq('preflight: ask key => fail-closed', ins.reason, 'EXECUTOR_CAPABILITY_INSUFFICIENT');
  eq('preflight: missing tool named', ins.missing.join(','), 'bash');

  // canonical read pattern-map + explicit allows => real preflight path proceeds
  // (spawnSync stubbed so no real binary probe ever runs in unit tests).
  mkCfg({ bash: 'allow', edit: 'allow', read: { '*': 'allow' }, glob: 'allow', grep: 'allow', list: 'allow' });
  let spawned = false;
  const realPreflight = (probe) => ({ executable, worktreePath }) =>
    preflightCodingCapabilities({ executable, worktreePath, spawnSync: probe });
  const r = startExecution({
    session, sessionPath: sessionPath(S), binding: binding(S), instruction: 'x', stateDir: S, env: goodExeEnv(),
    spawn: () => { spawned = true; const c = fakeChild(1234); queueMicrotask(() => c.emit('exit', 0, null)); return c; },
    resolveExecutable: foundExe, verifyAuthority: okVerify,
    preflight: realPreflight(() => ({ stdout: 'opencode 9.9.9' })),
  });
  tru('preflight: sufficient projection => launch proceeds', r.ok);
  tru('preflight: sufficient path spawned executor', spawned);
  await new Promise((res) => setImmediate(res));
  eq('preflight: version parsed from probe', readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 1 }).record.executorVersion, '9.9.9');
  // version probe failure is diagnostics-only: launch proceeds with version null
  const r2 = startExecution({
    session, sessionPath: sessionPath(S), binding: binding(S), instruction: 'x again', stateDir: S, env: goodExeEnv(),
    spawn: () => { const c = fakeChild(1235); queueMicrotask(() => c.emit('exit', 0, null)); return c; },
    resolveExecutable: foundExe, verifyAuthority: okVerify,
    preflight: realPreflight(() => { throw new Error('boom'); }),
  });
  tru('preflight: probe failure is diagnostics-only', r2.ok);
  await new Promise((res) => setImmediate(res));
  eq('preflight: version null on probe failure', readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 1 }).record.executorVersion, null);
}

// ---- invariant: resolved path is the single source (probe == spawn == record) -----
{
  const S = path.join(TMP, 's-inv');
  mkdirSync(S, { recursive: true });
  const exe = path.join(TMP, 'exe', 'opencode.exe'); // real file created in resolver block
  let probeExe = null;
  let spawnExe = null;
  const preflight = ({ executable }) => { probeExe = executable; return preflightOk(); };
  const r = startExecution({
    session, sessionPath: sessionPath(S), binding: binding(S), instruction: 'x', stateDir: S,
    env: { PATH: path.dirname(exe) },
    spawn: (e) => { spawnExe = e; const c = fakeChild(77); queueMicrotask(() => c.emit('exit', 0, null)); return c; },
    resolveExecutable: resolveOpenCodeExecutable, verifyAuthority: okVerify, preflight,
  });
  tru('invariant: launch ok via PATH resolution', r.ok);
  eq('invariant: probe exe == resolved exe', probeExe, exe);
  eq('invariant: spawn exe == resolved exe', spawnExe, exe);
  await new Promise((res) => setImmediate(res));
  eq('invariant: record.executable == resolved exe', readExecutionRecord({ stateDir: S, repo: 'o/r', issueNumber: 1 }).record.executable, exe);
}

// ---- readWin32ProcessStartTime (injected spawnSync; never a real probe) ----------
{
  const r = readWin32ProcessStartTime(4242, () => ({ stdout: '133600000000000000\n' }));
  tru('pst: ticks parsed', !!r && r.pid === 4242 && r.processStartTime > 0);
  eq('pst: invalid pid => null', readWin32ProcessStartTime(0, () => ({ stdout: '1' })), null);
  eq('pst: garbage stdout => null', readWin32ProcessStartTime(4242, () => ({ stdout: 'not-a-number' })), null);
  eq('pst: empty stdout => null', readWin32ProcessStartTime(4242, () => ({ stdout: '' })), null);
}

// ---- report ------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'ok' : 'FAIL'}  ${c.name}${c.ok ? '' : `  got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
console.log(`executor-launcher.test: ${checks.length - failed.length}/${checks.length} checks passed`);
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* windows handle lag */ }
if (failed.length) process.exit(1);
