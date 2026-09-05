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

- executor transport (`startExecution`) — NO_EXECUTOR_TRANSPORT
- verifier primitive (review-ready projection) — NO_VERIFIER_PRIMITIVE
- Gemini native API transport — NO_GEMINI_TRANSPORT
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
