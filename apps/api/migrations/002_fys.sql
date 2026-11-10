create table financial_years (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  start date not null,
  end_date date not null,
  status text not null default 'open' check (status in ('open','closed')),
  is_current boolean not null default false,
  closed_by uuid references users(id),
  closed_at timestamptz,
  history jsonb not null default '[]',
  created_at timestamptz not null default now(),
  unique (company_id, name),
  check (end_date > start)
);
create unique index fy_one_current on financial_years (company_id) where is_current;
