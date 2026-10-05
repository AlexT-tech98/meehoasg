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

    if exists (
      select 1 from public.settlement_requests sr
      where sr.order_id = old.id and sr.status in ('PENDING','APPROVED')
    ) then
      new.ship_fee := old.ship_fee;
      new.ship_confirmed := old.ship_confirmed;
      new.ship_fee_updated_by := old.ship_fee_updated_by;
      new.ship_fee_updated_role := old.ship_fee_updated_role;
      new.ship_fee_updated_at := old.ship_fee_updated_at;
      return new;
    end if;

    if coalesce(new.ship_fee_updated_role,'') in ('ADMIN','THO_OPS')
       and nullif(trim(coalesce(new.ship_fee_updated_by,'')),'') is not null then
      new.ship_fee_updated_at := coalesce(new.ship_fee_updated_at, now());
      return new;
    end if;

    if coalesce(new.ship_fee_updated_role,'') = 'SALE'
       and nullif(trim(coalesce(new.ship_fee_updated_by,'')),'') is not null
       and exists (
         select 1
         from public.app_users u
         where u.username = new.ship_fee_updated_by
           and u.active = true
           and u.role = 'SALE'
           and (
             lower(trim(coalesce(old.sale,''))) = lower(trim(u.username))
             or lower(trim(coalesce(old.sale,''))) = lower(trim(u.display_name))
           )
       ) then
      new.ship_fee_updated_at := coalesce(new.ship_fee_updated_at, now());
      return new;
    end if;

    raise exception 'SHIP_FEE_OWNER_REQUIRED: Sale chỉ được cập nhật phí ship đơn của mình; THO_OPS/ADMIN được cập nhật đơn vận hành';
  end if;
  return new;
end;
$$;
