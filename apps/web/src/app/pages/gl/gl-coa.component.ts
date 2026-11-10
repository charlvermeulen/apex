import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, ApiError, ToastService } from '../../core/api';
import { COA_GROUPS, COA_TYPES, coaGroup, isIS } from '@numera/shared';

export interface Acct {
  code: string; name: string; type: string; vat_rate: string;
  opening_balance: number; active: boolean; is_system: boolean; due: boolean;
}

// Chart of Accounts — renderCOA/openAcct/saveAcct port (legacy 4657–4698).
@Component({
  selector: 'app-gl-coa',
  imports: [FormsModule],
  template: `
  <div class="page-title">Chart of Accounts</div>
  <div class="page-sub">General Ledger · Maintenance</div>
  <div class="card">
    <div class="card-title">Accounts
      <button class="btn btn-p btn-sm" (click)="openEdit(null)"><i class="ti ti-plus"></i> Add Account</button></div>

    @if (editing()) { <div class="card" style="margin:0 0 14px;border-color:var(--ac)">
      <div class="card-title">{{editCode() ? 'Edit Account ' + editCode() : 'Add General Ledger Account'}}</div>
      <div class="fr">
        <div class="fg"><label>Code *</label><input [(ngModel)]="f.code" [disabled]="codeLocked()" (ngModelChange)="catChanged()"></div>
        <div class="fg"><label>Category</label><input [value]="cat()" disabled></div></div>
      <div class="fr">
        <div class="fg"><label>Account name *</label><input [(ngModel)]="f.name" maxlength="60"></div>
        <div class="fg"><label>Type *</label><select [(ngModel)]="f.type">
          @for (t of typeOptions(); track t) { <option [value]="t">{{t}}</option> }</select></div></div>
      <div class="fr">
        <div class="fg"><label>VAT indicator</label><select [(ngModel)]="f.vat_rate">
          <option>—</option><option>01</option><option>02</option></select></div>
        <div class="fg"><label>Opening balance</label><input type="number" [(ngModel)]="f.opening_balance"
          [disabled]="!!editCode()" [placeholder]="editCode() ? 'Balance comes from postings' : '0.00'"></div></div>
      <div class="fr">
        <div class="fg"><label>Status</label><select [(ngModel)]="f.active" [disabled]="sys()">
          <option [ngValue]="true">Active</option><option [ngValue]="false">Inactive</option></select></div></div>
      <div class="form-err" [style.display]="note()||err() ? 'block':'none'">{{note() || err()}}</div>
      <div class="btn-grp">
        <button class="btn btn-p" (click)="save()"><i class="ti ti-device-floppy"></i> Save Account</button>
        <button class="btn btn-s" (click)="editing.set(false)">Cancel</button></div>
    </div> }

    <table><thead><tr>
      <th style="width:70px">Code</th><th>Account</th><th>Type</th><th>VAT</th><th class="tr" style="width:120px">Balance</th>
      <th style="width:100px">Status</th><th style="width:250px">Actions</th></tr></thead>
    <tbody>
      @for (g of groups(); track g.name) {
        <tr class="ts"><td colspan="7">{{g.code}}s — {{g.name}}{{g.is < 5 ? ' (Income Statement)' : ' (Balance Sheet)'}}</td></tr>
        @for (a of g.rows; track a.code) {
          <tr>
            <td>{{a.code}}</td><td>{{a.name}}</td><td>{{a.type}}</td><td>{{a.vat_rate}}</td>
            <td class="tr">{{bal(a)}}</td>
            <td><span class="chip" [class.c-ok]="a.active && !a.due" [class.c-wn]="a.active && a.due" [class.c-nt]="!a.active">{{!a.active ? 'Inactive' : a.due ? 'Due' : 'Active'}}</span></td>
            <td>
              <button class="btn btn-s btn-sm" (click)="openEdit(a)">Edit</button>
              @if (!a.is_system) { <button class="btn btn-s btn-sm" (click)="toggle(a)">{{a.active ? 'Deactivate' : 'Activate'}}</button> }
              @if (canDelete(a)) { <button class="btn btn-s btn-sm" (click)="del(a)">Delete</button> }
            </td>
          </tr>
        }
      }
      @empty { <tr><td colspan="7" style="color:var(--txm)">No accounts yet.</td></tr> }
    </tbody></table>
  </div>`,
})
export class GlCoaComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  list = signal<Acct[]>([]);
  editing = signal<boolean>(false);
  editCode = signal<string | null>(null);
  f: { code: string; name: string; type: string; vat_rate: string; opening_balance: number; active: boolean } =
    { code: '', name: '', type: '', vat_rate: '—', opening_balance: 0, active: true };
  note = signal(''); err = signal('');

  constructor() { void this.reload(); }
  async reload() { this.list.set(await this.api.get<Acct[]>('/accounts')); }

  // group rows by first digit — renderCOA 4659
  groups = computed(() => COA_GROUPS.map((g, gi) => ({
    name: g.name, is: gi + 1, code: gi + 1,
    rows: this.list().filter((a) => +a.code[0] === gi + 1).sort((x, y) => (x.code < y.code ? -1 : 1)),
  })).filter((g) => g.rows.length));

  sys = () => { const s = this.editCode(); return !!s && s !== this.f.code && this.list().some((a) => a.code === this.editCode() && a.is_system); };
  origSys = () => !!this.editCode() && !!this.list().find((a) => a.code === this.editCode())?.is_system;

  cat = () => { const c = String(this.f.code); const g = coaGroup(c); return g ? g.name + (+c < 5 ? ' — Income Statement' : ' — Balance Sheet') : ''; };
  catChanged() {
    const d = +String(this.f.code)[0] || 0;
    this.f.type = COA_TYPES[d - 1]?.includes(String(this.f.type)) ? String(this.f.type) : (COA_TYPES[d - 1]?.[0] ?? '');
  }
  typeOptions = () => { const d = +String(this.f.code)[0] || 0; return COA_TYPES[d - 1] ?? []; };

  codeLocked = computed(() => {
    const e = this.editCode();
    if (!e) return false;
    return this.origSys();
  });

  openEdit(a: Acct | null) {
    this.editing.set(true);
    this.editCode.set(a ? a.code : null);
    this.f = a ? { code: a.code, name: a.name, type: a.type, vat_rate: a.vat_rate, opening_balance: a.opening_balance, active: a.active } : { code: '', name: '', type: '', vat_rate: '—', opening_balance: 0, active: true };
    this.note.set(this.origSys() ? 'This is a system account used by postings, so its code cannot change and it cannot be deactivated. You can still rename it.' : '');
    this.err.set('');
  }

  async save() {
    this.err.set('');
    const name = String(this.f.name).replace(/\s+/g, ' ').trim();
    try {
      if (this.editCode()) {
        await this.api.patch('/accounts/' + this.editCode(), { name, type: this.f.type, vat_rate: this.f.vat_rate, active: this.f.active });
      } else {
        await this.api.post('/accounts', { code: String(this.f.code), name, type: this.f.type, vat_rate: this.f.vat_rate, opening_balance: Number(this.f.opening_balance) || 0 });
      }
      this.editing.set(false);
      await this.reload();
      this.toast.show('Account ' + this.f.code + ' saved.');
    } catch (e) { this.err.set((e as ApiError).message); }
  }

  async toggle(a: Acct) {
    try { await this.api.patch('/accounts/' + a.code, { active: !a.active }); await this.reload(); }
    catch (e) { this.toast.show((e as ApiError).message); }
  }

  async del(a: Acct) {
    if (!confirm('Delete account ' + a.code + ' — ' + a.name + '?')) return;
    try { await this.api.del('/accounts/' + a.code); await this.reload(); this.toast.show('Account deleted.'); }
    catch (e) { this.toast.show((e as ApiError).message); }
  }

  canDelete = (a: Acct) => !a.is_system && Number(a.opening_balance) === 0;
  bal = (a: Acct) => {
    const v = Number(a.opening_balance);
    return v < 0 ? '(' + Math.abs(v).toLocaleString('en-ZA', { minimumFractionDigits: 2 }) + ')' : v.toLocaleString('en-ZA', { minimumFractionDigits: 2 });
  };
}
