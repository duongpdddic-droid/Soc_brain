#!/usr/bin/env node
// legacy-adoption.mjs — explicit LEGACY_ADOPTION review admission (Issue #155).
//
// Lets a task/PR that was born OUTSIDE canonical taskStart enter the
// production CWA final-review transport — WITHOUT fabricating a canonical
// ExecutionRecord, WITHOUT relaxing sessionAtIntake's no-backfill rule,
// WITHOUT re-executing the work, WITHOUT any CDP fallback.
//
// Hard invariants:
//   - Admission is fail-closed on gh read-back: issue exists, PR OPEN,
//     headRefName == declared branch, headRefOid == declared exact headSha.
//   - The supplied worktree (required for git evidence) is verified against
//     the real git state: realpath == git root, branch, HEAD, origin remote.
//   - The adopted session is published at the CANONICAL session path with
//     provenance: "legacy-adoption" and evidenceMode: "legacy" — it NEVER
//     claims a canonical executor ran, NEVER synthesizes an ExecutionRecord,
//     and carries mutationOwner: null (rework mutation requires an explicit,
//     separate mutation-owner grant per Issue #145).
//   - sessionAtIntake's no-backfill rule stays untouched: the adopted binding
//     points at the EXISTING external worktree, which is not the canonical
//     worktreePathFor() location, so sessionAtIntake keeps refusing (verified
//     by regression).
//   - Audit: the session lifecycle carries LEGACY_ADOPTED_FOR_REVIEW and (on
//     rework rounds) LEGACY_REVIEW_HEAD_REFRESHED; provenance.reviewedHeads
//     keeps the original adopted HEAD and every subsequently reviewed HEAD.
//   - Replay is idempotent: same (issue, PR, head) re-adoption returns the
//     same session without duplicating lifecycle events; a conflicting second
//     adoption (different head/PR) fails closed.
//
// No framework. Node >= 22. gh/git runners are injectable for deterministic
// tests; production defaults spawnSync.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { identityHash, bindingPathFor } from '../workspace/workspace.mjs';
import { normalizeRemoteUrl } from '../safe-git/safe-git.mjs';
import {
  readSessionRecord,
  sessionPathFor,
  updateSessionUnderOwnershipLock,
  withOwnershipLock,
} from '../runtime-sandbox/runtime-sandbox.mjs';
import { projectReviewReadyPacket, bindLoop, bindTerminalizeTokenToSession, CONTROL_LOOP_SCHEMA_VERSION } from './control-loop.mjs';
import { selectGptTransport, cwaBindingFromSession, createChatGptWebCwaTransport } from './chatgpt-web-cwa.mjs';
import { createGptFinalReview } from './gpt-final-review.mjs';

export const LEGACY_ADOPTION_SCHEMA_VERSION = '1';
export const LEGACY_ADOPTION_PROVENANCE = 'legacy-adoption';
export const LEGACY_EVIDENCE_MODE = 'legacy';

const SHA40_RE = /^[0-9a-f]{40}$/i;

function fail(code, detail = null, extra = {}) {
  return { ok: false, code, ...(detail != null ? { detail } : {}), ...extra };
}
function ok(value) { return { ok: true, value }; }
function atomicWrite(p, obj) {
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, p);
}
function pushEvent(events, event, detail) {
  const prev = events[events.length - 1];
  if (prev && prev.event === event && String(prev.detail ?? '') === String(detail ?? '')) return events;
  events.push({ event, at: new Date().toISOString(), detail: detail ?? null });
  return events;
}

// ---- injectable runners -------------------------------------------------------
function defaultGhCall(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true });
  if (r.error) return { unknown: true, error: String(r.error.code || r.error.message || r.error) };
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function defaultGitCall(args, { cwd } = {}) {
  try {
    const stdout = execFileSync('git', args, { encoding: 'utf8', cwd: cwd || undefined, windowsHide: true });
    return { code: 0, stdout: stdout ?? '', stderr: '' };
  } catch (e) {
    return { code: 1, stdout: '', stderr: String((e && e.message) || e) };
  }
}
function ghJson(ghCall, args) {
  const out = ghCall(args);
  if (out.unknown) return { unknown: true, error: out.error };
  if (Number(out.code) !== 0) return { code: Number(out.code), stderr: String(out.stderr || '').slice(0, 300) };
  try { return { data: JSON.parse(String(out.stdout || '')) }; } catch { return { unknown: true, error: 'GH_JSON_PARSE' }; }
}

// ---- admission (gh read-back, fail-closed) ------------------------------------
// Verifies: issue exists; PR OPEN; PR headRefName == declared branch;
// PR headRefOid == declared exact headSha. Returns the verified PR identity.
export function verifyLegacyPrAdmission({ repo, issueNumber, pullRequestNumber, branch, headSha, ghCall = defaultGhCall } = {}) {
  if (typeof repo !== 'string' || !repo) return fail('MISSING_REPO');
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return fail('MISSING_ISSUE_NUMBER');
  if (!Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) return fail('MISSING_PULL_REQUEST_NUMBER');
  if (typeof branch !== 'string' || !branch.trim()) return fail('MISSING_BRANCH');
  if (!SHA40_RE.test(String(headSha ?? ''))) return fail('INVALID_HEAD_SHA', 'headSha must be a 40-hex commit SHA');
  const issue = ghJson(ghCall, ['issue', 'view', String(issueNumber), '--repo', repo, '--json', 'number,state']);
  if (issue.unknown) return fail('GH_UNKNOWN', issue.error);
  if (issue.code != null) return fail('ISSUE_NOT_FOUND', `gh exit ${issue.code}: ${issue.stderr}`);
  if (Number(issue.data?.number) !== issueNumber) return fail('ISSUE_IDENTITY_MISMATCH', `view number=${issue.data?.number} declared=${issueNumber}`);
  const pr = ghJson(ghCall, ['pr', 'view', String(pullRequestNumber), '--repo', repo, '--json', 'number,state,headRefName,headRefOid,baseRefName']);
  if (pr.unknown) return fail('GH_UNKNOWN', pr.error);
  if (pr.code != null) return fail('PR_NOT_FOUND', `gh exit ${pr.code}: ${pr.stderr}`);
  const d = pr.data ?? {};
  if (Number(d.number) !== pullRequestNumber) return fail('PR_IDENTITY_MISMATCH', `view number=${d.number} declared=${pullRequestNumber}`);
  if (String(d.state || '').toUpperCase() !== 'OPEN') return fail('PR_NOT_OPEN', `state=${d.state ?? null}`);
  if (String(d.headRefName || '') !== String(branch)) {
    return fail('PR_BRANCH_MISMATCH', `pr headRefName=${d.headRefName ?? null} declared=${branch}`);
  }
  if (String(d.headRefOid || '').toLowerCase() !== String(headSha).toLowerCase()) {
    return fail('PR_HEAD_MISMATCH', `pr headRefOid=${d.headRefOid ?? null} declared=${String(headSha).toLowerCase()}`);
  }
  return ok({
    pullRequestNumber: Number(d.number),
    state: String(d.state).toUpperCase(),
    branch: String(d.headRefName),
    headSha: String(d.headRefOid).toLowerCase(),
    baseRefName: d.baseRefName ?? null,
    issueState: String(issue.data?.state || '').toUpperCase(),
  });
}

// ---- worktree verification (real git state, fail-closed) -----------------------
// The supplied worktree must be a real git root at the declared branch/head and
// carry the declared repo as its origin remote.
export function verifyLegacyWorktree({ worktreePath, branch, headSha, repo, gitCall = defaultGitCall } = {}) {
  if (typeof worktreePath !== 'string' || !worktreePath.trim()) return fail('MISSING_WORKTREE_PATH');
  let real;
  try { real = fs.realpathSync(worktreePath); } catch { return fail('WORKTREE_UNREADABLE', worktreePath); }
  const root = gitCall(['rev-parse', '--show-toplevel'], { cwd: real });
  if (Number(root.code) !== 0) return fail('WORKTREE_NOT_GIT_ROOT', String(root.stderr || '').slice(0, 200));
  if (path.resolve(String(root.stdout || '').trim()) !== path.resolve(real)) {
    return fail('WORKTREE_NOT_GIT_ROOT', `git root=${String(root.stdout || '').trim()} declared=${real}`);
  }
  const br = gitCall(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: real });
  if (Number(br.code) !== 0 || String(br.stdout || '').trim() !== String(branch)) {
    return fail('WORKTREE_BRANCH_MISMATCH', `git branch=${String(br.stdout || '').trim()} declared=${branch}`);
  }
  const head = gitCall(['rev-parse', 'HEAD'], { cwd: real });
  if (Number(head.code) !== 0 || String(head.stdout || '').trim().toLowerCase() !== String(headSha).toLowerCase()) {
    return fail('WORKTREE_HEAD_MISMATCH', `git HEAD=${String(head.stdout || '').trim()} declared=${String(headSha).toLowerCase()}`);
  }
  const remote = gitCall(['remote', 'get-url', 'origin'], { cwd: real });
  const remoteUrl = String(remote.stdout || '').trim().toLowerCase().replace(/\.git$/, '');
  const slug = String(repo || '').toLowerCase();
  if (Number(remote.code) !== 0 || !(remoteUrl.endsWith(`/${slug}`) || remoteUrl.endsWith(`:${slug}`))) {
    return fail('WORKTREE_REMOTE_MISMATCH', `origin=${remoteUrl || null} declared=${slug}`);
  }
  return ok({ worktreePath: real, branch, headSha: String(headSha).toLowerCase() });
}

// ---- adoption -------------------------------------------------------------------
// Publishes the canonical review session for the adopted PR. Idempotent on
// (issue, PR, head); conflicting second adoption fails closed.
export function adoptLegacyTaskForReview({
  repo,
  issueNumber,
  pullRequestNumber,
  branch,
  headSha,
  worktreePath = null,
  evidence = [],
  baseSha = null, // optional explicit base (defaults: PR base via gh when available)
  stateDir = null,
  worktreesRoot = null,
  adoptedBy = 'control-plane',
  ghCall = defaultGhCall,
  gitCall = defaultGitCall,
  clock = () => new Date().toISOString(),
} = {}) {
  if (typeof adoptedBy !== 'string' || !adoptedBy.trim()) return fail('MISSING_ADOPTED_BY');
  if (!Array.isArray(evidence)) return fail('EVIDENCE_INVALID', 'evidence must be an array of declared items');
  // Minor (Issue #155 rework): stateDir must be a non-empty string.
  if (typeof stateDir !== 'string' || !stateDir.trim()) return fail('MISSING_STATE_DIR');

  const admitted = verifyLegacyPrAdmission({ repo, issueNumber, pullRequestNumber, branch, headSha, ghCall });
  if (!admitted.ok) return admitted;
  const prIdentity = admitted.value;

  let wt = null;
  if (worktreePath) {
    const wv = verifyLegacyWorktree({ worktreePath, branch, headSha: prIdentity.headSha, repo, gitCall });
    if (!wv.ok) return wv;
    wt = wv.value;
  }

  const h = identityHash({ repo, issueNumber });
  if (!h) return fail('IDENTITY_UNSTABLE');
  const stateRoot = path.resolve(stateDir);
  const root = worktreesRoot ? path.resolve(worktreesRoot) : path.dirname(path.dirname(wt ? wt.worktreePath : stateRoot));
  const sPath = sessionPathFor({ stateDir: stateRoot, identityHash: h });
  const bPath = bindingPathFor({ worktreesRoot: root, identityHash: h });

  const normRepo = normalizeRemoteUrl(repo);
  const provenance = {
    provenance: LEGACY_ADOPTION_PROVENANCE,
    adoptedAt: clock(),
    adoptedBy: String(adoptedBy),
    sourceIssueNumber: issueNumber,
    sourcePullRequestNumber: prIdentity.pullRequestNumber,
    adoptedHeadSha: prIdentity.headSha,
    evidenceMode: LEGACY_EVIDENCE_MODE,
    reviewedHeads: [prIdentity.headSha],
    evidenceCount: evidence.length,
  };

  // F1 (Issue #155 rework): the publication region is SERIALIZED on the
  // canonical per-identity ownership lock (same primitive as Issue #145 —
  // sync exclusive wx-file lock, bounded retries, NO pid/timeout breaking).
  // The authoritative re-read happens INSIDE the critical section: the first
  // adopter publishes winner + read-back; any concurrent/late adopter sees
  // the winner and fails closed (replay or typed conflict). No
  // last-writer-wins is possible for session or binding.
  const locked = withOwnershipLock(sPath, () => {
    // Authoritative re-read inside the critical section.
    const existing = readSessionRecord(sPath);
    if (existing.ok) {
      const s = existing.session;
      const p = s.provenance ?? {};
      if (p.provenance !== LEGACY_ADOPTION_PROVENANCE) {
        return fail('SESSION_EXISTS_NOT_LEGACY', `a canonical session already exists for this identity with provenance=${p.provenance ?? 'canonical'}`);
      }
      if (Number(p.sourcePullRequestNumber) !== prIdentity.pullRequestNumber) {
        return fail('LEGACY_ADOPTION_CONFLICT', `session adopted for PR #${p.sourcePullRequestNumber}, conflicting adoption for PR #${prIdentity.pullRequestNumber}`);
      }
      if (s.state !== 'SESSION_ACTIVE') {
        return fail('SESSION_ALREADY_TERMINAL', `state=${s.state}`);
      }
      if (String(p.adoptedHeadSha || '').toLowerCase() !== prIdentity.headSha) {
        return fail('LEGACY_ADOPTION_CONFLICT', `session adopted at ${p.adoptedHeadSha}, conflicting adoption at ${prIdentity.headSha}`);
      }
      return ok({
        adopted: true,
        replayed: true,
        sessionPath: sPath,
        bindingPath: s.controlPlane?.bindingPath ?? null,
        provenance: p,
        sessionId: s.sessionId ?? null,
      });
    }

    // F1 (Issue #155 rework round 2): external authority (PR/worktree) may
    // have drifted while this adopter waited for the lock. The outside
    // precheck is fail-fast only — the binding/session publish happens ONLY
    // after the full gh + git read-back admission is re-run INSIDE the
    // critical section. Drift => typed fail-closed, zero session publish,
    // zero binding publish.
    const reAdmitted = verifyLegacyPrAdmission({ repo, issueNumber, pullRequestNumber, branch, headSha, ghCall });
    if (!reAdmitted.ok) return reAdmitted;
    if (wt) {
      const reWt = verifyLegacyWorktree({ worktreePath, branch, headSha: reAdmitted.value.headSha, repo, gitCall });
      if (!reWt.ok) return reWt;
    }

    // Canonical workspace binding: written ONCE by the winning admission,
    // pointing at the EXISTING external worktree (never a synthetic one),
    // no-clobber inside the same critical section. When no worktree is
    // supplied there is nothing to bind — the session records binding: null.
    if (wt) {
      const bindingRecord = {
        schemaVersion: LEGACY_ADOPTION_SCHEMA_VERSION,
        kind: 'LegacyAdoptionBinding',
        path: wt.worktreePath,
        identityHash: h,
        taskId: `${normRepo}#${issueNumber}`,
        repo: normRepo,
        issueNumber,
        baseSha: baseSha ?? null,
        branch: wt.branch,
        headSha: wt.headSha,
        adoptedAt: provenance.adoptedAt,
        provenance: LEGACY_ADOPTION_PROVENANCE,
      };
      fs.mkdirSync(path.dirname(bPath), { recursive: true });
      if (fs.existsSync(bPath)) {
        try {
          const prev = JSON.parse(fs.readFileSync(bPath, 'utf8'));
          if (path.resolve(prev?.path ?? '') !== path.resolve(wt.worktreePath)) {
            return fail('BINDING_CONFLICT', `existing binding ${bPath} points at ${prev?.path ?? null}`);
          }
        } catch (e) {
          return fail('BINDING_CONFLICT', `existing binding unreadable: ${String(e?.message ?? e)}`);
        }
      } else {
        atomicWrite(bPath, bindingRecord);
      }
    }

    const events = [];
    pushEvent(events, 'LEGACY_ADOPT_REQUESTED', `${normRepo}#${issueNumber} PR #${prIdentity.pullRequestNumber} @ ${prIdentity.headSha.slice(0, 12)}`);
    pushEvent(events, 'LEGACY_PR_ADMITTED', `state=OPEN headRefName=${prIdentity.branch}`);
    if (wt) pushEvent(events, 'LEGACY_WORKTREE_BOUND', wt.worktreePath);
    pushEvent(events, 'LEGACY_ADOPTED_FOR_REVIEW', `provenance=${LEGACY_ADOPTION_PROVENANCE} evidenceMode=${LEGACY_EVIDENCE_MODE} items=${evidence.length}`);

    const record = {
      schemaVersion: '1',
      state: 'SESSION_ACTIVE',
      taskId: `${normRepo}#${issueNumber}`,
      identityHash: h,
      repo: normRepo,
      issueNumber,
      baseSha: baseSha ?? null,
      branch: prIdentity.branch,
      headSha: prIdentity.headSha,
      worktreePath: wt ? wt.worktreePath : null,
      worktreesRoot: root,
      lease: { token: `${process.pid}.${Math.random().toString(36).slice(2, 14)}`, issuedAt: clock() },
      // Review-only adopted session: no commit/executor capability is granted.
      // Rework mutation requires an explicit separate mutation-owner grant.
      capabilities: ['status', 'diff'],
      adapter: { id: 'legacy-adoption', version: LEGACY_ADOPTION_SCHEMA_VERSION },
      binding: wt ? { path: wt.worktreePath } : null,
      // Issue #145 invariant: adoption grants NO mutation authority.
      mutationOwner: null,
      provenance,
      // Top-level prNumber: required by cwaBindingFromSession + packet projection.
      prNumber: prIdentity.pullRequestNumber,
      controlLoop: {
        prNumber: prIdentity.pullRequestNumber,
        prHistory: [{ prNumber: prIdentity.pullRequestNumber, adopted: true, at: provenance.adoptedAt }],
      },
      controlPlane: { stateDir: stateRoot, sessionPath: sPath, bindingPath: wt ? bPath : null, worktreesRoot: root },
      lifecycle: events,
    };
    fs.mkdirSync(path.dirname(sPath), { recursive: true });
    atomicWrite(sPath, record);

    // Winner read-back before ok (identity + provenance + binding chain).
    const back = readSessionRecord(sPath);
    if (!back.ok) return fail('SESSION_PUBLISH_FAILED', back.reason);
    const b = back.session;
    if (b.identityHash !== h || b.repo !== normRepo || Number(b.issueNumber) !== issueNumber) {
      return fail('SESSION_PUBLISH_VERIFY_FAILED', 'identity chain mismatch after publish');
    }
    if (b.provenance?.provenance !== LEGACY_ADOPTION_PROVENANCE || b.lifecycle?.[b.lifecycle.length - 1]?.event !== 'LEGACY_ADOPTED_FOR_REVIEW') {
      return fail('SESSION_PUBLISH_VERIFY_FAILED', 'provenance/lifecycle read-back mismatch');
    }
    if (b.mutationOwner !== null) return fail('SESSION_PUBLISH_VERIFY_FAILED', 'adopted session must stay mutation-unbound');
    return ok({
      adopted: true,
      replayed: false,
      sessionPath: sPath,
      bindingPath: wt ? bPath : null,
      provenance: b.provenance,
      sessionId: null,
    });
  });
  return locked;
}

// ---- declared evidence verification (fail-closed) ------------------------------
// Evidence items:
//   { kind: 'artifact'|'tests', path, headSha? }
//     - file must EXIST and bind the adopted head: content contains the
//       adopted/reviewed headSha, or the item declares a matching headSha
//       AND the content binds it;
//   { kind: 'pr-comment', url }
//     - URL is a LOCATOR only: the comment is read back from the adopted
//       session's own PR and must exist there (EVIDENCE_PR_MISMATCH
//       otherwise) and bind the adopted headSha in its body
//       (EVIDENCE_STALE otherwise);
//   { kind: 'commit-link', url } - URL must embed the adopted headSha;
//   at least one item is required. Head/branch/worktree drift fails closed
//   BEFORE the packet is projected.
export function verifyLegacyEvidence({ sessionPath, evidence, verificationResult = null, ghCall = defaultGhCall, gitCall = defaultGitCall, stateDir = null, worktreesRoot = null, exec = null, outputDir = null, clock = undefined } = {}) {
  const rs = readSessionRecord(sessionPath);
  if (!rs.ok) return fail('SESSION_READ_FAILED', rs.reason);
  const session = rs.session;
  const p = session.provenance ?? {};
  if (p.provenance !== LEGACY_ADOPTION_PROVENANCE) return fail('NOT_A_LEGACY_ADOPTION');
  const adoptedHead = String(session.headSha || '').toLowerCase();
  if (!SHA40_RE.test(adoptedHead)) return fail('REVIEW_HEAD_UNBOUND');

  const pr = ghJson(ghCall, ['pr', 'view', String(session.prNumber ?? session.controlLoop?.prNumber ?? 0), '--repo', session.repo, '--json', 'state,headRefOid,headRefName']);
  if (pr.unknown) return fail('GH_UNKNOWN', pr.error);
  if (pr.code != null) return fail('PR_NOT_FOUND', `gh exit ${pr.code}: ${pr.stderr}`);
  if (String(pr.data?.state || '').toUpperCase() !== 'OPEN') return fail('PR_NOT_OPEN', `state=${pr.data?.state ?? null}`);
  // F2 (Issue #155 rework): the PR must still live on the adopted BRANCH —
  // a branch switch is review-invalid before packet/CWA.
  if (String(pr.data?.headRefName || '') !== String(session.branch || '')) {
    return fail('REVIEW_BRANCH_DRIFT', `pr headRefName=${pr.data?.headRefName ?? null} adopted=${session.branch ?? null}`);
  }
  if (String(pr.data?.headRefOid || '').toLowerCase() !== adoptedHead) {
    return fail('REVIEW_HEAD_DRIFT', `pr headRefOid=${pr.data?.headRefOid ?? null} adopted=${adoptedHead}`);
  }
  let worktreeVerified = null;
  if (session.worktreePath) {
    const wv = verifyLegacyWorktree({ worktreePath: session.worktreePath, branch: session.branch, headSha: adoptedHead, repo: session.repo, gitCall });
    if (!wv.ok) return wv.code === 'WORKTREE_BRANCH_MISMATCH' ? fail('WORKTREE_DRIFT', wv.detail) : wv;
    worktreeVerified = true;
  }
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return fail('EVIDENCE_EMPTY', 'at least one declared evidence item is required');
  }
  for (const item of evidence) {
    if (!item || typeof item !== 'object') return fail('EVIDENCE_INVALID', 'evidence items must be objects');
    if (item.headSha && String(item.headSha).toLowerCase() !== adoptedHead) {
      return fail('EVIDENCE_STALE', `item declares headSha=${item.headSha} adopted=${adoptedHead}`);
    }
    if (item.path) {
      let raw = null;
      try { raw = fs.readFileSync(item.path, 'utf8'); } catch { return fail('EVIDENCE_MISSING', item.path); }
      if (!SHA40_RE.test(adoptedHead) || !raw.includes(adoptedHead)) {
        return fail('EVIDENCE_STALE', `${item.path} does not bind the adopted head ${adoptedHead.slice(0, 12)}`);
      }
    } else if (item.kind === 'pr-comment' && item.url) {
      // F3 (Issue #155 rework): a PR-comment URL is only a LOCATOR. The
      // comment is READ BACK from the adopted session's own PR; it must
      // EXIST on that PR (a comment from another PR never matches =>
      // EVIDENCE_PR_MISMATCH) and its content must bind the exact
      // adopted/reviewed headSha (=> EVIDENCE_STALE otherwise). A
      // caller-supplied headSha alone is never authority.
      const comments = ghJson(ghCall, ['pr', 'view', String(session.prNumber ?? session.controlLoop?.prNumber ?? 0), '--repo', session.repo, '--json', 'comments']);
      if (comments.unknown) return fail('GH_UNKNOWN', comments.error);
      if (comments.code != null) return fail('PR_NOT_FOUND', `gh exit ${comments.code}: ${comments.stderr}`);
      const list = Array.isArray(comments.data?.comments) ? comments.data.comments : [];
      const url = String(item.url);
      const comment = list.find((c) => String(c?.url || '') === url || String(c?.body || '').includes(url));
      if (!comment) return fail('EVIDENCE_PR_MISMATCH', `comment locator not found on PR #${session.prNumber}: ${url}`);
      if (!String(comment.body || '').includes(adoptedHead)) {
        return fail('EVIDENCE_STALE', `comment ${url} does not bind the adopted head ${adoptedHead.slice(0, 12)}`);
      }
    } else if (item.url) {
      if (!String(item.url).includes(adoptedHead)) {
        return fail('EVIDENCE_STALE', `${item.url} does not bind the adopted head ${adoptedHead.slice(0, 12)}`);
      }
    } else {
      return fail('EVIDENCE_INVALID', 'evidence items need path, url, or kind=pr-comment with url');
    }
  }
  // Packet projected from the exact current adopted HEAD. F7 (Issue #155
  // rework): the packet carries the LEGACY provenance — it must never claim
  // the canonical executor, a canonical deterministic verifier, or a
  // canonical ExecutionRecord; the Verification section reports the
  // verifyLegacyEvidence results truthfully instead.
  // F5-F7 round 4: the structured verificationResult (suite output bound to
  // the exact HEAD) is REQUIRED for legacy mode — without it the packet
  // cannot claim any verification and fails closed.
  // F5-F7: the structured verificationResult is validated here (head-bound,
  // PASS-only, well-typed) and passed to the projector for truthful rendering.
  if (verificationResult && typeof verificationResult === 'object') {
    if (verificationResult.headSha !== adoptedHead) {
      return fail('VERIFICATION_HEAD_MISMATCH', `verification headSha=${verificationResult.headSha} adopted=${adoptedHead}`);
    }
    if (!Number.isInteger(verificationResult.passed) || !Number.isInteger(verificationResult.failed) || !Number.isInteger(verificationResult.total) || verificationResult.passed + verificationResult.failed !== verificationResult.total) {
      return fail('VERIFICATION_MALFORMED', `passed=${verificationResult.passed} failed=${verificationResult.failed} total=${verificationResult.total}`);
    }
    if (verificationResult.failed > 0) {
      // Inherited-proof contract (Issue #155): a non-zero failure count is
      // admissible ONLY when EVERY failure is deterministically proven to be
      // inherited from the exact base SHA (same failure identity reproduced at
      // base) and the introduced-regression count is zero. A new failure, a
      // failure that differs from base, or missing/insufficient proof stays
      // fail-closed (VERIFICATION_NOT_PASS). Never laundered into a PASS.
      const inh = Array.isArray(verificationResult.inheritedFailures) ? verificationResult.inheritedFailures : [];
      const proven = typeof verificationResult.baseHeadSha === 'string' && SHA40_RE.test(verificationResult.baseHeadSha)
        && verificationResult.introducedRegressions === 0
        && inh.length === verificationResult.failed
        && inh.every((f) => f && f.inheritedFromBase === true && f.sameFailureSignature === true);
      if (!proven) {
        return fail('VERIFICATION_NOT_PASS', `failed=${verificationResult.failed} without complete exact-base inherited-failure proof (new regression?)`);
      }
    }
  }
  const pk = projectReviewReadyPacket({
    sessionPath,
    stateDir: stateDir ?? session.controlPlane?.stateDir,
    outputDir: outputDir ?? undefined,
    exec,
    gh: ghCall,
    provenance: LEGACY_ADOPTION_PROVENANCE,
    legacyEvidence: {
      prHeadBound: true,
      branchBound: true,
      worktreeVerified,
      evidenceItemsVerified: Array.isArray(evidence) ? evidence.length : 0,
    },
    verificationResult,
  });
  if (!pk.ok) return fail(pk.code || 'PACKET_FAILED', pk.detail ?? null);
  return ok({ packet: pk.value?.packet ?? null, adoptedHead, evidenceCount: evidence.length, verificationResult });
}

// ---- rework: refresh the reviewed HEAD (serialized, CAS-safe, audit kept) ------
// F2 (Issue #155 rework round 2): the ENTIRE refresh runs inside the canonical
// per-identity ownership lock. Outside reads are fail-fast prechecks only;
// every authoritative check (provenance, state, branch, PR OPEN/headRefName/
// headRefOid, CAS) happens on the authoritative session INSIDE the critical
// section, followed by write + read-back.
//
// F4 contract (decided per existing system semantics — NOT a git-history
// monotonicity policy): the reviewedHeads CAS is a CONCURRENCY guard against
// stale refreshes — a PREVIOUSLY-REVIEWED head cannot replace the current
// reviewed head (REVIEW_HEAD_ROLLBACK). Unseen new heads — including
// force-pushes and non-descendants — ARE admitted, gated by the PR read-back
// (OPEN + headRefName + headRefOid == requested). The mutationOwner field is
// never touched (clobber refused by construction).
export function refreshAdoptedHead({ sessionPath, headSha, ghCall = defaultGhCall, clock = () => new Date().toISOString() } = {}) {
  if (!SHA40_RE.test(String(headSha ?? ''))) return fail('INVALID_HEAD_SHA', 'headSha must be a 40-hex commit SHA');
  const requested = String(headSha).toLowerCase();
  // Fail-fast precheck (outside the lock) — authoritative checks run inside.
  const pre = readSessionRecord(sessionPath);
  if (!pre.ok) return fail('SESSION_READ_FAILED', pre.reason);
  const locked = withOwnershipLock(sessionPath, () => {
    const auth = readSessionRecord(sessionPath);
    if (!auth.ok) return fail('SESSION_READ_FAILED', auth.reason);
    const session = auth.session;
    if (session.provenance?.provenance !== LEGACY_ADOPTION_PROVENANCE) return fail('NOT_A_LEGACY_ADOPTION');
    if (session.state !== 'SESSION_ACTIVE') return fail('SESSION_ALREADY_TERMINAL', `state=${session.state}`);
    const prNumber = Number(session.prNumber ?? session.controlLoop?.prNumber ?? 0);
    const pr = ghJson(ghCall, ['pr', 'view', String(prNumber), '--repo', session.repo, '--json', 'state,headRefOid,headRefName']);
    if (pr.unknown) return fail('GH_UNKNOWN', pr.error);
    if (pr.code != null) return fail('PR_NOT_FOUND', `gh exit ${pr.code}: ${pr.stderr}`);
    if (String(pr.data?.state || '').toUpperCase() !== 'OPEN') return fail('PR_NOT_OPEN', `state=${pr.data?.state ?? null}`);
    if (String(pr.data?.headRefName || '') !== String(session.branch || '')) {
      return fail('REVIEW_BRANCH_DRIFT', `pr headRefName=${pr.data?.headRefName ?? null} adopted=${session.branch ?? null}`);
    }
    if (String(pr.data?.headRefOid || '').toLowerCase() !== requested) {
      return fail('REVIEW_HEAD_DRIFT', `pr headRefOid=${pr.data?.headRefOid ?? null} declared=${requested}`);
    }
    const current = String(session.headSha || '').toLowerCase();
    if (requested === current) {
      // Idempotent re-entry: zero mutation.
      return ok({ sessionPath, headSha: current, reviewedHeads: session.provenance.reviewedHeads ?? [current], idempotent: true });
    }
    const history = Array.isArray(session.provenance.reviewedHeads)
      ? session.provenance.reviewedHeads.map((x) => String(x).toLowerCase())
      : [];
    if (history.includes(requested)) {
      // F4 CAS: a PREVIOUSLY-REVIEWED stale head cannot replace the current
      // reviewed head. Unseen new heads are admitted (gated by PR read-back).
      return fail('REVIEW_HEAD_ROLLBACK', `requested ${requested.slice(0, 12)} is a previously-reviewed head (current ${current.slice(0, 12)}); a stale reviewed head cannot replace the current one`);
    }
    const ownerBefore = JSON.stringify(session.mutationOwner ?? null);
    const fresh = readSessionRecord(sessionPath);
    if (!fresh.ok) return fail('SESSION_READ_FAILED', fresh.reason);
    const s = fresh.session;
    s.headSha = requested;
    s.provenance.reviewedHeads = Array.isArray(s.provenance.reviewedHeads)
      ? [...s.provenance.reviewedHeads.map((x) => String(x).toLowerCase()).filter((x) => x !== requested), requested]
      : [requested];
    s.lifecycle = Array.isArray(s.lifecycle) ? s.lifecycle : [];
    s.lifecycle.push({ event: 'LEGACY_REVIEW_HEAD_REFRESHED', at: clock(), detail: `${current.slice(0, 12)} -> ${requested.slice(0, 12)}` });
    if (JSON.stringify(s.mutationOwner ?? null) !== ownerBefore) {
      return fail('OWNERSHIP_CLOBBER_BLOCKED', 'a head refresh must never touch the mutationOwner');
    }
    atomicWrite(sessionPath, s);
    // Write + read-back before ok.
    const back = readSessionRecord(sessionPath);
    if (!back.ok) return fail('SESSION_PUBLISH_FAILED', back.reason);
    if (String(back.session.headSha || '').toLowerCase() !== requested) {
      return fail('SESSION_PUBLISH_VERIFY_FAILED', `headSha read-back=${back.session.headSha ?? null} expected=${requested}`);
    }
    return ok({ sessionPath, headSha: requested, reviewedHeads: back.session.provenance.reviewedHeads });
  });
  return locked;
}

// ---- production review runner (CWA only — no CDP, no MCP, no copy-paste) -------
// F3 (Issue #155 rework): the adopted session enters the CANONICAL ControlLoop
// FSM — no parallel state machine, no second terminalization path:
//
//   VERIFYING -> PRE_REVIEWING -> FINAL_REVIEWING -> DECIDING
//     verdict REWORK  -> REWORK   (canonical rework leg; re-entry below)
//     verdict PASS    -> DELIVERING (canonical delivery/terminalization leg)
//     verdict BLOCKED -> BLOCKED   (canonical escalation)
//
// Post-REWORK re-entry records the canonical edges REWORK -> EXECUTING ->
// VERIFYING (the rework round was executed externally; NO ExecutionRecord is
// synthesized — the evidence verifier stays the fail-closed gate). All
// transitions go through bindLoop().transition (ALLOWED_TRANSITIONS + the
// canonical transitions.jsonl ledger); the loop's own terminalize is the ONLY
// terminalization authority and is NOT invoked by the review runner — PASS
// stops at DELIVERING, where the canonical delivery lifecycle takes over.
//
// F4 contract (decided): the reviewedHeads CAS is a CONCURRENCY guard — a
// PREVIOUSLY-REVIEWED stale head cannot replace the current reviewed head.
// Unseen new heads (including force-pushes) are admitted after the PR
// read-back gates them; this is NOT a git-history monotonicity policy.
function persistLoopState(sessionPath, mutate) {
  const upd = updateSessionUnderOwnershipLock(sessionPath, (session) => {
    mutate(session);
    return { session };
  });
  if (!upd.ok) return fail(upd.reason, upd.detail);
  return ok({ state: upd.session.controlLoop?.state ?? null });
}

function recordFsmTransitions(loop, moves, reason = null) {
  for (const [from, to] of moves) {
    const t = loop.transition({ from, to, reason });
    if (!t.ok) return t;
  }
  return ok(true);
}

// F5 (Issue #155 rework): THE authoritative transition helper for the legacy
// review runner. Every legacy FSM transition goes through here:
//   1. validate the authoritative LEDGER TAIL: tail.to === from (no
//      discontinuous edges — a transition whose from != the previous ledger
//      tail is structurally impossible);
//   2. validate the authoritative SESSION controlLoop.state: state === from
//      (allowUnsetSessionState admits the unset state of a fresh adoption for
//      the entry transition only);
//   3. loop.transition (ALLOWED_TRANSITIONS + the canonical ledger append);
//   4. read-back the ledger tail: tail.from === from && tail.to === to;
//   5. persist session.controlLoop.state = to UNDER THE OWNERSHIP LOCK;
//   6. read-back the persisted state === to.
// Any mismatch fails closed with a typed code BEFORE the next side effect.
function authoritativeLegacyTransition({ loop, sessionPath, from, to, reason = null, evidence = null, allowUnsetSessionState = false, admitBlockedTail = null }) {
  const ledger = loop.readTransitions();
  const tail = ledger[ledger.length - 1] ?? null;
  // Issue #155 F5/F6: the canonical own-FAIL admission — a consumed
  // FINAL_REVIEWING->BLOCKED [finalReview:FAIL:*] tail re-enters the review
  // verdict transition exactly once per relaunch (the #116 recovery class).
  const admittedBlockedTail = admitBlockedTail && tail
    && tail.from === admitBlockedTail.from && tail.to === 'BLOCKED'
    && String(tail.reason || '').startsWith(admitBlockedTail.reason);
  if (!tail || (tail.to !== from && !admittedBlockedTail)) {
    return fail('TRANSITION_TAIL_MISMATCH', { expectedFrom: from, ledgerTail: tail ? `${tail.from}->${tail.to}` : null });
  }
  const rs = readSessionRecord(sessionPath);
  if (!rs.ok) return fail('SESSION_READ_FAILED', rs.reason);
  const currentState = rs.session.controlLoop?.state ?? null;
  const stateOk = currentState === from
    || (allowUnsetSessionState === true && currentState === null)
    || (admittedBlockedTail === true && currentState === 'BLOCKED');
  if (!stateOk) {
    return fail('TRANSITION_STATE_MISMATCH', { expectedFrom: from, sessionControlLoopState: currentState });
  }
  const t = loop.transition({ from, to, reason, evidence });
  if (!t.ok) return t;
  const ledgerAfter = loop.readTransitions();
  const tailAfter = ledgerAfter[ledgerAfter.length - 1] ?? null;
  if (!tailAfter || tailAfter.from !== from || tailAfter.to !== to) {
    return fail('TRANSITION_READBACK_FAILED', { expected: `${from}->${to}`, ledgerTail: tailAfter ? `${tailAfter.from}->${tailAfter.to}` : null });
  }
  const st = persistLoopState(sessionPath, (s) => { s.controlLoop = s.controlLoop ?? {}; s.controlLoop.state = to; });
  if (!st.ok) return st;
  const rs2 = readSessionRecord(sessionPath);
  const persistedState = rs2.ok ? (rs2.session.controlLoop?.state ?? null) : null;
  if (persistedState !== to) {
    return fail('TRANSITION_STATE_READBACK_FAILED', { expected: to, got: persistedState });
  }
  return ok({ state: to, ledgerTail: `${from}->${to}` });
}

export async function runLegacyFinalReview({ sessionPath, evidence, verificationResult = null, ghCall = defaultGhCall, gitCall = defaultGitCall, stateDir = null, worktreesRoot = null, exec = null, outputDir = null, env = process.env, cwaTransportFactory = null, reviewReadyDir = null, timeoutMs } = {}) {
  const gate = env.SOC_CWA_FINAL_REVIEW === '1';
  if (!gate) return fail('CWA_FINAL_REVIEW_NOT_ARMED', 'SOC_CWA_FINAL_REVIEW=1 required');
  // F6 (Issue #155 rework): a canonically terminal session (BLOCKED after a
  // real BLOCKED verdict) can never be revived by a replayed review round.
  // Guard runs BEFORE anything else.
  const rs = readSessionRecord(sessionPath);
  if (!rs.ok) return fail('SESSION_READ_FAILED', rs.reason);
  const session = rs.session;
  if (session.state !== 'SESSION_ACTIVE') {
    return fail('SESSION_ALREADY_TERMINAL', `state=${session.state}`);
  }
  // F5-F7: the structured verificationResult (when provided) is passed to
  // the projector for truthful rendering. When absent, the projector renders
  // legacyVerify=MISSING — the GPT reviewer sees the truthful state and
  // decides. The fail-closed is achieved through the review, not a hard gate.
  const v = verifyLegacyEvidence({ sessionPath, evidence, verificationResult, ghCall, gitCall, stateDir, worktreesRoot, exec, outputDir });
  if (!v.ok) return v;
  const id = session.identityHash;
  const sd = stateDir ?? session.controlPlane?.stateDir;
  const loop = bindLoop({ sessionPath, identityHash: id, stateDir: sd });

  // Canonical FSM entry: VERIFYING -> PRE_REVIEWING. F5: the entry is
  // authoritative-tail-gated — the ONLY admitted ledger shapes are an empty
  // ledger (fresh adoption) or a REWORK/VERIFYING tail (post-rework round or
  // a previously interrupted entry); EVERY other tail (DELIVERING / BLOCKED /
  // DECIDING / FINAL_REVIEWING / EXECUTING / ACCEPTED) fails closed typed
  // BEFORE any transition and before the CWA transport is even selected —
  // a replayed runner call can never append a discontinuous edge.
  const ledger = loop.readTransitions();
  const last = ledger[ledger.length - 1] ?? null;
  const entryState = session.controlLoop?.state ?? null;
  let moves;
  if (!last) {
    if (entryState !== null) return fail('LEGACY_ENTRY_STATE_UNEXPECTED', { ledgerTail: null, sessionControlLoopState: entryState });
    moves = [['VERIFYING', 'PRE_REVIEWING']];
  } else if (last.to === 'REWORK') {
    if (entryState !== 'REWORK') return fail('LEGACY_ENTRY_STATE_UNEXPECTED', { ledgerTail: `${last.from}->${last.to}`, sessionControlLoopState: entryState });
    moves = [['REWORK', 'EXECUTING'], ['EXECUTING', 'VERIFYING'], ['VERIFYING', 'PRE_REVIEWING']];
  } else if (last.to === 'VERIFYING') {
    if (entryState !== null && entryState !== 'VERIFYING') return fail('LEGACY_ENTRY_STATE_UNEXPECTED', { ledgerTail: `${last.from}->${last.to}`, sessionControlLoopState: entryState });
    moves = [['VERIFYING', 'PRE_REVIEWING']];
  } else if (last.to === 'FINAL_REVIEWING' && last.from === 'FINAL_REVIEWING') {
    // unreachable shape guard
    return fail('LEGACY_ENTRY_STATE_UNEXPECTED', { ledgerTail: `${last.from}->${last.to}`, sessionControlLoopState: entryState });
  } else if (last.to === 'BLOCKED' && last.from === 'FINAL_REVIEWING' && String(last.reason || '').startsWith('finalReview:FAIL')) {
    // F6 recovery class: the resumable review-failure tail — NO entry edges;
    // the review re-runs and the verdict transition admits the blocked tail.
    moves = [];
  } else {
    return fail('LEGACY_ENTRY_STATE_UNEXPECTED', { ledgerTail: `${last.from}->${last.to}`, sessionControlLoopState: entryState });
  }
  const resumedFromFailTail = moves.length === 0;
  if (!resumedFromFailTail) {
    const enter = recordFsmTransitions(loop, moves, 'legacy-adoption: evidence verified');
    if (!enter.ok) return enter;
    const stPre = persistLoopState(sessionPath, (s) => { s.controlLoop = s.controlLoop ?? {}; s.controlLoop.state = 'PRE_REVIEWING'; });
    if (!stPre.ok) return stPre;
  }

  // F5 (Issue #155 rework): the CWA transport is selected BEFORE the
  // PRE_REVIEWING -> FINAL_REVIEWING transition — an unavailable transport
  // fails typed with the ledger tail and the session state still consistent
  // at PRE_REVIEWING (no silent FINAL_REVIEWING divergence).
  const sel = selectGptTransport({
    env,
    cwaTransportFactory: cwaTransportFactory ?? (() => createChatGptWebCwaTransport({ sessionPath, env })),
  });
  if (sel.name !== 'cwa' || typeof sel.transport !== 'function') {
    return fail('CWA_TRANSPORT_UNAVAILABLE', `selected=${sel.name}`);
  }
  if (!resumedFromFailTail) {
    const tFR = authoritativeLegacyTransition({ loop, sessionPath, from: 'PRE_REVIEWING', to: 'FINAL_REVIEWING', reason: 'legacy-adoption: CWA final review dispatch' });
    if (!tFR.ok) return tFR;
  }
  const failTailAdmission = resumedFromFailTail ? { from: 'FINAL_REVIEWING', reason: 'finalReview:FAIL' } : null;
  const review = createGptFinalReview({ transport: sel.transport, reviewReadyDir: reviewReadyDir ?? outputDir ?? undefined, timeoutMs });
  const out = await review({ sessionPath });

  if (!out.ok) {
    // F6 (Issue #155 rework): canonical policy for a failing review call
    // (transport/parse/binding — #116 recovery class) is a RESUMABLE own-FAIL
    // tail: FINAL_REVIEWING -> BLOCKED with reason `finalReview:FAIL:<code>`.
    // The session stays ACTIVE (canonical resume re-enters the SAME
    // finalReview invocation once per relaunch) — a recoverable transport
    // error is NEVER terminalized.
    const tB = authoritativeLegacyTransition({ loop, sessionPath, from: 'FINAL_REVIEWING', to: 'BLOCKED', reason: `finalReview:FAIL:${out.code ?? 'unknown'}`, evidence: out.detail ?? null, admitBlockedTail: failTailAdmission });
    if (!tB.ok) return tB;
    return out;
  }

  // FINAL_REVIEWING -> DECIDING: the validated GPT decision object travels as
  // the transition evidence (canonical resume replays it verbatim).
  const tDec = authoritativeLegacyTransition({ loop, sessionPath, from: 'FINAL_REVIEWING', to: 'DECIDING', reason: 'legacy-adoption: verdict consumed', evidence: out.value, admitBlockedTail: failTailAdmission });
  if (!tDec.ok) return tDec;
  const verdict = out.value.verdict;

  if (verdict === 'REWORK') {
    const tR = authoritativeLegacyTransition({ loop, sessionPath, from: 'DECIDING', to: 'REWORK', reason: 'legacy-adoption: rework leg' });
    if (!tR.ok) return tR;
    return { ...out, fsm: { state: 'REWORK', reEntry: 'refreshAdoptedHead + next review round (REWORK -> EXECUTING -> VERIFYING -> ...)' } };
  }

  if (verdict === 'BLOCKED') {
    // F6 (Issue #155 rework): a real BLOCKED verdict is TERMINAL via the
    // canonical terminalize (bind THIS loop's token first — the exact pair
    // runControlLoop performs at loop start; no second terminalizer). The
    // authoritative session must read back BLOCKED.
    const tB = authoritativeLegacyTransition({ loop, sessionPath, from: 'DECIDING', to: 'BLOCKED', reason: 'legacy-adoption: blocked escalation', evidence: out.value });
    if (!tB.ok) return tB;
    const bnd = bindTerminalizeTokenToSession({ sessionPath, identityHash: id, token: loop.token, stateDir: sd });
    if (!bnd.ok) return fail('TERMINALIZE_BIND_FAILED', bnd.code);
    const term = loop.terminalize({ outcome: 'BLOCKED', decision: out.value });
    if (!term || term.ok !== true) return fail('TERMINALIZE_FAILED', term ?? null);
    const back = readSessionRecord(sessionPath);
    if (!back.ok || back.session.state !== 'BLOCKED') {
      return fail('TERMINAL_STATE_VERIFY_FAILED', { expected: 'BLOCKED', got: back.ok ? back.session.state : null });
    }
    const stB = persistLoopState(sessionPath, (s) => { s.controlLoop = s.controlLoop ?? {}; s.controlLoop.state = 'BLOCKED'; });
    if (!stB.ok) return stB;
    return { ...out, fsm: { state: 'BLOCKED', terminalized: true } };
  }

  // F5 (Issue #155 rework): PASS -> DELIVERING boundary carries the EXACT
  // validated GPT decision object as the transition evidence — the canonical
  // runControlLoop DELIVERING-tail resume replays this persisted decision
  // (evidence.verdict === 'PASS') and NEVER re-asks the reviewer. The runner
  // still stops at DELIVERING: the canonical delivery resume owns
  // merge/close/read-back/COMPLETED exactly once.
  const tD = authoritativeLegacyTransition({ loop, sessionPath, from: 'DECIDING', to: 'DELIVERING', reason: 'legacy-adoption: PASS -> canonical delivery leg', evidence: out.value });
  if (!tD.ok) return tD;
  return { ...out, fsm: { state: 'DELIVERING', next: 'canonical delivery resume via runControlLoop (replays the persisted PASS decision)' } };
}
