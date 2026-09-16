#!/usr/bin/env node
// follow-binding.mjs — F5 (P0): the OBSERVABLE task binding for the attached
// follower, kept strictly separate from the executor-RECOVERY transport record.
//
// WHY SEPARATE: #182/#183 `transport.json` + `control.recover()` bind the SAME
// canonical task but carry execution-LIVENESS/recovery semantics (a GONE/terminal
// executor, STRICT pin-missing fail-closed, no-discovery auto boot, etc.). The
// follower is a pure OBSERVER: after ONE submit/attach it must resume FOLLOWING
// the exact same task across a transport restart even when the executor is no
// longer running and the canonical state advanced while the client was absent
// (RECOVERABLE_BLOCKED / HUMAN_GATE / READY_FOR_REVIEW). That "restore the exact
// observable binding" is a weaker need than "recover live execution," so it gets
// its own client-namespace record and NEVER rides the recovery/liveness path.
//
// It is observability-only: it stores identity coordinates (no lease token, no
// verdict, no lifecycle). It never submits, launches, answers gates, terminalizes
// or mutates canonical state. Clearing/absent binding simply means nothing to
// follow — it is not an error.

import fs from 'node:fs';
import path from 'node:path';

export const FOLLOW_BINDING_SCHEMA_VERSION = '1';

export function followBindingPathFor({ stateDir }) {
  return path.join(path.resolve(stateDir), 'client-mcp', 'follow.json');
}

function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function writeAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  try { fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8'); fs.renameSync(tmp, p); return true; }
  catch { try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ } return false; }
}

// Pin the exact observable identity to follow (idempotent; last writer wins). Only
// well-formed identities are persisted; anything else fails closed to a no-op.
export function pinFollow({ stateDir, repo, issueNumber, identityHash, now = () => new Date().toISOString() } = {}) {
  if (typeof repo !== 'string' || !repo) return { ok: false, reason: 'FOLLOW_BIND_REPO_MISSING' };
  const n = Number(issueNumber);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, reason: 'FOLLOW_BIND_ISSUE_MISSING' };
  if (typeof identityHash !== 'string' || !identityHash) return { ok: false, reason: 'FOLLOW_BIND_IDENTITY_MISSING' };
  const p = followBindingPathFor({ stateDir });
  const state = { schemaVersion: FOLLOW_BINDING_SCHEMA_VERSION, repo, issueNumber: n, identityHash, updatedAt: now() };
  return { ok: writeAtomic(p, state), state };
}

// Read the pinned observable identity. Returns { ok:true, binding } or
// { ok:true, binding:null } when nothing is pinned (NOT an error).
export function readFollowBinding({ stateDir } = {}) {
  const cur = readJsonSafe(followBindingPathFor({ stateDir }));
  if (!cur || typeof cur !== 'object' || cur.schemaVersion !== FOLLOW_BINDING_SCHEMA_VERSION
    || typeof cur.repo !== 'string' || !cur.repo || !Number.isInteger(Number(cur.issueNumber)) || Number(cur.issueNumber) <= 0
    || typeof cur.identityHash !== 'string' || !cur.identityHash) {
    return { ok: true, binding: null };
  }
  return { ok: true, binding: { repo: cur.repo, issueNumber: Number(cur.issueNumber), identityHash: cur.identityHash, updatedAt: cur.updatedAt ?? null } };
}

export function clearFollowBinding({ stateDir } = {}) {
  try { fs.rmSync(followBindingPathFor({ stateDir }), { force: true }); return { ok: true }; }
  catch { return { ok: false }; }
}
