# Soc_brain — Báo cáo rà soát & phân loại Backlog

> **Tài liệu này chỉ là ĐỀ XUẤT (proposal).** Không có bất kỳ thao tác ghi remote nào được thực hiện:
> không `gh issue close`, không `gh pr close`, không `gh pr merge`, không label/comment edit,
> không `push --force`, không amend/revert. Mọi close/merge chờ Bố phê duyệt (R2 — không tự duyệt).

## (a) Metadata, cách lấy dữ liệu, số liệu tổng quan

### Metadata

| Hạng mục | Giá trị |
|---|---|
| Repo | `duongpdddic-droid/Soc_brain` (default branch `main`) |
| PR nghiệm thu | **#234** (DRAFT, base `main`) |
| Local task binding | `#9000023` (issue nội bộ — KHÔNG phải GitHub issue; bỏ qua mọi lệnh label/issue với số này) |
| Worktree / branch | `C:\Users\Admin\.soc-brain\worktrees\agent\afa0b43e65a0370aaecc0b13f01bbf8c` → `agent/afa0b43e65a0370aaecc0b13f01bbf8c` |
| `origin/main` / local ref `main` | `a3b42e4102116a32f0ac650888f81c3aeccee612` (cả hai trùng nhau) |
| HEAD lúc khảo sát (read-only) | `d655df5ba2a0e0e5caee610822d071a5c16b8481` (commit bootstrap) |
| HEAD sau khi commit deliverable | `f09fd84f7b2921bde0023e5a780a683e17c7250f` — nhánh `ahead 2 / behind 0` so với `main`, **chưa push** |
| Ngày khảo sát | 2026-09-25 |
| OS / shell | Windows / PowerShell 7 (pwsh) |
| Công cụ | `gh version 2.97.0`, `node v22.23.2`, `git` read-only |
| Tài liệu đối chiếu | `docs/NORTH_STAR_v2.1.0.md`, `docs/MASTER_ROADMAP_v2.md` (đặc biệt **Mục 9 — Open PR treatment at roadmap reset**) |

### Cách lấy dữ liệu (chỉ đọc, GET/view)

```powershell
# 1) Danh sách tổng quan
gh issue list --repo duongpdddic-droid/Soc_brain --limit 100 --state all
gh pr list    --repo duongpdddic-droid/Soc_brain --limit 100 --state all

# 2) Đếm đủ (limit 100 bị CẮT — thấy thêm 6 issue + 28 PR khi nâng limit)
gh issue list --repo duongpdddic-droid/Soc_brain --limit 1000 --state all --json number,state
gh pr list    --repo duongpdddic-droid/Soc_brain --limit 1000 --state all --json number,state,isDraft

# 3) Chi tiết từng mục còn OPEN (body + comment đọc được)
gh issue view <N> --repo ... --json number,title,state,labels,createdAt,updatedAt,body,comments
gh pr    view <N> --repo ... --json number,title,state,isDraft,headRefName,createdAt,updatedAt,
                   mergeable,additions,deletions,changedFiles,body,comments

# 4) Đối chiếu trạng thái THẬT của nhánh so với main (read-only: fetch + diff/rev-list)
git fetch origin <các nhánh OPEN>
git rev-list --count origin/main..<branch>        # ahead
git diff --shortstat origin/main...<branch>       # diff thực tế vs main
```

**Lưu ý method:** `--limit 100 --state all` trả về đúng 100 dòng và **bị cắt**; số liệu tổng quan bên
dưới lấy từ `--limit 1000`. Không có lệnh nào trong phần 4 ghi remote; `git fetch` chỉ cập nhật
`refs/remotes/origin/*` cục bộ.

### Số liệu tổng quan

**Issues — tổng 106**

| State | Số lượng |
|---|---|
| OPEN | **16** |
| CLOSED | 90 |

**PRs — tổng 128**

| State | Số lượng |
|---|---|
| MERGED | 99 |
| OPEN (trong đó DRAFT) | **19** (7 draft: #187, #188, #190, #195, #214, #220, #234) |
| CLOSED | 10 |

**Issues OPEN theo nhãn (label FSM):**

| Nhãn | Issues |
|---|---|
| `status:in-progress` | #212, #92, #37 |
| `status:review-requested` + `agent:gpt` | #107, #67 |
| `status:blocked` + `agent:cline` | #103 |
| `status:ready-for-cline` + `agent:cline` | #30 |
| `status:queued` + `agent:cline` | #21 |
| *(không nhãn)* | #218, #192, #189, #164, #162, #155, #147, #51 |

**Nhóm dùng trong bảng (b)/(c):** `đang làm` · `kẹt` · `duplicate` · `obsolete` · `cần chốt` ·
`backlog` (Issues) và `merge-candidate` · `cần review` · `obsolete` · `superseded` (PRs).

---

## (b) Phân loại TỪNG Issue OPEN (16/16)

| # | Title (rút gọn) | Nhãn | Nhóm | Đề xuất (chờ Bố duyệt) |
|---|---|---|---|---|
| **218** | Baseline debt: SR11b/F1 load-flake trong `tests/client-mcp-supervisor.test.mjs` (race exactly-one `POST /mcp/connect` dưới full-suite contention) | — | **kẹt** (test debt) | Giữ OPEN. Đây là flake **đã tái diễn** (PR #230 cũng phải xử lý "one known-flaky SR1 race"; full-suite 776/777 một lần). Đề xuất xếp vào S1 *execution truth* và sửa test-only; **không** raise timeout/skip để làm xanh. |
| **212** | feat(telemetry): Detailed FSM milestone notifications for Telegram dispatcher | `status:in-progress` | **obsolete / duplicate** | **Đã giao hàng** bởi PR **#213 MERGED** (2026-09-22, merge `7f04788`); đã verify `dispatchGranularMilestone` **có trên `origin/main`**. Nhãn `status:in-progress` đang sai lệch. → Đề xuất **close #212** + gỡ nhãn (Bố duyệt). |
| **192** | S1 bootstrap: execution truth for process-backed test supervision | — | **backlog** (canonical, đúng Roadmap S1) | Giữ OPEN. Đây là work-item S1 chính gốc; chưa có PR riêng. Gắn với #218 (cùng chủ đề phân loại PASS/ASSERTION_FAILED/PROCESS_*). |
| **189** | `\Task: universal-final-review-loop (DEFER - review only, no merge)\` | — | **cần chốt** | Tracking issue của draft PR **#188**; `MERGE_DECISION = DEFER`. Số phận gắn với (d) bên dưới — chốt #188 trước rồi đóng kèm. |
| **164** | [P1] Idle Supervisor: machine-global singleton + PowerShell probe-churn reduction | — | **obsolete / superseded** | **Đã giao hàng** bởi cặp #165 → PR **#168 MERGED** (merge `1bd13ba`); PR #168 ghi rõ *"supersedes the stateDir-keyed singleton"*. `origin/main` đã có `machineSupervisorDir()` / `supervisor.lock` / stale-owner PID+startTime+bootId. → Đề xuất **close #164** (kèm đóng PR #166 — xem (c)). |
| **162** | reviewOnly: `executionRecordPath` verification should assert `record.headSha === target` (đối xứng với 2 nguồn còn lại) | — | **backlog** (S, không phải defect an ninh — body tự xác nhận "NOT a correctness or security defect") | Giữ OPEN, dồn vào sprint nhỏ. Không vội. |
| **155** | Control-plane gap: legacy/noncanonical task không vào được CWA final-review transport | — | **đang làm** | PR **#156** đang ở vòng review #7 với evidence packet + "307/307 PASS" tại HEAD `923bbbf`. → Tiếp tục review #156 (xem (c)). |
| **147** | Cline SDK Executor Adapter — MVP (non-production, default-off) | — | **đang làm** | PR **#152** đang rework round 4 (đã fix rò rỉ runtime). Mở đúng tinh thần North Star §7 "design for replacement". → Tiếp tục rework #152. |
| **107** | P0 reliability hotfix 1/3: PART 0 operator-fix reconciliation, commit-per-item | `status:review-requested`, `agent:gpt` | **kẹt** | PR **#144**: GPT verdict REWORK (0.97) với **rework budget EXHAUSTED 3/3** — hết vòng tự động. Cần **quyết định của Bố**: tách lại PART 0 sạch (branch riêng, không kèm commit #157) hay đóng. Comment 2026-09-10 đã xác nhận `CDP_NOT_PRODUCTION_READY`. |
| **103** | feat(review-eval): mechanical port 10-file delta (third-chance sau #100/#102) | `agent:cline`, `status:blocked` | **kẹt** | 3 lifecycle liên tiếp blocked vì **INFRA**, không phải nội dung; delta known-good @ `8701649`. Comment cuối: *"Requires human decision on executor environment before relaunch."* → Chờ Bố chọn executor/ môi trường. |
| **92** | P1-1: Review evaluation persistence (Gemini/GPT) + loop latency (M1) | `agent:cline`, `status:in-progress` | **kẹt** (umbrella) | Giữ OPEN làm umbrella cho tới khi #103 giao hàng. PR **#95** head *"predates the known-good delta → AMBIGUOUS under the #138 fail-closed rule"* → xem (c). |
| **67** | Bootstrap reverse control leg: bound GPT decision → validated dispatch seam | `status:review-requested`, `agent:gpt` | **kẹt** (chờ review 20 ngày) | PR **#68** bàn giao review từ 2026-09-05, im lặng 20 ngày. Cần review đúng hạn hoặc đóng theo chính sách stale. Lưu ý: phần E2E dùng CDP — CDP đã bị loại khỏi critical path (Issue #107 comment; Roadmap S3/S4). |
| **51** | Soc_Score summary durations thiếu đơn vị thời gian (ms) — đọc sai ~1000x (record-only) | — | **backlog** (XS) | Defect-record, điều tra xong (data nhất quán ms, chỉ lỗi trình bày). Fix nhỏ + test → gom vào sprint docs/UX. |
| **37** | Canonical registered-test registration path cho session testRegistry | `agent:cline`, `status:in-progress` | **đang làm** | Comment 2026-09-10: **blocker upstream đã cleared**; còn lại *"canonical task_handoff retry, GPT review, merge of PR #38"*. → PR #38 là ứng viên merge (xem (c)). |
| **30** | [P1] task-server cross-project routing: bind GitHub mutation theo canonical repo identity | `agent:cline`, `status:ready-for-cline` | **kẹt** (phụ thuộc ngoài) | Verify hôm nay: **`AI_PR_REVIEWER` PR #40 vẫn OPEN** (repo khác) → điều kiện đóng chưa thỏa. Giữ OPEN làm cross-repo tracker. **Rủi ro an ninh/authority** nếu đóng sớm. |
| **21** | Selective Experience Compiler v0: evidence → reviewable heuristics | `agent:cline`, `status:queued` | **backlog** (post-bootstrap) | Gate theo điều kiện của chính nó: sau pilot #18 + Claude-mem. Thuộc nhóm M3/M4 sau Bootstrap Exit (Roadmap §7/§8) → giữ `queued`. |

---

## (c) Phân loại TỪNG PR OPEN (19/19)

"Ahead/behind" = `git rev-list --count origin/main..<branch>` / `...<branch>..origin/main` (read-only).
"Diff vs main" = `git diff --shortstat origin/main...<branch>`.

| # | Title (rút gọn) | State/Draft | Ahead/behind · diff vs main | Nhóm | Đối chiếu North Star + Roadmap | Đề xuất |
|---|---|---|---|---|---|---|
| **38** | runtime-sandbox: canonical registered-test registration (Issue #37) | OPEN / ready | 1 / **191** · 3 files +369/−3 | **merge-candidate** | North Star §6.1/§7 "Soc_brain sole authority"; đúng *minimum sufficient* | Blocker upstream đã cleared. Cần: rebase vì **behind 191**, GPT review, rồi merge (Bố). |
| **68** | reverse-dispatch: bound GPT decision → validated dispatch seam + CDP reverse-control E2E (Issue #67) | OPEN / ready | 1 / **144** · 6 files +1170 | **cần review** (phần E2E CDP → obsolete một phần) | North Star §6.14 "no model output overrides policy"; Roadmap §3 fail-closed | Review #68; riêng script E2E dùng CDP (đã `CDP_NOT_PRODUCTION_READY`) → cân nhắc tách/port, không đưa vào critical path. |
| **95** | canonical task delivery (#92) | OPEN / ready | 5 / **111** · 11 files +1204/−9 | **superseded / ambiguous** | Roadmap §3 "không suy status từ PR mở"; Rule #138 fail-closed | Head **trước** delta known-good (`8701649`) → tái xác minh rồi **đề xuất close**, giao lại cho #103. |
| **144** | control-loop: P0 reliability PART 0 unique deltas (Issue #107 attempt 2) | OPEN / ready | 23 / **74** · 8 files +275/−21 | **kẹt → cần chốt** (một phần superseded) | Roadmap §5 cấm ép xanh; §9 "đọc lại HEAD trước hành động" | REWORK 0.97, budget **3/3 hết**. CDP send-timeout 300000→930000 xung đột với hướng loại CDP khỏi critical path → chờ quyết định Bố (tách PART 0 sạch / đóng). |
| **152** | Cline SDK executor adapter MVP, default-off (Issue #147) | OPEN / ready | 5 / **78** · 5 files +2128 | **cần review** | North Star §7 "design for replacement", §10 "không bắt Cline/OpenCode mãi là primary" | Tiếp tục rework round 4 → review. Chú ý: nhánh này sinh Issue #155 (không qua canonical taskStart) — đó là lý do #155/#156 tồn tại. |
| **156** | explicit legacy/noncanonical review adoption cho production CWA (Issue #155) | OPEN / ready | 13 / **74** · 8 files +1966/−9 | **merge-candidate** (mạnh nhất) | Roadmap **S6** nhưng đã bị blocker thật đẩy lên trước; North Star §6.11 binding fail-closed | Evidence round-7 đầy đủ (HEAD `923bbbf`, packet digest, "307/307 PASS"). Đề xuất: read-back HEAD → GPT PASS → **Bố authorize merge**. |
| **166** | idle-supervisor: machine-global singleton + bootId probe-churn (#164) | OPEN / ready | 2 / **72** · 3 files +646/−8 | **superseded** | Roadmap §9 "không suy status từ PR mở" | **#168 đã MERGED** (09/13) làm việc này. Diff 2 chiều cho thấy nhánh #166 **cũ hơn main rất nhiều** (idle-supervisor: 450 insert/1577 delete so với main) → merge sẽ **hồi phục code cũ**. → Đề xuất **close #166 + #164**. |
| **184** | lifecycle: recovery discovery chỉ gắn vào task canonical thực sự active | OPEN / ready | 4 / **60** · 8 files +787/−18 | **merge-candidate** (candidacy theo Mục 9) | Roadmap **Mục 9**: *"candidate source for S2; re-review exact current HEAD before adoption"*; North Star §7 event-driven autonomy | Vẫn OPEN đúng định hướng "candidacy". → Chạy re-review đúng HEAD, chọn delta cho S2 rồi adopt/đóng. |
| **185** | control-loop: thay Gemini pre-review bằng REVIEW-ONLY OCR/OpenCode leg | OPEN / ready | 1 / **74** · 17 files +3496/−34 | **superseded / defer** | Roadmap **Mục 9** + **S6**: *"defer until adoption seam is available or selectively port later"*; North Star §10 "không SuperAssistant trong critical path" | Giữ làm nguồn tham chiếu đến khi có seam S6; **không merge toàn bộ**. |
| **186** | docs: canonical R4a test execution policy | OPEN / ready | 2 / **74** · **18 files +3516/−34** | **superseded (như hiển thị)** | Roadmap **Mục 9**: *"canonicalize narrowly rather than importing unrelated cumulative changes"* | **Sai lệch nghiêm trọng:** PR body nói "AGENTS.md, 20 insertions" (base `04a6b08` = head của #185), nhưng GitHub base là `main` → PR này **gói trọn changeset của #185**. Đề xuất: tách nhánh mới chỉ với +20 dòng `AGENTS.md`, rồi **đóng #186**. (Verify: `origin/main` **chưa** có mục R4a trong `AGENTS.md` → intent vẫn chưa canonicalize.) |
| **187** | AG-UI PoC (technical): protocol layer, Soc_brain UI stays primary | OPEN / **DRAFT** | 3 / **60** · 12 files **+13615**/−10 | **obsolete (giữ PoC)** | Roadmap **§8 Deferred**: *"treat #187 as protocol/PoC evidence"*; North Star §10 không mở rộng ngoài critical path | Giữ DRAFT làm PoC evidence; không đưa vào critical path. Đề xuất chốt mốc close-sau-khi-lưu-trữ. |
| **188** | final-review: universal loop handoff — review-leg budget, smoke seam, P0 binding gate | OPEN / **DRAFT** | 3 / **60** · 28 files +8596/−78 | **superseded (một phần đã port)** | Roadmap **Mục 9** + **S4**: *"source of useful binding/review-loop work for S4; do not wholesale merge"* | S4 đã giao qua **#207/#208** (Roadmap: S4 `IMPLEMENTED`); binding 5-field đã có ở S4/`soc_authorize_merge`. → Rà delta còn thiếu, port phần cần, **đề xuất đóng #188 + #189**. |
| **190** | delivery: repository-wide autonomous delivery with fixed Web2API-copy Final Review | OPEN / **DRAFT** | 1 / **60** · 13 files +2259/−35 | **superseded / blocked** | Roadmap **Mục 9**: *"source of delivery/recovery/UI/Web2API experiments; review transport is degraded; do not wholesale merge"*; **S5** đã `INTEGRATED` qua **#229** | Comment cuối tự xác nhận `BLOCKED_REVIEW_TRANSPORT` (2 lần fail-closed `TURN_NOT_OBSERVED`). → Inventorize delta còn giá trị, port về S3/S5, **đề xuất đóng**. |
| **195** | executor: thêm Command Code provider | OPEN / **DRAFT** | 1 / **56** · 6 files +365/−28 | **obsolete → defer** | Roadmap **§8 Deferred**: *"Command Code and additional executor adapters"* | Giữ DRAFT/deferred; body tự nói *"live canonical launch chưa chạy"*. Không mở lane mutation mới trong bootstrap (Roadmap §4). |
| **214** | supervisor: reactive event engine + drift guard | OPEN / **DRAFT** | 2 / **31** · 5 files +287/−66 | **obsolete / duplicate** | Roadmap S-track đã ghi **PR #215 `DETERMINISTIC_VERIFIED`** | Task 9000022 **đã giao qua #215 MERGED**; #214 lại đụng `bin/soc-task-bootstrap.mjs` (dường như provision nhầm). → Đề xuất **close**. |
| **216** | supervisor: reactive event engine + drift guard (bản không-draft) | OPEN / ready | 3 / **30** · 6 files +1251/−16 | **superseded** | Roadmap S5: #215 đã `DETERMINISTIC_VERIFIED` (717/717) | Cùng goal nhưng nhánh dùng `packages/supervisor/**supervisor-engine.mjs**` song song với `reactive-engine.mjs` đã lên main → **hai kiến trúc trùng**. PR này còn phát sinh Issue #218. → Đề xuất: rút phần delta còn thật sự thiếu (nếu có), rồi **đóng #216**. |
| **220** | chore: verify end-to-end bootstrap integration | OPEN / **DRAFT** | 1 / **29** · 2 files +25/−14 | **obsolete** | Roadmap S5 đã `INTEGRATED` (#229) | Nhánh automated còn sót (body chỉ ghi worktree). → Đề xuất **close**. |
| **221** | control-loop: reactive process exit, granular milestone telemetry, auto-review handoff | OPEN / ready | 1 / **29** · 4 files +216/−11 | **merge-candidate (bất thường — cần chốt)** | Roadmap §3 *"process alive ≠ capability healthy"*; §5 evidence | **BẤT THƯỜNG:** PR song sinh **#222 đã MERGED cùng title/body** nhưng chỉ đổi `SOC_TASK_CONTRACT.md` + `tests/client-mcp-supervisor.test.mjs`; verify `origin/main` **không có** `exportReviewDiff` / `HUMAN_GATE_EVENT` → **tính năng thật chưa lên main**. → Đề xuất: review #221 (4 files) hoặc mở lại bằng nhánh sạch; điều tra vì sao #222 merge mà thiếu delta. |
| **234** | docs(backlog): backlog triage & audit report (PR này) | OPEN / **DRAFT** | 2 / 0 · 1 file docs mới (commit `f09fd84`) | **merge-candidate** | R5 diff bundle; R9 roadmap sync (lệch phạm vi — xem ghi chú cuối) | Đã test PASS (784/784) + R5 bundle → handoff review rồi Bố merge. |

**Ghi chú phạm vi nhánh PR #234:** ngoài file mới `docs/backlog-triage-audit.md`, diff của nhánh còn
chứa `SOC_TASK_CONTRACT.md` (+9/−28) do **commit bootstrap `d655df5`** render sẵn (không phải thay đổi
do task này sửa). Executor **không sửa** file đó.

---

## (d) Số phận PR #184–#190 (Roadmap Mục 9) — Thực tế vs Định hướng

Định hướng trích từ `docs/MASTER_ROADMAP_v2.md` **Mục 9 — Open PR treatment at roadmap reset**
(*"As of 2026-09-19, do not infer canonical status from an open PR"*).

| PR | Trạng thái THẬT (đọc remote hôm nay) | Draft | Diff vs main | Định hướng (Mục 9 / các mục khác) | Khớp? | Đề xuất |
|---|---|---|---|---|---|---|
| **#184** | **OPEN** | không | 8 files +787/−18 (ahead 4 / behind 60), updated 2026-09-18 | *"recovery/liveness — candidate source for **S2**; re-review exact current HEAD before adoption"* | ✅ Đúng: vẫn là ứng viên chưa adopt | Re-review đúng HEAD hiện tại; port delta S2, phần còn lại đóng |
| **#185** | **OPEN** | không | 17 files +3496/−34 (ahead 1 / behind 74) | *"external/unadopted candidate; **defer** until adoption seam is available (S6) or selectively port later"* | ✅ Đúng: đang defer | Giữ nguyên làm nguồn; **không merge toàn bộ**; port có chọn lọc khi seam S6 có |
| **#186** | **OPEN** | không | **18 files +3516/−34** (ahead 2 / behind 74) | *"policy intent belongs in S0/S1; **canonicalize narrowly** rather than importing unrelated cumulative changes"* | ⚠️ **Không khớp về hình thức**: PR chứa **toàn bộ changeset của #185** (gồm `AGENTS.md` +20 dòng), trái với "narrowly" | Tách nhánh mới chỉ +20 dòng `AGENTS.md`, merge nhánh đó, **đóng #186** (Bố duyệt) |
| **#187** | **OPEN** | **DRAFT** | 12 files **+13615**/−10 (ahead 3 / behind 60) | *"preserve as **PoC**; not bootstrap critical path"* (§8 Deferred) | ✅ Đúng: vẫn Draft, ngoài critical path | Giữ DRAFT làm PoC evidence; đặt hạn chốt để đóng khi đã lưu trữ evidence |
| **#188** | **OPEN** | **DRAFT** | 28 files +8596/−78 (ahead 3 / behind 60) | *"source of useful binding/review-loop work for **S4**; **do not wholesale merge**"* | ✅ Đúng: chưa merge; đồng thời S4 **đã** giao qua #207/#208 | Rà delta còn thiếu vs S4 hiện tại → port phần cần rồi **đóng #188** |
| **#189** | **KHÔNG TỒN TẠI như PR** — `gh pr view 189` → `GraphQL: Could not resolve to a PullRequest with the number of 189`. **#189 là Issue OPEN** (tracking cho draft PR #188, `MERGE_DECISION = DEFER`) | — | — | Mục 9 liệt kê theo dải "#184–#190" như thể là PR | ⚠️ **Sai lệch nhận dạng** — cần ghi rõ để không xử lý nhầm | Giữ #189 là issue tracking; đóng kèm #188 sau khi chốt |
| **#190** | **OPEN** | **DRAFT** | 13 files +2259/−35 (ahead 1 / behind 60), comment cuối: `BLOCKED_REVIEW_TRANSPORT` | *"source of delivery/recovery/UI/Web2API experiments; current review transport is **degraded**; **do not wholesale merge**"* | ✅ Đúng: vẫn Draft, blocked; S5 đã `INTEGRATED` qua **#229** | Inventorize delta giá trị (delivery/recovery/Web2API), port về S3/S5, **đóng #190** (Bố duyệt) |

**Kết luận mục (d):** 6 PR được Mục 9 nêu (**#184, #185, #186, #187, #188, #190**) **đều còn OPEN**
— không PR nào bị merge/close lén, đúng tinh thần *"do not infer canonical status from an open PR"*.
Hai điểm lệch cần chốt: (1) **#186 không "narrow"** như định hướng (gói trọn #185);
(2) **#189 không phải PR**. Không thao tác ghi remote nào được thực hiện trong khảo sát này.

---

## (e) Tổng hợp đề xuất theo ưu tiên + rủi ro

### P0 — quyết định cần Bố (không tự xử lý)

| # | Đề xuất | Lý do | Phụ thuộc |
|---|---|---|---|
| 1 | Chốt số phận **PR #144 + Issue #107** | GPT REWORK 0.97, **rework budget 3/3 hết**; một phần delta (CDP timeout) lệch hướng "loại CDP khỏi critical path" | Bố chọn: tách PART 0 sạch / đóng |
| 2 | Chốt số phận **Issue #103 / #92 / PR #95** | 3 lifecycle blocked vì infra; nội dung known-good @ `8701649`; #95 ambiguous theo rule #138 | Bố chọn executor/môi trường |
| 3 | Xác minh & xử lý **PR #221 vs #222** | #222 đã MERGED cùng title nhưng **không mang tính năng**; `origin/main` thiếu `exportReviewDiff`/`HUMAN_GATE_EVENT` | Cần điều tra nguyên nhân trước khi merge/close |
| 4 | Sửa **flake SR11b/F1 (Issue #218)** | Tái diễn trong full-suite (776/777 một lần); directly ảnh hưởng baseline 784 | Thuộc S1 *execution truth* |

### P1 — dọn backlog có bằng chứng (đề xuất close, chờ duyệt)

| # | Đề xuất | Bằng chứng |
|---|---|---|
| 5 | Close **#212** | PR #213 MERGED + `dispatchGranularMilestone` có trên `origin/main` |
| 6 | Close **#164 + PR #166** | PR #168 MERGED làm cùng việc; nhánh #166 cũ hơn main (idle-supervisor 450/1577 vs main) |
| 7 | Close **PR #214, PR #216** | Task 9000022 đã giao qua #215 `DETERMINISTIC_VERIFIED`; #216 dựng `supervisor-engine.mjs` song song `reactive-engine.mjs` |
| 8 | Close **PR #220** | Nhánh automated còn sót, S5 đã `INTEGRATED` (#229) |
| 9 | Tách nhánh R4a hẹp → close **PR #186** | PR đang mang +3516/18 files (gói #185); intent `AGENTS.md` +20 dòng chưa có trên main |
| 10 | Review **PR #156** (merge-candidate mạnh nhất) | Evidence round-7, HEAD `923bbbf`, "307/307 PASS" — cần GPT PASS + **authorize merge của Bố** |

### P2 — review / adopted-then-close / defer

| # | Đề xuất |
|---|---|
| 11 | **PR #38** (Issue #37): blocker upstream cleared → rebase (behind 191) + GPT review + merge |
| 12 | **PR #184**: re-review đúng HEAD (Mục 9) → port delta S2 |
| 13 | **PR #68** (Issue #67): review sau 20 ngày im lặng; tách phần E2E CDP (đã không production-ready) |
| 14 | **PR #152** (Issue #147): tiếp tục rework round 4 |
| 15 | Inventory delta còn giá trị của **#185 / #188 / #190 / #187** → port có chọn lọc rồi đóng (theo Mục 9 + S6 + §8) |
| 16 | **PR #95**: tái xác minh → close, giao lại cho #103 |
| 17 | Giữ defer: **PR #195** (Command Code, §8), **Issue #21** (post-bootstrap), **Issue #162/#51/#192** (backlog S/XS) |

### Rủi ro & biện pháp giảm thiểu

| Rủi ro | Mức | Biện pháp |
|---|---|---|
| **Đóng nhầm việc còn sống** (vd. #156/#38 chưa review xong) | Cao | Mọi close/merge **chỉ là đề xuất**; đọc lại state/HEAD đúng lúc hành động (Roadmap §9, North Star §6.11) |
| **Merge nhánh cũ làm hồi phục code** (đặc biệt **#166** vs main đã tiến hóa; các PR behind 56–191 commit) | Cao | Rebase/review từng PR; không merge theo thói quen để "dọn backlog" (Roadmap S0: *"do not merge broad overlapping PRs merely to clear backlog"*) |
| **#186 vô tình import cả #185** vào main | Cao | Tách nhánh mới hẹp (+20 dòng `AGENTS.md`); không dùng nhánh `docs/r4a-test-execution-policy` hiện tại |
| **#221/#222 lệch sự thật** — PR song sinh đã merge nhưng tính năng chưa lên main | Cao | Điều tra trước; không coi "đã merge title này" là đã giao hàng (§3 *read-back evidence outranks narrative*) |
| **Flake #218 làm full-suite FAIL giả** | Trung bình | Nếu fail, chẩn đoán targeted theo đúng SR11b, **không** raise timeout / skip / force-serial / blind retry |
| **Sai lệch nhãn FSM** (#212 vẫn `in-progress` dù đã merge; 8 issue không nhãn) | Trung bình | Đề xuất đồng bộ nhãn khi Bố duyệt (R8 lifecycle) — executor không tự sửa label |
| **Nhầm #189 (Issue) thành PR** | Thấp | Đã verify qua API: không có PullRequest #189 |
| **Scope creep của task này** | Thấp | Chỉ tạo 1 file mới; không sửa file nào khác; không thao tác remote |

---

**Kết luận:** backlog thực tế gồm **16 Issue OPEN** và **19 PR OPEN (7 Draft)**; trọng tâm cần Bố quyết
định là 4 việc P0, 6 việc dọn P1 (đều có bằng chứng read-back), phần còn lại là review/defer theo
đúng Roadmap Mục 9. Không có close/merge/label/commit remote nào được thực hiện trong khảo sát này.

---

## Ghi chú tuân thủ phạm vi

- **Phạm vi ghi file:** chỉ tạo đúng **1 file mới** `docs/backlog-triage-audit.md`; không sửa bất kỳ file nào khác trong repo.
- **Không thao tác ghi remote:** toàn bộ dữ liệu lấy bằng `gh issue list/view`, `gh pr list/view`, `gh repo view`, `git fetch` + `git diff`/`git rev-list` (đọc). Không `gh issue close`, `gh pr close`, `gh pr merge`, không label/comment edit, không `push --force`, không amend/revert. Commit **local** trên nhánh task, **chưa push**.
- **R9 (Roadmap Sync Gate) — treo có chủ đích:** task cấm sửa file khác nên `docs/MASTER_ROADMAP_v2.md` **chưa** được cập nhật tại đây. Đề xuất: sau khi Bố duyệt + merge PR #234, cập nhật Roadmap (dòng `Date:` header + bằng chứng `docs/backlog-triage-audit.md` / PR #234 / SHA) để không thiếu bằng chứng bàn giao.
- **R8 (label lifecycle) — không áp dụng:** local binding `#9000023` không phải GitHub issue; mọi lệnh label/issue với số này bị bỏ qua. Executor không tự apply/gỡ bất kỳ nhãn nào (kể cả #212 đang sai lệch `status:in-progress`).
- **Test trước khi bàn giao:** `node --test tests/*.test.mjs` → **784/784 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo, not-ok = 0, exit 0** — baseline giữ nguyên (0 regression).
