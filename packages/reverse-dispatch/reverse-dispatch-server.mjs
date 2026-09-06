#!/usr/bin/env node
// reverse-dispatch-server.mjs — Soc_brain reverse control leg, loopback seam
// (Issue #67). Binds 127.0.0.1 ONLY (never LAN). POST /decision with a JSON
// decision envelope → fail-closed validate → apply to the registered binding
// (SOC_TASK_CONTRACT.md DATA append). Every rejection is telemetry-recorded
// (bounded JSONL) so malformed tool-calls stay observable without expanding
// the Progress Monitor.
//
// Run: node reverse-dispatch-server.mjs  (expects registration via argv JSON)
//   argv[2] = JSON { expect, worktreePath, stateDir? }
// Exits non-zero on bad registration — fail-closed startup.
//
// ponytail: node:http + hand-rolled routing (house style); swap for the
// Decision Router's transport when it exists.

import http from 'node:http';
import { validateGptDecision, recordTelemetry, DECISION_MAX_BYTES } from './reverse-dispatch.mjs';
import { applyValidatedDecision } from './reverse-waiter.mjs';

export function createReverseDispatchServer({ expect, worktreePath, stateDir, now, ttlMs } = {}) {
  if (!expect || typeof expect !== 'object') return { ok: false, code: 'EXPECT_MISSING' };
  if (typeof worktreePath !== 'string' || !worktreePath) return { ok: false, code: 'WORKTREE_PATH_MISSING' };
  const server = http.createServer((req, res) => {
    let sent = false;
    const done = (status, body) => {
      if (sent) return;
      sent = true;
      const payload = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
      res.end(payload);
    };
    if (req.url !== '/decision') return done(404, { ok: false, code: 'NOT_FOUND' });
    if (req.method !== 'POST') return done(405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > DECISION_MAX_BYTES) {
        if (!aborted) {
          aborted = true;
          chunks.length = 0;
          recordTelemetry({ kind: 'REJECTED', code: 'BODY_TOO_LARGE', bytes: size }, { stateDir });
          done(413, { ok: false, code: 'BODY_TOO_LARGE', maxBytes: DECISION_MAX_BYTES });
          // Consume/destroy the oversized stream so the client never hangs.
          req.destroy();
        }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      let envelope;
      try {
        envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        recordTelemetry({ kind: 'REJECTED', code: 'ENVELOPE_MALFORMED' }, { stateDir });
        return done(400, { ok: false, code: 'ENVELOPE_MALFORMED', message: 'body must be JSON' });
      }
      const v = validateGptDecision(envelope, expect, { stateDir, now, ttlMs });
      if (!v.ok) return done(422, v);
      const a = applyValidatedDecision(v.envelope, { worktreePath, stateDir });
      if (!a.ok) return done(500, a);
      done(200, { ok: true, idempotent: a.idempotent, hintPath: a.hintPath, appliedAt: a.appliedAt, envelope: v.envelope });
    });
    req.on('error', () => done(400, { ok: false, code: 'ENVELOPE_MALFORMED' }));
  });
  return {
    ok: true,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      // loopback ONLY — the seam must never be reachable off-machine.
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    }),
    close: () => new Promise((resolve) => server.close(() => resolve(true))),
    url: () => {
      const a = server.address();
      return `http://127.0.0.1:${a.port}/decision`;
    },
  };
}

// CLI mode: registration JSON via argv[2].
function main() {
  let reg;
  try {
    reg = JSON.parse(process.argv[2] || '');
  } catch {
    console.error('FAIL registration: argv[2] must be JSON { expect, worktreePath, stateDir? }');
    process.exit(2);
  }
  const s = createReverseDispatchServer(reg);
  if (!s.ok) {
    console.error(`FAIL registration: ${s.code}`);
    process.exit(2);
  }
  s.listen().then((port) => {
    console.log(JSON.stringify({ ok: true, port, url: s.url() }));
  }).catch((e) => {
    console.error(`FAIL listen: ${String((e && e.message) || e)}`);
    process.exit(2);
  });
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('reverse-dispatch-server.mjs')) {
  main();
}