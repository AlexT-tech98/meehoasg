-- MEEHOA OPS V3.1 — Reconcile `guard_queued_order_update()` with 1-to-1 R2 <-> Supabase media URI switch/rollback.
-- Preserves all existing protections (`DELETE_SETTLEMENT_CONFLICT` and `ORDER_DELETING`) and all UI V3 permits
-- (`LEGACY_MIGRATION` backfill, `ADMIN` restore, `LEGACY_MIGRATION` rollback), while additionally permitting ONLY
-- exact 1-to-1 storage-backend URI rewrites (`supabase://<bucket>/<key>` <-> `r2://<r2_bucket>/<bucket>/<key>`)
-- on `image_urls` and/or `full_paid_bill_urls` when every object key, array order, and non-sync business column
-- remains identical (required for the 2 queued-delete orders among the 489 `orders.full_paid_bill_urls` bills).

CREATE OR REPLACE FUNCTION public.mee_canonical_media_keys(urls jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE
    WHEN jsonb_typeof(coalesce(urls, '[]'::jsonb)) <> 'array' THEN coalesce(urls, '[]'::jsonb)
    ELSE coalesce(
      (
        SELECT jsonb_agg(
          regexp_replace(
            regexp_replace(elem, '^supabase://', ''),
            '^r2://[a-z0-9-]+/',
            ''
          )
          ORDER BY ord
        )
        FROM jsonb_array_elements_text(coalesce(urls, '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
      ),
      '[]'::jsonb
    )
  END;
$$;

CREATE OR REPLACE FUNCTION public.guard_queued_order_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_sync_cols text[] := array['ops_search_key','source_sheet','source_row','sheet_synced_at','needs_sheet_sync','sync_hash','synced_at','updated_at'];
  v_media_cols text[] := array['image_urls','full_paid_bill_urls','ops_search_key','source_sheet','source_row','sheet_synced_at','needs_sheet_sync','sync_hash','synced_at','updated_at'];
  v_backfill_cols text[] := array['customer','flower','note','ops_search_key','is_deleted','deleted_at','deleted_by','deleted_by_role','deleted_reason','deleted_reason_code','source_sheet','source_row','sheet_synced_at','needs_sheet_sync','sync_hash','synced_at','updated_at'];
  v_restore_cols text[] := array['ops_search_key','is_deleted','delete_after_sheet_sync','restored_at','restored_by','source_sheet','source_row','sheet_synced_at','needs_sheet_sync','sync_hash','synced_at','updated_at'];
  v_rollback_cols text[] := array['customer','flower','note','ops_search_key','is_deleted','delete_after_sheet_sync','delete_requested_by','delete_requested_at','deleted_at','deleted_by','deleted_by_role','deleted_reason','deleted_reason_code','source_sheet','source_row','sheet_synced_at','needs_sheet_sync','sync_hash','synced_at','updated_at'];
  v_is_media_uri_rewrite boolean := false;
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

    v_is_media_uri_rewrite :=
      (to_jsonb(new) - v_media_cols) is not distinct from (to_jsonb(old) - v_media_cols)
      and public.mee_canonical_media_keys(new.image_urls) is not distinct from public.mee_canonical_media_keys(old.image_urls)
      and public.mee_canonical_media_keys(new.full_paid_bill_urls) is not distinct from public.mee_canonical_media_keys(old.full_paid_bill_urls);

    if v_is_media_uri_rewrite then
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
