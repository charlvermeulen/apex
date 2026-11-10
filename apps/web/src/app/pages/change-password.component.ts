import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiService, ApiError } from '../core/api';
import { AuthStore } from '../core/auth.store';

// Password change (legacy openChangePw/pwIssues + strength meter 2562–2581).
@Component({
  selector: 'app-change-password',
  imports: [FormsModule],
  styles: `:host{display:block} .pw-bar i{display:block;height:100%;width:0;transition:all .2s}`,
  template: `
  <div class="login-bg" style="display:flex">
    <div class="login-card" style="width:440px">
      <div class="logo-text" style="font-size:16px;margin-bottom:4px">Change password</div>
      <div class="logo-sub" style="margin-bottom:18px">{{sub}}</div>
      <form (ngSubmit)="save()" #f="ngForm">
        <div class="fg" style="margin-bottom:12px"><label>Current password</label>
          <div class="pw-wrap"><input type="password" [(ngModel)]="current" name="current" autocomplete="current-password"></div></div>
        <div class="fg" style="margin-bottom:4px"><label>New password</label>
          <div class="pw-wrap"><input type="password" [(ngModel)]="pw" name="pw" autocomplete="new-password" (ngModelChange)="strength()">
          <button type="button" class="pw-toggle" (click)="gen()"><i class="ti ti-wand"></i> Generate</button></div></div>
        <div class="pw-bar" [style.margin-top]="'6px'"><i [style.width.%]="score()*100/6" [style.background]="barColor()"></i></div>
        <div class="pw-hint">{{hint}}</div>
        <div class="btn-grp">
          <button class="btn btn-p" type="submit" [disabled]="busy()"><i class="ti ti-key"></i> Update password</button>
          @if (!mustChange) { <button class="btn btn-s" type="button" (click)="cancel()">Cancel</button> }
        </div>
      </form>
      <div class="login-err" [style.display]="err()?'block':'none'">{{err()}}</div>
    </div>
  </div>`,
})
export class ChangePasswordComponent {
  private api = inject(ApiService);
  private auth = inject(AuthStore);
  private router = inject(Router);

  current = ''; pw = '';
  mustChange = !!this.auth.user()?.must_change;
  sub = this.mustChange
    ? 'You are signing in with a temporary or demo password — set your own before continuing.'
    : 'Your password must be 8+ characters with upper and lower case, a number and a symbol, and contain no part of your username.';
  busy = signal(false);
  err = signal('');
  hint = '8+ characters with upper and lower case, a number and a symbol';

  score = signal(0); barColor = signal('var(--dn)');

  strength() {
    const p = this.pw || '';
    const i: string[] = [];
    if (p.length < 8) i.push('at least 8 characters');
    if (!/[a-z]/.test(p)) i.push('a lowercase letter');
    if (!/[A-Z]/.test(p)) i.push('an uppercase letter');
    if (!/\d/.test(p)) i.push('a number');
    if (!/[^A-Za-z0-9]/.test(p)) i.push('a symbol');
    const un = this.auth.user()?.username || '';
    if (un.length >= 3 && p.toLowerCase().includes(un.toLowerCase())) i.push('no part of the username');
    this.hint = p ? (i.length ? 'Needs: ' + i.join(', ') : 'Strong password') : '8+ characters with upper and lower case, a number and a symbol';
    const s = Math.max(0, 5 - i.filter((x) => !x.startsWith('no part')).length) + (p.length >= 12 ? 1 : 0);
    this.score.set(s);
    this.barColor.set(s <= 2 ? 'var(--dn)' : s <= 4 ? 'var(--wn)' : 'var(--ok)');
  }

  gen() {
    const U = 'ABCDEFGHJKLMNPQRSTUVWXYZ', L = 'abcdefghijkmnpqrstuvwxyz', D = '23456789', S = '!@#$%&*?', all = U + L + D + S;
    const pick = (set: string, r: number) => set[r % set.length];
    const raw = crypto.getRandomValues(new Uint8Array(12));
    const out = [pick(U, raw[0]), pick(L, raw[1]), pick(D, raw[2]), pick(S, raw[3])];
    for (let i = 4; i < 12; i++) out.push(pick(all, raw[i]));
    const sh = crypto.getRandomValues(new Uint8Array(12));
    for (let i = out.length - 1; i > 0; i--) { const j = sh[i] % (i + 1); [out[i], out[j]] = [out[j], out[i]]; }
    this.pw = out.join('');
    this.strength();
  }

  async save() {
    this.busy.set(true);
    this.err.set('');
    try {
      await this.api.post('/auth/change-password', { current: this.current, pw: this.pw });
      this.auth.user.update((u) => (u ? { ...u, must_change: false } : u));
      await this.auth.me(); // reload companies/access after must_change
      this.router.navigate(this.auth.company() ? ['/dashboard'] : ['/company-picker']);
    } catch (e) { this.err.set((e as ApiError).message); }
    finally { this.busy.set(false); }
  }

  cancel() { this.router.navigate(this.auth.company() ? ['/dashboard'] : ['/company-picker']); }
}
