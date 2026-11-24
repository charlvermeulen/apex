// Assets / Equipment — Asset Register (renderAssets 3271 / openAsset+saveAsset 3293 / disposeAsset 3313).
// Maintenance & Service and Depreciation tabs arrive with batch 4.
import { Component, ChangeDetectorRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService, ApiError, ToastService } from '../../core/api';
import { fmtR, fmtD, todayIso } from '../../core/fmt';

export const ASSET_CATS = ['Computer Equipment', 'Furniture & Fittings', 'Motor Vehicles', 'Plant & Machinery', 'Office Equipment', 'Tools', 'Printing Machines'];
const ATYPES: Record<string, string> = { company: 'Company Asset', warehouse: 'Warehouse (Inventory)', customer: 'Customer Asset' };

interface Asset {
  code: string; atype: string; name: string; cat: string; ser: string | null; loc: string | null; dept: string | null;
  sup: string | null; cust: string | null; custName: string | null; date: string | null; cost: number; res: number;
  life: number; status: string; onLine?: string;
}

@Component({
  selector: 'app-assets-register',
  imports: [FormsModule, RouterLink],
  template: `
  <div class="g3" id="ass-stats">
    <div class="card"><div class="stat-lbl">Total cost (company &amp; warehouse)</div><div class="stat-val">{{fmtR(costTot())}}</div></div>
    <div class="card"><div class="stat-lbl">Accumulated depreciation</div><div class="stat-val">{{fmtR(0)}}</div></div>
    <div class="card"><div class="stat-lbl">Net book value</div><div class="stat-val">{{fmtR(costTot())}}</div></div>
    <div class="card"><div class="stat-lbl">Customer assets (no value)</div><div class="stat-val">{{custN()}}</div><div class="stat-sub">{{whN()}} in the warehouse</div></div>
  </div>
  <div class="card">
    <div class="card-title">Asset Register
      <a class="btn btn-p btn-sm" routerLink="/assets/add"><i class="ti ti-plus"></i> Add Asset</a></div>
    <div class="fr" style="margin-bottom:8px">
      <div class="fg"><label>Asset type</label>
        <select [(ngModel)]="tf" (ngModelChange)="render()">
          <option value="">All types</option>
          <option value="company">Company Asset</option>
          <option value="warehouse">Warehouse (Inventory)</option>
          <option value="customer">Customer Asset</option></select></div>
      <div class="fg"><label>Department</label>
        <select [(ngModel)]="df" (ngModelChange)="render()">
          <option value="">All departments</option>
          @for (d of depts(); track d) {
            <option [value]="d" [selected]="d === '__none'">{{d === '__none' ? '(no department)' : d}}</option>
          }</select></div></div>
    <table><thead><tr><th>Code</th><th>Description</th><th>Type</th><th>Category</th><th>Customer / Owner</th>
      <th>Location / Custodian</th><th>Purchased</th><th class="tr">Cost</th><th class="tr">Accum. Dep.</th>
      <th class="tr">Net Book Value</th><th>Status</th><th style="width:150px"></th></tr></thead><tbody>
      @for (a of rows(); track a.code) {
        <tr>
          <td>{{a.code}}</td>
          <td><strong>{{a.name}}</strong><div style="font-size:11px;color:var(--txm)">{{a.ser || ''}}</div></td>
          <td><span class="chip" [class.c-bl]="a.atype === 'company'" [class.c-wn]="a.atype === 'warehouse'" [class.c-nt]="a.atype === 'customer'">{{ATYPES[a.atype]}}</span></td>
          <td>{{a.cat}}@if (a.dept) {<div style="font-size:11px;color:var(--txm)">Dept: {{a.dept}}</div>}</td>
          <td>@if (a.cust) { {{a.custName}}@if (a.atype === 'customer') {<div style="font-size:11px;color:var(--txm)">Owner</div>} }
            @else if (a.atype === 'warehouse') { <span style="color:var(--txm)">No owner</span> }
            @else { <span style="color:var(--txm)">Unassigned</span> }
            @if (a.onLine) {<div style="font-size:11px;color:var(--txm)">{{a.onLine}}</div>}</td>
          <td>{{a.loc || '—'}}</td>
          <td>@if (a.atype === 'customer') { <span style="color:var(--txm)">—</span> } @else { {{a.date}} }</td>
          <td class="tr">@if (a.atype !== 'customer') { {{fmtR(a.cost)}} } @else { <span style="color:var(--txm)">—</span> }</td>
          <td class="tr">@if (a.atype !== 'customer') { {{fmtR(0)}} } @else { <span style="color:var(--txm)">—</span> }</td>
          <td class="tr">@if (a.atype !== 'customer') { {{fmtR(a.cost)}} } @else { <span style="color:var(--txm)">—</span> }</td>
          <td><span class="chip" [class.c-ok]="a.status === 'Active'" [class.c-wn]="a.status !== 'Active'">{{a.status}}</span></td>
          <td><a class="btn btn-s btn-sm" [routerLink]="['/assets/add']" [queryParams]="{code: a.code}">Edit</a>
              @if (a.status === 'Active') { <button class="btn btn-s btn-sm" (click)="dispose(a)">Dispose</button> }</td>
        </tr>
      } @empty {
        <tr><td colspan="12" style="text-align:center;color:var(--txm)">No assets yet. Click Add Asset.</td></tr>
      }
    </tbody></table></div>`,
})
export class AssetsRegisterComponent {
  ATYPES = ATYPES;
  fmtR = (v: number) => 'R ' + (Number(v) || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  all = signal<Asset[]>([]);
  depts = signal<string[]>([]);
  tf = ''; df = '';
  rows = signal<Asset[]>([]);
  costTot = signal(0);
  custN = signal(0);
  whN = signal(0);

  constructor() { void this.reload(); }
  async reload() {
    const [a, d] = await Promise.all([
      this.api.get<Asset[]>('/assets'),
      this.api.get<string[]>('/assets/departments'),
    ]);
    this.all.set(a);
    this.depts.set([...new Set([...d, '__none'])]);
    this.render();
    this.cdr.detectChanges();
  }
  render() {
    const rows = this.all().filter((a) => (!this.tf || a.atype === this.tf) && (!this.df || (this.df === '__none' ? !a.dept : a.dept === this.df)));
    this.rows.set(rows);
    let cost = 0, custN = 0, whN = 0;
    this.all().forEach((a) => { if (a.status !== 'Active') return; if (a.atype === 'customer') custN++; else if (a.atype === 'warehouse') whN++; });
    this.all().forEach((a) => { if (a.status === 'Active' && a.atype !== 'customer') cost += a.cost; });
    this.costTot.set(cost); this.custN.set(custN); this.whN.set(whN);
  }
  async dispose(a: Asset) {
    if (!confirm('Mark ' + a.name + ' as disposed? Depreciation stops and it is removed from the register totals.')) return;
    try { await this.api.post('/assets/' + a.code + '/dispose'); this.toast.show('Asset ' + a.code + ' disposed.'); await this.reload(); }
    catch (e) { this.toast.show((e as ApiError).message); }
  }
}

// Add/Edit Asset form (openAsset + saveAsset 3293–3311). Billed/contract-locked fields are guarded server-side.
@Component({
  selector: 'app-asset-form',
  imports: [FormsModule, RouterLink],
  template: `
  <div class="page-title">Add Asset</div>
  <div class="card" style="max-width:900px">
    <div class="fr">
      <div class="fg"><label>Asset type *</label>
        <select [(ngModel)]="f.atype" (ngModelChange)="typeChanged()"><option value="company">Company Asset</option><option value="warehouse">Warehouse (Inventory)</option><option value="customer">Customer Asset</option></select></div>
      <div class="fg"><label>Description *</label><input [(ngModel)]="f.name" maxlength="80" placeholder="e.g. Dell Latitude laptops (x5)"></div></div>
    <div class="fr">
      <div class="fg"><label>Category</label><select [(ngModel)]="f.cat">@for (c of cats; track c) { <option [value]="c">{{c}}</option> }</select></div>
      <div class="fg"><label>Serial number</label><input [(ngModel)]="f.ser" maxlength="60"></div></div>
    <div class="fr">
      <div class="fg"><label>Location / Custodian</label><input [(ngModel)]="f.loc" maxlength="80"></div>
      <div class="fg"><label>Department</label><input [(ngModel)]="f.dept" maxlength="40" [attr.list]="'dept-list'">
        <datalist id="dept-list">@for (d of depts(); track d) { @if (d !== '__none') { <option [value]="d"> } }</datalist></div></div>
    <div class="fr">
      <div class="fg"><label>Customer / Owner @if (f.atype === 'customer') { * } @else if (f.atype === 'warehouse') { (none for warehouse) }</label>
        <select [(ngModel)]="f.cust"><option value="">— None —</option>@for (c of custs(); track c.code) { <option [value]="c.code">{{c.name}}</option> }</select></div>
      <div class="fg"><label>Supplier / Vendor</label><input [(ngModel)]="f.sup" maxlength="80"></div></div>
    <div class="fr3">
      <div class="fg"><label>Purchase date *</label><input [(ngModel)]="f.date" type="date" [disabled]="f.atype === 'customer'"></div>
      <div class="fg"><label>Cost (R) *</label><input [(ngModel)]="f.cost" type="number" min="0" step="0.01" [disabled]="f.atype !== 'company'"></div>
      <div class="fg"><label>Residual value (R)</label><input [(ngModel)]="f.res" type="number" min="0" step="0.01" [disabled]="f.atype !== 'company'"></div></div>
    <div class="fr"><div class="fg" style="max-width:300px"><label>Useful life (months)</label><input [(ngModel)]="f.life" type="number" min="1" [disabled]="f.atype !== 'company'"></div></div>
    <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
    <div class="btn-grp">
      <button class="btn btn-p" (click)="save()" [disabled]="busy()"><i class="ti ti-device-floppy"></i> {{edit ? 'Save Changes' : 'Add Asset'}}</button>
      <a class="btn btn-s" routerLink="/assets/register">Cancel</a></div></div>`,
})
export class AssetFormComponent {
  cats = ASSET_CATS;
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  private ar = inject(ActivatedRoute);
  private router = inject(Router);
  edit = '';
  f = { atype: 'company', name: '', cat: 'Computer Equipment', ser: '', loc: '', dept: '', cust: '', sup: '', date: todayIso(), cost: 0, res: 0, life: 60 };
  busy = signal(false); err = signal('');
  allCusts = signal<{ code: string; name: string; active?: boolean }[]>([]);
  depts = signal<string[]>([]);
  custs = () => this.allCusts();

  constructor() {
    void this.init();
  }
  async init() {
    const [cu, dp] = await Promise.all([
      this.api.get<{ code: string; name: string }[]>('/customers'), this.api.get<string[]>('/assets/departments'),
    ]);
    this.allCusts.set(cu); this.depts.set(dp);
    const code = this.ar.snapshot.queryParamMap.get('code');
    if (code) {
      this.edit = code;
      const a = (await this.api.get<Asset[]>('/assets')).find((x) => x.code === code);
      if (a) this.f = { atype: a.atype, name: a.name, cat: a.cat, ser: a.ser || '', loc: a.loc || '', dept: a.dept || '', cust: a.cust || '', sup: a.sup || '', date: a.date || todayIso(), cost: a.cost, res: a.res, life: a.life };
      setTimeout(() => document.querySelector('.page-title') && (document.querySelector('.page-title')!.textContent = 'Edit Asset ' + code), 0);
    }
    this.cdr.detectChanges();
  }
  typeChanged() {
    if (this.f.atype === 'warehouse') this.f.cust = '';
    this.costChanged();
  }
  costChanged() { void 0; }
  async save() {
    this.err.set(''); this.busy.set(true);
    try {
      const o = { ...this.f, name: this.f.name.trim(), ser: this.f.ser.trim(), loc: this.f.loc.trim(), dept: this.f.dept.trim(), sup: this.f.sup.trim(), cost: Number(this.f.cost), res: Number(this.f.res), life: Number(this.f.life) };
      const r = this.edit
        ? await this.api.patch<{ code: string }>('/assets/' + this.edit, o)
        : await this.api.post<{ code: string }>('/assets', o);
      this.toast.show('Asset ' + r.code + ' saved.');
      this.router.navigate(['/assets/register']);
    } catch (e) { this.err.set((e as ApiError).message); }
    finally { this.busy.set(false); this.cdr.detectChanges(); }
  }
}

// ── Maintenance & Service tab (assTab 'svc' / renderSvc 3286 / saveSvc 3298) ──
interface SvcRow { id: string; asset: string; assetName: string; date: string; type: string; sup: string; cost: number; next: string | null; notes: string }

@Component({
  selector: 'app-assets-svc',
  imports: [FormsModule],
  template: `
  <div class="card"><div class="card-title">Maintenance &amp; Service <button class="btn btn-p btn-sm" (click)="openModal()">Log Service</button></div>
    <table><thead><tr><th>Date</th><th>Asset</th><th>Type</th><th>Supplier / Technician</th><th class="tr">Cost</th><th>Next service</th><th>Notes</th></tr></thead><tbody>
      @for (x of rows(); track x.id) {
        <tr><td>{{fmtD(x.date,1)}}</td><td>{{x.asset}} — {{x.assetName}}</td><td>{{x.type}}</td><td>{{x.sup || '—'}}</td>
          <td class="tr">{{fmtR(x.cost)}}</td>
          <td>@if (x.next) { {{fmtD(x.next,1)}}@if (x.next < todayIso()) { <span class="chip c-dn">Overdue</span> } } @else { — }</td>
          <td>{{x.notes}}</td></tr>
      } @empty { <tr><td colspan="7" style="text-align:center;color:var(--txm)">No services logged.</td></tr> }
    </tbody></table></div>
  @if (isOpen()) {
    <div class="modal-bg" style="display:block" (click)="close($event)">
      <div class="modal" style="max-width:560px" (click)="$event.stopPropagation()">
        <div class="rm-hd"><strong>Log Service</strong><button class="btn btn-s btn-sm" (click)="close()">✕</button></div>
        <div class="fr"><div class="fg"><label>Asset *</label><select [(ngModel)]="f.asset"><option value="">Select asset…</option>
            @for (a of assets(); track a.code) { <option [value]="a.code">{{a.code}} — {{a.name}}</option> }</select></div>
          <div class="fg"><label>Type *</label><select [(ngModel)]="f.type"><option>Repair</option><option>Routine service</option><option>Inspection / Certification</option><option>Other</option></select></div></div>
        <div class="fr3">
          <div class="fg"><label>Date *</label><input type="date" [(ngModel)]="f.date"></div>
          <div class="fg"><label>Supplier / Technician</label><input [(ngModel)]="f.sup" maxlength="80"></div>
          <div class="fg"><label>Cost (excl VAT)</label><input type="number" min="0" step="0.01" [(ngModel)]="f.cost"></div></div>
        <div class="fr3">
          <div class="fg"><label>Next service due</label><input type="date" [(ngModel)]="f.next"></div>
          <div class="fg" style="grid-column:span 2"><label>Notes</label><input [(ngModel)]="f.notes" maxlength="160"></div></div>
        <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
        <div class="btn-grp"><button class="btn btn-p" (click)="save()">Log Service</button> <button class="btn btn-s" (click)="close()">Cancel</button></div>
      </div></div>
  }`,
})
export class AssetsSvcComponent {
  fmtR = fmtR; fmtD = fmtD; todayIso = todayIso; cdr = inject(ChangeDetectorRef);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  rows = signal<SvcRow[]>([]); assets = signal<{ code: string; name: string; status: string }[]>([]);
  isOpen = signal(false); err = signal('');
  f = { asset: '', date: todayIso(), type: 'Repair', sup: '', cost: 0, next: '', notes: '' };

  constructor() { void this.reload(); }
  openModal() { this.f = { asset: '', date: todayIso(), type: 'Repair', sup: '', cost: 0, next: '', notes: '' }; this.isOpen.set(true); this.err.set(''); this.cdr.detectChanges(); }
  close(e?: MouseEvent) { if (!e || (e.target as HTMLElement).classList.contains('modal-bg')) this.isOpen.set(false); this.cdr.detectChanges(); }
  async reload() {
    const [rows, assets] = await Promise.all([this.api.get<SvcRow[]>('/assets/services'), this.api.get<{ code: string; name: string; status: string }[]>('/assets')]);
    this.rows.set(rows); this.assets.set(assets.filter((a) => a.status === 'Active'));
    this.cdr.detectChanges();
  }
  async save() {
    this.err.set('');
    try {
      await this.api.post('/assets/services', this.f);
      this.toast.show('Service logged.');
      this.isOpen.set(false);
      await this.reload();
    } catch (e) { this.err.set((e as ApiError).message); this.cdr.detectChanges(); }
  }
}

// ── Depreciation tab (assTab 'dep' / depRows 3306 / postDep 3319) ──
interface DepRow { code: string; name: string; cost: number; amt: number; acc: number; state: string }

@Component({
  selector: 'app-assets-dep',
  imports: [FormsModule],
  template: `
  <div class="notice"><i class="ti ti-info-circle"></i> <div>Straight-line depreciation: (cost − residual value) ÷ useful life, charged monthly from the month of purchase. Posting records the charge once per asset per month and requires an open financial year.</div></div>
  <div class="card"><div class="card-title">Monthly Depreciation Run</div>
    <div class="fr"><div class="fg"><label>Month</label><input type="month" [(ngModel)]="month" (ngModelChange)="load()"></div>
      <div class="fg"><label>&nbsp;</label><button class="btn btn-p" (click)="post()"><i class="ti ti-player-play"></i> Post Depreciation</button></div></div></div>
  <div class="card"><div class="card-title">Depreciation — {{month}}</div>
    <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
    <table><thead><tr><th>Asset</th><th class="tr">Cost</th><th class="tr">Monthly charge</th><th class="tr">Accumulated</th><th>Status</th></tr></thead><tbody>
      @for (r of rows(); track r.code) {
        <tr><td>{{r.code}} — {{r.name}}</td><td class="tr">{{fmtR(r.cost)}}</td><td class="tr">{{fmtR(r.amt)}}</td><td class="tr">{{fmtR(r.acc)}}</td>
          <td><span class="chip {{r.state === 'Posted' ? 'c-ok' : r.state === 'Pending' ? 'c-wn' : 'c-nt'}}">{{r.state}}</span></td></tr>
      } @empty { <tr><td colspan="5" style="text-align:center;color:var(--txm)">No depreciable assets for this month.</td></tr> }
    </tbody></table></div>`,
})
export class AssetsDepComponent {
  fmtR = fmtR; cdr = inject(ChangeDetectorRef);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  rows = signal<DepRow[]>([]);
  month = todayIso().slice(0, 7);
  err = signal('');

  constructor() { void this.load(); }
  async load() {
    this.rows.set(await this.api.get<DepRow[]>('/assets/dep?month=' + this.month));
    this.cdr.detectChanges();
  }
  async post() {
    this.err.set('');
    try {
      const r = await this.api.post<{ count: number; total: number }>('/assets/dep', { month: this.month });
      this.toast.show('Depreciation posted for ' + r.count + ' asset(s).');
      await this.load();
    } catch (e) { this.err.set((e as ApiError).message); this.toast.show((e as ApiError).message); }
    this.cdr.detectChanges();
  }
}
