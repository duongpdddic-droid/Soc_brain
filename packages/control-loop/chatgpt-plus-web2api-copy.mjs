#!/usr/bin/env node
// chatgpt-plus-web2api-copy.mjs — ChatGPT Plus final-review transport over a
// LOCAL Web2API instance with clipboard extraction (Issue: Web2API PoC).
//
// Path: prompt -> Web2API submit (127.0.0.1:8081) -> ChatGPT Plus Web tab ->
// Ctrl+Shift+; (Copy last code block) via CDP Input.dispatchKeyEvent ->
// Windows clipboard -> raw text. Proven by PoC evidence: 10/10 copy runs +
// 8.9KB exact copy + 5/5 strict real Final Review validations (one run with
// POST 504 whose clipboard extraction still PASSED).
//
// Contract preserved verbatim (same as chatgpt-web-cwa.mjs):
//   transport({ prompt }) ->
//     { ok:true, text, conversationId, modelSlug, canonicalRequestId }
//     | { ok:false, code, ... }
// Authority stays in Soc_brain: strict JSON parse (parseGptFinalReview),
// requestDigest, binding (repository/issue/headSha) and PASS/REWORK/BLOCKED
// validation all live in gpt-final-review.mjs. This module adds NO authority:
// the digest/binding presence checks below are a TRANSPORT-level anti-stale
// heuristic (the copied text must contain the digest + binding triple this
// provider asked the model to echo); the canonical gate remains
// assertFinalBinding.
//
// Design constraints (from the integration contract):
// - No Copy-response button. No /backend-api/conversation/{id} projection as
//   a hard dependency.
// - An HTTP terminal status is NOT the sole authority: a failed/uncertain
//   submit followed by an observed NEW turn + validated clipboard is a
//   successful review. No blind resubmit on uncertain submit (duplicate risk).
// - Clipboard extraction is serialized: one clipboard review transaction at
//   a time, bounded lock timeout.
// - Stale clipboard / wrong digest+triple => reject, never resubmit blindly.
// - Feature-flagged OFF by default: SOC_FINAL_REVIEW_PROVIDER must equal
//   'chatgpt-plus-web2api-copy' (see selectGptTransport wiring).
//
// Limitations (explicit):
// - Windows-only clipboard path (powershell Get/Set-Clipboard). Other OSes
//   return WEB2API_COPY_CLIPBOARD_UNSUPPORTED.
// - The user clipboard is NOT restored (snapshot/restore would widen scope
//   and race the serialized transaction). Documented, not silent.
// - The in-process mutex serializes callers inside ONE node process. Two OS
//   processes running final review concurrently can still race the single
//   Windows clipboard; the digest/binding presence check fail-closes (reject)
//   rather than misattributing.
// - Turn correlation uses assistant data-message-id set-difference. If the
//   page virtualizes the new turn out of the DOM between snapshot and check,
//   the run fails TURN_NOT_OBSERVED (fail closed, no blind "last" fallback).

import { spawnSync } from 'node:child_process';

export const WEB2API_COPY_SCHEMA_VERSION = '1';
export const WEB2API_COPY_DEFAULT_HOST = '127.0.0.1';
export const WEB2API_COPY_DEFAULT_PORT = 8081;
export const WEB2API_COPY_DEFAULT_CDP_PORT = 9224;
export const WEB2API_COPY_DEFAULT_MODEL = 'auto';
export const WEB2API_COPY_FLAG_VALUE = 'chatgpt-plus-web2api-copy';

// Failure states (contract §7 + hardening telemetry) + operational codes.
export const WEB2API_COPY_CODES = Object.freeze({
  SUBMIT_UNCERTAIN: 'SUBMIT_UNCERTAIN',
  TURN_NOT_OBSERVED: 'TURN_NOT_OBSERVED',
  CONVERSATION_REUSED: 'CONVERSATION_REUSED',
  COPY_EMPTY: 'COPY_EMPTY',
  COPY_TIMEOUT: 'COPY_TIMEOUT',
  COPY_STALE: 'COPY_STALE',
  PARSE_FAILED: 'PARSE_FAILED', // reserved: provider never parses; kept for table parity
  BINDING_MISMATCH: 'BINDING_MISMATCH',
  UNAVAILABLE: 'WEB2API_COPY_UNAVAILABLE',
  CDP_LOST: 'WEB2API_CDP_LOST',
  LOCK_TIMEOUT: 'COPY_LOCK_TIMEOUT',
  CLIPBOARD_UNSUPPORTED: 'WEB2API_COPY_CLIPBOARD_UNSUPPORTED',
});

// Fresh-conversation lever (read-only upstream analysis, api_server.py):
// the server CONTINUES when (no explicit conversation_id) AND (_current ==
// _last AND same project AND no system parts) and only otherwise calls
// navigate_new_chat. The client cannot reset server-side _current_conv_id,
// and a CDP-side navigation is overridden by ensure_current_conversation.
// The ONLY documented client surface that forces the fresh branch is a
// `system` message part. Every transaction therefore sends one constant
// system part (content-neutral w.r.t. the review schema; the strict parser
// remains authoritative over the reply shape).
export const WEB2API_FRESH_SYSTEM_PART =
  'Fresh review session. Treat this conversation as a new review; do not rely on earlier turns.';

// Future-reuse guardrail: transactions per conversation when reuse mode is
// ever enabled. Default 1 (every transaction is fresh by construction);
// conversations that ever saw an anomaly are never reused regardless.
export const WEB2API_DEFAULT_MAX_TURNS_PER_CONVERSATION = 1;

// Telemetry event for arbitrary post-baseline clipboard changes.
export const CLIPBOARD_INTERFERENCE = 'CLIPBOARD_INTERFERENCE';

// ---- Transaction-scoped clipboard collector --------------------------------
// Windows mechanism: GetClipboardSequenceNumber() event-style polling (no
// window/message-loop needed, unlike AddClipboardFormatListener; no Win+V
// history dependency — sequence numbers come from the clipboard owner chain
// itself). Each sequence change after start() captures { seq, t, text } into
// a short in-memory ring buffer (default max 20). Empty reads are ignored
// (not items). stop() drops the buffer; polling is inline so there is no OS
// subscription to leak — cleanup = stop() in a finally on EVERY path.
export const COLLECTOR_MAX_ITEMS = 20;

export function createClipboardCollector({ clip, seqFn = null, nowImpl = Date.now, maxItems = COLLECTOR_MAX_ITEMS } = {}) {
  let localSeq = 0;
  const nextSeq = typeof seqFn === 'function'
    ? seqFn
    : (() => (typeof clip.seq === 'function' ? clip.seq() : ++localSeq));
  const cap = Number.isFinite(maxItems) && maxItems > 0 ? Math.floor(maxItems) : COLLECTOR_MAX_ITEMS;
  const collector = {
    baseline: null,
    lastSeen: null,
    items: [],
    events: [],
    stopped: false,
    start() {
      this.baseline = nextSeq();
      this.lastSeen = this.baseline;
      return this.baseline;
    },
    pollOnce() {
      if (this.stopped) return null;
      const s = nextSeq();
      if (s === this.lastSeen) return null;
      this.lastSeen = s;
      const cur = clip.read();
      if (!cur.ok) return { error: cur.code || 'WEB2API_COPY_READ_FAILED' };
      const text = String(cur.text || '');
      if (!text.length) return null;
      const item = { seq: s, t: nowImpl(), text };
      this.items.push(item);
      while (this.items.length > cap) this.items.shift();
      return { item };
    },
    noteInterference(item) {
      this.events.push({ type: CLIPBOARD_INTERFERENCE, seq: item.seq, t: item.t });
    },
    stop() {
      this.stopped = true;
      this.items.length = 0;
      return true;
    },
  };
  return collector;
}

// Strict per-item validation against the transaction reference: parses AND
// digest-exact AND binding-triple present. Returns 'valid' | 'stale-digest' |
// 'binding-bad' | 'not-json'. Transport-level only; canonical authority stays
// in Soc_brain (parseGptFinalReview / assertFinalBinding).
export function classifyCapturedItem(text, ref) {
  let obj;
  try { obj = JSON.parse(text); }
  catch { return 'not-json'; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'not-json';
  const digest = obj.metadata && typeof obj.metadata.requestDigest === 'string'
    ? obj.metadata.requestDigest.toLowerCase()
    : null;
  if (digest !== null && ref.requestDigest && digest !== ref.requestDigest) return 'stale-digest';
  if (digest !== null && !ref.requestDigest) return 'not-json';
  if (digest === null) return 'not-json';
  const b = obj.binding || {};
  const repoOk = ref.repository
    ? (typeof b.repository === 'string' && b.repository.toLowerCase() === String(ref.repository).toLowerCase())
    : true;
  const issueOk = (ref.issue !== null && ref.issue !== undefined) ? (b.issue === ref.issue) : true;
  const headOk = ref.headSha
    ? (typeof b.headSha === 'string' && b.headSha.toLowerCase() === ref.headSha)
    : true;
  if (!repoOk || !issueOk || !headOk) return 'binding-bad';
  return 'valid';
}

// Prompt wrapper (§6): exactly ONE fenced JSON code block, no prose, strict
// schema, exact requestDigest/binding echo. Appended to the canonical prompt
// built by buildFinalReviewPrompt — that builder is NOT modified.
export function wrapPromptForCopyExtraction(prompt) {
  return `${prompt}\n\nEXTRACTION CONTRACT (mandatory, overrides any other formatting instruction): return EXACTLY ONE fenced json code block containing the strict Final Review JSON object and NOTHING else — no prose before or after the fences. Echo the requestDigest and the binding (repository/issue/headSha) EXACTLY as given above.`;
}

// Extract the anti-stale reference this provider asked the model to echo.
// Returns { requestDigest, repository, issue, headSha } with nulls when absent.
// Transport-level heuristic only; canonical authority stays in Soc_brain.
export function extractEchoReference(wrappedPrompt) {
  const text = String(wrappedPrompt || '');
  const digest = /"requestDigest"\s*:\s*"([0-9a-f]{64})"/i.exec(text);
  const repo = /"repository"\s*:\s*"([^"]+)"/.exec(text);
  const issue = /"issue"\s*:\s*(\d+)/.exec(text);
  const head = /"headSha"\s*:\s*"([0-9a-f]{40})"/i.exec(text);
  return {
    requestDigest: digest ? digest[1].toLowerCase() : null,
    repository: repo ? repo[1] : null,
    issue: issue ? Number(issue[1]) : null,
    headSha: head ? head[1].toLowerCase() : null,
  };
}

export function checkCopiedBinding(copiedText, ref) {
  const text = String(copiedText || '');
  if (ref.requestDigest && !text.includes(ref.requestDigest)) {
    return { ok: false, code: WEB2API_COPY_CODES.COPY_STALE, detail: 'copied text lacks expected requestDigest' };
  }
  const missing = [];
  if (ref.repository && !text.toLowerCase().includes(String(ref.repository).toLowerCase())) missing.push('repository');
  if (ref.issue !== null && !new RegExp(`"issue"\\s*:\\s*${ref.issue}\\b`).test(text)) missing.push('issue');
  if (ref.headSha && !text.toLowerCase().includes(ref.headSha)) missing.push('headSha');
  if (missing.length) {
    return { ok: false, code: WEB2API_COPY_CODES.BINDING_MISMATCH, detail: `copied text binding mismatch: ${missing.join(',')}` };
  }
  return { ok: true };
}

// In-process clipboard-transaction mutex with bounded timeout. FIFO queue;
// a timed-out waiter is marked abandoned and skipped so it never blocks the
// queue. Acquisition timers are cleared on grant; release is idempotent.
export function createCopyLock() {
  let locked = false;
  const queue = [];
  function drain() {
    if (locked) return;
    while (queue.length) {
      const node = queue.shift();
      if (node.done) continue;
      node.done = true;
      if (node.timer) clearTimeout(node.timer);
      locked = true;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        locked = false;
        drain();
      };
      node.resolve({ ok: true, release });
      return;
    }
  }
  return async function acquire(timeoutMs) {
    const budget = Number(timeoutMs);
    const waitBudget = Number.isFinite(budget) && budget > 0 ? budget : 60000;
    if (!locked) {
      queue.length = 0; // only abandoned waiters can remain; drop them
      locked = true;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        locked = false;
        drain();
      };
      return { ok: true, release };
    }
    return await new Promise((resolve) => {
      const node = { resolve, done: false, timer: null };
      node.timer = setTimeout(() => {
        if (node.done) return;
        node.done = true;
        resolve({ ok: false, code: WEB2API_COPY_CODES.LOCK_TIMEOUT });
      }, waitBudget);
      queue.push(node);
    });
  };
}

// Process-wide default mutex: provider instances without an explicit lock
// share this so concurrent transports serialize the single OS clipboard.
const defaultCopyLock = createCopyLock();

function defaultRunner({ command, args, timeoutMs }) {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const PS_CLEAR = ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Value ([string]::Empty)'];
const PS_GET = ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'];
// Event-style clipboard generation counter: user32 GetClipboardSequenceNumber
// increments on every clipboard ownership change. P/Invoked per call inside a
// fresh powershell (no persistent listener/window, no Win+V dependency).
const PS_SEQ = ['-NoProfile', '-NonInteractive', '-Command',
  'Add-Type -Namespace W2A -Name Clip -MemberDefinition \'[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();\' | Out-Null; [W2A.Clip]::GetClipboardSequenceNumber()'];

function defaultClipboard({ runner = defaultRunner } = {}) {
  return {
    clear() {
      if (process.platform !== 'win32') return { ok: false, code: WEB2API_COPY_CODES.CLIPBOARD_UNSUPPORTED };
      runner({ command: 'powershell.exe', args: PS_CLEAR, timeoutMs: 15000 });
      const cur = this.read();
      if (!cur.ok) return cur;
      return cur.text.length === 0 ? { ok: true } : { ok: false, code: 'WEB2API_COPY_CLEAR_FAILED' };
    },
    read() {
      if (process.platform !== 'win32') return { ok: false, code: WEB2API_COPY_CODES.CLIPBOARD_UNSUPPORTED };
      const r = runner({ command: 'powershell.exe', args: PS_GET, timeoutMs: 15000 });
      // Get-Clipboard with empty clipboard prints nothing (exit 0, empty stdout).
      return { ok: true, text: String(r.stdout || '').replace(/\r\n/g, '\n') };
    },
    seq() {
      if (process.platform !== 'win32') throw new Error(WEB2API_COPY_CODES.CLIPBOARD_UNSUPPORTED);
      const r = runner({ command: 'powershell.exe', args: PS_SEQ, timeoutMs: 15000 });
      const n = Number(String(r.stdout || '').trim());
      if (!Number.isFinite(n)) throw new Error('WEB2API_COPY_SEQ_FAILED');
      return n;
    },
  };
}

function cdpListTargets({ cdpPort, runner = defaultRunner }) {
  const r = runner({ command: 'curl.exe', args: ['-s', '--max-time', '10', `http://127.0.0.1:${cdpPort}/json/list`], timeoutMs: 15000 });
  if (r.status !== 0) throw new Error(`curl /json/list exit ${r.status}`);
  return JSON.parse(r.stdout || '[]');
}

// Minimal CDP session over the global WebSocket (Node >=22): id-matched
// Runtime.evaluate + Input.dispatchKeyEvent on ONE tab socket.
function createCdpSession(wsUrl, { WebSocketImpl = globalThis.WebSocket, openTimeoutMs = 15000 } = {}) {
  let ws = null;
  let seq = 0;
  const pending = new Map();
  async function ensure() {
    if (ws) return ws;
    ws = new WebSocketImpl(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP_WS_OPEN_TIMEOUT')), openTimeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP_WS_ERROR')); }, { once: true });
    });
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m && m.id !== undefined && pending.has(m.id)) {
        const { resolve } = pending.get(m.id);
        pending.delete(m.id);
        resolve(m);
      }
    });
    return ws;
  }
  async function send(method, params, timeoutMs = 30000) {
    const sock = await ensure();
    const id = ++seq;
    const p = new Promise((resolve, reject) => {
      pending.set(id, { resolve });
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error('CDP_SEND_TIMEOUT')); }
      }, timeoutMs);
    });
    sock.send(JSON.stringify({ id, method, params }));
    return p;
  }
  function close() { try { ws && ws.close(); } catch { /* closed */ } ws = null; }
  return { send, close };
}

export const TURN_IDS_EXPRESSION = `JSON.stringify(Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')).map(function(e){return e.getAttribute('data-message-id')}))`;

export function diffTurnIds(before, after) {
  const prev = new Set(Array.isArray(before) ? before.filter(Boolean) : []);
  return (Array.isArray(after) ? after.filter(Boolean) : []).filter((id) => !prev.has(id));
}

async function cdpEvaluate(session, expression, timeoutMs = 30000) {
  const m = await session.send('Runtime.evaluate', { expression, returnByValue: true }, timeoutMs);
  if (m.error) throw new Error('CDP_ERROR: ' + JSON.stringify(m.error).slice(0, 300));
  const res = m.result || {};
  if (res.exceptionDetails) throw new Error('PAGE_EXCEPTION: ' + JSON.stringify(res.exceptionDetails).slice(0, 300));
  return res.result ? res.result.value : undefined;
}

// Ctrl+Shift+; — ChatGPT Web "Copy last code block". Modifiers bitmask:
// Ctrl=2, Shift=8 -> 10. ';' = VK_OEM_1 = 186. No coordinates, no OS focus.
async function dispatchCopyLastCodeBlock(session, timeoutMs = 30000) {
  const base = { modifiers: 10, windowsVirtualKeyCode: 186, code: 'Semicolon', key: ';' };
  const down = await session.send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' }, timeoutMs);
  if (down.error) throw new Error('CDP_KEY_ERROR: ' + JSON.stringify(down.error).slice(0, 200));
  const up = await session.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, timeoutMs);
  if (up.error) throw new Error('CDP_KEY_ERROR: ' + JSON.stringify(up.error).slice(0, 200));
  return true;
}

export function createChatGptPlusWeb2ApiCopyTransport({
  web2apiHost = process.env.SOC_W2A_HOST || WEB2API_COPY_DEFAULT_HOST,
  web2apiPort = Number(process.env.SOC_W2A_PORT) || WEB2API_COPY_DEFAULT_PORT,
  cdpPort = Number(process.env.SOC_W2A_CDP_PORT) || WEB2API_COPY_DEFAULT_CDP_PORT,
  model = process.env.SOC_W2A_MODEL || WEB2API_COPY_DEFAULT_MODEL,
  submitTimeoutMs = 180000,
  copyPollMs = 2000,
  copyTimeoutMs = 20000,
  maxCopyAttempts = 3,
  lockTimeoutMs = 60000,
  fetchImpl = globalThis.fetch,
  runner = defaultRunner,
  clipboard = null,
  cdpSessionFactory = null,
  listTargetsImpl = null,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
  nowImpl = Date.now,
  collectorFactory = null,
  maxTurnsPerConversation = WEB2API_DEFAULT_MAX_TURNS_PER_CONVERSATION,
  lock = null,
} = {}) {
  const copyLock = lock || defaultCopyLock;
  const clip = clipboard || defaultClipboard({ runner });
  const openSession = cdpSessionFactory || (async (wsUrl) => createCdpSession(wsUrl));
  const listTargets = listTargetsImpl || ((opts) => cdpListTargets(opts));
  // Conversation lifecycle memory (instance-scoped): every observed
  // conversation id with an anomaly flag. A response naming an already-seen
  // id is rejected (CONVERSATION_REUSED) — browser history is NOT Soc_brain
  // state, and an anomalous conversation is never reused.
  const seenConversations = new Map();
  function noteConversation(convId, anomalous) {
    if (typeof convId !== 'string' || !convId) return;
    const prev = seenConversations.get(convId);
    seenConversations.set(convId, { anomalous: Boolean(anomalous) || Boolean(prev && prev.anomalous) });
  }

  async function snapshotTurnIds() {
    const targets = listTargets({ cdpPort, runner });
    const page = Array.isArray(targets)
      ? targets.find((x) => x && x.type === 'page' && /chatgpt\.com/.test(x.url || ''))
      : null;
    if (!page || !page.webSocketDebuggerUrl) throw new Error('WEB2API_COPY_NO_PAGE_TARGET');
    const session = await openSession(page.webSocketDebuggerUrl);
    try {
      const raw = await cdpEvaluate(session, TURN_IDS_EXPRESSION);
      let ids = raw;
      if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch { ids = []; } }
      return { session, ids: Array.isArray(ids) ? ids.filter(Boolean) : [] };
    } catch (e) {
      try { session.close(); } catch { /* closed */ }
      throw e;
    }
  }

  return async function transport({ prompt }) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return { ok: false, code: 'WEB2API_COPY_PROMPT_INVALID' };
    }
    // Pre-submit availability: fail BEFORE submit so the caller policy may
    // fall back to CWA. Post-submit uncertainty NEVER falls back blindly
    // (duplicate-send risk) — it reconciles or fails with a typed code.
    let pre;
    try {
      pre = await snapshotTurnIds();
      pre.session.close();
    } catch (e) {
      return { ok: false, code: WEB2API_COPY_CODES.UNAVAILABLE, error: String((e && e.message) || e) };
    }

    const wrapped = wrapPromptForCopyExtraction(prompt);
    const ref = extractEchoReference(wrapped);
    let submitUncertain = false;
    let conversationId = null;
    let modelSlug = null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), submitTimeoutMs);
      let resp;
      try {
        resp = await fetchImpl(`http://${web2apiHost}:${web2apiPort}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // System part FIRST: the only documented client surface that forces
          // the server's fresh-chat branch (see WEB2API_FRESH_SYSTEM_PART).
          // Content-neutral w.r.t. the review schema; the strict parser stays
          // authoritative over the reply shape.
          body: JSON.stringify({ model, messages: [{ role: 'system', content: WEB2API_FRESH_SYSTEM_PART }, { role: 'user', content: wrapped }] }),
          signal: ctrl.signal,
        });
      } finally { clearTimeout(timer); }
      if (!resp || resp.status !== 200) {
        submitUncertain = true;
      } else {
        try {
          const data = await resp.json();
          conversationId = (data && data.conversation_id) || (data && data.conversationId) || null;
          modelSlug = (data && data.model) || null;
        } catch { submitUncertain = true; }
      }
    } catch (e) {
      submitUncertain = true;
    }

    // Fresh-conversation gate: the answered conversation must be one this
    // instance has never seen. A repeated id means the server continued an
    // old (possibly anomalous, possibly DOM-heavy) conversation instead of
    // starting fresh — reject WITHOUT copying and WITHOUT resubmitting.
    // (maxTurnsPerConversation documents the future-reuse budget; default 1
    // keeps every transaction fresh by construction, so no counting is needed
    // on this path — the parameter is reserved for an explicit reuse mode.)
    void maxTurnsPerConversation;
    if (conversationId && seenConversations.has(conversationId)) {
      noteConversation(conversationId, true);
      return { ok: false, code: WEB2API_COPY_CODES.CONVERSATION_REUSED, detail: 'server answered on an already-seen conversation; refusing reuse', submitUncertain, conversationId };
    }

    // Serialize the clipboard transaction (bounded). The collector runs
    // INSIDE the lock; it never replaces it — both layers coexist.
    const gated = await copyLock(lockTimeoutMs);
    if (!gated.ok) {
      return { ok: false, code: gated.code, submitUncertain, conversationId };
    }
    let session = null;
    let collector = null;
    try {
      // Turn correlation: ONLY a set-difference NEW turn is acceptable.
      let post;
      try {
        post = await snapshotTurnIds();
        session = post.session;
      } catch (e) {
        noteConversation(conversationId, true);
        return { ok: false, code: WEB2API_COPY_CODES.CDP_LOST, submitUncertain, error: String((e && e.message) || e) };
      }
      const fresh = diffTurnIds(pre.ids, post.ids);
      if (!fresh.length) {
        noteConversation(conversationId, true);
        return { ok: false, code: WEB2API_COPY_CODES.TURN_NOT_OBSERVED, submitUncertain, conversationId };
      }
      const turnId = fresh[0];

      const cleared = clip.clear();
      if (!cleared.ok) {
        noteConversation(conversationId, true);
        return { ok: false, code: cleared.code, submitUncertain, conversationId, turnId };
      }
      const newCollector = collectorFactory
        ? collectorFactory({ clip, nowImpl })
        : createClipboardCollector({ clip, nowImpl });
      collector = newCollector;
      collector.start(); // baseline AFTER clear: pre-transaction items excluded
      let accepted = null;
      let attempts = 0;
      let sawStaleDigest = false;
      let collectedCount = 0;
      const startedAt = nowImpl();
      while (attempts < maxCopyAttempts && !accepted) {
        attempts += 1;
        await dispatchCopyLastCodeBlock(session);
        const deadline = nowImpl() + copyTimeoutMs;
        for (;;) {
          const polled = collector.pollOnce();
          if (polled && polled.error) {
            noteConversation(conversationId, true);
            return { ok: false, code: polled.error, submitUncertain, conversationId, turnId, attempts, interference: collector.events.length };
          }
          if (polled && polled.item) {
            collectedCount += 1;
            const kind = classifyCapturedItem(polled.item.text, ref);
            if (kind === 'valid') { accepted = polled.item; break; }
            if (kind === 'binding-bad') {
              noteConversation(conversationId, true);
              return { ok: false, code: WEB2API_COPY_CODES.BINDING_MISMATCH, detail: 'copied payload digest ok but binding triple mismatched', submitUncertain, conversationId, turnId, attempts, interference: collector.events.length };
            }
            if (kind === 'stale-digest') sawStaleDigest = true;
            collector.noteInterference(polled.item);
          }
          if (accepted || nowImpl() >= deadline) break;
          await sleepImpl(copyPollMs);
        }
      }
      const interference = collector.events.length;
      if (!accepted) {
        // Fail-closed, most-specific first. Arbitrary changes observed but no
        // valid payload => COPY_TIMEOUT (telemetry CLIPBOARD_INTERFERENCE kept
        // in events, surfaced as count). Stale-digest evidence without a valid
        // payload => COPY_STALE. Zero post-baseline changes => COPY_EMPTY.
        // Every non-validated outcome marks the conversation anomalous: it
        // must never be reused (rotate triggers).
        noteConversation(conversationId, true);
        if (sawStaleDigest) {
          return { ok: false, code: WEB2API_COPY_CODES.COPY_STALE, detail: 'stale requestDigest captured, no valid payload', submitUncertain, conversationId, turnId, attempts, interference };
        }
        if (collectedCount > 0) {
          return { ok: false, code: WEB2API_COPY_CODES.COPY_TIMEOUT, detail: 'clipboard changed but no valid payload captured', submitUncertain, conversationId, turnId, attempts, interference };
        }
        return { ok: false, code: WEB2API_COPY_CODES.COPY_EMPTY, submitUncertain, conversationId, turnId, attempts, interference };
      }
      // Success marks anomalous when the submit was uncertain (rotate trigger:
      // an uncertain-submit conversation is never reused even though the
      // current transaction validated).
      noteConversation(conversationId, submitUncertain);
      return {
        ok: true,
        text: accepted.text,
        conversationId,
        modelSlug,
        canonicalRequestId: ref.requestDigest,
        transportMeta: {
          provider: WEB2API_COPY_FLAG_VALUE,
          schemaVersion: WEB2API_COPY_SCHEMA_VERSION,
          turnId,
          shortcutAttempts: attempts,
          submitUncertain,
          copyLatencyMs: nowImpl() - startedAt,
          interference,
          collectorSeq: accepted.seq,
        },
      };
    } catch (e) {
      // Unexpected mid-transaction failure (e.g. CDP dispatch throw):
      // fail-closed with a typed code, never a throw, never a resubmit.
      // The conversation (if any was created) is marked anomalous.
      noteConversation(conversationId, true);
      return { ok: false, code: WEB2API_COPY_CODES.CDP_LOST, submitUncertain, conversationId, error: String((e && e.message) || e) };
    } finally {
      try { collector && collector.stop(); } catch { /* already stopped */ }
      try { session && session.close(); } catch { /* closed */ }
      gated.release();
    }
  };
}
// end of chatgpt-plus-web2api-copy.mjs — no trailing marker.
