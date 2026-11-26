// Service (legacy page-svc markup 1003–1043, calls 3706–3792, requests/WO/WIP/SLA 4455–4601).
// Validation strings come verbatim from the API (validateCall 3754 / saveReq 4488 / saveWO 4526).
import { Component, ChangeDetectorRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, ApiError, ToastService } from '../../core/api';
import { Exporter } from '../../core/export';
import { fmtR, fmtD, fmtDMY, todayIso } from '../../core/fmt';

const dayAdd = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); const p = (x: number) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00') - Date.parse(a + 'T00:00:00')) / 86400000);

interface Call { code: string; cust: string; custName: string; asset: string; assetName: string; type: string; pri: string; descr: string; status: string; tech: string; techName: string; logged: string; sched: string | null; completed: string | null; hours: number; cost: number; res: string; hasOpenWo: boolean }
interface Req { code: string; cust: string; custName: string; asset: string; assetName: string; contact: string; phone: string; pri: string; received: string; descr: string; status: string; reason: string; call: string }
interface Wo { code: string; call: string; cust: string; asset: string; assetName: string; custName: string; tech: string; techName: string; sched: string | null; status: string; hours: number; instr: string; completed: string | null; notes: string; created: string; partsCost: number }
interface Part { descr: string; sku: string; qty: number; cost: number }
interface Staff { code: string; name: string; tech: boolean; active: boolean }
interface Cust { code: string; name: string }
interface Asset { code: string; name: string; cust: string; status: string }
interface Item { sku: string; name: string; cost: number }
interface Sla { pri: string; resp: number; res: number }
interface WipRow { call: Call; ow: { code: string; status: string } | null; hours: number; parts: number; age: number; sla: { resp: string; reso: string } }
interface TechRow { tech: string; calls: number; wos: number; hours: number; parts: number }

export const CALL_OPEN = (s: string): boolean => !['Completed', 'Cancelled'].includes(s); // 3713
const CALL_STATUSES = ['Logged', 'Assigned', 'In progress', 'On hold', 'Completed', 'Cancelled'];
const WO_OPEN = ['Issued', 'In progress']; // 4460

// slaState port (4461–4467)
const slaState = (c: Call, sla: Sla[], t0: string): { resp: string; reso: string } => {
  const S = sla.find((x) => x.pri === c.pri) || ({ pri: c.pri, resp: 2, res: 5 } as Sla);
  const rd = dayAdd(c.logged, S.resp), xd = dayAdd(c.logged, S.res);
  let resp: string, reso: string;
  if (c.sched) resp = c.sched <= rd ? 'Met' : 'Breached';
  else resp = (CALL_OPEN(c.status) && t0 > rd) || (!CALL_OPEN(c.status) && c.status === 'Completed') ? 'Breached' : 'Pending';
  if (c.status === 'Completed') reso = (c.completed || '') <= xd ? 'Met' : 'Breached';
  else if (c.status === 'Cancelled') reso = 'n/a';
  else reso = t0 > xd ? 'Breached' : 'On track';
  return { resp, reso };
};
const slaChip = (v: string): string => (v === 'Met' || v === 'On track') ? 'c-ok' : v === 'Breached' ? 'c-dn' : v === 'n/a' ? 'c-nt' : 'c-wn';
const SV_CHIP: Record<string, string> = { New: 'c-wn', Converted: 'c-ok', Declined: 'c-nt', Issued: 'c-wn', 'In progress': 'c-bl', Completed: 'c-ok', Cancelled: 'c-nt', Logged: 'c-wn', Assigned: 'c-bl', 'On hold': 'c-wn' };

// ══ Service Calls tab (renderCalls 3725 / saveCall 3774) ══
@Component({
  selector: 'app-sv-calls',
  imports: [FormsModule],
  template: `
  <div class="g3" style="grid-template-columns:repeat(4,1fr)">
    <div class="card"><div class="stat-lbl">Open calls</div><div class="stat-val">{{stats().open}}</div></div>
    <div class="card"><div class="stat-lbl">Unassigned</div><div class="stat-val">{{stats().unassigned}}</div></div>
    <div class="card"><div class="stat-lbl">Overdue</div><div class="stat-val">{{stats().overdue}}</div></div>
    <div class="card"><div class="stat-lbl">Completed this month</div><div class="stat-val">{{stats().doneMonth}}</div></div></div>
  <div class="card">
    <div class="card-title">Service Calls <button class="btn btn-p btn-sm" (click)="openCall(null)">Log Service Call</button></div>
    <div class="fr3" style="margin-bottom:8px">
      <div class="fg"><label>Search</label><input [(ngModel)]="q" placeholder="Call no., customer, asset"></div>
      <div class="fg"><label>Status</label>
        <select [(ngModel)]="f"><option value="">All</option><option value="open">Open (not completed)</option>
          @for (s of statuses; track s) { <option [value]="s">{{s}}</option> }</select></div>
      <div class="fg"><label>Technician</label>
        <select [(ngModel)]="tf"><option value="">All technicians</option><option value="-">Unassigned</option>
          @for (t of techs(); track t.code) { <option [value]="t.code">{{t.name}}</option> }</select></div></div>
    <table><thead><tr><th>Call</th><th>Customer</th><th>Asset</th><th>Type / Priority</th><th>Technician</th><th>Logged</th><th>Scheduled</th><th>Status</th><th style="width:200px"></th></tr></thead><tbody>
      @for (c of filtered(); track c.code) {
        <tr>
          <td><strong>{{c.code}}</strong><div style="font-size:11px;color:var(--txm)">{{c.descr}}</div></td>
          <td>{{c.custName}}</td>
          <td>{{c.asset}}@if (c.assetName) {<div style="font-size:11px;color:var(--txm)">{{c.assetName}}</div>}</td>
          <td>{{c.type}}<div style="font-size:11px;color:var(--txm)">{{c.pri}}</div></td>
          <td>@if (c.techName) { {{c.techName}} } @else { <span style="color:var(--txm)">Unassigned</span> }</td>
          <td>{{fmtD(c.logged,1)}}</td>
          <td>@if (c.sched) { {{fmtD(c.sched,1)}}@if (odd(c)) { <span class="chip c-dn">Overdue</span> } } @else { — }</td>
          <td><span class="chip {{chip(c)}}">{{c.status}}</span></td>
          <td>@if (CALL_OPEN(c.status)) {
            <button class="btn btn-s btn-sm" (click)="openCall(c)">Edit</button>
            @if (c.status === 'Assigned' || c.status === 'On hold') { <button class="btn btn-s btn-sm" (click)="start(c)">Start</button> }
            @if (c.status === 'In progress') { <button class="btn btn-s btn-sm" (click)="openCall(c, true)">Complete</button> }
          } @else { <button class="btn btn-s btn-sm" (click)="openCall(c)">View</button> }</td>
        </tr>
      } @empty { <tr><td colspan="9" style="text-align:center;color:var(--txm)">No service calls match.</td></tr> }
    </tbody></table></div>

  @if (edit() !== undefined) {
    <div class="modal-bg" style="display:block" (click)="close($event)">
      <div class="modal" style="max-width:660px" (click)="$event.stopPropagation()">
        <div class="rm-hd"><strong>{{title()}}</strong><button class="btn btn-s btn-sm" (click)="close()">✕</button></div>
        <div class="fr"><div class="fg"><label>Customer *</label>
            <select [(ngModel)]="fm.cust" (ngModelChange)="assetChange()" [disabled]="isEdit()"><option value="">Select customer…</option>
              @for (cu of custs; track cu.code) { <option [value]="cu.code">{{cu.name}}</option> }</select></div>
          <div class="fg"><label>Asset *</label>
            <select [(ngModel)]="fm.asset" [disabled]="isEdit()"><option value="">Select asset…</option>
              @for (a of custAssets(); track a.code) { <option [value]="a.code">{{a.code}} — {{a.name}}</option> }</select></div></div>
        <div style="font-size:12px;color:var(--txm);margin-bottom:8px">{{hint()}}</div>
        <div class="fr3">
          <div class="fg"><label>Call type *</label><select [(ngModel)]="fm.type" [disabled]="ro()">@for (t of ctypes; track t) { <option [value]="t">{{t}}</option> }</select></div>
          <div class="fg"><label>Priority *</label><select [(ngModel)]="fm.pri" [disabled]="ro()"><option>Urgent</option><option>High</option><option>Normal</option><option>Low</option></select></div>
          <div class="fg"><label>Status *</label><select [(ngModel)]="fm.status" (ngModelChange)="statusChanged()" [disabled]="ro()">@for (s of statuses; track s) { <option [value]="s">{{s}}</option> }</select></div></div>
        <div class="fr"><div class="fg"><label>Problem / work requested *</label><textarea [(ngModel)]="fm.descr" rows="2" [disabled]="ro()"></textarea></div></div>
        <div class="fr3">
          <div class="fg"><label>Technician</label><select [(ngModel)]="fm.tech" [disabled]="ro()"><option value="">— Unassigned —</option>
              @for (t of techOpts(); track t.code) { <option [value]="t.code">{{t.name}}{{t.active ? '' : ' (inactive)'}}</option> }</select></div>
          <div class="fg"><label>Logged date *</label><input type="date" [(ngModel)]="fm.logged" [disabled]="ro()"></div>
          <div class="fg"><label>Scheduled</label><input type="date" [(ngModel)]="fm.sched" [disabled]="ro()"></div></div>
        @if (fm.status === 'Completed') {
          <div class="fr3">
            <div class="fg"><label>Completed date *</label><input type="date" [(ngModel)]="fm.completed" [disabled]="ro()"></div>
            <div class="fg"><label>Hours</label><input type="number" min="0" step="any" [(ngModel)]="fm.hours" [disabled]="ro()"></div>
            <div class="fg"><label>Cost (excl VAT)</label><input type="number" min="0" step="0.01" [(ngModel)]="fm.cost" [disabled]="ro()"></div></div>
          <div class="fr"><div class="fg"><label>Resolution notes *</label><textarea [(ngModel)]="fm.res" rows="2" [disabled]="ro()"></textarea></div></div>
        }
        <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
        <div class="btn-grp">@if (!ro()) { <button class="btn btn-p" (click)="save()">Save Service Call</button> } <button class="btn btn-s" (click)="close()">Cancel</button></div>
      </div></div>
  }`,
})
export class SvCallsComponent {
  fmtD = fmtD; fmtR = fmtR; CALL_OPEN = CALL_OPEN; statuses = CALL_STATUSES;
  private api = inject(ApiService);
  private toast = inject(ToastService);
  cdr = inject(ChangeDetectorRef);
  calls = signal<Call[]>([]); techs = signal<Staff[]>([]);
  edit = signal<Call | null | undefined>(undefined); // null = new, undefined = closed
  completeMode = false; err = signal('');
  q = ''; f = ''; tf = '';
  custs: Cust[] = []; assets: Asset[] = []; ctypes: string[] = [];
  contracts: { code: string; status: string; lines: { asset: string }[] }[] = [];
  fm = this.blank();

  constructor() { void this.init(); }
  blank() { return { cust: '', asset: '', type: '', pri: 'Normal', status: 'Logged', descr: '', tech: '', logged: todayIso(), sched: '', completed: '', hours: 0, cost: 0, res: '' }; }
  async init() {
    const [calls, staff, custs, assets, ctypes] = await Promise.all([
      this.api.get<Call[]>('/calls'), this.api.get<Staff[]>('/techs'),
      this.api.get<Cust[]>('/customers'), this.api.get<Asset[]>('/assets'),
      this.api.get<{ name: string; active: boolean }[]>('/call-types'),
    ]);
    this.calls.set(calls); this.techs.set(staff); this.custs = custs; this.assets = assets;
    this.ctypes = ctypes.filter((t) => t.active).map((t) => t.name);
    this.api.get<{ code: string; status: string; lines: { asset: string }[] }[]>('/contracts').then((cs) => { this.contracts = cs; this.cdr.detectChanges(); }).catch(() => {});
    if (!this.fm.type && this.ctypes[0]) this.fm.type = this.ctypes[0];
    this.cdr.detectChanges();
  }
  isEdit = (): boolean => this.edit() !== null && this.edit() !== undefined;
  custAssets = () => this.assets.filter((a) => a.cust === this.fm.cust && (a.status === 'Active' || a.code === this.fm.asset));
  techOpts = () => this.techs().filter((t) => t.tech && (t.active || t.code === this.fm.tech));
  hint = (): string => { // callAssetChanged 3738
    if (!this.fm.asset) return 'Choose the customer\'s asset.';
    const con = this.contracts.find((x) => !['Cancelled', 'Expired'].includes(x.status) && (x.lines || []).some((l) => l.asset === this.fm.asset));
    return con ? `Covered by contract ${con.code} (${this.fm.cust}).` : 'This asset is not on an active contract — the call may be chargeable.';
  };
  assetChange() { this.fm.asset = ''; this.cdr.detectChanges(); }
  statusChanged() { if (this.fm.status === 'Completed' && !this.fm.completed) this.fm.completed = todayIso(); } // 3739
  chip = (c: Call): string => ({ Logged: 'c-wn', Assigned: 'c-bl', 'In progress': 'c-bl', 'On hold': 'c-wn', Completed: 'c-ok', Cancelled: 'c-nt' }[c.status] || 'c-nt');
  odd = (c: Call): boolean => CALL_OPEN(c.status) && !!c.sched && c.sched < todayIso();
  filtered = (): Call[] => {
    const q = this.q.toLowerCase(), f = this.f, tf = this.tf;
    return this.calls().filter((c) => (!f || (f === 'open' ? CALL_OPEN(c.status) : c.status === f))
      && (!tf || (tf === '-' ? !c.tech : c.tech === tf))
      && (!q || (c.code + ' ' + c.custName + ' ' + c.asset + ' ' + c.descr).toLowerCase().includes(q)))
      .sort((a, b) => b.code.localeCompare(a.code));
  };
  stats = () => {
    const t0 = todayIso(), m = t0.slice(0, 7);
    return { open: this.calls().filter((c) => CALL_OPEN(c.status)).length, unassigned: this.calls().filter((c) => CALL_OPEN(c.status) && !c.tech).length,
      overdue: this.calls().filter((c) => CALL_OPEN(c.status) && c.sched && c.sched < t0).length,
      doneMonth: this.calls().filter((c) => c.status === 'Completed' && (c.completed || '').slice(0, 7) === m).length };
  };
  title = (): string => {
    const c = this.edit();
    return c ? (this.ro() ? 'Service Call ' + c.code : 'Edit Service Call ' + c.code) : 'Log Service Call';
  };
  ro = (): boolean => !!this.edit() && !CALL_OPEN(this.edit()!.status);
  close(e?: MouseEvent) { if (!e || (e.target as HTMLElement).classList.contains('modal-bg')) this.edit.set(undefined); this.cdr.detectChanges(); }
  openCall(c: Call | null, complete = false) {
    this.completeMode = complete;
    if (c) this.fm = { cust: c.cust, asset: c.asset, type: c.type, pri: c.pri, status: complete ? 'Completed' : c.status, descr: c.descr, tech: c.tech, logged: c.logged, sched: c.sched || '', completed: c.completed || '', hours: c.hours, cost: c.cost, res: c.res };
    else { this.fm = this.blank(); this.fm.type = this.ctypes[0] || 'Breakdown'; }
    this.edit.set(c ?? null);
    this.err.set('');
    this.cdr.detectChanges();
  }
  async save() {
    if (this.ro()) { this.close(); return; }
    this.err.set('');
    if (this.fm.status === 'Logged' && this.fm.tech) this.fm.status = 'Assigned'; // 3779
    try {
      const code = this.edit()?.code ?? '';
      const r = this.edit()
        ? await this.api.post<{ code: string }>('/calls/' + code, this.fm)
        : await this.api.post<{ code: string }>('/calls', this.fm);
      this.toast.show('Service call ' + r.code + ' saved.');
      this.edit.set(undefined);
      await this.reload();
    } catch (e) { this.err.set((e as ApiError).message); this.cdr.detectChanges(); }
  }
  async reload() { this.calls.set(await this.api.get<Call[]>('/calls')); this.cdr.detectChanges(); }
  async start(c: Call) { // callAction 3789
    try { await this.api.post('/calls/' + c.code + '/action', { action: 'start' }); await this.reload(); }
    catch (e) { this.toast.show((e as ApiError).message); }
  }
}

// ══ Call Requests tab (renderReqs 4472 / saveReq 4488 / convertReq 4497) ══
@Component({
  selector: 'app-sv-reqs',
  imports: [FormsModule],
  template: `
  <div class="g3" style="grid-template-columns:repeat(3,1fr)">
    <div class="card"><div class="stat-lbl">New requests</div><div class="stat-val">{{stats().New}}</div></div>
    <div class="card"><div class="stat-lbl">Converted to calls</div><div class="stat-val">{{stats().Converted}}</div></div>
    <div class="card"><div class="stat-lbl">Declined</div><div class="stat-val">{{stats().Declined}}</div></div></div>
  <div class="card">
    <div class="card-title">Call Requests <button class="btn btn-p btn-sm" (click)="openReq(null)">New Request</button></div>
    <div style="font-size:12px;color:var(--txm);margin-bottom:8px">Requests received from customers. Convert a request into a service call once it is accepted, or decline it with a reason.</div>
    <div class="fr3" style="margin-bottom:8px">
      <div class="fg"><label>Search</label><input [(ngModel)]="q" placeholder="Request no., customer, contact"></div>
      <div class="fg"><label>Status</label><select [(ngModel)]="f"><option value="">All</option><option>New</option><option>Converted</option><option>Declined</option></select></div></div>
    <table><thead><tr><th>Request</th><th>Customer</th><th>Asset</th><th>Contact</th><th>Priority</th><th>Received</th><th>Status</th><th style="width:210px"></th></tr></thead><tbody>
      @for (r of filtered(); track r.code) {
        <tr>
          <td><strong>{{r.code}}</strong><div style="font-size:11px;color:var(--txm)">{{r.descr}}</div>
            @if (r.status === 'Declined') {<div style="font-size:11px;color:var(--txm)">Reason: {{r.reason}}</div>}</td>
          <td>{{r.custName}}</td><td>{{r.asset}}</td>
          <td>{{r.contact}}@if (r.phone) {<div style="font-size:11px;color:var(--txm)">{{r.phone}}</div>}</td>
          <td>{{r.pri}}</td><td>{{fmtD(r.received,1)}}</td>
          <td><span class="chip {{SV_CHIP[r.status]}}">{{r.status}}</span>@if (r.call) {<div style="font-size:11px;color:var(--txm)">{{r.call}}</div>}</td>
          <td>@if (r.status === 'New') {
            <button class="btn btn-p btn-sm" (click)="convert(r)">Convert to call</button>
            <button class="btn btn-s btn-sm" (click)="openReq(r, true)">Decline</button>
            <button class="btn btn-s btn-sm" (click)="openReq(r)">Edit</button>
          }</td>
        </tr>
      } @empty { <tr><td colspan="8" style="text-align:center;color:var(--txm)">No call requests yet.</td></tr> }
    </tbody></table></div>

  @if (edit() !== undefined) {
    <div class="modal-bg" style="display:block" (click)="close($event)">
      <div class="modal" style="max-width:620px" (click)="$event.stopPropagation()">
        <div class="rm-hd"><strong>{{title()}}</strong><button class="btn btn-s btn-sm" (click)="close()">✕</button></div>
        @if (decline()) {
          <div class="fr"><div class="fg"><label>Reason for declining *</label><textarea [(ngModel)]="reason" rows="2"></textarea></div></div>
        } @else {
          <div class="fr"><div class="fg"><label>Customer *</label><select [(ngModel)]="fm.cust" (ngModelChange)="fm.asset = ''"><option value="">Select customer…</option>
              @for (cu of custs; track cu.code) { <option [value]="cu.code">{{cu.name}}</option> }</select></div>
            <div class="fg"><label>Asset *</label><select [(ngModel)]="fm.asset"><option value="">Select asset…</option>
              @for (a of assets; track a.code) { @if (a.cust === fm.cust) { <option [value]="a.code">{{a.code}} — {{a.name}}</option> } }</select></div></div>
          <div class="fr3">
            <div class="fg"><label>Contact person *</label><input [(ngModel)]="fm.contact" maxlength="60"></div>
            <div class="fg"><label>Phone</label><input [(ngModel)]="fm.phone" maxlength="30"></div>
            <div class="fg"><label>Priority *</label><select [(ngModel)]="fm.pri"><option>Urgent</option><option>High</option><option>Normal</option><option>Low</option></select></div></div>
          <div class="fr3">
            <div class="fg"><label>Received date *</label><input type="date" [(ngModel)]="fm.received"></div>
            <div class="fg" style="grid-column:span 2"><label>Problem or request *</label><textarea [(ngModel)]="fm.descr" rows="2"></textarea></div></div>
        }
        <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
        <div class="btn-grp"><button class="btn btn-p" (click)="save()">{{decline() ? 'Decline Request' : 'Save Request'}}</button>
          <button class="btn btn-s" (click)="close()">Cancel</button></div>
      </div></div>
  }`,
})
export class SvReqsComponent {
  fmtD = fmtD; SV_CHIP = SV_CHIP; cdr = inject(ChangeDetectorRef);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  reqs = signal<Req[]>([]); custs: Cust[] = []; assets: Asset[] = [];
  edit = signal<Req | null | undefined>(undefined);
  declineMode = false; reason = ''; err = signal('');
  q = ''; f = '';
  fm: { cust: string; asset: string; contact: string; phone: string; pri: string; received: string; descr: string } = { cust: '', asset: '', contact: '', phone: '', pri: 'Normal', received: todayIso(), descr: '' };

  constructor() { void this.init(); }
  async init() {
    const [rq, custs, assets] = await Promise.all([this.api.get<Req[]>('/requests'), this.api.get<Cust[]>('/customers'), this.api.get<Asset[]>('/assets')]);
    this.reqs.set(rq); this.custs = custs; this.assets = assets;
    this.cdr.detectChanges();
  }
  filtered = (): Req[] => {
    const q = this.q.toLowerCase();
    return this.reqs().filter((r) => (!this.f || r.status === this.f) && (!q || (r.code + ' ' + r.custName + ' ' + r.contact + ' ' + r.descr).toLowerCase().includes(q)))
      .sort((a, b) => b.code.localeCompare(a.code));
  };
  stats = () => ({ New: this.reqs().filter((r) => r.status === 'New').length, Converted: this.reqs().filter((r) => r.status === 'Converted').length, Declined: this.reqs().filter((r) => r.status === 'Declined').length });
  decline = (): boolean => this.declineMode;
  title = (): string => {
    const r = this.edit();
    return this.declineMode ? 'Decline Request ' + r!.code : r ? 'Edit Request ' + r.code : 'New Call Request';
  };
  openReq(r: Req | null, decline = false) {
    this.declineMode = decline; this.reason = '';
    if (r) this.fm = { cust: r.cust, asset: r.asset, contact: r.contact, phone: r.phone, pri: r.pri, received: r.received, descr: r.descr };
    else this.fm = { cust: '', asset: '', contact: '', phone: '', pri: 'Normal', received: todayIso(), descr: '' };
    this.edit.set(r ?? null);
    this.err.set('');
    this.cdr.detectChanges();
  }
  close(e?: MouseEvent) { if (!e || (e.target as HTMLElement).classList.contains('modal-bg')) this.edit.set(undefined); this.cdr.detectChanges(); }
  async save() {
    this.err.set('');
    try {
      if (this.declineMode) {
        const r = this.edit()!; // decline: only a reason is captured (4490)
        await this.api.post('/requests/' + r.code + '/decline', { reason: this.reason });
        this.toast.show('Request declined.');
      } else if (this.edit()) {
        const r = this.edit()!;
        await this.api.post('/requests/' + r.code, this.fm);
        this.toast.show('Request saved.');
      } else {
        await this.api.post('/requests', this.fm);
        this.toast.show('Request saved.');
      }
      this.edit.set(undefined);
      await this.reload();
    } catch (e) { this.err.set((e as ApiError).message); this.cdr.detectChanges(); }
  }
  async convert(r: Req) {
    try {
      const res = await this.api.post<{ code: string }>('/requests/' + r.code + '/convert');
      this.toast.show('Service call ' + res.code + ' created.');
      await this.reload();
    } catch (e) { this.toast.show((e as ApiError).message); }
  }
  async reload() { this.reqs.set(await this.api.get<Req[]>('/requests')); this.cdr.detectChanges(); }
}

// ══ Work Orders tab (renderWOs 4549 / saveWO 4525 / printWO 4557) ══
@Component({
  selector: 'app-sv-wo',
  imports: [FormsModule],
  template: `
  <div class="g3" style="grid-template-columns:repeat(4,1fr)">
    <div class="card"><div class="stat-lbl">Issued</div><div class="stat-val">{{stats().Issued}}</div></div>
    <div class="card"><div class="stat-lbl">In progress</div><div class="stat-val">{{stats()['In progress']}}</div></div>
    <div class="card"><div class="stat-lbl">Completed</div><div class="stat-val">{{stats().Completed}}</div></div>
    <div class="card"><div class="stat-lbl">Parts used (excl VAT)</div><div class="stat-val">{{partsUsed()}}</div></div></div>
  <div class="card">
    <div class="card-title"><span>Work Orders</span>
      <span style="display:flex;gap:6px">
        <button class="btn btn-s btn-sm" title="Export PDF" (click)="export('pdf')"><i class="ti ti-file-type-pdf"></i></button>
        <button class="btn btn-s btn-sm" title="Export Excel" (click)="export('xlsx')"><i class="ti ti-file-spreadsheet"></i></button>
        <button class="btn btn-s btn-sm" title="Export CSV" (click)="export('csv')"><i class="ti ti-file-text"></i></button>
        <button class="btn btn-p btn-sm" (click)="openWo(null)">New Work Order</button></span></div>
    <div class="fr3" style="margin-bottom:8px">
      <div class="fg"><label>Search</label><input [(ngModel)]="q" placeholder="Work order, call, customer"></div>
      <div class="fg"><label>Status</label><select [(ngModel)]="f"><option value="">All</option><option value="open">Open (not completed)</option>
        @for (s of woStatuses; track s) { <option [value]="s">{{s}}</option> }</select></div></div>
    <table><thead><tr><th>Work order</th><th>Customer / asset</th><th>Call</th><th>Technician</th><th>Scheduled</th><th class="tr">Hours</th><th class="tr">Parts (excl VAT)</th><th>Status</th><th style="width:200px"></th></tr></thead><tbody>
      @for (w of filtered(); track w.code) {
        <tr>
          <td><strong>{{w.code}}</strong><div style="font-size:11px;color:var(--txm)">{{w.instr}}</div></td>
          <td>{{w.custName}}<div style="font-size:11px;color:var(--txm)">{{w.asset}}</div></td>
          <td>{{w.call}}</td><td>{{w.techName || '—'}}</td>
          <td>{{w.sched ? fmtD(w.sched,1) : '—'}}</td>
          <td class="tr">{{w.hours}}</td><td class="tr">{{fmtR(w.partsCost)}}</td>
          <td><span class="chip {{SV_CHIP[w.status]}}">{{w.status}}</span></td>
          <td><button class="btn btn-s btn-sm" (click)="openWo(w)">@if (OPEN(w.status)) { Edit } @else { View }</button>
            <button class="btn btn-s btn-sm" (click)="print(w)">Print</button></td>
        </tr>
      } @empty { <tr><td colspan="9" style="text-align:center;color:var(--txm)">No work orders yet.</td></tr> }
    </tbody></table></div>

  @if (edit() !== undefined) {
    <div class="modal-bg" style="display:block" (click)="close($event)">
      <div class="modal" style="max-width:760px" (click)="$event.stopPropagation()">
        <div class="rm-hd"><strong>{{title()}}</strong><button class="btn btn-s btn-sm" (click)="close()">✕</button></div>
        <div class="fr"><div class="fg"><label>Service call *</label>
            <select [(ngModel)]="fm.call" (ngModelChange)="callChanged()" [disabled]="isEdit()"><option value="">Select service call…</option>
              @for (c of callOpts(); track c.code) { <option [value]="c.code">{{c.code}} — {{c.custName}} — {{c.asset}}</option> }</select></div>
          <div class="fg"><label>Technician *</label><select [(ngModel)]="fm.tech"><option value="">— technician —</option>
              @for (t of techOpts(); track t.code) { <option [value]="t.code">{{t.name}}{{t.active ? '' : ' (inactive)'}}</option> }</select></div></div>
        <div class="fr3">
          <div class="fg"><label>Scheduled</label><input type="date" [(ngModel)]="fm.sched"></div>
          <div class="fg"><label>Status *</label><select [(ngModel)]="fm.status" (ngModelChange)="statusChanged()">@for (s of woStatuses; track s) { <option [value]="s">{{s}}</option> }</select></div>
          <div class="fg"><label>Hours</label><input type="number" min="0" step="any" [(ngModel)]="fm.hours"></div></div>
        <div class="fr"><div class="fg"><label>Instructions / work to be done *</label><textarea [(ngModel)]="fm.instr" rows="2"></textarea></div></div>
        <div class="card" style="margin:8px 0">
          <div class="card-title" style="font-size:13px">Parts &amp; materials <button class="btn btn-s btn-sm" type="button" (click)="addPart()">Add part</button></div>
          <table><thead><tr><th>Part</th><th style="width:90px">Qty</th><th style="width:120px">Unit cost</th><th style="width:60px"></th></tr></thead><tbody>
            @for (p of fm.parts; track $index) {
              <tr>
                <td><select [(ngModel)]="p.sku" (ngModelChange)="pickPart(p)"><option value="">— Other / non-stock part —</option>
                    @for (i of items; track i.sku) { <option [value]="i.sku">{{i.sku}} — {{i.name}}</option> }</select>
                  <input [(ngModel)]="p.descr" maxlength="80" placeholder="Description" [disabled]="!!p.sku" style="margin-top:4px"></td>
                <td><input type="number" min="0" step="1" [(ngModel)]="p.qty"></td>
                <td><input type="number" min="0" step="0.01" [(ngModel)]="p.cost"></td>
                <td><button class="btn btn-s btn-sm" type="button" (click)="delPart($index)">✕</button></td>
              </tr>
            } @empty { <tr><td colspan="4" style="color:var(--txm)">No parts.</td></tr> }
          </tbody></table></div>
        @if (fm.status === 'Completed') {
          <div class="fr3">
            <div class="fg"><label>Date completed *</label><input type="date" [(ngModel)]="fm.completed"></div>
            <div class="fg" style="grid-column:span 2"><label>What work was done *</label><textarea [(ngModel)]="fm.notes" rows="2"></textarea></div></div>
        }
        <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
        <div class="btn-grp">@if (!ro()) { <button class="btn btn-p" (click)="save()">Save Work Order</button> } <button class="btn btn-s" (click)="close()">Cancel</button></div>
      </div></div>
  }`,
})
export class SvWoComponent {
  fmtR = fmtR; fmtD = fmtD; fmtDMY = fmtDMY; SV_CHIP = SV_CHIP; OPEN = (s: string) => WO_OPEN.includes(s);
  private exporter = inject(Exporter);
  // svExport('wo') port 4599
  export(fmt: 'pdf' | 'xlsx' | 'csv') {
    this.exporter.download({
      title: 'Work Orders',
      sections: [{ cols: [{ h: 'Work order' }, { h: 'Call' }, { h: 'Customer' }, { h: 'Asset' }, { h: 'Technician' }, { h: 'Scheduled', t: 'd' }, { h: 'Hours', t: 'i' }, { h: 'Parts', t: 'm' }, { h: 'Status' }],
        rows: this.wos().slice().sort((a, b) => a.code.localeCompare(b.code)).map((w) => [w.code, w.call, w.custName, w.asset, w.techName || '', w.sched || '', w.hours, w.partsCost, w.status]) }],
    }, fmt);
  }
  woStatuses = ['Issued', 'In progress', 'Completed', 'Cancelled'];
  private api = inject(ApiService);
  private toast = inject(ToastService);
  cdr = inject(ChangeDetectorRef);
  wos = signal<Wo[]>([]); calls = signal<Call[]>([]); techs = signal<Staff[]>([]); items: Item[] = [];
  edit = signal<Wo | null | undefined>(undefined);
  err = signal('');
  q = ''; f = '';
  fm: { call: string; tech: string; sched: string; status: string; hours: number; instr: string; completed: string; notes: string; parts: Part[] } =
    { call: '', tech: '', sched: '', status: 'Issued', hours: 0, instr: '', completed: '', notes: '', parts: [] };

  constructor() { void this.init(); }
  async init() {
    const [wos, calls, staff, items] = await Promise.all([
      this.api.get<Wo[]>('/workorders'), this.api.get<Call[]>('/calls'), this.api.get<Staff[]>('/techs'),
      this.api.get<Item[]>('/inv/items').catch(() => [] as Item[]),
    ]);
    this.wos.set(wos); this.calls.set(calls); this.techs.set(staff); this.items = items.filter((i) => i.cost !== undefined);
    this.cdr.detectChanges();
  }
  filtered = (): Wo[] => {
    const q = this.q.toLowerCase(), f = this.f;
    return this.wos().filter((w) => (!f || (f === 'open' ? WO_OPEN.includes(w.status) : w.status === f))
      && (!q || (w.code + ' ' + w.call + ' ' + w.custName + ' ' + w.asset).toLowerCase().includes(q)))
      .sort((a, b) => b.code.localeCompare(a.code));
  };
  stats = () => ({ Issued: this.wos().filter((w) => w.status === 'Issued').length, 'In progress': this.wos().filter((w) => w.status === 'In progress').length,
    Completed: this.wos().filter((w) => w.status === 'Completed').length });
  partsUsed = (): string => fmtR(this.wos().filter((w) => w.status !== 'Cancelled').reduce((t, w) => t + w.partsCost, 0));
  woPartsTotal = (p: Part[]): number => p.reduce((t, x) => t + (x.qty || 0) * (x.cost || 0), 0);
  callOpts = () => this.calls().filter((c) => c.code === this.fm.call || (CALL_OPEN(c.status) && !c.hasOpenWo)); // 4504
  techOpts = () => this.techs().filter((t) => t.tech && (t.active || t.code === this.fm.tech));
  isEdit = (): boolean => this.edit() !== null && this.edit() !== undefined;
  ro = (): boolean => !!this.edit() && !WO_OPEN.includes(this.edit()!.status);
  title = (): string => {
    const w = this.edit();
    return w ? (this.ro() ? 'Work Order ' + w.code : 'Edit Work Order ' + w.code) : 'New Work Order';
  };
  openWo(w: Wo | null) {
    if (w) this.fm = { call: w.call, tech: w.tech, sched: w.sched || '', status: w.status, hours: w.hours, instr: w.instr, completed: w.completed || '', notes: w.notes, parts: [] };
    else this.fm = { call: '', tech: '', sched: '', status: 'Issued', hours: 0, instr: '', completed: '', notes: '', parts: [] };
    this.edit.set(w ?? null);
    this.err.set('');
    if (w) void this.loadParts(w.code);
    this.cdr.detectChanges();
  }
  async loadParts(code: string) {
    const parts = await this.api.get<Part[]>('/workorders/' + code + '/parts').catch(() => []);
    this.fm.parts = parts.filter((p) => p.descr || p.qty || p.cost);
    this.cdr.detectChanges();
  }
  callChanged() { // woCallChanged 4514
    const c = this.calls().find((x) => x.code === this.fm.call);
    if (c && !this.isEdit()) {
      this.fm.tech = c.tech;
      this.fm.sched = c.sched || '';
      this.fm.instr = c.descr;
      this.cdr.detectChanges();
    }
  }
  statusChanged() { if (this.fm.status === 'Completed' && !this.fm.completed) this.fm.completed = todayIso(); }
  addPart() { this.fm.parts.push({ descr: '', sku: '', qty: 1, cost: 0 }); this.cdr.detectChanges(); }
  delPart(i: number) { this.fm.parts.splice(i, 1); this.cdr.detectChanges(); }
  pickPart(p: Part) {
    const i = this.items.find((x) => x.sku === p.sku);
    if (i) { p.descr = i.sku; p.cost = i.cost; } else { p.descr = ''; }
    this.cdr.detectChanges();
  }
  close(e?: MouseEvent) { if (!e || (e.target as HTMLElement).classList.contains('modal-bg')) this.edit.set(undefined); this.cdr.detectChanges(); }
  async save() {
    if (this.ro()) { this.close(); return; }
    this.err.set('');
    const parts = this.fm.parts.filter((x) => x.descr || x.qty || x.cost); // readParts 4512
    const body = { ...this.fm, parts };
    try {
      const code = this.edit()?.code ?? '';
      const r = this.isEdit()
        ? await this.api.post<{ code: string }>('/workorders/' + code, body)
        : await this.api.post<{ code: string }>('/workorders', body);
      this.toast.show('Work order ' + r.code + ' saved.');
      this.edit.set(undefined);
      await this.reload();
    } catch (e) { this.err.set((e as ApiError).message); this.cdr.detectChanges(); }
  }
  async reload() {
    const [wos, calls] = await Promise.all([this.api.get<Wo[]>('/workorders'), this.api.get<Call[]>('/calls')]);
    this.wos.set(wos); this.calls.set(calls); this.cdr.detectChanges();
  }
  // printWO 4557 — print work order document (parts fetched first)
  async print(w: Wo) {
    const c = this.calls().find((x) => x.code === w.call) || ({} as Partial<Call>);
    const t = { name: w.techName };
    const parts = await this.api.get<Part[]>('/workorders/' + w.code + '/parts').catch(() => [] as Part[]);
    const partsHtml = parts.length
      ? parts.map((x) => `<tr><td>${x.descr}</td><td style="text-align:right">${x.qty}</td><td style="text-align:right">${fmtR(x.cost)}</td><td style="text-align:right">${fmtR(x.qty * x.cost)}</td></tr>`).join('')
      : '<tr><td colspan="4" style="color:#888">No parts recorded.</td></tr>';
    const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${w.code}</title><style>body{font-family:Arial,Helvetica,sans-serif;color:#222;margin:30px;font-size:12px}h1{font-size:22px;margin:0}table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border-bottom:1px solid #ddd;padding:7px 8px;text-align:left;vertical-align:top}th{background:#fafafa;color:#888;font-weight:400;font-style:italic}.g{color:#888;font-size:11px;font-weight:700;text-transform:uppercase;margin-top:12px}.sig{margin-top:40px;display:flex;gap:40px}.sig div{flex:1;border-top:1px solid #888;padding-top:4px;color:#666}</style></head><body>
<table style="border:0"><tr><td style="border:0"><strong style="font-size:16px">${(c as Partial<Call>).custName || ''}</strong></td><td style="border:0;text-align:right"><h1>WORK ORDER</h1><div><strong>${w.code}</strong> · Call ${w.call}</div><div>Status: ${w.status}</div><div>Scheduled: ${w.sched ? fmtDMY(w.sched) : '—'}</div></td></tr></table>
<div class="g">Customer</div><div><strong>${(c as Partial<Call>).custName || ''}</strong></div>
<div class="g">Asset</div><div>${(c as Partial<Call>).asset || ''} — ${(c as Partial<Call>).assetName || ''}</div>
<div class="g">Technician</div><div>${t.name || ''}</div>
<div class="g">Work to be done</div><div>${w.instr}</div>
<div class="g">Parts &amp; materials</div><table><thead><tr><th>Description</th><th style="text-align:right">Qty</th><th style="text-align:right">Unit cost</th><th style="text-align:right">Total</th></tr></thead><tbody>${partsHtml}</tbody></table>
<div>Labour hours: <strong>${w.hours}</strong> &nbsp; Parts total (excl VAT): <strong>${fmtR(w.partsCost)}</strong></div>
${w.status === 'Completed' ? `<div class="g">Work done (${fmtDMY(w.completed || '')})</div><div>${w.notes}</div>` : ''}
<div class="sig"><div>Technician signature</div><div>Customer signature &amp; name</div><div>Date</div></div></body></html>`;
    const win = window.open('', '_blank');
    if (!win) { alert('The pop-up was blocked. Allow pop-ups for this page to print.'); return; }
    win.document.write(doc); win.document.close(); win.focus(); setTimeout(() => win.print(), 300);
  }
}

// ══ Work In Progress tab (renderWip 4578) — rows computed by GET /wip ══
@Component({
  selector: 'app-sv-wip',
  imports: [FormsModule],
  template: `
  <div class="g3" style="grid-template-columns:repeat(4,1fr)">
    <div class="card"><div class="stat-lbl">Calls in progress</div><div class="stat-val">{{wip().rows.length}}</div></div>
    <div class="card"><div class="stat-lbl">Open work orders</div><div class="stat-val">{{wip().openWos}}</div></div>
    <div class="card"><div class="stat-lbl">Past resolution SLA</div><div class="stat-val">{{breached()}}</div></div>
    <div class="card"><div class="stat-lbl">Parts to date (excl VAT)</div><div class="stat-val">{{fmtR(partsTot())}}</div></div></div>
  <div class="card">
    <div class="card-title"><span>Work In Progress</span>
      <span style="display:flex;gap:6px">
        <button class="btn btn-s btn-sm" title="Export PDF" (click)="export('pdf')"><i class="ti ti-file-type-pdf"></i></button>
        <button class="btn btn-s btn-sm" title="Export Excel" (click)="export('xlsx')"><i class="ti ti-file-spreadsheet"></i></button>
        <button class="btn btn-s btn-sm" title="Export CSV" (click)="export('csv')"><i class="ti ti-file-text"></i></button></span></div>
    <div style="font-size:12px;color:var(--txm);margin-bottom:8px">Service calls that have been assigned or started and are not yet completed, with their open work orders, age and SLA position.</div>
    <table><thead><tr><th>Call</th><th>Customer / asset</th><th>Technician</th><th>Work order</th><th class="tr">Age (days)</th><th class="tr">Hours</th><th class="tr">Parts (excl VAT)</th><th>SLA</th><th>Status</th></tr></thead><tbody>
      @for (r of wip().rows; track r.call.code) {
        <tr>
          <td><strong>{{r.call.code}}</strong><div style="font-size:11px;color:var(--txm)">{{r.call.descr}}</div></td>
          <td>{{r.call.custName}}<div style="font-size:11px;color:var(--txm)">{{r.call.asset}}</div></td>
          <td>{{r.call.techName || '—'}}</td>
          <td>@if (r.ow) { {{r.ow.code}} <span class="chip {{SV_CHIP[r.ow.status]}}">{{r.ow.status}}</span> } @else { — }</td>
          <td class="tr">{{r.age}}</td><td class="tr">{{r.hours}}</td><td class="tr">{{fmtR(r.parts)}}</td>
          <td><span class="chip {{slaChip(r.sla.reso)}}">{{r.sla.reso}}</span></td>
          <td><span class="chip {{r.call.status === 'On hold' ? 'c-wn' : 'c-bl'}}">{{r.call.status}}</span></td>
        </tr>
      } @empty { <tr><td colspan="9" style="text-align:center;color:var(--txm)">Nothing in progress.</td></tr> }
    </tbody></table></div>
  <div class="card" style="margin-top:16px">
    <div class="card-title">By technician</div>
    <table><thead><tr><th>Technician</th><th class="tr">Calls in progress</th><th class="tr">Open work orders</th><th class="tr">Hours logged</th><th class="tr">Parts (excl VAT)</th></tr></thead><tbody>
      @for (t of wip().techRows; track t.tech) {
        <tr><td>{{t.tech}}</td><td class="tr">{{t.calls}}</td><td class="tr">{{t.wos}}</td><td class="tr">{{t.hours}}</td><td class="tr">{{fmtR(t.parts)}}</td></tr>
      } @empty { <tr><td colspan="5" style="text-align:center;color:var(--txm)">No technician has work in progress.</td></tr> }
    </tbody></table></div>`,
})
export class SvWipComponent {
  fmtR = fmtR; SV_CHIP = SV_CHIP; slaChip = slaChip; cdr = inject(ChangeDetectorRef);
  private api = inject(ApiService);
  private exporter = inject(Exporter);
  data = signal<{ rows: WipRow[]; techRows: TechRow[]; openWos: number }>({ rows: [], techRows: [], openWos: 0 });
  breached = () => this.data().rows.filter((r) => r.sla.reso === 'Breached').length;
  partsTot = () => this.data().rows.reduce((t, r) => t + r.parts, 0);
  wip = this.data;
  // svExport('wip') port 4600
  export(fmt: 'pdf' | 'xlsx' | 'csv') {
    this.exporter.download({
      title: 'Work In Progress',
      sections: [{ cols: [{ h: 'Call' }, { h: 'Customer' }, { h: 'Asset' }, { h: 'Technician' }, { h: 'Work order' }, { h: 'Age (days)', t: 'i' }, { h: 'Hours', t: 'i' }, { h: 'Parts', t: 'm' }, { h: 'Resolution SLA' }, { h: 'Status' }],
        rows: this.data().rows.map((r) => [r.call.code, r.call.custName, r.call.asset || '', r.call.techName || '', r.ow ? r.ow.code + ' (' + r.ow.status + ')' : '', r.age, r.hours, r.parts, r.sla.reso, r.call.status]) }],
    }, fmt);
  }
  constructor() {
    void this.api.get<{ rows: WipRow[]; techRows: TechRow[]; openWos: number }>('/wip')
      .then((d) => { this.data.set(d); this.cdr.detectChanges(); });
  }
}

// ══ Call SLA tab (renderSla/saveSla 4585–4597) ══
@Component({
  selector: 'app-sv-sla',
  imports: [FormsModule],
  template: `
  <div class="g3" style="grid-template-columns:repeat(4,1fr)">
    <div class="card"><div class="stat-lbl">Resolved within SLA</div><div class="stat-val">{{stats().within}}</div></div>
    <div class="card"><div class="stat-lbl">Open calls past resolution</div><div class="stat-val">{{stats().pastReso}}</div></div>
    <div class="card"><div class="stat-lbl">Response breached</div><div class="stat-val">{{stats().respBreached}}</div></div>
    <div class="card"><div class="stat-lbl">Calls measured</div><div class="stat-val">{{stats().measured}}</div></div></div>
  <div class="card" style="margin-bottom:16px">
    <div class="card-title">SLA targets by priority</div>
    <div style="font-size:12px;color:var(--txm);margin-bottom:8px">Targets are counted in calendar days from the logged date. A call is <strong>responded to</strong> when a visit is scheduled, and <strong>resolved</strong> when it is completed.</div>
    <table><thead><tr><th>Priority</th><th>Respond within (days)</th><th>Resolve within (days)</th></tr></thead><tbody>
      @for (t of sla(); track t.pri) {
        <tr><td><strong>{{t.pri}}</strong></td>
          <td><input type="number" min="0" max="365" step="1" [(ngModel)]="t.resp" style="width:90px"></td>
          <td><input type="number" min="0" max="365" step="1" [(ngModel)]="t.res" style="width:90px"></td></tr>
      }</tbody></table>
    <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
    <div class="btn-grp"><button class="btn btn-p" (click)="save()">Save SLA Targets</button></div></div>
  <div class="card"><div class="card-title">Call SLA position</div>
    <table><thead><tr><th>Call</th><th>Customer</th><th>Priority</th><th>Logged</th><th>Respond by</th><th>Resolve by</th><th>Response</th><th>Resolution</th></tr></thead><tbody>
      @for (r of position(); track r.c.code) {
        <tr><td><strong>{{r.c.code}}</strong></td><td>{{r.c.custName}}</td><td>{{r.c.pri}}</td>
          <td>{{fmtD(r.c.logged,1)}}</td>
          @if (r.c.status !== 'Cancelled') {
            <td>{{fmtD(dayAdd(r.c.logged, slaFor(r.c.pri).resp),1)}}</td>
            <td>{{fmtD(dayAdd(r.c.logged, slaFor(r.c.pri).res),1)}}</td>
          } @else { <td>—</td><td>—</td> }
          <td><span class="chip {{slaChip(r.s.resp)}}">{{r.s.resp}}</span></td>
          <td><span class="chip {{slaChip(r.s.reso)}}">{{r.s.reso}}</span></td></tr>
      } @empty { <tr><td colspan="8" style="text-align:center;color:var(--txm)">No service calls yet.</td></tr> }
    </tbody></table></div>`,
})
export class SvSlaComponent {
  fmtD = fmtD; slaChip = slaChip; dayAdd = dayAdd; cdr = inject(ChangeDetectorRef);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  sla() { return this.slaS; }
  slaS: Sla[] = []; calls: Call[] = []; err = signal('');
  constructor() { void this.init(); }
  async init() {
    const [s, calls] = await Promise.all([this.api.get<Sla[]>('/sla'), this.api.get<Call[]>('/calls')]);
    this.slaS = s; this.calls = calls;
    this.cdr.detectChanges();
  }
  slaFor = (pri: string): Sla => this.slaS.find((x) => x.pri === pri) || ({ pri, resp: 2, res: 5 } as Sla);
  position = () => {
    const t0 = todayIso();
    return this.calls.filter((c) => c.status !== 'Cancelled').map((c) => ({ c, s: slaState(c, this.slaS, t0) }))
      .sort((a, b) => b.c.code.localeCompare(a.c.code));
  };
  stats = () => {
    const t0 = todayIso();
    const all = this.calls.filter((c) => c.status !== 'Cancelled').map((c) => ({ c, s: slaState(c, this.slaS, t0) }));
    const done = all.filter((x) => x.c.status === 'Completed');
    const met = done.filter((x) => x.s.reso === 'Met').length;
    return { within: done.length ? Math.round((met / done.length) * 100) + '%' : '—',
      pastReso: all.filter((x) => CALL_OPEN(x.c.status) && x.s.reso === 'Breached').length,
      respBreached: all.filter((x) => x.s.resp === 'Breached').length, measured: all.length };
  };
  async save() {
    this.err.set('');
    const n = this.slaS;
    if (n.some((x) => !(x.resp >= 0 && x.resp <= 365) || !(x.res >= 0 && x.res <= 365))) { this.err.set('Enter whole days from 0 to 365.'); return; }
    if (n.some((x) => x.res < x.resp)) { this.err.set('The resolve target cannot be shorter than the respond target.'); return; }
    try {
      await this.api.put('/sla', n);
      this.toast.show('SLA targets saved.');
    } catch (e) { this.err.set((e as ApiError).message); }
    this.cdr.detectChanges();
  }
}
