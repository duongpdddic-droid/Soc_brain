<!-- SOC_INTERNAL_REVIEW_CHAIN_V2 -->
## INTERNAL REVIEW → REWORK → FINAL REVIEW

Policy của Bố cho task sửa code/logic; thay thế hướng dẫn OCR tùy chọn và các yêu cầu review lại toàn PR ở mọi lượt nội bộ trước đây.

### Lượt đầu
1. Hoàn thành implementation và kiểm chứng bị ảnh hưởng; cập nhật TODO, acceptance/scope, exact base SHA và candidate SHA. Công bố thay đổi chưa commit; không dùng evidence của candidate cũ để xác nhận bản sửa mới.
2. OCR là pre-review đầu tiên: xác minh ocr_health sau khi nạp plugin/đổi cấu hình, rồi review toàn changeset base..candidate và code liên quan cần thiết bằng exact SHAs. **OCR chỉ chạy một lần cho candidate đầu**; preview/resume không thay review toàn task. Xử lý findings, sửa, kiểm chứng và re-review phần sửa cùng ảnh hưởng bằng `soc_review`; không chạy lại OCR mỗi vòng rework.
3. Gọi subagent internal review; ưu tiên agent đích soc_review với model đã cấu hình. **Đây là internal review, không phải final approval.** Lượt đầu của reviewer này đánh giá độc lập toàn changeset và các đường liên quan, không chỉ xác nhận findings OCR. Xử lý findings → sửa → kiểm chứng → re-review phần sửa và ảnh hưởng liên quan đến khi PASS.
4. Final review là tùy chọn do Bố quyết và **chỉ chạy khi Bố gọi trực tiếp `soc_review`**; một `soc_review` subagent được gọi theo quy trình chỉ là internal review, không phải final approval. Mặc định không chạy; PR bàn giao sau khi internal review PASS và full suite (khi planner/contract đòi) đã chạy đủ 1 lần. Khi Bố yêu cầu, final review chạy trên candidate mới nhất; mỗi lượt final chịu trách nhiệm tổng thể toàn PR: acceptance, toàn diff, code liên quan, regression/rủi ro, evidence và lịch sử findings. Final PASS → đề nghị Bố merge; không tự merge/deploy hoặc tự final-approve.

### Sau final REWORK
5. Sửa findings final và chạy kiểm chứng bị ảnh hưởng trước. **Không chạy lại OCR sau final REWORK**; chỉ re-review scoped phần sửa/ảnh hưởng bằng `soc_review`. Nếu OCR coverage còn gap, xử lý theo cổng OCR (rerun có thẩm quyền hoặc chuyển file text trong scope cho reviewer), không chạy lại OCR mỗi vòng.
6. Tiếp tục subagent internal review (ưu tiên soc_review): xem findings final còn mở, toàn delta kể từ candidate đã review và các đường chịu ảnh hưởng. Sửa → kiểm chứng → re-review phần sửa/ảnh hưởng đến khi PASS. Nếu Bố gọi final review, bàn giao final review tổng thể toàn PR trên candidate mới nhất. Lặp lại luồng này nếu final tiếp tục REWORK.

### Phạm vi và cách gọi subreview
- Lượt OCR đầu tiên và lượt subreview đầu tiên cần phủ toàn changeset; lượt re-review tập trung findings đang mở, delta và tác động liên quan. Mở rộng tới toàn changeset nếu bản sửa đổi cơ chế chung, mở rộng scope hoặc làm evidence trước mất giá trị. Không bắt subreview đọc lại toàn PR chỉ vì có candidate mới; giữ evidence còn hợp lệ.
- Prompt subreview phải có repo/worktree, exact base/candidate, acceptance/scope, loại lượt (initial toàn task hay re-review), findings/lịch sử và evidence liên quan; yêu cầu đọc source, tìm lỗi cơ chế/tác động, trả verdict cùng findings có vị trí và cách kiểm chứng. Subreview read-only; không buộc reviewer chạy lại full suite đã PASS.
- soc_review là lựa chọn ưu tiên, không khóa cứng quyền gọi agent/model. Nếu đã gọi nhầm hoặc soc_review không khả dụng, kết quả từ subagent khác vẫn có thể dùng làm evidence nội bộ; công bố agent/model thực tế khi runtime cung cấp, thiếu metadata thì ghi chưa xác minh. Không bắt chạy lại chỉ vì khác tên agent; không đổi nhãn kết quả thành soc_review hoặc final approval.
- Riêng internal review được gọi subagent read-only theo policy này, thay thế lệnh cấm subagent trong hướng dẫn cũ đối với mục đích review. Subagent cho điều tra/thực thi khác vẫn tuân quyền và scope task hiện hành; policy này không cấp thêm quyền.
- Giữ ngân sách tối đa 3 lần sửa thất bại cho từng finding/root cause theo SOC_REVIEW_BUDGET_PER_FINDING_V1; không cap tổng invocation. Timeout/transport error/sai binding không tính là một lần sửa thất bại. Không bỏ re-review bản sửa cuối vì đã gọi review hơn 3 lần.
- Review PASS ở từng bước chỉ cho phép đi tiếp. Tool/config/model lỗi hoặc output không đủ coverage không phải review sạch. Không chạy lại khi CLEANUP_UNVERIFIED; xác minh tiến trình đã dừng trước khi retry. Với lỗi transient có thể retry an toàn, giữ quy định retry hiện hành; nếu không khắc phục được, báo blocker thật thay vì chờ vô hạn.
- Trước final handoff: đối chiếu TODO, gates bắt buộc, findings, candidate binding và toàn diff. Final có thể kế thừa evidence còn hợp lệ nhưng vẫn chịu trách nhiệm tổng thể toàn PR. Ghi đúng cơ chế/phạm vi/elapsed time/giới hạn; policy không tự nạp vào server đang chạy.
<!-- END_SOC_INTERNAL_REVIEW_CHAIN_V2 -->
