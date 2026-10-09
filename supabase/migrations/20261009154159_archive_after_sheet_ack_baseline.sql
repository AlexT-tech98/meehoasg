-- Existing production archive baseline. Definitions only: no rows are deleted by applying this migration.
CREATE OR REPLACE FUNCTION public.archive_order_after_sheet_delete_ack()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if new.delete_after_sheet_sync = true and new.needs_sheet_sync = false
     and (old.needs_sheet_sync is distinct from new.needs_sheet_sync) then
    insert into public.deleted_orders(id,snapshot,deleted_by,deleted_at)
    values(new.id,to_jsonb(new),new.delete_requested_by,now())
    on conflict(id) do update set snapshot=excluded.snapshot,deleted_by=excluded.deleted_by,deleted_at=excluded.deleted_at;
    delete from public.orders where id=new.id;
  end if;
  return null;
end;
$function$
;
DO $$ BEGIN IF NOT EXISTS(select 1 from pg_trigger where tgrelid='public.orders'::regclass and tgname='trg_archive_order_after_sheet_delete_ack') THEN
 create trigger trg_archive_order_after_sheet_delete_ack after update on public.orders for each row execute function public.archive_order_after_sheet_delete_ack();
END IF; END $$;
revoke all on function public.archive_order_after_sheet_delete_ack() from public,anon,authenticated;
grant execute on function public.archive_order_after_sheet_delete_ack() to service_role;
