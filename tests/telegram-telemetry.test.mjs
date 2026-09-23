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
  boundTelegramText,
  awaitDispatchSlot,
  resetDispatchQueueForTests,
  TELEGRAM_DISPATCH_INTERVAL_MS,
} from '../packages/telegram-dispatch/telegram-dispatch.mjs';
import {
  sendJsonWithRetry,
  MAX_ATTEMPTS,
  REQUEST_TIMEOUT_MS,
  RETRY_DELAYS_MS,
} from '../packages/telegram-dispatch/telegram-worker.mjs';
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

// ==========================================================================
// C3. FIFO dispatch queue: sequential 6-milestone processing, no loss, spacing
// ==========================================================================

test('C3. six milestone sends keep the 400ms FIFO minimum even when env attempts to lower it', () => {
  resetDispatchQueueForTests();
  const previousInterval = process.env.TELEGRAM_DISPATCH_INTERVAL_MS;
  process.env.TELEGRAM_DISPATCH_INTERVAL_MS = '1';
  try {
    const stateDir = mkStateDir();
    const session = mkSession(stateDir);
    const { spawn, sent } = mkAcceptRecorder();
    const stamps = [];
    const wrapped = (cmd, args, opts) => { stamps.push(Date.now()); return spawn(cmd, args, opts); };
    const interval = TELEGRAM_DISPATCH_INTERVAL_MS;
    const miles = ['ROUTED', 'EXECUTING', 'VERIFYING', 'FINAL_REVIEWING', 'DECIDING', 'DELIVERING'];
    const out = [];
    for (const e of miles) {
      out.push(dispatchLifecycleEvent({ session, event: e, stateDir, spawn: wrapped, allowNonCanonicalStateRoot: true }));
    }
    assert.equal(sent.length, 6, 'all 6 milestone messages must be sent (no loss)');
    assert.equal(out.filter((r) => r.status === 'API_ACCEPTED').length, 6);
    assert.equal(stamps.length, 6);
    for (let i = 1; i < stamps.length; i++) {
      const gap = stamps[i] - stamps[i - 1];
      assert.ok(gap >= interval - 5, `gap ${i}=${gap}ms must be >= ~${interval}ms (FIFO rate-limit)`);
    }
    for (let i = 0; i < miles.length; i++) {
      assert.ok(sent[i].includes(miles[i]), `sent[${i}] must contain ${miles[i]}`);
    }
    const recs = readDispatchRecords(ledgerPath(stateDir));
    assert.equal(recs.length, 12, 'intent+result for each of 6 events');
  } finally {
    if (previousInterval === undefined) delete process.env.TELEGRAM_DISPATCH_INTERVAL_MS;
    else process.env.TELEGRAM_DISPATCH_INTERVAL_MS = previousInterval;
    resetDispatchQueueForTests();
  }
});

test('C3b. TELEGRAM_DISPATCH_INTERVAL_MS default export is 400', () => {
  assert.equal(TELEGRAM_DISPATCH_INTERVAL_MS, 400);
});

// ==========================================================================
// F. Entity-safe truncation + worker retry/timeout (offline, injectable IO)
// ==========================================================================

test('F1. boundTelegramText never leaves a partial HTML entity at the cut', () => {
  for (const [entity, prefixLength] of [['&amp;', 1396], ['&lt;', 1397], ['&gt;', 1397]]) {
    const prefix = 'x'.repeat(prefixLength);
    const out = boundTelegramText(prefix + entity, 1400);
    assert.ok(!out.endsWith('&'), `${entity} must not leave a partial entity`);
    assert.equal(out, prefix);
  }
  const long = buildTelegramText({ event: 'DELIVERING', session: mkSession('/tmp/u'), note: '&'.repeat(5000) });
  const lastAmp = long.lastIndexOf('&');
  if (lastAmp !== -1) assert.ok(long.indexOf(';', lastAmp) !== -1, 'any trailing & must open a complete entity');
  assert.ok(long.length <= 1400);
});

test('F2. boundTelegramText does not split a surrogate pair', () => {
  const emoji = 'y'.repeat(1399) + '\u{1F680}';
  const out = boundTelegramText(emoji, 1400);
  assert.ok(out.length <= 1400);
  const last = out.charCodeAt(out.length - 1);
  assert.ok(!(last >= 0xD800 && last <= 0xDBFF), 'must not end on a lone high surrogate');
});

test('F3. worker: HTTP 429 then success retries once with RETRY_DELAYS_MS backoff', async () => {
  const delays = [];
  let calls = 0;
  const r = await sendJsonWithRetry({
    url: 'https://example.invalid/sendMessage',
    payload: { chat_id: 1, text: 'hi' },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7, chat: { id: 8 } } }) };
    },
    sleepImpl: async (ms) => { delays.push(ms); },
  });
  assert.equal(r.status, 'API_ACCEPTED');
  assert.equal(r.messageId, 7);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [RETRY_DELAYS_MS[0]], "first backoff must be 1000ms");
});

test('F4. worker: timeout aborts safely WITHOUT retry (fail-safe, no FSM crash)', async () => {
  let calls = 0;
  const r = await sendJsonWithRetry({
    url: 'https://example.invalid/sendMessage',
    payload: { chat_id: 1, text: 'hi' },
    fetchImpl: async () => {
      calls += 1;
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    },
    sleepImpl: async () => {},
  });
  assert.equal(r.status, 'DELIVERY_FAILED');
  assert.equal(r.timeout, true);
  assert.equal(r.attempts, 1, 'timeout must not burn retries');
  assert.equal(r.error, `TIMEOUT_${REQUEST_TIMEOUT_MS}MS`);
  assert.equal(calls, 1);
  assert.equal(REQUEST_TIMEOUT_MS, 5000);
  assert.equal(MAX_ATTEMPTS, 4);
  assert.deepEqual([...RETRY_DELAYS_MS], [1000, 2000, 4000]);
});

test('F5. worker: non-retryable HTTP 400 fails immediately (no retry)', async () => {
  let calls = 0;
  const r = await sendJsonWithRetry({
    url: 'https://example.invalid/sendMessage',
    payload: {},
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 400, json: async () => ({}) };
    },
    sleepImpl: async () => {},
  });
  assert.equal(r.status, 'DELIVERY_FAILED');
  assert.equal(r.error, 'HTTP_400');
  assert.equal(calls, 1);
  assert.equal(r.retryable, false);
});

test('F6. worker: every request uses the hard five-second timeout', async () => {
  const originalTimeout = AbortSignal.timeout;
  const configured = [];
  AbortSignal.timeout = (ms) => {
    configured.push(ms);
    return originalTimeout(ms);
  };
  try {
    const result = await sendJsonWithRetry({
      url: 'https://example.invalid/sendMessage',
      payload: {},
      timeoutMs: 1,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 9, chat: { id: 8 } } }),
      }),
    });
    assert.equal(result.status, 'API_ACCEPTED');
    assert.deepEqual(configured, [REQUEST_TIMEOUT_MS]);
    assert.equal(REQUEST_TIMEOUT_MS, 5000);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test('F7. worker: HTTP 502 is not retried (only HTTP 429 is retryable)', async () => {
  let calls = 0;
  const result = await sendJsonWithRetry({
    url: 'https://example.invalid/sendMessage',
    payload: {},
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 502, json: async () => ({}) };
    },
    sleepImpl: async () => {},
  });
  assert.equal(result.status, 'DELIVERY_FAILED');
  assert.equal(result.error, 'HTTP_502');
  assert.equal(calls, 1);
  assert.equal(result.retryable, false);
});

test('F8. worker: a non-transient thrown error is not retried', async () => {
  let calls = 0;
  const result = await sendJsonWithRetry({
    url: 'not-a-valid-url',
    payload: {},
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError('invalid worker configuration');
    },
    sleepImpl: async () => {},
  });
  assert.equal(result.status, 'DELIVERY_FAILED');
  assert.equal(result.error, 'NETWORK_ERROR');
  assert.equal(calls, 1);
  assert.equal(result.retryable, false);
});

test('F9. worker: a classified transient network error retries', async () => {
  let calls = 0;
  const delays = [];
  const result = await sendJsonWithRetry({
    url: 'https://example.invalid/sendMessage',
    payload: {},
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        const cause = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
        throw new TypeError('fetch failed', { cause });
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 10, chat: { id: 8 } } }) };
    },
    sleepImpl: async (ms) => { delays.push(ms); },
  });
  assert.equal(result.status, 'API_ACCEPTED');
  assert.equal(calls, 2);
  assert.deepEqual(delays, [RETRY_DELAYS_MS[0]]);
});

test('F10. awaitDispatchSlot enforces minimum gap then returns wait ms', () => {
  resetDispatchQueueForTests();
  let now = 1000000;
  const w1 = awaitDispatchSlot({ nowMs: () => now, intervalMs: 400 });
  assert.equal(w1, 0, 'first slot never waits');
  now += 100;
  const w2 = awaitDispatchSlot({ nowMs: () => now, intervalMs: 400 });
  assert.equal(w2, 300, 'second slot waits the remaining 300ms');
  resetDispatchQueueForTests();
});
