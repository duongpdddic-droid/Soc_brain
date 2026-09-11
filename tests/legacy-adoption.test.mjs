#!/usr/bin/env node
// legacy-adoption.test.mjs — deterministic regressions for the explicit
// legacy/noncanonical review adoption primitive (Issue #155).
// No framework. Exit 0 = PASS. gh/git runners injected; no network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { sessionAtIntake } from '../packages/task-intake/session-at-intake.mjs';
import { updateSessionUnderOwnershipLock, readSessionRecord } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { cwaBindingFromSession } from '../packages/control-loop/chatgpt-web-cwa.mjs';
import { readTransitions } from '../packages/control-loop/control-loop.mjs';
import {
  LEGACY_ADOPTION_PROVENANCE,
  adoptLegacyTaskForReview,
  verifyLegacyEvidence,
  refreshAdoptedHead,
  runLegacyFinalReview,
} from '../packages/control-loop/legacy-adoption.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-legacy-adopt-'));
const REPO = 'duongpdddic-droid/soc_brain';
const ISSUE = 147;
const PR = 152;
const BRANCH = 'task/issue-147-cline-sdk-adapter';
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_C = 'c'.repeat(40);
const HEAD_D = 'd'.repeat(40);

const stateDir = path.join(TMP, 'state');
const worktreesRoot = path.join(TMP, 'worktrees');
const reviewReadyDir = path.join(TMP, 'review-ready');
const wtDir = path.join(TMP, 'wt-external');
mkdirSync(wtDir, { recursive: true });
writeFileSync(path.join(wtDir, 'marker.txt'), 'legacy work');

// mutable gh state (drives drift/rework scenarios)
const ghState = {
  issue: { number: ISSUE, state: 'OPEN' },
  pr: { number: PR, state: 'OPEN', headRefName: BRANCH, headRefOid: HEAD_A },
  comments: [],
};
const ghCall = (args) => {
  if (args[0] === 'issue' && args[1] === 'view') {
    return ghState.issue ? { code: 0, stdout: JSON.stringify(ghState.issue) } : { code: 1, stderr: 'not found' };
  }
  if (args[0] === 'pr' && args[1] === 'view') {
    // number-aware stub: each PR number resolves to its own record
    const requested = Number(args[2]);
    return ghState.pr ? { code: 0, stdout: JSON.stringify({ ...ghState.pr, number: requested, comments: ghState.comments }) } : { code: 1, stderr: 'not found' };
  }
  if (args[0] === 'pr' && args[1] === 'list') {
    return { code: 0, stdout: JSON.stringify([ghState.pr]) };
  }
  return { code: 1, stderr: `unexpected gh args: ${args.join(' ')}` };
};
const gitCall = (args, { cwd } = {}) => {
  const dir = cwd || wtDir;
  if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { code: 0, stdout: dir + '\n' };
  if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { code: 0, stdout: BRANCH + '\n' };
  if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { code: 0, stdout: ghState.pr.headRefOid + '\n' };
  if (args[0] === 'remote' && args[1] === 'get-url') return { code: 0, stdout: `https://github.com/${REPO}.git\n` };
  return { code: 1, stdout: '', stderr: `unexpected git args: ${args.join(' ')}` };
};

const evidenceFile = path.join(TMP, 'evidence', 'report.md');
let declaredEvidence = [{ kind: 'artifact', path: evidenceFile }, { url: `https://github.com/${REPO}/pull/${PR}/commit/${HEAD_A}` }];

const ADOPT_ARGS = {
  repo: REPO,
  issueNumber: ISSUE,
  pullRequestNumber: PR,
  branch: BRANCH,
  headSha: HEAD_A,
  worktreePath: wtDir,
  evidence: [],
  stateDir,
  worktreesRoot,
  adoptedBy: 'test-operator',
  ghCall,
  gitCall,
};

const IDH = identityHash({ repo: REPO, issueNumber: ISSUE });
const sessionPath = path.join(stateDir, 'sessions', `${IDH}.json`);
const readAdopted = () => readSessionRecord(sessionPath).session;

// 1) no binding + valid legacy PR adoption PASS
{
  const r = await adoptLegacyTaskForReview(ADOPT_ARGS);
  tru('adopt(1): no binding + valid legacy PR => adoption PASS', r.ok === true);
  eq('adopt(1): replayed=false on first admission', r.value?.replayed, false);
  eq('adopt(1): session at canonical path', r.value?.sessionPath, sessionPath);
  tru('adopt(1): binding written for existing worktree', existsSync(path.join(worktreesRoot, 'bindings', `${IDH}.json`)));
  const s = readAdopted();
  eq('adopt(1): state SESSION_ACTIVE', s.state, 'SESSION_ACTIVE');
  eq('adopt(1): lifecycle ends LEGACY_ADOPTED_FOR_REVIEW', s.lifecycle[s.lifecycle.length - 1].event, 'LEGACY_ADOPTED_FOR_REVIEW');
  eq('adopt(1): provenance mode', s.provenance.provenance, LEGACY_ADOPTION_PROVENANCE);
  eq('adopt(1): evidenceMode legacy', s.provenance.evidenceMode, 'legacy');
  eq('adopt(1): adoptedHeadSha pinned', s.provenance.adoptedHeadSha, HEAD_A);
  eq('adopt(1): controlLoop.prNumber bound', s.controlLoop.prNumber, PR);
  eq('adopt(1): source PR recorded', s.provenance.sourcePullRequestNumber, PR);
  tru('adopt(1): adoptedBy recorded', String(s.provenance.adoptedBy).includes('test-operator'));
}

// 6) no synthetic ExecutionRecord anywhere
{
  falsy('evidence: no stateDir/executions dir created by adoption', existsSync(path.join(stateDir, 'executions')));
  const raw = readFileSync(sessionPath, 'utf8');
  falsy('evidence: session record claims no canonical executor run', raw.includes('"EXECUTING"') || raw.includes('ExecutionRecord'));
  eq('evidence: adapter id is legacy-adoption', readAdopted().adapter.id, 'legacy-adoption');
}

// 7) sessionAtIntake no-backfill behavior PRESERVED (still refuses this identity)
{
  const r = sessionAtIntake({ repo: REPO, issueNumber: ISSUE, baseSha: HEAD_A, worktreesRoot, stateDir });
  falsy('intake: sessionAtIntake still refuses the adopted identity', r.ok === true);
  tru('intake: refusal reason is a canonical fail-closed gate', ['SESSION_INTAKE_NO_BINDING', 'SESSION_INTAKE_BIND_INVALID'].includes(r.reason));
}

// 9) exact CWA binding PASS
{
  const s = readAdopted();
  const b = cwaBindingFromSession(s);
  tru('cwa: binding OK after adoption', b.ok === true);
  eq('cwa: repository', b.repository, REPO);
  eq('cwa: issueNumber', b.issueNumber, ISSUE);
  eq('cwa: pullRequestNumber', b.pullRequestNumber, PR);
  eq('cwa: headSha exact', b.headSha, HEAD_A);
}

// 12) mutation owner invariant (Issue #145) NOT bypassed
{
  eq('owner: adopted session mutation-unbound', readAdopted().mutationOwner, null);
  const clobber = updateSessionUnderOwnershipLock(sessionPath, (s) => { s.mutationOwner = { laneId: 'sneaky' }; return { session: s }; });
  eq('owner: ownership clobber blocked', clobber.reason, 'OWNERSHIP_CLOBBER_BLOCKED');
  eq('owner: still unbound after clobber attempt', readAdopted().mutationOwner, null);
}

// 2) wrong PR head FAIL
{
  ghState.pr.headRefOid = HEAD_C;
  const r = await adoptLegacyTaskForReview({ ...ADOPT_ARGS, stateDir: path.join(TMP, 'state-wrong-head'), worktreesRoot: path.join(TMP, 'worktrees-wh'), headSha: HEAD_A });
  eq('adopt(2): wrong PR head => PR_HEAD_MISMATCH', r.code, 'PR_HEAD_MISMATCH');
  ghState.pr.headRefOid = HEAD_A;
}

// 3) wrong branch FAIL
{
  const r = await adoptLegacyTaskForReview({ ...ADOPT_ARGS, stateDir: path.join(TMP, 'state-wrong-branch'), worktreesRoot: path.join(TMP, 'worktrees-wb'), branch: 'some/other-branch' });
  eq('adopt(3): wrong branch => PR_BRANCH_MISMATCH', r.code, 'PR_BRANCH_MISMATCH');
}

// 4) closed PR FAIL
{
  ghState.pr.state = 'CLOSED';
  const r = await adoptLegacyTaskForReview({ ...ADOPT_ARGS, stateDir: path.join(TMP, 'state-closed'), worktreesRoot: path.join(TMP, 'worktrees-closed') });
  eq('adopt(4): closed PR => PR_NOT_OPEN', r.code, 'PR_NOT_OPEN');
  ghState.pr.state = 'OPEN';
}

// 10) restart/replay adoption idempotent
{
  const before = readAdopted().lifecycle.filter((e) => e.event === 'LEGACY_ADOPTED_FOR_REVIEW').length;
  const r = await adoptLegacyTaskForReview(ADOPT_ARGS);
  tru('replay: idempotent adoption ok', r.ok === true);
  eq('replay: replayed=true', r.value?.replayed, true);
  const after = readAdopted().lifecycle.filter((e) => e.event === 'LEGACY_ADOPTED_FOR_REVIEW').length;
  eq('replay: no duplicated adoption event', after, before);
}

// 11) second/conflicting adoption fail-closed
{
  ghState.pr.headRefOid = HEAD_C;
  const r = await adoptLegacyTaskForReview({ ...ADOPT_ARGS, headSha: HEAD_C });
  eq('conflict: different head => LEGACY_ADOPTION_CONFLICT', r.code, 'LEGACY_ADOPTION_CONFLICT');
  ghState.pr.headRefOid = HEAD_A;
  const r2 = await adoptLegacyTaskForReview({ ...ADOPT_ARGS, pullRequestNumber: 999, headSha: HEAD_A });
  eq('conflict: different PR => LEGACY_ADOPTION_CONFLICT', r2.code, 'LEGACY_ADOPTION_CONFLICT');
}

// evidence verification + 5) stale/missing/drift FAIL
{
  mkdirSync(path.dirname(evidenceFile), { recursive: true });
  writeFileSync(evidenceFile, `Test report for ${REPO}#${ISSUE} @ ${HEAD_A}\nall suites pass\n`);
  const evidence = declaredEvidence;

  const v = await verifyLegacyEvidence({ sessionPath, evidence, ghCall, gitCall, stateDir, outputDir: reviewReadyDir });
  tru('verify: declared evidence bound to adopted head PASS', v.ok === true);
  tru('verify: packet projected from exact HEAD', v.value?.packet?.headSha === HEAD_A && v.value?.packet?.pr === PR);

  // stale evidence (declares a different head)
  const stale = await verifyLegacyEvidence({ sessionPath, evidence: [{ kind: 'artifact', path: evidenceFile, headSha: HEAD_B }], ghCall, gitCall, stateDir, outputDir: reviewReadyDir });
  eq('verify(5): stale declared head => EVIDENCE_STALE', stale.code, 'EVIDENCE_STALE');
  // evidence content does not bind the CURRENT adopted head after a rework drift
  ghState.pr.headRefOid = HEAD_B;
  const drift = await verifyLegacyEvidence({ sessionPath, evidence, ghCall, gitCall, stateDir, outputDir: reviewReadyDir });
  eq('verify(5): PR head drift => REVIEW_HEAD_DRIFT', drift.code, 'REVIEW_HEAD_DRIFT');
  ghState.pr.headRefOid = HEAD_A;
  // missing evidence file
  const missing = await verifyLegacyEvidence({ sessionPath, evidence: [{ kind: 'artifact', path: path.join(TMP, 'evidence', 'nope.md') }], ghCall, gitCall, stateDir, outputDir: reviewReadyDir });
  eq('verify(5): missing evidence => EVIDENCE_MISSING', missing.code, 'EVIDENCE_MISSING');
  // empty evidence
  const empty = await verifyLegacyEvidence({ sessionPath, evidence: [], ghCall, gitCall, stateDir, outputDir: reviewReadyDir });
  eq('verify(5): empty evidence => EVIDENCE_EMPTY', empty.code, 'EVIDENCE_EMPTY');
}

// 8) rework HEAD update PASS (audit keeps original + subsequent)
{
  ghState.pr.headRefOid = HEAD_B;
  writeFileSync(evidenceFile, `Test report for ${REPO}#${ISSUE} @ ${HEAD_B}\nrework round applied\n`);
  const r = await refreshAdoptedHead({ sessionPath, headSha: HEAD_B, ghCall });
  tru('rework: head refresh PASS', r.ok === true);
  const s = readAdopted();
  eq('rework: session.headSha updated', s.headSha, HEAD_B);
  eq('rework: original adopted head kept in audit', s.provenance.reviewedHeads[0], HEAD_A);
  eq('rework: subsequent reviewed head recorded', s.provenance.reviewedHeads[1], HEAD_B);
  tru('rework: lifecycle carries LEGACY_REVIEW_HEAD_REFRESHED', s.lifecycle.some((e) => e.event === 'LEGACY_REVIEW_HEAD_REFRESHED'));
  // CWA binding follows the refreshed head
  const b = cwaBindingFromSession(s);
  eq('rework: CWA binding follows refreshed head', b.headSha, HEAD_B);
  const v = await verifyLegacyEvidence({ sessionPath, evidence: [{ kind: 'artifact', path: evidenceFile }], ghCall, gitCall, stateDir, outputDir: reviewReadyDir });
  tru('rework: evidence verifies against refreshed head', v.ok === true);
  // idempotent same-head refresh
  const r2 = await refreshAdoptedHead({ sessionPath, headSha: HEAD_B, ghCall });
  tru('rework: same-head refresh idempotent', r2.ok === true);
}

// 13) zero TASK_COMPLETED before review PASS/delivery
{
  const s = readAdopted();
  eq('lifecycle: zero TASK_COMPLETED before delivery', s.lifecycle.filter((e) => e.event === 'TASK_COMPLETED').length, 0);
  eq('lifecycle: session still ACTIVE', s.state, 'SESSION_ACTIVE');
}

// review runner arming gate (production CWA only; no CDP/MCP/copy-paste)
{
  const r = await runLegacyFinalReview({ sessionPath, evidence: [{ kind: 'artifact', path: path.join(TMP, 'evidence', 'report.md') }], ghCall, gitCall, stateDir, outputDir: reviewReadyDir, env: {} });
  eq('runner: not armed => CWA_FINAL_REVIEW_NOT_ARMED (fail-closed)', r.code, 'CWA_FINAL_REVIEW_NOT_ARMED');
}

// F2: PR branch revalidation on every review round (verify + refresh + CWA calls 0)
{
  ghState.pr.headRefName = 'some/other-branch'; // branch switch on the PR
  const s0 = readAdopted();
  const head0 = s0.headSha;
  const reviewed0 = JSON.stringify(s0.provenance.reviewedHeads);
  const v = await verifyLegacyEvidence({ sessionPath, evidence: [{ kind: 'artifact', path: evidenceFile }], ghCall, gitCall, stateDir, outputDir: reviewReadyDir });
  eq('f2(verify): branch switch => REVIEW_BRANCH_DRIFT', v.code, 'REVIEW_BRANCH_DRIFT');
  const rf = await refreshAdoptedHead({ sessionPath, headSha: HEAD_B, ghCall });
  eq('f2(refresh): branch switch => REVIEW_BRANCH_DRIFT, zero mutation', rf.code, 'REVIEW_BRANCH_DRIFT');
  const s1 = readAdopted();
  eq('f2: session.headSha unchanged', s1.headSha, head0);
  eq('f2: reviewedHeads unchanged', JSON.stringify(s1.provenance.reviewedHeads), reviewed0);
  // CWA calls 0: the transport factory is never reached when verify fails
  let cwaCalls = 0;
  const armed = await runLegacyFinalReview({
    sessionPath, evidence: [{ kind: 'artifact', path: evidenceFile }], ghCall, gitCall, stateDir, outputDir: reviewReadyDir,
    env: { SOC_CWA_FINAL_REVIEW: '1' },
    cwaTransportFactory: () => { cwaCalls += 1; return () => {}; },
  });
  eq('f2(runner): typed drift before CWA', armed.code, 'REVIEW_BRANCH_DRIFT');
  eq('f2(runner): CWA transport calls = 0', cwaCalls, 0);
  ghState.pr.headRefName = BRANCH; // restore
}

// F3: pr-comment evidence contract (locator + read-back + head binding)
{
  const goodComment = { url: `https://github.com/${REPO}/pull/${PR}#issuecomment-1000`, body: `Rework evidence @ ${HEAD_B} — all suites pass` };
  ghState.comments = [goodComment];
  const vGood = await verifyLegacyEvidence({ sessionPath, evidence: [{ kind: 'pr-comment', url: goodComment.url }], ghCall, gitCall, stateDir, outputDir: reviewReadyDir });
  tru('f3: PR comment on adopted PR binding reviewed head PASS', vGood.ok === true);
  // comment from ANOTHER PR: the read-back fetches the adopted PR's own
  // comments — a foreign-PR locator never matches (fail closed)
  ghState.comments = [];
  const wrongPr = { url: `https://github.com/${REPO}/pull/999#issuecomment-2000`, body: `evidence @ ${HEAD_B}` };
  const vWrong = await verifyLegacyEvidence({ sessionPath, evidence: [{ kind: 'pr-comment', url: wrongPr.url }], ghCall, gitCall, stateDir, outputDir: reviewReadyDir });
  eq('f3: comment from wrong PR => EVIDENCE_PR_MISMATCH', vWrong.code, 'EVIDENCE_PR_MISMATCH');
  // comment exists on the right PR but does NOT bind the head
  const noHead = { url: `https://github.com/${REPO}/pull/${PR}#issuecomment-3000`, body: 'looks fine to me' };
  ghState.comments = [noHead];
  const vStale = await verifyLegacyEvidence({ sessionPath, evidence: [{ kind: 'pr-comment', url: noHead.url }], ghCall, gitCall, stateDir, outputDir: reviewReadyDir });
  eq('f3: comment not binding head => EVIDENCE_STALE', vStale.code, 'EVIDENCE_STALE');
  // caller-supplied headSha alone is NOT authority (no path/url/comment)
  const solo = await verifyLegacyEvidence({ sessionPath, evidence: [{ kind: 'artifact', headSha: HEAD_B }], ghCall, gitCall, stateDir, outputDir: reviewReadyDir });
  eq('f3: headSha alone => EVIDENCE_INVALID', solo.code, 'EVIDENCE_INVALID');
  ghState.comments = [];
}

// F1: barrier regression — concurrent cross-process adopters, no last-writer-wins
{
  const raceState = path.join(TMP, 'state-race');
  const raceRoot = path.join(TMP, 'worktrees-race');
  const wtA = path.join(TMP, 'wt-race-a');
  const wtB = path.join(TMP, 'wt-race-b');
  mkdirSync(wtA, { recursive: true });
  mkdirSync(wtB, { recursive: true });
  const here = path.dirname(fileURLToPath(import.meta.url));
  const child = path.join(here, 'legacy-adoption-race-child.mjs');
  const outA = path.join(TMP, 'result-a.json');
  const outB = path.join(TMP, 'result-b.json');
  const { spawn } = await import('node:child_process');
  const pA = spawn(process.execPath, [child, raceState, raceRoot, wtA, String(PR), HEAD_A, BRANCH, outA], { stdio: 'ignore', windowsHide: true });
  const pB = spawn(process.execPath, [child, raceState, raceRoot, wtB, 999, HEAD_C, 'some/other-branch', outB], { stdio: 'ignore', windowsHide: true });
  await Promise.all([
    new Promise((res) => pA.once('exit', res)),
    new Promise((res) => pB.once('exit', res)),
  ]);
  const resA = JSON.parse(readFileSync(outA, 'utf8'));
  const resB = JSON.parse(readFileSync(outB, 'utf8'));
  const outcomes = [resA, resB].map((r) => (r && r.ok === true && r.value ? { ...r, ...r.value, ok: true } : r));
  const winners = outcomes.filter((r) => r.ok === true);
  eq('f1(race): exactly ONE adoption winner', winners.length, 1);
  const loser = outcomes.find((r) => r.ok !== true);
  tru('f1(race): loser typed fail-closed', !!loser && typeof loser.code === 'string');
  const winner = winners[0];
  const s = readSessionRecord(winner.sessionPath).session;
  eq('f1(race): persisted session = winner PR', s.provenance.sourcePullRequestNumber, winner.provenance.sourcePullRequestNumber);
  eq('f1(race): LEGACY_ADOPTED_FOR_REVIEW exactly once', s.lifecycle.filter((e) => e.event === 'LEGACY_ADOPTED_FOR_REVIEW').length, 1);
  if (s.controlPlane?.bindingPath) {
    const bind = JSON.parse(readFileSync(s.controlPlane.bindingPath, 'utf8'));
    eq('f1(race): binding = winner worktree (no clobber)', bind.path, winner.provenance.sourcePullRequestNumber === PR ? wtA : wtB);
  }
  const loser2 = await adoptLegacyTaskForReview({ ...ADOPT_ARGS, stateDir: raceState, worktreesRoot: raceRoot, pullRequestNumber: winner.provenance.sourcePullRequestNumber === PR ? 999 : PR, headSha: winner.provenance.sourcePullRequestNumber === PR ? HEAD_C : HEAD_A, branch: winner.provenance.sourcePullRequestNumber === PR ? 'some/other-branch' : BRANCH });
  tru('f1(race): post-hoc loser adoption still fail-closed in-process', loser2.ok === false);
}

// F1 round 2: external authority revalidated INSIDE the adoption lock
{
  // PR drift: precheck sees H1, the inside-lock re-admission sees H2
  ghState.pr.headRefOid = HEAD_A; // precheck baseline (rework block left HEAD_B)
  let prViews = 0;
  const ghPrDrift = (args) => {
    if (args[0] === 'pr' && args[1] === 'view') {
      prViews += 1;
      return { code: 0, stdout: JSON.stringify({ ...ghState.pr, number: Number(args[2]), headRefOid: prViews === 1 ? HEAD_A : HEAD_C }) };
    }
    return ghCall(args);
  };
  const S1 = path.join(TMP, 'state-f1pr');
  const r1 = await adoptLegacyTaskForReview({ ...ADOPT_ARGS, stateDir: S1, worktreesRoot: path.join(TMP, 'worktrees-f1pr'), ghCall: ghPrDrift });
  eq('f1(1): PR drift inside lock => PR_HEAD_MISMATCH', r1.code, 'PR_HEAD_MISMATCH');
  falsy('f1(1): session absent (zero publish)', existsSync(path.join(S1, 'sessions', `${IDH}.json`)));
  falsy('f1(1): binding absent (zero publish)', existsSync(path.join(TMP, 'worktrees-f1pr', 'bindings', `${IDH}.json`)));
  eq('f1(1): precheck once + exactly one inside-lock re-admission', prViews, 2);

  // worktree drift: precheck git HEAD sees H1, inside-lock re-verify sees H2
  ghState.pr.headRefOid = HEAD_A; // keep gh consistent so the PR gate passes
  let headReads = 0;
  const gitHeadDrift = (args, opts) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      headReads += 1;
      return { code: 0, stdout: (headReads === 1 ? HEAD_A : HEAD_C) + '\n' };
    }
    return gitCall(args, opts);
  };
  const S2 = path.join(TMP, 'state-f1wt');
  const r2 = await adoptLegacyTaskForReview({ ...ADOPT_ARGS, stateDir: S2, worktreesRoot: path.join(TMP, 'worktrees-f1wt'), gitCall: gitHeadDrift });
  eq('f1(2): worktree drift inside lock => WORKTREE_HEAD_MISMATCH', r2.code, 'WORKTREE_HEAD_MISMATCH');
  falsy('f1(2): session absent (zero publish)', existsSync(path.join(S2, 'sessions', `${IDH}.json`)));
  falsy('f1(2): binding absent (zero publish)', existsSync(path.join(TMP, 'worktrees-f1wt', 'bindings', `${IDH}.json`)));
  ghState.pr.headRefOid = HEAD_B; // restore the rework-block world
}

// F2 round 2: serialized/CAS refresh (inside-lock authority + monotonic CAS)
{
  // (1) concurrent BLOCKED before lock => SESSION_ALREADY_TERMINAL, zero mutation
  const bytes0 = readFileSync(sessionPath, 'utf8');
  const blocked = JSON.parse(bytes0);
  blocked.state = 'BLOCKED';
  const bytesBlocked = `${JSON.stringify(blocked, null, 2)}\n`;
  writeFileSync(sessionPath, bytesBlocked, 'utf8');
  const r1 = await refreshAdoptedHead({ sessionPath, headSha: HEAD_C, ghCall });
  eq('f2(1): BLOCKED inside lock => SESSION_ALREADY_TERMINAL', r1.code, 'SESSION_ALREADY_TERMINAL');
  eq('f2(1): zero mutation by refresh (file still the BLOCKED write)', readFileSync(sessionPath, 'utf8'), bytesBlocked);
  writeFileSync(sessionPath, bytes0, 'utf8'); // restore ACTIVE

  // (2) competing forward refresh persists; rollback attempt fails closed
  ghState.pr.headRefOid = HEAD_C;
  const r2 = await refreshAdoptedHead({ sessionPath, headSha: HEAD_C, ghCall });
  tru('f2(2): competing forward refresh (H3) persists', r2.ok === true);
  let s = readAdopted();
  eq('f2(2): head = H3', s.headSha, HEAD_C);
  eq('f2(2): reviewedHeads monotonic', JSON.stringify(s.provenance.reviewedHeads), JSON.stringify([HEAD_A, HEAD_B, HEAD_C]));
  ghState.pr.headRefOid = HEAD_B;
  const r3 = await refreshAdoptedHead({ sessionPath, headSha: HEAD_B, ghCall });
  eq('f2(2): rollback to reviewed head => REVIEW_HEAD_ROLLBACK', r3.code, 'REVIEW_HEAD_ROLLBACK');
  eq('f2(2): head never rolls backward', readAdopted().headSha, HEAD_C);
  eq('f2(2): reviewedHeads audit unchanged', JSON.stringify(readAdopted().provenance.reviewedHeads), JSON.stringify([HEAD_A, HEAD_B, HEAD_C]));
  // force-push backward: PR head itself returns to an already-reviewed head
  ghState.pr.headRefOid = HEAD_A;
  const r4 = await refreshAdoptedHead({ sessionPath, headSha: HEAD_A, ghCall });
  eq('f2(2): previously-reviewed head via force-push => REVIEW_HEAD_ROLLBACK (stale CAS)', r4.code, 'REVIEW_HEAD_ROLLBACK');
  eq('f2(2): head still H3', readAdopted().headSha, HEAD_C);
  // F4 contract: an UNSEEN new head (force-pushed, non-descendant) IS admitted
  // after the PR read-back gates it — the CAS only blocks previously-REVIEWED
  // stale heads, never legitimate rebase/force-push workflows.
  ghState.pr.headRefOid = HEAD_D;
  const r6 = await refreshAdoptedHead({ sessionPath, headSha: HEAD_D, ghCall });
  tru('f2(2): unseen force-pushed head admitted (F4 contract)', r6.ok === true);
  eq('f2(2): head = H4 (unseen)', readAdopted().headSha, HEAD_D);
  eq('f2(2): audit monotonic with unseen head appended', JSON.stringify(readAdopted().provenance.reviewedHeads), JSON.stringify([HEAD_A, HEAD_B, HEAD_C, HEAD_D]));
  // idempotent same-head: zero mutation
  ghState.pr.headRefOid = HEAD_D;
  const bytes1 = readFileSync(sessionPath, 'utf8');
  const r5 = await refreshAdoptedHead({ sessionPath, headSha: HEAD_D, ghCall });
  tru('f2(2): same-head refresh idempotent ok', r5.ok === true && r5.value?.idempotent === true);
  eq('f2(2): idempotent refresh = zero mutation', readFileSync(sessionPath, 'utf8'), bytes1);
  eq('f2(2): mutationOwner never touched', readAdopted().mutationOwner, null);
}

// F3: canonical FSM entry + verdict routing (no parallel terminalization path)
{
  writeFileSync(evidenceFile, `Test report for ${REPO}#${ISSUE} @ ${HEAD_D}\nfinal round\n`);
  ghState.pr.headRefOid = HEAD_D;
  let cwaCalls = 0;
  const mockTransport = (verdict) => async () => {
    cwaCalls += 1;
    return {
      ok: true,
      text: JSON.stringify({ verdict, findings: [], evidenceRequests: [], confidence: 0.9, metadata: { model: 'mock-cwa' }, binding: { repository: REPO, issue: ISSUE, headSha: ghState.pr.headRefOid } }),
      modelSlug: 'mock',
    };
  };
  const fsmArgs = { sessionPath, evidence: [{ kind: 'artifact', path: evidenceFile }], ghCall, gitCall, stateDir, outputDir: reviewReadyDir, env: { SOC_CWA_FINAL_REVIEW: '1' } };

  // Round 1: REWORK verdict => canonical REWORK leg, non-terminal
  const r1 = await runLegacyFinalReview({ ...fsmArgs, cwaTransportFactory: () => mockTransport('REWORK') });
  tru('f3(1): REWORK verdict routed', r1.ok === true && r1.value?.verdict === 'REWORK');
  eq('f3(1): FSM state REWORK', r1.fsm?.state, 'REWORK');
  const moves1 = readTransitions({ stateDir, identityHash: IDH }).map((t) => `${t.from}->${t.to}`);
  eq('f3(1): canonical chain', JSON.stringify(moves1), JSON.stringify(['VERIFYING->PRE_REVIEWING', 'PRE_REVIEWING->FINAL_REVIEWING', 'FINAL_REVIEWING->DECIDING', 'DECIDING->REWORK']));
  eq('f3(1): controlLoop.state REWORK', readAdopted().controlLoop.state, 'REWORK');
  eq('f3(1): session non-terminal', readAdopted().state, 'SESSION_ACTIVE');

  // Round 2 (post-REWORK re-entry): canonical REWORK -> EXECUTING -> VERIFYING
  // -> PRE_REVIEWING -> FINAL_REVIEWING -> DECIDING -> DELIVERING on PASS
  const r2 = await runLegacyFinalReview({ ...fsmArgs, cwaTransportFactory: () => mockTransport('PASS') });
  tru('f3(2): PASS verdict routed to DELIVERING', r2.ok === true && r2.fsm?.state === 'DELIVERING');
  const moves2 = readTransitions({ stateDir, identityHash: IDH }).map((t) => `${t.from}->${t.to}`).slice(moves1.length);
  eq('f3(2): canonical re-entry + delivery chain', JSON.stringify(moves2), JSON.stringify(['REWORK->EXECUTING', 'EXECUTING->VERIFYING', 'VERIFYING->PRE_REVIEWING', 'PRE_REVIEWING->FINAL_REVIEWING', 'FINAL_REVIEWING->DECIDING', 'DECIDING->DELIVERING']));
  eq('f3(2): controlLoop.state DELIVERING', readAdopted().controlLoop.state, 'DELIVERING');
  eq('f3(2): session still non-terminal (delivery owns COMPLETED)', readAdopted().state, 'SESSION_ACTIVE');
  eq('f3(2): CWA called once per round', cwaCalls, 2);

  // zero TASK_COMPLETED + no COMPLETED transition anywhere (exactly-once owned
  // by the canonical delivery/terminalize path, never by this runner)
  eq('f3: zero TASK_COMPLETED lifecycle events', readAdopted().lifecycle.filter((e) => e.event === 'TASK_COMPLETED').length, 0);
  eq('f3: no COMPLETED transition in ledger', readTransitions({ stateDir, identityHash: IDH }).filter((t) => t.to === 'COMPLETED').length, 0);
}

// ---- report -------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'ok' : 'FAIL'}  ${c.name}${c.ok ? '' : `  got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
console.log(`legacy-adoption.test: ${checks.length - failed.length}/${checks.length} checks passed`);
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* windows handle lag */ }
if (failed.length) process.exit(1);
