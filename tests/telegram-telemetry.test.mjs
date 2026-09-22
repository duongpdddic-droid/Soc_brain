// tests/telegram-telemetry.test.mjs — Issue #9000021 granular FSM milestone telemetry.
// 6 milestone events: ROUTED, EXECUTING, VERIFYING, FINAL_REVIEWING, DECIDING, DELIVERING.
// 100% offline: Telegram transport fully mocked via spawn injection (no network).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  NOTIFIABLE_EVENTS,
  DELIVERY_STATUSES,
  dispatchLifecycleEvent,
  buildTelegramText,
  dispatchPathFor,
  readDispatchRecords,
} from '../packages/telegram-dispatch/telegram-dispatch.mjs';
import {
  GRANULAR_MILESTONE_EVENTS,
  bindLoop,
  readTransitions,
} from '../packages/control-loop/control-loop.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

const REPO = 'duongpdddic-droid/Soc_brain';
const ISSUE = 9000021;
const HEAD = 'a'.repeat(40);

const MILESTONES = ['ROUTED', 'EXECUTING', 'VERIFYING', 'FINAL_REVIEWING', 'DECIDING', 'DELIVERING'];
const EMOJI = {
  ROUTED: '🚀',
  EXECUTING: '⚙️',
  VERIFYING: '🧪',
  FINAL_REVIEWING: '🔍',
  DECIDING: '⚖️',
  DELIVERING: '🛑',
};

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-tel-')); }

function mkSession(stateDir) {
  return {
    schemaVersion: '1',
    state: 'SESSION_ACTIVE',
    taskId: `${REPO}#${ISSUE}`,
    repo: REPO,
    issueNumber: ISSUE,
    headSha: HEAD,
    baseSha: 'f'.repeat(40),
    branch: 'agent/tel-test',
    controlPlane: { stateDir },
  };
}

function ledgerPath(stateDir) {
  return dispatchPathFor({ stateDir, identityHash: identityHash({ repo: REPO, issueNumber: ISSUE }) });
}

// Mock transport: records every outgoing text, returns API_ACCEPTED.
function mkAcceptRecorder() {
  const sent = [];
  const spawn = (cmd, args, opts) => {
    let text = '';
    try {
      const input = opts && opts.input ? String(opts.input) : '';
      const payload = JSON.parse(input.trim().split(/\r?\n/).pop());
      text = payload.text || '';
    } catch { /* ignore malformed input */ }
    sent.push(text);
    return {
      error: 0,
      stdout: JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 1000 + sent.length, chatId: 816272951 }) + '\n',
      stderr: '',
    };
  };
  return { spawn, sent };
}

// Network-failure simulations.
const throwingSpawn = () => { throw new Error('ETIMEDOUT'); };
const httpFailSpawn = () => ({
  error: 0,
  stdout: JSON.stringify({ ok: false, status: 'DELIVERY_FAILED', error: 'HTTP_429' }) + '\n',
  stderr: '',
});

// ============================================================================
// A. Contract surface: the 6 granular events are registered end-to-end
// ============================================================================

test('A1. GRANULAR_MILESTONE_EVENTS exports exactly the 6 milestone names', () => {
  assert.deepEqual(Object.keys(GRANULAR_MILESTONE_EVENTS).sort(), [...MILESTONES].sort());
  assert.ok(Object.isFrozen(GRANULAR_MILESTONE_EVENTS));
  for (const e of MILESTONES) assert.equal(GRANULAR_MILESTONE_EVENTS[e], e);
});

test('A2. NOTIFIABLE_EVENTS includes all 6 granular milestones', () => {
  for (const e of MILESTONES) {
    assert.ok(NOTIFIABLE_EVENTS.includes(e), `${e} must be in NOTIFIABLE_EVENTS`);
  }
  assert.ok(Object.isFrozen(NOTIFIABLE_EVENTS));
});

test('A3. DELIVERY_STATUSES stays truthful (no USER_RECEIVED)', () => {
  assert.deepEqual([...DELIVERY_STATUSES], ['NOT_ATTEMPTED', 'API_ACCEPTED', 'DELIVERY_FAILED']);
});

// ============================================================================
// B. Formatting: each milestone renders with its visual icon + task identity
// ============================================================================

test('B1. buildTelegramText: each milestone has the correct emoji + identity header', () => {
  const session = mkSession('/tmp/unused');
  for (const e of MILESTONES) {
    const text = buildTelegramText({ event: e, session });
    const firstLine = text.split('\n')[0];
    assert.equal(
      firstLine,
      `${EMOJI[e]} ${e} — Soc_brain ${REPO}#${ISSUE}`,
      `${e} header mismatch: ${firstLine}`,
    );
    assert.ok(text.includes('Ref:'), `${e} must carry Ref metadata`);
    assert.ok(text.length > 50 && text.length <= 1400, `${e} body must be non-empty and bounded`);
  }
});

test('B2. all 6 milestone icons are distinct visual markers', () => {
  const icons = MILESTONES.map((e) => EMOJI[e]);
  assert.equal(new Set(icons).size, 6, 'each milestone needs a unique icon');
});

test('B2b. exact icon per contract: 🚀 ⚙️ 🧪 🔍 ⚖️ 🛑', () => {
  assert.equal(EMOJI.ROUTED, '🚀');
  assert.equal(EMOJI.EXECUTING, '⚙️');
  assert.equal(EMOJI.VERIFYING, '🧪');
  assert.equal(EMOJI.FINAL_REVIEWING, '🔍');
  assert.equal(EMOJI.DECIDING, '⚖️');
  assert.equal(EMOJI.DELIVERING, '🛑');
});

test('B3. milestone messages are HTML-escaped and length-bounded', () => {
  const session = mkSession('/tmp/unused');
  const xss = buildTelegramText({ event: 'DECIDING', session, note: '<script>alert(1)</script>' });
  assert.ok(xss.includes('&lt;script&gt;'), 'note must be escaped');
  assert.ok(!xss.includes('<script>'), 'raw script tag must not leak');
  const long = buildTelegramText({ event: 'DELIVERING', session, note: 'y'.repeat(5000) });
  assert.ok(long.length <= 1400, 'text must be bounded at 1400 chars');
});

// ============================================================================
// C. FSM sample chain walk: dispatch all 6 milestones in order
// ============================================================================

test('C1. walking the sample FSM chain dispatches all 6 milestone messages in order', () => {
  const stateDir = mkStateDir();
  const session = mkSession(stateDir);
  const { spawn, sent } = mkAcceptRecorder();

  // Sample chain: ACCEPTED -> ROUTED -> EXECUTING -> VERIFYING ->
  // PRE_REVIEWING -> FINAL_REVIEWING -> DECIDING -> DELIVERING -> COMPLETED
  const chain = [
    ['ACCEPTED', 'ROUTED'],
    ['ROUTED', 'EXECUTING'],
    ['EXECUTING', 'VERIFYING'],
    ['VERIFYING', 'PRE_REVIEWING'],
    ['PRE_REVIEWING', 'FINAL_REVIEWING'],
    ['FINAL_REVIEWING', 'DECIDING'],
    ['DECIDING', 'DELIVERING'],
    ['DELIVERING', 'COMPLETED'],
  ];
  const sessionPath = path.join(stateDir, 'sessions', 'c1.json');
  const loop = bindLoop({ sessionPath, identityHash: 'c1-hash', stateDir });

  const dispatched = [];
  for (const [from, to] of chain) {
    const t = loop.transition({ from, to, reason: 'telemetry-walk' });
    assert.ok(t.ok, `${from}->${to} must be a legal transition`);
    if (GRANULAR_MILESTONE_EVENTS[to]) {
      const r = dispatchLifecycleEvent({
        session, event: to, stateDir, spawn, allowNonCanonicalStateRoot: true,
      });
      assert.equal(r.status, 'API_ACCEPTED', `${to} must reach API_ACCEPTED, got ${r.status}`);
      dispatched.push(to);
    }
  }

  // All 6 milestones dispatched, in chain order.
  assert.deepEqual(dispatched, MILESTONES, 'dispatch order must match milestone chain order');
  assert.equal(sent.length, 6, 'exactly 6 Telegram messages must be sent');
  for (let i = 0; i < MILESTONES.length; i++) {
    assert.ok(sent[i].includes(MILESTONES[i]), `message ${i} must contain ${MILESTONES[i]}`);
    assert.ok(sent[i].includes(EMOJI[MILESTONES[i]]), `message ${i} must contain ${EMOJI[MILESTONES[i]]}`);
    assert.ok(sent[i].includes(`${REPO}#${ISSUE}`), `message ${i} must identify the task`);
  }

  // Ledger: intent + API_ACCEPTED result for each of the 6 = 12 records.
  const recs = readDispatchRecords(ledgerPath(stateDir));
  assert.equal(recs.length, 12, 'intent+result for each of 6 events');
  for (const e of MILESTONES) {
    const accepted = recs.filter((r) => r.event === e && r.status === 'API_ACCEPTED');
    assert.equal(accepted.length, 1, `${e} must have exactly one accepted record`);
    assert.equal(accepted[0].repo, REPO, `${e} record must carry repo identity`);
    assert.equal(accepted[0].issueNumber, ISSUE, `${e} record must carry issue identity`);
  }

  // FSM ledger recorded the full chain.
  const transitions = readTransitions({ stateDir, identityHash: 'c1-hash' });
  assert.equal(transitions.length, 8, 'all 8 chain transitions recorded');
  const last = transitions[transitions.length - 1];
  assert.equal(last.to, 'COMPLETED', 'FSM must reach COMPLETED');
});

test('C2. each milestone transition state maps 1:1 to its Telegram event', () => {
  // The milestone states in the FSM chain are exactly the 6 notifiable events.
  const chainStates = ['ROUTED', 'EXECUTING', 'VERIFYING', 'FINAL_REVIEWING', 'DECIDING', 'DELIVERING'];
  assert.deepEqual(chainStates, MILESTONES);
  for (const s of chainStates) {
    assert.ok(GRANULAR_MILESTONE_EVENTS[s], `${s} must be a granular milestone`);
    assert.ok(NOTIFIABLE_EVENTS.includes(s), `${s} must be notifiable`);
  }
});

// ============================================================================
// D. Resilience: Telegram failures never stop the FSM reaching destination
// ============================================================================

test('D1. throwing transport (network crash) does not throw out of dispatch', () => {
  const stateDir = mkStateDir();
  const session = mkSession(stateDir);
  // Must NOT throw — reaching the assertions proves no exception escaped.
  const r = dispatchLifecycleEvent({
    session, event: 'ROUTED', stateDir, spawn: throwingSpawn, allowNonCanonicalStateRoot: true,
  });
  assert.ok(r, 'dispatch must return a result object');
  assert.notEqual(r.status, 'API_ACCEPTED', 'failure must be truthful');
  assert.ok(['NOT_ATTEMPTED', 'DELIVERY_FAILED'].includes(r.status), `got ${r.status}`);
  // Evidence persisted for later recovery.
  const recs = readDispatchRecords(ledgerPath(stateDir));
  assert.ok(recs.length >= 2, 'intent + failure result must be persisted');
  assert.equal(recs[0].phase, 'intent', 'intent is written before the send attempt');
});

test('D2. HTTP-failure transport (429/502) records truthful DELIVERY_FAILED', () => {
  const stateDir = mkStateDir();
  const session = mkSession(stateDir);
  const r = dispatchLifecycleEvent({
    session, event: 'VERIFYING', stateDir, spawn: httpFailSpawn, allowNonCanonicalStateRoot: true,
  });
  assert.equal(r.status, 'DELIVERY_FAILED');
  const recs = readDispatchRecords(ledgerPath(stateDir));
  const failed = recs.filter((x) => x.event === 'VERIFYING' && x.status === 'DELIVERY_FAILED');
  assert.equal(failed.length, 1, 'failure must be persisted truthfully');
});

test('D3. FSM reaches COMPLETED even when every milestone Telegram send fails', () => {
  const stateDir = mkStateDir();
  const session = mkSession(stateDir);
  const sessionPath = path.join(stateDir, 'sessions', 'd3.json');
  const loop = bindLoop({ sessionPath, identityHash: 'd3-hash', stateDir });

  const chain = [
    ['ACCEPTED', 'ROUTED'],
    ['ROUTED', 'EXECUTING'],
    ['EXECUTING', 'VERIFYING'],
    ['VERIFYING', 'PRE_REVIEWING'],
    ['PRE_REVIEWING', 'FINAL_REVIEWING'],
    ['FINAL_REVIEWING', 'DECIDING'],
    ['DECIDING', 'DELIVERING'],
    ['DELIVERING', 'COMPLETED'],
  ];

  let dispatchAttempts = 0;
  for (const [from, to] of chain) {
    const t = loop.transition({ from, to, reason: 'resilience-walk' });
    assert.ok(t.ok, `${from}->${to} must succeed with Telegram down`);
    if (GRANULAR_MILESTONE_EVENTS[to]) {
      dispatchAttempts += 1;
      // Alternate throw / HTTP-fail to cover both transport failure modes.
      const spawn = dispatchAttempts % 2 === 1 ? throwingSpawn : httpFailSpawn;
      const r = dispatchLifecycleEvent({
        session, event: to, stateDir, spawn, allowNonCanonicalStateRoot: true,
      });
      assert.ok(r, `${to} dispatch must return, not throw`);
      assert.notEqual(r.status, 'API_ACCEPTED', `${to} failure must be truthful`);
    }
  }

  assert.equal(dispatchAttempts, 6, 'all 6 milestones attempted');
  const transitions = readTransitions({ stateDir, identityHash: 'd3-hash' });
  const last = transitions[transitions.length - 1];
  assert.equal(last.to, 'COMPLETED', 'FSM must reach COMPLETED despite Telegram failures');
  // Every failure left persisted evidence (recoverable, not silent).
  const recs = readDispatchRecords(ledgerPath(stateDir));
  for (const e of MILESTONES) {
    const evRecs = recs.filter((r) => r.event === e);
    assert.ok(evRecs.length >= 2, `${e} must have persisted intent+result evidence`);
  }
});

// ============================================================================
// E. Dedupe + recovery contract for milestone events
// ============================================================================

test('E1. milestone replay after API_ACCEPTED dedupes (no second send)', () => {
  const stateDir = mkStateDir();
  const session = mkSession(stateDir);
  const { spawn, sent } = mkAcceptRecorder();
  const r1 = dispatchLifecycleEvent({ session, event: 'FINAL_REVIEWING', stateDir, spawn, allowNonCanonicalStateRoot: true });
  assert.equal(r1.status, 'API_ACCEPTED');
  assert.equal(sent.length, 1);
  const r2 = dispatchLifecycleEvent({ session, event: 'FINAL_REVIEWING', stateDir, spawn, allowNonCanonicalStateRoot: true });
  assert.equal(r2.deduped, true, 'replay must dedupe');
  assert.equal(r2.messageId, r1.messageId, 'dedupe must return the original messageId');
  assert.equal(sent.length, 1, 'no second send after acceptance');
});

test('E2. non-milestone / unknown events are rejected as EVENT_NOT_NOTIFIABLE', () => {
  const stateDir = mkStateDir();
  const session = mkSession(stateDir);
  const { spawn } = mkAcceptRecorder();
  for (const bad of ['NOT_A_MILESTONE', 'SESSION_ACTIVE', '', 'ROUTED ']) {
    const r = dispatchLifecycleEvent({ session, event: bad, stateDir, spawn, allowNonCanonicalStateRoot: true });
    assert.equal(r.reason, 'EVENT_NOT_NOTIFIABLE', `event "${bad}" must be rejected`);
  }
});

test('E3. missing session identity fails closed without dispatching', () => {
  const stateDir = mkStateDir();
  const { spawn, sent } = mkAcceptRecorder();
  const r = dispatchLifecycleEvent({
    session: { repo: REPO }, event: 'ROUTED', stateDir, spawn, allowNonCanonicalStateRoot: true,
  });
  assert.equal(r.status, 'NOT_ATTEMPTED');
  assert.equal(r.reason, 'SESSION_IDENTITY_INVALID');
  assert.equal(sent.length, 0, 'nothing may be sent without identity');
});
