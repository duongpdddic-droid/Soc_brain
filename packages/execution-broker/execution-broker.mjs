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
//     spawn path — those live only in the trusted control-plane boundary.
//     (Issue #35 rework: the run_safe_command caller-argv surface was REMOVED;
//     deterministic command classification stays in permission-orchestration.)
//   - Only `status`, `diff`, `run_registered_test`, `commit` are dispatchable.
//     (Issue #35 rework: the run_safe_command caller-argv surface was REMOVED;
//     deterministic command classification stays in permission-orchestration.)
//   - Issue #49 + GPT-REV-137: `commit` is the single bounded MUTATOR. It
//     accepts only a canonical message shape + task-scoped relative paths (no
//     argv, no cwd, no executable, no arbitrary git verbs — amend/merge/push/
//     reset-hard are structurally impossible on this surface). The commit is
//     built inside a DISPOSABLE ISOLATED INDEX (GIT_INDEX_FILE) so its
//     changed-file set is exactly the validated requested paths, independent
//     of unrelated pre-existing staged/index state; the real index is written
//     at most by a path-limited `git reset -q -- <paths>` AFTER a successful
//     commit. Fixed argv via exec (no shell); fails closed (NOTHING_TO_COMMIT)
//     when the requested paths carry no change.
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
//   - Repeated-Action Circuit Breaker v0 (Issue #61): identical failing
//     actions are trip-counted per normalized identity; after a bounded
//     consecutive-failure threshold further identical requests are rejected
//     with CIRCUIT_BREAKER_TRIPPED BEFORE execution (deterministic, no AI).
//     See the CB section near the top of this file.
//   - Results are JSON-compatible plain objects; broker never throws and
//     never mutates Git state or task files.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { verifyBinding, SHA40_RE } from '../workspace/workspace.mjs';
import { normalizeRemoteUrl } from '../safe-git/safe-git.mjs';

export const BROKER_SCHEMA_VERSION = '1';
export const BROKER_OPERATIONS = ['status', 'diff', 'run_registered_test', 'commit'];
export const DIFF_MODES = ['working_tree', 'staged'];
export const STATUS_MAX_BYTES = 64 * 1024;
export const DIFF_MAX_BYTES = 256 * 1024;
export const DEFAULT_TEST_TIMEOUT_MS = 10000;
export const MAX_TEST_TIMEOUT_MS = 120000;
export const DEFAULT_TEST_MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_TEST_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
// ---- Issue #49: bounded canonical commit --------------------------------------
// Message MUST match the canonical shape: [type]((scope)): subject
// (one line, canonical type only). Paths must be unique, relative,
// task-scoped, free of traversal/absolute/~, control, shell-metachar and
// pathspec-glob/magic characters. Everything else fails closed at
// validateRequest — before any binding verification or mutation.
export const COMMIT_MESSAGE_RE = /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-zA-Z0-9._/-]+\))?: \S(?:.*\S)?$/;
export const COMMIT_MESSAGE_MAX_BYTES = 512;
export const COMMIT_PATH_MAX = 200;
export const COMMIT_PATH_MAX_CHARS = 1024;
const GLOB_PATHSPEC_RE = /[*?[\]:]/;

// ---- Repeated-Action Circuit Breaker v0 (Issue #61) -------------------------
// Deterministic, in-process breaker over the SINGLE dispatch choke point
// (executeBrokerRequest) so every executor adapter that talks to the broker is
// covered. NO AI, NO human gate: when the same normalized action fails
// `threshold` times in a row, further IDENTICAL actions are rejected with
// CIRCUIT_BREAKER_TRIPPED + evidence; DIFFERENT actions still run (per-action
// circuit, not a session-wide kill switch). The evidence on the trip response
// is the recovery decision input for the control plane (e.g. session restart,
// which naturally resets the in-process state). Scope note: the breaker lives
// in the createExecutionBroker closure — one broker per executor session (the
// runtime-sandbox MCP server binds one broker for the process lifetime), so
// v0 semantics are "latched until session restart".

export const CB_DEFAULT_THRESHOLD = 3;
export const CB_MIN_THRESHOLD = 2;
export const CB_MAX_THRESHOLD = 10;
// Canonical action-identity cap. Post-validation broker args are bounded
// (message <= 512B, <= 200 paths x <= 1024 chars, testId <= 200), so every
// schema-valid request canonicalizes far below this; the cap exists so an
// unbounded/absurd args object can never grow memory. Beyond the cap the
// request still runs — untracked (fail-safe, never crashes the runtime).
export const CB_IDENTITY_MAX_BYTES = 256 * 1024;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Canonicalize validated broker args into a stable string. Sorted keys make
// key order irrelevant; path ARRAYS keep their order (a commit touching
// [a,b] vs [b,a] is the same logical action for loop detection purposes, but
// collapsing arrays is NOT done elsewhere: any different scalar value yields
// a different identity). Deterministic; no timestamps inside identities.
function canonicalizeForIdentity(operation, args) {
  const walk = (v) => {
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v)) {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    throw new TypeError('non-serializable value in action args');
  };
  const canonical = JSON.stringify({ operation, args: walk(args) });
  if (Buffer.byteLength(canonical, 'utf8') > CB_IDENTITY_MAX_BYTES) {
    throw new RangeError('action identity exceeds CB_IDENTITY_MAX_BYTES');
  }
  return canonical;
}

// Build the normalized action identity for an ALREADY schema-validated
// request's normalized fields (v.normalized). Returns { ok:true, key, keyHash }
// or { ok:false } — never throws, so a malformed/missing identity can only
// degrade to "untracked", never crash the dispatch.
export function normalizeBrokerActionIdentity(n) {
  try {
    if (!isPlainObject(n)) return { ok: false, reason: 'ACTION_IDENTITY_UNAVAILABLE' };
    const operation = typeof n.operation === 'string' ? n.operation : null;
    if (!operation) return { ok: false, reason: 'ACTION_IDENTITY_UNAVAILABLE' };
    let args = {};
    if (operation === 'diff') args = { mode: n.diffMode };
    else if (operation === 'run_registered_test') args = { testId: n.testId };
    else if (operation === 'commit') args = { message: n.message, paths: [...n.paths].sort() };
    // status: no args — the operation alone is the identity.
    const canonical = canonicalizeForIdentity(operation, args);
    const keyHash = crypto.createHash('sha256').update(canonical).digest('hex');
    return { ok: true, key: canonical, keyHash, operation };
  } catch (e) {
    return { ok: false, reason: 'ACTION_IDENTITY_UNAVAILABLE', detail: String((e && e.message) || e) };
  }
}

function resolveCbThreshold(circuitBreakerThreshold) {
  // Bounded config: integer in [CB_MIN_THRESHOLD, CB_MAX_THRESHOLD]; anything
  // else falls back to the safe default (fail-safe: never crashes the factory).
  if (
    Number.isInteger(circuitBreakerThreshold)
    && circuitBreakerThreshold >= CB_MIN_THRESHOLD
    && circuitBreakerThreshold <= CB_MAX_THRESHOLD
  ) return circuitBreakerThreshold;
  return CB_DEFAULT_THRESHOLD;
}

// Per-action state machine. Latched "open" per action key; a success of the
// SAME key closes it and clears its history (see CB success semantics above).
export function createCircuitBreaker({ threshold } = {}) {
  const limit = resolveCbThreshold(threshold);
  // key -> { failures, lastReason }; key -> true when open (latched).
  const counters = new Map();
  const open = new Map();

  return {
    threshold: limit,
    isOpen(key) { return open.has(key); },
    stateFor(key) {
      if (open.has(key)) return { open: true };
      const c = counters.get(key);
      return c ? { open: false, failures: c.failures } : { open: false, failures: 0 };
    },
    // Success of an identity: clears its failure history; closes it if it was
    // open (defense for direct module users; via the broker an open action is
    // blocked before execution so this path is only reachable in tests/ops).
    recordSuccess(key) {
      if (typeof key !== 'string' || !key) return { ok: false, reason: 'ACTION_IDENTITY_UNAVAILABLE' };
      open.delete(key);
      counters.delete(key);
      return { ok: true, closed: true };
    },
    // Failure of an identity: bump its consecutive-failure counter; trip
    // EXACTLY ONCE when the counter first reaches the threshold (an already
    // open action does not re-trip). Returns the evidence to attach.
    recordFailure(key, lastReason) {
      if (typeof key !== 'string' || !key) return { ok: false, reason: 'ACTION_IDENTITY_UNAVAILABLE' };
      if (open.has(key)) {
        return { ok: true, alreadyOpen: true, tripped: false, open: true, keyHash: crypto.createHash('sha256').update(key).digest('hex') };
      }
      const failures = ((counters.get(key) || { failures: 0 }).failures) + 1;
      const entry = { failures, lastReason: typeof lastReason === 'string' ? lastReason : null };
      counters.set(key, entry);
      if (failures >= limit) {
        counters.delete(key);
        open.set(key, true);
        return {
          ok: true,
          tripped: true,
          open: true,
          failures,
          threshold: limit,
          lastReason: entry.lastReason,
          keyHash: crypto.createHash('sha256').update(key).digest('hex'),
        };
      }
      return { ok: true, tripped: false, open: false, failures, threshold: limit };
    },
  };
}

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
  let message;
  let paths;
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
  } else if (operation === 'commit') {
    const extra = argKeys.filter((k) => k !== 'message' && k !== 'paths');
    if (extra.length) {
      return { ok: false, reason: 'INVALID_ARGS', fields: extra, detail: `commit accepts only 'message' and 'paths'; got: ${extra.join(', ')}` };
    }
    message = args.message;
    if (
      typeof message !== 'string'
      || !COMMIT_MESSAGE_RE.test(message)
      || Buffer.byteLength(message, 'utf8') > COMMIT_MESSAGE_MAX_BYTES
      || CONTROL_RE.test(message)
    ) {
      return { ok: false, reason: 'INVALID_COMMIT_MESSAGE', detail: `message must be one line matching [type]((scope)): subject (canonical type, <= ${COMMIT_MESSAGE_MAX_BYTES} bytes, no control characters).` };
    }
    paths = args.paths;
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > COMMIT_PATH_MAX) {
      return { ok: false, reason: 'INVALID_COMMIT_PATHS', detail: `paths must be a non-empty array of at most ${COMMIT_PATH_MAX} unique relative task-scoped strings.` };
    }
    const seen = new Set();
    for (const p of paths) {
      if (typeof p !== 'string' || !p || p.length > COMMIT_PATH_MAX_CHARS || seen.has(p)) {
        return { ok: false, reason: 'INVALID_COMMIT_PATHS', detail: 'each path must be a non-empty unique string.' };
      }
      seen.add(p);
      const norm = p.replace(/\\/g, '/');
      if (
        norm.startsWith('/')
        || /^[a-zA-Z]:/.test(norm)
        || norm.includes('..')
        || norm.startsWith('~')
        || CONTROL_RE.test(p)
        || SHELL_META_RE.test(p)
        || GLOB_PATHSPEC_RE.test(p)
      ) {
        return { ok: false, reason: 'INVALID_COMMIT_PATHS', path: p, detail: 'paths must be relative, task-scoped, and free of traversal, absolute, ~, control, shell-metachar, and pathspec-glob/magic characters.' };
      }
    }
    paths = paths.slice();
  }

  return { ok: true, normalized: { repo, issueNumber, baseSha, operation, testId, diffMode, message, paths } };
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
// a `reason`/`detail` on failure. Used by opRunTest (registry) — never a second
// command runner. (Issue #35 rework: opRunSafeCommand was removed; classification
// of safe commands stays deterministic in permission-orchestration.)
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

// ---- Issue #49: bounded canonical commit (GPT-REV-137: index isolation) ------
// The ONLY mutator. Deterministic exact-set bounding: the commit is built in a
// DISPOSABLE ISOLATED INDEX (GIT_INDEX_FILE) instead of the shared real index,
// so the resulting commit's changed-file set is EXACTLY the validated requested
// paths — independent of any unrelated pre-existing staged/unmerged index
// state. All fixed argv via exec (no shell); the verified binding path is the
// only execution root. Sequence:
//   1. git rev-parse --git-dir                          (locate the git dir)
//   2. GIT_INDEX_FILE=<temp> git read-tree HEAD          (seed temp index)
//   3. GIT_INDEX_FILE=<temp> git update-index --add --remove -- <paths>
//   4. GIT_INDEX_FILE=<temp> git commit --no-verify -m <message>
//      (no pathspec: the commit is exactly HEAD + requested paths' worktree
//       content; --no-verify keeps hooks from injecting other files)
//   5. git reset -q -- <paths>   (mixed, path-limited, never moves refs: only
//      the committed paths' REAL-index entries are reverted to HEAD so no
//      residual staged state remains for them; unrelated staged entries — e.g.
//      a pre-existing staged B — are never touched)
// The temp index is unlinked on every exit path. The real index file is written
// at most by step 5 and only after a successful commit; every failure path
// leaves the real index byte-for-byte untouched.
// Deterministic failure taxonomy:
//   git-dir / read-tree failure  -> COMMIT_GIT_FAILED (pre-stage, no mutation)
//   staging (update-index) fail  -> GIT_ADD_FAILED (pre-stage, no mutation)
//   nothing to commit            -> NOTHING_TO_COMMIT (fail-closed, HEAD unchanged)
//   conflicted worktree          -> CONFLICTED_WORKING_TREE
//   any other commit failure     -> COMMIT_GIT_FAILED
//   post-commit restore failure  -> COMMIT_RESTORE_FAILED (partial: the commit
//                                   exists; data.head read-back is attempted)
function opCommit({ worktree, message, paths, exec }) {
  const pathspecs = paths.map((p) => p.replace(/\\/g, '/'));
  const baseOpts = (extra) => ({
    cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...extra,
  });
  const isoEnv = (T) => ({ env: { ...process.env, GIT_INDEX_FILE: T } });
  // Fixed-argv git runner bound to the disposable isolated index (steps 2-4).
  const runIso = (args, T, maxBytes) => {
    let raw;
    try {
      raw = exec('git', args, baseOpts({ ...isoEnv(T), maxBuffer: maxBytes + 1 }));
      return { ok: true, stdout: String(raw == null ? '' : raw) };
    } catch (e) {
      return { ok: false, stdout: String((e && e.stdout) || ''), stderr: String((e && e.stderr) || ''), message: String((e && e.message) || e) };
    }
  };

  // Step 1: locate the git dir (a linked worktree keeps `.git` as a FILE; the
  // index lives in the resolved git dir). Fixed argv, read-only.
  let gitDirRaw = '';
  try {
    gitDirRaw = String(exec('git', ['rev-parse', '--git-dir'], baseOpts({ maxBuffer: STATUS_MAX_BYTES + 1 }))).trim();
  } catch (e) {
    return { ok: false, reason: 'COMMIT_GIT_FAILED', detail: redactString(String((e && e.message) || e)) };
  }
  const tempIndex = path.resolve(worktree, gitDirRaw, `soc-commit-${process.pid}-${crypto.randomBytes(6).toString('hex')}.index`);
  const unlinkTempIndex = () => { try { fs.unlinkSync(tempIndex); } catch { /* best-effort */ } };

  // Step 2: seed the isolated index from HEAD (a repo without HEAD -> fail closed).
  let r = runIso(['read-tree', 'HEAD'], tempIndex, STATUS_MAX_BYTES);
  if (!r.ok) {
    unlinkTempIndex();
    return { ok: false, reason: 'COMMIT_GIT_FAILED', detail: redactString(r.message + (r.stderr ? ' | ' + r.stderr.slice(0, 500) : '')) };
  }
  // Step 3: stage exactly the requested paths into the ISOLATED index. Plumbing
  // does not apply .gitignore (unlike `git add`): an explicitly requested,
  // task-scoped file path is committable; a nonexistent path is a silent no-op
  // here, which step 4 then deterministically reports as NOTHING_TO_COMMIT.
  r = runIso(['update-index', '--add', '--remove', '--', ...pathspecs], tempIndex, STATUS_MAX_BYTES);
  if (!r.ok) {
    unlinkTempIndex();
    return { ok: false, reason: 'GIT_ADD_FAILED', detail: redactString(r.message + (r.stderr ? ' | ' + r.stderr.slice(0, 500) : '')) };
  }
  // Step 4: commit the isolated index. No pathspec, no shell, no hooks.
  r = runIso(['commit', '--no-verify', '-m', message], tempIndex, DIFF_MAX_BYTES);
  if (!r.ok) {
    unlinkTempIndex();
    const combined = r.stdout + r.stderr;
    // "nothing to commit" variants go to stdout; both mean the requested paths
    // carry no change vs HEAD -> fail-closed, HEAD unchanged, index untouched.
    if (/nothing (added )?to commit|no changes added to commit/i.test(combined)) {
      return { ok: false, reason: 'NOTHING_TO_COMMIT', detail: 'Nothing to commit for the requested paths; worktree unchanged.' };
    }
    if (/CONFLICT |Merge conflict/i.test(combined)) {
      return { ok: false, reason: 'CONFLICTED_WORKING_TREE', detail: redactString(combined.slice(0, 2000)) };
    }
    return { ok: false, reason: 'COMMIT_GIT_FAILED', detail: redactString(r.message + (combined ? ' | ' + combined.slice(0, 500) : '')) };
  }
  // Step 5: deterministic post-commit restore — revert ONLY the committed
  // paths' real-index entries to HEAD. Mixed reset with a pathspec never moves
  // refs and never touches unrelated entries.
  let restored = true;
  try {
    exec('git', ['reset', '-q', '--', ...pathspecs], baseOpts({ maxBuffer: STATUS_MAX_BYTES + 1 }));
  } catch (e) {
    restored = false;
  }
  unlinkTempIndex();
  // Deterministic evidence: read back the exact commit the worktree now points
  // at (Soc_brain verifies the result/HEAD independently via rev-parse).
  let head = '';
  try {
    head = String(exec('git', ['rev-parse', 'HEAD'], baseOpts())).trim();
  } catch (e) {
    return { ok: false, reason: 'COMMIT_GIT_FAILED', detail: redactString(String((e && e.message) || e)), partial: true };
  }
  const st = runGit(['status', '--porcelain=v1'], worktree, exec, STATUS_MAX_BYTES);
  const remainingEntries = st.ok ? st.text.split('\n').filter(Boolean).length : null;
  const data = { head, paths: pathspecs, remainingEntries, outputBytes: Buffer.byteLength(r.stdout, 'utf8') };
  const evidence = {
    redactionApplied: true,
    argvShape: 'git commit --no-verify -m <message> (isolated GIT_INDEX_FILE)',
    shellUsed: false,
    isolatedIndex: true,
  };
  if (!restored) {
    return {
      ok: false, reason: 'COMMIT_RESTORE_FAILED', partial: true,
      detail: 'The commit was created but restoring the real-index state of the committed paths failed; unrelated staged state is untouched.',
      data, evidence,
    };
  }
  return { ok: true, operation: 'commit', data, evidence };
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
  circuitBreakerThreshold,
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
  // Repeated-Action Circuit Breaker v0 (Issue #61): one breaker per broker
  // instance (== per executor session in the runtime-sandbox MCP server).
  // Deterministic, in-process, NO AI; recovery = control plane decision
  // (session restart naturally resets this in-process state).
  const breaker = createCircuitBreaker({ threshold: circuitBreakerThreshold });

  function blockedByBreaker(n, id) {
    return {
      ok: false,
      reason: 'CIRCUIT_BREAKER_TRIPPED',
      operation: n.operation,
      circuitBreaker: {
        actionKeyHash: id.keyHash,
        operation: id.operation,
        threshold: breaker.threshold,
        reason: 'REPEATED_IDENTICAL_FAILURE',
        detail: 'The identical action failed repeatedly; further identical requests are blocked without execution. Control plane decides recovery (session restart resets this breaker).',
      },
    };
  }

  function executeBrokerRequest(request) {
    try {
      const v = validateRequest(request);
      if (!v.ok) return { ok: false, ...v, operation: (request && request.operation) || null };

      const n = v.normalized;
      // Circuit breaker identity (Issue #61): computed from the VALIDATED
      // normalized fields only. If the identity is unavailable (malformed or
      // beyond the bounded canonical size), the request proceeds UNTRACKED —
      // fail-safe, never crashes the dispatch.
      const id = normalizeBrokerActionIdentity(n);
      if (id.ok && breaker.isOpen(id.key)) return blockedByBreaker(n, id);

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
        const bindingFailure = {
          ok: false,
          reason: 'BINDING_VERIFY_FAILED',
          bindingReason: binding.reason,
          operation: n.operation,
          detail: redactString(String(binding.detail || binding.reason)),
        };
        return cbObserve(id, bindingFailure);
      }

      const worktree = binding.path; // verified binding path is the ONLY execution root.

      let result;
      if (n.operation === 'status') result = redactValue(opStatus({ worktree, exec }));
      else if (n.operation === 'diff') result = redactValue(opDiff({ worktree, mode: n.diffMode, exec }));
      else if (n.operation === 'commit') result = redactValue(opCommit({ worktree, message: n.message, paths: n.paths, exec }));
      else result = redactValue(opRunTest({ worktree, testId: n.testId, testRegistry: registry, spawn, exec, controlCwd }));
      return cbObserve(id, result);
    } catch (e) {
      return {
        ok: false,
        reason: 'BROKER_INTERNAL_ERROR',
        detail: redactString(String((e && e.message) || e)),
      };
    }
  }

  // Circuit-breaker bookkeeping around an already-computed result. Success
  // clears that identity's history; failure bumps it and may trip exactly
  // once (the TRIPPING response carries the evidence; later identical
  // requests are blocked before execution). Never throws; identity-less
  // results pass through unchanged.
  function cbObserve(id, result) {
    try {
      if (!id.ok || typeof (result && result.ok) !== 'boolean') return result;
      if (result.ok) {
        breaker.recordSuccess(id.key);
        return result;
      }
      const st = breaker.recordFailure(id.key, typeof result.reason === 'string' ? result.reason : null);
      if (st.ok && st.tripped) {
        return {
          ...result,
          circuitBreaker: {
            tripped: true,
            actionKeyHash: st.keyHash,
            operation: id.operation,
            failures: st.failures,
            threshold: st.threshold,
            lastReason: st.lastReason,
            reason: 'REPEATED_IDENTICAL_FAILURE',
          },
        };
      }
      return result;
    } catch (e) {
      // Breaker bookkeeping must never break the operation result (fail-safe).
      return result;
    }
  }
  return { executeBrokerRequest };
}
