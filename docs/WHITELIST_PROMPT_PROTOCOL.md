# Whitelist-First Task Prompt Protocol

Muc dich: triet tieh tinh ly li suy nghi cua agent — khong de agent tu dien giai menh de cam mo ho; moi quyen tao/sua file phai duoc liet ke tuong minh.

## 1. Nguyen tac Whitelist-First

1. Cam menh de cam doan mo ho (vd: "dung sua bay", "chi sua phan lien quan"): menh de mo ho buoc agent suy dien, khong phan dinh duoc deterministic.
2. Moi task prompt phai mo dau bang Whitelist: danh sach dung duong dan cac file DUOC PHEP tao/sua, kem cau "Chi duoc tao/sua duy nhat cac file liet ke o day".
3. Whitelist la positive-allow duy nhat: file ngoai whitelist = DENY fail-closed, ke ca thay doi mot dong; khong tu mo rong sang file khac (R4 Minimum Scope).
4. Thieu Whitelist hoac whitelist mo ho (thư mục chung chung, glob rong) -> khong nhan task, tra lai Human Gate.
5. Whitelist khong thay review hay approve: no chi khoanh vung duoc sua; merge van can Human Gate.

## 2. Mau Task Prompt chuan (5 muc)

### 2.1 Context
Repository, Target Branch, Base (origin/main hoac commit SHA), Compliance (R4, Regression-First, Fail-Closed).

### 2.2 Whitelist
Danh sach file duoc cap phep — moi dong mot duong dan duy nhat kem vai tro, vi du:

1. `docs/WHITELIST_PROMPT_PROTOCOL.md` — tai lieu protocol nay.

Kem cau cam tuong minh: chi duoc tao/sua dung cac file liet ke trong muc nay.

### 2.3 Technical Solution
Diem nghen ky thuat va giai phap phau thuat: moi hanh dong gan dung mot file whitelist, ro rang tao hay sua gi va noi dung gi.

### 2.4 Targeted Verification
Lenh kiem tra thu hep chay truoc, kem tieu chi PASS do duoc, vi du:

- `git status --short`
- `git diff --check` -> exit 0, khong khoang trang thua cuoi dong.

### 2.5 Handoff Artifacts
Lenh xuat diff bundle vao `artifacts/diffs/`:

- `git diff origin/main...HEAD > artifacts/diffs/pr-<PR>-changes.diff`
- Nen `pr-<PR>-changes.diff` thanh `pr-<PR>-diff.zip`.

Kem bao cao bang chucg thuc thi: noi dung file va log diff sach.
