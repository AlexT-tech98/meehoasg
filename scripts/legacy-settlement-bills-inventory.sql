-- MEEHOA OPS V3.1 — Legacy Bills Inventory Across Both Sources (919 Bills, STRICTLY READ-ONLY)
-- Covers BOTH approved sources:
--   1. `public.settlement_requests.bill_urls` (430 distinct Supabase bills)
--   2. `public.orders.full_paid_bill_urls`    (489 distinct Supabase bills, 0 overlap -> 919 total)
-- Safe to run on Production before/after migration without modifying any data.

-- ============================================================================
-- QUERY 1: SUMMARY OF ALL 919 REFERENCED BILLS BY STORAGE BACKEND & STORAGE.OBJECTS
-- ============================================================================
WITH sr_urls AS (
  SELECT
    sr.id AS settlement_id,
    sr.order_id,
    sr.status AS settlement_status,
    sr.submitted_at,
    url_val AS raw_url
  FROM public.settlement_requests sr
  CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(sr.bill_urls, '[]'::jsonb)) AS url_val
),
fp_urls AS (
  SELECT
    o.id AS order_id,
    o.created_at,
    url_val AS raw_url
  FROM public.orders o
  CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(o.full_paid_bill_urls, '[]'::jsonb)) AS url_val
),
sr_supabase AS (
  SELECT DISTINCT
    regexp_replace(raw_url, '^supabase://settlement-bills/', '') AS object_name,
    raw_url
  FROM sr_urls
  WHERE raw_url LIKE 'supabase://settlement-bills/%'
),
fp_supabase AS (
  SELECT DISTINCT
    regexp_replace(raw_url, '^supabase://settlement-bills/', '') AS object_name,
    raw_url
  FROM fp_urls
  WHERE raw_url LIKE 'supabase://settlement-bills/%'
),
all_referenced_supabase AS (
  SELECT object_name, 'settlement_requests' AS source_kind FROM sr_supabase
  UNION ALL
  SELECT object_name, 'full_paid_orders' AS source_kind FROM fp_supabase
),
distinct_all_supabase AS (
  SELECT DISTINCT object_name FROM all_referenced_supabase
),
bucket_objects AS (
  SELECT
    name AS object_name,
    coalesce((metadata->>'size')::bigint, 0) AS size_bytes,
    created_at
  FROM storage.objects
  WHERE bucket_id = 'settlement-bills'
)
SELECT
  (SELECT count(*) FROM public.settlement_requests) AS total_settlement_requests,
  (SELECT count(DISTINCT settlement_id) FROM sr_urls WHERE raw_url LIKE 'supabase://settlement-bills/%') AS settlement_requests_with_supabase_bills,
  (SELECT count(*) FROM sr_supabase) AS distinct_supabase_settlement_bills,
  (SELECT count(DISTINCT raw_url) FROM sr_urls WHERE raw_url LIKE 'r2://%') AS distinct_r2_settlement_bills,
  (SELECT count(DISTINCT raw_url) FROM sr_urls WHERE raw_url LIKE 'http%') AS distinct_http_legacy_settlement_bills,
  (SELECT count(DISTINCT order_id) FROM fp_urls WHERE raw_url LIKE 'supabase://settlement-bills/%') AS orders_with_supabase_full_paid_bills,
  (SELECT count(*) FROM fp_supabase) AS distinct_supabase_full_paid_bills,
  (SELECT count(DISTINCT raw_url) FROM fp_urls WHERE raw_url LIKE 'r2://%') AS distinct_r2_full_paid_bills,
  (SELECT count(*) FROM sr_supabase s JOIN fp_supabase f ON f.object_name = s.object_name) AS overlap_between_sr_and_fp,
  (SELECT count(*) FROM distinct_all_supabase) AS total_distinct_referenced_supabase_bills,
  (SELECT count(*) FROM distinct_all_supabase a JOIN bucket_objects b ON b.object_name = a.object_name) AS all_bills_present_in_storage,
  (SELECT count(*) FROM distinct_all_supabase a LEFT JOIN bucket_objects b ON b.object_name = a.object_name WHERE b.object_name IS NULL) AS all_bills_missing_in_storage,
  (SELECT coalesce(sum(b.size_bytes), 0) FROM sr_supabase s JOIN bucket_objects b ON b.object_name = s.object_name) AS sr_bills_total_bytes,
  (SELECT coalesce(sum(b.size_bytes), 0) FROM fp_supabase f JOIN bucket_objects b ON b.object_name = f.object_name) AS fp_bills_total_bytes,
  (SELECT coalesce(sum(b.size_bytes), 0) FROM distinct_all_supabase a JOIN bucket_objects b ON b.object_name = a.object_name) AS all_referenced_bills_total_bytes,
  (SELECT count(*) FROM bucket_objects) AS storage_bucket_total_objects,
  (SELECT coalesce(sum(size_bytes), 0) FROM bucket_objects) AS storage_bucket_total_bytes;

-- ============================================================================
-- QUERY 2: BREAKDOWN BY SOURCE & MONTH OF ALL 919 REFERENCED SUPABASE BILLS
-- ============================================================================
WITH tagged AS (
  SELECT DISTINCT
    'settlement_requests' AS source_table,
    regexp_replace(url_val, '^supabase://settlement-bills/', '') AS object_name
  FROM public.settlement_requests sr
  CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(sr.bill_urls, '[]'::jsonb)) AS url_val
  WHERE url_val LIKE 'supabase://settlement-bills/%'
  UNION ALL
  SELECT DISTINCT
    'orders.full_paid_bill_urls' AS source_table,
    regexp_replace(url_val, '^supabase://settlement-bills/', '') AS object_name
  FROM public.orders ord
  CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(ord.full_paid_bill_urls, '[]'::jsonb)) AS url_val
  WHERE url_val LIKE 'supabase://settlement-bills/%'
)
SELECT
  t.source_table,
  to_char(timezone('Asia/Ho_Chi_Minh', o.created_at), 'YYYY-MM') AS month_vn,
  count(*) AS object_count,
  coalesce(sum((o.metadata->>'size')::bigint), 0) AS total_bytes,
  min(o.created_at) AS earliest_created_at,
  max(o.created_at) AS latest_created_at
FROM tagged t
LEFT JOIN storage.objects o
  ON o.bucket_id = 'settlement-bills' AND o.name = t.object_name
GROUP BY 1, 2
ORDER BY 1 ASC, 2 ASC;
