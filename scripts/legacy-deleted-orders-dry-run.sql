-- POLICY-04 / TC-14 — Legacy [ĐÃ XÓA] / delete_after_sheet_sync Dry-Run Inspection (STRICTLY READ-ONLY)
-- Safe to run on Production or Staging BEFORE or AFTER UI V3 migrations.
-- Executes inside a PostgreSQL READ ONLY transaction: ZERO writes, ZERO DDL, ZERO mutating function calls.
-- Cross-references public.orders, public.settlement_requests, and public.activity_log.
-- NEVER auto-converts keyword-only [ĐÃ XÓA] orders; classifies exact evidence vs insufficient evidence for Owner review.

BEGIN TRANSACTION READ ONLY;

-- ============================================================================
-- QUERY 1: SUMMARY INVENTORY REPORT (ALL 10 POLICY-04 METRICS)
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
    o.order_time,
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
    dl.last_delete_log_at,
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
scored AS (
  SELECT
    rc.*,
    (
      rc.has_delete_flag
      OR rc.delete_requested_at IS NOT NULL
      OR nullif(trim(coalesce(rc.delete_requested_by, '')), '') IS NOT NULL
      OR rc.has_ops_marker
      OR rc.delete_log_count > 0
    ) AS has_confirmed_evidence,
    CASE
      WHEN rc.full_paid THEN greatest(rc.full_paid_total, rc.total_due_vnd)
      WHEN rc.settled THEN rc.total_due_vnd
      WHEN lower(rc.payment) = '' OR lower(rc.payment) ~ 'chua|chưa' THEN 0::numeric
      WHEN lower(rc.payment) ~ '(full|da tt|đã tt|da thanh toan (du|toan bo)|đã thanh toán (đủ|toàn bộ)|thanh toan du|thanh toán đủ)' THEN rc.flower_total
      WHEN regexp_replace(lower(rc.payment), '\s+', '', 'g') ~ '([0-9][0-9.,]*)(tr|trieu|triệu)' THEN
        coalesce(NULLIF(regexp_replace((regexp_match(regexp_replace(lower(rc.payment), '\s+', '', 'g'), '([0-9][0-9.,]*)(tr|trieu|triệu)'))[1], '[^0-9.]', '', 'g'), '')::numeric, 0) * 1000000
      WHEN regexp_replace(lower(rc.payment), '\s+', '', 'g') ~ '([0-9][0-9.,]*)k' THEN
        coalesce(NULLIF(regexp_replace((regexp_match(regexp_replace(lower(rc.payment), '\s+', '', 'g'), '([0-9][0-9.,]*)k'))[1], '[^0-9.]', '', 'g'), '')::numeric, 0) * 1000
      WHEN regexp_replace(rc.payment, '[^0-9]', '', 'g') <> '' THEN
        coalesce(NULLIF(regexp_replace(rc.payment, '[^0-9]', '', 'g'), '')::numeric, 0)
      WHEN lower(rc.payment) ~ '(da thanh toan|đã thanh toán|coc|cọc|ck|chuyen khoan|chuyển khoản)' THEN rc.flower_total
      ELSE 0::numeric
    END AS estimated_paid_vnd
  FROM raw_candidates rc
),
classified AS (
  SELECT
    s.*,
    CASE
      WHEN s.settled OR s.full_paid THEN 0::numeric
      ELSE greatest(0::numeric, s.total_due_vnd - s.estimated_paid_vnd)
    END AS related_debt_vnd,
    (s.settled OR s.full_paid OR s.has_locked_settlement) AS is_full_paid_or_settled,
    (NOT (s.settled OR s.full_paid OR s.has_locked_settlement) AND s.estimated_paid_vnd > 0) AS is_deposit_or_partial_paid,
    (NOT (s.settled OR s.full_paid OR s.has_locked_settlement) AND s.estimated_paid_vnd <= 0) AS is_unpaid
  FROM scored s
)
SELECT
  count(*) AS total_suspected_legacy_deleted,
  count(*) FILTER (WHERE has_confirmed_evidence) AS confirmed_with_evidence,
  count(*) FILTER (WHERE NOT has_confirmed_evidence) AS insufficient_evidence_keyword_only,
  count(*) FILTER (WHERE is_unpaid) AS unpaid_orders,
  count(*) FILTER (WHERE is_deposit_or_partial_paid) AS deposit_or_partial_paid_orders,
  count(*) FILTER (WHERE is_full_paid_or_settled) AS full_paid_or_settled_orders,
  count(*) FILTER (WHERE has_confirmed_evidence AND is_unpaid) AS clean_verified_candidates,
  count(*) FILTER (WHERE NOT has_confirmed_evidence OR NOT is_unpaid) AS owner_manual_review_required,
  coalesce(sum(total_due_vnd), 0) AS total_order_value_vnd,
  coalesce(sum(estimated_paid_vnd), 0) AS total_collected_vnd,
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
    o.order_time,
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
    dl.last_delete_log_at,
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
scored AS (
  SELECT
    rc.*,
    (
      rc.has_delete_flag
      OR rc.delete_requested_at IS NOT NULL
      OR nullif(trim(coalesce(rc.delete_requested_by, '')), '') IS NOT NULL
      OR rc.has_ops_marker
      OR rc.delete_log_count > 0
    ) AS has_confirmed_evidence,
    CASE
      WHEN rc.full_paid THEN greatest(rc.full_paid_total, rc.total_due_vnd)
      WHEN rc.settled THEN rc.total_due_vnd
      WHEN lower(rc.payment) = '' OR lower(rc.payment) ~ 'chua|chưa' THEN 0::numeric
      WHEN lower(rc.payment) ~ '(full|da tt|đã tt|da thanh toan (du|toan bo)|đã thanh toán (đủ|toàn bộ)|thanh toan du|thanh toán đủ)' THEN rc.flower_total
      WHEN regexp_replace(lower(rc.payment), '\s+', '', 'g') ~ '([0-9][0-9.,]*)(tr|trieu|triệu)' THEN
        coalesce(NULLIF(regexp_replace((regexp_match(regexp_replace(lower(rc.payment), '\s+', '', 'g'), '([0-9][0-9.,]*)(tr|trieu|triệu)'))[1], '[^0-9.]', '', 'g'), '')::numeric, 0) * 1000000
      WHEN regexp_replace(lower(rc.payment), '\s+', '', 'g') ~ '([0-9][0-9.,]*)k' THEN
        coalesce(NULLIF(regexp_replace((regexp_match(regexp_replace(lower(rc.payment), '\s+', '', 'g'), '([0-9][0-9.,]*)k'))[1], '[^0-9.]', '', 'g'), '')::numeric, 0) * 1000
      WHEN regexp_replace(rc.payment, '[^0-9]', '', 'g') <> '' THEN
        coalesce(NULLIF(regexp_replace(rc.payment, '[^0-9]', '', 'g'), '')::numeric, 0)
      WHEN lower(rc.payment) ~ '(da thanh toan|đã thanh toán|coc|cọc|ck|chuyen khoan|chuyển khoản)' THEN rc.flower_total
      ELSE 0::numeric
    END AS estimated_paid_vnd
  FROM raw_candidates rc
)
SELECT
  id,
  order_date,
  sale,
  status,
  CASE
    WHEN NOT has_confirmed_evidence THEN 'INSUFFICIENT_EVIDENCE_KEYWORD_ONLY'
    WHEN settled OR full_paid OR has_locked_settlement THEN 'CONFIRMED_LOCKED_FINANCIAL_REVIEW'
    WHEN estimated_paid_vnd > 0 THEN 'CONFIRMED_PAID_OR_DEPOSIT_REVIEW'
    ELSE 'CONFIRMED_UNPAID_CANDIDATE'
  END AS classification,
  concat_ws(', ',
    CASE WHEN has_delete_flag THEN 'delete_after_sheet_sync' END,
    CASE WHEN delete_requested_at IS NOT NULL OR nullif(trim(coalesce(delete_requested_by, '')), '') IS NOT NULL THEN 'delete_requested_meta' END,
    CASE WHEN has_ops_marker THEN 'ops_note_marker' END,
    CASE WHEN delete_log_count > 0 THEN 'activity_log(' || delete_actions || ')' END,
    CASE WHEN has_keyword_prefix THEN 'keyword_prefix_[ĐÃ XÓA]' END
  ) AS evidence_sources,
  (NOT has_confirmed_evidence OR settled OR full_paid OR has_locked_settlement OR estimated_paid_vnd > 0) AS owner_manual_review_required,
  total_due_vnd,
  estimated_paid_vnd AS collected_vnd,
  CASE WHEN settled OR full_paid THEN 0::numeric ELSE greatest(0::numeric, total_due_vnd - estimated_paid_vnd) END AS related_debt_vnd,
  payment,
  settled,
  full_paid,
  has_locked_settlement,
  delete_requested_by,
  delete_requested_at,
  left(customer, 80) AS customer_preview,
  left(flower, 80) AS flower_preview
FROM scored
ORDER BY owner_manual_review_required DESC, order_date DESC, id ASC;

COMMIT;
