// Minimal migration runner: applies migrations/*.sql in order inside a transaction,
// guarded by schema_migrations(name primary key, checksum) so edits to applied files fail loudly.
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';

const dir = path.resolve('migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

const url = process.env.NEON_DATABASE_URL;
if (!url) { console.error('NEON_DATABASE_URL not set'); process.exit(1); }

const db = new pg.Client({ connectionString: url });
await db.connect();

await db.query(`create table if not exists schema_migrations (
  name text primary key, checksum text not null, applied_at timestamptz not null default now())`);

const applied = new Map(
  (await db.query('select name, checksum from schema_migrations')).rows.map((r) => [r.name, r.checksum]),
);

for (const f of files) {
  const sql = readFileSync(path.join(dir, f), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  if (applied.has(f)) {
    if (applied.get(f) !== checksum) {
      console.error(`Migration ${f} was applied but the file changed. Never edit a migration — add a new one.`);
      process.exit(1);
    }
    continue;
  }
  await db.query('begin');
  try {
    await db.query(sql);
    await db.query('insert into schema_migrations (name, checksum) values ($1, $2)', [f, checksum]);
    await db.query('commit');
    console.log('applied', f);
  } catch (e) {
    await db.query('rollback');
    console.error('FAILED', f, e.message);
    process.exit(1);
  }
}

await db.end();
console.log('done');
