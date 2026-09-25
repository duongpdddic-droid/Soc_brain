# Soc_brain — Executor Rules (canonical, executor-independent)

These are the shared process rules for any coding executor (Cline, OpenCode, future
backends) running a Soc_brain task. They are the canonical, executor-independent
source. Executor-specific quirks stay in per-executor files; they are never promoted
to canonical. Deterministic enforcement is referenced by module name, not restated.

## Language Protocol
- **Suy nghĩ nội tâm (Thinking) và Báo cáo tóm tắt:** Bắt buộc viết bằng Tiếng Việt thân thiện, rõ ràng, gãy gọn để Người điều hành (Bố) dễ theo dõi chiến trường.
- **Biến mã nguồn, lệnh Git, JSON schema:** Giữ nguyên định dạng kỹ thuật nguyên bản.

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
- Mandatory diff bundle: before signaling completion/review, the executor MUST export the full diff against main and package it into `artifacts/diffs/pr-<PR_NUMBER>-diff`:
  - Windows (PowerShell):
    `New-Item -ItemType Directory -Force -Path artifacts/diffs; git diff main...HEAD > artifacts/diffs/pr-<PR_NUMBER>-changes.diff; Compress-Archive -Path artifacts/diffs/pr-<PR_NUMBER>-changes.diff -DestinationPath artifacts/diffs/pr-<PR_NUMBER>-diff -Force`
  - Linux/macOS:
    `mkdir -p artifacts/diffs && git diff main...HEAD > artifacts/diffs/pr-<PR_NUMBER>-changes.diff && zip -j artifacts/diffs/pr-<PR_NUMBER>-diff artifacts/diffs/pr-<PR_NUMBER>-changes.diff`
  The diff files MUST be stored in `artifacts/diffs/` and include the task/PR number in their filenames, formatted as:
  `artifacts/diffs/pr-<PR_NUMBER>-changes.diff` and `artifacts/diffs/pr-<PR_NUMBER>-diff`
  (e.g., artifacts/diffs/pr-203-changes.diff / artifacts/diffs/).
  Handoff lacking `artifacts/diffs/pr-<PR_NUMBER>-diff` is incomplete (Fail-Closed).
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


## R8 — GitHub Label Lifecycle Protocol

- Executors (OpenCode/Cline):
  - On task start: apply status:in-progress, remove status:queued/status:ready-for-cline.
  - On handoff (READY_FOR_REVIEW): apply status:review-requested, remove status:in-progress/status:changes-requested.
  - NEVER self-apply status:approved or status:blocked.
- Reviewers (GPT/Reviewer Gate):
  - On REWORK verdict: apply status:changes-requested, remove status:review-requested.
  - On BLOCKED verdict: apply status:blocked, remove status:review-requested.
  - On PASS verdict: apply status:approved, remove status:review-requested.
---

### R9. Bắt buộc đồng bộ Roadmap (Roadmap Sync Gate)
1. Mỗi khi hoàn thành một PR/Task hoặc đạt một mốc kỹ thuật, Executor/Reviewer BẮT BUỘC phải cập nhật file MASTER_ROADMAP_v2.md.
2. Nội dung cập nhật bao gồm:
   - Chuyển trạng thái tiến độ theo đúng thang đo: IMPLEMENTED -> DETERMINISTIC_VERIFIED -> INTEGRATED -> REAL_E2E_PROVEN -> CANONICAL.
   - Ghi rõ bằng chứng ràng buộc: Số PR, commit SHA, và ngày hoàn thành cụ thể.
   - Cập nhật dòng Date: YYYY-MM-DD ở phần header của roadmap.
3. Thiếu cập nhật Roadmap được coi là thiếu bằng chứng bàn giao (áp dụng nguyên tắc Fail-Closed khi review).

