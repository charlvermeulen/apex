import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { q } from '../db.js';
import { verifyPw, hashPw, pwIssues } from '../scrypt.js';
import { ApiError, AuthedReq, logEv, effAccess, requireAuth } from '../middleware.js';

export const auth = Router();

const COOKIE = 'numera_sid';
const MAX_FAILS = 5, LOCK_MIN = 5; // legacy 2508

// legacy userCos 2523: no access rows = all companies (any role); rows restrict.
const companiesFor = async (user: { id: string; role: string }) => {
  const rows = (await q(`select c.id, c.name, c.seed, c.created_at from companies c
    join user_company_access a on a.company_id = c.id where a.user_id = $1 order by c.created_at`, [user.id])).rows;
  if (user.role === 'admin' || !rows.length)
    return (await q('select id, name, seed, created_at from companies order by created_at')).rows;
  return rows;
};

const publicUser = (u: Record<string, unknown>) => ({
  id: u.id, name: u.name, username: u.username, email: u.email, role: u.role,
  status: u.status, must_change: u.must_change,
});

const startSession = (res: unknown, id: string) => {
  const r = res as import('express').Response;
  r.cookie(COOKIE, id, {
    httpOnly: true, sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 1000 * 60 * 60 * 12, // hard cap; idle timeout enforced by requireAuth
  });
};

// authenticate port (legacy 2588–2599): username OR email, fake verify for timing, fail counter, lock.
auth.post('/login', async (req, res, next) => {
  try {
    const body = z.object({ id: z.string(), pw: z.string() }).parse(req.body);
    const id = body.id.trim().toLowerCase();
    if (!id || !body.pw) throw new ApiError(400, 'Enter your username and password.');
    const u = (await q('select * from users where lower(username) = $1 or lower(email) = $1', [id])).rows[0];

    if (u && u.locked_until && new Date(u.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(u.locked_until).getTime() - Date.now()) / 60000);
      throw new ApiError(401, `Account locked after too many failed attempts. Try again in ${mins} minute(s), or ask an administrator to unlock it.`);
    }
    const ok = u ? verifyPw(body.pw, u.password_hash) : verifyPw(body.pw, hashPw(body.pw)); // fake hash when unknown: constant-ish timing
    if (!u || !ok) {
      if (u) {
        const failed = (u.failed_attempts || 0) + 1;
        if (failed >= MAX_FAILS) {
          await q('update users set failed_attempts = 0, locked_until = now() + interval \'' + LOCK_MIN + ' minutes\' where id = $1', [u.id]);
          await logEv(null, '—', 'Account locked', 'Too many failed sign-in attempts', null);
          await logEv(u.id, u.username, 'Account locked', 'Too many failed sign-in attempts');
        } else {
          await q('update users set failed_attempts = $2 where id = $1', [u.id, failed]);
        }
      }
      await logEv(null, '—', 'Failed sign-in', 'Username: ' + id);
      throw new ApiError(401, 'Invalid username or password.');
    }
    if (u.status !== 'active') {
      await logEv(u.id, u.username, 'Blocked sign-in', 'Disabled account');
      throw new ApiError(403, 'This account is disabled. Contact your administrator.');
    }
    await q('update users set failed_attempts = 0, locked_until = null, last_login = now() where id = $1', [u.id]);
    const sid = randomBytes(32).toString('hex');
    await q('insert into sessions (id, user_id) values ($1, $2)', [sid, u.id]);
    startSession(res, sid);
    await logEv(u.id, u.username, 'Signed in', '');
    res.json({ user: publicUser(u), companies: await companiesFor(u), must_change: u.must_change, access: effAccess(u) });
  } catch (e) { next(e); }
});

const companyCols = 'c.id, c.name, c.seed, c.fy_start, c.reg, c.vat_no, c.created_at';

// legacy proceedAfterAuth: pick a company when only one is available
auth.get('/me', requireAuth, async (req: AuthedReq, res, next) => {
  try {
    const u = req.user!;
    const companies = await companiesFor(u);
    let company = null;
    if (req.companyId) {
      company = (await q(`select ${companyCols.replace(/c\./g, 'c.')} from companies c where c.id = $1`, [req.companyId])).rows[0] ?? null;
    }
    res.json({
      user: publicUser({ ...u, must_change: u.must_change }),
      access: effAccess(u),
      companies,
      company,
    });
  } catch (e) { next(e); }
});

auth.post('/select-company', requireAuth, async (req: AuthedReq, res, next) => {
  try {
    const body = z.object({ companyId: z.string().uuid() }).parse(req.body);
    const allowed = await companiesFor(req.user!);
    if (!allowed.some((c: { id: string }) => c.id === body.companyId))
      throw new ApiError(403, 'You do not have access to this company.');
    await q('update sessions set company_id = $2 where id = $1', [req.cookies[COOKIE], body.companyId]);
    const company = (await q(`select ${companyCols} from companies c where c.id = $1`, [body.companyId])).rows[0];
    await logEv(req.user!.id, req.user!.username, 'Switched company', company.name, body.companyId);
    res.json({ company });
  } catch (e) { next(e); }
});

auth.post('/logout', async (req: AuthedReq, res, next) => {
  try {
    await q('delete from sessions where id = $1', [req.cookies[COOKIE] || '']);
    res.clearCookie(COOKIE);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

auth.post('/change-password', requireAuth, async (req: AuthedReq, res, next) => {
  try {
    const body = z.object({ current: z.string(), pw: z.string() }).parse(req.body);
    const u = (await q('select * from users where id = $1', [req.user!.id])).rows[0];
    if (!verifyPw(body.current, u.password_hash)) throw new ApiError(400, 'Your current password is not correct.');
    const issues = pwIssues(body.pw, u.username);
    if (issues.length) throw new ApiError(400, 'Password needs: ' + issues.join(', ') + '.');
    await q('update users set password_hash = $2, must_change = false where id = $1', [u.id, hashPw(body.pw)]);
    await logEv(u.id, u.username, 'Password changed', '');
    res.json({ ok: true });
  } catch (e) { next(e); }
});
