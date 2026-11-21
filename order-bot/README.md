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
# Chạy bộ test chuyên biệt của bot (75 bài kiểm thử)
node --test tests/order-bot.test.cjs

# Chạy toàn bộ test suite dự án
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

## 4. Nhập và chuẩn hóa dữ liệu

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
- Ghi chú: Kèm thiệp chúc mừng
```

Bộ parser tự động chuẩn hóa:
- **Tiền**: `850k` → `850000`, `1.500.000 đ` → `1500000`, `1,2tr` → `1200000`.
- **Ngày**: `DD/MM/YYYY` hoặc `DD-MM-YYYY` → `YYYY-MM-DD`.
- **Giờ**: `9h` → `09:00`, `9h30` → `09:30`.
- **Hình thức ship**: Chuẩn hóa về đúng 1 trong 3 giá trị OPS: `Shop book ship`, `Khách tự book`, `Ghé lấy`.

---

## 5. Quy tắc xử lý ảnh & Thanh toán (Bất biến)

1. **Ảnh mẫu hoa**:
   - Gửi ảnh không caption hoặc caption không chứa từ khóa bill.
   - Lưu vào `sampleRefs` trong nháp (tối đa 10 ảnh).
   - Khi `/confirm`, ảnh được bot tải về và đính kèm vào `imageFiles` gửi lên OPS.
2. **Ảnh bill thanh toán**:
   - Gửi ảnh với caption chứa "bill" hoặc "hóa đơn".
   - Lưu vào `draftBillRefs` riêng biệt trong nháp (tối đa 10 ảnh).
   - **Tuyệt đối KHÔNG gửi ảnh bill vào createOrder**; không bao giờ tự động bật `fullPaidRequested`.
   - `payment` khi tạo đơn luôn luôn cố định là `'Chưa thanh toán'`.
   - Khi cần tất toán, nhân viên/operator xem ảnh bill trong nháp và thực hiện qua luồng `submitSettlement` chuẩn của OPS.

---

## 6. Tính bền vững & Đồng thời (Durability & Concurrency)

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
- **Giới hạn kiến trúc**:
  - Kho lưu trữ file JSON hiện tại được thiết kế và bảo đảm cho **1 process staging**.
  - Nếu triển khai môi trường nhiều replica, kho lưu trữ cần được thay thế bằng hàng đợi/DB tập trung (Postgres/Redis/Supabase table) có distributed lock.

---

## 7. Danh mục kiểm thử nghiệm thu (Checklist)

- [x] Đường đi ảnh bill tách biệt, không gửi vào `createOrder`.
- [x] Không bao giờ bật cờ `fullPaidRequested`, tiền thanh toán luôn `'Chưa thanh toán'`.
- [x] Giới hạn số lượng ảnh (tối đa 10 ảnh mẫu, 10 ảnh bill).
- [x] Giới hạn kích thước ảnh (tối đa 5MB/ảnh).
- [x] Chặn người dùng lạ ngoài `ALLOWED_USER_IDS`.
- [x] Chặn nhóm/kênh Telegram (chỉ xử lý tin nhắn riêng tư).
- [x] Tự động chuẩn hóa định dạng ngày, giờ, tiền, hình thức ship.
- [x] Khóa đồng thời và giữ nguyên `requestId` khi retry idempotent.
- [x] Cơ chế phục hồi đơn sau crash (`confirming` recovery).
- [x] Xóa bỏ file tạm mồ côi khi khởi động.
- [x] Redact token trong log.
- [x] Thư mục dữ liệu `order-bot/data/` được thêm vào `.gitignore`.
- [x] 75/75 unit & integration tests đạt.
- [x] Toàn bộ test suite dự án đạt.
