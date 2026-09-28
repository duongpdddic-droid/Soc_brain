# Task Contract - Phase 1: accept targetRef + expectedHead in workspace provisioning (fail-closed remote ref gate)

Context & Boundaries:
- Repository: duongpdddic-droid/Soc_brain
- Target Branch: fix/issue-244-phase-1-accept-targetref-expectedhead-in-workspa
- Base: origin/main
- PR Number: 248
- Issue Number: 244
- Worktree: worktrees/fix/issue-244-phase-1-accept-targetref-expectedhead-in-workspa
- Compliance: AGENTS.md R1 -> R10; North Star v2.1.0 (Invariant 11, 15; harness over model dependence); Fail-Closed.

## GitHub Label Lifecycle (R8)
- On start: gh pr edit 248 --add-label "status:in-progress"
- On handoff: gh pr edit 248 --add-label "status:review-requested" --remove-label "status:in-progress"
- NEVER self-apply status:approved or status:blocked.

## Objectives
1. Phase 1: accept targetRef + expectedHead in workspace provisioning (fail-closed remote ref gate)

## Implementation Checklist
- [ ] Implementation matches the goal with minimum scope (R4).
- [ ] git status --short clean (no untracked source files).
- [ ] Diff bundle exported to artifacts/diffs/pr-248-diff.zip (R5).

## Verification Gates (exit 0)
- node --test tests/task-bootstrapper.test.mjs
- node --test tests/*.test.mjs
- git diff --check

## Delivery & Handoff (R2, R5, R8)
- git diff origin/main...HEAD > artifacts/diffs/pr-248-changes.diff
- Compress-Archive -Path artifacts/diffs/pr-248-changes.diff -DestinationPath artifacts/diffs/pr-248-diff.zip -Force
- Declare READY_FOR_REVIEW only with real evidence; never self-approve or merge.