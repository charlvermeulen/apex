import { Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink, RouterOutlet } from '@angular/router';
import { AuthStore } from './auth.store';

export interface ModTab { label: string; path: string; sec: string; ready?: boolean; icon?: string; }
// Route data contract: {mod, title, sub, tabs} — one parent component per module (ponytail: data-driven parent beats 5 near-identical classes).

@Component({
  selector: 'app-mod-tabs',
  imports: [RouterOutlet, RouterLink],
  template: `
  <div class="page-title">{{d().title}}</div>
  <div class="page-sub">{{d().sub}}</div>
  @if (secs().length > 1) {
    <div class="sec-bar">
      @for (s of secs(); track s.key) {
        <button class="sec-btn" [class.active]="s.key === sec()" (click)="goSec(s.key)"><i class="ti" [class]="s.icon"></i> {{SECN[s.key]}}</button>
      }
    </div>
  }
  <div class="stab-bar" [class.single]="secs().length <= 1">
    @for (t of curTabs(); track t.path) {
      @if (t.ready !== false) {
        <a class="stab" [routerLink]="t.path" routerLinkActive="active"><i class="ti" [class]="t.icon"></i> {{t.label}}</a>
      } @else {
        <span class="stab" style="opacity:.4;cursor:not-allowed" title="Arrives in a later batch"><i class="ti" [class]="t.icon"></i> {{t.label}}</span>
      }
    }
  </div>
  <router-outlet />`,
})
export class ModTabsComponent {
  SECN: Record<string, string> = { maint: 'Maintenance', trans: 'Transactions', enq: 'Enquiries', rep: 'Reports' };
  private ar = inject(ActivatedRoute);
  private router = inject(Router);
  private auth = inject(AuthStore);

  d = () => this.ar.snapshot.data as { mod: string; title: string; sub: string; tabs: ModTab[] };
  icon = (s: string) => ({ maint: 'ti-settings', trans: 'ti-arrows-exchange', enq: 'ti-search', rep: 'ti-chart-bar' })[s] ?? '';

  // sections with at least one tab the role may see (access map hides whole secs for viewer)
  secs = computed(() => {
    void this.router.url;
    const mod = this.d().mod;
    const seen = new Set(this.d().tabs.filter((t) => t.ready !== false && this.auth.canSec()(mod, t.sec)).map((t) => t.sec));
    return ['maint', 'trans', 'enq', 'rep'].filter((s) => seen.has(s)).map((key) => ({ key, icon: this.icon(key) }));
  });

  sec = () => { const p = this.router.url; return this.d().tabs.find((t) => p.startsWith(t.path))?.sec ?? this.secs()[0]?.key; };
  curTabs = () => this.d().tabs.filter((t) => t.sec === this.sec());

  goSec(s: string) {
    const t = this.d().tabs.find((t) => t.sec === s && (t.ready !== false));
    if (t) this.router.navigateByUrl(t.path);
  }
}

// Shared money/date pipes used via helpers; forms need FormsModule only in leaf components.
export const MOD_FORMS = [FormsModule];
