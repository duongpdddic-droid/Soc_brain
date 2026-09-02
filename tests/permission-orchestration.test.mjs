#!/usr/bin/env node
// permission-orchestration.test.mjs — tests for packages/permission-orchestration
// (Issue #32 / executor permission orchestration + executor/worktree recovery).
// Pure verdict-engine tests + real-worktree guard tests. Follows the runtime-sandbox
// test pattern: makeRepo, taskStart to provision a bound execution root, eq/tru/falsy
// checks, summary, process.exit(0|1). Verifies ALLOW / DENY_AND_RECOVER /
// BLOCKED_HUMAN_GATE against the bound executionRoot.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import {
  OP_OUTCOME, classifyOperation, classifyPath, guardOperation, classifySafeCommand,
  ALLOWED_COMMAND_EXECUTABLES,
} from '../packages/permission-orchestration/permission-orchestration.mjs';
import { taskStart, createPermissionGuard } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { provision, identityHash, worktreePathFor, bindingPathFor } from '../packages/workspace/workspace.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

const CANON = 'duongpdddic-droid/Soc_brain';
const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-po-'));
const TMP_ROOT = path.join(TMP, 'worktrees');
mkdirSync(TMP_ROOT, { recursive: true });

function makeRepo() {
  const dir = mkdtempSync(path.join(TMP, 'repo-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'tester', GIT_AUTHOR_EMAIL: 't@e.x',
    GIT_COMMITTER_NAME: 'tester', GIT_COMMITTER_EMAIL: 't@e.x',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
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
    setRemote: (name, url) => { try { run(['remote', 'remove', name]); } catch {} run(['remote', 'add', name, url]); },
    dispose: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

function cleanupBound(issueNumber) {
  const h = identityHash({ repo: CANON, issueNumber });
  const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
  const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
  try { rmSync(wt, { recursive: true, force: true }); } catch {}
  try { rmSync(bp, { recursive: true, force: true }); } catch {}
}

// ---- pure verdicts: operation classification -----------------------------------
eq('OP_OUTCOME.ALLOW', OP_OUTCOME.ALLOW, 'ALLOW');
eq('OP_OUTCOME.DENY_AND_RECOVER', OP_OUTCOME.DENY_AND_RECOVER, 'DENY_AND_RECOVER');
eq('OP_OUTCOME.BLOCKED_HUMAN_GATE', OP_OUTCOME.BLOCKED_HUMAN_GATE, 'BLOCKED_HUMAN_GATE');

eq('status ALLOW', classifyOperation('status').outcome, OP_OUTCOME.ALLOW);
eq('diff ALLOW', classifyOperation('diff').outcome, OP_OUTCOME.ALLOW);
eq('run_registered_test ALLOW', classifyOperation('run_registered_test').outcome, OP_OUTCOME.ALLOW);
eq('edit ALLOW (pathSensitive)', classifyOperation('edit').outcome, OP_OUTCOME.ALLOW);
tru('edit is pathSensitive', classifyOperation('edit').pathSensitive === true);
eq('bash BLOCKED', classifyOperation('bash').outcome, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('command BLOCKED', classifyOperation('command').outcome, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('webfetch BLOCKED', classifyOperation('webfetch').outcome, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('network BLOCKED', classifyOperation('network').outcome, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('credential BLOCKED', classifyOperation('credential').outcome, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('destructive BLOCKED', classifyOperation('destructive').outcome, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('external_directory BLOCKED', classifyOperation('external_directory').outcome, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('unknown op BLOCKED', classifyOperation('totally-unknown').outcome, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('empty op BLOCKED', classifyOperation('').outcome, OP_OUTCOME.BLOCKED_HUMAN_GATE);

// ---- pure verdicts: path classification (no repo needed) -----------------------
const ROOT = path.join(TMP, 'exec-root');
const PRIMARY = path.join(TMP, 'primary');
const WT_ROOT = path.join(TMP, 'worktrees2');
const BOUND_CHILD = path.join(ROOT, 'src', 'a.js');
const FOREIGN_WT = path.join(WT_ROOT, 'agent', 'other-hash');
const OUTSIDE = path.join(TMP, 'bogus', 'outside');

eq('classify inside exec root ALLOW', classifyPath({ targetPath: BOUND_CHILD, executionRoot: ROOT }).verdict, OP_OUTCOME.ALLOW);
eq('classify exec root itself ALLOW', classifyPath({ targetPath: ROOT, executionRoot: ROOT }).verdict, OP_OUTCOME.ALLOW);
eq('classify primary checkout DENY_AND_RECOVER', classifyPath({ targetPath: PRIMARY, executionRoot: ROOT, primaryCheckout: PRIMARY }).verdict, OP_OUTCOME.DENY_AND_RECOVER);
eq('classify primary child DENY_AND_RECOVER', classifyPath({ targetPath: path.join(PRIMARY, 'sub'), executionRoot: ROOT, primaryCheckout: PRIMARY }).verdict, OP_OUTCOME.DENY_AND_RECOVER);
eq('classify foreign worktree DENY_AND_RECOVER', classifyPath({ targetPath: FOREIGN_WT, executionRoot: ROOT, worktreesRoot: WT_ROOT }).verdict, OP_OUTCOME.DENY_AND_RECOVER);
eq('classify outside BLOCKED', classifyPath({ targetPath: OUTSIDE, executionRoot: ROOT, worktreesRoot: WT_ROOT }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('classify missing target BLOCKED', classifyPath({ targetPath: '', executionRoot: ROOT }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('classify no exec root BLOCKED', classifyPath({ targetPath: BOUND_CHILD, executionRoot: '' }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);

// ---- pure verdicts: guardOperation binding mismatch + gate ---------------------
eq('guard status ALLOW', guardOperation({ operation: 'status', executionRoot: ROOT }).verdict, OP_OUTCOME.ALLOW);
eq('guard edit inside root ALLOW', guardOperation({ operation: 'edit', targetPath: BOUND_CHILD, executionRoot: ROOT }).verdict, OP_OUTCOME.ALLOW);
eq('guard edit no target BLOCKED', guardOperation({ operation: 'edit', executionRoot: ROOT }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('guard bash BLOCKED', guardOperation({ operation: 'bash', targetPath: BOUND_CHILD, executionRoot: ROOT }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('guard binding mismatch DENY_AND_RECOVER', guardOperation({ operation: 'status', executionRoot: ROOT, bindingOk: false, bindingReason: 'STALE_TASK_LEASE' }).verdict, OP_OUTCOME.DENY_AND_RECOVER);
eq('guard mismatch rerouteRoot', guardOperation({ operation: 'status', executionRoot: ROOT, bindingOk: false, bindingReason: 'STALE_TASK_LEASE' }).rerouteRoot, ROOT);
eq('guard edit primary DENY_AND_RECOVER', guardOperation({ operation: 'edit', targetPath: PRIMARY, executionRoot: ROOT, primaryCheckout: PRIMARY }).verdict, OP_OUTCOME.DENY_AND_RECOVER);

// ---- pure verdicts: safe local command (criterion #4) ------------------------
// classifySafeCommand: deterministic static authorization, NEVER executes.
eq('classify S1 safe node ALLOW', classifySafeCommand({ executable: 'node', argv: ['tests/foo.test.mjs'], executionRoot: ROOT, primaryCheckout: PRIMARY }).verdict, OP_OUTCOME.ALLOW);
eq('classify S1b exec carries normalized command', JSON.stringify(classifySafeCommand({ executable: 'node', argv: ['tests/foo.test.mjs'], executionRoot: ROOT, primaryCheckout: PRIMARY }).exec), JSON.stringify({ executable: 'node', argv: ['tests/foo.test.mjs'] }));
eq('classify S1c node.exe ALLOW', classifySafeCommand({ executable: 'node.exe', argv: ['rt-hello.cjs'], executionRoot: ROOT, primaryCheckout: PRIMARY }).verdict, OP_OUTCOME.ALLOW);
eq('classify S1d allowlist is node/node.exe only', ALLOWED_COMMAND_EXECUTABLES.includes('node') && ALLOWED_COMMAND_EXECUTABLES.includes('node.exe'), true);
eq('classify S2 non-node executable BLOCKED', classifySafeCommand({ executable: 'bash', argv: ['x'], executionRoot: ROOT, primaryCheckout: PRIMARY }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('classify S2b git BLOCKED', classifySafeCommand({ executable: 'git', argv: ['reset', '--hard'], executionRoot: ROOT, primaryCheckout: PRIMARY }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('classify S3 eval flag BLOCKED', classifySafeCommand({ executable: 'node', argv: ['tests/foo.test.mjs', '-e', 'x'], executionRoot: ROOT, primaryCheckout: PRIMARY }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('classify S3b print flag BLOCKED', classifySafeCommand({ executable: 'node', argv: ['-p', '1+1'], executionRoot: ROOT, primaryCheckout: PRIMARY }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('classify S4 traversal BLOCKED', classifySafeCommand({ executable: 'node', argv: ['../outside.js'], executionRoot: ROOT, primaryCheckout: PRIMARY }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('classify S4b absolute leading-slash BLOCKED', classifySafeCommand({ executable: 'node', argv: ['/etc/passwd'], executionRoot: ROOT, primaryCheckout: PRIMARY }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('classify S4c drive-letter BLOCKED', classifySafeCommand({ executable: 'node', argv: ['C:/Windows/system32'], executionRoot: ROOT, primaryCheckout: PRIMARY }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('classify S4d URL BLOCKED', classifySafeCommand({ executable: 'node', argv: ['file:///x'], executionRoot: ROOT, primaryCheckout: PRIMARY }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('classify S4e option/stdin BLOCKED', classifySafeCommand({ executable: 'node', argv: ['-'], executionRoot: ROOT, primaryCheckout: PRIMARY }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('classify S5 shell-meta chaining BLOCKED', classifySafeCommand({ executable: 'node', argv: ['tests/foo.test.mjs', '; rm -rf /'], executionRoot: ROOT, primaryCheckout: PRIMARY }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('classify S5b shell-meta redirection BLOCKED', classifySafeCommand({ executable: 'node', argv: ['tests/foo.test.mjs', '> out'], executionRoot: ROOT, primaryCheckout: PRIMARY }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('classify S6 secret token BLOCKED', classifySafeCommand({ executable: 'node', argv: ['tests/foo.test.mjs', '--token=abc'], executionRoot: ROOT, primaryCheckout: PRIMARY }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('classify S7 script resolves to primary DENY_AND_RECOVER', classifySafeCommand({ executable: 'node', argv: ['TOP.md'], cwd: PRIMARY, executionRoot: ROOT, primaryCheckout: PRIMARY }).verdict, OP_OUTCOME.DENY_AND_RECOVER);
eq('classify S7b script outside every root BLOCKED', classifySafeCommand({ executable: 'node', argv: ['sub/x'], cwd: OUTSIDE, executionRoot: ROOT, primaryCheckout: PRIMARY }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
// guardOperation verdict surface for the safe-command operation.
eq('guard run_safe_command ALLOW', guardOperation({ operation: 'run_safe_command', executable: 'node', argv: ['tests/foo.test.mjs'], executionRoot: ROOT, primaryCheckout: PRIMARY }).verdict, OP_OUTCOME.ALLOW);
eq('guard run_safe_command eval BLOCKED', guardOperation({ operation: 'run_safe_command', executable: 'node', argv: ['tests/foo.test.mjs', '-e', 'x'], executionRoot: ROOT, primaryCheckout: PRIMARY }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('guard run_safe_command non-node BLOCKED', guardOperation({ operation: 'run_safe_command', executable: 'bash', argv: ['x'], executionRoot: ROOT, primaryCheckout: PRIMARY }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
eq('guard run_safe_command binding mismatch DENY_AND_RECOVER', guardOperation({ operation: 'run_safe_command', executable: 'node', argv: ['tests/foo.test.mjs'], executionRoot: ROOT, primaryCheckout: PRIMARY, bindingOk: false, bindingReason: 'STALE_TASK_LEASE' }).verdict, OP_OUTCOME.DENY_AND_RECOVER);

// ---- real-worktree guard: ALLOW / DENY_AND_RECOVER / BLOCKED_HUMAN_GATE --------
{
  let repo;
  let foreignIssue = null;
  try {
    repo = makeRepo();
    const baseSha = repo.commit('START.md', 's');
    repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
    const issueNumber = 320;
    const result = taskStart({
      repo: CANON, issueNumber, baseSha,
      worktreesRoot: TMP_ROOT, stateDir: path.join(TMP, '_state'),
      controlCwd: repo.dir, testRegistry: {},
    });
    eq('taskStart ok', result.ok, true);
    if (!result.ok) { console.log('  taskStart failed: ' + (result.detail || result.reason)); }
    const executionRoot = path.dirname(result.openCodeConfigPath);
    tru('executionRoot exists', fs.existsSync(executionRoot));

    const guard = createPermissionGuard({
      sessionPath: result.session.path,
      leaseToken: result.session.leaseToken,
      controlCwd: path.resolve(repo.dir),
      canonicalExecutionRoot: executionRoot,
    });

    // ALLOW: safe, statically authorized ops against the bound root.
    eq('guard status ALLOW', guard.evaluate({ operation: 'status' }).verdict, OP_OUTCOME.ALLOW);
    eq('guard diff ALLOW', guard.evaluate({ operation: 'diff' }).verdict, OP_OUTCOME.ALLOW);
    eq('guard run_registered_test ALLOW', guard.evaluate({ operation: 'run_registered_test' }).verdict, OP_OUTCOME.ALLOW);
    const editInRoot = guard.evaluate({ operation: 'edit', targetPath: path.join(executionRoot, 'x.txt') });
    eq('guard edit inside root ALLOW', editInRoot.verdict, OP_OUTCOME.ALLOW);
    // Safe local command (criterion #4): deterministic ALLOW against the bound
    // root; eval-flag / non-node variants stay BLOCKED_HUMAN_GATE.
    eq('guard run_safe_command ALLOW', guard.evaluate({ operation: 'run_safe_command', executable: 'node', argv: ['tests/foo.test.mjs'] }).verdict, OP_OUTCOME.ALLOW);
    eq('guard run_safe_command eval BLOCKED', guard.evaluate({ operation: 'run_safe_command', executable: 'node', argv: ['tests/foo.test.mjs', '-e', 'x'] }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
    eq('guard run_safe_command non-node BLOCKED', guard.evaluate({ operation: 'run_safe_command', executable: 'bash', argv: ['x'] }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);

    // DENY_AND_RECOVER: mismatched execution root.
    const editPrimary = guard.evaluate({ operation: 'edit', targetPath: path.join(repo.dir, 'TOP.md') });
    eq('guard edit primary DENY_AND_RECOVER', editPrimary.verdict, OP_OUTCOME.DENY_AND_RECOVER);
    eq('guard edit primary rerouteRoot', editPrimary.rerouteRoot, executionRoot);

    // Foreign worktree: provision a second issue -> its worktree is mismatched.
    foreignIssue = 3201;
    const fp = provision({ worktreesRoot: TMP_ROOT, repo: CANON, issueNumber: foreignIssue, baseSha, cwd: repo.dir });
    tru('foreign provision ok', fp.ok);
    if (fp.ok) {
      const foreignRoot = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: identityHash({ repo: CANON, issueNumber: foreignIssue }) });
      const editForeign = guard.evaluate({ operation: 'edit', targetPath: path.join(foreignRoot, 'y.txt') });
      eq('guard edit foreign worktree DENY_AND_RECOVER', editForeign.verdict, OP_OUTCOME.DENY_AND_RECOVER);
      eq('guard edit foreign rerouteRoot', editForeign.rerouteRoot, executionRoot);
    }

    // BLOCKED_HUMAN_GATE: gate-classes / unknown / outside / missing target.
    eq('guard bash BLOCKED', guard.evaluate({ operation: 'bash' }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
    eq('guard webfetch BLOCKED', guard.evaluate({ operation: 'webfetch' }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
    eq('guard network BLOCKED', guard.evaluate({ operation: 'network' }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
    eq('guard credential BLOCKED', guard.evaluate({ operation: 'credential' }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
    eq('guard destructive BLOCKED', guard.evaluate({ operation: 'destructive' }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
    eq('guard unknown op BLOCKED', guard.evaluate({ operation: 'mystery' }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
    eq('guard edit no target BLOCKED', guard.evaluate({ operation: 'edit' }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);
    eq('guard edit outside BLOCKED', guard.evaluate({ operation: 'edit', targetPath: path.join(TMP, 'unrelated', 'z.txt') }).verdict, OP_OUTCOME.BLOCKED_HUMAN_GATE);

    // Deterministic recovery: break the execution-root binding AFTER guard creation;
    // the next evaluate MUST map to DENY_AND_RECOVER with rerouteRoot = canonical root.
    const h = identityHash({ repo: CANON, issueNumber });
    const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
    rmSync(bp, { force: true });
    const recover = guard.evaluate({ operation: 'status' });
    eq('guard broken binding DENY_AND_RECOVER', recover.verdict, OP_OUTCOME.DENY_AND_RECOVER);
    eq('guard broken binding rerouteRoot', recover.rerouteRoot, executionRoot);
    tru('guard broken binding reports reason', /WORKSPACE_SESSION_BIND_REQUIRED|BINDING_ABSENT/.test(String(recover.bindingReason)));
  } finally {
    if (repo) repo.dispose();
    cleanupBound(320);
    if (foreignIssue !== null) cleanupBound(foreignIssue);
  }
}

// ---- summary --------------------------------------------------------------------
const pass = checks.filter((c) => c.ok).length;
for (const c of checks) if (!c.ok) console.log('FAIL', c.name, '=>', JSON.stringify(c.got), 'want', JSON.stringify(c.want));
console.log('\nTotal: ' + pass + '/' + checks.length + ' PASS');
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(pass === checks.length ? 0 : 1);
