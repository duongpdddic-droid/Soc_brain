# Task Contract - fix(harness): harness hardening, model resolution, adapter wiring and safe auto-recovery

Context & Boundaries:
- Repository: duongpdddic-droid/Soc_brain
- Target Branch: task/fix-harness-harness-hardening-model-resolution-a-20260927-192541
- Base: origin/main
- PR Number: 246
- Issue Number: none
- Worktree: worktrees/task/fix-harness-harness-hardening-model-resolution-a-20260927-192541
- Compliance: AGENTS.md R1 -> R10; North Star v2.1.0 (Invariant 11, 15; harness over model dependence); Fail-Closed.

## GitHub Label Lifecycle (R8)
- On start: gh pr edit 246 --add-label "status:in-progress"
- On handoff: gh pr edit 246 --add-label "status:review-requested" --remove-label "status:in-progress"
- NEVER self-apply status:approved or status:blocked.

## Objectives
1. fix(harness): harness hardening, model resolution, adapter wiring and safe auto-recovery

## Implementation Checklist
- [ ] Implementation matches the goal with minimum scope (R4).
- [ ] git status --short clean (no untracked source files).
- [ ] Diff bundle exported to artifacts/diffs/pr-246-diff.zip (R5).

## Verification Gates (exit 0)
- node --test tests/task-bootstrapper.test.mjs
- node --test tests/*.test.mjs
- git diff --check

## Delivery & Handoff (R2, R5, R8)
- git diff origin/main...HEAD > artifacts/diffs/pr-246-changes.diff
- Compress-Archive -Path artifacts/diffs/pr-246-changes.diff -DestinationPath artifacts/diffs/pr-246-diff.zip -Force
- Declare READY_FOR_REVIEW only with real evidence; never self-approve or merge.