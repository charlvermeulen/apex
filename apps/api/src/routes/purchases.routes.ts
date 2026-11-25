import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { ApiError, AuthedReq, logEv, requireAuth, requireCan } from '../middleware.js';
import { checkPostingDate, nextDocRef, postJournal, r2, withTx, type Client } from '../posting.js';
import { fyIdFor, postSubJournal, subJnlSchema } from './sales.routes.js';

export const purchases = Router();
purchases.use(requireAuth);

const todayISO = () => new Date().toISOString().slice(0, 10);

// ── Supplier Invoices (legacy saveSinv 5129–5139 + glJournalBase 5543) ──

const piSchema = z.object({
  supplier: z.string().trim(),
  theirNo: z.string().trim().max(40),
  date: z.string(),
  due: z.string().optional().default(''),
  desc: z.string().trim().max(120).optional().default(''),
  acc: z.string().regex(/^\d{4}$/),
  amount: z.number(),
  vat: z.enum(['15', '0', 'e']),
});

purchases.get('/supplier-invoices', requireCan('procurement', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    res.json((await q(
      `select s.id, s.supplier_code as "sup", sp.name as "supName", s.their_no as "theirNo", s.invoice_date as "date",
              s.due_date as "due", s.description, s.account, s.excl::float as ex, s.vat::float, s.total::float as tot,
              s.grn_id as grn, s.po_id as po
         from supplier_invoices s join suppliers sp on sp.company_id = s.company_id and sp.code = s.supplier_code
        where s.company_id = $1 order by s.invoice_date desc, s.id desc`, [req.companyId])).rows);
  } catch (e) { next(e); }
});

purchases.post('/supplier-invoices', requireCan('procurement', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const p = piSchema.extend({ grn: z.string().optional().default('') }).parse(req.body);
    await withTx(async (c) => {
      const sup = (await c.query('select code, name from suppliers where company_id = $1 and code = $2 and active', [req.companyId, p.supplier])).rows[0];
      if (!sup) throw new ApiError(400, 'Select the supplier.');
      if (!p.theirNo) throw new ApiError(400, 'Enter the supplier invoice number.');
      const dup = (await c.query('select 1 as x from supplier_invoices where company_id = $1 and supplier_code = $2 and lower(their_no) = lower($3)', [req.companyId, sup.code, p.theirNo.trim()])).rows.length;
      if (dup) throw new ApiError(409, 'This supplier invoice number has already been captured.');
      if (!p.date) throw new ApiError(400, 'Enter the invoice date.');
      if (!(p.amount > 0)) throw new ApiError(400, 'Enter the invoice amount.');
      const acc = (await c.query('select code from accounts where company_id = $1 and code = $2', [req.companyId, p.acc])).rows[0];
      if (!acc) throw new ApiError(400, 'Select the expense account.');
      const pe = await checkPostingDate(c, req.companyId!, p.date);
      if (pe) throw new ApiError(400, pe);
      const ex = r2(p.amount);
      const vat = p.vat === '15' ? r2(ex * 0.15) : 0;
      const tot = r2(ex + vat);
      const id = await nextDocRef(c, req.companyId!, 'supplier_invoices', `PI-${p.date.slice(0, 4)}`, 23);
      // capture against a goods received note (legacy saveSinv g.inv link)
      let grnId: string | null = null, poId: string | null = null;
      if (p.grn) {
        const g = (await c.query(`select id, po_id, supplier_code, invoice_id from goods_received where company_id = $1 and id = $2`, [req.companyId, p.grn])).rows[0];
        if (!g) throw new ApiError(400, 'Select the purchase order this delivery is for.');
        if (g.supplier_code !== sup.code) throw new ApiError(400, 'Select the supplier.');
        if (g.invoice_id) throw new ApiError(409, 'This goods received note has already been invoiced.');
        grnId = g.id; poId = g.po_id;
        await c.query(`update goods_received set invoice_id = $3 where company_id = $1 and id = $2`, [req.companyId, g.id, id]);
      }
      const fyId = await fyIdFor(c, req.companyId!, p.date);
      await c.query(
        `insert into supplier_invoices (company_id, id, fy_id, supplier_code, their_no, invoice_date, due_date, description, account, excl, vat, total, grn_id, po_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [req.companyId, id, fyId, sup.code, p.theirNo.trim(), p.date, p.due || null, p.desc || null, p.acc, ex, vat, tot, grnId, poId],
      );
      // glJournalBase 5543: Dr expense, Dr VAT input, Cr AP
      const jid = await postJournal(c, {
        companyId: req.companyId!, fyId, date: p.date, ref: id,
        src: 'Supplier Invoice', srcType: 'supplier_invoice', srcId: id, desc: sup.name, userId: req.user!.id,
        lines: [
          { acc: p.acc, dr: ex, cr: 0, desc: p.desc || undefined },
          ...(vat ? [{ acc: '6300', dr: vat, cr: 0 }] : []),
          { acc: '9000', dr: 0, cr: tot },
        ],
      });
      await c.query(
        `insert into party_ledger (company_id, party_type, party_code, entry_date, ref, doc_type, description, debit, credit, journal_id)
         values ($1,'sup',$2,$3,$4,'Supplier Invoice',$5,0,$6,$7)`,
        [req.companyId, sup.code, p.date, id, 'Invoice ' + p.theirNo.trim() + (p.desc ? ' — ' + p.desc : ''), tot, jid],
      );
      await logEv(req.user!.id, req.user!.username, 'Supplier invoice captured', `${id} · ${sup.name}`, req.companyId);
      res.status(201).json({ id });
    });
  } catch (e) { next(e); }
});

// ── Debit Notes (legacy sdn form; reverse of PI: Dr AP, Cr expense, Cr VAT input) ──

const dnSchema = z.object({
  supplier: z.string().trim(),
  orig: z.string().trim().max(40),
  date: z.string(),
  reason: z.enum(['Returned Goods', 'Overcharge', 'Short Delivery', 'Quality Issue', 'Other']),
  desc: z.string().trim().min(1).max(120),
  amount: z.number(),
  vat: z.enum(['Standard 15%', 'Zero-Rated 0%', 'Exempt']),
});

purchases.get('/debit-notes', requireCan('procurement', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    res.json((await q(
      `select d.id, d.supplier_code as "sup", sp.name as "supName", d.orig_invoice as "orig", d.dn_date as "date",
              d.reason, d.description, d.excl::float, d.vat_amt::float as "vatAmt", d.total::float as tot
         from debit_notes d join suppliers sp on sp.company_id = d.company_id and sp.code = d.supplier_code
        where d.company_id = $1 order by d.dn_date desc, d.id desc`, [req.companyId])).rows);
  } catch (e) { next(e); }
});

purchases.post('/debit-notes', requireCan('procurement', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const p = dnSchema.parse(req.body);
    await withTx(async (c) => {
      const sup = (await c.query('select code, name, default_exp from suppliers where company_id = $1 and code = $2 and active', [req.companyId, p.supplier])).rows[0];
      if (!sup) throw new ApiError(400, 'Select the supplier.');
      if (!p.orig) throw new ApiError(400, 'Enter the original invoice number.');
      if (!p.date) throw new ApiError(400, 'Enter the debit note date.');
      if (!(p.amount > 0)) throw new ApiError(400, 'Enter the debit note amount.');
      const pe = await checkPostingDate(c, req.companyId!, p.date);
      if (pe) throw new ApiError(400, pe);
      const orig = (await c.query('select account from supplier_invoices where company_id = $1 and id = $2', [req.companyId, p.orig])).rows[0];
      const acc = orig?.account ?? sup.default_exp ?? '2000';
      const ex = r2(p.amount);
      const vatAmt = p.vat === 'Standard 15%' ? r2(ex * 0.15) : 0;
      const tot = r2(ex + vatAmt);
      const id = await nextDocRef(c, req.companyId!, 'debit_notes', `DN-${p.date.slice(0, 4)}`, 4);
      const fyId = await fyIdFor(c, req.companyId!, p.date);
      await c.query(
        `insert into debit_notes (company_id, id, fy_id, supplier_code, orig_invoice, dn_date, reason, description, excl, vat, vat_amt, total)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [req.companyId, id, fyId, sup.code, p.orig, p.date, p.reason, p.desc, ex, p.vat, vatAmt, tot],
      );
      const jid = await postJournal(c, {
        companyId: req.companyId!, fyId, date: p.date, ref: id,
        src: 'Debit Note', srcType: 'debit_note', srcId: id, desc: sup.name, userId: req.user!.id,
        lines: [
          { acc: '9000', dr: tot, cr: 0 },
          { acc, dr: 0, cr: ex },
          ...(vatAmt ? [{ acc: '6300', dr: 0, cr: vatAmt }] : []),
        ],
      });
      await c.query(
        `insert into party_ledger (company_id, party_type, party_code, entry_date, ref, doc_type, description, debit, credit, journal_id)
         values ($1,'sup',$2,$3,$4,'Debit Note',$5,$6,0,$7)`,
        [req.companyId, sup.code, p.date, id, 'Debit Note — ' + p.orig, tot, jid],
      );
      await logEv(req.user!.id, req.user!.username, 'Debit note created', `${id} · ${sup.code} · ${p.orig}`, req.companyId);
      res.status(201).json({ id });
    });
  } catch (e) { next(e); }
});

// ── Supplier Journals ──

purchases.post('/sup-journal', requireCan('suppliers', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const p = subJnlSchema.parse(req.body);
    const ref = await withTx((c) => postSubJournal(c, req, 'sup', p));
    res.status(201).json({ ref });
  } catch (e) { next(e); }
});

purchases.get('/sup-journals', requireCan('suppliers', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    res.json((await q(
      `select j.ref, j.journal_date as date, p.party_code as sup, sp.name as "supName", p.description,
              case when p.credit > 0 then 'Credit' else 'Debit' end as type, greatest(p.debit, p.credit)::float as amount
         from journals j join party_ledger p on p.journal_id = j.id
           left join suppliers sp on sp.company_id = j.company_id and sp.code = p.party_code
        where j.company_id = $1 and j.src_type = 'supplier_journal' order by j.journal_date desc, j.ref desc`, [req.companyId])).rows);
  } catch (e) { next(e); }
});

// ── Purchase Orders (legacy openPO/savePO 4996–5065) ──

const poLineSchema = z.object({
  stock: z.string().optional().default(''),
  desc: z.string(),
  qty: z.number(),
  price: z.number(),
  vat: z.enum(['15', '0']),
});
// poTotals (4998) — line totals r2(q*price), vat r2(per line), summed
const poTotals = (lines: { qty: number; price: number; vat: string }[]) => {
  let ex = 0, vat = 0;
  lines.forEach((l) => { const t = r2(l.qty * l.price); ex += t; vat += r2(t * Number(l.vat) / 100); });
  return { ex: r2(ex), vat: r2(vat), inc: r2(r2(ex) + r2(vat)) };
};
const poOpen = (s: string) => ['Draft', 'Approved', 'Sent', 'Part received'].includes(s);

const poList = async (companyId: string) => {
  const h = (await q(
    `select p.id, p.supplier_code as sup, s.name as "supName", p.order_date as date, p.due_date as due,
            coalesce(p.ref,'') as ref, coalesce(p.deliver_to,'') as deliver, coalesce(p.notes,'') as notes,
            p.ordered_by as "by", e.name as "byName", p.status, p.approved_date as approved, p.received_date as received,
            p.created
       from purchase_orders p
         join suppliers s on s.company_id = p.company_id and s.code = p.supplier_code
         left join employees e on e.company_id = p.company_id and e.code = p.ordered_by
      where p.company_id = $1 order by p.id desc`, [companyId])).rows as any[];
  const lines = (await q(
    `select po_id as po, seq, coalesce(stock_sku,'') as stock, descr as "desc", qty::float, price::float, vat::float
       from purchase_order_lines where company_id = $1 order by po_id, seq`, [companyId])).rows as any[];
  const recv = (await q(
    `select g.po_id, l.po_line, sum(l.qty)::float as n
       from goods_received_lines l join goods_received g on g.company_id = l.company_id and g.id = l.grn_id
      where l.company_id = $1 group by g.po_id, l.po_line`, [companyId])).rows as any[];
  const recMap: Record<string, number[]> = {};
  recv.forEach((r) => { (recMap[r.po_id] ||= [])[r.po_line] = (recMap[r.po_id][r.po_line] || 0) + r.n; });
  for (const o of h) {
    o.lines = lines.filter((l) => l.po === o.id);
    o.recv = o.lines.map((_l: any, i: number) => r2(recMap[o.id]?.[i] ?? 0));
    o.tot = poTotals(o.lines.map((l: any) => ({ ...l, vat: String(l.vat) })));
  }
  return h;
};

purchases.get('/purchase-orders', requireCan('procurement', 'trans'), async (req: AuthedReq, res, next) => {
  try { res.json(await poList(req.companyId!)); } catch (e) { next(e); }
});

// 'Requestor (ordered by)' — active employees for the PO form (procurement-visible, mirrors /techs)
purchases.get('/po-staff', requireCan('procurement', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    res.json((await q(`select code, name from employees where company_id = $1 and active order by name`, [req.companyId])).rows);
  } catch (e) { next(e); }
});

// savePO (5021–5027) — validation verbatim
const poSchema = z.object({
  sup: z.string().trim(), date: z.string(), due: z.string(), ref: z.string().trim().optional().default(''),
  by: z.string().optional().default(''), deliver: z.string().trim().optional().default(''), notes: z.string().trim().optional().default(''),
  lines: z.array(poLineSchema),
});
const validatePO = (o: z.infer<typeof poSchema>): string => {
  if (!o.sup) return 'Select the supplier.';
  if (!o.date) return 'Enter the order date.';
  if (!o.due) return 'Enter the date delivery is required by.';
  if (o.due < o.date) return 'The delivery date cannot be before the order date.';
  if (!o.lines.length) return 'Add at least one order line.';
  for (const l of o.lines) {
    if (!l.desc) return 'Every line needs a description.';
    if (!(l.qty > 0)) return 'Every line needs a quantity above zero.';
    if (l.price < 0) return 'Prices cannot be negative.';
  }
  return '';
};

purchases.post('/purchase-orders', requireCan('procurement', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const o = poSchema.parse(req.body);
    const e = validatePO(o);
    if (e) throw new ApiError(400, e);
    await withTx(async (c) => {
      const sup = (await c.query('select code from suppliers where company_id = $1 and code = $2 and active', [req.companyId, o.sup])).rows[0];
      if (!sup) throw new ApiError(400, 'Select the supplier.');
      const id = await nextDocRef(c, req.companyId!, 'purchase_orders', 'PO', 1, 'id', 5);
      await c.query(
        `insert into purchase_orders (company_id, id, supplier_code, order_date, due_date, ref, deliver_to, ordered_by, notes, status, created)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Draft',$10)`,
        [req.companyId, id, o.sup, o.date, o.due, o.ref || null, o.deliver || null, o.by || null, o.notes || null, todayISO()]);
      for (let i = 0; i < o.lines.length; i++) {
        const l = o.lines[i];
        await c.query(
          `insert into purchase_order_lines (company_id, po_id, seq, stock_sku, descr, qty, price, vat) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [req.companyId, id, i + 1, l.stock || null, l.desc, l.qty, l.price, Number(l.vat)]);
      }
      await logEv(req.user!.id, req.user!.username, 'Purchase order created', `${id} · ${o.sup}`, req.companyId);
      res.status(201).json({ id });
    });
  } catch (e) { next(e); }
});

purchases.patch('/purchase-orders/:id', requireCan('procurement', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const o = poSchema.parse(req.body);
    const e = validatePO(o);
    if (e) throw new ApiError(400, e);
    await withTx(async (c) => {
      const cur = (await c.query(`select id, status from purchase_orders where company_id = $1 and id = $2`, [req.companyId, req.params.id])).rows[0];
      if (!cur) throw new ApiError(404, 'Purchase order not found.');
      if (cur.status !== 'Draft') throw new ApiError(400, 'Only draft purchase orders can be edited.');
      const sup = (await c.query('select code from suppliers where company_id = $1 and code = $2 and active', [req.companyId, o.sup])).rows[0];
      if (!sup) throw new ApiError(400, 'Select the supplier.');
      await c.query(
        `update purchase_orders set supplier_code = $3, order_date = $4, due_date = $5, ref = $6, deliver_to = $7, ordered_by = $8, notes = $9
          where company_id = $1 and id = $2`,
        [req.companyId, cur.id, o.sup, o.date, o.due, o.ref || null, o.deliver || null, o.by || null, o.notes || null]);
      await c.query(`delete from purchase_order_lines where company_id = $1 and po_id = $2`, [req.companyId, cur.id]);
      for (let i = 0; i < o.lines.length; i++) {
        const l = o.lines[i];
        await c.query(
          `insert into purchase_order_lines (company_id, po_id, seq, stock_sku, descr, qty, price, vat) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [req.companyId, cur.id, i + 1, l.stock || null, l.desc, l.qty, l.price, Number(l.vat)]);
      }
      await logEv(req.user!.id, req.user!.username, 'Purchase order updated', cur.id, req.companyId);
      res.json({ id: cur.id });
    });
  } catch (e) { next(e); }
});

// poStatus (5032–5038) — approve/mark sent/cancel
purchases.post('/purchase-orders/:id/status', requireCan('procurement', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const { to } = z.object({ to: z.enum(['Approved', 'Sent', 'Cancelled', 'Received']) }).parse(req.body);
    await withTx(async (c) => {
      const o = (await c.query(`select id, status, order_date from purchase_orders where company_id = $1 and id = $2`, [req.companyId, req.params.id])).rows[0];
      if (!o) throw new ApiError(404, 'Purchase order not found.');
      if (to === 'Approved' && !['admin', 'accountant'].includes(req.user!.role))
        throw new ApiError(403, 'Only an administrator or accountant can approve purchase orders.');
      if (to === 'Received') {
        const d = z.object({ received: z.string() }).parse(req.body).received;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < (await c.query(`select order_date from purchase_orders where company_id = $1 and id = $2`, [req.companyId, o.id])).rows[0].order_date)
          throw new ApiError(400, 'Enter a valid date on or after the order date.');
        await c.query(`update purchase_orders set received_date = $3 where company_id = $1 and id = $2`, [req.companyId, o.id, d]);
      }
      await c.query(`update purchase_orders set status = $3, approved_date = case when $4::bool then current_date else approved_date end
                      where company_id = $1 and id = $2`, [req.companyId, o.id, to, to === 'Approved']);
      await logEv(req.user!.id, req.user!.username, `Purchase order ${to.toLowerCase()}`, o.id, req.companyId);
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});

purchases.delete('/purchase-orders/:id', requireCan('procurement', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    await withTx(async (c) => {
      const o = (await c.query(`select id, status from purchase_orders where company_id = $1 and id = $2`, [req.companyId, req.params.id])).rows[0];
      if (!o) throw new ApiError(404, 'Purchase order not found.');
      if (o.status !== 'Draft') throw new ApiError(400, 'Only draft purchase orders can be edited.');
      await c.query(`delete from purchase_order_lines where company_id = $1 and po_id = $2`, [req.companyId, o.id]);
      await c.query(`delete from purchase_orders where company_id = $1 and id = $2`, [req.companyId, o.id]);
      await logEv(req.user!.id, req.user!.username, 'Purchase order deleted', o.id, req.companyId);
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});

// ── Goods Received Notes (legacy openGRN/saveGRN 5076–5115) ──

// applyGrnStock (5363–5365): lines with a stock product add a qty_in move
purchases.get('/grns', requireCan('procurement', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const h = (await q(
      `select g.id, g.po_id as po, g.supplier_code as sup, s.name as "supName", g.rec_date as date,
              coalesce(g.dn_ref,'') as dn, coalesce(g.location,'') as loc, g.invoice_id as inv
         from goods_received g join suppliers s on s.company_id = g.company_id and s.code = g.supplier_code
        where g.company_id = $1 order by g.id desc`, [req.companyId])).rows as any[];
    const lines = (await q(
      `select grn_id, descr as "desc", qty::float, price::float, vat::float from goods_received_lines where company_id = $1 order by grn_id, seq`, [req.companyId])).rows as any[];
    for (const g of h) {
      g.lines = lines.filter((l) => l.grn_id === g.id);
    }
    res.json(h);
  } catch (e) { next(e); }
});

purchases.get('/grns/:po', requireCan('procurement', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const po = (await q(
      `select p.id, p.supplier_code as sup, p.order_date as date, l.seq, l.stock_sku as stock, l.descr, l.qty::float, l.price::float, l.vat::float,
              coalesce(rr.n, 0)::float as recv
         from purchase_orders p join purchase_order_lines l on l.company_id = p.company_id and l.po_id = p.id
         left join (select x.po_line, sum(x.qty) as n from goods_received_lines x
                      join goods_received gx on gx.company_id = x.company_id and gx.id = x.grn_id
                     where x.company_id = $1 and gx.po_id = p.id group by x.po_line) rr on rr.po_line = l.seq
        where p.company_id = $1 and p.id = $2 order by l.seq`, [req.companyId, req.params.po])).rows as any[];
    if (!po.length) throw new ApiError(404, 'Purchase order not found.');
    res.json({ id: po[0].id, sup: po[0].sup, date: po[0].date, lines: po.map((l) => ({ seq: l.seq, stock: l.stock, desc: l.descr, qty: l.qty, price: l.price, vat: l.vat, recv: r2(l.recv) })) });
  } catch (e) { next(e); }
});

purchases.post('/grns', requireCan('procurement', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const p = z.object({
      sup: z.string().trim(), po: z.string(), date: z.string(), dn: z.string().trim().optional().default(''),
      loc: z.string().trim().optional().default(''),
      lines: z.array(z.object({ i: z.number(), qty: z.number() })),
    }).parse(req.body);
    await withTx(async (c) => {
      if (!p.sup) throw new ApiError(400, 'Select the supplier.');
      const o = (await c.query(
        `select p.id, p.supplier_code, p.order_date, p.status from purchase_orders p where company_id = $1 and id = $2`, [req.companyId, p.po])).rows[0];
      if (!o) throw new ApiError(400, 'Select the purchase order this delivery is for.');
      if (o.supplier_code !== p.sup) throw new ApiError(400, 'Select the supplier.');
      if (!p.date) throw new ApiError(400, 'Enter the date received.');
      if (p.date < String(o.order_date)) throw new ApiError(400, `The date received cannot be before the order date (${fmtDate(String(o.order_date))}).`);
      const pe = await checkPostingDate(c, req.companyId!, p.date);
      if (pe) throw new ApiError(400, pe);
      const pl = (await c.query(`select seq, stock_sku, descr, qty::float, price::float, vat::float from purchase_order_lines where company_id = $1 and po_id = $2 order by seq`, [req.companyId, o.id])).rows as any[];
      const rc: Record<number, number> = {};
      (await c.query(
        `select x.po_line, sum(x.qty)::float as n from goods_received_lines x join goods_received gx on gx.company_id = x.company_id and gx.id = x.grn_id
          where x.company_id = $1 and gx.po_id = $2 group by x.po_line`, [req.companyId, o.id])).rows.forEach((r: any) => { rc[r.po_line] = r.n; });
      const lines: { i: number; descr: string; stock: string; qty: number; price: number; vat: number }[] = [];
      for (const r of p.lines) {
        const l = pl.find((x: any) => x.seq === r.i);
        if (!l) throw new ApiError(400, 'You cannot receive more than is outstanding on the order.');
        const out = r2(l.qty - (rc[l.seq] ?? 0));
        if (r.qty < 0) throw new ApiError(400, 'Quantities cannot be negative.');
        if (r.qty > out + 1e-9) throw new ApiError(400, `You cannot receive more than is outstanding on “${l.descr}” (${out}).`);
        if (r.qty > 0) lines.push({ i: l.seq, descr: l.descr, stock: l.stock_sku || '', qty: r.qty, price: l.price, vat: l.vat });
      }
      if (!lines.length) throw new ApiError(400, 'Enter a received quantity for at least one line.');
      const id = await nextDocRef(c, req.companyId!, 'goods_received', 'GRN', 1, 'id', 5);
      await c.query(
        `insert into goods_received (company_id, id, po_id, supplier_code, rec_date, dn_ref, location) values ($1,$2,$3,$4,$5,$6,$7)`,
        [req.companyId, id, o.id, o.supplier_code, p.date, p.dn || null, p.loc || null]);
      for (let s = 0; s < lines.length; s++) {
        const l = lines[s];
        await c.query(`insert into goods_received_lines (company_id, grn_id, seq, po_line, descr, qty, price, vat) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [req.companyId, id, s + 1, l.i, l.descr, l.qty, l.price, l.vat]);
        if (l.stock) {
          const has = (await c.query(`select 1 as x from stock_items where company_id = $1 and sku = $2`, [req.companyId, l.stock])).rows.length;
          if (has) await c.query(`insert into stock_moves (company_id, sku, move_date, ref, description, qty_in) values ($1,$2,$3,$4,$5,$6)`,
            [req.companyId, l.stock, p.date, id, 'Goods received — ' + o.id, l.qty]);
        }
      }
      const after: Record<number, number> = { ...rc };
      lines.forEach((l) => { after[l.i] = (after[l.i] ?? 0) + l.qty; });
      const full = pl.every((l) => r2(l.qty) <= r2(after[l.seq] ?? 0) + 1e-9);
      const nst = lines.filter((l) => l.stock).length;
      await c.query(`update purchase_orders set status = $3, received_date = case when $4::bool then $5 else received_date end where company_id = $1 and id = $2`,
        [req.companyId, o.id, full ? 'Received' : 'Part received', full, p.date]);
      await logEv(req.user!.id, req.user!.username, 'Goods received', `${id} against ${o.id}`, req.companyId);
      res.status(201).json({ id, received: full ? 'Received' : 'Part received', nst });
    });
  } catch (e) { next(e); }
});

// PO open-lines lookup for the GRN modal (gnSupChanged 5086–5089)
purchases.get('/grn-lookup', requireCan('procurement', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const rows = (await q(
      `select p.id, p.due_date as due,
              coalesce((select round(sum(l.qty * l.price + round(l.qty * l.price * l.vat / 100, 2)), 2)
                  from purchase_order_lines l where l.company_id = p.company_id and l.po_id = p.id), 0)::float as tot
         from purchase_orders p where p.company_id = $1 and p.supplier_code = $2 and p.status in ('Approved','Sent','Part received')
        order by p.id desc`, [req.companyId, req.query.sup ?? ''])).rows as any[];
    res.json(rows.map((r) => ({ id: r.id, due: r.due, label: `${r.id} · due ${fmtDate(r.due)} · R ${(r.tot ?? 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` })));
  } catch (e) { next(e); }
});
const MONS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmtDate = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d} ${MONS[+m - 1]} ${y}`; };

