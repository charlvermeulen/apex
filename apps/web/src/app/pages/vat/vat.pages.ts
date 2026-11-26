// VAT Returns module (legacy Numera.html 3977–4078 + page markup 1174–1207).
// One component hosts the three sections by route data tab (ModTabs drives the tab bar).
import { ChangeDetectorRef, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiError, ApiService, ToastService } from '../../core/api';
import { AuthStore } from '../../core/auth.store';
import { fmtD, fmtN } from '../../core/fmt';

const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// legacy vatLabel 3979
const vatLabel = (st: string, en: string): string => {
  const a = +st.slice(5, 7), b = +en.slice(5, 7), ya = st.slice(0, 4), yb = en.slice(0, 4);
  if (st.slice(0, 7) === en.slice(0, 7)) return `${MON3[a - 1]} ${ya}`;
  return ya === yb ? `${MON3[a - 1]}/${MON3[b - 1]} ${ya}` : `${MON3[a - 1]} ${ya} – ${MON3[b - 1]} ${yb}`;
};
// legacy 4023: {1:'Monthly',2:'Bi-monthly',6:'Six-monthly'} from the period's month length
const lenLabel = (p: { start: string; end: string }): string => {
  const len = 12 * (+p.end.slice(0, 4) - +p.start.slice(0, 4)) + (+p.end.slice(5, 7) - +p.start.slice(5, 7)) + 1;
  return ({ 1: 'Monthly', 2: 'Bi-monthly', 6: 'Six-monthly' } as Record<number, string>)[len] ?? len + '-month';
};

// next month of 'YYYY-MM' (legacy addMonths chain for the locked add input)
const ndm = (m: string): string => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
};

interface VatPeriod {
  id: string; start: string; end: string; status: 'open' | 'closed';
  closedAt?: string | null; closedBy?: string | null; submittedAt?: string | null;
  due: string; net: number; out: number; inn: number; nDocs: number; label: string; snap?: any;
}
interface VatDoc {
  date: string; doc: string; type: string; party: string; vatNo?: string | null;
  box: string; excl: number; vat: number; incl: number; out: boolean;
}

@Component({
  selector: 'app-vat',
  imports: [FormsModule],
  template: `
  <div class="sec-hdr"><div><div class="page-title">VAT Returns</div><div class="page-sub">VAT Act 89 of 1991 — SARS eFiling</div></div>
    <button class="btn btn-p btn-sm" (click)="submit()" [disabled]="submitDisabled()" [title]="submitTitle()"><i class="ti ti-send"></i> Submit to SARS</button></div>
  @if (tab !== 'periods') {
    <div class="card" style="margin-bottom:14px"><div class="fr"><div class="fg"><label>VAT period</label>
      <select [ngModel]="sel()" (ngModelChange)="pick($event)">
        @for (p of pers(); track p.id) { <option [value]="p.id">{{p.label}} ({{p.status}})</option> }
        @empty { <option value="">No VAT periods</option> } </select></div>
      <div class="fg"><label>Status</label><div style="padding-top:6px">
        @if (p(); as cur) { <span class="chip" [class.c-ok]="cur.status === 'open'" [class.c-nt]="cur.status !== 'open'">{{cur.status === 'open' ? 'Open' : 'Closed'}}</span>
          @if (cur.submittedAt) { <span class="chip c-bl">Submitted</span> } } @else { — }
      </div></div></div></div>
  }
  @switch (tab) {
    @case ('dash') {
      @if (p(); as cur) {
        <div class="vbox">
          <div class="vbox-ttl">{{cur.net < 0 ? 'Net VAT Refundable — ' : 'Net VAT Payable — '}}{{vatLabel(cur.start, cur.end)}}</div>
          <div class="vbox-val">R {{fmtN(Math.abs(cur.net))}}</div>
          <div style="font-size:12px;opacity:.75;margin-top:5px">Due {{fmtD(cur.due, true)}} · {{lenLabel(cur)}} · VAT No. {{auth.company()?.vat_no || 'not set'}}</div>
          <div class="vg">
            <div class="vi"><div class="vi-l">Output VAT Collected</div><div class="vi-v">R {{fmtN(cur.out)}}</div></div>
            <div class="vi"><div class="vi-l">Input VAT Claimable</div><div class="vi-v">R {{fmtN(cur.inn)}}</div></div>
            <div class="vi"><div class="vi-l">Effective Rate</div><div class="vi-v">{{rate()}}</div></div>
          </div>
        </div>
        <div class="card"><div class="card-title">VAT301 Return</div>
          <table><thead><tr><th>Field</th><th>Description</th><th class="tr">Amount Excl.</th><th class="tr">VAT</th><th>Code</th></tr></thead>
          <tbody>
            <tr><td>1A</td><td>Standard-rated supplies (15%)</td><td class="tr">R {{fmtN(fig()?.outEx ?? 0)}}</td><td class="tr">R {{fmtN(cur.out)}}</td><td><span class="chip c-bl">01</span></td></tr>
            <tr><td>1B</td><td>Zero-rated (s11)</td><td class="tr">R 0,00</td><td class="tr">R 0,00</td><td><span class="chip c-bl">02</span></td></tr>
            <tr><td>1C</td><td>Exempt (s12)</td><td class="tr">R 0,00</td><td class="tr">R 0,00</td><td><span class="chip c-gr">—</span></td></tr>
            <tr class="tt"><td>1D</td><td>Total Output VAT</td><td></td><td class="tr">R {{fmtN(cur.out)}}</td><td></td></tr>
            <tr style="background:var(--bg2)"><td>2A</td><td>Input VAT on purchases</td><td class="tr">R {{fmtN(fig()?.inEx ?? 0)}}</td><td class="tr">R {{fmtN(cur.inn)}}</td><td><span class="chip c-bl">01</span></td></tr>
            <tr class="tt"><td colspan="3">{{cur.net < 0 ? 'Net VAT Refundable' : 'Net VAT Payable'}}</td><td class="tr" style="color:var(--wn)">R {{fmtN(Math.abs(cur.net))}}</td><td></td></tr>
          </tbody></table></div>
      } @else {
        <div class="vbox"><div class="vbox-ttl">No VAT period</div><div class="vbox-val">R 0</div>
          <div style="font-size:12px;opacity:.75;margin-top:5px">Add a VAT period under VAT Periods.</div></div>
      }
    }
    @case ('detail') {
      <div class="notice"><i class="ti ti-info-circle"></i> <div>Every VAT-bearing document in the selected period: sales and contract invoices and credit notes (output, box 1A) and supplier invoices and debit notes (input, box 2A). VAT is taken at 15% from the VAT-inclusive document totals; credit and debit notes show as negatives.</div></div>
      <div class="card"><div class="card-title">VAT Detail <span style="display:flex;gap:8px;align-items:center">
        <select [(ngModel)]="type" style="width:auto">
          <option value="">Output and input</option><option value="out">Output VAT only</option><option value="in">Input VAT only</option></select></span></div>
        <table><thead><tr><th>Date</th><th>Document</th><th>Type</th><th>Customer / Supplier</th><th>VAT No.</th><th>Box</th><th class="tr">Excl. VAT</th><th class="tr">VAT</th><th class="tr">Incl. VAT</th></tr></thead><tbody>
          @for (x of rows(); track x.doc) {
            <tr><td>{{fmtD(x.date, true)}}</td><td>{{x.doc}}</td><td><span class="chip" [class.c-bl]="x.out" [class.c-nt]="!x.out">{{x.type}}</span></td>
              <td>{{x.party}}</td><td>{{x.vatNo || '—'}}</td><td>{{x.box}}</td>
              <td class="tr">{{fmtN(x.excl)}}</td><td class="tr">{{fmtN(x.vat)}}</td><td class="tr">{{fmtN(x.incl)}}</td></tr>
          } @empty { <tr><td colspan="9" style="text-align:center;color:var(--txm)">No VAT documents in this period.</td></tr> }
          <tr class="tt"><td colspan="7">Output VAT (1A)</td><td class="tr">R {{fmtN(fig()?.out ?? 0)}}</td><td></td></tr>
          <tr class="tt"><td colspan="7">Input VAT (2A)</td><td class="tr">R {{fmtN(fig()?.inn ?? 0)}}</td><td></td></tr>
          <tr class="tt"><td colspan="7">{{(fig()?.net ?? 0) < 0 ? 'Net VAT refundable' : 'Net VAT payable'}}</td><td class="tr">R {{fmtN(Math.abs(fig()?.net ?? 0))}}</td><td></td></tr>
        </tbody></table></div>
    }
    @case ('periods') {
      <div class="notice"><i class="ti ti-info-circle"></i> <div>Documents dated in a <strong>closed</strong> VAT period cannot be posted. Closing freezes the period's VAT figures. A period can only be closed after it has ended, and once the one before it is closed. Only an administrator can reopen the latest closed period, and not once it has been submitted.</div></div>
      <div class="card" style="margin-bottom:16px"><div class="card-title">Add VAT Period</div>
        <div class="fr3">
          <div class="fg"><label>{{last ? 'Starts (follows the last period)' : 'Starts'}}</label>
            <input type="month" [ngModel]="last ? last.next : newMonth" (ngModelChange)="newMonth = $event" [disabled]="!!last"></div>
          <div class="fg"><label>Length</label><select [(ngModel)]="len">
            <option value="1">Monthly</option><option value="2" selected>Bi-monthly (Category B)</option><option value="6">Six-monthly (Category C)</option></select></div>
          <div class="fg"><label>&nbsp;</label><button class="btn btn-p" (click)="add()"><i class="ti ti-plus"></i> Add Period</button></div></div>
        <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div></div>
      <div class="card"><div class="card-title">VAT Periods</div>
        <table><thead><tr><th>Period</th><th>Dates</th><th>Due</th><th>Status</th><th class="tr">Net VAT</th><th style="width:230px">Actions</th></tr></thead><tbody>
          @for (p of pers(); track p.id) {
            <tr><td><strong>{{p.label}}</strong></td><td>{{fmtD(p.start, true)}} – {{fmtD(p.end, true)}}</td><td>{{fmtD(p.due, true)}}</td>
              <td><span class="chip" [class.c-ok]="p.status === 'open'" [class.c-nt]="p.status !== 'open'">{{p.status === 'open' ? 'Open' : 'Closed'}}</span>
                @if (p.submittedAt) { <span class="chip c-bl">Submitted</span> }</td><td class="tr">R {{fmtN(p.net)}}</td>
              <td>@if (p.status === 'open') { <button class="btn btn-s btn-sm" (click)="close(p)"><i class="ti ti-lock"></i> Close</button>
                } @else { <button class="btn btn-s btn-sm" (click)="reopen(p)"><i class="ti ti-lock-open"></i> Open</button> }
                <button class="btn btn-s btn-sm" (click)="view(p)"><i class="ti ti-eye"></i> View</button></td></tr>
          } @empty { <tr><td colspan="6" style="text-align:center;color:var(--txm)">No VAT periods yet. Add the first one above.</td></tr> }
        </tbody></table></div>
    }
  }`,
})
export class VatComponent {
  fmtD = fmtD; fmtN = fmtN;
  vatLabel = vatLabel; lenLabel = lenLabel; Math = Math;
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  auth = inject(AuthStore);
  route = inject(ActivatedRoute);
  router = inject(Router);
  tab = (this.route.snapshot.data as { tab?: string }).tab ?? 'dash';

  pers = signal<VatPeriod[]>([]);
  sel = signal('');
  docs: VatDoc[] = [];
  detailFig: any = null;
  type = '';
  newMonth = ''; len = '2'; last: any = null;
  err = signal('');

  p = () => this.pers().find((x) => x.id === this.sel()) ?? null;
  fig = () => this.p()?.snap ?? this.detailFig;
  rows = () => this.docs.filter((x) => !this.type || (this.type === 'out') === x.out);
  rate = () => {
    const f = this.fig(), cur = this.p();
    return f && f.outEx ? (cur!.out / f.outEx * 100).toFixed(1) + '%' : '—';
  };
  submitDisabled = () => !this.p() || this.p()!.status !== 'closed' || !!this.p()!.submittedAt;
  submitTitle = () => !this.p() ? '' : this.p()!.status !== 'closed' ? 'Close the period first' : this.p()!.submittedAt ? 'Already submitted' : '';

  constructor() { void this.reload(); }

  async reload() {
    const ps = await this.api.get<VatPeriod[]>('/vat/periods');
    this.pers.set(ps);
    if (!ps.some((x) => x.id === this.sel()))
      this.sel.set((ps.find((x) => x.status === 'open') || ps[0] || ({} as VatPeriod)).id || '');
    // legacy 4042: the add input locks to the month after the latest period (list is start-desc)
    const l = ps[0];
    if (l) {
      this.last = { next: ndm(String(l.end).slice(0, 7)) };
    } else this.last = null;
    this.cdr.detectChanges();
    if (this.sel()) { void this.pick(this.sel()); this.cdr.detectChanges(); }
  }

  async pick(id: string) {
    this.sel.set(id);
    this.detailFig = null; this.docs = [];
    if (this.p()) {
      const r = await this.api.get<{ docs: VatDoc[]; figures: any }>('/vat/detail?id=' + this.sel());
      this.detailFig = r.figures; this.docs = r.docs;
    }
    this.cdr.detectChanges();
  }

  view(p: VatPeriod) { this.router.navigateByUrl('/vat/dash'); void this.pick(p.id); }

  async add() {
    this.err.set('');
    const m = this.last ? this.last.next : this.newMonth;
    try {
      await this.api.post('/vat/periods', { m, len: Number(this.len) });
      await this.reload();
      const np = this.pers().find((x) => x.id === m);
      this.toast.show('VAT period ' + (np ? np.label : m) + ' added.');
    } catch (e) { this.err.set((e as ApiError).message); }
  }

  async close(p: VatPeriod) {
    if (!confirm(`Close VAT period ${p.label}?\n\nOutput VAT R ${fmtN(p.out)}, input VAT R ${fmtN(p.inn)}, net R ${fmtN(p.net)}.\nDocuments dated in this period can then no longer be posted.`)) return;
    this.err.set('');
    try { await this.api.post('/vat/periods/' + p.id + '/close'); this.toast.show('VAT period closed.'); await this.reload(); }
    catch (e) { this.err.set((e as ApiError).message); alert((e as ApiError).message); }
  }

  async reopen(p: VatPeriod) {
    if (!confirm(`Reopen VAT period ${p.label}? Its figures will be recalculated and documents can be posted in it again.`)) return;
    this.err.set('');
    try { await this.api.post('/vat/periods/' + p.id + '/reopen'); this.toast.show('VAT period reopened.'); await this.reload(); }
    catch (e) { this.err.set((e as ApiError).message); alert((e as ApiError).message); }
  }

  async submit() {
    const p = this.p();
    if (!p) return;
    if (p.status !== 'closed') { alert('Close the VAT period before submitting.'); return; }
    if (p.submittedAt) return;
    if (!confirm(`Submit the VAT201 for ${p.label} to SARS?\n\nThis prototype is not connected to SARS eFiling: the submission is only recorded here.`)) return;
    try { await this.api.post('/vat/periods/' + p.id + '/submit'); this.toast.show('Recorded as submitted (not sent to SARS in this prototype).'); await this.reload(); }
    catch (e) { this.toast.show((e as ApiError).message); }
  }
}
