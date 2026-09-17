#!/usr/bin/env node
// review-leg-adapter.mjs — control-loop PRE_REVIEWING adapter for the
// REVIEW-ONLY OCR/OpenCode leg (Issue #4C/#4E).
//
// This adapter is the production replacement for the Gemini pre-review seam:
// runControlLoop wires it as `deps.preReview`. Same call shape
// ({sessionPath, report, reviewReadyDir}) -> {ok, value|code}, same
// fail-closed conventions, but the value is ReviewEvidence v1
// ({source:'ocr-review-leg', canonical, digest, findingsCount, batch}).
//
// Authority: pure evidence plumbing. No loop token, no terminalize, no
// delivery, no merge, no session write. Target derives from the authoritative
// canonical session record (never dirty workspace).
//
// Resume (4E): evidence persists atomically under
// <stateDir>/review-evidence/<identityHash>.json and is reused ONLY when it
// re-validates AND binds exactly to identityHash/repo/issue/baseSha/headSha/
// target (+ ocr version). Anything else reruns the leg. Legacy Gemini ledger
// shapes are never converted: resolveResumePreReview returns
// RESUME_PRE_REVIEW_SHAPE_MISMATCH unless a fresh leg run succeeds.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readSessionRecord } from '../runtime-sandbox/runtime-sandbox.mjs';
import { identityHash as workspaceIdentityHash } from '../workspace/workspace.mjs';
import { runReviewOnlyLeg } from '../review-leg/review-only.mjs';
// Authority & persistence semantics (Issue #4R F02 determination: option B):
// the AUTHORITATIVE resume state is the canonical transition ledger —
// control-loop.mjs persists the full preReview VALUE as the PRE_REVIEWING ->
// FINAL_REVIEWING transition evidence (loop.step capture) and resume
// re-enters from that ledger evidence (pRec), never from this file. This JSON
// envelope is a dispatch-dedup CACHE only: it lets a re-entered preReview step
// skip a duplicate model run when nothing changed. Consequences:
// - cache save failure NEVER blocks: the leg result still returns, the GPT /
//   final-review path still runs, and REVIEW_EVIDENCE_SAVE_FAILED is a helper
//   code only (never a loop transition blocker);
// - resume/no-duplicate invariants (rework dispatch, delivery, merge, close,
//   TASK_COMPLETED) rest on ledger markers + the exactly-once delivery ledger,
//   never on this cache;
// - telemetry stays best-effort and can never surface as SAVE_FAILED.
import {
  validateReviewEvidence,
  isLegacyGeminiPreReview,
  RESUME_PRE_REVIEW_SHAPE_MISMATCH,
} from './review-delegate-evidence.mjs';
import { runOcrRule, resolveOcrExecutable, readOcrVersion } from '../review-leg/review-only.mjs';

export const REVIEW_LEG_ADAPTER_VERSION = '1';
export const REVIEW_EVIDENCE_DIRNAME = 'review-evidence';
export const REVIEW_EVIDENCE_CACHE_KIND = 'review-evidence-cache';
const SHA40_RE = /^[0-9a-f]{40}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;

function fail(code, detail) { return { ok: false, code, detail: detail ?? null }; }

function tele(sink, event, detail) {
  try {
    if (sink && typeof sink.record === 'function') sink.record(event, detail);
  } catch { /* telemetry never breaks the review leg */ }
}

export function evidencePathFor({ stateDir, identityHash }) {
  return path.join(path.resolve(stateDir), REVIEW_EVIDENCE_DIRNAME, `${identityHash}.json`);
}

// Atomic cache write (tmp+rename). Envelope carries rulesDigest (F01) so the
// resume cache binds to the actual semantic rule payload. Best-effort for the
// caller by design (F02): a save failure never invalidates live evidence.
export function saveReviewEvidence({ stateDir, identityHash, record, rulesDigest }) {
  if (typeof stateDir !== 'string' || !stateDir) return fail('REVIEW_EVIDENCE_SAVE_FAILED', 'stateDir required');
  if (typeof identityHash !== 'string' || !identityHash) return fail('REVIEW_EVIDENCE_SAVE_FAILED', 'identityHash required');
  if (!record || typeof record !== 'object') return fail('REVIEW_EVIDENCE_SAVE_FAILED', 'record required');
  if (typeof rulesDigest !== 'string' || !SHA256_RE.test(rulesDigest)) {
    return fail('REVIEW_EVIDENCE_SAVE_FAILED', 'rulesDigest must be 64-hex');
  }
  try {
    const p = evidencePathFor({ stateDir, identityHash });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ schemaVersion: '1', kind: REVIEW_EVIDENCE_CACHE_KIND, savedAt: new Date().toISOString(), rulesDigest, value: record }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, p);
    return { ok: true, path: p };
  } catch (e) {
    return fail('REVIEW_EVIDENCE_SAVE_FAILED', String((e && e.message) || e));
  }
}

export function loadReviewEvidence({ stateDir, identityHash }) {
  const p = evidencePathFor({ stateDir, identityHash });
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch {
    return fail('REVIEW_EVIDENCE_ABSENT', 'no persisted review evidence');
  }
  let doc;
  try { doc = JSON.parse(raw); } catch (e) {
    return fail('REVIEW_EVIDENCE_MALFORMED', `persisted evidence unparseable: ${String((e && e.message) || e)}`);
  }
  if (!doc || typeof doc !== 'object' || !doc.value || typeof doc.value !== 'object') {
    return fail('REVIEW_EVIDENCE_MALFORMED', 'persisted evidence envelope malformed');
  }
  const v = validateReviewEvidence(doc.value.canonical);
  if (!v.ok) return fail('REVIEW_EVIDENCE_MALFORMED', `persisted canonical invalid: ${v.code}`);
  // F01.7: old envelopes (or tampered ones) without a well-formed rulesDigest
  // are stale, never converted or trusted alone.
  if (typeof doc.rulesDigest !== 'string' || !SHA256_RE.test(doc.rulesDigest)) {
    return fail('REVIEW_EVIDENCE_STALE', 'persisted rulesDigest missing or malformed; rerun required');
  }
  return { ok: true, value: doc.value, rulesDigest: doc.rulesDigest.toLowerCase(), path: p };
}

const norm = (v) => (typeof v === 'string' ? v.toLowerCase() : v);

// Exact-bound reuse gate: persisted canonical must echo every binding field
// and the exact target. OCR version is pinned too (rule/content drift across
// OCR upgrades must not silently reuse).
export function isFreshEvidence(canonical, { binding, target, ocrVersion }) {
  if (!canonical || typeof canonical !== 'object') return false;
  const b = canonical.binding;
  if (!b || typeof b !== 'object') return false;
  if (norm(b.identityHash) !== norm(binding.identityHash)) return false;
  if (String(b.repo).toLowerCase() !== String(binding.repo).toLowerCase()) return false;
  if (Number(b.issueNumber) !== Number(binding.issueNumber)) return false;
  if (norm(b.baseSha) !== norm(binding.baseSha)) return false;
  if (norm(b.headSha) !== norm(binding.headSha)) return false;
  const t = canonical.target;
  if (!t || t.mode !== target.mode) return false;
  if (target.mode === 'range' && (norm(t.from) !== norm(target.from) || norm(t.to) !== norm(target.to))) return false;
  if (target.mode === 'commit' && norm(t.commit) !== norm(target.commit)) return false;
  if (ocrVersion !== undefined && canonical.ocr && norm(canonical.ocr.version) !== norm(ocrVersion)) return false;
  return true;
}

export function deriveReviewTarget(session) {
  if (!session || typeof session !== 'object') return fail('REVIEW_TARGET_UNAVAILABLE', 'session required');
  if (typeof session.baseSha !== 'string' || !SHA40_RE.test(session.baseSha)) {
    return fail('REVIEW_TARGET_UNAVAILABLE', 'session.baseSha must be 40-hex');
  }
  if (typeof session.headSha !== 'string' || !SHA40_RE.test(session.headSha)) {
    return fail('REVIEW_TARGET_UNAVAILABLE', 'session.headSha must be 40-hex');
  }
  return { ok: true, target: { mode: 'range', from: session.baseSha, to: session.headSha } };
}

// Legacy resume helper (4E.4): a ledger preReview shaped like legacy Gemini
// evidence is NEVER converted or fabricated into OCR evidence. Rerun the new
// leg where the lifecycle permits; otherwise fail closed with the stable
// resume code.
//
// Discrimination subtlety: a GPT REWORK/DECIDING decision
// ({verdict, findings, confidence, metadata, binding, evidenceRequests}) is
// structurally a superset of the legacy shape, and rework rounds store the
// DECISION as the latest PRE_REVIEWING->FINAL_REVIEWING ledger evidence. Only
// a genuine adapter output (no decision binding echo, no evidenceRequests) is
// legacy; decision-shaped ledger evidence passes through exactly as before
// (pre-existing resume behavior unchanged).
export function isGenuineLegacyPreReview(ev) {
  if (!isLegacyGeminiPreReview(ev)) return false;
  if (ev.binding && typeof ev.binding === 'object') return false;
  if (Array.isArray(ev.evidenceRequests)) return false;
  return true;
}

export async function resolveResumePreReview({ preReviewDep, sessionPath, report, reviewReadyDir, pRecEvidence }) {
  if (pRecEvidence && isGenuineLegacyPreReview(pRecEvidence)) {
    if (typeof preReviewDep !== 'function') {
      return fail(RESUME_PRE_REVIEW_SHAPE_MISMATCH, 'legacy preReview shape with no leg to rerun');
    }
    let fresh = null;
    try {
      fresh = await preReviewDep({ sessionPath, report, reviewReadyDir: reviewReadyDir ?? null });
    } catch (e) {
      return fail(RESUME_PRE_REVIEW_SHAPE_MISMATCH, `leg rerun threw: ${String((e && e.message) || e)}`);
    }
    if (!fresh || fresh.ok !== true) {
      return fail(RESUME_PRE_REVIEW_SHAPE_MISMATCH, `leg rerun failed: ${(fresh && fresh.code) || 'unknown'}`);
    }
    const v = fresh.result && fresh.result.value ? fresh.result.value : fresh.value;
    return { ok: true, preReview: v };
  }
  return { ok: true, preReview: pRecEvidence ?? null };
}

export function reviewLegPreReviewAdapter({
  controlRepo = null,
  model = null,
  timeoutMs,
  ocr,
  ocrExec,
  telemetry = null,
  runLeg = runReviewOnlyLeg,
} = {}) {
  return async function preReview({ sessionPath, report, reviewReadyDir }) {
    void report;
    void reviewReadyDir;
    const rs = readSessionRecord(sessionPath);
    if (!rs.ok) return { ok: false, code: rs.reason || 'SESSION_READ_FAILED' };
    const session = rs.session;
    const sd = session.controlPlane && session.controlPlane.stateDir;
    if (!sd) return { ok: false, code: 'STATE_DIR_UNAVAILABLE' };
    const id = workspaceIdentityHash({ repo: session.repo, issueNumber: session.issueNumber });
    if (!id) return { ok: false, code: 'REVIEW_IDENTITY_INVALID' };
    const tg = deriveReviewTarget(session);
    if (!tg.ok) return tg;
    const binding = { identityHash: id, repo: session.repo, issueNumber: session.issueNumber, baseSha: session.baseSha, headSha: session.headSha };
    const repo = controlRepo || process.cwd();
    const execForOcr = ocrExec || execFileSync;
    const reused = tryReuseCachedEvidence({ sd, id, binding, target: tg.target, repo, ocr, execForOcr, telemetry });
    if (reused) return reused;
    const r = runLeg({
      repo: session.repo,
      issueNumber: session.issueNumber,
      identityHash: id,
      baseSha: session.baseSha,
      headSha: session.headSha,
      targetMode: 'range',
      model,
      controlRepo: repo,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(ocr !== undefined ? { ocr } : {}),
      telemetry,
    });
    const leg = (r && typeof r.then === 'function') ? await r : r;
    if (!leg || leg.ok !== true) {
      tele(telemetry, 'REVIEW_LEG_FAILED', { code: leg && leg.code });
      return { ok: false, code: (leg && leg.code) || 'REVIEW_LEG_FAILED', detail: (leg && leg.detail) ?? null };
    }
    const value = {
      source: 'ocr-review-leg',
      schemaVersion: '1',
      canonical: leg.value.canonical,
      digest: leg.value.digest,
      findingsCount: leg.value.findingsCount,
      batch: leg.batch ?? null,
    };
    // Cache write is best-effort (F02): live evidence stands regardless.
    const kept = typeof leg.rulesDigest === 'string'
      ? saveReviewEvidence({ stateDir: sd, identityHash: id, record: value, rulesDigest: leg.rulesDigest })
      : fail('REVIEW_EVIDENCE_SAVE_FAILED', 'leg produced no rulesDigest; cache skipped');
    tele(telemetry, 'REVIEW_LEG_SAVED', { digest: value.digest, rulesDigest: leg.rulesDigest ?? null, saved: kept.ok === true });
    return { ok: true, value };
  };
}

// Reuse gate (F01): persisted value re-validated + exact binding/target +
// current OCR version + current rulesDigest re-derived from a fresh
// `ocr delegate rule` over the canonical scope. Returns the reuse result, or
// null when the leg must run. A rule-derivation failure fails closed (no GPT)
// instead of reusing blindly.
function tryReuseCachedEvidence({ sd, id, binding, target, repo, ocr, execForOcr, telemetry }) {
  const saved = loadReviewEvidence({ stateDir: sd, identityHash: id });
  if (!saved.ok) return null;
  if (!isFreshEvidence(saved.value.canonical, { binding, target })) return null;
  let ocrVal = ocr !== undefined ? ocr : null;
  if (!ocrVal) {
    const auto = resolveOcrExecutable({ exec: execForOcr });
    if (!auto.ok) return auto;
    ocrVal = auto.ocr;
  }
  const ver = readOcrVersion({ ocr: ocrVal, exec: execForOcr });
  if (!ver.ok) return ver;
  if (String(saved.value.canonical.ocr.version).toLowerCase() !== ver.version.toLowerCase()) return null;
  const scope = saved.value.canonical.reviewableFiles;
  const rule = runOcrRule({ ocr: ocrVal, repo, from: binding.baseSha, to: binding.headSha, paths: scope, exec: execForOcr });
  if (!rule.ok) return { ok: false, code: rule.code, detail: rule.detail };
  if (rule.value.rulesDigest !== saved.rulesDigest) return null;
  tele(telemetry, 'REVIEW_LEG_REUSED', { digest: saved.value.digest, rulesDigest: saved.rulesDigest, findingsCount: saved.value.findingsCount ?? null });
  return { ok: true, value: saved.value };
}
