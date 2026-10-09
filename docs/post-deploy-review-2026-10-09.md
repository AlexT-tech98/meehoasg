# Kiểm chứng sau triển khai — 09/10/2026

**Kết luận:** Backend mới đã được triển khai và có giao dịch thực tế. Chưa đủ bằng chứng để đánh dấu toàn hệ thống PASS hoặc GO toàn diện. Đã xử lý ngay quyền dữ liệu công khai và bổ sung cổng nhập Sheets trên Supabase; không tạo/sửa/xóa đơn thật để thử nghiệm.

## Bản triển khai được xác minh

- PR #23 đã merge: main `9ae8da662b5e34fa28b1e5da5453753643a7fb79`; tree `2ec8238a2d66c60a1cb4bb2216968922db90151e` trùng bản đã kiểm thử.
- Nội dung tải trực tiếp từ Supabase của core v6, API v15, order-actions v3, writeback-feed v4 và các shared dependencies trùng mã trong PR.
- Migration `atomic_operations` đã có trên cơ sở dữ liệu production (`20261009054805`). RPC giao dịch không cấp EXECUTE cho anon/authenticated; service_role được phép.
- 7 receipt `createOrder`, 8 receipt `updateStatus`: bằng chứng giao dịch thật đi qua luồng mới. Không có receipt cho sửa đơn, nhập ship hoặc duyệt tất toán ở thời điểm kiểm tra; không suy diễn các luồng này đã được kiểm chứng production.

## Đối soát chỉ đọc

Kiểm tra vào khoảng 06:43–06:54 UTC (13:43–13:54 giờ Việt Nam).

| Kiểm tra | Kết quả | Phạm vi kết luận |
|---|---:|---|
| Tổng đơn | 5.670 | Snapshot tại thời điểm truy vấn |
| Full Paid thiếu bằng chứng | 0 | Quy tắc đối soát dữ liệu; chưa kiểm thử UI |
| Full Paid thấp hơn tổng phải thu | 0 | Quy tắc đối soát dữ liệu |
| Yêu cầu APPROVED nhưng đơn chưa tất toán | 0 | Quy tắc đối soát dữ liệu |
| Nhóm đơn có nhiều yêu cầu PENDING | 0 | Không thấy trùng tại snapshot |
| Đơn chờ đồng bộ Sheets | 0 | Không chứng minh nội dung Sheets khớp |
| Ghi nhận Sheets mới nhất | 06:37:58.702 UTC | ACK phía server; chưa đọc Sheets thực tế |

Các truy vấn chỉ trả aggregate, metadata quyền và definitions; không thử dùng API công khai để tải thông tin khách hàng.

## Lỗi xác nhận và xử lý đã triển khai

| Mã | Vấn đề / ảnh hưởng | Bằng chứng trước | Xử lý và bằng chứng sau |
|---|---|---|---|
| SEC-01 — nghiêm trọng | Hai bảng archive/backup có quyền đọc công khai; nguy cơ lộ dữ liệu đơn | `deleted_orders`, `orders_dup_artifact_backup_20261001`: RLS=false, anon/authenticated SELECT=true | Migration `protect_operational_archives`: RLS=true, anon/authenticated SELECT=false, service SELECT=true. Số dòng giữ nguyên: 5 và 68 |
| SEC-02 — cao | View audit dùng quyền owner và được đọc công khai | `order_card_quantity_audit`: reloptions=null, anon/auth SELECT=true; Advisor ERROR | `security_invoker=true`, thu hồi quyền công khai, giữ service SELECT |
| SEC-03 — trung bình | Sáu trigger function có search_path có thể thay đổi | Advisor WARN cho sáu function | Chốt `public, pg_temp`; Advisor sau sửa không còn WARN/ERROR bảo mật |
| SYNC-01 — cao | Hai dịch vụ ingest production chưa có cổng chặn nhập từ Sheets như PR | Nội dung tải từ deployed ingest v9 / settlement-ingest v1 không có `SHEET_IMPORT_ENABLED` | Đã deploy ingest v10 và settlement-ingest v3; tải lại mã trùng bản kiểm thử; import mặc định trả 409 trước DB write khi flag không bật |
| SYNC-02 — cao | Deploy nguyên ingest trong PR sẽ làm mất ACK của dịch vụ đang chạy, ảnh hưởng hàng đợi/xóa đơn | Deployed v9 có `needs_sheet_sync=false`, `sheet_synced_at`; bản PR chỉ cập nhật vị trí | Giữ ACK hiện tại trong bản mới; có kiểm thử thành công/xung đột/giới hạn batch và loại bỏ trường nghiệp vụ lạ |

SEC-01/02 là quyền truy cập đã xác nhận; chưa có bằng chứng rằng dữ liệu từng bị khai thác. Không kết luận đã có rò rỉ.

Security Advisor sau sửa chỉ còn 17 thông tin RLS không có policy: đây là mô hình dữ liệu riêng qua service_role. Không mở policy công khai để xóa thông báo. Tham khảo [RLS Advisor](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).

## Kiểm thử và benchmark

- Local suite mới nhất: **175 case, 172 PASS, 0 FAIL, 3 SKIP** (ba case cần PostgreSQL nhiều phiên). Log: `docs/validation/postdeploy-local-tests.txt`.
- Hai test riêng xác minh anon/auth bị từ chối trên cả ba object, service đọc được, dữ liệu còn nguyên; migration chạy được cả khi object production chưa tồn tại.
- Test import mặc định bị chặn trước bất kỳ fetch/DB write; test ACK có version dùng điều kiện id + updated_at và báo conflict khi không có row khớp.
- Test di chuyển Sheets dùng fixture: phục hồi lỗi metadata/append/delete, không tạo thêm bản sao khi retry; không tương đương Apps Script production.
- CI của PR #23 đã PASS; suite PostgreSQL thật trước merge: 26 PASS, 0 SKIP, có kiểm thử nhiều phiên. CI cho thay đổi mới phải được kiểm tra riêng.
- Hai probe POST không có secret hợp lệ trả 401; không ghi DB. Nội dung deployed tải lại trùng mã mới. Không thử import/ACK có secret trên đơn thật. Giá trị runtime của flag nhập và Apps Script đang chạy chưa được đọc trực tiếp.

Thống kê log từ **05:48 UTC đến khoảng 06:50 UTC**, chỉ POST, thời gian xử lý Edge Function (không phải thời gian toàn màn hình):

| Endpoint | Lượt | HTTP 5xx | P50 | P95 |
|---|---:|---:|---:|---:|
| API core | 95 | 0 | 813 ms | 2.219 ms |
| API legacy | 10 | 0 | 514 ms | 1.657 ms |
| Writeback feed | 52 | 0 | 868 ms | 1.208 ms |
| Ingest | 14 | 0 | 867 ms | 1.741 ms |

HTTP 200 không đảm bảo nghiệp vụ thành công (API có thể trả ok=false). Log không chứa action trong tập thống kê này, vì vậy chưa thể tách tốc độ đăng nhập/tìm kiếm/lưu từng loại thao tác.

## Chưa kiểm chứng và rủi ro còn lại

| Hạng mục | Trạng thái | Phương án tiếp theo / tiêu chí hoàn tất |
|---|---|---|
| Giao diện desktop/mobile và E2E theo ba vai trò | NOT TESTED trực tiếp trong lần kiểm tra này | Trình duyệt kiểm tra trả “Site Unavailable”. Cần phiên truy cập website hợp lệ và môi trường test; chạy tạo→sửa→bó→giao→ship→tất toán→dashboard, so sánh DB và UI. Không kết luận website thực tế bị sập |
| Sheets/Apps Script đang triển khai | NOT TESTED | Đọc phiên bản script và trigger thực tế; triển khai worker gửi `expectedUpdatedAt`; thử trên workbook test riêng trước khi chuyển |
| ACK cũ trong lúc hai người cùng cập nhật | RISK còn tồn tại | Backend đã hỗ trợ version guard và mã worker trong repo đã gửi version; worker cũ không gửi version vẫn tương thích. Chỉ đóng rủi ro sau khi xác minh worker production dùng mã mới, rồi bắt buộc version cho mọi ACK |
| Xóa đơn gặp tất toán đồng thời | RISK từ source | Deployed `meehoasg-delete-order` kiểm tra settlement rồi PATCH qua các request riêng; cần chuyển kiểm tra+xếp hàng xóa vào transaction có khóa đơn, receipt và test nhiều phiên. Không tái hiện trên đơn thật |
| Kiểm tra trạng thái tạo đơn với tài khoản bị vô hiệu hóa | RISK từ source | Deployed `meehoasg-create-status` chỉ kiểm tra session, thiếu kiểm tra user.active. Bổ sung active/role và phạm vi request của người tạo; kiểm thử tài khoản khóa trên fixture |
| Đồng bộ mã nguồn của phần vận hành ngoài repo | PARTIAL | Supabase có `delete-order`, `create-status`, `sheet-recovery`, các migration ACK/xóa an toàn chưa có đầy đủ trong repo. Cần đưa baseline đã rà soát vào repo để lần deploy sau không bỏ sót |
| Performance đăng nhập, mở module, tìm/lưu/sửa và mobile | NOT TESTED theo thao tác | Lập benchmark bằng tài khoản test, tối thiểu 20 lần/thao tác, ghi cold/warm và P50/P95; hiện chỉ có benchmark endpoint |

## Thứ tự xử lý

1. **Đã làm:** khóa archive/view, chốt search_path; deploy cổng import và giữ ACK; đối chiếu mã deployed sau sửa.
2. **P1:** kiểm chứng và chuyển Apps Script sang ACK có version trên workbook test; sau đó bắt buộc version để đóng nguy cơ ACK cũ xác nhận nhầm bản mới.
3. **P1:** thay xóa đơn bằng transaction, thêm kiểm tra active cho create-status, đưa baseline vận hành hiện đang thiếu vào repo; chạy concurrent settlement/delete và session khóa.
4. **P1:** chạy E2E ba vai trò trên môi trường test và desktop/mobile khi có phiên truy cập; kiểm chứng hóa đơn ảnh, dashboard, công nợ và retry mất kết nối.
5. **P2:** benchmark theo thao tác, kiểm tra recovery/backup và cập nhật feature matrix đầy đủ bằng bằng chứng mới.

**Go/No-Go:** Chưa cấp GO toàn hệ thống. Phần giao dịch backend có bằng chứng triển khai và sử dụng; các kiểm tra UI, Apps Script thực tế và E2E còn thiếu phải hoàn thành. Không tự thay đổi dữ liệu nghiệp vụ để tạo bằng chứng.
