# Task Contract - Fix #289: Session Admission fence tin cậy (tách socket idle lease khỏi request timeout + reconnect đúng biên)

Context & Boundaries:
- Repository: duongpdddic-droid/Soc_brain
- Target Branch: task/fix-289-session-authority-idle-lease
- Base: 4fc393f92f248c667376daaae205da51023c2ec2 (`main` local = origin, tree sạch)
- Issue: #289 (Session Admission fence không tin cậy được -> không dám arm -> REC-01 luôn `ADMISSION_NOT_ARMED`)
- PR: chưa tạo (không tự mở PR/merge/deploy)
- Worktree: C:/Users/Admin/.soc-brain/worktrees/fix/session-authority-idle-lease-289
- Scope (CHỈ được sửa):
  - `packages/session-authority/` (authority-server.mjs, guard.mjs, protocol.mjs, session-authority.mjs)
  - `tests/session-authority.test.mjs`
- Ngoài scope (tuyệt đối không chạm trong PR này):
  - `docs/MASTER_ROADMAP_v2.md` (R4&R9 split-authority: executor KHÔNG sửa roadmap trong task kỹ thuật)
  - `.opencode/opencode.json` (KHÔNG bật `SOC_SESSION_ADMISSION` ở PR này)
  - `packages/control-loop/**`, `scripts/**`, `bin/**`, mọi module khác
- Compliance: AGENTS.md R1..R9 (Fail-Closed, Evidence-First, R4 minimum scope, R5 evidence before completion).
- Không cherry-pick branch `fix/session-authority-idle-timeout` (tip `4c472fb2`): nó predates REC-01 và không có reconnect. Chỉ tham khảo THIẾT KẾ.

## GitHub Label Lifecycle (R8)
- On start: (issue #289 hiện chưa có nhãn) `gh issue edit 289 --add-label "status:in-progress"`
- On handoff (READY_FOR_REVIEW): `gh issue edit 289 --add-label "status:review-requested" --remove-label "status:in-progress"`
- NEVER self-apply `status:approved` / `status:blocked`.

## Problem (đã xác minh tĩnh trên base `4fc393f`)
1. `authority-server.mjs` chỉ có MỘT timer: `armTimer()` arm bằng `requestTimeoutMs` (mặc định 5000ms) và được re-arm sau mỗi chunk dữ liệu. `idleTimeoutMs = 30000` (dòng 136) khai báo nhưng KHÔNG dùng. Hệ quả: mọi socket im lặng > 5s bị daemon kill, kể cả owner đang giữ lease hợp lệ.
2. `guard.mjs:ensureClient()` (dòng 87-89) trả về `sharedClient` cũ mà không kiểm tra `connected`. Khi transport đã chết, lệnh `ACQUIRE` MỚI cũng trả `AUTHORITY_CONNECTION_LOST` mãi mãi -> không tự hồi phục.
3. `FENCE_RENEW_MS = 5000` hardcode, không thể cấu hình -> không thể test/khớp với socket idle lease ngắn, không thể đảm bảo cadence < lease/2.
4. `tests/session-authority.test.mjs` che defect bằng `requestTimeoutMs: 60000` trong harness.

## LOCKED ARCHITECTURAL CONSTRAINTS (Bố chốt - không được nới)
### C1. Ranh giới Fail-Closed khi reconnect (chống split-brain)
- **Case 1 — `activeFences.size === 0`:** nếu transport bị đóng do idle-timeout, `ensureClient()` ĐƯỢC phép reconnect trong suốt để phục vụ lệnh `ACQUIRE` MỚI của caller.
- **Case 2 — đang giữ fence:** khi mất kết nối (`AUTHORITY_CONNECTION_LOST`) hoặc đứt lease giữa chừng, hệ thống BẮT BUỘC fail-closed cho luồng đang chạy: invalidate các fence đang giữ và trả lỗi typed rõ ràng cho caller. TUYỆT ĐỐI KHÔNG âm thầm reconnect rồi tự re-`ACQUIRE` epoch/token mới dưới gầm bàn cho một phiên/mutation đang dở.
- Đường duy nhất để có grant mới: caller chủ động gọi lại `ACQUIRE` sau khi đã xử lý lỗi. Reconnect (transport) chỉ được phép xảy ra trên đường `ACQUIRE` đó — không có đường nào khác (`renewAllFences`/`refreshAdmissionFence`/`sealBoundaryReceipt`/`releaseAdmission` KHÔNG được reconnect/re-acquire).
- Không có file-lease fallback, không "best effort grant".

### C2. Tách timer trên server + tỷ lệ renewal
- `authority-server.mjs`: tách bạch hoàn toàn **Socket Idle Lease** (`idleTimeoutMs`, thời gian socket im lặng giữa các message) và **Per-Request/Frame Timeout** (`requestTimeoutMs`, frame chưa hoàn tất).
- Nhịp `FENCE_RENEW_MS` luôn phải nhỏ hơn đáng kể `idleTimeoutMs` (tối đa 1/2, mục tiêu 1/3) và PHẢI cấu hình được (không hardcode 5000ms đè lên lease ngắn 300-400ms khi test).

### C3. Yêu cầu RED/GREEN test (`tests/session-authority.test.mjs`)
- Bỏ `requestTimeoutMs: 60000` che lỗi.
- (a) đang giữ 1 fence: heartbeat/renewal giữ kết nối sống vượt qua cả `idleTimeoutMs` lẫn `requestTimeoutMs`.
- (b) không giữ fence nào + im lặng quá `idleTimeoutMs`: kết nối bị đóng nhưng lần `ACQUIRE` kế tiếp tự reconnect thành công (không kẹt `AUTHORITY_CONNECTION_LOST`).
- (c) transport bị cưỡng bức đóng khi đang giữ fence: mọi thao tác kiểm tra/gia hạn/xác nhận phải fail-closed đúng chuẩn; grant mới (token/epoch mới) chỉ đến từ `ACQUIRE` do caller chủ động gọi, không bao giờ tự động.

## Acceptance Criteria
- AC1 (C2): socket im lắng > `idleTimeoutMs` (ví dụ 400ms) bị đóng vì LEASE, KHÔNG phải vì `requestTimeoutMs` (5000ms); owner đang giữ fence thì renewal giữ được lease sống.
- AC2 (C1-case1): sau khi bị idle-kill và KHÔNG giữ fence, `admitSession` kế tiếp reconnect + nhận grant mới (ok=true), không còn kẹt `AUTHORITY_CONNECTION_LOST`.
- AC3 (C1-case2): transport đứt khi đang giữ fence -> `assertAdmissionFence` / `refreshAdmissionFence` / `sealBoundaryReceipt` trả typed fail-closed; `ACQUIRE` mới cho cùng session bị daemon từ chối typed (`SESSION_ACQUIRE_CONFLICT` vì entry của owner còn LIVE — đây chính là chống split-brain, KHÔNG phải lỗi); KHÔNG có fence nào được mint từ lệnh bị từ chối; một session không có entry tồn dư thì `ACQUIRE` mới thật sự thành công với token mới, cùng daemonEpoch.
- AC4 (C2): cadence renewal cấu hình được, và cấu hình sai (renew > lease/2, maxStale <= renew) bị từ chối TƯỜNG MINH (throw), không silent clamp.
- AC5: không hồi quy — toàn bộ test hiện có của `tests/session-authority.test.mjs` và các test dùng guard (`control-loop*.test.mjs`, `session-authority-durable.test.mjs`) vẫn PASS.

## Implementation Checklist
1. [ ] `protocol.mjs`: `createFrameDecoder` thêm `get bufferedBytes()` (additive) để server biết còn frame dở hay không.
2. [ ] `authority-server.mjs`: tách `armIdleLease()` (idleTimeoutMs, reason `IDLE_TIMEOUT`) và `armRequestTimeout()` (requestTimeoutMs, CODES.REQUEST_TIMEOUT); sau frame hoàn tất trả về idle lease; validate 2 option là số nguyên dương (fail-closed khi cấu hình sai).
3. [ ] `guard.mjs`: `fenceTiming()`, `configureFenceTiming(patch)` (validate renew*2 <= idleLease, maxStale > renew; apply ngay cả khi renewTimer đang chạy), `resetFenceTiming()`, env `SOC_SESSION_AUTHORITY_FENCE_RENEW_MS` / `_FENCE_MAX_STALE_MS` / `_IDLE_TIMEOUT_MS`; thay `FENCE_RENEW_MS`/`FENCE_MAX_STALE_MS` const bằng `_DEFAULT` + giá trị hiệu lực.
4. [ ] `guard.mjs`: `ensureClient()` chỉ tái dùng client khi `sharedClient.connected`; transport chết -> teardown rồi connect MỚI (không re-acquire fence).
5. [ ] `session-authority.mjs` (barrel): cập nhật export guard.
6. [ ] `tests/session-authority.test.mjs`: bỏ masking 60000, thêm test J1..J5 theo C3.
7. [ ] Không sửa roadmap/.opencode.

## Verification Gates
- RED: test J* fail trên base `4fc393f` vì ĐÚNG defect/năng lực thiếu, các test cũ vẫn pass.
- GREEN: test J* pass + không hồi quy.
- Gate bắt buộc theo repo (`AGENTS.md` R4a global): targeted `node --test tests/session-authority.test.mjs` -> regression subset (`control-loop*.test.mjs`, `session-authority-durable.test.mjs`) -> đúng MỘT full suite trước handoff.
- Evidence: command + exit code + totals pass/fail/skip + log path.

## Handoff
- Commit candidate scoped (code + test), export diff + ZIP evidence, READY_FOR_REVIEW theo quy trình (OCR pre-review -> soc_review internal review -> final review độc lập).
- Không arm `SOC_SESSION_ADMISSION` trong repo config ở PR này (việc của Operator sau khi fence đã tin cậy).
