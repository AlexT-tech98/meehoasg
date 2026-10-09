-- Baseline previously deployed outside the repository, preserved in source.
-- No UPDATE/DELETE of operational rows occurs while applying this migration.
alter table public.orders
 add column if not exists needs_sheet_sync boolean not null default false,
 add column if not exists sheet_synced_at timestamptz,
 add column if not exists delete_after_sheet_sync boolean not null default false,
 add column if not exists delete_requested_by text,
 add column if not exists delete_requested_at timestamptz;
create table if not exists public.deleted_orders (
 id text primary key, snapshot jsonb not null, deleted_by text, deleted_at timestamptz not null default now()
);
alter table public.deleted_orders enable row level security;
revoke all on public.deleted_orders from public,anon,authenticated;
grant all on public.deleted_orders to service_role;
CREATE OR REPLACE FUNCTION public.mark_order_sheet_sync_state()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if tg_op = 'INSERT' then
    if new.synced_at is not null and new.source_sheet is not null then
      new.needs_sheet_sync := false;
      new.sheet_synced_at := coalesce(new.sheet_synced_at, new.synced_at, now());
    else
      new.needs_sheet_sync := true;
    end if;
    return new;
  end if;

  -- A Sheet-origin import updates synced_at. It is already present in Sheet,
  -- so do not echo it back through the writeback queue.
  if new.synced_at is distinct from old.synced_at and new.synced_at is not null then
    new.needs_sheet_sync := false;
    new.sheet_synced_at := coalesce(new.sheet_synced_at, new.synced_at, now());
    return new;
  end if;

  -- Only business fields that are represented by the legacy Sheet/meta shadow
  -- should dirty the writeback queue. Row-cache bookkeeping must not re-dirty it.
  if (
    to_jsonb(new) - array['source_sheet','source_row','sheet_synced_at','needs_sheet_sync','sync_hash','synced_at','updated_at','created_at','request_id']
  ) is distinct from (
    to_jsonb(old) - array['source_sheet','source_row','sheet_synced_at','needs_sheet_sync','sync_hash','synced_at','updated_at','created_at','request_id']
  ) then
    new.needs_sheet_sync := true;
  end if;
  return new;
end;
$function$
;
create or replace function public.guard_queued_order_update()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if new.delete_after_sheet_sync and not coalesce(old.delete_after_sheet_sync,false) and
   (new.settled or exists(select 1 from public.settlement_requests where order_id=new.id and status in ('PENDING','APPROVED'))) then
   raise exception 'DELETE_SETTLEMENT_CONFLICT: đơn đã khóa bởi tất toán';
 end if;
 if old.delete_after_sheet_sync and
   (to_jsonb(new)-array['source_sheet','source_row','sheet_synced_at','needs_sheet_sync','sync_hash','synced_at','updated_at'])
   is distinct from
   (to_jsonb(old)-array['source_sheet','source_row','sheet_synced_at','needs_sheet_sync','sync_hash','synced_at','updated_at']) then
   raise exception 'ORDER_DELETING: đơn đang chờ xóa';
 end if;
 return new;
end $$;
create or replace function public.guard_settlement_against_delete()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare queued boolean;
begin
 if new.status in ('PENDING','APPROVED') then
   select delete_after_sheet_sync into queued from public.orders where id=new.order_id for update;
   if queued then raise exception 'ORDER_DELETING: đơn đang chờ xóa'; end if;
 end if;
 return new;
end $$;
DO $$ BEGIN IF NOT EXISTS(select 1 from pg_trigger where tgrelid='public.orders'::regclass and tgname='trg_orders_sheet_sync_state') THEN
 create trigger trg_orders_sheet_sync_state before insert or update on public.orders for each row execute function public.mark_order_sheet_sync_state();
 END IF; END $$;
DO $$ BEGIN IF NOT EXISTS(select 1 from pg_trigger where tgrelid='public.orders'::regclass and tgname='trg_guard_queued_order_update') THEN
 create trigger trg_guard_queued_order_update before update on public.orders for each row execute function public.guard_queued_order_update();
 END IF; END $$;
DO $$ BEGIN IF NOT EXISTS(select 1 from pg_trigger where tgrelid='public.settlement_requests'::regclass and tgname='trg_guard_settlement_against_delete') THEN
 create trigger trg_guard_settlement_against_delete before insert or update on public.settlement_requests for each row execute function public.guard_settlement_against_delete();
 END IF; END $$;

revoke all on function public.mark_order_sheet_sync_state(),public.guard_queued_order_update(),public.guard_settlement_against_delete() from public,anon,authenticated;
grant execute on function public.mark_order_sheet_sync_state(),public.guard_queued_order_update(),public.guard_settlement_against_delete() to service_role;
