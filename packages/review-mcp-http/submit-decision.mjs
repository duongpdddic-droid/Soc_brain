// submit-decision.mjs — Soc_brain: canonical review decision submission (Phase 3 = Issue #43).
//
// Pure module (zero IO on the network, zero GitHub IO, zero broker/executor IO).
// Performs validation + canonical ReviewResult persistence for the
// `review.submit_decision` tool, called from `packages/review-mcp-http`.
//
// Boundary (deliberate):
//   - Reuses `redactSecrets` from `review-mcp-http.mjs` (single SSOT).
//   - Reuses the canonical review-ready artifact path/builder/verifier
//     (REVIEW HANDOFF CONTRACT v1.0.0) from `packages/review-ready`.
//   - Writes ONE file under `<dir>/_decisions/<repo>_Issue-<n>_PR-<n>_<headSha>_<requestDigest12>.json`.
//   - Refuses symlinks (lstatSync, never follows) — per GPT-REV-134.
//   - Atomic write: write to tmp file, fsync, then rename.
//   - Idempotent at the deterministic path: identical payload → DUPLICATE_NOOP
//     (no second write, returns the same persistedAt/digest); different verdict
//     for the same identity+digest → DUPLICATE_CONFLICT.
//   - Verdict at MCP boundary: PASS / REWORK / BLOCKED (mapped to canonical
//     APPROVED / CHANGES_REQUESTED / BLOCKED inside this module only).
//   - submittedBy is an opaque label, NOT an authority.
//
// Out of scope: any GitHub IO, any task FSM mutation, any merge authority,
// any executor/broker call. Authority to "decide if PASS is good enough"
// remains the existing task FSM and approval gate.

import { createHash } from 'node:crypto';
import {
  lstatSync, mkdirSync, openSync, closeSync,
  fsyncSync, renameSync, readFileSync, existsSync, unlinkSync,
  writeSync,
} from 'node:fs';
import { resolve } from 'node:path';

const REPO_RE = /^(?!\.)(?!.*\.\.)[A-Za-z0-9_.-]+\/(?!\.)(?!.*\.\.)[A-Za-z0-9_.-]+$/;
const HEAD_SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const DECISION_DIR_NAME = '_decisions';

export const SUBMIT_BOUNDS = Object.freeze({
  decisionFileMaxBytes: 256 * 1024,
  findingsMaxCount: 64,
  findingTextMaxBytes: 8 * 1024,
  findingsTotalMaxBytes: 64 * 1024,
  evidenceRequestsMaxCount: 32,
  evidenceRequestNoteMaxBytes: 2 * 1024,
  metadataMaxBytes: 4 * 1024,
  submittedByMaxChars: 128,
});

export const BOUNDARY_VERDICTS = Object.freeze(['PASS', 'REWORK', 'BLOCKED']);

const CANONICAL_VERDICT = Object.freeze({
  PASS: 'APPROVED',
  REWORK: 'CHANGES_REQUESTED',
  BLOCKED: 'BLOCKED',
});
function parseIdentity(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, errors: [{ field: 'args', code: 'ARGS_INVALID', message: 'args phải là object' }] };
  }
  const errors = [];
  const repository = args.repository;
  if (typeof repository !== 'string' || !REPO_RE.test(repository)) {
    errors.push({ field: 'repository', code: 'REPO_INVALID', message: `repository phải dạng owner/name canonical: ${String(repository)}` });
  }
  const issueRaw = args.issue;
  const issue = Number(issueRaw);
  if (!Number.isInteger(issue) || issue <= 0) {
    errors.push({ field: 'issue', code: 'ISSUE_INVALID', message: `issue phải là số nguyên dương: ${String(issueRaw)}` });
  }
  const headSha = args.headSha;
  if (typeof headSha !== 'string' || !HEAD_SHA_RE.test(headSha.toLowerCase())) {
    errors.push({ field: 'headSha', code: 'HEAD_SHA_INVALID', message: `headSha phải là sha1 hex 40 ký tự: ${String(headSha)}` });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, identity: { repository, issue, headSha: headSha.toLowerCase() } };
}

function safeString(v, max) {
  if (typeof v !== 'string') return null;
  if (v.length > max) return null;
  return v;
}

function validateFindings(raw) {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: { field: 'findings', code: 'FINDINGS_NOT_ARRAY', message: 'findings phải là array' } };
  if (raw.length > SUBMIT_BOUNDS.findingsMaxCount) {
    return { ok: false, error: { field: 'findings', code: 'FINDINGS_TOO_MANY', message: `findings tối đa ${SUBMIT_BOUNDS.findingsMaxCount} entries` } };
  }
  let total = 0;
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const f = raw[i];
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      return { ok: false, error: { field: `findings[${i}]`, code: 'FINDING_NOT_OBJECT', message: 'finding phải là object' } };
    }
    const severity = safeString(f.severity, 32);
    const text = safeString(f.text, SUBMIT_BOUNDS.findingTextMaxBytes);
    const code = safeString(f.code, 64);
    if (text === null) {
      return { ok: false, error: { field: `findings[${i}].text`, code: 'FINDING_TEXT_TOO_LARGE', message: `finding.text tối đa ${SUBMIT_BOUNDS.findingTextMaxBytes} bytes` } };
    }
    total += Buffer.byteLength(text, 'utf8');
    if (total > SUBMIT_BOUNDS.findingsTotalMaxBytes) {
      return { ok: false, error: { field: 'findings', code: 'FINDINGS_TOTAL_TOO_LARGE', message: `tổng bytes findings tối đa ${SUBMIT_BOUNDS.findingsTotalMaxBytes}` } };
    }
    out.push({ severity: severity || null, code: code || null, text });
  }
  return { ok: true, value: out };
}

function validateEvidenceRequests(raw) {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: { field: 'evidenceRequests', code: 'EVIDENCE_REQUESTS_NOT_ARRAY', message: 'evidenceRequests phải là array' } };
  if (raw.length > SUBMIT_BOUNDS.evidenceRequestsMaxCount) {
    return { ok: false, error: { field: 'evidenceRequests', code: 'EVIDENCE_REQUESTS_TOO_MANY', message: `tối đa ${SUBMIT_BOUNDS.evidenceRequestsMaxCount}` } };
  }
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      return { ok: false, error: { field: `evidenceRequests[${i}]`, code: 'EVIDENCE_REQUEST_NOT_OBJECT', message: 'evidenceRequest phải là object' } };
    }
    const kind = safeString(e.kind, 64);
    const note = safeString(e.note, SUBMIT_BOUNDS.evidenceRequestNoteMaxBytes);
    if (note === null) {
      return { ok: false, error: { field: `evidenceRequests[${i}].note`, code: 'EVIDENCE_REQUEST_NOTE_TOO_LARGE', message: `note tối đa ${SUBMIT_BOUNDS.evidenceRequestNoteMaxBytes} bytes` } };
    }
    out.push({ kind: kind || null, note });
  }
  return { ok: true, value: out };
}
function validateMetadata(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: { field: 'metadata', code: 'METADATA_NOT_OBJECT', message: 'metadata phải là object' } };
  }
  for (const v of Object.values(raw)) {
    if (v !== null && typeof v === 'object') {
      return { ok: false, error: { field: 'metadata', code: 'METADATA_TOO_DEEP', message: 'metadata chỉ chấp nhận 1 level (không nested object/array)' } };
    }
  }
  const serialized = JSON.stringify(raw);
  if (Buffer.byteLength(serialized, 'utf8') > SUBMIT_BOUNDS.metadataMaxBytes) {
    return { ok: false, error: { field: 'metadata', code: 'METADATA_TOO_LARGE', message: `metadata tối đa ${SUBMIT_BOUNDS.metadataMaxBytes} bytes serialized` } };
  }
  return { ok: true, value: raw };
}

function validateConfidence(raw) {
  if (raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    return { ok: false, error: { field: 'confidence', code: 'CONFIDENCE_OUT_OF_RANGE', message: 'confidence phải là number trong [0, 1]' } };
  }
  return { ok: true, value: raw };
}

function validateVerdict(raw) {
  if (typeof raw !== 'string' || !BOUNDARY_VERDICTS.includes(raw)) {
    return { ok: false, error: { field: 'verdict', code: 'VERDICT_INVALID', message: `verdict phải là một trong: ${BOUNDARY_VERDICTS.join(', ')}` } };
  }
  return { ok: true, value: raw };
}

function validateDigests(args, errors) {
  const requestDigest = args.requestDigest;
  const contentDigest = args.contentDigest;
  if (typeof requestDigest !== 'string' || !DIGEST_RE.test(requestDigest)) {
    errors.push({ field: 'requestDigest', code: 'REQUEST_DIGEST_INVALID', message: 'requestDigest phải là sha256 hex 64 ký tự' });
  }
  if (typeof contentDigest !== 'string' || !DIGEST_RE.test(contentDigest)) {
    errors.push({ field: 'contentDigest', code: 'CONTENT_DIGEST_INVALID', message: 'contentDigest phải là sha256 hex 64 ký tự' });
  }
  return { requestDigest, contentDigest };
}

function validateSubmittedBy(raw) {
  if (raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > SUBMIT_BOUNDS.submittedByMaxChars) {
    return { ok: false, error: { field: 'submittedBy', code: 'SUBMITTED_BY_INVALID', message: `submittedBy phải là string ≤ ${SUBMIT_BOUNDS.submittedByMaxChars} chars` } };
  }
  return { ok: true, value: raw };
}

export function validateSubmission(args) {
  const id = parseIdentity(args);
  if (!id.ok) return { ok: false, errors: id.errors };
  const errors = [];
  const { requestDigest, contentDigest } = validateDigests(args, errors);

  const verdictRes = validateVerdict(args.verdict);
  if (!verdictRes.ok) errors.push(verdictRes.error);

  const findingsRes = validateFindings(args.findings);
  if (!findingsRes.ok) errors.push(findingsRes.error);

  const evRes = validateEvidenceRequests(args.evidenceRequests);
  if (!evRes.ok) errors.push(evRes.error);

  const confRes = validateConfidence(args.confidence);
  if (!confRes.ok) errors.push(confRes.error);

  const metaRes = validateMetadata(args.metadata);
  if (!metaRes.ok) errors.push(metaRes.error);

  const sbRes = validateSubmittedBy(args.submittedBy);
  if (!sbRes.ok) errors.push(sbRes.error);

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    submission: {
      identity: id.identity,
      requestDigest,
      contentDigest,
      verdict: verdictRes.value,
      canonicalVerdict: CANONICAL_VERDICT[verdictRes.value],
      findings: findingsRes.value,
      evidenceRequests: evRes.value,
      confidence: confRes.value,
      metadata: metaRes.value,
      submittedBy: sbRes.value,
    },
  };
}
export function buildDecisionFilename(submission) {
  const slug = submission.identity.repository.replace(/\//g, '_');
  const shortHead = submission.identity.headSha.slice(0, 7);
  const shortDigest = submission.requestDigest.slice(0, 12);
  return `${slug}_Issue-${submission.identity.issue}_PR-${submission.identity.issue}_${shortHead}_${shortDigest}.json`;
}

export function decisionPathFor(submission, { baseDir }) {
  return resolve(baseDir, DECISION_DIR_NAME, buildDecisionFilename(submission));
}

function assertNoSymlinkAt(filePath) {
  const dir = resolve(filePath, '..');
  if (existsSync(dir)) {
    const dl = lstatSync(dir);
    if (dl.isSymbolicLink()) {
      return { ok: false, code: 'ARTIFACT_IS_SYMLINK', message: `decision dir là symlink: ${dir}` };
    }
  }
  if (existsSync(filePath)) {
    const fl = lstatSync(filePath);
    if (fl.isSymbolicLink()) {
      return { ok: false, code: 'ARTIFACT_IS_SYMLINK', message: `decision file là symlink: ${filePath}` };
    }
  }
  return { ok: true };
}

export function computePayloadDigest(submission) {
  const canonical = {
    identity: submission.identity,
    requestDigest: submission.requestDigest,
    contentDigest: submission.contentDigest,
    verdict: submission.verdict,
    canonicalVerdict: submission.canonicalVerdict,
    findings: submission.findings,
    evidenceRequests: submission.evidenceRequests,
    confidence: submission.confidence,
    metadata: submission.metadata,
    submittedBy: submission.submittedBy,
  };
  const json = JSON.stringify(canonical, Object.keys(canonical).sort());
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

function readExistingDecision(filePath) {
  if (!existsSync(filePath)) return null;
  const st = lstatSync(filePath);
  if (st.isSymbolicLink()) return { error: { code: 'ARTIFACT_IS_SYMLINK', message: `decision file là symlink: ${filePath}` } };
  if (!st.isFile()) return { error: { code: 'DECISION_PERSIST_FAILED', message: 'path tồn tại nhưng không phải regular file' } };
  if (st.size > SUBMIT_BOUNDS.decisionFileMaxBytes) {
    return { error: { code: 'BOUNDED_PAYLOAD_EXCEEDED', message: `decision file vượt bound: ${st.size} > ${SUBMIT_BOUNDS.decisionFileMaxBytes}` } };
  }
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return { value: parsed };
  } catch (e) {
    return { error: { code: 'DECISION_PERSIST_FAILED', message: `parse lỗi: ${(e && e.message) || e}` } };
  }
}

function atomicWriteJson(filePath, payload) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, 'wx');
  try {
    const data = JSON.stringify(payload, null, 2);
    const buf = Buffer.from(data, 'utf8');
    if (buf.byteLength > SUBMIT_BOUNDS.decisionFileMaxBytes) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
      return { ok: false, code: 'BOUNDED_PAYLOAD_EXCEEDED', message: `payload ${buf.byteLength} > bound ${SUBMIT_BOUNDS.decisionFileMaxBytes}` };
    }
    writeSync(fd, buf, 0, buf.byteLength, 0);
    try { fsyncSync(fd); } catch { /* closeSync will flush */ }
    closeSync(fd);
    renameSync(tmp, filePath);
    return { ok: true, bytes: buf.byteLength };
  } catch (e) {
    try { closeSync(fd); } catch { /* ignore */ }
    try { unlinkSync(tmp); } catch { /* ignore */ }
    return { ok: false, code: 'DECISION_PERSIST_FAILED', message: (e && e.message) || String(e) };
  }
}
export function redactSubmission(submission, redactSecrets) {
  const walk = (v) => {
    if (typeof v === 'string') return redactSecrets(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return walk(submission);
}

export function verifyCanonicalDigests(submission, { dir, loadArtifact }) {
  const loaded = loadArtifact(submission.identity, { dir });
  if (!loaded.ok) {
    return { ok: false, code: loaded.error.code, message: loaded.error.message };
  }
  const m = /- reportDigest:\s*([0-9a-f]{64})/.exec(loaded.content);
  const requestDigestInArtifact = m ? m[1] : null;
  if (!requestDigestInArtifact) {
    return { ok: false, code: 'REQUEST_DIGEST_MISMATCH', message: 'canonical artifact thiếu reportDigest' };
  }
  const contentDigestInArtifact = createHash('sha256').update(loaded.content, 'utf8').digest('hex');
  if (submission.requestDigest !== requestDigestInArtifact) {
    return { ok: false, code: 'REQUEST_DIGEST_MISMATCH', message: `requestDigest không khớp artifact` };
  }
  if (submission.contentDigest !== contentDigestInArtifact) {
    return { ok: false, code: 'CONTENT_DIGEST_MISMATCH', message: `contentDigest không khớp artifact bytes` };
  }
  const ts = /- status:\s*\*\*([A-Z_]+)\*\*/.exec(loaded.content);
  if (!ts || ts[1] !== 'READY_FOR_REVIEW') {
    return { ok: false, code: 'ARTIFACT_NOT_READY', message: `canonical artifact terminalStatus !== READY_FOR_REVIEW` };
  }
  return { ok: true, requestDigest: requestDigestInArtifact, contentDigest: contentDigestInArtifact };
}

export function processSubmitDecision(args, deps) {
  const { redactSecrets, loadArtifact, baseDir } = deps;
  if (typeof redactSecrets !== 'function') return { ok: false, code: 'ARGS_INVALID', message: 'deps.redactSecrets thiếu' };
  if (typeof loadArtifact !== 'function') return { ok: false, code: 'ARGS_INVALID', message: 'deps.loadArtifact thiếu' };
  if (typeof baseDir !== 'string' || !baseDir) return { ok: false, code: 'ARGS_INVALID', message: 'deps.baseDir thiếu' };

  const validated = validateSubmission(args);
  if (!validated.ok) return { ok: false, errors: validated.errors };

  const submission = redactSubmission(validated.submission, redactSecrets);
  const verified = verifyCanonicalDigests(submission, { dir: baseDir, loadArtifact });
  if (!verified.ok) return { ok: false, code: verified.code, message: verified.message };

  const filePath = decisionPathFor(submission, { baseDir });
  const link = assertNoSymlinkAt(filePath);
  if (!link.ok) return { ok: false, code: link.code, message: link.message };

  const decDir = resolve(baseDir, DECISION_DIR_NAME);
  if (!existsSync(decDir)) {
    try { mkdirSync(decDir, { recursive: true }); } catch (e) {
      return { ok: false, code: 'DECISION_PERSIST_FAILED', message: `mkdir thất bại: ${(e && e.message) || e}` };
    }
  }

  const existing = readExistingDecision(filePath);
  if (existing && existing.error) return { ok: false, code: existing.error.code, message: existing.error.message };
  if (existing && existing.value) {
    const existingDigest = existing.value.payloadDigest;
    const newDigest = computePayloadDigest(submission);
    if (existingDigest === newDigest) {
      return {
        ok: true,
        persisted: false,
        code: 'DUPLICATE_NOOP',
        decision: existing.value,
        filePath,
        bytes: existing.value.bytes,
      };
    }
    return {
      ok: false,
      code: 'DUPLICATE_CONFLICT',
      message: `đã có decision khác tại deterministic path; existing payloadDigest=${existingDigest}, new=${newDigest}`,
    };
  }

  const payloadDigest = computePayloadDigest(submission);
  const now = new Date().toISOString();
  const record = {
    schemaVersion: '1.0.0',
    persistedAt: now,
    payloadDigest,
    identity: submission.identity,
    requestDigest: submission.requestDigest,
    contentDigest: submission.contentDigest,
    verdict: submission.verdict,
    canonicalVerdict: submission.canonicalVerdict,
    findings: submission.findings,
    evidenceRequests: submission.evidenceRequests,
    confidence: submission.confidence,
    metadata: submission.metadata,
    submittedBy: submission.submittedBy,
  };
  const written = atomicWriteJson(filePath, record);
  if (!written.ok) return { ok: false, code: written.code, message: written.message };

  return {
    ok: true,
    persisted: true,
    decision: { ...record, bytes: written.bytes },
    filePath,
    bytes: written.bytes,
  };
}
