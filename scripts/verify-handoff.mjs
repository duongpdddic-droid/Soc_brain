#!/usr/bin/env node
// scripts/verify-handoff.mjs - One-command Handoff Verification (Fail-Closed).
//
// Usage:
//   node scripts/verify-handoff.mjs [--base <commit_sha>] [--scope <paths>]
//
// Gate command defaults to `npm run test:gate` and can be overridden for
// isolated verification harnesses via VERIFY_HANDOFF_GATE_CMD.
//
// Exit code 0 only when every check passes; otherwise exit code 1.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Rule patterns are assembled from fragments so this file's own source lines
// never self-match the delegate rules it enforces.
const KW_DECL_RE = new RegExp('\\b' + ['v', 'a', 'r'].join('') + '\\b');
const LOOSE_EQ_RE = new RegExp('[^=!]' + String.fromCharCode(61, 61) + '[^=]' + '|' + '[^!]' + '!' + '=[^=]');
const NESTED_TERNARY_RE = new RegExp('\\u003f.*:.*\\u003f');

function fail(msg) {
  console.error('[FAIL-CLOSED] ' + msg);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.error) fail(cmd + ' spawn error: ' + r.error.message);
  return r;
}

function git(args, repo) {
  return run('git', args, { cwd: repo });
}

function parseArgs(argv) {
  const out = { base: null, scope: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--base') {
      out.base = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--scope') {
      out.scope = argv[i + 1];
      i += 1;
    } else {
      fail('unknown argument: ' + argv[i]);
    }
  }
  return out;
}

const SHA40 = /^[0-9a-f]{40}$/;

function requireValidSha(label, sha, repo) {
  if (typeof sha !== 'string' || !SHA40.test(sha)) fail(label + ' is not a valid 40-hex SHA');
  const v = git(['rev-parse', '--verify', '--quiet', sha + '^{commit}'], repo);
  if (v.status !== 0) fail(label + ' commit does not exist: ' + sha);
  return sha;
}

function resolveBase(baseArg, repo) {
  if (baseArg) return requireValidSha('base', baseArg, repo);
  for (const candidate of ['origin/main', 'main']) {
    const mb = git(['merge-base', 'HEAD', candidate], repo);
    if (mb.status === 0 && SHA40.test(mb.stdout.trim())) return requireValidSha('base', mb.stdout.trim(), repo);
  }
  fail('base commit could not be determined; pass --base <commit_sha>');
  return null;
}

function main() {
  const { base: baseArg, scope } = parseArgs(process.argv);
  const repo = process.cwd();

  const headRes = git(['rev-parse', 'HEAD'], repo);
  if (headRes.status !== 0) fail('HEAD SHA not determinable');
  const head = headRes.stdout.trim();
  requireValidSha('HEAD', head, repo);

  const base = resolveBase(baseArg, repo);

  const status = git(['status', '--porcelain'], repo);
  if (status.status !== 0) fail('git status failed');
  if (status.stdout.trim().length > 0) fail('working tree dirty (staged, unstaged or untracked files present)');

  const scopeArgs = scope ? scope.split(',').map((s) => s.trim()).filter((s) => s.length > 0) : [];
  const diffArgs = ['diff', '--no-color', base, head].concat(scopeArgs.length > 0 ? ['--'].concat(scopeArgs) : []);
  const diffRes = git(diffArgs, repo);
  if (diffRes.status !== 0) fail('diff extraction failed: ' + diffRes.stderr.trim());
  const diff = diffRes.stdout;
  if (typeof diff !== 'string') fail('diff extraction returned non-string');

  const nameRes = git(['diff', '--name-only', base, head].concat(scopeArgs.length > 0 ? ['--'].concat(scopeArgs) : []), repo);
  if (nameRes.status !== 0) fail('file list extraction failed');
  const files = nameRes.stdout.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);

  let digest;
  try {
    digest = createHash('sha256').update(diff, 'utf8').digest('hex');
  } catch (e) {
    fail('diff SHA-256 computation failed: ' + e.message);
  }
  if (typeof digest !== 'string' || digest.length !== 64) fail('diff SHA-256 invalid');

  const violations = [];
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const content = line.slice(1);
    if (KW_DECL_RE.test(content)) violations.push('keyword-declaration :: ' + content);
    if (LOOSE_EQ_RE.test(content)) violations.push('loose-equality :: ' + content);
    if (NESTED_TERNARY_RE.test(content)) violations.push('nested-ternary :: ' + content);
  }
  if (violations.length > 0) {
    for (const v of violations) console.error('[OCR-RULE] ' + v);
    fail('OCR delegate rule violation on added lines (' + violations.length + ')');
  }

  const gateCmd = process.env.VERIFY_HANDOFF_GATE_CMD || 'npm run test:gate';
  const gate = spawnSync(gateCmd, { shell: true, cwd: repo, encoding: 'utf8' });
  if (gate.error) fail('required gate spawn error: ' + gate.error.message);
  if (gate.status !== 0) fail('required gate failed with exit code ' + String(gate.status));

  let repoName = path.basename(repo);
  const remote = git(['remote', 'get-url', 'origin'], repo);
  if (remote.status === 0 && remote.stdout.trim().length > 0) repoName = remote.stdout.trim();

  const outDir = path.join(repo, 'artifacts', 'evidence');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'handoff-verification-' + head + '.md');
  const lines = [];
  lines.push('# Handoff Verification Evidence');
  lines.push('');
  lines.push('- Timestamp: ' + new Date().toISOString());
  lines.push('- Repo: ' + repoName);
  lines.push('- Base SHA: ' + base);
  lines.push('- HEAD SHA: ' + head);
  lines.push('- Diff SHA-256: ' + digest);
  lines.push('- Files: ' + (files.length > 0 ? files.join(', ') : '(none)'));
  lines.push('- OCR Rule Verdict: CLEAN');
  lines.push('- Raw Gate Summary: Exit Code 0 (' + gateCmd + ')');
  lines.push('');
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

  console.log('[PASS] handoff verification OK');
  console.log('[PASS] evidence: ' + outPath);
  process.exit(0);
}

main();
