'use strict';

const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

/*
 * Reading the text of a PDF, with positions, in the main process.
 *
 * pdf.js returns runs of text. For Hebrew it already gives each run in reading
 * order and marks its direction, so lines are built by sorting runs right to left on
 * Hebrew lines and left to right on Latin ones.
 */

const PDFJS_DIR = path.join(__dirname, '..', '..', '..', 'node_modules', 'pdfjs-dist');
let pdfjsPromise = null;

function pdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(pathToFileURL(path.join(PDFJS_DIR, 'legacy', 'build', 'pdf.mjs')).href);
  }
  return pdfjsPromise;
}

async function open(filePath, { password } = {}) {
  const lib = await pdfjs();
  const data = new Uint8Array(await fs.readFile(filePath));
  return lib.getDocument({
    data,
    password,
    isEvalSupported: false,
    standardFontDataUrl: path.join(PDFJS_DIR, 'standard_fonts') + path.sep,
    cMapUrl: path.join(PDFJS_DIR, 'cmaps') + path.sep,
    cMapPacked: true,
    verbosity: 0,
  }).promise;
}

const HEBREW = /[֐-׿]/;

/**
 * One page's text as lines, top to bottom.
 * @returns {Promise<{lines: {text: string, x: number, y: number, right: number, height: number, bold: boolean, rtl: boolean, items: object[]}[], width: number, height: number}>}
 */
async function pageLines(doc, pageNumber) {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const styles = content.styles || {};

  const items = content.items
    .filter((it) => it.str && it.str.trim())
    .map((it) => {
      // Positions in the page as shown, top-left origin, so rotation is already applied.
      const [x, y] = viewport.convertToViewportPoint(it.transform[4], it.transform[5]);
      const height = Math.abs(it.height) || Math.hypot(it.transform[2], it.transform[3]) || 10;
      const width = Math.abs(it.width) || 0;
      const font = styles[it.fontName] || {};
      return {
        str: it.str,
        rtl: it.dir === 'rtl' || (it.dir !== 'ltr' && HEBREW.test(it.str)),
        x,
        y,
        width,
        height,
        bold: /bold|black|heavy/i.test(`${it.fontName} ${font.fontFamily || ''}`),
      };
    });

  // Group by baseline: a run joins the line whose baseline is within half its height.
  items.sort((a, b) => a.y - b.y);
  const lines = [];
  for (const it of items) {
    const line = lines.find((l) => Math.abs(l.y - it.y) < Math.max(2, Math.min(l.height, it.height) * 0.5));
    if (line) {
      line.items.push(it);
      line.height = Math.max(line.height, it.height);
    } else {
      lines.push({ y: it.y, height: it.height, items: [it] });
    }
  }

  // A line's direction comes from its letters, not its digits: "01/05/2026 ועד ליום
  // 30/04/2027." is a Hebrew line even though most of its characters are numbers.
  // A line with no letters at all follows the page.
  const letters = (str, re) => (str.match(re) || []).length;
  const HEB_ALL = /[\u05D0-\u05EA]/g;
  const LAT_ALL = /[A-Za-z]/g;
  const pageHeb = items.reduce((n, i) => n + letters(i.str, HEB_ALL), 0);
  const pageLat = items.reduce((n, i) => n + letters(i.str, LAT_ALL), 0);

  const out = lines.map((line) => {
    const heb = line.items.reduce((n, i) => n + letters(i.str, HEB_ALL), 0);
    const lat = line.items.reduce((n, i) => n + letters(i.str, LAT_ALL), 0);
    const rtl = heb || lat ? heb >= lat : pageHeb >= pageLat;

    // Runs: neighbouring pieces of the same direction, read in that direction. pdf.js
    // may cut "07/07/2026" into "0" and "7/07/2026"; kept together as one
    // left-to-right run they come back whole, where sorting each piece on its own
    // would give "7/07/20260".
    const byX = line.items.slice().sort((a, b) => a.x - b.x);
    resolveNeutrals(byX, rtl);
    const runs = [];
    for (const it of byX) {
      const last = runs[runs.length - 1];
      if (last && last.rtl === it.rtl) last.items.push(it);
      else runs.push({ rtl: it.rtl, items: [it] });
    }
    for (const run of runs) if (run.rtl) run.items.reverse();
    if (rtl) runs.reverse();
    const ordered = runs.flatMap((r) => r.items);

    // On a Hebrew line, pdf.js gives a Latin run in its visual order, so punctuation
    // that ends the Hebrew sentence arrives at its front: ".Kalner" for "Kalner.".
    const pieces = [];
    for (const run of runs) {
      let piece = '';
      run.items.forEach((cur, i) => {
        if (i) {
          const prev = run.items[i - 1];
          const gap = run.rtl ? prev.x - (cur.x + cur.width) : cur.x - (prev.x + prev.width);
          if (gap > cur.height * 0.15 && !/\s$/.test(piece) && !/^\s/.test(cur.str)) piece += ' ';
        }
        piece += cur.str;
      });
      if (rtl && !run.rtl) {
        const m = /^([.,:;!?)\]]+)(\s*)(.*[A-Za-z0-9].*)$/s.exec(piece.trim());
        if (m) piece = m[3] + m[1];
      }
      pieces.push({ text: piece, first: run.items[0], last: run.items[run.items.length - 1] });
    }

    let text = '';
    pieces.forEach((piece, i) => {
      if (i) {
        const prev = pieces[i - 1];
        // Distance between the end of the previous run and the start of this one.
        const gap = rtl ? leftOf(prev) - rightOf(piece) : leftOf(piece) - rightOf(prev);
        if (gap > piece.first.height * 0.15 && !/\s$/.test(text) && !/^\s/.test(piece.text)) text += ' ';
      }
      text += piece.text;
    });

    const xs = line.items.map((i) => i.x);
    const rights = line.items.map((i) => i.x + i.width);
    return {
      text: text.replace(/\s+/g, ' ').trim(),
      x: Math.min(...xs),
      right: Math.max(...rights),
      y: line.y,
      height: line.height,
      bold: line.items.every((i) => i.bold),
      rtl,
      items: ordered,
    };
  }).filter((l) => l.text);

  page.cleanup();
  return { lines: out.sort((a, b) => a.y - b.y), width: viewport.width, height: viewport.height };
}

/** All the text of a document, page by page, as plain lines. */
async function documentText(filePath, { onPage, signal } = {}) {
  const doc = await open(filePath);
  const pages = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      if (signal && signal.aborted) break;
      const { lines } = await pageLines(doc, p);
      pages.push(lines.map((l) => l.text).join('\n'));
      if (onPage) onPage(p, doc.numPages);
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

/*
 * Punctuation on its own (":" or "." with no letters or digits) has no direction of
 * its own. As in the Unicode bidirectional algorithm, it takes the direction of the
 * text on both sides when they agree, numbers counting as Hebrew-side here, and the
 * line's direction otherwise. So in "הערעור: 07/07/2026." the colon stays with the
 * Hebrew word and the full stop ends the sentence.
 */
function resolveNeutrals(byX, lineRtl) {
  const kind = (it) => {
    if (/[\u05D0-\u05EA]/.test(it.str)) return 'R';
    if (/[A-Za-z]/.test(it.str)) return 'L';
    if (/\d/.test(it.str)) return 'EN';
    return 'O';
  };
  const kinds = byX.map(kind);
  // A single separator between two numbers is part of the number: "054-3074511",
  // "07/07", "1,250.00" (rules W4 of the same algorithm).
  kinds.forEach((k, i) => {
    if (k === 'O' && /^[-+/.,:]$/.test(byX[i].str.trim()) && kinds[i - 1] === 'EN' && kinds[i + 1] === 'EN') kinds[i] = 'EN';
  });
  const side = (k) => (k === 'L' ? 'L' : k === 'R' || k === 'EN' ? 'R' : null);
  byX.forEach((it, i) => {
    if (kinds[i] === 'R') it.rtl = true;
    else if (kinds[i] === 'L' || kinds[i] === 'EN') it.rtl = false;
  });
  const edge = lineRtl ? 'R' : 'L';
  byX.forEach((it, i) => {
    if (kinds[i] !== 'O') return;
    let before = edge;
    for (let j = i - 1; j >= 0; j--) if (side(kinds[j])) { before = side(kinds[j]); break; }
    let after = edge;
    for (let j = i + 1; j < byX.length; j++) if (side(kinds[j])) { after = side(kinds[j]); break; }
    it.rtl = before === after ? before === 'R' : lineRtl;
  });
}

function leftOf(piece) {
  return Math.min(piece.first.x, piece.last.x);
}
function rightOf(piece) {
  return Math.max(piece.first.x + piece.first.width, piece.last.x + piece.last.width);
}

module.exports = { open, pageLines, documentText, pdfjs };
