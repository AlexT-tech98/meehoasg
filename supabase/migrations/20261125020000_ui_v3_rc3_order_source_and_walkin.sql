-- MEEHOA OPS UI V3 RC3 — Additive, backwards-compatible migration for TC-19 (Order Source) & TC-20 (Walk-in Quick Order).
-- 1. TC-19: Structured `order_source` column with fixed 6-value allow-list (+ '' for legacy/unspecified/bot orders).
-- 2. TC-20: Structured `order_type` ('STANDARD' | 'WALK_IN'), `walk_in_payment_method` ('CASH' | 'TRANSFER' | ''),
--    and `created_by` (actual operator username recorded separately from canonical owner `sale = cmui`).
-- 3. Fully backwards-compatible: preserves existing rows, preserves `order_source` when legacy clients omit it on update,
--    never forces fake sources on legacy orders or Order Bot, and never auto-verifies Full Paid / settled on walk-in orders.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS order_source text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS order_type text NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN IF NOT EXISTS walk_in_payment_method text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS created_by text NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_order_source_chk') THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_order_source_chk
      CHECK (order_source IN ('', 'Threads', 'TikTok', 'Page/IG', 'Zalo', 'Google Map', 'Khách ghé tiệm'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_order_type_chk') THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_order_type_chk
      CHECK (order_type IN ('STANDARD', 'WALK_IN'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_walk_in_payment_method_chk') THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_walk_in_payment_method_chk
      CHECK (walk_in_payment_method IN ('', 'CASH', 'TRANSFER'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS orders_source_date_idx
  ON public.orders (order_source, order_date)
  WHERE NOT is_deleted AND order_source <> '';

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
 v_count integer; v_ship numeric; v_status text; v_source_status text; v_ready_status text;
 v_sale text; v_sale_raw text; v_sale_matches integer; v_expected timestamptz;
 v_reason text; v_reason_code text; v_tag_note text; v_paid numeric;
 v_order_type text; v_order_source text; v_walkin_pay text; v_require_source boolean;
begin
 select * into u from public.app_users where username=p_actor and active for share;
 if not found then return jsonb_build_object('ok',false,'code','AUTH_REQUIRED','message','Tài khoản đã bị khóa.'); end if;
 if length(coalesce(p_request_id,'')) not between 1 and 128 or length(coalesce(p_fingerprint,''))<>64 then
   return jsonb_build_object('ok',false,'code','REQUEST_ID_REQUIRED','message','Thiếu mã yêu cầu hợp lệ.');
 end if;
 if p_action='restoreOrder' and u.role<>'ADMIN' then
   return jsonb_build_object('ok',false,'code','NOT_OWNER','message','Chỉ Admin được khôi phục đơn từ Thùng rác.');
 end if;
 -- Serializes retries for the same actor/key, including different actions.
 perform pg_advisory_xact_lock(hashtextextended(p_actor||':'||p_request_id,0));
 prior := public.mee_ops_lookup(p_actor,p_request_id,p_action,p_fingerprint);
 if prior is not null then return prior; end if;
 if p_action not in ('createOrder','updateOrder','saveShipFee','submitSettlement','reviewSettlement','updateStatus','deleteOrder','restoreOrder') then
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
   -- Shared order lock also serializes edits, shipping, submission, delete, restore and review.
   select * into o from public.orders where id=v_id for update;
   if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND','message','Không tìm thấy đơn.'); end if;
   v_ready_status:=case when o.shipping='Ghé lấy' then 'Chờ lấy' else 'Chờ giao' end;
   v_source_status:=case when o.status='Đã bó' then v_ready_status else o.status end;
   if p_action='submitSettlement' and not public.mee_ops_owner(o.sale,u) then
     return jsonb_build_object('ok',false,'code','NOT_OWNER','message','Chỉ người phụ trách đơn được gửi tất toán.');
   end if;
   if p_action='deleteOrder' then
     if u.role<>'ADMIN' and not public.mee_ops_owner(o.sale,u) then
       return jsonb_build_object('ok',false,'code','NOT_OWNER','message','Bạn chỉ được xóa đơn thuộc quyền phụ trách của mình.');
     end if;
     if coalesce(o.is_deleted,false) or coalesce(o.delete_after_sheet_sync,false) then
       return jsonb_build_object('ok',false,'code','ALREADY_DELETED','message','Đơn hàng đã nằm trong Thùng rác.');
     end if;
     if o.full_paid then
       return jsonb_build_object('ok',false,'code','ORDER_LOCKED','message','Đơn Full Paid đã tự xác nhận thanh toán; không thể xóa trực tiếp.');
     end if;
     v_paid:=public.mee_ops_paid(o);
     if u.role<>'ADMIN' and v_paid>0 then
       return jsonb_build_object('ok',false,'code','PAYMENT_RECONCILIATION_REQUIRED','message','Đơn đã ghi nhận thanh toán/cọc; chỉ Admin được xóa sau khi kiểm tra đối chiếu công nợ.');
     end if;
   elsif p_action='restoreOrder' then
     if not coalesce(o.is_deleted,false) and not coalesce(o.delete_after_sheet_sync,false) then
       return jsonb_build_object('ok',false,'code','NOT_DELETED','message','Đơn hàng hiện đang hoạt động, không cần khôi phục.');
     end if;
   else
     if coalesce(o.is_deleted,false) or coalesce(o.delete_after_sheet_sync,false) then
       return jsonb_build_object('ok',false,'code','ORDER_DELETED','message','Đơn hàng đã bị xóa; cần Admin khôi phục trước khi thao tác.');
     end if;
   end if;
   if p_action in ('updateOrder','saveShipFee') and u.role='SALE' and not public.mee_ops_owner(o.sale,u) then
     return jsonb_build_object('ok',false,'code','NOT_OWNER','message','Sale chỉ được cập nhật đơn do mình phụ trách.');
   end if;
   if p_action in ('updateOrder','saveShipFee','updateStatus','deleteOrder') and
      (o.settled or exists(select 1 from public.settlement_requests where order_id=o.id and status in ('PENDING','APPROVED'))) then
     return jsonb_build_object('ok',false,'code','ORDER_LOCKED','message','Đơn đã khóa bởi yêu cầu tất toán.');
   end if;
   if p_action in ('updateOrder','saveShipFee','updateStatus','submitSettlement','deleteOrder','restoreOrder') then
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
   v_reason:=trim(coalesce(p_input->>'reason',''));
   v_reason_code:=upper(trim(coalesce(p_input->>'reasonCode','')));
   if v_reason='' then
     return jsonb_build_object('ok',false,'code','DELETE_REASON_REQUIRED','message','Vui lòng nhập lý do xóa đơn hàng.');
   end if;
   if length(v_reason)>500 then
     return jsonb_build_object('ok',false,'code','DELETE_REASON_INVALID','message','Lý do xóa tối đa 500 ký tự.');
   end if;
   if v_reason_code='OTHER' and length(v_reason)<3 then
     return jsonb_build_object('ok',false,'code','DELETE_REASON_REQUIRED','message','Vui lòng nhập chi tiết lý do xóa (tối thiểu 3 ký tự).');
   end if;
   -- TC-14: Soft Delete only — NEVER alters customer/flower/note, NEVER deletes images/bills/settlements.
   update public.orders set
     is_deleted=true,
     deleted_at=v_now,
     deleted_by=u.username,
     deleted_by_role=u.role,
     deleted_reason=v_reason,
     deleted_reason_code=v_reason_code,
     updated_at=v_now
     where id=o.id returning * into n;
   insert into public.order_deletion_history(order_id,event_type,actor_username,actor_name,actor_role,reason_code,reason_text,occurred_at,order_snapshot)
     values(o.id,'DELETE',u.username,u.display_name,u.role,v_reason_code,v_reason,v_now,to_jsonb(o));
   r:=jsonb_build_object('ok',true,'orderId',o.id,'row',to_jsonb(n),'deleted',true,'hadPayment',coalesce(v_paid,0)>0,'paidAmount',coalesce(v_paid,0),'message',case when coalesce(v_paid,0)>0 then 'Đã chuyển đơn có phát sinh thu tiền vào Thùng rác (vẫn hiển thị tại mục đối chiếu Công nợ).' else 'Đã chuyển đơn hàng vào Thùng rác.' end);

 elsif p_action='restoreOrder' then
   v_reason:=trim(coalesce(p_input->>'reason','Khôi phục đơn hàng'));
   -- TC-14: Restore in place on the exact same order ID; preserves deletion audit history.
   update public.orders set
     is_deleted=false,
     delete_after_sheet_sync=false,
     restored_at=v_now,
     restored_by=u.username,
     updated_at=v_now
     where id=o.id returning * into n;
   insert into public.order_deletion_history(order_id,event_type,actor_username,actor_name,actor_role,reason_code,reason_text,occurred_at,order_snapshot)
     values(o.id,'RESTORE',u.username,u.display_name,u.role,'ADMIN_RESTORE',v_reason,v_now,to_jsonb(n));
   r:=jsonb_build_object('ok',true,'orderId',o.id,'row',to_jsonb(n),'restored',true,'message','Đã khôi phục đơn hàng về danh sách vận hành.');

 elsif p_action in ('createOrder','updateOrder') then
   n:=jsonb_populate_record(null::public.orders,p_input->'order');
   v_order_type:=upper(trim(coalesce(
     case when (p_input->'order') ? 'order_type' then nullif(trim(n.order_type),'') else null end,
     case when p_action='updateOrder' then o.order_type else 'STANDARD' end,
     'STANDARD'
   )));
   if v_order_type not in ('STANDARD','WALK_IN') then
     return jsonb_build_object('ok',false,'code','ORDER_TYPE_INVALID','message','Loại đơn hàng không hợp lệ.');
   end if;
   if p_action='updateOrder' and v_order_type is distinct from coalesce(o.order_type,'STANDARD') then
     return jsonb_build_object('ok',false,'code','ORDER_TYPE_IMMUTABLE','message','Không thể chuyển đổi giữa đơn Khách vãng lai và đơn thông thường.');
   end if;

   if v_order_type='WALK_IN' then
     -- TC-20: Walk-in Quick Order — strict server-side canonicalization; never bypasses standard rules or auto-verifies Full Paid/settled.
     if n.order_date is null
        or n.order_time is null or n.order_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        or n.flower_total is null or n.flower_total<=0 or n.flower_total>999999999999 then
       return jsonb_build_object('ok',false,'code','WALK_IN_INPUT_INVALID','message','Đơn khách vãng lai cần ngày bán hợp lệ và số tiền lớn hơn 0.');
     end if;
     v_walkin_pay:=upper(trim(coalesce(
       case when (p_input->'order') ? 'walk_in_payment_method' then n.walk_in_payment_method else null end,
       case when p_action='updateOrder' then o.walk_in_payment_method else '' end,
       ''
     )));
     if v_walkin_pay not in ('CASH','TRANSFER') then
       return jsonb_build_object('ok',false,'code','WALK_IN_PAYMENT_INVALID','message','Vui lòng chọn hình thức thanh toán (Tiền mặt hoặc Chuyển khoản).');
     end if;
     if p_action='createOrder' then
       if exists(select 1 from public.orders where request_id=p_request_id) then
         return jsonb_build_object('ok',false,'code','LEGACY_REQUEST_EXISTS','message','Mã yêu cầu đã có đơn từ phiên bản trước. Kiểm tra danh sách đơn trước khi tạo tiếp.');
       end if;
       v_id:=p_input->>'newOrderId';
       -- Canonical C Mui lookup from app_users (TC-20 Section 4): never hardcode an unverified display name.
       select username into v_sale from public.app_users
         where active and (lower(trim(username))='cmui' or lower(trim(display_name)) in ('c mụi','c mui'))
         order by (lower(trim(username))='cmui') desc limit 1;
       if v_sale is null then
         return jsonb_build_object('ok',false,'code','WALK_IN_OWNER_NOT_CONFIGURED','message','Không tìm thấy tài khoản phụ trách mặc định C Mụi (cmui) đang hoạt động.');
       end if;
     else
       v_sale:=o.sale;
     end if;

     v_order_source:='Khách ghé tiệm';
     v_tag_note:='';
     n.customer:='Khách vãng lai';
     n.phone:='';
     n.address:='';
     n.shipping:='Ghé lấy';
     n.flower:=coalesce(nullif(trim(n.flower),''),'Khách vãng lai mua hoa tại tiệm');
     n.note:=trim(coalesce(n.note,''));
     n.payment:='Đã thanh toán '||trim(to_char(n.flower_total,'FM999999999999'))||' đ ('||case when v_walkin_pay='CASH' then 'Tiền mặt' else 'Chuyển khoản' end||' - Khách vãng lai)';
     if p_action='createOrder' then
       insert into public.orders(id,request_id,customer,phone,order_date,order_time,flower,note,tag_note_free,order_source,order_type,walk_in_payment_method,created_by,
         shipping,address,flower_total,payment,sale,status,
         card,card_qty,card_text,banner,banner_qty,banner_text,charm_fee,charm_text,paper_fee,paper_text,vat,image_urls,
         ship_fee,ship_confirmed,ship_fee_updated_by,ship_fee_updated_role,ship_fee_updated_at,updated_at)
       values(v_id,p_request_id,n.customer,'',n.order_date,n.order_time,n.flower,n.note,'',v_order_source,'WALK_IN',v_walkin_pay,u.username,
         'Ghé lấy','',n.flower_total,n.payment,v_sale,'Đã giao',
         false,0,'',false,0,'',0,'',0,'',0,'[]'::jsonb,
         0,false,u.username,u.role,v_now,v_now);
     else
       update public.orders set order_date=n.order_date,order_time=n.order_time,flower=n.flower,note=n.note,
         flower_total=n.flower_total,payment=n.payment,walk_in_payment_method=v_walkin_pay,order_source=v_order_source,
         updated_at=v_now where id=v_id;
     end if;
     select * into n from public.orders where id=v_id;
     r:=jsonb_build_object('ok',true,'orderId',v_id,'row',to_jsonb(n),'fullPaidApplied',false,'walkIn',true,'imageRetentionApplied',true,'fullPaidInvalidated',false,
       'message',case when p_action='createOrder' then 'Đã ghi nhận đơn khách vãng lai.' else 'Đã lưu thay đổi đơn khách vãng lai.' end);

   else
     -- STANDARD order path (TC-13 + TC-19 + all RC2 invariants preserved)
     v_tag_note:=case
       when p_action='updateOrder' and not ((p_input->'order') ? 'tag_note_free') then coalesce(o.tag_note_free,'')
       else trim(coalesce(n.tag_note_free,''))
     end;
     v_order_source:=case
       when p_action='updateOrder' and not ((p_input->'order') ? 'order_source') then coalesce(o.order_source,'')
       else trim(coalesce(n.order_source,''))
     end;
     v_require_source:=coalesce((p_input->>'requireOrderSource')::boolean,false);
     if v_order_source<>'' and v_order_source not in ('Threads','TikTok','Page/IG','Zalo','Google Map','Khách ghé tiệm') then
       return jsonb_build_object('ok',false,'code','ORDER_SOURCE_INVALID','message','Nguồn đơn không nằm trong danh sách cho phép.');
     end if;
     if p_action='createOrder' and v_require_source and v_order_source='' then
       return jsonb_build_object('ok',false,'code','ORDER_SOURCE_REQUIRED','message','Vui lòng chọn Nguồn đơn.');
     end if;

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
        or (n.banner and (coalesce(n.banner_qty,0) not between 1 and 99 or nullif(trim(n.banner_text),'') is null)) then
       return jsonb_build_object('ok',false,'code','ORDER_INPUT_INVALID','message','Thông tin đơn, thời gian hoặc số tiền không hợp lệ.');
     end if;
     if p_action='updateOrder' and v_source_status in ('Chờ lấy','Chờ giao')
        and (n.shipping='Ghé lấy') is distinct from (o.shipping='Ghé lấy') then
       return jsonb_build_object('ok',false,'code','SHIPPING_STATUS_CONFLICT',
         'message','Đưa đơn về Chờ bó trước khi đổi giữa giao hàng và ghé lấy.');
     end if;
     v_sale_raw:=case when u.role='SALE' then u.username else n.sale end;
     v_sale:=null;
     select username into v_sale from public.app_users
       where active and lower(trim(username))=lower(trim(coalesce(v_sale_raw,''))) limit 1;
     if v_sale is null then
       select count(*)::int, min(username) into v_sale_matches, v_sale
         from public.app_users
         where active and lower(trim(display_name))=lower(trim(coalesce(v_sale_raw,'')));
       if v_sale_matches>1 then
         return jsonb_build_object('ok',false,'code','SALE_AMBIGUOUS','message','Tên người phụ trách bị trùng giữa nhiều tài khoản. Vui lòng chọn theo mã tài khoản (username).');
       end if;
       if v_sale_matches=0 then v_sale:=null; end if;
     end if;
     if v_sale is null then return jsonb_build_object('ok',false,'code','SALE_REQUIRED','message','Cần chọn người phụ trách hợp lệ.'); end if;
     if p_action='createOrder' then
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
       insert into public.orders(id,request_id,customer,phone,order_date,order_time,flower,note,tag_note_free,order_source,order_type,walk_in_payment_method,created_by,
         shipping,address,flower_total,payment,sale,status,
         card,card_qty,card_text,banner,banner_qty,banner_text,charm_fee,charm_text,paper_fee,paper_text,vat,image_urls,
         ship_fee,ship_confirmed,ship_fee_updated_by,ship_fee_updated_role,ship_fee_updated_at,updated_at)
       values(v_id,p_request_id,n.customer,n.phone,n.order_date,n.order_time,n.flower,n.note,v_tag_note,v_order_source,'STANDARD','',u.username,
         n.shipping,n.address,n.flower_total,n.payment,v_sale,'Chờ bó',
         n.card,case when n.card then n.card_qty else 0 end,n.card_text,n.banner,case when n.banner then n.banner_qty else 0 end,n.banner_text,n.charm_fee,n.charm_text,n.paper_fee,n.paper_text,n.vat,v_images,
         n.ship_fee,n.ship_confirmed,u.username,u.role,v_now,v_now);
     else
       update public.orders set customer=n.customer,phone=n.phone,order_date=n.order_date,order_time=n.order_time,flower=n.flower,note=n.note,tag_note_free=v_tag_note,order_source=v_order_source,
         shipping=n.shipping,address=n.address,flower_total=n.flower_total,payment=n.payment,sale=v_sale,
         card=n.card,card_qty=case when n.card then n.card_qty else 0 end,card_text=n.card_text,banner=n.banner,banner_qty=case when n.banner then n.banner_qty else 0 end,banner_text=n.banner_text,
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
   end if;

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
   if v_status='Đã bó' then
     v_status:=case when v_source_status='Chờ bó' then v_ready_status
                    when v_source_status in ('Chờ giao','Chờ lấy') then 'Chờ bó'
                    else v_status end;
   end if;
   if v_status is null or v_status not in ('Chờ bó','Chờ giao','Chờ lấy','Đã giao') or not (
      (v_source_status='Chờ bó' and v_status=v_ready_status)
      or (v_source_status in ('Chờ giao','Chờ lấy') and v_status in ('Chờ bó','Đã giao'))
      or (v_source_status='Đã giao' and v_status=v_ready_status)
      or (o.status='Đã bó' and v_status=v_ready_status)
   ) then
     return jsonb_build_object('ok',false,'code','STATUS_INVALID','message','Chỉ được chuyển trạng thái từng bước.'); end if;
   update public.orders set status=v_status,updated_at=v_now where id=o.id returning * into n;
   r:=jsonb_build_object('ok',true,'orderId',o.id,'row',to_jsonb(n),'status',v_status);

 elsif p_action='submitSettlement' then
   if not u.active or o.settled or o.full_paid or o.status<>'Đã giao' then
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
end $function$;
