// review-eval.mjs — review evaluation persistence (Issue #100, remaining #92 scope).
//
// Append-only, identity-scoped ledger of semantic review outcomes:
//   <stateDir>/review-eval/<identityHash>/evaluations.jsonl
// One JSON record per line, fsync'd per append. The store is analytics
// evidence (verdict/score/findings count/step latency + a sha256 digest of
// the exact review value + the sha256 of the exact packet excerpt the
// reviewer saw — packetEvidence binding) — it is NEVER a second review truth:
// the canonical decision chain stays owned by the control-loop transition
// ledger and the session record. Fail-closed on contract violations (bad
// kind, review not ok, missing model identity, missing packet evidence); the
// loop isolates sink failures.
//
// Zero new deps: node:crypto + node:fs only.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const REVIEW_EVAL_SCHEMA_VERSION = 1;
export const REVIEW_EVAL_KINDS = Object.freeze(['PRE_REVIEW', 'FINAL_REVIEW']);

function evaluationsPathFor({ stateDir, identityHash: id }) {
  return path.join(stateDir, 'review-eval', id, 'evaluations.jsonl');
}

// Deterministic JSON (sorted keys, recursive) so the same logical review value
// always hashes to the same digest, independent of property insertion order.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

// Atomic append: one write + fsync on a file opened in append mode. The record
// is newline-terminated JSON; a crash can lose at most the in-flight line.
function appendLineAtomic(fp, line) {
  const fd = fs.openSync(fp, 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function appendReviewEvaluation({ stateDir, identityHash: id, kind, review, reviewDurationMs } = {}) {
  if (typeof stateDir !== 'string' || !stateDir) return { ok: false, code: 'STATE_DIR_INVALID' };
  if (typeof id !== 'string' || !id) return { ok: false, code: 'IDENTITY_HASH_INVALID' };
  if (!REVIEW_EVAL_KINDS.includes(kind)) {
    return { ok: false, code: 'KIND_INVALID', detail: `kind=${String(kind)}` };
  }
  if (!review || typeof review !== 'object' || Array.isArray(review) || review.ok !== true
    || !review.value || typeof review.value !== 'object' || Array.isArray(review.value)) {
    return { ok: false, code: 'REVIEW_INVALID', detail: 'review must be an ok:true envelope with a value object' };
  }
  const model = review.value.metadata && typeof review.value.metadata === 'object' && !Array.isArray(review.value.metadata)
    ? review.value.metadata.model
    : undefined;
  // PR #99 contract: adapters ALWAYS stamp a non-empty metadata.model on a
  // successful review value. Absence here is a contract violation, never coerced.
  if (typeof model !== 'string' || !model) {
    return { ok: false, code: 'MODEL_INVALID', detail: 'review.value.metadata.model must be a non-empty string' };
  }
  // Issue #100 (rework): the evaluation must be cryptographically bound to the
  // canonical review-ready packet it evaluated. Adapters stamp the exact-evidence
  // identity into metadata.packet ({ name, sha256, truncated } via packetEvidence,
  // covering the EXACT excerpt bytes rendered into the reviewer prompt). Absence
  // is a contract violation, never coerced — fail closed like MODEL_INVALID.
  const packet = review.value.metadata.packet;
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)
    || typeof packet.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(packet.sha256)
    || typeof packet.name !== 'string' || !packet.name) {
    return { ok: false, code: 'PACKET_EVIDENCE_INVALID', detail: 'review.value.metadata.packet must be { name, sha256, truncated } with a 64-hex sha256' };
  }
  const record = {
    schemaVersion: REVIEW_EVAL_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    kind,
    identityHash: id,
    verdict: review.value.verdict ?? null,
    score: review.value.score ?? null,
    findingsCount: Array.isArray(review.value.findings) ? review.value.findings.length : null,
    durationMs: Number.isFinite(reviewDurationMs) ? reviewDurationMs : null,
    digest: createHash('sha256').update(canonicalJson(review.value), 'utf8').digest('hex'),
    // Evidence binding: sha256 of the exact packet excerpt the reviewer saw.
    packetSha256: packet.sha256,
    packetName: packet.name,
    packetTruncated: packet.truncated === true,
  };
  const fp = evaluationsPathFor({ stateDir, identityHash: id });
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    appendLineAtomic(fp, `${JSON.stringify(record)}\n`);
  } catch (e) {
    return { ok: false, code: 'EVAL_APPEND_FAILED', detail: String((e && e.message) || e) };
  }
  return { ok: true, value: { record, path: fp } };
}

export function readReviewEvaluations({ stateDir, identityHash: id } = {}) {
  if (typeof stateDir !== 'string' || !stateDir || typeof id !== 'string' || !id) return [];
  const fp = evaluationsPathFor({ stateDir, identityHash: id });
  let raw;
  try { raw = fs.readFileSync(fp, 'utf8'); } catch { return []; } // missing storage => [], not an error
  return raw.split('\n').filter(Boolean).map((l) => {
    try {
      const r = JSON.parse(l);
      return r && typeof r === 'object' && !Array.isArray(r) ? r : null;
    } catch { return null; } // skip malformed lines
  }).filter(Boolean);
}

export function compareReviewEvaluations(records) {
  const list = Array.isArray(records) ? records : [];
  const byKind = {};
  const byVerdict = {};
  const pairs = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    if (r.verdict !== null && r.verdict !== undefined) {
      byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
    }
  }
  // Issue #100 (rework): evidence-bound Gemini-vs-GPT comparison. A PRE/FINAL
  // pair is comparable ONLY when both evaluations carried the SAME packet
  // evidence (same packetSha256 — the exact excerpt both reviewers saw).
  const pre = list.filter((r) => r && r.kind === 'PRE_REVIEW');
  const fin = list.filter((r) => r && r.kind === 'FINAL_REVIEW');
  for (const p of pre) {
    // Pair each pre-review with the EARLIEST final review (file order) that
    // evaluated the same packet evidence.
    const f = fin.find((c) => c.packetSha256 && c.packetSha256 === p.packetSha256);
    if (!f) continue;
    pairs.push({
      packetSha256: p.packetSha256,
      packetName: p.packetName ?? null,
      packetTruncated: p.packetTruncated === true,
      pre: { verdict: p.verdict ?? null, digest: p.digest ?? null, durationMs: p.durationMs ?? null },
      final: { verdict: f.verdict ?? null, digest: f.digest ?? null, durationMs: f.durationMs ?? null },
      sameVerdict: (p.verdict ?? null) === (f.verdict ?? null),
    });
    fin.splice(fin.indexOf(f), 1); // each final pairs at most once
  }
  return { total: list.length, byKind, byVerdict, pairs };
}
