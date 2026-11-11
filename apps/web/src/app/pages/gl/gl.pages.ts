import { Component, ChangeDetectorRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiService, ApiError, ToastService } from '../../core/api';
import { fmtR, stkDate, todayIso } from '../../core/fmt';
import { Acct } from './gl-coa.component';

const r2v = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ── General Journal: list + New Journal Entry (postJnl 2018–2024) ──
interface Jnl { id: string; date: string; ref: string; description: string; src: string; by: string; lines: { acc: string; acc_name: string; description: string; dr: number; cr: number }[]; }

@Component({
  selector: 'app-gl-jnl', imports: [FormsModule],
  template: `
  @if (!newing()) {
    <div class="card">
      <div class="notice"><i class="ti ti-info-circle"></i> IFRS double-entry. Debits must equal credits before posting.</div>
      <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
        <button class="btn btn-p" (click)="newJnl()"><i class="ti ti-plus"></i> New Journal Entry</button></div>
      <table><thead><tr><th>Date</th><th>Ref</th><th>Description</th><th>Account</th><th class="tr">Debit</th><th class="tr">Credit</th><th>Posted By</th></tr></thead>
      <tbody>
        @for (j of list(); track j.id) { @for (l of j.lines; track $index) {
          <tr>
            <td>{{$index === 0 ? dayMon(j.date) : ''}}</td>
            <td>{{$index === 0 ? j.ref : ''}}</td>
            <td>{{$index === 0 ? j.description : ''}}</td>
            <td>{{l.acc}} — {{l.acc_name}}@if (l.description) { · {{l.description}} }</td>
            <td class="tr">{{l.dr ? fmtR(l.dr) : ''}}</td><td class="tr">{{l.cr ? fmtR(l.cr) : ''}}</td>
            <td>{{$index === 0 ? j.by : ''}}</td>
          </tr>
        } }
        @empty { <tr><td colspan="7" style="text-align:center;color:var(--txm)">No journals posted yet.</td></tr> }
      </tbody></table>
    </div>
  } @else {
    <div class="card">
      <div class="card-title">New Journal Entry</div>
      <div class="fr">
        <div class="fg"><label>Journal Date *</label><input type="date" [(ngModel)]="f.date"></div>
        <div class="fg"><label>Journal Ref #</label><input value="Auto (JNL-…)" disabled></div></div>
      <div class="fr">
        <div class="fg"><label>Description *</label><input [(ngModel)]="f.desc" maxlength="200"></div></div>
      <table style="margin-top:10px"><thead><tr><th>Account</th><th>Narration</th><th class="tr">Debit</th><th class="tr">Credit</th></tr></thead>
      <tbody>
        @for (l of lines(); track $index; let i = $index) {
          <tr>
            <td><select style="min-width:220px" [(ngModel)]="l.acc">
              <option value="">— Select —</option>
              @for (a of accs(); track a.code) { <option [value]="a.code">{{a.code}} — {{a.name}}</option> }</select></td>
            <td><input [(ngModel)]="l.nar" maxlength="200"></td>
            <td><input type="number" style="width:120px" min="0" step="0.01" [(ngModel)]="l.dr" (ngModelChange)="calc()"></td>
            <td><input type="number" style="width:120px" min="0" step="0.01" [(ngModel)]="l.cr" (ngModelChange)="calc()"></td>
            <td><button class="btn btn-s btn-sm" type="button" (click)="rm(i)">✕</button></td></tr>
        }
      </tbody></table>
      <button class="btn btn-s btn-sm" style="margin-top:8px" (click)="add()"><i class="ti ti-plus"></i> Add line</button>
      <div style="margin-top:8px;display:flex;justify-content:flex-end">
        <table style="max-width:320px"><tbody>
          <tr><td>Totals</td><td class="tr">{{fmtR(dr())}}</td><td class="tr">{{fmtR(cr())}}</td></tr>
        </tbody></table></div>
      <div style="margin-top:6px" [style.color]="balanced() ? 'var(--txm)' : 'var(--dn)'">
        {{balanced() ? 'Enter debit and credit amounts' : 'Cannot post: debits must equal credits and be greater than zero.'}}</div>
      <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
      <div class="btn-grp"><button class="btn btn-p" (click)="save()" [disabled]="busy()"><i class="ti ti-check"></i> Post Journal</button>
        <button class="btn btn-s" (click)="cancel()">Cancel</button></div>
    </div>
  }`,
})
export class GlJnlComponent {
  fmtR = fmtR; dayMon = stkDate;
  private api = inject(ApiService);
  private router = inject(Router);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  list = signal<Jnl[]>([]);
  accs = signal<Acct[]>([]);
  newing = signal(false); busy = signal(false); err = signal('');
  lines = signal<{ acc: string; nar: string; dr: number; cr: number }[]>([]);
  f = { date: todayIso(), desc: '' };

  constructor() {
    void this.reload();
    if (this.router.url.endsWith('/jnl/new')) this.prepareJnl(); // /gl/jnl/new deep-link = the entry form tab
  }
  async reload() {
    const [l, a] = await Promise.all([this.api.get<Jnl[]>('/gl/journals'), this.api.get<Acct[]>('/gl/accounts')]);
    this.list.set(l); this.accs.set(a); this.cdr.detectChanges();
  }
  add() { this.lines.update((x) => [...x, { acc: '', nar: '', dr: 0, cr: 0 }]); }
  rm(i: number) { this.lines.update((x) => x.filter((_, j) => j !== i)); this.calc(); }
  calc() { this.cdr.detectChanges(); }
  dr = () => this.lines().reduce((s, l) => s + Number(l.dr), 0);
  cr = () => this.lines().reduce((s, l) => s + Number(l.cr), 0);
  balanced = () => Math.abs(this.dr() - this.cr()) < 0.005 && this.dr() > 0;
  prepareJnl() { this.f = { date: todayIso(), desc: '' }; this.lines.set([{ acc: '', nar: '', dr: 0, cr: 0 }, { acc: '', nar: '', dr: 0, cr: 0 }]); this.err.set(''); this.newing.set(true); }
  newJnl() { this.prepareJnl(); this.cdr.detectChanges(); }
  cancel() { this.newing.set(false); this.cdr.detectChanges(); }
  private cd() { this.cdr.detectChanges(); }

  async save() {
    this.err.set('');
    try {
      const r = await this.api.post<{ ref: string }>('/gl/journals', {
        date: this.f.date, desc: this.f.desc,
        lines: this.lines().filter((l) => l.acc).map((l) => ({ acc: l.acc, nar: l.nar, dr: Number(l.dr) || 0, cr: Number(l.cr) || 0 })),
      });
      this.toast.show('Journal ' + r.ref + ' posted.');
      this.newing.set(false); await this.reload();
    } catch (e) { this.err.set((e as ApiError).message); this.cd(); }
  }
}

// ── Journal Batches (saveBatch + postOpen, persisted status) ──
interface Batch { id: string; ref: string; date: string; description: string; status: string; lines: number; dr: number; cr: number; }

@Component({
  selector: 'app-gl-jbatch', imports: [FormsModule],
  template: `
  @if (!newing()) {
    <div class="card">
      <div class="notice"><i class="ti ti-info-circle"></i> IFRS double-entry. Debits must equal credits before posting.</div>
      <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
        <button class="btn btn-p" (click)="newBatch()"><i class="ti ti-plus"></i> New Journal Batch</button></div>
      <table><thead><tr><th>Batch Ref</th><th>Date</th><th>Description</th><th class="tr">Lines</th><th class="tr">Total Debits</th><th>Status</th><th style="width:120px">Action</th></tr></thead>
      <tbody>
        @for (b of list(); track b.id) {
          <tr><td>{{b.ref}}</td><td>{{dayMon(b.date)}}</td><td>{{b.description}}</td><td class="tr">{{b.lines}}</td><td class="tr">{{fmtR(b.dr)}}</td>
            <td><span class="chip" [class.c-ok]="b.status === 'Posted'" [class.c-wn]="b.status !== 'Posted'">{{b.status}}</span></td>
            <td>@if (b.status === 'Open') { <button class="btn btn-s btn-sm" (click)="post(b)">Post</button> }</td></tr>
        } @empty { <tr><td colspan="7" style="text-align:center;color:var(--txm)">No batches yet.</td></tr> }
      </tbody></table>
      <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
    </div>
  } @else {
    <div class="card">
      <div class="card-title">New General Ledger Journal Batch</div>
      <div class="fr">
        <div class="fg"><label>Batch Ref</label><input value="Auto (GJB-…)" disabled></div>
        <div class="fg"><label>Batch Date *</label><input type="date" [(ngModel)]="f.date"></div></div>
      <div class="fr">
        <div class="fg"><label>Description *</label><input [(ngModel)]="f.desc" maxlength="200" placeholder="e.g. March month-end adjustments"></div></div>
      <table style="margin-top:10px"><thead><tr><th>Account</th><th>Narration</th><th class="tr">Debit</th><th class="tr">Credit</th></tr></thead>
      <tbody>
        @for (l of lines(); track $index; let i = $index) {
          <tr>
            <td><select style="min-width:220px" [(ngModel)]="l.acc">
              <option value="">— Select —</option>
              @for (a of accs(); track a.code) { <option [value]="a.code">{{a.code}} — {{a.name}}</option> }</select></td>
            <td><input [(ngModel)]="l.nar" maxlength="200"></td>
            <td><input type="number" style="width:120px" min="0" step="0.01" [(ngModel)]="l.dr" (ngModelChange)="calc()"></td>
            <td><input type="number" style="width:120px" min="0" step="0.01" [(ngModel)]="l.cr" (ngModelChange)="calc()"></td>
            <td><button class="btn btn-s btn-sm" type="button" (click)="rm(i)">✕</button></td></tr>
        }
      </tbody></table>
      <button class="btn btn-s btn-sm" style="margin-top:8px" (click)="add()"><i class="ti ti-plus"></i> Add line</button>
      <div style="margin-top:8px;display:flex;justify-content:flex-end">
        <table style="max-width:320px"><tbody>
          <tr><td>Totals</td><td class="tr">{{fmtR(dr())}}</td><td class="tr">{{fmtR(cr())}}</td></tr>
        </tbody></table></div>
      <div style="margin-top:6px" [style.color]="balanced() ? 'var(--txm)' : 'var(--dn)'">
        {{balanced() ? 'Ready to post' : 'Debits and credits are out of balance — Save as Open to keep working on it.'}}</div>
      <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
      <div class="btn-grp"><button class="btn btn-p" (click)="save('Posted')" [disabled]="busy()"><i class="ti ti-check"></i> Post Batch</button>
        <button class="btn btn-s" (click)="save('Open')" [disabled]="busy()"><i class="ti ti-inbox"></i> Save as Open</button>
        <button class="btn btn-s" (click)="cancel()">Cancel</button></div>
    </div>
  }`,
})
export class GlJbatchComponent {
  fmtR = fmtR; dayMon = stkDate;
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  list = signal<Batch[]>([]);
  accs = signal<Acct[]>([]);
  newing = signal(false); busy = signal(false); err = signal('');
  lines = signal<{ acc: string; nar: string; dr: number; cr: number }[]>([]);
  f = { date: todayIso(), desc: '' };

  constructor() { void this.reload(); }
  async reload() {
    const [l, a] = await Promise.all([this.api.get<Batch[]>('/gl/batches'), this.api.get<Acct[]>('/gl/accounts')]);
    this.list.set(l); this.accs.set(a); this.cdr.detectChanges();
  }
  add() { this.lines.update((x) => [...x, { acc: '', nar: '', dr: 0, cr: 0 }]); }
  rm(i: number) { this.lines.update((x) => x.filter((_, j) => j !== i)); this.calc(); }
  calc() { this.cdr.detectChanges(); }
  dr = () => this.lines().reduce((s, l) => s + Number(l.dr), 0);
  cr = () => this.lines().reduce((s, l) => s + Number(l.cr), 0);
  balanced = () => Math.abs(this.dr() - this.cr()) < 0.005 && this.dr() > 0;
  newBatch() { this.f = { date: todayIso(), desc: '' }; this.lines.set([{ acc: '', nar: '', dr: 0, cr: 0 }, { acc: '', nar: '', dr: 0, cr: 0 }]); this.err.set(''); this.newing.set(true); this.cdr.detectChanges(); }
  cancel() { this.newing.set(false); this.cdr.detectChanges(); }

  async save(status: 'Posted' | 'Open') {
    this.err.set('');
    try {
      const r = await this.api.post<{ ref: string }>('/gl/batches', {
        date: this.f.date, desc: this.f.desc, status,
        lines: this.lines().filter((l) => l.acc).map((l) => ({ acc: l.acc, nar: l.nar, dr: Number(l.dr) || 0, cr: Number(l.cr) || 0 })),
      });
      this.toast.show('Batch ' + r.ref + (status === 'Posted' ? ' posted.' : ' saved open.'));
      this.newing.set(false); await this.reload();
    } catch (e) { this.err.set((e as ApiError).message); this.cdr.detectChanges(); }
  }
  async post(b: Batch) {
    this.err.set('');
    try { await this.api.patch('/gl/batches/' + b.id + '/post', {}); this.toast.show('Batch ' + b.ref + ' posted.'); await this.reload(); }
    catch (e) { this.err.set((e as ApiError).message); this.cdr.detectChanges(); }
  }
}

// ── General Ledger Account Enquiry (glEnqSync + renderEnq) ──
@Component({
  selector: 'app-gl-enq', imports: [FormsModule],
  template: `
  <div class="card" style="margin-bottom:12px"><div class="card-title">General Ledger Account Enquiry</div>
    <div class="fr">
      <div class="fg"><label>Account</label><select [(ngModel)]="code" (ngModelChange)="load()">
        <option value="">— Select —</option>
        @for (a of accs(); track a.code) { <option [value]="a.code">{{a.code}} — {{a.name}}</option> }</select></div>
      <div class="fg"><label>From date</label><input type="date" [(ngModel)]="from" (ngModelChange)="load()"></div>
      <div class="fg"><label>To date</label><input type="date" [(ngModel)]="to" (ngModelChange)="load()"></div></div></div>
  @if (dateErr()) { <div class="card" style="color:var(--dn)">The To date cannot be before the From date.</div> }
  @if (d() && !dateErr()) {
    <div class="st-r3">
      <div class="stat-card"><div class="stat-lbl">Opening Balance</div><div class="stat-val">{{fmtR(dd().opening)}}</div><div class="stat-sub">Start of period</div></div>
      <div class="stat-card"><div class="stat-lbl">Movement</div><div class="stat-val">{{fmtR(mvAmt())}}</div><div class="stat-sub">{{mvLabel()}}</div></div>
      <div class="stat-card"><div class="stat-lbl">Closing Balance</div><div class="stat-val" style="color:var(--wn)">{{fmtR(closing())}}</div><div class="stat-sub">{{balLabel()}}</div></div>
    </div>
    <div class="card"><table><thead><tr><th>Date</th><th>Reference</th><th>Description</th><th class="tr">Debit</th><th class="tr">Credit</th><th class="tr">Balance</th></tr></thead>
    <tbody>
      @if (!from) { <tr><td>{{stkDate(first())}}</td><td>Opening Balance</td><td></td><td></td><td></td><td class="tr">{{fmtR(dd().opening)}}</td></tr> }
      @for (r of dd().rows; track $index) {
        <tr><td>{{stkDate(r.date)}}</td><td>{{r.ref}}</td><td>{{r.desc}}</td>
          <td class="tr">{{r.dr ? fmtR(r.dr) : ''}}</td><td class="tr">{{r.cr ? fmtR(r.cr) : ''}}</td><td class="tr">{{fmtR(r.bal)}}</td></tr>
      }
      @if (dd().rows.length === 0) { <tr><td colspan="6" style="text-align:center;color:var(--txm)">No transactions this period.</td></tr> }
      <tr class="tg"><td colspan="5">Closing Balance</td><td class="tr">{{fmtR(closing())}}</td></tr>
    </tbody></table></div>
  }`,
})
export class GlEnqComponent {
  fmtR = fmtR; stkDate = stkDate;
  private api = inject(ApiService);
  private cdr = inject(ChangeDetectorRef);
  accs = signal<Acct[]>([]);
  code = ''; from = ''; to = '';
  private r = signal<{ code: string; name: string; open: number; side: string; opening: number; rows: { date: string; ref: string; desc: string; dr: number; cr: number; bal: number }[]; closing: number } | null>(null);
  d = () => this.r();
  dd = () => this.r()!;

  constructor() { void this.reload(); }
  async reload() { this.accs.set(await this.api.get<Acct[]>('/gl/accounts')); this.cdr.detectChanges(); }
  closing = () => this.r()?.closing ?? 0;
  first = () => this.r()?.rows?.[0]?.date ?? '';
  dateErr = () => !!this.from && !!this.to && this.to < this.from;
  diff = () => (this.r() ? this.closing() - this.r()!.opening : 0);
  mvAmt = () => Math.abs(this.closing() - (this.r()?.opening ?? 0));
  mvLabel = () => {
    const s = this.r()?.side === 'dr';
    const pos = this.diff() >= 0;
    return pos ? (s ? 'Net debit movement' : 'Net credit movement') : (s ? 'Net credit movement' : 'Net debit movement');
  };
  balLabel = () => {
    const dr = this.r()?.side === 'dr';
    return this.closing() >= 0 ? (dr ? 'Debit balance' : 'Credit balance') : (dr ? 'Credit balance' : 'Debit balance');
  };
  async load() {
    if (this.dateErr() || !this.code) { this.r.set(null); this.cdr.detectChanges(); return; }
    const qs = this.from || this.to ? '?from=' + this.from + '&to=' + this.to : '';
    this.r.set(await this.api.get('/gl/accounts/' + this.code + '/ledger' + qs)); this.cdr.detectChanges();
  }
}

// ── Journal Enquiry (filterJ — flat line listing) ──
@Component({
  selector: 'app-gl-jenq', imports: [FormsModule],
  template: `
  <div class="card">
    <div class="card-title">Journal Enquiry</div>
    <div class="fr">
      <div class="fg"><label>From date</label><input type="date" [(ngModel)]="from" (ngModelChange)="reload()"></div>
      <div class="fg"><label>To date</label><input type="date" [(ngModel)]="to" (ngModelChange)="reload()"></div>
      <div class="fg"><label>Search reference or description</label><input placeholder="e.g. payroll, JNL-088" [(ngModel)]="q"></div></div>
    <table><thead><tr><th>Date</th><th>Ref</th><th>Description</th><th>Account</th><th class="tr">Debit</th><th class="tr">Credit</th></tr></thead>
    <tbody>
      @for (r of filtered(); track $index) {
        <tr><td>{{dayMon(r.date)}}</td><td>{{r.ref}}</td><td>{{r.description}}@if (r.nar) { · {{r.nar}} }</td>
          <td>{{r.acc}} — {{r.acc_name}}</td><td class="tr">{{r.dr ? fmtR(r.dr) : ''}}</td><td class="tr">{{r.cr ? fmtR(r.cr) : ''}}</td></tr>
      } @empty { <tr><td colspan="6" style="text-align:center;color:var(--txm)">No posted journal lines match.</td></tr> }
    </tbody></table>
  </div>`,
})
export class GlJenqComponent {
  fmtR = fmtR; dayMon = stkDate;
  private api = inject(ApiService);
  private cdr = inject(ChangeDetectorRef);
  rows = signal<{ date: string; ref: string; description: string; nar: string; acc: string; acc_name: string; dr: number; cr: number }[]>([]);
  q = ''; from = ''; to = '';

  constructor() { void this.reload(); }
  async reload() {
    const qs = '?from=' + this.from + '&to=' + this.to;
    this.rows.set(await this.api.get('/gl/journal-lines' + qs)); this.cdr.detectChanges();
  }
  filtered = () => { // ponytail: plain accessor — computed would cache on q (untracked plain prop) and never re-filter
    const s = this.q.toLowerCase();
    return this.rows().filter((r) => !s || (r.ref + ' ' + r.description + ' ' + r.nar).toLowerCase().includes(s));
  };
}
