import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { ApiError, AuthedReq, logEv, requireAuth, requireCan } from '../middleware.js';
import { fmtD, nextDocRef, postJournal, r2, withTx, type Client } from '../posting.js';

// ══ Service: calls, requests, work orders, WIP, SLA (legacy 3706–3792, 4455–4601) ══
export const service = Router();
service.use(requireAuth);

const todayISO = () => new Date().toISOString().slice(0, 10);
const dayAdd = (iso: string, n: number): string => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string): number => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const callOpen = (s: string): boolean => !['Completed', 'Cancelled'].includes(s); // 3713
const WO_OPEN = ['Issued', 'In progress']; // 4460
// 3783/4544: completed work flows into the asset's service history
const SVC_TYPE: Record<string, string> = { Breakdown: 'Repair', 'Routine service': 'Routine service', Installation: 'Routine service', Inspection: 'Inspection / Certification' };
const svcTypeOf = (t: string): string => SVC_TYPE[t] || 'Repair';
const WIP = '6210'; // GL_WIP 5516

const fyIdFor = async (c: Client, companyId: string, iso: string): Promise<string | null> =>
  (await c.query('select id from financial_years where company_id = $1 and start <= $2 and end_date >= $3', [companyId, iso, iso])).rows[0]?.id ?? null;

const CALL_SELECT = `
  select s.code, s.cust_code as cust, c.name as "custName", s.asset_code as asset, a.name as "assetName",
         s.type, s.pri, s.descr, s.status, s.tech_code as tech, t.name as "techName",
         s.logged, s.sched, s.completed, s.hours::float, s.cost::float, coalesce(s.res,'') as res,
         s.svc_logged as "svcLogged",
         exists (select 1 from work_orders w where w.company_id = s.company_id and w.call_code = s.code and w.status in ('Issued','In progress')) as "hasOpenWo"
    from service_calls s
    left join customers c on c.company_id = s.company_id and c.code = s.cust_code
    left join assets a on a.company_id = s.company_id and a.code = s.asset_code
    left join employees t on t.company_id = s.company_id and t.code = s.tech_code
   where s.company_id = $1`;

// completed call → asset service history row (3783)
const writeSvcHistory = async (
  c: Client, companyId: string, call: { asset: string; code: string; completed: string; type: string; tech: string; cost: number; res: string }, techName: string,
): Promise<void> => {
  await c.query(
    `insert into asset_services (company_id, asset_code, entry_date, type, sup, cost, notes) values ($1,$2,$3,$4,$5,$6,$7)`,
    [companyId, call.asset, call.completed, svcTypeOf(call.type), techName, call.cost || 0, 'Call ' + call.code + ': ' + call.res]);
  await c.query('update service_calls set svc_logged = true where company_id = $1 and code = $2', [companyId, call.code]);
};

// validateCall port (3754–3772) — verbatim strings; a/tech fetched by caller when the call is being created/updated
const validateCall = (
  o: { cust: string; asset: string; descr: string; logged: string; sched: string; tech: string; status: string; completed: string; res: string; hours: number; cost: number },
  isNew: boolean, a: { status: string; cust_code: string } | undefined, tech: unknown,
): string => {
  const t0 = todayISO();
  if (!o.cust) return 'Select the customer.';
  if (!o.asset) return 'Select the asset the call is for.';
  if (!a || a.cust_code !== o.cust) return 'That asset is not linked to ' + o.cust + '.';
  if (isNew && a.status !== 'Active') return 'That asset is not active.';
  if (!o.descr.trim()) return 'Describe the problem or work requested.';
  if (!o.logged) return 'Enter the logged date.';
  if (isNew && o.logged > t0) return 'The logged date cannot be in the future.';
  if (o.sched && o.sched < o.logged) return 'The scheduled date cannot be before the logged date.';
  if (o.tech && !tech) return 'Choose a technician from the list.';
  if (['Assigned', 'In progress', 'On hold', 'Completed'].includes(o.status) && !o.tech) return 'Choose a technician before setting the status to "' + o.status + '".';
  if (o.status === 'Completed') {
    if (!o.completed) return 'Enter the completed date.';
    if (o.completed < o.logged) return 'The completed date cannot be before the logged date.';
    if (o.completed > t0) return 'The completed date cannot be in the future.';
    if (!o.res.trim()) return 'Enter the resolution notes.';
    if (!(o.hours >= 0)) return 'Hours cannot be negative.';
    if (!(o.cost >= 0)) return 'Cost cannot be negative.';
  }
  return '';
};

// ── Service calls ──
service.get('/calls', requireCan('service', 'trans'), async (req: AuthedReq, res, next) => {
  try { res.json((await q(CALL_SELECT, [req.companyId])).rows); } catch (e) { next(e); }
});

const callSchema = z.object({
  cust: z.string().optional().default(''), asset: z.string().optional().default(''), // fixed once logged (3750)
  type: z.string(), pri: z.enum(['Urgent', 'High', 'Normal', 'Low']), status: z.string(), descr: z.string(),
  tech: z.string().optional().default(''), logged: z.string(), sched: z.string().optional().default(''),
  completed: z.string().optional().default(''), hours: z.number(), cost: z.number(), res: z.string().optional().default(''),
});

service.post('/calls', requireCan('service', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const o = callSchema.parse(req.body);
    if (o.status === 'Logged' && o.tech) o.status = 'Assigned'; // 3779
    await withTx(async (c) => {
      const a = (await c.query('select code, status, cust_code from assets where company_id = $1 and code = $2', [req.companyId, o.asset])).rows[0];
      const t = o.tech ? (await c.query('select code from employees where company_id = $1 and code = $2', [req.companyId, o.tech])).rows[0] : undefined;
      const e = validateCall(o, true, a, t);
      if (e) throw new ApiError(400, e);
      const code = await nextDocRef(c, req.companyId!, 'service_calls', 'SC', 1, 'code', 4);
      const completed = o.status === 'Completed' ? o.completed : '';
      await c.query(
        `insert into service_calls (company_id, code, cust_code, asset_code, type, pri, descr, status, tech_code, logged, sched, completed, hours, cost, res)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,nullif($11::text,'')::date,nullif($12::text,'')::date,$13,$14,$15)`,
        [req.companyId, code, o.cust, o.asset, o.type, o.pri, o.descr.trim(), o.status, o.tech || null, o.logged, o.sched, completed, o.hours, o.cost, o.res.trim()]);
      if (o.status === 'Completed')
        await writeSvcHistory(c, req.companyId!, { asset: o.asset, code, completed, type: o.type, tech: o.tech, cost: o.cost, res: o.res.trim() }, (t as any)?.name || '');
      await logEv(req.user!.id, req.user!.username, 'Service call logged', `${code} ${o.status}`, req.companyId);
      res.status(201).json({ code });
    });
  } catch (e) { next(e); }
});

service.post('/calls/:code', requireCan('service', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const o = callSchema.parse(req.body);
    if (o.status === 'Logged' && o.tech) o.status = 'Assigned';
    await withTx(async (c) => {
      const base = (await c.query(`select code, cust_code as cust, asset_code as asset, logged, status, svc_logged as "svcLogged" from service_calls where company_id = $1 and code = $2`, [req.companyId, req.params.code])).rows[0];
      if (!base) throw new ApiError(404, 'Service call not found.');
      if (!callOpen(base.status)) throw new ApiError(409, `That service call is ${base.status.toLowerCase()} and cannot be changed.`);
      const a = (await c.query('select code, status, cust_code from assets where company_id = $1 and code = $2', [req.companyId, base.asset])).rows[0];
      const t = o.tech ? (await c.query('select code, name from employees where company_id = $1 and code = $2', [req.companyId, o.tech])).rows[0] : undefined;
      const e = validateCall({ ...o, cust: base.cust, asset: base.asset, logged: o.logged || base.logged }, false, a, t);
      if (e) throw new ApiError(400, e);
      const completed = o.status === 'Completed' ? o.completed : '';
      await c.query(
        `update service_calls set type = $3, pri = $4, descr = $5, status = $6, tech_code = $7, logged = $8, sched = nullif($9::text,'')::date,
                completed = nullif($10::text,'')::date, hours = $11, cost = $12, res = $13
          where company_id = $1 and code = $2`,
        [req.companyId, base.code, o.type, o.pri, o.descr.trim(), o.status, o.tech || null, o.logged || base.logged, o.sched, completed, o.hours, o.cost, o.res.trim()]);
      if (o.status === 'Completed' && !base.svcLogged)
        await writeSvcHistory(c, req.companyId!, { asset: base.asset, code: base.code, completed, type: o.type, tech: o.tech, cost: o.cost, res: o.res.trim() }, (t as any)?.name || '');
      await logEv(req.user!.id, req.user!.username, 'Service call updated', `${base.code} ${o.status}`, req.companyId);
      res.json({ code: base.code });
    });
  } catch (e) { next(e); }
});

// callAction 'start' (3789)
service.post('/calls/:code/action', requireCan('service', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    z.object({ action: z.literal('start') }).parse(req.body);
    await withTx(async (c) => {
      const call = (await c.query('select code, tech_code from service_calls where company_id = $1 and code = $2', [req.companyId, req.params.code])).rows[0];
      if (!call) throw new ApiError(404, 'Service call not found.');
      if (!call.tech_code) throw new ApiError(400, 'Assign a technician first.');
      await c.query(`update service_calls set status = 'In progress' where company_id = $1 and code = $2`, [req.companyId, call.code]);
      await logEv(req.user!.id, req.user!.username, 'Service call started', call.code, req.companyId);
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});

// technicians + active staff for selects (renderTechs 3721, pq-by 5153)
// NB: '/staff' is taken by contracts (356) — this endpoint follows legacy DATA.techs
service.get('/techs', requireCan('service', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const rows = (await q(`select code, name, is_tech as tech, active from employees where company_id = $1 order by name`, [req.companyId])).rows;
    res.json(rows);
  } catch (e) { next(e); }
});

// ── Service Call Types (legacy SVT 5492–5507) — settings module guard, flat mount ──
const svtCan = requireCan('settings', 'svctypes');

service.get('/call-types', svtCan, async (req: AuthedReq, res, next) => {
  try {
    const rows = (await q(
      `select t.name, coalesce(t.descr,'') as descr, t.active,
              (select count(*)::int from service_calls c where c.company_id = t.company_id and c.type = t.name) as use
         from call_types t where t.company_id = $1 order by t.name`, [req.companyId])).rows;
    res.json(rows);
  } catch (e) { next(e); }
});

service.post('/call-types', svtCan, async (req: AuthedReq, res, next) => {
  try {
    const o = z.object({ name: z.string(), descr: z.string().optional().default('') }).parse(req.body);
    const name = o.name.replace(/\s+/g, ' ').trim();
    await withTx(async (c) => {
      if (!name) throw new ApiError(400, 'Enter a name.');
      const dup = (await c.query(`select 1 as x from call_types where company_id = $1 and lower(btrim(name)) = lower($2)`, [req.companyId, name])).rows.length;
      if (dup) throw new ApiError(400, 'A call type with this name already exists.');
      await c.query(`insert into call_types (company_id, name, descr) values ($1,$2,nullif($3,''))`, [req.companyId, name, o.descr.trim()]);
      await logEv(req.user!.id, req.user!.username, 'Call type added', name, req.companyId);
      res.status(201).json({ name });
    });
  } catch (e) { next(e); }
});

// rename cascades into calls (5502)
service.patch('/call-types/:name', svtCan, async (req: AuthedReq, res, next) => {
  try {
    const o = z.object({ name: z.string(), descr: z.string().optional().default('') }).parse(req.body);
    const name = o.name.replace(/\s+/g, ' ').trim();
    await withTx(async (c) => {
      const cur = (await c.query(`select name from call_types where company_id = $1 and lower(btrim(name)) = lower($2)`, [req.companyId, req.params.name])).rows[0];
      if (!cur) throw new ApiError(404, 'Call type not found.');
      if (!name) throw new ApiError(400, 'Enter a name.');
      if (name.toLowerCase() !== cur.name.toLowerCase()) {
        const dup = (await c.query(`select 1 as x from call_types where company_id = $1 and lower(btrim(name)) = lower($2)`, [req.companyId, name])).rows.length;
        if (dup) throw new ApiError(400, 'A call type with this name already exists.');
      }
      await c.query(`update call_types set name = $3, descr = nullif($4,'') where company_id = $1 and name = $2`, [req.companyId, cur.name, name, o.descr.trim()]);
      if (cur.name !== name) await c.query(`update service_calls set type = $3 where company_id = $1 and type = $2`, [req.companyId, cur.name, name]);
      await logEv(req.user!.id, req.user!.username, 'Call type updated', name, req.companyId);
      res.json({ name: cur.name });
    });
  } catch (e) { next(e); }
});

// toggleSvcType (5506): at least one call type stays active
service.post('/call-types/:name/toggle', svtCan, async (req: AuthedReq, res, next) => {
  try {
    await withTx(async (c) => {
      const cur = (await c.query(`select name, active from call_types where company_id = $1 and name = $2`, [req.companyId, req.params.name])).rows[0];
      if (!cur) throw new ApiError(404, 'Call type not found.');
      if (cur.active) {
        const n = (await c.query(`select count(*)::int as n from call_types where company_id = $1 and active`, [req.companyId])).rows[0].n;
        if (n < 2) throw new ApiError(400, 'At least one call type must stay active.');
      }
      await c.query(`update call_types set active = not active where company_id = $1 and name = $2`, [req.companyId, cur.name]);
      await logEv(req.user!.id, req.user!.username, cur.active ? 'Call type deactivated' : 'Call type activated', cur.name, req.companyId);
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});

// deleteSvcType (5507): legacy blocked silently when in use — 409 strings new (batch-3 ctypes style)
service.delete('/call-types/:name', svtCan, async (req: AuthedReq, res, next) => {
  try {
    await withTx(async (c) => {
      const cur = (await c.query(
        `select t.name, t.active,
                (select count(*)::int from service_calls c where c.company_id = t.company_id and c.type = t.name) as use
           from call_types t where t.company_id = $1 and t.name = $2`, [req.companyId, req.params.name])).rows[0];
      if (!cur) throw new ApiError(404, 'Call type not found.');
      if (cur.use) throw new ApiError(409, `"${cur.name}" is used on a service call and cannot be deleted. Deactivate it instead.`);
      const n = (await c.query(`select count(*)::int as n from call_types where company_id = $1`, [req.companyId])).rows[0].n;
      if (n < 2 && cur.active) throw new ApiError(400, 'At least one call type must stay active.');
      await c.query(`delete from call_types where company_id = $1 and name = $2`, [req.companyId, cur.name]);
      await logEv(req.user!.id, req.user!.username, 'Call type deleted', cur.name, req.companyId);
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});

// ── Call requests (4469–4501) ──
const rqSchema = z.object({
  cust: z.string(), asset: z.string(), contact: z.string(), phone: z.string().optional().default(''),
  pri: z.enum(['Urgent', 'High', 'Normal', 'Low']), received: z.string(), descr: z.string(),
});

// saveReq validation order (4492–4493)
const validateReq = async (c: Client, companyId: string, o: z.infer<typeof rqSchema>): Promise<void> => {
  if (!o.cust) throw new ApiError(400, 'Select the customer.');
  const a = (await c.query('select code, cust_code from assets where company_id = $1 and code = $2', [companyId, o.asset])).rows[0];
  if (!a || a.cust_code !== o.cust) throw new ApiError(400, "Select one of the customer's assets.");
  if (!o.contact.trim()) throw new ApiError(400, 'Enter the contact person.');
  if (!o.received) throw new ApiError(400, 'Enter the received date.');
  if (o.received > todayISO()) throw new ApiError(400, 'The received date cannot be in the future.');
  if (!o.descr.trim()) throw new ApiError(400, 'Describe the problem or request.');
};

service.get('/requests', requireCan('service', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const rows = (await q(
      `select r.code, r.cust_code as cust, c.name as "custName", r.asset_code as asset, a.name as "assetName",
              r.contact, coalesce(r.phone,'') as phone, r.pri, r.received, r.descr, r.status, coalesce(r.reason,'') as reason, r.call_code as call
         from call_requests r
         left join customers c on c.company_id = r.company_id and c.code = r.cust_code
         left join assets a on a.company_id = r.company_id and a.code = r.asset_code
        where r.company_id = $1`, [req.companyId])).rows;
    res.json(rows);
  } catch (e) { next(e); }
});

service.post('/requests', requireCan('service', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const o = rqSchema.parse(req.body);
    await withTx(async (c) => {
      await validateReq(c, req.companyId!, o);
      const code = await nextDocRef(c, req.companyId!, 'call_requests', 'RQ', 1, 'code', 4);
      await c.query(
        `insert into call_requests (company_id, code, cust_code, asset_code, contact, phone, pri, received, descr)
         values ($1,$2,$3,$4,$5,nullif($6,''),$7,$8,$9)`,
        [req.companyId, code, o.cust, o.asset, o.contact.trim(), o.phone, o.pri, o.received, o.descr.trim()]);
      await logEv(req.user!.id, req.user!.username, 'Call request logged', o.cust, req.companyId);
      res.status(201).json({ code });
    });
  } catch (e) { next(e); }
});

service.post('/requests/:code', requireCan('service', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const o = rqSchema.parse(req.body);
    await withTx(async (c) => {
      const r = (await c.query("select code from call_requests where company_id = $1 and code = $2 and status = 'New'", [req.companyId, req.params.code])).rows[0];
      if (!r) throw new ApiError(404, 'Call request not found.');
      await validateReq(c, req.companyId!, o);
      await c.query(
        `update call_requests set cust_code = $3, asset_code = $4, contact = $5, phone = nullif($6,''), pri = $7, received = $8, descr = $9
          where company_id = $1 and code = $2`,
        [req.companyId, r.code, o.cust, o.asset, o.contact.trim(), o.phone, o.pri, o.received, o.descr.trim()]);
      await logEv(req.user!.id, req.user!.username, 'Call request updated', o.cust, req.companyId);
      res.json({ code: r.code });
    });
  } catch (e) { next(e); }
});

service.post('/requests/:code/decline', requireCan('service', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const { reason } = z.object({ reason: z.string() }).parse(req.body);
    await withTx(async (c) => {
      const r = (await c.query("select code from call_requests where company_id = $1 and code = $2 and status = 'New'", [req.companyId, req.params.code])).rows[0];
      if (!r) throw new ApiError(404, 'Call request not found.');
      if (!reason.trim()) throw new ApiError(400, 'Enter the reason for declining.');
      await c.query(`update call_requests set status = 'Declined', reason = $3 where company_id = $1 and code = $2`, [req.companyId, r.code, reason.trim()]);
      await logEv(req.user!.id, req.user!.username, 'Call request declined', r.code, req.companyId);
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});

// convertReq (4497)
service.post('/requests/:code/convert', requireCan('service', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    await withTx(async (c) => {
      const r = (await c.query("select code, cust_code as cust, asset_code as asset, pri, received, descr, contact, phone from call_requests where company_id = $1 and code = $2 and status = 'New'", [req.companyId, req.params.code])).rows[0];
      if (!r) throw new ApiError(404, 'Call request not found.');
      const code = await nextDocRef(c, req.companyId!, 'service_calls', 'SC', 1, 'code', 4);
      const d = r.descr + (r.contact ? ' (Contact: ' + r.contact + (r.phone ? ' ' + r.phone : '') + ')' : '');
      await c.query(
        `insert into service_calls (company_id, code, cust_code, asset_code, type, pri, descr, status, tech_code, logged)
         values ($1,$2,$3,$4,'Breakdown',$5,$6,'Logged',null,$7)`,
        [req.companyId, code, r.cust, r.asset, r.pri, d, r.received]);
      await c.query(`update call_requests set status = 'Converted', call_code = $3 where company_id = $1 and code = $2`, [req.companyId, r.code, code]);
      await logEv(req.user!.id, req.user!.username, 'Call request converted', `${r.code} → ${code}`, req.companyId);
      res.status(201).json({ code });
    });
  } catch (e) { next(e); }
});

// ── Work orders (4502–4556) ──
const partSchema = z.object({ descr: z.string(), sku: z.string().optional().default(''), qty: z.number(), cost: z.number() });
const woSchema = z.object({
  call: z.string(), tech: z.string(), sched: z.string().optional().default(''), status: z.string(),
  hours: z.number(), instr: z.string(), completed: z.string().optional().default(''),
  notes: z.string().optional().default(''), parts: z.array(partSchema),
});
const woParts = (parts: { qty: number; cost: number }[]): number => r2(parts.reduce((t, x) => t + (x.qty || 0) * (x.cost || 0), 0));

service.get('/workorders', requireCan('service', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const rows = (await q(
      `select w.code, w.call_code as call, c.cust_code as cust, c.asset_code as asset, a.name as "assetName",
              cu.name as "custName", w.tech_code as tech, t.name as "techName", w.sched, w.status, w.hours::float, w.instr,
              w.completed, coalesce(w.notes,'') as notes, w.created,
              (select coalesce(sum(p.qty * p.cost),0)::float from wo_parts p where p.company_id = w.company_id and p.wo_code = w.code) as "partsCost"
         from work_orders w
         left join service_calls c on c.company_id = w.company_id and c.code = w.call_code
         left join customers cu on cu.company_id = c.company_id and cu.code = c.cust_code
         left join assets a on a.company_id = c.company_id and a.code = c.asset_code
         left join employees t on t.company_id = w.company_id and t.code = w.tech_code
        where w.company_id = $1`, [req.companyId])).rows;
    res.json(rows);
  } catch (e) { next(e); }
});

service.get('/workorders/:code/parts', requireCan('service', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const rows = (await q(`select seq, descr, item_sku as sku, qty::float, cost::float from wo_parts where company_id = $1 and wo_code = $2 order by seq`, [req.companyId, req.params.code])).rows;
    res.json(rows);
  } catch (e) { next(e); }
});

const saveWoParts = async (c: Client, companyId: string, code: string, parts: z.infer<typeof partSchema>[]): Promise<void> => {
  await c.query('delete from wo_parts where company_id = $1 and wo_code = $2', [companyId, code]);
  let seq = 0;
  for (const p of parts) {
    seq++;
    await c.query(
      `insert into wo_parts (company_id, wo_code, seq, descr, item_sku, qty, cost) values ($1,$2,$3,$4,nullif($5,''),$6,$7)`,
      [companyId, code, seq, p.descr, p.sku, p.qty, p.cost]);
  }
};

// WIP → Cost of Sales at completion (glWip 5527–5529): per issued request, outstanding after good returns
const wipToCos = async (c: Client, companyId: string, w: { code: string; call: string }, cd: string): Promise<void> => {
  const prs = (await c.query(
    `select p.sku, p.qty::float, p.cost::float, coalesce(sc.cos,'2000') as cos,
            (select coalesce(sum(r.qty),0)::float from part_returns r where r.company_id = p.company_id and r.pr_code = p.code and r.cond like 'Good%') as returned
       from part_requests p
       left join stock_items i on i.company_id = p.company_id and i.sku = p.sku
       left join stock_categories sc on sc.company_id = i.company_id and sc.code = i.cat_code
      where p.company_id = $1 and p.wo_code = $2 and p.status = 'Issued'`, [companyId, w.code])).rows as any[];
  const fyId = await fyIdFor(c, companyId, cd);
  for (const pr of prs) {
    const t = r2(r2(pr.qty - pr.returned) * (pr.cost ?? 0));
    if (!t) continue;
    await postJournal(c, {
      companyId, fyId, date: cd, ref: w.call, src: 'WIP to Cost of Sales', srcType: 'work_order', srcId: w.code,
      desc: `${w.code} · ${pr.sku}`, userId: null, lines: [{ acc: pr.cos, dr: t, cr: 0 }, { acc: WIP, dr: 0, cr: t }],
    });
  }
};

// saveWO body (4526–4546) — validations verbatim
const validateWo = async (c: Client, companyId: string, o: z.infer<typeof woSchema>, isNewCall: string | null, hasOpenWo: boolean): Promise<{ call: any }> => {
  const call = (await c.query('select code, status, logged, asset_code, type from service_calls where company_id = $1 and code = $2', [companyId, o.call])).rows[0];
  if (!call) throw new ApiError(400, 'Select the service call.');
  if (isNewCall) {
    if (!callOpen(call.status)) throw new ApiError(400, `That service call is ${call.status.toLowerCase()}.`);
    if (hasOpenWo) throw new ApiError(400, 'That call already has an open work order.');
  }
  if (!o.tech) throw new ApiError(400, 'Choose the technician.');
  if (!(await c.query('select 1 as x from employees where company_id = $1 and code = $2', [companyId, o.tech])).rows[0])
    throw new ApiError(400, 'Choose a technician from the list.');
  if (!o.instr.trim()) throw new ApiError(400, 'Enter the instructions / work to be done.');
  if (o.sched && o.sched < call.logged) throw new ApiError(400, `The scheduled date cannot be before the call was logged (${fmtD(call.logged)}).`);
  if (!(o.hours >= 0)) throw new ApiError(400, 'Hours cannot be negative.');
  if (o.parts.some((x) => !x.descr || !(x.qty > 0) || !(x.cost >= 0)))
    throw new ApiError(400, 'Each part needs a description, a quantity above zero and a cost of zero or more.');
  const t0 = todayISO();
  if (o.status === 'Completed') {
    if (!o.completed) throw new ApiError(400, 'Enter the completed date.');
    if (o.completed < call.logged) throw new ApiError(400, 'The completed date cannot be before the logged date.');
    if (o.completed > t0) throw new ApiError(400, 'The completed date cannot be in the future.');
    if (!o.notes.trim()) throw new ApiError(400, 'Enter what work was done.');
  }
  return { call };
};

// call/asset sync + svc history + WIP→COS journals (4539–4546)
const syncWoToCall = async (c: Client, req: AuthedReq, o: z.infer<typeof woSchema>, call: any, w: { code: string; call: string }): Promise<void> => {
  if (o.tech && callOpen(call.status)) await c.query('update service_calls set tech_code = $3 where company_id = $1 and code = $2 and (tech_code is null or tech_code <> $3)', [req.companyId, call.code, o.tech]);
  if (o.sched && callOpen(call.status)) await c.query('update service_calls set sched = $3 where company_id = $1 and code = $2 and sched is null', [req.companyId, call.code, o.sched]);  if (o.status === 'Issued' && call.status === 'Logged')
    await c.query(`update service_calls set status = 'Assigned' where company_id = $1 and code = $2`, [req.companyId, call.code]);
  if (o.status === 'In progress' && ['Logged', 'Assigned', 'On hold'].includes(call.status))
    await c.query(`update service_calls set status = 'In progress' where company_id = $1 and code = $2`, [req.companyId, call.code]);
  if (o.status === 'Cancelled' && call.status === 'In progress')
    await c.query(`update service_calls set status = 'Assigned' where company_id = $1 and code = $2`, [req.companyId, call.code]);
  if (o.status === 'Completed') {
    const partsCost = woParts(o.parts);
    await c.query(
      `update service_calls set status = 'Completed', completed = $3, hours = $4, cost = $5, res = $6 where company_id = $1 and code = $2`,
      [req.companyId, call.code, o.completed, o.hours, partsCost, o.notes.trim()]);
    const fresh = (await c.query('select asset_code as asset, type, svc_logged as "svcLogged", completed from service_calls where company_id = $1 and code = $2', [req.companyId, call.code])).rows[0];
    if (!fresh.svcLogged) {
      const nm = (await c.query('select name from employees where company_id = $1 and code = $2', [req.companyId, o.tech])).rows[0]?.name || '';
      await writeSvcHistory(c, req.companyId!, { asset: fresh.asset, code: call.code, completed: o.completed, type: fresh.type, tech: o.tech, cost: partsCost, res: o.notes.trim() }, nm);
    }
    await wipToCos(c, req.companyId!, w, o.completed);
  }
};

service.post('/workorders', requireCan('service', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const o = woSchema.parse(req.body);
    await withTx(async (c) => {
      const hasOpenWo = !!(await c.query(`select 1 as x from work_orders where company_id = $1 and call_code = $2 and status in ('Issued','In progress')`, [req.companyId, o.call])).rows[0];
      const { call } = await validateWo(c, req.companyId!, o, 'new', hasOpenWo);
      const code = await nextDocRef(c, req.companyId!, 'work_orders', 'WO', 1, 'code', 4);
      await c.query(
        `insert into work_orders (company_id, code, call_code, tech_code, sched, status, hours, instr, completed, notes, created)
         values ($1,$2,$3,nullif($4,''),nullif($5::text,'')::date,$6,$7,$8,nullif($9::text,'')::date,$10,$11)`,
        [req.companyId, code, o.call, o.tech, o.sched, o.status, o.hours, o.instr.trim(), o.status === 'Completed' ? o.completed : '', o.notes.trim(), todayISO()]);
      await saveWoParts(c, req.companyId!, code, o.parts);
      await syncWoToCall(c, req, o, call, { code, call: o.call });
      await logEv(req.user!.id, req.user!.username, 'Work order created', `${code} ${o.status}`, req.companyId);
      res.status(201).json({ code });
    });
  } catch (e) { next(e); }
});

service.post('/workorders/:code', requireCan('service', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const o = woSchema.parse(req.body);
    await withTx(async (c) => {
      const base = (await c.query('select code, call_code as call, status from work_orders where company_id = $1 and code = $2', [req.companyId, req.params.code])).rows[0];
      if (!base) throw new ApiError(404, 'Work order not found.');
      if (!WO_OPEN.includes(base.status)) throw new ApiError(409, `That work order is ${base.status.toLowerCase()} and cannot be changed.`);
      const { call } = await validateWo(c, req.companyId!, o, null, false);
      await c.query(
        `update work_orders set tech_code = $3, sched = nullif($4::text,'')::date, status = $5, hours = $6, instr = $7, completed = nullif($8::text,'')::date, notes = $9
          where company_id = $1 and code = $2`,
        [req.companyId, base.code, o.tech, o.sched, o.status, o.hours, o.instr.trim(), o.status === 'Completed' ? o.completed : '', o.notes.trim()]);
      await saveWoParts(c, req.companyId!, base.code, o.parts);
      await syncWoToCall(c, req, o, call, { code: base.code, call: o.call });
      await logEv(req.user!.id, req.user!.username, 'Work order updated', `${base.code} ${o.status}`, req.companyId);
      res.json({ code: base.code });
    });
  } catch (e) { next(e); }
});

// ── Work in progress (wipRows 4574–4583) — legacy computed at render; server computes ──
service.get('/wip', requireCan('service', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    const t0 = todayISO();
    const sla = (await q(`select pri, resp, res from sla_targets where company_id = $1`, [req.companyId])).rows as any[];
    const slaOf = (pri: string) => sla.find((x) => x.pri === pri) || { resp: 2, res: 5 };
    const calls = (await q(CALL_SELECT, [req.companyId])).rows as any[];
    const wos = (await q(
      `select w.code, w.call_code as call, w.status, w.hours::float, w.tech_code as tech,
              (select coalesce(sum(p.qty * p.cost),0)::float from wo_parts p where p.company_id = w.company_id and p.wo_code = w.code) as "partsCost"
         from work_orders w where w.company_id = $1 and w.status <> 'Cancelled'`, [req.companyId])).rows as any[];
    const techs = (await q(`select code, name from employees where company_id = $1 and is_tech order by name`, [req.companyId])).rows as any[];
    // slaState (4461–4467)
    const slaState = (c: any): { resp: string; reso: string } => {
      const S = slaOf(c.pri), rd = dayAdd(c.logged, S.resp), xd = dayAdd(c.logged, S.res);
      let resp: string, reso: string;
      if (c.sched) resp = c.sched <= rd ? 'Met' : 'Breached';
      else resp = (callOpen(c.status) && t0 > rd) || (!callOpen(c.status) && c.status === 'Completed') ? 'Breached' : 'Pending';
      if (c.status === 'Completed') reso = c.completed <= xd ? 'Met' : 'Breached';
      else if (c.status === 'Cancelled') reso = 'n/a';
      else reso = t0 > xd ? 'Breached' : 'On track';
      return { resp, reso };
    };
    const rows = calls.filter((c) => ['Assigned', 'In progress', 'On hold'].includes(c.status)).map((c) => {
      const ws = wos.filter((w) => w.call === c.code);
      const ow = ws.find((w) => WO_OPEN.includes(w.status)) || (ws.length ? ws[ws.length - 1] : null);
      return { call: c, ow: ow ? { code: ow.code, status: ow.status } : null,
        hours: r2(ws.reduce((a, w) => a + (+w.hours || 0), 0)), parts: r2(ws.reduce((a, w) => a + w.partsCost, 0)),
        age: Math.max(0, daysBetween(c.logged, t0)), sla: slaState(c) };
    }).sort((a, b) => b.age - a.age);
    const techRows = techs.map((t) => {
      const m = rows.filter((r) => r.call.tech === t.code);
      return { tech: t.name, calls: m.length, wos: wos.filter((w) => w.tech === t.code && WO_OPEN.includes(w.status)).length,
        hours: r2(m.reduce((a, r) => a + r.hours, 0)), parts: r2(m.reduce((a, r) => a + r.parts, 0)) };
    }).filter((x) => x.calls);
    res.json({ rows, techRows, openWos: wos.filter((w) => WO_OPEN.includes(w.status)).length });
  } catch (e) { next(e); }
});

// ── SLA targets (4585–4597) ──
service.get('/sla', requireCan('service', 'enq'), async (req: AuthedReq, res, next) => {
  try {
    const rows = (await q(`select pri, resp, res from sla_targets where company_id = $1 order by array_position(array['Urgent','High','Normal','Low'], pri)`, [req.companyId])).rows;
    res.json(rows);
  } catch (e) { next(e); }
});

service.put('/sla', requireCan('service', 'trans'), async (req: AuthedReq, res, next) => {
  try {
    const n = z.array(z.object({ pri: z.string(), resp: z.number(), res: z.number() })).parse(req.body);
    if (n.some((x) => !(x.resp >= 0 && x.resp <= 365) || !(x.res >= 0 && x.res <= 365))) throw new ApiError(400, 'Enter whole days from 0 to 365.');
    if (n.some((x) => x.res < x.resp)) throw new ApiError(400, 'The resolve target cannot be shorter than the respond target.');
    await withTx(async (c) => {
      for (const x of n)
        await c.query('update sla_targets set resp = $3, res = $4 where company_id = $1 and pri = $2', [req.companyId, x.pri, x.resp, x.res]);
      await logEv(req.user!.id, req.user!.username, 'Call SLA targets updated', n.map((x) => x.pri + ' ' + x.resp + '/' + x.res).join(', '), req.companyId);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
