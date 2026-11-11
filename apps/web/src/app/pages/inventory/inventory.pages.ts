import { Component, ChangeDetectorRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, ApiError, ToastService } from '../../core/api';
import { fmtR, stkDate, todayIso } from '../../core/fmt';

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
