# MEEHOA ORDER BOT V1 — HƯỚNG DẪN KÍCH HOẠT VÀ NGHIỆM THU CLOUDFLARE STAGING

Tài liệu này hướng dẫn chi tiết quy trình triển khai, kiểm thử thực tế và nghiệm thu Telegram Order Bot trên Cloudflare Staging với User ID được ủy quyền: `5252724920` và bot `@meehoa_order_staging_bot`.

> **NGUYÊN TẮC AN TOÀN:**
> - **KHÔNG MERGE PR #65 VÀO `main`**.
> - **KHÔNG DEPLOY PRODUCTION**.
> - **KHÔNG SỬ DỤNG DỮ LIỆU KHÁCH HÀNG THẬT**.
> - **GIỮ NGUYÊN BẤT BIẾN TÀI CHÍNH**: `payment = 'Chưa thanh toán'`, `full_paid = false`.
> - **GIAI ĐOẠN C CHỈ THỰC HIỆN KHI CHỦ SỞ HỮU DUYỆT**.

---

## PHẦN I: TỔNG QUAN TÀI NGUYÊN CLOUDFLARE STAGING

| Tài nguyên | Định danh / ID | Mục đích |
|---|---|---|
| **Cloudflare Account ID** | `1e6471cd334eaedfa609d98fa1442466` | Tài khoản Cloudflare MEEHOA |
| **D1 Database** | `meehoasg-ops-staging` (`16bf0134-64c6-43ea-8098-b40c95251667`) | Lưu đơn nháp (`bot_drafts`), dedup updates (`bot_processed_updates`), audit log (`bot_audit_logs`), và đơn chính thức (`orders`) |
| **R2 Bucket** | `meehoasg-media-staging` | Lưu ảnh mẫu hoa (`order-images/`) và ảnh bill (`settlement-bills/`) |
| **KV Namespace** | `MEDIA` (`c483e22ad8c546c5bdf4f6711098fd04`) | Cache media signing keys / thumbnails |
| **Worker Bot Staging** | `meehoa-order-bot-staging` | Xử lý Telegram Webhook, phân tích cú pháp, điều phối R2/D1/OPS |
| **Worker OPS Staging** | `meehoasg-ops-staging` (`https://meehoasg-ops-staging.meehoasg.workers.dev/api-core`) | Core nghiệp vụ OPS tiếp nhận tạo đơn |
| **Telegram Bot** | `@meehoa_order_staging_bot` | Giao diện nhắn tin Telegram Staging |
| **Allowed User ID** | `5252724920` | Tài khoản Telegram duy nhất được cấp quyền vận hành |

---

## PHẦN II: KIỂM TRA & SAO LƯU D1 TRƯỚC THAY ĐỔI (GIAI ĐOẠN B)

### Bước 1: Kiểm tra cấu trúc hiện tại của D1 Staging
```bash
npx wrangler d1 execute meehoasg-ops-staging --remote --command="SELECT name FROM sqlite_master WHERE type='table';"
```

### Bước 2: Sao lưu cấu trúc và dữ liệu D1 Staging (Khuyến nghị an toàn)
```bash
# Xuất bản sao lưu SQL của D1 Staging trước khi chạy migration
npx wrangler d1 export meehoasg-ops-staging --remote --output=d1-staging-backup-$(date +%Y%m%d).sql
```

---

## PHẦN III: CHUẨN BỊ MIGRATION VÀ CẤU HÌNH (GIAI ĐOẠN B)

### 1. File Migration D1 (`order-bot/cloudflare/schema.sql`)
File migration tạo 3 bảng cách ly hoàn toàn, không đụng chạm đến bảng `orders` hay các bảng hiện có của OPS:
- `bot_drafts`: Lưu trạng thái đơn nháp, khóa phân tán (`lock_acquired_at`) và lịch sử sửa đổi.
- `bot_processed_updates`: Deduplication update Telegram (`update_id`).
- `bot_audit_logs`: Nhật ký kiểm toán mọi thao tác của bot và liên kết đơn OPS.

### 2. Cấu hình Worker (`order-bot/cloudflare/wrangler.toml`)
Đã cấu hình chính xác:
- `main = "worker.mjs"`
- `compatibility_flags = ["nodejs_compat"]`
- `[vars]`: `OPS_API_URL`, `ALLOWED_USER_IDS = "5252724920"`, `GEMINI_MODEL = "gemini-2.5-flash"`
- `[[d1_databases]]`: binding `DB` -> `meehoasg-ops-staging` (`16bf0134-64c6-43ea-8098-b40c95251667`)
- `[[r2_buckets]]`: binding `MEDIA_R2` -> `meehoasg-media-staging`
- `[[kv_namespaces]]`: binding `MEDIA` -> `c483e22ad8c546c5bdf4f6711098fd04`

### 3. Chuẩn bị Secrets (Cần nạp khi được phê duyệt)
```bash
cd order-bot/cloudflare

# 1. Telegram Bot Token của @meehoa_order_staging_bot
npx wrangler secret put TELEGRAM_BOT_TOKEN

# 2. Secret token dùng để Telegram ký Webhook header (tự sinh chuỗi ngẫu nhiên an toàn, VD: 32 ký tự alphanumeric)
npx wrangler secret put TELEGRAM_SECRET_TOKEN

# 3. Session token của tài khoản OPS Staging (hoặc service role token an toàn)
npx wrangler secret put OPS_TOKEN

# 4. Gemini API Key (tùy chọn — dùng để trích xuất tiếng Việt tự nhiên)
npx wrangler secret put GEMINI_API_KEY
```

---

## PHẦN IV: QUY TRÌNH KÍCH HOẠT THỰC TẾ (GIAI ĐOẠN C — CHỈ KHI ĐƯỢC DUYỆT)

### Bước 1: Áp dụng Migration vào D1 Staging
```bash
npx wrangler d1 execute meehoasg-ops-staging --remote --file=order-bot/cloudflare/schema.sql
```
*Kiểm tra bảng đã tạo thành công:*
```bash
npx wrangler d1 execute meehoasg-ops-staging --remote --command="SELECT count(*) FROM bot_drafts;"
```

### Bước 2: Triển khai Worker Telegram Bot lên Staging
```bash
cd order-bot/cloudflare
npx wrangler deploy
```
*Kết quả:* Worker sẵn sàng tại `https://meehoa-order-bot-staging.meehoasg.workers.dev`.

### Bước 3: Đăng ký Telegram Webhook
```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://meehoa-order-bot-staging.meehoasg.workers.dev/webhook",
    "secret_token": "<TELEGRAM_SECRET_TOKEN>",
    "allowed_updates": ["message"]
  }'
```
*Kiểm tra trạng thái Webhook:*
```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```
Đảm bảo: `url` trỏ đúng Worker, `has_custom_certificate: false`, `pending_update_count: 0`.

---

## PHẦN V: KỊCH BẢN KIỂM THỬ THỰC TẾ TRÊN STAGING (User ID `5252724920`)

Chủ sở hữu mở cuộc trò chuyện với `@meehoa_order_staging_bot` trên Telegram và thực hiện tuần tự 5 kịch bản:

### 🌸 Kịch bản 1: Đơn chuẩn không bill
1. Gửi: `/new`
   - *Kỳ vọng:* Bot phản hồi đã tạo đơn mới và hướng dẫn nhập thông tin.
2. Gửi tin nhắn:
   ```text
   Tên khách: Chị Hoàng Yến (Staging Test 1)
   Hoa: Bó hoa hướng dương 5 bông tone vàng
   Ngày nhận: 2026-12-05
   Giờ nhận: 09:30
   Hình thức: Shop book ship
   Địa chỉ: 45 Lê Duẩn, P. Bến Nghé, Quận 1
   SĐT: 0909123456
   Giá: 650k
   Nội dung thiệp: Chúc mừng khai trương
   Ghi chú: Đơn thử nghiệm an toàn Staging
   ```
   - *Kỳ vọng:* Bot ghi nhận đủ các trường, phụ kiện thiệp = 1, báo "Đã đủ dữ liệu — dùng /confirm để tạo đơn."
3. Gửi: `/confirm`
   - *Kỳ vọng:*
     - Bot thông báo: `✅ TẠO ĐƠN THÀNH CÔNG TRÊN MEEHOA OPS STAGING!`, hiển thị mã đơn `MEE-...`.
     - Thanh toán: "Chưa thanh toán (công nợ bảo lưu)".
4. Kiểm tra trên giao diện MEEHOA OPS Staging:
   - Đơn xuất hiện với đầy đủ thông tin: khách, hoa, ngày, giờ, tiền 650k, thiệp 1.
   - Trạng thái công nợ: Chưa thanh toán.

---

### 🌸 Kịch bản 2: Đơn có ảnh mẫu và bill đính kèm
1. Gửi: `/new`
2. Chuyển tiếp 1-2 ảnh mẫu hoa (không kèm caption hoặc caption "ảnh mẫu").
   - *Kỳ vọng:* Bot báo "Đã thêm 1 ảnh mẫu hoa vào đơn nháp (Tổng: 1/10)". Ảnh được lưu vào R2 `meehoasg-media-staging`.
3. Gửi 1 ảnh chuyển khoản ngân hàng kèm caption: `bill 850k chuyển khoản`
   - *Kỳ vọng:* Bot phân loại ảnh vào bill: "Đã thêm 1 ảnh bill vào đơn nháp (chưa xác minh — sẽ đối soát tại OPS)".
4. Gửi tin nhắn thông tin:
   ```text
   Tên: Anh Trần Quốc (Staging Test 2)
   Hoa: Kệ hoa lan hồ điệp trắng 3 cành
   Ngày: 2026-12-06
   Giờ: 14:00
   Ship: Ghé lấy
   Giá: 850k
   ```
5. Gửi: `/show`
   - *Kỳ vọng:* Hiển thị bản tóm tắt đầy đủ: Ảnh mẫu: 1 ảnh; Bill đính kèm: 1 ảnh (CẢNH BÁO: Bill chưa xác minh).
6. Gửi: `/confirm`
   - *Kỳ vọng:*
     - Bot tạo đơn thành công, liên kết 1 bill vào đơn qua OCC `json_set`.
     - Thông báo hiển thị: `🧾 Bill đính kèm: 1 bill đã liên kết thành công (chưa xác minh — đối soát tại OPS)`.
7. Kiểm tra trên giao diện MEEHOA OPS Staging:
   - Mở Drawer chi tiết đơn:
     - Tab ảnh mẫu hiển thị ảnh hoa.
     - Mục **🧾 BILL CHƯA XÁC MINH** hiển thị ảnh bill (được ký URL qua `displayUrls` và đọc từ R2 qua `serveMedia`).
     - Trạng thái thanh toán: **Tuyệt đối vẫn là Chưa thanh toán** (không tự động duyệt thanh toán).

---

### 🌸 Kịch bản 3: Đơn thiếu thông tin bắt buộc
1. Gửi: `/new`
2. Gửi tin nhắn thiếu hoa và ngày:
   ```text
   Tên khách: Chị Lan
   Giá: 500k
   ```
3. Gửi: `/confirm`
   - *Kỳ vọng:* Bot từ chối tạo đơn và liệt kê chính xác các trường còn thiếu:
     `⚠️ Không thể tạo đơn. Còn thiếu các thông tin bắt buộc sau:`
     `- Mẫu hoa`
     `- Ngày nhận`
     `- Giờ nhận`
     `- Hình thức giao nhận`
   - Đơn không được gửi sang OPS.

---

### 🌸 Kịch bản 4: Đơn sửa thông tin nhiều lần và kiểm tra tin gửi cùng giây
1. Gửi: `/new`
2. Gửi tin nhắn ban đầu:
   ```text
   Tên: Khách Thử Nghiệm 4
   Hoa: Bó hoa cẩm chướng hồng
   Ngày: 2026-12-10
   Giờ: 10:00
   Ship: Khách tự book
   Giá: 400k
   ```
3. Gửi tin nhắn sửa đổi:
   ```text
   Hoa: Bó hoa hồng đỏ ecuador
   Giá: 750k
   Giờ: 10:30
   ```
   - *Kỳ vọng:* Bot cập nhật hoa thành "Bó hoa hồng đỏ ecuador", tiền = 750.000 đ, giờ = 10:30, các trường tên, ngày, ship được giữ nguyên vẹn.
4. Gửi: `/show`
   - *Kỳ vọng:* Hiển thị thông tin mới nhất và ghi nhận lịch sử thay đổi trong `draft.history`.
5. Gửi: `/confirm` -> Tạo đơn thành công với giá trị đã sửa.

---

### 🌸 Kịch bản 5: Thử nghiệm gửi lại `/confirm` (Kiểm tra chống tạo trùng)
1. Trên đơn vừa tạo thành công ở Kịch bản 4 (đang ở trạng thái `submitted`):
2. Gửi lại lệnh: `/confirm`
   - *Kỳ vọng:* Bot cảnh báo: `⚠️ Đơn này đã được tạo thành công trên OPS (Mã: MEE-...). Gõ /new để tạo đơn mới.`
   - Tuyệt đối **không gọi OPS tạo đơn thứ hai**.

---

### 🌸 Kịch bản 6: Thử nghiệm khôi phục bill với `/relink`
1. Nếu có tình huống bill liên kết bị gián đoạn hoặc cần thử nghiệm tính năng relink độc lập:
2. Gửi lệnh:
   ```text
   /relink <MÃ_ĐƠN>
   ```
   - *Kỳ vọng:* Bot đọc lại danh sách bill trong bản nháp, kiểm tra ảnh R2, và liên kết an toàn vào đơn OPS đã tạo mà **tuyệt đối không gọi tạo đơn mới**.

---

## PHẦN VI: QUY TRÌNH ROLLBACK TỨC THỜI (BẢO TOÀN DỮ LIỆU)

Nếu phát hiện bất kỳ dấu hiệu bất thường nào trong quá trình thử nghiệm:

### Bước 1: Ngắt Webhook tức thời (Dừng nhận tin nhắn mới)
```bash
# ⚠️ TUYỆT ĐỐI KHÔNG dùng drop_pending_updates=true trong rollback thông thường
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/deleteWebhook"
```
*Hiệu lực:* Ngay lập tức. Telegram ngừng chuyển tin nhắn tới Worker, giữ nguyên hàng đợi an toàn.

### Bước 2: Gỡ bỏ Worker Bot Staging (Nếu cần dừng hẳn xử lý)
```bash
cd order-bot/cloudflare
npx wrangler delete meehoa-order-bot-staging
```

### Bước 3: Bảo toàn dữ liệu
- Bảng `bot_drafts`, `bot_processed_updates`, và `bot_audit_logs` **được giữ nguyên** trong D1 Staging để phục vụ điều tra lỗi.
- Không xóa hay thay đổi bảng `orders` của OPS.
- Chỉ khi có yêu cầu xóa sạch dữ liệu thử nghiệm của User ID `5252724920`, mới chạy file dọn dẹp:
  ```bash
  npx wrangler d1 execute meehoasg-ops-staging --remote --file=order-bot/cloudflare/purge-test-data.sql
  ```
