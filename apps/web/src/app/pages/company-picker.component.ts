import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService, ApiError } from '../core/api';
import { AuthStore, CompanyInfo } from '../core/auth.store';
import { FormsModule } from '@angular/forms';

// Post-login company picker (legacy pickCompany flow). Admin can add a company inline.
@Component({
  selector: 'app-company-picker',
  imports: [FormsModule],
  styles: `:host{display:block}`,
  template: `
  <div class="login-bg" style="display:flex">
    <div class="login-card" style="width:460px">
      <div class="logo-text" style="font-size:16px;margin-bottom:4px">Choose a company</div>
      <div class="logo-sub" style="margin-bottom:18px">Signed in as {{auth.user()?.name}}</div>
      @for (c of auth.companies(); track c.id) {
        <div class="rr" style="cursor:pointer" (click)="enter(c)">
          <span style="display:flex;align-items:center;gap:10px">
            <i class="ti ti-building" style="font-size:17px;color:var(--ac)"></i>
            <span><span class="rr-name">{{c.name}}</span>
            <span class="rr-desc">{{c.seed==='demo'?'Sample data':'Blank company'}}</span></span>
          </span>
          <span class="chip c-ok">Open</span>
        </div>
      }
      <div class="login-err" [style.display]="err()?'block':'none'">{{err()}}</div>
      @if (auth.user()?.role === 'admin') {
        @if (addOpen()) {
          <div class="fr" style="display:block;margin-top:16px">
            <div class="fg"><label>New company name</label>
              <input [(ngModel)]="newName" name="newName" placeholder="e.g. Thabo Trading (Pty) Ltd"></div>
            <div class="fg"><label>Type</label>
              <select [(ngModel)]="newSeed" name="newSeed">
                <option value="blank">Blank — no sample data</option>
                <option value="demo">Demo — seeded with sample data</option>
              </select></div>
            <div class="btn-grp" style="margin-top:12px">
              <button class="btn btn-p" (click)="addCompany()"><i class="ti ti-plus"></i> Add company</button>
              <button class="btn btn-s" (click)="addOpen.set(false)">Cancel</button>
            </div>
          </div>
        } @else {
          <button class="btn btn-s" style="margin-top:18px;width:100%;justify-content:center"
            (click)="addOpen.set(true)"><i class="ti ti-building-plus"></i> Add a company</button>
        }
      }
    </div>
  </div>`,
})
export class CompanyPickerComponent {
  private api = inject(ApiService);
  auth = inject(AuthStore);
  private router = inject(Router);

  addOpen = signal(false);
  newName = ''; newSeed = 'blank';
  err = signal('');

  async enter(c: CompanyInfo) {
    try {
      await this.auth.switchCompany(c.id);
      this.router.navigate(['/dashboard']);
    } catch (e) { this.err.set((e as ApiError).message); }
  }

  async addCompany() {
    this.err.set('');
    try {
      const c = await this.api.post<CompanyInfo>('/companies', { name: this.newName, seed: this.newSeed });
      const cos = [...this.auth.companies(), c];
      this.auth.companies.set(cos);
      this.addOpen.set(false);
      this.newName = '';
      await this.enter(c);
    } catch (e) { this.err.set((e as ApiError).message); }
  }
}
