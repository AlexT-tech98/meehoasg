# Điều tra nút lưu sửa đơn Pu — 16/10/2026

## Kết quả và giới hạn

Đơn được báo: `MEE-F89178045210428E`. Clip cho thấy nhập nội dung thiệp được, nút lưu không có phản hồi nhìn thấy và nhấn giữ chọn được chữ trên nút.

Đọc production xác nhận tài khoản pu hoạt động, SALE, đúng người phụ trách. Audit của đơn ghi createOrder bởi pu lúc 19:28:37 và updateOrder bởi admin lúc 21:53:37 (UTC+7), thay “Bs sau” bằng lời chúc trong clip. Không có audit sửa thành công bởi Pu trên đơn này. Không thể suy ra không có request thất bại chỉ từ audit.

HTML public hiện tại khớp SHA256 với repo main `7d20017`. Luồng sửa Full Paid tương tự với dữ liệu giả lưu được trên Chromium và WebKit. **Chưa tái hiện được tác nhân gốc trên thiết bị Pu**. WebKit Linux không thay thế nghiệm thu Safari/PWA trên iPhone thật. Chưa có thông tin phiên bản iOS hoặc shell cache của thiết bị trong clip.

## Lỗi đã chứng minh bằng thực thi

Trước bản sửa, validateOrderForm, new FormData, chuẩn hóa thanh toán và tạo request ID nằm ngoài try/catch. Gây lỗi giả lập tại FormData trên WebKit cho kết quả:

- không có updateOrder được gửi;
- không có feedback trong form;
- button vẫn là “Lưu thay đổi”, vẫn có thể thử bấm;
- unhandled rejection chỉ đi tới fatalError ở nền sau modal.

Đây là nhánh lỗi có thật, có thể tạo triệu chứng tương tự clip. **Lỗi giả lập không chứng minh Pu gặp chính lỗi FormData.** Các vai trò đều dùng cùng nhánh nên không chỉ Pu có nguy cơ bị lỗi im lặng này.

## Bản sửa

- Bao cả preflight trong catch/finally. Giữ draft, mở lại nút khi chưa lưu, bảo toàn request ID/payload khi kết quả chưa xác nhận.
- Nút khai báo rõ type=submit và form=orderForm. Chỉ nút lưu bị tắt chọn chữ/callout iOS; nội dung các trường vẫn chọn/copy được.
- Watchdog sau click kiểm tra hàm lưu có được gọi không. Nếu không, hiện lỗi SUBMIT_NOT_DISPATCHED; không tự gửi lại.
- Lỗi có mã chẩn đoán và stage (submit/validate/serialize/payment/files/request/render), lưu 10 bản gần nhất trong sessionStorage.
- API core thêm logOrderSaveFailure cho user có phiên hợp lệ, ghi log console có actor/role từ server. Chỉ nhận trường metadata cho phép, không nhận nội dung đơn, ảnh, token, raw message hoặc stack. Log không sửa đơn, không đổi schema hay quyền sửa đơn.
- Tăng shell release để tải HTML/CSS mới khi mở lại ứng dụng.

## Kiểm tra

- Node: 210 pass, 0 fail, 3 skip theo điều kiện của repo (213 tổng).
- Browser: API và ảnh bên ngoài bị chặn/mô phỏng; không dùng token hoặc dữ liệu khách thật.
- Chromium và WebKit, viewport mobile 390×844; SALE/ADMIN/THO_OPS; lưu thường, lỗi serialize, thiếu trường bắt buộc, submit không dispatch, mất phản hồi. Nhánh serialize và mất submit còn kiểm tra thử lại thành công và giữ nguyên nội dung thiệp.
- Script tái hiện: `scripts/order-save-browser.py` (cần Python Playwright và browser tương ứng). `MEEHOA_TEST_ENGINES=webkit` chọn một engine; `MEEHOA_CHROMIUM` chọn Chromium hệ thống. Kết quả và screenshot nằm trong `artifacts/order-save`.

## Triển khai và chốt nguyên nhân

Bản này chưa triển khai production. Cần deploy API core có route logOrderSaveFailure, sau đó static shell/CSS. Không có migration. Giữ nguyên thiết lập xác thực hiện hành.

Sau triển khai, mở lại ứng dụng trên iPhone của Pu, giữ nội dung đang sửa trước khi tải lại, tái hiện một lần. Tra log `meehoa_order_save_failure` theo mã hiện trong form hoặc username pu. Stage và errorName/sourceLocation sẽ phân biệt lỗi preflight, mất submit và API từ chối. Nếu logger không tới được server, lấy metadata từ sessionStorage `mee-order-save-diagnostics`. Không thể hồi phục log frontend của các lần thất bại trước khi có instrumentation này.
