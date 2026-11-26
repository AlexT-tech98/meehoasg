-- MEEHOA OPS V3.1 — Legacy Bills DB Reference Rollback (All 919 Bills: R2 -> Supabase)
-- Safely reverts BOTH `settlement_requests.bill_urls` AND `orders.full_paid_bill_urls`
-- to pre-switch `supabase://settlement-bills/...` because Supabase Storage originals are retained.
-- Supports optional per-batch rollback via `app.rollback_settlement_bill_keys` (JSON array of `<uuid>.<ext>` keys).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.legacy_settlement_bills_r2_backup') IS NULL
     AND to_regclass('public.legacy_full_paid_bills_r2_backup') IS NULL THEN
    RAISE EXCEPTION 'Neither backup table legacy_settlement_bills_r2_backup nor legacy_full_paid_bills_r2_backup exists';
  END IF;
END $$;

DO $$
DECLARE
  v_raw text := nullif(trim(coalesce(current_setting('app.rollback_settlement_bill_keys', true), '')), '');
  v_keys jsonb := '[]'::jsonb;
  v_has_batch_filter boolean := false;
BEGIN
  IF v_raw IS NOT NULL THEN
    v_keys := v_raw::jsonb;
    IF jsonb_typeof(v_keys) = 'array' AND jsonb_array_length(v_keys) > 0 THEN
      v_has_batch_filter := true;
    END IF;
  END IF;

  IF to_regclass('public.legacy_settlement_bills_r2_backup') IS NOT NULL THEN
    WITH target_keys AS (
      SELECT DISTINCT 'supabase://settlement-bills/' || value AS orig_uri
      FROM jsonb_array_elements_text(v_keys) AS value
      WHERE value ~ '^[0-9a-f-]{36}(?:\.preview)?\.(?:jpg|png|webp)$'
    ),
    restored_sr AS (
      UPDATE public.settlement_requests sr
      SET bill_urls = b.orig_bill_urls
      FROM public.legacy_settlement_bills_r2_backup b
      WHERE sr.id = b.settlement_id
        AND sr.bill_urls = b.new_bill_urls
        AND (
          NOT v_has_batch_filter
          OR EXISTS (
            SELECT 1
            FROM target_keys tk
            WHERE b.orig_bill_urls ? tk.orig_uri
          )
        )
      RETURNING sr.id
    )
    DELETE FROM public.legacy_settlement_bills_r2_backup b
    USING restored_sr r
    WHERE b.settlement_id = r.id;
  END IF;

  IF to_regclass('public.legacy_full_paid_bills_r2_backup') IS NOT NULL THEN
    WITH target_keys AS (
      SELECT DISTINCT 'supabase://settlement-bills/' || value AS orig_uri
      FROM jsonb_array_elements_text(v_keys) AS value
      WHERE value ~ '^[0-9a-f-]{36}(?:\.preview)?\.(?:jpg|png|webp)$'
    ),
    restored_fp AS (
      UPDATE public.orders o
      SET full_paid_bill_urls = b.orig_full_paid_bill_urls
      FROM public.legacy_full_paid_bills_r2_backup b
      WHERE o.id = b.order_id
        AND o.full_paid_bill_urls = b.new_full_paid_bill_urls
        AND (
          NOT v_has_batch_filter
          OR EXISTS (
            SELECT 1
            FROM target_keys tk
            WHERE b.orig_full_paid_bill_urls ? tk.orig_uri
          )
        )
      RETURNING o.id
    )
    DELETE FROM public.legacy_full_paid_bills_r2_backup b
    USING restored_fp r
    WHERE b.order_id = r.id;
  END IF;
END $$;

SELECT
  (SELECT count(*) FROM public.settlement_requests WHERE bill_urls::text LIKE '%supabase://settlement-bills/%') AS sr_restored_on_supabase,
  (SELECT count(*) FROM public.orders WHERE full_paid_bill_urls::text LIKE '%supabase://settlement-bills/%') AS fp_orders_restored_on_supabase,
  (SELECT count(*) FROM public.legacy_settlement_bills_r2_backup) AS remaining_sr_backup_rows,
  (SELECT count(*) FROM public.legacy_full_paid_bills_r2_backup) AS remaining_fp_backup_rows;

COMMIT;
