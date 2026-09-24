import fs from "node:fs";
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
import { createReviewPayload, buildReviewPromptForSession } from './review-payload.mjs';
import { parseReviewVerdict } from './verdict-parser.mjs';

const sharedGeminiCopyLock = createCopyLock();

// Default CDP configuration for Gemini Web2API
export const GEMINI_WEB2API_DEFAULT_CDP_PORT = 9222;
export const GEMINI_WEB2API_DEFAULT_HOST = '127.0.0.1';

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


export async function submitViaClipboardPaste(session, text, { runner = defaultRunner, sleepImpl = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  // 1. Kiem tra streaming
  const streaming = await isStreaming(session);
  if (streaming) {
    return { ok: false, reason: 'model_is_streaming' };
  }

  // 2. Nap noi dung vao clipboard he thong Windows an toan
  fs.writeFileSync('temp_gemini_paste.txt', text, 'utf8');
  spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Content -Raw temp_gemini_paste.txt | Set-Clipboard']);
  try { fs.unlinkSync('temp_gemini_paste.txt'); } catch {}

  // 3. Focus o soan thao va chon toan bo
  await cdpEvaluate(session, `(() => {
    const editor = document.querySelector('rich-textarea p') ||
                   document.querySelector('div.ql-editor[contenteditable="true"]') ||
                   document.querySelector('div[contenteditable="true"]');
    if (editor) {
      editor.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  })()`);

  try { await session.send('Page.bringToFront', {}); } catch {}

  // 4. Gui to hop Ctrl + V native qua CDP
  await session.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    modifiers: 2,
    windowsVirtualKeyCode: 86,
    key: 'v',
    code: 'KeyV',
  });
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    modifiers: 2,
    windowsVirtualKeyCode: 86,
    key: 'v',
    code: 'KeyV',
  });

  await sleepImpl(1200);

  // 5. Click nut Gui tren giao dien
  const clickRes = await cdpEvaluate(session, `(() => {
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    const sendBtn = btns.find(b => {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      const hasIcon = b.querySelector('mat-icon[class*="send"], svg[class*="send"], .send-button');
      return (aria.includes('gửi') || aria.includes('send') || Boolean(hasIcon)) && !b.disabled;
    });
    if (sendBtn) {
      sendBtn.click();
      return { ok: true, method: 'button' };
    }
    const editor = document.querySelector('rich-textarea p') || document.querySelector('div[contenteditable="true"]');
    if (editor) {
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      return { ok: true, method: 'enter' };
    }
    return { ok: false };
  })()`);

  const clickObj = typeof clickRes === 'string' ? JSON.parse(clickRes) : clickRes;
  return { ok: Boolean(clickObj && clickObj.ok) };
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

async function waitForGeminiCopyReadiness(session, { rId, sleepImpl, nowImpl, timeoutMs = 180000, pollMs = 1000 } = {}) {
  const started = nowImpl();
  let last = { ready: false, hasCopyButton: false, exactFreshTurnIsNewest: false };
  const expression = copyReadyExpressionForRId(rId);

  while (nowImpl() - started < timeoutMs) {
    // 1. Nếu còn đang streaming (còn nút "Dừng tạo"), tiếp tục chờ, KHÔNG ĐƯỢC COPY VỘI
    const streaming = await isStreaming(session);
    if (streaming) {
      await sleepImpl(pollMs);
      continue;
    }

    // 2. Khi đã dừng stream, kiểm tra xem nút Copy đã lên chưa
    const raw = await cdpEvaluate(session, expression);
    try { last = typeof raw === 'string' ? JSON.parse(raw) : (raw || last); }
    catch { last = { ready: false, hasCopyButton: false, exactFreshTurnIsNewest: false }; }

    if (last.ready) {
      // Chờ thêm 1 giây để DOM render hoàn tất và clipboard buffer sẵn sàng
      await sleepImpl(1000);
      return { ok: true, state: last };
    }

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

  // Tìm thanh công cụ bên dưới của câu trả lời (chứa nút Copy toàn bài, Like, Dislike, Share)
  const footerOrContainer = turn.querySelector('.response-footer, [class*="action-buttons"], [data-test-id*="footer"]') || turn;

  const buttons = Array.from(footerOrContainer.querySelectorAll('button, [role="button"]'));

  // Ưu tiên tìm nút copy phản hồi (không lấy nút copy code nằm trong pre/code)
  const copyBtn = buttons.filter((b) => {
    if (b.closest('pre') || b.closest('code-block')) return false; // LOẠI TRỪ nút copy code
    const label = (b.getAttribute('aria-label') || b.getAttribute('title') || b.getAttribute('data-test-id') || '').toLowerCase();
    return (label.includes('sao chép') || label.includes('copy')) && !label.includes('mã') && !label.includes('code');
  }).find((b) => !b.disabled) || null;

  if (!copyBtn) {
    // Fallback nếu không click được nút: trích xuất trực tiếp innerText của toàn turn
    return JSON.stringify({ ok: false, reason: 'copy_button_not_found', fallbackText: turn.innerText || turn.textContent });
  }

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

export async function createGeminiFinalReviewWithDiffTransport(opts = {}) {
  // Use the new standardized Web2API review transport as the primary transport
  const standardTransport = await createGeminiWeb2ApiReviewTransport(opts);
  // Keep fallback for backward compatibility
  const fallbackTransport = createGeminiFinalReviewFallbackTransport(opts);

  return async function reviewTransport({ prNumber, headSha, bindingRequestDigest, contextMetadata = {}, prompt: userPrompt, session, testLog, bundleInfo, diff }) {
    // If user provides a raw prompt, use it directly with fallback (backward compat)
    if (userPrompt && typeof userPrompt === 'string') {
      return fallbackTransport({ prompt: userPrompt });
    }

    // Validate required parameters
    if (!prNumber || typeof prNumber !== 'number') {
      return { ok: false, code: 'INVALID_PR_NUMBER', detail: 'prNumber (number) required', verdict: 'BLOCKED' };
    }
    if (!headSha || typeof headSha !== 'string' || headSha.length !== 40) {
      return { ok: false, code: 'INVALID_HEAD_SHA', detail: 'headSha (40-hex) required', verdict: 'BLOCKED' };
    }

    // Build standardized review prompt with full evidence packaging
    const promptResult = buildReviewPromptForSession({ session: { prNumber, headSha, ...contextMetadata }, testLog, bundleInfo, diff });
    if (!promptResult.ok) {
      return { ok: false, code: promptResult.code, detail: promptResult.detail, verdict: 'BLOCKED' };
    }

    const prompt = promptResult.prompt;

    // Safety check: ensure prompt fits within clipboard limits
    if (prompt.length > MAX_CLIPBOARD_CHARS) {
      return { ok: false, code: 'REVIEW_PROMPT_TOO_LARGE', detail: `prompt length ${prompt.length} exceeds safe clipboard limit`, verdict: 'BLOCKED' };
    }

    // Use standardized transport with CDP polling and verdict parsing
    return standardTransport({ prompt, session, testLog, bundleInfo, diff });
  };
}

export async function submitAndRead(prompt, opts = {}) {
  const submitResult = await submitAndConfirm(prompt, opts);
  if (!submitResult.ok) {
    return { ok: false, code: submitResult.reason || WEB2API_COPY_CODES.TURN_NOT_OBSERVED };
  }
  const rId = submitResult.newTurnIds[submitResult.newTurnIds.length - 1];
  return readResponseText(rId, opts);
}

/**
 * CDP Expression to extract the full text content of the latest model-response.
 * Polls the DOM for the newest model-response element and extracts its text content.
 */
export const LATEST_MODEL_RESPONSE_EXPRESSION = `
(() => {
  const responses = Array.from(document.querySelectorAll('model-response'));
  if (!responses.length) return null;
  const newest = responses[responses.length - 1];
  const messageContent = newest.querySelector('.message-content, [data-test-id="model-response-text"], response-container');
  if (messageContent) {
    return messageContent.innerText || messageContent.textContent || '';
  }
  return newest.innerText || newest.textContent || '';
})()
`;

/**
 * Poll CDP for the latest model response text until it stabilizes or timeout.
 * This is the Extraction Loop - continuously polls DOM for the model's final answer.
 */
export async function pollForModelResponse(session, opts = {}) {
  const {
    timeoutMs = 180000,
    pollIntervalMs = 1500,
    minStableRounds = 3,
    initialWaitTimeoutMs = 30000,
  } = opts;

  const checkStateExpr = `(() => {
    const responses = document.querySelectorAll('model-response');
    const count = responses.length;
    const last = count > 0 ? responses[count - 1] : null;
    const text = last ? (last.innerText || last.textContent || '').trim() : '';

    const norm = (v) => String(v || '').trim().toLowerCase();
    const controls = Array.from(document.querySelectorAll('button, [role="button"]'));
    const isStreaming = controls.some((el) => {
      const label = norm(el.getAttribute('aria-label'));
      const title = norm(el.getAttribute('title'));
      const textContent = norm(el.textContent);
      return (
        label.includes('dừng') || label.includes('stop') ||
        title.includes('dừng') || title.includes('stop') ||
        textContent === 'dừng tạo' || textContent === 'stop generating' || textContent === 'stop streaming'
      );
    });

    return { count, textLength: text.length, isStreaming };
  })()`;

  // Pha 1: Đợi streaming bắt đầu hoặc xuất hiện phản hồi
  const startWait = Date.now();
  while (Date.now() - startWait < initialWaitTimeoutMs) {
    try {
      const state = await cdpEvaluate(session, checkStateExpr);
      if (state && (state.isStreaming || state.textLength > 0)) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Pha 2: Đợi streaming kết thúc VÀ văn bản đạt độ ổn định
  let lastLen = 0;
  let stableRounds = 0;
  const streamStart = Date.now();

  while (Date.now() - streamStart < timeoutMs) {
    try {
      const state = await cdpEvaluate(session, checkStateExpr);
      if (state) {
        if (state.isStreaming) {
          stableRounds = 0;
        } else {
          if (state.textLength > 30 && state.textLength === lastLen) {
            stableRounds++;
            if (stableRounds >= minStableRounds) {
              const text = await cdpEvaluate(session, LATEST_MODEL_RESPONSE_EXPRESSION);
              return { ok: true, text: typeof text === 'string' ? text.trim() : '' };
            }
          } else {
            stableRounds = 0;
            lastLen = state.textLength;
          }
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  const fallbackText = await cdpEvaluate(session, LATEST_MODEL_RESPONSE_EXPRESSION);
  if (fallbackText && String(fallbackText).trim().length > 10) {
    return { ok: true, text: String(fallbackText).trim(), timeout: true };
  }

  return { ok: false, code: 'REVIEW_TIMEOUT', verdict: 'BLOCKED', detail: 'Model response polling timed out' };
}

/**
 * Standardized review transport using CDP polling extraction and verdict parsing.
 * Returns: { ok: true, verdict: 'APPROVED'|'CHANGES_REQUESTED'|'BLOCKED', rationale: '...', rawText: '...' }
 * Fail-closed on timeout: { ok: false, code: 'REVIEW_TIMEOUT', verdict: 'BLOCKED' }
 */
export async function createGeminiWeb2ApiReviewTransport(opts = {}) {
  const {
    cdpPort = GEMINI_WEB2API_DEFAULT_CDP_PORT,
    host = GEMINI_WEB2API_DEFAULT_HOST,
    runner = defaultRunner,
    submitTimeoutMs = 90000,
    pollTimeoutMs = 120000,
    log = () => {},
  } = opts;

  return async function reviewTransport({ prompt, session: sessionData, testLog, bundleInfo, diff }) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return { ok: false, code: 'GEMINI_PROMPT_INVALID', verdict: 'BLOCKED' };
    }

    // 1. Find Gemini page target
    const targets = cdpListTargets({ cdpPort, runner });
    const page = findGeminiPageTarget(targets);
    if (!page || !page.webSocketDebuggerUrl) {
      return { ok: false, code: WEB2API_COPY_CODES.UNAVAILABLE, verdict: 'BLOCKED' };
    }

    let cdpSession = createCdpSession(page.webSocketDebuggerUrl);

    try {
      // 2. Submit prompt
      log('Submitting review prompt to Gemini...');
      const submitResult = await submitViaClipboardPaste(cdpSession, prompt);
      if (!submitResult.ok) {
        return { ok: false, code: submitResult.reason || 'SUBMIT_FAILED', verdict: 'BLOCKED' };
      }

      // 3. Wait for new turn to appear
      const before = await readTurnIds(cdpSession);
      const submitDeadline = Date.now() + submitTimeoutMs;
      let newTurnIds = [];

      while (Date.now() < submitDeadline) {
        const after = await readTurnIds(cdpSession);
        newTurnIds = diffTurnIds(before, after);
        if (newTurnIds.length > 0) break;
        await new Promise((r) => setTimeout(r, 500));
      }

      if (newTurnIds.length === 0) {
        return { ok: false, code: 'TURN_NOT_OBSERVED', verdict: 'BLOCKED' };
      }

      // 4. Poll for model response (Extraction Loop)
      log('Polling for model response...');
      const pollResult = await pollForModelResponse(cdpSession, { timeoutMs: pollTimeoutMs });

      if (!pollResult.ok) {
        return {
          ok: false,
          code: pollResult.code || 'REVIEW_TIMEOUT',
          verdict: pollResult.verdict || 'BLOCKED',
          detail: pollResult.detail,
        };
      }

      const rawText = pollResult.text;

      // 5. Parse verdict using verdict-parser (fail-closed)
      const parseResult = parseReviewVerdict(rawText, { allowNonFinal: true });
      if (!parseResult.ok) {
        return {
          ok: false,
          code: parseResult.code || 'VERDICT_PARSE_FAILED',
          verdict: 'BLOCKED',
          detail: parseResult.detail,
          rawText,
        };
      }

      const verdict = parseResult.value.rawVerdict; // APPROVED, CHANGES_REQUESTED, BLOCKED
      const findings = parseResult.value.findings || [];
      const rationale = findings.join('\n') || '(no detailed findings provided)';

      log(`Review verdict extracted: ${verdict}`);

      return {
        ok: true,
        verdict,
        rationale,
        rawText,
        metadata: {
          conversationId: null, // Could be enriched later
          modelSlug: null,
          pollTimeout: pollResult.timeout === true,
          findingsCount: findings.length,
        },
      };

    } finally {
      try { cdpSession.close(); } catch { /* already closed */ }
    }
  };
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

/**
 * Transport danh rieng cho Advisor: Chi lay noi dung chi dan, khong bat buoc VERDICT header
 */
export async function createGeminiWeb2ApiAdvisorTransport({ cdpPort = 9222, host = '127.0.0.1', log = () => {} } = {}) {
  const baseTransport = await createGeminiWeb2ApiReviewTransport({ cdpPort, host, log });
  return async function dispatchAdvisor(ctx) {
    const res = await baseTransport(ctx);
    if (res && !res.ok && res.code === 'VERDICT_NOT_FOUND' && res.rawText) {
      return {
        ok: true,
        guidance: res.rawText,
        text: res.rawText,
        rawText: res.rawText,
        source: 'gemini-web2api-advisor'
      };
    }
    return res;
  };
}
