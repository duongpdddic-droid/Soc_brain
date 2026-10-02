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
  try {
    tracked = git(worktreePath, ['ls-files', '-z']).split('\0').filter(Boolean);
  } catch (e) {
    return { ok: false, reason: `tracked file list unavailable: ${String((e && e.message) || e)}` };
  }
  tracked.sort();

  const h = crypto.createHash('sha256');
  let fileCount = 0;
  for (const rel of tracked) {
    let digest = 'MISSING';
    try {
      digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(worktreePath, rel))).digest('hex');
    } catch { /* an unreadable/deleted tracked path is part of the content state */ }
    h.update(rel);
    h.update('\0');
    h.update(digest);
    h.update('\n');
    fileCount += 1;
  }
  const contentDigest = h.digest('hex');
  if (!HEX64.test(contentDigest)) return { ok: false, reason: 'content digest could not be computed' };
  return { ok: true, value: { headSha: head, contentDigest, fileCount } };
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
