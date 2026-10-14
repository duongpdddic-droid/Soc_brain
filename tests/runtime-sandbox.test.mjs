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
// F3 retention: a "kept for recovery" fixture must OUTLIVE the whole-file
// teardown of TMP — an unconditional rmSync(TMP) at the end silently destroyed
// every retained fixture, so the retention claim was never provable. Retained
// fixtures are therefore moved OUT of TMP into this sibling root, and the
// teardown at the end of this file asserts they still exist afterwards.
const RETAINED_ROOT = mkdtempSync(path.join(os.tmpdir(), 'soc-rs-retained-'));
const RETAINED = []; // every retained fixture path, asserted after TMP teardown
const retainFixture = (srcDir, tag) => {
  if (!srcDir) return null;
  try {
    const dest = path.join(RETAINED_ROOT, tag + '-' + path.basename(srcDir) + '-' + Date.now());
    fs.renameSync(srcDir, dest); // same volume (both under os.tmpdir())
    RETAINED.push(dest);
    return dest;
  } catch (e) {
    const kept = srcDir + ' (rename failed: ' + String((e && e.message) || e) + ')';
    RETAINED.push(srcDir); // still reported/retained at its original path
    return kept;
  }
};

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
// F3 port probe is TRI-STATE: only a completed connect is OPEN and only
// ECONNREFUSED is CLOSED. A timeout/reset/any other error is UNKNOWN — before,
// every error and every timeout resolved to `false` and was read as "closed",
// so a wedged probe could green-light state removal.
const probePort = (port, host = '127.0.0.1', timeoutMs = 2000) => new Promise((resolve) => {
  let done = false;
  const finishProbe = (state) => {
    if (done) return;
    done = true;
    try { socket.destroy(); } catch {}
    resolve(state);
  };
  const socket = net.connect({ port, host });
  socket.on('connect', () => finishProbe('OPEN'));
  socket.on('error', (e) => finishProbe(e && e.code === 'ECONNREFUSED' ? 'CLOSED' : 'UNKNOWN'));
  socket.setTimeout(timeoutMs, () => finishProbe('UNKNOWN'));
});
// Poll until CLOSED; at the deadline the LAST observed state is returned
// (OPEN / CLOSED / UNKNOWN) — never collapsed to a boolean.
const waitForPortState = async (port, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  let last = 'UNKNOWN';
  for (;;) {
    last = await probePort(port);
    if (last === 'CLOSED') return 'CLOSED';
    if (Date.now() > deadline) return last;
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
// F1 kill authorization is TRI-STATE. `!identityGone()` used to be the
// ownership proof, but `identityGone()` is false for BOTH "definitely ours and
// alive" and "cannot tell" — so an UNKNOWN probe (EPERM, timestamp failure,
// missing capture) read as "ours" and authorized a kill. The gate must be an
// explicit SAME / GONE / UNKNOWN decision:
//   SAME     — pid alive AND the revalidated creationTime matches the capture
//              (the only state that may be killed)
//   GONE     — pid dead (ESRCH) or alive with a different creationTime (reuse)
//   UNKNOWN  — anything unprovable (probe error, missing/failed timestamp,
//              no capture at all) => zero kill
const identityState = (identity) => {
  if (!identity || !identity.pid) return 'UNKNOWN'; // no capture: never SAME
  const status = processStatus(identity.pid);
  if (status === 'DEAD') return 'GONE'; // ESRCH: pid dead — proven
  if (status === 'UNKNOWN') return 'UNKNOWN'; // probe error: unprovable, fail-closed
  // ALIVE: SAME requires a captured AND revalidated creationTime
  if (!identity.startTime) return 'UNKNOWN'; // alive, unknown creationTime
  const now = queryStartTime(identity.pid);
  if (now === null) return 'UNKNOWN'; // timestamp query FAILED: never treated as reuse
  return now === identity.startTime ? 'SAME' : 'GONE'; // mismatch => reused, original dead
};
const identityGone = (identity) => identityState(identity) === 'GONE';
// Kill authorization at the kill boundary: revalidate NOW, refuse unless SAME.
const killAuthorization = (identity) => {
  const state = identityState(identity);
  return state === 'SAME'
    ? { allowed: true, state, reason: 'identity revalidated SAME (pid+creationTime match)' }
    : { allowed: false, state, reason: 'zero kill: identity ' + state + ' at kill boundary' };
};
const waitForIdentityGone = async (identity, timeoutMs = 10000, goneFn = identityGone) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (goneFn(identity)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
};
// Kill a whole spawned tree (shell + grandchildren): taskkill /T targets the
// descendant chain of the captured root pid — never a port, never a name.
// Bounded (F2): the command carries its own timeout so a wedged taskkill can
// never hang the cleanup, and the real exit/error is CAPTURED (a bare
// resolve(true) swallowed every taskkill failure).
const KILL_COMMAND_TIMEOUT_MS = 10000;
const killTree = (pid, timeoutMs = KILL_COMMAND_TIMEOUT_MS) => new Promise((resolve) => {
  if (!pid) { resolve({ ok: false, error: 'killTree: no root pid' }); return; }
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: timeoutMs }, (err, _out, stderr) => {
    if (err) {
      const bounded = Boolean(err.killed || err.code === 'ETIMEDOUT');
      resolve({ ok: false, bounded, error: bounded ? ('kill command bounded out after ' + timeoutMs + 'ms') : String((err && err.message) || err), stderr: String(stderr || '') });
    } else resolve({ ok: true, bounded: false, stderr: String(stderr || '') });
  });
});
// Pure parser for the Win32_Process snapshot: null = the snapshot itself is
// missing/unparsable (discovery FAILURE / UNKNOWN) — an empty stdout used to be
// returned as `[]`, i.e. a free "no descendants" proof. A valid snapshot with
// real rows but no children of the root is the only thing that yields `[]`.
const parseProcessTable = (out) => {
  if (!out || !String(out).trim()) return null; // empty output: failure, never proof
  let parsed;
  try { parsed = JSON.parse(out); } catch { return null; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (rows.length === 0) return null; // "no processes at all" is not a valid snapshot
  return rows;
};
// Live descendants of a root pid, from the current Win32_Process table (every
// enumerated record is a LIVE process; children are found by walking the
// ParentProcessId chain). null = the enumeration itself failed (UNKNOWN).
const walkDescendants = (rootPid, rows) => {
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
};
const listLiveDescendantPids = (rootPid) => {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
    { encoding: 'utf8', timeout: 15000 }).trim();
    const rows = parseProcessTable(out);
    if (rows === null) return null;
    return walkDescendants(rootPid, rows);
  } catch { return null; }
};
// Async variant (F2): descendant sampling must never block this process' event
// loop — the mock provider serves model requests from THIS process.
const listLiveDescendantPidsAsync = (rootPid) => new Promise((resolve) => {
  execFile('powershell', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
  { encoding: 'utf8', timeout: 15000 }, (err, stdout) => {
    if (err) { resolve(null); return; } // enumeration failed => UNKNOWN
    const rows = parseProcessTable(String(stdout || '').trim());
    resolve(rows === null ? null : walkDescendants(rootPid, rows));
  });
});
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
// ---- F3: managed-service acquisition with ownership-before-start -------------
// start-attempt/resource ownership is recorded BEFORE `service set port` (and
// therefore before the start-capable `debug config`) so a startup throw or
// timeout still hands the caller enough state to reconcile the resource it may
// have created. Never returns half-owned state without `attemptPort`.
const acquireSeamService = ({ seamEnv, seamRoot, maxAttempts = 5, deps = {} }) => {
  const exec = deps.exec || execFileSync;
  const listenPid = deps.listenPid || netstatListenPid;
  const pickPort = deps.pickPort || (() => 20000 + Math.floor(Math.random() * 20000));
  const queryStart = deps.queryStartTime || queryStartTime;
  const out = { ok: false, port: null, attemptPort: null, identity: null, failure: 'not attempted', attempts: 0, startAttempts: [] };
  for (let attempt = 0; attempt < maxAttempts && out.port === null; attempt += 1) {
    out.attempts = attempt + 1;
    const candidate = pickPort();
    if (listenPid(candidate) !== null) { out.failure = 'candidate already listening: ' + candidate; continue; }
    out.attemptPort = candidate; // OWNERSHIP FIRST — before any mutating command
    try {
      exec('opencode', ['service', 'set', 'port', String(candidate)], { encoding: 'utf8', shell: true, env: seamEnv, timeout: 60000 });
      out.startAttempts.push(candidate);
      if (deps.startService) deps.startService(candidate); // injected start boundary
      else exec('opencode', ['debug', 'config'], { cwd: seamRoot, encoding: 'utf8', shell: true, env: seamEnv, timeout: 90000 });
      out.port = candidate;
    } catch (e) {
      const msg = String((e && e.stderr) || (e && e.message) || '');
      if (msg.includes('already in use')) { out.failure = 'port stolen before bind: ' + candidate; continue; }
      out.failure = 'startup failed: ' + msg.slice(0, 300);
      return out; // attemptPort retained: the caller must still reconcile
    }
  }
  if (out.port === null) {
    if (out.failure === 'not attempted') out.failure = 'no service port after ' + maxAttempts + ' attempts';
    return out;
  }
  // Identity captured IMMEDIATELY after startup — before any later probe can
  // churn the process table — so cleanup can PROVE this exact {pid,
  // creationTime} died instead of trusting a closed port.
  const pid = listenPid(out.port);
  out.identity = pid ? { pid, startTime: queryStart(pid) } : null;
  out.ok = true;
  return out;
};
// ---- F3/F4: fail-closed synthetic-service cleanup (testable helper) ----------
// The real finally calls this with REAL OS deps; the negative cases inject
// stop/probe/identity faults at the OS boundary. State may only be removed
// when the stop exited clean AND the port is provably CLOSED AND the service
// identity is provably GONE — every dirty dimension keeps the state.
const cleanupMayRemoveState = (stopError, portClosed, serviceGone) => stopError === '' && portClosed && serviceGone;
const cleanupSyntheticService = async ({ seamEnv, seamPort, startAttemptPort, serviceIdentity, seamRoot, deps = {} }) => {
  const stop = deps.stop || ((env) => execFileSync('opencode', ['service', 'stop'], { encoding: 'utf8', shell: true, env, timeout: 60000 }));
  const portProbe = deps.probePort || waitForPortState;
  const goneFn = deps.identityGone || identityGone;
  const remove = deps.remove || rmSync;
  const out = { stopAttempted: false, stopError: '', portState: 'UNKNOWN', serviceGone: false, removed: false, reconcilePort: null, removeError: '' };
  // Reconcile the OWNED resource even when startup never verified a port —
  // attemptPort-only ownership (startup threw/timeout) still gets a stop.
  const reconcilePort = seamPort !== null && seamPort !== undefined ? seamPort : startAttemptPort;
  out.reconcilePort = reconcilePort;
  if (!seamEnv || reconcilePort === null || reconcilePort === undefined) {
    out.stopError = 'no owned resource';
    return out;
  }
  out.stopAttempted = true;
  try { await stop(seamEnv); } catch (e) { out.stopError = String((e && e.message) || e); }
  out.portState = await portProbe(reconcilePort);
  out.serviceGone = serviceIdentity !== null && serviceIdentity !== undefined
    && await waitForIdentityGone(serviceIdentity, 10000, goneFn);
  if (cleanupMayRemoveState(out.stopError, out.portState === 'CLOSED', out.serviceGone) && seamRoot) {
    try { remove(seamRoot, { recursive: true, force: true }); out.removed = true; }
    catch (e) { out.removeError = String((e && e.message) || e); }
  }
  return out;
};
// F3: the mock provider cleanup must run even when the service cleanup throws
// (a throw inside the finally used to skip everything after it).
const runCleanupSequence = async ({ serviceCleanup, mockCleanup }) => {
  const out = { serviceRan: false, serviceError: '', mockRan: false, mockError: '' };
  try {
    try { await serviceCleanup(out); out.serviceRan = true; }
    catch (e) { out.serviceError = String((e && e.message) || e); }
  } finally {
    try { await mockCleanup(out); out.mockRan = true; }
    catch (e) { out.mockError = String((e && e.message) || e); }
  }
  return out;
};
// ---- F1/F2: bounded, identity-tracked tree lifecycle -------------------------
// ONE lifecycle helper used by BOTH the real precedence probes and the F4
// negative cases (the negatives inject faults into THIS helper — no second
// framework). Contract:
//  * KILL AUTHORIZATION (F1): tri-state SAME/GONE/UNKNOWN revalidated AT the
//    kill boundary; only SAME may run taskkill, GONE/UNKNOWN => zero kill and
//    the refusal recorded in `killGate` (never `!identityGone()`).
//  * DESCENDANTS (F2): identities are sampled only while the ownership
//    relation is provable (root SAME) and are KEPT after the ancestor exits;
//    a tree-clean claim additionally needs a non-UNKNOWN discovery snapshot
//    whose live set is empty — an empty/failed snapshot is never proof.
//  * BOUNDS (F2): the kill deadline is armed BEFORE the kill command, the kill
//    command is bounded, cleanup is serialized (first finisher wins) and NO
//    timer may be created after settle (`postSettleTimers` must stay 0).
const runManagedTree = (spec) => new Promise((resolve) => {
  const {
    command, args, cwd = null, env = process.env, shell = false,
    timeoutMs = 120000, killDeadlineMs = 15000, treeGoneTimeoutMs = 15000,
    trackIntervalMs = 2000, reads = () => [], retainDir = null, retainTag = 'probe',
    deps = {},
  } = spec;
  const kill = deps.kill || killTree;
  const listDescendants = deps.listDescendants || listLiveDescendantPidsAsync;
  const idState = deps.identityState || identityState;
  const captureId = deps.captureIdentity || captureProcessIdentity;
  const child = spawn(command, args, { cwd, env, shell, stdio: ['ignore', 'pipe', 'pipe'] });
  const identity = captureId(child.pid);
  const startMs = Date.now();
  const descendants = new Map(); // pid -> identity, KEPT even after ancestor exit
  const result = {
    rootPid: child.pid, code: null, signal: null, spawnError: '',
    timedOut: false, stdout: '', stderr: '', reads: [],
    identityCaptured: identity !== null, rootState: 'UNKNOWN',
    killGate: { allowed: false, state: 'UNKNOWN', attempted: false, refused: false, reason: '' },
    killRecord: { attempted: false, ok: false, error: '' },
    descendantCount: 0, descendantStates: [], descendantIdentities: [],
    discovery: 'UNKNOWN', treeReason: 'NOT_EVALUATED',
    cleanupVerified: false, retainedPath: null,
    settleCount: 0, postSettleTimers: 0, timersArmed: 0, timersCleared: 0,
    timersActiveAfterSettle: -1,
    elapsedMs: 0, finishedBy: '',
  };
  const activeTimers = new Map(); // handle -> clear fn
  const armTimeout = (fn, ms) => {
    if (result.settleCount > 0) { result.postSettleTimers += 1; return null; } // F2: never after settle
    result.timersArmed += 1;
    const h = setTimeout(() => { activeTimers.delete(h); fn(); }, ms);
    activeTimers.set(h, () => clearTimeout(h));
    return h;
  };
  const armInterval = (fn, ms) => {
    if (result.settleCount > 0) { result.postSettleTimers += 1; return null; }
    result.timersArmed += 1;
    const clearFn = () => clearInterval(h);
    const h = setInterval(() => { fn(); }, ms);
    activeTimers.set(h, clearFn);
    return h;
  };
  let settledFlag = false; // settle() done
  let finishing = false; // a settle() is in flight (serialized)
  let stdout = '';
  let stderr = '';
  let timer = null;
  let hardTimer = null;
  let tracker = null;
  let sampling = false;
  // Sample descendants only while the ownership relation is provable (root
  // SAME); a failed capture is stored as {startTime:null} and stays UNKNOWN
  // until re-proven — identities are never dropped, even after ancestor exit.
  const sampleDescendants = async () => {
    if (sampling || settledFlag) return;
    sampling = true;
    try {
      const live = await listDescendants(child.pid);
      if (live === null) return; // discovery UNKNOWN: never recorded as "no descendants"
      for (const pid of live) {
        if (descendants.has(pid)) continue;
        const id = captureId(pid);
        descendants.set(pid, id || { pid, startTime: null });
      }
    } catch { /* fail-closed: re-checked as UNKNOWN in evaluateTree */ }
    finally { sampling = false; }
  };
  const evaluateTree = async () => {
    const rootState = idState(identity);
    result.rootState = rootState;
    if (rootState !== 'GONE') return { clean: false, reason: 'ROOT_' + rootState, discovery: 'SKIPPED' };
    const live = await listDescendants(child.pid);
    if (live === null) return { clean: false, reason: 'DISCOVERY_UNKNOWN', discovery: 'UNKNOWN' };
    const states = [];
    for (const d of descendants.values()) {
      const st = idState(d);
      states.push({ pid: d.pid, state: st });
      if (st === 'UNKNOWN') return { clean: false, reason: 'DESC_UNKNOWN:' + d.pid, discovery: live.length === 0 ? 'EMPTY' : 'NONEMPTY', states };
      if (st === 'SAME') return { clean: false, reason: 'DESC_ALIVE:' + d.pid, discovery: live.length === 0 ? 'EMPTY' : 'NONEMPTY', states };
    }
    if (live.length > 0) return { clean: false, reason: 'DISCOVERY_NONEMPTY', discovery: 'NONEMPTY', states };
    return { clean: true, reason: '', discovery: 'EMPTY', states };
  };
  const settle = async (code, signal, spawnError, finishedBy) => {
    // Serialized: exactly one finish path runs (close vs kill-deadline races).
    if (settledFlag || finishing) return false;
    finishing = true;
    result.code = code;
    result.signal = signal;
    result.spawnError = spawnError || '';
    result.finishedBy = finishedBy;
    const deadline = Date.now() + treeGoneTimeoutMs;
    let ev = { clean: false, reason: 'NOT_EVALUATED', discovery: 'UNKNOWN' };
    for (;;) {
      ev = await evaluateTree();
      if (ev.clean || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    result.treeReason = ev.reason;
    result.discovery = ev.discovery;
    result.descendantCount = descendants.size;
    result.descendantIdentities = [...descendants.values()];
    result.descendantStates = ev.states || result.descendantIdentities.map((d) => ({ pid: d.pid, state: idState(d) }));
    result.cleanupVerified = Boolean(identity !== null && ev.clean);
    result.reads = reads();
    result.stdout = stripAnsi(stdout);
    result.stderr = stripAnsi(stderr);
    result.elapsedMs = Date.now() - startMs;
    // settle: clear EVERY armed timer/interval — nothing may dangle
    settledFlag = true;
    result.settleCount += 1;
    for (const [h, clear] of [...activeTimers]) { clear(); activeTimers.delete(h); result.timersCleared += 1; }
    result.timersActiveAfterSettle = activeTimers.size; // must be 0
    // retention: an unverified fixture is MOVED out of TMP so it survives the
    // whole-file teardown; a verified one is removed.
    if (retainDir && fs.existsSync(retainDir)) {
      if (result.cleanupVerified) { try { rmSync(retainDir, { recursive: true, force: true }); } catch {} }
      else {
        result.retainedPath = retainFixture(retainDir, retainTag);
        console.log('probe: fixture KEPT for recovery: ' + result.retainedPath);
      }
    }
    resolve(result);
    return true;
  };
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('error', (e) => { void settle(null, null, String((e && e.message) || e), 'spawn-error'); });
  child.on('close', (code, signal) => { void settle(code, signal, '', 'close'); });
  timer = armTimeout(() => {
    result.timedOut = true;
    const gate = killAuthorization(identity); // F1: revalidate AT the kill boundary
    result.killGate = { allowed: gate.allowed, state: gate.state, attempted: false, refused: !gate.allowed, reason: gate.reason };
    if (!gate.allowed) {
      void settle(null, 'KILL_REFUSED_' + gate.state, '', 'kill-refused'); // zero kill
      return;
    }
    // F2: arm the hard deadline BEFORE the kill, then issue a bounded kill.
    hardTimer = armTimeout(() => { void settle(null, 'TIMEOUT_UNKILLED', '', 'kill-deadline'); }, killDeadlineMs);
    void sampleDescendants(); // last sample while the relation is still provable
    result.killGate.attempted = true;
    const done = (kr) => {
      result.killRecord = { attempted: true, ok: Boolean(kr && kr.ok), error: (kr && kr.error) || '' };
      // NO timer is armed here: a callback landing after settle must not create
      // one (armTimeout would count it into postSettleTimers).
    };
    try {
      const p = kill(child.pid);
      if (p && typeof p.then === 'function') p.then(done).catch((e) => done({ ok: false, error: String((e && e.message) || e) }));
      else done(p);
    } catch (e) { done({ ok: false, error: String((e && e.message) || e) }); }
  }, timeoutMs);
  tracker = armInterval(() => { void sampleDescendants(); }, trackIntervalMs);
});
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

// ---- F1: kill authorization is tri-state (unit level, no child needed) -------
{
  const ownLive = captureProcessIdentity(process.pid);
  eq('F1 identityState: our own live process revalidates SAME', identityState(ownLive), 'SAME');
  eq('F1 identityState: reused pid (creationTime mismatch) reads GONE',
    identityState({ pid: process.pid, startTime: '2000-01-01 00:00:00' }), 'GONE');
  eq('F1 identityState: alive with unknown creationTime reads UNKNOWN',
    identityState({ pid: process.pid, startTime: null }), 'UNKNOWN');
  eq('F1 identityState: missing capture reads UNKNOWN', identityState(null), 'UNKNOWN');
  tru('F1 killAuthorization allows ONLY a revalidated SAME identity',
    killAuthorization(ownLive).allowed === true);
  falsy('F1 killAuthorization refuses GONE (reused pid => zero kill)',
    killAuthorization({ pid: process.pid, startTime: '2000-01-01 00:00:00' }).allowed);
  falsy('F1 killAuthorization refuses UNKNOWN (unprovable => zero kill)',
    killAuthorization({ pid: process.pid, startTime: null }).allowed);
  falsy('F1 killAuthorization refuses missing capture (zero kill)',
    killAuthorization(null).allowed);
  // Why `!identityGone()` can never be an ownership proof: for an UNKNOWN probe
  // it evaluates to TRUE while ownership is completely unproven.
  tru('F1: !identityGone(UNKNOWN) is true while ownership is unproven (the old proof was invalid)',
    !identityGone({ pid: process.pid, startTime: null })
    && identityState({ pid: process.pid, startTime: null }) === 'UNKNOWN'
    && killAuthorization({ pid: process.pid, startTime: null }).allowed === false);
  // Bounded kill command: a failing/invalid taskkill must be CAPTURED, never
  // swallowed as success, and must not hang past its bound.
  const killStart = Date.now();
  const badKill = await killTree('not-a-pid');
  falsy('F1 killTree on an invalid pid records ok=false (failure captured)', badKill.ok);
  tru('F1 killTree error string is populated', typeof badKill.error === 'string' && badKill.error.length > 0);
  tru('F1 killTree returns bounded (no hang)', Date.now() - killStart < 15000);
}

// ---- F2: discovery snapshot semantics (pure parser + real enumeration) -------
{
  eq('F2: empty discovery output is UNKNOWN (null), never an empty proof',
    parseProcessTable(''), null);
  eq('F2: whitespace-only discovery output is UNKNOWN', parseProcessTable('   \n'), null);
  eq('F2: unparsable discovery output is UNKNOWN', parseProcessTable('not-json{{{'), null);
  eq('F2: structurally empty JSON table is UNKNOWN (a live process table is never empty)',
    parseProcessTable('[]'), null);
  const rows = parseProcessTable('[{"ProcessId":10,"ParentProcessId":4},'
    + '{"ProcessId":20,"ParentProcessId":10},{"ProcessId":30,"ParentProcessId":20}]');
  tru('F2: valid snapshot with rows parses to an array', Array.isArray(rows) && rows.length === 3);
  eq('F2: descendant walk follows the ParentProcessId chain',
    JSON.stringify(walkDescendants(10, rows)), JSON.stringify([20, 30]));
  eq('F2: a valid snapshot with no children yields EMPTY (not UNKNOWN)',
    JSON.stringify(walkDescendants(999, rows)), '[]');
  const liveSnap = listLiveDescendantPids(process.pid);
  tru('F2: real machine returns a valid (array) snapshot — null would be discovery UNKNOWN',
    Array.isArray(liveSnap));
}

// ---- F3: port probe tri-state (OPEN / CLOSED / UNKNOWN) ---------------------
{
  const srv = net.createServer();
  const openPort = await new Promise((res) => { srv.listen(0, '127.0.0.1', () => res(srv.address().port)); });
  eq('F3 probePort: listening port reads OPEN', await probePort(openPort), 'OPEN');
  await new Promise((res) => srv.close(res));
  eq('F3 probePort: released loopback port reads CLOSED (ECONNREFUSED only)',
    await probePort(openPort), 'CLOSED');
  eq('F3 probePort: unroutable target reads UNKNOWN (timeout/error is never CLOSED)',
    await probePort(81, '192.0.2.1', 700), 'UNKNOWN');
}

// ---- F3: acquisition records ownership BEFORE the start-capable command ------
{
  const calls = [];
  const acqThrow = acquireSeamService({
    seamEnv: {}, seamRoot: TMP, maxAttempts: 3,
    deps: {
      listenPid: () => null,
      pickPort: (() => { let n = 46000; return () => (n += 1); })(),
      exec: (cmd, argv) => { calls.push(argv.join(' ')); },
      startService: () => { throw new Error('BOOT_TIMEOUT at start boundary'); },
    },
  });
  eq('F3 acquire: startup throw fails the acquisition', acqThrow.ok, false);
  eq('F3 acquire: start-attempt ownership recorded BEFORE the failing start',
    acqThrow.attemptPort, 46001);
  tru('F3 acquire: set-port ran before the start-capable command',
    calls[0] === 'service set port 46001');
  falsy('F3 acquire: no verified port claimed after startup failure', acqThrow.port);
  tru('F3 acquire: failure text preserved for the handoff',
    String(acqThrow.failure).includes('BOOT_TIMEOUT'));
  // Collision path retries bounded and never accepts a stolen port.
  // The injected service comes alive on the port it actually started on, so
  // the post-start identity capture sees a listening owner (probe evidence:
  // a listenPid that only knew the foreign 47001 left identity null and the
  // "captured identity" check failed).
  let startedOn = null;
  const acqStolen = acquireSeamService({
    seamEnv: {}, seamRoot: TMP, maxAttempts: 2,
    deps: {
      listenPid: (p) => (p === 47001 ? 42 : (p === startedOn ? 77 : null)),
      pickPort: (() => { let n = 47000; return () => (n += 1); })(),
      exec: () => {},
      startService: (p) => { startedOn = p; },
      queryStartTime: () => 'start',
    },
  });
  eq('F3 acquire: occupied candidate skipped, next attempt used', acqStolen.attempts, 2);
  eq('F3 acquire: the occupied candidate never received a start command',
    JSON.stringify(acqStolen.startAttempts), JSON.stringify([47002]));
  tru('F3 acquire: collision-free candidate verified and captured identity',
    acqStolen.ok === true && acqStolen.port === 47002
    && acqStolen.identity !== null && acqStolen.identity.pid === 77);
}

// ---- F3/F4: cleanup fault injection at the OS boundary ----------------------
{
  const mkState = (tag) => mkdtempSync(path.join(TMP, tag + '-'));
  // (a) stop failure => state retained even with a closed port and dead identity
  {
    const dir = mkState('n8a');
    const r = await cleanupSyntheticService({
      seamEnv: { FAKE: '1' }, seamPort: 41234, startAttemptPort: 41234,
      serviceIdentity: { pid: 1, startTime: 'x' }, seamRoot: dir,
      deps: { stop: async () => { throw new Error('stop boom'); },
        probePort: async () => 'CLOSED', identityGone: () => true },
    });
    tru('F3-N8a: stop attempted on the owned port', r.stopAttempted && r.reconcilePort === 41234);
    tru('F3-N8a: stop failure recorded, never swallowed', r.stopError.includes('stop boom'));
    falsy('F3-N8a: stop failure forbids state removal', r.removed);
    tru('F3-N8a: state retained on disk after stop failure', fs.existsSync(dir));
    rmSync(dir, { recursive: true, force: true });
  }
  // (b) port UNKNOWN => retained (an unresolved probe is never CLOSED)
  {
    const dir = mkState('n8b');
    const r = await cleanupSyntheticService({
      seamEnv: { FAKE: '1' }, seamPort: 41235, startAttemptPort: 41235,
      serviceIdentity: { pid: 1, startTime: 'x' }, seamRoot: dir,
      deps: { stop: async () => {}, probePort: async () => 'UNKNOWN', identityGone: () => true },
    });
    eq('F3-N8b: port state observed UNKNOWN', r.portState, 'UNKNOWN');
    falsy('F3-N8b: port UNKNOWN forbids state removal', r.removed);
    tru('F3-N8b: state retained on port UNKNOWN', fs.existsSync(dir));
    rmSync(dir, { recursive: true, force: true });
  }
  // (c) live/unprovable service identity => retained
  {
    const dir = mkState('n8c');
    const r = await cleanupSyntheticService({
      seamEnv: { FAKE: '1' }, seamPort: 41236, startAttemptPort: 41236,
      serviceIdentity: { pid: 1, startTime: 'x' }, seamRoot: dir,
      deps: { stop: async () => {}, probePort: async () => 'CLOSED', identityGone: () => false },
    });
    falsy('F3-N8c: live service identity forbids state removal', r.removed && r.serviceGone);
    tru('F3-N8c: state retained while identity unproven', fs.existsSync(dir));
    rmSync(dir, { recursive: true, force: true });
  }
  // (d) clean control => removed (proves the gate is not a blanket deny)
  {
    const dir = mkState('n8d');
    const r = await cleanupSyntheticService({
      seamEnv: { FAKE: '1' }, seamPort: 41237, startAttemptPort: 41237,
      serviceIdentity: { pid: 1, startTime: 'x' }, seamRoot: dir,
      deps: { stop: async () => {}, probePort: async () => 'CLOSED', identityGone: () => true },
    });
    tru('F3-N8d clean control: stop clean + port CLOSED + identity gone',
      r.stopError === '' && r.portState === 'CLOSED' && r.serviceGone);
    tru('F3-N8d clean control: state removed', r.removed && !fs.existsSync(dir));
  }
  // (e) startup-throw ownership: attemptPort-only still reconciles (stop runs)
  {
    const dir = mkState('n8e');
    const stops = [];
    const r = await cleanupSyntheticService({
      seamEnv: { FAKE: '1' }, seamPort: null, startAttemptPort: 48001,
      serviceIdentity: null, seamRoot: dir,
      deps: { stop: async (env) => { stops.push('stop'); }, probePort: async () => 'UNKNOWN',
        identityGone: () => false },
    });
    eq('F3-N8e: reconcile target is the owned attemptPort', r.reconcilePort, 48001);
    tru('F3-N8e: startup-owned resource still reconciled (stop issued once)', stops.length === 1);
    falsy('F3-N8e: no removal while identity unproven after startup failure', r.removed);
    tru('F3-N8e: state retained after startup failure', fs.existsSync(dir));
    rmSync(dir, { recursive: true, force: true });
  }
  // (f) no owned resource at all => no stop, explicit reason
  {
    const r = await cleanupSyntheticService({
      seamEnv: null, seamPort: null, startAttemptPort: null,
      serviceIdentity: null, seamRoot: null,
      deps: { stop: async () => { throw new Error('must not run'); } },
    });
    falsy('F3-N8f: no stop attempted when nothing is owned', r.stopAttempted);
    eq('F3-N8f: explicit no-owned-resource reason', r.stopError, 'no owned resource');
  }
}

// ---- F3: service cleanup errors never skip the mock provider cleanup ---------
{
  let mockRan = false;
  const seq = await runCleanupSequence({
    serviceCleanup: async () => { throw new Error('service cleanup boom'); },
    mockCleanup: async () => { mockRan = true; },
  });
  tru('F3-N9: service cleanup error captured', seq.serviceError.includes('service cleanup boom'));
  tru('F3-N9: mock provider cleanup STILL ran despite the service cleanup throw',
    seq.mockRan && mockRan);
  const seqOk = await runCleanupSequence({
    serviceCleanup: async () => {}, mockCleanup: async () => {},
  });
  tru('F3-N9 clean control: both sides ran without error',
    seqOk.serviceRan && seqOk.mockRan && seqOk.serviceError === '' && seqOk.mockError === '');
}

// ---- F4: lifecycle negatives on REAL children (faults injected into the one
// shared runManagedTree helper — no second framework) --------------------------
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const gate = (r) => r.code === 0 && r.spawnError === '' && !r.timedOut && r.cleanupVerified;

  // N1: marker + NONZERO exit — the gate must reject it even though the marker
  // travelled and the tree cleanup was perfectly clean.
  {
    const n1 = await runManagedTree({
      command: process.execPath,
      args: ['-e', "process.stdout.write('N1_MARKER'); process.exit(7)"],
      timeoutMs: 30000, treeGoneTimeoutMs: 5000, trackIntervalMs: 400,
    });
    eq('F4-N1: real child nonzero exit recorded', n1.code, 7);
    tru('F4-N1: marker travelled from the real child', n1.stdout.includes('N1_MARKER'));
    tru('F4-N1: lifecycle otherwise clean (tree proven gone)', n1.cleanupVerified);
    falsy('F4-N1: gate rejects marker+nonzero', gate(n1));
    eq('F4-N1: settle serialized (exactly once)', n1.settleCount, 1);
    eq('F4-N1: no timer armed after settle', n1.postSettleTimers, 0);
    eq('F4-N1: no timer left active after settle', n1.timersActiveAfterSettle, 0);
  }

  // N2: marker + TIMEOUT — authorized kill (SAME revalidated at the boundary),
  // bounded completion, tree proven gone, timer accounting clean.
  {
    const n2 = await runManagedTree({
      command: process.execPath,
      args: ['-e', "process.stdout.write('N2_MARKER'); setTimeout(() => {}, 60000);"],
      timeoutMs: 1200, killDeadlineMs: 8000, treeGoneTimeoutMs: 5000, trackIntervalMs: 400,
    });
    tru('F4-N2: marker travelled before the timeout', n2.stdout.includes('N2_MARKER'));
    tru('F4-N2: timeout recorded', n2.timedOut);
    tru('F4-N2: kill authorized at the boundary (identity revalidated SAME)',
      n2.killGate.allowed === true && n2.killGate.state === 'SAME' && n2.killGate.attempted);
    tru('F4-N2: bounded kill issued and succeeded', n2.killRecord.attempted && n2.killRecord.ok);
    tru('F4-N2: bounded completion with tree proven gone',
      n2.elapsedMs < 20000 && n2.cleanupVerified && n2.finishedBy === 'close');
    eq('F4-N2: settle serialized (exactly once)', n2.settleCount, 1);
    eq('F4-N2: no timer armed after settle', n2.postSettleTimers, 0);
    eq('F4-N2: no timer left active after settle', n2.timersActiveAfterSettle, 0);
  }

  // N3: intermediate exit with a LIVE grandchild — never tree-clean, the
  // descendant identity captured while ownership was provable is KEPT after
  // the ancestor exits, and only a revalidated SAME identity may be killed.
  {
    // The ancestor MUST outlive at least one full PowerShell descendant
    // enumeration (~1.5-2s) — a 1500ms lifetime let `close` win every race and
    // the captured set stayed empty (probe evidence: N3 crashed on
    // `kept.pid` with zero sampled descendants). 8000ms gives ~3-4 sampling
    // passes while the ownership relation is still provable.
    const n3dir = mkdtempSync(path.join(TMP, 'n3-'));
    const n3 = await runManagedTree({
      command: process.execPath,
      args: ['-e',
        "const {spawn}=require('node:child_process');"
        + "spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore',detached:true});"
        + 'setTimeout(() => process.exit(0), 8000);'],
      retainDir: n3dir, retainTag: 'n3',
      timeoutMs: 30000, treeGoneTimeoutMs: 2500, trackIntervalMs: 400,
    });
    tru('F4-N3: ancestor exited on its own', n3.code === 0 && !n3.timedOut);
    falsy('F4-N3: NO tree-clean claim while the grandchild lives', n3.cleanupVerified);
    tru('F4-N3: reason names the live descendant or a non-empty discovery',
      /^(DESC_ALIVE|DESC_UNKNOWN|DISCOVERY_NONEMPTY)/.test(n3.treeReason));
    tru('F4-N3: descendant identity captured while the relation was provable',
      n3.descendantIdentities.length >= 1);
    const kept = n3.descendantIdentities.find((d) => identityState(d) === 'SAME');
    tru('F4-N3: descendant identity KEPT after ancestor exit (still SAME)',
      kept !== undefined);
    // Ownership proof for the kill: revalidate NOW at our own kill boundary.
    // Guarded so a capture failure degrades to recorded FAILs instead of
    // an uncaught TypeError that destroys the rest of the run's evidence.
    if (kept !== undefined) {
      const gate3 = killAuthorization(kept);
      tru('F4-N3: kill authorized only after revalidation of the captured identity',
        gate3.allowed && gate3.state === 'SAME');
      const kr3 = await killTree(kept.pid);
      tru('F4-N3: authorized kill of the retained grandchild succeeds', kr3.ok);
      tru('F4-N3: grandchild proven gone after the authorized kill',
        await waitForIdentityGone(kept, 10000));
    }
    tru('F4-N3: unverified fixture retained OUTSIDE TMP', n3.retainedPath !== null
      && fs.existsSync(n3.retainedPath));
    falsy('F4-N3: original fixture dir removed from TMP after retention', fs.existsSync(n3dir));
  }

  // N4: kill HANG — the hard deadline is armed BEFORE the kill, so a wedged
  // kill cannot outlive it; completion stays bounded and honest (not clean).
  {
    const n4dir = mkdtempSync(path.join(TMP, 'n4-'));
    const n4Start = Date.now();
    const n4 = await runManagedTree({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000);'],
      retainDir: n4dir, retainTag: 'n4',
      timeoutMs: 700, killDeadlineMs: 1500, treeGoneTimeoutMs: 1000, trackIntervalMs: 400,
      deps: { kill: () => new Promise(() => {}) }, // injected: taskkill never returns
    });
    const n4ms = Date.now() - n4Start;
    eq('F4-N4: completed on the kill deadline armed before the kill',
      n4.finishedBy, 'kill-deadline');
    tru('F4-N4: bounded completion despite the hung kill', n4ms < 15000 && n4.settleCount === 1);
    tru('F4-N4: kill was authorized and issued at the boundary', n4.killGate.attempted);
    falsy('F4-N4: honest — child still alive so cleanup is NOT verified', n4.cleanupVerified);
    tru('F4-N4: fixture retained (not silently deleted)', n4.retainedPath !== null
      && fs.existsSync(n4.retainedPath));
    eq('F4-N4: no timer armed after settle', n4.postSettleTimers, 0);
    // Reclaim OUR survivor: revalidate identity, then a real bounded kill.
    const alive = captureProcessIdentity(n4.rootPid);
    eq('F4-N4: survivor still the SAME identity we spawned', identityState(alive), 'SAME');
    const reclaim = await killTree(n4.rootPid);
    tru('F4-N4: reclaim kill succeeded', reclaim.ok);
    tru('F4-N4: survivor proven gone after reclaim',
      await waitForIdentityGone(alive, 10000));
    rmSync(n4dir, { recursive: true, force: true });
  }

  // N5: close lands BEFORE the kill callback - exactly one settle, the late
  // callback is recorded, and it must not arm any timer after settle.
  // Timing must clear two real-machine costs: the synchronous PowerShell
  // identity capture runs BEFORE the timer is armed and blocks the event loop
  // (probe evidence under load: >3.4s - a 4000ms child closed first, the
  // timer was cleared at settle and timedOut/killRecord read false). Child
  // lifetime 10000ms exceeds capture+timeout for any capture <9.4s, while the
  // 10s kill delay puts the callback (capture+600+10000) strictly AFTER the
  // 10s close for every capture >= 0, so close-before-callback always holds.
  {
    const n5dir = mkdtempSync(path.join(TMP, 'n5-'));
    const n5 = await runManagedTree({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10000);'],
      retainDir: n5dir, retainTag: 'n5',
      timeoutMs: 600, killDeadlineMs: 15000, treeGoneTimeoutMs: 3000, trackIntervalMs: 400,
      deps: { kill: () => new Promise((res) => setTimeout(() => res({ ok: true, error: '' }), 10000)) },
    });
    tru('F4-N5: timeout fired and the kill was issued before the child exited',
      n5.timedOut && n5.killGate.attempted);
    tru('F4-N5: child exited by itself and the tree was proven clean',
      n5.code === 0 && n5.cleanupVerified);
    tru('F4-N5: clean run removes its fixture (no false retention)', n5.retainedPath === null);
    // The late callback lands at (capture + 600 + 10000) while `resolve` fires
    // at the 10000ms close; a shorter sleep would assert BEFORE the callback
    // and re-create the false "swallowed" reading (probe evidence). 12000ms
    // covers capture up to ~9.4s worst case.
    await sleep(12000); // let the late kill callback land after settle
    eq('F4-N5: exactly one settle despite close-before-kill-callback', n5.settleCount, 1);
    eq('F4-N5: no timer armed after settle (late callback arms nothing)',
      n5.postSettleTimers, 0);
    eq('F4-N5: no timer left active after settle', n5.timersActiveAfterSettle, 0);
    tru('F4-N5: late kill callback still recorded, never swallowed',
      n5.killRecord.attempted === true && n5.killRecord.ok === true);
  }

  // N6: discovery FAILURE — UNKNOWN is never proof; no clean claim, retained.
  {
    const n6dir = mkdtempSync(path.join(TMP, 'n6-'));
    const n6 = await runManagedTree({
      command: process.execPath,
      args: ['-e', "process.stdout.write('N6');"],
      retainDir: n6dir, retainTag: 'n6',
      timeoutMs: 30000, treeGoneTimeoutMs: 1200, trackIntervalMs: 400,
      deps: { listDescendants: async () => null }, // injected: enumeration fails
    });
    eq('F4-N6: discovery failure reason recorded', n6.treeReason, 'DISCOVERY_UNKNOWN');
    eq('F4-N6: discovery state reported UNKNOWN', n6.discovery, 'UNKNOWN');
    falsy('F4-N6: NO tree-clean claim when discovery is UNKNOWN', n6.cleanupVerified);
    tru('F4-N6: fixture retained outside TMP', n6.retainedPath !== null
      && fs.existsSync(n6.retainedPath));
    falsy('F4-N6: original fixture dir removed from TMP after retention',
      fs.existsSync(n6dir));
  }
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
    let seamPort = null; // verified listening port (null when startup failed)
    let startAttemptPort = null; // F3: ownership recorded BEFORE the start-capable command
    let globalFixturePath = null;
    let serviceIdentity = null;
    // Cleanup gate lives OUTSIDE the try (a const inside `try {}` is not
    // visible to the sibling `finally {}`) — now the single top-level
    // `cleanupMayRemoveState`, shared with the F4 fault-injection checks.
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
      // Bounded port+start retry (see acquireSeamService). listenFreePort()'s
      // bind-0 result lives in the Windows ephemeral range (49152-65535) and
      // CAN be stolen as an outbound TCP source port the instant we close it
      // (probe evidence: first rework-3 targeted run hit "Managed service port
      // ... already in use" on the very first ensure-start). Candidates are
      // picked OUTSIDE the ephemeral range, checked against the live TCP
      // table, and the set-port+start pair is retried on a collision —
      // bounded and fail-closed, never silently accepted.
      // F3: ownership (attemptPort) is recorded BEFORE `service set port` and
      // therefore before the start-capable `debug config`, so a startup
      // throw/timeout still leaves the ownership state the finally needs to
      // reconcile the resource it may have created.
      const acq = acquireSeamService({ seamEnv, seamRoot, maxAttempts: 5 });
      startAttemptPort = acq.attemptPort;
      seamPort = acq.port;
      tru('GPT-REV-137 seam: managed service started on a verified port (bounded retries)',
        acq.ok);
      if (startAttemptPort !== null) {
        tru('GPT-REV-137 seam: start-attempt ownership recorded before the start-capable command',
          Number.isInteger(startAttemptPort) && startAttemptPort > 0);
      } else {
        falsy('GPT-REV-137 seam: no start attempt was recorded', acq.attempts > 0);
      }
      if (!acq.ok) throw new Error('GPT-REV-137 seam: ' + acq.failure);
      serviceIdentity = acq.identity;
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
    // hangs every run). All lifecycle mechanics (identity capture, tri-state
    // kill authorization, descendant sampling, bounded kill, serialized
    // cleanup, retention) live in the shared `runManagedTree` helper.
    const runPrecedenceProbe = (cfg, fileName) => {
      const proj = mkdtempSync(path.join(TMP, 'ocrun-'));
      writeFileSync(path.join(proj, OPENCODE_CONFIG_FILENAME), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      const target = path.join(proj, fileName);
      writeFileSync(target, fileName.endsWith('.env') ? 'TOP_SECRET=1' : 'PRECEDENCE_PROBE_CONTENT', 'utf8');
      const state = { target, reads: [] };
      mock.stateRef.current = state;
      return runManagedTree({
        command: 'opencode',
        args: ['run', '--standalone', '--model', 'mock/test', 'Read the file ' + target],
        cwd: proj, env: seamEnv, shell: true,
        timeoutMs: 120000,
        reads: () => state.reads,
        retainDir: proj, retainTag: 'ocrun',
      });
    };
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
    // Lives in the OUTER finally (cleanup in the try body leaked the service
    // when setup died after startup). Service cleanup and mock cleanup run
    // through runCleanupSequence so a service-cleanup THROW can never skip the
    // mock close (F3). Inside the service cleanup: stop first — against the
    // OWNED port, attemptPort included, so a startup that died before
    // verifying a port is still reconciled — then PROVE closed port + dead
    // pid/creationTime identity BEFORE removing state. Every dirty dimension
    // keeps the state for recovery.
    const seq = await runCleanupSequence({
      serviceCleanup: async () => {
        if (!(seamEnv && (seamPort !== null || startAttemptPort !== null))) {
          if (seamRoot) console.log('GPT-REV-137 cleanup: no owned seam service; synthetic state KEPT: ' + seamRoot);
          return;
        }
        const out = await cleanupSyntheticService({
          seamEnv, seamPort, startAttemptPort, serviceIdentity, seamRoot,
        });
        eq('GPT-REV-137 cleanup: synthetic service stop exit 0', out.stopError, '');
        eq('GPT-REV-137 cleanup: synthetic service port CLOSED after stop (tri-state probe)', out.portState, 'CLOSED');
        // identity missing => death cannot be proven => fail-closed (state KEPT)
        tru('GPT-REV-137 cleanup: synthetic service process gone (identity-checked pid+creationTime)', out.serviceGone);
        if (!out.removed) console.log('GPT-REV-137 cleanup: synthetic state KEPT for recovery: ' + seamRoot);
      },
      // outer resource guard: the mock provider dies even if setup failed midway
      mockCleanup: async () => { if (mock) await new Promise((r) => mock.server.close(r)); },
    });
    if (seq.serviceError) falsy('GPT-REV-137 cleanup: service cleanup threw', seq.serviceError);
    tru('GPT-REV-137 cleanup: mock provider cleanup executed in the finally sequence', seq.mockRan);
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
      // Pre-existing env flake (baseline evidence: crash at HEAD 1262 byId.get(7)
      // and again at 1901/1909 with the same signature — port contention from
      // leaked opencode services makes the broker drop a response). The
      // response-count FAIL above already fails the whole file closed; this
      // guard only prevents an uncaught TypeError from WIPING every earlier
      // check (F1-F4) before the summary line is printed. No assertion is
      // skipped when the transport is healthy.
      const mcpIntComplete = lines.length === 9
        && [1, 2, 3, 4, 5, 6, 7, 8, 9].every((id) => byId.get(id) && byId.get(id).result);
      if (!mcpIntComplete) {
        console.log('mcp-int: incomplete response set (pre-existing env flake); dependent assertions skipped, count check above stays FAIL');
      }
      if (mcpIntComplete) {
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
      } // end mcpIntComplete guard (fail-closed: count check above stays FAIL)
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

// ---- F3 teardown: the whole-file TMP sweep must NOT destroy retained fixtures -
// Previously every fixture lived under TMP, so this unconditional rmSync
// silently deleted the very state the "KEPT for recovery" claim pointed at.
// Retention now moves fixtures to RETAINED_ROOT (outside TMP); this teardown
// proves they survive the sweep instead of trusting the claim.
{
  const before = RETAINED.length;
  tru('F3 teardown: fixtures were actually retained during the run', before > 0);
  tru('F3 teardown: retained fixtures live OUTSIDE the TMP scratch root',
    RETAINED.every((p) => !String(p).startsWith(TMP + path.sep)));
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  falsy('F3 teardown: TMP scratch root is gone after the sweep', fs.existsSync(TMP));
  const survivors = RETAINED.filter((p) => fs.existsSync(p));
  eq('F3 teardown: every retained fixture survives the whole-file TMP teardown',
    survivors.length, RETAINED.length);
  for (const p of RETAINED) {
    if (!fs.existsSync(p)) console.log('FAIL retained-missing =>', p);
  }
}

// ---- summary --------------------------------------------------------------------
const pass = checks.filter((c) => c.ok).length;
for (const c of checks) if (!c.ok) console.log('FAIL', c.name, '=>', JSON.stringify(c.got), 'want', JSON.stringify(c.want));
console.log('\nTotal: ' + pass + '/' + checks.length + ' PASS');
// TMP was already swept (and retained fixtures proven to survive) above.
process.exit(pass === checks.length ? 0 : 1);
