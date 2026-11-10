import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { ApiError, AuthedReq, logEv, requireAuth, requireAdmin, requireCan } from '../middleware.js';

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

fys.get('/', async (req: AuthedReq, res, next) => {
  try {
    const rows = (await q(`select f.*, f.end_date as "end", u.username as closed_by_username
      from financial_years f left join users u on u.id = f.closed_by where f.company_id = $1 order by f.start`,
      [req.companyId])).rows;
    res.json(rows.map(withHistory));
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

// closeChecks port (legacy 2815–2823). Open-batch branch is vacuous until batch 2.
export const closeChecks = async (fy: { start: string; end: string; status: string; name: string }, companyId: string, all: { start: string; end: string; status: string; name: string }[]) => {
  const c: { ok: boolean; block: boolean; text: string }[] = [];
  const earlier = all.filter((f) => f.end < fy.start && f.status !== 'closed');
  c.push({
    ok: !earlier.length, block: true,
    text: earlier.length
      ? 'Earlier year(s) still open: ' + earlier.map((f) => f.name).join(', ') + '. Close years in order, oldest first.'
      : 'All earlier financial years are closed.',
  });
  // TODO(batch2): check for open (unposted) batches dated in this year once batches persist — legacy 2818
  c.push({ ok: true, block: true, text: 'No open batches dated in this year.' });
  const today = new Date().toISOString().slice(0, 10);
  c.push({
    ok: fy.end < today, block: false,
    text: fy.end < today
      ? `The year-end date (${fmtD(fy.end)}) has passed.`
      : `The year-end date (${fmtD(fy.end)}) has not passed yet. Closing now blocks postings for the rest of the year.`,
  });
  return c;
};

fys.post('/:id/close', requireCan('settings', 'years'), async (req: AuthedReq, res, next) => {
  try {
    const all = (await q('select *, end_date as "end" from financial_years where company_id = $1 order by start', [req.companyId])).rows.map(withHistory);
    const fy = all.find((f: { id: string }) => f.id === req.params.id);
    if (!fy || fy.status !== 'open') throw new ApiError(400, 'This year is not open.');
    const bad = (await closeChecks(fy, req.companyId!, all)).find((c) => c.block && !c.ok);
    if (bad) throw new ApiError(400, bad.text);
    // closing journal defers to the report batch (needs income/expense totals)
    await q(`update financial_years set status = 'closed', closed_at = now(),
        closed_by = $2, history = history || $3::jsonb where id = $1`,
      [fy.id, req.user!.id, JSON.stringify([{ t: Date.now(), user: req.user!.username, action: 'Closed', note: '' }])]);
    if (fy.is_current) {
      const nx = all.find((f: { start: string; status: string }) => f.start > fy.end && f.status === 'open');
      if (nx) await q('update financial_years set is_current = false where id = $1', [nx.id]);
    }
    await logEv(req.user!.id, req.user!.username, 'Financial year closed', fy.name, req.companyId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// reopenFYCore port (legacy 2841–2848): admin only, later-closed-year guard, reason ≥5 chars.
fys.post('/:id/reopen', requireAdmin, async (req: AuthedReq, res, next) => {
  try {
    const body = z.object({ reason: z.string() }).parse(req.body);
    const all = (await q('select *, end_date as "end" from financial_years where company_id = $1 order by start', [req.companyId])).rows.map(withHistory);
    const fy = all.find((f: { id: string }) => f.id === req.params.id);
    if (!fy || fy.status !== 'closed') throw new ApiError(400, 'This year is not closed.');
    const later = all.find((f: { start: string; status: string }) => f.start > fy.end && f.status === 'closed');
    if (later) throw new ApiError(400, `${later.name} is closed. Reopen later years first.`);
    const reason = body.reason.trim();
    if (reason.length < 5) throw new ApiError(400, 'Enter a reason (at least 5 characters).');
    await q(`update financial_years set status = 'open', closed_at = null, closed_by = null,
        history = history || $2::jsonb where id = $1`,
      [fy.id, JSON.stringify([{ t: Date.now(), user: req.user!.username, action: 'Reopened', note: reason }])]);
    await logEv(req.user!.id, req.user!.username, 'Financial year reopened', `${fy.name} — ${reason}`, req.companyId);
    res.json({ ok: true });
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
    const ok = fy === all[all.length - 1] && fy.status === 'open' && JSON.stringify(fy.history) === '[]' && !fy.is_current;
    if (!ok) throw new ApiError(400, 'Only the most recent year — open, never closed and not current — can be deleted.');
    await q('delete from financial_years where id = $1', [fy.id]);
    await logEv(req.user!.id, req.user!.username, 'Financial year deleted', fy.name, req.companyId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
