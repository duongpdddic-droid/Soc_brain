# Task Contract — INTEGRATE-AUTONOMOUS-CDP-AND-TELEGRAM-SELF-HEALING

Context & Boundaries:
- Repository: duongpdddic-droid/Soc_brain
- Target Branch: feat/cdp-telegram-autonomous-supervision
- Base: origin/main (cefc1dc43aeed9542ab7f044c2e6181163af4b0f)
- PR Number: 230
- Worktree: worktrees/feat-cdp-tg-supervision
- Compliance: AGENTS.md R1 → R10; Fail-Closed; no background loops (Issue #65 req 10).

## GitHub Label Lifecycle (R8)
- On start: `gh pr edit 230 --add-label "status:in-progress" --remove-label "status:queued,status:changes-requested"` (DONE)
- On handoff: `gh pr edit 230 --add-label "status:review-requested" --remove-label "status:in-progress,status:changes-requested"`
- NEVER self-apply status:approved or status:blocked.

## Objectives
1. CDP supervisor tự quản: auto-launch/poll-ready, isolated profile, Target.createTarget (WS + HTTP fallback), DOM-ready wait, exponential-backoff 2-tier recovery, zombie cleanup.
2. Telegram worker: env-config (`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`) + healthcheck export; dispatcher: durable JSONL spool + transient auto-flush (429/ECONNRESET/ETIMEDOUT) — NO background loop.
3. Wire `dispatchGranularMilestone` vào vòng lặp FSM (6 events: ROUTED → DELIVERING).
4. Wire CDP supervisor vào FINAL_REVIEWING Web2API review (lazy, fail-closed).
5. Offline test suites: CDP spawn/crash/recover chain; Telegram network-drop/spool/recover.
6. Update MASTER_ROADMAP_v2.md (R9).

## Implementation Checklist
- [ ] Implementation matches the goal with minimum scope (R4).
- [ ] git status --short clean (no untracked source files).
- [ ] Diff bundle exported to artifacts/diffs/pr-230-diff.zip (R5).

## Verification Gates (exit 0)
- node --test tests/cdp-supervisor.test.mjs
- node --test tests/telegram-dispatch.test.mjs
- node --test tests/telegram-telemetry.test.mjs
- node --test tests/task-bootstrapper.test.mjs
- node --test tests/soc-control-agent.test.mjs
- node --test tests/*.test.mjs
- git diff --check

## Delivery & Handoff (R2, R5, R8, R9)
- git diff origin/main...HEAD > artifacts/diffs/pr-230-changes.diff
- Compress-Archive -Path artifacts/diffs/pr-230-changes.diff -DestinationPath artifacts/diffs/pr-230-diff.zip -Force
- Update docs/MASTER_ROADMAP_v2.md with PR #230 + commit SHA + Date header.
- Declare READY_FOR_REVIEW only with real evidence; never self-approve or merge.
