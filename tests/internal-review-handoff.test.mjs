// tests/internal-review-handoff.test.mjs — OCR internal review -> Soc Loop ->
// handoff gate -> checklist (targeted verification matrix).
//
// Covers, with real loop/packet/checklist code and deterministic offline
// transports:
//   T1  missing OCR review record  -> INTERNAL_REVIEW_PENDING, NO packet,
//       no READY_FOR_REVIEW, never reaches the reviewers/delivery
//   T2  stale review (session head moved / live HEAD moved / content changed
//       after the review) and unresolved findings -> typed refusal, NO packet
//   T3  findings -> bounded rework round -> clean review -> READY_FOR_REVIEW
//       packet + checklist DONE items
//   T4  interruption + resume: the verify step (and therefore the OCR review)
//       is invoked exactly ONCE across the two runs — no duplicate invocation
//   T5  checklist is a read-only projection: DONE only with a valid record,
//       a passing required gate NEVER marks the OCR item DONE, and the
//       projection mutates no session/ledger bytes
//   T6  rework require-policy refusal stays recoverable at the VERIFYING
//       checkpoint (never a terminal block)
//   T7  H1: a TRACKED .opencode edit after the review with HEAD UNCHANGED is
//       proven stale by the canonical content-binding primitive
//   T8  H2: gate/final-review checklist items are DONE only when bound to the
//       CURRENT candidate — missing binding, stale binding, contradictory
//       evidence and PASS+exitCode!=0 are never DONE/COMPLETE
//   T9  H3: a fresh handoff refusal is recorded at the verify boundary and a
//       resume with a valid verifier PROGRESSES without re-dispatching the
//       executor (T4's no-duplicate-OCR resume stays intact)
//   T10 H4: an adoption mode without an OCR record describes the exemption —
//       never "APPROVED clean" / unproven zero findings

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  runControlLoop,
  readTransitions,
  projectReviewReadyPacket,
} from '../packages/control-loop/control-loop.mjs';
import {
  buildHandoffChecklist,
  projectHandoffChecklist,
  CHECKLIST_ITEM_IDS,
} from '../packages/control-loop/handoff-checklist.mjs';
import { computeWorktreeContentBinding } from '../packages/executor-launcher/execution-content-binding.mjs';
import { cleanPathspecsForPush } from '../packages/control-loop/push.mjs';
import { writeMergeAuthorization } from '../packages/control-loop/merge-authorization.mjs';
import { readSessionRecord } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { withOcrInternalReview, fixtureInternalReview, FIXTURE_CONTENT_DIGEST } from './fixtures/ocr-internal-review.mjs';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const BASE = 'f'.repeat(40);
const ISSUE = 9001;
const BRANCH = 'soc/issue-9001-handoff';
const REPO = 'duongpdddic-droid/soc_brain';
const ID = identityHash({ repo: REPO, issueNumber: ISSUE });

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ir-handoff-')); }

function mkSession(stateDir, overrides = {}) {
  const sessionPath = path.join(stateDir, 'sessions', `${ID}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1', state: 'SESSION_ACTIVE', lifecycle: [],
    taskId: `${REPO}#${ISSUE}`, repo: REPO, issueNumber: ISSUE,
    prNumber: 4242, headSha: HEAD_A, baseSha: BASE, branch: BRANCH,
    worktreePath: path.join(stateDir, 'wt'), worktreesRoot: stateDir,
    controlPlane: { stateDir },
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session };
}

// Canonical ledger writers for the handoff unit cases (same JSONL shape
// loop.step appends; the admission fence is disarmed offline).
function writeLedger(stateDir, records) {
  const dir = path.join(stateDir, 'control-loop', ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transitions.jsonl'),
    records.map((r) => JSON.stringify({ schemaVersion: '1', identityHash: ID, ...r })).join('\n'), 'utf8');
}
function boundary(evidence) {
  return { ts: '2026-10-05T00:00:00.000Z', from: 'VERIFYING', to: 'PRE_REVIEWING', reason: null, evidence };
}

// Content-binding injection for fixtures whose fake worktree is not a real git
// repository: the HANDOFF CHECK still goes through the canonical
// computeWorktreeContentBinding seam (io.computeBinding) — production defaults
// to the real primitive, only offline fixtures substitute the digest/head.
function bindingIo({ headSha, contentDigest = FIXTURE_CONTENT_DIGEST }) {
  return { computeBinding: () => ({ ok: true, value: { headSha, contentDigest } }) };
}
function brokenBindingIo(reason = 'HEAD unavailable: not a git repository') {
  return { computeBinding: () => ({ ok: false, reason }) };
}

// Deterministic in-memory git covering exactly what the publish chain, the
// handoff freshness check (rev-parse/status --porcelain) and the rework
// refresh use. `state` is shared so a test can move HEAD or inject dirt
// BETWEEN two loop phases.
function fakeGit(state = { head: HEAD_A, remoteRef: null, pushes: 0, dirty: '' }) {
  const exec = (a0, opts) => {
    const a = (Array.isArray(a0) ? a0 : (opts && opts.args) || []).map(String);
    if (a[0] === 'rev-parse' && a[1] === 'HEAD') return { status: 0, stdout: `${state.head}\n`, stderr: '' };
    if (a[0] === 'status') return { status: 0, stdout: state.dirty ? `${state.dirty}\n` : '', stderr: '' };
    if (a[0] === 'diff') return { status: state.head === BASE ? 0 : 1, stdout: '', stderr: '' };
    if (a[0] === 'merge-base') return { status: 0, stdout: '', stderr: '' };
    if (a[0] === 'ls-remote') return { status: 0, stdout: state.remoteRef ? `${state.remoteRef}\t${a[2]}\n` : '', stderr: '' };
    if (a[0] === 'push') { state.remoteRef = a[2].split(':')[0]; state.pushes += 1; return { status: 0, stdout: '', stderr: '' }; }
    if (a[0] === 'show') return { status: 1, stdout: '', stderr: '' };
    if (a[0] === 'log') return { status: 0, stdout: '', stderr: '' };
    if (a[0] === 'ls-files') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: `unmocked git: ${a.join(' ')}` };
  };
  return { state, exec };
}

function fakeGh(state, { issue = ISSUE, branch = BRANCH, number = 4242 } = {}) {
  const calls = [];
  const j = (code, obj, stderr = '') => ({ code, stdout: obj === undefined ? '' : JSON.stringify(obj), stderr });
  const gh = (args) => {
    const a = args.map(String);
    calls.push(a.join(' '));
    if (a[0] === 'issue' && a[1] === 'view') return j(0, { title: 'handoff gate task', body: 'acceptance' });
    if (a[0] === 'pr' && a[1] === 'list') return j(0, []);
    if (a[0] === 'pr' && a[1] === 'create') { state.remoteRef = state.remoteRef ?? state.head; return { code: 0, stdout: `https://github.com/${REPO}/pull/${number}\n`, stderr: '' }; }
    if (a[0] === 'pr' && a[1] === 'view') {
      return j(0, { number, state: 'OPEN', headRefOid: state.remoteRef ?? state.head, headRefName: branch, baseRefName: 'main', headRepository: { nameWithOwner: REPO }, url: `https://github.com/${REPO}/pull/${number}`, body: `Closes #${issue}\n\n<!-- soc-brain:identity=${ID} -->` });
    }
    return j(1, undefined, 'unmocked gh');
  };
  gh.calls = calls;
  return gh;
}

const packetsIn = (stateDir) => {
  try { return fs.readdirSync(path.join(stateDir, 'review-ready')); } catch { return []; }
};
const packetTexts = (stateDir) => packetsIn(stateDir).map((f) => fs.readFileSync(path.join(stateDir, 'review-ready', f), 'utf8'));

function loopDeps({ git, gh, verifier, preReview, finalReview, executor }) {
  return {
    pushExec: git.exec,
    gh,
    router: () => ({ ok: true, value: { executorKind: 'opencode', model: 'x' } }),
    executor: executor ?? (() => ({ ok: true, value: { executionRecordPath: 'x' } })),
    verifier,
    // Handoff freshness goes through the canonical content-binding seam; the
    // fixture worktree is not a real repository, so the binding is supplied
    // from the harness' git state (same head + the fixture content digest the
    // fixture OCR record carries).
    internalReviewIo: { computeBinding: () => ({ ok: true, value: { headSha: git.state.head, contentDigest: FIXTURE_CONTENT_DIGEST } }) },
    preReview: preReview ?? (() => ({ ok: true, value: { verdict: 'PASS', findings: [] } })),
    // Production's raw-text verdict path (verdict-parser) stamps exactly this
    // session binding onto the decision; H2 requires the final review to be
    // bound to the current candidate before it may be DONE, so the fixture
    // models that bound decision (read live from the bound session).
    finalReview: finalReview ?? ((ctx) => {
      const rs = ctx && ctx.sessionPath ? readSessionRecord(ctx.sessionPath) : null;
      const head = rs && rs.ok && rs.session && typeof rs.session.headSha === 'string' ? rs.session.headSha : null;
      return {
        ok: true,
        value: {
          verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.99, metadata: {},
          ...(head ? { binding: { repository: REPO, issue: ISSUE, headSha: head } } : {}),
        },
      };
    }),
    delivery: () => ({ ok: true, value: { shipped: true } }),
    telegramSpawn: () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 1 })}\n` }),
  };
}

// ---- T1 ---------------------------------------------------------------------
test('T1. missing OCR review record -> INTERNAL_REVIEW_PENDING, no packet, reviewers never reached', async () => {
  const stateDir = mkStateDir();
  const { sessionPath } = mkSession(stateDir);
  const git = fakeGit();
  const gh = fakeGh(git.state);
  // The verifier PASSES the required gate but carries NO internal-review
  // record — proof that a green gate alone can never create READY_FOR_REVIEW.
  const deps = loopDeps({ git, gh, verifier: () => ({ ok: true, value: { verdict: 'PASS', report: 'gate-ok' } }) });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'INTERNAL_REVIEW_PENDING');
  assert.equal(packetsIn(stateDir).length, 0, 'no review-ready packet may exist without the OCR record');
  const tos = readTransitions({ stateDir, identityHash: ID }).map((r) => r.to);
  assert.ok(!tos.includes('DECIDING'), 'never reaches the final-review decision boundary');
  assert.ok(!tos.includes('DELIVERING'), 'never reaches the READY_FOR_REVIEW boundary');
  const s = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(s.state, 'SESSION_ACTIVE', 'no terminalization on a missing internal review');
  for (const text of packetTexts(stateDir)) assert.ok(!text.includes('READY_FOR_REVIEW'));
});

// ---- T2 ---------------------------------------------------------------------
test('T2. stale/unresolved internal review is typed and never projects READY_FOR_REVIEW', async () => {
  // (a) session head moved after the review -> INTERNAL_REVIEW_STALE
  {
    const stateDir = mkStateDir();
    const { sessionPath } = mkSession(stateDir, { headSha: HEAD_B });
    const git = fakeGit({ head: HEAD_B });
    writeLedger(stateDir, [boundary({ internalReview: fixtureInternalReview({ repo: REPO, issueNumber: ISSUE, headSha: HEAD_A }) })]);
    const r = projectReviewReadyPacket({ sessionPath, stateDir, exec: git.exec });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.code, 'INTERNAL_REVIEW_STALE');
    assert.match(String(r.detail.reason), /head does not match/);
    assert.equal(packetsIn(stateDir).length, 0);
  }

  // (b) live HEAD moved after the review (same session head) -> STALE
  {
    const stateDir = mkStateDir();
    const { sessionPath } = mkSession(stateDir);
    const git = fakeGit({ head: HEAD_A });
    writeLedger(stateDir, [boundary({ internalReview: fixtureInternalReview({ repo: REPO, issueNumber: ISSUE, headSha: HEAD_A }) })]);
    const r = projectReviewReadyPacket({ sessionPath, stateDir, exec: git.exec, io: bindingIo({ headSha: HEAD_B }) });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.code, 'INTERNAL_REVIEW_STALE');
    assert.match(String(r.detail.reason), /HEAD moved after the internal review/);
    assert.equal(packetsIn(stateDir).length, 0);
  }

  // (c) tracked content changed after the review (HEAD unchanged) -> STALE.
  //     Freshness is the CANONICAL content-binding digest comparison — never
  //     the push-scope dirty filter (T7 proves it against a real worktree).
  {
    const stateDir = mkStateDir();
    const { sessionPath } = mkSession(stateDir);
    const git = fakeGit({ head: HEAD_A });
    const otherDigest = 'd'.repeat(64);
    writeLedger(stateDir, [boundary({ internalReview: fixtureInternalReview({ repo: REPO, issueNumber: ISSUE, headSha: HEAD_A }) })]);
    const r = projectReviewReadyPacket({ sessionPath, stateDir, exec: git.exec, io: bindingIo({ headSha: HEAD_A, contentDigest: otherDigest }) });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.code, 'INTERNAL_REVIEW_STALE');
    assert.match(String(r.detail.reason), /content changed after the internal review/);
    assert.equal(r.detail.reviewed, FIXTURE_CONTENT_DIGEST);
    assert.equal(r.detail.live, otherDigest);
    assert.equal(packetsIn(stateDir).length, 0);
  }

  // (d) substantive findings still on the record -> INTERNAL_REVIEW_PENDING
  {
    const stateDir = mkStateDir();
    const { sessionPath } = mkSession(stateDir);
    const git = fakeGit({ head: HEAD_A });
    const ev = fixtureInternalReview({ repo: REPO, issueNumber: ISSUE, headSha: HEAD_A });
    ev.findings = [{ path: 'a.mjs', content: 'unresolved' }];
    ev.findingsCount = 1;
    writeLedger(stateDir, [boundary({ internalReview: ev })]);
    const r = projectReviewReadyPacket({ sessionPath, stateDir, exec: git.exec });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.code, 'INTERNAL_REVIEW_PENDING');
    assert.equal(r.detail.findingsCount, 1);
    assert.equal(packetsIn(stateDir).length, 0);
  }

  // (e) no record at all -> INTERNAL_REVIEW_PENDING
  {
    const stateDir = mkStateDir();
    const { sessionPath } = mkSession(stateDir);
    const git = fakeGit({ head: HEAD_A });
    writeLedger(stateDir, [boundary({ verdict: 'PASS', evidence: { exitCode: 0 } })]);
    const r = projectReviewReadyPacket({ sessionPath, stateDir, exec: git.exec });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.code, 'INTERNAL_REVIEW_PENDING');
    assert.equal(packetsIn(stateDir).length, 0);
  }

  // (f) deferPending (publish chain, pre-review): reports the pending state
  //     and creates NO packet instead of failing the chain.
  {
    const stateDir = mkStateDir();
    const { sessionPath } = mkSession(stateDir);
    const git = fakeGit({ head: HEAD_A });
    const r = projectReviewReadyPacket({ sessionPath, stateDir, exec: git.exec, deferPending: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.value.deferred, true);
    assert.equal(r.value.packet.written, false);
    assert.equal(r.value.packet.status, 'INTERNAL_REVIEW_PENDING');
    assert.equal(r.value.packet.code, 'INTERNAL_REVIEW_PENDING');
    assert.equal(packetsIn(stateDir).length, 0, 'a deferred projection writes nothing');
  }

  // (g) an ERROR that prevents proving freshness (content binding
  //     uncomputable) is INTERNAL_REVIEW_PENDING — only PROVEN drift is STALE.
  {
    const stateDir = mkStateDir();
    const { sessionPath } = mkSession(stateDir);
    const git = fakeGit({ head: HEAD_A });
    writeLedger(stateDir, [boundary({ internalReview: fixtureInternalReview({ repo: REPO, issueNumber: ISSUE, headSha: HEAD_A }) })]);
    const r = projectReviewReadyPacket({ sessionPath, stateDir, exec: git.exec, io: brokenBindingIo() });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.code, 'INTERNAL_REVIEW_PENDING');
    assert.match(String(r.detail.reason), /cannot be proven/);
    assert.equal(packetsIn(stateDir).length, 0);
  }
});

// ---- T3 ---------------------------------------------------------------------
test('T3. findings -> bounded rework -> clean review -> READY_FOR_REVIEW packet + DONE checklist', async () => {
  const stateDir = mkStateDir();
  const { sessionPath } = mkSession(stateDir);
  const git = fakeGit({ head: HEAD_A });
  const gh = fakeGh(git.state);
  const execPath = path.join(stateDir, 'executions', `${ID}.json`);
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.writeFileSync(execPath, JSON.stringify({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: ID, repo: REPO, issueNumber: ISSUE,
    terminalStatus: 'EXITED', exitCode: 0,
  }, null, 2), 'utf8');

  const cleanVerifier = withOcrInternalReview(() => ({ ok: true, value: { verdict: 'PASS', exitCode: 0, evidence: { exitCode: 0, executionRecordPath: execPath } } }));
  let verifyCalls = 0;
  const deps = loopDeps({
    git, gh,
    executor: (ctx) => {
      if (ctx.reworkInstruction) git.state.head = HEAD_B; // repair commit
      return { ok: true, value: { executionRecordPath: execPath } };
    },
    verifier: (ctx) => {
      verifyCalls += 1;
      if (verifyCalls === 1) {
        return {
          ok: false,
          code: 'INTERNAL_REVIEW_FINDINGS',
          detail: {
            status: 'CHANGES_REQUESTED', transportReason: null, correlationKey: 'ck-fixture',
            requestedHeadSha: HEAD_A, responseHeadSha: HEAD_A,
            findingsCount: 1, openBlockingCount: 1,
            findings: [{ path: 'packages/control-loop/handoff-checklist.mjs', content: 'fix this' }],
            detail: 'ocr leg findings',
          },
        };
      }
      return cleanVerifier(ctx);
    },
  });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  assert.equal(verifyCalls, 2, 'findings round then the clean round');
  assert.equal(git.state.head, HEAD_B, 'the repair commit is the reviewed candidate');

  // The rework round is on the record and the packet exists at the NEW head.
  const reworkDir = path.join(stateDir, 'control-loop', ID, 'rework');
  assert.equal(fs.readdirSync(reworkDir).filter((f) => f.endsWith('.json')).length, 1, 'one bounded rework round');
  const packets = packetsIn(stateDir);
  assert.equal(packets.length, 1, 'exactly the clean-round packet');
  assert.ok(packets[0].includes(`_${HEAD_B.slice(0, 7)}_`), packets[0]);
  const text = packetTexts(stateDir)[0];
  assert.ok(text.includes('READY_FOR_REVIEW'), 'clean review creates READY_FOR_REVIEW');
  assert.ok(text.includes('internalReview=APPROVED'), 'packet carries the OCR invocation evidence');
  assert.ok(text.includes('reworkRounds=1'), 'packet carries the finding-resolution trail');

  // Checklist: OCR + gate + final review DONE, human gate still PENDING.
  const checklistPath = path.join(stateDir, 'control-loop', ID, 'handoff-checklist.json');
  assert.ok(fs.existsSync(checklistPath), 'checklist projected');
  const checklist = JSON.parse(fs.readFileSync(checklistPath, 'utf8'));
  assert.equal(checklist.authority.includes('no review, approval, merge'), true, checklist.authority);
  const byId = Object.fromEntries(checklist.items.map((i) => [i.id, i]));
  assert.equal(byId.ocrInvocation.status, 'DONE');
  assert.equal(byId.ocrInvocation.evidence.candidate.headSha, HEAD_B, 'OCR evidence bound to the reviewed head');
  assert.equal(byId.requiredGate.status, 'DONE');
  assert.equal(byId.reviewResult.status, 'DONE');
  assert.equal(byId.finalReview.status, 'DONE');
  assert.equal(byId.humanGate.status, 'PENDING', 'the projection never marks its own human gate DONE');
  assert.equal(checklist.status, 'IN_PROGRESS');
});

// ---- T4 ---------------------------------------------------------------------
test('T4. interruption + resume re-enters the review walk without a duplicate OCR invocation', async () => {
  const stateDir = mkStateDir();
  const { sessionPath } = mkSession(stateDir);
  const git = fakeGit();
  const gh = fakeGh(git.state);
  let verifyCalls = 0;
  let preCalls = 0;
  const verifier = withOcrInternalReview(() => {
    verifyCalls += 1;
    return { ok: true, value: { verdict: 'PASS', exitCode: 0, evidence: { exitCode: 0, executionRecordPath: 'x' } } };
  });
  // First run: the pre-review step fails (interruption after the OCR review
  // and the required gate already ran).
  const failPre = () => { preCalls += 1; return { ok: false, code: 'PRE_REVIEW_FIXTURE_INTERRUPTED' }; };
  const deps1 = loopDeps({ git, gh, verifier, preReview: failPre });
  const first = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: deps1 });
  assert.equal(first.ok, false, JSON.stringify(first));
  assert.equal(first.code, 'PRE_REVIEW_FAILED');
  assert.equal(verifyCalls, 1);
  const ledger1 = readTransitions({ stateDir, identityHash: ID });
  assert.equal(ledger1.filter((r) => r.from === 'VERIFYING' && r.to === 'PRE_REVIEWING').length, 1);

  // Second run resumes at the PRE_REVIEWING tail: the completed verify step is
  // NOT re-run (loop.step resume), so no second OCR invocation happens.
  const deps2 = loopDeps({ git, gh, verifier });
  const second = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: deps2 });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.value.state, 'COMPLETED');
  assert.equal(verifyCalls, 1, 'resume must never re-invoke the completed OCR review');
  const ledger2 = readTransitions({ stateDir, identityHash: ID });
  assert.equal(ledger2.filter((r) => r.from === 'VERIFYING' && r.to === 'PRE_REVIEWING').length, 1,
    'exactly one verify boundary record across both runs');
  assert.equal(packetsIn(stateDir).length, 1, 'one packet from the single completed review');
});

// ---- T5 ---------------------------------------------------------------------
test('T5. checklist is read-only: DONE needs a valid record, gate PASS never substitutes for OCR', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, session } = mkSession(stateDir);
  const transitions = [
    { ts: 't1', from: 'VERIFYING', to: 'PRE_REVIEWING', reason: null, evidence: { verdict: 'PASS', evidence: { exitCode: 0, executionRecordPath: 'x', headSha: HEAD_A } } },
    { ts: 't2', from: 'PRE_REVIEWING', to: 'FINAL_REVIEWING', reason: null, evidence: { verdict: 'PASS', findings: [] } },
  ];

  // (a) gate PASS but NO OCR record: gate DONE, OCR PENDING, not complete.
  const missing = buildHandoffChecklist({ stateDir, session, identityHash: ID, transitions, internalReviewGate: { ok: false, code: 'INTERNAL_REVIEW_PENDING', detail: { reason: 'none' } } });
  assert.equal(missing.ok, true, JSON.stringify(missing));
  let byId = Object.fromEntries(missing.value.items.map((i) => [i.id, i]));
  assert.equal(byId.requiredGate.status, 'DONE');
  assert.equal(byId.ocrInvocation.status, 'PENDING', 'test PASS never marks the OCR item DONE');
  assert.equal(byId.reviewResult.status, 'PENDING');
  assert.equal(missing.value.status, 'IN_PROGRESS');
  assert.equal(missing.value.authority.includes('grants no'), true);

  // (b) a fresh, bound, approved record: OCR + review DONE.
  const s = { ...session, headSha: HEAD_A };
  const gate = { ok: true, value: { internalReview: fixtureInternalReview({ ...s, repo: REPO, issueNumber: ISSUE }), boundary: { ts: 't0' } } };
  const clean = buildHandoffChecklist({ stateDir, session: s, identityHash: ID, transitions, internalReviewGate: gate });
  assert.equal(clean.ok, true, JSON.stringify(clean));
  byId = Object.fromEntries(clean.value.items.map((i) => [i.id, i]));
  assert.deepEqual(clean.value.items.map((i) => i.id), [...CHECKLIST_ITEM_IDS], 'the checklist shows exactly the contracted items');
  assert.equal(byId.ocrInvocation.status, 'DONE');
  assert.equal(byId.ocrInvocation.evidence.candidate.headSha, HEAD_A);
  assert.equal(byId.reviewResult.status, 'DONE');
  assert.equal(byId.humanGate.status, 'PENDING', 'no human merge authorization exists yet');

  // (c) a stale record is never DONE.
  const stale = buildHandoffChecklist({ stateDir, session: s, identityHash: ID, transitions, internalReviewGate: { ok: false, code: 'INTERNAL_REVIEW_STALE', detail: { reason: 'HEAD moved after the internal review' } } });
  byId = Object.fromEntries(stale.value.items.map((i) => [i.id, i]));
  assert.equal(byId.ocrInvocation.status, 'STALE');
  assert.notEqual(byId.ocrInvocation.status, 'DONE');

  // (d) projection writes its own view files and mutates NO canonical record.
  const ledgerPath = path.join(stateDir, 'control-loop', ID, 'transitions.jsonl');
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, transitions.map((t) => JSON.stringify({ schemaVersion: '1', identityHash: ID, ...t })).join('\n'), 'utf8');
  const beforeSession = fs.readFileSync(sessionPath, 'utf8');
  const beforeLedger = fs.readFileSync(ledgerPath, 'utf8');
  const pj = projectHandoffChecklist({ stateDir, identityHash: ID, session: s, transitions, internalReviewGate: gate });
  assert.equal(pj.ok, true, JSON.stringify(pj));
  assert.ok(fs.existsSync(pj.value.jsonPath), 'json view');
  assert.ok(fs.existsSync(pj.value.mdPath), 'markdown view');
  const md = fs.readFileSync(pj.value.mdPath, 'utf8');
  assert.ok(md.includes('grants no review, approval, merge or lifecycle authority'));
  assert.ok(md.includes('[x] `ocrInvocation` — **DONE**'));
  assert.ok(md.includes('[ ] `humanGate` — **PENDING**'));
  assert.equal(fs.readFileSync(sessionPath, 'utf8'), beforeSession, 'session untouched');
  assert.equal(fs.readFileSync(ledgerPath, 'utf8'), beforeLedger, 'ledger untouched');
  // The checklist never lands in the packet directory (packet resolver safety).
  assert.equal(packetsIn(stateDir).length, 0, 'checklist is not written as a review-ready packet');
});

// ---- T6 ---------------------------------------------------------------------
test('T6. rework require-policy refusal stays recoverable at the VERIFYING checkpoint', async () => {
  const stateDir = mkStateDir();
  const { sessionPath } = mkSession(stateDir);
  const git = fakeGit({ head: HEAD_A });
  const gh = fakeGh(git.state);
  const execPath = path.join(stateDir, 'executions', `${ID}.json`);
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.writeFileSync(execPath, JSON.stringify({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: ID, repo: REPO, issueNumber: ISSUE,
    terminalStatus: 'EXITED', exitCode: 0,
  }, null, 2), 'utf8');

  let verifyCalls = 0;
  const deps = loopDeps({
    git, gh,
    executor: (ctx) => {
      if (ctx.reworkInstruction) git.state.head = HEAD_B;
      return { ok: true, value: { executionRecordPath: execPath } };
    },
    // Round 1: findings -> rework. Round 2 (repaired candidate): the gate
    // passes but carries NO OCR record, so the rework leg's require-policy
    // packet projection must refuse WITHOUT stranding the task.
    verifier: (ctx) => {
      verifyCalls += 1;
      if (verifyCalls === 1) {
        return {
          ok: false,
          code: 'INTERNAL_REVIEW_FINDINGS',
          detail: {
            status: 'CHANGES_REQUESTED', correlationKey: 'ck-t6',
            requestedHeadSha: HEAD_A, responseHeadSha: HEAD_A,
            findingsCount: 1, openBlockingCount: 1,
            findings: [{ path: 'x.mjs', content: 'needs work' }], detail: 'ocr leg findings',
          },
        };
      }
      return { ok: true, value: { verdict: 'PASS', report: 'gate ok, no OCR record' } };
    },
  });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'INTERNAL_REVIEW_PENDING');
  assert.equal(res.detail.status, 'REVIEW_PENDING');
  assert.equal(res.detail.recoverable, true, 'a review refusal must stay resumable at VERIFYING');
  assert.equal(res.detail.resumeState, 'VERIFYING');
  assert.equal(packetsIn(stateDir).length, 0, 'no READY_FOR_REVIEW without the record');
  // The ledger tail proves where a resume re-enters: VERIFYING, ready for a
  // fresh review - never a terminal BLOCKED.
  const ledger = readTransitions({ stateDir, identityHash: ID });
  assert.equal(ledger[ledger.length - 1].to, 'VERIFYING');
  const s = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(s.state, 'SESSION_ACTIVE', 'no terminalization on a review refusal');
});

// ---- T7 / H1 ----------------------------------------------------------------
test('H1/T7. a tracked .opencode edit after the review (HEAD unchanged) proves the binding STALE via the canonical content-binding primitive', async () => {
  const stateDir = mkStateDir();
  const wt = path.join(stateDir, 'wt');
  fs.mkdirSync(path.join(wt, '.opencode'), { recursive: true });
  const run = (args) => {
    const r = spawnSync('git', args, { cwd: wt, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} -> ${r.status}: ${r.stderr || r.stdout}`);
    return r.stdout ?? '';
  };
  run(['init', '-q']);
  run(['config', 'user.email', 'handoff@example.test']);
  run(['config', 'user.name', 'handoff']);
  run(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(wt, '.opencode', 'review.mjs'), 'export const reviewed = 1;\n', 'utf8');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'reviewed candidate']);

  const live1 = computeWorktreeContentBinding({ worktreePath: wt, headSha: null });
  assert.equal(live1.ok, true, JSON.stringify(live1));
  const head1 = live1.value.headSha;
  const digest1 = live1.value.contentDigest;

  const { sessionPath } = mkSession(stateDir, { worktreePath: wt, headSha: head1, baseSha: head1 });
  const review = fixtureInternalReview({ repo: REPO, issueNumber: ISSUE, headSha: head1, baseSha: head1 });
  review.candidate.contentDigest = digest1; // the REAL digest of the reviewed candidate
  const gh = () => ({ code: 1, stdout: '', stderr: 'no gh fixture' });
  writeLedger(stateDir, [boundary({
    internalReview: review, verdict: 'PASS',
    evidence: { exitCode: 0, executionRecordPath: 'x', headSha: head1, codeContentDigest: digest1 },
  })]);

  // (1) unchanged candidate -> the handoff gate accepts (canonical primitive)
  const ok = projectReviewReadyPacket({ sessionPath, stateDir, gh });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(packetsIn(stateDir).length, 1);

  // (2) TRACKED .opencode edit, HEAD UNCHANGED -> stale binding, no refresh
  fs.writeFileSync(path.join(wt, '.opencode', 'review.mjs'), 'export const reviewed = 2;\n', 'utf8');
  const live2 = computeWorktreeContentBinding({ worktreePath: wt, headSha: null });
  assert.equal(live2.value.headSha, head1, 'HEAD must not change for this scenario');
  assert.notEqual(live2.value.contentDigest, digest1, 'the tracked content DID change');
  const stale = projectReviewReadyPacket({ sessionPath, stateDir, gh });
  assert.equal(stale.ok, false, JSON.stringify(stale));
  assert.equal(stale.code, 'INTERNAL_REVIEW_STALE');
  assert.match(String(stale.detail.reason), /content changed after the internal review/);
  assert.equal(stale.detail.reviewed, digest1);
  assert.equal(stale.detail.live, live2.value.contentDigest);
  assert.equal(packetsIn(stateDir).length, 1, 'the stale re-projection never rewrites READY_FOR_REVIEW');

  // (3) WHY the push-scope dirty filter must never be the freshness check:
  //     it ALLOWLISTS .opencode as runtime dirt, so it would have passed.
  assert.deepEqual(cleanPathspecsForPush(['.opencode/review.mjs']), [],
    'the push dirty filter allowlists .opencode — freshness must not delegate to it');
});

// ---- T8 / H2 ----------------------------------------------------------------
test('H2/T8. checklist DONE items must be bound to the current candidate (stale/contradictory/exit!=0 never DONE)', () => {
  const stateDir = mkStateDir();
  const { session } = mkSession(stateDir, { headSha: HEAD_B });
  const ocrB = fixtureInternalReview({ repo: REPO, issueNumber: ISSUE, headSha: HEAD_B });
  const gateB = { ok: true, value: { internalReview: ocrB, boundary: { ts: 't1' } } };
  const byIdOf = (r) => Object.fromEntries(r.value.items.map((i) => [i.id, i]));

  // (1) OCR bound to B while the gate/final records are bound to A
  {
    const transitions = [
      { ts: 't1', from: 'VERIFYING', to: 'PRE_REVIEWING', reason: null, evidence: {
        verdict: 'PASS', internalReview: ocrB, evidence: { exitCode: 0, executionRecordPath: 'x', headSha: HEAD_A } } },
      { ts: 't2', from: 'FINAL_REVIEWING', to: 'DECIDING', reason: null, evidence: {
        verdict: 'PASS', findings: [], binding: { repository: REPO, issue: ISSUE, headSha: HEAD_A } } },
    ];
    const r = buildHandoffChecklist({ stateDir, session, identityHash: ID, transitions, internalReviewGate: gateB });
    assert.equal(r.ok, true, JSON.stringify(r));
    const byId = byIdOf(r);
    assert.equal(byId.ocrInvocation.status, 'DONE');
    assert.equal(byId.requiredGate.status, 'PENDING', 'gate evidence bound to A is not DONE for candidate B');
    assert.equal(byId.finalReview.status, 'PENDING', 'final decision bound to A is not DONE for candidate B');
    assert.notEqual(r.value.status, 'COMPLETE', 'contradictory evidence never completes the checklist');
  }

  // (2) bound to B but PASS + exitCode 1 -> contradictory, never DONE
  {
    const transitions = [
      { ts: 't1', from: 'VERIFYING', to: 'PRE_REVIEWING', reason: null, evidence: {
        verdict: 'PASS', internalReview: ocrB, evidence: { exitCode: 1, executionRecordPath: 'x', headSha: HEAD_B } } },
      { ts: 't2', from: 'FINAL_REVIEWING', to: 'DECIDING', reason: null, evidence: {
        verdict: 'PASS', findings: [], binding: { repository: REPO, issue: ISSUE, headSha: HEAD_B } } },
    ];
    const r = buildHandoffChecklist({ stateDir, session, identityHash: ID, transitions, internalReviewGate: gateB });
    const byId = byIdOf(r);
    assert.equal(byId.requiredGate.status, 'PENDING', 'PASS with exitCode 1 is not a passing gate record');
    assert.match(byId.requiredGate.note, /exitCode/);
    assert.equal(byId.finalReview.status, 'DONE');
    assert.notEqual(r.value.status, 'COMPLETE');
  }

  // (3) gate evidence with NO candidate binding at all -> never DONE
  {
    const transitions = [
      { ts: 't1', from: 'VERIFYING', to: 'PRE_REVIEWING', reason: null, evidence: {
        verdict: 'PASS', evidence: { exitCode: 0, executionRecordPath: 'x' } } },
      { ts: 't2', from: 'FINAL_REVIEWING', to: 'DECIDING', reason: null, evidence: {
        verdict: 'PASS', findings: [] } },
    ];
    const r = buildHandoffChecklist({ stateDir, session, identityHash: ID, transitions, internalReviewGate: gateB });
    const byId = byIdOf(r);
    assert.equal(byId.requiredGate.status, 'PENDING', 'unbound gate evidence is never DONE');
    assert.equal(byId.finalReview.status, 'PENDING', 'an unbound final decision is never DONE');
    assert.notEqual(r.value.status, 'COMPLETE');
  }

  // (4) control: everything bound to the CURRENT candidate -> items DONE, and
  //     with an exact-bound human merge authorization the checklist completes.
  {
    const transitions = [
      { ts: 't1', from: 'VERIFYING', to: 'PRE_REVIEWING', reason: null, evidence: {
        verdict: 'PASS', internalReview: ocrB, evidence: { exitCode: 0, executionRecordPath: 'x', headSha: HEAD_B, codeContentDigest: FIXTURE_CONTENT_DIGEST } } },
      { ts: 't2', from: 'FINAL_REVIEWING', to: 'DECIDING', reason: null, evidence: {
        verdict: 'PASS', findings: [], binding: { repository: REPO, issue: ISSUE, headSha: HEAD_B } } },
      { ts: 't3', from: 'DECIDING', to: 'DELIVERING', reason: 'ready-for-review-boundary', evidence: {
        verdict: 'PASS', findings: [], binding: { repository: REPO, issue: ISSUE, headSha: HEAD_B } } },
    ];
    const auth = writeMergeAuthorization({
      stateDir, identityHash: ID, repo: REPO, issue: ISSUE, pullRequest: 4242,
      reviewedHeadSha: HEAD_B, authorizedBy: 'bo', clientRequestId: 'h2-t8-control',
    });
    assert.equal(auth.ok, true, JSON.stringify(auth));
    const r = buildHandoffChecklist({ stateDir, session, identityHash: ID, transitions, internalReviewGate: gateB });
    const byId = byIdOf(r);
    assert.equal(byId.requiredGate.status, 'DONE');
    assert.equal(byId.finalReview.status, 'DONE');
    assert.equal(byId.humanGate.status, 'DONE');
    assert.equal(r.value.status, 'COMPLETE', 'a fully bound, contradiction-free checklist can complete');
  }
});

// ---- T9 / H3 ----------------------------------------------------------------
test('H3/T9. fresh handoff refusal is recorded at the VERIFY boundary and resumes without a second executor dispatch', async () => {
  const stateDir = mkStateDir();
  const { sessionPath } = mkSession(stateDir);
  const git = fakeGit();
  const gh = fakeGh(git.state);
  const execPath = path.join(stateDir, 'executions', `${ID}.json`);
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.writeFileSync(execPath, JSON.stringify({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: ID, repo: REPO, issueNumber: ISSUE,
    terminalStatus: 'EXITED', exitCode: 0,
  }, null, 2), 'utf8');

  let execCalls = 0;
  let verifyCalls = 0;
  const executor = () => { execCalls += 1; return { ok: true, value: { executionRecordPath: execPath } }; };

  // Run 1: the gate passes but the verifier carries NO OCR record -> fresh
  // handoff refusal, recorded at the VERIFY boundary for a later resume.
  const first = await runControlLoop({
    sessionPath, identityHash: ID, stateDir,
    deps: loopDeps({
      git, gh, executor,
      verifier: () => { verifyCalls += 1; return { ok: true, value: { verdict: 'PASS', report: 'no OCR record' } }; },
    }),
  });
  assert.equal(first.ok, false, JSON.stringify(first));
  assert.equal(first.code, 'INTERNAL_REVIEW_PENDING');
  assert.equal(packetsIn(stateDir).length, 0, 'no packet from the refused handoff');
  assert.equal(execCalls, 1);
  const tail1 = readTransitions({ stateDir, identityHash: ID }).slice(-1)[0];
  assert.equal(tail1.from, 'VERIFYING');
  assert.equal(tail1.to, 'BLOCKED');
  assert.equal(tail1.reason, 'verify:FAIL', 'the refusal must be recorded at the VERIFY boundary');
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE');

  // Run 2: resume with a VALID verifier -> the verify step re-runs (fresh OCR
  // record), the walk PROGRESSES to COMPLETED, and the executor is NOT
  // dispatched a second time.
  const second = await runControlLoop({
    sessionPath, identityHash: ID, stateDir,
    deps: loopDeps({
      git, gh, executor,
      verifier: withOcrInternalReview(() => {
        verifyCalls += 1;
        return { ok: true, value: { verdict: 'PASS', exitCode: 0, evidence: { exitCode: 0, executionRecordPath: execPath } } };
      }),
    }),
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.value.state, 'COMPLETED');
  assert.equal(execCalls, 1, 'resume must never re-dispatch the executor');
  assert.equal(verifyCalls, 2, 'the verify step re-runs exactly once on resume');
  assert.equal(packetsIn(stateDir).length, 1, 'the resumed walk completes the handoff');
  assert.match(packetTexts(stateDir)[0], /READY_FOR_REVIEW/);
});

// ---- T10 / H4 ---------------------------------------------------------------
test('H4/T10. adoption without an OCR record describes the exemption — never APPROVED clean or unproven zero findings', async () => {
  const stateDir = mkStateDir();
  const git = fakeGit({ head: HEAD_A });
  const gh = fakeGh(git.state);
  const { sessionPath, session } = mkSession(stateDir, { controlLoop: { stateDir, reviewOnly: true } });
  // An adoption verify record WITHOUT any OCR internal-review record.
  writeLedger(stateDir, [{
    ts: '2026-10-05T00:00:00.000Z', from: 'VERIFYING', to: 'PRE_REVIEWING', reason: null,
    evidence: { verdict: 'PASS', reviewOnly: true, headSha: HEAD_A, evidence: { exitCode: 0, headSha: HEAD_A } },
  }]);

  const r = projectReviewReadyPacket({ sessionPath, stateDir, exec: git.exec, gh });
  assert.equal(r.ok, true, JSON.stringify(r), 'the adoption mode is exempt from the OCR handoff gate');
  const text = packetTexts(stateDir)[0];
  assert.match(text, /READY_FOR_REVIEW/, 'the adoption handoff itself still happens');
  assert.match(text, /review-only adoption/i, 'the packet must describe the exemption');
  assert.ok(!text.includes('APPROVED clean'), 'never claim a clean OCR review that never ran');
  assert.ok(!text.includes('findingsCount=0'), 'never claim zero findings that were not proven');

  // Checklist: the same truthfulness, never DONE/COMPLETE without a record.
  const cl = buildHandoffChecklist({
    stateDir, session, identityHash: ID,
    transitions: readTransitions({ stateDir, identityHash: ID }),
    internalReviewGate: { ok: false, code: 'INTERNAL_REVIEW_PENDING', detail: { reason: 'no OCR internal-review record in the loop ledger' } },
  });
  assert.equal(cl.ok, true, JSON.stringify(cl));
  const byId = Object.fromEntries(cl.value.items.map((i) => [i.id, i]));
  assert.equal(byId.ocrInvocation.status, 'PENDING');
  assert.match(byId.ocrInvocation.note, /exemption|adoption/i, 'the item names the exemption, not a fake record');
  assert.equal(byId.reviewResult.status, 'PENDING');
  assert.match(byId.reviewResult.note, /exemption|adoption/i, 'zero findings are never claimed for an adoption');
  assert.equal(byId.requiredGate.status, 'DONE', 'the adoption gate record is bound to this candidate');
  assert.notEqual(cl.value.status, 'COMPLETE');
});

// ---- T11 / H2 digest cross-check --------------------------------------------
test('H2/T11. OCR and execution bindings must AGREE on the content digest — contradiction is never DONE/COMPLETE', () => {
  const stateDir = mkStateDir();
  const { session } = mkSession(stateDir, { headSha: HEAD_B });
  const D2 = 'd'.repeat(64); // a second, DIFFERENT content digest
  const ocrB = fixtureInternalReview({ repo: REPO, issueNumber: ISSUE, headSha: HEAD_B }); // digest = FIXTURE_CONTENT_DIGEST
  const gateB = { ok: true, value: { internalReview: ocrB, boundary: { ts: 't1' } } };
  const byIdOf = (r) => Object.fromEntries(r.value.items.map((i) => [i.id, i]));

  // A verify boundary whose OCR record is bound to B while the execution
  // evidence carries the given digest fields (all at HEAD B).
  const verifyRec = (execFields) => ({
    ts: 't1', from: 'VERIFYING', to: 'PRE_REVIEWING', reason: null,
    evidence: {
      verdict: 'PASS', internalReview: ocrB,
      evidence: { exitCode: 0, executionRecordPath: 'x', headSha: HEAD_B, ...execFields },
    },
  });
  const boundFinal = [
    { ts: 't2', from: 'FINAL_REVIEWING', to: 'DECIDING', reason: null,
      evidence: { verdict: 'PASS', findings: [], binding: { repository: REPO, issue: ISSUE, headSha: HEAD_B } } },
    { ts: 't3', from: 'DECIDING', to: 'DELIVERING', reason: 'ready-for-review-boundary',
      evidence: { verdict: 'PASS', findings: [], binding: { repository: REPO, issue: ISSUE, headSha: HEAD_B } } },
  ];
  const auth = writeMergeAuthorization({
    stateDir, identityHash: ID, repo: REPO, issue: ISSUE, pullRequest: 4242,
    reviewedHeadSha: HEAD_B, authorizedBy: 'bo', clientRequestId: 'h2-t11-auth',
  });
  assert.equal(auth.ok, true, JSON.stringify(auth));
  const build = (transitions) => buildHandoffChecklist({
    stateDir, session, identityHash: ID, transitions, internalReviewGate: gateB,
  });

  // (1) reviewer repro: SAME head B, OCR digest D1 vs execution codeContentDigest D2.
  {
    const r = build([verifyRec({ codeContentDigest: D2 }), ...boundFinal]);
    const byId = byIdOf(r);
    assert.equal(byId.requiredGate.status, 'PENDING', 'a digest contradiction must never be a DONE gate');
    assert.match(byId.requiredGate.note, /contradict/i, byId.requiredGate.note);
    assert.ok(String(byId.requiredGate.note).includes(FIXTURE_CONTENT_DIGEST), 'the rejection shows the REVIEWED digest');
    assert.ok(String(byId.requiredGate.note).includes(D2), 'the rejection shows the EXECUTION digest');
    assert.equal(byId.requiredGate.evidence.binding.ocr.contentDigest, FIXTURE_CONTENT_DIGEST);
    assert.equal(byId.requiredGate.evidence.binding.execution.codeContentDigest, D2);
    assert.equal(byId.finalReview.status, 'DONE');
    assert.notEqual(r.value.status, 'COMPLETE', 'contradictory evidence never completes the checklist');
  }

  // (2) control: execution carries the contract contentDigest field and it
  //     MATCHES the reviewed digest -> gate DONE and the checklist completes.
  {
    const r = build([verifyRec({ contentDigest: FIXTURE_CONTENT_DIGEST }), ...boundFinal]);
    const byId = byIdOf(r);
    assert.equal(byId.requiredGate.status, 'DONE', 'an agreeing execution contentDigest stays valid');
    assert.equal(byId.finalReview.status, 'DONE');
    assert.equal(r.value.status, 'COMPLETE', 'identical HEAD + identical digest + PASS + exit 0 still completes');
  }

  // (3) execution carries contentDigest (not codeContentDigest) and it DIFFERS.
  {
    const r = build([verifyRec({ contentDigest: D2 }), ...boundFinal]);
    const byId = byIdOf(r);
    assert.equal(byId.requiredGate.status, 'PENDING', 'a differing execution contentDigest is still a contradiction');
    assert.ok(String(byId.requiredGate.note).includes(D2), 'the rejection shows the execution contentDigest');
    assert.notEqual(r.value.status, 'COMPLETE');
  }

  // (4) execution's OWN two digest fields disagree -> contradiction, never a
  //     silent pick of one of them.
  {
    const r = build([verifyRec({ codeContentDigest: FIXTURE_CONTENT_DIGEST, contentDigest: D2 }), ...boundFinal]);
    const byId = byIdOf(r);
    assert.equal(byId.requiredGate.status, 'PENDING', 'the two execution digest fields must not silently disagree');
    assert.match(byId.requiredGate.note, /contradict/i, byId.requiredGate.note);
    assert.notEqual(r.value.status, 'COMPLETE');
  }

  // (4b) the same execution-only contradiction holds with NO OCR record on the
  //      boundary (the OCR gate itself is still clean for this candidate).
  {
    const transitions = [
      { ts: 't1', from: 'VERIFYING', to: 'PRE_REVIEWING', reason: null,
        evidence: { verdict: 'PASS', evidence: { exitCode: 0, executionRecordPath: 'x', headSha: HEAD_B, codeContentDigest: FIXTURE_CONTENT_DIGEST, contentDigest: D2 } } },
      ...boundFinal,
    ];
    const r = build(transitions);
    const byId = byIdOf(r);
    assert.equal(byId.requiredGate.status, 'PENDING');
    assert.notEqual(r.value.status, 'COMPLETE');
  }
});

// ---- F1: a PRESENT-but-INVALID digest/head is never silently dropped -------
// normDigest()/normHead() mapped a malformed value to `null`, i.e. treated
// "present but unusable" as "absent", so the OCR side alone could still make
// the binding BOUND with requiredGate DONE. Present-but-invalid must be kept
// as evidence and become a CONFLICT (CONTRADICTORY -> requiredGate PENDING);
// truly-absent keeps the existing UNBOUND/absent semantics.
test('H2/T11b (F1). a PRESENT but malformed execution digest is a conflict — never dropped to BOUND/DONE', () => {
  const stateDir = mkStateDir();
  const { session } = mkSession(stateDir, { headSha: HEAD_B });
  const BAD = 'zz'.repeat(32); // 64 chars, non-hex: present but not a sha256
  const ocrB = fixtureInternalReview({ repo: REPO, issueNumber: ISSUE, headSha: HEAD_B });
  const gateB = { ok: true, value: { internalReview: ocrB, boundary: { ts: 't1' } } };
  const byIdOf = (r) => Object.fromEntries(r.value.items.map((i) => [i.id, i]));
  const verifyRec = (execFields, ocr) => ({
    ts: 't1', from: 'VERIFYING', to: 'PRE_REVIEWING', reason: null,
    evidence: {
      verdict: 'PASS',
      ...(ocr ? { internalReview: ocr } : {}),
      evidence: { exitCode: 0, executionRecordPath: 'x', headSha: HEAD_B, ...execFields },
    },
  });
  const boundFinal = [
    { ts: 't2', from: 'FINAL_REVIEWING', to: 'DECIDING', reason: null,
      evidence: { verdict: 'PASS', findings: [], binding: { repository: REPO, issue: ISSUE, headSha: HEAD_B } } },
    { ts: 't3', from: 'DECIDING', to: 'DELIVERING', reason: 'ready-for-review-boundary',
      evidence: { verdict: 'PASS', findings: [], binding: { repository: REPO, issue: ISSUE, headSha: HEAD_B } } },
  ];
  const build = (transitions) => buildHandoffChecklist({
    stateDir, session, identityHash: ID, transitions, internalReviewGate: gateB,
  });

  // (a) valid OCR digest + malformed EXECUTION digest (the reviewer repro)
  {
    const r = build([verifyRec({ codeContentDigest: BAD }), ...boundFinal]);
    const byId = byIdOf(r);
    const b = byId.requiredGate.evidence.binding;
    assert.equal(b.status, 'CONTRADICTORY', 'present-but-invalid execution digest must conflict, not vanish');
    assert.equal(byId.requiredGate.status, 'PENDING', 'a malformed digest must never make the gate DONE');
    assert.match(byId.requiredGate.note, /not a sha256/i, byId.requiredGate.note);
    assert.equal(b.execution.invalid && b.execution.invalid.codeContentDigest, BAD, 'the raw value stays as evidence');
    assert.notEqual(r.value.status, 'COMPLETE');
  }

  // (b) mirror: valid EXECUTION digest + malformed OCR digest
  {
    const badOcr = { ...ocrB, candidate: { ...ocrB.candidate, contentDigest: BAD } };
    const gateBad = { ok: true, value: { internalReview: badOcr, boundary: { ts: 't1' } } };
    const r = buildHandoffChecklist({
      stateDir, session, identityHash: ID, internalReviewGate: gateBad,
      transitions: [verifyRec({ contentDigest: FIXTURE_CONTENT_DIGEST }, badOcr), ...boundFinal],
    });
    const byId = byIdOf(r);
    const b = byId.requiredGate.evidence.binding;
    assert.equal(b.status, 'CONTRADICTORY', 'present-but-invalid OCR digest must conflict');
    assert.equal(byId.requiredGate.status, 'PENDING');
    assert.match(byId.requiredGate.note, /not a sha256/i, byId.requiredGate.note);
    assert.equal(b.ocr.invalid && b.ocr.invalid.contentDigest, BAD, 'the raw OCR value stays as evidence');
    assert.notEqual(r.value.status, 'COMPLETE');
  }
});

test('H2/T11c (F1). a PRESENT but malformed headSha on either witness is a conflict — never dropped', () => {
  const stateDir = mkStateDir();
  const { session } = mkSession(stateDir, { headSha: HEAD_B });
  const BAD_HEAD = 'zz'.repeat(20); // 40 chars, non-hex
  const ocrB = fixtureInternalReview({ repo: REPO, issueNumber: ISSUE, headSha: HEAD_B });
  const gateB = { ok: true, value: { internalReview: ocrB, boundary: { ts: 't1' } } };
  const byIdOf = (r) => Object.fromEntries(r.value.items.map((i) => [i.id, i]));
  const verifyRec = (execFields, ocr) => ({
    ts: 't1', from: 'VERIFYING', to: 'PRE_REVIEWING', reason: null,
    evidence: {
      verdict: 'PASS',
      ...(ocr ? { internalReview: ocr } : {}),
      evidence: { exitCode: 0, executionRecordPath: 'x', ...execFields },
    },
  });
  const boundFinal = [
    { ts: 't2', from: 'FINAL_REVIEWING', to: 'DECIDING', reason: null,
      evidence: { verdict: 'PASS', findings: [], binding: { repository: REPO, issue: ISSUE, headSha: HEAD_B } } },
    { ts: 't3', from: 'DECIDING', to: 'DELIVERING', reason: 'ready-for-review-boundary',
      evidence: { verdict: 'PASS', findings: [], binding: { repository: REPO, issue: ISSUE, headSha: HEAD_B } } },
  ];
  const build = (transitions) => buildHandoffChecklist({
    stateDir, session, identityHash: ID, transitions, internalReviewGate: gateB,
  });

  // (a) execution witness headSha present but malformed
  {
    const r = build([verifyRec({ headSha: BAD_HEAD, codeContentDigest: 'e'.repeat(64) }), ...boundFinal]);
    const byId = byIdOf(r);
    const b = byId.requiredGate.evidence.binding;
    assert.equal(b.status, 'CONTRADICTORY', 'malformed execution headSha must conflict');
    assert.equal(byId.requiredGate.status, 'PENDING');
    assert.match(byId.requiredGate.note, /not a 40-hex/i, byId.requiredGate.note);
    assert.equal(b.execution.invalid && b.execution.invalid.headSha, BAD_HEAD, 'the raw head stays as evidence');
    assert.notEqual(r.value.status, 'COMPLETE');
  }

  // (b) OCR witness headSha present but malformed
  {
    const badOcr = { ...ocrB, candidate: { ...ocrB.candidate, headSha: BAD_HEAD } };
    const gateBad = { ok: true, value: { internalReview: badOcr, boundary: { ts: 't1' } } };
    const r = buildHandoffChecklist({
      stateDir, session, identityHash: ID, internalReviewGate: gateBad,
      transitions: [verifyRec({ headSha: HEAD_B, codeContentDigest: 'e'.repeat(64) }, badOcr), ...boundFinal],
    });
    const byId = byIdOf(r);
    const b = byId.requiredGate.evidence.binding;
    assert.equal(b.status, 'CONTRADICTORY', 'malformed OCR headSha must conflict');
    assert.equal(byId.requiredGate.status, 'PENDING');
    assert.match(byId.requiredGate.note, /not a 40-hex/i, byId.requiredGate.note);
    assert.equal(b.ocr.invalid && b.ocr.invalid.headSha, BAD_HEAD, 'the raw OCR head stays as evidence');
    assert.notEqual(r.value.status, 'COMPLETE');
  }
});

test('H2/T11d (F1). controls: valid both sides still DONE/COMPLETE; truly-absent keeps UNBOUND semantics', () => {
  const stateDir = mkStateDir();
  const { session } = mkSession(stateDir, { headSha: HEAD_B });
  const ocrB = fixtureInternalReview({ repo: REPO, issueNumber: ISSUE, headSha: HEAD_B });
  const gateB = { ok: true, value: { internalReview: ocrB, boundary: { ts: 't1' } } };
  const byIdOf = (r) => Object.fromEntries(r.value.items.map((i) => [i.id, i]));
  const auth = writeMergeAuthorization({
    stateDir, identityHash: ID, repo: REPO, issue: ISSUE, pullRequest: 4242,
    reviewedHeadSha: HEAD_B, authorizedBy: 'bo', clientRequestId: 'f1-t11d-auth',
  });
  assert.equal(auth.ok, true, JSON.stringify(auth));
  const boundFinal = [
    { ts: 't2', from: 'FINAL_REVIEWING', to: 'DECIDING', reason: null,
      evidence: { verdict: 'PASS', findings: [], binding: { repository: REPO, issue: ISSUE, headSha: HEAD_B } } },
    { ts: 't3', from: 'DECIDING', to: 'DELIVERING', reason: 'ready-for-review-boundary',
      evidence: { verdict: 'PASS', findings: [], binding: { repository: REPO, issue: ISSUE, headSha: HEAD_B } } },
  ];

  // (a) control VALID: head + digest valid on both sides -> current behaviour
  {
    const r = buildHandoffChecklist({
      stateDir, session, identityHash: ID, internalReviewGate: gateB,
      transitions: [{
        ts: 't1', from: 'VERIFYING', to: 'PRE_REVIEWING', reason: null,
        evidence: { verdict: 'PASS', internalReview: ocrB,
          evidence: { exitCode: 0, executionRecordPath: 'x', headSha: HEAD_B, contentDigest: FIXTURE_CONTENT_DIGEST } },
      }, ...boundFinal],
    });
    const byId = byIdOf(r);
    assert.equal(byId.requiredGate.evidence.binding.status, 'BOUND');
    assert.equal(byId.requiredGate.status, 'DONE');
    assert.equal(r.value.status, 'COMPLETE');
  }

  // (b) control ABSENT: no OCR on the boundary and execution carries neither
  //     headSha nor digests -> the existing UNBOUND -> PENDING semantics stay
  {
    const r = buildHandoffChecklist({
      stateDir, session, identityHash: ID, internalReviewGate: gateB,
      transitions: [{
        ts: 't1', from: 'VERIFYING', to: 'PRE_REVIEWING', reason: null,
        evidence: { verdict: 'PASS', evidence: { exitCode: 0, executionRecordPath: 'x' } },
      }, ...boundFinal],
    });
    const byId = byIdOf(r);
    const b = byId.requiredGate.evidence.binding;
    assert.equal(b.status, 'UNBOUND', 'truly-absent fields keep the existing UNBOUND semantics');
    assert.deepEqual(b.conflicts, [], 'absence is not a conflict');
    assert.equal(byId.requiredGate.status, 'PENDING');
    assert.notEqual(r.value.status, 'COMPLETE');
  }
});

test('H2/T11e (F1). explicit verify evidence: present-but-invalid head/digest is CONTRADICTORY, absent stays UNBOUND, valid stays BOUND', () => {
  const stateDir = mkStateDir();
  const { session } = mkSession(stateDir, { headSha: HEAD_B });
  const ocrB = fixtureInternalReview({ repo: REPO, issueNumber: ISSUE, headSha: HEAD_B });
  const gateB = { ok: true, value: { internalReview: ocrB, boundary: { ts: 't1' } } };
  const build = (verifyEvidence) => buildHandoffChecklist({
    stateDir, session, identityHash: ID, internalReviewGate: gateB,
    transitions: [{ ts: 't2', from: 'FINAL_REVIEWING', to: 'DECIDING', reason: null,
      evidence: { verdict: 'PASS', findings: [], binding: { repository: REPO, issue: ISSUE, headSha: HEAD_B } } }],
    verifyEvidence,
  });

  // (a) head present but malformed -> conflict, never BOUND/UNBOUND
  const r1 = build({ verdict: 'PASS', exitCode: 0, headSha: 'zz'.repeat(20), contentDigest: FIXTURE_CONTENT_DIGEST });
  const b1 = r1.value.items.find((i) => i.id === 'requiredGate').evidence.binding;
  assert.equal(b1.status, 'CONTRADICTORY', 'malformed explicit headSha must be a conflict');
  assert.match(r1.value.items.find((i) => i.id === 'requiredGate').note, /not a 40-hex/i);
  assert.notEqual(r1.value.status, 'COMPLETE');

  // (b) head valid but digest present-and-malformed -> conflict, never BOUND
  const r2 = build({ verdict: 'PASS', exitCode: 0, headSha: HEAD_B, contentDigest: 'zz'.repeat(32) });
  const b2 = r2.value.items.find((i) => i.id === 'requiredGate').evidence.binding;
  assert.equal(b2.status, 'CONTRADICTORY', 'malformed explicit contentDigest must be a conflict');
  assert.match(r2.value.items.find((i) => i.id === 'requiredGate').note, /not a sha256/i);
  assert.notEqual(r2.value.status, 'COMPLETE');

  // (c) truly absent head+digest -> the existing UNBOUND semantics stay
  const r3 = build({ verdict: 'PASS', exitCode: 0 });
  const b3 = r3.value.items.find((i) => i.id === 'requiredGate').evidence.binding;
  assert.equal(b3.status, 'UNBOUND', 'absent explicit fields keep UNBOUND');
  assert.deepEqual(b3.conflicts, [], 'absence is not a conflict');
  assert.equal(r3.value.items.find((i) => i.id === 'requiredGate').status, 'PENDING');

  // (d) valid explicit head+digest -> the existing BOUND semantics stay
  const r4 = build({ verdict: 'PASS', exitCode: 0, headSha: HEAD_B, contentDigest: FIXTURE_CONTENT_DIGEST });
  const b4 = r4.value.items.find((i) => i.id === 'requiredGate').evidence.binding;
  assert.equal(b4.status, 'BOUND', 'a valid explicit binding stays BOUND');
});
