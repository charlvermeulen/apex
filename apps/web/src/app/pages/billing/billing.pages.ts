// Contract Billing (legacy 1053–1096 markup, runBilling 3563, meters 3648, periods 3611, escalations 5717, history 3588, invoiceHtml 3801).
import { Component, ChangeDetectorRef, viewChild, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, ApiError, ToastService } from '../../core/api';
import { AuthStore } from '../../core/auth.store';
import { fmtR, fmtD, fmtDMY, todayIso } from '../../core/fmt';

const dayAdd = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); const p = (x: number) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

const perFirst = (p: string) => p + '-01';
const perLast = (p: string) => new Date(Date.UTC(+p.slice(0, 4), +p.slice(5, 7), 0)).toISOString().slice(0, 10);

interface Per { id: string; status: 'open' | 'closed'; closedAt?: string | null; closedBy?: string | null; inv?: number; mb?: number }
interface DueItem { line: { id: number; type: string; asset: string; descr: string; amt: number; lastBilled?: string }; from: string; to: string; ex: number }
interface DueMeter { meter: { id: number; asset: string; type: string }; u: { op: number; end: number; pages: number; amt: number; rate: number } }
interface DueRow { con: { code: string; custName: string }; items: DueItem[]; mitems: DueMeter[]; ex: number; vat: number; tot: number }
interface MeterRow { con: string; custName: string; id: number; asset: string; type: string; rate: number; opening: number; end: number | null; pages: number; amt: number; rateNow: number; billed: boolean }
interface Inv { id: number; date: string; con: string; cust: string; custName: string; ex: number; vat: number; tot: number; lines: { type: string; descr?: string; asset?: string; from: string; to: string; ex: number }[] }

// ── invoice view modal (viewInvoice 3830 / invoiceHtml 3801; email deferred) ──
export const INV_CUR = signal<Inv | null>(null);

@Component({
  selector: 'app-inv-modal',
  imports: [],
  template: `
  @if (inv()) {
    <div class="modal-bg" style="display:block" (click)="close($event)">
      <div class="modal" style="max-width:900px;max-height:88vh;overflow:auto" (click)="$event.stopPropagation()">
        <div class="rm-hd"><strong>Contract Invoice {{inv()!.id}}</strong><button class="btn btn-s btn-sm" (click)="close()">✕</button></div>
        <div style="font-family:Arial,sans-serif;color:#222;background:#fff;padding:24px;border:1px solid #ddd">
          <table style="width:100%"><tr>
            <td style="vertical-align:top;width:52%">
              <div style="font-size:22px;font-weight:800;letter-spacing:2px">{{co()?.name}}</div>
              @if (co()?.reg) {<div style="font-size:11px;color:#8a8a8a">Reg: {{co()?.reg}}</div>}
              @if (co()?.vat_no) {<div style="font-size:11px;color:#8a8a8a">Supplier VAT No. {{co()?.vat_no}}</div>}
              <div style="font-size:15px;font-weight:700;color:#c66">Contract Invoice</div>
              <div style="font-size:12px;color:#555">{{fmtDMY(inv()!.date)}}</div></td>
            <td style="vertical-align:top">
              <div style="font-size:11px;font-weight:700;color:#8a8a8a;text-transform:uppercase">To</div>
              <div style="font-size:16px;font-weight:700;text-transform:uppercase">{{inv()!.custName}}</div>
              @if (det()?.vat_no) {<div style="font-size:12px;font-weight:700;color:#666">CUSTOMER VAT NO: {{det()?.vat_no}}</div>}
              <div style="font-size:12px;font-weight:700;color:#8a8a8a;text-transform:uppercase;margin-top:6px">Postal address:</div>
              <div style="font-size:12px;color:#555">{{addr() || ''}}</div></td></tr></table>
          <table style="width:100%;border-collapse:collapse;margin-top:12px">
            <thead><tr><th style="text-align:left;border-top:1px solid #dcdcdc;border-bottom:1px solid #dcdcdc;background:#fafafa;padding:7px 8px;font-size:11.5px;color:#8a8a8a">Description</th>
              <th style="border-top:1px solid #dcdcdc;border-bottom:1px solid #dcdcdc;background:#fafafa;padding:7px 8px;font-size:11.5px;color:#8a8a8a">Billing period</th>
              <th style="text-align:right;border-top:1px solid #dcdcdc;border-bottom:1px solid #dcdcdc;background:#fafafa;padding:7px 8px;font-size:11.5px;color:#8a8a8a">Amount (excl VAT)</th></tr></thead>
            <tbody>@for (l of inv()!.lines; track $index) {
              <tr><td style="padding:11px 8px;font-size:12px;border-bottom:1px solid #dcdcdc"><strong>{{l.type}}</strong>@if (l.descr) {<div style="font-style:italic;color:#555">{{l.descr}}</div>}@if (l.asset) {<div style="font-size:11px;color:#8a8a8a">Asset {{l.asset}}</div>}</td>
                <td style="padding:11px 8px;font-size:12px;border-bottom:1px solid #dcdcdc;color:#555;white-space:nowrap">{{l.from ? fmtDMY(l.from) + ' – ' + fmtDMY(l.to) : ''}}</td>
                <td style="padding:11px 8px;font-size:12px;border-bottom:1px solid #dcdcdc;text-align:right">{{fmtR(l.ex)}}</td></tr>
            }</tbody></table>
          <table style="width:100%;margin-top:14px"><tr>
            <td style="vertical-align:bottom;width:52%;font-size:11.5px;color:#666"><div style="font-weight:700;color:#444;margin-bottom:4px">Payment details</div>Reference: <strong>{{inv()!.id}}</strong><br>Payment due by <strong>{{fmtDMY(due())}}</strong> (30 days from invoice date)</td>
            <td style="vertical-align:top;text-align:right;font-size:12px">
              <table style="margin-left:auto"><tr><td style="color:#8a8a8a;text-align:right;padding:2px 14px 2px 0">Subtotal (excl VAT)</td><td style="font-weight:700;color:#555;text-align:right">{{fmtR(inv()!.ex)}}</td></tr>
              <tr><td style="color:#8a8a8a;text-align:right;padding:2px 14px 2px 0">VAT @ 15%</td><td style="font-weight:700;color:#555;text-align:right">{{fmtR(inv()!.vat)}}</td></tr>
              <tr><td style="color:#8a8a8a;text-align:right;padding:2px 14px 2px 0">Total (incl VAT)</td><td style="font-weight:700;color:#555;text-align:right">{{fmtR(inv()!.tot)}}</td></tr></table></td></tr></table>
          <div style="margin-top:22px;border-top:1px solid #dcdcdc;padding-top:10px;font-size:10.5px;color:#8a8a8a">Tax invoice issued in terms of section 20 of the VAT Act, No. 89 of 1991. Supplier VAT No. {{co()?.vat_no || ''}}. Late payment may attract interest. E&amp;OE.</div>
        </div>
        <div style="display:flex;gap:8px;padding:10px 0">
          <button class="btn btn-p" (click)="print()"><i class="ti ti-printer"></i> Print</button>
          <button class="btn btn-s" (click)="download()"><i class="ti ti-download"></i> Download</button></div>
      </div></div>
  }`,
})
export class InvModalComponent {
  fmtR = fmtR; fmtDMY = fmtDMY;
  private api = inject(ApiService);
  co = inject(AuthStore).company;
  det = signal<any>(null);
  inv = INV_CUR;
  due = () => dayAdd(this.inv()?.date || '', 30);
  addr = () => {
    const d: any = this.det() || {};
    return [d.street, d.suburb, d.city, d.postal_code].filter(Boolean).join(', ');
  };

  async open(i: Inv) {
    INV_CUR.set(i);
    this.det.set(await this.api.get<any>('/billing/invoices/' + i.id).catch(() => null));
  }
  close(e?: MouseEvent) { if (!e || (e.target as HTMLElement).classList.contains('modal-bg')) INV_CUR.set(null); }
  doc = () => '<!doctype html><html><head><meta charset="utf-8"><title>Invoice ' + INV_CUR()!.id + '</title><style>body{margin:20px;background:#fff}@media print{body{margin:0}}</style></head><body>' +
    (document.querySelector('.modal')?.innerHTML ?? '') + '</body></html>';
  print() {
    const w = window.open('', '_blank');
    if (!w) { alert('The pop-up was blocked. Allow pop-ups for this page, or use Download.'); return; }
    w.document.write(this.doc()); w.document.close();
    w.focus(); setTimeout(() => w.print(), 300);
  }
  download() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([this.doc()], { type: 'text/html;charset=utf-8' }));
    a.download = 'Invoice_' + INV_CUR()!.id + '.html';
    document.body.appendChild(a); a.click(); a.remove();
  }
}

// ── Billing Run (renderDue 3552 / runBilling 3563) ──
@Component({
  selector: 'app-cb-run',
  imports: [FormsModule, InvModalComponent],
  template: `
  <app-inv-modal></app-inv-modal>
  <div class="card">
    <div class="card-title">Billing Run</div>
    <div class="fr3">
      <div class="fg"><label>Billing period</label>
        <select [(ngModel)]="perPick" (ngModelChange)="perPicked()">
          @if (!openPer().length) { <option value="">No open periods</option> }
          @if (perStat() && perStat() !== 'open') { <option [value]="perMonth()">{{perMonth()}} {{perStat() === 'closed' ? '(closed)' : '(not opened)'}}</option> }
          @for (p of openPer(); track p.id) { <option [value]="p.id">{{p.id}}</option> }
        </select></div>
      <div class="fg"><label>Invoice date *</label><input [(ngModel)]="date" type="date" (ngModelChange)="load()"></div>
      <div class="fg"><label>&nbsp;</label><button class="btn btn-p" (click)="run()" [disabled]="busy()"><i class="ti ti-receipt"></i> Create Invoices for Selected</button></div></div>
    <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
    @if (result()) {
      <div class="card" style="margin:10px 0;background:var(--ok-bg)">
        <strong>{{result()!.n}} invoice(s) created, total {{fmtR(result()!.tot)}}.</strong>
        @for (b of result()!.inv; track b.id) { <div style="font-size:12px">{{b.id}} — {{b.custName}} · {{fmtR(b.tot)}}</div> }</div>
    }
    <table><thead><tr><th style="width:30px"><input type="checkbox" [ngModel]="all" (ngModelChange)="setAll($event)" style="width:auto"></th>
      <th>Contract</th><th>Customer</th><th>Items / billing period</th><th class="tr">Excl VAT</th><th class="tr">VAT 15%</th><th class="tr">Total</th></tr></thead><tbody>
      @if (!perKnown()) { <tr><td colspan="7" style="color:var(--wn)">Period {{date.slice(0,7)}} has not been opened. Open it under Billing Periods before invoicing.</td></tr> }
      @if (perStat() === 'closed') { <tr><td colspan="7" style="color:var(--wn)">Period {{date.slice(0,7)}} is closed — choose a date in an open period.</td></tr> }
      @for (r of rows(); track r.con.code) {
        <tr>
          <td><input type="checkbox" [(ngModel)]="sel[r.con.code]" style="width:auto"></td>
          <td>{{r.con.code}}</td><td>{{r.con.custName}}</td>
          <td>@for (i of r.items; track $index) {<div style="font-size:12px"><span class="chip c-nt">{{i.line.type}}</span> {{i.line.descr}}@if (i.line.asset) { · {{i.line.asset}} } · {{fmtD(i.from, 1)}} – {{fmtD(i.to, 1)}} · {{fmtR(i.ex)}}</div>}
            @for (i of r.mitems; track $index) {<div style="font-size:12px"><span class="chip c-bl">Meter</span> {{i.meter.type}} · {{i.meter.asset}} · {{i.u.pages.toLocaleString('en-ZA')}} pages @ R {{i.u.rate.toFixed(4)}} ({{i.u.op.toLocaleString('en-ZA')}}→{{i.u.end.toLocaleString('en-ZA')}}) · {{fmtR(i.u.amt)}}</div>}</td>
          <td class="tr">{{fmtR(r.ex)}}</td><td class="tr">{{fmtR(r.vat)}}</td><td class="tr">{{fmtR(r.tot)}}</td></tr>
      } @empty { @if (perKnown() && perStat() !== 'closed') { <tr><td colspan="7" style="text-align:center;color:var(--txm)">No contracts are due for billing on this date.</td></tr> } }
    </tbody></table></div>`,
})
export class CbRunComponent {
  fmtR = fmtR; fmtD = fmtD;
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  pers = signal<Per[]>([]); rows = signal<DueRow[]>([]);
  date = ''; perPick = ''; err = signal(''); busy = signal(false);
  sel: Record<string, boolean> = {};
  all = true;
  result = signal<{ n: number; tot: number; inv: Inv[] } | null>(null);

  constructor() { void this.init(); }
  async init() {
    this.pers.set(await this.api.get<Per[]>('/billing/periods'));
    const open = this.pers().filter((p) => p.status === 'open').sort((a, b) => a.id.localeCompare(b.id));
    // clampTo 3553: today clamped to the first open period's month
    const t = todayIso();
    const clamp = (pid: string) => { const a = perFirst(pid), z = perLast(pid); return t < a ? a : t > z ? z : t; };
    this.date = open.length ? clamp(open[0].id) : t;
    await this.load();
  }
  openPer = () => this.pers().filter((p) => p.status === 'open').sort((a, b) => a.id.localeCompare(b.id));
  perMonth = () => this.date.slice(0, 7);
  perStat = () => this.pers().find((p) => p.id === this.date.slice(0, 7))?.status ?? (this.pers().length ? '' : '');
  perKnown = () => this.pers().length > 0;
  async perPicked() { // cbPerPick 5509: clamp today into the picked period
    if (this.perPick) {
      const t = todayIso(), a = perFirst(this.perPick), z = perLast(this.perPick);
      this.date = t < a ? a : t > z ? z : t;
      await this.load();
    }
    this.cdr.detectChanges();
  }
  async load() {
    this.rows.set(await this.api.get<DueRow[]>('/billing/due?date=' + this.date));
    this.sel = {}; this.rows().forEach((r) => (this.sel[r.con.code] = true));
    this.cdr.detectChanges();
  }
  setAll(v: boolean) { this.rows().forEach((r) => (this.sel[r.con.code] = v)); }
  async run() {
    this.err.set('');
    const sel = this.rows().filter((r) => this.sel[r.con.code]).map((r) => r.con.code);
    if (!sel.length) { this.err.set('Select at least one contract.'); return; }
    this.busy.set(true);
    try {
      const r = await this.api.post<{ made: Inv[]; n: number; tot: number }>('/billing/run', { date: this.date, contracts: sel });
      this.result.set({ n: r.n, tot: r.tot, inv: r.made });
      this.toast.show(r.n + ' invoice(s) created, total ' + fmtR(r.tot) + '.');
      await this.load();
    } catch (e) { this.err.set((e as ApiError).message); }
    finally { this.busy.set(false); this.cdr.detectChanges(); }
  }
}

// ── Meter Usage (renderMeters 3648 / saveReadings 3656) ──
@Component({
  selector: 'app-cb-meters',
  imports: [FormsModule],
  template: `
  <div class="notice"><i class="ti ti-info-circle"></i> <div>Meters are set up on the contract (Contract Management → Edit → Meters). Each period opens at the previous closed period's closing reading — or the start reading on the contract for the first period. Capture the closing reading, then bill it in the Billing Run. A period can only be closed once every meter has been read and billed.</div></div>
  <div class="card">
    <div class="card-title">Meter Usage <span class="chip" [class.c-ok]="open()" [class.c-nt]="!open()">{{per ? (open() ? 'Open' : 'Closed') : 'No period'}}</span></div>
    <div class="fr">
      <div class="fg"><label>Billing period</label><select [(ngModel)]="per" (ngModelChange)="load()">
        @for (p of pers(); track p.id) { <option [value]="p.id">{{p.id}} ({{p.status}})</option> }
      </select></div>
      <div class="fg" style="display:flex;align-items:flex-end"><button class="btn btn-p" (click)="save()" [hidden]="!open()"><i class="ti ti-device-floppy"></i> Save Readings</button></div></div>
    <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
    <table><thead><tr><th>Contract</th><th>Customer</th><th>Asset</th><th>Meter</th><th class="tr">Rate / page</th><th class="tr">Opening</th>
      <th class="tr" style="width:130px">Closing</th><th class="tr">Pages</th><th class="tr">Charge (excl VAT)</th><th>Status</th></tr></thead><tbody>
      @for (r of rows(); track r.id; let i = $index) {
        <tr><td>{{r.con}}</td><td>{{r.custName}}</td><td>{{r.asset}}</td><td>{{r.type}}</td>
          <td class="tr">R {{r.rateNow.toFixed(4)}}</td><td class="tr">{{r.opening.toLocaleString('en-ZA')}}</td>
          <td class="tr">@if (open() && !r.billed) { <input [(ngModel)]="ends[i]" type="number" [min]="r.opening" step="1" style="width:110px"> }
            @else { {{r.end == null ? '—' : r.end.toLocaleString('en-ZA')}} }</td>
          <td class="tr">{{r.end == null ? '—' : r.pages.toLocaleString('en-ZA')}}</td>
          <td class="tr">{{r.end == null ? '—' : fmtR(r.amt)}}</td>
          <td>@if (r.billed) { <span class="chip c-ok">Billed</span> } @else if (r.end != null) { <span class="chip c-bl">Captured</span> } @else { <span class="chip c-wn">Pending</span> }</td></tr>
      } @empty { <tr><td colspan="10" style="text-align:center;color:var(--txm)">No meters set up. Add them on a contract (Contract Management → Edit → Meters).</td></tr> }
    </tbody></table></div>`,
})
export class CbMetersComponent {
  fmtR = fmtR;
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  pers = signal<Per[]>([]); rows = signal<MeterRow[]>([]);
  per = ''; ends: (string | number | null)[] = [];
  err = signal('');
  open = () => this.pers().find((p) => p.id === this.per)?.status === 'open';

  constructor() { void this.init(); }
  async init() {
    this.pers.set(await this.api.get<Per[]>('/billing/periods'));
    this.per = this.pers().filter((p) => p.status === 'open').map((p) => p.id).sort()[0] || this.pers()[0]?.id || '';
    await this.load();
  }
  async load() {
    this.rows.set(await this.api.get<MeterRow[]>('/billing/meters?per=' + this.per));
    this.ends = this.rows().map((r) => (r.end == null ? null : r.end));
    this.cdr.detectChanges();
  }
  async save() {
    this.err.set('');
    const per = this.per;
    if (this.pers().find((p) => p.id === per)?.status !== 'open') { this.err.set('Period ' + per + ' is not open.'); return; }
    for (let i = 0; i < this.rows().length; i++) {
      const raw = this.ends[i] == null || this.ends[i] === '' ? null : Number(this.ends[i]);
      const r = this.rows()[i];
      if (raw == null) continue;
      if (!Number.isInteger(raw) || raw < 0) { this.err.set(r.con + '/M' + r.id + ': the closing reading must be a whole number.'); return; }
      if (raw < r.opening) { this.err.set(r.con + '/M' + r.id + ': closing reading ' + raw + ' is lower than the opening reading ' + r.opening + '.'); return; }
    }
    const readings = this.rows().map((r, i) => ({ contract: r.con, meter: r.id, end: this.ends[i] == null || this.ends[i] === '' ? null : Number(this.ends[i]) }));
    try { await this.api.post('/billing/readings', { per, readings }); this.toast.show('Readings saved.'); await this.load(); }
    catch (e) { this.err.set((e as ApiError).message); }
    finally { this.cdr.detectChanges(); }
  }
}

// ── Billing Periods (renderPeriods 3611 / addPeriod 3618 / close 3632 / reopen 3640) ──
@Component({
  selector: 'app-cb-periods',
  imports: [FormsModule],
  template: `
  <div class="notice"><i class="ti ti-info-circle"></i> <div>Contract invoices and meter readings can only be created in an <strong>open</strong> period. Periods are added one month after the last one. Close a period once everything is billed; only an administrator can reopen the latest closed period.</div></div>
  <div class="card">
    <div class="card-title">Billing Periods</div>
    <div class="fr">
      <div class="fg"><label>Add period (month)</label><input [(ngModel)]="newPer" type="month"></div>
      <div class="fg" style="display:flex;align-items:flex-end"><button class="btn btn-p" (click)="add()"><i class="ti ti-plus"></i> Open Period</button></div></div>
    <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
    <table><thead><tr><th>Period</th><th>Dates</th><th>Status</th><th class="tr">Invoices</th><th class="tr">Meters billed</th><th>Closed</th><th style="width:170px">Actions</th></tr></thead><tbody>
      @for (p of pers(); track p.id) {
        <tr><td><strong>{{p.id}}</strong></td><td>{{fmtD(perFirst(p.id), 1)}} – {{fmtD(perLast(p.id), 1)}}</td>
          <td><span class="chip" [class.c-ok]="p.status === 'open'" [class.c-nt]="p.status !== 'open'">{{p.status === 'open' ? 'Open' : 'Closed'}}</span></td>
          <td class="tr">{{p.inv ?? 0}}</td><td class="tr">{{p.mb ?? 0}}</td>
          <td>{{p.closedAt ? fmtD(p.closedAt, 1) + ' · ' + (p.closedBy || '') : '—'}}</td>
          <td>@if (p.status === 'open') { <button class="btn btn-s btn-sm" (click)="close(p)"><i class="ti ti-lock"></i> Close</button> }
            @else { <button class="btn btn-s btn-sm" (click)="reopen(p)"><i class="ti ti-lock-open"></i> Reopen</button> }</td></tr>
      } @empty { <tr><td colspan="7" style="text-align:center;color:var(--txm)">No periods yet. Open the first one above.</td></tr> }
    </tbody></table></div>`,
})
export class CbPeriodsComponent {
  fmtD = fmtD; perFirst = perFirst; perLast = perLast;
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  pers = signal<Per[]>([]);
  newPer = ''; err = signal('');

  constructor() { void this.reload(); }
  async reload() {
    this.pers.set(await this.api.get<Per[]>('/billing/periods'));
    if (!this.newPer) {
      const l = this.pers().map((p) => p.id).sort().pop();
      const d = l ? new Date(l + '-01') : new Date(todayIso());
      d.setMonth(d.getMonth() + 1);
      this.newPer = l ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : todayIso().slice(0, 7);
    }
    this.cdr.detectChanges();
  }
  async add() {
    this.err.set('');
    try { await this.api.post('/billing/periods', { id: this.newPer }); this.toast.show('Period ' + this.newPer + ' opened.'); this.newPer = ''; await this.reload(); }
    catch (e) { this.err.set((e as ApiError).message); }
  }
  async close(p: Per) {
    this.err.set('');
    if (!confirm('Close period ' + p.id + '? Meter closing readings become the opening readings for the next period, and invoices and readings in this period are locked.')) return;
    try { await this.api.post('/billing/periods/' + p.id + '/close'); this.toast.show('Period ' + p.id + ' closed.'); await this.reload(); }
    catch (e) { this.err.set((e as ApiError).message); alert((e as ApiError).message); }
  }
  async reopen(p: Per) {
    if (!confirm('Reopen period ' + p.id + '? Readings and invoices in it can then be added to again.')) return;
    try { await this.api.post('/billing/periods/' + p.id + '/reopen'); this.toast.show('Period ' + p.id + ' reopened.'); await this.reload(); }
    catch (e) { alert((e as ApiError).message); }
  }
}

// ── Escalation (renderEsc 5731 / applyEsc 5744) ──
interface ConForEsc { code: string; custName: string; status?: string; stat?: string; lines: { id: number; type: string; asset: string; descr: string; amt: number; lastBilled?: string; ever?: boolean; endRaw?: string; base?: number | null; eh?: { from: string; v: number }[] }[]; meters: { id: number; asset: string; type: string; rate: number; base?: number | null; eh?: { from: string; v: number }[] }[] }
interface EscRow { k: string; con: ConForEsc; kind: 'line' | 'meter'; id: number; it: any; cur: number; desc: string; asset: string; unit: string }

@Component({
  selector: 'app-cb-esc',
  imports: [FormsModule],
  template: `
  <div class="card">
    <div class="card-title">Rate Escalation</div>
    <div style="font-size:13px;color:var(--tx2);margin-bottom:12px">Choose the contract items and meters to escalate, set the increase and the date it takes effect. Billing from the effective date uses the new rate; periods already invoiced are not changed.</div>
    <div class="fr3">
      <div class="fg"><label>Increase type</label><select [(ngModel)]="mode" (ngModelChange)="render()"><option value="pct">Percentage (%)</option><option value="amt">Fixed amount</option></select></div>
      <div class="fg"><label>{{mode === 'pct' ? 'Increase (%) *' : 'Fixed increase (R) *'}}</label><input [(ngModel)]="val" type="number" step="0.01" min="0" (ngModelChange)="render()"></div>
      <div class="fg"><label>Effective from *</label><input [(ngModel)]="eff" type="date"></div></div>
    <div class="fr3">
      <div class="fg"><label>Customer</label><select [(ngModel)]="custF" (ngModelChange)="render()"><option value="">All customers</option>@for (c of custNames(); track c) { <option [value]="c">{{c}}</option> }</select></div>
      <div class="fg"><label>Show</label><select [(ngModel)]="kindF" (ngModelChange)="render()"><option value="">Contract items and meters</option><option value="line">Contract items only</option><option value="meter">Meter items only</option></select></div>
      <div class="fg"><label>Search</label><input [(ngModel)]="q" placeholder="Contract, asset or description" (ngModelChange)="render()"></div></div>
    <div style="font-size:12px;color:var(--txm);margin:4px 0 8px">{{mode === 'amt' ? 'A fixed increase adds the amount to each selected contract item (per month) and each selected meter (per page).' : ''}}</div>
    <table><thead><tr><th style="width:34px"><input type="checkbox" [ngModel]="all" (ngModelChange)="allTog($event)" style="width:auto"></th>
      <th>Contract</th><th>Customer</th><th>Item</th><th>Asset</th><th class="tr">Current rate</th><th class="tr">New rate</th><th>Last escalated</th></tr></thead><tbody>
      @for (x of items(); track x.k) {
        <tr><td><input type="checkbox" [(ngModel)]="sel[x.k]" style="width:auto"></td>
          <td>{{x.con.code}}</td><td>{{x.con.custName}}</td>
          <td>{{x.desc}}<div style="font-size:11px;color:var(--txm)">{{x.unit}}</div></td><td>{{x.asset || '—'}}</td>
          <td class="tr">{{fmtC(x.cur, x.kind)}}</td>
          <td class="tr">@if (escNew(x) == null) { <span style="color:var(--txm)">—</span> } @else { <strong>{{fmtC(escNew(x)!, x.kind)}}</strong> }</td>
          <td>{{last(x) ? fmtD(last(x)!, 1) : '—'}}</td></tr>
      } @empty { <tr><td colspan="8" style="text-align:center;color:var(--txm)">No active contract items or meters match.</td></tr> }
    </tbody></table>
    <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
    <div class="btn-grp" style="margin-top:12px">
      <button class="btn btn-p" (click)="apply()"><i class="ti ti-trending-up"></i> Apply Escalation to Selected</button>
      <span style="font-size:13px;color:var(--tx2);align-self:center">{{selN()}} item(s) selected</span></div></div>
  <div class="card">
    <div class="card-title">Escalation History</div>
    <table><thead><tr><th>Ref</th><th>Applied</th><th>Effective from</th><th>Increase</th><th>Items</th><th>By</th></tr></thead><tbody>
      @for (h of hist(); track h.code) {
        <tr><td>{{h.code}}</td><td>{{fmtD(h.applied, 1)}}</td><td>{{fmtD(h.effective, 1)}}</td><td>{{h.mode === 'pct' ? h.val + '%' : 'R ' + h.val}}</td>
          <td>{{h.items.length}} <span style="font-size:11px;color:var(--txm)">{{escH3(h)}}</span></td>
          <td>{{h.applied_by || '—'}}</td></tr>
      } @empty { <tr><td colspan="6" style="text-align:center;color:var(--txm)">No escalations applied yet.</td></tr> }
    </tbody></table></div>`,
})
export class CbEscComponent {
  fmtD = fmtD; fmtR = fmtR;
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  cons = signal<ConForEsc[]>([]);
  hist = signal<{ code: string; applied: string; effective: string; mode: string; val: number; applied_by: string; items: { con: string; desc: string }[] }[]>([]);
  mode = 'pct'; val: number | null = null; eff = todayIso(); custF = ''; kindF = ''; q = '';
  sel: Record<string, boolean> = {}; all = false; err = signal('');

  constructor() { void this.init(); }
  async init() {
    const [c, h] = await Promise.all([this.api.get<ConForEsc[]>('/contracts'), this.api.get<any[]>('/escalations')]);
    this.cons.set(c); this.hist.set(h as any); this.render(); this.cdr.detectChanges();
  }
  custNames = () => [...new Set(this.cons().map((c) => c.custName))];
  escH3 = (h: { items: { con: string; desc: string }[] }) => h.items.slice(0, 3).map((i) => i.con + ' ' + i.desc).join('; ') + (h.items.length > 3 ? '…' : '');
  items = signal<EscRow[]>([]);
  selN = () => this.items().filter((x) => this.sel[x.k]).length;
  build() {
    // escItems 5721 — active contracts only
    const t = todayIso(), q = this.q.toLowerCase(), out: EscRow[] = [];
    this.cons().filter((c) => c.stat === 'Active' && (!this.custF || c.custName === this.custF)).forEach((c) => {
      c.lines.filter((l) => !l.lastBilled || !l.endRaw || l.endRaw >= t).forEach((l) => out.push({ k: c.code + '|L|' + l.id, con: c, kind: 'line', id: l.id, it: l, cur: l.amt, desc: l.type + ' — ' + (l.descr || ''), asset: l.asset || '', unit: 'per month' }));
      c.meters.forEach((m) => out.push({ k: c.code + '|M|' + m.id, con: c, kind: 'meter', id: m.id, it: m, cur: m.rate, desc: 'Meter: ' + m.type, asset: m.asset || '', unit: 'per page' }));
    });
    return out.filter((x) => !q || (x.con.code + ' ' + x.con.custName + ' ' + x.desc + ' ' + x.asset).toLowerCase().includes(q));
  }
  render() {
    const items = this.build(), live = new Set(items.map((x) => x.k));
    this.items.set(items);
    for (const k of Object.keys(this.sel)) if (!live.has(k)) delete this.sel[k];
    this.all = items.length > 0 && items.every((x) => this.sel[x.k]);
    this.cdr.detectChanges();
  }
  allTog(on: boolean) { this.items().forEach((x) => (this.sel[x.k] = on)); this.cdr.detectChanges(); }
  fmtC = (v: number, kind: string) => (kind === 'meter' ? 'R ' + v.toFixed(4) : fmtR(v));
  escNew(x: EscRow): number | null {
    const v = Number(this.val);
    if (!(v > 0)) return null;
    const n = this.mode === 'pct' ? x.cur * (1 + v / 100) : x.cur + v;
    return x.kind === 'meter' ? Math.round(n * 10000) / 10000 : Math.round(n * 100) / 100;
  }
  last = (x: EscRow) => ((x.it.eh || []) as { from: string }[]).slice().sort((a, b) => (a.from < b.from ? -1 : 1)).pop()?.from || null;
  async apply() {
    const eff = this.eff, v = Number(this.val), mode = this.mode;
    if (!(v > 0)) { this.err.set('Enter the increase — it must be greater than zero.'); return; }
    if (mode === 'pct' && v > 100) { this.err.set('A percentage increase cannot exceed 100%.'); return; }
    if (!eff) { this.err.set('Enter the date the escalation takes effect.'); return; }
    const sel = this.items().filter((x) => this.sel[x.k]);
    if (!sel.length) { this.err.set('Select at least one contract item or meter to escalate.'); return; }
    for (const x of sel) {
      const ld = (x.it.eh || []).map((e: any) => e.from).sort().pop();
      if (ld && eff <= ld) { this.err.set(x.con.code + ' · ' + x.desc + ' was already escalated from ' + fmtD(ld, 1) + '. Choose a later effective date.'); return; }
    }
    if (!confirm('Escalate ' + sel.length + ' item(s) by ' + (mode === 'pct' ? v + '%' : 'R ' + v) + ' effective ' + fmtD(eff, 1) + '?\nInvoices already created are not changed.')) return;
    try {
      const r = await this.api.post<{ code: string }>('/escalations', {
        mode, val: v, eff, items: sel.map((x) => ({ con: x.con.code, kind: x.kind, id: x.id })),
      });
      this.sel = {}; this.val = null; this.err.set('');
      this.toast.show('Escalation ' + r.code + ' applied to ' + sel.length + ' item(s).');
      await this.init();
    } catch (e) { this.err.set((e as ApiError).message); this.cdr.detectChanges(); }
  }
}

// ── Billing History (renderHist 3588) ──
@Component({
  selector: 'app-cb-hist',
  imports: [InvModalComponent],
  template: `
  <app-inv-modal></app-inv-modal>
  <div class="card">
    <div class="card-title">Billing History</div>
    <table><thead><tr><th>Invoice</th><th>Type</th><th>Date</th><th>Contract</th><th>Customer</th><th>Items</th><th class="tr">Excl VAT</th><th class="tr">VAT</th><th class="tr">Total</th><th></th></tr></thead><tbody>
      @for (b of invs(); track b.id) {
        <tr><td>{{b.id}}</td><td><span class="chip c-bl">Contract Invoice</span></td><td>{{fmtD(b.date, 1)}}</td><td>{{b.con}}</td><td>{{b.custName}}</td>
          <td>@for (l of b.lines; track $index) {<div style="font-size:12px">{{l.type}} {{l.descr}}@if (l.asset) { · {{l.asset}} } · {{fmtD(l.from, 1)}} – {{fmtD(l.to, 1)}}</div>} @if (!b.lines.length) { — }</td>
          <td class="tr">{{fmtR(b.ex)}}</td><td class="tr">{{fmtR(b.vat)}}</td><td class="tr">{{fmtR(b.tot)}}</td>
          <td><button class="btn btn-s btn-sm" (click)="view(b)">View</button></td></tr>
      } @empty { <tr><td colspan="10" style="text-align:center;color:var(--txm)">No contract invoices yet.</td></tr> }
    </tbody></table></div>`,
})
export class CbHistComponent {
  fmtR = fmtR; fmtD = fmtD;
  private api = inject(ApiService);
  private modal = viewChild.required(InvModalComponent);
  invs = signal<Inv[]>([]);
  constructor() { void this.reload(); }
  async reload() { this.invs.set(await this.api.get<Inv[]>('/billing/invoices')); }
  view(b: Inv) { void this.modal().open(b); }
}

// ── Customers ▸ Contract Invoices tab (renderContractInvoices 3699) ──
@Component({
  selector: 'app-cust-cinv',
  imports: [FormsModule, InvModalComponent],
  template: `
  <app-inv-modal></app-inv-modal>
  <div class="notice"><i class="ti ti-info-circle"></i> <div><strong>Contract Invoices</strong> are raised only by the Contract Billing run (rentals and services billed on a contract, numbered CINV-). They post to the customer's account and appear on statements as "Contract Invoice". One-off sales are <strong>Sales Invoices</strong> (SI-).</div></div>
  <div class="card">
    <div class="card-title">Contract Invoices</div>
    <div class="fr" style="margin-bottom:8px">
      <div class="fg"><label>Customer</label><select [(ngModel)]="custF" (ngModelChange)="load()"><option value="">All customers</option>@for (c of custs(); track c.code) { <option [value]="c.code">{{c.name}}</option> }</select></div></div>
    <table><thead><tr><th>Invoice</th><th>Type</th><th>Customer</th><th>Contract</th><th>Date</th><th>Items</th><th class="tr">Excl VAT</th><th class="tr">VAT</th><th class="tr">Total</th><th></th></tr></thead><tbody>
      @for (b of invs(); track b.id) {
        <tr><td>{{b.id}}</td><td><span class="chip c-bl">Contract Invoice</span></td><td>{{b.custName}}</td><td>{{b.con}}</td><td>{{fmtD(b.date, 1)}}</td>
          <td>@for (l of b.lines; track $index) {<div style="font-size:12px">{{l.type}} {{l.descr}}@if (l.asset) { · {{l.asset}} } · {{fmtD(l.from, 1)}} – {{fmtD(l.to, 1)}}</div>} @if (!b.lines.length) { — }</td>
          <td class="tr">{{fmtR(b.ex)}}</td><td class="tr">{{fmtR(b.vat)}}</td><td class="tr">{{fmtR(b.tot)}}</td>
          <td><button class="btn btn-s btn-sm" (click)="view(b)">View</button></td></tr>
      } @empty { <tr><td colspan="10" style="text-align:center;color:var(--txm)">No contract invoices yet. They are created in Contract Billing.</td></tr> }
    </tbody></table></div>`,
})
export class CustCinvComponent {
  fmtR = fmtR; fmtD = fmtD;
  private api = inject(ApiService);
  private cdr = inject(ChangeDetectorRef);
  private modal = viewChild.required(InvModalComponent);
  custs = signal<{ code: string; name: string }[]>([]);
  invs = signal<Inv[]>([]);
  custF = '';
  constructor() { void this.init(); }
  async init() {
    const [cu, iv] = await Promise.all([
      this.api.get<{ code: string; name: string }[]>('/customers'),
      this.api.get<Inv[]>('/billing/invoices'),
    ]);
    this.custs.set(cu); this.invs.set(iv); this.cdr.detectChanges();
  }
  async load() { this.invs.set(await this.api.get<Inv[]>('/billing/invoices?cust=' + this.custF)); this.cdr.detectChanges(); }
  view(b: Inv) { void this.modal().open(b); }
}
