// packages/control-loop/handoff-checklist.mjs — read-only handoff checklist
// projection (OCR internal review -> Soc Loop -> Final Review -> Human Gate).
//
// WHAT THIS IS: a projection of the SAME canonical records the handoff gate
// validates — the session record, the control-loop transition ledger, the
// resolved internal-review gate result and the merge-authorization store.
//
// WHAT THIS IS NOT (hard invariants):
//   - it grants NO authority: no approval, no merge, no lifecycle transition,
//     no terminal status. Reviewers/ControlLoop stay authoritative;
//   - it never writes to the session, the ledger, the review-ready packet or
//     any evidence record — it only renders its own view files;
//   - an item is marked DONE ONLY when a valid record backs it. A passing
//     test gate NEVER marks the OCR item DONE (they are separate items); a
//     missing/errored/stale review stays PENDING/STALE, never DONE.
//
// Sections (the handoff contract, displayed separately from the review-ready
// packet so the packet format/contract stays untouched):
//   1. OCR invocation and candidate binding
//   2. Review result and finding resolution
//   3. Required gate
//   4. Final review and human gate

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { verifyMergeAuthorization } from './merge-authorization.mjs';

export const HANDOFF_CHECKLIST_SCHEMA_VERSION = '1';
export const CHECKLIST_AUTHORITY = 'read-only projection — grants no review, approval, merge or lifecycle authority';
export const CHECKLIST_SECTIONS = Object.freeze([
  'ocrInternalReview',
  'reviewResolution',
  'requiredGate',
  'finalAndHumanGate',
]);
export const CHECKLIST_STATUSES = Object.freeze(['DONE', 'PENDING', 'STALE', 'BLOCKED']);
export const CHECKLIST_ITEM_IDS = Object.freeze([
  'ocrInvocation',
  'reviewResult',
  'requiredGate',
  'finalReview',
  'humanGate',
]);

function item(id, section, status, note, evidence = null) {
  const s = CHECKLIST_STATUSES.includes(status) ? status : 'PENDING';
  return { id, section, status: s, note: String(note ?? ''), evidence: evidence ?? null };
}

// Crash-safe rework round count — the same store the budget counts
// (<stateDir>/control-loop/<identityHash>/rework/<digest>.json).
function reworkRoundCount(stateDir, id) {
  try {
    return fs.readdirSync(path.join(stateDir, 'control-loop', id, 'rework'))
      .filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

// First defined (non-null/undefined) value wins — strict checks only, no
// loose `== null` comparisons.
function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

const HEAD_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

function normHead(v) {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  return HEAD_RE.test(s) ? s : null;
}
function normDigest(v) {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  return DIGEST_RE.test(s) ? s : null;
}

// F1 — distinguish ABSENT (field missing / null) from PRESENT-BUT-INVALID (a
// value IS there but fails the contract format — wrong length/charset, an empty
// string, or the wrong TYPE): a malformed value must never be normalized to
// null and then treated as absent (that would let one side silently drop a
// broken witness and still report BOUND). Diagnostics keep only the
// SIDE/FIELD/REASON — the raw value is NEVER copied into the projection
// because it may contain a secret or a path.
function classifyHead(v) {
  if (v === undefined || v === null) return { absent: true, norm: null, reason: null };
  const reason = typeof v === 'string' ? 'not a 40-hex head' : `not a 40-hex head (received ${typeof v})`;
  const norm = normHead(v);
  return norm ? { absent: false, norm, reason: null } : { absent: false, norm, reason };
}
function classifyDigest(v) {
  if (v === undefined || v === null) return { absent: true, norm: null, reason: null };
  const reason = typeof v === 'string' ? 'not a sha256' : `not a sha256 (received ${typeof v})`;
  const norm = normDigest(v);
  return norm ? { absent: false, norm, reason: null } : { absent: false, norm, reason };
}
// field -> REASON map for the present-but-invalid fields of one witness
// (never the raw value).
function invalidMap(entries) {
  const invalid = {};
  for (const [field, c] of entries) {
    if (c && c.reason) invalid[field] = c.reason;
  }
  return Object.keys(invalid).length ? { invalid } : {};
}

// H2 — the candidate binding of ONE verify boundary record. The OCR record on
// the same boundary (when present) is the primary binding; the execution
// evidence headSha / codeContentDigest / contentDigest is the second witness.
// When BOTH sides are present they must AGREE on the head AND on the content
// digest: any disagreement is CONTRADICTORY — OCR priority must never hide a
// contradicting evidence — and the execution side's own two digest fields must
// also agree with each other (never a silent pick of one). Every rejected
// binding keeps BOTH sides (heads + digests) so the refusal is diagnosable.
function bindingFromVerifyEvidence(e) {
  const inner = e.evidence && typeof e.evidence === 'object' && !Array.isArray(e.evidence) ? e.evidence : null;
  const deep = inner && inner.evidence && typeof inner.evidence === 'object' && !Array.isArray(inner.evidence) ? inner.evidence : null;
  const irOf = (obj) => (obj && obj.internalReview && typeof obj.internalReview === 'object' && !Array.isArray(obj.internalReview)
    ? obj.internalReview
    : null);
  const ir = irOf(e) || irOf(inner) || irOf(deep) || null;
  const execEv = deep || inner || null;

  // F1: classify, never collapse. A present-but-malformed head/digest on
  // EITHER witness becomes a conflict below (CONTRADICTORY) carrying only the
  // side/field/REASON — the raw value is NEVER kept (it may hold a secret or
  // a path). Only a genuinely absent field may be ignored.
  const ocrHeadC = ir && ir.candidate ? classifyHead(ir.candidate.headSha) : null;
  const ocrDigC = ir && ir.candidate ? classifyDigest(ir.candidate.contentDigest) : null;
  const execHeadC = execEv ? classifyHead(execEv.headSha) : null;
  const execCodeC = execEv ? classifyDigest(execEv.codeContentDigest) : null;
  const execContC = execEv ? classifyDigest(execEv.contentDigest) : null;

  const ocr = ir && ir.candidate
    ? {
      headSha: ocrHeadC ? ocrHeadC.norm : null,
      contentDigest: ocrDigC ? ocrDigC.norm : null,
      ...invalidMap([['headSha', ocrHeadC], ['contentDigest', ocrDigC]]),
    }
    : null;
  const execution = execEv
    ? {
      headSha: execHeadC ? execHeadC.norm : null,
      codeContentDigest: execCodeC ? execCodeC.norm : null,
      contentDigest: execContC ? execContC.norm : null,
      ...invalidMap([
        ['headSha', execHeadC],
        ['codeContentDigest', execCodeC],
        ['contentDigest', execContC],
      ]),
    }
    : null;
  const ocrHead = ocr ? ocr.headSha : null;
  const execHead = execution ? execution.headSha : null;
  const ocrDigest = ocr ? ocr.contentDigest : null;

  const conflicts = [];
  if (ocrHeadC && !ocrHeadC.absent && ocrHeadC.norm === null) conflicts.push(`ocr headSha is ${ocrHeadC.reason}`);
  if (ocrDigC && !ocrDigC.absent && ocrDigC.norm === null) conflicts.push(`ocr contentDigest is ${ocrDigC.reason}`);
  if (execHeadC && !execHeadC.absent && execHeadC.norm === null) conflicts.push(`execution headSha is ${execHeadC.reason}`);
  if (execCodeC && !execCodeC.absent && execCodeC.norm === null) conflicts.push(`execution codeContentDigest is ${execCodeC.reason}`);
  if (execContC && !execContC.absent && execContC.norm === null) conflicts.push(`execution contentDigest is ${execContC.reason}`);
  if (ocrHead && execHead && ocrHead !== execHead) conflicts.push('headSha');
  // The execution side may carry BOTH contract digest fields; two different
  // values are a contradiction on their own — never silently pick one.
  let execDigest = null;
  if (execution && execution.codeContentDigest && execution.contentDigest) {
    if (execution.codeContentDigest === execution.contentDigest) {
      execDigest = execution.codeContentDigest;
    } else {
      conflicts.push('execution codeContentDigest/contentDigest disagree');
    }
  } else if (execution) {
    execDigest = execution.codeContentDigest || execution.contentDigest;
  }
  if (ocrDigest && execDigest && ocrDigest !== execDigest) conflicts.push('contentDigest');

  if (conflicts.length) {
    return {
      status: 'CONTRADICTORY', headSha: null, contentDigest: null,
      source: 'binding-contradiction', conflicts, ocr, execution,
    };
  }
  const headSha = ocrHead || execHead;
  if (!headSha) {
    return { status: 'UNBOUND', headSha: null, contentDigest: null, source: null, conflicts: [], ocr, execution };
  }
  return {
    status: 'BOUND',
    headSha,
    contentDigest: ocrDigest || execDigest,
    source: ocrHead ? 'ocr-internal-review' : 'execution-evidence',
    conflicts: [],
    ocr,
    execution,
  };
}

// The deterministic gate payload of a verify boundary (all three shapes:
// standard {verdict, evidence}, fast path {verdict, evidence:<verify value>},
// fixture {verdict, exitCode, evidence:{...}}).
function gateExitCode(e) {
  const inner = e.evidence && typeof e.evidence === 'object' && !Array.isArray(e.evidence) ? e.evidence : null;
  if (!inner) return firstDefined(e.exitCode);
  const deep = inner.evidence && typeof inner.evidence === 'object' && !Array.isArray(inner.evidence) ? inner.evidence : null;
  return firstDefined(deep && deep.exitCode, inner.exitCode, e.exitCode);
}
function gateRecordPath(e) {
  const inner = e.evidence && typeof e.evidence === 'object' && !Array.isArray(e.evidence) ? e.evidence : null;
  if (!inner) return firstDefined(e.executionRecordPath);
  const deep = inner.evidence && typeof inner.evidence === 'object' && !Array.isArray(inner.evidence) ? inner.evidence : null;
  return firstDefined(deep && deep.executionRecordPath, inner.executionRecordPath, e.executionRecordPath);
}

// Deterministic gate verdict + binding from the canonical ledger: the verify
// boundary records carry { verdict, evidence:{ ...ExecutionRecord } } (the fast
// path nests one level deeper). preReview/finalReview boundary values are NOT
// gate evidence — they are only accepted when the record actually carries the
// gate payload (an `evidence` object or an exitCode), never from `verdict`
// alone.
function gateEvidenceFromLedger(transitions, verifyEvidence) {
  if (verifyEvidence && typeof verifyEvidence === 'object') {
    // F1: same contract as the ledger path — a present-but-malformed head or
    // digest here is a CONFLICT (CONTRADICTORY), never normalized away into
    // absent/UNBOUND and never BOUND; genuinely absent stays UNBOUND.
    const headC = classifyHead(verifyEvidence.headSha);
    const digC = classifyDigest(verifyEvidence.contentDigest);
    const explicitConflicts = [];
    if (!headC.absent && headC.norm === null) explicitConflicts.push(`explicit verify evidence headSha is ${headC.reason}`);
    if (!digC.absent && digC.norm === null) explicitConflicts.push(`explicit verify evidence contentDigest is ${digC.reason}`);
    const explicitInvalid = {};
    if (headC.reason) explicitInvalid.headSha = headC.reason;
    if (digC.reason) explicitInvalid.contentDigest = digC.reason;
    let binding;
    if (explicitConflicts.length > 0) {
      binding = { status: 'CONTRADICTORY', headSha: null, contentDigest: null, source: 'binding-contradiction', conflicts: explicitConflicts, invalid: explicitInvalid };
    } else if (headC.norm) {
      binding = { status: 'BOUND', headSha: headC.norm, contentDigest: digC.norm, source: 'explicit-verify-evidence', conflicts: [] };
    } else {
      binding = { status: 'UNBOUND', headSha: null, contentDigest: null, source: null, conflicts: [] };
    }
    return {
      verdict: verifyEvidence.verdict ?? null,
      exitCode: verifyEvidence.exitCode ?? null,
      executionRecordPath: verifyEvidence.executionRecordPath ?? null,
      binding,
      source: 'explicit verify evidence',
    };
  }
  const list = Array.isArray(transitions) ? transitions : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const rec = list[i];
    const e = rec && rec.evidence && typeof rec.evidence === 'object' && !Array.isArray(rec.evidence) ? rec.evidence : null;
    if (!e || typeof e.verdict !== 'string') continue;
    if (rec.to !== 'PRE_REVIEWING' && rec.to !== 'VERIFYING') continue;
    const inner = e.evidence && typeof e.evidence === 'object' && !Array.isArray(e.evidence) ? e.evidence : null;
    if (!inner && firstDefined(e.exitCode) === null && !('fastPathTerminal' in e)) continue;
    return {
      verdict: e.verdict,
      exitCode: gateExitCode(e),
      executionRecordPath: gateRecordPath(e),
      binding: bindingFromVerifyEvidence(e),
      source: `ledger ${rec.from}->${rec.to} (${rec.ts ?? 'no-ts'})`,
    };
  }
  return {
    verdict: null,
    exitCode: null,
    executionRecordPath: null,
    binding: { status: 'UNBOUND', headSha: null, contentDigest: null, source: null },
    source: 'no verify boundary record',
  };
}

// Final review decision from the canonical DECIDING/DELIVERING boundary
// records. DELIVERING is newer and carries the NORMALIZED decision (the loop
// stamps its own session binding there), DECIDING carries the reviewer's raw
// verdict — the first hit wins, and its `binding` is what H2 validates against
// the current candidate.
function finalDecisionFromLedger(transitions) {
  const list = Array.isArray(transitions) ? transitions : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const rec = list[i];
    if (!rec || (rec.to !== 'DECIDING' && rec.to !== 'DELIVERING')) continue;
    const e = rec.evidence && typeof rec.evidence === 'object' && !Array.isArray(rec.evidence) ? rec.evidence : null;
    if (!e || typeof e.verdict !== 'string') continue;
    const b = e.binding && typeof e.binding === 'object' && !Array.isArray(e.binding) ? e.binding : null;
    return {
      verdict: e.verdict,
      findingsCount: Array.isArray(e.findings) ? e.findings.length : 0,
      binding: b ? {
        headSha: normHead(b.headSha),
        repository: typeof b.repository === 'string' ? b.repository : null,
        issue: Number.isInteger(Number(b.issue)) ? Number(b.issue) : null,
      } : null,
      ts: rec.ts ?? null,
      reason: rec.reason ?? null,
      source: `ledger ${rec.from}->${rec.to}`,
    };
  }
  return null;
}

// H4 — provenance-declared adoption modes carry EXTERNAL evidence and are
// exempt from the canonical OCR internal-review record. The checklist must
// describe that exemption instead of claiming a review (or zero findings)
// that never ran; an adoption item is never DONE without its own record.
function adoptionOf(session) {
  if (!session || typeof session !== 'object') return null;
  const p = session.provenance;
  if (p && typeof p === 'object' && p.provenance === 'legacy-adoption') return 'legacy-adoption (Issue #155)';
  const cl = session.controlLoop;
  if (cl && typeof cl === 'object' && cl.reviewOnly === true) return 'review-only adoption (Issue #159)';
  return null;
}

// A positive-integer identity field (issue/pr), accepted only from a number or
// a non-empty numeric string: null/''/false/0/negative must stay null instead
// of being fabricated as 0 by Number(null) === 0.
function posInt(v) {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Sanitized copy of an OCR record's candidate for the projection: the
// contract-shaped fields (headSha / contentDigest / baseSha) are copied ONLY
// when they pass the contract — otherwise null + a REASON is kept, so a
// malformed value (which may hold a secret or a path) can never reach the
// checklist JSON/Markdown.
function safeCandidate(c) {
  if (!c || typeof c !== 'object') return null;
  const head = classifyHead(c.headSha);
  const dig = classifyDigest(c.contentDigest);
  const base = classifyHead(c.baseSha);
  return {
    repo: typeof c.repo === 'string' ? c.repo : null,
    issueNumber: posInt(c.issueNumber),
    prNumber: posInt(c.prNumber),
    identityHash: typeof c.identityHash === 'string' ? c.identityHash : null,
    headSha: head.norm,
    contentDigest: dig.norm,
    baseSha: base.norm,
    ...invalidMap([['headSha', head], ['contentDigest', dig], ['baseSha', base]]),
  };
}

function ocrItemFromGate(gate, adoption) {
  if (gate && gate.ok === true) {
    const ir = gate.value.internalReview;
    const boundary = gate.value.boundary ?? null;
    return item('ocrInvocation', 'ocrInternalReview', 'DONE',
      'OCR internal review ran and is bound to the live candidate', {
        mechanism: ir.mechanism ?? null,
        command: ir.command ?? null,
        runId: ir.runId ?? null,
        model: ir.model ?? null,
        sidecarPath: ir.sidecarPath ?? null,
        candidate: safeCandidate(ir.candidate),
        boundary,
        verifiedAt: ir.at ?? null,
      });
  }
  const code = gate && gate.code ? gate.code : 'INTERNAL_REVIEW_PENDING';
  const status = code === 'INTERNAL_REVIEW_STALE' ? 'STALE' : 'PENDING';
  if (adoption) {
    return item('ocrInvocation', 'ocrInternalReview', status,
      `exemption: ${adoption} — no canonical OCR internal-review record exists for this adoption`,
      { code, exemption: adoption, canonicalOcrRecord: 'ABSENT', detail: gate ? gate.detail ?? null : null });
  }
  return item('ocrInvocation', 'ocrInternalReview', status,
    `${code}: ${String((gate && gate.detail && gate.detail.reason) || 'no clean, candidate-bound OCR review record')}`,
    { code, detail: gate ? gate.detail ?? null : null });
}

function reviewResultItemFromGate(gate, rounds, adoption) {
  if (gate && gate.ok === true) {
    const ir = gate.value.internalReview;
    return item('reviewResult', 'reviewResolution', 'DONE',
      'review result APPROVED with zero findings; prior findings (if any) are resolved by recorded rework rounds', {
        verdict: ir.verdict ?? null,
        findingsCount: Number.isInteger(ir.findingsCount) ? ir.findingsCount : 0,
        reworkRounds: rounds,
        runId: ir.runId ?? null,
      });
  }
  const code = gate && gate.code ? gate.code : 'INTERNAL_REVIEW_PENDING';
  const status = code === 'INTERNAL_REVIEW_STALE' ? 'STALE' : 'PENDING';
  const findingsCount = gate && gate.detail && Number.isInteger(gate.detail.findingsCount)
    ? gate.detail.findingsCount : null;
  if (adoption) {
    return item('reviewResult', 'reviewResolution', status,
      `exemption: ${adoption} — the review result comes from external/adopted evidence; zero findings are NOT claimed`,
      { code, exemption: adoption, findings: 'NOT_CLAIMED', findingsCount, reworkRounds: rounds });
  }
  return item('reviewResult', 'reviewResolution', status,
    findingsCount
      ? `substantive findings unresolved (${findingsCount}) — rework required before handoff`
      : `${code}: no clean review result to resolve against`,
    { code, findingsCount, reworkRounds: rounds });
}

export function buildHandoffChecklist({
  stateDir = null,
  session = null,
  identityHash: id = null,
  transitions = null,
  internalReviewGate = null,
  verifyEvidence = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!session || typeof session !== 'object') {
    return { ok: false, code: 'CHECKLIST_SESSION_MISSING', detail: 'session record is required' };
  }
  if (typeof id !== 'string' || !id) {
    return { ok: false, code: 'CHECKLIST_IDENTITY_MISSING', detail: 'identityHash is required' };
  }
  // Same canonical state root the caller projected from; the session's
  // controlPlane.stateDir is only a fallback for standalone readers.
  const root = typeof stateDir === 'string' && stateDir ? stateDir : stateDirOf(session);
  if (!root) return { ok: false, code: 'CHECKLIST_STATE_DIR_MISSING', detail: 'stateDir is required' };
  const repo = typeof session.repo === 'string' ? session.repo : null;
  const issue = Number(session.issueNumber);
  const pr = Number.isInteger(session.prNumber) ? session.prNumber : null;
  const headSha = typeof session.headSha === 'string' ? session.headSha.toLowerCase() : null;
  if (!repo || !Number.isInteger(issue) || issue <= 0 || !headSha) {
    return { ok: false, code: 'CHECKLIST_IDENTITY_INVALID', detail: { repo, issue: session.issueNumber ?? null, headSha } };
  }

  const rounds = reworkRoundCount(root, id);
  const gate = internalReviewGate && typeof internalReviewGate === 'object' ? internalReviewGate : null;
  const adoption = adoptionOf(session);
  const verify = gateEvidenceFromLedger(transitions, verifyEvidence);
  const finalDecision = finalDecisionFromLedger(transitions);
  const ocrDigest = gate && gate.ok === true && gate.value.internalReview && gate.value.internalReview.candidate
    ? normDigest(gate.value.internalReview.candidate.contentDigest)
    : null;

  const items = [];
  items.push(ocrItemFromGate(gate, adoption));
  items.push(reviewResultItemFromGate(gate, rounds, adoption));

  // H2 — the required gate is DONE only when its evidence is bound to the
  // CURRENT candidate and contradiction-free. A passing gate still NEVER marks
  // the OCR item DONE (test evidence and review evidence are different
  // records), and unbound / stale / contradictory / non-zero-exit evidence is
  // never DONE.
  const gb = verify.binding;
  let gateItem;
  if (verify.verdict !== 'PASS') {
    const gateNote = verify.verdict
      ? `gate verdict ${verify.verdict} — not a passing required-gate record`
      : 'no required-gate record yet';
    gateItem = item('requiredGate', 'requiredGate', 'PENDING', gateNote, verify);
  } else if (verify.exitCode !== 0) {
    const shown = verify.exitCode === null || verify.exitCode === undefined ? 'absent' : verify.exitCode;
    gateItem = item('requiredGate', 'requiredGate', 'PENDING',
      `required-gate record does not prove a zero exit (exitCode=${shown})`, verify);
  } else if (!gb || gb.status === 'UNBOUND') {
    gateItem = item('requiredGate', 'requiredGate', 'PENDING',
      'gate evidence is not bound to the current candidate (no headSha/binding on the verify record)', verify);
  } else if (gb.status === 'CONTRADICTORY') {
    // H2/F1: the refusal is diagnosable — it names WHAT disagreed (side +
    // field + reason, from `conflicts`) and shows the validated values of BOTH
    // sides. An invalid field prints `INVALID`; the raw value is never echoed.
    const sideField = (side, field, short) => {
      if (side.invalid && Object.prototype.hasOwnProperty.call(side.invalid, field)) return `${field}=INVALID`;
      const v = side[field];
      if (v === null || v === undefined) return `${field}=absent`;
      return `${field}=${short ? String(v).slice(0, 7) : v}`;
    };
    const sides = [];
    if (gb.ocr) {
      sides.push(`reviewed ${sideField(gb.ocr, 'headSha', true)} ${sideField(gb.ocr, 'contentDigest', false)}`);
    }
    if (gb.execution) {
      sides.push(`execution ${sideField(gb.execution, 'headSha', true)} ${sideField(gb.execution, 'codeContentDigest', false)} ${sideField(gb.execution, 'contentDigest', false)}`);
    }
    const what = gb.conflicts && gb.conflicts.length ? gb.conflicts.join(', ') : 'binding';
    const sideText = sides.length ? ` — ${sides.join(' | ')}` : '';
    gateItem = item('requiredGate', 'requiredGate', 'PENDING',
      `gate evidence contradicts the OCR review record [${what}]${sideText}`, verify);
  } else if (gb.headSha !== headSha) {
    gateItem = item('requiredGate', 'requiredGate', 'PENDING',
      `gate evidence is bound to ${String(gb.headSha).slice(0, 7)}, current candidate is ${String(headSha).slice(0, 7)}`, verify);
  } else if (ocrDigest && gb.contentDigest && gb.contentDigest !== ocrDigest) {
    // Source-agnostic cross-check: whichever side produced the bound digest,
    // it must equal the reviewed digest (the binding above already flags a
    // contradiction; this keeps the refusal even if a future source skips it).
    gateItem = item('requiredGate', 'requiredGate', 'PENDING',
      `gate contentDigest ${gb.contentDigest} contradicts the OCR review record ${ocrDigest}`, verify);
  } else {
    gateItem = item('requiredGate', 'requiredGate', 'DONE',
      `deterministic required gate (test:gate) PASS bound to ${String(gb.headSha).slice(0, 7)} — does not substitute for the OCR review`, verify);
  }
  items.push(gateItem);

  // H2 — the final review is DONE only for a PASS whose binding names the
  // CURRENT candidate: a decision with no binding (or bound elsewhere) stays
  // PENDING, a BLOCKED verdict stays BLOCKED.
  if (finalDecision && finalDecision.verdict === 'PASS') {
    const fb = finalDecision.binding;
    if (!fb || !fb.headSha) {
      items.push(item('finalReview', 'finalAndHumanGate', 'PENDING',
        'final decision carries no candidate binding — it cannot be marked DONE', finalDecision));
    } else if (fb.headSha !== headSha) {
      items.push(item('finalReview', 'finalAndHumanGate', 'PENDING',
        `final decision is bound to ${fb.headSha.slice(0, 7)}, current candidate is ${String(headSha).slice(0, 7)}`, finalDecision));
    } else if (fb.repository && fb.repository.toLowerCase() !== String(repo).toLowerCase()) {
      items.push(item('finalReview', 'finalAndHumanGate', 'PENDING',
        'final decision binding names a different repository', finalDecision));
    } else if (fb.issue !== null && fb.issue !== issue) {
      items.push(item('finalReview', 'finalAndHumanGate', 'PENDING',
        'final decision binding names a different issue', finalDecision));
    } else {
      items.push(item('finalReview', 'finalAndHumanGate', 'DONE',
        `Final Review verdict PASS bound to the current candidate (${headSha.slice(0, 7)})`, finalDecision));
    }
  } else if (finalDecision && finalDecision.verdict === 'BLOCKED') {
    items.push(item('finalReview', 'finalAndHumanGate', 'BLOCKED',
      'Final Review verdict BLOCKED', finalDecision));
  } else {
    items.push(item('finalReview', 'finalAndHumanGate', 'PENDING',
      finalDecision ? `Final Review verdict ${finalDecision.verdict} — not PASS` : 'no final-review decision record yet',
      finalDecision));
  }

  // Human gate: only an exact-bound human merge-authorization record counts.
  // The S5 handoff record alone means "awaiting the human", never DONE.
  let humanDetail = null;
  let humanStatus = 'PENDING';
  let humanNote = 'human gate not reached — awaiting the S5 handoff record';
  const s5 = session.controlLoop && session.controlLoop.s5Dispatcher && typeof session.controlLoop.s5Dispatcher === 'object'
    ? session.controlLoop.s5Dispatcher
    : null;
  if (pr) {
    const auth = verifyMergeAuthorization({
      stateDir: root, identityHash: id,
      repo, issue, pullRequest: pr, reviewedHeadSha: headSha,
    });
    if (auth.ok === true) {
      humanStatus = 'DONE';
      humanNote = 'human merge authorization recorded for this exact HEAD';
      humanDetail = { authorizedBy: auth.record?.authorizedBy ?? null, at: auth.record?.at ?? null, bound: auth.record?.bound ?? null };
    } else {
      humanDetail = { code: auth.code ?? null };
      if (s5 && s5.terminalStatus === 'READY_FOR_HUMAN_GATE') {
        humanNote = `awaiting human merge authorization (S5 handoff recorded${auth.code ? `; ${auth.code}` : ''})`;
      } else {
        humanNote = `human gate not reached — awaiting the S5 handoff record${auth.code ? ` (${auth.code})` : ''}`;
      }
    }
  } else {
    humanNote = 'human gate not reachable — session has no bound pull request';
  }
  items.push(item('humanGate', 'finalAndHumanGate', humanStatus, humanNote, humanDetail));

  const complete = items.every((i) => i.status === 'DONE');
  return {
    ok: true,
    value: {
      schemaVersion: HANDOFF_CHECKLIST_SCHEMA_VERSION,
      authority: CHECKLIST_AUTHORITY,
      identity: { repository: repo, issue, pullRequest: pr, headSha, identityHash: id },
      status: complete ? 'COMPLETE' : 'IN_PROGRESS',
      sections: CHECKLIST_SECTIONS,
      items,
      projectedAt: now(),
    },
  };
}

// The loop writes its own records under <stateDir>/control-loop/<identityHash>;
// the session's controlPlane.stateDir is the canonical state root when set.
function stateDirOf(session) {
  const cp = session.controlPlane && typeof session.controlPlane === 'object' ? session.controlPlane : {};
  return typeof cp.stateDir === 'string' && cp.stateDir ? cp.stateDir : null;
}

function renderMarkdown(checklist) {
  const titles = {
    ocrInternalReview: '1. OCR invocation and candidate binding',
    reviewResolution: '2. Review result and finding resolution',
    requiredGate: '3. Required gate',
    finalAndHumanGate: '4. Final review and human gate',
  };
  const lines = [];
  const id = checklist.identity;
  lines.push(`# Handoff checklist — ${id.repository} Issue #${id.issue}${id.pullRequest ? ` · PR #${id.pullRequest}` : ''}`);
  lines.push('');
  lines.push(`> ${checklist.authority}. Canonical records are the SSOT; this file is an ephemeral view.`);
  lines.push('');
  lines.push(`- headSha: ${id.headSha}`);
  lines.push(`- status: **${checklist.status}**`);
  lines.push(`- projectedAt: ${checklist.projectedAt}`);
  lines.push('');
  for (const sec of checklist.sections) {
    lines.push(`## ${titles[sec] ?? sec}`);
    for (const i of checklist.items.filter((x) => x.section === sec)) {
      const mark = i.status === 'DONE' ? '[x]' : '[ ]';
      lines.push(`- ${mark} \`${i.id}\` — **${i.status}**: ${i.note}`);
      if (i.evidence) lines.push(`  - evidence: ${JSON.stringify(i.evidence)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// Writes the two view files (JSON for tooling, Markdown for humans) under the
// loop's own directory — never into the review-ready packet directory, so the
// packet resolver (packetPathFor) can never mistake a checklist for a packet.
export function projectHandoffChecklist({
  stateDir = null,
  identityHash: id = null,
  session = null,
  transitions = null,
  internalReviewGate = null,
  verifyEvidence = null,
  outputDir = null,
  now = () => new Date().toISOString(),
} = {}) {
  const built = buildHandoffChecklist({ stateDir, session, identityHash: id, transitions, internalReviewGate, verifyEvidence, now });
  if (!built.ok) return built;
  // Resolve the state root BEFORE any path math: a missing root is a typed
  // failure, never an unguarded path.join throw at the projection boundary.
  const rootDir = outputDir || (typeof stateDir === 'string' && stateDir ? stateDir : stateDirOf(session));
  if (!rootDir) return { ok: false, code: 'CHECKLIST_STATE_DIR_MISSING', detail: 'stateDir is required to project the checklist' };
  const dir = path.join(rootDir, 'control-loop', id);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const jsonPath = path.join(dir, 'handoff-checklist.json');
    const mdPath = path.join(dir, 'handoff-checklist.md');
    const json = JSON.stringify(built.value, null, 2);
    // Unique tmp per writer: two concurrent projections of the SAME identity
    // can never interleave bytes on one temp path (atomic rename per file).
    const tmp = () => `${randomUUID()}.tmp`;
    const jsonTmp = path.join(dir, tmp());
    const mdTmp = path.join(dir, tmp());
    fs.writeFileSync(jsonTmp, json, 'utf8');
    fs.renameSync(jsonTmp, jsonPath);
    fs.writeFileSync(mdTmp, renderMarkdown(built.value), 'utf8');
    fs.renameSync(mdTmp, mdPath);
    return { ok: true, value: { checklist: built.value, jsonPath, mdPath } };
  } catch (e) {
    return { ok: false, code: 'CHECKLIST_WRITE_FAILED', detail: String((e && e.message) || e) };
  }
}
