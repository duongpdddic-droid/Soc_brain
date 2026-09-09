#!/usr/bin/env node
// control-ui.test.mjs — tests for packages/control-ui (Issue #53).
// No framework. Exit 0 = PASS, 1 = FAIL. Fully injected control plane:
// NO real taskStart, NO real git, NO real opencode, NO real worktrees.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  validateRunRequest, buildStateResponse, buildActivityResponse, buildChangesResponse,
  createControlPlane, createControlUiServer, renderUiPage, CONTROL_UI_VERSION,
} from '../packages/control-ui/control-ui.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { buildTaskViewModel, VM_SCHEMA_VERSION } from '../packages/control-ui/ui-view-model.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-control-ui-'));
const IDH = identityHash({ repo: 'o/r', issueNumber: 7 });

// ---- validateRunRequest: browser authority is ONLY {issueNumber, instruction} --
{
  tru('validate: minimal ok', validateRunRequest({ issueNumber: 7, instruction: 'do it' }).ok);
  falsy('validate: null body', validateRunRequest(null).ok);
  falsy('validate: non-integer issue', validateRunRequest({ issueNumber: '7', instruction: 'x' }).ok);
  falsy('validate: negative issue', validateRunRequest({ issueNumber: -1, instruction: 'x' }).ok);
  falsy('validate: empty instruction', validateRunRequest({ issueNumber: 7, instruction: '  ' }).ok);
  falsy('validate: oversized instruction', validateRunRequest({ issueNumber: 7, instruction: 'x'.repeat(8193) }).ok);
  falsy('validate: control characters', validateRunRequest({ issueNumber: 7, instruction: 'a\x00b' }).ok);
  tru('validate: optional model ok', validateRunRequest({ issueNumber: 7, instruction: 'x', model: 'opencode/big-pickle' }).ok);
  falsy('validate: bad model charset', validateRunRequest({ issueNumber: 7, instruction: 'x', model: 'a b;c' }).ok);
  // Authority smuggling attempts are simply IGNORED (not honored, not rejected):
  const v = validateRunRequest({ issueNumber: 7, instruction: 'x', repo: 'evil/repo', baseSha: 'f'.repeat(40), worktreePath: 'C:\\evil', executable: 'cmd.exe', argv: ['evil'], cwd: 'C:\\' });
  tru('validate: smuggled authority fields ignored', v.ok && v.repo === undefined && v.executable === undefined && v.cwd === undefined);
}

// ---- buildStateResponse: public projection, no lease token / internal paths -----
{
  const S = path.join(TMP, 'st'); mkdirSync(S, { recursive: true });
  const sessionPath = path.join(S, 'sessions', `${IDH}.json`);
  mkdirSync(path.dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, JSON.stringify({
    schemaVersion: '1', state: 'SESSION_ACTIVE', taskId: 'o/r#7', repo: 'o/r', issueNumber: 7,
    baseSha: 'a'.repeat(40), branch: 'soc/task-x', headSha: 'b'.repeat(40),
    worktreePath: 'C:\\secret\\wt', lease: { token: 'SECRET-LEASE', issuedAt: '2026-01-01T00:00:00.000Z' },
    controlPlane: { sessionPath, bindingPath: 'C:\\secret\\binding', worktreesRoot: 'C:\\secret\\wts' },
  }), 'utf8');
  const r = buildStateResponse({
    repo: 'o/r', issueNumber: 7, stateDir: S,
    readSession: (p) => ({ ok: true, session: JSON.parse(fs.readFileSync(p, 'utf8')) }),
    now: () => '2026-01-01T00:00:01.000Z',
  });
  eq('state: version surfaced', r.server.version, CONTROL_UI_VERSION);
  eq('state: task surfaced', r.task.taskId, 'o/r#7');
  eq('state: lease token NEVER exposed', JSON.stringify(r).includes('SECRET-LEASE'), false);
  eq('state: internal paths NEVER exposed', JSON.stringify(r).includes('C:\\\\secret'), false);
  falsy('state: no execution record => execution null', r.execution);
}

// ---- buildActivityResponse: passthrough shape ------------------------------------
{
  const S = path.join(TMP, 'act'); mkdirSync(S, { recursive: true });
  const dir = path.join(S, 'executions'); mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${IDH}.events.jsonl`), [
    JSON.stringify({ seq: 1, t: 1, stream: 'stdout', kind: 'text', event: { type: 'text', sessionID: 's1', part: { type: 'text', text: 'hi' } }, text: 'hi' }),
    JSON.stringify({ seq: 2, t: 2, stream: 'stderr', kind: 'output', line: 'raw log' }),
  ].join('\n') + '\n', 'utf8');
  const r = buildActivityResponse({ stateDir: S, repo: 'o/r', issueNumber: 7 });
  tru('activity: available', r.available);
  eq('activity: 2 items', r.items.length, 2);
  eq('activity: text verbatim', r.items[0].text, 'hi');
  eq('activity: raw output verbatim', r.items[1].line, 'raw log');
  eq('activity: stream tagged', r.items[1].stream, 'stderr');
  const r2 = buildActivityResponse({ stateDir: path.join(TMP, 'missing'), repo: 'o/r', issueNumber: 7 });
  eq('activity: missing => fail-isolated', `${r2.available}:${r2.reason}`, 'false:ACTIVITY_UNAVAILABLE');
}

// ---- buildChangesResponse: status/diff via injected broker -------------------------
{
  const entries = [
    { code: 'M ', path: 'src/a.mjs' },
    { code: '??', path: 'SOC_E2E_MARKER.txt' },
  ];
  const brokerRequest = (req) => {
    if (req.operation === 'status') return { ok: true, data: { entries, truncated: false } };
    if (req.operation === 'diff') return { ok: true, mode: req.args.mode, data: { output: '--- a/src/a.mjs\n+++ b/src/a.mjs\n+soc-e2e-ok\n', truncated: false } };
    return { ok: false, reason: 'UNEXPECTED' };
  };
  const r = buildChangesResponse({ brokerRequest });
  tru('changes: available', r.available);
  eq('changes: 2 changed entries', r.files.length, 2);
  eq('changes: modified path surfaced', r.files[0].path, 'src/a.mjs');
  eq('changes: modified index', r.files[0].index, 'M');
  eq('changes: untracked flagged', r.files[1].untracked, true);
  tru('changes: diff text passthrough', r.diff.text.includes('+++ b/src/a.mjs') && r.diff.text.includes('+soc-e2e-ok'));
  const r2 = buildChangesResponse({ brokerRequest: () => ({ ok: false, reason: 'BINDING_VERIFY_FAILED' }) });
  eq('changes: broker failure surfaced fail-isolated', r2.reason, 'BINDING_VERIFY_FAILED');
}

// ---- createControlPlane: admission authority, browser has none --------------------
{
  const bad = createControlPlane({ repo: 'not a remote url', stateDir: TMP });
  eq('plane: unresolvable repo rejected', bad.ok === false && bad.reason, 'REPO_UNRESOLVABLE');

  const calls = { taskStart: [], startExecution: [] };
  let allocCalls = 0;
  const fakeBinding = { identityHash: IDH, taskId: 'o/r#7', repo: 'o/r', issueNumber: 7, baseSha: 'a'.repeat(40), branch: 'soc/task-x', path: 'C:\\wt\\7' };
  const fakeTaskStart = (p) => {
    calls.taskStart.push(p);
    return {
      ok: true, idempotent: false,
      worktree: { sessionPath: 'C:\\state\\sessions\\x.json' },
      session: { leaseToken: 'tok-1' },
      binding: fakeBinding,
      telemetry: null,
    };
  };
  const fakeLauncher = {
    startExecution: (p) => { calls.startExecution.push(p); return { ok: true, identityHash: IDH, taskId: 'o/r#7', pid: 4242, child: { kill() {} }, markStopRequested() {}, status: 'RUNNING' }; },
    stopExecution: ({ handle }) => (!handle ? { ok: false, reason: 'NO_ACTIVE_EXECUTION' } : { ok: true, pid: handle.pid, signal: 'SIGTERM' }),
    readExecutionStatus: () => ({ ok: false, reason: 'EXECUTION_NOT_FOUND' }),
    readActivityTail: () => ({ ok: false, reason: 'ACTIVITY_UNAVAILABLE' }),
  };
  const cp = createControlPlane({
    repo: 'https://github.com/o/r.git', stateDir: TMP,
    deps: {
      taskStart: fakeTaskStart,
      launcher: fakeLauncher,
      readUpstreamHead: () => 'c'.repeat(40),
      brokerFor: () => () => ({ ok: false, reason: 'NOT_USED_IN_TEST' }),
    },
  });
  tru('plane: ok + canonical repo name', cp.ok && cp.repo === 'o/r');

  const base = cp.admitAndLaunch({ issueNumber: 7, instruction: 'build the thing' });
  tru('plane: admitted + launched', base.ok && base.pid === 4242);
  eq('plane: canonical repo passed to taskStart', calls.taskStart[0].repo, 'o/r');
  eq('plane: baseSha from control-plane git read', calls.taskStart[0].baseSha, 'c'.repeat(40));
  eq('plane: instruction becomes task contract body', calls.taskStart[0].taskContract.body, 'build the thing');
  tru('plane: launcher cwd = taskStart binding path', calls.startExecution[0].binding.path === fakeBinding.path);
  tru('plane: session/lease from taskStart only', calls.startExecution[0].session.leaseToken === 'tok-1');

  const cpStop = cp.stop({ issueNumber: 99 });
  eq('plane: stop without active run => NO_ACTIVE_EXECUTION', cpStop.reason, 'NO_ACTIVE_EXECUTION');

  // browser cannot choose the base: readUpstreamHead null => 503-ish error
  const cp2 = createControlPlane({
    repo: 'o/r', stateDir: TMP,
    deps: {
      readUpstreamHead: () => null, launcher: fakeLauncher, taskStart: fakeTaskStart,
      // Phase A regression: base admission precedes LOCAL allocation, so an
      // instruction-only run that cannot be admitted must never burn a number.
      allocLocalTaskNumber: () => { allocCalls++; return { ok: true, number: 9000001 }; },
    },
  });
  const noBase = cp2.admitAndLaunch({ issueNumber: 7, instruction: 'x' });
  eq('plane: base unavailable => BASE_UNAVAILABLE', noBase.error, 'BASE_UNAVAILABLE');
  eq('plane: taskStart never called without base', calls.taskStart.length, 1);
  const noBaseLocal = cp2.admitAndLaunch({ instruction: 'no base, no burn' });
  eq('plane: instruction-only base unavailable => BASE_UNAVAILABLE', noBaseLocal.error, 'BASE_UNAVAILABLE');
  eq('plane: allocator never called without base (no burn)', allocCalls, 0);
}

// ---- HTTP server: routes, loopback bind, UI page -----------------------------------
{
  const handlers = { launch: [], stop: [] };
  const fakePlane = {
    state: (v) => ({ schemaVersion: '1', server: { version: CONTROL_UI_VERSION }, task: { taskId: `o/r#${v.issueNumber != null ? v.issueNumber : String(v.identityHash).slice(0, 4)}`, state: 'SESSION_ACTIVE' }, execution: { status: 'RUNNING', pid: 1, elapsedMs: 5 } }),
    activity: () => ({ schemaVersion: '1', available: true, items: [{ seq: 1, kind: 'text', text: 'hello' }] }),
    changes: () => ({ schemaVersion: '1', available: true, files: [], diff: { mode: 'working_tree', truncated: false, text: '' } }),
    admitAndLaunch: (v) => { handlers.launch.push(v); return { ok: true, taskId: `o/r#${v.issueNumber}`, identityHash: IDH, pid: 9, status: 'RUNNING' }; },
    stop: (v) => { handlers.stop.push(v); return { ok: true, pid: 9, signal: 'SIGTERM' }; },
  };
  const srv = createControlUiServer({ controlPlane: fakePlane, port: 0 });
  const { host, port } = await srv.listen();
  eq('http: loopback bind', host, '127.0.0.1');
  tru('http: ephemeral port', port > 0);
  const base = `http://127.0.0.1:${port}`;
  const j = async (p, opts) => { const r = await fetch(base + p, opts); return { code: r.status, body: await r.json() }; };

  const s1 = await j('/api/state?issueNumber=7');
  tru('http: /api/state 200', s1.code === 200 && s1.body.ok && s1.body.task.taskId === 'o/r#7');
  const s2 = await j('/api/state?issueNumber=zero');
  eq('http: bad issueNumber 400', s2.code, 400);
  const s3 = await j('/api/activity?issueNumber=7');
  tru('http: /api/activity passthrough', s3.body.ok && s3.body.available && s3.body.items[0].text === 'hello');
  const s4 = await j('/api/changes?issueNumber=7');
  tru('http: /api/changes 200', s4.code === 200 && s4.body.available);
  const s5 = await j('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issueNumber: 7, instruction: 'go' }) });
  tru('http: /api/run 200', s5.code === 200 && s5.body.ok && s5.body.pid === 9);
  eq('http: run passes only validated fields', JSON.stringify(handlers.launch[0]), JSON.stringify({ ok: true, issueNumber: 7, instruction: 'go', model: null }));
  const s6 = await j('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issueNumber: 7, instruction: 'a\x00b' }) });
  eq('http: invalid body 400', s6.code, 400);
  const s7 = await j('/api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issueNumber: 7 }) });
  tru('http: /api/stop ok', s7.code === 200 && s7.body.ok);
  const s8 = await j('/api/nothing');
  eq('http: unknown route 404', s8.code, 404);

  // Phase A4: identityHash handle path (opaque token, no issue number)
  const h1 = await j(`/api/state?identityHash=${IDH}`);
  tru('http: state via identityHash 200', h1.code === 200 && h1.body.ok && h1.body.task.taskId === `o/r#${IDH.slice(0, 4)}`);
  const h2 = await j('/api/state?identityHash=zzzz');
  eq('http: malformed handle 400', h2.code, 400);
  eq('http: malformed handle reason', h2.body.reason, 'SESSION_TOKEN_MALFORMED');
  const h3 = await j('/api/state');
  eq('http: no target 400', h3.code, 400);
  eq('http: no target reason', h3.body.reason, 'ISSUE_NUMBER_REQUIRED');
  const h4 = await j(`/api/activity?identityHash=${IDH}`);
  tru('http: activity via identityHash', h4.body.ok && h4.body.items[0].text === 'hello');
  const h5 = await j(`/api/changes?identityHash=${IDH}`);
  tru('http: changes via identityHash', h5.body.ok && h5.body.available);
  const s9 = await j('/api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identityHash: IDH }) });
  tru('http: stop via identityHash ok', s9.code === 200 && s9.body.ok);
  eq('http: stop receives handle object', JSON.stringify(handlers.stop[1]), JSON.stringify({ identityHash: IDH }));
  const s10 = await j('/api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identityHash: 'nothex' }) });
  eq('http: stop malformed handle 400', s10.code, 400);
  const s11 = await j('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction: 'local only' }) });
  tru('http: instruction-only run 200', s11.code === 200 && s11.body.ok && s11.body.identityHash === IDH);
  eq('http: instruction-only passes no issueNumber', handlers.launch[1].issueNumber, undefined);

  const page = await (await fetch(base + '/')).text();
  tru('ui: html served', page.includes('<!doctype html>'));
  tru('ui: semantic status tokens', page.includes('--status-success') && page.includes('--status-danger'));
  // UI v1: dashboard structure + canonical adapter wiring.
  tru('ui: v1 sidebar navigation', page.includes('data-view="tasks"') && page.includes('data-view="settings"'));
  tru('ui: v1 tabs', page.includes('data-tab="progress"') && page.includes('data-tab="todo"'));
  tru('ui: v1 modal system', page.includes('id="modalWrap"'));
  tru('ui: v1 terminal popup control', page.includes('id="termBtn"'));
  tru('ui: v1 vm polling from canonical adapter', page.includes('/api/vm?issueNumber='));
  tru('ui: v1 demo fallback present', page.includes('DEMO'));
  // UI v1 visual refinement (visual target).
  tru('ui: sans body + mono technical', page.includes("--sans:") && page.includes("--mono:"));
  tru('ui: dual progress bar (header strip + progress tab)', page.includes('id="pFill2"'));
  tru('ui: current-operation line', page.includes('Đang làm:'));
  tru('ui: human gate banner + detail button', page.includes('CẦN BỐ XỬ LÝ'));
  tru('ui: control-plane status dot', page.includes('id="cpDot"'));
  tru('ui: brain SVG logo', page.includes('<svg width="26"'));
  tru('ui: 3-zone layout grid', page.includes('grid-template-columns:232px 1fr') && page.includes('grid-template-columns:1fr 320px'));
  tru('ui: tab underline accent', page.includes('border-bottom:2px solid var(--accent)'));
  tru('ui: compact radius tokens', page.includes('border-radius:6px') && !page.includes('border-radius:16px'));
  tru('ui: recent events capped at 8 rows', page.includes('.slice(0, 8)'));

  // ---- CLI composition regression (E2E #3): SOC_STATE_DIR unset must resolve ------
  // The CLI entry previously passed stateDir: undefined; taskStart's internal
  // fallback masked it during admission, but startExecution and the state/
  // activity/changes projections crashed with
  // "The \"paths[0]\" argument must be of type string. Received undefined".
  // Regression: spawn the REAL CLI without SOC_STATE_DIR and require the state
  // API to answer 200 (read-only; no /api/run, no git, no executor spawn).
  {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const cliPath = fileURLToPath(new URL('../packages/control-ui/control-ui.mjs', import.meta.url));
    const env = { ...process.env };
    delete env.SOC_STATE_DIR;
    const child = spawn(process.execPath, [
      cliPath, '--repo', '9999/9999', '--port', '0',
    ], { cwd: TMP, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let cliOut = '';
    const killed = new Promise((res) => child.on('exit', res));
    const started = new Promise((resolve) => {
      child.stdout.on('data', (d) => {
        cliOut += String(d);
        const m = cliOut.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
        if (m) resolve(Number(m[1]));
      });
      child.stderr.on('data', (d) => { cliOut += String(d); });
    });
    const port2 = await Promise.race([
      started,
      new Promise((r) => setTimeout(() => r(null), 15000)),
    ]);
    if (port2) {
      try {
        const rs = await fetch(`http://127.0.0.1:${port2}/api/state?issueNumber=999999`);
        const rb = await rs.json();
        eq('cli: SOC_STATE_DIR unset => state 200 (was 500 in E2E #3)', rs.status, 200);
        tru('cli: state body ok with task null', rb.ok === true && rb.task === null);
        const ra = await fetch(`http://127.0.0.1:${port2}/api/activity?issueNumber=999999`);
        eq('cli: SOC_STATE_DIR unset => activity 200', ra.status, 200);
      } finally {
        child.kill();
        await killed;
      }
    } else {
      child.kill();
      await killed;
      tru('cli: CLI server started for regression', false);
    }
  }
  // ---- report ------------------------------------------------------------------------
  tru('ui: OpenCode pane', page.includes('OpenCode'));
  tru('ui: View Diff control', page.includes('View Diff'));
  falsy('ui: never leaks executable path or secret', page.includes('opencode.exe') || page.includes('SECRET'));
  tru('ui: brand wordmark + brain logo', page.includes('Soc_brain') && page.includes('brand-name'));
  tru('ui: vm adapter module exports canonical builder', typeof buildTaskViewModel === 'function');
  tru('ui: vm schema version', VM_SCHEMA_VERSION === '1');
  await new Promise((res) => srv.server.close(res));
}

// ---- report ------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'ok' : 'FAIL'}  ${c.name}${c.ok ? '' : `  got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
console.log(`control-ui.test: ${checks.length - failed.length}/${checks.length} checks passed`);
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* windows handle lag */ }
if (failed.length) process.exit(1);