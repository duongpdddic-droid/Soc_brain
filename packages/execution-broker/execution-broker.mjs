#!/usr/bin/env node
// execution-broker.mjs — Soc_brain: read-only Execution Broker v1 (Issue #15).
//
// Source pin (indirect): the broker has no direct AI_PR_REVIEWER source file;
// it reuses packages/workspace::verifyBinding (Issue #13), which itself is
// pinned to duongpdddic-droid/AI_PR_REVIEWER @ 9c104c88
// (scripts/github-task-intake.mjs + scripts/temp-hygiene.mjs).
//
// Boundary contract (v1):
//   - Single auditable dispatch: executeBrokerRequest().
//   - Only `status`, `diff`, `run_registered_test` are dispatchable.
//   - Every operation verifies the task binding via verifyBinding IMMEDIATELY
//     before reading/executing; the verified binding path is the ONLY
//     execution root. A caller-supplied path/cwd is never trusted (request
//     schema has no path/cwd fields at all).
//   - No shell is ever invoked: git ops use fixed argv via execFileSync-style
//     exec; registered tests use spawnSync (shell:false) with fixed
//     executable/argv from the registry only.
//   - Registry entries carry fixed executable + fixed argv; the request only
//     supplies a testId. Command text, flags, cwd, env overrides,
//     redirections, pipes, separators, shell syntax are structurally
//     impossible or rejected before execution.
//   - Timeout, independent stdout/stderr caps, truncation flags, and
//     secret/HOME redaction are enforced deterministically.
//   - Results are JSON-compatible plain objects; broker never throws and
//     never mutates Git state or task files.

import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { verifyBinding, SHA40_RE } from '../workspace/workspace.mjs';
import { normalizeRemoteUrl } from '../safe-git/safe-git.mjs';

export const BROKER_SCHEMA_VERSION = '1';
export const BROKER_OPERATIONS = ['status', 'diff', 'run_registered_test'];
export const DIFF_MODES = ['working_tree', 'staged'];
export const STATUS_MAX_BYTES = 64 * 1024;
export const DIFF_MAX_BYTES = 256 * 1024;
export const DEFAULT_TEST_TIMEOUT_MS = 10000;
export const MAX_TEST_TIMEOUT_MS = 120000;
export const DEFAULT_TEST_MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_TEST_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

// ---- fail-closed helpers ---------------------------------------------------

const SHA40_LC = SHA40_RE; // ^[0-9a-f]{40}$ from workspace
const OWNER_REPO_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const SAFE_TEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/; // slug only: no '/', no whitespace, no shell meta
const SHELL_INTERPRETER_RE = /^(sh|bash|dash|ksh|zsh|csh|tcsh|fish|cmd|cmd\.exe|powershell|pwsh|powershell\.exe|pwsh\.exe)$/;
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const SHELL_META_RE = /[&|;<>`$()\n\r]/;
const SECRET_KEY_RE = /(token|secret|passwd|password|api[_-]?key|authorization|credential|private[_-]?key)/i;

const REQUEST_KEYS = ['schemaVersion', 'operation', 'repo', 'issueNumber', 'baseSha', 'args'];
const REGISTRY_ENTRY_KEYS = ['executable', 'argv', 'timeoutMs', 'disabled', 'env', 'maxOutputBytes'];
const MINIMAL_ENV_ALLOWLIST = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'TEMP', 'TMP',
  'USERPROFILE', 'HOME', 'OS', 'ComSpec', 'PROCESSOR_ARCHITECTURE',
];

// ---- redaction (recursive, deterministic) ----------------------------------
// Replaces HOME-path fragments, secret-shaped tokens, and bearer headers.
// Applied to every string that can reach the result surface.

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactString(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  const home = os.homedir();
  if (home && home.length > 2) {
    out = out.replace(new RegExp(escapeRegExp(home), 'gi'), '<HOME>');
  }
  out = out.replace(/gh[pous]_[A-Za-z0-9_]{20,}/g, '<SECRET>');
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, 'Bearer <SECRET>');
  out = out.replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '<PRIVATE_KEY>');
  return out;
}

function redactValue(v) {
  if (v == null) return v;
  if (typeof v === 'string') return redactString(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = redactValue(val);
    return out;
  }
  return v;
}
// ---- request validation (fail-closed) --------------------------------------

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { ok: false, reason: 'INVALID_REQUEST', detail: 'request must be a plain object.' };
  }
  const keys = Object.keys(request);
  const unknown = keys.filter((k) => !REQUEST_KEYS.includes(k));
  if (unknown.length) {
    return { ok: false, reason: 'INVALID_REQUEST_FIELD', fields: unknown, detail: `Unknown request fields: ${unknown.join(', ')}` };
  }
  const missing = REQUEST_KEYS.filter((k) => request[k] === undefined || request[k] === null || request[k] === '');
  if (missing.length) {
    return { ok: false, reason: 'REQUEST_MISSING_FIELD', fields: missing, detail: `Missing request fields: ${missing.join(', ')}` };
  }
  if (request.schemaVersion !== BROKER_SCHEMA_VERSION) {
    return { ok: false, reason: 'SCHEMA_VERSION_UNSUPPORTED', schemaVersion: request.schemaVersion };
  }
  const operation = String(request.operation);
  if (!BROKER_OPERATIONS.includes(operation)) {
    return { ok: false, reason: 'UNKNOWN_OPERATION', operation: request.operation };
  }
  const repo = normalizeRemoteUrl(request.repo);
  if (!repo || !OWNER_REPO_RE.test(repo)) return { ok: false, reason: 'INVALID_REPO', repo: request.repo };
  const issueNumber = Number(request.issueNumber);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return { ok: false, reason: 'INVALID_ISSUE_NUMBER', issueNumber: request.issueNumber };
  }
  const baseSha = String(request.baseSha).toLowerCase();
  if (!SHA40_LC.test(baseSha)) return { ok: false, reason: 'INVALID_BASE_SHA', baseSha: request.baseSha };

  const args = request.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, reason: 'INVALID_ARGS', detail: 'args must be a plain object.' };
  }
  const argKeys = Object.keys(args);
  let testId;
  let diffMode;
  if (operation === 'status') {
    if (argKeys.length) return { ok: false, reason: 'INVALID_ARGS', fields: argKeys, detail: `status accepts no args; got: ${argKeys.join(', ')}` };
  } else if (operation === 'diff') {
    const extra = argKeys.filter((k) => k !== 'mode');
    if (extra.length) return { ok: false, reason: 'INVALID_ARGS', fields: extra, detail: `diff accepts only 'mode'; got: ${extra.join(', ')}` };
    if (!DIFF_MODES.includes(args.mode)) return { ok: false, reason: 'INVALID_DIFF_MODE', mode: args.mode };
    diffMode = args.mode;
  } else if (operation === 'run_registered_test') {
    const extra = argKeys.filter((k) => k !== 'testId');
    if (extra.length) return { ok: false, reason: 'INVALID_ARGS', fields: extra, detail: `run_registered_test accepts only 'testId'; got: ${extra.join(', ')}` };
    testId = args.testId;
    if (typeof testId !== 'string' || !SAFE_TEST_ID_RE.test(testId)) {
      return { ok: false, reason: 'INVALID_TEST_ID', testId: args.testId, detail: 'testId must be a plain slug (no path, whitespace, or shell metacharacters).' };
    }
  }

  return { ok: true, normalized: { repo, issueNumber, baseSha, operation, testId, diffMode } };
}
// ---- registry entry validation (fail-closed) --------------------------------

function validateRegistryEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, reason: 'MALFORMED_REGISTRY_ENTRY', detail: 'registry entry must be a plain object.' };
  }
  const unknown = Object.keys(entry).filter((k) => !REGISTRY_ENTRY_KEYS.includes(k));
  if (unknown.length) {
    return { ok: false, reason: 'MALFORMED_REGISTRY_ENTRY', fields: unknown, detail: `Unknown registry entry fields: ${unknown.join(', ')}` };
  }
  if (entry.disabled === true) {
    return { ok: false, reason: 'REGISTRY_ENTRY_DISABLED', detail: 'Registered test is disabled.' };
  }
  const executable = entry.executable;
  if (typeof executable !== 'string' || !executable) return { ok: false, reason: 'MALFORMED_REGISTRY_ENTRY', field: 'executable' };
  if (/\s/.test(executable) || CONTROL_RE.test(executable) || SHELL_META_RE.test(executable) || executable.startsWith('-')) {
    return { ok: false, reason: 'MALFORMED_REGISTRY_ENTRY', field: 'executable', detail: 'executable must be a single token without whitespace/control/shell-metacharacters and must not start with "-".' };
  }
  if (SHELL_INTERPRETER_RE.test(path.basename(executable).toLowerCase())) {
    return { ok: false, reason: 'FORBIDDEN_EXECUTABLE', executable, detail: 'Shell interpreters are not allowed as registered test executables.' };
  }
  if (!Array.isArray(entry.argv)) return { ok: false, reason: 'MALFORMED_REGISTRY_ENTRY', field: 'argv', detail: 'argv must be an array.' };
  for (const a of entry.argv) {
    if (typeof a !== 'string') return { ok: false, reason: 'MALFORMED_REGISTRY_ENTRY', field: 'argv', detail: 'argv entries must be strings.' };
    if (CONTROL_RE.test(a) || a.length > 1024) return { ok: false, reason: 'MALFORMED_REGISTRY_ENTRY', field: 'argv', detail: 'argv entry has control characters or is too long.' };
  }
  const timeoutMs = entry.timeoutMs === undefined ? DEFAULT_TEST_TIMEOUT_MS : entry.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TEST_TIMEOUT_MS) {
    return { ok: false, reason: 'MALFORMED_REGISTRY_ENTRY', field: 'timeoutMs', detail: 'timeoutMs must be an integer in [1, 120000].' };
  }
  const maxOutputBytes = entry.maxOutputBytes === undefined ? DEFAULT_TEST_MAX_OUTPUT_BYTES : entry.maxOutputBytes;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > MAX_TEST_MAX_OUTPUT_BYTES) {
    return { ok: false, reason: 'MALFORMED_REGISTRY_ENTRY', field: 'maxOutputBytes', detail: 'maxOutputBytes must be an integer in [1024, 4194304].' };
  }
  let env;
  if (entry.env !== undefined) {
    if (typeof entry.env !== 'object' || Array.isArray(entry.env)) {
      return { ok: false, reason: 'MALFORMED_REGISTRY_ENTRY', field: 'env', detail: 'env must be a plain object.' };
    }
    env = {};
    for (const [k, val] of Object.entries(entry.env)) {
      if (typeof k !== 'string' || !k || CONTROL_RE.test(k)) return { ok: false, reason: 'MALFORMED_REGISTRY_ENTRY', field: 'env' };
      if (SECRET_KEY_RE.test(k)) return { ok: false, reason: 'FORBIDDEN_ENV_KEY', key: k, detail: 'Registry env must not carry secret-looking keys.' };
      if (typeof val !== 'string') return { ok: false, reason: 'MALFORMED_REGISTRY_ENTRY', field: 'env', detail: 'env values must be strings.' };
      env[k] = val;
    }
  }
  return {
    ok: true,
    entry: { executable, argv: entry.argv.slice(), timeoutMs, maxOutputBytes, env },
  };
}
// ---- bounded git read -------------------------------------------------------

// Runs a fixed-argv git command in `cwd` with an output cap. Never a shell.
// execFileSync-style exec throws on non-zero exit or maxBuffer overflow; both
// are normalized into a structured result.
function runGit(args, cwd, exec, maxBytes) {
  let raw;
  let truncated = false;
  try {
    raw = exec('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: maxBytes + 1,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (e) {
    const out = String((e && e.stdout) || '');
    if ((e && e.code) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      raw = out;
      truncated = true;
    } else {
      const detail = String((e && e.stderr) || (e && e.message) || e);
      return { ok: false, reason: 'GIT_READ_FAILED', detail };
    }
  }
  let text = String(raw == null ? '' : raw).replace(/\r\n/g, '\n');
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    text = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
    truncated = true;
  }
  return { ok: true, text, truncated };
}

// ---- operations --------------------------------------------------------------

function opStatus({ worktree, exec }) {
  const r = runGit(['status', '--porcelain=v1'], worktree, exec, STATUS_MAX_BYTES);
  if (!r.ok) return r;
  const entries = r.text
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter(Boolean)
    .map((l) => ({ code: l.slice(0, 2), path: l.slice(3) }));
  return {
    ok: true,
    operation: 'status',
    data: { entries, truncated: r.truncated, outputBytes: Buffer.byteLength(r.text, 'utf8') },
    evidence: { redactionApplied: true },
  };
}

function opDiff({ worktree, mode, exec }) {
  // Enum → fixed argv. No caller-controlled revision expressions or paths.
  const args = mode === 'staged'
    ? ['diff', '--cached', '--no-color', '--']
    : ['diff', '--no-color', '--'];
  const r = runGit(args, worktree, exec, DIFF_MAX_BYTES);
  if (!r.ok) return r;
  return {
    ok: true,
    operation: 'diff',
    mode,
    data: { output: r.text, truncated: r.truncated, outputBytes: Buffer.byteLength(r.text, 'utf8') },
    evidence: { redactionApplied: true },
  };
}

// Minimal trusted env: an allowlisted subset of the broker's own environment
// (never the full caller env) plus the registry's validated fixed env map.
function buildMinimalEnv(registryEnv) {
  const env = {};
  for (const key of MINIMAL_ENV_ALLOWLIST) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) env[key] = process.env[key];
  }
  if (registryEnv) {
    for (const [k, val] of Object.entries(registryEnv)) env[k] = val;
  }
  return env;
}

function snapshotWorktree(worktree, exec) {
  let head = null;
  let status = null;
  try {
    head = String(exec('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
  } catch { head = '<unreadable>'; }
  try {
    status = String(exec('git', ['status', '--porcelain=v1'], { cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
  } catch { status = '<unreadable>'; }
  return { head, status };
}
function opRunTest({ worktree, testId, testRegistry, spawn, exec }) {
  if (!testRegistry || typeof testRegistry !== 'object' || Array.isArray(testRegistry)) {
    return { ok: false, reason: 'TEST_REGISTRY_MISSING', detail: 'testRegistry must be a plain object.' };
  }
  let rawEntry;
  try { rawEntry = testRegistry[testId]; } catch (e) {
    return { ok: false, reason: 'MALFORMED_REGISTRY_ENTRY', detail: String((e && e.message) || e) };
  }
  if (rawEntry === undefined || rawEntry === null) {
    return { ok: false, reason: 'UNKNOWN_TEST_ID', testId, detail: `No registered test named '${testId}'.` };
  }
  const ve = validateRegistryEntry(rawEntry);
  if (!ve.ok) return { ...ve, testId };
  const entry = ve.entry;

  const before = snapshotWorktree(worktree, exec);
  const started = Date.now();
  let res;
  // Use a generous safety maxBuffer so both streams are captured fully for
  // typical output; post-hoc per-stream caps provide independent truncation.
  const safetyMaxBuffer = Math.max(entry.maxOutputBytes, 4 * 1024 * 1024);
  try {
    res = spawn(entry.executable, entry.argv, {
      cwd: worktree,
      env: buildMinimalEnv(entry.env),
      encoding: 'utf8',
      shell: false,
      timeout: entry.timeoutMs,
      maxBuffer: safetyMaxBuffer,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return { ok: false, reason: 'TEST_EXEC_ERROR', testId, detail: redactString(String((e && e.message) || e)) };
  }
  const elapsedMs = Date.now() - started;
  const after = snapshotWorktree(worktree, exec);

  const stdoutRaw = String(res.stdout == null ? '' : res.stdout);
  const stderrRaw = String(res.stderr == null ? '' : res.stderr);
  const stdoutBytes = Buffer.byteLength(stdoutRaw, 'utf8');
  const stderrBytes = Buffer.byteLength(stderrRaw, 'utf8');
  const stdoutTruncated = stdoutBytes > entry.maxOutputBytes;
  const stderrTruncated = stderrBytes > entry.maxOutputBytes;
  const stdout = stdoutTruncated ? Buffer.from(stdoutRaw, 'utf8').subarray(0, entry.maxOutputBytes).toString('utf8') : stdoutRaw;
  const stderr = stderrTruncated ? Buffer.from(stderrRaw, 'utf8').subarray(0, entry.maxOutputBytes).toString('utf8') : stderrRaw;

  const maxBufferError = !!(res.error && (res.error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || res.error.code === 'ENOBUFS'));
  const timedOut = res.status === null && (res.signal !== null || !!(res.error && res.error.code === 'ETIMEDOUT'));
  const spawnFailed = !!(res.error && res.error.code && !['ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'ENOBUFS', 'ETIMEDOUT'].includes(res.error.code));

  const exitCode = Number.isInteger(res.status) ? res.status : null;
  const worktreeUnchanged = before.head === after.head && before.status === after.status;

  const base = {
    operation: 'run_registered_test',
    testId,
    data: {
      exitCode,
      timedOut,
      spawnFailed,
      stdout: redactString(stdout),
      stderr: redactString(stderr),
      truncated: { stdout: stdoutTruncated, stderr: stderrTruncated },
      outputBytes: { stdout: stdoutBytes, stderr: stderrBytes },
      elapsedMs,
    },
    evidence: {
      redactionApplied: true,
      worktreeUnchanged,
      cwd: worktree,
      executable: entry.executable,
      argv: entry.argv.slice(),
      argvSource: 'registry',
      envKeys: Object.keys(buildMinimalEnv(entry.env)).sort(),
    },
  };

  if (spawnFailed) return { ok: false, reason: 'TEST_EXEC_ERROR', ...base, detail: redactString(String((res.error && res.error.code) || 'spawn error')) };
  if (maxBufferError || stdoutTruncated || stderrTruncated) return { ok: false, reason: 'TEST_OUTPUT_OVERFLOW', ...base, detail: 'Registered test exceeded the configured output cap; truncated evidence returned.' };
  if (timedOut) return { ok: false, reason: 'TEST_TIMEOUT', ...base, detail: `Registered test exceeded timeout (${entry.timeoutMs} ms); child terminated.` };
  if (exitCode !== 0) return { ok: false, reason: 'TEST_NONZERO_EXIT', ...base, detail: `Registered test exited with code ${exitCode}.` };
  if (!worktreeUnchanged) return { ok: false, reason: 'TEST_MUTATED_WORKTREE', ...base, detail: 'Registered test changed the worktree HEAD or working-tree state; broker is read-only.' };
  return { ok: true, ...base };
}

// ---- single auditable dispatch boundary -------------------------------------

export function executeBrokerRequest(opts = {}, second = {}) {
  const { request, worktreesRoot, controlCwd, testRegistry, exec = execFileSync, spawn = spawnSync } = { ...opts, ...second };
  try {
    const v = validateRequest(request);
    if (!v.ok) return { ok: false, ...v, operation: (request && request.operation) || null };

    const n = v.normalized;
    // Every operation verifies the binding IMMEDIATELY before reading/executing.
    const binding = verifyBinding({
      worktreesRoot,
      repo: n.repo,
      issueNumber: n.issueNumber,
      baseSha: n.baseSha,
      cwd: controlCwd,
      exec,
    });
    if (!binding.ok) {
      return {
        ok: false,
        reason: 'BINDING_VERIFY_FAILED',
        bindingReason: binding.reason,
        operation: n.operation,
        detail: redactString(String(binding.detail || binding.reason)),
      };
    }

    const worktree = binding.path; // verified binding path is the ONLY execution root.

    if (n.operation === 'status') return redactValue(opStatus({ worktree, exec }));
    if (n.operation === 'diff') return redactValue(opDiff({ worktree, mode: n.diffMode, exec }));
    return redactValue(opRunTest({ worktree, testId: n.testId, testRegistry, spawn, exec }));
  } catch (e) {
    return {
      ok: false,
      reason: 'BROKER_INTERNAL_ERROR',
      detail: redactString(String((e && e.message) || e)),
    };
  }
}
