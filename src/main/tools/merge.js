'use strict';

const path = require('path');
const { PDFDocument } = require('pdf-lib');

const { loadPdf } = require('../pdf/inspect');

/**
 * Merge: the inputs, in the order given, become one PDF.
 *
 * Options: { outputName?: string }  the stem of the result; defaults to the first file's
 * name followed by " - מאוחד".
 */
async function run({ inputs, options = {}, ctx }) {
  if (!Array.isArray(inputs) || inputs.length < 2) {
    throw new Error('לאיחוד צריך לפחות שני קבצים.');
  }

  const merged = await PDFDocument.create();
  let total = 0;
  const counts = [];
  for (const file of inputs) counts.push((await loadPdf(file)).getPageCount());
  const all = counts.reduce((a, b) => a + b, 0);

  for (let i = 0; i < inputs.length; i++) {
    ctx.throwIfCancelled();
    const name = path.basename(inputs[i]);
    const source = await loadPdf(inputs[i]);
    const indices = source.getPageIndices();
    // Copying page by page keeps the progress honest on a 400-page scan.
    const chunk = 10;
    for (let start = 0; start < indices.length; start += chunk) {
      ctx.throwIfCancelled();
      const pages = await merged.copyPages(source, indices.slice(start, start + chunk));
      for (const page of pages) merged.addPage(page);
      total += pages.length;
      ctx.progress(total / all, `${name}: עמוד ${total} מתוך ${all}`);
    }
  }

  ctx.progress(1, 'שומר את הקובץ…');
  const bytes = await merged.save({ useObjectStreams: true });
  const outputPath = await ctx.writeOutput(bytes, {
    source: inputs[0],
    label: 'מאוחד',
    ext: 'pdf',
    name: options.outputName ? String(options.outputName).trim() : undefined,
  });

  return {
    summary: `נוצר קובץ אחד בן ${total} עמודים מתוך ${inputs.length} קבצים.`,
    pageCount: total,
    outputPath,
  };
}

module.exports = { run };
