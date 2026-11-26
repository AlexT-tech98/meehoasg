-- MEEHOA Order Bot V1 — Dọn Dẹp Dữ Liệu Thử Nghiệm Staging (Purge Test Data)
--
-- ⚠️ YÊU CẦU PHÊ DUYỆT RIÊNG CỦA CHỦ SỞ HỮU:
-- File này chỉ dùng để dọn dẹp các đơn nháp, nhật ký và update Telegram của tài khoản test
-- trong quá trình nghiệm thu Staging (User ID: 5252724920).
-- KHÔNG xóa bảng (KHÔNG DROP TABLE), KHÔNG ảnh hưởng đến các bảng OPS.

-- 1. Xóa dữ liệu đơn nháp của tài khoản thử nghiệm Staging
DELETE FROM bot_drafts WHERE user_id = 5252724920;

-- 2. Xóa các bản ghi cập nhật Telegram đã xử lý của tài khoản thử nghiệm
DELETE FROM bot_processed_updates WHERE user_id = 5252724920;

-- 3. Xóa nhật ký kiểm toán hành động thử nghiệm của bot
DELETE FROM bot_audit_logs WHERE user_id = 5252724920;
