# Task Contract - Selective Omnigent integration: capability declaration, OpenCode native adapter, event delivery

Context & Boundaries:
- Repository: duongpdddic-droid/Soc_brain
- Target Branch: agent/def4112c010d4793da74be680e38d3b2
- Base: origin/main (2b8e5f639c68a7cf039574d524d76d9735dea24e)
- PR Number: 283
- Issue Number: none (local task 9000035, identityHash def4112c010d4793da74be680e38d3b2)
- Worktree: C:\Users\Admin\.soc-brain\worktrees\agent\def4112c010d4793da74be680e38d3b2
- Upstream source under investigation: omnigent-ai/omnigent @ 12a0d5c8737571980b84869c2df00b17d0b42c9b
- Compliance: AGENTS.md R1 -> R10; Fail-Closed; minimum scope (R4).

## GitHub Label Lifecycle (R8)
- On start: gh pr edit 283 --add-label "status:in-progress" (DONE)
- On handoff: gh pr edit 283 --add-label "status:review-requested" --remove-label "status:in-progress"
- NEVER self-apply status:approved or status:blocked.

## Objectives
1. Investigate real Omnigent source (3 groups: capability declaration/probes, OpenCode
   native integration, event delivery/recovery) at the pinned SHA; read Soc_brain
   counterparts; produce a reuse/port/adapt/omit mapping with evidence.
2. Selectively implement the proven-gap parts that reduce Soc_brain total
   implementation + verification + maintenance cost. Soc_brain remains sole
   control-plane authority. No new runtime Python/FastAPI/database/UI, no new
   dependency, no new control plane/session store/daemon/plugin framework.
3. Preserve Omnigent attribution/LICENSE notices for any ported code.
4. Independent of Issue #282 (learning harness): no workspace/branch/scope change.

## Implementation Checklist
- [ ] Mapping table (upstream file/behavior -> Soc_brain module -> reuse/port/adapt/omit) backed by real source reads.
- [ ] Selected parts implemented with tests; capability declaration never auto-VERIFIED from mocks.
- [ ] git status --short clean (no untracked source files).
- [ ] Diff bundle exported to artifacts/diffs/pr-283-diff.zip (R5).

## Verification Gates (exit 0)
- node --test tests/task-bootstrapper.test.mjs
- node --test tests/*.test.mjs
- git diff --check

## Delivery & Handoff (R2, R5, R8)
- git diff origin/main...HEAD > artifacts/diffs/pr-283-changes.diff
- Compress-Archive -Path artifacts/diffs/pr-283-changes.diff -DestinationPath artifacts/diffs/pr-283-diff.zip -Force
- Declare READY_FOR_REVIEW only with real evidence; never self-approve or merge.
