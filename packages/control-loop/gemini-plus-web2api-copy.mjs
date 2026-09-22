// gemini-plus-web2api-copy.mjs
import {
  WEB2API_COPY_CODES,
  WEB2API_COPY_DEFAULT_CDP_PORT,
  createCdpSession,
  createCopyLock,
  defaultClipboard,
  diffTurnIds,
} from './chatgpt-plus-web2api-copy.mjs';
import { createCdpSupervisor } from './cdp-supervisor.mjs';
import { spawnSync } from 'node:child_process';

const sharedGeminiCopyLock = createCopyLock();

function defaultRunner({ command, args, timeoutMs }) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function cdpListTargets({ cdpPort, runner = defaultRunner } = {}) {
  const result = runner({ command: 'curl.exe', args: ['-s', '--max-time', '10', `http://127.0.0.1:${cdpPort}/json/list`], timeoutMs: 15000 });
  if (result.status !== 0) throw new Error(`curl /json/list exit ${result.status}`);
  return JSON.parse(result.stdout || '[]');
}

async function cdpEvaluate(session, expression, timeoutMs = 30000) {
  const message = await session.send('Runtime.evaluate', { expression, returnByValue: true }, timeoutMs);
  if (message.error) throw new Error('CDP_ERROR: ' + JSON.stringify(message.error).slice(0, 300));
  const result = message.result || {};
  if (result.exceptionDetails) throw new Error('PAGE_EXCEPTION: ' + JSON.stringify(result.exceptionDetails).slice(0, 300));
  return result.result ? result.result.value : undefined;
}

export function findGeminiPageTarget(targets) {
  if (!Array.isArray(targets)) return null;
  return targets.find((t) => t && t.type === 'page' && /gemini\.google\.com/.test(t.url || '')) || null;
}

export function conversationIdFromTargetUrl(url) {
  const appMatch = /\/app\/([a-f0-9]+)/.exec(String(url || ''));
  if (appMatch) return appMatch[1];
  const gemMatch = /\/gem\/[a-f0-9]+\/([a-f0-9]+)/.exec(String(url || ''));
  if (gemMatch) return gemMatch[1];
  return null;
}

export const TURN_IDS_EXPRESSION = `
JSON.stringify(
  Array.from(document.querySelectorAll('model-response')).map((mr) => {
    const rc = mr.querySelector('response-container[jslog]');
    if (!rc) return null;
    const jslog = rc.getAttribute('jslog') || '';
    const m = jslog.match(/BardVeMetadataKey:([A-Za-z0-9+/=_-]+)/);
    if (!m) return null;
    try {
      const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(b64))[0][0];
    } catch (e) { return null; }
  }).filter(Boolean)
)
`;

const CONVERSATION_ID_EXPRESSION = `
JSON.stringify((() => {
  const rc = document.querySelector('model-response response-container[jslog]');
  if (!rc) return null;
  const jslog = rc.getAttribute('jslog') || '';
  const m = jslog.match(/BardVeMetadataKey:([A-Za-z0-9+/=_-]+)/);
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const cId = JSON.parse(atob(b64))[0][1];
    return String(cId || '').replace(/^c_/, '');
  } catch (e) { return null; }
})())
`;

export async function readTurnIds(session) {
  const raw = await cdpEvaluate(session, TURN_IDS_EXPRESSION);
  const ids = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(ids) ? ids.filter(Boolean) : [];
}

export async function readConversationId(session) {
  const raw = await cdpEvaluate(session, CONVERSATION_ID_EXPRESSION);
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return value || null;
}

export async function isStreaming(session) {
  const raw = await cdpEvaluate(session, `
    (() => {
      const norm = (v) => String(v || '').trim().toLowerCase();
      const controls = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const el of controls) {
        const label = norm(el.getAttribute('aria-label'));
        const title = norm(el.getAttribute('title'));
        const text = norm(el.textContent);
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        const visible = r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        if (visible && (
          label.includes('dừng tạo') || label.includes('stop generating') ||
          label.includes('dừng') || label.includes('stop streaming') ||
          title.includes('dừng tạo') || title.includes('stop generating') ||
          title.includes('dừng') || title.includes('stop streaming') ||
          text === 'dừng tạo' || text === 'stop generating' || text === 'stop streaming'
        )) {
          return true;
        }
      }
      return false;
    })()
  `);
  return typeof raw === 'boolean' ? raw : false;
}

export async function submitViaClick(session, text) {
  // 0. Kiểm tra trạng thái streaming — tránh nuốt phím khi model đang phản hồi
  const streaming = await isStreaming(session);
  if (streaming) {
    return { ok: false, reason: 'model_is_streaming' };
  }

  // 1. Focus ô soạn thảo và xóa sạch văn bản cũ
  const focusRes = await cdpEvaluate(session, `
    (() => {
      const editor = document.querySelector('div.ql-editor[contenteditable="true"]') ||
                     document.querySelector('div[contenteditable="true"]');
      if (!editor) return { ok: false, reason: 'editor_not_found' };

      editor.focus();
      const clearRange = document.createRange();
      clearRange.selectNodeContents(editor);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(clearRange);
      document.execCommand('delete', false);
      return { ok: true };
    })()
  `);

  const focusObj = typeof focusRes === 'string' ? JSON.parse(focusRes) : focusRes;
  if (!focusObj || !focusObj.ok) {
    return { ok: false, reason: focusObj ? focusObj.reason : 'failed_to_focus_editor' };
  }

  // 2. Chèn trực tiếp văn bản qua native CDP Input.insertText (bỏ qua CSP TrustedHTML)
  await session.send('Input.insertText', { text });
  await new Promise((r) => setTimeout(r, 400));

  // 3. Tìm và click nút gửi trên giao diện (locale-independent)
  const clickSendRes = await cdpEvaluate(session, `
    (() => {
      const norm = (v) => String(v || '').trim().toLowerCase();
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      const sendBtn = btns.find((b) => {
        const label = norm(b.getAttribute('aria-label'));
        const tooltip = norm(b.getAttribute('mattooltip'));
        const title = norm(b.getAttribute('title'));
        const testId = norm(b.getAttribute('data-test-id'));
        const role = norm(b.getAttribute('role'));
        const hasSendIcon = b.querySelector('mat-icon[class*="send"], svg[class*="send"], .send-button, [data-test-id*="send"]');
        const isSend = (
          label.includes('gửi') || label.includes('send') ||
          tooltip.includes('gửi') || tooltip.includes('send') ||
          title.includes('gửi') || title.includes('send') ||
          testId.includes('send') || testId.includes('submit') ||
          (role === 'button' && (label.includes('gửi') || label.includes('send'))) ||
          !!hasSendIcon
        );
        return isSend && !b.disabled && b.getBoundingClientRect().width > 0;
      });
      if (sendBtn) {
        sendBtn.click();
        return { clicked: true };
      }
      return { clicked: false };
    })()
  `);

  const clickObj = typeof clickSendRes === 'string' ? JSON.parse(clickSendRes) : clickSendRes;

  // 4. Fallback bấm Enter nếu nút gửi chưa được kích hoạt
  if (!clickObj || !clickObj.clicked) {
    await session.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      windowsVirtualKeyCode: 13,
      key: 'Enter',
      code: 'Enter',
      text: String.fromCharCode(13),
      unmodifiedText: String.fromCharCode(13),
    });
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      windowsVirtualKeyCode: 13,
      key: 'Enter',
      code: 'Enter',
    });
  }

  await new Promise((r) => setTimeout(r, 1000));
  return { ok: true };
}

export async function submitAndConfirm(text, opts = {}) {
  const {
    cdpPort = Number(process.env.SOC_W2A_CDP_PORT) || WEB2API_COPY_DEFAULT_CDP_PORT,
    runner = defaultRunner,
    timeoutMs = 90000,
    pollIntervalMs = 500,
  } = opts;

  const targets = cdpListTargets({ cdpPort, runner });
  const page = findGeminiPageTarget(targets);
  if (!page || !page.webSocketDebuggerUrl) {
    return { ok: false, newTurnIds: [], reason: WEB2API_COPY_CODES.UNAVAILABLE };
  }

  const session = createCdpSession(page.webSocketDebuggerUrl);
  try {
    const before = await readTurnIds(session);

    const submitResult = await submitViaClick(session, text);
    if (!submitResult.ok) {
      return { ok: false, newTurnIds: [], reason: submitResult.reason };
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const after = await readTurnIds(session);
      const newTurnIds = diffTurnIds(before, after);
      if (newTurnIds.length > 0) {
        return { ok: true, newTurnIds };
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    return { ok: false, newTurnIds: [], reason: WEB2API_COPY_CODES.TURN_NOT_OBSERVED };
  } finally {
    try { session.close(); } catch { /* already closed */ }
  }
}

function copyReadyExpressionForRId(rId) {
  const encoded = JSON.stringify(String(rId || ''));
  return `
JSON.stringify((() => {
  const expectedRId = ${encoded};
  const responses = Array.from(document.querySelectorAll('model-response'));
  const newest = responses.length ? responses[responses.length - 1] : null;

  const extractRId = (mr) => {
    const rc = mr && mr.querySelector('response-container[jslog]');
    if (!rc) return null;
    const jslog = rc.getAttribute('jslog') || '';
    const m = jslog.match(/BardVeMetadataKey:([A-Za-z0-9+/=_-]+)/);
    if (!m) return null;
    try {
      const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(b64))[0][0];
    } catch (e) { return null; }
  };

  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };

  const turn = responses.find((mr) => extractRId(mr) === expectedRId) || null;
  const newestRId = newest ? extractRId(newest) : null;
  const exactFreshTurnIsNewest = !!turn && turn === newest;

  // Bắt nút "Sao chép" (Copy cả câu trả lời) — locale-independent
  const copyBtn = turn && Array.from(turn.querySelectorAll(
    'button[aria-label*="Sao chép"], button[aria-label*="Copy"], button[aria-label*="copy"], button[aria-label*="sao chép"], button[data-test-id*="copy"], button[title*="Copy"], button[title*="Sao chép"]'
  )).find((b) => visible(b) && !b.disabled) || null;

  return {
    ready: exactFreshTurnIsNewest && !!copyBtn,
    expectedRId,
    observedRId: turn ? extractRId(turn) : null,
    newestRId,
    exactFreshTurnIsNewest,
    hasCopyButton: !!copyBtn,
  };
})())
`;
}

async function waitForGeminiCopyReadiness(session, { rId, sleepImpl, nowImpl, timeoutMs = 25000, pollMs = 300 } = {}) {
  const started = nowImpl();
  let last = { ready: false, hasCopyButton: false, exactFreshTurnIsNewest: false };
  const expression = copyReadyExpressionForRId(rId);
  while (nowImpl() - started < timeoutMs) {
    const raw = await cdpEvaluate(session, expression);
    try { last = typeof raw === 'string' ? JSON.parse(raw) : (raw || last); }
    catch { last = { ready: false, hasCopyButton: false, exactFreshTurnIsNewest: false }; }
    if (last.ready) return { ok: true, state: last };
    await sleepImpl(pollMs);
  }
  return { ok: false, state: last };
}

function clickCopyExpression(rId) {
  const encoded = JSON.stringify(String(rId || ''));
  return `
(() => {
  const expectedRId = ${encoded};
  const responses = Array.from(document.querySelectorAll('model-response'));
  const extractRId = (mr) => {
    const rc = mr && mr.querySelector('response-container[jslog]');
    if (!rc) return null;
    const jslog = rc.getAttribute('jslog') || '';
    const m = jslog.match(/BardVeMetadataKey:([A-Za-z0-9+/=_-]+)/);
    if (!m) return null;
    try {
      const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(b64))[0][0];
    } catch (e) { return null; }
  };
  const turn = responses.find((mr) => extractRId(mr) === expectedRId) || null;
  if (!turn) return JSON.stringify({ ok: false, reason: 'turn_not_found' });

  const copyBtn = Array.from(turn.querySelectorAll(
    'button[aria-label*="Sao chép"], button[aria-label*="Copy"], button[aria-label*="copy"], button[aria-label*="sao chép"], button[data-test-id*="copy"], button[title*="Copy"], button[title*="Sao chép"]'
  )).find((b) => !b.disabled) || null;

  if (!copyBtn) return JSON.stringify({ ok: false, reason: 'copy_button_not_found' });
  copyBtn.click();
  return JSON.stringify({ ok: true });
})()
`;
}

export async function readResponseText(rId, opts = {}) {
  const {
    cdpPort = Number(process.env.SOC_W2A_CDP_PORT) || WEB2API_COPY_DEFAULT_CDP_PORT,
    runner = defaultRunner,
    clipboard = null,
    lock = null,
    lockTimeoutMs = 60000,
    activationFetchImpl = globalThis.fetch,
    sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
    nowImpl = Date.now,
    readinessTimeoutMs = 25000,
    clipboardPollTimeoutMs = 8000,
    clipboardPollMs = 200,
  } = opts;

  const copyLock = lock || sharedGeminiCopyLock;
  const clip = clipboard || defaultClipboard({ runner });

  const targets = cdpListTargets({ cdpPort, runner });
  const page = findGeminiPageTarget(targets);
  if (!page || !page.webSocketDebuggerUrl) {
    return { ok: false, code: WEB2API_COPY_CODES.UNAVAILABLE };
  }

  let session = createCdpSession(page.webSocketDebuggerUrl);

  const readiness = await waitForGeminiCopyReadiness(session, { rId, sleepImpl, nowImpl, timeoutMs: readinessTimeoutMs });
  if (!readiness.ok) {
    try { session.close(); } catch { /* already closed */ }
    return { ok: false, code: WEB2API_COPY_CODES.COPY_EMPTY, rId, error: 'COPY_NOT_READY: ' + JSON.stringify(readiness.state) };
  }

  const gated = await copyLock(lockTimeoutMs);
  if (!gated.ok) {
    try { session.close(); } catch { /* already closed */ }
    return { ok: false, code: gated.code, rId };
  }

  try {
    const targetId = page.id || page.targetId || null;
    if (!targetId) return { ok: false, code: WEB2API_COPY_CODES.CONVERSATION_MISMATCH, rId };

    try { session.close(); } catch { /* already closed */ }
    session = null;

    const activation = await activationFetchImpl(
      `http://127.0.0.1:${cdpPort}/json/activate/${encodeURIComponent(targetId)}`,
      { method: 'PUT' },
    );
    if (!activation || activation.ok === false) {
      return { ok: false, code: WEB2API_COPY_CODES.CDP_LOST, rId };
    }

    const cleared = clip.clear();
    if (!cleared.ok) return { ok: false, code: cleared.code, rId };
    await sleepImpl(200);

    session = createCdpSession(page.webSocketDebuggerUrl);
    try { await session.send('Page.bringToFront', {}); } catch { /* best effort */ }

    const rawClick = await cdpEvaluate(session, clickCopyExpression(rId));
    const clickResult = typeof rawClick === 'string' ? JSON.parse(rawClick) : rawClick;
    if (!clickResult.ok) {
      return { ok: false, code: WEB2API_COPY_CODES.COPY_BAD, rId, error: clickResult.reason };
    }

    const pollStart = nowImpl();
    let clipboardText = '';
    while (nowImpl() - pollStart <= clipboardPollTimeoutMs) {
      const read = clip.read();
      if (!read.ok) return { ok: false, code: read.code || 'CLIPBOARD_READ_FAILED', rId };
      clipboardText = String(read.text || '').trim();
      if (clipboardText.length) break;
      await sleepImpl(clipboardPollMs);
    }

    if (!clipboardText.length) {
      return { ok: false, code: WEB2API_COPY_CODES.COPY_EMPTY, rId, error: 'CLIPBOARD_EMPTY_AFTER_POLL' };
    }

    return { ok: true, text: clipboardText, rId };
  } finally {
    gated.release();
    if (session) { try { session.close(); } catch { /* already closed */ } }
  }
}

export async function submitAndRead(prompt, opts = {}) {
  const submitResult = await submitAndConfirm(prompt, opts);
  if (!submitResult.ok) {
    return { ok: false, code: submitResult.reason || WEB2API_COPY_CODES.TURN_NOT_OBSERVED };
  }
  const rId = submitResult.newTurnIds[submitResult.newTurnIds.length - 1];
  return readResponseText(rId, opts);
}

const MODEL_SLUG_EXPRESSION = `
JSON.stringify((() => {
  const btn = document.querySelector('[data-test-id="bard-mode-menu-button"]');
  if (!btn) return null;
  const label = btn.getAttribute('aria-label') || '';
  const m = label.match(/(?:hiện tại là|current model is|currently)\\s+(.+)$/i);
  return m ? m[1].trim() : null;
})())
`;

export function createGeminiFinalReviewFallbackTransport(opts = {}) {
  const supervisor = createCdpSupervisor({
    port: opts.cdpPort || Number(process.env.SOC_W2A_CDP_PORT) || WEB2API_COPY_DEFAULT_CDP_PORT,
    userDataDir: opts.userDataDir || null,
    headless: opts.headless || false,
    fetchImpl: opts.fetchImpl || globalThis.fetch,
    log: opts.log || (() => {}),
  });

  return async function transport({ prompt }) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return { ok: false, code: 'GEMINI_PROMPT_INVALID' };
    }

    const wrappedTransport = async () => {
      const result = await submitAndRead(prompt, opts);
      if (!result.ok) {
        return { ok: false, code: result.code || 'GEMINI_TRANSPORT_FAILED', detail: result.error || null };
      }

      let conversationId = null;
      let modelSlug = null;
      try {
        const {
          cdpPort = Number(process.env.SOC_W2A_CDP_PORT) || WEB2API_COPY_DEFAULT_CDP_PORT,
          runner = defaultRunner,
        } = opts;
        const targets = cdpListTargets({ cdpPort, runner });
        const page = findGeminiPageTarget(targets);
        if (page && page.webSocketDebuggerUrl) {
          const session = createCdpSession(page.webSocketDebuggerUrl);
          try {
            conversationId = await readConversationId(session);
            const rawSlug = await cdpEvaluate(session, MODEL_SLUG_EXPRESSION);
            modelSlug = typeof rawSlug === 'string' ? JSON.parse(rawSlug) : rawSlug;
          } finally {
            try { session.close(); } catch { /* already closed */ }
          }
        }
      } catch { /* enrichment is best-effort */ }

      return {
        ok: true,
        text: result.text,
        conversationId,
        modelSlug,
      };
    };

    return supervisor.withAutoRecover(wrappedTransport, {
      urlPattern: /gemini\.google\.com/,
      defaultUrl: 'https://gemini.google.com',
    });
  };
}
