-- MEEHOA OPS V3.1 — Legacy Settlement Bills Inventory (STRICTLY READ-ONLY)
-- Safe to run on Production before/after migration without modifying any data.

-- ============================================================================
-- QUERY 1: SUMMARY OF SETTLEMENT BILLS BY STORAGE BACKEND & STORAGE.OBJECTS
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
  SELECT object_name FROM sr_supabase
  UNION
  SELECT object_name FROM fp_supabase
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
  (SELECT count(*) FROM fp_supabase) AS distinct_supabase_full_paid_bills,
  (SELECT count(DISTINCT raw_url) FROM fp_urls WHERE raw_url LIKE 'r2://%') AS distinct_r2_full_paid_bills,
  (SELECT count(*) FROM all_referenced_supabase) AS total_distinct_referenced_supabase_bills,
  (SELECT count(*) FROM sr_supabase s JOIN bucket_objects b ON b.object_name = s.object_name) AS sr_bills_present_in_storage,
  (SELECT count(*) FROM sr_supabase s LEFT JOIN bucket_objects b ON b.object_name = s.object_name WHERE b.object_name IS NULL) AS sr_bills_missing_in_storage,
  (SELECT coalesce(sum(b.size_bytes), 0) FROM sr_supabase s JOIN bucket_objects b ON b.object_name = s.object_name) AS sr_bills_total_bytes,
  (SELECT count(*) FROM bucket_objects) AS storage_bucket_total_objects,
  (SELECT coalesce(sum(size_bytes), 0) FROM bucket_objects) AS storage_bucket_total_bytes;

-- ============================================================================
-- QUERY 2: BREAKDOWN BY MONTH OF REFERENCED SUPABASE SETTLEMENT BILLS
-- ============================================================================
WITH sr_supabase AS (
  SELECT DISTINCT
    regexp_replace(url_val, '^supabase://settlement-bills/', '') AS object_name
  FROM public.settlement_requests sr
  CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(sr.bill_urls, '[]'::jsonb)) AS url_val
  WHERE url_val LIKE 'supabase://settlement-bills/%'
)
SELECT
  to_char(timezone('Asia/Ho_Chi_Minh', o.created_at), 'YYYY-MM') AS month_vn,
  count(*) AS object_count,
  coalesce(sum((o.metadata->>'size')::bigint), 0) AS total_bytes,
  min(o.created_at) AS earliest_created_at,
  max(o.created_at) AS latest_created_at
FROM sr_supabase s
LEFT JOIN storage.objects o
  ON o.bucket_id = 'settlement-bills' AND o.name = s.object_name
GROUP BY 1
ORDER BY 1 ASC;
