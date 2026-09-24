// task-ingestion.mjs — Task Bootstrapper ↔ ControlLoop intake seam (PR #229).
//
// Objective (AGENTS.md R1→R10, Fail-Closed):
//   When the control loop receives a NEW Goal, it can automatically invoke
//   scripts/Invoke-SocTask.ps1 via child_process.spawn with safe PowerShell
//   flags (-NoProfile -NonInteractive -ExecutionPolicy Bypass -File), parse
//   the BOOTSTRAP_OK result (PR number, worktree path, branch name), and
//   assign those fields directly onto the canonical Session lease — no manual
//   operator bootstrap command is required.
//
// Fail-Closed contract:
//   - exit code != 0            → classified BOOTSTRAP_* failure, no session write
//   - dirty primary checkout    → BOOTSTRAP_PRIMARY_DIRTY (mapped from PS stderr)
//   - gh/network step failure   → BOOTSTRAP_STEP_FAILED (mapped from PS stderr)
//   - unparsable success stdout → BOOTSTRAP_OUTPUT_UNPARSEABLE
//   - spawn/transport error     → BOOTSTRAP_SPAWN_ERROR
//   - session missing/invalid   → SESSION_* (assignment never invents authority)
//   Every failure emits a structured JSON log line (best-effort under
//   stateDir/logs/task-ingestion.jsonl) and stops the intake BEFORE runControlLoop.
//
// Offline-safe: the spawn transport is injectable (deps.spawnBootstrapper /
// spawnImpl) so tests mock the bootstrapper without network, git, or gh.
import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateSessionUnderOwnershipLock, readSessionRecord } from '../runtime-sandbox/runtime-sandbox.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT_DEFAULT = path.resolve(__dirname, '..', '..');

export const TASK_INGESTION_SCHEMA_VERSION = '1';
export const BOOTSTRAPPER_SCRIPT_REL = path.join('scripts', 'Invoke-SocTask.ps1');

// Required safe PowerShell invocation flags (task contract — never omit).
export const PS_SAFE_FLAGS = Object.freeze([
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
]);

function ok(value, extra = {}) { return { ok: true, value, ...extra }; }
function fail(code, detail, extra = {}) { return { ok: false, code, detail: detail ?? null, ...extra }; }

// ---- Structured failure log (best-effort; never throws into the caller) ------
export function writeIngestionLog({ stateDir, entry }) {
  if (typeof stateDir !== 'string' || !stateDir || !entry || typeof entry !== 'object') return false;
  try {
    const dir = path.join(stateDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), schemaVersion: TASK_INGESTION_SCHEMA_VERSION, ...entry });
    fs.appendFileSync(path.join(dir, 'task-ingestion.jsonl'), `${line}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

// ---- Argument builder --------------------------------------------------------
// Pure validation + argv assembly. No process is spawned here.
export function buildBootstrapperArgs({
  goal, issueNumber = null, base = 'origin/main', repo = 'duongpdddic-droid/Soc_brain',
  repoRoot = null, worktreesRoot = null, timestamp = null, pullRequestNumber = null,
  dryRun = false, scriptPath,
} = {}) {
  if (typeof goal !== 'string' || !goal.trim()) {
    return fail('BOOTSTRAP_GOAL_REQUIRED', 'goal is required to invoke the task bootstrapper');
  }
  if (typeof scriptPath !== 'string' || !scriptPath) {
    return fail('BOOTSTRAP_SCRIPT_PATH_REQUIRED', 'scriptPath to Invoke-SocTask.ps1 is required');
  }
  if (issueNumber != null && !(Number.isInteger(issueNumber) && issueNumber > 0)) {
    return fail('BOOTSTRAP_BAD_ARGS', `issueNumber must be a positive integer, got: ${String(issueNumber)}`);
  }
  if (pullRequestNumber != null && !(Number.isInteger(pullRequestNumber) && pullRequestNumber > 0)) {
    return fail('BOOTSTRAP_BAD_ARGS', `pullRequestNumber must be a positive integer, got: ${String(pullRequestNumber)}`);
  }

  const args = [...PS_SAFE_FLAGS, scriptPath, '-Goal', String(goal).trim()];
  if (issueNumber != null) args.push('-IssueNumber', String(issueNumber));
  if (base) args.push('-Base', String(base));
  if (repo) args.push('-Repo', String(repo));
  if (repoRoot) args.push('-RepoRoot', String(repoRoot));
  if (worktreesRoot) args.push('-WorktreesRoot', String(worktreesRoot));
  if (timestamp) args.push('-Timestamp', String(timestamp));
  if (pullRequestNumber != null) args.push('-PullRequestNumber', String(pullRequestNumber));
  if (dryRun) args.push('-DryRun');

  return ok({ args, goal: String(goal).trim(), scriptPath });
}

// ---- PowerShell host selection ----------------------------------------------
// Prefer pwsh (PowerShell 7+): the bootstrapper suite and its empty-array
// ConvertFrom-Json semantics are validated under pwsh. powershell.exe (5.1)
// is only used when SOC_PS_HOST pins it explicitly (legacy hosts).
export function resolvePowerShellHost(platform = process.platform) {
  const pinned = typeof process.env.SOC_PS_HOST === 'string' && process.env.SOC_PS_HOST.trim()
    ? process.env.SOC_PS_HOST.trim()
    : '';
  if (pinned) return pinned;
  return platform === 'win32' ? 'pwsh' : 'pwsh';
}

// ---- Output parser (BOOTSTRAP_OK human summary → structured payload) ---------
// Real format emitted by scripts/Invoke-SocTask.ps1:
//   ============================================================
//   BOOTSTRAP_OK goal=<text>
//   branch=<branch>
//   pr=<N> url=<url> label=status:in-progress draft=<bool>
//   worktree=<abs path>
//   contract=<abs path>
//   Next: cd into the worktree and execute the task prompt.
//   ============================================================
export function parseBootstrapOutput(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) {
    return fail('BOOTSTRAP_OUTPUT_UNPARSEABLE', 'empty bootstrapper stdout');
  }
  if (!/BOOTSTRAP_OK\b/.test(stdout)) {
    return fail('BOOTSTRAP_OUTPUT_UNPARSEABLE', 'BOOTSTRAP_OK marker missing from bootstrapper stdout');
  }
  const goalM = /^BOOTSTRAP_OK goal=(.*)$/m.exec(stdout);
  const branchM = /^branch=(\S+)\s*$/m.exec(stdout);
  const prM = /^pr=(\d+)\s+url=(\S+)\s/m.exec(stdout);
  const worktreeM = /^worktree=(.+)\s*$/m.exec(stdout);
  const contractM = /^contract=(.+)\s*$/m.exec(stdout);

  if (!goalM || !branchM || !prM || !worktreeM) {
    return fail('BOOTSTRAP_OUTPUT_UNPARSEABLE',
      'required BOOTSTRAP_OK fields missing (goal/branch/pr/worktree)');
  }
  const prNumber = Number.parseInt(prM[1], 10);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return fail('BOOTSTRAP_OUTPUT_UNPARSEABLE', `invalid pr number: ${prM[1]}`);
  }
  return ok({
    goal: goalM[1].trim(),
    branch: branchM[1],
    prNumber,
    prUrl: prM[2],
    worktreePath: worktreeM[1].trim(),
    contractPath: contractM ? contractM[1].trim() : null,
  });
}

// ---- Failure classification (PowerShell stderr → deterministic code) ---------
export function classifyBootstrapFailure({ exitCode = null, signal = null, stderr = '', stdout = '' } = {}) {
  const err = String(stderr || '');
  const out = String(stdout || '');
  const blob = `${err}\n${out}`;
  if (/PRIMARY_DIRTY\b/.test(blob)) {
    return { code: 'BOOTSTRAP_PRIMARY_DIRTY', classifiedAs: 'DIRTY_WORKING_TREE' };
  }
  if (/GOAL_REQUIRED|BASE_REQUIRED|REPO_REQUIRED|INVALID_ISSUE_NUMBER|INVALID_TIMESTAMP|INVALID_PULL_REQUEST_NUMBER/.test(blob)) {
    return { code: 'BOOTSTRAP_BAD_ARGS', classifiedAs: 'ASSERTION_FAILED' };
  }
  if (/COMMAND_FAILED\b|gh\b.*failed|network|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|HTTP\s*[45]\d\d/i.test(blob)) {
    return { code: 'BOOTSTRAP_STEP_FAILED', classifiedAs: 'TRANSPORT_FAILURE' };
  }
  if (/BOOTSTRAP_FAILED\b/.test(blob)) {
    return { code: 'BOOTSTRAP_FAILED', classifiedAs: 'ASSERTION_FAILED' };
  }
  if (signal) {
    return { code: 'BOOTSTRAP_SPAWN_ERROR', classifiedAs: 'PROCESS_DIED', signal: String(signal) };
  }
  if (exitCode === 2) {
    return { code: 'BOOTSTRAP_BAD_ARGS', classifiedAs: 'ASSERTION_FAILED' };
  }
  return { code: 'BOOTSTRAP_EXIT_NONZERO', classifiedAs: 'ASSERTION_FAILED' };
}

// ---- Default async spawn transport ------------------------------------------
// Returns Promise<{ status, signal, stdout, stderr, error }>. Injectable so
// offline tests never touch a real PowerShell process.
export function defaultSpawnBootstrapper(command, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = nodeSpawn(command, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ status: null, signal: null, stdout: '', stderr: String((e && e.message) || e), error: e });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (payload) => { if (!settled) { settled = true; resolve(payload); } };
    if (child.stdout) child.stdout.setEncoding('utf8');
    if (child.stderr) child.stderr.setEncoding('utf8');
    if (child.stdout) child.stdout.on('data', (d) => { stdout += d; });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => {
      settle({ status: null, signal: null, stdout, stderr: stderr || String((error && error.message) || error), error });
    });
    child.on('close', (status, signal) => {
      settle({ status, signal, stdout, stderr, error: null });
    });
  });
}

// ---- Run the bootstrapper (spawn → classify → parse) -------------------------
// Fail-closed: any non-zero exit, spawn error, or unparsable success output
// returns { ok:false, code, detail } with structured log side-effect.
export async function runTaskBootstrapper({
  goal, issueNumber = null, base, repo, repoRoot, worktreesRoot, timestamp,
  pullRequestNumber = null, dryRun = false,
  projectRoot = PROJECT_ROOT_DEFAULT,
  scriptPath = null,
  host = null,
  cwd = null,
  env = null,
  spawnImpl = null,
  stateDir = null,
} = {}) {
  const script = scriptPath || path.join(projectRoot, BOOTSTRAPPER_SCRIPT_REL);
  const built = buildBootstrapperArgs({
    goal, issueNumber, base, repo, repoRoot, worktreesRoot, timestamp,
    pullRequestNumber, dryRun, scriptPath: script,
  });
  if (!built.ok) {
    writeIngestionLog({ stateDir, entry: { event: 'TASK_INGESTION_FAILED', code: built.code, detail: built.detail, phase: 'args' } });
    return built;
  }

  const psHost = host || resolvePowerShellHost();
  const spawn = typeof spawnImpl === 'function' ? spawnImpl : defaultSpawnBootstrapper;
  let raw;
  try {
    raw = await spawn(psHost, built.value.args, {
      cwd: cwd || projectRoot,
      env: env || process.env,
    });
  } catch (e) {
    const detail = String((e && e.message) || e);
    const result = fail('BOOTSTRAP_SPAWN_ERROR', detail, { classifiedAs: 'PROCESS_DIED' });
    writeIngestionLog({ stateDir, entry: { event: 'TASK_INGESTION_FAILED', code: result.code, detail, phase: 'spawn' } });
    return result;
  }
  if (!raw || typeof raw !== 'object') {
    const result = fail('BOOTSTRAP_SPAWN_ERROR', 'spawn transport returned no result', { classifiedAs: 'UNKNOWN' });
    writeIngestionLog({ stateDir, entry: { event: 'TASK_INGESTION_FAILED', code: result.code, detail: result.detail, phase: 'spawn' } });
    return result;
  }

  const exitCode = Number.isInteger(raw.status) ? raw.status : null;
  const signal = raw.signal ?? null;
  const stdout = String(raw.stdout ?? '');
  const stderr = String(raw.stderr ?? '');

  if (raw.error) {
    const detail = String((raw.error && raw.error.message) || raw.error);
    const result = fail('BOOTSTRAP_SPAWN_ERROR', detail, { classifiedAs: 'PROCESS_DIED' });
    writeIngestionLog({ stateDir, entry: { event: 'TASK_INGESTION_FAILED', code: result.code, detail, exitCode, phase: 'spawn' } });
    return result;
  }

  if (exitCode !== 0) {
    const cls = classifyBootstrapFailure({ exitCode, signal, stderr, stdout });
    const detail = {
      exitCode,
      signal,
      stderr: stderr.trim().slice(0, 4000),
      stdout: stdout.trim().slice(0, 2000),
      classifiedAs: cls.classifiedAs,
    };
    const result = fail(cls.code, detail, { classifiedAs: cls.classifiedAs });
    writeIngestionLog({ stateDir, entry: { event: 'TASK_INGESTION_FAILED', code: cls.code, ...detail, phase: 'run' } });
    return result;
  }

  const parsed = parseBootstrapOutput(stdout);
  if (!parsed.ok) {
    const detail = {
      exitCode,
      parseDetail: parsed.detail,
      stdout: stdout.trim().slice(0, 2000),
      classifiedAs: 'ASSERTION_FAILED',
    };
    writeIngestionLog({ stateDir, entry: { event: 'TASK_INGESTION_FAILED', code: parsed.code, ...detail, phase: 'parse' } });
    return fail(parsed.code, detail, { classifiedAs: 'ASSERTION_FAILED' });
  }

  return ok({
    ...parsed.value,
    exitCode,
    host: psHost,
    scriptPath: script,
    args: built.value.args,
  });
}

// ---- Assign bootstrapper result onto the Session lease -----------------------
// Ownership-safe write via updateSessionUnderOwnershipLock. Refuses to invent
// a session (SESSION_NOT_FOUND) and records previous values for audit.
export function assignBootstrapToSession({ sessionPath, bootstrap, now = () => new Date().toISOString() }) {
  if (typeof sessionPath !== 'string' || !sessionPath) {
    return fail('SESSION_PATH_REQUIRED', 'sessionPath is required');
  }
  if (!bootstrap || typeof bootstrap !== 'object') {
    return fail('BOOTSTRAP_RESULT_REQUIRED', 'bootstrap result object is required');
  }
  const prNumber = Number(bootstrap.prNumber);
  const branch = bootstrap.branch;
  const worktreePath = bootstrap.worktreePath;
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return fail('BOOTSTRAP_OUTPUT_UNPARSEABLE', 'bootstrap.prNumber must be a positive integer');
  }
  if (typeof branch !== 'string' || !branch) {
    return fail('BOOTSTRAP_OUTPUT_UNPARSEABLE', 'bootstrap.branch is required');
  }
  if (typeof worktreePath !== 'string' || !worktreePath) {
    return fail('BOOTSTRAP_OUTPUT_UNPARSEABLE', 'bootstrap.worktreePath is required');
  }

  const pre = readSessionRecord(sessionPath);
  if (!pre.ok) return fail(pre.reason === 'SESSION_NOT_FOUND' ? 'SESSION_NOT_FOUND' : 'SESSION_STATE_INVALID', pre.detail ?? sessionPath);

  const persisted = updateSessionUnderOwnershipLock(sessionPath, (session) => {
    const previous = {
      prNumber: session.prNumber ?? null,
      branch: session.branch ?? null,
      worktreePath: session.worktreePath ?? null,
    };
    session.prNumber = prNumber;
    session.branch = branch;
    session.worktreePath = worktreePath;
    session.controlLoop = session.controlLoop && typeof session.controlLoop === 'object' ? session.controlLoop : {};
    session.controlLoop.bootstrapper = {
      schemaVersion: TASK_INGESTION_SCHEMA_VERSION,
      goal: bootstrap.goal ?? null,
      prNumber,
      prUrl: bootstrap.prUrl ?? null,
      branch,
      worktreePath,
      contractPath: bootstrap.contractPath ?? null,
      previous,
      assignedAt: now(),
    };
    return { session };
  });
  if (!persisted.ok) {
    return fail('BOOTSTRAP_ASSIGN_FAILED', persisted.detail ?? persisted.reason);
  }
  const back = readSessionRecord(sessionPath);
  if (!back.ok) return fail('SESSION_READ_FAILED', back.reason);
  if (back.session.prNumber !== prNumber || back.session.branch !== branch || back.session.worktreePath !== worktreePath) {
    return fail('BOOTSTRAP_ASSIGN_VERIFY_FAILED',
      `read-back mismatch: pr=${back.session.prNumber} branch=${back.session.branch} worktree=${back.session.worktreePath}`);
  }
  return ok({
    session: back.session,
    assigned: {
      prNumber: back.session.prNumber,
      branch: back.session.branch,
      worktreePath: back.session.worktreePath,
      evidence: back.session.controlLoop.bootstrapper,
    },
  });
}

// ---- Full intake: spawn bootstrapper → parse → assign to session -------------
// Called by the control loop when a new Goal arrives with bootstrap enabled.
// Fail-closed at every step; on success the Session lease carries PR/branch/
// worktree so no operator bootstrap command is needed.
export async function ingestGoalViaBootstrapper({
  goal, issueNumber = null, sessionPath, stateDir = null,
  base, repo, repoRoot, worktreesRoot, timestamp, pullRequestNumber = null,
  dryRun = false, projectRoot, scriptPath, host, cwd, env,
  spawnImpl = null, now = () => new Date().toISOString(),
} = {}) {
  if (typeof goal !== 'string' || !goal.trim()) {
    const result = fail('BOOTSTRAP_GOAL_REQUIRED', 'goal is required for task ingestion');
    writeIngestionLog({ stateDir, entry: { event: 'TASK_INGESTION_FAILED', code: result.code, detail: result.detail, phase: 'intake' } });
    return result;
  }
  if (typeof sessionPath !== 'string' || !sessionPath) {
    const result = fail('SESSION_PATH_REQUIRED', 'sessionPath is required to assign bootstrapper output');
    writeIngestionLog({ stateDir, entry: { event: 'TASK_INGESTION_FAILED', code: result.code, detail: result.detail, phase: 'intake' } });
    return result;
  }

  const run = await runTaskBootstrapper({
    goal, issueNumber, base, repo, repoRoot, worktreesRoot, timestamp,
    pullRequestNumber, dryRun, projectRoot, scriptPath, host, cwd, env,
    spawnImpl, stateDir,
  });
  if (!run.ok) return run;

  const assigned = assignBootstrapToSession({ sessionPath, bootstrap: run.value, now });
  if (!assigned.ok) {
    writeIngestionLog({
      stateDir,
      entry: {
        event: 'TASK_INGESTION_FAILED',
        code: assigned.code,
        detail: assigned.detail,
        phase: 'assign',
        prNumber: run.value.prNumber,
        branch: run.value.branch,
        worktreePath: run.value.worktreePath,
      },
    });
    return assigned;
  }

  writeIngestionLog({
    stateDir,
    entry: {
      event: 'TASK_INGESTION_OK',
      goal: run.value.goal,
      prNumber: run.value.prNumber,
      branch: run.value.branch,
      worktreePath: run.value.worktreePath,
      phase: 'assign',
    },
  });
  return ok({
    bootstrap: run.value,
    session: assigned.value.session,
    assigned: assigned.value.assigned,
  });
}

// end of task-ingestion.mjs
