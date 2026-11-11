import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { ApiError, AuthedReq, logEv, requireAuth, requireCan } from '../middleware.js';
import { checkPostingDate, nextDocRef, postJournal, r2, withTx } from '../posting.js';
import { fyIdFor, postSubJournal, subJnlSchema } from './sales.routes.js';

export const purchases = Router();
purchases.use(requireAuth);

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
              s.due_date as "due", s.description, s.account, s.excl::float as ex, s.vat::float, s.total::float as tot
         from supplier_invoices s join suppliers sp on sp.company_id = s.company_id and sp.code = s.supplier_code
        where s.company_id = $1 order by s.invoice_date desc, s.id desc`, [req.companyId])).rows);
  } catch (e) { next(e); }
});

purchases.post('/supplier-invoices', requireCan('procurement', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const p = piSchema.parse(req.body);
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
      const fyId = await fyIdFor(c, req.companyId!, p.date);
      await c.query(
        `insert into supplier_invoices (company_id, id, fy_id, supplier_code, their_no, invoice_date, due_date, description, account, excl, vat, total)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [req.companyId, id, fyId, sup.code, p.theirNo.trim(), p.date, p.due || null, p.desc || null, p.acc, ex, vat, tot],
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
