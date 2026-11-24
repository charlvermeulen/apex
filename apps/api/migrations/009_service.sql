-- Batch 4: service calls, call requests, work orders (WIP), SLA targets,
-- call types, part requests/returns (inventory), asset service history,
-- asset depreciation, and the Work in Progress control account 6210.

create table call_types (
  company_id uuid not null references companies(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  descr text,
  active boolean not null default true,
  primary key (company_id, name)
);
create unique index call_types_unique_name on call_types (company_id, lower(btrim(name)));

create table sla_targets (
  company_id uuid not null references companies(id) on delete cascade,
  pri text not null check (pri in ('Urgent','High','Normal','Low')),
  resp int not null check (resp between 0 and 365),
  res int not null check (res between 0 and 365),
  primary key (company_id, pri)
);

create table service_calls (
  company_id uuid not null references companies(id) on delete cascade,
  code text not null check (code ~ '^SC-[0-9]{4,}$'),
  cust_code text not null,
  asset_code text not null,
  type text not null,
  pri text not null check (pri in ('Urgent','High','Normal','Low')),
  descr text not null check (char_length(btrim(descr)) between 1 and 300),
  status text not null default 'Logged' check (status in ('Logged','Assigned','In progress','On hold','Completed','Cancelled')),
  tech_code text,
  logged date not null,
  sched date,
  completed date,
  hours numeric(6,2) not null default 0 check (hours >= 0),
  cost numeric(14,2) not null default 0 check (cost >= 0),
  res text,
  svc_logged boolean not null default false,   -- completed work written to asset service history
  n_created date,                               -- service-notification sent dates (outbox batch)
  n_done date,
  primary key (company_id, code),
  foreign key (company_id, cust_code) references customers(company_id, code) on update cascade on delete restrict,
  foreign key (company_id, asset_code) references assets(company_id, code) on update cascade on delete restrict,
  foreign key (company_id, tech_code) references employees(company_id, code) on update cascade on delete restrict
);
create index service_calls_company on service_calls (company_id, status);

create table call_requests (
  company_id uuid not null references companies(id) on delete cascade,
  code text not null check (code ~ '^RQ-[0-9]{4,}$'),
  cust_code text not null,
  asset_code text not null,
  contact text not null,
  phone text,
  pri text not null check (pri in ('Urgent','High','Normal','Low')),
  received date not null,
  descr text not null check (char_length(btrim(descr)) between 1 and 300),
  status text not null default 'New' check (status in ('New','Converted','Declined')),
  reason text,
  call_code text,
  primary key (company_id, code),
  foreign key (company_id, cust_code) references customers(company_id, code) on update cascade on delete restrict,
  foreign key (company_id, asset_code) references assets(company_id, code) on update cascade on delete restrict,
  foreign key (company_id, call_code) references service_calls(company_id, code) on update cascade
);

create table work_orders (
  company_id uuid not null references companies(id) on delete cascade,
  code text not null check (code ~ '^WO-[0-9]{4,}$'),
  call_code text not null,
  tech_code text,
  sched date,
  status text not null default 'Issued' check (status in ('Issued','In progress','Completed','Cancelled')),
  hours numeric(6,2) not null default 0 check (hours >= 0),
  instr text not null check (char_length(btrim(instr)) between 1 and 500),
  completed date,
  notes text,
  created date not null,
  primary key (company_id, code),
  foreign key (company_id, call_code) references service_calls(company_id, code) on update cascade on delete restrict,
  foreign key (company_id, tech_code) references employees(company_id, code) on update cascade on delete restrict
);
create index work_orders_call on work_orders (company_id, call_code);

create table wo_parts (
  company_id uuid not null references companies(id) on delete cascade,
  wo_code text not null,
  seq int not null,
  descr text not null,
  item_sku text,
  qty numeric(12,3) not null default 0 check (qty >= 0),
  cost numeric(14,2) not null default 0 check (cost >= 0),
  pr_code text,                                 -- linked part request (informational)
  primary key (company_id, wo_code, seq),
  foreign key (company_id, wo_code) references work_orders(company_id, code) on update cascade on delete cascade
);

-- parts issued from stock (inventory ▸ transactions); glWip (5518) materialises on issue/return/completion
create table part_requests (
  company_id uuid not null references companies(id) on delete cascade,
  code text not null check (code ~ '^PR-[0-9]{4,}$'),
  request_date date not null,
  sku text not null,
  qty numeric(12,3) not null default 0 check (qty > 0),
  by_code text,
  wo_code text,
  notes text,
  status text not null default 'Requested' check (status in ('Requested','Issued','Cancelled')),
  issued date,
  cost numeric(14,2),
  primary key (company_id, code),
  foreign key (company_id, sku) references stock_items(company_id, sku) on update cascade on delete restrict,
  foreign key (company_id, by_code) references employees(company_id, code) on update cascade on delete set null,
  foreign key (company_id, wo_code) references work_orders(company_id, code) on update cascade
);
create index part_requests_company on part_requests (company_id, status);

create table part_returns (
  company_id uuid not null references companies(id) on delete cascade,
  code text not null check (code ~ '^PT-[0-9]{4,}$'),
  pr_code text not null,
  sku text not null,
  qty numeric(12,3) not null default 0 check (qty > 0),
  cond text not null check (cond in ('Good — back to stock','Damaged — not restocked')),
  reason text not null,
  return_date date not null,
  primary key (company_id, code),
  foreign key (company_id, pr_code) references part_requests(company_id, code) on update cascade on delete restrict,
  foreign key (company_id, sku) references stock_items(company_id, sku) on update cascade on delete restrict
);

create table asset_services (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  asset_code text not null,
  entry_date date not null,
  type text not null,
  sup text,
  cost numeric(14,2) not null default 0 check (cost >= 0),
  next date,
  notes text,
  foreign key (company_id, asset_code) references assets(company_id, code) on update cascade on delete restrict
);
create index asset_services_lookup on asset_services (company_id, asset_code, entry_date);

create table asset_depreciation (
  company_id uuid not null references companies(id) on delete cascade,
  asset_code text not null,
  month char(7) not null check (month ~ '^\d{4}-\d{2}$'),
  amount numeric(14,2) not null default 0 check (amount >= 0),
  primary key (company_id, asset_code, month),
  foreign key (company_id, asset_code) references assets(company_id, code) on update cascade on delete restrict
);

-- GL_WIP (5516): ensureWIP created 6210 on demand — backfill every company missing it
insert into accounts (company_id, code, name, type, vat_rate, opening_balance, active, is_system, due)
select id, '6210', 'Work in Progress', 'Current Asset', '—', 0, true, false, false
  from companies
 where not exists (select 1 from accounts a where a.company_id = companies.id and a.code = '6210');

-- call-type defaults (SVT_DEF 5488)
insert into call_types (company_id, name, descr)
select id, t.name, t.descr from companies,
  (values ('Breakdown',''), ('Routine service',''), ('Installation',''), ('Inspection','')) as t(name, descr)
 where not exists (select 1 from call_types ct where ct.company_id = companies.id and ct.name = t.name);

-- SLA defaults (SLA_DEF 4456)
insert into sla_targets (company_id, pri, resp, res)
select id, t.pri, t.resp, t.res from companies,
  (values ('Urgent',0,1), ('High',1,2), ('Normal',2,5), ('Low',5,10)) as t(pri, resp, res)
 where not exists (select 1 from sla_targets s where s.company_id = companies.id and s.pri = t.pri);
