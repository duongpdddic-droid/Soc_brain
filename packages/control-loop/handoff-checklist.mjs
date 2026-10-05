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

// Deterministic gate verdict from the canonical ledger: the verify boundary
// records carry { verdict, evidence:{ ...ExecutionRecord } } (the fast path
// nests one level deeper). preReview/finalReview boundary values are NOT
// gate evidence — they are only accepted when the record actually carries the
// gate payload (an `evidence` object or an exitCode), never from `verdict`
// alone.
function gateEvidenceFromLedger(transitions, verifyEvidence) {
  if (verifyEvidence && typeof verifyEvidence === 'object') {
    return {
      verdict: verifyEvidence.verdict ?? null,
      exitCode: verifyEvidence.exitCode ?? null,
      executionRecordPath: verifyEvidence.executionRecordPath ?? null,
      source: 'explicit verify evidence',
    };
  }
  const list = Array.isArray(transitions) ? transitions : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const rec = list[i];
    const e = rec && rec.evidence && typeof rec.evidence === 'object' && !Array.isArray(rec.evidence) ? rec.evidence : null;
    if (!e || typeof e.verdict !== 'string') continue;
    if (rec.to !== 'PRE_REVIEWING' && rec.to !== 'VERIFYING') continue;
    const inner = e.evidence && typeof e.evidence === 'object' ? e.evidence : null;
    if (!inner && firstDefined(e.exitCode) === null && !('fastPathTerminal' in e)) continue;
    return {
      verdict: e.verdict,
      exitCode: firstDefined(inner && inner.exitCode, e.exitCode),
      executionRecordPath: firstDefined(inner && inner.executionRecordPath, e.executionRecordPath),
      source: `ledger ${rec.from}->${rec.to} (${rec.ts ?? 'no-ts'})`,
    };
  }
  return { verdict: null, exitCode: null, executionRecordPath: null, source: 'no verify boundary record' };
}

// Final review decision from the canonical DECIDING boundary record.
function finalDecisionFromLedger(transitions) {
  const list = Array.isArray(transitions) ? transitions : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const rec = list[i];
    if (!rec || rec.to !== 'DECIDING') continue;
    const e = rec.evidence && typeof rec.evidence === 'object' ? rec.evidence : null;
    if (!e || typeof e.verdict !== 'string') continue;
    return {
      verdict: e.verdict,
      findingsCount: Array.isArray(e.findings) ? e.findings.length : 0,
      ts: rec.ts ?? null,
      reason: rec.reason ?? null,
      source: `ledger ${rec.from}->${rec.to}`,
    };
  }
  return null;
}

function ocrItemFromGate(gate) {
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
        candidate: ir.candidate ?? null,
        boundary,
        verifiedAt: ir.at ?? null,
      });
  }
  const code = gate && gate.code ? gate.code : 'INTERNAL_REVIEW_PENDING';
  const status = code === 'INTERNAL_REVIEW_STALE' ? 'STALE' : 'PENDING';
  return item('ocrInvocation', 'ocrInternalReview', status,
    `${code}: ${String((gate && gate.detail && gate.detail.reason) || 'no clean, candidate-bound OCR review record')}`,
    { code, detail: gate ? gate.detail ?? null : null });
}

function reviewResultItemFromGate(gate, rounds) {
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
  const findingsCount = gate && gate.detail && Number.isInteger(gate.detail.findingsCount)
    ? gate.detail.findingsCount : null;
  return item('reviewResult', 'reviewResolution', code === 'INTERNAL_REVIEW_STALE' ? 'STALE' : 'PENDING',
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
  const verify = gateEvidenceFromLedger(transitions, verifyEvidence);
  const finalDecision = finalDecisionFromLedger(transitions);

  const items = [];
  items.push(ocrItemFromGate(gate));
  items.push(reviewResultItemFromGate(gate, rounds));
  // The required gate is its own item: a PASS here NEVER marks the OCR item
  // DONE (test evidence and review evidence are different records).
  let gateItem;
  if (verify.verdict === 'PASS') {
    gateItem = item('requiredGate', 'requiredGate', 'DONE',
      'deterministic required gate (test:gate) PASS — does not substitute for the OCR review', verify);
  } else {
    const gateNote = verify.verdict
      ? `gate verdict ${verify.verdict} — not a passing required-gate record`
      : 'no required-gate record yet';
    gateItem = item('requiredGate', 'requiredGate', 'PENDING', gateNote, verify);
  }
  items.push(gateItem);

  if (finalDecision && finalDecision.verdict === 'PASS') {
    items.push(item('finalReview', 'finalAndHumanGate', 'DONE',
      'Final Review verdict PASS recorded on the DECIDING boundary', finalDecision));
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
