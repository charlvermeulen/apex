import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import { ApiError, AuthedReq, logEv, requireAuth, requireCan } from '../middleware.js';
import { fmtD, r2, vatLabel, withTx } from '../posting.js';
import { addMonths, dayAdd, todayISO } from './contracts.routes.js';
import type { Request, NextFunction } from 'express';
import { q } from '../db.js';

export const vat = Router();
vat.use(requireAuth);

const canVat = requireCan('vat', '*'); // legacy vat module is section-less: canMod('vat') guards everything, admin-only reopen

const perLastOfMonth = (m: string) => dayAdd(addMonths(m + '-01', 1), -1);

// Client-or-pool: pool reads go through q(), tx closures through c.query
type Exec = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };
const pool: Exec = { query: q };

const periodOr404 = async (c: Exec, companyId: string, id: string) => {
  const p = (await c.query(
    `select id, start, end_date as "end", status, closed_at as "closedAt", closed_by as "closedBy",
            submitted_at as "submittedAt", snap from vat_periods where company_id = $1 and id = $2`, [companyId, id],
  )).rows[0];
  if (!p) throw new ApiError(404, 'No such VAT period.');
  return p;
};

// vatDocs (3985) + vatCalc (3997) in one pass: the five document sources,
// date-filtered to the period, sorted by date then doc. VAT amounts come from the
// stored excl/vat columns (legacy derived from totals; identical for Standard 15% docs).
const docsIn = async (c: Exec, companyId: string, start: string, end: string) => {
  const rows = (await c.query(
    `select t.* from (
      select i.invoice_date as date, i.id as doc, 'Sales Invoice' as type, c.name as party,
             c.vat_no as "vatNo", i.excl::float8 as excl, i.vat::float8 as vat, i.total::float8 as incl, true as out
        from sales_invoices i join customers c on c.company_id = i.company_id and c.code = i.customer_code
       where i.company_id = $1 and i.total > 0
      union all
      select n.cn_date, n.id, 'Credit Note', c.name, c.vat_no, n.excl::float8, n.vat_amt::float8, n.total::float8, true
        from credit_notes n join customers c on c.company_id = n.company_id and c.code = n.customer_code
       where n.company_id = $1 and n.vat_amt > 0
      union all
      select b.invoice_date, b.id, 'Contract Invoice', c.name, c.vat_no, b.excl::float8, b.vat::float8, b.total::float8, true
        from contract_invoices b join customers c on c.company_id = b.company_id and c.code = b.customer_code
       where b.company_id = $1
      union all
      select s.invoice_date, s.id, 'Supplier Invoice', x.name, ''::text, s.excl::float8, s.vat::float8, s.total::float8, false
        from supplier_invoices s join suppliers x on x.company_id = s.company_id and x.code = s.supplier_code
       where s.company_id = $1 and s.total > 0
      union all
      select d.dn_date, d.id, 'Debit Note', x.name, ''::text, d.excl::float8, d.vat_amt::float8, d.total::float8, false
        from debit_notes d join suppliers x on x.company_id = d.company_id and x.code = d.supplier_code
       where d.company_id = $1 and d.total > 0
     ) t where t.date >= $2 and t.date <= $3
    order by t.date, t.doc`, [companyId, start, end])).rows as any[];
  for (const r of rows) {
    r.box = r.out ? '1A' : '2A';
    r.excl = r2(r.excl); r.vat = r2(r.vat); r.incl = r2(r.incl);
    r.date = String(r.date).slice(0, 10);
  }
  return rows;
};

const figures = (docs: any[]) => {
  const sum = (f: (x: any) => boolean, k: string) => r2(docs.filter(f).reduce((t, x) => t + x[k], 0));
  const outEx = sum((x) => x.out, 'excl'), out = sum((x) => x.out, 'vat');
  const inEx = sum((x) => !x.out, 'excl'), inn = sum((x) => !x.out, 'vat');
  return { outEx, out, inEx, inn, net: r2(out - inn), docs: docs.length };
};

// GET /api/vat/periods — every period with its figures (frozen snap when closed)
vat.get('/vat/periods', canVat, async (req: AuthedReq, res: Response, next: NextFunction) => {
  try {
    const ps = (await q(
      `select id, start, end_date as "end", status, closed_at as "closedAt", closed_by as "closedBy", submitted_at as "submittedAt", snap
         from vat_periods where company_id = $1 order by start desc`, [req.companyId])).rows;
    if (!ps.length) return res.json([]);
    // one pass over all docs, grouped by period (Neon: cheaper than per-period queries)
    const min = ps[ps.length - 1].start, max = ps[0].end;
    const docs = await docsIn(pool, req.companyId!, min, max);
    res.json(ps.map((p) => {
      const f = p.status === 'closed' && p.snap ? p.snap : figures(docs.filter((d) => d.date >= p.start && d.date <= p.end));
      const e = String(p.end).slice(0, 10); const s = String(p.start).slice(0, 10);
      return { ...p, start: s, end: e, due: dayAdd(addMonths(e.slice(0, 7) + '-01', 2), -1), net: f.net, out: f.out, inn: f.inn, nDocs: f.docs, label: vatLabel(s, e) };
    }));
  } catch (err) { next(err); }
});

// GET /api/vat/detail?id=YYYY-MM — the VAT Detail doc rows (renderVatDetail 4032)
vat.get('/vat/detail', canVat, async (req: AuthedReq, res: Response, next: NextFunction) => {
  try {
    const p = await periodOr404(pool, req.companyId!, String(req.query.id || ''));
    const docs = await docsIn(pool, req.companyId!, p.start, p.end);
    const f = figures(docs);
    res.json({ period: { ...p, start: String(p.start).slice(0, 10), end: String(p.end).slice(0, 10) }, docs, figures: f });
  } catch (err) { next(err); }
});

const periodBody = z.object({ m: z.string(), len: z.number() });

// POST /api/vat/periods — addVatPeriod (4045), validation order verbatim
vat.post('/vat/periods', canVat, async (req: AuthedReq, res: Response, next: NextFunction) => {
  try {
    const { m, len } = periodBody.parse(req.body);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new ApiError(400, 'Choose the month the period starts.');
    if (![1, 2, 6].includes(len)) throw new ApiError(400, 'Choose valid period length — 1 (monthly), 2 (bi-monthly) or 6 (six-monthly).'); // new guard (legacy select offered 1/2/6 only)
    const st = m + '-01';
    const en = perLastOfMonth(addMonths(st, len - 1).slice(0, 7));
    const last = (await q(`select end_date as "end" from vat_periods where company_id = $1 order by start desc limit 1`, [req.companyId])).rows[0];
    if (last && st !== dayAdd(String(last.end), 1))
      throw new ApiError(400, `The next period must start on ${fmtD(dayAdd(String(last.end), 1))}.`);
    if ((await q(`select 1 from vat_periods where company_id = $1 and $2 <= end_date and $3 >= "start"`,
      [req.companyId, st, en])).rows.length) throw new ApiError(400, 'That period overlaps an existing one.');
    await q(`insert into vat_periods (company_id, id, start, end_date) values ($1,$2,$3,$4)`, [req.companyId, m, st, en]);
    await logEv(req.user!.id, req.user!.username, 'VAT period added', vatLabel(st, en), req.companyId);
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/vat/periods/:id/close — closeVatPeriod (4055), guards verbatim
vat.post('/vat/periods/:id/close', canVat, async (req: AuthedReq, res: Response, next: NextFunction) => {
  try {
    await withTx(async (c) => {
      const p = await periodOr404(c, req.companyId!, req.params.id as string);
      if (p.status !== 'open') throw new ApiError(400, 'This VAT period is not open.');
      if (todayISO() <= p.end)
        throw new ApiError(400, `This period ends on ${fmtD(p.end)}. It can only be closed after it has ended.`);
      const prior = (await c.query(`select id, start, end_date as "end" from vat_periods
        where company_id = $1 and "start" < $2 and status = 'open' order by "start" limit 1`, [req.companyId!, p.start])).rows[0];
      if (prior)
        throw new ApiError(400, `Close ${vatLabel(prior.start, prior.end)} first. VAT periods close oldest first.`);
      const f = figures(await docsIn(c, req.companyId!, p.start, p.end));
      await c.query(`update vat_periods set status = 'closed', closed_at = $2, closed_by = $3, snap = $4
        where company_id = $1 and id = $5`, [req.companyId, todayISO(), req.user!.username, f, p.id]);
      await logEv(req.user!.id, req.user!.username, 'VAT period closed',
        `${vatLabel(p.start, p.end)} — net ${f.net.toFixed(2)}`, req.companyId);
      res.json({ ok: true });
    });
  } catch (err) { next(err); }
});

// POST /api/vat/periods/:id/reopen — reopenVatPeriod (4065), admin-only, guards verbatim
vat.post('/vat/periods/:id/reopen', canVat, async (req: AuthedReq, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== 'admin') throw new ApiError(403, 'Only an administrator can reopen a VAT period.');
    await withTx(async (c) => {
      const p = await periodOr404(c, req.companyId!, req.params.id as string);
      if (p.status !== 'closed') throw new ApiError(400, 'This period is not closed.');
      if (p.submittedAt) throw new ApiError(400, 'This period has been submitted to SARS and cannot be reopened.');
      const later = (await c.query(`select 1 from vat_periods where company_id = $1 and "start" > $2 and status = 'closed'`,
        [req.companyId!, p.start])).rows.length;
      if (later) throw new ApiError(400, 'Only the latest closed VAT period can be reopened.');
      await c.query(`update vat_periods set status = 'open', closed_at = null, closed_by = null, snap = null
        where company_id = $1 and id = $2`, [req.companyId, p.id]);
      await logEv(req.user!.id, req.user!.username, 'VAT period reopened', vatLabel(p.start, p.end), req.companyId);
      res.json({ ok: true });
    });
  } catch (err) { next(err); }
});

// POST /api/vat/periods/:id/submit — submitVat (4073): records a manual SARS VAT201 submission only
vat.post('/vat/periods/:id/submit', canVat, async (req: AuthedReq, res: Response, next: NextFunction) => {
  try {
    await withTx(async (c) => {
      const p = await periodOr404(c, req.companyId!, req.params.id as string);
      if (p.status !== 'closed') throw new ApiError(400, 'Close the VAT period before submitting.');
      if (p.submittedAt) throw new ApiError(409, 'This period has already been submitted.');
      await c.query(`update vat_periods set submitted_at = $2 where company_id = $1 and id = $3`, [req.companyId, todayISO(), p.id]);
      await logEv(req.user!.id, req.user!.username, 'VAT return submitted', vatLabel(p.start, p.end), req.companyId);
      res.json({ ok: true });
    });
  } catch (err) { next(err); }
});
