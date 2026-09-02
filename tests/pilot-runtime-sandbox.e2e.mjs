#!/usr/bin/env node
// pilot-runtime-sandbox.e2e.mjs — Issue #22 pilot: real E2E vertical slice.
// Spawns the actual packages/runtime-sandbox/mcp-server.mjs child (the exact
// entrypoint OpenCode launches) and speaks JSON-RPC 2.0 over stdio. It prepares
// an authorized session/worktree via taskStart, then exercises the three broker
// capabilities: soc_broker_status, soc_broker_diff, soc_broker_run_registered_test,
// and asserts the fail-closed boundaries still hold. Minimum scope: one test file.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  taskStart, SANDBOX_SCHEMA_VERSION, ALLOWED_OPERATIONS,
  readSessionRecord, verifyExecutionRootBinding,
} from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { identityHash, worktreePathFor, bindingPathFor } from '../packages/workspace/workspace.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });

const CANON = 'duongpdddic-droid/soc_brain';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-pilot-e2e-'));
const TMP_ROOT = path.join(TMP, 'worktrees');
const STATE_DIR = path.join(TMP, 'state');
mkdirSync(TMP_ROOT, { recursive: true });

const T = {
  startupMs: 0, statusMs: 0, diffMs: 0, runTestMs: 0,
  retryCount: 0, shellSyntaxMismatch: 0, humanInterventions: 0, failures: 0,
};

const run = (cmd, args, { cwd }) => String(execFileSync(cmd, args, { cwd, encoding: 'utf8' })).replace(/\r\n/g, '\n').trim();
function resolve(fn) { try { return fn(); } catch (e) { return String((e && e.stdout) || '').trim(); } }

function makeCanonRepo() {
  const dir = mkdtempSync(path.join(TMP, 'repo-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'tester', GIT_AUTHOR_EMAIL: 't@e.x',
    GIT_COMMITTER_NAME: 'tester', GIT_COMMITTER_EMAIL: 't@e.x',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  };
  const r = (args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  r(['init', '--initial-branch=main', dir]);
  r(['config', 'user.email', 't@e.x']);
  r(['config', 'user.name', 'tester']);
  fs.cpSync(path.join(PKG_ROOT, 'packages'), path.join(dir, 'packages'), { recursive: true });
  mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.cpSync(path.join(HERE, 'runtime-sandbox.test.mjs'), path.join(dir, 'tests', 'runtime-sandbox.test.mjs'), { recursive: true });
  fs.cpSync(path.join(HERE, 'pilot-runtime-sandbox.e2e.mjs'), path.join(dir, 'tests', 'pilot-runtime-sandbox.e2e.mjs'));
  r(['add', '-A']);
  r(['commit', '-m', 'seed']);
  r(['remote', 'add', 'origin', `https://github.com/${CANON}.git`]);
  return { dir, run: r, dispose: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function minimalEnv() {
  const allow = ['PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'OS', 'ComSpec', 'PROCESSOR_ARCHITECTURE'];
  const env = {};
  for (const k of allow) { if (process.env[k] !== undefined) env[k] = process.env[k]; }
  return env;
}
function startBroker(mcpCommand, mcpArgs, mcpEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(mcpCommand, mcpArgs, { env: { ...minimalEnv(), ...mcpEnv }, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    const pending = new Map();
    let seq = 1;
    let errBuf = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id != null && pending.has(msg.id)) {
          const pc = pending.get(msg.id);
          pending.delete(msg.id);
          pc.resolve({ msg, elapsedMs: Date.now() - pc.t0 });
        }
      }
    });
    child.stderr.on('data', (c) => { errBuf += c; });
    const exited = new Promise((r) => child.on('close', (code) => r(code)));
    const call = (method, params) => new Promise((r) => {
      const id = seq++;
      pending.set(id, { resolve: r, t0: Date.now() });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    resolve({ child, call, exited, stderr: () => errBuf, end: () => { try { child.stdin.end(); } catch { /* noop */ } } });
  });
}

function parseToolResponse(resp) {
  const txt = (resp && resp.content && resp.content[0] && resp.content[0].text) || '';
  let parsed = null;
  try { parsed = JSON.parse(txt); } catch { parsed = { raw: txt }; }
  return { txt, parsed, isError: !!(resp && resp.isError) };
}

// SCENARIO 0 — schema/operation constants (contract pinned by Issue #18).
eq('SANDBOX_SCHEMA_VERSION', SANDBOX_SCHEMA_VERSION, '1');
eq('ALLOWED_OPERATIONS.length', ALLOWED_OPERATIONS.length, 3);
tru('ALLOWED_OPERATIONS includes status', ALLOWED_OPERATIONS.includes('status'));
tru('ALLOWED_OPERATIONS includes diff', ALLOWED_OPERATIONS.includes('diff'));
tru('ALLOWED_OPERATIONS includes run_registered_test', ALLOWED_OPERATIONS.includes('run_registered_test'));

// SCENARIO 1 — authorized session/worktree; the three broker tools succeed E2E.
let repo;
let mcp = null;
try {
  repo = makeCanonRepo();
  const baseSha = repo.run(['rev-parse', 'HEAD']).trim();
  const issueNumber = 2201;
  const result = taskStart({
    repo: CANON, issueNumber, baseSha,
    worktreesRoot: TMP_ROOT, stateDir: STATE_DIR,
    controlCwd: repo.dir,
    testRegistry: {
      'runtime-sandbox': { executable: 'node', argv: ['tests/runtime-sandbox.test.mjs'], timeoutMs: 120000 },
    },
  });
  eq('taskStart ok', result.ok, true);
  if (!result.ok) { console.log('FATAL taskStart failed:', JSON.stringify(result)); throw new Error('taskStart failed'); }

  // Session/worktree binding is proven from authoritative state.
  const s = readSessionRecord(result.session.path);
  eq('session readable', s.ok, true);
  if (s.ok) {
    eq('session repo', s.session.repo, CANON);
    eq('session issueNumber', s.session.issueNumber, issueNumber);
    eq('session baseSha', s.session.baseSha, baseSha);
    eq('session worktreePath', s.session.worktreePath, result.binding.path);
    eq('session capabilities includes run_registered_test', s.session.capabilities.includes('run_registered_test'), true);
    const eb = verifyExecutionRootBinding({ session: s.session, controlCwd: repo.dir });
    eq('verifyExecutionRootBinding ok', eb.ok, true);
  }

  // Spawn the REAL mcp-server.mjs child (the exact OpenCode launch surface).
  mcp = await startBroker(result.mcpCommand, result.mcpArgs, result.mcpEnv);
  const t0 = Date.now();
  await mcp.call('initialize', {});
  T.startupMs = Date.now() - t0;

  const toolsList = await mcp.call('tools/list', {});
  const toolNames = (toolsList.msg.result.tools || []).map((x) => x.name).sort();
  eq('tools/list exposes exactly 3 tools', toolNames.length, 3);
  tru('exposes soc_broker_status', toolNames.includes('soc_broker_status'));
  tru('exposes soc_broker_diff', toolNames.includes('soc_broker_diff'));
  tru('exposes soc_broker_run_registered_test', toolNames.includes('soc_broker_run_registered_test'));

  // soc_broker_status
  const st = await mcp.call('tools/call', { name: 'soc_broker_status', arguments: {} });
  T.statusMs = st.elapsedMs;
  const stParsed = parseToolResponse(st.msg.result);
  eq('soc_broker_status isError', stParsed.isError, false);
  eq('soc_broker_status ok', stParsed.parsed && stParsed.parsed.ok, true);
  eq('soc_broker_status operation', stParsed.parsed && stParsed.parsed.operation, 'status');
  tru('soc_broker_status has data.entries', Array.isArray((stParsed.parsed || {}).data && stParsed.parsed.data.entries));

  // soc_broker_diff
  const df = await mcp.call('tools/call', { name: 'soc_broker_diff', arguments: { diffMode: 'working_tree' } });
  T.diffMs = df.elapsedMs;
  const dfParsed = parseToolResponse(df.msg.result);
  eq('soc_broker_diff isError', dfParsed.isError, false);
  eq('soc_broker_diff ok', dfParsed.parsed && dfParsed.parsed.ok, true);
  eq('soc_broker_diff operation', dfParsed.parsed && dfParsed.parsed.operation, 'diff');

  // soc_broker_run_registered_test (the real runtime-sandbox.test)
  const rt = await mcp.call('tools/call', { name: 'soc_broker_run_registered_test', arguments: { testId: 'runtime-sandbox' } });
  T.runTestMs = rt.elapsedMs;
  const rtParsed = parseToolResponse(rt.msg.result);
  eq('soc_broker_run_registered_test isError', rtParsed.isError, false);
  eq('soc_broker_run_registered_test ok', rtParsed.parsed && rtParsed.parsed.ok, true);
  eq('soc_broker_run_registered_test testId', rtParsed.parsed && rtParsed.parsed.testId, 'runtime-sandbox');
  eq('soc_broker_run_registered_test exitCode 0', rtParsed.parsed && rtParsed.parsed.data && rtParsed.parsed.data.exitCode, 0);
  tru('registered test ran in an isolated snapshot', !!(rtParsed.parsed && rtParsed.parsed.evidence && rtParsed.parsed.evidence.isolated === true));
  tru('registered test left bound worktree unchanged', !!(rtParsed.parsed && rtParsed.parsed.evidence && rtParsed.parsed.evidence.worktreeUnchanged === true));

  // FAIL-CLOSED A — tampered lease token -> startup DENIED.
  {
    const bad = await startBroker(result.mcpCommand, result.mcpArgs, { ...result.mcpEnv, SOC_SESSION_TOKEN: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
    const code = await bad.exited;
    eq('tampered lease token -> exit 1', code, 1);
    tru('tampered lease token -> SESSION_AUTHORITY_DENIED', /SESSION_AUTHORITY_DENIED/.test(bad.stderr()));
  }

  // FAIL-CLOSED B — break the execution-root binding AFTER boot; next call DENIED.
  {
    const h = identityHash({ repo: CANON, issueNumber });
    const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    tru('binding file exists before break', fs.existsSync(bp));
    rmSync(bp, { force: true });
    const denied = await mcp.call('tools/call', { name: 'soc_broker_status', arguments: {} });
    const deniedParsed = parseToolResponse(denied.msg.result);
    eq('broken binding -> isError', deniedParsed.isError, true);
    tru('broken binding -> WORKSPACE_SESSION_BIND_REQUIRED', /WORKSPACE_SESSION_BIND_REQUIRED/.test(deniedParsed.txt));
  }
} finally {
  if (mcp) { try { mcp.end(); } catch { /* noop */ } }
  if (repo) { try { repo.dispose(); } catch { /* noop */ } }
}

// Summary
const pass = checks.filter((c) => c.ok).length;
for (const c of checks) if (!c.ok) console.log('FAIL', c.name, '=>', JSON.stringify(c.got), 'want', JSON.stringify(c.want));
console.log('\n=== Pilot E2E telemetry (Issue #22) ===');
console.log(JSON.stringify(T, null, 2));
console.log('\nTotal: ' + pass + '/' + checks.length + ' PASS');
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
process.exit(pass === checks.length ? 0 : 1);

