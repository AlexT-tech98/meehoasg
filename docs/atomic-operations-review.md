# Bản thay thế luồng vận hành — 08/10/2026

**Phạm vi:** tạo/sửa đơn, trạng thái sản xuất, phí ship, gửi/duyệt tất toán, Full Paid và writeback Sheets liên quan. Bản đề xuất trên nhánh riêng, chưa áp dụng migration, chưa merge, chưa triển khai hoặc sửa dữ liệu thật.

**Kết luận:** đủ để review và kiểm thử staging; **chưa đủ bằng chứng để GO production**. Kiểm thử tự động dưới đây chứng minh hành vi trong môi trường kiểm thử, không chứng minh website đang triển khai đã được sửa.

## Vấn đề → phương án đã thực hiện → bằng chứng

| Vấn đề và ảnh hưởng | Phương án trong bản thay thế | Bằng chứng tự động |
|---|---|---|
| Hai mẫu hoa khác nhau bị ghép vào một đơn | Bỏ so khớp gần đúng; mỗi lần tạo có mã riêng. Mã đã lưu chỉ trả lại kết quả, không cập nhật thêm phụ kiện | `atomic-operations`: two different bouquets; lost-response retry; changed content; another actor |
| Một đơn lưu nhiều lần rời rạc, có thể thiếu thiệp, phụ kiện hoặc Full Paid | Các trường, ảnh tham chiếu, audit và biên nhận cùng nằm trong một giao dịch SQL | normal order; Full Paid exact 645000 total; injected audit failure rollback |
| Sale sửa/nhập ship đơn của người khác | Kiểm tra chủ đơn trong SQL và dùng cùng dịch vụ ghi trên cả core, legacy và order-actions | owner and optimistic timestamp; sale cannot change another sale shipping |
| Hai người mở bản cũ, lần lưu sau đè ghi chú | Lưu phải kèm nguyên phiên bản `updated_at`; SQL khóa đơn và từ chối bản cũ | owner and optimistic timestamp; ba ca đa phiên PostgreSQL trong CI |
| Đã duyệt yêu cầu nhưng đơn chưa được tất toán | Duyệt, tất toán, audit, biên nhận trong cùng giao dịch; cùng quyết định có thể phục hồi trạng thái cũ lệch | atomic review; injected settled failure rollback; historical inconsistency repair |
| Tổng đơn tăng nhưng tiền đã thu bị đọc thành thanh toán đủ | Giữ số tiền đã thu, gỡ xác nhận Full Paid khi thiếu bill mới; bộ đọc ưu tiên số tiền cụ thể | increase invalidates Full Paid; core collected amount/debt: 500.000đ → đơn 600.000đ còn nợ 100.000đ |
| Mất phản hồi, sửa form rồi bấm lại có thể tạo trùng | Giữ mã và bản nội dung đã gửi trong form để xác minh cùng thao tác trước | order-save: lost response; changed draft retry recovers original payload |
| Bill/ảnh không hiển thị ngay sau lưu | Core ký URL của cả ảnh mẫu lẫn bill ở kết quả trả về; không trả toàn bộ bản ghi thô | vị trí `decoratedExisting` và `operationResult`; **hiển thị trên website thật chưa kiểm thử** |
| Ly hồng bị mất khi bó có thêm Ecuador | Tách biến thể Ly trước khi nhận diện nguyên liệu khác, đổi phiên bản cache | core-payment-classifier: ba cách viết bó hỗn hợp, Ly sơn xanh đậm + Tulip |
| Chuyển đơn sang tab tháng mới: append xong lỗi meta/xóa làm kẹt duplicate | Nhật ký chuyển tab trước append; chỉ phục hồi duplicate thuộc nhật ký; meta thành công mới xóa nguồn; kiểm tra ID và snapshot nguồn; tính lại vị trí cuối | sheet-move-recovery: metadata failure, append response lost, delete failure, manual source edit, duplicate fail-closed, row shifts |
| Sheets thiếu số thiệp và dữ liệu Full Paid | Feed xuất đủ trường; giữ 17 cột meta cũ, bổ sung 8 cột 18–25, có tiêu đề và mở rộng chiều rộng nếu cần | ingest-gate: feed fields; sheet-move-recovery: 25-column metadata |
| Writer Sheet cũ có thể ghi đè website sau cutover | Import đơn/tất toán mặc định chặn; chỉ feed và cache vị trí được phép. Opt-in import phục vụ quy trình migration được kiểm soát | ingest-gate: 409 trước mọi DB write; position write chỉ hai trường |
| Upload mẫu xong lỗi bill/SQL để lại ảnh rác | Kiểm tra cả nhóm trước upload; dọn ảnh khi lỗi trước SQL hoặc SQL từ chối chắc chắn; giữ ảnh khi mất phản hồi SQL | storage-recovery: 5 ca lỗi, rollback upload và receipt race |

## Kiến trúc ghi mới

UI → Edge Function xác thực phiên → dịch vụ ghi chung → `mee_ops_mutate` → đơn + yêu cầu tất toán + audit + biên nhận.

Biên nhận được khóa theo người dùng/mã yêu cầu; đơn được khóa theo ID. Endpoint trình duyệt không có quyền gọi RPC trực tiếp bằng anon/authenticated. RPC chỉ cấp quyền service_role và kiểm tra lại tài khoản còn hoạt động.

Storage và Sheets là hệ thống ngoài PostgreSQL, **không thuộc giao dịch SQL**. Storage có bù trừ khi chắc chắn chưa commit. Sheets có nhật ký phục hồi và từ chối xóa khi nguồn bị sửa. Không tuyên bố giao dịch phân tán hoàn toàn.

## Kết quả và giới hạn kiểm thử

- `npm run build`: thành công, runtime sinh lại và đổi mã cache.
- `npm test`: **171 ca, 168 PASS, 0 FAIL, 3 SKIP**, 5.33 giây trong lần chạy ghi log. Log: `docs/validation/atomic-local-tests.txt`.
- Suite giao dịch áp dụng schema và toàn bộ migration thực tế vào PGlite (PostgreSQL WASM). Có kiểm thử lỗi cố ý sau khi ghi để xác minh rollback, tổng tiền, quyền, bản cũ, không ghi trùng và audit.
- Ba ca SKIP cục bộ cần nhiều kết nối PostgreSQL độc lập: tạo trùng cùng mã; hai lần sửa bản cũ; hai lần gửi tất toán. CI đã cấu hình PostgreSQL 16 và chạy riêng suite này. **Cần xem kết quả CI trên PR, không tính SKIP thành PASS.**
- Apps Script và Storage được kiểm thử bằng adapter giả lập có thể tạo lỗi tại từng bước, không dùng Google Sheets/bucket thật.
- Kiểm thử form chạy mã hàm thật trong VM; các kiểm thử CSS hiện có là kiểm tra hợp đồng mã. **Chưa kiểm thử thao tác/ảnh/responsive trên trình duyệt desktop hoặc mobile thực tế.**
- Chưa xác minh Gateway/JWT, triển khai Deno, trigger/migration đang cài trong Supabase, cấu hình Apps Script, thời gian thao tác ngoài mạng hoặc tải dữ liệu thật.

## Trình tự đưa vào staging — chưa thực hiện

1. Dùng Supabase project, Storage và bản sao Google Sheets riêng; không trỏ môi trường test vào dữ liệu thật. Chạy đủ migration trên staging và xác nhận RPC chỉ service_role được gọi.
2. Triển khai cùng bộ core API, legacy API, order-actions, writeback-feed, ingest và settlement-ingest trên staging, gồm thư mục `_shared`. Kiểm tra `config.toml`: core/legacy cần anon JWT; order-actions tự kiểm phiên; feed/ingest yêu cầu `INGEST_SECRET`. Không bật `SHEET_IMPORT_ENABLED` ở chế độ website là nguồn chính.
3. Dùng tài khoản Admin, Sale A, Sale B, Thợ/OPS test. Kiểm thử tạo → sửa → bó → giao → phí ship → gửi bill → duyệt → dashboard/công nợ/KPI; kiểm tra số liệu trong DB sau mỗi bước. Thử bill sai/trả đơn, tăng tổng Full Paid, mất mạng và hai thiết bị cùng sửa.
4. Thay nội dung script sync hiện hành bằng bản đã sửa, giữ helper v9.1 theo cấu trúc dự án; entrypoint/trigger v9.2 giữ tên để tương thích. Trên bản sao Sheet, thử đổi tháng, lỗi meta/xóa/append, restart job; xác minh 1 ID duy nhất và 25 cột meta đúng.
5. Triển khai frontend staging sau backend/migration, mã cache `20261008-atomic-ops1`; dùng đơn giả để kiểm tra desktop/mobile, ảnh và giữ form khi lỗi. Mô phỏng API mất phản hồi sau commit.
6. Chỉ xem xét production sau CI xanh, staging đạt và có kế hoạch sao lưu/giám sát. Backup trước cutover; kiểm tra đơn APPROVED nhưng chưa settled, duplicate ID/metadata, các writer cũ và dữ liệu Full Paid thiếu bằng chứng. Không tự sửa hàng loạt dữ liệu lịch sử.

## Rollback và phần còn phải xử lý

- Không rollback bằng cách bật lại nhập Sheet hoặc các writer cũ khi website đang ghi; có thể ghi đè tiền, trạng thái và tạo duplicate.
- Nếu cần dừng phiên bản mới: tạm khóa các thao tác ghi, giữ migration/biên nhận, xác minh kết quả các yêu cầu đang chờ rồi phục hồi bản backend đã kiểm tra tương thích. Hạ về backend cũ làm mất bảo vệ giao dịch và xung đột; cần quyết định riêng sau đối chiếu dữ liệu.
- Ảnh có thể còn lại khi phản hồi SQL không xác định hoặc cleanup Storage thất bại. Chưa có job dọn tự động; chỉ dọn sau đối chiếu tham chiếu orders, settlement_requests, receipts và audit. Không xóa theo tuổi đơn thuần.
- Bản nội dung đang chờ xác minh ở frontend chỉ giữ trong form đang mở. Đóng tab/reload mất bản này; cần đối chiếu danh sách đơn và audit trước tạo mới. Phương án tiếp: lưu metadata mã thao tác theo phiên và endpoint phục hồi theo chủ tài khoản, không lưu bill base64 vào localStorage.
- Sheets không có transaction hoặc khóa thao tác của người sửa trực tiếp. Snapshot/ID chỉ giảm rủi ro; cần bảo vệ vùng mirror và chỉ nhập nghiệp vụ trên website sau cutover. Duplicate không có nhật ký cần đối chiếu thủ công, script không tự chọn dòng để xóa.
- Import opt-in vẫn là đường migration lịch sử, chưa được nâng thành giao dịch tất toán mới; không dùng đồng thời với writer website.
- Chưa triển khai nghiệp vụ mới như hủy đơn, xóa đơn, sổ thu từng lần/cọc, đổi ngân sách sau tất toán hoặc công cụ hợp nhất xung đột. Cần chốt quy tắc và làm gói riêng; bản này không tự đổi nghiệp vụ.
- Chưa sửa toàn bộ các vấn đề UI/UX hoặc xác minh toàn hệ thống production. Báo cáo audit đầy đủ trước đó vẫn là danh sách công việc còn phải đối chiếu.

**Ưu tiên tiếp:** P0 xác minh staging/đa phiên và quyền thực tế; P1 phục hồi mã thao tác sau reload, đối soát dữ liệu lịch sử và dọn ảnh an toàn; P2 hoàn thiện các nghiệp vụ chưa có theo quy tắc tiệm hoa, rồi UI/mobile và benchmark thao tác thực tế.
