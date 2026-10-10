'use strict';

const { PDFDocument, degrees } = require('pdf-lib');

const { loadPdf } = require('../pdf/inspect');

/**
 * Organize: the pages in a new order, some removed, some turned, blank pages and
 * pages from other PDFs inserted.
 *
 * inputs[0] is the document; inputs[1..] are PDFs whose pages were inserted.
 * options.pages is the new sequence:
 *   { f: inputIndex, p: pageIndex, r: quarterTurns }   a page, turned r x 90 clockwise
 *   { blank: true, w, h }                               a blank page of that size
 * Without options.pages the document is copied unchanged.
 */
async function run({ inputs, options = {}, ctx }) {
  const docs = [];
  for (const input of inputs) docs.push(await loadPdf(input));
  const seq = Array.isArray(options.pages) && options.pages.length
    ? options.pages
    : docs[0].getPageIndices().map((p) => ({ f: 0, p, r: 0 }));

  for (const item of seq) {
    if (item.blank) continue;
    const doc = docs[item.f];
    if (!doc || !Number.isInteger(item.p) || item.p < 0 || item.p >= doc.getPageCount()) {
      throw new Error('סידור העמודים אינו תואם את הקובץ. ייתכן שהקובץ השתנה מאז שנפתח. פתח אותו שוב.');
    }
  }
  if (!seq.length) throw new Error('לא נשאר אף עמוד. אי אפשר ליצור קובץ ריק.');

  const out = await PDFDocument.create();
  for (let i = 0; i < seq.length; i++) {
    ctx.progress(i / seq.length, `עמוד ${i + 1} מתוך ${seq.length}`);
    const item = seq[i];
    if (item.blank) {
      out.addPage([Number(item.w) || 595.28, Number(item.h) || 841.89]);
      continue;
    }
    const [page] = await out.copyPages(docs[item.f], [item.p]);
    const turns = ((Math.round(Number(item.r) || 0) % 4) + 4) % 4;
    if (turns) page.setRotation(degrees((page.getRotation().angle + turns * 90) % 360));
    out.addPage(page);
  }

  ctx.progress(1, 'שומר…');
  const outputPath = await ctx.writeOutput(await out.save({ useObjectStreams: true }), {
    source: inputs[0], label: 'מסודר', ext: 'pdf',
  });
  const removed = docs[0].getPageCount() - seq.filter((s) => !s.blank && s.f === 0).length;
  const parts = [`נוצר קובץ בן ${seq.length} עמודים`];
  if (removed > 0) parts.push(removed === 1 ? 'עמוד אחד הוסר' : `${removed} עמודים הוסרו`);
  return { summary: `${parts.join(', ')}.`, display: [outputPath] };
}

module.exports = { run };
