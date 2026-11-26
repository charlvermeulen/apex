import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { AuthStore } from '../core/auth.store';
import { ToastService } from '../core/api';
import { ROLES } from '@numera/shared';
import { FormsModule } from '@angular/forms';

// App shell: topbar + 16-module sidebar (MODS 2536), user menu, FY label.
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, FormsModule],
  styles: `
    :host{display:contents}
    .um-drop.open{display:block}
  `,
  template: `
  <div class="app">
    <header class="topbar">
      <div class="logo">
        <div class="logo-icon" style="background:var(--ac)">N</div>
        <div><div class="logo-text">Numera</div>
        <div class="logo-sub">Accounting, Contract Management, and Service all in one place!</div></div>
      </div>
      <div class="topbar-right">
        <span class="tax-badge"><i class="ti ti-shield-check"></i> SARS Compliant</span>
        <span class="fy-lbl" style="font-size:12px;color:var(--tx2)">{{fyLabel()}}</span>
        <span style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--tx2)">
          <i class="ti ti-building"></i>
          <select id="co-switch" style="width:auto;padding:4px 8px;font-size:12px"
            [ngModel]="auth.company()?.id" (ngModelChange)="switchCo($event)"
            [title]="'Switch company'">
            @for (c of auth.companies(); track c.id) { <option [value]="c.id">{{c.name}}</option> }
          </select>
        </span>
        <div class="user-menu">
          <button class="user-btn" (click)="menuOpen.set(!menuOpen())">
            <span class="av-sm">{{initials(auth.user()?.name || '—')}}</span>
            <span class="um-name">{{auth.user()?.name}}<small>{{roleLabel()}}</small></span>
            <i class="ti ti-chevron-down" style="font-size:13px"></i>
          </button>
          <div class="um-drop" [class.open]="menuOpen()">
            <div class="um-head">{{auth.user()?.email}}</div>
            <button (click)="menuOpen.set(false); router.navigate(['/company-picker'])"><i class="ti ti-building"></i> Switch company</button>
            <button (click)="menuOpen.set(false); router.navigate(['/change-password'])"><i class="ti ti-key"></i> Change password</button>
            <button (click)="logout()"><i class="ti ti-logout"></i> Sign out</button>
          </div>
        </div>
      </div>
    </header>
    <div class="layout">
      <nav class="sidebar">
        @for (sec of navSections(); track sec.label) {
          <div class="nav-section">
            <div class="nav-label">{{sec.label}}</div>
            @for (m of sec.items; track m[0]) {
              @if (linkFor(m[0])) {
                <a [routerLink]="linkFor(m[0])" style="text-decoration:none">
                  <div class="nav-sub" [class.nav-parent]="m[0] === 'gl'"><i class="ti" [class]="iconFor(m[0])" style="width:18px;display:inline-block"></i> {{m[1]}}</div></a>
              } @else if (m[0] === 'dashboard') {
                <a routerLink="/dashboard" style="text-decoration:none">
                  <div class="nav-sub" title="Batch-1 stub — KPIs arrive with the financials batches"><i class="ti ti-gauge" style="width:18px;display:inline-block"></i> {{m[1]}}</div></a>
              } @else if (m[0] === 'settings') {
                <a routerLink="/settings/company" style="text-decoration:none">
                  <div class="nav-sub"><i class="ti ti-settings" style="width:18px;display:inline-block"></i> {{m[1]}}</div></a>
              } @else {
                <div class="nav-item" style="cursor:default;opacity:.55" [title]="m[1] + ' arrives in a later batch'">
                  <i class="ti ti-circle-dashed"></i> {{m[1]}}
                </div>
              }
            }
          </div>
        }
      </nav>
      <main class="main" (click)="menuOpen.set(false)"><router-outlet /></main>
    </div>
  </div>
  <div class="toast" [class.show]="toast.msg()">{{toast.msg()}}</div>`,
})
export class ShellComponent {
  auth = inject(AuthStore);
  toast = inject(ToastService);
  router = inject(Router);

  menuOpen = signal(false);
  roleLabel = () => { const r = this.auth.user()?.role; return r ? ROLES[r].label : '—'; };

  // sidebar sections mirror the legacy grouping (Overview / Finance / Operations / Tax & Compliance / System)
  navSections = () => {
    const sec: Record<string, [string, string][]> = {
      Overview: [["dashboard", "Dashboard"]],
      Finance: [["customers", "Customers"], ["suppliers", "Suppliers"], ["gl", "General Ledger"], ["banking", "Banking"]],
      Operations: [["inventory", "Inventory"], ["procurement", "Procurement"], ["assets", "Assets / Equipment"], ["service", "Service"], ["contracts", "Contract Management"], ["cbilling", "Contract Billing"]],
      "Tax & Compliance": [["vat", "VAT Returns"], ["paye", "PAYE / Payroll"], ["taxcal", "Tax Calendar"], ["reports", "Reports & Budgets"]],
      System: [["settings", "Settings"]],
    };
    return Object.entries(sec).map(([label, items]) => ({ label, items }));
  };

  // converted modules with the user's access route to their landing tab; others stay dimmed
  private CONVERTED: Record<string, string> = {
    customers: '/customers/list', suppliers: '/suppliers/list', gl: '/gl/coa',
    inventory: '/inventory/items', procurement: '/procurement/pi',
    assets: '/assets/register', service: '/service/calls', contracts: '/contracts/list', cbilling: '/cbilling/run',
    vat: '/vat/dash',
  };
  linkFor = (m: string) => {
    const conv = this.CONVERTED[m];
    return conv && this.auth.canMod()(m) ? conv : '';
  };
  iconFor = (m: string) => ({
    customers: 'ti-users', suppliers: 'ti-truck', gl: 'ti-books', inventory: 'ti-box',
    procurement: 'ti-shopping-cart', assets: 'ti-box-several', service: 'ti-headset',
    contracts: 'ti-file-text', cbilling: 'ti-receipt-2', vat: 'ti-receipt-tax',
    paye: 'ti-circle-dashed', taxcal: 'ti-circle-dashed', reports: 'ti-circle-dashed',
  })[m] ?? '';

  fyLabel = () => this.auth.fyName();

  async switchCo(id: string) {
    if (id === this.auth.company()?.id) return;
    try {
      await this.auth.switchCompany(id);
      this.toast.show('Switched to ' + (this.auth.company()?.name ?? ''));
      // no location.reload(): signals re-render downstream pages
    } catch { /* toast via interceptor/API error handled by caller pages */ }
  }

  async logout() {
    await this.auth.apiLogout();
    this.menuOpen.set(false);
    this.router.navigate(['/login']);
  }

  initials(n: string) { return n.split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase(); }
}
