# @soc-brain/control-loop

Soc_brain ControlLoop v0 (Issue #69) — canonical orchestration ownership.

## Hard invariants

1. **Only ControlLoop terminalizes a canonical task.** `loop.terminalize()` is
   the only code path that reaches `taskFinish`/`taskBlock`, and it refuses to
   run unless the loop's session-bound token (`session.controlLoop.terminalizeToken`)
   matches. Adapters and E2E scripts have no access to that token.
2. **Adapters return results only.** `adapters.mjs` never imports the terminal
   transition functions and never writes the session record (enforced by
   `tests/control-loop.adapters.test.mjs` G-hard).
3. **Every step appends to the transition ledger**
   (`~/.soc-brain/state/control-loop/<identityHash>/transitions.jsonl`) — the
   audit trail proves each terminal transition followed the full chain.

## FSM

`ACCEPTED → ROUTED → EXECUTING → VERIFYING → PRE_REVIEWING → FINAL_REVIEWING →
DECIDING → {REWORK | DELIVERING | BLOCKED}`; `DELIVERING → COMPLETED`.
Illegal transitions are rejected; adapter failure/thrown steps side-transition
to `BLOCKED` **without** terminalizing (recoverable).

## Usage

```powershell
node packages/control-loop/run.js --issue 69 --dry-run
```

## v0 seams (fail-closed until wired)

- executor transport (`startExecution`/`readExecutionStatus`) — wired (P0-A, Issue #71)
- deterministic verifier (`readExecutionRecord` on the executor's
  `executionRecordPath`) — wired (P0-B, Issue #73): machine-checkable PASS only
  for a canonical EXITED/exitCode-0 record bound to this session; failing or
  stale/mismatched evidence fails closed before any reviewer sees it
- Gemini native API transport — REMOVED from the critical path (Issue #4F):
  `gemini-transport.mjs` / `gemini-pre-review.mjs` / `geminiPreReviewAdapter`
  are dead/unwired compatibility code (rollback only), never imported by
  `run.js`, never invoked, never shadow-run. ACTIVE pre-review is the
  REVIEW-ONLY OCR/OpenCode leg (`review-leg-adapter.mjs` + `review-only.mjs`,
  strict ReviewEvidence v1).
- ChatGPT Web CDP transport — NO_GPT_TRANSPORT
- Telegram config — delivery records NOT_ATTEMPTED (never blocks)

## READY_FOR_REVIEW notification obligation (Issue #69 round-2)

Lifecycle contract enforced structurally inside `runControlLoop`:

```
DECIDING -> DELIVERING   (canonical boundary transition, ledgered FIRST)
  -> dispatchLifecycleEvent(READY_FOR_REVIEW)   [REQUIRED side-effect]
  -> delivery evidence (API_ACCEPTED + message identity) persisted in the
     dispatch ledger (~/.soc-brain/state/telegram-dispatch/<identityHash>.jsonl)
  -> only then DELIVERING -> COMPLETED (+ optional delivery step + terminalize)
```

- The dispatch is loop-owned (never an executor/model memory task).
- Idempotent: ONLY `API_ACCEPTED` is terminal delivery evidence and permanently
  dedupes re-entry; `DELIVERY_FAILED`/`NOT_ATTEMPTED` stay recoverable through
  the bounded `recoverLifecycleEvent()` budget (`MAX_DELIVERY_ATTEMPTS`).
  A dedupe never re-sends (zero transport attempts).
- Fail-closed: without terminal evidence the loop stops (`DELIVER_FAILED`),
  never terminalizes, never claims "delivered".
- The READY_FOR_REVIEW message carries the concise status text plus the
  canonical review-ready packet
  (`~/.soc-brain/review-ready/<repo>_Issue-<n>_PR-<p>_<head>_review-ready.md`)
  attached as ONE UTF-8 document (`sendDocument`). Missing packet is
  fail-closed (`NO_REVIEW_PACKET`); the adapter never fabricates a second
  review truth.

## Canonical delivery lifecycle (P0-F, Issue #81)

After the notification evidence (still only REVIEW_PASS — never
TASK_COMPLETED), the Soc_brain ControlLoop itself performs the canonical
delivery via `delivery.mjs` (`runDeliveryLifecycle`, wired through
`buildDeliveryAdapter` in `adapters.mjs`):

```
PR create + read-back (OPEN at approved head)
  -> squash merge + read-back (PR MERGED with 40-hex mergeCommit, verified
     twice: pr view + gh api commits/<oid>)
  -> Issue close + read-back (CLOSED)
  -> main sync/projection (read-only reachability scan of the merge commit
     and approved head touching packages/control-loop/control-loop.mjs)
  -> task worktree cleanup (canonical workspace primitive, LAST)
  -> canonical terminal transition + PERSISTED session state read-back
     (TASK_COMPLETED only after the real terminal state)
```

- Scope is hard-pinned to `duongpdddic-droid/soc_brain`; every mutation is
  bound to repo + issue + approved 40-hex headSha and re-checked against the
  canonical session before each step.
- Every completed side effect is recorded in the crash-safe delivery ledger
  (`~/.soc-brain/state/control-loop/<id>/delivery.json`) ONLY after its
  read-back verified the real state; resume is ledger-first and adopts
  already-done work from read-backs (a MERGED PR is never re-merged, a CLOSED
  issue is adopted, a replay issues zero remote commands).
- Ambiguous transport results (no exit status, throw, unparseable success)
  fail closed with `DELIVERY_AMBIGUOUS` — re-entry re-derives state, never
  blind-retries.
- `E2E_PASS` / `VERIFICATION_PASS` / `REVIEW_PASS` are necessary but never
  sufficient: any delivery failure leaves the loop at the recoverable
  DELIVERING tail (notification dedupes via the dispatch ledger, delivery
  resumes via the delivery ledger) — no fake TASK_COMPLETED, no
  `notification-evidence-only` completion path.
