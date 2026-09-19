import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture } from './adapter.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3210);
const fixture = createFixture();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8' };
function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function sseSend(res, event) {
  res.write('data: ' + JSON.stringify(event) + '\n\n');
}
function getAgentId(url) {
  const m = url.pathname.match(/\/api\/copilotkit\/agent\/([^/]+)/);
  return m ? m[1] : 'default';
}
function getThreadId(params) {
  const p = new URLSearchParams(params);
  return p.get('threadId') || 'fixture-alpha';
}
function findTask(taskId) {
  if (!taskId || taskId === 'default') return fixture.snapshot().tasks[0] || null;
  return fixture.snapshot().tasks.find(t => t.taskId === taskId);
}
function genId() { return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2); }
function forwardFixtureEvent(res, event) {
  if (event.type === 'CUSTOM') {
    sseSend(res, { type: 'CUSTOM', name: event.name, value: event.value });
  } else if (event.type === 'STATE_SNAPSHOT') {
    sseSend(res, { type: 'STATE_SNAPSHOT', snapshot: event.snapshot });
  } else {
    sseSend(res, event);
  }
}
function handleRun(req, res, taskId, input) {
  const task = findTask(taskId);
  if (!task) { res.writeHead(404); res.end('NOT_FOUND'); return; }
  const threadId = input.threadId || taskId;
  const runId = input.runId || genId();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  sseSend(res, { type: 'RUN_STARTED', threadId, runId });
  sseSend(res, { type: 'STATE_SNAPSHOT', snapshot: fixture.snapshot() });
  const lastUser = Array.isArray(input.messages) ? [...input.messages].reverse().find(m => m.role === 'user') : null;
  const echo = typeof lastUser?.content === 'string' ? lastUser.content.slice(0, 200) : 'ready';
  sseSend(res, { type: 'TEXT_MESSAGE_START', messageId: 'fixture-' + runId, role: 'assistant' });
  sseSend(res, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'fixture-' + runId, delta: 'fixture ' + taskId + ' ack: ' + echo + ' (commands flow through /api/command)' });
  sseSend(res, { type: 'TEXT_MESSAGE_END', messageId: 'fixture-' + runId });
  const live = fixture.snapshot().tasks.find(x => x.taskId === taskId);
  if (live && live.gate && !live.gate.resolved && !input.resume) {
    sseSend(res, { type: 'RUN_FINISHED', threadId, runId, outcome: 'interrupt', interrupts: [{ id: 'gate-' + taskId, type: 'HUMAN_GATE', value: { gate: live.gate, taskId } }] });
  } else {
    sseSend(res, { type: 'RUN_FINISHED', threadId, runId, outcome: 'success' });
  }
  res.end();
}
function handleConnect(req, res, taskId, input) {
  const task = findTask(taskId);
  if (!task) { res.writeHead(404); res.end('NOT_FOUND'); return; }
  const threadId = input.threadId || taskId;
  const runId = input.runId || genId();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  sseSend(res, { type: 'RUN_STARTED', threadId, runId });
  sseSend(res, { type: 'STATE_SNAPSHOT', snapshot: fixture.snapshot() });
  sseSend(res, { type: 'RUN_FINISHED', threadId, runId, outcome: 'success' });
  res.end();
}
function runtimeInfo() {
  const tasks = fixture.snapshot().tasks;
  const agents = {};
  for (const t of tasks) agents[t.taskId] = { description: t.title || t.taskId, capabilities: {} };
  return { version: '0.0.0-fixture', mode: 'sse', agents };
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, MIME['.html'], fs.readFileSync(path.join(here, 'index.html'), 'utf8'));
    }
    if (req.method === 'GET' && url.pathname === '/ui.js') {
      return send(res, 200, MIME['.js'], fs.readFileSync(path.join(here, 'dist', 'ui.js'), 'utf8'));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/copilotkit-styles.css')) {
      const cssPath = path.join(here, 'dist', 'copilotkit-styles.css');
      if (fs.existsSync(cssPath)) {
        return send(res, 200, MIME['.css'], fs.readFileSync(cssPath, 'utf8'));
      }
      return send(res, 404, MIME['.json'], JSON.stringify({ ok: false, error: 'CSS_NOT_FOUND' }));
    }
    if (req.method === 'GET' && url.pathname === '/api/snapshot') {
      return send(res, 200, MIME['.json'], JSON.stringify({ snapshot: fixture.snapshot() }));
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('data: ' + JSON.stringify({ snapshot: fixture.snapshot() }) + '\n\n');
      const unsub = fixture.subscribe((event) => { res.write('data: ' + JSON.stringify(event) + '\n\n'); });
      const heartbeat = setInterval(() => { fixture.tick(); }, 2000);
      req.on('close', () => { clearInterval(heartbeat); unsub(); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/command') {
      const raw = await readBody(req);
      let input;
      try { input = JSON.parse(raw); } catch { return send(res, 400, MIME['.json'], JSON.stringify({ ok: false, error: 'COMMAND_INVALID' })); }
      try {
        const result = fixture.command(input);
        return send(res, 200, MIME['.json'], JSON.stringify({ ok: true, result, snapshot: fixture.snapshot() }));
      } catch (err) { return send(res, 400, MIME['.json'], JSON.stringify({ ok: false, error: err.message })); }
    }
    if (req.method === 'GET' && (url.pathname === '/api/copilotkit/info' || url.pathname === '/api/copilotkit')) {
      return send(res, 200, MIME['.json'], JSON.stringify(runtimeInfo()));
    }
    const runMatch = url.pathname.match(/^\/api\/copilotkit\/agent\/([^/]+)\/run$/);
    if (req.method === 'POST' && runMatch) {
      const raw = await readBody(req);
      let input = {};
      try { input = JSON.parse(raw); } catch {}
      const taskId = runMatch[1] || 'default';
      if (!findTask(taskId)) return send(res, 404, MIME['.json'], JSON.stringify({ ok: false, error: 'TASK_UNKNOWN' }));
      return handleRun(req, res, taskId, input);
    }
    const connectMatch = url.pathname.match(/^\/api\/copilotkit\/agent\/([^/]+)\/connect$/);
    if (req.method === 'POST' && connectMatch) {
      const raw = await readBody(req);
      let input = {};
      try { input = JSON.parse(raw); } catch {}
      const taskId = connectMatch[1] || 'default';
      if (!findTask(taskId)) return send(res, 404, MIME['.json'], JSON.stringify({ ok: false, error: 'TASK_UNKNOWN' }));
      return handleConnect(req, res, taskId, input);
    }
    if (req.method === 'POST' && url.pathname.match(/^\/api\/copilotkit\/agent\/[^/]+\/stop\//)) {
      res.writeHead(204);
      return res.end();
    }
    return send(res, 404, MIME['.json'], JSON.stringify({ ok: false, error: 'NOT_FOUND' }));
  } catch { return send(res, 500, MIME['.json'], JSON.stringify({ ok: false, error: 'SERVER_ERROR' })); }
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write('AG-UI fixture server on http://127.0.0.1:' + PORT + '\n');
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
