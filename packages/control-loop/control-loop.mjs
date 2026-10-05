// control-loop.mjs — Soc_brain ControlLoop v0 (Issue #69).
// See Issue #69 body for full contract. Composes existing primitives.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  taskFinish,
  taskBlock,
  readSessionRecord,
  updateSessionUnderOwnershipLock,
} from '../runtime-sandbox/runtime-sandbox.mjs';
import { defaultWorktreesRoot, identityHash } from '../workspace/workspace.mjs';
import {
  dispatchLifecycleEvent,
  recoverLifecycleEvent,
} from '../telegram-dispatch/telegram-dispatch.mjs';
import { readExecutionRecord } from '../executor-launcher/executor-launcher.mjs';
// Issue #132 rework step 3: the delivery leg resolves identity through the ONE
// canonical session reader (packages/task-intake). Circular import is safe:
// both modules only use each other's hoisted function declarations at runtime.
import { readCanonicalTask, readCanonicalTaskWithBinding } from '../task-intake/session-at-intake.mjs';
import { currentAuthorityPipePath } from '../session-authority/guard.mjs';
import { authorityBindLockPath, OPS as AUTHORITY_OPS, CODES as AUTHORITY_CODES, authorityPipePath as defaultAuthorityPipePath } from '../session-authority/protocol.mjs';
import {
  decisionDigest as reworkDigest,
  buildReworkRecord,
  buildReworkInstruction,
} from './rework.mjs';
// Issue #264 option C: canonical commit recovery — the missing EXIT from the
// VERIFYING -> PUSH_DIRTY_FOREIGN closed loop. Pure scope/authority/lock
// decisions plus the canonical attempt-record seam; ControlLoop owns dispatch.
import {
  classifyCommitScope,
  assertPriorExecutorRelinquished,
  recoveryDigest,
  evaluateRecoveryLock,
  listCommitRecoveryRecords,
  persistCommitRecoveryRecord,
  stampCommitRecoveryOutcome,
  buildCommitRecoveryRecord,
  buildCommitRecoveryInstruction,
  resolveRecoveryScope,
} from './commit-recovery.mjs';
// S4 completion: the textual final-review response contract
// (review-payload.mjs `VERDICT: APPROVED | CHANGES_REQUESTED | BLOCKED`) is
// normalized at the SINGLE decision funnel below — structured FSM decisions
// pass through byte-for-byte, raw responses parse fail-closed.
import { normalizeReviewDecision } from './verdict-parser.mjs';
import { validateReviewProvenance, WEB2API_REVIEW_SOURCE } from './web2api-review-provenance.mjs';
import { packetPathFor } from './adapters.mjs';
import { runDeliveryLifecycle, deliverySpec, verifyExternalDelivery, verifyCleanupCompletion, performCanonicalCleanup, writeDeliveryCleanup } from './delivery.mjs';
import { pushBranch, cleanPathspecsForPush } from './push.mjs';
import { writeReviewReady } from '../review-ready/review-ready.mjs';
import { projectHandoffChecklist } from './handoff-checklist.mjs';
// Issue #125 (rework): deterministic Fast Path wiring — classifyRoute gates
// admission, runFastPath REALLY executes the eligible walk (deterministic
// verification, semantic reviews skipped), readTelemetry is the fail-closed
// read-back primitive, telemetryPathFor the single naming source.
import {
  classifyRoute,
  FAST_ROUTE,
  persistTelemetry,
  readTelemetry,
  runFastPath,
  STANDARD_ROUTE,
  telemetryPathFor,
} from '../fast-path/fast-path.mjs';
import { performance } from 'node:perf_hooks';
// Session Admission Authority (SOC_TASK_CONTRACT §3): the control-loop ledger
// is a mutation boundary too. The synchronous admission fence is asserted
// immediately before every append, so an armed process without a live grant
// cannot write transitions. Leaf import; disarmed unless
// SOC_SESSION_ADMISSION=required.
import { assertAdmissionFence, isSessionAdmissionArmed, sealBoundaryReceipt, verifyBoundaryReceipt } from '../session-authority/guard.mjs';
// REWORK F2-src (REC-01 rework round 2): the transport stage-observation
// SENTINEL format + its provenance derive. Leaf module (no cycle) shared by
// the raw transport (which EMITS the marker line into the captured log) and
// the writer/seal/reader below (which DERIVE the boundary observation from
// it). Re-exported here so the production runner entry resolves the same
// single source of truth.
import { derivePreSubmitObservationFromEvidence } from './boundary-observation.mjs';
export { derivePreSubmitObservationFromEvidence };

// ---- P0-G (Issue #83) canonical HEAD refresh --------------------------------
// Gap A (head binding): taskStart pins session.headSha = baseSha (the
// admission base). The canonical review-ready packet and the delivery binding
// must reference the POST-COMMIT HEAD; without a refresh every downstream
// identity gate (collectPreReviewEvidence REVIEW_PACKET_STALE,
// assertReworkBinding REWORK_BINDING_STALE, delivery DELIVERY_BIND_STALE)
// compares against a stale admission SHA. refreshCanonicalHead() reads the
// worktree HEAD AFTER the executor commit, refuses to move backwards or to
// the admission base, persists the record atomically and verifies the
// read-back; history is kept additively for the duration evidence trail.
function execGit(exec, cwd, args) {
  if (typeof exec === 'function') {
    try {
      const r = exec(args, { cwd });
      if (!r || !Number.isInteger(r.status)) return { unknown: true, error: 'GIT_NO_EXIT_STATUS' };
      return { unknown: false, status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
    } catch (e) {
      return { unknown: true, error: String((e && e.message) || e) };
    }
  }
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) return { unknown: true, error: String(r.error.message || r.error) };
  return { unknown: false, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function refreshCanonicalHead({ sessionPath, stateDir = defaultStateDir(), exec = null, now = () => new Date().toISOString() } = {}) {
  const rs = readSessionByHash({ stateDir, identityHash: path.basename(sessionPath, '.json') });
  if (!rs.ok) return fail('SESSION_READ_FAILED', rs.reason);
  const session = rs.session;
  if (session.state === 'COMPLETED' || session.state === 'FAILED' || session.state === 'BLOCKED') {
    return fail('HEAD_REFRESH_TERMINAL_REFUSED', session.state);
  }
  const worktree = session.worktreePath;
  if (typeof worktree !== 'string' || !worktree) return fail('HEAD_REFRESH_BIND_FAILED', 'session.worktreePath missing');
  const h = execGit(exec, worktree, ['rev-parse', 'HEAD']);
  if (h.unknown) return fail('HEAD_REFRESH_AMBIGUOUS', h.error);
  if (h.status !== 0) return fail('HEAD_REFRESH_HEAD_UNRESOLVED', (h.stderr || h.stdout).trim());
  const headSha = h.stdout.trim().toLowerCase();
  if (!HEAD_SHA_40.test(headSha)) return fail('HEAD_REFRESH_HEAD_UNRESOLVED', `local HEAD not 40-hex: ${headSha}`);
  if (headSha === String(session.headSha || '').toLowerCase()) {
    return ok({ refreshed: false, headSha, previous: session.headSha });
  }
  if (headSha === String(session.baseSha || '').toLowerCase()) {
    return fail('HEAD_REFRESH_REFUSED_BASE', `HEAD ${headSha} equals the admission baseSha — the executor produced no canonical commit`);
  }
  const anc = execGit(exec, worktree, ['merge-base', '--is-ancestor', String(session.baseSha), headSha]);
  if (anc.unknown) return fail('HEAD_REFRESH_AMBIGUOUS', anc.error);
  if (anc.status !== 0) {
    return fail('HEAD_REFRESH_REFUSED_LINEAGE', `HEAD ${headSha} does not descend from the admitted baseSha ${session.baseSha}`);
  }
  const previous = session.headSha ?? null;
  // Issue #145 rework F1: head binding is an owner-carrying whole-session
  // write — serialized under the ownership boundary (authoritative read
  // inside; the ownership field is structurally protected from clobber).
  const persisted = updateSessionUnderOwnershipLock(sessionPath, (auth) => {
    if (auth.headSha === headSha) return { session: auth }; // already bound
    auth.headSha = headSha;
    auth.controlLoop = auth.controlLoop && typeof auth.controlLoop === 'object' ? auth.controlLoop : {};
    auth.controlLoop.headHistory = Array.isArray(auth.controlLoop.headHistory) ? auth.controlLoop.headHistory : [];
    auth.controlLoop.headHistory.push({ headSha, previous, at: now() });
    return { session: auth };
  });
  if (!persisted.ok) return fail('HEAD_REFRESH_PERSIST_FAILED', persisted.detail ?? persisted.reason);
  if (persisted.session.headSha !== headSha) {
    return fail('HEAD_REFRESH_VERIFY_FAILED', `persisted headSha=${persisted.session.headSha}`);
  }
  return ok({ refreshed: true, headSha, previous });
}
// Gap B (packet projection): `writeReviewReady` existed only in tests before
// this fix — nothing in the runtime projected the canonical review-ready
// packet, so PRE_REVIEWING failed closed with NO_REVIEW_PACKET (the packet is
// REQUIRED and identity-gated). projectReviewReadyPacket() renders the
// handoff report from the CANONICAL session + transition evidence only, and
// writes it outside the worktree via the review-ready primitive's own
// fail-closed gate. Honest at projection time: deterministic verification and
// the semantic reviews have NOT run yet — the packet states exactly that.
// ---- OCR internal-review handoff gate (read-only, fail-closed) --------------
// READY_FOR_REVIEW is created at projectReviewReadyPacket. This resolver is
// the ONLY question that gate asks: "does a CLEAN OCR internal-review record,
// bound to THIS candidate, still describe the live worktree?".
//
// Evidence source (no parallel channel): the composite verifier attaches
// `internalReview` to its CLEAN verify result, and loop.step persists that
// result as the boundary evidence in the canonical transition ledger
// (VERIFYING->PRE_REVIEWING on the fresh walk, EXECUTING->VERIFYING on a
// rework round). Records are only ever READ here; nothing is written.
//
// Codes (requirement: INTERNAL_REVIEW_PENDING or a specific code):
//   INTERNAL_REVIEW_PENDING — no record, unknown source, verdict != APPROVED,
//                             unresolved substantive findings, or an ERROR that
//                             prevents proving freshness (worktree/HEAD/status
//                             unreadable);
//   INTERNAL_REVIEW_STALE   — the record exists but provably no longer
//                             describes the candidate (reviewed head/session
//                             identity mismatch, live HEAD moved, or foreign
//                             code changed after the review).
// Both refuse READY_FOR_REVIEW; neither may ever downgrade to a pass.
export const INTERNAL_REVIEW_HANDOFF_CODES = Object.freeze(['INTERNAL_REVIEW_PENDING', 'INTERNAL_REVIEW_STALE']);

const INTERNAL_REVIEW_SOURCES = new Set(['ocr-internal-review']);

// An internal-review record only ever rides a VERIFY BOUNDARY evidence (fresh
// walk VERIFYING->PRE_REVIEWING, rework round EXECUTING->VERIFYING); the fast
// path nests the value one level down ({ verdict, evidence: <verify value> }).
// Accept exactly those two shapes, never deeper and never from any other
// transition, and only from a known internal-review source.
function internalReviewFromTransition(rec) {
  if (!rec || (rec.to !== 'PRE_REVIEWING' && rec.to !== 'VERIFYING')) return null;
  const e = rec.evidence && typeof rec.evidence === 'object' && !Array.isArray(rec.evidence) ? rec.evidence : null;
  if (!e) return null;
  const ir = e.internalReview
    ?? (e.evidence && typeof e.evidence === 'object' ? e.evidence.internalReview : null)
    ?? null;
  if (!ir || typeof ir !== 'object' || Array.isArray(ir)) return null;
  if (!INTERNAL_REVIEW_SOURCES.has(ir.source)) return null;
  return ir;
}

export function resolveInternalReviewForHandoff({ stateDir = defaultStateDir(), identityHash: id, session, exec = null, transitions = null } = {}) {
  const pending = (detail) => ({ ok: false, code: 'INTERNAL_REVIEW_PENDING', detail });
  const stale = (detail) => ({ ok: false, code: 'INTERNAL_REVIEW_STALE', detail });
  if (!session || typeof session !== 'object') return pending({ reason: 'session is required' });

  // Newest first: the LATEST review of this candidate wins. An older round's
  // record can never satisfy the binding check below after a repair commit.
  const ledger = Array.isArray(transitions) ? transitions : readTransitions({ stateDir, identityHash: id });
  let ir = null;
  let boundary = null;
  for (let i = ledger.length - 1; i >= 0; i--) {
    const rec = ledger[i];
    const hit = internalReviewFromTransition(rec);
    if (hit) { ir = hit; boundary = { ts: rec.ts ?? null, from: rec.from ?? null, to: rec.to ?? null, reason: rec.reason ?? null }; break; }
  }
  if (!ir) {
    return pending({
      reason: 'no OCR internal-review record in the loop ledger (the review never ran, or its evidence was not persisted)',
      identityHash: id,
    });
  }

  const findings = Array.isArray(ir.findings) ? ir.findings : [];
  const findingsCount = Number.isInteger(ir.findingsCount) ? ir.findingsCount : findings.length;
  if (ir.verdict !== 'APPROVED' || findingsCount > 0 || findings.length > 0) {
    return pending({
      reason: 'substantive internal-review findings are not resolved on this candidate',
      verdict: typeof ir.verdict === 'string' ? ir.verdict : null,
      findingsCount,
      runId: ir.runId ?? null,
    });
  }

  const bound = ir.candidate && typeof ir.candidate === 'object' ? ir.candidate : null;
  const head = typeof session.headSha === 'string' && HEAD_SHA_40.test(session.headSha) ? session.headSha.toLowerCase() : null;
  if (!bound || !head || !HEAD_SHA_40.test(String(bound.headSha || '')) || String(bound.headSha).toLowerCase() !== head) {
    return stale({ reason: 'reviewed candidate head does not match the session head', reviewed: bound?.headSha ?? null, session: head });
  }
  if (String(bound.identityHash ?? '') !== String(id ?? '')) {
    return stale({ reason: 'reviewed candidate identity does not match this loop', reviewed: bound.identityHash ?? null, identityHash: id ?? null });
  }
  if (String(bound.repo ?? '') !== String(session.repo ?? '')
      || Number(bound.issueNumber) !== Number(session.issueNumber)) {
    return stale({ reason: 'reviewed candidate identity does not match the session', reviewed: { repo: bound.repo ?? null, issue: bound.issueNumber ?? null }, session: { repo: session.repo ?? null, issue: session.issueNumber ?? null } });
  }

  // Live freshness: the SAME primitives the composite used (live git HEAD +
  // push-scope foreign dirt). An ERROR that prevents proving freshness is a
  // pending review (INTERNAL_REVIEW_PENDING); only PROVEN drift is stale.
  if (typeof session.worktreePath !== 'string' || !session.worktreePath) {
    return pending({ reason: 'worktreePath unavailable — freshness of the reviewed candidate cannot be proven' });
  }
  const liveHead = execGit(exec, session.worktreePath, ['rev-parse', 'HEAD']);
  if (liveHead.unknown || Number(liveHead.status) !== 0) {
    return pending({ reason: 'live HEAD unreadable — freshness cannot be proven', detail: liveHead.error ?? String(liveHead.stderr || '').trim().slice(0, 200) });
  }
  const live = String(liveHead.stdout || '').trim().toLowerCase();
  if (live !== head) {
    return stale({ reason: 'HEAD moved after the internal review', reviewed: head, live: live || null });
  }
  const st = execGit(exec, session.worktreePath, ['status', '--porcelain']);
  if (st.unknown || Number(st.status) !== 0) {
    return pending({ reason: 'worktree status unreadable — freshness cannot be proven', detail: st.error ?? String(st.stderr || '').trim().slice(0, 200) });
  }
  // Same porcelain parse as push.mjs pushBranch (XY + space prefix, every
  // quote stripped) — two different parsers of the SAME output would drift.
  const dirty = String(st.stdout || '').split('\n')
    .map((l) => String(l).slice(3).trim().replaceAll('"', ''))
    .filter(Boolean);
  const foreign = cleanPathspecsForPush(dirty);
  if (foreign.length) {
    return stale({ reason: 'code changed after the internal review (foreign worktree paths)', foreignPaths: foreign.slice(0, 20) });
  }

  return { ok: true, value: { internalReview: ir, boundary } };
}

// Verify-report field reader shared by the handoff projection and the
// checklist: both the standard walk (value = { verdict, evidence }) and the
// fast walk (value = { verdict, fastPathTerminal, evidence }) keep the
// deterministic gate payload under `evidence`.
function verifyEvidenceOf(report, field) {
  const e = report && typeof report === 'object' && report.evidence && typeof report.evidence === 'object'
    ? report.evidence
    : null;
  if (!e) return null;
  const v = e[field];
  return v !== undefined && v !== null ? v : null;
}

// Read-only handoff checklist projection. Derived from the SAME canonical
// records the gate just validated (session + transition ledger + the resolved
// internal-review gate result); it writes a view and grants NO authority —
// a projection failure never blocks nor unlocks anything, so it is best-effort
// by design and always reports its own failure instead of throwing.
// Exported for the S5 dispatcher, which records the human-gate handoff AFTER
// the loop returns and re-projects the same view (no second source of truth).
export function projectChecklistBestEffort({ stateDir = defaultStateDir(), identityHash: id, sessionPath, exec = null, internalReviewGate = undefined }) {
  try {
    const rs = readSessionByHash({ stateDir, identityHash: id });
    if (!rs.ok) return { ok: false, code: rs.reason ?? 'SESSION_READ_FAILED' };
    const transitions = readTransitions({ stateDir, identityHash: id });
    // Reuse the caller's gate result when it has one (it was resolved with the
    // SAME git transport the loop used); otherwise re-resolve read-only.
    const gate = internalReviewGate && typeof internalReviewGate === 'object'
      ? internalReviewGate
      : resolveInternalReviewForHandoff({ stateDir, identityHash: id, session: rs.session, exec, transitions });
    return projectHandoffChecklist({ stateDir, identityHash: id, session: rs.session, transitions, internalReviewGate: gate });
  } catch (e) {
    return { ok: false, code: 'CHECKLIST_PROJECTION_FAILED', detail: String((e && e.message) || e) };
  }
}

export function projectReviewReadyPacket({ sessionPath, stateDir = defaultStateDir(), outputDir = null, now = () => new Date().toISOString(), exec = null, gh = null, verifyEvidence = null, provenance = null, legacyEvidence = null, verificationResult = null, deferPending = false } = {}) {
  const rs = readSessionByHash({ stateDir, identityHash: path.basename(sessionPath, '.json') });
  if (!rs.ok) return fail('SESSION_READ_FAILED', rs.reason);
  const session = rs.session;
  // Issue #155 F7 (legacy-adoption provenance): an ADOPTED legacy session is
  // external, noncanonical execution — the packet must NEVER claim the
  // canonical opencode executor, a canonical deterministic verifier, or a
  // canonical ExecutionRecord. The legacy mode renders the truthful
  // provenance and the verifyLegacyEvidence results instead. The packet
  // FORMAT (sections/shape) is unchanged — no fork.
  const legacyMode = provenance === 'legacy-adoption';
  if (legacyMode) {
    const p = session.provenance ?? {};
    if (p.provenance !== 'legacy-adoption') return fail('PACKET_PROVENANCE_MISMATCH', `requested legacy-adoption, session provenance=${p.provenance ?? null}`);
  }
  if (session.state === 'COMPLETED' || session.state === 'FAILED' || session.state === 'BLOCKED') {
    return fail('PACKET_TERMINAL_REFUSED', session.state);
  }
  const headSha = session.headSha;
  if (typeof headSha !== 'string' || !HEAD_SHA_40.test(headSha)) {
    return fail('PACKET_HEAD_UNBOUND', `session.headSha must be the refreshed post-commit 40-hex HEAD, got ${String(headSha)}`);
  }
  if (!Number.isInteger(session.issueNumber) || session.issueNumber <= 0) return fail('PACKET_IDENTITY_INVALID', 'issueNumber');
  if (!Number.isInteger(session.prNumber) || session.prNumber <= 0) {
    return fail('PACKET_PR_UNBOUND', 'session.prNumber must carry the canonical PR number before the packet is projected');
  }
  // ---- OCR internal-review handoff gate (checked BEFORE any gather) --------
  // Non-legacy canonical sessions reach READY_FOR_REVIEW only with a CLEAN,
  // candidate-bound, still-fresh OCR internal-review record. The publish chain
  // runs BEFORE the review exists and passes deferPending:true — it then
  // reports {written:false, status:'INTERNAL_REVIEW_PENDING'} and creates NO
  // packet, so no reviewer can ever observe a READY_FOR_REVIEW artifact that
  // was projected before the code was reviewed. Every other call site (the
  // post-verify handoff projection, the rework leg) is strict: a missing,
  // errored, stale or findings-bearing record is a typed fail, never a packet.
  //
  // Two provenance-declared ADOPTION modes carry no canonical executor and
  // therefore no executor changeset for OCR to review — their evidence is
  // external by contract and stays outside this gate (Issue #155
  // legacy-adoption, Issue #159 review-only adoption, whose persisted
  // controlLoop.reviewOnly flag the adopt leg writes BEFORE this projection).
  const adoptionMode = legacyMode
    || (session.controlLoop && typeof session.controlLoop === 'object' && session.controlLoop.reviewOnly === true);
  let internalReviewGate = null;
  if (!adoptionMode) {
    const ir = resolveInternalReviewForHandoff({
      stateDir,
      identityHash: path.basename(sessionPath, '.json'),
      session,
      exec,
    });
    if (!ir.ok) {
      if (deferPending === true) {
        return ok({
          packet: { written: false, status: 'INTERNAL_REVIEW_PENDING', code: ir.code, detail: ir.detail, headSha },
          projectedAt: now(),
          deferred: true,
        });
      }
      return fail(ir.code, ir.detail);
    }
    internalReviewGate = ir.value;
  }
  // P0-G (Issue #83): the final reviewer must receive REAL evidence — the
  // canonical git delta (diff stat / changed files / commits) and, when the
  // deterministic verifier has already run, its verdict + execution record
  // path. Placeholder-only packets made the real GPT final review fail closed
  // with "insufficient canonical evidence" (legitimate finding). Every gather
  // below is best-effort + bounded: an unavailable piece degrades to an
  // explicit UNAVAILABLE item, never fabricates evidence.
  const codeEvidenceItems = [legacyMode
    ? { committedHead: headSha.slice(0, 12), base: String(session.baseSha || '').slice(0, 12) || 'UNAVAILABLE (external legacy execution — no canonical admission base)', committedBy: 'external legacy execution (adopted session; no canonical soc_broker_commit record)' }
    : { committedHead: headSha.slice(0, 12), base: String(session.baseSha || '').slice(0, 12), committedBy: 'soc_broker_commit inside the bound task worktree' }];
  if (typeof session.worktreePath === 'string' && session.worktreePath && typeof session.baseSha === 'string') {
    const range = `${session.baseSha}..${headSha}`;
    const stat = execGit(exec, session.worktreePath, ['diff', '--stat', range]);
    if (!stat.unknown && stat.status === 0 && stat.stdout.trim()) codeEvidenceItems.push({ diffStat: stat.stdout.trim().slice(0, 4000) });
    const files = execGit(exec, session.worktreePath, ['diff', '--name-only', range]);
    if (!files.unknown && files.status === 0 && files.stdout.trim()) codeEvidenceItems.push({ changedFiles: files.stdout.trim().split(/\r?\n/).slice(0, 100).join(', ') });
    const log = execGit(exec, session.worktreePath, ['log', '--oneline', range]);
    if (!log.unknown && log.status === 0 && log.stdout.trim()) codeEvidenceItems.push({ commits: log.stdout.trim().split(/\r?\n/).slice(0, 50).join(' | ') });
    // P0-G leg-7 finding: diff stats alone cannot support a semantic review —
    // the reviewer needs the CONTENT of the changed files. `git show` at the
    // committed head is canonical evidence (read-only, bounded per file).
    const changedList = files.unknown || files.status !== 0 ? '' : String(files.stdout || '').trim();
    if (changedList) {
      for (const f of changedList.split(/\r?\n/).slice(0, 20)) {
        const show = execGit(exec, session.worktreePath, ['show', `${headSha}:${f}`]);
        if (!show.unknown && show.status === 0 && typeof show.stdout === 'string' && show.stdout.length) {
          codeEvidenceItems.push({ [`fileContent ${f}`]: show.stdout.length > 16000 ? `${show.stdout.slice(0, 16000)}\n…(truncated at 16000 of ${show.stdout.length} bytes)` : show.stdout });
        }
      }
    }
  }
  const scopeItems = [legacyMode
    ? { taskId: session.taskId, executor: 'legacy/noncanonical executor (external execution adopted for canonical review; NOT the canonical opencode P0-A lane)', provenance: 'legacy-adoption (Issue #155)' }
    : { taskId: session.taskId, executor: 'canonical opencode executor (P0-A)' }];
  // Real-run gh transport: deps.gh is null in production (spawnSync), a
  // function only in tests. Without the spawnSync path the objective gather
  // silently degraded to UNAVAILABLE (real GPT finding, leg 7).
  const ghCall = (args) => {
    if (typeof gh === 'function') {
      try { return gh(args); } catch (e) { return { unknown: true, error: String((e && e.message) || e) }; }
    }
    const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true });
    if (r.error) return { unknown: true, error: String(r.error.code || r.error.message || r.error) };
    return { unknown: false, code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  try {
    const r = ghCall(['issue', 'view', String(session.issueNumber), '--repo', session.repo, '--json', 'title,body']);
    if (r && !r.unknown && Number(r.code) === 0) {
      const data = JSON.parse(String(r.stdout || ''));
      if (data && (typeof data.title === 'string' || typeof data.body === 'string')) {
        scopeItems.push({ issueObjective: String(data.title || '').slice(0, 500), acceptanceCriteria: String(data.body || '').slice(0, 4000) });
      }
    }
  } catch { /* best-effort: objective unavailable → reviewer sees it explicitly */ }
  if (!scopeItems.some((x) => x.issueObjective !== undefined)) {
    scopeItems.push({ issueObjective: 'UNAVAILABLE_AT_PROJECTION_TIME' });
  }
  const verificationItems = legacyMode
    ? (() => {
        let items;
        if (!verificationResult || typeof verificationResult !== 'object') {
          items = [{ legacyVerify: 'MISSING', error: 'structured verification result required but not provided' }];
        } else {
          items = [{
            legacyVerify: verificationResult.failed === 0 ? 'PASS' : 'FAIL_WITH_INHERITED_FAILURES',
            suite: verificationResult.suite ?? 'unknown',
            repository: verificationResult.repository ?? session.repo,
            issueNumber: verificationResult.issueNumber ?? session.issueNumber,
            pullRequestNumber: verificationResult.pullRequestNumber ?? session.prNumber,
            headSha: verificationResult.headSha ?? session.headSha,
            passed: verificationResult.passed ?? null,
            failed: verificationResult.failed ?? null,
            total: verificationResult.total ?? null,
            exitCode: verificationResult.exitCode ?? null,
            timestamp: verificationResult.timestamp ?? null,
            evidencePath: verificationResult.evidencePath ?? null,
            source: 'verifyLegacyEvidence (Issue #155 legacy-adoption; external execution - no canonical execution record exists)',
          }];
          if (verificationResult.inheritedFailures && Array.isArray(verificationResult.inheritedFailures)) {
            for (const f of verificationResult.inheritedFailures) {
              items.push({ inheritedFailure: f.testName ?? f.file ?? 'unknown', detail: f.detail ?? null, inheritedFromBase: f.inheritedFromBase ?? true });
            }
          }
        }
        // Round-5 REWORK (GPT final-review findings): legacyEvidence was
        // accepted by the projector but NEVER rendered — the reviewer saw
        // only locators. Render the actual verified evidence (content + live
        // PR/worktree read-back + the fail-closed verifier surface). Runs for
        // BOTH branches: the evidence leg is verified even when the
        // structured verificationResult is missing.
        if (legacyEvidence && typeof legacyEvidence === 'object') {
          const le = legacyEvidence;
          items.push({
            legacyEvidenceVerify: 'PASS',
            prHeadBound: le.prHeadBound ? 'yes' : 'no',
            branchBound: le.branchBound ? 'yes' : 'no',
            worktreeVerified: le.worktreeVerified == null ? 'n/a' : String(le.worktreeVerified),
            evidenceItemsVerified: Number.isFinite(le.evidenceItemsVerified) ? le.evidenceItemsVerified : 0,
          });
          if (le.prReadBack && typeof le.prReadBack === 'object') items.push({ prReadBack: JSON.stringify(le.prReadBack) });
          if (le.worktreeBinding && typeof le.worktreeBinding === 'object') items.push({ worktreeBinding: JSON.stringify(le.worktreeBinding) });
          if (Array.isArray(le.evidence)) {
            for (const ev of le.evidence) {
              if (!ev || typeof ev !== 'object') continue;
              const text = typeof ev.text === 'string' && ev.text
                ? ` · text=${ev.text.replace(/\r/g, '').replace(/\n/g, ' ⏎ ')}`
                : '';
              items.push({ verifiedEvidence: `${ev.kind || 'artifact'} ${ev.locator} bindsAdoptedHead=${ev.headSha ? 'true' : 'false'}${text}` });
            }
          }
          if (Array.isArray(le.failClosedCodes) && le.failClosedCodes.length) {
            items.push({ failClosedVerifierCodes: le.failClosedCodes.join(', ') });
          }
        }
        return items;
      })()
    : [{ deterministicVerify: 'PENDING_AT_PACKET_TIME' }];
  if (!legacyMode && verifyEvidence && typeof verifyEvidence === 'object' && verifyEvidence.verdict) {
    verificationItems.unshift({
      deterministicVerify: verifyEvidence.verdict,
      exitCode: verifyEvidence.exitCode ?? null,
      recordPath: verifyEvidence.executionRecordPath ?? null,
      source: 'control-loop VERIFYING leg (canonical readExecutionRecord)',
    });
  }
  // The reviewer sees HOW the candidate was reviewed before it sees the gate
  // verdict: OCR invocation (mechanism/runId/model/sidecar path) + the exact
  // candidate binding the clean review approved. Read from the gate result —
  // never re-derived, never fabricated.
  if (internalReviewGate && internalReviewGate.internalReview) {
    const irEv = internalReviewGate.internalReview;
    verificationItems.unshift({
      internalReview: 'APPROVED (OCR pre-gate review)',
      mechanism: irEv.mechanism ?? null,
      runId: irEv.runId ?? null,
      model: irEv.model ?? null,
      reviewedHeadSha: irEv.candidate?.headSha ?? null,
      contentDigest: irEv.candidate?.contentDigest ?? null,
      sidecarPath: irEv.sidecarPath ?? null,
      reviewedAt: irEv.at ?? null,
      boundaryTs: internalReviewGate.boundary?.ts ?? null,
      source: 'control-loop VERIFYING leg (resolveInternalReviewForHandoff)',
    });
  }
  const report = {
    identity: {
      repository: session.repo,
      issue: session.issueNumber,
      pullRequest: session.prNumber,
      branch: session.branch ?? null,
      headSha,
      baseSha: session.baseSha ?? null,
      prState: 'OPEN',
    },
    terminalStatus: { status: 'READY_FOR_REVIEW' },
    scope: { items: scopeItems },
    codeEvidence: { items: codeEvidenceItems },
    findingResolution: { items: legacyMode
      ? [{ note: 'legacy-adoption first canonical pass — prior external review findings ride the adopted PR history' }]
      : (() => {
          // Truthful resolution trail: the clean internal review for THIS
          // candidate plus how many bounded rework rounds were consumed before
          // it. A DONE/resolved claim always comes from a persisted record.
          const id = path.basename(sessionPath, '.json');
          let rounds = 0;
          try { rounds = listReworkDigests({ stateDir, identityHash: id }).length; } catch { rounds = 0; }
          const ir = internalReviewGate && internalReviewGate.internalReview ? internalReviewGate.internalReview : null;
          return [
            {
              internalReview: `APPROVED clean on ${String(ir?.candidate?.headSha || headSha).slice(0, 12)} — findingsCount=0`,
              mechanism: ir?.mechanism ?? null,
              runId: ir?.runId ?? null,
              reviewedAt: ir?.at ?? null,
            },
            {
              reworkRounds: rounds,
              note: rounds > 0
                ? `${rounds} rework round(s) recorded before this clean review (bounded by MAX_REWORK_ROUNDS)`
                : 'first canonical pass — no prior review findings',
            },
          ];
        })() },
    tests: { items: (() => {
      if (!legacyMode) {
        return [{ note: 'deterministic verification runs in VERIFYING right after this projection; its verdict is carried by the control-loop evidence chain' }];
      }
      const items = [{ note: 'external legacy verification evidence (see Verification); no canonical deterministic verifier runs for adopted sessions' }];
      // Round-5 REWORK (GPT finding): the Tests section carried only a note —
      // render the REAL execution line (command + counts + exit + bound head)
      // and the per-path test detail lines the reviewer asked for.
      if (verificationResult && typeof verificationResult === 'object') {
        const vr = verificationResult;
        items.push({
          testExecution: `${vr.suite ?? 'external suite'} → ${vr.passed ?? '?'} passed / ${vr.failed ?? '?'} failed / ${vr.total ?? '?'} total · exitCode=${vr.exitCode ?? '?'} · headSha=${vr.headSha ?? '?'} · timestamp=${vr.timestamp ?? '?'}`,
        });
        if (Array.isArray(vr.tests)) {
          for (const t of vr.tests) items.push({ testExecutionDetail: String(t) });
        }
      }
      return items;
    })() },
    verification: { items: verificationItems },
    safety: { items: [
      { invariant: 'only ControlLoop terminalizes; executor/Gemini/GPT never merge, close or sync' },
      ...(legacyMode ? [{ provenance: 'legacy-adoption — external, noncanonical execution adopted for the canonical CWA final review (Issue #155); merge/close authority stays with the canonical delivery lifecycle' }] : []),
      // Round-5 REWORK (GPT finding): project the control-loop ledger trace so
      // the PRE_REVIEWING -> REVIEWING -> ... flow is observable from the
      // packet (EMPTY_LEDGER is reported truthfully when no transition exists).
      ...(legacyMode ? [{
        controlLoopTrace: (() => {
          try {
            const trs = readTransitions({ stateDir, identityHash: path.basename(sessionPath, '.json') });
            if (!Array.isArray(trs) || trs.length === 0) return 'EMPTY_LEDGER';
            return trs.slice(-14).map((t) => `${t.ts ?? '?'} ${t.from ?? '?'}->${t.to ?? '?'}${t.reason ? ` (${t.reason})` : ''}`).join(' | ');
          } catch (e) {
            return `UNAVAILABLE (${String(e && e.message ? e.message : e)})`;
          }
        })(),
      }] : []),
      { mutationScope: legacyMode
        ? 'PR already OPEN at the adopted head (external push); merge/close owned by the canonical delivery lifecycle after PASS'
        : 'push (canonical git push primitive) + PR read-back; merge/close owned by the P0-F delivery lifecycle after PASS' },
    ] },
    unverifiedRisks: { items: ['semantic review pending (Gemini pre-review, GPT-5.6 Sol final review)'] },
    delivery: { items: [
      { pr: session.prNumber, prState: 'OPEN', baseBranch: 'main' },
      { mergePolicy: 'squash merge with read-back, only after validated PASS verdict' },
    ] },
  };
  const dir = outputDir || path.join(stateDir, 'review-ready');
  // MCP final-review leg (Issue: mcp-gpt-final-review): the review-mcp-http
  // server rejects any artifact without `- reportDigest:` (REQUEST_DIGEST_MISMATCH)
  // and GPT binds its submit_decision.requestDigest to this stamp. Same formula
  // as scripts/reproject-evidence-155.mjs: sha256 over the JSON report bytes.
  const digest = createHash('sha256').update(JSON.stringify(report), 'utf8').digest('hex');
  const w = writeReviewReady(report, { outputDir: dir, digest });
  if (!w.ok) return fail('REVIEW_PACKET_WRITE_REJECTED', w.errors ?? null);
  return ok({
    packet: { filename: w.filename, filePath: w.filePath, headSha, pr: session.prNumber },
    // The gate result that authorized this READY_FOR_REVIEW stamp — handed
    // back so the checklist projection reuses the SAME resolution (computed
    // with the caller's git transport) instead of re-resolving it.
    internalReviewGate,
    projectedAt: now(),
  });
}
// ---- P0-G (Issue #83): pre-review publish chain ------------------------------
// The canonical review-ready packet is identity-gated on pullRequest, so a PR
// bound to the approved head MUST exist before the reviewers run. Chain (each
// step fail-closed, each with its own read-back):
//   refreshCanonicalHead -> pushBranch (remote read-back evidence)
//   -> PR adopt-or-create (gh read-back evidence) -> session.prNumber persist
//   -> canonical packet projection (same-head overwrite is idempotent).
// The delivery lifecycle stays the owner of merge/close: its ensurePr adopts
// the session-bound PR, and push re-entry is an alreadyPresent short-circuit.
// Gate: the chain runs ONLY when deps.pushExec is provided (run.js injects
// null = real git via spawnSync); fixtures without pushExec keep the legacy
// loop shape (no git, no remote — their reviewers/delivery are stubs).
function bindPullRequest({ session, gh, env }) {
  if (!session || typeof session !== 'object') return fail('PR_BIND_FAILED', 'session required');
  if (typeof session.worktreePath !== 'string' || !session.worktreePath) return fail('PR_BIND_FAILED', 'session.worktreePath missing');
  const spec = deliverySpec({ repo: session.repo, issue: session.issueNumber, headSha: session.headSha, branch: session.branch ?? undefined });
  if (!spec.ok) return fail(spec.code, spec.detail);
  const s = spec.value;
  if (session.taskId !== `${s.repo}#${s.issue}`) return fail('PR_BIND_IDENTITY_MISMATCH', 'session taskId does not match repo and issue');
  const id = identityHash({ repo: s.repo, issueNumber: s.issue });
  if (session.identityHash != null && session.identityHash !== id) return fail('PR_BIND_IDENTITY_MISMATCH', 'session identityHash does not match repo and issue');
  const marker = `<!-- soc-brain:identity=${id} -->`;
  const viewArgs = (number) => ['pr', 'view', String(number), '--repo', s.repo, '--json', 'state,number,headRefOid,headRefName,baseRefName,headRepository,url,body'];
  const validate = (p, number) => {
    if (!p || Number(p.number) !== Number(number)) return fail('PR_BIND_IDENTITY_MISMATCH', `view number=${p?.number} expected=${number}`);
    if (String(p.state).toUpperCase() !== 'OPEN') return fail('PR_BIND_STATE_INVALID', `PR #${number} state=${p.state}`);
    if (String(p.headRefOid || '').toLowerCase() !== s.headSha) return fail('PR_BIND_HEAD_MISMATCH', `PR head=${p.headRefOid} approved=${s.headSha}`);
    if (p.headRefName !== s.branch || p.baseRefName !== s.baseBranch
        || String(p.headRepository?.nameWithOwner || '').toLowerCase() !== s.repo
        || String(p.url || '').toLowerCase() !== `https://github.com/${s.repo}/pull/${number}`
        || (String(p.body || '').match(/<!-- soc-brain:identity=[a-f0-9]+ -->/g) || []).join() !== marker
        || !new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${s.issue}\\b`, 'i').test(String(p.body || ''))) {
      return fail('PR_BIND_IDENTITY_MISMATCH', { number, repo: s.repo, branch: s.branch, issue: s.issue });
    }
    return ok({ prNumber: Number(number), adopted: true, binding: { prNumber: Number(number), repo: s.repo, issueNumber: s.issue, identityHash: id, branch: s.branch, baseBranch: s.baseBranch, headSha: s.headSha, url: p.url } });
  };
  const call = (args) => {
    if (typeof gh === 'function') {
      try { return gh(args); } catch (e) { return { unknown: true, error: String((e && e.message) || e) }; }
    }
    const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, env: env || undefined });
    if (r.error) return { unknown: true, error: String(r.error.code || r.error.message || r.error) };
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const json = (args) => {
    const out = call(args);
    if (out.unknown) return { unknown: true, error: out.error };
    if (Number(out.code) !== 0) return { code: Number(out.code), stderr: String(out.stderr || '').slice(0, 300) };
    try { return { data: JSON.parse(String(out.stdout || '')) }; } catch (e) { return { unknown: true, error: `GH_JSON_PARSE: ${String((e && e.message) || e)}` }; }
  };
  // (a) Adopt: an already-bound session PR, verified OPEN at the exact head.
  if (Number.isInteger(session.prNumber) && session.prNumber > 0) {
    const v = json(viewArgs(session.prNumber));
    if (v.unknown) return fail('PR_BIND_UNKNOWN', v.error);
    if (v.code != null) return fail('PR_BIND_VIEW_FAILED', `gh exit ${v.code}: ${v.stderr}`);
    return validate(v.data, session.prNumber);
  }
  // (b) Crash-recovery adoption: any existing branch PR must be read back.
  // List results can lag the pushed HEAD; creating on that stale observation
  // would duplicate an already-created PR. Only view proves the full binding.
  const l = json(['pr', 'list', '--repo', s.repo, '--head', s.branch, '--state', 'all', '--json', 'number,state,headRefOid']);
  if (l.unknown) return fail('PR_BIND_UNKNOWN', l.error);
  if (l.code != null) return fail('PR_BIND_SEARCH_FAILED', `gh exit ${l.code}: ${l.stderr}`);
  if (!Array.isArray(l.data)) return fail('PR_BIND_UNKNOWN', 'PR list must be an array');
  const open = l.data.filter((p) => p && String(p.state || '').toUpperCase() === 'OPEN');
  if (open.length > 1) return fail('PR_BIND_AMBIGUOUS', 'multiple open PRs for the canonical task branch');
  const mine = open[0] ?? l.data[0];
  if (mine) {
    const v = json(viewArgs(mine.number));
    if (v.unknown) return fail('PR_BIND_UNKNOWN', v.error);
    if (v.code != null) return fail('PR_BIND_VIEW_FAILED', `gh exit ${v.code}: ${v.stderr}`);
    return validate(v.data, mine.number);
  }
  // (c) Create: the approved head is already pushed; the read-back is the
  // only create evidence (state OPEN at the approved head).
  const c = call(['pr', 'create', '--repo', s.repo, '--base', s.baseBranch, '--head', s.branch, '--title', s.title, '--body', `${s.body}\n\n${marker}`]);
  if (c.unknown) return fail('PR_BIND_UNKNOWN', c.error);
  if (Number(c.code) !== 0) return fail('PR_BIND_CREATE_FAILED', String((c.stderr || c.stdout) || '').trim().slice(0, 300));
  const m = String(c.stdout ?? '').match(/\/pull\/(\d+)/);
  if (!m) return fail('PR_BIND_UNKNOWN', `create output unparseable: ${String(c.stdout ?? '').slice(0, 120)}`);
  const v = json(viewArgs(m[1]));
  if (v.unknown) return fail('PR_BIND_UNKNOWN', v.error);
  if (v.code != null) return fail('PR_BIND_READBACK_FAILED', `gh exit ${v.code}: ${v.stderr}`);
  const bound = validate(v.data, m[1]);
  if (!bound.ok) return bound;
  return ok({ ...bound.value, adopted: false });
}

// Issue #159: review-only adoption gate. The remote PR MUST already exist, be
// OPEN, and sit at the EXACT immutable head — it is never created and a foreign
// or drifted head fails closed. gh is injected (null = real gh via spawnSync),
// matching bindPullRequest's transport contract.
function requireExistingPullRequest({ session, gh = null, env = null, prNumber }) {
  const spec = deliverySpec({ issue: session.issueNumber, headSha: session.headSha, branch: typeof session.branch === 'string' ? session.branch : undefined });
  if (!spec.ok) return fail(spec.code, spec.detail);
  const s = spec.value;
  const call = (args) => {
    if (typeof gh === 'function') {
      try { return gh(args); } catch (e) { return { unknown: true, error: String((e && e.message) || e) }; }
    }
    const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, env: env || undefined });
    if (r.error) return { unknown: true, error: String(r.error.code || r.error.message || r.error) };
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const out = call(['pr', 'view', String(prNumber), '--repo', s.repo, '--json', 'state,number,headRefOid']);
  if (out.unknown) return fail('REVIEW_ONLY_PR_UNKNOWN', out.error);
  if (Number(out.code) !== 0) return fail('REVIEW_ONLY_PR_UNBOUND', `gh pr view exit ${out.code}: ${String(out.stderr || '').slice(0, 200)}`);
  let p;
  try { p = JSON.parse(String(out.stdout || '{}')); } catch (e) { return fail('REVIEW_ONLY_PR_UNKNOWN', String((e && e.message) || e)); }
  if (!p || Number(p.number) !== Number(prNumber)) return fail('REVIEW_ONLY_PR_IDENTITY_MISMATCH', `view number=${p && p.number} expected=${prNumber}`);
  const st = String(p.state || '').toUpperCase();
  if (st !== 'OPEN') return fail('REVIEW_ONLY_PR_STATE_INVALID', st || null);
  if (String(p.headRefOid || '').toLowerCase() !== s.headSha) return fail('REVIEW_ONLY_REMOTE_HEAD_DRIFT', { remoteHead: p.headRefOid ?? null, target: s.headSha });
  return ok({ prNumber: Number(p.number), adopted: true });
}

// Session record persistence for the controlLoop metadata block. The canonical
// FSM transitions (taskFinish/taskBlock) still own their own persistence inside
// runtime-sandbox; this helper only persists binding metadata ADDITIVELY and —
// Issue #145 rework F1 — through the SERIALIZED ownership-safe update
// primitive (authoritative read inside the ownership critical section; a
// concurrent transfer/adoption can never be clobbered by a stale snapshot).
function persistSessionRecordWith(sessionPath, mutate) {
  return updateSessionUnderOwnershipLock(sessionPath, (auth) => {
    mutate(auth);
    return { session: auth };
  });
}

// Issue #83: persist the bound PR number additively (prHistory) with a
// read-back verify. FSM transitions and canonical session states remain owned
// by the runtime-sandbox primitives; this only adds binding metadata.
function persistPrNumber(sessionPath, prNumber, binding = null) {
  const p = updateSessionUnderOwnershipLock(sessionPath, (auth) => {
    if (binding && (auth.repo !== binding.repo || auth.issueNumber !== binding.issueNumber
        || auth.branch !== binding.branch || auth.headSha !== binding.headSha
        || identityHash({ repo: auth.repo, issueNumber: auth.issueNumber }) !== binding.identityHash
        || (auth.prNumber != null && auth.prNumber !== prNumber))) {
      return fail('PR_BIND_PERSIST_MISMATCH', 'canonical session changed before PR binding could be persisted');
    }
    auth.prNumber = prNumber;
    auth.controlLoop = auth.controlLoop && typeof auth.controlLoop === 'object' ? auth.controlLoop : {};
    const unchanged = binding && JSON.stringify(auth.controlLoop.prBinding) === JSON.stringify(binding);
    if (binding) auth.controlLoop.prBinding = binding;
    auth.controlLoop.prHistory = Array.isArray(auth.controlLoop.prHistory) ? auth.controlLoop.prHistory : [];
    if (!unchanged) auth.controlLoop.prHistory.push({ prNumber, ...(binding ? { headSha: binding.headSha, identityHash: binding.identityHash } : {}), at: new Date().toISOString() });
    return { session: auth };
  });
  if (!p.ok) return fail('PR_BIND_PERSIST_FAILED', p.detail ?? p.reason ?? null);
  if (p.session.prNumber !== prNumber) return fail('PR_BIND_VERIFY_FAILED', `persisted prNumber=${p.session.prNumber}`);
  if (binding && JSON.stringify(p.session.controlLoop.prBinding) !== JSON.stringify(binding)) return fail('PR_BIND_VERIFY_FAILED', 'persisted PR binding differs from GitHub read-back');
  return ok({ persisted: true });
}

// The publish chain used by the fresh EXECUTING leg AND every rework leg (each
// produces a commit that must be published before reviewers see it). Push is
// ALWAYS attempted: pushBranch's pre-mutation remote read-back makes a
// re-entry for an unchanged head a cheap alreadyPresent short-circuit, which
// also covers a crash between refresh and push.
function runPublishChain({ sessionPath, stateDir, identityHash: id, deps, packetPolicy = 'defer' } = {}) {
  const hr = refreshCanonicalHead({ sessionPath, stateDir, exec: deps.pushExec ?? null });
  if (!hr.ok) return { ok: false, code: hr.code, detail: hr.detail, step: 'head-refresh' };
  const rs2 = readSessionByHash({ stateDir, identityHash: id });
  if (!rs2.ok) return { ok: false, code: 'SESSION_READ_FAILED', detail: rs2.reason, step: 'session-read' };
  const session = rs2.session;
  const ps = pushBranch({
    session: { worktreePath: session.worktreePath, branch: session.branch, baseSha: session.baseSha, headSha: session.headSha },
    exec: deps.pushExec ?? null,
  });
  if (!ps.ok) return { ok: false, code: ps.code, detail: ps.detail, step: 'push' };
  const pb = bindPullRequest({ session, gh: deps.gh ?? null, env: deps.ghEnv ?? null });
  if (!pb.ok) return { ok: false, code: pb.code, detail: pb.detail, step: 'pr-bind' };
  const pp = persistPrNumber(sessionPath, pb.value.prNumber, pb.value.binding);
  if (!pp.ok) return { ok: false, code: pp.code, detail: pp.detail, step: 'pr-persist' };
  // Packet policy mirrors where the chain sits in the walk:
  //   'defer'   (fresh/resume legs, commit recovery) — the OCR review has NOT
  //             run yet, so a missing record reports INTERNAL_REVIEW_PENDING
  //             and writes no packet instead of stamping READY_FOR_REVIEW on
  //             unreviewed code;
  //   'require' (rework leg, after rework-verify) — the review MUST have
  //             produced its record for the repaired candidate; anything else
  //             is a typed INTERNAL_REVIEW_PENDING/STALE failure of the chain.
  const pk = projectReviewReadyPacket({
    sessionPath, stateDir, exec: deps.pushExec ?? null, gh: deps.gh ?? null,
    deferPending: packetPolicy !== 'require',
  });
  if (!pk.ok) return { ok: false, code: pk.code, detail: pk.detail, step: 'packet' };
  return ok({
    headSha: hr.value.headSha,
    headRefreshed: hr.value.refreshed === true,
    push: { branch: ps.value.branch, headSha: ps.value.headSha, alreadyPresent: ps.value.alreadyPresent === true },
    pr: { number: pb.value.prNumber, adopted: pb.value.adopted === true },
    packet: pk.value.packet,
  });
}

// A failed publish leaves the canonical ledger at VERIFYING. Retrying enters
// the same read-back-first chain; it never repeats the executor or assumes a
// transport failure proved the absence of a remote side effect.
function publishChainFailure(pub) {
  const noCommit = ['HEAD_REFRESH_REFUSED_BASE', 'PUSH_NOTHING_TO_PUSH'].includes(pub.code);
  const pushUnproven = ['PUSH_AMBIGUOUS', 'PUSH_READBACK_FAILED', 'PUSH_READBACK_MISMATCH'].includes(pub.code);
  const recoverable = noCommit || pushUnproven || ['PUSH_PRE_READBACK_FAILED', 'PR_BIND_UNKNOWN', 'PR_BIND_SEARCH_FAILED', 'PR_BIND_CREATE_FAILED', 'PR_BIND_READBACK_FAILED', 'PR_BIND_VIEW_FAILED'].includes(pub.code);
  // An OCR internal-review refusal at the packet step (packetPolicy 'require')
  // is NOT a dead end: a resume re-enters at the SAME VERIFYING checkpoint and
  // re-runs the review, which either proves the candidate clean or reports the
  // drift. It must stay recoverable there — never a terminal block, never a
  // silent pass.
  const reviewPending = INTERNAL_REVIEW_HANDOFF_CODES.includes(pub.code);
  let status = 'FAILED';
  if (reviewPending) status = 'REVIEW_PENDING';
  else if (noCommit) status = 'NO_COMMIT';
  else if (pushUnproven) status = 'PUSH_UNPROVEN';
  else if (pub.step === 'push') status = 'NO_PUSH';
  else if (pub.step === 'pr-bind') status = 'PR_UNBOUND';
  return fail(pub.code || 'PUBLISH_CHAIN_FAILED', {
    step: pub.step ?? null, detail: pub.detail ?? null,
    status,
    recoverable: recoverable || reviewPending,
    resumeState: 'VERIFYING',
  });
}

// ---- Issue #264 option C: canonical commit recovery at the VERIFYING checkpoint
// PUSH_DIRTY_FOREIGN is deliberately NOT relaxed: a dirty worktree still never
// leaves this machine. What is added is the missing EXIT from the closed loop
// reproduced at evidence/pr-263/<head>/commit-recovery-repro.log — when the
// dirt IS the task's own canonical output and the prior executor is provably
// terminal, ONE recovery executor is dispatched through the existing adapter
// channel to commit it, and the walk re-enters the canonical publish chain.
// No FSM state, no transition, no admission-as-dispatch: the VERIFYING
// checkpoint and every prior evidence record are preserved and the attempt is
// recorded by the canonical commit-recovery API instead.

// Canonical scope source (2): every path a persisted canonical rework record
// explicitly names. Free text is scanned for repo-path-shaped tokens; a match
// only ever WIDENS scope for a path that is already untracked AND already
// Issue #263 reviewer finding 1: scope for a recovery commit comes ONLY from
// the canonical whitelist bound into `session.taskContract` by the control
// plane at projection time, reconciled with the worktree copy by
// resolveRecoveryScope (commit-recovery.mjs). Reviewer/rework prose is never
// scraped for path-shaped tokens, a worktree heading is never authority, and a
// missing/wrong/unprovable binding is a typed-block rather than "everything
// tracked is fine".

function gitStatusLines({ worktreePath, exec }) {
  const r = execGit(exec, worktreePath, ['status', '--porcelain']);
  if (r.unknown) return { unknown: true, error: r.error };
  if (r.status !== 0) return { unknown: false, failed: true, error: (r.stderr || r.stdout).trim() };
  return { unknown: false, lines: r.stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean) };
}

// The recovery gate. Every branch either returns a typed refusal (nothing
// dispatched, nothing persisted) or dispatches EXACTLY ONE recovery executor
// under the canonical attempt record.
async function attemptCommitRecovery({ sessionPath, stateDir, identityHash: id, deps, executor, route, pub }) {
  if (typeof executor !== 'function') {
    return { ...fail('COMMIT_RECOVERY_NO_EXECUTOR', { recoverable: false, resumeState: 'VERIFYING' }) };
  }
  if (!route || typeof route.model !== 'string' || !route.model.trim()
    || typeof route.executorKind !== 'string' || !route.executorKind.trim()) {
    return { ...fail('COMMIT_RECOVERY_ROUTE_UNAVAILABLE', { recoverable: false, resumeState: 'VERIFYING', route: route ?? null }) };
  }
  const rs = readSessionByHash({ stateDir, identityHash: id });
  if (!rs.ok) return fail('SESSION_READ_FAILED', rs.reason);
  const session = rs.session;
  const worktree = session.worktreePath;
  if (typeof worktree !== 'string' || !worktree) {
    return { ...fail('COMMIT_RECOVERY_SCOPE_VIOLATION', { reason: 'session.worktreePath missing', recoverable: false, resumeState: 'VERIFYING' }) };
  }

  // (0) Resolve the canonical whitelist BEFORE the dirty set is even read, and
  //     therefore before any attempt record, any FSM transition, any dispatch,
  //     any commit and any push. A missing binding, a binding for another task
  //     or identity, a contract whose authority cannot be proved, or a
  //     whitelist widened past the canonical scope all typed-block right here —
  //     the executor never gets a chance to widen its own authority.
  const authz = resolveRecoveryScope({ session, identityHash: id });
  const foreign = pub && pub.detail && Array.isArray(pub.detail.foreignPaths) ? pub.detail.foreignPaths : [];
  if (!authz.ok) {
    return { ...fail(authz.code, {
      reason: authz.reason ?? null,
      authority: authz.authority ?? null,
      authorityDetail: authz.detail ?? null,
      field: authz.field ?? null,
      fields: authz.fields ?? null,
      canonicalScope: authz.canonicalScope ?? null,
      declared: authz.declared ?? null,
      allowedPaths: null,
      inScope: [], outScope: [], unclassified: [],
      foreign,
      recoverable: false, resumeState: 'VERIFYING',
    }) };
  }

  // (a) Re-read the canonical dirty set and reconcile it with the canonical
  //     task/rework scope. push.mjs already refused these exact paths; this
  //     decides whether they are the task's own output (commit them) or
  //     foreign (typed-block, no dispatch).
  const st = gitStatusLines({ worktreePath: worktree, exec: deps.pushExec ?? null });
  if (st.unknown) return { ...fail('COMMIT_RECOVERY_AMBIGUOUS', { step: 'status', detail: st.error, recoverable: false, resumeState: 'VERIFYING' }) };
  if (st.failed) return { ...fail('COMMIT_RECOVERY_STATUS_FAILED', { detail: st.error, recoverable: false, resumeState: 'VERIFYING' }) };
  const scope = classifyCommitScope({
    statusLines: st.lines,
    foreignPaths: foreign,
    allowedPaths: authz.allowedPaths,
  });
  // Typed-block BEFORE any dispatch/commit/push and with NO FSM transition:
  // missing declared scope, a path outside it, or nothing left in scope all
  // refuse here — recovery never widens scope to make a commit possible.
  scope.authority = authz.authority;
  if (!scope.ok) {
    return { ...fail(scope.code, {
      reason: scope.reason ?? null,
      authority: scope.authority ?? null,
      allowedPaths: scope.allowedPaths ?? null,
      inScope: scope.inScope ?? [], outScope: scope.outScope ?? [],
      unclassified: scope.unclassified ?? [],
      foreign,
      recoverable: false, resumeState: 'VERIFYING',
    }) };
  }

  // (b) The prior executor must be provably terminal AND have released its
  //     mutation authority before a second executor may be spawned. Missing,
  //     foreign, latched or merely-alive evidence typed-blocks here.
  const rb = readExecutionRecord({ stateDir, repo: session.repo, issueNumber: session.issueNumber });
  const auth = assertPriorExecutorRelinquished({ identityHash: id, record: rb && rb.ok ? rb.record : null });
  if (!auth.ok) {
    return { ...auth, detail: {
      ...(auth.detail || {}),
      // The canonical reader already refuses a record that is not at this
      // identity's canonical location — surface WHY, never the raw record.
      readerReason: rb && rb.ok ? null : ((rb && rb.reason) || null),
      recordPath: (rb && rb.path) || null,
      resumeState: 'VERIFYING',
    } };
  }

  // (c) Idempotency: one dispatch per dirty set, bounded per identity. A
  //     relaunch in the middle of a recovery, or a resume after one, reads the
  //     same records and never spawns a second executor.
  const digest = recoveryDigest({ identityHash: id, headSha: session.headSha, foreignPaths: scope.inScope });
  const lock = evaluateRecoveryLock({ records: listCommitRecoveryRecords({ stateDir, identityHash: id }), digest });
  if (!lock.ok) return { ...lock, detail: { ...(lock.detail || {}), recoverable: false, resumeState: 'VERIFYING' } };

  // (d) Record the attempt through the canonical API BEFORE any dispatch, so a
  //     crash after this point can never double-dispatch (the lock is durable).
  const record = buildCommitRecoveryRecord({
    identityHash: id, attempt: lock.value.attempt, digest, session, scope,
    priorExecution: { ...auth.value, recordPath: (rb && rb.ok && rb.path) || null },
    route: { executorKind: route.executorKind, model: route.model },
  });
  const pr = persistCommitRecoveryRecord({ stateDir, identityHash: id, record });
  if (!pr.ok) return { ...fail('COMMIT_RECOVERY_PERSIST_FAILED', { detail: pr.detail, recoverable: false, resumeState: 'VERIFYING' }) };

  // (e) Dispatch exactly one recovery executor through the SAME adapter channel
  //     the rework leg uses, in the SAME task worktree, with NO FSM transition.
  const instruction = buildCommitRecoveryInstruction({ session, record });
  let res;
  try {
    res = await executor({
      sessionPath,
      model: route.model,
      executorKind: route.executorKind,
      reworkInstruction: instruction,
      reworkCwd: deps.reworkCwd ?? null,
      reworkModel: deps.reworkModel ?? null,
    });
  } catch (e) {
    stampCommitRecoveryOutcome({ stateDir, identityHash: id, digest, outcome: { status: 'DISPATCH_THREW', error: String((e && e.message) || e) } });
    return { ...fail('COMMIT_RECOVERY_DISPATCH_THREW', { detail: String((e && e.message) || e), recoverable: true, resumeState: 'VERIFYING' }) };
  }
  const dispatched = !!(res && res.ok === true);
  const stamped = stampCommitRecoveryOutcome({
    stateDir, identityHash: id, digest,
    outcome: {
      status: dispatched ? 'DISPATCHED' : 'DISPATCH_FAILED',
      dispatchedAt: new Date().toISOString(),
      dispatchCode: dispatched ? null : ((res && res.code) || null),
      executionRecordPath: dispatched && res.value ? (res.value.executionRecordPath ?? null) : null,
    },
  });
  if (!dispatched) {
    return { ...fail('COMMIT_RECOVERY_DISPATCH_FAILED', {
      detail: (res && res.code) || null, stamped: stamped.ok === true,
      recoverable: true, resumeState: 'VERIFYING',
    }) };
  }
  return ok({
    dispatched: true, digest, attempt: record.attempt,
    executionRecordPath: (res.value && res.value.executionRecordPath) || null,
    inScope: scope.inScope,
  });
}

// publish chain + optional commit recovery. Returns the same shape
// runPublishChain/publishChainFailure already returned, so every call site
// keeps `if (!pub.ok) return pub;`.
async function publishOrRecover({ sessionPath, stateDir, identityHash: id, deps, executor = null, route = null, packetPolicy = 'defer' } = {}) {
  const first = runPublishChain({ sessionPath, stateDir, identityHash: id, deps, packetPolicy });
  if (first.ok || first.code !== 'PUSH_DIRTY_FOREIGN') {
    return first.ok ? first : publishChainFailure(first);
  }
  const rec = await attemptCommitRecovery({ sessionPath, stateDir, identityHash: id, deps, executor, route, pub: first });
  if (!rec.ok) return rec; // typed block: nothing dispatched, checkpoint untouched
  // Requirement 5: back into the canonical publish -> verify -> pre-review ->
  // final-review walk. A new review round is only reachable after this chain
  // succeeds at the NEW head, so a round is never opened on stale evidence.
  const second = runPublishChain({ sessionPath, stateDir, identityHash: id, deps, packetPolicy });
  if (second.ok) return second;
  if (second.code === 'PUSH_DIRTY_FOREIGN') {
    return { ...fail('COMMIT_RECOVERY_INCOMPLETE', {
      step: 'commit-recovery', detail: second.detail ?? null,
      digest: rec.value && rec.value.digest, attempt: rec.value && rec.value.attempt,
      recoverable: false, resumeState: 'VERIFYING',
    }) };
  }
  return publishChainFailure(second);
}

export const CONTROL_LOOP_SCHEMA_VERSION = '1';

// ControlLoop is Soc_brain's own orchestrator: it only terminalizes canonical
// tasks of THIS repository. Foreign sessions are refused before any transition.
export const CONTROL_LOOP_CANONICAL_REPO = 'duongpdddic-droid/soc_brain';

export const LOOP_STATES = Object.freeze([
  'ACCEPTED', 'ROUTED', 'EXECUTING', 'VERIFYING', 'PRE_REVIEWING',
  'FINAL_REVIEWING', 'DECIDING', 'REWORK', 'DELIVERING', 'COMPLETED', 'BLOCKED',
]);
export const TERMINAL_STATES = Object.freeze(new Set(['COMPLETED', 'BLOCKED']));

// P0-E (Issue #79): bounded rework budget. Each validated GPT REWORK verdict
// may drive AT MOST ONE executor re-dispatch; the budget counts the persisted
// rework decision records (crash-safe, not in-memory), and exhaustion is a
// canonical BLOCKED escalation — never a silent infinite rework loop and
// never a technical failure dressed up as a Human Gate.
export const MAX_REWORK_ROUNDS = 3;

// Granular FSM milestone event names (Issue #9000021)
export const GRANULAR_MILESTONE_EVENTS = Object.freeze({
  ROUTED: 'ROUTED',
  EXECUTING: 'EXECUTING',
  VERIFYING: 'VERIFYING',
  FINAL_REVIEWING: 'FINAL_REVIEWING',
  DECIDING: 'DECIDING',
  DELIVERING: 'DELIVERING',
});

// evidence.code whitelist eligible for the BOUNDED pre-dispatch route retry
// (routeFailTail below). Widening this list widens recovery: a code belongs
// here only when the failure provably happens BEFORE any executor dispatch
// and is safe to re-attempt once per relaunch. Observed on task #9000031:
// MODEL_UNRESOLVED from `spawnSync opencode.exe ETIMEDOUT` in the model
// availability probe. Route failures AFTER dispatch (or unknown side effects)
// are never whitelisted, and the REWORK cause/edge is never reused for them.
export const ROUTE_RETRY_SUPPORTED_CODES = Object.freeze(['MODEL_UNRESOLVED']);

// Ledger-enforced attempt budget for the pre-spawn instruction retry
// (execute:FAIL with evidence.code INSTRUCTION_REQUIRED). A resume may
// re-enter the execute step ONLY while the count of such failure records for
// this identity is below the limit; every failed retry appends its own record,
// so the budget is exhausted in the append-only ledger (never hand-edited).
export const EXECUTE_INSTRUCTION_RETRY_LIMIT = 2;

export const ALLOWED_TRANSITIONS = Object.freeze({
  ACCEPTED: new Set(['ROUTED', 'BLOCKED']),
  ROUTED: new Set(['EXECUTING', 'BLOCKED']),
  EXECUTING: new Set(['VERIFYING', 'BLOCKED']),
  // PRE-GATE-REVIEW-01: an INTERNAL_REVIEW_FINDINGS failure at the verify
  // step is a reviewer verdict on the SAME candidate, so it enters the SAME
  // bounded rework leg the GPT REWORK verdict uses (sourceFrom VERIFYING) —
  // one legal edge, budget/duplicate/digest guards shared, never a second
  // FSM edge invented for it.
  VERIFYING: new Set(['PRE_REVIEWING', 'REWORK', 'BLOCKED']),
  PRE_REVIEWING: new Set(['FINAL_REVIEWING', 'BLOCKED']),
  FINAL_REVIEWING: new Set(['DECIDING', 'BLOCKED']),
  DECIDING: new Set(['REWORK', 'DELIVERING', 'BLOCKED']),
  REWORK: new Set(['EXECUTING', 'BLOCKED']),
  DELIVERING: new Set(['COMPLETED', 'BLOCKED']),
  COMPLETED: new Set(),
  // P1 (Issue #155 round-7, human-authorized unblock — Issue #107 class):
  // BLOCKED -> REWORK exists ONLY as the sanctioned operator-unblock re-entry
  // of a terminalized legacy-adoption session. Its single writer is
  // admitOperatorUnblock + the audit edge in runLegacyFinalReview (token-gated,
  // exact tail match); every other BLOCKED shape stays fail-closed because no
  // other call site emits from:'BLOCKED'.
  BLOCKED: new Set(['REWORK']),
});

function ok(v, extra = {}) { return { ok: true, value: v, ...extra }; }
function fail(code, detail) { return { ok: false, code, detail: detail ?? null }; }

function defaultStateDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.USERPROFILE || 'C:\\Users\\Admin', '.soc-brain', 'state');
  }
  return path.join(process.env.HOME || '/root', '.soc-brain', 'state');
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

function loopDirFor({ stateDir = defaultStateDir(), identityHash: id }) {
  return ensureDir(path.join(stateDir, 'control-loop', id));
}

function transitionsPathFor({ stateDir = defaultStateDir(), identityHash: id }) {
  return path.join(loopDirFor({ stateDir, identityHash: id }), 'transitions.jsonl');
}

// ---- READY_FOR_REVIEW notification obligation (review round-2 blocker) ------
// Lifecycle contract: the canonical boundary transition to DELIVERING (the
// READY_FOR_REVIEW boundary) carries a REQUIRED notification side-effect that
// must be satisfied BEFORE the loop may continue to COMPLETED. Ordering:
//   boundary transition -> notification side-effect -> delivery evidence
//   -> only then dependent lifecycle continuation.
// Ownership: ControlLoop itself owns the dispatch (via the telegram-dispatch
// primitive) — never the executor/model's memory. Idempotency is owned by the
// dispatch ledger: ONLY API_ACCEPTED is terminal delivery evidence and
// permanently dedupes; DELIVERY_FAILED/NOT_ATTEMPTED stay recoverable through
// the bounded recoverLifecycleEvent() budget (MAX_DELIVERY_ATTEMPTS).
// Fail-closed: no persistent delivery evidence -> DELIVER_FAILED; the loop
// never claims notification delivered when it was not.
const READY_FOR_REVIEW_EVENT = 'READY_FOR_REVIEW';

function readinessNotificationEvidence({ session, stateDir, spawn = null, configPath = null, now = null, note = null, packetPath = null }) {
  const args = { session, event: READY_FOR_REVIEW_EVENT, stateDir, allowNonCanonicalStateRoot: true, now, note };
  let r;
  try {
    r = spawn
      ? dispatchLifecycleEvent({ ...args, spawn, configPath, documentPath: packetPath || null })
      : dispatchLifecycleEvent({ ...args, configPath, documentPath: packetPath || null });
  } catch (e) {
    return { status: 'NOT_ATTEMPTED', reason: 'DISPATCH_INTERNAL_ERROR', error: String((e && e.message) || e) };
  }
  const status = r && typeof r.status === 'string' ? r.status : 'NOT_ATTEMPTED';
  if (status === 'API_ACCEPTED') {
    return { status, messageId: r.messageId ?? null, recordsPath: r.recordsPath ?? null };
  }
  return {
    status,
    reason: r ? ((r.reason ?? r.error) ?? null) : null,
    attempts: r && Number.isInteger(r.attempts) ? r.attempts : null,
    recovery: r && typeof r.recovery === 'string' ? r.recovery : null,
    recordsPath: r && r.recordsPath ? r.recordsPath : null,
  };
}

// ---- Granular FSM milestone Telegram dispatch (Issue #9000021) --------------
// Fail-safe: each dispatch is best-effort — NEVER throws into the FSM path,
// NEVER mutates canonical task state. A transport failure only persists
// truthful evidence (NOT_ATTEMPTED/DELIVERY_FAILED) and the FSM continues.
function dispatchGranularMilestone({ session, event, stateDir, spawn = null, configPath = null, now = null, note = null }) {
  if (!GRANULAR_MILESTONE_EVENTS[event]) return { status: 'NOT_ATTEMPTED', reason: 'INVALID_MILESTONE_EVENT' };
  // allowNonCanonicalStateRoot is true ONLY when an explicit spawn seam is
  // provided (offline tests / injected transport). With spawn=null the default
  // spawnSync path is gated to the canonical state root — a temp stateDir
  // short-circuits NOT_ATTEMPTED before any network/worker spawn.
  const args = { session, event, stateDir, allowNonCanonicalStateRoot: Boolean(spawn), now, note };
  try {
    return spawn
      ? dispatchLifecycleEvent({ ...args, spawn, configPath })
      : dispatchLifecycleEvent({ ...args, configPath });
  } catch (e) {
    return { status: 'NOT_ATTEMPTED', reason: 'DISPATCH_INTERNAL_ERROR', error: String((e && e.message) || e) };
  }
}

export function appendTransition({ stateDir, identityHash: id, record, sessionPath = null }) {
  // Mutation boundary: the control-loop ledger is written only by a process
  // that still holds a live session-admission fence (fail-closed when armed).
  const admitted = assertAdmissionFence({ sessionPath, identityHash: id });
  if (!admitted.ok) {
    return {
      ok: false,
      code: admitted.code || 'ADMISSION_FENCE_MISSING',
      detail: admitted.detail || 'session admission fence failed closed',
      failClosed: 'SESSION_ADMISSION',
    };
  }
  const fp = transitionsPathFor({ stateDir, identityHash: id });
  ensureDir(path.dirname(fp));
  fs.appendFileSync(fp, JSON.stringify({ schemaVersion: CONTROL_LOOP_SCHEMA_VERSION, ...record }) + '\n', 'utf8');
  return { ok: true, path: fp };
}

export function readTransitions({ stateDir = defaultStateDir(), identityHash: id } = {}) {
  const fp = transitionsPathFor({ stateDir, identityHash: id });
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function readSessionByHash({ stateDir = defaultStateDir(), identityHash: id }) {
  const sp = path.join(stateDir, 'sessions', `${id}.json`);
  return readSessionRecord(sp);
}

function newLoopToken({ identityHash: id, sessionPath }) {
  return createHash('sha256')
    .update(`${CONTROL_LOOP_SCHEMA_VERSION}|${id}|${sessionPath}|${randomUUID()}`)
    .digest('hex');
}

// PRE-GATE-REVIEW-01: is this verify failure a rerouteable internal-review
// VERDICT? Only a typed INTERNAL_REVIEW_FINDINGS carrying a non-empty
// redacted findings array qualifies. Transport/timeouts, empty payloads and
// every other code keep the existing verify:FAIL -> BLOCKED semantics —
// a technical failure is never dressed up as a reviewer verdict.
function isInternalReviewReroute(result) {
  return Boolean(
    result
    && result.ok === false
    && result.code === 'INTERNAL_REVIEW_FINDINGS'
    && result.detail && typeof result.detail === 'object'
    && Array.isArray(result.detail.findings)
    && result.detail.findings.length > 0,
  );
}

export function bindLoop({ sessionPath, identityHash: id, stateDir = defaultStateDir(), now = () => new Date().toISOString(), onTransition = null } = {}) {
  if (typeof sessionPath !== 'string' || !sessionPath) return fail('MISSING_SESSION_PATH');
  if (typeof id !== 'string' || !id) return fail('MISSING_IDENTITY_HASH');
  const token = newLoopToken({ identityHash: id, sessionPath });

  function transition({ from, to, reason = null, evidence = null, extras = {} }) {
    if (!ALLOWED_TRANSITIONS[from] || !ALLOWED_TRANSITIONS[from].has(to)) {
      return fail('ILLEGAL_TRANSITION', `from=${from} to=${to}`);
    }
    const record = {
      ts: now(), from, to, reason, evidence,
      identityHash: id, sessionPath, ...extras,
    };
    const appended = appendTransition({ stateDir, identityHash: id, record, sessionPath });
    if (!appended.ok) return fail(appended.code || 'LEDGER_WRITE_FAILED', appended.detail ?? null);
    // Fail-soft observer hook (milestone Telegram dispatch). NEVER throws into
    // the FSM path and NEVER mutates the just-persisted transition record.
    if (typeof onTransition === 'function') {
      try { onTransition(record); } catch { /* fail-soft */ }
    }
    return ok({ state: to, record });
  }

  function terminalize({ outcome, decision, dispatchOptions = {} }) {
    // Defense-in-depth: refuse unless THIS loop bound the session token first.
    const auth = assertTerminalizationAuthorized({ sessionPath, identityHash: id, presentedToken: token, stateDir });
    if (!auth.ok) return auth;
    if (typeof outcome !== 'string') return fail('MISSING_OUTCOME');
    if (outcome === 'COMPLETED' || outcome === 'FAILED') {
      return taskFinish({ sessionPath, outcome, dispatchOptions });
    }
    if (outcome === 'BLOCKED') {
      return taskBlock({ sessionPath, dispatchOptions });
    }
    return fail('INVALID_OUTCOME', `outcome=${outcome}`);
  }

  async function step({ name, from, to, run, reason = null, capture = 'ok', retryOnOwnFail = false, retryOnOwnThrow = false, rerouteRework = false }) {
    const prior = readTransitions({ stateDir, identityHash: id });
    const last = prior[prior.length - 1];
    if (last && last.from === from && last.to === to) {
      return { ok: true, state: to, result: { resumed: true, record: last } };
    }
    // Issue #114 item 2: bounded explicit retry — ONLY when the caller opted in
    // (retryOnOwnFail === true, resume branch only) AND the immediately-
    // previous ledger record is this step's own fail side-transition is a
    // retry of the SAME step admitted; every other shape stays fail-closed.
    const ownFailTail = retryOnOwnFail === true && last
      && last.from === from && last.to === 'BLOCKED'
      && String(last.reason || '').startsWith(`${name}:FAIL`);
    // SEPARATE narrow opt-in (default false; used ONLY by the preReview
    // CDP_SEND_TIMEOUT recovery): admits this step's own THREW side-transition
    // for ONE re-entry - never a general throw retry for other steps/reasons.
    const ownThrowTail = retryOnOwnThrow === true && last
      && last.from === from && last.to === 'BLOCKED'
      && String(last.reason || '').startsWith(`${name}:THREW`);
    if (!ownFailTail && !ownThrowTail && (!last || last.to !== from)) {
      return fail('LOOP_NOT_AT_STATE', `expected last.to=${from}, got ${last && last.to}`);
    }
    let result;
    try {
      result = await run({ sessionPath });
    } catch (e) {
      transition({ from, to: 'BLOCKED', reason: `${name}:THREW`, evidence: String((e && e.message) || e) });
      return fail('STEP_THREW', `${name}: ${(e && e.message) || e}`);
    }
    if (!result || result.ok !== true) {
      // Request/response identity failures are blockers before FSM mutation.
      if (name.endsWith('finalReview') && /^REVIEW_(?:PROVENANCE|RESPONSE|REQUEST|SUBMIT)_/.test(result?.code || '')) return result;
      // PRE-GATE-REVIEW-01: a rerouteable internal-review verdict is NOT a
      // step failure. The BLOCKED side-transition is deliberately skipped and
      // the loop stays at `from` (VERIFYING) so the caller may enter the
      // rework leg from that exact state (VERIFYING->REWORK, appended by
      // runReworkLeg). No ledger record, no terminalize, no double verdict.
      if (rerouteRework === true && isInternalReviewReroute(result)) {
        return { ok: false, rerouted: 'REWORK', result };
      }
      transition({ from, to: 'BLOCKED', reason: `${name}:FAIL`, evidence: result || null });
      return fail(`${name}_FAILED`, result);
    }
    transition({ from, to, reason, evidence: capture === 'full' ? result : (result[capture] ?? null) });
    return { ok: true, state: to, result };
  }

  return Object.freeze({
    schemaVersion: CONTROL_LOOP_SCHEMA_VERSION,
    identityHash: id,
    sessionPath,
    stateDir,
    token,
    states: LOOP_STATES,
    transition,
    terminalize,
    step,
    readTransitions: () => readTransitions({ stateDir, identityHash: id }),
  });
}

// ---- P0-E rework leg (Issue #79) ---------------------------------------------
// REWORK binding gate (fail-closed): a rework decision may only be dispatched
// when it echoes the canonical identity of the bound session — repository and
// issue ALWAYS, headSha whenever the session pins one. A stale, foreign or
// malformed binding returns a deterministic failure and NEVER dispatches.
const HEAD_SHA_40 = /^[0-9a-f]{40}$/i;

export function assertReworkBinding({ session, decision }) {
  const b = decision && typeof decision.binding === 'object' && decision.binding !== null
    ? decision.binding
    : null;
  if (!b) return fail('REWORK_BINDING_MISSING', 'decision.binding (repository/issue/headSha echo) is required');
  const repo = typeof b.repository === 'string' ? b.repository.toLowerCase() : '';
  const issue = Number(b.issue);
  if (!repo || !Number.isInteger(issue) || issue <= 0
    || typeof b.headSha !== 'string' || !HEAD_SHA_40.test(b.headSha)) {
    return fail('REWORK_BINDING_MISSING', 'decision.binding must carry repository, issue and a 40-hex headSha');
  }
  if (repo !== String(session.repo).toLowerCase() || issue !== Number(session.issueNumber)) {
    return fail('REWORK_BINDING_MISMATCH', `decision=${b.repository}#${b.issue} session=${session.repo}#${session.issueNumber}`);
  }
  if (typeof session.headSha === 'string' && HEAD_SHA_40.test(session.headSha)
    && session.headSha.toLowerCase() !== b.headSha.toLowerCase()) {
    return fail('REWORK_BINDING_STALE', `decision head=${b.headSha.toLowerCase()} session head=${session.headSha.toLowerCase()}`);
  }
  return ok({ binding: { repository: repo, issue, headSha: b.headSha.toLowerCase() } });
}

// Persisted rework decisions are the crash-safe budget/replay ledger:
// <stateDir>/control-loop/<identityHash>/rework/<digest>.json (tmp + rename).
function listReworkDigests({ stateDir, identityHash: id }) {
  const dir = path.join(loopDirFor({ stateDir, identityHash: id }), 'rework');
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  } catch { return []; }
}

function persistReworkRecord({ stateDir, identityHash: id, record }) {
  const fp = path.join(loopDirFor({ stateDir, identityHash: id }), 'rework', `${record.digest}.json`);
  const tmp = `${fp}.tmp-${randomUUID()}`;
  try {
    ensureDir(path.dirname(fp));
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(tmp, fp);
    return { ok: true, path: fp };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    return { ok: false, detail: String((e && e.message) || e) };
  }
}

// Consumes a VALIDATED GPT ReviewResult with verdict REWORK: Soc_brain itself
// decides, persists a provenance-carrying rework record, re-dispatches THE
// SAME executor authority bound to this loop, read-backs the fresh execution
// record at its canonical location, and re-runs verification/pre-review/
// final-review before handing the follow-up decision back to the DECIDING
// policy. GPT stays advisory: it can never dispatch, mutate the FSM, merge or
// terminalize — only ControlLoop walks this leg.

// The loop's OWN ROUTED->EXECUTING record is the only authority for the route
// an executor dispatch may take. A resume re-enters decide() without running
// the ROUTED step, so `routeValue` is still null there and the dispatch would
// dereference it (an untyped TypeError that lands the FSM on
// REWORK->BLOCKED 'rework-execute:THREW', a tail no resume branch can recover
// from). Restore the authority from the ledger — never guess a route/model and
// never accept one from the caller — and fail closed with a typed code BEFORE
// any rework transition or dispatch when the record is missing, belongs to
// another identity/session, or carries no usable executor authority.
function restoreRouteEvidence({ ledger, identityHash: id, sessionPath }) {
  const rec = [...ledger].reverse().find((r) => r && r.from === 'ROUTED' && r.to === 'EXECUTING');
  if (!rec) return fail('RESUME_ROUTE_EVIDENCE_MISSING', 'no ROUTED->EXECUTING route evidence in the loop ledger');
  if (rec.identityHash !== id || rec.sessionPath !== sessionPath) {
    return fail('RESUME_ROUTE_EVIDENCE_INVALID', {
      reason: 'identity-or-session-mismatch',
      identityHash: rec.identityHash ?? null,
      sessionPath: rec.sessionPath ?? null,
    });
  }
  const e = rec.evidence;
  if (e == null) return fail('RESUME_ROUTE_EVIDENCE_MISSING', 'ROUTED->EXECUTING carries no route evidence');
  if (typeof e !== 'object' || Array.isArray(e)) {
    return fail('RESUME_ROUTE_EVIDENCE_INVALID', { reason: 'evidence-not-an-object', evidence: e });
  }
  if (typeof e.executorKind !== 'string' || !e.executorKind.trim() || typeof e.model !== 'string' || !e.model.trim()) {
    return fail('RESUME_ROUTE_EVIDENCE_INVALID', {
      reason: 'executor-authority-unusable',
      executorKind: typeof e.executorKind === 'string' ? e.executorKind : typeof e.executorKind,
      model: typeof e.model === 'string' ? e.model : typeof e.model,
    });
  }
  return ok(e);
}

// Durable submit side-effect artifacts of the review round store (the SAME
// path bin §D.2 openReviewRound builds: state/web2api-review-requests/<id>/).
// Writers: persistReviewRequest (.request.json), claimReviewSubmit
// (.submit.json), recordReviewAttempt (.attempts.jsonl), persistReviewResponse
// (.response.json). ABSENCE alone is never treated as proof during diagnosis
// (an in-flight raw pre-review round may persist nothing), but PRESENCE is
// conclusive: a round/submit exists -> reconcile, never resend automatically.
function readReviewSubmitArtifacts({ stateDir, identityHash: id }) {
  const dir = path.join(path.resolve(String(stateDir)), 'web2api-review-requests', String(id));
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => !String(f).endsWith('.tmp'));
  } catch {
    return { present: false, dir, files: [], count: 0 };
  }
  return { present: files.length > 0, dir, files: files.slice(0, 12), count: files.length };
}

// ---- Canonical pre-submit boundary reconcile record ------------------------
// Pre-review rounds persist NO request store, so an empty artifact store
// proves NOTHING about whether a legacy preReview:THREW ever submitted. A
// legacy checkpoint (bare evidence string, no structured stage/phase) may
// therefore retry ONLY after a RECONCILED PRE_SUBMIT boundary has been
// recorded through this canonical primitive: atomic tmp+rename under the
// identity's own control-loop directory (the same pattern commit-recovery
// uses for its attempt records). The record is CONTENT-ADDRESSED to the exact
// checkpoint (sha256 of ts|reason|evidence) and carries the identity twice
// (identity-scoped path + identityHash field), binding BOTH identity and
// checkpoint. No ledger line is rewritten and this code hardcodes no
// per-identity exception: any identity qualifies the same way.
const PRE_SUBMIT_BOUNDARY_KIND = 'PRE_SUBMIT_BOUNDARY_RECONCILED';

function preSubmitBoundaryKey({ ts, reason, evidence }) {
  return createHash('sha256').update(`${String(ts)}|${String(reason)}|${String(evidence)}`).digest('hex').slice(0, 16);
}

// ---- Authority model (stated honestly) ------------------------------------
// CORRECTION: SOC_CONTROL_LANE == session.mutationOwner.laneId only proves
// lane CONFIGURATION - any script can set an env var - so it is NEVER treated
// as caller authority. The authority for writing a reconciliation record is
// the EXISTING Session Admission seam (packages/session-authority guard): a
// live admission FENCE held by THIS process (incarnation-bound, pipe-verified,
// daemon-audited) - the same synchronous mutation boundary runtime-sandbox
// uses (assertAdmissionFence). The reader re-checks the recorded grant against
// the DAEMON-WRITTEN durable owner snapshot plus canonical identity/checkpoint
// and the evidence file's sha256. Honest limits: SAA grants live only in the
// admitting process (never persisted), so the reader validates the recorded
// grant's presence/binding/integrity rather than re-proving liveness; while
// the authority is DISARMED no record can be written at all - recovery then
// requires an Operator/control-plane-armed admission (Operator-authorized),
// never an env string. Evidence SHA256 proves log INTEGRITY only.
//
// REC-01 r4: the CANONICAL attempt linkage of a reconciliation checkpoint.
// The transport mints the attempt id per invocation and persists it through
// the typed failure evidence (ledger `preReview:FAIL` evidence.detail.attemptId);
// THIS function is the single place every leg (production entry BEFORE
// admission, writer BEFORE write, seal BEFORE receipt, reader BEFORE any retry
// authorization) resolves and verifies that linkage:
//   * checkpoint.attemptId required - a legacy checkpoint without it is a
//     typed block (CHECKPOINT_ATTEMPT_LINK_MISSING), never backfilled;
//   * the value must equal the CANONICAL failure evidence of the SAME
//     checkpoint (ts + reason + code) in the append-only ledger - a caller (or
//     the CLI) value is never its own expected value (CHECKPOINT_ATTEMPT_MISMATCH
//     / CHECKPOINT_UNLINKED);
//   * the marker is NEVER consulted here: it can only MATCH this canonical
//     value downstream (derivePreSubmitObservationFromEvidence), never define it.
// No ledger schema change: the linkage already lives in the failure evidence
// the transport produced; legacy evidence without it simply stays blocked.
export function resolveCheckpointAttemptLink({ stateDir, identityHash: id, checkpoint = null } = {}) {
  const ts = checkpoint && typeof checkpoint.ts === 'string' ? checkpoint.ts : null;
  const reason = checkpoint && typeof checkpoint.reason === 'string' ? checkpoint.reason : null;
  const code = checkpoint && typeof checkpoint.evidence === 'string' ? checkpoint.evidence : null;
  const cpAttemptId = checkpoint && typeof checkpoint.attemptId === 'string' && checkpoint.attemptId.trim()
    ? checkpoint.attemptId.trim() : null;
  const bound = { checkpoint: { ts, reason, code, attemptId: cpAttemptId } };
  if (!cpAttemptId) {
    return {
      ok: false,
      reason: 'CHECKPOINT_ATTEMPT_LINK_MISSING',
      detail: {
        ...bound,
        note: 'the checkpoint carries no transport-attempt linkage: only the canonical failure evidence of this checkpoint (ledger evidence.detail.attemptId) may provide it, so a legacy checkpoint is a typed block before admission/write/seal/retry - the linkage is never backfilled',
      },
    };
  }
  if (!id || !ts || !reason || !code) {
    return { ok: false, reason: 'CHECKPOINT_UNLINKED', detail: { ...bound, note: 'incomplete checkpoint: identity/ts/reason/code are required to locate the canonical failure evidence' } };
  }
  const tails = readTransitions({ stateDir, identityHash: id });
  let match = null;
  for (let i = tails.length - 1; i >= 0; i -= 1) {
    const t = tails[i];
    if (String((t && t.ts) ?? '') === ts && String((t && t.reason) ?? '') === reason) { match = t; break; }
  }
  const evCode = match
    ? (typeof match.evidence === 'string'
      ? match.evidence
      : (match.evidence && typeof match.evidence === 'object' ? String(match.evidence.code || '') : ''))
    : null;
  if (!match || evCode !== code) {
    return {
      ok: false,
      reason: 'CHECKPOINT_UNLINKED',
      detail: {
        ...bound,
        note: 'the checkpoint matches no canonical failure evidence of this identity (ts + reason + code): there is no canonical basis for an attempt linkage',
      },
    };
  }
  const canonical = match.evidence && typeof match.evidence === 'object'
    && match.evidence.detail && typeof match.evidence.detail === 'object'
    && typeof match.evidence.detail.attemptId === 'string' && match.evidence.detail.attemptId.trim()
    ? match.evidence.detail.attemptId.trim() : null;
  if (!canonical) {
    return {
      ok: false,
      reason: 'CHECKPOINT_ATTEMPT_LINK_MISSING',
      detail: {
        ...bound,
        note: 'the canonical failure evidence of this checkpoint carries no transport attempt id (legacy shape): typed block - never backfilled into the ledger or the record',
      },
    };
  }
  if (canonical !== cpAttemptId) {
    return {
      ok: false,
      reason: 'CHECKPOINT_ATTEMPT_MISMATCH',
      detail: {
        ...bound,
        canonicalAttemptId: canonical,
        checkpointAttemptId: cpAttemptId,
        note: 'the checkpoint attempt linkage disagrees with the canonical failure evidence of this checkpoint (a caller/CLI-supplied value is never its own expected value)',
      },
    };
  }
  return { ok: true, attemptId: canonical, source: 'FAILURE_EVIDENCE', detail: null, canonicalEvidence: match.evidence };
}

// REC-01 r5: the CANONICAL submit boundary of a reconciliation checkpoint.
// The ledger failure evidence (the transport's own typed detail for THIS
// attempt) - never the marker line, never a receipt - decides whether the
// submit pipeline had already started. Returns:
//   { veto: true,  detail: { reason:'CANONICAL_SUBMIT_STARTED', ... } }
//     when the canonical metadata ASSERTS the submit started:
//       stage SUBMIT_IN_FLIGHT / POST_SUBMIT_*, phase SUBMIT / POST_SUBMIT,
//       or submitEvidence.submitted that is not exactly false
//       ('UNKNOWN' and true both assert it; a future/unknown value fails
//       closed as started);
//   { veto: false } otherwise - including when the evidence simply LACKS the
//     submit-state metadata (legacy/thin detail). Lack of metadata is NOT a
//     veto assertion (it never proves NOT_SUBMITTED either - the attempt
//     linkage + record chain still decides), while a legacy checkpoint with
//     no linkage at all keeps failing closed at resolveCheckpointAttemptLink.
// Every caller runs this BEFORE write / seal / retry, so a marker claiming
// PRE_SUBMIT/NOT_SUBMITTED can never launder a canonical submit-in-flight or
// post-submit state into a reconciled PRE_SUBMIT boundary.
export function canonicalSubmitVeto({ canonicalEvidence = null } = {}) {
  const ev = canonicalEvidence;
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return { veto: false, known: false }; // legacy string/no evidence
  const d = ev.detail && typeof ev.detail === 'object' ? ev.detail : null;
  if (!d) return { veto: false, known: false }; // metadata absent - not an assertion
  const stage = typeof d.stage === 'string' && d.stage ? d.stage : null;
  const phase = typeof d.phase === 'string' && d.phase ? d.phase : null;
  const se = d.submitEvidence && typeof d.submitEvidence === 'object' ? d.submitEvidence : null;
  const submitted = se && se.submitted !== undefined ? se.submitted : undefined;
  const startedByStage = stage === 'SUBMIT_IN_FLIGHT' || stage === 'POLL'
    || (typeof stage === 'string' && stage.startsWith('POST_SUBMIT'));
  const startedByPhase = phase === 'SUBMIT'
    || (typeof phase === 'string' && phase.startsWith('POST_SUBMIT'));
  // explicit false is the ONLY submitted value that does not assert the
  // submit started; undefined = metadata absent (no assertion either way)
  const startedBySubmitted = submitted !== undefined && submitted !== false;
  if (startedByStage || startedByPhase || startedBySubmitted) {
    return {
      veto: true,
      known: true,
      detail: {
        reason: 'CANONICAL_SUBMIT_STARTED',
        stage,
        phase,
        submitted: submitted === undefined ? null : submitted,
        note: 'the CANONICAL failure evidence of this checkpoint asserts the submit pipeline had already started (SUBMIT_IN_FLIGHT / POST_SUBMIT / submitted not false): a marker line claiming PRE_SUBMIT/NOT_SUBMITTED or an authority receipt can never launder that state into a reconciled PRE_SUBMIT boundary - reconcile the original round, never resend',
      },
    };
  }
  return { veto: false, known: true };
}

// F3 WRITER-AUTHORITY LIMIT -> REC-01 OPERATION RECEIPT (fail-closed): identity,
// lane, generation and daemonEpoch are READ-ONLY, WORLD-READABLE fields of
// the durable owner snapshot, and a record's own authority block is written by
// whoever writes the record - markers alone never authorize. REC-01 closes
// the F3 seam with a real operation confirmation: sealPreSubmitBoundaryReconciled
// asks the Session Authority (RECEIPT op) to persist a durable, idempotent
// receipt row bound to the record's EXACT bytes, minted only while THIS
// process holds a live admission fence (token+daemonEpoch+connection verified
// daemon-side; the token is never persisted). The reader re-verifies that
// receipt as its LAST step (confirmBoundaryOperation): no receipt (or a
// receipt whose bytes/identity/checkpoint/generation do not match) ->
// RECORD_OPERATION_UNCONFIRMED and the recovery reports an
// Operator-authorized decision is required. No signature scheme, framework or
// marker is invented here (R4), and the fence is never relabeled as PRE_SUBMIT
// proof. Honest limit: the receipt store inherits the same OS file-permission
// trust as owners-*.json (daemon-written); the fence token itself never hits
// disk.
export function recordPreSubmitBoundaryReconciled({ stateDir, identityHash: id, checkpoint, source = null, basis = null, evidence = null, observation = null } = {}) {
  const ts = checkpoint && typeof checkpoint.ts === 'string' && checkpoint.ts ? checkpoint.ts : null;
  const reason = checkpoint && typeof checkpoint.reason === 'string' && checkpoint.reason ? checkpoint.reason : null;
  const evidenceStr = checkpoint && typeof checkpoint.evidence === 'string' && checkpoint.evidence ? checkpoint.evidence : null;
  if (!id || !ts || !reason || !evidenceStr) return { ok: false, reason: 'CHECKPOINT_INCOMPLETE' };
  if (typeof source !== 'string' || !source.trim() || typeof basis !== 'string' || !basis.trim()) {
    return { ok: false, reason: 'BASIS_REQUIRED', detail: 'the reconciliation source and basis must both be recorded' };
  }
  if (!evidence || typeof evidence !== 'object' || typeof evidence.path !== 'string' || !evidence.path.trim()) {
    return { ok: false, reason: 'EVIDENCE_REQUIRED', detail: 'the referenced evidence file path is required; its sha256 is computed here and re-verified on every read' };
  }
  // AUTHORITY = the existing Session Admission fence (packages/session-authority
  // guard) - the same synchronous mutation boundary runtime-sandbox uses on
  // every session/ledger write. An env lane is configuration, not authority.
  const canonicalSessionPath = path.join(path.resolve(String(stateDir)), 'sessions', `${id}.json`);
  const fence = assertAdmissionFence({ sessionPath: canonicalSessionPath, identityHash: id });
  // Order matters: a REAL fence failure (missing/revoked/stale/lost) returns
  // { ok:false, code } without an `armed` field and must surface its own code;
  // only the disarmed sentinel is { ok:true, armed:false }.
  if (!fence || fence.ok !== true) {
    return { ok: false, reason: String((fence && fence.code) || 'ADMISSION_FENCE_MISSING'), detail: (fence && fence.detail) ?? null };
  }
  if (fence.armed !== true) {
    return {
      ok: false,
      reason: 'ADMISSION_NOT_ARMED',
      detail: { note: 'the Session Admission Authority is disarmed (SOC_SESSION_ADMISSION!=required): a reconciliation record is an Operator/control-plane-authorized write and is refused while the admission-fence contract is not armed' },
    };
  }
  const ownerLane = readCanonicalOwnerLane(stateDir, id);
  if (!ownerLane || !fence.fence || fence.fence.laneId !== ownerLane) {
    return {
      ok: false,
      reason: 'MUTATION_LANE_MISMATCH',
      detail: { fenceLane: (fence.fence && fence.fence.laneId) ?? null, ownerLane, note: 'the admitted fence lane must match the canonical session mutationOwner.laneId (consistency check; the authority itself is the live fence)' },
    };
  }
  const pipePath = currentAuthorityPipePath();
  if (!pipePath) return { ok: false, reason: 'AUTHORITY_ENDPOINT_UNAVAILABLE', detail: 'fence held but the authority pipe endpoint is unknown' };
  const gf = fence.fence;
  let buf = null;
  try {
    buf = fs.readFileSync(evidence.path);
  } catch (e) {
    return { ok: false, reason: 'EVIDENCE_FILE_MISSING', detail: { path: evidence.path, code: (e && e.code) || null } };
  }
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const dir = path.join(path.resolve(String(stateDir)), 'control-loop', String(id), 'pre-submit-boundary');
  const key = preSubmitBoundaryKey({ ts, reason, evidence: evidenceStr });
  const base = path.join(dir, `${key}.json`);
  // REC-01 r3: the exact checkpoint binding every derive in this reconciliation
  // uses - ts/reason/evidence PLUS the transport-attempt linkage when the
  // checkpoint carries one (an old attempt's marker then never proves this
  // checkpoint; a legacy checkpoint without a linkage falls back to the full
  // identity + source + stage-map + time-window binding, never to the error
  // code alone).
  const cpAttemptId = checkpoint && typeof checkpoint.attemptId === 'string' && checkpoint.attemptId.trim() ? checkpoint.attemptId : null;
  const cpBind = { ts, reason, evidence: evidenceStr, ...(cpAttemptId ? { attemptId: cpAttemptId } : {}) };
  // REC-01 r4: resolve the CANONICAL attempt linkage ONCE (ledger failure
  // evidence, never the marker). It gates both the idempotent-winner scan and
  // the fresh write below; a refusal is typed and happens BEFORE any file is
  // written.
  const link = resolveCheckpointAttemptLink({ stateDir, identityHash: id, checkpoint: cpBind });
  // REWORK legacy idempotence + F2-src (round 2): scan EVERY candidate for
  // this checkpoint (the base AND its content-addressed siblings) for a
  // FULLY-PROVEN record BEFORE any new claim is evaluated. Fully-proven =
  // structure ok + boundary shape ok + the evidence's stage marker derives
  // exactly the observation the record stores (and agrees with any
  // caller-supplied claim). Only such a winner may answer created:false; a
  // structure-valid base WITHOUT a proven boundary (legacy) is never returned
  // as a new successful reconciliation, and a contradicting claim never
  // launders into an existing proven record.
  const candidates = [base];
  try {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.startsWith(`${key}.`) && name.endsWith('.json')) candidates.push(path.join(dir, name));
    }
  } catch { /* dir absent: only the base candidate */ }
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const cur = preSubmitRecordStructureCheck({ file: candidate, stateDir, identityHash: id, checkpoint: cpBind });
    if (!cur.ok) continue; // invalid base kept as evidence; fresh guarded write goes to a sibling below
    const vbExist = validatePreSubmitBoundaryBlock((cur.record && cur.record.boundary) || null);
    if (!vbExist.ok) continue; // boundary-less/invalid legacy shape never answers as a reconciliation
    const dExist = derivePreSubmitObservationFromEvidence({ evidenceBuf: cur.evidenceBuf, checkpoint: cpBind, identityHash: id });
    if (!dExist.ok) continue; // record without proven marker provenance is never an idempotent winner
    // REC-01 r3: the marker provenance (identity + attempt binding) is enforced
    // by the derive above; the stored block only has to agree on the boundary
    // shape (and on any binding the caller's own claim explicitly carries) so
    // a marker-perfect planted record still stops at the RECEIPT seam, exactly
    // as the closed F3 contract pins it.
    if (dExist.observation.phase !== vbExist.observation.phase
      || dExist.observation.submitState !== vbExist.observation.submitState) continue;
    if (observation !== null && observation !== undefined
      && (observation.phase !== dExist.observation.phase
        || observation.submitState !== dExist.observation.submitState
        || ((observation.identityHash ?? null) !== null && observation.identityHash !== dExist.observation.identityHash)
        || ((observation.attemptId ?? null) !== null && observation.attemptId !== dExist.observation.attemptId))) continue;
    // REC-01 r4: an unlinked/mismatched checkpoint NEVER answers as an
    // idempotent winner either (created:false is still accepting a
    // reconciliation).
    if (!link.ok) continue;
    return { ok: true, path: candidate, created: false };
  }
  // F2 (REC-01 rework): a record may only claim a PROVEN pre-submit boundary.
  // The observation comes from the transport stage tracker (phase + submitState
  // observed PRE_SUBMIT before submit); UNKNOWN, SUBMIT_IN_FLIGHT, POST_SUBMIT,
  // a wrong phase or a missing observation are typed refusals BEFORE any file
  // is written. The decision is always built here (never caller-supplied), so
  // the record binds {observation, decision} under the same fence as the write.
  if (observation === null || observation === undefined) {
    return {
      ok: false,
      reason: 'BOUNDARY_OBSERVATION_REQUIRED',
      detail: { note: 'a reconciliation record must bind the transport stage tracker observation proving the submit pipeline was observed in PRE_SUBMIT/NOT_SUBMITTED; without it the record cannot claim a boundary (a boundary-less legacy base is an honest typed refusal, never a successful reconciliation)' },
    };
  }
  const boundaryDecision = { action: PRE_SUBMIT_BOUNDARY_KIND, decidedAt: new Date().toISOString() };
  const vb = validatePreSubmitBoundaryBlock({ observation, decision: boundaryDecision });
  if (!vb.ok) {
    if (vb.reason === 'OBSERVATION_MISSING') return { ok: false, reason: 'BOUNDARY_OBSERVATION_REQUIRED', detail: vb.detail };
    if (vb.reason === 'OBSERVATION_INVALID') return { ok: false, reason: 'BOUNDARY_OBSERVATION_INVALID', detail: vb.detail };
    if (vb.reason === 'DECISION_INVALID') return { ok: false, reason: 'BOUNDARY_OBSERVATION_INVALID', detail: vb.detail };
    return { ok: false, reason: vb.reason, detail: vb.detail }; // BOUNDARY_NOT_PRE_SUBMIT
  }
  // Independent veto: submit artifacts on disk mean a round/submit already
  // exists - no record may claim an intact pre-submit boundary then.
  const artifacts = readReviewSubmitArtifacts({ stateDir, identityHash: id });
  if (artifacts && artifacts.present) {
    return { ok: false, reason: 'BOUNDARY_SUBMIT_ARTIFACTS_PRESENT', detail: artifacts };
  }
  // REWORK F2-src (round 2): the caller-supplied observation is a CLAIM, never
  // proof. What proves it is the transport stage tracker's marker line inside
  // the SAME evidence file the record binds by sha256: no marker, a marker for
  // another checkpoint (code mismatch), a contradicting phase/submitState or
  // an unbelievable observedAt are honest typed blocks BEFORE any write —
  // never a fabricated observation. On success the DERIVED observation is what
  // the record stores (the claim only had to agree with it).
  const derived = derivePreSubmitObservationFromEvidence({ evidenceBuf: buf, checkpoint: cpBind, identityHash: id });
  if (!derived.ok) {
    return {
      ok: false,
      reason: 'BOUNDARY_OBSERVATION_UNPROVEN',
      detail: {
        reason: derived.reason,
        ...(derived.detail || {}),
        note: 'the claimed boundary observation must be proven by the transport stage-observation marker line inside the evidence file bound to this checkpoint; an absent, foreign, unbound or contradictory marker is an honest typed block, never a fabricated observation',
      },
    };
  }
  if (derived.observation.phase !== observation.phase || derived.observation.submitState !== observation.submitState
    || ((observation.identityHash ?? null) !== null && observation.identityHash !== derived.observation.identityHash)
    || ((observation.attemptId ?? null) !== null && observation.attemptId !== derived.observation.attemptId)) {
    return {
      ok: false,
      reason: 'BOUNDARY_OBSERVATION_MISMATCH',
      detail: {
        expected: { phase: derived.observation.phase, submitState: derived.observation.submitState, source: derived.observation.source, observedAt: derived.observation.observedAt, identityHash: derived.observation.identityHash, attemptId: derived.observation.attemptId },
        actual: { phase: observation.phase, submitState: observation.submitState, source: observation.source ?? null, observedAt: observation.observedAt ?? null, identityHash: observation.identityHash ?? null, attemptId: observation.attemptId ?? null },
        note: 'the stage marker observed in the evidence contradicts the caller-supplied observation: only what the transport actually observed may be recorded',
      },
    };
  }
  // REC-01 r4: the canonical attempt linkage must be proven BEFORE any file
  // is written - a checkpoint without it (legacy) or one whose caller value
  // disagrees with the canonical failure evidence is a typed block, and no
  // record is ever created for it.
  if (!link.ok) {
    return { ok: false, reason: link.reason, detail: link.detail ?? null };
  }
  // REC-01 r5: the CANONICAL submit boundary vetoes the write. A canonical
  // failure that asserts the submit started (SUBMIT_IN_FLIGHT / UNKNOWN /
  // POST_SUBMIT / submitted=true) is never reconciled into a PRE_SUBMIT
  // boundary, no matter what the marker line claims - typed block, no file.
  const veto = canonicalSubmitVeto({ canonicalEvidence: link.canonicalEvidence });
  if (veto.veto) {
    return { ok: false, reason: 'BOUNDARY_CANONICAL_SUBMIT_VETO', detail: veto.detail };
  }
  // Never overwrite/laund an existing (possibly legacy, non-authorizing)
  // file: a fresh guarded write goes to a content-addressed SIBLING so the old
  // record stays on disk purely as evidence.
  const target = fs.existsSync(base)
    ? path.join(dir, `${key}.${randomUUID().replace(/-/g, '').slice(0, 8)}.json`)
    : base;
  const record = {
    schemaVersion: '1',
    kind: PRE_SUBMIT_BOUNDARY_KIND,
    identityHash: id,
    // REC-01 r4: the record persists the CANONICAL checkpoint linkage (attempt
    // id resolved from the ledger failure evidence above) so the seal/reader
    // can refuse a record of another attempt; legacy records simply carry no
    // such field and stay evidence-only (never backfilled).
    checkpoint: { ts, reason, evidence: evidenceStr, ...(cpAttemptId ? { attemptId: cpAttemptId } : {}) },
    source,
    basis,
    // Fence-derived grant markers. The fence TOKEN is NEVER persisted (SAA:
    // grants live in the admitting process only) - these fields let the reader
    // locate and cross-check the daemon's durable owner snapshot.
    authority: {
      kind: 'ADMISSION_FENCE',
      lane: gf.laneId,
      daemonEpoch: gf.daemonEpoch,
      generation: gf.generation,
      connectionId: gf.connectionId,
      pipePath,
      acquiredAt: gf.acquiredAt,
    },
    // F2/F2-src: the PROVEN pre-submit boundary — the DERIVED transport stage
    // marker observation + the decision built under this same fence. The seal
    // and the reader both re-derive it from the bound evidence; submit
    // artifacts independently veto it.
    boundary: { observation: derived.observation, decision: boundaryDecision },
    evidence: { path: evidence.path, sha256 },
    reconciledAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, target);
    return { ok: true, path: target, created: true };
  } catch (e) {
    return { ok: false, reason: 'RECORD_WRITE_FAILED', detail: String((e && e.message) || e) };
  }
}

// REC-01: the control-plane SEAL step. After recordPreSubmitBoundaryReconciled
// wrote the canonical base record through the live fence, this ASKS the
// Session Authority (RECEIPT op, same fence) to persist the operation
// confirmation: a durable, append-only, idempotent row bound to the record's
// EXACT bytes (sha256) and checkpoint key. Order of refusals, all typed and
// all BEFORE any confirmation can exist: disarmed authority
// (ADMISSION_NOT_ARMED) -> record missing/invalid (RECORD_*) -> no live fence
// (ADMISSION_FENCE_MISSING / ADMISSION_FENCE_REVOKED / ADMISSION_CONNECTION_LOST)
// -> daemon-side owner/payload verdicts (NOT_OWNER / EPOCH_STALE /
// RECEIPT_INVALID / AUTHORITY_STATE_UNAVAILABLE). The writer never writes the
// receipt itself - only the daemon does - and sealing never rewrites the
// record file. The fence TOKEN is never included in the store.
export async function sealPreSubmitBoundaryReconciled({ stateDir, identityHash: id, checkpoint, recordPath = null } = {}) {
  const ts = checkpoint && typeof checkpoint.ts === 'string' && checkpoint.ts ? checkpoint.ts : null;
  const reason = checkpoint && typeof checkpoint.reason === 'string' && checkpoint.reason ? checkpoint.reason : null;
  const evidenceStr = checkpoint && typeof checkpoint.evidence === 'string' && checkpoint.evidence ? checkpoint.evidence : null;
  if (!id || !ts || !reason || !evidenceStr) return { ok: false, code: 'CHECKPOINT_INCOMPLETE' };
  if (!isSessionAdmissionArmed()) {
    return { ok: false, code: 'ADMISSION_NOT_ARMED', detail: 'the Session Admission Authority is disarmed: a reconciliation record cannot be confirmed while the admission-fence contract is off' };
  }
  const dir = path.join(path.resolve(String(stateDir)), 'control-loop', String(id), 'pre-submit-boundary');
  const key = preSubmitBoundaryKey({ ts, reason, evidence: evidenceStr });
  const base = path.join(dir, `${key}.json`);
  // REC-01 r3: same checkpoint binding as the writer (attempt linkage when the
  // checkpoint carries one) - the seal re-derives provenance under it.
  const cpAttemptId = checkpoint && typeof checkpoint.attemptId === 'string' && checkpoint.attemptId.trim() ? checkpoint.attemptId : null;
  const cpBind = { ts, reason, evidence: evidenceStr, ...(cpAttemptId ? { attemptId: cpAttemptId } : {}) };
  // REWORK legacy idempotence (round 2): the writer may have sealed a SIBLING
  // (the base is a boundary-less legacy record that must stay byte-identical);
  // the caller seals the EXACT path the writer chose. Default stays the base,
  // preserving the round-1 contract when no sibling exists.
  const file = typeof recordPath === 'string' && recordPath.trim() ? recordPath : base;
  let buf = null;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return { ok: false, code: (e && e.code === 'ENOENT') ? 'RECORD_ABSENT' : 'RECORD_UNREADABLE', detail: { path: file, code: (e && e.code) || null } };
  }
  let record = null;
  try {
    record = JSON.parse(buf.toString('utf8'));
  } catch {
    return { ok: false, code: 'RECORD_INVALID', detail: { path: file } };
  }
  if (!record || typeof record !== 'object' || record.kind !== PRE_SUBMIT_BOUNDARY_KIND || record.schemaVersion !== '1') {
    return { ok: false, code: 'RECORD_INVALID', detail: { path: file } };
  }
  if (record.identityHash !== id) {
    return { ok: false, code: 'RECORD_IDENTITY_MISMATCH', detail: { path: file, recordIdentityHash: (record && record.identityHash) || null } };
  }
  const rc = record.checkpoint || {};
  if (rc.ts !== ts || rc.reason !== reason || rc.evidence !== evidenceStr
    || ((rc.attemptId ?? null) !== (cpAttemptId ?? null))) {
    return { ok: false, code: 'RECORD_CHECKPOINT_MISMATCH', detail: { path: file } };
  }
  // F2: the boundary observation/decision must be proven BEFORE any receipt
  // can exist. An UNKNOWN/IN_FLIGHT/POST_SUBMIT or missing boundary record is
  // a typed refusal at seal time - no receipt is minted for it.
  const vseal = validatePreSubmitBoundaryBlock((record && record.boundary) || null);
  if (!vseal.ok) {
    return { ok: false, code: 'BOUNDARY_NOT_PROVEN', detail: { reason: vseal.reason, path: file, ...(vseal.detail || {}) } };
  }
  // REWORK F2-src (round 2): PROVENANCE — a shape-valid record whose bound
  // evidence carries NO transport stage-observation marker (or a
  // contradicting one) gets NO receipt. The seal re-derives the observation
  // from the evidence the record itself references; only what the transport
  // observed may ever be sealed. Never fabricates an observation for a
  // legacy checkpoint.
  const derivedSeal = derivePreSubmitObservationFromEvidence({
    evidencePath: (record.evidence && typeof record.evidence.path === 'string' && record.evidence.path) || null,
    checkpoint: cpBind,
    identityHash: id,
  });
  if (!derivedSeal.ok) {
    return { ok: false, code: 'BOUNDARY_NOT_PROVEN', detail: { reason: derivedSeal.reason, path: file, ...(derivedSeal.detail || {}) } };
  }
  if (derivedSeal.observation.phase !== vseal.observation.phase
    || derivedSeal.observation.submitState !== vseal.observation.submitState) {
    return {
      ok: false,
      code: 'BOUNDARY_NOT_PROVEN',
      detail: {
        reason: 'OBSERVATION_MISMATCH',
        path: file,
        expected: { phase: derivedSeal.observation.phase, submitState: derivedSeal.observation.submitState },
        actual: { phase: vseal.observation.phase, submitState: vseal.observation.submitState },
        note: 'the stage marker observed in the bound evidence contradicts the stored boundary observation: the receipt is withheld',
      },
    };
  }
  // REC-01 r4: the CANONICAL attempt linkage gates the receipt - no authority
  // confirmation may be minted for a checkpoint whose attempt linkage is
  // missing (legacy) or disagrees with the ledger failure evidence.
  const linkSeal = resolveCheckpointAttemptLink({ stateDir, identityHash: id, checkpoint: cpBind });
  if (!linkSeal.ok) {
    return { ok: false, code: 'RECORD_ATTEMPT_LINK_UNPROVEN', detail: { reason: linkSeal.reason, path: file, ...(linkSeal.detail || {}) } };
  }
  // REC-01 r5: no receipt may ever be minted for a checkpoint whose CANONICAL
  // failure evidence asserts the submit already started (a receipt cannot
  // launder SUBMIT_IN_FLIGHT/UNKNOWN/POST_SUBMIT into NOT_SUBMITTED).
  const vetoSeal = canonicalSubmitVeto({ canonicalEvidence: linkSeal.canonicalEvidence });
  if (vetoSeal.veto) {
    return { ok: false, code: 'BOUNDARY_CANONICAL_SUBMIT_VETO', detail: { ...vetoSeal.detail, path: file } };
  }
  const recordSha256 = createHash('sha256').update(buf).digest('hex');
  const seal = await sealBoundaryReceipt({ identityHash: id, kind: PRE_SUBMIT_BOUNDARY_KIND, recordSha256, checkpointKey: key });
  if (!seal.ok) return { ok: false, code: String(seal.code || 'ADMISSION_FENCE_MISSING'), detail: seal.detail ?? null };
  return {
    ok: true,
    path: file,
    recordSha256,
    checkpointKey: key,
    sealed: Boolean(seal.value && seal.value.sealed),
    seq: seal.value && Number.isInteger(seal.value.seq) ? seal.value.seq : null,
    receipt: (seal.value && seal.value.receipt) || null,
  };
}

// F2 (REC-01 rework): validate the {observation, decision} block every
// reconciled record must carry. Shared by the SEAL and the READER (the writer
// uses it for its own typed refusal codes). Typed reasons:
//   OBSERVATION_MISSING     - no block / no observation at all
//   OBSERVATION_INVALID     - present but incomplete (phase/state/time/source)
//   DECISION_INVALID        - decision not bound to this action
//   BOUNDARY_NOT_PRE_SUBMIT - phase/state proves anything but PRE_SUBMIT +
//                             NOT_SUBMITTED (UNKNOWN, SUBMIT_IN_FLIGHT,
//                             POST_SUBMIT, wrong phase)
function validatePreSubmitBoundaryBlock(block) {
  if (!block || typeof block !== 'object') {
    return { ok: false, reason: 'OBSERVATION_MISSING', detail: { note: 'the record carries no pre-submit boundary observation/decision' } };
  }
  const obs = block.observation;
  if (!obs || typeof obs !== 'object') {
    return { ok: false, reason: 'OBSERVATION_MISSING', detail: { note: 'the record carries no boundary observation' } };
  }
  const phase = typeof obs.phase === 'string' ? obs.phase : null;
  const submitState = typeof obs.submitState === 'string' ? obs.submitState : null;
  const observedAt = typeof obs.observedAt === 'string' ? obs.observedAt : null;
  const obsSource = typeof obs.source === 'string' && obs.source.trim() ? obs.source : null;
  if (!phase || !submitState || !observedAt || !obsSource) {
    return {
      ok: false,
      reason: 'OBSERVATION_INVALID',
      detail: { phase, submitState, observedAt: obs.observedAt ?? null, source: obsSource, note: 'the boundary observation must record phase, submitState, observedAt and a non-empty source (the transport stage tracker that observed it)' },
    };
  }
  const dec = block.decision;
  if (!dec || typeof dec !== 'object' || dec.action !== PRE_SUBMIT_BOUNDARY_KIND || typeof dec.decidedAt !== 'string' || !dec.decidedAt) {
    return { ok: false, reason: 'DECISION_INVALID', detail: { action: (dec && dec.action) || null, note: 'the reconciled decision must bind action PRE_SUBMIT_BOUNDARY_RECONCILED and a decidedAt timestamp' } };
  }
  if (phase !== 'PRE_SUBMIT' || submitState !== 'NOT_SUBMITTED') {
    return {
      ok: false,
      reason: 'BOUNDARY_NOT_PRE_SUBMIT',
      detail: { phase, submitState, note: 'only a proven PRE_SUBMIT/NOT_SUBMITTED boundary (transport stage tracker observed before submit) is reconcilable; UNKNOWN, SUBMIT_IN_FLIGHT, POST_SUBMITTED or a wrong phase are typed refusals' },
    };
  }
  return { ok: true, observation: obs, decision: dec };
}

// Structural half of the reader's per-file checks WITHOUT any authority IPC:
// shape, identity, checkpoint, basis, fence-marker shape, owner-snapshot
// cross-check, evidence reference + hash. Shared by the reader loop and the
// writer's idempotent exists-check (the writer never mints a sibling for a
// structurally valid base). Returns { ok:true, record, authority,
// evidenceVerified, recordSha256, snapshotGeneration } or
// { ok:false, reason, detail? }.
function preSubmitRecordStructureCheck({ file, stateDir, identityHash: id, checkpoint }) {
  const ts = checkpoint && typeof checkpoint.ts === 'string' ? checkpoint.ts : null;
  const reason = checkpoint && typeof checkpoint.reason === 'string' ? checkpoint.reason : null;
  const evidenceStr = checkpoint && typeof checkpoint.evidence === 'string' ? checkpoint.evidence : null;
  // REC-01 r4: the checkpoint's canonical attempt linkage is part of the
  // checkpoint identity - a record written for another attempt (or a legacy
  // record without the field) never structure-matches a linked checkpoint.
  const cpAttemptId = checkpoint && typeof checkpoint.attemptId === 'string' && checkpoint.attemptId.trim() ? checkpoint.attemptId.trim() : null;
  let record = null;
  let rawBuf = null;
  try {
    // Keep the RAW bytes: the RECEIPT binds the record's exact content, so
    // the caller hashes what it parsed (drift after seal -> no receipt).
    rawBuf = fs.readFileSync(file);
    record = JSON.parse(rawBuf.toString('utf8'));
  } catch {
    return { ok: false, reason: 'RECORD_INVALID' };
  }
  if (!record || typeof record !== 'object' || record.kind !== PRE_SUBMIT_BOUNDARY_KIND || record.schemaVersion !== '1') {
    return { ok: false, reason: 'RECORD_INVALID' };
  }
  if (record.identityHash !== id) {
    return { ok: false, reason: 'RECORD_IDENTITY_MISMATCH' };
  }
  const c = record.checkpoint || {};
  if (c.ts !== ts || c.reason !== reason || c.evidence !== evidenceStr
    || ((c.attemptId ?? null) !== cpAttemptId)) {
    return { ok: false, reason: 'RECORD_CHECKPOINT_MISMATCH' };
  }
  if (typeof record.source !== 'string' || !record.source.trim() || typeof record.basis !== 'string' || !record.basis.trim()) {
    return { ok: false, reason: 'RECORD_BASIS_MISSING' };
  }
  // Authority: the record must carry a Session-Admission FENCE grant whose
  // lane matches the canonical mutationOwner, AND that grant must exist in
  // the DAEMON-WRITTEN durable owner snapshot for the recorded pipe with the
  // same generation/lane. Self-claimed source/basis, an env lane, or a
  // fabricated marker (no matching daemon-side entry) never authorizes.
  const ownerLane = readCanonicalOwnerLane(stateDir, id);
  const auth = record.authority;
  if (!auth || auth.kind !== 'ADMISSION_FENCE' || typeof auth.lane !== 'string' || !auth.lane.trim()
    || typeof auth.daemonEpoch !== 'string' || !auth.daemonEpoch
    || !Number.isInteger(auth.generation)
    || !ownerLane || auth.lane !== ownerLane) {
    return {
      ok: false,
      reason: 'RECORD_AUTHORITY_UNPROVEN',
      detail: { kind: (auth && auth.kind) || null, lane: (auth && auth.lane) || null, ownerLane, note: 'a lane/env-claimed record (or a missing admission-fence grant) cannot authorize a retry' },
    };
  }
  const snap = readAuthorityOwnerSnapshot(auth);
  if (!snap.ok) {
    return { ok: false, reason: 'RECORD_AUTHORITY_UNPROVEN', detail: { reason: snap.reason, pipePath: auth.pipePath || null } };
  }
  const entry = snap.entries.find((e) => e && e.identityHash === id) || null;
  // Snapshot vs record generation: equality is NEVER forced. The receipt of
  // an earlier grant (release -> fresh re-acquire, or a takeover bump) is
  // HISTORICAL history and stays valid as long as the daemon snapshot is at
  // least as new; a record claiming a generation NEWER than the daemon-
  // written snapshot is impossible (no receipt could exist for it) and is
  // refused as OWNER_SNAPSHOT_MISMATCH.
  if (!entry || !Number.isInteger(auth.generation) || auth.generation < 1
    || auth.generation > Number(entry.generation) || entry.laneId !== auth.lane) {
    return {
      ok: false,
      reason: 'RECORD_AUTHORITY_UNPROVEN',
      detail: { reason: 'OWNER_SNAPSHOT_MISMATCH', recordGeneration: auth.generation, snapshotGeneration: entry ? entry.generation : null, snapshotLane: entry ? entry.laneId : null },
    };
  }
  // Evidence: referenced file must exist and hash to the recorded sha256
  // (integrity only - authority already established above).
  const ev = record.evidence;
  if (!ev || typeof ev.path !== 'string' || !ev.path || typeof ev.sha256 !== 'string' || !ev.sha256) {
    return { ok: false, reason: 'RECORD_BASIS_UNVERIFIED', detail: { reason: 'EVIDENCE_REF_MISSING' } };
  }
  let buf = null;
  try {
    buf = fs.readFileSync(ev.path);
  } catch {
    return { ok: false, reason: 'RECORD_BASIS_UNVERIFIED', detail: { reason: 'EVIDENCE_FILE_MISSING', evidencePath: ev.path } };
  }
  const actual = createHash('sha256').update(buf).digest('hex');
  if (actual !== String(ev.sha256).toLowerCase()) {
    return { ok: false, reason: 'RECORD_BASIS_UNVERIFIED', detail: { reason: 'EVIDENCE_HASH_MISMATCH', expected: String(ev.sha256).toLowerCase(), actual } };
  }
  return {
    ok: true,
    record,
    recordSha256: createHash('sha256').update(rawBuf).digest('hex'),
    authority: auth,
    evidenceVerified: { path: ev.path, sha256: actual },
    // REWORK F2-src (round 2): hand the ALREADY-READ evidence bytes back so
    // the writer's idempotent exists-scan and the reader's provenance step can
    // re-derive the stage observation without a second disk read (the exact
    // bytes whose sha256 was just verified).
    evidenceBuf: buf,
    snapshotGeneration: Number(entry.generation),
  };
}

// F1/F2 (REC-01 rework): the reader is ASYNC now. Order of refusals, all
// typed and fail-closed BEFORE any retry can be authorized:
//   RECORD_ABSENT / structure (shape, identity, checkpoint, basis, authority,
//   owner snapshot, evidence hash)
//   -> RECORD_BOUNDARY_UNPROVEN (F2: the {observation, decision} must prove
//      PRE_SUBMIT/NOT_SUBMITTED; submit artifacts independently veto)
//   -> RECORD_OPERATION_UNCONFIRMED (F1: the LIVE authority must attest the
//      issuance - the durable store file alone proves persistence, never
//      issuance; it is cross-checked against what the attestation names).
export async function readPreSubmitBoundaryReconcile({ stateDir, identityHash: id, checkpoint } = {}) {
  const ts = checkpoint && typeof checkpoint.ts === 'string' && checkpoint.ts ? checkpoint.ts : null;
  const reason = checkpoint && typeof checkpoint.reason === 'string' && checkpoint.reason ? checkpoint.reason : null;
  const evidenceStr = checkpoint && typeof checkpoint.evidence === 'string' && checkpoint.evidence ? checkpoint.evidence : null;
  if (!id || !ts || !reason || !evidenceStr) return { ok: false, reason: 'CHECKPOINT_INCOMPLETE' };
  // REC-01 r3: the same checkpoint binding as writer/seal (attempt linkage when
  // the checkpoint carries one) - every provenance re-derivation below runs
  // under it, so a marker of another attempt/identity is refused typed.
  const cpAttemptId = checkpoint && typeof checkpoint.attemptId === 'string' && checkpoint.attemptId.trim() ? checkpoint.attemptId : null;
  const cpBind = { ts, reason, evidence: evidenceStr, ...(cpAttemptId ? { attemptId: cpAttemptId } : {}) };
  const dir = path.join(path.resolve(String(stateDir)), 'control-loop', String(id), 'pre-submit-boundary');
  const key = preSubmitBoundaryKey({ ts, reason, evidence: evidenceStr });
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.startsWith(`${key}.`) && f.endsWith('.json'));
  } catch {
    return { ok: false, reason: 'RECORD_ABSENT', path: path.join(dir, `${key}.json`) };
  }
  if (!names.length) return { ok: false, reason: 'RECORD_ABSENT', path: path.join(dir, `${key}.json`) };
  const inspected = [];
  let last = null;
  for (const name of names.sort()) {
    const file = path.join(dir, name);
    const c = preSubmitRecordStructureCheck({ file, stateDir, identityHash: id, checkpoint: cpBind });
    if (!c.ok) {
      const fail = { ok: false, reason: c.reason, path: file };
      if (c.detail !== undefined) fail.detail = c.detail;
      last = fail;
      inspected.push({ file, reason: c.reason });
      continue;
    }
    // F2: markers + evidence pass, but the boundary observation/decision must
    // itself prove PRE_SUBMIT/NOT_SUBMITTED (and no submit artifact may exist)
    // BEFORE any receipt confirmation is even attempted.
    const vb = validatePreSubmitBoundaryBlock((c.record && c.record.boundary) || null);
    if (!vb.ok) {
      last = { ok: false, reason: 'RECORD_BOUNDARY_UNPROVEN', path: file, detail: { reason: vb.reason, ...(vb.detail || {}) } };
      inspected.push({ file, reason: 'RECORD_BOUNDARY_UNPROVEN' });
      continue;
    }
    // REWORK F2-src (round 2): PROVENANCE — the stored observation must be
    // re-derivable from the transport stage marker inside the SAME evidence
    // bytes whose sha256 the structure check just verified. A legacy/planted
    // record whose evidence carries no marker (or a contradicting one) is an
    // honest RECORD_BOUNDARY_UNPROVEN — the reader NEVER fabricates an
    // observation for it, so the gate withholds the retry typed.
    const dRead = derivePreSubmitObservationFromEvidence({ evidenceBuf: c.evidenceBuf, checkpoint: cpBind, identityHash: id });
    if (!dRead.ok) {
      last = { ok: false, reason: 'RECORD_BOUNDARY_UNPROVEN', path: file, detail: { reason: dRead.reason, ...(dRead.detail || {}) } };
      inspected.push({ file, reason: 'RECORD_BOUNDARY_UNPROVEN' });
      continue;
    }
    // REC-01 r3: marker provenance (identity + attempt binding) is enforced by
    // the derive above; here the stored block only has to agree on the
    // boundary shape - the OPERATION confirmation below stays the authority.
    if (dRead.observation.phase !== vb.observation.phase || dRead.observation.submitState !== vb.observation.submitState) {
      last = {
        ok: false,
        reason: 'RECORD_BOUNDARY_UNPROVEN',
        path: file,
        detail: {
          reason: 'OBSERVATION_MISMATCH',
          expected: { phase: dRead.observation.phase, submitState: dRead.observation.submitState },
          actual: { phase: vb.observation.phase, submitState: vb.observation.submitState },
          note: 'the stage marker observed in the bound evidence contradicts the stored boundary observation',
        },
      };
      inspected.push({ file, reason: 'RECORD_BOUNDARY_UNPROVEN' });
      continue;
    }
    // REC-01 r4: the CANONICAL attempt linkage is verified before any
    // artifact check or receipt confirmation - a legacy checkpoint (no
    // linkage) or one whose value disagrees with the ledger failure evidence
    // never authorizes a retry, and the reason is surfaced typed.
    const linkRead = resolveCheckpointAttemptLink({ stateDir, identityHash: id, checkpoint: cpBind });
    if (!linkRead.ok) {
      last = { ok: false, reason: 'RECORD_ATTEMPT_LINK_UNPROVEN', path: file, detail: { reason: linkRead.reason, ...(linkRead.detail || {}) } };
      inspected.push({ file, reason: 'RECORD_ATTEMPT_LINK_UNPROVEN' });
      continue;
    }
    // REC-01 r5: the reader refuses a checkpoint whose CANONICAL failure
    // evidence asserts the submit started - the record's stored observation
    // and its receipt can never launder that state into a retry authorization.
    const vetoRead = canonicalSubmitVeto({ canonicalEvidence: linkRead.canonicalEvidence });
    if (vetoRead.veto) {
      last = { ok: false, reason: 'RECORD_CANONICAL_SUBMIT_VETO', path: file, detail: vetoRead.detail };
      inspected.push({ file, reason: 'RECORD_CANONICAL_SUBMIT_VETO' });
      continue;
    }
    const arts = readReviewSubmitArtifacts({ stateDir, identityHash: id });
    if (arts && arts.present) {
      last = { ok: false, reason: 'RECORD_BOUNDARY_UNPROVEN', path: file, detail: { reason: 'ARTIFACTS_PRESENT', ...arts } };
      inspected.push({ file, reason: 'RECORD_BOUNDARY_UNPROVEN' });
      continue;
    }
    // F1: markers above are NOT authority - they only prove the record AGREES
    // with the world-readable owner snapshot, so a self-created record can
    // copy lane/generation/daemonEpoch and pass every check above. What
    // decides is the LIVE authority attesting it issued a receipt for these
    // exact bytes (in-memory issuance ledger, minted only under a live fence);
    // without it (or with an attestation that does not match the store row)
    // authorization is withheld and the recovery reports an Operator-
    // authorized decision is required.
    const op = await confirmBoundaryOperation({
      record: c.record,
      recordSha256: c.recordSha256,
      snapshotGeneration: c.snapshotGeneration,
    });
    if (!op.ok) {
      last = { ok: false, reason: 'RECORD_OPERATION_UNCONFIRMED', path: file, detail: op };
      inspected.push({ file, reason: 'RECORD_OPERATION_UNCONFIRMED' });
      continue;
    }
    return { ok: true, record: c.record, path: file, authority: c.authority, evidenceVerified: c.evidenceVerified, receipt: op.receipt, inspected };
  }
  return { ...(last || { ok: false, reason: 'RECORD_INVALID' }), inspected };
}

// Operation/receipt confirmation seam (F3's single bind point; REC-01 fills it).
// A receipt is minted ONLY by the Session Authority RECEIPT op while a live
// admission fence holds the grant (token+daemonEpoch+connection verified
// daemon-side on the owning pipe) and is bound to the record's exact bytes.
// This function performs NO writes and NO grants: it re-reads the daemon's
// durable receipt store for the record's pipe and verifies the row against
// THIS record (bytes / identity / checkpoint / pipe / generation). Every
// failure is a typed reason under RECORD_OPERATION_UNCONFIRMED so the gate
// stays fail-closed before any transition or retry. The authority must be
// ARMED at read time as well: with the admission contract off there is no
// armed contract to confirm against (and none could have minted a receipt).
// No signature scheme or marker format is invented here (R4).
async function confirmBoundaryOperation({ record, recordSha256, snapshotGeneration = null } = {}) {
  const note = 'a receipt is minted only by the Session Authority RECEIPT op while a live admission fence holds the grant (token+daemonEpoch+connection verified daemon-side) and is bound to the record\'s exact bytes; copyable markers alone never confirm an operation';
  const ops = AUTHORITY_OPS.join('/');
  if (!isSessionAdmissionArmed()) {
    return {
      ok: false,
      reason: 'AUTHORITY_DISARMED',
      detail: {
        ops,
        note: 'the Session Admission Authority is disarmed: no operation confirmation can be validated here (and none could have been minted); arm admission via Operator/control-plane first',
        required: 'OPERATOR_AUTHORIZED_RECOVERY_DECISION',
      },
    };
  }
  const auth = (record && record.authority) || {};
  const pipe = (typeof auth.pipePath === 'string' && auth.pipePath) ? auth.pipePath : defaultAuthorityPipePath();
  const storeFile = path.join(path.dirname(authorityBindLockPath()), `receipts-${createHash('sha256').update(pipe).digest('hex')}.json`);
  let store = null;
  try {
    store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  } catch (e) {
    return {
      ok: false,
      reason: (e && e.code === 'ENOENT') ? 'RECEIPT_STORE_MISSING' : 'RECEIPT_STORE_UNREADABLE',
      detail: { ops, pipePath: pipe, storePath: storeFile, note },
    };
  }
  if (!store || store.schemaVersion !== 1 || store.pipePath !== pipe || !Array.isArray(store.entries)) {
    return { ok: false, reason: 'RECEIPT_STORE_INVALID', detail: { ops, pipePath: pipe, storePath: storeFile, note } };
  }
  const hit = store.entries.find((x) => x && x.kind === PRE_SUBMIT_BOUNDARY_KIND && x.recordSha256 === recordSha256) || null;
  if (!hit) {
    return {
      ok: false,
      reason: 'RECEIPT_ABSENT',
      detail: { ops, recordSha256, pipePath: pipe, note, required: 'OPERATOR_AUTHORIZED_RECOVERY_DECISION' },
    };
  }
  if (hit.identityHash !== (record && record.identityHash)) {
    return { ok: false, reason: 'RECEIPT_IDENTITY_MISMATCH', detail: { ops, expected: (record && record.identityHash) || null, got: hit.identityHash ?? null, note } };
  }
  const c = (record && record.checkpoint) || {};
  const expectedKey = preSubmitBoundaryKey({ ts: c.ts, reason: c.reason, evidence: c.evidence });
  if (hit.checkpointKey !== expectedKey) {
    return { ok: false, reason: 'RECEIPT_CHECKPOINT_MISMATCH', detail: { ops, expected: expectedKey, got: hit.checkpointKey ?? null, note } };
  }
  if (hit.pipePath !== pipe) {
    return { ok: false, reason: 'RECEIPT_PIPE_MISMATCH', detail: { ops, expected: pipe, got: hit.pipePath ?? null, note } };
  }
  const g = hit.generation;
  if (!Number.isInteger(g) || g < 1) {
    return { ok: false, reason: 'RECEIPT_GENERATION_INVALID', detail: { ops, receiptGeneration: Number.isInteger(g) ? g : null, note } };
  }
  if (Number.isInteger(snapshotGeneration) && g > snapshotGeneration) {
    return {
      ok: false,
      reason: 'RECEIPT_GENERATION_INVALID',
      detail: {
        ops,
        receiptGeneration: g,
        snapshotGeneration,
        note: 'a receipt may be HISTORICAL (minted under an earlier grant generation than the runner\'s current one) but never NEWER than the daemon-written owner snapshot',
      },
    };
  }
  // F1 (REC-01 rework): the store row above only proves PERSISTENCE on plain
  // user-writable disk. What confirms the OPERATION is the LIVE authority
  // attesting it issued a receipt for these exact bytes (its in-memory
  // issuance ledger, minted only under a live fence this connection owns).
  // A planted file row, or a row from before a daemon restart, is refused:
  // reading the file back is never issuance evidence.
  const attest = await verifyBoundaryReceipt({
    identityHash: (record && record.identityHash) || null,
    kind: PRE_SUBMIT_BOUNDARY_KIND,
    recordSha256,
  });
  if (!attest.ok) {
    if (attest.code === AUTHORITY_CODES.RECEIPT_NOT_ISSUED) {
      return {
        ok: false,
        reason: 'RECEIPT_NOT_ISSUED',
        detail: { ops, recordSha256, pipePath: pipe, note, required: 'OPERATOR_AUTHORIZED_RECOVERY_DECISION' },
      };
    }
    return {
      ok: false,
      reason: 'RECEIPT_UNVERIFIED',
      detail: { ops, code: attest.code ?? null, recordSha256, pipePath: pipe, note: 'the live authority could not attest an issuance for these record bytes (disarmed/missing fence, lost connection or unavailable authority); fail closed', required: 'OPERATOR_AUTHORIZED_RECOVERY_DECISION' },
    };
  }
  const issued = (attest.value && attest.value.receipt) || null;
  if (!issued
    || issued.recordSha256 !== recordSha256
    || issued.identityHash !== hit.identityHash
    || issued.checkpointKey !== hit.checkpointKey
    || issued.pipePath !== hit.pipePath
    || issued.generation !== hit.generation) {
    return {
      ok: false,
      reason: 'RECEIPT_ISSUANCE_MISMATCH',
      detail: {
        ops,
        recordSha256,
        pipePath: pipe,
        note: 'the authority-attested issuance must match the durable store row field for field; any divergence fails closed',
        storeRow: { identityHash: hit.identityHash, checkpointKey: hit.checkpointKey, pipePath: hit.pipePath, generation: hit.generation },
        attested: issued ? { identityHash: issued.identityHash, checkpointKey: issued.checkpointKey, pipePath: issued.pipePath, generation: issued.generation } : null,
      },
    };
  }
  return { ok: true, receipt: issued, store: storeFile };
}

// Locate the DAEMON-WRITTEN durable owner snapshot for the pipe a grant came
// from: <authorityRuntimeDir>/owners-sha256(<pipePath>).json (the same path
// authority-server.persistOwners uses with its default bind lock). Snapshot
// entries are written by the daemon at ACQUIRE time - never by callers.
function readAuthorityOwnerSnapshot(auth) {
  try {
    const pipe = (typeof auth.pipePath === 'string' && auth.pipePath) ? auth.pipePath : defaultAuthorityPipePath();
    const bind = authorityBindLockPath();
    const file = path.join(path.dirname(bind), `owners-${createHash('sha256').update(pipe).digest('hex')}.json`);
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!snap || snap.schemaVersion !== 1 || !Array.isArray(snap.entries)) return { ok: false, reason: 'OWNER_SNAPSHOT_INVALID' };
    return { ok: true, entries: snap.entries, file };
  } catch (e) {
    return { ok: false, reason: (e && e.code === 'ENOENT') ? 'OWNER_SNAPSHOT_MISSING' : 'OWNER_SNAPSHOT_UNREADABLE' };
  }
}

function readCanonicalOwnerLane(stateDir, id) {
  const rs = readSessionRecord(path.join(path.resolve(String(stateDir)), 'sessions', `${id}.json`));
  if (!rs.ok) return null;
  const mo = rs.session && rs.session.mutationOwner;
  return mo && typeof mo.laneId === 'string' && mo.laneId ? mo.laneId : null;
}

async function runReworkLeg({
  loop, deps, stateDir, identityHash: id, session, routeValue, decision,
  executor, verifier, preReview, finalReview,
  // PRE-GATE-REVIEW-01: which FSM state the leg dispatches FROM. DECIDING is
  // the GPT final-review REWORK verdict; VERIFYING is the internal pre-gate
  // review finding (the caller skipped DECIDING on purpose — the review was
  // never obtained through a semantic review step). Everything else (digest,
  // budget, duplicate-dispatch, readback) is identical for both sources.
  sourceFrom = 'DECIDING',
}) {
  const bind = assertReworkBinding({ session, decision });
  if (!bind.ok) return bind; // stale/wrong/missing binding: fail-closed, no dispatch, recoverable
  const digest = reworkDigest({ identityHash: id, decision });
  const ledger = readTransitions({ stateDir, identityHash: id });
  // Executor-authority gate, sibling of the binding gate above: a resume has
  // no in-memory route, so it is restored from THIS identity/session's own
  // ROUTED->EXECUTING record. Missing/wrong evidence typed-blocks here —
  // before the rework record, before sourceFrom->REWORK, before any dispatch.
  if (routeValue == null) {
    const restored = restoreRouteEvidence({ ledger, identityHash: id, sessionPath: loop.sessionPath });
    if (!restored.ok) return restored;
    routeValue = restored.value;
  }
  // Dispatch marker = the <sourceFrom>->REWORK record for THIS digest
  // immediately followed by its REWORK->EXECUTING dispatch record. The digest
  // alone identifies the decision (any source), so a replayed/duplicated
  // decision whose dispatch already ran never dispatches again; a crash
  // BETWEEN the persist and the executor step (transition recorded, no
  // dispatch record) stays retryable — exactly-once dispatch.
  const alreadyDispatched = ledger.some((r, i) => (
    r.to === 'REWORK'
    && r.evidence && r.evidence.digest === digest
    && ledger[i + 1] && ledger[i + 1].from === 'REWORK' && ledger[i + 1].to === 'EXECUTING'
  ));
  if (alreadyDispatched) {
    return fail('REWORK_ALREADY_DISPATCHED', { digest });
  }
  const round = listReworkDigests({ stateDir, identityHash: id }).length + 1;
  if (round > MAX_REWORK_ROUNDS) {
    // Budget exhaustion = the reviewer keeps rejecting fresh work. That is a
    // genuine escalation, not a technical failure: canonical BLOCKED.
    loop.transition({
      from: sourceFrom, to: 'BLOCKED', reason: 'rework-budget-exhausted',
      evidence: { digest, rounds: round - 1, max: MAX_REWORK_ROUNDS },
    });
    const term = loop.terminalize({ outcome: 'BLOCKED', decision });
    // Include the decision so the S5 dispatcher can extract rework-round
    // evidence (findings, evidenceRequests) from the BLOCKED escalation.
    return ok({ state: 'BLOCKED', reason: 'REWORK_BUDGET_EXHAUSTED', terminalize: term, decision, loopToken: loop.token });
  }
  const record = buildReworkRecord({ identityHash: id, round, digest, decision });
  const pr = persistReworkRecord({ stateDir, identityHash: id, record });
  if (!pr.ok) return fail('REWORK_PERSIST_FAILED', pr.detail);
  const tw = loop.transition({
    from: sourceFrom, to: 'REWORK',
    reason: sourceFrom === 'VERIFYING' ? 'internal-review-findings-rework' : 'final-review-rework',
    evidence: {
      digest, round, reworkPath: pr.path, binding: record.binding,
      findings: record.findings, evidenceRequests: record.evidenceRequests,
    },
  });
  if (!tw.ok) return fail('TRANSITION_FAILED', tw.code);
  const instruction = buildReworkInstruction({ session, record });
  const execR = await loop.step({
    name: 'rework-execute', from: 'REWORK', to: 'EXECUTING',
    run: (ctx) => executor({
      ...ctx,
      model: routeValue.model,
      executorKind: routeValue.executorKind,
      reworkInstruction: instruction,
      reworkCwd: deps.reworkCwd ?? null,
      reworkModel: deps.reworkModel ?? null,
    }),
    capture: 'value',
  });
  if (!execR.ok) {
    // Recoverable: the ledger holds the failed attempt (step() marks the loop
    // ledger, never the canonical session); the rework record stays persisted
    // for provenance. No terminalize happened.
    return fail('REWORK_EXECUTE_FAILED', execR.code || null);
  }
  const execPath = execR.result.value && execR.result.value.executionRecordPath;
  const cpDir = session && session.controlPlane && session.controlPlane.stateDir;
  if (!execPath || typeof cpDir !== 'string' || !cpDir) {
    return fail('REWORK_DISPATCH_READBACK_FAILED', { executionRecordPath: execPath ?? null, controlPlaneStateDir: cpDir ?? null });
  }
  // Sequential mutation + read-back: the fresh execution record must exist at
  // its canonical location and belong to THIS identity before the loop may
  // continue to verification.
  const rb = readExecutionRecord({ stateDir: cpDir, repo: session.repo, issueNumber: session.issueNumber });
  if (!rb.ok || rb.path !== execPath || !rb.record || rb.record.identityHash !== id) {
    return fail('REWORK_DISPATCH_READBACK_FAILED', {
      reason: rb.ok ? 'identity-or-path-mismatch' : (rb.reason ?? null),
      expected: execPath, got: rb.path ?? null,
    });
  }
  // F2 (PRE-GATE-REVIEW-01): the repair round committed — refresh the
  // canonical HEAD from LIVE git and read the binding back BEFORE the
  // composite reviews the NEW candidate. Existing primitive only
  // (refreshCanonicalHead: live rev-parse + lineage guard + ownership-locked
  // session write — never a hand-edited session/ledger). AMBIGUOUS /
  // HEAD_UNRESOLVED mean there is no readable git worktree (legacy fixtures);
  // nothing to refresh there and the composite binding below still fails
  // closed on any mismatch. Every other refresh failure is typed fail-closed.
  const hr = refreshCanonicalHead({ sessionPath: loop.sessionPath, stateDir, exec: deps.pushExec ?? null });
  if (!hr.ok && hr.code !== 'HEAD_REFRESH_AMBIGUOUS' && hr.code !== 'HEAD_REFRESH_HEAD_UNRESOLVED') {
    return fail('REWORK_HEAD_REFRESH_FAILED', { code: hr.code ?? null, detail: hr.detail ?? null });
  }
  const vR = await loop.step({
    name: 'rework-verify', from: 'EXECUTING', to: 'VERIFYING',
    run: (ctx) => verifier({ ...ctx, executionRecordPath: rb.path }), capture: 'value',
    rerouteRework: true,
  });
  if (!vR.ok) {
    if (vR.rerouted === 'REWORK') {
      // F1: findings on the REPAIRED candidate continue the SAME bounded
      // canonical leg. The review did run, so record the VERIFYING arrival
      // (EXECUTING->VERIFYING is the legal edge; no BLOCKED side-transition)
      // and hand the fresh findings back to findingsReworkLeg, which owns
      // binding + digest duplicate guard + budget for the next round.
      const arr = loop.transition({
        from: 'EXECUTING', to: 'VERIFYING',
        reason: 'rework-verify-findings', evidence: vR.result,
      });
      if (!arr.ok) return fail('TRANSITION_FAILED', arr.code);
      return { ok: false, rerouted: 'REWORK', result: vR.result };
    }
    return fail('REWORK_VERIFY_FAILED', vR.code || null);
  }
  // P0-G (Issue #83): rework legs commit NEW work — the same publish chain as
  // the fresh leg (refresh/push are idempotent short-circuits for an unchanged
  // head; the PR bind adopts the already-bound PR; the packet is re-projected
  // at the NEW head so packetPathFor's exact-head match always wins).
  // packetPolicy 'require': rework-verify already ran the OCR internal review
  // on the repaired candidate, so a packet without that record is a typed
  // INTERNAL_REVIEW_PENDING/STALE failure — never a silent READY_FOR_REVIEW.
  if (deps.pushExec !== undefined) {
    const pub = await publishOrRecover({ sessionPath: loop.sessionPath, stateDir, identityHash: id, deps, executor, route: routeValue, packetPolicy: 'require' });
    if (!pub.ok) return pub;
  }
  const pR = await loop.step({
    name: 'rework-preReview', from: 'VERIFYING', to: 'PRE_REVIEWING',
    run: (ctx) => preReview({ ...ctx, report: vR.result.value, reviewReadyDir: deps.reviewReadyDir ?? null }),
    capture: 'value',
  });
  if (!pR.ok) return fail('REWORK_PRE_REVIEW_FAILED', pR.code || null);
  const fR = await loop.step({
    name: 'rework-finalReview', from: 'PRE_REVIEWING', to: 'FINAL_REVIEWING',
    run: (ctx) => finalReview({ ...ctx, report: vR.result.value, preReview: pR.result.value }),
    capture: 'value',
  });
  if (!fR.ok) return /^REVIEW_/.test(fR.code || '') ? fR : fail('REWORK_FINAL_REVIEW_FAILED', fR.code || null);
  // Persist the ANSWERED round at its DECIDING boundary — the same boundary
  // the fresh walk records before decide() consumes a review. Without this
  // arrival record the round's decision lives only on a PRE_REVIEWING->
  // FINAL_REVIEWING evidence, so a relaunch misreads the answered round as
  // "review not yet obtained" and re-asks the reviewer (duplicate submit) —
  // exactly the class the DECIDING-tail replay below exists to prevent
  // (R5: re-invocation must replay, never re-ask).
  const roundArrival = loop.transition({
    from: 'FINAL_REVIEWING',
    to: 'DECIDING',
    reason: 'rework-round-review-consumed',
    evidence: fR.result.value,
  });
  if (!roundArrival.ok) return fail('TRANSITION_FAILED', roundArrival.code);
  return ok({ decision: fR.result.value });
}

// Recover missing fields only from an immutable pre-submit request and its
// linked response. Legacy #260 rawText alone is insufficient provenance.
// Recovery is in-memory, never changes the verdict/binding or writes a ledger.
export function recoverDecisionContract({ decision, session } = {}) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return decision ?? null;
  if (typeof decision.verdict !== 'string' || !decision.verdict.trim()) return decision;
  if (Array.isArray(decision.findings) && Array.isArray(decision.evidenceRequests) && Array.isArray(decision.remediation) && 'confidence' in decision) return decision;
  if (typeof decision.rawText !== 'string' || !decision.rawText.trim()) return decision;
  const linked = validateReviewProvenance({ decision, session, allowMissingContract: true });
  if (!linked.ok) return decision;
  const nd = linked;
  if (nd.value.verdict !== decision.verdict) return decision;
  return {
    ...decision,
    findings: nd.value.findings,
    remediation: nd.value.remediation,
    evidenceRequests: nd.value.evidenceRequests,
    confidence: nd.value.confidence ?? decision.confidence ?? null,
  };
}

export async function runControlLoop({ sessionPath, identityHash: id, stateDir = defaultStateDir(), deps = {} } = {}) {
  const rs = readSessionByHash({ stateDir, identityHash: id });
  if (!rs.ok) return fail('SESSION_READ_FAILED', rs.reason || null);
  if (rs.session.repo !== CONTROL_LOOP_CANONICAL_REPO
      || rs.session.taskId !== `${CONTROL_LOOP_CANONICAL_REPO}#${rs.session.issueNumber}`) {
    return fail('IDENTITY_MISMATCH', `taskId=${rs.session.taskId} identityHash=${id}`);
  }
  if (rs.session.state === 'COMPLETED' || rs.session.state === 'FAILED' || rs.session.state === 'BLOCKED') {
    return fail('ALREADY_TERMINAL', rs.session.state);
  }
  // Replay identity must be proven before even binding a terminalize token.
  const replayLedger = readTransitions({ stateDir, identityHash: id });
  const replayTail = replayLedger[replayLedger.length - 1];
  const replayDecision = replayTail?.to === 'DECIDING' ? replayTail.evidence
    : replayTail?.to === 'DELIVERING' ? [...replayLedger].reverse().find((r) => r.from === 'DECIDING' && r.to === 'DELIVERING')?.evidence : null;
  if (typeof replayDecision?.rawText === 'string' || replayDecision?.provenance?.source === WEB2API_REVIEW_SOURCE || replayDecision?.metadata?.source === WEB2API_REVIEW_SOURCE) {
    const linked = validateReviewProvenance({ decision: recoverDecisionContract({ decision: replayDecision, session: rs.session }), session: rs.session });
    if (!linked.ok) return linked;
  }
  // Opt-in granular milestone Telegram dispatch (Issue #9000021). Gate keeps
  // ZERO cost / ZERO side effects for callers that do not pass
  // deps.telegramMilestones === true (all existing offline suites).
  const milestoneObserver = deps.telegramMilestones === true
    ? (record) => {
        try {
          const fresh = readSessionByHash({ stateDir, identityHash: id });
          if (!fresh.ok) return;
          // This event is grounded in BOTH a persisted FSM edge and the
          // finalized ExecutionRecord. VERIFYING alone does not prove success,
          // and exitCode 0 never means that the task is complete.
          if (record.from === 'EXECUTING' && (record.to === 'VERIFYING' || record.to === 'BLOCKED')) {
            const execution = readExecutionRecord({ stateDir, repo: fresh.session.repo, issueNumber: fresh.session.issueNumber });
            const e = execution.ok ? execution.record : null;
            if (e?.identityHash === id && e.finalized === true && e.terminalStatus) {
              const eventKey = createHash('sha256').update(`${e.pid}|${e.processStartTime}|${e.startedAt}`).digest('hex');
              const args = { session: fresh.session, event: 'EXECUTOR_STOPPED', eventKey, stateDir,
                note: `ExecutionRecord: ${e.terminalStatus}; exitCode=${e.exitCode ?? 'unknown'}; FSM: ${record.from}→${record.to}.`,
                allowNonCanonicalStateRoot: typeof deps.telegramSpawn === 'function' };
              if (typeof deps.telegramSpawn === 'function') args.spawn = deps.telegramSpawn;
              dispatchLifecycleEvent(args);
            }
          }
          if (record.to === 'BLOCKED') {
            const args = { session: fresh.session, event: 'CONTROL_LOOP_BLOCKED', stateDir,
              eventKey: createHash('sha256').update(`${record.ts}|${record.from}|${record.reason ?? ''}`).digest('hex'),
              note: `FSM: ${record.from}→BLOCKED; reason=${record.reason ?? 'unknown'}.`,
              allowNonCanonicalStateRoot: typeof deps.telegramSpawn === 'function' };
            if (typeof deps.telegramSpawn === 'function') args.spawn = deps.telegramSpawn;
            dispatchLifecycleEvent(args);
          }
          if (!GRANULAR_MILESTONE_EVENTS[record.to]) return;
          dispatchGranularMilestone({
            session: fresh.session,
            event: record.to,
            stateDir,
            spawn: deps.telegramSpawn ?? null,
            configPath: deps.telegramConfigPath ?? null,
          });
        } catch { /* fail-soft: never throws into FSM */ }
      }
    : null;
  const loop = bindLoop({ sessionPath, identityHash: id, stateDir, onTransition: milestoneObserver });
  // Bind THIS loop's terminalize token into the canonical session record. The
  // guard inside loop.terminalize then refuses any terminal transition unless
  // this exact loop instance is bound — adapters and external scripts have no
  // access to the token.
  const bnd = bindTerminalizeTokenToSession({ sessionPath, identityHash: id, token: loop.token, stateDir });
  if (!bnd.ok) return fail('TERMINALIZE_BIND_FAILED', bnd.code);

  // Adapter seams are resolved up-front so the P0-E resume branch below can
  // re-enter the decision policy without re-running the executor prefix.
  let routeValue = null; // assigned by the ROUTED step; the resume branch reuses the ledger instead
  const executor = deps.executor || (() => ({ ok: false, code: 'NO_EXECUTOR' }));
  const verifier = deps.verifier || (() => ({ ok: false, code: 'NO_VERIFIER' }));
  const preReview = deps.preReview || (() => ({ ok: false, code: 'NO_PRE_REVIEW' }));
  const finalReview = deps.finalReview || (() => ({ ok: false, code: 'NO_FINAL_REVIEW' }));
  // Issue #125 (rework): Fast Path state — assigned ONLY by the fresh walk
  // below; resume paths re-enter reviewContinuation BEFORE those assignments,
  // so these declarations must hoist above the resume branches (TDZ) and the
  // resume walk always takes the standard semantic-review continuation.
  let isFast = false;
  let fpTele = null;
  let executionRecordPath = null;

  const prior = readTransitions({ stateDir, identityHash: id });
  // Issue #114 item 2: a VERIFYING->BLOCKED tail whose reason is the verify
  // step's own recoverable failure ('verify:FAIL...') is treated exactly like
  // a VERIFYING tail — the resume re-enters the SAME 'verify' step invocation
  // with retryOnOwnFail (ONE attempt per relaunch, no auto-loop; the FAIL
  // record stays in the append-only ledger). Every other BLOCKED tail stays
  // fail-closed at the route step without mutation.
  const verifyFailTail = prior.length > 0
    && prior[prior.length - 1].from === 'VERIFYING' && prior[prior.length - 1].to === 'BLOCKED'
    && String(prior[prior.length - 1].reason || '').startsWith('verify:FAIL');
  // Issue #148: same recovery class for the pre-review — a
  // PRE_REVIEWING->BLOCKED tail whose reason is the preReview step's own
  // recoverable failure ('preReview:FAIL...', e.g. a transient reviewer HTTP
  // 503) is treated exactly like a PRE_REVIEWING tail: the resume re-enters
  // the SAME 'preReview' step invocation with retryOnOwnFail (ONE attempt per
  // relaunch, no auto-loop; the FAIL record stays in the append-only ledger).
  // Every other BLOCKED tail stays fail-closed at the route step.
  const preReviewFailTail = prior.length > 0
    && prior[prior.length - 1].from === 'PRE_REVIEWING' && prior[prior.length - 1].to === 'BLOCKED'
    && String(prior[prior.length - 1].reason || '').startsWith('preReview:FAIL');
  // Issue #116 item 1: same recovery class for the final review — a
  // FINAL_REVIEWING->BLOCKED tail whose reason is the finalReview step's own
  // recoverable failure ('finalReview:FAIL...') is treated exactly like a
  // FINAL_REVIEWING tail: the resume re-obtains the review ONCE via the SAME
  // finalReview invocation, re-entering the step with retryOnOwnFail so
  // loop.step admits the immediately-previous own-FAIL record. Every other
  // BLOCKED shape stays fail-closed at the route step without mutation.
  const finalReviewFailTail = prior.length > 0
    && prior[prior.length - 1].from === 'FINAL_REVIEWING' && prior[prior.length - 1].to === 'BLOCKED'
    && String(prior[prior.length - 1].reason || '').startsWith('finalReview:FAIL');
  // ---- Classified preReview transport recovery (observed #9000031, F2) -------
  // The raw web2api transport types its CDP/WS failures as a CLOSED set
  // (gemini-plus-web2api-copy EXPECTED_CDP_ERROR_RE): CDP_SEND_TIMEOUT,
  // CDP_WS_ERROR, CDP_WS_OPEN_TIMEOUT. Only that classified set is gated by
  // the SUBMIT BOUNDARY; the decision rule is the submit state, never the
  // error code's name:
  //   1. legacy shape: reason 'preReview:THREW' with a classified BARE evidence
  //      string. Pre-review persists NO request store, so an EMPTY artifact
  //      store proves NOTHING — this shape may retry ONLY through the canonical
  //      reconciled PRE_SUBMIT boundary record bound to THIS identity and THIS
  //      checkpoint (recordPreSubmitBoundaryReconciled). Without a record the
  //      reader accepts: typed-block, zero transition, no submit.
  //   2. typed shape: reason 'preReview:FAIL' with a classified evidence.code
  //      AND structured detail proving pre-submit (phase PRE_SUBMIT,
  //      submitEvidence.submitted === false) — the transport's own boundary
  //      evidence; SUBMIT_IN_FLIGHT/POST_SUBMIT/UNKNOWN or missing detail is
  //      UNPROVEN.
  //   3. BOTH shapes: any durable submit side-effect artifact
  //      (request/submit/attempt/response) -> typed-block
  //      PRE_REVIEW_SUBMIT_UNRECONCILED: reconcile the existing round, never
  //      resend automatically.
  //   4. unproven boundary -> typed-block PRE_REVIEW_SUBMIT_UNRECONCILED BEFORE
  //      the generic preReview:FAIL resume branch below, so a classified
  //      WS/timeout error with an unknown submit state (the #9000031 duplicate
  //      submit) can never fall through to a resend.
  //   5. Any other preReview:FAIL evidence is NOT classified here: a
  //      non-classified preReview:FAIL keeps its Issue #148 generic recovery
  //      (one re-entry per relaunch); a non-classified THREW stays fail-closed
  //      at route (no general preReview:THREW recovery). One attempt per
  //      relaunch via retryOnOwnFail/retryOnOwnThrow.
  const PRE_REVIEW_CLASSIFIED_TRANSPORT_CODES = Object.freeze(['CDP_SEND_TIMEOUT', 'CDP_WS_ERROR', 'CDP_WS_OPEN_TIMEOUT']);
  const preReviewLastEvidence = prior.length > 0 ? prior[prior.length - 1].evidence : null;
  const preReviewEvidenceCode = typeof preReviewLastEvidence === 'string'
    ? preReviewLastEvidence
    : (preReviewLastEvidence && typeof preReviewLastEvidence === 'object'
      ? String(preReviewLastEvidence.code || '')
      : '');
  const preReviewClassified = PRE_REVIEW_CLASSIFIED_TRANSPORT_CODES.includes(preReviewEvidenceCode);
  const preReviewThrewTail = prior.length > 0
    && prior[prior.length - 1].from === 'PRE_REVIEWING' && prior[prior.length - 1].to === 'BLOCKED'
    && String(prior[prior.length - 1].reason || '').startsWith('preReview:THREW')
    && preReviewClassified;
  const preReviewClassifiedFailTail = preReviewFailTail && preReviewClassified;
  const preReviewCanonicalStage = preReviewClassifiedFailTail
    && preReviewLastEvidence && typeof preReviewLastEvidence === 'object'
    && preReviewLastEvidence.detail && typeof preReviewLastEvidence.detail === 'object'
    && typeof preReviewLastEvidence.detail.stage === 'string'
    ? preReviewLastEvidence.detail.stage : null;
  const preReviewPreSubmitProven = preReviewClassifiedFailTail
    && preReviewLastEvidence && typeof preReviewLastEvidence === 'object'
    && preReviewLastEvidence.detail && typeof preReviewLastEvidence.detail === 'object'
    // REC-01 r6 acceptance: a DIRECT PRE_SUBMIT proof is accepted ONLY when
    // the canonical stage itself is a well-formed PRE_SUBMIT stage. A missing,
    // mistyped, or non-PRE_SUBMIT-family stage never proves NOT_SUBMITTED;
    // it falls to the fail-closed reconciliation/attempt-binding chain.
    && typeof preReviewCanonicalStage === 'string'
    && (preReviewCanonicalStage === 'PRE_SUBMIT' || preReviewCanonicalStage.startsWith('PRE_SUBMIT_'))
    && preReviewLastEvidence.detail.phase === 'PRE_SUBMIT'
    && preReviewLastEvidence.detail.submitEvidence && preReviewLastEvidence.detail.submitEvidence.submitted === false;
  if (preReviewThrewTail || preReviewClassifiedFailTail) {
    // (i) A conclusive submit side effect dominates: artifacts in the round
    // store mean a round/submit exists regardless of any boundary claim.
    const artifacts = readReviewSubmitArtifacts({ stateDir, identityHash: id });
    if (artifacts.present) {
      return fail('PRE_REVIEW_SUBMIT_UNRECONCILED', {
        reason: 'submit side-effect artifacts exist for this identity: reconcile the existing review round before any retry - no automatic resend',
        supportedCode: preReviewEvidenceCode || null,
        detail: artifacts,
      });
    }
    // (ii) Boundary proof. Legacy THREW (bare string) needs the canonical
    // reconciled-record; a typed FAIL needs its own structured pre-submit
    // detail. Artifact absence alone is NEVER sufficient for either.
    //
    // REC-01 r6: the CANONICAL submit veto runs BEFORE every retry-permitting
    // branch below - it does NOT only guard the unproven tail. A classified
    // preReview failure whose canonical evidence STAGE already asserts the
    // submit started (SUBMIT_IN_FLIGHT / POST_SUBMIT_*) or whose submitted is
    // UNKNOWN|true is reconciled as the original round even when the phase /
    // submitEvidence labels claim PRE_SUBMIT / submitted=false (contradictory
    // metadata can never launder the started-submit assertion into a
    // PRE_SUBMIT reconciliation): zero retry/submit, ledger untouched, the
    // original no-resend contract kept. Metadata that merely LACKS the
    // submit state stays on the linkage+record chain (veto:false).
    const vetoTailDirect = canonicalSubmitVeto({ canonicalEvidence: preReviewLastEvidence });
    if (vetoTailDirect.veto) {
      return fail('PRE_REVIEW_SUBMIT_UNRECONCILED', {
        reason: `${preReviewEvidenceCode} without a reconcilable pre-submit boundary: the canonical failure evidence asserts the submit had already started - reconcile the existing round before any retry - no automatic resend`,
        supportedCode: preReviewEvidenceCode || null,
        detail: (preReviewLastEvidence && typeof preReviewLastEvidence === 'object' && preReviewLastEvidence.detail) || null,
        reconcile: { reason: 'CANONICAL_SUBMIT_VETO', detail: vetoTailDirect.detail },
      });
    }
    if (preReviewThrewTail) {
      const tailRecord = prior[prior.length - 1];
      const boundary = await readPreSubmitBoundaryReconcile({
        stateDir,
        identityHash: id,
        checkpoint: { ts: String(tailRecord.ts || ''), reason: String(tailRecord.reason || ''), evidence: String(tailRecord.evidence ?? '') },
      });
      if (!boundary.ok) {
        // Retry requires a record the reader accepts as written by a
        // fence-holding writer, whose referenced evidence file still hashes
        // to the recorded sha256, AND whose daemon-written RECEIPT binds
        // those exact record bytes. Identity/generation/lane markers are only
        // cross-checks against the owner snapshot (copyable), never authority.
        return fail('PRE_REVIEW_SUBMIT_UNRECONCILED', {
          reason: 'legacy preReview:THREW has no authority-confirmed reconciliation: the record carries no Session Authority RECEIPT (a receipt is minted only by the RECEIPT op while an admitted fence holds the grant, bound to the record bytes); absent that this checkpoint requires an Operator-authorized recovery decision - no automatic resend',
          supportedCode: preReviewEvidenceCode || null,
          checkpoint: { ts: tailRecord.ts ?? null, reason: tailRecord.reason ?? null, evidence: tailRecord.evidence ?? null },
          reconcile: { reason: boundary.reason, path: boundary.path ?? null, detail: boundary.detail ?? null },
        });
      }
    } else if (!preReviewPreSubmitProven) {
      // REC-01 r5: the CANONICAL submit boundary vetoes BEFORE any record is
      // even consulted - a tail whose failure evidence asserts the submit
      // started (SUBMIT_IN_FLIGHT / submitted UNKNOWN|true / POST_SUBMIT) is
      // reconciled as the original round, never resent, whatever a marker in
      // some evidence file claims. Metadata that merely LACKS the submit state
      // is not this veto (the record chain below still decides).
      const unprovenReason = `${preReviewEvidenceCode} without a proven pre-submit boundary (phase/submit evidence missing, not PRE_SUBMIT, or submitted not false): reconcile the existing round before any retry - no automatic resend; absent an authority-confirmed reconciliation this checkpoint requires an Operator-authorized recovery decision`;
      const unprovenDetail = (preReviewLastEvidence && typeof preReviewLastEvidence === 'object' && preReviewLastEvidence.detail) || null;
      const vetoTail = canonicalSubmitVeto({ canonicalEvidence: preReviewLastEvidence });
      if (vetoTail.veto) {
        return fail('PRE_REVIEW_SUBMIT_UNRECONCILED', {
          reason: unprovenReason,
          supportedCode: preReviewEvidenceCode || null,
          detail: unprovenDetail,
          reconcile: { reason: 'CANONICAL_SUBMIT_VETO', detail: vetoTail.detail },
        });
      }
      // REC-01 r4: the recovery gate consults the canonical reconcile record
      // with a checkpoint rebuilt from THIS tail's canonical failure evidence
      // - code AND the transport attempt linkage, never dropped. Only a record
      // whose writer/seal/reader chain proves the SAME attempt authorizes the
      // retry; otherwise the typed block below stands (unchanged reason), now
      // carrying the reader's typed detail so a missing/mismatched linkage is
      // named instead of silently ignored.
      const tailRecord = prior[prior.length - 1];
      const tailAttemptId = preReviewLastEvidence && typeof preReviewLastEvidence === 'object'
        && preReviewLastEvidence.detail && typeof preReviewLastEvidence.detail === 'object'
        && typeof preReviewLastEvidence.detail.attemptId === 'string' && preReviewLastEvidence.detail.attemptId.trim()
        ? preReviewLastEvidence.detail.attemptId.trim() : null;
      const boundary = await readPreSubmitBoundaryReconcile({
        stateDir,
        identityHash: id,
        checkpoint: {
          ts: String(tailRecord.ts || ''),
          reason: String(tailRecord.reason || ''),
          evidence: preReviewEvidenceCode,
          ...(tailAttemptId ? { attemptId: tailAttemptId } : {}),
        },
      });
      if (!boundary.ok) {
        return fail('PRE_REVIEW_SUBMIT_UNRECONCILED', {
          // keep the original no-resend contract AND name the Operator as the
          // only recovery authority when the canonical record could not
          // authorize this checkpoint (missing/mismatched attempt linkage,
          // absent record or unconfirmed receipt - see reconcile.detail).
          reason: unprovenReason,
          supportedCode: preReviewEvidenceCode || null,
          detail: unprovenDetail,
          reconcile: { reason: boundary.reason, path: boundary.path ?? null, detail: boundary.detail ?? null },
        });
      }
      // boundary.ok: the canonical record + authority receipt authorized this
      // retry for THIS attempt - fall through to the bounded resume below.
    }
  }
  // ---- Pre-dispatch route retry (repair for the observed #9000031 blocker) ----
  // A ROUTED->BLOCKED tail whose reason is 'route:FAIL' AND whose evidence
  // code is whitelisted in ROUTE_RETRY_SUPPORTED_CODES re-enters the SAME
  // route step ONCE (retryOnOwnFail: ONE attempt per relaunch, no auto-loop).
  // Contract, all enforced right here:
  //   * same identity/session/authority - the SAME bound loop and the SAME
  //     step; no session, lease, lane, claim or route request is minted;
  //   * pre-dispatch only - if ANY ExecutionRecord exists for this identity,
  //     or its evidence is unreadable, the side effect is not reconciled and
  //     the retry is refused typed (ROUTE_RETRY_BLOCKED_SIDE_EFFECT);
  //   * evidence preserved - the append-only ledger keeps the old
  //     ROUTED->BLOCKED failure record byte-for-byte; a retry only APPENDS
  //     (ROUTED->EXECUTING on success, a fresh route:FAIL record on another
  //     failure) and never rewrites old evidence or timestamps;
  //   * bounded - exactly one attempt per relaunch; the canonical
  //     startExecution EXECUTION_ALREADY_RUNNING contract stays the
  //     second-caller duplicate-dispatch guard, and loop.step re-reads the
  //     ledger before dispatching;
  //   * narrow - every other BLOCKED tail (other reasons, other steps, other
  //     or missing evidence codes) stays fail-closed at route with ZERO
  //     mutation; a route failure never borrows the REWORK cause or edge.
  const routeFailTail = prior.length > 0
    && prior[prior.length - 1].from === 'ROUTED' && prior[prior.length - 1].to === 'BLOCKED'
    && String(prior[prior.length - 1].reason || '').startsWith('route:FAIL')
    && ROUTE_RETRY_SUPPORTED_CODES.includes(String((prior[prior.length - 1].evidence || {}).code || ''));
  if (routeFailTail) {
    const ex = readExecutionRecord({ stateDir, repo: rs.session.repo, issueNumber: rs.session.issueNumber });
    const notFound = ex.ok !== true && String(ex.reason || '') === 'EXECUTION_NOT_FOUND';
    if (!notFound) {
      return fail('ROUTE_RETRY_BLOCKED_SIDE_EFFECT', {
        reason: 'a dispatch side effect already exists for this identity (or its evidence is unreadable): reconcile it before any route retry',
        detail: ex.ok === true
          ? { code: 'EXECUTION_EXISTS', path: ex.path || null, terminalStatus: (ex.record && ex.record.terminalStatus) || null }
          : { code: String(ex.reason || 'EXECUTION_EVIDENCE_UNREADABLE'), path: ex.path || null },
      });
    }
  }
  // ---- Pre-spawn execute:FAIL (INSTRUCTION_REQUIRED) retry ------------------
  // Eligible ONLY when the checkpoint proves a PRE-SPAWN instruction miss:
  // tail EXECUTING->BLOCKED, reason 'execute:FAIL', evidence.code
  // INSTRUCTION_REQUIRED. Contract (all enforced here, BEFORE any transition):
  //   * bounded attempts - EXECUTE_INSTRUCTION_RETRY_LIMIT, counted from the
  //     append-only ledger (EXECUTE_RETRY_LIMIT_EXHAUSTED when reached);
  //   * no unreconciled side effect - an existing/unreadable ExecutionRecord
  //     refuses typed (EXECUTE_RETRY_BLOCKED_SIDE_EFFECT), reconcile first;
  //   * route authority restored from THIS identity's own ROUTED->EXECUTING
  //     record via restoreRouteEvidence - the router is never re-run and no
  //     new route transition is appended;
  //   * the SAME execute step re-enters once (retryOnOwnFail: one attempt per
  //     relaunch, no auto-loop); startExecution's EXECUTION_ALREADY_RUNNING
  //     plus loop.step's ledger re-read stay the duplicate-dispatch guards;
  //   * every other execute failure code / tail shape stays fail-closed with
  //     ZERO mutation - this never becomes a general execute retry.
  const executeFailTail = prior.length > 0
    && prior[prior.length - 1].from === 'EXECUTING' && prior[prior.length - 1].to === 'BLOCKED'
    && String(prior[prior.length - 1].reason || '').startsWith('execute:FAIL')
    && String((prior[prior.length - 1].evidence || {}).code || '') === 'INSTRUCTION_REQUIRED';
  let executeRetryRouteValue = null;
  if (executeFailTail) {
    const executeFails = prior.filter((r) => r && r.from === 'EXECUTING' && r.to === 'BLOCKED'
      && String(r.reason || '').startsWith('execute:FAIL')
      && String((r.evidence || {}).code || '') === 'INSTRUCTION_REQUIRED');
    if (executeFails.length >= EXECUTE_INSTRUCTION_RETRY_LIMIT) {
      return fail('EXECUTE_RETRY_LIMIT_EXHAUSTED', {
        limit: EXECUTE_INSTRUCTION_RETRY_LIMIT,
        attempts: executeFails.length,
        reason: 'bounded pre-spawn instruction-retry budget exhausted: reconcile before any further dispatch',
      });
    }
    const ex = readExecutionRecord({ stateDir, repo: rs.session.repo, issueNumber: rs.session.issueNumber });
    const notFound = ex.ok !== true && String(ex.reason || '') === 'EXECUTION_NOT_FOUND';
    if (!notFound) {
      return fail('EXECUTE_RETRY_BLOCKED_SIDE_EFFECT', {
        reason: 'a dispatch side effect already exists for this identity (or its evidence is unreadable): reconcile it before any execute retry',
        detail: ex.ok === true
          ? { code: 'EXECUTION_EXISTS', path: ex.path || null, terminalStatus: (ex.record && ex.record.terminalStatus) || null }
          : { code: String(ex.reason || 'EXECUTION_EVIDENCE_UNREADABLE'), path: ex.path || null },
      });
    }
    const restored = restoreRouteEvidence({ ledger: prior, identityHash: id, sessionPath: loop.sessionPath });
    if (!restored.ok) return restored;
    executeRetryRouteValue = restored.value;
  }
  // ---- Issue #159: review-only / adopt-existing mode ----------------------------
  // A task whose implementation ALREADY EXISTS as a pushed PR at an exact head
  // walks the FULL canonical FSM without ever dispatching an executor:
  // adopt (bind PR at exact head) -> refreshCanonicalHead (pinned to the
  // immutable target) -> verification bound to the exact head -> packet ->
  // PRE_REVIEWING -> FINAL_REVIEWING -> DECIDING -> DELIVERING -> COMPLETED.
  // No state setter is exposed: prNumber/head bind ONLY through the existing
  // canonical primitives (persistPrNumber/refreshCanonicalHead), the remote PR
  // must already exist OPEN at the exact head (never created here), and any
  // drift fails closed. Absent deps.reviewOnly, the normal executor flow is
  // byte-for-byte unchanged.
  const ro = deps.reviewOnly ?? null;
  let reviewOnly = null;
  if (ro !== null) {
    if (typeof ro !== 'object' || Array.isArray(ro)
      || !Number.isInteger(ro.pullRequest) || ro.pullRequest <= 0
      || typeof ro.headSha !== 'string' || !HEAD_SHA_40.test(ro.headSha)
      || (ro.verification !== undefined && ro.verification !== null
        && (typeof ro.verification !== 'object' || Array.isArray(ro.verification)))) {
      return fail('REVIEW_ONLY_ARGS_INVALID', 'reviewOnly requires { pullRequest: int>0, headSha: 40-hex, verification?: { executionRecordPath } }');
    }
    if (deps.fastPathDescriptor !== undefined) {
      return fail('REVIEW_ONLY_ROUTE_CONFLICT', 'review-only mode never combines with the deterministic fast path');
    }
    if (deps.pushExec === undefined) {
      return fail('REVIEW_ONLY_TRANSPORT_MISSING', 'review-only adoption needs the canonical git transport (deps.pushExec, null = real git)');
    }
    reviewOnly = { pullRequest: ro.pullRequest, headSha: ro.headSha.toLowerCase(), verification: ro.verification ?? null };
  }
  if (prior.length === 0) {
    loop.transition({ from: 'ACCEPTED', to: 'ROUTED', reason: 'loop-bind', evidence: { boundAt: new Date().toISOString() } });
  } else if (prior[prior.length - 1].to === 'DECIDING' || prior[prior.length - 1].to === 'FINAL_REVIEWING' || finalReviewFailTail) {
    // P0-E rework-leg resume (Issue #79): the ledger ends at DECIDING (round
    // review consumed but the loop was interrupted before the decision policy
    // returned) or at FINAL_REVIEWING (re-review verdict not yet consumed).
    // Re-obtain the review ONCE and re-enter the decision policy — the rework
    // dispatch-marker guard then dedupes any already-dispatched verdict, so a
    // retry can never double-dispatch. Mid-round crashes (tail inside the
    // executor/verification prefix) still fail closed at the route step
    // without dispatching anything (documented P0-E ceiling; full resume walk
    // deferred).
    // Issue #116 item 1: the finalReviewFailTail (FINAL_REVIEWING->BLOCKED
    // 'finalReview:FAIL...') joins this branch via loop.step's explicit
    // retryOnOwnFail admission below — one re-obtained review per relaunch,
    // crash-safe: a mid-review crash lands back on the same tail shape
    // (or a DECIDING tail), both of which resume again by the same rule.
    const vRec = [...prior].reverse().find((r) => r.from === 'VERIFYING' && r.to === 'PRE_REVIEWING');
    const pRec = [...prior].reverse().find((r) => r.from === 'PRE_REVIEWING' && r.to === 'FINAL_REVIEWING');
    if (finalReviewFailTail && (!vRec || !pRec)) {
      return fail('RESUME_REVIEW_EVIDENCE_MISSING', 'finalReview:FAIL tail without ledger verify/preReview evidence');
    }
    if (finalReviewFailTail || prior[prior.length - 1].to === 'FINAL_REVIEWING') {
      // Issue #116 item 1: the re-entered finalReview step goes through
      // loop.step with retryOnOwnFail — the SAME step invocation the normal
      // walk uses admits BOTH the plain FINAL_REVIEWING tail (last.to ===
      // from) AND the immediately-previous own-FAIL record (BLOCKED tail,
      // reason starts with name + ':FAIL'); every other BLOCKED shape stays
      // fail-closed via LOOP_NOT_AT_STATE with no mutation. A failing
      // re-review re-lands on the resumable own-FAIL tail (crash-safe).
      const finR = await loop.step({
        name: 'finalReview', from: 'FINAL_REVIEWING', to: 'DECIDING',
        reason: 'rework-leg-resume-review',
        run: (ctx) => finalReview({ ...ctx, report: vRec ? vRec.evidence : null, preReview: pRec ? pRec.evidence : null }),
        capture: 'value',
        retryOnOwnFail: true,
      });
      if (!finR.ok) return /^REVIEW_/.test(finR.code || '') ? finR : fail('FINAL_REVIEW_FAILED', finR.code || null);
      return await decide({ decision: finR.result.value });
    }
    // A DECIDING tail means the review round was already obtained and its
    // decision persisted as the FINAL_REVIEWING->DECIDING evidence; only
    // decide() was interrupted. Replay THAT decision — never re-ask the
    // reviewer (a second prompt for an already-answered round is a duplicate
    // submit). Mirrors the DELIVERING-tail resume below, which also replays
    // the persisted boundary decision and never re-asks the reviewer.
    const decRec = prior[prior.length - 1];
    const persisted = decRec && decRec.evidence && typeof decRec.evidence === 'object' ? decRec.evidence : null;
    if (!persisted || typeof persisted.verdict !== 'string' || !persisted.verdict.trim()) {
      return fail('DECIDING_RESUME_DECISION_MISSING', persisted ? { keys: Object.keys(persisted) } : null);
    }
    // Legacy evidence persisted by a transport that dropped the contract
    // arrays: recover it in-memory from its own rawText (never rewrite the
    // ledger). A decision whose rawText cannot be re-parsed passes through
    // unchanged and fails typed inside decide().
    const dec = recoverDecisionContract({ decision: persisted, session: rs.session });
    return await decide({ decision: dec });
  } else if (prior[prior.length - 1].to === 'VERIFYING' || prior[prior.length - 1].to === 'PRE_REVIEWING' || verifyFailTail || preReviewFailTail || preReviewThrewTail) {
    // Issue #110 VERIFYING/PRE_REVIEWING tail resume: the ledger ends inside
    // the review walk of an interrupted run. Route and execute are NEVER
    // re-run — routeValue and the execution read-back evidence are
    // reconstructed from the ledger exactly as the steps recorded them — and
    // the tail re-enters at the SAME step invocation the normal walk uses
    // ('verify' / 'preReview'), then continues the normal walk to decide().
    // loop.step stays the only state authority: a crash mid-walk lands the
    // tail on the next boundary (VERIFYING <-> PRE_REVIEWING) which this same
    // branch resumes; anything unexpected fails closed via LOOP_NOT_AT_STATE
    // without mutation. An EXECUTING tail (mid-round rework crash) still
    // fails closed at the route step below.
    const reRec = [...prior].reverse().find((r) => r.from === 'ROUTED' && r.to === 'EXECUTING');
    if (!reRec || !reRec.evidence || typeof reRec.evidence !== 'object') {
      return fail('RESUME_ROUTE_EVIDENCE_MISSING', 'no ROUTED->EXECUTING route evidence in the loop ledger');
    }
    routeValue = reRec.evidence;
    let verifyReport;
    if (prior[prior.length - 1].to === 'VERIFYING' || verifyFailTail) {
      // A prior invocation can stop after EXECUTING->VERIFYING but before
      // PR binding. Re-enter the idempotent publish chain before review.
      if (deps.pushExec !== undefined && !reviewOnly) {
        const pub = await publishOrRecover({ sessionPath, stateDir, identityHash: id, deps, executor, route: routeValue });
        if (!pub.ok) return pub;
      }
      const evRec = [...prior].reverse().find((r) => r.from === 'EXECUTING' && r.to === 'VERIFYING');
      // The EXECUTING->VERIFYING evidence may be a fresh-walk shape
      // ({executionRecordPath, ...}) OR a rework-leg shape ({verdict,
      // evidence:{executionRecordPath, ...}}) — rework rounds write the
      // verifier capture-'value' result under the same transition.
      const e = evRec && evRec.evidence;
      const executionRecordPath = e ? (e.executionRecordPath ?? (e.evidence && e.evidence.executionRecordPath)) : undefined;
      const verifyR = await loop.step({
        name: 'verify', from: 'VERIFYING', to: 'PRE_REVIEWING',
        run: (ctx) => verifier({ ...ctx, executionRecordPath }),
        capture: 'value',
        retryOnOwnFail: verifyFailTail === true,
        rerouteRework: true,
      });
      if (!verifyR.ok) {
        if (verifyR.rerouted === 'REWORK') return await findingsReworkLeg(verifyR.result);
        return fail('VERIFY_FAILED', verifyR.detail ?? verifyR.code ?? null);
      }
      verifyReport = verifyR.result.value;
    } else {
      const vRec = [...prior].reverse().find((r) => r.from === 'VERIFYING' && r.to === 'PRE_REVIEWING');
      verifyReport = vRec ? vRec.evidence : null;
    }
    return await reviewContinuation({ verifyReport, preReviewRetryOnOwnFail: preReviewFailTail === true, preReviewRetryOnOwnThrow: preReviewThrewTail === true });
  } else if (prior[prior.length - 1].to === 'DELIVERING') {
    // P0-F (Issue #81) delivery resume: the PASS decision was consumed at the
    // boundary; replay the PERSISTED boundary decision (never re-ask the
    // reviewer — a late REWORK verdict must never enter delivery). The
    // notification dispatch ledger dedupes (no re-send), the delivery adapter
    // is ledger-first (no duplicate merge/close/cleanup), and the terminal
    // transition is exactly-once via the canonical session guard.
    const b = [...prior].reverse().find((r) => r.from === 'DECIDING' && r.to === 'DELIVERING');
    const d = b && b.evidence && typeof b.evidence === 'object' ? b.evidence : null;
    if (!d || d.verdict !== 'PASS') return fail('DELIVERY_RESUME_INVALID_DECISION', b ? (b.evidence ?? null) : null);
    return await deliveryContinuation({ decision: d });
  }

  // Issue #125 (rework) — deterministic Fast Path wiring, real execution.
  // Admission gate: deps.fastPathDescriptor present -> classifyRoute decides.
  //   FAST_PATH    -> the route step dispatches runFastPath: the eligible walk
  //                   executes EXACTLY ONCE through the SAME loop.steps
  //                   (ROUTED->EXECUTING->VERIFYING->PRE_REVIEWING->
  //                   FINAL_REVIEWING->DECIDING) with deterministic
  //                   verification inside; semantic preReview/finalReview are
  //                   NOT invoked (the FP outcomes carry them as skipped —
  //                   deterministic evidence is sufficient per Issue #123).
  //                   Telemetry is persist + read-back fail-closed.
  //   STANDARD_PATH-> reasons are recorded, then the EXISTING standard
  //                   pipeline runs unchanged (executor + verifier + reviews).
  //   missing descriptor -> legacy behavior byte-for-byte.
  // ControlLoop stays the ONLY terminalization authority; no auto-chain (the
  // loop runs exactly one task per invocation).
  // ponytail: the fast walk reuses the legal standard FSM path with FP-shaped
  // evidence instead of adding new FSM edges; add a dedicated FAST state only
  // if a reviewer requirement demands a visually distinct ledger.
  const fastPathTelemetryPath = deps.fastPathDescriptor !== undefined
    ? telemetryPathFor({ stateDir, repo: rs.session.repo, issueNumber: rs.session.issueNumber })
    : null;
  let fastRoute = null;
  if (deps.fastPathDescriptor !== undefined) {
    fastRoute = classifyRoute(deps.fastPathDescriptor);
    if (fastRoute.route !== FAST_ROUTE) {
      // STANDARD_PATH fallback: reasons recorded, task CONTINUES on the
      // standard pipeline (never a FAST_PATH_NOT_ELIGIBLE stop).
      try {
        persistTelemetry(fastPathTelemetryPath, {
          acceptedAt: new Date().toISOString(),
          route: fastRoute.route,
          routeReasons: fastRoute.reasons,
        });
        readTelemetry(fastPathTelemetryPath);
      } catch (e) {
        return fail('FAST_PATH_TELEMETRY_WRITE_FAILED', { reasons: fastRoute.reasons, error: String((e && e.message) || e) });
      }
    }
  }

  // ROUTED
  // Issue #125 round-2 boundary: BEFORE any execution a fast-eligible walk may
  // still degrade to the standard pipeline (route dispatch failure/throw, or a
  // fast-path pre-execution failure) — each records its reason in the fast-path
  // telemetry and continues EXACTLY ONCE on the standard path. AFTER the
  // executor has started (or may have mutated) there is NO fallback: failures
  // stay FAIL_CLOSED and the standard executor must never run a second time.
  const fallbackToStandard = (reason) => {
    isFast = false;
    try {
      persistTelemetry(fastPathTelemetryPath, {
        acceptedAt: new Date().toISOString(),
        route: STANDARD_ROUTE,
        routeReasons: [reason],
      });
      readTelemetry(fastPathTelemetryPath);
    } catch (e) {
      return fail('FAST_PATH_TELEMETRY_WRITE_FAILED', { reasons: [reason], error: String((e && e.message) || e) });
    }
    return null;
  };
  const router = deps.router || (() => ({ ok: false, code: 'NO_ROUTER' }));
  const fastPathReadBack = deps.fastPathReadBack || readTelemetry;
  const routeR = executeRetryRouteValue
    // Pre-spawn execute:FAIL resume: canonical ROUTED->EXECUTING route evidence
    // was restored above (executeRetryRouteValue), so the route step AND its
    // router are SKIPPED - zero router calls, zero new route transitions; the
    // restored authority feeds the execute step below.
    ? { ok: true, result: { value: executeRetryRouteValue } }
    : await loop.step({
    name: 'route',
    from: 'ROUTED', to: 'EXECUTING',
    // Pre-dispatch route retry: admitted ONLY for a whitelisted route:FAIL
    // own tail (routeFailTail above, which also enforces the side-effect
    // reconcile gate). loop.step then re-reads the ledger and allows exactly
    // ONE re-entry of this SAME step; every other shape stays LOOP_NOT_AT_STATE.
    retryOnOwnFail: routeFailTail === true,
    run: async (ctx) => {
      let r;
      try {
        r = await router(ctx);
      } catch (e) {
        if (fastRoute && fastRoute.route === FAST_ROUTE) {
          const f = fallbackToStandard('FAST_PATH_PRE_EXECUTION_ROUTER_THREW');
          if (f) return f;
          return { ok: true, value: { executorKind: routeValue && routeValue.executorKind, model: routeValue && routeValue.model } };
        }
        throw e;
      }
      if (fastRoute && fastRoute.route === FAST_ROUTE) {
        if (!r || r.ok !== true) {
          const f = fallbackToStandard('FAST_PATH_PRE_EXECUTION_ROUTE_FAILED');
          if (f) return f;
          const rv = r && r.value && typeof r.value === 'object' ? r.value : {};
          return { ok: true, value: { executorKind: rv.executorKind, model: rv.model } };
        }
        r.value.fastPath = { route: FAST_ROUTE, telemetryPath: fastPathTelemetryPath };
      }
      return r;
    },
    capture: 'value',
  }).catch((e) => ({ ok: false, code: 'ROUTE_THREW', detail: String((e && e.message) || e) }));
  if (!routeR.ok) return fail('ROUTE_FAILED', routeR.code || null);
  routeValue = routeR.result.value;
  isFast = Boolean(routeValue && routeValue.fastPath);

  // EXECUTING — on the Fast Path the eligible walk REALLY executes here via
  // runFastPath, straight from ControlLoop: exactly ONE execution, the
  // deterministic verifier runs inside it, semantic reviews are NEVER invoked,
  // and the telemetry record is persisted fail-closed by runFastPath itself.
  const execR = await loop.step({
    name: 'execute', from: 'EXECUTING', to: 'VERIFYING',
    // Pre-spawn instruction retry: admitted ONLY for a proven
    // INSTRUCTION_REQUIRED own tail (executeFailTail above, whose gates also
    // enforce the attempt budget and the side-effect reconcile check). ONE
    // attempt per relaunch; every other execute failure stays fail-closed.
    retryOnOwnFail: executeFailTail === true,
    run: async (ctx) => {
      if (reviewOnly) return await runReviewOnlyAdoptLeg(ctx);
      if (!isFast) {
        return executor({ ...ctx, model: routeValue.model, executorKind: routeValue.executorKind });
      }
      const fpAttempt = async () => {
        const fp = await runFastPath({
          descriptor: deps.fastPathDescriptor,
          stateDir,
          repo: rs.session.repo,
          issueNumber: rs.session.issueNumber,
          worktreesRoot: rs.session.worktreesRoot ?? stateDir,
          // Issue #125 round-2: injectable provisioning lets the boundary test
          // exercise a PRE-execution failure (worktree provision) and prove the
          // standard pipeline then runs EXACTLY ONCE. Default keeps the bound
          // session worktree (real behavior unchanged).
          provisionWorktree: deps.fastPathProvisionWorktree ?? (async () => ({
            path: rs.session.worktreePath,
            branch: rs.session.worktreeBranch ?? `agent/${String(id).slice(0, 12)}`,
          })),
          execute: async ({ telemetry, worktreePath, branch }) => {
            const t0 = performance.now();
            const r = await executor({ ...ctx, worktreePath, branch, model: routeValue.model, executorKind: routeValue.executorKind });
            telemetry.addWait('providerWaitMs', performance.now() - t0);
            if (!r || r.ok !== true) {
              const e = new Error(`EXECUTOR_FAILED: ${JSON.stringify(r ?? null)}`);
              throw e;
            }
            executionRecordPath = r.value && r.value.executionRecordPath ? r.value.executionRecordPath : null;
            return r.value;
          },
          verify: async () => {
            const r = await verifier({ ...ctx, executionRecordPath });
            return r && r.ok === true
              ? { ok: true, evidence: r.value }
              : { ok: false, error: (r && r.code) || 'VERIFY_FAILED' };
          },
        });
        return fp;
      };
      let fp;
      try {
        fp = await fpAttempt();
      } catch (e) {
        // Defensive parity: runFastPath fail-closes its internal errors, but a
        // provisioning-seam throw is still PRE-execution (nothing has run).
        if (/^WORKTREE_PROVISION_FAILED/.test(String((e && e.message) || e))) {
          const f = fallbackToStandard('FAST_PATH_PRE_EXECUTION_PROVISION_FAILED');
          if (f) return f;
          return executor({ ...ctx, model: routeValue.model, executorKind: routeValue.executorKind });
        }
        throw e;
      }
      if (fp.terminal === 'FAIL_CLOSED' && /^WORKTREE_PROVISION_FAILED/.test(String(fp.error || ''))) {
        // Issue #125 round-2 boundary: provision failed BEFORE the executor
        // started — nothing may have mutated, so the walk degrades to the
        // standard pipeline EXACTLY ONCE (no second fast attempt).
        const f = fallbackToStandard('FAST_PATH_PRE_EXECUTION_PROVISION_FAILED');
        if (f) return f;
        return executor({ ...ctx, model: routeValue.model, executorKind: routeValue.executorKind });
      }
      if (fp.route !== FAST_ROUTE) return { ok: false, code: 'FAST_PATH_ROUTE_DRIFT', detail: fp };
      return { ok: true, value: { executionRecordPath, fastPath: fp } };
    },
    capture: 'value',
  });
  if (!execR.ok) return fail('EXECUTE_FAILED', execR.detail ?? execR.code ?? null);
  executionRecordPath = execR.result.value.executionRecordPath;

  if (isFast) {
    // Fail-closed telemetry read-back BEFORE any further side effect: all five
    // mandated aggregates must be persisted AND readable, exactly one
    // execution — otherwise the fast walk is an explicit failure, never a
    // silent success.
    try {
      fpTele = fastPathReadBack(fastPathTelemetryPath);
    } catch (e) {
      return fail('FAST_PATH_TELEMETRY_READBACK_FAILED', { telemetryPath: fastPathTelemetryPath, error: String((e && e.message) || e) });
    }
    const AGGREGATES = ['totalWallClockMs', 'productiveMs', 'providerWaitMs', 'pollingWaitMs', 'recoveryWaitMs'];
    const missing = AGGREGATES.filter((k) => typeof fpTele[k] !== 'number' || !Number.isFinite(fpTele[k]));
    if (missing.length > 0) return fail('FAST_PATH_TELEMETRY_INCOMPLETE', { missing });
    if (execR.result.resumed === true) return fail('FAST_PATH_EXECUTE_RESUMED', 'fast path must execute exactly once per invocation');
  }


  // P0-G (Issue #83): canonical publish chain — refresh the post-commit HEAD,
  // push the task branch, bind/adopt the PR at the exact pushed head, and
  // project the canonical review-ready packet BEFORE the reviewers resolve it
  // (the packet is identity-gated on pullRequest; delivery later re-adopts
  // the same PR as its own ledger-first side effect). Active only when the
  // caller injects a git transport (deps.pushExec); legacy fixtures keep the
  // previous behavior end-to-end (admission headSha stands, no git/remote).
  // Issue #159: in review-only mode the EXECUTING leg already performed the
  // adoption (refresh + PR bind + packet) against the verified-identical remote
  // head, so the generic push/adopt chain is skipped (no re-push, no re-bind).
  if (deps.pushExec !== undefined && !reviewOnly) {
    const pub = await publishOrRecover({ sessionPath, stateDir, identityHash: id, deps, executor, route: routeValue });
    if (!pub.ok) return pub;
  }

  // VERIFYING
  // Issue #125 (rework): on the fast walk the deterministic verifier ALREADY
  // ran INSIDE runFastPath (the execute step above) — re-running it here would
  // execute verification twice. The verify boundary records the FP verdict
  // verbatim: a FAIL_CLOSED fast outcome side-transitions verify:FAIL BLOCKED
  // exactly like a standard verification failure (recoverable, telemetry with
  // the mandated aggregates is already persisted).
  const verifyR = await loop.step({
    name: 'verify', from: 'VERIFYING', to: 'PRE_REVIEWING',
    run: (ctx) => {
      if (reviewOnly) return reviewOnlyVerification(ctx);
      if (isFast) {
        const fp = execR.result.value.fastPath;
        return fp.ok === true
          ? { ok: true, value: { verdict: 'PASS', fastPathTerminal: fp.terminal, evidence: fp.evidence ?? null } }
          : { ok: false, code: 'FAST_PATH_VERIFICATION_FAILED', detail: fp.error ?? 'FAIL_CLOSED' };
      }
      return verifier({ ...ctx, executionRecordPath });
    },
    capture: 'value',
    rerouteRework: true,
  });
  if (!verifyR.ok) {
    if (verifyR.rerouted === 'REWORK') return await findingsReworkLeg(verifyR.result);
    return fail('VERIFY_FAILED', verifyR.code || null);
  }

  // Issue #110: the post-verify walk (packet re-projection, preReview,
  // finalReview, decide) is shared verbatim by the normal walk AND the
  // VERIFYING/PRE_REVIEWING tail resume — the tails re-enter the SAME step
  // invocations, never a parallel code path.
  return await reviewContinuation({ verifyReport: verifyR.result.value });

  // Issue #110: hoisted shared post-verify walk. The DECIDING/FINAL_REVIEWING
  // resume branch re-enters `decide` directly; the VERIFYING/PRE_REVIEWING
  // tails re-enter here with the reconstructed verify report.
  async function reviewContinuation({ verifyReport, preReviewRetryOnOwnFail = false, preReviewRetryOnOwnThrow = false }) {
  // P0-G (Issue #83) + OCR handoff gate: re-project the canonical packet AFTER
  // the verify step. This is THE canonical handoff projection — the publish
  // chain deferred (no packet may exist before the code is reviewed), so this
  // call is STRICT: a missing, errored, stale or findings-bearing OCR
  // internal-review record returns INTERNAL_REVIEW_PENDING /
  // INTERNAL_REVIEW_STALE here and the walk stops BEFORE pre-review, final
  // review and delivery. READY_FOR_REVIEW is therefore only ever written in
  // the same run that proved the clean, candidate-bound review record.
  // Same-head overwrite stays the designed idempotent re-entry of
  // writeReviewReady; the checklist projection below is a read-only view of
  // the same records and grants no authority of its own.
  if (deps.pushExec !== undefined) {
    let pk;
    try {
      pk = projectReviewReadyPacket({
        sessionPath, stateDir,
        exec: deps.pushExec ?? null,
        gh: deps.gh ?? null,
        verifyEvidence: verifyReport && typeof verifyReport === 'object'
          ? { verdict: verifyReport.verdict ?? null, exitCode: verifyEvidenceOf(verifyReport, 'exitCode'), executionRecordPath: verifyEvidenceOf(verifyReport, 'executionRecordPath') }
          : null,
      });
    } catch (e) {
      return fail('REVIEW_PACKET_PROJECTION_FAILED', String((e && e.message) || e));
    }
    if (!pk.ok) return fail(pk.code, pk.detail);
    projectChecklistBestEffort({
      stateDir, identityHash: id, sessionPath,
      exec: deps.pushExec ?? null,
      internalReviewGate: pk.value && pk.value.internalReviewGate ? pk.value.internalReviewGate : undefined,
    });
  }

  // PRE_REVIEWING
  // reviewReadyDir is plumbed into the pre-review step the same way DELIVERING
  // (line ~298) uses it: the canonical review-ready projection must be
  // resolvable for Gemini pre-review; absent / stale / foreign packets fail
  // closed inside the pre-review adapter itself.
  // Issue #125 (rework): on the deterministic Fast Path the semantic
  // preReview/finalReview are NEVER invoked — deterministic verification is
  // sufficient evidence (Issue #123). The loop still walks the legal boundary
  // transitions (VERIFYING->PRE_REVIEWING->FINAL_REVIEWING->DECIDING), but the
  // review steps record that the semantic stage was SKIPPED by the fast path;
  // they are not calls into any reviewer.
  if (isFast) {
    const preSkip = loop.transition({
      from: 'PRE_REVIEWING', to: 'FINAL_REVIEWING',
      reason: 'fast-path-semantic-prereview-skipped',
      evidence: { semanticReviewInvoked: false, deterministic: true },
    });
    if (!preSkip.ok) return fail('TRANSITION_FAILED', preSkip.code);
    const finSkip = loop.transition({
      from: 'FINAL_REVIEWING', to: 'DECIDING',
      reason: 'fast-path-semantic-finalreview-skipped',
      evidence: { semanticReviewInvoked: false, deterministic: true },
    });
    if (!finSkip.ok) return fail('TRANSITION_FAILED', finSkip.code);
    return await decide({ decision: { verdict: 'PASS', findings: [], fastPath: true, evidence: { executionRecordPath, telemetry: fpTele } } });
  }
  const preR = await loop.step({
    name: 'preReview', from: 'PRE_REVIEWING', to: 'FINAL_REVIEWING',
    run: (ctx) => preReview({ ...ctx, report: verifyReport, reviewReadyDir: deps.reviewReadyDir ?? null }),
    capture: 'value',
    retryOnOwnFail: preReviewRetryOnOwnFail === true,
    // Narrow opt-in (repair continuation): admit ONLY the classified
    // preReview:THREW tail (CDP_SEND_TIMEOUT) that already passed the
    // submit-side-effect gates in runControlLoop. Not a general THREW retry.
    retryOnOwnThrow: preReviewRetryOnOwnThrow === true,
  });
  if (!preR.ok) return fail('PRE_REVIEW_FAILED', preR.code || null);
  const preReviewValue = preR.result.value;

  // FINAL_REVIEWING
  const finR = await loop.step({
    name: 'finalReview', from: 'FINAL_REVIEWING', to: 'DECIDING',
    run: (ctx) => finalReview({ ...ctx, report: verifyReport, preReview: preReviewValue }),
    capture: 'value',
  });
  if (!finR.ok) return /^REVIEW_/.test(finR.code || '') ? finR : fail('FINAL_REVIEW_FAILED', finR.code || null);
  const decision = finR.result.value;
  return await decide({ decision });
  }

  // Issue #159: the review-only EXECUTING leg — adoption replaces execution.
  // Order is fail-closed at every step: local worktree HEAD must already sit
  // AT the immutable target (before any gh traffic), the remote PR must exist
  // OPEN at that exact head (never created here), then the SAME canonical
  // binding primitives the publish chain uses (refreshCanonicalHead pinned to
  // the target, persistPrNumber, packet projection). No executor(), no
  // pushBranch (the remote head was just verified equal to the target), no
  // lease involvement.
  async function runReviewOnlyAdoptLeg() {
    const target = reviewOnly.headSha;
    const exec = deps.pushExec ?? null;
    const lh = execGit(exec, rs.session.worktreePath, ['rev-parse', 'HEAD']);
    if (lh.unknown) return fail('REVIEW_ONLY_HEAD_UNKNOWN', lh.error);
    if (lh.status !== 0) return fail('REVIEW_ONLY_HEAD_UNRESOLVED', (lh.stderr || lh.stdout || '').trim());
    const local = lh.stdout.trim().toLowerCase();
    if (local !== target) return fail('REVIEW_ONLY_HEAD_DRIFT', { localHead: local, target });
    const ad = requireExistingPullRequest({
      session: { ...rs.session, headSha: target },
      gh: deps.gh ?? null, env: deps.ghEnv ?? null, prNumber: reviewOnly.pullRequest,
    });
    if (!ad.ok) return ad;
    const hr = refreshCanonicalHead({ sessionPath, stateDir, exec });
    if (!hr.ok) return fail('REVIEW_ONLY_HEAD_REFRESH_FAILED', { code: hr.code ?? null, detail: hr.detail ?? null });
    if (String(hr.value.headSha).toLowerCase() !== target) return fail('REVIEW_ONLY_HEAD_DRIFT', { refreshed: hr.value.headSha, target });
    const pp = persistPrNumber(sessionPath, ad.value.prNumber);
    if (!pp.ok) return fail(pp.code ?? 'REVIEW_ONLY_PR_PERSIST_FAILED', pp.detail ?? null);
    // Persistently mark the attempt review-only (additive, ownership-safe): a
    // later crash-resume replay of this ledger can then NEVER rework-dispatch
    // an executor either.
    const flag = persistSessionRecordWith(sessionPath, (auth) => {
      auth.controlLoop = auth.controlLoop && typeof auth.controlLoop === 'object' ? auth.controlLoop : {};
      auth.controlLoop.reviewOnly = true;
    });
    if (!flag.ok) return fail('REVIEW_ONLY_FLAG_PERSIST_FAILED', flag.detail ?? flag.reason ?? null);
    // Review-only adoption runs BEFORE this walk's verify step, so the packet
    // projection defers until the OCR internal review has produced its record
    // (the post-verify handoff projection then writes the real packet).
    const pk = projectReviewReadyPacket({ sessionPath, stateDir, exec, gh: deps.gh ?? null, deferPending: true });
    if (!pk.ok) return fail(pk.code ?? 'REVIEW_ONLY_PACKET_FAILED', pk.detail ?? null);
    return ok({
      reviewOnly: true, adopted: true, prNumber: ad.value.prNumber, headSha: target,
      packet: pk.value.packet,
      executionRecordPath: (reviewOnly.verification && reviewOnly.verification.executionRecordPath) || null,
    });
  }

  // Issue #159: review-only VERIFYING — verification evidence MUST be bound to
  // the exact adopted head. Missing/stale is never auto-reused: either the
  // caller supplies a verifier transport (deps.reviewOnlyVerifier) that actually
  // re-runs the check, or an existing ExecutionRecord is re-verified through the
  // SAME deterministic verifier (which fails closed on any headSha drift), or an
  // explicit bound verdict is accepted ONLY when it self-identifies the exact
  // target head. Otherwise REVIEW_ONLY_VERIFICATION_MISSING (no review, no
  // delivery — the loop blocks before PRE_REVIEWING).
  async function reviewOnlyVerification(ctx) {
    const target = reviewOnly.headSha;
    if (typeof deps.reviewOnlyVerifier === 'function') {
      const r = await deps.reviewOnlyVerifier({ ...ctx, sessionPath, headSha: target });
      if (!r || r.ok !== true) return fail('REVIEW_ONLY_VERIFICATION_FAILED', (r && (r.code || r.detail)) || null);
      const v = r.value || {};
      if (String(v.headSha || '').toLowerCase() !== target) return fail('REVIEW_ONLY_VERIFICATION_STALE', { got: v.headSha ?? null, target });
      if (v.verdict !== 'PASS') return fail('REVIEW_ONLY_VERIFICATION_FAILED', { verdict: v.verdict ?? null });
      return ok({ verdict: 'PASS', reviewOnly: true, headSha: target, evidence: v.evidence ?? null });
    }
    if (reviewOnly.verification && reviewOnly.verification.executionRecordPath) {
      return verifier({ ...ctx, executionRecordPath: reviewOnly.verification.executionRecordPath });
    }
    if (reviewOnly.verification && reviewOnly.verification.verdict) {
      const v = reviewOnly.verification;
      if (String(v.headSha || '').toLowerCase() !== target) return fail('REVIEW_ONLY_VERIFICATION_STALE', { got: v.headSha ?? null, target });
      if (v.verdict !== 'PASS') return fail('REVIEW_ONLY_VERIFICATION_FAILED', { verdict: v.verdict });
      return ok({ verdict: 'PASS', reviewOnly: true, headSha: target, evidence: v.evidence ?? null });
    }
    return fail('REVIEW_ONLY_VERIFICATION_MISSING', 'review-only mode refuses to review a head with no exact-head-bound verification evidence');
  }

  // PRE-GATE-REVIEW-01 — internal-review findings -> bounded rework leg.
  // Function declaration (hoisted): BOTH verify call sites (fresh walk and
  // VERIFYING-tail resume) route through this one seam. The composite's
  // INTERNAL_REVIEW_FINDINGS detail carries the redacted findings plus the
  // candidate binding keys; they become a canonical REWORK decision bound to
  // the pinned candidate and dispatched through the SAME runReworkLeg the
  // GPT verdict uses (budget + digest duplicate guard + readback shared).
  // The review was never obtained through a semantic review step, so the leg
  // starts at VERIFYING — never DECIDING — and decide() consumes the leg's
  // own fresh review of the repaired candidate.
  async function findingsReworkLeg(verifyFailure) {
    // Issue #159 sibling: review-only has no fresh-execution authority —
    // a findings verdict is a hard stop, before any transition.
    if (reviewOnly || (rs.session.controlLoop && rs.session.controlLoop.reviewOnly === true)) {
      const found = verifyFailure && verifyFailure.detail && Array.isArray(verifyFailure.detail.findings)
        ? verifyFailure.detail.findings : [];
      return fail('REVIEW_ONLY_NO_REWORK_DISPATCH', { findings: found, evidenceRequests: [] });
    }
    // F2 read-back: a prior round's leg may have refreshed the canonical
    // HEAD (repair commit) — bind THIS findings round against the CURRENT
    // persisted session, never a stale in-memory snapshot.
    const curRound = readSessionByHash({ stateDir, identityHash: id });
    if (curRound.ok) rs.session = curRound.session;
    const d = verifyFailure && verifyFailure.detail && typeof verifyFailure.detail === 'object'
      ? verifyFailure.detail
      : {};
    const findings = (Array.isArray(d.findings) ? d.findings : [])
      .map((f) => (typeof f === 'string' ? f : JSON.stringify(f)));
    if (findings.length === 0) return fail('VERIFY_FAILED', verifyFailure?.code ?? null);
    // Candidate binding: the review payload must echo the pinned session
    // head. Pinned head is authoritative; a mismatched echo is a review of a
    // drifted candidate and never dispatches (fail-closed, not re-based).
    const pinned = typeof rs.session.headSha === 'string' && HEAD_SHA_40.test(rs.session.headSha)
      ? rs.session.headSha.toLowerCase()
      : null;
    const echoed = typeof d.responseHeadSha === 'string' && HEAD_SHA_40.test(d.responseHeadSha)
      ? d.responseHeadSha.toLowerCase()
      : null;
    if (pinned && echoed && pinned !== echoed) {
      return fail('REWORK_BINDING_STALE', { pinned, echoed });
    }
    const headSha = pinned ?? echoed;
    if (!headSha) return fail('REWORK_BINDING_MISSING', 'internal-review findings carry no bindable headSha');
    const decision = {
      verdict: 'REWORK',
      binding: { repository: rs.session.repo, issue: rs.session.issueNumber, headSha },
      findings,
      evidenceRequests: [],
      provenance: {
        source: 'pre-gate-internal-review',
        correlationKey: typeof d.correlationKey === 'string' ? d.correlationKey : null,
        status: typeof d.status === 'string' ? d.status : null,
      },
    };
    const rw = await runReworkLeg({
      loop, deps, stateDir, identityHash: id, session: rs.session, routeValue, decision,
      executor, verifier, preReview, finalReview, sourceFrom: 'VERIFYING',
    });
    if (!rw.ok) {
      // F1: findings on the repaired candidate — the leg handed the fresh
      // verdict back; continue the SAME bounded canonical chain (binding,
      // duplicate guard and the finite MAX_REWORK_ROUNDS budget are all
      // re-evaluated inside runReworkLeg; exhaustion lands VERIFYING->BLOCKED).
      if (rw.rerouted === 'REWORK') return await findingsReworkLeg(rw.result);
      return rw;
    }
    if (rw.value && rw.value.state === 'BLOCKED') return ok(rw.value); // budget escalation: already transitioned + terminalized
    // F2 read-back: the leg may have refreshed the canonical HEAD — decide()
    // and everything downstream bind against the CURRENT session.
    const curDecision = readSessionByHash({ stateDir, identityHash: id });
    if (curDecision.ok) rs.session = curDecision.session;
    return await decide({ decision: rw.value.decision });
  }

  // DECIDING — single decision policy, re-entered after each rework leg.
  // Function declaration (hoisted): the P0-E resume branch above re-enters it
  // before the executor prefix steps are reached.
  async function decide({ decision: d }) {
    // S4 verdict auto-transition: EVERY decision source (fresh finalReview,
    // rework-leg follow-up, all resume paths, fast path) funnels through here,
    // so this is the one normalization seam. Structured PASS/REWORK/BLOCKED
    // decisions are byte-identical (existing gates unchanged); a raw
    // `VERDICT: ...` response is parsed and mapped to the FSM verdict with
    // loop-owned session binding; anything unparseable fails closed with a
    // deterministic VERDICT_* code BEFORE any transition — never a guessed
    // verdict, never a silent fall-through into DELIVERING.
    const nd = normalizeReviewDecision({ decision: d, session: rs.session });
    if (!nd.ok) return fail(nd.code, nd.detail);
    d = nd.value;
    let decisionSession = rs.session;
    if (typeof d.rawText === 'string' || d.provenance?.source === WEB2API_REVIEW_SOURCE || d.metadata?.source === WEB2API_REVIEW_SOURCE) {
      const current = readSessionByHash({ stateDir, identityHash: id });
      if (!current.ok) return fail('REVIEW_SESSION_UNREADABLE');
      const linked = validateReviewProvenance({ decision: d, session: current.session });
      if (!linked.ok) return linked;
      decisionSession = current.session;
    }
    if (d.verdict === 'REWORK') {
      // Issue #159: review-only never re-dispatches an executor (there is no
      // fresh-execution authority and spawning one would drift the immutable
      // head). A REWORK verdict is a hard stop, before any transition.
      if (reviewOnly || (rs.session.controlLoop && rs.session.controlLoop.reviewOnly === true)) {
        return fail('REVIEW_ONLY_NO_REWORK_DISPATCH', { findings: d.findings ?? [], evidenceRequests: d.evidenceRequests ?? [] });
      }
      // Transport -> decision contract check at the ONE normalization seam.
      // buildReworkRecord (rework.mjs:49/52) spreads findings/evidenceRequests
      // VERBATIM, so a REWORK decision without them would throw an uncaught
      // `decision.findings is not iterable` deeper in the FSM — including on the
      // DECIDING-tail replay path, which never passes through the runner's
      // finalReview closure. Fail CLOSED with a typed code BEFORE any transition;
      // never substitute `[]` (that would hide the defect instead of reporting it).
      if (!Array.isArray(d.findings)) {
        return fail('REVIEW_DECISION_FINDINGS_MISSING',
          { actual: d.findings === undefined ? 'absent (undefined)' : typeof d.findings });
      }
      if (!Array.isArray(d.evidenceRequests)) {
        return fail('REVIEW_DECISION_EVIDENCE_MISSING',
          { actual: d.evidenceRequests === undefined ? 'absent (undefined)' : typeof d.evidenceRequests });
      }
      if (!d.findings.every((f) => typeof f === 'string') || !d.evidenceRequests.every((e) => typeof e === 'string')) return fail('REVIEW_DECISION_PAYLOAD_MALFORMED');
    // P0-E (Issue #79): Soc_brain (never GPT) consumes the validated REWORK
    // verdict — persist decision + findings/evidenceRequests with provenance,
    // re-dispatch the SAME bound executor authority, read-back, and re-run
    // verification/review. Returns either the follow-up decision (hand it to
    // DECIDING again) or a fail-closed/recoverable error.
    const rw = await runReworkLeg({
      loop, deps, stateDir, identityHash: id, session: decisionSession, routeValue, decision: d,
      executor, verifier, preReview, finalReview,
    });
    if (!rw.ok) {
      // F1 call-site: findings on the REPAIRED candidate of a final-review
      // REWORK round. The leg handed the fresh verdict back — continue the
      // SAME bounded canonical chain through findingsReworkLeg (binding +
      // digest duplicate guard + finite budget all re-evaluated there;
      // exhaustion lands VERIFYING->BLOCKED). Every other failure stays a
      // typed fail-closed result — a transport error is never a reroute.
      if (rw.rerouted === 'REWORK') return await findingsReworkLeg(rw.result);
      return rw;
    }
    if (rw.value && rw.value.state === 'BLOCKED') return ok(rw.value); // budget escalation: already transitioned + terminalized
    return await decide({ decision: rw.value.decision });
  }
  if (d.verdict === 'BLOCKED') {
    loop.transition({ from: 'DECIDING', to: 'BLOCKED', reason: 'final-review-blocked', evidence: d });
    const term = loop.terminalize({ outcome: 'BLOCKED', decision: d });
    // Include the decision in the BLOCKED return so downstream consumers
    // (S5 dispatcher) can extract findings/evidenceRequests from the review
    // verdict. The terminalize result itself only carries session state;
    // the decision is the authoritative review evidence.
    return ok({ state: 'BLOCKED', terminalize: term, decision: d, loopToken: loop.token });
  }

  // DELIVERING — REQUIRED READY_FOR_REVIEW notification obligation.
  // (1) canonical boundary transition DECIDING->DELIVERING;
  const tw = loop.transition({ from: 'DECIDING', to: 'DELIVERING', reason: 'ready-for-review-boundary', evidence: d });
  if (!tw.ok) return fail('TRANSITION_FAILED', tw.code);
  return await deliveryContinuation({ decision: d });
  }

  // P0-F (Issue #81): shared DELIVERING continuation — notification evidence
  // gate, then the Soc_brain-owned canonical delivery (deps.delivery), then
  // the canonical terminal transition verified against the PERSISTED session
  // record. Used by the fresh PASS path AND the DELIVERING-tail resume path
  // (crash between boundary and completion), so recovery replays exactly-once:
  // the dispatch ledger dedupes the notification, the delivery adapter is
  // ledger-first (no duplicate merge/close/cleanup), and terminalization is
  // guarded by the canonical session itself. A failure anywhere leaves the
  // loop at the DELIVERING tail (recoverable) — never a fabricated COMPLETED.
  async function deliveryContinuation({ decision: d }) {
  if (typeof d?.rawText === 'string' || d?.provenance?.source === WEB2API_REVIEW_SOURCE || d?.metadata?.source === WEB2API_REVIEW_SOURCE) {
    const current = readSessionByHash({ stateDir, identityHash: id });
    if (!current.ok) return fail('REVIEW_SESSION_UNREADABLE');
    const linked = validateReviewProvenance({ decision: d, session: current.session });
    if (!linked.ok) return linked;
  }
  // Read-only checklist refresh at the READY_FOR_REVIEW boundary: the final
  // review decision is now in the ledger, so the projection reports OCR
  // invocation, review result, required gate and final review from records —
  // and leaves the human gate PENDING (this projection never grants it).
  projectChecklistBestEffort({ stateDir, identityHash: id, sessionPath, exec: deps.pushExec ?? null });
  // (2) required notification side-effect — owned by ControlLoop itself, never
  // by executor/model memory; idempotent via the dispatch evidence ledger
  // (only API_ACCEPTED dedupes; failed/not-attempted stay recoverable).
  // The message carries the canonical review-ready packet when resolvable;
  // an unresolvable packet degrades to status-only (documented deviation).
  const packet = packetPathFor({ sessionPath, reviewReadyDir: deps.reviewReadyDir ?? null });
  const ev = readinessNotificationEvidence({
    session: rs.session, stateDir, spawn: deps.telegramSpawn ?? null,
    configPath: deps.telegramConfigPath ?? null, note: d && d.verdict,
    packetPath: packet.ok ? packet.packetPath : null,
  });
  let evidence = ev.status === 'API_ACCEPTED'
    ? { notification: { status: ev.status, messageId: ev.messageId ?? null, recordsPath: ev.recordsPath ?? null, packet: packet.ok ? packet.filename : null } }
    : null;
  // (2b) transport dead -> deterministic bounded recovery from the persisted
  // ledger (only if a prior attempt left evidence; recovery never fabricates).
  if (!evidence && deps.telegramRecovery !== false) {
    const rec = recoverLifecycleEvent({
      session: rs.session, event: READY_FOR_REVIEW_EVENT, stateDir,
      ...(deps.telegramSpawn ? { spawn: deps.telegramSpawn } : {}),
      ...(deps.telegramConfigPath ? { configPath: deps.telegramConfigPath } : {}),
      note: d && d.verdict,
      documentPath: packet.ok ? packet.packetPath : null,
    });
    if (rec && rec.status === 'API_ACCEPTED') {
      evidence = { notification: { status: 'API_ACCEPTED', messageId: rec.messageId ?? null, recordsPath: rec.recordsPath ?? null, recovered: true, packet: packet.ok ? packet.filename : null } };
    } else if (rec) {
      evidence = { notification: { status: rec.status, reason: rec.reason ?? rec.error ?? null, recovery: rec.status === 'DELIVERY_FAILED' ? 'DELIVERY_FAILED' : 'NOT_RECOVERABLE', recordsPath: rec.recordsPath ?? ev.recordsPath ?? null } };
    }
  }
  // (3) delivery evidence gate — fail closed: without terminal evidence the
  // obligation is NOT satisfied and the loop must not continue to COMPLETED.
  if (!evidence || evidence.notification.status !== 'API_ACCEPTED') {
    return fail('DELIVER_FAILED', evidence || ev);
  }
  // (4) canonical delivery (P0-F): REVIEW_PASS + notification evidence are
  // necessary, NEVER sufficient — the ControlLoop-owned delivery lifecycle
  // must actually complete before the terminal transition. No loop.step here:
  // a failed/ambiguous delivery must leave the loop at the DELIVERING tail
  // (recoverable via the resume path), not auto-BLOCKED.
  if (!deps.delivery) return fail('DELIVER_STEP_FAILED', 'delivery lifecycle adapter is required after validated PASS');
  let deliveryValue = null;
  try {
    const r = await deps.delivery({ sessionPath, decision: d, notification: evidence.notification });
    if (!r || r.ok !== true) return fail('DELIVER_STEP_FAILED', r || null);
    deliveryValue = r.value;
  } catch (e) {
    return fail('DELIVER_STEP_FAILED', String((e && e.message) || e));
  }
  // Issue #132 rework step 1 (terminalization ordering): the terminal
  // transition may only run when the cleanup leg completed with persisted
  // read-back evidence. A delivery adapter that already performed the
  // canonical cleanup carries the `cleanup` evidence in its value; ANY other
  // adapter leaves the cleanup leg to the ControlLoop itself — same workspace
  // primitive, same crash-safe ledger, idempotent (ALREADY_ABSENT / already
  // verified evidence re-verifies instead of mutating twice). Cleanup failure
  // NEVER destroys the delivery evidence already in the ledger (F8 semantics)
  // — the loop stays at the recoverable DELIVERING tail, never fabricates
  // COMPLETED.
  if (!deliveryValue || !deliveryValue.cleanup) {
    const cl = await performCanonicalCleanup({ session: rs.session, deps });
    if (!cl.ok) return fail('DELIVER_STEP_FAILED', { code: cl.code || 'DELIVERY_CLEANUP_FAILED', detail: cl.detail || null });
    const cw = writeDeliveryCleanup({ stateDir, identityHash: id }, cl.value.cleanup);
    if (!cw.ok) return fail('DELIVER_STEP_FAILED', { code: 'DELIVERY_LEDGER_WRITE_FAILED', detail: cw.detail });
    const clv = verifyCleanupCompletion({ stateDir, identityHash: id });
    if (!clv.ok) return fail('DELIVER_STEP_FAILED', clv);
    deliveryValue = { ...(deliveryValue || {}), cleanup: cl.value.cleanup };
  }
  const clv = verifyCleanupCompletion({ stateDir, identityHash: id });
  if (!clv.ok) return fail('DELIVER_STEP_FAILED', clv);
  // (5) canonical terminal transition + REAL state read-back. TASK_COMPLETED
  // is a canonical session state, not a computed verdict: the terminalize
  // result is verified against the persisted session record before the loop
  // may report COMPLETED; anything else fails closed (no fake terminal state).
  loop.transition({ from: 'DELIVERING', to: 'COMPLETED', reason: 'canonical-delivery-verified', evidence: { notification: evidence.notification, delivery: deliveryValue } });
  const term = loop.terminalize({ outcome: 'COMPLETED', decision: d });
  if (!term || term.ok !== true) return fail('TERMINALIZE_FAILED', term || null);
  let persisted = null;
  try { persisted = JSON.parse(fs.readFileSync(sessionPath, 'utf8')); } catch { /* read-back fails closed below */ }
  if (!persisted || persisted.state !== 'COMPLETED') {
    return fail('TERMINAL_STATE_VERIFY_FAILED', { expected: 'COMPLETED', got: persisted ? persisted.state : null });
  }
  return ok({ state: 'COMPLETED', notification: evidence.notification, delivery: deliveryValue, terminalize: term, loopToken: loop.token });
  }
}

export function assertTerminalizationAuthorized({ sessionPath, identityHash: id, presentedToken, stateDir = defaultStateDir() }) {
  const rs = readSessionByHash({ stateDir, identityHash: id });
  if (!rs.ok) return fail('SESSION_READ_FAILED', rs.reason);
  const expected = rs.session.controlLoop && rs.session.controlLoop.terminalizeToken;
  if (!expected) return fail('NOT_CONTROL_LOOP_BOUND', 'session.controlLoop.terminalizeToken missing');
  if (typeof presentedToken !== 'string' || presentedToken !== expected) {
    return fail('TERMINALIZATION_TOKEN_MISMATCH', 'presented token does not match session-bound token');
  }
  return ok({ authorized: true, expected });
}

export function bindTerminalizeTokenToSession({ sessionPath, identityHash: id, token, stateDir = defaultStateDir(), now = () => new Date().toISOString() }) {
  const rs = readSessionByHash({ stateDir, identityHash: id });
  if (!rs.ok) return fail('SESSION_READ_FAILED', rs.reason);
  // Issue #145 rework F1: the terminalize-token bind is an owner-carrying
  // whole-session write — serialized under the ownership boundary.
  const p = persistSessionRecordWith(sessionPath, (auth) => {
    auth.controlLoop = auth.controlLoop || {};
    auth.controlLoop.terminalizeToken = token;
    auth.controlLoop.boundAt = now();
    auth.controlLoop.identityHash = id;
  });
  if (!p.ok) return fail('PERSIST_FAILED', p.detail ?? p.reason ?? null);
  return ok({ bound: true });
}

// ---- Issue #132: session-at-intake + task-server delivery terminalize --------
// bindSessionLoop performs the EXACT binding pair runControlLoop performs at
// loop start (bindLoop + bindTerminalizeTokenToSession), exposed as the
// canonical ControlLoop-owned primitive so the task-server/worktree flow can
// persist controlLoop.terminalizeToken into the session record AT INTAKE
// instead of running lifecycle-blind. First binding wins: re-intake never
// rotates the session-bound token (only a real runControlLoop run binds its
// own loop token, unchanged canonical behavior). The token is never returned
// to callers — it lives only in the canonical session record and is presented
// later exclusively by ControlLoop code.
export function bindSessionLoop({ sessionPath, identityHash: id, stateDir = defaultStateDir(), now = () => new Date().toISOString() } = {}) {
  const rs = readSessionByHash({ stateDir, identityHash: id });
  if (!rs.ok) return fail('SESSION_READ_FAILED', rs.reason);
  if (rs.session.state === 'COMPLETED' || rs.session.state === 'FAILED' || rs.session.state === 'BLOCKED') {
    return fail('ALREADY_TERMINAL', rs.session.state);
  }
  if (rs.session.controlLoop && rs.session.controlLoop.terminalizeToken) {
    return ok({ bound: true, alreadyBound: true });
  }
  const loop = bindLoop({ sessionPath, identityHash: id, stateDir, now });
  const bnd = bindTerminalizeTokenToSession({ sessionPath, identityHash: id, token: loop.token, stateDir, now });
  if (!bnd.ok) return fail('TERMINALIZE_BIND_FAILED', bnd.code);
  return ok({ bound: true, alreadyBound: false });
}

// terminalizeDeliveredTask — canonical terminalize leg for a task-server flow
// whose delivery happened OUTSIDE the runControlLoop walk (executor-created
// PR, human merge). Fail-closed order mirrors the canonical runControlLoop
// tail: canonical identity resolution -> replay dedupe -> session-bound intake
// token gate -> ExecutionRecord identity chain -> REMOTE read-back of the
// delivery (merge + close VERIFIED, never claimed) -> canonical
// DELIVERING->COMPLETED ledger transition -> taskFinish (persist COMPLETED +
// real read-back) -> dispatch TASK_COMPLETED (exactly-once via the dispatch
// dedupe ledger).
//
// Issue #132 rework steps 2+3:
//   - identity is resolved through the canonical session reader — callers pass
//     repo+issueNumber (or an already-canonical sessionPath+identityHash pair);
//     free-form branch/headSha/worktreePath arguments are NEVER accepted (the
//     delivery binding re-derives them from the canonical session record).
//   - the executor leg must have bound its ExecutionRecord into the SAME
//     identity chain (identityHash + worktree + issue); a session whose
//     executor leg never bound an execution identity can never be terminalized.
//   - the persisted rework budget (MAX_REWORK_ROUNDS = 3, same crash-safe
//     ledger the canonical rework leg counts) must NOT be exhausted — the
//     task-server flow shares the one rework budget per identity.
// A session without a bound intake token (a legacy task that never entered
// session-at-intake) can NEVER pass the token gate — no backfill, no
// fabricated terminal state.
export async function terminalizeDeliveredTask({
  sessionPath = null, identityHash: id = null,
  repo = null, issueNumber = null,
  stateDir = defaultStateDir(),
  worktreesRoot = defaultWorktreesRoot(),
  dispatchOptions = {}, deps = {},
} = {}) {
  let sPath = sessionPath;
  let h = id;
  if (!sPath || !h) {
    // Canonical resolution: the delivery leg derives identity from the
    // canonical session state — never from caller free-form values.
    // Issue #132 rework step 3: the ONE canonical reader resolves the
    // identity, the session AND the workspace binding; free-form identity
    // arguments never reach the terminalize gate.
    const can = readCanonicalTask({ repo, issueNumber, stateDir, worktreesRoot });
    if (!can.ok) {
      // Issue #132 rework step 1 (terminalization ordering): a COMPLETED
      // terminalize removes the workspace binding BY DESIGN, so a replay of
      // the resolution path can no longer re-derive the task through the
      // workspace chain. Terminal state lives in the canonical session record
      // + the delivery ledger: a COMPLETED session with verified cleanup
      // evidence is the ONLY accepted deduped replay; anything else fails
      // closed with the original chain reason (no backfill, ever).
      const hPost = identityHash({ repo, issueNumber });
      const rsPost = readSessionByHash({ stateDir, identityHash: hPost });
      if (rsPost.ok && rsPost.session.identityHash === hPost && rsPost.session.state === 'COMPLETED') {
        const rl = verifyCleanupCompletion({ stateDir, identityHash: hPost });
        if (!rl.ok) return fail('TERMINAL_STATE_VERIFY_FAILED', rl.detail || rl.code);
        return ok({ alreadyTerminal: true, deduped: true, state: 'COMPLETED' });
      }
      return fail(can.reason || 'SESSION_NOT_FOUND', can.detail || null);
    }
    sPath = can.sessionPath;
    h = can.identityHash;
  }
  // Issue #132 rework step 1 (terminalization ordering): the ONLY accepted
  // terminal replay is the canonical one — the session record shows COMPLETED
  // AND the delivery ledger carries the verified cleanup evidence. This gate
  // runs BEFORE the workspace-binding chain check because the canonical
  // cleanup REMOVES that binding (by design): a terminal session can never be
  // re-resolved through the workspace chain again. A COMPLETED session file
  // without the canonical cleanup ledger is a fabricable terminal state —
  // fail closed instead of deduping.
  const rsPre = readSessionByHash({ stateDir, identityHash: h });
  if (rsPre.ok && rsPre.session.identityHash === h && rsPre.session.state === 'COMPLETED') {
    const rl = verifyCleanupCompletion({ stateDir, identityHash: h });
    if (!rl.ok) return fail('TERMINAL_STATE_VERIFY_FAILED', rl.detail || rl.code);
    return ok({ alreadyTerminal: true, deduped: true, state: 'COMPLETED' });
  }
  // Issue #132 rework step 3: even when the caller supplied sessionPath+
  // identityHash directly, the canonical binding chain is re-verified —
  // binding, session and ExecutionRecord must share ONE canonical identity.
  // readCanonicalTaskWithBinding is fail-closed (also guards the no-binding
  // case); the worktrees root is the session-owned canonical pointer, so a
  // caller pointing at a foreign root can never make the chain pass.
  const canVerify = readCanonicalTaskWithBinding({ stateDir, worktreesRoot, sessionPath: sPath, identityHash: h });
  if (!canVerify.ok) return fail(canVerify.reason || 'IDENTITY_CHAIN_BROKEN', canVerify.detail || null);
  sPath = canVerify.sessionPath;
  h = canVerify.identityHash;
  const rs = readSessionByHash({ stateDir, identityHash: h });
  if (!rs.ok) return fail('SESSION_READ_FAILED', rs.reason || null);
  const session = rs.session;
  if (session.repo !== CONTROL_LOOP_CANONICAL_REPO
      || session.taskId !== `${CONTROL_LOOP_CANONICAL_REPO}#${session.issueNumber}`) {
    return fail('IDENTITY_MISMATCH', `taskId=${session.taskId} identityHash=${h}`);
  }
  if (session.state === 'FAILED' || session.state === 'BLOCKED') {
    return fail('ALREADY_TERMINAL', session.state);
  }
  const token = session.controlLoop && session.controlLoop.terminalizeToken;
  if (typeof token !== 'string' || !token) {
    return fail('NOT_CONTROL_LOOP_BOUND', 'session.controlLoop.terminalizeToken missing — no canonical intake binding; refusing to terminalize');
  }
  // Token gate BEFORE any mutation or remote call: an unauthorized caller
  // leaves NO ledger record and NO delivery traffic.
  const auth = assertTerminalizationAuthorized({ sessionPath: sPath, identityHash: h, presentedToken: token, stateDir });
  if (!auth.ok) return fail(auth.code, auth.detail);
  // ExecutionRecord identity chain (mandatory assert): identityHash, worktree,
  // repo and issue of the canonical ExecutionRecord must equal the session's —
  // the delivery of a task whose executor leg is outside the chain is refused.
  const cpDir = session.controlPlane && session.controlPlane.stateDir;
  if (typeof cpDir !== 'string' || !cpDir) {
    return fail('EXECUTION_IDENTITY_MISSING', 'session.controlPlane.stateDir missing — canonical ExecutionRecord location unknown');
  }
  const ex = readExecutionRecord({ stateDir: cpDir, repo: session.repo, issueNumber: session.issueNumber });
  if (!ex.ok || !ex.record || ex.record.identityHash !== h) {
    return fail('EXECUTION_IDENTITY_MISSING', ex.ok ? 'ExecutionRecord identity mismatch' : (ex.reason || 'ExecutionRecord unreadable'));
  }
  if (ex.record.worktreePath !== session.worktreePath
      || ex.record.repo !== session.repo
      || Number(ex.record.issueNumber) !== Number(session.issueNumber)) {
    return fail('EXECUTION_IDENTITY_MISMATCH', {
      record: { worktreePath: ex.record.worktreePath ?? null, repo: ex.record.repo ?? null, issueNumber: ex.record.issueNumber ?? null },
      session: { worktreePath: session.worktreePath ?? null, repo: session.repo ?? null, issueNumber: session.issueNumber ?? null },
    });
  }
  // Rework budget: the SAME crash-safe ledger the canonical rework leg
  // persists/count bounds the task-server flow — an identity that already
  // burned MAX_REWORK_ROUNDS is never silently terminalized as delivered.
  const digests = listReworkDigests({ stateDir, identityHash: h });
  if (digests.length >= MAX_REWORK_ROUNDS) {
    return fail('REWORK_BUDGET_EXHAUSTED', { rounds: digests.length, max: MAX_REWORK_ROUNDS });
  }
  // Remote delivery read-back: merge + close are VERIFIED, never trusted.
  let v;
  try {
    v = await verifyExternalDelivery({ issue: session.issueNumber, headSha: session.headSha, branch: session.branch, gh: deps.gh ?? null, env: deps.env ?? null });
  } catch (e) {
    return fail('DELIVERY_VERIFY_THREW', String((e && e.message) || e));
  }
  if (!v.ok) return fail(v.code || 'DELIVERY_VERIFY_FAILED', v.detail);
  // Issue #132 rework step 1 (canonical terminalization ordering): the
  // terminal state is only reachable AFTER the canonical delivery cleanup
  // completed AND its read-back evidence is persisted. Fail-closed: any
  // cleanup refusal/ambiguity leaves the session recoverable, never terminal.
  const cl = await performCanonicalCleanup({ session, deps });
  if (!cl.ok) return fail(cl.code || 'CLEANUP_FAILED', cl.detail || null);
  const cw = writeDeliveryCleanup({ stateDir, identityHash: h }, cl.value.cleanup);
  if (!cw.ok) return fail('DELIVERY_LEDGER_WRITE_FAILED', cw.detail);
  const clv = verifyCleanupCompletion({ stateDir, identityHash: h });
  if (!clv.ok) return fail(clv.code || 'CLEANUP_EVIDENCE_MISSING', clv.detail || null);
  const loop = bindLoop({ sessionPath: sPath, identityHash: h, stateDir });
  const t = loop.transition({ from: 'DELIVERING', to: 'COMPLETED', reason: 'canonical-delivery-verified-task-server', evidence: { delivery: v.value } });
  if (!t.ok) return fail('ILLEGAL_TRANSITION', t.detail);
  const term = taskFinish({ sessionPath: sPath, outcome: 'COMPLETED', dispatchOptions });
  if (!term || term.ok !== true) return fail('TERMINALIZE_FAILED', term || null);
  let persisted = null;
  try { persisted = JSON.parse(fs.readFileSync(sPath, 'utf8')); } catch { /* read-back fails closed below */ }
  if (!persisted || persisted.state !== 'COMPLETED') {
    return fail('TERMINAL_STATE_VERIFY_FAILED', { expected: 'COMPLETED', got: persisted ? persisted.state : null });
  }
  return ok({ state: 'COMPLETED', delivery: v.value, telegramDispatch: term.telegramDispatch });
}

// ---- Issue #159: canonical review-only entrypoint -----------------------------
// adoptExistingPullRequestForReview drives an ALREADY-IMPLEMENTED task (its code
// is committed and a PR already exists OPEN at an exact head) through the FULL
// canonical ControlLoop review + delivery path WITHOUT dispatching an executor.
// It accepts ONLY identity + the immutable review target (repo, issueNumber,
// pullRequest, headSha) and the deps the loop needs (git/gh transports, reviews,
// verification, delivery, telegram); every mutable binding (prNumber, headSha,
// controlLoop, packet) is derived by the canonical primitives inside the loop.
// There is deliberately NO parameter that sets session state directly, and no
// executor is ever spawned on this path.
export async function adoptExistingPullRequestForReview({
  repo = CONTROL_LOOP_CANONICAL_REPO, issueNumber, pullRequest, headSha,
  stateDir = defaultStateDir(), deps = {},
} = {}) {
  if (typeof repo !== 'string' || repo.toLowerCase() !== CONTROL_LOOP_CANONICAL_REPO) return fail('FOREIGN_REPO', repo ?? null);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return fail('REVIEW_ONLY_ARGS_INVALID', 'issueNumber required');
  if (!Number.isInteger(pullRequest) || pullRequest <= 0) return fail('REVIEW_ONLY_ARGS_INVALID', 'pullRequest required (an existing PR must already be open)');
  if (typeof headSha !== 'string' || !HEAD_SHA_40.test(headSha)) return fail('REVIEW_ONLY_ARGS_INVALID', 'headSha must be the exact 40-hex PR head to review');
  const id = identityHash({ repo, issueNumber });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  const rs = readSessionByHash({ stateDir, identityHash: id });
  if (!rs.ok) return fail(rs.reason || 'SESSION_READ_FAILED', null);
  if (rs.session.repo !== CONTROL_LOOP_CANONICAL_REPO
    || rs.session.taskId !== `${CONTROL_LOOP_CANONICAL_REPO}#${rs.session.issueNumber}`) {
    return fail('IDENTITY_MISMATCH', `taskId=${rs.session.taskId} identityHash=${id}`);
  }
  return runControlLoop({
    sessionPath, identityHash: id, stateDir,
    deps: { ...deps, reviewOnly: { pullRequest, headSha: headSha.toLowerCase(), verification: deps.verification ?? null } },
  });
}
