-- FINAL ORDER DELETION POLICY OVERRIDE — Legacy Deleted Orders Reversible Backfill Migration
-- DO NOT RUN ON PRODUCTION WITHOUT EXPLICIT OWNER GO-LIVE AUTHORIZATION.
-- OWNER APPROVED SCOPE (21 confirmed legacy deleted orders in Production: 2 unpaid, 17 deposit/flower-paid, 2 Full Paid):
--   1. Converts ALL orders with confirmed system deletion evidence (delete_after_sheet_sync, delete_requested_at/by,
--      [ĐÃ XÓA TRÊN OPS] note marker, or delete activity_log) to Trash (`is_deleted = true`), REGARDLESS of payment status.
--   2. NEVER auto-converts keyword-only `[ĐÃ XÓA]` text rows that lack confirmed system deletion evidence.
--   3. Preserves 100% of original data, images, bills, payment fields, `settled`, `full_paid`, `full_paid_total`, and
--      `settlement_requests` intact; stores pre-migration row state in `public.legacy_deleted_orders_backup` and full
--      JSON snapshot in `public.order_deletion_history`.
--   4. Does NOT alter `delete_after_sheet_sync` so already-excluded legacy orders never reappear or double-subtract revenue.
--   5. Fully idempotent (safe to re-run multiple times with zero duplicate history rows) & reversible via
--      `scripts/legacy-deleted-orders-rollback.sql`.

begin;

create table if not exists public.legacy_deleted_orders_backup (
  order_id text primary key references public.orders(id) on delete cascade,
  orig_customer text not null,
  orig_flower text not null,
  orig_note text not null,
  orig_is_deleted boolean not null,
  orig_delete_after_sheet_sync boolean not null,
  orig_delete_requested_by text,
  orig_delete_requested_at timestamptz,
  backed_up_at timestamptz not null default now()
);

alter table public.legacy_deleted_orders_backup enable row level security;
revoke all on public.legacy_deleted_orders_backup from anon, authenticated;
grant all on public.legacy_deleted_orders_backup to service_role;

with eligible as (
  select o.*
  from public.orders o
  where coalesce(o.is_deleted, false) = false
    and (
      coalesce(o.delete_after_sheet_sync, false) = true
      or o.delete_requested_at is not null
      or nullif(trim(coalesce(o.delete_requested_by, '')), '') is not null
      or coalesce(o.note, '') like '%[ĐÃ XÓA TRÊN OPS]%'
      or exists (
        select 1
        from public.activity_log al
        where al.order_id = o.id
          and (
            lower(coalesce(al.action, '')) like '%delete%'
            or lower(coalesce(al.action, '')) like '%xoa%'
            or coalesce(al.after_data->>'delete_after_sheet_sync', '') = 'true'
            or coalesce(al.after_data->>'note', '') like '%[ĐÃ XÓA TRÊN OPS]%'
          )
      )
    )
),
backed as (
  insert into public.legacy_deleted_orders_backup (
    order_id, orig_customer, orig_flower, orig_note,
    orig_is_deleted, orig_delete_after_sheet_sync,
    orig_delete_requested_by, orig_delete_requested_at
  )
  select
    id, customer, flower, note,
    is_deleted, delete_after_sheet_sync,
    delete_requested_by, delete_requested_at
  from eligible
  on conflict (order_id) do nothing
  returning order_id
),
updated as (
  update public.orders o
  set
    customer = trim(regexp_replace(o.customer, '^\[ĐÃ XÓA\]\s*', '')),
    flower = trim(regexp_replace(o.flower, '^\[ĐÃ XÓA\]\s*', '')),
    note = trim(regexp_replace(o.note, E'\\s*\\[ĐÃ XÓA TRÊN OPS\\]', '', 'g')),
    is_deleted = true,
    deleted_at = coalesce(o.delete_requested_at, o.updated_at, now()),
    deleted_by = coalesce(nullif(trim(o.delete_requested_by), ''), 'legacy-system'),
    deleted_by_role = 'ADMIN',
    deleted_reason_code = 'LEGACY_MIGRATION',
    deleted_reason = 'Chuyển đổi đơn đã xóa cũ sang Thùng rác (Final Deletion Policy Override)',
    updated_at = now()
  from eligible e
  where o.id = e.id
  returning o.id, o.deleted_by, o.deleted_at, to_jsonb(e) as orig_snapshot
)
insert into public.order_deletion_history (
  order_id, event_type, actor_username, actor_name, actor_role, reason_code, reason_text, occurred_at, order_snapshot
)
select
  u.id,
  'DELETE',
  u.deleted_by,
  u.deleted_by,
  'ADMIN',
  'LEGACY_MIGRATION',
  'Chuyển đổi đơn đã xóa cũ sang Thùng rác (Final Deletion Policy Override)',
  u.deleted_at,
  u.orig_snapshot
from updated u
where not exists (
  select 1
  from public.order_deletion_history h
  where h.order_id = u.id
    and h.reason_code = 'LEGACY_MIGRATION'
);

commit;
