# Task Contract — Soc_brain client goal #218

[TASK-S5-ENFORCE-SANDBOX-BOOTSTRAP-ISSUE-AND-SR11B-FIX] Tích hợp Tự tạo Issue vào Bootstrapper, Ép Sandbox cho Control & Build Agents và Sửa Flake SR11b.

Context & Boundaries:
- Repository: duongpdddic-droid/Soc_brain
- Target Branch: feat/bootstrap-issue-sandbox-sr11b-fix
- Base: origin/main (fetch và rebase mới nhất sau khi PR #214 và #216 merge vào main)
- PR Number: tạo mới (sẽ do bootstrapper/executor xác định)
- Compliance: AGENTS.md R1->R10, Fail-Closed, Regression-First, R2 authority, R4 minimum scope.

GitHub Label Lifecycle (R8): khi bắt đầu: gh pr edit <PR> --add-label "status:in-progress" --remove-label "status:queued,status:ready-for-cline,status:changes-requested". Cấm tự gán status:approved hoặc status:blocked.

Git Worktree Setup (R10): bắt buộc worktree cô lập:
  New-Item -ItemType Directory -Force -Path worktrees
  git worktree add -b feat/bootstrap-issue-sandbox-sr11b-fix worktrees/task-bootstrap-sandbox-sr11b origin/main
  Set-Location worktrees/task-bootstrap-sandbox-sr11b

Objectives:
1. Sửa triệt để Flake Test SR11b (Issue #218):
   - Phân tích và xử lý điểm nghẽn tranh chấp tài nguyên tại tests/client-mcp-supervisor.test.mjs (SR11b/F1).
   - Tối ưu cơ chế chờ sẵn sàng (polling/bounded wait thay vì sleep cố định) hoặc cô lập tiến trình để test ổn định khi chạy song song tải cao.
   - Không giảm độ ngạt assertion hoặc skip test; toàn bộ suite về 100% (733/733 pass, 0 fail, 0 unhandled rejection).

2. Bổ sung năng lực Tự tạo Issue cho Bootstrapper (bin/soc-task-bootstrap.mjs):
   - Cho chạy khi chưa có --issue: chỉ truyền --title và --goal, bootstrapper tự tạo GitHub Issue qua gh issue create --title "..." --body "..." --label "status:in-progress".
   - Trích xuất Issue Number vừa tạo để tiếp tục luồng: tự sinh nhánh issue-<number>, worktree sandbox tại ~/.soc-brain/worktrees/agent/<session_id>, Draft PR liên kết closes #<number>.
   - Giữ tương thích: nếu đã chỉ định --issue <số>, bỏ qua tạo issue, dùng trực tiếp.

3. Ép Sandbox Toàn diện cho Control Agent và Build/Executor Agent:
   - Cập nhật bin/soc-control-agent.mjs, bin/soc-control-loop.mjs và cấu trúc runner của build agent (.opencode/agents/soc_build.md, CLI runner cho build/executor):
     + Mandatory Gate: mọi agent (control hoặc build) khi nhận issue/task mới BẮT BUỘC gọi bin/soc-task-bootstrap.mjs để cấp worktree sandbox cô lập.
     + Cấm thao tác repo gốc: fail-closed lỗi ERR_SANDBOX_REQUIRED / OUT_OF_BOUNDS_EXECUTION nếu build/control agent thực thi đột biến file trực tiếp trên repo gốc (cwd == repo_root).
     + Ràng buộc ngữ cảnh: chuyển toàn bộ context, session_id, đường dẫn worktree cô lập cho SupervisorEngine (Reactive Engine, Scope Guard, Drift Guard).

4. Chuẩn hóa Telegram Telemetry:
   - Telemetry reader nạp chuẩn cấu hình telegram.json.
   - Giữ bộ lọc sự kiện theo mốc FSM (ROUTED, EXECUTING, VERIFYING, FINAL_REVIEWING, DECIDING, DELIVERING, TASK_COMPLETED, TASK_BLOCKED); loại bỏ/từ chối bản tin tự do cờ INFO.

Implementation Checklist:
- Khắc phục flake SR11b, giữ nguyên nghiêm assertion.
- bin/soc-task-bootstrap.mjs hỗ trợ tự sinh Issue khi không có --issue.
- Cơ chế phát hiện và chặn (Fail-Closed) nếu agent thao tác ngoài worktree sandbox.
- git status --short không còn untracked trong mã nguồn (git add đầy đủ).
- Test unit/integration cho tự tạo issue và ép sandbox.
- Cập nhật docs/MASTER_ROADMAP_v2.md phản ánh tiến độ Issue #218 và Sandbox & Issue Creation Enforcement.

Verification Gates (PASS 100%, lưu log):
  node --test tests/client-mcp-supervisor.test.mjs
  node --test tests/soc-control-agent.test.mjs
  node --test tests/supervisor-reactive-guard.test.mjs
  node --test tests/telegram-telemetry.test.mjs
  node --test tests/*.test.mjs
  git diff --check
Yêu cầu: tests/*.test.mjs đạt 733/733 PASS (exit 0, 0 fail, 0 unhandledRejection).

Delivery & Handoff (R2, R5, R8):
1. Commit sạch, push nhánh làm việc (cấm force-push).
2. PR OPEN, draft: false.
3. Export diff bundle:
  New-Item -ItemType Directory -Force -Path artifacts/diffs
  git diff origin/main...HEAD > artifacts/diffs/pr-<PR>-changes.diff
  Compress-Archive -Path artifacts/diffs/pr-<PR>-changes.diff -DestinationPath artifacts/diffs/pr-<PR>-diff.zip -Force
4. gh pr edit <PR> --add-label "status:review-requested" --remove-label "status:in-progress"
5. Báo cáo bàn giao in sẵn khối lệnh sau cho Reviewer:
  Get-Content artifacts/diffs/pr-<PR>-changes.diff | Set-Clipboard
  Get-Content artifacts/diffs/pr-<PR>-changes.diff
  node --test tests/client-mcp-supervisor.test.mjs
  node --test tests/*.test.mjs
