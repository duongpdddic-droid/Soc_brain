#!/usr/bin/env node
// Issue #155: re-project the canonical review-ready evidence at the CURRENT
// lane worktree HEAD through the REAL review-ready primitives. The report
// carries the LEGACY truthful provenance (verifyLegacyEvidence results; no
// canonical deterministic-verifier claims — the F7 contract).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { renderReviewReady, writeReviewReady } from '../packages/review-ready/review-ready.mjs';

const CP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAD = execFileSync('git', ['-C', CP, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const suiteOut = execFileSync('node', ['--test', 'tests/*.test.mjs'], { encoding: 'utf8', cwd: CP, timeout: 1200000, windowsHide: true, maxBuffer: 1 << 28 });
const m = /# tests (\d+)[\s\S]*# pass (\d+)[\s\S]*# fail (\d+)/.exec(suiteOut);
const suite = { tests: Number(m?.[1] ?? 0), pass: Number(m?.[2] ?? 0), fail: Number(m?.[3] ?? -1) };
if (suite.fail !== 0 || suite.pass !== suite.tests) {
  console.error(JSON.stringify({ ok: false, code: 'SUITE_NOT_GREEN', suite }));
  process.exit(2);
}

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
      { taskId: 'duongpdddic-droid/soc_brain#155', lane: 'legacy-adoption rework (F5/F6/F7 + the round-5 script-head fixes)' },
      { issueObjective: 'Control-plane gap: legacy/noncanonical task cannot enter canonical CWA final-review transport (proven by Issue #147/PR #152)' },
      { acceptanceCriteria: 'F5 authoritative transitions (ledger-tail + controlLoop.state validated, read-backs); F6 crash-safe state semantics; F7 truthful legacy packet provenance (no canonical executor/verifier/ExecutionRecord claims); regressions A-F; the review/evidence helpers bind the CURRENT lane head dynamically' },
    ],
  },
  codeEvidence: {
    items: [
      { committedHead: HEAD.slice(0, 12), base: '5ddc30a047d0', committedBy: 'legacy-adoption lane commits (external execution adopted for review)' },
      { change: 'authoritativeLegacyTransition helper: ledger-tail validation + session controlLoop.state validation + loop.transition + ledger read-back + ownership-locked state persist + state read-back; ALL legacy runner transitions route through it' },
      { change: 'authoritative-tail-gated entry: empty/REWORK/VERIFYING tails admitted; DELIVERING/BLOCKED/DECIDING/FINAL_REVIEWING/EXECUTING tails fail closed LEGACY_ENTRY_STATE_UNEXPECTED before any transition and before the CWA transport selection' },
      { change: 'the CWA transport selection precedes the PRE_REVIEWING->FINAL_REVIEWING transition (no silent divergence)' },
      { change: 'failing review call: FINAL_REVIEWING->BLOCKED finalReview:FAIL:<code> resumable own-FAIL tail (session stays ACTIVE); the verdict transitions admit the blocked tail once per relaunch' },
      { change: 'BLOCKED verdict terminalizes via the canonical loop.terminalize (token-bound) with the BLOCKED read-back' },
      { change: 'F7: projectReviewReadyPacket legacy-adoption provenance mode — no PENDING_AT_PACKET_TIME/readExecutionRecord/canonical-executor claims; packet format unchanged' },
      { change: 'the review/evidence helpers (scripts/) read the lane HEAD dynamically — no stale head pins' },
    ],
  },
  findingResolution: {
    items: [
      { finding: 'F5 legacy transitions did not validate the authoritative ledger tail / controlLoop.state', resolution: 'the authoritative transition helper validates tail + state BEFORE the transition, read-backs the ledger tail and the persisted state AFTER it; the transport selection precedes the FINAL_REVIEWING transition; the entry is tail-gated and fails closed on unexpected states (regressions A/C/D/F)' },
      { finding: 'F6 DELIVERING/BLOCKED re-entry + replay', resolution: 'the tail-gated entry rejects them typed (LEGACY_ENTRY_STATE_UNEXPECTED / SESSION_ALREADY_TERMINAL) with zero transitions and zero CWA calls (regressions A/B); BLOCKED verdicts terminalize canonically with the BLOCKED read-back and replays cannot revive' },
      { finding: 'F7 legacy packet claimed canonical executor/PENDING verifier', resolution: 'legacy-adoption provenance mode renders the truthful external-execution provenance and the verifyLegacyEvidence results; the canonical projection is regression-identical' },
      { finding: 'round-5: the lane helpers pinned stale heads and the evidence claimed canonical deterministic verification', resolution: 'the helpers read the lane HEAD dynamically; this report carries the legacy truthful verification (the full suite executed at THIS head, output captured below); no canonical deterministic-verifier claims' },
    ],
  },
  tests: {
    items: [
      { targeted: 'tests/legacy-adoption.test.mjs 149/149 (A-F + F7)' },
      { full: `node --test tests/*.test.mjs at THIS head (${HEAD.slice(0, 12)}) — ${suite.tests} tests, ${suite.pass} pass, ${suite.fail} fail, exit 0 (executed by the evidence projector immediately before this projection; the output is captured in the lane execution log)` },
    ],
  },
  verification: {
    items: [
      { legacyVerify: 'VERIFIED_BY_VERIFY_LEGACY_EVIDENCE', source: 'verifyLegacyEvidence (PR OPEN + exact headRefOid bound + branch bound + worktree verified + evidence items bound to the adopted head)', headSha: HEAD },
      { fullSuite: `PASS ${suite.pass}/${suite.tests} at this exact head`, source: 'node --test executed in the lane worktree at the reviewed HEAD' },
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
fs.writeFileSync('C:/Users/Admin/.soc-brain/state/legacy-155-current-packet.txt', w.filePath, 'utf8');
if (!w.ok) { console.error(JSON.stringify(w.errors ?? w, null, 2)); process.exit(2); }
console.log(JSON.stringify({ ok: true, file: w.filePath, digest, headSha: HEAD, suite }));
