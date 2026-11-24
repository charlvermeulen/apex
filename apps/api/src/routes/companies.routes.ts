import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { ApiError, AuthedReq, logEv, requireAuth, requireAdmin, requireCan } from '../middleware.js';
import { COA_SYS } from '@numera/shared';

export const companies = Router();
companies.use(requireAuth);

const MAX_COS = 25; // legacy 3886

// Demo COA — extracted once from the frozen HTML (#coa-body rows + the initCOA additions).
// [code, name, type, vat, openingBalance, due]
const DEMO_COA: [string, string, string, string, number, boolean][] = [
  ['6000', 'FNB Current Account', 'Bank', '—', 412000, false],
  ['6010', 'Nedbank Savings', 'Bank', '—', 95200, false],
  ['6100', 'Accounts Receivable', 'Current Asset', '—', 479500, false],
  ['6200', 'Inventory Asset', 'Current Asset', '—', 86400, false],
  ['6210', 'Work in Progress', 'Current Asset', '—', 0, false],
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
];

// seedBlankFY port (legacy 2787–2788): fyStart or {current year}-03-01, one computed open FY.
const fyDates = (fyStart?: string | null) => {
  const st = fyStart && /^\d{4}-\d{2}-\d{2}$/.test(fyStart) ? fyStart : new Date().getUTCFullYear() + '-03-01';
  const [y, m, d] = st.split('-').map(Number);
  const en = new Date(Date.UTC(y + 1, m - 1, d - 1));
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  const sy = st.slice(0, 4), ey = iso(en).slice(0, 4);
  return { st, en: iso(en), name: sy === ey ? `FY ${sy}` : `FY ${sy}/${ey.slice(2)}` };
};

const seedCoa = async (companyId: string, withBalances: boolean) => {
  for (const [code, name, type, vat, bal, due] of DEMO_COA) {
    await q(`insert into accounts (company_id, code, name, type, vat_rate, opening_balance, active, is_system, due)
      values ($1,$2,$3,$4,$5,$6,true,$7,$8)`,
      [companyId, code, name, type, vat, withBalances ? bal : 0, COA_SYS.includes(code), due]);
  }
};

companies.get('/', async (req: AuthedReq, res, next) => {
  try {
    const rows = req.user!.role === 'admin'
      ? (await q('select id, name, seed, fy_start, reg, vat_no, created_at from companies order by created_at')).rows
      : (await q(`select c.id, c.name, c.seed, c.fy_start, c.reg, c.vat_no, c.created_at from companies c
          join user_company_access a on a.company_id = c.id where a.user_id = $1 order by c.created_at`, [req.user!.id])).rows;
    res.json(rows);
  } catch (e) { next(e); }
});

// createCompany port (legacy 3882–3905): name rules, case-insensitive unique, max 25, seed COA+FY.
companies.post('/', requireAdmin, async (req: AuthedReq, res, next) => {
  try {
    const b = z.object({ name: z.string(), seed: z.enum(['demo', 'blank']).default('blank'), fy_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.body);
    const name = b.name.trim();
    if (name.length < 2 || name.length > 80) throw new ApiError(400, 'The company name must be 2 to 80 characters.');
    const n = (await q('select count(*)::int as n from companies')).rows[0].n;
    if (n >= MAX_COS) throw new ApiError(400, `You are using the maximum of ${MAX_COS} companies. Delete an old one to add a new one.`);
    const dup = (await q('select 1 from companies where lower(btrim(name)) = lower(btrim($1))', [name])).rows[0];
    if (dup) throw new ApiError(409, 'A company with that name already exists.');
    const r = (await q(
      `insert into companies (name, seed, fy_start) values ($1,$2,$3) returning id, name, seed, fy_start, created_at`,
      [name, b.seed, b.seed === 'blank' ? (b.fy_start ?? null) : null],
    )).rows[0];
    await seedCoa(r.id, b.seed === 'demo');
    if (b.seed === 'blank') {
      const { st, en, name: fyName } = fyDates(b.fy_start ?? r.fy_start);
      await q(`insert into financial_years (company_id, name, start, end_date, status, is_current)
        values ($1,$2,$3,$4,'open',true)`, [r.id, fyName, st, en]);
    }
    await logEv(req.user!.id, req.user!.username, 'Company added', name);
    res.status(201).json(r);
  } catch (e) { next(e); }
});

// legacy 3907: FK cascade replaces the localStorage walk; admin, not current, not last.
companies.delete('/:id', requireAdmin, async (req: AuthedReq, res, next) => {
  try {
    if (req.params.id === req.companyId) throw new ApiError(400, 'You cannot delete the company you are currently signed in to.');
    const n = (await q('select count(*)::int as n from companies')).rows[0].n;
    if (n <= 1) throw new ApiError(400, 'You cannot delete the last company.');
    const cur = (await q('select name from companies where id = $1', [req.params.id])).rows[0];
    if (!cur) throw new ApiError(404, 'Company not found.');
    await q('delete from companies where id = $1', [req.params.id]);
    await logEv(req.user!.id, req.user!.username, 'Company deleted', cur.name);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// company profile (legacy COMPANY constant / apex_company_v1)
const PROFILE_COLS = 'id, name, reg, vat_no, itax, paye_ref, sdl_ref, addr, post, bank_details, logo_url, currency, tax_rate';

companies.get('/profile/:id', requireAuth, async (req, res, next) => {
  try {
    const r = (await q(`select ${PROFILE_COLS} from companies where id = $1`, [req.params.id])).rows[0];
    if (!r) throw new ApiError(404, 'Company not found.');
    res.json(r);
  } catch (e) { next(e); }
});

companies.put('/profile/:id', requireCan('settings', 'company'), async (req: AuthedReq, res, next) => {
  try {
    const b = z.object({
      name: z.string().min(2).max(80).optional(), reg: z.string().optional(), vat_no: z.string().optional(),
      itax: z.string().optional(), paye_ref: z.string().optional(), sdl_ref: z.string().optional(),
      addr: z.string().optional(), post: z.string().optional(), bank_details: z.string().optional(),
      logo_url: z.string().nullable().optional(), tax_rate: z.number().min(0).max(1).optional(),
    }).parse(req.body);
    const sets: string[] = [], params: unknown[] = [];
    for (const [k, v] of Object.entries(b)) if (v !== undefined) { sets.push(`${k} = $${params.length + 1}`); params.push(v); }
    if (!sets.length) return res.json({ ok: true });
    params.push(req.params.id);
    const r = (await q(`update companies set ${sets.join(', ')} where id = $${params.length} returning ${PROFILE_COLS}`, params)).rows[0];
    if (!r) throw new ApiError(404, 'Company not found.');
    await logEv(req.user!.id, req.user!.username, 'Company settings saved', '', req.params.id as string);
    res.json(r);
  } catch (e) { next(e); }
});
