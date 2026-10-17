'use strict';

const { loadPdf } = require('../pdf/inspect');
const { visualFrame } = require('../pdf/stamp');
const { parseRanges, indicesOf } = require('../../shared/pages');

/**
 * Crop: trim the edges of pages.
 *
 * options.margins: { top, right, bottom, left }, each a fraction (0..1) of the page as
 *   it appears on screen. The screen draws them on a page, or finds them from the
 *   page's white space, and sends fractions so pages of other sizes crop alike.
 * options.pages: "" for every page, or ranges.
 *
 * Only the crop box changes. The content is all still there, which is what a person
 * expects of "crop" and means a crop that went too far can be undone.
 */
async function run({ inputs, options = {}, ctx }) {
  const m = options.margins || {};
  const margins = ['top', 'right', 'bottom', 'left'].map((k) => Number(m[k]) || 0);
  const [top, right, bottom, left] = margins;
  if (margins.some((v) => v < 0 || v >= 1)) throw new Error('השוליים לחיתוך אינם תקינים.');
  if (left + right >= 0.95 || top + bottom >= 0.95) throw new Error('החיתוך גדול מדי: לא יישאר מהעמוד כמעט כלום.');
  if (margins.every((v) => v === 0)) throw new Error('לא סומן מה לחתוך. גרור את המסגרת על העמוד, או לחץ על "זיהוי שוליים".');

  const source = inputs[0];
  const doc = await loadPdf(source);
  const indices = String(options.pages || '').trim()
    ? indicesOf(parseRanges(options.pages, doc.getPageCount()))
    : doc.getPageIndices();

  indices.forEach((i, n) => {
    const page = doc.getPage(i);
    const frame = visualFrame(page);
    const a = frame.toUser(left * frame.width, bottom * frame.height);
    const b = frame.toUser((1 - right) * frame.width, (1 - top) * frame.height);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    page.setCropBox(x, y, w, h);
    page.setTrimBox(x, y, w, h);
    ctx.progress((n + 1) / indices.length, `עמוד ${n + 1} מתוך ${indices.length}`);
  });

  const out = await ctx.writeOutput(await doc.save({ useObjectStreams: true }), { source, label: 'חתוך', ext: 'pdf' });
  const what = indices.length === 1 ? 'עמוד אחד נחתך' : `${indices.length} עמודים נחתכו`;
  return { summary: `${what}. התוכן שמחוץ למסגרת לא נמחק, רק הוסתר.`, display: [out] };
}

module.exports = { run };
