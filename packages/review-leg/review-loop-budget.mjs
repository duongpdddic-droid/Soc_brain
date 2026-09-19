#!/usr/bin/env node
// review-loop-budget.mjs — deterministic REVIEW LOOP enforcement helpers
// (REVIEW_LOOP_CONTRACT.md v1: OCR pre-review budget + REWORK convergence).
//
// Pure, authority-free, dependency-free (zero imports): no FSM transition, no
// terminalize, no dispatch, no session/ledger write, no spawn, no network, no
// verdict authority. Consumption point (follow-up, NOT wired here):
// control-loop PRE_REVIEWING step — nextOcrPass decides leg rerun/stop,
// preHandoffCheck gates handoff composition, planRepairEpoch focuses OCR scope
// in a rework leg. No new FSM state, no TRANSITIONS change, no enum change.

export const REVIEW_LOOP_VERSION = '1';
// GATE 3: default max 2 OCR passes per review epoch (OCR-1 DISCOVERY,
// OCR-2 CONVERGENCE). Never a self-created OCR-3.
export const OCR_MAX_PASSES_PER_EPOCH = 2;
export const OCR_PASS_DISCOVERY = 'DISCOVERY';
export const OCR_PASS_CONVERGENCE = 'CONVERGENCE';
// GATE 2: OCR authority is INFORMATIONAL only — never FINAL PASS/REWORK.
export const OCR_AUTHORITY = 'INFORMATIONAL';
export const OCR_BUDGET_EXHAUSTED = 'OCR_BUDGET_EXHAUSTED';
export const HANDOFF_EVIDENCE_INCOMPLETE = 'HANDOFF_EVIDENCE_INCOMPLETE';

// GATE 4: the 7 fields that make a finding repair-cycle eligible.
export const ACTIONABLE_REQUIRED_FIELDS = Object.freeze([
  'file',
  'observedBehavior',
  'invariant',
  'consequence',
  'fixBoundary',
  'testEvidence',
  'passGate',
]);

// Pre-handoff gates (GATE 6): all 8 must be proven before READY_FOR_REVIEW.
export const PRE_HANDOFF_GATES = Object.freeze([
  'requiredFindingsClosed',
  'scopeDiff',
  'diffCheck',
  'targetedTests',
  'relatedRegression',
  'readBack',
  'identityBinding',
  'evidenceComplete',
]);

function fail(code, detail) { return { ok: false, code, detail: detail ?? null }; }

// ---- GATE 3: OCR budget state machine (pure) --------------------------------
// passesUsed 0 -> RUN_DISCOVERY (OCR-1); 1 -> RUN_CONVERGENCE (OCR-2);
// >=2 -> STOP (route BLOCKED with OCR_BUDGET_EXHAUSTED evidence, or handoff
// when no blocker remains — the caller decides, the loop never continues).
export function nextOcrPass({ passesUsed } = {}) {
  const n = Number(passesUsed);
  if (!Number.isInteger(n) || n < 0) return fail('OCR_BUDGET_INPUT_INVALID', 'passesUsed must be an integer >= 0');
  if (n === 0) {
    return { ok: true, action: 'RUN_DISCOVERY', pass: 1, role: OCR_PASS_DISCOVERY, stop: false };
  }
  if (n === 1) {
    return { ok: true, action: 'RUN_CONVERGENCE', pass: 2, role: OCR_PASS_CONVERGENCE, stop: false };
  }
  return { ok: true, action: 'STOP', pass: null, role: null, stop: true, stopCode: OCR_BUDGET_EXHAUSTED };
}

// ---- GATE 4: OCR signal classifier ------------------------------------------
// Fail-direction is ALWAYS advisory: a signal becomes a repair cycle only on
// positive evidence. Advisory signals never block handoff.
const SPECULATIVE_RE = /\b(consider|optionally|nit\b|nitpick|food for thought|just a suggestion|you may want to|it would be nice|should we consider|what if we|style only|purely stylistic|personal preference|optional refactor|cleanup opportunity|cosmetic)\b/i;
const ADVISORY_CATEGORIES = new Set(['style', 'documentation']);

function signalText(f) {
  const parts = [f && f.content, f && f.reason, f && f.note].filter((v) => typeof v === 'string');
  return parts.join(' ');
}

export function classifyOcrSignal(finding) {
  const reasons = [];
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    return { status: 'ADVISORY', reasons: ['not-an-object'] };
  }
  if (typeof finding.path !== 'string' || !finding.path.trim()) {
    reasons.push('missing-file');
  }
  const text = signalText(finding).trim();
  if (text.length < 20) reasons.push('no-evidence-text');
  if (SPECULATIVE_RE.test(text)) reasons.push('speculative-or-preference-wording');
  const cat = typeof finding.category === 'string' ? finding.category.toLowerCase() : '';
  const sev = typeof finding.severity === 'string' ? finding.severity.toLowerCase() : '';
  if (ADVISORY_CATEGORIES.has(cat) && (sev === 'low' || sev === '')) {
    reasons.push('style-or-docs-low-severity');
  }
  if (reasons.length) return { status: 'ADVISORY', reasons };
  return { status: 'ACTIONABLE', reasons: [] };
}

// GATE 4 repair-cycle eligibility: all 7 fields present and non-empty.
export function isActionableRepairFinding(finding) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    return { ok: false, missing: [...ACTIONABLE_REQUIRED_FIELDS] };
  }
  const missing = ACTIONABLE_REQUIRED_FIELDS.filter((k) => {
    const v = finding[k];
    if (v === undefined || v === null) return true;
    if (typeof v === 'string') return !v.trim();
    if (Array.isArray(v)) return v.length === 0;
    return false;
  });
  return missing.length ? { ok: false, missing } : { ok: true, missing: [] };
}

// GATE 3 (post OCR-1): ONE batch repair plan — never per-finding repair cycles.
export function batchRepairPlan(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const batch = [];
  const advisory = [];
  for (const f of list) {
    const c = classifyOcrSignal(f);
    if (c.status === 'ACTIONABLE') batch.push(f);
    else advisory.push({ finding: f, reasons: c.reasons });
  }
  const lines = [
    `BATCH REPAIR (single cycle): address ALL ${batch.length} actionable finding(s) below, then self-verify the WHOLE batch before any OCR rerun.`,
    ...batch.map((f, i) => `${i + 1}. [${f.severity || '?'}] ${f.path || '?'}: ${String((f.content || '')).slice(0, 280)}`),
    advisory.length
      ? `Advisory only (do NOT repair, do NOT block handoff): ${advisory.length} item(s).`
      : 'No advisory items.',
  ];
  return { singleBatch: true, batch, advisory, instruction: lines.join('\n') };
}

// GATE 3 (OCR-2): convergence scope — close OCR-1 findings, direct regression,
// severe new blockers with evidence. Advisory-only items are excluded; full
// re-discovery is disabled by construction (no scope field for it).
export function convergenceScope({ ocr1Findings = [], repairPaths = [], newSignals = [] } = {}) {
  const actionable = ocr1Findings.filter((f) => classifyOcrSignal(f).status === 'ACTIONABLE');
  const excludedAdvisory = ocr1Findings.length - actionable.length;
  const severe = (Array.isArray(newSignals) ? newSignals : []).filter((s) => {
    if (classifyOcrSignal(s).status !== 'ACTIONABLE') return false;
    const sev = typeof s.severity === 'string' ? s.severity.toLowerCase() : '';
    return sev === 'critical' || sev === 'high';
  });
  return {
    verifyClosed: actionable,
    directRegression: [...new Set((Array.isArray(repairPaths) ? repairPaths : []).filter((p) => typeof p === 'string'))],
    newBlockers: severe,
    excludedAdvisory,
    discoveryEnabled: false,
  };
}

// GATE 5: repair-epoch focus after a Final Reviewer REWORK — final findings
// first, direct regression second, severe new blockers third. Never a default
// full repo/diff re-discovery.
export function planRepairEpoch({ reworkFindings = [], repairPaths = [], newSignals = [] } = {}) {
  const conv = convergenceScope({ ocr1Findings: [], repairPaths, newSignals });
  const finals = (Array.isArray(reworkFindings) ? reworkFindings : []).filter(
    (f) => isActionableRepairFinding(f).ok,
  );
  const finalsMissingFields = (Array.isArray(reworkFindings) ? reworkFindings : []).length - finals.length;
  return {
    focusOrder: ['FINAL_FINDINGS', 'DIRECT_REGRESSION', 'NEW_BLOCKERS'],
    finalFindings: finals,
    finalFindingsMissingFields: finalsMissingFields,
    directRegression: conv.directRegression,
    newBlockers: conv.newBlockers,
    discoveryFromScratch: false,
  };
}

// ---- GATE 6: pre-handoff verification gate (pure) ----------------------------
// gates: {<gateName>: {proven:boolean, note?}}. Unproven or absent gate names
// fail closed with the missing list + the next actor (EXECUTOR).
export function preHandoffCheck({ gates = {} } = {}) {
  if (!gates || typeof gates !== 'object' || Array.isArray(gates)) {
    return { ...fail(HANDOFF_EVIDENCE_INCOMPLETE, 'gates object required'), missing: [...PRE_HANDOFF_GATES], nextActor: null };
  }
  const missing = PRE_HANDOFF_GATES.filter((name) => {
    const g = gates[name];
    return !(g && typeof g === 'object' && g.proven === true);
  });
  if (!missing.length) return { ok: true, missing: [] };
  return {
    ...fail(HANDOFF_EVIDENCE_INCOMPLETE, `unproven pre-handoff gates: ${missing.join(', ')}`),
    missing,
    nextActor: {
      actor: 'EXECUTOR',
      do: missing.map((m) => `prove pre-handoff gate: ${m}`),
      verify: 're-run preHandoffCheck until ok:true; never emit READY_FOR_REVIEW while missing is non-empty',
      stop: 'do NOT claim TASK_COMPLETED; exit/process/SESSION signals are not lifecycle evidence',
    },
  };
}

// ---- GATE 2: OCR carries no final authority (pure detector) ------------------
// Any verdict/authority-shaped field anywhere near the evidence fails the check.
const AUTHORITY_KEYS = new Set([
  'verdict', 'finalVerdict', 'approved', 'finalPass', 'rework', 'blocked',
  'terminalize', 'terminalizeToken', 'taskFinish', 'taskBlock', 'merge', 'deploy',
  'dispatchAuthority', 'loopToken',
]);

function collectAuthorityFields(value, seen = new Set()) {
  const hits = [];
  if (!value || typeof value !== 'object' || seen.has(value)) return hits;
  seen.add(value);
  for (const [k, v] of Object.entries(value)) {
    if (AUTHORITY_KEYS.has(k)) hits.push(k);
    if (v && typeof v === 'object') hits.push(...collectAuthorityFields(v, seen));
  }
  return [...new Set(hits)];
}

export function assertNoFinalAuthority(evidence) {
  const fields = collectAuthorityFields(evidence);
  if (fields.length) return { ...fail('OCR_AUTHORITY_VIOLATION', `authority-shaped fields present: ${fields.join(', ')}`), fields };
  return { ok: true, authority: OCR_AUTHORITY, fields: [] };
}

// ---- GATE 7: next-actor instruction (executable routing text) ----------------
export function buildNextActorInstruction({ actor, epoch = null, findings = [], missing = [], verify = '', stop = '' } = {}) {
  const lines = [
    `NEXT_ACTOR: ${actor || 'UNKNOWN'}`,
    `REPAIR_EPOCH: ${epoch === null || epoch === undefined ? '-' : String(epoch)}`,
    `DO: ${(Array.isArray(findings) && findings.length ? findings : missing).map((f, i) => `${i + 1}. ${typeof f === 'string' ? f : JSON.stringify(f)}`).join(' | ') || '(none — hold)'}`,
    `VERIFY: ${verify || 'exact PASS gates from the finding contract'}`,
    `STOP: ${stop || 'do not cross the authority boundary (no merge/deploy/terminalize)'}`,
  ];
  return lines.join('\n');
}
