import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService, ApiError } from '../core/api';
import { AuthStore, UserInfo, CompanyInfo } from '../core/auth.store';

// Login port (legacy Numera.html:2588–2622): verbatim error strings, remember-username, demo hint.
@Component({
  selector: 'app-login',
  imports: [FormsModule],
  template: `
  <div class="login-bg" style="display:flex">
    <div class="login-card">
      <div class="login-logo">
        <div class="logo-icon" style="background:var(--ac)">N</div>
        <div><div class="logo-text" style="font-size:17px">Numera</div>
        <div class="logo-sub">South African Accounting System</div></div>
      </div>
      <form (ngSubmit)="login()" #f="ngForm">
        <div class="fg" style="margin-bottom:12px"><label>Username or email</label>
          <input name="id" [(ngModel)]="id" autocomplete="username" placeholder="e.g. admin"></div>
        <div class="fg" style="margin-bottom:6px"><label>Password</label>
          <div class="pw-wrap"><input name="pass" type="password" [(ngModel)]="pass" autocomplete="current-password" placeholder="Your password">
          <button type="button" class="pw-toggle" (click)="show=!show">{{show?'Hide':'Show'}}</button></div></div>
        <label style="display:flex;gap:8px;align-items:center;font-size:12.5px;color:var(--tx2);margin-top:8px">
          <input type="checkbox" [(ngModel)]="remember" name="remember" style="width:auto"> Remember my username</label>
        <button class="btn btn-p" type="submit" style="width:100%;justify-content:center;margin-top:14px"
          [disabled]="busy"><i class="ti ti-login"></i> {{busy?'Signing in…':'Sign in'}}</button>
      </form>
      <div class="login-err" [style.display]="err()?'block':'none'">{{err()}}</div>
      <div class="login-info" [style.display]="info()?'block':'none'">{{info()}}</div>
      <div style="margin-top:14px;font-size:12.5px"><a href="javascript:void 0" (click)="forgot()" style="color:var(--ac)">Forgot your password?</a></div>
      <div class="demo-box" title="Demo accounts seeded with forced password change — sign in, set your own password.">
        <div style="font-weight:700;margin-bottom:6px">Demo accounts</div>
        <table><thead><tr><th>Username</th><th>Role</th><th>Password</th></tr></thead><tbody>
          <tr><td>admin</td><td>Administrator</td><td>Admin@2025</td></tr>
          <tr><td>nomsa</td><td>Accountant</td><td>Nomsa@2025</td></tr>
          <tr><td>thabo</td><td>Bookkeeper</td><td>Thabo@2025</td></tr>
          <tr><td>pieter</td><td>Viewer</td><td>Pieter@2025</td></tr>
        </tbody></table>
      </div>
    </div>
  </div>`,
})
export class LoginComponent {
  private api = inject(ApiService);
  private auth = inject(AuthStore);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  id = ''; pass = ''; remember = false; show = false; busy = false;
  err = signal(''); info = signal('');

  ngOnInit() {
    const reason = this.route.snapshot.queryParamMap.get('reason');
    if (reason) this.err.set(reason);
  }

  async login() {
    this.busy = true;
    this.err.set(''); this.info.set('');
    try {
      const r = await this.api.post<{ user: UserInfo; companies: CompanyInfo[]; access?: Record<string, string> }>('/auth/login', { id: this.id, pw: this.pass });
      this.auth.user.set(r.user);
      this.auth.companies.set(r.companies);
      if (r.access) this.auth.access.set(r.access);
      if (r.user.must_change) {
        this.auth.companies.set([]);
        this.router.navigate(['/change-password']);
        return;
      }
      if (r.companies.length === 1) {
        await this.auth.switchCompany(r.companies[0].id);
        this.router.navigate(['/dashboard']);
      } else {
        this.router.navigate(['/company-picker']);
      }
    } catch (e) {
      this.err.set((e as ApiError).message);
      this.pass = '';
    } finally { this.busy = false; }
  }

  forgot() {
    this.err.set('');
    this.info.set('Ask your administrator to reset your password (Settings → Users → Reset password).');
  }
}
