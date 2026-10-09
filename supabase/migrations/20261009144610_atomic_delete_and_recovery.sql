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
CREATE OR REPLACE FUNCTION public.archive_order_after_sheet_delete_ack()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if new.delete_after_sheet_sync = true and new.needs_sheet_sync = false
     and (old.needs_sheet_sync is distinct from new.needs_sheet_sync) then
    if new.settled or exists(select 1 from public.settlement_requests where order_id=new.id and status in ('PENDING','APPROVED')) then
      raise exception 'DELETE_SETTLEMENT_CONFLICT: không lưu trữ đơn đang tất toán';
    end if;
    insert into public.deleted_orders(id,snapshot,deleted_by,deleted_at)
    values(new.id,to_jsonb(new),new.delete_requested_by,now())
    on conflict(id) do update set snapshot=excluded.snapshot,deleted_by=excluded.deleted_by,deleted_at=excluded.deleted_at;
    delete from public.orders where id=new.id;
  end if;
  return null;
end;
$function$
;

create or replace function public.guard_queued_order_update()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
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
drop trigger if exists trg_orders_sheet_sync_state on public.orders;
create trigger trg_orders_sheet_sync_state before insert or update on public.orders for each row execute function public.mark_order_sheet_sync_state();
drop trigger if exists trg_archive_order_after_sheet_delete_ack on public.orders;
create trigger trg_archive_order_after_sheet_delete_ack after update on public.orders for each row execute function public.archive_order_after_sheet_delete_ack();
drop trigger if exists trg_guard_queued_order_update on public.orders;
create trigger trg_guard_queued_order_update before update on public.orders for each row execute function public.guard_queued_order_update();
drop trigger if exists trg_guard_settlement_against_delete on public.settlement_requests;
create trigger trg_guard_settlement_against_delete before insert or update on public.settlement_requests for each row execute function public.guard_settlement_against_delete();

CREATE OR REPLACE FUNCTION public.mee_ops_mutate(p_actor text, p_request_id text, p_action text, p_fingerprint text, p_input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
 u public.app_users; o public.orders; n public.orders; req public.settlement_requests;
 r jsonb; prior jsonb; v_id text; v_now timestamptz; v_total numeric;
 v_full boolean; v_new_bills jsonb; v_bills jsonb; v_images jsonb; v_decision text;
 v_count integer; v_ship numeric; v_status text; v_sale text; v_expected timestamptz;
begin
 select * into u from public.app_users where username=p_actor and active for share;
 if not found then return jsonb_build_object('ok',false,'code','AUTH_REQUIRED','message','Tài khoản đã bị khóa.'); end if;
 if length(coalesce(p_request_id,'')) not between 1 and 128 or length(coalesce(p_fingerprint,''))<>64 then
   return jsonb_build_object('ok',false,'code','REQUEST_ID_REQUIRED','message','Thiếu mã yêu cầu hợp lệ.');
 end if;
 if p_action='deleteOrder' and u.role<>'ADMIN' then
   return jsonb_build_object('ok',false,'code','NOT_OWNER','message','Chỉ Admin được xóa đơn.');
 end if;
 -- Serializes retries for the same actor/key, including different actions.
 perform pg_advisory_xact_lock(hashtextextended(p_actor||':'||p_request_id,0));
 prior := public.mee_ops_lookup(p_actor,p_request_id,p_action,p_fingerprint);
 if prior is not null then return prior; end if;
 if p_action not in ('createOrder','updateOrder','saveShipFee','submitSettlement','reviewSettlement','updateStatus','deleteOrder') then
   return jsonb_build_object('ok',false,'code','ACTION_INVALID','message','Thao tác không được hỗ trợ.');
 end if;
 v_id:=nullif(trim(p_input->>'orderId'),'');
 if p_action='reviewSettlement' then
   if u.role<>'ADMIN' then return jsonb_build_object('ok',false,'code','NOT_OWNER','message','Không có quyền duyệt tất toán.'); end if;
   select * into req from public.settlement_requests where id=p_input->>'settlementId';
   if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND','message','Không tìm thấy yêu cầu.'); end if;
   v_id:=req.order_id;
 end if;
 if p_action<>'createOrder' then
   -- Shared order lock also serializes edits, shipping, submission and review.
   select * into o from public.orders where id=v_id for update;
   if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND','message','Không tìm thấy đơn.'); end if;
   if o.delete_after_sheet_sync then
     if p_action='deleteOrder' then
       return jsonb_build_object('ok',true,'idempotent',true,'orderId',o.id,'message','Đơn đã được xếp hàng xóa, đang chờ Sheet xác nhận.');
     end if;
     return jsonb_build_object('ok',false,'code','ORDER_DELETING','message','Đơn đang chờ xóa; không thể sửa hoặc tất toán.');
   end if;
   if p_action in ('updateOrder','saveShipFee','submitSettlement') and u.role='SALE' and not public.mee_ops_owner(o.sale,u) then
     return jsonb_build_object('ok',false,'code','NOT_OWNER','message','Sale chỉ được cập nhật đơn do mình phụ trách.');
   end if;
   if p_action in ('updateOrder','saveShipFee','updateStatus','deleteOrder') and
      (o.settled or exists(select 1 from public.settlement_requests where order_id=o.id and status in ('PENDING','APPROVED'))) then
     return jsonb_build_object('ok',false,'code','ORDER_LOCKED','message','Đơn đã khóa bởi yêu cầu tất toán.');
   end if;
   if p_action in ('updateOrder','saveShipFee','updateStatus','submitSettlement','deleteOrder') then
     if nullif(p_input->>'expectedUpdatedAt','') is null then
       return jsonb_build_object('ok',false,'code','VERSION_REQUIRED','message','Tải lại chi tiết đơn trước khi lưu.');
     end if;
     begin v_expected:=(p_input->>'expectedUpdatedAt')::timestamptz;
     exception when others then return jsonb_build_object('ok',false,'code','VERSION_REQUIRED','message','Phiên bản đơn không hợp lệ.'); end;
     if o.updated_at is distinct from v_expected then
       return jsonb_build_object('ok',false,'code','ORDER_CONFLICT','message','Đơn vừa được người khác cập nhật. Tải lại chi tiết để đối chiếu trước khi lưu.');
     end if;
   end if;
 end if;
 -- PostgreSQL precision is retained in responses and compared as timestamptz.
 v_now:=clock_timestamp();
 if o.updated_at is not null and v_now<=o.updated_at then v_now:=o.updated_at+interval '1 microsecond'; end if;
 if p_action='deleteOrder' then
   -- Keep the existing Sheet marker and archive-after-ACK business flow.
   -- The same locked row serializes this action with edits and settlement.
   update public.orders set
     customer='[ĐÃ XÓA] '||regexp_replace(o.customer,'^\[ĐÃ XÓA\]\s*',''),
     flower='[ĐÃ XÓA] '||regexp_replace(o.flower,'^\[ĐÃ XÓA\]\s*',''),
     note=concat_ws(E'\n',nullif(trim(o.note),''),'[ĐÃ XÓA TRÊN OPS] '||coalesce(u.display_name,u.username)||' · '||v_now::text),
     delete_after_sheet_sync=true,delete_requested_by=u.username,delete_requested_at=v_now,
     needs_sheet_sync=true,updated_at=v_now
     where id=o.id returning * into n;
   r:=jsonb_build_object('ok',true,'orderId',o.id,'row',to_jsonb(n),
     'message','Đã gửi yêu cầu xóa. Đơn sẽ được gỡ khỏi OPS sau khi Sheet nhận dấu xóa.');
 elsif p_action in ('createOrder','updateOrder') then
   n:=jsonb_populate_record(null::public.orders,p_input->'order');
   if nullif(trim(n.customer),'') is null or nullif(trim(n.flower),'') is null or n.order_date is null
      or n.order_time is null or n.order_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      or n.shipping is null or n.shipping not in ('Shop book ship','Khách tự book','Ghé lấy')
      or n.flower_total is null or n.flower_total<0 or n.flower_total>999999999999
      or n.card is null or n.banner is null or n.ship_confirmed is null
      or (n.card and n.card_qty is null)
      or n.charm_fee>999999999999 or n.paper_fee>999999999999 or n.vat>999999999999 or n.ship_fee>999999999999
      or n.charm_fee<0 or n.paper_fee<0 or n.vat<0 or n.ship_fee<0
      or n.charm_fee is null or n.paper_fee is null or n.vat is null or n.ship_fee is null
      or (n.card and (n.card_qty not between 1 and 99 or nullif(trim(n.card_text),'') is null))
      or (n.banner and nullif(trim(n.banner_text),'') is null) then
     return jsonb_build_object('ok',false,'code','ORDER_INPUT_INVALID','message','Thông tin đơn, thời gian hoặc số tiền không hợp lệ.');
   end if;
   v_sale:=case when u.role='SALE' then u.username else n.sale end;
   select username into v_sale from public.app_users where active and
     (lower(trim(username))=lower(trim(v_sale)) or lower(trim(display_name))=lower(trim(v_sale)))
     order by (lower(trim(username))=lower(trim(v_sale))) desc limit 1;
   if v_sale is null then return jsonb_build_object('ok',false,'code','SALE_REQUIRED','message','Cần chọn người phụ trách hợp lệ.'); end if;
   if p_action='createOrder' then
     -- An old pre-migration request ID is never replayed as an edit.
     if exists(select 1 from public.orders where request_id=p_request_id) then
       return jsonb_build_object('ok',false,'code','LEGACY_REQUEST_EXISTS','message','Mã yêu cầu đã có đơn từ phiên bản trước. Kiểm tra danh sách đơn trước khi tạo tiếp.');
     end if;
     v_id:=p_input->>'newOrderId';
   end if;
   v_images:=coalesce(n.image_urls,'[]'::jsonb);v_new_bills:=coalesce(p_input->'newBillUrls','[]'::jsonb);
   v_bills:=case when p_action='updateOrder' then coalesce(o.full_paid_bill_urls,'[]'::jsonb) else '[]'::jsonb end;
   v_bills:=v_bills||v_new_bills;
   if jsonb_typeof(v_images)<>'array' or jsonb_typeof(v_bills)<>'array' then
     return jsonb_build_object('ok',false,'code','IMAGE_INVALID','message','Danh sách ảnh không hợp lệ.');
   end if;
   -- Retained private images must belong to this order. New objects are supplied
   -- only by the Edge Function after upload, never accepted from client billUrls.
   if p_action='updateOrder' and exists(
     select 1 from jsonb_array_elements_text(v_images) x where not coalesce(o.image_urls,'[]'::jsonb) ? x
       and not coalesce(p_input->'newImageUrls','[]'::jsonb) ? x) then
     return jsonb_build_object('ok',false,'code','IMAGE_INVALID','message','Ảnh không thuộc đơn này.');
   end if;
   if n.shipping<>'Shop book ship' then n.ship_fee:=0;n.ship_confirmed:=false; end if;
   v_total:=public.mee_ops_total(n);v_full:=coalesce((p_input->>'fullPaidRequested')::boolean,false);
   if v_full and (jsonb_array_length(v_images)=0 or jsonb_array_length(v_bills)=0 or
      (n.shipping='Shop book ship' and not n.ship_confirmed)) then
     return jsonb_build_object('ok',false,'code','FULL_PAID_EVIDENCE_REQUIRED','message','Full Paid cần ảnh mẫu, bill và phí ship đã xác nhận.');
   end if;
   if v_full and p_action='updateOrder' and not o.full_paid and jsonb_array_length(v_new_bills)=0 then
     return jsonb_build_object('ok',false,'code','FULL_PAID_EVIDENCE_REQUIRED','message','Bật Full Paid cần ảnh bill mới.');
   end if;
   if v_full and p_action='updateOrder' and o.full_paid and v_total>o.full_paid_total and jsonb_array_length(v_new_bills)=0 then
     v_full:=false;n.payment:='Đã thanh toán '||o.full_paid_total::text||' đ';
   end if;
   if p_action='createOrder' then
     insert into public.orders(id,request_id,customer,phone,order_date,order_time,flower,note,shipping,address,flower_total,payment,sale,status,
       card,card_qty,card_text,banner,banner_text,charm_fee,charm_text,paper_fee,paper_text,vat,image_urls,
       ship_fee,ship_confirmed,ship_fee_updated_by,ship_fee_updated_role,ship_fee_updated_at,updated_at)
     values(v_id,p_request_id,n.customer,n.phone,n.order_date,n.order_time,n.flower,n.note,n.shipping,n.address,n.flower_total,n.payment,v_sale,'Chờ bó',
       n.card,case when n.card then n.card_qty else 0 end,n.card_text,n.banner,n.banner_text,n.charm_fee,n.charm_text,n.paper_fee,n.paper_text,n.vat,v_images,
       n.ship_fee,n.ship_confirmed,u.username,u.role,v_now,v_now);
   else
     -- No observer can see the temporary full_paid=false between these writes:
     -- both are inside this RPC's transaction, along with audit and receipt.
     update public.orders set customer=n.customer,phone=n.phone,order_date=n.order_date,order_time=n.order_time,flower=n.flower,note=n.note,
       shipping=n.shipping,address=n.address,flower_total=n.flower_total,payment=n.payment,sale=v_sale,
       card=n.card,card_qty=case when n.card then n.card_qty else 0 end,card_text=n.card_text,banner=n.banner,banner_text=n.banner_text,
       charm_fee=n.charm_fee,charm_text=n.charm_text,paper_fee=n.paper_fee,paper_text=n.paper_text,vat=n.vat,image_urls=v_images,
       ship_fee=n.ship_fee,ship_confirmed=n.ship_confirmed,ship_fee_updated_by=u.username,ship_fee_updated_role=u.role,ship_fee_updated_at=v_now,
       full_paid=false,
       full_paid_invalidated_at=case when o.full_paid and not v_full then v_now else o.full_paid_invalidated_at end,
       full_paid_invalidated_reason=case when o.full_paid and not v_full then case when v_total>o.full_paid_total then 'ORDER_TOTAL_INCREASED' else 'PAYMENT_STATUS_CHANGED' end else o.full_paid_invalidated_reason end,
       updated_at=v_now where id=v_id;
   end if;
   if v_full then
     update public.orders set full_paid=true,full_paid_total=case when p_action='updateOrder' and o.full_paid and jsonb_array_length(v_new_bills)=0 then o.full_paid_total else v_total end,
       full_paid_bill_urls=v_bills,full_paid_by=u.username,full_paid_at=v_now,full_paid_invalidated_at=null,full_paid_invalidated_reason='',
       payment='Đã thanh toán toàn bộ đơn',updated_at=v_now where id=v_id;
   end if;
   select * into n from public.orders where id=v_id;
   r:=jsonb_build_object('ok',true,'orderId',v_id,'row',to_jsonb(n),'fullPaidApplied',n.full_paid,'imageRetentionApplied',true,
     'fullPaidInvalidated',coalesce(o.full_paid,false) and not n.full_paid,
     'message',case when o.full_paid and not n.full_paid and v_total>o.full_paid_total then 'Đã lưu. Tổng đơn tăng, Full Paid được gỡ và giữ nguyên số tiền đã thu.' when p_action='createOrder' then 'Đã tạo đơn.' else 'Đã lưu thay đổi.' end);
 elsif p_action='saveShipFee' then
   if u.role not in ('ADMIN','THO_OPS','SALE') or lower(o.shipping) not like '%shop%' then
     return jsonb_build_object('ok',false,'code','SHIP_INVALID','message','Chỉ nhập phí ship cho đơn Shop book ship.');
   end if;
   v_ship:=(p_input->>'shipFee')::numeric;
   if v_ship is null or v_ship<0 or v_ship>999999999999 then return jsonb_build_object('ok',false,'code','SHIP_INVALID','message','Phí ship không hợp lệ.'); end if;
   update public.orders set ship_fee=v_ship,ship_confirmed=true,ship_fee_updated_by=u.username,ship_fee_updated_role=u.role,ship_fee_updated_at=v_now,updated_at=v_now where id=o.id returning * into n;
   r:=jsonb_build_object('ok',true,'orderId',o.id,'row',to_jsonb(n),'shipFee',n.ship_fee,'shipConfirmed',n.ship_confirmed,'message','Đã cập nhật phí ship.');
 elsif p_action='updateStatus' then
   if u.role not in ('ADMIN','THO_OPS') then return jsonb_build_object('ok',false,'code','NOT_OWNER','message','Không có quyền cập nhật sản xuất.'); end if;
   v_status:=p_input->>'status';
   if v_status is null or v_status not in ('Chờ bó','Đã bó','Đã giao') or abs(array_position(array['Chờ bó','Đã bó','Đã giao'],v_status)-array_position(array['Chờ bó','Đã bó','Đã giao'],o.status))<>1 then
     return jsonb_build_object('ok',false,'code','STATUS_INVALID','message','Chỉ được chuyển trạng thái từng bước.'); end if;
   update public.orders set status=v_status,updated_at=v_now where id=o.id returning * into n;
   r:=jsonb_build_object('ok',true,'orderId',o.id,'row',to_jsonb(n),'status',v_status);
 elsif p_action='submitSettlement' then
   if u.role not in ('ADMIN','SALE') or o.settled or o.full_paid or o.status<>'Đã giao' then
     return jsonb_build_object('ok',false,'code','SETTLEMENT_INVALID','message','Đơn chưa thể gửi tất toán hoặc bạn không có quyền.'); end if;
   if exists(select 1 from public.settlement_requests where order_id=o.id and status in ('PENDING','APPROVED')) then
     return jsonb_build_object('ok',false,'code','SETTLEMENT_EXISTS','message','Đơn đã có yêu cầu tất toán.'); end if;
   if lower(o.shipping) like '%shop%' and not o.ship_confirmed then return jsonb_build_object('ok',false,'code','SHIP_FEE_REQUIRED','message','Cần nhập phí ship thực tế trước khi gửi tất toán.'); end if;
   v_bills:=coalesce(p_input->'newBillUrls','[]'::jsonb);
   if jsonb_typeof(v_bills)<>'array' or jsonb_array_length(v_bills)=0 then return jsonb_build_object('ok',false,'code','BILL_REQUIRED','message','Cần ít nhất một ảnh bill.'); end if;
   v_total:=public.mee_ops_total(o);v_ship:=case when lower(o.shipping) like '%shop%' then o.ship_fee else 0 end;
   insert into public.settlement_requests(id,order_id,sale_username,sale_name,flower_total,accessory_total,vat,ship_fee,required_amount,bill_urls,note,status)
   values(p_input->>'newSettlementId',o.id,u.username,u.display_name,o.flower_total,v_total-o.flower_total-o.vat-v_ship,o.vat,v_ship,v_total,v_bills,coalesce(p_input->>'note',''),'PENDING') returning * into req;
   update public.orders set updated_at=v_now where id=o.id returning * into n;
   r:=jsonb_build_object('ok',true,'orderId',o.id,'row',to_jsonb(n),'requestId',req.id,'requiredAmount',req.required_amount,'settlementStatus','PENDING','message','Đã gửi tất toán.');
 elsif p_action='reviewSettlement' then
   -- Order first, then requests: same lock order for all finance operations.
   select * into req from public.settlement_requests where id=p_input->>'settlementId' for update;
   v_decision:=p_input->>'decision';
   if v_decision is null or v_decision not in ('APPROVED','REJECTED') then return jsonb_build_object('ok',false,'code','DECISION_INVALID','message','Quyết định không hợp lệ.'); end if;
   if req.status=v_decision then
     if v_decision='APPROVED' and not o.settled then
       update public.orders set settled=true,updated_at=v_now where id=o.id returning * into n;
     else n:=o; end if;
     r:=jsonb_build_object('ok',true,'idempotent',true,'orderId',o.id,'row',to_jsonb(n),'processedRequests',0,'message','Yêu cầu đã được xử lý.');
   elsif req.status<>'PENDING' then return jsonb_build_object('ok',false,'code','REVIEW_CONFLICT','message','Yêu cầu đã được xử lý với kết quả khác.');
   else
     update public.settlement_requests set status=v_decision,admin_username=u.username,admin_name=u.display_name,reviewed_at=v_now,rejection_reason=coalesce(p_input->>'reason','')
       where order_id=o.id and status='PENDING';get diagnostics v_count=row_count;
     update public.orders set settled=case when v_decision='APPROVED' then true else settled end,updated_at=v_now where id=o.id returning * into n;
     r:=jsonb_build_object('ok',true,'orderId',o.id,'row',to_jsonb(n),'processedRequests',v_count,'message',case when v_decision='APPROVED' then 'Đã duyệt tất toán.' else 'Đã trả đơn cho Sale chỉnh sửa.' end);
   end if;
 end if;
 insert into public.activity_log(username,display_name,role,order_id,action,before_data,after_data)
   values(u.username,u.display_name,u.role,v_id,p_action,to_jsonb(o),to_jsonb(n));
 insert into public.operation_receipts(actor,request_id,action,fingerprint,result) values(u.username,p_request_id,p_action,p_fingerprint,r);
 return r;
 -- Unexpected failures propagate; PostgreSQL rolls back ALL writes and receipt.
end $function$
;

revoke all on function public.mee_ops_mutate(text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.mee_ops_mutate(text,text,text,text,jsonb) to service_role;

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
revoke all on function public.mark_order_sheet_sync_state(),public.archive_order_after_sheet_delete_ack(),public.guard_queued_order_update(),public.guard_settlement_against_delete() from public,anon,authenticated;
grant execute on function public.mark_order_sheet_sync_state(),public.archive_order_after_sheet_delete_ack(),public.guard_queued_order_update(),public.guard_settlement_against_delete() to service_role;
