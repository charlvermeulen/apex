-- Batch 3: assets (register), contract types / meter types, employees, contracts
-- (+ lines, meters, escalations), billing periods, meter readings, contract invoices.

create table assets (
  company_id uuid not null references companies(id) on delete cascade,
  code text not null check (code ~ '^AST-[0-9]{4,}$'),
  atype text not null default 'company' check (atype in ('company','warehouse','customer')),
  name text not null check (char_length(btrim(name)) between 2 and 80),
  cat text not null check (cat in ('Computer Equipment','Furniture & Fittings','Motor Vehicles','Plant & Machinery','Office Equipment','Tools','Printing Machines')),
  ser text, loc text, dept text, sup text,
  cust_code text,
  purchase_date date,
  cost numeric(14,2) not null default 0 check (cost >= 0),
  res numeric(14,2) not null default 0 check (res >= 0),
  life int not null default 0 check (life between 0 and 600),
  status text not null default 'Active' check (status in ('Active','Disposed')),
  disposed date,
  primary key (company_id, code),
  foreign key (company_id, cust_code) references customers(company_id, code) on update cascade on delete restrict
);

create table contract_types (
  company_id uuid not null references companies(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 40),
  asset_req text not null default 'optional' check (asset_req in ('required','optional')),
  funder boolean not null default false,
  ever boolean not null default false,
  rev varchar(4) not null,
  cos varchar(4) not null,
  active boolean not null default true,
  primary key (company_id, name),
  foreign key (company_id, rev) references accounts(company_id, code) on update cascade,
  foreign key (company_id, cos) references accounts(company_id, code) on update cascade
);
create unique index contract_types_lower_name on contract_types (company_id, lower(btrim(name)));

create table meter_types (
  company_id uuid not null references companies(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 30),
  descr text,
  rev varchar(4) not null,
  cos varchar(4) not null,
  active boolean not null default true,
  primary key (company_id, name),
  foreign key (company_id, rev) references accounts(company_id, code) on update cascade,
  foreign key (company_id, cos) references accounts(company_id, code) on update cascade
);
create unique index meter_types_lower_name on meter_types (company_id, lower(btrim(name)));

-- employees: contract managers, sales people and (from batch 4) technicians
create table employees (
  company_id uuid not null references companies(id) on delete cascade,
  code text not null check (code ~ '^EM-[0-9]{4,}$'),
  name text not null check (char_length(btrim(name)) between 2 and 80),
  email text,
  phone text,
  is_mgr boolean not null default false,
  is_sales boolean not null default false,
  is_tech boolean not null default false,
  active boolean not null default true,
  primary key (company_id, code)
);
create unique index employees_unique_name on employees (lower(btrim(name)), company_id);

create table contracts (
  company_id uuid not null references companies(id) on delete cascade,
  code text not null check (code ~ '^CON-[0-9]{4,}$'),
  cust_code text not null,
  ref text,
  status text not null default 'Active' check (status in ('Active','Draft','Suspended','Cancelled')),
  start_date date not null,
  freq int not null check (freq in (1,3,6,12)),
  esc numeric(5,2) not null default 0 check (esc between 0 and 50),
  mgr_code text,
  sales_code text,
  primary key (company_id, code),
  foreign key (company_id, cust_code) references customers(company_id, code) on update cascade on delete restrict,
  foreign key (company_id, mgr_code) references employees(company_id, code) on update cascade on delete restrict,
  foreign key (company_id, sales_code) references employees(company_id, code) on update cascade on delete restrict
);

create table contract_lines (
  company_id uuid not null references companies(id) on delete cascade,
  contract_code text not null,
  line_no int not null,
  ctype text not null,
  asset_code text,
  descr text,
  amt numeric(14,2) not null check (amt > 0),
  term int not null check (term between 1 and 120),
  start_date date not null,
  funder text,
  last_billed date,
  esc_base numeric(14,2),
  esc_history jsonb not null default '[]',
  primary key (company_id, contract_code, line_no),
  foreign key (company_id, contract_code) references contracts(company_id, code) on update cascade on delete cascade,
  foreign key (company_id, ctype) references contract_types(company_id, name) on update cascade,
  foreign key (company_id, asset_code) references assets(company_id, code) on update cascade
);

create table contract_meters (
  company_id uuid not null references companies(id) on delete cascade,
  contract_code text not null,
  meter_no int not null,
  asset_code text not null,
  mtype text not null,
  rate numeric(10,4) not null check (rate > 0),
  start_reading bigint not null default 0 check (start_reading >= 0),
  esc_base numeric(10,4),
  esc_history jsonb not null default '[]',
  primary key (company_id, contract_code, meter_no),
  foreign key (company_id, contract_code) references contracts(company_id, code) on update cascade on delete cascade,
  foreign key (company_id, asset_code) references assets(company_id, code) on update cascade,
  foreign key (company_id, mtype) references meter_types(company_id, name) on update cascade
);

create table billing_periods (
  company_id uuid not null references companies(id) on delete cascade,
  id text not null check (id ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  status text not null default 'open' check (status in ('open','closed')),
  closed_at date,
  closed_by text,
  primary key (company_id, id)
);

create table contract_invoices (
  company_id uuid not null references companies(id) on delete cascade,
  id text not null check (id ~ '^CINV-[0-9]{4,}$'),
  fy_id uuid,
  invoice_date date not null,
  contract_code text not null,
  customer_code text not null,
  excl numeric(14,2) not null default 0,
  vat numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  primary key (company_id, id),
  foreign key (fy_id) references financial_years(id),
  foreign key (company_id, contract_code) references contracts(company_id, code) on update cascade on delete restrict,
  foreign key (company_id, customer_code) references customers(company_id, code) on update cascade on delete restrict
);

create table meter_readings (
  company_id uuid not null references companies(id) on delete cascade,
  contract_code text not null,
  meter_no int not null,
  period text not null,
  end_reading bigint not null check (end_reading >= 0),
  billed boolean not null default false,
  invoice_id text,
  start_read bigint,
  rate numeric(10,4),
  pages int,
  amt numeric(14,2),
  primary key (company_id, contract_code, meter_no, period),
  foreign key (company_id, contract_code, meter_no) references contract_meters(company_id, contract_code, meter_no) on update cascade on delete restrict,
  foreign key (company_id, period) references billing_periods(company_id, id) on update cascade on delete restrict,
  foreign key (company_id, invoice_id) references contract_invoices(company_id, id) on update cascade on delete restrict
);

create table contract_invoice_lines (
  company_id uuid not null references companies(id) on delete cascade,
  invoice_id text not null,
  seq int not null,
  kind text not null check (kind in ('item','meter')),
  ctype text not null,
  descr text,
  asset_code text,
  from_d date not null,
  to_d date not null,
  excl numeric(14,2) not null,
  rev varchar(4) not null,
  cos varchar(4),
  primary key (company_id, invoice_id, seq),
  foreign key (company_id, invoice_id) references contract_invoices(company_id, id) on update cascade on delete cascade,
  -- ctype is a display snapshot (item type name or the reserved 'Meter Usage'); no FK —
  -- contract type names are rename-locked, but invoice lines must not follow later renames anyway.
  foreign key (company_id, rev) references accounts(company_id, code) on update cascade,
  foreign key (company_id, cos) references accounts(company_id, code) on update cascade
);

create table contract_escalations (
  company_id uuid not null references companies(id) on delete cascade,
  code text not null check (code ~ '^ESC-[0-9]{4,}$'),
  applied date not null,
  effective date not null,
  mode text not null check (mode in ('pct','amt')),
  val numeric(12,4) not null,
  applied_by text,
  items jsonb not null,
  primary key (company_id, code)
);
