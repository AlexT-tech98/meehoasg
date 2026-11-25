-- MEEHOA OPS UI V3 — Additive, backwards-compatible migration for TC-13, TC-14, TC-15, TC-16, TC-17.
-- 1. TC-13: Independent free field `tag_note_free` (no cost, does not affect hasAccessories or totals).
-- 2. TC-14/15/16: Soft Delete (`is_deleted`, metadata, append-only `order_deletion_history`),
--    Admin/owner delete permissions, mandatory deletion reason, Admin-only restore, financial preservation.
-- 3. TC-17: Server-side full-period status/debt filtering and accurate total counts in `mee_search_orders_page`.
-- Does NOT drop or mutate existing rows; legacy `[ĐÃ XÓA]` conversion is handled by a separate Owner-approved script.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS tag_note_free text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by text,
  ADD COLUMN IF NOT EXISTS deleted_by_role text,
  ADD COLUMN IF NOT EXISTS deleted_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS deleted_reason_code text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS restored_at timestamptz,
  ADD COLUMN IF NOT EXISTS restored_by text;

CREATE INDEX IF NOT EXISTS orders_active_date_time_idx
  ON public.orders (order_date, order_time, id)
  WHERE NOT is_deleted AND NOT delete_after_sheet_sync;

CREATE INDEX IF NOT EXISTS orders_deleted_at_idx
  ON public.orders (deleted_at DESC)
  WHERE is_deleted;

CREATE TABLE IF NOT EXISTS public.order_deletion_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id text NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('DELETE', 'RESTORE')),
  actor_username text NOT NULL DEFAULT '',
  actor_name text NOT NULL DEFAULT '',
  actor_role text NOT NULL DEFAULT '',
  reason_code text NOT NULL DEFAULT '',
  reason_text text NOT NULL DEFAULT '',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  order_snapshot jsonb
);
CREATE INDEX IF NOT EXISTS order_deletion_history_order_idx
  ON public.order_deletion_history (order_id, occurred_at DESC);

ALTER TABLE public.order_deletion_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_deletion_history FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.order_deletion_history TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.order_deletion_history_id_seq TO service_role;

-- Hardened ownership check (TC-15):
-- 1) Exact username match is always authoritative and unambiguous.
-- 2) Legacy display_name match is allowed ONLY when no other active user owns that string as username
--    AND the display_name is unique among active users (fails closed on duplicate display_name).
CREATE OR REPLACE FUNCTION public.mee_ops_owner(sale text, u public.app_users)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT
    lower(trim(coalesce(sale, ''))) = lower(trim(u.username))
    OR (
      lower(trim(coalesce(sale, ''))) = lower(trim(u.display_name))
      AND NOT EXISTS (
        SELECT 1 FROM public.app_users u2
        WHERE u2.active
          AND lower(trim(u2.username)) = lower(trim(coalesce(sale, '')))
          AND u2.username <> u.username
      )
      AND (
        SELECT count(*) FROM public.app_users u3
        WHERE u3.active
          AND lower(trim(u3.display_name)) = lower(trim(u.display_name))
      ) = 1
    )
$$;

-- Canonical fulfillment status projection matching JS `fulfillmentStatus(row)`
CREATE OR REPLACE FUNCTION public.mee_ops_visible_status(o public.orders)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE
    WHEN o.status = 'Đã bó' THEN
      CASE WHEN o.shipping = 'Ghé lấy' THEN 'Chờ lấy' ELSE 'Chờ giao' END
    ELSE coalesce(o.status, '')
  END
$$;

-- Canonical paid amount parser matching JS `paidAmount(payment, base, settled)` in meehoasg-api-core
CREATE OR REPLACE FUNCTION public.mee_ops_paid(o public.orders)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_total numeric := public.mee_ops_total(o);
  v_base numeric := coalesce(o.flower_total, 0);
  v_text text;
  v_compact text;
  v_match text[];
  v_raw text;
  v_unit text;
  v_val numeric := 0;
BEGIN
  IF coalesce(o.full_paid, false) THEN
    RETURN CASE WHEN coalesce(o.full_paid_total, 0) > 0 THEN o.full_paid_total ELSE v_total END;
  END IF;
  IF coalesce(o.settled, false) THEN
    RETURN v_total;
  END IF;
  v_text := public.mee_search_key(coalesce(o.payment, ''));
  IF v_text = '' OR v_text ~ 'chua' THEN
    RETURN 0;
  END IF;
  IF v_text ~ '(full|da tt|da thanh toan (du|toan bo)|thanh toan du)' THEN
    RETURN v_base;
  END IF;
  v_compact := regexp_replace(v_text, '\s+', '', 'g');
  v_match := regexp_match(v_compact, '([0-9][0-9.,]*)(trieu|tr|k)?');
  IF v_match IS NULL THEN
    IF v_text ~ 'da thanh toan' THEN RETURN v_base; END IF;
    RETURN 0;
  END IF;
  v_raw := v_match[1];
  v_unit := coalesce(v_match[2], '');
  IF position(',' IN v_raw) > 0 AND position('.' IN v_raw) > 0 THEN
    v_raw := replace(replace(v_raw, '.', ''), ',', '.');
  ELSIF v_raw ~ '^[0-9]{1,3}([.,][0-9]{3})+$' THEN
    v_raw := regexp_replace(v_raw, '[.,]', '', 'g');
  ELSE
    v_raw := replace(v_raw, ',', '.');
  END IF;
  BEGIN
    v_val := v_raw::numeric;
  EXCEPTION WHEN OTHERS THEN
    RETURN 0;
  END;
  IF v_unit IN ('tr', 'trieu') THEN
    v_val := v_val * 1000000;
  ELSIF v_unit = 'k' OR (v_val > 0 AND v_val <= 1000 AND v_text !~ '[0-9]\s*(d|vnd)($|[\s),.])') THEN
    v_val := v_val * 1000;
  END IF;
  RETURN greatest(0, v_val);
END;
$$;

CREATE OR REPLACE FUNCTION public.mee_ops_debt(o public.orders)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE
    WHEN coalesce(o.settled, false) OR coalesce(o.full_paid, false) THEN 0
    ELSE greatest(0, public.mee_ops_total(o) - public.mee_ops_paid(o))
  END
$$;

-- Upgrade `mee_search_orders_global` to exclude soft-deleted & legacy-delete-queued orders.
CREATE OR REPLACE FUNCTION public.mee_search_orders_global(p_query text, p_limit integer DEFAULT 80, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = 'public', 'pg_temp'
AS $$
DECLARE v jsonb; v_query text;
BEGIN
  v_query := public.mee_search_key(trim(coalesce(p_query, '')));
  IF length(v_query) < 2 OR length(v_query) > 200 THEN
    RAISE EXCEPTION 'SEARCH_QUERY_INVALID: use 2–200 characters';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 OR p_offset IS NULL OR p_offset < 0 OR p_offset > 1000000 THEN
    RAISE EXCEPTION 'SEARCH_PAGE_INVALID';
  END IF;
  v_query := replace(replace(replace(v_query, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_');
  WITH matched AS MATERIALIZED (
    SELECT o.* FROM public.orders o
    WHERE NOT coalesce(o.is_deleted, false)
      AND NOT coalesce(o.delete_after_sheet_sync, false)
      AND public.mee_search_key(concat_ws(' ', o.id, o.customer, o.phone, o.flower, o.sale)) LIKE '%' || v_query || '%' ESCAPE E'\\'
  ), page AS (
    SELECT * FROM matched ORDER BY order_date ASC, order_time ASC, id ASC LIMIT p_limit OFFSET p_offset
  )
  SELECT jsonb_build_object(
    'rows', coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.order_date ASC, p.order_time ASC, p.id ASC) FROM page p), '[]'::jsonb),
    'total', (SELECT count(*) FROM matched)
  ) INTO v;
  RETURN v;
END;
$$;

-- Upgrade `mee_search_orders_page` (TC-17):
-- Keeps 5-argument call compatibility while adding optional `p_status` and `p_debt_only`
-- and returning full-period `counts` and `scopeTotal` computed on PostgreSQL without preloading all rows.
DROP FUNCTION IF EXISTS public.mee_search_orders_page(text, date, date, integer, integer);
CREATE OR REPLACE FUNCTION public.mee_search_orders_page(
  p_query text DEFAULT '',
  p_start date DEFAULT NULL,
  p_end date DEFAULT NULL,
  p_limit integer DEFAULT 80,
  p_offset integer DEFAULT 0,
  p_status text DEFAULT NULL,
  p_debt_only boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = 'public', 'pg_temp'
AS $$
DECLARE
  v_query text := public.mee_search_key(trim(coalesce(p_query, '')));
  v_status text := nullif(trim(coalesce(p_status, '')), '');
  v_debt boolean := coalesce(p_debt_only, false);
  v jsonb;
BEGIN
  IF (v_query <> '' AND (length(v_query) < 2 OR length(v_query) > 200)) OR (v_query = '' AND p_start IS NULL) THEN
    RAISE EXCEPTION 'SEARCH_QUERY_INVALID';
  END IF;
  IF (p_start IS NULL) <> (p_end IS NULL) OR p_end < p_start THEN
    RAISE EXCEPTION 'SEARCH_RANGE_INVALID';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 OR p_offset IS NULL OR p_offset < 0 OR p_offset > 1000000 THEN
    RAISE EXCEPTION 'SEARCH_PAGE_INVALID';
  END IF;
  IF v_status IS NOT NULL AND v_status NOT IN ('Tất cả', 'Chờ bó', 'Chờ giao', 'Chờ lấy', 'Đã giao', 'Còn nợ') THEN
    RAISE EXCEPTION 'SEARCH_STATUS_INVALID';
  END IF;
  IF v_status = 'Tất cả' THEN v_status := NULL; END IF;
  IF v_status = 'Còn nợ' THEN v_status := NULL; v_debt := true; END IF;

  v_query := replace(replace(replace(v_query, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_');

  WITH scoped AS MATERIALIZED (
    SELECT
      o.id,
      o.order_date,
      o.order_time,
      CASE
        WHEN o.status = 'Đã bó' THEN
          CASE WHEN o.shipping = 'Ghé lấy' THEN 'Chờ lấy' ELSE 'Chờ giao' END
        ELSE coalesce(o.status, '')
      END AS vis_status,
      CASE
        WHEN coalesce(o.settled, false) OR coalesce(o.full_paid, false) THEN false
        WHEN coalesce(o.payment, '') IN ('', 'Chưa thanh toán') THEN (
          coalesce(o.flower_total, 0)
          + CASE WHEN o.card THEN greatest(1, coalesce(o.card_qty, 1)) * 10000 ELSE 0 END
          + CASE WHEN o.banner THEN greatest(1, coalesce(o.banner_qty, 1)) * 35000 ELSE 0 END
          + coalesce(o.charm_fee, 0) + coalesce(o.paper_fee, 0) + coalesce(o.vat, 0)
          + CASE WHEN lower(coalesce(o.shipping, '')) LIKE '%shop%' AND coalesce(o.ship_confirmed, false) THEN coalesce(o.ship_fee, 0) ELSE 0 END
        ) > 0
        ELSE public.mee_ops_debt(o) > 0
      END AS has_debt
    FROM public.orders o
    WHERE NOT coalesce(o.is_deleted, false)
      AND NOT coalesce(o.delete_after_sheet_sync, false)
      AND (p_start IS NULL OR o.order_date BETWEEN p_start AND p_end)
      AND (v_query = '' OR o.ops_search_key LIKE '%' || v_query || '%' ESCAPE E'\\')
  ),
  filtered AS (
    SELECT id, order_date, order_time
    FROM scoped s
    WHERE (v_status IS NULL OR s.vis_status = v_status)
      AND (NOT v_debt OR s.has_debt)
  ),
  page AS (
    SELECT id, order_date, order_time
    FROM filtered
    ORDER BY order_date ASC, order_time ASC, id ASC
    LIMIT p_limit OFFSET p_offset
  ),
  agg AS (
    SELECT
      count(*)::int AS all_count,
      count(*) FILTER (WHERE vis_status = 'Chờ bó')::int AS wait_count,
      count(*) FILTER (WHERE vis_status = 'Chờ giao')::int AS ship_count,
      count(*) FILTER (WHERE vis_status = 'Chờ lấy')::int AS pickup_count,
      count(*) FILTER (WHERE vis_status = 'Đã giao')::int AS delivered_count,
      count(*) FILTER (WHERE has_debt)::int AS debt_count
    FROM scoped
  )
  SELECT jsonb_build_object(
    'rows', coalesce((
      SELECT jsonb_agg(to_jsonb(o) ORDER BY p.order_date ASC, p.order_time ASC, p.id ASC)
      FROM page p
      JOIN public.orders o ON o.id = p.id
    ), '[]'::jsonb),
    'total', (SELECT count(*)::int FROM filtered),
    'scopeTotal', (SELECT all_count FROM agg),
    'counts', (
      SELECT jsonb_build_object(
        'Tất cả', all_count,
        'Chờ bó', wait_count,
        'Chờ giao', ship_count,
        'Chờ lấy', pickup_count,
        'Đã giao', delivered_count,
        'Còn nợ', debt_count
      ) FROM agg
    )
  ) INTO v;
  RETURN v;
END;
$$;

REVOKE ALL ON FUNCTION public.mee_ops_visible_status(public.orders) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mee_ops_paid(public.orders) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mee_ops_debt(public.orders) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mee_search_orders_global(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mee_search_orders_page(text, date, date, integer, integer, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mee_ops_visible_status(public.orders) TO service_role;
GRANT EXECUTE ON FUNCTION public.mee_ops_paid(public.orders) TO service_role;
GRANT EXECUTE ON FUNCTION public.mee_ops_debt(public.orders) TO service_role;
GRANT EXECUTE ON FUNCTION public.mee_search_orders_global(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mee_search_orders_page(text, date, date, integer, integer, text, boolean) TO service_role;

-- Update canonical `mee_ops_mutate` for TC-13 (tag_note_free), TC-14/15/16 (soft delete, ownership, mandatory reason, restore).
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
   -- TC-13 backwards compatibility: if a legacy client omits tag_note_free on update, keep existing value.
   v_tag_note:=case
     when p_action='updateOrder' and not ((p_input->'order') ? 'tag_note_free') then coalesce(o.tag_note_free,'')
     else trim(coalesce(n.tag_note_free,''))
   end;
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
     insert into public.orders(id,request_id,customer,phone,order_date,order_time,flower,note,tag_note_free,shipping,address,flower_total,payment,sale,status,
       card,card_qty,card_text,banner,banner_qty,banner_text,charm_fee,charm_text,paper_fee,paper_text,vat,image_urls,
       ship_fee,ship_confirmed,ship_fee_updated_by,ship_fee_updated_role,ship_fee_updated_at,updated_at)
     values(v_id,p_request_id,n.customer,n.phone,n.order_date,n.order_time,n.flower,n.note,v_tag_note,n.shipping,n.address,n.flower_total,n.payment,v_sale,'Chờ bó',
       n.card,case when n.card then n.card_qty else 0 end,n.card_text,n.banner,case when n.banner then n.banner_qty else 0 end,n.banner_text,n.charm_fee,n.charm_text,n.paper_fee,n.paper_text,n.vat,v_images,
       n.ship_fee,n.ship_confirmed,u.username,u.role,v_now,v_now);
   else
     update public.orders set customer=n.customer,phone=n.phone,order_date=n.order_date,order_time=n.order_time,flower=n.flower,note=n.note,tag_note_free=v_tag_note,
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
