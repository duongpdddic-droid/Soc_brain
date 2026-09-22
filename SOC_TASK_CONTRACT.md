# Task Contract — Soc_brain client goal #9000021

feat(telemetry): Detailed FSM milestone notifications for Telegram dispatcher.

Target branch: feat/telegram-detailed-telemetry, base origin/main (fetch+rebase first). Comply AGENTS.md R1-R10, Fail-Closed, clear authority separation (R2), no swallowed errors, minimal scope (R4).

Objectives:
1) Upgrade Telegram Dispatcher (packages/control-loop/telegram-dispatcher.mjs or equivalent) to support hook/emitter sending granular FSM milestone events, not only end/error: ROUTED (task assigned to executor model/agent), EXECUTING (start isolated worktree), VERIFYING (start offline test suite with expected test count), FINAL_REVIEWING (payload packed, sent to reviewer), DECIDING (verdict APPROVED or CHANGES_REQUESTED - Rework Round N), DELIVERING/Human Gate (with PR link, diff summary, PowerShell command awaiting merge approval). Message format: concise, visual icons (🚀 ⚙️ 🧪 🔍 ⚖️ 🛑 ✅), timestamp, Session ID / Issue number.
2) Integrate telemetry hook into CLI runner (bin/soc-control-loop.mjs): listen to transition events from readTransitions or FSM observer to trigger Telegram dispatch in real time. Fail-safe: Telegram send failure (network/rate-limit) must NOT crash the main FSM loop (log warning, continue).
3) Offline tests (tests/telegram-telemetry.test.mjs): fully mock Telegram API (telegramSpawn / HTTP fetch), 100% offline. Assert that as FSM walks a sample state chain, correct and complete milestone messages are formatted and sent. Assert resilience: Telegram API errors do not stop the FSM reaching its destination.

Verification gates (must PASS 100%): node --test tests/telegram-telemetry.test.mjs; node --test tests/soc-control-agent.test.mjs; node --test tests/verdict-parser.test.mjs; node --test tests/*.test.mjs; git diff --check.

Delivery: clean commit + push (no force-push), create PR, export diff bundle to artifacts/diffs/pr-<PR>-changes.diff and pr-<PR>-diff.zip (non-empty), update docs/MASTER_ROADMAP_v2.md, set PR labels per R8 (status:review-requested, remove status:in-progress). Handoff must include the required PowerShell evidence block.
