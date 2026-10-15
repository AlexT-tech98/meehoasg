-- Global paginated search for operations; normalization retains Vietnamese diacritic independence.
-- Invoked server-side through an authenticated Edge Function using service_role only.
CREATE OR REPLACE FUNCTION public.mee_search_key(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path = 'pg_catalog' AS $$
 SELECT regexp_replace(translate(lower(p_text), 'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ', 'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd'), '[[:space:]]+', ' ', 'g')
$$;

CREATE OR REPLACE FUNCTION public.mee_search_orders_global(p_query text, p_limit integer DEFAULT 80, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = 'public', 'pg_temp' AS $$
DECLARE v jsonb; v_query text;
BEGIN
 v_query := public.mee_search_key(trim(coalesce(p_query,'')));
 IF length(v_query) < 2 OR length(v_query) > 200 THEN
   RAISE EXCEPTION 'SEARCH_QUERY_INVALID: use 2–200 characters';
 END IF;
 IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 OR p_offset IS NULL OR p_offset < 0 OR p_offset > 1000000 THEN
   RAISE EXCEPTION 'SEARCH_PAGE_INVALID';
 END IF;
 v_query := replace(replace(replace(v_query, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_');
 WITH matched AS MATERIALIZED (
   SELECT o.* FROM public.orders o
   WHERE public.mee_search_key(concat_ws(' ',o.id,o.customer,o.phone,o.flower,o.sale)) LIKE '%' || v_query || '%' ESCAPE E'\\'
 ), page AS (
   SELECT * FROM matched ORDER BY order_date DESC,order_time DESC,id DESC LIMIT p_limit OFFSET p_offset
 )
 SELECT jsonb_build_object(
   'rows',coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM page p),'[]'::jsonb),
   'total',(SELECT count(*) FROM matched)
 ) INTO v;
 RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public.mee_search_key(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mee_search_orders_global(text,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mee_search_key(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mee_search_orders_global(text,integer,integer) TO service_role;
