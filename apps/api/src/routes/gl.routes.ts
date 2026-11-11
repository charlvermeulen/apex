import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { ApiError, AuthedReq, logEv, requireAuth, requireCan } from '../middleware.js';
import { checkPostingDate, nextDocRef, r2, withTx } from '../posting.js';

export const gl = Router();
gl.use(requireAuth);

const lineSchema = z.object({
  acc: z.string().regex(/^\d{4}$/),
  nar: z.string().trim().max(200).optional().default(''),
  dr: z.number().optional().default(0),
  cr: z.number().optional().default(0),
});

// ── New Journal Entry (legacy postJnl 2018–2024) ──

gl.post('/journals', requireCan('gl', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const p = z.object({ date: z.string(), desc: z.string().trim().min(1).max(200), lines: z.array(lineSchema).min(2) }).parse(req.body);
    await withTx(async (c) => {
      const dr = r2(p.lines.reduce((s, l) => s + l.dr, 0));
      const cr = r2(p.lines.reduce((s, l) => s + l.cr, 0));
      if (p.lines.some((l) => (l.dr > 0 && l.cr > 0))) throw new ApiError(400, 'Each line needs an account and either a debit or a credit.');
      const pe = await checkPostingDate(c, req.companyId!, p.date);
      if (pe) throw new ApiError(400, pe);
      if (!(dr > 0) || Math.abs(dr - cr) >= 0.005) throw new ApiError(400, 'Cannot post: debits must equal credits and be greater than zero.');
      for (const l of p.lines) {
        const a = (await c.query('select 1 as x from accounts where company_id = $1 and code = $2', [req.companyId, l.acc])).rows.length;
        if (!a) throw new ApiError(400, `Unknown account "${l.acc}".`);
      }
      const ref = await nextDocRef(c, req.companyId!, 'journals', `JNL-${p.date.slice(0, 4)}`, 90, 'ref');
      const fyId = (await c.query('select id from financial_years where company_id = $1 and start <= $2 and end_date >= $3', [req.companyId, p.date, p.date])).rows[0]?.id ?? null;
      const jr = await c.query(
        `insert into journals (company_id, fy_id, journal_date, ref, src, src_type, src_id, description, posted_by, status)
         values ($1,$2,$3,$4,'Journal','manual','',$5,$6,'Posted') returning id`,
        [req.companyId, fyId, p.date, ref, p.desc, req.user!.id],
      );
      let seq = 0;
      for (const l of p.lines.filter((l) => l.dr > 0 || l.cr > 0)) {
        seq++;
        await c.query('insert into journal_lines (journal_id, company_id, seq, account_code, description, debit, credit) values ($1,$2,$3,$4,$5,$6,$7)',
          [jr.rows[0].id, req.companyId, seq, l.acc, l.nar || null, r2(l.dr), r2(l.cr)]);
      }
      await logEv(req.user!.id, req.user!.username, 'Journal posted', `${ref} · ${p.desc}`, req.companyId);
      res.status(201).json({ ref });
    });
  } catch (e) { next(e); }
});

// ── Journal Batches (legacy saveBatch 2267–2284 with Open/Posted, persisted) ──

gl.post('/batches', requireCan('gl', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const p = z.object({
      date: z.string(),
      desc: z.string().trim(),
      status: z.enum(['Posted', 'Open']),
      lines: z.array(lineSchema).min(1),
    }).parse(req.body);
    await withTx(async (c) => {
      // saveBatch verbatim checks
      if (!p.desc) throw new ApiError(400, 'Enter a batch description.');
      const L = p.lines.filter((l) => l.dr > 0 || l.cr > 0);
      if (!L.length) throw new ApiError(400, 'Add at least one line with an amount.');
      if (L.some((l) => !l.acc || (l.dr > 0 && l.cr > 0))) throw new ApiError(400, 'Each line needs an account and either a debit or a credit.');
      const dr = r2(L.reduce((s, l) => s + l.dr, 0));
      const cr = r2(L.reduce((s, l) => s + l.cr, 0));
      const balanced = Math.abs(dr - cr) < 0.005;
      if (p.status === 'Posted' && !balanced) throw new ApiError(400, 'Cannot post: debits must equal credits. Save as Open to keep working on it.');
      if (p.status === 'Posted') {
        const pe = await checkPostingDate(c, req.companyId!, p.date);
        if (pe) throw new ApiError(400, pe);
      }
      for (const l of L) {
        const a = (await c.query('select 1 as x from accounts where company_id = $1 and code = $2', [req.companyId, l.acc])).rows.length;
        if (!a) throw new ApiError(400, `Unknown account "${l.acc}".`);
      }
      const ref = await nextDocRef(c, req.companyId!, 'journals', `GJB-${p.date.slice(0, 4)}`, 1, 'ref');
      const fyId = (await c.query('select id from financial_years where company_id = $1 and start <= $2 and end_date >= $3', [req.companyId, p.date, p.date])).rows[0]?.id ?? null;
      const jr = await c.query(
        `insert into journals (company_id, fy_id, journal_date, ref, src, src_type, src_id, description, posted_by, status)
         values ($1,$2,$3,$4,'Journal Batch','batch','',$5,$6,$7) returning id`,
        [req.companyId, fyId, p.date, ref, p.desc, req.user!.id, p.status],
      );
      let seq = 0;
      for (const l of L) {
        seq++;
        await c.query('insert into journal_lines (journal_id, company_id, seq, account_code, description, debit, credit) values ($1,$2,$3,$4,$5,$6,$7)',
          [jr.rows[0].id, req.companyId, seq, l.acc, l.nar || null, r2(l.dr), r2(l.cr)]);
      }
      await logEv(req.user!.id, req.user!.username, p.status === 'Posted' ? 'Journal batch posted' : 'Journal batch saved open', `${ref} · ${p.desc}`, req.companyId);
      res.status(201).json({ ref, id: jr.rows[0].id, balanced });
    });
  } catch (e) { next(e); }
});

// batch list
gl.get('/batches', requireCan('gl', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    res.json((await q(
      `select j.id, j.ref, j.journal_date as date, j.description, j.status,
              (select count(*)::int from journal_lines l where l.journal_id = j.id) as lines,
              (select sum(l.debit)::float from journal_lines l where l.journal_id = j.id) as dr,
              (select sum(l.credit)::float from journal_lines l where l.journal_id = j.id) as cr
         from journals j where j.company_id = $1 and j.src_type = 'batch' order by j.journal_date desc, j.ref desc`, [req.companyId])).rows);
  } catch (e) { next(e); }
});

// postOpen port (2290–2295)
gl.patch('/batches/:id/post', requireCan('gl', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    await withTx(async (c) => {
      const b = (await c.query(`select id, journal_date from journals where company_id = $1 and id = $2 and src_type = 'batch'`, [req.companyId, req.params.id])).rows[0];
      if (!b) throw new ApiError(404, 'Batch not found.');
      const agg = (await c.query(`select sum(debit)::float as dr, sum(credit)::float as cr from journal_lines where journal_id = $1`, [b.id])).rows[0];
      if (Math.abs(Number(agg.dr) - Number(agg.cr)) >= 0.005) throw new ApiError(400, 'Cannot post: this batch is out of balance.');
      const pe = await checkPostingDate(c, req.companyId!, b.journal_date);
      if (pe) throw new ApiError(400, pe);
      const cur = (await c.query('select status from journals where id = $1', [b.id])).rows[0].status;
      if (cur === 'Open') {
        await c.query('update journals set status = \'Posted\' where id = $1', [b.id]);
        await logEv(req.user!.id, req.user!.username, 'Journal batch posted', String(b.journal_date), req.companyId);
      }
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});

// ── General Journal listing (legacy gl-jnl) ──

gl.get('/journals', requireCan('gl', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    const js = (await q(
      `select j.id, j.journal_date as date, j.ref, j.description, j.src, u.username as by
         from journals j left join users u on u.id = j.posted_by
        where j.company_id = $1 and j.status = 'Posted' order by j.journal_date desc, j.ref desc limit 300`, [req.companyId])).rows;
    const out = [];
    for (const j of js) {
      const lines = (await q(
        `select l.account_code as acc, a.name as acc_name, l.description, l.debit::float as dr, l.credit::float as cr
           from journal_lines l join accounts a on a.company_id = l.company_id and a.code = l.account_code
          where l.journal_id = $1 order by l.seq`, [j.id])).rows;
      out.push({ ...j, lines });
    }
    res.json(out);
  } catch (e) { next(e); }
});

// ── Account Enquiry (ENQ.gl per account — glEnqSync 5581 + renderEnq 1974–1989) ──

gl.get('/accounts/:code/ledger', requireCan('gl', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    const acc = (await q(
      `select code, name, type, opening_balance::float as open from accounts where company_id = $1 and code = $2`, [req.companyId, req.params.code])).rows[0];
    if (!acc) throw new ApiError(404, 'No accounts yet.');
    // dr side: assets/expenses (glEnqSync 5588)
    const gi = Number(acc.code[0]);
    const sec = ['Income', 'Expenses', 'Income', 'Expenses', 'Assets', 'Assets', 'Equity', 'Liabilities', 'Liabilities'][gi - 1];
    const dr = /asset|expense|cost/i.test(sec);
    let open = dr ? Number(acc.open) : -Number(acc.open);
    const moves = (await q(
      `select j.journal_date as date, j.ref, j.src, j.description, l.debit::float as dr, l.credit::float as cr
         from journal_lines l join journals j on j.id = l.journal_id
        where l.company_id = $1 and l.account_code = $2 and j.status = 'Posted'`,
      [req.companyId, req.params.code])).rows as any[];
    const from = String(req.query.from || ''), to = String(req.query.to || '');
    moves.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    let bal = open;
    if (from) moves.forEach((m) => { if (m.date < from) bal += dr ? m.dr - m.cr : m.cr - m.dr; });
    const opening = r2(bal);
    const rows = [] as any[];
    moves.forEach((m) => {
      if ((from && m.date < from) || (to && m.date > to)) return;
      bal += dr ? m.dr - m.cr : m.cr - m.dr;
      rows.push({ date: m.date, ref: m.ref, desc: m.src + ' — ' + (m.description || ''), dr: m.dr, cr: m.cr, bal: r2(bal) });
    });
    res.json({ code: acc.code, name: acc.name, open: r2(open), side: dr ? 'dr' : 'cr', opening, rows, closing: r2(bal) });
  } catch (e) { next(e); }
});

// journal enquiry — flat lines listing (legacy filterJ)
gl.get('/journal-lines', requireCan('gl', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    const from = String(req.query.from || ''), to = String(req.query.to || '');
    res.json((await q(
      `select j.journal_date as date, j.ref, j.src, j.description, l.account_code as acc, a.name as acc_name,
              l.description as nar, l.debit::float as dr, l.credit::float as cr
         from journal_lines l join journals j on j.id = l.journal_id join accounts a on a.company_id = l.company_id and a.code = l.account_code
        where l.company_id = $1 and j.status = 'Posted'
          and ($2 = '' or j.journal_date >= $2::date) and ($3 = '' or j.journal_date <= $3::date)
        order by j.journal_date desc, j.ref desc, l.seq`, [req.companyId, from, to])).rows);
  } catch (e) { next(e); }
});

// accounts list for enquiry/journal selects
gl.get('/accounts', requireCan('gl', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    res.json((await q(
      `select a.code, a.name, a.type, a.vat_rate as vat, a.opening_balance::float as open, a.active,
              coalesce((select sum(l.debit - l.credit) from journal_lines l join journals j on j.id = l.journal_id
                where l.company_id = a.company_id and l.account_code = a.code and j.status = 'Posted'), 0)::float as balance
         from accounts a where a.company_id = $1 order by a.code`, [req.companyId])).rows);
  } catch (e) { next(e); }
});
