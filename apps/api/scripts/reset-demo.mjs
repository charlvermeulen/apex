// Dev convenience: wipe all app tables so `npm run seed` reseeds from scratch.
// npm run reset-demo -w @numera/api
import pg from 'pg';

const db = new pg.Client({ connectionString: process.env.NEON_DATABASE_URL });
await db.connect();
await db.query(`truncate table
  activity_log, sessions, journals, journal_lines, party_ledger, stock_moves,
  receipts, credit_notes, debit_notes, sales_invoice_lines, sales_invoices, supplier_invoices,
  stock_items, stock_categories, sales_item_types, customers, suppliers,
  contract_escalations, contract_invoice_lines, meter_readings, contract_invoices,
  billing_periods, contract_meters, contract_lines, contracts, employees,
  meter_types, contract_types, assets,
  financial_years, accounts, user_company_access, email_settings, app_settings,
  companies, users
  restart identity cascade`);
console.log('all app tables truncated');
await db.end();
