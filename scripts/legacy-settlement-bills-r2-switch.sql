-- MEEHOA OPS V3.1 — Legacy Bills DB Reference Switch (All 919 Bills: `settlement_requests` + `orders.full_paid_bill_urls`)
-- DO NOT run before every target object in `verified_keys` has been copied to R2
-- and verified by SHA-256 + R2 GET readback via `scripts/migrate-settlement-bills-to-r2.cjs`.
-- Requires migration `20261126040000_ui_v3_1_guard_queued_order_r2_uri_compat.sql` so queued-delete orders switch cleanly.
-- NEVER deletes Supabase Storage originals; reversible via `scripts/legacy-settlement-bills-r2-rollback.sql`.

BEGIN;

CREATE TABLE IF NOT EXISTS public.legacy_settlement_bills_r2_backup (
  settlement_id text PRIMARY KEY REFERENCES public.settlement_requests(id) ON DELETE CASCADE,
  order_id text NOT NULL,
  orig_bill_urls jsonb NOT NULL,
  new_bill_urls jsonb NOT NULL,
  r2_bucket text NOT NULL DEFAULT 'meehoasg-website-media',
  migrated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.legacy_settlement_bills_r2_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.legacy_settlement_bills_r2_backup FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.legacy_settlement_bills_r2_backup TO service_role;

CREATE TABLE IF NOT EXISTS public.legacy_full_paid_bills_r2_backup (
  order_id text PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  orig_full_paid_bill_urls jsonb NOT NULL,
  new_full_paid_bill_urls jsonb NOT NULL,
  orig_updated_at timestamptz NOT NULL,
  r2_bucket text NOT NULL DEFAULT 'meehoasg-website-media',
  migrated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.legacy_full_paid_bills_r2_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.legacy_full_paid_bills_r2_backup FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.legacy_full_paid_bills_r2_backup TO service_role;

-- 1. Switch `public.settlement_requests.bill_urls` ONLY for verified keys
WITH cfg AS (
  SELECT
    coalesce(nullif(current_setting('app.r2_bucket', true), ''), 'meehoasg-website-media') AS bucket,
    coalesce(nullif(current_setting('app.verified_settlement_bill_keys', true), ''), '[]')::jsonb AS verified_json
),
verified AS (
  SELECT DISTINCT value AS object_name
  FROM cfg, jsonb_array_elements_text(cfg.verified_json) AS value
  WHERE value ~ '^[0-9a-f-]{36}(?:\.preview)?\.(?:jpg|png|webp)$'
),
rewritten AS (
  SELECT
    sr.id AS settlement_id,
    sr.order_id,
    sr.bill_urls AS orig_bill_urls,
    (
      SELECT jsonb_agg(
        CASE
          WHEN elem LIKE 'supabase://settlement-bills/%'
           AND EXISTS (
             SELECT 1 FROM verified v
             WHERE v.object_name = regexp_replace(elem, '^supabase://settlement-bills/', '')
           )
          THEN 'r2://' || cfg.bucket || '/settlement-bills/' || regexp_replace(elem, '^supabase://settlement-bills/', '')
          ELSE elem
        END
        ORDER BY ord
      )
      FROM jsonb_array_elements_text(coalesce(sr.bill_urls, '[]'::jsonb)) WITH ORDINALITY AS u(elem, ord)
    ) AS new_bill_urls,
    cfg.bucket AS r2_bucket
  FROM public.settlement_requests sr
  CROSS JOIN cfg
  WHERE jsonb_typeof(coalesce(sr.bill_urls, '[]'::jsonb)) = 'array'
    AND sr.bill_urls::text LIKE '%supabase://settlement-bills/%'
),
changed AS (
  SELECT *
  FROM rewritten
  WHERE new_bill_urls IS DISTINCT FROM orig_bill_urls
),
backed_up AS (
  INSERT INTO public.legacy_settlement_bills_r2_backup (
    settlement_id, order_id, orig_bill_urls, new_bill_urls, r2_bucket
  )
  SELECT settlement_id, order_id, orig_bill_urls, new_bill_urls, r2_bucket
  FROM changed
  ON CONFLICT (settlement_id) DO NOTHING
  RETURNING settlement_id
)
UPDATE public.settlement_requests sr
SET bill_urls = c.new_bill_urls
FROM changed c
WHERE sr.id = c.settlement_id;

-- 2. Switch `public.orders.full_paid_bill_urls` ONLY for verified keys
WITH cfg AS (
  SELECT
    coalesce(nullif(current_setting('app.r2_bucket', true), ''), 'meehoasg-website-media') AS bucket,
    coalesce(nullif(current_setting('app.verified_settlement_bill_keys', true), ''), '[]')::jsonb AS verified_json
),
verified AS (
  SELECT DISTINCT value AS object_name
  FROM cfg, jsonb_array_elements_text(cfg.verified_json) AS value
  WHERE value ~ '^[0-9a-f-]{36}(?:\.preview)?\.(?:jpg|png|webp)$'
),
rewritten_orders AS (
  SELECT
    o.id AS order_id,
    o.full_paid_bill_urls AS orig_full_paid_bill_urls,
    o.updated_at AS orig_updated_at,
    (
      SELECT jsonb_agg(
        CASE
          WHEN elem LIKE 'supabase://settlement-bills/%'
           AND EXISTS (
             SELECT 1 FROM verified v
             WHERE v.object_name = regexp_replace(elem, '^supabase://settlement-bills/', '')
           )
          THEN 'r2://' || cfg.bucket || '/settlement-bills/' || regexp_replace(elem, '^supabase://settlement-bills/', '')
          ELSE elem
        END
        ORDER BY ord
      )
      FROM jsonb_array_elements_text(coalesce(o.full_paid_bill_urls, '[]'::jsonb)) WITH ORDINALITY AS u(elem, ord)
    ) AS new_full_paid_bill_urls,
    cfg.bucket AS r2_bucket
  FROM public.orders o
  CROSS JOIN cfg
  WHERE jsonb_typeof(coalesce(o.full_paid_bill_urls, '[]'::jsonb)) = 'array'
    AND o.full_paid_bill_urls::text LIKE '%supabase://settlement-bills/%'
),
changed_orders AS (
  SELECT *
  FROM rewritten_orders
  WHERE new_full_paid_bill_urls IS DISTINCT FROM orig_full_paid_bill_urls
),
backed_up_orders AS (
  INSERT INTO public.legacy_full_paid_bills_r2_backup (
    order_id, orig_full_paid_bill_urls, new_full_paid_bill_urls, orig_updated_at, r2_bucket
  )
  SELECT order_id, orig_full_paid_bill_urls, new_full_paid_bill_urls, orig_updated_at, r2_bucket
  FROM changed_orders
  ON CONFLICT (order_id) DO NOTHING
  RETURNING order_id
)
UPDATE public.orders o
SET full_paid_bill_urls = c.new_full_paid_bill_urls
FROM changed_orders c
WHERE o.id = c.order_id;

SELECT
  (SELECT count(*) FROM public.legacy_settlement_bills_r2_backup) AS total_backed_up_settlement_requests,
  (SELECT count(*) FROM public.legacy_full_paid_bills_r2_backup) AS total_backed_up_full_paid_orders,
  (SELECT count(*) FROM public.settlement_requests WHERE bill_urls::text LIKE '%r2://%') AS settlement_requests_with_r2_bills,
  (SELECT count(*) FROM public.settlement_requests WHERE bill_urls::text LIKE '%supabase://settlement-bills/%') AS settlement_requests_still_on_supabase,
  (SELECT count(*) FROM public.orders WHERE full_paid_bill_urls::text LIKE '%r2://%') AS orders_with_r2_full_paid_bills,
  (SELECT count(*) FROM public.orders WHERE full_paid_bill_urls::text LIKE '%supabase://settlement-bills/%') AS orders_full_paid_still_on_supabase;

COMMIT;
