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

    // ── batch 2 demo master data (ENQ.cust/ENQ.sup/STK/CATS/NIT seeds port) ──
    const CUST = [
      ['CUST-001', 'Woolworths Ltd', 'accounts@woolworths.co.za', '4001234567', 500000, '30 days'],
      ['CUST-002', 'Shoprite Holdings', 'finance@shoprite.co.za', '4002345678', 300000, '30 days'],
      ['CUST-003', 'MTN Group', 'ap@mtn.co.za', '4003456789', 400000, '30 days'],
      ['CUST-004', 'Naspers Ltd', 'finance@naspers.com', '4004567890', 250000, '30 days'],
      ['CUST-005', 'Standard Bank', 'procurement@standardbank.co.za', '4005678901', 600000, '30 days'],
    ];
    for (const [code, name, email, vat, limit, terms] of CUST)
      await db.query('insert into customers (company_id, code, name, email, vat_no, credit_limit, terms) values ($1,$2,$3,$4,$5,$6,$7)',
        [co.id, code, name, email, vat, limit, terms]);

    const SUP = [
      ['SUP-001', 'Bidvest Facilities', 'creditors@bidvest.co.za', '4009123456', '2000', '30 days'],
      ['SUP-002', 'Eskom Holdings', 'accounts@eskom.co.za', '4008987654', '4030', '30 days'],
      ['SUP-003', 'Vodacom Business', 'ar@vodacom.co.za', '4007654321', '4040', '30 days'],
      ['SUP-004', 'Massdiscounters', 'supplies@massdiscounters.co.za', '4006543210', '4050', '30 days'],
      ['SUP-005', 'Outsurance', 'claims@outsurance.co.za', '4005432109', '4070', 'Monthly'],
    ];
    for (const [code, name, email, vat, exp, terms] of SUP)
      await db.query('insert into suppliers (company_id, code, name, email, vat_no, default_exp, terms) values ($1,$2,$3,$4,$5,$6,$7)',
        [co.id, code, name, email, vat, exp, terms]);

    const CATS = [
      ['CAT-01', 'Office Equipment'], ['CAT-02', 'Stationery & Supplies'], ['CAT-03', 'Technology Products'],
      ['CAT-04', 'Cleaning Supplies'], ['CAT-05', 'Safety Equipment'],
    ];
    for (const [code, name] of CATS)
      await db.query('insert into stock_categories (company_id, code, name, gl, cos, sales) values ($1,$2,$3,\'6200\',\'2000\',\'1000\')',
        [co.id, code, name]);

    const ITEMS = [
      ['OE-001', 'HP LaserJet Printer', 'CAT-01', 2800, 4200, 10, 'Each', null],
      ['OE-002', 'Ergonomic Office Chair', 'CAT-01', 1650, 2800, 5, 'Each', null],
      ['SS-001', 'A4 Copy Paper (500 sheets)', 'CAT-02', 68, 95, 100, 'Ream', null],
      ['SS-002', 'Whiteboard Markers (Pk 6)', 'CAT-02', 42, 65, 12, 'Pack', null],
      ['TP-001', 'Logitech Wireless Mouse', 'CAT-03', 280, 420, 30, 'Each', null],
      ['TP-002', 'USB-C Hub (7-port)', 'CAT-03', 490, 750, 8, 'Each', null],
      ['CS-001', 'Multi-Surface Cleaner 5L', 'CAT-04', 85, 130, 40, 'Litre', null],
    ];
    const MOVES = [
      ['OE-001', '2025-03-05', 'GRN-2025-011', 5],
      ['SS-001', '2025-03-03', 'GRN-2025-012', 60],
    ];
    for (const [sku, name, cat, cost, sell, open, unit, sup] of ITEMS)
      await db.query(`insert into stock_items (company_id, sku, name, cat_code, unit, cost, sell, opening_qty, vat)
        values ($1,$2,$3,$4,$5,$6,$7,$8,'Standard 15%')`, [co.id, sku, name, cat, unit, cost, sell, open]);
    for (const [sku, date, ref, qty] of MOVES)
      await db.query(`insert into stock_moves (company_id, sku, move_date, ref, description, qty_in)
        values ($1,$2,$3,$4,$5,$6)`, [co.id, sku, date, ref, 'Goods received', qty]);

    for (const [code, name, price] of [
      ['NI-001', 'Professional Services', 850], ['NI-002', 'Delivery / Freight', 150], ['NI-003', 'Installation Labour', 600],
    ])
      await db.query('insert into sales_item_types (company_id, code, name, price, gl, vat) values ($1,$2,$3,$4,\'1000\',\'15\')',
        [co.id, code, name, price]);

    // demo party-ledger display rows — sum to the seeded AR/AP opening balances (parity with legacy ENQ seeds)
    // [party_code, date, ref, doc_type, desc, dr, cr]
    const PL = [
      ['cust', 'CUST-001', '2025-02-12', 'SI-2025-036', 'Sales Invoice', 69000, 0],
      ['cust', 'CUST-001', '2025-02-15', 'CN-2025-006', 'Credit Note', 0, 5750],
      ['cust', 'CUST-001', '2025-02-28', 'RCP-2025-022', 'Receipt', 0, 63250],
      ['cust', 'CUST-001', '2025-03-12', 'SI-2025-041', 'Sales Invoice', 128400, 0],
      ['cust', 'CUST-002', '2025-03-10', 'SI-2025-040', 'Sales Invoice', 84200, 0],
      ['cust', 'CUST-003', '2025-03-05', 'SI-2025-039', 'Sales Invoice', 210000, 0],
      ['cust', 'CUST-003', '2025-03-23', 'RCP-2025-023', 'Receipt', 0, 210000],
      ['cust', 'CUST-004', '2025-03-01', 'SI-2025-038', 'Sales Invoice', 56900, 0],
      ['cust', 'CUST-005', '2025-03-02', 'SI-2025-037', 'Sales Invoice', 210000, 0],
      ['sup', 'SUP-001', '2025-03-01', 'PI-2025-022', 'Supplier Invoice', 0, 24000],
      ['sup', 'SUP-002', '2025-03-05', 'PI-2025-021', 'Supplier Invoice', 0, 9500],
      ['sup', 'SUP-003', '2025-02-01', '—', 'Opening Balance', 0, 5000],
      ['sup', 'SUP-004', '2025-02-01', '—', 'Opening Balance', 0, 2500],
      ['sup', 'SUP-005', '2025-02-01', '—', 'Opening Balance', 0, 3200],
    ];
    const PL_DESC = { 'PI-2025-022': 'Invoice BID-9821 — Rent', 'PI-2025-021': 'Invoice ESK-44321 — Electricity' };
    for (const [type, pc, date, ref, doc, dr, cr] of PL)
      await db.query(`insert into party_ledger (company_id, party_type, party_code, entry_date, ref, doc_type, description, debit, credit)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [co.id, type, pc, date, ref, doc, PL_DESC[ref] ?? (doc === 'Opening Balance' ? 'Opening balance' : doc), dr, cr]);

    await db.query('commit');
    console.log('seeded: 4 demo users, Demo Company (Pty) Ltd + COA + 3 FYs + batch 2 demo data');
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
};

try { await seed(); } finally { await db.end(); }
