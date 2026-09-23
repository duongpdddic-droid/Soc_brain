#!/usr/bin/env node
// soc-task-bootstrap.mjs - Soc_brain: automated task provisioning & zero-thought bootstrapper.
// Fail-closed: every step is verified; any failure rolls back ALL created artifacts (worktree, binding, branch, PR)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { provision, verifyBinding, cleanup, defaultWorktreesRoot, identityHash, worktreeBranchFor, worktreePathFor, bindingPathFor, SHA40_RE } from '../packages/workspace/workspace.mjs';
import { normalizeRemoteUrl } from '../packages/safe-git/safe-git.mjs';

// Canonical groundtruth config
const REPO = 'duongpdddic-droid/Soc_brain';
const CANONICAL_REPO = normalizeRemoteUrl(REPO);

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

// Exported for testing
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      args[key] = (!next || next.startsWith('--')) ? true : argv[++i];
    }
  }
  return args;
}

function fail(message, details = null) {
  console.error('FAIL: ' + message);
  if (details) console.error(details);
  process.exit(1);
}

function notify(phase, msg) {
  try { run('node', ['bin/soc-notify.mjs', phase, msg], { timeout: 10000 }); } catch {}
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  const title = args.title || 'feat(bootstrap): autonomous task';
  const goal = args.goal || 'goal-' + Date.now();
  const baseBranch = args.base || 'main';
  // --issue is optional; if not provided, derive from goal or use a generated ID
  const issueNumber = args.issue ? Number(args.issue) : 0;

  console.log('Bootstrap: Bat dau task: ' + title);
  console.log('   Goal: ' + goal);
  console.log('   Base: ' + baseBranch);
  if (issueNumber > 0) console.log('   Issue: ' + issueNumber);

  notify('EXECUTING', 'Bat dau bootstrap: ' + title);

  let baseSha;
  try {
    run('git', ['fetch', 'origin', baseBranch]);
    baseSha = run('git', ['rev-parse', 'origin/' + baseBranch]);
    if (!SHA40_RE.test(baseSha)) fail('Base SHA khong hop le: ' + baseSha);
  } catch (e) {
    fail('khong the xac dinh duoc base SHA: ' + String(e));
  }
  console.log('Base: ' + baseSha.slice(0, 12));

  const worktreesRoot = defaultWorktreesRoot();
  const h = identityHash({ repo: CANONICAL_REPO, issueNumber: issueNumber || 9999 });
  if (!h) fail('identity hash unstable');
  const branchName = worktreeBranchFor({ identityHash: h });
  const wtPath = worktreePathFor({ worktreesRoot, identityHash: h });
  const bPath = bindingPathFor({ worktreesRoot, identityHash: h });

  console.log('Worktree: ' + wtPath);
  console.log('Branch: ' + branchName);

  const created = { worktree: false, binding: false, branch: false, prNumber: null };

  // Use issueNumber for provision if provided, otherwise use 9999 for generated tasks
  const provisionIssueNumber = issueNumber > 0 ? issueNumber : 9999;
  const prov = provision({ worktreesRoot, repo: REPO, issueNumber: provisionIssueNumber, baseSha: baseSha, cwd: process.cwd() });
  if (!prov.ok) { fail('Provision that bai: ' + prov.reason, prov.detail); }
  created.worktree = true; created.binding = true;
  console.log('Provision: ' + (prov.idempotent ? 'idempotent' : 'moi'));

  const vb = verifyBinding({ worktreesRoot, repo: REPO, issueNumber: provisionIssueNumber, baseSha: baseSha, cwd: process.cwd() });
  if (!vb.ok) {
    const c = cleanup({ worktreesRoot, repo: REPO, issueNumber: provisionIssueNumber, baseSha: baseSha, cwd: process.cwd(), keepBranch: false });
    fail('Verify that bai: ' + vb.reason, vb.detail);
  }
  console.log('Verify: HEAD @ ' + vb.head.slice(0, 12) + ', branch ' + vb.branch);

  const agentDir = path.join(wtPath, '.opencode', 'agents');
  fs.mkdirSync(agentDir, { recursive: true });
  const buildAgentConfig = `---
description: Build and test execution worker
mode: primary
permission:
  bash: allow
  read: allow
  glob: allow
  grep: allow
  edit: allow
  mcp: deny
---

You are build executor. Your role is strictly to write code and run tests inside this isolated worktree.
`;
  fs.writeFileSync(path.join(agentDir, 'build.md'), buildAgentConfig, 'utf8');
  console.log('Agent Config: .opencode/agents/build.md');

  const contractContent = `# Task Contract — ${title}
Goal ID: ${goal}
Branch: ${branchName}
Status: IN_PROGRESS

## Scope
- Deliverables:
  - Automated task provisioning script (bin/soc-task-bootstrap.mjs)
  - Offline test suite (tests/soc-task-bootstrap.test.mjs)
  - Full regression test pass (node --test tests/*.test.mjs)
  - Diff bundle artifacts/diffs/pr-214-diff.zip
- Out of scope:
  - Runtime sandbox MCP server changes
  - Control-loop FSM modifications
  - Telegram dispatch modifications

## Verification Gates
- node --test tests/soc-task-bootstrap.test.mjs
- node --test tests/*.test.mjs (full regression)
- git diff --check
- Diff bundle created at artifacts/diffs/pr-214-diff.zip

## Acceptance Criteria
- [ ] Script accepts --title, --goal, --base, --issue CLI args
- [ ] Creates isolated worktree at ~/.soc-brain/worktrees/agent/<session_id>
- [ ] Generates .opencode/agents/build.md with standard permissions
- [ ] Generates SOC_TASK_CONTRACT.md with full objectives, scope, gates
- [ ] Pushes branch and opens draft PR with status:in-progress label
- [ ] Fail-closed rollback on any step failure (worktree, binding, branch cleaned up)
- [ ] Offline tests pass (mocked provisioning, file structure, error cleanup)
- [ ] Full regression suite passes 100%
`;
  fs.writeFileSync(path.join(wtPath, 'SOC_TASK_CONTRACT.md'), contractContent, 'utf8');
  console.log('Contract: SOC_TASK_CONTRACT.md');

  try {
    run('git', ['add', '.'], { cwd: wtPath });
    run('git', ['commit', '-m', 'chore(bootstrap): initialize worktree for ' + title], { cwd: wtPath });
    run('git', ['push', '-u', 'origin', branchName], { cwd: wtPath });
    created.branch = true;
    console.log('Git: Branch pushed to origin/' + branchName);
  } catch (e) {
    const c = cleanup({ worktreesRoot, repo: REPO, issueNumber: provisionIssueNumber, baseSha: baseSha, cwd: process.cwd(), keepBranch: false });
    fail('Git commit/push that bai', String(e));
  }

  let prUrl;
  try {
    prUrl = run('gh', ['pr', 'create', '--repo', REPO, '--title', title, '--body', 'Automated provisioned task for ' + goal + '.\nWorktree: `' + h + '`\nBranch: `' + branchName + '`\n\n', '--base', baseBranch, '--head', branchName, '--draft', '--label', 'status:in-progress'], { cwd: wtPath });
    const prMatch = prUrl.match(/pull\/(\d+)/);
    created.prNumber = prMatch ? Number(prMatch[1]) : null;
    console.log('PR Created: ' + prUrl + ' (PR #' + created.prNumber + ')');
  } catch (e) {
    try { run('git', ['push', 'origin', '--delete', branchName], { cwd: process.cwd() }); } catch {}
    try { run('git', ['branch', '-D', branchName], { cwd: process.cwd() }); } catch {}
    const c = cleanup({ worktreesRoot, repo: REPO, issueNumber: provisionIssueNumber, baseSha: baseSha, cwd: process.cwd(), keepBranch: false });
    fail('Tao PR that bai', String(e));
  }

  console.log('\n' + '='.repeat(60));
  console.log('KHOI TAO HOAN TAT!');
  console.log('Worktree Path: ' + wtPath);
  console.log('Branch: ' + branchName);
  console.log('PR: ' + prUrl);
  console.log('Lenh cd: ' + wtPath);
  console.log('='.repeat(60) + '\n');
  notify('EXECUTING', 'Hoan tat bootstrap task ' + title + ' -- PR ' + prUrl);
}

// Only run main() when executed directly, not when imported as a module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('Unhandled error:', e); process.exit(1); });
}