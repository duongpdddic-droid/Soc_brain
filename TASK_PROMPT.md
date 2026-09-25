# TASK PROMPT - Fix SR11b load flake race in client-mcp-supervisor test

## 1. Context & Boundaries
- Repository: duongpdddic-droid/Soc_brain
- Target Branch: fix/issue-218-fix-sr11b-load-flake-race-in-client-mcp-supervis
- Base: origin/main
- PR Number: 236
- Issue Number: 218
- Compliance: AGENTS.md (R1 -> R10) and North Star v2.1.0 (Invariant 11, 15; harness over model dependence).

## 2. Git Worktree Setup (R1 & R10)
Pre-provisioned isolated worktree: worktrees/fix/issue-218-fix-sr11b-load-flake-race-in-client-mcp-supervis
If it must be recreated:
  git worktree add -b fix/issue-218-fix-sr11b-load-flake-race-in-client-mcp-supervis worktrees/fix/issue-218-fix-sr11b-load-flake-race-in-client-mcp-supervis origin/main

## 3. GitHub Label Lifecycle (R8)
  gh pr edit 236 --add-label "status:in-progress" --remove-label "status:queued,status:changes-requested"
NEVER self-apply status:approved or status:blocked.

## 4. Objectives & Detailed Requirements
1. Fix SR11b load flake race in client-mcp-supervisor test

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
   git diff origin/main...HEAD > artifacts/diffs/pr-236-changes.diff
   Compress-Archive -Path artifacts/diffs/pr-236-changes.diff -DestinationPath artifacts/diffs/pr-236-diff.zip -Force
4. gh pr edit 236 --add-label "status:review-requested" --remove-label "status:in-progress"
5. Handoff report must print the reviewer clipboard/inspect commands verbatim.