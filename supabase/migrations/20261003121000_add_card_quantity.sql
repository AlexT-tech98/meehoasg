alter table public.orders add column if not exists card_qty integer not null default 0;

update public.orders
set card_qty = case when card then greatest(card_qty, 1) else 0 end;

alter table public.orders drop constraint if exists orders_card_qty_check;
alter table public.orders add constraint orders_card_qty_check check (card_qty between 0 and 99);

create or replace function public.normalize_order_card_qty()
returns trigger language plpgsql as $$
begin
  if coalesce(new.card,false) = false then
    new.card_qty := 0;
  elsif coalesce(new.card_qty,0) < 1 then
    new.card_qty := 1;
  end if;
  return new;
end $$;

drop trigger if exists trg_normalize_order_card_qty on public.orders;
create trigger trg_normalize_order_card_qty
before insert or update of card, card_qty on public.orders
for each row execute function public.normalize_order_card_qty();

create index if not exists idx_orders_card_qty_nonzero on public.orders(card_qty) where card_qty > 0;
comment on column public.orders.card_qty is 'Number of greeting cards; each card is 10,000 VND. Zero when card=false.';
