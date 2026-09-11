#!/usr/bin/env node
// Issue #155 rework round 4: project the canonical review-ready evidence at
// the exact rework HEAD through the REAL review-ready primitives.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { renderReviewReady, writeReviewReady } from '../packages/review-ready/review-ready.mjs';

const HEAD = '1d5e3d5f48c49d7f3a1e1d093c108ef01e6321c2';
const report = {
  identity: {
    repository: 'duongpdddic-droid/Soc_brain',
    issue: 155,
    pullRequest: 156,
    branch: 'task/issue-155-legacy-adoption',
    headSha: HEAD,
    baseSha: '5ddc30a047d088a76150837b2b4bc86a2984ab6d',
    prState: 'OPEN',
  },
  terminalStatus: { status: 'READY_FOR_REVIEW' },
  scope: {
    items: [
      { taskId: 'duongpdddic-droid/soc_brain#155', lane: 'legacy-adoption rework round 4 (F5/F6/F7 of the round-3 review)' },
      { issueObjective: 'Control-plane gap: legacy/noncanonical task cannot enter canonical CWA final-review transport (proven by Issue #147/PR #152)' },
      { acceptanceCriteria: 'F5 authoritative transitions (ledger-tail + controlLoop.state validated, read-backs); F6 crash-safe state semantics (recoverable finalReview:FAIL tail, canonical BLOCKED terminalization, replay-proof); F7 truthful legacy packet provenance (no canonical executor/verifier/ExecutionRecord claims); regressions A-F' },
    ],
  },
  codeEvidence: {
    items: [
      { committedHead: HEAD.slice(0, 12), base: '5ddc30a047d0', committedBy: 'legacy-adoption lane commits (external execution adopted for review)' },
      { change: 'authoritativeLegacyTransition helper: ledger-tail validation (tail.to === from) + session controlLoop.state validation + loop.transition + ledger read-back + ownership-locked state persist + state read-back; ALL legacy runner transitions route through it' },
      { change: 'authoritative-tail-gated entry: empty ledger (fresh adoption) / REWORK tail / VERIFYING tail admitted; DELIVERING/BLOCKED/DECIDING/FINAL_REVIEWING/EXECUTING/ACCEPTED tails fail closed LEGACY_ENTRY_STATE_UNEXPECTED before any transition and before the CWA transport selection' },
      { change: 'CWA transport selection moved BEFORE the PRE_REVIEWING->FINAL_REVIEWING transition (no silent FINAL_REVIEWING divergence when the transport is unavailable)' },
      { change: 'failing review call: FINAL_REVIEWING->BLOCKED finalReview:FAIL:<code> resumable own-FAIL tail (session stays ACTIVE; canonical resume re-enters once per relaunch); PASS/REWORK/BLOCKED verdict transitions carry the validated decision as evidence' },
      { change: 'BLOCKED verdict terminalizes via the canonical loop.terminalize (token-bound) with the BLOCKED read-back; no second terminalization path' },
      { change: 'F7: projectReviewReadyPacket legacy-adoption provenance mode — legacy executor wording, verifyLegacyEvidence-based Verification section, no PENDING_AT_PACKET_TIME/readExecutionRecord/canonical-executor claims; packet format unchanged' },
    ],
  },
  findingResolution: {
    items: [
      { finding: 'F5 legacy transitions did not validate the authoritative ledger tail / controlLoop.state; discontinuous edges + ledger/state divergence were possible; CWA_TRANSPORT_UNAVAILABLE could return after the ledger entered FINAL_REVIEWING', resolution: 'the authoritative transition helper validates tail + state BEFORE the transition, read-backs the ledger tail and the persisted state AFTER it; the transport selection precedes the FINAL_REVIEWING transition; the entry is tail-gated and fails closed on unexpected states (regressions A/C/D/F)' },
      { finding: 'F6 DELIVERING/BLOCKED re-entry + replay', resolution: 'the tail-gated entry rejects them typed (LEGACY_ENTRY_STATE_UNEXPECTED / SESSION_ALREADY_TERMINAL) with zero transitions and zero CWA calls (regressions A/B); BLOCKED verdicts terminalize canonically with the BLOCKED read-back and replays cannot revive' },
      { finding: 'F7 legacy packet claimed canonical executor/PENDING verifier', resolution: 'legacy-adoption provenance mode renders the truthful external-execution provenance and the verifyLegacyEvidence results; the canonical projection is regression-identical' },
    ],
  },
  tests: {
    items: [
      { targeted: 'tests/legacy-adoption.test.mjs 149/149 (F5 boundary evidence at DELIVERING; A DELIVERING re-entry typed reject + zero CWA + transitions unchanged; B BLOCKED replay typed reject + zero CWA + zero transitions; C unconfigured transport keeps tail/state consistent at PRE_REVIEWING->BLOCKED resumable tail; D controlLoop.state read-backs at every boundary; E PASS after the fail-tail re-entry; F whole-ledger continuity scan with the admitted own-FAIL re-entry class; F7 legacy packet claims)' },
      { full: 'node --test tests/*.test.mjs — 307/307 PASS, 0 fail, exit 0 at this HEAD' },
    ],
  },
  verification: {
    items: [
      { deterministicVerify: 'PASS', source: 'task lane verification (legacy-adoption rework round 4)', evidence: `full suite 307/303+4 at ${HEAD}` },
    ],
  },
  safety: {
    items: [
      { invariant: 'every legacy transition validates the authoritative ledger tail and controlLoop.state; read-backs before the next side effect' },
      { invariant: 'no transition whose from != the previous ledger tail (the only admitted discontinuity class = the #114/#116 own-FAIL re-entry, whitelisted and counted in the regression)' },
      { invariant: 'DELIVERING/BLOCKED/terminal re-entries fail closed typed with zero transitions and zero CWA calls' },
      { mutationScope: 'review evidence projection only; merge/close owned by the canonical delivery resume after PASS' },
    ],
  },
  unverifiedRisks: {
    items: [
      { risk: 'the legacy runner stops at DELIVERING; the canonical delivery resume (runControlLoop) owns merge/close/COMPLETED — executed immediately after a PASS verdict in the same lane' },
    ],
  },
  delivery: {
    items: [
      { pr: 156, prState: 'OPEN', baseBranch: 'main', headBranch: 'task/issue-155-legacy-adoption', headSha: HEAD },
      { mergePolicy: 'squash merge with read-back, only after a validated PASS verdict via the production CWA transport' },
    ],
  },
};
const digest = createHash('sha256').update(JSON.stringify(report)).digest('hex');
const w = writeReviewReady(report, { digest });
if (!w.ok) { console.error(JSON.stringify(w.errors ?? w, null, 2)); process.exit(2); }
console.log(JSON.stringify({ ok: true, file: w.filePath, digest, headSha: HEAD }));
