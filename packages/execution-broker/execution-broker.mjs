#!/usr/bin/env node
// execution-broker.mjs — Soc_brain: read-only Execution Broker v1 (Issue #15).
//
// Source pin (indirect): the broker has no direct AI_PR_REVIEWER source file;
// it reuses packages/workspace::verifyBinding (Issue #13), which itself is
// pinned to duongpdddic-droid/AI_PR_REVIEWER @ 9c104c88
// (scripts/github-task-intake.mjs + scripts/temp-hygiene.mjs).
//
// Boundary contract (v1):
//   - Single auditable dispatch: createExecutionBroker({ worktreesRoot,
//     controlCwd, testRegistry, exec, spawn }) returns
//     { executeBrokerRequest(request) } with the registry and execution
//     primitives bound in a factory closure. The untrusted request object can
//     NEVER supply or override the registry, executable, argv, cwd, env, or
//     spawn path — those live only in the trusted control-plane boundary. The
//     ONE deliberate, tightly-gated exception is `run_safe_command`: the
//     request supplies `executable` + a structured `argv` (never cwd/env/a
//     shell string), and the broker re-authorizes it deterministically via the
//     permission-orchestration `classifySafeCommand` (Node allowlist, no eval
//     flags, no shell meta, repo-relative argv[0] resolved inside the bound
//     worktree) before executing EXACTLY ONCE in the isolated snapshot.
//   - Only `status`, `diff`, `run_registered_test`, `run_safe_command` are
//     dispatchable.
//   - Every operation verifies the task binding via verifyBinding IMMEDIATELY
//     before reading/executing; the verified binding path is the ONLY
//     execution root. A caller-supplied path/cwd is never trusted (request
//     schema has no path/cwd fields at all).
//   - No shell is ever invoked: git ops use fixed argv via execFileSync-style
//     exec; registered tests use spawnSync (shell:false) with fixed
//     executable/argv from the registry only.
//   - Registry entries are allowlisted: executable must be `node`; argv must
//     NOT carry eval/code flags (`-e`, `--eval`, `-p`, `--print`, ...) or any
//     arbitrary executable path; shell interpreters and Git mutators are
//     structurally impossible (git is not an allowed executable).
//   - Registered tests execute in a disposable isolated snapshot worktree
//     (git worktree add --detach) that is destroyed afterward; the verified
//     task worktree is preserved byte-for-byte. A mutating test touches only
//     the snapshot, never the bound worktree.
//   - Timeout, independent stdout/stderr caps, truncation flags, and
//     secret/HOME redaction are enforced deterministically.
//   - Results are JSON-compatible plain objects; broker never throws and
//     never mutates Git state or task files.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { verifyBinding, SHA40_RE } from '../workspace/workspace.mjs';
import { normalizeRemoteUrl } from '../safe-git/safe-git.mjs';
import { classifySafeCommand, OP_OUTCOME } from '../permission-orchestration/permission-orchestration.mjs';

export const BROKER_SCHEMA_VERSION = '1';
export const BROKER_OPERATIONS = ['status', 'diff', 'run_registered_test', 'run_safe_command'];
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
// Registered-test executables are allowlisted. Only the Node runtime is
// permitted; shell interpreters, git, python, arbitrary paths are all rejected
// as FORBIDDEN_EXECUTABLE. This makes `git reset --hard` and shell/eval
// injection structurally impossible.
const ALLOWED_EXECUTABLES = new Set(['node', 'node.exe']);
// Eval/code flags for the Node runtime — executing a code string or an
// interactive REPL is exactly the arbitrary-execution path the registry must
// never carry. Rejected at registry validation.
const NODE_EVAL_FLAG_RE = /^(-e|--eval|-p|--print|-pe|-i|--interactive)(=.*)?$/;
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const SHELL_META_RE = /[&|;<>`$()\n\r]/;
const SECRET_KEY_RE = /(token|secret|passwd|password|api[_-]?key|authorization|credential|private[_-]?key)/i;

const REQUEST_KEYS = ['schemaVersion', 'operation', 'repo', 'issueNumber', 'baseSha', 'args'];
const REGISTRY_ENTRY_KEYS = ['executable', 'argv', 'timeoutMs', 'disabled', 'env', 'maxOutputBytes'];
const MINIMAL_ENV_ALLOWLIST = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'TEMP', 'TMP',
  'USERPROFILE', 'HOME', 'OS', 'ComSpec', 'PROCESSOR_ARCHITECTURE',
];
// ---- script path validation (GPT-REV-127) ---------------------------------
// A registered-test script path (argv[0]) must be a repo-relative safe path
// that stays inside the snapshot root. Absolute paths (Windows drive-letter
// / POSIX), traversal, drive letters, UNC paths, URLs, stdin, and option
// tokens are all rejected fail-closed as FORBIDDEN_SCRIPT_PATH.

function validateScriptPath(script) {
  if (typeof script !== 'string' || !script) {
    return { ok: false, reason: 'FORBIDDEN_SCRIPT_PATH', detail: 'Registered-test script path (argv[0]) must be a non-empty string.' };
  }
  if (script.startsWith('-')) {
    return { ok: false, reason: 'FORBIDDEN_SCRIPT_PATH', detail: 'Registered-test script path must not be an option or stdin ("-").' };
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(script)) {
    return { ok: false, reason: 'FORBIDDEN_SCRIPT_PATH', detail: 'Registered-test script path must not be a URL (e.g. file://).' };
  }
  if (/^[a-zA-Z]:/.test(script)) {
    return { ok: false, reason: 'FORBIDDEN_SCRIPT_PATH', detail: 'Registered-test script path must not carry a drive letter.' };
  }
  if (script.includes('\\')) {
    return { ok: false, reason: 'FORBIDDEN_SCRIPT_PATH', detail: 'Registered-test script path must use forward slashes only.' };
  }
  if (script.startsWith('/')) {
    return { ok: false, reason: 'FORBIDDEN_SCRIPT_PATH', detail: 'Registered-test script path must be repo-relative (no leading slash).' };
  }
  if (script.split('/').includes('..')) {
    return { ok: false, reason: 'FORBIDDEN_SCRIPT_PATH', detail: 'Registered-test script path must not contain traversal ("..").' };
  }
  return { ok: true };
}

// ---- deep-copy / deep-freeze helpers (GPT-REV-127) ------------------------

function deepCopy(value) {
  if (Array.isArray(value)) return value.map(deepCopy);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = deepCopy(value[k]);
    return out;
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

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
  let executable;
  let argv;
  let timeoutMs;
  let maxOutputBytes;
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
  } else if (operation === 'run_safe_command') {
    // SOLE caller-argv op, gated by classifySafeCommand before execution. The
    // request may carry executable + a structured argv (and optional bounds);
    // it may NEVER carry cwd/env/eval/script-path escapes — those are vetted in
    // classifySafeCommand / validateRegistryEntry (fail-closed).
    const extra = argKeys.filter((k) => !['executable', 'argv', 'timeoutMs', 'maxOutputBytes'].includes(k));
    if (extra.length) return { ok: false, reason: 'INVALID_ARGS', fields: extra, detail: `run_safe_command accepts only 'executable','argv','timeoutMs','maxOutputBytes'; got: ${extra.join(', ')}` };
    executable = args.executable;
    argv = args.argv;
    timeoutMs = args.timeoutMs;
    maxOutputBytes = args.maxOutputBytes;
    if (typeof executable !== 'string' || !executable) return { ok: false, reason: 'INVALID_ARGS', field: 'executable', detail: 'run_safe_command requires a non-empty executable token.' };
    if (!Array.isArray(argv) || argv.length === 0) return { ok: false, reason: 'INVALID_ARGS', field: 'argv', detail: 'run_safe_command requires a non-empty argv array.' };
  }

  return { ok: true, normalized: { repo, issueNumber, baseSha, operation, testId, diffMode, executable, argv, timeoutMs, maxOutputBytes } };
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
  // Strict allowlist: only the Node runtime may be a registered-test
  // executable. Any other token (shell interpreter, git, python, an absolute
  // or relative path, a mutator) is FORBIDDEN_EXECUTABLE. This makes
  // `git reset --hard` and arbitrary executable paths structurally impossible.
  if (!ALLOWED_EXECUTABLES.has(executable)) {
    return { ok: false, reason: 'FORBIDDEN_EXECUTABLE', executable, detail: `Registered-test executables are allowlisted to the Node runtime; got: ${executable}.` };
  }
  if (!Array.isArray(entry.argv)) return { ok: false, reason: 'MALFORMED_REGISTRY_ENTRY', field: 'argv', detail: 'argv must be an array.' };
  for (const a of entry.argv) {
    if (typeof a !== 'string') return { ok: false, reason: 'MALFORMED_REGISTRY_ENTRY', field: 'argv', detail: 'argv entries must be strings.' };
    if (CONTROL_RE.test(a) || a.length > 1024) return { ok: false, reason: 'MALFORMED_REGISTRY_ENTRY', field: 'argv', detail: 'argv entry has control characters or is too long.' };
    if (NODE_EVAL_FLAG_RE.test(a)) {
      return { ok: false, reason: 'FORBIDDEN_EVAL_FLAG', flag: a, detail: 'Registered-test argv must not carry eval/code flags (e.g. node -e/--eval, -p/--print).' };
    }
  }
  // argv[0] is the Node script path: it must be a repo-relative safe path that
  // stays inside the snapshot root (GPT-REV-127). The eval-flag check above
  // runs first so `-e`/`-p`/`-i` keep their FORBIDDEN_EVAL_FLAG precedence.
  {
    const sp = validateScriptPath(entry.argv[0]);
    if (!sp.ok) return sp;
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

// ---- snapshot isolation for registered tests --------------------------------
// Registered tests must NEVER touch the verified task worktree. Each run creates
// a disposable detached snapshot worktree at the same HEAD, executes the child
// there, and destroys the snapshot afterward. Any mutation a test performs lands
// in the disposable snapshot and is thrown away; the bound worktree is preserved
// byte-for-byte. We do NOT attempt to clean up an untrusted mutation in the
// bound worktree (GPT-REV-126) — it is never written to in the first place.

// Byte/content-level fingerprint of a directory tree (excluding .git): a
// deterministic hash over every path + content hash. Unlike HEAD+porcelain
// comparisons it catches any content change, including changes to an
// already-modified tracked file, an existing untracked file, or ignored paths.
function treeFingerprint(root) {
  const acc = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (ent.name === '.git' || ent.name === '.git.lock') continue;
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full);
      if (ent.isDirectory()) { walk(full); continue; }
      let contentHash = '<unreadable>';
      try { contentHash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'); } catch (e) { /* keep marker */ }
      acc.push(`${rel}\u0000${contentHash}`);
    }
  };
  walk(root);
  acc.sort();
  return crypto.createHash('sha256').update(acc.join('\n')).digest('hex');
}

// Fixed-argv git helper that never uses a shell; normalized failure result.
function runGitBare(args, cwd, exec) {
  try {
    exec('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: String((e && e.stderr) || (e && e.message) || e) };
  }
}

// Create a disposable detached snapshot worktree at the same HEAD as `worktree`,
// run in the trusted control-plane cwd (the main checkout). Returns the snapshot
// path, or a { ok:false } result.
function createSnapshotWorktree({ worktree, controlCwd, exec }) {
  let snap;
  try { snap = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-eb-snap-')); } catch (e) {
    return { ok: false, reason: 'SNAPSHOT_CREATE_FAILED', detail: String((e && e.message) || e) };
  }
  const r = runGitBare(['worktree', 'add', '--detach', snap, 'HEAD'], controlCwd, exec);
  if (!r.ok) {
    try { fs.rmSync(snap, { recursive: true, force: true }); } catch { /* best-effort */ }
    return { ok: false, reason: 'SNAPSHOT_CREATE_FAILED', detail: r.detail };
  }
  // Worktree dir may contain a bare ".git" file; we must not copy it into the
  // snapshot (it would point back at the main repo). Copy the rest of the
  // content (pre-dirty tracked/untracked/ignored files included) so the child
  // sees the same bytes the user sees.
  try {
    for (const ent of fs.readdirSync(worktree, { withFileTypes: true })) {
      if (ent.name === '.git' || ent.name === '.git.lock') continue;
      fs.cpSync(path.join(worktree, ent.name), path.join(snap, ent.name), { recursive: true, force: true });
    }
  } catch (e) {
    destroySnapshot({ snap, controlCwd, exec });
    return { ok: false, reason: 'SNAPSHOT_COPY_FAILED', detail: String((e && e.message) || e) };
  }
  return { ok: true, snap };
}

function destroySnapshot({ snap, controlCwd, exec }) {
  try { runGitBare(['worktree', 'remove', '--force', snap], controlCwd, exec); } catch { /* best-effort */ }
  try { fs.rmSync(snap, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// Shared disposable-snapshot runner. `command` is a validated
// { executable, argv, timeoutMs, maxOutputBytes, env }. It fingerprints the
// ORIGINAL bound worktree before and after, runs the child EXACTLY ONCE in the
// snapshot (shell:false, minimal env, bounded output), destroys the snapshot,
// proves worktree invariance, and returns a structured { data, evidence } with
// a `reason`/`detail` on failure. Used by BOTH opRunTest (registry) and
// opRunSafeCommand (inline safe command) — never a second command runner.
function runInSnapshot({ worktree, command, spawn, exec, controlCwd, operation, argvSource }) {
  const originalBefore = treeFingerprint(worktree);

  const snapRes = createSnapshotWorktree({ worktree, controlCwd, exec });
  if (!snapRes.ok) return { ok: false, reason: snapRes.reason, detail: snapRes.detail, data: null, evidence: null };
  const snap = snapRes.snap;

  // Containment backstop (GPT-REV-127): argv[0] must resolve inside the snapshot
  // root on top of the syntactic validation — proves no path can escape the
  // disposable snapshot the child actually runs in.
  {
    const scriptRel = command.argv[0];
    const scriptAbs = path.resolve(snap, scriptRel);
    const rel = path.relative(snap, scriptAbs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      destroySnapshot({ snap, controlCwd, exec });
      return { ok: false, reason: 'FORBIDDEN_SCRIPT_PATH', detail: 'command script path escapes the snapshot root.', data: null, evidence: null };
    }
  }

  const started = Date.now();
  let res;
  // Generous safety maxBuffer so both streams are captured fully; post-hoc
  // per-stream caps provide independent truncation.
  const safetyMaxBuffer = Math.max(command.maxOutputBytes, 4 * 1024 * 1024);
  try {
    res = spawn(command.executable, command.argv, {
      cwd: snap,
      env: buildMinimalEnv(command.env),
      encoding: 'utf8',
      shell: false,
      timeout: command.timeoutMs,
      maxBuffer: safetyMaxBuffer,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    destroySnapshot({ snap, controlCwd, exec });
    return { ok: false, reason: 'TEST_EXEC_ERROR', detail: redactString(String((e && e.message) || e)), data: null, evidence: null };
  }
  const elapsedMs = Date.now() - started;
  destroySnapshot({ snap, controlCwd, exec });

  // Prove byte/content-level invariance of the ORIGINAL bound worktree.
  const worktreeUnchanged = originalBefore === treeFingerprint(worktree);

  const stdoutRaw = String(res.stdout == null ? '' : res.stdout);
  const stderrRaw = String(res.stderr == null ? '' : res.stderr);
  const stdoutBytes = Buffer.byteLength(stdoutRaw, 'utf8');
  const stderrBytes = Buffer.byteLength(stderrRaw, 'utf8');
  const stdoutTruncated = stdoutBytes > command.maxOutputBytes;
  const stderrTruncated = stderrBytes > command.maxOutputBytes;
  const stdout = stdoutTruncated ? Buffer.from(stdoutRaw, 'utf8').subarray(0, command.maxOutputBytes).toString('utf8') : stdoutRaw;
  const stderr = stderrTruncated ? Buffer.from(stderrRaw, 'utf8').subarray(0, command.maxOutputBytes).toString('utf8') : stderrRaw;

  const maxBufferError = !!(res.error && (res.error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || res.error.code === 'ENOBUFS'));
  const timedOut = res.status === null && (res.signal !== null || !!(res.error && res.error.code === 'ETIMEDOUT'));
  const spawnFailed = !!(res.error && res.error.code && !['ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'ENOBUFS', 'ETIMEDOUT'].includes(res.error.code));

  const exitCode = Number.isInteger(res.status) ? res.status : null;

  const data = {
    exitCode,
    timedOut,
    spawnFailed,
    stdout: redactString(stdout),
    stderr: redactString(stderr),
    truncated: { stdout: stdoutTruncated, stderr: stderrTruncated },
    outputBytes: { stdout: stdoutBytes, stderr: stderrBytes },
    elapsedMs,
  };
  const evidence = {
    redactionApplied: true,
    isolated: true,
    worktreeUnchanged,
    cwd: worktree,
    executable: command.executable,
    argv: command.argv.slice(),
    argvSource,
    envKeys: Object.keys(buildMinimalEnv(command.env)).sort(),
  };

  if (!worktreeUnchanged) return { ok: false, reason: 'TEST_MUTATED_WORKTREE', detail: 'The original bound worktree changed after the run; broker is read-only.', data, evidence };
  if (spawnFailed) return { ok: false, reason: 'TEST_EXEC_ERROR', detail: redactString(String((res.error && res.error.code) || 'spawn error')), data, evidence };
  if (maxBufferError || stdoutTruncated || stderrTruncated) return { ok: false, reason: 'TEST_OUTPUT_OVERFLOW', detail: 'execution exceeded the configured output cap; truncated evidence returned.', data, evidence };
  if (timedOut) return { ok: false, reason: 'TEST_TIMEOUT', detail: `execution exceeded timeout (${command.timeoutMs} ms); child terminated.`, data, evidence };
  if (exitCode !== 0) return { ok: false, reason: 'TEST_NONZERO_EXIT', detail: `execution exited with code ${exitCode}.`, data, evidence };
  return { ok: true, reason: null, detail: null, data, evidence };
}

function opRunTest({ worktree, testId, testRegistry, spawn, exec, controlCwd }) {
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

  const r = runInSnapshot({ worktree, command: entry, spawn, exec, controlCwd, operation: 'run_registered_test', argvSource: 'registry' });
  const base = { operation: 'run_registered_test', testId, data: r.data, evidence: r.evidence };
  if (!r.ok) return { ok: false, reason: r.reason, ...base, detail: r.detail };
  return { ok: true, ...base };
}

// Deterministic safe local command boundary: authorizes the inline
// executable/argv via classifySafeCommand BEFORE any execution (never a shell,
// no caller cwd/env), bounds it via validateRegistryEntry, then runs EXACTLY
// ONCE in the disposable snapshot.
function opRunSafeCommand({ worktree, executable, argv, timeoutMs, maxOutputBytes, spawn, exec, controlCwd }) {
  const v = classifySafeCommand({ executable, argv, executionRoot: worktree, primaryCheckout: controlCwd });
  if (v.verdict !== OP_OUTCOME.ALLOW) {
    return {
      ok: false,
      operation: 'run_safe_command',
      verdict: v.verdict,
      reason: v.reason,
      detail: v.detail,
      ...(v.targetKind ? { targetKind: v.targetKind } : {}),
      ...(v.rerouteRoot !== undefined ? { rerouteRoot: v.rerouteRoot } : {}),
    };
  }
  const entry = {
    executable,
    argv,
    timeoutMs: timeoutMs === undefined ? DEFAULT_TEST_TIMEOUT_MS : timeoutMs,
    maxOutputBytes: maxOutputBytes === undefined ? DEFAULT_TEST_MAX_OUTPUT_BYTES : maxOutputBytes,
  };
  const ve = validateRegistryEntry(entry);
  if (!ve.ok) return { ok: false, ...ve, operation: 'run_safe_command' };

  const r = runInSnapshot({ worktree, command: ve.entry, spawn, exec, controlCwd, operation: 'run_safe_command', argvSource: 'command' });
  const base = { operation: 'run_safe_command', data: r.data, evidence: r.evidence };
  if (!r.ok) return { ok: false, reason: r.reason, ...base, detail: r.detail };
  return { ok: true, ...base };
}

// ---- single auditable dispatch boundary -------------------------------------

// ---- single auditable dispatch boundary -------------------------------------
// The registry and execution primitives are bound at factory-creation time and
// are invisible to the untrusted request object: the request carries only the
// operation + typed args. There is no second argument, no opts.testRegistry,
// no caller-supplied executable/argv/env/cwd/path — the override path is gone.

export function createExecutionBroker({
  worktreesRoot,
  controlCwd,
  testRegistry,
  exec = execFileSync,
  spawn = spawnSync,
} = {}) {
  // Deep-copy + deep-freeze ONLY the broker's internal registry copy at factory
  // time (GPT-REV-127 + review fix): the caller's testRegistry object is never
  // frozen, mutated, or even read after the copy is taken — it is left exactly
  // as provided. The independent deep-frozen copy is what the broker executes,
  // so no in-memory mutation of the caller's registry (or its nested objects)
  // after the broker is built can change what the broker will run. Requests
  // never carry the registry or execution primitives — they are bound here, in
  // the trusted control-plane closure.
  const registry = deepFreeze(deepCopy(testRegistry));

  function executeBrokerRequest(request) {
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
      if (n.operation === 'run_safe_command') {
        return redactValue(opRunSafeCommand({ worktree, executable: n.executable, argv: n.argv, timeoutMs: n.timeoutMs, maxOutputBytes: n.maxOutputBytes, spawn, exec, controlCwd }));
      }
      return redactValue(opRunTest({ worktree, testId: n.testId, testRegistry: registry, spawn, exec, controlCwd }));
    } catch (e) {
      return {
        ok: false,
        reason: 'BROKER_INTERNAL_ERROR',
        detail: redactString(String((e && e.message) || e)),
      };
    }
  }
  return { executeBrokerRequest };
}
