import { Component, ChangeDetectorRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiService, ApiError, ToastService } from '../../core/api';
import { AuthStore } from '../../core/auth.store';
import { fmtR, dayMon, todayIso, stkDate } from '../../core/fmt';

export interface Sup { code: string; name: string; trading: string; vatNo: string; regNo: string; contact: string; email: string; phone: string; bank: string; terms: string; defaultExp: string | null; street: string; suburb: string; city: string; prov: string; pc: string; balance: number; }

const BLANK_SUP = { name: '', trading: '', vat: '', reg: '', contact: '', email: '', phone: '', bank: '', terms: '30 days', defaultExp: '', street: '', suburb: '', city: '', prov: 'Gauteng', pc: '' };
const S_TERMS = ['30 days', '60 days', '7 days', 'COD', 'EOM', 'Monthly'];
const PROVS = ['Gauteng', 'Western Cape', 'KwaZulu-Natal', 'Eastern Cape', 'Free State', 'Mpumalanga', 'Limpopo', 'North West', 'Northern Cape'];

// ── Supplier List (renderSupList) ──
@Component({
  selector: 'app-sup-list', imports: [FormsModule],
  template: `
  <div class="card">
    <div class="st-r2">
      <div class="stat-card"><div class="stat-lbl">Total Suppliers</div><div class="stat-val">{{st().n}}</div><div class="stat-sub">{{st().owed}} owed money</div></div>
      <div class="stat-card"><div class="stat-lbl">Total Payable</div><div class="stat-val" style="color:var(--wn)">{{fmtR(st().tot)}}</div><div class="stat-sub">Across {{st().owed}} supplier{{st().owed === 1 ? '' : 's'}}</div></div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin:10px 0">
      <input style="max-width:380px" placeholder="Code, name, email or VAT no." [(ngModel)]="q" name="q">
      <button class="btn btn-p" (click)="goAdd()"><i class="ti ti-truck"></i> Add Supplier</button>
    </div>
    <table><thead><tr><th>Code</th><th>Supplier Name</th><th>Contact</th><th>VAT No.</th><th class="tr">Balance Owing</th><th>Terms</th><th>Status</th><th style="width:120px">Action</th></tr></thead>
    <tbody>
      @for (s of filtered(); track s.code) {
        <tr>
          <td>{{s.code}}</td><td><strong>{{s.name}}</strong></td><td>{{s.email || '—'}}</td><td>{{s.vatNo || '—'}}</td>
          <td class="tr" [style.color]="s.balance > 0.004 ? 'var(--wn)' : ''">{{fmtR(s.balance)}}</td><td>{{s.terms}}</td>
          <td><span class="chip" [class.c-wn]="s.balance > 0.004" [class.c-ok]="s.balance <= 0.004">{{s.balance > 0.004 ? 'Owing' : 'Clear'}}</span></td>
          <td><button class="btn btn-s btn-sm" (click)="edit(s)"><i class="ti ti-pencil"></i> Edit</button></td>
        </tr>
      } @empty { <tr><td colspan="8" style="text-align:center;color:var(--txm)">No suppliers match your search.</td></tr> }
    </tbody></table>
  </div>`,
})
export class SupListComponent {
  fmtR = fmtR;
  private api = inject(ApiService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  auth = inject(AuthStore);
  list = signal<Sup[]>([]);
  q = '';
  filtered = computed(() => { const s = this.q.toLowerCase(); return this.list().filter((c) => !s || (c.code + ' ' + c.name + ' ' + c.email + ' ' + c.vatNo).toLowerCase().includes(s)); });

  constructor() { this.auth.company(); void this.reload(); }
  async reload() { this.list.set(await this.api.get<Sup[]>('/suppliers')); this.cdr.detectChanges(); }
  st = () => {
    const l = this.filtered();
    const owed = l.filter((c) => c.balance > 0.004).length;
    return { n: l.length, owed, tot: l.reduce((s, c) => s + c.balance, 0) };
  };
  edit(s: Sup) { this.auth.custEdit.set({ ...s }); this.router.navigateByUrl('/suppliers/add'); }
  goAdd() { this.auth.custEdit.set(null); this.router.navigateByUrl('/suppliers/add'); }
}

// ── Add/Edit Supplier ──
@Component({
  selector: 'app-sup-add', imports: [FormsModule],
  template: `
  <div class="card">
    <div class="card-title">{{editCode() ? 'Edit Supplier — ' + editCode() : 'Add New Supplier'}}</div>
    <div class="fr">
      <div class="fg"><label>Supplier / Company Name *</label><input [(ngModel)]="f.name" maxlength="80" placeholder="e.g. ABC Supplies (Pty) Ltd"></div>
      <div class="fg"><label>Trading Name</label><input [(ngModel)]="f.trading" maxlength="80"></div></div>
    <div class="fr">
      <div class="fg"><label>VAT Registration Number</label><input [(ngModel)]="f.vat" maxlength="10" placeholder="10 digits, starts with 4"></div>
      <div class="fg"><label>Company Reg. No.</label><input [(ngModel)]="f.reg" maxlength="20"></div></div>
    <div class="fr">
      <div class="fg"><label>Contact Person</label><input [(ngModel)]="f.contact" maxlength="80"></div>
      <div class="fg"><label>Email Address *</label><input [(ngModel)]="f.email" maxlength="120" placeholder="invoices@supplier.co.za"></div></div>
    <div class="fr">
      <div class="fg"><label>Phone</label><input [(ngModel)]="f.phone" maxlength="20"></div>
      <div class="fg"><label>Bank Account (for payments)</label><input [(ngModel)]="f.bank" maxlength="40"></div></div>
    <div class="fr">
      <div class="fg"><label>Payment Terms</label><select [(ngModel)]="f.terms">
        @for (t of S_TERMS; track t) { <option [value]="t">{{t}}</option> }</select></div>
      <div class="fg"><label>Default Expense Account</label><select [(ngModel)]="f.defaultExp">
        <option value="">— None —</option>
        @for (a of accs(); track a.code) { <option [value]="a.code">{{a.code}} — {{a.name}}</option> }</select></div></div>
    <div class="card-title" style="margin-top:8px">Supplier Address</div>
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
      <button class="btn btn-p" (click)="save()" [disabled]="busy()"><i class="ti ti-device-floppy"></i> Save Supplier</button>
      <button class="btn btn-s" (click)="cancel()">Cancel edit</button></div>
  </div>`,
})
export class SupAddComponent {
  S_TERMS = S_TERMS; PROVS = PROVS;
  private api = inject(ApiService);
  private auth = inject(AuthStore);
  private router = inject(Router);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);

  f = { ...BLANK_SUP };
  accs = signal<{ code: string; name: string }[]>([]);
  err = signal(''); busy = signal(false);
  editCode = signal('');

  constructor() { void this.load(); }
  async load() {
    this.accs.set(await this.api.get<{ code: string; name: string }[]>('/gl/accounts'));
    const e = this.auth.custEdit() as Sup | null;
    if (e) {
      this.editCode.set(e.code);
      this.f = { name: e.name, trading: e.trading || '', vat: e.vatNo || '', reg: e.regNo || '', contact: e.contact || '', email: e.email || '', phone: e.phone || '', bank: e.bank || '', terms: e.terms, defaultExp: e.defaultExp || '', street: e.street || '', suburb: e.suburb || '', city: e.city || '', prov: e.prov, pc: e.pc || '' };
    } else { this.editCode.set(''); this.f = { ...BLANK_SUP }; }
    this.cdr.detectChanges();
  }
  cancel() { this.auth.custEdit.set(null); }

  async save() {
    this.err.set(''); this.busy.set(true);
    const p = { ...this.f, defaultExp: this.f.defaultExp || null };
    try {
      const code = this.editCode();
      if (code) await this.api.patch('/suppliers/' + code, p);
      else await this.api.post('/suppliers', p);
      this.toast.show('Supplier ' + (code || p.name) + ' saved.');
      this.auth.custEdit.set(null);
      this.router.navigateByUrl('/suppliers/list');
    } catch (e) { this.err.set((e as ApiError).message); }
    finally { this.busy.set(false); }
  }
}

// ── Supplier Journals (postSubJnl 'sup' + This Period list) ──
@Component({
  selector: 'app-sup-jnl', imports: [FormsModule],
  template: `
  <div class="notice"><i class="ti ti-info-circle"></i> Supplier journals adjust a supplier account (corrections, settlement discounts, reclassifications) and post against control account 9000 — Accounts Payable.</div>
  <div class="card" style="margin-bottom:16px"><div class="card-title">New Supplier Journal</div>
    <div class="fr">
      <div class="fg"><label>Supplier *</label><select [(ngModel)]="f.party">
        <option value="">— Select —</option>
        @for (s of sups(); track s.code) { <option [value]="s.code">{{s.name}}</option> }</select></div>
      <div class="fg"><label>Journal Date *</label><input type="date" [(ngModel)]="f.date"></div></div>
    <div class="fr">
      <div class="fg"><label>Journal Ref #</label><input value="Auto (SJ-…)" disabled></div>
      <div class="fg"><label>Adjustment Type *</label><select [(ngModel)]="f.type">
        <option value="inc">Increase amount owing (credit supplier)</option>
        <option value="dec">Decrease amount owing (debit supplier)</option></select></div></div>
    <div class="fr">
      <div class="fg"><label>Amount (ZAR) *</label><input type="number" min="0" step="0.01" [(ngModel)]="f.amount" (ngModelChange)="cd()"></div>
      <div class="fg"><label>Contra GL Account *</label><select [(ngModel)]="f.contra">
        <option value="">— Select —</option>
        @for (a of accs(); track a.code) { <option [value]="a.code">{{a.code}} — {{a.name}}</option> }</select></div></div>
    <div class="fr">
      <div class="fg"><label>Narration *</label><input [(ngModel)]="f.narration" maxlength="200" placeholder="Reason for adjustment"></div></div>
    <div class="card-title" style="margin-top:8px">GL posting preview</div>
    @if (num(f.amount) > 0 && f.contra) {
      <table style="max-width:640px"><thead><tr><th>Account</th><th class="tr">Debit</th><th class="tr">Credit</th></tr></thead><tbody>
        <tr><td>9000 — Accounts Payable</td><td class="tr">{{f.type === 'dec' ? fmtR(num(f.amount)) : ''}}</td><td class="tr">{{f.type === 'inc' ? fmtR(num(f.amount)) : ''}}</td></tr>
        <tr><td>{{contraLabel()}}</td><td class="tr">{{f.type === 'inc' ? fmtR(num(f.amount)) : ''}}</td><td class="tr">{{f.type === 'dec' ? fmtR(num(f.amount)) : ''}}</td></tr>
      </tbody></table>
    } @else { <div style="color:var(--txm)">Enter an amount to preview the posting.</div> }
    <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
    <div class="btn-grp"><button class="btn btn-p" (click)="save()" [disabled]="busy()"><i class="ti ti-book"></i> Post Journal</button>
      <button class="btn btn-s" (click)="reset()">Cancel</button></div>
  </div>
  <div class="card"><div class="card-title">Supplier Journals — This Period</div>
    <table><thead><tr><th>Date</th><th>Ref</th><th>Supplier</th><th>Narration</th><th>Type</th><th class="tr">Amount</th></tr></thead>
    <tbody>
      @for (j of list(); track j.ref) {
        <tr><td>{{dayMon(j.date)}}</td><td>{{j.ref}}</td><td>{{j.supName}}</td><td>{{j.description}}</td><td>{{j.type}}</td><td class="tr">{{fmtR(j.amount)}}</td></tr>
      } @empty { <tr><td colspan="6" style="color:var(--txm)">No journals posted this period.</td></tr> }
    </tbody></table></div>`,
})
export class SupJnlComponent {
  num = (v: unknown): number => Number(v);
  fmtR = fmtR; dayMon = dayMon;
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  sups = signal<{ code: string; name: string }[]>([]);
  accs = signal<{ code: string; name: string }[]>([]);
  list = signal<{ ref: string; date: string; supName: string; description: string; type: string; amount: number }[]>([]);
  busy = signal(false); err = signal('');
  f = { party: '', date: todayIso(), type: 'inc', amount: 0, contra: '', narration: '' };

  constructor() { void this.reload(); }
  async reload() {
    const [s, a, l] = await Promise.all([
      this.api.get<{ code: string; name: string }[]>('/suppliers'),
      this.api.get<{ code: string; name: string }[]>('/gl/accounts'),
      this.api.get<{ ref: string; date: string; supName: string; description: string; type: string; amount: number }[]>('/sup-journals').catch(() => []),
    ]);
    this.sups.set(s); this.accs.set(a); this.list.set(l); this.cdr.detectChanges();
  }
  contraLabel = () => { const a = this.accs().find((x) => x.code === this.f.contra); return a ? a.code + ' — ' + a.name : ''; };
  cd() { this.cdr.detectChanges(); }
  reset() { this.f = { party: '', date: todayIso(), type: 'inc', amount: 0, contra: '', narration: '' }; this.err.set(''); this.cd(); }
  async save() {
    this.err.set(''); this.busy.set(true);
    try {
      const r = await this.api.post<{ ref: string }>('/sup-journal', { party: this.f.party, type: this.f.type, contra: this.f.contra, amount: Number(this.f.amount), narration: this.f.narration, date: this.f.date });
      this.toast.show('Supplier journal ' + r.ref + ' posted.');
      await this.reload();
    } catch (e) { this.err.set((e as ApiError).message); }
    finally { this.busy.set(false); }
  }
}

// ── Supplier Account Enquiry ──
@Component({
  selector: 'app-sup-enq', imports: [FormsModule],
  template: `
  <div class="card" style="margin-bottom:12px"><div class="card-title">Supplier Account Enquiry</div>
    <div class="fr">
      <div class="fg"><label>Supplier</label><select [(ngModel)]="code" (ngModelChange)="load()">
        <option value="">— Select —</option>
        @for (s of sups(); track s.code) { <option [value]="s.code">{{s.name}}</option> }</select></div>
      <div class="fg"><label>From date</label><input type="date" [(ngModel)]="from" (ngModelChange)="load()"></div>
      <div class="fg"><label>To date</label><input type="date" [(ngModel)]="to" (ngModelChange)="load()"></div></div></div>
  @if (d()) {
    <div class="st-r3">
      <div class="stat-card"><div class="stat-lbl">Balance Owing</div><div class="stat-val" style="color:var(--wn)">{{fmtR(dd().closing)}}</div><div class="stat-sub">{{dd().code}}</div></div>
      <div class="stat-card"><div class="stat-lbl">Opening Balance</div><div class="stat-val">{{fmtR(dd().opening)}}</div><div class="stat-sub">Start of period</div></div>
      <div class="stat-card"><div class="stat-lbl">Movement</div><div class="stat-val">{{fmtR(dd().closing - dd().opening)}}</div><div class="stat-sub">Debits less credits</div></div>
    </div>
    <div class="card"><table><thead><tr><th>Date</th><th>Reference</th><th>Description</th><th class="tr">Debit</th><th class="tr">Credit</th><th class="tr">Balance Owing</th></tr></thead>
    <tbody>
      @if (!from) { <tr><td>{{stkDate(first())}}</td><td>Opening Balance</td><td></td><td></td><td></td><td class="tr">{{fmtR(dd().opening)}}</td></tr> }
      @for (r of dd().rows; track $index) {
        <tr><td>{{stkDate(r.date)}}</td><td>{{r.ref}}</td><td>{{r.desc}}</td>
          <td class="tr">{{r.dr ? fmtR(r.dr) : ''}}</td><td class="tr">{{r.cr ? fmtR(r.cr) : ''}}</td><td class="tr">{{fmtR(r.bal)}}</td></tr>
      }
      @if (dd().empty) { <tr><td colspan="6" style="text-align:center;color:var(--txm)">No transactions this period.</td></tr> }
      <tr class="tg"><td colspan="5">Closing Balance</td><td class="tr">{{fmtR(closing())}}</td></tr>
    </tbody></table></div>
  }`,
})
export class SupEnqComponent {
  fmtR = fmtR; stkDate = stkDate;
  private api = inject(ApiService);
  private cdr = inject(ChangeDetectorRef);
  sups = signal<{ code: string; name: string }[]>([]);
  code = ''; from = ''; to = '';
  private r = signal<{ code: string; name: string; limit: number; opening: number; rows: { date: string; ref: string; desc: string; dr: number; cr: number; bal: number }[]; closing: number; empty: boolean } | null>(null);
  d = () => this.r();
  dd = () => this.r()!;

  constructor() { void this.reload(); }
  async reload() { this.sups.set(await this.api.get<{ code: string; name: string }[]>('/suppliers')); this.cdr.detectChanges(); }
  closing = () => this.r()?.closing ?? 0;
  first = () => this.r()?.rows?.[0]?.date ?? '';
  async load() {
    if (!this.code) { this.r.set(null); this.cdr.detectChanges(); return; }
    const qs = this.from || this.to ? '?from=' + this.from + '&to=' + this.to : '';
    this.r.set(await this.api.get('/suppliers/' + this.code + '/ledger' + qs)); this.cdr.detectChanges();
  }
}
