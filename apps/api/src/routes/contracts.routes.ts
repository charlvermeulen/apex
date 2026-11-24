import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { ApiError, AuthedReq, logEv, requireAuth, requireCan } from '../middleware.js';
import { nextDocRef, r2, withTx, fmtD, type Client } from '../posting.js';

export const contracts = Router();
contracts.use(requireAuth);

const todayISO = () => new Date().toISOString().slice(0, 10);
const dayAdd = (iso: string, n: number) => {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};
const addMonths = (iso: string, n: number) => {
  const d = new Date(iso + 'T00:00:00Z'); const day = d.getUTCDate(); d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last)); return d.toISOString().slice(0, 10);
};
// monthsBetween (3227) — from a date to a YYYY-MM month
const monthsBetween = (fromISO: string, toMonth: string) => {
  const [y1, m1] = fromISO.slice(0, 7).split('-').map(Number), [y2, m2] = toMonth.slice(0, 7).split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
};
// escAt (5718): last escalation value with from <= d, else base/cur
const escAt = (it: { esc_base: number | null; esc_history: { from: string; v: number }[] }, d: string, cur: number): number => {
  if (!it.esc_history || !it.esc_history.length) return cur;
  let r = it.esc_base != null ? it.esc_base : cur;
  it.esc_history.slice().sort((a, b) => (a.from < b.from ? -1 : 1)).forEach((e) => { if (e.from <= d) r = e.v; });
  return r;
};
// lineEnd (3426): evergreen ⇒ '' else start+term−1d; conStatus (3447); lineActive (3446)
const lineEndOf = (l: { ever: boolean; start_date: string; term: number }) =>
  l.ever ? '' : dayAdd(addMonths(l.start_date, l.term), -1);
const lineActive = (l: { ever: boolean; start_date: string; term: number }) => { const e = lineEndOf(l); return !e || e >= todayISO(); };

export { lineEndOf, lineActive, escAt, monthsBetween, addMonths, dayAdd, todayISO };

// ── Contract types (Item Fees) + meter types (settings:ctypes; reads for contract users) ──

const ctSchema = z.object({
  name: z.string(),
  asset: z.enum(['required', 'optional']),
  funder: z.boolean(),
  ever: z.boolean(),
  rev: z.string(),
  cos: z.string(),
});
const mtSchema = z.object({
  name: z.string(),
  descr: z.string().trim().max(100).optional().default(''),
  rev: z.string(),
  cos: z.string(),
});

// glOk (4371): rev must be Income+active, cos Expenses+active
const glCheck = async (c: Client, companyId: string, rev: string, cos: string): Promise<string> => {
  const rv = (await c.query(
    `select 1 from accounts where company_id = $1 and code = $2 and active and type in ('Income','Other Income')`, [companyId, rev])).rows.length;
  if (!rv) return 'Choose a GL revenue account.';
  const cs = (await c.query(
    `select 1 from accounts where company_id = $1 and code = $2 and active and type in ('Expense','Cost of Sales')`, [companyId, cos])).rows.length;
  if (!cs) return 'Choose a GL cost of sales account.';
  return '';
};

const ctRead = requireCan('contracts', 'maint');
const ctWrite = requireCan('settings', 'ctypes');

contracts.get('/ctypes', ctRead, async (req: AuthedReq, res, next) => {
  try {
    const rows = (await q(
      `select t.name, t.asset_req as asset, t.funder, t.ever, t.rev, t.cos, t.active,
              (select count(*)::int from contract_lines l where l.company_id = t.company_id and l.ctype = t.name) as uses
         from contract_types t where t.company_id = $1 order by t.name`, [req.companyId])).rows;
    res.json(rows);
  } catch (e) { next(e); }
});

contracts.get('/mtypes', ctRead, async (req: AuthedReq, res, next) => {
  try {
    const rows = (await q(
      `select t.name, t.descr, t.rev, t.cos, t.active,
              (select count(*)::int from contract_meters m where m.company_id = t.company_id and m.mtype = t.name) as uses
         from meter_types t where t.company_id = $1 order by t.name`, [req.companyId])).rows;
    res.json(rows);
  } catch (e) { next(e); }
});

contracts.post('/ctypes', ctWrite, async (req: AuthedReq, res, next) => {
  try {
    const o = ctSchema.parse(req.body);
    await withTx(async (c) => {
      const g = await glCheck(c, req.companyId!, o.rev, o.cos); if (g) throw new ApiError(400, g);
      if (o.name.length < 2 || o.name.length > 40) throw new ApiError(400, 'The name must be 2 to 40 characters.');
      if (o.name === 'Meter Usage') throw new ApiError(400, '"Meter Usage" is reserved for meter charges.');
      const dup = (await c.query(`select 1 from contract_types where company_id = $1 and lower(btrim(name)) = lower(btrim($2))`, [req.companyId, o.name])).rows.length;
      if (dup) throw new ApiError(409, `A type called "${o.name}" already exists.`);
      const n = (await c.query('select count(*)::int as n from contract_types where company_id = $1', [req.companyId])).rows[0].n;
      if (n >= 30) throw new ApiError(400, 'The maximum is 30 types.');
      await c.query(
        `insert into contract_types (company_id, name, asset_req, funder, ever, rev, cos, active) values ($1,$2,$3,$4,$5,$6,$7,true)`,
        [req.companyId, o.name, o.asset, o.funder, o.ever, o.rev, o.cos]);
      await logEv(req.user!.id, req.user!.username, 'Contract type added', o.name, req.companyId);
      res.status(201).json({ ok: true });
    });
  } catch (e) { next(e); }
});

// legacy 3399: a used type can only change its GL accounts
contracts.patch('/ctypes/:name', ctWrite, async (req: AuthedReq, res, next) => {
  try {
    const o = ctSchema.parse(req.body);
    await withTx(async (c) => {
      const t = (await c.query('select name, rev, cos from contract_types where company_id = $1 and lower(btrim(name)) = lower(btrim($2))', [req.companyId, req.params.name])).rows[0];
      if (!t) throw new ApiError(404, 'Type not found.');
      const g = await glCheck(c, req.companyId!, o.rev, o.cos); if (g) throw new ApiError(400, g);
      const uses = (await c.query('select count(*)::int as n from contract_lines where company_id = $1 and ctype = $2', [req.companyId, t.name])).rows[0].n;
      if (uses) {
        if (o.rev === t.rev && o.cos === t.cos) { res.json({ ok: true }); return; }
        await c.query('update contract_types set rev = $3, cos = $4 where company_id = $1 and name = $2', [req.companyId, t.name, o.rev, o.cos]);
        await logEv(req.user!.id, req.user!.username, 'Contract type GL accounts updated', `${t.name} → ${o.rev} / ${o.cos}`, req.companyId);
        res.json({ ok: true }); return;
      }
      if (o.name.length < 2 || o.name.length > 40) throw new ApiError(400, 'The name must be 2 to 40 characters.');
      if (o.name === 'Meter Usage') throw new ApiError(400, '"Meter Usage" is reserved for meter charges.');
      const dup = (await c.query(`select 1 from contract_types where company_id = $1 and lower(btrim(name)) = lower(btrim($2)) and name <> $3`, [req.companyId, o.name, t.name])).rows.length;
      if (dup) throw new ApiError(409, `A type called "${o.name}" already exists.`);
      await c.query(`update contract_types set name = $3, asset_req = $4, funder = $5, ever = $6, rev = $7, cos = $8 where company_id = $1 and name = $2`,
        [req.companyId, t.name, o.name, o.asset, o.funder, o.ever, o.rev, o.cos]);
      await logEv(req.user!.id, req.user!.username, 'Contract type updated', o.name, req.companyId);
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});

contracts.post('/ctypes/:name/toggle', ctWrite, async (req: AuthedReq, res, next) => {
  try {
    await withTx(async (c) => {
      const t = (await c.query('select name, active, rev, cos from contract_types where company_id = $1 and name = $2', [req.companyId, req.params.name])).rows[0];
      if (!t) throw new ApiError(404, 'Type not found.');
      if (t.active) {
        const others = (await c.query(`select count(*)::int as n from contract_types where company_id = $1 and active and name <> $2`, [req.companyId, t.name])).rows[0].n;
        if (others < 1) throw new ApiError(400, 'At least one type must stay active.');
      }
      await c.query(`update contract_types set active = not active where company_id = $1 and name = $2`, [req.companyId, t.name]);
      await logEv(req.user!.id, req.user!.username, `Contract type ${!t.active ? 'activated' : 'deactivated'}`, t.name, req.companyId);
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});

contracts.delete('/ctypes/:name', ctWrite, async (req: AuthedReq, res, next) => {
  try {
    await withTx(async (c) => {
      const t = (await c.query('select name, active from contract_types where company_id = $1 and name = $2', [req.companyId, req.params.name])).rows[0];
      if (!t) throw new ApiError(404, 'Type not found.');
      const uses = (await c.query('select count(*)::int as n from contract_lines where company_id = $1 and ctype = $2', [req.companyId, t.name])).rows[0].n;
      if (uses) throw new ApiError(400, `"${t.name}" is used on a contract and cannot be deleted. Deactivate it instead.`);
      const others = (await c.query(`select count(*)::int as n from contract_types where company_id = $1 and active and name <> $2`, [req.companyId, t.name])).rows[0].n;
      if (others < 1) throw new ApiError(400, 'At least one type must stay active.');
      await c.query('delete from contract_types where company_id = $1 and name = $2', [req.companyId, t.name]);
      await logEv(req.user!.id, req.user!.username, 'Contract type deleted', t.name, req.companyId);
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});

contracts.post('/mtypes', ctWrite, async (req: AuthedReq, res, next) => {
  try {
    const o = mtSchema.parse(req.body);
    await withTx(async (c) => {
      const g = await glCheck(c, req.companyId!, o.rev, o.cos); if (g) throw new ApiError(400, g);
      if (o.name.length < 2 || o.name.length > 30) throw new ApiError(400, 'The name must be 2 to 30 characters.');
      const dup = (await c.query(`select 1 from meter_types where company_id = $1 and lower(btrim(name)) = lower(btrim($2))`, [req.companyId, o.name])).rows.length;
      if (dup) throw new ApiError(400, `A meter type called "${o.name}" already exists.`);
      const n = (await c.query('select count(*)::int as n from meter_types where company_id = $1', [req.companyId])).rows[0].n;
      if (n >= 30) throw new ApiError(400, 'The maximum is 30 meter types.');
      await c.query(`insert into meter_types (company_id, name, descr, rev, cos, active) values ($1,$2,$3,$4,$5,true)`,
        [req.companyId, o.name, o.descr || null, o.rev, o.cos]);
      await logEv(req.user!.id, req.user!.username, 'Meter type added', o.name, req.companyId);
      res.status(201).json({ ok: true });
    });
  } catch (e) { next(e); }
});

contracts.patch('/mtypes/:name', ctWrite, async (req: AuthedReq, res, next) => {
  try {
    const o = mtSchema.parse(req.body);
    await withTx(async (c) => {
      const t = (await c.query('select name, rev, cos from meter_types where company_id = $1 and lower(btrim(name)) = lower(btrim($2))', [req.companyId, req.params.name])).rows[0];
      if (!t) throw new ApiError(404, 'Meter type not found.');
      const g = await glCheck(c, req.companyId!, o.rev, o.cos); if (g) throw new ApiError(400, g);
      if (o.name.length < 2 || o.name.length > 30) throw new ApiError(400, 'The name must be 2 to 30 characters.');
      const dup = (await c.query(`select 1 from meter_types where company_id = $1 and lower(btrim(name)) = lower(btrim($2)) and name <> $3`, [req.companyId, o.name, t.name])).rows.length;
      if (dup) throw new ApiError(400, `A meter type called "${o.name}" already exists.`);
      // legacy 3365: renaming cascades to placed meters (invoices already raised keep their snapshot)
      await c.query(`update meter_types set name = $3, descr = $4, rev = $5, cos = $6 where company_id = $1 and name = $2`,
        [req.companyId, t.name, o.name, o.descr || null, o.rev, o.cos]);
      if (t.name !== o.name) await c.query(`update contract_meters set mtype = $3 where company_id = $1 and mtype = $2`, [req.companyId, t.name, o.name]);
      await logEv(req.user!.id, req.user!.username, 'Meter type updated', t.name === o.name ? o.name : `${t.name} → ${o.name}`, req.companyId);
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});

contracts.post('/mtypes/:name/toggle', ctWrite, async (req: AuthedReq, res, next) => {
  try {
    await withTx(async (c) => {
      const t = (await c.query('select name, active from meter_types where company_id = $1 and name = $2', [req.companyId, req.params.name])).rows[0];
      if (!t) throw new ApiError(404, 'Meter type not found.');
      if (t.active) {
        const others = (await c.query(`select count(*)::int as n from meter_types where company_id = $1 and active and name <> $2`, [req.companyId, t.name])).rows[0].n;
        if (others < 1) throw new ApiError(400, 'At least one meter type must stay active.');
      }
      await c.query(`update meter_types set active = not active where company_id = $1 and name = $2`, [req.companyId, t.name]);
      await logEv(req.user!.id, req.user!.username, `Meter type ${!t.active ? 'activated' : 'deactivated'}`, t.name, req.companyId);
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});

contracts.delete('/mtypes/:name', ctWrite, async (req: AuthedReq, res, next) => {
  try {
    await withTx(async (c) => {
      const t = (await c.query('select name from meter_types where company_id = $1 and name = $2', [req.companyId, req.params.name])).rows[0];
      if (!t) throw new ApiError(404, 'Meter type not found.');
      const uses = (await c.query('select count(*)::int as n from contract_meters where company_id = $1 and mtype = $2', [req.companyId, t.name])).rows[0].n;
      if (uses) throw new ApiError(400, `"${t.name}" is used on a meter and cannot be deleted. Deactivate it instead.`);
      const others = (await c.query(`select count(*)::int as n from meter_types where company_id = $1 and active and name <> $2`, [req.companyId, t.name])).rows[0].n;
      if (others < 1) throw new ApiError(400, 'At least one meter type must stay active.');
      await c.query('delete from meter_types where company_id = $1 and name = $2', [req.companyId, t.name]);
      await logEv(req.user!.id, req.user!.username, 'Meter type deleted', t.name, req.companyId);
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});

// ── Contracts ──

type ConLine = { id: number; type: string; asset: string; descr: string; amt: number; term: number; start: string; funder: string; lastBilled?: string };
const conSchema = z.object({
  cust: z.string().trim(),
  ref: z.string().trim().max(60).optional().default(''),
  status: z.enum(['Active', 'Draft', 'Suspended', 'Cancelled']),
  start: z.string(),
  freq: z.number().int(),
  esc: z.number(),
  mgr: z.string().trim().optional().default(''),
  sales: z.string().trim().optional().default(''),
  lines: z.array(z.object({
    id: z.number(),
    type: z.string(),
    asset: z.string().optional().default(''),
    descr: z.string().optional().default(''),
    amt: z.number(),
    term: z.number().int(),
    start: z.string(),
    funder: z.string().optional().default(''),
    lastBilled: z.string().optional().default(''),
  })).min(1),
  meters: z.array(z.object({
    id: z.number(),
    asset: z.string(),
    type: z.string(),
    rate: z.number(),
    start: z.number(),
  })).default([]),
});

const loadFull = async (c: Client, companyId: string, code: string) => {
  const h = (await c.query(
    `select c.code, c.ref, c.status, c.start_date as start, c.freq, c.esc::float, c.mgr_code as mgr, c.sales_code as sales,
            cm.name as "mgrName", sm.name as "salesName", cust.name as "custName"
       from contracts c
       join customers cust on cust.company_id = c.company_id and cust.code = c.cust_code
       left join employees cm on cm.company_id = c.company_id and cm.code = c.mgr_code
       left join employees sm on sm.company_id = c.company_id and sm.code = c.sales_code
      where c.company_id = $1 and c.code = $2`, [companyId, code])).rows[0];
  if (!h) return null;
  const lines = (await c.query(
    `select l.line_no as id, l.ctype as type, coalesce(l.asset_code, '') as asset, coalesce(l.descr, '') as descr,
            l.amt::float as amt, l.term, l.start_date as start, coalesce(l.funder, '') as funder,
            l.last_billed as lastBilled, coalesce(l.esc_base::float, null) as "escBase", l.esc_history as "escHistory",
            t.ever, t.asset_req, t.funder as needsFunder
       from contract_lines l join contract_types t on t.company_id = l.company_id and t.name = l.ctype
      where l.company_id = $1 and l.contract_code = $2 order by l.line_no`, [companyId, code])).rows;
  const meters = (await c.query(
    `select m.meter_no as id, m.asset_code as asset, m.mtype as type, m.rate::float as rate, m.start_reading as start,
            coalesce(m.esc_base::float, null) as "escBase", m.esc_history as "escHistory",
            (select count(*)::int from meter_readings r where r.company_id = m.company_id and r.contract_code = m.contract_code and r.meter_no = m.meter_no) as "hasReadings"
       from contract_meters m where m.company_id = $1 and m.contract_code = $2 order by m.meter_no`, [companyId, code])).rows;
  return { ...h, lines, meters };
};

// validateContract (3493) — verbatim strings, in order
const validateContract = (c: Client) => async (companyId: string, o: z.infer<typeof conSchema>, editCode: string | null, ctypes: any[]): Promise<string> => {
  if (!o.cust) return 'Select the customer.';
  if (!o.start) return 'Enter the contract start date.';
  if (!(o.esc >= 0) || o.esc > 50) return 'Escalation must be between 0 and 50%.';
  if (!o.lines.length) return 'Add at least one billable item.';
  const base = editCode ? await loadFull(c, companyId, editCode) : null;
  const seen = new Set<string>();
  for (let i = 0; i < o.lines.length; i++) {
    const l = o.lines[i], n = `Item ${i + 1}: `;
    const t = ctypes.find((x: any) => x.name === l.type);
    if (!t) return `${n}choose a type.`;
    const keepType = base ? base.lines.some((x: any) => x.id === l.id && x.type === l.type) : false;
    if (!t.active && !keepType) return `${n}"${l.type}" is inactive. Choose an active type.`;
    if (!(l.amt > 0)) return `${n}enter an amount greater than zero.`;
    if (!Number.isInteger(l.term) || l.term < 1 || l.term > 120) return `${n}term must be 1 to 120 months.`;
    if (!l.start) return `${n}enter the start date.`;
    if (l.start < o.start) return `${n}cannot start before the contract starts.`;
    if (t.asset_req === 'required' && !l.asset) return `${n}${l.type} needs an asset.`;
    if (t.funder && !l.funder) return `${n}enter the funder / bank for ${l.type}.`;
    if (l.asset) { if (seen.has(l.asset)) return `${n}asset ${l.asset} is used twice on this contract.`; seen.add(l.asset); }
  }
  return '';
};

// validateMeters (3680) — verbatim strings
const validateMeters = (c: Client) => async (companyId: string, o: z.infer<typeof conSchema>, editCode: string | null, mtypes: any[]): Promise<string> => {
  const keys = new Set<string>();
  for (let i = 0; i < o.meters.length; i++) {
    const m = o.meters[i], n = `Meter ${i + 1}: `;
    if (!m.asset) return `${n}choose a printing machine (it must be on one of this contract's items).`;
    const a = (await c.query('select cat from assets where company_id = $1 and code = $2', [companyId, m.asset])).rows[0];
    if (!a || a.cat !== 'Printing Machines') return `${n}meters can only be added to Printing Machines assets.`;
    if (!o.lines.some((l) => l.asset === m.asset)) return `${n}${m.asset} is not on this contract.`;
    const mt = mtypes.find((x: any) => x.name === m.type);
    if (!mt) return `${n}choose a meter type.`;
    const keepType = editCode ? (await loadFull(c, companyId, editCode))?.meters.some((x: any) => x.id === m.id && x.type === m.type) : false;
    if (!mt.active && !keepType) return `${n}"${m.type}" is inactive. Choose an active meter type.`;
    if (!(m.rate > 0) || Math.round(m.rate * 10000) / 10000 !== m.rate) return `${n}enter a rate per page greater than zero (up to 4 decimals).`;
    if (!Number.isInteger(m.start) || m.start < 0) return `${n}the start reading must be a whole number, zero or more.`;
    const k = m.asset + '|' + m.type; if (keys.has(k)) return `${n}${m.asset} already has a ${m.type} meter.`; keys.add(k);
  }
  return '';
};

// validateStaff (4871)
const validateStaff = (c: Client) => async (companyId: string, o: z.infer<typeof conSchema>, baseMgr: string, baseSales: string): Promise<string> => {
  const chk = async (id: string, role: 'is_mgr' | 'is_sales', lab: string, old: string): Promise<string> => {
    if (!id) return '';
    const e = (await c.query(
      `select name, active, ${role} as fits from employees where company_id = $1 and code = $2`, [companyId, id])).rows[0];
    if (!e) return `Choose the ${lab} from the list.`;
    if (!e.fits) return `${e.name} is not set up as a ${lab}.`;
    if (!e.active && id !== old) return `${e.name} is inactive. Choose an active employee.`;
    return '';
  };
  return (await chk(o.mgr, 'is_mgr', 'Contract Manager', baseMgr)) || (await chk(o.sales, 'is_sales', 'Sales Person', baseSales));
};

// employee options for the contract form (fillEmpSel 4867): managers, sales people, active first
contracts.get('/staff', requireCan('contracts', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    res.json((await q(
      `select code, name, is_mgr as mgr, is_sales as sales, active from employees
        where company_id = $1 and (is_mgr or is_sales) order by active desc, name`, [req.companyId])).rows);
  } catch (e) { next(e); }
});

contracts.get('/contracts', requireCan('contracts', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    const rows = (await q(
      `select c.code, c.ref, c.status, c.start_date as start, c.freq, c.esc::float, c.mgr_code as mgr, c.sales_code as sales,
              cust.name as "custName", cm.name as "mgrName", sm.name as "salesName",
              coalesce((select json_agg(json_build_object('id', l.line_no, 'type', l.ctype, 'asset', coalesce(l.asset_code,''),
                        'descr', coalesce(l.descr,''), 'amt', l.amt::float, 'term', l.term, 'start', l.start_date,
                        'funder', coalesce(l.funder,''), 'lastBilled', l.last_billed, 'ever', t.ever, 'active', t.active, 'eh', l.esc_history))
                        from contract_lines l join contract_types t on t.company_id = l.company_id and t.name = l.ctype
                       where l.company_id = c.company_id and l.contract_code = c.code), '[]') as lines,
              coalesce((select json_agg(json_build_object('id', m.meter_no, 'asset', m.asset_code, 'type', m.mtype,
                        'rate', m.rate::float, 'start', m.start_reading, 'eh', m.esc_history))
                        from contract_meters m
                       where m.company_id = c.company_id and m.contract_code = c.code), '[]') as meters
         from contracts c
         join customers cust on cust.company_id = c.company_id and cust.code = c.cust_code
         left join employees cm on cm.company_id = c.company_id and cm.code = c.mgr_code
         left join employees sm on sm.company_id = c.company_id and sm.code = c.sales_code
        where c.company_id = $1 order by c.code`, [req.companyId])).rows as any[];
    const t = todayISO();
    for (const c of rows) {
      const ends = c.lines.map((l: any) => (l.ever ? '' : dayAdd(addMonths(l.start, l.term), -1)));
      const ce = ends.some((e: string) => !e) ? '' : ends.reduce((m: string, e: string) => (e > m ? e : m), '');
      c.end = ce;
      c.stat = c.status !== 'Active' ? c.status : (ce && ce < t ? 'Expired' : 'Active');
      c.lines.forEach((l: any) => { l.endRaw = l.ever ? '' : dayAdd(addMonths(l.start, l.term), -1); });
    }
    res.json(rows);
  } catch (e) { next(e); }
});

contracts.get('/contracts/:code', requireCan('contracts', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    const full = await withTx((c) => loadFull(c, req.companyId!, String(req.params.code)));
    if (!full) throw new ApiError(404, 'Contract not found.');
    res.json(full);
  } catch (e) { next(e); }
});

// live line on this asset by another contract (assetOptions 3468 / conActive check)
const assetOther = async (c: Client, companyId: string, editCode: string | null, asset: string): Promise<string> =>
  (await c.query(
    `select c.code from contract_lines cl
       join contracts c on c.company_id = cl.company_id and c.code = cl.contract_code and c.status not in ('Cancelled','Expired')
       join contract_types t on t.company_id = cl.company_id and t.name = cl.ctype
      where cl.company_id = $1 and cl.asset_code = $2 and ($3::text is null or c.code <> $3)
        and (t.ever or (cl.start_date + make_interval(months => cl.term) - interval '1 day')::date >= current_date) limit 1`,
    [companyId, asset, editCode])).rows[0]?.code ?? '';

contracts.post('/contracts', requireCan('contracts', 'maint'), async (req: AuthedReq, res, next) => {
  try {
    const o = conSchema.parse(req.body);
    await withTx(async (c) => {
      const cust = (await c.query('select code, name from customers where company_id = $1 and code = $2', [req.companyId, o.cust])).rows[0];
      if (!cust) throw new ApiError(400, 'Select the customer.');
      const ctypes = (await c.query('select name, active, asset_req, funder from contract_types where company_id = $1', [req.companyId])).rows;
      const mtypes = (await c.query('select name, active from meter_types where company_id = $1', [req.companyId])).rows;
      let e = await validateContract(c)(req.companyId!, o, null, ctypes) || await validateMeters(c)(req.companyId!, o, null, mtypes) || await validateStaff(c)(req.companyId!, o, '', '');
      if (e) throw new ApiError(400, e);
      for (const l of o.lines) {
        if (!l.asset) continue;
        const a = (await c.query('select code, status, cust_code from assets where company_id = $1 and code = $2', [req.companyId, l.asset])).rows[0];
        if (!a || a.status !== 'Active' || a.cust_code !== cust.code)
          throw new ApiError(400, `Asset ${l.asset} is not an active asset linked to ${cust.name}.`);
        const other = await assetOther(c, req.companyId!, null, l.asset);
        if (other) throw new ApiError(400, `Asset ${l.asset} is already on ${other}.`);
      }
      const code = await nextDocRef(c, req.companyId!, 'contracts', 'CON', 1, 'code', 4);
      // parent row first: contract_lines/contract_meters FK onto contracts
      await c.query(
        `insert into contracts (company_id, code, cust_code, ref, status, start_date, freq, esc, mgr_code, sales_code)
         values ($1,$2,$3,nullif($4,''),$5,$6,$7,$8,nullif($9,''),nullif($10,''))`,
        [req.companyId, code, cust.code, o.ref, o.status, o.start, o.freq, o.esc, o.mgr, o.sales]);
      let seq = 0;
      for (const l of o.lines) { seq++; await c.query(
        `insert into contract_lines (company_id, contract_code, line_no, ctype, asset_code, descr, amt, term, start_date, funder)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [req.companyId, code, seq, l.type, l.asset || null, l.descr || null, l.amt, l.term, l.start, l.funder || null]); }
      let ms = 0;
      for (const m of o.meters) { ms++; await c.query(
        `insert into contract_meters (company_id, contract_code, meter_no, asset_code, mtype, rate, start_reading)
         values ($1,$2,$3,$4,$5,$6,$7)`, [req.companyId, code, ms, m.asset, m.type, m.rate, m.start]); }
      await logEv(req.user!.id, req.user!.username, 'Contract added', `${code} ${cust.name}`, req.companyId);
      res.status(201).json({ code });
    });
  } catch (e) { next(e); }
});

contracts.patch('/contracts/:code', requireCan('contracts', 'maint'), async (req: AuthedReq, res, next) => {
  try {
    const o = conSchema.parse(req.body);
    await withTx(async (c) => {
      const base = await loadFull(c, req.companyId!, String(req.params.code));
      if (!base) throw new ApiError(404, 'Contract not found.');
      const ctypes = (await c.query('select name, active, asset_req, funder from contract_types where company_id = $1', [req.companyId])).rows;
      const mtypes = (await c.query('select name, active from meter_types where company_id = $1', [req.companyId])).rows;
      const e = await validateContract(c)(req.companyId!, o, base.code, ctypes)
        || await validateMeters(c)(req.companyId!, o, base.code, mtypes)
        || await validateStaff(c)(req.companyId!, o, base.mgr || '', base.sales || '');
      if (e) throw new ApiError(400, e);
      for (const l of o.lines) {
        if (!l.asset) continue;
        const a = (await c.query('select code, status, cust_code from assets where company_id = $1 and code = $2', [req.companyId, l.asset])).rows[0];
        const custName = (await c.query('select name from customers where company_id = $1 and code = $2', [req.companyId, o.cust])).rows[0]?.name ?? o.cust;
        if (!a || a.status !== 'Active' || a.cust_code !== o.cust)
          throw new ApiError(400, `Asset ${l.asset} is not an active asset linked to ${custName}.`);
        const other = await assetOther(c, req.companyId!, base.code, l.asset);
        if (other) throw new ApiError(400, `Asset ${l.asset} is already on ${other}.`);
      }
      // legacy 3529: metered machines with readings must stay on the contract
      const lost = (base.meters as any[]).filter((m) => m.hasReadings && !o.meters.some((x) => x.id === m.id));
      if (lost.length) throw new ApiError(400, `Meter ${lost[0].type} on ${lost[0].asset} has readings and cannot be removed.`);
      // billed rows keep their saved identity: customer/start/freq locked with any billed line (legacy 3515–3517),
      // billed lines keep type/amount/term/start/asset (3484), metered machines with readings keep machine/type/start (3535)
      const billed = (base.lines as any[]).some((l) => l.lastBilled);
      if (billed && (o.cust !== base.cust || o.start !== base.start || o.freq !== base.freq))
        throw new ApiError(400, 'Customer, contract start and billing frequency are locked — this contract has billed items.');
      const cust = billed ? base.cust : o.cust;
      const start = billed ? base.start : o.start;
      const freq = billed ? base.freq : o.freq;
      // ids for new rows
      let seq = Math.max(0, ...(base.lines as any[]).map((l) => l.id));
      let ms = Math.max(0, ...(base.meters as any[]).map((m) => m.id));
      // apply lines — legacy 3533: escalation history follows an unchanged amount
      for (const l of o.lines) {
        const old = (base.lines as any[]).find((x) => x.id === l.id);
        if (old && old.lastBilled) continue; // locked row — keep as saved
        if (old) {
          const keepEsc = old.amt === l.amt;
          await c.query(
            `update contract_lines set ctype = $3, asset_code = nullif($4,''), descr = nullif($5,''), amt = $6, term = $7,
                    start_date = $8, funder = nullif($9,''), esc_history = $10::jsonb, esc_base = $11
              where company_id = $1 and contract_code = $2 and line_no = $12`,
            [req.companyId, base.code, l.type, l.asset, l.descr, l.amt, l.term, l.start, l.funder,
              JSON.stringify(keepEsc ? (old.escHistory || []) : []), keepEsc ? old.escBase : null, old.id]);
        } else {
          seq++;
          await c.query(
            `insert into contract_lines (company_id, contract_code, line_no, ctype, asset_code, descr, amt, term, start_date, funder)
             values ($1,$2,$3,$4,nullif($5,''),nullif($6,''),$7,$8,$9,nullif($10,''))`,
            [req.companyId, base.code, seq, l.type, l.asset, l.descr, l.amt, l.term, l.start, l.funder]);
        }
      }
      // removed meters go (readings-bearing removals were rejected above)
      await c.query('delete from contract_meters where company_id = $1 and contract_code = $2 and meter_no <> all($3::int[])',
        [req.companyId, base.code, o.meters.length ? o.meters.map((m) => m.id) : [0]]);
      for (const m of o.meters) {
        const old = (base.meters as any[]).find((x) => x.id === m.id);
        const use = old && old.hasReadings ? { asset: old.asset, type: old.type, start: old.start } : { asset: m.asset, type: m.type, start: m.start };
        if (old) {
          const keepEsc = old.rate === m.rate;
          await c.query(
            `update contract_meters set asset_code = $3, mtype = $4, rate = $5, start_reading = $6, esc_history = $7::jsonb, esc_base = $8
              where company_id = $1 and contract_code = $2 and meter_no = $9`,
            [req.companyId, base.code, use.asset, use.type, m.rate, use.start,
              JSON.stringify(keepEsc ? (old.escHistory || []) : []), keepEsc ? old.escBase : null, old.id]);
        } else {
          ms++;
          await c.query(
            `insert into contract_meters (company_id, contract_code, meter_no, asset_code, mtype, rate, start_reading)
             values ($1,$2,$3,$4,$5,$6,$7)`, [req.companyId, base.code, ms, m.asset, m.type, m.rate, m.start]);
        }
      }
      await c.query(
        `update contracts set cust_code = $3, ref = nullif($4,''), status = $5, start_date = $6, freq = $7, esc = $8,
                mgr_code = nullif($9,''), sales_code = nullif($10,'') where company_id = $1 and code = $2`,
        [req.companyId, base.code, cust, o.ref, o.status, start, freq, o.esc, o.mgr, o.sales]);
      await logEv(req.user!.id, req.user!.username, 'Contract updated', base.code, req.companyId);
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});

contracts.post('/contracts/:code/status', requireCan('contracts', 'maint'), async (req: AuthedReq, res, next) => {
  try {
    const p = z.object({ status: z.enum(['Active', 'Draft', 'Suspended', 'Cancelled']) }).parse(req.body);
    await withTx(async (c) => {
      const r = (await c.query('select code from contracts where company_id = $1 and code = $2', [req.companyId, req.params.code])).rows[0];
      if (!r) throw new ApiError(404, 'Contract not found.');
      await c.query('update contracts set status = $3 where company_id = $1 and code = $2', [req.companyId, r.code, p.status]);
      await logEv(req.user!.id, req.user!.username, `Contract ${p.status.toLowerCase()}`, r.code, req.companyId);
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});

// ── Escalations (5717–5756; due-list maths lives in billing.routes) ──

const escSchema = z.object({
  mode: z.enum(['pct', 'amt']),
  val: z.number(),
  eff: z.string(),
  items: z.array(z.object({ con: z.string(), kind: z.enum(['line', 'meter']), id: z.number() })).min(1),
});

contracts.post('/escalations', requireCan('contracts', 'maint'), async (req: AuthedReq, res, next) => {
  try {
    const p = escSchema.parse(req.body);
    await withTx(async (c) => {
      if (!(p.val > 0)) throw new ApiError(400, 'Enter the increase — it must be greater than zero.');
      if (p.mode === 'pct' && p.val > 100) throw new ApiError(400, 'A percentage increase cannot exceed 100%.');
      if (!p.eff) throw new ApiError(400, 'Enter the date the escalation takes effect.');
      const items: any[] = [];
      for (const x of p.items) {
        const con = (await c.query('select code, cust_code from contracts where company_id = $1 and code = $2', [req.companyId, x.con])).rows[0];
        if (!con) throw new ApiError(400, 'Select at least one contract item or meter to escalate.');
        if (x.kind === 'line') {
          const l = (await c.query(
            `select l.line_no as id, l.ctype as type, coalesce(l.descr,'') as descr, l.amt::float as amt, l.esc_base::float as base,
                    l.esc_history as eh, t.ever,
                    case when t.ever then null else (l.start_date + make_interval(months => l.term) - interval '1 day')::date end as le
               from contract_lines l join contract_types t on t.company_id = l.company_id and t.name = l.ctype
              where l.company_id = $1 and l.contract_code = $2 and l.line_no = $3`, [req.companyId, x.con, x.id])).rows[0];
          if (!l) throw new ApiError(400, 'Select at least one contract item or meter to escalate.');
          const last = (l.eh || []).map((e: any) => e.from as string).sort().pop();
          if (last && p.eff <= last)
            throw new ApiError(400, `${con.code} · ${l.type}${l.descr ? ' — ' + l.descr : ''} was already escalated from ${fmtD(last)}. Choose a later effective date.`);
          const cur = escAt({ esc_base: l.base, esc_history: l.eh }, todayISO(), l.amt);
          const n = p.mode === 'pct' ? r2(cur * (1 + p.val / 100)) : r2(cur + p.val);
          await c.query(
            `update contract_lines set amt = $4, esc_history = $5::jsonb, esc_base = $6
              where company_id = $1 and contract_code = $2 and line_no = $3`,
            [req.companyId, con.code, l.id, n,
              JSON.stringify([...(l.eh || []), { from: p.eff, v: n }]), l.base != null ? l.base : cur]);
          items.push({ con: con.code, kind: 'line', id: l.id, desc: `${l.type} — ${l.descr}`, old: cur, new: n });
        } else {
          const m = (await c.query(
            `select m.meter_no as id, m.mtype as type, m.rate::float as rate, m.esc_base::float as base, m.esc_history as eh
               from contract_meters m where m.company_id = $1 and m.contract_code = $2 and m.meter_no = $3`,
            [req.companyId, x.con, x.id])).rows[0];
          if (!m) throw new ApiError(400, 'Select at least one contract item or meter to escalate.');
          const last = (m.eh || []).map((e: any) => e.from as string).sort().pop();
          if (last && p.eff <= last)
            throw new ApiError(400, `${con.code} · Meter: ${m.type} was already escalated from ${fmtD(last)}. Choose a later effective date.`);
          const cur = escAt({ esc_base: m.base, esc_history: m.eh }, todayISO(), m.rate);
          const n = Math.round((p.mode === 'pct' ? cur * (1 + p.val / 100) : cur + p.val) * 10000) / 10000;
          await c.query(
            `update contract_meters set rate = $4, esc_history = $5::jsonb, esc_base = $6
              where company_id = $1 and contract_code = $2 and meter_no = $3`,
            [req.companyId, con.code, m.id, n,
              JSON.stringify([...(m.eh || []), { from: p.eff, v: n }]), m.base != null ? m.base : cur]);
          items.push({ con: con.code, kind: 'meter', id: m.id, desc: `Meter: ${m.type}`, old: cur, new: n });
        }
      }
      const code = await nextDocRef(c, req.companyId!, 'contract_escalations', 'ESC', 1, 'code', 4);
      await c.query(
        `insert into contract_escalations (company_id, code, applied, effective, mode, val, applied_by, items)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [req.companyId, code, todayISO(), p.eff, p.mode, p.val, req.user!.username, JSON.stringify(items)]);
      await logEv(req.user!.id, req.user!.username, 'Contract escalation',
        `${code} · ${items.length} item(s) · ${p.mode === 'pct' ? p.val + '%' : 'R ' + p.val} from ${p.eff}`, req.companyId);
      res.status(201).json({ code, items });
    });
  } catch (e) { next(e); }
});

contracts.get('/escalations', requireCan('contracts', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    const rows = (await q(
      `select code, applied, effective, mode, val::float, applied_by, items
         from contract_escalations where company_id = $1 order by applied desc, code desc`, [req.companyId])).rows;
    res.json(rows);
  } catch (e) { next(e); }
});
