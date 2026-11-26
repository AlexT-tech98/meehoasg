-- MEEHOA OPS V3.1 — Legacy Note -> tag_note_free Normalization Dry-Run (STRICTLY READ-ONLY)
-- Safe to run on Production BEFORE or AFTER backfill without modifying any data.
-- Exact verified UI V3 Production Go-Live cutoff: 2026-11-26T07:28:27Z (14:28:27 +07:00, PR #68 merge).
-- Approved Final Blocker Resolution Policy:
--   1. Never overwrites existing non-empty tag_note_free.
--   2. Never touches orders created at/after UI V3 Go-Live (2026-11-26T07:28:27Z).
--   3. Preserves deleted orders, legacy deletion queue rows, system/audit stamps (`Meehoa_Manage ·`, `[ĐÃ XÓA...]`).
--   4. Keeps at `note` (zero manual review needed):
--      - Card/Banner references anywhere in note (`KEEP_CARD_OR_BANNER`)
--      - Deferred placeholders `"Bsung sau"` / `"Bổ sung sau"` (`KEEP_DEFERRED_PLACEHOLDER`, 32 orders)
--      - Payment / deposit / invoice warnings (`KEEP_PAYMENT_OR_DEPOSIT`)
--      - Delivery / ops / packaging / Zalo / test instructions (`KEEP_OPS_OR_MIXED`)
--   5. Auto-migrates clean pre-Go-Live tag/greeting notes (`3,619` orders on Production baseline),
--      including blank/self-written tag notes (`"Note trống tự ghi"`) and greetings containing substrings (`scholarship`, `friendship`, `@hihihaha`, proper names).

-- ============================================================================
-- QUERY 1: SUMMARY CLASSIFICATION INVENTORY
-- ============================================================================
WITH classified AS (
  SELECT
    o.id,
    o.order_date,
    o.customer,
    o.sale,
    o.created_at,
    o.updated_at,
    o.is_deleted,
    o.delete_after_sheet_sync,
    o.card,
    o.banner,
    o.note,
    o.tag_note_free,
    CASE
      WHEN o.created_at >= TIMESTAMPTZ '2026-11-26T07:28:27Z' THEN 'SKIP_POST_GOLIVE'
      WHEN nullif(trim(coalesce(o.tag_note_free, '')), '') IS NOT NULL THEN 'SKIP_ALREADY_HAS_TAG_NOTE_FREE'
      WHEN coalesce(o.is_deleted, false) OR coalesce(o.delete_after_sheet_sync, false)
        OR coalesce(o.note, '') ~ 'Meehoa_Manage[[:space:]]*·'
        OR coalesce(o.note, '') ~ '\[ĐÃ XÓA' THEN 'SKIP_DELETED_OR_AUDIT_STAMP'
      WHEN coalesce(o.note, '') ~* '(^|[^[:alpha:]])(thiệp|thiep|banner)([^[:alpha:]]|$)' THEN 'KEEP_CARD_OR_BANNER'
      WHEN coalesce(o.note, '') ~* '(bổ[[:space:]]*sung[[:space:]]*sau|bo[[:space:]]*sung[[:space:]]*sau|bsung[[:space:]]*sau)' THEN 'KEEP_DEFERRED_PLACEHOLDER'
      WHEN coalesce(o.note, '') ~* '((^|[^[:alpha:]])(cọc|full[[:space:]]*paid|fullpaid|bank[[:space:]]*full|bankfull|cod)([^[:alpha:]]|$)|thu[[:space:]]*hộ|hóa[[:space:]]*đơn|xuất[[:space:]]*hđ|bù[[:space:]]*tiền|giảm[[:space:]]*giá)' THEN 'KEEP_PAYMENT_OR_DEPOSIT'
      WHEN coalesce(o.note, '') ~* '((^|[^[:alpha:]])(ship|shipper|zalo|zaloo|grab|ahamove|sđt|sdt|test)([^[:alpha:]]|$)|(^|[^[:alpha:]])aha([^[:alnum:]_]|$)|giao[[:space:]]*(thứ|ngày|lúc|trước|sau|trong|đến|tới|qua|hàng|hoa|giúp|nhanh|gấp|đúng)|khi[[:space:]]*giao|liên[[:space:]]*hệ|(ko|không|khỏi|đừng|cần|nhớ|shop|nhân[[:space:]]*viên)[[:space:]]*(cần[[:space:]]*)?gọi|gọi[[:space:]]*(trước|trc|xác[[:space:]]*nhận|sđt|sdt|số|người[[:space:]]*nhận|ng[[:space:]]*đặt|khách)|chụp[[:space:]]*(hình|ảnh|trước)|gửi[[:space:]]*ảnh|gửi[[:space:]]*kèm|check[[:space:]]*(hình|ảnh|hoa)|cẩn[[:space:]]*thận|nhẹ[[:space:]]*tay|đúng[[:space:]]*giờ|báo[[:space:]]*trước|địa[[:space:]]*chỉ|lấy[[:space:]]*thêm|bó[[:space:]]*gấp|(^|[^[:alpha:]])gấp([^[:alpha:]]|$)|trước[[:space:]]+[0-9]|sau[[:space:]]+[0-9]|đổi[[:space:]]*hoa|đổi[[:space:]]*giấy[[:space:]]*gói|ghé[[:space:]]*lấy|mới[[:space:]]*book|tự[[:space:]]*book|book[[:space:]]*(ship|grab|aha)|(mình|sốp|shop)[[:space:]]*tự[[:space:]]*(viết|ghi)[[:space:]]*(thư|chúc)|qua[[:space:]]*viết[[:space:]]*sau|đợt[[:space:]]*1|kiểm[[:space:]]*thử)' THEN 'KEEP_OPS_OR_MIXED'
      WHEN coalesce(o.note, '') ~* '^[[:space:]]*[•·*-]?[[:space:]]*(lấy[[:space:]]*(giấy[[:space:]]*)?note|note[[:space:]]*free|tag[[:space:]]*note([[:space:]]*free)?|giấy[[:space:]]*note|note)([^[:alnum:]_]|$)' THEN 'AUTO_MIGRATE_EXPLICIT_NOTE'
      ELSE 'AUTO_MIGRATE_CLEAN_LEGACY_NOTE'
    END AS classification
  FROM public.orders o
  WHERE nullif(trim(coalesce(o.note, '')), '') IS NOT NULL
)
SELECT
  count(*) AS total_orders_with_note,
  count(*) FILTER (WHERE classification = 'AUTO_MIGRATE_EXPLICIT_NOTE') AS auto_migrate_explicit_note,
  count(*) FILTER (WHERE classification = 'AUTO_MIGRATE_CLEAN_LEGACY_NOTE') AS auto_migrate_clean_legacy_note,
  count(*) FILTER (WHERE classification IN ('AUTO_MIGRATE_EXPLICIT_NOTE', 'AUTO_MIGRATE_CLEAN_LEGACY_NOTE')) AS total_auto_migrate_eligible,
  count(*) FILTER (WHERE classification = 'KEEP_CARD_OR_BANNER') AS keep_card_or_banner,
  count(*) FILTER (WHERE classification = 'KEEP_DEFERRED_PLACEHOLDER') AS keep_deferred_placeholder,
  count(*) FILTER (WHERE classification = 'KEEP_PAYMENT_OR_DEPOSIT') AS keep_payment_or_deposit,
  count(*) FILTER (WHERE classification = 'KEEP_OPS_OR_MIXED') AS keep_ops_or_mixed,
  count(*) FILTER (WHERE classification LIKE 'KEEP_%') AS total_kept_at_note,
  count(*) FILTER (WHERE classification = 'SKIP_DELETED_OR_AUDIT_STAMP') AS skip_deleted_or_audit_stamp,
  count(*) FILTER (WHERE classification = 'SKIP_ALREADY_HAS_TAG_NOTE_FREE') AS skip_already_has_tag_note_free,
  count(*) FILTER (WHERE classification = 'SKIP_POST_GOLIVE') AS skip_post_golive,
  count(*) FILTER (WHERE classification LIKE 'SKIP_%') AS total_protected_skipped
FROM classified;

-- ============================================================================
-- QUERY 2: KEPT-AT-NOTE BREAKDOWN PREVIEW (NOT AUTO-MIGRATED)
-- ============================================================================
WITH classified AS (
  SELECT
    o.id,
    o.order_date,
    o.customer,
    o.sale,
    o.created_at,
    o.card,
    o.banner,
    o.note,
    o.tag_note_free,
    CASE
      WHEN o.created_at >= TIMESTAMPTZ '2026-11-26T07:28:27Z' THEN 'SKIP_POST_GOLIVE'
      WHEN nullif(trim(coalesce(o.tag_note_free, '')), '') IS NOT NULL THEN 'SKIP_ALREADY_HAS_TAG_NOTE_FREE'
      WHEN coalesce(o.is_deleted, false) OR coalesce(o.delete_after_sheet_sync, false)
        OR coalesce(o.note, '') ~ 'Meehoa_Manage[[:space:]]*·'
        OR coalesce(o.note, '') ~ '\[ĐÃ XÓA' THEN 'SKIP_DELETED_OR_AUDIT_STAMP'
      WHEN coalesce(o.note, '') ~* '(^|[^[:alpha:]])(thiệp|thiep|banner)([^[:alpha:]]|$)' THEN 'KEEP_CARD_OR_BANNER'
      WHEN coalesce(o.note, '') ~* '(bổ[[:space:]]*sung[[:space:]]*sau|bo[[:space:]]*sung[[:space:]]*sau|bsung[[:space:]]*sau)' THEN 'KEEP_DEFERRED_PLACEHOLDER'
      WHEN coalesce(o.note, '') ~* '((^|[^[:alpha:]])(cọc|full[[:space:]]*paid|fullpaid|bank[[:space:]]*full|bankfull|cod)([^[:alpha:]]|$)|thu[[:space:]]*hộ|hóa[[:space:]]*đơn|xuất[[:space:]]*hđ|bù[[:space:]]*tiền|giảm[[:space:]]*giá)' THEN 'KEEP_PAYMENT_OR_DEPOSIT'
      WHEN coalesce(o.note, '') ~* '((^|[^[:alpha:]])(ship|shipper|zalo|zaloo|grab|ahamove|sđt|sdt|test)([^[:alpha:]]|$)|(^|[^[:alpha:]])aha([^[:alnum:]_]|$)|giao[[:space:]]*(thứ|ngày|lúc|trước|sau|trong|đến|tới|qua|hàng|hoa|giúp|nhanh|gấp|đúng)|khi[[:space:]]*giao|liên[[:space:]]*hệ|(ko|không|khỏi|đừng|cần|nhớ|shop|nhân[[:space:]]*viên)[[:space:]]*(cần[[:space:]]*)?gọi|gọi[[:space:]]*(trước|trc|xác[[:space:]]*nhận|sđt|sdt|số|người[[:space:]]*nhận|ng[[:space:]]*đặt|khách)|chụp[[:space:]]*(hình|ảnh|trước)|gửi[[:space:]]*ảnh|gửi[[:space:]]*kèm|check[[:space:]]*(hình|ảnh|hoa)|cẩn[[:space:]]*thận|nhẹ[[:space:]]*tay|đúng[[:space:]]*giờ|báo[[:space:]]*trước|địa[[:space:]]*chỉ|lấy[[:space:]]*thêm|bó[[:space:]]*gấp|(^|[^[:alpha:]])gấp([^[:alpha:]]|$)|trước[[:space:]]+[0-9]|sau[[:space:]]+[0-9]|đổi[[:space:]]*hoa|đổi[[:space:]]*giấy[[:space:]]*gói|ghé[[:space:]]*lấy|mới[[:space:]]*book|tự[[:space:]]*book|book[[:space:]]*(ship|grab|aha)|(mình|sốp|shop)[[:space:]]*tự[[:space:]]*(viết|ghi)[[:space:]]*(thư|chúc)|qua[[:space:]]*viết[[:space:]]*sau|đợt[[:space:]]*1|kiểm[[:space:]]*thử)' THEN 'KEEP_OPS_OR_MIXED'
      ELSE 'AUTO_MIGRATE'
    END AS classification
  FROM public.orders o
  WHERE nullif(trim(coalesce(o.note, '')), '') IS NOT NULL
)
SELECT
  id,
  order_date,
  classification,
  sale,
  card,
  banner,
  left(customer, 60) AS customer_preview,
  left(note, 200) AS note_preview,
  created_at
FROM classified
WHERE classification LIKE 'KEEP_%'
ORDER BY order_date DESC, created_at DESC, id ASC;
