import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { ApiError, AuthedReq, logEv, requireAuth, requireCan } from '../middleware.js';
import { nextDocRef, withTx } from '../posting.js';

export const inventory = Router();
inventory.use(requireAuth);

// ── Stock Categories (legacy CATS CRUD 4745–4789) ──

const catSchema = z.object({
  name: z.string().trim(),
  gl: z.string(),
  cos: z.string(),
  sales: z.string(),
  active: z.boolean().optional().default(true),
});

inventory.get('/inv/categories', requireCan('inventory', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    res.json((await q(
      `select g.code, g.name, g.gl, g.cos, g.sales, g.active,
              (select count(*)::int from stock_items i where i.company_id = g.company_id and i.cat_code = g.code and i.active) as items
         from stock_categories g where g.company_id = $1 order by g.code`, [req.companyId])).rows);
  } catch (e) { next(e); }
});

inventory.post('/inv/categories', requireCan('inventory', 'maint'), async (req: AuthedReq, res, next) => {
  try {
    const p = catSchema.parse(req.body);
    await withTx(async (c) => {
      // saveCat exact strings (4775–4787)
      if (p.name.length < 2 || p.name.length > 40) throw new ApiError(400, 'The category name must be 2 to 40 characters.');
      const dup = (await c.query('select 1 as x from stock_categories where company_id = $1 and lower(btrim(name)) = lower(btrim($2))', [req.companyId, p.name])).rows.length;
      if (dup) throw new ApiError(409, `A category called "${p.name}" already exists.`);
      const cnt = (await c.query('select count(*)::int as n from stock_categories where company_id = $1', [req.companyId])).rows[0].n;
      if (cnt >= 50) throw new ApiError(400, 'The maximum is 50 categories.');
      const accOk = async (code: string, group: RegExp) => {
        const r = (await c.query(`select 1 as x from accounts where company_id = $1 and code = $2
           and type in ('Fixed Asset','Contra Asset','Non-Current Asset','Bank','Current Asset','Tax Asset','Income','Other Income','Expense','Cost of Sales')`, [req.companyId, code])).rows.length;
        return r;
      };
      const grpOf = (code: string) => '123456789'[Number(code[0]) - 1];
      // legacy: gl must be an asset account, cos an expense, sales an income (first digit check mirrors COA group secs)
      const glA = (await c.query('select 1 as x from accounts where company_id = $1 and code = $2', [req.companyId, p.gl])).rows.length;
      const cosA = (await c.query('select 1 as x from accounts where company_id = $1 and code = $2', [req.companyId, p.cos])).rows.length;
      const salA = (await c.query('select 1 as x from accounts where company_id = $1 and code = $2', [req.companyId, p.sales])).rows.length;
      if (!glA || !'56'.includes(grpOf(p.gl))) throw new ApiError(400, 'Choose an asset account from the Chart of Accounts.');
      if (!cosA || !'24'.includes(grpOf(p.cos))) throw new ApiError(400, 'Choose a cost of sales account from the Chart of Accounts.');
      if (!salA || !'13'.includes(grpOf(p.sales))) throw new ApiError(400, 'Choose a sales (income) account from the Chart of Accounts.');
      const seq = (await c.query(
        `select coalesce(max(substring(code from 5)::int), 0)::int as m from stock_categories where company_id = $1`, [req.companyId])).rows[0].m;
      const code = 'CAT-' + String(seq + 1).padStart(2, '0');
      await c.query('insert into stock_categories (company_id, code, name, gl, cos, sales, active) values ($1,$2,$3,$4,$5,$6,$7)',
        [req.companyId, code, p.name, p.gl, p.cos, p.sales, p.active]);
      await logEv(req.user!.id, req.user!.username, 'Inventory category added', `${code} — ${p.name}`, req.companyId);
      res.status(201).json({ code });
    });
  } catch (e) { next(e); }
});

inventory.patch('/inv/categories/:code', requireCan('inventory', 'maint'), async (req: AuthedReq, res, next) => {
  try {
    const p = catSchema.parse(req.body);
    await withTx(async (c) => {
      const cur = (await c.query('select code, name, active from stock_categories where company_id = $1 and code = $2', [req.companyId, req.params.code])).rows[0];
      if (!cur) throw new ApiError(404, 'Category not found.');
      if (p.name.length < 2 || p.name.length > 40) throw new ApiError(400, 'The category name must be 2 to 40 characters.');
      const dup = (await c.query('select 1 as x from stock_categories where company_id = $1 and lower(btrim(name)) = lower(btrim($2)) and code <> $3', [req.companyId, p.name, cur.code])).rows.length;
      if (dup) throw new ApiError(409, `A category called "${p.name}" already exists.`);
      const grpOf = (code: string) => '123456789'[Number(code[0]) - 1];
      if (!'56'.includes(grpOf(p.gl))) throw new ApiError(400, 'Choose an asset account from the Chart of Accounts.');
      if (!'24'.includes(grpOf(p.cos))) throw new ApiError(400, 'Choose a cost of sales account from the Chart of Accounts.');
      if (!'13'.includes(grpOf(p.sales))) throw new ApiError(400, 'Choose a sales (income) account from the Chart of Accounts.');
      // deactivating the last active category with items is blocked
      if (cur.active && !p.active) {
        const items = (await c.query('select count(*)::int as n from stock_items where company_id = $1 and cat_code = $2 and active', [req.companyId, cur.code])).rows[0].n;
        const others = (await c.query('select count(*)::int as n from stock_categories where company_id = $1 and active and code <> $2', [req.companyId, cur.code])).rows[0].n;
        if (items && others < 1) throw new ApiError(400, 'At least one category must stay active.');
      }
      await c.query('update stock_categories set name = $3, gl = $4, cos = $5, sales = $6, active = $7 where company_id = $1 and code = $2',
        [req.companyId, cur.code, p.name, p.gl, p.cos, p.sales, p.active]);
      await logEv(req.user!.id, req.user!.username, 'Inventory category updated', `${cur.code} — ${p.name}`, req.companyId);
      res.json({ code: cur.code });
    });
  } catch (e) { next(e); }
});

inventory.delete('/inv/categories/:code', requireCan('inventory', 'maint'), async (req: AuthedReq, res, next) => {
  try {
    const cnt = (await q('select count(*)::int as n from stock_items where company_id = $1 and cat_code = $2', [req.companyId, req.params.code])).rows[0].n;
    if (cnt) throw new ApiError(409, 'The category still has items and cannot be deleted.');
    await q('delete from stock_categories where company_id = $1 and code = $2', [req.companyId, req.params.code]);
    await logEv(req.user!.id, req.user!.username, 'Inventory category deleted', String(req.params.code), req.companyId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Stock Items (legacy STKX/applyStkX 5837–5853) ──

const itemSchema = z.object({
  name: z.string().trim(),
  sku: z.string().trim(),
  cat: z.string().trim(),
  unit: z.enum(['Each', 'Box', 'Ream', 'Pack', 'Litre', 'Kg', 'Metre']).optional().default('Each'),
  cost: z.number().optional().default(0),
  sell: z.number().optional().default(0),
  open: z.number().optional().default(0),
  vat: z.enum(['Standard 15%', 'Zero-Rated 0%', 'Exempt']).optional().default('Standard 15%'),
  sup: z.string().nullable().optional().default(null),
  reo: z.number().optional().default(0),
  roq: z.number().optional().default(0),
  bin: z.string().trim().max(40).optional().default(''),
  bar: z.string().trim().max(30).optional().default(''),
  notes: z.string().trim().max(120).optional().default(''),
});

inventory.get('/inv/items', requireCan('inventory', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    res.json((await q(
      `select i.sku, i.name, i.cat_code as "cat", g.name as "catName", i.unit, i.cost::float, i.sell::float,
              opening_qty::float as "open", i.reorder::float as reo, i.reorder_qty::float as roq,
              i.bin, i.barcode as bar, i.notes, i.vat, i.supplier_code as sup,
              coalesce((select sum(m.qty_in - m.qty_out) from stock_moves m where m.company_id = i.company_id and m.sku = i.sku), 0)::float as moves,
              s.name as "supName"
         from stock_items i join stock_categories g on g.company_id = i.company_id and g.code = i.cat_code
         left join suppliers s on s.company_id = i.company_id and s.code = i.supplier_code
        where i.company_id = $1 and i.active order by i.sku`, [req.companyId])).rows);
  } catch (e) { next(e); }
});

inventory.post('/inv/items', requireCan('inventory', 'maint'), async (req: AuthedReq, res, next) => {
  try {
    const p = itemSchema.parse(req.body);
    await withTx(async (c) => {
      const E = (msg: string) => new ApiError(400, msg);
      if (p.name.length < 2) throw E('Enter the item name.');
      if (!p.sku) throw E('Enter the SKU / item code.');
      if (p.sku.includes('—') || p.name.includes('—')) throw E('The name and SKU cannot contain the “—” character.');
      const dupSku = (await c.query('select 1 as x from stock_items where company_id = $1 and upper(btrim(sku)) = upper(btrim($2))', [req.companyId, p.sku])).rows.length;
      if (dupSku) throw E(`The SKU ${p.sku} already exists.`);
      const cat = (await c.query('select code from stock_categories where company_id = $1 and code = $2 and active', [req.companyId, p.cat])).rows[0];
      if (!cat) throw E('Select the inventory category. Add one under Categories first if none exist.');
      if (!(p.cost >= 0)) throw E('Enter the cost price (zero or more).');
      if (!(p.sell >= 0)) throw E('The sell price cannot be negative.');
      if (!(p.open >= 0) || !Number.isInteger(p.open)) throw E('Opening stock must be a whole number, zero or more.');
      const sku = p.sku.toUpperCase();
      await c.query(
        `insert into stock_items (company_id, sku, name, cat_code, unit, cost, sell, opening_qty, supplier_code, reorder, reorder_qty, bin, barcode, notes, vat)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [req.companyId, sku, p.name, cat.code, p.unit, p.cost, p.sell, p.open, p.sup || null, p.reo, p.roq, p.bin || null, p.bar || null, p.notes || null, p.vat],
      );
      await logEv(req.user!.id, req.user!.username, 'Inventory item added', `${sku} — ${p.name}`, req.companyId);
      res.status(201).json({ sku });
    });
  } catch (e) { next(e); }
});

// stock card (renderStk port 2079–2088)
inventory.get('/inv/items/:sku/card', requireCan('inventory', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    const item = (await q(
      `select sku, name, cost::float, opening_qty::float as open from stock_items
        where company_id = $1 and upper(sku) = upper($2) and active`, [req.companyId, req.params.sku])).rows[0];
    if (!item) throw new ApiError(404, 'No inventory items yet.');
    const moves = (await q(
      `select move_date, ref, description, qty_in::float, qty_out::float from stock_moves
        where company_id = $1 and sku = $2 order by move_date, id`, [req.companyId, item.sku])).rows as any[];
    const from = String(req.query.from || ''), to = String(req.query.to || '');
    let q0 = Number(item.open);
    let rows: any[] = [];
    moves.forEach((r) => {
      if (from && r.move_date < from) q0 += r.qty_in - r.qty_out;
    });
    let bal = q0;
    moves.forEach((r) => {
      if ((from && r.move_date < from) || (to && r.move_date > to)) return;
      bal += r.qty_in - r.qty_out;
      rows.push({ date: r.move_date, ref: r.ref, desc: r.description, in: r.qty_in, out: r.qty_out, bal });
    });
    res.json({
      sku: item.sku, name: item.name, cost: Number(item.cost),
      opening: q0, rows, closing: bal,
      value: Math.round(bal * Number(item.cost) * 100) / 100,
    });
  } catch (e) { next(e); }
});

// stock valuation (fillReports port)
inventory.get('/inv/valuation', requireCan('inventory', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    res.json((await q(
      `select i.sku, i.name, cost::float,
              (opening_qty + coalesce((select sum(m.qty_in - m.qty_out) from stock_moves m where m.company_id = i.company_id and m.sku = i.sku), 0))::float as qty
         from stock_items i where i.company_id = $1 and i.active order by i.sku`, [req.companyId])).rows
      .map((r: any) => ({ ...r, value: r.qty * r.cost })));
  } catch (e) { next(e); }
});
