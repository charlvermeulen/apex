// one-off unlock helper (dev)
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.NEON_DATABASE_URL });
await c.connect();
const r = await c.query("update users set locked_until = null, failed_attempts = 0 where username = $1", [process.argv[2] || 'admin']);
console.log('unlocked', r.rowCount);
await c.end();
