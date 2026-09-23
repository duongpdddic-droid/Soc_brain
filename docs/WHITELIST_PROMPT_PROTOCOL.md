# Whitelist-First Task Prompt Protocol

Mục đích: triệt tiêu tê liệt suy nghĩ của agent — không để agent tự diễn giải các mệnh đề cấm mơ hồ; mọi quyền tạo/sửa file phải được liệt kê tường minh.

## 1. Nguyên tắc Whitelist-First

1. Cấm mệnh đề cấm đoán mơ hồ (ví dụ: "đừng sửa bậy", "chỉ sửa phần liên quan"): mệnh đề mơ hồ buộc agent suy diễn, không phân định được một cách deterministic.
2. Mọi task prompt phải mở đầu bằng Whitelist: danh sách đúng đường dẫn các file ĐƯỢC PHÉP tạo/sửa, kèm câu "Chỉ được tạo/sửa duy nhất các file liệt kê ở trên".
3. Whitelist là positive-allow duy nhất: file ngoài whitelist = DENY fail-closed, kể cả thay đổi một dòng; không tự mở rộng sang file khác (R4 Minimum Scope).
4. Thiếu Whitelist hoặc whitelist mơ hồ (thư mục chung chung, glob rộng) → không nhận task, trả lại Human Gate.
5. Whitelist không thay thế review hay approve: nó chỉ khoanh vùng được sửa; merge vẫn cần Human Gate.

## 2. Mẫu Task Prompt chuẩn (5 mục)

### 2.1 Context
Repository, Target Branch, Base (origin/main hoặc commit SHA), Compliance (R4, Regression-First, Fail-Closed).

### 2.2 Whitelist
Danh sách file được cấp phép — mỗi dòng một đường dẫn duy nhất kèm vai trò, ví dụ:

1. `docs/WHITELIST_PROMPT_PROTOCOL.md` — tài liệu protocol này.

Kèm câu cấm tường minh: chỉ được tạo/sửa đúng các file liệt kê trong mục này.

### 2.3 Technical Solution
Điểm nghẽn kỹ thuật và giải pháp phẫu thuật: mỗi hành động gắn đúng một file whitelist, nêu rõ tạo hay sửa gì và nội dung gì.

### 2.4 Targeted Verification
Lệnh kiểm tra thu hẹp chạy trước, kèm tiêu chí PASS đo được, ví dụ:

- `git status --short`
- `git diff --check` → exit 0, không khoảng trắng thừa cuối dòng.

### 2.5 Handoff Artifacts
Lệnh xuất diff bundle vào `artifacts/diffs/`:

- `git diff origin/main...HEAD > artifacts/diffs/pr-smoke-changes.diff`
- Nén `pr-smoke-changes.diff` thành `pr-smoke-diff.zip`.

Kèm báo cáo bằng chứng thực thi: nội dung file và log diff sạch.
