import express from 'express';
import cookieParser from 'cookie-parser';
import { ZodError } from 'zod';
import pg from 'pg';
import { auth } from './routes/auth.routes.js';
import { users } from './routes/users.routes.js';
import { companies } from './routes/companies.routes.js';
import { fys } from './routes/fys.routes.js';
import { accounts } from './routes/accounts.routes.js';
import { settings } from './routes/settings.routes.js';
import { misc } from './routes/misc.routes.js';
import { parties } from './routes/parties.routes.js';
import { sales } from './routes/sales.routes.js';
import { purchases } from './routes/purchases.routes.js';
import { inventory } from './routes/inventory.routes.js';
import { gl } from './routes/gl.routes.js';
import { assets } from './routes/assets.routes.js';
import { contracts } from './routes/contracts.routes.js';
import { billing } from './routes/billing.routes.js';
import { service } from './routes/service.routes.js';
import { ApiError, AuthedReq } from './middleware.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));   // logo uploads are small dataURIs
app.use(cookieParser());

app.use('/api/auth', auth);
app.use('/api/users', users);
app.use('/api/companies', companies);
app.use('/api/fys', fys);
app.use('/api/accounts', accounts);
app.use('/api/settings', settings);
app.use('/api', misc);
app.use('/api', parties);
app.use('/api', sales);
app.use('/api', purchases);
app.use('/api', inventory);
app.use('/api/gl', gl);
app.use('/api', assets);
app.use('/api', contracts);
app.use('/api', billing);
app.use('/api', service);

// errors: {error} shape, 500 never leaks SQL
app.use((err: unknown, _req: AuthedReq, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ApiError) return res.status(err.status).json({ error: err.message });
  if (err instanceof ZodError) return res.status(400).json({ error: 'The request could not be understood.' });
  if (err instanceof pg.DatabaseError && err.code) {
    if (err.code === '23505' || err.code === '23502') return res.status(409).json({ error: 'That value conflicts with something already saved.' });
    if (err.code === '23503') { console.error(23503, err.detail ?? err.message, err.constraint); return res.status(409).json({ error: 'That record is still linked somewhere and cannot be changed or removed.' }); }
    console.error(err.code, err.detail ?? err.message);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const port = Number(process.env.PORT) || 8788;
app.listen(port, () => console.log(`numera api on :${port}`));
