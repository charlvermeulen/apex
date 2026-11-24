import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { ApiError, AuthedReq, logEv, requireAuth, requireCan } from '../middleware.js';
import { checkPostingDate, nextDocRef, withTx } from '../posting.js';

export const assets = Router();
assets.use(requireAuth);

// legacy ATYPES 3232 / CATS options 1664 / DEPTS defaults 5692
export const ASSET_CATS = ['Computer Equipment', 'Furniture & Fittings', 'Motor Vehicles', 'Plant & Machinery', 'Office Equipment', 'Tools', 'Printing Machines'];
const DEPT_DEFAULTS = ['Administration', 'Sales', 'Operations', 'Finance', 'IT', 'Warehouse'];

// lineActive (3446) in SQL: evergreen ⇒ no end, else start + term months − 1 day
const LINE_END = `case when t.ever then null else (cl.start_date + make_interval(months => cl.term) - interval '1 day')::date end`;
const todayISO = () => new Date().toISOString().slice(0, 10);

// assetLine (3443): contract currently holding a live line on this asset
const assetLine = async (c: import('../posting.js').Client, companyId: string, code: string): Promise<string> => {
  const t = todayISO();
  const rows = (await c.query(
    `select c.code, cl.ctype, ${LINE_END} as le
       from contract_lines cl
       join contracts c on c.company_id = cl.company_id and c.code = cl.contract_code and c.status not in ('Cancelled','Expired')
       join contract_types t on t.company_id = cl.company_id and t.name = cl.ctype
      where cl.company_id = $1 and cl.asset_code = $2`, [companyId, code])).rows;
  const live = rows.find((r: any) => !r.le || r.le >= t);
  return live ? `${live.code} · ${live.ctype}` : '';
};

const isInt = (v: unknown): v is number => Number.isInteger(v);

const assetSchema = z.object({
  atype: z.enum(['company', 'warehouse', 'customer']),
  name: z.string().trim(),
  cat: z.string(),
  ser: z.string().trim().max(60).optional().default(''),
  loc: z.string().trim().max(80).optional().default(''),
  dept: z.string().trim().max(40).optional().default(''),
  sup: z.string().trim().max(80).optional().default(''),
  cust: z.string().trim().optional().default(''),
  date: z.string(),     // purchase date ('' for customer assets)
  cost: z.number(),
  res: z.number().optional().default(0),
  life: z.number().optional().default(0),
});

// validateAsset port (3244–3253) — verbatim strings
const validateAsset = (o: z.infer<typeof assetSchema>): string => {
  if (!o.name.trim()) return 'Enter a description.';
  if (o.atype === 'customer') { if (!o.cust) return 'Choose the customer who owns this asset.'; return ''; }
  if (o.atype === 'warehouse') {
    if (o.cust) return 'A warehouse asset has no owner. Clear the customer, or change the type.';
    if (!o.date) return 'Enter the purchase date.';
    if (!(o.cost > 0)) return 'Cost must be greater than zero.';
    return '';
  }
  if (!o.date) return 'Enter the purchase date.';
  if (!(o.cost > 0)) return 'Cost must be greater than zero.';
  if (!(o.res >= 0) || o.res >= o.cost) return 'Residual value must be zero or more and less than the cost.';
  if (!isInt(o.life) || o.life < 1 || o.life > 600) return 'Useful life must be between 1 and 600 months.';
  return '';
};

assets.get('/assets', requireCan('assets', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    const rows = (await q(
      `select a.code, a.atype, a.name, a.cat, a.ser, a.loc, a.dept, a.sup, a.cust_code as cust,
              c.name as "custName", a.purchase_date as date, a.cost::float, a.res::float, a.life,
              a.status, a.disposed
         from assets a left join customers c on c.company_id = a.company_id and c.code = a.cust_code
        where a.company_id = $1 order by a.code`, [req.companyId])).rows;
    for (const r of rows as any[]) {
      if (r.status === 'Active' && r.atype === 'company') r.onLine = await assetLine({ query: (t: string, p?: unknown[]) => q(t, p) }, req.companyId!, r.code);
      else r.onLine = '';
    }
    res.json(rows);
  } catch (e) { next(e); }
});

assets.get('/assets/departments', requireCan('assets', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    const { rows } = await q(`select distinct dept from assets where company_id = $1 and dept is not null and dept <> ''`, [req.companyId]);
    res.json([...new Set([...DEPT_DEFAULTS, ...rows.map((r: any) => r.dept)])]);
  } catch (e) { next(e); }
});

assets.post('/assets', requireCan('assets', 'maint'), async (req: AuthedReq, res, next) => {
  try {
    const o = assetSchema.parse(req.body);
    const e = validateAsset(o);
    if (e) throw new ApiError(400, e);
    await withTx(async (c) => {
      if (o.atype !== 'customer') { const pe = await checkPostingDate(c, req.companyId!, o.date); if (pe) throw new ApiError(400, pe); }
      if (o.cust) {
        const cust = (await c.query('select code from customers where company_id = $1 and code = $2', [req.companyId, o.cust])).rows[0];
        if (!cust) throw new ApiError(400, 'Choose the customer who owns this asset.');
      }
      const code = await nextDocRef(c, req.companyId!, 'assets', 'AST', 1, 'code', 4);
      // port of saveAsset 3268: value model forces customer/warehouse fields
      const date = o.atype === 'customer' ? todayISO() : o.date;
      const cost = o.atype === 'customer' ? 0 : o.cost;
      const resV = o.atype === 'warehouse' ? 0 : (o.atype === 'customer' ? 0 : o.res);
      const life = o.atype === 'customer' || o.atype === 'warehouse' ? 0 : o.life;
      await c.query(
        `insert into assets (company_id, code, atype, name, cat, ser, loc, dept, sup, cust_code, purchase_date, cost, res, life, status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'Active')`,
        [req.companyId, code, o.atype, o.name.trim(), o.cat, o.ser || null, o.loc || null, o.dept || null, o.sup || null,
          o.atype === 'warehouse' ? null : (o.cust || null), date, cost, resV, life]);
      await logEv(req.user!.id, req.user!.username, 'Asset added', `${code} ${o.name.trim()}`, req.companyId);
      res.status(201).json({ code });
    });
  } catch (e) { next(e); }
});

assets.patch('/assets/:code', requireCan('assets', 'maint'), async (req: AuthedReq, res, next) => {
  try {
    const o = assetSchema.parse(req.body);
    const e = validateAsset(o);
    if (e) throw new ApiError(400, e);
    await withTx(async (c) => {
      const a = (await c.query('select code, atype, cust_code, name from assets where company_id = $1 and code = $2', [req.companyId, req.params.code])).rows[0];
      if (!a) throw new ApiError(404, 'Asset not found.');
      const onLine = await assetLine(c, req.companyId!, a.code);
      // legacy 3262/3270: type and customer cannot change while a live contract line holds the asset
      if (onLine && (o.atype !== a.atype || (o.cust || '') !== (a.cust_code || '')))
        throw new ApiError(400, `This asset is on contract line ${onLine}. Change the customer on the contract instead.`);
      const date = o.atype === 'customer' ? (await c.query('select purchase_date from assets where company_id = $1 and code = $2', [req.companyId, a.code])).rows[0]?.purchase_date || todayISO() : o.date;
      const resV = o.atype === 'warehouse' ? 0 : (o.atype === 'customer' ? 0 : o.res);
      const life = o.atype === 'customer' || o.atype === 'warehouse' ? 0 : o.life;
      await c.query(
        `update assets set atype = $2, name = $3, cat = $4, ser = $5, loc = $6, dept = $7, sup = $8, cust_code = $9,
                purchase_date = $10, cost = $11, res = $12, life = $13
          where company_id = $1 and code = $14`,
        [req.companyId, o.atype, o.name.trim(), o.cat, o.ser || null, o.loc || null, o.dept || null, o.sup || null,
          o.atype === 'warehouse' ? null : (o.cust || null), date, o.atype === 'customer' ? 0 : o.cost, resV, life, a.code]);
      await logEv(req.user!.id, req.user!.username, 'Asset updated', a.code, req.companyId);
      res.json({ code: a.code });
    });
  } catch (e) { next(e); }
});

assets.post('/assets/:code/dispose', requireCan('assets', 'maint'), async (req: AuthedReq, res, next) => {
  try {
    await withTx(async (c) => {
      const a = (await c.query(`select code, name from assets where company_id = $1 and code = $2 and status = 'Active'`, [req.companyId, req.params.code])).rows[0];
      if (!a) throw new ApiError(404, 'Asset not found.');
      const pe = await checkPostingDate(c, req.companyId!, todayISO());
      if (pe) throw new ApiError(400, pe);
      await c.query(`update assets set status = 'Disposed', disposed = $2 where company_id = $1 and code = $3`, [req.companyId, todayISO(), a.code]);
      await logEv(req.user!.id, req.user!.username, 'Asset disposed', a.code, req.companyId);
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});
