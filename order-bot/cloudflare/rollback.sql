-- MEEHOA Order Bot V1 — Schema Destruction / Full Teardown Script
--
-- ⚠️ CẢNH BÁO NGUY HIỂM:
-- Script này xóa hoàn toàn các bảng D1 của Bot (DROP TABLES).
-- TUYỆT ĐỐI KHÔNG SỬ DỤNG TRONG QUY TRÌNH ROLLBACK VẬN HÀNH THÔNG THƯỜNG!
--
-- Quy trình rollback vận hành chuẩn (BẢO TOÀN DỮ LIỆU) là:
--   1. Hủy Webhook Telegram (ngừng nhận tin nhắn mới).
--   2. Xóa / Tắt Worker Cloudflare.
--   3. Giữ nguyên toàn bộ bảng D1 để phục vụ kiểm toán và đối soát.
--
-- Chỉ chạy file này khi chủ sở hữu phê duyệt hủy bỏ vĩnh viễn tính năng Bot khỏi D1.

DROP INDEX IF EXISTS idx_bot_updates_user;
DROP INDEX IF EXISTS idx_bot_drafts_updated;
DROP TABLE IF EXISTS bot_audit_logs;
DROP TABLE IF EXISTS bot_processed_updates;
DROP TABLE IF EXISTS bot_drafts;
