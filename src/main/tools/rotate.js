'use strict';

const { degrees } = require('pdf-lib');

const { loadPdf } = require('../pdf/inspect');
const { parseRanges, indicesOf } = require('../../shared/pages');

/**
 * Rotate pages by 90, 180 or 270 degrees clockwise.
 * options.angle: 90 | 180 | 270
 * options.pages: "" for every page, or ranges like "2, 5-7" (one file only)
 *
 * Rotation is the page's /Rotate entry, so nothing is redrawn and nothing is lost:
 * rotating back gives the original.
 */
async function run({ inputs, options = {}, ctx }) {
  const angle = Number(options.angle);
  if (![90, 180, 270].includes(angle)) throw new Error('יש לבחור זווית: 90, 180 או 270 מעלות.');
  const someOnly = String(options.pages || '').trim();
  if (someOnly && inputs.length > 1) throw new Error('בחירת עמודים מסוימים אפשרית רק בקובץ אחד.');

  const outputs = [];
  let turned = 0;
  for (let f = 0; f < inputs.length; f++) {
    const doc = await loadPdf(inputs[f]);
    const indices = someOnly ? indicesOf(parseRanges(someOnly, doc.getPageCount())) : doc.getPageIndices();
    for (const i of indices) {
      const page = doc.getPage(i);
      page.setRotation(degrees((page.getRotation().angle + angle) % 360));
    }
    turned += indices.length;
    ctx.progress((f + 1) / inputs.length, `${f + 1} מתוך ${inputs.length} קבצים`);
    outputs.push(await ctx.writeOutput(await doc.save({ useObjectStreams: true }), {
      source: inputs[f], label: 'מסובב', ext: 'pdf',
    }));
  }
  const what = turned === 1 ? 'עמוד אחד סובב' : `${turned} עמודים סובבו`;
  return { summary: `${what} ב-${angle} מעלות${inputs.length > 1 ? `, ב-${inputs.length} קבצים` : ''}.`, display: outputs };
}

module.exports = { run };
