// tests/verify-handoff.test.mjs - branch coverage for scripts/verify-handoff.mjs
// Uses node --test with isolated temp git repos; never touches the live repo state.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'verify-handoff.mjs');

function git(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, 'git ' + args.join(' ') + ' failed: ' + r.stderr);
  return r.stdout.trim();
}

function runVerify(repo, extraArgs = [], gateCmd = 'node -e "process.exit(0)"') {
  return spawnSync('node', [SCRIPT].concat(extraArgs), {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, VERIFY_HANDOFF_GATE_CMD: gateCmd },
  });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-test-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'base']);
  const base = git(dir, ['rev-parse', 'HEAD']);
  return { dir, base };
}

function commitCleanChange(dir) {
  fs.writeFileSync(path.join(dir, 'b.mjs'), 'export const answer = 42;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'clean change']);
  return git(dir, ['rev-parse', 'HEAD']);
}

test('fail when working tree dirty or untracked files present', () => {
  const { dir, base } = makeRepo();
  commitCleanChange(dir);
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'x\n');
  const r = runVerify(dir, ['--base', base]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /dirty/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fail when base SHA does not exist', () => {
  const { dir, base } = makeRepo();
  commitCleanChange(dir);
  const r = runVerify(dir, ['--base', '0'.repeat(40)]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /base/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fail when diff contains OCR rule violations', () => {
  const { dir, base } = makeRepo();
  const bad1 = ['v', 'a', 'r'].join('') + ' x = 1;';
  const bad2 = 'if (a ' + String.fromCharCode(61) + String.fromCharCode(61) + ' b) { go(); }';
  const bad3 = 'const t = a ? b : c ' + String.fromCharCode(63) + ' d : e;';
  fs.writeFileSync(path.join(dir, 'bad.mjs'), bad1 + '\n' + bad2 + '\n' + bad3 + '\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'bad change']);
  const r = runVerify(dir, ['--base', base]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /OCR/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fail when required gate exits non-zero', () => {
  const { dir, base } = makeRepo();
  commitCleanChange(dir);
  const r = runVerify(dir, ['--base', base], 'node -e "process.exit(1)"');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /gate/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pass and emit markdown evidence when everything is clean', () => {
  const { dir, base } = makeRepo();
  const head = commitCleanChange(dir);
  const r = runVerify(dir, ['--base', base]);
  assert.equal(r.status, 0, r.stderr);
  const evidencePath = path.join(dir, 'artifacts', 'evidence', 'handoff-verification-' + head + '.md');
  assert.ok(fs.existsSync(evidencePath), 'evidence file missing');
  const md = fs.readFileSync(evidencePath, 'utf8');
  assert.match(md, /Timestamp:/);
  assert.match(md, /Repo:/);
  assert.match(md, new RegExp('Base SHA: ' + base));
  assert.match(md, new RegExp('HEAD SHA: ' + head));
  assert.match(md, /Diff SHA-256: [0-9a-f]{64}/);
  assert.match(md, /Files:/);
  assert.match(md, /OCR Rule Verdict: CLEAN/);
  assert.match(md, /Raw Gate Summary: Exit Code 0/);
  assert.doesNotMatch(md, /APPROVED/);
  fs.rmSync(dir, { recursive: true, force: true });
});
