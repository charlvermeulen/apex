// ZAR formatting + legacy display dates (Numera.html fmtR 2169 / stkDate 5364).
export const fmtR = (v: number): string => {
  const n = Number(v) || 0, a = Math.abs(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? '(R ' + a + ')' : 'R ' + a;
};
// bare number with thousands (totals rows, buckets)
export const fmtN = (v: number): string => (Number(v) || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// '05 Mar 2025' — stkDate
export const stkDate = (iso: string): string => {
  const [y, m, d] = (iso || '').split('-');
  return d ? `${d} ${MONS[+m - 1]} ${y}` : '';
};
// '05 Mar' — table list dates (fmtD(v,1))
export const dayMon = (iso: string): string => {
  const [, m, d] = (iso || '').split('-');
  return d ? `${d} ${MONS[+m - 1]}` : '';
};

// legacy today (no TZ surprises): local calendar date as YYYY-MM-DD
export const todayIso = (): string => {
  const d = new Date(), p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// legacy fmtD (2165): y truthy → '5 Mar 2025', else '05 Mar'
export const fmtD = (iso: string, y?: boolean | number): string => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-GB', y ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: '2-digit', month: 'short' });
};
// '05/03/2025' — invoice print dates (fmtDMY)
export const fmtDMY = (iso: string): string => {
  const [y, m, d] = (iso || '').split('-');
  return y ? `${d}/${m}/${y}` : '';
};
