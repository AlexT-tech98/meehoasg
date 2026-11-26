-- MEEHOA OPS V3.1 — Legacy Note -> tag_note_free Normalization Backfill (IDEMPOTENT & REVERSIBLE)
-- DO NOT run on Production without Owner Go-Live authorization and dry-run review.
-- Moves ONLY verified pre-UI-V3 legacy note content (`created_at < '2026-11-26T07:28:27Z'`)
-- from `orders.note` -> `orders.tag_note_free` and clears `orders.note = ''` to prevent duplicate display.
-- Strictly preserves:
--   - All post-Go-Live orders (`created_at >= '2026-11-26T07:28:27Z'`)
--   - Any order already having non-empty `tag_note_free`
--   - Deleted orders, legacy deletion queue rows, system/audit stamps (`Meehoa_Manage ·`, `[ĐÃ XÓA...]`)
--   - Card/Banner-prefixed notes (`SEPARATED_CARD_OR_BANNER`) and operational/mixed notes (`SEPARATED_OPS_OR_MIXED`)
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
  WHERE o.created_at < TIMESTAMPTZ '2026-11-26T07:28:27Z'
    AND nullif(trim(coalesce(o.note, '')), '') IS NOT NULL
    AND nullif(trim(coalesce(o.tag_note_free, '')), '') IS NULL
    AND coalesce(o.is_deleted, false) = false
    AND coalesce(o.delete_after_sheet_sync, false) = false
    AND coalesce(o.note, '') !~ 'Meehoa_Manage[[:space:]]*·'
    AND coalesce(o.note, '') !~ '\[ĐÃ XÓA'
    AND coalesce(o.note, '') !~* '^[[:space:]]*[•·*-]?[[:space:]]*(lấy[[:space:]]*)?(thiệp|banner)([^[:alnum:]_]|$)'
    AND coalesce(o.note, '') !~* '(giao[[:space:]]|ship|liên[[:space:]]*hệ|gọi|thu[[:space:]]*hộ|cod([^[:alnum:]_]|$)|chụp|gửi[[:space:]]*ảnh|hóa[[:space:]]*đơn|xuất[[:space:]]*hđ|cẩn[[:space:]]*thận|nhẹ[[:space:]]*tay|đúng[[:space:]]*giờ|ko[[:space:]]*gọi|không[[:space:]]*gọi|đừng[[:space:]]*gọi|báo[[:space:]]*trước|tự[[:space:]]*viết|tự[[:space:]]*ghi|khách[[:space:]]*tự|địa[[:space:]]*chỉ|sđt|sdt|zalo|grab|aha|check[[:space:]]|kèm[[:space:]]|lấy[[:space:]]*thêm|bó[[:space:]]*gấp|gấp([^[:alnum:]_]|$)|trước[[:space:]]+[0-9]|sau[[:space:]]+[0-9]|đổi[[:space:]]*hoa|bù[[:space:]]*tiền|giảm[[:space:]]*giá|tặng[[:space:]]*thêm|đợt[[:space:]]*1|test([^[:alnum:]_]|$)|kiểm[[:space:]]*thử)'
),
backed_up AS (
  INSERT INTO public.legacy_note_migration_backup (
    order_id,
    classification,
    orig_note,
    orig_tag_note_free,
    orig_updated_at
  )
  SELECT id, classification, orig_note, orig_tag_note_free, orig_updated_at
  FROM candidates
  ON CONFLICT (order_id) DO NOTHING
  RETURNING order_id, classification, orig_note
),
updated_orders AS (
  UPDATE public.orders o
  SET
    tag_note_free = trim(b.orig_note),
    note = ''
  FROM backed_up b
  WHERE o.id = b.order_id
    AND nullif(trim(coalesce(o.tag_note_free, '')), '') IS NULL
  RETURNING o.id, b.classification
)
SELECT
  count(*) AS newly_migrated_count,
  count(*) FILTER (WHERE classification = 'AUTO_MIGRATE_EXPLICIT_NOTE') AS explicit_note_migrated,
  count(*) FILTER (WHERE classification = 'AUTO_MIGRATE_CLEAN_LEGACY_NOTE') AS clean_legacy_migrated,
  (SELECT count(*) FROM public.legacy_note_migration_backup) AS total_backup_rows
FROM updated_orders;

COMMIT;
