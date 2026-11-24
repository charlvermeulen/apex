import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { ApiError, AuthedReq, logEv, requireAuth, requireCan } from '../middleware.js';
import { canSec as aclCanSec } from '@numera/shared';
import { checkPostingDate, nextDocRef, postJournal, r2, withTx, type Client } from '../posting.js';
import { addMonths, dayAdd, escAt, lineEndOf, monthsBetween, todayISO } from './contracts.routes.js';

export const billing = Router();
billing.use(requireAuth);

// invoice list is read from both the customers enquiry tab and cbilling history
const invEnq = (req: AuthedReq, res: Response, next: NextFunction) =>
  req.user && (aclCanSec({ role: req.user.role, overrides: req.user.overrides }, 'customers', 'enq')
    || aclCanSec({ role: req.user.role, overrides: req.user.overrides }, 'cbilling', 'enq'))
    ? next() : next(new ApiError(403, 'You do not have access to this area.'));

const perFirst = (per: string) => per + '-01';
const perLast = (per: string) => dayAdd(addMonths(per + '-01', 1), -1);
const canMod = (mod: 'contracts' | 'cbilling') => requireCan(mod, 'maint');
const canEnq = (mod: 'contracts' | 'cbilling') => requireCan(mod, 'enq');

// ── periods ──

billing.get('/billing/periods', canEnq('cbilling'), async (req: AuthedReq, res, next) => {
  try {
    res.json((await q(
      `select p.id, p.status, p.closed_at as "closedAt", p.closed_by as "closedBy",
              (select count(*)::int from contract_invoices b where b.company_id = p.company_id and b.invoice_date >= (p.id || '-01')::date and b.invoice_date < (p.id || '-01')::date + interval '1 month') as inv,
              (select count(*)::int from meter_readings r where r.company_id = p.company_id and r.period = p.id and r.billed) as mb
         from billing_periods p where p.company_id = $1 order by p.id desc`, [req.companyId])).rows);
  } catch (e) { next(e); }
});

billing.post('/billing/periods', canMod('cbilling'), async (req: AuthedReq, res, next) => {
  try {
    const id = String(req.body?.id || '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(id)) throw new ApiError(400, 'Choose a month.');
    await withTx(async (c) => {
      const dup = (await c.query('select 1 from billing_periods where company_id = $1 and id = $2', [req.companyId, id])).rows.length;
      if (dup) throw new ApiError(409, id + ' already exists.');
      const l = (await c.query(`select max(id) as l from billing_periods where company_id = $1`, [req.companyId])).rows[0].l as string | null;
      if (l && id !== addMonths(l + '-01', 1).slice(0, 7))
        throw new ApiError(400, `The next period must be ${addMonths(l + '-01', 1).slice(0, 7)}, straight after ${l}.`);
      const chk = await checkPostingDate(c, req.companyId!, perLast(id));
      if (chk) throw new ApiError(400, chk);
      await c.query(`insert into billing_periods (company_id, id, status) values ($1,$2,'open')`, [req.companyId, id]);
      await logEv(req.user!.id, req.user!.username, 'Billing period opened', id, req.companyId);
      res.status(201).json({ ok: true });
    });
  } catch (e) { next(e); }
});

// meters with captured, unbilled readings (or none) — the blockers for closing (legacy 3627)
const periodBlockers = async (c: Client, companyId: string, per: string): Promise<string[]> => {
  const act = (await c.query(
    `select c.code as con, m.asset_code as asset, m.mtype as type, r.end_reading, r.billed
       from contracts c
       join contract_meters m on m.company_id = c.company_id and m.contract_code = c.code
       left join meter_readings r on r.company_id = c.company_id and r.contract_code = c.code and r.meter_no = m.meter_no and r.period = $2
      where c.company_id = $1 and c.status = 'Active'`, [companyId, per])).rows as any[];
  const b: string[] = [];
  for (const r of act) {
    if (r.end_reading == null) b.push(`${r.con} ${r.asset} ${r.type}: no closing reading`);
    else if (!r.billed) b.push(`${r.con} ${r.asset} ${r.type}: reading not billed`);
  }
  return b;
};

billing.post('/billing/periods/:id/close', canMod('cbilling'), async (req: AuthedReq, res, next) => {
  try {
    await withTx(async (c) => {
      const p = (await c.query(`select id, status from billing_periods where company_id = $1 and id = $2`, [req.companyId, req.params.id])).rows[0];
      if (!p || p.status !== 'open') throw new ApiError(404, 'Period not found.');
      const earlier = (await c.query(`select id from billing_periods where company_id = $1 and id < $2 and status = 'open'`, [req.companyId, p.id])).rows as any[];
      if (earlier.length) throw new ApiError(400, `Close ${earlier.map((x) => x.id).sort()[0]} first. Periods close oldest first.`);
      const bl = await periodBlockers(c, req.companyId!, p.id);
      if (bl.length) throw new ApiError(400, `Period ${p.id} cannot be closed yet:\n\n• ` + bl.join('\n• '));
      await c.query(`update billing_periods set status = 'closed', closed_at = $3, closed_by = $4 where company_id = $1 and id = $2`,
        [req.companyId, p.id, todayISO(), req.user!.username]);
      await logEv(req.user!.id, req.user!.username, 'Billing period closed', p.id, req.companyId);
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});

billing.post('/billing/periods/:id/reopen', requireAuth, async (req: AuthedReq, res, next) => {
  try {
    if (req.user!.role !== 'admin') throw new ApiError(403, 'Only an administrator can reopen a period.');
    await withTx(async (c) => {
      const p = (await c.query(`select id, status from billing_periods where company_id = $1 and id = $2`, [req.companyId, req.params.id])).rows[0];
      if (!p || p.status !== 'closed') throw new ApiError(404, 'Period not found.');
      const later = (await c.query(
        `select p.id from billing_periods p where p.company_id = $1 and p.id > $2
           and (p.status = 'closed'
             or exists (select 1 from meter_readings r where r.company_id = p.company_id and r.period = p.id and r.billed)
             or exists (select 1 from contract_invoices b where b.company_id = p.company_id and b.invoice_date >= (p.id || '-01')::date and b.invoice_date < (p.id || '-01')::date + interval '1 month'))`,
        [req.companyId, p.id])).rows;
      if (later.length) throw new ApiError(400, 'Only the latest closed period can be reopened, and only while later periods have nothing billed.');
      await c.query(`update billing_periods set status = 'open', closed_at = null, closed_by = null where company_id = $1 and id = $2`, [req.companyId, p.id]);
      await logEv(req.user!.id, req.user!.username, 'Billing period reopened', p.id, req.companyId);
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});

// ── meters & readings ──

// meterOpening (3606): latest closed period's closing, else the meter's start reading
const meterOpening = async (c: Client, companyId: string, code: string, meterNo: number, per: string, start: number): Promise<number> => {
  const prev = (await c.query(
    `select r.end_reading from meter_readings r
       join billing_periods p on p.company_id = r.company_id and p.id = r.period and p.status = 'closed'
      where r.company_id = $1 and r.contract_code = $2 and r.meter_no = $3 and r.period < $4 and r.end_reading is not null
      order by r.period`, [companyId, code, meterNo, per])).rows;
  return prev.length ? Number(prev[prev.length - 1].end_reading) : start;
};

// meterUsage (3610): opening/ending/pages/amount for a period (uses saved reading when present)
const meterUsage = async (c: Client, companyId: string, code: string, m: any, per: string) => {
  const rd = (await c.query(
    `select end_reading as "end", billed, rate::float, start_read from meter_readings
      where company_id = $1 and contract_code = $2 and meter_no = $3 and period = $4`,
    [companyId, code, m.id, per])).rows[0];
  const op = rd && rd.billed ? Number(rd.start_read) : await meterOpening(c, companyId, code, m.id, per, m.start);
  if (!rd || rd.end == null) return { op, end: null, pages: 0, amt: 0, rate: escAt({ esc_base: m.escBase, esc_history: m.eh }, perFirst(per), m.rate), rd };
  const rate = rd.billed ? rd.rate : escAt({ esc_base: m.escBase, esc_history: m.eh }, perFirst(per), m.rate);
  const pages = Number(rd.end) - op;
  return { op, end: Number(rd.end), pages, amt: r2(pages * rate), rate, rd };
};

billing.get('/billing/meters', canEnq('cbilling'), async (req: AuthedReq, res, next) => {
  try {
    const per = String(req.query.per || '');
    const rows = (await q(
      `select c.code as con, c.cust_code as cust, cu.name as "custName", m.meter_no as id, m.asset_code as asset, m.mtype as type,
              m.start_reading as "start", m.rate::float as rate, m.esc_base as "escBase", m.esc_history as eh
         from contracts c
         join contract_meters m on m.company_id = c.company_id and m.contract_code = c.code
         join customers cu on cu.company_id = c.company_id and cu.code = c.cust_code
        where c.company_id = $1 and c.status = 'Active'
        order by c.code, m.meter_no`, [req.companyId])).rows as any[];
    const out = await withTx(async (c) => {
      const res2: any[] = [];
      for (const m of rows) {
        const u = await meterUsage(c, req.companyId!, m.con, m, per);
        const rd: any = (await c.query(
          `select billed from meter_readings where company_id = $1 and contract_code = $2 and meter_no = $3 and period = $4`,
          [req.companyId, m.con, m.id, per])).rows[0];
        res2.push({ ...m, opening: u.op, end: u.end, pages: u.pages, amt: u.amt, rateNow: u.rate, billed: !!rd?.billed });
      }
      return res2;
    });
    res.json(out);
  } catch (e) { next(e); }
});

const rdSchema = z.object({
  per: z.string().regex(/^\d{4}-[0-1][0-9]$/),
  readings: z.array(z.object({ contract: z.string(), meter: z.number(), end: z.number().nullable() })),
});

billing.post('/billing/readings', canMod('cbilling'), async (req: AuthedReq, res, next) => {
  try {
    const p = rdSchema.parse(req.body);
    await withTx(async (c) => {
      const per = (await c.query('select id, status from billing_periods where company_id = $1 and id = $2', [req.companyId, p.per])).rows[0];
      if (!per || per.status !== 'open') throw new ApiError(400, `Period ${p.per} is not open.`);
      for (const r of p.readings) {
        const k = `${r.contract}/M${r.meter}`;
        const m = (await c.query(
          `select m.start_reading as start, m.esc_base as "escBase", m.esc_history as eh
             from contract_meters m join contracts c on c.company_id = m.company_id and c.code = m.contract_code
            where m.company_id = $1 and m.contract_code = $2 and m.meter_no = $3 and c.status = 'Active'`,
          [req.companyId, r.contract, r.meter])).rows[0];
        if (!m) continue;
        if (r.end != null) {
          if (!Number.isInteger(r.end) || r.end < 0) throw new ApiError(400, `${k}: the closing reading must be a whole number.`);
          const op = await meterOpening(c, req.companyId!, r.contract, r.meter, p.per, m.start);
          if (r.end < op) throw new ApiError(400, `${k}: closing reading ${r.end} is lower than the opening reading ${op}.`);
        }
        const old = (await c.query(
          `select billed from meter_readings where company_id = $1 and contract_code = $2 and meter_no = $3 and period = $4`,
          [req.companyId, r.contract, r.meter, p.per])).rows[0];
        if (old?.billed) continue;
        if (r.end == null) { if (old) await c.query('delete from meter_readings where company_id = $1 and contract_code = $2 and meter_no = $3 and period = $4', [req.companyId, r.contract, r.meter, p.per]); }
        else if (old) await c.query('update meter_readings set end_reading = $5 where company_id = $1 and contract_code = $2 and meter_no = $3 and period = $4', [req.companyId, r.contract, r.meter, p.per, r.end]);
        else await c.query(
          `insert into meter_readings (company_id, contract_code, meter_no, period, end_reading, billed) values ($1,$2,$3,$4,$5,false)`,
          [req.companyId, r.contract, r.meter, p.per, r.end]);
      }
      await logEv(req.user!.id, req.user!.username, 'Meter readings saved',
        `${p.per} — ${p.readings.filter((r) => r.end != null).length} readings`, req.companyId);
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});

// ── due list (dueList 3543) & run (runBilling 3563) ──

const dueList = async (c: Client, companyId: string, asAt: string) => {
  const per = asAt.slice(0, 7);
  const perRow = (await c.query('select id, status from billing_periods where company_id = $1 and id = $2', [companyId, per])).rows[0];
  const pOpen = !!perRow && perRow.status === 'open';
  const cons = (await c.query(
    `select c.code, c.cust_code as cust, c.status, c.esc::float as esc, c.freq, cu.name as "custName",
            coalesce((select json_agg(json_build_object('id', l.line_no, 'type', l.ctype, 'asset', coalesce(l.asset_code,''), 'descr', coalesce(l.descr,''),
                      'amt', l.amt::float, 'term', l.term, 'start', l.start_date, 'lastBilled', l.last_billed,
                      'ever', t.ever, 'rev', t.rev, 'cos', t.cos, 'escBase', l.esc_base::float, 'eh', l.esc_history))
                      from contract_lines l join contract_types t on t.company_id = l.company_id and t.name = l.ctype
                     where l.company_id = c.company_id and l.contract_code = c.code), '[]') as lines,
            coalesce((select json_agg(json_build_object('id', m.meter_no, 'asset', m.asset_code, 'type', m.mtype, 'rate', m.rate::float,
                      'start', m.start_reading, 'escBase', m.esc_base, 'eh', m.esc_history, 'rev', mt.rev, 'cos', mt.cos))
                      from contract_meters m join meter_types mt on mt.company_id = m.company_id and mt.name = m.mtype
                     where m.company_id = c.company_id and m.contract_code = c.code), '[]') as meters
       from contracts c join customers cu on cu.company_id = c.company_id and cu.code = c.cust_code
      where c.company_id = $1`, [companyId])).rows as any[];
  const rows: any[] = [];
  for (const cn of cons) {
    const ends = cn.lines.map((l: any) => lineEndOf({ ever: l.ever, start_date: l.start, term: l.term }));
    const ce = ends.some((e: string) => !e) ? '' : ends.reduce((a: string, b: string) => (b > a ? b : a), '');
    if (cn.status === 'Active' && ce && ce < todayISO()) cn.status = 'Expired';
    if (cn.status !== 'Active') continue;
    const items: any[] = [];
    for (const l of cn.lines) {
      const f = l.lastBilled ? dayAdd(l.lastBilled, 1) : l.start;
      const le = lineEndOf({ ever: l.ever, start_date: l.start, term: l.term });
      if (le && f > le) continue;
      let to = dayAdd(addMonths(f, cn.freq), -1);
      if (le && to > le) to = le;
      if (f > asAt) continue; // period not started by the selected date (legacy 3546)
      const yrs = Math.max(0, Math.floor(monthsBetween(l.start, f.slice(0, 7)) / 12));
      const amt = r2(escAt({ esc_base: l.escBase, esc_history: l.eh }, f, l.amt) * Math.pow(1 + (cn.esc || 0) / 100, yrs) * cn.freq);
      items.push({ line: l, from: f, to, ex: amt });
    }
    const mitems: any[] = [];
    if (pOpen) {
      for (const m of cn.meters) {
        const u = await meterUsage(c, companyId, cn.code, { id: m.id, start: m.start, rate: m.rate, escBase: m.escBase, eh: m.eh }, per);
        if (u.end == null || (u.rd && u.rd.billed)) continue;
        mitems.push({ meter: m, u });
      }
    }
    if (!items.length && !mitems.length) continue;
    const ex = r2(items.reduce((t, i) => t + i.ex, 0) + mitems.reduce((t, i) => t + i.u.amt, 0));
    const vat = r2(ex * 0.15);
    rows.push({ con: { code: cn.code, cust: cn.cust, custName: cn.custName }, items, mitems, ex, vat, tot: r2(ex + vat) });
  }
  return rows;
};

billing.get('/billing/due', canMod('cbilling'), async (req: AuthedReq, res, next) => {
  try {
    const asAt = String(req.query.date || todayISO());
    const rows = await withTx((c) => dueList(c, req.companyId!, asAt));
    res.json(rows);
  } catch (e) { next(e); }
});

const runSchema = z.object({
  date: z.string(),
  contracts: z.array(z.string()).min(1),
});

billing.post('/billing/run', canMod('cbilling'), async (req: AuthedReq, res, next) => {
  try {
    const p = runSchema.parse(req.body);
    await withTx(async (c) => {
      const chk = await checkPostingDate(c, req.companyId!, p.date);
      if (chk) throw new ApiError(400, chk);
      const per = p.date.slice(0, 7);
      const perRow = (await c.query('select id, status from billing_periods where company_id = $1 and id = $2', [req.companyId, per])).rows[0];
      if (!perRow) throw new ApiError(400, `Period ${per} has not been opened. Open it under Billing Periods first.`);
      if (perRow.status !== 'open') throw new ApiError(400, `Period ${per} is closed. Choose a date in an open period.`);
      const rows = (await dueList(c, req.companyId!, p.date)).filter((r) => p.contracts.includes(r.con.code));
      let n = 0, tot = 0;
      const made: any[] = [];
      for (const r of rows) {
        const no = await nextDocRef(c, req.companyId!, 'contract_invoices', 'CINV', 1, 'id', 5);
        const lines: { kind: 'item' | 'meter'; ctype: string; descr: string; asset: string; from: string; to: string; ex: number; rev: string; cos: string | null }[] = [];
        const itemLines = r.items.map((i: any) => ({
          kind: 'item' as const, ctype: i.line.type, descr: i.line.descr || '', asset: i.line.asset || '',
          from: i.from, to: i.to, ex: i.ex, rev: i.line.rev, cos: i.line.cos ?? null,
        }));
        const meterLines = r.mitems.map((i: any) => ({
          kind: 'meter' as const, ctype: 'Meter Usage',
          descr: `${i.meter.type} meter: ${i.u.pages.toLocaleString('en-ZA')} pages @ R ${i.u.rate.toFixed(4)} (${i.u.op} → ${i.u.end})`,
          asset: i.meter.asset, from: perFirst(per), to: perLast(per), ex: i.u.amt,
          rev: i.meter.rev, cos: i.meter.cos ?? null,
        }));
        lines.push(...itemLines, ...meterLines);
        const fyId = (await c.query('select id from financial_years where company_id = $1 and start <= $2 and end_date >= $3', [req.companyId, p.date, p.date])).rows[0]?.id ?? null;
        await c.query(
          `insert into contract_invoices (company_id, id, fy_id, invoice_date, contract_code, customer_code, excl, vat, total)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [req.companyId, no, fyId, p.date, r.con.code, r.con.cust, r.ex, r.vat, r.tot]);
        let seq = 0;
        for (const l of lines) {
          seq++;
          await c.query(
            `insert into contract_invoice_lines (company_id, invoice_id, seq, kind, ctype, descr, asset_code, from_d, to_d, excl, rev, cos)
             values ($1,$2,$3,$4,$5,$6,nullif($7,''),$8,$9,$10,$11,$12)`,
            [req.companyId, no, seq, l.kind, l.ctype, l.descr || null, l.asset, l.from, l.to, l.ex, l.rev, l.cos]);
        }
        // journal (glJournalBase): dr AR total; cr per-line revenue + VAT output
        const jLines: { acc: string; dr: number; cr: number; desc?: string }[] = [];
        for (const l of lines) jLines.push({ acc: l.rev, dr: 0, cr: l.ex, desc: l.descr || l.ctype });
        if (r.vat) jLines.push({ acc: '9100', dr: 0, cr: r.vat });
        jLines.push({ acc: '6100', dr: r.tot, cr: 0 });
        const jid = await postJournal(c, {
          companyId: req.companyId!, fyId, date: p.date, ref: no,
          src: 'Contract Invoice', srcType: 'contract_invoice', srcId: no, desc: r.con.custName, userId: req.user!.id,
          lines: jLines,
        });
        await c.query(
          `insert into party_ledger (company_id, party_type, party_code, entry_date, ref, doc_type, description, debit, credit, journal_id)
           values ($1,'cust',$2,$3,$4,'Contract Invoice',$5,$6,0,$7)`,
          [req.companyId, r.con.cust, p.date, no,
            `Contract Invoice — ${r.con.code} (${[...new Set(lines.map((l) => l.ctype))].join(', ')})`, r.tot, jid]);
        for (const i of r.items)
          await c.query('update contract_lines set last_billed = $3 where company_id = $1 and contract_code = $2 and line_no = $4',
            [req.companyId, r.con.code, i.to, i.line.id]);
        for (const i of r.mitems) {
          await c.query(
            `update meter_readings set billed = true, invoice_id = $4, start_read = $5, rate = $6, pages = $7, amt = $8
              where company_id = $1 and contract_code = $2 and meter_no = $3 and period = $9`,
            [req.companyId, r.con.code, i.meter.id, no, i.u.op, i.u.rate, i.u.pages, i.u.amt, per]);
        }
        n++; tot += r.tot;
        made.push({ no, con: r.con.code, cust: r.con.cust, custName: r.con.custName, ex: r.ex, vat: r.vat, tot: r.tot, date: p.date, lineCount: lines.length });
      }
      await logEv(req.user!.id, req.user!.username, 'Contract billing run',
        `${n} invoices, ${'R ' + tot.toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`, req.companyId);
      res.status(201).json({ made, n, tot: r2(tot) });
    });
  } catch (e) { next(e); }
});

// ── invoice list/detail (Billing History + customer Contract Invoices tab) ──

billing.get('/billing/invoices', invEnq, async (req: AuthedReq, res, next) => {
  try {
    const cust = req.query.cust ? String(req.query.cust) : '';
    res.json((await q(
      `select b.id, b.invoice_date as "date", b.contract_code as con, b.customer_code as cust, c.name as "custName",
              b.excl::float as ex, b.vat::float, b.total::float as tot,
              coalesce((select json_agg(json_build_object('type', il.ctype, 'descr', coalesce(il.descr,''), 'asset', coalesce(il.asset_code,''),
                        'from', il.from_d, 'to', il.to_d, 'ex', il.excl::float) order by il.seq)
                        from contract_invoice_lines il where il.company_id = b.company_id and il.invoice_id = b.id), '[]') as lines
         from contract_invoices b join customers c on c.company_id = b.company_id and c.code = b.customer_code
        where b.company_id = $1 and ($2 = '' or b.customer_code = $2)
        order by b.invoice_date desc, b.id desc`, [req.companyId, cust])).rows);
  } catch (e) { next(e); }
});

billing.get('/billing/invoices/:id', invEnq, async (req: AuthedReq, res, next) => {
  try {
    const inv = (await q(
      `select b.id, b.invoice_date as "date", b.contract_code as con, b.customer_code as cust, c.name as "custName",
              b.excl::float as ex, b.vat::float, b.total::float as tot,
              c.street, c.suburb, c.city, c.postal_code, c.vat_no,
              coalesce((select json_agg(json_build_object('kind', il.kind, 'type', il.ctype, 'descr', coalesce(il.descr,''),
                        'asset', coalesce(il.asset_code,''), 'from', il.from_d, 'to', il.to_d, 'ex', il.excl::float) order by il.seq), '[]') as lines
         from contract_invoices b join customers c on c.company_id = b.company_id and c.code = b.customer_code
        where b.company_id = $1 and b.id = $2`, [req.companyId, req.params.id])).rows[0];
    if (!inv) throw new ApiError(404, 'Invoice not found.');
    res.json(inv);
  } catch (e) { next(e); }
});
