-- Thêm cột sync_hash, synced_at vào orders (nếu chưa có)
alter table public.orders
  add column if not exists sync_hash text,
  add column if not exists synced_at timestamptz;

-- Bảng ghi log mỗi lần sync chạy
create table if not exists public.sync_runs (
  id bigint generated always as identity primary key,
  entity text not null default 'orders',
  received integer not null default 0,
  inserted integer not null default 0,
  updated integer not null default 0,
  unchanged integer not null default 0,
  skipped integer not null default 0,
  errors integer not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  detail jsonb
);

-- Bảng lưu con trỏ dòng cuối mỗi tab (thay Script Properties)
create table if not exists public.sync_cursors (
  source_sheet text primary key,
  last_source_row integer not null default 1,
  updated_at timestamptz not null default now()
);

-- RLS + quyền
alter table public.sync_runs enable row level security;
alter table public.sync_cursors enable row level security;
revoke all on public.sync_runs, public.sync_cursors from anon, authenticated;
grant all on public.sync_runs, public.sync_cursors to service_role;
grant usage, select on sequence public.sync_runs_id_seq to service_role;
