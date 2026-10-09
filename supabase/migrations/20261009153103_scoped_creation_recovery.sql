-- One service-only read operation checks session, active account and request scope.
create or replace function public.mee_create_status(p_token_hash text,p_request_id text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.app_users; o public.orders; r public.operation_receipts; old_row jsonb;
begin
 if coalesce(p_token_hash,'') !~ '^[0-9a-f]{64}$' or length(coalesce(p_request_id,'')) not between 1 and 128 then
   return jsonb_build_object('ok',false,'found',false,'code','AUTH_REQUIRED');
 end if;
 select a.* into u from public.app_sessions s join public.app_users a on a.username=s.username
   where s.token_hash=p_token_hash and s.expires_at>clock_timestamp() and a.active for share of a;
 if not found then return jsonb_build_object('ok',false,'found',false,'code','AUTH_REQUIRED'); end if;
 select * into r from public.operation_receipts where request_id=p_request_id and action='createOrder'
   and (actor=u.username or u.role='ADMIN') order by created_at desc limit 1;
 if found then
   select * into o from public.orders where id=r.result->>'orderId';
   if not found then
     old_row:=r.result->'row';
     return jsonb_build_object('ok',true,'found',true,'archived',exists(select 1 from public.deleted_orders where id=r.result->>'orderId'),
       'order',jsonb_build_object('id',r.result->>'orderId','customer',old_row->>'customer','order_date',old_row->>'order_date',
       'order_time',old_row->>'order_time','sale',old_row->>'sale','created_at',old_row->>'created_at'));
   end if;
 else
   select * into o from public.orders where request_id=p_request_id;
   if not found then return jsonb_build_object('ok',true,'found',false,'order',null); end if;
   -- Historical requests have no receipt: require creator audit, not assigned Sale.
   if u.role<>'ADMIN' and not exists(select 1 from public.activity_log where order_id=o.id
       and username=u.username and action in ('createOrder','CREATE_ORDER')) then
     return jsonb_build_object('ok',false,'found',false,'code','NOT_OWNER','message','Không có quyền kiểm tra yêu cầu này.');
   end if;
 end if;
 return jsonb_build_object('ok',true,'found',true,'order',jsonb_build_object('id',o.id,'customer',o.customer,
   'order_date',o.order_date,'order_time',o.order_time,'sale',o.sale,'created_at',o.created_at));
end $$;
revoke all on function public.mee_create_status(text,text) from public,anon,authenticated;
grant execute on function public.mee_create_status(text,text) to service_role;
