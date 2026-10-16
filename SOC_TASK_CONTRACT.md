# Task Contract - Fix 10 pre-existing full-suite failures proven by PR #285 evidence: soc-control-agent A1-A5, gateway-notifications #2, client-mcp-regression #2/#3/#5, runtime-sandbox 3 checks. No test skip/delete or timeout raise; web2api flaky out of scope.

Context & Boundaries:
- Repository: duongpdddic-droid/Soc_brain
- Target Branch: task/fix-10-pre-existing-full-suite-failures-proven-b-20261013-190145
- Base: origin/main
- PR Number: 288
- Issue Number: none
- Worktree: worktrees/task/fix-10-pre-existing-full-suite-failures-proven-b-20261013-190145
- Compliance: AGENTS.md R1 -> R10; North Star v2.1.0 (Invariant 11, 15; harness over model dependence); Fail-Closed.

## GitHub Label Lifecycle (R8)
- On start: gh pr edit 288 --add-label "status:in-progress"
- On handoff: gh pr edit 288 --add-label "status:review-requested" --remove-label "status:in-progress"
- NEVER self-apply status:approved or status:blocked.

## Objectives
1. Fix 10 pre-existing full-suite failures proven by PR #285 evidence: soc-control-agent A1-A5, gateway-notifications #2, client-mcp-regression #2/#3/#5, runtime-sandbox 3 checks. No test skip/delete or timeout raise; web2api flaky out of scope.

## Implementation Checklist
- [ ] Implementation matches the goal with minimum scope (R4).
- [ ] git status --short clean (no untracked source files).
- [ ] Diff bundle exported to artifacts/diffs/pr-288-diff.zip (R5).

## Verification Gates (exit 0)
- node --test tests/task-bootstrapper.test.mjs
- node --test tests/*.test.mjs
- git diff --check

## Delivery & Handoff (R2, R5, R8)
- git diff origin/main...HEAD > artifacts/diffs/pr-288-changes.diff
- Compress-Archive -Path artifacts/diffs/pr-288-changes.diff -DestinationPath artifacts/diffs/pr-288-diff.zip -Force
- Declare READY_FOR_REVIEW only with real evidence; never self-approve or merge.
