// tests/internal-review-handoff.test.mjs — OCR internal review -> Soc Loop ->
// handoff gate -> checklist (targeted verification matrix).
//
// Covers, with real loop/packet/checklist code and deterministic offline
// transports:
//   T1  missing OCR review record  -> INTERNAL_REVIEW_PENDING, NO packet,
//       no READY_FOR_REVIEW, never reaches the reviewers/delivery
//   T2  stale review (session head moved / live HEAD moved / foreign code
//       changed after the review) and unresolved findings -> typed refusal,
//       NO packet
//   T3  findings -> bounded rework round -> clean review -> READY_FOR_REVIEW
//       packet + checklist DONE items
//   T4  interruption + resume: the verify step (and therefore the OCR review)
//       is invoked exactly ONCE across the two runs — no duplicate invocation
//   T5  checklist is a read-only projection: DONE only with a valid record,
//       a passing required gate NEVER marks the OCR item DONE, and the
//       projection mutates no session/ledger bytes

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
import { identityHash } from '../packages/workspace/workspace.mjs';
import { withOcrInternalReview, fixtureInternalReview } from './fixtures/ocr-internal-review.mjs';

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
    preReview: preReview ?? (() => ({ ok: true, value: { verdict: 'PASS', findings: [] } })),
    finalReview: finalReview ?? (() => ({ ok: true, value: { verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.99, metadata: {} } })),
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
  const writeLedger = (stateDir, records) => {
    const dir = path.join(stateDir, 'control-loop', ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transitions.jsonl'),
      records.map((r) => JSON.stringify({ schemaVersion: '1', identityHash: ID, ...r })).join('\n'), 'utf8');
  };
  const boundary = (evidence) => ({
    ts: '2026-10-05T00:00:00.000Z', from: 'VERIFYING', to: 'PRE_REVIEWING', reason: null, evidence,
  });

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
    const git = fakeGit({ head: HEAD_B });
    writeLedger(stateDir, [boundary({ internalReview: fixtureInternalReview({ repo: REPO, issueNumber: ISSUE, headSha: HEAD_A }) })]);
    const r = projectReviewReadyPacket({ sessionPath, stateDir, exec: git.exec });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.code, 'INTERNAL_REVIEW_STALE');
    assert.match(String(r.detail.reason), /HEAD moved after the internal review/);
    assert.equal(packetsIn(stateDir).length, 0);
  }

  // (c) foreign code changed after the review (worktree no longer clean) -> STALE
  {
    const stateDir = mkStateDir();
    const { sessionPath } = mkSession(stateDir);
    const git = fakeGit({ head: HEAD_A, dirty: ' M packages/control-loop/control-loop.mjs' });
    writeLedger(stateDir, [boundary({ internalReview: fixtureInternalReview({ repo: REPO, issueNumber: ISSUE, headSha: HEAD_A }) })]);
    const r = projectReviewReadyPacket({ sessionPath, stateDir, exec: git.exec });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.code, 'INTERNAL_REVIEW_STALE');
    assert.match(String(r.detail.reason), /code changed after the internal review/);
    assert.deepEqual(r.detail.foreignPaths, ['packages/control-loop/control-loop.mjs']);
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

  // (g) an ERROR that prevents proving freshness (unreadable HEAD/status) is
  //     INTERNAL_REVIEW_PENDING — only PROVEN drift is STALE.
  {
    const stateDir = mkStateDir();
    const { sessionPath } = mkSession(stateDir);
    const brokenExec = () => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository' });
    writeLedger(stateDir, [boundary({ internalReview: fixtureInternalReview({ repo: REPO, issueNumber: ISSUE, headSha: HEAD_A }) })]);
    const r = projectReviewReadyPacket({ sessionPath, stateDir, exec: brokenExec });
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
    { ts: 't1', from: 'VERIFYING', to: 'PRE_REVIEWING', reason: null, evidence: { verdict: 'PASS', evidence: { exitCode: 0, executionRecordPath: 'x' } } },
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
