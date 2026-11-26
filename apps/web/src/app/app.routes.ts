import { Routes } from '@angular/router';
import { authGuard, canSecGuard } from './core/guards';
import { ModTabsComponent, type ModTab } from './core/mod-tabs';
import { LoginComponent } from './pages/login.component';
import { CompanyPickerComponent } from './pages/company-picker.component';
import { ChangePasswordComponent } from './pages/change-password.component';
import { ShellComponent } from './pages/shell.component';
import { DashboardComponent } from './pages/dashboard.component';
import { GlCoaComponent } from './pages/gl/gl-coa.component';
import { GlJnlComponent, GlJbatchComponent, GlEnqComponent, GlJenqComponent } from './pages/gl/gl.pages';
import {
  CustListComponent, CustAddComponent,
} from './pages/customers/customers.pages';
import { CustSiComponent, CustCnComponent, CustRcptComponent, CustJnlComponent, CustEnqComponent, AgedComponent } from './pages/customers/customers-trans.pages';
import { SupListComponent, SupAddComponent, SupJnlComponent, SupEnqComponent } from './pages/suppliers/suppliers.pages';
import { ProcurementComponent, PiComponent, DnComponent, PoComponent, GrnComponent } from './pages/procurement/procurement.pages';
import { InvItemsComponent, InvCatsComponent, InvItemAddComponent, InvCardComponent, InvValComponent, InvPreqComponent, InvPretComponent } from './pages/inventory/inventory.pages';
import { AssetsRegisterComponent, AssetFormComponent, AssetsSvcComponent, AssetsDepComponent, AssetsBBComponent, AssetsCvComponent } from './pages/assets/assets.pages';
import { ContractsListComponent, ContractFormComponent } from './pages/contracts/contracts.pages';
import { CbRunComponent, CbMetersComponent, CbPeriodsComponent, CbEscComponent, CbHistComponent, CustCinvComponent } from './pages/billing/billing.pages';
import { SvCallsComponent, SvReqsComponent, SvWoComponent, SvWipComponent, SvSlaComponent } from './pages/service/service.pages';
import { VatComponent } from './pages/vat/vat.pages';
import { ReportsComponent } from './pages/reports/reports.pages';
import {
  SettingsComponent, CompanyTaxComponent, YearsComponent, CompaniesTabComponent,
  UsersComponent, RolesComponent, EmailComponent, LogComponent, SitypesComponent,
  CtypesComponent, EmployeesComponent, SvctypesComponent,
} from './pages/settings/settings.pages';

// Per-module tab maps: {label, child path suffix, sec, ready?}
const custTabs: ModTab[] = [
  { label: 'Customer List', path: '/customers/list', sec: 'maint', icon: 'ti-users' },
  { label: 'Add Customer', path: '/customers/add', sec: 'maint', icon: 'ti-user-plus' },
  { label: 'Sales Invoices', path: '/customers/inv', sec: 'trans', icon: 'ti-file-invoice' },
  { label: 'Credit Notes', path: '/customers/cn', sec: 'trans', icon: 'ti-file-minus' },
  { label: 'Receipts', path: '/customers/rcpt', sec: 'trans', icon: 'ti-cash' },
  { label: 'Customer Journals', path: '/customers/jnl', sec: 'trans', icon: 'ti-book' },
  { label: 'Account Enquiry', path: '/customers/enq', sec: 'enq', icon: 'ti-zoom-money' },
  { label: 'Aged Debtors', path: '/customers/aged', sec: 'enq', icon: 'ti-clock-hour-4' },
  { label: 'Contract Invoices', path: '/customers/cinvc', sec: 'trans', icon: 'ti-file-certificate' },
];
const supTabs: ModTab[] = [
  { label: 'Supplier List', path: '/suppliers/list', sec: 'maint', icon: 'ti-truck' },
  { label: 'Add Supplier', path: '/suppliers/add', sec: 'maint', icon: 'ti-truck' },
  { label: 'Supplier Journals', path: '/suppliers/jnl', sec: 'trans', icon: 'ti-book' },
  { label: 'Account Enquiry', path: '/suppliers/enq', sec: 'enq', icon: 'ti-zoom-money' },
  { label: 'Aged Creditors', path: '/suppliers/aged', sec: 'enq', icon: 'ti-clock-hour-4' },
];
const invTabs: ModTab[] = [
  { label: 'Inventory Items', path: '/inventory/items', sec: 'maint', icon: 'ti-box' },
  { label: 'Categories', path: '/inventory/cats', sec: 'maint', icon: 'ti-folders' },
  { label: 'Add Item', path: '/inventory/add', sec: 'maint', icon: 'ti-plus' },
  { label: 'Part Requests', path: '/inventory/preq', sec: 'trans', icon: 'ti-package-export' },
  { label: 'Part Returns', path: '/inventory/pret', sec: 'trans', icon: 'ti-package-import' },
  { label: 'Item Enquiry', path: '/inventory/card', sec: 'enq', icon: 'ti-search' },
  { label: 'Stock Valuation', path: '/inventory/valuation', sec: 'enq', icon: 'ti-chart-pie' },
];
const glTabs: ModTab[] = [
  { label: 'Chart of Accounts', path: '/gl/coa', sec: 'maint', icon: 'ti-books' },
  { label: 'General Journal', path: '/gl/jnl', sec: 'trans', icon: 'ti-book' },
  { label: 'New Journal Entry', path: '/gl/jnl/new', sec: 'trans', icon: 'ti-plus' },
  { label: 'Journal Batches', path: '/gl/jbatch', sec: 'trans', icon: 'ti-books' },
  { label: 'Account Enquiry', path: '/gl/enq', sec: 'enq', icon: 'ti-zoom-money' },
  { label: 'Journal Enquiry', path: '/gl/jenq', sec: 'enq', icon: 'ti-list' },
];
const assetTabs: ModTab[] = [
  { label: 'Asset Register', path: '/assets/register', sec: 'maint', icon: 'ti-box-several' },
  { label: 'Maintenance & Service', path: '/assets/svc', sec: 'maint', icon: 'ti-tool', ready: true },
  { label: 'Depreciation', path: '/assets/dep', sec: 'maint', icon: 'ti-arrow-down-right', ready: true },
  { label: 'Buy-Backs', path: '/assets/buybacks', sec: 'maint', icon: 'ti-arrow-back-up', ready: true },
  { label: 'Conversions', path: '/assets/conversions', sec: 'maint', icon: 'ti-transform', ready: true },
];
const conTabs: ModTab[] = [
  { label: 'Contracts', path: '/contracts/list', sec: 'maint', icon: 'ti-file-text' },
  { label: 'Add Contract', path: '/contracts/add', sec: 'maint', icon: 'ti-plus' },
];
const billTabs: ModTab[] = [
  { label: 'Billing Run', path: '/cbilling/run', sec: 'trans', icon: 'ti-receipt' },
  { label: 'Meter Usage', path: '/cbilling/meters', sec: 'trans', icon: 'ti-gauge' },
  { label: 'Billing Periods', path: '/cbilling/periods', sec: 'trans', icon: 'ti-calendar' },
  { label: 'Escalation', path: '/cbilling/escalate', sec: 'trans', icon: 'ti-trending-up' },
  { label: 'Billing History', path: '/cbilling/hist', sec: 'enq', icon: 'ti-history' },
];
const svcTabs: ModTab[] = [
  { label: 'Service Calls', path: '/service/calls', sec: 'trans', icon: 'ti-headset' },
  { label: 'Call Requests', path: '/service/reqs', sec: 'trans', icon: 'ti-message-2' },
  { label: 'Work Orders', path: '/service/wo', sec: 'trans', icon: 'ti-clipboard-list' },
  { label: 'Work In Progress', path: '/service/wip', sec: 'enq', icon: 'ti-progress' },
  { label: 'Call SLA', path: '/service/sla', sec: 'enq', icon: 'ti-stopwatch' },
];
// legacy VAT module is section-less — all tabs sit in one flat bar (sec 'maint' keeps ModTabs single-section)
const vatTabs: ModTab[] = [
  { label: 'Dashboard', path: '/vat/dash', sec: 'maint', icon: 'ti-dashboard' },
  { label: 'Detail', path: '/vat/detail', sec: 'maint', icon: 'ti-list-details' },
  { label: 'VAT Periods', path: '/vat/periods', sec: 'maint', icon: 'ti-calendar' },
];

// legacy reports groups (REP_GROUP 1890) drive the section bar; Tax Computation arrives with PAYE
const repTabs: ModTab[] = [
  { label: 'Trial Balance', path: '/reports/tb', sec: 'fin', icon: 'ti-scale' },
  { label: 'Income Statement', path: '/reports/pl', sec: 'fin', icon: 'ti-chart-line' },
  { label: 'Balance Sheet', path: '/reports/bs', sec: 'fin', icon: 'ti-building-bank' },
  { label: 'VAT201 Return', path: '/reports/vat', sec: 'stat', icon: 'ti-percentage' },
  { label: 'VAT Period Summary', path: '/reports/vper', sec: 'stat', icon: 'ti-calendar-stats' },
  { label: 'Tax Computation', path: '/reports/tax', sec: 'stat', icon: 'ti-calculator', ready: false },
  { label: 'Financial Years', path: '/reports/fyr', sec: 'stat', icon: 'ti-calendar-event' },
  { label: 'Budget', path: '/reports/bud', sec: 'bud', icon: 'ti-pencil-dollar' },
  { label: 'Budget vs Actual', path: '/reports/bva', sec: 'bud', icon: 'ti-chart-infographic' },
  { label: 'Asset Register', path: '/reports/assets', sec: 'ops', icon: 'ti-tool' },
  { label: 'Depreciation', path: '/reports/dep', sec: 'ops', icon: 'ti-trending-down' },
  { label: 'Contract Schedule', path: '/reports/con', sec: 'ops', icon: 'ti-file-certificate' },
  { label: 'Contract Billing', path: '/reports/bill', sec: 'ops', icon: 'ti-receipt-2' },
  { label: 'Meter Usage', path: '/reports/meter', sec: 'ops', icon: 'ti-printer' },
  { label: 'Service Calls', path: '/reports/calls', sec: 'ops', icon: 'ti-headset' },
  { label: 'Work Orders', path: '/reports/wo', sec: 'ops', icon: 'ti-clipboard-list' },
  { label: 'Sales by Customer', path: '/reports/sales', sec: 'ops', icon: 'ti-chart-bar' },
  { label: 'Purchase Orders', path: '/reports/po', sec: 'ops', icon: 'ti-shopping-cart' },
  { label: 'Goods Received', path: '/reports/grn', sec: 'ops', icon: 'ti-package' },
  { label: 'Supplier Invoices', path: '/reports/sinv', sec: 'ops', icon: 'ti-file-invoice' },
  { label: 'Part Requests', path: '/reports/preq', sec: 'ops', icon: 'ti-package-export' },
  { label: 'Part Returns', path: '/reports/pret', sec: 'ops', icon: 'ti-package-import' },
  { label: 'Stock on Hand', path: '/reports/stk', sec: 'ops', icon: 'ti-box' },
];
const repChildren = repTabs.map((t) => ({ path: t.path.split('/').pop()!, component: ReportsComponent, data: { tab: t.path.split('/').pop()! } }));
repChildren.unshift({ path: '', pathMatch: 'full', redirectTo: 'tb' } as never);

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: 'company-picker', component: CompanyPickerComponent, canActivate: [authGuard] },
  { path: 'change-password', component: ChangePasswordComponent, canActivate: [authGuard] },
  {
    path: '', component: ShellComponent, canActivate: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      { path: 'dashboard', component: DashboardComponent },
      // GL: /gl/jnl hosts both the list and the entry form (New Journal Entry tab deep-links with ?new=1 handled client-side)
      {
        path: 'gl', component: ModTabsComponent,
        data: { mod: 'gl', title: 'General Ledger', sub: 'Chart of accounts, journals & ledger enquiries', tabs: glTabs },
        canActivate: [canSecGuard],
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'coa' },
          { path: 'coa', component: GlCoaComponent, data: { mod: 'gl', sec: 'maint' }, canActivate: [canSecGuard] },
          { path: 'jnl', component: GlJnlComponent, data: { mod: 'gl', sec: 'trans' }, canActivate: [canSecGuard] },
          { path: 'jnl/new', component: GlJnlComponent, data: { mod: 'gl', sec: 'trans' }, canActivate: [canSecGuard] },
          { path: 'jbatch', component: GlJbatchComponent, data: { mod: 'gl', sec: 'trans' }, canActivate: [canSecGuard] },
          { path: 'enq', component: GlEnqComponent, data: { mod: 'gl', sec: 'enq' }, canActivate: [canSecGuard] },
          { path: 'jenq', component: GlJenqComponent, data: { mod: 'gl', sec: 'enq' }, canActivate: [canSecGuard] },
        ],
      },
      {
        path: 'customers', component: ModTabsComponent,
        data: { mod: 'customers', title: 'Customers', sub: 'Manage customers, invoices, credit notes & statements', tabs: custTabs },
        canActivate: [canSecGuard],
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'list' },
          { path: 'list', component: CustListComponent, data: { mod: 'customers', sec: 'maint' }, canActivate: [canSecGuard] },
          { path: 'add', component: CustAddComponent, data: { mod: 'customers', sec: 'maint' }, canActivate: [canSecGuard] },
          { path: 'inv', component: CustSiComponent, data: { mod: 'customers', sec: 'trans' }, canActivate: [canSecGuard] },
          { path: 'cn', component: CustCnComponent, data: { mod: 'customers', sec: 'trans' }, canActivate: [canSecGuard] },
          { path: 'rcpt', component: CustRcptComponent, data: { mod: 'customers', sec: 'trans' }, canActivate: [canSecGuard] },
          { path: 'jnl', component: CustJnlComponent, data: { mod: 'customers', sec: 'trans' }, canActivate: [canSecGuard] },
          { path: 'enq', component: CustEnqComponent, data: { mod: 'customers', sec: 'enq' }, canActivate: [canSecGuard] },
          { path: 'aged', component: AgedComponent, data: { mod: 'customers', sec: 'enq', kind: 'cust' }, canActivate: [canSecGuard] },
          { path: 'cinvc', component: CustCinvComponent, data: { mod: 'customers', sec: 'trans' }, canActivate: [canSecGuard] },
        ],
      },
      {
        path: 'suppliers', component: ModTabsComponent,
        data: { mod: 'suppliers', title: 'Suppliers', sub: 'Manage suppliers, purchase invoices & debit notes', tabs: supTabs },
        canActivate: [canSecGuard],
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'list' },
          { path: 'list', component: SupListComponent, data: { mod: 'suppliers', sec: 'maint' }, canActivate: [canSecGuard] },
          { path: 'add', component: SupAddComponent, data: { mod: 'suppliers', sec: 'maint' }, canActivate: [canSecGuard] },
          { path: 'jnl', component: SupJnlComponent, data: { mod: 'suppliers', sec: 'trans' }, canActivate: [canSecGuard] },
          { path: 'enq', component: SupEnqComponent, data: { mod: 'suppliers', sec: 'enq' }, canActivate: [canSecGuard] },
          { path: 'aged', component: AgedComponent, data: { mod: 'suppliers', sec: 'enq', kind: 'sup' }, canActivate: [canSecGuard] },
        ],
      },
      {
        path: 'inventory', component: ModTabsComponent,
        data: { mod: 'inventory', title: 'Inventory', sub: 'Manage stock categories & items — linked to GL account 6200', tabs: invTabs },
        canActivate: [canSecGuard],
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'items' },
          { path: 'items', component: InvItemsComponent, data: { mod: 'inventory', sec: 'maint' }, canActivate: [canSecGuard] },
          { path: 'cats', component: InvCatsComponent, data: { mod: 'inventory', sec: 'maint' }, canActivate: [canSecGuard] },
          { path: 'add', component: InvItemAddComponent, data: { mod: 'inventory', sec: 'maint' }, canActivate: [canSecGuard] },
          { path: 'preq', component: InvPreqComponent, data: { mod: 'inventory', sec: 'trans' }, canActivate: [canSecGuard] },
          { path: 'pret', component: InvPretComponent, data: { mod: 'inventory', sec: 'trans' }, canActivate: [canSecGuard] },
          { path: 'card', component: InvCardComponent, data: { mod: 'inventory', sec: 'enq' }, canActivate: [canSecGuard] },
          { path: 'valuation', component: InvValComponent, data: { mod: 'inventory', sec: 'enq' }, canActivate: [canSecGuard] },
        ],
      },
      {
        path: 'procurement', component: ProcurementComponent, canActivate: [canSecGuard],
        data: { mod: 'procurement' },
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'pi' },
          { path: 'pi', component: PiComponent, data: { mod: 'procurement', sec: 'trans' }, canActivate: [canSecGuard] },
          { path: 'dn', component: DnComponent, data: { mod: 'procurement', sec: 'trans' }, canActivate: [canSecGuard] },
          { path: 'po', component: PoComponent, data: { mod: 'procurement', sec: 'trans' }, canActivate: [canSecGuard] },
          { path: 'grn', component: GrnComponent, data: { mod: 'procurement', sec: 'trans' }, canActivate: [canSecGuard] },
        ],
      },
      {
        path: 'assets', component: ModTabsComponent,
        data: { mod: 'assets', title: 'Assets / Equipment', sub: 'Fixed asset register, servicing and depreciation', tabs: assetTabs },
        canActivate: [canSecGuard],
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'register' },
          { path: 'register', component: AssetsRegisterComponent, data: { mod: 'assets', sec: 'maint' }, canActivate: [canSecGuard] },
          { path: 'add', component: AssetFormComponent, data: { mod: 'assets', sec: 'maint' }, canActivate: [canSecGuard] },
          { path: 'svc', component: AssetsSvcComponent, data: { mod: 'assets', sec: 'maint' }, canActivate: [canSecGuard] },
          { path: 'dep', component: AssetsDepComponent, data: { mod: 'assets', sec: 'maint' }, canActivate: [canSecGuard] },
          { path: 'buybacks', component: AssetsBBComponent, data: { mod: 'assets', sec: 'maint' }, canActivate: [canSecGuard] },
          { path: 'conversions', component: AssetsCvComponent, data: { mod: 'assets', sec: 'maint' }, canActivate: [canSecGuard] },
        ],
      },
      {
        path: 'service', component: ModTabsComponent,
        data: { mod: 'service', title: 'Service', sub: 'Service calls for customers and their assets, assigned to technicians', tabs: svcTabs },
        canActivate: [canSecGuard],
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'calls' },
          { path: 'calls', component: SvCallsComponent, data: { mod: 'service', sec: 'trans' }, canActivate: [canSecGuard] },
          { path: 'reqs', component: SvReqsComponent, data: { mod: 'service', sec: 'trans' }, canActivate: [canSecGuard] },
          { path: 'wo', component: SvWoComponent, data: { mod: 'service', sec: 'trans' }, canActivate: [canSecGuard] },
          { path: 'wip', component: SvWipComponent, data: { mod: 'service', sec: 'enq' }, canActivate: [canSecGuard] },
          { path: 'sla', component: SvSlaComponent, data: { mod: 'service', sec: 'enq' }, canActivate: [canSecGuard] },
        ],
      },
      {
        path: 'contracts', component: ModTabsComponent,
        data: { mod: 'contracts', title: 'Contract Management', sub: 'Customer contracts, terms and renewals', tabs: conTabs },
        canActivate: [canSecGuard],
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'list' },
          { path: 'list', component: ContractsListComponent, data: { mod: 'contracts', sec: 'maint' }, canActivate: [canSecGuard] },
          { path: 'add', component: ContractFormComponent, data: { mod: 'contracts', sec: 'maint' }, canActivate: [canSecGuard] },
        ],
      },
      {
        path: 'cbilling', component: ModTabsComponent,
        data: { mod: 'cbilling', title: 'Contract Billing', sub: 'Recurring invoices raised from active contracts', tabs: billTabs },
        canActivate: [canSecGuard],
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'run' },
          { path: 'run', component: CbRunComponent, data: { mod: 'cbilling', sec: 'trans' }, canActivate: [canSecGuard] },
          { path: 'meters', component: CbMetersComponent, data: { mod: 'cbilling', sec: 'trans' }, canActivate: [canSecGuard] },
          { path: 'periods', component: CbPeriodsComponent, data: { mod: 'cbilling', sec: 'trans' }, canActivate: [canSecGuard] },
          { path: 'escalate', component: CbEscComponent, data: { mod: 'cbilling', sec: 'trans' }, canActivate: [canSecGuard] },
          { path: 'hist', component: CbHistComponent, data: { mod: 'cbilling', sec: 'enq' }, canActivate: [canSecGuard] },
        ],
      },
      {
        path: 'vat', component: ModTabsComponent,
        data: { mod: 'vat', title: 'VAT Returns', sub: 'VAT Act 89 of 1991 — SARS eFiling', tabs: vatTabs },
        canActivate: [canSecGuard],
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'dash' },
          { path: 'dash', component: VatComponent, data: { mod: 'vat', tab: 'dash' }, canActivate: [canSecGuard] },
          { path: 'detail', component: VatComponent, data: { mod: 'vat', tab: 'detail' }, canActivate: [canSecGuard] },
          { path: 'periods', component: VatComponent, data: { mod: 'vat', tab: 'periods' }, canActivate: [canSecGuard] },
        ],
      },
      {
        path: 'reports', component: ModTabsComponent,
        data: { mod: 'reports', title: 'Reports & Budgets', sub: 'IFRS for SMEs · SARS', tabs: repTabs, secLabels: { fin: 'Financial Reports', stat: 'Statutory Reports', ops: 'Operation Reports', bud: 'Budgets' } },
        canActivate: [canSecGuard],
        children: repChildren,
      },
      {
        path: 'settings', component: SettingsComponent, data: { mod: 'settings' }, canActivate: [canSecGuard],
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'company' },
          { path: 'company', component: CompanyTaxComponent, data: { mod: 'settings', sec: 'company' }, canActivate: [canSecGuard] },
          { path: 'years', component: YearsComponent, data: { mod: 'settings', sec: 'years' }, canActivate: [canSecGuard] },
          { path: 'companies', component: CompaniesTabComponent, data: { mod: 'settings', sec: 'companies' }, canActivate: [canSecGuard] },
          { path: 'users', component: UsersComponent, data: { mod: 'settings', sec: 'users' }, canActivate: [canSecGuard] },
          { path: 'roles', component: RolesComponent, data: { mod: 'settings', sec: 'roles' }, canActivate: [canSecGuard] },
          { path: 'email', component: EmailComponent, data: { mod: 'settings', sec: 'email' }, canActivate: [canSecGuard] },
          { path: 'log', component: LogComponent, data: { mod: 'settings', sec: 'log' }, canActivate: [canSecGuard] },
          { path: 'sitypes', component: SitypesComponent, data: { mod: 'settings', sec: 'sitypes' }, canActivate: [canSecGuard] },
          { path: 'ctypes', component: CtypesComponent, data: { mod: 'settings', sec: 'ctypes' }, canActivate: [canSecGuard] },
          { path: 'employees', component: EmployeesComponent, data: { mod: 'settings', sec: 'employees' }, canActivate: [canSecGuard] },
          { path: 'svctypes', component: SvctypesComponent, data: { mod: 'settings', sec: 'svctypes' }, canActivate: [canSecGuard] },
        ],
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
