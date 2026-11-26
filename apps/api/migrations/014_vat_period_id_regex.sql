-- 013 shipped a bad regex: in the SQL literal '\\d{4}' became a literal backslash+d,
-- so any valid 'YYYY-MM id' failed vat_periods_id_check. Replace the constraint.
alter table vat_periods drop constraint vat_periods_id_check;
alter table vat_periods add constraint vat_periods_id_check check (id ~ '^\d{4}-(0[1-9]|1[0-2])$');
