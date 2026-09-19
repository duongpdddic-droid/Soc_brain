# AUTONOMOUS DELIVERY CONTRACT — Soc_brain repository-wide autonomous delivery

> Canonical contract cho hành vi delivery tự động của TOÀN BỘ code tasks tương lai.
> Một shared delivery controller duy nhất phục vụ: Build foreground, canonical
> executors, resume, startup recovery và terminal-event wake.
>
> Quan hệ với policy hiện hành (không ghi đè, không suy yếu):
>
> - `AGENTS.md` R1–R9, R4a vẫn là intent chung; file này là contract chuyên biệt.
> - `FINAL_REVIEW_EXCHANGE_CONTRACT.md` sở hữu trao đổi Soc_brain ↔ Final Reviewer
>   (transport, manifest, trust levels, verdict rules). Contract này sở hữu chuỗi
>   delivery và shared controller; hai file dẫn chiếu nhau, không sao chép nội dung.
> - `REVIEW_LOOP_CONTRACT.md` sở hữu vòng Executor → OCR → handoff → Final Reviewer
>   và REWORK convergence (OCR tối đa 2 passes/epoch, REWORK ngoài tối đa 3 rounds).
>   Controller này tiêu thụ đúng các trần đó, không tự đặt trần mới.
> - Review Handoff Contract (AI_PR_REVIEWER validator) + review-ready packet
>   (`packages/review-ready`) vẫn là SSOT của canonical evidence.
> - Implementation nằm ở `packages/autonomous-delivery/` (pure, authority-free);
>   contract chỉ ràng buộc hành vi.

Phiên bản contract: `1.0.0` (`AUTONOMOUS_DELIVERY_VERSION = "1"`).

## 1. Shared controller (invariant)

Mọi入口 sau dùng CHUNG một controller (`packages/autonomous-delivery/`):

- Build foreground (OpenCode daily-driver Build trực tiếp);
- canonical executors (Cline/OpenCode/future backends qua ControlLoop);
- resume (tiếp tục task đang dở từ canonical persisted state);
- startup recovery (khởi động lại sau crash/restart từ checkpoint đã verify);
- terminal-event wake (executor tới terminal state → đánh thức delivery).

Chia sẻ nghĩa là: cùng `advance()` core, cùng transition table, cùng ownership
(`controllerOwner = 'autonomous-delivery-v1'`), cùng evidence guard. Không入口 nào
được fork logic riêng, không narrative riêng, không transport riêng.

## 2. Fixed Final Review provider (invariant)

- Provider cố định duy nhất: `chatgpt-plus-web2api-copy.mjs`
  (ChatGPT Plus qua local Web2API + clipboard extraction).
- Kích hoạt bằng đúng một flag: `SOC_FINAL_REVIEW_PROVIDER=chatgpt-plus-web2api-copy`.
- Executors KHÔNG được: chọn CWA, chọn CDP-legacy, combine nhiều transports,
  hay silent fallback theo bất kỳ hướng nào.
- Mọi vi phạm là fail-closed với code tường minh:
  `FINAL_REVIEW_PROVIDER_MISMATCH` (flag thiếu/sai),
  `FINAL_REVIEW_TRANSPORT_COMBINED_REFUSED` (đòi combine),
  `FINAL_REVIEW_FALLBACK_REFUSED` (đòi fallback),
  `NO_FINAL_REVIEW_TRANSPORT` (factory thiếu).
- Absent/misconfigured → fail-closed seam, không bao giờ tự suy đoán provider.

## 3. Canonical delivery chain (invariant)

Chuỗi tự động, mỗi mutation kèm read-back trước bước tiếp theo:

```text
TESTING → COMMITTING → PUSHING → PR_DRAFT → PR_READBACK
  → FINAL_REVIEWING → { REWORK → TESTING (bounded) | EVIDENCE_GUARD }
  → AWAITING_HUMAN_MERGE_DECISION (dừng, không merge tại đây)
```

- TESTING: targeted tests cho file/symbol đổi → related regression subset.
  Full suite đúng một lần trước handoff (R4a).
- COMMITTING: commit trong task worktree, HEAD 40-hex, dòng dõi từ baseSha.
- PUSHING: push đúng HEAD lên đúng session branch; remote read-back exact SHA.
- PR_DRAFT: mở Draft PR (không phải ready PR, không merge); adopt nếu đã tồn tại
  ở đúng head (idempotent, không duplicate).
- PR_READBACK: `gh pr view` xác minh OPEN + headRefOid === approved headSha.
- FINAL_REVIEWING: Web2API-copy review trên canonical packet; verdict
  PASS/REWORK/BLOCKED (strict JSON, binding echo khớp).
- REWORK: gom toàn bộ actionable findings một batch → repair epoch mới
  (verify → OCR ưu tiên findings → re-handoff). Trần ngoài 3 rounds (parity
  `MAX_REWORK_ROUNDS`); OCR trong mỗi epoch tối đa 2 passes.
- Controller KHÔNG merge/deploy/close/cleanup. Merge là quyết định của người,
  ngoài scope controller.

## 4. Human-gate policy (allowlist true, denylist false)

TRUE gates (được pause thành `AWAITING_HUMAN`):

- `CREDENTIAL_REQUIRED`, `PERMISSION_REQUIRED`, `BUSINESS_DECISION_REQUIRED`,
  `DESTRUCTIVE_PRODUCTION_AUTHORITY`, `BRON_DATA_REQUIRED`
  (dữ liệu chỉ Bố giữ).

Machine-solvable — KHÔNG BAO GIỜ là human gate (phải ra deterministic
machine action):

- `EXECUTOR_EXITED`, `STALE_SESSION_ACTIVE`, `REVIEW_REWORK`, `TEST_FAIL`,
  `EVIDENCE_TRANSPORT_FAIL`, `HANDOFF_PERSIST_FAIL`, `WORKTREE_INFRA`,
  `MACHINE_SOLVABLE_DEPENDENCY`, `REPAIR_TASK_REQUIRED`.

REWORK-budget exhaustion không phải gate mới: nó pause thành `AWAITING_HUMAN`
với reason `BUSINESS_DECISION_REQUIRED` + detail `REWORK_BUDGET_EXHAUSTED`
(người quyết định đổi scope hay chấp nhận rủi ro).

## 5. Evidence guard trước AWAITING_HUMAN_MERGE_DECISION (invariant)

Transition vào `AWAITING_HUMAN_MERGE_DECISION` bị từ chối fail-closed trừ khi
mọi evidence sau đã verify (không phải exit code, không phải narrative):

1. `testEvidence`: targeted + regression PASS (command, totals, exit 0, log ref);
2. `headSha`: 40-hex post-commit HEAD, dòng dõi từ baseSha;
3. `remoteSha === headSha`: remote branch read-back exact SHA;
4. `prNumber` + `prHeadSha === headSha` + `draft === true` + `state === OPEN`;
5. `reviewVerdict === PASS` + binding echo (repository/issue/headSha) khớp;
6. `reworkRounds <= 3`.

Thiếu bất kỳ mục nào → `MERGE_DECISION_EVIDENCE_INCOMPLETE` + `missing[]`.
Không bao giờ nâng narrative thành evidence.

## 6. UI/reporting từ canonical state (invariant)

- `deriveReport(record)` là SSOT cho mọi UI/reporting/progress.
- Input duy nhất là canonical record (state, chain, evidence, humanGate).
  Mọi narrative/executor story đều bị bỏ qua — report không bao giờ chứa
  narrative text, không suy đoán từ narrative.
- Hiển thị trạng thái suy ra từ state machine, không từ lời executor.

## 7. Migration cho tasks hiện có

`migrateLegacyTask(legacy)`:

- Provider cũ (`cwa`/`cdp-legacy`/`none`/thiếu) → `chatgpt-plus-web2api-copy`,
  giữ nguyên binding (repo/issue/headSha/pr).
- Review state cũ → `FINAL_REVIEWING` (cần fresh Web2API review; verdict cũ
  từ transport khác không được tái sử dụng làm PASS).
- Binding thiếu/sai → fail-closed (`MIGRATION_BIND_FAILED`).
- Ghi `migratedFrom` để trace; migration là idempotent.

## 8. Integration seams (wiring vật lý)

Core (`advance`/`nextMachineAction`/ownership) đã dùng chung cho cả 5入口 ở
mức module (có regression test chứng minh). Wiring vật lý tại call-site:

- foreground + canonical + resume: `packages/control-loop/run.js`
  (fixed provider selector + `--resume` qua controller recover).
- terminal-event wake: `packages/executor-launcher/executor-launcher.mjs`
  `appendTerminalEvidence` là điểm gọi `onTerminalEvent` (follow-up, không đổi
  hành vi runtime trong turn này).
- startup recovery: đọc canonical persisted delivery record rồi `startupRecover`
  (follow-up, cùng core đã test).

## 9. Verification

`tests/autonomous-delivery.test.mjs` bao phủ: fixed provider, refuse
CWA/combine/fallback, chain progression, REWORK bound, true-gate-only pause,
evidence guard, UI-from-state, migration, shared-core cho 5入口.
