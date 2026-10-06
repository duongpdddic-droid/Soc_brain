// tests/verify-handoff.test.mjs - branch coverage for scripts/verify-handoff.mjs
// Uses node --test with isolated temp git repos; never touches the live repo state.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

function runVerify(repo, extraArgs = []) {
  return spawnSync('node', [SCRIPT].concat(extraArgs), { cwd: repo, encoding: 'utf8' });
}

function sha256File(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function evidencePath(dir, head) {
  return path.join(dir, 'artifacts', 'evidence', 'handoff-verification-' + head + '.md');
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

const GATE_OK = 'node -e "process.exit(0)"';
const GATE_BAD = 'node -e "process.exit(1)"';

test('fail when working tree dirty or untracked files present; no evidence emitted', () => {
  const { dir, base } = makeRepo();
  const head = commitCleanChange(dir);
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'x\n');
  const r = runVerify(dir, ['--base', base, '--gate-cmd', GATE_OK]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /dirty/);
  assert.equal(fs.existsSync(evidencePath(dir, head)), false, 'evidence bundle must not exist on failure');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fail when base SHA does not exist; no evidence emitted', () => {
  const { dir } = makeRepo();
  const head = commitCleanChange(dir);
  const r = runVerify(dir, ['--base', '0'.repeat(40), '--gate-cmd', GATE_OK]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /base/i);
  assert.equal(fs.existsSync(evidencePath(dir, head)), false, 'evidence bundle must not exist on failure');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fail when diff contains OCR rule violations; no evidence emitted', () => {
  const { dir, base } = makeRepo();
  const head = git(dir, ['rev-parse', 'HEAD']);
  const bad1 = ['v', 'a', 'r'].join('') + ' x = 1;';
  const bad2 = 'if (a ' + String.fromCharCode(61) + String.fromCharCode(61) + ' b) { go(); }';
  const bad3 = 'const t = a ? b : c ' + String.fromCharCode(63) + ' d : e;';
  fs.writeFileSync(path.join(dir, 'bad.mjs'), bad1 + '\n' + bad2 + '\n' + bad3 + '\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'bad change']);
  const newHead = git(dir, ['rev-parse', 'HEAD']);
  const r = runVerify(dir, ['--base', base, '--gate-cmd', GATE_OK]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /OCR/);
  assert.equal(fs.existsSync(evidencePath(dir, newHead)), false, 'evidence bundle must not exist on failure');
  void head;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fail when required gate exits non-zero; no evidence emitted', () => {
  const { dir, base } = makeRepo();
  const head = commitCleanChange(dir);
  const r = runVerify(dir, ['--base', base, '--gate-cmd', GATE_BAD]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /gate/i);
  assert.equal(fs.existsSync(evidencePath(dir, head)), false, 'evidence bundle must not exist on failure');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fail on invalid CLI usage: unknown flag, bad SHA format, missing value', () => {
  const { dir, base } = makeRepo();
  commitCleanChange(dir);
  const unknown = runVerify(dir, ['--nope']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown argument/);
  const badSha = runVerify(dir, ['--base', 'not-a-sha']);
  assert.notEqual(badSha.status, 0);
  assert.match(badSha.stderr, /valid 40-hex/);
  const missing = runVerify(dir, ['--base']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /requires a non-empty value/);
  void base;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pass and emit markdown evidence when everything is clean; hash reproducible', () => {
  const { dir, base } = makeRepo();
  const head = commitCleanChange(dir);
  const r = runVerify(dir, ['--base', base, '--gate-cmd', GATE_OK]);
  assert.equal(r.status, 0, r.stderr);
  const md = fs.readFileSync(evidencePath(dir, head), 'utf8');
  assert.match(md, /Timestamp:/);
  assert.match(md, /Repo:/);
  assert.match(md, new RegExp('Base SHA: ' + base));
  assert.match(md, new RegExp('HEAD SHA: ' + head));
  assert.match(md, /Files:/);
  assert.match(md, /OCR Rule Verdict: CLEAN/);
  assert.match(md, /Raw Gate Summary: Exit Code 0/);
  assert.doesNotMatch(md, /APPROVED/);
  const m = md.match(/Diff SHA-256: ([0-9a-f]{64})/);
  assert.ok(m, 'evidence must carry a concrete diff digest');
  const diffArtifact = path.join(dir, 'artifacts', 'diffs', 'verify-handoff-' + head + '.diff');
  assert.ok(fs.existsSync(diffArtifact), 'diff artifact missing');
  assert.equal(sha256File(diffArtifact), m[1], 'evidence hash must equal independent read-back hash of the diff artifact');
  const gateLog = path.join(dir, 'artifacts', 'evidence', 'verify-handoff-gate-' + head + '.log');
  assert.ok(fs.existsSync(gateLog), 'gate log missing');
  assert.match(fs.readFileSync(gateLog, 'utf8'), /EXIT CODE: 0/);
  fs.rmSync(dir, { recursive: true, force: true });
});
