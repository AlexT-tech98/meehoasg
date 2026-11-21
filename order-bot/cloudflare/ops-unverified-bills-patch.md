# BẢN ĐÁNH GIÁ & ĐỀ XUẤT CẬP NHẬT HIỂN THỊ BILL CHƯA XÁC MINH TRÊN MEEHOA OPS STAGING

> **LƯU Ý:** Bản cập nhật này đã được chuẩn bị sẵn sàng nhưng **CHƯA ĐƯỢC DEPLOY** lên Worker OPS Staging `meehoasg-ops-staging` tuân thủ nghiêm ngặt chỉ đạo của chủ sở hữu (cần phê duyệt riêng).

---

## I. HIỆN TRẠNG SO SÁNH (GAP ANALYSIS)

| Thành phần | Trạng thái hiện hành trên OPS Staging (14/10/2026) | Trạng thái cần đạt để hiển thị Bill chưa xác minh |
|---|---|---|
| **D1 Database `orders`** | Đã lưu trường `unverified_bill_urls` (dạng `["supabase://settlement-bills/..."]`) qua hàm `linkUnverifiedBillsToD1Order` của Bot. | Dữ liệu đã có sẵn trong D1, 100% nguyên vẹn. |
| **Backend Worker (`api-core`)** | Phiên bản đang chạy chỉ giải mã `image_urls` và `full_paid_bill_urls` qua `displayUrls`. Chưa ký URL cho `unverified_bill_urls`. | Cần ký HMAC-SHA256 cho `unverified_bill_urls` thành `/media/settlement-bills/...?exp=...&sig=...` trong `fastOrder()` và `detailOrder()`. |
| **Frontend UI (Drawer chi tiết đơn)** | Chỉ hiển thị block `✓ FULL PAID · TỰ XÁC NHẬN` khi `fullPaid === true`. Đơn có bill chưa xác minh (`payment === 'Chưa thanh toán'`) chưa có block UI hiển thị link bill. | Bổ sung block UI cảnh báo màu vàng cam: **🧾 BILL CHƯA XÁC MINH** kèm link xem ảnh mở trong tab mới. |

---

## II. CHI TIẾT CÁC THAY ĐỔI CẦN THỰC HIỆN KHI ĐƯỢC DUYỆT

### 1. Backend (`cloudflare-migration/runtime/core.js`) — ĐÃ CÓ SẴN TRONG SOURCE CODE
Trong hàm `decorate()`, `detailOrder()` và `fastOrder()`:
```javascript
// Giải mã và ký URL ảnh bill chưa xác minh từ R2:
const unverified = row.unverified_bill_urls || [];
const [images, bills, unverifiedBills] = await Promise.all([
  displayUrls(row.image_urls || []),
  displayUrls(row.full_paid_bill_urls || []),
  unverified.length ? displayUrls(unverified) : Promise.resolve([])
]);

const shown = decorate({
  ...row,
  image_urls: images,
  unverified_bill_urls: unverifiedBills
}, user, sm[id], dir);

shown.fullPaidBillUrls = bills;
shown.unverifiedBillUrls = unverifiedBills;
```

---

### 2. Frontend (`cloudflare-migration/public/html` hoặc bundle UI OPS)
Thêm đoạn mã hiển thị vào Drawer chi tiết đơn hàng (ngay dưới block Full Paid):

```javascript
// Block hiển thị Bill chưa xác minh từ Telegram Bot:
(o.unverifiedBillUrls && o.unverifiedBillUrls.length ?
  '<div class="mee-unverified-bills" style="margin-top:12px;padding:12px 14px;border:1px dashed #f59e0b;background:#fffbeb;border-radius:8px">' +
    '<div style="display:flex;align-items:center;gap:8px">' +
      '<span style="font-size:18px">🧾</span>' +
      '<div>' +
        '<b style="color:#b45309;font-size:13px">BILL ĐÍNH KÈM CHƯA XÁC MINH (' + o.unverifiedBillUrls.length + ' bill)</b><br>' +
        '<small style="color:#92400e">Ảnh chuyển khoản từ Telegram Bot. Công nợ vẫn được bảo lưu, vui lòng đối soát và tất toán theo quy trình OPS.</small>' +
      '</div>' +
    '</div>' +
    '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
      o.unverifiedBillUrls.map(function(url, idx) {
        return '<a href="' + attr(url) + '" target="_blank" rel="noopener noreferrer" class="btn small" style="border:1px solid #d97706;background:#ffffff;color:#b45309;padding:6px 12px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-flex;align-items:center;gap:4px">' +
          '🔍 Xem Bill ' + (idx + 1) +
        '</a>';
      }).join('') +
    '</div>' +
  '</div>' : '')
```

---

## III. TÁC ĐỘNG VẬN HÀNH KHI CHƯA DEPLOY CẬP NHẬT NÀY

- **Dữ liệu**: Không bị ảnh hưởng. Mọi bill gửi qua Bot đều được lưu an toàn tại R2 `meehoasg-media-staging` (`settlement-bills/`) và liên kết vĩnh viễn trong bảng `orders` của D1.
- **Bot**: Vẫn hoạt động hoàn hảo, kiểm tra bill, tạo đơn, OCC chống xung đột và báo cáo chính xác.
- **Kế toán / Quản trị viên**: Trong thời gian chờ deploy bản cập nhật OPS Staging, người vận hành vẫn thấy ghi chú `[🧾 Đính kèm X bill chưa xác minh]` trong trường Note của đơn hàng.
- **Triển khai khi duyệt**: Khi chủ sở hữu phê duyệt riêng, chỉ cần chạy script build & deploy Worker OPS Staging (`npx wrangler deploy` trong `cloudflare-migration/`), toàn bộ các đơn hàng đã tạo trước đó sẽ lập tức hiển thị nút xem bill.
