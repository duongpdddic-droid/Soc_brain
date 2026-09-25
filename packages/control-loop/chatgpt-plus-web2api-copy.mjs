import { spawnSync } from 'node:child_process';
import { createCdpSupervisor } from './cdp-supervisor.mjs';

export const WEB2API_COPY_SCHEMA_VERSION = '1';
export const WEB2API_COPY_DEFAULT_HOST = '127.0.0.1';
export const WEB2API_COPY_DEFAULT_PORT = 8081;
export const WEB2API_COPY_DEFAULT_CDP_PORT = 9222;
export const WEB2API_COPY_DEFAULT_MODEL = 'auto';
export const WEB2API_COPY_FLAG_VALUE = 'chatgpt-plus-web2api-copy';
export const WEB2API_FRESH_SYSTEM_PART = 'Fresh review session. Treat this conversation as a new review; do not rely on earlier turns.';

export function wrapPromptForCopyExtraction(prompt) {
  return `${prompt}\n\nFORMAT CONTRACT: Respond with EXACTLY ONE fenced JSON code block. Put only the response requested by the caller inside that code block. Do not include text outside the fenced code block.`;
}
export const CLIPBOARD_INTERFERENCE = 'CLIPBOARD_INTERFERENCE';
export const COLLECTOR_MAX_ITEMS = 20;

export const WEB2API_COPY_CODES = Object.freeze({
  PROMPT_INVALID: 'WEB2API_COPY_PROMPT_INVALID',
  UNAVAILABLE: 'WEB2API_COPY_UNAVAILABLE',
  SUBMIT_UNCERTAIN: 'SUBMIT_UNCERTAIN',
  TURN_NOT_OBSERVED: 'TURN_NOT_OBSERVED',
  CONVERSATION_REUSED: 'CONVERSATION_REUSED',
  CONVERSATION_MISMATCH: 'CONVERSATION_MISMATCH',
  COPY_EMPTY: 'COPY_EMPTY',
  COPY_TIMEOUT: 'COPY_TIMEOUT',
  COPY_STALE: 'COPY_STALE',
  COPY_BAD: 'COPY_BAD',
  BINDING_MISMATCH: 'BINDING_MISMATCH',
  CDP_LOST: 'WEB2API_CDP_LOST',
  COPY_LOCK_TIMEOUT: 'COPY_LOCK_TIMEOUT',
  CLIPBOARD_UNSUPPORTED: 'WEB2API_COPY_CLIPBOARD_UNSUPPORTED',
});

function createClipboardCollector({ clip, seqFn = null, nowImpl = Date.now, maxItems = COLLECTOR_MAX_ITEMS } = {}) {
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
      const seq = nextSeq();
      if (seq === this.lastSeen) return null;
      this.lastSeen = seq;
      const read = clip.read();
      if (!read.ok) return { error: read.code || WEB2API_COPY_CODES.COPY_BAD };
      const text = String(read.text || '');
      if (!text.length) return null;
      const item = { seq, t: nowImpl(), text };
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

function createCopyLock() {
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
      queue.length = 0;
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
        resolve({ ok: false, code: WEB2API_COPY_CODES.COPY_LOCK_TIMEOUT });
      }, waitBudget);
      queue.push(node);
    });
  };
}

const defaultCopyLock = createCopyLock();

function defaultRunner({ command, args, timeoutMs }) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

const PS_GET = ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'];
const PS_SEQ = ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -Namespace W2A -Name Clip -MemberDefinition \'[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();\' | Out-Null; [W2A.Clip]::GetClipboardSequenceNumber()'];

function defaultClipboard({ runner = defaultRunner } = {}) {
  return {
    clear() {
      if (process.platform !== 'win32') return { ok: false, code: WEB2API_COPY_CODES.CLIPBOARD_UNSUPPORTED };
      const res = runner({ command: 'cmd.exe', args: ['/c', 'type NUL | clip'], timeoutMs: 5000 });
      if (res.status !== 0) return { ok: false, code: 'WEB2API_COPY_CLEAR_FAILED' };
      const read = this.read();
      if (!read.ok) return read;
      // Trim sạch ký tự CRLF dư từ stdout của PowerShell
      return String(read.text || '').trim().length === 0 ? { ok: true } : { ok: false, code: 'WEB2API_COPY_CLEAR_FAILED' };
    },
    read() {
      if (process.platform !== 'win32') return { ok: false, code: WEB2API_COPY_CODES.CLIPBOARD_UNSUPPORTED };
      const result = runner({ command: 'powershell.exe', args: PS_GET, timeoutMs: 15000 });
      return { ok: true, text: String(result.stdout || '').replace(/\r\n/g, '\n') };
    },
    seq() {
      if (process.platform !== 'win32') throw new Error(WEB2API_COPY_CODES.CLIPBOARD_UNSUPPORTED);
      const result = runner({ command: 'powershell.exe', args: PS_SEQ, timeoutMs: 15000 });
      const value = Number(String(result.stdout || '').trim());
      if (!Number.isFinite(value)) throw new Error('WEB2API_COPY_SEQ_FAILED');
      return value;
    },
  };
}

export function findChatGptPageTarget(targets) {
  if (!Array.isArray(targets)) return null;
  return targets.find((target) => target && target.type === 'page' && /chatgpt\.com/.test(target.url || '')) || null;
}

function conversationIdFromTargetUrl(url) {
  const match = /\/c\/([^/?#]+)/i.exec(String(url || ''));
  return match ? match[1] : null;
}

function targetConversationMatches(page, conversationId) {
  if (!conversationId) return true;
  const targetConversationId = conversationIdFromTargetUrl(page && page.url);
  return !targetConversationId || targetConversationId.toLowerCase() === String(conversationId).toLowerCase();
}

function cdpListTargets({ cdpPort, runner = defaultRunner }) {
  const result = runner({ command: 'curl.exe', args: ['-s', '--max-time', '10', `http://127.0.0.1:${cdpPort}/json/list`], timeoutMs: 15000 });
  if (result.status !== 0) throw new Error(`curl /json/list exit ${result.status}`);
  return JSON.parse(result.stdout || '[]');
}

function createCdpSession(wsUrl, { WebSocketImpl = globalThis.WebSocket, openTimeoutMs = 15000 } = {}) {
  if (!WebSocketImpl) throw new Error('WEB2API_CDP_WEBSOCKET_UNAVAILABLE');
  let socket = null;
  let sequence = 0;
  const pending = new Map();
  async function ensure() {
    if (socket) return socket;
    socket = new WebSocketImpl(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP_WS_OPEN_TIMEOUT')), openTimeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP_WS_ERROR')); }, { once: true });
    });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message && message.id !== undefined && pending.has(message.id)) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        request.resolve(message);
      }
    });
    return socket;
  }
  async function send(method, params, timeoutMs = 30000) {
    const current = await ensure();
    const id = ++sequence;
    const request = new Promise((resolve, reject) => {
      pending.set(id, { resolve });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('CDP_SEND_TIMEOUT'));
        }
      }, timeoutMs);
    });
    current.send(JSON.stringify({ id, method, params }));
    return request;
  }
  function close() {
    try { socket && socket.close(); } catch { /* already closed */ }
    socket = null;
  }
  return { send, close };
}

export const TURN_IDS_EXPRESSION = 'JSON.stringify(Array.from(document.querySelectorAll(\'[data-message-author-role="assistant"]\')).map(function(e){return e.getAttribute(\'data-message-id\')}))';

export function copyReadyExpressionForTurn(turnId) {
  const encodedTurnId = JSON.stringify(String(turnId || ''));
  return `JSON.stringify((function(){
    const expectedTurnId = ${encodedTurnId};
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const norm = (v) => String(v || '').trim().toLowerCase();
    const controls = Array.from(document.querySelectorAll('button,[role="button"]'));
    const streaming = controls.some((el) => {
      const label = norm(el.getAttribute('aria-label'));
      const title = norm(el.getAttribute('title'));
      const text = norm(el.textContent);
      return visible(el) && (
        label.includes('stop streaming') || title.includes('stop streaming') ||
        label.includes('stop generating') || title.includes('stop generating') ||
        text === 'stop generating' || text === 'stop streaming'
      );
    });

    const turns = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    const newest = turns.length ? turns[turns.length - 1] : null;
    const turn = turns.find((el) => el.getAttribute('data-message-id') === expectedTurnId) || null;
    const exactFreshTurnIsNewest = !!turn && turn === newest;

    const code = turn && turn.querySelector('pre code, pre, code');
    const copy = turn && Array.from(turn.querySelectorAll('button,[role="button"]')).find((el) => {
      const label = norm(el.getAttribute('aria-label'));
      const title = norm(el.getAttribute('title'));
      const text = norm(el.textContent);
      return visible(el) && !el.disabled && (
        label === 'copy' || label.includes('copy code') ||
        title === 'copy' || title.includes('copy code') || text === 'copy'
      );
    });

    return {
      ready: !streaming && exactFreshTurnIsNewest && !!code && !!copy,
      streaming,
      expectedTurnId,
      observedTurnId: turn && turn.getAttribute('data-message-id'),
      newestTurnId: newest && newest.getAttribute('data-message-id'),
      exactFreshTurnIsNewest,
      hasCode: !!code,
      hasCopy: !!copy
    };
  })())`;
}

async function waitForCopyReadiness(session, { turnId, sleepImpl, nowImpl, timeoutMs = 10000, pollMs = 250 } = {}) {
  const started = nowImpl();
  let last = { ready: false, streaming: null, hasCode: false, hasCopy: false, exactFreshTurnIsNewest: false };
  const expression = copyReadyExpressionForTurn(turnId);
  while (nowImpl() - started < timeoutMs) {
    const raw = await cdpEvaluate(session, expression, Math.min(30000, timeoutMs));
    try {
      last = typeof raw === 'string' ? JSON.parse(raw) : (raw || last);
    } catch {
      last = { ready: false, streaming: null, hasCode: false, hasCopy: false, exactFreshTurnIsNewest: false };
    }
    if (last.ready) return { ok: true, state: last };
    await sleepImpl(pollMs);
  }
  return { ok: false, state: last };
}

export function diffTurnIds(before, after) {
  const previous = new Set(Array.isArray(before) ? before.filter(Boolean) : []);
  return (Array.isArray(after) ? after.filter(Boolean) : []).filter((id) => !previous.has(id));
}

async function cdpEvaluate(session, expression, timeoutMs = 30000) {
  const message = await session.send('Runtime.evaluate', { expression, returnByValue: true }, timeoutMs);
  if (message.error) throw new Error('CDP_ERROR: ' + JSON.stringify(message.error).slice(0, 300));
  const result = message.result || {};
  if (result.exceptionDetails) throw new Error('PAGE_EXCEPTION: ' + JSON.stringify(result.exceptionDetails).slice(0, 300));
  return result.result ? result.result.value : undefined;
}

function parseCopiedPayload(text) {
  const raw = String(text || '').trim();
  const fence = /^[`]{3}\s*(?:json)?\s*([\s\S]*?)\s*[`]{3}\s*$/i.exec(raw);
  const jsonText = fence ? fence[1].trim() : raw;
  try { return JSON.parse(jsonText); } catch { return null; }
}

function responseShapeLooksCurrent(payload) {
  return Boolean(payload && typeof payload === 'object' && !Array.isArray(payload));
}

function classifyCapturedItem(text, ref = {}) {
  const payload = parseCopiedPayload(text);
  if (!payload) return 'not-json';
  if (ref.responseRef && !String(text).includes(String(ref.responseRef))) return 'stale-digest';
  const digest = payload.metadata && typeof payload.metadata === 'object' && typeof payload.metadata.requestDigest === 'string'
    ? payload.metadata.requestDigest.toLowerCase()
    : null;
  if (ref.requestDigest && (!digest || digest !== ref.requestDigest)) return 'stale-digest';
  if (!ref.requestDigest && digest) return 'not-json';
  const binding = payload.binding && typeof payload.binding === 'object' && !Array.isArray(payload.binding) ? payload.binding : null;
  if (ref.repository && (!binding || String(binding.repository).toLowerCase() !== String(ref.repository).toLowerCase())) return 'binding-bad';
  if (ref.issue !== null && ref.issue !== undefined && (!binding || binding.issue !== ref.issue)) return 'binding-bad';
  if (ref.pullRequest !== null && ref.pullRequest !== undefined && (!binding || binding.pullRequest !== ref.pullRequest)) return 'binding-bad';
  if (ref.headSha && (!binding || String(binding.headSha).toLowerCase() !== String(ref.headSha).toLowerCase())) return 'binding-bad';
  const s4BindingActive = ref.repository || ref.issue !== null && ref.issue !== undefined || ref.pullRequest !== null && ref.pullRequest !== undefined || ref.headSha || ref.requestDigest;
  if (s4BindingActive) {
    const verdict = payload.verdict;
    const validVerdicts = new Set(['PASS', 'REWORK', 'BLOCKED']);
    if (!validVerdicts.has(verdict)) return 'not-json';
  }
  if (responseShapeLooksCurrent(payload)) return 'valid';
  return 'stale-digest';
}

function normalizeResponseRef(responseRef) {
  return typeof responseRef === 'string' && responseRef ? { responseRef: responseRef } : {};
}

export function createChatGptPlusWeb2ApiCopyTransport({
  web2apiHost = process.env.SOC_W2A_HOST || WEB2API_COPY_DEFAULT_HOST,
  web2apiPort = Number(process.env.SOC_W2A_PORT) || WEB2API_COPY_DEFAULT_PORT,
  cdpPort = Number(process.env.SOC_W2A_CDP_PORT) || WEB2API_COPY_DEFAULT_CDP_PORT,
  model = process.env.SOC_W2A_MODEL || WEB2API_COPY_DEFAULT_MODEL,
  submitTimeoutMs = 180000,
  copyPollMs = 200,
  copyTimeoutMs = 20000,
  lockTimeoutMs = 60000,
  fetchImpl = globalThis.fetch,
  activationFetchImpl = globalThis.fetch,
  runner = defaultRunner,
  clipboard = null,
  cdpSessionFactory = null,
  listTargetsImpl = null,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  nowImpl = Date.now,
  lock = null,
  responseRef = null,
  bindingRepository = null,
  bindingIssue = null,
  bindingPullRequest = null,
  bindingHeadSha = null,
  bindingRequestDigest = null,
  userDataDir = null,
  headless = false,
} = {}) {
  const copyLock = lock || defaultCopyLock;
  const clip = clipboard || defaultClipboard({ runner });
  const openSession = cdpSessionFactory || ((wsUrl) => createCdpSession(wsUrl));
  const listTargets = listTargetsImpl || ((options) => cdpListTargets(options));
  const supervisor = createCdpSupervisor({
    port: cdpPort,
    userDataDir,
    headless,
    fetchImpl,
    log: () => {},
  });
  const isPresent = (v) => v !== null && v !== undefined && !(typeof v === 'string' && !v.trim());
  const allPresent = [bindingRepository, bindingIssue, bindingPullRequest, bindingHeadSha, bindingRequestDigest].every(isPresent);
  const anyPresent = [bindingRepository, bindingIssue, bindingPullRequest, bindingHeadSha, bindingRequestDigest].some(isPresent);
  if (anyPresent && !allPresent) {
    throw new Error('WEB2API_COPY_PARTIAL_BINDING: all five binding options (repository, issue, pullRequest, headSha, requestDigest) must be supplied with non-empty values');
  }
  const s4BindingActive = allPresent;
  const ref = {
    ...normalizeResponseRef(responseRef),
    repository: bindingRepository,
    issue: bindingIssue,
    pullRequest: bindingPullRequest,
    headSha: bindingHeadSha,
    requestDigest: bindingRequestDigest,
  };
  const seenConversations = new Map();
  function noteConversation(conversationId, anomalous) {
    if (typeof conversationId !== 'string' || !conversationId) return;
    const previous = seenConversations.get(conversationId);
    seenConversations.set(conversationId, { anomalous: Boolean(anomalous) || Boolean(previous && previous.anomalous) });
  }

  async function snapshotTurnIds() {
    const targets = listTargets({ cdpPort, runner });
    const page = findChatGptPageTarget(targets);
    if (!page || !page.webSocketDebuggerUrl) throw new Error('WEB2API_COPY_NO_PAGE_TARGET');
    const session = await openSession(page.webSocketDebuggerUrl);
    try {
      const raw = await cdpEvaluate(session, TURN_IDS_EXPRESSION);
      let ids = raw;
      if (typeof ids === 'string') {
        try { ids = JSON.parse(ids); } catch { ids = []; }
      }
      return { page, session, ids: Array.isArray(ids) ? ids.filter(Boolean) : [] };
    } catch (error) {
      try { session.close(); } catch { /* already closed */ }
      throw error;
    }
  }

  async function innerTransport({ prompt }) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return { ok: false, code: WEB2API_COPY_CODES.PROMPT_INVALID, reconcileRequired: true, safeToRetry: false, transportMeta: { postCount: 0 } };
    }

    let postCount = 0;
    let pre;
    try {
      pre = await snapshotTurnIds();
      try { pre.session.close(); } catch { /* already closed */ }
    } catch (error) {
      return { ok: false, code: WEB2API_COPY_CODES.UNAVAILABLE, error: String((error && error.message) || error), reconcileRequired: true, safeToRetry: false, transportMeta: { postCount } };
    }

    let submitUncertain = false;
    let conversationId = null;
    let modelSlug = null;
    let submitError = null;
    const wrappedPrompt = wrapPromptForCopyExtraction(prompt);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), submitTimeoutMs);
      let response;
      try {
        postCount += 1;
        response = await fetchImpl(`http://${web2apiHost}:${web2apiPort}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: WEB2API_FRESH_SYSTEM_PART },
              { role: 'user', content: wrappedPrompt },
            ],
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response || response.status !== 200) {
        submitUncertain = true;
        const errText = response ? await response.text() : 'NO_RESPONSE';
        submitError = `HTTP_${response ? response.status : 'ERR'}: ${errText.slice(0, 200)}`;
      } else {
        try {
          const data = await response.json();
          conversationId = String(data && (data.conversation_id || data.conversationId) || '') || null;
          modelSlug = data && data.model ? String(data.model) : null;
          if (!conversationId) {
            submitUncertain = true;
            submitError = `MISSING_CONVERSATION_ID: ${JSON.stringify(data).slice(0, 200)}`;
          }
        } catch (e) {
          submitUncertain = true;
          submitError = `JSON_PARSE_ERROR: ${e.message}`;
        }
      }
    } catch (error) {
      submitUncertain = true;
      submitError = `FETCH_EXCEPTION: ${error.message}`;
    }

    let session = null;
    if (conversationId && seenConversations.has(conversationId)) {
      noteConversation(conversationId, true);
      return { ok: false, code: WEB2API_COPY_CODES.CONVERSATION_REUSED, submitUncertain, conversationId, reconcileRequired: true, safeToRetry: false, transportMeta: { postCount, submitError } };
    }

    let post;
    let freshTurnIds = [];
    let turnObservationStart = nowImpl();
    const turnObservationTimeoutMs = 30000;
    let turnSession = null;
    let turnPage = null;
    while (freshTurnIds.length === 0 && nowImpl() - turnObservationStart < turnObservationTimeoutMs) {
      try {
        if (!turnSession) {
          const targets = listTargets({ cdpPort, runner });
          const page = findChatGptPageTarget(targets);
          if (!page || !page.webSocketDebuggerUrl) throw new Error('WEB2API_COPY_NO_PAGE_TARGET');
          turnSession = await openSession(page.webSocketDebuggerUrl);
          turnPage = page;
        }
        const raw = await cdpEvaluate(turnSession, TURN_IDS_EXPRESSION);
        let ids = raw;
        if (typeof ids === 'string') {
          try { ids = JSON.parse(ids); } catch { ids = []; }
        }
        post = { page: turnPage, session: turnSession, ids: Array.isArray(ids) ? ids.filter(Boolean) : [] };
        freshTurnIds = diffTurnIds(pre.ids, post.ids);
      } catch (error) {
        noteConversation(conversationId, true);
        return { ok: false, code: WEB2API_COPY_CODES.CDP_LOST, submitUncertain, conversationId, error: String((error && error.message) || error), reconcileRequired: true, safeToRetry: false, transportMeta: { postCount, submitError } };
      }
      if (freshTurnIds.length === 0) {
        await sleepImpl(500);
      }
    }
    if (!freshTurnIds.length) {
      noteConversation(conversationId, true);
      return { ok: false, code: WEB2API_COPY_CODES.TURN_NOT_OBSERVED, submitUncertain, conversationId, error: submitError, reconcileRequired: true, safeToRetry: false, transportMeta: { postCount, submitError } };
    }
    const turnId = freshTurnIds[freshTurnIds.length - 1];
    session = turnSession;

    const readiness = await waitForCopyReadiness(session, {
      turnId,
      sleepImpl,
      nowImpl,
      timeoutMs: 10000,
      pollMs: 250,
    });
    if (!readiness.ok) {
      noteConversation(conversationId, true);
      return {
        ok: false,
        code: WEB2API_COPY_CODES.COPY_EMPTY,
        submitUncertain,
        conversationId,
        turnId,
        error: 'COPY_NOT_READY: ' + JSON.stringify(readiness.state),
        reconcileRequired: true,
        safeToRetry: false,
        transportMeta: { postCount, submitError },
      };
    }

    if (conversationId && !targetConversationMatches(post.page, conversationId)) {
      noteConversation(conversationId, true);
      return { ok: false, code: WEB2API_COPY_CODES.CONVERSATION_MISMATCH, submitUncertain, conversationId, turnId, reconcileRequired: true, safeToRetry: false, transportMeta: { postCount, submitError } };
    }

    const gated = await copyLock(lockTimeoutMs);
    if (!gated.ok) {
      return { ok: false, code: gated.code, submitUncertain, conversationId, turnId, reconcileRequired: true, safeToRetry: false, transportMeta: { postCount, submitError } };
    }

    let copyPage = null;
    try {
      const targets = listTargets({ cdpPort, runner });
      copyPage = targets.find((target) =>
        target &&
        target.type === 'page' &&
        /chatgpt\.com/.test(target.url || '') &&
        targetConversationMatches(target, conversationId)
      ) || null;
    } catch { /* handled below */ }

    const targetId = copyPage && (copyPage.id || copyPage.targetId || null);
    if (!copyPage || !targetId || !copyPage.webSocketDebuggerUrl) {
      noteConversation(conversationId, true);
      return { ok: false, code: WEB2API_COPY_CODES.CONVERSATION_MISMATCH, submitUncertain, conversationId, turnId, reconcileRequired: true, safeToRetry: false, transportMeta: { postCount, submitError } };
    }

    try { session.close(); } catch { /* already closed */ }
    session = null;

    const activation = await activationFetchImpl(
      `http://127.0.0.1:${cdpPort}/json/activate/${encodeURIComponent(targetId)}`,
      { method: 'PUT' },
    );
    if (!activation || activation.ok === false) {
      noteConversation(conversationId, true);
      return { ok: false, code: WEB2API_COPY_CODES.CDP_LOST, submitUncertain, conversationId, turnId, reconcileRequired: true, safeToRetry: false, transportMeta: { postCount, submitError } };
    }

    const cleared = clip.clear();
    if (!cleared.ok) {
      noteConversation(conversationId, true);
      return { ok: false, code: cleared.code, submitUncertain, conversationId, turnId, reconcileRequired: true, safeToRetry: false, transportMeta: { postCount, submitError } };
    }
    await sleepImpl(200);

    try {
      session = await openSession(copyPage.webSocketDebuggerUrl);
    } catch (error) {
      noteConversation(conversationId, true);
      return { ok: false, code: WEB2API_COPY_CODES.CDP_LOST, submitUncertain, conversationId, turnId, error: String((error && error.message) || error), reconcileRequired: true, safeToRetry: false, transportMeta: { postCount, submitError } };
    }

    try { await session.send('Page.bringToFront', {}); } catch {}

    await session.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      modifiers: 10,
      windowsVirtualKeyCode: 186,
      nativeVirtualKeyCode: 186,
      key: ';',
      code: 'Semicolon'
    }, 30000);

    await session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: 10,
      windowsVirtualKeyCode: 186,
      nativeVirtualKeyCode: 186,
      key: ';',
      code: 'Semicolon'
    }, 30000);

    await sleepImpl(1000);

    const clipboardPollStarted = nowImpl();
    const clipboardPollTimeoutMs = 8000;
    const clipboardPollMs = 200;
    let clipboardText = '';
    while (nowImpl() - clipboardPollStarted <= clipboardPollTimeoutMs) {
      const directRead = clip.read();
      if (!directRead.ok) {
        return { ok: false, code: directRead.code || 'CLIPBOARD_READ_FAILED', submitUncertain, conversationId, turnId, reconcileRequired: true, safeToRetry: false, transportMeta: { postCount, submitError } };
      }
      clipboardText = String(directRead.text || '').trim();
      if (clipboardText.length) break;
      if (nowImpl() - clipboardPollStarted >= clipboardPollTimeoutMs) break;
      await sleepImpl(clipboardPollMs);
    }

    if (!clipboardText.length) {
      return { ok: false, code: WEB2API_COPY_CODES.COPY_EMPTY, submitUncertain, conversationId, turnId, error: 'CLIPBOARD_EMPTY_AFTER_POLL', reconcileRequired: true, safeToRetry: false, transportMeta: { postCount, submitError } };
    }

    const classification = classifyCapturedItem(clipboardText, ref);
    if (classification !== 'valid') {
      if (classification === 'binding-bad') {
        return { ok: false, code: WEB2API_COPY_CODES.BINDING_MISMATCH, submitUncertain, conversationId, turnId, reconcileRequired: true, safeToRetry: false, transportMeta: { postCount, submitError } };
      }
      if (classification === 'stale-digest') {
        return { ok: false, code: WEB2API_COPY_CODES.COPY_STALE, submitUncertain, conversationId, turnId, reconcileRequired: true, safeToRetry: false, transportMeta: { postCount, submitError } };
      }
      return { ok: false, code: WEB2API_COPY_CODES.COPY_BAD, submitUncertain, conversationId, turnId, error: `PARSE_FAILED_RAW: ${clipboardText.slice(0, 200)}`, reconcileRequired: true, safeToRetry: false, transportMeta: { postCount, submitError } };
    }

    noteConversation(conversationId, submitUncertain);
    return {
      ok: true,
      text: clipboardText,
      conversationId,
      modelSlug,
      canonicalRequestId: ref.responseRef || null,
      submitUncertain,
      reconcileRequired: submitUncertain,
      safeToRetry: false,
      transportMeta: {
        provider: WEB2API_COPY_FLAG_VALUE,
        schemaVersion: WEB2API_COPY_SCHEMA_VERSION,
        turnId,
        shortcutAttempts: 1,
        submitUncertain,
        copyLatencyMs: 0,
        interference: 0,
        collectorSeq: 0,
        postCount,
      },
    };
  }

  return async function transport({ prompt }) {
    return supervisor.withAutoRecover(() => innerTransport({ prompt }), {
      urlPattern: /chatgpt\.com/,
      defaultUrl: 'https://chatgpt.com',
    });
  };
}

export {
  createClipboardCollector,
  createCopyLock,
  createCdpSession,
  defaultClipboard,
  classifyCapturedItem,
};