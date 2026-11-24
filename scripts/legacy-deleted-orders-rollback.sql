-- TC-14 Rollback Script for Legacy [ĐÃ XÓA] Backfill
-- Restores exact original columns from public.legacy_deleted_orders_backup.

begin;

update public.orders o
set
  customer = b.orig_customer,
  flower = b.orig_flower,
  note = b.orig_note,
  is_deleted = b.orig_is_deleted,
  delete_after_sheet_sync = b.orig_delete_after_sheet_sync,
  delete_requested_by = b.orig_delete_requested_by,
  delete_requested_at = b.orig_delete_requested_at,
  deleted_at = null,
  deleted_by = null,
  deleted_by_role = null,
  deleted_reason = null,
  deleted_reason_code = null,
  updated_at = now()
from public.legacy_deleted_orders_backup b
where o.id = b.order_id;

delete from public.order_deletion_history h
using public.legacy_deleted_orders_backup b
where h.order_id = b.order_id
  and h.reason_code = 'LEGACY_MIGRATION';

delete from public.legacy_deleted_orders_backup;

commit;
