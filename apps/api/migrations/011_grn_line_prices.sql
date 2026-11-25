-- GRN lines carry the PO line's price/vat (legacy grnVal + supplier-invoice prefill per grnVal 5077)
alter table goods_received_lines add column if not exists price numeric not null default 0;
alter table goods_received_lines add column if not exists vat numeric not null default 0;
