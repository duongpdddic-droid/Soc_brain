import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createSessionAuthority } from '../packages/session-authority/authority-server.mjs';
import { createAuthorityClient } from '../packages/session-authority/authority-client.mjs';
import { CODES } from '../packages/session-authority/protocol.mjs';

test('two OS processes cannot bind the same authority pipe', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-pipe-singleton-'));
  const pipePath = `\\\\.\\pipe\\soc-singleton-${process.pid}-${Date.now()}`;
  const bindLockPath = path.join(dir, 'legacy.lock');
  const script = path.join(dir, 'holder.mjs');
  fs.writeFileSync(script, [
    `import { createSessionAuthority } from ${JSON.stringify(new URL('../packages/session-authority/authority-server.mjs', import.meta.url).href)};`,
    'const s = createSessionAuthority({pipePath:process.argv[2],bindLockPath:process.argv[3]});',
    'try { const r = await s.start(); process.stdout.write(JSON.stringify(r) + "\\n"); }',
    'catch(e) { process.stdout.write(JSON.stringify({ok:false,code:e.code}) + "\\n"); process.exitCode=2; }',
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const child = spawn(process.execPath, [script, pipePath, bindLockPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  try {
    const first = await Promise.race([
      new Promise((resolve, reject) => child.stdout.on('data', (chunk) => {
        out += chunk;
        if (out.includes('\n')) { try { resolve(JSON.parse(out.split('\n')[0])); } catch (e) { reject(e); } }
      })),
      new Promise((_, reject) => setTimeout(() => reject(new Error('authority child did not bind')), 10000)),
    ]);
    assert.equal(first.ok, true, JSON.stringify(first));
    const peer = createSessionAuthority({ pipePath, bindLockPath });
    await assert.rejects(peer.start(), (e) => e.code === CODES.BIND_FAILED);
    assert.equal(child.exitCode, null, 'first authority remains alive');
  } finally {
    child.kill();
    if (child.exitCode === null) await once(child, 'exit');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('authority restores a live owner before accepting a new grant', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-authority-durable-'));
  const pipePath = process.platform === 'win32'
    ? `\\\\.\\pipe\\soc-durable-${process.pid}-${Date.now()}`
    : path.join(dir, 'authority.sock');
  const bindLockPath = path.join(dir, 'legacy-bind.lock');
  const alive = new Map([[111, true], [222, true]]);
  const starts = new Map([[111, 1111], [222, 2222]]);
  const deps = { isAlive: (pid) => alive.get(pid) ?? false, readStartTime: (pid) => starts.get(pid) ?? null };
  const opts = { pipePath, bindLockPath, deps };
  const identityHash = 'a'.repeat(32);
  const sessionPath = path.join(dir, 'session.json');
  let first = null;
  let second = null;
  let client = null;
  try {
    first = createSessionAuthority(opts);
    assert.equal((await first.start()).ok, true);
    client = createAuthorityClient({ pipePath });
    assert.equal((await client.connect()).ok, true);
    const g = await client.acquire({ identityHash, sessionPath, owner: { pid: 111, processStartTime: 1111 } });
    assert.equal(g.ok, true, JSON.stringify(g));
    assert.ok(fs.existsSync(first.snapshotPath), 'grant persisted before reply');
    await first.stop();
    client.close();

    second = createSessionAuthority(opts);
    assert.equal((await second.start()).ok, true);
    client = createAuthorityClient({ pipePath });
    assert.equal((await client.connect()).ok, true);
    const denied = await client.acquire({ identityHash, sessionPath, owner: { pid: 222, processStartTime: 2222 } });
    assert.equal(denied.code, CODES.SESSION_ACQUIRE_CONFLICT);
    const blocked = await client.takeover({ identityHash, sessionPath, requester: { pid: 222, processStartTime: 2222 } });
    assert.equal(blocked.code, CODES.TAKEOVER_EVIDENCE_INCOMPLETE);
    alive.set(111, false);
    const moved = await client.takeover({ identityHash, sessionPath, requester: { pid: 222, processStartTime: 2222 } });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    assert.equal(moved.value.generation, 2);
    assert.notEqual(moved.value.daemonEpoch, g.value.daemonEpoch);
  } finally {
    client?.close();
    if (second) await second.stop();
    if (first && first !== second) await first.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed owner snapshot blocks authority startup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-authority-corrupt-'));
  const pipePath = process.platform === 'win32'
    ? `\\\\.\\pipe\\soc-corrupt-${process.pid}-${Date.now()}`
    : path.join(dir, 'authority.sock');
  const server = createSessionAuthority({ pipePath, bindLockPath: path.join(dir, 'bind.lock') });
  try {
    fs.writeFileSync(server.snapshotPath, '{');
    const result = await server.start();
    assert.equal(result.code, CODES.AUTHORITY_STATE_UNAVAILABLE);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
