#!/usr/bin/env node
// legacy-adoption.test.mjs — deterministic regressions for the explicit
// legacy/noncanonical review adoption primitive (Issue #155).
// No framework. Exit 0 = PASS. gh/git runners injected; no network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { sessionAtIntake } from '../packages/task-intake/session-at-intake.mjs';
import { updateSessionUnderOwnershipLock, readSessionRecord } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { cwaBindingFromSession } from '../packages/control-loop/chatgpt-web-cwa.mjs';
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
};
const ghCall = (args) => {
  if (args[0] === 'issue' && args[1] === 'view') {
    return ghState.issue ? { code: 0, stdout: JSON.stringify(ghState.issue) } : { code: 1, stderr: 'not found' };
  }
  if (args[0] === 'pr' && args[1] === 'view') {
    // number-aware stub: each PR number resolves to its own record
    const requested = Number(args[2]);
    return ghState.pr ? { code: 0, stdout: JSON.stringify({ ...ghState.pr, number: requested }) } : { code: 1, stderr: 'not found' };
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
  const evidenceFile = path.join(TMP, 'evidence', 'report.md');
  mkdirSync(path.dirname(evidenceFile), { recursive: true });
  writeFileSync(evidenceFile, `Test report for ${REPO}#${ISSUE} @ ${HEAD_A}\nall suites pass\n`);
  const evidence = [{ kind: 'artifact', path: evidenceFile }, { kind: 'pr-comment', url: `https://github.com/${REPO}/pull/${PR}/commit/${HEAD_A}` }];

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
  const evidenceFile = path.join(TMP, 'evidence', 'report.md');
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

// ---- report -------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'ok' : 'FAIL'}  ${c.name}${c.ok ? '' : `  got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
console.log(`legacy-adoption.test: ${checks.length - failed.length}/${checks.length} checks passed`);
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* windows handle lag */ }
if (failed.length) process.exit(1);
