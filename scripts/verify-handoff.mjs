#!/usr/bin/env node
// scripts/verify-handoff.mjs - One-command Handoff Verification (Fail-Closed).
//
// Usage:
//   node scripts/verify-handoff.mjs [--base <commit_sha>] [--scope <paths>] [--gate-cmd <cmd>]
//
// Gate command is LOCKED to `npm run test:gate` unless the explicit
// --gate-cmd flag is passed (offline unit-test harnesses only). No
// environment-variable override exists, so dogfood/production runs cannot
// silently bypass the required gate.
//
// Exit code 0 only when every check passes; otherwise exit code 1.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_GATE_CMD = 'npm run test:gate';

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
  const r = spawnSync(cmd, args, opts);
  if (r.error) fail(cmd + ' spawn error: ' + r.error.message);
  return r;
}

function gitText(args, repo) {
  const r = run('git', args, { cwd: repo, encoding: 'utf8' });
  return r;
}

function gitBuffer(args, repo) {
  const r = run('git', args, { cwd: repo });
  if (!Buffer.isBuffer(r.stdout)) fail('git did not return a byte stream for ' + args.join(' '));
  return r;
}

function parseArgs(argv) {
  const out = { base: null, scope: null, gateCmd: null };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--base' || flag === '--scope' || flag === '--gate-cmd') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value.length === 0) fail(flag + ' requires a non-empty value');
      if (flag === '--base') out.base = value;
      else if (flag === '--scope') out.scope = value;
      else out.gateCmd = value;
      i += 1;
    } else {
      fail('unknown argument: ' + flag);
    }
  }
  return out;
}

const SHA40 = /^[0-9a-f]{40}$/;

function requireValidSha(label, sha, repo) {
  if (typeof sha !== 'string' || !SHA40.test(sha)) fail(label + ' is not a valid 40-hex SHA');
  const v = gitText(['rev-parse', '--verify', '--quiet', sha + '^{commit}'], repo);
  if (v.status !== 0) fail(label + ' commit does not exist: ' + sha);
  return sha;
}

function resolveBase(baseArg, repo) {
  if (baseArg) return requireValidSha('base', baseArg, repo);
  for (const candidate of ['origin/main', 'main']) {
    const mb = gitText(['merge-base', 'HEAD', candidate], repo);
    if (mb.status === 0 && SHA40.test(mb.stdout.trim())) return requireValidSha('base', mb.stdout.trim(), repo);
  }
  fail('base commit could not be determined; pass --base <commit_sha>');
  return null;
}

function main() {
  const args = parseArgs(process.argv);
  const repo = process.cwd();

  const headRes = gitText(['rev-parse', 'HEAD'], repo);
  if (headRes.status !== 0) fail('HEAD SHA not determinable');
  const head = headRes.stdout.trim();
  requireValidSha('HEAD', head, repo);

  const base = resolveBase(args.base, repo);

  const status = gitText(['status', '--porcelain'], repo);
  if (status.status !== 0) fail('git status failed');
  if (status.stdout.trim().length > 0) fail('working tree dirty (staged, unstaged or untracked files present)');

  const scopeArgs = args.scope ? args.scope.split(',').map((s) => s.trim()).filter((s) => s.length > 0) : [];
  const scopeTail = scopeArgs.length > 0 ? ['--'].concat(scopeArgs) : [];
  const diffRes = gitBuffer(['diff', '--no-color', base, head].concat(scopeTail), repo);
  if (diffRes.status !== 0) fail('diff extraction failed');
  const diffBuf = diffRes.stdout;
  const diffText = diffBuf.toString('utf8');

  const nameRes = gitText(['diff', '--name-only', base, head].concat(scopeTail), repo);
  if (nameRes.status !== 0) fail('file list extraction failed');
  const files = nameRes.stdout.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);

  let digest;
  try {
    digest = createHash('sha256').update(diffBuf).digest('hex');
  } catch (e) {
    fail('diff SHA-256 computation failed: ' + e.message);
  }
  if (typeof digest !== 'string' || digest.length !== 64) fail('diff SHA-256 invalid');

  const diffsDir = path.join(repo, 'artifacts', 'diffs');
  fs.mkdirSync(diffsDir, { recursive: true });
  const diffArtifactPath = path.join(diffsDir, 'verify-handoff-' + head + '.diff');
  fs.writeFileSync(diffArtifactPath, diffBuf);

  const violations = [];
  for (const line of diffText.split('\n')) {
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

  const gateCmd = args.gateCmd === null ? DEFAULT_GATE_CMD : args.gateCmd;
  const gate = spawnSync(gateCmd, { shell: true, cwd: repo });
  if (gate.error) fail('required gate spawn error: ' + gate.error.message);
  const evidenceDir = path.join(repo, 'artifacts', 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const gateLogPath = path.join(evidenceDir, 'verify-handoff-gate-' + head + '.log');
  const gateOut = Buffer.isBuffer(gate.stdout) ? gate.stdout : Buffer.from(String(gate.stdout || ''));
  const gateErr = Buffer.isBuffer(gate.stderr) ? gate.stderr : Buffer.from(String(gate.stderr || ''));
  const logBuf = Buffer.concat([
    Buffer.from('GATE COMMAND: ' + gateCmd + '\nEXIT CODE: ' + String(gate.status) + '\n\nSTDOUT:\n'),
    gateOut,
    Buffer.from('\n\nSTDERR:\n'),
    gateErr,
  ]);
  fs.writeFileSync(gateLogPath, logBuf);
  if (gate.status !== 0) fail('required gate failed with exit code ' + String(gate.status) + ' (log: ' + gateLogPath + ')');

  let repoName = path.basename(repo);
  const remote = gitText(['remote', 'get-url', 'origin'], repo);
  if (remote.status === 0 && remote.stdout.trim().length > 0) repoName = remote.stdout.trim();

  const outPath = path.join(evidenceDir, 'handoff-verification-' + head + '.md');
  const lines = [];
  lines.push('# Handoff Verification Evidence');
  lines.push('');
  lines.push('- Timestamp: ' + new Date().toISOString());
  lines.push('- Repo: ' + repoName);
  lines.push('- Base SHA: ' + base);
  lines.push('- HEAD SHA: ' + head);
  lines.push('- Diff SHA-256: ' + digest);
  lines.push('- Diff Artifact: ' + path.relative(repo, diffArtifactPath).replace(/\\/g, '/'));
  lines.push('- Gate Log: ' + path.relative(repo, gateLogPath).replace(/\\/g, '/'));
  lines.push('- Files: ' + (files.length > 0 ? files.join(', ') : '(none)'));
  lines.push('- OCR Rule Verdict: CLEAN');
  lines.push('- Raw Gate Summary: Exit Code 0 (' + gateCmd + ')');
  lines.push('');
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');

  console.log('[PASS] handoff verification OK');
  console.log('[PASS] evidence: ' + outPath);
  process.exit(0);
}

main();
