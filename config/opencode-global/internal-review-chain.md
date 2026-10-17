<!-- SOC_INTERNAL_REVIEW_CHAIN_V2 -->
## INTERNAL REVIEW → FINAL REVIEW

Policy của Bố cho task sửa code/logic, thay thế mục OCR tùy chọn trong hướng dẫn cũ:
1. Tạo/cập nhật TODO; chốt acceptance, scope, base SHA và candidate SHA. Chạy regression/gate bị ảnh hưởng trước review. Review bản commit cụ thể; công bố mọi thay đổi chưa commit.
2. OCR là pre-review nội bộ bắt buộc: xác minh tool ocr_health sau khi nạp plugin/đổi cấu hình; gọi ocr_review với from/to là exact base/candidate SHAs cho toàn task. Preview, resume, review workspace chưa commit hoặc chỉ diff vòng sửa gần nhất không thay thế pre-review toàn task.
3. Xử lý findings OCR bằng evidence/root cause; sửa và kiểm chứng phần bị ảnh hưởng, rồi re-review bản sửa. Giữ bộ đếm tối đa 3 lần sửa thất bại cho từng finding theo SOC_REVIEW_BUDGET_PER_FINDING_V1; không cap tổng số invocation. Không tự động retry timeout hay CLEANUP_UNVERIFIED. Nếu transport/config/model bị lỗi, báo BLOCKED với lỗi thật; không gọi là review sạch hoặc tự bỏ OCR.
4. Sau OCR không còn finding hợp lệ đang mở, gọi soc_review subagent read-only để review toàn task trên exact candidate mới nhất, không chỉ finding cuối. Đây là ngoại lệ duy nhất của mục NO SUBAGENTS cho review này; build vẫn tự sửa code/chạy lệnh, không ủy quyền thực thi.
5. Rework findings soc_review, chạy kiểm chứng bị ảnh hưởng, re-review các findings và tác động liên quan. Khi code đổi, làm mới binding; chạy lại OCR nếu phần sửa chưa được OCR phủ trên candidate mới. Giữ evidence còn hợp lệ, không chạy lại full suite vô cớ.
6. Trước bàn giao final review, đối chiếu TODO, acceptance, các gates bắt buộc, toàn diff base..candidate, trạng thái findings và binding của evidence. soc_review phải có lượt tổng thể trên candidate cuối; đóng finding cuối không tự thay lượt này nếu nó chỉ soi delta.
7. Final review độc lập phải review tổng thể toàn task: requirements/acceptance, toàn changeset và các đường liên quan, regression/rủi ro, evidence và toàn bộ findings cũ. OCR và soc_review là evidence nội bộ, không phải final approval. Build không tự final-approve, terminalize, merge hoặc deploy.

Ghi đúng tool/cơ chế, base/candidate, phạm vi thực đọc, elapsed time, lỗi và giới hạn từng lượt. Chỉ ghi đã chạy khi invocation có kết quả thật. Policy không tự nạp plugin vào server đang chạy; activation/LLM health/Windows process-tree cleanup phải được xác minh riêng.
<!-- END_SOC_INTERNAL_REVIEW_CHAIN_V2 -->
