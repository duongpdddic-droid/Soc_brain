// rework.mjs — P0-E rework-leg support (Issue #79).
//
// Single responsibility: turn a VALIDATED GPT ReviewResult (verdict REWORK,
// strict shape + echoed binding per gpt-final-review.mjs) into
//   1. a deterministic decision digest (replay/duplicate-dispatch guard), and
//   2. a canonical rework decision record (verbatim findings +
//      evidenceRequests with provenance) that control-loop.mjs persists, and
//   3. the bounded executor re-dispatch instruction.
// This module is a pure helper of control-loop.mjs: it receives already
// validated data, performs NO FSM transition, terminalization, dispatch or
// canonical session write — the ControlLoop owns all of that (hard invariant,
// Issue #79: GPT never dispatches executors, never merges, never
// terminalizes; only Soc_brain ControlLoop mutates the canonical FSM).

import { createHash } from 'node:crypto';

export const REWORK_SCHEMA_VERSION = '1';

// Deterministic digest of a decision: stable key order + canonical JSON, so a
// byte-identical replayed ReviewResult always yields the same digest while
// any new finding/request/metadata changes it.
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function decisionDigest({ identityHash, decision }) {
  return createHash('sha256')
    .update(`${REWORK_SCHEMA_VERSION}|${identityHash}|${stableStringify(decision)}`)
    .digest('hex');
}

// Canonical rework decision record. findings/evidenceRequests are copied
// VERBATIM from the validated decision; provenance records where the payload
// came from and who holds dispatch authority.
export function buildReworkRecord({ identityHash, round, digest, decision, now = () => new Date().toISOString() }) {
  return {
    schemaVersion: REWORK_SCHEMA_VERSION,
    kind: 'rework-decision',
    identityHash,
    round,
    digest,
    persistedAt: now(),
    binding: { ...decision.binding },
    findings: [...decision.findings],
    remediation: [...(decision.remediation ?? [])],
    advisorGuidance: decision.advisorGuidance || decision.guidance || null,
    evidenceRequests: [...decision.evidenceRequests],
    provenance: {
      source: decision.provenance?.source || decision.metadata?.source || 'gpt-final-review (validated ReviewResult, Issue #77)',
      request: decision.provenance ?? null,
      round,
      reviewerConfidence: decision.confidence ?? null,
      reviewerMetadata: decision.metadata ?? null,
      dispatchAuthority: 'Soc_brain ControlLoop only (Issue #79); GPT has no executor authority',
    },
  };
}

// Bounded rework instruction for the executor re-dispatch round. The verdict
// payload is already length-bounded by the GPT validator (50 findings x 500
// chars, 32 evidence requests x 280 chars), so no additional truncation is
// applied here; add a cap only if a real transport rejects the length.
export function buildReworkInstruction({ session, record }) {
  const head = String((record.binding && record.binding.headSha) || 'unpinned').slice(0, 12);
  const lines = [
    `REWORK round ${record.round} for ${session.repo}#${session.issueNumber} @ head ${head} (digest ${record.digest.slice(0, 12)}).`,
    `Provenance: ${record.provenance.source}.`,
    'Address EVERY finding below and provide the requested evidence in the task record.',
    ...(record.advisorGuidance ? [
    'Advisor Guidance (Root Cause Analysis & Direct Fix):',
    record.advisorGuidance,
  ] : []),
  'Findings (verbatim from the validated review):',
    ...record.findings.map((f, i) => `${i + 1}. ${f}`),
  ];
  if (record.evidenceRequests.length) {
    lines.push('Evidence requests:');
    record.evidenceRequests.forEach((e, i) => lines.push(`R${i + 1}. ${e}`));
  }
  if (record.remediation?.length) {
    lines.push('Reviewer remediation (verbatim):', ...record.remediation.map((r, i) => `${i + 1}. ${r}`));
  }
  // Issue #264 root cause (read off the byte-exact round-2 instruction): this
  // function rendered the reviewer's findings VERBATIM and never once told the
  // executor to commit, while one remediation line asked it to commit a path
  // under `artifacts/` that .gitignore excludes — an instruction that cannot be
  // satisfied and does not ask for the one action delivery requires. The
  // publish chain refuses to push a dirty worktree, so anything left
  // uncommitted can never reach review, and `soc_broker_commit` (allowlisted in
  // the executor session) was never mentioned. State the obligation explicitly
  // and separate it from the gitignored evidence export.
  lines.push(
    'COMMIT OBLIGATION (mandatory — before you report done):',
    '1. Every content change you make in the bound task worktree MUST be committed '
      + '(`soc_broker_commit`, or `git add <path> && git commit`). An uncommitted working '
      + 'tree is NOT delivered: the publish chain refuses to push a dirty worktree, so no '
      + 'change you leave uncommitted can ever reach the reviewer.',
    '2. After committing, read back `git rev-parse HEAD` and include that new HEAD in your '
      + 'report. If HEAD did not move, you have not delivered — do not claim completion.',
    '3. `artifacts/` (for example `artifacts/diffs/pr-<PR_NUMBER>-changes.diff`) is listed '
      + 'in .gitignore: export bundles there as EVIDENCE ONLY. NEVER `git add` an '
      + '`artifacts/**` path — git will refuse it and it does NOT satisfy point 1.',
    '4. Commit only files inside the task scope. Do NOT modify, skip, or weaken tests to '
      + 'make a finding disappear.',
  );
  lines.push(
    'You are the executor: work in the bound task worktree only. '
    + 'Do NOT merge, do NOT terminalize, do NOT dispatch other executors.',
  );
  return lines.join('\n');
}


