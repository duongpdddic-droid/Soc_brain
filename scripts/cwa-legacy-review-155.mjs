#!/usr/bin/env node
// Issue #155 rework round 4: production CWA final review through the legacy
// adoption route (runLegacyFinalReview), then the canonical delivery resume.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const phase = args[0] || 'review';
const HEAD = '1d5e3d5f48c49d7f3a1e1d093c108ef01e6321c2';
const REPO = 'duongpdddic-droid/Soc_brain';
const PR = 156;
const CP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKTREE = CP;
const STATE_DIR = 'C:/Users/Admin/.soc-brain/state';
const COMMENT_URL = process.env.SOC_EVIDENCE_COMMENT_URL || '';

const { adoptLegacyTaskForReview, runLegacyFinalReview } = await import('../packages/control-loop/legacy-adoption.mjs');
const { runControlLoop } = await import('../packages/control-loop/control-loop.mjs');

const evidence = [{ kind: 'artifact', path: 'C:/Users/Admin/.soc-brain/review-ready/duongpdddic-droid_Soc_brain_Issue-155_PR-156_1d5e3d5_review-ready.md' }];
if (COMMENT_URL) evidence.push({ kind: 'pr-comment', url: COMMENT_URL });

if (phase === 'review') {
  const a = await adoptLegacyTaskForReview({
    repo: REPO, issueNumber: 155, pullRequestNumber: PR,
    branch: 'task/issue-155-legacy-adoption', headSha: HEAD,
    worktreePath: WORKTREE, evidence,
    stateDir: STATE_DIR, worktreesRoot: 'C:/Users/Admin/.soc-brain/worktrees',
    adoptedBy: 'lane-155-round4',
  });
  if (!a.ok) { console.error(JSON.stringify({ ok: false, stage: 'adopt', result: a })); process.exit(3); }
  const sessionPath = a.value.sessionPath;
  console.error('adopted:', sessionPath);
  const r = await runLegacyFinalReview({
    sessionPath,
    evidence,
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
