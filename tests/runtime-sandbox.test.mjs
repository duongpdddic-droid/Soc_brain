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
// Finding 5 (rework): the rename-failure fallback must NOT leave the fixture
// inside TMP (the sweep would destroy exactly the state retention claims to
// keep). A failed rename now falls back to a recursive COPY out of TMP, then
// removes the source; only if BOTH rename and copy fail is the original path
// kept — and the teardown relocates any still-in-TMP retained fixture before
// sweeping, so no unresolved state is ever deleted.
const RETAINED_ROOT = mkdtempSync(path.join(os.tmpdir(), 'soc-rs-retained-'));
// Finding 4 (rework): retention records are STRUCTURED {path, error} objects —
// never a path annotated with an error string (which is not a real path and
// breaks existence/relocate checks). Asserted after TMP teardown.
const RETAINED = [];
// Finding 3 (acceptance A): real OpenCode probes have NO completeness proof, so
// their recovery fixtures are RETAINED. This list is re-checked AFTER the
// whole-file teardown to prove the state actually survived it.
const PROBE_RECOVERY_PATHS = [];
// Finding 4: records that must be re-checked after the TMP sweep — {label, rec}.
// `rec` is the LIVE record object, so a teardown relocate updates rec.path.
const F4_TEARDOWN_CHECKS = [];
const insideTmp = (p) => String(p).startsWith(TMP + path.sep);
const recordRetention = (p, error) => {
  if (!p) return;
  if (!RETAINED.some((r) => r.path === p)) RETAINED.push({ path: p, error });
};
const retainFixture = (srcDir, tag) => {
  if (!srcDir) return null;
  const dest = path.join(RETAINED_ROOT, tag + '-' + path.basename(srcDir) + '-' + Date.now());
  try {
    fs.renameSync(srcDir, dest); // same volume (both under os.tmpdir())
    recordRetention(dest, null);
    return dest;
  } catch (eRename) {
    // rename failed (locked/cross-volume): COPY out of TMP, then drop source.
    try {
      fs.cpSync(srcDir, dest, { recursive: true });
      try { fs.rmSync(srcDir, { recursive: true, force: true }); } catch { /* source cleanup best-effort */ }
      recordRetention(dest, null);
      return dest;
    } catch (eCopy) {
      // Both move and copy failed: keep the ORIGINAL path (a real, existing
      // path — no annotation string) with the structured failure recorded, and
      // let the teardown relocate it (never silently drop, never sweep it).
      recordRetention(srcDir, 'rename=' + String((eRename && eRename.message) || eRename)
        + '; copy=' + String((eCopy && eCopy.message) || eCopy));
      return srcDir;
    }
  }
};
// Finding 4 (rework): a seamRoot left behind by a startup/cleanup failure is
// UNRESOLVED STATE — it must be RETAINED out of TMP (registered), not merely
// logged as "KEPT" while the sweep later deletes it. seamRoot === TMP (the
// whole scratch root) and missing roots are never relocated.
const retainSeamState = (seamRoot, tag = 'seam') => {
  if (!seamRoot || seamRoot === TMP || !fs.existsSync(seamRoot)) return null;
  const kept = retainFixture(seamRoot, tag);
  console.log('GPT-REV-137 cleanup: synthetic state KEPT for recovery: ' + kept);
  return kept;
};
// Finding 4: guard a service-cleanup implementation so a seamRoot still on disk
// when it FINISHES — including when the impl THROWS — is registered for
// retention (moved out of TMP) instead of being left for the sweep to delete.
// Production wires its real service cleanup through this; the regression below
// exercises the SAME wrapper with an injected throw.
const withSeamRetention = async (sr, impl) => {
  try { return await impl(); }
  finally { if (sr && fs.existsSync(sr)) retainSeamState(sr, 'seam-after-cleanup'); }
};
// Finding 4 (rework): relocate every retained record STILL inside TMP, then
// sweep TMP ONLY when nothing unresolved remains. This is REAL control flow —
// the sweep is skipped entirely (state preserved, failure reported) whenever an
// unresolved path is still inside TMP. It iterates a SNAPSHOT: retainFixture
// appends to RETAINED, so iterating the live array could grow forever when
// relocate keeps failing (rename+copy+relocate all fail).
const relocateRetainedAndSweepTmp = () => {
  const snapshot = [...RETAINED];
  for (const rec of snapshot) {
    if (!insideTmp(rec.path)) continue;
    if (!fs.existsSync(rec.path)) continue; // stale record: nothing left to lose
    const relocated = retainFixture(rec.path, 'teardown-relocate');
    if (relocated && !insideTmp(relocated)) { rec.path = relocated; rec.error = null; }
    // double-failure: rec.path stays inside TMP => reported as unresolved below
  }
  const unresolved = RETAINED.filter((r) => insideTmp(r.path) && fs.existsSync(r.path));
  if (unresolved.length > 0) {
    console.log('FAIL teardown: ' + unresolved.length + ' unresolved retained fixture(s) still inside TMP; '
      + 'sweep SKIPPED to preserve state: '
      + unresolved.map((r) => r.path + (r.error ? ' [' + r.error + ']' : '')).join(', '));
    return { swept: false, unresolved: unresolved.map((r) => r.path) };
  }
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  return { swept: !fs.existsSync(TMP), unresolved: [] };
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
  // Finding 1 (rework 4): SAME SOURCE as PROCESS_TABLE_QUERY — both sides of
  // sameCreationTime read Win32_Process CreationDate, so capture-vs-snapshot
  // equality is exact (the old Get-Process StartTime path read 1-8 ticks apart
  // from the CIM snapshot and forced a lossy tolerance window). Emitted as a
  // lossless digit STRING of FileTime ticks — ToFileTimeUtc() is a 100-ns UTC
  // tick integer, stable and comparable across runs regardless of culture.
  // Core cmdlets only (Get-NetTCPConnection module load hangs on this runtime —
  // probe evidence: ETIMEDOUT).
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop).CreationDate.ToFileTimeUtc().ToString()`],
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
// Finding 1 (rework): killTree now RECEIVES the ORIGINAL captured identity,
// revalidates it AT the kill boundary INSIDE this helper, and REFUSES (zero
// taskkill) on UNKNOWN/GONE. A bare-pid killTree let the CALLER decide whether
// to revalidate; folding the gate in makes refusal the only possible path.
const KILL_COMMAND_TIMEOUT_MS = 10000;
const killTree = (identity, timeoutMs = KILL_COMMAND_TIMEOUT_MS) => new Promise((resolve) => {
  const pid = identity && identity.pid;
  if (!pid) { resolve({ ok: false, refused: false, error: 'killTree: no root pid' }); return; }
  const gate = killAuthorization(identity); // revalidate ORIGINAL identity here
  if (!gate.allowed) {
    resolve({ ok: false, refused: true, state: gate.state, bounded: false,
      error: 'killTree refused (zero kill): identity ' + gate.state + ' at kill boundary' });
    return;
  }
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: timeoutMs }, (err, _out, stderr) => {
    if (err) {
      const bounded = Boolean(err.killed || err.code === 'ETIMEDOUT');
      resolve({ ok: false, refused: false, bounded, error: bounded ? ('kill command bounded out after ' + timeoutMs + 'ms') : String((err && err.message) || err), stderr: String(stderr || '') });
    } else resolve({ ok: true, refused: false, bounded: false, stderr: String(stderr || '') });
  });
});
// Pure parser for the Win32_Process snapshot: null = the snapshot itself is
// missing/unparsable (discovery FAILURE / UNKNOWN) — an empty stdout used to be
// returned as `[]`, i.e. a free "no descendants" proof. A valid snapshot with
// real rows but no children of the root is the only thing that yields `[]`.
// Finding 4 (rework): EVERY row must be validated. `[{}]` / rows with a
// non-numeric ProcessId used to parse to a "valid" array, then walkDescendants
// silently skipped them and returned [] — a false no-descendants proof. A
// single malformed row makes the WHOLE snapshot UNKNOWN (fail-closed).
// Finding 5 (rework): NO coercion. Number(null), Number('') and Number(false)
// all read as 0 and would smuggle malformed ids in as PID 0 (a real row);
// every id must be a primitive number, an integer, inside the UInt32 domain.
// Finding 1 (rework): every row additionally carries a machine-readable
// creation timestamp so ownership can be proven AT DISCOVERY TIME — a row
// without one makes the whole snapshot UNKNOWN (no identity proof, no kill).
const isUInt32Id = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xFFFFFFFF;
// Finding 1 (rework 4): the production timestamp is now a lossless DIGIT
// STRING (Win32 FileTime ticks exceed 2^53 — as a JSON number they round and
// can no longer be compared exactly). Integer numbers stay accepted only for
// legacy/unit fixtures; anything non-numeric/negative/fractional/non-digits is
// still UNKNOWN.
const isCreationTimestamp = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0)
  || (typeof v === 'string' && /^\d+$/.test(v));
const parseProcessTable = (out) => {
  if (!out || !String(out).trim()) return null; // empty output: failure, never proof
  let parsed;
  try { parsed = JSON.parse(out); } catch { return null; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (rows.length === 0) return null; // "no processes at all" is not a valid snapshot
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null; // [{}] / [42] / [[1]] => UNKNOWN
    // PID 0 (System Idle Process) is a LEGITIMATE table row (probe evidence:
    // the real Win32_Process snapshot contains it); only missing/non-numeric/
    // negative/non-number ids are malformed — with NO Number() coercion.
    if (!isUInt32Id(row.ProcessId)) return null;
    if (!isUInt32Id(row.ParentProcessId)) return null;
    if (!isCreationTimestamp(row.CreationTime)) return null;
  }
  return rows;
};
// Finding 1 (rework 4): identity compare is now LOSSLESS + SAME-SOURCE +
// EXACT. The old +/-1000-tick window existed only because two defects were
// being tolerated at once:
//   1) JSON float rounding — FileTime ticks (~1.3e17) exceed 2^53, so a raw
//      Int64 serialized as a JSON number rounds at ~16-tick granularity and
//      the exact identity can no longer be reconstructed. The query now
//      emits the ticks as a digit STRING, which survives JSON untouched.
//   2) cross-source reads — snapshots came from Win32_Process CreationDate
//      while captures came from Get-Process StartTime: two readings of the
//      SAME process differed by 1-8 ticks. Both sides now read the same
//      Win32_Process CreationDate field, so equality is exact.
// With both defects gone the window is unsound, not merely generous: a pid
// recycled into a different incarnation created within ~100us of the original
// would have compared SAME. Equality is now exact string equality on digits.
// A null/non-digit capture time means we hold no usable root identity, so it
// can never match (finding F5: no coercion of missing data into an identity
// claim).
const sameCreationTime = (a, b) => {
  if (a == null || b == null) return false;
  const sa = String(a);
  const sb = String(b);
  if (!/^\d+$/.test(sa) || !/^\d+$/.test(sb)) return false;
  return sa === sb;
};
// Shared process-table query: rows carry pid, parent pid AND the creation
// timestamp (Finding 1: discovery-time ownership proof). `.ToString()` keeps
// FileTime ticks lossless through JSON — a raw Int64 comes back as a rounded
// number (see sameCreationTime above).
const PROCESS_TABLE_QUERY = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{n='CreationTime';e={$_.CreationDate.ToFileTimeUtc().ToString()}} | ConvertTo-Json -Compress";
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
// Row-typed variant: the ownership proof walks the SAME chain but keeps each
// descendant's snapshot creation timestamp for the capture-time binding.
const walkDescendantRows = (rootPid, rows) => {
  const pids = new Set(walkDescendants(rootPid, rows));
  return rows.filter((r) => pids.has(Number(r.ProcessId)));
};
const listLiveDescendantPids = (rootPid) => {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', PROCESS_TABLE_QUERY],
    { encoding: 'utf8', timeout: 15000 }).trim();
    const rows = parseProcessTable(out);
    if (rows === null) return null;
    return walkDescendants(rootPid, rows);
  } catch { return null; }
};
// Async ownership snapshot (F2 + Finding 1 rework): descendant sampling must
// never block this process' event loop, and the snapshot must carry each row's
// creation timestamp PLUS the root row so ownership is provable at discovery
// time. Returns null (UNKNOWN) or { rows, rootRow } (rootRow null when the
// root is no longer in the live table).
const listOwnershipSnapshotAsync = (rootPid) => new Promise((resolve) => {
  execFile('powershell', ['-NoProfile', '-Command', PROCESS_TABLE_QUERY],
  { encoding: 'utf8', timeout: 15000 }, (err, stdout) => {
    if (err) { resolve(null); return; } // enumeration failed => UNKNOWN
    const rows = parseProcessTable(String(stdout || '').trim());
    if (rows === null) { resolve(null); return; }
    const rootRow = rows.find((r) => r.ProcessId === Number(rootPid)) || null;
    resolve({ rows, rootRow });
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
//  * DESCENDANTS (F2 + Finding 1 rework 4): identities are sampled ONLY from a
//    snapshot whose root row is present and whose creation timestamp matches
//    the ORIGINAL captured identity (root row present => SAME, otherwise the
//    pid was REUSED => FOREIGN). An ABSENT root (even proven GONE) is merely a
//    walk proof — it can NEVER authorize a new capture, because the freed pid
//    may now belong to an unrelated process claiming that parent. Rows also
//    re-bind at capture time (snapshot timestamp vs freshly captured identity —
//    pid reuse between the two is FOREIGN and never recorded). A tree-clean
//    claim additionally needs a non-UNKNOWN discovery snapshot whose live set
//    is empty, plus — when an enforced registration handshake is configured —
//    every registered descendant proven GONE; an empty/failed snapshot or
//    missing registry is never proof.
//  * STABLE SNAPSHOT (Finding 2 rework 4): the promise resolves a frozen
//    settle-time COPY of the result. The live record stays observable through
//    `spec.onResult` for audit hooks and for a late kill callback to record on —
//    nothing that runs after settle can mutate the object the caller received.
//  * CLEANUP SPLIT (Finding 3, operator option A): `trackedCleanupVerified`
//    is what the repo's existing mechanisms CAN prove for any tree — root
//    identity revalidated GONE + every captured identity revalidated GONE.
//    `treeCompleteness` is the COMPLETENESS proof: PROVEN only when a genuine
//    proof actually exists — an ENFORCED registration handshake (`registryPath`)
//    whose registered descendants are all proven GONE, on top of a non-UNKNOWN
//    discovery walk whose live set is empty. An empty walk ALONE is never
//    enough (a broken parent chain hides descendants), so real binary probes
//    that cannot run a handshake always read UNKNOWN — never assumed, never a
//    claim. The compatibility `cleanupVerified` is true only when BOTH hold;
//    UNKNOWN completeness keeps the fixture (recovery state, no silent removal).
//  * BOUNDS (F2): the kill deadline is armed BEFORE the kill command, the kill
//    command is bounded, cleanup is serialized (first finisher wins) and NO
//    timer may be created after settle (`postSettleTimers` must stay 0).
const runManagedTree = (spec) => new Promise((resolve) => {
  const {
    command, args, cwd = null, env = process.env, shell = false,
    timeoutMs = 120000, killDeadlineMs = 15000, treeGoneTimeoutMs = 15000,
    trackIntervalMs = 2000, reads = () => [], retainDir = null, retainTag = 'probe',
    onDescendantCaptured = null,
    registryPath = null, // Finding 3: enforced registration handshake (completeness)
    deps = {},
  } = spec;
  const kill = deps.kill || killTree;
  const listDescendants = deps.listDescendants || listOwnershipSnapshotAsync;
  const idState = deps.identityState || identityState;
  const captureId = deps.captureIdentity || captureProcessIdentity;
  const child = spawn(command, args, { cwd, env, shell, stdio: ['ignore', 'pipe', 'pipe'] });
  const identity = captureId(child.pid);
  const startMs = Date.now();
  const descendants = new Map(); // pid -> identity, KEPT even after ancestor exit
  const result = {
    rootPid: child.pid, code: null, signal: null, spawnError: '',
    timedOut: false, stdout: '', stderr: '', reads: [],
    identityCaptured: identity !== null, rootIdentity: identity, rootState: 'UNKNOWN',
    killGate: { allowed: false, state: 'UNKNOWN', attempted: false, refused: false, reason: '' },
    killRecord: { attempted: false, ok: false, error: '' },
    descendantCount: 0, descendantStates: [], descendantIdentities: [],
    discovery: 'UNKNOWN', treeReason: 'NOT_EVALUATED', discoveryOwner: '',
    // Finding 3 (operator option A): the cleanup verdict is SPLIT. See the
    // CLEANUP contract line above and the settle-time assignment.
    trackedCleanupVerified: false, treeCompleteness: 'UNKNOWN',
    cleanupVerified: false, retainedPath: null,
    settleCount: 0, postSettleTimers: 0, timersArmed: 0, timersCleared: 0,
    timersActiveAfterSettle: -1,
    settleStarted: false, // Finding 2 test hook: a settle() has begun
    elapsedMs: 0, finishedBy: '',
    sampleNow: () => sampleDescendants(), // Finding 2 test hook: request a pass NOW
  };
  // Test hook: hand the LIVE result object to the caller immediately, so a
  // test can observe settleStarted/settleCount while the run is in flight
  // (the promise only resolves at the very end).
  if (spec.onResult) { try { spec.onResult(result); } catch { /* hook must never break the run */ } }
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
  let samplingAdmitted = true; // Finding 2: CLOSED at settle start — no NEW pass may ever start
  let rootAbsentProven = false; // Finding 1: root proven GONE at least once (absent terminus)
  let stdout = '';
  let stderr = '';
  let timer = null;
  let hardTimer = null;
  let tracker = null;
  let sampling = false;
  let samplingPromise = null; // in-flight sampling pass, awaited by settle (Finding 3)
  // Finding 1 (rework 4): DISCOVERY-TIME ownership proof. A snapshot only earns
  // `PROVEN` when the root row's creation timestamp matches the ORIGINAL
  // captured root identity (root row present => SAME, otherwise the pid was
  // REUSED and the snapshot's root is FOREIGN => nothing from it may be
  // captured). `PROVEN_ROOT_ABSENT` (root row absent + identity proven GONE) is
  // only a WALK/evaluate proof — it says the chain terminus is the verified
  // dead root, nothing more. It is NEVER a capture proof: once the root pid is
  // free, any row claiming that ParentProcessId may be an UNRELATED process
  // that inherited the recycled pid, so no NEW identity may ever be captured
  // from such a snapshot (identities captured while the root was still proven
  // alive stay in the map and are re-validated per evaluate).
  // Each captured descendant row's snapshot timestamp is re-checked against the
  // identity captured AFTER the snapshot — a mismatch means the pid was reused
  // between snapshot and capture => a FOREIGN process, never recorded as ours
  // and never killable as ours.
  // Anything less yields an ownership state (never `PROVEN`) and captures
  // NOTHING. evaluateTree re-runs this same proof — it is never used as a
  // substitute for discovery proof, and discovery proof is never delegated to
  // evaluateTree.
  // Deliberately NO per-pass synchronous PowerShell in the hot loop: a
  // 10s-timeout sync call blocks the event loop under full-suite load and made
  // sampling drop captures (probe evidence: rework3 lost every identity). The
  // absent-terminus idState() probe runs at most ONCE (cached in
  // rootAbsentProven), never per pass.
  const proveDiscoveryOwnership = (snap) => {
    if (!identity) return 'NO_ROOT_IDENTITY';
    if (snap.rootRow) {
      return sameCreationTime(snap.rootRow.CreationTime, identity.startTime)
        ? 'PROVEN' : 'ROOT_PID_REUSED';
    }
    if (rootAbsentProven) return 'PROVEN_ROOT_ABSENT';
    if (idState(identity) === 'GONE') { rootAbsentProven = true; return 'PROVEN_ROOT_ABSENT'; }
    return 'ROOT_UNPROVEN';
  };
  const sampleDescendants = () => {
    if (!samplingAdmitted || sampling || settledFlag) return samplingPromise || Promise.resolve();
    sampling = true;
    samplingPromise = (async () => {
      try {
        const snap = await listDescendants(child.pid);
        // FROZEN after the final verdict. An ADMITTED pass is drained by
        // settle() and MUST be allowed to land before evaluate (that is the
        // whole point of the drain); only post-verdict mutation is refused.
        // New passes are already blocked at the admission guard above.
        if (settledFlag) return;
        if (!snap || !Array.isArray(snap.rows)) return; // UNKNOWN: never "no descendants"
        const owner = proveDiscoveryOwnership(snap);
        if (owner !== 'PROVEN') {
          // Finding 1 (rework 4): capture ONLY from a snapshot whose root row
          // is present and SAME. A missing root row (PROVEN_ROOT_ABSENT /
          // ROOT_UNPROVEN / foreign) leaves the old parent pid free for reuse —
          // a row claiming that PPID is NOT a proven descendant of OURS, so
          // nothing new is recorded and nothing from it can ever be killed.
          // The walk still runs through takeDiscovery at evaluate time, so a
          // non-empty unattributable discovery keeps the verdict NOT-CLEAN.
          result.discoveryOwner = owner;
          return;
        }
        for (const row of walkDescendantRows(child.pid, snap.rows)) {
          const pid = row.ProcessId; // rows carry ProcessId — never `row.pid`
          if (descendants.has(pid)) continue;
          const id = captureId(pid);
          // Capture-vs-snapshot binding: pid REUSED between snapshot and
          // capture reads a different creation time => foreign, never recorded.
          if (!id || !sameCreationTime(id.startTime, row.CreationTime)) continue;
          descendants.set(pid, id);
          if (onDescendantCaptured) { try { onDescendantCaptured(pid); } catch { /* hook must never break sampling */ } }
        }
      } catch { /* fail-closed: re-checked as UNKNOWN in evaluateTree */ }
      finally { sampling = false; samplingPromise = null; }
    })();
    return samplingPromise;
  };
  // Finding 3 (rework): completeness for a clean claim. With an enforced
  // registration handshake, `clean` additionally requires EVERY registered
  // descendant to be PROVEN GONE — a missing/undecipherable registry is never
  // completeness (fail-closed), so a walk that returns [] while a registered
  // grandchild still lives can never read as a false clean.
  // NOTE: this handshake is the ONLY completeness proof in this repo — see
  // `treeCompleteness` in settle(): without `registryPath` there is no proof,
  // even when the walk comes back empty.
  const registryCompleteness = () => {
    if (!registryPath) return { ok: true };
    let entries = null;
    try { entries = JSON.parse(fs.readFileSync(registryPath, 'utf8')); } catch { entries = null; }
    if (!Array.isArray(entries) || entries.length === 0) return { ok: false, reason: 'REGISTRY_MISSING' };
    for (const en of entries) {
      const st = idState(en);
      if (st === 'SAME') return { ok: false, reason: 'REGISTRY_ALIVE' };
      if (st !== 'GONE') return { ok: false, reason: 'REGISTRY_UNKNOWN' };
    }
    return { ok: true };
  };
  const evaluateTree = async () => {
    const rootState = idState(identity);
    result.rootState = rootState;
    if (rootState !== 'GONE') return { clean: false, reason: 'ROOT_' + rootState, discovery: 'SKIPPED' };
    const disc = await takeDiscovery();
    if (!disc) return { clean: false, reason: 'DISCOVERY_UNKNOWN', discovery: 'UNKNOWN' };
    if (disc.owner !== 'PROVEN' && disc.owner !== 'PROVEN_ROOT_ABSENT') {
      // Discovery-time ownership failed (foreign root / unproven terminus) —
      // never substituted by evaluateTree: this is a NOT-CLEAN verdict only.
      result.discoveryOwner = disc.owner;
      return { clean: false, reason: disc.owner, discovery: 'UNKNOWN', states: [] };
    }
    const live = disc.rows.map((r) => r.ProcessId);
    const states = [];
    for (const d of descendants.values()) {
      const st = idState(d);
      states.push({ pid: d.pid, state: st });
      if (st === 'UNKNOWN') return { clean: false, reason: 'DESC_UNKNOWN:' + d.pid, discovery: live.length === 0 ? 'EMPTY' : 'NONEMPTY', states };
      if (st === 'SAME') return { clean: false, reason: 'DESC_ALIVE:' + d.pid, discovery: live.length === 0 ? 'EMPTY' : 'NONEMPTY', states };
    }
    if (live.length > 0) return { clean: false, reason: 'DISCOVERY_NONEMPTY', discovery: 'NONEMPTY', states };
    const reg = registryCompleteness();
    if (!reg.ok) return { clean: false, reason: reg.reason, discovery: 'EMPTY', states };
    return { clean: true, reason: '', discovery: 'EMPTY', states };
  };
  // Shared discovery entry (Finding 1): BOTH sampling and evaluation prove
  // ownership the same way, against the ORIGINAL captured root identity.
  const takeDiscovery = async () => {
    const snap = await listDescendants(child.pid);
    if (!snap || !Array.isArray(snap.rows)) return null; // enumeration UNKNOWN
    const owner = proveDiscoveryOwnership(snap);
    if (owner !== 'PROVEN' && owner !== 'PROVEN_ROOT_ABSENT') return { owner, rows: [] };
    return { owner, rows: walkDescendantRows(child.pid, snap.rows) };
  };
  // Finding 2 (rework 4): the promise resolves with a STABLE SNAPSHOT frozen
  // at settle time. The internal `result` stays live for audit hooks and for a
  // LATE kill callback to record its outcome — that callback can no longer
  // mutate the object already handed to the caller (the old code resolved the
  // live object, so a kill callback landing after settle rewrote the verdict
  // data the caller already observed). Nested containers are copied so the
  // snapshot is insulated from later in-place writes; shared closures
  // (sampleNow etc.) are kept by reference.
  const makeResultSnapshot = (r) => Object.freeze({
    ...r,
    rootIdentity: r.rootIdentity ? { ...r.rootIdentity } : null,
    killGate: { ...r.killGate },
    killRecord: { ...r.killRecord },
    descendantIdentities: r.descendantIdentities.map((d) => ({ ...d })),
    descendantStates: r.descendantStates.map((s) => ({ ...s })),
    reads: Array.isArray(r.reads) ? r.reads.slice() : r.reads,
  });
  const settle = async (code, signal, spawnError, finishedBy) => {
    // Serialized: exactly one finish path runs (close vs kill-deadline races).
    if (settledFlag || finishing) return false;
    finishing = true;
    result.settleStarted = true;
    // Finding 2 (rework): CLOSE sampling admission FIRST and clear the
    // tracker — from here on no new sampling task may start. Then DRAIN every
    // pass admitted before the close, and only then evaluate: the evaluated
    // state and the captured set are the same frozen state.
    samplingAdmitted = false;
    if (tracker !== null) { try { clearInterval(tracker); } catch { /* already cleared */ } }
    result.code = code;
    result.signal = signal;
    result.spawnError = spawnError || '';
    result.finishedBy = finishedBy;
    while (samplingPromise) { try { await samplingPromise; } catch { /* fail-closed */ } }
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
    // Finding 3 (operator option A): SPLIT the cleanup verdict instead of one
    // ambiguous `cleanupVerified` standing in for a complete-tree proof.
    //  * `trackedCleanupVerified` is exactly what the repo's EXISTING
    //    mechanisms can prove for any tree — root identity revalidated GONE
    //    AND every captured identity revalidated GONE. Captured identities are
    //    revalidated HERE directly (not read from ev.states): a discovery
    //    failure returns no states, which must never read as "all gone".
    //  * `treeCompleteness` is the COMPLETENESS proof — PROVEN only when a
    //    genuine proof exists: `ev.clean` (a non-UNKNOWN discovery walk with an
    //    empty live set, registry folded in) AND an ENFORCED registration
    //    handshake was configured (`registryPath`). A walk that merely came back
    //    EMPTY is NEVER promoted to PROVEN: an arbitrary spawned tree with a
    //    broken parent chain produces exactly that empty walk (real binary
    //    probes cannot run a handshake), so without the handshake the verdict
    //    stays UNKNOWN — never a claim.
    //  * `cleanupVerified` (compatibility field) is true ONLY when BOTH hold;
    //    an UNKNOWN completeness keeps the fixture for recovery below — no
    //    silent state loss and never a "tree clean" claim on UNKNOWN proof.
    const capturedGone = result.descendantIdentities.every((d) => idState(d) === 'GONE');
    result.trackedCleanupVerified = Boolean(identity !== null && result.rootState === 'GONE' && capturedGone);
    result.treeCompleteness = (ev.clean && registryPath !== null) ? 'PROVEN' : 'UNKNOWN';
    result.cleanupVerified = result.trackedCleanupVerified && result.treeCompleteness === 'PROVEN';
    result.reads = reads();
    result.stdout = stripAnsi(stdout);
    result.stderr = stripAnsi(stderr);
    result.elapsedMs = Date.now() - startMs;
    // settle: clear EVERY armed timer/interval — nothing may dangle
    settledFlag = true;
    result.settleCount += 1;
    for (const [h, clear] of [...activeTimers]) { clear(); activeTimers.delete(h); result.timersCleared += 1; }
    result.timersActiveAfterSettle = activeTimers.size; // must be 0
    // retention: a fixture is MOVED out of TMP (survives the whole-file
    // teardown) unless the run is FULLY proven — tracked cleanup gone AND the
    // tree proven complete (a REAL completeness proof, not an empty walk).
    // treeCompleteness UNKNOWN therefore KEEPS the fixture: it holds the
    // recovery state for whatever could not be proven.
    if (retainDir && fs.existsSync(retainDir)) {
      if (result.cleanupVerified) { try { rmSync(retainDir, { recursive: true, force: true }); } catch {} }
      else {
        result.retainedPath = retainFixture(retainDir, retainTag);
        console.log('probe: fixture KEPT for recovery: ' + result.retainedPath);
      }
    }
    resolve(makeResultSnapshot(result));
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
      const p = kill(identity); // Finding 1: pass the ORIGINAL identity, not a bare pid
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
  const badKill = await killTree('not-a-pid'); // no .pid => zero kill, failure captured
  falsy('F1 killTree on an invalid pid records ok=false (failure captured)', badKill.ok);
  tru('F1 killTree error string is populated', typeof badKill.error === 'string' && badKill.error.length > 0);
  tru('F1 killTree returns bounded (no hang)', Date.now() - killStart < 15000);
  // Finding 1: killTree REVALIDATES the ORIGINAL identity inside the helper and
  // refuses UNKNOWN/GONE — a caller can never force a kill on an unproven pid.
  const refuseUnknown = await killTree({ pid: process.pid, startTime: null });
  falsy('F1 killTree refuses an UNKNOWN identity (zero kill)', refuseUnknown.ok);
  eq('F1 killTree UNKNOWN refusal state', refuseUnknown.state, 'UNKNOWN');
  const refuseGone = await killTree({ pid: process.pid, startTime: '2000-01-01 00:00:00' });
  falsy('F1 killTree refuses a GONE/reused identity (zero kill)', refuseGone.ok);
  eq('F1 killTree GONE refusal state', refuseGone.state, 'GONE');
  const refuseMissing = await killTree(null);
  falsy('F1 killTree refuses a missing identity (zero kill)', refuseMissing.ok);
}

// ---- F2: discovery snapshot semantics (pure parser + real enumeration) -------
{
  eq('F2: empty discovery output is UNKNOWN (null), never an empty proof',
    parseProcessTable(''), null);
  eq('F2: whitespace-only discovery output is UNKNOWN', parseProcessTable('   \n'), null);
  eq('F2: unparsable discovery output is UNKNOWN', parseProcessTable('not-json{{{'), null);
  eq('F2: structurally empty JSON table is UNKNOWN (a live process table is never empty)',
    parseProcessTable('[]'), null);
  const rows = parseProcessTable('[{"ProcessId":10,"ParentProcessId":4,"CreationTime":100},'
    + '{"ProcessId":20,"ParentProcessId":10,"CreationTime":200},'
    + '{"ProcessId":30,"ParentProcessId":20,"CreationTime":300}]');
  tru('F2: valid snapshot with rows parses to an array', Array.isArray(rows) && rows.length === 3);
  eq('F2: descendant walk follows the ParentProcessId chain',
    JSON.stringify(walkDescendants(10, rows)), JSON.stringify([20, 30]));
  eq('F2: a valid snapshot with no children yields EMPTY (not UNKNOWN)',
    JSON.stringify(walkDescendants(999, rows)), '[]');
  // Finding 4: a malformed row makes the WHOLE snapshot UNKNOWN — it is never
  // silently skipped into a false "no descendants" proof.
  eq('F2: [{}] (row without ProcessId) is UNKNOWN, not an empty proof',
    parseProcessTable('[{}]'), null);
  eq('F2: mixed valid+malformed rows is UNKNOWN (one bad row poisons the snapshot)',
    parseProcessTable('[{"ProcessId":10,"ParentProcessId":4,"CreationTime":1},{}]'), null);
  eq('F2: non-numeric ProcessId is UNKNOWN',
    parseProcessTable('[{"ProcessId":"abc","ParentProcessId":1,"CreationTime":1}]'), null);
  eq('F2: non-numeric ParentProcessId is UNKNOWN',
    parseProcessTable('[{"ProcessId":10,"ParentProcessId":"x","CreationTime":1}]'), null);
  eq('F2: scalar (non-object) row is UNKNOWN',
    parseProcessTable('[42]'), null);
  // Finding 5 (rework): NO coercion — Number(null), Number('') and
  // Number(false) all read as 0 and would smuggle malformed ids in as a
  // legitimate-looking PID 0 row. Primitive-number + integer + UInt32 only.
  eq('F5: {ProcessId:null} is UNKNOWN (null never coerces to PID 0)',
    parseProcessTable('[{"ProcessId":null,"ParentProcessId":1,"CreationTime":5}]'), null);
  eq('F5: {ProcessId:""} is UNKNOWN (empty string never coerces to PID 0)',
    parseProcessTable('[{"ProcessId":"","ParentProcessId":1,"CreationTime":5}]'), null);
  eq('F5: {ProcessId:false} is UNKNOWN (boolean never coerces to PID 0)',
    parseProcessTable('[{"ProcessId":false,"ParentProcessId":1,"CreationTime":5}]'), null);
  eq('F5: string-valued ProcessId is UNKNOWN (no Number() parsing)',
    parseProcessTable('[{"ProcessId":"10","ParentProcessId":1,"CreationTime":5}]'), null);
  eq('F5: {ParentProcessId:null} is UNKNOWN',
    parseProcessTable('[{"ProcessId":1,"ParentProcessId":null,"CreationTime":5}]'), null);
  eq('F5: {ParentProcessId:false} is UNKNOWN',
    parseProcessTable('[{"ProcessId":1,"ParentProcessId":false,"CreationTime":5}]'), null);
  eq('F5: row without CreationTime (no identity proof) is UNKNOWN',
    parseProcessTable('[{"ProcessId":1,"ParentProcessId":0}]'), null);
  eq('F5: {CreationTime:null} is UNKNOWN',
    parseProcessTable('[{"ProcessId":1,"ParentProcessId":0,"CreationTime":null}]'), null);
  eq('F5: mixed valid+null-id rows is UNKNOWN (one bad row poisons the snapshot)',
    parseProcessTable('[{"ProcessId":1,"ParentProcessId":0,"CreationTime":5},'
      + '{"ProcessId":null,"ParentProcessId":1,"CreationTime":6}]'), null);
  eq('F5: array-shaped row is UNKNOWN', parseProcessTable('[[1,2,3]]'), null);
  eq('F5: negative ProcessId is UNKNOWN', parseProcessTable('[{"ProcessId":-1,"ParentProcessId":1,"CreationTime":5}]'), null);
  eq('F5: fractional ProcessId is UNKNOWN', parseProcessTable('[{"ProcessId":1.5,"ParentProcessId":1,"CreationTime":5}]'), null);
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
  // The gate's cleanup dimension is TRACKED cleanup (root + captured identities
  // proven GONE) — the single-source lifecycle gate shared with okRun. Tree
  // completeness is reported separately and never flips this gate.
  const gate = (r) => r.code === 0 && r.spawnError === '' && !r.timedOut && r.trackedCleanupVerified;

  // N1: marker + NONZERO exit — the gate must reject it even though the marker
  // travelled and tracked cleanup was proven (root + captured identities gone).
  {
    const n1 = await runManagedTree({
      command: process.execPath,
      args: ['-e', "process.stdout.write('N1_MARKER'); process.exit(7)"],
      timeoutMs: 30000, treeGoneTimeoutMs: 5000, trackIntervalMs: 400,
    });
    eq('F4-N1: real child nonzero exit recorded', n1.code, 7);
    tru('F4-N1: marker travelled from the real child', n1.stdout.includes('N1_MARKER'));
    tru('F4-N1: tracked cleanup proven (root + captured identities gone)', n1.trackedCleanupVerified);
    eq('F4-N1: no handshake configured => completeness UNKNOWN (walk-empty never promoted)',
      n1.treeCompleteness, 'UNKNOWN');
    falsy('F4-N1: no tree-clean claim without a completeness proof', n1.cleanupVerified);
    falsy('F4-N1: gate rejects marker+nonzero', gate(n1));
    eq('F4-N1: settle serialized (exactly once)', n1.settleCount, 1);
    eq('F4-N1: no timer armed after settle', n1.postSettleTimers, 0);
    eq('F4-N1: no timer left active after settle', n1.timersActiveAfterSettle, 0);
  }

  // N2: marker + TIMEOUT — authorized kill (SAME revalidated at the boundary),
  // bounded completion, tracked cleanup proven (root killed + gone),
  // completeness UNKNOWN (no handshake possible), timer accounting clean.
  // Finding 2 (rework 4): the verdict data comes from the settle-time SNAPSHOT;
  // the kill outcome is audited on the LIVE record (the real taskkill callback
  // may land before OR after resolve — polling here proves it runs either way).
  {
    let live2 = null;
    const n2 = await runManagedTree({
      command: process.execPath,
      args: ['-e', "process.stdout.write('N2_MARKER'); setTimeout(() => {}, 60000);"],
      timeoutMs: 1200, killDeadlineMs: 8000, treeGoneTimeoutMs: 5000, trackIntervalMs: 400,
      onResult: (r) => { live2 = r; },
    });
    tru('F4-N2: marker travelled before the timeout', n2.stdout.includes('N2_MARKER'));
    tru('F4-N2: timeout recorded', n2.timedOut);
    tru('F4-N2: kill authorized at the boundary (identity revalidated SAME)',
      n2.killGate.allowed === true && n2.killGate.state === 'SAME' && n2.killGate.attempted);
    // Audit the real kill on the live record: it must have been issued, and its
    // outcome must land (never swallowed) whether it beat or followed resolve.
    let waited = 0;
    while (live2 !== null && !(live2.killRecord.attempted && live2.killRecord.ok)
        && waited < 15000) { await sleep(100); waited += 100; }
    tru('F4-N2: bounded kill issued and succeeded (live audit)',
      live2 !== null && live2.killRecord.attempted && live2.killRecord.ok);
    tru('F4-N2: bounded completion with tracked cleanup proven (root killed + gone)',
      n2.elapsedMs < 20000 && n2.trackedCleanupVerified && n2.finishedBy === 'close');
    eq('F4-N2: no handshake configured => completeness UNKNOWN (never assumed)',
      n2.treeCompleteness, 'UNKNOWN');
    falsy('F4-N2: no tree-clean claim without a completeness proof', n2.cleanupVerified);
    eq('F4-N2: settle serialized (exactly once)', n2.settleCount, 1);
    eq('F4-N2: no timer armed after settle', n2.postSettleTimers, 0);
    eq('F4-N2: no timer left active after settle', n2.timersActiveAfterSettle, 0);
  }

  // N3: intermediate exit with a LIVE grandchild — never tree-clean, the
  // descendant identity captured while ownership was provable is KEPT after
  // the ancestor exits, and only a revalidated SAME identity may be killed.
  // Finding 1: killTree now REVALIDATES the ORIGINAL identity inside the
  // helper and refuses UNKNOWN/GONE; the test never issues a bare-pid kill and
  // never kills when the gate reads false.
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
      // Finding 1: the gate must be SAME; a false gate means ZERO kill (the
      // helper would refuse anyway, but the test never even reaches for a kill
      // on an unproven identity).
      tru('F4-N3: kill authorized only after revalidation of the captured identity',
        gate3.allowed && gate3.state === 'SAME');
      // CONTROL-FLOW guard: on a false gate the kill is never issued at all
      // (the helper's refusal is the last line, not the first).
      if (gate3.allowed) {
        const kr3 = await killTree(kept); // Finding 1: pass the ORIGINAL identity
        tru('F4-N3: authorized kill of the retained grandchild succeeds', kr3.ok);
        falsy('F4-N3: an authorized SAME kill is never refused', kr3.refused);
        tru('F4-N3: grandchild proven gone after the authorized kill',
          await waitForIdentityGone(kept, 10000));
      } else {
        falsy('F4-N3: gate false => NO kill is ever issued (control-flow guard)', true);
      }
    }
    tru('F4-N3: unverified fixture retained OUTSIDE TMP', n3.retainedPath !== null
      && fs.existsSync(n3.retainedPath));
    falsy('F4-N3: original fixture dir removed from TMP after retention', fs.existsSync(n3dir));
  }

  // N3b (Finding 3): root -> intermediate -> grandchild with a HANDSHAKE. The
  // intermediate spawns the grandchild, publishes its pid, then BLOCKS
  // (Atomics.wait) until the test observes that pid captured via
  // onDescendantCaptured, and only then exits — so the proof is the capture
  // itself, NOT a padded lifetime. This closes the gap where an intermediate
  // exits before the first enumeration and the grandchild (whose
  // ParentProcessId now points at a dead intermediate, which no longer appears
  // in the live process table) is silently lost from the final walk: without
  // the handshake capture the walk returns [] and the map is empty — a FALSE
  // clean. The kept identity is what refuses it.
  {
    const n3bdir = mkdtempSync(path.join(TMP, 'n3b-'));
    const gcPidPath = path.join(n3bdir, 'grandchild.pid');
    const capturedFlag = path.join(n3bdir, 'captured.flag');
    const intermediateSrc = path.join(n3bdir, 'intermediate.js');
    // INTERMEDIATE: spawn the grandchild (detached, long-lived), publish the
    // pid, then block until the handshake capture lands, then exit.
    fs.writeFileSync(intermediateSrc,
      "const {spawn}=require('node:child_process');const fs=require('node:fs');\n"
      + "const g=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore',detached:true});\n"
      + 'fs.writeFileSync(' + JSON.stringify(gcPidPath) + ', String(g.pid));\n'
      + 'const sab=new SharedArrayBuffer(4);const arr=new Int32Array(sab);\n'
      + 'while(!fs.existsSync(' + JSON.stringify(capturedFlag) + ')){Atomics.wait(arr,0,0,250);}\n'
      + 'process.exit(0);\n');
    let n3bCapturedGrandchild = null;
    const n3b = await runManagedTree({
      // ROOT: spawn the intermediate, wait for it to exit, then exit.
      command: process.execPath,
      args: ['-e',
        "const {spawn}=require('node:child_process');"
        + 'const inter=spawn(process.execPath,[' + JSON.stringify(intermediateSrc) + '],{stdio:"ignore"});'
        + "inter.on('exit',()=>process.exit(0));"],
      retainDir: n3bdir, retainTag: 'n3b',
      timeoutMs: 30000, treeGoneTimeoutMs: 2500, trackIntervalMs: 300,
      onDescendantCaptured: (pid) => {
        try {
          if (!fs.existsSync(gcPidPath)) return; // grandchild pid not published yet
          const gp = Number(fs.readFileSync(gcPidPath, 'utf8').trim());
          if (pid === gp && n3bCapturedGrandchild === null) {
            n3bCapturedGrandchild = pid;
            fs.writeFileSync(capturedFlag, '1'); // release the intermediate to exit
          }
        } catch { /* retry next capture */ }
      },
    });
    tru('F4-N3b: grandchild identity captured through the handshake (not a lifetime guess)',
      n3bCapturedGrandchild !== null);
    tru('F4-N3b: root exited only after the intermediate (post-handshake)', n3b.code === 0 && !n3b.timedOut);
    falsy('F4-N3b: NO tree-clean claim while the grandchild lives', n3b.cleanupVerified);
    tru('F4-N3b: reason names the live descendant (kept identity) despite the broken walk',
      /^(DESC_ALIVE|DESC_UNKNOWN)/.test(n3b.treeReason));
    const keptB = n3b.descendantIdentities.find((d) => d.pid === n3bCapturedGrandchild
      && identityState(d) === 'SAME');
    tru('F4-N3b: grandchild identity KEPT after intermediate exit (still SAME)', keptB !== undefined);
    if (keptB !== undefined) {
      const gateB = killAuthorization(keptB);
      tru('F4-N3b: kill authorized only after revalidation of the captured identity',
        gateB.allowed && gateB.state === 'SAME');
      // CONTROL-FLOW guard: a false gate issues no kill at all.
      if (gateB.allowed) {
        const krB = await killTree(keptB); // Finding 1: identity-based, self-revalidated
        tru('F4-N3b: authorized kill of the handshake grandchild succeeds', krB.ok);
        falsy('F4-N3b: an authorized SAME kill is never refused', krB.refused);
        tru('F4-N3b: grandchild proven gone after the authorized kill',
          await waitForIdentityGone(keptB, 10000));
      } else {
        falsy('F4-N3b: gate false => NO kill is ever issued (control-flow guard)', true);
      }
    }
    tru('F4-N3b: unverified fixture retained OUTSIDE TMP', n3b.retainedPath !== null
      && fs.existsSync(n3b.retainedPath));
    falsy('F4-N3b: original fixture dir removed from TMP after retention', fs.existsSync(n3bdir));
  }

  // N3c (Finding 3 rework): intermediate exits BEFORE the first enumeration
  // captured the grandchild. The ParentProcessId chain is broken, the captured
  // map stays empty and the final walk returns [] — while the grandchild is
  // still ALIVE. The ONLY thing that can still prove completeness here is the
  // ENFORCED registration handshake: the grandchild registers {pid,
  // startTime} before the intermediate may exit, and with `registryPath` on,
  // `clean` requires every registered identity proven GONE (a missing registry
  // is fail-closed too). walk=[] can therefore never read as a false clean —
  // cleanupVerified MUST stay false and the fixture is retained.
  {
    const n3cdir = mkdtempSync(path.join(TMP, 'n3c-'));
    const registryPath = path.join(n3cdir, 'registry.json');
    const interSrc = path.join(n3cdir, 'intermediate.js');
    const gcSrc = path.join(n3cdir, 'grandchild.js');
    // GRANDCHILD: registers itself FIRST (pid + machine creation time), then lives.
    // Finding 1 (rework 4): the registry timestamp must come from the SAME
    // source as identityState's revalidation (Win32_Process CreationDate as
    // lossless digit ticks) — a cross-source read would mismatch a LIVING
    // grandchild into GONE and defeat the registry gate entirely.
    fs.writeFileSync(gcSrc,
      "const {execFileSync}=require('node:child_process');const fs=require('node:fs');\n"
      + "const st=execFileSync('powershell',['-NoProfile','-Command',"
      + "'(Get-CimInstance Win32_Process -Filter (\\'ProcessId=' + process.pid + '\\')).CreationDate.ToFileTimeUtc().ToString()'],"
      + "{encoding:'utf8'}).trim();\n"
      + 'fs.writeFileSync(' + JSON.stringify(registryPath) + ','
      + ' JSON.stringify([{pid:process.pid,startTime:st}]));\n'
      + 'setTimeout(function(){},60000);\n');
    // INTERMEDIATE: spawn the grandchild, wait for the REGISTRATION to land,
    // then exit immediately — before any descendant sampling can capture it.
    fs.writeFileSync(interSrc,
      "const {spawn}=require('node:child_process');const fs=require('node:fs');\n"
      + 'spawn(process.execPath,[' + JSON.stringify(gcSrc) + '],{stdio:\'ignore\',detached:true});\n'
      + 'const sab=new SharedArrayBuffer(4);const arr=new Int32Array(sab);\n'
      + 'while(!fs.existsSync(' + JSON.stringify(registryPath) + ')){Atomics.wait(arr,0,0,100);}\n'
      + 'process.exit(0);\n');
    const n3c = await runManagedTree({
      // ROOT: spawn the intermediate, wait for it to exit, linger, then exit.
      command: process.execPath,
      args: ['-e',
        "const {spawn}=require('node:child_process');"
        + 'const i=spawn(process.execPath,[' + JSON.stringify(interSrc) + '],{stdio:"ignore"});'
        + "i.on('exit',()=>setTimeout(()=>process.exit(0),1000));"],
      retainDir: n3cdir, retainTag: 'n3c', registryPath,
      timeoutMs: 30000, treeGoneTimeoutMs: 2500,
      trackIntervalMs: 60000, // FIRST sampling pass only after settle: capture never races (0 passes before settle)
    });
    falsy('F4-N3c: NO tree-clean claim while the registered grandchild lives', n3c.cleanupVerified);
    eq('F4-N3c: walk came back empty + map empty (capture happened before this test only) — registry blocks the false clean',
      n3c.descendantCount, 0);
    eq('F4-N3c: reason is the registry completeness failure (walk [] is never proof)', n3c.treeReason, 'REGISTRY_ALIVE');
    // Read the registration from the RETAINED fixture (unverified => moved out
    // of TMP as a whole) and prove the grandchild really is still alive.
    const regPath = path.join(n3c.retainedPath || n3cdir, 'registry.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    eq('F4-N3c: exactly one registered descendant', reg.length, 1);
    const gcIdent = { pid: Number(reg[0].pid), startTime: String(reg[0].startTime) };
    eq('F4-N3c: registered grandchild is ALIVE at assertion time (the case under test)',
      identityState(gcIdent), 'SAME');
    const gateC = killAuthorization(gcIdent);
    tru('F4-N3c: kill authorized only after revalidation of the registered identity',
      gateC.allowed && gateC.state === 'SAME');
    if (gateC.allowed) {
      const krC = await killTree(gcIdent);
      tru('F4-N3c: authorized kill of the registered grandchild succeeds', krC.ok);
      tru('F4-N3c: registered grandchild proven gone after the authorized kill',
        await waitForIdentityGone(gcIdent, 10000));
    } else {
      falsy('F4-N3c: gate false => NO kill is ever issued (control-flow guard)', true);
    }
    tru('F4-N3c: unverified fixture retained OUTSIDE TMP', n3c.retainedPath !== null
      && fs.existsSync(regPath));
    falsy('F4-N3c: original fixture dir removed from TMP after retention', fs.existsSync(n3cdir));
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
    // Reclaim OUR survivor using the ORIGINAL root identity captured at spawn
    // (Finding 1). Recapturing the current pid here would only prove "some
    // process with this pid is alive" — NOT that it is still the child we
    // spawned (PID reuse). Revalidating the original identity is the proof.
    tru('F4-N4: original root identity was captured at spawn', n4.identityCaptured);
    const reclaimGate = killAuthorization(n4.rootIdentity);
    eq('F4-N4: survivor still the SAME identity we spawned (original revalidated)',
      reclaimGate.state, 'SAME');
    const reclaim = await killTree(n4.rootIdentity); // Finding 1: identity-based, self-revalidated
    tru('F4-N4: reclaim kill succeeded', reclaim.ok);
    tru('F4-N4: survivor proven gone after reclaim',
      await waitForIdentityGone(n4.rootIdentity, 10000));
    // Finding 4: the lifecycle helper OWNS the keep/remove decision. n4 was NOT
    // fully proven, so its fixture is already retained (moved OUT of TMP above);
    // an unconditional rmSync(n4dir) here would silently delete that state in
    // the fallback case where retention kept the ORIGINAL in-TMP path.
    tru('F4-N4: unverified fixture retained by the helper (caller never deletes)',
      n4.retainedPath !== null && fs.existsSync(n4.retainedPath));
  }

  // N5 (Finding 2, rework 5): the returned result is a STABLE SNAPSHOT and the
  // late kill callback is proven by a HANDSHAKE, never a padded lifetime. The
  // child BLOCKS on an exit flag (no self-exit timer), so the ordering is
  // deterministic: lifecycle starts -> timeout fires and the authorized kill is
  // issued while the kill promise is held PENDING under test control [M1] ->
  // ONLY THEN the child is released -> close -> settle hands out the frozen
  // snapshot [M2] -> the callback is released -> the audit lands on the LIVE
  // record [M3]. Every milestone has a bounded deadline; identity authorization
  // is never bypassed and no sleep/lifetime stretch stands in for the handshake.
  {
    const n5dir = mkdtempSync(path.join(TMP, 'n5-'));
    const exitFlag = path.join(n5dir, 'exit.flag');
    let live5 = null;
    let releaseKill = null;
    // Bounded poll on the LIVE record — a fixed sleep is never the proof.
    const awaitMilestone = async (pred, ms) => {
      let w = 0;
      while (!(live5 !== null && pred(live5)) && w < ms) { await sleep(50); w += 50; }
      return live5 !== null && pred(live5);
    };
    const n5Promise = runManagedTree({
      command: process.execPath,
      args: ['-e',
        "const fs=require('node:fs');const sab=new SharedArrayBuffer(4);const arr=new Int32Array(sab);"
        + 'while(!fs.existsSync(' + JSON.stringify(exitFlag) + ')){Atomics.wait(arr,0,0,50);}'
        + 'process.exit(0);'],
      retainDir: n5dir, retainTag: 'n5',
      timeoutMs: 600, killDeadlineMs: 60000, treeGoneTimeoutMs: 3000, trackIntervalMs: 400,
      onResult: (r) => { live5 = r; },
      // Held pending: only a deliberate release below can complete this kill.
      deps: { kill: () => new Promise((res) => { releaseKill = res; }) },
    });
    // [M1] kill-issued: the timeout fired and the authorized kill was issued
    // while the child is STILL alive (blocked on the exit flag) — the kill
    // promise is pending and cannot have settled anything.
    const killIssued = await awaitMilestone((r) => r.killGate.attempted, 20000);
    tru('F4-N5 [M1]: timeout fired and the authorized kill was issued while the child was still alive',
      killIssued && live5.timedOut && live5.killGate.allowed && live5.killGate.state === 'SAME');
    tru('F4-N5 [M1]: the kill promise is still PENDING under test control (nothing settled yet)',
      typeof releaseKill === 'function' && live5.killRecord.attempted === false && live5.settleCount === 0);
    // [M2] release the child ONLY after the kill was issued, then await settle.
    writeFileSync(exitFlag, '1', 'utf8');
    const n5 = await n5Promise;
    tru('F4-N5 [M2]: child released after the kill was issued and exited on its own',
      n5.code === 0 && n5.timedOut && n5.finishedBy === 'close');
    tru('F4-N5 [M2]: tracked cleanup proven (root + captured identities gone)', n5.trackedCleanupVerified);
    eq('F4-N5 [M2]: no handshake => completeness UNKNOWN (walk-empty never promoted)',
      n5.treeCompleteness, 'UNKNOWN');
    falsy('F4-N5 [M2]: no tree-clean claim without a completeness proof', n5.cleanupVerified);
    tru('F4-N5 [M2]: unverified fixture retained by the helper (caller never deletes)',
      n5.retainedPath !== null && fs.existsSync(n5.retainedPath));
    eq('F4-N5 [M2]: settle exactly once at snapshot time', n5.settleCount, 1);
    eq('F4-N5 [M2]: no timer left active after settle', n5.timersActiveAfterSettle, 0);
    const frozen = JSON.stringify(n5);
    // [M3] release the callback AFTER the snapshot: it must still run and be
    // audited on the LIVE record, while the resolved snapshot cannot move.
    if (typeof releaseKill === 'function') {
      releaseKill({ ok: true, error: '' });
      const audited = await awaitMilestone((r) => r.killRecord.attempted && r.killRecord.ok, 10000);
      tru('F4-N5 [M3]: late kill callback ran and was audited on the LIVE record (never swallowed)', audited);
    }
    eq('F4-N5: returned snapshot byte-identical after the late callback',
      JSON.stringify(n5), frozen);
    eq('F4-N5: exactly one settle despite the late callback', n5.settleCount, 1);
    eq('F4-N5: no timer armed after settle (late callback arms nothing)',
      n5.postSettleTimers, 0);
    eq('F4-N5: live audit — exactly one settle on the LIVE record', live5.settleCount, 1);
    eq('F4-N5: live audit — no timer armed after settle on the LIVE record', live5.postSettleTimers, 0);
    eq('F4-N5: live audit — no timer left active after settle on the LIVE record',
      live5.timersActiveAfterSettle, 0);
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

  // OWN1 (Finding 1): ROOT PID REUSE between spawn and snapshot — the
  // snapshot's root row carries a DIFFERENT creation timestamp than the
  // ORIGINAL captured identity, so the snapshot's root is FOREIGN: nothing
  // from it is captured and nothing derived from it is ever killed.
  // Finding 1 (rework 4): the capture is a VALID lossless timestamp exactly
  // ONE tick away from the row's — the old +/-1000-tick window would have
  // called this SAME, so this case is the near-boundary regression proof for
  // exact equality.
  {
    const foreignPid = 424242;
    const killedPids = [];
    const own1dir = mkdtempSync(path.join(TMP, 'own1-'));
    const own1 = await runManagedTree({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 600);'],
      retainDir: own1dir, retainTag: 'own1',
      timeoutMs: 30000, treeGoneTimeoutMs: 800, trackIntervalMs: 100,
      deps: {
        identityState: () => 'GONE', // injected: root proven gone (pid reused)
        // valid digit ticks, ONE tick before the snapshot row (near-boundary)
        captureIdentity: (pid) => ({ pid: Number(pid), startTime: '42424242424241' }),
        listDescendants: async (rootPid) => ({
          rootRow: { ProcessId: rootPid, ParentProcessId: 0, CreationTime: 42424242424242 },
          rows: [
            { ProcessId: rootPid, ParentProcessId: 0, CreationTime: 42424242424242 },
            { ProcessId: foreignPid, ParentProcessId: rootPid, CreationTime: 777000111000 },
          ],
        }),
        kill: (id) => { killedPids.push(id.pid); return Promise.resolve({ ok: true, error: '' }); },
      },
    });
    eq('F4-OWN1: foreign-root snapshot is reported as ROOT_PID_REUSED (never proven)',
      own1.treeReason, 'ROOT_PID_REUSED');
    eq('F4-OWN1: discovery ownership state recorded', own1.discoveryOwner, 'ROOT_PID_REUSED');
    eq('F4-OWN1: NOTHING captured from a foreign-root snapshot', own1.descendantCount, 0);
    eq('F4-OWN1: no identity recorded at all (the foreign row is never ours)',
      own1.descendantIdentities.length, 0);
    falsy('F4-OWN1: NO tree-clean claim from a foreign-root snapshot', own1.cleanupVerified);
    falsy('F4-OWN1: no kill issued at all in this run', own1.killGate.attempted);
    tru('F4-OWN1: the foreign pid was never killed', !killedPids.includes(foreignPid));
    tru('F4-OWN1: unverified fixture retained OUTSIDE TMP', own1.retainedPath !== null
      && fs.existsSync(own1.retainedPath));
    falsy('F4-OWN1: original fixture dir removed from TMP after retention', fs.existsSync(own1dir));
  }

  // OWN2 (Finding 1): DESCENDANT PID REUSE between snapshot and capture — the
  // snapshot row's creation timestamp no longer matches the freshly captured
  // identity, so that (now foreign) process is never recorded as our
  // descendant and never killable as ours; the non-empty walk still blocks a
  // clean claim.
  {
    const reusedPid = 434343;
    const killedPids = [];
    let firstCapture = true;
    const own2dir = mkdtempSync(path.join(TMP, 'own2-'));
    const own2 = await runManagedTree({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 600);'],
      retainDir: own2dir, retainTag: 'own2',
      timeoutMs: 30000, treeGoneTimeoutMs: 800, trackIntervalMs: 100,
      deps: {
        identityState: () => 'GONE',
        // First capture call IS the root (captureId(child.pid) at spawn):
        // root matches the snapshot root row; any descendant reads a NEW
        // creation time (the pid was reused between snapshot and capture).
        captureIdentity: (pid) => {
          const isRoot = firstCapture;
          firstCapture = false;
          return { pid: Number(pid), startTime: isRoot ? '1110000' : '9990000' };
        },
        listDescendants: async (rootPid) => ({
          rootRow: { ProcessId: rootPid, ParentProcessId: 0, CreationTime: 1110000 },
          rows: [
            { ProcessId: rootPid, ParentProcessId: 0, CreationTime: 1110000 },
            { ProcessId: reusedPid, ParentProcessId: rootPid, CreationTime: 2220000 },
          ],
        }),
        kill: (id) => { killedPids.push(id.pid); return Promise.resolve({ ok: true, error: '' }); },
      },
    });
    eq('F4-OWN2: reused-descendant row is NEVER recorded as ours',
      own2.descendantCount, 0);
    eq('F4-OWN2: no identity recorded for the reused pid',
      own2.descendantIdentities.length, 0);
    eq('F4-OWN2: the non-empty walk still blocks a clean claim (DISCOVERY_NONEMPTY)',
      own2.treeReason, 'DISCOVERY_NONEMPTY');
    falsy('F4-OWN2: NO tree-clean claim', own2.cleanupVerified);
    tru('F4-OWN2: the reused pid was never killed', !killedPids.includes(reusedPid));
    tru('F4-OWN2: unverified fixture retained OUTSIDE TMP', own2.retainedPath !== null
      && fs.existsSync(own2.retainedPath));
    falsy('F4-OWN2: original fixture dir removed from TMP after retention', fs.existsSync(own2dir));
  }

  // OWN3 (Finding 2): settle CLOSES sampling admission. A handshake keeps the
  // child alive until the FIRST discovery pass is provably IN FLIGHT, so the
  // sequence is deterministic: pass pending => child exits => settle starts
  // (admission closed, tracker cleared) => settle DRAINS the pending pass =>
  // evaluate on the frozen state => result never changes afterwards.
  {
    const own3dir = mkdtempSync(path.join(TMP, 'own3-'));
    const goFlag = path.join(own3dir, 'go.flag');
    let snapCalls = 0;
    let release = null;
    const pending = new Promise((r) => { release = r; });
    let own3 = null;
    const own3Promise = runManagedTree({
      command: process.execPath,
      args: ['-e',
        "const fs=require('node:fs');const sab=new SharedArrayBuffer(4);const arr=new Int32Array(sab);"
        + 'while(!fs.existsSync(' + JSON.stringify(goFlag) + ')){Atomics.wait(arr,0,0,50);}'
        + 'process.exit(0);'],
      retainDir: own3dir, retainTag: 'own3',
      timeoutMs: 30000, treeGoneTimeoutMs: 3000, trackIntervalMs: 100,
      onResult: (r) => { own3 = r; },
      deps: {
        listDescendants: async () => {
          snapCalls += 1;
          if (snapCalls === 1) await pending; // the first pass stays IN FLIGHT
          return { rootRow: null, rows: [] };
        },
      },
    });
    // 1) Wait until the first discovery pass is provably pending.
    let waited = 0;
    while (snapCalls < 1 && waited < 15000) { await sleep(50); waited += 50; }
    tru('F4-OWN3: first discovery pass is IN FLIGHT before the child exits', snapCalls >= 1);
    // 2) Release the child => close => settle starts while that pass is pending.
    writeFileSync(goFlag, '1');
    waited = 0;
    while (own3 !== null && !own3.settleStarted && waited < 10000) { await sleep(50); waited += 50; }
    tru('F4-OWN3: settle STARTED (admission closed) while the first pass is still pending',
      own3 !== null && own3.settleStarted === true);
    tru('F4-OWN3: settle is still DRAINING the pending pass (child already exited, no verdict yet)',
      own3 !== null && own3.settleCount === 0 && own3.code !== null);
    // 3) Admission is closed: a direct pass request must be refused, and the
    //    cleared tracker must not fire either — snapCalls stays where it is.
    const callsBefore = snapCalls;
    if (own3 !== null) own3.sampleNow();
    await sleep(250); // several tracker periods (100ms) have passed
    eq('F4-OWN3: NO new sampling pass after admission closed (tracker cleared + guard)',
      snapCalls, callsBefore);
    // 4) Let the drained pass land => settle may conclude now.
    release(null);
    waited = 0;
    while (own3 !== null && own3.settleCount === 0 && waited < 10000) { await sleep(50); waited += 50; }
    const own3Result = await own3Promise;
    eq('F4-OWN3: exactly one settle after the drain', own3Result.settleCount, 1);
    tru('F4-OWN3: the run still concludes honestly (root gone, tracked cleanup proven)',
      own3Result.trackedCleanupVerified === true);
    eq('F4-OWN3: walk came back empty yet no handshake => completeness UNKNOWN (never promoted)',
      own3Result.treeCompleteness, 'UNKNOWN');
    falsy('F4-OWN3: no tree-clean claim without a completeness proof', own3Result.cleanupVerified);
    tru('F4-OWN3: UNKNOWN completeness keeps the fixture for recovery (no false removal)',
      own3Result.retainedPath !== null && fs.existsSync(own3Result.retainedPath));
    const frozen = JSON.stringify(own3Result);
    await sleep(300);
    eq('F4-OWN3: result unchanged after resolve (nothing may mutate post-settle)',
      JSON.stringify(own3Result), frozen);
    eq('F4-OWN3: no timer armed after settle', own3Result.postSettleTimers, 0);
    eq('F4-OWN3: no timer left active after settle', own3Result.timersActiveAfterSettle, 0);
  }

  // OWN4 (Finding 1, rework 4): ABSENT ROOT + proven-GONE identity is only a
  // WALK proof, never a CAPTURE proof. The root pid is free for reuse, so a
  // row whose ParentProcessId still points at the dead root may belong to an
  // UNRELATED process that inherited the recycled pid: nothing new is captured,
  // no foreign pid is ever killed, the run never reads tree-clean, and the
  // fixture is retained. The walk itself still runs at evaluate time, so the
  // non-empty unattributable discovery keeps the verdict NOT-CLEAN
  // (DISCOVERY_NONEMPTY) instead of silently becoming an empty, "clean" walk.
  {
    const foreignPid = 515151; // claims the dead root as its parent
    const killedPids = [];
    const own4dir = mkdtempSync(path.join(TMP, 'own4-'));
    const own4 = await runManagedTree({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 600);'],
      retainDir: own4dir, retainTag: 'own4',
      timeoutMs: 30000, treeGoneTimeoutMs: 800, trackIntervalMs: 100,
      deps: {
        identityState: () => 'GONE', // injected: root identity proven GONE
        captureIdentity: (pid) => ({ pid: Number(pid), startTime: '100000000000000001' }),
        listDescendants: async (rootPid) => ({
          rootRow: null, // root ABSENT from the snapshot — pid free for reuse
          rows: [
            { ProcessId: foreignPid, ParentProcessId: rootPid, CreationTime: '100000000000770000' },
          ],
        }),
        kill: (id) => { killedPids.push(id.pid); return Promise.resolve({ ok: true, error: '' }); },
      },
    });
    eq('F4-OWN4: absent root + GONE is recorded as a walk proof only',
      own4.discoveryOwner, 'PROVEN_ROOT_ABSENT');
    eq('F4-OWN4: NOTHING newly captured from the absent-root snapshot',
      own4.descendantCount, 0);
    eq('F4-OWN4: no identity recorded for the PPID-claiming row',
      own4.descendantIdentities.length, 0);
    eq('F4-OWN4: the non-empty discovery still blocks the verdict (DISCOVERY_NONEMPTY)',
      own4.treeReason, 'DISCOVERY_NONEMPTY');
    falsy('F4-OWN4: NO tree-clean claim', own4.cleanupVerified);
    falsy('F4-OWN4: no kill issued at all in this run', own4.killGate.attempted);
    tru('F4-OWN4: the PPID-claiming foreign pid was never killed',
      !killedPids.includes(foreignPid));
    tru('F4-OWN4: unverified fixture retained OUTSIDE TMP', own4.retainedPath !== null
      && fs.existsSync(own4.retainedPath));
    falsy('F4-OWN4: original fixture dir removed from TMP after retention', fs.existsSync(own4dir));
  }

  // OWN5 (Finding 1, rework 4): exact same-source equality, unit level.
  // Identical lossless digit ticks are SAME; a ONE-tick difference is a
  // DIFFERENT incarnation — the removed 1000-tick tolerance window would have
  // matched it (that is the pid-reuse hole this closes). Null/lost captures
  // and non-digit data can never compare as ours (F5: no coercion).
  {
    const CT = '133800000000000016';
    eq('F4-OWN5: identical lossless timestamps from the same source are SAME',
      sameCreationTime(CT, CT), true);
    falsy('F4-OWN5: one-tick difference (near-boundary) is NOT the same process',
      sameCreationTime(CT, '133800000000000017'));
    falsy('F4-OWN5: 1000-tick difference is NOT the same process (the old window matched this)',
      sameCreationTime(CT, '133800000000001016'));
    falsy('F4-OWN5: null capture time never matches', sameCreationTime(CT, null));
    falsy('F4-OWN5: lost/non-digit capture never matches', sameCreationTime(CT, 'ORIG-CAPTURE-TS'));
    falsy('F4-OWN5: fractional number is not an identity', sameCreationTime(CT, 1.5));
    tru('F4-OWN5: parser accepts lossless digit strings',
      Array.isArray(parseProcessTable('[{"ProcessId":1,"ParentProcessId":0,"CreationTime":"133800000000000016"}]')));
    eq('F4-OWN5: parser still rejects a non-digit CreationTime',
      parseProcessTable('[{"ProcessId":1,"ParentProcessId":0,"CreationTime":"abc"}]'), null);
    eq('F4-OWN5: parser still rejects a fractional CreationTime',
      parseProcessTable('[{"ProcessId":1,"ParentProcessId":0,"CreationTime":1.5}]'), null);
  }

  // FINDING 3 — negative: an EMPTY walk with NO completeness proof is never
  // promoted to PROVEN. No handshake is configured; the owned tree walks empty
  // on a valid snapshot and the root identity is GONE — exactly the shape a real
  // binary probe produces. tracked cleanup is still proven, but completeness
  // MUST stay UNKNOWN and the fixture is kept for recovery.
  {
    const npDir = mkdtempSync(path.join(TMP, 'comp-np-'));
    const np = await runManagedTree({
      command: process.execPath,
      args: ['-e', "process.stdout.write('COMP_NP');"],
      retainDir: npDir, retainTag: 'comp-np',
      timeoutMs: 30000, treeGoneTimeoutMs: 1500, trackIntervalMs: 400,
      // no registryPath: no enforced handshake => no completeness proof exists
    });
    eq('F4-COMP-1: the discovery walk really came back EMPTY on a valid snapshot',
      np.discovery, 'EMPTY');
    eq('F4-COMP-1: evaluate found nothing on the walk (reason empty)', np.treeReason, '');
    tru('F4-COMP-1: tracked cleanup (root + captured identities gone) IS proven',
      np.trackedCleanupVerified);
    eq('F4-COMP-1: walk-empty is NEVER promoted to PROVEN without a proof',
      np.treeCompleteness, 'UNKNOWN');
    falsy('F4-COMP-1: no tree-clean claim without a completeness proof', np.cleanupVerified);
    tru('F4-COMP-1: recovery fixture retained OUTSIDE TMP', np.retainedPath !== null
      && fs.existsSync(np.retainedPath));
    falsy('F4-COMP-1: original fixture dir removed from TMP after retention',
      fs.existsSync(npDir));
  }

  // FINDING 3 — positive: the ONLY thing that earns a completeness PROVEN is a
  // REAL proof — the ENFORCED registration handshake. The grandchild registers
  // {pid, startTime} (same Win32 source as identityState) before its parent may
  // exit, then dies on its own; by settle the registry entry is proven GONE and
  // the walk is empty, so with `registryPath` configured completeness is PROVEN,
  // cleanupVerified is true and the fully-proven fixture is removed.
  {
    const cpDir = mkdtempSync(path.join(TMP, 'comp-pos-'));
    const cpRegistry = path.join(cpDir, 'registry.json');
    const cpGcSrc = path.join(cpDir, 'grandchild.js');
    const cpInterSrc = path.join(cpDir, 'intermediate.js');
    // GRANDCHILD: register itself FIRST (pid + machine creation time, same source
    // as identityState's revalidation), then exit on its own after a short life.
    fs.writeFileSync(cpGcSrc,
      "const {execFileSync}=require('node:child_process');const fs=require('node:fs');\n"
      + "const st=execFileSync('powershell',['-NoProfile','-Command',"
      + "'(Get-CimInstance Win32_Process -Filter (\\'ProcessId=' + process.pid + '\\')).CreationDate.ToFileTimeUtc().ToString()'],"
      + "{encoding:'utf8'}).trim();\n"
      + 'fs.writeFileSync(' + JSON.stringify(cpRegistry) + ','
      + ' JSON.stringify([{pid:process.pid,startTime:st}]));\n'
      + 'setTimeout(function(){}, 600);\n');
    // INTERMEDIATE: spawn the grandchild, wait for the REGISTRATION to land, then
    // exit immediately (before any descendant sampling can capture it).
    fs.writeFileSync(cpInterSrc,
      "const {spawn}=require('node:child_process');const fs=require('node:fs');\n"
      + 'spawn(process.execPath,[' + JSON.stringify(cpGcSrc) + '],{stdio:\'ignore\',detached:true});\n'
      + 'const sab=new SharedArrayBuffer(4);const arr=new Int32Array(sab);\n'
      + 'while(!fs.existsSync(' + JSON.stringify(cpRegistry) + ')){Atomics.wait(arr,0,0,100);}\n'
      + 'process.exit(0);\n');
    const cp = await runManagedTree({
      // ROOT: spawn the intermediate, wait for it to exit, linger, then exit.
      command: process.execPath,
      args: ['-e',
        "const {spawn}=require('node:child_process');"
        + 'const i=spawn(process.execPath,[' + JSON.stringify(cpInterSrc) + '],{stdio:"ignore"});'
        + "i.on('exit',()=>setTimeout(()=>process.exit(0),1500));"],
      retainDir: cpDir, retainTag: 'comp-pos', registryPath: cpRegistry,
      timeoutMs: 30000, treeGoneTimeoutMs: 5000,
      trackIntervalMs: 60000, // FIRST sampling pass only after settle: capture never races
    });
    tru('F4-COMP-2: tracked cleanup proven (root + captured identities gone)',
      cp.trackedCleanupVerified);
    eq('F4-COMP-2: enforced handshake all-GONE + empty walk => completeness PROVEN',
      cp.treeCompleteness, 'PROVEN');
    tru('F4-COMP-2: cleanup fully verified only WITH the completeness proof', cp.cleanupVerified);
    eq('F4-COMP-2: fully proven run removes its fixture (no false retention)', cp.retainedPath, null);
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
      // R3 gate (Finding 3, operator option A): a probe result only counts
      // when the run exited cleanly AND no spawn error occurred AND no timeout
      // fired AND TRACKED CLEANUP was proven — the root identity revalidated
      // GONE and every captured identity revalidated GONE. The real opencode
      // binary cannot run a registration handshake, so it has NO completeness
      // proof: `treeCompleteness` is reported separately below and MUST read
      // UNKNOWN — it NEVER greens or reddens a permission case. A root/captured
      // identity that is UNKNOWN or still alive still fails this gate and keeps
      // state. A marker string alone can never turn a case green.
      const okRun = (r) => r.code === 0 && r.spawnError === '' && !r.timedOut && r.trackedCleanupVerified;
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
      // ---- PART B completeness report (Finding 3, operator option A) ----
      // The permission cases above gate ONLY on tracked cleanup (root +
      // captured identities GONE) plus exit/marker/timeout. Tree-completeness
      // for the arbitrary opencode binary tree is reported here SEPARATELY: the
      // real binary cannot run a registration handshake, so it has NO
      // completeness proof — the verdict MUST be UNKNOWN (a walk that merely
      // came back empty is never promoted to PROVEN), an UNKNOWN KEEPS the
      // probe fixture for recovery (no silent state loss, no "tree clean"
      // claim), and it must never be what failed a permission assertion above.
      for (const probeEntry of [['pre-fix', preRun], ['post-fix', postRun], ['secret deny', envRun],
        ['swapped allow', swapFileRun], ['swapped order-flip', swapEnvRun]]) {
        const probeName = probeEntry[0];
        const probeRun = probeEntry[1];
        tru('GPT-REV-137 probe completeness (' + probeName + '): tracked cleanup proven (root + every captured identity GONE)',
          probeRun.trackedCleanupVerified === true);
        eq('GPT-REV-137 probe completeness (' + probeName + '): no completeness proof => UNKNOWN (walk-empty never PROVEN)',
          probeRun.treeCompleteness, 'UNKNOWN');
        falsy('GPT-REV-137 probe completeness (' + probeName + '): UNKNOWN completeness never claims tree-clean',
          probeRun.cleanupVerified);
        tru('GPT-REV-137 probe completeness (' + probeName + '): UNKNOWN completeness KEEPS the fixture for recovery',
          probeRun.retainedPath !== null && fs.existsSync(probeRun.retainedPath));
        PROBE_RECOVERY_PATHS.push(probeRun.retainedPath);
      }
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
      // Finding 3: the cleanup dimension of this gate is TRACKED cleanup
      // (root + captured identities gone) — UNKNOWN/alive must still reject.
      falsy('GPT-REV-137 C1d: nonzero exit rejected by okRun gate',
        okRun({ code: 1, spawnError: '', timedOut: false, trackedCleanupVerified: true }));
      falsy('GPT-REV-137 C1d: spawn error rejected by okRun gate',
        okRun({ code: 0, spawnError: 'boom', timedOut: false, trackedCleanupVerified: true }));
      falsy('GPT-REV-137 C1d: timeout rejected by okRun gate',
        okRun({ code: 0, spawnError: '', timedOut: true, trackedCleanupVerified: true }));
      falsy('GPT-REV-137 C1d: unproven tracked cleanup (root/captured UNKNOWN or alive) rejected by okRun gate',
        okRun({ code: 0, spawnError: '', timedOut: false, trackedCleanupVerified: false }));
      tru('GPT-REV-137 C1e: okRun gate passes only a fully clean run',
        okRun({ code: 0, spawnError: '', timedOut: false, trackedCleanupVerified: true }));
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
      // Finding 4: the seamRoot is registered for retention by a guarded finally
      // (withSeamRetention) — if the cleanup below throws, a seamRoot still on
      // disk is unresolved state and must not be left for the sweep to delete.
      // runCleanupSequence still runs the mock close afterwards.
      serviceCleanup: async () => withSeamRetention(seamRoot, async () => {
        if (!(seamEnv && (seamPort !== null || startAttemptPort !== null))) {
          // Finding 4 (rework): unresolved state is RETAINED out of TMP — a
          // log line alone let the later sweep delete exactly this state.
          if (seamRoot && !retainSeamState(seamRoot, 'seam-unowned')) {
            console.log('GPT-REV-137 cleanup: no owned seam service; nothing to retain (' + seamRoot + ')');
          }
          return;
        }
        const out = await cleanupSyntheticService({
          seamEnv, seamPort, startAttemptPort, serviceIdentity, seamRoot,
        });
        eq('GPT-REV-137 cleanup: synthetic service stop exit 0', out.stopError, '');
        eq('GPT-REV-137 cleanup: synthetic service port CLOSED after stop (tri-state probe)', out.portState, 'CLOSED');
        // identity missing => death cannot be proven => fail-closed (state KEPT)
        tru('GPT-REV-137 cleanup: synthetic service process gone (identity-checked pid+creationTime)', out.serviceGone);
        // Finding 4 (rework): a seamRoot the cleanup could NOT remove is
        // unresolved state — register it with retention, never just log it.
        if (!out.removed && !retainSeamState(seamRoot, 'seam-unclean')) {
          console.log('GPT-REV-137 cleanup: synthetic state could not be retained: ' + seamRoot);
        }
      }),
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

// ---- F5: retention rename-failure fallback copies OUT of TMP ----------------
// A transient rename failure (locked/held handle) must NOT leave the fixture
// inside TMP — the fallback copies it to RETAINED_ROOT and drops the source,
// so the sweep can never destroy the very state retention claims to keep.
{
  const fbDir = mkdtempSync(path.join(TMP, 'f5-fallback-'));
  writeFileSync(path.join(fbDir, 'keep.txt'), 'unresolved-recovery-state', 'utf8');
  const realRename = fs.renameSync;
  let renameCalls = 0;
  fs.renameSync = () => { renameCalls += 1; throw new Error('injected rename failure'); };
  let keptPath = null;
  try {
    keptPath = retainFixture(fbDir, 'f5fb');
  } finally {
    fs.renameSync = realRename; // restore immediately
  }
  tru('F5 fallback: rename was attempted then failed', renameCalls === 1);
  tru('F5 fallback: retained path is OUTSIDE TMP (copy fallback, not in-place keep)',
    keptPath !== null && !insideTmp(keptPath) && !String(keptPath).includes('retain failed'));
  tru('F5 fallback: fixture content survived the copy', fs.existsSync(path.join(keptPath, 'keep.txt')));
  falsy('F5 fallback: original TMP source removed after the copy', fs.existsSync(fbDir));
}

// ---- F5 seam: an unresolved seamRoot is RETAINED, never just logged ----------
// Finding 4 (rework): startup/cleanup failures used to log "KEPT" while the
// fixture stayed inside TMP for the sweep to delete. Registration means the
// seamRoot is actually relocated out of TMP.
{
  const srDir = mkdtempSync(path.join(TMP, 'seamreg-'));
  writeFileSync(path.join(srDir, 'service.state'), 'unresolved-service-state', 'utf8');
  const keptSeam = retainSeamState(srDir, 'seamreg-test');
  tru('F5 seam: unresolved seamRoot retained OUTSIDE TMP (registered, not just logged)',
    keptSeam !== null && !insideTmp(keptSeam));
  tru('F5 seam: seamRoot content survived retention', fs.existsSync(path.join(keptSeam, 'service.state')));
  falsy('F5 seam: original seamRoot gone from TMP after retention', fs.existsSync(srDir));
  eq('F5 seam: seamRoot === TMP is never relocated (guard returns null)', retainSeamState(TMP, 'never'), null);
  tru('F5 seam: TMP itself is untouched by the guard', fs.existsSync(TMP));
  eq('F5 seam: missing seamRoot registers nothing', retainSeamState(path.join(TMP, 'does-not-exist-xyz'), 'never'), null);
}

// ---- F5 double-failure: rename + copy + relocate ALL fail --------------------
// Finding 4 (rework): the record keeps the ORIGINAL path (structured {path,
// error} — never a path-annotated string), the teardown terminates FINITE
// (snapshot iteration, no append-while-iterating growth), and the sweep is
// SKIPPED by REAL control flow so the unresolved state survives.
{
  const dfDir = mkdtempSync(path.join(TMP, 'f5-double-'));
  writeFileSync(path.join(dfDir, 'keep.txt'), 'survives-double-failure', 'utf8');
  const realRename = fs.renameSync;
  const realCopy = fs.cpSync;
  const boomRename = () => { throw new Error('injected rename failure'); };
  const boomCopy = () => { throw new Error('injected copy failure'); };
  fs.renameSync = boomRename;
  fs.cpSync = boomCopy;
  let dfKept = null;
  try {
    dfKept = retainFixture(dfDir, 'f5double');
  } finally {
    fs.renameSync = realRename;
    fs.cpSync = realCopy;
  }
  eq('F5 double: original REAL path returned (no path-annotation string)', dfKept, dfDir);
  const dfRecord = RETAINED.find((r) => r.path === dfDir);
  tru('F5 double: structured {path, error} record kept',
    dfRecord !== undefined && dfRecord.error !== null
    && String(dfRecord.error).includes('rename=') && String(dfRecord.error).includes('copy='));
  tru('F5 double: original state still inside TMP (unresolved, preserved)',
    fs.existsSync(path.join(dfDir, 'keep.txt')));
  // Teardown-style relocate WHILE still failing: the record keeps the original
  // path again, and the collection does not grow unboundedly (snapshot loop).
  const recordsBefore = RETAINED.length;
  fs.renameSync = boomRename;
  fs.cpSync = boomCopy;
  let relocateAgain = null;
  try {
    relocateAgain = retainFixture(dfDir, 'teardown-relocate');
  } finally {
    fs.renameSync = realRename;
    fs.cpSync = realCopy;
  }
  eq('F5 double: relocate double-failure keeps the original path again', relocateAgain, dfDir);
  eq('F5 double: no record growth for a repeat failure on the same path', RETAINED.length, recordsBefore);
  // The REAL sweep control flow: with rename+copy still failing the relocate
  // inside it cannot resolve this record => the sweep is SKIPPED entirely.
  fs.renameSync = boomRename;
  fs.cpSync = boomCopy;
  let sweepRes = null;
  try {
    sweepRes = relocateRetainedAndSweepTmp();
  } finally {
    fs.renameSync = realRename;
    fs.cpSync = realCopy;
  }
  eq('F5 double: sweep SKIPPED by real control flow while unresolved state is inside TMP',
    sweepRes.swept, false);
  tru('F5 double: unresolved path is reported', sweepRes.unresolved.includes(dfDir));
  tru('F5 double: TMP scratch root preserved (never swept with unresolved state)',
    fs.existsSync(dfDir) && fs.existsSync(path.join(dfDir, 'keep.txt')));
  // Failures restored => the teardown relocate recovers this record properly.
  const recovered = retainFixture(dfDir, 'f5double-recovered');
  tru('F5 double: after failures clear, relocate moves the state OUT of TMP',
    recovered !== null && !insideTmp(recovered) && fs.existsSync(path.join(recovered, 'keep.txt')));
  const staleRec = RETAINED.find((r) => r.path === dfDir);
  if (staleRec) { // the path was moved: drop the stale in-TMP record we made above
    staleRec.path = recovered;
    staleRec.error = null;
  }
}

// ---- F4: caller retention regression — rename+copy BOTH fail ----------------
// Finding 4: the lifecycle helper OWNS the keep/remove decision. When both
// relocation paths fail, retainFixture returns the ORIGINAL in-TMP path (with
// the structured failure recorded); the caller must NOT rmSync it afterwards,
// and the teardown must still find the state. This locks the removal of the old
// unconditional rmSync(n4dir/n5dir) calls.
{
  const dir = mkdtempSync(path.join(TMP, 'f4ret-'));
  writeFileSync(path.join(dir, 'keep.txt'), 'survives-caller-and-teardown', 'utf8');
  const realRename = fs.renameSync;
  const realCopy = fs.cpSync;
  fs.renameSync = () => { throw new Error('injected rename failure'); };
  fs.cpSync = () => { throw new Error('injected copy failure'); };
  let r = null;
  try {
    r = await runManagedTree({
      command: process.execPath,
      args: ['-e', "process.stdout.write('F4RET');"],
      retainDir: dir, retainTag: 'f4ret',
      timeoutMs: 30000, treeGoneTimeoutMs: 1200, trackIntervalMs: 400,
    });
  } finally {
    fs.renameSync = realRename;
    fs.cpSync = realCopy;
  }
  eq('F4 caller retention: unproven run keeps its fixture at the ORIGINAL path', r.retainedPath, dir);
  tru('F4 caller retention: state still on disk after the CALLER finished (no rmSync)',
    fs.existsSync(path.join(dir, 'keep.txt')));
  const rec = RETAINED.find((x) => x.path === dir);
  tru('F4 caller retention: structured {path, error} record kept for the fixture',
    rec !== undefined && rec.error !== null);
  if (rec) F4_TEARDOWN_CHECKS.push({ label: 'caller-retention rename+copy failure', rec });
}

// ---- F4: service cleanup THROW keeps the seam state and closes the mock -----
// Finding 4: the guarded finally (withSeamRetention — the exact wrapper the
// production cleanup uses) registers a seamRoot still on disk when the cleanup
// THROWS; runCleanupSequence still runs the mock close. Neither the seam state
// nor the mock cleanup may be lost to a throw.
{
  const sr = mkdtempSync(path.join(TMP, 'f4throw-'));
  writeFileSync(path.join(sr, 'service.state'), 'unresolved-seam', 'utf8');
  let mockClosed = false;
  const seq = await runCleanupSequence({
    serviceCleanup: async () => withSeamRetention(sr, async () => {
      throw new Error('injected service cleanup throw');
    }),
    mockCleanup: async () => { mockClosed = true; },
  });
  tru('F4 throw: service cleanup error recorded (never swallowed)',
    seq.serviceError.includes('injected service cleanup throw'));
  tru('F4 throw: mock cleanup STILL closed despite the service throw', seq.mockRan && mockClosed);
  const rec = RETAINED.find((x) => x.path.includes(path.basename(sr)));
  tru('F4 throw: seam state registered OUTSIDE TMP by the guarded finally',
    rec !== undefined && !insideTmp(rec.path) && fs.existsSync(path.join(rec.path, 'service.state')));
  falsy('F4 throw: original seam dir left TMP (moved, not kept in place)', fs.existsSync(sr));
  if (rec) F4_TEARDOWN_CHECKS.push({ label: 'service-cleanup throw seam retention', rec });
}

// ---- F3 teardown: the whole-file TMP sweep must NOT destroy retained fixtures -
// Previously every fixture lived under TMP, so this unconditional rmSync
// silently deleted the very state the "KEPT for recovery" claim pointed at.
// Retention now moves fixtures to RETAINED_ROOT (outside TMP); this teardown
// proves they survive the sweep instead of trusting the claim.
// Finding 4 (rework): relocate+relocate-failure handling and the sweep live in
// relocateRetainedAndSweepTmp — snapshot iteration (finite under repeated
// failure) and REAL control flow: any record still unresolved inside TMP skips
// the sweep entirely (state preserved, failure reported), and only a fully
// resolved state lets rmSync(TMP) run.
{
  const before = RETAINED.length;
  tru('F3 teardown: fixtures were actually retained during the run', before > 0);
  const sweep = relocateRetainedAndSweepTmp();
  tru('F3 teardown: no unresolved retained fixture left inside TMP after relocate',
    sweep.unresolved.length === 0);
  if (sweep.swept) {
    falsy('F3 teardown: TMP scratch root is gone after the sweep', fs.existsSync(TMP));
  } else {
    console.log('FAIL teardown: sweep skipped (unresolved state preserved): ' + sweep.unresolved.join(', '));
  }
  const survivors = RETAINED.filter((r) => fs.existsSync(r.path));
  eq('F3 teardown: every retained fixture survives the whole-file TMP teardown',
    survivors.length, RETAINED.length);
  for (const r of RETAINED) {
    if (!fs.existsSync(r.path)) console.log('FAIL retained-missing =>', r.path, r.error || '');
  }
}

// ---- F3/F4: state retained during the run must survive the SWEEP, provably ---
// The five real probes have no completeness proof, so their recovery fixtures
// were retained; the F4 regressions rely on the teardown relocate to move their
// unresolved state out of TMP. Both are re-checked HERE, after the sweep.
{
  if (openCodeAvailable()) {
    eq('F3 teardown: every real probe recovery fixture path was recorded',
      PROBE_RECOVERY_PATHS.length, 5);
    for (const p of PROBE_RECOVERY_PATHS) {
      tru('F3 teardown: real probe recovery fixture survives the whole-file teardown: ' + p,
        p !== null && fs.existsSync(p));
    }
  }
  for (const c of F4_TEARDOWN_CHECKS) {
    tru('F4 teardown: state survives the whole-file teardown (' + c.label + ')',
      fs.existsSync(c.rec.path));
  }
}

// ---- summary --------------------------------------------------------------------
const pass = checks.filter((c) => c.ok).length;
for (const c of checks) if (!c.ok) console.log('FAIL', c.name, '=>', JSON.stringify(c.got), 'want', JSON.stringify(c.want));
console.log('\nTotal: ' + pass + '/' + checks.length + ' PASS');
// TMP was already swept (and retained fixtures proven to survive) above.
process.exit(pass === checks.length ? 0 : 1);
