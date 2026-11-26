-- Batch 7: budgets + financial-year closing snapshot (legacy apex_budget_v1 / fy.closing).
create table budgets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  fy_id uuid not null references financial_years(id) on delete cascade,
  code varchar(4) not null,
  months jsonb not null, -- 12 monthly amounts in FY month order (legacy budRead row)
  unique (company_id, fy_id, code)
);

-- frozen figures of the year just closed (legacy fy.closing): {ref,income,expenses,net}; cleared on reopen
alter table financial_years add column closing jsonb;
