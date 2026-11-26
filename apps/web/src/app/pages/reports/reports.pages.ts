// Reports & Budgets module (legacy repOpen/rtab 1894 + renderers 4082–4171 / 5599–5663 / budgets 4381–4452).
// One component per tab (route data), a shared VTable renderer, and REPDATA-style export sections.
import { Component, ChangeDetectorRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { ApiService, ApiError, ToastService } from '../../core/api';
import { AuthStore } from '../../core/auth.store';
import { Exporter, type RepCol, type ExportSpec } from '../../core/export';
import { fmtR, fmtD, todayIso } from '../../core/fmt';
import { COA_GROUPS } from '@numera/shared';

const r2v = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown): number => (Number(v) || 0);
const fpar = (n: number) => { n = Math.abs(n) < 0.005 ? 0 : n; return n < 0 ? '(R ' + Math.abs(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ')' : 'R ' + n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
const dayAdd = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); const p = (x: number) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const addMonths = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00'); d.setMonth(d.getMonth() + n); const p = (x: number) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00') - Date.parse(a + 'T00:00:00')) / 86400000);
const lineEndOfL = (l: { ever?: boolean; start: string; term: number }) => l.ever ? '' : dayAdd(addMonths(l.start, l.term), -1);
const lineActive = (l: { ever?: boolean; start: string; term: number }) => !lineEndOfL(l) || lineEndOfL(l) >= todayIso();
const MONS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// legacy vatLabel 3979
const vatLabel = (st: string, en: string) => {
  const a = st.slice(5, 7), b = en.slice(5, 7), ya = st.slice(0, 4), yb = en.slice(0, 4);
  return st.slice(0, 7) === en.slice(0, 7) ? `${MONS[+a]} ${ya}`
    : ya === yb ? `${MONS[+a]}/${MONS[+b]} ${ya}` : `${MONS[+a]} ${ya} – ${MONS[+b]} ${yb}`;
};

export interface VCell { v: string; r?: boolean; muted?: boolean; }
export interface VRow { cls?: 'tt' | 'tg' | ''; sec?: string; span?: number; cells?: (VCell | null)[]; nz?: 0 | 1; }
interface FinAcc { code: string; name: string; type: string; open: number; beforeDr: number; beforeCr: number; dr: number; cr: number; }
interface FY { id: string; name: string; start: string; end: string; status: string; is_current: boolean; income: number; expenses: number; }

// legacy FIN (5597) — shared across the three financial reports, survives tab hops
const FIN = { fy: '', from: '', to: '', tbmode: 'bal', showZero: 'all' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const dashR = (v: number): VCell => (v ? { v: fmtR(v), r: true } : { v: '—', r: true, muted: true });

@Component({
  selector: 'app-reports',
  imports: [FormsModule],
  template: `
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
    @if (isFin()) {
      <span style="font-size:13px;color:var(--tx2)">Financial year:</span>
      <select [(ngModel)]="FIN.fy" (change)="finChanged()" style="width:150px">
        <option value="">All periods</option>
        @for (f of fys; track f.id) { <option [value]="f.id">{{f.name}}</option> }
        <option value="custom">Custom dates</option>
      </select>
      <span style="font-size:13px;color:var(--tx2)">From:</span><input type="date" [(ngModel)]="FIN.from" (change)="finDate()" style="width:150px">
      <span style="font-size:13px;color:var(--tx2)">To:</span><input type="date" [(ngModel)]="FIN.to" (change)="finDate()" style="width:150px">
      <button class="btn btn-s btn-sm" (click)="finClear()">Clear</button>
      @if (tab() === 'tb') {
        <span style="font-size:13px;color:var(--tx2)">Balances:</span>
        <select [(ngModel)]="FIN.tbmode" (change)="renderTB(); " style="width:210px"><option value="bal">Include opening balances</option><option value="mov">Movements only</option></select>
        <span style="font-size:13px;color:var(--tx2)">Show:</span>
        <select [(ngModel)]="FIN.showZero" (change)="0" style="width:190px"><option value="all">All accounts</option><option value="nz">Non-zero only</option></select>
      }
      <span style="margin-left:auto;display:flex;gap:6px">
        @if (vt(); as v) {
          <button class="btn btn-s btn-sm" (click)="exportAs('pdf')"><i class="ti ti-file-type-pdf"></i> PDF</button>
          <button class="btn btn-s btn-sm" (click)="exportAs('xlsx')"><i class="ti ti-file-spreadsheet"></i> Excel</button>
          <button class="btn btn-s btn-sm" (click)="exportAs('csv')"><i class="ti ti-file-text"></i> CSV</button>
        }
      </span>
    } @else {
      @if (tab() === 'vat') {
        <span style="font-size:13px;color:var(--tx2)">VAT period:</span>
        <select [(ngModel)]="vatSel" (change)="rVat(); " style="min-width:230px">
          @for (p of vps(); track p.id) { <option [value]="p.id">{{vatLabel(p.start, p.end)}} ({{p.status === 'open' ? 'open' : 'closed'}})</option> }
        </select>
      }
      @if (tab() === 'dep') {
        <span style="font-size:13px;color:var(--tx2)">As at month:</span>
        <input type="month" [(ngModel)]="depMonth" (change)="load()" style="width:160px">
      }
      @if (budTabs().includes(tab())) {
        <span style="font-size:13px;color:var(--tx2)">Financial year:</span>
        <select [ngModel]="budFy" (ngModelChange)="budFy = $event; load()" style="width:180px">
          @for (f of budFyOpts(); track f.id) { <option [value]="f.id">{{f.name}} {{f.is_current ? '(current)' : ''}}</option> }
        </select>
      }
      @if (tab() === 'meter') {
        <span style="font-size:13px;color:var(--tx2)">Billing period:</span>
        <select [ngModel]="fvals['f_per']" (ngModelChange)="fvals['f_per'] = $event; loadMeter()" [disabled]="!periods().length" style="min-width:190px">
          @for (p of periods(); track p.id) { <option [value]="p.id">{{p.id}} ({{p.status}})</option> }
        </select>
      }
      @for (f of filters(); track f.key) {
        @if (f.type === 'date') {
          <span><span style="font-size:13px;color:var(--tx2)">{{f.label}}:</span><input type="date" [ngModel]="fvals[f.key]" (ngModelChange)="fvals[f.key] = $event; rerender()" style="width:150px"></span>
        } @else {
          <span><span style="font-size:13px;color:var(--tx2)">{{f.label}}:</span>
          <select [ngModel]="fvals[f.key]" (ngModelChange)="fvals[f.key] = $event; rerender()" style="min-width:140px">
            @for (o of f.opts; track o[0]) { <option [value]="o[0]">{{o[1]}}</option> }
          </select></span>
        }
      }
      <span style="margin-left:auto;display:flex;gap:6px">
        @if (vt(); as v) {
          <button class="btn btn-s btn-sm" (click)="exportAs('pdf')"><i class="ti ti-file-type-pdf"></i> PDF</button>
          <button class="btn btn-s btn-sm" (click)="exportAs('xlsx')"><i class="ti ti-file-spreadsheet"></i> Excel</button>
          <button class="btn btn-s btn-sm" (click)="exportAs('csv')"><i class="ti ti-file-text"></i> CSV</button>
        }
      </span>
    }
  </div>
  @if (err()) { <div class="form-err">{{err()}}</div> }

  @if (tab() === 'bud') {
    @if (budView(); as b) {
      <div class="card">
        <div class="card-title"><span>Budget</span>
          @if (budEditable()) { <span style="display:flex;gap:6px">
            <button class="btn btn-p btn-sm" (click)="saveBudget()">Save Budget</button>
            <button class="btn btn-s btn-sm" (click)="clearBudget()">Clear</button></span> }
        </div>
        <div style="font-size:12px;color:var(--txm);margin-bottom:10px">Set a monthly budget for each income and expense account (from the Chart of Accounts) for a financial year. Type an annual amount to spread it evenly over 12 months, or type each month yourself.</div>
        @if (b.msg) { <div class="form-err" style="display:block">{{b.msg}}</div> }
        <div style="overflow-x:auto"><table style="min-width:1250px">
          <thead><tr><th>Account</th><th class="tr">Annual</th>@for (m of b.months; track m.label) { <th class="tr">{{m.label}}</th> }</tr></thead>
          <tbody>
            @for (a of b.rows; track a.code; let k = $index) {
              @if (k === 0 || b.rows[k - 1].sec !== a.sec) { <tr class="ts"><td colspan="14">{{a.sec === 1 ? 'Income' : 'Expenses'}}</td></tr> }
              <tr>
                <td style="white-space:nowrap">{{a.code}} — {{a.name}}</td>
                <td><input type="number" step="0.01" style="width:105px;text-align:right" [disabled]="!budEditable()" [value]="a.annual || ''" (change)="budSpread(a, $any($event.target).value)"></td>
                @for (m of a.months; track $index; let i = $index) {
                  <td><input type="number" step="0.01" style="width:82px;text-align:right" [disabled]="!budEditable()" [value]="m || ''" (input)="a.months[i] = num($any($event.target).value); a.annual = sumRow(a); budNet()"></td>
                }
              </tr>
            }
            <tr class="tt"><td><strong>Net budget (income − expenses)</strong></td>@for (m of b.net; track $index) { <td class="tr"><strong>{{fmtR(m)}}</strong></td> }</tr>
          </tbody>
        </table></div>
      </div>
    }
  } @else {
    @if (vt(); as v) {
      @if (tab() === 'tb') {
        <div class="tb-ok" style="display:flex;align-items:flex-start;gap:10px;margin-bottom:14px">
          <i class="ti" [class]="v.ok ? 'ti-circle-check' : 'ti-circle-x'" [style.color]="v.ok ? 'var(--ac)' : 'var(--dn,#c0392b)'"></i>
          <div [innerHTML]="v.okLine"></div>
        </div>
      } @else if (tab() === 'bs') {
        <div style="font-size:12px;color:var(--txm);margin-bottom:10px">Balance sheet is as at the To date.</div>
      }
      <div class="card" style="padding:0;overflow-x:auto"><table>
        <thead><tr>@for (c of v.cols; track $index) { <th [class.tr]="c.r" [style.width.px]="c.w">{{c.h}}</th> }</tr></thead>
        <tbody>
          @for (row of rowsShown(); track $index) {
            @if (row.sec !== undefined) {
              <tr class="ts"><td [attr.colspan]="row.span || v.cols.length">{{row.sec}}</td></tr>
            } @else {
              <tr [class]="row.cls">
                @for (c of row.cells; track $index) {
                  <td [class.tr]="c?.r" [style]="c?.muted ? 'color:var(--txm)' : ''">{{c ? c.v : ''}}</td>
                }
              </tr>
            }
          }
          @if (!hasData()) { <tr><td [attr.colspan]="v.cols.length" style="text-align:center;color:var(--txm)">Nothing to report for these filters.</td></tr> }
        </tbody>
      </table></div>
      @if (tab() === 'tb') { <div style="font-size:12px;color:var(--txm);margin-top:10px">Prepared by Numera · {{fmtD(todayIso(), 1)}} · Accrual basis (IFRS for SMEs)</div> }
    }
  }
  `,
})
export class ReportsComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private exp = inject(Exporter);
  private auth = inject(AuthStore);
  private ar = inject(ActivatedRoute);
  cdr = inject(ChangeDetectorRef);

  FIN = FIN; fmtR = fmtR; fmtD = fmtD; todayIso = todayIso; vatLabel = vatLabel; num = num;
  err = signal('');
  vt = signal<null | { cols: { h: string; r?: boolean; w?: number }[]; rows: VRow[]; ok?: boolean; okLine?: string }>(null);
  private ex: { title: string; cols: RepCol[]; rows: unknown[][]; totals?: unknown[] } | null = null; // REPDATA (4084) port
  tab = () => (this.ar.snapshot.data as { tab: string }).tab;
  isFin = () => ['tb', 'pl', 'bs'].includes(this.tab());
  budTabs = () => ['bud', 'bva'];

  fys: FY[] = [];
  finRows: FinAcc[] = []; maxDate = '';
  vatPeriods: any[] = []; vatSel = '';
  depMonth = todayIso().slice(0, 7);
  budFy = '';
  // per-tab filters (bracket-accessed from the template)
  fvals: Record<string, string> = {}; // per-tab filter values (template bracket access)
  data: any[] = []; extra: any[] = [];

  constructor() { void this.load(); }

  load = async () => {
    this.err.set(''); this.vt.set(null); this.ex = null;
    const t = this.tab();
    try {
      if (t === 'tb' || t === 'pl' || t === 'bs') await this.loadFin();
      else if (t === 'vat' || t === 'vper') {
        this.vatPeriods = await this.api.get<any[]>('/vat/periods');
        if (t === 'vat') this.rVat(); else this.rVper();
      } else if (t === 'fyr') { this.fys = await this.api.get<FY[]>('/fys'); this.rFyr(); }
      else if (t === 'bud' || t === 'bva') await this.loadBud();
      else if (t === 'assets' || t === 'dep') this.setAssets(await this.api.get<any[]>('/reports/assets?month=' + this.depMonth));
      else if (t === 'stk') this.rStk(await this.api.get<any[]>('/reports/stk'));
      else this.rOpsLoad();
      
    } catch (e) { this.err.set((e as ApiError).message); }
  };

  rerender = () => { this.rOps(); };
  periods = () => this.data;

  async loadMeter() {
    try {
      this.extra = await this.api.get<any[]>('/billing/meters?per=' + this.fvals['f_per']);
      this.rMeter(); 
    } catch (e) { this.err.set((e as ApiError).message); }
  }

  // per-panel filter defs; options computed from the loaded data
  filters = (): { key: string; label: string; type?: 'date'; opts?: [string, string][] }[] => {
    const t = this.tab();
    const uniq = (k: string, none = 'All') => [['', none], ...[...new Set(this.data.map((x: any) => x[k]).filter(Boolean))].sort().map((v) => [String(v), String(v)])] as [string, string][];
    if (t === 'con') return [{ key: 'f_st', label: 'Status', opts: [['', 'All'], ['Active', 'Active'], ['Draft', 'Draft'], ['Suspended', 'Suspended'], ['Expired', 'Expired'], ['Cancelled', 'Cancelled']] },
      { key: 'f_cust', label: 'Customer', opts: uniq('custName') }];
    if (t === 'meter') return [{ key: 'f_cust', label: 'Customer', opts: uniq('custName') }];
    if (t === 'bill' || t === 'sales') return [{ key: 'f_from', label: 'From', type: 'date' }, { key: 'f_to', label: 'To', type: 'date' }, ...(t === 'bill' ? [{ key: 'f_cust', label: 'Customer', opts: uniq('custName') }] : [])];
    if (t === 'calls') return [
      { key: 'f_from', label: 'From', type: 'date' }, { key: 'f_to', label: 'To', type: 'date' },
      { key: 'f_tech', label: 'Technician', opts: [['', 'All technicians'], ['-', 'Unassigned'], ...[...new Set(this.data.map((x: any) => x.techName).filter(Boolean))].sort().map((v) => [String(v), String(v)] as [string, string])] },
      { key: 'f_st', label: 'Status', opts: [['', 'All'], ['open', 'Open'], ['Logged', 'Logged'], ['Assigned', 'Assigned'], ['In progress', 'In progress'], ['On hold', 'On hold'], ['Completed', 'Completed'], ['Cancelled', 'Cancelled']] },
      { key: 'f_cust', label: 'Customer', opts: uniq('custName') }];
    if (t === 'wo') return [{ key: 'f_st', label: 'Status', opts: [['', 'All'], ['Issued', 'Issued'], ['In progress', 'In progress'], ['Completed', 'Completed'], ['Cancelled', 'Cancelled']] }];
    if (t === 'po') return [{ key: 'f_st', label: 'Status', opts: [['', 'All'], ['Draft', 'Draft'], ['Approved', 'Approved'], ['Sent', 'Sent'], ['Part received', 'Part received'], ['Received', 'Received'], ['Cancelled', 'Cancelled']] },
      { key: 'f_sup', label: 'Supplier', opts: uniq('supName') }];
    if (t === 'preq') return [{ key: 'f_st', label: 'Status', opts: [['', 'All'], ['New', 'New'], ['Issued', 'Issued'], ['Cancelled', 'Cancelled']] }];
    if (t === 'assets') return [
      { key: 'f_cust', label: 'Customer', opts: [['', 'All customers'], ['-', 'Unassigned'], ...[...new Set(this.data.map((x: any) => x.custName).filter(Boolean))].map((v) => [String(v), String(v)] as [string, string])] },
      { key: 'f_cat', label: 'Category', opts: [['', 'All'], ...[...new Set(this.data.map((x: any) => x.cat).filter(Boolean))].map((v) => [String(v), String(v)] as [string, string])] },
      { key: 'f_st', label: 'Status', opts: [['', 'All'], ['Active', 'Active'], ['Disposed', 'Disposed']] },
      { key: 'f_type', label: 'Type', opts: [['', 'All types'], ['company', 'Company Asset'], ['warehouse', 'Warehouse (Inventory)'], ['customer', 'Customer Asset']] }];
    return [];
  };

  // ── FIN (legacy finModel 5599 / finPeriodLabel 5612 / finEffTo 5615) ──
  async loadFin() {
    const before = { fy: FIN.fy, from: FIN.from, to: FIN.to };
    this.fys = await this.api.get<FY[]>('/fys');
    FIN.fy = before.fy; FIN.from = before.from; FIN.to = before.to;
    if (FIN.from && FIN.to && FIN.to < FIN.from) { this.toast.show('The To date cannot be before the From date.'); return; } // finBad 5631
    let res = await this.api.get<{ maxDate: string; accounts: FinAcc[] }>('/reports/fin?from=' + FIN.from + '&to=' + FIN.to);
    this.maxDate = res.maxDate || todayIso();
    const t = this.tab();
    if (t === 'bs') {
      // balance sheet: re-window to [fyStart(T)..T] so curPL is the current-year profit (renderBS 5653)
      const T = this.finEffTo(res.maxDate);
      const fs = this.fys.find((f) => f.start <= T && T <= f.end)?.start ?? '';
      if (fs && (fs !== FIN.from || T !== FIN.to))
        res = await this.api.get<{ maxDate: string; accounts: FinAcc[] }>('/reports/fin?from=' + fs + '&to=' + T);
      this.renderBS(res.accounts, T);
      return;
    }
    this.finRows = res.accounts;
    if (t === 'tb') this.renderTB(); else this.renderPL();
  }
  finChanged() {
    const fy = this.fys.find((f) => f.id === FIN.fy);
    if (fy) { FIN.from = fy.start; FIN.to = fy.end; }
    else if (!FIN.fy) { FIN.from = ''; FIN.to = ''; }
    void this.load();
  }
  finDate() { // finDate 5625
    const fy = this.fys.find((x) => x.start === FIN.from && x.end === FIN.to);
    FIN.fy = fy ? fy.id : ((FIN.from || FIN.to) ? 'custom' : '');
    void this.load();
  }
  finClear() { FIN.fy = ''; FIN.from = ''; FIN.to = ''; void this.load(); }
  finPeriodLabel() {
    const fy = this.fys.find((f) => f.id === FIN.fy);
    if (fy) return fy.name + ' (' + fmtD(fy.start, 1) + ' – ' + fmtD(fy.end, 1) + ')';
    if (FIN.from || FIN.to) return (FIN.from ? fmtD(FIN.from, 1) : 'start') + ' to ' + (FIN.to ? fmtD(FIN.to, 1) : 'date');
    return 'All periods';
  }
  finEffTo(max = '') { return FIN.to || (max || this.maxDate || todayIso()); } // finEffTo 5615
  private model(rows: FinAcc[], from = FIN.from) {
    const by = new Map(rows.map((a) => [a.code, a]));
    // opening_balance is stored display-normal (credit side positive, as seeded) like the account
    // enquiry's glEnqSync 5588 side rule — normalize: dr-normal = first digit 2/4/5/6
    const side = (c: string) => '2456'.includes(String(c)[0]);
    const A = (c: string): FinAcc => by.get(c) ?? { code: c, name: 'Account ' + c, type: '', open: 0, beforeDr: 0, beforeCr: 0, dr: 0, cr: 0 };
    const mv = (c: string) => r2v(A(c).dr - A(c).cr);
    const base = (c: string) => { const a = A(c); const o = r2v(a.open); return r2v((side(c) ? o : -o) + a.beforeDr - a.beforeCr); };
    const isPL = (c: string) => c < '5000';
    const plNet = (c: string) => (from ? mv(c) : r2v(base(c) + mv(c)));      // plNet 5608
    const cum = (c: string) => r2v(base(c) + mv(c));                        // cum 5609
    return { A, mv, base, isPL, plNet, cum, codes: rows.map((a) => a.code).sort() };
  }

  // ── Trial Balance (renderTB 5557) ──
  renderTB() {
    const M = this.model(this.finRows);
    const mode = FIN.tbmode;
    let adj = 0;
    if (mode === 'bal') { let cp = 0, dp = 0; M.codes.filter(M.isPL).forEach((c) => { cp += M.cum(c); dp += M.plNet(c); }); adj = r2v(cp - dp); } // 5561
    const netOf = (c: string) => (mode === 'mov' ? M.mv(c) : (M.isPL(c) ? M.plNet(c) : M.cum(c) + (c === '7010' ? adj : 0))); // 5562
    const rows: VRow[] = []; let TD = 0, TC = 0;
    COA_GROUPS.forEach((g, gi) => {
      const codes = M.codes.filter((c) => +c[0] === gi + 1).sort();
      if (!codes.length) return;
      rows.push({ sec: `${(gi + 1) * 1000}s — ${g.name}` });
      let sd = 0, sc = 0;
      codes.forEach((c) => {
        const a = M.A(c); const net = r2v(netOf(c)); const d = net > 0 ? net : 0, cr = net < 0 ? -net : 0; sd += d; sc += cr;
        rows.push({ cells: [{ v: c }, { v: a.name }, { v: a.type }, dashR(d), dashR(cr)], nz: net ? 1 : 0 });
      });
      TD = r2v(TD + sd); TC = r2v(TC + sc);
      rows.push({ cls: 'tt', cells: [{ v: 'Subtotal — ' + g.name, muted: true }, null, null, dashR(sd), dashR(sc)] });
    });
    const ok = Math.abs(TD - TC) < 0.005;
    const lbl = this.finPeriodLabel() + ' · ' + (mode === 'mov' ? 'movements only (opening balances excluded)' : 'including opening balances');
    const okLine = ok
      ? `<strong>Trial balance is balanced.</strong> Total Debits = Total Credits = ${fmtR(TD)} · ${lbl}` // 5576
      : `<strong style="color:var(--dn,#c0392b)">Trial balance is out of balance by ${fmtR(Math.abs(TD - TC))}.</strong> Debits ${fmtR(TD)} · Credits ${fmtR(TC)} · ${lbl}`;
    const cols = [{ h: 'Code', w: 72 }, { h: 'Account Name' }, { h: 'Type' }, { h: 'Debit', r: true }, { h: 'Credit', r: true }];
    this.vt.set({ cols, rows, ok, okLine });
    this.ex = { title: 'Trial Balance — ' + this.finPeriodLabel(), cols,
      rows: rows.map((r) => r.sec ? [r.sec, '', '', '', ''] : (r.cells ?? []).map((c) => (c ? c.v : ''))) };
  }
  hasData = (): boolean => (this.vt()?.rows ?? []).some((r) => r.cls === undefined && r.sec === undefined);
  rowsShown = (): VRow[] => {
    const v = this.vt(); if (!v) return [];
    return FIN.showZero === 'nz' && this.tab() === 'tb' ? v.rows.filter((r) => r.nz !== 0 || r.cls || r.sec !== undefined) : v.rows;
  };

  // ── Income Statement (renderPL 5639) — export rows carry raw numbers ──
  renderPL() {
    const M = this.model(this.finRows);
    const rows: VRow[] = []; const exrows: unknown[][] = [];
    const sec = (title: string, lo: string, hi: string, sign: number, keep?: string) => {
      let tot = 0; rows.push({ sec: title });
      this.finRows.map((a) => a.code).filter((c) => c >= lo && c < hi).sort().forEach((c) => {
        const n = r2v(sign * M.plNet(c));
        if (n || c === keep) {
          tot += n;
          rows.push({ cells: [{ v: M.A(c).code + ' — ' + M.A(c).name }, { v: fpar(n), r: true }] });
          exrows.push([M.A(c).code + ' — ' + M.A(c).name, n]);
        }
      });
      return r2v(tot);
    };
    const sal = sec('Sales', '1000', '2000', -1, '1000');
    rows.push({ cls: 'tt', cells: [{ v: 'Total Sales' }, { v: fpar(sal), r: true }] }); exrows.push(['Total Sales', sal]);
    const cos = sec('Cost of Sales', '2000', '3000', 1);
    rows.push({ cls: 'tt', cells: [{ v: 'Total Cost of Sales' }, { v: fpar(-cos), r: true }] }); exrows.push(['Total Cost of Sales', -cos]);
    const gp = r2v(sal - cos);
    rows.push({ cls: 'tt', cells: [{ v: 'Gross Profit' }, { v: fpar(gp), r: true }] }); exrows.push(['Gross Profit', gp]);
    const oth = sec('Other Income', '3000', '4000', -1);
    rows.push({ cls: 'tt', cells: [{ v: 'Total Other Income' }, { v: fpar(oth), r: true }] }); exrows.push(['Total Other Income', oth]);
    const ovh = sec('Overheads', '4000', '5000', 1);
    rows.push({ cls: 'tt', cells: [{ v: 'Total Overheads' }, { v: fpar(-ovh), r: true }] }); exrows.push(['Total Overheads', -ovh]);
    const pbt = r2v(gp + oth - ovh), tax = pbt > 0 ? r2v(pbt * 0.27) : 0;
    rows.push({ cls: 'tt', cells: [{ v: 'Operating Profit (EBIT)' }, { v: fpar(pbt), r: true }] }); exrows.push(['Operating Profit (EBIT)', pbt]);
    rows.push({ cls: 'tt', cells: [{ v: 'Profit Before Tax' }, { v: fpar(pbt), r: true }] }); exrows.push(['Profit Before Tax', pbt]);
    rows.push({ cells: [{ v: 'Corporate Tax @ 27%' }, { v: fpar(-tax), r: true }] }); exrows.push(['Corporate Tax @ 27%', -tax]);
    rows.push({ cls: 'tg', cells: [{ v: 'Net Profit After Tax' }, { v: fpar(r2v(pbt - tax)), r: true }] }); exrows.push(['Net Profit After Tax', r2v(pbt - tax)]);
    this.vt.set({ cols: [{ h: 'Income Statement — ' + this.finPeriodLabel() }, { h: 'Amount', r: true }], rows });
    this.ex = { title: 'Income Statement — ' + this.finPeriodLabel(), cols: [{ h: 'Account' }, { h: 'Amount', t: 'm' }], rows: exrows };
  }

  // ── Balance Sheet (renderBS 5651) ──
  renderBS(rowsIn: FinAcc[], T: string) {
    const M = this.model(rowsIn, this.fys.find((f) => f.start <= T && T <= f.end)?.start ?? '');
    const bal = (c: string) => M.cum(c);
    let cumPL = 0, curPL = 0;
    M.codes.filter(M.isPL).forEach((c) => { cumPL += bal(c); curPL += M.mv(c); }); // 5655: mv over [fs..T]
    cumPL = r2v(cumPL); curPL = r2v(curPL);
    const rows: VRow[] = []; const exrows: unknown[][] = [];
    const grp = (codes: string[], sign: number) => {
      let tot = 0; const out: VRow[] = [];
      codes.sort().forEach((c) => { const n = r2v(sign * bal(c)); if (n) { tot += n; out.push({ cells: [{ v: M.A(c).name }, { v: fpar(n), r: true }] }); exrows.push([M.A(c).name, n]); } });
      return { tot: r2v(tot), out };
    };
    const ca = grp(M.codes.filter((c) => c >= '6000' && c < '7000'), 1), nca = grp(M.codes.filter((c) => c >= '5000' && c < '6000'), 1), li = grp(M.codes.filter((c) => c >= '8000'), -1);
    const eq = grp(M.codes.filter((c) => c >= '7000' && c < '8000' && c !== '7010'), -1),
      re = r2v(-(bal('7010') + cumPL - curPL)), cy = r2v(-curPL), te = r2v(eq.tot + re + cy), ta = r2v(ca.tot + nca.tot);
    rows.push({ sec: 'Assets' }, { cells: [{ v: 'Current Assets', muted: true }, null] }, ...ca.out);
    rows.push({ cls: 'tt', cells: [{ v: 'Total Current Assets' }, { v: fpar(ca.tot), r: true }] }); exrows.push(['Total Current Assets', ca.tot]);
    rows.push({ cells: [{ v: 'Non-Current Assets', muted: true }, null] }, ...nca.out);
    rows.push({ cls: 'tg', cells: [{ v: 'Total Assets' }, { v: fpar(ta), r: true }] });
    exrows.push(['Total Assets', ta]);
    rows.push({ sec: 'Liabilities' }, ...li.out);
    rows.push({ cls: 'tt', cells: [{ v: 'Total Liabilities' }, { v: fpar(li.tot), r: true }] }); exrows.push(['Total Liabilities', li.tot]);
    rows.push({ sec: 'Equity' }, ...eq.out);
    rows.push({ cells: [{ v: 'Retained Earnings (opening)' }, { v: fpar(re), r: true }] }); exrows.push(['Retained Earnings (opening)', re]);
    rows.push({ cells: [{ v: 'Current Year Profit (before tax)' }, { v: fpar(cy), r: true }] }); exrows.push(['Current Year Profit (before tax)', cy]);
    rows.push({ cls: 'tt', cells: [{ v: 'Total Equity' }, { v: fpar(te), r: true }] }); exrows.push(['Total Equity', te]);
    rows.push({ cls: 'tg', cells: [{ v: 'Total Liabilities + Equity' }, { v: fpar(r2v(li.tot + te)), r: true }] });
    exrows.push(['Total Liabilities + Equity', r2v(li.tot + te)]);
    this.vt.set({ cols: [{ h: 'Balance Sheet — ' + fmtD(T, 1) }, { h: 'Amount', r: true }], rows });
    this.ex = { title: 'Balance Sheet — ' + fmtD(T, 1), cols: [{ h: 'Item' }, { h: 'Amount', t: 'm' }], rows: exrows };
  }

  // ── VAT201 Return (rVat 4114) ──
  vps = () => this.vatPeriods.slice().sort((a, b) => (a.start > b.start ? -1 : 1));
  rVat() {
    const ps = this.vps();
    if (!ps.find((x) => x.id === this.vatSel)) this.vatSel = (ps.find((x) => x.status === 'open') || ps[0])?.id ?? '';
    const p = ps.find((x) => x.id === this.vatSel);
    const co = this.auth.company();
    const refund = p.net < 0;
    const st = p.status === 'open' ? 'DRAFT (period open)' : (p.submittedAt ? 'Submitted' : 'Closed');
    const rows: VRow[] = [
      { sec: 'Vendor: ' + (co?.name ?? '') + ' · VAT No. ' + (co?.vat_no || 'not set'), span: 3 },
      { sec: 'Period ' + fmtD(p.start, 1) + ' to ' + fmtD(p.end, 1) + ' · due ' + fmtD(p.due, 1) + ' · ' + st, span: 3 },
      { cells: [{ v: '1' }, { v: 'Standard-rated supplies (15%)' }, { v: fmtR(num(p.outEx)), r: true }, { v: fmtR(num(p.out)), r: true }] },
      { cells: [{ v: '2' }, { v: 'Zero-rated supplies' }, { v: fmtR(0), r: true }, { v: fmtR(0), r: true }] },
      { cells: [{ v: '3' }, { v: 'Exempt supplies' }, { v: fmtR(0), r: true }, { v: fmtR(0), r: true }] },
      { cells: [{ v: '4' }, { v: 'Total output VAT' }, null, { v: fmtR(num(p.out)), r: true }] },
      { cells: [{ v: '5' }, { v: 'Input VAT on purchases' }, { v: fmtR(num(p.inEx)), r: true }, { v: fmtR(num(p.inn)), r: true }] },
      { cells: [{ v: '6' }, { v: refund ? 'Net VAT refundable' : 'Net VAT payable' }, null, { v: fmtR(Math.abs(num(p.net))), r: true }] },
    ];
    const cols = [{ h: 'Field' }, { h: 'Description' }, { h: 'Amount excl.', r: true }, { h: 'VAT', r: true }];
    this.vt.set({ cols, rows });
    this.ex = { title: 'VAT201 Return — ' + vatLabel(p.start, p.end), cols,
      rows: [['Vendor: ' + (co?.name ?? '') + ' · VAT No. ' + (co?.vat_no || 'not set'), '', ''],
        ['Period ' + fmtD(p.start, 1) + ' to ' + fmtD(p.end, 1) + ' · due ' + fmtD(p.due, 1) + ' · ' + st, '', ''],
        ['1', 'Standard-rated supplies (15%)', num(p.outEx), num(p.out)], ['2', 'Zero-rated supplies', 0, 0], ['3', 'Exempt supplies', 0, 0],
        ['4', 'Total output VAT', '', num(p.out)], ['5', 'Input VAT on purchases', num(p.inEx), num(p.inn)],
        ['6', refund ? 'Net VAT refundable' : 'Net VAT payable', '', Math.abs(num(p.net))]] as unknown[][] };
  }

  // ── VAT Period Summary (rVper 4125) ──
  rVper() {
    const ps = this.vps(); let o = 0, i = 0, n = 0;
    const data = ps.map((p) => { o += num(p.out); i += num(p.inn); n += num(p.net);
      return [vatLabel(p.start, p.end), p.start, p.end, p.due, p.status === 'open' ? 'Open' : (p.submittedAt ? 'Closed · Submitted' : 'Closed'), num(p.out), num(p.inn), num(p.net)] as unknown[]; });
    const rows: VRow[] = data.map((r) => ({ cells: [{ v: String(r[0]) }, { v: fmtD(String(r[1]), 1) }, { v: fmtD(String(r[2]), 1) }, { v: fmtD(String(r[3]), 1) }, { v: String(r[4]) }, { v: fmtR(num(r[5])), r: true }, { v: fmtR(num(r[6])), r: true }, { v: fmtR(num(r[7])), r: true }] }));
    rows.push({ cls: 'tt', cells: [{ v: 'Total' }, null, null, null, null, { v: fmtR(r2v(o)), r: true }, { v: fmtR(r2v(i)), r: true }, { v: fmtR(r2v(n)), r: true }] });
    const cols = [{ h: 'Period' }, { h: 'From' }, { h: 'To' }, { h: 'Due' }, { h: 'Status' }, { h: 'Output VAT', r: true }, { h: 'Input VAT', r: true }, { h: 'Net VAT', r: true }];
    this.vt.set({ cols, rows });
    this.ex = { title: 'VAT Period Summary', cols, rows: data, totals: ['Total', '', '', '', '', r2v(o), r2v(i), r2v(n)] };
  }

  // ── Financial Years Summary (rFyr 4130) ──
  rFyr() {
    let inc = 0, ex = 0;
    const data = this.fys.slice().sort((a, b) => (a.start > b.start ? -1 : 1)).map((f) => { inc += num(f.income); ex += num(f.expenses); return [f.name, f.start, f.end, f.status === 'open' ? 'Open' : 'Closed', num(f.income), num(f.expenses), r2v(num(f.income) - num(f.expenses))] as unknown[]; });
    const rows: VRow[] = data.map((r) => ({ cells: [{ v: String(r[0]) }, { v: fmtD(String(r[1]), 1) }, { v: fmtD(String(r[2]), 1) }, { v: String(r[3]) }, { v: fmtR(num(r[4])), r: true }, { v: fmtR(num(r[5])), r: true }, { v: fmtR(num(r[6])), r: true }] }));
    rows.push({ cls: 'tt', cells: [{ v: 'Total' }, null, null, null, { v: fmtR(r2v(inc)), r: true }, { v: fmtR(r2v(ex)), r: true }, { v: fmtR(r2v(inc - ex)), r: true }] });
    const cols = [{ h: 'Year' }, { h: 'From' }, { h: 'To' }, { h: 'Status' }, { h: 'Income', r: true }, { h: 'Expenses', r: true }, { h: 'Net profit', r: true }];
    this.vt.set({ cols, rows });
    this.ex = { title: 'Financial Years Summary', cols, rows: data, totals: ['Total', '', '', '', r2v(inc), r2v(ex), r2v(inc - ex)] };
  }

  // ── Budgets (renderBud 4408 / rBva 4441) ──
  budFyOpts = () => this.fys.map((f) => ({ ...f }));
  async loadBud() {
    this.fys = await this.api.get<FY[]>('/fys');
    if (this.tab() === 'bud') {
      const res = await this.api.get<{ fy: { id: string; name: string; start: string; status: string }; data: Record<string, number[]> }>(`/reports/budget${this.budFy ? '?fy=' + this.budFy : ''}`);
      this.budFy = res.fy.id;
      await this.renderBud(res.fy, res.data);
    } else {
      const cur = this.fys.find((f) => f.id === this.budFy) || this.fys.find((f) => f.is_current) || this.fys[this.fys.length - 1];
      if (!cur) return;
      this.budFy = cur.id;
      const res = await this.api.get<{ data: Record<string, number[]> }>('/reports/budget?fy=' + this.budFy);
      const fin = await this.api.get<{ accounts: FinAcc[] }>('/reports/fin');
      this.rBva(cur, res.data, fin.accounts);
    }
  }
  budEditable = () => this.auth.user()?.role !== 'viewer' && this.fys.find((f) => f.id === this.budFy)?.status !== 'closed';
  budMonths = (fy: { start: string }) => {
    const m0 = parseInt(fy.start.slice(5, 7), 10) - 1; const y0 = parseInt(fy.start.slice(0, 4), 10);
    return Array.from({ length: 12 }, (_, i) => { const m = (m0 + i) % 12; return { label: MONTHS[m] + ' ' + String(y0 + Math.floor((m0 + i) / 12)).slice(2) }; });
  };
  budView = signal<null | { fy: { id: string; name: string; start: string; status: string }; months: { label: string }[]; rows: { code: string; name: string; sec: number; annual: number; months: number[] }[]; net: number[]; msg: string }>(null);
  async renderBud(fy: { id: string; name: string; start: string; status: string }, data: Record<string, number[]>) {
    const accs = await this.api.get<any[]>('/gl/accounts');
    const rows = accs.filter((a: any) => a.active && '1234'.includes(String(a.code)[0]))
      .map((a: any) => ({ code: a.code, name: a.name, sec: [1, 3].includes(+String(a.code)[0]) ? 1 : 2, months: [...(data[a.code] || Array(12).fill(0))] as number[], annual: 0 }));
    rows.forEach((r) => { r.annual = this.sumRow(r); });
    const msg = fy.status === 'closed' ? 'This financial year is closed, so its budget cannot be changed.' : (this.auth.user()?.role === 'viewer' ? 'You have view-only access to budgets.' : '');
    this.budView.set({ fy, months: this.budMonths(fy), rows, net: this.budNetCalc(rows), msg });
    this.ex = { title: 'Budget — ' + fy.name,
      cols: ([{ h: 'Account' }, { h: 'Annual', t: 'm' }] as RepCol[]).concat(this.budMonths(fy).map((m) => ({ h: m.label, t: 'm' }))),
      rows: rows.filter((r) => data[r.code]).map((r) => [`${r.code} — ${r.name}`, r2v(this.sumRow(r)), ...r.months.map(r2v)] as unknown[]) };
    
  }
  sumRow(a: { months: number[] }) { return r2v(a.months.reduce((x, y) => x + (Number(y) || 0), 0)); }
  budSpread(a: { months: number[]; annual: number }, v: number) { // budSpread 4421
    if (Number.isNaN(v) || v < 0) { a.months = Array(12).fill(0); a.annual = 0; this.budNet(); return; }
    const base = Math.floor(v / 12 * 100) / 100; const rem = r2v(v - base * 12);
    a.months = Array.from({ length: 12 }, (_, i) => (i === 11 ? r2v(base + rem) : base));
    a.annual = this.sumRow(a); this.budNet();
  }
  budNetCalc(rows: { code: string; sec: number; months: number[] }[]) { // budNet 4425
    const net = Array(12).fill(0);
    rows.forEach((r) => { const sg = r.sec === 1 ? 1 : -1; r.months.forEach((m, i) => { net[i] += sg * (Number(m) || 0); }); });
    return net.map(r2v);
  }
  budBump() { this.budView.update((b) => (b ? { ...b } : b)); } // force signal emission for in-place edits
  budNet() { this.budView.update((b) => (b ? { ...b, net: this.budNetCalc(b.rows) } : b)); }
  async saveBudget() {
    if (!this.budEditable()) { this.toast.show('You do not have access to this area.'); return; } // deny 4429
    const b = this.budView(); if (!b) return;
    const data: Record<string, number[]> = {};
    b.rows.forEach((r) => { if (r.months.some((x) => x)) data[r.code] = r.months; });
    if (Object.values(data).some((ms) => ms.some((v) => !(v >= 0) || v > 1e10))) { b.msg = 'Budget amounts must be zero or more.'; this.budBump(); return; } // 4430
    try {
      await this.api.put('/reports/budget', { fy: b.fy.id, data });
      this.toast.show('Budget saved for ' + b.fy.name + '.'); // 4431
      b.msg = ''; this.budBump(); 
      await this.loadBud();
    } catch (e) { b.msg = (e as ApiError).message; this.budBump(); }
  }
  async clearBudget() { // clearBudget 4433
    if (!this.budEditable()) { this.toast.show('You do not have access to this area.'); return; }
    const b = this.budView(); if (!b) return;
    if (!confirm('Clear the whole budget for ' + b.fy.name + '?')) return;
    try {
      await this.api.del('/reports/budget?fy=' + b.fy.id);
      this.toast.show('Budget cleared.');
      await this.loadBud();
    } catch (e) { this.toast.show((e as ApiError).message); }
  }

  // ── Budget vs Actual (rBva 4441) ──
  rBva(fy: FY, data: Record<string, number[]>, accounts: FinAcc[]) {
    const drSide = (code: string) => '2456'.includes(String(code)[0]); // dr-normal groups (see model())
    const actualOf = (code: string) => { // actualOf 4440 — the COA balance (all movements, glEnqSync 5588 side rule)
      const a = accounts.find((x) => x.code === code); if (!a) return 0;
      const raw = r2v((drSide(code) ? a.open : -a.open) + a.beforeDr - a.beforeCr + a.dr - a.cr);
      return r2v(drSide(code) ? raw : -raw);
    };
    const I = accounts.filter((a) => [1, 3].includes(+String(a.code)[0]) && (data[a.code] || actualOf(a.code)));
    const E = accounts.filter((a) => [2, 4].includes(+String(a.code)[0]) && (data[a.code] || actualOf(a.code)));
    const rows: VRow[] = []; const exrows: unknown[] = []; const tot = { bi: 0, ai: 0, be: 0, ae: 0 };
    const mk = (a: FinAcc, inc: boolean) => {
      const b = r2v((data[a.code] || []).reduce((x, y) => x + y, 0)), ac = actualOf(a.code), v = inc ? r2v(ac - b) : r2v(b - ac);
      const r = [`${a.code} — ${a.name}`, b, ac, v, b ? Math.round((v / b) * 1000) / 10 : ''] as unknown[];
      rows.push({ cells: [{ v: String(r[0]) }, { v: fmtR(num(r[1])), r: true }, { v: fmtR(num(r[2])), r: true }, { v: fmtR(num(r[3])), r: true }, { v: r[4] === '' ? '' : String(r[4]), r: true }] });
      exrows.push(r); return r;
    };
    I.forEach((a) => { const r = mk(a, true); tot.bi += num(r[1]); tot.ai += num(r[2]); });
    E.forEach((a) => { const r = mk(a, false); tot.be += num(r[1]); tot.ae += num(r[2]); });
    const nb = r2v(tot.bi - tot.be), na = r2v(tot.ai - tot.ae);
    rows.push({ cls: 'tt', cells: [{ v: 'Net profit / (loss)' }, { v: fmtR(nb), r: true }, { v: fmtR(na), r: true }, { v: fmtR(r2v(na - nb)), r: true }, { v: nb ? String(Math.round(((na - nb) / Math.abs(nb)) * 1000) / 10) : '', r: true }] });
    if (!Object.keys(data).length) rows.unshift({ cells: [{ v: 'No budget has been saved for this financial year yet — set one on the Budget tab.', muted: true }, null, null, null, null] }); // 4451
    const cols = [{ h: 'Account' }, { h: 'Budget', r: true }, { h: 'Actual', r: true }, { h: 'Variance', r: true }, { h: 'Variance %', r: true }];
    this.vt.set({ cols, rows });
    this.ex = { title: 'Budget vs Actual — ' + fy.name, cols, rows: exrows as unknown[][],
      totals: ['Net profit / (loss)', nb, na, r2v(na - nb), nb ? Math.round(((na - nb) / Math.abs(nb)) * 1000) / 10 : ''] };
  }

  // ── Asset Register + Depreciation Schedule (rAssets 4134 / rDep 4142) ──
  setAssets(rows: any[]) {
    this.data = rows.map((a) => ({ ...a, ty: a.atype || 'company', valued: (a.atype || 'company') !== 'customer' }));
    if (this.tab() === 'dep') this.rDep(); else this.rAssets();
    
  }
  rAssets() {
    const c = this.fvals['f_cust'], k = this.fvals['f_cat'], st = this.fvals['f_st'], ty = this.fvals['f_type']; let C = 0, A = 0;
    const list = this.data.filter((a: any) => (!c || (c === '-' ? !a.custName : a.custName === c)) && (!k || a.cat === k) && (!st || a.status === st) && (!ty || a.ty === ty));
    const out: VRow[] = []; const exrows: unknown[][] = [];
    list.forEach((a: any) => {
      const v = a.valued, dd = v ? r2v(a.doneAll) : 0;
      if (v && a.status !== 'Disposed') { C += a.cost; A += dd; }
      out.push({ cells: [{ v: a.code }, { v: a.name }, { v: ({ company: 'Company Asset', warehouse: 'Warehouse (Inventory)', customer: 'Customer Asset' } as Record<string, string>)[a.ty] }, { v: a.cat ?? '' }, { v: a.custName || (a.ty === 'warehouse' ? 'No owner' : 'Unassigned') }, { v: a.date ? fmtD(a.date, 1) : '' }, { v: a.status }, { v: v ? fmtR(a.cost) : '', r: true }, { v: v ? fmtR(r2v(dd)) : '', r: true }, { v: v ? fmtR(r2v(a.cost - dd)) : '', r: true }] });
      exrows.push([a.code, a.name, ({ company: 'Company Asset', warehouse: 'Warehouse (Inventory)', customer: 'Customer Asset' } as Record<string, string>)[a.ty], a.cat ?? '', a.custName || (a.ty === 'warehouse' ? 'No owner' : 'Unassigned'), a.date || '', a.status, v ? a.cost : '', v ? r2v(dd) : '', v ? r2v(a.cost - dd) : '']);
    });
    out.push({ cls: 'tt', cells: [{ v: 'Total (company & warehouse, active)' }, null, null, null, null, null, null, { v: fmtR(r2v(C)), r: true }, { v: fmtR(r2v(A)), r: true }, { v: fmtR(r2v(C - A)), r: true }] });
    const cols = [{ h: 'Code' }, { h: 'Description' }, { h: 'Type' }, { h: 'Category' }, { h: 'Customer / Owner' }, { h: 'Purchased' }, { h: 'Status' }, { h: 'Cost', r: true }, { h: 'Accum. dep.', r: true }, { h: 'Net book value', r: true }];
    this.vt.set({ cols, rows: out });
    this.ex = { title: 'Asset Register', cols, rows: exrows, totals: ['Total (company & warehouse, active)', '', '', '', '', '', '', r2v(C), r2v(A), r2v(C - A)] };
  }
  rDep() {
    const m = this.depMonth; let C = 0, MM = 0, A = 0, NN = 0;
    const list = this.data.filter((a: any) => a.ty === 'company' && (a.date || '').slice(0, 7) <= m);
    const out: VRow[] = []; const exrows: unknown[][] = [];
    list.forEach((a: any) => {
      const mo = r2v(a.postedAmt), acc = r2v(a.doneTo); C += a.cost; MM += mo; A += acc; NN += a.cost - acc;
      out.push({ cells: [{ v: a.code }, { v: a.name }, { v: a.cat ?? '' }, { v: String(a.life), r: true }, { v: fmtR(a.monthly), r: true }, { v: fmtR(mo), r: true }, { v: fmtR(acc), r: true }, { v: fmtR(r2v(a.cost - acc)), r: true }, { v: fmtR(a.cost), r: true }] });
      exrows.push([a.code, a.name, a.cat ?? '', a.life, a.monthly, mo, acc, r2v(a.cost - acc), a.cost]);
    });
    out.push({ cls: 'tt', cells: [{ v: 'Total' }, null, null, null, null, { v: fmtR(r2v(MM)), r: true }, { v: fmtR(r2v(A)), r: true }, { v: fmtR(r2v(NN)), r: true }, { v: fmtR(r2v(C)), r: true }] });
    const cols = [{ h: 'Code' }, { h: 'Description' }, { h: 'Category' }, { h: 'Life (months)', r: true }, { h: 'Monthly charge', r: true }, { h: 'Posted in month', r: true }, { h: 'Accum. to month end', r: true }, { h: 'NBV', r: true }, { h: 'Cost', r: true }];
    this.vt.set({ cols, rows: out });
    this.ex = { title: 'Depreciation Schedule — ' + m, cols, rows: exrows, totals: ['Total', '', '', '', '', r2v(MM), r2v(A), r2v(NN), r2v(C)] };
  }

  // ── Stock on Hand (rStk 5255) ──
  rStk(list: any[]) {
    let V = 0;
    const out: VRow[] = []; const exrows: unknown[][] = [];
    list.forEach((r) => {
      const avail = r2v(r.qty - r.issued); V += r.value;
      out.push({ cells: [{ v: r.sku }, { v: String(r.qty), r: true }, { v: String(r.issued), r: true }, { v: String(avail), r: true }, { v: fmtR(r.cost), r: true }, { v: fmtR(r.value), r: true }] });
      exrows.push([r.sku, r.qty, r.issued, avail, r.cost, r.value]);
    });
    out.push({ cls: 'tt', cells: [{ v: 'Total' }, null, null, null, null, { v: fmtR(r2v(V)), r: true }] });
    const cols = [{ h: 'Item' }, { h: 'On hand', r: true }, { h: 'Issued on requests', r: true }, { h: 'Available', r: true }, { h: 'Unit cost', r: true }, { h: 'Value', r: true }];
    this.vt.set({ cols, rows: out });
    this.ex = { title: 'Stock on Hand', cols, rows: exrows, totals: ['Total', '', '', '', '', r2v(V)] };
  }

  // ── ops panels ──
  rOpsLoad = async () => {
    const paths: Record<string, string> = { con: '/contracts', bill: '/billing/invoices', sales: '/billing/invoices', calls: '/calls', wo: '/workorders', po: '/purchase-orders', grn: '/grns', sinv: '/supplier-invoices', preq: '/parts/requests', pret: '/parts/returns' };
    const t = this.tab();
    if (t === 'meter') {
      this.data = await this.api.get<any[]>('/billing/periods');
      if (!this.fvals['f_per']) this.fvals['f_per'] = (this.periods()[0] as any)?.id ?? '';
      this.extra = await this.api.get<any[]>('/billing/meters?per=' + this.fvals['f_per']);
      this.rMeter();
      return;
    }
    this.data = (await this.api.get<any[]>(paths[t])) ?? [];
    if (!Array.isArray(this.data)) this.data = (this.data as { rows?: any[] }).rows ?? []; // /parts/returns returns {rows, issued}
    if (t === 'pret') this.extra = await this.api.get<any[]>('/inv/items'); // item names (x.item 5253)
    this.rOps();
  };
  rOps = () => {
    const t = this.tab();
    if (t === 'con') this.rCon();
    else if (t === 'bill') this.rBill();
    else if (t === 'meter') this.rMeter();
    else if (t === 'calls') this.rCalls();
    else if (t === 'wo') this.rWo();
    else if (t === 'sales') this.rSales();
    else if (t === 'po') this.rPo();
    else if (t === 'grn') this.rGrn();
    else if (t === 'sinv') this.rSinv();
    else if (t === 'preq') this.rPreq();
    else if (t === 'pret') this.rPret();
  };
  private static ATYPE_NAMES: Record<string, string> = { company: 'Company Asset', warehouse: 'Warehouse (Inventory)', customer: 'Customer Asset' };
  private static FREQ: Record<number, string> = { 1: 'Monthly', 3: 'Quarterly', 6: '6-monthly', 12: 'Annually' };

  rCon() { // rCon 4147
    let rev = 0; const rows: VRow[] = []; const exrows: unknown[][] = [];
    this.data.filter((c: any) => !this.fvals['f_st'] || c.stat === this.fvals['f_st']).filter((c: any) => !this.fvals['f_cust'] || c.custName === this.fvals['f_cust']).forEach((c: any) => {
      (c.lines || []).forEach((l: any) => {
        const e = lineEndOfL(l), per = r2v(l.amt * c.freq);
        if (c.stat === 'Active' && lineActive(l)) rev += l.amt;
        rows.push({ cells: [{ v: c.code }, { v: c.custName }, { v: l.type }, { v: (l.descr || '') + (l.asset ? ' [' + l.asset + ']' : '') }, { v: fmtD(l.start, 1) }, { v: lineEndOfL(l) ? fmtD(lineEndOfL(l), 1) : 'Evergreen' }, { v: String(l.term), r: true }, { v: ReportsComponent.FREQ[c.freq] || String(c.freq) }, { v: fmtR(per), r: true }, { v: c.stat }, { v: c.mgrName || '' }, { v: c.salesName || '' }] });
        exrows.push([c.code, c.custName, l.type, (l.descr || '') + (l.asset ? ' [' + l.asset + ']' : ''), l.start, e, l.term, ReportsComponent.FREQ[c.freq] || String(c.freq), per, c.stat, c.mgrName || '', c.salesName || '']);
      });
      (c.meters || []).forEach((m: any) => {
        rows.push({ cells: [{ v: c.code }, { v: c.custName }, { v: 'Meter: ' + m.type }, { v: `${m.asset} @ R ${(num(m.rate)).toFixed(4)}/page` }, { v: fmtD(c.start, 1) }, { v: '' }, { v: '' }, { v: 'Per usage' }, { v: fmtR(0), r: true }, { v: c.stat }, { v: c.mgrName || '' }, { v: c.salesName || '' }] });
        exrows.push([c.code, c.custName, 'Meter: ' + m.type, `${m.asset} @ R ${(num(m.rate)).toFixed(4)}/page`, c.start, '', '', 'Per usage', 0, c.stat, c.mgrName || '', c.salesName || '']);
      });
    });
    rows.push({ cls: 'tt', cells: [{ v: 'Monthly recurring revenue (active, excl VAT)' }, null, null, null, null, null, null, null, { v: fmtR(r2v(rev)), r: true }, null, null, null] });
    const cols = [{ h: 'Contract' }, { h: 'Customer' }, { h: 'Type' }, { h: 'Description' }, { h: 'Start' }, { h: 'End' }, { h: 'Term (mo)', r: true }, { h: 'Billing' }, { h: 'Per billing (excl VAT)', r: true }, { h: 'Status' }, { h: 'Contract Manager' }, { h: 'Sales Person' }];
    this.vt.set({ cols, rows });
    this.ex = { title: 'Contract Schedule', cols, rows: exrows, totals: ['Monthly recurring revenue (active, excl VAT)', '', '', '', '', '', '', '', r2v(rev), '', '', ''] };
  }
  rBill() { // rBill 4154
    const f = this.fvals['f_from'], t2 = this.fvals['f_to'], c = this.fvals['f_cust']; let X = 0, V = 0, T = 0;
    const list = this.data.filter((b: any) => (!f || b.date >= f) && (!t2 || b.date <= t2) && (!c || b.custName === c)).slice().sort((a: any, b: any) => (a.date < b.date ? -1 : 1));
    const cols = [{ h: 'Invoice' }, { h: 'Date' }, { h: 'Contract' }, { h: 'Customer' }, { h: 'Items' }, { h: 'Excl. VAT', r: true }, { h: 'VAT', r: true }, { h: 'Total', r: true }];
    const rows: VRow[] = []; const exrows: unknown[][] = [];
    list.forEach((b: any) => { X += num(b.ex); V += num(b.vat); T += num(b.tot);
      const items = (b.lines || []).map((l: any) => l.type).filter((x: string, i: number, a: string[]) => a.indexOf(x) === i).join(', ');
      rows.push({ cells: [{ v: b.id }, { v: fmtD(b.date, 1) }, { v: b.con }, { v: b.custName }, { v: items }, { v: fmtR(num(b.ex)), r: true }, { v: fmtR(num(b.vat)), r: true }, { v: fmtR(num(b.tot)), r: true }] });
      exrows.push([b.id, b.date, b.con, b.custName, items, num(b.ex), num(b.vat), num(b.tot)]); });
    rows.push({ cls: 'tt', cells: [{ v: 'Total' }, null, null, null, null, { v: fmtR(r2v(X)), r: true }, { v: fmtR(r2v(V)), r: true }, { v: fmtR(r2v(T)), r: true }] });
    this.vt.set({ cols, rows });
    this.ex = { title: 'Contract Billing Summary', cols, rows: exrows, totals: ['Total', '', '', '', '', r2v(X), r2v(V), r2v(T)] };
  }
  rMeter() { // rMeter 4159
    const cu = this.fvals['f_cust']; let P = 0, A = 0;
    const rows: VRow[] = []; const exrows: unknown[][] = [];
    this.extra.filter((u: any) => !cu || u.custName === cu).forEach((u: any) => {
      const st = u.billed ? 'Billed' : (u.end != null ? 'Captured' : 'Pending');
      if (u.end != null) { P += num(u.pages); A += num(u.amt); }
      rows.push({ cells: [{ v: u.con }, { v: u.custName }, { v: u.asset }, { v: u.type }, { v: fmtR(num(u.rateNow ?? u.rate)), r: true }, { v: String(u.opening ?? ''), r: !!(u.op ?? true) }, { v: u.end == null ? '' : String(u.end), r: true }, { v: u.end == null ? '' : String(u.pages), r: true }, { v: u.end == null ? fmtR(0) : fmtR(num(u.amt)), r: true }, { v: st }] });
      exrows.push([u.con, u.custName, u.asset, u.type, num(u.rateNow ?? u.rate), u.opening ?? '', u.end == null ? '' : u.end, u.end == null ? '' : u.pages, u.end == null ? 0 : num(u.amt), st]);
    });
    rows.push({ cls: 'tt', cells: [{ v: 'Total' }, null, null, null, null, null, null, { v: String(P), r: true }, { v: fmtR(r2v(A)), r: true }, null] });
    const cols = [{ h: 'Contract' }, { h: 'Customer' }, { h: 'Asset' }, { h: 'Meter' }, { h: 'Rate / page', r: true }, { h: 'Opening', r: true }, { h: 'Closing', r: true }, { h: 'Pages', r: true }, { h: 'Charge (excl VAT)', r: true }, { h: 'Status' }];
    const per = this.fvals['f_per'];
    this.vt.set({ cols, rows });
    this.ex = { title: 'Meter Usage' + (per ? ' — ' + per : ''), cols, rows: exrows, totals: ['Total', '', '', '', '', '', '', P, r2v(A), ''] };
  }
  rCalls() { // rCalls 4165
    const f = this.fvals['f_from'], t2 = this.fvals['f_to'], te = this.fvals['f_tech'], st = this.fvals['f_st'], cu = this.fvals['f_cust']; let n = 0, dsum = 0, dn = 0;
    const list = this.data
      .filter((c: any) => (!f || c.logged >= f) && (!t2 || c.logged <= t2) && (!te || (te === '-' ? !c.tech : c.techName === te)) && (!st || (st === 'open' ? !['Completed', 'Cancelled'].includes(c.status) : c.status === st)) && (!cu || c.custName === cu))
      .slice().sort((a: any, b: any) => (a.logged < b.logged ? -1 : 1));
    const rows: VRow[] = []; const exrows: unknown[][] = [];
    let cost = 0;
    list.forEach((c: any) => {
      const dr = c.status === 'Completed' && c.completed ? daysBetween(c.logged, c.completed) : null;
      if (dr != null) { dsum += dr; dn++; } n++; cost += num(c.cost);
      rows.push({ cells: [{ v: c.code }, { v: c.custName }, { v: c.asset || '' }, { v: c.type || '' }, { v: c.pri || '' }, { v: c.techName || 'Unassigned' }, { v: fmtD(c.logged, 1) }, { v: c.completed ? fmtD(c.completed, 1) : '' }, { v: dr == null ? '' : String(dr), r: true }, { v: c.status }, { v: fmtR(num(c.cost)), r: true }] });
      exrows.push([c.code, c.custName, c.asset || '', c.type || '', c.pri || '', c.techName || 'Unassigned', c.logged, c.completed || '', dr ?? '', c.status, num(c.cost)]);
    });
    rows.push({ cls: 'tt', cells: [{ v: 'Total calls: ' + n + (dn ? ' · average ' + (dsum / dn).toFixed(1) + ' days to complete' : '') }, null, null, null, null, null, null, null, null, null, { v: fmtR(r2v(cost)), r: true }] });
    const cols = [{ h: 'Call' }, { h: 'Customer' }, { h: 'Asset' }, { h: 'Type' }, { h: 'Priority' }, { h: 'Technician' }, { h: 'Logged' }, { h: 'Completed' }, { h: 'Days to complete', r: true }, { h: 'Status' }, { h: 'Cost', r: true }];
    this.vt.set({ cols, rows });
    this.ex = { title: 'Service Calls', cols, rows: exrows,
      totals: ['Total calls: ' + n + (dn ? ' · average ' + (dsum / dn).toFixed(1) + ' days to complete' : ''), '', '', '', '', '', '', '', '', '', r2v(cost)] };
  }
  rWo() { // REP_RENDER.wo 5239
    const f = this.fvals['f_st']; let P = 0;
    const list = this.data.filter((w: any) => !f || w.status === f).slice().sort((a: any, b: any) => (a.code < b.code ? -1 : 1));
    const rows: VRow[] = []; const exrows: unknown[][] = [];
    list.forEach((w: any) => {
      const pt = r2v(num(w.partsCost)); P += pt;
      rows.push({ cells: [{ v: w.code }, { v: w.call }, { v: w.custName }, { v: w.assetName || w.asset || '' }, { v: w.techName || 'Unassigned' }, { v: w.sched ? fmtD(w.sched, 1) : '' }, { v: w.status }, { v: String(num(w.hours)), r: true }, { v: fmtR(pt), r: true }] });
      exrows.push([w.code, w.call, w.custName, w.assetName || w.asset || '', w.techName || 'Unassigned', w.sched || '', w.status, num(w.hours), pt]);
    });
    rows.push({ cls: 'tt', cells: [{ v: 'Total: ' + rows.length }, null, null, null, null, null, null, null, { v: fmtR(r2v(P)), r: true }] });
    const cols = [{ h: 'Work order' }, { h: 'Call' }, { h: 'Customer' }, { h: 'Asset' }, { h: 'Technician' }, { h: 'Scheduled' }, { h: 'Status' }, { h: 'Hours', r: true }, { h: 'Parts (excl VAT)', r: true }];
    this.vt.set({ cols, rows });
    this.ex = { title: 'Work Orders', cols, rows: exrows, totals: ['Total: ' + exrows.length, '', '', '', '', '', '', '', r2v(P)] };
  }
  rSales() { // REP_RENDER.sales 5241
    const f = this.fvals['f_from'], t2 = this.fvals['f_to']; const m: Record<string, { n: number; ex: number; vat: number; tot: number }> = {};
    this.data.filter((b: any) => (!f || b.date >= f) && (!t2 || b.date <= t2)).forEach((b: any) => {
      const o = m[b.custName] || (m[b.custName] = { n: 0, ex: 0, vat: 0, tot: 0 }); o.n++; o.ex += num(b.ex); o.vat += num(b.vat); o.tot += num(b.tot);
    });
    const rows: VRow[] = []; let N = 0;
    Object.keys(m).sort().forEach((k) => {
      N += m[k].n;
      rows.push({ cells: [{ v: k }, { v: String(m[k].n), r: true }, { v: fmtR(r2v(m[k].ex)), r: true }, { v: fmtR(r2v(m[k].vat)), r: true }, { v: fmtR(r2v(m[k].tot)), r: true }] });
    });
    const S = (k: 'ex' | 'vat' | 'tot') => r2v(Object.values(m).reduce((a, o) => a + o[k], 0));
    rows.push({ cls: 'tt', cells: [{ v: 'Total' }, { v: String(N), r: true }, { v: fmtR(S('ex')), r: true }, { v: fmtR(S('vat')), r: true }, { v: fmtR(S('tot')), r: true }] });
    const cols = [{ h: 'Customer' }, { h: 'Invoices', r: true }, { h: 'Excl. VAT', r: true }, { h: 'VAT', r: true }, { h: 'Total', r: true }];
    this.vt.set({ cols, rows });
    this.ex = { title: 'Sales by Customer', cols,
      rows: Object.keys(m).sort().map((k) => [k, m[k].n, r2v(m[k].ex), r2v(m[k].vat), r2v(m[k].tot)]) as unknown[][], totals: ['Total', N, S('ex'), S('vat'), S('tot')] };
  }
  rPo() { // REP_RENDER.po 5244
    const f = this.fvals['f_st'], su = this.fvals['f_sup']; let X = 0, V = 0, T = 0;
    const list = this.data.filter((o: any) => (!f || o.status === f) && (!su || o.supName === su)).slice().sort((a: any, b: any) => (a.id < b.id ? -1 : 1));
    const rows: VRow[] = []; const exrows: unknown[][] = [];
    list.forEach((o: any) => {
      const exv = r2v(num(o.tot?.ex)), vatv = r2v(num(o.tot?.vat)), inc = r2v(num(o.tot?.inc));
      X += exv; V += vatv; T += inc;
      rows.push({ cells: [{ v: o.id }, { v: o.supName }, { v: fmtD(o.date, 1) }, { v: fmtD(o.due, 1) }, { v: o.status }, { v: fmtR(exv), r: true }, { v: fmtR(vatv), r: true }, { v: fmtR(inc), r: true }] });
      exrows.push([o.id, o.supName, o.date, o.due, o.status, exv, vatv, inc]);
    });
    rows.push({ cls: 'tt', cells: [{ v: 'Total' }, null, null, null, null, { v: fmtR(r2v(X)), r: true }, { v: fmtR(r2v(V)), r: true }, { v: fmtR(r2v(T)), r: true }] });
    const cols = [{ h: 'Purchase order' }, { h: 'Supplier' }, { h: 'Ordered' }, { h: 'Delivery by' }, { h: 'Status' }, { h: 'Excl. VAT', r: true }, { h: 'VAT', r: true }, { h: 'Total', r: true }];
    this.vt.set({ cols, rows });
    this.ex = { title: 'Purchase Orders', cols, rows: exrows, totals: ['Total', '', '', '', '', r2v(X), r2v(V), r2v(T)] };
  }
  rGrn() { // REP_RENDER.grn 5247
    const list = this.data.slice().sort((a: any, b: any) => (a.id < b.id ? -1 : 1));
    const rows: VRow[] = []; const exrows: unknown[][] = []; let V = 0;
    list.forEach((g: any) => {
      const v = r2v((g.lines || []).reduce((t: number, l: any) => t + num(l.qty) * num(l.price), 0)); V += v;
      rows.push({ cells: [{ v: g.id }, { v: g.po }, { v: g.supName }, { v: fmtD(g.date, 1) }, { v: g.dn || '' }, { v: fmtR(v), r: true }, { v: g.inv || 'Not invoiced' }] });
      exrows.push([g.id, g.po, g.supName, g.date, g.dn || '', v, g.inv || 'Not invoiced']);
    });
    rows.push({ cls: 'tt', cells: [{ v: 'Total' }, null, null, null, null, { v: fmtR(r2v(V)), r: true }, null] });
    const cols = [{ h: 'GRN' }, { h: 'Purchase order' }, { h: 'Supplier' }, { h: 'Received' }, { h: 'Delivery note' }, { h: 'Value (excl VAT)', r: true }, { h: 'Invoice' }];
    this.vt.set({ cols, rows });
    this.ex = { title: 'Goods Received', cols, rows: exrows, totals: ['Total', '', '', '', '', r2v(V), ''] };
  }
  rSinv() { // REP_RENDER.sinv 5249
    const list = this.data.slice().sort((a: any, b: any) => (a.id < b.id ? -1 : 1));
    const rows: VRow[] = []; const exrows: unknown[][] = [];
    list.forEach((n: any) => {
      rows.push({ cells: [{ v: n.id }, { v: n.supName }, { v: n.theirNo }, { v: fmtD(n.date, 1) }, { v: n.grn || '' }, { v: n.po || '' }, { v: fmtR(num(n.ex)), r: true }, { v: fmtR(num(n.vat)), r: true }, { v: fmtR(num(n.tot)), r: true }] });
      exrows.push([n.id, n.supName, n.theirNo, n.date, n.grn || '', n.po || '', num(n.ex), num(n.vat), num(n.tot)]);
    });
    const S = (k: string) => r2v(list.reduce((t: number, n: any) => t + num(n[k]), 0));
    rows.push({ cls: 'tt', cells: [{ v: 'Total' }, null, null, null, null, null, { v: fmtR(S('ex')), r: true }, { v: fmtR(S('vat')), r: true }, { v: fmtR(S('tot')), r: true }] });
    const cols = [{ h: 'Our ref' }, { h: 'Supplier' }, { h: 'Supplier invoice' }, { h: 'Date' }, { h: 'GRN' }, { h: 'Purchase order' }, { h: 'Excl. VAT', r: true }, { h: 'VAT', r: true }, { h: 'Total', r: true }];
    this.vt.set({ cols, rows });
    this.ex = { title: 'Supplier Invoices', cols, rows: exrows, totals: ['Total', '', '', '', '', '', S('ex'), S('vat'), S('tot')] };
  }
  rPreq() { // REP_RENDER.preq 5251
    const f = this.fvals['f_st'];
    const list = this.data.filter((r: any) => !f || r.status === f).slice().sort((a: any, b: any) => (a.code < b.code ? -1 : 1));
    const rows: VRow[] = []; const exrows: unknown[][] = [];
    list.forEach((r: any) => {
      rows.push({ cells: [{ v: r.code }, { v: fmtD(r.date, 1) }, { v: r.itemName || r.sku }, { v: String(r.qty), r: true }, { v: r.wo || '' }, { v: r.byName || '' }, { v: r.status }, { v: r.issued ? fmtD(r.issued, 1) : '' }] });
      exrows.push([r.code, r.date, r.itemName || r.sku, r.qty, r.wo || '', r.byName || '', r.status, r.issued || '']);
    });
    rows.push({ cls: 'tt', cells: [{ v: 'Total: ' + list.length }, null, null, null, null, null, null, null] });
    const cols = [{ h: 'Request' }, { h: 'Date' }, { h: 'Item' }, { h: 'Qty', r: true }, { h: 'Work order' }, { h: 'Requested by' }, { h: 'Status' }, { h: 'Issued' }];
    this.vt.set({ cols, rows });
    this.ex = { title: 'Part Requests', cols, rows: exrows, totals: ['Total: ' + exrows.length, '', '', '', '', '', '', ''] };
  }
  rPret() { // REP_RENDER.pret 5253 — item names joined from /inv/items
    const list = this.data.slice().sort((a: any, b: any) => (a.code < b.code ? -1 : 1));
    const nameOf = (sku: string) => { const it = (this.extra || []).find((i: any) => i.sku === sku); return it ? `${sku} — ${it.name}` : sku; };
    const rows: VRow[] = []; const exrows: unknown[][] = [];
    list.forEach((x: any) => {
      rows.push({ cells: [{ v: x.code }, { v: fmtD(x.date, 1) }, { v: x.req }, { v: nameOf(x.sku) }, { v: String(x.qty), r: true }, { v: x.cond }, { v: x.reason || '' }] });
      exrows.push([x.code, x.date, x.req, nameOf(x.sku), x.qty, x.cond, x.reason || '']);
    });
    rows.push({ cls: 'tt', cells: [{ v: 'Total: ' + list.length }, null, null, null, null, null, null] });
    const cols = [{ h: 'Return' }, { h: 'Date' }, { h: 'Part request' }, { h: 'Item' }, { h: 'Qty', r: true }, { h: 'Condition' }, { h: 'Reason' }];
    this.vt.set({ cols, rows });
    this.ex = { title: 'Part Returns', cols, rows: exrows, totals: ['Total: ' + exrows.length, '', '', '', '', '', ''] };
  }

  exportAs(fmt: 'pdf' | 'xlsx' | 'csv') {
    if (!this.ex) return;
    const spec: ExportSpec = { title: this.ex.title, sections: [{ cols: this.ex.cols as RepCol[], rows: this.ex.rows as unknown[][], totals: this.ex.totals }] };
    if (!this.exp.download(spec, fmt)) this.toast.show('Nothing to export.');
  }
}
