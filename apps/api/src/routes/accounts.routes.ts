import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { ApiError, AuthedReq, logEv, requireAuth, requireCan } from '../middleware.js';
import { COA_GROUPS, COA_TYPES, COA_SYS } from '@numera/shared';

export const accounts = Router();
accounts.use(requireAuth);

const COLS = 'company_id, code, name, type, vat_rate, opening_balance, active, is_system, due';

// batch-1 referential check: journal_lines only (renderCOA acctRefs port — later batches append).
const acctRefs = async (companyId: string, code: string): Promise<string[]> => {
  const r = (await q('select count(*)::int as n from journal_lines where company_id = $1 and account_code = $2', [companyId, code])).rows[0].n;
  return r ? [`${r} journal line${r > 1 ? 's' : ''}`] : [];
};

const validType = (code: string, type: string) =>
  /^\d{4}$/.test(code) && +code[0] >= 1 && +code[0] <= 9 && COA_TYPES[+code[0] - 1].includes(type);

accounts.get('/', async (req: AuthedReq, res, next) => {
  try {
    res.json((await q(`select ${COLS} from accounts where company_id = $1 order by code`, [req.companyId])).rows);
  } catch (e) { next(e); }
});

// saveAcct port (legacy 4679–4691) — create
accounts.post('/', requireCan('gl', 'maint'), async (req: AuthedReq, res, next) => {
  try {
    const b = z.object({
      code: z.string(), name: z.string(), type: z.string(),
      vat_rate: z.string().default('—'), opening_balance: z.number().default(0),
    }).parse(req.body);
    const code = b.code.trim();
    if (!/^[1-9]\d{3}$/.test(code))
      throw new ApiError(400, 'The code must be 4 digits: 1000–4999 are Income Statement accounts (1 Sales, 2 Cost of Sales, 3 Other Income, 4 Overheads) and 5000–9999 are Balance Sheet accounts (5 Non-Current Assets, 6 Current Assets, 7 Equity, 8 Non-Current Liabilities, 9 Current Liabilities).');
    const name = b.name.replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 60) throw new ApiError(400, 'The account name must be 2 to 60 characters.');
    const dupCode = (await q('select 1 from accounts where company_id = $1 and code = $2', [req.companyId, code])).rows[0];
    if (dupCode) throw new ApiError(409, 'Account ' + code + ' already exists.');
    const dupName = (await q('select 1 from accounts where company_id = $1 and lower(btrim(name)) = lower($2)', [req.companyId, name])).rows[0];
    if (dupName) throw new ApiError(409, 'An account called "' + name + '" already exists.');
    if (!validType(code, b.type)) throw new ApiError(400, 'Choose an account type that matches the category.');
    if (!Number.isFinite(b.opening_balance) || Math.abs(b.opening_balance) > 1e12) throw new ApiError(400, 'Enter a valid opening balance.');
    const r = (await q(`insert into accounts (company_id, code, name, type, vat_rate, opening_balance, due) values ($1,$2,$3,$4,$5,$6,false) returning ${COLS}`,
      [req.companyId, code, name, b.type, b.vat_rate, b.opening_balance])).rows[0];
    await logEv(req.user!.id, req.user!.username, 'Account added', `${code} ${name}`, req.companyId);
    res.status(201).json(r);
  } catch (e) { next(e); }
});

accounts.patch('/:code', requireCan('gl', 'maint'), async (req: AuthedReq, res, next) => {
  try {
    const b = z.object({
      code: z.string().optional(), name: z.string().optional(), type: z.string().optional(),
      vat_rate: z.string().optional(), active: z.boolean().optional(),
    }).parse(req.body);
    const cur = (await q(`select ${COLS} from accounts where company_id = $1 and code = $2`, [req.companyId, req.params.code])).rows[0];
    if (!cur) throw new ApiError(404, 'Account not found.');
    const sys = COA_SYS.includes(cur.code);
    const refs = await acctRefs(req.companyId!, cur.code);
    if (b.active === false && sys)
      throw new ApiError(400, 'This is a system account used by postings, so its code cannot change and it cannot be deactivated. You can still rename it.');
    if (b.active === false && cur.active && refs.length)
      throw new ApiError(400, `This account is linked to ${refs.join(', ')}, so it cannot be deactivated.`);
    let newCode = cur.code;
    if (b.code !== undefined && b.code !== cur.code) {
      if (sys) throw new ApiError(400, 'This is a system account used by postings; its code cannot change.');
      if (refs.length) throw new ApiError(400, `This account is linked to ${refs.join(', ')}, so its code is locked.`);
      const dupCode = (await q('select 1 from accounts where company_id = $1 and code = $2', [req.companyId, b.code])).rows[0];
      if (dupCode) throw new ApiError(409, 'Account ' + b.code + ' already exists.');
      if (!/^[1-9]\d{3}$/.test(b.code)) throw new ApiError(400, 'The code must be 4 digits.');
      newCode = b.code;
    }
    if (b.name !== undefined) {
      const name = b.name.replace(/\s+/g, ' ').trim();
      if (name.length < 2 || name.length > 60) throw new ApiError(400, 'The account name must be 2 to 60 characters.');
      const dupName = (await q('select 1 from accounts where company_id = $1 and lower(btrim(name)) = lower($2) and code <> $3', [req.companyId, name, newCode])).rows[0];
      if (dupName) throw new ApiError(409, 'An account called "' + name + '" already exists.');
    }
    if (b.type !== undefined && !validType(newCode, b.type)) throw new ApiError(400, 'Choose an account type that matches the category.');
    const sets: string[] = [], params: unknown[] = [];
    if (newCode !== cur.code) { sets.push(`code = $${params.length + 1}`); params.push(newCode); }
    if (b.name !== undefined) { sets.push(`name = $${params.length + 1}`); params.push(b.name.replace(/\s+/g, ' ').trim()); }
    if (b.type !== undefined) { sets.push(`type = $${params.length + 1}`); params.push(b.type); }
    if (b.vat_rate !== undefined) { sets.push(`vat_rate = $${params.length + 1}`); params.push(b.vat_rate); }
    if (b.active !== undefined) { sets.push(`active = $${params.length + 1}`); params.push(b.active); }
    params.push(req.companyId, cur.code);
    const r = (await q(`update accounts set ${sets.join(', ')} where company_id = $${params.length - 1} and code = $${params.length} returning ${COLS}`, params)).rows[0];
    await logEv(req.user!.id, req.user!.username, 'Account updated', `${newCode} ${r.name}`, req.companyId);
    res.json(r);
  } catch (e) { next(e); }
});

// deleteAcct port (legacy 4696): system, balance or refs block deletion.
accounts.delete('/:code', requireCan('gl', 'maint'), async (req: AuthedReq, res, next) => {
  try {
    const cur = (await q(`select ${COLS} from accounts where company_id = $1 and code = $2`, [req.companyId, req.params.code])).rows[0];
    if (!cur) throw new ApiError(404, 'Account not found.');
    if (COA_SYS.includes(cur.code) || Number(cur.opening_balance) !== 0) throw new ApiError(400, 'System accounts and accounts with an opening balance cannot be deleted.');
    const refs = await acctRefs(req.companyId!, cur.code);
    if (refs.length) throw new ApiError(400, `This account is linked to ${refs.join(', ')}. Change those links first.`);
    await q('delete from accounts where company_id = $1 and code = $2', [req.companyId, cur.code]);
    await logEv(req.user!.id, req.user!.username, 'Account deleted', `${cur.code} ${cur.name}`, req.companyId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// finModel seam (legacy 5464+): trial balance from opening balances ± journal lines
export const glSummary = async (companyId: string) => {
  const rows = (await q(`
    select a.code, a.name, a.type,
           a.opening_balance
             + coalesce((select sum(l.debit - l.credit) from journal_lines l where l.company_id = a.company_id and l.account_code = a.code), 0) as balance
      from accounts a where a.company_id = $1 and a.active order by a.code`, [companyId])).rows;
  return rows;
};
