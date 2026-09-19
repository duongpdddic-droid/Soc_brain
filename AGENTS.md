# Soc_brain — Executor Rules (canonical, executor-independent)

These are the shared process rules for any coding executor (Cline, OpenCode, future
backends) running a Soc_brain task. They are the canonical, executor-independent
source. Executor-specific quirks stay in per-executor files; they are never promoted
to canonical. Deterministic enforcement is referenced by module name, not restated.

## R1 — Task ownership & isolation

- Work only in the isolated worktree/session allocated to the current task.
- Never edit through another issue's workspace or the primary checkout.
- One executor owner per task; no concurrent mutation of the same task.

Enforcement (deterministic): `packages/workspace`, `packages/safe-git`,
`packages/execution-broker` (locks), `packages/runtime-sandbox` (session authority).

## R2 — Authority fit

- Never self-approve. Never claim reviewer/GPT approval.
- Never merge, deploy, amend or force-push without explicit human authorization.
- Declare `READY_FOR_REVIEW` only when the handoff prerequisites are met
  (implementation exists + verification PASS + task state recorded).

Gate (deterministic): the canonical REVIEW HANDOFF CONTRACT validator enforces the
`READY_FOR_REVIEW` prerequisites (source: AI_PR_REVIEWER `review-handoff-contract.mjs`);
`packages/review-ready` only fail-closed projects a runtime file when
`terminalStatus == READY_FOR_REVIEW` (it does not approve, and carries no HEAD lock —
HEAD lock is review-specific, not in scope here).

## R3 — Risk-proportional effort

- Classify the task (S/M/L) before mutation; choose the lowest-cost verification that
  still proves the acceptance criteria and protects the affected boundary.
- Small changes do not require full GitHub/PR/review ceremony.

This classification is process guidance, not code.

## R4 — Minimum scope

- Change what the task requires; do not self-expand refactor/architecture/naming/optimization.
- Do not invent guards, plugins or rules frameworks without evidence; defer out-of-scope
  improvements as proposals.

## R5 — Evidence before completion

- Only claim COMPLETE / READY_FOR_REVIEW with real evidence
  (implementation exists + verification PASS + task state recorded).
- Never treat a command/session boundary or context compaction as completion; recover
  state from verified evidence before continuing.

## R6 — Recoverable context

- Prefer verified evidence (Issue, repository, exact HEAD) over memory/experience;
  resolve conflicts toward current evidence.
- Do not ask again for information recoverable from the current task, repository or
  observed state.

## R7 — Terminal & process context

- State and respect the execution OS and shell (Windows / PowerShell). Be explicit,
  never assume.
- Prefer native file tools over a shell for read/edit when safe; use command-scoped
  paths (`git -C <path>`).
- Never leave a shared terminal in a changed directory; clean up only owned child
  processes/terminals; report anything intentionally left running.
- Prefer deterministic checks over repeated reasoning; do not blind-retry mutating
  commands; treat missing captured output as unknown, not success.

## Deterministic enforcement — reference, don't restate

Refer to these by module name instead of repeating their contents in prompts:

- temp/runtime hygiene: `packages/temp-hygiene`
- final-review exchange over Web2API/CWA (transport order, trust levels,
  verdict rules — canonical pointer only): `FINAL_REVIEW_EXCHANGE_CONTRACT.md`
- review loop (OCR budget + REWORK convergence — canonical pointer only):
  `REVIEW_LOOP_CONTRACT.md` (enforcement: `packages/review-leg/review-loop-budget.mjs`)
- safe-git preflight: `packages/safe-git`
- workspace binding/cleanup: `packages/workspace`
- task admission, session lease, fail-closed guards: `packages/runtime-sandbox`
- one-owner locking: `packages/execution-broker`
- review-ready evidence + HEAD lock: `packages/review-ready`
- registry ownership/conflicts/path/secret: `packages/project-registry`

## Per-executor notes (NOT canonical)

- Cline: `.clinerules` files, VS Code Plan-mode ("Duyệt trước") channel, Memory-Bank
  file layout, Telegram channels — Cline-presence/UI specific, not canonical.
- OpenCode: `opencode.json` `permission` block, MCP broker tool set, per-task
  `SOC_TASK_CONTRACT.md` — OpenCode runtime config, not canonical rules.

## Projection

This file is the shared intent and is the cross-executor carrier: AGENTS.md is
autoloaded by Cline and OpenCode. Per-task scope/authority keeps living in the per-task
contract (`SOC_TASK_CONTRACT.md`), which references this file for the always-on rules.
Cline/OpenCode-specific quirks remain in their own config and are never merged here.
