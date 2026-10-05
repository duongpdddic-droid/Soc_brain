// tests/review-model-policy.test.mjs — PRE-GATE-REVIEW-01 model policy.
// Proves the operator directive (2026-10-04) end to end:
//   - the pinned list is ordered, exact-id, free-only and ≤ 3 attempts;
//   - primary success never calls a fallback;
//   - only CLASSIFIED availability errors (rate limit / model unavailable /
//     provider error / timeout) fall back, primary → MiMo Free → another
//     OpenCode Free model, one attempt per model, same candidate;
//   - findings are a valid outcome: CHANGES_REQUESTED with NO fallback;
//   - paid / out-of-list models are refused BEFORE any spawn;
//   - malformed output, binding drift and unclassified exits are typed-fail
//     with no fallback; exhausting the budget is a typed fail, not a retry
//     loop; each attempt keeps its own binding, model and failure reason and
//     the per-attempt timeout is never raised.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOcrReviewTransport } from '../packages/control-loop/ocr-review-transport.mjs';
import {
  REVIEW_MODEL_PIN_LIST,
  REVIEW_MODEL_MAX_ATTEMPTS,
  validateModelPinList,
  classifyReviewLegFailure,
  isAllowlistedReviewModel,
} from '../packages/control-loop/review-model-policy.mjs';

const HEAD_A = 'a'.repeat(40);
const BASE_A = 'b'.repeat(40);
const REPO = 'duongpdddic-droid/soc_brain';

const [PRIMARY, MIMO_FREE, DEEPSEEK_FREE] = REVIEW_MODEL_PIN_LIST;

function mkCandidate() {
  return {
    repo: REPO, issueNumber: 903, identityHash: 'f'.repeat(32),
    baseSha: BASE_A, headSha: HEAD_A, worktreePath: 'C:/wt',
  };
}
function mkReq(headSha = HEAD_A) {
  return { repo: REPO, pr: 272, headSha, projectId: 'soc_brain' };
}
function mkTransport({ runLeg, evidenceDir, modelPinList, timeoutMs } = {}) {
  const dir = evidenceDir || fs.mkdtempSync(path.join(os.tmpdir(), 'rmp-'));
  const t = createOcrReviewTransport({
    controlRepo: 'C:/ctrl',
    evidenceDir: dir,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(modelPinList !== undefined ? { modelPinList } : {}),
    runLeg,
  });
  return { t, dir };
}
function readSidecars(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

// ---- pin list shape ----------------------------------------------------------

test('pin list is ordered primary→fallback, exact ids, free-only, within budget', () => {
  assert.equal(REVIEW_MODEL_MAX_ATTEMPTS, 3);
  assert.ok(REVIEW_MODEL_PIN_LIST.length <= REVIEW_MODEL_MAX_ATTEMPTS);
  assert.equal(PRIMARY.tier, 'primary');
  assert.equal(PRIMARY.id, 'nine-router/Soc_OR_free_act');
  assert.equal(PRIMARY.provider, 'nine-router');
  assert.equal(MIMO_FREE.id, 'opencode/mimo-v2.6-flash-free');
  assert.equal(DEEPSEEK_FREE.id, 'opencode/deepseek-v4-flash-free');
  for (const m of REVIEW_MODEL_PIN_LIST) {
    assert.equal(m.free, true, `${m.id} must be verified free`);
    assert.ok(isAllowlistedReviewModel(m.id));
  }
  const v = validateModelPinList(REVIEW_MODEL_PIN_LIST);
  assert.equal(v.ok, true, JSON.stringify(v));
});

test('classify: only proven availability errors are fallback-eligible', () => {
  const avail = (code, detail) => classifyReviewLegFailure(code, detail);
  assert.equal(avail('REVIEW_TIMEOUT', 'review run exceeded').classification, 'availability');
  assert.equal(avail('REVIEW_TIMEOUT', 'x').kind, 'timeout');
  assert.equal(avail('REVIEW_EXIT_NONZERO', 'exit 1 429 rate limit exceeded').kind, 'rate_limit');
  assert.equal(avail('REVIEW_EXIT_NONZERO', 'exit 1 model not found').kind, 'model_unavailable');
  assert.equal(avail('REVIEW_EXIT_NONZERO', 'exit 1 provider returned 503').kind, 'provider_error');
  // contract failures never fall back
  assert.equal(avail('REVIEW_RESULT_MALFORMED', 'no json').classification, 'contract');
  assert.equal(avail('REVIEW_BINDING_INVALID', 'bad').classification, 'contract');
  assert.equal(avail('HEAD_DRIFT', 'x').classification, 'contract');
  // a batch wrapper hiding a contract code stays contract
  assert.equal(avail('REVIEW_BATCH_FAILED', 'REVIEW_RESULT_MALFORMED: bad').classification, 'contract');
  // an unclassified nonzero exit is NOT claimed as availability (fail closed)
  assert.equal(avail('REVIEW_EXIT_NONZERO', 'exit 1 something odd').classification, 'contract');
  assert.equal(avail('REVIEW_SPAWN_FAILED', 'ENOENT').classification, 'contract');
});

// ---- transport attempt loop --------------------------------------------------

test('primary succeeds → exactly one leg call, no fallback', async () => {
  const seen = [];
  const { t, dir } = mkTransport({
    runLeg: (args) => { seen.push(args.model); return { ok: true, value: { canonical: { findings: [] }, digest: 'e'.repeat(64), findingsCount: 0 }, batch: { batched: false }, rulesDigest: 'd'.repeat(64) }; },
  });
  const res = await t(mkReq(), { candidate: mkCandidate() });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.verdict, 'APPROVED');
  assert.equal(res.model, PRIMARY.id);
  assert.deepEqual(seen, [PRIMARY.id], 'fallback must not run after a clean primary');
  const sc = readSidecars(dir);
  assert.equal(sc.length, 1);
  assert.equal(sc[0].attempt.model, PRIMARY.id);
  assert.deepEqual(sc[0].policy.pinList, [PRIMARY.id, MIMO_FREE.id, DEEPSEEK_FREE.id]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findings are valid → CHANGES_REQUESTED with NO model swap', async () => {
  const seen = [];
  const { t, dir } = mkTransport({
    runLeg: (args) => { seen.push(args.model); return { ok: true, value: { canonical: { findings: [{ path: 'a.js', severity: 'high', content: 'bug' }] }, digest: 'e'.repeat(64), findingsCount: 1 }, batch: { batched: false } }; },
  });
  const res = await t(mkReq(), { candidate: mkCandidate() });
  assert.equal(res.ok, true);
  assert.equal(res.verdict, 'CHANGES_REQUESTED');
  assert.equal(res.findings.length, 1);
  assert.deepEqual(seen, [PRIMARY.id], 'findings must never trigger a fallback');
  const sc = readSidecars(dir);
  assert.equal(sc[0].outcome, 'completed');
  assert.equal(sc[0].verdict, 'CHANGES_REQUESTED');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('primary rate-limited → falls back to MiMo Free (2 calls, ordered)', async () => {
  const seen = [];
  const { t, dir } = mkTransport({
    runLeg: (args) => {
      seen.push(args.model);
      if (args.model === PRIMARY.id) return { ok: false, code: 'REVIEW_EXIT_NONZERO', detail: 'exit 1 429 rate limit exceeded' };
      return { ok: true, value: { canonical: { findings: [] }, digest: 'e'.repeat(64), findingsCount: 0 }, batch: { batched: false } };
    },
  });
  const res = await t(mkReq(), { candidate: mkCandidate() });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.verdict, 'APPROVED');
  assert.equal(res.model, MIMO_FREE.id);
  assert.deepEqual(seen, [PRIMARY.id, MIMO_FREE.id]);
  const sc = readSidecars(dir);
  assert.equal(sc.length, 2, 'one sidecar per attempt');
  assert.equal(sc[0].outcome, 'refused');
  assert.equal(sc[0].classification.classification, 'availability');
  assert.equal(sc[0].classification.kind, 'rate_limit');
  assert.equal(sc[0].attempt.binding.headSha, HEAD_A, 'failed attempt keeps candidate binding');
  assert.equal(sc[1].outcome, 'completed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('primary + MiMo unavailable → third pinned Free model; then budget', async () => {
  const seen = [];
  const { t, dir } = mkTransport({
    runLeg: (args) => {
      seen.push(args.model);
      if (args.model === PRIMARY.id) return { ok: false, code: 'REVIEW_EXIT_NONZERO', detail: 'exit 1 provider 503' };
      if (args.model === MIMO_FREE.id) return { ok: false, code: 'REVIEW_EXIT_NONZERO', detail: 'exit 1 model not found' };
      return { ok: true, value: { canonical: { findings: [] }, digest: 'e'.repeat(64), findingsCount: 0 }, batch: { batched: false } };
    },
  });
  const res = await t(mkReq(), { candidate: mkCandidate() });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(seen, [PRIMARY.id, MIMO_FREE.id, DEEPSEEK_FREE.id]);
  assert.equal(res.model, DEEPSEEK_FREE.id);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('frozen clock: attempts sharing one timestamp still keep one file each', async () => {
  // REWORK regression: sidecar filenames used to embed the wall-clock time,
  // so two attempts written in the same millisecond overwrote each other
  // (reviewer saw 1 of 2 files). The name is now runId + attempt index.
  const { t, dir } = mkTransport({
    runLeg: (args) => {
      if (args.model === PRIMARY.id) return { ok: false, code: 'REVIEW_EXIT_NONZERO', detail: 'exit 1 429 rate limit exceeded' };
      return { ok: true, value: { canonical: { findings: [] }, digest: 'e'.repeat(64), findingsCount: 0 }, batch: { batched: false } };
    },
  });
  const origToIso = Date.prototype.toISOString;
  Date.prototype.toISOString = () => '2026-10-04T12:00:00.000Z';
  let res;
  try {
    res = await t(mkReq(), { candidate: mkCandidate() });
  } finally {
    Date.prototype.toISOString = origToIso;
  }
  assert.equal(res.ok, true, JSON.stringify(res));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 2, `a frozen clock must not merge attempts: ${JSON.stringify(files)}`);
  assert.equal(new Set(files).size, 2, 'filenames must be unique — no attempt overwritten');
  for (const f of files) {
    assert.match(f, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-attempt-\d\.json$/, `name = runId + attempt index, not a timestamp: ${f}`);
  }
  const sc = readSidecars(dir);
  assert.equal(sc.length, 2, 'both payloads readable after the collision window');
  assert.equal(sc[0].outcome, 'refused');
  assert.equal(sc[0].attempt.index, 0);
  assert.equal(sc[0].classification.kind, 'rate_limit');
  assert.equal(sc[1].outcome, 'completed');
  assert.equal(sc[1].attempt.index, 1);
  assert.equal(sc[0].runId, sc[1].runId, 'both attempts belong to the same runId');
  assert.equal(sc[0].at, '2026-10-04T12:00:00.000Z', 'wall clock is kept in the payload only');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('leg contract: findings are read from value.canonical, verdict CHANGES_REQUESTED', async () => {
  // The real leg returns { canonical, digest, findingsCount } (review-
  // delegate-evidence.mjs). The transport must surface canonical.findings.
  const { t, dir } = mkTransport({
    runLeg: () => ({
      ok: true,
      value: { canonical: { findings: [{ path: 'cart.js', severity: 'critical', content: 'Off-by-one in the loop bounds' }] }, digest: 'e'.repeat(64), findingsCount: 1 },
      batch: { batched: false }, rulesDigest: 'd'.repeat(64),
    }),
  });
  const res = await t(mkReq(), { candidate: mkCandidate() });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.verdict, 'CHANGES_REQUESTED');
  assert.equal(res.findings.length, 1, 'canonical.findings must reach the composite');
  assert.equal(res.findings[0].path, 'cart.js');
  const sc = readSidecars(dir);
  assert.equal(sc[0].outcome, 'completed');
  assert.equal(sc[0].verdict, 'CHANGES_REQUESTED');
  assert.equal(sc[0].findingsCount, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('flat value.findings (wrong leg shape) → REVIEW_EVIDENCE_INVALID, never false CLEAN', async () => {
  // Regression for the fail-open bug the BUG-SEED proof caught: a leg result
  // without value.canonical must be a typed contract failure — NOT an
  // implicit clean review.
  const seen = [];
  const { t, dir } = mkTransport({
    runLeg: (args) => {
      seen.push(args.model);
      return { ok: true, value: { findings: [{ path: 'a.js', severity: 'high', content: 'bug' }] } };
    },
  });
  const res = await t(mkReq(), { candidate: mkCandidate() });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.reason, 'REVIEW_EVIDENCE_INVALID');
  assert.equal(seen.length, 1, 'a contract failure must never fall back to another model');
  const sc = readSidecars(dir);
  assert.equal(sc[0].outcome, 'refused');
  assert.equal(sc[0].classification.classification, 'contract');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('all attempts unavailable → REVIEW_MODEL_BUDGET_EXHAUSTED typed fail (no loop)', async () => {
  const seen = [];
  const { t, dir } = mkTransport({
    runLeg: (args) => { seen.push(args.model); return { ok: false, code: 'REVIEW_EXIT_NONZERO', detail: 'exit 1 rate limit 429' }; },
  });
  const res = await t(mkReq(), { candidate: mkCandidate() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'REVIEW_MODEL_BUDGET_EXHAUSTED');
  assert.equal(seen.length, 3, 'exactly one attempt per pinned model');
  assert.equal(new Set(seen).size, 3, 'no model retried');
  const sc = readSidecars(dir);
  const last = sc[sc.length - 1];
  assert.equal(last.outcome, 'budget-exhausted');
  assert.equal(last.attempts.length, 3, 'every attempt recorded with model + reason');
  for (const a of last.attempts) {
    assert.ok(a.model && a.provider && a.binding && a.failure, 'attempt keeps model/provider/binding/reason');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('malformed reviewer output → typed fail, NO fallback (1 call only)', async () => {
  const seen = [];
  const { t, dir } = mkTransport({
    runLeg: (args) => { seen.push(args.model); return { ok: false, code: 'REVIEW_RESULT_MALFORMED', detail: 'no fenced json' }; },
  });
  const res = await t(mkReq(), { candidate: mkCandidate() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'REVIEW_RESULT_MALFORMED');
  assert.deepEqual(seen, [PRIMARY.id], 'a contract failure must never reach another model');
  const sc = readSidecars(dir);
  assert.equal(sc[sc.length - 1].classification.classification, 'contract');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('binding drift (request head != candidate head) refuses before spawn', async () => {
  const seen = [];
  const { t, dir } = mkTransport({ runLeg: (args) => { seen.push(args.model); return { ok: true, value: { canonical: { findings: [] }, digest: 'e'.repeat(64), findingsCount: 0 } }; } });
  const res = await t(mkReq('c'.repeat(40)), { candidate: mkCandidate() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'HEAD_DRIFT');
  assert.equal(seen.length, 0, 'drift is refused before any spawn');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('paid entry → REVIEW_MODEL_PAID_FORBIDDEN before spawn', async () => {
  const seen = [];
  const paidList = [{ ...PRIMARY, free: false }, { ...MIMO_FREE }];
  const { t, dir } = mkTransport({ runLeg: (args) => { seen.push(args.model); return { ok: true, value: { canonical: { findings: [] }, digest: 'e'.repeat(64), findingsCount: 0 } }; }, modelPinList: paidList });
  const res = await t(mkReq(), { candidate: mkCandidate() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'REVIEW_MODEL_PAID_FORBIDDEN');
  assert.equal(seen.length, 0, 'paid model must be rejected BEFORE spawn');
  const sc = readSidecars(dir);
  assert.equal(sc[0].outcome, 'policy-refused');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('model outside the verified allowlist → rejected before spawn', async () => {
  const seen = [];
  const evil = [{ id: 'openrouter/moonshotai/kimi-k3', provider: 'openrouter', tier: 'primary', free: true }];
  const { t } = mkTransport({ runLeg: (args) => { seen.push(args.model); return { ok: true, value: { canonical: { findings: [] }, digest: 'e'.repeat(64), findingsCount: 0 } }; }, modelPinList: evil });
  const res = await t(mkReq(), { candidate: mkCandidate() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'REVIEW_MODEL_NOT_ALLOWLISTED');
  assert.equal(seen.length, 0, 'out-of-list model must be rejected BEFORE spawn');
});

test('pin list over budget (>3) is refused as policy-invalid before spawn', async () => {
  const seen = [];
  const { t } = mkTransport({
    runLeg: (args) => { seen.push(args.model); return { ok: true, value: { canonical: { findings: [] }, digest: 'e'.repeat(64), findingsCount: 0 } }; },
    modelPinList: [{ ...PRIMARY }, { ...MIMO_FREE }, { ...DEEPSEEK_FREE }, { ...MIMO_FREE, id: 'opencode/mimo-v2.5-free' }],
  });
  const res = await t(mkReq(), { candidate: mkCandidate() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'REVIEW_MODEL_POLICY_INVALID');
  assert.equal(seen.length, 0);
});

test('the per-attempt timeout is passed through unchanged on every attempt', async () => {
  const timeouts = [];
  const { t, dir } = mkTransport({
    timeoutMs: 1234,
    runLeg: (args) => {
      timeouts.push(args.timeoutMs);
      if (timeouts.length < 3) return { ok: false, code: 'REVIEW_TIMEOUT', detail: 'exceeded' };
      return { ok: true, value: { canonical: { findings: [] }, digest: 'e'.repeat(64), findingsCount: 0 }, batch: { batched: false } };
    },
  });
  const res = await t(mkReq(), { candidate: mkCandidate() });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(timeouts, [1234, 1234, 1234], 'timeout must never grow across fallback attempts');
  fs.rmSync(dir, { recursive: true, force: true });
});
