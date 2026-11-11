import { q } from './db.js';
import { ApiError, type AuthedReq } from './middleware.js';

export type Client = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

// Transaction wrapper: fn receives a pg client with the tx open.
export const withTx = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
  const c = await import('./db.js').then((m) => m.db.connect());
  try {
    await c.query('begin');
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
};

export const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const MONS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// legacy stkDate 5364 — ledger display date '05 Mar 2025'
export const stkDate = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d} ${MONS[+m - 1]} ${y}`;
};
// legacy fmtD(v, 1) 2175 — error strings '5 Mar 2025'
export const fmtD = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number) as [string, number, number];
  const s = `${d} ${MONS[m - 1]}`;
  return y ? `${s} ${y}` : s;
};

export interface JournalLine { acc: string; dr: number; cr: number; desc?: string }

// Port of glJournalBase's add() (5536): zero lines dropped, journal + lines inserted.
export const postJournal = async (
  c: Client,
  p: { companyId: string; fyId: string | null; date: string; ref: string; src: string; srcType: string; srcId: string; desc: string; userId: string | null; lines: JournalLine[] },
): Promise<string> => {
  const lines = p.lines.filter((l) => l.dr || l.cr);
  if (!lines.length) throw new ApiError(400, 'The journal has no lines to post.');
  const jr = await c.query(
    `insert into journals (company_id, fy_id, journal_date, ref, src, src_type, src_id, description, posted_by, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Posted') returning id`,
    [p.companyId, p.fyId, p.date, p.ref, p.src, p.srcType, p.srcId, p.desc, p.userId],
  );
  const id = jr.rows[0].id as string;
  let seq = 0;
  for (const l of lines) {
    seq++;
    await c.query(
      `insert into journal_lines (journal_id, company_id, seq, account_code, description, debit, credit)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [id, p.companyId, seq, l.acc, l.desc ?? null, r2(l.dr), r2(l.cr)],
    );
  }
  return id;
};

// Port of checkPostingDate (legacy 2791–2799) — VAT-period check lands with batch 6.
export const checkPostingDate = async (c: Client, companyId: string, iso: string): Promise<string> => {
  if (!iso) return 'Enter a posting date.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return 'Enter a posting date.';
  const fys = (await c.query('select id, name, start, end_date as "end", status from financial_years where company_id = $1 order by start', [companyId])).rows;
  const fy = fys.find((f: any) => iso >= f.start && iso <= f.end);
  if (!fy) return `No financial year exists for ${fmtD(iso)}. Add one under Settings → Financial Years.`;
  if (fy.status !== 'open')
    return `${fy.name} is closed, so posting dates in it are blocked. Ask an administrator to reopen it under Settings → Financial Years.`;
  return '';
};

// Count-based numbering, port of siRef (5415) / siNextRef (5118):
// seq = offset + row count, advancing on collision.
export const nextDocRef = async (
  c: Client, companyId: string, table: string, prefix: string, offset: number, idCol: 'id' | 'code' | 'ref' = 'id',
): Promise<string> => {
  let n = (await c.query(`select count(*)::int as n from ${table} where company_id = $1`, [companyId])).rows[0].n;
  for (;;) {
    const ref = `${prefix}-${String(offset + n).padStart(3, '0')}`;
    const dup = (await c.query(`select 1 as x from ${table} where company_id = $1 and ${idCol} = $2`, [companyId, ref])).rows.length;
    if (!dup) return ref;
    n++;
  }
};
