create table accounts (
  company_id uuid not null references companies(id) on delete cascade,
  code varchar(4) not null check (code ~ '^[1-9][0-9]{3}$'),
  name text not null check (char_length(btrim(name)) between 2 and 60),
  type text not null,
  vat_rate text not null default '—',
  opening_balance numeric(14,2) not null default 0 check (abs(opening_balance) <= 1e12),
  active boolean not null default true,
  is_system boolean not null default false,
  due boolean not null default false,
  primary key (company_id, code)
);
create unique index accounts_unique_name on accounts (lower(btrim(name)), company_id);
