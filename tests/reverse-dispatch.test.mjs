// tests/reverse-dispatch.test.mjs — deterministic tests for the reverse
// control leg (Issue #67). No network beyond loopback; no real GPT; every
// fail-closed path proven, not assumed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReverseDispatchServer } from '../packages/reverse-dispatch/reverse-dispatch-server.mjs';
import { applyValidatedDecision, readAppliedInstruction, contractHintPath, APPLIED_MARKER_PREFIX } from '../packages/reverse-dispatch/reverse-waiter.mjs';
import { validateGptDecision, ledgerPath } from '../packages/reverse-dispatch/reverse-dispatch.mjs';

function tmpState(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-rev-disp-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

const EXPECT = { repo: 'duongpdddic-droid/Soc_brain', taskRef: 'Issue #67', stateDigest: 'a'.repeat(64) };
const NOW = new Date('2026-09-05T12:00:00.000Z');
const issued = NOW.toISOString();

function envelope(over = {}) {
  return {
    requestId: 'e2e-rev-00000001',
    repo: EXPECT.repo,
    taskRef: EXPECT.taskRef,
    stateDigest: EXPECT.stateDigest,
    decision: 'CONTINUE',
    issuedAt: issued,
    instruction: 'Create e2e/reverse-leg-marker.txt with the exact content given in executorHint.',
    ...over,
  };
}

test('validateGptDecision: happy path CONTINUE', (t) => {
  const stateDir = tmpState(t);
  const v = validateGptDecision(envelope(), EXPECT, { stateDir, now: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.envelope.decision, 'CONTINUE');
});

test('validateGptDecision: ENVELOPE_MALFORMED on non-object', (t) => {
  const stateDir = tmpState(t);
  for (const bad of [null, 'x', 42, [], true]) {
    const v = validateGptDecision(bad, EXPECT, { stateDir, now: NOW });
    assert.equal(v.ok, false);
    assert.equal(v.code, 'ENVELOPE_MALFORMED');
  }
});

test('validateGptDecision: MISSING_FIELD per required field', (t) => {
  const stateDir = tmpState(t);
  const required = ['requestId', 'repo', 'taskRef', 'stateDigest', 'decision', 'issuedAt', 'instruction'];
  for (const k of required) {
    const e = envelope();
    delete e[k];
    const v = validateGptDecision(e, EXPECT, { stateDir, now: NOW });
    assert.equal(v.ok, false, k);
    assert.equal(v.code, 'MISSING_FIELD', k);
    assert.equal(v.field, k);
  }
});

test('validateGptDecision: FIELD_INVALID formats', (t) => {
  const stateDir = tmpState(t);
  const cases = [
    ['requestId', 'short'],                       // < 8 chars
    ['repo', 'no-slash'],
    ['taskRef', 'a'.repeat(129)],                 // > 128 chars
    ['stateDigest', 'zz'.repeat(32)],             // not hex
    ['decision', 'MAKE_COFFEE'],                  // outside #63 enum
    ['issuedAt', 'not-a-timestamp'],
  ];
  for (const [k, val] of cases) {
    const v = validateGptDecision(envelope({ [k]: val }), EXPECT, { stateDir, now: NOW });
    assert.equal(v.ok, false, k);
    assert.equal(v.code, 'FIELD_INVALID', k);
    assert.equal(v.field, k, k);
  }
});

test('validateGptDecision: INSTRUCTION_TOO_LARGE', (t) => {
  const stateDir = tmpState(t);
  const v = validateGptDecision(envelope({ instruction: 'x'.repeat(8 * 1024 + 1) }), EXPECT, { stateDir, now: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'INSTRUCTION_TOO_LARGE');
});

test('validateGptDecision: BINDING_MISMATCH each echo field', (t) => {
  const stateDir = tmpState(t);
  for (const [k, val] of [['repo', 'other/repo'], ['taskRef', 'Issue #99'], ['stateDigest', 'b'.repeat(64)]]) {
    const v = validateGptDecision(envelope({ [k]: val }), EXPECT, { stateDir, now: NOW });
    assert.equal(v.ok, false, k);
    assert.equal(v.code, 'BINDING_MISMATCH', k);
    assert.equal(v.field, k, k);
  }
});

test('validateGptDecision: EXPIRED_DECISION (too old and too future)', (t) => {
  const stateDir = tmpState(t);
  const old = validateGptDecision(envelope({ issuedAt: '2026-09-05T11:00:00.000Z' }), EXPECT, { stateDir, now: NOW });
  assert.equal(old.ok, false);
  assert.equal(old.code, 'EXPIRED_DECISION');
  const future = validateGptDecision(envelope({ issuedAt: '2026-09-05T12:10:00.000Z' }), EXPECT, { stateDir, now: NOW });
  assert.equal(future.ok, false);
  assert.equal(future.code, 'EXPIRED_DECISION');
});

test('validateGptDecision: REPLAYED_REQUEST_ID once-only per stateDir ledger', (t) => {
  const stateDir = tmpState(t);
  const first = validateGptDecision(envelope(), EXPECT, { stateDir, now: NOW });
  assert.equal(first.ok, true);
  assert.ok(fs.existsSync(ledgerPath({ stateDir })));
  const second = validateGptDecision(envelope(), EXPECT, { stateDir, now: NOW });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'REPLAYED_REQUEST_ID');
});

test('validateGptDecision: REPLAY_LEDGER_UNAVAILABLE fails closed on corrupt ledger', (t) => {
  const stateDir = tmpState(t);
  fs.mkdirSync(path.dirname(ledgerPath({ stateDir })), { recursive: true });
  fs.writeFileSync(ledgerPath({ stateDir }), '{not-json-at-all', 'utf8');
  const v = validateGptDecision(envelope(), EXPECT, { stateDir, now: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'REPLAY_LEDGER_UNAVAILABLE');
});

test('applyValidatedDecision: writes hint block, idempotent on re-apply', (t) => {
  const stateDir = tmpState(t);
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-rev-wt-'));
  t.after(() => { try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* best effort */ } });
  const e = envelope({ executorHint: 'markerPath=e2e/reverse-leg-marker.txt' });
  const a1 = applyValidatedDecision(e, { worktreePath: wt, stateDir, now: NOW });
  assert.equal(a1.ok, true);
  assert.equal(a1.idempotent, false);
  assert.equal(a1.hintPath, contractHintPath(wt));
  const text = fs.readFileSync(a1.hintPath, 'utf8');
  assert.ok(text.includes(`${APPLIED_MARKER_PREFIX}${e.requestId} `));
  assert.ok(text.includes(e.instruction));
  assert.ok(text.includes('executorHint'));
  const a2 = applyValidatedDecision(e, { worktreePath: wt, stateDir, now: NOW });
  assert.equal(a2.ok, true);
  assert.equal(a2.idempotent, true);
  const text2 = fs.readFileSync(a1.hintPath, 'utf8');
  assert.equal((text2.match(new RegExp(APPLIED_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1);
});

test('readAppliedInstruction: round-trips the applied instruction', (t) => {
  const stateDir = tmpState(t);
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-rev-wt-'));
  t.after(() => { try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* best effort */ } });
  const e = envelope();
  applyValidatedDecision(e, { worktreePath: wt, stateDir, now: NOW });
  const r = readAppliedInstruction(contractHintPath(wt), e.requestId);
  assert.equal(r.ok, true);
  assert.equal(r.instruction, e.instruction);
  assert.equal(readAppliedInstruction(contractHintPath(wt), 'other-request-0001').code, 'HINT_NOT_APPLIED');
});

async function post(url, body, headers = { 'Content-Type': 'application/json' }) {
  const res = await fetch(url, { method: 'POST', headers, body });
  return { status: res.status, json: await res.json() };
}

test('server: 200 applied on valid decision over real loopback HTTP', async (t) => {
  const stateDir = tmpState(t);
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-rev-wt-'));
  t.after(() => { try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* best effort */ } });
  const s = createReverseDispatchServer({ expect: EXPECT, worktreePath: wt, stateDir, now: NOW });
  const port = await s.listen();
  try {
    const r = await post(`http://127.0.0.1:${port}/decision`, JSON.stringify(envelope()));
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.idempotent, false);
  } finally {
    await s.close();
  }
});

test('server: fail-closed HTTP statuses', async (t) => {
  const stateDir = tmpState(t);
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-rev-wt-'));
  t.after(() => { try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* best effort */ } });
  const s = createReverseDispatchServer({ expect: EXPECT, worktreePath: wt, stateDir, now: NOW });
  const port = await s.listen();
  try {
    const url = `http://127.0.0.1:${port}/decision`;
    const bad = await post(url, '{not json');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'ENVELOPE_MALFORMED');
    const mismatch = await post(url, JSON.stringify(envelope({ repo: 'other/repo' })));
    assert.equal(mismatch.status, 422);
    assert.equal(mismatch.json.code, 'BINDING_MISMATCH');
    const replay = await post(url, JSON.stringify(envelope()));
    assert.equal(replay.status, 200);
    const again = await post(url, JSON.stringify(envelope({ requestId: 'e2e-rev-00000001' })));
    assert.equal(again.status, 422);
    assert.equal(again.json.code, 'REPLAYED_REQUEST_ID');
    const wrongMethod = await fetch(url, { method: 'GET' });
    assert.equal(wrongMethod.status, 405);
    const wrongPath = await post(`http://127.0.0.1:${port}/nope`, '{}');
    assert.equal(wrongPath.status, 404);
    const big = await post(url, 'x'.repeat(64 * 1024 + 1));
    assert.equal(big.status, 413);
  } finally {
    await s.close();
  }
});

test('server: telemetry records rejections for malformed calls', async (t) => {
  const stateDir = tmpState(t);
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-rev-wt-'));
  t.after(() => { try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* best effort */ } });
  const { telemetryPath: tp } = await import('../packages/reverse-dispatch/reverse-dispatch.mjs');
  const s = createReverseDispatchServer({ expect: EXPECT, worktreePath: wt, stateDir, now: NOW });
  const port = await s.listen();
  try {
    await post(`http://127.0.0.1:${port}/decision`, 'not-json');
  } finally {
    await s.close();
  }
  const lines = fs.readFileSync(tp({ stateDir }), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.kind === 'REJECTED' && l.code === 'ENVELOPE_MALFORMED'));
});