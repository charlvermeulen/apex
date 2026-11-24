import { Component, ChangeDetectorRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, ApiError, ToastService } from '../../core/api';
import { fmtR, fmtD, stkDate, todayIso } from '../../core/fmt';

interface Cat { code: string; name: string; gl: string; cos: string; sales: string; active: boolean; items: number; }
interface Item { sku: string; name: string; cat: string; catName: string; unit: string; cost: number; sell: number; open: number; reo: number; roq: number; bin: string; bar: string; notes: string; vat: string; sup: string | null; supName: string; moves: number; }
const qty = (i: Item) => (i.open || 0) + (i.moves || 0);
const UNITS = ['Each', 'Box', 'Ream', 'Pack', 'Litre', 'Kg', 'Metre'];
const IVATS = ['Standard 15%', 'Zero-Rated 0%', 'Exempt'];

// ── Inventory Items (renderStkList + ii-stats) ──
@Component({
  selector: 'app-inv-items', imports: [FormsModule],
  template: `
  <div class="st-r2">
    <div class="stat-card"><div class="stat-lbl">Total Items</div><div class="stat-val">{{st().n}}</div><div class="stat-sub">Across {{st().cats}} categor{{st().cats === 1 ? 'y' : 'ies'}}</div></div>
    <div class="stat-card"><div class="stat-lbl">Total Stock Value</div><div class="stat-val">{{fmtR(st().v)}}</div><div class="stat-sub">At cost (FIFO)</div></div>
    <div class="stat-card"><div class="stat-lbl">Low Stock Alerts</div><div class="stat-val" style="color:var(--wn)">{{st().low}}</div><div class="stat-sub">5 or fewer on hand</div></div>
    <div class="stat-card"><div class="stat-lbl">Out of Stock</div><div class="stat-val" style="color:var(--dn)">{{st().out}}</div><div class="stat-sub">Reorder required</div></div>
  </div>
  <div class="card">
    <table><thead><tr><th>SKU</th><th>Item Name</th><th>Category</th><th>Unit</th><th class="tr">Cost Price</th><th class="tr">Sell Price (Excl.)</th><th class="tr">On Hand</th><th class="tr">Value</th><th>Status</th></tr></thead>
    <tbody>
      @for (g of groups(); track g.cat) {
        <tr class="ts"><td colspan="9">{{g.cat}} — {{g.gname}}</td></tr>
        @for (i of g.rows; track i.sku) {
          <tr>
            <td>{{i.sku}}</td><td><strong>{{i.name}}</strong></td><td>{{g.gname}}</td><td>{{i.unit}}</td>
            <td class="tr">{{fmtR(i.cost)}}</td><td class="tr">{{fmtR(i.sell)}}</td>
            <td class="tr">{{qtyOf(i)}}</td><td class="tr">{{fmtR(qtyOf(i) * i.cost)}}</td>
            <td><span class="chip" [class.c-dn]="stOf(i) === 'Out of Stock'" [class.c-wn]="stOf(i) === 'Low Stock'" [class.c-ok]="stOf(i) === 'In Stock'">{{stOf(i)}}</span></td>
          </tr>
        }
      }
      @empty { <tr><td colspan="9" style="text-align:center;color:var(--txm)">No inventory items yet. Add one under Add Item.</td></tr> }
    </tbody></table>
  </div>`,
})
export class InvItemsComponent {
  fmtR = fmtR; qtyOf = qty;
  private api = inject(ApiService);
  private cdr = inject(ChangeDetectorRef);
  items = signal<Item[]>([]);
  cats = signal<Cat[]>([]);
  constructor() { void this.reload(); }
  async reload() {
    const [i, c] = await Promise.all([this.api.get<Item[]>('/inv/items'), this.api.get<Cat[]>('/inv/categories')]);
    this.items.set(i); this.cats.set(c); this.cdr.detectChanges();
  }
  groups = computed(() => {
    const cs = new Map(this.cats().map((c) => [c.code, c.name]));
    return [...this.items()].sort((a, b) => (a.cat < b.cat ? -1 : a.cat > b.cat ? 1 : a.sku < b.sku ? -1 : 1))
      .reduce<{ cat: string; gname: string; rows: Item[] }[]>((acc, i) => {
        const last = acc[acc.length - 1];
        if (last && last.cat === i.cat) last.rows.push(i);
        else acc.push({ cat: i.cat, gname: cs.get(i.cat) ?? i.catName, rows: [i] });
        return acc;
      }, []);
  });
  stOf = (i: Item) => qty(i) <= 0 ? 'Out of Stock' : qty(i) <= 5 ? 'Low Stock' : 'In Stock';
  st = () => {
    const l = this.items();
    return {
      n: l.length, cats: new Set(l.map((i) => i.cat)).size,
      v: l.reduce((s, i) => s + qty(i) * i.cost, 0),
      low: l.filter((i) => qty(i) > 0 && qty(i) <= 5).length,
      out: l.filter((i) => qty(i) <= 0).length,
    };
  };
}

// ── Categories (renderCats + saveCat port) ──
@Component({
  selector: 'app-inv-cats', imports: [FormsModule],
  template: `
  <div class="card" style="margin-bottom:16px">
    <div class="card-title">Inventory Categories
      <button class="btn btn-p btn-sm" (click)="edit(null)"><i class="ti ti-plus"></i> Add Category</button></div>
    @if (editing()) {
      <div class="card" style="margin:0 0 14px;border-color:var(--ac)">
        <div class="card-title">{{edCode() ? 'Edit Category — ' + edCode() : 'Add Inventory Category'}}</div>
        <div class="fr">
          <div class="fg"><label>Category Name *</label><input [(ngModel)]="f.name" maxlength="40"></div>
          <div class="fg"><label>Category Code</label><input value="Auto (CAT-…)" disabled></div></div>
        <div class="fr">
          <div class="fg"><label>Status</label><select [ngModel]="f.active" (ngModelChange)="f.active = $event === 'true'">
            <option [value]="true">Active</option><option [value]="false">Inactive</option></select></div></div>
        <div class="fr">
          <div class="fg"><label>GL Account for Inventory *</label><select [(ngModel)]="f.gl">
            <option value="">— Select —</option>
            @for (a of accs(); track a.code) { <option [value]="a.code">{{a.code}} — {{a.name}}</option> }</select></div>
          <div class="fg"><label>GL Account for Cost of Sales *</label><select [(ngModel)]="f.cos">
            <option value="">— Select —</option>
            @for (a of accs(); track a.code) { <option [value]="a.code">{{a.code}} — {{a.name}}</option> }</select></div></div>
        <div class="fr">
          <div class="fg"><label>GL Account for Sales *</label><select [(ngModel)]="f.sales">
            <option value="">— Select —</option>
            @for (a of accs(); track a.code) { <option [value]="a.code">{{a.code}} — {{a.name}}</option> }</select></div></div>
        <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
        <div class="btn-grp"><button class="btn btn-p" (click)="save()" [disabled]="busy()"><i class="ti ti-device-floppy"></i> Save Category</button>
          <button class="btn btn-s" (click)="editing.set(false)">Cancel</button></div>
      </div>
    }
    <table><thead><tr><th>Cat. Code</th><th>Category Name</th><th>GL Accounts</th><th class="tr">Items</th><th>Status</th><th style="width:150px">Action</th></tr></thead>
    <tbody>
      @for (c of cats(); track c.code) {
        <tr><td>{{c.code}}</td><td><strong>{{c.name}}</strong></td>
          <td>{{c.gl}} · {{c.cos}} · {{c.sales}}</td><td class="tr">{{c.items}}</td>
          <td><span class="chip" [class.c-ok]="c.active" [class.c-nt]="!c.active">{{c.active ? 'Active' : 'Inactive'}}</span></td>
          <td><button class="btn btn-s btn-sm" (click)="edit(c)">Edit</button>
            @if (!c.items) { <button class="btn btn-s btn-sm" (click)="del(c)">Delete</button> }</td></tr>
      } @empty { <tr><td colspan="6" style="text-align:center;color:var(--txm)">No categories yet.</td></tr> }
    </tbody></table>
  </div>`,
})
export class InvCatsComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  cats = signal<Cat[]>([]);
  accs = signal<{ code: string; name: string }[]>([]);
  editing = signal(false); busy = signal(false); err = signal('');
  edCode = signal('');
  f = { name: '', active: true, gl: '', cos: '', sales: '' };

  constructor() { void this.reload(); }
  async reload() {
    const [c, a] = await Promise.all([this.api.get<Cat[]>('/inv/categories'), this.api.get<{ code: string; name: string }[]>('/gl/accounts')]);
    this.cats.set(c); this.accs.set(a); this.cdr.detectChanges();
  }
  edit(c: Cat | null) {
    this.edCode.set(c ? c.code : '');
    this.f = c ? { name: c.name, active: c.active, gl: c.gl, cos: c.cos, sales: c.sales } : { name: '', active: true, gl: '', cos: '', sales: '' };
    this.err.set(''); this.editing.set(true); this.cdr.detectChanges();
  }
  async save() {
    this.err.set(''); this.busy.set(true);
    const p = { name: this.f.name.trim(), gl: this.f.gl, cos: this.f.cos, sales: this.f.sales, active: this.f.active };
    try {
      const code = this.edCode();
      if (code) await this.api.patch('/inv/categories/' + code, p);
      else await this.api.post('/inv/categories', p);
      this.toast.show('Category ' + this.f.name + ' saved.');
      this.editing.set(false); await this.reload();
    } catch (e) { this.err.set((e as ApiError).message); }
    finally { this.busy.set(false); this.cdr.detectChanges(); }
  }
  async del(c: Cat) {
    if (!confirm('Delete category ' + c.code + ' — ' + c.name + '?')) return;
    try { await this.api.del('/inv/categories/' + c.code); await this.reload(); this.toast.show('Category deleted.'); }
    catch (e) { this.toast.show((e as ApiError).message); }
  }
}

// ── Add Item (applyStkX port) ──
@Component({
  selector: 'app-inv-item-add', imports: [FormsModule],
  template: `
  <div class="card">
    <div class="card-title">Add Inventory Item</div>
    <div class="fr">
      <div class="fg"><label>Item Name *</label><input [(ngModel)]="f.name" maxlength="80"></div>
      <div class="fg"><label>SKU / Item Code *</label><input [(ngModel)]="f.sku" maxlength="20" placeholder="e.g. OE-003"></div></div>
    <div class="fr">
      <div class="fg"><label>Category *</label><select [(ngModel)]="f.cat">
        <option value="">— Select —</option>
        @for (c of cats(); track c.code) { <option [value]="c.code">{{c.name}}</option> }</select></div>
      <div class="fg"><label>Supplier (default)</label><select [(ngModel)]="f.sup">
        <option value="">— None —</option>
        @for (s of sups(); track s.code) { <option [value]="s.code">{{s.name}}</option> }</select></div></div>
    <div class="fr">
      <div class="fg"><label>Unit of Measure</label><select [(ngModel)]="f.unit">
        @for (u of UNITS; track u) { <option [value]="u">{{u}}</option> }</select></div>
      <div class="fg"><label>VAT on Sales</label><select [(ngModel)]="f.vat">
        @for (v of IVATS; track v) { <option [value]="v">{{v}}</option> }</select></div></div>
    <div class="fr">
      <div class="fg"><label>Cost Price (Excl.) *</label><input type="number" min="0" step="0.01" [(ngModel)]="f.cost"></div>
      <div class="fg"><label>Sell Price (Excl.)</label><input type="number" min="0" step="0.01" [(ngModel)]="f.sell"></div></div>
    <div class="fr">
      <div class="fg"><label>Opening Stock Qty</label><input type="number" min="0" step="1" [(ngModel)]="f.open"></div>
      <div class="fg"><label>Reorder Level</label><input type="number" min="0" step="any" [(ngModel)]="f.reo"></div></div>
    <div class="fr">
      <div class="fg"><label>Reorder Qty</label><input type="number" min="0" step="any" [(ngModel)]="f.roq"></div>
      <div class="fg"><label>Bin / Location</label><input [(ngModel)]="f.bin" maxlength="40"></div></div>
    <div class="fr">
      <div class="fg"><label>Barcode / EAN</label><input [(ngModel)]="f.bar" maxlength="30"></div>
      <div class="fg"><label>Notes</label><input [(ngModel)]="f.notes" maxlength="120"></div></div>
    <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
    <div class="btn-grp"><button class="btn btn-p" (click)="save()" [disabled]="busy()"><i class="ti ti-device-floppy"></i> Save Item</button>
      <button class="btn btn-s" (click)="clear()">Clear</button></div>
  </div>`,
})
export class InvItemAddComponent {
  UNITS = UNITS; IVATS = IVATS;
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  cats = signal<Cat[]>([]); sups = signal<{ code: string; name: string }[]>([]);
  busy = signal(false); err = signal('');
  f = { name: '', sku: '', cat: '', sup: '', unit: 'Each', cost: 0, sell: 0, open: 0, vat: 'Standard 15%', reo: 0, roq: 0, bin: '', bar: '', notes: '' };

  constructor() { void this.reload(); }
  async reload() {
    const [c, s] = await Promise.all([this.api.get<Cat[]>('/inv/categories'), this.api.get<{ code: string; name: string }[]>('/suppliers')]);
    this.cats.set(c.filter((x) => x.active)); this.sups.set(s); this.cdr.detectChanges();
  }
  clear() { this.f = { name: '', sku: '', cat: '', sup: '', unit: 'Each', cost: 0, sell: 0, open: 0, vat: 'Standard 15%', reo: 0, roq: 0, bin: '', bar: '', notes: '' }; this.err.set(''); }
  async save() {
    this.err.set(''); this.busy.set(true);
    try {
      const r = await this.api.post<{ sku: string }>('/inv/items', {
        name: this.f.name, sku: this.f.sku, cat: this.f.cat, unit: this.f.unit, cost: Number(this.f.cost), sell: Number(this.f.sell),
        open: Math.round(Number(this.f.open)), vat: this.f.vat, sup: this.f.sup || null, reo: Number(this.f.reo), roq: Number(this.f.roq),
        bin: this.f.bin, bar: this.f.bar, notes: this.f.notes,
      });
      this.toast.show('Item ' + r.sku + ' saved.'); this.clear();
    } catch (e) { this.err.set((e as ApiError).message); }
    finally { this.busy.set(false); this.cdr.detectChanges(); }
  }
}

// ── Item Enquiry — Stock Card (renderStk port) ──
@Component({
  selector: 'app-inv-card', imports: [FormsModule],
  template: `
  <div class="card" style="margin-bottom:12px"><div class="card-title">Item Enquiry — Stock Card</div>
    <div class="fr">
      <div class="fg"><label>Item</label><select [(ngModel)]="sku" (ngModelChange)="load()">
        <option value="">— Select —</option>
        @for (i of items(); track i.sku) { <option [value]="i.sku">{{i.sku}} — {{i.name}}</option> }</select></div>
      <div class="fg"><label>From date</label><input type="date" [(ngModel)]="from" (ngModelChange)="load()"></div>
      <div class="fg"><label>To date</label><input type="date" [(ngModel)]="to" (ngModelChange)="load()"></div></div></div>
  @if (d()) {
    <div class="st-r3">
      <div class="stat-card"><div class="stat-lbl">Item</div><div class="stat-val" style="font-size:18px">{{dd().sku}} — {{dd().name}}</div><div class="stat-sub">Stock card</div></div>
      <div class="stat-card"><div class="stat-lbl">Qty on Hand</div><div class="stat-val">{{dd().closing}}</div><div class="stat-sub">At {{fmtR(dd().cost)}} each</div></div>
      <div class="stat-card"><div class="stat-lbl">Stock Value</div><div class="stat-val">{{fmtR(dd().value)}}</div><div class="stat-sub">At cost (FIFO)</div></div>
    </div>
    <div class="card"><table><thead><tr><th>Date</th><th>Reference</th><th>Description</th><th class="tr">Qty In</th><th class="tr">Qty Out</th><th class="tr">Qty on Hand</th></tr></thead>
    <tbody>
      <tr><td>{{stkDate(from || first())}}</td><td>Opening Balance</td><td></td><td></td><td></td><td class="tr">{{dd().opening}}</td></tr>
      @for (r of dd().rows; track $index) {
        <tr><td>{{stkDate(r.date)}}</td><td>{{r.ref}}</td><td>{{r.desc}}</td>
          <td class="tr">{{r.in || ''}}</td><td class="tr">{{r.out || ''}}</td><td class="tr">{{r.bal}}</td></tr>
      }
      @if (dd().rows.length === 0) { <tr><td colspan="6" style="text-align:center;color:var(--txm)">No movements this period.</td></tr> }
      <tr class="tg"><td colspan="4">Closing</td><td></td><td class="tr">{{dd().closing}}</td></tr>
    </tbody></table></div>
  }`,
})
export class InvCardComponent {
  fmtR = fmtR; stkDate = stkDate;
  private api = inject(ApiService);
  private cdr = inject(ChangeDetectorRef);
  items = signal<{ sku: string; name: string }[]>([]);
  sku = ''; from = ''; to = '';
  private r = signal<{ sku: string; name: string; cost: number; opening: number; rows: { date: string; ref: string; desc: string; in: number; out: number; bal: number }[]; closing: number; value: number } | null>(null);
  d = () => this.r();
  dd = () => this.r()!;

  constructor() { void this.reload(); }
  async reload() { this.items.set(await this.api.get('/inv/items')); this.cdr.detectChanges(); }
  first = () => this.r()?.rows?.[0]?.date ?? '';
  async load() {
    if (!this.sku) { this.r.set(null); this.cdr.detectChanges(); return; }
    const qs = this.from || this.to ? '?from=' + this.from + '&to=' + this.to : '';
    this.r.set(await this.api.get('/inv/items/' + this.sku + '/card' + qs)); this.cdr.detectChanges();
  }
}

// ── Stock Valuation (fillReports port) ──
@Component({
  selector: 'app-inv-val', imports: [],
  template: `
  <div class="card"><div class="card-title">Stock Valuation by Category <span style="font-size:12px;font-weight:400;color:var(--txm)">As at {{todayIso()}} · at cost (FIFO)</span></div>
    <table><thead><tr><th>Category</th><th class="tr">Items</th><th class="tr">Value at Cost</th><th class="tr">% of Total</th></tr></thead>
    <tbody>
      @for (g of groups(); track g.cat) {
        <tr><td>{{g.cat}}</td><td class="tr">{{g.n}}</td><td class="tr">{{fmtR(g.v)}}</td><td class="tr">{{pct(g.v)}}</td></tr>
      } @empty { <tr><td colspan="4" style="text-align:center;color:var(--txm)">No inventory items yet.</td></tr> }
      <tr class="tg"><td>Total (agrees to GL 6200)</td><td class="tr">{{st().n}}</td><td class="tr">{{fmtR(st().v)}}</td><td class="tr">100%</td></tr>
    </tbody></table>
  </div>`,
})
export class InvValComponent {
  fmtR = fmtR; todayIso = todayIso;
  private api = inject(ApiService);
  private cdr = inject(ChangeDetectorRef);
  items = signal<Item[]>([]);
  constructor() { void this.load(); }
  async load() { this.items.set(await this.api.get<Item[]>('/inv/items')); this.cdr.detectChanges(); }
  groups = computed(() => {
    const byCat = new Map<string, Item[]>();
    [...this.items()].forEach((i) => { const a = byCat.get(i.catName) ?? []; a.push(i); byCat.set(i.catName, a); });
    return [...byCat.entries()].map(([cat, rows]) => ({ cat, n: rows.length, v: rows.reduce((s, i) => s + qty(i) * i.cost, 0) }))
      .sort((a, b) => (a.cat < b.cat ? -1 : 1));
  });
  st = () => { const l = this.items(); return { n: l.length, v: l.reduce((s, i) => s + qty(i) * i.cost, 0) }; };
  pct = (v: number) => { const t = this.st().v; return t ? Math.round(v / t * 100) + '%' : '0%'; };
}

// ── Part Requests (legacy pq 5148–5177) — inventory ▸ transactions ──
interface Preq { code: string; date: string; sku: string; itemName: string; qty: number; by: string; byName: string; wo: string; notes: string; status: string; issued: string | null; cost: number | null }

@Component({
  selector: 'app-inv-preq',
  imports: [FormsModule],
  template: `
  <div class="g3" style="grid-template-columns:repeat(3,1fr)">
    <div class="card"><div class="stat-lbl">Awaiting issue</div><div class="stat-val">{{stats().req}}</div></div>
    <div class="card"><div class="stat-lbl">Issued</div><div class="stat-val">{{stats().iss}}</div></div>
    <div class="card"><div class="stat-lbl">Cancelled</div><div class="stat-val">{{stats().can}}</div></div></div>
  <div class="card"><div class="card-title">Part Requests <button class="btn btn-p btn-sm" (click)="open()">New Part Request</button></div>
    <table><thead><tr><th>Request</th><th>Item</th><th class="tr">Qty</th><th>Requested by</th><th>Work order</th><th>Date</th><th>Status</th><th style="width:170px"></th></tr></thead><tbody>
      @for (r of reqs(); track r.code) {
        <tr><td><strong>{{r.code}}</strong></td><td>{{r.sku}} — {{r.itemName}}</td><td class="tr">{{r.qty}}</td><td>{{r.byName || '—'}}</td><td>{{r.wo || '—'}}</td>
          <td>{{fmtD(r.date,1)}}</td>
          <td><span class="chip {{r.status === 'Requested' ? 'c-wn' : r.status === 'Issued' ? 'c-ok' : 'c-nt'}}">{{r.status}}</span></td>
          <td>@if (r.status === 'Requested') { <button class="btn btn-p btn-sm" (click)="issue(r)">Issue</button> <button class="btn btn-s btn-sm" (click)="cancel(r)">Cancel</button> }</td></tr>
      } @empty { <tr><td colspan="8" style="color:var(--txm)">No part requests yet.</td></tr> }
    </tbody></table></div>
  @if (isOpen()) {
    <div class="modal-bg" style="display:block" (click)="close($event)">
      <div class="modal" style="max-width:520px" (click)="$event.stopPropagation()">
        <div class="rm-hd"><strong>New Part Request</strong><button class="btn btn-s btn-sm" (click)="close()">✕</button></div>
        <div class="fr"><div class="fg"><label>Item *</label><select [(ngModel)]="f.sku" (ngModelChange)="avail()"><option value="">Select item…</option>
            @for (i of items(); track i.sku) { <option [value]="i.sku">{{i.sku}} — {{i.name}}</option> }</select></div>
          <div class="fg"><label>Available</label><input [value]="f.av" disabled></div></div>
        <div class="fr3">
          <div class="fg"><label>Quantity *</label><input type="number" min="0" step="1" [(ngModel)]="f.qty"></div>
          <div class="fg"><label>Date *</label><input type="date" [(ngModel)]="f.date"></div>
          <div class="fg"><label>Requested by</label><select [(ngModel)]="f.by"><option value="">— None —</option>
            @for (e of staff(); track e.code) { @if (e.active) { <option [value]="e.code">{{e.name}}</option> } }</select></div></div>
        <div class="fr"><div class="fg"><label>Work order (optional)</label><select [(ngModel)]="f.wo"><option value="">— None —</option>
            @for (w of openWos(); track w.code) { <option [value]="w.code">{{w.code}}</option> }</select></div>
          <div class="fg" style="grid-column:span 2"><label>Notes</label><input [(ngModel)]="f.notes" maxlength="120"></div></div>
        <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
        <div class="btn-grp"><button class="btn btn-p" (click)="save()">Save Request</button> <button class="btn btn-s" (click)="close()">Cancel</button></div>
      </div></div>
  }`,
})
export class InvPreqComponent {
  fmtD = fmtD; fmtR = fmtR; cdr = inject(ChangeDetectorRef);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  reqs = signal<Preq[]>([]); items = signal<{ sku: string; name: string; cost: number }[]>([]); staff = signal<{ code: string; name: string; active: boolean }[]>([]); openWosList = signal<{ code: string; status: string }[]>([]);
  isOpen = signal(false); err = signal('');
  f = { sku: '', qty: 1, date: todayIso(), by: '', wo: '', notes: '', av: '' };

  constructor() { void this.reload(); }
  stats = () => ({ req: this.reqs().filter((r) => r.status === 'Requested').length, iss: this.reqs().filter((r) => r.status === 'Issued').length, can: this.reqs().filter((r) => r.status === 'Cancelled').length });
  openWos = () => this.openWosList();
  open() { this.f = { sku: '', qty: 1, date: todayIso(), by: '', wo: '', notes: '', av: '' }; this.isOpen.set(true); this.err.set(''); this.cdr.detectChanges(); }
  close(e?: MouseEvent) { if (!e || (e.target as HTMLElement).classList.contains('modal-bg')) this.isOpen.set(false); this.cdr.detectChanges(); }
  async reload() {
    const [reqs, items, staff, wos] = await Promise.all([
      this.api.get<Preq[]>('/parts/requests'), this.api.get<{ sku: string; name: string; cost: number }[]>('/inv/items'),
      this.api.get<{ code: string; name: string; active: boolean }[]>('/techs'),
      this.api.get<{ code: string; status: string }[]>('/workorders').catch(() => [] as { code: string; status: string }[]),
    ]);
    this.reqs.set(reqs); this.items.set(items); this.staff.set(staff);
    this.openWosList.set(wos.filter((w) => w.status !== 'Completed' && w.status !== 'Cancelled'));
    this.cdr.detectChanges();
  }
  avail() {
    // pqAvailQty 5149 — real check happens server-side at issue
    void this.api.get<{ out: number }>('/parts/avail?sku=' + encodeURIComponent(this.f.sku)).then((r) => { this.f.av = String(r.out); this.cdr.detectChanges(); }).catch(() => {});
  }
  async issue(r: Preq) {
    try { await this.api.post('/parts/requests/' + r.code + '/issue'); this.toast.show(r.code + ' issued' + (r.wo ? ' to Work in Progress.' : '.')); await this.reload(); }
    catch (e) { this.toast.show((e as ApiError).message); }
  }
  async cancel(r: Preq) {
    if (!confirm('Cancel ' + r.code + '?')) return;
    try { await this.api.post('/parts/requests/' + r.code + '/cancel'); await this.reload(); }
    catch (e) { this.toast.show((e as ApiError).message); }
  }
  async save() {
    this.err.set('');
    try {
      const r = await this.api.post<{ code: string }>('/parts/requests', { sku: this.f.sku, qty: this.f.qty, by: this.f.by, wo: this.f.wo, date: this.f.date, notes: this.f.notes });
      this.toast.show(r.code + ' saved.');
      this.isOpen.set(false);
      await this.reload();
    } catch (e) { this.err.set((e as ApiError).message); this.cdr.detectChanges(); }
  }
}

// ── Part Returns (legacy pr 5178–5192) ──
interface Pret { code: string; req: string; sku: string; qty: number; cond: string; reason: string; date: string }

@Component({
  selector: 'app-inv-pret',
  imports: [FormsModule],
  template: `
  <div class="card"><div class="card-title">Part Returns <button class="btn btn-p btn-sm" (click)="open()" [disabled]="!issued().length">New Part Return</button></div>
    <table><thead><tr><th>Return</th><th>Request</th><th>Item</th><th class="tr">Qty</th><th>Condition</th><th>Reason</th><th>Date</th></tr></thead><tbody>
      @for (r of pretRows(); track r.code) {
        <tr><td><strong>{{r.code}}</strong></td><td>{{r.req}}</td><td>{{r.sku}}</td><td class="tr">{{r.qty}}</td><td>{{r.cond}}</td><td>{{r.reason}}</td><td>{{fmtD(r.date,1)}}</td></tr>
      } @empty { <tr><td colspan="7" style="color:var(--txm)">No part returns yet.</td></tr> }
    </tbody></table></div>
  @if (isOpen()) {
    <div class="modal-bg" style="display:block" (click)="close($event)">
      <div class="modal" style="max-width:560px" (click)="$event.stopPropagation()">
        <div class="rm-hd"><strong>New Part Return</strong><button class="btn btn-s btn-sm" (click)="close()">✕</button></div>
        <div class="fr"><div class="fg"><label>Issued request *</label>
            <select [(ngModel)]="f.req" (ngModelChange)="avail()"><option value="">@if (issued().length) { — Select issued request — } @else { No issued requests with parts to return }</option>
              @for (i of issued(); track i.code) { <option [value]="i.code">{{i.code}} · {{i.sku}} · {{i.out}} out</option> }</select></div>
          <div class="fg"><label>Out</label><input [value]="f.av" disabled></div></div>
        <div class="fr3"><div class="fg"><label>Quantity returned *</label><input type="number" min="0" step="any" [(ngModel)]="f.qty"></div>
          <div class="fg"><label>Condition *</label><select [(ngModel)]="f.cond"><option>Good — back to stock</option><option>Damaged — not restocked</option></select></div>
          <div class="fg"><label>Date *</label><input type="date" [(ngModel)]="f.date"></div></div>
        <div class="fr"><div class="fg"><label>Reason *</label><input [(ngModel)]="f.reason" maxlength="120"></div></div>
        <div class="form-err" [style.display]="err() ? 'block' : 'none'">{{err()}}</div>
        <div class="btn-grp"><button class="btn btn-p" (click)="save()">Save Return</button> <button class="btn btn-s" (click)="close()">Cancel</button></div>
      </div></div>
  }`,
})
export class InvPretComponent {
  fmtD = fmtD; fmtR = fmtR; cdr = inject(ChangeDetectorRef);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  pretRows = signal<Pret[]>([]); issued = signal<{ code: string; sku: string; itemName: string; out: number }[]>([]);
  isOpen = signal(false); err = signal('');
  f = { req: '', qty: 0, cond: 'Good — back to stock', reason: '', date: todayIso(), av: '' };

  constructor() { void this.reload(); }
  open() { this.f = { req: '', qty: 0, cond: 'Good — back to stock', reason: '', date: todayIso(), av: '' }; this.isOpen.set(true); this.err.set(''); this.cdr.detectChanges(); }
  close(e?: MouseEvent) { if (!e || (e.target as HTMLElement).classList.contains('modal-bg')) this.isOpen.set(false); this.cdr.detectChanges(); }
  async reload() {
    const r = await this.api.get<{ rows: Pret[]; issued: { code: string; sku: string; itemName: string; out: number }[] }>('/parts/returns');
    this.pretRows.set(r.rows); this.issued.set(r.issued);
    this.cdr.detectChanges();
  }
  avail() {
    const i = this.issued().find((x) => x.code === this.f.req);
    this.f.av = i ? String(i.out) : '';
    if (i) this.f.qty = i.out; // prChanged 5184
    this.cdr.detectChanges();
  }
  async save() {
    this.err.set('');
    try {
      const r = await this.api.post<{ code: string }>('/parts/returns', { req: this.f.req, qty: this.f.qty, cond: this.f.cond, reason: this.f.reason, date: this.f.date });
      this.toast.show(r.code + ' saved.');
      this.isOpen.set(false);
      await this.reload();
    } catch (e) { this.err.set((e as ApiError).message); this.cdr.detectChanges(); }
  }
}
