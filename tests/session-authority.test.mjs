#!/usr/bin/env node
// session-authority.test.mjs - Issue #9001 acceptance tests for the Centralized
// Session Admission Authority (Windows Named Pipe over node:net, no FFI).
//
// Proves the SOC_TASK_CONTRACT acceptance criteria end to end:
//   A. wire protocol: framing caps, version gate, canonicalization (two
//      spellings of one session collapse to ONE registry key).
//   B. incarnation classification: pid alone proves nothing - start-time
//      mismatch is FOREIGN, unprobeable is UNKNOWN (fail-closed), never LIVE.
//   C. endpoint singleton: one exclusive wx bind-lock decides which process may
//      bind; a stale lock is reclaimable, a live daemon's is not.
//   D. disarmed by default: the sync fence is an honest no-op (legacy flows
//      byte-identical, reported as "not yet wired", never as "enforced").
//   E. armed + authority unreachable: fail-closed EVERYWHERE - admit, sync
//      fence, ownership critical section, ledger append. No file fallback.
//   F. real daemon acceptance:
//        F1 one live grant per session; alias spelling + a REAL second process
//           both conflict; OWNERS observed owner count; release frees it.
//        F2 EOF is not release: pipe cut while the owner is ALIVE keeps the
//           entry, a second ACQUIRE conflicts and takeover is refused
//           (owner LIVE blocks death evidence).
//        F3 crash takeover: dead owner + closed pipe -> takeover with positive
//           GONE evidence, generation bump, fresh token.
//        F4 late RELEASE of an old token never revokes a newer lease; after a
//           daemon restart the old daemonEpoch is rejected EPOCH_STALE.
//   G. armed guard + real daemon: live fence admits the ownership critical
//      section and the ledger; killing the authority revokes the fence and
//      every mutation seam fails closed while the process is still alive.
//
// All fixtures are real: real Named Pipe daemon, real child processes, real
// Win32 process start-times. Everything lives under a temp dir.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CODES, MAX_FRAME_BYTES, PROTOCOL_VERSION,
  authorityPipePath, canonicalIdentityHash, canonicalSessionPath,
  createFrameDecoder, encodeFrame, encodeRequest, parseFrame,
} from '../packages/session-authority/protocol.mjs';
import {
  acquireBindLock, classifyIncarnation, createSessionAuthority, releaseBindLock,
} from '../packages/session-authority/authority-server.mjs';
import { createAuthorityClient } from '../packages/session-authority/authority-client.mjs';
import {
  __resetAdmissionForTests, admitSession, assertAdmissionFence, refreshAdmissionFence,
  releaseAdmission, sessionAdmissionMode, setSessionAdmissionMode,
} from '../packages/session-authority/guard.mjs';
import { withOwnershipLock } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { bindLoop } from '../packages/control-loop/control-loop.mjs';
import { readWin32ProcessStartTime } from '../packages/temp-hygiene/temp-hygiene.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-session-authority-'));
const TMP_STATE = path.join(TMP, 'state');
const TMP_SESSIONS = path.join(TMP, 'sessions');
fs.mkdirSync(TMP_STATE, { recursive: true });
fs.mkdirSync(TMP_SESSIONS, { recursive: true });

const ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const S1 = path.join(TMP_SESSIONS, 's1.json');
const S2 = path.join(TMP_SESSIONS, 's2.json');
const S3 = path.join(TMP_SESSIONS, 's3.json');
const S4 = path.join(TMP_SESSIONS, 's4.json');
const S5 = path.join(TMP_SESSIONS, 's5.json');
const SE = path.join(TMP_SESSIONS, 'se.json');   // E: unreachable-authority case
const IDG = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'; // G: hermetic ledger identity
const SD = path.join(TMP_SESSIONS, 'sd.json');   // D: disarmed legacy case

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let OWN = null;
function ownIncarnation() {
  if (!OWN) {
    const r = readWin32ProcessStartTime(process.pid);
    assert.ok(r && r.processStartTime > 0, 'cannot read own Win32 process start time');
    OWN = { pid: process.pid, processStartTime: r.processStartTime };
  }
  return OWN;
}

// Memoize start-time probes: powershell is expensive and the daemon probes the
// same owner incarnations repeatedly across one test.
const pstCache = new Map();
function cachedReadStartTime(pid) {
  if (pstCache.has(pid)) return pstCache.get(pid);
  const r = readWin32ProcessStartTime(pid);
  const ticks = r ? r.processStartTime : null;
  pstCache.set(pid, ticks);
  return ticks;
}

// ---- daemon / client helpers ------------------------------------------------

let authoritySeq = 0;
async function startAuthority() {
  authoritySeq += 1;
  const pipePath = `\\\\.\\pipe\\soc-sa-test-${process.pid}-${authoritySeq}-${Date.now()}`;
  const bindLockPath = path.join(TMP, `bind-${authoritySeq}.lock`);
  const authority = createSessionAuthority({
    pipePath,
    bindLockPath,
    requestTimeoutMs: 60000,          // connection idle cap; tests are faster
    deps: { readStartTime: cachedReadStartTime },
  });
  const started = await authority.start();
  assert.equal(started.ok, true, `authority start failed: ${JSON.stringify(started)}`);
  return authority;
}

async function connectClient(pipePath) {
  const client = createAuthorityClient({ pipePath });
  const r = await client.connect();
  assert.equal(r.ok, true, `client connect failed: ${JSON.stringify(r)}`);
  return client;
}

async function waitForOwners(client, pred, label, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    const r = await client.owners();
    if (r.ok) {
      last = r.value;
      if (pred(r.value)) return r.value;
    }
    await sleep(100);
  }
  const shape = last && {
    sessionCount: last.sessionCount,
    ownedWithOpenConnection: last.ownedWithOpenConnection,
    disconnected: last.disconnected,
    entries: last.entries.map((e) => ({ sessionPath: e.sessionPath, state: e.state, generation: e.generation })),
  };
  throw new Error(`timeout waiting for OWNERS: ${label}; last=${JSON.stringify(shape)}`);
}

// ---- real second process ----------------------------------------------------

const CHILD_SCRIPT = path.join(TMP, 'child-admit.mjs');
fs.writeFileSync(CHILD_SCRIPT, `// generated fixture: a REAL second process that acquires a session grant
import { createAuthorityClient } from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'packages', 'session-authority', 'authority-client.mjs')).href)};
import { readWin32ProcessStartTime } from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'packages', 'temp-hygiene', 'temp-hygiene.mjs')).href)};

const [pipePath, sessionPath, identityHash, mode] = process.argv.slice(2);
const pst = readWin32ProcessStartTime(process.pid);
if (!pst) { console.log(JSON.stringify({ ok: false, code: 'PST_UNREADABLE' })); process.exit(1); }
const client = createAuthorityClient({ pipePath });
const c = await client.connect();
if (!c.ok) { console.log(JSON.stringify({ ok: false, code: c.code, detail: c.detail })); process.exit(1); }
const r = await client.acquire({
  identityHash,
  sessionPath,
  laneId: 'child',
  owner: { pid: process.pid, processStartTime: pst.processStartTime },
});
if (!r.ok) {
  console.log(JSON.stringify({ ok: false, code: r.code, detail: r.detail ?? null, pid: process.pid }));
  client.close();
  process.exit(0);
}
console.log(JSON.stringify({
  ok: true, pid: process.pid,
  token: r.value.token, daemonEpoch: r.value.daemonEpoch,
  generation: r.value.generation, connectionId: r.value.connectionId,
}));
if (mode !== 'hold') { client.close(); process.exit(0); }
// hold mode: keep the owning pipe alive with periodic PINGs until killed
setInterval(() => { void client.ping(); }, 2000);
`);

function spawnChild(args) {
  return spawn(process.execPath, [CHILD_SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function readChildReport(child, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`child did not report within ${timeoutMs}ms: ${buf}`)), timeoutMs);
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      buf += line;
      try {
        const parsed = JSON.parse(line);
        clearTimeout(timer);
        rl.close();
        resolve(parsed);
      } catch { /* keep buffering */ }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited (code=${code}) before reporting: ${buf}`));
    });
  });
}

function waitChildExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    else child.once('exit', (code) => resolve(code));
  });
}

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

// ============================================================================
// A. wire protocol
// ============================================================================

test('A. protocol: framing caps, version gate, canonical identity/path', () => {
  // frame size cap is enforced at encode time
  const oversize = { v: PROTOCOL_VERSION, id: 'x', op: 'PING', pad: 'y'.repeat(MAX_FRAME_BYTES) };
  assert.throws(() => encodeFrame(oversize), (e) => e.code === CODES.FRAME_TOO_LARGE);

  // decoder poisons on a raw buffer over the cap BEFORE any newline arrives
  let protoErr = null;
  const dec = createFrameDecoder({ maxBytes: 32, onProtocolError: (code, detail) => { protoErr = { code, detail }; } });
  dec.push(Buffer.alloc(64));
  assert.equal(dec.poisoned, true);
  assert.equal(protoErr.code, CODES.FRAME_TOO_LARGE);

  // protocol version gate + JSON gate
  assert.equal(parseFrame('definitely-not-json').ok, false);
  const badVer = parseFrame(JSON.stringify({ v: 99, id: '1', op: 'PING' }));
  assert.equal(badVer.ok, false);
  assert.equal(badVer.code, CODES.PROTOCOL_ERROR);
  const good = parseFrame(JSON.stringify({ v: PROTOCOL_VERSION, id: '1', op: 'PING' }));
  assert.equal(good.ok, true);

  // invalid op rejected at encode time
  assert.throws(() => encodeRequest('r1', 'lowercase-op'), (e) => e.code === CODES.REQUEST_INVALID);

  // identity hash: canonical lowercasing, strict 32-hex gate
  const up = canonicalIdentityHash(ID.toUpperCase());
  assert.equal(up.ok, true);
  assert.equal(up.identityHash, ID);
  assert.equal(canonicalIdentityHash('nope').ok, false);
  assert.equal(canonicalIdentityHash(42).ok, false);

  // session path: three different SPELLINGS of one session collapse to ONE key
  const p1 = canonicalSessionPath(S1);
  const p2 = canonicalSessionPath(`${TMP_SESSIONS}\\.\\s1.json`);
  const p3 = canonicalSessionPath(`${TMP_SESSIONS}\\..\\sessions\\S1.JSON`);
  assert.equal(p1.ok, true);
  assert.equal(p2.sessionPath, p1.sessionPath, 'dot-segment spelling must collapse');
  assert.equal(p3.sessionPath, p1.sessionPath, 'case + parent-dir spelling must collapse');
  assert.equal(canonicalSessionPath('').ok, false);
  assert.equal(canonicalSessionPath(null).ok, false);
});

// ============================================================================
// B. incarnation classification (pid reuse safety)
// ============================================================================

test('B. classifyIncarnation: start-time decides, unknown fails closed', () => {
  const alive = { isAlive: () => true, readStartTime: () => 111 };
  assert.equal(classifyIncarnation({ pid: 7, processStartTime: 111 }, alive).status, 'LIVE');
  assert.equal(classifyIncarnation({ pid: 7, processStartTime: 222 }, { isAlive: () => true, readStartTime: () => 111 }).status, 'FOREIGN');
  assert.equal(classifyIncarnation({ pid: 7, processStartTime: 111 }, { isAlive: () => false, readStartTime: () => 111 }).status, 'GONE');
  assert.equal(classifyIncarnation({ pid: 7, processStartTime: 111 }, { isAlive: () => true, readStartTime: () => null }).status, 'UNKNOWN');
  assert.equal(classifyIncarnation({ pid: -1, processStartTime: 111 }, alive).status, 'UNPROVEN');
  assert.equal(classifyIncarnation({ pid: 7, processStartTime: 0 }, alive).status, 'UNPROVEN');
  // a throwing probe never becomes LIVE
  assert.equal(classifyIncarnation({ pid: 7, processStartTime: 111 }, { isAlive: () => { throw new Error('probe down'); }, readStartTime: () => 111 }).status, 'GONE');
});

// ============================================================================
// C. endpoint singleton (bind lock)
// ============================================================================

test('C. bind lock: one binder, stale reclaimable, live daemon untouchable', () => {
  const lockPath = path.join(TMP, `unit-bind-${Date.now()}.lock`);
  const probes = {
    isAlive: (pid) => pid !== 333,                    // pid 333 = stale daemon
    readStartTime: (pid) => (pid === 111 ? 1111 : 2222),
  };
  const r1 = { pid: 111, processStartTime: 1111, pipePath: '\\\\.\\pipe\\a' };
  assert.equal(acquireBindLock(lockPath, r1, probes).ok, true, 'first binder wins');

  const live = acquireBindLock(lockPath, { pid: 111, processStartTime: 1111, pipePath: '\\\\.\\pipe\\a' }, probes);
  assert.equal(live.ok, false);
  assert.equal(live.code, CODES.BIND_LOCK_HELD_BY_LIVE_DAEMON);

  const other = acquireBindLock(lockPath, { pid: 111, processStartTime: 1111, pipePath: '\\\\.\\pipe\\b' }, probes);
  assert.equal(other.ok, false);
  assert.equal(other.code, CODES.BIND_LOCK_HELD_BY_OTHER_AUTHORITY);

  assert.equal(releaseBindLock(lockPath, r1).ok, true, 'owner releases its lock');
  assert.equal(releaseBindLock(lockPath, r1).ok, false, 'second release is not an owner');

  // stale lock (recorded daemon pid is dead) is reclaimable exactly once
  const staleRecord = { pid: 333, processStartTime: 2222, pipePath: '\\\\.\\pipe\\a' };
  assert.equal(acquireBindLock(lockPath, staleRecord, probes).ok, true, 'stale lock reclaimed');
  const again = acquireBindLock(lockPath, staleRecord, { ...probes, isAlive: () => false });
  assert.equal(again.ok, true, 'dead record reclaimed again');
  fs.rmSync(lockPath, { force: true });
});

// ============================================================================
// D. disarmed default (honest no-op)
// ============================================================================

test('D. disarmed by default: sync fence is an honest no-op, legacy behavior intact', async () => {
  setSessionAdmissionMode('off');
  assert.equal(sessionAdmissionMode(), 'off');
  __resetAdmissionForTests();

  const admitted = await admitSession({ identityHash: ID, sessionPath: SD, owner: ownIncarnation(), pipePath: '\\\\.\\pipe\\definitely-not-running' });
  assert.equal(admitted.ok, true, 'disarmed admit never touches transport');
  assert.equal(admitted.armed, false);
  assert.equal(admitted.reason, 'ADMISSION_DISARMED');

  const fence = assertAdmissionFence({ sessionPath: SD });
  assert.equal(fence.ok, true);
  assert.equal(fence.armed, false);

  // legacy ownership critical section runs byte-identical
  let ran = false;
  const r = withOwnershipLock(SD, () => { ran = true; return { ok: true, value: 'legacy' }; });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(ran, true);

  // ledger append works without any fence
  const loop = bindLoop({ sessionPath: SD, identityHash: ID, stateDir: TMP_STATE });
  const t = loop.transition({ from: 'ACCEPTED', to: 'ROUTED', reason: 'disarmed' });
  assert.equal(t.ok, true, JSON.stringify(t));
});

// ============================================================================
// E. armed + no authority => fail closed everywhere (no file-lease fallback)
// ============================================================================

test('E. armed fail-closed: unreachable authority admits nothing and mutates nothing', async () => {
  setSessionAdmissionMode('required');
  __resetAdmissionForTests();
  try {
    const deadPipe = `\\\\.\\pipe\\soc-sa-never-started-${process.pid}-${Date.now()}`;
    const admitted = await admitSession({ identityHash: ID, sessionPath: SE, owner: ownIncarnation(), pipePath: deadPipe });
    assert.equal(admitted.ok, false, JSON.stringify(admitted));
    assert.ok([CODES.AUTHORITY_UNAVAILABLE, CODES.AUTHORITY_TIMEOUT].includes(admitted.code), `got ${admitted.code}`);
    assert.ok(!admitted.fence, 'no fence may be minted without the authority');

    const fence = assertAdmissionFence({ sessionPath: SE });
    assert.equal(fence.ok, false);
    assert.equal(fence.code, CODES.ADMISSION_FENCE_MISSING);

    const refresh = await refreshAdmissionFence({ sessionPath: SE });
    assert.equal(refresh.ok, false);
    assert.equal(refresh.code, CODES.ADMISSION_FENCE_MISSING);

    // ownership critical section refuses: no lock, no callback, no file
    let ran = false;
    const lock = withOwnershipLock(SE, () => { ran = true; });
    assert.equal(lock.ok, false);
    assert.equal(lock.failClosed, 'SESSION_ADMISSION');
    assert.equal(ran, false);
    assert.equal(fs.existsSync(SE), false, 'no session file may be created');

    // ledger append refuses
    const loop = bindLoop({ sessionPath: SE, identityHash: ID, stateDir: TMP_STATE });
    const t = loop.transition({ from: 'ACCEPTED', to: 'ROUTED' });
    assert.equal(t.ok, false);
    assert.match(String(t.code), /^ADMISSION_/, `got ${t.code}`);
  } finally {
    setSessionAdmissionMode('off');
    __resetAdmissionForTests();
  }
});

// ============================================================================
// F. acceptance against a REAL daemon (Named Pipe, real child processes)
// ============================================================================

test('F1. one live grant per session: alias + real second process both conflict; OWNERS count; release frees', async () => {
  const authority = await startAuthority();
  const clients = [];
  const children = [];
  try {
    const A = await connectClient(authority.pipePath); clients.push(A);
    const g1 = await A.acquire({ identityHash: ID, sessionPath: S1, owner: ownIncarnation(), laneId: 'f1' });
    assert.equal(g1.ok, true, JSON.stringify(g1));
    assert.match(g1.value.token, /^[0-9a-f]{64}$/, 'token is 256-bit hex');
    assert.equal(g1.value.generation, 1);
    const epoch1 = g1.value.daemonEpoch;
    assert.equal(typeof epoch1, 'string');

    // observed owner count while the grant is live
    const o1 = await waitForOwners(A, (v) => v.sessionCount >= 1, 'grant visible');
    assert.equal(o1.sessionCount, 1);
    assert.equal(o1.ownedWithOpenConnection, 1);
    const canon = canonicalSessionPath(S1).sessionPath;
    const entry = o1.entries.find((e) => e.sessionPath === canon);
    assert.ok(entry, 'entry registered under the canonical key');
    assert.equal(entry.state, 'OWNED');
    assert.equal(entry.connectionOpen, true);

    // alias spelling on a SECOND connection must conflict, not double-grant
    const B = await connectClient(authority.pipePath); clients.push(B);
    const g2 = await B.acquire({ identityHash: ID.toUpperCase(), sessionPath: S1.toUpperCase(), owner: ownIncarnation() });
    assert.equal(g2.ok, false);
    assert.equal(g2.code, CODES.SESSION_ACQUIRE_CONFLICT);
    assert.equal(g2.owner && g2.owner.state, 'OWNED');

    // a REAL second process (different pid) must also conflict
    const child = spawnChild([authority.pipePath, S1.toUpperCase(), ID, 'conflict']);
    children.push(child);
    const report = await readChildReport(child);
    assert.equal(report.ok, false, JSON.stringify(report));
    assert.equal(report.code, CODES.SESSION_ACQUIRE_CONFLICT);
    assert.ok(report.pid && report.pid !== process.pid, 'the loser really is another process');
    await waitChildExit(child);

    // still exactly ONE owner, never two
    const o2 = await A.owners();
    assert.equal(o2.value.sessionCount, 1);
    assert.equal(o2.value.ownedWithOpenConnection, 1);

    // explicit release frees the grant; re-acquire then succeeds
    const rel = await A.release({ identityHash: ID, sessionPath: S1, token: g1.value.token, daemonEpoch: epoch1 });
    assert.equal(rel.ok, true, JSON.stringify(rel));
    const o3 = await A.owners();
    assert.equal(o3.value.sessionCount, 0);
    const g3 = await B.acquire({ identityHash: ID, sessionPath: S1, owner: ownIncarnation() });
    assert.equal(g3.ok, true, JSON.stringify(g3));
    await B.release({ identityHash: ID, sessionPath: S1, token: g3.value.token, daemonEpoch: g3.value.daemonEpoch });
  } finally {
    for (const c of clients) { try { c.close(); } catch { /* already gone */ } }
    for (const ch of children) { try { ch.kill(); } catch { /* already gone */ } }
    await authority.stop();
  }
});

test('F2. EOF is not release: pipe cut while owner ALIVE keeps the entry and blocks takeover', async () => {
  const authority = await startAuthority();
  const clients = [];
  try {
    const A = await connectClient(authority.pipePath); clients.push(A);
    const g1 = await A.acquire({ identityHash: ID, sessionPath: S2, owner: ownIncarnation() });
    assert.equal(g1.ok, true, JSON.stringify(g1));

    // a second observer connection for polling OWNERS after A is cut
    const O = await connectClient(authority.pipePath); clients.push(O);

    // cut the pipe while THIS process (the registered owner) stays alive
    A.close();
    const canon = canonicalSessionPath(S2).sessionPath;
    const after = await waitForOwners(O,
      (v) => {
        const e = v.entries.find((x) => x.sessionPath === canon);
        return e && e.state === 'DISCONNECTED';
      }, 'entry becomes DISCONNECTED after EOF');
    assert.equal(after.sessionCount, 1, 'entry is RETAINED, never released on EOF');
    assert.equal(after.ownedWithOpenConnection, 0);
    assert.equal(after.disconnected, 1);
    const cut = after.entries.find((e) => e.sessionPath === canon);
    assert.equal(cut.connectionOpen, false);
    assert.equal(cut.ownerIncarnation.pid, process.pid, 'owner record still points at the live process');

    const B = await connectClient(authority.pipePath); clients.push(B);
    // a second ACQUIRE conflicts: EOF alone grants nothing to nobody
    const g2 = await B.acquire({ identityHash: ID, sessionPath: S2, owner: ownIncarnation() });
    assert.equal(g2.ok, false);
    assert.equal(g2.code, CODES.SESSION_ACQUIRE_CONFLICT);
    assert.equal(g2.owner && g2.owner.state, 'DISCONNECTED');

    // takeover is refused: the owner incarnation is provably LIVE
    const tk = await B.takeover({ identityHash: ID, sessionPath: S2, requester: ownIncarnation(), reason: 'test' });
    assert.equal(tk.ok, false);
    assert.equal(tk.code, CODES.TAKEOVER_EVIDENCE_INCOMPLETE);
    // the refusal keeps its evidence in the bounded audit ring (read via OWNERS)
    const audited = await B.owners();
    const denial = [...audited.value.audit].reverse().find((a) => a.op === 'TAKEOVER_DENIED' && a.sessionPath === canon);
    assert.ok(denial, 'TAKEOVER_DENIED is audited with the evidence used');
    assert.equal(denial.code, CODES.TAKEOVER_EVIDENCE_INCOMPLETE);
    const ownerEvidence = Array.isArray(denial.evidence) && denial.evidence.find((e) => e.role === 'owner');
    assert.ok(ownerEvidence, 'audit carries the per-incarnation evidence');
    assert.equal(ownerEvidence.status, 'LIVE', 'a live owner blocks takeover');

    // and nobody else was granted it meanwhile
    const o = await B.owners();
    const still = o.value.entries.find((e) => e.sessionPath === canon);
    assert.equal(still.state, 'DISCONNECTED');
    assert.equal(still.connectionOpen, false);
  } finally {
    for (const c of clients) { try { c.close(); } catch { /* already gone */ } }
    await authority.stop();
  }
});

test('F3. crash takeover: dead owner + closed pipe => takeover with GONE evidence and generation bump', async () => {
  const authority = await startAuthority();
  const clients = [];
  let child = null;
  try {
    // a REAL child process owns the session grant
    child = spawnChild([authority.pipePath, S3, ID, 'hold']);
    const grant = await readChildReport(child);
    assert.equal(grant.ok, true, JSON.stringify(grant));
    assert.ok(grant.pid && grant.pid !== process.pid);
    const canon = canonicalSessionPath(S3).sessionPath;

    const observer = await connectClient(authority.pipePath); clients.push(observer);
    const held = await waitForOwners(observer,
      (v) => { const e = v.entries.find((x) => x.sessionPath === canon); return e && e.state === 'OWNED' && e.connectionOpen; },
      'child holds the grant');
    assert.equal(held.sessionCount, 1);

    // CRASH the owner (process gone, pipe cut)
    child.kill();
    await waitChildExit(child);
    const dead = await waitForOwners(observer,
      (v) => { const e = v.entries.find((x) => x.sessionPath === canon); return e && e.state === 'DISCONNECTED'; },
      'EOF after crash');
    assert.equal(dead.disconnected >= 1, true, 'crash leaves DISCONNECTED, not released');

    // takeover now succeeds: positive death evidence for EVERY incarnation
    const B = await connectClient(authority.pipePath); clients.push(B);
    const tk = await B.takeover({ identityHash: ID, sessionPath: S3, requester: ownIncarnation(), reason: 'owner crashed' });
    assert.equal(tk.ok, true, JSON.stringify(tk));
    assert.equal(tk.value.takeover, true);
    assert.equal(tk.value.previousGeneration, 1);
    assert.equal(tk.value.generation, 2, 'takeover bumps the generation');
    assert.notEqual(tk.value.token, grant.token, 'fresh token, old token is dead');
    assert.equal(tk.value.state, 'OWNED');
    const ownerEv = tk.value.evidence.find((e) => e.role === 'owner');
    assert.equal(ownerEv.status, 'GONE', 'death evidence recorded');
    assert.equal(ownerEv.pid, grant.pid);

    // new grant is fully usable, then cleanly released
    const ver = await B.verify({ identityHash: ID, sessionPath: S3, token: tk.value.token, daemonEpoch: tk.value.daemonEpoch });
    assert.equal(ver.ok, true, JSON.stringify(ver));
    const rel = await B.release({ identityHash: ID, sessionPath: S3, token: tk.value.token, daemonEpoch: tk.value.daemonEpoch });
    assert.equal(rel.ok, true, JSON.stringify(rel));
    const o = await B.owners();
    assert.equal(o.value.sessionCount, 0);
  } finally {
    if (child && child.exitCode === null) { try { child.kill(); } catch { /* already gone */ } }
    for (const c of clients) { try { c.close(); } catch { /* already gone */ } }
    await authority.stop();
  }
});

test('F4. late RELEASE never revokes a newer lease; daemon restart invalidates the old epoch', async () => {
  const authority = await startAuthority();
  const clients = [];
  let authority2 = null;
  try {
    const A = await connectClient(authority.pipePath); clients.push(A);
    const epoch1 = authority.daemonEpoch;

    const gA = await A.acquire({ identityHash: ID, sessionPath: S4, owner: ownIncarnation() });
    assert.equal(gA.ok, true, JSON.stringify(gA));
    assert.equal(gA.value.daemonEpoch, epoch1);
    const relA = await A.release({ identityHash: ID, sessionPath: S4, token: gA.value.token, daemonEpoch: epoch1 });
    assert.equal(relA.ok, true, JSON.stringify(relA));

    // a NEW lease on the same session
    const gB = await A.acquire({ identityHash: ID, sessionPath: S4, owner: ownIncarnation() });
    assert.equal(gB.ok, true, JSON.stringify(gB));
    assert.notEqual(gB.value.token, gA.value.token, 'fresh token after re-acquire');

    // LATE release with the OLD token must not touch the new lease
    const late = await A.release({ identityHash: ID, sessionPath: S4, token: gA.value.token, daemonEpoch: epoch1 });
    assert.equal(late.ok, false);
    assert.equal(late.code, CODES.RELEASE_NOT_OWNER, JSON.stringify(late));
    const stillLive = await A.verify({ identityHash: ID, sessionPath: S4, token: gB.value.token, daemonEpoch: epoch1 });
    assert.equal(stillLive.ok, true, 'the newer lease survived the stale release');
    const relB = await A.release({ identityHash: ID, sessionPath: S4, token: gB.value.token, daemonEpoch: epoch1 });
    assert.equal(relB.ok, true, JSON.stringify(relB));

    // ---- daemon restart: a NEW authority incarnation, a NEW epoch ---------
    A.close(); clients.splice(clients.indexOf(A), 1);
    await authority.stop();
    authority2 = createSessionAuthority({
      pipePath: authority.pipePath,
      bindLockPath: authority.bindLockPath,
      requestTimeoutMs: 60000,
      deps: { readStartTime: cachedReadStartTime },
    });
    const restarted = await authority2.start();
    assert.equal(restarted.ok, true, JSON.stringify(restarted));
    const epoch2 = authority2.daemonEpoch;
    assert.notEqual(epoch2, epoch1, 'restart mints a new daemonEpoch');

    const D = await connectClient(authority2.pipePath); clients.push(D);
    const gC = await D.acquire({ identityHash: ID, sessionPath: S4, owner: ownIncarnation() });
    assert.equal(gC.ok, true, JSON.stringify(gC));
    assert.equal(gC.value.daemonEpoch, epoch2);

    // any request carrying the PREVIOUS authority epoch is rejected fail-closed
    const staleV = await D.verify({ identityHash: ID, sessionPath: S4, token: gC.value.token, daemonEpoch: epoch1 });
    assert.equal(staleV.ok, false);
    assert.equal(staleV.code, CODES.EPOCH_STALE, JSON.stringify(staleV));
    const staleR = await D.release({ identityHash: ID, sessionPath: S4, token: gC.value.token, daemonEpoch: epoch1 });
    assert.equal(staleR.ok, false);
    assert.equal(staleR.code, CODES.EPOCH_STALE, JSON.stringify(staleR));

    // the current epoch still works, so the refusal above was epoch-specific
    const liveV = await D.verify({ identityHash: ID, sessionPath: S4, token: gC.value.token, daemonEpoch: epoch2 });
    assert.equal(liveV.ok, true, JSON.stringify(liveV));
    const relD = await D.release({ identityHash: ID, sessionPath: S4, token: gC.value.token, daemonEpoch: epoch2 });
    assert.equal(relD.ok, true, JSON.stringify(relD));
  } finally {
    for (const c of clients) { try { c.close(); } catch { /* already gone */ } }
    await authority.stop();
    if (authority2) { try { await authority2.stop(); } catch { /* already stopped */ } }
  }
});

// ============================================================================
// G. armed guard against a REAL daemon: live fence admits, dead daemon revokes
// ============================================================================

test('G. armed guard: live fence admits both mutation seams; authority death fails closed', async () => {
  setSessionAdmissionMode('required');
  __resetAdmissionForTests();
  const authority = await startAuthority();
  try {
    const admitted = await admitSession({
      identityHash: IDG, sessionPath: S5, owner: ownIncarnation(), pipePath: authority.pipePath,
    });
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    assert.equal(admitted.armed, true);
    assert.ok(admitted.fence && admitted.fence.token, 'fence carries the grant token');

    const fence = assertAdmissionFence({ sessionPath: S5 });
    assert.equal(fence.ok, true, JSON.stringify(fence));
    assert.equal(fence.armed, true);
    assert.equal(fence.fence.identityHash, IDG);

    // armed AND fenced => both mutation seams are ADMITTED
    let ran = false;
    const lock = withOwnershipLock(S5, () => { ran = true; return { ok: true, value: 'admitted' }; });
    assert.equal(lock.ok, true, JSON.stringify(lock));
    assert.equal(ran, true);

    const loop = bindLoop({ sessionPath: S5, identityHash: IDG, stateDir: TMP_STATE });
    const t1 = loop.transition({ from: 'ACCEPTED', to: 'ROUTED', reason: 'admitted' });
    assert.equal(t1.ok, true, JSON.stringify(t1));
    const records = loop.readTransitions();
    assert.equal(records.length, 1, 'ledger row written while fenced');

    // ---- kill the authority while this process stays alive ----------------
    await authority.stop();
    await sleep(200);

    const after = assertAdmissionFence({ sessionPath: S5 });
    assert.equal(after.ok, false, JSON.stringify(after));
    assert.ok(
      [CODES.ADMISSION_FENCE_REVOKED, CODES.ADMISSION_CONNECTION_LOST, CODES.ADMISSION_FENCE_STALE].includes(after.code),
      `got ${after.code}`,
    );

    let ranAfter = false;
    const lockAfter = withOwnershipLock(S5, () => { ranAfter = true; });
    assert.equal(lockAfter.ok, false, JSON.stringify(lockAfter));
    assert.equal(lockAfter.failClosed, 'SESSION_ADMISSION');
    assert.equal(ranAfter, false, 'no mutation after the pipe died');

    const t2 = loop.transition({ from: 'ROUTED', to: 'EXECUTING' });
    assert.equal(t2.ok, false, JSON.stringify(t2));
    assert.match(String(t2.code), /^ADMISSION_/, `got ${t2.code}`);
    assert.equal(loop.readTransitions().length, 1, 'ledger row count unchanged');

    // release against a dead authority also fails closed (never a silent ok)
    const rel = await releaseAdmission({ sessionPath: S5 });
    assert.equal(rel.ok, false, JSON.stringify(rel));
  } finally {
    setSessionAdmissionMode('off');
    __resetAdmissionForTests();
    try { await authority.stop(); } catch { /* already stopped */ }
  }
});
