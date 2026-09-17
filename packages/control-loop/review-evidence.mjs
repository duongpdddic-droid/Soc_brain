#!/usr/bin/env node
// review-evidence.mjs — canonical review-evidence selection (Issue #1, OCR migration).
//
// Pure move (verbatim, byte-equivalent) from gemini-pre-review.mjs (Issue #75
// P0-C): parsePacketIdentity + collectPreReviewEvidence + the bounds they
// depend on. No Gemini semantics live here: this module never calls a model,
// never receives the loop token, never terminalizes, and never writes the
// canonical session record. Consumers: gemini-pre-review.mjs (re-export, Issue
// #75 path unchanged), gpt-final-review.mjs (canonical evidence, Issue #77),
// and the future OCR ReviewDelegate (same evidence gate, skipped==0).

import fs from 'node:fs';
import path from 'node:path';
import { readSessionRecord } from '../runtime-sandbox/runtime-sandbox.mjs';
import { readTransitions } from './control-loop.mjs';
import { packetPathFor } from './review-packet.mjs';

export const PRE_REVIEW_PACKET_MAX_BYTES = 64 * 1024; // canonical packet excerpt bound (64 KiB — Issue #83 leg-9: the real GPT reviewer could not semantically review a truncated 8 KiB packet)
export const PRE_REVIEW_LEDGER_MAX = 50;             // last N transitions included

// Parse the canonical Identity block that review-ready's renderReviewReady
// writes into every packet. Returns ok:false when any required identity field
// is missing or garbled — such a file is not canonical evidence.
export function parsePacketIdentity(content) {
  const text = typeof content === 'string' ? content : '';
  const grab = (re) => { const m = re.exec(text); return m ? m[1] : null; };
  const repository = grab(/^- repository:\s*(\S[^\r\n]*?)\s*$/im);
  const issueRaw = grab(/^- issue:\s*(\d+)\s*$/im);
  const headSha = grab(/^- headSha:\s*([0-9a-f]{40})(?:\s*\(short\s+[0-9a-f]+\))?/im);
  if (!repository || issueRaw === null || !headSha) {
    return { ok: false, detail: 'packet missing canonical Identity block (repository/issue/headSha)' };
  }
  return { ok: true, repository, issue: Number(issueRaw), headSha: headSha.toLowerCase() };
}

// ---- 1. canonical evidence selection ----------------------------------------
export function collectPreReviewEvidence({ sessionPath, report, reviewReadyDir = null } = {}) {
  const rs = readSessionRecord(sessionPath);
  if (!rs.ok) return { ok: false, code: rs.reason || 'SESSION_STATE_INVALID' };
  const session = rs.session;
  // Canonical loop ledger: <stateDir>/control-loop/<identityHash>/transitions.jsonl,
  // derived from the session's own canonical control-plane location (enforced
  // by readSessionRecord above).
  const stateDir = path.dirname(path.dirname(sessionPath));
  const identityHash = path.basename(sessionPath, '.json');
  const ledger = readTransitions({ stateDir, identityHash }).slice(-PRE_REVIEW_LEDGER_MAX);
  // Canonical review-ready packet = REQUIRED canonical semantic review
  // evidence (D8, round-3 rework): without it Gemini has no canonical review
  // basis, so the pre-review FAILS CLOSED — no transport call, no substitute.
  const packet = packetPathFor({ reviewReadyDir, sessionPath });
  if (!packet.ok) return { ok: false, code: packet.code || 'NO_REVIEW_PACKET' };
  let raw = null;
  try { raw = fs.readFileSync(packet.packetPath); } catch { raw = null; }
  if (!raw) return { ok: false, code: 'REVIEW_PACKET_UNREADABLE', detail: packet.filename || null };
  if (!raw.toString('utf8').trim()) return { ok: false, code: 'REVIEW_PACKET_UNREADABLE', detail: 'empty packet' };
  // Identity gate: the packet must self-identify with the session's canonical
  // (repo, issue) and a full 40-hex headSha. Foreign identity or a stale
  // headSha (when the session pins one) is refused — fail closed.
  const ident = parsePacketIdentity(raw.toString('utf8'));
  if (!ident.ok) return { ok: false, code: 'REVIEW_PACKET_IDENTITY_MISMATCH', detail: ident.detail };
  if (String(ident.repository).toLowerCase() !== String(session.repo).toLowerCase()
    || Number(ident.issue) !== Number(session.issueNumber)) {
    return { ok: false, code: 'REVIEW_PACKET_IDENTITY_MISMATCH', detail: `packet=${ident.repository}#${ident.issue} session=${session.repo}#${session.issueNumber}` };
  }
  if (typeof session.headSha === 'string' && /^[0-9a-f]{40}$/i.test(session.headSha)
    && ident.headSha !== session.headSha.toLowerCase()) {
    return { ok: false, code: 'REVIEW_PACKET_STALE', detail: `packet headSha=${ident.headSha} session headSha=${session.headSha.toLowerCase()}` };
  }
  const truncated = raw.length > PRE_REVIEW_PACKET_MAX_BYTES;
  const packetInfo = {
    ok: true,
    code: null,
    name: packet.filename,
    excerpt: raw.subarray(0, PRE_REVIEW_PACKET_MAX_BYTES).toString('utf8'),
    truncated,
  };
  return { ok: true, session, ledger, packet: packetInfo, report: report && typeof report === 'object' ? report : {} };
}
