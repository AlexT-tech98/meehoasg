# MEEHOA R2 — Giai đoạn thử nghiệm có bản dự phòng Supabase (72 giờ)

**Phạm vi được chủ hệ thống duyệt ngày 04/11/2026:** Chỉ thử nghiệm lưu ảnh mẫu, ảnh xem trước và bill qua R2; giữ bản dự phòng Supabase tạm thời đúng 72 giờ. Không thay đổi tạo đơn, Dashboard, KPI, Payment Check, vai trò hay dòng tiền.

## Điều kiện trước khi bật Production
- Pull request chỉ được merge/deploy sau khi có phê duyệt riêng của chủ hệ thống.
- Xác nhận website hoạt động với cả hai cờ R2 đang tắt và có bản phát hành/rollback hợp lệ.
- Xác nhận R2 bucket riêng tư, CORS hỗ trợ PUT từ website, presigned URL hợp lệ; không đưa khóa bí mật vào trình duyệt.
- Tạo thời điểm bắt đầu bằng UTC ISO 8601 trong `R2_TRIAL_START_AT` khi thực sự khởi động 72 giờ; không đặt sẵn thời gian bằng ngày tạo PR.

## Quy trình chuyển đổi — giữ nguyên thứ tự duyệt
1. Triển khai phiên bản website hỗ trợ R2, để `R2_READS_ENABLED=false`, `R2_UPLOADS_ENABLED=false`. Kiểm tra tạo/sửa đơn, Dashboard, KPI, Payment Check, mở ảnh mẫu/bill, xác nhận phiên bản.
2. Bật `R2_READS_ENABLED=true` trước, `R2_UPLOADS_ENABLED=false`. Mở ít nhất 20 ảnh mẫu và 20 bill nhiều ngày, kiểm tra ảnh thiếu trong R2 vẫn đọc được từ Supabase.
3. Khi được chủ hệ thống cho phép bật ghi: đặt `R2_TRIAL_BACKUP_ENABLED=true`, `R2_TRIAL_START_AT=<UTC_ISO_AT_REAL_ACTIVATION>`, rồi bật `R2_UPLOADS_ENABLED=true`. Trong 72 giờ, ảnh mới được ghi R2 **và** dự phòng Supabase với cùng bucket/path; máy chủ phải xác minh tồn tại cả hai trước khi chấp nhận lưu đơn. Thử tối thiểu 10 ảnh mới, bao gồm mẫu, ảnh preview và bill, nhiều ảnh cùng đơn, retry, sửa đơn và đối soát.
4. Thử quay lui trên môi trường kiểm thử và xác nhận các ảnh tạo trong 72 giờ được mở lại từ Supabase sau khi tắt `R2_READS_ENABLED=false` và `R2_UPLOADS_ENABLED=false`. Nếu thử thật trên Production phải có lệnh duyệt tương ứng.
5. Khi đã đủ 72 giờ, cờ thử nghiệm `R2_TRIAL_BACKUP_ENABLED=true` với cùng thời điểm bắt đầu **không tự chuyển sang R2-only**. Hệ thống tự trả thao tác **ghi ảnh mới về Supabase** khi hết cửa sổ thử nghiệm, bảo vệ vận hành nếu chưa có quyết định cuối. Các bản dự phòng đã lưu không bị xóa tự động.
6. Chỉ sau khi chủ hệ thống xác nhận toàn bộ tiêu chí và duyệt giai đoạn tiếp, mới được chuyển sang R2-only; việc tắt cờ thử nghiệm, gỡ `meehoasg-r2-copy` hoặc xóa bản dự phòng là các thay đổi **chưa được phép** trong PR này.

## Tiêu chí PASS 72 giờ
- 100% ảnh mẫu, preview và bill trong bộ thử mở đúng từ R2; 100% bản sao dự phòng của ảnh tạo trong thử nghiệm hiện diện, dung lượng trùng khớp và đọc lại được từ Supabase.
- Lưu đơn mới, sửa đơn, Full Paid, gửi/duyệt Payment Check, KPI/Doanh thu và phân quyền không phát sinh lỗi do R2.
- Kiểm chứng khi thiếu một bản dự phòng, lưu đơn phải báo lỗi thay vì nhận thành công; kiểm chứng R2 lỗi/thiếu thì đọc từ Supabase, không hiển thị nhầm ảnh.
- Kiểm chứng sau giờ thứ 72: **không** phát sinh ảnh chỉ có trên R2 nếu chưa có duyệt chuyển sang R2-only; ảnh mới quay về Supabase theo cơ chế an toàn.
- Egress Supabase đo chính thức cùng kỳ và đối chiếu lưu lượng tương đương; mục tiêu giảm >=80% **lưu lượng phục vụ ảnh**, không đánh đồng với tổng Egress không phân loại.

**Không tự kết luận PASS chỉ từ CI.** Sau 72 giờ thử nghiệm và thêm 7 ngày quan sát Egress thực tế mới trình kết luận cuối; các mốc này chỉ tính từ lúc thực sự bật thử nghiệm trên Production.

## Các giới hạn phải được trình chủ hệ thống
- Các ảnh R2-only được tạo **ngoài** thời gian thử nghiệm không đương nhiên có bản dự phòng. Tắt R2 hoàn toàn khi đã chuyển sang R2-only cần khôi phục riêng những ảnh đó.
- Việc xác minh kích thước ảnh không thay thế cho kiểm tra nội dung ảnh; phải mở/đối chiếu ảnh thực tế khi nghiệm thu.
- Signed upload ticket cấp sát thời điểm kết thúc có thể hết hạn sớm theo mốc 72 giờ; nhân viên cần tạo lại quyền tải ảnh nếu nhận lỗi hết hạn.
- Cấu hình R2 và các cờ điều khiển ở phía máy chủ không được cung cấp vào HTML. Tuyệt đối không chạm dữ liệu thật trong giai đoạn chuẩn bị.

**Trạng thái:** Prepared on review branch only — NOT DEPLOYED.
