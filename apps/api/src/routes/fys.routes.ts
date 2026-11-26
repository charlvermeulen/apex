import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { ApiError, AuthedReq, logEv, requireAuth, requireAdmin, requireCan } from '../middleware.js';
import { postJournal, r2, withTx, type Client } from '../posting.js';

export const fys = Router();
fys.use(requireAuth);

const iso = (t: string | Date) => (typeof t === 'string' ? t : (t as Date).toISOString()).slice(0, 10);
const addDays = (t: string | Date, n: number) => {
  const [y, m, d] = iso(t).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 864e5).toISOString().slice(0, 10);
};
const daysBetween = (a: string | Date, b: string | Date) =>
  Math.round((Date.parse(iso(b)) - Date.parse(iso(a))) / 864e5);
const fmtD = (t: string | Date) => {
  const s = iso(t);
  const [y, m, d] = s.split('-');
  return `${d} ${['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m]} ${y}`;
};
const fyName = (a: string | Date, b: string | Date) => {
  const sy = iso(a).slice(0, 4), ey = iso(b).slice(0, 4);
  return sy === ey ? 'FY ' + sy : `FY ${sy}/${ey.slice(2)}`;
};

// rows are any-typed on purpose: pg rows are shapeless and every read path normalizes dates here
const withHistory = (r: any) => ({
  ...r,
  start: iso(r.start), end: iso(r.end), end_date: iso(r.end),
  history: typeof r.history === 'string' ? JSON.parse(r.history) : (r.history ?? []),
  ...r,
});

const fmtR = (n: number) => 'R ' + n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Income (groups 1000s/3000s) and expense (2000s/4000s) totals per open FY from posted journals —
// the fy.income/fy.expenses recompute deferred from batch 1. Closed FYs keep their frozen closing snapshot.
const openTotals = async (companyId: string): Promise<Record<string, { income: number; expenses: number }>> => {
  const rows = (await q(
    `select f.id as fy_id,
            coalesce(sum(case when left(l.account_code,1) in ('1','3') then l.credit - l.debit else 0 end),0)::float as income,
            coalesce(sum(case when left(l.account_code,1) in ('2','4') then l.debit - l.credit else 0 end),0)::float as expenses
       from financial_years f
       join journals j on j.company_id = f.company_id and j.status = 'Posted'
            and j.journal_date >= f.start and j.journal_date <= f.end_date
       join journal_lines l on l.journal_id = j.id
      where f.company_id = $1 and f.status = 'open' and left(l.account_code,1) < '5'
      group by f.id`, [companyId])).rows;
  const m: Record<string, { income: number; expenses: number }> = {};
  rows.forEach((r) => { m[r.fy_id] = { income: r.income, expenses: r.expenses }; });
  return m;
};

// Closing balances per IS account across the FY's posted journals (Income credit-normal, Expenses
// debit-normal). Drives the close-preview, the materialized closing journal and the frozen totals.
const closingData = async (db: typeof q, companyId: string, fy: { start: string; end_date: string }) => {
  const rows = (await db(
    `select l.account_code as code, a.name,
            sum(case when left(l.account_code,1) in ('1','3') then l.credit - l.debit else l.debit - l.credit end)::float as amt
       from journals j join journal_lines l on l.journal_id = j.id
       left join accounts a on a.company_id = l.company_id and a.code = l.account_code
      where j.company_id = $1 and j.status = 'Posted' and j.journal_date >= $2 and j.journal_date <= $3
        and left(l.account_code,1) < '5'
      group by l.account_code, a.name having sum(l.debit) <> sum(l.credit)`,
    [companyId, fy.start, fy.end_date])).rows as { code: string; name: string; amt: number }[];
  // legacy 2824: Cr the income total, Dr the expense total, net to 7010 (income accounts are
  // credit-normal so zero-ing them is a debit, and vice versa)
  const lines = rows
    .filter((r) => '13'.includes(r.code[0]) && r.amt > 0)
    .map((r) => ({ acc: r.code, name: r.name || '', dr: r.amt, cr: 0 }))
    .concat(
      rows.filter((r) => '24'.includes(r.code[0]) && r.amt > 0)
        .map((r) => ({ acc: r.code, name: r.name || '', dr: 0, cr: r.amt })),
    );
  const income = r2(rows.filter((r) => '13'.includes(r.code[0])).reduce((t, r) => t + r.amt, 0));
  const expenses = r2(rows.filter((r) => '24'.includes(r.code[0])).reduce((t, r) => t + r.amt, 0));
  const net = r2(income - expenses);
  if (net >= 0) lines.push({ acc: '7010', name: 'Retained Earnings', dr: 0, cr: net });
  else lines.push({ acc: '7010', name: 'Retained Earnings', dr: -net, cr: 0 });
  const closingRef = (name: string) => 'CLS-' + name.replace('FY ', '').replace('/', '-');
  return { lines, income, expenses, net, ref: closingRef };
};

// open-batch branch of closeChecks (legacy 2818) — batches now persist, wired for batch 7
const openBatchRefs = async (db: typeof q, companyId: string, fy: { start: string; end_date: string }) =>
  (await db(
    `select ref from journals where company_id = $1 and src_type = 'batch' and status = 'Open'
       and journal_date >= $2 and journal_date <= $3 order by ref`,
    [companyId, fy.start, fy.end_date])).rows.map((r: { ref: string }) => r.ref);

fys.get('/', async (req: AuthedReq, res, next) => {
  try {
    const rows = (await q(`select f.*, f.end_date as "end", u.username as closed_by_username
      from financial_years f left join users u on u.id = f.closed_by where f.company_id = $1 order by f.start`,
      [req.companyId])).rows.map(withHistory);
    const totals = await openTotals(req.companyId!);
    res.json(rows.map((r: any) => r.status === 'open'
      ? { ...r, income: totals[r.id]?.income ?? 0, expenses: totals[r.id]?.expenses ?? 0 }
      : r));
  } catch (e) { next(e); }
});

// validateFY port (legacy 2804–2813)
fys.post('/', requireCan('settings', 'years'), async (req: AuthedReq, res, next) => {
  try {
    const b = z.object({ name: z.string(), start: z.string(), end: z.string() }).parse(req.body);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(b.end || ''))
      throw new ApiError(400, 'Enter valid start and end dates.');
    if (b.end <= b.start) throw new ApiError(400, 'The end date must be after the start date.');
    const days = daysBetween(b.start, b.end) + 1;
    if (days < 28 || days > 550) throw new ApiError(400, 'A financial year must be between 28 days and 18 months long.');
    const name = b.name.trim();
    if (!name) throw new ApiError(400, 'Enter a name for the financial year.');
    const all = (await q('select *, end_date as "end" from financial_years where company_id = $1 order by start', [req.companyId])).rows.map(withHistory);
    if (all.some((f: { name: string }) => f.name.toLowerCase() === name.toLowerCase()))
      throw new ApiError(409, 'A financial year with that name already exists.');
    const ov = all.find((f: { start: string; end: string }) => b.start <= f.end && b.end >= f.start);
    if (ov) throw new ApiError(400, `These dates overlap ${ov.name} (${fmtD(ov.start)} – ${fmtD(ov.end)}).`);
    if (all.length) {
      const last = all[all.length - 1], first = all[0];
      if (b.start !== addDays(last.end, 1) && b.end !== addDays(first.start, -1))
        throw new ApiError(400, `Financial years must run on without gaps. The next year must start on ${fmtD(addDays(last.end, 1))}.`);
    }
    const r = withHistory((await q(`insert into financial_years (company_id, name, start, end_date) values ($1,$2,$3,$4) returning *, end_date as "end"`,
      [req.companyId, name, b.start, b.end])).rows[0]);
    await logEv(req.user!.id, req.user!.username, 'Financial year added', name, req.companyId);
    res.status(201).json(withHistory(r));
  } catch (e) { next(e); }
});

// closeChecks port (legacy 2815–2823). Open batches: refs passed in (legacy BATCH scan).
export const closeChecks = async (
  fy: { start: string; end: string; status: string; name: string },
  all: { start: string; end: string; status: string; name: string }[],
  openRefs: string[] = [],
) => {
  const c: { ok: boolean; block: boolean; text: string }[] = [];
  const earlier = all.filter((f) => f.end < fy.start && f.status !== 'closed');
  c.push({
    ok: !earlier.length, block: true,
    text: earlier.length
      ? 'Earlier year(s) still open: ' + earlier.map((f) => f.name).join(', ') + '. Close years in order, oldest first.'
      : 'All earlier financial years are closed.',
  });
  c.push({
    ok: !openRefs.length, block: true,
    text: openRefs.length
      ? `${openRefs.length} open (unposted) batch(es) dated in this year: ${openRefs.join(', ')}. Post them first.`
      : 'No open batches dated in this year.',
  });
  const today = new Date().toISOString().slice(0, 10);
  c.push({
    ok: fy.end < today, block: false,
    text: fy.end < today
      ? `The year-end date (${fmtD(fy.end)}) has passed.`
      : `The year-end date (${fmtD(fy.end)}) has not passed yet. Closing now blocks postings for the rest of the year.`,
  });
  return c;
};

// openCloseFY preview (legacy 2889–2895): checks + the closing journal lines that will be posted.
fys.get('/:id/close-preview', requireCan('settings', 'years'), async (req: AuthedReq, res, next) => {
  try {
    const all = (await q('select *, end_date as "end" from financial_years where company_id = $1 order by start', [req.companyId])).rows.map(withHistory);
    const fy = all.find((f: { id: string }) => f.id === req.params.id);
    if (!fy || fy.status !== 'open') throw new ApiError(400, 'This year is not open.');
    const refs = await openBatchRefs(q, req.companyId!, fy);
    const checks = await closeChecks(fy, all, refs);
    const cd = await closingData(q, req.companyId!, fy);
    res.json({ checks, name: fy.name, journal: cd.lines, net: cd.net, income: cd.income, expenses: cd.expenses });
  } catch (e) { next(e); }
});

fys.post('/:id/close', requireCan('settings', 'years'), async (req: AuthedReq, res, next) => {
  try {
    await withTx(async (c) => {
      const all = (await c.query('select *, end_date as "end" from financial_years where company_id = $1 order by start', [req.companyId])).rows.map(withHistory);
      const fy = all.find((f: { id: string }) => f.id === req.params.id);
      if (!fy || fy.status !== 'open') throw new ApiError(400, 'This year is not open.');
      const refs = await openBatchRefs(c.query.bind(c) as unknown as typeof q, req.companyId!, fy);
      const bad = (await closeChecks(fy, all, refs)).find((c2) => c2.block && !c2.ok);
      if (bad) throw new ApiError(400, bad.text);
      const cd = await closingData(c.query.bind(c) as unknown as typeof q, req.companyId!, fy);
      const reAcc = (await c.query('select 1 as x from accounts where company_id = $1 and code = \'7010\'', [req.companyId])).rows.length;
      if (!reAcc) throw new ApiError(400, `Closing the year needs account 7010 (Retained Earnings) on the Chart of Accounts. (journal ${cd.ref(fy.name)})`);
      // legacy closeFYCore just recorded fy.closing; a zero-activity year has no journal lines to post
      if (cd.lines.some((l) => l.dr || l.cr)) {
        await postJournal(c, {
          companyId: req.companyId!, fyId: fy.id, date: fy.end_date, ref: cd.ref(fy.name),
          src: 'Year-End Close', srcType: 'fyclose', srcId: fy.id, desc: `Year-end close ${fy.name}`, userId: req.user!.id,
          lines: cd.lines.map((l) => ({ acc: l.acc, dr: l.dr, cr: l.cr })),
        });
      }
      await c.query(
        `update financial_years set status = 'closed', closed_at = now(), closing = $3::jsonb,
            closed_by = $2, history = history || $4::jsonb where id = $1`,
        [fy.id, req.user!.id,
          JSON.stringify({ ref: cd.ref(fy.name), income: cd.income, expenses: cd.expenses, net: cd.net }),
          JSON.stringify([{ t: Date.now(), user: req.user!.username, action: 'Closed', note: `Closing journal ${cd.ref(fy.name)} · net profit ${fmtR(cd.net)}` }])],
      );
      // legacy 2838: current-year handover to the next open year after fy.end (batch-1 shipped the directions wrong)
      if (fy.is_current) {
        const nx = all.find((f: { start: string; status: string }) => f.start > fy.end && f.status === 'open');
        if (nx) {
          await c.query('update financial_years set is_current = false where id = $1', [fy.id]);
          await c.query('update financial_years set is_current = true where id = $1', [nx.id]);
        }
      }
      await logEv(req.user!.id, req.user!.username, 'Financial year closed', `${fy.name} · closing journal ${cd.ref(fy.name)}`, req.companyId);
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});

// reopenFYCore port (legacy 2841–2848): admin only, later-closed-year guard, reason ≥5 chars.
fys.post('/:id/reopen', requireAdmin, async (req: AuthedReq, res, next) => {
  try {
    const body = z.object({ reason: z.string() }).parse(req.body);
    await withTx(async (c) => {
      const all = (await c.query('select *, end_date as "end" from financial_years where company_id = $1 order by start', [req.companyId])).rows.map(withHistory);
      const fy = all.find((f: { id: string }) => f.id === req.params.id);
      if (!fy || fy.status !== 'closed') throw new ApiError(400, 'This year is not closed.');
      const later = all.find((f: { start: string; status: string }) => f.start > fy.end && f.status === 'closed');
      if (later) throw new ApiError(400, `${later.name} is closed. Reopen later years first.`);
      const reason = body.reason.trim();
      if (reason.length < 5) throw new ApiError(400, 'Enter a reason (at least 5 characters).');
      // legacy: '· closing journal <ref> reversed' — the closing journal is deleted outright
      const ref = (fy.closing as { ref?: string } | null)?.ref ?? '';
      await c.query(`delete from journal_lines where journal_id in (select id from journals where company_id = $1 and src_type = 'fyclose' and src_id = $2)`, [req.companyId, fy.id]);
      await c.query(`delete from journals where company_id = $1 and src_type = 'fyclose' and src_id = $2`, [req.companyId, fy.id]);
      await c.query(
        `update financial_years set status = 'open', closed_at = null, closed_by = null, closing = null,
            history = history || $2::jsonb where id = $1`,
        [fy.id, JSON.stringify([{ t: Date.now(), user: req.user!.username, action: 'Reopened', note: reason + (ref ? ` · closing journal ${ref} reversed` : '') }])],
      );
      await logEv(req.user!.id, req.user!.username, 'Financial year reopened', `${fy.name} — ${reason}`, req.companyId);
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});

fys.post('/:id/set-current', requireCan('settings', 'years'), async (req: AuthedReq, res, next) => {
  try {
    const fy = (await q('select * from financial_years where id = $1 and company_id = $2', [req.params.id, req.companyId])).rows[0];
    if (!fy) throw new ApiError(404, 'Financial year not found.');
    if (fy.status !== 'open') throw new ApiError(400, fy.name + ' is closed, so it cannot be the current year. Reopen it first.');
    await q('begin');
    await q('update financial_years set is_current = false where company_id = $1', [req.companyId]);
    await q('update financial_years set is_current = true where id = $1', [fy.id]);
    await q('commit');
    await logEv(req.user!.id, req.user!.username, 'Current year set', fy.name, req.companyId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// canDeleteFY port (legacy 2850): last row, open, no history, not current.
fys.delete('/:id', requireCan('settings', 'years'), async (req: AuthedReq, res, next) => {
  try {
    const all = (await q('select *, end_date as "end" from financial_years where company_id = $1 order by start', [req.companyId])).rows.map(withHistory);
    const fy = all.find((f: { id: string }) => f.id === req.params.id);
    if (!fy) throw new ApiError(404, 'Financial year not found.');
    // legacy used its stored fy.income/expenses; the rewrite derives them from journals, so compute
    const totals = await openTotals(req.companyId!);
    const t = totals[fy.id] ?? { income: 0, expenses: 0 };
    const ok = fy === all[all.length - 1] && fy.status === 'open' && JSON.stringify(fy.history) === '[]' && !fy.is_current
      && !(t.income || t.expenses);
    if (!ok) throw new ApiError(400, 'Only the most recent year — open, never closed and not current — can be deleted.');
    await q('delete from financial_years where id = $1', [fy.id]);
    await logEv(req.user!.id, req.user!.username, 'Financial year deleted', fy.name, req.companyId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
