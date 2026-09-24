# TASK PROMPT - docs: add feasibility spike verification note for PR 230 cdp loop

## 1. Context & Boundaries
- Repository: duongpdddic-droid/soc_brain
- Target Branch: fix/issue-231-docs-add-feasibility-spike-verification-note-for
- Base: origin/main
- PR Number: 233
- Issue Number: 231
- Compliance: AGENTS.md (R1 -> R10) and North Star v2.1.0 (Invariant 11, 15; harness over model dependence).

## 2. Git Worktree Setup (R1 & R10)
Pre-provisioned isolated worktree: worktrees/fix/issue-231-docs-add-feasibility-spike-verification-note-for
If it must be recreated:
  git worktree add -b fix/issue-231-docs-add-feasibility-spike-verification-note-for worktrees/fix/issue-231-docs-add-feasibility-spike-verification-note-for origin/main

## 3. GitHub Label Lifecycle (R8)
  gh pr edit 233 --add-label "status:in-progress" --remove-label "status:queued,status:changes-requested"
NEVER self-apply status:approved or status:blocked.

## 4. Objectives & Detailed Requirements
1. docs: add feasibility spike verification note for PR 230 cdp loop

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
   git diff origin/main...HEAD > artifacts/diffs/pr-233-changes.diff
   Compress-Archive -Path artifacts/diffs/pr-233-changes.diff -DestinationPath artifacts/diffs/pr-233-diff.zip -Force
4. gh pr edit 233 --add-label "status:review-requested" --remove-label "status:in-progress"
5. Handoff report must print the reviewer clipboard/inspect commands verbatim.