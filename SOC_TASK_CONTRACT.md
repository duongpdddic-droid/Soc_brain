# Task Contract — feat(bootstrap): autonomous task
Goal ID: goal-1790127194275
Branch: agent/054af059ec49559f0788baa3a92e5ec8
Status: IN_PROGRESS

## Scope
- Deliverables:
  - Automated task provisioning script (bin/soc-task-bootstrap.mjs)
  - Offline test suite (tests/soc-task-bootstrap.test.mjs)
  - Full regression test pass (node --test tests/*.test.mjs)
  - Diff bundle artifacts/diffs/pr-214-diff.zip
- Out of scope:
  - Runtime sandbox MCP server changes
  - Control-loop FSM modifications
  - Telegram dispatch modifications

## Verification Gates
- node --test tests/soc-task-bootstrap.test.mjs
- node --test tests/*.test.mjs (full regression)
- git diff --check
- Diff bundle created at artifacts/diffs/pr-214-diff.zip

## Acceptance Criteria
- [ ] Script accepts --title, --goal, --base, --issue CLI args
- [ ] Creates isolated worktree at ~/.soc-brain/worktrees/agent/<session_id>
- [ ] Generates .opencode/agents/build.md with standard permissions
- [ ] Generates SOC_TASK_CONTRACT.md with full objectives, scope, gates
- [ ] Pushes branch and opens draft PR with status:in-progress label
- [ ] Fail-closed rollback on any step failure (worktree, binding, branch cleaned up)
- [ ] Offline tests pass (mocked provisioning, file structure, error cleanup)
- [ ] Full regression suite passes 100%
