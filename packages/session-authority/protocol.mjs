// protocol.mjs — wire contract for the Centralized Session Admission Authority.
//
// SCOPE: transport + canonicalization + error taxonomy ONLY. This module holds
// no registry, no grant state and no lifecycle policy, so both the daemon and
// every client agree on byte-level framing without importing each other.
//
// DESIGN INVARIANTS (SOC_TASK_CONTRACT §2):
//   * Windows Named Pipe over node:net. No FFI, no native dependency.
//   * Endpoint is per USER/MACHINE, never per worktree, so two worktrees of the
//     same canonical task resolve to ONE authority.
//   * Newline-delimited JSON frames with a hard size cap (oversize -> typed
//     error + connection teardown), a request timeout and explicit codes.
//   * identityHash and sessionPath are canonicalized so two spellings of the
//     same session can never become two registry keys.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROTOCOL_VERSION = 1;

// Hard frame cap. A frame is one JSON object terminated by '\n'. Anything
// larger is a protocol violation, never a truncated grant.
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_ID_OCTETS = 64;
export const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
export const DEFAULT_SOCKET_IDLE_TIMEOUT_MS = 30000;
export const MAX_CONCURRENT_CONNECTIONS = 128;

// workspace.mjs derives identityHash as a 32-char lowercase hex prefix of
// sha256(task identity). Anything else is not a canonical session identity.
export const IDENTITY_HASH_RE = /^[0-9a-f]{32}$/;
const OP_RE = /^[A-Z][A-Z0-9_]{0,31}$/;

// Ops understood by the authority daemon.
// RECEIPT (REC-01): owner-gated, durable, idempotent confirmation that a
// boundary record write happened under THIS live grant - the operation seam
// the control-plane reconciliation reader verifies against.
export const OPS = Object.freeze([
  'PING', 'ACQUIRE', 'VERIFY', 'RELEASE', 'ATTACH', 'DETACH', 'TAKEOVER', 'OWNERS', 'RECEIPT',
]);

// Registered receipt kinds. The daemon validates membership so a RECEIPT can
// only ever confirm a record type this protocol explicitly knows about.
export const RECEIPT_KINDS = Object.freeze([
  'PRE_SUBMIT_BOUNDARY_RECONCILED',
]);

// Typed failure taxonomy. Every rejection is one of these; a client treats ANY
// non-ok code as fail-closed (no mutation).
export const CODES = Object.freeze({
  // transport / framing
  AUTHORITY_UNAVAILABLE: 'AUTHORITY_UNAVAILABLE',
  AUTHORITY_TIMEOUT: 'AUTHORITY_TIMEOUT',
  AUTHORITY_CONNECTION_LOST: 'AUTHORITY_CONNECTION_LOST',
  AUTHORITY_MALFORMED_RESPONSE: 'AUTHORITY_MALFORMED_RESPONSE',
  FRAME_TOO_LARGE: 'FRAME_TOO_LARGE',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
  REQUEST_INVALID: 'REQUEST_INVALID',
  // admission
  SESSION_ACQUIRE_CONFLICT: 'SESSION_ACQUIRE_CONFLICT',
  OWNER_IDENTITY_UNPROVEN: 'OWNER_IDENTITY_UNPROVEN',
  IDENTITY_HASH_INVALID: 'IDENTITY_HASH_INVALID',
  SESSION_PATH_INVALID: 'SESSION_PATH_INVALID',
  IDENTITY_PATH_MISMATCH: 'IDENTITY_PATH_MISMATCH',
  NOT_OWNER: 'NOT_OWNER',
  EPOCH_STALE: 'EPOCH_STALE',
  RELEASE_NOT_OWNER: 'RELEASE_NOT_OWNER',
  ATTACH_TOKEN_INVALID: 'ATTACH_TOKEN_INVALID',
  TAKEOVER_NOT_DISCONNECTED: 'TAKEOVER_NOT_DISCONNECTED',
  TAKEOVER_EVIDENCE_INCOMPLETE: 'TAKEOVER_EVIDENCE_INCOMPLETE',
  ENTRY_ABSENT: 'ENTRY_ABSENT',
  RECEIPT_INVALID: 'RECEIPT_INVALID',
  // local fence (guard)
  ADMISSION_NOT_ARMED: 'ADMISSION_NOT_ARMED',
  ADMISSION_FENCE_MISSING: 'ADMISSION_FENCE_MISSING',
  ADMISSION_FENCE_STALE: 'ADMISSION_FENCE_STALE',
  ADMISSION_FENCE_REVOKED: 'ADMISSION_FENCE_REVOKED',
  ADMISSION_CONNECTION_LOST: 'ADMISSION_CONNECTION_LOST',
  BIND_LOCK_HELD_BY_LIVE_DAEMON: 'BIND_LOCK_HELD_BY_LIVE_DAEMON',
  BIND_LOCK_HELD_BY_OTHER_AUTHORITY: 'BIND_LOCK_HELD_BY_OTHER_AUTHORITY',
  BIND_FAILED: 'BIND_FAILED',
  AUTHORITY_STATE_UNAVAILABLE: 'AUTHORITY_STATE_UNAVAILABLE',
});

// ---- canonicalization -------------------------------------------------------

export function canonicalIdentityHash(h) {
  if (typeof h !== 'string') return { ok: false, reason: CODES.IDENTITY_HASH_INVALID };
  const v = h.trim().toLowerCase();
  if (!IDENTITY_HASH_RE.test(v)) return { ok: false, reason: CODES.IDENTITY_HASH_INVALID, detail: 'identityHash must be 32 lowercase hex chars' };
  return { ok: true, identityHash: v };
}

// Two spellings of the same session MUST collapse to one registry key:
//   * path.resolve collapses '.' / '..' and redundant separators
//   * realpathSync (best effort) collapses junctions/symlinks
//   * win32 comparison is case-insensitive and uses '\' separators
export function canonicalSessionPath(p) {
  if (typeof p !== 'string' || !p.trim()) return { ok: false, reason: CODES.SESSION_PATH_INVALID };
  let r;
  try { r = path.resolve(p.trim()); } catch { return { ok: false, reason: CODES.SESSION_PATH_INVALID }; }
  if (r.includes('\0')) return { ok: false, reason: CODES.SESSION_PATH_INVALID };
  try { r = fs.realpathSync(r); } catch { /* target may not exist yet */ }
  if (process.platform === 'win32') r = r.replace(/\//g, '\\').toLowerCase();
  return { ok: true, sessionPath: r };
}

// ---- endpoint naming (per user / machine, NOT per worktree) -----------------

export function authorityPipeName({ override = null } = {}) {
  const explicit = override || process.env.SOC_SESSION_AUTHORITY_PIPE || null;
  let base;
  if (explicit && typeof explicit === 'string' && explicit.trim()) base = explicit.trim();
  else {
    let user = 'unknown';
    try { user = os.userInfo().username || 'unknown'; } catch { /* service account without userinfo */ }
    base = `soc-brain-session-authority-${user}`;
  }
  // Named pipes accept a broad charset, but keep the name boring and portable.
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return safe || 'soc-brain-session-authority';
}

export function authorityPipePath(opts = {}) {
  return `\\\\.\\pipe\\${authorityPipeName(opts)}`;
}

// Daemon singleton bookkeeping lives in a per-authority runtime dir under the
// USER's home (machine scope). This is NOT a session grant fallback: it only
// decides which process may own the canonical endpoint, so a second daemon can
// never stand up a parallel grant registry.
export function authorityRuntimeDir() {
  return path.join(os.homedir(), '.soc-brain', 'runtime', 'session-authority');
}

export function authorityBindLockPath(opts = {}) {
  return path.join(authorityRuntimeDir(), `${authorityPipeName(opts)}.bind.lock`);
}

// ---- framing ----------------------------------------------------------------

export function encodeFrame(message) {
  const json = JSON.stringify(message);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_FRAME_BYTES) {
    const e = new Error(`frame of ${bytes} bytes exceeds MAX_FRAME_BYTES=${MAX_FRAME_BYTES}`);
    e.code = CODES.FRAME_TOO_LARGE;
    throw e;
  }
  return Buffer.concat([Buffer.from(json, 'utf8'), Buffer.from('\n', 'utf8')]);
}

export function encodeRequest(id, op, payload = {}) {
  if (typeof id !== 'string' || !id || Buffer.byteLength(id) > MAX_ID_OCTETS) throw bad('REQUEST_INVALID', 'id missing or too long');
  if (typeof op !== 'string' || !OP_RE.test(op)) throw bad('REQUEST_INVALID', 'op must be an upper-case token');
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw bad('REQUEST_INVALID', 'payload must be an object');
  return encodeFrame({ v: PROTOCOL_VERSION, id, op, ...payload });
}

function bad(code, detail) { const e = new Error(detail); e.code = code; return e; }

// Incremental newline-delimited decoder with a hard buffered-byte cap. The cap
// is enforced on the RAW buffer, so an attacker cannot force unbounded memory
// by withholding the newline.
export function createFrameDecoder({ maxBytes = MAX_FRAME_BYTES, onProtocolError } = {}) {
  let buf = Buffer.alloc(0);
  let poisoned = false;
  return {
    push(chunk) {
      if (poisoned) return [];
      if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      if (buf.length > maxBytes) {
        poisoned = true;
        if (typeof onProtocolError === 'function') onProtocolError(CODES.FRAME_TOO_LARGE, `buffered ${buf.length} bytes without a frame terminator`);
        buf = Buffer.alloc(0);
        return [];
      }
      const out = [];
      let idx;
      while ((idx = buf.indexOf(0x0a)) !== -1) {
        const line = buf.subarray(0, idx);
        buf = buf.subarray(idx + 1);
        if (!line.length) continue;
        if (line.length > maxBytes) {
          poisoned = true;
          if (typeof onProtocolError === 'function') onProtocolError(CODES.FRAME_TOO_LARGE, `frame of ${line.length} bytes exceeds ${maxBytes}`);
          return out;
        }
        out.push(line.toString('utf8'));
      }
      return out;
    },
    get poisoned() { return poisoned; },
  };
}

export function parseFrame(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { return { ok: false, code: CODES.PROTOCOL_ERROR, detail: 'frame is not JSON' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, code: CODES.PROTOCOL_ERROR, detail: 'frame must be a JSON object' };
  if (obj.v !== PROTOCOL_VERSION) return { ok: false, code: CODES.PROTOCOL_ERROR, detail: `unsupported protocol version ${String(obj.v)}` };
  return { ok: true, message: obj };
}

export function okReply(id, value, extra = {}) {
  return encodeFrame({ v: PROTOCOL_VERSION, id, ok: true, value, ...extra });
}

export function failReply(id, code, detail = null, extra = {}) {
  return encodeFrame({ v: PROTOCOL_VERSION, id, ok: false, code, detail, ...extra });
}
