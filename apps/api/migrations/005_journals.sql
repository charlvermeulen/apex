create table journals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  fy_id uuid references financial_years(id),
  journal_date date not null,
  ref text not null,
  src text not null,
  src_type text,
  src_id text,
  description text,
  posted_by uuid references users(id),
  posted_at timestamptz not null default now(),
  reverse_of uuid references journals(id)
);
create index on journals (company_id, journal_date);

create table journal_lines (
  journal_id uuid not null references journals(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  seq int not null,
  account_code varchar(4) not null,
  description text,
  debit numeric(14,2) not null default 0 check (debit >= 0),
  credit numeric(14,2) not null default 0 check (credit >= 0),
  primary key (journal_id, seq),
  foreign key (company_id, account_code) references accounts (company_id, code),
  constraint line_one_side check ((debit = 0 or credit = 0) and (debit > 0 or credit > 0))
);
create index on journal_lines (company_id, account_code);
