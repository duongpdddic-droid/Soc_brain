#!/usr/bin/env node
// merge-authorization.test.mjs — Issue #175 REWORK locked-P0 regressions.
// Proves the canonical delivery leg CONSUMES an exact human merge authorization
// before it may squash-merge, and that neither GPT PASS nor the authorization can
// substitute for the other. Deterministic (in-memory fake gh, temp stateDir), no
// network. Maps to R1-R9, R11 (R10 lives in client-mcp.test.mjs; R3 at loop level).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDeliveryLifecycle, readDeliveryLedger } from '../packages/control-loop/delivery.mjs';
import { runControlLoop } from '../packages/control-loop/control-loop.mjs';
import { buildDeliveryAdapter } from '../packages/control-loop/adapters.mjs';
import {
  writeMergeAuthorization, verifyMergeAuthorization, readMergeAuthorization,
} from '../packages/control-loop/merge-authorization.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { fakeGh } from './fake-gh.mjs';

const CANON = 'duongpdddic-droid/soc_brain';
const HEAD = 'a'.repeat(40);
const BASE = 'f'.repeat(40);
const ISSUE = 81;
const PR = 80;

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ma-')); }
function mkSession(stateDir, { repo = CANON, issueNumber = ISSUE, headSha = HEAD } = {}) {
  const id = identityHash({ repo, issueNumber });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, JSON.stringify({
    schemaVersion: '1', state: 'SESSION_ACTIVE', lifecycle: [], taskId: `${repo}#${issueNumber}`,
    repo, issueNumber, headSha, baseSha: BASE, worktreePath: undefined, worktreesRoot: stateDir,
  }), 'utf8');
  return { sessionPath, id };
}
const grant = (stateDir, id, o = {}) => writeMergeAuthorization({
  stateDir, identityHash: id, repo: CANON, issue: ISSUE, pullRequest: PR, reviewedHeadSha: HEAD,
  authorizedBy: 'human:bob', clientRequestId: 'auth-12345678', ...o,
});
const mergeCmds = (calls) => calls.filter((c) => c.startsWith('pr merge'));

// ---- producer/consumer contract ---------------------------------------------
test('M0 write+verify: exact binding accepted; schema is DATA-only (performsMerge:false)', () => {
  const sd = mkStateDir(); const { id } = mkSession(sd);
  const w = grant(sd, id);
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.equal(w.replayed, false);
  const v = verifyMergeAuthorization({ stateDir: sd, identityHash: id, repo: CANON, issue: ISSUE, pullRequest: PR, reviewedHeadSha: HEAD });
  assert.ok(v.ok, JSON.stringify(v));
  assert.equal(v.record.performsMerge, false);
});

test('M1 idempotent identical replay; conflicting replay fails closed (R8/R9 producer side)', () => {
  const sd = mkStateDir(); const { id } = mkSession(sd);
  assert.equal(grant(sd, id).replayed, false);
  const rereplay = grant(sd, id);
  assert.equal(rereplay.ok, true);
  assert.equal(rereplay.replayed, true, 'identical authorization replay is idempotent');
  const conflict = grant(sd, id, { pullRequest: 999, clientRequestId: 'auth-other1' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'MERGE_AUTH_DUPLICATE_CONFLICT');
});

test('M2 no authorization record -> verify fails closed MERGE_AUTHORIZATION_REQUIRED', () => {
  const sd = mkStateDir(); const { id } = mkSession(sd);
  const v = verifyMergeAuthorization({ stateDir: sd, identityHash: id, repo: CANON, issue: ISSUE, pullRequest: PR, reviewedHeadSha: HEAD });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'MERGE_AUTHORIZATION_REQUIRED');
});

// ---- R1: final PASS + NO authorization => zero merge ------------------------
test('R1 delivery with NO authorization performs ZERO merge', async () => {
  const sd = mkStateDir(); const { sessionPath, id } = mkSession(sd);
  const calls = [];
  const fx = fakeGh({ issue: ISSUE, headSha: HEAD, baseSha: BASE, order: calls });
  const r = await runDeliveryLifecycle({ sessionPath, identityHash: id, stateDir: sd, issue: ISSUE, headSha: HEAD, deps: { gh: fx.gh, cleanup: () => ({ ok: true, removed: [] }) } });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'MERGE_AUTHORIZATION_REQUIRED');
  assert.equal(mergeCmds(calls).length, 0, 'zero `gh pr merge` without authorization');
  assert.equal(fx.state.merged, false);
  assert.ok(!readDeliveryLedger({ stateDir: sd, identityHash: id })?.merged, 'no merge evidence');
});

// ---- R2: exact final PASS + exact authorization => may merge ----------------
test('R2 delivery with exact authorization merges (canonical path)', async () => {
  const sd = mkStateDir(); const { sessionPath, id } = mkSession(sd);
  grant(sd, id);
  const calls = [];
  const fx = fakeGh({ issue: ISSUE, headSha: HEAD, baseSha: BASE, order: calls });
  const r = await runDeliveryLifecycle({ sessionPath, identityHash: id, stateDir: sd, issue: ISSUE, headSha: HEAD, deps: { gh: fx.gh, cleanup: () => ({ ok: true, removed: [] }) } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(mergeCmds(calls).length, 1, 'exactly one merge');
  assert.equal(fx.state.merged, true);
});

// ---- R4: stale authorized HEAD => zero merge --------------------------------
test('R4 stale authorized HEAD (auth for a different head) => zero merge', async () => {
  const sd = mkStateDir(); const { sessionPath, id } = mkSession(sd);
  grant(sd, id, { reviewedHeadSha: 'e'.repeat(40), clientRequestId: 'auth-old-head' });
  const calls = [];
  const fx = fakeGh({ issue: ISSUE, headSha: HEAD, baseSha: BASE, order: calls });
  const r = await runDeliveryLifecycle({ sessionPath, identityHash: id, stateDir: sd, issue: ISSUE, headSha: HEAD, deps: { gh: fx.gh, cleanup: () => ({ ok: true, removed: [] }) } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MERGE_AUTH_HEAD_STALE');
  assert.equal(mergeCmds(calls).length, 0);
});

// ---- R5: wrong PR => zero merge --------------------------------------------
test('R5 authorization for a different PR => zero merge', async () => {
  const sd = mkStateDir(); const { sessionPath, id } = mkSession(sd);
  grant(sd, id, { pullRequest: 999, clientRequestId: 'auth-wrong-pr' });
  const calls = [];
  const fx = fakeGh({ issue: ISSUE, headSha: HEAD, baseSha: BASE, order: calls });
  const r = await runDeliveryLifecycle({ sessionPath, identityHash: id, stateDir: sd, issue: ISSUE, headSha: HEAD, deps: { gh: fx.gh, cleanup: () => ({ ok: true, removed: [] }) } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MERGE_AUTH_PR_MISMATCH');
  assert.equal(mergeCmds(calls).length, 0);
});

// ---- R6: wrong issue / wrong repo => zero merge -----------------------------
test('R6a authorization for a different issue => zero merge', async () => {
  const sd = mkStateDir(); const { sessionPath, id } = mkSession(sd);
  grant(sd, id, { issue: 999, clientRequestId: 'auth-wrong-issue' });
  const calls = [];
  const fx = fakeGh({ issue: ISSUE, headSha: HEAD, baseSha: BASE, order: calls });
  const r = await runDeliveryLifecycle({ sessionPath, identityHash: id, stateDir: sd, issue: ISSUE, headSha: HEAD, deps: { gh: fx.gh, cleanup: () => ({ ok: true, removed: [] }) } });
  assert.equal(r.ok, false); assert.equal(r.code, 'MERGE_AUTH_ISSUE_MISMATCH');
  assert.equal(mergeCmds(calls).length, 0);
});
test('R6b authorization bound to a foreign repository => zero merge', async () => {
  const sd = mkStateDir(); const { sessionPath, id } = mkSession(sd);
  grant(sd, id, { repo: 'evil/repo', clientRequestId: 'auth-foreign-repo' });
  const calls = [];
  const fx = fakeGh({ issue: ISSUE, headSha: HEAD, baseSha: BASE, order: calls });
  const r = await runDeliveryLifecycle({ sessionPath, identityHash: id, stateDir: sd, issue: ISSUE, headSha: HEAD, deps: { gh: fx.gh, cleanup: () => ({ ok: true, removed: [] }) } });
  assert.equal(r.ok, false); assert.equal(r.code, 'MERGE_AUTH_REPO_MISMATCH');
  assert.equal(mergeCmds(calls).length, 0);
});

// ---- R7: HEAD advances AFTER authorization => authorization invalid ---------
test('R7 HEAD changes after authorization => the new merge head is unauthorized, zero merge', async () => {
  const sd = mkStateDir();
  const HEAD2 = 'b'.repeat(40);
  const { sessionPath, id } = mkSession(sd, { headSha: HEAD2 });       // loop re-pinned to a new head
  grant(sd, id, { reviewedHeadSha: HEAD, clientRequestId: 'auth-pre-headshift' }); // authorized OLD head
  const calls = [];
  const fx = fakeGh({ issue: ISSUE, headSha: HEAD2, baseSha: BASE, order: calls });
  const r = await runDeliveryLifecycle({ sessionPath, identityHash: id, stateDir: sd, issue: ISSUE, headSha: HEAD2, deps: { gh: fx.gh, cleanup: () => ({ ok: true, removed: [] }) } });
  assert.equal(r.ok, false); assert.equal(r.code, 'MERGE_AUTH_HEAD_STALE');
  assert.equal(mergeCmds(calls).length, 0);
  assert.equal(fx.state.merged, false);
});

// ---- R11: existing delivery HEAD-mismatch protection still fires (ordering) --
test('R11 remote PR head drift is caught by the pre-existing HEAD guard before any auth is consulted', async () => {
  const sd = mkStateDir(); const { sessionPath, id } = mkSession(sd);
  const sess = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  sess.prNumber = PR;                                        // adopted existing PR
  fs.writeFileSync(sessionPath, JSON.stringify(sess, null, 2), 'utf8');
  grant(sd, id); // a valid authorization exists at HEAD...
  const calls = [];
  const fx = fakeGh({ issue: ISSUE, headSha: 'c'.repeat(40), baseSha: BASE, order: calls }); // ...but the remote PR sits at a different head
  const r = await runDeliveryLifecycle({ sessionPath, identityHash: id, stateDir: sd, issue: ISSUE, headSha: HEAD, deps: { gh: fx.gh, cleanup: () => ({ ok: true, removed: [] }) } });
  assert.equal(r.ok, false);
  // The pre-existing head guard fires first (ensurePr PR_HEAD_MISMATCH / mergePr
  // MERGE_HEAD_MISMATCH); the authorization is never the reason it stops.
  assert.ok(['PR_HEAD_MISMATCH', 'MERGE_HEAD_MISMATCH'].includes(r.code), `expected a HEAD-mismatch guard, got ${r.code}`);
  assert.equal(mergeCmds(calls).length, 0);
  assert.equal(fx.state.merged, false);
});

// ---- R3: authorization present but NO final PASS => loop never merges --------
test('R3 an authorization never substitutes for GPT PASS: loop with no PASS does not merge', async () => {
  const sd = mkStateDir(); const { sessionPath, id } = mkSession(sd);
  grant(sd, id); // authorization exists, but there is no validated PASS
  const execId = id;
  const execPath = path.join(sd, 'executions', `${execId}.json`);
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.writeFileSync(execPath, JSON.stringify({ schemaVersion: '1', kind: 'ExecutionRecord', identityHash: execId, terminalStatus: 'ok', exitCode: 0 }), 'utf8');
  const calls = [];
  const fx = fakeGh({ issue: ISSUE, headSha: HEAD, baseSha: BASE, order: calls });
  const deliverySpy = { called: false };
  const rework = { verdict: 'REWORK', findings: ['x'], evidenceRequests: [], confidence: 0.5, metadata: {}, binding: { repository: CANON, issue: ISSUE, headSha: HEAD } };
  const deps = {
    pushExec: undefined,
    router: () => ({ ok: true, value: { executorKind: 'opencode', model: 'x' } }),
    executor: () => ({ ok: true, value: { executionRecordPath: execPath } }),
    verifier: () => ({ ok: true, value: { verdict: 'PASS', report: 'ok' } }),
    preReview: () => ({ ok: true, value: { verdict: 'PASS', findings: [] } }),
    finalReview: () => { calls.push('finalReview'); return { ok: true, value: rework }; }, // never PASS
    delivery: async () => { deliverySpy.called = true; return { ok: true, value: { shipped: true } }; },
    reviewReadyDir: path.join(sd, 'review-ready'),
    telegramSpawn: () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 1 })}\n` }),
  };
  const res = await runControlLoop({ sessionPath, identityHash: id, stateDir: sd, deps });
  // Rework budget exhausts -> BLOCKED; the delivery/merge leg is NEVER entered.
  assert.equal(res.ok, false);
  assert.notEqual(res.value && res.value.state, 'COMPLETED');
  assert.equal(deliverySpy.called, false, 'no delivery without a validated PASS even with an authorization present');
  assert.equal(mergeCmds(calls).length, 0);
});

// ---- buildDeliveryAdapter integration: no auth -> the loop's delivery fails ---
test('R1b buildDeliveryAdapter (real consumer wiring) refuses to merge without an authorization', async () => {
  const sd = mkStateDir(); const { sessionPath, id } = mkSession(sd);
  // session must carry controlPlane.stateDir so the adapter resolves the store.
  const sess = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  sess.controlPlane = { stateDir: sd };
  fs.writeFileSync(sessionPath, JSON.stringify(sess, null, 2), 'utf8');
  const calls = [];
  const fx = fakeGh({ issue: ISSUE, headSha: HEAD, baseSha: BASE, order: calls });
  const delivery = buildDeliveryAdapter({ gh: fx.gh, cleanup: () => ({ ok: true, removed: [], keptBranch: 'x' }) });
  const r = await delivery({ sessionPath, decision: { binding: { repository: CANON, issue: ISSUE, headSha: HEAD } } });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'MERGE_AUTHORIZATION_REQUIRED');
  assert.equal(mergeCmds(calls).length, 0);
});

// ---- R13 (REWORK F1): the head-shift recovery lifecycle ----------------------
test('R13 authorize H1 -> HEAD H2 -> H1 stale/zero-merge -> PASS@H2 authorize H2 succeeds -> H2 replay idempotent -> H1 immutable+unusable at H2 -> delivery@H2 merges exactly once', async () => {
  const sd = mkStateDir();
  const H1 = 'a'.repeat(40); const H2 = 'b'.repeat(40); const H3 = 'c'.repeat(40);
  const { sessionPath, id } = mkSession(sd, { headSha: H1 });

  // (1) human authorizes the reviewed HEAD H1.
  const w1 = grant(sd, id, { reviewedHeadSha: H1, clientRequestId: 'r13-h1-aaaa' });
  assert.ok(w1.ok, JSON.stringify(w1)); assert.equal(w1.replayed, false);
  assert.equal(verifyMergeAuthorization({ stateDir: sd, identityHash: id, repo: CANON, issue: ISSUE, pullRequest: PR, reviewedHeadSha: H1 }).ok, true);

  // (2) HEAD moves to H2 (re-review -> PASS@H2). Delivery merges at H2.
  const sess = JSON.parse(fs.readFileSync(sessionPath, 'utf8')); sess.headSha = H2; fs.writeFileSync(sessionPath, JSON.stringify(sess, null, 2), 'utf8');
  let calls = [];
  let fx = fakeGh({ issue: ISSUE, headSha: H2, baseSha: BASE, order: calls });
  let r = await runDeliveryLifecycle({ sessionPath, identityHash: id, stateDir: sd, issue: ISSUE, headSha: H2, deps: { gh: fx.gh, cleanup: () => ({ ok: true, removed: [] }) } });
  assert.equal(r.ok, false); assert.equal(r.code, 'MERGE_AUTH_HEAD_STALE'); // auth@H1 must NOT authorize H2
  assert.equal(mergeCmds(calls).length, 0, 'zero merge at H2 while only H1 is authorized');
  assert.equal(fx.state.merged, false);

  // (3) after a valid PASS@H2 the human can authorize H2 (the F1 recovery — no conflict).
  const w2 = grant(sd, id, { reviewedHeadSha: H2, clientRequestId: 'r13-h2-bbbb' });
  assert.ok(w2.ok, JSON.stringify(w2));
  assert.equal(w2.replayed, false);
  assert.notEqual(w2.code, 'MERGE_AUTH_DUPLICATE_CONFLICT', 'authorizing a new HEAD must not be a duplicate conflict');

  // (4) identical H2 replay stays idempotent.
  const w2b = grant(sd, id, { reviewedHeadSha: H2, clientRequestId: 'r13-h2-bbbb' });
  assert.ok(w2b.ok); assert.equal(w2b.replayed, true);

  // (5) H1 is immutable + still present (not overwritten); a different HEAD (H3) is still stale.
  const rd = readMergeAuthorization({ stateDir: sd, identityHash: id });
  assert.ok(rd.ok && Array.isArray(rd.records));
  assert.ok(rd.records.some((x) => x.bound.reviewedHeadSha === H1), 'H1 record remains (immutable)');
  assert.ok(rd.records.some((x) => x.bound.reviewedHeadSha === H2), 'H2 record present');
  assert.equal(verifyMergeAuthorization({ stateDir: sd, identityHash: id, repo: CANON, issue: ISSUE, pullRequest: PR, reviewedHeadSha: H3 }).code, 'MERGE_AUTH_HEAD_STALE');

  // (6) delivery@H2 now accepts the H2 authorization and merges EXACTLY once.
  calls = [];
  fx = fakeGh({ issue: ISSUE, headSha: H2, baseSha: BASE, order: calls });
  r = await runDeliveryLifecycle({ sessionPath, identityHash: id, stateDir: sd, issue: ISSUE, headSha: H2, deps: { gh: fx.gh, cleanup: () => ({ ok: true, removed: [] }) } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(mergeCmds(calls).length, 1, 'exactly one merge, authorized at H2');
  assert.equal(fx.state.merged, true);
});
