> **ARCHIVED 2026-10-24** — This prompt was for PR #288, which has been merged. It is kept in `docs/archive/` for historical reference only; the canonical task prompt now lives in the worktree provisioned by `scripts/Invoke-SocTask.ps1`.

# TASK PROMPT - Fix 10 pre-existing full-suite failures proven by PR #285 evidence: soc-control-agent A1-A5, gateway-notifications #2, client-mcp-regression #2/#3/#5, runtime-sandbox 3 checks. No test skip/delete or timeout raise; web2api flaky out of scope.

## 1. Context & Boundaries
- Repository: duongpdddic-droid/Soc_brain
- Target Branch: task/fix-10-pre-existing-full-suite-failures-proven-b-20261013-190145
- Base: origin/main
- PR Number: 288
- Issue Number: none (create/link if the goal maps to an issue)
- Compliance: AGENTS.md (R1 -> R10) and North Star v2.1.0 (Invariant 11, 15; harness over model dependence).

## 2. Git Worktree Setup (R1 & R10)
Pre-provisioned isolated worktree: worktrees/task/fix-10-pre-existing-full-suite-failures-proven-b-20261013-190145
If it must be recreated:
  git worktree add -b task/fix-10-pre-existing-full-suite-failures-proven-b-20261013-190145 worktrees/task/fix-10-pre-existing-full-suite-failures-proven-b-20261013-190145 origin/main

## 3. GitHub Label Lifecycle (R8)
  gh pr edit 288 --add-label "status:in-progress" --remove-label "status:queued,status:changes-requested"
NEVER self-apply status:approved or status:blocked.

## 4. Objectives & Detailed Requirements
1. Fix 10 pre-existing full-suite failures proven by PR #285 evidence: soc-control-agent A1-A5, gateway-notifications #2, client-mcp-regression #2/#3/#5, runtime-sandbox 3 checks. No test skip/delete or timeout raise; web2api flaky out of scope.

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
   git diff origin/main...HEAD > artifacts/diffs/pr-288-changes.diff
   Compress-Archive -Path artifacts/diffs/pr-288-changes.diff -DestinationPath artifacts/diffs/pr-288-diff.zip -Force
4. gh pr edit 288 --add-label "status:review-requested" --remove-label "status:in-progress"
5. Handoff report must print the reviewer clipboard/inspect commands verbatim.
