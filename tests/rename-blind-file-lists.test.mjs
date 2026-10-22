// tests/rename-blind-file-lists.test.mjs — the SAME root cause as the F1 fix in
// PR #307, on the two file-list readers it did not cover.
//
// A rename is a delete + an add. With git's default rename detection on, both
// `readRangeFileList` (the review-leg scope reader) and `verify-handoff` (the
// handoff evidence reader) reported ONLY the destination path, so
// `git mv src/x.mjs docs/x.md` made the old source path disappear from the
// review scope and from the handoff evidence: a source file could vanish
// unreviewed while the list looked doc-only. The canonical fix (see
// packages/review-leg/doc-only-scope.mjs) is `--no-renames --name-only -z`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRangeFileList } from '../packages/review-leg/review-only.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERIFY_SCRIPT = path.join(REPO_ROOT, 'scripts', 'verify-handoff.mjs');

function git(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, 'git ' + args.join(' ') + ' failed: ' + r.stderr);
  return r.stdout.trim();
}

// base: src/x.mjs exists. head: same content, renamed to docs/x.md.
function makeRenameRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-test-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'x.mjs'), 'export const x = 1;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'base']);
  const base = git(dir, ['rev-parse', 'HEAD']);
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.renameSync(path.join(dir, 'src', 'x.mjs'), path.join(dir, 'docs', 'x.md'));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'rename source file into docs']);
  const head = git(dir, ['rev-parse', 'HEAD']);
  return { dir, base, head };
}

test('B1: readRangeFileList reports BOTH sides of a rename', () => {
  const { dir, base, head } = makeRenameRepo();
  try {
    const r = readRangeFileList({ repo: dir, from: base, to: head });
    assert.equal(r.ok, true, r.detail || r.reason || 'range file list failed');
    assert.deepEqual([...r.files].sort(), ['docs/x.md', 'src/x.mjs'],
      'the vanished source path must stay in the review scope');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('B2: verify-handoff evidence names BOTH sides of a rename', () => {
  const { dir, base, head } = makeRenameRepo();
  try {
    const r = spawnSync('node', [VERIFY_SCRIPT, '--base', base, '--gate-cmd', 'node -e "process.exit(0)"'],
      { cwd: dir, encoding: 'utf8', timeout: 120000 });
    if (r.error) throw new Error('verify-handoff spawn error: ' + r.error.message);
    if (r.signal) throw new Error('verify-handoff killed by signal: ' + r.signal);
    assert.equal(r.status, 0, 'verify-handoff failed: ' + (r.stderr || '(no stderr)'));
    const evidence = path.join(dir, 'artifacts', 'evidence', `handoff-verification-${head}.md`);
    assert.equal(fs.existsSync(evidence), true, 'evidence bundle missing');
    const filesLine = fs.readFileSync(evidence, 'utf8').split('\n').find((l) => l.startsWith('- Files:'));
    assert.ok(filesLine, 'evidence must carry the Files: line');
    assert.match(filesLine, /src\/x\.mjs/, 'vanished source path must be named in the evidence');
    assert.match(filesLine, /docs\/x\.md/, 'new destination path must be named in the evidence');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
