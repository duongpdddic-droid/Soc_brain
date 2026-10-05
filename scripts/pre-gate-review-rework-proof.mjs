// scripts/pre-gate-review-rework-proof.mjs — bounded proof for the
// PRE-GATE-REVIEW-01 rework seam (internal-review findings -> bounded
// rework leg -> repaired candidate -> CLEAN -> gate exactly once).
//
// REAL code under proof: preGateReviewVerifierAdapter (candidate binding,
// head lock, correlation key, classify), the AI_PR_REVIEWER adapter
// normalization/redaction, the ControlLoop FSM + runReworkLeg (digest,
// budget, duplicate-dispatch, readback), rework.mjs record/instruction.
// SCRIPTED DOUBLES (labeled, never claimed as e2e): the reviewer transport
// (findings on candidate A, APPROVED on candidate B) and the executor
// (on the rework instruction it "repairs" the candidate: session head,
// execution record and content binding all move A -> B).
//
// Not part of any test tier; operator-run evidence script.
// Output: artifacts/evidence/pre-gate-review-rework-proof.log
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { preGateReviewVerifierAdapter } from '../packages/control-loop/pre-gate-review.mjs';
import { runControlLoop, readTransitions } from '../packages/control-loop/control-loop.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

const REPO = 'duongpdddic-droid/soc_brain';
const ISSUE = 901;
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const DIGEST_A = 'c'.repeat(64);
const DIGEST_B = 'd'.repeat(64);
const FINDING_TEXT = 'eval of dynamic input without validation';

const log = (...a) => console.log(...a);
const checks = [];
function check(name, cond, detail = '') {
  checks.push({ name, ok: Boolean(cond) });
  log(`${cond ? '[ok]' : '[FAIL]'} ${name}${detail ? ` | ${detail}` : ''}`);
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pgrw-proof-'));
}

const stateDir = tmp();
const worktreePath = tmp();
const ID = identityHash({ repo: REPO, issueNumber: ISSUE });
const sessionPath = path.join(stateDir, 'sessions', `${ID}.json`);
fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
const execPath = path.join(stateDir, 'executions', `${ID}.json`);
fs.mkdirSync(path.dirname(execPath), { recursive: true });

function writeSession(headSha) {
  // Preserve the loop-bound terminalize token: runControlLoop binds its own
  // token at start; the mocked repair must not rotate what it presents later.
  let controlLoop = { terminalizeToken: 'f'.repeat(64) };
  try {
    const prev = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    if (prev.controlLoop && prev.controlLoop.terminalizeToken) controlLoop = prev.controlLoop;
  } catch { /* first write: use the placeholder */ }
  fs.writeFileSync(sessionPath, JSON.stringify({
    schemaVersion: '1',
    state: 'SESSION_ACTIVE',
    lifecycle: [],
    taskId: `${REPO}#${ISSUE}`,
    repo: REPO,
    issueNumber: ISSUE,
    headSha,
    baseSha: 'e'.repeat(40),
    worktreePath,
    worktreesRoot: stateDir,
    prNumber: 5,
    controlPlane: { stateDir },
    controlLoop,
  }, null, 2), 'utf8');
}

function writeRecord(headSha, digest) {
  fs.writeFileSync(execPath, JSON.stringify({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: ID,
    taskId: `${REPO}#${ISSUE}`, repo: REPO, issueNumber: ISSUE,
    terminalStatus: 'ok', exitCode: 0,
    worktreePath, baseSha: 'e'.repeat(40), headSha,
    codeContentDigest: digest, codeContentFiles: 1,
  }, null, 2), 'utf8');
}

writeSession(HEAD_A);
writeRecord(HEAD_A, DIGEST_A);

// ---- composite io: live reads of the (mutable) fixture files -------------
const registryPath = path.join(stateDir, 'registry.json');
fs.writeFileSync(registryPath, JSON.stringify({
  schemaVersion: '1',
  projects: [{ projectId: 'fixture', repository: REPO }],
}));
const io = {
  readSession: () => ({ ok: true, session: JSON.parse(fs.readFileSync(sessionPath, 'utf8')) }),
  readExecutionRecord: () => ({ ok: true, record: JSON.parse(fs.readFileSync(execPath, 'utf8')) }),
  computeBinding: () => {
    const r = JSON.parse(fs.readFileSync(execPath, 'utf8'));
    return { ok: true, value: { headSha: r.headSha, contentDigest: r.codeContentDigest, fileCount: r.codeContentFiles } };
  },
  findProjectId: () => 'fixture',
  registryPath,
};

// ---- reviewer transport: SCRIPTED DOUBLE ---------------------------------
const transportCalls = [];
const reviewerTransport = async (req) => {
  transportCalls.push(req.headSha);
  if (req.headSha === HEAD_A) {
    return {
      ok: true,
      verdict: 'CHANGES_REQUESTED',
      finalReview: true,
      reviewedHeadSha: HEAD_A,
      decisionGate: { status: 'PASS' },
      findings: [{ severity: 'critical', status: 'open', path: 'calc.js', content: FINDING_TEXT, category: 'security' }],
      openBlocking: [],
      detail: 'scripted findings on candidate A',
    };
  }
  return {
    ok: true,
    verdict: 'APPROVED',
    finalReview: true,
    reviewedHeadSha: HEAD_B,
    decisionGate: { status: 'PASS' },
    findings: [],
    openBlocking: [],
    detail: 'scripted CLEAN on repaired candidate B',
  };
};

// ---- inner gate verifier: counts real gate invocations --------------------
let innerCalls = 0;
const innerVerifier = async () => {
  innerCalls += 1;
  return { ok: true, value: { verdict: 'PASS', evidence: { exitCode: 0 } } };
};

const composite = preGateReviewVerifierAdapter({
  innerVerifier,
  transport: reviewerTransport,
  registryPath,
  io,
});

// ---- ControlLoop deps -----------------------------------------------------
const calls = [];
let reworkInstruction = null;
const deps = {
  reviewReadyDir: path.join(stateDir, 'review-ready'),
  router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
  executor: (ctx) => {
    if (ctx.reworkInstruction) {
      calls.push('executor:rework [MOCKED executor doubles the fix]');
      reworkInstruction = ctx.reworkInstruction;
      // The "repair": the candidate moves A -> B everywhere the binding looks.
      writeSession(HEAD_B);
      writeRecord(HEAD_B, DIGEST_B);
    } else {
      calls.push('executor:initial [MOCKED executor]');
    }
    return { ok: true, value: { executionStatus: 'EXITED', terminalStatus: 'ok', exitCode: 0, executionRecordPath: execPath } };
  },
  verifier: (ctx) => {
    calls.push('verifier(composite)');
    return composite({ sessionPath: ctx.sessionPath ?? sessionPath, executionRecordPath: ctx.executionRecordPath ?? execPath });
  },
  preReview: () => { calls.push('preReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
  finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.99, metadata: {} } }; },
  delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
  telegramSpawn: () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 1 })}\n` }),
};

log('=== PRE-GATE-REVIEW-01 rework-seam proof (bounded, disposable fixture) ===');
log(`stateDir=${stateDir}`);
log('REAL: composite + adapter normalization + control-loop FSM + rework leg');
log('DOUBLES: reviewer transport (scripted A-findings / B-APPROVED), executor (mocked repair A->B)');

const t0 = Date.now();
const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
const ms = Date.now() - t0;

log(`\nresult: ok=${res.ok} state=${res.value && res.value.state} code=${res.ok === false ? res.code : '-'} elapsed=${ms}ms`);
log(`calls: ${JSON.stringify(calls)}`);
log(`transport requested heads: ${JSON.stringify(transportCalls)}`);

check('loop completes COMPLETED after repair', res.ok === true && res.value.state === 'COMPLETED', JSON.stringify(res.ok === false ? res.detail : res.value));
check('reviewer transport saw candidate A then B', transportCalls.length === 2 && transportCalls[0] === HEAD_A && transportCalls[1] === HEAD_B, JSON.stringify(transportCalls));
check('gate (inner verifier) ran EXACTLY once — only on CLEAN B', innerCalls === 1, `innerCalls=${innerCalls}`);
check('rework instruction carries the finding verbatim', reworkInstruction !== null && reworkInstruction.includes(FINDING_TEXT));
check('exactly one rework dispatch', calls.filter((c) => c.startsWith('executor:rework')).length === 1);

const ledger = readTransitions({ stateDir, identityHash: ID });
const rwEntries = ledger.filter((r) => r.from === 'VERIFYING' && r.to === 'REWORK');
check('VERIFYING -> REWORK recorded once with internal-review reason',
  rwEntries.length === 1 && rwEntries[0].reason === 'internal-review-findings-rework',
  `count=${rwEntries.length} reason=${rwEntries[0] && rwEntries[0].reason}`);
check('findings preserved on the transition evidence',
  rwEntries.length === 1 && Array.isArray(rwEntries[0].evidence.findings)
  && rwEntries[0].evidence.findings.some((f) => String(f).includes(FINDING_TEXT)));
check('no verify:FAIL BLOCKED on the findings path',
  !ledger.some((r) => r.to === 'BLOCKED' && String(r.reason || '').startsWith('verify:FAIL')));
const reworkRecords = (() => {
  const dir = path.join(stateDir, 'control-loop', ID, 'rework');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
})();
check('rework decision record persisted (crash-safe digest ledger)', reworkRecords.length === 1, JSON.stringify(reworkRecords));

const failed = checks.filter((c) => !c.ok);
log(`\nproof: ${checks.length - failed.length}/${checks.length} checks passed`);
log('PROOF SCRIPT COMPLETE');
process.exit(failed.length ? 1 : 0);
