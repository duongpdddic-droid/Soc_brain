// tests/control-loop-publish.test.mjs — P0-G (Issue #83) pre-review publish
// chain: refreshCanonicalHead -> pushBranch -> PR bind -> packet projection.
// Deterministic in-memory git/gh; no network, no real worktree. The chain is
// gated on deps.pushExec (run.js injects null = real git), so these tests
// exercise the EXACT real-run path including the negative gates.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runControlLoop, readTransitions } from '../packages/control-loop/control-loop.mjs';
import { packetPathFor } from '../packages/control-loop/adapters.mjs';
import { pushBranch } from '../packages/control-loop/push.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { withOcrInternalReview, FIXTURE_CONTENT_DIGEST } from './fixtures/ocr-internal-review.mjs';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const BASE = 'f'.repeat(40);
const ISSUE = 83;
const BRANCH = 'soc/issue-83-publish';
const REPO = 'duongpdddic-droid/soc_brain';

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cl-pub-')); }

function mkSession(stateDir, overrides = {}) {
  const issue = overrides.issueNumber ?? ISSUE;
  const id = identityHash({ repo: REPO, issueNumber: issue });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1', state: 'SESSION_ACTIVE', lifecycle: [],
    taskId: `${REPO}#${issue}`, repo: REPO, issueNumber: issue,
    headSha: HEAD_A, baseSha: BASE, branch: BRANCH,
    worktreePath: path.join(stateDir, 'wt'), worktreesRoot: stateDir,
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, id, session };
}

// In-memory git: exactly the subcommands pushBranch + refreshCanonicalHead use.
// Normalizes BOTH transport shapes: execGit calls exec(argsArray, {cwd}) while
// pushBranch's run() calls exec('git', {args, cwd}).
function fakeGit({ head = HEAD_A, base = BASE } = {}) {
  const st = { head, base, remoteRef: null, pushes: 0 };
  const exec = (a0, opts) => {
    const a = (Array.isArray(a0) ? a0 : (opts && opts.args) || []).map(String);
    if (a[0] === 'rev-parse' && a[1] === 'HEAD') return { status: 0, stdout: `${st.head}\n`, stderr: '' };
    if (a[0] === 'status') return { status: 0, stdout: '', stderr: '' };
    if (a[0] === 'diff') return { status: st.head === st.base ? 0 : 1, stdout: '', stderr: '' };
    if (a[0] === 'ls-remote') return { status: 0, stdout: st.remoteRef ? `${st.remoteRef}\t${a[2]}\n` : '', stderr: '' };
    if (a[0] === 'push') { st.remoteRef = a[2].split(':')[0]; st.pushes += 1; return { status: 0, stdout: '', stderr: '' }; }
    if (a[0] === 'merge-base') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: `unmocked git: ${a.join(' ')}` };
  };
  return { st, exec };
}

// In-memory gh: the PR head auto-follows the remote branch (GitHub semantics).
// A PR exists only after `pr create` (no fabrication).
function fakeGh({ gitState, issue = ISSUE, branch = BRANCH, number = 80 }) {
  const calls = [];
  const st = { created: false };
  const j = (code, obj, stderr = '') => ({ code, stdout: obj === undefined ? '' : JSON.stringify(obj), stderr });
  function gh(args) {
    const a = args.map(String);
    calls.push(a.join(' '));
    if (a[0] === 'pr' && a[1] === 'view' && a[a.indexOf('--json') + 1].includes('baseRepository')) {
      return j(1, undefined, 'Unknown JSON field: baseRepository');
    }
    if (a[0] === 'pr' && a[1] === 'list') {
      return j(0, st.created ? [{ number, state: 'OPEN', headRefOid: gitState.remoteRef }] : []);
    }
    if (a[0] === 'pr' && a[1] === 'view') {
      if (!st.created) return j(1, undefined, 'no PR');
      return j(0, { number, state: 'OPEN', headRefOid: gitState.remoteRef, headRefName: branch, baseRefName: 'main', headRepository: { nameWithOwner: REPO }, url: `https://github.com/${REPO}/pull/${number}`, body: `Closes #${issue}\n\n<!-- soc-brain:identity=${identityHash({ repo: REPO, issueNumber: issue })} -->` });
    }
    if (a[0] === 'pr' && a[1] === 'create') {
      st.created = true;
      return { code: 0, stdout: `https://github.com/${REPO}/pull/${number}\n`, stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unmocked gh: ${a.join(' ')}` };
  }
  return { gh, calls, st };
}

function loopDeps({ git, fx, executor }) {
  return {
    pushExec: git.exec, // presence (not value) activates the publish chain
    // H1 seam: the fixture worktree is not a real repository — the handoff
    // freshness check still runs through the canonical content-binding port.
    internalReviewIo: { computeBinding: () => ({ ok: true, value: { headSha: git.st.head, contentDigest: FIXTURE_CONTENT_DIGEST } }) },
    gh: fx.gh,
    router: () => ({ ok: true, value: { executorKind: 'opencode', model: 'x' } }),
    executor,
    verifier: withOcrInternalReview(() => ({ ok: true, value: { verdict: 'PASS', report: 'ok' } })),
    preReview: () => ({ ok: true, value: { verdict: 'PASS', findings: [] } }),
    finalReview: () => ({ ok: true, value: { verdict: 'PASS', findings: [] } }),
    delivery: () => ({ ok: true, value: { shipped: true } }),
    telegramSpawn: () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 1 })}\n` }),
  };
}

const packetsIn = (stateDir) => {
  try { return fs.readdirSync(path.join(stateDir, 'review-ready')); } catch { return []; }
};

test('G1. publish chain: refresh -> push -> PR create/read-back -> packet -> reviewers pass', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const git = fakeGit({ head: HEAD_A }); // executor already committed head A
  const fx = fakeGh({ gitState: git.st });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: loopDeps({ git, fx, executor: () => ({ ok: true, value: { executionRecordPath: 'x' } }) }) });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  // Push evidence: the remote ref carries the EXACT local HEAD.
  assert.equal(git.st.remoteRef, HEAD_A);
  assert.equal(git.st.pushes, 1);
  // PR bound at the pushed head BEFORE reviewers ran: list -> create -> view.
  // Issue #83 (P0-G): packet projection enriches the review packet with the
  // canonical issue objective (issue view) — but ONLY at the post-verify
  // handoff projection now: the publish-chain projection defers (no OCR
  // internal-review record exists yet) and gathers nothing, so `issue view`
  // appears exactly once.
  assert.deepEqual(fx.calls, [
    `pr list --repo ${REPO} --head ${BRANCH} --state all --json number,state,headRefOid`,
    `pr create --repo ${REPO} --base main --head ${BRANCH} --title feat: canonical task delivery (#${ISSUE}) --body Closes #${ISSUE}\n\n<!-- soc-brain:identity=${ID} -->`,
    'pr view 80 --repo duongpdddic-droid/soc_brain --json state,number,headRefOid,headRefName,baseRefName,headRepository,url,body',
    `issue view ${ISSUE} --repo ${REPO} --json title,body`,
  ]);
  // Session carries the binding additively; admission head unchanged (no-op refresh).
  const s = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(s.prNumber, 80);
  assert.equal(s.headSha, HEAD_A);
  assert.equal(s.controlLoop.prHistory.length, 1);
  assert.deepEqual(s.controlLoop.prBinding, { prNumber: 80, repo: REPO, issueNumber: ISSUE, identityHash: ID, branch: BRANCH, baseBranch: 'main', headSha: HEAD_A, url: `https://github.com/${REPO}/pull/80` });
  // Canonical packet projected at the bound identity.
  const packets = packetsIn(stateDir);
  assert.equal(packets.length, 1);
  assert.match(packets[0], new RegExp(`_Issue-${ISSUE}_PR-80_${HEAD_A.slice(0, 7)}_review-ready\\.md$`));
});

test('G2. HEAD moving BACK to the admission base is refused before any mutation', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const git = fakeGit({ head: BASE }); // worktree HEAD reset back to base
  const fx = fakeGh({ gitState: git.st });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: loopDeps({ git, fx, executor: () => ({ ok: true, value: { executionRecordPath: 'x' } }) }) });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'HEAD_REFRESH_REFUSED_BASE');
  assert.equal(git.st.pushes, 0, 'no push on refused head');
  assert.equal(fx.calls.length, 0, 'no gh calls on refused head');
  assert.equal(packetsIn(stateDir).length, 0, 'no packet on refused head');
  const s = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(s.prNumber, undefined);
  assert.equal(s.state, 'SESSION_ACTIVE', 'no terminalization on refused head');
  const tos = readTransitions({ stateDir, identityHash: ID }).map((r) => r.to);
  assert.ok(tos.includes('VERIFYING'));
  assert.ok(!tos.includes('PRE_REVIEWING'), 'chain failure never reaches reviewers');
});

test('G3. HEAD without lineage from the admission base is refused', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const git = fakeGit({ head: HEAD_B });
  const baseExec = git.exec;
  git.exec = (args) => {
    const a = args.map(String);
    if (a[0] === 'merge-base') return { status: 1, stdout: '', stderr: '' }; // B not a descendant of base
    return baseExec(args);
  };
  const fx = fakeGh({ gitState: git.st });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: loopDeps({ git, fx, executor: () => ({ ok: true, value: { executionRecordPath: 'x' } }) }) });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'HEAD_REFRESH_REFUSED_LINEAGE');
  assert.equal(git.st.pushes, 0);
  assert.equal(fx.calls.length, 0);
  assert.equal(packetsIn(stateDir).length, 0);
});

test('G3b. PR read-back with foreign issue refuses binding before review', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const git = fakeGit();
  const fx = fakeGh({ gitState: git.st });
  const gh = fx.gh;
  fx.gh = (args) => {
    const out = gh(args);
    if (args[0] === 'pr' && args[1] === 'view' && out.code === 0) {
      const data = JSON.parse(out.stdout);
      data.body = 'Closes #999';
      return { ...out, stdout: JSON.stringify(data) };
    }
    return out;
  };
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: loopDeps({ git, fx, executor: () => ({ ok: true, value: { executionRecordPath: 'x' } }) }) });
  assert.equal(res.code, 'PR_BIND_IDENTITY_MISMATCH');
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).prNumber, undefined);
  assert.equal(readTransitions({ stateDir, identityHash: id }).some((r) => r.to === 'PRE_REVIEWING'), false);
});

test('G3c. failed PR creation resumes at VERIFYING and publishes once before review', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const git = fakeGit();
  const fx = fakeGh({ gitState: git.st });
  const gh = fx.gh;
  let failCreate = true;
  let attempts = 0;
  fx.gh = (args) => {
    if (args[0] === 'pr' && args[1] === 'create') {
      attempts += 1;
      if (failCreate) return { code: 1, stdout: '', stderr: 'temporary failure' };
    }
    return gh(args);
  };
  const deps = loopDeps({ git, fx, executor: () => ({ ok: true, value: { executionRecordPath: 'x' } }) });
  const first = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(first.code, 'PR_BIND_CREATE_FAILED');
  assert.equal(readTransitions({ stateDir, identityHash: id }).some((r) => r.to === 'PRE_REVIEWING'), false);
  failCreate = false;
  const second = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(git.st.pushes, 1);
  assert.equal(attempts, 2);
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).prNumber, 80);
});

test('G3d. zero commits reports a typed recoverable state and retry publishes the later commit', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir, { headSha: BASE });
  const git = fakeGit({ head: BASE });
  const fx = fakeGh({ gitState: git.st });
  const deps = loopDeps({ git, fx, executor: () => ({ ok: true, value: { executionRecordPath: 'x' } }) });
  const first = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(first.code, 'PUSH_NOTHING_TO_PUSH');
  assert.equal(first.detail.status, 'NO_COMMIT');
  assert.equal(first.detail.recoverable, true);
  assert.equal(first.detail.resumeState, 'VERIFYING');
  assert.equal(git.st.pushes, 0);
  assert.equal(fx.calls.length, 0);
  git.st.head = HEAD_A;
  const second = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(git.st.remoteRef, HEAD_A);
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).prNumber, 80);
});

test('G3e. existing branch PR is adopted without a second creation after restart', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const git = fakeGit();
  git.st.remoteRef = HEAD_A;
  const fx = fakeGh({ gitState: git.st });
  fx.st.created = true;
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: loopDeps({ git, fx, executor: () => ({ ok: true, value: { executionRecordPath: 'x' } }) }) });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(git.st.pushes, 0);
  assert.equal(fx.calls.some((c) => c.startsWith('pr create')), false);
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).prNumber, 80);
});

test('G3f. independent issues keep separate PR bindings in one state directory', async () => {
  const stateDir = mkStateDir();
  const first = mkSession(stateDir);
  const second = mkSession(stateDir, { issueNumber: 84, branch: 'soc/issue-84-publish' });
  const gitA = fakeGit();
  const gitB = fakeGit({ head: HEAD_B });
  const fxA = fakeGh({ gitState: gitA.st });
  const fxB = fakeGh({ gitState: gitB.st, issue: 84, branch: 'soc/issue-84-publish', number: 81 });
  const execute = () => ({ ok: true, value: { executionRecordPath: 'x' } });
  const a = await runControlLoop({ sessionPath: first.sessionPath, identityHash: first.id, stateDir, deps: loopDeps({ git: gitA, fx: fxA, executor: execute }) });
  const b = await runControlLoop({ sessionPath: second.sessionPath, identityHash: second.id, stateDir, deps: loopDeps({ git: gitB, fx: fxB, executor: execute }) });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.notEqual(first.id, second.id);
  assert.equal(JSON.parse(fs.readFileSync(first.sessionPath, 'utf8')).prNumber, 80);
  assert.equal(JSON.parse(fs.readFileSync(second.sessionPath, 'utf8')).prNumber, 81);
});

test('G3g. local HEAD drift between canonical refresh and push sends nothing', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const git = fakeGit();
  const original = git.exec;
  let reads = 0;
  git.exec = (a0, opts) => {
    const args = Array.isArray(a0) ? a0 : opts.args;
    if (args[0] === 'rev-parse' && ++reads > 1) git.st.head = HEAD_B;
    return original(a0, opts);
  };
  const fx = fakeGh({ gitState: git.st });
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: loopDeps({ git, fx, executor: () => ({ ok: true, value: { executionRecordPath: 'x' } }) }) });
  assert.equal(res.code, 'PUSH_HEAD_MISMATCH');
  assert.equal(git.st.pushes, 0);
  assert.equal(fx.calls.length, 0);
});

test('G3h. ambiguous push has typed recoverable status and remote read-back resolves retry', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const git = fakeGit();
  const original = git.exec;
  git.exec = (a0, opts) => {
    const out = original(a0, opts);
    const args = Array.isArray(a0) ? a0 : opts.args;
    return args[0] === 'push' ? { status: 1, stdout: '', stderr: 'connection lost after write' } : out;
  };
  const fx = fakeGh({ gitState: git.st });
  const deps = loopDeps({ git, fx, executor: () => ({ ok: true, value: { executionRecordPath: 'x' } }) });
  const first = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(first.code, 'PUSH_AMBIGUOUS');
  assert.equal(first.detail.status, 'PUSH_UNPROVEN');
  assert.equal(first.detail.recoverable, true);
  assert.equal(fx.calls.length, 0);
  const retry = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps });
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(git.st.pushes, 1, 'retry adopts the remotely proven head');
});

for (const [field, value, expected] of [
  ['headRefName', 'agent/foreign', 'PR_BIND_IDENTITY_MISMATCH'],
  ['baseRefName', 'foreign-base', 'PR_BIND_IDENTITY_MISMATCH'],
  ['url', 'https://github.com/foreign/repo/pull/80', 'PR_BIND_IDENTITY_MISMATCH'],
  ['headRepository', { nameWithOwner: 'foreign/repo' }, 'PR_BIND_IDENTITY_MISMATCH'],
  ['body', `Closes #${ISSUE}\n<!-- soc-brain:identity=ffffffffffffffffffffffffffffffff -->`, 'PR_BIND_IDENTITY_MISMATCH'],
  ['number', 81, 'PR_BIND_IDENTITY_MISMATCH'],
  ['headRefOid', HEAD_B, 'PR_BIND_HEAD_MISMATCH'],
  ['state', 'MERGED', 'PR_BIND_STATE_INVALID'],
]) {
  test(`PR binding rejects mismatched GitHub ${field}`, async () => {
    const stateDir = mkStateDir();
    const { sessionPath, id } = mkSession(stateDir);
    const git = fakeGit();
    const fx = fakeGh({ gitState: git.st });
    const gh = fx.gh;
    fx.gh = (args) => {
      const out = gh(args);
      if (args[0] === 'pr' && args[1] === 'view' && out.code === 0) return { ...out, stdout: JSON.stringify({ ...JSON.parse(out.stdout), [field]: value }) };
      return out;
    };
    const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: loopDeps({ git, fx, executor: () => ({ ok: true, value: { executionRecordPath: 'x' } }) }) });
    assert.equal(res.code, expected);
    assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).prNumber, undefined);
    assert.equal(packetsIn(stateDir).length, 0);
  });
}

test('PR creation with unknown reply is adopted on restart without creating twice', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const git = fakeGit();
  const fx = fakeGh({ gitState: git.st });
  const gh = fx.gh;
  fx.gh = (args) => {
    const out = gh(args);
    return args[0] === 'pr' && args[1] === 'create' ? { unknown: true, error: 'reply lost' } : out;
  };
  const deps = loopDeps({ git, fx, executor: () => ({ ok: true, value: { executionRecordPath: 'x' } }) });
  assert.equal((await runControlLoop({ sessionPath, identityHash: id, stateDir, deps })).code, 'PR_BIND_UNKNOWN');
  assert.equal((await runControlLoop({ sessionPath, identityHash: id, stateDir, deps })).ok, true);
  assert.equal(fx.calls.filter((c) => c.startsWith('pr create')).length, 1);
});

test('an open branch PR with delayed head read-back is never duplicated', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const git = fakeGit();
  const fx = fakeGh({ gitState: git.st });
  fx.st.created = true;
  const gh = fx.gh;
  fx.gh = (args) => args[0] === 'pr' && args[1] === 'list'
    ? { code: 0, stdout: JSON.stringify([{ number: 80, state: 'OPEN', headRefOid: HEAD_B }]) }
    : gh(args);
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: loopDeps({ git, fx, executor: () => ({ ok: true, value: { executionRecordPath: 'x' } }) }) });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(fx.calls.some((c) => c.startsWith('pr create')), false);
});

test('multiple open branch PRs refuse ambiguous binding without creating another', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id } = mkSession(stateDir);
  const git = fakeGit();
  const fx = fakeGh({ gitState: git.st });
  const gh = fx.gh;
  fx.gh = (args) => args[0] === 'pr' && args[1] === 'list'
    ? { code: 0, stdout: JSON.stringify([{ number: 80, state: 'OPEN', headRefOid: HEAD_A }, { number: 81, state: 'OPEN', headRefOid: HEAD_A }]) } : gh(args);
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir, deps: loopDeps({ git, fx, executor: () => ({ ok: true, value: { executionRecordPath: 'x' } }) }) });
  assert.equal(res.code, 'PR_BIND_AMBIGUOUS');
  assert.equal(fx.calls.some((c) => c.startsWith('pr create')), false);
});

test('G4. rework leg republishes: new head pushed, same PR adopted, fresh packet wins', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir } });
  const git = fakeGit({ head: HEAD_A });
  const fx = fakeGh({ gitState: git.st });
  const rw = { verdict: 'REWORK', findings: ['f'], evidenceRequests: [], confidence: 0.8, metadata: {}, binding: { repository: REPO, issue: ISSUE, headSha: HEAD_A } };
  const pass = { verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.99, metadata: {} };
  let n = 0;
  // The rework leg read-back gate requires the canonical execution record.
  const execPath = path.join(stateDir, 'executions', `${ID}.json`);
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.writeFileSync(execPath, JSON.stringify({ schemaVersion: '1', kind: 'ExecutionRecord', identityHash: ID, terminalStatus: 'ok', exitCode: 0 }), 'utf8');
  const deps = loopDeps({
    git, fx,
    // The rework executor "commits" head B before returning.
    executor: (ctx) => { if (ctx.reworkInstruction) git.st.head = HEAD_B; return { ok: true, value: { executionRecordPath: execPath } }; },
  });
  deps.finalReview = () => { n += 1; return { ok: true, value: n === 1 ? rw : pass }; };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  // Round-2 head published; the SAME PR follows the branch (adopted, no 2nd create).
  assert.equal(git.st.remoteRef, HEAD_B);
  assert.equal(fx.calls.filter((c) => c.startsWith('pr create')).length, 1, 'exactly one PR create across legs');
  const s = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(s.headSha, HEAD_B, 'canonical head refreshed to the rework commit');
  assert.equal(s.prNumber, 80);
  assert.equal(s.controlLoop.prHistory.length, 2, 'binding re-persisted per leg');
  // Both packets exist on disk; the CURRENT-head one is the canonical choice.
  const packets = packetsIn(stateDir);
  assert.equal(packets.length, 2);
  assert.ok(packets.some((p) => p.includes(`_${HEAD_B.slice(0, 7)}_`)), 'packet at the rework head exists');
});

// G5 (direct unit): packetPathFor must resolve the packet matching the
// session's CURRENT head even when the other round's shortSha sorts lexically
// HIGHER (the pre-fix behavior picked the stale packet).
test('G5. packetPathFor resolves the current-head packet, not the lexically-newest one', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { headSha: HEAD_B });
  const dir = path.join(stateDir, 'review-ready');
  fs.mkdirSync(dir, { recursive: true });
  // Round-1 packet (shortSha 'aaaaaaa') sorts ABOVE round-2's 'bbbbbbb'.
  fs.writeFileSync(path.join(dir, `${REPO.replaceAll('/', '_')}_Issue-${ISSUE}_PR-80_${HEAD_A.slice(0, 7)}_review-ready.md`), 'stale', 'utf8');
  fs.writeFileSync(path.join(dir, `${REPO.replaceAll('/', '_')}_Issue-${ISSUE}_PR-80_${HEAD_B.slice(0, 7)}_review-ready.md`), 'current', 'utf8');
  const r = packetPathFor({ sessionPath, reviewReadyDir: dir });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.filename.includes(`_${HEAD_B.slice(0, 7)}_`), `resolved ${r.filename}`);
});

// G6 (Issue #110/#120): push scope guard — ONLY the proven generated residue of
// the Issue #67 e2e harness (.soc-e2e-<digits>/marker-<token>.<ext>, see
// scripts/e2e-reverse-control-leg.mjs:75/:218) plus the collapsed wholly-
// untracked dir form `.soc-e2e-<digits>` (Issue #120) joins the runtime-dirt
// allowlist; every other unknown untracked path stays foreign
// (PUSH_DIRTY_FOREIGN). NO blanket .soc-e2e-* bypass.
test('G6. push scope guard: generated .soc-e2e marker residue allowlisted, everything else foreign', async () => {
  const session = { worktreePath: 'wt', branch: BRANCH, baseSha: BASE };
  const pushGit = (statusLines) => {
    const st = { head: HEAD_A, base: BASE, remoteRef: null, pushes: 0 };
    const exec = (a0, opts) => {
      const a = (Array.isArray(a0) ? a0 : (opts && opts.args) || []).map(String);
      if (a[0] === 'rev-parse' && a[1] === 'HEAD') return { status: 0, stdout: `${st.head}\n`, stderr: '' };
      if (a[0] === 'status') return { status: 0, stdout: statusLines.join('\n') + '\n', stderr: '' };
      if (a[0] === 'diff') return { status: 1, stdout: '', stderr: '' };
      if (a[0] === 'ls-remote') return { status: 0, stdout: st.remoteRef ? `${st.remoteRef}\t${a[2]}\n` : '', stderr: '' };
      if (a[0] === 'push') { st.remoteRef = a[2].split(':')[0]; st.pushes += 1; return { status: 0, stdout: '', stderr: '' }; }
      return { status: 1, stdout: '', stderr: `unmocked git: ${a.join(' ')}` };
    };
    return { st, exec };
  };

  // (a) dirty list = allowlisted marker residue + collapsed bare dir form
  // (Issue #120) + opencode.json -> guard passes.
  const marker = '.soc-e2e-67/marker-8c03334c-86a6-434c-bfa1-11ef62c64a48.txt';
  const ga = pushGit([`?? ${marker}`, '?? .soc-e2e-67', '?? opencode.json']);
  const ra = pushBranch({ session, exec: ga.exec });
  assert.equal(ra.ok, true, JSON.stringify(ra));
  assert.equal(ga.st.pushes, 1, 'guard passes: push proceeds past the marker residue');

  // (b) foreign residue: other filename in the same dir / non-numeric dir /
  // collapsed unknown dir (Issue #120 keeps these foreign).
  for (const dirty of ['?? .soc-e2e-67/injected.sh', '?? .soc-e2e-x/marker-a.txt', '?? .soc-e2e-x', '?? unknown-dirt.txt', ' M SOC_TASK_CONTRACT.md']) {
    const gb = pushGit([dirty]);
    const rb = pushBranch({ session, exec: gb.exec });
    assert.equal(rb.ok, false);
    assert.equal(rb.code, 'PUSH_DIRTY_FOREIGN', dirty);
    assert.deepEqual(rb.detail.foreignPaths, [dirty.slice(3)]);
    assert.equal(gb.st.pushes, 0, 'nothing is pushed while foreign dirt is present');
  }
});



