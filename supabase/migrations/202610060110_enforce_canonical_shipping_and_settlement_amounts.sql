alter table public.orders add column if not exists ship_fee_updated_by text;
alter table public.orders add column if not exists ship_fee_updated_role text;
alter table public.orders add column if not exists ship_fee_updated_at timestamptz;

create or replace function public.guard_order_ship_fee_update()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE'
     and (new.ship_fee is distinct from old.ship_fee or new.ship_confirmed is distinct from old.ship_confirmed) then
    if new.synced_at is distinct from old.synced_at and new.synced_at is not null then
      return new;
    end if;
    if coalesce(new.ship_fee_updated_role,'') in ('ADMIN','THO_OPS')
       and nullif(trim(coalesce(new.ship_fee_updated_by,'')),'') is not null then
      new.ship_fee_updated_at := coalesce(new.ship_fee_updated_at, now());
      return new;
    end if;
    if exists (
      select 1 from public.settlement_requests sr
      where sr.order_id = old.id and sr.status = 'PENDING'
    ) then
      new.ship_fee := old.ship_fee;
      new.ship_confirmed := old.ship_confirmed;
      new.ship_fee_updated_by := old.ship_fee_updated_by;
      new.ship_fee_updated_role := old.ship_fee_updated_role;
      new.ship_fee_updated_at := old.ship_fee_updated_at;
      return new;
    end if;
    raise exception 'SHIP_FEE_ROLE_REQUIRED: chỉ THO_OPS hoặc ADMIN được cập nhật phí ship';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_order_ship_fee_update on public.orders;
create trigger trg_guard_order_ship_fee_update
before update of ship_fee, ship_confirmed on public.orders
for each row execute function public.guard_order_ship_fee_update();

create or replace function public.canonicalize_settlement_amounts()
returns trigger
language plpgsql
as $$
declare
  o public.orders%rowtype;
  accessory numeric := 0;
  ship numeric := 0;
begin
  select * into o from public.orders where id = new.order_id;
  if not found then
    raise exception 'ORDER_NOT_FOUND: không tìm thấy đơn để tất toán';
  end if;
  if lower(coalesce(o.shipping,'')) like '%shop%' then
    if not coalesce(o.ship_confirmed,false) then
      raise exception 'SHIP_FEE_REQUIRED: thợ cần nhập phí ship thực tế trước khi gửi tất toán';
    end if;
    ship := coalesce(o.ship_fee,0);
  end if;
  accessory :=
    (case when coalesce(o.card,false) then greatest(1,coalesce(o.card_qty,1))*10000 else 0 end)
    + (case when coalesce(o.banner,false) then 35000 else 0 end)
    + coalesce(o.charm_fee,0)
    + coalesce(o.paper_fee,0);
  new.flower_total := coalesce(o.flower_total,0);
  new.accessory_total := accessory;
  new.vat := coalesce(o.vat,0);
  new.ship_fee := ship;
  new.required_amount := coalesce(o.flower_total,0) + accessory + coalesce(o.vat,0) + ship;
  return new;
end;
$$;

drop trigger if exists trg_canonicalize_settlement_amounts on public.settlement_requests;
create trigger trg_canonicalize_settlement_amounts
before insert or update of order_id, flower_total, accessory_total, vat, ship_fee, required_amount
on public.settlement_requests
for each row execute function public.canonicalize_settlement_amounts();
