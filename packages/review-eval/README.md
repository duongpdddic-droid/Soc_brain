# @soc-brain/review-eval

Append-only persistence for semantic review evaluations (Issue #100, remaining
#92 scope). Storage: `<stateDir>/review-eval/<identityHash>/evaluations.jsonl`
— one JSON record per line, fsync'd per append.

## API

- `appendReviewEvaluation({ stateDir, identityHash, kind, review, reviewDurationMs })`
  Persist one review outcome. `kind` must be `'PRE_REVIEW' | 'FINAL_REVIEW'`.
  `review` must be an `ok:true` envelope whose `value.metadata.model` is a
  non-empty string (PR #99 contract — adapters always stamp model identity;
  absence is a contract violation, never coerced) and whose
  `value.metadata.packet` is `{ name, sha256, truncated }` with a 64-hex
  `sha256` (Issue #100 rework — adapters stamp `packetEvidence(packetInfo)`:
  the sha256 covers the EXACT packet excerpt bytes rendered into the reviewer
  prompt, cryptographically binding the evaluation to the canonical review
  evidence). Fail-closed codes: `STATE_DIR_INVALID`, `IDENTITY_HASH_INVALID`,
  `KIND_INVALID`, `REVIEW_INVALID`, `MODEL_INVALID`, `PACKET_EVIDENCE_INVALID`,
  `EVAL_APPEND_FAILED`.
  Record shape: `{ schemaVersion: 1, ts, kind, identityHash, verdict, score,
  findingsCount, durationMs, digest, packetSha256, packetName,
  packetTruncated }` where `digest` is the sha256 hex of the canonical
  (key-sorted) JSON of `review.value` and `packetSha256` is the sha256 hex of
  the exact packet excerpt the reviewer saw.
- `readReviewEvaluations({ stateDir, identityHash })` → records array.
  Missing storage returns `[]` (not an error); malformed lines are skipped.
- `compareReviewEvaluations(records)` → `{ total, byKind, byVerdict, pairs }`
  counts plus `pairs`: the evidence-bound Gemini-vs-GPT comparison. A
  PRE/FINAL pair exists ONLY when both evaluations carried the SAME
  `packetSha256` (same packet evidence); each `pairs[i]` is
  `{ packetSha256, packetName, packetTruncated,
  pre: { verdict, digest, durationMs }, final: { verdict, digest, durationMs },
  sameVerdict }`; each FINAL record pairs at most once (earliest match).

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
