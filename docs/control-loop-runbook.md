# ControlLoop Runbook (Issue #83)

Canonical operator runbook for Soc_brain ControlLoop v0 (`packages/control-loop/`).
ControlLoop is Soc_brain's own orchestrator: it only terminalizes canonical tasks of
this repository (`duongpdddic-droid/soc_brain`); foreign sessions are refused before
any transition.

## 1. Launch command

```
node packages/control-loop/run.js --issue N --no-dry-run --instruction "TEXT"
```

- `--no-dry-run` is required for a real run; `--instruction` is required with it
  (`MISSING_INSTRUCTION` otherwise). Dry-run (default) only proves the loop binds,
  transitions, and refuses to terminalize — nothing executes.
- `--repo` defaults to `duongpdddic-droid/Soc_brain`; any other repo exits with
  `FOREIGN_REPO`.
- `run.js` resolves `origin/main` as `baseSha`, then `taskStart` provisions the
  canonical session + worktree binding before the loop walks the FSM.

## 2. FSM states and transitions

Canonical source: `LOOP_STATES`, `TERMINAL_STATES`, `ALLOWED_TRANSITIONS` in
`packages/control-loop/control-loop.mjs` (`schemaVersion: "1"`).

States (11):

```
ACCEPTED, ROUTED, EXECUTING, VERIFYING, PRE_REVIEWING,
FINAL_REVIEWING, DECIDING, REWORK, DELIVERING, COMPLETED, BLOCKED
```

Terminal states: `COMPLETED`, `BLOCKED`.

Allowed transitions:

| From | To |
| --- | --- |
| ACCEPTED | ROUTED, BLOCKED |
| ROUTED | EXECUTING, BLOCKED |
| EXECUTING | VERIFYING, BLOCKED |
| VERIFYING | PRE_REVIEWING, BLOCKED |
| PRE_REVIEWING | FINAL_REVIEWING, BLOCKED |
| FINAL_REVIEWING | DECIDING, BLOCKED |
| DECIDING | REWORK, DELIVERING, BLOCKED |
| REWORK | EXECUTING, BLOCKED |
| DELIVERING | COMPLETED, BLOCKED |
| COMPLETED | (terminal, none) |
| BLOCKED | (terminal, none) |

Semantics:

- Every step failure or throw transitions to `BLOCKED` (fail-closed); nothing
  skips ahead.
- `DECIDING -> REWORK` runs a bounded rework leg (max `MAX_REWORK_ROUNDS = 3`
  rounds, crash-safe budget persisted under `<stateDir>/control-loop/<id>/rework/`).
  Rework dispatches the SAME bound executor authority and re-runs verify ->
  pre-review -> final review. Budget exhaustion escalates to canonical `BLOCKED`.
  REWORK verdicts must echo repository/issue/headSha binding or they fail closed
  without dispatching.
- `DECIDING -> DELIVERING` is the READY_FOR_REVIEW boundary: the required
  Telegram notification must yield `API_ACCEPTED` evidence before delivery and
  completion may proceed. Dispatch idempotency is ledger-owned (only
  `API_ACCEPTED` dedupes); a dead transport triggers bounded recovery from the
  persisted ledger. Failure leaves the loop at the DELIVERING tail — recoverable,
  never a fabricated COMPLETED.
- Resume: a loop interrupted mid-round re-enters safely from the persisted
  transitions ledger (rework-leg resume re-asks review once and dedupes dispatch;
  DELIVERING-tail resume replays the persisted PASS decision, never re-asks the
  reviewer).
- Any state's failure path lands in `BLOCKED`, which `taskBlock` terminalizes.

## 3. Operating environment

- `GEMINI_API_KEY` — enables the native Gemini pre-review transport
  (`gemini-transport.mjs`, native REST wire protocol, `x-goog-api-key`). Absent
  env: fail-closed `NO_GEMINI_TRANSPORT` seam.
- `SOC_GPT_CDP_PORT` — enables the ChatGPT Web CDP final-review transport
  (`chatgpt-web-cdp.mjs`). Requires a Chrome instance with remote debugging on
  that port and a logged-in `chatgpt.com` tab; Soc_brain initiates every GPT
  request. Absent env: fail-closed `NO_GPT_TRANSPORT` seam.
- Telegram: config at `~/.ai-pr-reviewer/tg.json`, transport for the
  `telegram-dispatch` primitive. Notification classes are not interchangeable:
  - Best-effort lifecycle notifications (`TASK_STARTED`, `TASK_BLOCKED`):
    missing config records truthful `NOT_ATTEMPTED` evidence and never blocks
    or rolls back the FSM transition they accompany (canonical state is
    persisted first; the dispatch is additive evidence only).
  - `READY_FOR_REVIEW` (the DELIVERING boundary) is a REQUIRED obligation, not
    an optional notification: only persisted `API_ACCEPTED` evidence lets the
    delivery continuation proceed. Missing config => `NOT_ATTEMPTED` =>
    fail-closed `DELIVER_FAILED`; the loop HOLDS at the recoverable DELIVERING
    tail (bounded ledger recovery, `MAX_DELIVERY_ATTEMPTS`) and never
    fabricates completion. "Never blocks" applies only to the best-effort
    class above — never to this gate.
  - `TASK_COMPLETED` is the mandatory completion invariant (section 5): it is
    dispatched exactly once, only after canonical COMPLETED is persisted AND
    read back (inside `taskFinish`, the `persistLifecycleState` write +
    read-back strictly precede the dispatch). The dispatch ledger guarantees
    exactly-once: only `API_ACCEPTED` is terminal delivery evidence and
    permanently dedupes, so a replayed terminalize can never send twice. A
    failed/absent send is recorded as truthful `deliveryEvidence` and stays
    recoverable via explicit bounded recovery (`recoverLifecycleEvent`); it
    never fabricates delivery and never rolls back the terminal transition.

## 4. Canonical evidence locations

All under the Soc_brain state dir (`~/.soc-brain/state` on Windows via
`USERPROFILE`, `~/.soc-brain/state` otherwise; overridable by `stateDir`):

- `control-loop/<identityHash>/transitions.jsonl` — append-only FSM ledger;
  each line `{ schemaVersion, ts, from, to, reason, evidence, identityHash, sessionPath }`.
  Crash recovery reads this file first.
- `control-loop/<identityHash>/rework/<digest>.json` — persisted rework decision
  records (budget + exactly-once dispatch ledger).
- `control-loop/<identityHash>/delivery.json` — delivery lifecycle evidence,
  written only after its lifecycle step completes (ledger-first, no duplicates).
- `sessions/<identityHash>.json` — canonical session record: binding,
  `controlLoop.terminalizeToken`, state.
- Review-ready packet: `<stateDir>/review-ready/<repo>_Issue-<n>_PR-<p>_<7hex>_review-ready.md`
  (the canonical review evidence attached to Telegram delivery).
- Dispatch ledger: `<stateDir>/telegram-dispatch/<identityHash>.jsonl` —
  lifecycle notification evidence (intent/result records; exactly-once proof
  surface for `TASK_COMPLETED`, see section 5).

## 5. Terminalization invariant

Only ControlLoop terminalizes. `run.js` binds a per-loop SHA-256 terminalize
token into the canonical session record
(`session.controlLoop.terminalizeToken`); `loop.terminalize` refuses any terminal
transition (`COMPLETED`/`FAILED`/`BLOCKED`) unless the presenting token matches
the session-bound token. Adapters and external scripts have no access to the
token, so they can never terminalize. GPT stays advisory: it can never dispatch,
mutate the FSM, merge, or terminalize — only ControlLoop walks the rework leg and
delivery continuation.

`TASK_COMPLETED` fires exactly once after persisted canonical COMPLETED: after
the DELIVERING continuation verifies notification evidence (`API_ACCEPTED`) and
completes the delivery lifecycle, ControlLoop transitions DELIVERING -> COMPLETED,
calls `taskFinish({ outcome: 'COMPLETED' })`, then re-reads the persisted session
record — anything but `state === 'COMPLETED'` fails closed
(`TERMINAL_STATE_VERIFY_FAILED`), so the completion is never claimed without real
persisted evidence.

Ordering (inside `taskFinish`/`transitionTerminal`,
`packages/runtime-sandbox/runtime-sandbox.mjs`):

```
persistLifecycleState(COMPLETED) + read-back   (strictly FIRST)
  -> dispatchLifecycleEvent(TASK_COMPLETED)    (exactly-once, ledger-deduped)
  -> deliveryEvidence written back onto the session record (best-effort)
```

Exactly-once proof surface: the dispatch ledger
(`<stateDir>/telegram-dispatch/<identityHash>.jsonl`) holds at most one
`API_ACCEPTED` record for `TASK_COMPLETED` per identity — any later re-entry
dedupes against it (zero transport attempts), which is the structural guarantee
that a replayed terminalize can never re-send.

## E2E validation log

- 2026-09-07: post-#85 E2E validation (Issue #88) - real run PASS.
