// tests/control-loop-delivery.test.mjs — P0-F canonical delivery lifecycle
// (Issue #81). Deterministic coverage of the Soc_brain-owned delivery leg:
// PASS -> ordered delivery (PR -> merge -> close -> sync -> cleanup) ->
// canonical TASK_COMPLETED terminal transition with real state read-back;
// REWORK never delivers; wrong/stale binding never merges; merge failure
// never closes/terminalizes; ambiguous results fail closed without blind
// retries; crash between steps resumes via read-backs/ledger without
// duplicated side effects; cleanup failure preserves delivery evidence.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runControlLoop,
  readTransitions,
} from '../packages/control-loop/control-loop.mjs';
import {
  runDeliveryLifecycle,
  readDeliveryLedger,
  deliverySpec,
} from '../packages/control-loop/delivery.mjs';
import { buildDeliveryAdapter } from '../packages/control-loop/adapters.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { fakeGh } from './fake-gh.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'f'.repeat(40);
const ISSUE = 81;

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cl-del-')); }

function mkSession(stateDir, overrides = {}) {
  const repo = overrides.repo || 'duongpdddic-droid/soc_brain';
  const issueNumber = overrides.issueNumber || ISSUE;
  const id = identityHash({ repo, issueNumber });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1',
    state: 'SESSION_ACTIVE',
    lifecycle: [],
    taskId: `${repo}#${issueNumber}`,
    repo,
    issueNumber,
    headSha: HEAD,
    baseSha: BASE,
    worktreePath: path.join(stateDir, `wt-issue-${issueNumber}`),
    worktreesRoot: stateDir,
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session, id };
}

function happyDeps(stateDir, calls, ghOpts = {}) {
  const fx = fakeGh({ issue: ISSUE, headSha: HEAD, baseSha: BASE, order: calls, ...ghOpts });
  // Canonical execution record at its canonical location (identity-checked by
  // the rework read-back gate).
  const execId = identityHash({ repo: 'duongpdddic-droid/soc_brain', issueNumber: ISSUE });
  const execPath = path.join(stateDir, 'executions', `${execId}.json`);
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.writeFileSync(execPath, JSON.stringify({ schemaVersion: '1', kind: 'ExecutionRecord', identityHash: execId, terminalStatus: 'ok', exitCode: 0 }), 'utf8');
  return {
    fx,
    deps: {
      router: () => ({ ok: true, value: { executorKind: 'opencode', model: 'x' } }),
      executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: execPath } }; },
      verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
      preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
      finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
      delivery: buildDeliveryAdapter({ gh: fx.gh, cleanup: () => { calls.push('cleanup'); return { ok: true, removed: [], keptBranch: 'x' }; } }),
      reviewReadyDir: path.join(stateDir, 'review-ready'),
      telegramSpawn: () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 901 })}\n` }),
    },
  };
}

const isRemote = (c) => typeof c === 'string' && (c.startsWith('pr ') || c.startsWith('issue ') || c.startsWith('api '));
const remoteCmds = (calls) => calls.filter(isRemote);

test('F1. validated PASS -> delivery in canonical order -> read-back -> TASK_COMPLETED', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const calls = [];
  const { deps } = happyDeps(stateDir, calls);
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  // Delivery ORDER: notification first, then PR create, merge, issue close,
  // main projection scans, cleanup LAST.
  const remote = remoteCmds(calls);
  // The read-only adoption search may precede creation; the first MUTATING
  // remote operation must be the PR create.
  const firstMut = remote.find((c) => !c.startsWith('pr list'));
  assert.ok(firstMut && firstMut.startsWith('pr create'), `first mutating op is pr create, got: ${firstMut}`);
  assert.ok(remote.some((c) => c.startsWith('pr merge')), 'squash merge issued');
  assert.ok(remote.some((c) => c.startsWith('issue close')), 'issue close issued');
  assert.ok(remote.some((c) => c.startsWith('api repos/duongpdddic-droid/soc_brain/branches/')), 'main projection scanned');
  assert.equal(calls[calls.length - 1], 'cleanup', 'cleanup runs LAST');
  // Read-back evidence: session REALLY terminal COMPLETED (TASK_COMPLETED).
  const persisted = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(persisted.state, 'COMPLETED');
  assert.ok(persisted.lifecycle.some((e) => e.event === 'TASK_COMPLETED'));
  // Delivery ledger holds the canonical delivery evidence.
  const ledger = readDeliveryLedger({ stateDir, identityHash: ID });
  assert.ok(ledger && ledger.merged && /^[0-9a-f]{40}$/.test(ledger.merged.mergeCommitSha), 'merge evidence persisted');
  assert.ok(ledger.closed, 'close evidence persisted');
  assert.ok(ledger.synced && ledger.synced.mergeCommitReachable, 'main projection persisted');
  assert.ok(ledger.cleanup, 'cleanup evidence persisted');
  // Loop ledger ends at the canonical COMPLETED boundary.
  const tos = readTransitions({ stateDir, identityHash: ID }).map((r) => r.to);
  assert.equal(tos[tos.length - 1], 'COMPLETED');
});

test('F2. REWORK never enters delivery: no PR/merge/close while rework leg runs', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir } });
  const execPath = path.join(stateDir, 'executions', `${ID}.json`);
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.writeFileSync(execPath, JSON.stringify({ schemaVersion: '1', kind: 'ExecutionRecord', identityHash: ID, terminalStatus: 'ok', exitCode: 0 }), 'utf8');
  const calls = [];
  const { deps } = happyDeps(stateDir, calls);
  const rw = { verdict: 'REWORK', findings: ['fix'], evidenceRequests: [], confidence: 0.8, metadata: {}, binding: { repository: 'duongpdddic-droid/soc_brain', issue: ISSUE, headSha: HEAD } };
  const pass = { verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.99, metadata: {} };
  let n = 0;
  deps.finalReview = () => { calls.push('finalReview'); n += 1; return { ok: true, value: n === 1 ? rw : pass }; };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  // REWORK round 1 re-executed; delivery mutations only AFTER the round-2 PASS.
  const firstRemoteIdx = calls.findIndex(isRemote);
  assert.ok(firstRemoteIdx > calls.indexOf('executor'), 'no remote delivery mutation before the executor ran');
  assert.equal(calls.filter((c) => c === 'executor').length, 2, 'initial + one rework dispatch');
  const tos = readTransitions({ stateDir, identityHash: ID }).map((r) => `${r.from}->${r.to}`);
  assert.ok(tos.includes('DECIDING->REWORK'), 'rework leg recorded');
  assert.equal(tos.filter((t) => t === 'DECIDING->DELIVERING').length, 1, 'exactly one delivery boundary, after the rework leg');
});

test('F3. wrong/stale binding never merges: session head != approved head -> DELIVERY_BIND_STALE', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { headSha: 'b'.repeat(40) });
  const calls = [];
  const { fx, deps } = happyDeps(stateDir, calls);
  // Validated decision binding echoes the APPROVED head, but the session is
  // pinned to a STALE head -> the delivery binding gate must refuse.
  deps.finalReview = () => ({ ok: true, value: { verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.99, metadata: {}, binding: { repository: 'duongpdddic-droid/soc_brain', issue: ISSUE, headSha: HEAD } } });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'DELIVER_STEP_FAILED');
  const inner = res.detail && res.detail.value ? res.detail.value : res.detail;
  assert.equal(inner && inner.code, 'DELIVERY_BIND_STALE');
  assert.equal(remoteCmds(calls).length, 0, 'zero remote mutations on stale binding');
  assert.equal(fx.state.merged, false);
  assert.equal(fx.state.closed, false);
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE', 'no terminalization on stale binding');
});

test('F4. merge failure -> no close, no cleanup, no terminalization', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const calls = [];
  const { fx, deps } = happyDeps(stateDir, calls, { mergeBehavior: () => ({ code: 1, stdout: '', stderr: 'gh: PR not mergeable (dirty)' }) });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false);
  const inner = res.detail && res.detail.value ? res.detail.value : res.detail;
  assert.equal(inner && inner.code, 'MERGE_FAILED');
  assert.ok(!remoteCmds(calls).some((c) => c.startsWith('issue close')), 'no issue close on merge failure');
  assert.ok(!calls.includes('cleanup'), 'no cleanup on merge failure');
  assert.equal(fx.state.closed, false);
  const ledger = readDeliveryLedger({ stateDir, identityHash: ID });
  assert.ok(ledger && ledger.pr && !ledger.merged && !ledger.closed, 'PR bound, merge/close never recorded');
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE', 'no TASK_COMPLETED');
});

test('F5. ambiguous merge result -> fail closed, then re-derive: exactly one merge', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { worktreePath: undefined });
  const calls1 = [];
  const fx1 = fakeGh({ issue: ISSUE, headSha: HEAD, baseSha: BASE, order: calls1, mergeBehavior: () => 'THROW' });
  const r1 = await runDeliveryLifecycle({ sessionPath, identityHash: ID, stateDir, issue: ISSUE, headSha: HEAD, deps: { gh: fx1.gh, cleanup: () => ({ ok: true, removed: [] }) } });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'DELIVERY_AMBIGUOUS');
  assert.equal(r1.detail && r1.detail.step, 'merge');
  assert.ok(!readDeliveryLedger({ stateDir, identityHash: ID }).merged, 'no merge evidence without read-back');
  // Re-enter with a healthy transport: the merge runs ONCE (verify-first, no
  // blind duplicate of an unknown-outcome call pattern without state proof).
  const calls2 = [];
  const fx2 = fakeGh({ issue: ISSUE, headSha: HEAD, baseSha: BASE, order: calls2 });
  const r2 = await runDeliveryLifecycle({ sessionPath, identityHash: ID, stateDir, issue: ISSUE, headSha: HEAD, deps: { gh: fx2.gh, cleanup: () => ({ ok: true, removed: [] }) } });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(calls2.filter((c) => c.startsWith('pr merge')).length, 1, 'exactly one merge after ambiguity recovery');
  assert.equal(fx2.state.merged, true);
});

test('F6. merge happened but ledger lost (crash before read-back) -> resume adopts MERGED, never re-merges', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { worktreePath: undefined });
  const calls = [];
  const fx = fakeGh({ issue: ISSUE, headSha: HEAD, baseSha: BASE, order: calls });
  // Simulate the crash window: the remote ALREADY merged (side effect real),
  // while the local delivery ledger holds nothing yet.
  fx.state.merged = true;
  fx.state.mergeCommitOid = 'd'.repeat(40);
  const r = await runDeliveryLifecycle({ sessionPath, identityHash: ID, stateDir, issue: ISSUE, headSha: HEAD, deps: { gh: fx.gh, cleanup: () => ({ ok: true, removed: [] }) } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(calls.filter((c) => c.startsWith('pr merge')).length, 0, 'resume NEVER re-merges an already-merged PR');
  assert.equal(r.value.merged.mergeCommitSha, 'd'.repeat(40));
  const ledger = readDeliveryLedger({ stateDir, identityHash: ID });
  assert.ok(ledger.merged && ledger.closed, 'resume records the read-back evidence');
});

test('F7. issue close failure -> merge evidence preserved, close retryable, no terminalization', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { worktreePath: undefined });
  const calls1 = [];
  const fx1 = fakeGh({ issue: ISSUE, headSha: HEAD, baseSha: BASE, order: calls1, closeBehavior: () => ({ code: 1, stdout: '', stderr: 'gh: close rejected' }) });
  const r1 = await runDeliveryLifecycle({ sessionPath, identityHash: ID, stateDir, issue: ISSUE, headSha: HEAD, deps: { gh: fx1.gh, cleanup: () => ({ ok: true, removed: [] }) } });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'ISSUE_CLOSE_FAILED');
  const l1 = readDeliveryLedger({ stateDir, identityHash: ID });
  assert.ok(l1.merged, 'merge evidence survives the close failure');
  assert.ok(!l1.closed && !l1.cleanup, 'close/cleanup not recorded');
  const calls2 = [];
  const fx2 = fakeGh({ issue: ISSUE, headSha: HEAD, baseSha: BASE, order: calls2 });
  // The remote world persists across resume: the merge from run-1 is real.
  fx2.state.merged = true;
  fx2.state.mergeCommitOid = 'd'.repeat(40);
  const r2 = await runDeliveryLifecycle({ sessionPath, identityHash: ID, stateDir, issue: ISSUE, headSha: HEAD, deps: { gh: fx2.gh, cleanup: () => ({ ok: true, removed: [] }) } });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(calls2.filter((c) => c.startsWith('pr merge')).length, 0, 'resume never re-merges');
  assert.equal(calls2.filter((c) => c.startsWith('issue close')).length, 1, 'resume closes the issue exactly once');
});

test('F8. cleanup failure preserves canonical delivery evidence; resume completes without duplicate side effects', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const calls1 = [];
  const { fx: fx1, deps: d1 } = happyDeps(stateDir, calls1, {});
  d1.delivery = buildDeliveryAdapter({
    gh: fx1.gh,
    cleanup: () => ({ ok: false, reason: 'CLEANUP_VERIFY_FAILED', detail: 'binding mismatch' }),
  });
  const r1 = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: d1 });
  assert.equal(r1.ok, false);
  const l1 = readDeliveryLedger({ stateDir, identityHash: ID });
  assert.ok(l1.merged && l1.closed && l1.synced, 'merge/close/projection evidence intact after cleanup failure');
  assert.ok(!l1.cleanup, 'cleanup evidence not fabricated');
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE', 'no TASK_COMPLETED on cleanup failure');
  // Resume: cleanup-only re-entry completes; no merge/close ever repeats.
  const calls2 = [];
  const { fx: fx2, deps: d2 } = happyDeps(stateDir, calls2, {});
  const res2 = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: d2 });
  assert.equal(res2.ok, true, JSON.stringify(res2));
  assert.equal(res2.value.state, 'COMPLETED');
  assert.equal(remoteCmds(calls2).filter((c) => c.startsWith('pr merge') || c.startsWith('issue close')).length, 0, 'zero repeated mutations on resume');
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'COMPLETED');
});

test('F9. TASK_COMPLETED is claimed only after the REAL persisted terminal state (no fake COMPLETED)', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const calls = [];
  const { deps } = happyDeps(stateDir, calls);
  // Simulate persistence loss for the terminal transition: drop the FIRST
  // write to the session record (the terminal state persist). The terminalize
  // result then disagrees with the canonical record and the loop MUST fail
  // closed instead of reporting a computed COMPLETED.
  const origWrite = fs.writeFileSync;
  let dropped = false;
  fs.writeFileSync = function patchedWrite(p, data, opts) {
    if (!dropped && String(p) === sessionPath) { dropped = true; return undefined; }
    return origWrite.call(fs, p, data, opts);
  };
  let res;
  try {
    res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  } finally {
    fs.writeFileSync = origWrite;
  }
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.ok(['TERMINALIZE_FAILED', 'TERMINAL_STATE_VERIFY_FAILED'].includes(res.code), `fail-closed code, got ${res.code}`);
  const persisted = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.notEqual(persisted.state, 'COMPLETED', 'no fabricated terminal state');
  assert.ok(!persisted.lifecycle || !persisted.lifecycle.some((e) => e.event === 'TASK_COMPLETED'), 'no TASK_COMPLETED without a real terminal transition');
});

test('F10. replay after success: ledger-first resume issues ZERO remote mutations', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const calls = [];
  const { deps } = happyDeps(stateDir, calls);
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  // Replay the lifecycle directly with a FRESH transport: the ledger proves
  // every stage already completed, so nothing may run again.
  const replay = [];
  const fx2 = fakeGh({ issue: ISSUE, headSha: HEAD, baseSha: BASE, order: replay });
  const r2 = await runDeliveryLifecycle({ sessionPath, identityHash: ID, stateDir, issue: ISSUE, headSha: HEAD, deps: { gh: fx2.gh, cleanup: () => { replay.push('cleanup'); return { ok: true, removed: [] }; } } });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(remoteCmds(replay).length, 0, 'zero remote commands on replay');
});

test('F11. crash between the boundary and completion: DELIVERING-tail resume dedupes the notification and completes exactly once', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const spawnCalls = [];
  const probe = () => { spawnCalls.push('send'); return { stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 901 })}\n` }; };
  const calls1 = [];
  const { fx: fx1, deps: d1 } = happyDeps(stateDir, calls1, { closeBehavior: () => ({ code: 1, stdout: '', stderr: 'gh: close rejected' }) });
  d1.telegramSpawn = probe;
  const r1 = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: d1 });
  assert.equal(r1.ok, false);
  assert.equal(spawnCalls.length, 1, 'run-1 delivered the notification exactly once');
  const tos1 = readTransitions({ stateDir, identityHash: ID });
  assert.equal(tos1[tos1.length - 1].to, 'DELIVERING', 'failure leaves the loop at the recoverable DELIVERING tail');
  // Resume with a healthy world (the run-1 merge is real on the remote).
  const calls2 = [];
  const { fx: fx2, deps: d2 } = happyDeps(stateDir, calls2, {});
  fx2.state.merged = true;
  fx2.state.mergeCommitOid = 'd'.repeat(40);
  d2.telegramSpawn = probe;
  const r2 = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: d2 });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.value.state, 'COMPLETED');
  assert.equal(spawnCalls.length, 1, 'resume NEVER re-sends the notification (dispatch-ledger dedupe)');
  assert.equal(remoteCmds(calls2).filter((c) => c.startsWith('pr merge')).length, 0, 'resume never re-merges');
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'COMPLETED');
});

test('F12. delivery spec + binding guards: foreign repo/stale head/ledger conflict fail closed before any mutation', async () => {
  // Spec guards.
  assert.equal(deliverySpec({ issue: 0, headSha: HEAD }).code, 'DELIVERY_SPEC_INVALID');
  assert.equal(deliverySpec({ issue: 81, headSha: 'nothex' }).code, 'DELIVERY_SPEC_INVALID');
  assert.equal(deliverySpec({ repo: 'other/repo', issue: 81, headSha: HEAD }).code, 'DELIVERY_SPEC_INVALID');
  const good = deliverySpec({ issue: 81, headSha: HEAD.toUpperCase() });
  assert.equal(good.ok, true);
  assert.equal(good.value.repo, 'duongpdddic-droid/soc_brain');
  assert.equal(good.value.headSha, HEAD);
  // Foreign session repo.
  const s1 = mkStateDir();
  const f1 = mkSession(s1, { repo: 'other/repo', worktreePath: undefined });
  const fx1 = fakeGh({ issue: 81, headSha: HEAD, baseSha: BASE, order: [] });
  const r1 = await runDeliveryLifecycle({ sessionPath: f1.sessionPath, identityHash: f1.id, stateDir: s1, issue: 81, headSha: HEAD, deps: { gh: fx1.gh } });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'DELIVERY_BIND_FAILED');
  // Ledger conflict: a ledger bound to a different approved head refuses.
  const s2 = mkStateDir();
  const f2 = mkSession(s2, { worktreePath: undefined });
  const ledgerPath = path.join(s2, 'control-loop', f2.id, 'delivery.json');
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify({ schemaVersion: '1', kind: 'delivery-ledger', identityHash: f2.id, spec: { repo: 'duongpdddic-droid/soc_brain', issue: ISSUE, headSha: '9'.repeat(40) } }), 'utf8');
  const fx2 = fakeGh({ issue: ISSUE, headSha: HEAD, baseSha: BASE, order: [] });
  const r2 = await runDeliveryLifecycle({ sessionPath: f2.sessionPath, identityHash: f2.id, stateDir: s2, issue: ISSUE, headSha: HEAD, deps: { gh: fx2.gh } });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'DELIVERY_LEDGER_CONFLICT');
});