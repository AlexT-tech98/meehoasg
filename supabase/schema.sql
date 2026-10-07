-- Meehoa Ops data model. Application tables are private to the Edge Function.
-- The browser must never receive a service-role key or read password hashes.
create table if not exists public.app_users (
  username text primary key,
  password_hash text not null,
  display_name text not null,
  role text not null check (role in ('ADMIN', 'THO_OPS', 'SALE')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.app_sessions (
  token_hash text primary key,
  username text not null references public.app_users(username) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists app_sessions_expires_idx on public.app_sessions(expires_at);
create index if not exists app_sessions_username_idx on public.app_sessions(username);

create table if not exists public.login_attempts (
  username text primary key,
  attempts integer not null default 0,
  blocked_until timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  id text primary key,
  request_id text unique,
  source_sheet text,
  source_row integer,
  customer text not null default '',
  phone text not null default '',
  order_date date not null,
  order_time text not null default '',
  flower text not null default '',
  note text not null default '',
  shipping text not null default '',
  address text not null default '',
  flower_total numeric(14,2) not null default 0,
  payment text not null default '',
  sale text not null default '',
  status text not null default 'Chờ bó' check (status in ('Chờ bó', 'Đã bó', 'Đã giao')),
  settled boolean not null default false,
  full_paid boolean not null default false,
  full_paid_total numeric(14,2) not null default 0,
  full_paid_bill_urls jsonb not null default '[]'::jsonb,
  full_paid_by text,
  full_paid_at timestamptz,
  full_paid_invalidated_at timestamptz,
  full_paid_invalidated_reason text not null default '',
  ship_fee numeric(14,2) not null default 0,
  ship_confirmed boolean not null default false,
  card boolean not null default false,
  card_text text not null default '',
  banner boolean not null default false,
  banner_text text not null default '',
  charm_fee numeric(14,2) not null default 0,
  charm_text text not null default '',
  paper_fee numeric(14,2) not null default 0,
  paper_text text not null default '',
  vat numeric(14,2) not null default 0,
  image_urls jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists orders_date_time_idx on public.orders(order_date, order_time);
create index if not exists orders_sale_date_idx on public.orders(sale, order_date);
create index if not exists idx_orders_full_paid_order_date on public.orders(full_paid, order_date);
-- Sheet rows move when older orders are inserted; the stable order ID is the
-- identity for synchronization. Source position is a non-unique lookup hint.
create index if not exists orders_source_idx on public.orders(source_sheet, source_row)
  where source_sheet is not null and source_row is not null;

create table if not exists public.settlement_requests (
  id text primary key,
  order_id text not null references public.orders(id) on delete cascade,
  sale_username text not null default '',
  sale_name text not null default '',
  flower_total numeric(14,2) not null default 0,
  accessory_total numeric(14,2) not null default 0,
  vat numeric(14,2) not null default 0,
  ship_fee numeric(14,2) not null default 0,
  required_amount numeric(14,2) not null default 0,
  bill_urls jsonb not null default '[]'::jsonb,
  note text not null default '',
  status text not null check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  submitted_at timestamptz not null default now(),
  admin_username text,
  admin_name text,
  reviewed_at timestamptz,
  rejection_reason text not null default ''
);
create index if not exists settlements_order_status_idx on public.settlement_requests(order_id, status);

create table if not exists public.kpi_operations (
  id text primary key,
  month text not null,
  event_date date,
  sale_username text not null default '',
  sale_name text not null default '',
  order_id text,
  error_type text not null default '',
  points numeric(8,2) not null default 0,
  count integer not null default 1,
  total_points numeric(8,2) not null default 0,
  note text not null default '',
  admin_username text not null default '',
  admin_name text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.activity_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  username text not null default '',
  display_name text not null default '',
  role text not null default '',
  order_id text,
  action text not null,
  before_data jsonb,
  after_data jsonb
);

create table if not exists public.flower_cache (
  fingerprint text primary key,
  content text not null,
  flowers jsonb not null default '[]'::jsonb,
  needs_review boolean not null default false,
  updated_at timestamptz
);

create table if not exists public.performance_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  api text not null,
  total_ms integer not null default 0,
  server_ms integer not null default 0,
  username text not null default '',
  role text not null default '',
  source text not null default 'CLIENT'
);
create index if not exists performance_log_api_time_idx on public.performance_log(api, occurred_at desc);

-- No browser-facing table policies: the function validates the opaque session
-- and applies role checks before querying with the service-role credential.
alter table public.app_users enable row level security;
alter table public.app_sessions enable row level security;
alter table public.login_attempts enable row level security;
alter table public.orders enable row level security;
alter table public.settlement_requests enable row level security;
alter table public.kpi_operations enable row level security;
alter table public.activity_log enable row level security;
alter table public.flower_cache enable row level security;
alter table public.performance_log enable row level security;

revoke all on public.app_users, public.app_sessions, public.login_attempts, public.orders,
  public.settlement_requests, public.kpi_operations, public.activity_log, public.flower_cache, public.performance_log
  from anon, authenticated;
grant usage on schema public to service_role;
grant all on public.app_users, public.app_sessions, public.login_attempts, public.orders,
  public.settlement_requests, public.kpi_operations, public.activity_log, public.flower_cache, public.performance_log to service_role;
grant usage, select on sequence public.activity_log_id_seq to service_role;
grant usage, select on sequence public.performance_log_id_seq to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('order-images', 'order-images', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('settlement-bills', 'settlement-bills', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
