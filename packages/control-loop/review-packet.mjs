#!/usr/bin/env node
// review-packet.mjs — canonical review-ready packet resolver (leaf module).
//
// Verbatim move of packetPathFor from adapters.mjs (Issue 1R rework): resolve
// the EXISTING canonical review-ready artifact for a bound session. Reuses
// the review-ready primitive's filename scheme — no second review truth is
// constructed; if the canonical artifact has not been projected yet, the
// resolver returns NO_REVIEW_PACKET (fail-closed, no fabrication).
//
// LEAF INVARIANT: this module imports only stdlib + runtime-sandbox +
// review-ready. It must never import adapters, control-loop, review-evidence,
// gemini-pre-review, or gpt-final-review — the evidence graph
// (review-evidence -> {review-packet, control-loop}, adapters/gemini/gpt ->
// review-evidence) stays acyclic.

import fs from 'node:fs';
import path from 'node:path';
import { readSessionRecord } from '../runtime-sandbox/runtime-sandbox.mjs';
import { DEFAULT_REVIEW_READY_DIR } from '../review-ready/review-ready.mjs';

export function packetPathFor({ reviewReadyDir = null, sessionPath = null } = {}) {
  let session = null;
  if (sessionPath) {
    const rs = readSessionRecord(sessionPath);
    if (rs.ok) session = rs.session;
  }
  if (!session) return { ok: false, code: 'NO_REVIEW_PACKET' };
  const repo = typeof session.repo === 'string' ? session.repo : '';
  const issue = Number(session.issueNumber);
  if (!repo || !Number.isInteger(issue) || issue <= 0) return { ok: false, code: 'NO_REVIEW_PACKET' };
  // The review-ready projection dir is the review-ready primitive's own
  // default (~/.soc-brain/review-ready) unless explicitly overridden — the
  // artifact is a global (repo, issue) projection, not state-root local.
  const dir = reviewReadyDir || DEFAULT_REVIEW_READY_DIR();
  // Prefix mirror of review-ready's buildReviewReadyFilename (pr/headSha are
  // per-HEAD components, unknown at resolve time). Match is CASE-INSENSITIVE:
  // the session stores the canonical lowercase repo ('.../soc_brain') while the
  // artifact slug preserves the handoff identity casing ('.../Soc_brain').
  //   <repo-with-/-replaced-by-_>_Issue-<n>_PR-<p>_<7-hex>_review-ready.md
  const prefix = `${repo.replace(/\//g, '_').replace(/[^A-Za-z0-9._-]+/g, '_')}_Issue-${issue}_PR-`.toLowerCase();
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { ok: false, code: 'NO_REVIEW_PACKET' }; // no review-ready dir yet
  }
  const matches = entries
    .filter((e) => e.isFile()
      && e.name.toLowerCase().startsWith(prefix)
      && e.name.toLowerCase().endsWith('_review-ready.md'))
    .map((e) => path.join(dir, e.name))
    .sort()
    .reverse(); // newest first (fallback; exact-head match preferred below)
  if (!matches.length) return { ok: false, code: 'NO_REVIEW_PACKET' };
  // Issue #83: the packet MUST match the session's current head. Pure lexical
  // "newest first" breaks on short-sha ordering (a rework round's new 7-hex
  // may sort BELOW round 1's), silently handing reviewers a STALE packet. An
  // exact current-head match wins; newest-first is only the fallback.
  const currentHead = typeof session.headSha === 'string' ? session.headSha.toLowerCase() : null;
  const exact = currentHead
    ? matches.filter((p) => path.basename(p).toLowerCase().includes(`_${currentHead.slice(0, 7)}_`))
    : [];
  const chosen = exact.length ? exact[0] : matches[0];
  return { ok: true, packetPath: chosen, filename: path.basename(chosen) };
}
