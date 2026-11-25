-- TC-14 / POLICY-04 Legacy Deleted Orders Reversible Backfill Script
-- DO NOT RUN ON PRODUCTION WITHOUT EXPLICIT OWNER APPROVAL & DRY-RUN REVIEW.
-- STRICT GUARD (POLICY-04):
--   1. NEVER auto-converts orders matching only the [ĐÃ XÓA] text keyword without system deletion evidence.
--   2. NEVER auto-converts orders with settled=true, full_paid=true, locked settlement requests, or recorded payment > 0.
--   3. Idempotent & reversible via scripts/legacy-deleted-orders-rollback.sql.

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
  where o.is_deleted = false
    and (
      o.delete_after_sheet_sync = true
      or o.delete_requested_at is not null
      or nullif(trim(coalesce(o.delete_requested_by, '')), '') is not null
      or o.note like '%[ĐÃ XÓA TRÊN OPS]%'
      or exists (
        select 1
        from public.activity_log al
        where al.order_id = o.id
          and (
            lower(coalesce(al.action, '')) like '%delete%'
            or coalesce(al.after_data->>'delete_after_sheet_sync', '') = 'true'
          )
      )
    )
    and o.settled = false
    and o.full_paid = false
    and public.mee_ops_paid(o) <= 0
    and not exists (
      select 1
      from public.settlement_requests sr
      where sr.order_id = o.id
        and sr.status in ('PENDING', 'APPROVED')
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
    deleted_reason = 'Chuyển đổi từ đơn xóa cũ đã xác minh lịch sử xóa (POLICY-04)',
    updated_at = now()
  from eligible e
  where o.id = e.id
  returning o.id, o.deleted_by, o.deleted_at
)
insert into public.order_deletion_history (
  order_id, event_type, actor_username, actor_name, actor_role, reason_code, reason_text, occurred_at
)
select
  u.id,
  'DELETE',
  u.deleted_by,
  u.deleted_by,
  'ADMIN',
  'LEGACY_MIGRATION',
  'Chuyển đổi từ đơn xóa cũ đã xác minh lịch sử xóa (POLICY-04)',
  u.deleted_at
from updated u;

commit;
