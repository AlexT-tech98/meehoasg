-- MEEHOA OPS V3.1 — Legacy Bills DB Reference Rollback (All 919 Bills: R2 -> Supabase)
-- Safely reverts BOTH `settlement_requests.bill_urls` AND `orders.full_paid_bill_urls`
-- to pre-switch `supabase://settlement-bills/...` because Supabase Storage originals are retained.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.legacy_settlement_bills_r2_backup') IS NULL
     AND to_regclass('public.legacy_full_paid_bills_r2_backup') IS NULL THEN
    RAISE EXCEPTION 'Neither backup table legacy_settlement_bills_r2_backup nor legacy_full_paid_bills_r2_backup exists';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.legacy_settlement_bills_r2_backup') IS NOT NULL THEN
    UPDATE public.settlement_requests sr
    SET bill_urls = b.orig_bill_urls
    FROM public.legacy_settlement_bills_r2_backup b
    WHERE sr.id = b.settlement_id
      AND sr.bill_urls = b.new_bill_urls;
  END IF;

  IF to_regclass('public.legacy_full_paid_bills_r2_backup') IS NOT NULL THEN
    UPDATE public.orders o
    SET full_paid_bill_urls = b.orig_full_paid_bill_urls
    FROM public.legacy_full_paid_bills_r2_backup b
    WHERE o.id = b.order_id
      AND o.full_paid_bill_urls = b.new_full_paid_bill_urls;
  END IF;
END $$;

SELECT
  (SELECT count(*) FROM public.settlement_requests WHERE bill_urls::text LIKE '%supabase://settlement-bills/%') AS sr_restored_on_supabase,
  (SELECT count(*) FROM public.orders WHERE full_paid_bill_urls::text LIKE '%supabase://settlement-bills/%') AS fp_orders_restored_on_supabase;

COMMIT;
