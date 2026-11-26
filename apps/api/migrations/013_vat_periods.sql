-- Batch 6: VAT periods (port of legacy DATA.vatp, Numera.html 3977–4078).
-- id = start month 'YYYY-MM' (legacy id slice(0,7)); end_date mirrors financial_years.
create table if not exists vat_periods (
  company_id uuid not null references companies(id) on delete cascade,
  id text not null check (id ~ '^\\d{4}-(0[1-9]|1[0-2])$'),
  start date not null,
  end_date date not null,
  status text not null default 'open' check (status in ('open','closed')),
  closed_at date,
  closed_by text,
  submitted_at date,
  snap jsonb,                       -- legacy snapshot: {outEx,out,inEx,inn,net,docs}
  primary key (company_id, id)
);
