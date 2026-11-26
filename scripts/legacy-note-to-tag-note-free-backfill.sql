-- MEEHOA OPS V3.1 — Legacy Note -> tag_note_free Normalization Backfill (IDEMPOTENT & REVERSIBLE)
-- DO NOT run on Production without Owner Go-Live authorization and pre-migration dry-run count reconciliation.
-- Moves ONLY verified safe pre-UI-V3 legacy tag/greeting notes (`created_at < '2026-11-26T07:28:27Z'`, 3,619 orders on baseline)
-- from `orders.note` -> `orders.tag_note_free` and clears `orders.note = ''` to prevent duplicate display.
-- Strictly preserves / keeps at `note`:
--   - All post-Go-Live orders (`created_at >= '2026-11-26T07:28:27Z'`)
--   - Any order already having non-empty `tag_note_free`
--   - Deleted orders, legacy deletion queue rows, system/audit stamps (`Meehoa_Manage ·`, `[ĐÃ XÓA...]`)
--   - Card/Banner references anywhere in note (`KEEP_CARD_OR_BANNER`, 789 orders)
--   - Deferred `"Bsung sau"` / `"Bổ sung sau"` placeholders (`KEEP_DEFERRED_PLACEHOLDER`, 32 orders)
--   - Payment / deposit / invoice warnings (`KEEP_PAYMENT_OR_DEPOSIT`, 23 orders)
--   - Operational / delivery / packaging / Zalo / test instructions (`KEEP_OPS_OR_MIXED`, 66 orders)
--   - `card_text`, `banner_text`, `flower`, financial totals, images, bills, and `updated_at` integrity.
-- Reversible via `scripts/legacy-note-to-tag-note-free-rollback.sql`.

BEGIN;

CREATE TABLE IF NOT EXISTS public.legacy_note_migration_backup (
  order_id text PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  classification text NOT NULL,
  orig_note text NOT NULL,
  orig_tag_note_free text NOT NULL,
  orig_updated_at timestamptz NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.legacy_note_migration_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.legacy_note_migration_backup FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.legacy_note_migration_backup TO service_role;

WITH candidates AS (
  SELECT
    o.id,
    o.note AS orig_note,
    coalesce(o.tag_note_free, '') AS orig_tag_note_free,
    o.updated_at AS orig_updated_at,
    CASE
      WHEN coalesce(o.note, '') ~* '^[[:space:]]*[•·*-]?[[:space:]]*(lấy[[:space:]]*(giấy[[:space:]]*)?note|note[[:space:]]*free|tag[[:space:]]*note([[:space:]]*free)?|giấy[[:space:]]*note|note)([^[:alnum:]_]|$)'
        THEN 'AUTO_MIGRATE_EXPLICIT_NOTE'
      ELSE 'AUTO_MIGRATE_CLEAN_LEGACY_NOTE'
    END AS classification
  FROM public.orders o
  WHERE nullif(trim(coalesce(o.note, '')), '') IS NOT NULL
    AND o.created_at < TIMESTAMPTZ '2026-11-26T07:28:27Z'
    AND nullif(trim(coalesce(o.tag_note_free, '')), '') IS NULL
    AND coalesce(o.is_deleted, false) = false
    AND coalesce(o.delete_after_sheet_sync, false) = false
    AND coalesce(o.note, '') !~ 'Meehoa_Manage[[:space:]]*·'
    AND coalesce(o.note, '') !~ '\[ĐÃ XÓA'
    AND coalesce(o.note, '') !~* '(^|[^[:alpha:]])(thiệp|thiep|banner)([^[:alpha:]]|$)'
    AND coalesce(o.note, '') !~* '(bổ[[:space:]]*sung[[:space:]]*sau|bo[[:space:]]*sung[[:space:]]*sau|bsung[[:space:]]*sau)'
    AND coalesce(o.note, '') !~* '((^|[^[:alpha:]])(cọc|full[[:space:]]*paid|fullpaid|bank[[:space:]]*full|bankfull|cod)([^[:alpha:]]|$)|thu[[:space:]]*hộ|hóa[[:space:]]*đơn|xuất[[:space:]]*hđ|bù[[:space:]]*tiền|giảm[[:space:]]*giá)'
    AND coalesce(o.note, '') !~* '((^|[^[:alpha:]])(ship|shipper|zalo|zaloo|grab|ahamove|sđt|sdt|test)([^[:alpha:]]|$)|(^|[^[:alpha:]])aha([^[:alnum:]_]|$)|giao[[:space:]]*(thứ|ngày|lúc|trước|sau|trong|đến|tới|qua|hàng|hoa|giúp|nhanh|gấp|đúng)|khi[[:space:]]*giao|liên[[:space:]]*hệ|(ko|không|khỏi|đừng|cần|nhớ|shop|nhân[[:space:]]*viên)[[:space:]]*(cần[[:space:]]*)?gọi|gọi[[:space:]]*(trước|trc|xác[[:space:]]*nhận|sđt|sdt|số|người[[:space:]]*nhận|ng[[:space:]]*đặt|khách)|chụp[[:space:]]*(hình|ảnh|trước)|gửi[[:space:]]*ảnh|gửi[[:space:]]*kèm|check[[:space:]]*(hình|ảnh|hoa)|cẩn[[:space:]]*thận|nhẹ[[:space:]]*tay|đúng[[:space:]]*giờ|báo[[:space:]]*trước|địa[[:space:]]*chỉ|lấy[[:space:]]*thêm|bó[[:space:]]*gấp|(^|[^[:alpha:]])gấp([^[:alpha:]]|$)|trước[[:space:]]+[0-9]|sau[[:space:]]+[0-9]|đổi[[:space:]]*hoa|đổi[[:space:]]*giấy[[:space:]]*gói|ghé[[:space:]]*lấy|mới[[:space:]]*book|tự[[:space:]]*book|book[[:space:]]*(ship|grab|aha)|(mình|sốp|shop)[[:space:]]*tự[[:space:]]*(viết|ghi)[[:space:]]*(thư|chúc)|qua[[:space:]]*viết[[:space:]]*sau|đợt[[:space:]]*1|kiểm[[:space:]]*thử)'
),
backed_up AS (
  INSERT INTO public.legacy_note_migration_backup (
    order_id, classification, orig_note, orig_tag_note_free, orig_updated_at
  )
  SELECT
    id, classification, orig_note, orig_tag_note_free, orig_updated_at
  FROM candidates
  ON CONFLICT (order_id) DO NOTHING
  RETURNING order_id
)
UPDATE public.orders o
SET
  tag_note_free = trim(c.orig_note),
  note = ''
FROM candidates c
WHERE o.id = c.id
  AND nullif(trim(coalesce(o.tag_note_free, '')), '') IS NULL;

SELECT
  (SELECT count(*) FROM public.legacy_note_migration_backup) AS total_backed_up_and_migrated,
  (SELECT count(*) FROM public.orders WHERE nullif(trim(coalesce(tag_note_free, '')), '') IS NOT NULL) AS total_orders_with_tag_note_free,
  (SELECT count(*) FROM public.orders WHERE nullif(trim(coalesce(note, '')), '') IS NOT NULL) AS remaining_orders_with_note;

COMMIT;
