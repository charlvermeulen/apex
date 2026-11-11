import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from './api';
import { canMod, canSec } from '@numera/shared';
import type { AccessMap, Role } from '@numera/shared';

export interface UserInfo {
  id: string; name: string; username: string; email: string;
  role: Role; status: string; must_change: boolean;
}
export interface CompanyInfo {
  id: string; name: string; seed: 'demo' | 'blank'; fy_start?: string | null;
  reg?: string | null; vat_no?: string | null; created_at?: string;
}

@Injectable({ providedIn: 'root' })
export class AuthStore {
  private api = inject(ApiService);

  user = signal<UserInfo | null>(null);
  access = signal<AccessMap>({});
  companies = signal<CompanyInfo[]>([]);
  company = signal<CompanyInfo | null>(null);
  fyName = signal('');   // legacy topbar fy-label (updateFyLabel 2790)
  // edit handoff between list/add components (customers + suppliers)
  custEdit = signal<any>(null);

  canMod = computed(() => (m: string) => canMod(this.authU(), m));
  canSec = computed(() => (m: string, sec: string) => canSec(this.authU(), m, sec));
  private authU = computed(() => {
    const u = this.user();
    return u ? { role: u.role, overrides: this.access() as never } : null;
  });

  async me(): Promise<boolean> {
    try {
      const r = await this.api.get<{ user: UserInfo; access: AccessMap; companies: CompanyInfo[]; company: CompanyInfo | null }>('/auth/me');
      this.user.set(r.user);
      this.access.set(r.access || {});
      this.companies.set(r.companies);
      this.company.set(r.company);
      await this.loadFY();
      return true;
    } catch { return false; }
  }

  clear() {
    this.user.set(null);
    this.access.set({});
    this.companies.set([]);
    this.company.set(null);
  }

  async switchCompany(id: string): Promise<void> {
    const r = await this.api.post<{ company: CompanyInfo }>('/auth/select-company', { companyId: id });
    this.company.set(r.company);
    await this.loadFY();
  }

  // is_current FY name for the topbar label
  async loadFY(): Promise<void> {
    if (!this.company()) { this.fyName.set(''); return; }
    try {
      const fys = await this.api.get<{ id: string; name: string; is_current: boolean; status: string }[]>('/fys');
      const cur = fys.find((f) => f.is_current);
      this.fyName.set(cur ? cur.name + (cur.status === 'closed' ? ' (closed)' : '') : 'No financial year');
    } catch { this.fyName.set(''); }
  }

  async apiLogout(): Promise<void> {
    try { await this.api.post('/auth/logout'); } catch { /* session may already be gone */ }
    this.clear();
  }
}
