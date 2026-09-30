# MEEHOASG Operations Platform

`index.html` is the GitHub Pages entry point for [ops.meehoasg.com](https://ops.meehoasg.com). The identical `html` file is retained as an editable copy. Both call the `meehoasg-api` Supabase Edge Function in project `zxnfhshnavbmvdthrmrd`.

> **Production status — 30/09/2026:** website operations are running on the new platform and Web → Supabase is active. The legacy Google Apps Script web app must **not** be considered fully decommissioned yet. Cutover is pending final acceptance testing of create/edit flows and full Web → Sheet field parity.

## Architecture & Bi-Directional Sync

```text
[Nhân viên shop]                     [Hệ thống Cloud]                   [Đối tác / Kế toán]
Thao tác trên Web mới  ──(ngay lập tức)──►  Supabase Database  ──(trigger Apps Script)──►  Google Sheet
```

1. **Web App → Supabase**
   - Nhân viên thao tác trực tiếp trên `ops.meehoasg.com`.
   - Tạo đơn, sửa đơn, chuyển trạng thái, thanh toán và công nợ được lưu vào Supabase thông qua `meehoasg-api`.

2. **Supabase → Google Sheet**
   - Google Apps Script chạy `syncDelta()` theo trigger định kỳ.
   - `syncSupabaseToSheet()` đưa đơn mới hoặc thay đổi từ Supabase về Sheet tháng tương ứng.
   - Đơn test `MEE-133EA255B4234859` đã được kiểm tra thực tế ngày 30/09/2026: xuất hiện tại dòng 539, đúng khách hàng, giờ nhận, mẫu hoa, số tiền 280.000đ và trạng thái thanh toán; lượt sync tự động kế tiếp không tạo dòng trùng.
   - Apps Script production đã được sửa để nhận đúng tên tab dạng `Tháng 09/2026` và quét lại đơn bị bỏ sót.

3. **Google Sheet → Supabase**
   - `syncDelta()` tiếp tục quét phần thay đổi trên Sheet và gửi lên Supabase.
   - Chiều Sheet/web app cũ → website đã được kiểm tra thực tế.

## Acceptance status

**Đã xác nhận:**
- Website lưu đơn vào Supabase.
- Một đơn test mới đã đồng bộ đúng xuống Sheet và không tạo trùng ở lượt chạy kế tiếp.
- Production Apps Script nhận đúng tab `Tháng 09/2026`.

**Chưa nghiệm thu hoàn tất:**
- Tạo nhiều đơn mới liên tiếp trong vận hành thực tế.
- Sửa đơn đã tồn tại và xác nhận toàn bộ trường đều phản chiếu về Sheet: tên khách, ngày/giờ nhận, mẫu hoa, ảnh, note, vận chuyển, tiền hoa, thanh toán, Sale, trạng thái.
- Dữ liệu phụ: phí ship, xác nhận ship, thiệp, banner, charm, thay giấy, VAT và ảnh.
- Điều kiện ngưng hẳn web app cũ.

## Source-of-truth note

Ngày 30/09/2026, mã Apps Script đang chạy production và file `supabase/functions/meehoasg-ingest/apps-script-sync.gs` trong GitHub từng có chênh lệch. Trước mọi lần triển khai tiếp theo phải đối chiếu production với repository và chỉ dùng phiên bản đã nghiệm thu làm mốc.

## Security & Storage

The API validates existing usernames and SHA-256 password hashes, then issues opaque sessions stored as hashes in `app_sessions`. Supabase's public anon credential carries no database privileges. Service-role credentials remain in the Edge Function environment. Application tables use RLS and uploaded order images / settlement bills are private objects returned to authenticated users through time-limited signed URLs.

## Project Structure

- `index.html` / `html`: giao diện web vận hành.
- `CNAME`: custom subdomain `ops.meehoasg.com`.
- `supabase/schema.sql`: cấu trúc database.
- `supabase/functions/meehoasg-api/`: API vận hành chính.
- `supabase/functions/meehoasg-ingest/`: API trung gian cho đồng bộ Google Sheet.
- `supabase/functions/meehoasg-ingest/apps-script-sync.gs`: Apps Script đồng bộ hai chiều.
