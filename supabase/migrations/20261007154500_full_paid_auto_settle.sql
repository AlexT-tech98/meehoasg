alter table public.orders
  add column if not exists full_paid boolean not null default false,
  add column if not exists full_paid_total numeric not null default 0,
  add column if not exists full_paid_bill_urls jsonb not null default '[]'::jsonb,
  add column if not exists full_paid_by text,
  add column if not exists full_paid_at timestamptz,
  add column if not exists full_paid_invalidated_at timestamptz,
  add column if not exists full_paid_invalidated_reason text not null default '';

create index if not exists idx_orders_full_paid_order_date
  on public.orders(full_paid, order_date);

alter table public.orders
  drop constraint if exists orders_full_paid_has_bill;

alter table public.orders
  add constraint orders_full_paid_has_bill
  check (
    not full_paid
    or (
      jsonb_typeof(full_paid_bill_urls) = 'array'
      and jsonb_array_length(full_paid_bill_urls) > 0
      and full_paid_total >= 0
    )
  );

create or replace function public.guard_full_paid_after_financial_change()
returns trigger
language plpgsql
as $$
declare
  new_total numeric;
begin
  if old.full_paid
     and new.full_paid
     and (
       new.flower_total is distinct from old.flower_total
       or new.shipping is distinct from old.shipping
       or new.ship_fee is distinct from old.ship_fee
       or new.ship_confirmed is distinct from old.ship_confirmed
       or new.card is distinct from old.card
       or new.card_qty is distinct from old.card_qty
       or new.banner is distinct from old.banner
       or new.charm_fee is distinct from old.charm_fee
       or new.paper_fee is distinct from old.paper_fee
       or new.vat is distinct from old.vat
     )
  then
    new_total :=
      coalesce(new.flower_total,0)
      + case when coalesce(new.card,false) then greatest(coalesce(new.card_qty,1),1) * 10000 else 0 end
      + case when coalesce(new.banner,false) then 35000 else 0 end
      + coalesce(new.charm_fee,0)
      + coalesce(new.paper_fee,0)
      + coalesce(new.vat,0)
      + case
          when lower(coalesce(new.shipping,'')) like '%shop%'
               and coalesce(new.ship_confirmed,false)
          then coalesce(new.ship_fee,0)
          else 0
        end;

    if new_total > coalesce(old.full_paid_total,0) then
      new.full_paid := false;
      new.full_paid_invalidated_at := now();
      new.full_paid_invalidated_reason := 'ORDER_TOTAL_INCREASED';
      new.payment := 'Đã thanh toán ' || trim(to_char(coalesce(old.full_paid_total,0), 'FM999999999990')) || ' đ';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_full_paid_after_financial_change on public.orders;
create trigger trg_guard_full_paid_after_financial_change
before update on public.orders
for each row
execute function public.guard_full_paid_after_financial_change();
