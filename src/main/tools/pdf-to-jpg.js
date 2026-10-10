'use strict';

const fs = require('fs/promises');
const path = require('path');

const bin = require('../engine/binaries');
const { stage } = require('../engine/stage');
const { loadPdf } = require('../pdf/inspect');
const { pageImages, extract } = require('../pdf/images');
const { baseName } = require('../output');
const { parseRanges, indicesOf } = require('../../shared/pages');

/**
 * PDF to images.
 *
 * options.mode     'pages': each page drawn as a picture (default)
 *                  'images': the pictures inside the file, taken out unchanged
 * options.format   'jpg' | 'png'          (pages)
 * options.dpi      72 | 150 | 300         (pages, default 150)
 * options.pages    "" for all, or ranges  (pages)
 *
 * One picture goes beside the source; several go into a folder beside it.
 */
async function run({ inputs, options = {}, ctx }) {
  return options.mode === 'images' ? images(inputs, ctx) : pages(inputs, options, ctx);
}

async function pages(inputs, options, ctx) {
  const png = options.format === 'png';
  const dpi = [72, 150, 300].includes(Number(options.dpi)) ? Number(options.dpi) : 150;
  const ext = png ? 'png' : 'jpg';
  const display = [];
  let made = 0;

  for (let f = 0; f < inputs.length; f++) {
    const doc = await loadPdf(inputs[f]);
    const total = doc.getPageCount();
    const wanted = String(options.pages || '').trim() && inputs.length === 1
      ? indicesOf(parseRanges(options.pages, total))
      : doc.getPageIndices();
    const src = await stage(ctx, inputs[f], f);
    const pattern = path.join(ctx.scratch, `p${f}-%05d.${ext}`);
    const args = [
      '-dNOPAUSE', '-dBATCH', '-dSAFER',
      `-sDEVICE=${png ? 'png16m' : 'jpeg'}`,
      `-r${dpi}`,
      '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
      `-sPageList=${wanted.map((i) => i + 1).join(',')}`,
      `-sOutputFile=${pattern}`,
    ];
    if (!png) args.push('-dJPEGQ=90');
    args.push(src);
    const name = path.basename(inputs[f]);
    const result = await bin.run('gs', args, {
      signal: ctx.signal,
      onLine: (line) => {
        const m = /^Page (\d+)/.exec(line);
        if (m) ctx.progress((f + wanted.indexOf(Number(m[1]) - 1) / wanted.length) / inputs.length, `"${name}": עמוד ${m[1]}`);
      },
    });
    ctx.throwIfCancelled();
    if (result.code !== 0) throw new Error(`לא ניתן היה ליצור תמונות מ-"${name}". ייתכן שהקובץ פגום; אפשר לנסות קודם את "תיקון PDF".`);

    const stem = baseName(inputs[f]);
    const width = String(total).length;
    const files = wanted.map((pageIndex, k) => ({
      from: path.join(ctx.scratch, `p${f}-${String(k + 1).padStart(5, '0')}.${ext}`),
      label: `עמ' ${String(pageIndex + 1).padStart(width, '0')}`,
    }));
    if (files.length === 1) {
      display.push(await ctx.writeOutput(await fs.readFile(files[0].from), { source: inputs[f], label: files[0].label, ext }));
    } else {
      const folder = await ctx.outputFolder(inputs[f], 'תמונות');
      for (const file of files) {
        await ctx.writeOutput(await fs.readFile(file.from), { dir: folder, name: `${stem} - ${file.label}`, ext });
      }
      display.push(folder);
    }
    made += files.length;
  }
  return { summary: `נוצרו ${made === 1 ? 'תמונה אחת' : `${made} תמונות`} ב-${dpi} DPI.`, display };
}

async function images(inputs, ctx) {
  const display = [];
  let made = 0;
  let skipped = 0;
  for (let f = 0; f < inputs.length; f++) {
    const doc = await loadPdf(inputs[f]);
    const found = [];
    doc.getPages().forEach((page, p) => {
      for (const stream of pageImages(doc, page)) found.push({ p, stream });
    });
    ctx.progress(f / inputs.length, `"${path.basename(inputs[f])}": ${found.length} תמונות`);
    const usable = [];
    for (const item of found) {
      const out = extract(doc, item.stream);
      if (out) usable.push({ ...out, p: item.p });
      else skipped++;
    }
    if (!usable.length) continue;
    const stem = baseName(inputs[f]);
    if (usable.length === 1) {
      display.push(await ctx.writeOutput(usable[0].bytes, { source: inputs[f], label: 'תמונה', ext: usable[0].ext }));
    } else {
      const folder = await ctx.outputFolder(inputs[f], 'תמונות מתוך הקובץ');
      const perPage = new Map();
      for (const img of usable) {
        const n = (perPage.get(img.p) || 0) + 1;
        perPage.set(img.p, n);
        await ctx.writeOutput(img.bytes, { dir: folder, name: `${stem} - עמ' ${img.p + 1} - ${n}`, ext: img.ext });
      }
      display.push(folder);
    }
    made += usable.length;
  }
  if (!made && !skipped) return { summary: 'לא נמצאו תמונות בתוך הקובץ. כדי לקבל את העמודים עצמם כתמונות, בחר "כל עמוד כתמונה".', display: [] };
  let summary = made ? `נשמרו ${made === 1 ? 'תמונה אחת' : `${made} תמונות`} כפי שהן בקובץ, בלי איבוד איכות.` : 'לא נשמרו תמונות.';
  if (skipped) summary += ` ${skipped === 1 ? 'תמונה אחת נשמרה' : `${skipped} תמונות נשמרו`} בקובץ בפורמט שאי אפשר להוציא כמו שהוא; "כל עמוד כתמונה" יכלול ${skipped === 1 ? 'אותה' : 'אותן'}.`;
  return { summary, display };
}

function availability() {
  // Taking images out needs nothing extra, but drawing pages needs Ghostscript, and the
  // tile stands for both.
  return bin.availability('gs');
}

module.exports = { run, availability };
