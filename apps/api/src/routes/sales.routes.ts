import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { ApiError, AuthedReq, logEv, requireAuth, requireCan } from '../middleware.js';
import { checkPostingDate, nextDocRef, postJournal, r2, stkDate, withTx, type Client } from '../posting.js';

export const sales = Router();
sales.use(requireAuth);

const fyIdFor = async (c: Client, companyId: string, date: string): Promise<string | null> =>
  (await c.query('select id from financial_years where company_id = $1 and start <= $2 and end_date >= $3', [companyId, date, date])).rows[0]?.id ?? null;

export { fyIdFor };

// ── Sales Invoices (legacy saveSI2 5445–5460 + glJournalBase 5539–5542) ──

const siSchema = z.object({
  customer: z.string().trim(),
  date: z.string(),
  due: z.string(),
  ref: z.string().trim().max(40).optional().default(''),
  lines: z.array(z.object({
    type: z.enum(['inv', 'non']),
    item: z.string(),          // sku for inv, NIT code for non
    qty: z.number(),
    price: z.number(),
    vat: z.number(),           // 15 | 0
  })).min(1),
});

const siOnHand = async (c: Client, companyId: string, sku: string): Promise<number> =>
  Number((await c.query(
    `select opening_qty + coalesce((select sum(qty_in - qty_out) from stock_moves where company_id = $1 and sku = $2), 0) as q
       from stock_items where company_id = $1 and sku = $2`, [companyId, sku])).rows[0]?.q ?? 0);

sales.get('/sales-invoices', requireCan('customers', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    res.json((await q(
      `select s.id, s.customer_code as "cust", c.name as "custName", s.invoice_date as "date", s.due_date as "due",
              s.excl::float as ex, s.vat::float, s.total::float as tot,
              case when s.due_date < current_date then 'Overdue' else 'Sent' end as status
         from sales_invoices s join customers c on c.company_id = s.company_id and c.code = s.customer_code
        where s.company_id = $1 order by s.invoice_date desc, s.id desc`, [req.companyId])).rows);
  } catch (e) { next(e); }
});

sales.post('/sales-invoices', requireCan('customers', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const p = siSchema.parse(req.body);
    await withTx(async (c) => {
      const cust = (await c.query('select code, name from customers where company_id = $1 and code = $2 and active', [req.companyId, p.customer])).rows[0];
      if (!cust) throw new ApiError(400, 'Select the customer.');
      if (!p.date) throw new ApiError(400, 'Enter the invoice date.');
      if (!p.due) throw new ApiError(400, 'Enter the due date.');
      if (p.due < p.date) throw new ApiError(400, 'The due date cannot be before the invoice date.');
      const pe = await checkPostingDate(c, req.companyId!, p.date);
      if (pe) throw new ApiError(400, pe);
      // line-level checks, port of saveSI2 loop (5449–5452)
      for (const l of p.lines) {
        if (!l.item) throw new ApiError(400, 'Select an item on every line (choose the Item Type first).');
        if (!(l.qty > 0)) throw new ApiError(400, 'Every line needs a quantity above zero.');
        if (!(l.price >= 0)) throw new ApiError(400, 'Prices cannot be negative.');
      }
      // resolve items + GL mapping (catFor 5483 via the item's category)
      const resolved: any[] = [];
      for (const l of p.lines) {
        if (l.type === 'inv') {
          const it = (await c.query(
            `select i.sku, i.name, i.cost, g.gl, g.cos, g.sales
               from stock_items i join stock_categories g on g.company_id = i.company_id and g.code = i.cat_code
              where i.company_id = $1 and i.sku = $2 and i.active`, [req.companyId, l.item])).rows[0];
          if (!it) throw new ApiError(400, 'Select an item on every line (choose the Item Type first).');
          resolved.push({ ...l, sku: it.sku, desc: it.name, cost: Number(it.cost), gl: it.sales || '1000', cos: it.cos || '2000', invgl: it.gl || '6200' });
        } else {
          const t = (await c.query('select code, name, gl from sales_item_types where company_id = $1 and code = $2 and active', [req.companyId, l.item])).rows[0];
          if (!t) throw new ApiError(400, 'Select an item on every line (choose the Item Type first).');
          resolved.push({ ...l, sku: null, desc: t.name, cost: 0, gl: t.gl, cos: null, invgl: null });
        }
      }
      // stock availability, aggregated per item across the invoice's lines (saveSI2 5452)
      const need: Record<string, number> = {};
      resolved.filter((l) => l.type === 'inv').forEach((l) => { need[l.sku] = r2((need[l.sku] || 0) + l.qty); });
      for (const [sku, n] of Object.entries(need)) {
        const avail = r2(await siOnHand(c, req.companyId!, sku));
        if (n > avail + 0.0001) {
          const key = (await c.query('select name from stock_items where company_id = $1 and sku = $2', [req.companyId, sku])).rows[0]?.name ?? sku;
          throw new ApiError(400, `Not enough stock of “${sku} — ${key}”: ${avail} available, ${n} on this invoice.`);
        }
      }
      // totals (saveSI2 5455): ex = Σ qty*price, vat = Σ r2(qty*price*vat/100)
      const ex = r2(resolved.reduce((t, l) => t + l.qty * l.price, 0));
      const vat = r2(resolved.reduce((t, l) => t + r2(l.qty * l.price * l.vat / 100), 0));
      const tot = r2(ex + vat);
      const id = await nextDocRef(c, req.companyId!, 'sales_invoices', `SI-${p.date.slice(0, 4)}`, 42);
      const fyId = await fyIdFor(c, req.companyId!, p.date);
      await c.query(
        `insert into sales_invoices (company_id, id, fy_id, customer_code, invoice_date, due_date, ref, excl, vat, total)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [req.companyId, id, fyId, cust.code, p.date, p.due, p.ref || null, ex, vat, tot],
      );
      // journal lines per glJournalBase (5539–5542)
      const lines: { acc: string; dr: number; cr: number; desc?: string }[] = [];
      const crLines: { acc: string; dr: number; cr: number; desc?: string }[] = [];
      const plLines: { acc: string; dr: number; cr: number; desc?: string }[] = [];
      resolved.forEach((l) => {
        crLines.push({ acc: l.gl, dr: 0, cr: r2(l.qty * l.price), desc: l.desc });
        if (l.type === 'inv' && l.cost) {
          const cc = r2(l.qty * l.cost);
          plLines.push({ acc: l.cos, dr: cc, cr: 0 });
          plLines.push({ acc: l.invgl, dr: 0, cr: cc });
        }
      });
      if (vat) crLines.push({ acc: '9100', dr: 0, cr: vat });
      const t = r2(crLines.reduce((s, l) => s + l.cr, 0));
      lines.push({ acc: '6100', dr: t, cr: 0 });
      const jid = await postJournal(c, {
        companyId: req.companyId!, fyId, date: p.date, ref: id,
        src: 'Sales Invoice', srcType: 'sales_invoice', srcId: id, desc: cust.name, userId: req.user!.id,
        lines: lines.concat(crLines, plLines),
      });
      // customer ledger row (postSaleToLedger 5462)
      await c.query(
        `insert into party_ledger (company_id, party_type, party_code, entry_date, ref, doc_type, description, debit, credit, journal_id)
         values ($1,'cust',$2,$3,$4,'Sales Invoice',$5,$6,0,$7)`,
        [req.companyId, cust.code, p.date, id, 'Sales Invoice' + (p.ref ? ' — ' + p.ref : ''), tot, jid],
      );
      // stock rows (postSaleToLedger 5463)
      for (const l of resolved.filter((x) => x.type === 'inv')) {
        await c.query('insert into stock_moves (company_id, sku, move_date, ref, description, qty_out) values ($1,$2,$3,$4,$5,$6)',
          [req.companyId, l.sku, p.date, id, 'Sale', l.qty]);
      }
      await logEv(req.user!.id, req.user!.username, 'Sales invoice created', `${id} · ${cust.name}`, req.companyId);
      res.status(201).json({ id });
    });
  } catch (e) { next(e); }
});

// ── Credit Notes (legacy CCN form; reverse of SI) ──

const cnSchema = z.object({
  customer: z.string().trim(),
  orig: z.string().trim().max(40),
  date: z.string(),
  reason: z.enum(['Returned Goods', 'Pricing Error', 'Duplicate Invoice', 'Service Not Rendered', 'Other']),
  desc: z.string().trim().min(1).max(120),
  qty: z.number(),
  price: z.number(),
  vat: z.enum(['Standard 15%', 'Zero-Rated 0%', 'Exempt']),
});

sales.get('/credit-notes', requireCan('customers', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    res.json((await q(
      `select id, customer_code as "cust", c.name as "custName", orig_invoice as "orig", cn_date as "date",
              reason, excl::float, vat_amt::float as "vatAmt", total::float as tot
         from credit_notes n join customers c on c.company_id = n.company_id and c.code = n.customer_code
        where n.company_id = $1 order by n.cn_date desc, n.id desc`, [req.companyId])).rows);
  } catch (e) { next(e); }
});

sales.post('/credit-notes', requireCan('customers', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const p = cnSchema.parse(req.body);
    await withTx(async (c) => {
      const cust = (await c.query('select code, name from customers where company_id = $1 and code = $2 and active', [req.companyId, p.customer])).rows[0];
      if (!cust) throw new ApiError(400, 'Select the customer.');
      if (!p.orig) throw new ApiError(400, 'Enter the original invoice number.');
      if (!p.date) throw new ApiError(400, 'Enter the credit note date.');
      if (!(p.qty > 0)) throw new ApiError(400, 'Every line needs a quantity above zero.');
      if (!(p.price >= 0)) throw new ApiError(400, 'Prices cannot be negative.');
      const pe = await checkPostingDate(c, req.companyId!, p.date);
      if (pe) throw new ApiError(400, pe);
      const ex = r2(p.qty * p.price);
      const vatAmt = p.vat === 'Standard 15%' ? r2(ex * 0.15) : 0;
      const tot = r2(ex + vatAmt);
      const id = await nextDocRef(c, req.companyId!, 'credit_notes', `CN-${p.date.slice(0, 4)}`, 9);
      const fyId = await fyIdFor(c, req.companyId!, p.date);
      await c.query(
        `insert into credit_notes (company_id, id, fy_id, customer_code, orig_invoice, cn_date, reason, description, qty, price, vat, excl, vat_amt, total)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [req.companyId, id, fyId, cust.code, p.orig, p.date, p.reason, p.desc, p.qty, p.price, p.vat, ex, vatAmt, tot],
      );
      // reverse posting: Dr revenue, Dr VAT output, Cr AR
      const jid = await postJournal(c, {
        companyId: req.companyId!, fyId, date: p.date, ref: id,
        src: 'Credit Note', srcType: 'credit_note', srcId: id, desc: cust.name, userId: req.user!.id,
        lines: [
          { acc: '6100', dr: 0, cr: tot },
          { acc: '1000', dr: ex, cr: 0 },
          ...(vatAmt ? [{ acc: '9100', dr: vatAmt, cr: 0 }] : []),
        ],
      });
      await c.query(
        `insert into party_ledger (company_id, party_type, party_code, entry_date, ref, doc_type, description, debit, credit, journal_id)
         values ($1,'cust',$2,$3,$4,'Credit Note',$5,0,$6,$7)`,
        [req.companyId, cust.code, p.date, id, 'Credit Note — ' + p.orig, tot, jid],
      );
      await logEv(req.user!.id, req.user!.username, 'Credit note created', `${id} · ${cust.code} · ${p.orig}`, req.companyId);
      res.status(201).json({ id });
    });
  } catch (e) { next(e); }
});

// ── Receipts (legacy cust-rcpt; real posting: Dr bank, Cr AR) ──

const rcptSchema = z.object({
  customer: z.string().trim(),
  date: z.string(),
  bank: z.string().regex(/^\d{4}$/),
  method: z.enum(['EFT', 'Cash', 'Card', 'Cheque']).optional().default('EFT'),
  amount: z.number(),
  bankRef: z.string().trim().max(60).optional().default(''),
});

sales.get('/receipts', requireCan('customers', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    res.json((await q(
      `select id, customer_code as "cust", c.name as "custName", receipt_date as "date",
              bank_account as bank, method, amount::float, bank_ref as "bankRef"
         from receipts r join customers c on c.company_id = r.company_id and c.code = r.customer_code
        where r.company_id = $1 order by r.receipt_date desc, r.id desc`, [req.companyId])).rows);
  } catch (e) { next(e); }
});

sales.post('/receipts', requireCan('customers', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const p = rcptSchema.parse(req.body);
    await withTx(async (c) => {
      const cust = (await c.query('select code, name from customers where company_id = $1 and code = $2 and active', [req.companyId, p.customer])).rows[0];
      if (!cust) throw new ApiError(400, 'Select the customer.');
      if (!(p.amount > 0)) throw new ApiError(400, 'Enter the amount received.');
      if (!p.date) throw new ApiError(400, 'Enter the receipt date.');
      const bank = (await c.query('select code, name from accounts where company_id = $1 and code = $2', [req.companyId, p.bank])).rows[0];
      if (!bank) throw new ApiError(400, 'Select the bank account to deposit to.');
      const pe = await checkPostingDate(c, req.companyId!, p.date);
      if (pe) throw new ApiError(400, pe);
      const id = await nextDocRef(c, req.companyId!, 'receipts', `RCP-${p.date.slice(0, 4)}`, 24);
      const fyId = await fyIdFor(c, req.companyId!, p.date);
      await c.query(
        `insert into receipts (company_id, id, fy_id, customer_code, receipt_date, bank_account, method, amount, bank_ref)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [req.companyId, id, fyId, cust.code, p.date, bank.code, p.method, r2(p.amount), p.bankRef || null],
      );
      const jid = await postJournal(c, {
        companyId: req.companyId!, fyId, date: p.date, ref: id,
        src: 'Receipt', srcType: 'receipt', srcId: id, desc: cust.name, userId: req.user!.id,
        lines: [{ acc: bank.code, dr: r2(p.amount), cr: 0 }, { acc: '6100', dr: 0, cr: r2(p.amount) }],
      });
      await c.query(
        `insert into party_ledger (company_id, party_type, party_code, entry_date, ref, doc_type, description, debit, credit, journal_id)
         values ($1,'cust',$2,$3,$4,'Receipt',$5,0,$6,$7)`,
        [req.companyId, cust.code, p.date, id, 'Receipt — ' + p.method, r2(p.amount), jid],
      );
      await logEv(req.user!.id, req.user!.username, 'Receipt posted', `${id} · ${cust.code} · ${p.method}`, req.companyId);
      res.status(201).json({ id });
    });
  } catch (e) { next(e); }
});

// ── Customer Journals (legacy postSubJnl 2047–2059, persisted) ──

export const subJnlSchema = z.object({
  party: z.string().trim(),
  type: z.enum(['inc', 'dec']),
  contra: z.string().regex(/^\d{4}$/),
  amount: z.number(),
  narration: z.string().trim().min(1).max(200),
  date: z.string(),
});

export async function postSubJournal(
  c: Client, req: AuthedReq, kind: 'cust' | 'sup', p: z.infer<typeof subJnlSchema>,
): Promise<string> {
  const table = kind === 'cust' ? 'customers' : 'suppliers';
  const party = (await c.query(`select code, name from ${table} where company_id = $1 and code = $2 and active`, [req.companyId, p.party])).rows[0];
  if (!party) throw new ApiError(400, kind === 'cust' ? 'Select the customer.' : 'Select the supplier.');
  if (!(p.amount > 0)) throw new ApiError(400, 'Enter an amount and a narration before posting.');
  const contra = (await c.query('select code from accounts where company_id = $1 and code = $2', [req.companyId, p.contra])).rows[0];
  if (!contra) throw new ApiError(400, 'Choose the contra account.');
  const pe = await checkPostingDate(c, req.companyId!, p.date);
  if (pe) throw new ApiError(400, pe);
  // subJnlLines (2032–2038): cust Debit on inc; supplier Debit on dec
  const ctlDebit = kind === 'cust' ? p.type === 'inc' : p.type === 'dec';
  const ctl = kind === 'cust' ? '6100' : '9000';
  const amt = r2(p.amount);
  const src = kind === 'cust' ? 'customer_journal' : 'supplier_journal';
  const seq = (await c.query(`select count(*)::int as n from journals where company_id = $1 and src_type = $2`, [req.companyId, src])).rows[0].n;
  const ref = `${kind === 'cust' ? 'CJ' : 'SJ'}-${p.date.slice(0, 4)}-${String(seq + 1).padStart(3, '0')}`;
  const fyId = await fyIdFor(c, req.companyId!, p.date);
  const jid = await postJournal(c, {
    companyId: req.companyId!, fyId, date: p.date, ref,
    src: kind === 'cust' ? 'Customer Journal' : 'Supplier Journal', srcType: src, srcId: '', desc: p.narration, userId: req.user!.id,
    lines: ctlDebit
      ? [{ acc: ctl, dr: amt, cr: 0, desc: party.name }, { acc: contra.code, dr: 0, cr: amt, desc: p.narration }]
      : [{ acc: ctl, dr: 0, cr: amt, desc: party.name }, { acc: contra.code, dr: amt, cr: 0, desc: p.narration }],
  });
  // ctlDebit = balance up on the ledger (customer owed↑ / supplier owed↓)
  await c.query(
    `insert into party_ledger (company_id, party_type, party_code, entry_date, ref, doc_type, description, debit, credit, journal_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [req.companyId, kind, party.code, p.date, ref, kind === 'cust' ? 'Customer Journal' : 'Supplier Journal', p.narration,
      ctlDebit ? amt : 0, ctlDebit ? 0 : amt, jid],
  );
  await logEv(req.user!.id, req.user!.username, kind === 'cust' ? 'Customer journal posted' : 'Supplier journal posted',
    `${ref} · ${party.code} · ${p.type === 'inc' ? 'Debit' : 'Credit'} to control`, req.companyId);
  return ref;
}

sales.post('/cust-journal', requireCan('customers', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const p = subJnlSchema.parse(req.body);
    const ref = await withTx((c) => postSubJournal(c, req, 'cust', p));
    res.status(201).json({ ref });
  } catch (e) { next(e); }
});

sales.get('/cust-journals', requireCan('customers', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    res.json((await q(
      `select j.ref, j.journal_date as date, p.party_code as cust, c.name as "custName", p.description,
              case when p.debit > 0 then 'Debit' else 'Credit' end as type, greatest(p.debit, p.credit)::float as amount
         from journals j join party_ledger p on p.journal_id = j.id
           left join customers c on c.company_id = j.company_id and c.code = p.party_code
        where j.company_id = $1 and j.src_type = 'customer_journal' order by j.journal_date desc, j.ref desc`, [req.companyId])).rows);
  } catch (e) { next(e); }
});
