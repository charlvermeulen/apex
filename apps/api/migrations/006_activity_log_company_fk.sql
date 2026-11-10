-- activity_log.company_id blocked company deletion (log rows outlive companies) — set null on delete.
alter table activity_log
  drop constraint activity_log_company_id_fkey,
  add constraint activity_log_company_id_fkey foreign key (company_id) references companies(id) on delete set null;
