#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : null;
}

const title = getArg('--title') || 'feat(supervisor): autonomous task';
const goal = getArg('--goal') || `goal-${Date.now()}`;
const baseBranch = getArg('--base') || 'main';

console.log(`🚀 [Bootstrap] Bắt đầu khởi tạo task: "${title}"...`);

const sessionId = crypto.randomBytes(16).toString('hex');
const branchName = `agent/${sessionId}`;
const userProfile = process.env.USERPROFILE || process.env.HOME;
const worktreeDir = path.join(userProfile, '.soc-brain', 'worktrees', 'agent', sessionId);

run('git', ['fetch', 'origin', baseBranch]);
fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });

console.log(`📁 [Worktree] Đang tạo tại: ${worktreeDir}`);
run('git', ['worktree', 'add', worktreeDir, '-b', branchName, `origin/${baseBranch}`]);

const agentDir = path.join(worktreeDir, '.opencode', 'agents');
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

const contractContent = `# Task Contract — ${title}
Goal ID: ${goal}
Branch: ${branchName}
Status: IN_PROGRESS

## Scope
- Deliverables:
- Out of scope:

## Verification Gates
- node --test tests/*.test.mjs
- git diff --check
`;
fs.writeFileSync(path.join(worktreeDir, 'SOC_TASK_CONTRACT.md'), contractContent, 'utf8');

console.log(`🔗 [GitHub] Đang push branch và mở Draft PR...`);
run('git', ['add', '.'], { cwd: worktreeDir });
run('git', ['commit', '-m', `chore(bootstrap): initialize worktree for ${title}`], { cwd: worktreeDir });
run('git', ['push', '-u', 'origin', branchName], { cwd: worktreeDir });

try {
  const prUrl = run('gh', [
    'pr', 'create',
    '--repo', 'duongpdddic-droid/Soc_brain',
    '--title', title,
    '--body', `Automated provisioned task for ${goal}.\nWorktree: \`${sessionId}\``,
    '--base', baseBranch,
    '--head', branchName,
    '--draft',
    '--label', 'status:in-progress',
  ], { cwd: worktreeDir });
  console.log(`✅ [PR Created] ${prUrl}`);
} catch (e) {
  console.warn(`⚠️ [Warning] Chưa tạo được PR qua gh CLI: ${e.message}`);
}

console.log('\n' + '='.repeat(60));
console.log('🎉 KHỞI TẠO HOÀN TẤT TRONG TÍCH TẮC!');
console.log(`👉 Worktree Path: ${worktreeDir}`);
console.log(`👉 Lệnh chuyển vào làm việc:`);
console.log(`   cd "${worktreeDir}"`);
console.log('='.repeat(60) + '\n');
