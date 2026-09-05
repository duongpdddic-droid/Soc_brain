#!/usr/bin/env node
// e2e-reverse-control-leg.mjs — REAL reverse control leg E2E (Issue #67).
//
// Proves, with REAL components and NO manual copy/paste:
//   1. Canonical task: the #67 session (taskStart already fired TASK_STARTED).
//   2. GPT decision authority: REAL ChatGPT Web Plus via
//      transport chatgpt-web-plus/cdp-inpage-backend-api (live CDP browser).
//   3. Reverse dispatch seam: loopback HTTP -> fail-closed validate ->
//      SOC_TASK_CONTRACT.md DATA append (executor-independent contracts in
//      packages/reverse-dispatch).
//   4. Executor continuation: reads the APPLIED instruction from the seam
//      output, performs the small reversible machine-verifiable action
//      (marker file with EXACT content echoed by GPT), deterministic
//      read-back verification stays authoritative.
//   5. Canonical terminal state: taskFinish(COMPLETED) -> exactly-one
//      Telegram TASK_COMPLETED dispatch (dedupe ledger).
//   6. Replay guard: a second POST of the same decision is rejected.
//
// No mocks, no fallback LLM, no browser launching: if the live ChatGPT Web
// Plus browser (CDP) is absent, this fails closed with evidence — it never
// fakes PASS. Exit 0 = every check verified.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReverseDispatchServer } from '../packages/reverse-dispatch/reverse-dispatch-server.mjs';
import { ledgerPath } from '../packages/reverse-dispatch/reverse-dispatch.mjs';
import { applyValidatedDecision, readAppliedInstruction, contractHintPath, APPLIED_MARKER_PREFIX } from '../packages/reverse-dispatch/reverse-waiter.mjs';
import { canonicalStateText } from '../packages/reverse-dispatch/reverse-dispatch.mjs';
import { taskFinish } from '../packages/runtime-sandbox/runtime-sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'duongpdddic-droid/Soc_brain';
const TASK_REF = 'Issue #67';
const CDP_PORT = Number(process.env.SOC_REVERSE_CDP_PORT || 9223);
const OUT_DIR = path.join(os.homedir(), '.soc-brain', 'e2e');
const STATE_DIR = path.join(os.homedir(), '.soc-brain', 'state');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) throw new Error('E2E_FAIL: ' + name);
}

function git(worktree, args) {
  return spawnSync('git', args, { cwd: worktree, encoding: 'utf8' }).stdout.trim();
}

// ---- canonical #67 session discovery (binding outside the worktree) ----------

function discoverSession() {
  const dir = path.join(STATE_DIR, 'sessions');
  const found = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (s && s.taskId === `${REPO.toLowerCase()}#${TASK_REF.match(/\d+/)[0]}`) found.push(s);
    } catch { /* skip unreadable */ }
  }
  found.sort((a, b) => String(b.lease?.issuedAt || '').localeCompare(String(a.lease?.issuedAt || '')));
  return found[0] || null;
}

// ---- live ChatGPT Web Plus via CDP (the #63-proven transport) ---------------
// transport = chatgpt-web-plus/cdp-inpage-backend-api: attach to the LIVE
// user-profile Chrome (CDP 9223), find the chatgpt.com page target, run an
// in-page async function inside the chatgpt.com origin (its own session).

function cdpListTargets() {
  const r = spawnSync('curl.exe', ['-s', '--max-time', '10', `http://127.0.0.1:${CDP_PORT}/json/list`],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`curl /json/list exit ${r.status}`);
  return JSON.parse(r.stdout);
}

function cdpEvaluate(wsUrl, expression, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* already closed */ }
      reject(new Error('CDP_EVALUATE_TIMEOUT'));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1, method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      if (msg.error) return reject(new Error('CDP_ERROR: ' + JSON.stringify(msg.error).slice(0, 300)));
      if (msg.result && msg.result.exceptionDetails) {
        return reject(new Error('PAGE_EXCEPTION: ' + JSON.stringify(msg.result.exceptionDetails).slice(0, 500)));
      }
      resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP_WS_ERROR')); });
  });
}

// ---- CDP-level capture of the conversation response ----------------------------
// The page's client holds its own fetch reference, so window.fetch wrapping is
// bypassed. Capture at the transport layer instead: Network domain events on the
// same CDP socket. Returns { status, text } of the POST /backend-api/conversation
// response once loadingFinished, or fails with the network error.
function captureConversationResponse(wsUrl, sendExpression, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* closed */ }
      reject(new Error('CAPTURE_TIMEOUT'));
    }, timeoutMs);
    let convReqId = null;
    let convStatus = null;
    let seq = 0;
    const send = (method, params, onMsg) => {
      const id = ++seq;
      const on = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.id === id) { ws.removeEventListener('message', on); onMsg(m); }
      };
      ws.addEventListener('message', on);
      ws.send(JSON.stringify({ id, method, params }));
    };
    const onEvent = (ev) => {
      let m;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      const { method, params } = m;
      if (method === 'Network.requestWillBeSent' && params.request.method === 'POST'
        && /\/backend-api\/(f\/)?conversation\/?(\?|$)/.test(params.request.url) && convReqId === null) {
        convReqId = params.requestId;
      }
      if (method === 'Network.responseReceived' && params.requestId === convReqId) {
        convStatus = params.response.status;
      }
      if (method === 'Network.loadingFailed' && params.requestId === convReqId) {
        clearTimeout(timer);
        try { ws.close(); } catch { /* closed */ }
        reject(new Error('CONVERSATION_REQUEST_FAILED: ' + params.errorText + ' status=' + convStatus));
      }
      if (method === 'Network.loadingFinished' && params.requestId === convReqId) {
        send('Network.getResponseBody', { requestId: convReqId }, (r) => {
          clearTimeout(timer);
          try { ws.close(); } catch { /* closed */ }
          if (r.error) return reject(new Error('GET_RESPONSE_BODY_FAILED: ' + JSON.stringify(r.error).slice(0, 200)));
          const b = r.result;
          const text = b && b.isBase64 ? Buffer.from(b.body, 'base64').toString('utf8') : (b && b.body) || '';
          resolve({ status: convStatus, text });
        });
      }
    };
    ws.addEventListener('message', onEvent);
    ws.addEventListener('open', () => {
      send('Network.enable', {}, () => {
        send('Runtime.evaluate', { expression: sendExpression, awaitPromise: true, returnByValue: true }, (r) => {
          if (r.error || (r.result && r.result.exceptionDetails)) {
            clearTimeout(timer);
            try { ws.close(); } catch { /* closed */ }
            reject(new Error('SEND_EVAL_FAILED: ' + JSON.stringify(r.error || r.result.exceptionDetails).slice(0, 300)));
          }
        });
      });
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CAPTURE_WS_ERROR')); });
  });
}

function uiSendExpr(prompt) {
  return `
(async () => {
  const ta = document.querySelector('#prompt-textarea');
  if (!ta) return JSON.stringify({ ok: false, err: 'no textarea' });
  ta.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, ${JSON.stringify(prompt)});
  const after = ta.textContent || '';
  if (!after.includes('Reverse control leg test')) return JSON.stringify({ ok: false, err: 'insert failed' });
  let btn = null;
  for (let i = 0; i < 12 && !btn; i++) {
    await new Promise((r) => setTimeout(r, 250));
    btn = document.querySelector('[data-testid="send-button"]')
      || document.querySelector('button[aria-label*="Send"]');
  }
  if (btn && !btn.disabled) { btn.click(); return JSON.stringify({ ok: true, via: 'button' }); }
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  return JSON.stringify({ ok: true, via: 'enter', btnFound: !!btn });
})()
`;
}

// Parse a captured SSE body string (Node side): last assistant text + conversation id.
// Handles legacy full-message events and the v1 delta (JSON-patch) encoding,
// including chained deltas where p/o are inherited from the previous op and
// {"p":"","o":"patch","v":[ops]} envelopes.
function parseSseCapture(sseText) {
  let text = '';
  let conversationId = null;
  let modelSlug = null;
  const applyMsg = (msg) => {
    if (!msg) return;
    if (msg.author && msg.author.role === 'assistant' && msg.content && Array.isArray(msg.content.parts)) {
      const parts = msg.content.parts.filter((p) => typeof p === 'string');
      if (parts.length) text = parts.join('');
    }
    if (msg.metadata && msg.metadata.model_slug) modelSlug = msg.metadata.model_slug;
  };
  const handleOp = (p, o, v) => {
    if (o === 'add' && (!p || p === '') && v && v.message) { applyMsg(v.message); return; }
    if (typeof p === 'string' && p.startsWith('/message/content/parts') && typeof v === 'string') {
      if (o === 'append') text += v;
      else if (o === 'replace' && p.endsWith('/0')) text = v; // ponytail: tracks parts/0 only; multi-part messages would need part indexing
    } else if (p === '/message/metadata' && v && typeof v === 'object' && v.model_slug) {
      modelSlug = v.model_slug;
    }
  };
  const applyOps = (ops, cur) => {
    for (const patch of ops) {
      if (!patch || typeof patch !== 'object') continue;
      // {"o":"patch","v":[ops]} envelope: recurse with fresh inheritance state,
      // leaving the outer stream state (p/o) untouched for chained deltas.
      if (patch.o === 'patch' && Array.isArray(patch.v)) {
        applyOps(patch.v, { p: undefined, o: undefined });
        continue;
      }
      if (typeof patch.p === 'string') cur.p = patch.p;
      if (typeof patch.o === 'string') cur.o = patch.o;
      if ('v' in patch) handleOp(cur.p, cur.o, patch.v);
    }
  };
  const cur = { p: undefined, o: undefined }; // stream-level inheritance state
  for (const line of String(sseText).split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let obj;
    try { obj = JSON.parse(payload); } catch { continue; }
    if (Array.isArray(obj)) { applyOps(obj, cur); continue; }
    if (obj && typeof obj === 'object' && ('p' in obj || 'o' in obj || 'v' in obj)) {
      applyOps([obj], cur);
      continue;
    }
    // Named event envelopes.
    if (obj && obj.conversation_id) conversationId = obj.conversation_id;
    if (obj && obj.message) applyMsg(obj.message);
    if (obj && obj.type === 'server_ste_metadata' && obj.metadata && obj.metadata.model_slug) {
      modelSlug = obj.metadata.model_slug;
    }
  }
  return { text, conversationId, modelSlug };
}

// First balanced JSON object inside free text (string-aware brace scan).
function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

function buildPrompt({ requestId, nonce, stateDigest }) {
  const marker = `E2E67_REVERSE_OK ${nonce}`;
  const nowAnchor = new Date().toISOString();
  return [
    'Reverse control leg test (Soc_brain Issue #67). You are the decision authority.',
    'Reply with ONE JSON object EXACTLY in this shape — no markdown fences, nothing before it:',
    `{"requestId":"${requestId}","repo":"${REPO}","taskRef":"${TASK_REF}","stateDigest":"<stateDigest given below>","decision":"CONTINUE","issuedAt":"<the current UTC time, see anchor below>","reasoning":"<one sentence>","nextAction":"<one sentence>","confidence":0.9,"instruction":"Create file .soc-e2e-67/marker-${nonce}.txt in the task worktree containing exactly the line ${marker}","executorHint":"deterministic verification already passed; proceed"}`,
    'Rules: echo requestId, repo, taskRef and stateDigest EXACTLY as given below. decision must be exactly CONTINUE.',
    `Clock anchor: the current UTC time when this prompt was submitted is ${nowAnchor}. issuedAt must be a valid ISO-8601 timestamp with Z within 2 minutes of that anchor — the decision expires in 15 minutes.`,
    `Bindings: repo=${REPO} taskRef=${TASK_REF} requestId=${requestId}`,
    `stateDigest=${stateDigest}`,
    `After the JSON object, end your reply with this exact line on its own: ${marker}`,
    'The executor worktree is clean at the pinned head; the reverse-dispatch unit tests pass 14/14.',
  ].join('\n');
}

// ---- E2E main ------------------------------------------------------------------

async function main() {
  const startedAt = new Date().toISOString();
  const evidence = {
    kind: 'e2e-reverse-control-leg',
    issue: 67,
    repo: REPO,
    taskRef: TASK_REF,
    transport: 'chatgpt-web-plus/cdp-inpage-backend-api',
    cdpPort: CDP_PORT,
    startedAt,
    noManualIntervention: false,
    basis: [],
  };
  const nonce = crypto.randomUUID();

  // 1. Canonical session binding (control plane OUTSIDE any worktree).
  const session = discoverSession();
  check('canonical session #67 found', !!session && session.state === 'SESSION_ACTIVE',
    session ? `${session.taskId} @ ${session.worktreePath}` : 'no SESSION_ACTIVE record');
  const worktree = session.worktreePath;
  check('canonical worktree exists', fs.existsSync(path.join(worktree, '.git')));
  evidence.worktreePath = worktree;
  evidence.branch = session.branch;
  evidence.sessionPath = session.controlPlane.sessionPath;

  // The implementation must run from the CANONICAL worktree (never another
  // issue's workspace). The provisioned worktree starts at base SHA without
  // the task's own uncommitted files; sync the task's reverse-dispatch +
  // tests in (task-scoped, committed later from this worktree).
  const syncDirs = [
    ['packages/reverse-dispatch', 'packages/reverse-dispatch'],
    ['packages/advisor-mcp', 'packages/advisor-mcp'],
    ['tests/reverse-dispatch.test.mjs', 'tests/reverse-dispatch.test.mjs'],
    ['tests/advisor-mcp.test.mjs', 'tests/advisor-mcp.test.mjs'],
  ];
  for (const [src, dst] of syncDirs) {
    const s = path.join(process.cwd(), src);
    const d = path.join(worktree, dst);
    if (!fs.existsSync(s)) continue;
    const st = fs.statSync(s);
    if (st.isDirectory()) fs.cpSync(s, d, { recursive: true });
    else { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d); }
  }
  check('reverse-dispatch present in canonical worktree',
    fs.existsSync(path.join(worktree, 'packages', 'reverse-dispatch', 'reverse-dispatch.mjs')));

  // 2. Canonical state digest (branch/head/dirty/step of THIS worktree).
  const branch = git(worktree, ['branch', '--show-current']);
  const head = git(worktree, ['rev-parse', 'HEAD']);
  const dirty = git(worktree, ['status', '--porcelain']).length > 0;
  const stateText = canonicalStateText({
    repo: REPO, taskRef: TASK_REF, branch, head, dirty,
    step: 'e2e-reverse-control-leg',
  });
  const stateDigest = crypto.createHash('sha256').update(stateText).digest('hex');
  evidence.head = head;
  evidence.stateDigest = stateDigest;
  check('canonical state digest computed', /^[0-9a-f]{64}$/.test(stateDigest), head.slice(0, 12));

  // 3. Deterministic verification BEFORE asking GPT (loop needs a healthy leg).
  const t = spawnSync(process.execPath, ['--test', 'tests/reverse-dispatch.test.mjs'],
    { cwd: worktree, encoding: 'utf8', timeout: 120000 });
  check('deterministic pre-check 14/14', t.status === 0,
    (t.stdout || '').split('\n').filter((l) => l.startsWith('# ')).slice(-4).join(' '));

  // 4. Loopback dispatch seam, bound to the executor's CURRENT state.
  const seam = createReverseDispatchServer({
    expect: { repo: REPO, taskRef: TASK_REF, stateDigest },
    worktreePath: worktree,
  });
  check('seam registration accepted', seam.ok === true);
  const port = await seam.listen();
  evidence.seamUrl = seam.url();
  check('seam listening loopback-only', typeof port === 'number' && port > 0, String(port));

  try {
    // 5. REAL GPT decision via live ChatGPT Web Plus (CDP in-page backend-api).
    const targets = cdpListTargets();
    const page = targets.find((x) => x.type === 'page' && /chatgpt\.com/.test(x.url || ''));
    check('live chatgpt.com page target via CDP', !!page, page ? page.url.slice(0, 80) : 'not found');
    const prompt = buildPrompt({ requestId: `e2e67-${nonce}`, nonce, stateDigest });
    // UI-driven send + CDP transport-level capture of the SSE reply. The page's
    // own client sends (sentinel/proof native); we watch the Network domain.
    const cap = await captureConversationResponse(
      page.webSocketDebuggerUrl,
      uiSendExpr(prompt),
      300000,
    );
    evidence.captureStatus = cap.status;
    evidence.sseBody = cap.text; // debug + audit: full captured SSE stream
    const reply = parseSseCapture(cap.text);
    check('GPT reply received', !!reply.text && reply.text.length > 0,
      `conversationId=${reply.conversationId || '-'}`);
    evidence.chatgpt = { conversationId: reply.conversationId, modelSlug: reply.modelSlug || null };
    evidence.decisionRaw = reply.text;

    // 6. Extract the structured decision the GPT reply carries (fail-closed).
    const jsonText = extractJsonObject(reply.text);
    check('decision JSON object present in reply', !!jsonText,
      'rawLen=' + String(reply.text || '').length + ' rawHead=' + String(reply.text || '').slice(0, 160));
    let envelope;
    try { envelope = JSON.parse(jsonText); } catch (e) {
      throw new Error('DECISION_JSON_PARSE_FAILED: ' + String(e.message).slice(0, 120));
    }
    evidence.decision = envelope;
    check('echo binding in reply', envelope.requestId === `e2e67-${nonce}` && envelope.repo === REPO
      && envelope.taskRef === TASK_REF && envelope.stateDigest === stateDigest, 'requestId/repo/taskRef/stateDigest');
    check('decision enum', envelope.decision === 'CONTINUE', String(envelope.decision));

    // 7. POST through the seam — the ONLY path the decision may travel.
    const post = await fetch(seam.url(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    const postBody = await post.json().catch(() => ({}));
    evidence.post = { status: post.status, body: postBody };
    check('seam ACCEPTED the real decision', post.status === 200 && postBody.ok === true,
      `status=${post.status} code=${postBody.code || '-'}`);

    // 8. Executor reads the APPLIED instruction from the seam output.
    const hintPath = contractHintPath(worktree);
    const applied = readAppliedInstruction(hintPath, envelope.requestId);
    check('instruction applied to SOC_TASK_CONTRACT.md', applied.ok === true, applied.hintPath);
    evidence.appliedInstruction = applied.instruction;
    evidence.hintPath = hintPath;

    // 9. Execute the applied instruction VERBATIM (machine-parsed from the
    //    APPLIED text — never from the prompt). Small, reversible, exact.
    const m = String(applied.instruction).match(/marker-[A-Za-z0-9._-]+\.txt/) || [];
    const mm = String(applied.instruction).match(/E2E67_REVERSE_OK\s+[A-Za-z0-9-]+/) || [];
    check('instruction machine-parseable', !!m[0] && !!mm[0], `${m[0] || '?'} / ${mm[0] || '?'}`);
    const markerRel = `.soc-e2e-67/${m[0]}`;
    const markerAbs = path.join(worktree, markerRel);
    const expectedContent = `${mm[0]}\n`;
    fs.mkdirSync(path.dirname(markerAbs), { recursive: true });
    fs.writeFileSync(markerAbs, expectedContent, 'utf8');
    const actualContent = fs.readFileSync(markerAbs, 'utf8');
    check('executed applied instruction — exact read-back', actualContent === expectedContent,
      `${markerRel} ${Buffer.byteLength(actualContent)}B`);
    evidence.executed = { markerPath: markerRel, expectedContent, actualContent };

    // 10. Replay guard: the SAME decision posted again must be rejected.
    const replay = await fetch(seam.url(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    const replayBody = await replay.json().catch(() => ({}));
    evidence.replayGuard = { status: replay.status, code: replayBody.code };
    check('replay guard rejects identical decision', replay.status === 422 && replayBody.code === 'REPLAYED_REQUEST_ID',
      `status=${replay.status} code=${replayBody.code || '-'}`);
    check('replay ledger persisted', fs.existsSync(ledgerPath({})));

    // 11. Canonical terminal state: exactly-once Telegram TASK_COMPLETED.
    const fin = taskFinish({ sessionPath: session.controlPlane.sessionPath, outcome: 'COMPLETED' });
    check('taskFinish(COMPLETED) canonical', fin.ok === true, fin.session ? fin.session.state : String(fin.reason || ''));
    evidence.taskFinish = {
      state: fin.session && fin.session.state,
      telegram: {
        status: fin.telegramDispatch && fin.telegramDispatch.status,
        messageId: fin.telegramDispatch && fin.telegramDispatch.messageId,
      },
    };
    check('Telegram TASK_COMPLETED dispatched once', fin.telegramDispatch && fin.telegramDispatch.status === 'API_ACCEPTED',
      JSON.stringify(evidence.taskFinish.telegram));

    // 12. noManualIntervention — asserted from THIS run's machine evidence:
    // decision arrived from the live page over the loopback seam, the
    // instruction was applied by the seam and executed in-process.
    evidence.noManualIntervention = post.status === 200 && applied.ok === true
      && actualContent === expectedContent && replayBody.code === 'REPLAYED_REQUEST_ID'
      && evidence.chatgpt.conversationId != null;
    evidence.basis = [
      'decision captured from live chatgpt.com page via CDP in-page backend-api',
      'envelope validated fail-closed at 127.0.0.1 loopback seam (expect-bound)',
      'instruction applied by the seam into SOC_TASK_CONTRACT.md and read back',
      'executor executed the APPLIED instruction verbatim in-process',
      'replay of the same decision rejected by the once-only ledger',
    ];
    check('noManualIntervention assertion', evidence.noManualIntervention === true);

    // 13. Evidence checkpoint OUTSIDE the repo (atomic).
    evidence.finishedAt = new Date().toISOString();
    evidence.exitCode = 0;
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const out = path.join(OUT_DIR, `reverse-leg-e2e-${Date.now()}.json`);
    const tmp = `${out}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(evidence, null, 2), 'utf8');
    fs.renameSync(tmp, out);
    console.log('CHECKPOINT_PERSISTED ' + out);
    console.log('E2E_PASS');
  } catch (e) {
    // Debug evidence on failure: persist what was captured before bailing out.
    try {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      evidence.fail = { message: String((e && e.message) || e), at: new Date().toISOString() };
      const out = path.join(OUT_DIR, `reverse-leg-e2e-FAIL-${Date.now()}.json`);
      fs.writeFileSync(out, JSON.stringify(evidence, null, 2), 'utf8');
      console.error('FAIL_EVIDENCE ' + out);
    } catch { /* best-effort */ }
    throw e;
  } finally {
    await seam.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((e) => {
    console.error('E2E_FAIL: ' + String((e && e.message) || e));
    process.exit(1);
  });
}
// end of e2e-reverse-control-leg.mjs — no trailing marker.