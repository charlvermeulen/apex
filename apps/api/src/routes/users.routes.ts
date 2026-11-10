import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { q } from '../db.js';
import { hashPw, pwIssues } from '../scrypt.js';
import { ApiError, AuthedReq, logEv, requireAuth, requireAdmin, requireCan } from '../middleware.js';

export const users = Router();
users.use(requireAuth);

const USERNAME_RE = /^[a-z0-9._-]{3,30}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ['admin', 'accountant', 'bookkeeper', 'viewer'];

const userCols = 'id, name, username, email, role, status, must_change, failed_attempts, locked_until, last_login, access_overrides, created_at';

const genPassword = () => {
  const U = 'ABCDEFGHJKLMNPQRSTUVWXYZ', L = 'abcdefghijkmnpqrstuvwxyz', D = '23456789', S = '!@#$%&*?', all = U + L + D + S;
  const pick = (set: string, r: number) => set[r % set.length];
  const raw = randomBytes(12);
  const out = [pick(U, raw[0]), pick(L, raw[1]), pick(D, raw[2]), pick(S, raw[3])];
  for (let i = 4; i < 12; i++) out.push(pick(all, raw[i]));
  const sh = randomBytes(12);
  for (let i = out.length - 1; i > 0; i--) { const j = sh[i] % (i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out.join('');
};

const activeAdmins = async (excludeId?: string) => {
  const r = await q(`select count(*)::int as n from users where role = 'admin' and status = 'active' ${excludeId ? 'and id <> $1' : ''}`,
    excludeId ? [excludeId] : []);
  return r.rows[0].n;
};

// validateUser port (legacy 2601) — create
users.post('/', requireCan('settings', 'users'), async (req: AuthedReq, res, next) => {
  try {
    const b = z.object({
      name: z.string(), username: z.string(), email: z.string(), role: z.string(),
      pw: z.string(), status: z.string().optional(),
    }).parse(req.body);
    const name = b.name.trim();
    if (!name) throw new ApiError(400, 'Enter the full name.');
    if (!USERNAME_RE.test(b.username)) throw new ApiError(400, 'Username must be 3–30 characters: letters, numbers, . _ -');
    const others = (await q('select id, lower(username) as username, lower(email) as email from users')).rows;
    if (others.some((u: { username: string }) => u.username === b.username.toLowerCase()))
      throw new ApiError(409, 'That username is already in use.');
    if (!EMAIL_RE.test(b.email)) throw new ApiError(400, 'Enter a valid email address.');
    if (others.some((u: { email: string }) => u.email === b.email.toLowerCase()))
      throw new ApiError(409, 'That email is already in use.');
    if (!ROLES.includes(b.role)) throw new ApiError(400, 'Choose a role.');
    const i = pwIssues(b.pw, b.username);
    if (i.length) throw new ApiError(400, 'Password needs: ' + i.join(', ') + '.');
    const r = await q(`insert into users (name, username, email, role, password_hash, must_change, status)
      values ($1, $2, $3, $4, $5, true, coalesce($6, 'active')) returning ${userCols}`,
      [name, b.username.toLowerCase(), b.email, b.role, hashPw(b.pw), b.status === 'disabled' ? 'disabled' : 'active']);
    await logEv(req.user!.id, req.user!.username, 'User added', b.username + ' (' + b.role + ')');
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

users.get('/', requireCan('settings', 'users'), async (_req, res, next) => {
  try {
    res.json((await q(`select ${userCols} from users order by created_at`)).rows);
  } catch (e) { next(e); }
});

users.patch('/:id', requireCan('settings', 'users'), async (req: AuthedReq, res, next) => {
  try {
    const b = z.object({
      name: z.string().optional(), username: z.string().optional(), email: z.string().optional(),
      role: z.string().optional(), status: z.string().optional(), access_overrides: z.any().nullable().optional(),
    }).parse(req.body);
    const cur = (await q(`select ${userCols} from users where id = $1`, [req.params.id])).rows[0];
    if (!cur) throw new ApiError(404, 'User not found.');
    const nextRole = b.role ?? cur.role, nextStatus = b.status ?? cur.status;
    if (req.params.id === req.user!.id && (nextStatus !== 'active' || nextRole !== 'admin'))
      throw new ApiError(400, 'You cannot disable or demote your own account.');
    if (nextRole !== 'admin' && cur.role === 'admin' && (await activeAdmins(req.params.id as string)) < 1)
      throw new ApiError(400, 'There must always be at least one active administrator.');
    if (b.username !== undefined && b.username.toLowerCase() !== cur.username) {
      if (!USERNAME_RE.test(b.username)) throw new ApiError(400, 'Username must be 3–30 characters: letters, numbers, . _ -');
      const dup = (await q('select 1 from users where lower(username) = $1 and id <> $2', [b.username.toLowerCase(), cur.id])).rows[0];
      if (dup) throw new ApiError(409, 'That username is already in use.');
    }
    if (b.email !== undefined && b.email.toLowerCase() !== cur.email) {
      if (!EMAIL_RE.test(b.email)) throw new ApiError(400, 'Enter a valid email address.');
      const dup = (await q('select 1 from users where lower(email) = $1 and id <> $2', [b.email.toLowerCase(), cur.id])).rows[0];
      if (dup) throw new ApiError(409, 'That email is already in use.');
    }
    if (b.access_overrides !== undefined && nextRole === 'admin') throw new ApiError(400, 'Administrators always have full access.');
    const sets: string[] = [], params: unknown[] = [];
    const push = (col: string, v: unknown) => { sets.push(`${col} = $${params.length + 1}`); params.push(v); };
    if (b.name !== undefined) push('name', b.name.trim());
    if (b.username !== undefined) push('username', b.username.toLowerCase());
    if (b.email !== undefined) push('email', b.email);
    if (b.role !== undefined) push('role', b.role);
    if (b.status !== undefined) push('status', b.status);
    if (b.access_overrides !== undefined) push('access_overrides', b.access_overrides);
    const r = await q(`update users set ${sets.join(', ')} where id = $${params.length + 1} returning ${userCols}`,
      [...params, req.params.id]);
    await logEv(req.user!.id, req.user!.username, 'User updated', cur.username);
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

users.post('/:id/reset-password', requireCan('settings', 'users'), async (req: AuthedReq, res, next) => {
  try {
    const cur = (await q(`select ${userCols} from users where id = $1`, [req.params.id])).rows[0];
    if (!cur) throw new ApiError(404, 'User not found.');
    const temp = genPassword();
    await q('update users set password_hash = $2, must_change = true, failed_attempts = 0, locked_until = null where id = $1',
      [cur.id, hashPw(temp)]);
    await logEv(req.user!.id, req.user!.username, 'Password reset', cur.username);
    res.json({ temp }); // shown once by the admin UI
  } catch (e) { next(e); }
});

users.post('/:id/unlock', requireCan('settings', 'users'), async (req: AuthedReq, res, next) => {
  try {
    await q('update users set failed_attempts = 0, locked_until = null where id = $1', [req.params.id]);
    await logEv(req.user!.id, req.user!.username, 'Account unlocked', req.body?.username ?? '');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

users.delete('/:id', requireCan('settings', 'users'), async (req: AuthedReq, res, next) => {
  try {
    if (req.params.id === req.user!.id) throw new ApiError(400, 'You cannot delete your own account.');
    const cur = (await q(`select ${userCols} from users where id = $1`, [req.params.id])).rows[0];
    if (!cur) throw new ApiError(404, 'User not found.');
    if (cur.role === 'admin' && (await activeAdmins(cur.id)) < 1)
      throw new ApiError(400, 'There must always be at least one active administrator.');
    await q('delete from users where id = $1', [cur.id]);
    await logEv(req.user!.id, req.user!.username, 'User removed', cur.username);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// app config (idle timeout) — admin only
users.get('/config/:key', requireAdmin, async (req, res, next) => {
  try {
    const r = await q('select value from app_settings where key = $1', [req.params.key]);
    res.json(r.rows[0]?.value ?? null);
  } catch (e) { next(e); }
});

users.put('/config/:key', requireAdmin, async (req: AuthedReq, res, next) => {
  try {
    const v = z.any().parse(req.body);
    await q(`insert into app_settings (key, value) values ($1, $2)
      on conflict (key) do update set value = excluded.value`, [req.params.key, v]);
    await logEv(req.user!.id, req.user!.username, 'Setting updated', String(req.params.key));
    res.json({ ok: true });
  } catch (e) { next(e); }
});
