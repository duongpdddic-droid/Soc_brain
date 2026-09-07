# review-eval — evidence-bound persistent review evaluation store (Issue #92 P1-1)

Append-only JSONL evidence store for control-loop review outcomes
(Gemini PRE_REVIEW / GPT-5.6 Sol FINAL_REVIEW verdicts, latency) bound to the
EXACT canonical evidence the model reviewed.

## Storage

```
<stateDir>/review-eval/<identityHash>/evaluations.jsonl
```

One JSON object per line, atomic single-line append (same pattern as the
control-loop transitions ledger). Missing dir/file reads back as `[]`.

Record shape (`schemaVersion: 2`, evidence-bound):

```json
{
  "schemaVersion": 2,
  "kind": "PRE_REVIEW | FINAL_REVIEW",
  "identityHash": "<32-hex workspace identity>",
  "model": "reviewer model identity (review.value.metadata.model)",
  "reviewTarget": { "repository": "...", "issue": 92, "headSha": "<40-hex>" },
  "evidenceDigest": "sha256 of the EXACT canonical review-ready packet EXCERPT bytes the model reviewed",
  "verdict": "PASS | REWORK | BLOCKED",
  "findings": [{ "message": "...", "severity": "high | low | ... | null" }],
  "confidence": 0.93,
  "durationMs": 0,
  "recordedAt": "2026-09-08T00:00:00.000Z"
}
```

- `reviewTarget` is the packet's canonical Identity triple (repository/issue/
  headSha) — the identity already gated by `collectPreReviewEvidence`.
- `evidenceDigest` is NEVER a digest of the verdict payload: it is
  `sha256(packet excerpt bytes)` as computed by `collectPreReviewEvidence`
  (`packet.sha256` — both model prompts embed `packet.excerpt` only, so the
  digest covers exactly the bytes the reviewers received) and stamped onto the
  adapter result by the pre-review and final-review adapters.
- Findings are normalized: a string finding becomes `{ message, severity: null }`;
  an object `{ severity, message }` finding is preserved verbatim.

## Validation (fail-closed input boundary)

`appendReviewEvaluation({ stateDir, identityHash, kind, review, reviewDurationMs, now? })`
receives the FULL adapter result (`{ ok, value }`) from the loop's
failure-isolated `deps.reviewEvalSink`. It throws `ReviewEvalInputError` with
an explicit `REVIEW_EVAL_*` code BEFORE any append unless the review is a
successful adapter result (`review.ok === true`) carrying all required
evidence-bound fields: `verdict ∈ {PASS, REWORK, BLOCKED}`, finite
`confidence`, non-empty `metadata.model`, `reviewTarget
{repository, issue>0, 40-hex headSha}`, 64-lowercase-hex `evidenceDigest`, and
an array of string/`{severity,message}` findings. Malformed successful-looking
reviews can therefore never create a non-conforming record. Append/IO errors
propagate — the control-loop sink wrapper owns the persistence policy.

## Comparability (`compareReviewEvaluations`)

Returns the legacy aggregates (`total`, `preReview`, `finalReview`,
`approvals`, `changesRequested`, `avgPreReviewMs`, `avgFinalReviewMs`,
`avgFindings` — the last now averages normalized findings-array lengths)
PLUS the evidence-bound comparison result:

- `comparable: true` ONLY for a PRE_REVIEW + FINAL_REVIEW pair with IDENTICAL
  `reviewTarget` AND `evidenceDigest` (repository/headSha matched
  case-insensitively; the latest bound round wins);
  `verdictAgreement` is then `preReview.verdict === finalReview.verdict`,
  and `reviewTarget`/`evidenceDigest` echo the bound round.
- Otherwise `comparable: false`, `verdictAgreement: null`, and
  `notComparableReason` ∈ `NO_BOUND_EVALUATIONS` (no record carries the
  binding), `MISSING_REVIEW_KIND` (same binding but only one kind),
  `REVIEW_TARGET_MISMATCH`, or `EVIDENCE_DIGEST_MISMATCH` (same target,
  different packet bytes).

## Ownership

Pure evidence storage: never touches the canonical session record, never
terminalizes, never dispatches, never merges. Wired into
`packages/control-loop/control-loop.mjs` as the failure-isolated
`deps.reviewEvalSink` (`run.js` builds the default sink): a sink throw or
rejection never changes FSM state/reason — the step's transition entry only
gains `evidence.evalPersisted` (`false` on failure, `true` on success).
