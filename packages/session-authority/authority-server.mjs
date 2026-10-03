// authority-server.mjs — the Centralized Session Admission Authority daemon.
//
// ONE process owns ONE canonical Named Pipe endpoint and therefore ONE grant
// registry per (user, machine). Everything here runs on a single event-loop
// turn per frame: parse -> validate -> mutate registry -> reply, with NO await
// between the registry read and the registry write (SOC_TASK_CONTRACT §2).
//
// Registry semantics (§2/§3):
//   * key      = canonical sessionPath, cross-indexed by canonical identityHash
//                so two spellings of one session share ONE entry.
//   * value    = owner incarnation + laneId + random token + daemonEpoch +
//                the OWNING connection + registered worker incarnations.
//   * ACQUIRE never grants a second live connection for one session.
//   * RELEASE requires the exact token AND daemonEpoch AND owning connection.
//   * socket EOF is only an INVESTIGATION signal: the entry becomes
//     DISCONNECTED and is NOT released. Takeover needs positive proof that
//     every incarnation that could still mutate is gone.
//
// The canonical pipe bind is the singleton authority. On Windows libuv binds
// its first server instance with FILE_FLAG_FIRST_PIPE_INSTANCE. A filesystem
// bind-lock is not an ownership primitive (read -> unlink has a TOCTOU gap).

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  CODES, MAX_CONCURRENT_CONNECTIONS, MAX_FRAME_BYTES, OPS, PROTOCOL_VERSION,
  RECEIPT_KINDS, authorityBindLockPath, authorityPipePath, canonicalIdentityHash,
  canonicalSessionPath, createFrameDecoder, encodeFrame, failReply, okReply,
  parseFrame,
} from './protocol.mjs';
import { isAlive as defaultIsAlive, readWin32ProcessStartTime } from '../temp-hygiene/temp-hygiene.mjs';

export const ENTRY_STATE = Object.freeze({ OWNED: 'OWNED', DISCONNECTED: 'DISCONNECTED' });
export const AUDIT_MAX = 1000;

// A snapshot is only accessed by the process that successfully bound the
// canonical endpoint. It is persistence, never a second lock/arbiter.
function ownerSnapshotPath(bindLockPath, pipePath) {
  return path.join(path.dirname(bindLockPath), `owners-${crypto.createHash('sha256').update(pipePath).digest('hex')}.json`);
}

// Durable RECEIPT store (REC-01): same directory and per-pipe hashed naming
// as the owner snapshot (no new state root), append-only history rows that
// outlive the grant they were minted under. The fence TOKEN is never written.
function receiptStorePath(bindLockPath, pipePath) {
  return path.join(path.dirname(bindLockPath), `receipts-${crypto.createHash('sha256').update(pipePath).digest('hex')}.json`);
}

function durableReplace(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx');
    try { fs.writeSync(fd, contents); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    // Do not run a fallible operation after the atomic replacement: callers
    // roll back their registry on failure, which would disagree with a snapshot
    // already published by a successful rename. File contents are fsynced;
    // power-loss durability of the directory rename remains platform-specific.
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* temp only */ }
  }
}

function defaultReadStartTime(pid) {
  const r = readWin32ProcessStartTime(pid);
  return r ? r.processStartTime : null;
}

// Incarnation classification. pid alone proves nothing on Windows: pids are
// recycled. We always compare the immutable Win32 PROCESS_START_TIME, and an
// unprobeable identity is UNKNOWN (fail-closed), never LIVE and never GONE.
export function classifyIncarnation(inc, { isAlive = defaultIsAlive, readStartTime = defaultReadStartTime } = {}) {
  if (!inc || !Number.isInteger(inc.pid) || inc.pid <= 0) return { status: 'UNPROVEN', reason: 'PID_INVALID' };
  if (!Number.isInteger(inc.processStartTime) || inc.processStartTime <= 0) return { status: 'UNPROVEN', reason: 'START_TIME_MISSING' };
  // A THROWING probe is never death evidence. alive=false may only come from
  // an isAlive() that actually returned; an exception means we could not
  // observe liveness at all => UNPROVEN (fail-closed: blocks both ACQUIRE and
  // takeover, exactly like a missing start time).
  let alive;
  try {
    alive = isAlive(inc.pid);
  } catch (e) {
    return { status: 'UNPROVEN', reason: 'ALIVE_PROBE_ERROR', detail: String((e && e.message) || e).slice(0, 200) };
  }
  if (!alive) return { status: 'GONE', reason: 'PID_GONE' };
  // Same rule for the start-time probe: a throw is UNKNOWN (still not LIVE,
  // still not GONE), so a takeover can never ride a broken probe to success.
  let cur = null;
  try {
    cur = readStartTime(inc.pid);
  } catch (e) {
    return { status: 'UNKNOWN', reason: 'START_TIME_PROBE_ERROR', detail: String((e && e.message) || e).slice(0, 200) };
  }
  if (cur == null) return { status: 'UNKNOWN', reason: 'PROBE_UNAVAILABLE' };
  if (cur !== inc.processStartTime) return { status: 'FOREIGN', reason: 'PID_REUSED_FOREIGN', currentStartTime: cur };
  return { status: 'LIVE', reason: 'INCARNATION_ALIVE' };
}

function validIncarnation(i) {
  return Boolean(i) && Number.isInteger(i.pid) && i.pid > 0
    && Number.isInteger(i.processStartTime) && i.processStartTime > 0;
}

function summarizeEntry(e) {
  return {
    identityHash: e.identityHash,
    sessionPath: e.sessionPath,
    laneId: e.laneId ?? null,
    state: e.state,
    connectionOpen: e.connectionOpen,
    owningConnectionId: e.connectionId,
    ownerIncarnation: e.ownerIncarnation,
    workerIncarnations: e.workers.map((w) => ({ incarnation: w.incarnation, connectionId: w.connectionId, attachedAt: w.attachedAt })),
    generation: e.generation,
    grantedAt: e.grantedAt,
    lastVerifyAt: e.lastVerifyAt,
    daemonEpoch: e.daemonEpoch,
  };
}

// ---- bind lock (daemon singleton) ------------------------------------------

// ---- server -----------------------------------------------------------------

export function createSessionAuthority(options = {}) {
  const {
    pipePath = authorityPipePath(),
    bindLockPath = authorityBindLockPath({ override: options.pipeName || null }),
    deps = {},
    now = () => new Date().toISOString(),
    requestTimeoutMs = 5000,
    idleTimeoutMs = 30000,
    maxConnections = MAX_CONCURRENT_CONNECTIONS,
    auditMax = AUDIT_MAX,
    log = null,
  } = options;

  const probe = {
    isAlive: deps.isAlive || defaultIsAlive,
    readStartTime: deps.readStartTime || defaultReadStartTime,
  };

  const daemonEpoch = crypto.randomUUID();
  const snapshotPath = ownerSnapshotPath(bindLockPath, pipePath);
  const receiptsPath = receiptStorePath(bindLockPath, pipePath);
  const state = {
    started: false,
    stopped: false,
    server: null,
    connections: new Map(),          // connectionId -> conn
    sessions: new Map(),             // canonical sessionPath -> entry
    byIdentity: new Map(),           // canonical identityHash -> canonical sessionPath
    audit: [],                       // bounded ring (oldest dropped)
    seq: 0,
    nextConnectionId: 1,
  };

  function emit(line) { if (typeof log === 'function') { try { log(line); } catch { /* observability only */ } } }

  function pushAudit(rec) {
    state.seq += 1;
    state.audit.push({ seq: state.seq, at: now(), daemonEpoch, ...rec });
    while (state.audit.length > auditMax) state.audit.shift();
  }

  function persistOwners() {
    try {
      const entries = [...state.sessions.values()].map((e) => ({
        identityHash: e.identityHash, sessionPath: e.sessionPath,
        laneId: e.laneId, ownerIncarnation: e.ownerIncarnation,
        workers: e.workers, generation: e.generation, grantedAt: e.grantedAt,
      }));
      durableReplace(snapshotPath, `${JSON.stringify({ schemaVersion: 1, pipePath, entries })}\n`);
      return { ok: true };
    } catch (e) {
      return { ok: false, code: CODES.AUTHORITY_STATE_UNAVAILABLE, detail: String((e && e.message) || e) };
    }
  }

  function restoreOwners() {
    let snapshot;
    try { snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')); }
    catch (e) {
      if (e?.code === 'ENOENT') return { ok: true };
      return { ok: false, code: CODES.AUTHORITY_STATE_UNAVAILABLE, detail: 'owner snapshot is unreadable' };
    }
    if (snapshot?.schemaVersion !== 1 || snapshot.pipePath !== pipePath || !Array.isArray(snapshot.entries)) {
      return { ok: false, code: CODES.AUTHORITY_STATE_UNAVAILABLE, detail: 'owner snapshot schema/endpoint mismatch' };
    }
    const sessions = new Map();
    const byIdentity = new Map();
    for (const item of snapshot.entries) {
      const id = canonicalIdentityHash(item?.identityHash);
      const sp = canonicalSessionPath(item?.sessionPath);
      if (!id.ok || !sp.ok || sp.sessionPath !== item.sessionPath
        || !validIncarnation(item.ownerIncarnation) || !Number.isInteger(item.generation)
        || item.generation < 1 || !Array.isArray(item.workers)
        || item.workers.some((w) => !validIncarnation(w?.incarnation))
        || sessions.has(item.sessionPath) || byIdentity.has(item.identityHash)) {
        return { ok: false, code: CODES.AUTHORITY_STATE_UNAVAILABLE, detail: 'owner snapshot contains an invalid or duplicate entry' };
      }
      sessions.set(item.sessionPath, {
        ...item, token: null, daemonEpoch: null, connectionId: null,
        connectionOpen: false, state: ENTRY_STATE.DISCONNECTED,
        lastSeenAt: null, lastVerifyAt: null,
      });
      byIdentity.set(item.identityHash, item.sessionPath);
    }
    state.sessions = sessions;
    state.byIdentity = byIdentity;
    return { ok: true };
  }

  function lookup(identityHashC, sessionPathC) {
    const byPath = state.sessions.get(sessionPathC) || null;
    const mapped = state.byIdentity.get(identityHashC) || null;
    if (byPath && mapped && mapped !== sessionPathC) return { ok: false, code: CODES.IDENTITY_PATH_MISMATCH };
    if (mapped && !byPath) {
      const e = state.sessions.get(mapped) || null;
      if (e && e.identityHash !== identityHashC) return { ok: false, code: CODES.IDENTITY_PATH_MISMATCH };
      return { ok: true, entry: e, sessionPath: mapped };
    }
    if (byPath && byPath.identityHash !== identityHashC) return { ok: false, code: CODES.IDENTITY_PATH_MISMATCH };
    return { ok: true, entry: byPath, sessionPath: sessionPathC };
  }

  // ---- op handlers (ALL synchronous: check+write happen in one turn) -------

  function onAcquire(conn, m) {
    const idc = canonicalIdentityHash(m.identityHash);
    if (!idc.ok) return { ok: false, code: idc.reason, detail: idc.detail ?? null };
    const spc = canonicalSessionPath(m.sessionPath);
    if (!spc.ok) return { ok: false, code: spc.reason, detail: 'sessionPath is not a canonical filesystem path' };
    if (!validIncarnation(m.owner)) {
      return { ok: false, code: CODES.OWNER_IDENTITY_UNPROVEN, detail: 'owner must carry {pid, processStartTime}' };
    }
    const cls = classifyIncarnation(m.owner, probe);
    if (cls.status !== 'LIVE') {
      return { ok: false, code: CODES.OWNER_IDENTITY_UNPROVEN, detail: `owner incarnation is ${cls.status} (${cls.reason})` };
    }
    if (m.laneId !== undefined && m.laneId !== null && (typeof m.laneId !== 'string' || m.laneId.length > 200)) {
      return { ok: false, code: CODES.REQUEST_INVALID, detail: 'laneId must be a short string' };
    }

    const found = lookup(idc.identityHash, spc.sessionPath);
    if (!found.ok) return { ok: false, code: found.code, detail: 'identityHash and sessionPath map to different sessions' };

    const existing = found.entry;
    if (existing) {
      if (existing.connectionId === conn.id) {
        // Same owning connection re-acquiring: idempotent renewal of the ONE
        // grant. Never mints a second token and never adds a second owner.
        existing.lastSeenAt = now();
        pushAudit({ op: 'ACQUIRE_RENEW', identityHash: existing.identityHash, sessionPath: existing.sessionPath, connectionId: conn.id, generation: existing.generation });
        return { ok: true, value: grantValue(existing, { resumed: false, renewed: true }) };
      }
      pushAudit({ op: 'ACQUIRE_DENIED', identityHash: existing.identityHash, sessionPath: existing.sessionPath, connectionId: conn.id, ownerConnectionId: existing.connectionId, ownerState: existing.state });
      return {
        ok: false,
        code: CODES.SESSION_ACQUIRE_CONFLICT,
        detail: 'session already has a registered owner entry; EOF alone is not a takeover',
        owner: summarizeEntry(existing),
      };
    }

    const token = crypto.randomBytes(32).toString('hex');
    const entry = {
      identityHash: idc.identityHash,
      sessionPath: spc.sessionPath,
      laneId: m.laneId ?? null,
      token,
      daemonEpoch,
      connectionId: conn.id,
      connectionOpen: true,
      state: ENTRY_STATE.OWNED,
      ownerIncarnation: { pid: m.owner.pid, processStartTime: m.owner.processStartTime },
      workers: [],
      generation: 1,
      grantedAt: now(),
      lastSeenAt: now(),
      lastVerifyAt: null,
    };
    // Registry check + registry write in the SAME synchronous block; no await.
    state.sessions.set(entry.sessionPath, entry);
    state.byIdentity.set(entry.identityHash, entry.sessionPath);
    const saved = persistOwners();
    if (!saved.ok) {
      state.sessions.delete(entry.sessionPath);
      state.byIdentity.delete(entry.identityHash);
      return saved;
    }
    pushAudit({ op: 'GRANT', identityHash: entry.identityHash, sessionPath: entry.sessionPath, connectionId: conn.id, laneId: entry.laneId, generation: 1, ownerIncarnation: entry.ownerIncarnation });
    emit(`GRANT ${entry.identityHash} -> conn#${conn.id}`);
    return { ok: true, value: grantValue(entry, { resumed: false, renewed: false }) };
  }

  function grantValue(e, extra = {}) {
    return {
      identityHash: e.identityHash,
      sessionPath: e.sessionPath,
      laneId: e.laneId,
      token: e.token,
      daemonEpoch: e.daemonEpoch,
      connectionId: e.connectionId,
      generation: e.generation,
      grantedAt: e.grantedAt,
      state: e.state,
      ...extra,
    };
  }

  // Shared ownership assertion used by VERIFY/RELEASE/ATTACH/DETACH. A token is
  // never a bearer credential: it is only accepted together with the CURRENT
  // daemonEpoch and on the CURRENT owning connection.
  function assertOwner(conn, m, { release = false } = {}) {
    const idc = canonicalIdentityHash(m.identityHash);
    if (!idc.ok) return { ok: false, code: idc.reason, detail: idc.detail ?? null };
    const spc = canonicalSessionPath(m.sessionPath);
    if (!spc.ok) return { ok: false, code: spc.reason, detail: 'sessionPath is not a canonical filesystem path' };
    const found = lookup(idc.identityHash, spc.sessionPath);
    if (!found.ok) return { ok: false, code: found.code, detail: 'identityHash and sessionPath map to different sessions' };
    const e = found.entry;
    if (!e) return { ok: false, code: release ? CODES.RELEASE_NOT_OWNER : CODES.NOT_OWNER, detail: 'no grant for this session' };
    if (e.daemonEpoch !== m.daemonEpoch) return { ok: false, code: CODES.EPOCH_STALE, detail: 'grant was minted by a previous authority incarnation' };
    if (e.token !== m.token) return { ok: false, code: release ? CODES.RELEASE_NOT_OWNER : CODES.NOT_OWNER, detail: 'token does not match the current grant' };
    if (e.connectionId !== conn.id) return { ok: false, code: release ? CODES.RELEASE_NOT_OWNER : CODES.NOT_OWNER, detail: 'grant belongs to a different connection' };
    return { ok: true, entry: e };
  }

  function onVerify(conn, m) {
    const r = assertOwner(conn, m);
    if (!r.ok) { pushAudit({ op: 'VERIFY_DENIED', identityHash: safeId(m), connectionId: conn.id, code: r.code }); return r; }
    r.entry.lastVerifyAt = now();
    return { ok: true, value: grantValue(r.entry, { verified: true }) };
  }

  function onRelease(conn, m) {
    const r = assertOwner(conn, m, { release: true });
    if (!r.ok) { pushAudit({ op: 'RELEASE_DENIED', identityHash: safeId(m), connectionId: conn.id, code: r.code }); return r; }
    const e = r.entry;
    state.sessions.delete(e.sessionPath);
    if (state.byIdentity.get(e.identityHash) === e.sessionPath) state.byIdentity.delete(e.identityHash);
    const saved = persistOwners();
    if (!saved.ok) {
      state.sessions.set(e.sessionPath, e);
      state.byIdentity.set(e.identityHash, e.sessionPath);
      return saved;
    }
    pushAudit({ op: 'RELEASE', identityHash: e.identityHash, sessionPath: e.sessionPath, connectionId: conn.id, generation: e.generation });
    return { ok: true, value: { released: true, identityHash: e.identityHash, generation: e.generation } };
  }

  function onAttach(conn, m) {
    const r = assertOwner(conn, m);
    if (!r.ok) return { ok: false, code: CODES.ATTACH_TOKEN_INVALID, detail: r.detail ?? 'attach must present a live owner grant' };
    if (!validIncarnation(m.worker)) return { ok: false, code: CODES.OWNER_IDENTITY_UNPROVEN, detail: 'worker must carry {pid, processStartTime}' };
    const cls = classifyIncarnation(m.worker, probe);
    if (cls.status !== 'LIVE') return { ok: false, code: CODES.OWNER_IDENTITY_UNPROVEN, detail: `worker incarnation is ${cls.status} (${cls.reason})` };
    const e = r.entry;
    const previousWorkers = e.workers.map((w) => ({ ...w, incarnation: { ...w.incarnation } }));
    const pid = m.worker.pid;
    const known = e.workers.find((w) => w.incarnation.pid === pid);
    if (known) {
      known.incarnation = { pid: m.worker.pid, processStartTime: m.worker.processStartTime };
      known.connectionId = conn.id;
      known.attachedAt = now();
    } else {
      e.workers.push({ incarnation: { pid: m.worker.pid, processStartTime: m.worker.processStartTime }, connectionId: conn.id, attachedAt: now() });
    }
    const saved = persistOwners();
    if (!saved.ok) { e.workers = previousWorkers; return saved; }
    pushAudit({ op: 'ATTACH_WORKER', identityHash: e.identityHash, sessionPath: e.sessionPath, connectionId: conn.id, worker: e.workers.find((w) => w.incarnation.pid === pid).incarnation });
    return { ok: true, value: { attached: true, workerCount: e.workers.length } };
  }

  function onDetach(conn, m) {
    const r = assertOwner(conn, m);
    if (!r.ok) return { ok: false, code: CODES.ATTACH_TOKEN_INVALID, detail: r.detail ?? 'detach must present a live owner grant' };
    const e = r.entry;
    const previousWorkers = e.workers;
    const pid = m.workerPid;
    const before = e.workers.length;
    e.workers = e.workers.filter((w) => w.incarnation.pid !== pid || w.connectionId !== conn.id);
    const saved = persistOwners();
    if (!saved.ok) { e.workers = previousWorkers; return saved; }
    pushAudit({ op: 'DETACH_WORKER', identityHash: e.identityHash, sessionPath: e.sessionPath, connectionId: conn.id, workerPid: pid ?? null, removed: before - e.workers.length });
    return { ok: true, value: { detached: true, workerCount: e.workers.length } };
  }

  // Takeover is the ONLY way a dead owner's entry becomes available again.
  // Pre-conditions, all checked in this one synchronous turn:
  //   1. the entry exists and its OWNING connection is closed (EOF observed),
  //   2. EVERY registered incarnation (owner + attached workers) is provably
  //      gone (dead pid or recycled pid) — UNKNOWN is fail-closed,
  //   3. the requester's own incarnation is provably LIVE.
  // The audit record keeps the evidence that was used.
  function onTakeover(conn, m) {
    const idc = canonicalIdentityHash(m.identityHash);
    if (!idc.ok) return { ok: false, code: idc.reason, detail: idc.detail ?? null };
    const spc = canonicalSessionPath(m.sessionPath);
    if (!spc.ok) return { ok: false, code: spc.reason, detail: 'sessionPath is not a canonical filesystem path' };
    const found = lookup(idc.identityHash, spc.sessionPath);
    if (!found.ok) return { ok: false, code: found.code, detail: 'identityHash and sessionPath map to different sessions' };
    const e = found.entry;
    if (!e) return { ok: false, code: CODES.ENTRY_ABSENT, detail: 'no grant to take over; ACQUIRE instead' };
    if (e.connectionId === conn.id && e.connectionOpen) return { ok: false, code: CODES.TAKEOVER_NOT_DISCONNECTED, detail: 'this connection already owns the session' };
    if (e.connectionOpen) {
      pushAudit({ op: 'TAKEOVER_DENIED', identityHash: e.identityHash, sessionPath: e.sessionPath, connectionId: conn.id, code: CODES.TAKEOVER_NOT_DISCONNECTED });
      return { ok: false, code: CODES.TAKEOVER_NOT_DISCONNECTED, detail: 'owner connection is still open; EOF is not proof of a dead owner' };
    }
    if (!validIncarnation(m.requester)) return { ok: false, code: CODES.OWNER_IDENTITY_UNPROVEN, detail: 'requester must carry {pid, processStartTime}' };
    const reqCls = classifyIncarnation(m.requester, probe);
    if (reqCls.status !== 'LIVE') return { ok: false, code: CODES.OWNER_IDENTITY_UNPROVEN, detail: `requester incarnation is ${reqCls.status}` };

    const evidence = [];
    let blocking = null;
    const all = [{ role: 'owner', incarnation: e.ownerIncarnation, connectionId: e.connectionId },
      ...e.workers.map((w) => ({ role: 'worker', incarnation: w.incarnation, connectionId: w.connectionId }))];
    for (const item of all) {
      const cls = classifyIncarnation(item.incarnation, probe);
      evidence.push({ role: item.role, pid: item.incarnation?.pid ?? null, status: cls.status, reason: cls.reason });
      if (cls.status !== 'GONE' && cls.status !== 'FOREIGN') blocking = blocking || { ...item, status: cls.status, reason: cls.reason };
    }
    if (blocking) {
      pushAudit({ op: 'TAKEOVER_DENIED', identityHash: e.identityHash, sessionPath: e.sessionPath, connectionId: conn.id, code: CODES.TAKEOVER_EVIDENCE_INCOMPLETE, blocking, evidence });
      return {
        ok: false,
        code: CODES.TAKEOVER_EVIDENCE_INCOMPLETE,
        detail: `prior ${blocking.role} pid ${blocking.incarnation?.pid ?? '?'} is ${blocking.status} (${blocking.reason}); a live/unprobeable mutator blocks takeover`,
        evidence,
      };
    }

    const token = crypto.randomBytes(32).toString('hex');
    const previous = { ...e, ownerIncarnation: { ...e.ownerIncarnation }, workers: e.workers };
    const prevGeneration = e.generation;
    e.token = token;
    e.daemonEpoch = daemonEpoch;
    e.connectionId = conn.id;
    e.connectionOpen = true;
    e.state = ENTRY_STATE.OWNED;
    e.workers = [];
    e.generation = prevGeneration + 1;
    e.laneId = m.laneId ?? e.laneId;
    e.ownerIncarnation = { pid: m.requester.pid, processStartTime: m.requester.processStartTime };
    e.grantedAt = now();
    e.lastSeenAt = now();
    const saved = persistOwners();
    if (!saved.ok) { Object.assign(e, previous); return saved; }
    pushAudit({
      op: 'TAKEOVER', identityHash: e.identityHash, sessionPath: e.sessionPath, connectionId: conn.id,
      fromGeneration: prevGeneration, toGeneration: e.generation, evidence, requestedReason: typeof m.reason === 'string' ? m.reason.slice(0, 300) : null,
    });
    emit(`TAKEOVER ${e.identityHash} gen ${prevGeneration} -> ${e.generation}`);
    return { ok: true, value: grantValue(e, { takeover: true, previousGeneration: prevGeneration, evidence }) };
  }

  function onOwners() {
    const entries = [...state.sessions.values()].map(summarizeEntry);
    return {
      ok: true,
      value: {
        daemonEpoch,
        startedAt: state.startedAt ?? null,
        openConnections: state.connections.size,
        sessionCount: entries.length,
        // Live registry view: how many sessions currently have a registered
        // owner entry, and how many of those still have an open owning pipe.
        ownedWithOpenConnection: entries.filter((e) => e.state === ENTRY_STATE.OWNED && e.connectionOpen).length,
        disconnected: entries.filter((e) => e.state === ENTRY_STATE.DISCONNECTED).length,
        entries,
        audit: state.audit.slice(-100),
      },
    };
  }

  function safeId(m) { const c = canonicalIdentityHash(m && m.identityHash); return c.ok ? c.identityHash : null; }

  // ---- RECEIPT (REC-01) ----------------------------------------------------
  // Fresh read of the durable store per op (never a stale cache): idempotency
  // and dedup always judge against what is actually on disk, in ONE
  // synchronous read-check-write turn like every other op here.
  function loadReceipts() {
    let store;
    try {
      store = JSON.parse(fs.readFileSync(receiptsPath, 'utf8'));
    } catch (e) {
      if (e && e.code === 'ENOENT') return { ok: true, store: { schemaVersion: 1, pipePath, entries: [] } };
      return { ok: false, code: CODES.AUTHORITY_STATE_UNAVAILABLE, detail: 'receipt store is unreadable' };
    }
    if (!store || store.schemaVersion !== 1 || store.pipePath !== pipePath || !Array.isArray(store.entries)) {
      return { ok: false, code: CODES.AUTHORITY_STATE_UNAVAILABLE, detail: 'receipt store schema/endpoint mismatch' };
    }
    return { ok: true, store };
  }

  // Owner-gated operation confirmation. The SAME token+daemonEpoch+connection
  // triple as VERIFY/RELEASE (assertOwner) proves the caller IS the live grant
  // holder - the token alone is never bearer. A confirmed row is durable,
  // append-only and idempotent per (identityHash, kind, record bytes); the
  // fence token itself is NEVER persisted.
  function onReceipt(conn, m) {
    const r = assertOwner(conn, m);
    if (!r.ok) {
      pushAudit({ op: 'RECEIPT_DENIED', identityHash: safeId(m), connectionId: conn.id, code: r.code });
      return r;
    }
    if (!RECEIPT_KINDS.includes(m.kind)) {
      return { ok: false, code: CODES.RECEIPT_INVALID, detail: 'kind must be a registered receipt kind' };
    }
    if (typeof m.recordSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.recordSha256)) {
      return { ok: false, code: CODES.RECEIPT_INVALID, detail: 'recordSha256 must be 64 lowercase hex chars' };
    }
    if (typeof m.checkpointKey !== 'string' || !/^[0-9a-f]{16}$/.test(m.checkpointKey)) {
      return { ok: false, code: CODES.RECEIPT_INVALID, detail: 'checkpointKey must be 16 lowercase hex chars' };
    }
    const e = r.entry;
    const loaded = loadReceipts();
    if (!loaded.ok) return loaded;
    const store = loaded.store;
    const dup = store.entries.find((x) => x && x.identityHash === e.identityHash && x.kind === m.kind && x.recordSha256 === m.recordSha256);
    if (dup) {
      pushAudit({ op: 'RECEIPT_DUPLICATE', identityHash: e.identityHash, connectionId: conn.id, seq: dup.seq, recordSha256: m.recordSha256 });
      return { ok: true, value: { sealed: false, seq: dup.seq, recordSha256: m.recordSha256, checkpointKey: m.checkpointKey, receipt: dup } };
    }
    const lastSeq = store.entries.length ? Number(store.entries[store.entries.length - 1].seq) || 0 : 0;
    const entry = {
      seq: lastSeq + 1,
      at: now(),
      daemonEpoch,
      identityHash: e.identityHash,
      sessionPath: e.sessionPath,
      generation: e.generation,
      connectionId: conn.id,
      kind: m.kind,
      recordSha256: m.recordSha256,
      checkpointKey: m.checkpointKey,
      pipePath,
    };
    store.entries.push(entry);
    try {
      durableReplace(receiptsPath, `${JSON.stringify(store)}\n`);
    } catch (err) {
      store.entries.pop();
      return { ok: false, code: CODES.AUTHORITY_STATE_UNAVAILABLE, detail: String((err && err.message) || err) };
    }
    pushAudit({ op: 'RECEIPT', identityHash: e.identityHash, sessionPath: e.sessionPath, connectionId: conn.id, generation: e.generation, seq: entry.seq, recordSha256: m.recordSha256 });
    emit(`RECEIPT ${e.identityHash} seq ${entry.seq}`);
    return { ok: true, value: { sealed: true, seq: entry.seq, recordSha256: m.recordSha256, checkpointKey: m.checkpointKey, receipt: entry } };
  }

  const handlers = {
    PING: () => ({ ok: true, value: { pong: true, daemonEpoch, protocol: PROTOCOL_VERSION } }),
    ACQUIRE: onAcquire,
    VERIFY: onVerify,
    RELEASE: onRelease,
    ATTACH: onAttach,
    DETACH: onDetach,
    TAKEOVER: onTakeover,
    OWNERS: onOwners,
    RECEIPT: onReceipt,
  };

  function handleFrame(conn, text) {
    const parsed = parseFrame(text);
    if (!parsed.ok) {
        conn.socket.write(failReply(null, parsed.code, parsed.detail));
      conn.kill(`${parsed.code}: ${parsed.detail}`);
      return;
    }
    const m = parsed.message;
    const id = typeof m.id === 'string' ? m.id.slice(0, 64) : null;
    const op = m.op;
    if (!id || typeof op !== 'string' || !OPS.includes(op)) {
      conn.socket.write(failReply(id, CODES.REQUEST_INVALID, `unknown or missing op: ${String(op)}`));
      return;
    }
    let result;
    try {
      result = handlers[op](conn, m);
    } catch (e) {
      result = { ok: false, code: CODES.PROTOCOL_ERROR, detail: String((e && e.message) || e) };
    }
    if (!result || result.ok !== true) {
      conn.socket.write(failReply(id, (result && result.code) || CODES.PROTOCOL_ERROR, (result && result.detail) ?? null, result && result.owner ? { owner: result.owner } : {}));
      return;
    }
    conn.socket.write(okReply(id, result.value));
  }

  function onConnection(socket) {
    if (state.stopped || !state.started) { socket.destroy(); return; }
    if (state.connections.size >= maxConnections) { socket.destroy(); return; }
    const id = state.nextConnectionId++;
    const conn = {
      id,
      socket,
      timer: null,
      kill(reason) {
        pushAudit({ op: 'CONNECTION_REJECTED', connectionId: id, reason: String(reason).slice(0, 200) });
        try { socket.destroy(); } catch { /* already gone */ }
      },
    };
    state.connections.set(id, conn);
    const decoder = createFrameDecoder({
      maxBytes: MAX_FRAME_BYTES,
      onProtocolError: (code, detail) => { conn.kill(`${code}: ${detail}`); },
    });

    const armTimer = () => {
      if (conn.timer) clearTimeout(conn.timer);
      conn.timer = setTimeout(() => conn.kill(CODES.REQUEST_TIMEOUT), requestTimeoutMs);
      if (typeof conn.timer.unref === 'function') conn.timer.unref();
    };
    armTimer();

    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      armTimer();
      if (decoder.poisoned) return;
      const frames = decoder.push(chunk);
      for (const text of frames) {
        if (decoder.poisoned) break;
        handleFrame(conn, text);
      }
      if (decoder.poisoned) conn.kill(CODES.FRAME_TOO_LARGE);
    });
    const onClose = () => {
      if (conn.timer) clearTimeout(conn.timer);
      state.connections.delete(id);
      // EOF is an INVESTIGATION signal only: entries are marked DISCONNECTED,
      // never released, never handed to another connection.
      for (const e of state.sessions.values()) {
        if (e.connectionId === id && e.connectionOpen) {
          e.connectionOpen = false;
          e.state = ENTRY_STATE.DISCONNECTED;
          pushAudit({ op: 'OWNER_PIPE_CLOSED', identityHash: e.identityHash, sessionPath: e.sessionPath, connectionId: id, generation: e.generation, note: 'not a takeover; awaiting positive death evidence' });
          emit(`DISCONNECT ${e.identityHash} conn#${id} (entry retained)`);
        }
      }
      for (const e of state.sessions.values()) {
        for (const w of e.workers) if (w.connectionId === id) w.connectionOpen = false;
      }
    };
    socket.on('close', onClose);
    socket.on('error', onClose);
    socket.on('end', () => { try { socket.end(); } catch { /* already gone */ } });
  }

  async function start() {
    if (state.started) return { ok: true, pipePath, daemonEpoch, alreadyStarted: true };
    // The pipe bind itself is the singleton election. Do not acquire or
    // reclaim a filesystem lock before binding: its read/unlink race can let
    // two claimants believe they won. No frame is handled until restoration.
    const server = net.createServer(onConnection);
    state.server = server;
    await new Promise((resolve, reject) => {
      const onError = (err) => { server.removeListener('listening', onListening); reject(err); };
      const onListening = () => { server.removeListener('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      try { server.listen(pipePath); } catch (e) { server.removeListener('error', onError); server.removeListener('listening', onListening); reject(e); }
    }).catch((e) => {
      state.server = null;
      const err = new Error(`failed to bind canonical authority endpoint ${pipePath}: ${String((e && e.message) || e)}`);
      err.code = CODES.BIND_FAILED;
      throw err;
    });

    const restored = restoreOwners();
    if (!restored.ok) {
      state.stopped = true;
      for (const conn of [...state.connections.values()]) conn.kill('OWNER_SNAPSHOT_UNAVAILABLE');
      await new Promise((resolve) => server.close(resolve));
      state.server = null;
      state.stopped = false;
      return { ...restored, pipePath };
    }

    state.started = true;
    state.startedAt = new Date().toISOString();
    emit(`authority listening on ${pipePath} epoch=${daemonEpoch}`);
    return { ok: true, pipePath, daemonEpoch, bindLockPath };
  }

  async function stop() {
    if (state.stopped) return { ok: true };
    state.stopped = true;
    for (const conn of [...state.connections.values()]) {
      if (conn.timer) clearTimeout(conn.timer);
      try { conn.socket.destroy(); } catch { /* already gone */ }
    }
    state.connections.clear();
    if (state.server) {
      await new Promise((resolve) => { try { state.server.close(() => resolve()); } catch { resolve(); } });
      state.server = null;
    }
    state.started = false;
    emit(`authority stopped epoch=${daemonEpoch}`);
    return { ok: true };
  }

  return {
    start,
    stop,
    pipePath,
    bindLockPath,
    snapshotPath,
    daemonEpoch,
    // Read-only introspection for tests/ops. Never grants anything.
    inspect: () => ({ daemonEpoch, sessionCount: state.sessions.size, openConnections: state.connections.size, audit: state.audit.slice() }),
    handlers: { onAcquire, onVerify, onRelease, onAttach, onDetach, onTakeover, onOwners, onReceipt },
  };
}

export { encodeFrame };
