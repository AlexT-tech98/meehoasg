-- Private archives must never be reachable with browser API roles.
-- Conditional objects keep this migration compatible with fresh installs.
DO $$
DECLARE object_name text; function_name text;
BEGIN
  FOREACH object_name IN ARRAY ARRAY['deleted_orders','orders_dup_artifact_backup_20261001'] LOOP
    IF to_regclass('public.' || object_name) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', object_name);
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', object_name);
    END IF;
  END LOOP;
  IF to_regclass('public.order_card_quantity_audit') IS NOT NULL THEN
    ALTER VIEW public.order_card_quantity_audit SET (security_invoker = true);
    REVOKE ALL ON TABLE public.order_card_quantity_audit FROM PUBLIC, anon, authenticated;
  END IF;
  FOREACH function_name IN ARRAY ARRAY['normalize_order_card_qty','mark_order_sheet_sync_state','archive_order_after_sheet_delete_ack','guard_order_ship_fee_update','canonicalize_settlement_amounts','guard_full_paid_after_financial_change'] LOOP
    IF to_regprocedure('public.' || function_name || '()') IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION public.%I() SET search_path = public, pg_temp', function_name);
    END IF;
  END LOOP;
END $$;
