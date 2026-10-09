# P1 — Xóa đơn an toàn và kiểm tra trạng thái tạo đơn

Bản thay thế tiếp theo sau PR #24; kiểm tra tối 09/10/2026 giờ Việt Nam. Không thử sửa, xóa hoặc tất toán đơn thật.

## Vấn đề và phương án đã thực hiện trong mã

| Vấn đề | Ảnh hưởng tại tiệm | Bản thay thế |
|---|---|---|
| Xóa kiểm tra tất toán rồi PATCH ở request khác | Đơn có thể bị xếp hàng xóa khi một người khác vừa gửi tất toán | `deleteOrder` nằm trong RPC giao dịch hiện có, cùng khóa đơn với sửa/ship/tất toán; ghi marker, audit, receipt cùng lúc |
| Thử lại xóa sau mất phản hồi | Có thể ghi marker/ghi chú nhiều lần, không biết thao tác đã thành công | Receipt và request ID giữ nguyên qua retry; vẫn trả kết quả sau khi đơn đã được lưu trữ |
| Luồng cũ có thể tiếp tục sửa/tất toán đơn đã xếp hàng xóa | Gây sai dữ liệu giữa lúc ghi Sheet và lưu trữ | Guard ở database chặn thay đổi nghiệp vụ trên đơn queued và chặn tạo/duyệt settlement cho đơn queued |
| Create-status chỉ kiểm tra session | Tài khoản đã khóa vẫn có thể đọc; yêu cầu của người khác chưa được giới hạn | Một RPC kiểm tra session còn hạn, user.active và người tạo qua receipt/audit. Admin được tra cứu hỗ trợ vận hành |
| Không tìm thấy đơn sau khi đã lưu trữ | Nhân viên có thể hiểu nhầm tạo đơn thất bại và tạo lại | Receipt xác nhận đơn từng tạo thành công, trả `archived=true` khi đã lưu trữ; không trả ảnh bill hoặc toàn bộ snapshot |
| Phần triển khai ngoài repository chưa có baseline | Lần deploy sau có thể bỏ sót ACK/xóa/recovery | Đưa schema/triggers ACK hiện hành, endpoint xóa/create-status và endpoint recovery đã nghỉ (404) vào repository |

Giữ quy trình hiện có: Admin yêu cầu xóa → đánh dấu `[ĐÃ XÓA]` trên đơn → hàng đợi ghi Sheet → ACK → lưu snapshot và gỡ khỏi danh sách. Chỉ xếp hàng xóa khi chưa settled và không có settlement PENDING/APPROVED. Không thay cách tính tiền.

Endpoint tương thích client cũ: tạo khóa xóa ổn định khi thiếu request ID và đọc phiên bản server khi client cũ chưa gửi version. Client mới gửi phiên bản từ chi tiết đang xem, giữ payload khi mất phản hồi, yêu cầu tải lại khi thiếu version. Vì vậy bản frontend mới cần được đưa lên cùng mã backend đã kiểm thử.

## Bằng chứng kiểm thử

- Local: 193 case, 187 PASS, 0 FAIL, 6 SKIP (cần PostgreSQL nhiều phiên trên CI).
- Log đầy đủ: `docs/validation/p1-local-tests.txt`.
- 32 test giao dịch SQL trên local, gồm xóa retry trước/sau archive, chặn pending/settled, stale version, Sale và tài khoản khóa, audit failure rollback, guard cho legacy write, scope request và phiên hết hạn.
- 6 test endpoint/client: từ chối auth trước mutate; retry đọc receipt trước đơn đã archive; truyền đúng version vào RPC; hash token khi tra trạng thái; button giữ payload sau mất phản hồi; không gửi khi thiếu phiên bản.
- CI chạy lại toàn bộ và suite PostgreSQL độc lập, gồm delete-vs-settlement, hai phiên retry xóa và legacy insert-vs-delete. Chỉ triển khai sau khi CI đạt; kết quả cụ thể xem run gắn với commit trong PR.

## Snapshot production trước triển khai

Truy vấn chỉ đọc trong lần kiểm tra tối 09/10: 5.689 đơn; 5 archive; 0 queued deletion; 0 đơn chờ Sheet; ACK mới nhất 14:37:09.240 UTC. Receipt: 26 createOrder, 7 updateOrder, 58 updateStatus. Đây là snapshot hệ thống, không phải dữ liệu thử nghiệm.

Các lỗi xung đột/auth đã tái hiện trên fixture và đối chiếu source deployed v1. Chưa tái hiện trên đơn hoặc tài khoản thật.

## Kiểm tra sau triển khai cần thực hiện

1. Đối chiếu definitions RPC và mã endpoint tải lại từ Supabase với bản đã test.
2. Kiểm tra quyền execute: anon/authenticated không có quyền; service_role có quyền. Chạy Security Advisor.
3. Probe read-only bằng session giả, không dùng session của nhân viên để impersonate và không ghi đơn thật.
4. Theo dõi tổng queued/settlement, số lượng archive và log sau triển khai; không khẳng định số lượng đơn giữ nguyên nếu tiệm đang tạo đơn trong lúc kiểm tra.

## Phần chưa thể đóng

- **Sheets/Apps Script production:** Google Drive chưa kết nối ở thời điểm chuẩn bị bản sửa. Đã tìm kết nối phù hợp và đề xuất; chưa đọc workbook hay xác minh worker thực tế. Chưa bắt buộc ACK có version để tránh làm gián đoạn worker hiện tại.
- **UI desktop/mobile và E2E đầy đủ:** lần thử lại qua cloud browser vẫn trả `Site Unavailable`; đây không phải bằng chứng website của tiệm sập. Chưa có phiên website và môi trường test phù hợp, không dùng đơn thật để test.
- **Baseline toàn database:** migration này đưa vào các phần ACK/xóa liên quan trực tiếp; không tuyên bố toàn bộ lịch sử database đã khớp repo.
- **GO toàn hệ thống:** chưa cấp; còn Apps Script thực tế, E2E và benchmark theo thao tác. Những phần chặn trên không ngăn việc kiểm thử và triển khai hai bản thay thế backend đã xác minh.
