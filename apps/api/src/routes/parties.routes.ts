import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { ApiError, AuthedReq, logEv, requireAuth, requireCan } from '../middleware.js';
import { nextDocRef, r2, withTx, type Client } from '../posting.js';

export const parties = Router();
parties.use(requireAuth);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── shared ageing engine — port of ageItems/ageBucket (4713–4741) ──
const ageBucket = (d: number): number => d <= 30 ? 0 : d <= 60 ? 1 : d <= 90 ? 2 : d <= 120 ? 3 : 4;
const daysBetween = (a: string, b: string): number => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

async function ageParties(companyId: string | undefined, kind: 'cust' | 'sup', asAt: string) {
  const table = kind === 'cust' ? 'customers' : 'suppliers';
  const ledger = (await q(
    `select party_code, entry_date, ref, description, debit::float as debit, credit::float as credit from party_ledger
      where company_id = $1 and party_type = $2 and entry_date <= $3 order by entry_date, ref`, [companyId, kind, asAt])).rows as any[];
  const inc = kind === 'cust' ? 'debit' : 'credit';
  const dec = kind === 'cust' ? 'credit' : 'debit';
  const partiesRows = (await q(`select code, name from ${table} where company_id = $1 and active order by code`, [companyId])).rows as any[];
  const byCode: Record<string, any[]> = {};
  ledger.forEach((r) => (byCode[r.party_code] ??= []).push(r));
  const out = partiesRows.map((p) => {
    const items: { iso: string; ref: string; desc: string; amt: number }[] = [];
    let red = 0;
    (byCode[p.code] || []).forEach((r) => {
      if (r[inc] > 0) items.push({ iso: r.entry_date, ref: r.ref, desc: r.description, amt: r[inc] });
      red += r[dec] || 0;
    });
    items.sort((a, b) => a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : a.ref < b.ref ? -1 : 1);
    for (const it of items) {
      if (red <= 0) break;
      const t = Math.min(it.amt, red);
      it.amt = r2(it.amt - t); red = r2(red - t);
    }
    const buckets = [0, 0, 0, 0, 0], det: any[] = [];
    items.filter((i2) => i2.amt > 0.004).forEach((i2) => {
      const b = i2.iso ? ageBucket(Math.max(0, daysBetween(i2.iso, asAt))) : 4;
      buckets[b] += i2.amt;
      det.push({ ref: i2.ref, date: i2.iso, desc: i2.desc, b, amt: r2(i2.amt) });
    });
    if (red > 0.004) {
      buckets[0] += -red;
      det.push({ ref: 'Unallocated payments / credits', date: '', desc: '', b: 0, amt: r2(-red) });
    }
    return { code: p.code, name: p.name, buckets: buckets.map(r2), total: r2(buckets.reduce((x, y) => x + y, 0)), det };
  });
  const tot = [0, 0, 0, 0, 0].map((_, i) => r2(out.reduce((s, x) => s + x.buckets[i], 0)));
  const grand = r2(tot.reduce((x, y) => x + y, 0));
  const pct = grand ? Math.round((tot[1] + tot[2] + tot[3] + tot[4]) / grand * 100) : 0;
  return { asAt, rows: out, tot, grand, pct, labels: ['Current', '31–60 days', '61–90 days', '91–120 days', '120+ days'] };
}

// party ledger enquiry (renderEnq port, 1970–1991): opening + rows + closing
async function partyLedger(companyId: string | undefined, kind: 'cust' | 'sup', code: string, from: string, to: string) {
  const rows = (await q(
    `select entry_date, ref, doc_type, description, debit::float as dr, credit::float as cr
      from party_ledger where company_id = $1 and party_type = $2 and party_code = $3
      order by entry_date, id`, [companyId, kind, code])).rows as any[];
  const drSide = kind === 'cust';
  let bal = 0;
  rows.forEach((r) => {
    if (from && r.entry_date < from) bal += drSide ? r.dr - r.cr : r.cr - r.dr;
  });
  const opening = r2(bal);
  const out: any[] = [];
  let shown = 0;
  rows.forEach((r) => {
    if ((from && r.entry_date < from) || (to && r.entry_date > to)) return;
    bal += drSide ? r.dr - r.cr : r.cr - r.dr;
    shown++;
    out.push({ date: r.entry_date, ref: r.ref, desc: r.description, dr: r.dr || 0, cr: r.cr || 0, bal: r2(bal) });
  });
  const limit = (await q(kind === 'cust'
    ? `select credit_limit as v, name, code from customers where company_id = $1 and code = $2`
    : `select 0 as v, name, code from suppliers where company_id = $1 and code = $2`, [companyId, code])).rows[0];
  return {
    kind, code, name: limit?.name ?? '', limit: Number(limit?.v ?? 0),
    opening, rows: out, closing: r2(bal),
    count: shown, drSide,
    empty: rows.length === 0,
  };
}

// ── Customers ──

const custSchema = z.object({
  name: z.string().trim(),
  trading: z.string().trim().optional().default(''),
  vat: z.string().trim().optional().default(''),
  reg: z.string().trim().optional().default(''),
  contact: z.string().trim().optional().default(''),
  email: z.string().trim(),
  svcEmail: z.string().trim().optional().default(''),
  phone: z.string().trim().optional().default(''),
  limit: z.number().optional().default(0),
  terms: z.enum(['30 days', '60 days', '7 days', 'COD', 'EOM + 30']).optional().default('30 days'),
  street: z.string().trim().optional().default(''),
  suburb: z.string().trim().optional().default(''),
  city: z.string().trim().optional().default(''),
  prov: z.string().trim().optional().default('Gauteng'),
  pc: z.string().trim().optional().default(''),
});

const custList = `
  select c.code, c.name, c.trading, c.vat_no as "vatNo", c.reg_no as "regNo", c.contact, c.email,
    c.svc_email as "svcEmail", c.phone, c.credit_limit as "limit", c.terms,
    c.street, c.suburb, c.city, c.prov, c.postal_code as "pc",
    coalesce((select sum(pl.debit - pl.credit) from party_ledger pl
      where pl.company_id = c.company_id and pl.party_type = 'cust' and pl.party_code = c.code), 0)::float as balance
  from customers c where c.company_id = $1 and c.active`;

parties.get('/customers', requireCan('customers', 'enq'), async (req: AuthedReq, res, next) => {
  try { res.json((await q(custList + ' order by c.code', [req.companyId])).rows); } catch (e) { next(e); }
});

// validateCustomer port (3931–3939) — verbatim messages; returns '' or the first error
function validateCustomer(c: Client, companyId: string, o: z.infer<typeof custSchema>, excludeCode?: string): Promise<string> {
  const run = async () => {
    if (o.name.length < 2) return 'Enter the customer name.';
    const dup = (await c.query('select 1 as x from customers where company_id = $1 and lower(btrim(name)) = lower(btrim($2)) and code <> coalesce($3, \'\')', [companyId, o.name, excludeCode ?? ''])).rows.length;
    if (dup) return `A customer called "${o.name}" already exists.`;
    if (!EMAIL_RE.test(o.email)) return 'Enter a valid Accounts Email address.';
    if (o.svcEmail && !EMAIL_RE.test(o.svcEmail)) return 'Enter a valid Service Email address.';
    if (o.vat && !/^4\d{9}$/.test(o.vat)) return 'A South African VAT number is 10 digits starting with 4.';
    if (!(o.limit >= 0)) return 'The credit limit cannot be negative.';
    return '';
  };
  return run();
}

parties.post('/customers', requireCan('customers', 'maint'), async (req: AuthedReq, res, next) => {
  try {
    const p = custSchema.parse(req.body);
    await withTx(async (c) => {
      const e = await validateCustomer(c, req.companyId!, p);
      if (e) throw new ApiError(p.name.length < 2 || e.startsWith('A customer called') ? 409 : 400, e);
      const code = await nextDocRef(c, req.companyId!, 'customers', 'CUST', 1, 'code');
      await c.query(
        `insert into customers (company_id, code, name, trading, vat_no, reg_no, contact, email, svc_email, phone, credit_limit, terms, street, suburb, city, prov, postal_code)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [req.companyId, code, p.name, p.trading || null, p.vat || null, p.reg || null, p.contact || null, p.email, p.svcEmail || null, p.phone || null, p.limit, p.terms, p.street || null, p.suburb || null, p.city || null, p.prov, p.pc || null],
      );
      await logEv(req.user!.id, req.user!.username, 'Customer added', `${p.name} (${code})`, req.companyId);
      res.status(201).json({ code });
    });
  } catch (e) { next(e); }
});

parties.patch('/customers/:code', requireCan('customers', 'maint'), async (req: AuthedReq, res, next) => {
  try {
    const p = custSchema.parse(req.body);
    await withTx(async (c) => {
      const cur = (await c.query('select code, name from customers where company_id = $1 and code = $2', [req.companyId, req.params.code])).rows[0];
      if (!cur) throw new ApiError(404, 'Customer not found.');
      const e = await validateCustomer(c, req.companyId!, p, cur.code);
      if (e) throw new ApiError(400, e);
      await c.query(
        `update customers set name = $3, trading = $4, vat_no = $5, reg_no = $6, contact = $7, email = $8, svc_email = $9, phone = $10,
           credit_limit = $11, terms = $12, street = $13, suburb = $14, city = $15, prov = $16, postal_code = $17
         where company_id = $1 and code = $2`,
        [req.companyId, cur.code, p.name, p.trading || null, p.vat || null, p.reg || null, p.contact || null, p.email, p.svcEmail || null, p.phone || null, p.limit, p.terms, p.street || null, p.suburb || null, p.city || null, p.prov, p.pc || null],
      );
      await logEv(req.user!.id, req.user!.username, 'Customer updated', `${p.name} (${cur.code})` + (p.name !== cur.name ? ` — renamed from ${cur.name}` : ''), req.companyId);
      res.json({ code: cur.code });
    });
  } catch (e) { next(e); }
});

// ── ledger enquiries + ageing endpoints ──

parties.get('/customers/:code/ledger', requireCan('customers', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    res.json(await partyLedger(req.companyId, 'cust', String(req.params.code), String(req.query.from || ''), String(req.query.to || '')));
  } catch (e) { next(e); }
});

parties.get('/customers/:code/age', requireCan('customers', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    const asAt = String(req.query.asAt || '') || new Date().toISOString().slice(0, 10);
    const all = await ageParties(req.companyId, 'cust', asAt);
    res.json(all.rows.find((r: any) => r.code === req.params.code) ?? { buckets: [0,0,0,0,0], total: 0, det: [] });
  } catch (e) { next(e); }
});

parties.get('/suppliers/:code/ledger', requireCan('suppliers', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    res.json(await partyLedger(req.companyId, 'sup', String(req.params.code), String(req.query.from || ''), String(req.query.to || '')));
  } catch (e) { next(e); }
});

parties.get('/age/cust', requireCan('customers', 'enq'), async (req: AuthedReq, res, next) => {
  try { res.json(await ageParties(req.companyId, 'cust', String(req.query.asAt || '') || new Date().toISOString().slice(0, 10))); } catch (e) { next(e); }
});

parties.get('/age/sup', requireCan('suppliers', 'enq'), async (req: AuthedReq, res, next) => {
  try { res.json(await ageParties(req.companyId, 'sup', String(req.query.asAt || '') || new Date().toISOString().slice(0, 10))); } catch (e) { next(e); }
});

// ── Suppliers ──

const supSchema = z.object({
  name: z.string().trim(),
  trading: z.string().trim().optional().default(''),
  vat: z.string().trim().optional().default(''),
  reg: z.string().trim().optional().default(''),
  contact: z.string().trim().optional().default(''),
  email: z.string().trim(),
  phone: z.string().trim().optional().default(''),
  bank: z.string().trim().optional().default(''),
  terms: z.enum(['30 days', '60 days', '7 days', 'COD', 'EOM', 'Monthly']).optional().default('30 days'),
  street: z.string().trim().optional().default(''),
  suburb: z.string().trim().optional().default(''),
  city: z.string().trim().optional().default(''),
  prov: z.string().trim().optional().default('Gauteng'),
  pc: z.string().trim().optional().default(''),
  defaultExp: z.string().regex(/^\d{4}$/).nullable().optional().default(null),
});

const supList = `
  select s.code, s.name, s.trading, s.vat_no as "vatNo", s.reg_no as "regNo", s.contact, s.email, s.phone,
    s.bank_account as "bank", s.terms, s.default_exp as "defaultExp",
    s.street, s.suburb, s.city, s.prov, s.postal_code as "pc",
    coalesce((select sum(pl.credit - pl.debit) from party_ledger pl
      where pl.company_id = s.company_id and pl.party_type = 'sup' and pl.party_code = s.code), 0)::float as balance
  from suppliers s where s.company_id = $1 and s.active`;

parties.get('/suppliers', requireCan('suppliers', 'enq'), async (req: AuthedReq, res, next) => {
  try { res.json((await q(supList + ' order by s.code', [req.companyId])).rows); } catch (e) { next(e); }
});

// validateSupplier port (4813–4828, inline) — verbatim messages
async function validateSupplier(c: Client, companyId: string, o: z.infer<typeof supSchema>, excludeCode?: string): Promise<string> {
  if (o.name.length < 2) return 'Enter the supplier name.';
  const dup = (await c.query('select 1 as x from suppliers where company_id = $1 and lower(btrim(name)) = lower(btrim($2)) and code <> coalesce($3, \'\')', [companyId, o.name, excludeCode ?? ''])).rows.length;
  if (dup) return `A supplier called "${o.name}" already exists.`;
  if (!EMAIL_RE.test(o.email)) return 'Enter a valid email address.';
  if (o.vat && !/^4\d{9}$/.test(o.vat)) return 'A South African VAT number is 10 digits starting with 4.';
  if (o.defaultExp) {
    const a = (await c.query('select 1 as x from accounts where company_id = $1 and code = $2', [companyId, o.defaultExp])).rows.length;
    if (!a) return `Unknown expense account "${o.defaultExp}".`;
  }
  return '';
}

parties.post('/suppliers', requireCan('suppliers', 'maint'), async (req: AuthedReq, res, next) => {
  try {
    const p = supSchema.parse(req.body);
    await withTx(async (c) => {
      const e = await validateSupplier(c, req.companyId!, p);
      if (e) throw new ApiError(400, e);
      const code = await nextDocRef(c, req.companyId!, 'suppliers', 'SUP', 1, 'code');
      await c.query(
        `insert into suppliers (company_id, code, name, trading, vat_no, reg_no, contact, email, phone, bank_account, terms, street, suburb, city, prov, postal_code, default_exp)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [req.companyId, code, p.name, p.trading || null, p.vat || null, p.reg || null, p.contact || null, p.email, p.phone || null, p.bank || null, p.terms, p.street || null, p.suburb || null, p.city || null, p.prov, p.pc || null, p.defaultExp],
      );
      await logEv(req.user!.id, req.user!.username, 'Supplier added', `${p.name} (${code})`, req.companyId);
      res.status(201).json({ code });
    });
  } catch (e) { next(e); }
});

parties.patch('/suppliers/:code', requireCan('suppliers', 'maint'), async (req: AuthedReq, res, next) => {
  try {
    const p = supSchema.parse(req.body);
    await withTx(async (c) => {
      const cur = (await c.query('select code, name from suppliers where company_id = $1 and code = $2', [req.companyId, req.params.code])).rows[0];
      if (!cur) throw new ApiError(404, 'Supplier not found.');
      const e = await validateSupplier(c, req.companyId!, p, cur.code);
      if (e) throw new ApiError(400, e);
      await c.query(
        `update suppliers set name = $3, trading = $4, vat_no = $5, reg_no = $6, contact = $7, email = $8, phone = $9,
           bank_account = $10, terms = $11, street = $12, suburb = $13, city = $14, prov = $15, postal_code = $16, default_exp = $17
         where company_id = $1 and code = $2`,
        [req.companyId, cur.code, p.name, p.trading || null, p.vat || null, p.reg || null, p.contact || null, p.email, p.phone || null, p.bank || null, p.terms, p.street || null, p.suburb || null, p.city || null, p.prov, p.pc || null, p.defaultExp],
      );
      await logEv(req.user!.id, req.user!.username, 'Supplier updated', `${p.name} (${cur.code})` + (p.name !== cur.name ? ` — renamed from ${cur.name}` : ''), req.companyId);
      res.json({ code: cur.code });
    });
  } catch (e) { next(e); }
});

// ── Sales item types (NIT) — legacy 5395–5412 ──

const nitSchema = z.object({
  name: z.string().trim(),
  price: z.number().optional().default(0),
  gl: z.string().regex(/^\d{4}$/),
  vat: z.enum(['15', '0', 'e']).optional().default('15'),
});

parties.get('/sitypes', requireCan('settings', 'sitypes'), async (req: AuthedReq, res, next) => {
  try {
    res.json((await q(`select code, name, price::float, gl, vat, active from sales_item_types where company_id = $1 order by code`, [req.companyId])).rows);
  } catch (e) { next(e); }
});

parties.post('/sitypes', requireCan('settings', 'sitypes'), async (req: AuthedReq, res, next) => {
  try {
    const p = nitSchema.parse(req.body);
    await withTx(async (c) => {
      if (p.name.length < 2) throw new ApiError(400, 'Enter the item type name.');
      const dup = (await c.query('select 1 as x from sales_item_types where company_id = $1 and lower(btrim(name)) = lower(btrim($2))', [req.companyId, p.name])).rows.length;
      if (dup) throw new ApiError(409, `An item type called "${p.name}" already exists.`);
      const a = (await c.query('select 1 as x from accounts where company_id = $1 and code = $2', [req.companyId, p.gl])).rows.length;
      if (!a) throw new ApiError(400, 'Choose the income account.');
      const code = await nextDocRef(c, req.companyId!, 'sales_item_types', 'NI', 1, 'code');
      await c.query('insert into sales_item_types (company_id, code, name, price, gl, vat) values ($1,$2,$3,$4,$5,$6)', [req.companyId, code, p.name, p.price, p.gl, p.vat]);
      await logEv(req.user!.id, req.user!.username, 'Sales item type added', `${code} · ${p.name}`, req.companyId);
      res.status(201).json({ code });
    });
  } catch (e) { next(e); }
});

parties.delete('/sitypes/:code', requireCan('settings', 'sitypes'), async (req: AuthedReq, res, next) => {
  try {
    await q('update sales_item_types set active = false where company_id = $1 and code = $2', [req.companyId, req.params.code]);
    await logEv(req.user!.id, req.user!.username, 'Sales item type deactivated', String(req.params.code), req.companyId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
