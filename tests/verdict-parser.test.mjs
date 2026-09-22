// tests/verdict-parser.test.mjs — Review verdict parser + ControlLoop auto-transition.
// 100% offline/mock: no live HTTP, no live CDP, no live clipboard, no network.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  REVIEW_VERDICTS,
  FSM_VERDICTS,
  REVIEW_VERDICT_TO_FSM,
  VERDICT_PARSER_CODES,
  VERDICT_PARSER_SCHEMA_VERSION,
  parseReviewVerdict,
  normalizeReviewDecision,
} from '../packages/control-loop/verdict-parser.mjs';
import { readTransitions, runControlLoop } from '../packages/control-loop/control-loop.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'f'.repeat(40);
const WORKTREES_ROOT = path.join(os.tmpdir(), 'verdict-parser-wt-root');
const REPO = 'duongpdddic-droid/soc_brain';

function mkSession(stateDir, overrides = {}) {
  const repo = overrides.repo || REPO;
  const issueNumber = overrides.issueNumber || 4242;
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
    worktreePath: path.join(WORKTREES_ROOT, `issue-${issueNumber}`),
    worktreesRoot: WORKTREES_ROOT,
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session, id };
}

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-parser-test-')); }

// ---- module surface ---------------------------------------------------------

test('surface: verdict enums, mapping and codes are frozen and complete', () => {
  assert.deepEqual([...REVIEW_VERDICTS], ['APPROVED', 'CHANGES_REQUESTED', 'BLOCKED']);
  assert.deepEqual([...FSM_VERDICTS], ['PASS', 'REWORK', 'BLOCKED']);
  assert.equal(REVIEW_VERDICT_TO_FSM.APPROVED, 'PASS');
  assert.equal(REVIEW_VERDICT_TO_FSM.CHANGES_REQUESTED, 'REWORK');
  assert.equal(REVIEW_VERDICT_TO_FSM.BLOCKED, 'BLOCKED');
  assert.ok(Object.isFrozen(REVIEW_VERDICTS));
  assert.ok(Object.isFrozen(FSM_VERDICTS));
  assert.ok(Object.isFrozen(REVIEW_VERDICT_TO_FSM));
  assert.ok(Object.isFrozen(VERDICT_PARSER_CODES));
  assert.equal(VERDICT_PARSER_SCHEMA_VERSION, '1');
  for (const code of Object.values(VERDICT_PARSER_CODES)) assert.match(code, /^VERDICT_/);
});

// ---- parseReviewVerdict: happy paths ---------------------------------------

test('parse: final-line APPROVED maps to PASS with pre-verdict findings', () => {
  const r = parseReviewVerdict('Analysis line one.\nFindings: fix the off-by-one.\nVERDICT: APPROVED');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.rawVerdict, 'APPROVED');
  assert.equal(r.value.verdict, 'PASS');
  assert.deepEqual(r.value.findings, ['Analysis line one.', 'Findings: fix the off-by-one.']);
});

test('parse: final-line CHANGES_REQUESTED maps to REWORK', () => {
  const r = parseReviewVerdict('Bug in helper.\nVERDICT: CHANGES_REQUESTED');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.verdict, 'REWORK');
  assert.equal(r.value.rawVerdict, 'CHANGES_REQUESTED');
});

test('parse: final-line BLOCKED maps to BLOCKED', () => {
  const r = parseReviewVerdict('Missing evidence bundle.\nVERDICT: BLOCKED');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.verdict, 'BLOCKED');
});

test('parse: CRLF line endings and trailing blank lines still parse', () => {
  const r = parseReviewVerdict('reason\r\nVERDICT: APPROVED\r\n\r\n   \n');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.verdict, 'PASS');
});

test('parse: findings are bounded at 500 chars per line', () => {
  const long = `x${'a'.repeat(600)}`;
  const r = parseReviewVerdict(`${long}\nVERDICT: BLOCKED`);
  assert.equal(r.ok, true);
  assert.equal(r.value.findings[0].length, 501); // 500 chars + ellipsis
  assert.ok(r.value.findings[0].endsWith('…'));
});

// ---- parseReviewVerdict: fail-closed paths ---------------------------------

test('parse: non-string and empty input fail closed', () => {
  assert.equal(parseReviewVerdict(null).code, VERDICT_PARSER_CODES.VERDICT_INPUT_INVALID);
  assert.equal(parseReviewVerdict(42).code, VERDICT_PARSER_CODES.VERDICT_INPUT_INVALID);
  assert.equal(parseReviewVerdict('').code, VERDICT_PARSER_CODES.VERDICT_INPUT_INVALID);
  assert.equal(parseReviewVerdict('   \n  ').code, VERDICT_PARSER_CODES.VERDICT_INPUT_INVALID);
});

test('parse: response without any VERDICT line fails VERDICT_NOT_FOUND', () => {
  const r = parseReviewVerdict('Looks fine to me, shipping it.');
  assert.equal(r.ok, false);
  assert.equal(r.code, VERDICT_PARSER_CODES.VERDICT_NOT_FOUND);
});

test('parse: invalid final verdict token fails VERDICT_TOKEN_INVALID', () => {
  const dotted = parseReviewVerdict('reason\nVERDICT: APPROVED.');
  assert.equal(dotted.ok, false);
  assert.equal(dotted.code, VERDICT_PARSER_CODES.VERDICT_TOKEN_INVALID);
  const lower = parseReviewVerdict('reason\nverdict: approved');
  assert.equal(lower.ok, false);
  assert.equal(lower.code, VERDICT_PARSER_CODES.VERDICT_NOT_FOUND); // prefix is case-sensitive
});

test('parse: verdict line not final fails VERDICT_NOT_FINAL', () => {
  const r = parseReviewVerdict('VERDICT: APPROVED\nThanks, looks good to me.');
  assert.equal(r.ok, false);
  assert.equal(r.code, VERDICT_PARSER_CODES.VERDICT_NOT_FINAL);
});

test('parse: markdown-fenced verdict fails closed (never parsed)', () => {
  const r = parseReviewVerdict('reason\n```\nVERDICT: APPROVED\n```');
  assert.equal(r.ok, false);
  assert.equal(r.code, VERDICT_PARSER_CODES.VERDICT_NOT_FINAL);
});

test('parse: two strict verdict lines fail VERDICT_AMBIGUOUS', () => {
  const r = parseReviewVerdict('VERDICT: BLOCKED\nmore analysis\nVERDICT: APPROVED');
  assert.equal(r.ok, false);
  assert.equal(r.code, VERDICT_PARSER_CODES.VERDICT_AMBIGUOUS);
});

// ---- normalizeReviewDecision: structured decisions -------------------------

test('normalize: structured PASS/REWORK/BLOCKED decisions pass through byte-identical', () => {
  const session = { repo: REPO, issueNumber: 4242, headSha: HEAD };
  const pass = { verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.99, metadata: { source: 'gpt-final-review' } };
  const rework = { verdict: 'REWORK', findings: ['f1'], evidenceRequests: ['e1'], binding: { repository: REPO, issue: 4242, headSha: HEAD } };
  const blocked = { verdict: 'BLOCKED', findings: ['fatal'] };
  for (const d of [pass, rework, blocked]) {
    const r = normalizeReviewDecision({ decision: d, session });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.value, d); // same reference: no clone, no re-stamp, no field added
  }
  // A structured REWORK WITHOUT binding is NOT back-filled: the GPT
  // echoed-binding gate must keep failing it (existing fail-closed behavior).
  const naked = { verdict: 'REWORK', findings: ['f'] };
  const r = normalizeReviewDecision({ decision: naked, session });
  assert.equal(r.ok, true);
  assert.equal(r.value, naked);
  assert.equal(naked.binding, undefined);
});

test('normalize: raw-token verdict fields map to FSM verdicts and stamp session binding', () => {
  const session = { repo: REPO, issueNumber: 4242, headSha: HEAD };
  const approved = normalizeReviewDecision({ decision: { verdict: 'APPROVED', findings: [] }, session });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(approved.value.verdict, 'PASS');
  assert.deepEqual(approved.value.binding, { repository: REPO, issue: 4242, headSha: HEAD });

  const changes = normalizeReviewDecision({ decision: { verdict: 'CHANGES_REQUESTED', findings: ['f'] }, session });
  assert.equal(changes.ok, true, JSON.stringify(changes));
  assert.equal(changes.value.verdict, 'REWORK');
  assert.deepEqual(changes.value.binding, { repository: REPO, issue: 4242, headSha: HEAD });

  const lower = normalizeReviewDecision({ decision: { verdict: 'pass' }, session });
  assert.equal(lower.ok, true);
  assert.equal(lower.value.verdict, 'PASS');
});

test('normalize: unknown structured verdict fails VERDICT_UNKNOWN (no DELIVERING fall-through)', () => {
  const r = normalizeReviewDecision({ decision: { verdict: 'SHIPPED' }, session: { repo: REPO, issueNumber: 4242, headSha: HEAD } });
  assert.equal(r.ok, false);
  assert.equal(r.code, VERDICT_PARSER_CODES.VERDICT_UNKNOWN);
});

// ---- normalizeReviewDecision: raw text shapes ------------------------------

test('normalize: raw response text (string / text / response / raw / rawResponse) parses', () => {
  const session = { repo: REPO, issueNumber: 4242, headSha: HEAD };
  const text = 'Deep review.\nVERDICT: CHANGES_REQUESTED';
  for (const decision of [text, { text }, { response: text }, { raw: text }, { rawResponse: text }, { ok: true, text }]) {
    const r = normalizeReviewDecision({ decision, session });
    assert.equal(r.ok, true, JSON.stringify({ decision, r }));
    assert.equal(r.value.verdict, 'REWORK');
    assert.equal(r.value.metadata.source, 'verdict-parser');
    assert.equal(r.value.metadata.rawVerdict, 'CHANGES_REQUESTED');
    assert.deepEqual(r.value.binding, { repository: REPO, issue: 4242, headSha: HEAD });
    assert.deepEqual(r.value.evidenceRequests, []);
    assert.ok(r.value.findings.includes('Deep review.'));
  }
});

test('normalize: parsed BLOCKED needs no delivery-shaped fields; APPROVED maps to PASS', () => {
  const session = { repo: REPO, issueNumber: 4242, headSha: HEAD };
  const b = normalizeReviewDecision({ decision: 'no diff evidence\nVERDICT: BLOCKED', session });
  assert.equal(b.ok, true);
  assert.equal(b.value.verdict, 'BLOCKED');
  const a = normalizeReviewDecision({ decision: 'VERDICT: APPROVED', session });
  assert.equal(a.ok, true);
  assert.equal(a.value.verdict, 'PASS');
});

// ---- normalizeReviewDecision: fail-closed identity/text gates --------------

test('normalize: missing decision / missing text / unparseable text fail closed', () => {
  const session = { repo: REPO, issueNumber: 4242, headSha: HEAD };
  assert.equal(normalizeReviewDecision({ decision: null, session }).code, VERDICT_PARSER_CODES.VERDICT_DECISION_MISSING);
  assert.equal(normalizeReviewDecision({ decision: undefined, session }).code, VERDICT_PARSER_CODES.VERDICT_DECISION_MISSING);
  assert.equal(normalizeReviewDecision({ decision: ['x'], session }).code, VERDICT_PARSER_CODES.VERDICT_DECISION_MISSING);
  assert.equal(normalizeReviewDecision({ decision: { findings: ['f'] }, session }).code, VERDICT_PARSER_CODES.VERDICT_TEXT_MISSING);
  assert.equal(normalizeReviewDecision({ decision: 'no verdict line', session }).code, VERDICT_PARSER_CODES.VERDICT_NOT_FOUND);
});

test('normalize: session identity is required to bind a parsed verdict', () => {
  const r = normalizeReviewDecision({ decision: 'VERDICT: APPROVED', session: null });
  assert.equal(r.ok, false);
  assert.equal(r.code, VERDICT_PARSER_CODES.VERDICT_SESSION_IDENTITY_MISSING);
  const r2 = normalizeReviewDecision({ decision: 'VERDICT: APPROVED', session: { issueNumber: 1 } });
  assert.equal(r2.code, VERDICT_PARSER_CODES.VERDICT_SESSION_IDENTITY_MISSING);
});

test('normalize: REWORK derivation without a 40-hex session headSha fails VERDICT_BINDING_UNAVAILABLE', () => {
  const session = { repo: REPO, issueNumber: 4242, headSha: 'not-a-sha' };
  const r = normalizeReviewDecision({ decision: 'needs rework\nVERDICT: CHANGES_REQUESTED', session });
  assert.equal(r.ok, false);
  assert.equal(r.code, VERDICT_PARSER_CODES.VERDICT_BINDING_UNAVAILABLE);
  // PASS does not require a head binding (delivery falls back to session head).
  const p = normalizeReviewDecision({ decision: 'fine\nVERDICT: APPROVED', session });
  assert.equal(p.ok, true);
  assert.equal(p.value.binding, undefined);
});

// ---- ControlLoop integration: raw verdict auto-transitions the FSM ---------

function baseDeps(calls, extra = {}) {
  return {
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: '/fake/execution.json' } }; },
    verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
    telegramSpawn: () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 900 })}\n` }),
    ...extra,
  };
}

test('loop: raw VERDICT: APPROVED auto-transitions DECIDING -> DELIVERING -> COMPLETED', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const calls = [];
  const deps = baseDeps(calls, {
    finalReview: () => { calls.push('finalReview'); return { ok: true, value: { text: 'All good after offline gates.\nVERDICT: APPROVED' } }; },
  });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  assert.deepEqual(calls, ['router', 'executor', 'verifier', 'preReview', 'finalReview', 'delivery']);
  const records = readTransitions({ stateDir, identityHash: ID });
  const boundary = records.find((r) => r.from === 'DECIDING' && r.to === 'DELIVERING');
  assert.ok(boundary, 'DECIDING -> DELIVERING boundary must exist');
  assert.equal(boundary.evidence.verdict, 'PASS');
  assert.equal(boundary.evidence.metadata.source, 'verdict-parser');
  assert.deepEqual(boundary.evidence.binding, { repository: REPO, issue: 4242, headSha: HEAD });
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'COMPLETED');
});

test('loop: raw VERDICT: CHANGES_REQUESTED auto-transitions to the rework leg, then PASS completes', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { controlPlane: { stateDir } });
  const execPath = path.join(stateDir, 'executions', `${ID}.json`);
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.writeFileSync(execPath, JSON.stringify({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: ID,
    taskId: `${REPO}#4242`, repo: REPO, issueNumber: 4242,
    terminalStatus: 'ok', exitCode: 0,
  }, null, 2), 'utf8');
  const calls = [];
  let n = 0;
  const deps = baseDeps(calls, {
    executor: (ctx) => {
      calls.push(ctx.reworkInstruction ? 'executor:rework' : 'executor');
      return { ok: true, value: { executionRecordPath: execPath } };
    },
    finalReview: () => {
      calls.push('finalReview');
      n += 1;
      return n === 1
        ? { ok: true, value: { text: 'Off-by-one in the parser bounds.\nVERDICT: CHANGES_REQUESTED' } }
        : { ok: true, value: { verdict: 'PASS', findings: [], evidenceRequests: [], metadata: {} } };
    },
  });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'COMPLETED');
  assert.deepEqual(calls, ['router', 'executor', 'verifier', 'preReview', 'finalReview', 'executor:rework', 'verifier', 'preReview', 'finalReview', 'delivery']);
  const records = readTransitions({ stateDir, identityHash: ID });
  const rw = records.find((r) => r.from === 'DECIDING' && r.to === 'REWORK');
  assert.ok(rw, 'DECIDING -> REWORK transition must exist');
  assert.equal(rw.evidence.binding.repository, REPO);
  assert.equal(rw.evidence.binding.issue, 4242);
  assert.equal(rw.evidence.binding.headSha, HEAD);
  assert.ok(rw.evidence.findings.some((f) => f.includes('Off-by-one')));
  assert.equal(rw.evidence.provenance ?? undefined, undefined); // record provenance lives in the persisted rework record, not the ledger
});

test('loop: raw VERDICT: BLOCKED auto-transitions DECIDING -> BLOCKED and terminalizes', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const calls = [];
  const deps = baseDeps(calls, {
    finalReview: () => ({ ok: true, value: { text: 'Evidence bundle missing.\nVERDICT: BLOCKED' } }),
    delivery: () => { assert.fail('delivery must NOT run on BLOCKED'); },
  });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.state, 'BLOCKED');
  assert.equal(res.value.decision.verdict, 'BLOCKED');
  assert.equal(res.value.decision.metadata.source, 'verdict-parser');
  assert.ok(res.value.decision.findings.some((f) => f.includes('Evidence bundle missing.')));
  assert.ok(!calls.includes('delivery'));
  const records = readTransitions({ stateDir, identityHash: ID });
  const blk = records.find((r) => r.from === 'DECIDING' && r.to === 'BLOCKED');
  assert.ok(blk, 'DECIDING -> BLOCKED transition must exist');
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'BLOCKED');
});

test('loop: unparseable final-review text fails closed with VERDICT_* before any terminal transition', async () => {
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const calls = [];
  const deps = baseDeps(calls, {
    finalReview: () => ({ ok: true, value: { text: 'I could not decide anything.' } }),
    delivery: () => { assert.fail('delivery must NOT run on a parse failure'); },
  });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, VERDICT_PARSER_CODES.VERDICT_NOT_FOUND);
  // No terminal state, no delivery, no DECIDING side-transition: the ledger
  // stays at FINAL_REVIEWING -> DECIDING so a resume may re-obtain the review.
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state, 'SESSION_ACTIVE');
  assert.ok(!calls.includes('delivery'));
  const records = readTransitions({ stateDir, identityHash: ID });
  const last = records[records.length - 1];
  assert.equal(last.from, 'FINAL_REVIEWING');
  assert.equal(last.to, 'DECIDING');
});
