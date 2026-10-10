'use strict';

const { loadPdf } = require('../pdf/inspect');
const { visualFrame, spot, embedStamps, drawAt, rectAt } = require('../pdf/stamp');
const { parseRanges, indicesOf } = require('../../shared/pages');

const MARGINS = { small: 18, normal: 30, large: 48 };

const FORMATS = {
  n: (n) => `${n}`,
  'n-of': (n, t) => `${n} מתוך ${t}`,
  'page-n': (n) => `עמוד ${n}`,
  'page-n-of': (n, t) => `עמוד ${n} מתוך ${t}`,
  'n-slash': (n, t) => `${n}/${t}`,
};

/**
 * Page numbers.
 *
 * options.position  'bottom-center' | 'bottom-left' | 'bottom-right' | 'top-...'
 * options.margin    'small' | 'normal' | 'large'
 * options.format    'n' | 'n-of' | 'page-n' | 'page-n-of' | 'n-slash'
 * options.start     the number on the first numbered page (default 1)
 * options.pages     which pages get a number: "" for all, or ranges like "2-"
 * options.size      points (default 11)
 * options.background  a white patch behind the number, for scans with dark edges
 *
 * "Of" counts the numbered pages: numbering pages 2-10 starting at 1 gives "1 מתוך 9".
 */
async function run({ inputs, options = {}, ctx }) {
  const format = FORMATS[options.format] || FORMATS.n;
  const raw = options.start === undefined ? 1 : options.start;
  const start = raw === '' || raw === null ? NaN : Math.floor(Number(raw));
  if (!Number.isFinite(start)) throw new Error('כתוב את המספר הראשון.');
  const margin = MARGINS[options.margin] || MARGINS.normal;
  const size = Math.min(48, Math.max(6, Number(options.size) || 11));
  const pagesText = String(options.pages || '').trim();

  const outputs = [];
  for (let f = 0; f < inputs.length; f++) {
    const doc = await loadPdf(inputs[f]);
    const indices = pagesText ? indicesOf(parseRanges(pagesText, doc.getPageCount())) : doc.getPageIndices();
    const last = start + indices.length - 1;
    const texts = indices.map((_, k) => format(start + k, last));

    ctx.progress(f / inputs.length, 'מכין את המספרים…');
    const stamps = await embedStamps(doc, texts, { size, color: options.color || '#000000' });

    indices.forEach((pageIndex, k) => {
      const page = doc.getPage(pageIndex);
      const stamp = stamps[k];
      const at = spot(visualFrame(page), options.position, stamp.width, stamp.height, margin);
      if (options.background) {
        rectAt(page, { vx: at.vx - 4, vy: at.vy - 1, w: stamp.width + 8, h: stamp.height + 2 });
      }
      drawAt(page, stamp, { ...at, w: stamp.width, h: stamp.height });
    });

    ctx.progress((f + 1) / inputs.length, `${f + 1} מתוך ${inputs.length} קבצים`);
    outputs.push(await ctx.writeOutput(await doc.save({ useObjectStreams: true }), {
      source: inputs[f], label: 'ממוספר', ext: 'pdf',
    }));
  }
  return {
    summary: inputs.length === 1 ? 'מספרי העמודים נוספו.' : `מספרי העמודים נוספו ל-${inputs.length} קבצים.`,
    display: outputs,
  };
}

module.exports = { run, FORMATS };
