import type { Request, Response, NextFunction } from 'express';
import { q } from './db.js';
import { accOf, canSec as aclCanSec } from '@numera/shared';
import type { AccessMap, Role } from '@numera/shared';

export interface CtxUser {
  id: string;
  username: string;
  name: string;
  email: string;
  role: Role;
  status: string;
  must_change: boolean;
  overrides: AccessMap | null;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const logEv = async (
  userId: string | null, username: string, action: string, detail: string, companyId: string | null = null,
): Promise<void> => {
  try {
    await q('insert into activity_log (user_id, username, company_id, action, detail) values ($1,$2,$3,$4,$5)',
      [userId, username || '—', companyId, action, detail || '']);
  } catch { /* logging must never break a request */ }
};

export const idleTimeoutMinutes = async (): Promise<number> => {
  const r = await q(`select value from app_settings where key = 'idle_timeout_minutes'`);
  return Number(r.rows[0]?.value ?? 30);
};

export interface AuthedReq extends Request {
  user?: CtxUser;
  companyId?: string;
}

// requireAuth: cookie → session → active user → idle check → touch → attach ctx (plan §3).
export async function requireAuth(req: AuthedReq, res: Response, next: NextFunction) {
  try {
    const sid = req.cookies?.numera_sid as string | undefined;
    if (!sid) throw new ApiError(401, 'Signed out.');
    const s = await q(`select s.user_id, s.company_id, s.last_seen, u.name, u.username, u.email, u.role, u.status, u.must_change, u.access_overrides,
        extract(epoch from now() - s.last_seen) as idle_secs
      from sessions s join users u on u.id = s.user_id where s.id = $1`, [sid]);
    const row = s.rows[0];
    if (!row) throw new ApiError(401, 'Signed out.');
    if (row.status !== 'active') { throw new ApiError(401, 'Signed out.'); }
    const limit = await idleTimeoutMinutes();
    if (row.idle_secs > limit * 60) {
      await q('delete from sessions where id = $1', [sid]);
      throw new ApiError(401, `Signed out automatically after ${limit} minutes of inactivity.`);
    }
    await q('update sessions set last_seen = now() where id = $1', [sid]);
    req.user = {
      id: row.user_id, username: row.username, name: row.name, email: row.email,
      role: row.role, status: row.status, must_change: row.must_change, overrides: row.access_overrides ?? null,
    };
    req.companyId = row.company_id;
    next();
  } catch (e) { next(e); }
}

export const requireAdmin = (req: AuthedReq, res: Response, next: NextFunction) =>
  req.user?.role === 'admin' ? next() : next(new ApiError(403, 'You do not have access to this area.'));

// Exact canSec port (legacy 2541): admin bypass + per-user overrides.
export const requireCan = (mod: string, sec: string) =>
  (req: AuthedReq, res: Response, next: NextFunction) =>
    req.user && aclCanSec({ role: req.user.role, overrides: req.user.overrides }, mod, sec)
      ? next()
      : next(new ApiError(403, 'You do not have access to this area.'));

// convenience for reading
export const effAccess = (u: CtxUser) => accOf({ role: u.role, overrides: u.overrides });
