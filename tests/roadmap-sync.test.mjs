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
  localDateYmd,
  createRoadmapSyncPr,
} from '../packages/control-loop/roadmap-sync.mjs';

const SHA = 'c'.repeat(40);
const DATE = '2026-10-23';
const BRANCH = `roadmap/sync-311-${SHA.slice(0, 7)}`;

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

const STAMPED = SAMPLE
  .replace('Date: 2026-01-01', `Date: ${DATE}`)
  .replace(
    'Last synchronized (GitHub read-back): 2026-01-01 - PR #1, merge SHA ' + 'a'.repeat(40) + '.',
    'Last synchronized (GitHub read-back): 2026-01-01 - PR #1, merge SHA ' + 'a'.repeat(40) + '.\n'
      + `Last synchronized (post-merge): ${DATE} - Issue #311 / PR #311, merge SHA ${SHA}; status: pending operator stamp.`,
  );

function j(code, obj, stderr = '') {
  return { code, stdout: JSON.stringify(obj), stderr };
}

function fakeGh({ existing = null, branchExists = false, branchHead = null, stampedBranch = false, refUnknownOnce = false, putFailOnce = false } = {}) {
  const calls = [];
  const roadmap = SAMPLE;
  let branchRoadmap = stampedBranch ? STAMPED : SAMPLE;
  let exists = !!branchExists;
  let head = branchHead || (exists ? SHA : null);
  let putFail = !!putFailOnce;
  let refUnknown = !!refUnknownOnce;
  let commitSha = 'd'.repeat(40);
  const gh = (args) => {
    const a = args.map(String);
    calls.push(a.join(' '));
    if (a[0] === 'pr' && a[1] === 'list') return j(0, existing ? [existing] : []);
    if (a[0] === 'pr' && a[1] === 'create') {
      return { code: 0, stdout: 'https://github.com/o/r/pull/90\n', stderr: '' };
    }
    if (a[0] === 'pr' && a[1] === 'view') {
      return j(0, { state: 'OPEN', number: 90, headRefOid: head, headRefName: BRANCH, baseRefName: 'main' });
    }
    if (a[0] === 'api' && a[1] && a[1].includes('/contents/') && !a.includes('-X')) {
      const isBranchRead = a[1].includes('?ref=roadmap');
      return j(0, {
        content: Buffer.from(isBranchRead ? branchRoadmap : roadmap, 'utf8').toString('base64'),
        sha: isBranchRead ? 'branch-file-sha' : 'file-sha',
      });
    }
    if (a[0] === 'api' && a[1] && a[1].includes('/git/ref/heads/') && !a.includes('-X')) {
      return exists ? j(0, { object: { sha: head } }) : { code: 1, stdout: '', stderr: 'Not Found' };
    }
    if (a[0] === 'api' && a.includes('-X') && a[a.indexOf('-X') + 1] === 'DELETE') {
      exists = false;
      head = null;
      branchRoadmap = SAMPLE;
      return j(0, {});
    }
    if (a[0] === 'api' && a.includes('-X') && a[a.indexOf('-X') + 1] === 'POST') {
      if (refUnknown) {
        refUnknown = false;
        exists = true;
        head = SHA;
        branchRoadmap = SAMPLE;
        return { unknown: true, error: 'transport timeout after create' };
      }
      if (exists) return { code: 1, stdout: '', stderr: 'Reference already exists' };
      exists = true;
      head = SHA;
      branchRoadmap = SAMPLE;
      return j(0, { ref: `refs/heads/${BRANCH}` });
    }
    if (a[0] === 'api' && a.includes('-X') && a[a.indexOf('-X') + 1] === 'PUT') {
      if (putFail) {
        putFail = false;
        return { code: 1, stdout: '', stderr: '409 conflict' };
      }
      const inputPath = a[a.indexOf('--input') + 1];
      const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
      branchRoadmap = Buffer.from(payload.content, 'base64').toString('utf8');
      head = commitSha;
      exists = true;
      return j(0, { commit: { sha: commitSha } });
    }
    throw new Error(`unexpected gh call: ${a.join(' ')}`);
  };
  return { gh, calls, getRoadmap: () => branchRoadmap };
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

test('stampRoadmap does not treat a SHA elsewhere as already stamped', () => {
  const withRemoteSha = `${SAMPLE}\nRemote main: ${SHA}\n`;
  const r = stampRoadmap(withRemoteSha, { date: DATE, issue: 311, prNumber: 311, mergeCommitSha: SHA });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.changed, true);
  assert.match(r.value.text, /^Date: 2026-10-23$/m);
  assert.equal((r.value.text.match(/Last synchronized \(post-merge\):/g) || []).length, 1);
});

test('stampRoadmap fails closed when the roadmap has no Date anchor', () => {
  const r = stampRoadmap('# no header\n', { date: DATE, issue: 1, prNumber: 2, mergeCommitSha: SHA });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ROADMAP_SYNC_ANCHOR_MISSING');
});

test('roadmapSyncBranch, PR body, and local date keep the sync docs-only and pending', () => {
  const b = roadmapSyncBranch({ issue: 12, prNumber: 13, mergeCommitSha: SHA });
  assert.equal(b.ok, true);
  assert.equal(b.value, `roadmap/sync-12-${SHA.slice(0, 7)}`);
  const body = roadmapSyncPrBody({ issue: 12, prNumber: 13, mergeCommitSha: SHA, date: DATE });
  assert.match(body, /MASTER_ROADMAP_v2\.md/);
  assert.match(body, /pending operator stamp/);
  assert.match(body, new RegExp(SHA));
  assert.equal(localDateYmd(new Date(2026, 9, 23, 1, 0, 0)), '2026-10-23');
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
  assert.equal(r.value.recoveredBranch, false);
  assert.match(fx.getRoadmap(), /Last synchronized \(post-merge\): 2026-10-23/);
  assert.equal(fx.calls.some((c) => c.startsWith('api -X POST')), true);
  assert.equal(fx.calls.some((c) => c.startsWith('api -X PUT')), true);
  assert.equal(fx.calls.some((c) => c.startsWith('pr create')), true);
  assert.equal(fx.calls.some((c) => c.startsWith('pr view')), true);
});

test('createRoadmapSyncPr adopts an existing identity-matching PR and never duplicates mutations', async () => {
  const fx = fakeGh({
    existing: { number: 90, state: 'OPEN', headRefOid: 'd'.repeat(40), headRefName: BRANCH, baseRefName: 'main' },
  });
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
  assert.equal(r.value.headRefName, BRANCH);
  assert.equal(r.value.baseRefName, 'main');
  assert.deepEqual(fx.calls, [
    `pr list --repo o/r --head ${BRANCH} --state all --json number,state,headRefOid,headRefName,baseRefName`,
  ]);
});

test('createRoadmapSyncPr refuses to adopt a PR with the wrong head/base identity', async () => {
  const fx = fakeGh({
    existing: { number: 90, state: 'OPEN', headRefOid: 'd'.repeat(40), headRefName: 'agent/not-roadmap', baseRefName: 'main' },
  });
  const r = await createRoadmapSyncPr({
    repo: 'o/r',
    issue: 311,
    prNumber: 311,
    mergeCommitSha: SHA,
    date: DATE,
    gh: fx.gh,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ROADMAP_SYNC_PR_IDENTITY_INVALID');
});

test('createRoadmapSyncPr recovers a branch at the merge commit with no stamp yet', async () => {
  const fx = fakeGh({ branchExists: true, branchHead: SHA });
  const r = await createRoadmapSyncPr({
    repo: 'o/r',
    issue: 311,
    prNumber: 311,
    mergeCommitSha: SHA,
    date: DATE,
    gh: fx.gh,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.changed, true);
  assert.equal(r.value.recoveredBranch, true);
  assert.equal(r.value.headSha, 'd'.repeat(40));
  assert.equal(fx.calls.some((c) => c.startsWith('api -X POST')), false);
  assert.equal(fx.calls.some((c) => c.startsWith('api -X PUT')), true);
});

test('createRoadmapSyncPr recovers a branch that already contains the stamped evidence', async () => {
  const fx = fakeGh({ branchExists: true, branchHead: 'e'.repeat(40), stampedBranch: true });
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

test('createRoadmapSyncPr converges after an ambiguous branch-create response', async () => {
  const fx = fakeGh({ refUnknownOnce: true });
  const opts = {
    repo: 'o/r', issue: 311, prNumber: 311, mergeCommitSha: SHA, date: DATE, gh: fx.gh,
  };
  const first = await createRoadmapSyncPr(opts);
  assert.equal(first.ambiguous, true);
  assert.equal(first.code, 'ROADMAP_SYNC_BRANCH_UNKNOWN');
  const second = await createRoadmapSyncPr(opts);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.value.recoveredBranch, true);
  assert.equal(fx.calls.filter((c) => c.startsWith('pr create')).length, 1);
});

test('createRoadmapSyncPr retries a definite PUT conflict and creates exactly one PR', async () => {
  const fx = fakeGh({ branchExists: true, branchHead: SHA, putFailOnce: true });
  const opts = {
    repo: 'o/r', issue: 311, prNumber: 311, mergeCommitSha: SHA, date: DATE, gh: fx.gh,
  };
  const first = await createRoadmapSyncPr(opts);
  assert.equal(first.ok, false);
  assert.equal(first.code, 'ROADMAP_SYNC_COMMIT_FAILED');
  const second = await createRoadmapSyncPr(opts);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(fx.calls.filter((c) => c.startsWith('pr create')).length, 1);
});

test('createRoadmapSyncPr deletes its newly-created ref after a definite PUT failure, then retries cleanly', async () => {
  const fx = fakeGh({ putFailOnce: true });
  const opts = {
    repo: 'o/r', issue: 311, prNumber: 311, mergeCommitSha: SHA, date: DATE, gh: fx.gh,
  };
  const first = await createRoadmapSyncPr(opts);
  assert.equal(first.ok, false);
  assert.equal(first.code, 'ROADMAP_SYNC_COMMIT_FAILED');
  assert.equal(fx.calls.some((c) => c.startsWith('api -X DELETE')), true);
  const second = await createRoadmapSyncPr(opts);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(fx.calls.filter((c) => c.startsWith('pr create')).length, 1);
});

test('createRoadmapSyncPr fails closed on a foreign branch without a stamp', async () => {
  const fx = fakeGh({ branchExists: true, branchHead: 'f'.repeat(40) });
  const r = await createRoadmapSyncPr({
    repo: 'o/r', issue: 311, prNumber: 311, mergeCommitSha: SHA, date: DATE, gh: fx.gh,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ROADMAP_SYNC_BRANCH_FOREIGN');
  assert.equal(fx.calls.some((c) => c.startsWith('pr create')), false);
});
