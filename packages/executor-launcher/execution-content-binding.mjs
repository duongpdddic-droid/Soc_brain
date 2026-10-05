// execution-content-binding.mjs — the CODE-VERSION binding an ExecutionRecord
// must carry (Issue #263 reviewer finding 4).
//
// Why this exists: `readExecutionTestLog` used to trust `record.headSha`, which
// production ExecutionRecords never write — so the staleness check compared
// `undefined !== undefined`, always passed, and a test log produced against an
// OLDER code version was accepted as evidence for the HEAD under review. A
// commit SHA field that can be null is not a binding.
//
// The binding is therefore content-addressed: a digest over every tracked file
// in the task worktree, taken at the moment the executor finished. The reviewer
// recomputes the same digest from the BOUND task worktree and compares. Equal
// digests mean the bytes the tests ran against are byte-identical to the bytes
// under review — regardless of how many metadata-only commits moved the label,
// and fail-closed whenever a single tracked byte differs.
//
// `headSha` is still recorded (as a label + provenance), but it is never the
// authority; content is.
//
// Both producer (executor exit handler) and consumer (review evidence) call the
// SAME function, so the two sides can never drift in serialization detail.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function git(worktreePath, args) {
  // NOTE: never strip NUL bytes here — `ls-files -z` relies on them as the
  // field separator; only surrounding whitespace is trimmed.
  return execFileSync('git', ['-C', worktreePath, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

// Snapshot the tracked content of a worktree.
//   { ok:true,  value:{ headSha, contentDigest, fileCount } }
//   { ok:false, reason }   -> the caller MUST fail closed; never "no binding
//                             means no check".
//
// The hash loop lives in ONE place (`hashTrackedContent`) so the one-shot
// reader and the incremental tracker used by the test-run recorder can never
// disagree about serialization detail — a digest that differed between the two
// sides would make every test-run record unverifiable.
function hashTrackedContent(tracked, digestOf) {
  const h = crypto.createHash('sha256');
  let fileCount = 0;
  for (const rel of tracked) {
    h.update(rel);
    h.update('\0');
    h.update(digestOf(rel));
    h.update('\n');
    fileCount += 1;
  }
  return { contentDigest: h.digest('hex'), fileCount };
}

function listTracked(worktreePath) {
  const tracked = git(worktreePath, ['ls-files', '-z']).split('\0').filter(Boolean);
  tracked.sort();
  return tracked;
}

function readDigest(worktreePath, rel) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(worktreePath, rel))).digest('hex');
  } catch { return 'MISSING'; } // an unreadable/deleted tracked path IS the content state
}

export function computeWorktreeContentBinding({ worktreePath = null, headSha = null } = {}) {
  if (typeof worktreePath !== 'string' || !worktreePath.trim()) {
    return { ok: false, reason: 'worktreePath is absent' };
  }
  let head;
  try {
    head = headSha || git(worktreePath, ['rev-parse', 'HEAD']);
  } catch (e) {
    return { ok: false, reason: `HEAD unavailable: ${String((e && e.message) || e)}` };
  }
  head = String(head || '').toLowerCase();
  if (!HEX40.test(head)) return { ok: false, reason: `HEAD is not a 40-hex sha: ${head || '(empty)'}` };

  let tracked;
  try { tracked = listTracked(worktreePath); } catch (e) {
    return { ok: false, reason: `tracked file list unavailable: ${String((e && e.message) || e)}` };
  }

  const { contentDigest, fileCount } = hashTrackedContent(tracked, (rel) => readDigest(worktreePath, rel));
  if (!HEX64.test(contentDigest)) return { ok: false, reason: 'content digest could not be computed' };
  return { ok: true, value: { headSha: head, contentDigest, fileCount } };
}

// Incremental snapshotter. `computeWorktreeContentBinding` re-reads every
// tracked file (~0.4 s on this repo) which is far too expensive to call after
// every executor tool event. This tracker caches per-file (mtime, size,
// digest) and only re-hashes what actually changed, while producing a digest
// byte-identical to the one-shot function above.
//   snapshot({ withHead }) -> { ok, value:{ headSha, contentDigest, fileCount } }
//   markIndexStale()       -> force a fresh `git ls-files` (a staged add/rm
//                             changes which paths count as tracked content)
export function createContentTracker({ worktreePath = null } = {}) {
  if (typeof worktreePath !== 'string' || !worktreePath.trim()) {
    throw new Error('worktreePath is required');
  }
  const cache = new Map();
  let tracked = null;
  let indexStale = true;
  let headSha = null;

  function ensureTracked() {
    if (!indexStale && tracked) return tracked;
    tracked = listTracked(worktreePath);
    for (const k of [...cache.keys()]) if (!tracked.includes(k)) cache.delete(k);
    indexStale = false;
    return tracked;
  }
  function cachedDigest(rel) {
    let st;
    try { st = fs.statSync(path.join(worktreePath, rel)); } catch { return 'MISSING'; }
    const hit = cache.get(rel);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.digest;
    const digest = readDigest(worktreePath, rel);
    if (digest !== 'MISSING') cache.set(rel, { mtimeMs: st.mtimeMs, size: st.size, digest });
    else cache.delete(rel);
    return digest;
  }

  return {
    markIndexStale() { indexStale = true; },
    get headSha() { return headSha; },
    snapshot({ withHead = false } = {}) {
      try {
        const list = ensureTracked();
        const { contentDigest, fileCount } = hashTrackedContent(list, cachedDigest);
        if (!HEX64.test(contentDigest)) return { ok: false, reason: 'content digest could not be computed' };
        if (withHead) {
          try { headSha = git(worktreePath, ['rev-parse', 'HEAD']).toLowerCase(); } catch { headSha = null; }
        }
        return { ok: true, value: { headSha, contentDigest, fileCount } };
      } catch (e) {
        return { ok: false, reason: String((e && e.message) || e) };
      }
    },
  };
}

// The record fields the producer stamps and the reader requires.
export const CONTENT_BINDING_FIELDS = Object.freeze({
  headSha: 'headSha',
  contentDigest: 'codeContentDigest',
  fileCount: 'codeContentFiles',
  at: 'codeBindingAt',
});

export function contentBindingFromRecord(record) {
  const r = record && typeof record === 'object' ? record : {};
  const headSha = typeof r.headSha === 'string' ? r.headSha.toLowerCase() : '';
  const contentDigest = typeof r.codeContentDigest === 'string' ? r.codeContentDigest.toLowerCase() : '';
  if (!HEX40.test(headSha)) return { ok: false, reason: `record.headSha is not a 40-hex sha: ${r.headSha ?? '(absent)'}` };
  if (!HEX64.test(contentDigest)) return { ok: false, reason: `record.codeContentDigest is not a sha256: ${r.codeContentDigest ?? '(absent)'}` };
  return { ok: true, value: { headSha, contentDigest } };
}
