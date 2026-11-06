'use strict';

const { loadPdf } = require('../pdf/inspect');
const { drawObjects } = require('../pdf/draw');

/**
 * Edit PDF: text, pictures, shapes, freehand lines, highlights and white-out, drawn
 * into the pages. options.objects is the list the screen built (see pdf/draw.js).
 */
async function run({ inputs, options = {}, ctx }) {
  const doc = await loadPdf(inputs[0]);
  ctx.progress(0.2, 'מצייר על העמודים…');
  const placed = await drawObjects(doc, options.objects || []);
  if (!placed) throw new Error('לא נוסף דבר לעמודים. בחר כלי בסרגל ולחץ על העמוד.');
  ctx.progress(0.9, 'שומר…');
  const out = await ctx.writeOutput(await doc.save({ useObjectStreams: true }), { source: inputs[0], label: 'ערוך', ext: 'pdf' });
  return { summary: `${placed === 1 ? 'פריט אחד נוסף' : `${placed} פריטים נוספו`} לקובץ.`, display: [out] };
}

module.exports = { run };
