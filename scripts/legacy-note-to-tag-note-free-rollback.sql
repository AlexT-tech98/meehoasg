-- MEEHOA OPS V3.1 — Legacy Note -> tag_note_free Rollback (SAFE & IDEMPOTENT)
-- Restores `orders.note` and `orders.tag_note_free` from `public.legacy_note_migration_backup`
-- ONLY for rows still matching the migrated state (never overwrites subsequent manual staff edits).

BEGIN;

WITH restored AS (
  UPDATE public.orders o
  SET
    note = b.orig_note,
    tag_note_free = b.orig_tag_note_free
  FROM public.legacy_note_migration_backup b
  WHERE o.id = b.order_id
    AND coalesce(o.note, '') = ''
    AND o.tag_note_free = trim(b.orig_note)
  RETURNING o.id
),
cleaned_backup AS (
  DELETE FROM public.legacy_note_migration_backup b
  USING restored r
  WHERE b.order_id = r.id
  RETURNING b.order_id
)
SELECT
  (SELECT count(*) FROM restored) AS restored_orders_count,
  (SELECT count(*) FROM cleaned_backup) AS backup_rows_cleared,
  (SELECT count(*) FROM public.legacy_note_migration_backup) AS remaining_backup_rows_with_subsequent_edits;

COMMIT;
