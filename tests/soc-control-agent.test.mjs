// tests/soc-control-agent.test.mjs — soc_control agent config + runner CLI E2E.
// 100% offline/mock: no live HTTP, no live CDP, no live clipboard, no network.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  runSocControlLoop,
  parseArgs,
  loadInstructionFile,
  HUMAN_GATE_DELIVERY_CODE,
} from '../bin/soc-control-loop.mjs';
import { readTransitions } from '../packages/control-loop/control-loop.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import {
  buildBootstrapperArgs,
  parseBootstrapOutput,
  classifyBootstrapFailure,
  ingestGoalViaBootstrapper,
  assignBootstrapToSession,
  PS_SAFE_FLAGS,
} from '../packages/control-loop/task-ingestion.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const AGENT_PATH = path.join(PROJECT_ROOT, '.opencode', 'agents', 'soc_control.md');

const REPO = 'duongpdddic-droid/soc_brain';
const ISSUE = 9901;
const HEAD = 'a'.repeat(40);
const BASE = 'f'.repeat(40);

// ---- Minimal frontmatter parser (flat YAML only) -----------------------------
function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return null;
  const fm = {};
  const lines = m[1].split(/\r?\n/);
  let permKey = null;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.match(/^\s*/)[0].length;
    const trimmed = line.trim();
    if (indent === 0) {
      const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(trimmed);
      if (kv && kv[2] === '') {
        fm[kv[1]] = {};
        permKey = kv[1];
      } else if (kv) {
        fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
        permKey = null;
      }
    } else if (permKey && fm[permKey] && typeof fm[permKey] === 'object') {
      const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(trimmed);
      if (kv) fm[permKey][kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
  }
  return { frontmatter: fm, body: raw.slice(m[0].length) };
}

// ---- Fixture helpers ---------------------------------------------------------
function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'soc-ctrl-')); }

function mkSession(stateDir, overrides = {}) {
  const id = identityHash({ repo: REPO, issueNumber: ISSUE });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1',
    state: 'SESSION_ACTIVE',
    lifecycle: [],
    taskId: `${REPO}#${ISSUE}`,
    repo: REPO,
    issueNumber: ISSUE,
    headSha: HEAD,
    baseSha: BASE,
    worktreePath: path.join(stateDir, `wt-issue-${ISSUE}`),
    worktreesRoot: stateDir,
    controlPlane: { stateDir },
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session, id };
}

function mkExecRecord(stateDir, id) {
  const p = path.join(stateDir, 'executions', `${id}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: id,
    taskId: `${REPO}#${ISSUE}`, repo: REPO, issueNumber: ISSUE,
    terminalStatus: 'ok', exitCode: 0,
  }, null, 2), 'utf8');
  return p;
}

function baseDeps(calls, execPath) {
  return {
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: (ctx) => {
      calls.push(ctx.reworkInstruction ? 'executor:rework' : 'executor:initial');
      return { ok: true, value: { executionStatus: 'EXITED', terminalStatus: 'ok', exitCode: 0, executionRecordPath: execPath } };
    },
    verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    telegramSpawn: () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 900 })}\n` }),
  };
}

// ---- BOOTSTRAP_OK stdout fixture (mirrors scripts/Invoke-SocTask.ps1) --------
function bootstrapOkStdout({
  goal = 'Integrate Bootstrapper',
  branch = 'task/integrate-bootstrapper-20260924-075429',
  pr = 229,
  worktree = 'C:\\tmp\\wtx\\task\\integrate-bootstrapper-20260924-075429',
  contract = 'C:\\tmp\\wtx\\task\\integrate-bootstrapper-20260924-075429\\SOC_TASK_CONTRACT.md',
} = {}) {
  return [
    '='.repeat(60),
    `BOOTSTRAP_OK goal=${goal}`,
    `branch=${branch}`,
    `pr=${pr} url=https://github.com/duongpdddic-droid/Soc_brain/pull/${pr} label=status:in-progress draft=False`,
    `worktree=${worktree}`,
    `contract=${contract}`,
    'Next: cd into the worktree and execute the task prompt.',
    '='.repeat(60),
    '',
  ].join('\n');
}

// ============================================================================
// A. Agent config validity
// ============================================================================

test('A1. soc_control.md exists and has valid frontmatter', () => {
  assert.ok(fs.existsSync(AGENT_PATH), `missing agent file: ${AGENT_PATH}`);
  const raw = fs.readFileSync(AGENT_PATH, 'utf8');
  const parsed = parseFrontmatter(raw);
  assert.ok(parsed, 'frontmatter block (--- ... ---) must be present');
  const fm = parsed.frontmatter;
  assert.equal(typeof fm.description, 'string');
  assert.ok(fm.description.length > 0, 'description must be non-empty');
  assert.equal(fm.mode, 'primary', 'role must be primary Orchestrator');
});

test('A2. permissions: bash/read/glob/grep allow, edit deny', () => {
  const raw = fs.readFileSync(AGENT_PATH, 'utf8');
  const { frontmatter: fm } = parseFrontmatter(raw);
  assert.ok(fm.permission && typeof fm.permission === 'object', 'permission block required');
  assert.equal(fm.permission.bash, 'allow');
  assert.equal(fm.permission.read, 'allow');
  assert.equal(fm.permission.glob, 'allow');
  assert.equal(fm.permission.grep, 'allow');
  assert.equal(fm.permission.edit, 'deny', 'R2 Hard Boundary: edit must be deny');
});

test('A3. body defines Orchestrator FSM role, handoff, and R2 boundary', () => {
  const raw = fs.readFileSync(AGENT_PATH, 'utf8');
  const { body } = parseFrontmatter(raw);
  assert.ok(body.length > 0, 'body must not be empty');
  assert.match(body, /Orchestrator/i);
  assert.match(body, /ControlLoop|FSM/i);
  assert.match(body, /edit:\s*deny|never edit|no.*edit/i);
  assert.match(body, /handoff|hand off/i);
  assert.match(body, /DELIVERING|Human Gate/i);
  assert.match(body, /REWORK|CHANGES_REQUESTED/i);
  assert.match(body, /never self-approve|no self-approve|Never self-approve/i);
});

// ============================================================================
// B. CLI arg parsing
// ============================================================================

test('B1. parseArgs extracts repo, issue, goal, state-dir, human-gate', () => {
  const a = parseArgs(['--repo', 'o/n', '--issue', '42', '--goal', 'do thing', '--state-dir', '/tmp/s']);
  assert.equal(a.repo, 'o/n');
  assert.equal(a.issue, 42);
  assert.equal(a.goal, 'do thing');
  assert.equal(a.stateDir, '/tmp/s');
  assert.equal(a.humanGate, true);
  assert.equal(a.help, false);
});

test('B2. parseArgs handles --no-human-gate, --help, invalid issue', () => {
  const a = parseArgs(['--repo', 'o/n', '--issue', '42', '--no-human-gate']);
  assert.equal(a.humanGate, false);
  const h = parseArgs(['--help']);
  assert.equal(h.help, true);
  const bad = parseArgs(['--repo', 'o/n', '--issue', 'not-a-number']);
  assert.equal(bad.issue, null);
});

// ============================================================================
// C. E2E: APPROVED stops at Human Gate DELIVERING
// ============================================================================

test('C1. E2E APPROVED -> stops at DELIVERING (Human Gate), no COMPLETED', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const execPath = mkExecRecord(stateDir, id);
  const calls = [];
  const deps = baseDeps(calls, execPath);
  deps.finalReview = () => {
    calls.push('finalReview');
    return { ok: true, value: { text: 'All offline gates pass.\nVERDICT: APPROVED' } };
  };
  deps.delivery = () => { throw new Error('delivery must NOT be invoked by runner in humanGate mode'); };

  const res = await runSocControlLoop({
    repo: REPO, issueNumber: ISSUE, stateDir, humanGate: true, deps,
  });

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'DELIVERING');
  assert.equal(res.value.awaitingHumanGate, true);
  assert.equal(res.value.humanGate, 'AWAITING_MERGE');
  assert.equal(res.value.decision.verdict, 'PASS');

  const ledger = readTransitions({ stateDir, identityHash: id });
  const tos = ledger.map((r) => r.to);
  assert.ok(tos.includes('DELIVERING'), 'DECIDING -> DELIVERING boundary recorded');
  assert.ok(!tos.includes('COMPLETED'), 'must NOT reach COMPLETED in human gate mode');

  const boundary = ledger.find((r) => r.from === 'DECIDING' && r.to === 'DELIVERING');
  assert.ok(boundary, 'DECIDING -> DELIVERING transition exists');
  assert.equal(boundary.evidence.verdict, 'PASS');

  const persisted = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(persisted.state, 'SESSION_ACTIVE', 'session stays active awaiting human merge');

  assert.deepEqual(
    calls,
    ['router', 'executor:initial', 'verifier', 'preReview', 'finalReview'],
    'no delivery/terminalize side effects in human gate mode',
  );
});

// ============================================================================
// D. E2E: CHANGES_REQUESTED auto re-dispatches REWORK
// ============================================================================

test('D1. E2E CHANGES_REQUESTED re-dispatches REWORK, then APPROVED stops at Human Gate', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const execPath = mkExecRecord(stateDir, id);
  const calls = [];
  const deps = baseDeps(calls, execPath);
  let n = 0;
  let seenInstruction = null;
  deps.executor = (ctx) => {
    calls.push(ctx.reworkInstruction ? 'executor:rework' : 'executor:initial');
    if (ctx.reworkInstruction) seenInstruction = ctx.reworkInstruction;
    return { ok: true, value: { executionStatus: 'EXITED', terminalStatus: 'ok', exitCode: 0, executionRecordPath: execPath } };
  };
  deps.finalReview = () => {
    calls.push('finalReview');
    n += 1;
    return n === 1
      ? { ok: true, value: { text: 'Off-by-one in bounds.\nVERDICT: CHANGES_REQUESTED' } }
      : { ok: true, value: { text: 'Fixed and verified.\nVERDICT: APPROVED' } };
  };
  deps.delivery = () => { throw new Error('delivery must NOT be invoked by runner in humanGate mode'); };

  const res = await runSocControlLoop({
    repo: REPO, issueNumber: ISSUE, stateDir, humanGate: true, deps,
  });

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'DELIVERING');
  assert.equal(res.value.awaitingHumanGate, true);

  // Auto re-dispatch: executor called twice, 2nd with rework instruction.
  assert.ok(calls.includes('executor:initial'), 'initial execution');
  assert.ok(calls.includes('executor:rework'), 'rework re-dispatch');
  assert.ok(seenInstruction && seenInstruction.includes('Off-by-one'), 'rework instruction carries findings');

  const ledger = readTransitions({ stateDir, identityHash: id });
  const rw = ledger.find((r) => r.from === 'DECIDING' && r.to === 'REWORK');
  assert.ok(rw, 'DECIDING -> REWORK recorded');
  const rexec = ledger.find((r) => r.from === 'REWORK' && r.to === 'EXECUTING');
  assert.ok(rexec, 'REWORK -> EXECUTING re-dispatch recorded');
  const tos = ledger.map((r) => r.to);
  assert.ok(tos.includes('DELIVERING'), 'reaches DELIVERING after round-2 APPROVED');
  assert.ok(!tos.includes('COMPLETED'), 'no COMPLETED in human gate mode');

  const persisted = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(persisted.state, 'SESSION_ACTIVE');
});

// ============================================================================
// E. Fail-closed: unparseable verdict
// ============================================================================

test('E1. unparseable final-review text fails closed with FINAL_REVIEW/VERDICT_* , no delivery', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const execPath = mkExecRecord(stateDir, id);
  const calls = [];
  const deps = baseDeps(calls, execPath);
  deps.finalReview = () => ({ ok: true, value: { text: 'I could not decide anything.' } });
  deps.delivery = () => { throw new Error('delivery must NOT run on parse failure'); };

  const res = await runSocControlLoop({
    repo: REPO, issueNumber: ISSUE, stateDir, humanGate: true, deps,
  });

  assert.equal(res.ok, false, JSON.stringify(res));
  assert.match(String(res.code), /FINAL_REVIEW_FAILED|VERDICT_/);
  const persisted = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(persisted.state, 'SESSION_ACTIVE');
  const ledger = readTransitions({ stateDir, identityHash: id });
  const last = ledger[ledger.length - 1];
  assert.equal(last.to, 'BLOCKED', 'unparseable verdict fails closed to BLOCKED');
  const tos = ledger.map((r) => r.to);
  assert.ok(!tos.includes('DELIVERING'), 'no delivery on parse failure');
  assert.ok(!tos.includes('COMPLETED'), 'no COMPLETED on parse failure');
});

// ============================================================================
// F. Arg validation fail-closed
// ============================================================================

test('F1. missing session / invalid args fail closed', async () => {
  const stateDir = mkStateDir();
  const r1 = await runSocControlLoop({ repo: '', issueNumber: 1, stateDir, deps: {} });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'ARGS_INVALID');

  const r2 = await runSocControlLoop({ repo: REPO, issueNumber: 0, stateDir, deps: {} });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'ARGS_INVALID');

  const r3 = await runSocControlLoop({ repo: REPO, issueNumber: 123456, stateDir, deps: {} });
  assert.equal(r3.ok, false);
  assert.equal(r3.code, 'SESSION_NOT_FOUND');
});

test('F2. HUMAN_GATE_DELIVERY_CODE is exported and stable', () => {
  assert.equal(HUMAN_GATE_DELIVERY_CODE, 'HUMAN_GATE_AWAITING_MERGE');
});

// ============================================================================
// G. CLI --instruction-file flag (parse + fail-closed)
// ============================================================================

test('G1. parseArgs extracts --instruction-file / -f and loadInstructionFile parses sample markdown', () => {
  // Flag parsing: long form and -f alias.
  const long = parseArgs(['--repo', 'o/n', '--issue', '42', '--instruction-file', '/tmp/prompt.md']);
  assert.equal(long.instructionFile, '/tmp/prompt.md');
  const alias = parseArgs(['-f', '/tmp/prompt.md']);
  assert.equal(alias.instructionFile, '/tmp/prompt.md');
  const absent = parseArgs(['--repo', 'o/n', '--issue', '42']);
  assert.equal(absent.instructionFile, null);

  // Sample markdown: heading-derived goal + full content as instruction.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-inst-'));
  const file = path.join(dir, 'task-prompt.md');
  const content = [
    '# Surgical Task Prompt',
    '',
    '## Explicit Whitelist',
    '- `bin/soc-control-loop.mjs`',
    '- `.opencode/agents/soc_control.md`',
    '',
    'Long multi-line body that must not be shell-escaped.',
    '',
  ].join('\n');
  fs.writeFileSync(file, content, 'utf8');

  const r = loadInstructionFile(file);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.goal, 'Surgical Task Prompt', 'goal derived from first markdown heading');
  assert.equal(r.value.instruction, content, 'full UTF-8 file content carried as instruction');
});

test('G2. missing --instruction-file path fails closed: exit 1 + INSTRUCTION_FILE_NOT_FOUND', () => {
  const missing = path.join(os.tmpdir(), `soc-no-such-${Date.now()}.md`);
  assert.ok(!fs.existsSync(missing), 'fixture path must not exist');

  // Alias form exercises the same ingestion path as --instruction-file.
  const r = spawnSync(
    process.execPath,
    [
      path.join(PROJECT_ROOT, 'bin', 'soc-control-loop.mjs'),
      '--repo', 'duongpdddic-droid/soc_brain',
      '--issue', '42',
      '-f', missing,
      '--state-dir', fs.mkdtempSync(path.join(os.tmpdir(), 'soc-state-')),
    ],
    { encoding: 'utf8', timeout: 30000, windowsHide: true },
  );

  assert.equal(r.status, 1, `expected exit 1, got ${r.status}; stderr=${r.stderr}`);
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /INSTRUCTION_FILE_NOT_FOUND/, `missing error code in: ${out}`);
  // Fail-closed before any session/loop work: no SESSION_NOT_FOUND noise.
  assert.doesNotMatch(out, /SESSION_NOT_FOUND/);
});

// ============================================================================
// H. Task Bootstrapper intake (--bootstrap) — offline mock spawn, fail-closed
// ============================================================================

test('H1. parseArgs extracts --bootstrap / --no-bootstrap', () => {
  const on = parseArgs(['--repo', 'o/n', '--issue', '42', '--bootstrap']);
  assert.equal(on.bootstrap, true);
  const off = parseArgs(['--repo', 'o/n', '--issue', '42', '--no-bootstrap']);
  assert.equal(off.bootstrap, false);
  const absent = parseArgs(['--repo', 'o/n', '--issue', '42']);
  assert.equal(absent.bootstrap, false, 'bootstrap is opt-in (default false)');
});

test('H2. buildBootstrapperArgs emits safe PowerShell flags + Goal', () => {
  const r = buildBootstrapperArgs({ goal: 'Integrate Bootstrapper', scriptPath: 'C:/repo/scripts/Invoke-SocTask.ps1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const args = r.value.args;
  // Required safe flags in order at the head of argv.
  assert.deepEqual(args.slice(0, PS_SAFE_FLAGS.length), [...PS_SAFE_FLAGS]);
  assert.ok(args.includes('-File'));
  assert.ok(args.includes('-NoProfile'));
  assert.ok(args.includes('-NonInteractive'));
  assert.ok(args.includes('-ExecutionPolicy'));
  assert.ok(args.includes('Bypass'));
  assert.ok(args.includes('-Goal'));
  assert.ok(args.includes('Integrate Bootstrapper'));
  assert.ok(args.includes('C:/repo/scripts/Invoke-SocTask.ps1'));

  const bad = buildBootstrapperArgs({ goal: '', scriptPath: 'x.ps1' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'BOOTSTRAP_GOAL_REQUIRED');
});

test('H3. parseBootstrapOutput extracts pr/branch/worktree; unparsable fails closed', () => {
  const good = parseBootstrapOutput(bootstrapOkStdout());
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(good.value.prNumber, 229);
  assert.equal(good.value.branch, 'task/integrate-bootstrapper-20260924-075429');
  assert.match(good.value.worktreePath, /integrate-bootstrapper-20260924-075429/);
  assert.equal(good.value.goal, 'Integrate Bootstrapper');
  assert.match(good.value.prUrl, /\/pull\/229$/);

  const empty = parseBootstrapOutput('');
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'BOOTSTRAP_OUTPUT_UNPARSEABLE');

  const noMarker = parseBootstrapOutput('branch=x\npr=1 url=u\nworktree=w\n');
  assert.equal(noMarker.ok, false);
  assert.equal(noMarker.code, 'BOOTSTRAP_OUTPUT_UNPARSEABLE');

  const partial = parseBootstrapOutput('BOOTSTRAP_OK goal=g\nbranch=b\n');
  assert.equal(partial.ok, false);
  assert.equal(partial.code, 'BOOTSTRAP_OUTPUT_UNPARSEABLE');
});

test('H4. classifyBootstrapFailure maps dirty-tree / network / exit codes', () => {
  const dirty = classifyBootstrapFailure({ exitCode: 1, stderr: 'BOOTSTRAP_FAILED: PRIMARY_DIRTY: stash/commit first' });
  assert.equal(dirty.code, 'BOOTSTRAP_PRIMARY_DIRTY');
  assert.equal(dirty.classifiedAs, 'DIRTY_WORKING_TREE');

  const net = classifyBootstrapFailure({ exitCode: 1, stderr: 'COMMAND_FAILED exit=1: gh pr create\nnetwork timeout' });
  assert.equal(net.code, 'BOOTSTRAP_STEP_FAILED');
  assert.equal(net.classifiedAs, 'TRANSPORT_FAILURE');

  const badArgs = classifyBootstrapFailure({ exitCode: 2, stderr: 'BOOTSTRAP_FAILED: GOAL_REQUIRED' });
  assert.equal(badArgs.code, 'BOOTSTRAP_BAD_ARGS');

  // Unknown non-zero exit, no recognizable marker → generic nonzero code.
  const generic = classifyBootstrapFailure({ exitCode: 1, stderr: 'something exploded' });
  assert.equal(generic.code, 'BOOTSTRAP_EXIT_NONZERO');

  // Explicit BOOTSTRAP_FAILED marker maps to BOOTSTRAP_FAILED.
  const marked = classifyBootstrapFailure({ exitCode: 1, stderr: 'BOOTSTRAP_FAILED: workspace lock held' });
  assert.equal(marked.code, 'BOOTSTRAP_FAILED');

  const spawnDie = classifyBootstrapFailure({ exitCode: null, signal: 'SIGKILL', stderr: '' });
  assert.equal(spawnDie.code, 'BOOTSTRAP_SPAWN_ERROR');
});

test('H5. E2E --bootstrap: control loop auto-invokes bootstrapper, assigns PR/branch/worktree to session, then runs FSM', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const execPath = mkExecRecord(stateDir, id);
  const calls = [];
  const deps = baseDeps(calls, execPath);
  const spawnCalls = [];
  deps.spawnBootstrapper = (cmd, args) => {
    spawnCalls.push({ cmd, args });
    return Promise.resolve({
      status: 0, signal: null, error: null,
      stdout: bootstrapOkStdout({ pr: 229, branch: 'task/e2e-boot-20260924-000001' }),
      stderr: '',
    });
  };
  deps.finalReview = () => {
    calls.push('finalReview');
    return { ok: true, value: { text: 'All offline gates pass.\nVERDICT: APPROVED' } };
  };
  deps.delivery = () => { throw new Error('delivery must NOT be invoked in humanGate mode'); };

  const res = await runSocControlLoop({
    repo: REPO, issueNumber: ISSUE, goal: 'Integrate Bootstrapper',
    stateDir, humanGate: true, bootstrap: true, deps,
  });

  // Bootstrapper was invoked exactly once with the safe flag set.
  assert.equal(spawnCalls.length, 1, `expected 1 spawn, got ${spawnCalls.length}`);
  const sc = spawnCalls[0];
  assert.ok(sc.args.includes('-NoProfile') && sc.args.includes('-NonInteractive')
    && sc.args.includes('-ExecutionPolicy') && sc.args.includes('Bypass') && sc.args.includes('-File'),
    `safe PowerShell flags missing: ${JSON.stringify(sc.args)}`);
  assert.ok(sc.args.includes('-Goal') && sc.args.includes('Integrate Bootstrapper'));

  // Session lease now carries PR/branch/worktree from BOOTSTRAP_OK — no manual init.
  const persisted = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(persisted.prNumber, 229, 'session.prNumber assigned from bootstrapper');
  assert.equal(persisted.branch, 'task/e2e-boot-20260924-000001', 'session.branch assigned from bootstrapper');
  assert.match(persisted.worktreePath, /integrate-bootstrapper-20260924-075429/, 'session.worktreePath assigned');
  assert.ok(persisted.controlLoop && persisted.controlLoop.bootstrapper, 'bootstrapper evidence recorded on session');
  assert.equal(persisted.controlLoop.bootstrapper.prNumber, 229);

  // FSM still runs to Human Gate after successful ingestion.
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'DELIVERING');
  assert.equal(res.value.awaitingHumanGate, true);
  assert.ok(calls.includes('executor:initial'), 'FSM executed after ingestion');
});

test('H6. --bootstrap fail-closed: bootstrapper exit != 0 stops intake, no FSM, structured code', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const before = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  const calls = [];
  const deps = baseDeps(calls, path.join(stateDir, 'exec', `${id}.json`));
  deps.spawnBootstrapper = () => Promise.resolve({
    status: 1, signal: null, error: null, stdout: '',
    stderr: 'BOOTSTRAP_FAILED: PRIMARY_DIRTY: stash/commit first, bootstrapper will not switch a dirty checkout',
  });
  deps.finalReview = () => { throw new Error('finalReview must NOT run on failed ingestion'); };

  const res = await runSocControlLoop({
    repo: REPO, issueNumber: ISSUE, goal: 'Integrate Bootstrapper',
    stateDir, humanGate: true, bootstrap: true, deps,
  });

  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'BOOTSTRAP_PRIMARY_DIRTY');
  assert.match(String(res.detail.classifiedAs || ''), /DIRTY_WORKING_TREE/);

  // Session untouched — fail-closed before any assignment or FSM work.
  const after = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(after.prNumber, before.prNumber, 'session.prNumber must not change on failure');
  assert.equal(after.branch, before.branch, 'session.branch must not change on failure');
  assert.deepEqual(calls, [], 'no router/executor/verifier on failed ingestion');

  // Structured failure log written under stateDir/logs/task-ingestion.jsonl.
  const logPath = path.join(stateDir, 'logs', 'task-ingestion.jsonl');
  assert.ok(fs.existsSync(logPath), 'structured ingestion log must exist');
  const entries = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const failEntry = entries.find((e) => e.event === 'TASK_INGESTION_FAILED' && e.code === 'BOOTSTRAP_PRIMARY_DIRTY');
  assert.ok(failEntry, `missing structured fail entry: ${JSON.stringify(entries)}`);
  assert.equal(failEntry.phase, 'run');
});

test('H7. --bootstrap without --goal fails closed BOOTSTRAP_GOAL_REQUIRED', async () => {
  const stateDir = mkStateDir();
  mkSession(stateDir);
  const calls = [];
  const deps = baseDeps(calls, path.join(stateDir, 'x.json'));
  deps.spawnBootstrapper = () => { throw new Error('spawn must NOT be called without a goal'); };

  const res = await runSocControlLoop({
    repo: REPO, issueNumber: ISSUE, goal: null,
    stateDir, humanGate: true, bootstrap: true, deps,
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'BOOTSTRAP_GOAL_REQUIRED');
  assert.deepEqual(calls, []);
});

test('H8. ingestGoalViaBootstrapper: unparsable success stdout fails closed, no session write', async () => {
  const stateDir = mkStateDir();
  const { sessionPath } = mkSession(stateDir);
  const before = fs.readFileSync(sessionPath, 'utf8');

  const r = await ingestGoalViaBootstrapper({
    goal: 'Integrate Bootstrapper',
    issueNumber: ISSUE,
    sessionPath,
    stateDir,
    spawnImpl: () => Promise.resolve({
      status: 0, signal: null, error: null,
      stdout: 'partial garbage without BOOTSTRAP_OK marker', stderr: '',
    }),
  });

  assert.equal(r.ok, false);
  assert.equal(r.code, 'BOOTSTRAP_OUTPUT_UNPARSEABLE');
  assert.equal(fs.readFileSync(sessionPath, 'utf8'), before, 'session must be byte-identical after failed parse');
});

test('H9. assignBootstrapToSession: missing session fails closed SESSION_NOT_FOUND', () => {
  const stateDir = mkStateDir();
  const missing = path.join(stateDir, 'sessions', 'deadbeef.json');
  const r = assignBootstrapToSession({
    sessionPath: missing,
    bootstrap: { prNumber: 1, branch: 'task/x', worktreePath: '/tmp/x' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SESSION_NOT_FOUND');
});
