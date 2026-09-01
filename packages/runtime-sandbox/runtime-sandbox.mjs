#!/usr/bin/env node
// runtime-sandbox.mjs - Soc_brain: provider-neutral harness boundary (Issue #18).
// Minimal vertical slice: task_start admission, fail-closed guards, evidence.

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  provision, defaultWorktreesRoot,
  identityHash, worktreeBranchFor,
  SHA40_RE,
} from '../workspace/workspace.mjs';
import {
  gitRoot, readBranchInfo, readLocalHead,
  normalizeRemoteUrl,
} from '../safe-git/safe-git.mjs';
import { isInside, isReparsePoint } from '../temp-hygiene/temp-hygiene.mjs';
import { createExecutionBroker } from '../execution-broker/execution-broker.mjs';
import { buildOpenCodeConfig, writeOpenCodeConfig, readOpenCodeConfigDigest } from './opencode-adapter.mjs';

export const SANDBOX_SCHEMA_VERSION = '1';
export const ALLOWED_OPERATIONS = ['status', 'diff', 'run_registered_test'];

const run = (cmd, args, { cwd, exec = execFileSync } = {}) => {
  const out = exec(cmd, args, { cwd, encoding: 'utf8' });
  return String(out).replace(/\r\n/g, '\n').trim();
};

function realPathOrNull(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

// ---- mainCheckoutGuard --------------------------------------------------------
// Fail-closed: rejects if the bound worktree resolves to (or inside) the main
// checkout, or shares the same git-common-dir (canonical checkout execution).
export function mainCheckoutGuard({ worktree, controlCwd, exec = execFileSync }) {
  let mainRoot;
  try { mainRoot = gitRoot({ cwd: controlCwd, exec }); } catch {
    return { ok: false, errors: [{ reason: 'NO_GIT_ROOT', detail: 'Cannot determine main checkout Git root.' }] };
  }
  const mainAbs = path.resolve(mainRoot);
  const wtReal = realPathOrNull(worktree);
  if (wtReal) {
    if (isInside(mainAbs, wtReal)) {
      return { ok: false, errors: [{ reason: 'WORKTREE_INSIDE_MAIN_CHECKOUT', detail: 'Bound worktree resolves inside the main checkout.' }] };
    }
    if (path.resolve(wtReal) === mainAbs) {
      return { ok: false, errors: [{ reason: 'WORKTREE_IS_MAIN_CHECKOUT', detail: 'Bound worktree IS the main checkout.' }] };
    }
  }
  try {
    const wtCommonDir = run('git', ['rev-parse', '--git-common-dir'], { cwd: worktree, exec });
    const mainGitDir = run('git', ['rev-parse', '--git-dir'], { cwd: controlCwd, exec });
    if (path.resolve(wtCommonDir) === path.resolve(mainGitDir)) {
      return { ok: false, errors: [{ reason: 'SHARED_GIT_COMMON_DIR', detail: 'Worktree shares git common-dir with main checkout.' }] };
    }
  } catch {
    return { ok: false, errors: [{ reason: 'WORKTREE_NOT_GIT', detail: 'Worktree path is not a Git repository.' }] };
  }
  return { ok: true };
}

// ---- symlinkEscapeGuard -------------------------------------------------------
// Fail-closed: rejects if the worktree path is a symlink/reparse point or its
// realpath escapes worktreesRoot.
export function symlinkEscapeGuard({ worktree, worktreesRoot, exec = execFileSync }) {
  const rootReal = realPathOrNull(worktreesRoot);
  const wtReal = realPathOrNull(worktree);
  if (!rootReal) return { ok: false, errors: [{ reason: 'ROOT_UNRESOLVABLE' }] };
  if (!wtReal) return { ok: false, errors: [{ reason: 'WORKTREE_UNRESOLVABLE' }] };
  if (isReparsePoint(worktree)) {
    return { ok: false, errors: [{ reason: 'WORKTREE_SYMLINK', detail: 'Worktree path is a symlink or reparse point.' }] };
  }
  if (!isInside(rootReal, wtReal)) {
    return { ok: false, errors: [{ reason: 'WORKTREE_ESCAPES_ROOT', detail: 'Worktree realpath escapes worktreesRoot.' }] };
  }
  return { ok: true };
}

// ---- buildEvidence ------------------------------------------------------------
export function buildEvidence({ binding, worktree, exec = execFileSync }) {
  const h = identityHash({ repo: binding.repo, issueNumber: binding.issueNumber });
  let headSha = null;
  let branchName = null;
  try { headSha = readLocalHead({ cwd: worktree, exec }); } catch {}
  try { const info = readBranchInfo({ cwd: worktree, exec }); branchName = info.branchName; } catch {}
  const configDigest = crypto.createHash('sha256').update(JSON.stringify({
    adapter: 'runtime-sandbox', adapterVersion: SANDBOX_SCHEMA_VERSION, capabilities: ALLOWED_OPERATIONS,
  })).digest('hex');
  return {
    schemaVersion: SANDBOX_SCHEMA_VERSION,
    adapter: 'runtime-sandbox', adapterVersion: SANDBOX_SCHEMA_VERSION,
    runtime: { node: process.version, platform: process.platform },
    configDigest,
    binding: {
      repo: binding.repo, issueNumber: binding.issueNumber,
      baseSha: binding.baseSha, identityHash: h,
      branch: worktreeBranchFor({ identityHash: h }),
    },
    worktree: { headSha, branchName },
    allowedCapabilities: ALLOWED_OPERATIONS,
  };
}

// ---- taskStart ----------------------------------------------------------------
// Top-level task admission. Provisions the worktree, runs fail-closed guards,
// creates the broker, generates evidence, and returns launch config.
export function taskStart({
  repo, issueNumber, baseSha,
  worktreesRoot = defaultWorktreesRoot(),
  controlCwd = process.cwd(),
  exec = execFileSync, spawn = undefined,
  testRegistry = {},
} = {}) {
  if (typeof repo !== 'string' || !repo) return { ok: false, reason: 'MISSING_REPO' };
  if (typeof issueNumber !== 'number' || !Number.isInteger(issueNumber) || issueNumber <= 0) return { ok: false, reason: 'MISSING_ISSUE_NUMBER' };
  if (typeof baseSha !== 'string' || !SHA40_RE.test(baseSha)) return { ok: false, reason: 'INVALID_BASE_SHA' };
  if (typeof worktreesRoot !== 'string' || !worktreesRoot) return { ok: false, reason: 'MISSING_WORKTREES_ROOT' };

  const root = path.resolve(worktreesRoot);
  const h = identityHash({ repo, issueNumber });
  if (!h) return { ok: false, reason: 'IDENTITY_UNSTABLE' };
  const p = provision({ worktreesRoot: root, repo, issueNumber, baseSha, cwd: controlCwd, exec });
  if (!p.ok) return { ok: false, ...p, detail: p.detail || 'provision failed' };

  const wtPath = p.path;
  const mg = mainCheckoutGuard({ worktree: wtPath, controlCwd, exec });
  if (!mg.ok) return { ok: false, reason: 'FORBIDDEN_CANONICAL_CHECKOUT', guard: mg.errors };
  const sg = symlinkEscapeGuard({ worktree: wtPath, worktreesRoot: root, exec });
  if (!sg.ok) return { ok: false, reason: 'WORKSPACE_ADMISSION_REJECTED', guard: sg.errors };

  const evidence = buildEvidence({ binding: p.binding, worktree: wtPath, exec });
  const broker = createExecutionBroker({ worktreesRoot: root, controlCwd, testRegistry, exec, spawn });

  const mcpEntrypoint = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-server.mjs');
  const mcpCommand = process.execPath;
  const mcpArgs = [mcpEntrypoint];
  const mcpEnv = buildMinimalEnv();
  mcpEnv.SOC_WORKTREES_ROOT = root;
  mcpEnv.SOC_REPO = normalizeRemoteUrl(repo);
  mcpEnv.SOC_ISSUE = String(issueNumber);
  mcpEnv.SOC_BASE_SHA = baseSha;
  mcpEnv.SOC_TEST_REGISTRY = JSON.stringify(testRegistry);

  const openCodeConfig = buildOpenCodeConfig({ mcpCommand, mcpArgs, mcpEnv });
  const ocw = writeOpenCodeConfig({ worktreePath: wtPath, config: openCodeConfig });
  if (!ocw.ok) return { ok: false, reason: 'OPENCODE_CONFIG_WRITE_FAILED', detail: ocw };
  const ocDigest = readOpenCodeConfigDigest({ worktreePath: wtPath });
  evidence.opencode = ocDigest.ok ? { digest: ocDigest.digest, bytes: ocDigest.bytes, file: ocw.path } : { error: ocDigest };

  return {
    ok: true, evidence, broker, mcpCommand, mcpArgs, mcpEnv,
    openCodeConfig, openCodeConfigPath: ocw.path,
    binding: { repo, issueNumber, baseSha, identityHash: h, path: wtPath, branch: p.branch, head: p.head },
  };
}

function buildMinimalEnv() {
  const allowlist = new Set([
    'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'TEMP', 'TMP',
    'USERPROFILE', 'HOME', 'OS', 'ComSpec', 'PROCESSOR_ARCHITECTURE',
  ]);
  const env = {};
  for (const k of allowlist) { if (process.env[k] !== undefined) env[k] = process.env[k]; }
  return env;
}