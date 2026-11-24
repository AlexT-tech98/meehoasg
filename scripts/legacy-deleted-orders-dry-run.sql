-- TC-14 Legacy [ĐÃ XÓA] / delete_after_sheet_sync Dry-Run Inspection (READ-ONLY)
-- Safe to run on Staging or Production without modifying any rows.

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
    o.is_deleted,
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
  where o.is_deleted = false
    and (
      o.delete_after_sheet_sync = true
      or o.customer like '[ĐÃ XÓA]%'
      or o.flower like '[ĐÃ XÓA]%'
      or o.note like '%[ĐÃ XÓA TRÊN OPS]%'
    )
)
select
  count(*) as total_candidates,
  count(*) filter (where settled or full_paid or has_locked_settlement) as financial_review_required,
  count(*) filter (where not settled and not full_paid and not has_locked_settlement) as auto_convertible
from legacy_candidates;

select
  id,
  order_date,
  sale,
  status,
  settled,
  full_paid,
  delete_after_sheet_sync,
  delete_requested_by,
  delete_requested_at,
  left(customer, 80) as customer_preview,
  left(flower, 80) as flower_preview
from public.orders
where is_deleted = false
  and (
    delete_after_sheet_sync = true
    or customer like '[ĐÃ XÓA]%'
    or flower like '[ĐÃ XÓA]%'
    or note like '%[ĐÃ XÓA TRÊN OPS]%'
  )
order by order_date desc, id asc;
