-- composite FK set-null must only clear grn_id (company_id is NOT NULL; clearing both violates it)
alter table supplier_invoices drop constraint supplier_invoices_grn;
alter table supplier_invoices add constraint supplier_invoices_grn
  foreign key (company_id, grn_id) references goods_received (company_id, id)
  on update cascade on delete set null (grn_id);
