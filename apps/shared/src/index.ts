// Ported verbatim from legacy/Numera.html:2524–2541 (ROLES, ACCESS, MODS, SECN, accOf/canSec).
export type Role = 'admin' | 'accountant' | 'bookkeeper' | 'viewer';

export const ROLES: Record<Role, { label: string; chip: string; desc: string }> = {
  admin: { label: 'Administrator', chip: 'c-wn', desc: 'Full access to everything, including user management and security settings.' },
  accountant: { label: 'Accountant', chip: 'c-bl', desc: 'Full access to accounting, tax and reports. Can edit company settings and add or close financial years, but cannot manage users or reopen a closed year.' },
  bookkeeper: { label: 'Bookkeeper', chip: 'c-ok', desc: 'Captures day-to-day transactions for customers, suppliers, inventory, banking and GL journals. No tax returns, financial reports or settings.' },
  viewer: { label: 'Viewer', chip: 'c-gr', desc: 'Read-only: dashboard, enquiries and reports. Cannot capture or change data.' },
};

export type AccessMap = Record<string, string>;
export const ACCESS: Record<Role, AccessMap> = {
  admin: { procurement: '*', dashboard: '*', customers: '*', suppliers: '*', gl: '*', inventory: '*', banking: '*', assets: '*', service: '*', contracts: '*', cbilling: '*', vat: '*', paye: '*', taxcal: '*', reports: '*', settings: '*' },
  accountant: { procurement: '*', dashboard: '*', customers: '*', suppliers: '*', gl: '*', inventory: '*', banking: '*', assets: '*', service: '*', contracts: '*', cbilling: '*', vat: '*', paye: '*', taxcal: '*', reports: '*', settings: 'company,years,ctypes,sitypes,svctypes,employees,email' },
  bookkeeper: { procurement: '*', dashboard: '*', customers: 'maint,trans,enq', suppliers: 'maint,trans,enq', gl: 'trans,enq', inventory: 'maint,trans,enq', banking: '*', assets: '*', service: '*', contracts: '*', cbilling: '*', taxcal: '*' },
  viewer: { dashboard: '*', customers: 'enq,rep', suppliers: 'enq,rep', gl: 'enq,rep', inventory: 'enq,rep', assets: '*', service: '*', contracts: '*', cbilling: '*', taxcal: '*', reports: '*' },
};

export const MODS: [string, string][] = [
  ['dashboard', 'Dashboard'], ['customers', 'Customers'], ['suppliers', 'Suppliers'], ['gl', 'General Ledger'],
  ['inventory', 'Inventory'], ['procurement', 'Procurement'], ['banking', 'Banking'], ['assets', 'Assets / Equipment'],
  ['service', 'Service'], ['contracts', 'Contract Management'], ['cbilling', 'Contract Billing'], ['vat', 'VAT Returns'],
  ['paye', 'PAYE / Payroll'], ['taxcal', 'Tax Calendar'], ['reports', 'Reports & Budgets'], ['settings', 'Settings'],
];

export const SECN: Record<string, string> = {
  maint: 'Maintenance', trans: 'Transactions', enq: 'Enquiries', rep: 'Reports',
  company: 'Company & Tax', users: 'Users', roles: 'Roles & Permissions', log: 'Activity Log',
  years: 'Financial Years', ctypes: 'Contract Types', sitypes: 'Sales Item Types', svctypes: 'Service Call Types',
  employees: 'Employees', companies: 'Companies', email: 'Email (SMTP)',
};

// Sections available per module (legacy 4970) — used by the Roles permissions matrix.
export const MODSEC: Record<string, string[]> = {
  customers: ['maint', 'trans', 'enq', 'rep'], suppliers: ['maint', 'trans', 'enq', 'rep'],
  gl: ['maint', 'trans', 'enq', 'rep'], inventory: ['maint', 'trans', 'enq', 'rep'],
  settings: ['company', 'years', 'employees', 'email', 'ctypes', 'users', 'roles', 'log', 'companies', 'sitypes', 'svctypes'],
};

export interface UserAccess {
  role: Role;
  overrides?: AccessMap | null; // legacy u.acc: {module: '*' | csv}
}

export const accOf = (u: UserAccess | null): AccessMap =>
  !u ? {} : (u.role === 'admin' ? ACCESS.admin : (u.overrides || ACCESS[u.role] || {}));

export const canMod = (u: UserAccess | null, m: string): boolean => !!accOf(u)[m];

export const canSec = (u: UserAccess | null, m: string, sec: string): boolean => {
  const a = accOf(u)[m];
  return !!a && (a === '*' || a.split(',').includes(sec));
};

// COA groups/types — ported from legacy/Numera.html:4629–4642.
export const COA_SYS = ['6000', '6010', '6100', '6200', '6210', '5020', '6300', '5000', '5010', '9000', '9100', '7010', '1000', '2000', '4020'];

export interface CoaGroup { name: string; sec: 'Income' | 'Expenses' | 'Assets' | 'Equity' | 'Liabilities'; types: string[]; }
export const COA_GROUPS: CoaGroup[] = [
  { name: 'Sales', sec: 'Income', types: ['Income'] },
  { name: 'Cost of Sales', sec: 'Expenses', types: ['Cost of Sales', 'Expense'] },
  { name: 'Other Income', sec: 'Income', types: ['Other Income', 'Income'] },
  { name: 'Overheads', sec: 'Expenses', types: ['Expense'] },
  { name: 'Non-Current Assets', sec: 'Assets', types: ['Fixed Asset', 'Contra Asset', 'Non-Current Asset'] },
  { name: 'Current Assets', sec: 'Assets', types: ['Bank', 'Current Asset', 'Tax Asset'] },
  { name: 'Equity', sec: 'Equity', types: ['Equity'] },
  { name: 'Non-Current Liabilities', sec: 'Liabilities', types: ['Long-term Liability'] },
  { name: 'Current Liabilities', sec: 'Liabilities', types: ['Current Liability', 'Tax Liability'] },
];

export const coaGroup = (code: string): CoaGroup | null =>
  /^\d{4}$/.test(String(code)) ? COA_GROUPS[+String(code)[0] - 1] : null;

// 1000–4999 income statement, 5000–9999 balance sheet
export const isIS = (code: string): boolean => String(code) < '5000';

export const COA_TYPES = COA_GROUPS.map((g) => g.types);
