import { Component, ChangeDetectorRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink, RouterOutlet } from '@angular/router';
import { ApiService, ApiError, ToastService } from '../../core/api';
import { fmtR, dayMon, todayIso } from '../../core/fmt';

const DN_NOTICE = 'A debit note is issued to a supplier to reduce the amount owed — typically for returned goods or overcharges. It reduces your accounts payable and adjusts input VAT.';

// Procurement parent: flat tab bar (legacy has no sec-bar here)
@Component({
  selector: 'app-procurement', imports: [RouterOutlet, RouterLink],
  template: `
  <div class="page-title">Procurement</div>
  <div class="page-sub">Raise purchase orders to suppliers, approve them and record delivery</div>
  <div class="stab-bar">
    <span class="stab" style="opacity:.4;cursor:not-allowed" title="Purchase orders arrive in batch 5"><i class="ti ti-file-shopping-cart"></i> Purchase Orders</span>
    <span class="stab" style="opacity:.4;cursor:not-allowed" title="Goods received arrives in batch 5"><i class="ti ti-package"></i> Goods Received</span>
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
          <tr><td>{{p.id}}</td><td>{{p.supName}}</td><td>{{p.theirNo}}</td><td>{{dayMon(p.date)}}</td>
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
  list = signal<{ id: string; supName: string; theirNo: string; date: string; ex: number; vat: number; tot: number }[]>([]);
  sups = signal<{ code: string; name: string; defaultExp: string | null }[]>([]);
  accs = signal<{ code: string; name: string; type: string }[]>([]);
  newing = signal(false); busy = signal(false); err = signal('');
  f = { supplier: '', theirNo: '', date: todayIso(), due: '', desc: '', acc: '', amount: 0, vat: 'Standard 15%' };

  constructor() { void this.reload(); }
  async reload() {
    const [l, s, a] = await Promise.all([
      this.api.get<{ id: string; supName: string; theirNo: string; date: string; ex: number; vat: number; tot: number }[]>('/supplier-invoices'), this.api.get<{ code: string; name: string; defaultExp: string | null }[]>('/suppliers'), this.api.get<{ code: string; name: string; type: string }[]>('/gl/accounts'),
    ]);
    this.list.set(l); this.sups.set(s); this.accs.set(a); this.cdr.detectChanges();
  }
  expAccs = () => this.accs().filter((a) => a.type === 'Expense' || a.type === 'Cost of Sales');
  ex = () => Math.round(Number(this.f.amount) * 100) / 100;
  vatAmt = () => this.f.vat === 'Standard 15%' ? Math.round(this.ex() * 15) / 100 : 0;
  cd() { this.cdr.detectChanges(); }
  showList() { this.newing.set(false); this.cdr.detectChanges(); }
  newPi() { this.f = { supplier: '', theirNo: '', date: todayIso(), due: '', desc: '', acc: '', amount: 0, vat: 'Standard 15%' }; this.newing.set(true); this.cdr.detectChanges(); }
  pickSup(code: string) { this.f.acc = this.sups().find((s) => s.code === code)?.defaultExp || ''; this.cd(); }
  async save() {
    this.err.set(''); this.busy.set(true);
    const v = this.f.vat === 'Standard 15%' ? '15' : '0';
    try {
      const r = await this.api.post<{ id: string }>('/supplier-invoices', { supplier: this.f.supplier, theirNo: this.f.theirNo, date: this.f.date, due: this.f.due, desc: this.f.desc, acc: this.f.acc, amount: Number(this.f.amount), vat: v });
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
