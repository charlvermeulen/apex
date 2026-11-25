import { Component, ChangeDetectorRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink, RouterOutlet } from '@angular/router';
import { ApiService, ApiError, ToastService } from '../../core/api';
import { AuthStore } from '../../core/auth.store';
import { fmtR, fmtD, dayMon, todayIso } from '../../core/fmt';

const DN_NOTICE = 'A debit note is issued to a supplier to reduce the amount owed — typically for returned goods or overcharges. It reduces your accounts payable and adjusts input VAT.';

// Procurement parent: flat tab bar (legacy has no sec-bar here)
@Component({
  selector: 'app-procurement', imports: [RouterOutlet, RouterLink],
  template: `
  <div class="page-title">Procurement</div>
  <div class="page-sub">Raise purchase orders to suppliers, approve them and record delivery</div>
  <div class="stab-bar">
    <a class="stab" routerLink="/procurement/po" routerLinkActive="active"><i class="ti ti-shopping-cart"></i> Purchase Orders</a>
    <a class="stab" routerLink="/procurement/grn" routerLinkActive="active"><i class="ti ti-package"></i> Goods Received</a>
    <a class="stab" routerLink="/procurement/pi" routerLinkActive="active"><i class="ti ti-file-invoice"></i> Supplier Invoices</a>
    <a class="stab" routerLink="/procurement/dn" routerLinkActive="active"><i class="ti ti-file-minus"></i> Debit Notes</a>
  </div>
  <router-outlet />`,
})
export class ProcurementComponent { }

// ── Supplier Invoices: list + Capture Invoice (saveSinv port) ──
@Component({
  selector: 'app-pi', imports: [FormsModule],
  template: `
  <div class="card">
    <div class="notice"><i class="ti ti-info-circle"></i> <strong>s16(3)</strong> Input VAT is claimable per s16(3) of the VAT Act. The supplier must be VAT-registered and you must hold a valid tax invoice.</div>
    <div class="tab-bar" style="margin:0 0 12px">
      <button class="tab" [class.active]="!newing()" (click)="showList()">Invoice List</button>
      <button class="tab" [class.active]="newing()" (click)="newPi()">Capture Invoice</button>
    </div>
    @if (!newing()) {
      <table><thead><tr><th>Ref #</th><th>Supplier</th><th>Supplier Inv #</th><th>Date</th><th class="tr">Excl. VAT</th><th class="tr">Input VAT</th><th class="tr">Total</th><th>Status</th></tr></thead>
      <tbody>
        @for (p of list(); track p.id) {
          <tr><td>{{p.id}}@if (p.grn) {<div style="font-size:11px;color:var(--txm)">{{p.grn}} · {{p.po}}</div>}</td><td>{{p.supName}}</td><td>{{p.theirNo}}</td><td>{{dayMon(p.date)}}</td>
            <td class="tr">{{fmtR(p.ex)}}</td><td class="tr">{{fmtR(p.vat)}}</td><td class="tr">{{fmtR(p.tot)}}</td>
            <td><span class="chip c-bl">Sent</span></td></tr>
        } @empty { <tr><td colspan="8" style="text-align:center;color:var(--txm)">No supplier invoices yet.</td></tr> }
      </tbody></table>
    } @else {
      <div class="fr">
        <div class="fg"><label>Supplier *</label><select [(ngModel)]="f.supplier" (ngModelChange)="pickSup($event)">
          <option value="">— Select —</option>
          @for (s of sups(); track s.code) { <option [value]="s.code">{{s.name}}</option> }</select></div>
        <div class="fg"><label>Supplier Invoice Number *</label><input [(ngModel)]="f.theirNo" maxlength="40" placeholder="As printed on invoice"></div></div>
      <div class="fr">
        <div class="fg"><label>Goods received note</label><select [(ngModel)]="f.grn" (ngModelChange)="pickGrn()">
          <option value="">— None —</option>
          @for (g of openGrns(); track g.id) { <option [value]="g.id">{{g.id}} · {{g.po}} · {{dayMon(g.date)}} · {{fmtR(grnVal(g))}} excl VAT</option> }</select></div>
        <div class="fg"><label>&nbsp;</label>@if (f.grn) { <div class="stat-sub" style="margin-top:6px">Amount filled from {{f.grn}}. If the supplier’s invoice differs, change the amount — the difference will be shown.</div> }</div></div>
      <div class="fr">
        <div class="fg"><label>Invoice Date *</label><input type="date" [(ngModel)]="f.date"></div>
        <div class="fg"><label>Due Date</label><input type="date" [(ngModel)]="f.due"></div>
        <div class="fg"><label>Our Ref #</label><input value="Auto (PI-…)" disabled></div></div>
      <table style="margin-top:10px"><thead><tr><th>Description</th><th>Expense Account</th><th class="tr">Excl. VAT</th><th>VAT Type</th><th class="tr">VAT</th><th class="tr">Total</th></tr></thead>
      <tbody><tr>
        <td><input [(ngModel)]="f.desc" maxlength="120"></td>
        <td><select style="min-width:220px" [(ngModel)]="f.acc">
          <option value="">— Select —</option>
          @for (a of expAccs(); track a.code) { <option [value]="a.code">{{a.code}} — {{a.name}}</option> }</select></td>
        <td><input type="number" style="width:130px" min="0" step="0.01" [(ngModel)]="f.amount" (ngModelChange)="cd()"></td>
        <td><select [(ngModel)]="f.vat" (ngModelChange)="cd()">
          <option>Standard 15%</option><option>Zero-Rated</option><option>Exempt</option></select></td>
        <td class="tr">{{fmtR(vatAmt())}}</td><td class="tr">{{fmtR(ex() + vatAmt())}}</td></tr></tbody></table>
      <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
      <div class="btn-grp"><button class="btn btn-p" (click)="save()" [disabled]="busy()"><i class="ti ti-device-floppy"></i> Save Invoice</button>
        <button class="btn btn-s" (click)="showList()">Cancel</button></div>
    }
  </div>`,
})
export class PiComponent {
  fmtR = fmtR; dayMon = dayMon;
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  list = signal<{ id: string; supName: string; theirNo: string; date: string; ex: number; vat: number; tot: number; po?: string; grn?: string }[]>([]);
  sups = signal<{ code: string; name: string; defaultExp: string | null }[]>([]);
  accs = signal<{ code: string; name: string; type: string }[]>([]);
  grns = signal<{ id: string; po: string; sup: string; date: string; inv: string; lines: { qty: number; price: number; vat: number }[] }[]>([]);
  newing = signal(false); busy = signal(false); err = signal('');
  f = { supplier: '', theirNo: '', date: todayIso(), due: '', desc: '', acc: '', amount: 0, vat: 'Standard 15%', grn: '' };

  constructor() { void this.reload(); }
  async reload() {
    const [l, s, a, g] = await Promise.all([
      this.api.get<{ id: string; supName: string; theirNo: string; date: string; ex: number; vat: number; tot: number; po?: string; grn?: string }[]>('/supplier-invoices'),
      this.api.get<{ code: string; name: string; defaultExp: string | null }[]>('/suppliers'),
      this.api.get<{ code: string; name: string; type: string }[]>('/gl/accounts'),
      this.api.get<{ id: string; po: string; sup: string; date: string; inv: string; lines: { qty: number; price: number; vat: number }[] }[]>('/grns'),
    ]);
    this.list.set(l); this.sups.set(s); this.accs.set(a); this.grns.set(g); this.cdr.detectChanges();
  }
  // siSupChanged/siGrnChanged (5117–5128): uninvoiced GRNs for the supplier; picked → prefill
  openGrns = () => this.grns().filter((g) => !g.inv && (!this.f.supplier || g.sup === this.f.supplier));
  grnVal = (g: { lines: { qty: number; price: number; vat: number }[] }) =>
    Math.round(g.lines.reduce((t, l) => t + l.qty * l.price, 0) * 100) / 100;
  pickGrn() {
    const g = this.grns().find((x) => x.id === this.f.grn);
    if (!g) return;
    this.f.desc = 'Goods per ' + g.id + ' (order ' + g.po + ')';
    this.f.amount = this.grnVal(g);
    const vats = [...new Set(g.lines.map((l) => l.vat))];
    this.f.vat = vats.length === 1 && vats[0] === 0 ? 'Zero-Rated' : 'Standard 15%';
    this.cd();
  }
  expAccs = () => this.accs().filter((a) => a.type === 'Expense' || a.type === 'Cost of Sales');
  ex = () => Math.round(Number(this.f.amount) * 100) / 100;
  vatAmt = () => this.f.vat === 'Standard 15%' ? Math.round(this.ex() * 15) / 100 : 0;
  cd() { this.cdr.detectChanges(); }
  showList() { this.newing.set(false); this.cdr.detectChanges(); }
  newPi() { this.f = { supplier: '', theirNo: '', date: todayIso(), due: '', desc: '', acc: '', amount: 0, vat: 'Standard 15%', grn: '' }; this.newing.set(true); this.cdr.detectChanges(); }
  pickSup(code: string) { this.f.acc = this.sups().find((s) => s.code === code)?.defaultExp || ''; this.f.grn = ''; this.cd(); }
  async save() {
    this.err.set(''); this.busy.set(true);
    const v = this.f.vat === 'Standard 15%' ? '15' : '0';
    try {
      const r = await this.api.post<{ id: string }>('/supplier-invoices', { supplier: this.f.supplier, theirNo: this.f.theirNo, date: this.f.date, due: this.f.due, desc: this.f.desc, acc: this.f.acc, amount: Number(this.f.amount), vat: v, grn: this.f.grn });
      this.toast.show('Supplier invoice ' + r.id + ' saved.');
      this.newing.set(false); await this.reload();
    } catch (e) { this.err.set((e as ApiError).message); }
    finally { this.busy.set(false); this.cdr.detectChanges(); }
  }
}

// ── Debit Notes: list + New Debit Note ──
@Component({
  selector: 'app-dn', imports: [FormsModule],
  template: `
  <div class="notice" style="margin-bottom:12px"><i class="ti ti-info-circle"></i> {{DN_NOTICE}}</div>
  <div class="card">
    <div class="tab-bar" style="margin:0 0 12px">
      <button class="tab" [class.active]="!newing()" (click)="showList()">Debit Note List</button>
      <button class="tab" [class.active]="newing()" (click)="newDn()">New Debit Note</button>
    </div>
    @if (!newing()) {
      <table><thead><tr><th>DN #</th><th>Supplier</th><th>Orig. Invoice</th><th>Date</th><th class="tr">Excl. VAT</th><th class="tr">VAT Adj.</th><th class="tr">Total</th><th>Reason</th></tr></thead>
      <tbody>
        @for (d of list(); track d.id) {
          <tr><td>{{d.id}}</td><td>{{d.supName}}</td><td>{{d.orig}}</td><td>{{dayMon(d.date)}}</td>
            <td class="tr">{{fmtR(d.excl)}}</td><td class="tr">{{fmtR(d.vatAmt)}}</td><td class="tr">{{fmtR(d.tot)}}</td><td>{{d.reason}}</td></tr>
        } @empty { <tr><td colspan="8" style="text-align:center;color:var(--txm)">No debit notes yet.</td></tr> }
      </tbody></table>
    } @else {
      <div class="fr">
        <div class="fg"><label>Supplier *</label><select [(ngModel)]="f.supplier">
          <option value="">— Select —</option>
          @for (s of sups(); track s.code) { <option [value]="s.code">{{s.name}}</option> }</select></div>
        <div class="fg"><label>Original Invoice # *</label><input [(ngModel)]="f.orig" maxlength="40" placeholder="e.g. PI-2025-022"></div></div>
      <div class="fr">
        <div class="fg"><label>Debit Note Date *</label><input type="date" [(ngModel)]="f.date"></div>
        <div class="fg"><label>DN Reference #</label><input value="Auto (DN-…)" disabled></div></div>
      <div class="fr">
        <div class="fg"><label>Reason</label><select [(ngModel)]="f.reason">
          <option>Returned Goods</option><option>Overcharge</option><option>Short Delivery</option><option>Quality Issue</option><option>Other</option></select></div></div>
      <table style="margin-top:10px"><thead><tr><th>Description</th><th class="tr">Excl. VAT</th><th>VAT</th><th class="tr">Total</th></tr></thead>
      <tbody><tr>
        <td><input [(ngModel)]="f.desc" maxlength="120"></td>
        <td><input type="number" style="width:130px" min="0" step="0.01" [(ngModel)]="f.amount" (ngModelChange)="cd()"></td>
        <td><select [(ngModel)]="f.vat" (ngModelChange)="cd()"><option>Standard 15%</option><option>Zero-Rated 0%</option><option>Exempt</option></select></td>
        <td class="tr">{{fmtR(ex() + vatAmt())}}</td></tr></tbody></table>
      <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
      <div class="btn-grp"><button class="btn btn-p" (click)="save()" [disabled]="busy()"><i class="ti ti-device-floppy"></i> Issue Debit Note</button></div>
    }
  </div>`,
})
export class DnComponent {
  fmtR = fmtR; dayMon = dayMon; DN_NOTICE = DN_NOTICE;
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  list = signal<{ id: string; supName: string; orig: string; date: string; excl: number; vatAmt: number; tot: number; reason: string }[]>([]);
  sups = signal<{ code: string; name: string }[]>([]);
  newing = signal(false); busy = signal(false); err = signal('');
  f = { supplier: '', orig: '', date: todayIso(), reason: 'Returned Goods', desc: '', amount: 0, vat: 'Standard 15%' };

  constructor() { void this.reload(); }
  async reload() {
    const [l, s] = await Promise.all([this.api.get<{ id: string; supName: string; orig: string; date: string; excl: number; vatAmt: number; tot: number; reason: string }[]>('/debit-notes'), this.api.get<{ code: string; name: string }[]>('/suppliers')]);
    this.list.set(l); this.sups.set(s); this.cdr.detectChanges();
  }
  ex = () => Math.round(Number(this.f.amount) * 100) / 100;
  vatAmt = () => this.f.vat === 'Standard 15%' ? Math.round(this.ex() * 15) / 100 : 0;
  cd() { this.cdr.detectChanges(); }
  showList() { this.newing.set(false); this.cdr.detectChanges(); }
  newDn() { this.f = { supplier: '', orig: '', date: todayIso(), reason: 'Returned Goods', desc: '', amount: 0, vat: 'Standard 15%' }; this.newing.set(true); this.cdr.detectChanges(); }
  async save() {
    this.err.set(''); this.busy.set(true);
    try {
      const r = await this.api.post<{ id: string }>('/debit-notes', { supplier: this.f.supplier, orig: this.f.orig, date: this.f.date, reason: this.f.reason, desc: this.f.desc, amount: Number(this.f.amount), vat: this.f.vat });
      this.toast.show('Debit note ' + r.id + ' issued.');
      this.newing.set(false); await this.reload();
    } catch (e) { this.err.set((e as ApiError).message); }
    finally { this.busy.set(false); this.cdr.detectChanges(); }
  }
}

// ── Purchase Orders (openPO/savePO/poStatus/renderPO 4996–5065) ──
interface PoLine { seq: number; stock: string; desc: string; qty: number; price: number; vat: number }
interface Po {
  id: string; sup: string; supName: string; date: string; due: string; ref: string; deliver: string; notes: string;
  by: string; byName: string; status: string; approved: string | null; received: string | null;
  lines: PoLine[]; recv: number[]; tot: { ex: number; vat: number; inc: number };
}
type FormLine = { stock: string; desc: string; qty: number; price: number; vat: string; free: boolean };
const PO_CHIP: Record<string, string> = { Draft: 'c-gr', Approved: 'c-bl', Sent: 'c-wn', 'Part received': 'c-wn', Received: 'c-ok', Cancelled: 'c-dn' };
const poOpen = (s: string) => ['Draft', 'Approved', 'Sent', 'Part received'].includes(s);

@Component({
  selector: 'app-po', imports: [FormsModule],
  template: `
  <div class="g4">
    <div class="card"><div class="stat-lbl">Drafts</div><div class="stat-val">{{stats().drafts}}</div><div class="stat-sub">Awaiting approval</div></div>
    <div class="card"><div class="stat-lbl">On order</div><div class="stat-val">{{stats().onOrder}}</div><div class="stat-sub">{{fmtR(stats().onOrderSum)}}</div></div>
    <div class="card"><div class="stat-lbl">Received</div><div class="stat-val">{{stats().received}}</div><div class="stat-sub">{{fmtR(stats().receivedSum)}}</div></div>
    <div class="card"><div class="stat-lbl">Overdue</div><div class="stat-val">{{stats().overdue}}</div><div class="stat-sub">Past delivery date</div></div>
  </div>
  <div class="card"><div class="card-title">Purchase Orders
    <button class="btn btn-p btn-sm" (click)="openPO()"><i class="ti ti-plus"></i> New Purchase Order</button></div>
    <div class="fr" style="margin-bottom:8px">
      <div class="fg"><label>Search</label><input [(ngModel)]="q" (ngModelChange)="render()" placeholder="PO no., supplier, reference"></div>
      <div class="fg"><label>Status</label><select [(ngModel)]="f" (ngModelChange)="render()">
        <option value="">All</option><option value="open">Open</option><option>Approved</option><option>Sent</option>
        <option value="Part received">Part received</option><option>Received</option><option>Cancelled</option></select></div></div>
    <table><thead><tr><th>PO</th><th>Supplier</th><th>Date</th><th>Delivery due</th><th class="tr">Total (incl VAT)</th><th>Status</th><th style="width:280px"></th></tr></thead><tbody>
      @for (o of rows(); track o.id) {
        <tr><td><strong>{{o.id}}</strong>@if (o.ref) {<div style="font-size:11px;color:var(--txm)">{{o.ref}}</div>}</td>
          <td>{{o.supName}}</td><td>{{dayMon(o.date)}}</td>
          <td [style.color]="isLate(o) ? 'var(--dn)' : ''">{{dayMon(o.due)}}@if (isLate(o)) { (overdue) }</td>
          <td class="tr">{{fmtR(o.tot.inc)}}</td>
          <td><span class="chip {{PO_CHIP[o.status]}}">{{o.status}}</span></td>
          <td style="white-space:nowrap">
            @if (o.status === 'Draft') {
              <button class="btn btn-s btn-sm" (click)="openPO(o)">Edit</button>
              @if (approver()) { <button class="btn btn-p btn-sm" (click)="setStatus(o, 'Approved')">Approve</button> }
              <button class="btn btn-s btn-sm" title="Delete draft" (click)="del(o)">✕</button>
            }
            @if (o.status === 'Approved') {
              <button class="btn btn-s btn-sm" (click)="setStatus(o, 'Sent')">Mark sent</button>
              <button class="btn btn-p btn-sm" (click)="receive(o)">Receive goods</button>
              <button class="btn btn-s btn-sm" (click)="setStatus(o, 'Cancelled')">Cancel</button>
            }
            @if (o.status === 'Sent') {
              <button class="btn btn-p btn-sm" (click)="receive(o)">Receive goods</button>
              <button class="btn btn-s btn-sm" (click)="setStatus(o, 'Cancelled')">Cancel</button>
            }
            @if (o.status === 'Part received') { <button class="btn btn-p btn-sm" (click)="receive(o)">Receive goods</button> }
          </td></tr>
      } @empty {
        <tr><td colspan="7" style="color:var(--txm)">No purchase orders yet. Click “New Purchase Order” to raise one.</td></tr>
      }
    </tbody></table></div>
  @if (isOpen()) {
    <div class="modal-bg" style="display:block" (click)="close($event)">
      <div class="modal" style="max-width:860px" (click)="$event.stopPropagation()">
        <div class="rm-hd"><strong>{{edit ? 'Edit ' + edit : 'New Purchase Order'}}</strong><button class="btn btn-s btn-sm" (click)="close()">✕</button></div>
        <div class="fr3">
          <div class="fg"><label>Supplier *</label><select [(ngModel)]="m.sup" (ngModelChange)="cd()">
            <option value="">— Select supplier —</option>
            @for (s of sups(); track s.code) { <option [value]="s.code">{{s.name}}</option> }</select></div>
          <div class="fg"><label>Order date *</label><input type="date" [(ngModel)]="m.date"></div>
          <div class="fg"><label>Delivery required by *</label><input type="date" [(ngModel)]="m.due"></div></div>
        <div class="fr3">
          <div class="fg"><label>Our reference / requisition</label><input [(ngModel)]="m.ref" maxlength="40"></div>
          <div class="fg"><label>Requestor (ordered by)</label><select [(ngModel)]="m.by">
            <option value="">— None —</option>
            @for (e of staff(); track e.code) { <option [value]="e.code">{{e.name}}</option> }</select></div>
          <div class="fg"><label>Deliver to</label><input [(ngModel)]="m.deliver" maxlength="120"></div></div>
        <div class="card-title" style="margin-top:4px">Order lines <button class="btn btn-s btn-sm" type="button" (click)="addLine()"><i class="ti ti-plus"></i> Add line</button></div>
        <table><thead><tr><th>Item (pick from inventory)</th><th style="width:80px">Qty</th><th style="width:120px">Unit price (excl)</th><th style="width:90px">VAT</th><th class="tr" style="width:120px">Line total</th><th style="width:30px"></th></tr></thead><tbody>
          @for (l of m.lines(); track $index) {
            <tr><td><select style="min-width:220px" [ngModel]="l.stock" (ngModelChange)="pickStock($index, $event)">
                <option value="">— Other / non-stock item —</option>
                @for (i of items(); track i.sku) { <option [value]="i.sku">{{i.sku}} — {{i.name}}</option> }</select>
              @if (l.free) { <input [(ngModel)]="l.desc" (ngModelChange)="cd()" maxlength="120" placeholder="Description"> }</td>
              <td><input type="number" min="0" step="any" style="width:70px" [(ngModel)]="l.qty" (ngModelChange)="cd()"></td>
              <td><input type="number" min="0" step="0.01" style="width:110px" [(ngModel)]="l.price" (ngModelChange)="cd()" [disabled]="!l.free"></td>
              <td><select [(ngModel)]="l.vat" (ngModelChange)="cd()"><option value="15">15%</option><option value="0">0%</option></select></td>
              <td class="tr">{{fmtR(lineTot(l))}}</td>
              <td><button class="btn btn-s btn-sm" type="button" (click)="rmLine($index)"><i class="ti ti-x"></i></button></td></tr>
          }</tbody></table>
        <div style="text-align:right;margin:8px 0;font-size:13px">Subtotal {{fmtR(mTot().ex)}} &nbsp;·&nbsp; VAT {{fmtR(mTot().vat)}} &nbsp;·&nbsp; <strong>Total {{fmtR(mTot().inc)}}</strong></div>
        <div class="fg"><label>Notes / terms</label><textarea [(ngModel)]="m.notes" rows="2" maxlength="400"></textarea></div>
        <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
        <div class="btn-grp"><button class="btn btn-p" (click)="save()"><i class="ti ti-device-floppy"></i> Save Purchase Order</button>
          <button class="btn btn-s" (click)="close()">Cancel</button></div>
      </div></div>
  }`,
})
export class PoComponent {
  fmtR = fmtR; dayMon = dayMon; fmtD = fmtD; PO_CHIP = PO_CHIP;
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  private router = inject(Router);
  private auth = inject(AuthStore);
  all = signal<Po[]>([]); sups = signal<{ code: string; name: string }[]>([]);
  staff = signal<{ code: string; name: string }[]>([]);
  items = signal<{ sku: string; name: string; cost: number }[]>([]);
  q = ''; f = '';
  rows = signal<Po[]>([]);
  isOpen = signal(false); err = signal('');
  edit = '';
  m = { sup: '', date: todayIso(), due: '', ref: '', by: '', deliver: '', notes: '', lines: signal<FormLine[]>([]) };

  constructor() { void this.reload(); }
  approver = () => ['admin', 'accountant'].includes(this.auth.user()?.role ?? '');
  isLate = (o: Po) => ['Approved', 'Sent', 'Part received'].includes(o.status) && !!o.due && o.due < todayIso();
  async reload() {
    const [pos]: any[] = await Promise.all([
      this.api.get<Po[]>('/purchase-orders'),
    ]);
    this.all.set(pos);
    this.sups.set((await this.api.get<{ code: string; name: string }[]>('/suppliers')));
    this.staff.set(await this.api.get<{ code: string; name: string }[]>('/po-staff').catch(() => []));
    this.items.set(await this.api.get<{ sku: string; name: string; cost: number }[]>('/inv/items').catch(() => []));
    this.render(); this.cdr.detectChanges();
  }
  stats = () => {
    const P = this.all();
    const on = P.filter((o) => ['Approved', 'Sent', 'Part received'].includes(o.status));
    const sum = (l: Po[]) => l.reduce((t, o) => t + o.tot.inc, 0);
    return {
      drafts: P.filter((o) => o.status === 'Draft').length,
      onOrder: on.length, onOrderSum: sum(on),
      received: P.filter((o) => o.status === 'Received').length, receivedSum: sum(P.filter((o) => o.status === 'Received')),
      overdue: P.filter((o) => this.isLate(o)).length,
    };
  };
  render() {
    const q = (this.q || '').toLowerCase(), f = this.f;
    this.rows.set(this.all().filter((o) => (!f || (f === 'open' ? poOpen(o.status) : o.status === f)) && (!q || (o.id + ' ' + o.sup + ' ' + o.ref).toLowerCase().includes(q))));
    this.cdr.detectChanges();
  }
  addLine() { this.m.lines.update((ls) => [...ls, { stock: '', desc: '', qty: 1, price: 0, vat: '15', free: true }]); this.cd(); }
  rmLine(i: number) { this.m.lines.update((ls) => ls.filter((_, x) => x !== i)); this.cd(); }
  pickStock(i: number, sku: string) {
    this.m.lines.update((ls) => ls.map((l, x) => x !== i ? l : sku
      ? { ...l, stock: sku, desc: sku + ' — ' + (this.items().find((it) => it.sku === sku)?.name ?? ''), price: this.items().find((it) => it.sku === sku)?.cost ?? 0, free: false }
      : { ...l, stock: '', desc: '', free: true }));
    this.cd();
  }
  lineTot = (l: FormLine) => Math.round((Number(l.qty) || 0) * (Number(l.price) || 0) * 100) / 100;
  mTot = () => {
    const ls = this.m.lines();
    const ex = Math.round(ls.reduce((t, l) => t + this.lineTot(l), 0) * 100) / 100;
    const vat = Math.round(ls.reduce((t, l) => t + this.lineTot(l) * (Number(l.vat) || 0) / 100, 0) * 100) / 100;
    return { ex, vat, inc: Math.round((ex + vat) * 100) / 100 };
  };
  cd() { this.cdr.detectChanges(); }
  close(e?: MouseEvent) { if (!e || (e.target as HTMLElement).classList.contains('modal-bg')) { this.isOpen.set(false); this.cdr.detectChanges(); } }
  openPO(o?: Po) {
    this.err.set('');
    if (o) {
      if (o.status !== 'Draft') { this.toast.show('Only draft purchase orders can be edited.'); return; }
      this.edit = o.id;
    } else this.edit = '';
    const src: PoLine[] = o?.lines?.length ? o.lines : [{ seq: 0, stock: '', desc: '', qty: 1, price: 0, vat: 15 }];
    this.m = {
      sup: o?.sup ?? '', date: o?.date ?? todayIso(), due: o?.due ?? '', ref: o?.ref ?? '', by: o?.by ?? '', deliver: o?.deliver || '', notes: o?.notes ?? '',
      lines: signal(src.map((l) => ({ stock: l.stock || '', desc: l.desc, qty: l.qty, price: l.price, vat: String(l.vat), free: !l.stock }))),
    };
    this.isOpen.set(true); this.cd();
  }
  async save() {
    this.err.set('');
    const lines = this.m.lines().map((l) => ({ stock: l.stock, desc: l.desc.trim(), qty: Number(l.qty) || 0, price: Number(l.price) || 0, vat: l.vat }));
    const body = { sup: this.m.sup, date: this.m.date, due: this.m.due, ref: this.m.ref.trim(), by: this.m.by, deliver: this.m.deliver.trim(), notes: this.m.notes.trim(), lines };
    try {
      if (this.edit) await this.api.patch('/purchase-orders/' + this.edit, body);
      else {
        const r = await this.api.post<{ id: string }>('/purchase-orders', body);
        this.toast.show('Purchase order saved.'); void r;
        this.isOpen.set(false); await this.reload(); return;
      }
      this.toast.show('Purchase order saved.');
      this.isOpen.set(false); await this.reload();
    } catch (e) { this.err.set((e as ApiError).message); this.cdr.detectChanges(); }
  }
  async setStatus(o: Po, to: string) {
    if (to === 'Cancelled' && !confirm('Cancel ' + o.id + '?')) return;
    try {
      await this.api.post('/purchase-orders/' + o.id + '/status', { to });
      if (to === 'Approved') this.toast.show('Purchase order approved. Requestor email notifications arrive with the outbox batch.');
      await this.reload();
    } catch (e) { this.toast.show((e as ApiError).message); }
    this.cdr.detectChanges();
  }
  receive(o: Po) { this.isOpen.set(false); void this.router.navigate(['/procurement/grn'], { queryParams: { po: o.id } }); }
  async del(o: Po) {
    if (!confirm('Delete draft ' + o.id + '?')) return;
    try { await this.api.del('/purchase-orders/' + o.id); await this.reload(); } catch (e) { this.toast.show((e as ApiError).message); }
    this.cdr.detectChanges();
  }
}

// ── Goods Received Notes (openGRN/gnSupChanged/gnPoChanged/saveGRN/renderGRN 5076–5115) ──
interface Grn { id: string; po: string; sup: string; supName: string; date: string; dn: string; loc: string; inv: string; lines: { desc: string; qty: number; price: number; vat: number }[] }
const grnVal = (g: Grn) => Math.round(g.lines.reduce((t, l) => t + l.qty * l.price, 0) * 100) / 100;

@Component({
  selector: 'app-grn', imports: [FormsModule],
  template: `
  <div class="g3">
    <div class="card"><div class="stat-lbl">Goods received notes</div><div class="stat-val">{{list().length}}</div><div class="stat-sub">All time</div></div>
    <div class="card"><div class="stat-lbl">Awaiting invoice</div><div class="stat-val">{{uninvoiced().length}}</div><div class="stat-sub">{{fmtR(unSum())}} excl VAT</div></div>
    <div class="card"><div class="stat-lbl">Invoiced</div><div class="stat-val">{{list().length - uninvoiced().length}}</div><div class="stat-sub">Matched to supplier invoices</div></div>
  </div>
  <div class="card"><div class="card-title">Goods Received
    <button class="btn btn-p btn-sm" (click)="openGRN()"><i class="ti ti-plus"></i> New Goods Received Note</button></div>
    <table><thead><tr><th>GRN</th><th>PO</th><th>Supplier</th><th>Date</th><th>Delivery note</th><th class="tr">Value (excl)</th><th>Invoiced</th></tr></thead><tbody>
      @for (g of list(); track g.id) {
        <tr><td><strong>{{g.id}}</strong></td><td>{{g.po}}</td><td>{{g.supName}}</td><td>{{dayMon(g.date)}}</td><td>{{g.dn || '—'}}</td>
          <td class="tr">{{fmtR(grnVal(g))}}</td>
          <td>@if (g.inv) { <span class="chip c-ok">{{g.inv}}</span> } @else { <span class="chip c-wn">Not invoiced</span> }</td></tr>
      } @empty {
        <tr><td colspan="7" style="color:var(--txm)">No goods received yet. Use “Receive goods” on an approved purchase order, or the button above.</td></tr>
      }
    </tbody></table></div>
  @if (isOpen()) {
    <div class="modal-bg" style="display:block" (click)="close($event)">
      <div class="modal" style="max-width:860px" (click)="$event.stopPropagation()">
        <div class="rm-hd"><strong>New Goods Received Note</strong><button class="btn btn-s btn-sm" (click)="close()">✕</button></div>
        <div class="fr3">
          <div class="fg"><label>Supplier *</label><select [(ngModel)]="f.sup" (ngModelChange)="pickSup()">
            <option value="">— Select supplier —</option>
            @for (s of sups(); track s.code) { <option [value]="s.code">{{s.name}}</option> }</select></div>
          <div class="fg"><label>Purchase order *</label><select [(ngModel)]="f.po" (ngModelChange)="loadPo()">
            <option value="">@if (!f.sup) { Select a supplier first } @else if (!openPos().length) { No open purchase orders } @else { — Select purchase order — }</option>
            @for (o of openPos(); track o.id) { <option [value]="o.id">{{o.label}}</option> }</select></div>
          <div class="fg"><label>GRN #</label><input value="Auto (GRN-…)" disabled></div></div>
        <div class="fr3">
          <div class="fg"><label>Date received *</label><input type="date" [(ngModel)]="f.date"></div>
          <div class="fg"><label>Delivery note / supplier ref</label><input [(ngModel)]="f.dn" maxlength="40"></div>
          <div class="fg"><label>Receiving location</label><select [(ngModel)]="f.loc"><option>Main Warehouse</option><option>Shelf A</option></select></div></div>
        <table><thead><tr><th>Description</th><th class="tr" style="width:80px">Ordered</th><th class="tr" style="width:100px">Received before</th><th class="tr" style="width:90px">Outstanding</th><th style="width:110px">Receive now</th></tr></thead><tbody>
          @if (f.po && poLines().length) {
            @for (l of poLines(); track l.seq; let i = $index) {
              <tr><td>{{l.desc}}</td><td class="tr">{{l.qty}}</td><td class="tr">{{r2(l.recv)}}</td><td class="tr">{{r2(l.qty - l.recv)}}</td>
                <td><input type="number" min="0" [max]="l.qty - l.recv" step="any" style="width:100px" [(ngModel)]="f.qty[i]" (ngModelChange)="cd()" [disabled]="l.qty - l.recv <= 0"></td></tr>
            }
          } @else { <tr><td colspan="5" style="color:var(--txm)">Select a purchase order to load its lines.</td></tr> }
        </tbody></table>
        <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
        <div class="btn-grp"><button class="btn btn-p" (click)="save()"><i class="ti ti-device-floppy"></i> Save Goods Received Note</button>
          <button class="btn btn-s" (click)="close()">Cancel</button></div>
      </div></div>
  }`,
})
export class GrnComponent {
  fmtR = fmtR; dayMon = dayMon; grnVal = grnVal;
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  private ar = inject(ActivatedRoute);
  list = signal<Grn[]>([]);
  sups = signal<{ code: string; name: string }[]>([]);
  openPos = signal<{ id: string; label: string }[]>([]);
  poLines = signal<{ seq: number; desc: string; qty: number; recv: number }[]>([]);
  isOpen = signal(false); err = signal('');
  f = { sup: '', po: '', date: todayIso(), dn: '', loc: 'Main Warehouse', qty: [] as Record<number, number> };

  constructor() { void this.reload(); }
  r2 = (n: number) => Math.round(n * 100) / 100;
  uninvoiced = () => this.list().filter((g) => !g.inv);
  unSum = () => Math.round(this.uninvoiced().reduce((t, g) => t + grnVal(g), 0) * 100) / 100;
  cd() { this.cdr.detectChanges(); }
  close(e?: MouseEvent) { if (!e || (e.target as HTMLElement).classList.contains('modal-bg')) { this.isOpen.set(false); this.cdr.detectChanges(); } }
  async reload() {
    const [l, s] = await Promise.all([
      this.api.get<Grn[]>('/grns'), this.api.get<{ code: string; name: string }[]>('/suppliers'),
    ]);
    this.list.set(l); this.sups.set(s);
    // deep-link "Receive goods" from the PO list
    const po = this.ar.snapshot.queryParamMap.get('po');
    if (po) {
      const p = (await this.api.get<{ id: string; sup: string }[]>('/purchase-orders')).find((x) => x.id === po);
      if (p) { this.f.sup = p.sup; await this.pickSup(); this.f.po = po; await this.loadPo(); this.isOpen.set(true); }
    }
    this.cdr.detectChanges();
  }
  openGRN() { this.f = { sup: '', po: '', date: todayIso(), dn: '', loc: 'Main Warehouse', qty: [] }; this.poLines.set([]); this.err.set(''); this.isOpen.set(true); this.cd(); }
  async pickSup() {
    this.f.po = '';
    this.poLines.set([]);
    this.openPos.set(this.f.sup ? await this.api.get<{ id: string; label: string }[]>('/grn-lookup?sup=' + encodeURIComponent(this.f.sup)) : []);
    this.cd();
  }
  async loadPo() {
    if (!this.f.po) { this.poLines.set([]); this.cd(); return; }
    const po = await this.api.get<{ lines: { seq: number; desc: string; qty: number; recv: number }[] }>('/grns/' + this.f.po);
    this.poLines.set(po.lines);
    this.f.qty = Object.fromEntries(po.lines.map((l) => [l.seq, Math.round((l.qty - l.recv) * 100) / 100]));
    this.cd();
  }
  async save() {
    this.err.set('');
    const lines: { i: number; qty: number }[] = [];
    for (const [k, v] of Object.entries(this.f.qty)) {
      const q = Number(v) || 0;
      if (q > 0) lines.push({ i: Number(k), qty: q });
    }
    try {
      const r = await this.api.post<{ id: string; received: string; nst: number }>('/grns', { sup: this.f.sup, po: this.f.po, date: this.f.date, dn: this.f.dn.trim(), loc: this.f.loc, lines });
      this.toast.show(`${r.id} saved${r.nst ? ` and ${r.nst} item${r.nst > 1 ? 's' : ''} added to stock` : ''}. ${this.f.po} is now ${r.received.toLowerCase()}.`);
      this.isOpen.set(false);
      await this.reload();
    } catch (e) { this.err.set((e as ApiError).message); this.cdr.detectChanges(); }
  }
}
