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

- **Advisor Invocation Invariant (No Rogue MCP Scripts)**:
    - Executor TUYỆT ĐỐI KHÔNG tự ý spawn tiến trình con gọi `packages/advisor-mcp` hoặc tạo script tạm trong thư mục Temp để gọi API bên ngoài.
    - Quyền tham vấn Advisor độc quyền thuộc về ControlLoop FSM qua Chrome CDP 9222 (Web2API) khi kích hoạt chu trình REWORK.
    - Khi executor gặp bế tắc kỹ thuật, dừng mutation và báo cáo trung thực trở ngại trong biên bản bàn giao, cấm tự ý vượt cấp đi đêm.

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

## R5 — Evidence before completion & Commit Ordering Protocol

- Only claim COMPLETE / READY_FOR_REVIEW with real evidence (implementation exists + offline verification PASS + task state recorded).

### The 4-Step Commit Ordering Protocol (Eliminates HEAD SHA Drift):
To prevent HEAD SHA divergence between git state and the review payload, executors MUST follow this immutable sequence:
1. **Step 1 (Code & Test Freeze)**: Complete all code edits and run offline tests (`npm test` or `npm run test:gate`). Exit code MUST be 0.
2. **Step 2 (Atomic Commit)**: Commit all functional code and tests:
   `git add <files>; git commit -m "<task-message>"`
   Working tree MUST be clean (`git status --short` must report 0 uncommitted changes).
3. **Step 3 (Immutable HEAD Capture)**: Read the exact commit hash:
   `HEAD_SHA=$(git rev-parse HEAD)` (or via PowerShell `git rev-parse HEAD`).
4. **Step 4 (Export Diff Bundle from Frozen HEAD)**:
   Export the PR diff against base branch (main) into `artifacts/diffs/`:
   - PowerShell: `New-Item -ItemType Directory -Force -Path artifacts/diffs; git diff main...HEAD > artifacts/diffs/pr-<PR_NUMBER>-changes.diff`
   - Bash: `mkdir -p artifacts/diffs && git diff main...HEAD > artifacts/diffs/pr-<PR_NUMBER>-changes.diff`
   - *Packaging Note*: Raw diff (`pr-<PR_NUMBER>-changes.diff`) is the canonical format for review payloads; zip packaging is optional legacy.

5. **Step 5 (Reviewer Gate & Final Verification)**:
      - Offline tests pass (784+ tests) CHỈ LÀ điều kiện cần, KHÔNG PHẢI điều kiện hoàn tất tác vụ.
      - Executor TUYỆT ĐỐI KHÔNG bàn giao thẳng cho Bố duyệt khi PR chưa qua Trạm gác Reviewer độc lập.
      - Handoff chỉ hoàn tất khi FSM/Reviewer cấp `VERDICT: APPROVED` (hoặc `PASS`) và PR được gắn nhãn `status:approved`. Mọi hành vi giục Bố merge khi thiếu chữ ký Reviewer đều bị coi là vi phạm nghiêm trọng kỷ luật R2/R5.

**CRITICAL INVARIANT**: Absolutely NO new commits after Step 4. Any subsequent commit will move HEAD, desynchronize the review payload binding, and trigger Fail-Closed (`VERDICT: BLOCKED`).

## R6 — Recoverable context

- Prefer verified evidence (Issue, repository, exact HEAD) over memory/experience;
  resolve conflicts toward current evidence.
- Do not ask again for information recoverable from the current task, repository or
  observed state.

- **Virtual Knowledge & Strategic Docs Invariant**:
  1. Các tài liệu tri thức kỹ thuật (`01_` đến `07_`, `PROJECT_QLDA_DTXD_MAP`) là tri thức nội bộ của riêng Gem Sóc nạp sẵn trong LLM context, KHÔNG tồn tại vật lý trên đĩa repo. Executor tuyệt đối không gọi công cụ tìm kiếm hoặc cố gắng mở các file này trên filesystem.
  2. Tài liệu chiến lược hệ thống (`docs/NORTH_STAR_v2.1.0.md`) thuộc thẩm quyền định hướng của Operator (Bố) và Advisor. Executor kỹ thuật tuyệt đối không tự ý đọc, sửa hoặc viện dẫn nếu không có yêu cầu đích danh trong task manifest.

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


### R4 & R9 Split-Authority Contract (Zero-Overthinking Rule):
- **Executor Scope**: An executor working on a technical bug or feature MUST ONLY touch code and test files required for the task.
- **Roadmap Boundary**: The executor MUST NOT touch docs/MASTER_ROADMAP_v2.md unless the task issue/whitelist explicitly authorizes it.
- **Reviewer Non-Blocking**: Reviewers MUST NOT issue CHANGES_REQUESTED or BLOCKED for a missing roadmap update on technical-only PRs; roadmap stamping is handled by the control loop or operator handoff.
