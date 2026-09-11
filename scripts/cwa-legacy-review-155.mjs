#!/usr/bin/env node
// Issue #155 rework round 4: production CWA final review through the legacy
// adoption route (runLegacyFinalReview), then the canonical delivery resume.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const phase = args[0] || 'review';
// The reviewed HEAD is read DYNAMICALLY from the lane worktree — never
// hard-coded (Issue #155 round-5 review finding: a stale pin can point the
// production review at an obsolete head).
const HEAD = execFileSync('git', ['-C', path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const REPO = 'duongpdddic-droid/Soc_brain';
const PR = 156;
const CP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKTREE = CP;
const STATE_DIR = 'C:/Users/Admin/.soc-brain/state';
const COMMENT_URL = process.env.SOC_EVIDENCE_COMMENT_URL || 'https://github.com/duongpdddic-droid/Soc_brain/pull/156#issuecomment-5632687353';

const { adoptLegacyTaskForReview, runLegacyFinalReview, refreshAdoptedHead } = await import('../packages/control-loop/legacy-adoption.mjs');
const { runControlLoop } = await import('../packages/control-loop/control-loop.mjs');

const evidence = [{ kind: 'artifact', path: fs.readFileSync('C:/Users/Admin/.soc-brain/state/legacy-155-current-packet.txt', 'utf8').trim() }];
if (COMMENT_URL) evidence.push({ kind: 'pr-comment', url: COMMENT_URL });

if (phase === 'review') {
  let sessionPath;
  const a = await adoptLegacyTaskForReview({
    repo: REPO, issueNumber: 155, pullRequestNumber: PR,
    branch: 'task/issue-155-legacy-adoption', headSha: HEAD, baseSha: '5ddc30a047d088a76150837b2b4bc86a2984ab6d',
    worktreePath: WORKTREE, evidence,
    stateDir: STATE_DIR, worktreesRoot: 'C:/Users/Admin/.soc-brain/worktrees',
    adoptedBy: 'lane-155-round4',
  });
  if (a.ok) {
    sessionPath = a.value.sessionPath;
  } else if (a.code === 'LEGACY_ADOPTION_CONFLICT' || a.code === 'SESSION_ALREADY_TERMINAL') {
    // The canonical session already exists for this identity (an earlier
    // adoption/round); the head has been refreshed via refreshAdoptedHead —
    // reuse the canonical session path (never a second adoption).
    sessionPath = 'C:/Users/Admin/.soc-brain/state/sessions/7a47cffa2d5cda1653c9912134676bcb.json';
    console.error('reusing adopted session (adoption replay: ' + a.code + ')');
  } else {
    console.error(JSON.stringify({ ok: false, stage: 'adopt', result: a }));
    process.exit(3);
  }
  console.error('session:', sessionPath);
  let verificationResult = null;
  const vrPath = 'C:/Users/Admin/.soc-brain/state/legacy-155-current-verification.json';
  try { verificationResult = JSON.parse(fs.readFileSync(vrPath, 'utf8')); } catch { /* absent = fail-closed in the runner */ }
  const r = await runLegacyFinalReview({
    sessionPath,
    evidence,
    verificationResult,
    stateDir: STATE_DIR,
    outputDir: 'C:/Users/Admin/.soc-brain/review-ready',
    env: process.env,
  });
  console.log(JSON.stringify({ ok: r.ok, code: r.code ?? null, verdict: r.value?.verdict ?? null, fsm: r.fsm ?? null, metadata: r.value?.metadata ?? null, binding: r.value?.binding ?? null, findings: r.value?.findings ?? null }, null, 2));
  fs.writeFileSync('C:/Users/Admin/.soc-brain/state/legacy-155-review-result.json', JSON.stringify({ sessionPath, result: r }, null, 2));
  process.exit(r.ok && r.value?.verdict === 'PASS' ? 0 : (r.ok ? 5 : 4));
}

if (phase === 'deliver') {
  const sessionPath = args[1];
  if (!sessionPath) { console.error('deliver: sessionPath required'); process.exit(2); }
  const res = await runControlLoop({
    sessionPath,
    identityHash: (await import('../packages/workspace/workspace.mjs')).identityHash({ repo: REPO, issueNumber: 155 }),
    stateDir: STATE_DIR,
    deps: {},
  });
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok && res.value?.state === 'COMPLETED' ? 0 : 4);
}
console.error('usage: cwa-legacy-review-155.mjs review|deliver [sessionPath]');
process.exit(64);
