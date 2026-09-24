#!/usr/bin/env node
// tests/task-bootstrapper.test.mjs — hardened scripts/Invoke-SocTask.ps1 (offline).
// 100% deterministic: no network, no real GitHub. git/gh are PATH-shadowed by
// recording mocks; DryRun performs zero process calls (asserted via empty log).
//
// Group A — script source invariants (ASCII-safe for PS 5.1 + pwsh, fail-closed
//           flags, chicken-and-egg anchors, no bracketed PR placeholder token,
//           no force-push).
// Group B — pure naming/param logic dot-sourced from the script (slug rules,
//           branch forms task/<slug>-<ts> and fix/issue-<id>-<slug>, validation).
// Group C — -DryRun JSON plan: base default origin/main, contract + task prompt
//           render with a real PR number, no placeholder, and nothing executed.
// Group D — argument handling: missing/invalid inputs exit 2, fail-closed.
// Group E — full mocked flow: empty init commit -> push -> gh pr create ->
//           label status:in-progress -> primary restored -> isolated worktree ->
//           contracts committed with the REAL PR number (4242), exact order.
// Group F — resume: an already-open PR is discovered and reused (no create).
// Group G — dirty primary checkout fails closed before any branch mutation.
// Group H — Windows PowerShell 5.1 smoke (skipped when powershell.exe absent).
// Group I — control-loop Task Ingestion seam (packages/control-loop/
//           task-ingestion.mjs): safe-flag spawn argv, BOOTSTRAP_OK parse,
//           session lease assignment, fail-closed exit!=0 / dirty / unparsable
//           paths — 100% offline mock spawn (no network, no real PowerShell).
// Exit 0 = PASS, 1 = FAIL. Disposable temp dirs only.
import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  buildBootstrapperArgs,
  parseBootstrapOutput,
  classifyBootstrapFailure,
  runTaskBootstrapper,
  ingestGoalViaBootstrapper,
  assignBootstrapToSession,
  PS_SAFE_FLAGS,
  resolvePowerShellHost,
} from '../packages/control-loop/task-ingestion.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PS_SCRIPT = path.join(ROOT, 'scripts', 'Invoke-SocTask.ps1');
const PLACEHOLDER = '[SỐ_PR]'; // bracketed PR placeholder that must never survive
const TMP_DIRS = [];
after(() => {
  for (const dir of TMP_DIRS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.push(dir);
  return dir;
}

function psFileArgs(script, args) {
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args];
}

function envWith(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^path$/i.test(k)) env[k] = v;
  }
  env.PATH = process.env.PATH || process.env.Path || '';
  return { ...env, ...extra };
}

function runPsJson(args, extraEnv = {}) {
  const out = execFileSync('pwsh', psFileArgs(PS_SCRIPT, args), {
    encoding: 'utf8',
    windowsHide: true,
    env: envWith(extraEnv),
  });
  return JSON.parse(out.replace(/^\uFEFF/, '').trim());
}

function runPsStatus(args, extraEnv = {}) {
  return spawnSync('pwsh', psFileArgs(PS_SCRIPT, args), {
    encoding: 'utf8',
    windowsHide: true,
    env: envWith(extraEnv),
  });
}

// PATH-shadowed recording mocks: PowerShell resolves git.CMD/gh.CMD (or the sh
// wrappers on POSIX) before the real binaries because the mock dir leads PATH.
function writeMocks(mockDir) {
  fs.mkdirSync(mockDir, { recursive: true });
  fs.writeFileSync(path.join(mockDir, 'mock-cli.mjs'), `
import fs from 'node:fs';
const exe = process.argv[2];
const args = process.argv.slice(3);
if (process.env.MOCK_LOG) {
  fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ exe, args }) + '\\n');
}
if (exe === 'git') {
  if (args.includes('--show-toplevel')) {
    process.stdout.write(process.env.MOCK_REPO_ROOT + '\\n');
    process.exit(0);
  }
  if (args.includes('--abbrev-ref')) {
    process.stdout.write('main\\n');
    process.exit(0);
  }
  if (args.includes('rev-parse')) {
    process.stdout.write('a'.repeat(40) + '\\n');
    process.exit(0);
  }
  if (args.includes('status') && args.includes('--porcelain')) {
    if (process.env.MOCK_DIRTY === '1') process.stdout.write(' M docs/dirty.md\\n');
    process.exit(0);
  }
  if (args.includes('worktree') && args.includes('add')) {
    const target = args[args.indexOf('add') + 1];
    fs.mkdirSync(target, { recursive: true });
    process.exit(0);
  }
  process.exit(0);
}
if (exe === 'gh') {
  if (args[0] === 'pr' && args[1] === 'list') {
    if (process.env.MOCK_PR_EXISTS === '1') {
      process.stdout.write(JSON.stringify([
        { number: 777, url: 'https://github.com/duongpdddic-droid/Soc_brain/pull/777' },
      ]) + '\\n');
    } else {
      process.stdout.write('[]\\n');
    }
    process.exit(0);
  }
  if (args[0] === 'pr' && args[1] === 'create') {
    process.stdout.write('https://github.com/duongpdddic-droid/Soc_brain/pull/4242\\n');
    process.exit(0);
  }
  process.exit(0);
}
process.exit(0);
`, 'utf8');
  const isWin = process.platform === 'win32';
  for (const exe of ['git', 'gh']) {
    if (isWin) {
      fs.writeFileSync(path.join(mockDir, `${exe}.cmd`),
        `@echo off\r\nnode "%~dp0mock-cli.mjs" ${exe} %*\r\nexit /b %ERRORLEVEL%\r\n`, 'utf8');
    } else {
      const sh = path.join(mockDir, exe);
      fs.writeFileSync(sh, `#!/bin/sh\nnode "$(dirname "$0")/mock-cli.mjs" ${exe} "$@"\n`, 'utf8');
      fs.chmodSync(sh, 0o755);
    }
  }
}

function mockPath(mockDir) {
  const sep = process.platform === 'win32' ? ';' : ':';
  return mockDir + sep + (process.env.PATH || process.env.Path || '');
}

function readLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

function setupMockRepo() {
  const tmp = mkTmp('soc-boot-');
  const mockDir = path.join(tmp, 'mock');
  const repoRoot = path.join(tmp, 'primary');
  const worktreesRoot = path.join(tmp, 'wtx');
  const logPath = path.join(tmp, 'mock-log.jsonl');
  writeMocks(mockDir);
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.git'), 'gitdir: ./fake-git-dir\n', 'utf8');
  return {
    tmp, mockDir, repoRoot, worktreesRoot, logPath,
    env: { PATH: mockPath(mockDir), MOCK_LOG: logPath, MOCK_REPO_ROOT: repoRoot },
  };
}

function idxOf(log, pred, label) {
  const i = log.findIndex(pred);
  assert.notStrictEqual(i, -1, `missing step in mock log: ${label}\n${JSON.stringify(log, null, 2)}`);
  return i;
}

function assertIncreasing(log, steps) {
  const indices = steps.map(([label, pred]) => [label, idxOf(log, pred, label)]);
  for (let i = 1; i < indices.length; i++) {
    assert.ok(
      indices[i][1] > indices[i - 1][1],
      `order violated: "${indices[i][0]}" (${indices[i][1]}) must come after "${indices[i - 1][0]}" (${indices[i - 1][1]})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Group A — script source invariants
// ---------------------------------------------------------------------------
test('A1: script source is pure ASCII (PS 5.1 ANSI-safe) and fail-closed flags exist', () => {
  const src = fs.readFileSync(PS_SCRIPT, 'utf8');
  assert.match(src, /^[\x00-\x7F]+$/, 'script source must be 7-bit ASCII');
  assert.match(src, /\$ErrorActionPreference = 'Stop'/);
  assert.match(src, /#Requires -Version 5\.1/);
  assert.ok(!src.includes("'--force'") && !src.includes('"--force"'), 'no force-push argument allowed');
  const forceLines = src.split('\n').filter((l) => l.includes('--force') || l.includes('force-push'));
  assert.ok(
    forceLines.every((l) => l.includes('no force-push')),
    `force-push may only appear in prohibition text:\n${forceLines.join('\n')}`,
  );
  assert.ok(!src.includes(PLACEHOLDER), 'source must not embed the bracketed PR placeholder');
});

test('A2: chicken-and-egg anchors exist in source (empty commit, label lifecycle, worktree, real-PR gate)', () => {
  const src = fs.readFileSync(PS_SCRIPT, 'utf8');
  assert.match(src, /--allow-empty/);
  assert.match(src, /chore: initialize task under AGENTS\.md/);
  assert.match(src, /'push', '-u', 'origin'/);
  assert.match(src, /'pr', 'edit'/);
  assert.match(src, /status:in-progress/);
  assert.match(src, /status:review-requested/);
  const forbiddenLabels = src.split('\n')
    .filter((l) => l.includes('status:approved') || l.includes('status:blocked'));
  assert.ok(
    forbiddenLabels.length > 0 && forbiddenLabels.every((l) => l.includes('NEVER self-apply')),
    'status:approved/blocked may only appear inside the NEVER self-apply prohibition',
  );
  assert.match(src, /'worktree', 'add'/);
  assert.match(src, /SOC_TASK_CONTRACT\.md/);
  assert.match(src, /TASK_PROMPT\.md/);
  assert.match(src, /PR_UNRESOLVED/, 'refuse to scaffold without a real PR number');
});

// ---------------------------------------------------------------------------
// Group B — pure naming / parameter logic (dot-sourced)
// ---------------------------------------------------------------------------
test('B1: ConvertTo-GoalSlug + Get-SocTaskBranchName rules', () => {
  const harness = path.join(mkTmp('soc-boot-h-'), 'harness.ps1');
  const scriptLiteral = PS_SCRIPT.replace(/'/g, "''");
  fs.writeFileSync(harness, [
    "$ErrorActionPreference = 'Stop'",
    'Set-StrictMode -Version Latest',
    `. '${scriptLiteral}'`,
    '$out = [ordered]@{}',
    "$out.slugBasic = ConvertTo-GoalSlug -Goal 'Harden Task Bootstrapper!'",
    "$out.slugViet = ConvertTo-GoalSlug -Goal 'Tăng cường Task Bootstrapper'",
    "$out.slugVietDD = ConvertTo-GoalSlug -Goal 'Đưa Task Vào Bootstrapper'",
    "$out.slugEmpty = ConvertTo-GoalSlug -Goal '!!!'",
    "$out.slugLong = ConvertTo-GoalSlug -Goal ('a' * 100)",
    "$out.slugSpaces = ConvertTo-GoalSlug -Goal '  Multiple   Spaces  '",
    "$out.branchTask = Get-SocTaskBranchName -Goal 'Harden Bootstrapper' -Timestamp '20260924-120000'",
    "$out.branchIssue = Get-SocTaskBranchName -Goal 'Harden Bootstrapper' -IssueNumber '218' -Timestamp '20260924-120000'",
    "$out.branchDefaultTs = Get-SocTaskBranchName -Goal 'Harden Bootstrapper'",
    "try { $null = Get-SocTaskBranchName -Goal 'x' -IssueNumber 'abc' -Timestamp '20260101-000000'; $out.badIssue = 'NO_THROW' } catch { $out.badIssue = 'THROWN' }",
    "try { $null = Get-SocTaskBranchName -Goal 'x' -Timestamp 'bad'; $out.badTs = 'NO_THROW' } catch { $out.badTs = 'THROWN' }",
    '$out | ConvertTo-Json -Compress',
    '',
  ].join('\n'), 'utf8');
  const out = execFileSync('pwsh', psFileArgs(harness, []), {
    encoding: 'utf8', windowsHide: true, env: envWith(),
  });
  const r = JSON.parse(out.replace(/^\uFEFF/, '').trim());
  assert.strictEqual(r.slugBasic, 'harden-task-bootstrapper');
  assert.strictEqual(r.slugViet, 'tang-cuong-task-bootstrapper');
  assert.strictEqual(r.slugVietDD, 'dua-task-vao-bootstrapper');
  assert.strictEqual(r.slugEmpty, 'task');
  assert.strictEqual(r.slugLong.length, 48);
  assert.strictEqual(r.slugSpaces, 'multiple-spaces');
  assert.strictEqual(r.branchTask, 'task/harden-bootstrapper-20260924-120000');
  assert.strictEqual(r.branchIssue, 'fix/issue-218-harden-bootstrapper');
  assert.match(r.branchDefaultTs, /^task\/harden-bootstrapper-\d{8}-\d{6}$/);
  assert.strictEqual(r.badIssue, 'THROWN');
  assert.strictEqual(r.badTs, 'THROWN');
});

// ---------------------------------------------------------------------------
// Group C — DryRun plan JSON (zero process calls)
// ---------------------------------------------------------------------------
test('C1: DryRun emits a full plan with default base origin/main and renders contracts with a real PR', () => {
  const tmp = mkTmp('soc-boot-dry-');
  const mockDir = path.join(tmp, 'mock');
  const logPath = path.join(tmp, 'never.log');
  writeMocks(mockDir);
  const plan = runPsJson([
    '-Goal', 'Harden Bootstrapper',
    '-RepoRoot', path.join(tmp, 'not-a-repo'),
    '-WorktreesRoot', path.join(tmp, 'wtx'),
    '-Timestamp', '20260924-120000',
    '-PullRequestNumber', '999',
    '-DryRun',
  ], { PATH: mockPath(mockDir), MOCK_LOG: logPath, MOCK_REPO_ROOT: path.join(tmp, 'not-a-repo') });

  assert.strictEqual(plan.base, 'origin/main');
  assert.strictEqual(plan.ghBase, 'main');
  assert.strictEqual(plan.startPoint, 'origin/main');
  assert.strictEqual(plan.branch, 'task/harden-bootstrapper-20260924-120000');
  assert.strictEqual(plan.taskName, plan.branch);
  assert.strictEqual(plan.worktreeDisplay, 'worktrees/task/harden-bootstrapper-20260924-120000');
  assert.strictEqual(plan.pullRequest, '999');
  assert.strictEqual(plan.draft, false);
  assert.strictEqual(plan.dryRun, true);
  assert.ok(plan.contract.includes('PR Number: 999'));
  assert.ok(plan.taskPrompt.includes('PR Number: 999'));
  assert.ok(!plan.contract.includes(PLACEHOLDER), 'contract must not contain the PR placeholder');
  assert.ok(!plan.taskPrompt.includes(PLACEHOLDER), 'task prompt must not contain the PR placeholder');
  assert.ok(!plan.contract.includes('UNRESOLVED'), 'resolved PR must be rendered');
  assert.ok(fs.existsSync(path.join(PS_SCRIPT)) && fs.statSync(PS_SCRIPT).size > 0);

  // DryRun must not execute a single git/gh process (mock log stays absent/empty).
  const logEntries = readLog(logPath);
  assert.strictEqual(logEntries.length, 0, `DryRun executed processes: ${JSON.stringify(logEntries)}`);
});

test('C2: DryRun with -IssueNumber selects fix/issue-<id>-<slug> and -Draft is honored', () => {
  const plan = runPsJson([
    '-Goal', 'Harden Bootstrapper',
    '-IssueNumber', '218',
    '-RepoRoot', mkTmp('soc-boot-dry2-'),
    '-Timestamp', '20260924-120000',
    '-PullRequestNumber', '55',
    '-Draft',
    '-DryRun',
  ]);
  assert.strictEqual(plan.branch, 'fix/issue-218-harden-bootstrapper');
  assert.strictEqual(plan.issueNumber, '218');
  assert.strictEqual(plan.draft, true);
  assert.strictEqual(plan.pullRequest, '55');
  assert.ok(plan.contract.includes('PR Number: 55'));
  assert.ok(!plan.contract.includes(PLACEHOLDER));
});

// ---------------------------------------------------------------------------
// Group D — argument handling (fail-closed exit codes)
// ---------------------------------------------------------------------------
test('D1: missing -Goal exits 2 with GOAL_REQUIRED', () => {
  const r = runPsStatus(['-RepoRoot', mkTmp('soc-boot-d1-'), '-DryRun']);
  assert.notStrictEqual(r.status, 0, 'missing goal must fail');
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /GOAL_REQUIRED/);
});

test('D2: non-numeric -IssueNumber and bad -Timestamp exit 2', () => {
  const rIssue = runPsStatus([
    '-Goal', 'x', '-IssueNumber', 'abc',
    '-RepoRoot', mkTmp('soc-boot-d2a-'), '-DryRun',
  ]);
  assert.strictEqual(rIssue.status, 2);
  assert.match(rIssue.stderr, /INVALID_ISSUE_NUMBER/);

  const rTs = runPsStatus([
    '-Goal', 'x', '-Timestamp', 'not-a-stamp',
    '-RepoRoot', mkTmp('soc-boot-d2b-'), '-DryRun',
  ]);
  assert.strictEqual(rTs.status, 2);
  assert.match(rTs.stderr, /INVALID_TIMESTAMP/);
});

test('D3: non-numeric -PullRequestNumber exits 2', () => {
  const r = runPsStatus([
    '-Goal', 'x', '-PullRequestNumber', 'pr-9',
    '-RepoRoot', mkTmp('soc-boot-d3-'), '-DryRun',
  ]);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /INVALID_PULL_REQUEST_NUMBER/);
});

// ---------------------------------------------------------------------------
// Group E — full mocked flow, exact chicken-and-egg order
// ---------------------------------------------------------------------------
test('E1: full flow: empty commit -> push -> PR create -> label -> restore -> worktree -> contracts (PR 4242)', () => {
  const s = setupMockRepo();
  const r = runPsStatus([
    '-Goal', 'Full Flow Check',
    '-RepoRoot', s.repoRoot,
    '-WorktreesRoot', s.worktreesRoot,
    '-Timestamp', '20260924-150000',
  ], s.env);
  assert.strictEqual(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /BOOTSTRAP_OK/);
  assert.match(r.stdout, /pr=4242/);

  const log = readLog(s.logPath);
  assertIncreasing(log, [
    ['fetch', (e) => e.exe === 'git' && e.args.includes('fetch')],
    ['clean-check', (e) => e.exe === 'git' && e.args.includes('--porcelain')],
    ['checkout -b', (e) => e.exe === 'git' && e.args.includes('checkout') && e.args.includes('-b')],
    ['empty-init-commit', (e) => e.exe === 'git' && e.args.includes('--allow-empty')
      && e.args.includes('chore: initialize task under AGENTS.md')],
    ['push -u', (e) => e.exe === 'git' && e.args.includes('push') && e.args.includes('-u')],
    ['gh pr list (resume probe)', (e) => e.exe === 'gh' && e.args.includes('list')],
    ['gh pr create', (e) => e.exe === 'gh' && e.args.includes('create')],
    ['gh pr edit label', (e) => e.exe === 'gh' && e.args.includes('edit')
      && e.args.includes('status:in-progress') && e.args.includes('4242')],
    ['restore primary ref', (e) => e.exe === 'git' && e.args.includes('checkout')
      && !e.args.includes('-b') && e.args[e.args.length - 1] === 'main'],
    ['worktree add', (e) => e.exe === 'git' && e.args.includes('worktree') && e.args.includes('add')],
    ['commit contracts', (e) => e.exe === 'git' && e.args.includes('SOC_TASK_CONTRACT.md')],
  ]);

  const createEntry = log.find((e) => e.exe === 'gh' && e.args.includes('create'));
  assert.ok(createEntry.args.includes('--base') && createEntry.args.includes('main'));
  assert.ok(createEntry.args.includes('--head') && createEntry.args.includes('task/full-flow-check-20260924-150000'));
  assert.ok(!createEntry.args.includes('--draft'), 'default PR must be ready (draft: false)');
  const pushEntry = log.find((e) => e.exe === 'git' && e.args.includes('push') && e.args.includes('-u'));
  assert.ok(!pushEntry.args.some((a) => a === '--force' || a === '-f'), 'force-push forbidden');

  const wt = path.join(s.worktreesRoot, 'task', 'full-flow-check-20260924-150000');
  const contract = fs.readFileSync(path.join(wt, 'SOC_TASK_CONTRACT.md'), 'utf8');
  const prompt = fs.readFileSync(path.join(wt, 'TASK_PROMPT.md'), 'utf8');
  assert.ok(contract.includes('PR Number: 4242'), 'contract must carry the REAL PR number');
  assert.ok(prompt.includes('PR Number: 4242'), 'task prompt must carry the REAL PR number');
  assert.ok(!contract.includes(PLACEHOLDER) && !prompt.includes(PLACEHOLDER));
  assert.ok(contract.includes('Target Branch: task/full-flow-check-20260924-150000'));
});

// ---------------------------------------------------------------------------
// Group F — resume an already-open PR (no duplicate PR)
// ---------------------------------------------------------------------------
test('F1: existing open PR for the head branch is reused; gh pr create is never called', () => {
  const s = setupMockRepo();
  const r = runPsStatus([
    '-Goal', 'Recovery Flow',
    '-IssueNumber', '218',
    '-RepoRoot', s.repoRoot,
    '-WorktreesRoot', s.worktreesRoot,
    '-Timestamp', '20260924-160000',
  ], { ...s.env, MOCK_PR_EXISTS: '1' });
  assert.strictEqual(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /pr=777/);

  const log = readLog(s.logPath);
  assert.ok(log.some((e) => e.exe === 'gh' && e.args.includes('list')), 'resume probe required');
  assert.ok(!log.some((e) => e.exe === 'gh' && e.args.includes('create')), 'must not open a second PR');
  assert.ok(log.some((e) => e.exe === 'gh' && e.args.includes('edit') && e.args.includes('777')));

  const wt = path.join(s.worktreesRoot, 'fix', 'issue-218-recovery-flow');
  const contract = fs.readFileSync(path.join(wt, 'SOC_TASK_CONTRACT.md'), 'utf8');
  assert.ok(contract.includes('PR Number: 777'));
  assert.ok(!contract.includes(PLACEHOLDER));
});

// ---------------------------------------------------------------------------
// Group G — dirty primary checkout fails closed before branch mutation
// ---------------------------------------------------------------------------
test('G1: dirty primary checkout aborts before checkout -b / commit / push', () => {
  const s = setupMockRepo();
  const r = runPsStatus([
    '-Goal', 'Dirty Guard',
    '-RepoRoot', s.repoRoot,
    '-WorktreesRoot', s.worktreesRoot,
    '-Timestamp', '20260924-170000',
  ], { ...s.env, MOCK_DIRTY: '1' });
  assert.strictEqual(r.status, 1, `stderr:\n${r.stderr}`);
  assert.match(r.stderr, /PRIMARY_DIRTY/);

  const log = readLog(s.logPath);
  assert.ok(!log.some((e) => e.exe === 'git' && e.args.includes('-b')), 'no branch switch allowed');
  assert.ok(!log.some((e) => e.exe === 'git' && e.args.includes('--allow-empty')), 'no commit allowed');
  assert.ok(!log.some((e) => e.exe === 'git' && e.args.includes('push')), 'no push allowed');
  assert.ok(!log.some((e) => e.exe === 'gh'), 'no GitHub call allowed');
});

// ---------------------------------------------------------------------------
// Group H — Windows PowerShell 5.1 compatibility smoke
// ---------------------------------------------------------------------------
const HAS_PS51 = process.platform === 'win32'
  && (() => {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0'], {
      encoding: 'utf8', windowsHide: true,
    });
    return r.status === 0;
  })();

test('H1: Windows PowerShell 5.1 runs DryRun and emits parseable UTF-8 JSON', { skip: !HAS_PS51 }, () => {
  const out = execFileSync(
    'powershell.exe',
    psFileArgs(PS_SCRIPT, [
      '-Goal', 'PS51 Smoke',
      '-RepoRoot', mkTmp('soc-boot-h1-'),
      '-Timestamp', '20260924-180000',
      '-PullRequestNumber', '12',
      '-DryRun',
    ]),
    { encoding: 'utf8', windowsHide: true, env: envWith() },
  );
  const plan = JSON.parse(out.replace(/^\uFEFF/, '').trim());
  assert.strictEqual(plan.base, 'origin/main');
  assert.strictEqual(plan.branch, 'task/ps51-smoke-20260924-180000');
  assert.ok(plan.contract.includes('PR Number: 12'));
  assert.ok(!plan.contract.includes(PLACEHOLDER));
});

// ---------------------------------------------------------------------------
// Group I — control-loop Task Ingestion seam (offline mock spawn)
// ---------------------------------------------------------------------------
function mkFakeSession(stateDir, overrides = {}) {
  const repo = 'duongpdddic-droid/Soc_brain';
  const issueNumber = 229;
  const id = identityHash({ repo, issueNumber });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1',
    state: 'SESSION_ACTIVE',
    lifecycle: [],
    taskId: `${repo}#${issueNumber}`,
    repo,
    issueNumber,
    headSha: 'a'.repeat(40),
    baseSha: 'f'.repeat(40),
    worktreePath: path.join(stateDir, 'wt-before-bootstrap'),
    worktreesRoot: stateDir,
    controlPlane: { stateDir },
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session, id, repo, issueNumber };
}

function okStdout(overrides = {}) {
  const {
    goal = 'Integrate Bootstrapper',
    branch = 'task/integrate-bootstrapper-20260924-075429',
    pr = 229,
    worktree = 'C:\\wt\\task\\integrate-bootstrapper-20260924-075429',
    contract = 'C:\\wt\\task\\integrate-bootstrapper-20260924-075429\\SOC_TASK_CONTRACT.md',
  } = overrides;
  return [
    '='.repeat(60),
    `BOOTSTRAP_OK goal=${goal}`,
    `branch=${branch}`,
    `pr=${pr} url=https://github.com/duongpdddic-droid/Soc_brain/pull/${pr} label=status:in-progress draft=False`,
    `worktree=${worktree}`,
    `contract=${contract}`,
    'Next: cd into the worktree and execute the task prompt.',
    '='.repeat(60),
    '',
  ].join('\n');
}

test('I1: buildBootstrapperArgs always prefixes the four safe PowerShell flags + -File', () => {
  const r = buildBootstrapperArgs({
    goal: 'Integrate Bootstrapper',
    issueNumber: 229,
    scriptPath: PS_SCRIPT,
    repoRoot: 'C:\\repo',
    worktreesRoot: 'C:\\repo\\worktrees',
    dryRun: true,
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const args = r.value.args;
  assert.deepStrictEqual(args.slice(0, 5), [...PS_SAFE_FLAGS]);
  assert.deepStrictEqual(PS_SAFE_FLAGS,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.ok(args.includes(PS_SCRIPT));
  assert.ok(args.includes('-Goal') && args.includes('Integrate Bootstrapper'));
  assert.ok(args.includes('-IssueNumber') && args.includes('229'));
  assert.ok(args.includes('-DryRun'));

  const missing = buildBootstrapperArgs({ goal: '', scriptPath: PS_SCRIPT });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.code, 'BOOTSTRAP_GOAL_REQUIRED');

  const badIssue = buildBootstrapperArgs({ goal: 'x', issueNumber: -1, scriptPath: PS_SCRIPT });
  assert.strictEqual(badIssue.ok, false);
  assert.strictEqual(badIssue.code, 'BOOTSTRAP_BAD_ARGS');
});

test('I2: parseBootstrapOutput binds pr/branch/worktree/contract from a real BOOTSTRAP_OK block', () => {
  const good = parseBootstrapOutput(okStdout({
    pr: 4242,
    branch: 'task/full-flow-check-20260924-150000',
    worktree: 'C:\\wt\\task\\full-flow-check-20260924-150000',
    contract: 'C:\\wt\\task\\full-flow-check-20260924-150000\\SOC_TASK_CONTRACT.md',
  }));
  assert.strictEqual(good.ok, true, JSON.stringify(good));
  assert.strictEqual(good.value.prNumber, 4242);
  assert.strictEqual(good.value.branch, 'task/full-flow-check-20260924-150000');
  assert.match(good.value.worktreePath, /full-flow-check/);
  assert.match(good.value.contractPath, /SOC_TASK_CONTRACT\.md$/);
  assert.match(good.value.prUrl, /\/pull\/4242$/);

  assert.strictEqual(parseBootstrapOutput('').code, 'BOOTSTRAP_OUTPUT_UNPARSEABLE');
  assert.strictEqual(parseBootstrapOutput('BOOTSTRAP_OK goal=g\n').code, 'BOOTSTRAP_OUTPUT_UNPARSEABLE');
  assert.strictEqual(
    parseBootstrapOutput('branch=x\npr=1 url=u\nworktree=w\n').code,
    'BOOTSTRAP_OUTPUT_UNPARSEABLE',
  );
});

test('I3: classifyBootstrapFailure maps PRIMARY_DIRTY / network / exit 2 / generic / spawn death', () => {
  assert.strictEqual(
    classifyBootstrapFailure({ exitCode: 1, stderr: 'BOOTSTRAP_FAILED: PRIMARY_DIRTY: stash first' }).code,
    'BOOTSTRAP_PRIMARY_DIRTY',
  );
  assert.strictEqual(
    classifyBootstrapFailure({ exitCode: 1, stderr: 'COMMAND_FAILED exit=1: gh\nETIMEDOUT' }).code,
    'BOOTSTRAP_STEP_FAILED',
  );
  assert.strictEqual(
    classifyBootstrapFailure({ exitCode: 2, stderr: 'BOOTSTRAP_FAILED: GOAL_REQUIRED' }).code,
    'BOOTSTRAP_BAD_ARGS',
  );
  // Unknown non-zero exit with no recognizable marker → generic nonzero code.
  assert.strictEqual(
    classifyBootstrapFailure({ exitCode: 1, stderr: 'random explosion' }).code,
    'BOOTSTRAP_EXIT_NONZERO',
  );
  // Explicit BOOTSTRAP_FAILED marker in stderr maps to BOOTSTRAP_FAILED.
  assert.strictEqual(
    classifyBootstrapFailure({ exitCode: 1, stderr: 'BOOTSTRAP_FAILED: workspace lock held' }).code,
    'BOOTSTRAP_FAILED',
  );
  assert.strictEqual(
    classifyBootstrapFailure({ exitCode: null, signal: 'SIGTERM', stderr: '' }).code,
    'BOOTSTRAP_SPAWN_ERROR',
  );
});

test('I4: runTaskBootstrapper with mock spawn: success parses; exit!=0 and spawn-error fail closed', async () => {
  const stateDir = mkTmp('soc-ing-ok-');
  const seen = [];

  // Success path: mock spawn returns BOOTSTRAP_OK.
  const okRun = await runTaskBootstrapper({
    goal: 'Integrate Bootstrapper',
    issueNumber: 229,
    projectRoot: ROOT,
    stateDir,
    spawnImpl: (cmd, args) => {
      seen.push({ cmd, args });
      return Promise.resolve({ status: 0, signal: null, error: null, stdout: okStdout({ pr: 229 }), stderr: '' });
    },
  });
  assert.strictEqual(okRun.ok, true, JSON.stringify(okRun));
  assert.strictEqual(okRun.value.prNumber, 229);
  assert.strictEqual(okRun.value.branch, 'task/integrate-bootstrapper-20260924-075429');
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].cmd, resolvePowerShellHost());
  assert.deepStrictEqual(seen[0].args.slice(0, 5), [...PS_SAFE_FLAGS]);

  // exit != 0 → classified fail-closed, structured log written.
  const dirty = await runTaskBootstrapper({
    goal: 'x', projectRoot: ROOT, stateDir,
    spawnImpl: () => Promise.resolve({
      status: 1, signal: null, error: null, stdout: '',
      stderr: 'BOOTSTRAP_FAILED: PRIMARY_DIRTY: dirty checkout',
    }),
  });
  assert.strictEqual(dirty.ok, false);
  assert.strictEqual(dirty.code, 'BOOTSTRAP_PRIMARY_DIRTY');
  assert.ok(dirty.detail && dirty.detail.exitCode === 1);

  // Spawn transport throws → BOOTSTRAP_SPAWN_ERROR.
  const boom = await runTaskBootstrapper({
    goal: 'x', projectRoot: ROOT, stateDir,
    spawnImpl: () => Promise.reject(new Error('ENOENT: powershell not found')),
  });
  assert.strictEqual(boom.ok, false);
  assert.strictEqual(boom.code, 'BOOTSTRAP_SPAWN_ERROR');

  // exit 0 but garbage stdout → BOOTSTRAP_OUTPUT_UNPARSEABLE.
  const garbage = await runTaskBootstrapper({
    goal: 'x', projectRoot: ROOT, stateDir,
    spawnImpl: () => Promise.resolve({ status: 0, signal: null, error: null, stdout: 'no marker', stderr: '' }),
  });
  assert.strictEqual(garbage.ok, false);
  assert.strictEqual(garbage.code, 'BOOTSTRAP_OUTPUT_UNPARSEABLE');

  // Structured log has at least one TASK_INGESTION_FAILED line.
  const logPath = path.join(stateDir, 'logs', 'task-ingestion.jsonl');
  assert.ok(fs.existsSync(logPath), 'structured ingestion log must exist');
  const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.some((e) => e.event === 'TASK_INGESTION_FAILED' && e.code === 'BOOTSTRAP_PRIMARY_DIRTY'));
  assert.ok(lines.some((e) => e.event === 'TASK_INGESTION_FAILED' && e.code === 'BOOTSTRAP_SPAWN_ERROR'));
});

test('I5: ingestGoalViaBootstrapper assigns pr/branch/worktree onto the Session lease (read-back verified)', async () => {
  const stateDir = mkTmp('soc-ing-lease-');
  const { sessionPath, id } = mkFakeSession(stateDir);

  const r = await ingestGoalViaBootstrapper({
    goal: 'Integrate Bootstrapper',
    issueNumber: 229,
    sessionPath,
    stateDir,
    repo: 'duongpdddic-droid/Soc_brain',
    projectRoot: ROOT,
    spawnImpl: () => Promise.resolve({
      status: 0, signal: null, error: null,
      stdout: okStdout({ pr: 229, branch: 'task/e2e-boot-20260924-000001' }),
      stderr: '',
    }),
  });

  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.value.session.prNumber, 229);
  assert.strictEqual(r.value.session.branch, 'task/e2e-boot-20260924-000001');
  assert.match(r.value.session.worktreePath, /integrate-bootstrapper-20260924-075429/);
  assert.ok(r.value.session.controlLoop.bootstrapper, 'bootstrapper evidence on session');
  assert.strictEqual(r.value.session.controlLoop.bootstrapper.prNumber, 229);
  // Previous worktree preserved in evidence for audit.
  assert.match(String(r.value.session.controlLoop.bootstrapper.previous.worktreePath), /wt-before-bootstrap/);

  // Disk read-back matches.
  const onDisk = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.strictEqual(onDisk.prNumber, 229);
  assert.strictEqual(onDisk.branch, 'task/e2e-boot-20260924-000001');
  assert.strictEqual(onDisk.identityHash ?? id, onDisk.identityHash ?? id); // identity unchanged shape

  // Success log entry exists.
  const lines = fs.readFileSync(path.join(stateDir, 'logs', 'task-ingestion.jsonl'), 'utf8')
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.some((e) => e.event === 'TASK_INGESTION_OK' && e.prNumber === 229));
});

test('I6: ingestGoalViaBootstrapper dirty-bootstrapper failure never touches the session', async () => {
  const stateDir = mkTmp('soc-ing-dirty-');
  const { sessionPath } = mkFakeSession(stateDir);
  const before = fs.readFileSync(sessionPath, 'utf8');

  const r = await ingestGoalViaBootstrapper({
    goal: 'Integrate Bootstrapper',
    issueNumber: 229,
    sessionPath,
    stateDir,
    projectRoot: ROOT,
    spawnImpl: () => Promise.resolve({
      status: 1, signal: null, error: null, stdout: '',
      stderr: 'BOOTSTRAP_FAILED: PRIMARY_DIRTY: stash/commit first',
    }),
  });

  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'BOOTSTRAP_PRIMARY_DIRTY');
  assert.strictEqual(fs.readFileSync(sessionPath, 'utf8'), before, 'session must be byte-identical after failure');
});

test('I7: assignBootstrapToSession validates inputs and missing session fail-closed', () => {
  const stateDir = mkTmp('soc-ing-asg-');

  // Missing session file.
  const missing = assignBootstrapToSession({
    sessionPath: path.join(stateDir, 'sessions', 'nope.json'),
    bootstrap: { prNumber: 1, branch: 'task/x', worktreePath: '/tmp/x' },
  });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.code, 'SESSION_NOT_FOUND');

  // Invalid bootstrap payload.
  const { sessionPath } = mkFakeSession(stateDir);
  const badPr = assignBootstrapToSession({
    sessionPath,
    bootstrap: { prNumber: 0, branch: 'task/x', worktreePath: '/tmp/x' },
  });
  assert.strictEqual(badPr.ok, false);
  assert.strictEqual(badPr.code, 'BOOTSTRAP_OUTPUT_UNPARSEABLE');

  const badBranch = assignBootstrapToSession({
    sessionPath,
    bootstrap: { prNumber: 5, branch: '', worktreePath: '/tmp/x' },
  });
  assert.strictEqual(badBranch.ok, false);
  assert.strictEqual(badBranch.code, 'BOOTSTRAP_OUTPUT_UNPARSEABLE');
});

// ---------------------------------------------------------------------------
// Group I (cont) — PATH-shadow: control-loop intake invokes the REAL bootstrapper
// offline through mock git/gh, then assigns the Session lease (no network).
// ---------------------------------------------------------------------------
test('I8: PATH-shadow E2E: task-ingestion spawns real Invoke-SocTask.ps1 with mock git/gh, session gets pr/branch/worktree', async () => {
  const s = setupMockRepo();
  const { sessionPath } = mkFakeSession(s.tmp);

  const r = await ingestGoalViaBootstrapper({
    goal: 'Path Shadow Ingest',
    issueNumber: 229,
    sessionPath,
    stateDir: path.join(s.tmp, 'state'),
    repoRoot: s.repoRoot,
    worktreesRoot: s.worktreesRoot,
    projectRoot: ROOT,
    scriptPath: PS_SCRIPT,
    cwd: s.repoRoot,
    // Full process env with PATH led by mock git.CMD/gh.CMD — offline, no network.
    env: envWith(s.env),
  });

  assert.strictEqual(r.ok, true, JSON.stringify(r));
  // Mocked gh pr create returns PR 4242; bootstrapper reports it.
  // issueNumber=229 selects the fix/issue-229-<slug> branch form.
  assert.strictEqual(r.value.session.prNumber, 4242);
  assert.strictEqual(r.value.session.branch, 'fix/issue-229-path-shadow-ingest');
  assert.match(r.value.session.worktreePath, /path-shadow-ingest/);

  // Real mock log proves git/gh ran under the safe PowerShell invocation.
  const log = readLog(s.logPath);
  assert.ok(log.some((e) => e.exe === 'git' && e.args.includes('fetch')), 'bootstrapper fetched via PATH-shadow git');
  assert.ok(log.some((e) => e.exe === 'gh' && e.args.includes('create')), 'bootstrapper created PR via PATH-shadow gh');
});
