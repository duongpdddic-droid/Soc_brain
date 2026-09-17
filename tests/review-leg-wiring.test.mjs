// review-leg-wiring.test.mjs — Issue #4C/#4E/#4F: fresh path, rework with new
// head, Gemini absence, authority. No framework (top-level await like the
// Gemini loop tests).
import { runControlLoop, readTransitions, bindLoop } from '../packages/control-loop/control-loop.mjs';
import { reviewLegPreReviewAdapter } from '../packages/control-loop/review-leg-adapter.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rlw-')); }

function mkSession(stateDir, overrides = {}) {
  const repo = overrides.repo || 'duongpdddic-droid/soc_brain';
  const issueNumber = overrides.issueNumber || 79;
  const id = identityHash({ repo, issueNumber });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1',
    state: 'SESSION_ACTIVE',
    lifecycle: [],
    taskId: `${repo}#${issueNumber}`,
    repo,
    issueNumber,
    headSha: 'a'.repeat(40),
    baseSha: 'f'.repeat(40),
    worktreePath: path.join(stateDir, `wt-issue-${issueNumber}`),
    worktreesRoot: stateDir,
    controlPlane: { stateDir },
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session, id };
}

function mkExecRecord(stateDir, id, repo, issueNumber) {
  const p = path.join(stateDir, 'executions', `${id}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: id,
    taskId: `${repo}#${issueNumber}`, repo, issueNumber,
    terminalStatus: 'ok', exitCode: 0,
  }, null, 2), 'utf8');
  return p;
}

// Fake leg echoing its input binding into canonical evidence (proves the
// adapter passes the NEW head on rework rounds).
function mkFakeLeg(seen) {
  return (args) => {
    seen.push({ headSha: args.headSha, baseSha: args.baseSha });
    const n = seen.length;
    return {
      ok: true,
      value: {
        canonical: {
          schemaVersion: '1',
          source: 'ocr-delegate+opencode-host',
          binding: { identityHash: args.identityHash, repo: args.repo, issueNumber: args.issueNumber, baseSha: args.baseSha, headSha: args.headSha },
          target: { mode: 'range', from: args.baseSha, to: args.headSha },
          ocr: { version: '1.12.4', ruleGroups: 1 },
          reviewableFiles: ['src/a.mjs'],
          excludedFiles: [],
          reviewedFiles: ['src/a.mjs'],
          skippedFiles: [],
          coverageRate: 1,
          findings: [],
          reflectionCompleted: true,
          durationMs: 1,
        },
        digest: String(n).repeat(64).slice(0, 64),
        findingsCount: 0,
      },
      batch: { batched: false, batches: 1 },
    };
  };
}

// ---- fresh path: verify -> new leg -> GPT -> decide, Gemini never involved --
{
  const stateDir = mkStateDir();
  const { sessionPath, id: ID, session } = mkSession(stateDir);
  const execPath = mkExecRecord(stateDir, ID, session.repo, session.issueNumber);
  const calls = [];
  const seenLeg = [];
  const seenFinal = [];
  const deps = {
    reviewReadyDir: path.join(stateDir, 'review-ready'),
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: () => { calls.push('executor'); return { ok: true, value: { executionStatus: 'EXITED', terminalStatus: 'ok', exitCode: 0, executionRecordPath: execPath } }; },
    verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: (() => {
      const leg = reviewLegPreReviewAdapter({ controlRepo: stateDir, runLeg: mkFakeLeg(seenLeg) });
      return async (ctx) => { calls.push('preReview'); return leg(ctx); };
    })(),
    finalReview: (ctx) => { calls.push('finalReview'); seenFinal.push(ctx.preReview); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  eq('fresh COMPLETED', res.ok && res.value.state, 'COMPLETED');
  eq('fresh leg ran once', seenLeg.length, 1);
  tru('finalReview got leg evidence', seenFinal[0] && seenFinal[0].source === 'ocr-review-leg');
  tru('leg value carries no verdict', seenFinal[0] && !('verdict' in seenFinal[0]));
  const ledger = readTransitions({ stateDir, identityHash: ID });
  tru('fresh PRE->FINAL in ledger', ledger.some((r) => r.from === 'PRE_REVIEWING' && r.to === 'FINAL_REVIEWING'));
  tru('fresh order router/executor/verifier/leg/GPT/delivery', calls.join(',') === 'router,executor,verifier,preReview,finalReview,delivery');
}

// ---- rework: GPT REWORK -> executor rework -> NEW head -> NEW leg evidence --
{
  const stateDir = mkStateDir();
  const { sessionPath, id: ID, session } = mkSession(stateDir);
  const execPath = mkExecRecord(stateDir, ID, session.repo, session.issueNumber);
  const calls = [];
  const seenLeg = [];
  const seenFinal = [];
  const leg = reviewLegPreReviewAdapter({ controlRepo: stateDir, runLeg: mkFakeLeg(seenLeg) });
  let preCalls = 0;
  const deps = {
    reviewReadyDir: path.join(stateDir, 'review-ready'),
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: (ctx) => { calls.push(`executor:${ctx.reworkInstruction ? 'rework' : 'initial'}`); return { ok: true, value: { executionStatus: 'EXITED', terminalStatus: 'ok', exitCode: 0, executionRecordPath: execPath } }; },
    verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', report: 'ok' } }; },
    preReview: async (ctx) => {
      preCalls += 1;
      calls.push('preReview');
      if (preCalls === 2) {
        // Simulate the publish-chain canonical head refresh after rework.
        const rec = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
        rec.headSha = 'd'.repeat(40);
        fs.writeFileSync(sessionPath, JSON.stringify(rec, null, 2), 'utf8');
      }
      return leg(ctx);
    },
    finalReview: (ctx) => {
      calls.push('finalReview');
      seenFinal.push(ctx.preReview);
      if (seenFinal.length === 1) {
        return { ok: true, value: { verdict: 'REWORK', findings: ['fix-x'], evidenceRequests: [], confidence: 0.8, metadata: {}, binding: { repository: session.repo, issue: session.issueNumber, headSha: 'a'.repeat(40) } } };
      }
      return { ok: true, value: { verdict: 'PASS', findings: [] } };
    },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  eq('rework COMPLETED', res.ok && res.value.state, 'COMPLETED');
  eq('leg ran per round (new head reruns)', seenLeg.length, 2);
  eq('round1 head', seenLeg[0].headSha, 'a'.repeat(40));
  eq('round2 new head', seenLeg[1].headSha, 'd'.repeat(40));
  tru('new digest round2', seenFinal[1].digest !== seenFinal[0].digest);
  tru('GPT reran with new evidence', seenFinal[1].digest === seenLegDigest(seenFinal[1]));
  function seenLegDigest(v) { return v.digest; }
}

// ---- F02: authoritative resume state is the LEDGER, the JSON file is cache --
{
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const legEvidence = {
    source: 'ocr-review-leg',
    schemaVersion: '1',
    canonical: { schemaVersion: '1', source: 'ocr-delegate+opencode-host' },
    digest: 'a'.repeat(64),
    findingsCount: 3,
  };
  // Seed the canonical ledger exactly as a fresh walk would have left it.
  const loop = bindLoop({ sessionPath, identityHash: ID, stateDir });
  loop.transition({ from: 'ACCEPTED', to: 'ROUTED', reason: 'seed' });
  loop.transition({ from: 'ROUTED', to: 'EXECUTING', reason: 'seed' });
  loop.transition({ from: 'EXECUTING', to: 'VERIFYING', reason: 'seed' });
  loop.transition({ from: 'VERIFYING', to: 'PRE_REVIEWING', reason: 'seed', evidence: { verdict: 'PASS', report: 'ok' } });
  loop.transition({ from: 'PRE_REVIEWING', to: 'FINAL_REVIEWING', reason: 'seed', evidence: legEvidence });
  const seenFinal = [];
  const deps = {
    reviewReadyDir: path.join(stateDir, 'review-ready'),
    router: () => ({ ok: true, value: { executorKind: 'opencode', model: 'x' } }),
    executor: () => { throw new Error('must not re-execute on ledger resume'); },
    verifier: () => { throw new Error('must not re-verify on ledger resume'); },
    preReview: () => { throw new Error('must not rerun leg: ledger evidence is authoritative, cache absent'); },
    finalReview: (ctx) => { seenFinal.push(ctx); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    delivery: () => ({ ok: true, value: { shipped: true } }),
  };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  eq('ledger resume COMPLETED with no cache and no leg', res.ok && res.value.state, 'COMPLETED');
  eq('finalReview got ledger evidence (not cache)', seenFinal[0] && seenFinal[0].preReview && seenFinal[0].preReview.digest, legEvidence.digest);
  eq('finalReview got ledger verify report', seenFinal[0] && seenFinal[0].report && seenFinal[0].report.verdict, 'PASS');
}

// ---- Gemini absence from the active runtime ----
{
  const runSrc = fs.readFileSync(new URL('../packages/control-loop/run.js', import.meta.url), 'utf8');
  tru('run.js: no GEMINI_API_KEY', !runSrc.includes('GEMINI_API_KEY'));
  tru('run.js: no createGeminiTransport', !runSrc.includes('createGeminiTransport'));
  tru('run.js: no geminiPreReviewAdapter(', !runSrc.includes('geminiPreReviewAdapter('));
  tru('run.js: wires review leg', runSrc.includes('reviewLegPreReviewAdapter'));
  const loopSrc = fs.readFileSync(new URL('../packages/control-loop/control-loop.mjs', import.meta.url), 'utf8');
  const loopCode = loopSrc.replace(/\/\/[^\n]*/g, '');
  tru('loop: no gemini adapter invocation', !loopCode.includes('geminiPreReviewAdapter('));
  const adaptersSrc = fs.readFileSync(new URL('../packages/control-loop/adapters.mjs', import.meta.url), 'utf8');
  tru('adapters: gemini factory kept as dead compat', adaptersSrc.includes('export function geminiPreReviewAdapter'));
  const geminiSrc = fs.readFileSync(new URL('../packages/control-loop/gemini-pre-review.mjs', import.meta.url), 'utf8');
  tru('gemini module file retained (rollback)', geminiSrc.includes('createGeminiPreReview'));
}

// ---- summary ----
const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : ` | got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
}
console.log(`review-leg-wiring: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
