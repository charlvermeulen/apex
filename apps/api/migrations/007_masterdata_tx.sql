-- Batch 2: master data (customers, suppliers, inventory) + AR/AP documents + postings.

create table customers (
  company_id uuid not null references companies(id) on delete cascade,
  code text not null check (code ~ '^CUST-[0-9]{3,}$'),
  name text not null check (char_length(btrim(name)) between 2 and 80),
  trading text,
  vat_no text check (vat_no is null or vat_no = '' or vat_no ~ '^4[0-9]{9}$'),
  reg_no text,
  contact text,
  email text not null check (char_length(email) <= 80),
  svc_email text,
  phone text,
  credit_limit numeric(14,2) not null default 0 check (credit_limit >= 0),
  terms text not null default '30 days' check (terms in ('30 days','60 days','7 days','COD','EOM + 30')),
  street text, suburb text, city text,
  prov text not null default 'Gauteng',
  postal_code text,
  active boolean not null default true,
  primary key (company_id, code)
);
create unique index customers_unique_name on customers (lower(btrim(name)), company_id);

create table suppliers (
  company_id uuid not null references companies(id) on delete cascade,
  code text not null check (code ~ '^SUP-[0-9]{3,}$'),
  name text not null check (char_length(btrim(name)) between 2 and 80),
  trading text,
  vat_no text check (vat_no is null or vat_no = '' or vat_no ~ '^4[0-9]{9}$'),
  reg_no text,
  contact text,
  email text not null check (char_length(email) <= 80),
  phone text,
  bank_account text,
  terms text not null default '30 days' check (terms in ('30 days','60 days','7 days','COD','EOM','Monthly')),
  street text, suburb text, city text,
  prov text not null default 'Gauteng',
  postal_code text,
  default_exp varchar(4),
  active boolean not null default true,
  primary key (company_id, code),
  foreign key (company_id, default_exp) references accounts(company_id, code) on update cascade on delete set null
);
create unique index suppliers_unique_name on suppliers (lower(btrim(name)), company_id);

-- sales item types (NIT) — backing for non-inventory sales invoice lines
create table sales_item_types (
  company_id uuid not null references companies(id) on delete cascade,
  code text not null check (code ~ '^NI-[0-9]{3,}$'),
  name text not null check (char_length(btrim(name)) between 2 and 60),
  price numeric(14,2) not null default 0,
  gl varchar(4) not null,
  vat text not null default '15' check (vat in ('15','0','e')),
  active boolean not null default true,
  primary key (company_id, code),
  foreign key (company_id, gl) references accounts(company_id, code) on update cascade
);
create unique index sales_item_types_unique_name on sales_item_types (lower(btrim(name)), company_id);

create table stock_categories (
  company_id uuid not null references companies(id) on delete cascade,
  code text not null check (code ~ '^CAT-[0-9]{2}$'),
  name text not null check (char_length(btrim(name)) between 2 and 40),
  gl varchar(4) not null,   -- inventory asset account
  cos varchar(4) not null,  -- cost of sales
  sales varchar(4) not null,-- sales income account
  active boolean not null default true,
  primary key (company_id, code),
  foreign key (company_id, gl)  references accounts(company_id, code) on update cascade,
  foreign key (company_id, cos) references accounts(company_id, code) on update cascade,
  foreign key (company_id, sales) references accounts(company_id, code) on update cascade
);
create unique index stock_categories_unique_name on stock_categories (lower(btrim(name)), company_id);

create table stock_items (
  company_id uuid not null references companies(id) on delete cascade,
  sku text not null check (char_length(btrim(sku)) between 2 and 20),
  name text not null check (char_length(btrim(name)) between 2 and 80),
  cat_code text not null,
  unit text not null default 'Each' check (unit in ('Each','Box','Ream','Pack','Litre','Kg','Metre')),
  cost numeric(14,2) not null default 0 check (cost >= 0),
  sell numeric(14,2) not null default 0 check (sell >= 0),
  opening_qty numeric(12,3) not null default 0 check (opening_qty >= 0),
  supplier_code text,
  reorder numeric(12,3) not null default 0 check (reorder >= 0),
  reorder_qty numeric(12,3) not null default 0 check (reorder_qty >= 0),
  bin text, barcode text, notes text,
  vat text not null default 'Standard 15%' check (vat in ('Standard 15%','Zero-Rated 0%','Exempt')),
  active boolean not null default true,
  primary key (company_id, sku),
  foreign key (company_id, cat_code) references stock_categories(company_id, code) on update cascade,
  foreign key (company_id, supplier_code) references suppliers(company_id, code) on update cascade on delete set null
);
create unique index stock_items_unique_name on stock_items (lower(btrim(name)), company_id);

create table stock_moves (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  sku text not null,
  move_date date not null,
  ref text not null,
  description text not null,
  qty_in numeric(12,3) not null default 0 check (qty_in >= 0),
  qty_out numeric(12,3) not null default 0 check (qty_out >= 0),
  constraint move_one_side check (qty_in = 0 or qty_out = 0),
  foreign key (company_id, sku) references stock_items(company_id, sku) on update cascade on delete cascade
);
create index stock_moves_lookup on stock_moves (company_id, sku, move_date);

-- customer/supplier ledger — materialised on posting (SI/CN/RCP/PI/DN/journals).
-- debit = increases customer owed / decreases supplier owed; credit the reverse.
create table party_ledger (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  party_type text not null check (party_type in ('cust','sup')),
  party_code text not null,
  entry_date date not null,
  ref text not null,
  doc_type text not null,
  description text not null,
  debit numeric(14,2) not null default 0 check (debit >= 0),
  credit numeric(14,2) not null default 0 check (credit >= 0),
  journal_id uuid references journals(id) on delete cascade,
  constraint pl_one_side check ((debit = 0 or credit = 0) and (debit > 0 or credit > 0))
);
create index party_ledger_lookup on party_ledger (company_id, party_type, party_code, entry_date);

-- manual GL journals & batches: posted multiline entries; batches can be saved Open.
alter table journals add column status text not null default 'Posted' check (status in ('Posted','Open'));

-- documents
create table sales_invoices (
  company_id uuid not null references companies(id) on delete cascade,
  id text not null check (id ~ '^SI-[0-9]{4}-[0-9]{3,}$'),
  fy_id uuid,
  customer_code text not null,
  invoice_date date not null,
  due_date date not null,
  ref text,
  excl numeric(14,2) not null default 0,
  vat numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  primary key (company_id, id),
  foreign key (company_id, customer_code) references customers(company_id, code) on update cascade on delete restrict,
  foreign key (fy_id) references financial_years(id)
);
create table sales_invoice_lines (
  company_id uuid not null references companies(id) on delete cascade,
  invoice_id text not null,
  seq int not null,
  line_type text not null check (line_type in ('inv','non')),
  sku text,
  description text not null,
  qty numeric(12,3) not null check (qty > 0),
  price numeric(14,2) not null check (price >= 0),
  cost numeric(14,2) not null default 0,
  vat numeric(5,2) not null check (vat in (15,0)),
  gl varchar(4) not null,
  cos varchar(4),
  invgl varchar(4),
  primary key (company_id, invoice_id, seq),
  foreign key (company_id, invoice_id) references sales_invoices(company_id, id) on update cascade on delete cascade,
  foreign key (company_id, gl) references accounts(company_id, code) on update cascade,
  foreign key (company_id, cos) references accounts(company_id, code) on update cascade,
  foreign key (company_id, invgl) references accounts(company_id, code) on update cascade
);

create table supplier_invoices (
  company_id uuid not null references companies(id) on delete cascade,
  id text not null check (id ~ '^PI-[0-9]{4}-[0-9]{3,}$'),
  fy_id uuid,
  supplier_code text not null,
  their_no text not null check (char_length(btrim(their_no)) between 1 and 40),
  invoice_date date not null,
  due_date date,
  description text,
  account varchar(4) not null,
  excl numeric(14,2) not null default 0,
  vat numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  primary key (company_id, id),
  foreign key (fy_id) references financial_years(id),
  foreign key (company_id, supplier_code) references suppliers(company_id, code) on update cascade on delete restrict,
  foreign key (company_id, account) references accounts(company_id, code) on update cascade
);
create unique index supplier_invoices_their_no on supplier_invoices (company_id, supplier_code, lower(their_no));

create table credit_notes (
  company_id uuid not null references companies(id) on delete cascade,
  id text not null check (id ~ '^CN-[0-9]{4}-[0-9]{3,}$'),
  fy_id uuid,
  customer_code text not null,
  orig_invoice text not null,
  cn_date date not null,
  reason text not null check (reason in ('Returned Goods','Pricing Error','Duplicate Invoice','Service Not Rendered','Other')),
  description text not null,
  qty numeric(12,3) not null check (qty > 0),
  price numeric(14,2) not null check (price >= 0),
  vat text not null default 'Standard 15%' check (vat in ('Standard 15%','Zero-Rated 0%','Exempt')),
  excl numeric(14,2) not null default 0,
  vat_amt numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  primary key (company_id, id),
  foreign key (fy_id) references financial_years(id),
  foreign key (company_id, customer_code) references customers(company_id, code) on update cascade on delete restrict
);

create table debit_notes (
  company_id uuid not null references companies(id) on delete cascade,
  id text not null check (id ~ '^DN-[0-9]{4}-[0-9]{3,}$'),
  fy_id uuid,
  supplier_code text not null,
  orig_invoice text not null,
  dn_date date not null,
  reason text not null check (reason in ('Returned Goods','Overcharge','Short Delivery','Quality Issue','Other')),
  description text not null,
  excl numeric(14,2) not null default 0,
  vat text not null default 'Standard 15%' check (vat in ('Standard 15%','Zero-Rated 0%','Exempt')),
  vat_amt numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  primary key (company_id, id),
  foreign key (fy_id) references financial_years(id),
  foreign key (company_id, supplier_code) references suppliers(company_id, code) on update cascade on delete restrict
);

create table receipts (
  company_id uuid not null references companies(id) on delete cascade,
  id text not null check (id ~ '^RCP-[0-9]{4}-[0-9]{3,}$'),
  fy_id uuid,
  customer_code text not null,
  receipt_date date not null,
  bank_account varchar(4) not null,
  method text not null default 'EFT' check (method in ('EFT','Cash','Card','Cheque')),
  amount numeric(14,2) not null check (amount > 0),
  bank_ref text,
  primary key (company_id, id),
  foreign key (fy_id) references financial_years(id),
  foreign key (company_id, customer_code) references customers(company_id, code) on update cascade on delete restrict,
  foreign key (company_id, bank_account) references accounts(company_id, code) on update cascade
);
