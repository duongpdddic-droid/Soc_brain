#!/usr/bin/env node
// autonomous-delivery.test.mjs — system-wide regression for the repository-wide
// autonomous delivery behavior (AUTONOMOUS_DELIVERY_CONTRACT.md v1).
//
// Covers: fixed Web2API-copy provider (no CWA/combine/fallback), canonical
// chain progression, REWORK bound, true-gate-only pause, evidence guard before
// AWAITING_HUMAN_MERGE_DECISION, UI-from-canonical-state, legacy migration,
// and the ONE shared core across all five entries. Pure + deterministic: no
// spawn, no network, no filesystem.
import {
  AUTONOMOUS_DELIVERY_VERSION,
  CONTROLLER_OWNER,
  FIXED_FINAL_REVIEW_PROVIDER,
  MAX_REWORK_ROUNDS,
  TRUE_HUMAN_GATES,
  NON_HUMAN_GATES,
  isTrueHumanGate,
  createDeliveryRecord,
  nextMachineAction,
  advance,
  requireMergeDecisionEvidence,
  deriveReport,
  migrateLegacyTask,
  foregroundBuild,
  canonicalExecutorDispatch,
  resumeDelivery,
  startupRecover,
  onTerminalEvent,
  AWAITING_HUMAN_MERGE_DECISION,
  AWAITING_HUMAN,
} from '../packages/autonomous-delivery/autonomous-delivery.mjs';
import {
  selectFixedFinalReviewTransport,
  refuseFinalReviewFallback,
  FIXED_FINAL_REVIEW_PROVIDER as FIXED2,
} from '../packages/autonomous-delivery/final-review-provider.mjs';
import { selectGptTransport as legacySelect } from '../packages/control-loop/chatgpt-web-cwa.mjs';

const checks = [];
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });

const HEAD = 'b'.repeat(40);
const BASE = 'a'.repeat(40);
const REPO = 'duongpdddic-droid/Soc_brain';
const ISSUE = 200;

function mkRecord() {
  const r = createDeliveryRecord({ taskId: 't-200', repo: REPO, issue: ISSUE, baseSha: BASE });
  if (!r.ok) throw new Error('fixture failed: ' + r.code);
  return r.value;
}

function fullChainToGuard() {
  let r = mkRecord();
  const steps = [
    { type: 'TEST_PASSED', testEvidence: { command: 'node --test tests/x.test.mjs', totals: { pass: 3, fail: 0 }, exitCode: 0 } },
    { type: 'COMMITTED', headSha: HEAD },
    { type: 'PUSHED', remoteSha: HEAD },
    { type: 'PR_DRAFTED', prNumber: 42, draft: true },
    { type: 'PR_READBACK_OK', prHeadSha: HEAD, prState: 'OPEN' },
    { type: 'REVIEW_PASS', verdict: 'PASS', binding: { repository: REPO, issue: ISSUE, headSha: HEAD } },
  ];
  for (const e of steps) {
    const n = advance(r, e);
    if (!n.ok) return { ok: false, code: n.code, detail: n.detail, record: r };
    r = n.value;
  }
  return { ok: true, record: r };
}

async function main() {
  eq('contract version', AUTONOMOUS_DELIVERY_VERSION, '1');
  eq('fixed provider match', FIXED_FINAL_REVIEW_PROVIDER, FIXED2);
  eq('fixed provider value', FIXED_FINAL_REVIEW_PROVIDER, 'chatgpt-plus-web2api-copy');
  eq('rework bound', MAX_REWORK_ROUNDS, 3);
  tru('true gate recognized', isTrueHumanGate('BUSINESS_DECISION_REQUIRED'));
  tru('machine gate rejected', !isTrueHumanGate('TEST_FAIL'));
  tru('allowlist non-empty', TRUE_HUMAN_GATES.length >= 5);
  tru('denylist non-empty', NON_HUMAN_GATES.includes('EXECUTOR_EXITED'));

  // 1. Fixed selector: happy path.
  {
    const s = selectFixedFinalReviewTransport({
      env: { SOC_FINAL_REVIEW_PROVIDER: 'chatgpt-plus-web2api-copy' },
      web2apiFactory: () => ({ name: 'web2api-copy-transport' }),
    });
    eq('fixed selector ok', s.ok, true);
    eq('fixed selector name', s.ok && s.value.name, 'web2api-copy');
  }
  // 2. Mismatch / combine / missing-factory all fail closed, never fallback.
  {
    const m = selectFixedFinalReviewTransport({ env: {}, web2apiFactory: () => ({}) });
    eq('missing flag refused', m.code, 'FINAL_REVIEW_PROVIDER_MISMATCH');
    const w = selectFixedFinalReviewTransport({ env: { SOC_FINAL_REVIEW_PROVIDER: 'cwa' }, web2apiFactory: () => ({}) });
    eq('wrong flag refused', w.code, 'FINAL_REVIEW_PROVIDER_MISMATCH');
    const c = selectFixedFinalReviewTransport({
      env: { SOC_FINAL_REVIEW_PROVIDER: 'chatgpt-plus-web2api-copy', SOC_CWA_FINAL_REVIEW: '1' },
      web2apiFactory: () => ({}),
    });
    eq('combined transport refused', c.code, 'FINAL_REVIEW_TRANSPORT_COMBINED_REFUSED');
    const d = selectFixedFinalReviewTransport({
      env: { SOC_FINAL_REVIEW_PROVIDER: 'chatgpt-plus-web2api-copy', SOC_GPT_CDP_PORT: '9222' },
      web2apiFactory: () => ({}),
    });
    eq('cdp env combined refused', d.code, 'FINAL_REVIEW_TRANSPORT_COMBINED_REFUSED');
    const n = selectFixedFinalReviewTransport({
      env: { SOC_FINAL_REVIEW_PROVIDER: 'chatgpt-plus-web2api-copy' },
      web2apiFactory: null,
    });
    eq('missing factory refused', n.code, 'NO_FINAL_REVIEW_TRANSPORT');
    eq('fallback refused', refuseFinalReviewFallback({ from: 'web2api-copy', to: 'cwa' }).code, 'FINAL_REVIEW_FALLBACK_REFUSED');
  }
  // 3. Legacy CWA selector can no longer select CWA.
  {
    const cwa = legacySelect({ env: { SOC_CWA_FINAL_REVIEW: '1' } });
    eq('legacy CWA transport refused', cwa.transport, null);
  }
  // 4. Full canonical chain reaches EVIDENCE_GUARD then AWAITING_HUMAN_MERGE_DECISION.
  {
    const f = fullChainToGuard();
    eq('chain reaches guard', f.ok && f.record.state, 'EVIDENCE_GUARD');
    const g = requireMergeDecisionEvidence(f.record);
    eq('evidence guard passes', g.ok, true);
    const fin = advance(f.record, { type: 'EVIDENCE_VERIFIED' });
    eq('guard opens merge decision', fin.ok && fin.value.state, AWAITING_HUMAN_MERGE_DECISION);
    const nxt = nextMachineAction(fin.value);
    eq('merge decision pauses', nxt.ok && nxt.value.pause, true);
  }
  // 5. Evidence guard refuses incomplete records with explicit missing[].
  {
    const r = mkRecord();
    const g = requireMergeDecisionEvidence(r);
    eq('empty record refused', g.code, 'MERGE_DECISION_EVIDENCE_INCOMPLETE');
    tru('missing lists testEvidence', g.detail.missing.includes('testEvidence'));
    tru('missing lists headSha', g.detail.missing.includes('headSha'));
  }
  // 6. REWORK loop bounded: 3 rounds cycle, 4th pauses for human business decision.
  {
    let r = mkRecord();
    r = advance(r, { type: 'TEST_PASSED', testEvidence: { exitCode: 0 } }).value;
    r = advance(r, { type: 'COMMITTED', headSha: HEAD }).value;
    r = advance(r, { type: 'PUSHED', remoteSha: HEAD }).value;
    r = advance(r, { type: 'PR_DRAFTED', prNumber: 7, draft: true }).value;
    r = advance(r, { type: 'PR_READBACK_OK', prHeadSha: HEAD, prState: 'OPEN' }).value;
    for (let i = 1; i <= 3; i++) {
      r = advance(r, { type: 'REVIEW_REWORK', findings: [{ id: i }] }).value;
      eq(`rework round ${i} state`, r.state, 'REWORK');
      eq(`rework round ${i} count`, r.reworkRounds, i);
      r = advance(r, { type: 'REPAIR_VERIFIED' }).value;
      eq(`repair ${i} back to testing`, r.state, 'TESTING');
      // re-drive the chain to FINAL_REVIEWING for the next round
      r = advance(r, { type: 'TEST_PASSED', testEvidence: { exitCode: 0 } }).value;
      r = advance(r, { type: 'COMMITTED', headSha: HEAD }).value;
      r = advance(r, { type: 'PUSHED', remoteSha: HEAD }).value;
      r = advance(r, { type: 'PR_DRAFTED', prNumber: 7, draft: true }).value;
      r = advance(r, { type: 'PR_READBACK_OK', prHeadSha: HEAD, prState: 'OPEN' }).value;
    }
    const over = advance(r, { type: 'REVIEW_REWORK', findings: [] });
    eq('4th rework pauses human', over.ok && over.value.state, AWAITING_HUMAN);
    eq('exhaustion reason', over.ok && over.value.humanGate.reasonCode, 'BUSINESS_DECISION_REQUIRED');
    eq('exhaustion detail', over.ok && over.value.humanGate.detail, 'REWORK_BUDGET_EXHAUSTED');
  }
  // 7. Pause ONLY on true human gates.
  {
    const fake = advance(mkRecord(), { type: 'TRUE_GATE', reasonCode: 'TEST_FAIL' });
    eq('machine gate refused as human gate', fake.code, 'DELIVERY_NOT_A_HUMAN_GATE');
    const real = advance(mkRecord(), { type: 'TRUE_GATE', reasonCode: 'CREDENTIAL_REQUIRED', detail: 'need token' });
    eq('true gate pauses', real.ok && real.value.state, AWAITING_HUMAN);
  }
  // 8. UI/reporting derives from canonical state, never narrative.
  {
    const f = fullChainToGuard();
    const withNarrative = { ...f.record, narrative: 'executor says all done, trust me', story: 'shipped it!' };
    const rep = deriveReport(withNarrative);
    eq('report ok', rep.ok, true);
    const text = JSON.stringify(rep.value);
    tru('no narrative leaks', !text.includes('trust me') && !text.includes('shipped it'));
    eq('report state canonical', rep.value.state, 'EVIDENCE_GUARD');
    eq('report provider fixed', rep.value.finalReviewProvider, FIXED_FINAL_REVIEW_PROVIDER);
  }
  // 9. Migration: legacy provider -> fixed, binding preserved, fresh review required.
  {
    const m = migrateLegacyTask({ taskId: 't-200', repo: REPO, issue: ISSUE, baseSha: BASE, headSha: HEAD, prNumber: 9, provider: 'cwa', state: 'FINAL_REVIEWING' });
    eq('migration ok', m.ok, true);
    eq('migrated provider', m.value.record.finalReviewProvider, FIXED_FINAL_REVIEW_PROVIDER);
    eq('migrated state needs fresh review', m.value.record.state, 'FINAL_REVIEWING');
    eq('binding head preserved', m.value.record.evidence.headSha, HEAD);
    const bad = migrateLegacyTask({ taskId: '', repo: REPO, issue: ISSUE });
    eq('bad binding refused', bad.code, 'MIGRATION_BIND_FAILED');
  }
  // 10. ONE shared core: all five entries agree on the same transition.
  {
    const ev = { type: 'TEST_PASSED', testEvidence: { exitCode: 0 } };
    const outs = [
      foregroundBuild({ record: mkRecord(), event: ev }),
      canonicalExecutorDispatch({ record: mkRecord(), event: ev }),
      resumeDelivery({ record: mkRecord(), event: ev }),
      startupRecover({ record: mkRecord(), event: ev }),
      onTerminalEvent({ record: mkRecord(), terminalEvidence: { executionStatus: 'EXITED', testEvidence: { exitCode: 0 } } }),
    ];
    tru('all five entries ok', outs.every((o) => o.ok));
    const states = outs.map((o) => o.value.record.state);
    tru('shared core same state', states.every((s) => s === 'COMMITTING'));
    const entries = outs.map((o) => o.value.entry).sort();
    eq('five entry names', JSON.stringify(entries), JSON.stringify(['canonicalExecutorDispatch', 'foregroundBuild', 'onTerminalEvent', 'resumeDelivery', 'startupRecover']));
  }
  // 11. Terminal wake rejects non-terminal evidence; ownership enforced.
  {
    const nt = onTerminalEvent({ record: mkRecord(), terminalEvidence: { executionStatus: 'RUNNING' } });
    eq('non-terminal refused', nt.code, 'DELIVERY_NOT_A_TERMINAL_EVENT');
    const foreign = advance({ ...mkRecord(), controllerOwner: 'someone-else' }, { type: 'TEST_PASSED', testEvidence: {} });
    eq('owner conflict', foreign.code, 'DELIVERY_OWNER_CONFLICT');
    tru('owner constant', CONTROLLER_OWNER === 'autonomous-delivery-v1');
  }
  // 12. nextMachineAction invariant across the chain.
  {
    eq('testing action', nextMachineAction(mkRecord()).value.do, 'RUN_TARGETED_TESTS');
    const f = fullChainToGuard();
    eq('guard action', nextMachineAction(f.record).value.do, 'VERIFY_MERGE_DECISION_EVIDENCE');
  }

  let failed = 0;
  for (const c of checks) {
    if (!c.ok) { failed += 1; console.error(`FAIL ${c.name}: got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want ?? null)}`); }
  }
  console.log(`autonomous-delivery tests: ${checks.length - failed}/${checks.length} passed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
