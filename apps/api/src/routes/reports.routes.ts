import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { ApiError, AuthedReq, logEv, requireAuth, requireCan } from '../middleware.js';
import { r2, withTx } from '../posting.js';

// Reports & Budgets module (legacy reports page). Section-less module: legacy guarded everything
// with canMod('reports') — the rewrite maps that to requireCan('reports','rep'). Finance data
// (TB/PL/BS) is served raw and shaped by the web renderer, like legacy's finModel (5599).
export const reports = Router();
reports.use(requireAuth);

const canRep = requireCan('reports', 'rep');
const r2v = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// GET /api/reports/fin?from&to — per account: opening balance, movements before `from`
// and movements inside the window. The web derives cum/plNet/adj from these three
// exactly like legacy finModel (5610).
reports.get('/fin', canRep, async (req: AuthedReq, res, next) => {
  try {
    const from = String(req.query.from || ''), to = String(req.query.to || '');
    const lines = (await q(
      `select j.journal_date as date, l.account_code as code, l.debit::float as dr, l.credit::float as cr
         from journal_lines l join journals j on j.id = l.journal_id
        where l.company_id = $1 and j.status = 'Posted'`, [req.companyId])).rows as any[];
    const accs = (await q(
      `select code, name, type, opening_balance::float as open from accounts where company_id = $1 order by code`,
      [req.companyId])).rows as any[];
    const mv = new Map<string, { bDr: number; bCr: number; dr: number; cr: number }>();
    for (const l of lines) {
      const m = mv.get(l.code) ?? { bDr: 0, bCr: 0, dr: 0, cr: 0 };
      const d = String(l.date).slice(0, 10);
      if (from && d < from) { m.bDr += l.dr; m.bCr += l.cr; }
      else if (!to || d <= to) { m.dr += l.dr; m.cr += l.cr; }
      mv.set(l.code, m);
    }
    res.json({
      maxDate: ((await q(`select max(j.journal_date)::text as d from journals j where j.company_id = $1 and j.status = 'Posted'`, [req.companyId])).rows[0]?.d ?? null),
      accounts: accs.map((a) => {
        const m = mv.get(a.code) ?? { bDr: 0, bCr: 0, dr: 0, cr: 0 };
        return { ...a, beforeDr: r2(m.bDr), beforeCr: r2(m.bCr), dr: r2(m.dr), cr: r2(m.cr) };
      }),
    });
  } catch (e) { next(e); }
});

// ── Budgets (legacy 4381–4433) ──

const budFY = async (companyId: string, fyId: string) => {
  const fys = (await q(`select id, name, start, end_date as "end", status, is_current
    from financial_years where company_id = $1 order by start`, [companyId])).rows as any[];
  const fy = fys.find((f) => f.id === fyId) || fys.find((f) => f.is_current) || fys[fys.length - 1];
  if (!fy) throw new ApiError(400, 'No financial year exists. Add one under Settings → Financial Years.');
  return fy;
};

reports.get('/budget', canRep, async (req: AuthedReq, res, next) => {
  try {
    const fy = await budFY(req.companyId!, String(req.query.fy || ''));
    const rows = (await q(`select code, months from budgets where company_id = $1 and fy_id = $2`,
      [req.companyId, fy.id])).rows as { code: string; months: any }[];
    const data: Record<string, number[]> = {};
    rows.forEach((r) => { data[r.code] = (typeof r.months === 'string' ? JSON.parse(r.months) : r.months) as number[]; });
    res.json({ fy: { id: fy.id, name: fy.name, start: fy.start, end: fy.end, status: fy.status }, data });
  } catch (e) { next(e); }
});

reports.put('/budget', canRep, async (req: AuthedReq, res, next) => {
  try {
    if (req.user!.role === 'viewer') throw new ApiError(403, 'You do not have access to this area.'); // legacy budEditable
    const p = z.object({ fy: z.string(), data: z.record(z.string(), z.array(z.number())) }).parse(req.body);
    const fy = await budFY(req.companyId!, p.fy);
    if (fy.status === 'closed') throw new ApiError(400, 'This financial year is closed.');
    // legacy 4430: every typed amount must be zero or more (and sane)
    const bad = Object.values(p.data).some((ms) => ms.some((v) => !(v >= 0) || v > 1e10));
    if (bad) throw new ApiError(400, 'Budget amounts must be zero or more.');
    await withTx(async (c) => {
      await c.query('delete from budgets where company_id = $1 and fy_id = $2', [req.companyId, fy.id]);
      for (const [code, months] of Object.entries(p.data)) {
        if (!months.some((v) => v)) continue; // legacy budRead keeps only rows with an amount
        await c.query(`insert into budgets (company_id, fy_id, code, months) values ($1,$2,$3,$4::jsonb)`,
          [req.companyId, fy.id, code, JSON.stringify(months.slice(0, 12))]);
      }
    });
    await logEv(req.user!.id, req.user!.username, 'Budget saved', fy.name, req.companyId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

reports.delete('/budget', canRep, async (req: AuthedReq, res, next) => {
  try {
    if (req.user!.role === 'viewer') throw new ApiError(403, 'You do not have access to this area.');
    const fy = await budFY(req.companyId!, String(req.query.fy || ''));
    if (fy.status === 'closed') throw new ApiError(400, 'This financial year is closed.');
    await q('delete from budgets where company_id = $1 and fy_id = $2', [req.companyId, fy.id]);
    await logEv(req.user!.id, req.user!.username, 'Budget cleared', fy.name, req.companyId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Asset Register + Depreciation Schedule data (legacy rAssets 4134 / rDep 4142).
// One query serves both: totalDep (all-time), accum-to-month and posted-in-month.
reports.get('/assets', canRep, async (req: AuthedReq, res, next) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : new Date().toISOString().slice(0, 7);
    const rows = (await q(
      `select a.code, a.atype, a.name, a.cat, a.cust_code as cust, c.name as "custName", a.purchase_date as date, a.status,
              a.cost::float, a.res::float, a.life,
              coalesce(d.amount, 0)::float as "postedAmt",
              coalesce((select sum(x.amount) from asset_depreciation x where x.company_id = a.company_id and x.asset_code = a.code), 0)::float as "doneAll",
              coalesce((select sum(x.amount) from asset_depreciation x where x.company_id = a.company_id and x.asset_code = a.code and x.month <= $3), 0)::float as "doneTo"
         from assets a
         left join customers c on c.company_id = a.company_id and c.code = a.cust_code
         left join asset_depreciation d on d.company_id = a.company_id and d.asset_code = a.code and d.month = $2
        where a.company_id = $1 order by a.code`, [req.companyId, month, month])).rows;
    res.json(rows.map((a) => ({
      ...a,
      date: a.date ? String(a.date).slice(0, 10) : '',
      monthly: r2v(a.life > 0 ? (a.cost - a.res) / a.life : 0),
    })));
  } catch (e) { next(e); }
});

// ── Stock on Hand (legacy rStk 5255): on-hand, issued-on-requests net of good returns, value.
reports.get('/stk', canRep, async (req: AuthedReq, res, next) => {
  try {
    const rows = (await q(
      `select i.sku, i.name, i.cost::float as cost,
              (i.opening_qty + coalesce((select sum(m.qty_in - m.qty_out) from stock_moves m
                  where m.company_id = i.company_id and m.sku = i.sku), 0))::float as qty,
              (coalesce((select sum(p.qty) from part_requests p
                  where p.company_id = i.company_id and p.sku = i.sku and p.status = 'Issued'), 0)
               - coalesce((select sum(r.qty) from part_returns r
                  join part_requests p2 on p2.company_id = r.company_id and p2.code = r.pr_code
                  where p2.company_id = i.company_id and p2.sku = i.sku and p2.status = 'Issued' and r.cond like 'Good%'), 0))::float as issued
         from stock_items i where i.company_id = $1 and i.active order by i.sku`, [req.companyId])).rows as any[];
    res.json(rows.map((r) => ({ ...r, qty: r2v(r.qty), issued: r2v(r.issued), value: r2v(r.qty * r.cost) })));
  } catch (e) { next(e); }
});
