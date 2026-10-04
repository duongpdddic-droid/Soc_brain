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

import { readSessionRecord } from '../runtime-sandbox/runtime-sandbox.mjs';
import { readExecutionRecord } from '../executor-launcher/executor-launcher.mjs';
import {
  computeWorktreeContentBinding,
  contentBindingFromRecord,
} from '../executor-launcher/execution-content-binding.mjs';
import { requestReview, defaultCallReviewer } from '../ai-pr-reviewer-adapter/ai-pr-reviewer-adapter.mjs';
import { loadRegistry } from '../project-registry/project-registry.mjs';

export const PRE_GATE_REVIEW_SCHEMA_VERSION = '1';

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
  const projects = registry && Array.isArray(registry.projects) ? registry.projects : [];
  const hit = projects.find(
    (p) => p && typeof p === 'object' && String(p.repository || '') === String(repo) && typeof p.projectId === 'string' && p.projectId,
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
  const live = computeBinding({ worktreePath: session.worktreePath, headSha: record.headSha });
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
          // bind the exact session evidence without a second lookup.
          transport: (r, ctx) => (typeof transport === 'function'
            ? transport(r, { ...(ctx || {}), candidate: cand.value })
            : defaultCallReviewer(r, ctx)),
          timeoutMs,
          registryPath,
        },
      );
    } catch (e) {
      return fail('INTERNAL_REVIEW_TRANSPORT_EXCEPTION', String((e && e.message) || e));
    }

    const clean =
      res && typeof res === 'object'
      && res.accepted === true
      && res.status === 'APPROVED'
      && String(res.requestedHeadSha || '').toLowerCase() === cand.value.headSha;

    if (clean) {
      return innerVerifier({ sessionPath, executionRecordPath });
    }
    const c = classifyReviewResult(res);
    return fail(c.code, c.detail);
  };
}
