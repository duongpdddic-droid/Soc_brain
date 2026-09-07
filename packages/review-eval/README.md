# review-eval — persistent review evaluation store (Issue #92 P1-1)

Append-only JSONL evidence store for control-loop review outcomes
(Gemini PRE_REVIEW / GPT-5.6 Sol FINAL_REVIEW verdicts, scores, latency).

## Storage

```
<stateDir>/review-eval/<identityHash>/evaluations.jsonl
```

One JSON object per line, atomic single-line append (same pattern as the
control-loop transitions ledger). Missing dir/file reads back as `[]`.

Record shape (`schemaVersion: 1`):

```json
{
  "schemaVersion": 1,
  "ts": "2026-09-07T00:00:00.000Z",
  "kind": "PRE_REVIEW | FINAL_REVIEW",
  "identityHash": "<32-hex workspace identity>",
  "verdict": "review.verdict",
  "score": "review.score",
  "findingsCount": 0,
  "durationMs": 0,
  "digest": "sha256(JSON.stringify({ verdict, score, findings }))"
}
```

## API

- `appendReviewEvaluation({ stateDir, identityHash, kind, review, reviewDurationMs, now? })`
  validates fail-closed (throws `ReviewEvalInputError` with an explicit
  `REVIEW_EVAL_*` code) and appends one record. Append/IO errors propagate —
  the control-loop sink wrapper owns the persistence policy.
- `readReviewEvaluations({ stateDir, identityHash })` -> parsed records,
  oldest first (`[]` when storage is absent; malformed lines skipped).
- `compareReviewEvaluations(records)` -> `{ total, preReview, finalReview,
  approvals, changesRequested, avgPreReviewMs, avgFinalReviewMs, avgFindings }`.
  `approvals` = verdict `PASS`; `changesRequested` = verdict `REWORK`
  (`BLOCKED` counts in neither — it is an escalation, not a change request).
- `reviewEvalDigest(review)` -> the canonical payload digest (deterministic).

## Ownership

Pure evidence storage: never touches the canonical session record, never
terminalizes, never dispatches, never merges. Wired into
`packages/control-loop/control-loop.mjs` as the failure-isolated
`deps.reviewEvalSink` (`run.js` builds the default sink): a sink throw or
rejection never changes FSM state/reason — the step's transition entry only
gains `evidence.evalPersisted` (`false` on failure, `true` on success).
