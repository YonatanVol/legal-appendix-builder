'use strict';

const fs = require('fs/promises');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const bin = require('../engine/binaries');
const ocr = require('../engine/ocr');
const { stage } = require('../engine/stage');
const { renderPages } = require('../engine/render');
const { stampTextLayer } = require('../pdf/textlayer');
const text = require('../pdf/text');
const { loadPdf } = require('../pdf/inspect');
const { wordDocument } = require('../pdf/docx');

const DPI = 300;
const LANGS = { heb: 'heb', 'heb+eng': 'heb+eng', eng: 'eng' };

/**
 * OCR: make a scanned PDF searchable.
 *
 * Each page without text is drawn at 300 DPI, read by Tesseract, and given an
 * invisible text layer over the words where they appear. The page itself is not
 * touched: the scan looks exactly as before, and it can now be searched and copied.
 *
 * options.langs     'heb' (default) | 'heb+eng' | 'eng'
 * options.alsoWord  also write the text as a Word document
 * options.alsoText  also write it as a plain text file
 */
async function run({ inputs, options = {}, ctx }) {
  const langs = LANGS[options.langs] || 'heb';
  const display = [];
  const notes = [];
  for (let f = 0; f < inputs.length; f++) {
    const result = await ocrFile(inputs[f], { langs }, ctx, (fraction, label) =>
      ctx.progress((f + fraction) / inputs.length, label));
    const name = path.basename(inputs[f]);

    if (result.read === 0 && !options.alsoWord && !options.alsoText) {
      notes.push(`${inputs.length > 1 ? `"${name}": ` : ''}בכל העמודים כבר יש טקסט, ולכן לא נוצר עותק.`);
      continue;
    }
    if (result.read > 0) {
      display.push(await ctx.writeOutput(result.bytes, { source: inputs[f], label: 'ניתן לחיפוש', ext: 'pdf' }));
    }
    if (options.alsoWord) {
      display.push(await ctx.writeOutput(await wordDocument(result.pages), { source: inputs[f], label: 'טקסט', ext: 'docx' }));
    }
    if (options.alsoText) {
      display.push(await ctx.writeOutput(Buffer.from(result.pages.join('\n\n\f\n'), 'utf8'), { source: inputs[f], label: 'טקסט', ext: 'txt' }));
    }
    const parts = [];
    if (result.read) parts.push(`${result.read === 1 ? 'עמוד אחד זוהה' : `${result.read} עמודים זוהו`}`);
    if (result.skipped) parts.push(`${result.skipped === 1 ? 'בעמוד אחד' : `ב-${result.skipped} עמודים`} כבר היה טקסט`);
    if (result.empty) parts.push(`${result.empty === 1 ? 'בעמוד אחד' : `ב-${result.empty} עמודים`} לא נמצא טקסט לזהות`);
    notes.push(`${inputs.length > 1 ? `"${name}": ` : ''}${parts.join(', ')}.`);
  }
  return { summary: notes.join(' '), display };
}

/**
 * Read one file. Shared with the tools that need the text of a scan: PDF to Excel,
 * Redact, Summarize and Translate.
 * @returns {Promise<{bytes: Uint8Array, pages: string[], words: Array[], images: object[], read: number, skipped: number, empty: number}>}
 */
async function ocrFile(input, { langs = 'heb' } = {}, ctx, progress = () => {}) {
  // Saved without pdf-lib's own name and dates in the details: a copy carries no more
  // about its making than it must (Redact's copy carries nothing at all).
  const doc = await loadPdf(input, { updateMetadata: false });
  const total = doc.getPageCount();

  // Which pages already carry text: those are left alone unless asked.
  const reader = await text.open(input);
  const existing = [];
  const existingBoxes = [];
  try {
    for (let p = 1; p <= total; p++) {
      const { lines, width, height } = await text.pageLines(reader, p);
      existing.push(lines.map((l) => l.text).join('\n'));
      // Where the page's own words already are, as fractions of the shown page.
      existingBoxes.push(lines.flatMap((l) => l.items.map((it) => ({ x0: it.x / width, x1: (it.x + it.width) / width, y0: (it.y - it.height) / height, y1: it.y / height }))));
    }
  } finally {
    await reader.destroy();
  }
  // A page "has text" when it holds a real amount of it. A scanned page with a typed
  // header, a stamped page number or a divider title has a few words and a picture: it
  // still needs reading.
  const { pageImages } = require('../pdf/images');
  const hasText = existing.map((t, i) => {
    const n = t.replace(/\s/g, '').length;
    if (n >= 200) return true;
    if (n < 20) return false;
    return pageImages(doc, doc.getPage(i)).length === 0;
  });
  const todo = [...Array(total).keys()].filter((i) => !hasText[i]);

  const pages = existing.slice();
  const words = existing.map(() => []);
  const images = [];
  let read = 0;
  let empty = 0;
  if (todo.length) {
    const src = await stage(ctx, input, `ocr-${Math.random().toString(36).slice(2, 8)}`);
    progress(0.02, 'מכין את העמודים…');
    const files = await renderPages(ctx, src, todo, { dpi: DPI, device: 'pnggray', tag: path.basename(src, '.pdf') });
    for (let k = 0; k < todo.length; k++) {
      const i = todo[k];
      progress(0.05 + (k / todo.length) * 0.93, `מזהה טקסט: עמוד ${i + 1} מתוך ${total}`);
      const result = await ocr.recognise({ file: files[k], langs, dpi: DPI }, ctx.signal);
      ctx.throwIfCancelled();
      // A page that already had a few words keeps them, and the scan's words are added
      // beside them. A recognised word lying where the page already has text is skipped,
      // so a search does not find it twice; the same word elsewhere on the page is kept.
      if (existingBoxes[i] && existingBoxes[i].length) {
        const png = pngSize(await fs.readFile(files[k]));
        result.words = result.words.filter((w) => {
          const b = { x0: w.bbox.x0 / png.width, x1: w.bbox.x1 / png.width, y0: w.bbox.y0 / png.height, y1: w.bbox.y1 / png.height };
          return !existingBoxes[i].some((e) => {
            const ix = Math.max(0, Math.min(b.x1, e.x1) - Math.max(b.x0, e.x0));
            const iy = Math.max(0, Math.min(b.y1, e.y1) - Math.max(b.y0, e.y0));
            return ix * iy > 0.3 * (b.x1 - b.x0) * (b.y1 - b.y0);
          });
        });
      }
      const size = pngSize(await fs.readFile(files[k]));
      images[i] = { ...size, dpi: DPI, file: files[k] };
      words[i] = result.words;
      if (!result.words.length) {
        empty++;
        continue;
      }
      const placed = await stampTextLayer(doc, doc.getPage(i), result, { ...size, dpi: DPI });
      if (placed) read++;
      else empty++;
      pages[i] = result.text.trim();
    }
  }
  progress(1, 'שומר…');
  return {
    bytes: read ? await doc.save({ useObjectStreams: true }) : null,
    pages,
    words,
    images,
    read,
    skipped: total - todo.length,
    empty,
    hasText,
  };
}

/** Width and height from a PNG's header. */
function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

module.exports = { run, ocrFile, availability: () => bin.availability('gs') };
