# Step Transition Guide — tự bổ sung tại chỗ, không dừng, không Block

> GENERATED từ `packages/control-loop/step-contract.mjs` bởi
> `node scripts/export-step-guide.mjs` — **không sửa tay** (test T8 byte-so khớp).
> Document nạp context cho Reviewer (AI/Human) và Bố Dương.

- schemaVersion: `1`
- sổ cái trạng thái: `.soc/step-state.json`
- status hợp lệ: `READY`, `REMEDIATION_REQUIRED` (không có `BLOCKED`)
- sessionPhase: `IN_STEP`, `AWAITING_FIELDS`

## 1. Triết lý: Fail đâu bổ sung đó — Remediation over Blocking

Khi preflight chuyển bước phát hiện trường **thiếu** hoặc **sai format**, hệ thống:

1. **Không** ném lỗi hard-stop, **không** ghi `BLOCKED`;
2. Ghi sổ cái `.soc/step-state.json` với `status: REMEDIATION_REQUIRED`,
   `sessionPhase: AWAITING_FIELDS`, giữ nguyên `currentStep` (không nhảy cóc),
   nêu đích danh `missingFields` / `invalidFields` kèm `remediationHint`;
3. Executor điền đúng các trường đó rồi **gọi lại cùng transition** —
   trường đã hợp lệ trước đó được **merge cộng dồn (additive)**, không mất gì;
4. Ngay khi preflight pass 100% → `status: READY`, `currentStep` tiến bước,
   transition chạy tiếp mượt mà — không khởi động lại từ đầu.

## 2. Sơ đồ chu trình chuyển bước & cơ chế tự bổ sung tại chỗ

```
ACCEPTED → ROUTED → EXECUTING → VERIFYING → PRE_REVIEWING → FINAL_REVIEWING
                                                                  ↓
              COMPLETED ← DELIVERING ← DECIDING ←─────────────────┘

  verdict PASS:   DECIDING → DELIVERING → COMPLETED
  rework legs:    VERIFYING / DECIDING / BLOCKED → REWORK → EXECUTING
  escalation:     any live step → BLOCKED (canonical FSM edge only)
```

Cơ chế tự bổ sung (in-place remediation loop):

```
 attemptStepTransition(from, to, fields)
        │
        ├─ field thiếu/sai ──► status=REMEDIATION_REQUIRED
        │                      sessionPhase=AWAITING_FIELDS
        │                      currentStep=from (giữ chỗ, không nhảy cóc)
        │                      ghi .soc/step-state.json ──► executor điền trường
        │                              │
        │                              └── gọi lại attempt (merge additive) ──┐
        │                                                                      │
        └─ field đủ & đúng ──► status=READY, currentStep=to ◄─────────────────┘
                                transition hợp lệ được phép thực thi
```

## 3. Danh mục từng bước (tên bước · điều kiện tiên quyết · trường bắt buộc)

### ACCEPTED

- **Điều kiện tiên quyết:** _(entry — không có bước trước)_
- **Trường bắt buộc:**

| Trường | Format (quy chuẩn) | Mô tả |
| --- | --- | --- |
| `repo` | owner/name repository string | target repository (owner/name) |
| `issueNumber` | positive integer | GitHub issue number of the task |

### ROUTED

- **Điều kiện tiên quyết:** `ACCEPTED`
- **Trường bắt buộc:**

| Trường | Format (quy chuẩn) | Mô tả |
| --- | --- | --- |
| `branch` | non-empty string | task branch to push / review |
| `headSha` | 40-hex SHA | 40-hex SHA of the candidate HEAD under evaluation |

### EXECUTING

- **Điều kiện tiên quyết:** `ROUTED`, `REWORK`
- **Trường bắt buộc:**

| Trường | Format (quy chuẩn) | Mô tả |
| --- | --- | --- |
| `worktreePath` | path (non-empty string, no NUL) | absolute path of the isolated task worktree |
| `executorPid` | integer PID | integer PID of the owning executor process |

### VERIFYING

- **Điều kiện tiên quyết:** `EXECUTING`
- **Trường bắt buộc:**

| Trường | Format (quy chuẩn) | Mô tả |
| --- | --- | --- |
| `headSha` | 40-hex SHA | 40-hex SHA of the candidate HEAD under evaluation |
| `exitCode` | non-negative integer exit code | exit code of the required verification gate |
| `contentDigest` | SHA-256 hash (64-hex) | SHA-256 digest of the reviewed content bundle |

### PRE_REVIEWING

- **Điều kiện tiên quyết:** `VERIFYING`
- **Trường bắt buộc:**

| Trường | Format (quy chuẩn) | Mô tả |
| --- | --- | --- |
| `headSha` | 40-hex SHA | 40-hex SHA of the candidate HEAD under evaluation |
| `contentDigest` | SHA-256 hash (64-hex) | SHA-256 digest of the reviewed content bundle |

### FINAL_REVIEWING

- **Điều kiện tiên quyết:** `PRE_REVIEWING`
- **Trường bắt buộc:**

| Trường | Format (quy chuẩn) | Mô tả |
| --- | --- | --- |
| `headSha` | 40-hex SHA | 40-hex SHA of the candidate HEAD under evaluation |
| `contentDigest` | SHA-256 hash (64-hex) | SHA-256 digest of the reviewed content bundle |
| `reviewRunId` | non-empty string | run id of the internal/final review invocation |

### DECIDING

- **Điều kiện tiên quyết:** `FINAL_REVIEWING`
- **Trường bắt buộc:**

| Trường | Format (quy chuẩn) | Mô tả |
| --- | --- | --- |
| `headSha` | 40-hex SHA | 40-hex SHA of the candidate HEAD under evaluation |
| `verdict` | closed enum (case-sensitive) · nhận `PASS` \| `REWORK` \| `BLOCKED` | normalized reviewer verdict |

### REWORK

- **Điều kiện tiên quyết:** `VERIFYING`, `DECIDING`, `BLOCKED`
- **Trường bắt buộc:**

| Trường | Format (quy chuẩn) | Mô tả |
| --- | --- | --- |
| `headSha` | 40-hex SHA | 40-hex SHA of the candidate HEAD under evaluation |
| `reworkReason` | non-empty string | short reason recorded for the rework leg |

### DELIVERING

- **Điều kiện tiên quyết:** `DECIDING`
- **Trường bắt buộc:**

| Trường | Format (quy chuẩn) | Mô tả |
| --- | --- | --- |
| `headSha` | 40-hex SHA | 40-hex SHA of the candidate HEAD under evaluation |
| `pullRequest` | positive integer | pull request number carrying the delivery |

### COMPLETED

- **Điều kiện tiên quyết:** `DELIVERING`
- **Trường bắt buộc:**

| Trường | Format (quy chuẩn) | Mô tả |
| --- | --- | --- |
| `headSha` | 40-hex SHA | 40-hex SHA of the candidate HEAD under evaluation |
| `contentDigest` | SHA-256 hash (64-hex) | SHA-256 digest of the reviewed content bundle |

### BLOCKED

- **Điều kiện tiên quyết:** `ACCEPTED`, `ROUTED`, `EXECUTING`, `VERIFYING`, `PRE_REVIEWING`, `FINAL_REVIEWING`, `DECIDING`, `REWORK`, `DELIVERING`
- **Trường bắt buộc:**

| Trường | Format (quy chuẩn) | Mô tả |
| --- | --- | --- |
| `reason` | non-empty string | escalation reason recorded with the state |

## 4. Bảng quy chuẩn format (toàn bộ)

| Format id | Quy chuẩn | Áp dụng cho |
| --- | --- | --- |
| `sha40` | 40-hex SHA | `headSha` |
| `sha256` | SHA-256 hash (64-hex) | `contentDigest` |
| `pid` | integer PID | `executorPid` |
| `exitCode` | non-negative integer exit code | `exitCode` |
| `path` | path (non-empty string, no NUL) | `worktreePath` |
| `repo` | owner/name repository string | `repo` |
| `positiveInt` | positive integer | `issueNumber`, `pullRequest` |
| `string` | non-empty string | `branch`, `reviewRunId`, `reworkReason`, `reason` |
| `enum` | closed enum (case-sensitive) | `verdict` |

Ghi chú chung:

- `40-hex SHA` / `SHA-256`: 40/64 ký tự hex, không phân biệt hoa thường (thuần về chữ thường khi lưu);
- `integer PID` / `exit code` / `positive integer`: phải là **số nguyên** (chuỗi số bị từ chối);
- `path`: chuỗi khác rỗng, không chứa NUL;
- `verdict`: enum đóng, phân biệt hoa thường;
- trường lạ (không có trong registry) không bao giờ được thu thập.

## 5. Xử lý `REMEDIATION_REQUIRED` — cách bù thông tin để chạy tiếp

1. Đọc `.soc/step-state.json` (JSON):
   - `currentStep` / `targetStep`: bước đang giữ và bước định chuyển tới;
   - `missingFields`: danh sách trường **chưa có** — cần cấp đủ;
   - `invalidFields`: các trường **đã cấp nhưng sai format** — từng entry kèm lý do cụ thể;
   - `remediationHint`: chỉ dẫn ngắn gọn cách cấp đúng để pass;
   - `collectedFields`: các trường đã hợp lệ từ lần thử trước (đã lưu, không mất).
2. Bổ sung/sửa đúng các trường đó theo bảng quy chuẩn ở mục 3–4.
3. Gọi lại `attemptStepTransition` với **cùng** `from`/`to` — giá trị mới hợp lệ
   được validate trước khi ghi đè `collectedFields` (merge cộng dồn: trường hợp lệ
   cũ được giữ, chỉ giá trị mới hợp lệ mới thay thế); giá trị sai của lần gọi hiện
   tại bị báo `invalidFields` + `REMEDIATION_REQUIRED` nhưng **không xóa** trường
   hợp lệ đã thu — preflight lại và tự chuyển bước khi đạt, **không cần khởi động
   lại tiến trình**.
4. Không bao giờ tự ý nhảy cóc: transition sang bước không thuộc
   `prerequisites` của đích bị từ chối typed (`STEP_TRANSITION_INVALID`),
   bản ghi remediation đang giữ không bị ghi đè.

Ví dụ bản ghi mẫu (fixture `tests/fixtures/step-state.sample.json` — trạng thái runtime KHÔNG được commit):

```json
{
  "schemaVersion": "1",
  "currentStep": "EXECUTING",
  "collectedFields": {},
  "updatedAt": "2026-10-08T00:00:00.000Z",
  "status": "REMEDIATION_REQUIRED",
  "sessionPhase": "AWAITING_FIELDS",
  "targetStep": "VERIFYING",
  "missingFields": [
    "headSha",
    "exitCode"
  ],
  "invalidFields": {
    "contentDigest": "not a SHA-256 hash (64-hex)"
  },
  "remediationHint": "supply missing field(s): headSha (40-hex SHA), exitCode (non-negative integer exit code); fix invalid field(s): contentDigest — not a SHA-256 hash (64-hex). Re-run the SAME transition with the corrected fields — collected fields are kept, the session stays AWAITING_FIELDS until the preflight passes; no restart needed."
}
```

---

_Sổ cái `.soc/step-state.json` chỉ là kênh điều phối preflight giữa Executor
và Soc Control Loop: nó không cấp thẩm quyền, không tự chuyển FSM, không
thay thế ledger phiên. Trạng thái vòng đời canonical vẫn do control-loop.mjs
(LOOP_STATES / ALLOWED_TRANSITIONS) quản lý — test T11 khóa đồng bộ giữa
hai bảng này, test T8 khóa đồng bộ giữa tài liệu này và schema._
