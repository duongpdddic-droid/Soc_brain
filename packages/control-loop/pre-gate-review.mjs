// packages/control-loop/pre-gate-review.mjs — Issue PRE-GATE-REVIEW-01.
//
// Internal, READ-ONLY review that must run BEFORE the deterministic
// verifier (the required gate) on the production ControlLoop path. The
// composite wraps an existing verifier adapter: it reviews the exact
// candidate the gate is about to judge (same session record + same
// canonical execution record + same worktree content binding), and only
// when the review is a CLEAN APPROVED does it call the inner verifier —
// exactly once. Any finding, timeout, transport error, unsupported
// transport, or missing/stale binding is a typed fail: the inner
// verifier is never called and the result is never CLEAN.
//
// Reuse (no reimplementation):
//   - packages/ai-pr-reviewer-adapter: requestReview carries the
//     fail-closed status normalization, HEAD lock, correlation key,
//     redaction, and transport TIMEOUT race. The default transport is
//     UNSUPPORTED by design — a missing live transport is NOT CLEAN.
//   - packages/executor-launcher/execution-content-binding: the
//     candidate is re-stamped live and must equal the record's
//     codeContentDigest, else the candidate is considered stale.
//   - runtime-sandbox readSessionRecord / executor-launcher
//     readExecutionRecord: same canonical identity primitives the
//     deterministic verifier uses.

import path from 'node:path';

import { readSessionRecord } from '../runtime-sandbox/runtime-sandbox.mjs';
import { readExecutionRecord } from '../executor-launcher/executor-launcher.mjs';
import {
  computeWorktreeContentBinding,
  contentBindingFromRecord,
} from '../executor-launcher/execution-content-binding.mjs';
import { requestReview, defaultCallReviewer } from '../ai-pr-reviewer-adapter/ai-pr-reviewer-adapter.mjs';
import { loadRegistry } from '../project-registry/project-registry.mjs';

export const PRE_GATE_REVIEW_SCHEMA_VERSION = '1';

// Canonical source tag of the OCR internal-review record. The handoff gate
// (control-loop projectReviewReadyPacket -> resolveInternalReviewForHandoff)
// and the read-only handoff checklist both key on this exact value; an
// evidence object without it is never treated as an internal review.
export const INTERNAL_REVIEW_SOURCE = 'ocr-internal-review';

export const PRE_GATE_REVIEW_CODES = Object.freeze([
  'INTERNAL_REVIEW_SESSION_UNBOUND',
  'INTERNAL_REVIEW_EXECUTION_RECORD_MISSING',
  'INTERNAL_REVIEW_RECORD_STALE',
  'INTERNAL_REVIEW_PR_UNBOUND',
  'INTERNAL_REVIEW_CONTENT_BINDING_MISSING',
  'INTERNAL_REVIEW_CANDIDATE_STALE',
  'INTERNAL_REVIEW_PROJECT_UNBOUND',
  'INTERNAL_REVIEW_TRANSPORT',
  'INTERNAL_REVIEW_FINDINGS',
  'INTERNAL_REVIEW_NOT_APPROVED',
  'INTERNAL_REVIEW_TRANSPORT_EXCEPTION',
]);

function fail(code, detail = null) {
  return { ok: false, code, detail };
}

function defaultFindProjectId({ repo, registryPath } = {}) {
  let registry;
  try {
    registry = loadRegistry({ registryPath });
  } catch {
    return null;
  }
  const rawProjects = registry && typeof registry.projects === 'object' && registry.projects !== null ? registry.projects : {};
  const list = Array.isArray(rawProjects) ? rawProjects : Object.values(rawProjects);
  const target = String(repo || '').trim().toLowerCase();
  const hit = list.find(
    (p) => p && typeof p === 'object' && (String(p.canonicalRepository || p.repository || '').trim().toLowerCase() === target) && typeof p.projectId === 'string' && p.projectId,
  );
  return hit ? hit.projectId : null;
}

// Derive the exact review candidate from the same canonical evidence the
// inner verifier judges. Every step fails closed: a candidate that cannot
// be bound is not reviewable, so it must block the gate.
export function deriveReviewCandidate({ sessionPath, executionRecordPath, io } = {}) {
  const readSession = (io && typeof io.readSession === 'function') ? io.readSession : readSessionRecord;
  const readRecord = (io && typeof io.readExecutionRecord === 'function') ? io.readExecutionRecord : readExecutionRecord;
  const computeBinding = (io && typeof io.computeBinding === 'function') ? io.computeBinding : computeWorktreeContentBinding;
  const findProjectId = (io && typeof io.findProjectId === 'function') ? io.findProjectId : defaultFindProjectId;
  const registryPath = io && io.registryPath;

  const rs = readSession(sessionPath);
  if (!rs.ok) return fail('INTERNAL_REVIEW_SESSION_UNBOUND', rs.reason ?? null);
  const session = rs.session;

  if (!executionRecordPath || typeof executionRecordPath !== 'string') {
    return fail('INTERNAL_REVIEW_EXECUTION_RECORD_MISSING', null);
  }
  const cp = session.controlPlane || {};
  if (!cp.stateDir) return fail('INTERNAL_REVIEW_EXECUTION_RECORD_MISSING', 'STATE_DIR_UNAVAILABLE');

  const r = readRecord({ stateDir: cp.stateDir, repo: session.repo, issueNumber: session.issueNumber });
  if (!r.ok) {
    return fail(
      r.reason === 'EXECUTION_NOT_FOUND' ? 'INTERNAL_REVIEW_EXECUTION_RECORD_MISSING' : 'INTERNAL_REVIEW_RECORD_STALE',
      r.detail ?? r.reason ?? null,
    );
  }
  const record = r.record;
  if (!record || typeof record !== 'object') return fail('INTERNAL_REVIEW_RECORD_STALE', null);
  if (
    record.repo !== session.repo
    || Number(record.issueNumber) !== Number(session.issueNumber)
    || record.taskId !== session.taskId
  ) {
    return fail('INTERNAL_REVIEW_RECORD_STALE', { taskId: record.taskId ?? null, repo: record.repo ?? null });
  }
  if (session.worktreePath && record.worktreePath !== session.worktreePath) {
    return fail('INTERNAL_REVIEW_RECORD_STALE', 'worktree mismatch');
  }
  if (session.baseSha && record.baseSha && record.baseSha !== session.baseSha) {
    return fail('INTERNAL_REVIEW_RECORD_STALE', 'baseSha mismatch');
  }
  if (session.headSha && record.headSha && record.headSha !== session.headSha) {
    return fail('INTERNAL_REVIEW_RECORD_STALE', 'headSha mismatch');
  }

  if (!Number.isInteger(session.prNumber) || session.prNumber <= 0) {
    return fail('INTERNAL_REVIEW_PR_UNBOUND', null);
  }

  const cb = contentBindingFromRecord(record);
  if (!cb.ok) return fail('INTERNAL_REVIEW_CONTENT_BINDING_MISSING', cb.reason);
  if (!session.worktreePath || typeof session.worktreePath !== 'string') {
    return fail('INTERNAL_REVIEW_CANDIDATE_STALE', 'worktreePath unavailable');
  }
  // Freshness re-stamp: the live candidate must still be the record's
  // candidate. A moved HEAD or changed worktree invalidates any prior
  // review — fail closed so the gate can never run on a drifted target.
  // F3: the HEAD is read LIVE from git (headSha: null -> `git rev-parse
  // HEAD`); record.headSha is never substituted for the live HEAD, so a
  // metadata-only commit (HEAD moved, tracked bytes identical) is a stale
  // candidate too — content alone never launders a moved label.
  const live = computeBinding({ worktreePath: session.worktreePath, headSha: null });
  if (!live.ok) return fail('INTERNAL_REVIEW_CANDIDATE_STALE', live.reason ?? null);
  if (
    String(live.value.headSha || '').toLowerCase() !== cb.value.headSha
    || String(live.value.contentDigest || '').toLowerCase() !== cb.value.contentDigest
  ) {
    return fail('INTERNAL_REVIEW_CANDIDATE_STALE', {
      record: { headSha: cb.value.headSha, contentDigest: cb.value.contentDigest },
      live: { headSha: live.value.headSha ?? null, contentDigest: live.value.contentDigest ?? null },
    });
  }

  const projectId = findProjectId({ repo: session.repo, registryPath });
  if (typeof projectId !== 'string' || !projectId) {
    return fail('INTERNAL_REVIEW_PROJECT_UNBOUND', session.repo ?? null);
  }

  return {
    ok: true,
    value: {
      repo: session.repo,
      issueNumber: session.issueNumber,
      taskId: session.taskId,
      prNumber: session.prNumber,
      headSha: cb.value.headSha,
      contentDigest: cb.value.contentDigest,
      worktreePath: session.worktreePath,
      projectId,
      htmlUrl: typeof session.htmlUrl === 'string' ? session.htmlUrl : null,
      // Binding completes what the REVIEW-ONLY leg needs to bind the
      // candidate range exactly (no extra lookup downstream).
      identityHash: typeof session.identityHash === 'string' ? session.identityHash : null,
      baseSha: typeof session.baseSha === 'string' ? session.baseSha : null,
    },
  };
}

// OCR invocation provenance. The AI_PR_REVIEWER adapter normalizes the
// transport response down to { status, correlationKey, evidence, ... } and
// deliberately drops the OCR-side meta (model, evidence sidecar path/runId),
// so the composite captures it from the RAW transport response itself — the
// one place where the real `ocr` leg reports what actually ran.
function transportMetaFrom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sc = raw.sidecar && typeof raw.sidecar === 'object' ? raw.sidecar : null;
  const sidecarPath = sc && typeof sc.path === 'string' && sc.path ? sc.path : null;
  // Sidecar filename is `<runId>-<label>.json` (ocr-review-transport.mjs:57);
  // the runId is therefore recoverable without a second record.
  const m = sidecarPath ? path.basename(sidecarPath).match(/^([0-9a-fA-F]{8}-[0-9a-fA-F-]{27,})-[^/\\]+$/) : null;
  return {
    model: typeof raw.model === 'string' && raw.model ? raw.model : null,
    runId: m ? m[1] : null,
    sidecarPath,
    sidecarWritten: sc ? sc.written === true : false,
  };
}

// The OCR internal-review record the composite attaches to a CLEAN verify
// result. It is BOUND to the exact candidate that was reviewed (repo, issue,
// identityHash, headSha, contentDigest) and carries the invocation provenance
// (mechanism, runId, model, sidecar/log path) plus the review outcome. The
// handoff gate re-reads this record from the canonical loop ledger and refuses
// READY_FOR_REVIEW unless it is present, APPROVED with zero findings, and
// still fresh against the live worktree — so "the gate passed" can never be
// silently read as "the code was reviewed".
export function buildInternalReviewEvidence({ candidate, response, transportMeta = null, at = () => new Date().toISOString() }) {
  const ev = response && typeof response.evidence === 'object' && response.evidence ? response.evidence : {};
  const findings = Array.isArray(ev.findings) ? ev.findings : [];
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const meta = transportMeta && typeof transportMeta === 'object' ? transportMeta : null;
  return {
    schemaVersion: '1',
    source: INTERNAL_REVIEW_SOURCE,
    mechanism: 'ocr delegate (open-code-review) REVIEW-ONLY leg via the pre-gate composite transport',
    command: 'ocr delegate preview|rule inside packages/review-leg/review-only.mjs (runReviewOnlyLeg)',
    runId: meta ? meta.runId : null,
    model: meta ? meta.model : null,
    sidecarPath: meta ? meta.sidecarPath : null,
    sidecarWritten: meta ? meta.sidecarWritten === true : false,
    correlationKey: typeof response?.correlationKey === 'string' ? response.correlationKey : null,
    candidate: {
      repo: c.repo ?? null,
      issueNumber: c.issueNumber ?? null,
      prNumber: c.prNumber ?? null,
      identityHash: c.identityHash ?? null,
      headSha: typeof c.headSha === 'string' ? c.headSha.toLowerCase() : null,
      contentDigest: typeof c.contentDigest === 'string' ? c.contentDigest.toLowerCase() : null,
      baseSha: typeof c.baseSha === 'string' ? c.baseSha.toLowerCase() : null,
    },
    verdict: 'APPROVED',
    findingsCount: Number.isInteger(ev.findingsCount) ? ev.findingsCount : findings.length,
    findings,
    openBlockingCount: Number.isInteger(ev.openBlockingCount) ? ev.openBlockingCount : 0,
    at: at(),
  };
}

function classifyReviewResult(res) {
  const status = res && typeof res === 'object' ? res.status : null;
  if (status === 'CHANGES_REQUESTED') {
    // PRE-GATE-REVIEW-01 rework seam: a findings verdict must travel intact.
    // The composite forwards the ALREADY-REDACTED evidence payload (adapter
    // redacts recursively before this point) plus the candidate binding keys
    // so the ControlLoop can bind a canonical REWORK decision to THIS
    // candidate. detail here is evidence, never a verdict on its own.
    const ev = res && res.evidence && typeof res.evidence === 'object' ? res.evidence : {};
    const findings = Array.isArray(ev.findings) ? ev.findings : [];
    return {
      code: 'INTERNAL_REVIEW_FINDINGS',
      detail: {
        status,
        transportReason: res.transportReason ?? null,
        correlationKey: typeof res.correlationKey === 'string' ? res.correlationKey : null,
        requestedHeadSha: typeof res.requestedHeadSha === 'string' ? res.requestedHeadSha : null,
        responseHeadSha: typeof res.responseHeadSha === 'string' ? res.responseHeadSha : null,
        findingsCount: Number.isInteger(ev.findingsCount) ? ev.findingsCount : findings.length,
        openBlockingCount: Number.isInteger(ev.openBlockingCount) ? ev.openBlockingCount : 0,
        findings,
        detail: typeof res.detail === 'string' ? res.detail : null,
      },
    };
  }
  if (status === 'BLOCKED' || status === 'VERIFIED_WITH_WARNINGS') {
    return { code: 'INTERNAL_REVIEW_NOT_APPROVED', detail: { status, transportReason: res.transportReason ?? null, detail: res.detail ?? null } };
  }
  // ERROR, MALFORMED, UNKNOWN, or any accepted:false transport outcome —
  // including the default UNSUPPORTED_TRANSPORT — is not CLEAN.
  return {
    code: 'INTERNAL_REVIEW_TRANSPORT',
    detail: { status, transportReason: res && res.transportReason ? res.transportReason : null, detail: res && res.detail ? res.detail : null },
  };
}

// Composite verifier: internal review FIRST, inner gate verifier ONLY on a
// CLEAN APPROVED review. The inner verifier is called exactly once and its
// result is passed through verbatim. No FSM step, no new evidence truth.
export function preGateReviewVerifierAdapter({
  innerVerifier,
  transport = null,
  timeoutMs = 1000,
  registryPath = undefined,
  io = null,
} = {}) {
  if (typeof innerVerifier !== 'function') {
    throw new TypeError('preGateReviewVerifierAdapter: innerVerifier (function) is required');
  }
  return async function preGateReviewVerifier({ sessionPath, executionRecordPath } = {}) {
    const cand = deriveReviewCandidate({ sessionPath, executionRecordPath, io: { ...(io || {}), registryPath: (io && io.registryPath) ?? registryPath } });
    if (!cand.ok) return fail(cand.code, cand.detail ?? null);

    let res;
    // RAW transport response meta (model/sidecar/runId) — captured here
    // because requestReview() normalizes it away. One capture per composite
    // invocation; a transport that returns nothing leaves it null and the
    // evidence simply carries nulls (never invented values).
    let transportMeta = null;
    try {
      res = await requestReview(
        {
          repo: cand.value.repo,
          pr: cand.value.prNumber,
          headSha: cand.value.headSha,
          projectId: cand.value.projectId,
          htmlUrl: cand.value.htmlUrl ?? undefined,
        },
        {
          // The candidate is injected into ctx so the real transport can
          // bind the exact session evidence without a second lookup. The
          // wrapper observes the RAW response for OCR provenance and passes
          // it through verbatim — it never alters the review contract.
          transport: async (r, ctx) => {
            const out = typeof transport === 'function'
              ? await transport(r, { ...(ctx || {}), candidate: cand.value })
              : await defaultCallReviewer(r, ctx);
            const meta = transportMetaFrom(out);
            if (meta) transportMeta = meta;
            return out;
          },
          timeoutMs,
          registryPath,
        },
      );
    } catch (e) {
      return fail('INTERNAL_REVIEW_TRANSPORT_EXCEPTION', String((e && e.message) || e));
    }

    // F3: re-check the candidate AFTER the review and BEFORE the gate. The
    // review window is unbounded (real transports take seconds to minutes);
    // a HEAD/content drift during it invalidates the verdict regardless of
    // its outcome, so the inner gate must never run on the drifted target.
    // This re-derives from the SAME canonical primitives (live git HEAD +
    // record + session), never from cached values.
    const recheck = deriveReviewCandidate({
      sessionPath,
      executionRecordPath,
      io: { ...(io || {}), registryPath: (io && io.registryPath) ?? registryPath },
    });
    if (!recheck.ok) {
      // A drift discovered by the re-derivation itself is still a POST-REVIEW
      // refusal — keep the phase visible on the typed detail.
      return recheck.code === 'INTERNAL_REVIEW_CANDIDATE_STALE'
        ? fail(recheck.code, {
            phase: 'post-review',
            before: { headSha: cand.value.headSha, contentDigest: cand.value.contentDigest },
            cause: recheck.detail ?? null,
          })
        : fail(recheck.code, recheck.detail ?? null);
    }
    if (
      recheck.value.headSha !== cand.value.headSha
      || recheck.value.contentDigest !== cand.value.contentDigest
    ) {
      return fail('INTERNAL_REVIEW_CANDIDATE_STALE', {
        phase: 'post-review',
        before: { headSha: cand.value.headSha, contentDigest: cand.value.contentDigest },
        after: { headSha: recheck.value.headSha, contentDigest: recheck.value.contentDigest },
      });
    }

    const clean =
      res && typeof res === 'object'
      && res.accepted === true
      && res.status === 'APPROVED'
      && String(res.requestedHeadSha || '').toLowerCase() === cand.value.headSha;

    if (clean) {
      const inner = await innerVerifier({ sessionPath, executionRecordPath });
      // CLEAN = "the OCR review approved THIS candidate AND the gate passed".
      // The verify result therefore carries the internal-review record into
      // the canonical loop ledger, where the handoff gate and the read-only
      // checklist re-read it. A non-object inner value keeps the verifier
      // result verbatim (no fabricated record) and the handoff gate then
      // fails closed with INTERNAL_REVIEW_PENDING.
      if (inner && inner.ok === true && inner.value && typeof inner.value === 'object' && !Array.isArray(inner.value)) {
        return {
          ...inner,
          value: {
            ...inner.value,
            internalReview: buildInternalReviewEvidence({
              candidate: cand.value,
              response: res,
              transportMeta,
            }),
          },
        };
      }
      return inner;
    }
    const c = classifyReviewResult(res);
    return fail(c.code, c.detail);
  };
}

