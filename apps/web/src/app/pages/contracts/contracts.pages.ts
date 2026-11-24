// Contract Management (renderContracts 3456 / openContract+saveContract 3511–3538).
import { Component, ChangeDetectorRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService, ApiError, ToastService } from '../../core/api';
import { fmtR, fmtD, todayIso } from '../../core/fmt';

interface CLine { id: number; type: string; asset: string; descr: string; amt: number; term: number; start: string; funder: string; lastBilled?: string; ever?: boolean; active?: boolean; needsFunder?: boolean; endRaw?: string; }
interface CMeter { id: number; asset: string; type: string; rate: number; start: number; hasReadings?: number; }
interface Con { code: string; ref: string; status: string; start: string; freq: number; esc: number; mgr: string; sales: string; mgrName?: string; salesName?: string; custName: string; lines: CLine[]; meters: CMeter[]; end?: string; stat?: string; }

const FREQ: Record<number, string> = { 1: 'Monthly', 3: 'Quarterly', 6: '6-monthly', 12: 'Annually' };
const lineEndOfL = (l: { ever?: boolean; start: string; term: number }) => {
  if (l.ever) return '';
  const d = new Date(l.start); d.setMonth(d.getMonth() + l.term); d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
};
const lineActive = (l: CLine) => !l.lastBilled || !lineEndOfL(l) || lineEndOfL(l) >= todayIso();

@Component({
  selector: 'app-contracts-list',
  imports: [FormsModule, RouterLink],
  template: `
  <div class="g3" id="con-stats">
    <div class="card"><div class="stat-lbl">Active contracts</div><div class="stat-val">{{act()}}</div></div>
    <div class="card"><div class="stat-lbl">Monthly recurring revenue (excl VAT)</div><div class="stat-val">{{fmtR(mrr())}}</div></div>
    <div class="card"><div class="stat-lbl">Items ending within 60 days</div><div class="stat-val">{{exp()}}</div></div>
  </div>
  <div class="card">
    <div class="card-title">Contracts <a class="btn btn-p btn-sm" routerLink="/contracts/add"><i class="ti ti-plus"></i> Add Contract</a></div>
    <div class="fr" style="margin-bottom:8px">
      <div class="fg"><label>Search</label><input [(ngModel)]="q" (ngModelChange)="render()" placeholder="Contract no. or customer"></div>
      <div class="fg"><label>Status</label>
        <select [(ngModel)]="f" (ngModelChange)="render()"><option value="">All</option><option>Active</option><option>Draft</option><option>Suspended</option><option>Expired</option><option>Cancelled</option></select></div></div>
    <table><thead><tr><th>Contract</th><th>Customer</th><th>Items &amp; terms</th><th>Period</th><th>Billing</th>
      <th class="tr">Per billing (excl VAT)</th><th>Status</th><th style="width:190px"></th></tr></thead><tbody>
      @for (c of view(); track c.code) {
        <tr>
          <td>{{c.code}}@if (c.ref) {<div style="font-size:11px;color:var(--txm)">{{c.ref}}</div>}</td>
          <td>{{c.custName}}@if (c.mgrName || c.salesName) {<div style="font-size:11px;color:var(--txm)">{{staffSub(c)}}</div>}</td>
          <td>@for (l of c.lines; track l.id) {<div style="font-size:12px"><span class="chip c-nt">{{l.type}}</span> {{l.descr}}@if (l.asset) { · {{l.asset}} } · {{l.ever ? l.term + ' mo min, then rolling' : l.term + ' mo'}}@if (l.funder) { · {{l.funder}} }</div>}
            @for (m of c.meters; track m.id) {<div style="font-size:12px"><span class="chip c-bl">Meter</span> {{m.type}} · {{m.asset}} · R {{m.rate.toFixed(4)}}/page · start {{m.start.toLocaleString('en-ZA')}}</div>}</td>
          <td>{{fmtD(c.start, 1)}} – {{c.end ? fmtD(c.end, 1) : 'Evergreen'}}</td>
          <td>{{freqLbl(c.freq)}}@if (c.esc) { · +{{c.esc}}%/yr }</td>
          <td class="tr">{{fmtR(per(c))}}</td>
          <td><span class="chip" [class.c-ok]="c.stat === 'Active'" [class.c-nt]="c.stat === 'Draft'" [class.c-wn]="c.stat !== 'Active' && c.stat !== 'Draft'">{{c.stat}}</span></td>
          <td><a class="btn btn-s btn-sm" [routerLink]="['/contracts/add']" [queryParams]="{code: c.code}">Edit</a>
            @if (c.status === 'Active') { <button class="btn btn-s btn-sm" (click)="setStatus(c, 'Suspended')">Suspend</button> }
            @if (c.status === 'Suspended' || c.status === 'Draft') { <button class="btn btn-s btn-sm" (click)="setStatus(c, 'Active')">Activate</button> }</td>
        </tr>
      } @empty { <tr><td colspan="8" style="text-align:center;color:var(--txm)">No contracts match.</td></tr> }
    </tbody></table></div>`,
})
export class ContractsListComponent {
  FREQ = FREQ;
  fmtR = fmtR; fmtD = fmtD;
  staffSub = (c: Con) => [c.mgrName ? 'Mgr: ' + c.mgrName : '', c.salesName ? 'Sales: ' + c.salesName : ''].filter(Boolean).join(' · ');
  freqLbl = (f: number) => FREQ[f] || f + ' mo';
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  all = signal<Con[]>([]);
  q = ''; f = '';
  act = signal(0); mrr = signal(0); exp = signal(0);
  view = signal<Con[]>([]);

  constructor() { void this.reload(); }
  async reload() {
    this.all.set(await this.api.get<Con[]>('/contracts'));
    this.render(); this.cdr.detectChanges();
  }
  render() {
    const t = todayIso(), in60 = fmtD; void in60;
    const in60d = new Date(); in60d.setDate(in60d.getDate() + 60);
    const in60s = in60d.toISOString().slice(0, 10);
    let act = 0, mrr = 0, exp = 0;
    this.all().forEach((c) => {
      if (c.stat !== 'Active') return;
      act++;
      c.lines.forEach((l) => { if (lineActive(l)) { mrr += l.amt; const e = lineEndOfL(l); if (e && e <= in60s) exp++; } });
    });
    this.act.set(act); this.mrr.set(mrr); this.exp.set(exp);
    const ql = this.q.toLowerCase();
    this.view.set(this.all().filter((c) => (!this.f || c.stat === this.f) && (!ql || (c.code + ' ' + c.custName).toLowerCase().includes(ql))));
  }
  per = (c: Con) => c.lines.filter(lineActive).reduce((t, l) => t + l.amt * c.freq, 0);
  async setStatus(c: Con, st: string) {
    try { await this.api.post('/contracts/' + c.code + '/status', { status: st }); await this.reload(); }
    catch (e) { this.toast.show((e as ApiError).message); }
  }
}

// Add/Edit Contract (openContract 3511 / saveContract 3522). Field-level validation lives server-side
// (validateContract 3493 + validateMeters + validateStaff ported verbatim) — the form shows the first error.
@Component({
  selector: 'app-contract-form',
  imports: [FormsModule, RouterLink],
  template: `
  <div class="card" style="max-width:1100px">
    <div class="card-title">{{edit ? 'Edit Contract ' + edit : 'Add Contract'}}
      <a class="btn btn-s btn-sm" routerLink="/contracts/list"><i class="ti ti-x"></i> Cancel</a></div>
    <div class="fr">
      <div class="fg"><label>Customer *</label>
        <select [(ngModel)]="f.cust" [disabled]="billed">
          <option value="">— Select —</option>@for (c of custs(); track c.code) { <option [value]="c.code">{{c.name}}</option> }</select></div>
      <div class="fg"><label>Status</label>
        <select [(ngModel)]="f.status"><option>Active</option><option>Draft</option><option>Suspended</option><option>Cancelled</option></select></div>
      <div class="fg"><label>Customer PO / reference</label><input [(ngModel)]="f.ref" maxlength="60"></div></div>
    <div class="fr">
      <div class="fg"><label>Contract start date *</label><input [(ngModel)]="f.start" type="date" [disabled]="billed"></div>
      <div class="fg"><label>Billing frequency</label>
        <select [(ngModel)]="f.freq" [disabled]="billed"><option value="1">Monthly</option><option value="3">Quarterly</option><option value="6">6-monthly</option><option value="12">Annually</option></select></div>
      <div class="fg"><label>Escalation % per year</label><input [(ngModel)]="f.esc" type="number" min="0" max="50" step="0.1" [disabled]="billed"></div></div>
    <div class="fr">
      <div class="fg"><label>Contract Manager</label>
        <select [(ngModel)]="f.mgr"><option value=""></option>@for (e of staff(); track e.code) { @if (e.mgr) { <option [value]="e.code">{{e.name}}</option> } }</select></div>
      <div class="fg"><label>Sales Person</label>
        <select [(ngModel)]="f.sales"><option value=""></option>@for (e of staff(); track e.code) { @if (e.sales) { <option [value]="e.code">{{e.name}}</option> } }</select></div></div>
    <h3 style="margin:14px 0 6px">Billable items</h3>
    <table><thead><tr><th style="width:150px">Type</th><th style="width:220px">Asset</th><th>Description</th>
      <th style="width:120px">Amount (R)</th><th style="width:80px">Term (mo)</th><th style="width:130px">Start</th><th style="width:140px">Funder</th><th style="width:40px"></th></tr></thead><tbody>
      @for (l of f.lines; track $index; let i = $index) {
        <tr [title]="l.lastBilled ? 'Already billed — type, asset, amount, term and start are locked.' : ''">
          <td><select [(ngModel)]="l.type" (ngModelChange)="lineTypeChanged(l)" [disabled]="!!l.lastBilled">
            @for (t of activeTypes(); track t) { <option [value]="t">{{t}}</option> }</select></td>
          <td><select [(ngModel)]="l.asset" [disabled]="!!l.lastBilled"><option value="">—</option>@for (a of assetOpts(); track a.code) { <option [value]="a.code">{{a.code}} — {{a.name}}</option> }</select></td>
          <td><input [(ngModel)]="l.descr"></td>
          <td><input [(ngModel)]="l.amt" type="number" min="0" step="0.01" [disabled]="!!l.lastBilled"></td>
          <td><input [(ngModel)]="l.term" type="number" min="1" max="120" [disabled]="!!l.lastBilled"></td>
          <td><input [(ngModel)]="l.start" type="date" [disabled]="!!l.lastBilled"></td>
          <td><input [(ngModel)]="l.funder" [placeholder]="lnFunder(l.type) ? 'Funder / bank' : 'Not needed'" [disabled]="!lnFunder(l.type) || !!l.lastBilled" (ngModelChange)="lnFunder(l.type) ? null : (l.funder = '')"></td>
          <td><button class="btn btn-s btn-sm" type="button" (click)="lineRemove(i)" title="Remove">✕</button></td>
        </tr>
      }
    </tbody></table>
    <button class="btn btn-s btn-sm" type="button" (click)="addLine()" style="margin-top:6px"><i class="ti ti-plus"></i> Add item</button>
    <h3 style="margin:14px 0 6px">Meters (usage-billed)</h3>
    <table><thead><tr><th style="width:220px">Asset</th><th style="width:150px">Meter type</th><th style="width:130px">Rate / page</th><th style="width:130px">Start reading</th><th style="width:40px"></th></tr></thead><tbody>
      @for (m of f.meters; track $index; let i = $index) {
        <tr>
          <td><select [(ngModel)]="m.asset" [disabled]="!!m.hasReadings"><option value="" disabled>Pick the machine asset</option>@for (a of meterAssets(); track a.code) { <option [value]="a.code">{{a.code}} — {{a.name}}</option> }</select></td>
          <td><select [(ngModel)]="m.type" [disabled]="!!m.hasReadings">@for (t of mtypes(); track t) { <option [value]="t">{{t}}</option> }</select></td>
          <td><input [(ngModel)]="m.rate" type="number" min="0" step="0.0001"></td>
          <td><input [(ngModel)]="m.start" type="number" min="0" step="1" [disabled]="!!m.hasReadings"></td>
          <td><button class="btn btn-s btn-sm" type="button" (click)="meterRemove(i)" title="Remove">✕</button></td>
        </tr>
      } @empty { <tr><td colspan="5" style="text-align:center;color:var(--txm)">No meters. Add one per usage-billed machine above.</td></tr> }
    </tbody></table>
    <button class="btn btn-s btn-sm" type="button" (click)="addMeter()" style="margin-top:6px"><i class="ti ti-plus"></i> Add meter</button>
    <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
    <div class="btn-grp"><button class="btn btn-p" (click)="save()" [disabled]="busy()"><i class="ti ti-device-floppy"></i> Save Contract</button></div>
  </div>`,
})
export class ContractFormComponent {
  fmtR = fmtR; fmtD = fmtD;
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  private ar = inject(ActivatedRoute);
  private router = inject(Router);
  edit = ''; billed = false;
  err = signal(''); busy = signal(false);
  custs = signal<{ code: string; name: string; active?: boolean }[]>([]);
  staff = signal<{ code: string; name: string; mgr: boolean; sales: boolean; active: boolean }[]>([]);
  ctypes = signal<{ name: string; active: boolean; asset_req: string; funder: string; ever: boolean }[]>([]);
  mtypes = signal<string[]>([]);
  assets = signal<{ code: string; name: string; atype: string; cust: string | null; status: string }[]>([]);
  conCache: Con[] = [];
  f = { cust: '', status: 'Active', ref: '', start: todayIso(), freq: 1, esc: 0, mgr: '', sales: '', lines: [] as CLine[], meters: [] as CMeter[] };

  constructor() { void this.init(); }
  async init() {
    const code = this.ar.snapshot.queryParamMap.get('code');
    const [cu, st, ct, mt, as] = await Promise.all([
      this.api.get<{ code: string; name: string }[]>('/customers'),
      this.api.get<{ code: string; name: string; mgr: boolean; sales: boolean }[]>('/staff'),
      this.api.get<{ name: string; active: boolean }[]>('/ctypes'),
      this.api.get<{ name: string; active: boolean }[]>('/mtypes'),
      this.api.get<{ code: string; name: string; atype: string; cust: string | null; status: string }[]>('/assets'),
    ]);
    const con = code ? await this.api.get<Con>('/contracts/' + code) : null;
    this.custs.set(cu); this.staff.set(st as any); this.ctypes.set(ct as any);
    this.mtypes.set((mt as any).filter((m: any) => m.active).map((m: any) => m.name));
    this.assets.set(as);
    this.conCache = await this.api.get<Con[]>('/contracts');
    if (con) {
      this.edit = con.code;
      this.billed = con.lines.some((l) => l.lastBilled);
      this.f = { cust: cu.find((c) => c.name === con.custName)?.code || '', status: con.status !== 'Expired' ? con.status : 'Active', ref: con.ref, start: con.start, freq: con.freq, esc: con.esc, mgr: con.mgr || '', sales: con.sales || '', lines: con.lines, meters: con.meters as any };
    } else this.f.lines = [{ id: 0, type: (ct as any).find((t: any) => t.active)?.name || '', asset: '', descr: '', amt: 0, term: 12, start: todayIso(), funder: '' }];
    this.cdr.detectChanges();
  }
  activeTypes = () => [...new Set(this.ctypes().filter((t) => t.active).map((t) => t.name))];
  lnFunder = (type: string) => !!this.ctypes().find((t) => t.name === type && t.funder === 'required');
  lineTypeChanged(l: CLine) { l.funder = ''; }
  // assetOptions 3468 — this customer's active assets not already on another live line
  assetOpts = () => {
    if (!this.f.cust) return [{ code: '', name: 'Select the customer first', atype: '', cust: null, status: '' }];
    const cur = this.f.lines.map((l) => l.asset).filter(Boolean);
    const taken = new Set<string>();
    this.conCache.forEach((c) => {
      if (c.code === this.edit || c.status === 'Cancelled' || c.status === 'Expired') return;
      c.lines.forEach((l) => { if (l.asset && lineActive(l) && !cur.includes(l.asset)) taken.add(l.asset); });
    });
    return this.assets().filter((a) => a.status === 'Active' && a.cust === this.f.cust && (!taken.has(a.code) || cur.includes(a.code)));
  };
  meterAssets = () => {
    const seen = new Set(this.f.lines.map((l) => l.asset).filter(Boolean));
    return this.assets().filter((a) => a.status === 'Active' && seen.has(a.code));
  };
  addLine() {
    this.f.lines = [...this.f.lines, { id: 0, type: this.activeTypes()[0] || '', asset: '', descr: '', amt: 0, term: 12, start: this.f.start || todayIso(), funder: '' }];
    this.cdr.detectChanges();
  }
  async lineRemove(i: number) {
    if (this.f.lines.length <= 1) { this.err.set('A contract needs at least one item.'); return; }
    this.f.lines.splice(i, 1); this.cdr.detectChanges();
  }
  addMeter() {
    const a = this.meterAssets()[0]?.code || '';
    this.f.meters = [...this.f.meters, { id: 0, asset: a, type: this.mtypes()[0] || '', rate: 0, start: 0 }];
    this.cdr.detectChanges();
  }
  meterRemove(i: number) { this.f.meters.splice(i, 1); this.cdr.detectChanges(); }
  async save() {
    this.err.set(''); this.busy.set(true);
    try {
      const o = {
        cust: this.f.cust, ref: this.f.ref.trim(), status: this.f.status, start: this.f.start,
        freq: Number(this.f.freq), esc: Number(this.f.esc || 0), mgr: this.f.mgr, sales: this.f.sales,
        lines: this.f.lines.map((l) => ({ id: Number(l.id) || 0, type: l.type, asset: l.asset, descr: l.descr.trim(), amt: Number(l.amt) || 0, term: Number(l.term) || 0, start: l.start, funder: (l.funder || '').trim(), lastBilled: l.lastBilled || '' })),
        meters: this.f.meters.map((m) => ({ id: Number(m.id) || 0, asset: m.asset, type: m.type, rate: Number(m.rate) || 0, start: Number(m.start) || 0 })),
      };
      if (this.edit) await this.api.patch('/contracts/' + this.edit, o);
      else await this.api.post('/contracts', o);
      this.toast.show('Contract saved.');
      this.router.navigate(['/contracts/list']);
    } catch (e) { this.err.set((e as ApiError).message); }
    finally { this.busy.set(false); this.cdr.detectChanges(); }
  }
}
