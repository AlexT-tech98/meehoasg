-- MEEHOA OPS V3.1 — Legacy Settlement Bills DB Reference Rollback (R2 -> Supabase)
-- Safely reverts `settlement_requests.bill_urls` to pre-switch `supabase://settlement-bills/...`
-- because Supabase Storage originals are retained until Owner approves cleanup.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.legacy_settlement_bills_r2_backup') IS NULL THEN
    RAISE EXCEPTION 'Backup table public.legacy_settlement_bills_r2_backup does not exist';
  END IF;
END $$;

UPDATE public.settlement_requests sr
SET bill_urls = b.orig_bill_urls
FROM public.legacy_settlement_bills_r2_backup b
WHERE sr.id = b.settlement_id
  AND sr.bill_urls = b.new_bill_urls;

SELECT
  count(*) AS total_backup_rows,
  count(*) FILTER (WHERE sr.bill_urls = b.orig_bill_urls) AS restored_to_supabase_count,
  count(*) FILTER (WHERE sr.bill_urls <> b.orig_bill_urls) AS skipped_modified_after_switch
FROM public.legacy_settlement_bills_r2_backup b
JOIN public.settlement_requests sr ON sr.id = b.settlement_id;

COMMIT;
