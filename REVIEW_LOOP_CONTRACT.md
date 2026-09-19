# REVIEW LOOP CONTRACT — Soc_brain canonical OCR pre-review + REWORK convergence

> Chuẩn hóa vòng review trước khi Web2API/CWA review loop hoàn thiện. Mục tiêu:
> giảm số vòng Final Reviewer → REWORK → Executor; OCR bắt lỗi sớm nhưng không
> chiếm final-review authority; không review loop vô hạn; giữ canonical evidence
> và deterministic lifecycle.
>
> Quan hệ với policy hiện hành (không ghi đè, không suy yếu):
>
> - `AGENTS.md` R1–R9, R4a vẫn là intent chung; file này là contract chuyên biệt.
> - `FINAL_REVIEW_EXCHANGE_CONTRACT.md` sở hữu trao đổi Soc_brain ↔ Final Reviewer
>   (transport, manifest, trust levels, verdict rules). File này sở hữu vòng
>   Executor → self-verify → OCR → handoff → Final Reviewer và vòng REWORK
>   convergence; hai file dẫn chiếu nhau, không sao chép nội dung.
> - Review Handoff Contract (AI_PR_REVIEWER validator) + review-ready packet
>   (`packages/review-ready`) vẫn là SSOT của canonical evidence.
> - Lifecycle FSM (`packages/control-loop/control-loop.mjs`,
>   `ACCEPTED → ROUTED → EXECUTING → VERIFYING → PRE_REVIEWING → FINAL_REVIEWING →
>   DECIDING → {REWORK | DELIVERING | BLOCKED}`) không bị sửa bởi contract này.
> - Deterministic enforcement: `packages/review-leg/review-loop-budget.mjs`
>   (pure, authority-free). Tích hợp vào control-loop PRE_REVIEWING là follow-up
>   được định nghĩa sẵn (xem §8), ngoài scope turn này để tránh xung đột lane.

Phiên bản contract: `1.0.0` (`REVIEW_LOOP_VERSION = "1"`).

## 1. Canonical review loop (invariant)

```text
Executor
  → self-verify
  → OCR pre-review (OCR-1 DISCOVERY)
  → batch repair nếu có actionable findings
  → OCR convergence (OCR-2 CONVERGENCE)
  → canonical handoff
  → Web2API/CWA
  → Final Reviewer.
```

Mỗi mũi tên là một gate có evidence; không bước nào được suy đoán từ bước trước.

## 2. Authority

- **Executor** = mutation owner duy nhất trong task lane (R1). Chỉ executor sửa code.
- **OCR** (REVIEW-ONLY leg: `review-only.mjs` + `review-leg-adapter.mjs`,
  ReviewEvidence v1) = INFORMATIONAL / PRE-REVIEW quality gate.
- OCR **không có** quyền FINAL PASS/REWORK verdict. ReviewEvidence v1 bị validator
  từ chối ở dạng closed-world nếu mang `verdict` hay bất kỳ trường authority nào —
  đó là enforced, không phải quy ước miệng.
- **Final Reviewer** phải tự kiểm canonical evidence (source/diff thật, SHA/hash,
  binding). OCR PASS/clean **không được** chuyển đổi thành bằng chứng final PASS
  (trust level của OCR tối đa là SUPPORTING_ONLY theo thang của
  `FINAL_REVIEW_EXCHANGE_CONTRACT.md` §6).
- Chỉ Soc_brain ControlLoop dispatch executor, terminalize, chuyển FSM
  (Issue #79; `rework.mjs` là pure helper, không chuyển state).

## 3. OCR budget (mặc định tối đa 2 passes / review epoch)

### OCR-1 — DISCOVERY

- Review toàn bộ in-scope diff (base..head).
- Cố gắng gom toàn bộ actionable findings trong một lượt.
- Không yêu cầu executor repair từng finding riêng lẻ.

Sau OCR-1: executor repair findings theo **batch**; self-verify toàn batch trước
khi OCR lại.

### OCR-2 — CONVERGENCE

- Verify OCR-1 findings đã đóng.
- Kiểm regression trực tiếp do repair tạo ra.
- Cho phép blocker nghiêm trọng mới **có evidence**.
- Không mở scope sang preference/style/refactor/cleanup không cần thiết.

### Sau OCR-2 — bắt buộc dừng

- Bắt buộc dừng OCR loop. **Không tự tạo OCR-3.**
- Nếu còn blocker có evidence: trả **BLOCKED** theo vocabulary hiện có
  (terminal `BLOCKED` + evidence `OCR_BUDGET_EXHAUSTED`) và route evidence lên
  control plane.
- Nếu không còn blocker: tạo canonical handoff cho Final Reviewer.

## 4. Actionable finding contract

Một finding chỉ được tạo repair cycle khi có đủ cả 7 trường:

1. file/symbol; 2. observed behavior; 3. violated/required invariant;
4. concrete consequence; 5. minimal fix boundary; 6. required test/evidence;
7. explicit PASS gate.

Finding thiếu evidence, hoặc chỉ là preference / style / speculative concern /
optional refactor / scope expansion → đánh dấu **ADVISORY/INFORMATIONAL**,
không được block handoff, không được vào convergence scope.

Enforcement (`review-loop-budget.mjs` `classifyOcrSignal`): fail-direction luôn
về ADVISORY (không bao giờ chặn handoff nhầm).

## 5. Final-review REWORK convergence

Nếu Final Reviewer trả REWORK:

- Gom **tất cả** actionable findings phát hiện được trong **một** response
  (không drip-feed qua nhiều vòng nếu có thể phát hiện trong cùng review).
- Mỗi finding phải executor-ready:
  file/symbol → observed behavior → invariant → minimal fix boundary →
  tests/evidence → PASS gate.

REWORK tạo **repair epoch** mới. Trong repair epoch:

- Executor sửa toàn bộ final-review findings theo batch.
- Chạy targeted/bounded verification.
- OCR chỉ ưu tiên verify theo thứ tự:
  1. final-review findings;
  2. regression trực tiếp từ repair;
  3. blocker nghiêm trọng mới có evidence.
- Không mặc định discovery lại toàn repo/diff từ đầu.

Sau đó mới tạo canonical re-handoff cho Final Reviewer
(`rework.mjs` digest/record/instruction + `MAX_REWORK_ROUNDS = 3` của control-loop
là trần vòng ngoài; OCR budget §3 là trần vòng trong mỗi epoch).

## 6. Pre-handoff verification (trước READY_FOR_REVIEW)

Executor phải kiểm tối thiểu 8 gates:

1. tất cả required findings đã xử lý;
2. scope diff; 3. `git diff --check`;
3. targeted/bounded tests phù hợp; 5. regression tests liên quan;
4. HEAD/diff/evidence read-back; 7. canonical identity binding;
5. handoff evidence completeness.

Nếu required PASS gate chưa chứng minh được: không phát READY_FOR_REVIEW;
fail closed thành BLOCKED với missing evidence + next actor.

Không coi exit 0 / tests green / OCR clean / executor done / SESSION_ACTIVE /
process EXITED / commit-PR tồn tại là bằng chứng TASK_COMPLETED nếu lifecycle
evidence chưa đủ (tương thích R5: timeout/missing output/process exit không
chứng minh PASS).

## 7. Next-actor output

Mọi Final Reviewer REWORK/BLOCKED response phải kèm next-actor instruction
executable để Soc_brain/Web2API route tự động (mục tiêu dài hạn: Bố không cần
copy/paste thủ công khi Web2API/CWA hoàn thiện). Shape:

```text
NEXT_ACTOR: <EXECUTOR | OCR | FINAL_REVIEWER | HUMAN>
REPAIR_EPOCH: <n>
DO: <exact executable steps>
VERIFY: <exact PASS gates>
STOP: <authority boundary — việc gì không được làm>
```

## 8. Integration seam (follow-up, ngoài scope turn này)

`review-loop-budget.mjs` là pure helpers, chưa wire vào `control-loop.mjs`
PRE_REVIEWING (tránh xung đột lane đang sửa control-loop + giữ lifecycle
zero-diff). Khi wire: consumption point duy nhất là PRE_REVIEWING step —
`nextOcrPass` quyết định rerun/stop leg, `preHandoffCheck` gate trước handoff
composition, `planRepairEpoch` định hướng OCR scope trong rework leg. Không
thêm FSM state, không đổi TRANSITIONS, không đổi verdict enum.
