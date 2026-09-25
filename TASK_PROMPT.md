# TASK PROMPT - Fix the SR11b race-condition load-flake in tests/client-mcp-supervisor.test.mjs (Issue #218 / PR #236). Root-cause the flake systematically (no blind retries, no timeout raising, no test skipping): identify the actual race (e.g. unawaited async setup, event/ordering dependence, missing barrier/await, shared mutable state) and apply the minimal deterministic fix that preserves the test's original intent and coverage. Verification: run the targeted test repeatedly enough to prove the flake is gone (SR11b load-flake), then the related regression subset, then exactly one full offline test suite - all must be 100% pass with captured logs, command, exit code and totals. Follow the 4-step Commit Ordering Protocol (freeze code+tests, atomic commit, capture HEAD SHA, export diff bundle for PR #236, no commits after). Then bring PR #236 to DELIVERING / READY_FOR_HUMAN_GATE awaiting human merge review. Do not self-approve, do not merge.

## 1. Context & Boundaries
- Repository: duongpdddic-droid/Soc_brain
- Target Branch: fix/issue-218-fix-the-sr11b-race-condition-load-flake-in-tests
- Base: origin/main
- PR Number: 237
- Issue Number: 218
- Compliance: AGENTS.md (R1 -> R10) and North Star v2.1.0 (Invariant 11, 15; harness over model dependence).

## 2. Git Worktree Setup (R1 & R10)
Pre-provisioned isolated worktree: worktrees/fix/issue-218-fix-the-sr11b-race-condition-load-flake-in-tests
If it must be recreated:
  git worktree add -b fix/issue-218-fix-the-sr11b-race-condition-load-flake-in-tests worktrees/fix/issue-218-fix-the-sr11b-race-condition-load-flake-in-tests origin/main

## 3. GitHub Label Lifecycle (R8)
  gh pr edit 237 --add-label "status:in-progress" --remove-label "status:queued,status:changes-requested"
NEVER self-apply status:approved or status:blocked.

## 4. Objectives & Detailed Requirements
1. Fix the SR11b race-condition load-flake in tests/client-mcp-supervisor.test.mjs (Issue #218 / PR #236). Root-cause the flake systematically (no blind retries, no timeout raising, no test skipping): identify the actual race (e.g. unawaited async setup, event/ordering dependence, missing barrier/await, shared mutable state) and apply the minimal deterministic fix that preserves the test's original intent and coverage. Verification: run the targeted test repeatedly enough to prove the flake is gone (SR11b load-flake), then the related regression subset, then exactly one full offline test suite - all must be 100% pass with captured logs, command, exit code and totals. Follow the 4-step Commit Ordering Protocol (freeze code+tests, atomic commit, capture HEAD SHA, export diff bundle for PR #236, no commits after). Then bring PR #236 to DELIVERING / READY_FOR_HUMAN_GATE awaiting human merge review. Do not self-approve, do not merge.

## 5. Implementation Checklist
- [ ] Goal delivered with minimum scope (R4), no self-expanded refactor.
- [ ] Targeted + regression + exactly one full suite PASS (global test policy).
- [ ] git status --short shows a clean worktree.

## 6. Verification Gates (mandatory PASS 100%)
  node --test tests/task-bootstrapper.test.mjs
  node --test tests/*.test.mjs
  git diff --check

## 7. Delivery & Handoff Protocol (R2, R5 & R8)
1. Commit clean, push the working branch (no force-push).
2. PR OPEN, draft: false.
3. Export the diff bundle:
   New-Item -ItemType Directory -Force -Path artifacts/diffs
   git diff origin/main...HEAD > artifacts/diffs/pr-237-changes.diff
   Compress-Archive -Path artifacts/diffs/pr-237-changes.diff -DestinationPath artifacts/diffs/pr-237-diff.zip -Force
4. gh pr edit 237 --add-label "status:review-requested" --remove-label "status:in-progress"
5. Handoff report must print the reviewer clipboard/inspect commands verbatim.