# MEEHOA Order Bot V1 — Quy Trình Dừng Khẩn Cấp & Rollback An Toàn (Bảo Toàn Dữ Liệu)

Tài liệu này quy định quy trình hoàn tác và dừng hoạt động an toàn cho MEEHOA Order Bot trên môi trường Staging.

> **NGUYÊN TẮC BẢO MẬT & TOÀN VẸN DỮ LIỆU:**
> 1. Rollback vận hành **TUYỆT ĐỐI KHÔNG DROP TABLES** trong D1.
> 2. Thao tác dừng thông thường **TUYỆT ĐỐI KHÔNG DÙNG `drop_pending_updates=true`** để tránh làm mất tin nhắn của người dùng đang chờ trong hàng đợi Telegram.
> 3. Mọi dữ liệu đơn nháp, nhật ký kiểm toán và vết xử lý tin nhắn được bảo toàn nguyên vẹn phục vụ đối soát và khôi phục.

---

## 1. Các bước Dừng Vận Hành Khẩn Cấp (Standard Stop Operation)

### Bước 1: Ngắt kết nối Webhook Telegram (Bảo toàn hàng đợi tin nhắn)
Chạy lệnh sau để hủy Webhook **mà không xóa tin nhắn chờ**:

```bash
# ⚠️ TUYỆT ĐỐI KHÔNG THÊM drop_pending_updates=true trong thao tác dừng thông thường:
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/deleteWebhook"
```
*Kết quả:* Telegram ngừng chuyển tiếp tin nhắn tới Worker nhưng **vẫn lưu giữ các tin nhắn chưa gửi trong hàng đợi Telegram**. Khách hàng/Operator gửi tin nhắn vào bot sẽ không gây lỗi và tin nhắn không bị thất lạc.

---

### Bước 2: Tắt / Gỡ bỏ Cloudflare Worker Bot
Gỡ bỏ Worker `meehoa-order-bot-staging` để ngắt hoàn toàn endpoint xử lý:

```bash
cd order-bot/cloudflare
npx wrangler delete meehoa-order-bot-staging
```
*Kết quả:* Worker ngừng chạy hoàn toàn, giải phóng tài nguyên CPU/Network.

---

### Bước 3: Bảo toàn Dữ liệu D1 (Không can thiệp bảng)
- Các bảng `bot_drafts`, `bot_processed_updates`, và `bot_audit_logs` trong D1 `meehoasg-ops-staging` **được giữ nguyên vẹn**.
- Dữ liệu đơn chính thức trong bảng `orders` của OPS không bị tác động.
- Không phát sinh chi phí lưu trữ (D1 Staging dung lượng nhỏ nằm trọn trong hạn mức miễn phí).

---

## 2. Quy trình Khôi Phục & Bật Lại Bot Không Gây Trùng Đơn

Khi sự cố đã được khắc phục và hệ thống sẵn sàng hoạt động trở lại:

### Bước 1: Triển khai lại Worker
```bash
cd order-bot/cloudflare
npx wrangler deploy
```

### Bước 2: Kích hoạt lại Telegram Webhook
```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://meehoa-order-bot-staging.meehoasg.workers.dev/webhook","secret_token":"<TELEGRAM_SECRET_TOKEN>","allowed_updates":["message"]}'
```

### Bước 3: Tự động Phục hồi Đơn Gián Đoạn (Stale Confirming Recovery)
Nếu Bot bị dừng đúng lúc đang gọi OPS `/confirm` (đơn ở trạng thái `confirming`):
1. Bot tự động phát hiện đơn `confirming` bị kẹt quá 15 phút và chuyển về trạng thái `confirmed`.
2. **`requestId` được giữ nguyên vẹn**:
   - Khi Operator kiểm tra `/show` và gõ lại `/confirm`, Bot gửi lại đúng `requestId` ban đầu.
   - Nếu trước khi dừng, OPS **đã kịp tạo đơn**, OPS sẽ trả về ngay hóa đơn cũ (idempotent lookup), không tạo đơn thứ hai.
   - Nếu trước khi dừng, OPS **chưa nhận được request**, OPS sẽ tạo đơn mới duy nhất với mã `requestId` này.
3. Nếu đơn đã tạo thành công nhưng bill chưa kịp liên kết do bị gián đoạn, Operator chỉ cần gõ:
   ```text
   /relink
   ```
   Bot sẽ liên kết lại toàn bộ bill vào mã đơn OPS đã tạo mà **tuyệt đối không gọi tạo đơn mới**.

---

## 3. Quy trình Dọn dẹp Dữ liệu Thử nghiệm (Chỉ thực hiện khi có phê duyệt riêng)

Khi chủ sở hữu muốn làm sạch dữ liệu nháp của đợt thử nghiệm nghiệm thu (User ID `5252724920`):

```bash
# Chỉ chạy khi có phê duyệt riêng từ chủ sở hữu:
npx wrangler d1 execute meehoasg-ops-staging --remote --file=order-bot/cloudflare/purge-test-data.sql
```

---

## 4. Xóa Hàng Đợi Telegram (Chỉ dùng khi có quyết định hủy bỏ tin nhắn rác)
Chỉ khi hàng đợi Telegram bị tràn tin nhắn rác/thử nghiệm lỗi và chủ sở hữu duyệt xóa bỏ hàng đợi:

```bash
# ⚠️ CẢNH BÁO: Lệnh này xóa vĩnh viễn các tin nhắn Telegram đang chờ:
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/deleteWebhook?drop_pending_updates=true"
```

---

## 5. Quy trình Gỡ bỏ Toàn phần (Full Teardown) — Chỉ dùng khi hủy dự án
Chỉ thực thi script `rollback.sql` khi có văn bản chỉ đạo gỡ bỏ vĩnh viễn cấu trúc bảng khỏi D1:

```bash
# ⚠️ NGUY HIỂM — XÓA HOÀN TOÀN CÁC BẢNG D1 (DROP TABLES):
npx wrangler d1 execute meehoasg-ops-staging --remote --file=order-bot/cloudflare/rollback.sql
```
