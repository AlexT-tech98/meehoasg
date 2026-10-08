# Kiểm tra sâu tạo đơn — 08/10/2026

## Kết luận và ảnh hưởng vận hành

Video cho thấy lựa chọn “Đã thanh toán toàn bộ đơn” và thao tác tạo đơn không có phản hồi dễ thấy. Video không đủ để kết luận đơn đã được ghi hay chưa, hoặc thiếu ảnh nào ở phần trên form.

Những điểm xác nhận từ mã nguồn main 19a131e:

- Form ở lớp 1000 trong khi thông báo/lớp chờ chỉ ở 100/90: lỗi thiếu ảnh mẫu, thiếu bill, thiếu phí ship và lỗi máy chủ bị che. Nhân viên có thể nghĩ nút không hoạt động và bỏ sót đơn.
- Trường bắt buộc có thể chặn sự kiện gửi trước khi hàm lưu chạy. Bản thay thế chủ động kiểm tra và hiển thị lỗi trong form, cuộn đến trường cần sửa.
- Module v366 bọc hàm lưu và sau 7 giây chỉ kiểm tra `found` để tự đóng form/báo tạo thành công. Core API ghi đơn qua API legacy rồi mới lưu phụ kiện/phí ship/bill/Full Paid. Sự tồn tại của đơn chưa chứng minh hoàn tất các bước này. Cơ chế xác nhận sớm đã được loại bỏ, không thêm lớp bọc mới.
- Lỗi hiển thị sau phản hồi thành công trước đây mở lại nút tạo đơn. Bản thay thế khóa việc gửi tiếp sau khi đã nhận thành công, và yêu cầu kiểm tra danh sách đơn.
- Mất mạng hoặc `SERVER_ERROR` có thể xảy ra sau khi đơn đã được ghi. Bản thay thế thông báo chưa xác nhận, giữ mã yêu cầu để thử lại trong cùng form; không tự gửi lại.

## Rủi ro máy chủ cần nghiệm thu riêng

Đây là các rủi ro suy ra từ mã, chưa phải lỗi đã chứng minh xảy ra trên dữ liệu thật:

1. Ghi đơn, audit, phụ kiện, phí ship và Full Paid chưa nằm trong một giao dịch. Một bước sau có thể lỗi khi đơn đã tồn tại. Bản này không thay cơ chế ghi máy chủ; xử lý giao diện bảo thủ và bỏ xác nhận sớm.
2. Bộ chống trùng nghiệp vụ chỉ so khách/điện thoại, Sale, ngày/giờ, tiền hoa, vận chuyển và thanh toán. Chưa so nội dung hoa/phụ kiện. Hai đơn khác sản phẩm nhưng cùng các giá trị này có thể bị coi là một. Không thay quy tắc này khi chưa có nghiệm thu nghiệp vụ.
3. Khóa duy nhất `orders.request_id` bảo vệ cùng mã yêu cầu. Đóng form/tải lại rồi tạo mới có thể tạo mã mới. Bản này bảo vệ retry trong cùng form; đã bỏ thông báo phục hồi tự động chưa chứng minh hoàn tất thanh toán.
4. Phiên bản/migration Full Paid đang triển khai và lỗi máy chủ thực tế chưa thể xác nhận bằng repository.

## Phạm vi thay thế

- `html` sở hữu duy nhất xác thực/lưu đơn/trạng thái gửi/thông báo lỗi.
- Không bọc lại `MEEOPS7.saveOrder`, không tự xác nhận dựa trên việc tìm thấy đơn sau 7 giây.
- Chỉnh lớp thông báo/chờ ngay tại khai báo gốc; nâng mã phát hành để lấy shell mới.
- Bản này được tạo từ main, không chồng lên PR #21.

## Kiểm tra

- Quy trình build tương đương CI: harden money, flatten bootstrap, build runtime.
- 127/127 kiểm thử Node đạt, gồm 11 kiểm thử bổ sung: thiếu trường, thiếu bill/mẫu/phí ship, đọc ảnh lỗi, bấm liên tiếp, mất phản hồi/thử lại cùng mã, máy chủ ghi một phần, hiển thị lỗi sau lưu, hết phiên, khoảng trắng, lớp phản hồi.
- Các kiểm thử luồng lưu chạy hàm thực bằng VM với dữ liệu/API mô phỏng; không ghi dữ liệu production.
- Không thực hiện được QA trình duyệt/iPhone: chưa có browser local, tải browser bị chặn/trả nội dung không hợp lệ. Truy cập ops.meehoasg.com từ môi trường này trả trang “Site Unavailable”; không kết luận website của tiệm đang sập.

## Điều kiện trước khi coi là pass production

Trên iPhone/Safari và bản web đã triển khai: thử đơn thường, đơn đủ tiền có bill/mẫu/phí ship, thiếu trường, mất mạng/bấm lại; kiểm tra đúng một Order ID, đủ ảnh/phụ kiện/phí ship, trạng thái Full Paid/công nợ, xuất hiện ở danh sách/sản xuất và đồng bộ Sheet. Cần phiên kiểm tra được cấp quyền hoặc môi trường thử riêng để xác nhận các điểm này.
