#!/usr/bin/env node
// control-loop-gpt-web2api-copy.test.mjs — ChatGPT Plus Web2API-copy final
// review transport (chatgpt-plus-web2api-copy.mjs). Fully deterministic:
// fetch/CDP-targets/CDP-session/clipboard/clock are injected fakes — no
// network, no browser, no real ChatGPT. Covers the 11 required cases.
import assert from 'node:assert';
import {
  createChatGptPlusWeb2ApiCopyTransport,
  wrapPromptForCopyExtraction,
  extractEchoReference,
  checkCopiedBinding,
  diffTurnIds,
  createCopyLock,
  WEB2API_COPY_CODES,
} from '../packages/control-loop/chatgpt-plus-web2api-copy.mjs';
import { selectGptTransport } from '../packages/control-loop/chatgpt-web-cwa.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

const DIGEST = 'a'.repeat(64);
const HEAD = 'b'.repeat(40);
const PROMPT = [
  'CANONICAL EVIDENCE: executor-reaper 22/22, full suite 401 pass.',
  `"requestDigest": "${DIGEST}"`,
  '"binding": {"repository": "duongpdddic-droid/soc_brain", "issue": 157,',
  `"headSha": "${HEAD}"}`,
].join('\n');

const goodJson = JSON.stringify({
  verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.99,
  metadata: { source: 'chatgpt-web-final-review', requestDigest: DIGEST },
  binding: { repository: 'duongpdddic-droid/soc_brain', issue: 157, headSha: HEAD },
});

function fakeTargets() {
  return [{ type: 'page', url: 'https://chatgpt.com/c/abc', webSocketDebuggerUrl: 'ws://fake/tab' }];
}

// Fake CDP session: scripted turn-id snapshots; records Input dispatches.
function fakeSessionFactory({ snapshots, keyLog }) {
  let n = 0;
  return async () => ({
    sendCalls: [],
    async send(method, params) {
      this.sendCalls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        const ids = snapshots[Math.min(n++, snapshots.length - 1)];
        return { result: { result: { value: JSON.stringify(ids) } } };
      }
      if (method === 'Input.dispatchKeyEvent') {
        keyLog.push(params.type);
        return { result: {} };
      }
      return { result: {} };
    },
    close() {},
  });
}

function fakeClipboard(readScript) {
  let i = 0;
  return {
    cleared: 0,
    clear() { this.cleared += 1; return { ok: true }; },
    read() {
      const text = i < readScript.length ? readScript[i] : readScript[readScript.length - 1];
      i += 1;
      return { ok: true, text };
    },
  };
}

const noSleep = () => Promise.resolve();

function makeTransport({ fetchRes, snapshots, reads, fetchCalls = null, extra = {}, clipboardImpl = null, bodies = null, fetchSeq = null }) {
  const keyLog = [];
  const clip = clipboardImpl || fakeClipboard(reads);
  let fetchIdx = 0;
  const t = createChatGptPlusWeb2ApiCopyTransport({
    fetchImpl: async (url, opts) => {
      if (fetchCalls) fetchCalls.count += 1;
      if (bodies) { try { bodies.push(JSON.parse(opts.body)); } catch { bodies.push(null); } }
      const res = Array.isArray(fetchSeq) ? fetchSeq[Math.min(fetchIdx++, fetchSeq.length - 1)] : fetchRes;
      if (res instanceof Error) throw res;
      return res;
    },
    listTargetsImpl: () => fakeTargets(),
    cdpSessionFactory: fakeSessionFactory({ snapshots, keyLog }),
    clipboard: clip,
    sleepImpl: noSleep,
    ...extra,
  });
  return { t, keyLog, clip };
}

// Deterministic copy clock: each sleep advances past the poll budget so one
// poll cycle ends per attempt without wall-clock waiting.
function fakeCopyClock({ step = 25 } = {}) {
  const tick = { t: 0 };
  return {
    nowImpl: () => tick.t,
    sleepImpl: () => { tick.t += step; return Promise.resolve(); },
  };
}

const okFetch = (extra = {}) => ({
  status: 200,
  json: async () => ({ conversation_id: 'conv-1', model: 'auto', ...extra }),
});

// 1. clipboard exact JSON PASS.
{
  const { t } = makeTransport({ fetchRes: okFetch(), snapshots: [['A'], ['A', 'B']], reads: [goodJson] });
  const r = await t({ prompt: PROMPT });
  eq('T1 ok', r.ok, true);
  eq('T1 text exact', r.text, goodJson);
  eq('T1 conversationId', r.conversationId, 'conv-1');
  eq('T1 canonicalRequestId', r.canonicalRequestId, DIGEST);
  eq('T1 attempts', r.transportMeta.shortcutAttempts, 1);
  eq('T1 not uncertain', r.transportMeta.submitUncertain, false);
}

// 2. first copy empty, retry 2 PASS.
{
  const clock = fakeCopyClock();
  const { t } = makeTransport({ fetchRes: okFetch(), snapshots: [['A'], ['A', 'B']], reads: ['', '', goodJson], extra: { ...clock, copyTimeoutMs: 10, copyPollMs: 1 } });
  const r = await t({ prompt: PROMPT });
  eq('T2 ok after retry', r.ok, true);
  eq('T2 attempts', r.transportMeta.shortcutAttempts, 2);
  eq('T2 text', r.text, goodJson);
}

// 3. all 3 copy attempts empty.
{
  const clock = fakeCopyClock();
  const { t } = makeTransport({ fetchRes: okFetch(), snapshots: [['A'], ['A', 'B']], reads: [''], extra: { ...clock, copyTimeoutMs: 10, copyPollMs: 1 } });
  const r = await t({ prompt: PROMPT });
  falsy('T3 not ok', r.ok);
  eq('T3 code', r.code, WEB2API_COPY_CODES.COPY_EMPTY);
  eq('T3 attempts', r.attempts, 3);
}

// 4. stale digest reject.
{
  const stale = goodJson.replace(DIGEST, 'c'.repeat(64));
  const clock = fakeCopyClock();
  const { t } = makeTransport({ fetchRes: okFetch(), snapshots: [['A'], ['A', 'B']], reads: [stale], extra: { ...clock, copyTimeoutMs: 10, copyPollMs: 1 } });
  const r = await t({ prompt: PROMPT });
  falsy('T4 not ok', r.ok);
  eq('T4 code', r.code, WEB2API_COPY_CODES.COPY_STALE);
}

// 5. wrong repo / issue / headSha reject (BINDING_MISMATCH x3).
{
  for (const [name, bad] of [
    ['repo', goodJson.replace('duongpdddic-droid/soc_brain', 'evil/repo')],
    ['issue', goodJson.replace('"issue":157', '"issue":999')],
    ['head', goodJson.replace(HEAD, 'd'.repeat(40))],
  ]) {
    const { t } = makeTransport({ fetchRes: okFetch(), snapshots: [['A'], ['A', 'B']], reads: [bad] });
    const r = await t({ prompt: PROMPT });
    falsy(`T5-${name} not ok`, r.ok);
    eq(`T5-${name} code`, r.code, WEB2API_COPY_CODES.BINDING_MISMATCH);
  }
}

// 6. submit 504 + new turn + valid clipboard => PASS path with submitUncertain.
{
  const fetch504 = { status: 504, json: async () => ({}) };
  const { t } = makeTransport({ fetchRes: fetch504, snapshots: [['A'], ['A', 'B']], reads: [goodJson] });
  const r = await t({ prompt: PROMPT });
  eq('T6 ok despite 504', r.ok, true);
  eq('T6 uncertain flagged', r.transportMeta.submitUncertain, true);
  eq('T6 turn', r.transportMeta.turnId, 'B');
}

// 7. submit 500 + no new turn => fail/reconcile path, exactly ONE submit.
{
  const fetchCalls = { count: 0 };
  const fetch500 = { status: 500, json: async () => ({}) };
  const { t } = makeTransport({ fetchRes: fetch500, snapshots: [['A'], ['A']], reads: [goodJson], fetchCalls });
  const r = await t({ prompt: PROMPT });
  falsy('T7 not ok', r.ok);
  eq('T7 code', r.code, WEB2API_COPY_CODES.TURN_NOT_OBSERVED);
  eq('T7 uncertain flagged', r.submitUncertain, true);
  eq('T7 single submit (no blind resubmit)', fetchCalls.count, 1);
}

// 8. old turn only => reject.
{
  const { t } = makeTransport({ fetchRes: okFetch(), snapshots: [['A', 'B'], ['A', 'B']], reads: [goodJson] });
  const r = await t({ prompt: PROMPT });
  falsy('T8 not ok', r.ok);
  eq('T8 code', r.code, WEB2API_COPY_CODES.TURN_NOT_OBSERVED);
}

// 9. two simultaneous review attempts => serialized, no clipboard race.
// The clipboard contract is SYNC (powershell spawnSync in production), so
// overlap can only happen at async yields (session open/evaluate/dispatch).
// Counting active send() calls across both holders proves the mutex holds.
{
  let active = 0;
  let maxActive = 0;
  // Each holder gets its OWN snapshots (session 1 = pre ['A'], session 2 =
  // post ['A','B']) so turn detection is deterministic per holder; only the
  // LOCK is shared — that is exactly what this case proves. Overlap is
  // counted ONLY inside the locked region (post-snapshot + dispatch sends);
  // pre-submit snapshots intentionally run outside the lock.
  const perHolderFactory = () => {
    let calls = 0;
    return async () => {
      calls += 1;
      const ids = calls === 1 ? ['A'] : ['A', 'B'];
      const inLock = calls === 2;
      return {
        async send(method) {
          if (inLock) {
            active += 1;
            maxActive = Math.max(maxActive, active);
          }
          await new Promise((r) => setImmediate(r));
          if (inLock) { active -= 1; }
          if (method === 'Runtime.evaluate') {
            return { result: { result: { value: JSON.stringify(ids) } } };
          }
          return { result: {} };
        },
        close() {},
      };
    };
  };
  const sharedLock = createCopyLock();
  const mkShared = () => createChatGptPlusWeb2ApiCopyTransport({
    fetchImpl: async () => okFetch(),
    listTargetsImpl: () => fakeTargets(),
    cdpSessionFactory: perHolderFactory(),
    clipboard: fakeClipboard([goodJson]),
    sleepImpl: noSleep,
    lockTimeoutMs: 10000,
    lock: sharedLock,
  });
  const [r1, r2] = await Promise.all([mkShared()({ prompt: PROMPT }), mkShared()({ prompt: PROMPT })]);
  eq('T9 both ok', r1.ok && r2.ok, true);
  eq('T9 no overlap (maxActive 1)', maxActive, 1);
}

// 10. large JSON not truncated fixture (~9KB exact).
{
  const rows = Array.from({ length: 150 }, (_, i) => `item-${String(i).padStart(4, '0')}-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ`);
  const big = JSON.stringify({ verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.99, metadata: { source: 't', requestDigest: DIGEST }, binding: { repository: 'duongpdddic-droid/soc_brain', issue: 157, headSha: HEAD }, rows });
  tru('T10 fixture is large', big.length > 5000 && big.length < 12000);
  const { t } = makeTransport({ fetchRes: okFetch(), snapshots: [['A'], ['A', 'B']], reads: [big] });
  const r = await t({ prompt: PROMPT });
  eq('T10 ok', r.ok, true);
  eq('T10 byte-exact', r.text, big);
  eq('T10 length', r.text.length, big.length);
}

// 11. selection: flag OFF default; flag ON selects web2api-copy; CWA intact.
{
  const factories = { cwaTransportFactory: () => 'CWA-T', cdpTransportFactory: () => 'CDP-T', web2apiCopyTransportFactory: () => 'W2A-T' };
  eq('T11 default none', selectGptTransport({ env: {}, ...factories }).name, 'none');
  eq('T11 flag selects copy', selectGptTransport({ env: { SOC_FINAL_REVIEW_PROVIDER: 'chatgpt-plus-web2api-copy' }, ...factories }).name, 'web2api-copy');
  eq('T11 cwa intact', selectGptTransport({ env: { SOC_CWA_FINAL_REVIEW: '1' }, ...factories }).name, 'cwa');
  eq('T11 flag wins over cwa flag', selectGptTransport({ env: { SOC_FINAL_REVIEW_PROVIDER: 'chatgpt-plus-web2api-copy', SOC_CWA_FINAL_REVIEW: '1' }, ...factories }).name, 'web2api-copy');
  eq('T11 flag without factory stays none', selectGptTransport({ env: { SOC_FINAL_REVIEW_PROVIDER: 'chatgpt-plus-web2api-copy' } }).name, 'none');
}

// Unit: prompt wrapper + echo reference + binding check + diff + lock.
{
  const w = wrapPromptForCopyExtraction('REVIEW THIS');
  tru('U1 wrapper demands one fenced block', /EXACTLY ONE fenced json code block/.test(w));
  tru('U2 wrapper keeps canonical prompt', w.startsWith('REVIEW THIS'));
  const ref = extractEchoReference(wrapPromptForCopyExtraction(PROMPT));
  eq('U3 digest ref', ref.requestDigest, DIGEST);
  eq('U4 binding ref', `${ref.repository}#${ref.issue}@${ref.headSha}`, `duongpdddic-droid/soc_brain#157@${HEAD}`);
  eq('U5 binding ok', checkCopiedBinding(goodJson, ref).ok, true);
  eq('U6 diff finds new', JSON.stringify(diffTurnIds(['A'], ['A', 'B'])), JSON.stringify(['B']));
  eq('U7 diff empty', diffTurnIds(['A'], ['A']).length, 0);
  const lock = createCopyLock();
  const g1 = await lock(1000);
  eq('U8 lock acquire', g1.ok, true);
  g1.release();
  const g2 = await lock(1000);
  eq('U9 lock re-acquire', g2.ok, true);
  g2.release();
}

// ---- T12-T19: hardened collector (sequence-scoped, interference-proof) ----
import { createClipboardCollector } from '../packages/control-loop/chatgpt-plus-web2api-copy.mjs';

// Scripted sequence clipboard: seqs consumed one per seq() call (baseline
// uses the first), reads consumed one per read() call.
function fakeClipboardSeq(reads, seqs) {
  let ri = 0;
  let si = 0;
  const last = (a) => a[a.length - 1];
  return {
    cleared: 0,
    clear() { this.cleared += 1; return { ok: true }; },
    read() { return { ok: true, text: ri < reads.length ? reads[ri++] : last(reads) }; },
    seq() { return si < seqs.length ? seqs[si++] : last(seqs); },
  };
}

const staleJson = goodJson.replace(DIGEST, 'c'.repeat(64));

// T12: ChatGPT valid copied, then user overwrites BEFORE our poll (seq jump
// 10->12 proves a missed generation). Retry dispatch re-copies the same
// block -> valid accepted. PASS with interference recorded.
{
  const clock = fakeCopyClock();
  const { t } = makeTransport({
    fetchRes: okFetch(), snapshots: [['A'], ['A', 'B']],
    clipboardImpl: fakeClipboardSeq(['user typed hello', goodJson], [10, 12, 12, 13]),
    extra: { ...clock, copyTimeoutMs: 10, copyPollMs: 1 },
  });
  const r = await t({ prompt: PROMPT });
  eq('T12 ok', r.ok, true);
  eq('T12 text is the earlier valid payload', r.text, goodJson);
  eq('T12 attempts (re-dispatch)', r.transportMeta.shortcutAttempts, 2);
  eq('T12 interference counted', r.transportMeta.interference, 1);
}

// T13: user text first, then ChatGPT valid -> PASS.
{
  const clock = fakeCopyClock();
  const { t } = makeTransport({
    fetchRes: okFetch(), snapshots: [['A'], ['A', 'B']],
    clipboardImpl: fakeClipboardSeq(['user text', goodJson], [10, 11, 11, 12]),
    extra: { ...clock, copyTimeoutMs: 10, copyPollMs: 1 },
  });
  const r = await t({ prompt: PROMPT });
  eq('T13 ok', r.ok, true);
  eq('T13 text', r.text, goodJson);
  eq('T13 attempts (second dispatch)', r.transportMeta.shortcutAttempts, 2);
  eq('T13 interference counted', r.transportMeta.interference, 1);
}

// T14: several interference events around the valid payload -> PASS, digest exact.
{
  const clock = fakeCopyClock();
  const { t } = makeTransport({
    fetchRes: okFetch(), snapshots: [['A'], ['A', 'B']],
    clipboardImpl: fakeClipboardSeq(['spam1', 'spam2', goodJson], [10, 11, 12, 13]),
    extra: { ...clock, copyTimeoutMs: 10, copyPollMs: 1 },
  });
  const r = await t({ prompt: PROMPT });
  eq('T14 ok', r.ok, true);
  eq('T14 text', r.text, goodJson);
  eq('T14 interference counted', r.transportMeta.interference, 2);
}

// T15: stale Final Review JSON only -> reject (COPY_STALE).
{
  const clock = fakeCopyClock();
  const { t } = makeTransport({
    fetchRes: okFetch(), snapshots: [['A'], ['A', 'B']],
    clipboardImpl: fakeClipboardSeq([staleJson], [10, 11]),
    extra: { ...clock, copyTimeoutMs: 10, copyPollMs: 1 },
  });
  const r = await t({ prompt: PROMPT });
  falsy('T15 not ok', r.ok);
  eq('T15 code', r.code, WEB2API_COPY_CODES.COPY_STALE);
}

// T16: two valid-looking JSONs, only one digest correct -> accept the right one.
{
  const clock = fakeCopyClock();
  const { t } = makeTransport({
    fetchRes: okFetch(), snapshots: [['A'], ['A', 'B']],
    clipboardImpl: fakeClipboardSeq([staleJson, goodJson], [10, 11, 12]),
    extra: { ...clock, copyTimeoutMs: 10, copyPollMs: 1 },
  });
  const r = await t({ prompt: PROMPT });
  eq('T16 ok', r.ok, true);
  eq('T16 text is the correct-digest payload', r.text, goodJson);
  eq('T16 interference counted (stale first)', r.transportMeta.interference, 1);
}

// T17: sequence changes but only arbitrary text -> no misattribution.
{
  const clock = fakeCopyClock();
  const { t } = makeTransport({
    fetchRes: okFetch(), snapshots: [['A'], ['A', 'B']],
    clipboardImpl: fakeClipboardSeq(['hello', 'world'], [10, 11, 12]),
    extra: { ...clock, copyTimeoutMs: 10, copyPollMs: 1 },
  });
  const r = await t({ prompt: PROMPT });
  falsy('T17 not ok', r.ok);
  eq('T17 code', r.code, WEB2API_COPY_CODES.COPY_TIMEOUT);
  eq('T17 no text surfaced', r.text, undefined);
  eq('T17 interference counted', r.interference, 2);
}

// T18: all 3 attempts see only interference -> COPY_TIMEOUT, attempts 3.
{
  const clock = fakeCopyClock();
  const { t } = makeTransport({
    fetchRes: okFetch(), snapshots: [['A'], ['A', 'B']],
    clipboardImpl: fakeClipboardSeq(['a', 'b', 'c', 'd', 'e', 'f', 'g'], [10, 11, 12, 13, 14, 15, 16, 17]),
    extra: { ...clock, copyTimeoutMs: 10, copyPollMs: 1 },
  });
  const r = await t({ prompt: PROMPT });
  falsy('T18 not ok', r.ok);
  eq('T18 code', r.code, WEB2API_COPY_CODES.COPY_TIMEOUT);
  eq('T18 attempts', r.attempts, 3);
}

// T19: collector stops on PASS / TIMEOUT / exception paths.
{
  const stops = [];
  const spyFactory = (opts) => {
    const c = createClipboardCollector(opts);
    const orig = c.stop.bind(c);
    c.stop = () => { stops.push(1); return orig(); };
    return c;
  };
  const clock = fakeCopyClock();
  const baseExtra = { ...clock, copyTimeoutMs: 10, copyPollMs: 1, collectorFactory: spyFactory };
  // (a) PASS path.
  const pa = makeTransport({ fetchRes: okFetch(), snapshots: [['A'], ['A', 'B']], reads: [goodJson], extra: baseExtra });
  const ra = await pa.t({ prompt: PROMPT });
  eq('T19a pass ok', ra.ok, true);
  // (b) TIMEOUT path.
  const pb = makeTransport({
    fetchRes: okFetch(), snapshots: [['A'], ['A', 'B']],
    clipboardImpl: fakeClipboardSeq(['zzz'], [10, 11]),
    extra: baseExtra,
  });
  const rb = await pb.t({ prompt: PROMPT });
  falsy('T19b timeout not ok', rb.ok);
  // (c) exception path: CDP dispatch throws mid-transaction.
  let throwCalls = 0;
  const throwingFactory = async () => {
    throwCalls += 1;
    const isPre = throwCalls === 1;
    return {
      async send(method) {
        if (method === 'Runtime.evaluate') {
          const ids = isPre ? ['A'] : ['A', 'B'];
          return { result: { result: { value: JSON.stringify(ids) } } };
        }
        throw new Error('CDP_SEND_BOOM');
      },
      close() {},
    };
  };
  const pc = createChatGptPlusWeb2ApiCopyTransport({
    fetchImpl: async () => okFetch(),
    listTargetsImpl: () => fakeTargets(),
    cdpSessionFactory: throwingFactory,
    clipboard: fakeClipboard([goodJson]),
    sleepImpl: noSleep,
    nowImpl: clock.nowImpl,
    copyTimeoutMs: 10,
    copyPollMs: 1,
    collectorFactory: spyFactory,
  });
  // Pre snapshot also uses the throwing factory: first call is pre (evaluate
  // ok), post call evaluates ok too; the dispatch throws -> typed CDP_LOST.
  const rc = await pc({ prompt: PROMPT });
  falsy('T19c exception not ok', rc.ok);
  eq('T19c typed code', rc.code, WEB2API_COPY_CODES.CDP_LOST);
  eq('T19 collector stopped on all paths', stops.length, 3);
}

// T20 (concurrent serialization) is covered by T9 (kept green).

// ---- T20-T25: fresh-conversation lifecycle (one transaction = one fresh conversation) ----
import { WEB2API_FRESH_SYSTEM_PART } from '../packages/control-loop/chatgpt-plus-web2api-copy.mjs';

// Sequential-evaluate session factory: each Runtime.evaluate consumes the next
// entry of `queue`. Optional throwOnDispatchAt counts dispatches (1-indexed).
function fakeSessionFactorySeq({ queue, keyLog = null, throwOnDispatchAt = -1 }) {
  let evalIdx = 0;
  let dispatches = 0;
  return async () => ({
    async send(method, params) {
      if (method === 'Runtime.evaluate') {
        const ids = queue[Math.min(evalIdx++, queue.length - 1)];
        return { result: { result: { value: JSON.stringify(ids) } } };
      }
      if (method === 'Input.dispatchKeyEvent') {
        dispatches += 1;
        if (keyLog) keyLog.push(params.type);
        if (dispatches === throwOnDispatchAt) throw new Error('Input.insertText timeout');
        return { result: {} };
      }
      return { result: {} };
    },
    close() {},
  });
}

const DIGEST2 = 'e'.repeat(64);
const PROMPT2 = [
  'CANONICAL EVIDENCE: executor-reaper 22/22, full suite 401 pass.',
  `"requestDigest": "${DIGEST2}"`,
  '"binding": {"repository": "duongpdddic-droid/soc_brain", "issue": 157,',
  `"headSha": "${HEAD}"}`,
].join('\n');
const goodJson2 = JSON.stringify({
  verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.99,
  metadata: { source: 'chatgpt-web-final-review', requestDigest: DIGEST2 },
  binding: { repository: 'duongpdddic-droid/soc_brain', issue: 157, headSha: HEAD },
});

// T20: two sequential Final Reviews on the SAME transport instance yield two
// distinct conversation IDs and two distinct turn IDs (no turn/state reuse).
{
  const fetchSeq = [okFetch({ conversation_id: 'conv-A' }), okFetch({ conversation_id: 'conv-B' })];
  let fetchIdx = 0;
  const t = createChatGptPlusWeb2ApiCopyTransport({
    fetchImpl: async () => fetchSeq[Math.min(fetchIdx++, fetchSeq.length - 1)],
    listTargetsImpl: () => fakeTargets(),
    cdpSessionFactory: fakeSessionFactorySeq({ queue: [['A'], ['A', 'B'], ['A', 'B'], ['A', 'B', 'C']] }),
    clipboard: fakeClipboard([goodJson, goodJson]),
    sleepImpl: noSleep,
  });
  const r1 = await t({ prompt: PROMPT });
  const r2 = await t({ prompt: PROMPT });
  eq('T20 both ok', r1.ok && r2.ok, true);
  eq('T20 distinct conversation IDs', r1.conversationId !== r2.conversationId, true);
  eq('T20 conv-A', r1.conversationId, 'conv-A');
  eq('T20 conv-B', r2.conversationId, 'conv-B');
  eq('T20 distinct turn IDs', r1.transportMeta.turnId !== r2.transportMeta.turnId, true);
}

// T21: server answers the second transaction with the ALREADY-SEEN conversation
// id (continued instead of fresh) => CONVERSATION_REUSED, no copy, no resubmit.
{
  const fetchCalls = { count: 0 };
  const fetchSeq = [okFetch({ conversation_id: 'conv-same' }), okFetch({ conversation_id: 'conv-same' })];
  let fetchIdx = 0;
  const clip = fakeClipboard([goodJson, goodJson]);
  const t = createChatGptPlusWeb2ApiCopyTransport({
    fetchImpl: async () => { fetchCalls.count += 1; return fetchSeq[Math.min(fetchIdx++, fetchSeq.length - 1)]; },
    listTargetsImpl: () => fakeTargets(),
    cdpSessionFactory: fakeSessionFactorySeq({ queue: [['A'], ['A', 'B'], ['A', 'B'], ['A', 'B', 'C']] }),
    clipboard: clip,
    sleepImpl: noSleep,
  });
  const r1 = await t({ prompt: PROMPT });
  const r2 = await t({ prompt: PROMPT });
  eq('T21 first ok', r1.ok, true);
  falsy('T21 second not ok', r2.ok);
  eq('T21 code', r2.code, WEB2API_COPY_CODES.CONVERSATION_REUSED);
  eq('T21 conv id surfaced', r2.conversationId, 'conv-same');
  eq('T21 one fetch per call, no blind resubmit', fetchCalls.count, 2);
  eq('T21 second call never reached clipboard', clip.cleared, 1);
}

// T22: stale previous response is not accepted on the next transaction.
{
  const t = createChatGptPlusWeb2ApiCopyTransport({
    fetchImpl: async () => okFetch({ conversation_id: 'conv-stale-2' }),
    listTargetsImpl: () => fakeTargets(),
    cdpSessionFactory: fakeSessionFactorySeq({ queue: [['A'], ['A', 'B']] }),
    clipboard: fakeClipboard([goodJson]),
    sleepImpl: noSleep,
  });
  const r = await t({ prompt: PROMPT2 });
  falsy('T22 stale not ok', r.ok);
  eq('T22 code', r.code, WEB2API_COPY_CODES.COPY_STALE);
}

// T23a: pre-submit fresh-creation failure => fail-closed BEFORE submit (fetch count 0).
{
  const fetchCalls = { count: 0 };
  const t = createChatGptPlusWeb2ApiCopyTransport({
    fetchImpl: async () => { fetchCalls.count += 1; return okFetch(); },
    listTargetsImpl: () => { throw new Error('CDP_UNREACHABLE'); },
    cdpSessionFactory: fakeSessionFactory({ snapshots: [['A']], keyLog: [] }),
    clipboard: fakeClipboard([goodJson]),
    sleepImpl: noSleep,
  });
  const r = await t({ prompt: PROMPT });
  falsy('T23a not ok', r.ok);
  eq('T23a code', r.code, WEB2API_COPY_CODES.UNAVAILABLE);
  eq('T23a no submit on fresh-creation failure', fetchCalls.count, 0);
}

// T23b: every submit carries the system-first fresh-chat part (upstream fresh branch trigger).
{
  const bodies = [];
  const { t } = makeTransport({
    fetchRes: okFetch(), snapshots: [['A'], ['A', 'B']], reads: [goodJson], bodies,
  });
  const r = await t({ prompt: PROMPT });
  eq('T23b ok', r.ok, true);
  tru('T23b body captured', bodies.length === 1 && Array.isArray(bodies[0].messages));
  eq('T23b first part is system fresh trigger', bodies[0].messages[0] && bodies[0].messages[0].role, 'system');
  eq('T23b system content exact', bodies[0].messages[0] && bodies[0].messages[0].content, WEB2API_FRESH_SYSTEM_PART);
  eq('T23b second part is user prompt', bodies[0].messages[1] && bodies[0].messages[1].role, 'user');
}

// T24: anomalous conversation (TURN_NOT_OBSERVED with a conv id) is never reused.
{
  const fetchSeq = [okFetch({ conversation_id: 'conv-anom' }), okFetch({ conversation_id: 'conv-anom' })];
  let fetchIdx = 0;
  const t = createChatGptPlusWeb2ApiCopyTransport({
    fetchImpl: async () => fetchSeq[Math.min(fetchIdx++, fetchSeq.length - 1)],
    listTargetsImpl: () => fakeTargets(),
    cdpSessionFactory: fakeSessionFactorySeq({ queue: [['A'], ['A'], ['A'], ['A', 'B']] }),
    clipboard: fakeClipboard([goodJson, goodJson]),
    sleepImpl: noSleep,
  });
  const r1 = await t({ prompt: PROMPT });
  falsy('T24 first not ok', r1.ok);
  eq('T24 first code', r1.code, WEB2API_COPY_CODES.TURN_NOT_OBSERVED);
  eq('T24 first conv surfaced', r1.conversationId, 'conv-anom');
  const r2 = await t({ prompt: PROMPT });
  falsy('T24 second not ok', r2.ok);
  eq('T24 second code (anomalous never reused)', r2.code, WEB2API_COPY_CODES.CONVERSATION_REUSED);
}

// T25: Input.insertText timeout (CDP dispatch throw) => CDP_LOST + anomalous; reuse rejected.
{
  const t = createChatGptPlusWeb2ApiCopyTransport({
    fetchImpl: (() => {
      const seq = [okFetch({ conversation_id: 'conv-cdp' }), okFetch({ conversation_id: 'conv-cdp' })];
      let i = 0;
      return async () => seq[Math.min(i++, seq.length - 1)];
    })(),
    listTargetsImpl: () => fakeTargets(),
    cdpSessionFactory: (() => {
      let sessions = 0;
      return async () => {
        sessions += 1;
        if (sessions <= 2) {
          const ids = sessions === 1 ? ['A'] : ['A', 'B'];
          return {
            async send(method) {
              if (method === 'Runtime.evaluate') return { result: { result: { value: JSON.stringify(ids) } } };
              throw new Error('Input.insertText timeout');
            },
            close() {},
          };
        }
        return {
          async send(method) {
            if (method === 'Runtime.evaluate') {
              const ids = sessions === 3 ? ['A', 'B'] : ['A', 'B', 'C'];
              return { result: { result: { value: JSON.stringify(ids) } } };
            }
            return { result: {} };
          },
          close() {},
        };
      };
    })(),
    clipboard: fakeClipboard([goodJson, goodJson]),
    sleepImpl: noSleep,
  });
  const r1 = await t({ prompt: PROMPT });
  falsy('T25 first not ok', r1.ok);
  eq('T25 first code', r1.code, WEB2API_COPY_CODES.CDP_LOST);
  const r2 = await t({ prompt: PROMPT });
  falsy('T25 second not ok', r2.ok);
  eq('T25 second code (anomalous never reused)', r2.code, WEB2API_COPY_CODES.CONVERSATION_REUSED);
}

// ---- L1-L5: default process-wide lock + timeout-queue recovery ----
// L1: two provider instances WITHOUT injected lock share the default mutex.
{
  let active = 0;
  let maxActive = 0;
  const perHolderFactory = () => {
    let calls = 0;
    return async () => {
      calls += 1;
      const ids = calls === 1 ? ['A'] : ['A', 'B'];
      const inLock = calls === 2;
      return {
        async send(method) {
          if (inLock) {
            active += 1;
            maxActive = Math.max(maxActive, active);
          }
          await new Promise((r) => setImmediate(r));
          if (inLock) { active -= 1; }
          if (method === 'Runtime.evaluate') {
            return { result: { result: { value: JSON.stringify(ids) } } };
          }
          return { result: {} };
        },
        close() {},
      };
    };
  };
  const mkDefault = () => createChatGptPlusWeb2ApiCopyTransport({
    fetchImpl: async () => okFetch(),
    listTargetsImpl: () => fakeTargets(),
    cdpSessionFactory: perHolderFactory(),
    clipboard: fakeClipboard([goodJson]),
    sleepImpl: noSleep,
    lockTimeoutMs: 10000,
  });
  const [r1, r2] = await Promise.all([mkDefault()({ prompt: PROMPT }), mkDefault()({ prompt: PROMPT })]);
  eq('L1 default lock both ok', r1.ok && r2.ok, true);
  eq('L1 default lock no overlap (maxActive 1)', maxActive, 1);
}

// L2: holder -> waiter timeout -> holder release -> next waiter ACQUIRES.
{
  const lock = createCopyLock();
  const h = await lock(1000);
  eq('L2 holder acquired', h.ok, true);
  const w = await lock(20);
  falsy('L2 waiter timed out', w.ok);
  eq('L2 waiter code', w.code, WEB2API_COPY_CODES.LOCK_TIMEOUT);
  h.release();
  const n = await lock(1000);
  eq('L2 next acquires after release', n.ok, true);
  n.release();
}

// L3: timed-out waiter is skipped; later live waiter is granted (FIFO).
{
  const lock = createCopyLock();
  const h = await lock(1000);
  const w1p = lock(10);
  const w2p = lock(1000);
  const w1 = await w1p;
  falsy('L3 first waiter timed out', w1.ok);
  eq('L3 first waiter code', w1.code, WEB2API_COPY_CODES.LOCK_TIMEOUT);
  h.release();
  const w2 = await w2p;
  eq('L3 live waiter granted after skip', w2.ok, true);
  w2.release();
}

// L4/L5: repeated timeout/release cycles recover; double release is safe.
{
  const lock = createCopyLock();
  for (let i = 0; i < 3; i++) {
    const h = await lock(1000);
    eq(`L4 cycle ${i} holder ok`, h.ok, true);
    const w = await lock(10);
    falsy(`L4 cycle ${i} waiter timed out`, w.ok);
    h.release();
    const n = await lock(1000);
    eq(`L4 cycle ${i} recovers`, n.ok, true);
    n.release();
    n.release();
  }
  const after = await lock(50);
  eq('L5 acquire after double release', after.ok, true);
  after.release();
}

// ---- summary ------------------------------------------------------------------
let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : ` — got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
}
console.log(`control-loop-gpt-web2api-copy: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exit(1);
assert.ok(true);
// end of control-loop-gpt-web2api-copy.test.mjs — no trailing marker.
