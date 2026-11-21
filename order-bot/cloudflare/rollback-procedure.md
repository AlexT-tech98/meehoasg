# MEEHOA Order Bot V1 — Quy Trình Rollback Vận Hành Chuẩn (Bảo Toàn Dữ Liệu)

Tài liệu này quy định quy trình hoàn tác an toàn cho MEEHOA Order Bot trên môi trường Staging.

> **NGUYÊN TẮC BẢO MẬT & TOÀN VẸN DỮ LIỆU:**
> Rollback vận hành **TUYỆT ĐỐI KHÔNG DROP TABLES** trong D1.
> Mọi dữ liệu đơn nháp, nhật ký kiểm toán và vết xử lý tin nhắn phải được bảo toàn nguyên vẹn để phục vụ đối soát và phân tích sự cố.

---

## 1. Các bước Rollback Vận Hành (Thực hiện khi cần dừng Bot khẩn cấp)

### Bước 1: Ngắt kết nối Webhook Telegram (Dừng nhận tin nhắn mới ngay lập tức)
Chạy lệnh sau bằng terminal để hủy Webhook và xóa các update đang chờ (drop pending updates):

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/deleteWebhook?drop_pending_updates=true"
```
*Kết quả:* Telegram lập tức ngừng gửi tin nhắn tới Cloudflare Worker. Khách hàng/Operator gửi tin nhắn vào bot sẽ không kích hoạt Worker nữa.

---

### Bước 2: Tắt / Xóa Cloudflare Worker Bot
Gỡ bỏ Worker `meehoa-order-bot-staging` để ngắt toàn bộ endpoint:

```bash
cd order-bot/cloudflare
npx wrangler delete meehoa-order-bot-staging
```
*Kết quả:* Worker ngừng chạy hoàn toàn, giải phóng tài nguyên.

---

### Bước 3: Bảo toàn Dữ liệu D1 (Không can thiệp bảng)
- Các bảng `bot_drafts`, `bot_processed_updates`, và `bot_audit_logs` trong D1 `meehoasg-ops-staging` **được giữ nguyên vẹn**.
- Dữ liệu đơn chính thức trong bảng `orders` của OPS không bị tác động.
- Không phát sinh chi phí lưu trữ (D1 Staging dung lượng nhỏ nằm trọn trong hạn mức miễn phí).

---

## 2. Quy trình Dọn dẹp Dữ liệu Thử nghiệm (Chỉ thực hiện khi có phê duyệt riêng)

Khi chủ sở hữu muốn làm sạch toàn bộ dữ liệu nháp của đợt thử nghiệm nghiệm thu (User ID `5252724920`):

```bash
# Chỉ chạy khi có phê duyệt riêng từ chủ sở hữu:
npx wrangler d1 execute meehoasg-ops-staging --remote --file=order-bot/cloudflare/purge-test-data.sql
```

---

## 3. Quy trình Gỡ bỏ Toàn phần (Full Teardown) — Chỉ dùng khi hủy dự án
Chỉ thực thi script `rollback.sql` khi có văn bản chỉ đạo gỡ bỏ vĩnh viễn cấu trúc bảng khỏi D1:

```bash
# ⚠️ NGUY HIỂM — XÓA HOÀN TOÀN CÁC BẢNG D1:
npx wrangler d1 execute meehoasg-ops-staging --remote --file=order-bot/cloudflare/rollback.sql
```
