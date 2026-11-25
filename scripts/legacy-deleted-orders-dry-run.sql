-- POLICY-04 / TC-14 — Legacy [ĐÃ XÓA] / delete_after_sheet_sync Dry-Run Inspection (STRICTLY READ-ONLY)
-- Safe to run on Production BEFORE or AFTER UI V3 migrations without modifying any rows.
-- Executes inside a PostgreSQL READ ONLY transaction: ZERO writes, ZERO DDL, ZERO mutating function calls.
-- Production Parity:
--   1. Payment parser matches Production `paidAmount` / SQL `mee_ops_paid()` using `public.mee_search_key()`.
--   2. Strictly separates `verified_collected_vnd` (`full_paid` / `settled`) from `unverified_estimated_paid_vnd`
--      (free-text `payment` estimate) so unverified text is NEVER treated as verified collected revenue.
--   3. Cross-references `public.orders`, `public.settlement_requests`, and `public.activity_log`; never auto-converts keyword-only `[ĐÃ XÓA]` rows.

BEGIN TRANSACTION READ ONLY;

-- ============================================================================
-- QUERY 1: SUMMARY INVENTORY REPORT (VERIFIED VS ESTIMATED + 10+ METRICS)
-- ============================================================================
WITH delete_logs AS (
  SELECT
    al.order_id,
    count(*) AS delete_log_count,
    max(al.occurred_at) AS last_delete_log_at,
    string_agg(DISTINCT coalesce(nullif(trim(al.action), ''), 'UNKNOWN'), ', ' ORDER BY coalesce(nullif(trim(al.action), ''), 'UNKNOWN')) AS delete_actions
  FROM public.activity_log al
  WHERE al.order_id IS NOT NULL
    AND (
      lower(coalesce(al.action, '')) LIKE '%delete%'
      OR lower(coalesce(al.action, '')) LIKE '%xoa%'
      OR coalesce(al.after_data->>'delete_after_sheet_sync', '') = 'true'
      OR coalesce(al.after_data->>'note', '') LIKE '%[ĐÃ XÓA TRÊN OPS]%'
    )
  GROUP BY al.order_id
),
raw_candidates AS (
  SELECT
    o.id,
    o.order_date,
    o.customer,
    o.flower,
    o.note,
    o.sale,
    o.status,
    o.shipping,
    coalesce(o.settled, false) AS settled,
    coalesce(o.full_paid, false) AS full_paid,
    coalesce(o.flower_total, 0)::numeric AS flower_total,
    coalesce(o.full_paid_total, 0)::numeric AS full_paid_total,
    coalesce(o.payment, '') AS payment,
    public.mee_search_key(coalesce(o.payment, '')) AS payment_key,
    (
      coalesce(o.flower_total, 0)::numeric
      + CASE WHEN coalesce(o.card, false) THEN greatest(1, least(99, coalesce(o.card_qty, 1))) * 10000 ELSE 0 END
      + CASE WHEN coalesce(o.banner, false) THEN greatest(1, least(99, coalesce(NULLIF((to_jsonb(o)->>'banner_qty'), '')::integer, 1))) * 35000 ELSE 0 END
      + coalesce(o.charm_fee, 0)::numeric
      + coalesce(o.paper_fee, 0)::numeric
      + coalesce(o.vat, 0)::numeric
      + CASE WHEN lower(coalesce(o.shipping, '')) LIKE '%shop%' AND coalesce(o.ship_confirmed, false) THEN coalesce(o.ship_fee, 0)::numeric ELSE 0 END
    ) AS total_due_vnd,
    coalesce(o.delete_after_sheet_sync, false) AS has_delete_flag,
    o.delete_requested_by,
    o.delete_requested_at,
    (coalesce(o.note, '') LIKE '%[ĐÃ XÓA TRÊN OPS]%') AS has_ops_marker,
    (coalesce(o.customer, '') LIKE '[ĐÃ XÓA]%' OR coalesce(o.flower, '') LIKE '[ĐÃ XÓA]%') AS has_keyword_prefix,
    coalesce(dl.delete_log_count, 0) AS delete_log_count,
    EXISTS (
      SELECT 1
      FROM public.settlement_requests sr
      WHERE sr.order_id = o.id
        AND sr.status IN ('PENDING', 'APPROVED')
    ) AS has_locked_settlement
  FROM public.orders o
  LEFT JOIN delete_logs dl ON dl.order_id = o.id
  WHERE coalesce((to_jsonb(o)->>'is_deleted')::boolean, false) = false
    AND (
      coalesce(o.delete_after_sheet_sync, false) = true
      OR o.delete_requested_at IS NOT NULL
      OR nullif(trim(coalesce(o.delete_requested_by, '')), '') IS NOT NULL
      OR coalesce(o.customer, '') LIKE '[ĐÃ XÓA]%'
      OR coalesce(o.flower, '') LIKE '[ĐÃ XÓA]%'
      OR coalesce(o.note, '') LIKE '%[ĐÃ XÓA TRÊN OPS]%'
      OR dl.order_id IS NOT NULL
    )
),
tokens AS (
  SELECT
    rc.*,
    regexp_match(
      regexp_replace(rc.payment_key, '\s+', '', 'g'),
      '([0-9]+(?:[.,][0-9]+)*)(trieu|tr|k)?'
    ) AS pay_match
  FROM raw_candidates rc
),
parsed_numbers AS (
  SELECT
    t.*,
    CASE
      WHEN t.pay_match IS NULL THEN NULL::numeric
      WHEN length(regexp_replace(t.pay_match[1], '[.,]', '', 'g')) > 12 THEN 0::numeric
      WHEN position(',' IN t.pay_match[1]) > 0 AND position('.' IN t.pay_match[1]) > 0 THEN
        replace(replace(t.pay_match[1], '.', ''), ',', '.')::numeric
      WHEN t.pay_match[1] ~ '^[0-9]{1,3}([.,][0-9]{3})+$' THEN
        regexp_replace(t.pay_match[1], '[.,]', '', 'g')::numeric
      ELSE
        replace(t.pay_match[1], ',', '.')::numeric
    END AS raw_num,
    coalesce(t.pay_match[2], '') AS raw_unit
  FROM tokens t
),
scored AS (
  SELECT
    pn.*,
    (
      pn.has_delete_flag
      OR pn.delete_requested_at IS NOT NULL
      OR nullif(trim(coalesce(pn.delete_requested_by, '')), '') IS NOT NULL
      OR pn.has_ops_marker
      OR pn.delete_log_count > 0
    ) AS has_confirmed_evidence,
    CASE
      WHEN pn.full_paid THEN CASE WHEN pn.full_paid_total > 0 THEN pn.full_paid_total ELSE pn.total_due_vnd END
      WHEN pn.settled THEN pn.total_due_vnd
      ELSE 0::numeric
    END AS verified_collected_vnd,
    CASE
      WHEN pn.full_paid OR pn.settled THEN 0::numeric
      WHEN pn.payment_key = '' OR pn.payment_key ~ 'chua' THEN 0::numeric
      WHEN pn.payment_key ~ '(full|da tt|da thanh toan (du|toan bo)|thanh toan du)' THEN pn.flower_total
      WHEN pn.raw_num IS NULL THEN CASE WHEN pn.payment_key ~ 'da thanh toan' THEN pn.flower_total ELSE 0::numeric END
      WHEN pn.raw_unit IN ('tr', 'trieu') THEN greatest(0::numeric, pn.raw_num * 1000000)
      WHEN pn.raw_unit = 'k' OR (pn.raw_num > 0 AND pn.raw_num <= 1000 AND pn.payment_key !~ '[0-9]\s*(d|vnd)($|[\s),.])') THEN
        greatest(0::numeric, pn.raw_num * 1000)
      ELSE greatest(0::numeric, pn.raw_num)
    END AS unverified_estimated_paid_vnd
  FROM parsed_numbers pn
),
classified AS (
  SELECT
    s.*,
    (
      NOT (s.settled OR s.full_paid OR s.has_locked_settlement)
      AND (
        s.unverified_estimated_paid_vnd > 0
        OR (s.payment_key <> '' AND s.payment_key !~ 'chua' AND s.payment_key ~ '(coc|ck|chuyen khoan|da thanh toan|da tt|full|thu)')
      )
    ) AS has_unverified_payment_signal,
    CASE
      WHEN s.settled OR s.full_paid THEN 0::numeric
      ELSE greatest(0::numeric, s.total_due_vnd - s.unverified_estimated_paid_vnd)
    END AS related_debt_vnd,
    (s.settled OR s.full_paid OR s.has_locked_settlement) AS is_full_paid_or_settled
  FROM scored s
)
SELECT
  count(*) AS total_suspected_legacy_deleted,
  count(*) FILTER (WHERE has_confirmed_evidence) AS confirmed_with_evidence,
  count(*) FILTER (WHERE NOT has_confirmed_evidence) AS insufficient_evidence_keyword_only,
  count(*) FILTER (WHERE NOT is_full_paid_or_settled AND NOT has_unverified_payment_signal) AS unpaid_orders,
  count(*) FILTER (WHERE NOT is_full_paid_or_settled AND has_unverified_payment_signal) AS deposit_or_partial_paid_orders,
  count(*) FILTER (WHERE is_full_paid_or_settled) AS full_paid_or_settled_orders,
  count(*) FILTER (WHERE has_confirmed_evidence AND NOT is_full_paid_or_settled AND NOT has_unverified_payment_signal) AS clean_verified_candidates,
  count(*) FILTER (WHERE NOT has_confirmed_evidence OR is_full_paid_or_settled OR has_unverified_payment_signal) AS owner_manual_review_required,
  coalesce(sum(total_due_vnd), 0) AS total_order_value_vnd,
  coalesce(sum(verified_collected_vnd), 0) AS total_verified_collected_vnd,
  coalesce(sum(unverified_estimated_paid_vnd), 0) AS total_unverified_estimated_paid_vnd,
  coalesce(sum(related_debt_vnd), 0) AS total_related_debt_vnd
FROM classified;

-- ============================================================================
-- QUERY 2: DETAILED PER-ORDER INVENTORY & OWNER REVIEW CLASSIFICATION
-- ============================================================================
WITH delete_logs AS (
  SELECT
    al.order_id,
    count(*) AS delete_log_count,
    max(al.occurred_at) AS last_delete_log_at,
    string_agg(DISTINCT coalesce(nullif(trim(al.action), ''), 'UNKNOWN'), ', ' ORDER BY coalesce(nullif(trim(al.action), ''), 'UNKNOWN')) AS delete_actions
  FROM public.activity_log al
  WHERE al.order_id IS NOT NULL
    AND (
      lower(coalesce(al.action, '')) LIKE '%delete%'
      OR lower(coalesce(al.action, '')) LIKE '%xoa%'
      OR coalesce(al.after_data->>'delete_after_sheet_sync', '') = 'true'
      OR coalesce(al.after_data->>'note', '') LIKE '%[ĐÃ XÓA TRÊN OPS]%'
    )
  GROUP BY al.order_id
),
raw_candidates AS (
  SELECT
    o.id,
    o.order_date,
    o.customer,
    o.flower,
    o.note,
    o.sale,
    o.status,
    o.shipping,
    coalesce(o.settled, false) AS settled,
    coalesce(o.full_paid, false) AS full_paid,
    coalesce(o.flower_total, 0)::numeric AS flower_total,
    coalesce(o.full_paid_total, 0)::numeric AS full_paid_total,
    coalesce(o.payment, '') AS payment,
    public.mee_search_key(coalesce(o.payment, '')) AS payment_key,
    (
      coalesce(o.flower_total, 0)::numeric
      + CASE WHEN coalesce(o.card, false) THEN greatest(1, least(99, coalesce(o.card_qty, 1))) * 10000 ELSE 0 END
      + CASE WHEN coalesce(o.banner, false) THEN greatest(1, least(99, coalesce(NULLIF((to_jsonb(o)->>'banner_qty'), '')::integer, 1))) * 35000 ELSE 0 END
      + coalesce(o.charm_fee, 0)::numeric
      + coalesce(o.paper_fee, 0)::numeric
      + coalesce(o.vat, 0)::numeric
      + CASE WHEN lower(coalesce(o.shipping, '')) LIKE '%shop%' AND coalesce(o.ship_confirmed, false) THEN coalesce(o.ship_fee, 0)::numeric ELSE 0 END
    ) AS total_due_vnd,
    coalesce(o.delete_after_sheet_sync, false) AS has_delete_flag,
    o.delete_requested_by,
    o.delete_requested_at,
    (coalesce(o.note, '') LIKE '%[ĐÃ XÓA TRÊN OPS]%') AS has_ops_marker,
    (coalesce(o.customer, '') LIKE '[ĐÃ XÓA]%' OR coalesce(o.flower, '') LIKE '[ĐÃ XÓA]%') AS has_keyword_prefix,
    coalesce(dl.delete_log_count, 0) AS delete_log_count,
    coalesce(dl.delete_actions, '') AS delete_actions,
    EXISTS (
      SELECT 1
      FROM public.settlement_requests sr
      WHERE sr.order_id = o.id
        AND sr.status IN ('PENDING', 'APPROVED')
    ) AS has_locked_settlement
  FROM public.orders o
  LEFT JOIN delete_logs dl ON dl.order_id = o.id
  WHERE coalesce((to_jsonb(o)->>'is_deleted')::boolean, false) = false
    AND (
      coalesce(o.delete_after_sheet_sync, false) = true
      OR o.delete_requested_at IS NOT NULL
      OR nullif(trim(coalesce(o.delete_requested_by, '')), '') IS NOT NULL
      OR coalesce(o.customer, '') LIKE '[ĐÃ XÓA]%'
      OR coalesce(o.flower, '') LIKE '[ĐÃ XÓA]%'
      OR coalesce(o.note, '') LIKE '%[ĐÃ XÓA TRÊN OPS]%'
      OR dl.order_id IS NOT NULL
    )
),
tokens AS (
  SELECT
    rc.*,
    regexp_match(
      regexp_replace(rc.payment_key, '\s+', '', 'g'),
      '([0-9]+(?:[.,][0-9]+)*)(trieu|tr|k)?'
    ) AS pay_match
  FROM raw_candidates rc
),
parsed_numbers AS (
  SELECT
    t.*,
    CASE
      WHEN t.pay_match IS NULL THEN NULL::numeric
      WHEN length(regexp_replace(t.pay_match[1], '[.,]', '', 'g')) > 12 THEN 0::numeric
      WHEN position(',' IN t.pay_match[1]) > 0 AND position('.' IN t.pay_match[1]) > 0 THEN
        replace(replace(t.pay_match[1], '.', ''), ',', '.')::numeric
      WHEN t.pay_match[1] ~ '^[0-9]{1,3}([.,][0-9]{3})+$' THEN
        regexp_replace(t.pay_match[1], '[.,]', '', 'g')::numeric
      ELSE
        replace(t.pay_match[1], ',', '.')::numeric
    END AS raw_num,
    coalesce(t.pay_match[2], '') AS raw_unit
  FROM tokens t
),
scored AS (
  SELECT
    pn.*,
    (
      pn.has_delete_flag
      OR pn.delete_requested_at IS NOT NULL
      OR nullif(trim(coalesce(pn.delete_requested_by, '')), '') IS NOT NULL
      OR pn.has_ops_marker
      OR pn.delete_log_count > 0
    ) AS has_confirmed_evidence,
    CASE
      WHEN pn.full_paid THEN CASE WHEN pn.full_paid_total > 0 THEN pn.full_paid_total ELSE pn.total_due_vnd END
      WHEN pn.settled THEN pn.total_due_vnd
      ELSE 0::numeric
    END AS verified_collected_vnd,
    CASE
      WHEN pn.full_paid OR pn.settled THEN 0::numeric
      WHEN pn.payment_key = '' OR pn.payment_key ~ 'chua' THEN 0::numeric
      WHEN pn.payment_key ~ '(full|da tt|da thanh toan (du|toan bo)|thanh toan du)' THEN pn.flower_total
      WHEN pn.raw_num IS NULL THEN CASE WHEN pn.payment_key ~ 'da thanh toan' THEN pn.flower_total ELSE 0::numeric END
      WHEN pn.raw_unit IN ('tr', 'trieu') THEN greatest(0::numeric, pn.raw_num * 1000000)
      WHEN pn.raw_unit = 'k' OR (pn.raw_num > 0 AND pn.raw_num <= 1000 AND pn.payment_key !~ '[0-9]\s*(d|vnd)($|[\s),.])') THEN
        greatest(0::numeric, pn.raw_num * 1000)
      ELSE greatest(0::numeric, pn.raw_num)
    END AS unverified_estimated_paid_vnd
  FROM parsed_numbers pn
),
final_rows AS (
  SELECT
    s.*,
    (
      NOT (s.settled OR s.full_paid OR s.has_locked_settlement)
      AND (
        s.unverified_estimated_paid_vnd > 0
        OR (s.payment_key <> '' AND s.payment_key !~ 'chua' AND s.payment_key ~ '(coc|ck|chuyen khoan|da thanh toan|da tt|full|thu)')
      )
    ) AS has_unverified_payment_signal
  FROM scored s
)
SELECT
  id,
  order_date,
  sale,
  status,
  CASE
    WHEN NOT has_confirmed_evidence THEN 'INSUFFICIENT_EVIDENCE_KEYWORD_ONLY'
    WHEN settled OR full_paid OR has_locked_settlement THEN 'CONFIRMED_LOCKED_FINANCIAL_REVIEW'
    WHEN has_unverified_payment_signal THEN 'CONFIRMED_PAID_OR_DEPOSIT_REVIEW'
    ELSE 'CONFIRMED_UNPAID_CANDIDATE'
  END AS classification,
  concat_ws(', ',
    CASE WHEN has_delete_flag THEN 'delete_after_sheet_sync' END,
    CASE WHEN delete_requested_at IS NOT NULL OR nullif(trim(coalesce(delete_requested_by, '')), '') IS NOT NULL THEN 'delete_requested_meta' END,
    CASE WHEN has_ops_marker THEN 'ops_note_marker' END,
    CASE WHEN delete_log_count > 0 THEN 'activity_log(' || delete_actions || ')' END,
    CASE WHEN has_keyword_prefix THEN 'keyword_prefix_[ĐÃ XÓA]' END
  ) AS evidence_sources,
  (NOT has_confirmed_evidence OR settled OR full_paid OR has_locked_settlement OR has_unverified_payment_signal) AS owner_manual_review_required,
  total_due_vnd,
  verified_collected_vnd,
  unverified_estimated_paid_vnd,
  has_unverified_payment_signal,
  CASE WHEN settled OR full_paid THEN 0::numeric ELSE greatest(0::numeric, total_due_vnd - unverified_estimated_paid_vnd) END AS related_debt_vnd,
  payment,
  settled,
  full_paid,
  has_locked_settlement,
  delete_requested_by,
  delete_requested_at,
  left(customer, 80) AS customer_preview,
  left(flower, 80) AS flower_preview
FROM final_rows
ORDER BY owner_manual_review_required DESC, order_date DESC, id ASC;

COMMIT;
