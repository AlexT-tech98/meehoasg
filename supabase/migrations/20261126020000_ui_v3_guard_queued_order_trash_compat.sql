-- MEEHOA OPS UI V3 — Reconcile legacy `guard_queued_order_update()` trigger with UI V3 Trash backfill & Admin Restore.
-- Preserves all legacy protections (`DELETE_SETTLEMENT_CONFLICT` and `ORDER_DELETING`) for unauthorized updates,
-- while permitting ONLY:
--   1. Idempotent `LEGACY_MIGRATION` Trash backfill (`is_deleted = true`, `deleted_reason_code = 'LEGACY_MIGRATION'`,
--      `deleted_by_role = 'ADMIN'`, stripping only `[ĐÃ XÓA]` / `[ĐÃ XÓA TRÊN OPS]` markers while preserving
--      `delete_after_sheet_sync = true`, financial fields, images, bills, settled/full_paid, and status).
--   2. Server-verified Admin Restore from Trash (`restoreOrder`: `delete_after_sheet_sync = false`, `is_deleted = false`,
--      `restored_at` set, `restored_by` verified as active `ADMIN` in `public.app_users`, zero other column edits).
--   3. Reversible `LEGACY_MIGRATION` rollback from `public.legacy_deleted_orders_backup` if ever invoked.

CREATE TABLE IF NOT EXISTS public.legacy_deleted_orders_backup (
  order_id text PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  orig_customer text NOT NULL,
  orig_flower text NOT NULL,
  orig_note text NOT NULL,
  orig_is_deleted boolean NOT NULL,
  orig_delete_after_sheet_sync boolean NOT NULL,
  orig_delete_requested_by text,
  orig_delete_requested_at timestamptz,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.legacy_deleted_orders_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.legacy_deleted_orders_backup FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.legacy_deleted_orders_backup TO service_role;

CREATE OR REPLACE FUNCTION public.guard_queued_order_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_sync_cols text[] := array['ops_search_key','source_sheet','source_row','sheet_synced_at','needs_sheet_sync','sync_hash','synced_at','updated_at'];
  v_backfill_cols text[] := array['customer','flower','note','ops_search_key','is_deleted','deleted_at','deleted_by','deleted_by_role','deleted_reason','deleted_reason_code','source_sheet','source_row','sheet_synced_at','needs_sheet_sync','sync_hash','synced_at','updated_at'];
  v_restore_cols text[] := array['ops_search_key','is_deleted','delete_after_sheet_sync','restored_at','restored_by','source_sheet','source_row','sheet_synced_at','needs_sheet_sync','sync_hash','synced_at','updated_at'];
  v_rollback_cols text[] := array['customer','flower','note','ops_search_key','is_deleted','delete_after_sheet_sync','delete_requested_by','delete_requested_at','deleted_at','deleted_by','deleted_by_role','deleted_reason','deleted_reason_code','source_sheet','source_row','sheet_synced_at','needs_sheet_sync','sync_hash','synced_at','updated_at'];
  v_is_legacy_backfill boolean := false;
  v_is_admin_restore boolean := false;
  v_is_legacy_rollback boolean := false;
begin
  if new.delete_after_sheet_sync and not coalesce(old.delete_after_sheet_sync, false) and
     (new.settled or exists(select 1 from public.settlement_requests where order_id = new.id and status in ('PENDING','APPROVED'))) then
    raise exception 'DELETE_SETTLEMENT_CONFLICT: đơn đã khóa bởi tất toán';
  end if;

  if coalesce(old.delete_after_sheet_sync, false) then
    if (to_jsonb(new) - v_sync_cols) is not distinct from (to_jsonb(old) - v_sync_cols) then
      return new;
    end if;

    v_is_legacy_backfill :=
      coalesce(old.is_deleted, false) = false
      and new.delete_after_sheet_sync = true
      and new.is_deleted = true
      and new.deleted_reason_code = 'LEGACY_MIGRATION'
      and new.deleted_by_role = 'ADMIN'
      and nullif(trim(coalesce(new.deleted_by, '')), '') is not null
      and new.deleted_at is not null
      and new.customer is not distinct from trim(regexp_replace(old.customer, '^\[ĐÃ XÓA\]\s*', ''))
      and new.flower is not distinct from trim(regexp_replace(old.flower, '^\[ĐÃ XÓA\]\s*', ''))
      and new.note is not distinct from trim(regexp_replace(old.note, E'\\s*\\[ĐÃ XÓA TRÊN OPS\\]', '', 'g'))
      and (to_jsonb(new) - v_backfill_cols) is not distinct from (to_jsonb(old) - v_backfill_cols);

    if v_is_legacy_backfill then
      return new;
    end if;

    v_is_admin_restore :=
      new.delete_after_sheet_sync = false
      and coalesce(new.is_deleted, false) = false
      and new.restored_at is not null
      and nullif(trim(coalesce(new.restored_by, '')), '') is not null
      and exists (
        select 1
        from public.app_users u
        where lower(trim(u.username)) = lower(trim(new.restored_by))
          and u.active
          and u.role = 'ADMIN'
      )
      and (to_jsonb(new) - v_restore_cols) is not distinct from (to_jsonb(old) - v_restore_cols);

    if v_is_admin_restore then
      return new;
    end if;

    v_is_legacy_rollback :=
      coalesce(old.is_deleted, false) = true
      and old.deleted_reason_code = 'LEGACY_MIGRATION'
      and new.delete_after_sheet_sync = true
      and coalesce(new.is_deleted, false) = false
      and coalesce(new.deleted_reason_code, '') = ''
      and new.deleted_at is null
      and exists (
        select 1
        from public.legacy_deleted_orders_backup b
        where b.order_id = new.id
          and new.customer = b.orig_customer
          and new.flower = b.orig_flower
          and new.note = b.orig_note
      )
      and (to_jsonb(new) - v_rollback_cols) is not distinct from (to_jsonb(old) - v_rollback_cols);

    if v_is_legacy_rollback then
      return new;
    end if;

    raise exception 'ORDER_DELETING: đơn đang chờ xóa';
  end if;

  return new;
end
$function$;

DROP TRIGGER IF EXISTS trg_guard_queued_order_update ON public.orders;
CREATE TRIGGER trg_guard_queued_order_update
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_queued_order_update();
