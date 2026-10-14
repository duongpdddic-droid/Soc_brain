#!/usr/bin/env node
// runtime-sandbox.test.mjs — tests for packages/runtime-sandbox (Issue #18).
// Real-FS tests: guard rejections, taskStart happy path with provisioned worktree.
// Follows same pattern as workspace.test.mjs (makeRepo, checks, summary).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  mainCheckoutGuard, symlinkEscapeGuard,
  taskStart, SANDBOX_SCHEMA_VERSION, ALLOWED_OPERATIONS, sessionPathFor,
  verifyExecutionRootBinding, readSessionRecord,
} from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { buildOpenCodeConfig, OPENCODE_CONFIG_SCHEMA, OPENCODE_CONFIG_FILENAME, OPENCODE_MCP_TIMEOUT_MS, readOpenCodeConfig, evaluateCodingCapabilities } from '../packages/runtime-sandbox/opencode-adapter.mjs';
import { identityHash, worktreePathFor, bindingPathFor } from '../packages/workspace/workspace.mjs';
import { validateControlCwd, createMcpServer } from '../packages/runtime-sandbox/mcp-server.mjs';
import { executionRecordPath, readExecutionRecord } from '../packages/executor-launcher/executor-launcher.mjs';

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
eq('ALLOWED_OPERATIONS length', ALLOWED_OPERATIONS.length, 4);
tru('ALLOWED_OPERATIONS includes status', ALLOWED_OPERATIONS.includes('status'));
tru('ALLOWED_OPERATIONS includes diff', ALLOWED_OPERATIONS.includes('diff'));
tru('ALLOWED_OPERATIONS includes run_registered_test', ALLOWED_OPERATIONS.includes('run_registered_test'));
tru('ALLOWED_OPERATIONS includes bounded commit (Issue #49)', ALLOWED_OPERATIONS.includes('commit'));

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
    repo.commit('START.md', 's');
    const baseSha = repo.commit('SOC_TASK_CONTRACT.md', '# Tracked repository contract\n');
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
      // Issue #49 Gap A: self-describing worktree contract — exact response
      // shape, canonical path, and consistency with the verified binding.
      tru('taskStart worktree contract present', Boolean(result.worktree));
      eq('taskStart worktree exact keys',
         Object.keys(result.worktree).sort().join(','),
         'baseSha,bindingPath,branch,head,identityHash,leaseToken,opencodeConfigPath,path,sessionPath');
      eq('taskStart worktree.path == canonical worktree for identity',
         path.resolve(result.worktree.path),
         path.resolve(worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: identityHash({ repo: CANON, issueNumber }) })));
      eq('taskStart worktree.branch is task branch',
         result.worktree.branch,
         'agent/' + identityHash({ repo: CANON, issueNumber }));
      eq('taskStart worktree.baseSha', result.worktree.baseSha, baseSha);
      eq('taskStart worktree.head == verified binding head', result.worktree.head, result.binding.head);
      eq('taskStart worktree.opencodeConfigPath', result.worktree.opencodeConfigPath, result.openCodeConfigPath);
      eq('taskStart worktree.sessionPath', result.worktree.sessionPath, result.session.path);
      eq('taskStart worktree.leaseToken', result.worktree.leaseToken, result.session.leaseToken);
      tru('taskStart worktree.path exists on disk', fs.existsSync(result.worktree.path));
      tru('taskStart worktree.bindingPath exists on disk', fs.existsSync(result.worktree.bindingPath));
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
      eq('openCodeConfig permission.bash', result.openCodeConfig.permission.bash, 'allow');
      eq('openCodeConfig permission.edit', result.openCodeConfig.permission.edit, 'allow');
      eq('openCodeConfig permission.read wildcard', result.openCodeConfig.permission.read['*'], 'allow');
      eq('openCodeConfig read .env deny (secret boundary)', result.openCodeConfig.permission.read['*.env'], 'deny');
      eq('openCodeConfig read .env.example re-allow (last-match-wins)', result.openCodeConfig.permission.read['*.env.example'], 'allow');
      eq('openCodeConfig permission.glob', result.openCodeConfig.permission.glob, 'allow');
      eq('openCodeConfig permission.grep', result.openCodeConfig.permission.grep, 'allow');
      eq('openCodeConfig permission.list', result.openCodeConfig.permission.list, 'allow');
      eq('openCodeConfig permission.task', result.openCodeConfig.permission.task, 'allow');
      eq('openCodeConfig permission.skill', result.openCodeConfig.permission.skill, 'allow');
      eq('openCodeConfig permission.webfetch', result.openCodeConfig.permission.webfetch, 'allow');
      eq('openCodeConfig permission.websearch', result.openCodeConfig.permission.websearch, 'allow');
      eq('openCodeConfig permission.external_directory deny', result.openCodeConfig.permission.external_directory, 'deny');
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
      eq('stored config permission.bash', stored.permission.bash, 'allow');
      eq('stored config read .env deny', stored.permission.read['*.env'], 'deny');
      eq('stored config external_directory deny', stored.permission.external_directory, 'deny');
      eq('stored config experimental.mcp_timeout', stored.experimental.mcp_timeout, OPENCODE_MCP_TIMEOUT_MS);
      tru('stored config has mcp', stored.mcp && stored.mcp['soc-brain']);
      eq('stored config env SOC_CONTROL_CWD', stored.mcp['soc-brain'].environment.SOC_CONTROL_CWD, path.resolve(repo.dir));
      // Issue #31 pilot: task-contract projection into the OpenCode execution context.
      tru('openCodeConfig has instructions', Array.isArray(result.openCodeConfig.instructions));
      eq('openCodeConfig instructions[0]', result.openCodeConfig.instructions[0], '.soc/task-contract.md');
      const contractRoot = path.dirname(result.openCodeConfigPath);
      tru('projected task contract exists', fs.existsSync(path.join(contractRoot, '.soc', 'task-contract.md')));
      eq('taskStart preserves tracked repository contract', fs.readFileSync(path.join(contractRoot, 'SOC_TASK_CONTRACT.md'), 'utf8').trim(), '# Tracked repository contract');
      eq('taskStart introduces no tracked-file dirt', execFileSync('git', ['diff', '--name-only'], { cwd: contractRoot, encoding: 'utf8' }).trim(), '');
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
      // Issue #47: telemetry recorder identity carries the stable task id
      // derived from the workspace binding ({repo}#{issueNumber}) and the
      // TASK_STARTED event is actually recorded to the JSONL stream.
      tru('taskStart telemetry non-null', result.telemetry);
      if (result.telemetry) {
        eq('telemetry recorder ok', result.telemetry.recorder.ok, true);
        eq('telemetry taskId is stable repo#issue',
           result.telemetry.recorder.identity.taskId,
           'duongpdddic-droid/soc_brain#118');
        tru('telemetry has recorded events', result.telemetry.recorder.events().length > 0);
        eq('telemetry first event is TASK_STARTED',
           result.telemetry.recorder.events()[0]?.event, 'TASK_STARTED');
        tru('telemetry events file exists on disk', fs.existsSync(result.telemetry.recorder.eventsPath));
        tru('telemetry JSONL non-empty', fs.statSync(result.telemetry.recorder.eventsPath).size > 0);
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

// OpenCode >= 2.x answers `debug config` with an array of typed documents
// ({type, path, info}) and NO merged view; `permission` is normalized into an
// {action,resource,effect} rule list per source document (`bash` -> action
// `shell`, `task` -> action `subagent`), MCP entries live under
// `mcp.servers[name]` with `disabled` instead of `enabled`, and
// `experimental.mcp_timeout` folds into `mcp.timeout`. The projections below
// only SELECT source documents (strict, fail-closed); they never merge rules
// across documents — merged precedence is runtime behavior that this output
// does not express, so inventing a merge here would be an unverified oracle.
const DEBUG_EFFECTS = ['allow', 'deny', 'ask'];

function assertPermissionRules(rules, label) {
  if (!Array.isArray(rules)) throw new Error(label + ': permissions must be an array');
  for (const r of rules) {
    if (!r || typeof r !== 'object') throw new Error(label + ': permission rule must be an object');
    if (typeof r.action !== 'string' || typeof r.resource !== 'string') {
      throw new Error(label + ': permission rule requires string action+resource');
    }
    if (!DEBUG_EFFECTS.includes(r.effect)) {
      throw new Error(label + ': permission rule effect must be allow|deny|ask, got ' + JSON.stringify(r.effect));
    }
  }
}

// Strictly select the single source document at exactly `wantPath`.
function selectDebugDocument(raw, wantPath) {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('debug config: expected documents array (OpenCode >= 2.x)');
  const want = path.normalize(wantPath);
  const matches = parsed.filter((d) => d && d.type === 'document'
    && typeof d.path === 'string' && path.normalize(d.path) === want);
  if (matches.length !== 1) {
    throw new Error('debug config: expected exactly one document at ' + want + ', got ' + matches.length);
  }
  const info = matches[0].info;
  if (!info || typeof info !== 'object') throw new Error('debug config: document has no info object: ' + want);
  if (info.permissions !== undefined) assertPermissionRules(info.permissions, want);
  return info;
}

const projectDebugDocument = (raw, projDir) =>
  selectDebugDocument(raw, path.join(projDir, OPENCODE_CONFIG_FILENAME));

// Binary-vocabulary rule lookup on ONE source document (find-only, no merging).
const effectOf = (info, action, resource) => (Array.isArray(info.permissions)
  ? (info.permissions.find((r) => r.action === action && r.resource === resource) || {}).effect
  : undefined);
const debugActions = (info) => [...new Set((info.permissions || []).map((r) => r.action))].sort();

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
      // The real binary resolved the generated config: select the project
      // document strictly (missing/duplicate/malformed => throw => FAIL below).
      const info = projectDebugDocument(out, proj);
      eq('preflight document carries schema', typeof info.$schema, 'string');
      // Assert the binary-normalized rule list directly (config `bash` -> action
      // `shell`, config `task` -> action `subagent` — v2 vocabulary).
      eq('preflight shell(=bash) allow', effectOf(info, 'shell', '*'), 'allow');
      eq('preflight edit allow', effectOf(info, 'edit', '*'), 'allow');
      // GPT-REV-137 regression: `read` must be EXPLICITLY projected (wildcard-ask
      // auto-reject class) as explicit rules in the project document.
      eq('preflight read allow (GPT-REV-137)', effectOf(info, 'read', '*'), 'allow');
      eq('preflight read .env deny survives binary resolution', effectOf(info, 'read', '*.env'), 'deny');
      eq('preflight webfetch allow', effectOf(info, 'webfetch', '*'), 'allow');
      eq('preflight subagent(=task) allow', effectOf(info, 'subagent', '*'), 'allow');
      eq('preflight skill allow', effectOf(info, 'skill', '*'), 'allow');
      eq('preflight websearch allow', effectOf(info, 'websearch', '*'), 'allow');
      eq('preflight external_directory deny', effectOf(info, 'external_directory', '*'), 'deny');
      const soc = info.mcp && info.mcp.servers && info.mcp.servers['soc-brain'];
      eq('preflight mcp.soc-brain type local', soc && soc.type, 'local');
      eq('preflight mcp.soc-brain command[0]', soc && soc.command && soc.command[0], process.execPath);
      eq('preflight mcp.soc-brain disabled=false (v2 spelling)', soc && soc.disabled, false);
      eq('preflight mcp.timeout.execution (from experimental.mcp_timeout)',
        info.mcp && info.mcp.timeout && info.mcp.timeout.execution, OPENCODE_MCP_TIMEOUT_MS);
    } catch (e) {
      falsy('preflight opencode run threw', String((e && e.message) || e));
    } finally {
      try { rmSync(proj, { recursive: true, force: true }); } catch {}
    }
  } else {
    console.log('SKIP opencode preflight: opencode binary not available on PATH');
  }
}

// ---- capability preflight helpers (Issue #31 pilot, Bước 4/5) ------------------
// readOpenCodeConfig + evaluateCodingCapabilities: the launch preflight reads
// the worktree projection back from disk and fails closed on any missing/ask
// key. Deterministic (no binary) — the binary-level acceptance is covered by
// the real `opencode debug config` preflight blocks above.
{
  const proj = mkdtempSync(path.join(TMP, 'ocpref-'));
  // canonical projection from buildOpenCodeConfig must pass evaluate
  const canonical = buildOpenCodeConfig({ mcpCommand: 'node', mcpArgs: ['x.mjs'] });
  writeFileSync(path.join(proj, OPENCODE_CONFIG_FILENAME), JSON.stringify(canonical, null, 2) + '\n', 'utf8');
  const rd = readOpenCodeConfig({ worktreePath: proj });
  tru('preflight: canonical projection reads back ok', rd.ok);
  const ev = evaluateCodingCapabilities(rd.config);
  tru('preflight: canonical projection sufficient', ev.ok);
  eq('preflight: toolCaps minimum set',
    JSON.stringify(ev.toolCaps),
    JSON.stringify({ bash: 'allow', edit: 'allow', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow' }));

  // missing config => fail-closed
  eq('preflight: missing config file fails closed', readOpenCodeConfig({ worktreePath: path.join(TMP, 'no-such-dir') }).reason, 'CONFIG_READ_FAILED');
  const brokenDir = mkdtempSync(path.join(TMP, 'ocbroken-'));
  writeFileSync(path.join(brokenDir, OPENCODE_CONFIG_FILENAME), '{corrupt', 'utf8');
  eq('preflight: corrupt config fails closed', readOpenCodeConfig({ worktreePath: brokenDir }).reason, 'CONFIG_PARSE_FAILED');

  // ask/missing keys => EXECUTOR_CAPABILITY_INSUFFICIENT with named missing
  const ask = evaluateCodingCapabilities({ permission: { ...canonical.permission, bash: 'ask' } });
  falsy('preflight: ask key insufficient', ask.ok);
  eq('preflight: ask key named missing', ask.missing.join(','), 'bash');
  eq('preflight: ask key reason', ask.reason, 'EXECUTOR_CAPABILITY_INSUFFICIENT');
  const absent = evaluateCodingCapabilities({ permission: { edit: 'allow' } });
  falsy('preflight: missing keys insufficient', absent.ok);
  eq('preflight: missing keys named', absent.missing.join(','), 'bash,read,glob,grep,list');
  eq('preflight: no permission block', evaluateCodingCapabilities({}).reason, 'PERMISSION_BLOCK_MISSING');

  // read pattern-map with '*' allow satisfies the read requirement; a deny
  // wildcard does not (fail-closed on the exact GPT-REV-137 class).
  tru('preflight: read pattern-map wildcard allow accepted',
    evaluateCodingCapabilities({ permission: { bash: 'allow', edit: 'allow', read: { '*': 'allow' }, glob: 'allow', grep: 'allow', list: 'allow' } }).ok);
  falsy('preflight: read wildcard deny rejected',
    evaluateCodingCapabilities({ permission: { bash: 'allow', edit: 'allow', read: { '*': 'deny' }, glob: 'allow', grep: 'allow', list: 'allow' } }).ok);
  try { rmSync(proj, { recursive: true, force: true }); rmSync(brokenDir, { recursive: true, force: true }); } catch {}
}

// ---- GPT-REV-137: explicit `read` projection vs operator wildcard-ask --------
// Two-layer reproduction of the E2E #53 read auto-reject:
//   PART A (document projection): binary `debug config` proves the two
//   config sources resolve as separate documents with provenance — the
//   synthetic OPERATOR-GLOBAL fixture carries permission["*"]="ask"; the
//   project document is pre-#53 (no read key) or post-#53 (explicit read).
//   PART B (runtime precedence integration probe): the REAL OpenCode
//   permission engine runs `opencode run --standalone` (no service needed)
//   with a deterministic mock OpenAI-compatible provider that issues one
//   `read` tool call. Only the MODEL is mocked; permission resolution and
//   precedence are production behavior:
//     pre-fix project + global wildcard ask => read auto-rejected (ask)
//     post-fix explicit read allow => read executes (explicit beats wildcard)
//     post-fix read *.env deny => .env read auto-rejected (deny beats allow)
//     rules order swapped => .env ALLOW: the runtime resolves permission maps
//       in declaration order with LAST-match-wins (probed both orders on this
//       runtime), so the canonical shape MUST keep '*.env' deny AFTER '*' allow
// v2.0.26 isolation seam (probe evidence, this runtime): `debug config` ignores
// XDG_CONFIG_HOME and OPENCODE_CONFIG; the global source can only be
// redirected via USERPROFILE/HOME, which additionally requires pinning the
// managed-service port (`opencode service set port`) or session-level service
// discovery collides (port-in-use). Standalone `run` needs no service at all.
// Lifecycle is identity-tracked, fail-closed (review R2): every synthetic
// process (managed service + standalone probe trees) is captured as
// {pid, creationTime}; timeout kills the whole tree (taskkill /T); cleanup
// must prove stop exit 0 AND port closed AND identity gone BEFORE removing
// state — otherwise the state is KEPT for recovery and assertions fail.
// Probe results only count when exit==0 AND no spawn error AND no timeout AND
// identity gone (review R3); allow/deny outcomes additionally require the file
// sentinel to have travelled (or provably NOT travelled) through the recorded
// tool result. PART C adds negative cases: live/reused/unknown-creationTime
// identity gates, port-occupied startup refusal, and stop-no-record no-op.
// The synthetic service is stopped in cleanup, then its port is verified
// CLOSED; stop failures and a still-open port are FAILED assertions, never
// swallowed, so a leaked service cannot turn this block green.
const stripAnsi = (s) => String(s || '').replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
// Ask the OS for a free port (bind ephemeral, close, return): no modulo/PID
// guessing — the kernel only hands out ports nothing is listening on. A tiny
// race window remains between close and the service bind; the deterministic
// guard is the fail-closed closed-port assertion in cleanup below.
const listenFreePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});
const connectOnce = (port) => new Promise((resolve) => {
  const socket = net.connect({ port, host: '127.0.0.1' }, () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
  socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
});
const waitForPortClosed = async (port, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await connectOnce(port))) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
};
// ---- process identity (Windows) ----------------------------------------------
// A port closing is NOT proof a process died, and a bare PID is not a stable
// identity (PID reuse). Capture {pid, creationTime} for every synthetic
// process we own; "gone" requires the pid to be dead OR its creationTime to
// differ (reused by a foreign process). Alive with unknown creationTime is
// NOT gone — fail-closed, never assumed dead.
// TRI-STATE probe (review finding: a catch-all `false` turned every probe
// error into a free "dead" pass): only ESRCH proves death. EPERM/anything
// else is UNKNOWN and must never read as dead.
const processStatus = (pid) => {
  if (!pid) return 'UNKNOWN';
  try { process.kill(Number(pid), 0); return 'ALIVE'; }
  catch (e) { return (e && e.code === 'ESRCH') ? 'DEAD' : 'UNKNOWN'; }
};
const processAlive = (pid) => processStatus(pid) === 'ALIVE';
const queryStartTime = (pid) => {
  // Core Get-Process cmdlet only (Get-NetTCPConnection module load hangs on
  // this runtime — probe evidence: ETIMEDOUT); creationTime is locale-formatted
  // but stable within one machine/run for equality comparison.
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty StartTime`],
    { encoding: 'utf8', timeout: 10000 }).trim() || null;
  } catch { return null; }
};
const captureProcessIdentity = (pid) => {
  if (!pid || !processAlive(pid)) return null;
  return { pid: Number(pid), startTime: queryStartTime(pid) };
};
const identityGone = (identity) => {
  if (!identity) return true; // nothing captured => nothing of ours can be leaking (callers separately gate capture failure)
  const status = processStatus(identity.pid);
  if (status === 'DEAD') return true; // ESRCH: pid dead — proven
  if (status === 'UNKNOWN') return false; // cannot prove death — fail-closed, never assumed dead
  // ALIVE: only a creationTime MISMATCH proves a pid reuse (our process is dead)
  if (!identity.startTime) return false; // alive, unknown creationTime: cannot prove dead
  const now = queryStartTime(identity.pid);
  if (now === null) return false; // timestamp query FAILED: UNKNOWN — never treated as reuse
  return now !== identity.startTime; // same pid, different creationTime => reused, original dead
};
const waitForIdentityGone = async (identity, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (identityGone(identity)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
};
// Kill a whole spawned tree (shell + grandchildren): taskkill /T targets the
// descendant chain of the captured root pid — never a port, never a name.
// The real exit/error is CAPTURED (review finding: a bare resolve(true)
// swallowed every taskkill failure).
const killTree = (pid) => new Promise((resolve) => {
  if (!pid) { resolve({ ok: false, error: 'killTree: no root pid' }); return; }
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], (err, _out, stderr) => {
    if (err) resolve({ ok: false, error: String((err && err.message) || err), stderr: String(stderr || '') });
    else resolve({ ok: true, stderr: String(stderr || '') });
  });
});
// Live descendants of a root pid, from the current Win32_Process table (every
// enumerated record is a LIVE process; children are found by walking the
// ParentProcessId chain). null = the enumeration itself failed (UNKNOWN).
const listLiveDescendantPids = (rootPid) => {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
    { encoding: 'utf8', timeout: 15000 }).trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const byParent = new Map();
    for (const row of rows) {
      if (!row || row.ProcessId == null) continue;
      const par = Number(row.ParentProcessId);
      if (!byParent.has(par)) byParent.set(par, []);
      byParent.get(par).push(Number(row.ProcessId));
    }
    const seen = new Set([Number(rootPid)]);
    const queue = [Number(rootPid)];
    const live = [];
    while (queue.length > 0) {
      const cur = queue.shift();
      for (const ch of (byParent.get(cur) || [])) {
        if (seen.has(ch)) continue;
        seen.add(ch);
        live.push(ch);
        queue.push(ch);
      }
    }
    return live;
  } catch { return null; }
};
// A dead root shell alone never proves the tree died (review finding): gone
// means the captured root identity is gone AND the live descendant
// enumeration comes back EMPTY — every identity must be dead.
const waitForTreeGone = async (rootIdentity, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const live = listLiveDescendantPids(rootIdentity.pid); // null = enumeration failed
    if (identityGone(rootIdentity) && live !== null && live.length === 0) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
};
// The listening-owner PID of a port, from the native TCP table (fast; no
// PowerShell module dependency). Only used to IDENTIFY our synthetic service;
// a foreign owner is never killed.
const netstatListenPid = (port) => {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 15000 });
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 5 && cols[1].endsWith(':' + String(port))) return Number(cols[cols.length - 1]);
    }
  } catch {}
  return null;
};
// Deterministic mock OpenAI-compatible provider: the title request gets a text
// completion, the agent request gets one `read` tool call against
// `stateRef.current.target`, and the follow-up (tool result present) gets a
// stop. Every tool result delivered by the REAL engine is recorded into
// `stateRef.current.reads` so assertions can prove the file content actually
// travelled through the permission gate. SSE chunks must be split the OpenAI
// way (role chunk, then tool_call chunk, then finish) or the AI SDK drops the
// tool call (probe evidence: single-chunk tool_calls loops forever).
function startMockPermissionProvider() {
  const stateRef = { current: null };
  const chunk = (id, delta, finish) => 'data: ' + JSON.stringify({
    id, object: 'chat.completion.chunk', created: 0, model: 'test',
    choices: [{ index: 0, delta, finish_reason: finish }],
  }) + '\n\n';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      const state = stateRef.current || { target: null, reads: [] };
      const sys = String((parsed && parsed.messages && parsed.messages[0] && parsed.messages[0].content) || '');
      const isTitle = /title generator/.test(sys);
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      if (isTitle) {
        res.write(chunk('t1', { role: 'assistant', content: 'T' }, null));
        res.write(chunk('t1', {}, 'stop'));
      } else {
        const toolResults = (parsed && parsed.messages || []).filter((m) => m.role === 'tool');
        if (toolResults.length === 0) {
          res.write(chunk('a1', { role: 'assistant', tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read', arguments: '' } }] }, null));
          res.write(chunk('a1', { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: state.target }) } }] }, null));
          res.write(chunk('a1', {}, 'tool_calls'));
        } else {
          for (const m of toolResults) {
            state.reads.push({ callId: String(m.tool_call_id || ''), content: JSON.stringify(m.content ?? '') });
          }
          res.write(chunk('a1', { role: 'assistant', content: 'AGENT_DONE' }, null));
          res.write(chunk('a1', {}, 'stop'));
        }
      }
      res.write('data: [DONE]\n\n');
      res.end();
      res.on('error', () => {});
    });
    req.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, stateRef }));
  });
}

{
  if (openCodeAvailable()) {
    const baseArgs = { mcpCommand: process.execPath, mcpArgs: [MCP_ENTRYPOINT], mcpEnv: { SOC_SESSION_PATH: 'gpt-rev-137', SOC_SESSION_TOKEN: 'gpt-rev-137' } };
    const pre = buildOpenCodeConfig(baseArgs);
    delete pre.permission.read; // pre-#53 shape: no explicit read key (wildcard lives ONLY in the global fixture)
    const post = buildOpenCodeConfig(baseArgs); // current canonical shape
    const postSwapped = buildOpenCodeConfig(baseArgs); // same rules, reversed order
    postSwapped.permission.read = { '*.env': 'deny', '*': 'allow' };
    // Outer try/finally protects EVERY acquired resource: if setup dies after
    // the mock server or service seam is created, cleanup still runs.
    let mock = null;
    let seamRoot = null;
    let seamEnv = null;
    let seamPort = null;
    let globalFixturePath = null;
    let serviceIdentity = null;
    // Cleanup gate, single source (declared OUTSIDE the try block: a const
    // inside `try {}` is not visible to the sibling `finally {}` scope —
    // probe evidence: ReferenceError at cleanup). State may only be removed
    // when the stop exited clean AND the port closed AND the service identity
    // is provably dead. Every dirty dimension forbids removal (state KEPT).
    const cleanupMayRemoveState = (stopError, portClosed, serviceGone) => stopError === '' && portClosed && serviceGone;
    try {
      mock = await startMockPermissionProvider();
      seamRoot = mkdtempSync(path.join(TMP, 'ocxdg-'));
      const fakeHome = path.join(seamRoot, 'home');
      globalFixturePath = path.join(fakeHome, '.config', 'opencode', OPENCODE_CONFIG_FILENAME);
      mkdirSync(path.dirname(globalFixturePath), { recursive: true });
      writeFileSync(globalFixturePath, JSON.stringify({
        $schema: OPENCODE_CONFIG_SCHEMA,
        permission: { '*': 'ask' },
        provider: {
          mock: {
            npm: '@ai-sdk/openai-compatible',
            name: 'mock',
            options: { baseURL: 'http://127.0.0.1:' + mock.port + '/v1', apiKey: 'mock-key' },
            models: { test: { name: 'test' } },
          },
        },
      }, null, 2) + '\n', 'utf8');
      seamEnv = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome };
      // Bounded port+start retry. listenFreePort()'s bind-0 result lives in
      // the Windows ephemeral range (49152-65535) and CAN be stolen as an
      // outbound TCP source port the instant we close it (probe evidence:
      // first rework-3 targeted run hit "Managed service port ... already in
      // use" on the very first ensure-start). Candidates are therefore picked
      // OUTSIDE the ephemeral range, checked against the live TCP table, and
      // the set-port+start pair is retried on an "already in use" collision —
      // bounded and fail-closed, never silently accepted.
      const MAX_PORT_ATTEMPTS = 5;
      let startFailure = 'not attempted';
      for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS && seamPort === null; attempt += 1) {
        const candidate = 20000 + Math.floor(Math.random() * 20000); // 20000-39999: never ephemeral
        if (netstatListenPid(candidate) !== null) { startFailure = 'candidate already listening: ' + candidate; continue; }
        try {
          execFileSync('opencode', ['service', 'set', 'port', String(candidate)], { encoding: 'utf8', shell: true, env: seamEnv, timeout: 60000 });
          execFileSync('opencode', ['debug', 'config'], { cwd: seamRoot, encoding: 'utf8', shell: true, env: seamEnv, timeout: 90000 });
          seamPort = candidate;
        } catch (e) {
          const msg = String((e && e.stderr) || (e && e.message) || '');
          if (msg.includes('already in use')) { startFailure = 'port stolen before bind: ' + candidate; continue; }
          throw e; // any non-collision failure is a real failure — propagate
        }
      }
      tru('GPT-REV-137 seam: managed service started on a verified port (bounded retries)',
        seamPort !== null);
      if (seamPort === null) throw new Error('GPT-REV-137 seam: no service port after ' + MAX_PORT_ATTEMPTS + ' attempts (' + startFailure + ')');
      // Capture the service identity IMMEDIATELY after startup — before any
      // later probe can churn the process table — so cleanup can PROVE this
      // exact {pid, creationTime} died instead of trusting a closed port.
      const servicePid = netstatListenPid(seamPort);
      serviceIdentity = servicePid ? { pid: servicePid, startTime: queryStartTime(servicePid) } : null;
      tru('GPT-REV-137 identity: synthetic service process captured (pid+creationTime)',
        serviceIdentity !== null && serviceIdentity.pid > 0 && serviceIdentity.startTime !== null);
      const operatorGlobal = path.join(os.homedir(), '.config', 'opencode', OPENCODE_CONFIG_FILENAME);
    const probe = (cfg) => {
      const proj = mkdtempSync(path.join(TMP, 'ocperm-'));
      writeFileSync(path.join(proj, OPENCODE_CONFIG_FILENAME), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      try {
        const out = execFileSync('opencode', ['debug', 'config'], {
          cwd: proj, encoding: 'utf8', shell: true, timeout: 90000,
          env: seamEnv,
        });
        const parsed = JSON.parse(out);
        const docPaths = parsed.filter((d) => d && d.type === 'document' && typeof d.path === 'string').map((d) => String(d.path));
        // provenance: the synthetic fixture document resolved, the real operator
        // global config did NOT (the seam is airtight for this probe).
        tru('GPT-REV-137 provenance: fixture global document loaded',
          docPaths.some((p) => path.normalize(p) === path.normalize(globalFixturePath)));
        falsy('GPT-REV-137 provenance: real operator global NOT loaded',
          docPaths.some((p) => path.normalize(p) === path.normalize(operatorGlobal)));
        return {
          globalInfo: selectDebugDocument(out, globalFixturePath),
          projInfo: projectDebugDocument(out, proj),
        };
      } finally {
        try { rmSync(proj, { recursive: true, force: true }); } catch {}
      }
    };
    // PART B helper: run the real engine against one project config + one
    // target file. ASYNC spawn — never spawnSync: the mock provider lives in
    // THIS process, and a sync spawn would block the event loop so the
    // provider can never answer the model request (probe evidence: sync spawn
    // hangs every run). Lifecycle is identity-tracked: the spawned root pid is
    // captured with its creationTime (a missing capture after a successful
    // spawn fails the run), output is drained until `close` (not `exit`), a
    // timeout REVALIDATES the identity (never taskkill a reused pid) before
    // killing the whole tree, the taskkill exit/error is recorded, and the
    // result only counts if the root identity AND every live descendant are
    // verifiably gone afterwards.
    const runPrecedenceProbe = (cfg, fileName) => new Promise((resolve) => {
      const proj = mkdtempSync(path.join(TMP, 'ocrun-'));
      writeFileSync(path.join(proj, OPENCODE_CONFIG_FILENAME), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      const target = path.join(proj, fileName);
      writeFileSync(target, fileName.endsWith('.env') ? 'TOP_SECRET=1' : 'PRECEDENCE_PROBE_CONTENT', 'utf8');
      const state = { target, reads: [] };
      mock.stateRef.current = state;
      const child = spawn('opencode', ['run', '--standalone', '--model', 'mock/test', 'Read the file ' + target], {
        cwd: proj, env: seamEnv, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const identity = captureProcessIdentity(child.pid); // {pid, startTime} of the spawned shell root
      const identityCaptured = identity !== null; // spawn ok but nothing captured => cleanup CANNOT be proven green
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let killRecord = { attempted: false, ok: false, error: '' };
      let timer = null;
      let hardTimer = null; // BOTH timers cleared in settle (never dangle)
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      const settle = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (hardTimer) clearTimeout(hardTimer);
        if (result.cleanupVerified) {
          try { rmSync(proj, { recursive: true, force: true }); } catch {}
        } else {
          console.log('GPT-REV-137 probe: fixture KEPT for recovery: ' + proj);
        }
        resolve(result);
      };
      const finish = async (code, signal, spawnError) => {
        // A closed root shell alone never proves the tree died: the captured
        // root identity must be gone AND no live descendant may remain.
        const treeGone = identityCaptured && await waitForTreeGone(identity);
        settle({
          code, signal, spawnError,
          timedOut,
          stdout: stripAnsi(stdout),
          stderr: stripAnsi(stderr),
          reads: state.reads,
          identityCaptured,
          killRecord,
          cleanupVerified: identityCaptured && treeGone,
        });
      };
      timer = setTimeout(() => {
        timedOut = true;
        // Revalidate BEFORE killing: a reused root pid belongs to a FOREIGN
        // process and must never be taskkill'ed.
        const rootIsOurs = identityCaptured && !identityGone(identity);
        const afterKill = (killResult) => {
          killRecord = { attempted: rootIsOurs, ok: killResult.ok, error: killResult.error || '' };
          // hard deadline: if the tree still refuses to die, settle as FAILED
          // cleanup (never a green run, never silently abandoned)
          hardTimer = setTimeout(() => finish(null, 'TIMEOUT_UNKILLED', ''), 15000);
        };
        if (rootIsOurs) killTree(child.pid).then(afterKill);
        else afterKill({ ok: false, error: 'root identity reused/dead at timeout — taskkill skipped (never kill a foreign pid)' });
      }, 120000);
      child.on('error', (e) => finish(null, null, String((e && e.message) || e)));
      child.on('close', (code, signal) => finish(code, signal, ''));
    });
    const REJECT_MARK = 'cannot ask the user for permission'; // ask -> headless auto-reject
    const DENY_MARK = 'Permission denied: read'; // deny -> immediate rejection, never asks
    try {
      // ---- PART A: binary document projection (strict, provenance-checked) ----
      const preRes = probe(pre);
      // The operator-global fixture resolved as its own document carrying wildcard ask.
      eq('GPT-REV-137 global fixture: wildcard ask', effectOf(preRes.globalInfo, '*', '*'), 'ask');
      // pre-#53: the project document carries NO explicit read rule — the only
      // wildcard rule lives in the separate global source, never in the project.
      eq('GPT-REV-137 pre-fix: project has no read rule', effectOf(preRes.projInfo, 'read', '*'), undefined);
      falsy('GPT-REV-137 pre-fix: project carries no wildcard-action rule',
        (preRes.projInfo.permissions || []).some((r) => r.action === '*'));
      const postRes = probe(post);
      // post-#53: explicit read rules land in the project document.
      eq('GPT-REV-137 post-fix: explicit read in project', effectOf(postRes.projInfo, 'read', '*'), 'allow');
      eq('GPT-REV-137 authority: read .env secret deny unchanged', effectOf(postRes.projInfo, 'read', '*.env'), 'deny');
      eq('GPT-REV-137 authority: edit allow unchanged', effectOf(postRes.projInfo, 'edit', '*'), 'allow');
      eq('GPT-REV-137 authority: shell(=bash) allow (executor autonomy profile)', effectOf(postRes.projInfo, 'shell', '*'), 'allow');
      eq('GPT-REV-137 authority: webfetch allow (executor autonomy profile)', effectOf(postRes.projInfo, 'webfetch', '*'), 'allow');
      eq('GPT-REV-137 authority: external_directory deny unchanged', effectOf(postRes.projInfo, 'external_directory', '*'), 'deny');
      eq('GPT-REV-137 authority: read-only discovery trio allow (Phase B E2E: glob auto-rejected via wildcard ask)',
        JSON.stringify([effectOf(postRes.projInfo, 'glob', '*'), effectOf(postRes.projInfo, 'grep', '*'), effectOf(postRes.projInfo, 'list', '*')]),
        JSON.stringify(['allow', 'allow', 'allow']));
      eq('GPT-REV-137 authority: no permission surface regression',
        JSON.stringify(debugActions(postRes.projInfo)),
        // Binary-vocabulary union surface: executor autonomy keys
        // (subagent=task/skill/webfetch/websearch, Issue #121) + the six
        // canonical soc_broker MCP tool actions (Issue #83 P0-G) — both are
        // deliberate, evidence-driven explicit keys in the project document;
        // the wildcard-ask stays in the separate operator-global source.
        JSON.stringify(['edit', 'external_directory', 'glob', 'grep', 'list', 'read',
          'shell', 'skill', 'soc-brain_soc_broker_commit', 'soc-brain_soc_broker_diff',
          'soc-brain_soc_broker_request_human_gate', 'soc-brain_soc_broker_run_registered_test',
          'soc-brain_soc_broker_status', 'soc-brain_soc_broker_submit_executor_report',
          'subagent', 'webfetch', 'websearch']));
      // ---- PART B: REAL runtime precedence (permission engine of OpenCode) ----
      // R3 gate: a probe result only counts when the run exited cleanly AND no
      // spawn error occurred AND no timeout fired AND the spawned tree was
      // verifiably gone — a marker string alone can never turn a case green.
      const okRun = (r) => r.code === 0 && r.spawnError === '' && !r.timedOut && r.cleanupVerified;
      // Tool-result assertions bind to the mock's read call id ('c1'): a
      // marker may only count when it travelled through THAT tool call.
      const c1Reads = (r) => r.reads.filter((x) => x.callId === 'c1');
      const readSentinelReached = (r) => c1Reads(r).some((x) => x.content.includes('PRECEDENCE_PROBE_CONTENT'));
      const secretSentinelReached = (r) => c1Reads(r).some((x) => x.content.includes('TOP_SECRET'));
      const preRun = await runPrecedenceProbe(pre, 'hello.txt');
      tru('GPT-REV-137 runtime pre-fix: run lifecycle clean (exit0/no spawn error/no timeout/identity gone)',
        okRun(preRun));
      tru('GPT-REV-137 runtime pre-fix: headless ask rejected (E2E #53 class), file content never reached the model',
        preRun.stderr.includes(REJECT_MARK) && /✗ Read hello\.txt failed/.test(preRun.stderr)
        && !readSentinelReached(preRun));
      const postRun = await runPrecedenceProbe(post, 'hello.txt');
      tru('GPT-REV-137 runtime post-fix: explicit read beats global wildcard ask (lifecycle clean)',
        okRun(postRun));
      tru('GPT-REV-137 runtime post-fix: read executed AND file sentinel travelled through the permission gate',
        postRun.stderr.includes('→ Read hello.txt') && !postRun.stderr.includes(REJECT_MARK)
        && readSentinelReached(postRun));
      const envRun = await runPrecedenceProbe(post, 'secret.env');
      tru('GPT-REV-137 runtime: read *.env secret denied despite read allow (lifecycle clean)',
        okRun(envRun));
      tru('GPT-REV-137 runtime: .env denied with DENY_MARK and secret sentinel never reached the model',
        envRun.stderr.includes(DENY_MARK) && /✗ Read secret\.env failed/.test(envRun.stderr)
        && !secretSentinelReached(envRun));
      const swapFileRun = await runPrecedenceProbe(postSwapped, 'hello.txt');
      tru('GPT-REV-137 runtime swapped rules: read allow still wins (lifecycle clean)',
        okRun(swapFileRun));
      tru('GPT-REV-137 runtime swapped rules: normal file sentinel travelled through',
        swapFileRun.stderr.includes('→ Read hello.txt') && readSentinelReached(swapFileRun));
      const swapEnvRun = await runPrecedenceProbe(postSwapped, 'secret.env');
      // Swapped declaration order FLIPS the .env outcome on this runtime:
      // OpenCode resolves a permission map in declaration order with
      // LAST-match-wins (probed both orders: {'*':allow,'*.env':deny} -> deny;
      // {'*.env':deny,'*':allow} -> allow). The canonical post-#53 shape
      // REQUIRES '*.env' deny to stay AFTER '*' allow for the boundary to hold.
      tru('GPT-REV-137 runtime swapped rules: last matching rule wins — order significant (lifecycle clean)',
        okRun(swapEnvRun));
      tru('GPT-REV-137 runtime swapped rules: .env sentinel really travelled (order flip proven by content)',
        !swapEnvRun.stderr.includes(DENY_MARK) && /→ Read secret\.env/.test(swapEnvRun.stderr)
        && secretSentinelReached(swapEnvRun));
      // ---- PART C: deterministic negative cases (fail-closed lifecycle proofs) ----
      // C1: the identity gate must REJECT a live process — this is the exact
      // check cleanup relies on, so a service leak can never read as "gone".
      const liveIdentity = captureProcessIdentity(process.pid);
      tru('GPT-REV-137 C1: live process with matching creationTime is NOT gone',
        liveIdentity !== null && !identityGone(liveIdentity));
      // C1b: same pid with a DIFFERENT creationTime is a reused pid — the
      // original is dead; the gate must not report a foreign reuse as ours.
      tru('GPT-REV-137 C1b: pid reuse (creationTime mismatch) counts as gone',
        identityGone({ pid: process.pid, startTime: '2000-01-01 00:00:00' }));
      // C1c: alive + unknown creationTime is fail-closed: NOT gone.
      falsy('GPT-REV-137 C1c: alive process with unknown creationTime is NOT gone',
        identityGone({ pid: process.pid, startTime: null }));
      // C1d/C1e: the okRun lifecycle gate is single-source and rejects EVERY
      // dirty dimension — a marker string or a zero exit can never bypass it.
      falsy('GPT-REV-137 C1d: nonzero exit rejected by okRun gate',
        okRun({ code: 1, spawnError: '', timedOut: false, cleanupVerified: true }));
      falsy('GPT-REV-137 C1d: spawn error rejected by okRun gate',
        okRun({ code: 0, spawnError: 'boom', timedOut: false, cleanupVerified: true }));
      falsy('GPT-REV-137 C1d: timeout rejected by okRun gate',
        okRun({ code: 0, spawnError: '', timedOut: true, cleanupVerified: true }));
      falsy('GPT-REV-137 C1d: unverified tree cleanup rejected by okRun gate',
        okRun({ code: 0, spawnError: '', timedOut: false, cleanupVerified: false }));
      tru('GPT-REV-137 C1e: okRun gate passes only a fully clean run',
        okRun({ code: 0, spawnError: '', timedOut: false, cleanupVerified: true }));
      // C1f: taskkill failure is CAPTURED (ok=false + error), never swallowed
      {
        const kr = await killTree(null);
        falsy('GPT-REV-137 C1f: killTree without root pid records ok=false', kr.ok);
      }
      // C2: port-occupied — production must refuse to start the managed
      // service on a foreign-owned port, and must NEVER touch the squatter.
      {
        const negRoot = mkdtempSync(path.join(TMP, 'ocneg-port-'));
        const negHome = path.join(negRoot, 'home');
        mkdirSync(path.join(negHome, '.config', 'opencode'), { recursive: true });
        writeFileSync(path.join(negHome, '.config', 'opencode', OPENCODE_CONFIG_FILENAME), JSON.stringify({ $schema: OPENCODE_CONFIG_SCHEMA }, null, 2) + '\n', 'utf8');
        const negEnv = { ...process.env, USERPROFILE: negHome, HOME: negHome };
        const occupied = await listenFreePort();
        const squatter = net.createServer();
        await new Promise((res) => squatter.listen(occupied, '127.0.0.1', res));
        try {
          execFileSync('opencode', ['service', 'set', 'port', String(occupied)], { encoding: 'utf8', shell: true, env: negEnv, timeout: 60000 });
          let failRc = 0;
          let failMsg = '';
          try {
            execFileSync('opencode', ['debug', 'config'], { cwd: negRoot, encoding: 'utf8', shell: true, env: negEnv, timeout: 90000 });
          } catch (e) {
            failRc = e.status;
            failMsg = String((e && e.stderr) || (e && e.message) || '');
          }
          tru('GPT-REV-137 C2: debug config fails closed on occupied port (rc!=0, "already in use")',
            failRc !== 0 && failMsg.includes('already in use'));
          tru('GPT-REV-137 C2: foreign squatter server never killed (still owns the port)',
            await connectOnce(occupied));
          execFileSync('opencode', ['service', 'stop'], { encoding: 'utf8', shell: true, env: negEnv, timeout: 60000 }); // rc0 no-op (probed)
        } finally {
          await new Promise((res) => squatter.close(res));
          try { rmSync(negRoot, { recursive: true, force: true }); } catch {}
        }
      }
      // C3: stop with no service record is a deterministic rc0 no-op (probed
      // on this runtime) — so a stop error in the cleanup below is a REAL
      // failure, never "nothing to stop" noise.
      {
        const negRoot = mkdtempSync(path.join(TMP, 'ocneg-stop-'));
        const negHome = path.join(negRoot, 'home');
        mkdirSync(path.join(negHome, '.config', 'opencode'), { recursive: true });
        const negEnv = { ...process.env, USERPROFILE: negHome, HOME: negHome };
        try {
          execFileSync('opencode', ['service', 'stop'], { encoding: 'utf8', shell: true, env: negEnv, timeout: 60000 });
          tru('GPT-REV-137 C3: stop without service record is a deterministic rc0 no-op', true);
        } catch (e) {
          falsy('GPT-REV-137 C3: stop without service record must not throw', String((e && e.message) || e));
        } finally {
          try { rmSync(negRoot, { recursive: true, force: true }); } catch {}
        }
      }
      // C4: the cleanup gate — state removal is allowed ONLY when the stop
      // exited clean AND the port closed AND the service identity died.
      falsy('GPT-REV-137 C4: stop-failed forbids state removal',
        cleanupMayRemoveState('stop boom', true, true));
      falsy('GPT-REV-137 C4: open port forbids state removal',
        cleanupMayRemoveState('', false, true));
      falsy('GPT-REV-137 C4: live service identity forbids state removal',
        cleanupMayRemoveState('', true, false));
      tru('GPT-REV-137 C4: only stop+closed-port+dead-identity allows removal',
        cleanupMayRemoveState('', true, true));
    } catch (e) {
      falsy('GPT-REV-137 opencode debug config threw', String((e && e.message) || e));
    }
  } finally {
    // ---- FAIL-CLOSED cleanup of the synthetic managed service ----
    // Lives in the OUTER finally (review finding: cleanup in the try body
    // leaked the service when setup died after startup). Order matters:
    // stop first, then PROVE it succeeded — port closed AND the captured
    // pid+creationTime identity gone — BEFORE removing state. A stop error,
    // an open port or a still-live service keeps the state for recovery.
    // Skipped when setup died before a verified seam existed (stopping with
    // the REAL environment would be forbidden).
    if (seamEnv && seamPort) {
      let stopError = '';
      try {
        execFileSync('opencode', ['service', 'stop'], { encoding: 'utf8', shell: true, env: seamEnv, timeout: 60000 });
      } catch (e) {
        stopError = String((e && e.message) || e);
      }
      eq('GPT-REV-137 cleanup: synthetic service stop exit 0', stopError, '');
      const portClosed = await waitForPortClosed(seamPort);
      tru('GPT-REV-137 cleanup: synthetic service port closed after stop', portClosed);
      // identity missing => death cannot be proven => fail-closed (state KEPT)
      const serviceGone = serviceIdentity !== null && await waitForIdentityGone(serviceIdentity);
      tru('GPT-REV-137 cleanup: synthetic service process gone (identity-checked pid+creationTime)', serviceGone);
      if (cleanupMayRemoveState(stopError, portClosed, serviceGone) && seamRoot) {
        try { rmSync(seamRoot, { recursive: true, force: true }); } catch {}
      } else {
        console.log('GPT-REV-137 cleanup: synthetic state KEPT for recovery: ' + seamRoot);
      }
    } else if (seamRoot) {
      console.log('GPT-REV-137 cleanup: no verified seam service; synthetic state KEPT: ' + seamRoot);
    }
    // outer resource guard: the mock provider dies even if setup failed midway
    if (mock) { try { await new Promise((r) => mock.server.close(r)); } catch {} }
  }
  } else {
    console.log('SKIP GPT-REV-137: opencode binary not available on PATH');
  }
}

// ---- OpenCode v2 document projection: strict fail-closed contract -------------
// Deterministic negative cases for the projection helpers (no binary needed):
// missing/duplicate project document, non-documents shape, malformed rules,
// and cross-source separation (a global document's rules never bleed into the
// project document's rule list — each source stays verbatim, order included).
{
  const projDir = path.join(TMP, 'ocneg-');
  mkdirSync(projDir, { recursive: true });
  const projPath = path.join(projDir, OPENCODE_CONFIG_FILENAME);
  const globalPath = path.join(TMP, 'ocneg-global', OPENCODE_CONFIG_FILENAME);
  const globalRules = [{ action: '*', resource: '*', effect: 'ask' }];
  const projectRules = [
    { action: 'read', resource: '*', effect: 'allow' },
    { action: 'shell', resource: '*', effect: 'allow' },
  ];
  const doc = (p, rules) => ({ type: 'document', path: p, info: { $schema: OPENCODE_CONFIG_SCHEMA, permissions: rules } });
  const throws = (name, fn) => {
    let threw = false;
    try { fn(); } catch { threw = true; }
    tru(name, threw);
  };
  throws('projection: missing project document throws',
    () => selectDebugDocument(JSON.stringify([doc(globalPath, globalRules)]), projPath));
  throws('projection: duplicate project document throws',
    () => selectDebugDocument(JSON.stringify([doc(projPath, projectRules), doc(projPath, projectRules)]), projPath));
  throws('projection: non-documents shape throws',
    () => selectDebugDocument(JSON.stringify({ permission: { bash: 'allow' } }), projPath));
  const badRules = [
    [{ action: 'read', effect: 'allow' }], // missing resource
    [{ resource: '*', effect: 'allow' }], // missing action
    [{ action: 'read', resource: '*' }], // missing effect
    [{ action: 'read', resource: '*', effect: 'grant' }], // unknown effect
    ['read'], // not an object
  ];
  for (const [i, rules] of badRules.entries()) {
    throws('projection: malformed rule #' + i + ' throws',
      () => selectDebugDocument(JSON.stringify([doc(projPath, rules)]), projPath));
  }
  // cross-source separation: each document keeps its own verbatim rule list
  // (order included); the helper selects, it never merges or reorders.
  const both = JSON.stringify([doc(globalPath, globalRules), doc(projPath, projectRules)]);
  eq('projection: global rules verbatim', JSON.stringify(selectDebugDocument(both, globalPath).permissions), JSON.stringify(globalRules));
  eq('projection: project rules verbatim (order kept, no global bleed)',
    JSON.stringify(selectDebugDocument(both, projPath).permissions), JSON.stringify(projectRules));
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
      // Issue #145 rework F1: a mutation-capable admission carries a stable
      // lane identity (the server below is booted with the matching env).
      mutationLaneId: 'lane-int',
    });
    eq('mcp-int taskStart ok', result.ok, true);
    if (result.ok) {
      const wt = path.dirname(result.openCodeConfigPath);
      writeFileSync(path.join(wt, 'BASE.md'), 'base modified', 'utf8');
      // Brand-new untracked file, created BEFORE the server boots so the
      // bounded commit (id 6) actually has something to stage + commit.
      writeFileSync(path.join(wt, 'MCP49.txt'), 'mcp bounded commit\n');
      const env = {
        ...process.env,
        SOC_SESSION_PATH: result.session.path,
        SOC_SESSION_TOKEN: result.session.leaseToken,
        SOC_CONTROL_CWD: path.resolve(repo.dir),
        SOC_LANE_ID: 'lane-int', // Issue #145: mutation-capable lane identity
      };
      const reqs = [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'soc_broker_status', arguments: {} } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'soc_broker_diff', arguments: { diffMode: 'working_tree' } } },
        { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'soc_broker_run_registered_test', arguments: { testId: 'hello' } } },
        { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'soc_broker_commit', arguments: { message: 'test: mcp bounded commit (Issue #49)', paths: ['MCP49.txt'] } } },
        { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'soc_broker_commit', arguments: { message: 'test: nothing', paths: ['rt-hello.cjs'] } } },
        { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'soc_task_progress', arguments: { repo: CANON, issueNumber: 910, executorId: 'opencode@it-1', executorKind: 'opencode', executionEpoch: 1, currentStep: 2, totalSteps: 2, steps: [{ index: 1, name: 'Inspect', status: 'COMPLETED' }, { index: 2, name: 'Implement', status: 'IN_PROGRESS' }], message: 'implementing P1-0' } } },
        { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'soc_task_progress', arguments: { repo: CANON, issueNumber: 910, executorId: 'opencode@it-1', executionEpoch: 1, currentStep: 1, totalSteps: 2, steps: [{ index: 1, name: 'Inspect', status: 'IN_PROGRESS' }, { index: 2, name: 'Implement', status: 'PENDING' }] } } },
      ].map((o) => JSON.stringify(o)).join('\n') + '\n';
      const r = spawnSync(process.execPath, [MCP_ENTRYPOINT], {
        input: reqs, cwd: wt, encoding: 'utf8', env, timeout: 60000,
      });
      eq('mcp-int exit code 0', r.status, 0);
      tru('mcp-int no stderr', !String(r.stderr || '').trim());
      const lines = String(r.stdout || '').trim().split('\n').map((l) => JSON.parse(l));
      eq('mcp-int response count', lines.length, 9);
      const byId = new Map(lines.map((l) => [l.id, l]));
      eq('mcp-int serverInfo name', byId.get(1).result.serverInfo.name, 'soc-brain-broker');
      eq('mcp-int tools length', byId.get(2).result.tools.length, 10);
      eq('mcp-int tool names', JSON.stringify(byId.get(2).result.tools.map((t) => t.name).sort()), JSON.stringify(['soc_broker_block_task', 'soc_broker_commit', 'soc_broker_diff', 'soc_broker_finish_task', 'soc_broker_recover_human_gate', 'soc_broker_request_human_gate', 'soc_broker_run_registered_test', 'soc_broker_status', 'soc_broker_submit_executor_report', 'soc_task_progress']));
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
      // Issue #49: soc_broker_commit — bounded commit over MCP on a brand-new
      // untracked file, then deterministic NOTHING_TO_COMMIT fail-closed.
      const commit = JSON.parse(byId.get(6).result.content[0].text);
      eq('mcp-int commit ok', commit.ok, true);
      if (commit.ok) {
        tru('mcp-int commit head is 40-hex', /^[0-9a-f]{40}$/.test(commit.data.head));
        eq('mcp-int commit evidence head matches worktree HEAD',
           commit.data.head,
           execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8' }).trim());
      }
      const commitEmpty = JSON.parse(byId.get(7).result.content[0].text);
      eq('mcp-int commit empty NOTHING_TO_COMMIT', commitEmpty.reason, 'NOTHING_TO_COMMIT');
      eq('mcp-int commit empty isError', byId.get(7).result.isError, true);
      // P1-0 (Issue #90): soc_task_progress telemetry over MCP — accepted, then
      // out-of-order (currentStep regression) fail-closed; canonical FSM untouched.
      const prog = JSON.parse(byId.get(8).result.content[0].text);
      eq('mcp-int progress ok', prog.ok, true);
      eq('mcp-int progress currentStep', prog.progress && prog.progress.currentStep, 2);
      eq('mcp-int progress bound to session => buildStableTaskId lowercases repo', prog.progress.taskId, 'duongpdddic-droid/soc_brain#910');
      const progBack = JSON.parse(byId.get(9).result.content[0].text);
      eq('mcp-int progress regression fail-closed', progBack.code, 'OUT_OF_ORDER_STEP');
      eq('mcp-int progress regression isError', byId.get(9).result.isError, true);
      const sess910 = JSON.parse(fs.readFileSync(result.session.path, 'utf8'));
      eq('mcp-int progress leaves FSM canonical', sess910.state, 'SESSION_ACTIVE');
    }
  } finally { if (repo) repo.dispose(); }
}

// ---- Issue #49: bounded commit capability gate is fail-closed per request ----
// A live session whose authoritative capabilities do NOT include 'commit'
// (pre-#49 grant or tampered record) must get CAPABILITY_NOT_GRANTED on
// soc_broker_commit while read-only tools keep working.
{
  let repo;
  try {
    repo = makeRepo();
    repo.commit('rt-hello.cjs', "process.stdout.write('hi')");
    const baseSha = repo.commit('BASE.md', 'base');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const result = taskStart({
      repo: CANON, issueNumber: 911, baseSha,
      worktreesRoot: TMP_ROOT, stateDir: path.join(TMP, '_state_cap'),
      controlCwd: repo.dir, testRegistry: {},
    });
    eq('cap taskStart ok', result.ok, true);
    if (result.ok) {
      // Strip the commit capability from the authoritative session record.
      const sess = JSON.parse(fs.readFileSync(result.session.path, 'utf8'));
      sess.capabilities = sess.capabilities.filter((c) => c !== 'commit');
      fs.writeFileSync(result.session.path, JSON.stringify(sess, null, 2) + '\n', 'utf8');
      const server = createMcpServer({
        config: { ok: true, sessionPath: result.session.path, leaseToken: result.session.leaseToken, controlCwd: path.resolve(repo.dir) },
      });
      eq('cap server boots', server.ok, true);
      if (server.ok) {
        const commitCall = server.dispatch({ params: { name: 'soc_broker_commit', arguments: { message: 'feat: x', paths: ['BASE.md'] } } });
        eq('cap commit denied', commitCall.reason, 'CAPABILITY_NOT_GRANTED');
        falsy('cap commit no data (no mutation)', commitCall.data);
        const statusCall = server.dispatch({ params: { name: 'soc_broker_status', arguments: {} } });
        eq('cap read-only still allowed', statusCall.ok, true);
      }
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
// #246: an unreadable/corrupt ExecutionRecord is not proof of absence. An
// otherwise-authorized control-plane mutation must not reach the FSM.
{
  const repo = makeRepo();
  try {
    const baseSha = repo.commit('READ_GATE.md', 'read gate');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issueNumber = 246246;
    const stateDir = path.join(TMP, '_state_record_read');
    const started = taskStart({ repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT,
      stateDir, controlCwd: repo.dir, mutationLaneId: 'test-lane-246' });
    eq('record-read taskStart ok', started.ok, true);
    if (started.ok) {
      const h = identityHash({ repo: CANON, issueNumber });
      const recordPath = executionRecordPath({ stateDir, identityHash: h });
      eq('record-read absent is ENOENT only', readExecutionRecord({ stateDir, repo: CANON, issueNumber }).reason, 'EXECUTION_NOT_FOUND');
      const server = createMcpServer({ config: { ok: true, sessionPath: started.session.path,
        leaseToken: started.session.leaseToken, controlCwd: path.resolve(repo.dir), laneId: 'test-lane-246' } });
      eq('record-read server boots', server.ok, true);
      if (server.ok) {
        fs.mkdirSync(recordPath, { recursive: true });
        eq('record-read directory is not absence', readExecutionRecord({ stateDir, repo: CANON, issueNumber }).reason, 'RECORD_READ_FAILED');
        const call = () => server.dispatch({ params: { name: 'soc_broker_finish_task', arguments: { outcome: 'COMPLETED' } } });
        eq('record-read mutation denied', call().reason, 'RECORD_READ_FAILED');
        fs.rmSync(recordPath, { recursive: true, force: true });
        fs.writeFileSync(recordPath, '{bad json', 'utf8');
        eq('record-corrupt mutation denied', call().reason, 'RECORD_READ_FAILED');
        eq('record-read session not terminalized', readSessionRecord(started.session.path).session.state, 'SESSION_ACTIVE');
      }
    }
  } finally { repo.dispose(); }
}

// ---- summary --------------------------------------------------------------------
const pass = checks.filter((c) => c.ok).length;
for (const c of checks) if (!c.ok) console.log('FAIL', c.name, '=>', JSON.stringify(c.got), 'want', JSON.stringify(c.want));
console.log('\nTotal: ' + pass + '/' + checks.length + ' PASS');
// Best-effort cleanup
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(pass === checks.length ? 0 : 1);
