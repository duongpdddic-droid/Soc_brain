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
import { buildOpenCodeConfig, OPENCODE_CONFIG_SCHEMA, OPENCODE_CONFIG_FILENAME, OPENCODE_MCP_TIMEOUT_MS, readOpenCodeConfig, evaluateCodingCapabilities } from '../packages/runtime-sandbox/opencode-adapter.mjs';
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
      eq('openCodeConfig permission.todowrite', result.openCodeConfig.permission.todowrite, 'allow');
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
      eq('preflight permission.bash allow', resolved.permission.bash, 'allow');
      eq('preflight permission.edit allow', resolved.permission.edit, 'allow');
      // GPT-REV-137 regression: `read` must be EXPLICITLY projected (wildcard-ask
      // auto-reject class) — now as a pattern-map whose `*` entry carries the
      // explicit allow verdict.
      eq('preflight permission.read allow (GPT-REV-137)', resolved.permission.read['*'], 'allow');
      eq('preflight read .env deny survives binary resolution', resolved.permission.read['*.env'], 'deny');
      eq('preflight permission.webfetch allow', resolved.permission.webfetch, 'allow');
      eq('preflight permission.task allow', resolved.permission.task, 'allow');
      eq('preflight permission.skill allow', resolved.permission.skill, 'allow');
      eq('preflight permission.todowrite allow', resolved.permission.todowrite, 'allow');
      eq('preflight permission.websearch allow', resolved.permission.websearch, 'allow');
      eq('preflight permission.external_directory deny', resolved.permission.external_directory, 'deny');
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
// Deterministic, model-free reproduction of the E2E #53 read auto-reject:
//   pre-fix projection (no `read` key) + a global config with
//   permission["*"]="ask"  =>  read matches the wildcard -> ask
//   -> headless auto-reject (pre-fix E2E evidence: evaluated permission=read
//      action.permission=* action.action=ask; the 900001 events file).
//   post-fix projection (read:"allow") => explicit key beats the wildcard
//   -> allow, and NO other permission key changes (authority not expanded:
//   only `read` is added to the canonical allow set; read-only inside the
//   bound worktree matches permission-orchestration OPERATION_RULES.read).
// The synthetic global config lives in an XDG_CONFIG_HOME override, so the
// real operator config is never read or modified. Works on OpenCode 1.18.18
// and 1.18.25 (both reproduced during the GPT-REV-137 rework).
{
  if (openCodeAvailable()) {
    const fakeXdg = mkdtempSync(path.join(TMP, 'ocxdg-'));
    const cfgDir = path.join(fakeXdg, 'opencode');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      path.join(cfgDir, OPENCODE_CONFIG_FILENAME),
      JSON.stringify({ $schema: OPENCODE_CONFIG_SCHEMA, permission: { '*': 'ask' } }, null, 2) + '\n',
      'utf8',
    );
    const baseArgs = { mcpCommand: process.execPath, mcpArgs: [MCP_ENTRYPOINT], mcpEnv: { SOC_SESSION_PATH: 'gpt-rev-137', SOC_SESSION_TOKEN: 'gpt-rev-137' } };
    const pre = buildOpenCodeConfig(baseArgs);
    delete pre.permission.read; // pre-#53 shape: no explicit read key
    const post = buildOpenCodeConfig(baseArgs); // current canonical shape
    const probe = (cfg) => {
      const proj = mkdtempSync(path.join(TMP, 'ocperm-'));
      writeFileSync(path.join(proj, OPENCODE_CONFIG_FILENAME), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      try {
        const out = execFileSync('opencode', ['debug', 'config'], {
          cwd: proj, encoding: 'utf8', shell: true,
          env: { ...process.env, XDG_CONFIG_HOME: fakeXdg },
        });
        return JSON.parse(out);
      } finally {
        try { rmSync(proj, { recursive: true, force: true }); } catch {}
      }
    };
    try {
      const preRes = probe(pre);
      eq('GPT-REV-137 pre-fix: no explicit read key', preRes.permission.read, undefined);
      eq('GPT-REV-137 pre-fix: wildcard fallback present', preRes.permission['*'], 'ask');
      const postRes = probe(post);
      eq('GPT-REV-137 post-fix: explicit read beats wildcard', postRes.permission.read['*'], 'allow');
      eq('GPT-REV-137 authority: edit allow unchanged', postRes.permission.edit, 'allow');
      eq('GPT-REV-137 authority: bash allow (executor autonomy profile)', postRes.permission.bash, 'allow');
      eq('GPT-REV-137 authority: webfetch allow (executor autonomy profile)', postRes.permission.webfetch, 'allow');
      eq('GPT-REV-137 authority: external_directory deny unchanged', postRes.permission.external_directory, 'deny');
      eq('GPT-REV-137 authority: read .env secret deny unchanged', postRes.permission.read['*.env'], 'deny');
      eq('GPT-REV-137 authority: read-only discovery trio allow (Phase B E2E: glob auto-rejected via wildcard ask)',
        JSON.stringify([postRes.permission.glob, postRes.permission.grep, postRes.permission.list]),
        JSON.stringify(['allow', 'allow', 'allow']));
      eq('GPT-REV-137 authority: no permission surface regression',
        JSON.stringify(Object.keys(postRes.permission).sort()),
        // Union surface: executor autonomy keys (task/skill/webfetch/websearch,
        // Issue #121) + the four canonical soc_broker MCP tool keys
        // (Issue #83 P0-G) — both are deliberate, evidence-driven explicit
        // keys that beat the operator-global wildcard ask. FSM tools stay
        // wildcard-ask on purpose.
        JSON.stringify(['*', 'bash', 'edit', 'external_directory', 'glob', 'grep', 'list', 'read',
          'skill', 'soc-brain_soc_broker_commit', 'soc-brain_soc_broker_diff',
          'soc-brain_soc_broker_run_registered_test', 'soc-brain_soc_broker_status',
          'task', 'todowrite', 'webfetch', 'websearch']));
    } catch (e) {
      falsy('GPT-REV-137 opencode debug config threw', String((e && e.message) || e));
    } finally {
      try { rmSync(fakeXdg, { recursive: true, force: true }); } catch {}
    }
  } else {
    console.log('SKIP GPT-REV-137: opencode binary not available on PATH');
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
      // Brand-new untracked file, created BEFORE the server boots so the
      // bounded commit (id 6) actually has something to stage + commit.
      writeFileSync(path.join(wt, 'MCP49.txt'), 'mcp bounded commit\n');
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
      eq('mcp-int tools length', byId.get(2).result.tools.length, 9);
      eq('mcp-int tool names', JSON.stringify(byId.get(2).result.tools.map((t) => t.name).sort()), JSON.stringify(['soc_broker_block_task', 'soc_broker_commit', 'soc_broker_diff', 'soc_broker_finish_task', 'soc_broker_recover_human_gate', 'soc_broker_request_human_gate', 'soc_broker_run_registered_test', 'soc_broker_status', 'soc_task_progress']));
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
// ---- summary --------------------------------------------------------------------
const pass = checks.filter((c) => c.ok).length;
for (const c of checks) if (!c.ok) console.log('FAIL', c.name, '=>', JSON.stringify(c.got), 'want', JSON.stringify(c.want));
console.log('\nTotal: ' + pass + '/' + checks.length + ' PASS');
// Best-effort cleanup
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(pass === checks.length ? 0 : 1);