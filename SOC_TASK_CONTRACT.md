# Task Contract - Fix the SR11b race-condition load-flake in tests/client-mcp-supervisor.test.mjs (Issue #218 / PR #236). Root-cause the flake systematically (no blind retries, no timeout raising, no test skipping): identify the actual race (e.g. unawaited async setup, event/ordering dependence, missing barrier/await, shared mutable state) and apply the minimal deterministic fix that preserves the test's original intent and coverage. Verification: run the targeted test repeatedly enough to prove the flake is gone (SR11b load-flake), then the related regression subset, then exactly one full offline test suite - all must be 100% pass with captured logs, command, exit code and totals. Follow the 4-step Commit Ordering Protocol (freeze code+tests, atomic commit, capture HEAD SHA, export diff bundle for PR #236, no commits after). Then bring PR #236 to DELIVERING / READY_FOR_HUMAN_GATE awaiting human merge review. Do not self-approve, do not merge.

Context & Boundaries:
- Repository: duongpdddic-droid/Soc_brain
- Target Branch: fix/issue-218-fix-the-sr11b-race-condition-load-flake-in-tests
- Base: origin/main
- PR Number: 237
- Issue Number: 218
- Worktree: worktrees/fix/issue-218-fix-the-sr11b-race-condition-load-flake-in-tests
- Compliance: AGENTS.md R1 -> R10; North Star v2.1.0 (Invariant 11, 15; harness over model dependence); Fail-Closed.

## GitHub Label Lifecycle (R8)
- On start: gh pr edit 237 --add-label "status:in-progress"
- On handoff: gh pr edit 237 --add-label "status:review-requested" --remove-label "status:in-progress"
- NEVER self-apply status:approved or status:blocked.

## Objectives
1. Fix the SR11b race-condition load-flake in tests/client-mcp-supervisor.test.mjs (Issue #218 / PR #236). Root-cause the flake systematically (no blind retries, no timeout raising, no test skipping): identify the actual race (e.g. unawaited async setup, event/ordering dependence, missing barrier/await, shared mutable state) and apply the minimal deterministic fix that preserves the test's original intent and coverage. Verification: run the targeted test repeatedly enough to prove the flake is gone (SR11b load-flake), then the related regression subset, then exactly one full offline test suite - all must be 100% pass with captured logs, command, exit code and totals. Follow the 4-step Commit Ordering Protocol (freeze code+tests, atomic commit, capture HEAD SHA, export diff bundle for PR #236, no commits after). Then bring PR #236 to DELIVERING / READY_FOR_HUMAN_GATE awaiting human merge review. Do not self-approve, do not merge.

## Implementation Checklist
- [ ] Implementation matches the goal with minimum scope (R4).
- [ ] git status --short clean (no untracked source files).
- [ ] Diff bundle exported to artifacts/diffs/pr-237-diff.zip (R5).

## Verification Gates (exit 0)
- node --test tests/task-bootstrapper.test.mjs
- node --test tests/*.test.mjs
- git diff --check

## Delivery & Handoff (R2, R5, R8)
- git diff origin/main...HEAD > artifacts/diffs/pr-237-changes.diff
- Compress-Archive -Path artifacts/diffs/pr-237-changes.diff -DestinationPath artifacts/diffs/pr-237-diff.zip -Force
- Declare READY_FOR_REVIEW only with real evidence; never self-approve or merge.