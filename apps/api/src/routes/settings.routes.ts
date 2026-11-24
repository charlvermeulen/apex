import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { ApiError, AuthedReq, logEv, requireAuth, requireCan } from '../middleware.js';
import { encrypt, decrypt } from '../crypto.js';
import { nextDocRef, withTx } from '../posting.js';

export const settings = Router();
settings.use(requireAuth);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const splitAddr = (v: string) => String(v || '').split(/[;,]/).map((x) => x.trim()).filter(Boolean);

const rowToClient = (r: Record<string, unknown>) => {
  const { smtp_pass_enc, save_pass, ...rest } = r;
  void smtp_pass_enc, void save_pass;
  return { ...rest, has_password: !!smtp_pass_enc, save_pass: !!save_pass };
};

// GET /settings/email — never returns the password (legacy cached it in sessionStorage; API decrypts internally only).
settings.get('/email', requireCan('settings', 'email'), async (req: AuthedReq, res, next) => {
  try {
    let row = (await q('select * from email_settings where company_id = $1', [req.companyId])).rows[0];
    if (!row) {
      row = (await q(
        `insert into email_settings (company_id, mode) values ($1, 'simulate') on conflict do nothing returning *`,
        [req.companyId])).rows[0]
        ?? (await q('select * from email_settings where company_id = $1', [req.companyId])).rows[0];
    }
    res.json(rowToClient(row));
  } catch (e) { next(e); }
});

// PUT /settings/email — validateSmtp port (legacy 2944–2957)
const emailBody = z.object({
  mode: z.enum(['simulate', 'mailto', 'relay']),
  // nullable: GET returns DB nulls and the tab PUTs them straight back
  host: z.string().nullable().optional(), port: z.union([z.number(), z.string()]).nullable().optional(),
  security: z.enum(['starttls', 'ssl', 'none']).nullable().optional(),
  smtp_user: z.string().nullable().optional(), smtp_pass: z.string().optional().nullable(), save_pass: z.boolean().optional(),
  from_name: z.string().nullable().optional(), from_email: z.string().nullable().optional(), reply_to: z.string().nullable().optional(), bcc: z.string().nullable().optional(),
  relay_url: z.string().nullable().optional(), relay_token: z.string().nullable().optional(),
  subject_tpl: z.string().optional(), body_tpl: z.string().optional(),
});

settings.put('/email', requireCan('settings', 'email'), async (req: AuthedReq, res, next) => {
  try {
    const c = emailBody.parse(req.body);
    const errs: string[] = [];
    const rel = c.mode === 'relay';
    if (c.host || rel) { if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test((c.host || '').trim())) errs.push('Enter a valid SMTP host name.'); }
    const portNum: number | null = c.port === '' || c.port == null ? null : Number(c.port);
    if (c.port !== '' && c.port != null || rel) { if (!Number.isInteger(portNum) || (portNum as number) < 1 || (portNum as number) > 65535) errs.push('Port must be a whole number between 1 and 65535.'); }
    if (!['starttls', 'ssl', 'none'].includes(c.security || 'starttls')) errs.push('Choose a connection security option.');
    if (c.from_email || rel) { if (!EMAIL_RE.test(c.from_email || '')) errs.push('Enter a valid From email address.'); }
    if (c.reply_to && !EMAIL_RE.test(c.reply_to)) errs.push('Reply-To is not a valid email address.');
    if (c.bcc && !splitAddr(c.bcc).every((x) => EMAIL_RE.test(x))) errs.push('BCC contains an invalid email address.');
    if (rel) {
      if (!/^https:\/\/.+/i.test(c.relay_url || '') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(c.relay_url || ''))
        errs.push('Relay URL must start with https:// (http:// is only allowed for localhost).');
      if (!(c.relay_token || '').trim()) errs.push('Enter the relay access token.');
    }
    const s = (await q('select subject_tpl, body_tpl from email_settings where company_id = $1', [req.companyId])).rows[0];
    if (!c.subject_tpl && !(s?.subject_tpl)) errs.push('Enter a subject for the statement email.');
    if (!c.body_tpl?.trim() && !(s?.body_tpl || '').trim()) errs.push('Enter a message for the statement email.');
    if (errs.length) throw new ApiError(400, errs.join(' '));

    const savePass = c.save_pass ?? false;
    const passEnc = (c.smtp_pass && c.smtp_pass.length) ? encrypt(c.smtp_pass) : undefined;
    await q(
      `insert into email_settings (company_id, mode, host, port, security, smtp_user, smtp_pass_enc, save_pass,
         from_name, from_email, reply_to, bcc, relay_url, relay_token, subject_tpl, body_tpl, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
       on conflict (company_id) do update set
         mode = excluded.mode, host = excluded.host, port = excluded.port, security = excluded.security,
         smtp_user = excluded.smtp_user,
         smtp_pass_enc = coalesce(excluded.smtp_pass_enc, email_settings.smtp_pass_enc),
         save_pass = excluded.save_pass, from_name = excluded.from_name, from_email = excluded.from_email,
         reply_to = excluded.reply_to, bcc = excluded.bcc, relay_url = excluded.relay_url,
         relay_token = excluded.relay_token, subject_tpl = excluded.subject_tpl, body_tpl = excluded.body_tpl,
         updated_at = now()`,
      [req.companyId, c.mode, c.host || null, portNum ?? 587, c.security || 'starttls', c.smtp_user || null,
        passEnc ?? null, savePass, c.from_name || null, c.from_email || null, c.reply_to || null, c.bcc || null,
        c.relay_url || null, c.relay_token || null, c.subject_tpl ?? s?.subject_tpl ?? null, c.body_tpl ?? s?.body_tpl ?? null],
    );
    await logEv(req.user!.id, req.user!.username, 'Email settings updated', 'Delivery: ' + c.mode + (c.host ? ' · host ' + c.host : ''), req.companyId);
    const row = (await q('select * from email_settings where company_id = $1', [req.companyId])).rows[0];
    res.json(rowToClient(row));
  } catch (e) { next(e); }
});

// relayCall('verify') port (legacy 2964–2973): server-side, 20s abort, same payload contract.
settings.post('/email/test', requireCan('settings', 'email'), async (req: AuthedReq, res, next) => {
  try {
    const row = (await q('select * from email_settings where company_id = $1', [req.companyId])).rows[0];
    if (!row) throw new ApiError(400, 'Email settings are not configured yet.');
    if (row.mode !== 'relay') throw new ApiError(400, 'Testing the SMTP connection needs the mail relay. Choose “Send through my mail relay” first.');
    const pass = row.smtp_pass_enc ? decrypt(row.smtp_pass_enc) : '';
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(String(row.relay_url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + row.relay_token },
        body: JSON.stringify({
          action: 'verify',
          smtp: { host: row.host, port: Number(row.port), security: row.security, user: row.smtp_user || '', pass },
          from: { name: row.from_name || '', address: row.from_email || '' },
          replyTo: row.reply_to || undefined,
        }),
        signal: ctl.signal,
      });
      clearTimeout(tm);
      let j: { ok?: boolean; error?: string; messageId?: string } = {};
      try { j = await r.json(); } catch { /* relay may return empty body on failure */ }
      const status = r.ok && j.ok ? 'Verified' : 'Failed';
      const detail = r.ok && j.ok ? `Connected to ${row.host}:${row.port}` : (j.error || 'Relay returned HTTP ' + r.status);
      await logEv(req.user!.id, req.user!.username, 'Test email', status + ' — ' + detail, req.companyId);
      res.json({ status, detail });
    } catch (e: unknown) {
      clearTimeout(tm);
      const err = e as { name?: string; message?: string };
      res.json({ status: 'Failed', detail: err.name === 'AbortError' ? 'The relay did not respond within 20 seconds.' : 'Could not reach the relay (' + (err.message || 'network error') + '). Check the URL, that it is running, and that CORS is allowed.' });
    }
  } catch (e) { next(e); }
});

// ── Employees (legacy 4858–4896) ──

const empSchema = z.object({
  name: z.string(),
  email: z.string().optional().default(''),
  phone: z.string().optional().default(''),
  mgr: z.boolean(),
  sales: z.boolean(),
  tech: z.boolean(),
  active: z.boolean(),
});

const empCan = requireCan('settings', 'employees');

settings.get('/employees', empCan, async (req: AuthedReq, res, next) => {
  try {
    // empUse (4865): contracts + service calls (tech use lands with batch 4)
    const rows = (await q(
      `select e.code, e.name, coalesce(e.email,'') as email, coalesce(e.phone,'') as phone,
              e.is_mgr as mgr, e.is_sales as sales, e.is_tech as tech, e.active,
              (select count(*)::int from contracts c where c.company_id = e.company_id and (c.mgr_code = e.code or c.sales_code = e.code)) as use
         from employees e where e.company_id = $1 order by e.name`, [req.companyId])).rows;
    res.json(rows);
  } catch (e) { next(e); }
});

settings.post('/employees', empCan, async (req: AuthedReq, res, next) => {
  try {
    const o = empSchema.parse(req.body);
    const name = o.name.replace(/\s+/g, ' ').trim();
    await withTx(async (c) => {
      if (name.length < 2) throw new ApiError(400, "Enter the employee's name.");
      if (o.email && !EMAIL_RE.test(o.email)) throw new ApiError(400, 'Enter a valid email address.');
      if (!o.mgr && !o.sales && !o.tech) throw new ApiError(400, 'Tick at least one role.');
      const dup = (await c.query(`select 1 from employees where company_id = $1 and lower(btrim(name)) = lower($2)`, [req.companyId, name])).rows.length;
      if (dup) throw new ApiError(400, `An employee called "${name}" already exists.`);
      const n = (await c.query('select count(*)::int as n from employees where company_id = $1', [req.companyId])).rows[0].n;
      if (n >= 200) throw new ApiError(400, 'The maximum is 200 employees.');
      const code = await nextDocRef(c, req.companyId!, 'employees', 'EM', 1, 'code', 4);
      await c.query(
        `insert into employees (company_id, code, name, email, phone, is_mgr, is_sales, is_tech, active)
         values ($1,$2,$3,nullif($4,''),nullif($5,''),$6,$7,$8,$9)`,
        [req.companyId, code, name, o.email, o.phone, o.mgr, o.sales, o.tech, o.active]);
      await logEv(req.user!.id, req.user!.username, 'Employee added', name, req.companyId);
      res.status(201).json({ code });
    });
  } catch (e) { next(e); }
});

settings.patch('/employees/:code', empCan, async (req: AuthedReq, res, next) => {
  try {
    const o = empSchema.parse(req.body);
    const name = o.name.replace(/\s+/g, ' ').trim();
    await withTx(async (c) => {
      const base = (await c.query('select code, name, is_mgr, is_sales, is_tech from employees where company_id = $1 and code = $2', [req.companyId, req.params.code])).rows[0];
      if (!base) throw new ApiError(404, 'Employee not found.');
      if (name.length < 2) throw new ApiError(400, "Enter the employee's name.");
      if (o.email && !EMAIL_RE.test(o.email)) throw new ApiError(400, 'Enter a valid email address.');
      if (!o.mgr && !o.sales && !o.tech) throw new ApiError(400, 'Tick at least one role.');
      const dup = (await c.query(`select 1 from employees where company_id = $1 and lower(btrim(name)) = lower($2) and code <> $3`, [req.companyId, name, base.code])).rows.length;
      if (dup) throw new ApiError(400, `An employee called "${name}" already exists.`);
      // TODO(batch4): service-call technician guard — legacy 4891 first half
      const lost = (await c.query(
        `select code, mgr_code, sales_code from contracts where company_id = $1 and (mgr_code = $2 and not $3::bool) or (sales_code = $2 and not $4::bool) limit 1`,
        [req.companyId, base.code, o.mgr, o.sales])).rows[0];
      if (lost)
        throw new ApiError(400, `${base.name} is the ${lost.mgr_code === base.code ? 'Contract Manager' : 'Sales Person'} on ${lost.code}, so that role cannot be removed.`);
      await c.query(
        `update employees set name = $3, email = nullif($4,''), phone = nullif($5,''), is_mgr = $6, is_sales = $7, is_tech = $8, active = $9
          where company_id = $1 and code = $2`,
        [req.companyId, base.code, name, o.email, o.phone, o.mgr, o.sales, o.tech, o.active]);
      await logEv(req.user!.id, req.user!.username, 'Employee updated', name, req.companyId);
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});

settings.post('/employees/:code/toggle', empCan, async (req: AuthedReq, res, next) => {
  try {
    await withTx(async (c) => {
      const base = (await c.query('select code, name, active from employees where company_id = $1 and code = $2', [req.companyId, req.params.code])).rows[0];
      if (!base) throw new ApiError(404, 'Employee not found.');
      await c.query('update employees set active = not active where company_id = $1 and code = $2', [req.companyId, base.code]);
      await logEv(req.user!.id, req.user!.username, `Employee ${base.active ? 'deactivated' : 'activated'}`, base.name, req.companyId);
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});

settings.delete('/employees/:code', empCan, async (req: AuthedReq, res, next) => {
  try {
    await withTx(async (c) => {
      const base = (await c.query(
        `select e.code, e.name,
                (select count(*)::int from contracts c where c.company_id = e.company_id and (c.mgr_code = e.code or c.sales_code = e.code)) as use
           from employees e where e.company_id = $1 and e.code = $2`, [req.companyId, req.params.code])).rows[0];
      if (!base) throw new ApiError(404, 'Employee not found.');
      if (base.use) throw new ApiError(409, `${base.name} is used on a contract and cannot be deleted. Deactivate instead.`);
      await c.query('delete from employees where company_id = $1 and code = $2', [req.companyId, base.code]);
      await logEv(req.user!.id, req.user!.username, 'Employee deleted', base.name, req.companyId);
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});
