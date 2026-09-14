#!/usr/bin/env node
// client-mcp.test.mjs — Issue #175 A1-A7 + MCP transport integration tests.
// Deterministic, dependency-free, disposable git fixtures with a github.com
// origin remote and an explicit refs/remotes/origin/main ref (so readUpstreamHead
// resolves without any CWD fallback). No gh, no network, no real executor.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { sessionPathFor, readSessionRecord, taskRequestHumanGate, updateSessionUnderOwnershipLock, answerHumanGate as canonicalAnswerHumanGate } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { createClientControl, resolveCanonicalRepo } from '../packages/client-mcp/client-control.mjs';
import { createClientMcpServer } from '../packages/client-mcp/client-mcp.mjs';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-175-'));
mkdirSync(path.join(TMP, 'wt'), { recursive: true });
mkdirSync(path.join(TMP, 'state'), { recursive: true });

function makeRepo(ownerRepoName, files = { 'opencode.json': '{}\n', 'README.md': 'r\n' }) {
  const dir = mkdtempSync(path.join(TMP, 'repo-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const run = (args) => { try { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { throw new Error('git ' + args.join(' ') + ' failed: ' + ((e.stderr || '') + (e.stdout || '') || e.message)); } };
  run(['init', '--initial-branch=main', dir]);
  run(['-C', dir, 'config', 'user.email', 't@e.x']);
  run(['-C', dir, 'config', 'user.name', 't']);
  for (const [f, c] of Object.entries(files)) { writeFileSync(path.join(dir, f), c); run(['-C', dir, 'add', f]); }
  run(['-C', dir, 'commit', '-m', 'init']);
  const sha = run(['-C', dir, 'rev-parse', 'HEAD']);
  run(['-C', dir, 'remote', 'add', 'origin', `https://github.com/${ownerRepoName}.git`]);
  run(['-C', dir, 'update-ref', 'refs/remotes/origin/main', sha]);
  return { dir, ownerRepoName, sha };
}

function newControl(overrides = {}) {
  return createClientControl({
    stateDir: path.join(TMP, 'state-' + Math.random().toString(36).slice(2, 8)),
    worktreesRoot: path.join(TMP, 'wt'),
    controlLane: null,
    ...overrides,
  });
}

test('A1 admission from external client — canonical task created, explicit repo identity, no CWD fallback, client not lifecycle owner', () => {
  const R = makeRepo('duongpdddic-droid/disposable-a1');
  const ctl = newControl();
  const res = ctl.submitGoal({
    targetRepo: 'duongpdddic-droid/disposable-a1',
    localCheckoutPath: R.dir,
    goal: 'add hello endpoint',
    issueNumber: 424242,
  });
  assert.ok(res.ok, `submitGoal failed: ${JSON.stringify(res)}`);
  assert.equal(res.admitted, true);
  assert.equal(res.repo, 'duongpdddic-droid/disposable-a1');
  assert.equal(res.issueNumber, 424242);
  // The canonical session exists at the identity-addressed path.
  const h = identityHash({ repo: 'duongpdddic-droid/disposable-a1', issueNumber: 424242 });
  assert.equal(res.identityHash, h);
  const sPath = sessionPathFor({ stateDir: ctl.config.stateDir, identityHash: h });
  assert.ok(fs.existsSync(sPath), 'canonical session file not written');
  const rs = readSessionRecord(sPath);
  assert.ok(rs.ok, 'session not readable');
  assert.equal(rs.session.repo, 'duongpdddic-droid/disposable-a1');
  // Client is NOT the mutation owner: config.controlLane=null leaves the session
  // UNBOUND (anonymous mutation authority is forbidden by #145 rework F1).
  assert.equal(rs.session.mutationOwner, null);
  // Client did NOT terminalize.
  assert.ok(!['COMPLETED', 'FAILED', 'BLOCKED'].includes(rs.session.state));
  // Missing targetRepo/checkout -> explicit fail-closed.
  const r2 = ctl.submitGoal({ targetRepo: '', localCheckoutPath: R.dir, goal: 'g', issueNumber: 1 });
  assert.equal(r2.ok, false); assert.equal(r2.reason, 'REPO_IDENTITY_MISSING');
  const r3 = ctl.submitGoal({ targetRepo: 'duongpdddic-droid/disposable-a1', goal: 'g', issueNumber: 1 });
  assert.equal(r3.ok, false); assert.equal(r3.reason, 'REPO_CHECKOUT_PATH_REQUIRED'); // no CWD fallback
});

test('A2 external repo execution — worktree provisioned against the external repo, Soc_brain source untouched', () => {
  const R = makeRepo('duongpdddic-droid/disposable-a2');
  const worktreeBefore = fs.readdirSync(path.join(TMP, 'wt'));
  const socSrcFile = new URL('../README.md', import.meta.url);
  const socBefore = fs.readFileSync(socSrcFile);
  const ctl = newControl();
  const res = ctl.submitGoal({
    targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, goal: 'do a thing', issueNumber: 555555,
  });
  assert.ok(res.ok, JSON.stringify(res));
  // The provisioned worktree path is under the injected worktreesRoot and
  // identity-derived (agent/<hash>), and IS a git worktree whose origin matches
  // the external repo (NOT the Soc_brain origin).
  const wt = path.join(TMP, 'wt', 'agent', res.identityHash);
  assert.ok(fs.existsSync(wt), 'external worktree missing');
  const url = execFileSync('git', ['-C', wt, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  assert.match(url, /disposable-a2\.git$/);
  // Soc_brain source repo not mutated by product task (README unchanged, no
  // agent worktree leaked inside the .wt175 checkout).
  const socAfter = fs.readFileSync(socSrcFile);
  assert.deepEqual(socAfter, socBefore);
  const agentInside = path.join(new URL('..', import.meta.url).pathname.replace(/^\//, ''), 'worktrees', 'agent');
  assert.ok(!fs.existsSync(agentInside), `Soc_brain tree should not have a worktrees/agent dir, found at ${agentInside}`);
  // And TMP/wt gained at least one new agent/ subdir.
  const worktreeAfter = fs.readdirSync(path.join(TMP, 'wt', 'agent'));
  assert.ok(worktreeAfter.length > 0);
});

test('A3 reconnect — same canonical state from a fresh client instance, no duplicate task, idempotent replay', () => {
  const R = makeRepo('duongpdddic-droid/disposable-a3');
  const shared = { stateDir: path.join(TMP, 'state-a3'), worktreesRoot: path.join(TMP, 'wt'), controlLane: null };
  mkdirSync(shared.stateDir, { recursive: true });
  const A = createClientControl(shared);
  const sub = A.submitGoal({ targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, goal: 'reconnect', clientRequestId: 'req-A3-aaaaaaaa', executorPreference: 'auto' });
  assert.ok(sub.ok, JSON.stringify(sub));
  const localNum = sub.issueNumber;
  assert.ok(localNum >= 9000000, 'local allocator must produce >=9_000_000 provenance-clean numbers');

  // Client A "dies" — no client-process-held lifecycle exists in the surface
  // (all state is on disk). Client B is a fresh instance over the SAME stateDir.
  const B = createClientControl(shared);
  const t = B.getTask({ repo: R.ownerRepoName, issueNumber: localNum });
  assert.ok(t.ok, JSON.stringify(t));
  assert.equal(t.task.identityHash, sub.identityHash);
  assert.equal(t.task.taskId, sub.taskId);

  // Idempotent replay of the SAME submit (same clientRequestId) reconciles to
  // the SAME canonical task — no duplicate admission, no second number burn.
  const replay = B.submitGoal({ targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, goal: 'reconnect', clientRequestId: 'req-A3-aaaaaaaa' });
  assert.ok(replay.ok);
  assert.equal(replay.replayed, true);
  assert.equal(replay.identityHash, sub.identityHash);
  assert.equal(replay.issueNumber, localNum);

  // Same explicit issueNumber → taskStart's identity-addressed idempotency.
  const resubmit = B.submitGoal({ targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, goal: 'reconnect again', issueNumber: localNum });
  assert.ok(resubmit.ok, JSON.stringify(resubmit));
  assert.equal(resubmit.identityHash, sub.identityHash);
});

test('A4 human gate — exact checkpoint accepted once, stale/wrong rejected, resume is canonical SESSION_ACTIVE', () => {
  const R = makeRepo('duongpdddic-droid/disposable-a4');
  const ctl = newControl();
  const sub = ctl.submitGoal({ targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, goal: 'gate', issueNumber: 900900 });
  assert.ok(sub.ok, JSON.stringify(sub));
  const h = sub.identityHash;
  const sPath = sessionPathFor({ stateDir: ctl.config.stateDir, identityHash: h });
  // Canonical HUMAN_GATE_REQUIRED edge (executor-side primitive — the loop's
  // own tool call; the client cannot synthesize this — verified separately).
  const req = taskRequestHumanGate({ sessionPath: sPath, note: 'which endpoint style? REST or GraphQL' });
  assert.ok(req.ok);
  const readBack = readSessionRecord(sPath).session;
  assert.ok(['HUMAN_GATE_REQUIRED', 'WAITING_FOR_INPUT'].includes(readBack.state));
  assert.ok(readBack.humanGate && typeof readBack.humanGate.at === 'string');
  const cp = readBack.humanGate.at;

  // get_task exposes the checkpoint.
  const g = ctl.getTask({ repo: R.ownerRepoName, issueNumber: 900900 });
  assert.ok(g.ok && g.task.humanGate && g.task.humanGate.at === cp);
  assert.equal(g.task.humanActionRequired ?? (g.task.state === 'HUMAN_GATE_REQUIRED' || g.task.state === 'WAITING_FOR_INPUT'), true);

  // Wrong checkpoint (stale) → fail closed.
  const stale = ctl.answerHumanGate({ repo: R.ownerRepoName, issueNumber: 900900, checkpointAt: '1970-01-01T00:00:00.000Z', response: 'REST' });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'GATE_CHECKPOINT_STALE');

  // Wrong task/session (different issue) → TASK_NOT_FOUND (identity-addressed path).
  const wrongTask = ctl.answerHumanGate({ repo: R.ownerRepoName, issueNumber: 123456, checkpointAt: cp, response: 'REST' });
  assert.equal(wrongTask.ok, false);
  assert.equal(wrongTask.reason, 'TASK_NOT_FOUND');

  // Correct checkpoint → accepted; state resumes to canonical SESSION_ACTIVE.
  const ok = ctl.answerHumanGate({ repo: R.ownerRepoName, issueNumber: 900900, checkpointAt: cp, response: 'REST please' });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(ok.resumed, true);
  assert.equal(ok.state, 'SESSION_ACTIVE');

  // Duplicate answer → deterministic rejection (accepted exactly once).
  const dup = ctl.answerHumanGate({ repo: R.ownerRepoName, issueNumber: 900900, checkpointAt: cp, response: 'REST again' });
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'GATE_NOT_ACTIVE');

  // Answer is DATA, never a lifecycle verdict.
  const s = readSessionRecord(sPath).session;
  assert.equal(s.humanGate.state, 'ANSWERED');
  assert.equal(s.humanGate.response, 'REST please');
});

test('A5 merge authorization — exact repo/issue/PR/reviewedHeadSha, stale/wrong/foreign rejected, no direct merge, idempotent', () => {
  const R = makeRepo('duongpdddic-droid/disposable-a5');
  const deliveryRepo = R.ownerRepoName; // test-scoped canonical delivery repo
  const a5State = path.join(TMP, 'state-a5-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(a5State, { recursive: true });
  const ctl = createClientControl({ stateDir: a5State, worktreesRoot: path.join(TMP, 'wt'), controlLane: null, deliveryCanonicalRepo: deliveryRepo });
  const sub = ctl.submitGoal({ targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, goal: 'merge-auth', issueNumber: 700700 });
  assert.ok(sub.ok, JSON.stringify(sub));
  const sPath = sessionPathFor({ stateDir: ctl.config.stateDir, identityHash: sub.identityHash });
  // Simulate the review-ready binding (canonical control-loop would write these
  // via refreshCanonicalHead + bindPullRequest + persistPrNumber).
  const headSha = 'a'.repeat(40);
  updateSessionUnderOwnershipLock(sPath, (sess) => {
    sess.headSha = headSha;
    sess.prNumber = 777;
    return { session: sess };
  });
  const clientReq = 'auth-175-aaaa';
  // Wrong PR → PR_MISMATCH.
  const wrongPr = ctl.authorizeMerge({ repo: R.ownerRepoName, issueNumber: 700700, pullRequest: 999, reviewedHeadSha: headSha, authorizedBy: 'human:alice', clientRequestId: clientReq });
  assert.equal(wrongPr.ok, false);
  assert.equal(wrongPr.reason, 'PR_MISMATCH');

  // Wrong HEAD (stale) → HEAD_STALE.
  const wrongHead = ctl.authorizeMerge({ repo: R.ownerRepoName, issueNumber: 700700, pullRequest: 777, reviewedHeadSha: 'b'.repeat(40), authorizedBy: 'human:alice', clientRequestId: 'auth-175-aaaa-h2' });
  assert.equal(wrongHead.ok, false);
  assert.equal(wrongHead.reason, 'HEAD_STALE');

  // Missing clientRequestId → fail closed (no blind retry).
  const noReqId = ctl.authorizeMerge({ repo: R.ownerRepoName, issueNumber: 700700, pullRequest: 777, reviewedHeadSha: headSha, authorizedBy: 'human:alice' });
  assert.equal(noReqId.ok, false);
  assert.equal(noReqId.reason, 'AUTHORIZE_CLIENT_REQUEST_ID_REQUIRED');

  // Foreign repo (deliveryCanonicalRepo default is Soc_brain) → canonical-only guard.
  const ctlForeign = createClientControl({ stateDir: a5State, worktreesRoot: path.join(TMP, 'wt'), controlLane: null });
  const foreign = ctlForeign.authorizeMerge({ repo: R.ownerRepoName, issueNumber: 700700, pullRequest: 777, reviewedHeadSha: headSha, authorizedBy: 'human:alice', clientRequestId: 'auth-175-aaaa-h3' });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, 'MERGE_AUTH_CANONICAL_REPO_ONLY');

  // Exact binding accepted (recorded, no merge invoked).
  const good = ctl.authorizeMerge({ repo: R.ownerRepoName, issueNumber: 700700, pullRequest: 777, reviewedHeadSha: headSha, authorizedBy: 'human:alice', clientRequestId: clientReq });
  assert.ok(good.ok, JSON.stringify(good));
  assert.equal(good.recorded, true);
  assert.equal(good.replayed, false);
  assert.equal(good.bound.reviewedHeadSha, headSha);
  assert.equal(good.bound.pullRequest, 777);

  // Idempotent replay of identical authorization → same record, replayed:true.
  const replay = ctl.authorizeMerge({ repo: R.ownerRepoName, issueNumber: 700700, pullRequest: 777, reviewedHeadSha: headSha, authorizedBy: 'human:alice', clientRequestId: clientReq });
  assert.ok(replay.ok);
  assert.equal(replay.replayed, true);
});

test('A6 client death does not cancel executor / no duplicate owner / task continues to be observable', () => {
  const R = makeRepo('duongpdddic-droid/disposable-a6');
  const shared = { stateDir: path.join(TMP, 'state-a6'), worktreesRoot: path.join(TMP, 'wt'), controlLane: 'lane-A6' };
  mkdirSync(shared.stateDir, { recursive: true });
  const A = createClientControl(shared);
  const sub = A.submitGoal({ targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, goal: 'long-running', issueNumber: 810810 });
  assert.ok(sub.ok, JSON.stringify(sub));
  const sPath = sessionPathFor({ stateDir: shared.stateDir, identityHash: sub.identityHash });
  const before = readSessionRecord(sPath).session;
  // Client A named a CONTROL lane, not itself: the client surface binds
  // controlLane as the mutation owner. That's the canonical single-owner
  // model; the CLIENT is never a second mutation owner.
  assert.equal(before.mutationOwner && before.mutationOwner.laneId, 'lane-A6');

  // Simulate executor bind (startExecution's session.executionMode='executor').
  updateSessionUnderOwnershipLock(sPath, (s) => { s.executionMode = 'executor'; return { session: s }; });

  // "Client A dies" — drop A reference. Nothing on the client surface has
  // process-lifetime authority. No taskBlock/taskFinish called → state
  // unchanged from admission.
  const beforeState = before.state;
  const ARef = null; // eslint-disable-line no-unused-vars

  // Client B (fresh) reads the SAME canonical state; no second mutation owner.
  const B = createClientControl(shared);
  const t = B.getTask({ repo: R.ownerRepoName, issueNumber: 810810 });
  assert.ok(t.ok);
  assert.equal(t.task.state, beforeState);
  assert.equal(t.task.mutationOwner, 'lane-A6');
  assert.equal(t.task.executionMode, 'executor');
  // getProgress observe path must not change anything either.
  const p = B.getProgress({ repo: R.ownerRepoName, issueNumber: 810810 });
  assert.ok(p.ok);
  const after = readSessionRecord(sPath).session;
  assert.equal(after.mutationOwner.laneId, 'lane-A6');
  assert.equal(after.state, beforeState);
  // B submitting the SAME issue with a DIFFERENT lane (would be a second
  // owner) fails closed via admissionOwnershipGate.
  const C = createClientControl({ ...shared, controlLane: 'lane-INTRUDER' });
  const clash = C.submitGoal({ targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, goal: 'hijack', issueNumber: 810810 });
  assert.equal(clash.ok, false);
  assert.equal(clash.reason, 'MUTATION_OWNER_CONFLICT');
});

test('A7 cross-project safety — two disposable repos isolate by canonical identity; no CWD fallback', () => {
  const RA = makeRepo('duongpdddic-droid/disposable-a7a');
  const RB = makeRepo('duongpdddic-droid/disposable-a7b');
  const ctl = newControl();
  const a = ctl.submitGoal({ targetRepo: RA.ownerRepoName, localCheckoutPath: RA.dir, goal: 'A goal', issueNumber: 601 });
  const b = ctl.submitGoal({ targetRepo: RB.ownerRepoName, localCheckoutPath: RB.dir, goal: 'B goal', issueNumber: 602 });
  assert.ok(a.ok && b.ok, JSON.stringify({ a, b }));
  assert.notEqual(a.identityHash, b.identityHash);
  // Cross-target mismatch — repo identity from the checkout's real origin wins,
  // never a caller-provided string against the wrong checkout.
  const crossed = ctl.submitGoal({ targetRepo: RB.ownerRepoName, localCheckoutPath: RA.dir, goal: 'wrong', issueNumber: 603 });
  assert.equal(crossed.ok, false);
  assert.equal(crossed.reason, 'REPO_CHECKOUT_MISMATCH');
  // get_task on the wrong repo → TASK_IDENTITY_MISMATCH or TASK_NOT_FOUND (both
  // reject; identity is bound). The two identity hashes differ, so the path is
  // different from the other repo's session.
  const t = ctl.getTask({ repo: RA.ownerRepoName, issueNumber: 602 });
  assert.equal(t.ok, false);
  assert.ok(['TASK_NOT_FOUND', 'TASK_IDENTITY_MISMATCH'].includes(t.reason));
});

test('cancel_task fails closed (no canonical cancellation path exists)', () => {
  const ctl = newControl();
  const r = ctl.cancelTask({ repo: 'x/y', issueNumber: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'CANCEL_NOT_SUPPORTED');
});

test('MCP transport — tools/list + tools/call round-trip (A1 shape)', () => {
  const R = makeRepo('duongpdddic-droid/disposable-mcp');
  const ctl = newControl();
  const server = createClientMcpServer({ control: ctl });
  // tools/list exposes the canonical capability set.
  const list = server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(list.result.tools.length, 7);
  const names = list.result.tools.map((t) => t.name);
  assert.ok(names.includes('soc.submit_goal') && names.includes('soc.authorize_merge') && names.includes('soc.cancel_task'));
  // tools/call soc.get_task on unknown task → isError:true (canonical fail-closed).
  const call = server.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'soc.get_task', arguments: { repo: R.ownerRepoName, issueNumber: 123999 } } });
  assert.equal(call.result.isError, true);
  // initialize
  const init = server.handleRequest({ jsonrpc: '2.0', id: 3, method: 'initialize' });
  assert.equal(init.result.serverInfo.name, 'soc-brain-client');
});

test('repo identity resolution — canonical URL forms normalize; ambiguous/missing reject; CWD fallback forbidden', () => {
  const R = makeRepo('duongpdddic-droid/disposable-identity');
  const okA = resolveCanonicalRepo({ targetRepo: 'https://github.com/DuongPDDdic-Droid/Disposable-Identity.git', localCheckoutPath: R.dir });
  assert.ok(okA.ok, JSON.stringify(okA));
  assert.equal(okA.repo, 'duongpdddic-droid/disposable-identity'); // lowercased canonical form
  const badMissing = resolveCanonicalRepo({ targetRepo: '', localCheckoutPath: R.dir });
  assert.equal(badMissing.reason, 'REPO_IDENTITY_MISSING');
  const badCwdFallback = resolveCanonicalRepo({ targetRepo: 'owner/repo', localCheckoutPath: '' });
  assert.equal(badCwdFallback.reason, 'REPO_CHECKOUT_PATH_REQUIRED');
  const badMismatch = resolveCanonicalRepo({ targetRepo: 'other/repo', localCheckoutPath: R.dir });
  assert.equal(badMismatch.reason, 'REPO_CHECKOUT_MISMATCH');
});

test('answerHumanGate canonical seam — direct primitive: exactly-once + stale + wrong-checkpoint reject', () => {
  // dispatcher test A4 above already covers the client-facing surface; this
  // locks the invariant at the primitive level so #175 does not silently break
  // it if the dispatcher evolves.
  const R = makeRepo('duongpdddic-droid/disposable-m1');
  const ctl = newControl();
  const sub = ctl.submitGoal({ targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, goal: 'm1', issueNumber: 654321 });
  const sPath = sessionPathFor({ stateDir: ctl.config.stateDir, identityHash: sub.identityHash });
  taskRequestHumanGate({ sessionPath: sPath, note: 'q' });
  const gate = readSessionRecord(sPath).session.humanGate;
  // Missing checkpoint rejected.
  const missing = canonicalAnswerHumanGate({ sessionPath: sPath, checkpointAt: '', response: 'a' });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'GATE_CHECKPOINT_MISSING');
  // Wrong checkpoint stale.
  const wrong = canonicalAnswerHumanGate({ sessionPath: sPath, checkpointAt: 'stale', response: 'a' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'GATE_CHECKPOINT_STALE');
  // Correct → SESSION_ACTIVE.
  const good = canonicalAnswerHumanGate({ sessionPath: sPath, checkpointAt: gate.at, response: 'ok' });
  assert.ok(good.ok);
  assert.equal(good.session.state, 'SESSION_ACTIVE');
  // Replay → GATE_NOT_ACTIVE (canonical exactly-once via state).
  const replay = canonicalAnswerHumanGate({ sessionPath: sPath, checkpointAt: gate.at, response: 'ok' });
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'GATE_NOT_ACTIVE');
});

// Helper: drive the MCP wire and parse the tool result payload.
function callMcp(server, name, args) {
  const res = server.handleRequest({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res.result, `no result for ${name}: ${JSON.stringify(res)}`);
  return JSON.parse(res.result.content[0].text);
}

test('VERTICAL SLICE — Cline-compatible MCP client: submit -> route -> client death -> reconnect -> Human Gate -> answer -> resume -> review/merge gates intact', () => {
  const R = makeRepo('duongpdddic-droid/disposable-vslice');
  const vsState = path.join(TMP, 'state-vs-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(vsState, { recursive: true });
  const shared = { stateDir: vsState, worktreesRoot: path.join(TMP, 'wt'), controlLane: 'control-plane-175' };  // The persistent control plane (NOT the client) owns execution: this injected
  // router stands in for a detached canonical executor launch. Marking the
  // session 'executor' mirrors startExecution's execution-context bind.
  const routeExecutor = ({ sessionPath }) => {
    updateSessionUnderOwnershipLock(sessionPath, (s) => { s.executionMode = 'executor'; return { session: s }; });
    return { ok: true, status: 'RUNNING', detached: true };
  };
  const clientA = createClientMcpServer({ control: createClientControl({ ...shared, routeExecutor }) });

  // 1. Cline types a normal goal -> submitted to Soc_brain (not executed by Cline).
  const submit = callMcp(clientA, 'soc.submit_goal', {
    targetRepo: R.ownerRepoName, localCheckoutPath: R.dir, goal: 'ship the widget behind a flag',
    clientRequestId: 'vs-goal-0001', executorPreference: 'cline',
  });
  assert.ok(submit.ok, JSON.stringify(submit));
  assert.equal(submit.admitted, true);
  assert.equal(submit.execution && submit.execution.status, 'RUNNING'); // routed by the control plane
  const issue = submit.issueNumber;
  const sPath = sessionPathFor({ stateDir: vsState, identityHash: submit.identityHash });
  const afterSubmit = readSessionRecord(sPath).session;
  assert.equal(afterSubmit.mutationOwner.laneId, 'control-plane-175'); // owner is control plane, never the client
  assert.equal(afterSubmit.executionMode, 'executor');

  // 2. The routed executor (not the client) reaches a genuine Human Gate.
  taskRequestHumanGate({ sessionPath: sPath, note: 'Which datastore: Postgres or SQLite?' });

  // 3. Client A closes; a fresh client B reconnects over the SAME canonical state.
  // deliveryCanonicalRepo matches the fixture repo so authorizeMerge reaches the
  // head/PR binding checks; A5 already proves the foreign-repo guard rejects it.
  const clientB = createClientMcpServer({ control: createClientControl({ ...shared, deliveryCanonicalRepo: R.ownerRepoName }) });
  const gt = callMcp(clientB, 'soc.get_task', { repo: R.ownerRepoName, issueNumber: issue });
  assert.ok(gt.ok);
  assert.ok(['HUMAN_GATE_REQUIRED', 'WAITING_FOR_INPUT'].includes(gt.task.state)); // NOT cancelled by A's death
  assert.equal(gt.task.mutationOwner, 'control-plane-175'); // still a single owner, no second owner minted
  assert.ok(gt.task.humanGate && gt.task.humanGate.at);
  const gp = callMcp(clientB, 'soc.get_progress', { repo: R.ownerRepoName, issueNumber: issue });
  assert.ok(gp.ok && gp.humanActionRequired === true);
  // Reconnect alone created no duplicate: the canonical session path is unique.
  assert.equal(gt.task.identityHash, submit.identityHash);

  // 4. Human answers THROUGH the client (relay only). Wrong checkpoint first.
  const stale = callMcp(clientB, 'soc.answer_human_gate', { repo: R.ownerRepoName, issueNumber: issue, checkpointAt: 'nope', response: 'Postgres' });
  assert.equal(stale.ok, false); assert.equal(stale.reason, 'GATE_CHECKPOINT_STALE');
  const ans = callMcp(clientB, 'soc.answer_human_gate', { repo: R.ownerRepoName, issueNumber: issue, checkpointAt: gt.task.humanGate.at, response: 'Postgres' });
  assert.ok(ans.ok, JSON.stringify(ans));
  assert.equal(ans.state, 'SESSION_ACTIVE'); // loop can resume canonically
  const dup = callMcp(clientB, 'soc.answer_human_gate', { repo: R.ownerRepoName, issueNumber: issue, checkpointAt: gt.task.humanGate.at, response: 'Postgres' });
  assert.equal(dup.ok, false); assert.equal(dup.reason, 'GATE_NOT_ACTIVE'); // exactly once

  // 5. Verification/review gate preserved: request_review is non-authoritative.
  const rr = callMcp(clientB, 'soc.request_review', { repo: R.ownerRepoName, issueNumber: issue });
  assert.ok(rr.ok);
  assert.equal(rr.review.requested, true);
  assert.match(rr.review.note, /verdict|PASS/i); // explicitly no client verdict
  assert.ok(!('verdict' in rr.review) || rr.review.verdict === undefined);

  // 6. Merge authorization is exact-head-bound and performs no merge.
  const head = 'c'.repeat(40);
  updateSessionUnderOwnershipLock(sPath, (s) => { s.headSha = head; s.prNumber = 321; return { session: s }; });
  const bad = callMcp(clientB, 'soc.authorize_merge', { repo: R.ownerRepoName, issueNumber: issue, pullRequest: 321, reviewedHeadSha: 'd'.repeat(40), authorizedBy: 'human:bob', clientRequestId: 'vs-auth-1' });
  assert.equal(bad.ok, false); assert.equal(bad.reason, 'HEAD_STALE');
  const auth = callMcp(clientB, 'soc.authorize_merge', { repo: R.ownerRepoName, issueNumber: issue, pullRequest: 321, reviewedHeadSha: head, authorizedBy: 'human:bob', clientRequestId: 'vs-auth-1' });
  assert.ok(auth.ok, JSON.stringify(auth));
  assert.equal(auth.bound.reviewedHeadSha, head);
  assert.equal(auth.replayed, false);
  // No direct merge is possible through the client surface.
  const cancel = callMcp(clientB, 'soc.cancel_task', { repo: R.ownerRepoName, issueNumber: issue });
  assert.equal(cancel.ok, false); assert.equal(cancel.reason, 'CANCEL_NOT_SUPPORTED');
});
