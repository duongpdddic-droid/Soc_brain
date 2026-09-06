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
import { identityHash } from '../packages/workspace/workspace.mjs';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const BASE = 'f'.repeat(40);
const ISSUE = 83;
const BRANCH = 'soc/issue-83-publish';
const REPO = 'duongpdddic-droid/soc_brain';

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cl-pub-')); }

function mkSession(stateDir, overrides = {}) {
  const id = identityHash({ repo: REPO, issueNumber: ISSUE });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1', state: 'SESSION_ACTIVE', lifecycle: [],
    taskId: `${REPO}#${ISSUE}`, repo: REPO, issueNumber: ISSUE,
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
function fakeGh({ gitState }) {
  const calls = [];
  const st = { created: false };
  const j = (code, obj, stderr = '') => ({ code, stdout: obj === undefined ? '' : JSON.stringify(obj), stderr });
  function gh(args) {
    const a = args.map(String);
    calls.push(a.join(' '));
    if (a[0] === 'pr' && a[1] === 'list') {
      return j(0, st.created ? [{ number: 80, state: 'OPEN', headRefOid: gitState.remoteRef }] : []);
    }
    if (a[0] === 'pr' && a[1] === 'view') {
      if (!st.created) return j(1, undefined, 'no PR');
      return j(0, { number: 80, state: 'OPEN', headRefOid: gitState.remoteRef });
    }
    if (a[0] === 'pr' && a[1] === 'create') {
      st.created = true;
      return { code: 0, stdout: `https://github.com/${REPO}/pull/80\n`, stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unmocked gh: ${a.join(' ')}` };
  }
  return { gh, calls, st };
}

function loopDeps({ git, fx, executor }) {
  return {
    pushExec: git.exec, // presence (not value) activates the publish chain
    gh: fx.gh,
    router: () => ({ ok: true, value: { executorKind: 'opencode', model: 'x' } }),
    executor,
    verifier: () => ({ ok: true, value: { verdict: 'PASS', report: 'ok' } }),
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
  assert.deepEqual(fx.calls, [
    `pr list --repo ${REPO} --head ${BRANCH} --state all --json number,state,headRefOid`,
    `pr create --repo ${REPO} --base main --head ${BRANCH} --title feat: canonical task delivery (#${ISSUE}) --body Closes #${ISSUE}`,
    'pr view 80 --repo duongpdddic-droid/soc_brain --json state,number,headRefOid',
  ]);
  // Session carries the binding additively; admission head unchanged (no-op refresh).
  const s = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(s.prNumber, 80);
  assert.equal(s.headSha, HEAD_A);
  assert.equal(s.controlLoop.prHistory.length, 1);
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



