import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ApiError } from './middleware.js';

// AES-256-GCM for the SMTP password at rest (plan §0). Format: iv:tag:ciphertext, hex.
const key = () => {
  const k = process.env.SMTP_ENC_KEY;
  if (!k || !/^[0-9a-f]{64}$/i.test(k)) throw new ApiError(500, 'SMTP_ENC_KEY missing or invalid (needs 64 hex chars).');
  return createHash('sha256').update(k).digest();
};

export const encrypt = (plain: string): string => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv.toString('hex'), c.getAuthTag().toString('hex'), ct.toString('hex')].join(':');
};

export const decrypt = (blob: string): string => {
  const [iv, tag, ct] = blob.split(':');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'hex'));
  d.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(ct, 'hex')), d.final()]).toString('utf8');
};
