# Task Contract - Affected-test gate: unified manifest and deterministic verifier integration

Context & Boundaries:
- Repository: duongpdddic-droid/Soc_brain
- Target Branch: task/affected-test-gate-unified-manifest-and-verifier-20261012-204117
- Base: origin/main (merge-base resolved to an exact SHA at plan time)
- PR Number: 285 (Draft)
- Issue Number: none (goal-only admission)
- Worktree: worktrees/task/affected-test-gate-unified-manifest-and-verifier-20261012-204117
- Compliance: AGENTS.md R1 -> R9 (R4&R9 split-authority: NO roadmap edits in this technical task), Fail-Closed, Evidence-First.

## GitHub Label Lifecycle (R8)
- On start: gh pr edit 285 --add-label "status:in-progress"
- On handoff: gh pr edit 285 --add-label "status:review-requested" --remove-label "status:in-progress"
- NEVER self-apply status:approved or status:blocked.

## Objectives
1. ONE canonical test manifest (`tests/tiers.json`): validate orphan/duplicate/ghost/smoke,
   derive `all` from the filesystem inventory (no stored list), delete `tests/test-suites.json`,
   keep `scripts/run-tier-tests.mjs` as a thin wrapper (npm script names unchanged).
2. Deterministic affected/full planner (`packages/executor-launcher/test-plan.mjs`):
   BASE binding -> exact SHA, merge-base + tracked dirty/untracked, reverse-dependency
   closure with visited set, literal dynamic import, explicit path/subsystem mappings,
   old+new paths for add/delete/rename, .md/.txt judged by path (never blanket-ignored),
   unknown -> FULL with reason, contract-required FULL wins, empty/invalid plan never PASS,
   NO_TESTS (docs-only/empty) is an explicit state.
3. Active verifier integration: control plane builds/validates the plan from the task BASE,
   derives argv ONLY from the validated plan, refuses stale/tampered/escaping plans,
   enforces a valid TAP summary (exit 0 alone is never proof), records plan+TAP+runtime
   evidence in TestRunRecord, consumer read-back (`verifyActiveRunPlanBinding`) revalidates
   digest + argv + TAP; legacy `test:gate` semantics preserved.

## Implementation Checklist
- [ ] Implementation matches the goal with minimum scope (R4, no roadmap edits).
- [ ] git status --short clean after commit (disclosed if anything remains).
- [ ] Diff bundle exported to artifacts/diffs/pr-285-diff.zip (R5 + REVIEW-PACKAGING-V1).

## Verification Gates (exit 0)
- node --test tests/task-bootstrapper.test.mjs
- node --test tests/*.test.mjs
- git diff --check

## Delivery & Handoff (R2, R5, R8)
- git diff origin/main...HEAD > artifacts/diffs/pr-285-changes.diff
- Compress-Archive -Path artifacts/diffs/pr-285-changes.diff -DestinationPath artifacts/diffs/pr-285-diff.zip -Force
- Declare READY_FOR_REVIEW only with real evidence; never self-approve or merge.
