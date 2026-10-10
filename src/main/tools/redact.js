'use strict';

const fs = require('fs/promises');
const path = require('path');
const { PDFDocument, PDFName } = require('pdf-lib');

const bin = require('../engine/binaries');
const imaging = require('../engine/imaging');
const { stage } = require('../engine/stage');
const { renderPages } = require('../engine/render');
const { ocrFile } = require('./ocr');
const { loadPdf } = require('../pdf/inspect');

const DPI = 200;

/**
 * Redact: remove what is marked, for real.
 *
 * A black rectangle drawn over text hides it from the eye and nothing else: the text
 * is still in the file, and copying the page brings it back. So every page that has a
 * mark is redrawn as a picture with the marked areas painted black, and the picture
 * replaces the page. Nothing of the original page survives on it: no text, no layers,
 * no hidden objects. Pages without marks are kept as they are.
 *
 * options.marks     [{ page, x, y, w, h }]: 0-based page, the rest fractions of the page
 *                   as shown, measured from its top-left corner
 * options.clean     also remove the document's metadata, comments and attached files
 *                   (default true)
 * options.ocr       make the redacted pages searchable again afterwards; the black areas
 *                   have nothing to find
 */
async function run({ inputs, options = {}, ctx }) {
  const source = inputs[0];
  const marks = Array.isArray(options.marks) ? options.marks.filter(valid) : [];
  if (!marks.length) throw new Error('לא סומן מה להשחיר. סמן אזורים על העמוד, או חפש טקסט וסמן את התוצאות.');

  const doc = await loadPdf(source);
  const total = doc.getPageCount();
  const byPage = new Map();
  for (const m of marks) {
    if (m.page >= total) throw new Error('הסימונים אינם תואמים את הקובץ. ייתכן שהוא השתנה מאז שנפתח.');
    if (!byPage.has(m.page)) byPage.set(m.page, []);
    byPage.get(m.page).push(m);
  }
  const pages = [...byPage.keys()].sort((a, b) => a - b);

  const src = await stage(ctx, source, 'redact');
  ctx.progress(0.05, 'מצייר את העמודים המסומנים…');
  const images = await renderPages(ctx, src, pages, { dpi: DPI, device: 'png16m', tag: 'red' });

  for (let k = 0; k < pages.length; k++) {
    const i = pages[k];
    ctx.progress(0.1 + (k / pages.length) * 0.6, `משחיר את עמוד ${i + 1}`);
    const png = await fs.readFile(images[k]);
    // A little beyond each mark, so anti-aliased edges of letters do not peek out.
    const boxes = byPage.get(i).map((m) => ({ x: m.x - 0.002, y: m.y - 0.002, w: m.w + 0.004, h: m.h + 0.004 }));
    const out = await imaging.blackOut(png, 'image/png', boxes);
    ctx.throwIfCancelled();
    const old = doc.getPage(i);
    const crop = old.getCropBox();
    const turned = old.getRotation().angle % 180 !== 0;
    const w = turned ? crop.height : crop.width;
    const h = turned ? crop.width : crop.height;
    const image = await doc.embedJpg(out.bytes);
    doc.removePage(i);
    const page = doc.insertPage(i, [w, h]);
    page.drawImage(image, { x: 0, y: 0, width: w, height: h });
  }

  if (options.clean !== false) clean(doc);

  ctx.progress(0.75, 'שומר…');
  let bytes = await doc.save({ useObjectStreams: true });
  let searchable = '';
  if (options.ocr && bin.locate('gs')) {
    const temp = path.join(ctx.scratch, 'redacted.pdf');
    await fs.writeFile(temp, bytes);
    const read = await ocrFile(temp, { langs: 'heb+eng' }, ctx, (fraction, label) => ctx.progress(0.75 + fraction * 0.23, label));
    if (read.bytes) bytes = read.bytes;
    searchable = ' העמודים המושחרים זוהו מחדש, ואפשר לחפש בהם בכל מה שלא הושחר.';
  }
  const outputPath = await ctx.writeOutput(bytes, { source, label: 'מושחר', ext: 'pdf' });
  const what = pages.length === 1 ? 'עמוד אחד הושחר' : `${pages.length} עמודים הושחרו`;
  const how = options.ocr ? '' : ' העמודים המושחרים הפכו לתמונה, ולכן אי אפשר לחפש בהם טקסט.';
  return {
    summary: `${what}. ${marks.length === 1 ? 'האזור המסומן נמחק' : `${marks.length} האזורים המסומנים נמחקו`} מהקובץ עצמו, לא רק הוסתרו.${how}${searchable}${options.clean !== false ? ' גם פרטי המסמך, ההערות והקבצים המצורפים הוסרו.' : ''}`,
    display: [outputPath],
  };
}

function valid(m) {
  return m && Number.isInteger(m.page) && m.page >= 0 &&
    [m.x, m.y, m.w, m.h].every((v) => Number.isFinite(v)) && m.w > 0 && m.h > 0 &&
    m.x >= -0.01 && m.y >= -0.01 && m.x + m.w <= 1.01 && m.y + m.h <= 1.01;
}

/** Metadata, comments, attachments and scripts can hold what was redacted. */
function clean(doc) {
  doc.setTitle('');
  doc.setAuthor('');
  doc.setSubject('');
  doc.setKeywords([]);
  doc.setCreator('');
  doc.setProducer('');
  const catalog = doc.catalog;
  for (const key of ['Metadata', 'Names', 'OpenAction', 'AA', 'Outlines', 'PieceInfo']) catalog.delete(PDFName.of(key));
  for (const page of doc.getPages()) {
    page.node.delete(PDFName.of('Annots'));
    page.node.delete(PDFName.of('AA'));
    page.node.delete(PDFName.of('PieceInfo'));
  }
  const form = catalog.lookup(PDFName.of('AcroForm'));
  if (form) catalog.delete(PDFName.of('AcroForm'));
}

module.exports = { run, availability: () => bin.availability('gs') };
