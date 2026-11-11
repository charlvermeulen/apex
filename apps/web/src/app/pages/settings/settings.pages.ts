import { Component, ChangeDetectorRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { ApiService, ApiError, ToastService } from '../../core/api';
import { AuthStore, CompanyInfo } from '../../core/auth.store';
import { fmtR } from '../../core/fmt';
import { MODSEC, SECN, ROLES, ACCESS, MODS, Role } from '@numera/shared';

// Settings parent: two-level tab nav mirroring SECN (2537). Deferred tabs show as disabled pills.
@Component({
  selector: 'app-settings',
  imports: [RouterOutlet, RouterLink],
  template: `
  <div class="page-title">Settings</div>
  <div class="page-sub">Company, users &amp; security</div>
  <div class="tab-bar">
    @for (tab of allowed(); track tab.key) {
      @if (tab.ready) {
        <a class="tab" [routerLink]="tab.path" routerLinkActive="active">{{SECN[tab.sec]}}</a>
      } @else {
        <span class="tab" style="opacity:.4;cursor:not-allowed" [title]="tab.ready ? '' : 'Arrives in a later batch'">{{SECN[tab.sec]}}</span>
      }
    }
  </div>
  <router-outlet />`,
})
export class SettingsComponent {
  SECN = SECN;
  private auth = inject(AuthStore);
  tabs = [
    { key: 'company', sec: 'company', path: '/settings/company', ready: true },
    { key: 'years', sec: 'years', path: '/settings/years', ready: true },
    { key: 'companies', sec: 'companies', path: '/settings/companies', ready: true },
    { key: 'users', sec: 'users', path: '/settings/users', ready: true },
    { key: 'roles', sec: 'roles', path: '/settings/roles', ready: true },
    { key: 'email', sec: 'email', path: '/settings/email', ready: true },
    { key: 'log', sec: 'log', path: '/settings/log', ready: true },
    { key: 'ctypes', sec: 'ctypes', path: '', ready: false },
    { key: 'sitypes', sec: 'sitypes', path: '/settings/sitypes', ready: true },
    { key: 'svctypes', sec: 'svctypes', path: '', ready: false },
    { key: 'employees', sec: 'employees', path: '', ready: false },
  ];
  allowed = () => this.tabs.filter((t) => this.auth.canSec()('settings', t.sec));
}

// Company & Tax (set-company port). Tax configuration mirrors the legacy static selects.
@Component({
  selector: 'app-settings-company',
  imports: [FormsModule],
  template: `
  <div class="card" style="margin-bottom:16px"><div class="card-title">Company Details</div>
    <div class="fr">
      <div class="fg"><label>Company Name *</label><input [(ngModel)]="f.name" maxlength="80"></div>
      <div class="fg"><label>CIPC Reg. Number</label><input [(ngModel)]="f.reg"></div></div>
    <div class="fr">
      <div class="fg"><label>VAT Registration Number</label><input [(ngModel)]="f.vat_no"></div>
      <div class="fg"><label>Income Tax Number</label><input [(ngModel)]="f.itax"></div></div>
    <div class="fr">
      <div class="fg"><label>PAYE Reference (EMP)</label><input [(ngModel)]="f.paye_ref"></div>
      <div class="fg"><label>SDL Reference</label><input [(ngModel)]="f.sdl_ref"></div></div>
    <div class="fr">
      <div class="fg"><label>Physical Address</label><input [(ngModel)]="f.addr"></div>
      <div class="fg"><label>Postal Address</label><input [(ngModel)]="f.post" placeholder="Same as physical if blank"></div></div>
    <div class="form-err" [style.display]="err()?'block':'none'">{{err()}}</div>
  </div>
  <div class="card" style="margin-bottom:16px"><div class="card-title">Tax Configuration</div>
    <div class="fr3">
      <div class="fg"><label>Financial Year End</label><select><option>28 February</option><option selected>31 March</option><option>30 June</option><option>31 December</option></select></div>
      <div class="fg"><label>VAT Category</label><select><option selected>B — Bi-monthly</option><option>A — Monthly</option><option>C — 6-month</option></select></div>
      <div class="fg"><label>Provisional Tax</label><select><option selected>Yes — Company</option><option>No</option></select></div></div>
    <div class="fr3">
      <div class="fg"><label>Accounting Basis</label><select><option selected>Accrual (Invoice)</option><option>Cash Basis</option></select></div>
      <div class="fg"><label>Currency</label><select><option selected>ZAR — South African Rand</option></select></div>
      <div class="fg"><label>SBC Entity?</label><select><option selected>No</option><option>Yes — s12E</option></select></div></div>
  </div>
  <div class="card"><div class="card-title">SARS eFiling</div>
    <div class="rr"><div><div class="rr-name">eFiling Connectivity</div><div class="rr-desc">Auto-submit VAT201, EMP201</div></div><span class="chip c-ok">Connected</span></div>
    <div class="rr"><div><div class="rr-name">Tax Clearance Certificate</div></div><span class="chip c-ok">Valid</span></div>
    <div class="rr" style="border:none"><div><div class="rr-name">Bank Verification (BVS)</div></div><span class="chip c-ok">Verified</span></div>
  </div>
  <div class="btn-grp">
    <button class="btn btn-p" (click)="save()" [disabled]="busy()"><i class="ti ti-device-floppy"></i> Save Settings</button>
    <button class="btn btn-s" (click)="load()">Reset</button>
  </div>`,
})
export class CompanyTaxComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  auth = inject(AuthStore);

  f: { name: string; reg: string; vat_no: string; itax: string; paye_ref: string; sdl_ref: string; addr: string; post: string } =
    { name: '', reg: '', vat_no: '', itax: '', paye_ref: '', sdl_ref: '', addr: '', post: '' };
  busy = signal(false); err = signal('');

  constructor() { this.load0(); }
  async load0() {
    const id = this.auth.company()?.id;
    if (!id) return;
    const c = await this.api.get<CompanyInfo & { itax?: string | null; paye_ref?: string | null; sdl_ref?: string | null; addr?: string | null; post?: string | null }>('/companies/profile/' + id);
    this.f = { name: c.name, reg: c.reg || '', vat_no: c.vat_no || '', itax: c.itax || '', paye_ref: c.paye_ref || '', sdl_ref: c.sdl_ref || '', addr: c.addr || '', post: c.post || '' };
    this.cdr.detectChanges(); // zoneless: async assignment needs a manual pass
  }
  load() { void this.load0(); }

  async save() {
    this.busy.set(true); this.err.set('');
    try {
      const c = await this.api.put<CompanyInfo>('/companies/profile/' + this.auth.company()!.id, { name: this.f.name, reg: this.f.reg, vat_no: this.f.vat_no, itax: this.f.itax, paye_ref: this.f.paye_ref, sdl_ref: this.f.sdl_ref, addr: this.f.addr, post: this.f.post });
      this.auth.company.update((x) => (x ? { ...x, name: c.name } : x));
      this.toast.show('Company settings saved.');
    } catch (e) { this.err.set((e as ApiError).message); }
    finally { this.busy.set(false); }
  }
}

interface FY { id: string; name: string; start: string; end_date: string; status: string; is_current: boolean; closed_at?: string; history: { t: number; user: string; action: string; note: string }[]; }

// Financial years (set-years port). Income/Expenses/Net Profit read '—' until the report batch.
@Component({
  selector: 'app-settings-years',
  imports: [FormsModule],
  template: `
  <div class="notice"><i class="ti ti-info-circle"></i> <div>Postings are only allowed in an <strong>open</strong> financial year. Close years in order, oldest first. Closing posts a year-end journal that moves the year's net profit to Retained Earnings (GL 7010). Only administrators can reopen a closed year.</div></div>
  <div class="card"><div class="card-title">Financial Years <button class="btn btn-p btn-sm" (click)="addOpen.set(!addOpen())"><i class="ti ti-plus"></i> Add Financial Year</button></div>
    @if (addOpen()) {
      <div class="fr3">
        <div class="fg"><label>Year name *</label><input [(ngModel)]="nf.name" placeholder="e.g. FY 2026/27"></div>
        <div class="fg"><label>Start date *</label><input type="date" [(ngModel)]="nf.start"></div>
        <div class="fg"><label>End date *</label><input type="date" [(ngModel)]="nf.end"></div></div>
      <div class="form-err" [style.display]="err()?'block':'none'">{{err()}}</div>
      <div class="btn-grp" style="margin-top:14px">
        <button class="btn btn-p" (click)="add()"><i class="ti ti-plus"></i> Add Year</button>
        <button class="btn btn-s" (click)="addOpen.set(false)">Cancel</button></div>
    }
    <table style="margin-top:14px">
      <thead><tr><th>Year</th><th>Period</th><th>Status</th><th class="tr">Income</th><th class="tr">Expenses</th><th class="tr">Net Profit</th><th style="width:290px">Actions</th></tr></thead>
      <tbody>
        @for (fy of fys(); track fy.id) {
          <tr>
            <td>{{fy.name}} @if (fy.is_current) { <span class="chip c-bl">Current</span> }</td>
            <td>{{d(fy.start)}} – {{d(fy.end_date)}}</td>
            <td><span class="chip" [class.c-ok]="fy.status==='open'" [class.c-gr]="fy.status==='closed'">{{fy.status==='open'?'Open':'Closed'}}</span></td>
            <td class="tr">—</td><td class="tr">—</td><td class="tr">—</td>
            <td>
              @if (fy.status === 'open') {
                <button class="btn btn-s btn-sm" (click)="close(fy)"><i class="ti ti-lock"></i> Close</button>
                @if (!fy.is_current) { <button class="btn btn-s btn-sm" (click)="setCurrent(fy)">Set current</button> }
                <button class="btn btn-s btn-sm" (click)="del(fy)"><i class="ti ti-trash"></i></button>
              } @else {
                <button class="btn btn-s btn-sm" (click)="reopenOpen.set(fy)"><i class="ti ti-lock-open"></i> Reopen</button>
              }
            </td>
          </tr>
          @if (reopenOpen() === fy) {
            <tr><td colspan="7">
              <div class="card" style="margin:0"><div class="card-title">Reopen {{fy.name}}</div>
                <div class="fg"><label>Reason (at least 5 characters) *</label><input [(ngModel)]="reopenReason" placeholder="e.g. Late supplier invoice for March was captured today"></div>
                <div class="form-err" [style.display]="err()?'block':'none'">{{err()}}</div>
                <div class="btn-grp"><button class="btn btn-p" (click)="reopen(fy)">Reopen year</button>
                <button class="btn btn-s" (click)="reopenOpen.set(null)">Cancel</button></div></div>
            </td></tr>
          }
        }
      </tbody>
    </table>
  </div>`,
})
export class YearsComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  fys = signal<FY[]>([]);
  addOpen = signal(false); reopenOpen = signal<FY | null>(null);
  nf = { name: '', start: '', end: '' };
  reopenReason = ''; busy = signal(false); err = signal('');

  constructor() { void this.reload(); }
  async reload() {
    this.fys.set(await this.api.get<FY[]>('/fys'));
    this.err.set('');
  }

  async add() {
    this.busy.set(true); this.err.set('');
    try {
      await this.api.post('/fys', this.nf);
      this.addOpen.set(false); this.nf = { name: '', start: '', end: '' };
      await this.reload();
      this.toast.show('Financial year added.');
    } catch (e) { this.err.set((e as ApiError).message); }
    finally { this.busy.set(false); }
  }

  async close(fy: FY) {
    this.busy.set(true);
    try {
      await this.api.post('/fys/' + fy.id + '/close');
      await this.reload();
      this.toast.show(fy.name + ' closed.');
    } catch (e) { this.toast.show((e as ApiError).message); }
    finally { this.busy.set(false); }
  }

  async reopen(fy: FY) {
    this.busy.set(true); this.err.set('');
    try {
      await this.api.post('/fys/' + fy.id + '/reopen', { reason: this.reopenReason });
      this.reopenOpen.set(null); this.reopenReason = '';
      await this.reload();
      this.toast.show(fy.name + ' reopened.');
    } catch (e) { this.err.set((e as ApiError).message); }
    finally { this.busy.set(false); }
  }

  async setCurrent(fy: FY) {
    try { await this.api.post('/fys/' + fy.id + '/set-current'); await this.reload(); }
    catch (e) { this.toast.show((e as ApiError).message); }
  }

  async del(fy: FY) {
    if (!confirm('Delete ' + fy.name + '?')) return;
    try { await this.api.del('/fys/' + fy.id); await this.reload(); }
    catch (e) { this.toast.show((e as ApiError).message); }
  }

  d = (iso: string) => String(iso).slice(0, 10);
}

interface Usr { id: string; name: string; username: string; email: string; role: Role; status: string; must_change: boolean; locked_until?: string; last_login?: string; access_overrides?: Record<string, string> | null; }

// Users (set-users port) + add/edit modal + password generator.
@Component({
  selector: 'app-settings-users',
  imports: [FormsModule],
  template: `
  <div class="card"><div class="card-title">User Accounts <span style="display:flex;gap:10px;align-items:center">
    <button class="btn btn-p btn-sm" (click)="openAdd()"><i class="ti ti-user-plus"></i> Add User</button></span></div>
    @if (editing()) { <div class="card" style="margin:0 0 14px;border-color:var(--ac)">
      <div class="card-title">{{ef.id ? 'Edit User' : 'Add User'}}</div>
      <div class="fr">
        <div class="fg"><label>Full name *</label><input [(ngModel)]="ef.name"></div>
        <div class="fg"><label>Username * <span style="font-weight:400;color:var(--txm)">(3–30, letters/numbers . _ -)</span></label><input [(ngModel)]="ef.username" [readonly]="!!ef.id"></div></div>
      <div class="fr">
        <div class="fg"><label>Email *</label><input [(ngModel)]="ef.email" [readonly]="!!ef.id"></div>
        <div class="fg"><label>Role *</label><select [(ngModel)]="ef.role">
          @for (r of roleKeys; track r) { <option [value]="r">{{ROLES[r].label}}</option> }</select></div></div>
      @if (!ef.id) {
        <div class="fg" style="margin-bottom:4px"><label>Password *</label>
          <div class="pw-wrap"><input type="text" [(ngModel)]="ef.pw" autocomplete="new-password">
          <button type="button" class="pw-toggle" (click)="gen()"><i class="ti ti-wand"></i> Generate</button></div></div>
        <div class="pw-bar"><i [style.width.%]="score()*100/6" [style.background]="barColor()"></i></div>
        <div class="pw-hint">{{hint()}}</div>
      } @else {
        <div class="fr" style="margin-top:14px">
          <div class="fg"><label>Status</label><select [(ngModel)]="ef.status"><option value="active">Active</option><option value="disabled">Disabled</option></select></div></div>
      }
      <div class="form-err" [style.display]="err()?'block':'none'">{{err()}}</div>
      <div class="btn-grp">
        <button class="btn btn-p" (click)="save()">Save</button>
        <button class="btn btn-s" (click)="editing.set(null)">Cancel</button></div>
    </div> }
    @if (tempPw()) {
      <div class="notice"><i class="ti ti-key"></i> <div>Temporary password for {{tempPwUser()}}: <strong>{{tempPw()}}</strong> — shown once; the user must change it at their next sign-in.</div></div>
    }
    <table>
      <thead><tr><th>User</th><th>Username</th><th>Role</th><th>Status</th><th>Last Sign-in</th><th style="width:260px">Actions</th></tr></thead>
      <tbody>
        @for (u of list(); track u.id) {
          <tr>
            <td>{{u.name}} @if (u.must_change) { <span class="chip c-wn" title="Must change password at next sign-in">PW</span> }</td>
            <td>{{u.username}}<div style="font-size:11px;color:var(--txm)">{{u.email}}</div></td>
            <td><span class="chip {{ROLES[u.role].chip}}">{{ROLES[u.role].label}}</span></td>
            <td><span class="chip" [class.c-ok]="u.status==='active'" [class.c-nt]="u.status!=='active'">{{u.status==='active'?'Active':'Disabled'}}</span></td>
            <td>{{u.last_login ? fmtT(u.last_login) : 'Never'}}</td>
            <td>
              <button class="btn btn-s btn-sm" (click)="openEdit(u)">Edit</button>
              <button class="btn btn-s btn-sm" (click)="resetpw(u)">Reset pw</button>
              @if (u.locked_until) { <button class="btn btn-s btn-sm" (click)="unlock(u)">Unlock</button> }
              <button class="btn btn-s btn-sm" (click)="toggleStatus(u)">{{u.status==='active'?'Disable':'Enable'}}</button>
              <button class="btn btn-s btn-sm" (click)="del(u)"><i class="ti ti-trash"></i></button>
            </td>
          </tr>
        }
      </tbody>
    </table>
  </div>`,
})
export class UsersComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  auth = inject(AuthStore);

  ROLES = ROLES;
  roleKeys: Role[] = ['admin', 'accountant', 'bookkeeper', 'viewer'];
  list = signal<Usr[]>([]);
  editing = signal<Partial<Usr> & { pw?: string } | null>(null);
  tempPw = signal(''); tempPwUser = signal('');
  err = signal('');
  hint = signal('8+ characters with upper and lower case, a number and a symbol');
  score = signal(0); barColor = signal('var(--dn)');

  constructor() { void this.reload(); }
  get ef() { return (this.editing() ?? {}) as Partial<Usr> & { pw?: string }; }
  async reload() { this.list.set(await this.api.get<Usr[]>('/users')); }

  openAdd() {
    this.editing.set({ name: '', username: '', email: '', role: 'bookkeeper', pw: '' });
    this.err.set(''); this.score.set(0); this.hint.set('8+ characters with upper and lower case, a number and a symbol');
  }
  openEdit(u: Usr) {
    this.editing.set({ id: u.id, name: u.name, username: u.username, email: u.email, role: u.role, status: u.status });
    this.err.set('');
  }

  gen() {
    const U = 'ABCDEFGHJKLMNPQRSTUVWXYZ', L = 'abcdefghijkmnpqrstuvwxyz', D = '23456789', S = '!@#$%&*?', all = U + L + D + S;
    const pick = (set: string, r: number) => set[r % set.length];
    const raw = crypto.getRandomValues(new Uint8Array(12));
    const out = [pick(U, raw[0]), pick(L, raw[1]), pick(D, raw[2]), pick(S, raw[3])];
    for (let i = 4; i < 12; i++) out.push(pick(all, raw[i]));
    const sh = crypto.getRandomValues(new Uint8Array(12));
    for (let i = out.length - 1; i > 0; i--) { const j = sh[i] % (i + 1); [out[i], out[j]] = [out[j], out[i]]; }
    this.pwIssuesScore(out.join(''));
  }
  pwIssuesScore(p: string) {
    const un = this.editing()?.username || '';
    const i: string[] = [];
    if (p.length < 8) i.push('at least 8 characters');
    if (!/[a-z]/.test(p)) i.push('a lowercase letter');
    if (!/[A-Z]/.test(p)) i.push('an uppercase letter');
    if (!/\d/.test(p)) i.push('a number');
    if (!/[^A-Za-z0-9]/.test(p)) i.push('a symbol');
    if (un.length >= 3 && p.toLowerCase().includes(un.toLowerCase())) i.push('no part of the username');
    this.hint.set(i.length ? 'Needs: ' + i.join(', ') : 'Strong password');
    this.score.set(Math.max(0, 5 - i.filter((x) => !x.startsWith('no part')).length) + (p.length >= 12 ? 1 : 0));
    this.barColor.set(this.score() <= 2 ? 'var(--dn)' : this.score() <= 4 ? 'var(--wn)' : 'var(--ok)');
  }

  async save() {
    const e = this.editing(); if (!e) return;
    this.err.set(''); this.pwIssuesScore(e.pw ?? '');
    try {
      if (e.id) {
        await this.api.patch('/users/' + e.id, { name: e.name, role: e.role, status: e.status });
      } else {
        await this.api.post('/users', { name: e.name, username: e.username, email: e.email, role: e.role, pw: e.pw });
      }
      this.editing.set(null);
      await this.reload();
      this.toast.show('User saved.');
    } catch (err) { this.err.set((err as ApiError).message); }
  }

  async resetpw(u: Usr) {
    if (!confirm('Reset the password for ' + u.name + '? They will be forced to change it at next sign-in.')) return;
    try {
      const r = await this.api.post<{ temp: string }>('/users/' + u.id + '/reset-password');
      this.tempPw.set(r.temp); this.tempPwUser.set(u.username);
      await this.reload();
    } catch (e) { this.toast.show((e as ApiError).message); }
  }

  async unlock(u: Usr) {
    try { await this.api.post('/users/' + u.id + '/unlock'); await this.reload(); }
    catch (e) { this.toast.show((e as ApiError).message); }
  }

  async toggleStatus(u: Usr) {
    const status = u.status === 'active' ? 'disabled' : 'active';
    try {
      await this.api.patch('/users/' + u.id, { status });
      await this.reload();
      this.toast.show('User ' + status + '.');
    } catch (e) { this.toast.show((e as ApiError).message); }
  }

  async del(u: Usr) {
    if (!confirm('Remove user ' + u.username + '?')) return;
    try { await this.api.del('/users/' + u.id); await this.reload(); }
    catch (e) { this.toast.show((e as ApiError).message); }
  }

  fmtT(t: string) { return new Date(t).toLocaleString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
}

// Roles (set-roles port): role cards + per-user permission overrides + read-only matrix.
@Component({
  selector: 'app-settings-roles',
  imports: [FormsModule],
  template: `
  <div class="notice"><i class="ti ti-info-circle"></i> Each user has one role, which sets default access. Use User Permissions below to enable or remove access to modules and sections for an individual user. Administrators always have full access.</div>
  <div class="g4">
    @for (r of roleKeys; track r) {
      <div class="stat-card"><div class="stat-lbl"><span class="chip {{ROLES[r].chip}}">{{ROLES[r].label}}</span></div>
        <div style="font-size:12.5px;color:var(--tx2)">{{ROLES[r].desc}}</div></div>
    }
  </div>
  <div class="card" style="margin-bottom:16px"><div class="card-title">User Permissions <span style="font-weight:400;font-size:12px;color:var(--txm)">Override the role for one user</span></div>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
      <select [(ngModel)]="selId" (ngModelChange)="selChanged()" style="min-width:260px">
        <option value="">— choose a non-admin user —</option>
        @for (u of users(); track u.id) { @if (u.role !== 'admin') { <option [value]="u.id">{{u.name}} ({{ROLES[u.role].label}})</option> } }
      </select>
      <span class="logo-sub">@if (sel()) { {{sel()!.role}} defaults: {{modSummary(sel()!.role)}} }</span></div>
    @if (sel() && sel()!.role !== 'admin') {
      <div style="overflow:auto">
        <table><thead><tr><th>Module</th><th style="width:90px">Full</th><th>Sections</th></tr></thead>
        <tbody>
          @for (m of modRows(); track m.key) {
            <tr><td>{{m.label}}</td>
              <td><input type="checkbox" [ngModel]="m.star" (ngModelChange)="toggleStar(m.key, $event)" style="width:auto"></td>
              <td style="display:flex;gap:8px;flex-wrap:wrap">
                @for (s of m.sections; track s) {
                  <label style="font-size:12px;font-weight:400;display:flex;gap:4px;align-items:center">
                    <input type="checkbox" style="width:auto" [checked]="m.on.has(s)" (change)="toggleSec(m, s, $any($event.target).checked)">
                    {{SECN[s]}}</label>
                }
              </td></tr>
          }
        </tbody></table>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-p" (click)="saveUP()"><i class="ti ti-device-floppy"></i> Save Permissions</button>
        <button class="btn btn-s" (click)="resetUP()">Reset to Role Defaults</button>
      </div>
      <div class="form-err" [style.display]="err()?'block':'none'">{{err()}}</div>
    }
  </div>
  <div class="card"><div class="card-title">Role Access Matrix</div>
    <div style="overflow:auto">
      <table><thead><tr><th>Role</th><th>Full access</th><th>Restricted</th><th>None</th></tr></thead>
      <tbody>
        @for (r of roleKeys; track r) {
          <tr><td><span class="chip {{ROLES[r].chip}}">{{ROLES[r].label}}</span></td>
            <td>{{fullMods(r)}}</td>
            <td>{{partMods(r)}}</td>
            <td style="color:var(--txm)">{{noMods(r)}}</td></tr>
        }
      </tbody></table>
    </div>
  </div>`,
})
export class RolesComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  ROLES = ROLES; SECN = SECN;
  roleKeys: Role[] = ['admin', 'accountant', 'bookkeeper', 'viewer'];
  users = signal<Usr[]>([]);
  selId = ''; err = signal('');
  rows = signal<Record<string, { star: boolean; on: Set<string> }>>({});

  constructor() { void this.reload(); }
  async reload() {
    this.users.set(await this.api.get<Usr[]>('/users'));
    this.selChanged();
  }

  sel = () => this.users().find((u) => u.id === this.selId) ?? null;
  selChanged() {
    const u = this.sel();
    const acc = u ? (u.access_overrides ? { ...u.access_overrides } : undefined) : undefined;
    const base = u ? ACCESS[u.role] : {};
    const rows: Record<string, { star: boolean; on: Set<string> }> = {};
    for (const [k, v] of Object.entries(base)) {
      const ov = acc?.[k];
      rows[k] = { star: ov === '*' || v === '*',
        on: new Set(ov && ov !== '*' ? ov.split(',') : v === '*' ? [] : v.split(',')) };
    }
    this.rows.set(rows);
  }
  modRows = () => {
    const u = this.sel();
    const base = u ? ACCESS[u.role] as Record<string, string> : {};
    return Object.entries(this.rows()).map(([key, r]) => ({
      key, label: MODS.find((m) => m[0] === key)?.[1] ?? key, ...r,
      sections: MODSEC[key] ?? (base[key] !== '*' ? String(base[key]).split(',') : []),
    }));
  };
  toggleStar(key: string, on: boolean) {
    this.rows.update((r) => ({ ...r, [key]: { ...r[key], star: on, on: on ? new Set([...r[key].on]) : new Set([...r[key].on]) } }));
  }
  toggleSec(m: { key: string; on: Set<string> }, sec: string, on: boolean) {
    const s = new Set(m.on);
    on ? s.add(sec) : s.delete(sec);
    this.rows.update((r) => ({ ...r, [m.key]: { star: r[m.key].star, on: s } }));
  }

  buildOverride(): Record<string, string> {
    const u = this.sel()!;
    const base = ACCESS[u.role] as Record<string, string>;
    const rows = this.rows();
    const out: Record<string, string> = {};
    for (const key of Object.keys(base)) {
      const r = rows[key];
      if (!r) continue;
      if (r.star) out[key] = '*';
      else if (r.on.size) out[key] = [...r.on].join(',');
      // empty = module removed via override
    }
    return out;
  }

  async saveUP() {
    this.err.set('');
    try {
      await this.api.patch('/users/' + this.selId, { access_overrides: this.buildOverride() });
      await this.reload();
      this.toast.show('Permissions saved.');
    } catch (e) { this.err.set((e as ApiError).message); }
  }
  async resetUP() {
    try {
      await this.api.patch('/users/' + this.selId, { access_overrides: null });
      await this.reload();
      this.toast.show('Reset to role defaults.');
    } catch (e) { this.err.set((e as ApiError).message); }
  }

  modSummary(role: Role) {
    const a = ACCESS[role] as Record<string, string>;
    return Object.entries(a).map(([k, v]) => k + (v === '*' ? '' : ': ' + v)).join('; ');
  }
  fullMods(r: Role) { return this.partModsBase(r, '*'); }
  partMods(r: Role) { return this.partModsBase(r, false); }
  noMods(r: Role) {
    const a = ACCESS[r] as Record<string, string> | undefined;
    if (!a) return 'everything';
    return MODS.map((m) => m[0]).filter((m) => !(m in a)).map((m) => (SECN[m] || m)).join(', ') || '—';
  }
  private partModsBase(r: Role, star: unknown) {
    const a = ACCESS[r] as Record<string, string> | undefined;
    if (!a) return 'everything';
    return Object.entries(a).filter(([, v]) => (star ? v === '*' : v !== '*')).map(([k]) => k).join(', ') || '—';
  }
}

interface LogRow { id: number; at: string; username: string; action: string; detail: string; }

// Activity log (set-log port): table + client filter.
@Component({
  selector: 'app-settings-log',
  imports: [FormsModule],
  template: `
  <div class="card"><div class="card-title">Activity Log
    <span style="display:flex;gap:8px;align-items:center"><input [(ngModel)]="filter" placeholder="Filter by user or action…" style="width:240px"></span></div>
    <table><thead><tr><th style="width:170px">Time</th><th>User</th><th>Action</th><th>Detail</th></tr></thead>
    <tbody>
      @for (l of filtered(); track l.id) {
        <tr><td>{{fmtT(l.at)}}</td><td>{{l.username}}</td><td>{{l.action}}</td><td>{{l.detail}}</td></tr>
      }
      @empty { <tr><td colspan="4" style="color:var(--txm)">No activity yet.</td></tr> }
    </tbody></table>
  </div>`,
})
export class LogComponent {
  private api = inject(ApiService);
  rows = signal<LogRow[]>([]);
  filter = '';

  constructor() { void this.reload(); }
  async reload() { this.rows.set(await this.api.get<LogRow[]>('/activity-log?limit=300')); }
  filtered = () => {
    const f = this.filter.trim().toLowerCase();
    return f ? this.rows().filter((r) => (r.username + ' ' + r.action + ' ' + r.detail).toLowerCase().includes(f)) : this.rows();
  };
  fmtT(t: string) { return new Date(t).toLocaleString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
}

// Companies tab (set-companies port): add-company card + table (admin only — router-guarded).
@Component({
  selector: 'app-settings-companies',
  imports: [FormsModule],
  template: `
  <div class="card"><div class="card-title">Add Company</div>
    <div class="fr3">
      <div class="fg"><label>Company name *</label><input [(ngModel)]="f.name" maxlength="80" placeholder="e.g. Acme Holdings (Pty) Ltd"></div>
      <div class="fg"><label>Start with</label><select [(ngModel)]="f.seed"><option value="blank">Blank (no demo data)</option><option value="demo">Demo (sample SA data)</option></select></div>
      <div class="fg"><label>First FY starts (optional)</label><input type="date" [(ngModel)]="f.fy_start" [placeholder]="today"></div>
    </div>
    <div class="fr2" style="display:flex;gap:10px;align-items:flex-end">
      <div class="fg"><label>Assign users (optional)</label><select multiple [(ngModel)]="f.users" style="height:88px">
        @for (u of users(); track u.id) { <option [value]="u.id">{{u.name}} ({{ROLES[u.role].label}})</option> }
      </select></div>
      <button class="btn btn-p" (click)="add()" [disabled]="busy()"><i class="ti ti-plus"></i> Add Company</button>
    </div>
    <div class="form-err" [style.display]="err()?'block':'none'">{{err()}}</div>
  </div>
  <div class="card"><div class="card-title">All Companies</div>
    <table><thead><tr><th>Company</th><th>Started with</th><th>Created</th><th>Status</th><th style="width:120px">Actions</th></tr></thead>
    <tbody>
      @for (c of cos(); track c.id) {
        <tr>
          <td>{{c.name}}</td>
          <td>{{c.seed==='demo'?'Demo data':'Blank'}}</td>
          <td>{{fmtD(c.created_at)}}</td>
          <td><span class="chip" [class.c-ok]="c.id===auth.company()?.id">Active</span></td>
          <td><button class="btn btn-s btn-sm" (click)="del(c)" [title]="c.id===auth.company()?.id?'Cannot delete the current company':'Delete'"><i class="ti ti-trash"></i></button></td>
        </tr>
      }
    </tbody></table>
  </div>`,
})
export class CompaniesTabComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  auth = inject(AuthStore);

  ROLES = ROLES;
  today = new Date().toISOString().slice(0, 10);
  users = signal<Usr[]>([]);
  cos = signal<CompanyInfo[]>([]);
  f: { name: string; seed: string; fy_start: string; users: string[] } = { name: '', seed: 'blank', fy_start: '', users: [] };
  busy = signal(false); err = signal('');

  constructor() { void this.reload(); }
  async reload() {
    this.cos.set(await this.api.get<CompanyInfo[]>('/companies'));
    this.users.set(await this.api.get<Usr[]>('/users'));
  }

  async add() {
    this.busy.set(true); this.err.set('');
    try {
      await this.api.post('/companies', { name: this.f.name, seed: this.f.seed, fy_start: this.f.fy_start || undefined });
      this.f = { name: '', seed: 'blank', fy_start: '', users: [] };
      await this.reload();
      void this.auth.me(); // refresh own company list so the new company is switchable
      this.toast.show('Company added.');
    } catch (e) { this.err.set((e as ApiError).message); }
    finally { this.busy.set(false); }
  }

  async del(c: CompanyInfo) {
    if (!confirm('Remove company ' + c.name + '? This deletes all of its data.')) return;
    try { await this.api.del('/companies/' + c.id); await this.reload(); }
    catch (e) { this.toast.show((e as ApiError).message); }
  }

  fmtD(t?: string) { return t ? new Date(t).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'; }
}

interface EmailCfg {
  mode: string; host: string; port?: number; security: string; smtp_user: string; save_pass: boolean;
  from_name: string; from_email: string; reply_to: string; bcc: string; relay_url: string; relay_token: string;
  subject_tpl: string; body_tpl: string; has_password?: boolean;
}

// Email (SMTP) tab (set-email port 2930–3019). Password never comes back from the API — has_password only.
@Component({
  selector: 'app-settings-email',
  imports: [FormsModule],
  template: `
  <div class="card" style="margin-bottom:16px"><div class="card-title">SMTP Configuration</div>
    <div class="fr3">
      <div class="fg"><label>SMTP Mode</label><select [(ngModel)]="c.mode">
        <option value="simulate">Simulate (demo)</option><option value="mailto">Mail client (mailto)</option><option value="relay">Relay (real email)</option></select></div>
      <div class="fg"><label>SMTP Host</label><input [(ngModel)]="c.host" placeholder="smtp.yourdomain.co.za"></div>
      <div class="fg"><label>Port</label><input type="number" [(ngModel)]="c.port"></div></div>
    <div class="fr3">
      <div class="fg"><label>Security</label><select [(ngModel)]="c.security">
        <option value="starttls">STARTTLS</option><option value="ssl">SSL/TLS</option><option value="none">None</option></select></div>
      <div class="fg"><label>Username</label><input [(ngModel)]="c.smtp_user"></div>
      <div class="fg"><label>Password</label>
        <input type="password" [(ngModel)]="pw" [placeholder]="c.has_password ? 'Saved — leave blank to keep' : ''">
        <label style="font-weight:400;display:flex;gap:6px;align-items:center;margin-top:6px"><input type="checkbox" style="width:auto" [(ngModel)]="c.save_pass"> Remember password on this device</label></div></div>
  </div>
  <div class="card" style="margin-bottom:16px"><div class="card-title">Relay &amp; From</div>
    <div class="fr">
      <div class="fg"><label>From name</label><input [(ngModel)]="c.from_name"></div>
      <div class="fg"><label>From email</label><input [(ngModel)]="c.from_email" placeholder="no-reply@yourdomain.co.za"></div></div>
    <div class="fr">
      <div class="fg"><label>Reply-To (optional)</label><input [(ngModel)]="c.reply_to"></div>
      <div class="fg"><label>BCC archive (optional, comma-separate)</label><input [(ngModel)]="c.bcc"></div></div>
    <div class="fr3">
      <div class="fg"><label>Relay URL</label><input [(ngModel)]="c.relay_url" placeholder="https://relay.yourdomain.co.za"></div>
      <div class="fg"><label>Relay token</label><input type="password" [(ngModel)]="c.relay_token" placeholder="16+ characters"></div></div>
  </div>
  <div class="card"><div class="card-title">Statement Template</div>
    <div class="fg"><label>Email subject</label><input [(ngModel)]="c.subject_tpl"></div>
    <div class="fg" style="margin-bottom:4px"><label>Email body</label><textarea [(ngModel)]="c.body_tpl" rows="9" style="font-family:ui-monospace,monospace;font-size:12.5px"></textarea></div>
    <div style="font-size:12px;color:var(--txm)">Placeholders: &#123;customer&#125; &#123;date&#125; &#123;balance&#125; &#123;overdue_line&#125; &#123;company&#125; &#123;company_vat&#125; &#123;company_reg&#125;</div>
  </div>
  <div class="btn-grp">
    <button class="btn btn-p" (click)="save()" [disabled]="busy()"><i class="ti ti-device-floppy"></i> Save Email Settings</button>
    <button class="btn btn-s" (click)="test()"><i class="ti ti-send"></i> Test Relay</button>
  </div>
  @if (testResult()) { <div class="notice" style="margin-top:12px"><i class="ti ti-flask"></i> <div>{{testResult()}}</div></div> }`,
})
export class EmailComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);

  c: EmailCfg = {
    mode: 'simulate', host: '', port: 587, security: 'starttls', smtp_user: '', save_pass: false,
    from_name: 'Demo Company (Pty) Ltd', from_email: '', reply_to: '', bcc: '', relay_url: '', relay_token: '',
    subject_tpl: 'Statement of account — {customer} — {date}',
    body_tpl: 'Dear {customer},\n\nPlease find your account statement as at {date} below.\nBalance outstanding: {balance}.{overdue_line}\n\nKind regards,\n{company}',
  };
  pw = ''; busy = signal(false); testResult = signal('');

  constructor() { void this.reload(); }
  async reload() {
    this.c = { ...this.c, ...(await this.api.get<EmailCfg>('/settings/email')) };
    this.cdr.detectChanges(); // zoneless: async assignment needs a manual pass
  }

  async save() {
    this.busy.set(true);
    try {
      await this.api.put<EmailCfg>('/settings/email', { ...this.c, smtp_pass: this.pw || undefined });
      this.pw = ''; await this.reload();
      this.toast.show('Email settings saved.');
    } catch (e) { this.toast.show((e as ApiError).message); }
    finally { this.busy.set(false); }
  }

  async test() {
    this.testResult.set('');
    const r = await this.api.post<{ status: string; detail: string }>('/settings/email/test');
    this.testResult.set(r.status === 'ok' ? 'Relay check passed: ' + r.detail : 'Relay check failed: ' + r.detail);
  }
}


// ── Sales Item Types (NIT — Settings tab, legacy 5390-5412) ──
// ── Sales Item Types (NIT — legacy 5390–5412). No edit endpoint; delete = deactivate. ──
@Component({
  selector: 'app-settings-sitypes', imports: [FormsModule],
  template: `
  <div class="card" style="margin-bottom:16px"><div class="card-title">Add Non-Inventory Item Type</div>
    <div class="fr3">
      <div class="fg"><label>Name *</label><input [(ngModel)]="f.name" maxlength="50" placeholder="e.g. Installation Labour"></div>
      <div class="fg"><label>Default price (excl. VAT)</label><input type="number" [(ngModel)]="f.price" min="0" step="0.01" placeholder="0.00"></div>
      <div class="fg"><label>VAT</label><select [(ngModel)]="f.vat"><option value="15">Standard 15%</option><option value="0">Zero-rated / exempt 0%</option></select></div></div>
    <div class="fr"><div class="fg"><label>Sales GL Account *</label><select [(ngModel)]="f.gl">
      <option value="">— Select —</option>
      @for (a of accs(); track a.code) { <option [value]="a.code">{{a.code}} — {{a.name}}</option> }</select></div></div>
    <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
    <div class="btn-grp"><button class="btn btn-p" (click)="save()" [disabled]="busy()"><i class="ti ti-plus"></i> Add Item Type</button>
      <button class="btn btn-s" (click)="reset()">Cancel</button></div></div>
  <div class="card"><div class="card-title">Non-Inventory Item Types</div>
    <table><thead><tr><th>Code</th><th>Name</th><th class="tr">Default price</th><th>VAT</th><th>GL account</th><th>Status</th><th style="width:130px">Action</th></tr></thead>
    <tbody>
      @for (t of list(); track t.code) {
        <tr><td>{{t.code}}</td><td><strong>{{t.name}}</strong></td><td class="tr">{{fmtR(t.price)}}</td><td>{{t.vat === '15' ? '15%' : '0%'}}</td><td>{{t.gl}}</td>
          <td><span class="chip" [class.c-ok]="t.active" [class.c-nt]="!t.active">{{t.active ? 'Active' : 'Inactive'}}</span></td>
          <td>@if (t.active) { <button class="btn btn-s btn-sm" (click)="deactivate(t)">Deactivate</button> }</td></tr>
      } @empty { <tr><td colspan="7" style="color:var(--txm)">No item types yet.</td></tr> }
    </tbody></table></div>`,
})
export class SitypesComponent {
  fmtR = fmtR;
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  list = signal<{ code: string; name: string; price: number; gl: string; vat: string; active: boolean }[]>([]);
  accs = signal<{ code: string; name: string }[]>([]);
  busy = signal(false); err = signal('');
  f = { name: '', price: 0, vat: '15', gl: '' };

  constructor() { void this.reload(); }
  async reload() {
    const [l, a] = await Promise.all([
      this.api.get<{ code: string; name: string; price: number; gl: string; vat: string; active: boolean }[]>('/sitypes'),
      this.api.get<{ code: string; name: string }[]>('/gl/accounts'),
    ]);
    this.list.set(l); this.accs.set(a); this.cdr.detectChanges();
  }
  reset() { this.f = { name: '', price: 0, vat: '15', gl: '' }; this.err.set(''); }
  async save() {
    this.err.set(''); this.busy.set(true);
    try {
      const r = await this.api.post<{ code: string }>('/sitypes', { name: this.f.name.trim(), price: Number(this.f.price), gl: this.f.gl, vat: this.f.vat });
      this.toast.show('Item type ' + r.code + ' added.'); this.reset(); await this.reload();
    } catch (e) { this.err.set((e as ApiError).message); }
    finally { this.busy.set(false); this.cdr.detectChanges(); }
  }
  async deactivate(t: { code: string }) {
    try { await this.api.del('/sitypes/' + t.code); await this.reload(); this.toast.show('Item type deactivated.'); }
    catch (e) { this.toast.show((e as ApiError).message); }
  }
}
