# Task Contract — S5 Post-Final-Review Dispatcher

## Issue
Implement Stage S5 Post-Final-Review Dispatcher on Soc_brain.

## Objective
Wire the S4 Final Review verdict into run.js to close the execution loop across 2 terminal branches:
1. **PASS (COMPLETED):** Set terminal status to READY_FOR_HUMAN_GATE, generate merge handoff payload with PR link, and exit cleanly.
2. **BLOCKED:** Fail-closed halt, emit blocker alert, and lock workspace state.

**REWORK is handled internally by the FSM loop** — the control loop's DECIDING policy consumes REWORK verdicts and either re-dispatches the executor or escalates to BLOCKED on budget exhaustion. The S5 dispatcher only sees terminal states (COMPLETED or BLOCKED).

## Acceptance Criteria
- [x] S5 dispatcher module created at `packages/control-loop/s5-dispatcher.mjs`
- [x] PASS branch: Sets READY_FOR_HUMAN_GATE status, generates merge handoff payload with `{ verdict: 'PASS' }` decision, exits cleanly
- [x] BLOCKED branch: Fail-closed halt, extracts findings from `result.decision`, emits blocker alert, locks workspace
- [x] `run.js` wired to call S5 dispatcher after `runControlLoop()` returns with fail-closed error handling
- [x] BLOCKED terminal return carries `decision` (review verdict with findings/evidenceRequests) for S5 extraction
- [x] Comprehensive offline test suite covering both terminal branches
- [x] All offline gates pass:
  - `node --test tests/control-loop-gpt-final.test.mjs`
  - `node --test tests/control-loop-web2api-copy.test.mjs`
  - `node --test tests/control-loop-s4-final-review-integration.test.mjs`
  - `node --test tests/control-loop.test.mjs`
  - `node --test tests/control-loop-s5-dispatcher.test.mjs`
  - `git diff --check`

## runControlLoop() Output Contracts
- **PASS:** `{ ok: true, value: { state: 'COMPLETED', notification, delivery, terminalize, loopToken } }`
- **BLOCKED:** `{ ok: true, value: { state: 'BLOCKED', terminalize, decision, loopToken } }`
- **Error:** `{ ok: false, code, detail }`

REWORK is never a terminal output — it is consumed internally by `decide()` and `runReworkLeg()`.
