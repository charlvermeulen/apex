-- Batch 5: purchase orders + goods received + asset buy-backs & conversions (legacy DATA.po/grn/bb/cnv)

create table purchase_orders (
  company_id uuid not null references companies(id) on delete cascade,
  id text not null,
  supplier_code text not null,
  order_date date not null,
  due_date date not null,
  ref text null,
  deliver_to text null,
  ordered_by text null,
  notes text null,
  status text not null default 'Draft',
  approved_date date null,
  received_date date null,
  created date not null default current_date,
  foreign key (company_id, supplier_code) references suppliers (company_id, code) on update cascade on delete restrict,
  foreign key (company_id, ordered_by) references employees (company_id, code) on delete set null,
  primary key (company_id, id)
);

create table purchase_order_lines (
  company_id uuid not null,
  po_id text not null,
  seq int not null,
  stock_sku text null,
  descr text not null,
  qty numeric not null,
  price numeric not null,
  vat numeric not null default 15,
  primary key (company_id, po_id, seq)
);

create table goods_received (
  company_id uuid not null references companies(id) on delete cascade,
  id text not null,
  po_id text not null,
  supplier_code text not null,
  rec_date date not null,
  dn_ref text null,
  location text null,
  invoice_id text null,            -- supplier invoice that matched this note
  foreign key (company_id, po_id) references purchase_orders (company_id, id) on delete cascade,
  foreign key (company_id, supplier_code) references suppliers (company_id, code) on update cascade on delete restrict,
  primary key (company_id, id)
);

create table goods_received_lines (
  company_id uuid not null,
  grn_id text not null,
  seq int not null,
  po_line int not null,
  descr text not null,
  qty numeric not null,
  primary key (company_id, grn_id, seq)
);

create table asset_buybacks (
  company_id uuid not null references companies(id) on delete cascade,
  id text not null,
  buyback_date date not null,
  asset_code text not null,
  descr text null,
  cust_code text not null,
  to_type text not null,           -- 'company' | 'warehouse'
  price numeric not null,
  vat numeric not null default 0,
  total numeric not null,
  settle text not null,            -- 'credit' | 'bank'
  ref text null,
  notes text null,
  journal_id uuid null references journals on delete set null,
  foreign key (company_id, asset_code) references assets (company_id, code) on delete cascade,
  foreign key (company_id, cust_code) references customers (company_id, code) on delete restrict,
  primary key (company_id, id)
);

create table asset_conversions (
  company_id uuid not null references companies(id) on delete cascade,
  id text not null,
  conv_date date not null,
  asset_code text not null,
  descr text null,
  value numeric not null,
  from_acc text not null,
  to_acc text not null,
  notes text null,
  journal_id uuid null references journals on delete set null,
  foreign key (company_id, asset_code) references assets (company_id, code) on delete cascade,
  primary key (company_id, id)
);

-- supplier invoices can now be captured against a GRN (legacy g.inv)
alter table supplier_invoices add column if not exists grn_id text null;
alter table supplier_invoices add column if not exists po_id text null;
alter table supplier_invoices add constraint supplier_invoices_grn
  foreign key (company_id, grn_id) references goods_received (company_id, id) on update cascade on delete set null;

-- conversions/buy-backs rewrite purchase_date (legacy a.date = event date); original kept in acq_date
alter table assets add column if not exists acq_date date null;
