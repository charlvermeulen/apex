// Idempotent demo seed: 4 demo users (must_change=true), demo company with profile,
// COA (balances from the frozen page) and 3 financial years (seedFY port).
// Run after migrate: npm run seed -w @numera/api
import pg from 'pg';
import { hashPw } from '../src/scrypt.js';

// same table as companies.routes.ts DEMO_COA — keep in sync
const DEMO_COA = Object.fromEntries([
  ['6000', 'FNB Current Account', 'Bank', '—', 412000, false],
  ['6010', 'Nedbank Savings', 'Bank', '—', 95200, false],
  ['6100', 'Accounts Receivable', 'Current Asset', '—', 479500, false],
  ['6200', 'Inventory Asset', 'Current Asset', '—', 86400, false],
  ['6300', 'VAT Input (Claimable)', 'Tax Asset', '01', 62400, false],
  ['5000', 'Property & Equipment', 'Fixed Asset', '—', 1240000, false],
  ['5010', 'Accumulated Depreciation', 'Contra Asset', '—', -18600, false],
  ['9000', 'Accounts Payable', 'Current Liability', '—', 318700, false],
  ['9100', 'VAT Output (Payable)', 'Tax Liability', '01', 94860, true],
  ['9200', 'PAYE Payable', 'Tax Liability', '—', 38240, true],
  ['9210', 'UIF Payable', 'Tax Liability', '—', 4120, true],
  ['7000', 'Share Capital', 'Equity', '—', 1000000, false],
  ['7010', 'Retained Earnings', 'Equity', '—', 586580, false],
  ['1000', 'Sales — Standard VAT', 'Income', '01', 842600, false],
  ['1010', 'Sales — Zero Rated', 'Income', '02', 0, false],
  ['3000', 'Interest Income', 'Income', '—', 8400, false],
  ['2000', 'Cost of Sales', 'Expense', '01', 380200, false],
  ['4000', 'Salaries & Wages', 'Expense', '—', 92400, false],
  ['4010', 'Rent & Occupancy', 'Expense', '01', 24000, false],
  ['4020', 'Depreciation', 'Expense', '—', 18600, false],
  ['4030', 'Utilities', 'Expense', '01', 0, false],
  ['4040', 'Telecoms', 'Expense', '01', 0, false],
  ['4050', 'Office Supplies', 'Expense', '01', 0, false],
  ['4060', 'Bank Charges', 'Expense', '—', 0, false],
  ['4070', 'Insurance', 'Expense', '—', 0, false],
  ['4080', 'Bad Debts Written Off', 'Expense', '—', 0, false],
].map((r) => [r[0], r]));
const SYS = ['6000','6010','6100','6200','6210','5020','6300','5000','5010','9000','9100','7010','1000','2000','4020'];

// legacy DEMO (Numera.html:2586) — demo-grade: every seeded user must change password on first sign-in
const DEMO_USERS = [
  ['admin', 'System Administrator', 'admin@numera.co.za', 'admin', 'Admin@2025'],
  ['nomsa', 'Nomsa Sithole', 'nomsa@numera.co.za', 'accountant', 'Nomsa@2025'],
  ['thabo', 'Thabo Mokoena', 'thabo@numera.co.za', 'bookkeeper', 'Thabo@2025'],
  ['pieter', 'Pieter de Wet', 'pieter@numera.co.za', 'viewer', 'Pieter@2025'],
];

const db = new pg.Client({ connectionString: process.env.NEON_DATABASE_URL });
await db.connect();

const seed = async () => {
  const n = (await db.query('select count(*)::int as n from users')).rows[0].n;
  if (n > 0) { console.log('already seeded (%d users) — skipping', n); return; }
  await db.query('begin');
  try {
    await db.query('insert into companies (name, seed, reg, vat_no, addr, bank_details) values ($1,$2,$3,$4,$5,$6)',
      ['Demo Company (Pty) Ltd', 'demo', '2018/123456/07', '4012345678', '123 Commissioner Street, Johannesburg, 2001', 'FNB · Acc 62012345678 · Branch 250655']);
    const co = (await db.query("select id from companies where name = 'Demo Company (Pty) Ltd'")).rows[0];

    for (const [u, n2, e, r, p] of DEMO_USERS)
      await db.query(`insert into users (username, name, email, role, password_hash, must_change) values ($1,$2,$3,$4,$5,true)`,
        [u, n2, e, r, hashPw(p)]);

    for (const [code, name, type, vat, bal, due] of Object.values(DEMO_COA))
      await db.query(`insert into accounts (company_id, code, name, type, vat_rate, opening_balance, active, is_system, due)
        values ($1,$2,$3,$4,$5,$6,true,$7,$8)`,
        [co.id, code, name, type, vat, bal, SYS.includes(code), due]);

    // seedFY port (legacy 2779–2785): income/expenses/closing columns deferred to the report batch
    await db.query(`insert into financial_years (company_id, name, start, end_date, status, is_current, history)
      values ($1,'FY 2023/24','2023-04-01','2024-03-31','closed',false,$2::jsonb)`,
      [co.id, JSON.stringify([{ t: Date.parse('2024-05-15T10:00:00'), user: 'system', action: 'Closed', note: 'Year-end close (opening data)' }])]);
    await db.query(`insert into financial_years (company_id, name, start, end_date, status, is_current) values ($1,'FY 2024/25','2024-04-01','2025-03-31','open',true)`, [co.id]);
    await db.query(`insert into financial_years (company_id, name, start, end_date, status, is_current) values ($1,'FY 2025/26','2025-04-01','2026-03-31','open',false)`, [co.id]);

    await db.query('commit');
    console.log('seeded: 4 demo users, Demo Company (Pty) Ltd + COA + 3 FYs');
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
};

try { await seed(); } finally { await db.end(); }
