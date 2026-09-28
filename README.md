# MEEHOASG Operations Platform

`index.html` is the GitHub Pages entry point for [ops.meehoasg.com](https://ops.meehoasg.com). The identical `html` file is retained as an editable copy. Both call the `meehoasg-api` Supabase Edge Function in project `zxnfhshnavbmvdthrmrd`. The old Google Apps Script web app is decommissioned for daily operations and superseded by this platform.

## Architecture & Bi-Directional Sync

The system runs on a high-speed, resilient bi-directional sync loop:

```
[Nhân viên shop]                     [Hệ thống Cloud]                   [Đối tác / Kế toán]
Thao tác trên Web mới  ──(ngay lập tức)──►  Supabase Database  ──(tự động sync)──►  Google Sheet
(Mượt mà, nhanh ~100ms)               (Lưu trữ an toàn)                 (Xem báo cáo quen thuộc)
```

1. **Web App ➔ Supabase (`~100ms`)**:
   - Nhân viên thao tác trực tiếp trên giao diện [ops.meehoasg.com](https://ops.meehoasg.com).
   - Mọi tạo mới đơn, sửa đơn, chuyển trạng thái (`Chờ bó`, `Đã bó`, `Đã giao`), cập nhật thanh toán và công nợ đều ghi tức thời vào cơ sở dữ liệu Supabase thông qua Edge Function `meehoasg-api`.

2. **Supabase ➔ Google Sheet (`Tự động mỗi 1 phút`)**:
   - Google Apps Script chạy trigger time-driven mỗi 1 phút (`syncDelta()`).
   - Hàm `syncSupabaseToSheet()` tự động gọi endpoint `meehoasg-ingest/getOrdersForSheet` để lấy danh sách các đơn hàng mới tạo hoặc mới cập nhật trên Web.
   - Script ghi tự động dòng mới vào Sheet tháng tương ứng (hoặc cập nhật lại dòng nếu đơn đã tồn tại trên Sheet) và thông báo lại tọa độ cho Supabase qua `recordSheetPositions`.

3. **Google Sheet ➔ Supabase (`Đồng bộ ngược`)**:
   - Khi có bất kỳ dữ liệu nào được chỉnh sửa trực tiếp trên Google Sheet, trigger 1 phút `syncDelta()` sẽ quét delta và đồng bộ vào Supabase Database, đảm bảo 2 hệ thống luôn khớp dữ liệu 100%.

## Security & Storage

The API validates existing usernames and SHA-256 password hashes, then issues opaque sessions stored as hashes in `app_sessions`. Supabase's legacy public `anon` JWT is used for platform Edge Function verification; it is public and carries no database privileges. The service-role credential stays strictly in the Edge Function environment. All application tables have RLS enabled and no browser-access policies. Uploaded order images and settlement bills are private Storage objects, returned to authenticated users as time-limited signed URLs.

## Project Structure

- `index.html` / `html`: Giao diện Botanical Studio & Executive Precision cho web vận hành.
- `CNAME`: Cấu hình custom subdomain `ops.meehoasg.com`.
- `supabase/schema.sql`: Toàn bộ cấu trúc cơ sở dữ liệu PostgreSQL trên Supabase.
- `supabase/functions/meehoasg-api/`: API vận hành chính (xác thực, đơn hàng, công nợ, KPI, quyết toán).
- `supabase/functions/meehoasg-ingest/`: API trung gian hỗ trợ đồng bộ dữ liệu với Google Sheet.
- `supabase/functions/meehoasg-ingest/apps-script-sync.gs`: Mã nguồn Google Apps Script triển khai trên Google Sheets để đồng bộ 2 chiều tự động.
