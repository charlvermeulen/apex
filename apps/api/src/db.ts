import pg from 'pg';

// DATE (1082) as plain 'YYYY-MM-DD' string — pg's default local-midnight Date object shifts across timezones.
pg.types.setTypeParser(1082, (v) => v);
// NUMERIC (1700) keep as string (we Number() at the edges).

const url = process.env.NEON_DATABASE_URL;
if (!url) { console.error('NEON_DATABASE_URL not set — see apps/api/.env'); process.exit(1); }

// ponytail: single pooled client; add read replica pooling only if Neon tells us to
export const db = new pg.Pool({ connectionString: url, max: 5 });
export const q = (text: string, params: unknown[] = []) => db.query(text, params);
