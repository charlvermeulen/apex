import { Component, ChangeDetectorRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { ApiService, ApiError, ToastService } from '../../core/api';
import { AuthStore } from '../../core/auth.store';
import { fmtR, dayMon, todayIso, stkDate } from '../../core/fmt';

const dayAdd = (iso: string, d: number): string => { const t = new Date(iso); t.setDate(t.getDate() + d); return t.toISOString().slice(0, 10); };

// ── Sales Invoices: list (inv-list) + New Sales Invoice (saveSI2 port) ──
interface Si { id: string; cust: string; custName: string; date: string; due: string; ex: number; vat: number; tot: number; status: string; }

@Component({
  selector: 'app-cust-si', imports: [FormsModule],
  template: `
  <div class="card">
    <div class="notice"><i class="ti ti-info-circle"></i> <strong>Sales Invoice</strong> — one-off sale of goods or services (numbered SI-). Recurring contract and rental billing is done under Contract Billing and appears under Contract Invoices (numbered CINV-). SARS Tax Invoice — s20(4) VAT Act 89/1991. Must include supplier VAT No., customer VAT No., invoice number, date, description, quantity, unit price, VAT amount, and total.</div>
    <div class="tab-bar" style="margin:0 0 12px">
      <button class="tab" [class.active]="!newing()" (click)="list()">Sales Invoice List</button>
      <button class="tab" [class.active]="newing()" (click)="newInv()">New Sales Invoice</button>
    </div>

    @if (!newing()) {
      <table><thead><tr><th>Invoice #</th><th>Customer</th><th>Date</th><th>Due Date</th><th class="tr">Excl. VAT</th><th class="tr">VAT 15%</th><th class="tr">Total Incl.</th><th>Status</th></tr></thead>
      <tbody>
        @for (s of inv(); track s.id) {
          <tr><td>{{s.id}}</td><td>{{s.custName}}</td><td>{{dayMon(s.date)}}</td><td>{{dayMon(s.due)}}</td>
            <td class="tr">{{fmtR(s.ex)}}</td><td class="tr">{{fmtR(s.vat)}}</td><td class="tr">{{fmtR(s.tot)}}</td>
            <td><span class="chip" [class.c-dn]="s.status === 'Overdue'" [class.c-bl]="s.status !== 'Overdue'">{{s.status}}</span></td></tr>
        } @empty { <tr><td colspan="8" style="text-align:center;color:var(--txm)">No sales invoices yet.</td></tr> }
      </tbody></table>
    } @else {
      <div class="fr">
        <div class="fg"><label>Customer *</label><select [(ngModel)]="f.customer">
          <option value="">— Select —</option>
          @for (c of custs(); track c.code) { <option [value]="c.code">{{c.name}}</option> }</select></div>
        <div class="fg"><label>Invoice #</label><input value="Auto" disabled></div></div>
      <div class="fr">
        <div class="fg"><label>Invoice Date *</label><input type="date" [(ngModel)]="f.date"></div>
        <div class="fg"><label>Due Date *</label><input type="date" [(ngModel)]="f.due"></div>
        <div class="fg"><label>Reference / PO# <span style="color:var(--txm)">(Optional)</span></label><input [(ngModel)]="f.ref" maxlength="40"></div></div>
      <table style="margin-top:10px"><thead><tr><th>Item Type *</th><th>Item *</th><th>Qty</th><th>Unit Price (Excl.)</th><th>VAT Type</th><th class="tr">Line Total</th><th class="tr">VAT</th><th></th></tr></thead>
      <tbody>
        @for (l of lines(); track $index; let i = $index) {
          <tr>
            <td><select [(ngModel)]="l.type" (ngModelChange)="typeChanged(i)">
              <option value="inv">Inventory</option><option value="non">Non Inventory</option></select></td>
            <td><select [(ngModel)]="l.item" (ngModelChange)="pick(i)">
              <option value="">— Select —</option>
              @if (l.type === 'inv') { @for (it of items(); track it.sku) { <option [value]="it.sku">{{it.sku}} ({{it.avail}} available)</option> } }
              @else { @for (t of nits(); track t.code) { <option [value]="t.code">{{t.name}}</option> } }</select></td>
            <td><input type="number" style="width:80px" min="0" step="any" [(ngModel)]="l.qty" (ngModelChange)="calc()"></td>
            <td><input type="number" style="width:110px" min="0" step="0.01" [(ngModel)]="l.price" (ngModelChange)="calc()"></td>
            <td><select [(ngModel)]="l.vat" (ngModelChange)="calc()">
              <option [ngValue]="15">Standard 15%</option><option [ngValue]="0">Zero-Rated 0%</option><option [ngValue]="'e'">Exempt</option></select></td>
            <td class="tr">{{fmtR(l.lt)}}</td><td class="tr">{{fmtR(l.vt)}}</td>
            <td><button class="btn btn-s btn-sm" type="button" (click)="rm(i)">✕</button></td></tr>
        }
      </tbody></table>
      <button class="btn btn-s btn-sm" style="margin-top:8px" (click)="add()"><i class="ti ti-plus"></i> Add line</button>
      <div style="margin-top:10px;display:flex;justify-content:flex-end">
        <table style="max-width:340px"><tbody>
          <tr><td>Subtotal (Excl. VAT)</td><td class="tr">{{fmtR(tot().ex)}}</td></tr>
          <tr><td>VAT @ 15%</td><td class="tr">{{fmtR(tot().vt)}}</td></tr>
          <tr class="tg"><td>Total (Incl. VAT)</td><td class="tr">{{fmtR(tot().t)}}</td></tr>
        </tbody></table></div>
      <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
      <div class="btn-grp">
        <button class="btn btn-p" (click)="save()" [disabled]="busy()"><i class="ti ti-device-floppy"></i> Save Invoice</button>
        <button class="btn btn-s" (click)="list()">Clear</button></div>
    }
  </div>`,
})
export class CustSiComponent {
  fmtR = fmtR; dayMon = dayMon;
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  auth = inject(AuthStore);

  inv = signal<Si[]>([]); custs = signal<{ code: string; name: string }[]>([]); items = signal<{ sku: string; name: string; sell: number; vat: string; avail: number }[]>([]); nits = signal<{ code: string; name: string; price: number; vat: string }[]>([]);
  newing = signal(false); busy = signal(false); err = signal('');
  lines = signal<{ type: string; item: string; qty: number; price: number; vat: number; lt: number; vt: number }[]>([]);
  f = { customer: '', date: todayIso(), due: dayAdd(todayIso(), 30), ref: '' };

  constructor() { void this.reload(); }
  async reload() {
    const [inv, custs, items, nits] = await Promise.all([
      this.api.get<Si[]>('/sales-invoices'), this.api.get<{ code: string; name: string }[]>('/customers'),
      this.api.get<{ sku: string; name: string; sell: number; vat: string; moves: number; open: number }[]>('/inv/items'),
      this.api.get<{ code: string; name: string; price: number; vat: string }[]>('/sitypes'),
    ]);
    this.inv.set(inv); this.custs.set(custs);
    this.items.set(items.map((i) => ({ ...i, avail: (i.open || 0) + (i.moves || 0) })));
    this.nits.set(nits); this.cdr.detectChanges();
  }
  list() { this.newing.set(false); this.cd(); }
  newInv() {
    this.f = { customer: '', date: todayIso(), due: dayAdd(todayIso(), 30), ref: '' };
    this.err.set(''); this.lines.set([]); this.add();
    this.newing.set(true); this.cd();
  }
  add() { this.lines.update((l) => [...l, { type: 'inv', item: '', qty: 1, price: 0, vat: 15, lt: 0, vt: 0 }]); }
  rm(i: number) { this.lines.update((l) => l.filter((_, j) => j !== i)); this.calc(); }
  typeChanged(i: number) {
    this.lines.update((l) => l.map((x, j) => j === i ? { ...x, item: '', price: 0 } : x));
    this.calc();
  }
  pick(i: number) {
    const l = this.lines()[i];
    let price = 0, vat = 15;
    if (l.type === 'inv') {
      const it = this.items().find((x) => x.sku === l.item);
      if (it) { price = it.sell; vat = it.vat === 'Standard 15%' ? 15 : 0; }
    } else {
      const t = this.nits().find((x) => x.code === l.item);
      if (t) { price = t.price; vat = t.vat === '15' ? 15 : 0; }
    }
    this.lines.update((ls) => ls.map((x, j) => j === i ? { ...x, price, vat } : x));
    this.calc();
  }
  calc() {
    this.lines.update((l) => l.map((x) => {
      const lt = Math.round(x.qty * x.price * 100) / 100;
      return { ...x, lt, vt: Math.round(lt * (x.vat as number > 10 ? (x.vat as number) / 100 : 0) * 100) / 100 };
    }));
    this.cd();
  }
  tot = () => {
    const ex = this.lines().reduce((s, l) => s + l.lt, 0), vt = this.lines().reduce((s, l) => s + l.vt, 0);
    return { ex, vt, t: ex + vt };
  };
  private cd() { this.cdr.detectChanges(); }

  async save() {
    this.err.set('');
    const vatVal = (v: unknown): number => (v === 15 ? 15 : 0); // Exempt posts as zero-rated
    const body = {
      customer: this.f.customer, date: this.f.date, due: this.f.due, ref: this.f.ref,
      lines: this.lines().map((l) => ({ type: l.type, item: l.item, qty: Number(l.qty), price: Number(l.price), vat: vatVal(l.vat) })),
    };
    try {
      const r = await this.api.post<{ id: string }>('/sales-invoices', body);
      this.toast.show('Sales invoice ' + r.id + ' saved.');
      this.newing.set(false); await this.reload();
    } catch (e) { this.err.set((e as ApiError).message); this.cd(); }
  }
}

// ── Credit Notes: list + New Credit Note ──
@Component({
  selector: 'app-cust-cn', imports: [FormsModule],
  template: `
  <div class="card">
    <div class="notice" style="margin-bottom:12px"><i class="ti ti-info-circle"></i> Credit notes must reference the original tax invoice number per s21 of the VAT Act. Output VAT is reduced accordingly.</div>
    <div class="tab-bar" style="margin:0 0 12px">
      <button class="tab" [class.active]="!newing()" (click)="showList()">Credit Note List</button>
      <button class="tab" [class.active]="newing()" (click)="newCn()">New Credit Note</button>
    </div>
    @if (!newing()) {
      <table><thead><tr><th>CN #</th><th>Customer</th><th>Orig. Invoice</th><th>Date</th><th class="tr">Excl. VAT</th><th class="tr">VAT</th><th class="tr">Total</th><th>Reason</th></tr></thead>
      <tbody>
        @for (c of list(); track c.id) {
          <tr><td>{{c.id}}</td><td>{{c.custName}}</td><td>{{c.orig}}</td><td>{{dayMon(c.date)}}</td>
            <td class="tr">{{fmtR(c.ex)}}</td><td class="tr">{{fmtR(c.vatAmt)}}</td><td class="tr">{{fmtR(c.tot)}}</td><td>{{c.reason}}</td></tr>
        } @empty { <tr><td colspan="8" style="text-align:center;color:var(--txm)">No credit notes yet.</td></tr> }
      </tbody></table>
    } @else {
      <div class="fr">
        <div class="fg"><label>Customer *</label><select [(ngModel)]="f.customer">
          <option value="">— Select —</option>
          @for (c of custs(); track c.code) { <option [value]="c.code">{{c.name}}</option> }</select></div>
        <div class="fg"><label>Original Invoice # *</label><input [(ngModel)]="f.orig" maxlength="40" placeholder="e.g. SI-2025-041"></div></div>
      <div class="fr">
        <div class="fg"><label>Credit Note Date *</label><input type="date" [(ngModel)]="f.date"></div>
        <div class="fg"><label>CN Reference #</label><input value="Auto" disabled></div></div>
      <div class="fr">
        <div class="fg"><label>Reason</label><select [(ngModel)]="f.reason">
          <option>Returned Goods</option><option>Pricing Error</option><option>Duplicate Invoice</option><option>Service Not Rendered</option><option>Other</option></select></div></div>
      <table style="margin-top:10px"><thead><tr><th>Description</th><th>Qty</th><th>Unit Price (Excl.)</th><th>VAT</th><th class="tr">Amount</th><th class="tr">VAT Adj.</th></tr></thead>
      <tbody><tr>
        <td><input [(ngModel)]="f.desc" maxlength="120"></td>
        <td><input type="number" style="width:80px" min="0" step="any" [(ngModel)]="f.qty" (ngModelChange)="calc()"></td>
        <td><input type="number" style="width:110px" min="0" step="0.01" [(ngModel)]="f.price" (ngModelChange)="calc()"></td>
        <td><select [(ngModel)]="f.vat"><option>Standard 15%</option><option>Zero-Rated 0%</option><option>Exempt</option></select></td>
        <td class="tr">{{fmtR(ex())}}</td><td class="tr">{{fmtR(vatAmt())}}</td></tr></tbody></table>
      <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
      <div class="btn-grp"><button class="btn btn-p" (click)="save()" [disabled]="busy()"><i class="ti ti-device-floppy"></i> Issue Credit Note</button></div>
    }
  </div>`,
})
export class CustCnComponent {
  fmtR = fmtR; dayMon = dayMon;
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  list = signal<{ id: string; custName: string; orig: string; date: string; ex: number; vatAmt: number; tot: number; reason: string }[]>([]);
  custs = signal<{ code: string; name: string }[]>([]);
  newing = signal(false); busy = signal(false); err = signal('');
  f = { customer: '', orig: '', date: todayIso(), reason: 'Returned Goods', desc: '', qty: 1, price: 0, vat: 'Standard 15%' };

  constructor() { void this.reload(); }
  async reload() {
    const [l, c] = await Promise.all([this.api.get<{ id: string; custName: string; orig: string; date: string; ex: number; vatAmt: number; tot: number; reason: string }[]>('/credit-notes'), this.api.get<{ code: string; name: string }[]>('/customers')]);
    this.list.set(l); this.custs.set(c); this.cdr.detectChanges();
  }
  ex = () => Math.round(Number(this.f.qty) * Number(this.f.price) * 100) / 100;
  vatAmt = () => this.f.vat === 'Standard 15%' ? Math.round(this.ex() * 15) / 100 : 0;
  calc() { this.cdr.detectChanges(); }
  newCn() { this.f = { customer: '', orig: '', date: todayIso(), reason: 'Returned Goods', desc: '', qty: 1, price: 0, vat: 'Standard 15%' }; this.newing.set(true); this.cdr.detectChanges(); }
  showList() { this.newing.set(false); this.cdr.detectChanges(); }
  async save() {
    this.err.set('');
    try {
      const r = await this.api.post<{ id: string }>('/credit-notes', { customer: this.f.customer, orig: this.f.orig, date: this.f.date, reason: this.f.reason, desc: this.f.desc, qty: Number(this.f.qty), price: Number(this.f.price), vat: this.f.vat });
      this.toast.show('Credit note ' + r.id + ' issued.');
      this.newing.set(false); await this.reload();
    } catch (e) { this.err.set((e as ApiError).message); }
  }
}

// ── Receipts (cust-rcpt port; simple receipt, allocation arrives with cashbook batching) ──
@Component({
  selector: 'app-cust-rcpt', imports: [FormsModule],
  template: `
  <div class="card">
    <div class="card-title">Capture Customer Receipt</div>
    <div class="fr">
      <div class="fg"><label>Customer *</label><select [(ngModel)]="f.customer">
        <option value="">— Select —</option>
        @for (c of custs(); track c.code) { <option [value]="c.code">{{c.name}}</option> }</select></div>
      <div class="fg"><label>Receipt #</label><input value="Auto" disabled></div></div>
    <div class="fr3">
      <div class="fg"><label>Receipt Date *</label><input type="date" [(ngModel)]="f.date"></div>
      <div class="fg"><label>Deposit To *</label><select [(ngModel)]="f.bank">
        <option value="">— Select —</option>
        @for (a of banks(); track a.code) { <option [value]="a.code">{{a.code}} — {{a.name}}</option> }</select></div>
      <div class="fg"><label>Method</label><select [(ngModel)]="f.method">
        <option>EFT</option><option>Cash</option><option>Card</option><option>Cheque</option></select></div></div>
    <div class="fr">
      <div class="fg"><label>Amount Received (ZAR) *</label><input type="number" min="0" step="0.01" [(ngModel)]="f.amount"></div>
      <div class="fg"><label>Bank Reference</label><input [(ngModel)]="f.bankRef" maxlength="60" placeholder="Reference on bank statement"></div></div>
    <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
    <div class="btn-grp"><button class="btn btn-p" (click)="save()" [disabled]="busy()"><i class="ti ti-cash"></i> Post Receipt</button></div>
  </div>`,
})
export class CustRcptComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  custs = signal<{ code: string; name: string }[]>([]);
  banks = signal<{ code: string; name: string }[]>([]);
  busy = signal(false); err = signal('');
  f = { customer: '', date: todayIso(), bank: '', method: 'EFT', amount: 0, bankRef: '' };

  constructor() { void this.reload(); }
  async reload() {
    const [c, accs] = await Promise.all([
      this.api.get<{ code: string; name: string }[]>('/customers'),
      this.api.get<{ code: string; name: string; type: string }[]>('/gl/accounts'),
    ]);
    this.custs.set(c);
    this.banks.set(accs.filter((a) => a.type === 'Bank')); // ponytail: bank list by type, cashbook adds the rest later
    this.cdr.detectChanges();
  }
  async save() {
    this.err.set(''); this.busy.set(true);
    try {
      const r = await this.api.post<{ id: string }>('/receipts', { customer: this.f.customer, date: this.f.date, bank: this.f.bank, method: this.f.method, amount: Number(this.f.amount), bankRef: this.f.bankRef });
      this.toast.show('Receipt ' + r.id + ' posted.');
      this.f = { customer: '', date: todayIso(), bank: '', method: 'EFT', amount: 0, bankRef: '' };
    } catch (e) { this.err.set((e as ApiError).message); }
    finally { this.busy.set(false); this.cdr.detectChanges(); }
  }
}

// ── Customer Journals (postSubJnl 'cust' + This Period list) ──
@Component({
  selector: 'app-cust-jnl', imports: [FormsModule],
  template: `
  <div class="notice"><i class="ti ti-info-circle"></i> Customer journals adjust a customer account (interest, write-offs, corrections) and post against control account 6100 — Accounts Receivable and the contra account you choose. Bad-debt write-offs may need an output VAT adjustment (s22 VAT Act).</div>
  <div class="card" style="margin-bottom:16px"><div class="card-title">New Customer Journal</div>
    <div class="fr">
      <div class="fg"><label>Customer *</label><select [(ngModel)]="f.party">
        <option value="">— Select —</option>
        @for (c of custs(); track c.code) { <option [value]="c.code">{{c.name}}</option> }</select></div>
      <div class="fg"><label>Journal Date *</label><input type="date" [(ngModel)]="f.date"></div></div>
    <div class="fr">
      <div class="fg"><label>Journal Ref #</label><input value="Auto (CJ-…)" disabled></div>
      <div class="fg"><label>Adjustment Type *</label><select [(ngModel)]="f.type">
        <option value="inc">Increase balance (debit customer)</option>
        <option value="dec">Decrease balance (credit customer)</option></select></div></div>
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
        <tr><td>6100 — Accounts Receivable</td><td class="tr">{{f.type === 'inc' ? fmtR(num(f.amount)) : ''}}</td><td class="tr">{{f.type === 'dec' ? fmtR(num(f.amount)) : ''}}</td></tr>
        <tr><td>{{contraLabel()}}</td><td class="tr">{{f.type === 'dec' ? fmtR(num(f.amount)) : ''}}</td><td class="tr">{{f.type === 'inc' ? fmtR(num(f.amount)) : ''}}</td></tr>
      </tbody></table>
    } @else { <div style="color:var(--txm)">Enter an amount to preview the posting.</div> }
    <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
    <div class="btn-grp"><button class="btn btn-p" (click)="save()" [disabled]="busy()"><i class="ti ti-book"></i> Post Journal</button>
      <button class="btn btn-s" (click)="reset()">Cancel</button></div>
  </div>
  <div class="card"><div class="card-title">Customer Journals — This Period</div>
    <table><thead><tr><th>Date</th><th>Ref</th><th>Customer</th><th>Narration</th><th>Type</th><th class="tr">Amount</th></tr></thead>
    <tbody>
      @for (j of list(); track j.ref) {
        <tr><td>{{dayMon(j.date)}}</td><td>{{j.ref}}</td><td>{{j.custName}}</td><td>{{j.description}}</td><td>{{j.type}}</td><td class="tr">{{fmtR(j.amount)}}</td></tr>
      } @empty { <tr><td colspan="6" style="color:var(--txm)">No journals posted this period.</td></tr> }
    </tbody></table></div>`,
})
export class CustJnlComponent {
  num = (v: unknown): number => Number(v);
  fmtR = fmtR; dayMon = dayMon;
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  custs = signal<{ code: string; name: string }[]>([]);
  accs = signal<{ code: string; name: string }[]>([]);
  list = signal<{ ref: string; date: string; custName: string; description: string; type: string; amount: number }[]>([]);
  busy = signal(false); err = signal('');
  f = { party: '', date: todayIso(), type: 'inc', amount: 0, contra: '', narration: '' };

  constructor() { void this.reload(); }
  async reload() {
    const [c, a, l] = await Promise.all([
      this.api.get<{ code: string; name: string }[]>('/customers'),
      this.api.get<{ code: string; name: string }[]>('/gl/accounts'),
      this.api.get<{ ref: string; date: string; custName: string; description: string; type: string; amount: number }[]>('/cust-journals').catch(() => []),
    ]);
    this.custs.set(c); this.accs.set(a); this.list.set(l); this.cdr.detectChanges();
  }
  contraLabel = () => { const a = this.accs().find((x) => x.code === this.f.contra); return a ? a.code + ' — ' + a.name : ''; };
  cd() { this.cdr.detectChanges(); }
  reset() { this.f = { party: '', date: todayIso(), type: 'inc', amount: 0, contra: '', narration: '' }; this.err.set(''); this.cd(); }
  async save() {
    this.err.set(''); this.busy.set(true);
    try {
      const r = await this.api.post<{ ref: string }>('/cust-journal', { party: this.f.party, type: this.f.type, contra: this.f.contra, amount: Number(this.f.amount), narration: this.f.narration, date: this.f.date });
      this.toast.show('Customer journal ' + r.ref + ' posted.');
      await this.reload();
    } catch (e) { this.err.set((e as ApiError).message); }
    finally { this.busy.set(false); }
  }
}

// ── Customer Account Enquiry (cust-enq port) ──
@Component({
  selector: 'app-cust-enq', imports: [FormsModule],
  template: `
  <div class="card" style="margin-bottom:12px"><div class="card-title">Customer Account Enquiry</div>
    <div class="fr">
      <div class="fg"><label>Customer</label><select [(ngModel)]="code" (ngModelChange)="load()">
        <option value="">— Select —</option>
        @for (c of custs(); track c.code) { <option [value]="c.code">{{c.name}}</option> }</select></div>
      <div class="fg"><label>From date</label><input type="date" [(ngModel)]="from" (ngModelChange)="load()"></div>
      <div class="fg"><label>To date</label><input type="date" [(ngModel)]="to" (ngModelChange)="load()"></div></div></div>
  @if (d()) {
    <div class="st-r3">
      <div class="stat-card"><div class="stat-lbl">Closing Balance</div><div class="stat-val" style="color:var(--wn)">{{fmtR(dd().closing)}}</div><div class="stat-sub">{{dd().code}}</div></div>
      <div class="stat-card"><div class="stat-lbl">Credit Limit</div><div class="stat-val">{{fmtR(dd().limit)}}</div><div class="stat-sub">Approved limit</div></div>
      <div class="stat-card"><div class="stat-lbl">Available Credit</div><div class="stat-val" style="color:var(--ok)">{{fmtR(dd().limit - closing())}}</div><div class="stat-sub">{{pct()}}% utilised</div></div>
    </div>
    <div class="card"><table><thead><tr><th>Date</th><th>Reference</th><th>Description</th><th class="tr">Debit</th><th class="tr">Credit</th><th class="tr">Balance</th></tr></thead>
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
export class CustEnqComponent {
  fmtR = fmtR; stkDate = stkDate;
  private api = inject(ApiService);
  private cdr = inject(ChangeDetectorRef);
  custs = signal<{ code: string; name: string }[]>([]);
  code = ''; from = ''; to = '';
  private r = signal<{ code: string; name: string; limit: number; opening: number; rows: { date: string; ref: string; desc: string; dr: number; cr: number; bal: number }[]; closing: number; empty: boolean } | null>(null);
  d = () => this.r();
  dd = () => this.r()!;

  constructor() { void this.reload(); }
  async reload() { this.custs.set(await this.api.get<{ code: string; name: string }[]>('/customers')); this.cdr.detectChanges(); }
  closing = () => this.r()?.closing ?? 0;
  pct = () => this.r()?.limit ? Math.max(0, Math.round(this.closing() / this.r()!.limit * 100)) : 0;
  first = () => this.r()?.rows?.[0]?.date ?? '';
  async load() {
    if (!this.code) { this.r.set(null); this.cdr.detectChanges(); return; }
    const qs = this.from || this.to ? '?from=' + this.from + '&to=' + this.to : '';
    this.r.set(await this.api.get('/customers/' + this.code + '/ledger' + qs)); this.cdr.detectChanges();
  }
}

type AgeRes = { asAt: string; rows: { code: string; name: string; buckets: number[]; total: number }[]; tot: number[]; grand: number; pct: number; labels: string[] };
const AGE_NOTE = 'Outstanding balances by age. Payments and credit notes are applied to the oldest documents first, and each remaining document is aged from its date to the “as at” date. Current is 0–30 days.';

// ── Aged Debtors / Creditors (renderAge port, 5 buckets; kind from route data) ──
@Component({
  selector: 'app-aged', imports: [],
  template: `
  <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
    <label style="font-size:12px;color:var(--tx2)">As at&nbsp;<input type="date" style="max-width:150px" (change)="load($any($event.target).value)"></label></div>
  <div class="card"><div class="card-title">{{kind === 'cust' ? 'Aged Debtors' : 'Aged Creditors'}} <span style="font-size:12px;font-weight:400;color:var(--txm)">As at {{stkDate(rd()?.asAt || '')}}</span></div>
    <table><thead><tr><th>{{kind === 'cust' ? 'Customer' : 'Supplier'}}
      @for (l of rd()?.labels ?? []; track l) { <th class="tr">{{l}}</th> }
      <th class="tr">Total</th></tr></thead>
    <tbody>
      @for (r of rd()?.rows ?? []; track r.code) {
        <tr><td>{{r.name || r.code}}</td>
          @for (b of r.buckets; track $index) { <td class="tr" [style.color]="b > 0.004 ? 'var(--wn)' : ''">{{b > 0.004 ? fmtR(b) : '—'}}</td> }
          <td class="tr"><strong>{{fmtR(r.total)}}</strong></td></tr>
      }
      <tr class="tg"><td>Total (agrees to GL {{kind === 'cust' ? '6100' : '9000'}})</td>
        @for (t of rd()?.tot ?? []; track $index) { <td class="tr">{{fmtR(t)}}</td> }
        <td class="tr">{{fmtR(rd()?.grand ?? 0)}}</td></tr>
    </tbody></table>
    <div style="margin-top:10px" class="notice"><i class="ti ti-info-circle"></i> {{AGE_NOTE}} <strong>{{rd()?.pct ?? 0}}% of the balance is older than 30 days.</strong></div>
  </div>`,
})
export class AgedComponent {
  fmtR = fmtR; stkDate = stkDate; AGE_NOTE = AGE_NOTE;
  kind: 'cust' | 'sup';
  private api = inject(ApiService);
  private cdr = inject(ChangeDetectorRef);
  private rs = signal<AgeRes | null>(null);
  res = this.rs.asReadonly;
  rd = () => this.rs();

  constructor() { this.kind = (inject(ActivatedRoute).snapshot.data?.['kind'] ?? 'cust') as 'cust' | 'sup'; this.load(); }
  load(asAt?: string) {
    const a = asAt || this.rs()?.asAt || todayIso();
    void this.api.get<AgeRes>('/age/' + this.kind + '?asAt=' + a).then((r) => {
      this.rs.set(r); this.cdr.detectChanges();
    });
  }
}
