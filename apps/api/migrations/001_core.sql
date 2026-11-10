create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(btrim(name)) between 2 and 80),
  seed text not null default 'blank' check (seed in ('demo','blank')),
  fy_start date,
  reg text, vat_no text, itax text, paye_ref text, sdl_ref text,
  addr text, post text, bank_details text, logo_url text,
  currency text not null default 'ZAR',
  tax_rate numeric(5,4) not null default 0.2700,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique check (username ~ '^[a-z0-9._-]{3,30}$'),
  name text not null,
  email text not null unique,
  role text not null check (role in ('admin','accountant','bookkeeper','viewer')),
  password_hash text not null,
  must_change boolean not null default false,
  status text not null default 'active' check (status in ('active','disabled')),
  failed_attempts int not null default 0,
  locked_until timestamptz,
  last_login timestamptz,
  access_overrides jsonb,
  created_at timestamptz not null default now()
);

create table user_company_access (
  user_id uuid not null references users(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  primary key (user_id, company_id)
);

create table sessions (
  id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  company_id uuid references companies(id) on delete cascade,   -- null until the company picker runs
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

create table app_settings (key text primary key, value jsonb not null);
insert into app_settings (key, value) values ('idle_timeout_minutes', '30');

create table activity_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid references users(id),
  username text not null default '—',
  company_id uuid references companies(id),
  action text not null,
  detail text not null default ''
);
create index on activity_log (at desc);
