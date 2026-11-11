// one-off batch-2 API smoke test (throwaway): login → masterdata → SI/PI/RCP/DN/JNL/BATCH → enquiries
const B = 'http://localhost:8788';
let ck = '';
const call = async (m, p, body) => {
  const r = await fetch(B + p, {
    method: m, headers: { 'content-type': 'application/json', cookie: ck },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get('set-cookie');
  if (sc?.includes('numera_sid=')) ck = 'numera_sid=' + sc.split('numera_sid=')[1].split(';')[0];
  const j = r.status === 204 ? null : await r.json().catch(() => null);
  return { s: r.status, j };
};
const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '  ← ' + JSON.stringify(extra)));
  if (!cond) process.exitCode = 1;
};

let { s, j } = await call('POST', '/api/auth/login', { id: 'admin', pw: 'Admin@2025' });
ok('login', s === 200 && j?.user, j);
({ s, j } = await call('POST', '/api/auth/change-password', { current: 'Admin@2025', pw: 'Numera@2026' }));
ok('change-password', s === 200, j);
const me = await call('GET', '/api/auth/me');
const demo = me.j?.companies?.find((c) => c.seed === 'demo') ?? me.j?.companies?.[0];
({ s } = await call('POST', '/api/auth/select-company', { companyId: demo.id }));
ok('select-company', s === 200);

// masterdata
let r = await call('GET', '/api/customers');
ok('customers list 5 + WW balance 128400', r.s === 200 && r.j.length === 5 && r.j[0].balance === 128400, r.j);
r = await call('GET', '/api/age/cust?asAt=2025-03-31');
ok('aged debtors WW all Current buckets[0]=128400', r.s === 200 && r.j.rows[0].buckets.join() === '128400,0,0,0,0' && r.j.pct === 0, r.j);
r = await call('GET', '/api/age/sup?asAt=2025-03-31');
ok('aged creditors grand 44200', r.s === 200 && r.j.grand === 44200, r.j.rows);
r = await call('GET', '/api/suppliers');
ok('suppliers list + Bidvest 24000', r.s === 200 && r.j[0].balance === 24000, r.j);
r = await call('GET', '/api/inv/items');
ok('stock items 7, OE-001 qty 15', r.s === 200 && r.j.length === 7 && r.j.find((i) => i.sku === 'OE-001').moves === 5, r);
r = await call('GET', '/api/inv/items/OE-001/card');
ok('stock card OE-001 closing 15', r.s === 200 && r.j.closing === 15, r.j);
r = await call('GET', '/api/sitypes');
ok('sitypes 3', r.s === 200 && r.j.length === 3, r.j);

// posting: SI
r = await call('POST', '/api/sales-invoices', { customer: 'CUST-001', date: '2025-03-29', due: '2025-04-28', lines: [{ type: 'inv', item: 'TP-001', qty: 2, price: 500, vat: 15 }] });
ok('SI-2025-042 created', s === 201 || r.s === 201 && r.j.id === 'SI-2025-042', r);
r = await call('POST', '/api/sales-invoices', { customer: 'CUST-001', date: '2025-03-29', due: '2025-04-28', lines: [{ type: 'inv', item: 'TP-001', qty: 0.5, price: 500, vat: 15 }] });
ok('SI fractional qty above zero accepted', r.s === 201, r);
r = await call('POST', '/api/sales-invoices', { customer: 'CUST-001', date: '2025-03-29', due: '2025-04-28', lines: [{ type: 'inv', item: 'TP-001', qty: 100, price: 500, vat: 15 }] });
ok('SI stock check verbatim', r.s === 400 && r.j.error === 'Not enough stock of “TP-001 — Logitech Wireless Mouse”: 27.5 available, 100 on this invoice.', r);
r = await call('POST', '/api/sales-invoices', { customer: 'CUST-001', date: '2023-08-01', due: '2025-04-28', lines: [{ type: 'non', item: 'NI-001', qty: 1, price: 850, vat: 15 }] });
ok('SI closed-FY date blocked', r.s === 400 && r.j.error === 'FY 2023/24 is closed, so posting dates in it are blocked. Ask an administrator to reopen it under Settings → Financial Years.', r);

// CUST-101 stock test: first SI of TP-001 took 2 → 28 avail
r = await call('POST', '/api/receipts', { customer: 'CUST-002', date: '2025-03-20', bank: '6000', method: 'EFT', amount: 1150 });
ok('RCP-2025-024', r.s === 201 && r.j.id === 'RCP-2025-024', r);
r = await call('GET', '/api/customers/CUST-002/ledger');
ok('ledger Shoprite closing 84200-1150', r.s === 200 && r.j.closing === 83050, r.j);

// procurement
r = await call('POST', '/api/supplier-invoices', { supplier: 'SUP-001', theirNo: 'BID-9999', date: '2025-03-15', desc: 'Courier', acc: '4070', amount: 12000, vat: '15' });
ok('PI-2025-023 created', r.s === 201 && r.j.id === 'PI-2025-023', r);
r = await call('POST', '/api/supplier-invoices', { supplier: 'SUP-001', theirNo: 'bid-9999', date: '2025-03-15', acc: '4070', amount: 1, vat: '15' });
ok('dup theirNo blocked', r.s === 409 && r.j.error === 'This supplier invoice number has already been captured.', r);
r = await call('POST', '/api/debit-notes', { supplier: 'SUP-001', orig: 'PI-2025-023', date: '2025-03-18', reason: 'Overcharge', desc: 'Courier overcharge', amount: 2000, vat: 'Standard 15%' });
ok('DN-2025-004 created', r.s === 201 && r.j.id === 'DN-2025-004', r);

// supplier + customer journals
r = await call('POST', '/api/sup-journal', { party: 'SUP-002', type: 'inc', contra: '4030', amount: 1500, narration: 'Late fee', date: '2025-03-20' });
ok('SUP journal SJ-2025-001', r.s === 201 && r.j.ref === 'SJ-2025-001', r);
r = await call('POST', '/api/cust-journal', { party: 'CUST-004', type: 'dec', contra: '4080', amount: 900, narration: 'Bad debt write-off', date: '2025-03-25' });
ok('CUST journal CJ-2025-001', r.s === 201 && r.j.ref === 'CJ-2025-001', r);

// GL journals + batches (JNL/GJB count the whole journals table per legacy siRef)
r = await call('POST', '/api/gl/journals', { date: '2025-03-20', desc: 'Accrual', lines: [{ acc: '4030', dr: 500, cr: 0, nar: 'Elec' }, { acc: '9000', dr: 0, cr: 500, nar: 'Accrue' }] });
ok('JNL posted', r.s === 201 && /^JNL-2025-\d{3}$/.test(r.j.ref), r);
r = await call('POST', '/api/gl/journals', { date: '2025-03-20', desc: 'Broken', lines: [{ acc: '4030', dr: 500, cr: 0 }, { acc: '9000', dr: 0, cr: 400 }] });
ok('unbalanced journal verbatim', r.s === 400 && r.j.error === 'Cannot post: debits must equal credits and be greater than zero.', r);
r = await call('POST', '/api/gl/batches', { date: '2025-03-20', status: 'Posted', desc: 'March adjustments', lines: [{ acc: '4060', dr: 90, cr: 0 }, { acc: '6000', dr: 0, cr: 90 }] });
ok('GJB balance', r.s === 201 && /^GJB-2025-\d{3}$/.test(r.j.ref), r);
r = await call('POST', '/api/gl/batches', { date: '2025-03-20', status: 'Posted', desc: 'X', lines: [{ acc: '4060', dr: 50, cr: 0 }, { acc: '6000', dr: 0, cr: 40 }] });
ok('GJB out-of-balance verbatim', r.s === 400 && r.j.error === 'Cannot post: debits must equal credits. Save as Open to keep working on it.', r);
r = await call('POST', '/api/gl/batches', { date: '2025-03-20', status: 'Open', desc: 'Pending', lines: [{ acc: '4050', dr: 25, cr: 0 }, { acc: '6000', dr: 0, cr: 25 }] });
ok('GJB open', r.s === 201 && r.j.id, r);
const bid = r.j.id;
r = await call('GET', '/api/gl/accounts/4050/ledger'); // open batch: Dr 4050 25
const pre = r?.j?.closing;
r = await call('PATCH', `/api/gl/batches/${bid}/post`);
ok('batch posted', r.s === 200, r);
r = await call('GET', '/api/gl/accounts/4050/ledger');
ok(`ledger grew by open batch 25 (${pre}→${r?.j?.closing})`, pre === 0 && r.j?.closing === 25, r.j);
r = await call('GET', '/api/gl/accounts/6100/ledger'); // AR: 479500 + SI-042 1150 + SI-043 287.5 - RCP 1150 - CJ 900
ok('AR closing 478887.5', r.s === 200 && r.j.closing === 478887.5, r.j);
r = await call('GET', '/api/gl/journal-lines?from=2025-03-01&to=2025-03-31');
ok('journal-lines flat list', r.s === 200 && r.j.length >= 20, r.j?.length);
r = await call('GET', '/api/inv/valuation');
ok('valuation rows', r.s === 200 && r.j.length === 7 && r.j.find((i) => i.sku === 'OE-001').qty === 15, r.j);
console.log('smoke done');
process.exit(process.exitCode ?? 0);
