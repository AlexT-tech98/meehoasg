-- TC-14 Legacy [ĐÃ XÓA] / delete_after_sheet_sync Dry-Run Inspection (READ-ONLY)
-- Safe to run on Staging or Production without modifying any rows.
-- Reports candidate count, payment/deposit breakdown, financial impact, and full order list.

with legacy_candidates as (
  select
    o.id,
    o.order_date,
    o.customer,
    o.flower,
    o.note,
    o.sale,
    o.status,
    o.settled,
    o.full_paid,
    o.flower_total,
    o.payment,
    coalesce(o.full_paid_total, 0) as full_paid_total,
    case
      when coalesce(o.full_paid, false) then greatest(coalesce(o.full_paid_total, 0), coalesce(o.flower_total, 0))
      when coalesce(o.settled, false) then coalesce(o.flower_total, 0)
      when lower(coalesce(o.payment, '')) ~ '(coc|da tt|da thanh toan|full|chuyen khoan|ck|thu )'
        and lower(coalesce(o.payment, '')) !~ 'chua' then 1
      else 0
    end > 0 as has_recorded_payment,
    o.delete_after_sheet_sync,
    o.delete_requested_by,
    o.delete_requested_at,
    exists (
      select 1
      from public.settlement_requests sr
      where sr.order_id = o.id
        and sr.status in ('PENDING', 'APPROVED')
    ) as has_locked_settlement
  from public.orders o
  where coalesce((to_jsonb(o)->>'is_deleted')::boolean, false) = false
    and (
      coalesce(o.delete_after_sheet_sync, false) = true
      or o.customer like '[ĐÃ XÓA]%'
      or o.flower like '[ĐÃ XÓA]%'
      or o.note like '%[ĐÃ XÓA TRÊN OPS]%'
    )
)
select
  count(*) as total_candidates,
  count(*) filter (where settled or full_paid or has_locked_settlement) as locked_financial_review,
  count(*) filter (where not settled and not full_paid and not has_locked_settlement and has_recorded_payment) as deposit_or_partial_payment_review,
  count(*) filter (where not settled and not full_paid and not has_locked_settlement and not has_recorded_payment) as clean_auto_convertible,
  coalesce(sum(flower_total), 0) as total_flower_value_vnd,
  coalesce(sum(flower_total) filter (where settled or full_paid or has_locked_settlement or has_recorded_payment), 0) as financial_impact_flower_vnd
from legacy_candidates;

select
  id,
  order_date,
  sale,
  status,
  flower_total,
  payment,
  settled,
  full_paid,
  delete_after_sheet_sync,
  delete_requested_by,
  delete_requested_at,
  left(customer, 80) as customer_preview,
  left(flower, 80) as flower_preview
from public.orders o
where coalesce((to_jsonb(o)->>'is_deleted')::boolean, false) = false
  and (
    coalesce(o.delete_after_sheet_sync, false) = true
    or o.customer like '[ĐÃ XÓA]%'
    or o.flower like '[ĐÃ XÓA]%'
    or o.note like '%[ĐÃ XÓA TRÊN OPS]%'
  )
order by order_date desc, id asc;
