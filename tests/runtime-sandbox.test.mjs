#!/usr/bin/env node
// runtime-sandbox.test.mjs — tests for packages/runtime-sandbox (Issue #18).
// Real-FS tests: guard rejections, taskStart happy path with provisioned worktree.
// Follows same pattern as workspace.test.mjs (makeRepo, checks, summary).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  mainCheckoutGuard, symlinkEscapeGuard,
  taskStart, SANDBOX_SCHEMA_VERSION, ALLOWED_OPERATIONS, sessionPathFor,
  verifyExecutionRootBinding, readSessionRecord,
} from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { buildOpenCodeConfig, OPENCODE_CONFIG_SCHEMA, OPENCODE_CONFIG_FILENAME, OPENCODE_MCP_TIMEOUT_MS } from '../packages/runtime-sandbox/opencode-adapter.mjs';
import { identityHash, worktreePathFor, bindingPathFor } from '../packages/workspace/workspace.mjs';
import { validateControlCwd, createMcpServer } from '../packages/runtime-sandbox/mcp-server.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

const CANON = 'duongpdddic-droid/Soc_brain';
const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-rs-'));
const TMP_ROOT = path.join(TMP, 'worktrees');
mkdirSync(TMP_ROOT, { recursive: true });

function makeRepo() {
  const dir = mkdtempSync(path.join(TMP, 'repo-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'tester',
    GIT_AUTHOR_EMAIL: 't@e.x',
    GIT_COMMITTER_NAME: 'tester',
    GIT_COMMITTER_EMAIL: 't@e.x',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const stderr = (e.stderr || '') + ' | ' + (e.stdout || '');
      throw new Error('git ' + args.join(' ') + ' failed: ' + (stderr || e.message));
    }
  };
  run(['init', '--initial-branch=main', dir]);
  run(['config', 'user.email', 't@e.x']);
  run(['config', 'user.name', 'tester']);
  return {
    dir, run,
    commit: (file, content, msg = 'c') => {
      const fp = path.join(dir, file);
      const parent = path.dirname(fp);
      if (parent !== dir) mkdirSync(parent, { recursive: true });
      writeFileSync(fp, content);
      run(['add', file]);
      run(['commit', '-m', msg]);
      return run(['rev-parse', 'HEAD']).trim();
    },
    setRemote: (name, url) => {
      try { run(['remote', 'remove', name]); } catch {}
      run(['remote', 'add', name, url]);
    },
    dispose: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}
// ---- SANDBOX_SCHEMA_VERSION / ALLOWED_OPERATIONS --------------------------------
eq('SANDBOX_SCHEMA_VERSION', SANDBOX_SCHEMA_VERSION, '1');
eq('ALLOWED_OPERATIONS length', ALLOWED_OPERATIONS.length, 3);
tru('ALLOWED_OPERATIONS includes status', ALLOWED_OPERATIONS.includes('status'));
tru('ALLOWED_OPERATIONS includes diff', ALLOWED_OPERATIONS.includes('diff'));
tru('ALLOWED_OPERATIONS includes run_registered_test', ALLOWED_OPERATIONS.includes('run_registered_test'));

// ---- mainCheckoutGuard: rejects worktree inside the main checkout ---------------
{
  let repo;
  try {
    repo = makeRepo();
    const baseSha = repo.commit('GUARD.md', 'g');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    // The main checkout itself should be rejected.
    const mg = mainCheckoutGuard({ worktree: repo.dir, controlCwd: repo.dir });
    falsy('mainCheckoutGuard rejects main checkout itself', mg.ok);
    if (!mg.ok) {
      const reasons = mg.errors.map((e) => e.reason);
      eq('mainCheckoutGuard reason is WORKTREE_IS_MAIN_CHECKOUT', reasons[0], 'WORKTREE_IS_MAIN_CHECKOUT');
    }
  } finally { if (repo) repo.dispose(); }
}

// ---- mainCheckoutGuard: non-git controlCwd -> NO_GIT_ROOT -----------------------
{
  const unrelated = mkdtempSync(path.join(TMP, 'unrelated-'));
  try {
    const mg = mainCheckoutGuard({ worktree: unrelated, controlCwd: unrelated });
    falsy('mainCheckoutGuard on non-git dir returns NO_GIT_ROOT', mg.ok);
    if (!mg.ok) eq('mainCheckoutGuard non-git reason', mg.errors[0].reason, 'NO_GIT_ROOT');
  } finally { try { rmSync(unrelated, { recursive: true, force: true }); } catch {} }
}

// ---- mainCheckoutGuard: legit linked worktree admitted from canonical cwd (GPT-REV-143) ----
// Reproduces the authority/MCP child launched FROM the canonical checkout cwd:
// process.cwd() is set equal to controlCwd. Before GPT-REV-143 the guard resolved
// the main checkout's relative `--git-dir` (`.git`) against process.cwd(), which
// collided with the worktree's `--git-common-dir` and FALSE-rejected a real
// `git worktree add` linked worktree. The guard must now admit it, and still
// reject the canonical checkout itself.
{
  let repo;
  const origCwd = process.cwd();
  let wt = null;
  try {
    repo = makeRepo();
    const baseSha = repo.commit('TREE.md', 't');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    wt = path.join(TMP, `linkedwt-${Math.random().toString(36).slice(2)}`);
    // Real linked worktree, per provisioning (git worktree add).
    repo.run(['worktree', 'add', '-b', 'linked-branch', wt, baseSha]);
    // Simulate the MCP/authority process launched from the canonical checkout cwd.
    process.chdir(repo.dir);
    const mg = mainCheckoutGuard({ worktree: wt, controlCwd: repo.dir });
    tru('mainCheckoutGuard admits a legit linked worktree from canonical cwd', mg.ok);
    if (!mg.ok) {
      eq('mainCheckoutGuard legit-worktree reject reason', mg.errors[0].reason, 'SHARED_MAIN_GIT_DIR');
    }
    // The canonical checkout itself must still be rejected (canonical execution).
    const mgMain = mainCheckoutGuard({ worktree: repo.dir, controlCwd: repo.dir });
    falsy('mainCheckoutGuard still rejects the canonical checkout from canonical cwd', mgMain.ok);
  } finally {
    try { process.chdir(origCwd); } catch { /* restore regardless */ }
    if (repo && wt) { try { repo.run(['worktree', 'remove', '--force', wt]); } catch { try { rmSync(wt, { recursive: true, force: true }); } catch {} } }
    if (repo) repo.dispose();
  }
}

// ---- symlinkEscapeGuard: rejects symlink worktree path --------------------------
{
  let repo;
  let symlinkMade = false;
  try {
    repo = makeRepo();
    repo.commit('SYMLINK_GUARD.md', 's');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const fakeWt = mkdtempSync(path.join(TMP, 'fakewt-'));
    const symlinkWt = path.join(TMP, 'symlink-wt');
    try {
      symlinkSync(fakeWt, symlinkWt, process.platform === 'win32' ? 'junction' : 'dir');
      symlinkMade = true;
    } catch (e) {
      console.log('  symlink unsupported, skipping: ' + String((e && e.message) || e));
    }
    if (symlinkMade) {
      const sg = symlinkEscapeGuard({ worktree: symlinkWt, worktreesRoot: TMP_ROOT });
      falsy('symlinkEscapeGuard rejects symlink path', sg.ok);
      if (!sg.ok) {
        const reasons = sg.errors.map((e) => e.reason);
        tru('symlinkEscapeGuard rejects (SYMLINK or ESCAPES_ROOT)', reasons.includes('WORKTREE_SYMLINK') || reasons.includes('WORKTREE_ESCAPES_ROOT'));
      }
      try { rmSync(symlinkWt, { recursive: true, force: true }); } catch {}
    }
    try { rmSync(fakeWt, { recursive: true, force: true }); } catch {}
  } finally { if (repo) repo.dispose(); }
}

// ---- symlinkEscapeGuard: rejects worktree outside worktreesRoot -----------------
{
  const outside = mkdtempSync(path.join(TMP, 'outside-'));
  const sg = symlinkEscapeGuard({ worktree: outside, worktreesRoot: TMP_ROOT });
  falsy('symlinkEscapeGuard rejects path outside root', sg.ok);
  if (!sg.ok) {
    const reasons = sg.errors.map((e) => e.reason);
    tru('symlinkEscapeGuard includes WORKTREE_ESCAPES_ROOT', reasons.includes('WORKTREE_ESCAPES_ROOT'));
  }
  try { rmSync(outside, { recursive: true, force: true }); } catch {}
}
// ---- taskStart happy path -------------------------------------------------------
{
  let repo;
  try {
    repo = makeRepo();
    const baseSha = repo.commit('START.md', 's');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issueNumber = 118;
    const result = taskStart({
      repo: CANON, issueNumber, baseSha,
      worktreesRoot: TMP_ROOT,
      stateDir: path.join(TMP, '_state'),
      controlCwd: repo.dir,
      testRegistry: {},
      taskContract: { title: 'Pilot test', body: 'Scope: bootstrap only (no task implementation).' },
    });
    tru('taskStart ok', result.ok);
    if (result.ok) {
      tru('taskStart has evidence', result.evidence);
      eq('taskStart evidence schemaVersion', result.evidence.schemaVersion, '1');
      tru('taskStart evidence has binding', result.evidence.binding);
      eq('taskStart evidence binding.repo', result.evidence.binding.repo, 'duongpdddic-droid/soc_brain');
      eq('taskStart evidence binding.issueNumber', result.evidence.binding.issueNumber, issueNumber);
      eq('taskStart evidence binding.baseSha', result.evidence.binding.baseSha, baseSha);
      tru('taskStart evidence binding.identityHash', result.evidence.binding.identityHash);
      eq('taskStart evidence binding.identityHash length', result.evidence.binding.identityHash.length, 32);
      tru('taskStart has broker', result.broker);
      eq('taskStart broker type', typeof result.broker, 'object');
      tru('taskStart has mcpCommand', result.mcpCommand);
      eq('taskStart mcpCommand is process.execPath', result.mcpCommand, process.execPath);
      tru('taskStart has mcpArgs', result.mcpArgs);
      tru('taskStart has mcpEnv', result.mcpEnv);
      eq('taskStart session.state', result.session.state, 'SESSION_ACTIVE');
      eq('taskStart session.schemaVersion', result.session.schemaVersion, '1');
      tru('taskStart session.path', result.session.path);
      tru('taskStart session.leaseToken', result.session.leaseToken);
      eq('taskStart session.path on disk', fs.existsSync(result.session.path), true);
      eq('taskStart mcpEnv has SOC_SESSION_PATH', result.mcpEnv.SOC_SESSION_PATH, result.session.path);
      eq('taskStart mcpEnv has SOC_SESSION_TOKEN', result.mcpEnv.SOC_SESSION_TOKEN, result.session.leaseToken);
      eq('taskStart mcpEnv has SOC_CONTROL_CWD', result.mcpEnv.SOC_CONTROL_CWD, path.resolve(repo.dir));
      tru('taskStart mcpEnv no SOC_REPO authority', !result.mcpEnv.SOC_REPO);
      tru('taskStart has session leaseToken length', result.session.leaseToken.length, 48);
      tru('taskStart has openCodeConfig', result.openCodeConfig);
      eq('openCodeConfig $schema', result.openCodeConfig.$schema, OPENCODE_CONFIG_SCHEMA);
      eq('openCodeConfig permission.bash', result.openCodeConfig.permission.bash, 'deny');
      eq('openCodeConfig permission.edit', result.openCodeConfig.permission.edit, 'allow');
      eq('openCodeConfig permission.webfetch', result.openCodeConfig.permission.webfetch, 'deny');
      eq('openCodeConfig experimental.mcp_timeout', result.openCodeConfig.experimental.mcp_timeout, OPENCODE_MCP_TIMEOUT_MS);
      tru('openCodeConfig has mcp.soc-brain', result.openCodeConfig.mcp['soc-brain']);
      eq('mcpServer type', result.openCodeConfig.mcp['soc-brain'].type, 'local');
      tru('mcpServer command is array', Array.isArray(result.openCodeConfig.mcp['soc-brain'].command));
      eq('mcpServer command[0]', result.openCodeConfig.mcp['soc-brain'].command[0], process.execPath);
      eq('mcpServer enabled', result.openCodeConfig.mcp['soc-brain'].enabled, true);
      eq('mcpServer env SOC_SESSION_PATH', result.openCodeConfig.mcp['soc-brain'].environment.SOC_SESSION_PATH, result.session.path);
      eq('mcpServer env SOC_CONTROL_CWD', result.openCodeConfig.mcp['soc-brain'].environment.SOC_CONTROL_CWD, path.resolve(repo.dir));
      tru('openCodeConfigPath ends with opencode.json', result.openCodeConfigPath.endsWith('opencode.json'));
      // Verify the file was actually written and its content matches.
      tru('opencode.json exists on disk', fs.existsSync(result.openCodeConfigPath));
      const stored = JSON.parse(fs.readFileSync(result.openCodeConfigPath, 'utf8'));
      eq('stored config permission.bash', stored.permission.bash, 'deny');
      eq('stored config experimental.mcp_timeout', stored.experimental.mcp_timeout, OPENCODE_MCP_TIMEOUT_MS);
      tru('stored config has mcp', stored.mcp && stored.mcp['soc-brain']);
      eq('stored config env SOC_CONTROL_CWD', stored.mcp['soc-brain'].environment.SOC_CONTROL_CWD, path.resolve(repo.dir));
      // Issue #31 pilot: task-contract projection into the OpenCode execution context.
      tru('openCodeConfig has instructions', Array.isArray(result.openCodeConfig.instructions));
      eq('openCodeConfig instructions[0]', result.openCodeConfig.instructions[0], 'SOC_TASK_CONTRACT.md');
      tru('task contract file exists', fs.existsSync(path.join(path.dirname(result.openCodeConfigPath), 'SOC_TASK_CONTRACT.md')));
      tru('evidence has opencode', result.evidence.opencode);
      tru('evidence opencode has digest', result.evidence.opencode.digest);
      eq('evidence opencode digest length', result.evidence.opencode.digest.length, 64);
      tru('evidence opencode bytes > 0', result.evidence.opencode.bytes > 0);
      // evidence.session (new, GPT-REV-136): authority digest pointing to control-plane state.
      tru('taskStart evidence has session', result.evidence.session);
      eq('taskStart evidence.session.state', result.evidence.session.state, 'SESSION_ACTIVE');
      eq('taskStart evidence.session.digest length', result.evidence.session.digest.length, 64);
      eq('taskStart evidence.session.path', result.evidence.session.path, result.session.path);
      // taskPacket (new, GPT-REV-140): bounded context projection.
      tru('taskStart taskPacket ok', result.taskPacket.ok);
      if (result.taskPacket.ok) {
        eq('taskPacket repo', result.taskPacket.packet.repo, 'duongpdddic-droid/soc_brain');
        eq('taskPacket issueNumber', result.taskPacket.packet.issueNumber, issueNumber);
        eq('taskPacket baseSha', result.taskPacket.packet.baseSha, baseSha);
        eq('taskPacket schemaVersion', result.taskPacket.packet.schemaVersion, '1');
        tru('taskPacket taskId present', result.taskPacket.packet.taskId);
      }
    }
  } finally { if (repo) repo.dispose(); }
}

// ---- taskStart validation: missing params ---------------------------------------
falsy('taskStart missing repo', taskStart({ issueNumber: 1, baseSha: 'a'.repeat(40) }).ok);
falsy('taskStart missing issueNumber', taskStart({ repo: CANON, baseSha: 'a'.repeat(40) }).ok);
falsy('taskStart missing baseSha', taskStart({ repo: CANON, issueNumber: 1 }).ok);
falsy('taskStart invalid baseSha', taskStart({ repo: CANON, issueNumber: 1, baseSha: 'short' }).ok);
falsy('taskStart invalid repo', taskStart({ repo: 123, issueNumber: 1, baseSha: 'a'.repeat(40) }).ok);

// ---- Issue #25: validateControlCwd rejects a bad SOC_CONTROL_CWD --------------
// The control-plane cwd must be an absolute real Git checkout whose origin matches
// the session repo, and must never be (or live inside) the execution worktree.
{
  const nonGit = mkdtempSync(path.join(TMP, 'nongit-'));
  const unrelatedRepo = makeRepo();
  let repo;
  let wt = null;
  try {
    repo = makeRepo();
    const ccBase = repo.commit('CC.md', 'c');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    wt = path.join(TMP, 'ccwt-' + Math.random().toString(36).slice(2));
    repo.run(['worktree', 'add', '-b', 'cc-branch', wt, ccBase]);
    unrelatedRepo.setRemote('origin', 'https://github.com/other/SomeOtherRepo.git');
    const g = (controlCwd) => validateControlCwd({ controlCwd, repo: CANON, worktreePath: wt });
    const ok = g(repo.dir);
    eq('validateControlCwd valid', ok.ok, true);
    if (ok.ok) eq('validateControlCwd root is canonical dir', path.normalize(ok.root), path.normalize(repo.dir));
    eq('validateControlCwd missing -> CONTROL_CWD_MISSING', g('').reason, 'CONTROL_CWD_MISSING');
    eq('validateControlCwd relative -> CONTROL_CWD_NOT_ABSOLUTE', g('relative/path').reason, 'CONTROL_CWD_NOT_ABSOLUTE');
    eq('validateControlCwd non-existent -> CONTROL_CWD_NOT_DIRECTORY', g(path.join(TMP, 'does-not-exist')).reason, 'CONTROL_CWD_NOT_DIRECTORY');
    eq('validateControlCwd non-git -> CONTROL_CWD_NO_GIT_ROOT', g(nonGit).reason, 'CONTROL_CWD_NO_GIT_ROOT');
    eq('validateControlCwd wrong repo -> CONTROL_CWD_WRONG_REPO', g(unrelatedRepo.dir).reason, 'CONTROL_CWD_WRONG_REPO');
    eq('validateControlCwd execution worktree -> CONTROL_CWD_IS_EXECUTION_WORKTREE', g(wt).reason, 'CONTROL_CWD_IS_EXECUTION_WORKTREE');
  } finally {
    if (repo && wt) { try { repo.run(['worktree', 'remove', '--force', wt]); } catch {} }
    if (repo) repo.dispose();
    if (unrelatedRepo) try { unrelatedRepo.dispose(); } catch {}
    try { rmSync(nonGit, { recursive: true, force: true }); } catch {}
  }
}

// ---- GPT-REV-141 preflight: real OpenCode accepts the generated config -------
const MCP_ENTRYPOINT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'runtime-sandbox', 'mcp-server.mjs');

function openCodeAvailable() {
  try { execFileSync('opencode', ['--version'], { shell: true, stdio: 'ignore' }); return true; }
  catch { return false; }
}

{
  if (openCodeAvailable()) {
    const proj = mkdtempSync(path.join(TMP, 'ocproj-'));
    const cfg = buildOpenCodeConfig({
      mcpCommand: process.execPath,
      mcpArgs: [MCP_ENTRYPOINT],
      mcpEnv: { SOC_SESSION_PATH: 'preflight-probe', SOC_SESSION_TOKEN: 'preflight-probe' },
    });
    writeFileSync(path.join(proj, OPENCODE_CONFIG_FILENAME), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    try {
      const out = execFileSync('opencode', ['debug', 'config'], { cwd: proj, shell: true, encoding: 'utf8' });
      const resolved = JSON.parse(out);
      eq('preflight output is resolved JSON', typeof resolved.$schema, 'string');
      eq('preflight permission.bash deny', resolved.permission.bash, 'deny');
      eq('preflight permission.edit allow', resolved.permission.edit, 'allow');
      eq('preflight permission.webfetch deny', resolved.permission.webfetch, 'deny');
      eq('preflight mcp.soc-brain type local', resolved.mcp['soc-brain'].type, 'local');
      eq('preflight mcp.soc-brain command[0]', resolved.mcp['soc-brain'].command[0], process.execPath);
      eq('preflight mcp.soc-brain enabled', resolved.mcp['soc-brain'].enabled, true);
      eq('preflight experimental.mcp_timeout', resolved.experimental.mcp_timeout, OPENCODE_MCP_TIMEOUT_MS);
    } catch (e) {
      falsy('preflight opencode run threw', String((e && e.message) || e));
    } finally {
      try { rmSync(proj, { recursive: true, force: true }); } catch {}
    }
  } else {
    console.log('SKIP opencode preflight: opencode binary not available on PATH');
  }
}

// ---- GPT-REV-138: direct-run entrypoint actually executes main() ---------------
// `node mcp-server.mjs` with no trusted config must reach main(), detect the
// MISSING_CONFIG authority failure and exit 1. If the direct-run check were
// broken (the file:// vs filesystem-path bug) the process would never call
// main() and would exit 0 doing nothing. Cwd-independent: the config read fails
// before any worktree/Git/guard code runs.
{
  const env = { ...process.env };
  delete env.SOC_SESSION_PATH;
  delete env.SOC_SESSION_TOKEN;
  delete env.SOC_CONTROL_CWD;
  const r = spawnSync(process.execPath, [MCP_ENTRYPOINT], {
    input: '', cwd: os.tmpdir(), encoding: 'utf8', env,
  });
  eq('mcp-directrun exit 1 (missing config)', r.status, 1);
  tru('mcp-directrun reports MISSING_CONFIG', /MISSING_CONFIG/.test(String(r.stderr || '')));
}

// ---- Issue #25: MCP boots from SOC_CONTROL_CWD (real spawn, cwd=worktree) ------
// Regression for the OpenCode-launch-from-the-execution-worktree bug: process.cwd()
// is the worktree but SOC_CONTROL_CWD is the canonical checkout. The server must
// still boot, expose exactly 3 Broker tools and serve status/diff/run.
{
  let repo;
  try {
    repo = makeRepo();
    repo.commit('rt-hello.cjs', "process.stdout.write('hi')");
    const baseSha = repo.commit('BASE.md', 'base');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issueNumber = 910;
    const result = taskStart({
      repo: CANON, issueNumber, baseSha,
      worktreesRoot: TMP_ROOT, stateDir: path.join(TMP, '_state_mcp'),
      controlCwd: repo.dir,
      testRegistry: { hello: { executable: 'node', argv: ['rt-hello.cjs'] } },
    });
    eq('mcp-int taskStart ok', result.ok, true);
    if (result.ok) {
      const wt = path.dirname(result.openCodeConfigPath);
      writeFileSync(path.join(wt, 'BASE.md'), 'base modified', 'utf8');
      const env = {
        ...process.env,
        SOC_SESSION_PATH: result.session.path,
        SOC_SESSION_TOKEN: result.session.leaseToken,
        SOC_CONTROL_CWD: path.resolve(repo.dir),
      };
      const reqs = [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'soc_broker_status', arguments: {} } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'soc_broker_diff', arguments: { diffMode: 'working_tree' } } },
        { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'soc_broker_run_registered_test', arguments: { testId: 'hello' } } },
      ].map((o) => JSON.stringify(o)).join('\n') + '\n';
      const r = spawnSync(process.execPath, [MCP_ENTRYPOINT], {
        input: reqs, cwd: wt, encoding: 'utf8', env, timeout: 60000,
      });
      eq('mcp-int exit code 0', r.status, 0);
      tru('mcp-int no stderr', !String(r.stderr || '').trim());
      const lines = String(r.stdout || '').trim().split('\n').map((l) => JSON.parse(l));
      eq('mcp-int response count', lines.length, 5);
      const byId = new Map(lines.map((l) => [l.id, l]));
      eq('mcp-int serverInfo name', byId.get(1).result.serverInfo.name, 'soc-brain-broker');
      eq('mcp-int tools length', byId.get(2).result.tools.length, 3);
      eq('mcp-int tool names', JSON.stringify(byId.get(2).result.tools.map((t) => t.name).sort()), JSON.stringify(['soc_broker_diff', 'soc_broker_run_registered_test', 'soc_broker_status']));
      const status = JSON.parse(byId.get(3).result.content[0].text);
      eq('mcp-int status ok', status.ok, true);
      tru('mcp-int status sees dirty BASE.md', status.data.entries.some((e) => (e.path || '').includes('BASE.md')));
      const diff = JSON.parse(byId.get(4).result.content[0].text);
      eq('mcp-int diff ok', diff.ok, true);
      tru('mcp-int diff mentions BASE.md', diff.data.output.includes('BASE.md'));
      const run = JSON.parse(byId.get(5).result.content[0].text);
      eq('mcp-int run ok', run.ok, true);
      eq('mcp-int run exitCode', run.data.exitCode, 0);
      eq('mcp-int run stdout', run.data.stdout, 'hi');
    }
  } finally { if (repo) repo.dispose(); }
}

// ---- Issue #25: forged SOC_CONTROL_CWD fails closed ---------------------------
// A valid session but a SOC_CONTROL_CWD that is NOT the canonical checkout must
// never bind: the MCP exits 1 with CONTROL_CWD_DENIED (wrong repo).
{
  let repo;
  let forged;
  try {
    repo = makeRepo();
    const baseSha = repo.commit('FORGED.md', 'f');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issueNumber = 920;
    const result = taskStart({
      repo: CANON, issueNumber, baseSha,
      worktreesRoot: TMP_ROOT, stateDir: path.join(TMP, '_state_forged'),
      controlCwd: repo.dir,
      testRegistry: {},
    });
    eq('forge taskStart ok', result.ok, true);
    forged = makeRepo();
    forged.setRemote('origin', 'https://github.com/evil/Everything.git');
    const wt = path.dirname(result.openCodeConfigPath);
    const env = {
      ...process.env,
      SOC_SESSION_PATH: result.session.path,
      SOC_SESSION_TOKEN: result.session.leaseToken,
      SOC_CONTROL_CWD: path.resolve(forged.dir),
    };
    const r = spawnSync(process.execPath, [MCP_ENTRYPOINT], {
      input: '', cwd: wt, encoding: 'utf8', env, timeout: 30000,
    });
    eq('forge exit 1', r.status, 1);
    tru('forge reports CONTROL_CWD_DENIED', /CONTROL_CWD_DENIED/.test(String(r.stderr || '')));
    tru('forge reports CONTROL_CWD_WRONG_REPO', /CONTROL_CWD_WRONG_REPO/.test(String(r.stderr || '')));
  } finally { if (repo) repo.dispose(); if (forged) forged.dispose(); }
}

// ---- GPT-REV-142: idempotent reuse never compensates pre-existing state ------
{
  let repo;
  try {
    repo = makeRepo();
    const baseSha = repo.commit('IDEMP.md', 'i');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issueNumber = 131;
    const stateDir = path.join(TMP, '_state_idem');
    const first = taskStart({
      repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir, controlCwd: repo.dir,
    });
    eq('idem first ok', first.ok, true);
    if (first.ok) {
      const h = identityHash({ repo: CANON, issueNumber });
      const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
      const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
      const sp = sessionPathFor({ stateDir, identityHash: h });
      eq('idem first idempotent flag', first.idempotent, false);
      tru('idem worktree exists', fs.existsSync(wt));
      tru('idem binding exists', fs.existsSync(bp));
      tru('idem session exists', fs.existsSync(sp));
      const bindingBefore = fs.readFileSync(bp);
      const sessionBefore = fs.readFileSync(sp);
      const ocPath = path.join(wt, OPENCODE_CONFIG_FILENAME);
      const ocBefore = fs.readFileSync(ocPath);
      // Invalidate the projection digest to force the read-back failure.
      writeFileSync(ocPath, ocBefore + '\n// tampered\n', 'utf8');
      const second = taskStart({
        repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir, controlCwd: repo.dir,
      });
      eq('idem second ok', second.ok, false);
      eq('idem second reason', second.reason, 'SESSION_READBACK_FAILED');
      tru('idem worktree survives', fs.existsSync(wt));
      tru('idem binding survives', fs.existsSync(bp));
      tru('idem session survives', fs.existsSync(sp));
      eq('idem binding byte-for-byte', fs.readFileSync(bp).equals(bindingBefore), true);
      eq('idem session byte-for-byte', fs.readFileSync(sp).equals(sessionBefore), true);
      eq('idem tampered config survives', fs.readFileSync(ocPath).equals(ocBefore), false);
    }
  } finally { if (repo) repo.dispose(); }
}

// ---- Issue #18: verifyExecutionRootBinding admits a properly bound session -----
{
  let repo;
  try {
    repo = makeRepo();
    const baseSha = repo.commit('BIND.md', 'b');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issueNumber = 1018;
    const result = taskStart({
      repo: CANON, issueNumber, baseSha,
      worktreesRoot: TMP_ROOT, stateDir: path.join(TMP, '_state_bind'),
      controlCwd: repo.dir, testRegistry: {},
    });
    eq('bind-valid taskStart ok', result.ok, true);
    if (result.ok) {
      const s = readSessionRecord(result.session.path);
      eq('bind-valid session readable', s.ok, true);
      if (s.ok) {
        const eb = verifyExecutionRootBinding({ session: s.session, controlCwd: repo.dir });
        eq('bind-valid guard ok', eb.ok, true);
      }
    }
  } finally { if (repo) repo.dispose(); }
}

// ---- Issue #18: forged execution root (session worktree != authorized) --------
{
  const fake = {
    repo: CANON, issueNumber: 9999, baseSha: 'a'.repeat(40),
    worktreesRoot: TMP_ROOT, worktreePath: path.join(TMP, 'not-the-worktree'),
  };
  const eb = verifyExecutionRootBinding({ session: fake });
  eq('bind-forged ok', eb.ok, false);
  eq('bind-forged reason', eb.reason, 'WORKSPACE_SESSION_BIND_REQUIRED');
  tru('bind-forged detail mentions unauthorized', /not the authorized worktree/.test(eb.detail));
}

// ---- Issue #18: missing binding file -> WORKSPACE_SESSION_BIND_REQUIRED --------
{
  let repo;
  try {
    repo = makeRepo();
    const baseSha = repo.commit('BIND.md', 'b');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issueNumber = 1019;
    const result = taskStart({
      repo: CANON, issueNumber, baseSha,
      worktreesRoot: TMP_ROOT, stateDir: path.join(TMP, '_state_bindmiss'),
      controlCwd: repo.dir, testRegistry: {},
    });
    eq('bind-missing taskStart ok', result.ok, true);
    if (result.ok) {
      const h = identityHash({ repo: CANON, issueNumber });
      const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
      tru('bind-missing binding exists before', fs.existsSync(bp));
      rmSync(bp, { force: true });
      const s = readSessionRecord(result.session.path).session;
      const eb = verifyExecutionRootBinding({ session: s, controlCwd: repo.dir });
      eq('bind-missing ok', eb.ok, false);
      eq('bind-missing reason', eb.reason, 'WORKSPACE_SESSION_BIND_REQUIRED');
      eq('bind-missing verify.reason', eb.verify && eb.verify.reason, 'BINDING_ABSENT');
    }
  } finally { if (repo) repo.dispose(); }
}

// ---- Issue #18: forged binding record (identity mismatch) -> fail closed -------
{
  let repo;
  try {
    repo = makeRepo();
    const baseSha = repo.commit('BIND.md', 'b');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issueNumber = 1020;
    const result = taskStart({
      repo: CANON, issueNumber, baseSha,
      worktreesRoot: TMP_ROOT, stateDir: path.join(TMP, '_state_bindforge'),
      controlCwd: repo.dir, testRegistry: {},
    });
    eq('bind-forged-rec taskStart ok', result.ok, true);
    if (result.ok) {
      const h = identityHash({ repo: CANON, issueNumber });
      const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
      const b = JSON.parse(fs.readFileSync(bp, 'utf8'));
      b.repo = 'differently/forgedRepo'; // identity field no longer matches
      writeFileSync(bp, `${JSON.stringify(b, null, 2)}\n`, 'utf8');
      const s = readSessionRecord(result.session.path).session;
      const eb = verifyExecutionRootBinding({ session: s, controlCwd: repo.dir });
      eq('bind-forged-rec ok', eb.ok, false);
      eq('bind-forged-rec reason', eb.reason, 'WORKSPACE_SESSION_BIND_REQUIRED');
      eq('bind-forged-rec verify.reason', eb.verify && eb.verify.reason, 'BINDING_IDENTITY_MISMATCH');
    }
// ---- Issue #18: edit/test DENIED per-request when binding breaks after boot ----
// Boot succeeds while the execution-root binding is valid, then the binding
// record is removed; the NEXT tool call (run_registered_test = a "test" action)
// MUST fail closed WORKSPACE_SESSION_BIND_REQUIRED (isError true) — the runtime
// never edits/runs when it is not bound to the authorized execution root.
{
  let repo;
  try {
    repo = makeRepo();
    repo.commit('deny-hello.cjs', "process.stdout.write('hi')");
    const baseSha = repo.commit('BASE.md', 'base');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issueNumber = 1021;
    const result = taskStart({
      repo: CANON, issueNumber, baseSha,
      worktreesRoot: TMP_ROOT, stateDir: path.join(TMP, '_state_deny'),
      controlCwd: repo.dir,
      testRegistry: { x: { executable: 'node', argv: ['deny-hello.cjs'] } },
    });
    eq('bind-deny taskStart ok', result.ok, true);
    if (result.ok) {
      const h = identityHash({ repo: CANON, issueNumber });
      const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
      const server = createMcpServer({
        config: {
          ok: true,
          sessionPath: result.session.path,
          leaseToken: result.session.leaseToken,
          controlCwd: path.resolve(repo.dir),
        },
      });
      eq('bind-deny boot ok', server.ok, true);
      if (server.ok) {
        // Break the execution-root binding AFTER boot: delete the binding record.
        rmSync(bp, { force: true });
        const res = server.handleRequest({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'soc_broker_run_registered_test', arguments: { testId: 'x' } },
        });
        eq('bind-deny tool isError', res.result.isError, true);
        tru('bind-deny tool reports WORKSPACE_SESSION_BIND_REQUIRED', /WORKSPACE_SESSION_BIND_REQUIRED/.test(String(res.result.content[0].text)));
      }
    }
  } finally { if (repo) repo.dispose(); }
}

// ---- summary --------------------------------------------------------------------
  } finally { if (repo) repo.dispose(); }
}

// ---- summary --------------------------------------------------------------------
// ---- summary --------------------------------------------------------------------
const pass = checks.filter((c) => c.ok).length;
for (const c of checks) if (!c.ok) console.log('FAIL', c.name, '=>', JSON.stringify(c.got), 'want', JSON.stringify(c.want));
console.log('\nTotal: ' + pass + '/' + checks.length + ' PASS');
// Best-effort cleanup
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(pass === checks.length ? 0 : 1);