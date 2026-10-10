'use strict';

const path = require('path');
const ExcelJS = require('exceljs');

const text = require('../pdf/text');
const bin = require('../engine/binaries');
const { ocrFile } = require('./ocr');

const HEBREW = /[א-ת]/;

/**
 * PDF to Excel: tables become rows and columns.
 *
 * Each line of text is cut into cells where there is a wide gap, runs of lines with
 * two or more cells become a table, and cells are lined up into columns by where they
 * sit across the rows. Hebrew tables read right to left, so their first column is the
 * rightmost and the sheet is set right to left. Lines outside a table go in the first
 * column, so nothing on the page is lost. Numbers become numbers; dates stay as
 * written, so 07/08 is never turned into the wrong month.
 *
 * options.layout  'page' (a sheet per page, default) | 'one' (everything on one sheet)
 * Scanned pages are read with OCR first when they have no text.
 */
async function run({ inputs, options = {}, ctx }) {
  const display = [];
  let tables = 0;
  let scanned = 0;
  for (let f = 0; f < inputs.length; f++) {
    const name = path.basename(inputs[f]);
    const pages = await pageItems(inputs[f], ctx, (fr, label) => ctx.progress((f + fr * 0.8) / inputs.length, label));
    scanned += pages.filter((p) => p.ocr).length;

    const book = new ExcelJS.Workbook();
    book.creator = '';
    const one = options.layout === 'one' ? book.addWorksheet('PDF') : null;
    let rowAt = 1;
    let rtlVotes = 0;
    pages.forEach((page, i) => {
      const sheet = one || book.addWorksheet(`עמוד ${i + 1}`);
      if (!one) rowAt = 1;
      const grid = layout(page.items);
      tables += grid.tables;
      if (grid.rtl) rtlVotes++;
      else rtlVotes--;
      if (one && i > 0) rowAt++;
      for (const row of grid.rows) {
        row.forEach((value, c) => {
          if (value === '' || value == null) return;
          const cell = sheet.getCell(rowAt, c + 1);
          cell.value = value;
          if (typeof value === 'number' && /\./.test(String(value))) cell.numFmt = '#,##0.00';
        });
        rowAt++;
      }
      if (!one) finishSheet(sheet, grid.rtl);
    });
    if (one) finishSheet(one, rtlVotes >= 0);
    ctx.progress((f + 0.95) / inputs.length, `"${name}": שומר את הגיליון…`);
    const bytes = await book.xlsx.writeBuffer();
    display.push(await ctx.writeOutput(Buffer.from(bytes), { source: inputs[f], label: '', ext: 'xlsx' }));
  }
  let summary = tables
    ? `${tables === 1 ? 'נמצאה טבלה אחת' : `נמצאו ${tables} טבלאות`}, והן בגיליון בשורות ועמודות.`
    : 'לא נמצאו טבלאות בקובץ, ולכן הטקסט הועתק לגיליון שורה אחר שורה, בעמודה הראשונה.';
  if (scanned) summary += ` ${scanned === 1 ? 'עמוד אחד היה סרוק' : `${scanned} עמודים היו סרוקים`} וזוהה בזיהוי טקסט, לכן כדאי לבדוק את המספרים מול המקור.`;
  return { summary, display };
}

/** Text pieces with positions in points, top-left origin, per page; OCR for pages without text. */
async function pageItems(file, ctx, progress) {
  const doc = await text.open(file);
  const pages = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      progress((p - 1) / doc.numPages, `קורא עמוד ${p} מתוך ${doc.numPages}`);
      const { lines } = await text.pageLines(doc, p);
      pages.push({ items: lines.flatMap((l) => l.items.map((it) => ({ str: it.str, x: it.x, width: it.width, y: l.y, height: l.height, rtl: it.rtl }))), ocr: false });
    }
  } finally {
    await doc.destroy();
  }
  const empty = pages.map((p, i) => (p.items.length ? -1 : i)).filter((i) => i >= 0);
  if (empty.length && bin.locate('gs')) {
    const read = await ocrFile(file, { langs: 'heb+eng' }, ctx, (fr, label) => progress(0.5 + fr * 0.5, label));
    for (const i of empty) {
      const img = read.images[i];
      if (!img || !read.words[i].length) continue;
      const k = 72 / img.dpi;
      pages[i] = {
        ocr: true,
        items: read.words[i].map((w) => ({
          str: w.text,
          x: w.bbox.x0 * k,
          width: (w.bbox.x1 - w.bbox.x0) * k,
          y: (w.line ? w.line.y1 : w.bbox.y1) * k,
          height: (w.bbox.y1 - w.bbox.y0) * k,
          rtl: HEBREW.test(w.text),
        })),
      };
    }
  }
  return pages;
}

/**
 * Lines, cells, tables and columns for one page.
 * @returns {{rows: (string|number)[][], tables: number, rtl: boolean}}
 */
function layout(items) {
  if (!items.length) return { rows: [], tables: 0, rtl: false };
  const heb = items.filter((i) => HEBREW.test(i.str)).length;
  const rtl = heb * 2 >= items.filter((i) => /[A-Za-zא-ת]/.test(i.str)).length && heb > 0;

  // Lines by baseline.
  const sorted = items.slice().sort((a, b) => a.y - b.y);
  const lines = [];
  for (const it of sorted) {
    const line = lines.find((l) => Math.abs(l.y - it.y) < Math.max(2, Math.min(l.height, it.height) * 0.5));
    if (line) {
      line.items.push(it);
      line.height = Math.max(line.height, it.height);
    } else lines.push({ y: it.y, height: it.height, items: [it] });
  }
  lines.sort((a, b) => a.y - b.y);

  // Cells: pieces closer than about two letters belong to the same cell.
  for (const line of lines) {
    const byX = line.items.slice().sort((a, b) => a.x - b.x);
    const cells = [];
    for (const it of byX) {
      const last = cells[cells.length - 1];
      const gap = last ? it.x - last.x1 : Infinity;
      if (last && gap < Math.max(4, line.height * 1.1)) {
        last.items.push(it);
        last.x1 = Math.max(last.x1, it.x + it.width);
      } else cells.push({ x0: it.x, x1: it.x + it.width, items: [it] });
    }
    line.cells = cells.map((c) => ({ x0: c.x0, x1: c.x1, text: cellText(c.items, line.height) }));
  }

  // Tables: runs of at least two consecutive lines with at least two cells.
  const rows = [];
  let tables = 0;
  for (let i = 0; i < lines.length;) {
    let j = i;
    while (j < lines.length && lines[j].cells.length >= 2) j++;
    if (j - i >= 2) {
      tables++;
      const block = lines.slice(i, j);
      const columns = clusterColumns(block.flatMap((l) => l.cells));
      const ordered = rtl ? columns.slice().sort((a, b) => b.x1 - a.x1) : columns.slice().sort((a, b) => a.x0 - b.x0);
      for (const line of block) {
        const row = new Array(ordered.length).fill('');
        for (const cell of line.cells) {
          const c = ordered.findIndex((col) => col.members.has(cell));
          row[c] = row[c] ? `${row[c]} ${cell.text}` : cell.text;
        }
        rows.push(row.map(value));
      }
      i = j;
    } else {
      const line = lines[i];
      const ordered = rtl ? line.cells.slice().sort((a, b) => b.x1 - a.x1) : line.cells;
      rows.push([value(ordered.map((c) => c.text).join(' '))]);
      i++;
    }
  }
  return { rows, tables, rtl };
}

function cellText(pieces, height) {
  const hebrew = pieces.some((p) => HEBREW.test(p.str));
  const ordered = pieces.slice().sort((a, b) => (hebrew ? b.x - a.x : a.x - b.x));
  let out = '';
  ordered.forEach((p, k) => {
    if (k) {
      const prev = ordered[k - 1];
      const gap = hebrew ? prev.x - (p.x + p.width) : p.x - (prev.x + prev.width);
      if (gap > height * 0.15) out += ' ';
    }
    out += p.str;
  });
  return out.replace(/\s+/g, ' ').trim();
}

/** Group cells whose horizontal extents overlap into columns. */
function clusterColumns(cells) {
  const columns = [];
  for (const cell of cells.slice().sort((a, b) => a.x0 - b.x0)) {
    const col = columns.find((c) => cell.x0 <= c.x1 + 3 && cell.x1 >= c.x0 - 3);
    if (col) {
      col.x0 = Math.min(col.x0, cell.x0);
      col.x1 = Math.max(col.x1, cell.x1);
      col.members.add(cell);
    } else columns.push({ x0: cell.x0, x1: cell.x1, members: new Set([cell]) });
  }
  // Columns that ended up overlapping after growing are one column.
  let merged = true;
  while (merged) {
    merged = false;
    for (let a = 0; a < columns.length && !merged; a++) {
      for (let b = a + 1; b < columns.length && !merged; b++) {
        if (columns[a].x0 <= columns[b].x1 && columns[a].x1 >= columns[b].x0) {
          columns[a].x0 = Math.min(columns[a].x0, columns[b].x0);
          columns[a].x1 = Math.max(columns[a].x1, columns[b].x1);
          for (const m of columns[b].members) columns[a].members.add(m);
          columns.splice(b, 1);
          merged = true;
        }
      }
    }
  }
  return columns;
}

/** "1,250.00" and "₪ 300" become numbers; dates, ID numbers and anything else stay text. */
function value(text) {
  const t = String(text).trim();
  if (/^\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?$/.test(t)) return t;
  if (/^0\d/.test(t)) return t; // leading zeros: phone numbers, IDs
  const m = /^(?:₪\s*)?(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)(?:\s*₪)?$/.exec(t);
  if (m && t.replace(/[^\d]/g, '').length < 15) return Number(m[1].replace(/,/g, ''));
  const pct = /^(-?\d+(?:\.\d+)?)%$/.exec(t);
  if (pct) return Number(pct[1]) / 100;
  return t;
}

function finishSheet(sheet, rtl) {
  sheet.views = [{ rightToLeft: rtl }];
  sheet.columns.forEach((col) => {
    let width = 8;
    col.eachCell({ includeEmpty: false }, (cell) => {
      width = Math.max(width, Math.min(60, String(cell.value).length + 2));
    });
    col.width = width;
  });
}

module.exports = { run, layout, value };
