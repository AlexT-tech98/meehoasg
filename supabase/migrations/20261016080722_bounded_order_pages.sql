-- Bounded server pages for both global keyword and optional date searches.
-- Keep the old 3-argument RPC for rollback/client compatibility.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS ops_search_key text GENERATED ALWAYS AS (public.mee_search_key(coalesce(id,'')||' '||coalesce(customer,'')||' '||coalesce(phone,'')||' '||coalesce(flower,'')||' '||coalesce(sale,''))) STORED;
CREATE INDEX IF NOT EXISTS idx_orders_page_date ON public.orders(order_date DESC,order_time DESC,id DESC);
CREATE OR REPLACE FUNCTION public.mee_search_orders_page(p_query text DEFAULT '',p_start date DEFAULT NULL,p_end date DEFAULT NULL,p_limit integer DEFAULT 80,p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = 'public','pg_temp' AS $$
DECLARE v_query text := public.mee_search_key(trim(coalesce(p_query,''))); v jsonb;
BEGIN
 IF (v_query <> '' AND (length(v_query)<2 OR length(v_query)>200)) OR (v_query='' AND p_start IS NULL) THEN RAISE EXCEPTION 'SEARCH_QUERY_INVALID'; END IF;
 IF (p_start IS NULL) <> (p_end IS NULL) OR p_end<p_start THEN RAISE EXCEPTION 'SEARCH_RANGE_INVALID'; END IF;
 IF p_limit IS NULL OR p_limit<1 OR p_limit>200 OR p_offset IS NULL OR p_offset<0 OR p_offset>1000000 THEN RAISE EXCEPTION 'SEARCH_PAGE_INVALID'; END IF;
 v_query:=replace(replace(replace(v_query,E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_');
 WITH matched AS NOT MATERIALIZED (
  SELECT o.* FROM public.orders o
  WHERE (p_start IS NULL OR o.order_date BETWEEN p_start AND p_end)
    AND (v_query='' OR o.ops_search_key LIKE '%'||v_query||'%' ESCAPE E'\\')
 ), page AS (SELECT * FROM matched ORDER BY order_date DESC,order_time DESC,id DESC LIMIT p_limit OFFSET p_offset)
 SELECT jsonb_build_object('rows',coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM page p),'[]'::jsonb),'total',(SELECT count(*) FROM matched)) INTO v;
 RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public.mee_search_orders_page(text,date,date,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mee_search_orders_page(text,date,date,integer,integer) TO service_role;
