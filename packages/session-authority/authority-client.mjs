// authority-client.mjs — fail-closed client for the Session Admission Authority.
//
// CONTRACT (SOC_TASK_CONTRACT §2):
//   * If the canonical authority endpoint cannot be reached, the client FAILS
//     CLOSED. There is NO file-lease fallback and no "best effort" grant.
//   * Every transport failure (connect error, mid-request cut, timeout,
//     oversize frame at the peer, malformed reply) surfaces as a typed
//     { ok:false, code } result. Callers MUST refuse to mutate on any of them.
//   * A grant is connection-scoped. Losing the socket loses the grant: the
//     client flips every derived fence to INVALID synchronously inside the
//     socket 'close'/'error' handler, so no later mutation in this process can
//     mistake a dead pipe for live authority.

import net from 'node:net';

import {
  CODES, DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, MAX_FRAME_BYTES,
  authorityPipePath, createFrameDecoder, encodeRequest, parseFrame,
} from './protocol.mjs';

function fail(code, detail, extra = {}) { return { ok: false, code, detail: detail ?? null, ...extra }; }

export function createAuthorityClient(options = {}) {
  const pipePath = options.pipePath || authorityPipePath();
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  let socket = null;
  let connected = false;
  let seq = 0;
  let daemonEpoch = null;
  let decoder = null;                 // fresh per connection (never inherits poison)
  const pending = new Map();          // id -> {resolve, timer}
  const closeHandlers = new Set();

  function dropConnection(code, detail) {
    const wasConnected = connected;
    connected = false;
    const s = socket;
    socket = null;
    if (s) { try { s.destroy(); } catch { /* already gone */ } }
    for (const [id, p] of [...pending.entries()]) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.resolve(fail(code, detail));
    }
    if (wasConnected || closeHandlers.size) {
      for (const h of [...closeHandlers]) { try { h({ code, detail }); } catch { /* observer */ } }
    }
  }

  async function connect() {
    if (connected) return { ok: true, pipePath, alreadyConnected: true };
    return new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };

      decoder = createFrameDecoder({
        maxBytes: MAX_FRAME_BYTES,
        onProtocolError: (code, detail) => { dropConnection(code, detail); },
      });

      let s;
      try { s = net.createConnection(pipePath); } catch (e) {
        decoder = null;
        done(fail(CODES.AUTHORITY_UNAVAILABLE, String((e && e.message) || e)));
        return;
      }
      socket = s;

      const timer = setTimeout(() => {
        dropConnection(CODES.AUTHORITY_TIMEOUT, `connect to ${pipePath} timed out after ${connectTimeoutMs}ms`);
        done(fail(CODES.AUTHORITY_TIMEOUT, `authority at ${pipePath} did not accept within ${connectTimeoutMs}ms`));
      }, connectTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      s.once('connect', () => {
        clearTimeout(timer);
        connected = true;
        done({ ok: true, pipePath });
      });

      s.on('data', (chunk) => {
        if (!decoder || decoder.poisoned) return;
        const frames = decoder.push(chunk);
        for (const text of frames) {
          const parsed = parseFrame(text);
          if (!parsed.ok) { dropConnection(CODES.AUTHORITY_MALFORMED_RESPONSE, parsed.detail); done(fail(CODES.AUTHORITY_MALFORMED_RESPONSE, parsed.detail)); return; }
          const m = parsed.message;
          const p = typeof m.id === 'string' ? pending.get(m.id) : undefined;
          if (m.ok === true && m.value && typeof m.value === 'object' && typeof m.value.daemonEpoch === 'string') daemonEpoch = m.value.daemonEpoch;
          if (!p) continue;                      // unsolicited frame: ignore
          pending.delete(m.id);
          clearTimeout(p.timer);
          if (m.ok === true) p.resolve({ ok: true, value: m.value ?? null });
          else p.resolve(fail(typeof m.code === 'string' ? m.code : CODES.PROTOCOL_ERROR, m.detail ?? null, m.owner ? { owner: m.owner } : {}));
        }
        if (decoder && decoder.poisoned) dropConnection(CODES.FRAME_TOO_LARGE, 'authority sent an oversize frame');
      });

      s.on('error', (e) => {
        clearTimeout(timer);
        const msg = String((e && e.message) || e);
        dropConnection(CODES.AUTHORITY_UNAVAILABLE, `authority pipe error on ${pipePath}: ${msg}`);
        done(fail(CODES.AUTHORITY_UNAVAILABLE, `cannot reach authority at ${pipePath}: ${msg}`));
      });

      s.on('close', () => {
        clearTimeout(timer);
        dropConnection(CODES.AUTHORITY_CONNECTION_LOST, `authority pipe closed (${pipePath})`);
        done(fail(CODES.AUTHORITY_CONNECTION_LOST, `authority pipe closed (${pipePath})`));
      });
    });
  }

  async function request(op, payload = {}) {
    if (!connected || !socket) {
      return fail(CODES.AUTHORITY_CONNECTION_LOST, `not connected to ${pipePath}; authority unavailable => fail closed`);
    }
    const id = `r${++seq}`;
    let frame;
    try { frame = encodeRequest(id, op, payload); } catch (e) {
      return fail(typeof e.code === 'string' ? e.code : CODES.REQUEST_INVALID, String((e && e.message) || e));
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        resolve(fail(CODES.AUTHORITY_TIMEOUT, `${op} did not complete within ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      pending.set(id, { resolve, timer });
      const s = socket;
      if (!s) {
        pending.delete(id);
        clearTimeout(timer);
        resolve(fail(CODES.AUTHORITY_CONNECTION_LOST, 'connection dropped before write'));
        return;
      }
      try { s.write(frame); } catch (e) {
        pending.delete(id);
        clearTimeout(timer);
        dropConnection(CODES.AUTHORITY_CONNECTION_LOST, String((e && e.message) || e));
        resolve(fail(CODES.AUTHORITY_CONNECTION_LOST, `write failed: ${String((e && e.message) || e)}`));
      }
    });
  }

  const incarnationOf = (v) => (v && Number.isInteger(v.pid) && Number.isInteger(v.processStartTime) ? v : null);

  return {
    pipePath,
    get connected() { return connected; },
    get daemonEpoch() { return daemonEpoch; },
    onClose(handler) { closeHandlers.add(handler); return () => closeHandlers.delete(handler); },
    connect,
    request,
    ping: () => request('PING'),
    async acquire({ identityHash, sessionPath, laneId = null, owner = null }) {
      const inc = incarnationOf(owner);
      if (!inc) return fail(CODES.OWNER_IDENTITY_UNPROVEN, 'acquire requires a provable owner incarnation {pid, processStartTime}');
      return request('ACQUIRE', { identityHash, sessionPath, laneId, owner: inc });
    },
    async verify({ identityHash, sessionPath, token, daemonEpoch: epoch }) {
      if (typeof token !== 'string' || typeof epoch !== 'string') return fail(CODES.REQUEST_INVALID, 'verify requires token and daemonEpoch');
      return request('VERIFY', { identityHash, sessionPath, token, daemonEpoch: epoch });
    },
    async release({ identityHash, sessionPath, token, daemonEpoch: epoch }) {
      if (typeof token !== 'string' || typeof epoch !== 'string') return fail(CODES.REQUEST_INVALID, 'release requires token and daemonEpoch');
      return request('RELEASE', { identityHash, sessionPath, token, daemonEpoch: epoch });
    },
    async attach({ identityHash, sessionPath, token, daemonEpoch: epoch, worker = null }) {
      const inc = incarnationOf(worker);
      if (!inc) return fail(CODES.OWNER_IDENTITY_UNPROVEN, 'attach requires a provable worker incarnation {pid, processStartTime}');
      return request('ATTACH', { identityHash, sessionPath, token, daemonEpoch: epoch, worker: inc });
    },
    async detach({ identityHash, sessionPath, token, daemonEpoch: epoch, workerPid = null }) {
      return request('DETACH', { identityHash, sessionPath, token, daemonEpoch: epoch, workerPid });
    },
    async takeover({ identityHash, sessionPath, requester = null, laneId = null, reason = null }) {
      const inc = incarnationOf(requester);
      if (!inc) return fail(CODES.OWNER_IDENTITY_UNPROVEN, 'takeover requires a provable requester incarnation {pid, processStartTime}');
      return request('TAKEOVER', { identityHash, sessionPath, requester: inc, laneId, reason });
    },
    owners: () => request('OWNERS'),
    close() {
      dropConnection(CODES.AUTHORITY_CONNECTION_LOST, 'client closed by caller');
    },
  };
}

export { CODES as AUTHORITY_CODES };
