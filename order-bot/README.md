# MEEHOA Order Bot — Staging

Bot Telegram nhận tin nhắn và ảnh, tổng hợp đơn nháp, và tạo đơn chính thức trong OPS sau khi người dùng xác nhận.

> **QUAN TRỌNG:** Bản triển khai này chỉ dành cho môi trường **Staging**. Tuyệt đối **không merge hoặc deploy Production** khi chưa có phê duyệt riêng của chủ sở hữu.

---

## 1. Yêu cầu môi trường

Tạo file môi trường an toàn (hoặc cấu hình secret manager), không commit lên git:

```env
BOT_TOKEN=<Telegram Bot token>
ALLOWED_USER_IDS=<user_id_1>,<user_id_2>
OPS_API_URL=https://<project>.supabase.co/functions/v1/meehoasg-api-core
OPS_TOKEN=<OPS session token — kết quả đăng nhập OPS, không phải service role key>
GEMINI_API_KEY=<tuỳ chọn — để trích xuất trường từ tin nhắn dài>
GEMINI_MODEL=gemini-1.5-flash-latest
```

*Lưu ý bảo mật:*
- `OPS_TOKEN`: Là session token của tài khoản OPS (30 ngày), không bao giờ dùng `SUPABASE_SERVICE_ROLE_KEY`.
- Các token/khóa đều được bot tự động redact nếu có log lỗi phát sinh.

---

## 2. Cách chạy & kiểm thử

### Khởi động Bot (Staging)

```bash
node order-bot/run.mjs
```

### Chạy Unit & Integration Tests

```bash
# Chạy bộ test chuyên biệt của bot (90 bài kiểm thử)
node --test tests/order-bot.test.cjs

# Chạy bộ test 13 kịch bản thực tế đặt hoa (Phase 2)
node --test tests/order-bot-realistic-scenarios.test.cjs

# Chạy toàn bộ test suite dự án (435 bài kiểm thử)
npm test
```

---

## 3. Các lệnh Telegram Bot

| Lệnh | Mô tả |
|------|-------|
| `/new` | Tạo đơn nháp mới và kích hoạt đơn này |
| `/list` | Liệt kê tất cả đơn nháp kèm trạng thái (thiếu trường / đủ dữ liệu / đang tạo / đã tạo) |
| `/select <id>` | Chuyển sang đơn nháp khác bằng 6 ký tự cuối ID |
| `/show` | Xem chi tiết đơn nháp đang chọn |
| `/cancel` | Xóa đơn nháp đang chọn (chỉ xóa được đơn chưa tạo OPS và không trong tiến trình gọi OPS) |
| `/confirm` | Xác nhận đơn và gọi OPS `createOrder` |

---

## 4. Nhập và chuẩn hóa dữ liệu & Phòng vệ Injection

Gửi tin nhắn theo dạng `trường: giá trị` (hỗ trợ tin nhắn nhiều dòng, gạch đầu dòng bullet `-`, `*`, `•`):

```text
- Tên khách: Nguyễn Thị Mai
- Mẫu hoa: Bó hoa hướng dương tone vàng
- Ngày nhận: 15/12/2026 (hoặc 2026-12-15)
- Giờ nhận: 9h30 (hoặc 09:30)
- Hình thức: Shop book ship (hoặc shop, khách tự book, ghé lấy)
- Địa chỉ: 123 Lê Lợi, P. Bến Nghé, Q.1
- SĐT: 0901234567
- Giá: 850k (hoặc 850.000 đ)
- Nội dung thiệp: Chúc mừng sinh nhật
- Ghi chú: Kèm hoa phụ
```

Bộ parser tự động chuẩn hóa:
- **Tiền**: `850k` → `850000`, `1.500.000 đ` → `1500000`, `1,2tr` → `1200000`.
- **Ngày**: `DD/MM/YYYY` hoặc `DD-MM-YYYY` → `YYYY-MM-DD`.
- **Giờ**: `9h` → `09:00`, `9h30` → `09:30`.
- **Hình thức ship**: Chuẩn hóa về đúng 1 trong 3 giá trị OPS: `Shop book ship`, `Khách tự book`, `Ghé lấy`.
- **Phụ kiện**: Nhập `nội dung thiệp` tự động bật cờ thiệp và số lượng; `nội dung banner` tự động bật banner và số lượng.
- **Phát hiện mơ hồ (Uncertainty Detection)**: Giá trị ngày/giờ/tiền/ship chưa rõ ràng (ví dụ "chiều mai", "tầm trưa") được gắn cờ trong `draft.uncertainFields` và cảnh báo; lệnh `/confirm` bị chặn đến khi thông tin được làm rõ.
- **Lịch sử chỉnh sửa (`draft.history`)**: Lưu vết toàn bộ thay đổi qua từng lượt tin nhắn để đối chiếu khi cần.
- **Phòng thủ Prompt Injection**: Ngăn chặn tuyệt đối các chỉ dẫn ghi đè hệ thống (`ignore instructions`, `system override`), không cho phép sửa trường thanh toán (`payment`, `full_paid`) hay quyền hạn qua tin nhắn.

---

## 5. Quy tắc xử lý ảnh & Lưu trữ Bill chưa xác minh (Bất biến)

1. **Ảnh mẫu hoa**:
   - Gửi ảnh không caption hoặc caption không chứa từ khóa bill.
   - Lưu vào `sampleRefs` trong nháp (tối đa 10 ảnh).
   - Khi `/confirm`, bot tải toàn bộ ảnh mẫu về; nếu **bất kỳ ảnh nào tải thất bại**, bot lập tức dừng tạo đơn, rollback về `confirmed` và thông báo cho người dùng gửi lại.
   - Khi thành công, ảnh được đính kèm vào `imageFiles` gửi lên OPS lưu tại bucket `order-images`.
2. **Ảnh bill thanh toán**:
   - Gửi ảnh với caption chứa "bill" hoặc "hóa đơn".
   - Lưu vào `draftBillRefs` trong nháp (tối đa 10 ảnh).
   - Khi `/confirm`, bot tải toàn bộ ảnh bill về; nếu lỗi tải ảnh, bot dừng tạo đơn ngay lập tức.
   - Ảnh bill được chuyển vào `unverifiedBillFiles` lưu trữ an toàn trong bucket `settlement-bills` và liên kết với trường `unverified_bill_urls` của đơn.
   - **Tuyệt đối KHÔNG tự động bật cờ `fullPaidRequested`**; `payment` luôn cố định là `'Chưa thanh toán'`.
   - Ảnh bill hiển thị trong drawer chi tiết đơn tại OPS với nhãn **🧾 BILL CHƯA XÁC MINH** để kế toán/Sale đối soát và thực hiện tất toán qua luồng OPS chuẩn.

---

## 6. Tính bền vững, An toàn & Đồng thời (Durability & Concurrency)

- **Lưu trữ nguyên tử (Atomic Write)**:
  - Dữ liệu lưu tại `order-bot/data/<userId>.json`.
  - Mọi thao tác ghi dùng file tạm `.tmp.<uuid>` sau đó `renameSync` để đảm bảo file không bao giờ bị corrupt khi crash.
  - Phân quyền file nghiêm ngặt: thư mục `data/` phân quyền `0o700`, file JSON phân quyền `0o600`.
- **Chống gọi trùng (Idempotent Retry & Lock)**:
  - Khóa đồng thời theo user (`withConfirmLock`) ngăn chặn 2 yêu cầu `/confirm` chạy song song.
  - Vòng đời trạng thái: `pending` → `confirmed` → `confirming` → `submitted`.
  - `requestId` được sinh cố định ngay lần xác nhận đầu tiên và lưu vào nháp. Khi retry, `requestId` giữ nguyên để hàm `mee_ops_lookup` của OPS trả về hóa đơn idempotent cũ, không bao giờ tạo đơn trùng.
- **Khôi phục sau sự cố (Crash Recovery)**:
  - Khi bot khởi động lại, `cleanupOrphanedTmpFiles()` dọn dẹp các file `.tmp` mồ côi.
  - `findStaleConfirming()` rà soát các đơn bị kẹt ở trạng thái `confirming` do process bị tắt ngang, chuyển về `confirmed` với `requestId` không đổi để operator có thể `/confirm` lại an toàn.
- **Vệ sinh thông báo lỗi (Sanitized Errors)**:
  - Mọi lỗi mạng kết nối tới OPS đều được chuẩn hóa thành thông báo tiếng Việt an toàn; không bao giờ để lộ `e.message` thô, mã lỗi hệ thống hay token nội bộ vào Telegram.
- **Giới hạn kiến trúc**:
  - Kho lưu trữ file JSON hiện tại được thiết kế và bảo đảm cho **1 process staging**.
  - Nếu triển khai môi trường nhiều replica, kho lưu trữ cần được thay thế bằng hàng đợi/DB tập trung (Postgres/Redis/Supabase table) có distributed lock.

---

## 7. Danh mục kiểm thử nghiệm thu (Checklist)

- [x] Ảnh bill được lưu vào `unverified_bill_urls` trong OPS mà không kích hoạt Full Paid hay auto-settlement.
- [x] Không bao giờ bật cờ `fullPaidRequested`, tiền thanh toán luôn `'Chưa thanh toán'`.
- [x] Lỗi tải bất kỳ ảnh mẫu hoặc ảnh bill nào lập tức hủy tạo đơn, giữ nguyên nháp cho retry.
- [x] Giới hạn số lượng ảnh (tối đa 10 ảnh mẫu, 10 ảnh bill).
- [x] Giới hạn kích thước ảnh (tối đa 5MB/ảnh).
- [x] Chặn người dùng lạ ngoài `ALLOWED_USER_IDS`.
- [x] Chặn nhóm/kênh Telegram (chỉ xử lý tin nhắn riêng tư).
- [x] Tự động chuẩn hóa định dạng ngày, giờ, tiền, hình thức ship, thiệp, banner.
- [x] Phát hiện dữ liệu mơ hồ (`uncertainFields`) và chặn `/confirm` khi chưa làm rõ.
- [x] Theo dõi lịch sử thay đổi (`draft.history`) qua từng lượt tin nhắn.
- [x] Phòng thủ prompt injection và chặn can thiệp quyền/thanh toán.
- [x] Khóa đồng thời và giữ nguyên `requestId` khi retry idempotent.
- [x] Cơ chế phục hồi đơn sau crash (`confirming` recovery).
- [x] Xóa bỏ file tạm mồ côi khi khởi động.
- [x] Vệ sinh thông báo lỗi mạng, không lộ token hay `e.message` trong Telegram.
- [x] Redact token trong log.
- [x] Thư mục dữ liệu `order-bot/data/` được thêm vào `.gitignore`.
- [x] 90/90 unit & integration tests chuyên biệt của bot đạt.
- [x] 13/13 test kịch bản thực tế đặt hoa (Phase 2) đạt.
- [x] 435/435 test suite toàn bộ dự án đạt (432 pass, 0 fail, 3 skip).
