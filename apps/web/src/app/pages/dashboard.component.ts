import { Component, inject } from '@angular/core';
import { AuthStore } from '../core/auth.store';

// Batch-1 dashboard stub — real KPIs arrive with the financials batches.
@Component({
  selector: 'app-dashboard',
  template: `
  <div class="page-title">Dashboard</div>
  <div class="page-sub">{{auth.company()?.name}}</div>
  <div class="notice"><i class="ti ti-info-circle"></i> Dashboard KPIs, revenue charts and position summaries arrive with the Customers/Suppliers and financials batches. Everything already ported lives under <strong>General Ledger → Chart of Accounts</strong> and <strong>Settings</strong>.</div>
  <div class="g4">
    <div class="stat-card"><div class="stat-lbl">Module</div><div class="stat-val">{{auth.company()?.seed==='demo'?'Demo':'Blank'}} company</div><div class="stat-sub">Ported: auth, roles, companies, settings, COA</div></div>
    <div class="stat-card"><div class="stat-lbl">Sign-in idle timeout</div><div class="stat-val">Server-side</div><div class="stat-sub">401 &rarr; back to the sign-in screen</div></div>
    <div class="stat-card"><div class="stat-lbl">Data layer</div><div class="stat-val">Neon Postgres</div><div class="stat-sub">Migrations + seeds applied</div></div>
    <div class="stat-card"><div class="stat-lbl">Next batch</div><div class="stat-val">Customers / Suppliers</div><div class="stat-sub">Journals materialize on posting</div></div>
  </div>`,
})
export class DashboardComponent {
  auth = inject(AuthStore);
}
