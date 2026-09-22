# Task Contract — S5 Post-Final-Review Dispatcher

## Issue
Implement Stage S5 Post-Final-Review Dispatcher on Soc_brain.

## Objective
Wire the S4 Final Review verdict into run.js to close the execution loop across 3 distinct branches:
1. PASS: Set terminal status to READY_FOR_HUMAN_GATE, generate merge handoff payload with PR link, and exit cleanly.
2. REWORK: Package reviewer findings and re-queue/re-enter the task to the executor session with bounded retry counter.
3. BLOCKED: Fail-closed halt, emit blocker alert, and lock workspace state.

## Acceptance Criteria
- [ ] S5 dispatcher module created at `packages/control-loop/s5-dispatcher.mjs`
- [ ] PASS branch: Sets READY_FOR_HUMAN_GATE status, generates merge handoff payload, exits cleanly
- [ ] REWORK branch: Packages findings, re-queues with bounded retry counter
- [ ] BLOCKED branch: Fail-closed halt, emits blocker alert, locks workspace
- [ ] `run.js` wired to call S5 dispatcher after `runControlLoop()` returns
- [ ] Comprehensive offline test suite covering all 3 branches
- [ ] All offline gates pass:
  - `node --test tests/control-loop-gpt-final.test.mjs`
  - `node --test tests/control-loop-web2api-copy.test.mjs`
  - `node --test tests/control-loop-s4-final-review-integration.test.mjs`
  - `node --test tests/control-loop.test.mjs`
  - `git diff --check`

## Implementation Plan

### Phase 1: Create S5 Dispatcher Module
Create `packages/control-loop/s5-dispatcher.mjs` with:
- `dispatchPostFinalReview({ result, sessionPath, stateDir, identityHash, deps })` - Main dispatcher
- `handlePassBranch({ result, sessionPath, stateDir, identityHash })` - PASS handling
- `handleReworkBranch({ result, sessionPath, stateDir, identityHash })` - REWORK handling
- `handleBlockedBranch({ result, sessionPath, stateDir, identityHash })` - BLOCKED handling
- `generateMergeHandoffPayload({ session, prNumber, headSha })` - Merge payload generation
- `emitBlockerAlert({ session, findings })` - Blocker alert emission
- `lockWorkspaceState({ sessionPath })` - Workspace state locking

### Phase 2: Wire S5 Dispatcher into run.js
Modify `run.js` to:
- Import S5 dispatcher
- After `runControlLoop()` returns, call `dispatchPostFinalReview()`
- Handle S5-specific exit codes and output

### Phase 3: Create Test Suite
Create `tests/control-loop-s5-dispatcher.test.mjs` with:
- Test PASS branch: READY_FOR_HUMAN_GATE status, merge handoff payload
- Test REWORK branch: findings packaging, bounded retry counter
- Test BLOCKED branch: fail-closed halt, blocker alert, workspace lock
- Test edge cases: invalid verdicts, missing session, etc.

### Phase 4: Verify All Gates
Run all required test suites and verify `git diff --check` passes.

## Evidence Requirements
- Test output showing all checks passed
- `git diff --check` output
- PR link with immutable commit SHA
- READY_FOR_FINAL_REVIEW declaration
