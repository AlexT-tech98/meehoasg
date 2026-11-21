# MEEHOA Order Bot — Staging

Bot Telegram nhận tin nhắn và ảnh, tổng hợp đơn nháp, và tạo đơn chính thức trong OPS sau khi người dùng xác nhận.

## Yêu cầu môi trường

```
BOT_TOKEN=<Telegram Bot token>
ALLOWED_USER_IDS=<user_id_1>,<user_id_2>
OPS_API_URL=https://<project>.supabase.co/functions/v1/meehoasg-api-core
OPS_TOKEN=<OPS session token — kết quả đăng nhập OPS, không phải service role key>
GEMINI_API_KEY=<tuỳ chọn — để trích xuất trường từ tin nhắn dài>
GEMINI_MODEL=gemini-1.5-flash-latest
```

## Chạy staging

```bash
node order-bot/run.mjs
```

## Lệnh

| Lệnh | Mô tả |
|------|-------|
| `/new` | Tạo đơn nháp mới |
| `/list` | Liệt kê tất cả đơn nháp |
| `/select <id>` | Chọn đơn nháp (6 ký tự cuối ID) |
| `/show` | Xem đơn đang chọn |
| `/cancel` | Xóa đơn nháp đang chọn |
| `/confirm` | Xác nhận tạo đơn trong OPS |

## Nhập thông tin

Gửi tin nhắn theo dạng `trường: giá trị` (một hoặc nhiều dòng):

```
tên khách: Nguyễn A
mẫu hoa: Hoa hồng đỏ
ngày nhận: 2026-12-01
giờ nhận: 10:00
hình thức: Shop book ship
```

## Ảnh

- **Ảnh mẫu hoa**: gửi ảnh không caption, hoặc caption không chứa "bill"/"hóa đơn" → lưu vào nháp, gắn vào đơn khi `/confirm`
- **Ảnh bill**: gửi ảnh với caption chứa "bill" hoặc "hóa đơn" → **lưu vào nháp RIÊNG** (`draftBillRefs`), **không gắn vào đơn**, **không xác nhận thanh toán**

## Nguyên tắc bất biến

- `payment` luôn là `'Chưa thanh toán'` khi tạo đơn — không bao giờ tự xác nhận
- `fullPaidRequested` **không bao giờ** được đặt bởi bot
- Ảnh bill chỉ tồn tại trong nháp local — khi cần tất toán, operator tải ảnh lên OPS qua luồng tất toán
- Chỉ hoạt động với private chat
- Chỉ cho phép user IDs trong `ALLOWED_USER_IDS`

## Dữ liệu nháp

Nháp lưu tại `order-bot/data/<userId>.json`. File này chứa thông tin riêng tư — không commit, không chia sẻ.
