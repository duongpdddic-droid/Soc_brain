import http from 'node:http';
import { createFixture } from './adapter.mjs';

const fixture = createFixture();
const PORT = process.env.PORT || 3210;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  res.write('data: {"type":"STATE_SNAPSHOT","snapshot":' + JSON.stringify(fixture.snapshot()) + '}

');
  const interval = setInterval(() => {
    fixture.tick();
    res.write('data: {"type":"CUSTOM","name":"task.progress","value":' + JSON.stringify(fixture.snapshot().tasks[0].timeline.at(-1)) + '}

');
  }, 5000);
  req.on('close', () => clearInterval(interval));
});

server.listen(PORT, '127.0.0.1', () => console.log(`AG-UI fixture server on http://127.0.0.1:${PORT}`));
