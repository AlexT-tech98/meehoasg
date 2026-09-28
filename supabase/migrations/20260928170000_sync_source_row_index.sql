-- The old Sheets reorder rows when staff insert earlier orders. ID, not row,
-- is the stable identity. Retain the source-position lookup without uniqueness.
drop index if exists public.orders_source_idx;
create index orders_source_idx on public.orders(source_sheet, source_row)
  where source_sheet is not null and source_row is not null;
