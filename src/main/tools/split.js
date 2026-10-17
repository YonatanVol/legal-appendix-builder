'use strict';

const { PDFDocument } = require('pdf-lib');

const { loadPdf } = require('../pdf/inspect');
const { baseName } = require('../output');
const { parseRanges, indicesOf, formatRange } = require('../../shared/pages');

/**
 * Split one PDF.
 *
 * options.mode:
 *   'ranges'   options.ranges "1-3, 4-6, 8-": one file per range, or one file for all
 *              of them when options.mergeRanges is true
 *   'every'    options.every N: a file every N pages
 *   'extract'  options.pages "2, 5-7": those pages, as one file, or one file per page
 *              when options.extractEach is true
 *   'size'     options.maxMb: parts no larger than that, as far as pages allow
 *
 * One result is written beside the source. Several go into a folder beside it, named
 * "<name> - חלק 01 (עמ' 1-3).pdf" so they sort in order in Explorer.
 */
async function run({ inputs, options = {}, ctx }) {
  const source = inputs[0];
  const doc = await loadPdf(source);
  const total = doc.getPageCount();
  const mode = options.mode || 'ranges';

  let parts; // [{indices: number[], over?: boolean}]
  let oversize = 0;
  if (mode === 'every') {
    const n = Math.floor(Number(options.every));
    if (!Number.isFinite(n) || n < 1) throw new Error('יש לבחור כל כמה עמודים לפצל, מספר של 1 ומעלה.');
    if (n >= total) throw new Error(`בקובץ יש ${total} עמודים, ולכן חלוקה כל ${n} עמודים תשאיר אותו שלם.`);
    parts = [];
    for (let start = 0; start < total; start += n) {
      const indices = [];
      for (let i = start; i < Math.min(total, start + n); i++) indices.push(i);
      parts.push({ indices });
    }
  } else if (mode === 'extract') {
    const indices = indicesOf(parseRanges(options.pages, total));
    parts = options.extractEach ? indices.map((i) => ({ indices: [i] })) : [{ indices }];
  } else if (mode === 'size') {
    parts = await partsBySize(doc, Number(options.maxMb), ctx);
    oversize = parts.filter((p) => p.over).length;
  } else {
    const ranges = parseRanges(options.ranges, total);
    parts = options.mergeRanges
      ? [{ indices: ranges.flatMap(({ from, to }) => Array.from({ length: to - from + 1 }, (_, k) => from - 1 + k)) }]
      : ranges.map(({ from, to }) => ({ indices: Array.from({ length: to - from + 1 }, (_, k) => from - 1 + k) }));
  }

  const stem = baseName(source);
  const digits = String(parts.length).length < 2 ? 2 : String(parts.length).length;
  const label = (indices) => {
    const r = contiguous(indices);
    return r ? `עמ' ${formatRange(r)}` : `${indices.length} עמודים`;
  };

  if (parts.length === 1) {
    ctx.progress(0.5, 'מכין את הקובץ…');
    const bytes = await partBytes(doc, parts[0].indices);
    const out = await ctx.writeOutput(bytes, { source, label: label(parts[0].indices), ext: 'pdf' });
    return { summary: `נוצר קובץ אחד בן ${parts[0].indices.length} עמודים.`, display: [out] };
  }

  const folder = await ctx.outputFolder(source, 'מפוצל');
  for (let i = 0; i < parts.length; i++) {
    ctx.progress(i / parts.length, `חלק ${i + 1} מתוך ${parts.length}`);
    const bytes = await partBytes(doc, parts[i].indices);
    const number = String(i + 1).padStart(digits, '0');
    await ctx.writeOutput(bytes, { dir: folder, name: `${stem} - חלק ${number} (${label(parts[i].indices)})`, ext: 'pdf' });
  }
  ctx.progress(1, 'הסתיים');
  let summary = `הקובץ פוצל ל-${parts.length} קבצים, בתיקייה חדשה ליד המקור.`;
  if (oversize) {
    summary += ` ${oversize === 1 ? 'חלק אחד גדול' : `${oversize} חלקים גדולים`} מהמגבלה, כי ${oversize === 1 ? 'יש בו עמוד אחד' : 'בכל אחד מהם עמוד אחד'} שגדול ממנה בעצמו.`;
  }
  return {
    summary,
    display: [folder],
  };
}

function contiguous(indices) {
  for (let i = 1; i < indices.length; i++) if (indices[i] !== indices[i - 1] + 1) return null;
  return { from: indices[0] + 1, to: indices[indices.length - 1] + 1 };
}

async function partBytes(doc, indices) {
  const part = await PDFDocument.create();
  const pages = await part.copyPages(doc, indices);
  pages.forEach((p) => part.addPage(p));
  return part.save({ useObjectStreams: true });
}

/**
 * Parts no larger than maxMb. Each page's own size is measured once, standing alone;
 * pages in a part share fonts and images, so a part is never larger than the sum and
 * the limit holds. A single page larger than the limit becomes a part of its own,
 * and the summary says so rather than pretending.
 */
async function partsBySize(doc, maxMb, ctx) {
  if (!Number.isFinite(maxMb) || maxMb <= 0) throw new Error('יש לכתוב גודל מרבי לכל חלק, במגה-בייט.');
  const limit = maxMb * 1024 * 1024;
  const total = doc.getPageCount();
  const sizes = [];
  for (let i = 0; i < total; i++) {
    ctx.progress((i / total) * 0.6, `מודד את עמוד ${i + 1} מתוך ${total}`);
    sizes.push((await partBytes(doc, [i])).length);
  }
  if (total === 1) throw new Error('בקובץ יש עמוד אחד בלבד, ולכן אי אפשר לפצל אותו.');
  const parts = [];
  let current = [];
  let sum = 0;
  const close = () => {
    parts.push({ indices: current, over: sum > limit });
    current = [];
    sum = 0;
  };
  for (let i = 0; i < total; i++) {
    if (current.length && sum + sizes[i] > limit) close();
    current.push(i);
    sum += sizes[i];
  }
  if (current.length) close();
  if (parts.length === 1) throw new Error(`הקובץ כולו קטן מ-\u2066${maxMb} MB\u2069, ולכן אין מה לפצל.`);
  return parts;
}

module.exports = { run };
