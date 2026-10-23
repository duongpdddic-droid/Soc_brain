// tests/roadmap-sync.test.mjs — deterministic post-merge roadmap sync (A+C).
// Covers the pure stamping contract and the GitHub mutation/read-back sequence
// without touching a real repository.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

import {
  stampRoadmap,
  roadmapSyncBranch,
  roadmapSyncPrBody,
  createRoadmapSyncPr,
} from '../packages/control-loop/roadmap-sync.mjs';

const SHA = 'c'.repeat(40);
const DATE = '2026-10-23';

const SAMPLE = [
  '# MASTER ROADMAP',
  'Date: 2026-01-01',
  'Last synchronized (historical): 2025-12-31',
  'Last synchronized (GitHub read-back): 2026-01-01 - PR #1, merge SHA ' + 'a'.repeat(40) + '.',
  'Source audit: sample',
  'North Star: sample',
  '',
  '## Status',
].join('\n');

function j(code, obj, stderr = '') {
  return { code, stdout: JSON.stringify(obj), stderr };
}

function fakeGh({ existing = null, branchCreateFail = false, stampedBranch = false } = {}) {
  const calls = [];
  let roadmap = SAMPLE;
  const branchSha = 'e'.repeat(40);
  let commitSha = stampedBranch ? branchSha : 'd'.repeat(40);
  const stampedBranchText = SAMPLE
    .replace('Date: 2026-01-01', `Date: ${DATE}`)
    .replace(
      'Last synchronized (GitHub read-back): 2026-01-01 - PR #1, merge SHA ' + 'a'.repeat(40) + '.',
      'Last synchronized (GitHub read-back): 2026-01-01 - PR #1, merge SHA ' + 'a'.repeat(40) + '.\n'
        + `Last synchronized (post-merge): ${DATE} - Issue #311 / PR #311, merge SHA ${SHA}; status: pending operator stamp.`,
    );
  const gh = (args) => {
    const a = args.map(String);
    calls.push(a.join(' '));
    if (a[0] === 'pr' && a[1] === 'list') return j(0, existing ? [existing] : []);
    if (a[0] === 'pr' && a[1] === 'create') {
      return { code: 0, stdout: 'https://github.com/o/r/pull/90\n', stderr: '' };
    }
    if (a[0] === 'pr' && a[1] === 'view') {
      return j(0, { state: 'OPEN', number: 90, headRefOid: commitSha });
    }
    if (a[0] === 'api' && a[1] && a[1].includes('/contents/') && !a.includes('-X')) {
      const isBranchRead = a[1].includes('?ref=roadmap');
      const body = isBranchRead && stampedBranch ? stampedBranchText : roadmap;
      return j(0, {
        content: Buffer.from(body, 'utf8').toString('base64'),
        sha: isBranchRead && stampedBranch ? 'branch-file-sha' : 'file-sha',
      });
    }
    if (a[0] === 'api' && a[1] && a[1].includes('/git/ref/heads/') && !a.includes('-X')) {
      return j(0, { object: { sha: branchSha } });
    }
    if (a[0] === 'api' && a.includes('-X') && a[a.indexOf('-X') + 1] === 'POST') {
      if (branchCreateFail) return { code: 1, stdout: '', stderr: 'Reference already exists' };
      return j(0, { ref: 'refs/heads/roadmap/sync' });
    }
    if (a[0] === 'api' && a.includes('-X') && a[a.indexOf('-X') + 1] === 'PUT') {
      const inputPath = a[a.indexOf('--input') + 1];
      const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
      roadmap = Buffer.from(payload.content, 'base64').toString('utf8');
      return j(0, { commit: { sha: commitSha } });
    }
    throw new Error(`unexpected gh call: ${a.join(' ')}`);
  };
  return { gh, calls, getRoadmap: () => roadmap };
}

test('stampRoadmap updates Date and inserts a post-merge evidence line after sync headers', () => {
  const r = stampRoadmap(SAMPLE, { date: DATE, issue: 311, prNumber: 311, mergeCommitSha: SHA });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.changed, true);
  assert.match(r.value.text, /^Date: 2026-10-23$/m);
  assert.match(r.value.text, new RegExp(`Last synchronized \\(post-merge\\): ${DATE} - Issue #311 / PR #311, merge SHA ${SHA}; status: pending operator stamp\\.`));
  const lines = r.value.text.split('\n');
  const syncIdx = lines.findIndex((l) => l.includes('(post-merge)'));
  assert.equal(lines[syncIdx - 1].startsWith('Last synchronized (GitHub read-back):'), true);
});

test('stampRoadmap is idempotent by merge SHA and preserves CRLF', () => {
  const crlf = SAMPLE.replace(/\n/g, '\r\n');
  const first = stampRoadmap(crlf, { date: DATE, issue: 7, prNumber: 8, mergeCommitSha: SHA });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.text.includes('\r\n'), true);
  const second = stampRoadmap(first.value.text, { date: DATE, issue: 7, prNumber: 8, mergeCommitSha: SHA });
  assert.equal(second.ok, true);
  assert.equal(second.value.changed, false);
  assert.equal(second.value.text, first.value.text);
});

test('stampRoadmap keeps exactly one post-merge line across different merges', () => {
  const first = stampRoadmap(SAMPLE, { date: DATE, issue: 1, prNumber: 2, mergeCommitSha: SHA });
  assert.equal(first.ok, true, JSON.stringify(first));
  const nextSha = 'b'.repeat(40);
  const second = stampRoadmap(first.value.text, { date: '2026-10-24', issue: 3, prNumber: 4, mergeCommitSha: nextSha });
  assert.equal(second.ok, true, JSON.stringify(second));
  const lines = second.value.text.split('\n').filter((l) => l.startsWith('Last synchronized (post-merge):'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(nextSha));
  assert.equal(second.value.text.includes(SHA), false);
});

test('stampRoadmap fails closed when the roadmap has no Date anchor', () => {
  const r = stampRoadmap('# no header\n', { date: DATE, issue: 1, prNumber: 2, mergeCommitSha: SHA });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ROADMAP_SYNC_ANCHOR_MISSING');
});

test('roadmapSyncBranch and PR body keep the sync docs-only and status pending', () => {
  const b = roadmapSyncBranch({ issue: 12, prNumber: 13, mergeCommitSha: SHA });
  assert.equal(b.ok, true);
  assert.equal(b.value, `roadmap/sync-12-${SHA.slice(0, 7)}`);
  const body = roadmapSyncPrBody({ issue: 12, prNumber: 13, mergeCommitSha: SHA, date: DATE });
  assert.match(body, /MASTER_ROADMAP_v2\.md/);
  assert.match(body, /pending operator stamp/);
  assert.match(body, new RegExp(SHA));
});

test('createRoadmapSyncPr creates branch, commits header/evidence, opens PR, and reads it back', async () => {
  const fx = fakeGh();
  const r = await createRoadmapSyncPr({
    repo: 'o/r',
    issue: 311,
    prNumber: 311,
    mergeCommitSha: SHA,
    baseBranch: 'main',
    date: DATE,
    gh: fx.gh,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.changed, true);
  assert.equal(r.value.prNumber, 90);
  assert.equal(r.value.headSha, 'd'.repeat(40));
  assert.match(fx.getRoadmap(), /Last synchronized \(post-merge\): 2026-10-23/);
  assert.equal(fx.calls.some((c) => c.startsWith('api -X POST')), true);
  assert.equal(fx.calls.some((c) => c.startsWith('api -X PUT')), true);
  assert.equal(fx.calls.some((c) => c.startsWith('pr create')), true);
  assert.equal(fx.calls.some((c) => c.startsWith('pr view')), true);
});

test('createRoadmapSyncPr adopts an existing PR and never duplicates mutations', async () => {
  const fx = fakeGh({ existing: { number: 90, state: 'OPEN', headRefOid: 'd'.repeat(40) } });
  const r = await createRoadmapSyncPr({
    repo: 'o/r',
    issue: 311,
    prNumber: 311,
    mergeCommitSha: SHA,
    date: DATE,
    gh: fx.gh,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.adopted, true);
  assert.equal(r.value.prNumber, 90);
  assert.deepEqual(fx.calls, ['pr list --repo o/r --head roadmap/sync-311-ccccccc --state all --json number,state,headRefOid']);
});

test('createRoadmapSyncPr recovers a branch that already contains the stamped evidence', async () => {
  const fx = fakeGh({ branchCreateFail: true, stampedBranch: true });
  const r = await createRoadmapSyncPr({
    repo: 'o/r',
    issue: 311,
    prNumber: 311,
    mergeCommitSha: SHA,
    date: DATE,
    gh: fx.gh,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.recoveredBranch, true);
  assert.equal(r.value.headSha, 'e'.repeat(40));
  assert.equal(fx.calls.some((c) => c.startsWith('api -X PUT')), false);
  assert.equal(fx.calls.some((c) => c.startsWith('pr create')), true);
});

test('createRoadmapSyncPr fails closed on branch conflict without blind retry', async () => {
  const fx = fakeGh({ branchCreateFail: true });
  const r = await createRoadmapSyncPr({
    repo: 'o/r',
    issue: 311,
    prNumber: 311,
    mergeCommitSha: SHA,
    date: DATE,
    gh: fx.gh,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ROADMAP_SYNC_BRANCH_CREATE_FAILED');
  assert.equal(fx.calls.some((c) => c.startsWith('pr create')), false);
});
