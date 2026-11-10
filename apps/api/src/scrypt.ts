import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const N = 16384, R = 8, P = 1;

export function hashPw(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 32, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPw(pw: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const expect = Buffer.from(hash, 'hex');
  const got = scryptSync(pw, Buffer.from(salt, 'hex'), expect.length, { N: +n, r: +r, p: +p });
  return timingSafeEqual(expect, got);
}

// Legacy pwIssues port (Numera.html:2562) — returns list of unmet requirements.
export function pwIssues(pw: string, username?: string): string[] {
  const i: string[] = [];
  pw = pw || '';
  if (pw.length < 8) i.push('at least 8 characters');
  if (!/[a-z]/.test(pw)) i.push('a lowercase letter');
  if (!/[A-Z]/.test(pw)) i.push('an uppercase letter');
  if (!/\d/.test(pw)) i.push('a number');
  if (!/[^A-Za-z0-9]/.test(pw)) i.push('a symbol');
  if (username && username.length >= 3 && pw.toLowerCase().includes(username.toLowerCase())) i.push('no part of the username');
  return i;
}
