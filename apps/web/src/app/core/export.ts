// Export engine — verbatim port of legacy/Numera.html:4175–4318 (real .pdf/.xlsx/CSV files, no libraries).
import { Injectable, inject } from '@angular/core';
import { AuthStore } from './auth.store';
import { todayIso, fmtD } from './fmt';

export interface RepCol { h: string; t?: 'm' | 'i' | 'd' | ''; }
export interface RepSection { title?: string; cols: RepCol[]; rows: unknown[][]; totals?: unknown[]; }
export interface ExportSpec { title: string; sub?: string; sections: RepSection[]; }

// legacy fmtR 1943 ('R '+n.toLocaleString — negatives keep the sign; paren-free for export cells)
export const fmtRxl = (n: number): string => 'R ' + (Number(n) || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const enc = new TextEncoder();
const fileBase = (t: string | undefined) => String(t || 'Report').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) + '_' + todayIso();

// --- CRC32 + zip (stored) — legacy 4180–4192
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (u: Uint8Array) => { let c = 0xFFFFFFFF; for (let i = 0; i < u.length; i++) c = CRC_T[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

function zipStore(files: { name: string; data: string }[]): Blob {
  const parts: Uint8Array[] = [], cen: Uint8Array[] = []; let off = 0;
  const d = new Date(), dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), tm = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const u16 = (a: number[], v: number) => a.push(v & 255, (v >> 8) & 255), u32 = (a: number[], v: number) => a.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  files.forEach((f) => {
    const nm = enc.encode(f.name), data = enc.encode(f.data), crc = crc32(data), h: number[] = [];
    u32(h, 0x04034b50); u16(h, 20); u16(h, 0x0800); u16(h, 0); u16(h, tm); u16(h, dt); u32(h, crc); u32(h, data.length); u32(h, data.length); u16(h, nm.length); u16(h, 0);
    parts.push(new Uint8Array(h), nm, data);
    const c: number[] = []; u32(c, 0x02014b50); u16(c, 20); u16(c, 20); u16(c, 0x0800); u16(c, 0); u16(c, tm); u16(c, dt); u32(c, crc); u32(c, data.length); u32(c, data.length); u16(c, nm.length); u16(c, 0); u16(c, 0); u16(c, 0); u16(c, 0); u32(c, 0); u32(c, off);
    cen.push(new Uint8Array(c), nm); off += h.length + nm.length + data.length;
  });
  let cs = 0; cen.forEach((x) => cs += x.length);
  const e: number[] = []; u32(e, 0x06054b50); u16(e, 0); u16(e, 0); u16(e, files.length); u16(e, files.length); u32(e, cs); u32(e, off); u16(e, 0);
  return new Blob(parts.concat(cen, [new Uint8Array(e)]) as BlobPart[], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

const xe = (v: unknown) => String(v == null ? '' : v)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i: number) => { let n = '', x = i + 1; while (x > 0) { const m = (x - 1) % 26; n = String.fromCharCode(65 + m) + n; x = Math.floor((x - 1) / 26); } return n; };
const isoSerial = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5); };

// legacy buildXlsx 4196: styles 0 normal,1 header,2 money,3 int,4 date,5 bold,6 bold money,7 title,8 sub,9 bold int
function buildXlsx(spec: ExportSpec, co: string): Blob {
  const rows: string[] = []; let r = 1; const W: number[] = [];
  const put = (row: number, cells: string[]) => { rows.push(`<row r="${row}">` + cells.join('') + '</row>'); };
  const S = (c: number, rw: number, v: string, st?: number) => `<c r="${colName(c)}${rw}" t="inlineStr"${st ? ` s="${st}"` : ''}><is><t xml:space="preserve">${xe(v)}</t></is></c>`;
  const N = (c: number, rw: number, v: number, st?: number) => `<c r="${colName(c)}${rw}" s="${st}"><v>${v}</v></c>`;
  const bump = (c: number, len: number) => { W[c] = Math.min(60, Math.max(W[c] || 8, len + 2)); };
  put(r++, [S(0, r - 1, co, 7)]); put(r++, [S(0, r - 1, spec.title, 5)]); if (spec.sub) put(r++, [S(0, r - 1, spec.sub, 8)]); put(r++, [S(0, r - 1, 'Generated ' + fmtD(todayIso(), 1), 8)]); r++;
  spec.sections.forEach((sec) => {
    if (sec.title && spec.sections.length > 1) { put(r++, [S(0, r - 1, sec.title, 5)]); }
    if (sec.cols.some((c) => c.h)) put(r++, sec.cols.map((c, i) => { bump(i, String(c.h).length); return S(i, r - 1, c.h, 1); }));
    const cell = (c: RepCol, i: number, v: any, bold: boolean) => {
      if (v === '' || v == null) return S(i, r, '', bold ? 5 : 0);
      if (c.t === 'm') { const x = Number(v); bump(i, 12); return Number.isFinite(x) ? N(i, r, x, bold ? 6 : 2) : S(i, r, v, bold ? 5 : 0); }
      if (c.t === 'i') { const x = Number(v); bump(i, String(v).length); return Number.isFinite(x) ? N(i, r, x, bold ? 9 : 3) : S(i, r, v, bold ? 5 : 0); }
      if (c.t === 'd' && /^\d{4}-\d{2}-\d{2}$/.test(v)) { bump(i, 11); return N(i, r, isoSerial(v), 4); }
      bump(i, Math.min(60, String(v).length)); return S(i, r, v, bold ? 5 : 0);
    };
    sec.rows.forEach((row) => { put(r, sec.cols.map((c, i) => cell(c, i, row[i], false))); r++; });
    if (sec.totals && sec.rows.length) { put(r, sec.cols.map((c, i) => cell(c, i, sec.totals![i], true))); r++; }
    r++;
  });
  const cols = '<cols>' + W.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w || 10}" customWidth="1"/>`).join('') + '</cols>';
  const sheetName = xe(String(spec.title).replace(/[\\\/\?\*\[\]:]/g, ' ').slice(0, 31) || 'Report');
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="'+sheetName+'" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="3"><numFmt numFmtId="164" formatCode="&quot;R&quot;\\ #,##0.00;[Red]\\-&quot;R&quot;\\ #,##0.00"/><numFmt numFmtId="165" formatCode="#,##0"/><numFmt numFmtId="166" formatCode="dd/mm/yyyy"/></numFmts><fonts count="4"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font><font><b/><sz val="14"/><name val="Arial"/></font><font><sz val="9"/><color rgb="FF777777"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF3"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF999999"/></top><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="10"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="165" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/></cellXfs></styleSheet>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + cols + '<sheetData>' + rows.join('') + '</sheetData></worksheet>' },
  ];
  return zipStore(files);
}

// --- PDF (Helvetica, A4) — legacy 4230–4302, verbatim
const HW = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const CP: Record<string, number> = { '—': 0x97, '–': 0x96, '·': 0xB7, '’': 0x92, '‘': 0x91, '“': 0x93, '”': 0x94, '…': 0x85, '•': 0x95, '€': 0x80, '−': 0x2D, '×': 0xD7 };
function pdfClean(t: string) {
  t = String(t == null ? '' : t).replace(/[\u00A0\u202F\u2009\u2007]/g, ' ').replace(/→/g, '->').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/✕/g, 'x');
  let o = ''; for (const ch of t) { const c = ch.codePointAt(0)!; if (c === 9 || c === 10 || c === 13) o += ' '; else if (CP[ch] !== undefined) o += String.fromCharCode(CP[ch]); else if (c >= 32 && c <= 126) o += ch; else if (c >= 160 && c <= 255) o += ch; else o += '?'; }
  return o;
}
const cw = (ch: string, bold?: boolean) => { const c = ch.charCodeAt(0); const w = (c >= 32 && c <= 126) ? HW[c - 32] : (c === 0x97 ? 1000 : c === 0x96 ? 556 : c === 0xB7 ? 333 : 556); return bold ? w * 1.06 : w; };
const tw = (t: string, size: number, bold?: boolean) => { let w = 0; for (let i = 0; i < t.length; i++) w += cw(t[i], bold); return w * size / 1000; };
const pesc = (t: string) => t.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[\x80-\xFF]/g, (m) => '\\' + m.charCodeAt(0).toString(8).padStart(3, '0'));
function wrapText(t: string, w: number, size: number, bold?: boolean) {
  t = pdfClean(t); const out: string[] = []; let line = '';
  const words = t.split(' ');
  for (let word of words) {
    while (tw(word, size, bold) > w && word.length > 1) { let k = word.length; while (k > 1 && tw(word.slice(0, k), size, bold) > w) k--; if (line) { out.push(line); line = ''; } out.push(word.slice(0, k)); word = word.slice(k); }
    const test = line ? line + ' ' + word : word; if (tw(test, size, bold) <= w || !line) line = test; else { out.push(line); line = word; }
  }
  out.push(line); return out;
}
export const fmtCell = (c: RepCol, v: unknown): string => {
  if (v === '' || v == null) return '';
  if (c.t === 'm') { const x = Number(v); return Number.isFinite(x) ? fmtRxl(x) : String(v); }
  if (c.t === 'i') { const x = Number(v); return Number.isFinite(x) ? x.toLocaleString('en-ZA') : String(v); }
  if (c.t === 'd' && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) return fmtD(String(v), 1);
  return String(v);
};
function buildPdf(spec: ExportSpec, co: string, user: string): Blob {
  const FS = 8, LH = 10, PADX = 4, PADY = 3;
  const secs = spec.sections.map((sec) => {
    const cols = sec.cols, nat = cols.map((c, i) => {
      let w = tw(pdfClean(c.h), FS, true);
      sec.rows.concat(sec.totals ? [sec.totals] : []).forEach((r) => { const v = fmtCell(c, r[i]); const lw = Math.max(...pdfClean(v).split(' ').map((x) => tw(x, FS, false))); const full = tw(pdfClean(v), FS, false); w = Math.max(w, Math.min(full, 200)); w = Math.max(w, Math.min(lw, 200)); });
      return w + PADX * 2;
    });
    return { sec, nat };
  });
  const widest = Math.max(...secs.map((x) => x.nat.reduce((a, b) => a + b, 0)));
  const landscape = widest > 480, PW = landscape ? 842 : 595, PH = landscape ? 595 : 842, M = 34, AV = PW - 2 * M;
  const pages: { ops: string[] }[] = []; let cur: { ops: string[] } | null = null, y = 0;
  const txt = (x: number, yy: number, t: string, size: number, bold?: boolean, rgb?: number[], align?: string, w?: number) => { t = pdfClean(t); let px = x; if (align === 'r') px = x + w! - tw(t, size, bold); return `BT /${bold ? 'F2' : 'F1'} ${size} Tf ${(rgb || [0.1, 0.1, 0.1]).join(' ')} rg ${px.toFixed(2)} ${yy.toFixed(2)} Td (${pesc(t)}) Tj ET`; };
  const rect = (x: number, yy: number, w: number, h: number, g: number) => `${g} g ${x.toFixed(2)} ${yy.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`;
  const line = (x1: number, y1: number, x2: number, g: number, wd?: number) => `${g} G ${wd || 0.5} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y1.toFixed(2)} l S`;
  const newPage = () => {
    cur = { ops: [] }; pages.push(cur); y = PH - M;
    cur.ops.push(txt(M, y - 12, co, 13, true, [0.1, 0.1, 0.1])); y -= 20; cur.ops.push(txt(M, y - 8, spec.title, 10.5, true, [0.1, 0.32, 0.46])); y -= 14;
    if (spec.sub) { cur.ops.push(txt(M, y - 8, spec.sub, 8.5, false, [0.4, 0.4, 0.4])); y -= 12; }
    cur.ops.push(txt(M, y - 8, 'Generated ' + fmtD(todayIso(), 1) + ' · ' + user, 8, false, [0.5, 0.5, 0.5])); y -= 18;
  };
  newPage();
  secs.forEach(({ sec, nat }) => {
    const cols = sec.cols; let widths = nat.slice(); const tot = widths.reduce((a, b) => a + b, 0);
    if (tot > AV) {
      const fixed = cols.map((c, i) => (c.t === 'm' || c.t === 'i' || c.t === 'd') ? widths[i] : 0), fx = fixed.reduce((a, b) => a + b, 0), flex = widths.map((w, i) => fixed[i] ? 0 : w), fl = flex.reduce((a, b) => a + b, 0);
      const room = Math.max(AV - fx, fl * 0.3); widths = widths.map((w, i) => fixed[i] ? w : Math.max(36, w * room / fl)); const t2 = widths.reduce((a, b) => a + b, 0); if (t2 > AV) widths = widths.map((w) => w * AV / t2);
    } else if (tot < AV * 0.9) { const k = Math.min(AV / tot, 1.25); widths = widths.map((w) => w * k); }
    const X: number[] = []; let ax = M; widths.forEach((w) => { X.push(ax); ax += w; });
    const drawHeader = () => {
      if (!cols.some((c) => c.h)) return; const h = LH + PADY * 2;
      cur!.ops.push(rect(M, y - h, widths.reduce((a, b) => a + b, 0), h, 0.91));
      cols.forEach((c, i) => cur!.ops.push(txt(X[i] + PADX, y - h + PADY + 2, c.h, FS, true, [0.1, 0.1, 0.1], (c.t === 'm' || c.t === 'i') ? 'r' : 'l', widths[i] - PADX * 2))); y -= h;
    };
    if (sec.title && spec.sections.length > 1) { if (y < M + 60) newPage(); cur!.ops.push(txt(M, y - 10, sec.title, 10, true, [0.1, 0.32, 0.46])); y -= 18; }
    if (y < M + 60) newPage(); drawHeader();
    const drawRow = (r: unknown[], bold: boolean, fill: number | null, topLine: boolean) => {
      const cells = cols.map((c, i) => wrapText(fmtCell(c, r[i]), widths[i] - PADX * 2, FS, bold)), n = Math.max(...cells.map((c) => c.length)), h = n * LH + PADY * 2;
      if (y - h < M + 22) { newPage(); drawHeader(); }
      if (fill) cur!.ops.push(rect(M, y - h, widths.reduce((a, b) => a + b, 0), h, fill));
      cells.forEach((ls, i) => { const right = (cols[i].t === 'm' || cols[i].t === 'i'); ls.forEach((l, k) => cur!.ops.push(txt(X[i] + PADX, y - PADY - FS - k * LH + 1.5, l, FS, bold, [0.1, 0.1, 0.1], right ? 'r' : 'l', widths[i] - PADX * 2))); });
      cur!.ops.push(line(M, y - h, M + widths.reduce((a, b) => a + b, 0), topLine ? 0.35 : 0.85, topLine ? 0.8 : 0.4)); y -= h;
    };
    sec.rows.forEach((r) => drawRow(r as unknown[], false, null, false));
    if (!sec.rows.length) { cur!.ops.push(txt(M + PADX, y - 12, 'Nothing to report.', FS, false, [0.5, 0.5, 0.5])); y -= 18; }
    if (sec.totals && sec.rows.length) drawRow(sec.totals as unknown[], true, 0.94, true);
    y -= 16;
  });
  const N = pages.length, objs: (string | null)[] = []; const add = (o: string | null) => { objs.push(o); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>'); add(null); add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids: string[] = [];
  pages.forEach((pg, i) => {
    pg.ops.push(txt(M, 18, 'Numera', 7.5, false, [0.55, 0.55, 0.55])); pg.ops.push(txt(PW - M - 120, 18, 'Page ' + (i + 1) + ' of ' + N, 7.5, false, [0.55, 0.55, 0.55], 'r', 120));
    const stream = pg.ops.join('\n'), cid = objs.length + 2;
    const pid = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cid} 0 R >>`); kids.push(pid + ' 0 R');
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${N} >>`;
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'; const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xr = out.length; out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info << /Title (${pesc(pdfClean(spec.title))}) /Producer (Numera) >> >>\nstartxref\n${xr}\n%%EOF`;
  const bytes = new Uint8Array(out.length); for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255;
  return new Blob([bytes], { type: 'application/pdf' });
}
function buildCsv(spec: ExportSpec, co: string): Blob {
  const q = (v0: unknown) => { let v = v0 == null ? '' : String(v0); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
  const L: string[] = [[co, spec.title, 'Generated ' + todayIso()].map(q).join(',')];
  spec.sections.forEach((sec) => {
    if (sec.title && spec.sections.length > 1) L.push(q(sec.title)); if (sec.cols.some((c) => c.h)) L.push(sec.cols.map((c) => q(c.h)).join(','));
    const f = (c: RepCol, v: unknown) => (c.t === 'm' && v !== '' && v != null && Number.isFinite(Number(v))) ? Number(v).toFixed(2) : q(v);
    sec.rows.forEach((r) => L.push(sec.cols.map((c, i) => f(c, r[i])).join(',')));
    if (sec.totals && sec.rows.length) L.push(sec.cols.map((c, i) => f(c, sec.totals![i])).join(','));
    L.push('');
  });
  return new Blob(['\ufeff' + L.join('\r\n')], { type: 'text/csv;charset=utf-8' });
}
function saveBlob(blob: Blob, name: string) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// exportSpec (legacy 4311): nothing to export toast; log goes to the activity log route separately.
@Injectable({ providedIn: 'root' })
export class Exporter {
  private auth = inject(AuthStore);
  download(spec: ExportSpec, fmt: 'pdf' | 'xlsx' | 'csv' = 'csv'): boolean {
    if (!spec.sections.some((s) => s.rows.length)) { return false; }
    const co = this.auth.company()?.name ?? '';
    const user = this.auth.user()?.username ?? '';
    const base = fileBase(spec.title);
    if (fmt === 'pdf') saveBlob(buildPdf(spec, co, user), base + '.pdf');
    else if (fmt === 'xlsx') saveBlob(buildXlsx(spec, co), base + '.xlsx');
    else saveBlob(buildCsv(spec, co), base + '.csv');
    return true;
  }
}
