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
