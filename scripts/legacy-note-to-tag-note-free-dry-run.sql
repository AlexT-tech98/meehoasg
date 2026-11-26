-- MEEHOA OPS V3.1 — Legacy Note -> tag_note_free Normalization Dry-Run (STRICTLY READ-ONLY)
-- Safe to run on Production BEFORE or AFTER backfill without modifying any data.
-- Exact verified UI V3 Production Go-Live cutoff: 2026-11-26T07:28:27Z (14:28:27 +07:00, PR #68 merge).
-- Rules:
--   1. Never overwrites existing non-empty tag_note_free.
--   2. Never touches orders created at/after UI V3 Go-Live (2026-11-26T07:28:27Z).
--   3. Preserves deleted orders, legacy deletion queue rows, system/audit stamps (`Meehoa_Manage ·`, `[ĐÃ XÓA...]`).
--   4. Preserves card_text, banner_text, and flower verbatim; separates card/banner-prefixed notes and operational/mixed notes for manual review instead of auto-overwriting.

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
      WHEN coalesce(o.note, '') ~* '^[[:space:]]*[•·*-]?[[:space:]]*(lấy[[:space:]]*)?(thiệp|banner)([^[:alnum:]_]|$)' THEN 'SEPARATED_CARD_OR_BANNER'
      WHEN coalesce(o.note, '') ~* '(giao[[:space:]]|ship|liên[[:space:]]*hệ|gọi|thu[[:space:]]*hộ|cod([^[:alnum:]_]|$)|chụp|gửi[[:space:]]*ảnh|hóa[[:space:]]*đơn|xuất[[:space:]]*hđ|cẩn[[:space:]]*thận|nhẹ[[:space:]]*tay|đúng[[:space:]]*giờ|ko[[:space:]]*gọi|không[[:space:]]*gọi|đừng[[:space:]]*gọi|báo[[:space:]]*trước|tự[[:space:]]*viết|tự[[:space:]]*ghi|khách[[:space:]]*tự|địa[[:space:]]*chỉ|sđt|sdt|zalo|grab|aha|check[[:space:]]|kèm[[:space:]]|lấy[[:space:]]*thêm|bó[[:space:]]*gấp|gấp([^[:alnum:]_]|$)|trước[[:space:]]+[0-9]|sau[[:space:]]+[0-9]|đổi[[:space:]]*hoa|bù[[:space:]]*tiền|giảm[[:space:]]*giá|tặng[[:space:]]*thêm|đợt[[:space:]]*1|test([^[:alnum:]_]|$)|kiểm[[:space:]]*thử)' THEN 'SEPARATED_OPS_OR_MIXED'
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
  count(*) FILTER (WHERE classification = 'SEPARATED_CARD_OR_BANNER') AS separated_card_or_banner_review,
  count(*) FILTER (WHERE classification = 'SEPARATED_OPS_OR_MIXED') AS separated_ops_or_mixed_review,
  count(*) FILTER (WHERE classification = 'SKIP_DELETED_OR_AUDIT_STAMP') AS skip_deleted_or_audit_stamp,
  count(*) FILTER (WHERE classification = 'SKIP_ALREADY_HAS_TAG_NOTE_FREE') AS skip_already_has_tag_note_free,
  count(*) FILTER (WHERE classification = 'SKIP_POST_GOLIVE') AS skip_post_golive
FROM classified;

-- ============================================================================
-- QUERY 2: SEPARATED CASES FOR MANUAL REVIEW (NOT AUTO-MIGRATED)
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
      WHEN coalesce(o.note, '') ~* '^[[:space:]]*[•·*-]?[[:space:]]*(lấy[[:space:]]*)?(thiệp|banner)([^[:alnum:]_]|$)' THEN 'SEPARATED_CARD_OR_BANNER'
      WHEN coalesce(o.note, '') ~* '(giao[[:space:]]|ship|liên[[:space:]]*hệ|gọi|thu[[:space:]]*hộ|cod([^[:alnum:]_]|$)|chụp|gửi[[:space:]]*ảnh|hóa[[:space:]]*đơn|xuất[[:space:]]*hđ|cẩn[[:space:]]*thận|nhẹ[[:space:]]*tay|đúng[[:space:]]*giờ|ko[[:space:]]*gọi|không[[:space:]]*gọi|đừng[[:space:]]*gọi|báo[[:space:]]*trước|tự[[:space:]]*viết|tự[[:space:]]*ghi|khách[[:space:]]*tự|địa[[:space:]]*chỉ|sđt|sdt|zalo|grab|aha|check[[:space:]]|kèm[[:space:]]|lấy[[:space:]]*thêm|bó[[:space:]]*gấp|gấp([^[:alnum:]_]|$)|trước[[:space:]]+[0-9]|sau[[:space:]]+[0-9]|đổi[[:space:]]*hoa|bù[[:space:]]*tiền|giảm[[:space:]]*giá|tặng[[:space:]]*thêm|đợt[[:space:]]*1|test([^[:alnum:]_]|$)|kiểm[[:space:]]*thử)' THEN 'SEPARATED_OPS_OR_MIXED'
      WHEN coalesce(o.note, '') ~* '^[[:space:]]*[•·*-]?[[:space:]]*(lấy[[:space:]]*(giấy[[:space:]]*)?note|note[[:space:]]*free|tag[[:space:]]*note([[:space:]]*free)?|giấy[[:space:]]*note|note)([^[:alnum:]_]|$)' THEN 'AUTO_MIGRATE_EXPLICIT_NOTE'
      ELSE 'AUTO_MIGRATE_CLEAN_LEGACY_NOTE'
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
WHERE classification IN ('SEPARATED_CARD_OR_BANNER', 'SEPARATED_OPS_OR_MIXED')
ORDER BY order_date DESC, created_at DESC, id ASC;
