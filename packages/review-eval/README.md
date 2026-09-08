# @soc-brain/review-eval

Append-only persistence for semantic review evaluations (Issue #100, remaining
#92 scope). Storage: `<stateDir>/review-eval/<identityHash>/evaluations.jsonl`
— one JSON record per line, fsync'd per append.

## API

- `appendReviewEvaluation({ stateDir, identityHash, kind, review, reviewDurationMs })`
  Persist one review outcome. `kind` must be `'PRE_REVIEW' | 'FINAL_REVIEW'`.
  `review` must be an `ok:true` envelope whose `value.metadata.model` is a
  non-empty string (PR #99 contract — adapters always stamp model identity;
  absence is a contract violation, never coerced). Fail-closed codes:
  `STATE_DIR_INVALID`, `IDENTITY_HASH_INVALID`, `KIND_INVALID`,
  `REVIEW_INVALID`, `MODEL_INVALID`, `EVAL_APPEND_FAILED`.
  Record shape: `{ schemaVersion: 1, ts, kind, identityHash, verdict, score,
  findingsCount, durationMs, digest }` where `digest` is the sha256 hex of the
  canonical (key-sorted) JSON of `review.value`.
- `readReviewEvaluations({ stateDir, identityHash })` → records array.
  Missing storage returns `[]` (not an error); malformed lines are skipped.
- `compareReviewEvaluations(records)` → `{ total, byKind, byVerdict }` counts.

## Wiring

`runControlLoop` accepts optional `deps.reviewEvalSink(ctx)` and calls it after
each successful preReview and finalReview step (fresh and rework legs) with
`{ stateDir, identityHash, kind, review, reviewDurationMs }`. Sink failure is
isolated: the FSM state and reason are unchanged and the step transition
records `evalPersisted: false` (`true` on success). Every step transition also
carries `durationMs` (measured wall time); `summarizePhaseLatency(transitions)`
aggregates them into `{ phases: [{ from, to, durationMs }], totalMs }`.

Not a second review truth: the canonical decision chain remains owned by the
control-loop transition ledger and the session record. This store is analytics
evidence only.
