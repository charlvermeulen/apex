import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { ApiError, AuthedReq, logEv, requireAuth, requireCan } from '../middleware.js';

export const misc = Router();
misc.use(requireAuth);

// activity log — canSec settings:log. Failed sign-ins show with '—' (no user).
misc.get('/activity-log', requireCan('settings', 'log'), async (req: AuthedReq, res, next) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 300));
    const p: (string | number)[] = [];
    let where = '';
    if (req.companyId && req.query.mine === '1') { where = 'company_id = $1'; p.push(req.companyId); }
    const rows = (await q(`select a.id, a.at, a.username, a.action, a.detail, c.name as company
      from activity_log a left join companies c on c.id = a.company_id
      ${where ? 'where ' + where : ''} order by a.at desc limit ${limit}`, p)).rows;
    res.json(rows);
  } catch (e) { next(e); }
});

// GL summary seam — trial balance from opening balances ± materialized journal lines
misc.get('/gl/summary', async (req: AuthedReq, res, next) => {
  try {
    const rows = (await q(`
      select a.code, a.name, a.type, a.vat_rate,
             a.opening_balance
               + coalesce((select sum(l.debit - l.credit) from journal_lines l join journals j on j.id = l.journal_id
                           where l.company_id = a.company_id and l.account_code = a.code and j.status = 'Posted'), 0) as balance
        from accounts a where a.company_id = $1 and a.active order by a.code`, [req.companyId])).rows;
    res.json(rows);
  } catch (e) { next(e); }
});
