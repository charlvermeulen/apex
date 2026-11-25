import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { ApiError, AuthedReq, logEv, requireAuth, requireCan } from '../middleware.js';
import { checkPostingDate, fmtD, nextDocRef, postJournal, r2, withTx } from '../posting.js';
import { fyIdFor } from './sales.routes.js';

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
      if (r.status === 'Active' && (r.atype === 'company' || r.atype === 'customer')) r.onLine = await assetLine({ query: (t: string, p?: unknown[]) => q(t, p) }, req.companyId!, r.code);
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

// ── Maintenance & Service tab (renderSvc/saveSvc 3286–3304) ──

assets.get('/assets/services', requireCan('assets', 'maint'), async (req: AuthedReq, res, next) => {
  try {
    res.json((await q(
      `select s.id, s.asset_code as asset, a.name as "assetName", s.entry_date as date, s.type,
              coalesce(s.sup,'') as sup, s.cost::float, s.next, coalesce(s.notes,'') as notes
         from asset_services s left join assets a on a.company_id = s.company_id and a.code = s.asset_code
        where s.company_id = $1 order by s.entry_date desc, s.id desc`, [req.companyId])).rows);
  } catch (e) { next(e); }
});

assets.post('/assets/services', requireCan('assets', 'maint'), async (req: AuthedReq, res, next) => {
  try {
    const o = z.object({ asset: z.string(), date: z.string(), type: z.string(), sup: z.string().optional().default(''), cost: z.number(), next: z.string().optional().default(''), notes: z.string().optional().default('') }).parse(req.body);
    await withTx(async (c) => {
      if (!o.asset || !o.date) throw new ApiError(400, 'Choose an asset and enter the service date.');
      if (!(o.cost >= 0)) throw new ApiError(400, 'Cost cannot be negative.');
      if (o.next && o.next <= o.date) throw new ApiError(400, 'The next service date must be after this service.');
      if (!(await c.query(`select 1 as x from assets where company_id = $1 and code = $2 and status = 'Active'`, [req.companyId, o.asset])).rows[0])
        throw new ApiError(400, 'Asset not found.');
      await c.query(
        `insert into asset_services (company_id, asset_code, entry_date, type, sup, cost, next, notes)
         values ($1,$2,$3,$4,nullif($5,''),$6,nullif($7::text,'')::date,nullif($8,''))`,
        [req.companyId, o.asset, o.date, o.type, o.sup.trim(), o.cost, o.next, o.notes.trim()]);
      await logEv(req.user!.id, req.user!.username, 'Service logged', o.asset, req.companyId);
      res.status(201).json({ ok: true });
    });
  } catch (e) { next(e); }
});

// ── Depreciation tab (depRows/postDep 3306–3326) ──

// depRows port: company-type Active assets purchased in/before the month
assets.get('/assets/dep', requireCan('assets', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    const month = String(req.query.month || todayISO().slice(0, 7));
    const r2v = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
    const rows = (await q(
      `select a.code, a.name, a.cost::float, a.res::float, a.life, a.purchase_date as date,
              coalesce(d.amount, 0)::float as "postedAmt",
              coalesce((select sum(x.amount) from asset_depreciation x where x.company_id = a.company_id and x.asset_code = a.code), 0)::float as "doneAll"
         from assets a
         left join asset_depreciation d on d.company_id = a.company_id and d.asset_code = a.code and d.month = $2
        where a.company_id = $1 and a.status = 'Active' and a.atype = 'company' and to_char(a.purchase_date,'YYYY-MM') <= $2
        order by a.code`, [req.companyId, month])).rows as any[];
    const out = rows.map((a) => {
      const posted = a.postedAmt > 0;
      const [y1, m1] = String(a.date).slice(0, 7).split('-').map(Number) as [number, number];
      const [y2, m2] = month.split('-').map(Number);
      const n = (y2 - y1) * 12 + (m2 - m1);
      const monthly = a.life > 0 ? r2v((a.cost - a.res) / a.life) : 0;
      let amt = monthly;
      const max = r2v(a.cost - a.res - a.doneAll + (posted ? a.postedAmt : 0));
      amt = Math.min(amt, Math.max(0, max));
      const state = posted ? 'Posted' : (n >= a.life || amt <= 0 ? 'Fully depreciated' : 'Pending');
      const acc = r2v(a.doneAll + (posted ? 0 : (state === 'Pending' ? amt : 0)));
      return { code: a.code, name: a.name, cost: a.cost, amt: posted ? a.postedAmt : amt, acc, state };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// postDep (3319–3326). Legacy never wrote GL for depreciation (derived GL ignored dep) — deliberate deviation:
// the rewrite materialises one journal per run (Dr 4020 / Cr 5010) so reports batch 7 agrees.
assets.post('/assets/dep', requireCan('assets', 'maint'), async (req: AuthedReq, res, next) => {
  try {
    const { month } = z.object({ month: z.string() }).parse(req.body);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new ApiError(400, 'Choose a month.');
    await withTx(async (c) => {
      const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
      const chk = await checkPostingDate(c, req.companyId!, last);
      if (chk) throw new ApiError(400, chk);
      const rows = (await q(
        `select a.code, a.cost::float, a.res::float, a.life, a.purchase_date as date,
                coalesce(d.amount, 0)::float as "postedAmt",
                coalesce((select sum(x.amount) from asset_depreciation x where x.company_id = a.company_id and x.asset_code = a.code), 0)::float as "doneAll"
           from assets a
           left join asset_depreciation d on d.company_id = a.company_id and d.asset_code = a.code and d.month = $2
          where a.company_id = $1 and a.status = 'Active' and a.atype = 'company' and to_char(a.purchase_date,'YYYY-MM') <= $2`,
        [req.companyId, month])).rows as any[];
      const todo: { code: string; amt: number }[] = [];
      for (const a of rows) {
        const posted = a.postedAmt > 0;
        if (posted) continue;
        const [y1, m1] = String(a.date).slice(0, 7).split('-').map(Number) as [number, number];
        const [y2, m2] = month.split('-').map(Number);
        const n = (y2 - y1) * 12 + (m2 - m1);
        const monthly = a.life > 0 ? r2((a.cost - a.res) / a.life) : 0;
        const max = r2(a.cost - a.res - a.doneAll);
        const amt = Math.min(monthly, Math.max(0, max));
        if (n >= a.life || amt <= 0) continue;
        todo.push({ code: a.code, amt });
      }
      if (!todo.length) throw new ApiError(400, `Nothing to post for ${month}.`);
      const accs = (await c.query(`select code from accounts where company_id = $1 and code in ('4020','5010')`, [req.companyId])).rows;
      if (accs.length < 2) throw new ApiError(400, 'Depreciation needs accounts 4020 (Depreciation) and 5010 (Accumulated Depreciation) on the Chart of Accounts.');
      for (const t of todo)
        await c.query(`insert into asset_depreciation (company_id, asset_code, month, amount) values ($1,$2,$3,$4)`, [req.companyId, t.code, month, t.amt]);
      const fyId = (await c.query('select id from financial_years where company_id = $1 and start <= $2 and end_date >= $3', [req.companyId, last, last])).rows[0]?.id ?? null;
      const total = r2(todo.reduce((s, t) => s + t.amt, 0));
      const ref = `DEP-${String((await c.query(`select count(*)::int as n from journals where company_id = $1 and ref like 'DEP-%'`, [req.companyId])).rows[0].n + 1).padStart(4, '0')}`;
      await postJournal(c, {
        companyId: req.companyId!, fyId, date: last, ref, src: 'Depreciation', srcType: 'depreciation', srcId: month,
        desc: `Monthly depreciation — ${month}`, userId: req.user!.id,
        lines: [{ acc: '4020', dr: total, cr: 0 }, { acc: '5010', dr: 0, cr: total }],
      });
      await logEv(req.user!.id, req.user!.username, 'Depreciation posted', `${month} — ${todo.length} assets, ${total}`, req.companyId);
      res.json({ count: todo.length, total });
    });
  } catch (e) { next(e); }
});

// ── Asset Buy-Back from Customer (openBB/saveBB 5759–5788) ──

const bbSchema = z.object({
  cust: z.string(), asset: z.string(), date: z.string(), price: z.number(),
  vat: z.enum(['15', '0']), to: z.enum(['company', 'warehouse']), settle: z.enum(['credit', 'bank']),
  res: z.number().optional().default(0), life: z.number().optional().default(0),
  ref: z.string().trim().optional().default(''), notes: z.string().trim().optional().default(''),
});

assets.get('/assets/buybacks', requireCan('assets', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    res.json((await q(
      `select b.id, b.buyback_date as date, a.code as asset, coalesce(b.descr, a.name) as "assetDesc",
              c.name as cust, b.to_type as to, b.price::float, b.vat::float, b.total::float as tot,
              b.settle, coalesce(b.ref,'') as ref, coalesce(b.notes,'') as notes
         from asset_buybacks b
         left join assets a on a.company_id = b.company_id and a.code = b.asset_code
         left join customers c on c.company_id = b.company_id and c.code = b.cust_code
        where b.company_id = $1 order by b.buyback_date desc, b.id desc`, [req.companyId])).rows);
  } catch (e) { next(e); }
});

assets.post('/assets/buybacks', requireCan('assets', 'maint'), async (req: AuthedReq, res, next) => {
  try {
    // asset candidates (bbCands 5760): customer-owned, active, not on a live contract line
    const cand = (await q(
      `select a.code, a.name, a.cust_code as cust from assets a
        where a.company_id = $1 and a.atype = 'customer' and a.status = 'Active' and a.cust_code is not null`, [req.companyId])).rows as any[];
    const candMap = new Map(cand.map((a) => [a.code, a]));
    const o = bbSchema.parse(req.body);
    await withTx(async (c) => {
      if (!o.cust) throw new ApiError(400, 'Select the customer.');
      const a = candMap.get(o.asset);
      if (!a) throw new ApiError(400, 'Select the asset being bought back.');
      if (a.cust !== o.cust) throw new ApiError(400, 'Select the asset being bought back.');
      const onLine = await assetLine(c, req.companyId!, a.code);
      if (onLine) throw new ApiError(400, `This asset is on contract line ${onLine}. Change the customer on the contract instead.`);
      if (!o.date) throw new ApiError(400, 'Enter the buy-back date.');
      if (!(o.price > 0)) throw new ApiError(400, 'Enter the price — it must be greater than zero.');
      if (o.to === 'company') {
        if (!(o.res >= 0) || o.res >= o.price) throw new ApiError(400, 'Residual value must be zero or more and less than the price.');
        if (!Number.isInteger(o.life) || o.life < 1 || o.life > 600) throw new ApiError(400, 'Useful life must be between 1 and 600 months.');
      }
      const pe = await checkPostingDate(c, req.companyId!, o.date);
      if (pe) throw new ApiError(400, pe);
      const cust = (await c.query('select code, name from customers where company_id = $1 and code = $2', [req.companyId, o.cust])).rows[0];
      if (!cust) throw new ApiError(400, 'Select the customer.');
      const vat = o.vat === '15' ? r2(o.price * 0.15) : 0;
      const tot = r2(o.price + vat);
      const id = await nextDocRef(c, req.companyId!, 'asset_buybacks', 'BB', 1, 'id', 4);
      const fyId = await fyIdFor(c, req.companyId!, o.date);
      // glBB (5786): Dr 5000 company / 6200 warehouse price, Dr 6300 VAT, Cr 6100 credit / 6000 bank the total
      const drAcc = o.to === 'company' ? '5000' : '6200';
      const crAcc = o.settle === 'credit' ? '6100' : '6000';
      const want = ['6300', drAcc, crAcc];
      const have = new Set((await c.query(`select code from accounts where company_id = $1 and code = any($2::text[])`, [req.companyId, want])).rows.map((r: any) => r.code));
      const missing = want.filter((w) => !have.has(w));
      if (missing.length) throw new ApiError(400, `Buy-back needs account ${missing[0]} on the Chart of Accounts.`);
      const jid = await postJournal(c, {
        companyId: req.companyId!, fyId, date: o.date, ref: id,
        src: 'Asset Buy-Back', srcType: 'asset_buyback', srcId: id, desc: `${cust.name} · ${a.code}`, userId: req.user!.id,
        lines: [
          { acc: drAcc, dr: o.price, cr: 0 },
          ...(vat ? [{ acc: '6300', dr: vat, cr: 0 }] : []),
          { acc: crAcc, dr: 0, cr: tot },
        ],
      });
      await c.query(
        `insert into asset_buybacks (company_id, id, buyback_date, asset_code, descr, cust_code, to_type, price, vat, total, settle, ref, notes, journal_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [req.companyId, id, o.date, a.code, a.name, cust.code, o.to, o.price, vat, tot, o.settle, o.ref || null, o.notes || null, jid]);
      // saveBB 5780: asset becomes ours at the buy-back price and date
      await c.query(
        `update assets set atype = $3, cost = $4, purchase_date = $5, acq_date = $6, res = $7, life = $8, sup = $9, cust_code = null
          where company_id = $1 and code = $2`,
        [req.companyId, a.code, o.to, o.price, o.date, o.date, o.to === 'company' ? o.res : 0, o.to === 'company' ? o.life : 0, cust.name]);
      // postBBToLedger (5784): settle on the customer's account credits it
      if (o.settle === 'credit')
        await c.query(
          `insert into party_ledger (company_id, party_type, party_code, entry_date, ref, doc_type, description, debit, credit, journal_id)
           values ($1,'cust',$2,$3,$4,'Buy-Back',$5,0,$6,$7)`,
          [req.companyId, cust.code, o.date, id, 'Asset buy-back — ' + a.name + (o.ref ? ' (' + o.ref + ')' : ''), tot, jid]);
      await logEv(req.user!.id, req.user!.username, 'Asset bought back', `${id} · ${a.code} from ${cust.name} · ${tot}`, req.companyId);
      res.status(201).json({ id });
    });
  } catch (e) { next(e); }
});

// ── Convert Inventory Asset → Rental Equipment (openCV/saveCV 5791–5818) ──

const cvSchema = z.object({
  asset: z.string(), date: z.string(), res: z.number(), life: z.number(),
  from: z.string(), to: z.string(), notes: z.string().trim().optional().default(''),
});

assets.get('/assets/conversions', requireCan('assets', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    res.json((await q(
      `select v.id, v.conv_date as date, a.code as asset, coalesce(v.descr, a.name) as "assetDesc",
              v.value::float, fa.name as "fromName", ta.name as "toName", fa.code as from, ta.code as to,
              coalesce(v.notes,'') as notes
         from asset_conversions v
         left join assets a on a.company_id = v.company_id and a.code = v.asset_code
         left join accounts fa on fa.company_id = v.company_id and fa.code = v.from_acc
         left join accounts ta on ta.company_id = v.company_id and ta.code = v.to_acc
        where v.company_id = $1 order by v.conv_date desc, v.id desc`, [req.companyId])).rows);
  } catch (e) { next(e); }
});

assets.post('/assets/conversions', requireCan('assets', 'maint'), async (req: AuthedReq, res, next) => {
  try {
    const o = cvSchema.parse(req.body);
    const fmtR = (n: number) => 'R ' + n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    await withTx(async (c) => {
      const a = (await c.query(
        `select code, name, cost::float, purchase_date as date, atype, status from assets where company_id = $1 and code = $2`, [req.companyId, o.asset])).rows[0];
      if (!a || a.status !== 'Active' || a.atype !== 'warehouse')
        throw new ApiError(400, 'Select the warehouse asset to convert.');
      if (!o.date) throw new ApiError(400, 'Enter the conversion date.');
      if (a.date && o.date < String(a.date)) throw new ApiError(400, `The conversion date cannot be before the asset was acquired (${fmtD(String(a.date))}).`);
      if (!(o.res >= 0) || o.res >= a.cost) throw new ApiError(400, `Residual value must be zero or more and less than the cost (${fmtR(a.cost)}).`);
      if (!Number.isInteger(o.life) || o.life < 1 || o.life > 600) throw new ApiError(400, 'Useful life must be between 1 and 600 months.');
      if (o.from === o.to) throw new ApiError(400, 'The Inventory GL and Rental Equipment GL must be different accounts.');
      const pe = await checkPostingDate(c, req.companyId!, o.date);
      if (pe) throw new ApiError(400, pe);
      // ensureRentGL (5793): the Rental Equipment account is created on first use
      const have = new Set((await c.query(`select code from accounts where company_id = $1 and code = any($2::text[])`, [req.companyId, [o.from, o.to]])).rows.map((r: any) => r.code));
      if (!have.has(o.to) && o.to === '5020') {
        await c.query(`insert into accounts (company_id, code, name, type) values ($1,'5020','Rental Equipment','Fixed Asset') on conflict do nothing`, [req.companyId]);
        have.add('5020');
      }
      const missing = [o.from, o.to].filter((w) => !have.has(w));
      if (missing.length) throw new ApiError(400, `Conversion needs account ${missing[0]} on the Chart of Accounts.`);
      const id = await nextDocRef(c, req.companyId!, 'asset_conversions', 'CV', 1, 'id', 4);
      const fyId = await fyIdFor(c, req.companyId!, o.date);
      const jid = await postJournal(c, {
        companyId: req.companyId!, fyId, date: o.date, ref: id,
        src: 'Asset Conversion', srcType: 'asset_conversion', srcId: id, desc: `${a.code} to Rental Equipment`, userId: req.user!.id,
        lines: [{ acc: o.to, dr: a.cost, cr: 0 }, { acc: o.from, dr: 0, cr: a.cost }],
      });
      await c.query(
        `insert into asset_conversions (company_id, id, conv_date, asset_code, descr, value, from_acc, to_acc, notes, journal_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [req.companyId, id, o.date, a.code, a.name, a.cost, o.from, o.to, o.notes || null, jid]);
      // saveCV 5812: asset becomes a company asset dated the conversion day (acquired date kept in acq_date)
      await c.query(
        `update assets set atype = 'company', acq_date = $3, purchase_date = $4, res = $5, life = $6 where company_id = $1 and code = $2`,
        [req.companyId, a.code, a.date, o.date, o.res, o.life]);
      await logEv(req.user!.id, req.user!.username, 'Asset converted to rental equipment', `${id} · ${a.code} · ${fmtR(a.cost)}`, req.companyId);
      res.status(201).json({ id });
    });
  } catch (e) { next(e); }
});
