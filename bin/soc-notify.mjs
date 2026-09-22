#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dispatchLifecycleEvent } from '../packages/telegram-dispatch/telegram-dispatch.mjs';

function runCmd(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function getPrData() {
  try {
    const raw = runCmd('gh', ['pr', 'view', '--json', 'number,title,url']);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const [event = 'EXECUTING', ...noteParts] = process.argv.slice(2);
const note = noteParts.join(' ');

const home = os.homedir();
const configPath = process.env.TELEGRAM_CONFIG_PATH || path.join(home, '.soc-brain', 'telegram.json');
const stateDir = process.env.SOC_STATE_DIR || path.join(home, '.soc-brain', 'state');

const branch = runCmd('git', ['branch', '--show-current']) || 'main';
const headSha = runCmd('git', ['rev-parse', '--short', 'HEAD']) || 'unknown';
const pr = getPrData();

// Tên task/issue mặc định hoặc lấy từ biến môi trường
const issueTitle = process.env.SOC_TASK_TITLE || 'Supervisor: Reactive Engine & Drift Guard';
const issueNumber = pr?.number || Number(process.env.SOC_ISSUE) || 9000022;

const runNonce = crypto.randomBytes(4).toString('hex');
const session = {
  repo: 'duongpdddic-droid/Soc_brain',
  issueNumber: issueNumber,
  // Gán session.pr để template core không in "PR: chưa tạo"
  pr: pr ? `#${pr.number} (${pr.title})` : `[Đang triển khai trên branch: ${branch}]`,
  headSha: `${headSha}-${Date.now()}-${runNonce}`,
  baseSha: '0000000000000000000000000000000000000000',
};

// Đưa thẳng Tên Task / PR vào phần ghi chú nổi bật
const fullNote = [
  `🎯 Task: ${issueTitle}`,
  pr ? `🔗 PR: #${pr.number} — ${pr.title}` : `🌿 Branch: ${branch}`,
  note ? `📝 Chi tiết: ${note}` : ''
].filter(Boolean).join('\n');

const result = dispatchLifecycleEvent({
  session,
  event,
  note: fullNote,
  stateDir,
  configPath,
  allowNonCanonicalStateRoot: true,
});

if (result.status === 'API_ACCEPTED') {
  console.log(`📡 [Telegram] Báo thành công mốc: ${event}`);
} else {
  console.log(`⚠️ [Telegram] Lỗi: ${result.status} (${result.reason || ''})`);
}
