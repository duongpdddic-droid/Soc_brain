import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HttpAgent, EventSchemas } from '@ag-ui/client';

test('real HttpAgent consumes loopback SSE without terminalizing fixture task', async () => {
  const received = [];
  const state = { source: 'FIXTURE', taskId: 'fixture-alpha', canonicalState: 'SESSION_ACTIVE' };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    received.push({ method: req.method, path: req.url, input });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    for (const event of [
      { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId },
      { type: 'STATE_SNAPSHOT', snapshot: state },
      { type: 'CUSTOM', name: 'task.log', value: { taskId: state.taskId, text: 'hello', source: 'FIXTURE' } },
      { type: 'TEXT_MESSAGE_START', messageId: 'hello-1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'hello-1', delta: 'hello fixture-alpha' },
      { type: 'TEXT_MESSAGE_END', messageId: 'hello-1' },
      { type: 'RUN_FINISHED', threadId: input.threadId, runId: input.runId },
    ]) res.write(`data: ${JSON.stringify(EventSchemas.parse(event))}\n\n`);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/hello`;
    const agent = new HttpAgent({ url, threadId: 'fixture-alpha' });
    const events = [];
    agent.subscribe({ onEvent: ({ event }) => { events.push(event); } });
    agent.addMessage({ id: 'ping-1', role: 'user', content: 'ping' });
    await agent.runAgent();
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].input.messages[0].content, 'ping');
    assert.deepEqual(agent.state, state);
    assert.equal(agent.messages.at(-1).content, 'hello fixture-alpha');
    assert.ok(events.some(e => e.type === 'CUSTOM' && e.name === 'task.log'));
    assert.equal(events.at(-1).type, 'RUN_FINISHED');
    assert.equal(agent.state.canonicalState, 'SESSION_ACTIVE');
    assert.ok(!events.some(e => e.type === 'TASK_COMPLETED' || e.name === 'TASK_COMPLETED'));
    console.log(JSON.stringify({ url, transport: 'SSE', client: '@ag-ui/client@0.0.59', eventCount: events.length, canonicalState: agent.state.canonicalState }));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
