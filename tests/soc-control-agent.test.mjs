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
  countCommitsAheadOfBase,
  resolveRunnerInstruction,
} from '../bin/soc-control-loop.mjs';
import { readTransitions } from '../packages/control-loop/control-loop.mjs';
import { withOcrInternalReview } from './fixtures/ocr-internal-review.mjs';
import { dispatchPathFor, readDispatchRecords } from '../packages/telegram-dispatch/telegram-dispatch.mjs';
import { identityHash, worktreePathFor, worktreeBranchFor, bindingPathFor } from '../packages/workspace/workspace.mjs';
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

test('runner instruction points at the active runtime contract', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-instruction-contract-'));
  try {
    fs.writeFileSync(path.join(dir, 'SOC_TASK_CONTRACT.md'), '# stale repository task\n');
    fs.mkdirSync(path.join(dir, '.soc'));
    fs.writeFileSync(path.join(dir, '.soc', 'task-contract.md'), '# active runtime task\n');
    const instruction = resolveRunnerInstruction({ goal: 'active task', session: { worktreePath: dir } });
    assert.match(instruction.replaceAll('\\', '/'), /\.soc\/task-contract\.md/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- Minimal frontmatter parser (flat YAML only) -----------------------------
// Keys may be single- or double-quoted (OpenCode permission keys such as '*' and
// 'soc-brain-gateway_gateway' are quoted in canonical YAML); the quotes are
// stripped from the returned key name.
const KEY_RE = /^(['"]?)([A-Za-z0-9_.*-]+)\1:\s*(.*)$/;
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
      const kv = KEY_RE.exec(trimmed);
      if (kv && kv[3] === '') {
        fm[kv[2]] = {};
        permKey = kv[2];
      } else if (kv) {
        fm[kv[2]] = kv[3].replace(/^["']|["']$/g, '');
        permKey = null;
      }
    } else if (permKey && fm[permKey] && typeof fm[permKey] === 'object') {
      const kv = KEY_RE.exec(trimmed);
      if (kv) fm[permKey][kv[2]] = kv[3].replace(/^["']|["']$/g, '');
    }
  }
  return { frontmatter: fm, body: raw.slice(m[0].length) };
}

// ---- Fixture helpers ---------------------------------------------------------
function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'soc-ctrl-')); }

// Canonical session fixture (§A.1): every field the admission read-back
// validates is present AND agrees with the on-disk binding record. The worktree
// itself is deliberately NOT created — validateCanonicalSession only re-reads
// Git state once the worktree exists (verifyGit: 'auto').
function mkSession(stateDir, overrides = {}) {
  const id = identityHash({ repo: REPO, issueNumber: ISSUE });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  const worktreesRoot = stateDir;
  const bindingPath = bindingPathFor({ worktreesRoot, identityHash: id });
  const worktreePath = overrides.worktreePath || worktreePathFor({ worktreesRoot, identityHash: id });
  const branch = overrides.branch || worktreeBranchFor({ identityHash: id });
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1',
    state: 'SESSION_ACTIVE',
    lifecycle: [],
    taskId: `${REPO}#${ISSUE}`,
    repo: REPO,
    issueNumber: ISSUE,
    identityHash: id,
    headSha: HEAD,
    baseSha: BASE,
    branch,
    worktreePath,
    worktreesRoot,
    lease: { token: `lease-${id}` },
    controlPlane: { stateDir, sessionPath, bindingPath, worktreesRoot },
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  // Binding record MUST agree with the session on the canonical identity fields.
  fs.mkdirSync(path.dirname(bindingPath), { recursive: true });
  fs.writeFileSync(bindingPath, JSON.stringify({
    schemaVersion: '1.0',
    taskId: session.taskId,
    repo: REPO,
    issueNumber: ISSUE,
    baseSha: session.baseSha,
    branch: session.branch,
    // `remote` is part of verifyBinding's field map; it is only read back when
    // the worktree exists on disk (provenanced-workspace fixtures below).
    remote: REPO,
    path: session.worktreePath,
    identityHash: id,
  }, null, 2), 'utf8');
  return { sessionPath, session, id, worktreesRoot, bindingPath, branch, worktreePath };
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
    pushExec: undefined, // offline agent fixtures do not own a git worktree
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: (ctx) => {
      calls.push(ctx.reworkInstruction ? 'executor:rework' : 'executor:initial');
      return { ok: true, value: { executionStatus: 'EXITED', terminalStatus: 'ok', exitCode: 0, executionRecordPath: execPath } };
    },
    verifier: withOcrInternalReview(() => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; }),
    preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    telegramSpawn: () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 900 })}\n` }),
  };
}

test('publish-enabled CLI defers bootstrap PR creation and reviews the freshly bound head', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id, branch } = mkSession(stateDir);
  const execPath = mkExecRecord(stateDir, id);
  const committed = 'b'.repeat(40);
  const calls = [];
  const deps = baseDeps(calls, execPath);
  let remote = null;
  deps.execGit = () => '1\n'; // pre-existing commit on resume must not invoke bootstrap publication
  deps.spawnBootstrapper = () => { throw new Error('PR publication belongs to the canonical post-executor chain'); };
  deps.pushExec = (a0, opts) => {
    const a = Array.isArray(a0) ? a0 : opts.args;
    if (a[0] === 'rev-parse') return { status: 0, stdout: `${committed}\n` };
    if (a[0] === 'merge-base' || a[0] === 'status') return { status: 0, stdout: '' };
    if (a[0] === 'diff') return { status: a.includes('--quiet') ? 1 : 0, stdout: 'diff --git a/smoke.md b/smoke.md\n+verified lifecycle\n' };
    if (a[0] === 'ls-remote') return { status: 0, stdout: remote ? `${remote}\trefs/heads/${branch}\n` : '' };
    if (a[0] === 'push') { remote = a[2].split(':')[0]; return { status: 0, stdout: '' }; }
    return { status: 1, stderr: `unhandled git ${a}` };
  };
  deps.gh = (a) => {
    if (a[0] === 'pr' && a[1] === 'list') return { code: 0, stdout: '[]' };
    if (a[0] === 'pr' && a[1] === 'create') return { code: 0, stdout: `https://github.com/${REPO}/pull/80` };
    if (a[0] === 'pr' && a[1] === 'view') return { code: 0, stdout: JSON.stringify({ number: 80, state: 'OPEN', headRefOid: remote, headRefName: branch, baseRefName: 'main', headRepository: { nameWithOwner: REPO }, url: `https://github.com/${REPO}/pull/80`, body: `Closes #${ISSUE}\n\n<!-- soc-brain:identity=${id} -->` }) };
    return { code: 1, stderr: 'no issue fixture' };
  };
  let reviewed;
  deps.finalReview = (ctx) => { reviewed = ctx.session; return { ok: true, value: { text: 'VERDICT: APPROVED' } }; };
  const res = await runSocControlLoop({ repo: REPO, issueNumber: ISSUE, goal: 'publish committed task', stateDir, bootstrap: true, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(reviewed.prNumber, 80);
  assert.equal(reviewed.headSha, committed);
  assert.equal(res.value.decision.binding.headSha, committed);
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).controlLoop.prBinding.identityHash, id);
});

// ---- Review-boundary seam: prompt-build failure vs. transport delivery ------
// deps.createReviewTransport is a test seam ONLY (bin/soc-control-loop.mjs):
// it lets these tests prove (A) a prompt-build failure never reaches a
// transport, and (B) the prompt the transport receives carries the diff and
// the exact reviewed-HEAD binding. Both run fully offline on the publish-chain
// fixture above (PR 80 bound, session.headSha a real 40-hex commit).

function publishChainFixture(stateDir) {
  const { sessionPath, id, branch } = mkSession(stateDir);
  const execPath = mkExecRecord(stateDir, id);
  const committed = 'b'.repeat(40);
  const calls = [];
  const deps = baseDeps(calls, execPath);
  let remote = null;
  deps.spawnBootstrapper = () => { throw new Error('PR publication belongs to the canonical post-executor chain'); };
  deps.pushExec = (a0, opts) => {
    const a = Array.isArray(a0) ? a0 : opts.args;
    if (a[0] === 'rev-parse') return { status: 0, stdout: `${committed}\n` };
    if (a[0] === 'merge-base' || a[0] === 'status') return { status: 0, stdout: '' };
    if (a[0] === 'diff') return { status: a.includes('--quiet') ? 1 : 0, stdout: 'diff --git a/smoke.md b/smoke.md\n+verified lifecycle\n' };
    if (a[0] === 'ls-remote') return { status: 0, stdout: remote ? `${remote}\trefs/heads/${branch}\n` : '' };
    if (a[0] === 'push') { remote = a[2].split(':')[0]; return { status: 0, stdout: '' }; }
    return { status: 1, stderr: `unhandled git ${a}` };
  };
  deps.gh = (a) => {
    if (a[0] === 'pr' && a[1] === 'list') return { code: 0, stdout: '[]' };
    if (a[0] === 'pr' && a[1] === 'create') return { code: 0, stdout: `https://github.com/${REPO}/pull/80` };
    if (a[0] === 'pr' && a[1] === 'view') return { code: 0, stdout: JSON.stringify({ number: 80, state: 'OPEN', headRefOid: remote, headRefName: branch, baseRefName: 'main', headRepository: { nameWithOwner: REPO }, url: `https://github.com/${REPO}/pull/80`, body: `Closes #${ISSUE}\n\n<!-- soc-brain:identity=${id} -->` }) };
    return { code: 1, stderr: 'no issue fixture' };
  };
  return { sessionPath, id, branch, deps, calls, committed };
}

test('review boundary: prompt-build failure (EMPTY_DIFF_CONTENT) never reaches a transport', async () => {
  const stateDir = mkStateDir();
  const { deps } = publishChainFixture(stateDir);
  // The boundary calls (deps.execGit || execFileSync)('git', ['-C', wt, 'diff',
  // '<base>..<head>'], ...) — an empty diff trips the fail-closed prompt build.
  deps.execGit = (cmd, argv) => {
    const a = Array.isArray(argv) ? argv : [];
    if (a[0] === 'rev-list') return '1\n';
    if (a[0] === 'diff') return '';
    return '';
  };
  // deps.finalReview deliberately NOT set: the real prompt/diff boundary runs.
  let transportCalls = 0;
  deps.createReviewTransport = () => async () => {
    transportCalls += 1;
    return { ok: true, value: { text: 'VERDICT: APPROVED' } };
  };

  const res = await runSocControlLoop({ repo: REPO, issueNumber: ISSUE, goal: 'boundary', stateDir, bootstrap: true, deps });

  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'EMPTY_DIFF_CONTENT');
  assert.equal(transportCalls, 0, 'transport must never be called with a null/empty prompt');
  assert.equal(typeof res.detail, 'string');
  assert.ok(res.detail.length > 0, 'the specific fail-closed reason is returned at the boundary');
});

test('review boundary: the prompt carries the diff and the reviewed-HEAD binding', async () => {
  const stateDir = mkStateDir();
  const { deps } = publishChainFixture(stateDir);
  deps.execGit = (cmd, argv) => {
    const a = Array.isArray(argv) ? argv : [];
    if (a[0] === 'rev-list') return '1\n';
    if (a.includes('diff')) return 'diff --git a/alpha.md b/alpha.md\n+ALPHA_MARKER_42\n';
    return '';
  };
  let seen = null;
  deps.createReviewTransport = async () => {
    const { createGeminiWeb2ApiReviewTransport } = await import('../packages/control-loop/gemini-plus-web2api-copy.mjs');
    return createGeminiWeb2ApiReviewTransport({ rawTransport: async (ctx) => {
    seen = ctx;
    const { binding, requestId, attemptId, requestDigest } = ctx.reviewRequest;
    const text = `REVIEW_PAYLOAD_BEGIN\n${JSON.stringify({ binding, requestId, attemptId, requestDigest, findings: [], remediation: [], evidenceRequests: [], confidence: 1 })}\nREVIEW_PAYLOAD_END\nVERDICT: APPROVED`;
    return { ok: true, text, rawText: text, newTurnId: 'r-review', targetId: 'target-review', conversationId: 'conversation-review', beforeTurnIds: [], afterTurnIds: ['r-review'] };
    } });
  };

  const res = await runSocControlLoop({ repo: REPO, issueNumber: ISSUE, goal: 'boundary', stateDir, bootstrap: true, deps });

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(seen !== null, 'the seam transport must be reached with a built prompt');
  assert.equal(typeof seen.prompt, 'string');
  assert.ok(seen.prompt.length > 0);
  assert.ok(seen.prompt.includes('ALPHA_MARKER_42'), 'prompt must embed the diff content');
  assert.ok(seen.diff.includes('ALPHA_MARKER_42'), 'the raw diff must accompany the prompt');
  assert.ok(seen.prompt.includes(seen.session.headSha), 'prompt must bind the reviewed HEAD');
  assert.match(seen.session.headSha, /[0-9a-f]{40}/);
  assert.ok(seen.prompt.includes(String(seen.session.prNumber)), 'prompt must carry the bound PR number');
  assert.equal(seen.session.repo, REPO);
  assert.equal(seen.session.issueNumber, ISSUE);
});

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

test('A2. permissions: default-deny "*" then a single gateway allow', () => {
  const raw = fs.readFileSync(AGENT_PATH, 'utf8');
  const { frontmatter: fm } = parseFrontmatter(raw);
  assert.ok(fm.permission && typeof fm.permission === 'object', 'permission block required');
  // P0 rework: DEFAULT-DENY. `'*'` is the OpenCode wildcard every unspecified
  // tool key (built-in AND MCP) resolves through -> deny.
  assert.equal(fm.permission['*'], 'deny', 'wildcard must default-deny every tool for soc_control');
  // Only the gateway tool is allowed, and only as an explicit key AFTER the
  // wildcard (explicit key beats the wildcard in OpenCode 1.18.x).
  assert.match(raw, /'soc-brain-gateway_gateway':\s*allow/, 'gateway tool must be allowed for soc_control');
  // Nothing else may be granted: no per-tool allow can exist next to the
  // wildcard, and the old `mcp: deny` misconception is gone (mcp is NOT the
  // "deny all MCP tools" switch — the wildcard is).
  const permBlock = /^permission:\r?\n((?:[ \t]+.*\r?\n)+)/m.exec(raw);
  assert.ok(permBlock, 'permission block must be a nested YAML map');
  const keys = [...permBlock[1].matchAll(/^\s+['"]?([^'":\s]+)['"]?:/gm)].map((m) => m[1]);
  assert.deepEqual(keys, ['*', 'soc-brain-gateway_gateway'], `permission keys must be exactly wildcard-then-gateway, got ${JSON.stringify(keys)}`);
  assert.ok(!keys.includes('mcp'), 'mcp must not be used as the deny-all switch');
  for (const k of ['bash', 'read', 'glob', 'grep', 'edit', 'task', 'webfetch', 'websearch', 'list', 'skill']) {
    assert.ok(!keys.includes(k), `${k} must not be granted individually`);
  }
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

// P0 rework Req 2 — no fake issue identity: a goal without a real issue is
// submitted goal-only with ONE stable clientRequestId that is reused on retry.
test('A4. body: no fake issueNumber; goal-only submit reuses one stable clientRequestId', () => {
  const raw = fs.readFileSync(AGENT_PATH, 'utf8');
  const { body } = parseFrontmatter(raw);
  assert.doesNotMatch(body, /issue_number_or_dummy|or_dummy|<issue_number/i,
    'the dummy issueNumber placeholder must be removed from the instruction');
  assert.doesNotMatch(body, /"issueNumber":\s*</,
    'the example payload must not fabricate an issue number');
  assert.match(body, /OMIT `?issueNumber`?/i,
    'the instruction must say to omit issueNumber when there is no real issue');
  assert.match(body, /clientRequestId/, 'the instruction must document clientRequestId');
  assert.match(body, /ONCE per goal/i, 'the id must be generated once per goal');
  assert.match(body, /REUSE/i, 'a retry must reuse the same clientRequestId');
  assert.match(body, /reconciles to the same canonical task|instead of minting a second/i,
    'reuse must be tied to reconciling to one canonical task');

  // The example payload itself must be honest: submit + stable id, no issueNumber.
  const m = /```json\r?\n([\s\S]*?)```/.exec(body);
  assert.ok(m, 'the instruction must show an example submit payload');
  const payload = JSON.parse(m[1]);
  assert.equal(payload.operation, 'submit');
  assert.ok(!('issueNumber' in payload), 'example payload must not carry an issueNumber');
  assert.equal(typeof payload.clientRequestId, 'string');
  assert.ok(payload.clientRequestId.length >= 8, 'clientRequestId must be >= 8 chars');
  assert.equal(payload.localCheckoutPath, 'C:/Users/Admin/Soc_brain');
});

// P0 rework Req 3 — the instruction may only assert what this surface can do:
// three gateway operations, honest execution vocabulary, and an explicit
// out-of-reach statement for Advisor/Final Review/Human Gate/lifecycle claims.
test('A5. body only claims capabilities this surface actually has', () => {
  const raw = fs.readFileSync(AGENT_PATH, 'utf8');
  const { body } = parseFrontmatter(raw);

  const forbidden = [
    [/dispatch the diagnostic context/i, 'Advisor consultation instruction'],
    [/via Web2API/i, 'Web2API invocation instruction'],
    // `\btelegramDispatch\b` does NOT match `\bTelegram\b`: after "telegram"
    // comes "D" (a word char), so there is no word boundary there — the
    // canonical field name stays allowed, while a standalone "Telegram"
    // (claiming the service/telemetry) is still forbidden. The message (the
    // 3rd tuple element) is unchanged.
    [/\bTelegram\b/i, 'Telegram telemetry instruction'],
    [/transition to\s+`?BLOCKED/i, 'lifecycle terminalization instruction'],
    [/readTransitions/i, 'ledger read outside the gateway'],
    [/Report the final review verdict/i, 'final review verdict reporting'],
    [/await explicit human merge authorization/i, 'merge authorization handling'],
    [/Emit completion telemetry/i, 'completion telemetry emission'],
  ];
  for (const [re, what] of forbidden) {
    assert.doesNotMatch(body, re, `the instruction must not contain a ${what}`);
  }

  // It must be explicit about what is NOT reachable from this surface.
  assert.match(body, /Exactly three operations exist/i, 'must enumerate submit/status/recover as the whole surface');
  assert.match(body, /no tool that reaches Web2API, the Advisor/i, 'must state that Advisor/Reviewer access is out of reach');
  assert.match(body, /Never state that you consulted the Advisor/i, 'must forbid claiming an Advisor consultation');
  assert.match(body, /cannot answer one/i, 'must forbid answering a Human Gate');
  assert.match(body, /cannot claim\s+any of them|no operation for review/i,
    'must state there is no review/advisor/merge operation');

  // Honest execution vocabulary the gateway actually returns.
  assert.match(body, /ADMITTED_ONLY/, 'must document the admitted-only answer');
  assert.match(body, /"EXECUTING"|EXECUTING/, 'must document the executing answer');
  assert.match(body, /ExecutionRecord/, 'must tie an execution claim to the canonical record');
  assert.match(body, /never as running/i, 'ADMITTED_ONLY must never be reported as running');
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

test('C2. a persisted EXECUTING exit edge and finalized record trigger one executor-stop notification', async () => {
  const stateDir = mkStateDir();
  const { id } = mkSession(stateDir);
  const execPath = mkExecRecord(stateDir, id);
  const record = JSON.parse(fs.readFileSync(execPath, 'utf8'));
  Object.assign(record, { finalized: true, pid: 1234, processStartTime: 'start-1234', startedAt: '2026-09-30T00:00:00Z' });
  fs.writeFileSync(execPath, JSON.stringify(record));
  const deps = baseDeps([], execPath);
  deps.finalReview = () => ({ ok: true, value: { text: 'Verified.\nVERDICT: APPROVED' } });
  deps.telegramMilestones = true;
  deps.telegramSpawn = () => ({ status: 0, stdout: JSON.stringify({ status: 'API_ACCEPTED', messageId: 100 }) });
  const res = await runSocControlLoop({ repo: REPO, issueNumber: ISSUE, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  const transitions = readTransitions({ stateDir, identityHash: id });
  assert.ok(transitions.some((e) => e.from === 'EXECUTING' && e.to === 'VERIFYING'));
  const notices = readDispatchRecords(dispatchPathFor({ stateDir, identityHash: id }))
    .filter((e) => e.event === 'EXECUTOR_STOPPED' && e.status === 'API_ACCEPTED');
  assert.equal(notices.length, 1);
});

test('C3. executor failure produces a BLOCKED FSM alert without inventing a terminal ExecutionRecord', async () => {
  const stateDir = mkStateDir();
  const { id } = mkSession(stateDir);
  const deps = baseDeps([], path.join(stateDir, 'missing-execution.json'));
  deps.executor = () => ({ ok: false, code: 'EXECUTION_BUDGET_EXCEEDED' });
  deps.finalReview = () => { throw new Error('must not review after failed executor'); };
  deps.telegramMilestones = true;
  deps.telegramSpawn = () => ({ status: 0, stdout: JSON.stringify({ status: 'API_ACCEPTED', messageId: 101 }) });
  await runSocControlLoop({ repo: REPO, issueNumber: ISSUE, stateDir, deps });
  const transitions = readTransitions({ stateDir, identityHash: id });
  assert.ok(transitions.some((e) => e.from === 'EXECUTING' && e.to === 'BLOCKED'));
  const notices = readDispatchRecords(dispatchPathFor({ stateDir, identityHash: id }))
    .filter((e) => e.event === 'CONTROL_LOOP_BLOCKED' && e.status === 'API_ACCEPTED');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].eventKey.length, 64);
});

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
  const { sessionPath, id, branch, worktreePath } = mkSession(stateDir);
  const execPath = mkExecRecord(stateDir, id);
  const calls = [];
  const deps = baseDeps(calls, execPath);
  const spawnCalls = [];
  deps.spawnBootstrapper = (cmd, args) => {
    spawnCalls.push({ cmd, args });
    // The bootstrapper is TOLD the canonical workspace (§A.2) and echoes it back.
    return Promise.resolve({
      status: 0, signal: null, error: null,
      stdout: bootstrapOkStdout({ pr: 229, branch, worktree: worktreePath, contract: path.join(worktreePath, 'SOC_TASK_CONTRACT.md') }),
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
  // §A.2: the runner NAMES the canonical workspace instead of letting the
  // bootstrapper mint a second task/<slug> branch + worktree.
  const wtIdx = sc.args.indexOf('-WorktreesRoot');
  const brIdx = sc.args.indexOf('-BranchName');
  const wpIdx = sc.args.indexOf('-WorktreePath');
  assert.ok(wtIdx >= 0 && brIdx >= 0 && wpIdx >= 0,
    `-WorktreesRoot/-BranchName/-WorktreePath missing: ${JSON.stringify(sc.args)}`);
  assert.equal(sc.args[wtIdx + 1], stateDir, 'worktreesRoot is the canonical root');
  assert.equal(sc.args[brIdx + 1], branch, 'branchName is the canonical agent/<hash> branch');
  assert.equal(sc.args[wpIdx + 1], worktreePath, 'worktreePath is the canonical worktree');

  // Session lease now carries PR/branch/worktree from BOOTSTRAP_OK — no manual init.
  const persisted = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(persisted.prNumber, 229, 'session.prNumber assigned from bootstrapper');
  assert.equal(persisted.branch, branch, 'session.branch stays on the canonical branch');
  assert.equal(persisted.worktreePath, worktreePath, 'session.worktreePath stays canonical');
  assert.ok(persisted.controlLoop && persisted.controlLoop.bootstrapper, 'bootstrapper evidence recorded on session');
  assert.equal(persisted.controlLoop.bootstrapper.prNumber, 229);

  // FSM still runs to Human Gate after successful ingestion.
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'DELIVERING');
  assert.equal(res.value.awaitingHumanGate, true);
  assert.ok(calls.includes('executor:initial'), 'FSM executed after ingestion');
});

test('H5b. --bootstrap worktree drift: a bootstrapper answer for ANOTHER namespace fails closed', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const execPath = mkExecRecord(stateDir, id);
  const calls = [];
  const deps = baseDeps(calls, execPath);
  deps.spawnBootstrapper = () => Promise.resolve({
    status: 0, signal: null, error: null,
    // Legacy-shaped answer: task/<slug> branch on a DIFFERENT worktree.
    stdout: bootstrapOkStdout({ pr: 300, branch: 'task/other-20260927-000001', worktree: 'C:\\tmp\\other' }),
    stderr: '',
  });
  deps.finalReview = () => { throw new Error('finalReview must NOT run on drift'); };

  const res = await runSocControlLoop({
    repo: REPO, issueNumber: ISSUE, goal: 'Integrate Bootstrapper',
    stateDir, humanGate: true, bootstrap: true, deps,
  });

  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'BOOTSTRAP_WORKTREE_DRIFT');
  assert.deepEqual(calls, [], 'no router/executor on drift');

  // Session was NOT cross-assigned onto the foreign namespace.
  const persisted = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(persisted.prNumber, undefined, 'foreign prNumber must not stick');
  assert.notEqual(persisted.branch, 'task/other-20260927-000001');
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

// ---- Provenanced workspace fixture (real, offline git) -----------------------
// Reproduces the exact state a goal-only Gateway submit arrives in:
// soc.submit_goal -> taskStart() -> `git worktree add -b agent/<hash> <baseSha>`.
// The canonical branch therefore sits EXACTLY on the pinned base: zero commits
// ahead, nothing pushed - the state in which `gh pr create --base main --head
// <branch>` is refused by GitHub with
// "GraphQL: No commits between main and <branch>".
function mkProvisionedWorkspace(stateDir) {
  const id = identityHash({ repo: REPO, issueNumber: ISSUE });
  const branch = worktreeBranchFor({ identityHash: id });
  const worktreePath = worktreePathFor({ worktreesRoot: stateDir, identityHash: id });
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-ctrl-gitrepo-'));
  const git = (args, cwd = repoDir) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(' ')} -> exit ${r.status}: ${String(r.stderr || r.stdout || '')}`);
    }
    return String(r.stdout || '').trim();
  };
  git(['init']);
  git(['config', 'user.email', 'soc-test@example.invalid']);
  git(['config', 'user.name', 'soc-test']);
  fs.writeFileSync(path.join(repoDir, 'base.txt'), 'base\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-m', 'base']);
  const baseSha = git(['rev-parse', 'HEAD']);
  git(['remote', 'add', 'origin', 'https://github.com/duongpdddic-droid/Soc_brain.git']);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(['worktree', 'add', '-b', branch, worktreePath, baseSha]);

  const { sessionPath } = mkSession(stateDir, { baseSha, headSha: baseSha, branch, worktreePath });
  return {
    id, branch, worktreePath, baseSha, repoDir, sessionPath, git,
    addCommitOnBranch() {
      fs.writeFileSync(path.join(worktreePath, 'work.txt'), 'work\n', 'utf8');
      git(['add', '.'], worktreePath);
      git(['commit', '-m', 'work'], worktreePath);
    },
    cleanup() {
      try {
        spawnSync('git', ['-C', repoDir, 'worktree', 'remove', '--force', worktreePath], { windowsHide: true });
      } catch { /* best effort */ }
      fs.rmSync(worktreePath, { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

// The stderr below is the verbatim failure captured from the live Gateway
// smoke (identity a3c65484186f92d9a87684ef29d460aa, result
// <stateDir>/client-mcp/routes/a3c65484….control-loop.json.result.json).
function ghRefusalStderr(branch) {
  return 'BOOTSTRAP_FAILED: COMMAND_FAILED exit=1: gh pr create --repo duongpdddic-droid/soc_brain'
    + ` --base main --head ${branch} --title t --body b`
    + `\npull request create failed: GraphQL: No commits between main and ${branch} (createPullRequest)`;
}

test('H10. --bootstrap on a provisioned workspace (0 commits ahead) must NOT be forced through the bootstrapper; the FSM still runs', async () => {
  const stateDir = mkStateDir();
  const fx = mkProvisionedWorkspace(stateDir);
  try {
    const execPath = mkExecRecord(stateDir, fx.id);
    const calls = [];
    const deps = baseDeps(calls, execPath);
    const spawnCalls = [];
    deps.spawnBootstrapper = (_cmd, args) => {
      spawnCalls.push(args);
      return Promise.resolve({ status: 1, signal: null, error: null, stdout: '', stderr: ghRefusalStderr(fx.branch) });
    };
    deps.finalReview = () => {
      calls.push('finalReview');
      return { ok: true, value: { text: 'All offline gates pass.\nVERDICT: APPROVED' } };
    };

    const res = await runSocControlLoop({
      repo: REPO, issueNumber: ISSUE, goal: 'Gateway goal-only submit',
      stateDir, humanGate: true, bootstrap: true, deps,
    });

    assert.equal(spawnCalls.length, 0,
      `bootstrapper must not be invoked while the branch carries no commit ahead of the base (doomed gh pr create): ${JSON.stringify(spawnCalls)}`);
    assert.ok(calls.includes('executor:initial'), `executor must be spawned by the FSM, calls=${JSON.stringify(calls)}`);
    const ledger = readTransitions({ stateDir, identityHash: fx.id });
    assert.ok(ledger.length > 0, 'FSM transitions must be recorded (defect: 0 transitions)');
    assert.equal(res.ok, true, JSON.stringify(res));

    // The skip is RECORDED, never silent.
    const logPath = path.join(stateDir, 'logs', 'task-ingestion.jsonl');
    assert.ok(fs.existsSync(logPath), 'structured ingestion log must exist for a state-gated skip');
    const entries = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(entries.some((e) => e.event === 'TASK_INGESTION_SKIPPED' && e.code === 'BOOTSTRAP_NO_COMMITS_AHEAD'),
      `missing skip entry: ${JSON.stringify(entries)}`);

    // No PR was invented: the session keeps its truthful null binding.
    const persisted = JSON.parse(fs.readFileSync(fx.sessionPath, 'utf8'));
    assert.equal(persisted.prNumber, undefined, 'no PR number may be invented when no PR could be created');
  } finally {
    fx.cleanup();
  }
});

test('H11. --bootstrap still runs when the canonical branch carries a commit ahead of the base', async () => {
  const stateDir = mkStateDir();
  const fx = mkProvisionedWorkspace(stateDir);
  try {
    fx.addCommitOnBranch();
    const execPath = mkExecRecord(stateDir, fx.id);
    const calls = [];
    const deps = baseDeps(calls, execPath);
    const spawnCalls = [];
    deps.spawnBootstrapper = (_cmd, args) => {
      spawnCalls.push(args);
      return Promise.resolve({
        status: 0, signal: null, error: null,
        stdout: bootstrapOkStdout({
          pr: 555, branch: fx.branch, worktree: fx.worktreePath,
          contract: path.join(fx.worktreePath, 'SOC_TASK_CONTRACT.md'),
        }),
        stderr: '',
      });
    };
    deps.finalReview = () => {
      calls.push('finalReview');
      return { ok: true, value: { text: 'All offline gates pass.\nVERDICT: APPROVED' } };
    };

    const res = await runSocControlLoop({
      repo: REPO, issueNumber: ISSUE, goal: 'Gateway goal-only submit',
      stateDir, humanGate: true, bootstrap: true, deps,
    });

    assert.equal(spawnCalls.length, 1, `bootstrapper must run once when the branch has a commit ahead: ${JSON.stringify(spawnCalls)}`);
    assert.ok(spawnCalls[0].includes('-WorktreePath'), 'the runner still names the canonical workspace (§A.2)');
    const persisted = JSON.parse(fs.readFileSync(fx.sessionPath, 'utf8'));
    assert.equal(persisted.prNumber, 555, 'session.prNumber assigned from bootstrapper');
    assert.equal(res.ok, true, JSON.stringify(res));
  } finally {
    fx.cleanup();
  }
});

test('H12. countCommitsAheadOfBase: proven 0/1 on a real worktree, null whenever unproven', () => {
  const stateDir = mkStateDir();
  const fx = mkProvisionedWorkspace(stateDir);
  try {
    const at = (session) => countCommitsAheadOfBase({ session });
    assert.equal(at({ worktreePath: fx.worktreePath, baseSha: fx.baseSha }), 0,
      'a taskStart()-provisioned branch sits exactly on the pinned base');
    fx.addCommitOnBranch();
    assert.equal(at({ worktreePath: fx.worktreePath, baseSha: fx.baseSha }), 1);
    assert.equal(at({ worktreePath: path.join(fx.repoDir, 'does-not-exist'), baseSha: fx.baseSha }), null,
      'unreadable worktree must stay UNPROVEN (previous behaviour: bootstrapper runs)');
    assert.equal(at({ worktreePath: fx.worktreePath, baseSha: 'not-a-sha' }), null);
    assert.equal(at({ worktreePath: null, baseSha: fx.baseSha }), null);
    assert.equal(at(null), null);
  } finally {
    fx.cleanup();
  }
});
