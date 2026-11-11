import { Component, ChangeDetectorRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiService, ApiError, ToastService } from '../../core/api';
import { AuthStore } from '../../core/auth.store';
import { fmtR, stkDate, todayIso } from '../../core/fmt';

export interface Cust { code: string; name: string; trading: string; vatNo: string; regNo: string; contact: string; email: string; svcEmail: string; phone: string; limit: number; terms: string; street: string; suburb: string; city: string; prov: string; pc: string; balance: number; }

const BLANK_CUST = { name: '', trading: '', vat: '', reg: '', contact: '', email: '', svcEmail: '', phone: '', limit: 0, terms: '30 days', street: '', suburb: '', city: '', prov: 'Gauteng', pc: '' };
const TERMS = ['30 days', '60 days', '7 days', 'COD', 'EOM + 30'];
const PROVS = ['Gauteng', 'Western Cape', 'KwaZulu-Natal', 'Eastern Cape', 'Free State', 'Mpumalanga', 'Limpopo', 'North West', 'Northern Cape'];

// ── Customer List (renderCustList) ──
@Component({
  selector: 'app-cust-list', imports: [FormsModule],
  template: `
  <div class="card">
    <div class="st-r3">
      <div class="stat-card"><div class="stat-lbl">Total Customers</div><div class="stat-val">{{st().n}}</div><div class="stat-sub">{{st().owing}} with a balance</div></div>
      <div class="stat-card"><div class="stat-lbl">Outstanding Balance</div><div class="stat-val" style="color:var(--wn)">{{fmtR(st().tot)}}</div><div class="stat-sub">Across {{st().owing}} customer{{st().owing === 1 ? '' : 's'}}</div></div>
      <div class="stat-card"><div class="stat-lbl">Over Credit Limit</div><div class="stat-val" style="color:var(--dn)">{{st().over}}</div><div class="stat-sub">Balance above limit</div></div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin:10px 0">
      <input style="max-width:380px" placeholder="Code, name, email or VAT no." [(ngModel)]="q" name="q">
      <button class="btn btn-p" (click)="goAdd()"><i class="ti ti-user-plus"></i> Add Customer</button>
    </div>
    <table><thead><tr><th>Code</th><th>Customer Name</th><th>Contact</th><th>VAT No.</th><th class="tr">Balance</th><th>Status</th><th style="width:120px">Action</th></tr></thead>
    <tbody>
      @for (c of filtered(); track c.code) {
        <tr>
          <td>{{c.code}}</td><td><strong>{{c.name}}</strong></td><td>{{c.email || '—'}}</td><td>{{c.vatNo || '—'}}</td>
          <td class="tr" [style.color]="c.balance > 0.004 ? 'var(--wn)' : ''">{{fmtR(c.balance)}}</td>
          <td><span class="chip" [class.c-dn]="over(c)" [class.c-wn]="!over(c) && c.balance > 0.004" [class.c-ok]="c.balance <= 0.004">{{over(c) ? 'Over limit' : c.balance > 0.004 ? 'Outstanding' : 'Clear'}}</span></td>
          <td><button class="btn btn-s btn-sm" (click)="edit(c)"><i class="ti ti-pencil"></i> Edit</button></td>
        </tr>
      } @empty { <tr><td colspan="7" style="text-align:center;color:var(--txm)">No customers match your search.</td></tr> }
    </tbody></table>
  </div>`,
})
export class CustListComponent {
  fmtR = fmtR;
  private api = inject(ApiService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  auth = inject(AuthStore);
  list = signal<Cust[]>([]);
  q = '';
  filtered = computed(() => { const s = this.q.toLowerCase(); return this.list().filter((c) => !s || (c.code + ' ' + c.name + ' ' + c.email + ' ' + c.vatNo).toLowerCase().includes(s)); });

  constructor() { this.auth.company(); void this.reload(); }
  async reload() { this.list.set(await this.api.get<Cust[]>('/customers')); this.cdr.detectChanges(); }
  st = () => {
    const l = this.filtered();
    const owing = l.filter((c) => c.balance > 0.004).length;
    return { n: l.length, owing, tot: l.reduce((s, c) => s + c.balance, 0), over: l.filter((c) => c.limit > 0 && c.balance > c.limit).length };
  };
  over = (c: Cust) => c.limit > 0 && c.balance > c.limit + 0.004;
  edit(c: Cust) { this.auth.custEdit.set({ ...c }); this.router.navigateByUrl('/customers/add'); }
  goAdd() { this.auth.custEdit.set(null); this.router.navigateByUrl('/customers/add'); }
}

// ── Add/Edit Customer (addCustomer/saveCustomer port). Add and Edit share the form. ──
@Component({
  selector: 'app-cust-add', imports: [FormsModule],
  template: `
  <div class="card">
    <div class="card-title">{{editCode() ? 'Edit Customer — ' + editCode() : 'Add New Customer'}}</div>
    <div class="fr">
      <div class="fg"><label>Customer / Company Name *</label><input [(ngModel)]="f.name" maxlength="80" placeholder="e.g. ABC Holdings (Pty) Ltd"></div>
      <div class="fg"><label>Trading Name</label><input [(ngModel)]="f.trading" maxlength="80"></div></div>
    <div class="fr">
      <div class="fg"><label>VAT Registration Number</label><input [(ngModel)]="f.vat" maxlength="10" placeholder="10 digits, starts with 4"></div>
      <div class="fg"><label>Company Reg. No. (CIPC)</label><input [(ngModel)]="f.reg" maxlength="20"></div></div>
    <div class="fr">
      <div class="fg"><label>Contact Person</label><input [(ngModel)]="f.contact" maxlength="80"></div>
      <div class="fg"><label>Accounts Email *</label><input [(ngModel)]="f.email" maxlength="120" placeholder="accounts@company.co.za">
        <div class="fg-help">Statements, invoices and other accounting documents are sent here.</div></div></div>
    <div class="fr">
      <div class="fg"><label>Service Email</label><input [(ngModel)]="f.svcEmail" maxlength="120">
        <div class="fg-help">Service notifications are sent here when a call is created and when it is completed.</div></div>
      <div class="fg"><label>Phone</label><input [(ngModel)]="f.phone" maxlength="20"></div></div>
    <div class="fr">
      <div class="fg"><label>Credit Limit (ZAR)</label><input type="number" [(ngModel)]="f.limit"></div>
      <div class="fg"><label>Payment Terms</label><select [(ngModel)]="f.terms">
        @for (t of TERMS; track t) { <option [value]="t">{{t}}</option> }</select></div></div>
    <div class="card-title" style="margin-top:8px">Physical / Postal Address</div>
    <div class="fr">
      <div class="fg"><label>Street Address</label><input [(ngModel)]="f.street" maxlength="120"></div>
      <div class="fg"><label>Suburb</label><input [(ngModel)]="f.suburb" maxlength="60"></div></div>
    <div class="fr">
      <div class="fg"><label>City</label><input [(ngModel)]="f.city" maxlength="60"></div>
      <div class="fg"><label>Province</label><select [(ngModel)]="f.prov">
        @for (p of PROVS; track p) { <option [value]="p">{{p}}</option> }</select></div></div>
    <div class="fr">
      <div class="fg"><label>Postal Code</label><input [(ngModel)]="f.pc" maxlength="4"></div></div>
    <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
    <div class="btn-grp">
      <button class="btn btn-p" (click)="save()" [disabled]="busy()"><i class="ti ti-device-floppy"></i> {{editCode() ? 'Save Customer' : 'Save Customer'}}</button>
      <button class="btn btn-s" (click)="cancel()">Cancel edit</button></div>
  </div>`,
})
export class CustAddComponent {
  TERMS = TERMS; PROVS = PROVS; fmtR = fmtR;
  private api = inject(ApiService);
  private auth = inject(AuthStore);
  private router = inject(Router);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);

  f = { ...BLANK_CUST };
  err = signal(''); busy = signal(false);
  editCode = signal('');

  constructor() { void this.load(); }
  async load() {
    const e = this.auth.custEdit() as Cust | null;
    if (e) {
      this.editCode.set(e.code);
      this.f = { name: e.name, trading: e.trading || '', vat: e.vatNo || '', reg: e.regNo || '', contact: e.contact || '', email: e.email || '', svcEmail: e.svcEmail || '', phone: e.phone || '', limit: e.limit, terms: e.terms, street: e.street || '', suburb: e.suburb || '', city: e.city || '', prov: e.prov, pc: e.pc || '' };
    } else { this.editCode.set(''); this.f = { ...BLANK_CUST }; }
    // ponytail: sync read only — render happens on first view creation, no detectChanges needed here
  }
  cancel() { this.auth.custEdit.set(null); }

  async save() {
    this.err.set(''); this.busy.set(true);
    const p = { ...this.f, limit: Number(this.f.limit) || 0 };
    try {
      const code = this.editCode();
      if (code) await this.api.patch('/customers/' + code, p);
      else await this.api.post('/customers', p);
      this.toast.show('Customer ' + (code || p.name) + ' saved.');
      this.auth.custEdit.set(null);
      this.router.navigateByUrl('/customers/list');
    } catch (e) { this.err.set((e as ApiError).message); }
    finally { this.busy.set(false); }
  }
}
